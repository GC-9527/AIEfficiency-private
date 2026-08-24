import {
  appendStageResultRecord,
  canonicalJson,
  canonicalSha256,
  readWorkflowV2Envelopes,
} from "./envelope-store.js";
import { WORKFLOW_V2_SCHEMA_IDS, workflowV2SchemaRegistry } from "./schema-registry.js";

export class WorkflowV2StructuredResultStoreError extends Error {
  constructor(message, code, details = {}) {
    super(message);
    this.name = "WorkflowV2StructuredResultStoreError";
    this.code = code;
    this.statusCode = 409;
    this.details = details;
  }
}

function fail(message, code, details = {}) {
  throw new WorkflowV2StructuredResultStoreError(message, code, details);
}

function snapshot(value) {
  return JSON.parse(canonicalJson(value));
}

function sameFrozenResult(envelope, expected) {
  const payload = envelope?.payload;
  return payload?.storyId === expected.storyId
    && payload?.stageId === expected.stageId
    && payload?.resultSchemaId === expected.resultSchemaId
    && payload?.contextId === expected.contextId
    && payload?.contextRevision === expected.contextRevision
    && payload?.contextIdempotencyKey === expected.contextIdempotencyKey
    && payload?.resultSha256 === expected.resultSha256;
}

export async function recordStructuredStageResult({
  tab,
  dispatch,
  result,
  readEnvelopes = readWorkflowV2Envelopes,
  appendResult = appendStageResultRecord,
} = {}) {
  if (!tab?.id || dispatch?.promptMode !== "structured") {
    fail("structured result 缺少可信 story/dispatch", "WORKFLOW_V2_STRUCTURED_RESULT_IDENTITY_MISSING");
  }
  const resultSnapshot = snapshot(result);
  const resultSchemaId = String(dispatch.resultSchemaId || dispatch.context?.output?.schemaId || "");
  workflowV2SchemaRegistry.assertValid(resultSchemaId, resultSnapshot, "structured stage result");
  const expected = {
    storyId: String(tab.id),
    stageId: String(dispatch.stageId || ""),
    resultSchemaId,
    contextId: String(dispatch.contextId || ""),
    contextRevision: dispatch.contextRevision,
    contextIdempotencyKey: String(dispatch.context?.idempotencyKey || ""),
    resultSha256: canonicalSha256(resultSnapshot),
  };
  if (resultSnapshot.contextId !== expected.contextId
    || resultSnapshot.contextRevision !== expected.contextRevision
    || resultSnapshot.idempotencyKey !== expected.contextIdempotencyKey) {
    fail("structured result 与冻结 StageContext 身份不一致", "WORKFLOW_V2_STRUCTURED_RESULT_IDENTITY_MISMATCH");
  }

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const records = await readEnvelopes({
      tab,
      payloadSchemaId: WORKFLOW_V2_SCHEMA_IDS.stageResultRecord,
    });
    const existing = records.find((entry) => (
      entry.payload?.contextId === expected.contextId
      && entry.payload?.contextRevision === expected.contextRevision
    ));
    if (existing) {
      if (!sameFrozenResult(existing, expected)) {
        fail("同一冻结 StageContext 已绑定不同 structured result", "WORKFLOW_V2_STRUCTURED_RESULT_CONFLICT", {
          contextId: expected.contextId,
          contextRevision: expected.contextRevision,
        });
      }
      return { envelope: existing, replayed: true };
    }

    const recordRevision = records.length + 1;
    const payload = {
      schemaVersion: "stage-result-record-v1",
      storyId: expected.storyId,
      recordRevision,
      stageId: expected.stageId,
      resultSchemaId: expected.resultSchemaId,
      contextId: expected.contextId,
      contextRevision: expected.contextRevision,
      contextIdempotencyKey: expected.contextIdempotencyKey,
      resultSha256: expected.resultSha256,
      result: resultSnapshot,
    };
    try {
      return await appendResult({ tab, payload });
    } catch (error) {
      if (!["WORKFLOW_V2_STALE_REVISION", "WORKFLOW_V2_IDEMPOTENCY_CONFLICT"].includes(error?.code)) throw error;
    }
  }
  fail("structured result 并发追加无法收敛", "WORKFLOW_V2_STRUCTURED_RESULT_REVISION_RACE");
}
