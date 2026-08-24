import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";

import {
  createWorkflowV2ControllerReceiptBridge,
  WORKFLOW_V2_BUILD_CONTROLLER_ADAPTER_ID,
  WORKFLOW_V2_DEVICE_PROXY_ADAPTER_ID,
} from "../services/devbench/workflow-v2/controller-receipt-bridge.js";
import {
  WORKFLOW_V2_BUILD_EXECUTOR_ATTESTATION,
} from "../services/devbench/workflow-v2/build-controller.js";
import {
  WORKFLOW_V2_DEVICE_ADAPTER_ATTESTATION,
} from "../services/devbench/device-operation-guard-service.js";
import { verifyControlledReceiptOutput } from "../services/devbench/workflow-v2/controlled-receipt-evidence.js";
import { canonicalSha256 } from "../services/devbench/workflow-v2/envelope-store.js";
import {
  buildStageReceiptRecorder,
} from "../services/devbench/workflow-v2/receipt-producer.js";
import {
  WORKFLOW_V2_SCHEMA_IDS,
  workflowV2SchemaRegistry,
} from "../services/devbench/workflow-v2/schema-registry.js";
import { buildTrustedStageExecution } from "../services/devbench/workflow-v2/trusted-execution-profile.js";

process.env.NODE_ENV = "test";

function sha256Text(value) {
  return createHash("sha256").update(String(value || ""), "utf8").digest("hex");
}

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "workflow-v2-controller-bridge-"));

after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));

function git(args, cwd) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function deepFreeze(value, seen = new Set()) {
  if (!value || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
}

function storageApiFor(storyDirectory) {
  return {
    getStoryStoragePaths: () => ({ storyDirectory }),
    validateStoryStorageTarget: (_tab, targetPath, {
      baseDirectory = storyDirectory,
      createDirectory = false,
      mustExist = false,
      expectedType = "",
    } = {}) => {
      const base = path.resolve(baseDirectory);
      const target = path.resolve(targetPath);
      const relative = path.relative(base, target);
      if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error("path escape");
      if (createDirectory && !fs.existsSync(target)) fs.mkdirSync(target);
      if (mustExist && !fs.existsSync(target)) throw new Error("missing target");
      if (fs.existsSync(target)) {
        const stat = fs.lstatSync(target);
        if (stat.isSymbolicLink()) throw new Error("symlink target");
        if (expectedType === "directory" && !stat.isDirectory()) throw new Error("not directory");
        if (expectedType === "file" && !stat.isFile()) throw new Error("not file");
      }
      return target;
    },
  };
}

function appendHarness({ tab, dispatch, executionProfile, controllerBridge, storyDirectory }) {
  const receipts = [];
  const storageApi = storageApiFor(storyDirectory);
  const effectiveDispatch = deepFreeze({
    ...dispatch,
    executionProfile,
    executionStatus: { status: "READY", profileId: executionProfile.profileId, blockers: [] },
    executionProfileSha256: canonicalSha256({
      executionProfile,
      status: "READY",
      profileId: executionProfile.profileId,
      blockers: [],
    }),
  });
  const appendReceipt = async ({ revision, idempotencyKey, operationArgs, payload }) => {
    const operationArgsSha256 = canonicalSha256({
      action: payload.action,
      toolName: payload.toolName,
      rootId: payload.rootId ?? null,
      selector: payload.selector ?? null,
      operationArgs,
    });
    const unsigned = {
      schemaVersion: "workflow-envelope-v2",
      storyId: tab.id,
      recordId: payload.receiptId,
      contextId: null,
      revision,
      idempotencyKey,
      payloadSchemaId: WORKFLOW_V2_SCHEMA_IDS.evidenceReceipt,
      payloadSha256: canonicalSha256(payload),
      operationArgsSha256,
      previousEnvelopeSha256: receipts.at(-1)?.envelopeSha256 || null,
      createdAt: "2026-08-08T08:00:00.000Z",
      payload,
    };
    const envelope = { ...unsigned, envelopeSha256: canonicalSha256(unsigned), operationArgs };
    receipts.push(envelope);
    return { replayed: false, envelope };
  };
  const recorder = buildStageReceiptRecorder({
    tab,
    dispatch: effectiveDispatch,
    executionProfile,
    controllerBridge,
    storageApi,
    readEnvelopes: async () => [...receipts],
    appendReceipt,
    runProcess: async () => { throw new Error("BUILD/DEVICE must never invoke runProcess"); },
    now: () => "2026-08-08T08:00:00.000Z",
  });
  return { recorder, receipts, storageApi, dispatch: effectiveDispatch };
}

function buildFixture() {
  const repositoryPath = path.join(tempRoot, `repo-${Math.random().toString(36).slice(2)}`);
  const storyDirectory = path.join(tempRoot, `story-${Math.random().toString(36).slice(2)}`);
  fs.mkdirSync(repositoryPath, { recursive: true });
  fs.mkdirSync(storyDirectory, { recursive: true });
  git(["init", "-q", "-b", "main"], repositoryPath);
  git(["config", "user.email", "test@example.com"], repositoryPath);
  git(["config", "user.name", "Test"], repositoryPath);
  fs.writeFileSync(path.join(repositoryPath, "flavorConfig.json"), JSON.stringify({ demo: { versionName: "1.0.0", versionCode: 100 } }));
  git(["add", "flavorConfig.json"], repositoryPath);
  git(["commit", "-q", "-m", "chore: 初始化测试仓库"], repositoryPath);
  const head = git(["rev-parse", "HEAD"], repositoryPath);
  const tab = {
    id: "story-bridge-build",
    primaryProjectId: "repo-main",
    flavors: [{ path: repositoryPath, flavor: "demo" }],
  };
  const roots = [{
    rootId: "main",
    kind: "MAIN",
    repositoryId: "repo-main",
    branch: "main",
    headSha: head,
    flavor: "demo",
    writable: true,
  }];
  const storyStore = {
    getTab: () => tab,
    tabProjectPaths: () => [{ path: repositoryPath, role: "primary", name: "Main" }],
    getTabFlavor: () => "demo",
    getAndroidFlavors: () => ({ isAndroid: true, flavors: ["demo"], buildVariants: ["demo"] }),
    expandAndroidBuildFlavors: (_targetPath, flavors) => flavors,
    readProjectVersion: () => ({ ok: true, versionName: "1.0.0", versionCode: 100 }),
  };
  return { repositoryPath, storyDirectory, tab, roots, storyStore, head };
}

function trustedBuild(tab, roots) {
  return buildTrustedStageExecution({
    config: {
      workflowV2: {
        activeExecutionProfileId: "build-profile",
        executionProfiles: [{
          profileId: "build-profile",
          rootId: "main",
          stages: {
            REPAIR: {
              executors: [{
                executorId: "build-release",
                action: "BUILD",
                buildType: "release",
                cwdRootId: "main",
                timeoutMs: 120_000,
              }],
              localChecks: [{
                checkId: "build-main",
                name: "release build",
                executorId: "build-release",
                mandatory: true,
                rootId: "main",
              }],
            },
          },
        }],
      },
    },
    tab,
    stageId: "REPAIR",
    roots,
  });
}

function buildDispatch(tab, roots, trusted) {
  return {
    contextId: "ctx-build-bridge",
    contextRevision: 1,
    evidenceSnapshots: [],
    context: {
      story: { storyId: tab.id },
      stage: { id: "REPAIR" },
      scope: { roots },
      data: { localChecks: trusted.localChecks },
    },
  };
}

test("BUILD receipt 只走专用 Controller，并绑定冻结 Flavor/task/HEAD/产物 hash", async () => {
  const fixture = buildFixture();
  const trusted = trustedBuild(fixture.tab, fixture.roots);
  assert.equal(trusted.status, "READY");
  assert.equal(trusted.executionProfile.executors[0].adapterId, WORKFLOW_V2_BUILD_CONTROLLER_ADAPTER_ID);
  assert.equal("argv" in trusted.executionProfile.executors[0], false);
  const dispatch = buildDispatch(fixture.tab, fixture.roots, trusted);
  const calls = { attest: 0, execute: 0 };
  const executorBroker = {
    attest: async ({ rootId, repositoryId }) => {
      calls.attest += 1;
      return { ok: true, kind: WORKFLOW_V2_BUILD_EXECUTOR_ATTESTATION, rootId, repositoryId };
    },
    execute: async (input) => {
      calls.execute += 1;
      const artifactPath = path.join(fixture.repositoryPath, "build", "outputs", "app-demo-release.apk");
      fs.mkdirSync(path.dirname(artifactPath), { recursive: true });
      fs.writeFileSync(artifactPath, `artifact-${input.head}`);
      const artifactSha256 = createHash("sha256").update(fs.readFileSync(artifactPath)).digest("hex");
      return {
        exitCode: 0,
        artifactPath,
        provenance: {
          head: input.head,
          task: input.task,
          flavor: input.flavor,
          buildType: input.buildType,
          versionName: input.version.versionName,
          versionCode: input.version.versionCode,
          artifactSha256,
        },
      };
    },
  };
  const controllerBridge = createWorkflowV2ControllerReceiptBridge({
    tab: fixture.tab,
    dispatch,
    buildControllerOptions: { storyStore: fixture.storyStore, executorBroker },
  });
  const harness = appendHarness({
    tab: fixture.tab,
    dispatch,
    executionProfile: trusted.executionProfile,
    controllerBridge,
    storyDirectory: fixture.storyDirectory,
  });

  for (const extra of [{ task: "clean" }, { flavor: "other" }, { command: "gradlew clean" }]) {
    assert.throws(
      () => harness.recorder.runLocalCheck({
        rootId: "main",
        checkId: "build-main",
        absoluteRoot: fixture.repositoryPath,
        ...extra,
      }),
      (error) => error.code === "WORKFLOW_V2_RECEIPT_CONTROLLED_INPUT_FORBIDDEN",
    );
  }
  assert.equal(calls.execute, 0);

  const result = await harness.recorder.runLocalCheck({
    rootId: "main",
    checkId: "build-main",
    absoluteRoot: fixture.repositoryPath,
  });
  assert.equal(result.status, "PASS");
  assert.equal(calls.attest, 1);
  assert.equal(calls.execute, 1);
  const receipt = harness.receipts[0].payload;
  assert.equal(receipt.selector.contextId, dispatch.contextId);
  assert.equal(receipt.selector.checkId, "build-main");
  assert.equal(receipt.selector.executorId, "build-release");
  assert.equal(receipt.selector.controller.flavor, "demo");
  assert.equal(receipt.selector.controller.task, "assembleDemoRelease");
  assert.equal(receipt.selector.controller.head, fixture.head);
  assert.equal(receipt.selector.controller.artifact.sha256.length, 64);
  assert.equal(receipt.selector.controller.artifact.sha256 === receipt.sha256, false);
  assert.equal(workflowV2SchemaRegistry.validate(WORKFLOW_V2_SCHEMA_IDS.evidenceReceipt, receipt).valid, true);
  const { operationArgs: _operationArgs, ...signedEnvelope } = harness.receipts[0];
  const envelopeValidation = workflowV2SchemaRegistry.validate(WORKFLOW_V2_SCHEMA_IDS.workflowEnvelope, signedEnvelope);
  assert.equal(envelopeValidation.valid, true, JSON.stringify(envelopeValidation.errors));
  assert.equal(verifyControlledReceiptOutput({ tab: fixture.tab, receipt, storageApi: harness.storageApi }).valid, true);
});

test("BUILD 缺少受证明 broker 时产生 BLOCKED envelope 且零底层执行", async () => {
  const fixture = buildFixture();
  const trusted = trustedBuild(fixture.tab, fixture.roots);
  const dispatch = buildDispatch(fixture.tab, fixture.roots, trusted);
  const controllerBridge = createWorkflowV2ControllerReceiptBridge({
    tab: fixture.tab,
    dispatch,
    buildControllerOptions: { storyStore: fixture.storyStore },
  });
  const harness = appendHarness({
    tab: fixture.tab,
    dispatch,
    executionProfile: trusted.executionProfile,
    controllerBridge,
    storyDirectory: fixture.storyDirectory,
  });
  const result = await harness.recorder.runLocalCheck({ rootId: "main", checkId: "build-main", absoluteRoot: fixture.repositoryPath });
  assert.equal(result.status, "BLOCKED");
  assert.match(result.output, /WORKFLOW_V2_BUILD_CONFINED_EXECUTOR_UNAVAILABLE/);
  assert.equal(harness.receipts[0].payload.status, "BLOCKED");
  assert.equal(harness.receipts[0].payload.selector.controller.head, fixture.head);
});

function trustedDevice(tab, roots) {
  return buildTrustedStageExecution({
    config: {
      workflowV2: {
        activeExecutionProfileId: "device-profile",
        executionProfiles: [{
          profileId: "device-profile",
          rootId: "main",
          stages: {
            VERIFY_EXECUTE: {
              executors: [{
                executorId: "install-release",
                action: "DEVICE_ACTION",
                businessAction: "install_release",
                cwdRootId: "main",
                timeoutMs: 120_000,
              }],
              cases: [{
                caseId: "device-install",
                title: "install release",
                mandatory: true,
                executorId: "install-release",
                target: { rootId: "main" },
                requirements: [],
                preconditions: [],
                steps: ["install"],
                assertions: ["installed"],
                evidenceRequirements: ["receipt"],
                cleanup: [],
                failureDiagnostics: [],
              }],
            },
          },
        }],
      },
    },
    tab,
    stageId: "VERIFY_EXECUTE",
    roots,
  });
}

function deviceFixture() {
  const projectRoot = path.join(tempRoot, `device-project-${Math.random().toString(36).slice(2)}`);
  const storyDirectory = path.join(tempRoot, `device-story-${Math.random().toString(36).slice(2)}`);
  fs.mkdirSync(projectRoot, { recursive: true });
  fs.mkdirSync(storyDirectory, { recursive: true });
  const tab = { id: "story-bridge-device", deviceSerial: "SERIAL-BRIDGE" };
  const roots = [{ rootId: "main", kind: "MAIN", writable: false }];
  const lease = {
    serial: tab.deviceSerial,
    storyId: tab.id,
    leaseId: "lease-bridge",
    fencingToken: 9,
    expiresAt: 80_000,
    expired: false,
  };
  return { projectRoot, storyDirectory, tab, roots, lease };
}

test("DEVICE_ACTION 从冻结 executor registry 映射 businessAction，并绑定同故事 lease", async () => {
  const fixture = deviceFixture();
  const trusted = trustedDevice(fixture.tab, fixture.roots);
  assert.equal(trusted.status, "READY");
  assert.deepEqual(trusted.executionProfile.executors[0], {
    executorId: "install-release",
    action: "DEVICE_ACTION",
    adapterId: WORKFLOW_V2_DEVICE_PROXY_ADAPTER_ID,
    businessAction: "install_release",
    cwdRootId: "main",
    timeoutMs: 120_000,
  });
  const dispatch = {
    contextId: "ctx-device-bridge",
    contextRevision: 1,
    evidenceSnapshots: [],
    deviceLeaseSnapshot: {
      serialSha256: sha256Text(fixture.tab.deviceSerial),
      leaseId: fixture.lease.leaseId,
      fencingToken: fixture.lease.fencingToken,
    },
    context: {
      story: { storyId: fixture.tab.id },
      stage: { id: "VERIFY_EXECUTE" },
      scope: { roots: fixture.roots },
      data: { verificationPlan: trusted.verificationPlan },
    },
  };
  const calls = { action: 0, heartbeat: 0, input: null };
  const actionAdapter = Object.freeze({
    attest: async ({ businessAction }) => ({
      ok: true,
      kind: WORKFLOW_V2_DEVICE_ADAPTER_ATTESTATION,
      businessAction,
    }),
    execute: async (input) => {
      calls.action += 1;
      calls.input = input;
      return { ok: true, businessAction: input.businessAction };
    },
  });
  const controllerBridge = createWorkflowV2ControllerReceiptBridge({
    tab: fixture.tab,
    dispatch,
    deviceActions: Object.freeze({ install_release: actionAdapter }),
    deviceProxyOptions: {
      readStory: async () => fixture.tab,
      readRuntimeSnapshot: async () => ({ status: "acquired", serial: fixture.tab.deviceSerial, lease: fixture.lease }),
      heartbeat: async () => {
        calls.heartbeat += 1;
        return { ok: true, status: "renewed", lease: { ...fixture.lease, expiresAt: 90_000 } };
      },
      nowMs: () => 10_000,
    },
  });
  const harness = appendHarness({
    tab: fixture.tab,
    dispatch,
    executionProfile: trusted.executionProfile,
    controllerBridge,
    storyDirectory: fixture.storyDirectory,
  });

  for (const extra of [{ serial: "OTHER" }, { leaseId: "other" }, { businessAction: "reboot" }]) {
    assert.throws(
      () => harness.recorder.runVerificationCase({
        rootId: "main",
        caseId: "device-install",
        absoluteRoot: fixture.projectRoot,
        ...extra,
      }),
      (error) => error.code === "WORKFLOW_V2_RECEIPT_CONTROLLED_INPUT_FORBIDDEN",
    );
  }
  assert.equal(calls.action, 0);
  const result = await harness.recorder.runVerificationCase({
    rootId: "main",
    caseId: "device-install",
    absoluteRoot: fixture.projectRoot,
  });
  assert.equal(result.status, "PASS");
  assert.equal(calls.action, 1);
  assert.equal(calls.heartbeat, 2);
  assert.deepEqual(calls.input, {
    businessAction: "install_release",
    storyId: fixture.tab.id,
    serial: fixture.tab.deviceSerial,
    leaseId: fixture.lease.leaseId,
    fencingToken: fixture.lease.fencingToken,
  });
  const receipt = harness.receipts[0].payload;
  assert.equal(receipt.selector.contextId, dispatch.contextId);
  assert.equal(receipt.selector.contextRevision, 1);
  assert.equal(receipt.selector.caseId, "device-install");
  assert.equal(receipt.selector.executorId, "install-release");
  assert.equal(receipt.selector.controller.businessAction, "install_release");
  assert.equal(receipt.selector.controller.leaseId, fixture.lease.leaseId);
  assert.equal(receipt.selector.controller.fencingToken, fixture.lease.fencingToken);
  assert.equal(receipt.selector.controller.serialSha256, canonicalSha256(fixture.tab.deviceSerial));
  assert.equal(JSON.stringify(receipt).includes(fixture.tab.deviceSerial), false);
  assert.equal(workflowV2SchemaRegistry.validate(WORKFLOW_V2_SCHEMA_IDS.evidenceReceipt, receipt).valid, true);
  assert.equal(verifyControlledReceiptOutput({ tab: fixture.tab, receipt, storageApi: harness.storageApi }).valid, true);
});

test("DEVICE_ACTION 缺少 attested adapter 时 BLOCKED 且零 lease/handler 调用", async () => {
  const fixture = deviceFixture();
  const trusted = trustedDevice(fixture.tab, fixture.roots);
  const dispatch = {
    contextId: "ctx-device-blocked",
    contextRevision: 1,
    evidenceSnapshots: [],
    deviceLeaseSnapshot: {
      serialSha256: sha256Text(fixture.tab.deviceSerial),
      leaseId: fixture.lease.leaseId,
      fencingToken: fixture.lease.fencingToken,
    },
    context: {
      story: { storyId: fixture.tab.id },
      stage: { id: "VERIFY_EXECUTE" },
      scope: { roots: fixture.roots },
      data: { verificationPlan: trusted.verificationPlan },
    },
  };
  let reads = 0;
  const controllerBridge = createWorkflowV2ControllerReceiptBridge({
    tab: fixture.tab,
    dispatch,
    deviceActions: Object.freeze({}),
    deviceProxyOptions: {
      readStory: async () => { reads += 1; return fixture.tab; },
      readRuntimeSnapshot: async () => { reads += 1; return { status: "acquired", serial: fixture.tab.deviceSerial, lease: fixture.lease }; },
      heartbeat: async () => { reads += 1; return { lease: fixture.lease }; },
    },
  });
  const harness = appendHarness({
    tab: fixture.tab,
    dispatch,
    executionProfile: trusted.executionProfile,
    controllerBridge,
    storyDirectory: fixture.storyDirectory,
  });
  const result = await harness.recorder.runVerificationCase({ rootId: "main", caseId: "device-install", absoluteRoot: fixture.projectRoot });
  assert.equal(result.status, "BLOCKED");
  assert.equal(reads, 0);
  assert.match(result.output, /WORKFLOW_V2_DEVICE_ADAPTER_UNAVAILABLE/);
  assert.equal(harness.receipts[0].payload.selector.controller.businessAction, "install_release");
});
