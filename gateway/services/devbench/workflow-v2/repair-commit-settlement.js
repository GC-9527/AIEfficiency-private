import path from "node:path";
import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import {
  link,
  lstat,
  open,
  readFile,
  readdir,
  unlink,
} from "node:fs/promises";

import * as storyStore from "../store.js";
import { getGitControllerRuntime } from "../git-controller-runtime.js";
import { verifyControlledReceiptOutput } from "./controlled-receipt-evidence.js";
import {
  deriveWorkflowV2EditState,
  receiptBindsWorkflowV2EditState,
  verifyWorkflowV2EditStateFiles,
} from "./edit-state-binding.js";
import {
  canonicalJson,
  canonicalSha256,
  readWorkflowV2Envelopes,
} from "./envelope-store.js";
import {
  WORKFLOW_V2_SCHEMA_IDS,
  workflowV2SchemaRegistry,
} from "./schema-registry.js";

const CHECK_ACTIONS = new Set(["BUILD", "TEST"]);
export const WORKFLOW_V2_GIT_SETTLEMENT_SCHEMA_VERSION = "workflow-v2-git-settlement-v1";
export const WORKFLOW_V2_REPAIR_RECOVERY_SCHEMA_VERSION = "workflow-v2-repair-recovery-v1";
const SHA_PATTERN = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const RECOVERY_FILE_PATTERN = /^[a-f0-9]{64}\.json$/;
const RECOVERY_STEPS = new Set([
  "gitCommitted",
  "stageResultRecorded",
  "compatibilityRecorded",
  "workflowApplied",
  "finalTabPersisted",
]);
const RECOVERY_DIRECTORY_PARTS = ["workflow-v2", "repair-recovery"];

export class WorkflowV2RepairCommitSettlementError extends Error {
  constructor(message, code, details = {}) {
    super(message);
    this.name = "WorkflowV2RepairCommitSettlementError";
    this.code = code;
    this.details = Object.freeze({ ...details });
  }
}

function fail(message, code, details = {}) {
  throw new WorkflowV2RepairCommitSettlementError(message, code, details);
}

function snapshot(value) {
  return JSON.parse(canonicalJson(value));
}

function recoveryKey({ storyId, contextId, contextRevision }) {
  return canonicalSha256({
    schemaVersion: WORKFLOW_V2_REPAIR_RECOVERY_SCHEMA_VERSION,
    storyId,
    stageId: "REPAIR",
    contextId,
    contextRevision,
  });
}

function safeRecoveryDispatch(dispatch) {
  const roots = Array.isArray(dispatch?.context?.scope?.roots)
    ? dispatch.context.scope.roots.map((root) => ({
      rootId: root?.rootId,
      kind: root?.kind,
      repositoryId: root?.repositoryId,
      branch: root?.branch,
      headSha: root?.headSha,
      flavor: root?.flavor,
      writable: root?.writable === true,
    }))
    : [];
  const localChecks = Array.isArray(dispatch?.context?.data?.localChecks)
    ? dispatch.context.data.localChecks.map((check) => ({
      checkId: check?.checkId,
      name: check?.name,
      executorId: check?.executorId,
      action: check?.action,
      mandatory: check?.mandatory === true,
      rootId: check?.rootId ?? check?.target?.rootId,
    }))
    : [];
  const executors = Array.isArray(dispatch?.executionProfile?.executors)
    ? dispatch.executionProfile.executors.map((executor) => ({
      executorId: executor?.executorId,
      action: executor?.action,
      cwdRootId: executor?.cwdRootId,
    }))
    : [];
  return snapshot({
    promptMode: "structured",
    stageId: "REPAIR",
    taskId: String(dispatch?.taskId || ""),
    attemptId: String(dispatch?.attemptId || ""),
    userMessageId: String(dispatch?.userMessageId || ""),
    contextId: dispatch?.contextId,
    contextRevision: dispatch?.contextRevision,
    resultSchemaId: dispatch?.resultSchemaId || dispatch?.context?.output?.schemaId,
    sourceCursor: dispatch?.sourceCursor || null,
    context: {
      contextId: dispatch?.context?.contextId,
      revision: dispatch?.context?.revision,
      idempotencyKey: dispatch?.context?.idempotencyKey,
      story: { storyId: dispatch?.context?.story?.storyId },
      stage: { id: dispatch?.context?.stage?.id },
      scope: { roots },
      data: { localChecks },
    },
    executionStatus: {
      status: dispatch?.executionStatus?.status,
      profileId: dispatch?.executionStatus?.profileId,
      blockers: Array.isArray(dispatch?.executionStatus?.blockers)
        ? dispatch.executionStatus.blockers.map((value) => String(value))
        : [],
    },
    executionProfile: {
      profileId: dispatch?.executionProfile?.profileId,
      stageId: dispatch?.executionProfile?.stageId,
      rootId: dispatch?.executionProfile?.rootId,
      executors,
    },
  });
}

function assertRecoveryContainsNoPrompt(value, trail = []) {
  if (!value || typeof value !== "object") return;
  for (const [key, entry] of Object.entries(value)) {
    const normalized = key.toLowerCase();
    if (["prompt", "rawprompt", "providercontent", "taskinstruction", "canonical"].includes(normalized)) {
      fail(
        "REPAIR recovery outbox must not persist Provider prompt material",
        "WORKFLOW_V2_REPAIR_RECOVERY_SENSITIVE_FIELD",
        { field: [...trail, key].join(".") },
      );
    }
    assertRecoveryContainsNoPrompt(entry, [...trail, key]);
  }
}

function unsignedRecoveryRecord(record) {
  const { recordSha256: _ignored, ...unsigned } = record;
  return unsigned;
}

function validateRecoveryRecord(record) {
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    fail("REPAIR recovery outbox is missing", "WORKFLOW_V2_REPAIR_RECOVERY_INVALID");
  }
  assertRecoveryContainsNoPrompt(record);
  const binding = record.binding;
  const dispatch = record.dispatch;
  const result = record.structuredGateResult?.result;
  const expectedKey = recoveryKey({
    storyId: record.storyId,
    contextId: dispatch?.contextId,
    contextRevision: dispatch?.contextRevision,
  });
  const expectedBindingSha256 = canonicalSha256(binding);
  const expectedOperationId = `workflow-v2-repair-commit:${expectedBindingSha256}`;
  if (record.schemaVersion !== WORKFLOW_V2_REPAIR_RECOVERY_SCHEMA_VERSION
    || !SHA256_PATTERN.test(String(record.recordSha256 || ""))
    || record.recordSha256 !== canonicalSha256(unsignedRecoveryRecord(record))
    || record.recoveryKey !== expectedKey
    || record.bindingSha256 !== expectedBindingSha256
    || record.operationId !== expectedOperationId
    || record.storyId !== binding?.storyId
    || dispatch?.promptMode !== "structured"
    || dispatch?.stageId !== "REPAIR"
    || dispatch?.context?.story?.storyId !== record.storyId
    || dispatch?.contextId !== binding?.contextId
    || dispatch?.contextRevision !== binding?.contextRevision
    || dispatch?.context?.idempotencyKey !== binding?.contextIdempotencyKey
    || canonicalSha256(result) !== binding?.resultSha256
    || record.structuredGateResult?.ok !== true
    || record.workflowEvent?.kind !== "fix_done") {
    fail(
      "REPAIR recovery outbox identity or hash binding is invalid",
      "WORKFLOW_V2_REPAIR_RECOVERY_INVALID",
    );
  }
  return snapshot(record);
}

function buildRecoveryRecord({ binding, bindingSha256, operationId, dispatch, structuredGateResult, recoveryContext, now }) {
  const workflowEvent = recoveryContext?.workflowEvent || structuredGateResult?.legacyEvent || null;
  const safeEvent = {
    kind: String(workflowEvent?.kind || ""),
    cleaned: String(workflowEvent?.cleaned || structuredGateResult?.displayText || "").slice(0, 20_000),
    shortReport: String(workflowEvent?.shortReport || "").slice(0, 4_000),
    detailReport: String(workflowEvent?.detailReport || "").slice(0, 40_000),
    lesson: workflowEvent?.lesson && typeof workflowEvent.lesson === "object"
      ? snapshot(workflowEvent.lesson)
      : null,
    deterministic: workflowEvent?.deterministic === true,
  };
  const safeContext = {
    report: String(recoveryContext?.report || structuredGateResult?.displayText || "").slice(0, 40_000),
    markerKind: String(recoveryContext?.markerKind || safeEvent.kind),
    taskId: String(recoveryContext?.taskId || dispatch?.taskId || ""),
    attemptId: String(recoveryContext?.attemptId || dispatch?.attemptId || ""),
    workflowKind: String(recoveryContext?.workflowKind || "fix"),
    stage: String(recoveryContext?.stage || "REPAIR"),
  };
  const unsigned = {
    schemaVersion: WORKFLOW_V2_REPAIR_RECOVERY_SCHEMA_VERSION,
    recoveryKey: recoveryKey({
      storyId: binding.storyId,
      contextId: binding.contextId,
      contextRevision: binding.contextRevision,
    }),
    storyId: binding.storyId,
    operationId,
    bindingSha256,
    binding: snapshot(binding),
    dispatch: safeRecoveryDispatch(dispatch),
    structuredGateResult: snapshot({
      ok: true,
      result: structuredGateResult.result,
      legacyEvent: { kind: "fix_done" },
      code: structuredGateResult.code || null,
      displayText: String(structuredGateResult.displayText || "").slice(0, 40_000),
    }),
    workflowEvent: safeEvent,
    recoveryContext: safeContext,
    // This identity must remain byte-stable across Gateway processes. Runtime
    // wall-clock time would make two identical retries look like different
    // payloads, so only reuse a timestamp already frozen in StageContext.
    createdAt: String(dispatch?.context?.createdAt || dispatch?.context?.generatedAt || "") || null,
  };
  const record = { ...unsigned, recordSha256: canonicalSha256(unsigned) };
  return validateRecoveryRecord(record);
}

function validateRecoveryStep(stepRecord, recovery, step) {
  if (!RECOVERY_STEPS.has(step)
    || stepRecord?.schemaVersion !== "workflow-v2-repair-recovery-step-v1"
    || stepRecord?.storyId !== recovery.storyId
    || stepRecord?.operationId !== recovery.operationId
    || stepRecord?.outboxSha256 !== recovery.recordSha256
    || stepRecord?.step !== step
    || stepRecord?.stepSha256 !== canonicalSha256((({ stepSha256: _ignored, ...value }) => value)(stepRecord))) {
    fail("REPAIR recovery step receipt is invalid", "WORKFLOW_V2_REPAIR_RECOVERY_STEP_INVALID", { step });
  }
  return snapshot(stepRecord);
}

function validatePlainFileTarget(storageApi, tab, target, options) {
  try {
    return storageApi.validateStoryStorageTarget(tab, target, options);
  } catch (error) {
    if (options?.createDirectory && error?.code === "EEXIST") {
      return storageApi.validateStoryStorageTarget(tab, target, {
        ...options,
        createDirectory: false,
        mustExist: true,
        expectedType: "directory",
      });
    }
    fail("REPAIR recovery storage boundary rejected", "WORKFLOW_V2_REPAIR_RECOVERY_STORE_FAILED", {
      causeCode: String(error?.code || ""),
    });
  }
}

function recoveryPaths(tab, storageApi) {
  const storage = storageApi.getStoryStoragePaths(tab, { create: true });
  let current = storage.storyDirectory;
  for (const part of RECOVERY_DIRECTORY_PARTS) {
    const next = path.join(current, part);
    validatePlainFileTarget(storageApi, tab, next, {
      baseDirectory: current,
      createDirectory: true,
      expectedType: "directory",
    });
    current = next;
  }
  const outboxDirectory = path.join(current, "outbox");
  const stepsDirectory = path.join(current, "steps");
  const locksDirectory = path.join(current, "locks");
  for (const directory of [outboxDirectory, stepsDirectory, locksDirectory]) {
    validatePlainFileTarget(storageApi, tab, directory, {
      baseDirectory: current,
      createDirectory: true,
      expectedType: "directory",
    });
  }
  return { root: current, outboxDirectory, stepsDirectory, locksDirectory };
}

async function readCanonicalFile(pathname, expectedType, validator) {
  const stat = await lstat(pathname);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    fail(`${expectedType} is not a plain file`, "WORKFLOW_V2_REPAIR_RECOVERY_STORE_FAILED");
  }
  const raw = await readFile(pathname, "utf8");
  let value;
  try { value = JSON.parse(raw); } catch {
    fail(`${expectedType} JSON is invalid`, "WORKFLOW_V2_REPAIR_RECOVERY_INVALID");
  }
  if (raw !== canonicalJson(value)) {
    fail(`${expectedType} is not canonical JSON`, "WORKFLOW_V2_REPAIR_RECOVERY_INVALID");
  }
  return validator(value);
}

async function writeCanonicalNoReplace({ tab, storageApi, directory, filename, value, validator }) {
  const target = path.join(directory, filename);
  const temporary = path.join(directory, `.${filename}.${process.pid}.${randomUUID()}.tmp`);
  validatePlainFileTarget(storageApi, tab, target, { baseDirectory: directory, mustExist: false });
  validatePlainFileTarget(storageApi, tab, temporary, { baseDirectory: directory, mustExist: false });
  let handle = null;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(canonicalJson(value), "utf8");
    await handle.sync();
    await handle.close();
    handle = null;
    try {
      await link(temporary, target);
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      const existing = await readCanonicalFile(target, "existing REPAIR recovery record", validator);
      if (canonicalSha256(existing) !== canonicalSha256(value)) {
        fail(
          "same REPAIR recovery key is already bound to a different payload",
          "WORKFLOW_V2_REPAIR_RECOVERY_IDEMPOTENCY_CONFLICT",
        );
      }
      return { value: existing, replayed: true };
    }
    validatePlainFileTarget(storageApi, tab, target, {
      baseDirectory: directory,
      mustExist: true,
      expectedType: "file",
    });
    const targetStat = await lstat(target);
    if (targetStat.isSymbolicLink() || !targetStat.isFile()) {
      fail("REPAIR recovery target is not a plain file", "WORKFLOW_V2_REPAIR_RECOVERY_STORE_FAILED");
    }
    return { value: validator(value), replayed: false };
  } finally {
    try { await handle?.close(); } catch {}
    try { await unlink(temporary); } catch (error) { if (error?.code !== "ENOENT") throw error; }
  }
}

export function createFileRepairRecoveryStore({
  storageApi = storyStore,
  lockTimeoutMs = 5_000,
  lockPollMs = 20,
  onStaleLockObserved = null,
  isLocalProcessAlive = (pid) => {
    try { process.kill(pid, 0); return true; } catch (error) { return error?.code !== "ESRCH"; }
  },
} = {}) {
  return Object.freeze({
    async withLock({ tab, lockKey }, operation) {
      if (!SHA256_PATTERN.test(String(lockKey || "")) || typeof operation !== "function") {
        fail("REPAIR recovery lock identity is invalid", "WORKFLOW_V2_REPAIR_RECOVERY_LOCK_FAILED");
      }
      const paths = recoveryPaths(tab, storageApi);
      const lockPath = path.join(paths.locksDirectory, `${lockKey}.lock`);
      // A deterministic, no-replace hard link serializes stale-lock reapers.
      // Acquirers also respect it, so once a reaper has linked the observed
      // inode no compliant process can replace the original before removal.
      const staleClaimPath = path.join(paths.locksDirectory, `${lockKey}.stale-claim`);
      const token = randomUUID();
      const owner = {
        schemaVersion: "workflow-v2-repair-recovery-lock-v1",
        host: hostname(),
        pid: process.pid,
        token,
        lockKey,
        acquiredAt: new Date().toISOString(),
      };
      const startedAt = Date.now();
      let handle = null;
      while (!handle) {
        validatePlainFileTarget(storageApi, tab, lockPath, {
          baseDirectory: paths.locksDirectory,
          mustExist: false,
        });
        validatePlainFileTarget(storageApi, tab, staleClaimPath, {
          baseDirectory: paths.locksDirectory,
          mustExist: false,
        });
        try {
          const claimStat = await lstat(staleClaimPath);
          if (claimStat.isSymbolicLink() || !claimStat.isFile()) {
            fail("REPAIR recovery stale-lock claim is invalid", "WORKFLOW_V2_REPAIR_RECOVERY_LOCK_FAILED");
          }
          if (Date.now() - startedAt >= lockTimeoutMs) {
            fail(
              "another Gateway is resolving a stale REPAIR recovery lock",
              "WORKFLOW_V2_REPAIR_RECOVERY_LOCKED",
            );
          }
          await new Promise((resolve) => setTimeout(resolve, lockPollMs));
          continue;
        } catch (error) {
          if (error instanceof WorkflowV2RepairCommitSettlementError) throw error;
          if (error?.code !== "ENOENT") throw error;
        }
        try {
          handle = await open(lockPath, "wx", 0o600);
          await handle.writeFile(canonicalJson(owner), "utf8");
          await handle.sync();
          await handle.close();
          handle = true;
        } catch (error) {
          try { if (handle && handle !== true) await handle.close(); } catch {}
          handle = null;
          if (error?.code !== "EEXIST") throw error;
          let existing = null;
          let observedRaw = "";
          try {
            observedRaw = await readFile(lockPath, "utf8");
            existing = JSON.parse(observedRaw);
          } catch (readError) {
            if (readError?.code === "ENOENT") continue;
          }
          let ownerAlive = true;
          if (existing?.host === hostname() && Number.isInteger(existing?.pid) && existing.pid > 0) {
            ownerAlive = isLocalProcessAlive(existing.pid) !== false;
          }
          if (!ownerAlive) {
            if (typeof onStaleLockObserved === "function") {
              await onStaleLockObserved({
                tab,
                lockKey,
                lockPath,
                staleClaimPath,
                observedOwner: existing,
                observedRaw,
              });
            }
            let claimed = false;
            try {
              await link(lockPath, staleClaimPath);
              claimed = true;
            } catch (claimError) {
              if (!["ENOENT", "EEXIST"].includes(claimError?.code)) throw claimError;
            }
            if (!claimed) {
              await new Promise((resolve) => setTimeout(resolve, lockPollMs));
              continue;
            }
            try {
              const claimRaw = await readFile(staleClaimPath, "utf8");
              // If the original changed between observation and claim, the
              // claim points at the replacement. Never unlink the live path.
              if (claimRaw !== observedRaw) continue;
              let currentRaw;
              try { currentRaw = await readFile(lockPath, "utf8"); }
              catch (readError) { if (readError?.code === "ENOENT") continue; throw readError; }
              if (currentRaw !== claimRaw) continue;
              try { await unlink(lockPath); }
              catch (unlinkError) { if (unlinkError?.code !== "ENOENT") throw unlinkError; }
            } finally {
              // Only this process could have won the deterministic no-replace
              // claim above. Losing reapers never clean another owner's claim.
              try { await unlink(staleClaimPath); }
              catch (cleanupError) { if (cleanupError?.code !== "ENOENT") throw cleanupError; }
            }
            continue;
          }
          if (Date.now() - startedAt >= lockTimeoutMs) {
            fail(
              "another Gateway still owns this REPAIR recovery operation",
              "WORKFLOW_V2_REPAIR_RECOVERY_LOCKED",
              { ownerHost: existing?.host || null, ownerPid: existing?.pid || null },
            );
          }
          await new Promise((resolve) => setTimeout(resolve, lockPollMs));
        }
      }
      try {
        return await operation();
      } finally {
        validatePlainFileTarget(storageApi, tab, lockPath, {
          baseDirectory: paths.locksDirectory,
          mustExist: true,
          expectedType: "file",
        });
        let saved;
        try { saved = JSON.parse(await readFile(lockPath, "utf8")); } catch {}
        if (saved?.token !== token || saved?.pid !== process.pid || saved?.lockKey !== lockKey) {
          fail("REPAIR recovery lock ownership changed", "WORKFLOW_V2_REPAIR_RECOVERY_LOCK_FAILED");
        }
        await unlink(lockPath);
      }
    },
    async prepare({ tab, record }) {
      const recovery = validateRecoveryRecord(record);
      const paths = recoveryPaths(tab, storageApi);
      return writeCanonicalNoReplace({
        tab,
        storageApi,
        directory: paths.outboxDirectory,
        filename: `${recovery.recoveryKey}.json`,
        value: recovery,
        validator: validateRecoveryRecord,
      });
    },
    async list({ tab }) {
      const paths = recoveryPaths(tab, storageApi);
      const entries = await readdir(paths.outboxDirectory, { withFileTypes: true });
      const records = [];
      for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
        if (!RECOVERY_FILE_PATTERN.test(entry.name) || !entry.isFile()) {
          fail("REPAIR recovery outbox contains an unexpected entry", "WORKFLOW_V2_REPAIR_RECOVERY_STORE_FAILED");
        }
        const pathname = path.join(paths.outboxDirectory, entry.name);
        validatePlainFileTarget(storageApi, tab, pathname, {
          baseDirectory: paths.outboxDirectory,
          mustExist: true,
          expectedType: "file",
        });
        const record = await readCanonicalFile(pathname, "REPAIR recovery outbox", validateRecoveryRecord);
        if (entry.name !== `${record.recoveryKey}.json`) {
          fail("REPAIR recovery filename does not match its identity", "WORKFLOW_V2_REPAIR_RECOVERY_INVALID");
        }
        records.push(record);
      }
      return records;
    },
    async readSteps({ tab, recovery }) {
      const record = validateRecoveryRecord(recovery);
      const paths = recoveryPaths(tab, storageApi);
      const directory = path.join(paths.stepsDirectory, canonicalSha256(record.operationId));
      try {
        validatePlainFileTarget(storageApi, tab, directory, {
          baseDirectory: paths.stepsDirectory,
          mustExist: true,
          expectedType: "directory",
        });
      } catch (error) {
        if (error?.details?.causeCode === "STORY_STORAGE_PATH_MISSING") return {};
        throw error;
      }
      const entries = await readdir(directory, { withFileTypes: true });
      const result = {};
      for (const entry of entries) {
        const step = entry.name.replace(/\.json$/u, "");
        if (!RECOVERY_STEPS.has(step) || entry.name !== `${step}.json` || !entry.isFile()) {
          fail("REPAIR recovery step directory contains an unexpected entry", "WORKFLOW_V2_REPAIR_RECOVERY_STORE_FAILED");
        }
        const value = await readCanonicalFile(
          path.join(directory, entry.name),
          "REPAIR recovery step",
          (candidate) => validateRecoveryStep(candidate, record, step),
        );
        result[step] = value;
      }
      return result;
    },
    async markStep({ tab, recovery, step, value = null, now = () => new Date().toISOString() }) {
      const record = validateRecoveryRecord(recovery);
      if (!RECOVERY_STEPS.has(step)) {
        fail("unsupported REPAIR recovery step", "WORKFLOW_V2_REPAIR_RECOVERY_STEP_INVALID", { step });
      }
      const paths = recoveryPaths(tab, storageApi);
      const directory = path.join(paths.stepsDirectory, canonicalSha256(record.operationId));
      validatePlainFileTarget(storageApi, tab, directory, {
        baseDirectory: paths.stepsDirectory,
        createDirectory: true,
        expectedType: "directory",
      });
      const unsigned = {
        schemaVersion: "workflow-v2-repair-recovery-step-v1",
        storyId: record.storyId,
        operationId: record.operationId,
        outboxSha256: record.recordSha256,
        step,
        value: value == null ? null : snapshot(value),
        completedAt: String(now()),
      };
      const stepRecord = { ...unsigned, stepSha256: canonicalSha256(unsigned) };
      return writeCanonicalNoReplace({
        tab,
        storageApi,
        directory,
        filename: `${step}.json`,
        value: stepRecord,
        validator: (candidate) => validateRecoveryStep(candidate, record, step),
      });
    },
  });
}

export const fileRepairRecoveryStore = createFileRepairRecoveryStore();

function exactSortedValues(values, label) {
  if (!Array.isArray(values)) {
    fail(`${label} must be an array`, "WORKFLOW_V2_GIT_SETTLEMENT_CONTROLLER_RESULT_INVALID", { label });
  }
  return [...values].map((value) => String(value || "").trim()).sort();
}

function sameStringArray(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function normalizeDeclaredPath(value) {
  const normalized = String(value || "").trim().replace(/\\/g, "/");
  const segments = normalized.split("/");
  if (!normalized
    || normalized.length > 500
    || path.posix.isAbsolute(normalized)
    || /^[A-Za-z]:\//.test(normalized)
    || segments.some((segment) => !segment || segment === "." || segment === "..")
    || segments[0].toLowerCase() === ".git"
    || /[\u0000\r\n]/u.test(normalized)) {
    fail(
      "REPAIR declared change path is not a canonical repository-relative path",
      "WORKFLOW_V2_GIT_SETTLEMENT_CHANGE_PATH_INVALID",
      { path: normalized.slice(0, 300) },
    );
  }
  return normalized;
}

function normalizeIdentifier(value, field, maxLength = 300) {
  const normalized = String(value || "").trim();
  if (!normalized || normalized !== value || normalized.length > maxLength || /[\u0000-\u001f\u007f]/u.test(normalized)) {
    fail(
      `frozen REPAIR root ${field} is missing or invalid`,
      "WORKFLOW_V2_GIT_SETTLEMENT_ROOT_METADATA_MISSING",
      { field },
    );
  }
  return normalized;
}

function assertRepairIdentity(tab, dispatch, structuredGateResult) {
  const result = structuredGateResult?.result;
  const storyId = String(tab?.id || "").trim();
  const stageId = String(dispatch?.context?.stage?.id || dispatch?.stageId || "");
  if (!storyId
    || structuredGateResult?.ok !== true
    || !result
    || typeof result !== "object"
    || Array.isArray(result)
    || stageId !== "REPAIR"
    || dispatch?.stageId !== "REPAIR"
    || dispatch?.contextId !== dispatch?.context?.contextId
    || dispatch?.contextRevision !== dispatch?.context?.revision
    || dispatch?.context?.story?.storyId !== storyId
    || result.contextId !== dispatch.contextId
    || result.contextRevision !== dispatch.contextRevision
    || result.idempotencyKey !== dispatch.context.idempotencyKey) {
    fail(
      "structured REPAIR result is not bound to the current frozen story context",
      "WORKFLOW_V2_GIT_SETTLEMENT_IDENTITY_MISMATCH",
    );
  }
  if (result.status !== "COMPLETED"
    || result.outcome !== "FIXED"
    || result.nextStage !== "LOCAL_GATE"
    || !Array.isArray(result.changes)
    || result.changes.length === 0) {
    fail(
      "only a completed FIXED REPAIR result with declared changes can be committed",
      "WORKFLOW_V2_GIT_SETTLEMENT_RESULT_NOT_COMMITTABLE",
    );
  }
  return { result, storyId };
}

function resolveSingleChangedRoot(dispatch, result) {
  const roots = Array.isArray(dispatch?.context?.scope?.roots)
    ? dispatch.context.scope.roots
    : [];
  const rootIndex = new Map();
  for (const root of roots) {
    const rootId = String(root?.rootId || "").trim();
    if (!rootId || rootIndex.has(rootId)) {
      fail(
        "frozen REPAIR root identities are missing or duplicated",
        "WORKFLOW_V2_GIT_SETTLEMENT_ROOT_METADATA_INVALID",
        { rootId },
      );
    }
    rootIndex.set(rootId, root);
  }

  const changedRootIds = [...new Set(result.changes.map((change) => String(change?.rootId || "").trim()))];
  if (changedRootIds.length !== 1 || !changedRootIds[0]) {
    fail(
      "authoritative REPAIR commit currently requires exactly one changed repository",
      "WORKFLOW_V2_GIT_MULTI_ROOT_ATOMIC_COMMIT_UNSUPPORTED",
      { rootIds: changedRootIds.filter(Boolean).sort() },
    );
  }
  const rootId = changedRootIds[0];
  const root = rootIndex.get(rootId);
  if (!root || root.writable !== true || root.kind === "ARTIFACT") {
    fail(
      "declared REPAIR changes do not resolve to one writable frozen repository root",
      "WORKFLOW_V2_GIT_SETTLEMENT_ROOT_NOT_WRITABLE",
      { rootId },
    );
  }
  const repositoryId = normalizeIdentifier(root.repositoryId, "repositoryId", 200);
  const expectedBranch = normalizeIdentifier(root.branch, "branch", 300);
  const targetFlavor = normalizeIdentifier(root.flavor, "flavor", 100);
  const expectedHead = String(root.headSha || "").trim().toLowerCase();
  if (!SHA_PATTERN.test(expectedHead)) {
    fail(
      "frozen REPAIR root headSha is missing or invalid",
      "WORKFLOW_V2_GIT_SETTLEMENT_ROOT_METADATA_MISSING",
      { field: "headSha", rootId },
    );
  }
  const declaredChanges = result.changes
    .map((change) => {
      if (String(change?.rootId || "").trim() !== rootId || !String(change?.summary || "").trim()) {
        fail(
          "REPAIR change declaration is incomplete",
          "WORKFLOW_V2_GIT_SETTLEMENT_CHANGE_DECLARATION_INVALID",
          { rootId },
        );
      }
      return normalizeDeclaredPath(change.path);
    })
    .sort();
  if (new Set(declaredChanges).size !== declaredChanges.length) {
    fail(
      "REPAIR declared change paths must be unique",
      "WORKFLOW_V2_GIT_SETTLEMENT_CHANGE_DECLARATION_INVALID",
      { rootId },
    );
  }
  const changeSummary = String(result.changeSummary || "").trim().replace(/\s+/gu, " ");
  if (!changeSummary
    || changeSummary.length > 120
    || !/[\u3400-\u9fff]/u.test(changeSummary)
    || /[\u0000-\u001f\u007f]/u.test(changeSummary)) {
    fail(
      "REPAIR changeSummary must be a bounded Chinese description",
      "WORKFLOW_V2_GIT_SETTLEMENT_CHANGE_SUMMARY_INVALID",
    );
  }
  return {
    rootId,
    repositoryId,
    expectedBranch,
    expectedHead,
    targetFlavor,
    declaredChanges,
    changeSummary,
  };
}

function worktreeEntryRepositoryIds(entry) {
  return new Set([
    entry?.repositoryId,
    entry?.baseProjectId,
    entry?.projectId,
  ].map((value) => String(value || "").trim()).filter(Boolean));
}

function resolveWorktreeEntry(tab, root) {
  const entries = Array.isArray(tab?.worktree?.entries) ? tab.worktree.entries : [];
  const matches = entries
    .map((entry, index) => ({ entry, index }))
    .filter(({ entry }) => (
      worktreeEntryRepositoryIds(entry).has(root.repositoryId)
      && String(entry?.branch || "").trim() === root.expectedBranch
    ));
  if (matches.length !== 1) {
    fail(
      "frozen REPAIR repository does not resolve to one current story worktree entry",
      "WORKFLOW_V2_GIT_SETTLEMENT_WORKTREE_BINDING_INVALID",
      { repositoryId: root.repositoryId, matches: matches.length },
    );
  }
  return matches[0];
}

function currentEntryHead(entry) {
  return String(entry?.revision || entry?.head || entry?.baseRevision || "").trim().toLowerCase();
}

function unsignedEnvelope(envelope) {
  const { envelopeSha256: _ignored, ...unsigned } = envelope;
  return unsigned;
}

function validateReceiptEnvelopes(envelopes, storyId) {
  if (!Array.isArray(envelopes)) {
    fail("evidence receipt reader did not return an array", "WORKFLOW_V2_GIT_SETTLEMENT_RECEIPT_READ_FAILED");
  }
  const receipts = [];
  const seenReceiptIds = new Set();
  let previousEnvelopeSha256 = null;
  for (let index = 0; index < envelopes.length; index += 1) {
    const envelope = envelopes[index];
    const envelopeValidation = workflowV2SchemaRegistry.validate(WORKFLOW_V2_SCHEMA_IDS.workflowEnvelope, envelope);
    const receiptValidation = workflowV2SchemaRegistry.validate(WORKFLOW_V2_SCHEMA_IDS.evidenceReceipt, envelope?.payload);
    const receiptId = String(envelope?.payload?.receiptId || "");
    if (!envelopeValidation.valid
      || !receiptValidation.valid
      || envelope.payloadSchemaId !== WORKFLOW_V2_SCHEMA_IDS.evidenceReceipt
      || envelope.storyId !== storyId
      || envelope.recordId !== receiptId
      || envelope.contextId !== null
      || envelope.revision !== index + 1
      || envelope.payloadSha256 !== canonicalSha256(envelope.payload)
      || envelope.envelopeSha256 !== canonicalSha256(unsignedEnvelope(envelope))
      || envelope.previousEnvelopeSha256 !== previousEnvelopeSha256
      || (envelope.payload.idempotencyKey !== null
        && envelope.idempotencyKey !== envelope.payload.idempotencyKey)
      || seenReceiptIds.has(receiptId)) {
      fail(
        "evidence receipt envelope schema, hash chain, identity, or idempotency binding is invalid",
        "WORKFLOW_V2_GIT_SETTLEMENT_RECEIPT_ENVELOPE_INVALID",
        { revision: envelope?.revision ?? null, receiptId },
      );
    }
    seenReceiptIds.add(receiptId);
    previousEnvelopeSha256 = envelope.envelopeSha256;
    receipts.push(envelope.payload);
  }
  return receipts;
}

function frozenMandatoryChecks(dispatch, targetRootId) {
  const checks = Array.isArray(dispatch?.context?.data?.localChecks)
    ? dispatch.context.data.localChecks
    : [];
  const targetChecks = checks.filter((entry) => (
    entry?.mandatory === true
    && CHECK_ACTIONS.has(String(entry?.action || "").toUpperCase())
    && String(entry?.rootId || entry?.target?.rootId || "").trim() === targetRootId
  ));
  if (targetChecks.length === 0) {
    fail(
      "changed repository has no frozen mandatory BUILD/TEST check",
      "WORKFLOW_V2_GIT_SETTLEMENT_MANDATORY_CHECK_MISSING",
      { rootId: targetRootId },
    );
  }
  const checkIds = targetChecks.map((entry) => String(entry?.checkId || "").trim());
  if (checkIds.some((checkId) => !checkId) || new Set(checkIds).size !== checkIds.length) {
    fail(
      "frozen mandatory BUILD/TEST checks contain missing or duplicate checkId",
      "WORKFLOW_V2_GIT_SETTLEMENT_CHECK_PROFILE_INVALID",
      { rootId: targetRootId },
    );
  }
  const executionProfile = dispatch?.executionProfile;
  const executors = new Map();
  if (dispatch?.executionStatus?.status !== "READY"
    || !executionProfile
    || dispatch.executionStatus.profileId !== executionProfile.profileId
    || executionProfile.stageId !== "REPAIR"
    || !Array.isArray(executionProfile.executors)) {
    fail(
      "frozen mandatory checks are not bound to a READY Gateway execution profile",
      "WORKFLOW_V2_GIT_SETTLEMENT_CHECK_PROFILE_INVALID",
    );
  }
  for (const executor of executionProfile.executors) {
    const executorId = String(executor?.executorId || "").trim();
    if (!executorId || executors.has(executorId)) {
      fail(
        "Gateway execution profile contains missing or duplicate executorId",
        "WORKFLOW_V2_GIT_SETTLEMENT_CHECK_PROFILE_INVALID",
      );
    }
    executors.set(executorId, executor);
  }
  for (const check of targetChecks) {
    const executorId = String(check?.executorId || "").trim();
    const action = String(check?.action || "").toUpperCase();
    const executor = executors.get(executorId);
    if (!executor
      || String(executor.action || "").toUpperCase() !== action
      || String(executor.cwdRootId || "").trim() !== targetRootId) {
      fail(
        "frozen mandatory check does not match its Gateway-owned executor",
        "WORKFLOW_V2_GIT_SETTLEMENT_CHECK_PROFILE_INVALID",
        { checkId: String(check?.checkId || "") },
      );
    }
  }
  return targetChecks;
}

async function selectRequiredCheckReceipts({
  tab,
  dispatch,
  rootId,
  readEnvelopes,
  storageApi,
  verifyReceiptOutput,
  absoluteRoot,
  declaredChanges,
  verifyEditStateFiles,
}) {
  const checks = frozenMandatoryChecks(dispatch, rootId);
  let envelopes;
  try {
    envelopes = await readEnvelopes({
      tab,
      payloadSchemaId: WORKFLOW_V2_SCHEMA_IDS.evidenceReceipt,
    });
  } catch (error) {
    fail(
      "unable to read authoritative evidence receipt stream",
      "WORKFLOW_V2_GIT_SETTLEMENT_RECEIPT_READ_FAILED",
      { causeCode: String(error?.code || "") },
    );
  }
  const receipts = validateReceiptEnvelopes(envelopes, String(tab.id));
  let editState;
  try {
    editState = deriveWorkflowV2EditState({
      envelopes,
      storyId: String(tab.id),
      contextId: dispatch.contextId,
      contextRevision: dispatch.contextRevision,
      rootId,
      requireChanges: true,
    });
    verifyEditStateFiles({
      absoluteRoot,
      state: editState,
      expectedPaths: declaredChanges,
    });
  } catch (error) {
    fail(
      "latest EDIT receipts do not match the authoritative final repository bytes",
      "WORKFLOW_V2_GIT_SETTLEMENT_EDIT_STATE_INVALID",
      { causeCode: String(error?.code || ""), causeMessage: String(error?.message || error) },
    );
  }
  const selected = [];
  for (const check of checks) {
    const checkId = String(check.checkId);
    const action = String(check.action).toUpperCase();
    const executorId = String(check.executorId);
    const matches = receipts.filter((receipt) => (
      receipt.status === "PASS"
      && receipt.action === action
      && receipt.rootId === rootId
      && receipt.selector?.contextId === dispatch.contextId
      && receipt.selector?.contextRevision === dispatch.contextRevision
      && receipt.selector?.checkId === checkId
      && receipt.selector?.executorId === executorId
      && receiptBindsWorkflowV2EditState(receipt, editState)
    ));
    if (matches.length !== 1) {
      fail(
        "frozen mandatory BUILD/TEST check does not resolve to one exact PASS receipt",
        "WORKFLOW_V2_GIT_SETTLEMENT_MANDATORY_CHECK_RECEIPT_MISSING",
        { checkId, matches: matches.length },
      );
    }
    let outputEvidence;
    try {
      outputEvidence = await verifyReceiptOutput({ tab, receipt: matches[0], storageApi });
    } catch (error) {
      outputEvidence = { valid: false, reason: error?.message || String(error) };
    }
    if (outputEvidence?.valid !== true) {
      fail(
        "mandatory BUILD/TEST receipt output cannot be re-read and verified",
        "WORKFLOW_V2_GIT_SETTLEMENT_RECEIPT_OUTPUT_INVALID",
        { checkId, receiptId: matches[0].receiptId, reason: outputEvidence?.reason || "unknown" },
      );
    }
    selected.push(matches[0].receiptId);
  }
  const sorted = selected.sort();
  if (new Set(sorted).size !== sorted.length) {
    fail(
      "one receipt cannot authorize multiple mandatory checks",
      "WORKFLOW_V2_GIT_SETTLEMENT_RECEIPT_REUSE",
    );
  }
  return Object.freeze({ receiptIds: Object.freeze(sorted), editState });
}

function settlementBinding({ storyId, dispatch, resultSha256, root, requiredCheckReceiptIds, editState }) {
  return {
    schemaVersion: WORKFLOW_V2_GIT_SETTLEMENT_SCHEMA_VERSION,
    storyId,
    stageId: "REPAIR",
    contextId: dispatch.contextId,
    contextRevision: dispatch.contextRevision,
    contextIdempotencyKey: dispatch.context.idempotencyKey,
    resultSha256,
    rootId: root.rootId,
    repositoryId: root.repositoryId,
    expectedHead: root.expectedHead,
    expectedBranch: root.expectedBranch,
    targetFlavor: root.targetFlavor,
    changeSummary: root.changeSummary,
    declaredChanges: [...root.declaredChanges],
    requiredCheckReceiptIds: [...requiredCheckReceiptIds],
    editStateSha256: editState.editStateSha256,
    editStateVersionSha256: editState.editStateVersionSha256,
    editReceiptIds: editState.files.map((entry) => entry.receiptId),
  };
}

function validateExistingSettlement(existing, binding, bindingSha256, worktreeEntry) {
  if (!existing) return null;
  if (existing.schemaVersion !== WORKFLOW_V2_GIT_SETTLEMENT_SCHEMA_VERSION
    || existing.status !== "COMMITTED"
    || existing.bindingSha256 !== bindingSha256
    || canonicalSha256({
      schemaVersion: existing.schemaVersion,
      storyId: existing.storyId,
      stageId: existing.stageId,
      contextId: existing.contextId,
      contextRevision: existing.contextRevision,
      contextIdempotencyKey: existing.contextIdempotencyKey,
      resultSha256: existing.resultSha256,
      rootId: existing.rootId,
      repositoryId: existing.repositoryId,
      expectedHead: existing.expectedHead,
      expectedBranch: existing.expectedBranch,
      targetFlavor: existing.targetFlavor,
      changeSummary: existing.changeSummary,
      declaredChanges: existing.declaredChanges,
      requiredCheckReceiptIds: existing.requiredCheckReceiptIds,
      editStateSha256: existing.editStateSha256,
      editStateVersionSha256: existing.editStateVersionSha256,
      editReceiptIds: existing.editReceiptIds,
    }) !== canonicalSha256(binding)
    || !SHA_PATTERN.test(String(existing.commitSha || ""))
    || currentEntryHead(worktreeEntry) !== existing.commitSha
    || String(worktreeEntry?.head || "").trim().toLowerCase() !== existing.commitSha) {
    fail(
      "existing REPAIR Git settlement conflicts with the current structured binding",
      "WORKFLOW_V2_GIT_SETTLEMENT_IDEMPOTENCY_CONFLICT",
    );
  }
  return existing;
}

function assertControllerResult(result, request) {
  const changedPaths = exactSortedValues(result?.changedPaths, "changedPaths");
  const receiptIds = exactSortedValues(result?.requiredCheckReceiptIds, "requiredCheckReceiptIds");
  const dirtyAfterCommit = exactSortedValues(result?.dirtyAfterCommit, "dirtyAfterCommit");
  const commitSha = String(result?.commitSha || "").trim().toLowerCase();
  if (result?.ok !== true
    || result?.resultCode !== "PASS"
    || result?.tabId !== request.tabId
    || result?.repositoryId !== request.repositoryId
    || result?.operationId !== request.operationId
    || String(result?.beforeSha || "").trim().toLowerCase() !== request.expectedHead
    || result?.branch !== request.expectedBranch
    || result?.targetFlavor !== request.targetFlavor
    || !SHA_PATTERN.test(commitSha)
    || !sameStringArray(changedPaths, request.declaredChanges)
    || !sameStringArray(receiptIds, request.requiredCheckReceiptIds)
    || dirtyAfterCommit.length !== 0) {
    fail(
      "Git Controller returned a result that does not exactly attest the requested commit",
      "WORKFLOW_V2_GIT_SETTLEMENT_CONTROLLER_RESULT_INVALID",
    );
  }
  return { commitSha, changedPaths, receiptIds };
}

async function resolveRuntime(runtime, getRuntime) {
  try {
    const resolved = typeof runtime === "function"
      ? await runtime()
      : (runtime || await getRuntime());
    if (typeof resolved?.storyRepositories?.commit !== "function") {
      fail(
        "authoritative Git Controller commit facade is unavailable",
        "WORKFLOW_V2_GIT_SETTLEMENT_CONTROLLER_UNAVAILABLE",
      );
    }
    return resolved;
  } catch (error) {
    if (error instanceof WorkflowV2RepairCommitSettlementError) throw error;
    fail(
      "authoritative Git Controller runtime is unavailable",
      "WORKFLOW_V2_GIT_SETTLEMENT_CONTROLLER_UNAVAILABLE",
      { causeCode: String(error?.code || "") },
    );
  }
}

/**
 * Settles one accepted structured REPAIR result through the independent Git
 * Controller. Provider receipt IDs and commit messages are deliberately not
 * accepted as authority: check receipts come from the frozen Gateway profile
 * and persisted receipt stream, while the Controller owns the final message.
 */
export async function settleStructuredRepairCommit({
  tab,
  dispatch,
  structuredGateResult,
  recoveryRecord = null,
  recoveryContext = null,
  recoveryStore = fileRepairRecoveryStore,
  readEnvelopes = readWorkflowV2Envelopes,
  storageApi = storyStore,
  verifyReceiptOutput = verifyControlledReceiptOutput,
  verifyEditStateFiles = verifyWorkflowV2EditStateFiles,
  runtime = null,
  getRuntime = getGitControllerRuntime,
  updateTab = storyStore.updateTab,
  getTab = storyStore.getTab,
  now = () => new Date().toISOString(),
} = {}) {
  if (recoveryRecord) {
    const recovered = validateRecoveryRecord(recoveryRecord);
    if (tab?.id !== recovered.storyId) {
      fail("REPAIR recovery story identity changed", "WORKFLOW_V2_REPAIR_RECOVERY_INVALID");
    }
    dispatch = recovered.dispatch;
    structuredGateResult = recovered.structuredGateResult;
    recoveryContext = recovered.recoveryContext;
  }
  const { result, storyId } = assertRepairIdentity(tab, dispatch, structuredGateResult);
  const root = resolveSingleChangedRoot(dispatch, result);
  const worktreeMatch = resolveWorktreeEntry(tab, root);
  const resultSha256 = canonicalSha256(result);
  const selectedChecks = await selectRequiredCheckReceipts({
    tab,
    dispatch,
    rootId: root.rootId,
    readEnvelopes,
    storageApi,
    verifyReceiptOutput,
    absoluteRoot: worktreeMatch.entry.path || worktreeMatch.entry.worktreePath,
    declaredChanges: root.declaredChanges,
    verifyEditStateFiles,
  });
  const requiredCheckReceiptIds = selectedChecks.receiptIds;
  const binding = settlementBinding({
    storyId,
    dispatch,
    resultSha256,
    root,
    requiredCheckReceiptIds,
    editState: selectedChecks.editState,
  });
  const bindingSha256 = canonicalSha256(binding);
  const operationId = `workflow-v2-repair-commit:${bindingSha256}`;
  const recovery = recoveryRecord
    ? validateRecoveryRecord(recoveryRecord)
    : buildRecoveryRecord({
      binding,
      bindingSha256,
      operationId,
      dispatch,
      structuredGateResult,
      recoveryContext,
      now,
    });
  if (recovery.bindingSha256 !== bindingSha256
    || recovery.operationId !== operationId
    || canonicalSha256(recovery.binding) !== canonicalSha256(binding)) {
    fail(
      "REPAIR recovery outbox conflicts with live receipt and Git binding",
      "WORKFLOW_V2_REPAIR_RECOVERY_IDEMPOTENCY_CONFLICT",
    );
  }
  let prepared;
  try {
    prepared = await recoveryStore.prepare({ tab, record: recovery });
  } catch (error) {
    if (error instanceof WorkflowV2RepairCommitSettlementError) throw error;
    fail("unable to persist immutable REPAIR recovery outbox", "WORKFLOW_V2_REPAIR_RECOVERY_STORE_FAILED", {
      causeCode: String(error?.code || ""),
    });
  }

  const pendingPointer = Object.freeze({
    schemaVersion: WORKFLOW_V2_REPAIR_RECOVERY_SCHEMA_VERSION,
    status: "pending",
    recoveryKey: recovery.recoveryKey,
    operationId,
    bindingSha256,
    outboxSha256: recovery.recordSha256,
    contextId: binding.contextId,
    contextRevision: binding.contextRevision,
    updatedAt: recovery.createdAt,
  });
  let workingTab = getTab?.(storyId) || tab;
  const livePointer = workingTab?.workflowV2Compatibility?.repairRecovery;
  if (livePointer?.operationId && livePointer.operationId !== operationId) {
    fail(
      "story already has a different pending REPAIR recovery operation",
      "WORKFLOW_V2_REPAIR_RECOVERY_IDEMPOTENCY_CONFLICT",
    );
  }
  if (canonicalSha256(livePointer || null) !== canonicalSha256(pendingPointer)) {
    try {
      const pointerUpdated = await updateTab(storyId, {
        workflowV2Compatibility: {
          ...(workingTab.workflowV2Compatibility || {}),
          repairRecovery: pendingPointer,
        },
      });
      workingTab = pointerUpdated || getTab?.(storyId) || workingTab;
    } catch (error) {
      fail(
        "immutable REPAIR outbox was stored but its recovery pointer could not be persisted",
        "WORKFLOW_V2_REPAIR_RECOVERY_POINTER_PERSIST_FAILED",
        { causeCode: String(error?.code || "") },
      );
    }
  }
  const currentWorktreeMatch = resolveWorktreeEntry(workingTab, root);
  const existing = validateExistingSettlement(
    workingTab?.workflowV2Compatibility?.gitSettlement,
    binding,
    bindingSha256,
    currentWorktreeMatch.entry,
  );
  if (existing) {
    return Object.freeze({
      ok: true,
      status: "COMMITTED",
      replayed: true,
      operationId,
      commitSha: existing.commitSha,
      settlement: existing,
      recovery,
      tab: workingTab,
    });
  }
  if (currentEntryHead(currentWorktreeMatch.entry) !== root.expectedHead && prepared?.replayed !== true) {
    fail(
      "current story worktree HEAD metadata differs from the frozen REPAIR root",
      "WORKFLOW_V2_GIT_SETTLEMENT_WORKTREE_HEAD_MISMATCH",
      { repositoryId: root.repositoryId },
    );
  }

  const controllerRuntime = await resolveRuntime(runtime, getRuntime);
  const request = Object.freeze({
    tabId: storyId,
    repositoryId: root.repositoryId,
    operationId,
    expectedHead: root.expectedHead,
    expectedBranch: root.expectedBranch,
    targetFlavor: root.targetFlavor,
    changeSummary: root.changeSummary,
    declaredChanges: Object.freeze([...root.declaredChanges]),
    requiredCheckReceiptIds: Object.freeze([...requiredCheckReceiptIds]),
  });
  let controllerResult;
  try {
    controllerResult = await controllerRuntime.storyRepositories.commit(request);
  } catch (error) {
    fail(
      "authoritative Git Controller rejected the REPAIR commit",
      "WORKFLOW_V2_GIT_SETTLEMENT_CONTROLLER_FAILED",
      { causeCode: String(error?.code || ""), causeMessage: String(error?.message || error) },
    );
  }
  const attested = assertControllerResult(controllerResult, request);
  const settlement = Object.freeze({
    ...binding,
    bindingSha256,
    operationId,
    status: "COMMITTED",
    controllerOperationId: String(controllerResult.controllerOperationId || ""),
    commitSha: attested.commitSha,
    beforeSha: root.expectedHead,
    changedPaths: Object.freeze([...attested.changedPaths]),
    requiredCheckReceiptIds: Object.freeze([...attested.receiptIds]),
    controllerReplayed: controllerResult.replayed === true,
    controllerRecovered: controllerResult.recovered === true,
    flavorWarnings: Object.freeze(Array.isArray(controllerResult.flavorWarnings)
      ? controllerResult.flavorWarnings.map((value) => String(value))
      : []),
    settledAt: String(now()),
  });
  const nextEntries = workingTab.worktree.entries.map((entry, index) => (
    index === currentWorktreeMatch.index
      ? { ...entry, head: attested.commitSha, revision: attested.commitSha }
      : entry
  ));
  const updates = {
    worktree: { ...workingTab.worktree, entries: nextEntries },
    workflowV2Compatibility: {
      ...(workingTab.workflowV2Compatibility || {}),
      repairRecovery: pendingPointer,
      gitSettlement: settlement,
    },
  };
  let updated;
  try {
    updated = await updateTab(storyId, updates);
  } catch (error) {
    fail(
      "authoritative commit succeeded but Git settlement persistence failed",
      "WORKFLOW_V2_GIT_SETTLEMENT_PERSIST_FAILED",
      { causeCode: String(error?.code || "") },
    );
  }
  const savedSettlement = updated?.workflowV2Compatibility?.gitSettlement;
  const savedEntries = Array.isArray(updated?.worktree?.entries) ? updated.worktree.entries : [];
  const savedEntry = savedEntries[currentWorktreeMatch.index];
  if (!savedSettlement
    || canonicalSha256(savedSettlement) !== canonicalSha256(settlement)
    || currentEntryHead(savedEntry) !== attested.commitSha
    || String(savedEntry?.head || "").trim().toLowerCase() !== attested.commitSha) {
    fail(
      "authoritative commit succeeded but persisted Git settlement cannot be read back",
      "WORKFLOW_V2_GIT_SETTLEMENT_PERSIST_FAILED",
    );
  }
  return Object.freeze({
    ok: true,
    status: "COMMITTED",
    replayed: controllerResult.replayed === true,
    operationId,
    commitSha: attested.commitSha,
    settlement,
    recovery,
    tab: updated,
  });
}

async function markRecoveryStep({ recoveryStore, tab, recovery, step, value, now, afterStep }) {
  const marked = await recoveryStore.markStep({ tab, recovery, step, value, now });
  if (typeof afterStep === "function") await afterStep(step, marked);
  return marked;
}

function settledRecoveryProjection(recovery, recoveryContext, completedAt) {
  return {
    status: "settled",
    taskId: recoveryContext.taskId || null,
    attemptId: recoveryContext.attemptId || null,
    stageId: "REPAIR",
    operationId: recovery.operationId,
    code: null,
    error: null,
    at: Date.parse(String(completedAt)) || Date.now(),
  };
}

/**
 * Completes every local boundary after a structured REPAIR result without
 * invoking a Provider. Every boundary is guarded by an immutable step receipt,
 * so a restart resumes at the first unfinished boundary. The Git Controller is
 * always addressed with the outbox operationId and therefore can only replay
 * the already-authorized commit.
 */
async function completeStructuredRepairRecoveryUnlocked({
  tab,
  dispatch = null,
  structuredGateResult = null,
  recoveryContext = null,
  recoveryRecord = null,
  recoveryStore = fileRepairRecoveryStore,
  commitSettler = settleStructuredRepairCommit,
  recordStructuredResult,
  recordCompatibilityResult,
  applyWorkflow,
  updateTab = storyStore.updateTab,
  getTab = storyStore.getTab,
  afterStep = null,
  now = () => new Date().toISOString(),
  commitDependencies = {},
} = {}) {
  if (!tab?.id
    || typeof recordStructuredResult !== "function"
    || typeof recordCompatibilityResult !== "function"
    || typeof applyWorkflow !== "function") {
    fail(
      "REPAIR recovery runner is missing its story or local settlement boundaries",
      "WORKFLOW_V2_REPAIR_RECOVERY_DEPENDENCY_MISSING",
    );
  }
  const recovered = recoveryRecord ? validateRecoveryRecord(recoveryRecord) : null;
  const settled = await commitSettler({
    tab: getTab?.(tab.id) || tab,
    dispatch: recovered?.dispatch || dispatch,
    structuredGateResult: recovered?.structuredGateResult || structuredGateResult,
    recoveryRecord: recovered,
    recoveryContext: recovered?.recoveryContext || recoveryContext,
    recoveryStore,
    updateTab,
    getTab,
    now,
    ...commitDependencies,
  });
  if (settled?.ok !== true || settled.status !== "COMMITTED" || !settled.recovery) {
    fail("authoritative REPAIR commit recovery is incomplete", "WORKFLOW_V2_GIT_SETTLEMENT_INCOMPLETE");
  }
  const recovery = validateRecoveryRecord(settled.recovery);
  let currentTab = getTab?.(tab.id) || settled.tab || tab;
  let steps = await recoveryStore.readSteps({ tab: currentTab, recovery });

  if (!steps.gitCommitted) {
    await markRecoveryStep({
      recoveryStore,
      tab: currentTab,
      recovery,
      step: "gitCommitted",
      value: {
        operationId: settled.operationId,
        commitSha: settled.commitSha,
        bindingSha256: recovery.bindingSha256,
      },
      now,
      afterStep,
    });
    steps = await recoveryStore.readSteps({ tab: currentTab, recovery });
  }

  if (!steps.stageResultRecorded) {
    const recorded = await recordStructuredResult({
      tab: getTab?.(tab.id) || currentTab,
      dispatch: recovery.dispatch,
      result: recovery.structuredGateResult.result,
    });
    await markRecoveryStep({
      recoveryStore,
      tab: getTab?.(tab.id) || currentTab,
      recovery,
      step: "stageResultRecorded",
      value: {
        replayed: recorded?.replayed === true,
        resultSha256: recovery.binding.resultSha256,
      },
      now,
      afterStep,
    });
    steps = await recoveryStore.readSteps({ tab: getTab?.(tab.id) || currentTab, recovery });
  }

  if (!steps.compatibilityRecorded) {
    const recorded = await recordCompatibilityResult({
      tab: getTab?.(tab.id) || currentTab,
      dispatch: recovery.dispatch,
      report: recovery.recoveryContext.report,
      markerKind: recovery.recoveryContext.markerKind,
    });
    await markRecoveryStep({
      recoveryStore,
      tab: getTab?.(tab.id) || currentTab,
      recovery,
      step: "compatibilityRecorded",
      value: {
        replayed: recorded?.replayed === true,
        checkpointRevision: recorded?.checkpoint?.revision ?? null,
      },
      now,
      afterStep,
    });
    steps = await recoveryStore.readSteps({ tab: getTab?.(tab.id) || currentTab, recovery });
  }

  let workflowResult = steps.workflowApplied?.value?.workflowResult || null;
  if (!steps.workflowApplied) {
    workflowResult = await applyWorkflow(
      getTab?.(tab.id) || currentTab,
      recovery.workflowEvent,
      {
        taskId: recovery.recoveryContext.taskId,
        attemptId: recovery.recoveryContext.attemptId,
        workflowKind: recovery.recoveryContext.workflowKind,
        stage: recovery.recoveryContext.stage,
        recoveryOperationId: recovery.operationId,
      },
    );
    await markRecoveryStep({
      recoveryStore,
      tab: getTab?.(tab.id) || currentTab,
      recovery,
      step: "workflowApplied",
      value: { workflowResult: workflowResult == null ? null : snapshot(workflowResult) },
      now,
      afterStep,
    });
    steps = await recoveryStore.readSteps({ tab: getTab?.(tab.id) || currentTab, recovery });
  }

  currentTab = getTab?.(tab.id) || currentTab;
  if (!steps.finalTabPersisted) {
    let updated;
    try {
      updated = await updateTab(tab.id, {
        runningTaskId: null,
        workflowV2Compatibility: {
          ...(currentTab.workflowV2Compatibility || {}),
          repairRecovery: null,
          settlement: settledRecoveryProjection(recovery, recovery.recoveryContext, now()),
        },
      });
    } catch (error) {
      fail(
        "REPAIR recovery completed locally but final tab persistence failed",
        "WORKFLOW_V2_REPAIR_RECOVERY_FINAL_PERSIST_FAILED",
        { causeCode: String(error?.code || "") },
      );
    }
    currentTab = updated || getTab?.(tab.id) || currentTab;
    if (currentTab?.workflowV2Compatibility?.repairRecovery != null
      || currentTab?.workflowV2Compatibility?.settlement?.status !== "settled"
      || currentTab?.workflowV2Compatibility?.settlement?.operationId !== recovery.operationId) {
      fail(
        "REPAIR recovery final tab state cannot be read back",
        "WORKFLOW_V2_REPAIR_RECOVERY_FINAL_PERSIST_FAILED",
      );
    }
    await markRecoveryStep({
      recoveryStore,
      tab: currentTab,
      recovery,
      step: "finalTabPersisted",
      value: { settlementStatus: "settled" },
      now,
      afterStep,
    });
  }

  return Object.freeze({
    ok: true,
    status: "SETTLED",
    resumed: recoveryRecord != null,
    operationId: recovery.operationId,
    commitSha: settled.commitSha,
    workflowResult,
    recovery,
    tab: getTab?.(tab.id) || currentTab,
  });
}

export async function completeStructuredRepairRecovery(options = {}) {
  const recoveryStore = options.recoveryStore || fileRepairRecoveryStore;
  const tab = options.tab;
  const recovered = options.recoveryRecord ? validateRecoveryRecord(options.recoveryRecord) : null;
  const lockKey = recovered?.recoveryKey || recoveryKey({
    storyId: String(tab?.id || ""),
    contextId: options.dispatch?.contextId,
    contextRevision: options.dispatch?.contextRevision,
  });
  const run = () => completeStructuredRepairRecoveryUnlocked({
    ...options,
    recoveryStore,
    ...(recovered ? { recoveryRecord: recovered } : {}),
  });
  return typeof recoveryStore.withLock === "function"
    ? recoveryStore.withLock({ tab, lockKey }, run)
    : run();
}

function newestRecovery(records) {
  return [...records].sort((left, right) => (
    String(right.createdAt || "").localeCompare(String(left.createdAt || ""))
    || String(right.operationId || "").localeCompare(String(left.operationId || ""))
  ))[0] || null;
}

/** Finds and resumes one durable REPAIR outbox after Gateway restart. */
export async function resumePendingStructuredRepairRecovery({
  tab,
  recoveryStore = fileRepairRecoveryStore,
  ...dependencies
} = {}) {
  if (!tab?.id) {
    fail("REPAIR recovery resume requires a story", "WORKFLOW_V2_REPAIR_RECOVERY_DEPENDENCY_MISSING");
  }
  const records = await recoveryStore.list({ tab });
  if (!records.length) return { ok: true, resumed: false, pending: false, tab };
  const pointerOperationId = String(tab?.workflowV2Compatibility?.repairRecovery?.operationId || "");
  const committedOperationId = String(tab?.workflowV2Compatibility?.gitSettlement?.operationId || "");
  let selected = records.find((record) => record.operationId === pointerOperationId) || null;
  if (!selected && tab?.workflowV2Compatibility?.settlement?.status === "failed") {
    selected = records.find((record) => record.operationId === committedOperationId) || null;
  }
  if (!selected) {
    const unfinished = [];
    for (const record of records) {
      const steps = await recoveryStore.readSteps({ tab, recovery: record });
      if (!steps.finalTabPersisted) unfinished.push(record);
    }
    if (unfinished.length > 1) {
      fail(
        "story contains multiple unfinished REPAIR recovery operations",
        "WORKFLOW_V2_REPAIR_RECOVERY_IDEMPOTENCY_CONFLICT",
        { operations: unfinished.map((record) => record.operationId).sort() },
      );
    }
    selected = unfinished[0] || null;
  }
  if (!selected && tab?.workflowV2Compatibility?.settlement?.status === "failed") {
    selected = newestRecovery(records.filter((record) => record.operationId === committedOperationId));
  }
  if (!selected) return { ok: true, resumed: false, pending: false, tab };
  return completeStructuredRepairRecovery({
    tab,
    recoveryRecord: selected,
    recoveryStore,
    ...dependencies,
  });
}
