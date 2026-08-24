import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, test } from "node:test";

import {
  WorkflowV2RepairCommitSettlementError,
  completeStructuredRepairRecovery,
  createFileRepairRecoveryStore,
  resumePendingStructuredRepairRecovery,
  settleStructuredRepairCommit,
} from "../services/devbench/workflow-v2/repair-commit-settlement.js";
import { canonicalSha256 } from "../services/devbench/workflow-v2/envelope-store.js";
import { WORKFLOW_V2_SCHEMA_IDS } from "../services/devbench/workflow-v2/schema-registry.js";
import { deriveWorkflowV2EditState } from "../services/devbench/workflow-v2/edit-state-binding.js";

const STORY_ID = "story-m8-repair";
const CONTEXT_ID = "context-m8-repair";
const CONTEXT_REVISION = 7;
const CONTEXT_KEY = "repair-context-idempotency";
const BEFORE_SHA = "1".repeat(40);
const COMMIT_SHA = "2".repeat(40);
const OUTPUT_SHA = "3".repeat(64);

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function createMemoryRecoveryStore() {
  const records = new Map();
  const steps = new Map();
  const locks = new Map();
  return {
    records,
    steps,
    async withLock({ lockKey }, operation) {
      const previous = locks.get(lockKey) || Promise.resolve();
      let release;
      const current = new Promise((resolve) => { release = resolve; });
      const queued = previous.then(() => current);
      locks.set(lockKey, queued);
      await previous;
      try { return await operation(); }
      finally {
        release();
        if (locks.get(lockKey) === queued) locks.delete(lockKey);
      }
    },
    async prepare({ record }) {
      const existing = records.get(record.recoveryKey);
      if (existing) {
        if (canonicalSha256(existing) !== canonicalSha256(record)) {
          throw new WorkflowV2RepairCommitSettlementError(
            "recovery conflict",
            "WORKFLOW_V2_REPAIR_RECOVERY_IDEMPOTENCY_CONFLICT",
          );
        }
        return { value: clone(existing), replayed: true };
      }
      records.set(record.recoveryKey, clone(record));
      return { value: clone(record), replayed: false };
    },
    async list() {
      return [...records.values()].map(clone);
    },
    async readSteps({ recovery }) {
      return clone(steps.get(recovery.operationId) || {});
    },
    async markStep({ recovery, step, value = null }) {
      const current = steps.get(recovery.operationId) || {};
      const existing = current[step];
      const next = {
        schemaVersion: "test-recovery-step-v1",
        storyId: recovery.storyId,
        operationId: recovery.operationId,
        step,
        value: clone(value),
      };
      if (existing && canonicalSha256(existing.value) !== canonicalSha256(next.value)) {
        throw new WorkflowV2RepairCommitSettlementError(
          "step conflict",
          "WORKFLOW_V2_REPAIR_RECOVERY_IDEMPOTENCY_CONFLICT",
        );
      }
      current[step] ||= next;
      steps.set(recovery.operationId, current);
      return { value: clone(current[step]), replayed: !!existing };
    },
  };
}

function createTestStoryStorage(root) {
  fs.mkdirSync(root, { recursive: true });
  return {
    getStoryStoragePaths() {
      return { storyDirectory: root };
    },
    validateStoryStorageTarget(_tab, targetPath, {
      baseDirectory = root,
      createDirectory = false,
      mustExist = false,
      expectedType = "",
    } = {}) {
      const base = path.resolve(baseDirectory);
      const target = path.resolve(targetPath);
      const relative = path.relative(base, target);
      if (relative.startsWith("..") || path.isAbsolute(relative)) {
        throw Object.assign(new Error("outside test story root"), { code: "STORY_STORAGE_PATH_INVALID" });
      }
      if (createDirectory && !fs.existsSync(target)) fs.mkdirSync(target);
      if (mustExist && !fs.existsSync(target)) {
        throw Object.assign(new Error("missing test story path"), { code: "STORY_STORAGE_PATH_MISSING" });
      }
      if (fs.existsSync(target)) {
        const stat = fs.lstatSync(target);
        if (stat.isSymbolicLink()
          || (expectedType === "directory" && !stat.isDirectory())
          || (expectedType === "file" && !stat.isFile())) {
          throw Object.assign(new Error("invalid test story path type"), { code: "STORY_STORAGE_PATH_INVALID" });
        }
      }
      return target;
    },
  };
}
const EDIT_BEFORE_SHA = "4".repeat(64);
const EDIT_AFTER_SHA = "5".repeat(64);

function baseTab(overrides = {}) {
  return {
    id: STORY_ID,
    worktree: {
      managed: true,
      entries: [{
        role: "primary",
        repositoryId: "repo-main",
        baseProjectId: "repo-main",
        path: "D:/story/main",
        branch: "story/m8-repair",
        revision: BEFORE_SHA,
      }],
    },
    workflowV2Compatibility: { sourceCursor: { revision: 1 } },
    ...overrides,
  };
}

function root(overrides = {}) {
  return {
    rootId: "main",
    kind: "MAIN",
    repositoryId: "repo-main",
    branch: "story/m8-repair",
    headSha: BEFORE_SHA,
    flavor: "prod",
    writable: true,
    ...overrides,
  };
}

function baseDispatch({ roots = [root()], checks, executors } = {}) {
  const localChecks = checks || [{
    checkId: "check-test",
    name: "unit test",
    executorId: "executor-test",
    action: "TEST",
    mandatory: true,
    rootId: "main",
  }];
  const profileExecutors = executors || [{
    executorId: "executor-test",
    action: "TEST",
    cwdRootId: "main",
    argv: ["npm", "test"],
  }];
  const context = {
    contextId: CONTEXT_ID,
    revision: CONTEXT_REVISION,
    idempotencyKey: CONTEXT_KEY,
    story: { storyId: STORY_ID },
    stage: { id: "REPAIR" },
    scope: { roots },
    data: { localChecks },
  };
  return {
    stageId: "REPAIR",
    resultSchemaId: "https://example.local/schemas/repair-result-v2.json",
    contextId: CONTEXT_ID,
    contextRevision: CONTEXT_REVISION,
    context,
    executionStatus: { status: "READY", profileId: "profile-repair", blockers: [] },
    executionProfile: {
      profileId: "profile-repair",
      stageId: "REPAIR",
      rootId: "main",
      executors: profileExecutors,
    },
  };
}

function repairResult({ changes, localChecks, ...overrides } = {}) {
  return {
    schemaVersion: "repair-result-v2",
    contextId: CONTEXT_ID,
    contextRevision: CONTEXT_REVISION,
    idempotencyKey: CONTEXT_KEY,
    status: "COMPLETED",
    outcome: "FIXED",
    nextStage: "LOCAL_GATE",
    changeSummary: "修复边界判断",
    changes: changes || [{
      rootId: "main",
      path: "src/fix.js",
      summary: "补充边界判断",
      receiptIds: ["model-edit-receipt-is-not-authority"],
    }],
    localChecks: localChecks || [{
      name: "unit test",
      status: "PASS",
      receiptIds: ["model-check-receipt-is-not-authority"],
    }],
    ...overrides,
  };
}

function gate(result = repairResult()) {
  return { ok: true, result, legacyEvent: { kind: "fix_done" } };
}

function receiptPayload({
  receiptId = "receipt-system-test",
  action = "TEST",
  rootId = "main",
  checkId = "check-test",
  executorId = "executor-test",
  selector = {},
} = {}) {
  return {
    schemaVersion: "evidence-receipt-v2",
    receiptId,
    action,
    status: "PASS",
    startedAt: "2026-08-08T01:00:00.000Z",
    finishedAt: "2026-08-08T01:00:01.000Z",
    toolName: "run_local_check",
    rootId,
    selector: {
      contextId: CONTEXT_ID,
      contextRevision: CONTEXT_REVISION,
      checkId,
      executorId,
      ...selector,
    },
    operationId: `operation-${receiptId}`,
    idempotencyKey: `idempotency-${receiptId}`,
    exitCode: 0,
    outputRef: `storydev:/workflow-v2/receipt-output/${OUTPUT_SHA}.txt`,
    sha256: OUTPUT_SHA,
    summary: `${action} PASS`,
    error: null,
  };
}

function editReceiptPayload() {
  return {
    ...receiptPayload({
      receiptId: "receipt-system-edit",
      action: "EDIT",
      selector: {
        path: "src/fix.js",
        beforeExists: true,
        afterExists: true,
        beforeSha256: EDIT_BEFORE_SHA,
        afterSha256: EDIT_AFTER_SHA,
      },
    }),
    toolName: "edit_file",
    operationId: "operation-receipt-system-edit",
    idempotencyKey: "idempotency-receipt-system-edit",
    outputRef: null,
    sha256: EDIT_AFTER_SHA,
    exitCode: null,
  };
}

function receiptEnvelopes(payloads = [receiptPayload()]) {
  let previousEnvelopeSha256 = null;
  return payloads.map((payload, index) => {
    const unsigned = {
      schemaVersion: "workflow-envelope-v2",
      storyId: STORY_ID,
      recordId: payload.receiptId,
      contextId: null,
      revision: index + 1,
      idempotencyKey: payload.idempotencyKey || `envelope-${payload.receiptId}`,
      payloadSchemaId: WORKFLOW_V2_SCHEMA_IDS.evidenceReceipt,
      payloadSha256: canonicalSha256(payload),
      operationArgsSha256: canonicalSha256({ receiptId: payload.receiptId }),
      previousEnvelopeSha256,
      createdAt: "2026-08-08T01:00:02.000Z",
      payload,
    };
    const envelope = { ...unsigned, envelopeSha256: canonicalSha256(unsigned) };
    previousEnvelopeSha256 = envelope.envelopeSha256;
    return envelope;
  });
}

function boundReceiptEnvelopes(prefix = [], { includeCheck = true } = {}) {
  const edit = editReceiptPayload();
  const editEnvelopes = receiptEnvelopes([...prefix, edit]);
  if (!includeCheck) return editEnvelopes;
  const state = deriveWorkflowV2EditState({
    envelopes: editEnvelopes,
    storyId: STORY_ID,
    contextId: CONTEXT_ID,
    contextRevision: CONTEXT_REVISION,
    rootId: "main",
    requireChanges: true,
  });
  const check = receiptPayload({
    selector: {
      editStateSha256: state.editStateSha256,
      editStateVersionSha256: state.editStateVersionSha256,
    },
  });
  return receiptEnvelopes([...prefix, edit, check]);
}

function successControllerResult(request, overrides = {}) {
  return {
    ok: true,
    resultCode: "PASS",
    operationId: request.operationId,
    controllerOperationId: "controller-op-1",
    replayed: false,
    recovered: false,
    repositoryId: request.repositoryId,
    tabId: request.tabId,
    branch: request.expectedBranch,
    beforeSha: request.expectedHead,
    commitSha: COMMIT_SHA,
    message: "fix(prod): 修复边界判断",
    changedPaths: [...request.declaredChanges],
    targetFlavor: request.targetFlavor,
    requiredCheckReceiptIds: [...request.requiredCheckReceiptIds],
    dirtyAfterCommit: [],
    flavorWarnings: [],
    ...overrides,
  };
}

function harness({
  tab = baseTab(),
  dispatch = baseDispatch(),
  result = repairResult(),
  envelopes,
  recoveryStore = createMemoryRecoveryStore(),
} = {}) {
  let currentTab = tab;
  const calls = { commit: [], update: [], output: [] };
  const runtime = {
    storyRepositories: {
      async commit(request) {
        calls.commit.push(request);
        return successControllerResult(request);
      },
    },
  };
  const dependencies = {
    tab: currentTab,
    dispatch,
    structuredGateResult: gate(result),
    readEnvelopes: async () => envelopes || boundReceiptEnvelopes(),
    verifyReceiptOutput: async ({ receipt }) => {
      calls.output.push(receipt.receiptId);
      return { valid: true, reason: null };
    },
    verifyEditStateFiles: ({ state, expectedPaths }) => {
      assert.deepEqual(state.files.map((entry) => entry.path), expectedPaths);
      return { ok: true };
    },
    runtime,
    recoveryStore,
    updateTab: async (tabId, updates) => {
      calls.update.push({ tabId, updates });
      currentTab = { ...currentTab, ...updates };
      return currentTab;
    },
    getTab: () => currentTab,
    now: () => "2026-08-08T02:00:00.000Z",
  };
  return {
    calls,
    dependencies,
    runtime,
    recoveryStore,
    get currentTab() { return currentTab; },
  };
}

function isSettlementError(code) {
  return (error) => error instanceof WorkflowV2RepairCommitSettlementError && error.code === code;
}

describe("structured REPAIR authoritative Git settlement", () => {
  test("success uses only frozen metadata and persisted mandatory receipt identities", async () => {
    const unrelatedRead = {
      ...receiptPayload({ receiptId: "receipt-unrelated-read" }),
      action: "READ",
      operationId: "read-operation",
      idempotencyKey: null,
      rootId: "main",
      selector: { contextId: "older-context", contextRevision: 1, path: "README.md" },
      outputRef: null,
      sha256: null,
    };
    const h = harness({ envelopes: boundReceiptEnvelopes([unrelatedRead]) });
    const settled = await settleStructuredRepairCommit(h.dependencies);

    assert.equal(settled.ok, true);
    assert.equal(settled.status, "COMMITTED");
    assert.equal(settled.commitSha, COMMIT_SHA);
    assert.equal(h.calls.commit.length, 1);
    assert.deepEqual(h.calls.commit[0], {
      tabId: STORY_ID,
      repositoryId: "repo-main",
      operationId: settled.operationId,
      expectedHead: BEFORE_SHA,
      expectedBranch: "story/m8-repair",
      targetFlavor: "prod",
      changeSummary: "修复边界判断",
      declaredChanges: ["src/fix.js"],
      requiredCheckReceiptIds: ["receipt-system-test"],
    });
    assert.match(settled.operationId, /^workflow-v2-repair-commit:[a-f0-9]{64}$/);
    assert.deepEqual(h.calls.output, ["receipt-system-test"]);
    assert.equal(h.calls.update.length, 2);
    assert.equal(h.currentTab.worktree.entries[0].head, COMMIT_SHA);
    assert.equal(h.currentTab.worktree.entries[0].revision, COMMIT_SHA);
    assert.equal(h.currentTab.workflowV2Compatibility.sourceCursor.revision, 1);
    assert.equal(h.currentTab.workflowV2Compatibility.gitSettlement.resultSha256, canonicalSha256(h.dependencies.structuredGateResult.result));
    assert.deepEqual(
      h.currentTab.workflowV2Compatibility.gitSettlement.requiredCheckReceiptIds,
      ["receipt-system-test"],
    );
  });

  test("same binding replays persisted settlement without a second Controller commit", async () => {
    const h = harness();
    const first = await settleStructuredRepairCommit(h.dependencies);
    const replay = await settleStructuredRepairCommit({ ...h.dependencies, tab: h.currentTab });

    assert.equal(replay.ok, true);
    assert.equal(replay.replayed, true);
    assert.equal(replay.commitSha, first.commitSha);
    assert.equal(replay.operationId, first.operationId);
    assert.equal(h.calls.commit.length, 1);
    assert.equal(h.calls.update.length, 2);
  });

  test("missing frozen root metadata fails before receipt read and commit", async () => {
    const h = harness({ dispatch: baseDispatch({ roots: [root({ headSha: null })] }) });
    let reads = 0;
    h.dependencies.readEnvelopes = async () => { reads += 1; return receiptEnvelopes(); };

    await assert.rejects(
      settleStructuredRepairCommit(h.dependencies),
      isSettlementError("WORKFLOW_V2_GIT_SETTLEMENT_ROOT_METADATA_MISSING"),
    );
    assert.equal(reads, 0);
    assert.equal(h.calls.commit.length, 0);
    assert.equal(h.calls.update.length, 0);
  });

  test("multiple changed repositories fail closed before any commit", async () => {
    const dispatch = baseDispatch({
      roots: [root(), root({
        rootId: "sdk",
        kind: "SDK",
        repositoryId: "repo-sdk",
        branch: "story/m8-sdk",
        headSha: "4".repeat(40),
      })],
    });
    const result = repairResult({
      changes: [
        { rootId: "main", path: "src/fix.js", summary: "修复主工程", receiptIds: ["model-edit-main"] },
        { rootId: "sdk", path: "src/sdk.js", summary: "修复 SDK", receiptIds: ["model-edit-sdk"] },
      ],
    });
    const h = harness({ dispatch, result });

    await assert.rejects(
      settleStructuredRepairCommit(h.dependencies),
      isSettlementError("WORKFLOW_V2_GIT_MULTI_ROOT_ATOMIC_COMMIT_UNSUPPORTED"),
    );
    assert.equal(h.calls.commit.length, 0);
    assert.equal(h.calls.update.length, 0);
  });

  test("missing mandatory BUILD/TEST receipt cannot authorize a commit", async () => {
    const h = harness({ envelopes: boundReceiptEnvelopes([], { includeCheck: false }) });
    await assert.rejects(
      settleStructuredRepairCommit(h.dependencies),
      isSettlementError("WORKFLOW_V2_GIT_SETTLEMENT_MANDATORY_CHECK_RECEIPT_MISSING"),
    );
    assert.equal(h.calls.commit.length, 0);
    assert.equal(h.calls.update.length, 0);
  });

  test("再次 EDIT 后旧 mandatory check digest 不得授权提交", async () => {
    const original = boundReceiptEnvelopes().map((entry) => structuredClone(entry.payload));
    const secondEdit = {
      ...editReceiptPayload(),
      receiptId: "receipt-system-edit-second",
      operationId: "operation-receipt-system-edit-second",
      idempotencyKey: "idempotency-receipt-system-edit-second",
      selector: {
        ...editReceiptPayload().selector,
        beforeSha256: EDIT_AFTER_SHA,
        afterSha256: "6".repeat(64),
      },
      sha256: "6".repeat(64),
    };
    const h = harness({ envelopes: receiptEnvelopes([...original, secondEdit]) });

    await assert.rejects(
      settleStructuredRepairCommit(h.dependencies),
      isSettlementError("WORKFLOW_V2_GIT_SETTLEMENT_MANDATORY_CHECK_RECEIPT_MISSING"),
    );
    assert.equal(h.calls.commit.length, 0);
    assert.equal(h.calls.update.length, 0);
  });

  test("settlement 在 Controller 前回读最终文件/删除状态，字节漂移即 fail closed", async () => {
    const h = harness();
    let verified = 0;
    h.dependencies.verifyEditStateFiles = () => {
      verified += 1;
      throw Object.assign(new Error("final bytes drifted"), { code: "WORKFLOW_V2_EDIT_STATE_FILE_MISMATCH" });
    };

    await assert.rejects(
      settleStructuredRepairCommit(h.dependencies),
      (error) => isSettlementError("WORKFLOW_V2_GIT_SETTLEMENT_EDIT_STATE_INVALID")(error)
        && error.details.causeCode === "WORKFLOW_V2_EDIT_STATE_FILE_MISMATCH",
    );
    assert.equal(verified, 1);
    assert.equal(h.calls.commit.length, 0);
    assert.equal(h.calls.update.length, 0);
  });

  test("tampered envelope and unreadable controlled output both fail before commit", async (t) => {
    await t.test("tampered envelope hash", async () => {
      const envelopes = receiptEnvelopes();
      envelopes[0].payload.summary = "tampered";
      const h = harness({ envelopes });
      await assert.rejects(
        settleStructuredRepairCommit(h.dependencies),
        isSettlementError("WORKFLOW_V2_GIT_SETTLEMENT_RECEIPT_ENVELOPE_INVALID"),
      );
      assert.equal(h.calls.commit.length, 0);
    });

    await t.test("controlled output verification failure", async () => {
      const h = harness();
      h.dependencies.verifyReceiptOutput = async () => ({ valid: false, reason: "artifact hash mismatch" });
      await assert.rejects(
        settleStructuredRepairCommit(h.dependencies),
        isSettlementError("WORKFLOW_V2_GIT_SETTLEMENT_RECEIPT_OUTPUT_INVALID"),
      );
      assert.equal(h.calls.commit.length, 0);
    });
  });

  test("Controller failure does not persist a success settlement", async () => {
    const h = harness();
    h.runtime.storyRepositories.commit = async (request) => {
      h.calls.commit.push(request);
      const error = new Error("head changed");
      error.code = "STORY_REPOSITORY_COMMIT_HEAD_MISMATCH";
      throw error;
    };

    await assert.rejects(
      settleStructuredRepairCommit(h.dependencies),
      (error) => isSettlementError("WORKFLOW_V2_GIT_SETTLEMENT_CONTROLLER_FAILED")(error)
        && error.details.causeCode === "STORY_REPOSITORY_COMMIT_HEAD_MISMATCH",
    );
    assert.equal(h.calls.commit.length, 1);
    assert.equal(h.calls.update.length, 1);
    assert.equal(h.currentTab.workflowV2Compatibility.gitSettlement, undefined);
    assert.equal(h.currentTab.workflowV2Compatibility.repairRecovery.status, "pending");
    assert.equal(h.currentTab.worktree.entries[0].revision, BEFORE_SHA);
  });

  test("Controller attestation mismatch is rejected without persisting success", async () => {
    const h = harness();
    h.runtime.storyRepositories.commit = async (request) => {
      h.calls.commit.push(request);
      return successControllerResult(request, { changedPaths: ["src/undeclared.js"] });
    };

    await assert.rejects(
      settleStructuredRepairCommit(h.dependencies),
      isSettlementError("WORKFLOW_V2_GIT_SETTLEMENT_CONTROLLER_RESULT_INVALID"),
    );
    assert.equal(h.calls.update.length, 1);
    assert.equal(h.currentTab.workflowV2Compatibility.gitSettlement, undefined);
  });
});

function recoveryHarness() {
  const h = harness();
  const controllerResults = new Map();
  const calls = {
    provider: 0,
    controller: 0,
    actualCommit: 0,
    stageResult: 0,
    compatibilityResult: 0,
    applyWorkflow: 0,
  };
  h.runtime.storyRepositories.commit = async (request) => {
    calls.controller += 1;
    const existing = controllerResults.get(request.operationId);
    if (existing) return { ...clone(existing), replayed: true, recovered: true };
    calls.actualCommit += 1;
    const result = successControllerResult(request);
    controllerResults.set(request.operationId, clone(result));
    return result;
  };
  const completed = {
    stageResult: new Set(),
    compatibilityResult: new Set(),
    workflow: new Set(),
  };
  const dependencies = {
    recoveryStore: h.recoveryStore,
    commitDependencies: {
      readEnvelopes: h.dependencies.readEnvelopes,
      verifyReceiptOutput: h.dependencies.verifyReceiptOutput,
      verifyEditStateFiles: h.dependencies.verifyEditStateFiles,
      runtime: h.runtime,
    },
    recordStructuredResult: async ({ result }) => {
      calls.stageResult += 1;
      const key = canonicalSha256(result);
      const replayed = completed.stageResult.has(key);
      completed.stageResult.add(key);
      return { replayed };
    },
    recordCompatibilityResult: async ({ dispatch }) => {
      calls.compatibilityResult += 1;
      const key = dispatch.taskId;
      const replayed = completed.compatibilityResult.has(key);
      completed.compatibilityResult.add(key);
      return { replayed, checkpoint: { revision: 2 } };
    },
    applyWorkflow: async (_tab, _event, observation) => {
      calls.applyWorkflow += 1;
      const replayed = completed.workflow.has(observation.recoveryOperationId);
      completed.workflow.add(observation.recoveryOperationId);
      return { phase: "verifying", replayed };
    },
    updateTab: h.dependencies.updateTab,
    getTab: h.dependencies.getTab,
    now: h.dependencies.now,
  };
  return { h, calls, dependencies };
}

async function startRecoverableRepair(r, overrides = {}) {
  return completeStructuredRepairRecovery({
    tab: r.h.currentTab,
    dispatch: r.h.dependencies.dispatch,
    structuredGateResult: r.h.dependencies.structuredGateResult,
    recoveryContext: {
      workflowEvent: {
        kind: "fix_done",
        cleaned: "修复完成",
        shortReport: "原因：边界错误；措施：补充校验",
        detailReport: "结构化修复详情",
      },
      report: "修复完成",
      markerKind: "fix_done",
      taskId: "task-recovery",
      attemptId: "attempt-recovery",
      workflowKind: "fix",
      stage: "REPAIR",
    },
    ...r.dependencies,
    ...overrides,
  });
}

async function resumeRecoverableRepair(r, overrides = {}) {
  return resumePendingStructuredRepairRecovery({
    tab: r.h.currentTab,
    ...r.dependencies,
    ...overrides,
  });
}

describe("structured REPAIR durable recovery/outbox", () => {
  for (const crashStep of [
    "gitCommitted",
    "stageResultRecorded",
    "compatibilityRecorded",
    "workflowApplied",
  ]) {
    test(`restart resumes after durable ${crashStep} boundary without Provider or another commit`, async () => {
      const r = recoveryHarness();
      await assert.rejects(
        startRecoverableRepair(r, {
          afterStep: async (step) => {
            if (step === crashStep) throw Object.assign(new Error(`crash after ${step}`), { code: "TEST_CRASH" });
          },
        }),
        (error) => error?.code === "TEST_CRASH",
      );

      const resumed = await resumeRecoverableRepair(r);
      assert.equal(resumed.ok, true);
      assert.equal(resumed.status, "SETTLED");
      assert.equal(r.calls.provider, 0);
      assert.equal(r.calls.actualCommit, 1);
      assert.equal(r.calls.stageResult, 1);
      assert.equal(r.calls.compatibilityResult, 1);
      assert.equal(r.calls.applyWorkflow, 1);
      assert.equal(r.h.currentTab.workflowV2Compatibility.repairRecovery, null);
      assert.equal(r.h.currentTab.workflowV2Compatibility.settlement.status, "settled");
    });
  }

  test("commit success followed by Git settlement persistence failure is recovered by Controller replay", async () => {
    const r = recoveryHarness();
    const stableUpdate = r.dependencies.updateTab;
    let updateAttempt = 0;
    r.dependencies.updateTab = async (...args) => {
      updateAttempt += 1;
      if (updateAttempt === 2) throw Object.assign(new Error("database unavailable after commit"), { code: "DB_DOWN" });
      return stableUpdate(...args);
    };

    await assert.rejects(
      startRecoverableRepair(r),
      isSettlementError("WORKFLOW_V2_GIT_SETTLEMENT_PERSIST_FAILED"),
    );
    assert.equal(r.calls.actualCommit, 1);
    assert.equal(r.calls.controller, 1);
    assert.equal(r.h.currentTab.workflowV2Compatibility.gitSettlement, undefined);

    r.dependencies.updateTab = stableUpdate;
    const resumed = await resumeRecoverableRepair(r);
    assert.equal(resumed.status, "SETTLED");
    assert.equal(r.calls.provider, 0);
    assert.equal(r.calls.controller, 2);
    assert.equal(r.calls.actualCommit, 1);
    assert.equal(resumed.commitSha, COMMIT_SHA);
  });

  test("final tab persistence failure resumes from workflowApplied without reapplying workflow", async () => {
    const r = recoveryHarness();
    const stableUpdate = r.dependencies.updateTab;
    let updateAttempt = 0;
    r.dependencies.updateTab = async (...args) => {
      updateAttempt += 1;
      if (updateAttempt === 3) throw Object.assign(new Error("final tab write failed"), { code: "DB_DOWN" });
      return stableUpdate(...args);
    };

    await assert.rejects(
      startRecoverableRepair(r),
      isSettlementError("WORKFLOW_V2_REPAIR_RECOVERY_FINAL_PERSIST_FAILED"),
    );
    assert.equal(r.calls.applyWorkflow, 1);
    r.dependencies.updateTab = stableUpdate;

    const resumed = await resumeRecoverableRepair(r);
    assert.equal(resumed.status, "SETTLED");
    assert.equal(r.calls.applyWorkflow, 1);
    assert.equal(r.calls.actualCommit, 1);
    assert.equal(r.calls.provider, 0);
  });

  test("same story/context recovery key rejects a different safe payload before Controller", async () => {
    const r = recoveryHarness();
    r.h.runtime.storyRepositories.commit = async (request) => {
      r.calls.controller += 1;
      throw Object.assign(new Error(`stop ${request.operationId}`), { code: "CONTROLLER_STOP" });
    };
    await assert.rejects(
      startRecoverableRepair(r),
      isSettlementError("WORKFLOW_V2_GIT_SETTLEMENT_CONTROLLER_FAILED"),
    );
    assert.equal(r.calls.controller, 1);

    await assert.rejects(
      startRecoverableRepair(r, {
        recoveryContext: {
          workflowEvent: { kind: "fix_done", cleaned: "different recovery payload" },
          report: "different recovery payload",
          markerKind: "fix_done",
          taskId: "task-recovery",
          attemptId: "attempt-recovery",
          workflowKind: "fix",
          stage: "REPAIR",
        },
      }),
      isSettlementError("WORKFLOW_V2_REPAIR_RECOVERY_IDEMPOTENCY_CONFLICT"),
    );
    assert.equal(r.calls.controller, 1);
  });

  test("two Gateway recovery attempts serialize on the durable recovery key", async () => {
    const r = recoveryHarness();
    const [left, right] = await Promise.all([
      startRecoverableRepair(r),
      startRecoverableRepair(r),
    ]);
    assert.equal(left.status, "SETTLED");
    assert.equal(right.status, "SETTLED");
    assert.equal(left.operationId, right.operationId);
    assert.equal(r.calls.actualCommit, 1);
    assert.equal(r.calls.stageResult, 1);
    assert.equal(r.calls.compatibilityResult, 1);
    assert.equal(r.calls.applyWorkflow, 1);
    assert.equal(r.calls.provider, 0);
  });

  test("filesystem outbox survives a fresh recovery-store instance and resumes locally", async () => {
    const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "workflow-v2-repair-recovery-"));
    try {
      const storageApi = createTestStoryStorage(temporaryRoot);
      const r = recoveryHarness();
      r.dependencies.recoveryStore = createFileRepairRecoveryStore({ storageApi });
      await assert.rejects(
        startRecoverableRepair(r, {
          afterStep: async (step) => {
            if (step === "compatibilityRecorded") {
              throw Object.assign(new Error("simulated Gateway exit"), { code: "TEST_CRASH" });
            }
          },
        }),
        (error) => error?.code === "TEST_CRASH",
      );

      const restartedStore = createFileRepairRecoveryStore({ storageApi });
      const resumed = await resumeRecoverableRepair(r, { recoveryStore: restartedStore });
      assert.equal(resumed.status, "SETTLED");
      assert.equal(r.calls.actualCommit, 1);
      assert.equal(r.calls.applyWorkflow, 1);
      assert.equal(r.calls.provider, 0);
      assert.equal(
        fs.existsSync(path.join(temporaryRoot, "workflow-v2", "repair-recovery", "outbox")),
        true,
      );
    } finally {
      fs.rmSync(temporaryRoot, { recursive: true, force: true });
    }
  });

  test("stale-lock barrier replacement never deletes the new live lock or enters concurrently", async () => {
    const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "workflow-v2-repair-lock-race-"));
    try {
      const storageApi = createTestStoryStorage(temporaryRoot);
      const locksDirectory = path.join(temporaryRoot, "workflow-v2", "repair-recovery", "locks");
      fs.mkdirSync(locksDirectory, { recursive: true });
      const lockKey = "a".repeat(64);
      const lockPath = path.join(locksDirectory, `${lockKey}.lock`);
      const staleOwner = {
        schemaVersion: "workflow-v2-repair-recovery-lock-v1",
        host: os.hostname(),
        pid: 123456789,
        token: "stale-token",
        lockKey,
        acquiredAt: "2026-08-08T00:00:00.000Z",
      };
      const liveOwner = {
        ...staleOwner,
        pid: process.pid,
        token: "new-live-token",
        acquiredAt: "2026-08-08T00:00:01.000Z",
      };
      fs.writeFileSync(lockPath, JSON.stringify(staleOwner), { flag: "wx" });
      let barrierRuns = 0;
      let entered = 0;
      const recoveryStore = createFileRepairRecoveryStore({
        storageApi,
        lockTimeoutMs: 80,
        lockPollMs: 2,
        isLocalProcessAlive: (pid) => pid === process.pid,
        onStaleLockObserved: async ({ lockPath: observedPath }) => {
          barrierRuns += 1;
          assert.equal(observedPath, lockPath);
          fs.unlinkSync(lockPath);
          fs.writeFileSync(lockPath, JSON.stringify(liveOwner), { flag: "wx" });
        },
      });

      await assert.rejects(
        recoveryStore.withLock({ tab: baseTab(), lockKey }, async () => { entered += 1; }),
        isSettlementError("WORKFLOW_V2_REPAIR_RECOVERY_LOCKED"),
      );
      assert.equal(barrierRuns, 1);
      assert.equal(entered, 0);
      assert.equal(JSON.parse(fs.readFileSync(lockPath, "utf8")).token, "new-live-token");
      assert.equal(fs.existsSync(path.join(locksDirectory, `${lockKey}.stale-claim`)), false);
    } finally {
      fs.rmSync(temporaryRoot, { recursive: true, force: true });
    }
  });

  test("outbox snapshots only the safe dispatch subset and never stores Provider prompt", async () => {
    const r = recoveryHarness();
    r.h.dependencies.dispatch.prompt = "TOP-SECRET-PROVIDER-PROMPT";
    r.h.dependencies.dispatch.context.data.taskInstruction = "TOP-SECRET-TASK-INSTRUCTION";
    const settled = await startRecoverableRepair(r);
    const record = r.h.recoveryStore.records.get(settled.recovery.recoveryKey);
    const stored = JSON.stringify(record);
    assert.doesNotMatch(stored, /TOP-SECRET|taskInstruction|\"prompt\"/);
    assert.equal(record.dispatch.context.scope.roots[0].repositoryId, "repo-main");
    assert.equal(record.structuredGateResult.result.outcome, "FIXED");
  });
});
