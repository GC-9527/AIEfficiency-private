import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  assertWorkflowV2CompatibilityDispatch,
  buildLegacyCheckpoint,
  buildLegacyEvidenceManifest,
  prepareWorkflowV2CompatibilityDispatch,
  recordWorkflowV2CompatibilityResult,
} from "../services/devbench/workflow-v2/compatibility-dispatch.js";
import {
  canonicalJson,
  canonicalSha256,
} from "../services/devbench/workflow-v2/envelope-store.js";
import { WORKFLOW_V2_SCHEMA_IDS } from "../services/devbench/workflow-v2/schema-registry.js";

function tabFixture() {
  return {
    id: "story-m3-dispatch",
    title: "兼容派发测试",
    primaryProjectId: "project-main",
    deviceSerial: "SECRET-DEVICE-SERIAL",
    workflow: { phase: "triaging", riskLevel: "MEDIUM" },
    tbContext: {
      tbTaskId: "tb-task-1",
      title: "TB 标题",
      description: "TB 描述",
      comments: [
        { id: "comment-2", text: "最新评论", updatedAt: "2026-08-07T02:00:00.000Z" },
        { id: "comment-1", text: "较早评论", updatedAt: "2026-08-07T01:00:00.000Z" },
      ],
      sourceCoverage: {
        comments: { available: true, complete: true },
        attachments: { available: true, complete: true },
      },
      attachments: [],
    },
    materials: [],
  };
}

function rolloutConfig() {
  return {
    workflowV2: {
      featureFlags: { promptV2: true },
      promptV2Rollout: { percentage: 100, salt: "m3-dispatch", storyIds: [], providers: [] },
    },
  };
}

function createHarness(tab) {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "workflow-v2-m3-dispatch-"));
  fs.mkdirSync(path.join(tempRoot, "ABSOLUTE_PROJECT_SECRET"), { recursive: true });
  const streams = new Map(Object.values(WORKFLOW_V2_SCHEMA_IDS).map((id) => [id, []]));
  let observedBaseSchemaVersion;
  const storageApi = {
    getTab: () => tab,
    updateTab: (_storyId, patch) => Object.assign(tab, structuredClone(patch)),
    tabProjectPaths: () => [{
      role: "primary",
      projectId: "project-main",
      path: path.join(tempRoot, "ABSOLUTE_PROJECT_SECRET"),
      branch: "feature/m3",
    }],
    getStoryStoragePaths: () => ({
      storyDirectory: tempRoot,
      attachmentDirectory: path.join(tempRoot, "archives"),
    }),
    validateStoryStorageTarget: () => true,
  };
  const fsApi = {
    existsSync: () => false,
    statSync: () => { throw Object.assign(new Error("missing"), { code: "ENOENT" }); },
  };
  function makeEnvelope(payloadSchemaId, payload, idempotencyKey, revision) {
    const contextId = payloadSchemaId === WORKFLOW_V2_SCHEMA_IDS.stageContext ? payload.contextId : null;
    const payloadSha256 = canonicalSha256(payload);
    const envelope = {
      schemaVersion: "workflow-envelope-v2",
      storyId: tab.id,
      recordId: contextId || `${payloadSchemaId.split("/").at(-1)}:${revision}`,
      contextId,
      revision,
      idempotencyKey,
      payloadSchemaId,
      payloadSha256,
      operationArgsSha256: null,
      previousEnvelopeSha256: null,
      createdAt: new Date(Date.UTC(2026, 7, 7, 10, 0, revision)).toISOString(),
      payload: structuredClone(payload),
      envelopeSha256: canonicalSha256({ payloadSchemaId, revision, idempotencyKey, payloadSha256 }),
    };
    streams.get(payloadSchemaId).push(envelope);
    return { envelope, replayed: false };
  }
  const readEnvelopes = async ({ payloadSchemaId }) => structuredClone(streams.get(payloadSchemaId) || []);
  const appendCheckpoint = async ({ revision, idempotencyKey, payload }) => (
    makeEnvelope(WORKFLOW_V2_SCHEMA_IDS.workflowCheckpoint, payload, idempotencyKey, revision)
  );
  const appendManifest = async ({ revision, idempotencyKey, payload }) => (
    makeEnvelope(WORKFLOW_V2_SCHEMA_IDS.evidenceManifest, payload, idempotencyKey, revision)
  );
  const appendContext = async ({ payload }) => (
    makeEnvelope(WORKFLOW_V2_SCHEMA_IDS.stageContext, payload, payload.idempotencyKey, payload.revision)
  );
  const selectFromStore = async ({ baseContext, checkpointRevision, manifestRevision, sources }) => {
    observedBaseSchemaVersion = baseContext.schemaVersion;
    const checkpoint = streams.get(WORKFLOW_V2_SCHEMA_IDS.workflowCheckpoint)
      .find((entry) => entry.revision === checkpointRevision)?.payload;
    const manifest = streams.get(WORKFLOW_V2_SCHEMA_IDS.evidenceManifest)
      .find((entry) => entry.revision === manifestRevision)?.payload;
    const selected = {
      ...structuredClone(baseContext),
      // Keep exercising the remaining dispatch/store contract even when this
      // assertion's production precondition regresses.
      schemaVersion: baseContext.schemaVersion || "tb-stage-context-v2",
      checkpoint: structuredClone(checkpoint),
      data: {
        issue: structuredClone(sources.issue),
        latestSubstantiveComments: structuredClone(sources.latestSubstantiveComments),
        requiredEvidence: structuredClone(sources.requiredEvidence),
        evidenceManifest: structuredClone(manifest),
        misc: structuredClone(sources.misc),
      },
    };
    return {
      context: selected,
      canonical: canonicalJson(selected),
      contextHash: canonicalSha256(selected),
      budget: { total: Array.from(canonicalJson(selected)).length },
      selection: { droppedFields: [] },
    };
  };
  return {
    tempRoot,
    streams,
    get observedBaseSchemaVersion() { return observedBaseSchemaVersion; },
    dependencies: {
      storageApi,
      fsApi,
      readEnvelopes,
      appendCheckpoint,
      appendManifest,
      appendContext,
      selectFromStore,
    },
  };
}

function dispatchArgs(tab, dependencies, overrides = {}) {
  return {
    tab,
    content: "只甄别当前问题，不要使用历史会话",
    workflowKind: "triage",
    engine: "codex",
    taskId: "task-m3-1",
    attemptId: "attempt-m3-1",
    userMessageId: "message-m3-1",
    conversation: {
      mode: "append",
      messageId: "message-m3-1",
      expectedRevision: 7,
      idempotencyKey: "conversation-m3-1",
    },
    repositoryPathResolution: { mappedContent: "只甄别当前问题，不要使用历史会话" },
    config: rolloutConfig(),
    ...dependencies,
    ...overrides,
  };
}

test("启用确定性短报告后 REPORT_SHORT 在 Provider 派发前 fail closed", async () => {
  const tab = tabFixture();
  tab.workflow.phase = "reporting";
  const harness = createHarness(tab);
  const config = rolloutConfig();
  config.workflowV2.featureFlags.shortReportDeterministic = true;
  await assert.rejects(
    prepareWorkflowV2CompatibilityDispatch(dispatchArgs(tab, harness.dependencies, {
      workflowKind: "report",
      reportMode: "short",
      config,
    })),
    (error) => error?.code === "WORKFLOW_V2_DETERMINISTIC_SHORT_REPORT_PROVIDER_FORBIDDEN",
  );
});

test("legacy bootstrap 只把旧阶段记为 UNVERIFIED，manifest 不声称未知覆盖完整", () => {
  const tab = tabFixture();
  tab.materials = [
    { id: "material-duplicate", name: "same.log", relPath: "storydev:/materials/missing.log", size: 12 },
    { id: "material-duplicate", name: "same.log", relPath: "storydev:/materials/missing.log", size: 12 },
  ];
  const checkpoint = buildLegacyCheckpoint(tab);
  assert.equal(checkpoint.claims.length, 1);
  assert.equal(checkpoint.claims[0].status, "UNVERIFIED");
  assert.deepEqual(checkpoint.claims[0].evidenceIds, []);
  assert.match(checkpoint.claims[0].reason, /尚无 v2 evidence receipt/);

  const harness = createHarness(tab);
  const complete = buildLegacyEvidenceManifest(tab, harness.dependencies);
  assert.equal(complete.coverage, "COMPLETE");
  assert.equal(complete.items.some((item) => item.type === "TB_FIELD" && item.required), true);
  assert.equal(complete.items.filter((item) => item.type === "TEXT").length, 1, "相同 identity 的材料必须合并");
  tab.tbContext.comments.reverse();
  tab.materials.reverse();
  assert.deepEqual(buildLegacyEvidenceManifest(tab, harness.dependencies), complete, "输入重排不得改变 manifest");
  delete tab.tbContext.sourceCoverage;
  const unknown = buildLegacyEvidenceManifest(tab, harness.dependencies);
  assert.equal(unknown.coverage, "UNKNOWN");
  assert.match(unknown.coverageReason, /没有可证明完整性/);
  fs.rmSync(harness.tempRoot, { recursive: true, force: true });
});

test("prepare 冻结 exact source cursor 与 StageContext，同 task 幂等回放且内容漂移 fail closed", async () => {
  const tab = tabFixture();
  const harness = createHarness(tab);
  try {
    const args = dispatchArgs(tab, harness.dependencies);
    const first = await prepareWorkflowV2CompatibilityDispatch(args);
    assert.equal(first.promptMode, "compatibility");
    assert.equal(first.stageId, "TRIAGE");
    assert.equal(first.replayed, false);
    assert.equal(first.checkpointRevision, 1);
    assert.equal(first.manifestRevision, 1);
    assert.equal(first.context.checkpoint.claims.every((claim) => claim.status !== "VERIFIED"), true);
    assert.equal(first.prompt.includes("SECRET-DEVICE-SERIAL"), false);
    assert.equal(first.prompt.includes("ABSOLUTE_PROJECT_SECRET"), false);
    assert.equal(first.prompt.includes("只甄别当前问题，不要使用历史会话"), true);
    assert.equal(harness.streams.get(WORKFLOW_V2_SCHEMA_IDS.stageContext).length, 1);
    assert.equal(harness.observedBaseSchemaVersion, "tb-stage-context-v2");

    const replay = await prepareWorkflowV2CompatibilityDispatch(args);
    assert.equal(replay.replayed, true);
    assert.equal(replay.contextEnvelopeSha256, first.contextEnvelopeSha256);
    assert.equal(replay.contextHash, first.contextHash);
    assert.equal(replay.promptSha256, first.promptSha256);
    assert.equal(harness.streams.get(WORKFLOW_V2_SCHEMA_IDS.stageContext).length, 1);

    assert.equal(assertWorkflowV2CompatibilityDispatch({ dispatch: first, ...args }), true);
    assert.throws(
      () => assertWorkflowV2CompatibilityDispatch({ dispatch: first, ...args, content: "已被修改的任务" }),
      (error) => error.code === "WORKFLOW_V2_COMPATIBILITY_DISPATCH_STALE",
    );

    await assert.rejects(
      prepareWorkflowV2CompatibilityDispatch({ ...args, content: "同 task 的新内容" }),
      (error) => error.code === "WORKFLOW_V2_COMPATIBILITY_TASK_BINDING_CONFLICT",
    );
  } finally {
    fs.rmSync(harness.tempRoot, { recursive: true, force: true });
  }
});

test("record 追加 UNVERIFIED checkpoint 并原子推进 cursor，重复结算幂等回放", async () => {
  const tab = tabFixture();
  const harness = createHarness(tab);
  try {
    const dispatch = await prepareWorkflowV2CompatibilityDispatch(dispatchArgs(tab, harness.dependencies));
    const report = "## 甄别结论\n结论：本侧问题\n原因：边界遗漏\n依据：tb-fields\n未读：无";
    const first = await recordWorkflowV2CompatibilityResult({
      tab,
      dispatch,
      report,
      markerKind: "triage_is_bug",
      ...harness.dependencies,
    });
    assert.equal(first.replayed, false);
    assert.equal(first.checkpoint.revision, 2);
    assert.equal(first.checkpoint.payload.claims.at(-1).status, "UNVERIFIED");
    assert.deepEqual(first.checkpoint.payload.claims.at(-1).evidenceIds, []);
    assert.match(first.checkpoint.payload.claims.at(-1).reason, /尚未由 v2 receipt gate 验证/);
    assert.equal(tab.workflowV2Compatibility.sourceCursor.checkpoint.revision, 2);
    assert.equal(tab.workflowV2Compatibility.sourceCursor.evidenceManifest.revision, 1);

    const replay = await recordWorkflowV2CompatibilityResult({
      tab,
      dispatch,
      report,
      markerKind: "triage_is_bug",
      ...harness.dependencies,
    });
    assert.equal(replay.replayed, true);
    assert.equal(replay.checkpoint.revision, 2);
    assert.equal(harness.streams.get(WORKFLOW_V2_SCHEMA_IDS.workflowCheckpoint).length, 2);
  } finally {
    fs.rmSync(harness.tempRoot, { recursive: true, force: true });
  }
});

test("M4 structured dispatch freezes result mode, schema, strategy, and Provider binding", async () => {
  const tab = tabFixture();
  const harness = createHarness(tab);
  try {
    const config = {
      workflowV2: {
        featureFlags: { promptV2: true, structuredResultsV2: true },
        promptV2Rollout: { percentage: 100, salt: "m4-structured", storyIds: [], providers: [] },
      },
    };
    const args = dispatchArgs(tab, harness.dependencies, {
      config,
      taskId: "task-m4-structured",
      attemptId: "attempt-m4-structured",
      userMessageId: "message-m4-structured",
      resultMode: "structured",
      structuredStrategy: "json_text",
    });
    const first = await prepareWorkflowV2CompatibilityDispatch(args);
    assert.equal(first.promptMode, "structured");
    assert.equal(first.stageId, "TRIAGE");
    assert.equal(first.resultSchemaId, WORKFLOW_V2_SCHEMA_IDS.triageResult);
    assert.equal(first.context.output.schemaId, WORKFLOW_V2_SCHEMA_IDS.triageResult);
    assert.equal(first.structuredStrategy, "json_text");
    assert.deepEqual(first.structuredOutput, {
      mode: "structured",
      strategy: "json_text",
      schemaId: WORKFLOW_V2_SCHEMA_IDS.triageResult,
      schema: first.structuredOutput.schema,
      contextId: first.contextId,
      contextRevision: first.contextRevision,
      idempotencyKey: first.context.idempotencyKey,
    });
    assert.equal(Object.isFrozen(first), true);
    assert.equal(Object.isFrozen(first.structuredOutput), true);
    assert.match(first.promptSha256, /^[a-f0-9]{64}$/);
    assert.match(first.dispatchHash, /^[a-f0-9]{64}$/);
    assert.match(first.prompt, /<STAGE_CONTEXT_JSON>/);
    assert.match(first.prompt, /<RESULT_SCHEMA_JSON>/);
    assert.equal(assertWorkflowV2CompatibilityDispatch({ dispatch: first, ...args }), true);

    const replay = await prepareWorkflowV2CompatibilityDispatch(args);
    assert.equal(replay.replayed, true);
    assert.equal(replay.bindingHash, first.bindingHash);
    assert.equal(replay.promptSha256, first.promptSha256);
    assert.match(replay.dispatchHash, /^[a-f0-9]{64}$/);

    assert.throws(
      () => assertWorkflowV2CompatibilityDispatch({
        dispatch: first,
        ...args,
        structuredStrategy: "finish_stage",
      }),
      (error) => error.code === "WORKFLOW_V2_COMPATIBILITY_DISPATCH_STALE",
    );
    assert.throws(
      () => assertWorkflowV2CompatibilityDispatch({ dispatch: first, ...args, engine: "claude" }),
      (error) => error.code === "WORKFLOW_V2_COMPATIBILITY_DISPATCH_STALE",
    );
    assert.throws(
      () => assertWorkflowV2CompatibilityDispatch({
        dispatch: first,
        ...args,
        config: {
          ...config,
          workflowV2: {
            ...config.workflowV2,
            featureFlags: { promptV2: true, structuredResultsV2: false },
          },
        },
        resultMode: "compatibility",
        structuredStrategy: "",
      }),
      (error) => error.code === "WORKFLOW_V2_COMPATIBILITY_DISPATCH_MISSING",
    );

    for (const drift of [
      { structuredStrategy: "finish_stage" },
      { resultMode: "compatibility", structuredStrategy: "" },
      { engine: "claude" },
    ]) {
      await assert.rejects(
        prepareWorkflowV2CompatibilityDispatch({ ...args, ...drift }),
        (error) => error.code === "WORKFLOW_V2_COMPATIBILITY_TASK_BINDING_CONFLICT",
        `same task must reject drift: ${JSON.stringify(drift)}`,
      );
    }
  } finally {
    fs.rmSync(harness.tempRoot, { recursive: true, force: true });
  }
});
