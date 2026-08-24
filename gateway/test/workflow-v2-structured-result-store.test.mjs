import { test } from "node:test";
import assert from "node:assert/strict";

import { recordStructuredStageResult } from "../services/devbench/workflow-v2/structured-result-store.js";
import {
  WORKFLOW_V2_SCHEMA_IDS,
  workflowV2SchemaRegistry,
} from "../services/devbench/workflow-v2/schema-registry.js";

function dispatchFixture(overrides = {}) {
  return {
    promptMode: "structured",
    stageId: "TRIAGE",
    resultSchemaId: WORKFLOW_V2_SCHEMA_IDS.triageResult,
    contextId: "context-m4-result-store",
    contextRevision: 3,
    context: {
      idempotencyKey: "m4-result-context-key-3",
    },
    ...overrides,
  };
}

function triageResult(overrides = {}) {
  return {
    schemaVersion: "triage-result-v2",
    contextId: "context-m4-result-store",
    contextRevision: 3,
    idempotencyKey: "m4-result-context-key-3",
    status: "COMPLETED",
    classification: "CLIENT_ISSUE",
    confidence: "HIGH",
    rootCause: {
      symptom: "结果未被可靠记录",
      trigger: "Provider 完成阶段",
      observedBehavior: "同一上下文可能被重复结算",
      directCause: "缺少不可变结果流",
      faultOwner: "客户端工作流",
      workaroundOwner: "客户端工作流",
    },
    claims: [],
    evidenceRead: [],
    evidenceUnread: [],
    recommendedAction: "记录后再推进",
    userSummary: "结果记录测试",
    nextStage: "REPAIR",
    ...overrides,
  };
}

function resultStoreHarness() {
  const records = [];
  return {
    records,
    readEnvelopes: async ({ payloadSchemaId }) => {
      assert.equal(payloadSchemaId, WORKFLOW_V2_SCHEMA_IDS.stageResultRecord);
      return structuredClone(records);
    },
    appendResult: async ({ tab, payload }) => {
      assert.equal(tab.id, "story-m4-result-store");
      workflowV2SchemaRegistry.assertValid(
        WORKFLOW_V2_SCHEMA_IDS.stageResultRecord,
        payload,
        "test stage result record",
      );
      const envelope = Object.freeze({
        idempotencyKey: `stage-result:${payload.contextId}:${payload.contextRevision}`,
        payload: structuredClone(payload),
      });
      records.push(envelope);
      return { envelope, replayed: false };
    },
  };
}

test("M4 structured result store replays the same frozen context/result idempotently", async () => {
  const harness = resultStoreHarness();
  const tab = { id: "story-m4-result-store" };
  const dispatch = dispatchFixture();
  const result = triageResult();
  const first = await recordStructuredStageResult({
    tab,
    dispatch,
    result,
    ...harness,
  });
  assert.equal(first.replayed, false);
  assert.equal(harness.records.length, 1);
  assert.equal(harness.records[0].payload.recordRevision, 1);
  assert.equal(harness.records[0].payload.contextIdempotencyKey, dispatch.context.idempotencyKey);
  assert.deepEqual(harness.records[0].payload.result, result);

  const replay = await recordStructuredStageResult({
    tab,
    dispatch: structuredClone(dispatch),
    result: structuredClone(result),
    ...harness,
  });
  assert.equal(replay.replayed, true);
  assert.equal(harness.records.length, 1, "idempotent replay must not append a second record");
  assert.deepEqual(replay.envelope, first.envelope);
});

test("M4 structured result store rejects a different result for the same context revision", async () => {
  const harness = resultStoreHarness();
  const input = {
    tab: { id: "story-m4-result-store" },
    dispatch: dispatchFixture(),
    ...harness,
  };
  await recordStructuredStageResult({ ...input, result: triageResult() });
  await assert.rejects(
    recordStructuredStageResult({
      ...input,
      result: triageResult({ userSummary: "同一上下文的另一个结果" }),
    }),
    (error) => error.code === "WORKFLOW_V2_STRUCTURED_RESULT_CONFLICT",
  );
  assert.equal(harness.records.length, 1, "conflict must not mutate the immutable stream");
});

test("M4 structured result store validates schema and exact context identity before append", async () => {
  const harness = resultStoreHarness();
  const input = {
    tab: { id: "story-m4-result-store" },
    dispatch: dispatchFixture(),
    ...harness,
  };
  await assert.rejects(
    recordStructuredStageResult({
      ...input,
      result: triageResult({ idempotencyKey: "another-context-key" }),
    }),
    (error) => error.code === "WORKFLOW_V2_STRUCTURED_RESULT_IDENTITY_MISMATCH",
  );
  await assert.rejects(
    recordStructuredStageResult({
      ...input,
      result: { ...triageResult(), unexpected: true },
    }),
    (error) => error.code === "WORKFLOW_V2_SCHEMA_VALIDATION_FAILED",
  );
  assert.equal(harness.records.length, 0);
});
