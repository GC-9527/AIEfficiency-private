import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import { WORKFLOW_V2_SCHEMA_IDS } from "./schema-registry.js";
import {
  appendEvidenceReceipt,
  canonicalSha256,
  readWorkflowV2Envelopes,
} from "./envelope-store.js";
import {
  createWorkflowV2ControllerReceiptBridge,
  isWorkflowV2ControllerReceiptBridge,
  WORKFLOW_V2_BUILD_CONTROLLER_ADAPTER_ID,
  WORKFLOW_V2_DEVICE_PROXY_ADAPTER_ID,
} from "./controller-receipt-bridge.js";
import {
  createWorkflowV2ControlledOperationJournal,
} from "./controlled-operation-journal.js";
import {
  deriveWorkflowV2EditState,
  verifyWorkflowV2EditStateFiles,
} from "./edit-state-binding.js";

const FROZEN_EVIDENCE_DIRECTORY = "workflow-v2/evidence-blobs";
const RECEIPT_MAX_ATTEMPTS = 3;
const MAX_PROCESS_OUTPUT_CHARS = 200_000;
const MAX_CAPTURE_OUTPUT_BYTES = 64 * 1024 * 1024;
const CHECK_ACTIONS = new Set(["BUILD", "TEST"]);
const VERIFICATION_ACTIONS = new Set(["BUILD", "TEST", "DEVICE_ACTION", "DB_QUERY", "CAPTURE"]);

export class WorkflowV2ReceiptProducerError extends Error {
  constructor(message, code, details = {}) {
    super(message);
    this.name = "WorkflowV2ReceiptProducerError";
    this.code = code;
    this.details = details;
  }
}

function fail(message, code, details = {}) {
  throw new WorkflowV2ReceiptProducerError(message, code, details);
}

function assertExactControlledInput(input, allowedKeys) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    fail("controlled execution input must be an object", "WORKFLOW_V2_RECEIPT_CONTROLLED_INPUT_INVALID");
  }
  const forbidden = Object.keys(input).filter((key) => !allowedKeys.has(key));
  if (forbidden.length) {
    fail(
      "controlled execution does not accept task, flavor, serial, lease, command, or other free-form fields",
      "WORKFLOW_V2_RECEIPT_CONTROLLED_INPUT_FORBIDDEN",
      { fields: forbidden.sort() },
    );
  }
}

function sameRealPath(left, right) {
  if (!left || !right) return false;
  const a = path.resolve(String(left));
  const b = path.resolve(String(right));
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function sha256File(pathname) {
  return createHash("sha256").update(readFileSync(pathname)).digest("hex");
}

function writeExclusiveDurable(pathname, bytes) {
  const fd = openSync(pathname, "wx", 0o600);
  try {
    writeFileSync(fd, bytes);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function safeFileSnapshot(pathname) {
  try {
    if (!existsSync(pathname) || !statSync(pathname).isFile()) return null;
    const stat = statSync(pathname);
    return { sha256: sha256File(pathname), sizeBytes: stat.size };
  } catch {
    return null;
  }
}

function sameOrChildPath(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function readPlainGeneratedCapture(generatedAbsolutePath, generatedRoot) {
  if (typeof generatedAbsolutePath !== "string" || !path.isAbsolute(generatedAbsolutePath)
    || typeof generatedRoot !== "string" || !path.isAbsolute(generatedRoot)) {
    fail("capture output path/root is invalid", "WORKFLOW_V2_RECEIPT_CAPTURE_OUTPUT_INVALID");
  }
  const root = path.resolve(generatedRoot);
  const target = path.resolve(generatedAbsolutePath);
  if (!sameOrChildPath(root, target)) {
    fail("capture output escapes the generated-artifact root", "WORKFLOW_V2_RECEIPT_CAPTURE_OUTPUT_INVALID");
  }
  let current = root;
  const rootStat = lstatSync(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    fail("capture generated-artifact root is not a plain directory", "WORKFLOW_V2_RECEIPT_CAPTURE_OUTPUT_INVALID");
  }
  for (const segment of path.relative(root, target).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    const stat = lstatSync(current);
    if (stat.isSymbolicLink()) {
      fail("capture output traverses a symlink or junction", "WORKFLOW_V2_RECEIPT_CAPTURE_OUTPUT_INVALID");
    }
  }
  const stat = lstatSync(target);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1 || stat.size > MAX_CAPTURE_OUTPUT_BYTES) {
    fail("capture output is not a bounded regular file", "WORKFLOW_V2_RECEIPT_CAPTURE_OUTPUT_INVALID");
  }
  const realRoot = realpathSync(root);
  const realTarget = realpathSync(target);
  if (!sameOrChildPath(realRoot, realTarget)) {
    fail("capture output resolves outside the generated-artifact root", "WORKFLOW_V2_RECEIPT_CAPTURE_OUTPUT_INVALID");
  }
  return readFileSync(realTarget);
}

function isDeepFrozen(value, seen = new Set()) {
  if (!value || typeof value !== "object" || seen.has(value)) return true;
  if (!Object.isFrozen(value)) return false;
  seen.add(value);
  return Object.values(value).every((child) => isDeepFrozen(child, seen));
}

function boundedText(value, max = 2000) {
  const text = String(value ?? "").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, "�");
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function receiptIdFor(operationId, action) {
  return `gateway-${String(action).toLowerCase()}-${canonicalSha256({ operationId, action }).slice(0, 32)}`;
}

function assertIdentifier(value, field) {
  if (typeof value !== "string" || !value.trim() || value !== value.trim() || value.length > 160
    || /[\u0000-\u001f\u007f-\u009f]/u.test(value)) {
    fail(`${field} is invalid`, "WORKFLOW_V2_RECEIPT_EXECUTION_PROFILE_INVALID", { field });
  }
  return value;
}

function executorIndex(stageProfile) {
  const raw = stageProfile?.executors;
  if (raw === undefined) return new Map();
  if (Array.isArray(raw)) {
    const index = new Map();
    for (const entry of raw) {
      const id = assertIdentifier(entry?.executorId, "executorId");
      if (index.has(id)) fail("duplicate executorId", "WORKFLOW_V2_RECEIPT_EXECUTION_PROFILE_INVALID", { executorId: id });
      index.set(id, entry);
    }
    return index;
  }
  if (!raw || typeof raw !== "object") {
    fail("stage executors must be an object or array", "WORKFLOW_V2_RECEIPT_EXECUTION_PROFILE_INVALID");
  }
  return new Map(Object.entries(raw));
}

function profileEntry({ executionProfile, stageContext, stageId, kind, identity }) {
  if (!executionProfile) {
    fail("controlled execution profile is missing", "WORKFLOW_V2_RECEIPT_EXECUTION_PROFILE_MISSING", { stageId });
  }
  if (!isDeepFrozen(executionProfile)) {
    fail("controlled execution profile must be recursively frozen", "WORKFLOW_V2_RECEIPT_EXECUTION_PROFILE_UNTRUSTED");
  }
  if (executionProfile.stageId !== stageId || !Array.isArray(executionProfile.executors)) {
    fail("controlled execution stage profile does not match dispatch", "WORKFLOW_V2_RECEIPT_EXECUTION_PROFILE_MISSING", { stageId });
  }
  const list = kind === "check"
    ? stageContext?.data?.localChecks
    : stageContext?.data?.verificationPlan?.cases;
  if (!Array.isArray(list)) {
    fail("controlled execution entry list is missing", "WORKFLOW_V2_RECEIPT_EXECUTION_PROFILE_MISSING", { stageId, kind });
  }
  const identityField = kind === "check" ? "checkId" : "caseId";
  const matches = list.filter((entry) => entry?.[identityField] === identity);
  if (matches.length !== 1) {
    fail("controlled execution identity is unknown or duplicated", "WORKFLOW_V2_RECEIPT_EXECUTION_UNKNOWN", {
      stageId,
      [identityField]: identity,
    });
  }
  const entry = matches[0];
  const executors = executorIndex({ executors: executionProfile.executors });
  const executorId = entry.executorId === undefined ? "" : assertIdentifier(entry.executorId, "executorId");
  const referenced = executorId ? executors.get(executorId) : null;
  if (executorId && !referenced) {
    fail("controlled execution references an unknown executor", "WORKFLOW_V2_RECEIPT_EXECUTION_PROFILE_INVALID", { executorId });
  }
  const executor = referenced;
  if (!executor) {
    fail("controlled execution requires an executorId", "WORKFLOW_V2_RECEIPT_EXECUTION_PROFILE_INVALID");
  }
  const action = String(executor.action || "").toUpperCase();
  const allowed = kind === "check" ? CHECK_ACTIONS : VERIFICATION_ACTIONS;
  if (!allowed.has(action)) {
    fail("controlled execution action is not allowed", "WORKFLOW_V2_RECEIPT_EXECUTION_PROFILE_INVALID", { action, kind });
  }
  if (String(entry.action || "").toUpperCase() !== action) {
    fail("controlled execution claim/action does not match its executor", "WORKFLOW_V2_RECEIPT_EXECUTION_PROFILE_INVALID", {
      action,
      claimedAction: String(entry.action || ""),
    });
  }
  const rootId = assertIdentifier(
    entry.rootId || entry.target?.rootId || executor.cwdRootId || executionProfile.rootId,
    "rootId",
  );
  let argv = executor.argv;
  let adapterArgs = {};
  let adapterId = String(executor.adapterId || (Array.isArray(argv) ? "process" : ""));
  if (action === "BUILD") {
    // BUILD can never fall through to profile argv/raw process execution.  The
    // only public parameter is a trusted debug/release registry value; Flavor
    // and task are derived again inside the Build Controller.
    adapterId = WORKFLOW_V2_BUILD_CONTROLLER_ADAPTER_ID;
    argv = null;
    const executorBuildType = String(executor.buildType || "").toLowerCase();
    const targetBuildType = String(entry.target?.buildType || "").toLowerCase();
    if (["debug", "release"].includes(executorBuildType)
      && ["debug", "release"].includes(targetBuildType)
      && executorBuildType !== targetBuildType) {
      fail("BUILD executor and verification target disagree on buildType", "WORKFLOW_V2_RECEIPT_EXECUTION_PROFILE_INVALID");
    }
    const frozenRoot = (Array.isArray(stageContext?.scope?.roots) ? stageContext.scope.roots : [])
      .find((candidate) => candidate?.rootId === rootId);
    const targetFlavor = String(entry.target?.flavor || "");
    if (targetFlavor && frozenRoot?.flavor && targetFlavor !== String(frozenRoot.flavor)) {
      fail("BUILD verification target disagrees with the frozen root Flavor", "WORKFLOW_V2_RECEIPT_EXECUTION_PROFILE_INVALID");
    }
    adapterArgs = {
      buildType: executorBuildType || targetBuildType,
    };
  } else if (action === "DEVICE_ACTION") {
    // Legacy generic adapters remain available only to existing unit tests.
    // Production always routes DEVICE_ACTION through the story-lease proxy.
    const legacyTestAdapter = process.env.NODE_ENV === "test" && !executor.businessAction && adapterId;
    if (!legacyTestAdapter) {
      adapterId = WORKFLOW_V2_DEVICE_PROXY_ADAPTER_ID;
      adapterArgs = { businessAction: String(executor.businessAction || "") };
    }
  }
  assertIdentifier(adapterId, "adapterId");
  if (adapterId === "process"
    && (!Array.isArray(argv) || argv.length === 0 || argv.length > 200
      || argv.some((arg) => typeof arg !== "string" || !arg || arg.length > 16_000 || arg.includes("\u0000")))) {
    fail("process adapter requires a frozen argv array", "WORKFLOW_V2_RECEIPT_EXECUTION_PROFILE_INVALID");
  }
  const timeoutMs = executor.timeoutMs === undefined ? 600_000 : executor.timeoutMs;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 7_200_000) {
    fail("controlled execution timeoutMs is invalid", "WORKFLOW_V2_RECEIPT_EXECUTION_PROFILE_INVALID");
  }
  return {
    action,
    adapterId,
    argv: Array.isArray(argv) ? [...argv] : null,
    adapterArgs,
    caseOrCheck: entry,
    evidenceId: kind === "case" ? `case-evidence-${canonicalSha256(identity).slice(0, 32)}` : null,
    executorId: executorId || executor.executorId || `${kind}-${identity}`,
    name: kind === "check" ? String(entry.name || identity) : "",
    outputRef: null,
    profileId: String(executionProfile.profileId || "workflow-v2-profile"),
    rootId,
    timeoutMs,
  };
}

async function defaultRunProcess() {
  // A frozen argv is necessary but not sufficient confinement. The existing
  // worker broker only attests provider CLIs and cannot yet prove arbitrary
  // npm/Gradle execution. Production therefore fails closed until a dedicated
  // controlled runner is wired in by the Gateway.
  return {
    exitCode: null,
    timedOut: false,
    blocked: true,
    stdout: "",
    stderr: "WORKFLOW_V2_RECEIPT_CONFINED_EXECUTOR_UNAVAILABLE",
  };
}

/**
 * Gateway-owned evidence receipt producer. The optional executionProfile must
 * be a recursively frozen, dispatch-time snapshot selected from trusted
 * configuration; model tool arguments can only select one check/case by ID.
 */
export function buildStageReceiptRecorder({
  tab,
  dispatch,
  storageApi,
  executionProfile = dispatch?.executionProfile || null,
  readEnvelopes = readWorkflowV2Envelopes,
  appendReceipt = appendEvidenceReceipt,
  runProcess = defaultRunProcess,
  adapterHandlers = {},
  controllerBridge = null,
  now = () => new Date().toISOString(),
} = {}) {
  if (!tab || !dispatch || typeof dispatch?.contextId !== "string") {
    fail("receipt recorder is missing tab/dispatch", "WORKFLOW_V2_RECEIPT_RECORDER_CONTEXT_MISSING");
  }
  if (executionProfile) {
    const executionStatus = dispatch.executionStatus;
    const expectedProfileHash = canonicalSha256({
      executionProfile,
      status: executionStatus?.status,
      profileId: executionStatus?.profileId ?? null,
      blockers: executionStatus?.blockers || [],
    });
    if (!isDeepFrozen(executionProfile)
      || executionStatus?.status !== "READY"
      || executionStatus.profileId !== executionProfile.profileId
      || !Array.isArray(executionStatus.blockers)
      || executionStatus.blockers.length !== 0
      || dispatch.executionProfileSha256 !== expectedProfileHash
      || canonicalSha256(dispatch.executionProfile || null) !== canonicalSha256(executionProfile)) {
      fail(
        "controlled execution profile is not bound to the asserted dispatch snapshot",
        "WORKFLOW_V2_RECEIPT_EXECUTION_PROFILE_UNTRUSTED",
      );
    }
  }
  if (runProcess !== defaultRunProcess && process.env.NODE_ENV !== "test") {
    fail(
      "custom controlled process runners are only allowed in tests until an attested production broker exists",
      "WORKFLOW_V2_RECEIPT_CONFINED_EXECUTOR_UNAVAILABLE",
    );
  }
  const secureControllerBridge = controllerBridge || createWorkflowV2ControllerReceiptBridge({ tab, dispatch });
  if (!isWorkflowV2ControllerReceiptBridge(secureControllerBridge)) {
    fail(
      "reserved BUILD/DEVICE controller bridge is missing or untrusted",
      "WORKFLOW_V2_RECEIPT_CONTROLLER_BRIDGE_UNTRUSTED",
    );
  }
  const resolvedAdapterHandlers = Object.freeze({
    ...adapterHandlers,
    ...secureControllerBridge.adapterHandlers,
  });
  const storyId = String(tab.id);
  const contextId = String(dispatch.contextId);
  const contextRevision = dispatch.contextRevision;
  const stageId = String(dispatch.context?.stage?.id || "");
  const operationLocks = new Map();
  let storage;
  try {
    storage = storageApi?.getStoryStoragePaths?.(tab, { create: true });
  } catch (error) {
    fail(`story storage is unavailable: ${error.message}`, "WORKFLOW_V2_RECEIPT_RECORDER_STORAGE_UNAVAILABLE", {
      causeCode: String(error?.code || ""),
    });
  }
  if (!storage?.storyDirectory) {
    fail("story storage is missing storyDirectory", "WORKFLOW_V2_RECEIPT_RECORDER_STORAGE_UNAVAILABLE");
  }

  function validateStorageTarget(target, options) {
    if (typeof storageApi?.validateStoryStorageTarget !== "function") {
      fail(
        "story storage target validator is unavailable",
        "WORKFLOW_V2_RECEIPT_OUTPUT_PATH_BOUNDARY_REJECTED",
      );
    }
    try {
      return storageApi.validateStoryStorageTarget(tab, target, options);
    } catch (error) {
      // Concurrent creators may race on mkdir. EEXIST is safe only after the
      // winner's path is revalidated as a plain in-bound directory.
      if (options?.createDirectory && error?.code === "EEXIST") {
        try {
          return storageApi.validateStoryStorageTarget(tab, target, {
            ...options,
            createDirectory: false,
            mustExist: true,
            expectedType: "directory",
          });
        } catch (revalidationError) {
          error = revalidationError;
        }
      }
      fail(
        `controlled receipt output path was rejected: ${error?.message || error}`,
        "WORKFLOW_V2_RECEIPT_OUTPUT_PATH_BOUNDARY_REJECTED",
        { causeCode: String(error?.code || "") },
      );
    }
  }
  const controlledOperationJournal = createWorkflowV2ControlledOperationJournal({
    storyDirectory: storage.storyDirectory,
    validateTarget: validateStorageTarget,
    now,
  });
  const manifest = (Array.isArray(dispatch.evidenceSnapshots) ? dispatch.evidenceSnapshots : [])
    .map((item) => {
      const contentRef = String(item?.contentRef || "");
      const sha256 = String(item?.sha256 || "");
      if (!/^[a-f0-9]{64}$/.test(sha256)
        || contentRef !== `storydev:/${FROZEN_EVIDENCE_DIRECTORY}/${sha256}.blob`
        || !Number.isSafeInteger(item?.sizeBytes) || item.sizeBytes < 0) return null;
      const relative = contentRef.slice("storydev:/".length);
      return {
        evidenceId: String(item.evidenceId),
        relativePath: relative,
        absolutePath: path.join(storage.storyDirectory, ...relative.split("/")),
        sha256,
        sizeBytes: item.sizeBytes,
      };
    })
    .filter(Boolean);

  function verifiedManifestItem(absolutePath) {
    const item = manifest.find((entry) => sameRealPath(entry.absolutePath, absolutePath));
    if (!item) return null;
    try {
      validateStorageTarget(item.absolutePath, {
        baseDirectory: storage.storyDirectory,
        mustExist: true,
        expectedType: "file",
      });
      const stat = lstatSync(item.absolutePath);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== item.sizeBytes) return null;
      if (sha256File(item.absolutePath) !== item.sha256) return null;
      return item;
    } catch {
      return null;
    }
  }

  async function readReceiptStream() {
    let existing;
    try {
      existing = await readEnvelopes({ tab, payloadSchemaId: WORKFLOW_V2_SCHEMA_IDS.evidenceReceipt });
    } catch (error) {
      fail(`unable to read receipt stream: ${error.message}`, "WORKFLOW_V2_RECEIPT_RECORDER_READ_FAILED", {
        causeCode: String(error?.code || ""),
      });
    }
    if (!Array.isArray(existing)) {
      fail("receipt reader did not return an array", "WORKFLOW_V2_RECEIPT_RECORDER_READ_FAILED");
    }
    return existing;
  }

  function operationArgsSha256(payload, operationArgs) {
    return canonicalSha256({
      action: payload.action,
      toolName: payload.toolName,
      rootId: payload.rootId ?? null,
      selector: payload.selector ?? null,
      operationArgs,
    });
  }

  function exactObjectKeys(value, expectedKeys) {
    return !!value && typeof value === "object" && !Array.isArray(value)
      && canonicalSha256(Object.keys(value).sort()) === canonicalSha256([...expectedKeys].sort());
  }

  function validControllerText(value, max, { nullable = false } = {}) {
    if (value === null && nullable) return true;
    return typeof value === "string" && value.length > 0 && value.length <= max
      && !/[\u0000-\u001f\u007f-\u009f]/u.test(value);
  }

  function validateSettledSelector(payload, skeleton, entry) {
    const selector = payload?.selector;
    const frozenSelector = skeleton?.selector;
    const controller = selector?.controller;
    const expectedKeys = [
      ...Object.keys(frozenSelector || {}),
      ...(controller === undefined ? [] : ["controller"]),
    ];
    if (!exactObjectKeys(selector, expectedKeys)
      || Object.entries(frozenSelector || {}).some(([key, value]) => canonicalSha256(selector[key]) !== canonicalSha256(value))) {
      fail("durable controlled operation selector changed its frozen fields", "WORKFLOW_V2_CONTROLLED_OPERATION_SETTLEMENT_INVALID");
    }
    const reservedControllerAdapter = [
      WORKFLOW_V2_BUILD_CONTROLLER_ADAPTER_ID,
      WORKFLOW_V2_DEVICE_PROXY_ADAPTER_ID,
    ].includes(entry?.adapterId);
    if (controller === undefined) {
      if (reservedControllerAdapter && payload.status === "PASS") {
        fail("durable Controller PASS has no Controller receipt binding", "WORKFLOW_V2_CONTROLLED_OPERATION_SETTLEMENT_INVALID");
      }
      return;
    }
    if (!reservedControllerAdapter || !controller || typeof controller !== "object" || Array.isArray(controller)) {
      fail("durable controlled operation contains an unexpected Controller binding", "WORKFLOW_V2_CONTROLLED_OPERATION_SETTLEMENT_INVALID");
    }

    if (entry.adapterId === WORKFLOW_V2_BUILD_CONTROLLER_ADAPTER_ID) {
      const keys = [
        "kind", "receiptId", "operationId", "resultCode", "storyId", "repositoryId", "rootId",
        "storyFlavor", "flavor", "buildType", "task", "head", "version", "artifact",
      ];
      const root = (Array.isArray(dispatch?.context?.scope?.roots) ? dispatch.context.scope.roots : [])
        .find((candidate) => candidate?.rootId === skeleton.rootId);
      const commonValid = exactObjectKeys(controller, keys)
        && controller.kind === "BUILD"
        && validControllerText(controller.receiptId, 160)
        && validControllerText(controller.operationId, 160)
        && validControllerText(controller.resultCode, 160, { nullable: true })
        && controller.repositoryId === String(root?.repositoryId || "")
        && controller.rootId === skeleton.rootId
        && controller.buildType === entry.adapterArgs?.buildType
        && controller.head === String(root?.headSha || "")
        && [null, String(tab.id)].includes(controller.storyId)
        && [null, String(root?.flavor || "")].includes(controller.storyFlavor);
      if (!commonValid) {
        fail("durable BUILD Controller binding does not match the frozen root", "WORKFLOW_V2_CONTROLLED_OPERATION_SETTLEMENT_INVALID");
      }
      if (payload.status === "PASS") {
        const versionValid = controller.version === null || (
          exactObjectKeys(controller.version, ["versionName", "versionCode"])
          && (controller.version.versionName === null || validControllerText(controller.version.versionName, 100))
          && (controller.version.versionCode === null || Number.isSafeInteger(controller.version.versionCode))
        );
        const artifact = controller.artifact;
        const artifactValid = exactObjectKeys(artifact, ["outputRef", "sha256", "sizeBytes"])
          && validControllerText(artifact.outputRef, 600)
          && /^[a-f0-9]{64}$/.test(String(artifact.sha256 || ""))
          && Number.isSafeInteger(artifact.sizeBytes) && artifact.sizeBytes >= 0;
        if (controller.storyId !== String(tab.id)
          || controller.storyFlavor !== String(root?.flavor || "")
          || !validControllerText(controller.flavor, 100)
          || !/^(?::[A-Za-z0-9_.-]+)*:?[A-Za-z][A-Za-z0-9_]*$/.test(String(controller.task || ""))
          || !versionValid || !artifactValid) {
          fail("durable BUILD PASS Controller binding is incomplete", "WORKFLOW_V2_CONTROLLED_OPERATION_SETTLEMENT_INVALID");
        }
      }
      return;
    }

    const deviceKeys = [
      "kind", "receiptId", "operationId", "resultCode", "storyId", "businessAction",
      "serialSha256", "leaseId", "fencingToken",
    ];
    const lease = dispatch?.deviceLeaseSnapshot;
    if (!exactObjectKeys(controller, deviceKeys)
      || controller.kind !== "DEVICE_ACTION"
      || !validControllerText(controller.receiptId, 160)
      || !validControllerText(controller.operationId, 160)
      || !validControllerText(controller.resultCode, 160, { nullable: true })
      || controller.storyId !== String(tab.id)
      || controller.businessAction !== entry.adapterArgs?.businessAction
      || controller.serialSha256 !== canonicalSha256(String(tab.deviceSerial || ""))
      || controller.leaseId !== lease?.leaseId
      || controller.fencingToken !== lease?.fencingToken) {
      fail("durable DEVICE_ACTION Controller binding does not match the frozen lease", "WORKFLOW_V2_CONTROLLED_OPERATION_SETTLEMENT_INVALID");
    }
  }

  function validateSettledControlledOperation(settlement, skeleton, operationArgs, entry) {
    const payload = settlement?.payload;
    if (!payload || payload.operationId !== skeleton.operationId
      || payload.receiptId !== skeleton.receiptId
      || payload.idempotencyKey !== skeleton.idempotencyKey
      || payload.action !== skeleton.action
      || payload.toolName !== skeleton.toolName
      || payload.rootId !== skeleton.rootId
      || canonicalSha256(settlement.operationArgs || null) !== canonicalSha256(operationArgs)
      || !["PASS", "FAIL", "BLOCKED", "PARTIAL"].includes(payload.status)
      || !Number.isFinite(Date.parse(String(payload.startedAt || "")))
      || !Number.isFinite(Date.parse(String(payload.finishedAt || "")))) {
      fail(
        "durable controlled operation settlement does not match the frozen execution",
        "WORKFLOW_V2_CONTROLLED_OPERATION_SETTLEMENT_INVALID",
        { operationId: skeleton.operationId },
      );
    }
    validateSettledSelector(payload, skeleton, entry);
    if (payload.outputRef || payload.sha256) {
      const sha256 = String(payload.sha256 || "");
      const expectedRef = `storydev:/workflow-v2/receipt-output/${sha256}.txt`;
      if (!/^[a-f0-9]{64}$/.test(sha256) || payload.outputRef !== expectedRef) {
        fail("durable controlled operation output binding is invalid", "WORKFLOW_V2_CONTROLLED_OPERATION_SETTLEMENT_INVALID");
      }
      if (createHash("sha256").update(String(settlement.output || ""), "utf8").digest("hex") !== sha256) {
        fail("durable controlled operation output differs from its settled bytes", "WORKFLOW_V2_CONTROLLED_OPERATION_SETTLEMENT_INVALID");
      }
      const outputPath = path.join(storage.storyDirectory, "workflow-v2", "receipt-output", `${sha256}.txt`);
      validateStorageTarget(outputPath, {
        baseDirectory: path.dirname(outputPath),
        mustExist: true,
        expectedType: "file",
      });
      const stat = lstatSync(outputPath);
      if (!stat.isFile() || stat.isSymbolicLink() || sha256File(outputPath) !== sha256) {
        fail("durable controlled operation output cannot be re-verified", "WORKFLOW_V2_CONTROLLED_OPERATION_SETTLEMENT_INVALID");
      }
    } else if (payload.status === "PASS") {
      fail("durable PASS settlement has no verified output", "WORKFLOW_V2_CONTROLLED_OPERATION_SETTLEMENT_INVALID");
    }
    return payload;
  }

  async function preflightOperation(payload, operationArgs) {
    const existing = await readReceiptStream();
    const byIdempotency = existing.find((entry) => entry.idempotencyKey === payload.idempotencyKey);
    const byOperation = existing.find((entry) => entry.payload?.operationId === payload.operationId);
    if (byIdempotency && byOperation && byIdempotency !== byOperation) {
      fail("receipt idempotencyKey and operationId resolve to different envelopes", "WORKFLOW_V2_RECEIPT_OPERATION_CONFLICT", {
        operationId: payload.operationId,
      });
    }
    const candidate = byIdempotency || byOperation;
    if (!candidate) return { existing, replay: null };
    // A receipt selector may contain system-observed post-state (for example,
    // EDIT afterSha256). Recompute the envelope-store hash with the persisted
    // selector and the newly requested operationArgs so replay can be decided
    // before another side effect without trusting current filesystem state.
    const expectedArgsSha = operationArgsSha256(candidate.payload, operationArgs);
    const persistedArgsSha = candidate.operationArgsSha256
      || (candidate.operationArgs && operationArgsSha256(candidate.payload, candidate.operationArgs));
    const persistedSelector = candidate.payload?.selector;
    const selectorIdentityMatches = persistedSelector && Object.entries(payload.selector || {})
      .every(([key, value]) => persistedSelector[key] === value);
    const editObservationValid = candidate.payload?.action !== "EDIT" || (
      typeof persistedSelector.beforeExists === "boolean"
      && typeof persistedSelector.afterExists === "boolean"
      && (persistedSelector.beforeSha256 === null || /^[a-f0-9]{64}$/.test(persistedSelector.beforeSha256))
      && (persistedSelector.afterSha256 === null || /^[a-f0-9]{64}$/.test(persistedSelector.afterSha256))
      && persistedSelector.beforeExists === (persistedSelector.beforeSha256 !== null)
      && persistedSelector.afterExists === (persistedSelector.afterSha256 !== null)
      && (candidate.payload.status !== "PASS"
        || persistedSelector.beforeSha256 !== persistedSelector.afterSha256)
    );
    if (candidate.payload?.operationId !== payload.operationId
      || persistedArgsSha !== expectedArgsSha
      || candidate.payload?.receiptId !== payload.receiptId
      || !selectorIdentityMatches
      || !editObservationValid) {
      fail("receipt operation identity is already bound to different arguments", "WORKFLOW_V2_RECEIPT_OPERATION_CONFLICT", {
        operationId: payload.operationId,
      });
    }
    return { existing, replay: candidate };
  }

  async function appendReceiptEnvelope(payload, operationArgs, prefetched = null) {
    for (let attempt = 0; attempt < RECEIPT_MAX_ATTEMPTS; attempt += 1) {
      const existing = attempt === 0 && Array.isArray(prefetched) ? prefetched : await readReceiptStream();
      try {
        return await appendReceipt({
          tab,
          revision: existing.length + 1,
          idempotencyKey: payload.idempotencyKey,
          operationArgs,
          payload,
        });
      } catch (error) {
        if (error?.code === "WORKFLOW_V2_STALE_REVISION") continue;
        throw error;
      }
    }
    fail("receipt append could not stabilize under concurrency", "WORKFLOW_V2_RECEIPT_RECORDER_REVISION_RACE");
  }

  async function withOperationLock(operationId, callback) {
    while (operationLocks.has(operationId)) await operationLocks.get(operationId);
    let release;
    const pending = new Promise((resolve) => { release = resolve; });
    operationLocks.set(operationId, pending);
    try {
      return await callback();
    } finally {
      operationLocks.delete(operationId);
      release();
    }
  }

  function controlledDescriptor(kind, identity, rootId, editState) {
    const entry = profileEntry({ executionProfile, stageContext: dispatch.context, stageId, kind, identity });
    if (entry.rootId !== rootId) {
      fail("controlled execution rootId does not match the frozen profile", "WORKFLOW_V2_RECEIPT_EXECUTION_ROOT_MISMATCH", {
        expectedRootId: entry.rootId,
        actualRootId: rootId,
      });
    }
    const identityField = kind === "check" ? "checkId" : "caseId";
    const selector = {
      contextId,
      contextRevision,
      executorId: entry.executorId,
      [identityField]: identity,
      ...(kind === "check" ? { name: entry.name } : {}),
      ...(CHECK_ACTIONS.has(entry.action) ? {
        editStateSha256: editState.editStateSha256,
        editStateVersionSha256: editState.editStateVersionSha256,
      } : {}),
    };
    const operationId = `${kind}:${canonicalSha256({
      contextId,
      contextRevision,
      identity,
      ...(CHECK_ACTIONS.has(entry.action) ? {
        editStateSha256: editState.editStateSha256,
        editStateVersionSha256: editState.editStateVersionSha256,
      } : {}),
    })}`;
    const operationArgs = {
      profileId: entry.profileId,
      executorId: entry.executorId,
      action: entry.action,
      rootId,
      executionSha256: canonicalSha256({
        action: entry.action,
        adapterId: entry.adapterId,
        argv: entry.argv,
        adapterArgs: entry.adapterArgs,
        timeoutMs: entry.timeoutMs,
      }),
      ...(CHECK_ACTIONS.has(entry.action) ? {
        editStateSha256: editState.editStateSha256,
        editStateVersionSha256: editState.editStateVersionSha256,
      } : {}),
    };
    const skeleton = {
      schemaVersion: "evidence-receipt-v2",
      receiptId: receiptIdFor(operationId, entry.action),
      ...(entry.evidenceId ? { evidenceId: String(entry.evidenceId) } : {}),
      action: entry.action,
      toolName: kind === "check" ? "run_local_check" : "run_verification_case",
      rootId,
      operationId,
      selector,
      idempotencyKey: operationId,
    };
    return { entry, operationArgs, skeleton };
  }

  async function readVerifiedEditState(rootId, absoluteRoot) {
    let state;
    try {
      state = deriveWorkflowV2EditState({
        envelopes: await readReceiptStream(),
        storyId,
        contextId,
        contextRevision,
        rootId,
      });
      verifyWorkflowV2EditStateFiles({ absoluteRoot, state });
    } catch (error) {
      fail(
        `controlled check cannot bind the live final EDIT state: ${error?.message || error}`,
        "WORKFLOW_V2_RECEIPT_EDIT_STATE_INVALID",
        { causeCode: String(error?.code || "") },
      );
    }
    return state;
  }

  async function executeControlled(entry, absoluteRoot, signal) {
    if (typeof absoluteRoot !== "string" || !path.isAbsolute(absoluteRoot)
      || !existsSync(absoluteRoot) || !statSync(absoluteRoot).isDirectory()) {
      fail("authorized controlled execution root is unavailable", "WORKFLOW_V2_RECEIPT_EXECUTION_ROOT_INVALID");
    }
    if (entry.adapterId !== "process") {
      const handler = resolvedAdapterHandlers?.[entry.adapterId];
      if (typeof handler !== "function") {
        return {
          status: "BLOCKED",
          exitCode: null,
          summary: `trusted adapter ${entry.adapterId} is unavailable`,
          output: `controlled adapter unavailable: ${entry.adapterId}`,
        };
      }
      try {
        const result = await handler({
          action: entry.action,
          adapterId: entry.adapterId,
          adapterArgs: Object.freeze({ ...entry.adapterArgs }),
          absoluteRoot,
          context: dispatch.context,
          executorId: entry.executorId,
          rootId: entry.rootId,
          caseOrCheck: entry.caseOrCheck,
          signal,
          timeoutMs: entry.timeoutMs,
        });
        const status = String(result?.status || "");
        if (!["PASS", "FAIL", "BLOCKED", "PARTIAL"].includes(status)) {
          fail("trusted adapter returned an invalid status", "WORKFLOW_V2_RECEIPT_ADAPTER_RESULT_INVALID", {
            adapterId: entry.adapterId,
          });
        }
        const reservedControllerAdapter = [
          WORKFLOW_V2_BUILD_CONTROLLER_ADAPTER_ID,
          WORKFLOW_V2_DEVICE_PROXY_ADAPTER_ID,
        ].includes(entry.adapterId);
        const receiptBinding = reservedControllerAdapter ? result?.receiptBinding : null;
        if (reservedControllerAdapter && status === "PASS"
          && (!receiptBinding || typeof receiptBinding !== "object" || Array.isArray(receiptBinding))) {
          fail("controller adapter omitted its receipt binding", "WORKFLOW_V2_RECEIPT_ADAPTER_RESULT_INVALID", {
            adapterId: entry.adapterId,
          });
        }
        return {
          status,
          exitCode: Number.isInteger(result?.exitCode) ? result.exitCode : null,
          ...(result?.sha256 ? { sha256: String(result.sha256) } : {}),
          ...(receiptBinding ? { receiptBinding } : {}),
          summary: boundedText(result?.summary || `${entry.action} ${status}`),
          output: boundedText(result?.output || "", MAX_PROCESS_OUTPUT_CHARS),
        };
      } catch (error) {
        return { status: "FAIL", exitCode: null, summary: `${entry.action} adapter failed`, output: boundedText(error.message, MAX_PROCESS_OUTPUT_CHARS) };
      }
    }
    const result = await runProcess({
      argv: [...entry.argv],
      cwd: absoluteRoot,
      timeoutMs: entry.timeoutMs,
      signal,
    });
    const passed = result?.blocked !== true && result?.timedOut !== true && result?.exitCode === 0;
    return {
      status: passed ? "PASS" : (result?.timedOut || result?.blocked ? "BLOCKED" : "FAIL"),
      exitCode: Number.isInteger(result?.exitCode) ? result.exitCode : null,
      summary: result?.timedOut
        ? "controlled execution timed out"
        : (result?.blocked ? "confined controlled executor is unavailable" : `controlled execution ${passed ? "passed" : "failed"}`),
      output: boundedText(`${result?.stdout || ""}${result?.stderr ? `\n${result.stderr}` : ""}`, MAX_PROCESS_OUTPUT_CHARS),
    };
  }

  async function runControlled({ kind, identity, rootId, absoluteRoot, signal = null }) {
    const profile = profileEntry({ executionProfile, stageContext: dispatch.context, stageId, kind, identity });
    const initialEditState = CHECK_ACTIONS.has(profile.action)
      ? await readVerifiedEditState(rootId, absoluteRoot)
      : null;
    const { entry, operationArgs, skeleton } = controlledDescriptor(
      kind,
      identity,
      rootId,
      initialEditState,
    );
    return withOperationLock(skeleton.operationId, async () => {
      if (CHECK_ACTIONS.has(entry.action)) {
        const lockedEditState = await readVerifiedEditState(rootId, absoluteRoot);
        if (lockedEditState.editStateSha256 !== initialEditState.editStateSha256
          || lockedEditState.editStateVersionSha256 !== initialEditState.editStateVersionSha256) {
          fail(
            "final EDIT state changed while the controlled check was waiting to start",
            "WORKFLOW_V2_RECEIPT_EDIT_STATE_CHANGED_BEFORE_EXECUTION",
          );
        }
      }
      const startedAt = now();
      const initialPayload = { ...skeleton, status: "BLOCKED", startedAt, finishedAt: startedAt };
      const preflight = await preflightOperation(initialPayload, operationArgs);
      const operationArgsHash = canonicalSha256(operationArgs);
      const durableOperation = controlledOperationJournal.reserve({
        operationId: skeleton.operationId,
        receiptId: skeleton.receiptId,
        operationArgsSha256: operationArgsHash,
      });
      if (preflight.replay) {
        if (durableOperation.kind !== "SETTLED") {
          fail(
            "controlled receipt exists without a provable durable settlement",
            "WORKFLOW_V2_CONTROLLED_OPERATION_AMBIGUOUS",
            { operationId: skeleton.operationId },
          );
        }
        const settledPayload = validateSettledControlledOperation(
          durableOperation.settlement,
          skeleton,
          operationArgs,
          entry,
        );
        if (canonicalSha256(settledPayload) !== canonicalSha256(preflight.replay.payload)) {
          fail(
            "controlled receipt differs from its durable settlement",
            "WORKFLOW_V2_CONTROLLED_OPERATION_SETTLEMENT_INVALID",
            { operationId: skeleton.operationId },
          );
        }
        const receipt = preflight.replay.payload;
        return {
          replayed: true,
          envelope: preflight.replay,
          receiptId: receipt.receiptId,
          status: receipt.status,
          action: receipt.action,
          evidenceId: receipt.evidenceId || null,
          output: durableOperation.settlement.output,
        };
      }
      if (durableOperation.kind === "SETTLED") {
        const settledPayload = validateSettledControlledOperation(
          durableOperation.settlement,
          skeleton,
          operationArgs,
          entry,
        );
        const stored = await appendReceiptEnvelope(settledPayload, operationArgs, preflight.existing);
        return {
          ...stored,
          replayed: true,
          receiptId: stored.envelope.payload.receiptId,
          status: stored.envelope.payload.status,
          action: stored.envelope.payload.action,
          evidenceId: stored.envelope.payload.evidenceId || null,
          output: durableOperation.settlement.output,
        };
      }
      let executed = await executeControlled(entry, absoluteRoot, signal);
      if (CHECK_ACTIONS.has(entry.action)) {
        try {
          const finishedEditState = await readVerifiedEditState(rootId, absoluteRoot);
          if (finishedEditState.editStateSha256 !== initialEditState.editStateSha256
            || finishedEditState.editStateVersionSha256 !== initialEditState.editStateVersionSha256) {
            throw Object.assign(new Error("final EDIT state changed during controlled execution"), {
              code: "WORKFLOW_V2_RECEIPT_EDIT_STATE_CHANGED_DURING_EXECUTION",
            });
          }
        } catch (error) {
          executed = {
            status: "BLOCKED",
            exitCode: null,
            summary: "final EDIT state changed during controlled execution",
            output: boundedText(`${error?.code || "WORKFLOW_V2_RECEIPT_EDIT_STATE_CHANGED_DURING_EXECUTION"}: ${error?.message || error}`),
          };
        }
      }
      const observedOutput = boundedText(executed.output || "", MAX_PROCESS_OUTPUT_CHARS);
      let persistedOutput = null;
      if (observedOutput) {
        try {
          const outputBytes = Buffer.from(observedOutput, "utf8");
          const outputSha256 = createHash("sha256").update(outputBytes).digest("hex");
          const relativeOutputPath = `workflow-v2/receipt-output/${outputSha256}.txt`;
          const workflowDirectory = path.join(storage.storyDirectory, "workflow-v2");
          const outputDirectory = path.join(storage.storyDirectory, "workflow-v2", "receipt-output");
          const absoluteOutputPath = path.join(outputDirectory, `${outputSha256}.txt`);
          // Never traverse a pre-created symlink/junction. Each directory is
          // created by the story-storage validator and revalidated before the
          // leaf is authorized for an exclusive write.
          validateStorageTarget(workflowDirectory, {
            baseDirectory: storage.storyDirectory,
            createDirectory: true,
            expectedType: "directory",
          });
          validateStorageTarget(outputDirectory, {
            baseDirectory: workflowDirectory,
            createDirectory: true,
            expectedType: "directory",
          });
          validateStorageTarget(absoluteOutputPath, {
            baseDirectory: outputDirectory,
            mustExist: false,
          });
          try {
            writeExclusiveDurable(absoluteOutputPath, outputBytes);
          } catch (error) {
            if (error?.code !== "EEXIST") throw error;
          }
          validateStorageTarget(absoluteOutputPath, {
            baseDirectory: outputDirectory,
            mustExist: true,
            expectedType: "file",
          });
          if (sha256File(absoluteOutputPath) !== outputSha256) {
            fail("controlled receipt output hash changed after write", "WORKFLOW_V2_RECEIPT_OUTPUT_PATH_BOUNDARY_REJECTED");
          }
          persistedOutput = {
            outputRef: `storydev:/${relativeOutputPath}`,
            sha256: outputSha256,
          };
        } catch (error) {
          executed = {
            ...executed,
            status: "BLOCKED",
            exitCode: null,
            summary: "controlled execution output could not be persisted",
            output: boundedText(error.message, MAX_PROCESS_OUTPUT_CHARS),
          };
        }
      }
      if (executed.status === "PASS" && !persistedOutput) {
        executed = {
          ...executed,
          status: "BLOCKED",
          exitCode: null,
          summary: "controlled execution returned no persistable output",
        };
      }
      const finishedAt = now();
      const payload = {
        ...skeleton,
        selector: {
          ...skeleton.selector,
          ...(executed.receiptBinding || {}),
        },
        status: executed.status,
        startedAt,
        finishedAt,
        exitCode: executed.exitCode,
        ...(persistedOutput || {}),
        summary: boundedText(executed.summary),
        ...(executed.status === "PASS" ? {} : { error: boundedText(executed.summary) }),
      };
      const settlement = controlledOperationJournal.settle(durableOperation, {
        payload,
        operationArgs,
        output: executed.output,
      });
      const settledPayload = validateSettledControlledOperation(settlement, skeleton, operationArgs, entry);
      const stored = await appendReceiptEnvelope(settledPayload, operationArgs, preflight.existing);
      return {
        ...stored,
        receiptId: stored.envelope.payload.receiptId,
        status: stored.envelope.payload.status,
        action: stored.envelope.payload.action,
        evidenceId: stored.envelope.payload.evidenceId || null,
        output: executed.output,
      };
    });
  }

  return {
    manifest,
    contextId,
    contextRevision,
    storyId,
    hasExecutionProfile: !!executionProfile,

    async recordRead({ absolutePath, toolName = "read_file", rootId = null, operationArgs = null }) {
      const item = verifiedManifestItem(absolutePath);
      if (!item) return null;
      const boundArgs = operationArgs && typeof operationArgs === "object" && !Array.isArray(operationArgs)
        ? operationArgs
        : { path: item.relativePath };
      const toolCallSha256 = canonicalSha256(boundArgs);
      const finishedAt = now();
      const operationId = `read:${canonicalSha256({
        contextId,
        contextRevision,
        evidenceId: item.evidenceId,
        toolName,
        toolCallSha256,
        sha256: item.sha256,
      })}`;
      const payload = {
        schemaVersion: "evidence-receipt-v2",
        receiptId: receiptIdFor(operationId, "READ"),
        evidenceId: item.evidenceId,
        action: "READ",
        status: "PASS",
        toolName,
        ...(rootId ? { rootId: String(rootId) } : {}),
        operationId,
        selector: {
          contextId,
          contextRevision,
          path: item.relativePath,
          sourceEvidenceId: item.evidenceId,
          toolCallSha256,
        },
        startedAt: finishedAt,
        finishedAt,
        sha256: item.sha256,
        summary: `Read frozen evidence ${item.evidenceId}; sha256 matched`,
        idempotencyKey: operationId,
      };
      const receiptOperationArgs = {
        toolName,
        rootId: rootId || null,
        path: item.relativePath,
        sha256: item.sha256,
        toolCallSha256,
      };
      const preflight = await preflightOperation(payload, receiptOperationArgs);
      if (preflight.replay) return { replayed: true, envelope: preflight.replay };
      return appendReceiptEnvelope(payload, receiptOperationArgs, preflight.existing);
    },

    async recordCapture({
      sourceAbsolutePath,
      generatedAbsolutePath = null,
      generatedRoot = null,
      expectedSha256 = null,
      toolName,
      rootId = null,
      operationArgs = {},
      captureKind,
      timestamp = null,
      page = null,
      observedStatus = "PASS",
      error = "",
    }) {
      const item = verifiedManifestItem(sourceAbsolutePath);
      if (!item) {
        fail("CAPTURE source is not a verified frozen manifest item", "WORKFLOW_V2_RECEIPT_CAPTURE_SOURCE_INVALID");
      }
      if (!["video-frame", "pdf-page"].includes(captureKind)
        || (captureKind === "video-frame" && (!Number.isFinite(timestamp) || timestamp < 0))
        || (captureKind === "pdf-page" && (!Number.isSafeInteger(page) || page < 1))) {
        fail("CAPTURE selector is invalid", "WORKFLOW_V2_RECEIPT_CAPTURE_SELECTOR_INVALID");
      }
      const normalizedStatus = String(observedStatus || "").toUpperCase();
      if (!["PASS", "FAIL", "BLOCKED"].includes(normalizedStatus)) {
        fail("CAPTURE observed status is invalid", "WORKFLOW_V2_RECEIPT_CAPTURE_STATUS_INVALID");
      }
      const toolCallSha256 = canonicalSha256(operationArgs && typeof operationArgs === "object" ? operationArgs : {});
      const captureSelector = {
        contextId,
        contextRevision,
        sourceEvidenceId: item.evidenceId,
        sourcePath: item.relativePath,
        sourceSha256: item.sha256,
        captureKind,
        ...(captureKind === "video-frame" ? { timestamp } : { page }),
        toolCallSha256,
      };
      const operationId = `capture:${canonicalSha256(captureSelector)}`;
      const skeleton = {
        schemaVersion: "evidence-receipt-v2",
        receiptId: receiptIdFor(operationId, "CAPTURE"),
        evidenceId: `capture-evidence-${canonicalSha256({ operationId }).slice(0, 32)}`,
        action: "CAPTURE",
        toolName: String(toolName || ""),
        ...(rootId ? { rootId: String(rootId) } : {}),
        operationId,
        selector: captureSelector,
        idempotencyKey: operationId,
      };
      const receiptOperationArgs = {
        toolName: skeleton.toolName,
        rootId: rootId || null,
        sourceEvidenceId: item.evidenceId,
        sourceSha256: item.sha256,
        captureKind,
        ...(captureKind === "video-frame" ? { timestamp } : { page }),
        toolCallSha256,
      };
      const preflight = await preflightOperation(
        { ...skeleton, status: "BLOCKED", startedAt: now(), finishedAt: now() },
        receiptOperationArgs,
      );
      if (preflight.replay) {
        const replayPayload = preflight.replay.payload;
        if (replayPayload?.status === "PASS") {
          const sha256 = String(replayPayload.sha256 || "");
          const outputPath = path.join(storage.storyDirectory, "workflow-v2", "capture-output", `${sha256}.bin`);
          try {
            validateStorageTarget(outputPath, {
              baseDirectory: path.dirname(outputPath),
              mustExist: true,
              expectedType: "file",
            });
            const stat = lstatSync(outputPath);
            if (!/^[a-f0-9]{64}$/.test(sha256)
              || replayPayload.outputRef !== `storydev:/workflow-v2/capture-output/${sha256}.bin`
              || !stat.isFile() || stat.isSymbolicLink() || sha256File(outputPath) !== sha256) {
              throw new Error("capture output binding mismatch");
            }
          } catch (replayError) {
            fail(
              `CAPTURE replay output cannot be verified: ${replayError?.message || replayError}`,
              "WORKFLOW_V2_RECEIPT_CAPTURE_OUTPUT_INVALID",
            );
          }
        }
        return { replayed: true, envelope: preflight.replay };
      }

      const recordedAt = now();
      let status = normalizedStatus;
      let outputBinding = null;
      let captureError = boundedText(error || "");
      if (status === "PASS") {
        try {
          const bytes = readPlainGeneratedCapture(generatedAbsolutePath, generatedRoot);
          const sha256 = createHash("sha256").update(bytes).digest("hex");
          if (!/^[a-f0-9]{64}$/.test(String(expectedSha256 || "")) || sha256 !== expectedSha256) {
            throw new Error("capture output changed after the media tool observation");
          }
          const workflowDirectory = path.join(storage.storyDirectory, "workflow-v2");
          const outputDirectory = path.join(workflowDirectory, "capture-output");
          const outputPath = path.join(outputDirectory, `${sha256}.bin`);
          validateStorageTarget(workflowDirectory, {
            baseDirectory: storage.storyDirectory,
            createDirectory: true,
            expectedType: "directory",
          });
          validateStorageTarget(outputDirectory, {
            baseDirectory: workflowDirectory,
            createDirectory: true,
            expectedType: "directory",
          });
          validateStorageTarget(outputPath, { baseDirectory: outputDirectory, mustExist: false });
          try {
            writeExclusiveDurable(outputPath, bytes);
          } catch (writeError) {
            if (writeError?.code !== "EEXIST") throw writeError;
          }
          validateStorageTarget(outputPath, {
            baseDirectory: outputDirectory,
            mustExist: true,
            expectedType: "file",
          });
          const storedStat = lstatSync(outputPath);
          if (!storedStat.isFile() || storedStat.isSymbolicLink() || sha256File(outputPath) !== sha256) {
            throw new Error("content-addressed capture output hash mismatch");
          }
          outputBinding = {
            outputRef: `storydev:/workflow-v2/capture-output/${sha256}.bin`,
            sha256,
          };
        } catch (captureOutputError) {
          status = "BLOCKED";
          captureError = boundedText(captureOutputError?.message || captureOutputError);
        }
      }
      const payload = {
        ...skeleton,
        status,
        startedAt: recordedAt,
        finishedAt: recordedAt,
        ...(outputBinding || {}),
        summary: status === "PASS"
          ? `Captured ${captureKind} from frozen evidence ${item.evidenceId}`
          : `Capture ${captureKind} did not produce verified content`,
        ...(status === "PASS" ? {} : { error: captureError || "capture failed without a verified output" }),
      };
      return appendReceiptEnvelope(payload, receiptOperationArgs, preflight.existing);
    },

    async recordEditExecution({ toolName, rootId, pathRefs, operationArgs, execute }) {
      if (!["edit_file", "apply_patch"].includes(toolName) || typeof execute !== "function") {
        fail("unsupported EDIT receipt request", "WORKFLOW_V2_RECEIPT_EDIT_INVALID");
      }
      const targets = (Array.isArray(pathRefs) ? pathRefs : [])
        .filter((ref) => ref?.access === "write" && typeof ref.absolutePath === "string" && typeof ref.path === "string");
      if (!targets.length || targets.some((ref) => ref.rootId !== rootId)) {
        fail("EDIT receipt has no exact authorized targets", "WORKFLOW_V2_RECEIPT_EDIT_INVALID");
      }
      const callDigest = canonicalSha256({ toolName, rootId, operationArgs });
      return withOperationLock(`edit-group:${canonicalSha256({ contextId, contextRevision, callDigest })}`, async () => {
        const prepared = [];
        for (const target of targets) {
          const operationId = `edit:${canonicalSha256({
            contextId,
            contextRevision,
            rootId,
            path: target.path,
            callDigest,
          })}`;
          const selector = { contextId, contextRevision, path: target.path };
          const args = { toolName, rootId, path: target.path, callDigest };
          const skeleton = {
            schemaVersion: "evidence-receipt-v2",
            receiptId: receiptIdFor(operationId, "EDIT"),
            action: "EDIT",
            toolName,
            rootId,
            operationId,
            selector,
            idempotencyKey: operationId,
          };
          const check = await preflightOperation({ ...skeleton, status: "BLOCKED", startedAt: now(), finishedAt: now() }, args);
          prepared.push({ target, args, skeleton, check });
        }
        const replayCount = prepared.filter((item) => item.check.replay).length;
        if (replayCount && replayCount !== prepared.length) {
          fail("EDIT operation is only partially replayable", "WORKFLOW_V2_RECEIPT_EDIT_PARTIAL_REPLAY");
        }
        if (replayCount === prepared.length) {
          return {
            replayed: true,
            result: "Gateway replayed the previously completed edit operation",
            receipts: prepared.map((item) => item.check.replay),
          };
        }
        const before = new Map(prepared.map((item) => [item.target.absolutePath, safeFileSnapshot(item.target.absolutePath)]));
        const startedAt = now();
        let result;
        let executionError = null;
        try { result = await execute(); } catch (error) { executionError = error; result = `edit execution failed: ${error.message}`; }
        const finishedAt = now();
        const receipts = [];
        for (const item of prepared) {
          const prior = before.get(item.target.absolutePath);
          const after = safeFileSnapshot(item.target.absolutePath);
          const changed = prior?.sha256 !== after?.sha256 && (!!prior || !!after);
          const payload = {
            ...item.skeleton,
            selector: {
              ...item.skeleton.selector,
              beforeExists: !!prior,
              afterExists: !!after,
              beforeSha256: prior?.sha256 || null,
              afterSha256: after?.sha256 || null,
            },
            status: changed && !executionError ? "PASS" : "FAIL",
            startedAt,
            finishedAt,
            ...(after?.sha256 ? { sha256: after.sha256 } : {}),
            summary: changed && !executionError
              ? `Edited ${item.target.path}; before=${prior?.sha256 || "missing"}; after=${after?.sha256 || "missing"}`
              : `EDIT produced no verified change for ${item.target.path}`,
            ...(!changed || executionError ? { error: boundedText(executionError?.message || "no content hash change") } : {}),
          };
          receipts.push((await appendReceiptEnvelope(payload, item.args, item.check.existing)).envelope);
        }
        return { replayed: false, result, receipts };
      });
    },

    runLocalCheck(input) {
      assertExactControlledInput(input, new Set(["rootId", "checkId", "absoluteRoot", "signal"]));
      const { rootId, checkId, absoluteRoot, signal = null } = input;
      return runControlled({ kind: "check", identity: checkId, rootId, absoluteRoot, signal });
    },

    runVerificationCase(input) {
      assertExactControlledInput(input, new Set(["rootId", "caseId", "absoluteRoot", "signal"]));
      const { rootId, caseId, absoluteRoot, signal = null } = input;
      return runControlled({ kind: "case", identity: caseId, rootId, absoluteRoot, signal });
    },
  };
}

export function isStageReceiptRecorder(value) {
  return !!value
    && typeof value === "object"
    && typeof value.recordRead === "function"
    && typeof value.recordCapture === "function"
    && typeof value.recordEditExecution === "function"
    && typeof value.runLocalCheck === "function"
    && typeof value.runVerificationCase === "function"
    && Array.isArray(value.manifest);
}
