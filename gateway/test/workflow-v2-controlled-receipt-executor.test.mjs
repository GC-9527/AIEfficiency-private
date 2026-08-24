import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";

import { getToolDefinitions } from "../services/api-tools.js";
import {
  buildStageReceiptRecorder,
  WorkflowV2ReceiptProducerError,
} from "../services/devbench/workflow-v2/receipt-producer.js";
import { canonicalSha256 } from "../services/devbench/workflow-v2/envelope-store.js";
import { getWorkflowV2StageToolPolicyTemplate } from "../services/devbench/workflow-v2/stage-tool-policy.js";
import { WORKFLOW_V2_SCHEMA_IDS } from "../services/devbench/workflow-v2/schema-registry.js";
import { buildTrustedSystemGate } from "../services/devbench/workflow-v2/system-verification-gate.js";

process.env.NODE_ENV = "test";

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "workflow-v2-controlled-receipt-"));
const projectRoot = path.join(tempRoot, "project");
const storyRoot = path.join(tempRoot, "story");
fs.mkdirSync(projectRoot, { recursive: true });
fs.mkdirSync(storyRoot, { recursive: true });
let receiptHarnessSequence = 0;

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
      if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
        throw Object.assign(new Error("path escape"), { code: "TEST_PATH_ESCAPE" });
      }
      if (fs.lstatSync(base).isSymbolicLink()) throw Object.assign(new Error("symlink base"), { code: "TEST_SYMLINK" });
      let current = base;
      for (const segment of relative.split(path.sep).filter(Boolean)) {
        current = path.join(current, segment);
        if (!fs.existsSync(current)) continue;
        const stat = fs.lstatSync(current);
        if (stat.isSymbolicLink()) throw Object.assign(new Error("symlink target"), { code: "TEST_SYMLINK" });
      }
      if (createDirectory && !fs.existsSync(target)) fs.mkdirSync(target);
      if (mustExist && !fs.existsSync(target)) throw Object.assign(new Error("missing target"), { code: "TEST_MISSING" });
      if (fs.existsSync(target)) {
        const stat = fs.lstatSync(target);
        if (stat.isSymbolicLink()) throw Object.assign(new Error("symlink leaf"), { code: "TEST_SYMLINK" });
        if (expectedType === "directory" && !stat.isDirectory()) throw new Error("not directory");
        if (expectedType === "file" && !stat.isFile()) throw new Error("not file");
      }
      return target;
    },
  };
}

function deepFreeze(value, seen = new Set()) {
  if (!value || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
}

function checkDispatch({ revision = 1, action = "TEST", executorId = "exec-check" } = {}) {
  return deepFreeze({
    contextId: "ctx-controlled",
    contextRevision: revision,
    evidenceSnapshots: [],
    context: {
      stage: { id: "REPAIR" },
      data: {
        localChecks: [{
          checkId: "check-main",
          name: "unit test",
          executorId,
          action,
          mandatory: true,
          rootId: "main",
        }],
      },
    },
  });
}

function checkProfile({ argv = [process.execPath, "-e", "process.exit(0)"], action = "TEST", executorId = "exec-check" } = {}) {
  return deepFreeze({
    schemaVersion: "workflow-v2-execution-profile-v1",
    profileId: "profile-check",
    rootId: "main",
    stageId: "REPAIR",
    executors: [{ executorId, action, argv, cwdRootId: "main", timeoutMs: 10_000 }],
  });
}

function verifyDispatch(actions, revision = 1) {
  return deepFreeze({
    contextId: "ctx-verify",
    contextRevision: revision,
    evidenceSnapshots: [],
    context: {
      story: { storyId: "story-controlled" },
      stage: { id: "VERIFY_EXECUTE" },
      data: {
        verificationPlan: {
          schemaVersion: "verification-plan-v2",
          planId: "plan-controlled",
          profileId: "profile-verify",
          status: "READY",
          storyIds: ["story-controlled"],
          mandatoryCapabilities: actions.map((entry) => entry.action).sort(),
          blockers: [],
          cases: actions.map(({ caseId, executorId, action }) => ({
            caseId,
            title: caseId,
            storyIds: ["story-controlled"],
            executorId,
            action,
            mandatory: true,
            requirements: [],
            target: {
              rootId: "main",
              flavor: null,
              buildType: null,
              deviceProfileId: null,
              environment: null,
            },
            steps: ["run"],
            assertions: ["pass"],
            evidenceRequirements: ["receipt"],
            cleanup: [],
          })),
        },
      },
    },
  });
}

function verifyProfile(actions) {
  return deepFreeze({
    schemaVersion: "workflow-v2-execution-profile-v1",
    profileId: "profile-verify",
    rootId: "main",
    stageId: "VERIFY_EXECUTE",
    executors: actions.map(({ executorId, action, adapterId }) => ({
      executorId,
      action,
      adapterId,
      cwdRootId: "main",
      timeoutMs: 10_000,
    })),
  });
}

function receiptHarness({ dispatch, executionProfile, runProcess, adapterHandlers, receipts = [], storyDirectory = null, appendReceiptOverride = null }) {
  const effectiveStoryDirectory = storyDirectory || path.join(storyRoot, `h-${++receiptHarnessSequence}`);
  fs.mkdirSync(effectiveStoryDirectory, { recursive: true });
  const storageApi = storageApiFor(effectiveStoryDirectory);
  const appendReceipt = async ({ revision, idempotencyKey, operationArgs, payload }) => {
    if (appendReceiptOverride) {
      const overridden = await appendReceiptOverride({ revision, idempotencyKey, operationArgs, payload, receipts });
      if (overridden !== undefined) return overridden;
    }
    const operationArgsSha256 = canonicalSha256({
      action: payload.action,
      toolName: payload.toolName,
      rootId: payload.rootId ?? null,
      selector: payload.selector ?? null,
      operationArgs,
    });
    const sameKey = receipts.find((entry) => entry.idempotencyKey === idempotencyKey);
    const sameOperation = receipts.find((entry) => entry.payload.operationId === payload.operationId);
    const replay = sameKey || sameOperation;
    if (replay) {
      if (replay.operationArgsSha256 !== operationArgsSha256) {
        const error = new Error("operation conflict");
        error.code = "WORKFLOW_V2_RECEIPT_OPERATION_CONFLICT";
        throw error;
      }
      return { replayed: true, envelope: replay };
    }
    const unsigned = {
      schemaVersion: "workflow-envelope-v2",
      storyId: "story-controlled",
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
  const effectiveDispatch = executionProfile
    ? deepFreeze({
      ...dispatch,
      executionProfile,
      executionStatus: { status: "READY", profileId: executionProfile.profileId, blockers: [] },
      executionProfileSha256: canonicalSha256({
        executionProfile,
        status: "READY",
        profileId: executionProfile.profileId,
        blockers: [],
      }),
    })
    : dispatch;
  return {
    receipts,
    dispatch: effectiveDispatch,
    storyDirectory: effectiveStoryDirectory,
    recorder: buildStageReceiptRecorder({
      tab: { id: "story-controlled" },
      dispatch: effectiveDispatch,
      executionProfile,
      storageApi,
      readEnvelopes: async () => [...receipts],
      appendReceipt,
      ...(runProcess ? { runProcess } : {}),
      ...(adapterHandlers ? { adapterHandlers } : {}),
      now: () => "2026-08-08T08:00:00.000Z",
    }),
  };
}

test("controlled tool definitions are hidden without a Workflow v2 recorder", () => {
  const ordinary = getToolDefinitions({ commandPolicy: "workspace" }).map((entry) => entry.function.name);
  const controlled = getToolDefinitions({
    commandPolicy: "read_only",
    workflowV2ControlledExecution: true,
  }).map((entry) => entry.function.name);
  assert.equal(ordinary.includes("run_local_check"), false);
  assert.equal(ordinary.includes("run_verification_case"), false);
  assert.equal(controlled.includes("run_local_check"), true);
  assert.equal(controlled.includes("run_verification_case"), true);
});

test("stage policy exposes only parameterized controlled tools, not raw shell or DB MCP", () => {
  const repair = getWorkflowV2StageToolPolicyTemplate("REPAIR");
  const verify = getWorkflowV2StageToolPolicyTemplate("VERIFY_EXECUTE");
  assert.equal(repair.allowedToolNames.includes("run_local_check"), true);
  assert.equal(repair.allowedToolNames.includes("run_command"), false);
  assert.deepEqual(verify.allowedToolNames, ["run_verification_case"]);
});

test("attested-runner injection consumes frozen argv and emits a TEST/PASS receipt", async () => {
  let observed;
  const harness = receiptHarness({
    dispatch: checkDispatch(),
    executionProfile: checkProfile(),
    runProcess: async (request) => {
      observed = request;
      return { exitCode: 0, timedOut: false, stdout: "ok", stderr: "" };
    },
  });
  const result = await harness.recorder.runLocalCheck({
    rootId: "main",
    checkId: "check-main",
    absoluteRoot: projectRoot,
  });
  assert.equal(result.status, "PASS");
  assert.equal(result.action, "TEST");
  assert.equal(harness.receipts.length, 1);
  assert.equal(harness.receipts[0].payload.selector.name, "unit test");
  assert.equal(harness.receipts[0].payload.selector.executorId, "exec-check");
  assert.match(result.receiptId, /^gateway-test-/);
  assert.deepEqual(observed.argv, [process.execPath, "-e", "process.exit(0)"]);
  assert.equal(observed.cwd, projectRoot);
});

test("production default fails closed without an attested confined executor", async () => {
  const harness = receiptHarness({ dispatch: checkDispatch(), executionProfile: checkProfile() });
  const result = await harness.recorder.runLocalCheck({
    rootId: "main",
    checkId: "check-main",
    absoluteRoot: projectRoot,
  });
  assert.equal(result.status, "BLOCKED");
  assert.match(result.output, /CONFINED_EXECUTOR_UNAVAILABLE/);
  assert.equal(harness.receipts[0].payload.status, "BLOCKED");
});

test("same revision replays before side effect; concurrent calls execute once", async () => {
  let executions = 0;
  const harness = receiptHarness({
    dispatch: checkDispatch(),
    executionProfile: checkProfile(),
    runProcess: async () => {
      executions += 1;
      await new Promise((resolve) => setTimeout(resolve, 20));
      return { exitCode: 0, timedOut: false, stdout: "ok", stderr: "" };
    },
  });
  const [first, replay] = await Promise.all([
    harness.recorder.runLocalCheck({ rootId: "main", checkId: "check-main", absoluteRoot: projectRoot }),
    harness.recorder.runLocalCheck({ rootId: "main", checkId: "check-main", absoluteRoot: projectRoot }),
  ]);
  assert.equal(executions, 1);
  assert.equal(harness.receipts.length, 1);
  assert.equal(first.receiptId, replay.receiptId);
  assert.equal([first.replayed, replay.replayed].includes(true), true);
});

test("two recorder instances share a durable reservation and never duplicate the external action", async () => {
  const sharedStoryDirectory = path.join(storyRoot, `shared-${++receiptHarnessSequence}`);
  const receipts = [];
  let executions = 0;
  let releaseExecution;
  let markStarted;
  const started = new Promise((resolve) => { markStarted = resolve; });
  const released = new Promise((resolve) => { releaseExecution = resolve; });
  const runProcess = async () => {
    executions += 1;
    markStarted();
    await released;
    return { exitCode: 0, timedOut: false, stdout: "durable ok", stderr: "" };
  };
  const first = receiptHarness({
    dispatch: checkDispatch(),
    executionProfile: checkProfile(),
    receipts,
    storyDirectory: sharedStoryDirectory,
    runProcess,
  });
  const second = receiptHarness({
    dispatch: checkDispatch(),
    executionProfile: checkProfile(),
    receipts,
    storyDirectory: sharedStoryDirectory,
    runProcess,
  });
  const pending = first.recorder.runLocalCheck({ rootId: "main", checkId: "check-main", absoluteRoot: projectRoot });
  await started;
  await assert.rejects(
    second.recorder.runLocalCheck({ rootId: "main", checkId: "check-main", absoluteRoot: projectRoot }),
    (error) => error.code === "WORKFLOW_V2_CONTROLLED_OPERATION_AMBIGUOUS",
  );
  releaseExecution();
  const result = await pending;
  assert.equal(result.status, "PASS");
  assert.equal(executions, 1);
  assert.equal(receipts.length, 1);
});

test("append failure retries from durable settlement without another external action", async () => {
  const sharedStoryDirectory = path.join(storyRoot, `append-fault-${++receiptHarnessSequence}`);
  const receipts = [];
  let executions = 0;
  let appendAttempts = 0;
  const runProcess = async () => {
    executions += 1;
    return { exitCode: 0, timedOut: false, stdout: "settled before append", stderr: "" };
  };
  const appendReceiptOverride = async () => {
    appendAttempts += 1;
    if (appendAttempts === 1) throw Object.assign(new Error("injected append fault"), { code: "TEST_APPEND_FAULT" });
    return undefined;
  };
  const first = receiptHarness({
    dispatch: checkDispatch(),
    executionProfile: checkProfile(),
    receipts,
    storyDirectory: sharedStoryDirectory,
    runProcess,
    appendReceiptOverride,
  });
  await assert.rejects(
    first.recorder.runLocalCheck({ rootId: "main", checkId: "check-main", absoluteRoot: projectRoot }),
    (error) => error.code === "TEST_APPEND_FAULT",
  );
  assert.equal(executions, 1);
  assert.equal(receipts.length, 0);

  const restarted = receiptHarness({
    dispatch: checkDispatch(),
    executionProfile: checkProfile(),
    receipts,
    storyDirectory: sharedStoryDirectory,
    runProcess,
    appendReceiptOverride,
  });
  const replay = await restarted.recorder.runLocalCheck({ rootId: "main", checkId: "check-main", absoluteRoot: projectRoot });
  assert.equal(replay.status, "PASS");
  assert.equal(replay.replayed, true);
  assert.equal(executions, 1);
  assert.equal(receipts.length, 1);
  assert.equal(appendAttempts, 2);
});

test("tampered settled output is rejected after append fault and is never re-executed", async () => {
  const sharedStoryDirectory = path.join(storyRoot, `settlement-tamper-${++receiptHarnessSequence}`);
  const receipts = [];
  let executions = 0;
  const runProcess = async () => {
    executions += 1;
    return { exitCode: 0, timedOut: false, stdout: "trusted bytes", stderr: "" };
  };
  const first = receiptHarness({
    dispatch: checkDispatch(),
    executionProfile: checkProfile(),
    receipts,
    storyDirectory: sharedStoryDirectory,
    runProcess,
    appendReceiptOverride: async () => { throw Object.assign(new Error("append failed"), { code: "TEST_APPEND_FAULT" }); },
  });
  await assert.rejects(
    first.recorder.runLocalCheck({ rootId: "main", checkId: "check-main", absoluteRoot: projectRoot }),
    (error) => error.code === "TEST_APPEND_FAULT",
  );
  const outputDirectory = path.join(sharedStoryDirectory, "workflow-v2", "receipt-output");
  const [outputName] = fs.readdirSync(outputDirectory);
  fs.writeFileSync(path.join(outputDirectory, outputName), "tampered", "utf8");
  const restarted = receiptHarness({
    dispatch: checkDispatch(),
    executionProfile: checkProfile(),
    receipts,
    storyDirectory: sharedStoryDirectory,
    runProcess,
  });
  await assert.rejects(
    restarted.recorder.runLocalCheck({ rootId: "main", checkId: "check-main", absoluteRoot: projectRoot }),
    (error) => error.code === "WORKFLOW_V2_CONTROLLED_OPERATION_SETTLEMENT_INVALID",
  );
  assert.equal(executions, 1);
  assert.equal(receipts.length, 0);
});

test("receipt replay revalidates its durable settlement and rejects a later output tamper", async () => {
  const sharedStoryDirectory = path.join(storyRoot, `receipt-replay-tamper-${++receiptHarnessSequence}`);
  const receipts = [];
  let executions = 0;
  const runProcess = async () => {
    executions += 1;
    return { exitCode: 0, timedOut: false, stdout: "persisted replay bytes", stderr: "" };
  };
  const first = receiptHarness({
    dispatch: checkDispatch(),
    executionProfile: checkProfile(),
    receipts,
    storyDirectory: sharedStoryDirectory,
    runProcess,
  });
  const recorded = await first.recorder.runLocalCheck({
    rootId: "main",
    checkId: "check-main",
    absoluteRoot: projectRoot,
  });
  assert.equal(recorded.status, "PASS");
  assert.equal(receipts.length, 1);
  const outputRef = receipts[0].payload.outputRef;
  const outputPath = path.join(sharedStoryDirectory, ...outputRef.slice("storydev:/".length).split("/"));
  fs.writeFileSync(outputPath, "tampered after append", "utf8");

  const restarted = receiptHarness({
    dispatch: checkDispatch(),
    executionProfile: checkProfile(),
    receipts,
    storyDirectory: sharedStoryDirectory,
    runProcess,
  });
  await assert.rejects(
    restarted.recorder.runLocalCheck({ rootId: "main", checkId: "check-main", absoluteRoot: projectRoot }),
    (error) => error.code === "WORKFLOW_V2_CONTROLLED_OPERATION_SETTLEMENT_INVALID",
  );
  assert.equal(executions, 1);
  assert.equal(receipts.length, 1);
});

test("same operationId with changed frozen argv conflicts before execution", async () => {
  let executions = 0;
  const receipts = [];
  const first = receiptHarness({
    dispatch: checkDispatch(),
    executionProfile: checkProfile(),
    receipts,
    runProcess: async () => ({ exitCode: 0, timedOut: false, stdout: "ok", stderr: "" }),
  });
  await first.recorder.runLocalCheck({ rootId: "main", checkId: "check-main", absoluteRoot: projectRoot });
  const changed = receiptHarness({
    dispatch: checkDispatch(),
    executionProfile: checkProfile({ argv: [process.execPath, "-e", "process.exit(2)"] }),
    receipts,
    runProcess: async () => { executions += 1; return { exitCode: 2, timedOut: false }; },
  });
  await assert.rejects(
    changed.recorder.runLocalCheck({ rootId: "main", checkId: "check-main", absoluteRoot: projectRoot }),
    (error) => error.code === "WORKFLOW_V2_RECEIPT_OPERATION_CONFLICT",
  );
  assert.equal(executions, 0);
  assert.equal(receipts.length, 1);
});

test("new context revision executes again and emits a distinct receipt", async () => {
  let executions = 0;
  const receipts = [];
  const runProcess = async () => {
    executions += 1;
    return { exitCode: 0, timedOut: false, stdout: "ok", stderr: "" };
  };
  const first = receiptHarness({ dispatch: checkDispatch({ revision: 1 }), executionProfile: checkProfile(), receipts, runProcess });
  const second = receiptHarness({ dispatch: checkDispatch({ revision: 2 }), executionProfile: checkProfile(), receipts, runProcess });
  const one = await first.recorder.runLocalCheck({ rootId: "main", checkId: "check-main", absoluteRoot: projectRoot });
  const two = await second.recorder.runLocalCheck({ rootId: "main", checkId: "check-main", absoluteRoot: projectRoot });
  assert.equal(executions, 2);
  assert.notEqual(one.receiptId, two.receiptId);
  assert.equal(receipts.length, 2);
});

test("timeout is recorded as BLOCKED and non-zero exit as FAIL", async () => {
  const timedOut = receiptHarness({
    dispatch: checkDispatch(),
    executionProfile: checkProfile(),
    runProcess: async () => ({ exitCode: null, timedOut: true, stdout: "", stderr: "timeout" }),
  });
  const blocked = await timedOut.recorder.runLocalCheck({ rootId: "main", checkId: "check-main", absoluteRoot: projectRoot });
  assert.equal(blocked.status, "BLOCKED");
  assert.equal(timedOut.receipts[0].payload.exitCode, null);

  const failed = receiptHarness({
    dispatch: checkDispatch(),
    executionProfile: checkProfile(),
    runProcess: async () => ({ exitCode: 3, timedOut: false, stdout: "", stderr: "failed" }),
  });
  const result = await failed.recorder.runLocalCheck({ rootId: "main", checkId: "check-main", absoluteRoot: projectRoot });
  assert.equal(result.status, "FAIL");
  assert.equal(failed.receipts[0].payload.exitCode, 3);
});

test("EDIT receipt binds exact before/after existence and hashes; replay skips edit", async () => {
  const target = path.join(projectRoot, "edit-target.txt");
  fs.writeFileSync(target, "before", "utf8");
  let executions = 0;
  const harness = receiptHarness({ dispatch: checkDispatch(), executionProfile: checkProfile() });
  const request = {
    toolName: "edit_file",
    rootId: "main",
    pathRefs: [{ rootId: "main", path: "edit-target.txt", absolutePath: target, access: "write" }],
    operationArgs: { rootId: "main", path: target, old_string: "before", new_string: "after" },
    execute: async () => {
      executions += 1;
      fs.writeFileSync(target, "after", "utf8");
      return "edited";
    },
  };
  const first = await harness.recorder.recordEditExecution(request);
  const replay = await harness.recorder.recordEditExecution(request);
  const receipt = first.receipts[0].payload;
  assert.equal(executions, 1);
  assert.equal(replay.replayed, true);
  assert.equal(receipt.action, "EDIT");
  assert.equal(receipt.status, "PASS");
  assert.equal(receipt.selector.beforeExists, true);
  assert.equal(receipt.selector.afterExists, true);
  assert.match(receipt.selector.beforeSha256, /^[a-f0-9]{64}$/);
  assert.match(receipt.selector.afterSha256, /^[a-f0-9]{64}$/);
  assert.notEqual(receipt.selector.beforeSha256, receipt.selector.afterSha256);
});

test("EDIT A → TEST PASS → 再次 EDIT A 后同 checkId 绑定新 digest 并重新执行", async () => {
  const target = path.join(projectRoot, "edit-state-rerun.txt");
  fs.writeFileSync(target, "v0", "utf8");
  let checks = 0;
  const harness = receiptHarness({
    dispatch: checkDispatch(),
    executionProfile: checkProfile(),
    runProcess: async () => {
      checks += 1;
      return { exitCode: 0, timedOut: false, stdout: `check-${checks}`, stderr: "" };
    },
  });
  const edit = async (from, to) => harness.recorder.recordEditExecution({
    toolName: "edit_file",
    rootId: "main",
    pathRefs: [{ rootId: "main", path: "edit-state-rerun.txt", absolutePath: target, access: "write" }],
    operationArgs: { path: "edit-state-rerun.txt", old_string: from, new_string: to },
    execute: async () => fs.writeFileSync(target, to, "utf8"),
  });

  await edit("v0", "v1");
  const first = await harness.recorder.runLocalCheck({ rootId: "main", checkId: "check-main", absoluteRoot: projectRoot });
  await edit("v1", "v2");
  const second = await harness.recorder.runLocalCheck({ rootId: "main", checkId: "check-main", absoluteRoot: projectRoot });

  assert.equal(first.status, "PASS");
  assert.equal(second.status, "PASS");
  assert.equal(second.replayed, false);
  assert.equal(checks, 2);
  assert.notEqual(first.receiptId, second.receiptId);
  const checkReceipts = harness.receipts.filter((entry) => entry.payload.action === "TEST");
  assert.equal(checkReceipts.length, 2);
  assert.notEqual(
    checkReceipts[0].payload.selector.editStateSha256,
    checkReceipts[1].payload.selector.editStateSha256,
  );
});

test("受控检查执行期间发生 EDIT 时即使命令成功也只签发 BLOCKED", async () => {
  const target = path.join(projectRoot, "edit-state-concurrent.txt");
  fs.writeFileSync(target, "before", "utf8");
  let releaseCheck;
  let checkStarted;
  const started = new Promise((resolve) => { checkStarted = resolve; });
  const waitForRelease = new Promise((resolve) => { releaseCheck = resolve; });
  const harness = receiptHarness({
    dispatch: checkDispatch(),
    executionProfile: checkProfile(),
    runProcess: async () => {
      checkStarted();
      await waitForRelease;
      return { exitCode: 0, timedOut: false, stdout: "command passed", stderr: "" };
    },
  });
  await harness.recorder.recordEditExecution({
    toolName: "edit_file",
    rootId: "main",
    pathRefs: [{ rootId: "main", path: "edit-state-concurrent.txt", absolutePath: target, access: "write" }],
    operationArgs: { path: "edit-state-concurrent.txt", old_string: "before", new_string: "checked" },
    execute: async () => fs.writeFileSync(target, "checked", "utf8"),
  });
  const pending = harness.recorder.runLocalCheck({ rootId: "main", checkId: "check-main", absoluteRoot: projectRoot });
  await started;
  await harness.recorder.recordEditExecution({
    toolName: "edit_file",
    rootId: "main",
    pathRefs: [{ rootId: "main", path: "edit-state-concurrent.txt", absolutePath: target, access: "write" }],
    operationArgs: { path: "edit-state-concurrent.txt", old_string: "checked", new_string: "drifted" },
    execute: async () => fs.writeFileSync(target, "drifted", "utf8"),
  });
  releaseCheck();
  const result = await pending;

  assert.equal(result.status, "BLOCKED");
  const checkReceipt = harness.receipts.find((entry) => entry.payload.action === "TEST");
  assert.equal(checkReceipt.payload.status, "BLOCKED");
  assert.match(result.output, /EDIT_STATE_CHANGED_DURING_EXECUTION|changed during controlled execution/);
});

test("trusted DEVICE/DB/CAPTURE adapters map real terminal results to receipts", async () => {
  const actions = [
    { caseId: "device-case", executorId: "device-exec", action: "DEVICE_ACTION", adapterId: "device-proxy" },
    { caseId: "db-case", executorId: "db-exec", action: "DB_QUERY", adapterId: "appmarket-db" },
    { caseId: "capture-case", executorId: "capture-exec", action: "CAPTURE", adapterId: "evidence-capture" },
  ];
  const calls = [];
  const handler = async ({ action, executorId }) => {
    calls.push(executorId);
    return {
      status: "PASS",
      exitCode: 0,
      summary: `${action} verified`,
      output: `${action} evidence`,
      ...(action === "CAPTURE" ? { sha256: "a".repeat(64) } : {}),
    };
  };
  const initialDispatch = verifyDispatch(actions);
  const harness = receiptHarness({
    dispatch: initialDispatch,
    executionProfile: verifyProfile(actions),
    adapterHandlers: {
      "device-proxy": handler,
      "appmarket-db": handler,
      "evidence-capture": handler,
    },
  });
  for (const entry of actions) {
    const result = await harness.recorder.runVerificationCase({
      rootId: "main",
      caseId: entry.caseId,
      absoluteRoot: projectRoot,
    });
    assert.equal(result.status, "PASS");
    assert.equal(result.action, entry.action);
  }
  assert.deepEqual(calls, ["device-exec", "db-exec", "capture-exec"]);
  assert.deepEqual(harness.receipts.map((entry) => entry.payload.action), ["DEVICE_ACTION", "DB_QUERY", "CAPTURE"]);
  for (const envelope of harness.receipts) {
    assert.match(envelope.payload.outputRef, /^storydev:\/workflow-v2\/receipt-output\/[a-f0-9]{64}\.txt$/);
    assert.match(envelope.payload.sha256, /^[a-f0-9]{64}$/);
  }
  assert.match(harness.receipts[0].payload.evidenceId, /^case-evidence-[a-f0-9]{32}$/);
  const gateEnvelopes = harness.receipts.map(({ operationArgs: _operationArgs, ...envelope }) => envelope);
  const gate = await buildTrustedSystemGate({
    tab: { id: "story-controlled" },
    dispatch: harness.dispatch,
    result: {
      planId: "plan-controlled",
      cases: actions.map((entry, index) => ({
        caseId: entry.caseId,
        status: "PASS",
        receiptIds: [harness.receipts[index].payload.receiptId],
        evidenceRefs: [harness.receipts[index].payload.evidenceId],
      })),
    },
    readEnvelopes: async () => gateEnvelopes,
    storageApi: { getStoryStoragePaths: () => ({ storyDirectory: harness.storyDirectory }) },
  });
  assert.equal(gate.status, "PASS");

  const firstOutputRef = harness.receipts[0].payload.outputRef;
  const firstOutputPath = path.join(harness.storyDirectory, ...firstOutputRef.slice("storydev:/".length).split("/"));
  fs.writeFileSync(firstOutputPath, "tampered after receipt", "utf8");
  const tamperedGate = await buildTrustedSystemGate({
    tab: { id: "story-controlled" },
    dispatch: harness.dispatch,
    result: {
      planId: "plan-controlled",
      cases: actions.map((entry, index) => ({
        caseId: entry.caseId,
        status: "PASS",
        receiptIds: [harness.receipts[index].payload.receiptId],
        evidenceRefs: [harness.receipts[index].payload.evidenceId],
      })),
    },
    readEnvelopes: async () => gateEnvelopes,
    storageApi: { getStoryStoragePaths: () => ({ storyDirectory: harness.storyDirectory }) },
  });
  assert.equal(tamperedGate.status, "FAIL");
  assert.match(tamperedGate.reason, /输出证据不可验证/);
});

test("execution profile hash/status mismatch is rejected at recorder construction", () => {
  const executionProfile = checkProfile();
  assert.throws(
    () => buildStageReceiptRecorder({
      tab: { id: "story-controlled" },
      dispatch: deepFreeze({
        ...checkDispatch(),
        executionProfile,
        executionStatus: { status: "READY", profileId: executionProfile.profileId, blockers: [] },
        executionProfileSha256: "0".repeat(64),
      }),
      executionProfile,
      storageApi: { getStoryStoragePaths: () => ({ storyDirectory: storyRoot }) },
    }),
    (error) => error.code === "WORKFLOW_V2_RECEIPT_EXECUTION_PROFILE_UNTRUSTED",
  );
});

test("adapter PASS without persistable observed output is downgraded to BLOCKED", async () => {
  const actions = [{ caseId: "db-empty", executorId: "db-empty-exec", action: "DB_QUERY", adapterId: "empty-db" }];
  const harness = receiptHarness({
    dispatch: verifyDispatch(actions),
    executionProfile: verifyProfile(actions),
    adapterHandlers: {
      "empty-db": async () => ({ status: "PASS", exitCode: 0, summary: "", output: "" }),
    },
  });
  const result = await harness.recorder.runVerificationCase({
    rootId: "main",
    caseId: "db-empty",
    absoluteRoot: projectRoot,
  });
  assert.equal(result.status, "BLOCKED");
  assert.equal(harness.receipts[0].payload.outputRef, undefined);
  assert.equal(harness.receipts[0].payload.sha256, undefined);
});

test("pre-created receipt-output symlink/junction is rejected with zero external writes", async () => {
  const symlinkStory = path.join(tempRoot, "symlink-story");
  const workflowDirectory = path.join(symlinkStory, "workflow-v2");
  const outside = path.join(tempRoot, "outside-receipt-output");
  fs.mkdirSync(workflowDirectory, { recursive: true });
  fs.mkdirSync(outside, { recursive: true });
  fs.symlinkSync(outside, path.join(workflowDirectory, "receipt-output"), process.platform === "win32" ? "junction" : "dir");
  const harness = receiptHarness({
    dispatch: checkDispatch(),
    executionProfile: checkProfile(),
    storyDirectory: symlinkStory,
    runProcess: async () => ({ exitCode: 0, timedOut: false, stdout: "must not escape", stderr: "" }),
  });
  const result = await harness.recorder.runLocalCheck({
    rootId: "main",
    checkId: "check-main",
    absoluteRoot: projectRoot,
  });
  assert.equal(result.status, "BLOCKED");
  assert.deepEqual(fs.readdirSync(outside), []);
  assert.equal(harness.receipts[0].payload.outputRef, undefined);
  assert.equal(harness.receipts[0].payload.sha256, undefined);
});

test("pre-created controlled-operation journal symlink is rejected before the external action", async () => {
  const symlinkStory = path.join(tempRoot, `journal-symlink-${++receiptHarnessSequence}`);
  const workflowDirectory = path.join(symlinkStory, "workflow-v2");
  const outside = path.join(tempRoot, `outside-journal-${receiptHarnessSequence}`);
  fs.mkdirSync(workflowDirectory, { recursive: true });
  fs.mkdirSync(outside, { recursive: true });
  fs.symlinkSync(outside, path.join(workflowDirectory, "controlled-operations"), process.platform === "win32" ? "junction" : "dir");
  let executions = 0;
  const harness = receiptHarness({
    dispatch: checkDispatch(),
    executionProfile: checkProfile(),
    storyDirectory: symlinkStory,
    runProcess: async () => {
      executions += 1;
      return { exitCode: 0, timedOut: false, stdout: "must not run", stderr: "" };
    },
  });
  await assert.rejects(
    harness.recorder.runLocalCheck({ rootId: "main", checkId: "check-main", absoluteRoot: projectRoot }),
    (error) => error.code === "WORKFLOW_V2_RECEIPT_OUTPUT_PATH_BOUNDARY_REJECTED",
  );
  assert.equal(executions, 0);
  assert.deepEqual(fs.readdirSync(outside), []);
  assert.equal(harness.receipts.length, 0);
});

test("missing profile fails closed before a runner can execute", async () => {
  let executed = false;
  const harness = receiptHarness({
    dispatch: checkDispatch(),
    executionProfile: null,
    runProcess: async () => { executed = true; return { exitCode: 0 }; },
  });
  await assert.rejects(
    harness.recorder.runLocalCheck({ rootId: "main", checkId: "check-main", absoluteRoot: projectRoot }),
    (error) => error instanceof WorkflowV2ReceiptProducerError
      && error.code === "WORKFLOW_V2_RECEIPT_EXECUTION_PROFILE_MISSING",
  );
  assert.equal(executed, false);
  assert.equal(harness.receipts.length, 0);
});

after(() => {
  fs.rmSync(tempRoot, { recursive: true, force: true });
});
