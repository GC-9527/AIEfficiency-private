import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  WORKFLOW_V2_SCHEMA_IDS,
  workflowV2SchemaRegistry,
} from "../services/devbench/workflow-v2/schema-registry.js";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const sourceSchemaDirectory = path.join(
  repoRoot,
  "features",
  "StoryDev",
  "工作流",
  "AI修复工作流",
  "stepplan0",
  "TB_AI_Workflow_Phase2_Optimization",
  "schemas",
);
const localSchemaDirectory = fileURLToPath(new URL("../services/devbench/workflow-v2/schemas/", import.meta.url));
const reusedSchemaFiles = [
  "stage-context.schema.json",
  "workflow-checkpoint.schema.json",
  "evidence-manifest.schema.json",
  "evidence-receipt.schema.json",
  "triage-result.schema.json",
  "repair-result.schema.json",
  "verification-result.schema.json",
  "short-report-result.schema.json",
  "expert-report-result.schema.json",
  "stage-result-record.schema.json",
];

const resultSchemaKeys = [
  "triageResult",
  "repairResult",
  "verificationResult",
  "shortReportResult",
  "expertReportResult",
];

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

// 跨平台字节比较必须归一化行尾：Windows core.autocrlf 会让 checkout 工作树
// 出现 CRLF/LF 差异（git 视为等价），直接比字节会把内容一致误报为漂移。
function normalizeEol(buffer) {
  return buffer.toString("utf8").replace(/\r\n/g, "\n");
}

function validEnvelope(payloadSchemaId, operationArgsSha256) {
  return {
    schemaVersion: "workflow-envelope-v2",
    storyId: "story-1",
    recordId: "record-1",
    contextId: null,
    revision: 1,
    idempotencyKey: "story-1:record-1",
    payloadSchemaId,
    payloadSha256: "a".repeat(64),
    operationArgsSha256,
    previousEnvelopeSha256: null,
    createdAt: "2026-08-07T10:00:00.000Z",
    payload: {},
    envelopeSha256: "b".repeat(64),
  };
}

test("生产 registry 本地十份 Schema 与 Phase2 设计源字节级一致（行尾归一化后）", () => {
  for (const filename of reusedSchemaFiles) {
    const source = fs.readFileSync(path.join(sourceSchemaDirectory, filename));
    const local = fs.readFileSync(path.join(localSchemaDirectory, filename));
    assert.equal(sha256(normalizeEol(local)), sha256(normalizeEol(source)), filename);
    assert.deepEqual(JSON.parse(local), JSON.parse(source), filename);
  }
});

test("registry 可从任意 cwd import，十三份 Schema（含 verificationPlan）均已编译", () => {
  assert.equal(workflowV2SchemaRegistry.has(WORKFLOW_V2_SCHEMA_IDS.verificationPlan), true);
  for (const schemaId of Object.values(WORKFLOW_V2_SCHEMA_IDS)) {
    assert.equal(workflowV2SchemaRegistry.has(schemaId), true, schemaId);
    assert.ok(workflowV2SchemaRegistry.getSchemaDocument(schemaId).$id);
  }
  const moduleUrl = pathToFileURL(fileURLToPath(new URL(
    "../services/devbench/workflow-v2/schema-registry.js",
    import.meta.url,
  ))).href;
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "workflow-v2-registry-cwd-"));
  const result = spawnSync(process.execPath, [
    "--input-type=module",
    "-e",
    `const m=await import(${JSON.stringify(moduleUrl)}); console.log(Object.keys(m.WORKFLOW_V2_SCHEMA_IDS).length);`,
  ], { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), "13");
});

test("five active result schemas require the frozen StageContext identity", () => {
  for (const key of resultSchemaKeys) {
    const schemaId = WORKFLOW_V2_SCHEMA_IDS[key];
    const document = workflowV2SchemaRegistry.getSchemaDocument(schemaId);
    assert.equal(document.$id, schemaId);
    assert.equal(document.required.includes("contextId"), true, key);
    assert.equal(document.required.includes("contextRevision"), true, key);
    assert.equal(document.required.includes("idempotencyKey"), true, key);
    assert.deepEqual(document.properties.idempotencyKey, {
      type: "string",
      minLength: 8,
      maxLength: 160,
    });
  }
});

test("stage-result record schema binds an exact stage/result schema pair without mutating input", () => {
  const result = {
    schemaVersion: "short-report-result-v2",
    contextId: "context-1",
    contextRevision: 1,
    idempotencyKey: "context-key-1",
    reportText: "done",
  };
  const record = {
    schemaVersion: "stage-result-record-v1",
    storyId: "story-1",
    recordRevision: 1,
    stageId: "REPORT_SHORT",
    resultSchemaId: WORKFLOW_V2_SCHEMA_IDS.shortReportResult,
    contextId: result.contextId,
    contextRevision: result.contextRevision,
    contextIdempotencyKey: result.idempotencyKey,
    resultSha256: "a".repeat(64),
    result,
  };
  const before = structuredClone(record);
  assert.equal(
    workflowV2SchemaRegistry.validate(WORKFLOW_V2_SCHEMA_IDS.stageResultRecord, record).valid,
    true,
  );
  assert.deepEqual(record, before);

  const wrongPair = structuredClone(record);
  wrongPair.stageId = "TRIAGE";
  assert.equal(
    workflowV2SchemaRegistry.validate(WORKFLOW_V2_SCHEMA_IDS.stageResultRecord, wrongPair).valid,
    false,
  );
});

test("compatibility source cursor 绑定 exact checkpoint/manifest revision 与 hash", () => {
  const cursor = {
    schemaVersion: "workflow-v2-compatibility-source-cursor-v1",
    storyId: "story-1",
    checkpoint: {
      revision: 1,
      envelopeSha256: "a".repeat(64),
      payloadSha256: "b".repeat(64),
    },
    evidenceManifest: {
      revision: 2,
      envelopeSha256: "c".repeat(64),
      payloadSha256: "d".repeat(64),
    },
    updatedAt: "2026-08-07T10:00:00.000Z",
  };
  assert.equal(
    workflowV2SchemaRegistry.validate(WORKFLOW_V2_SCHEMA_IDS.compatibilitySourceCursor, cursor).valid,
    true,
  );
  for (const mutate of [
    (value) => { value.checkpoint.revision = 0; },
    (value) => { value.evidenceManifest.payloadSha256 = "not-a-hash"; },
    (value) => { value.updatedAt = "not-a-date"; },
    (value) => { value.extra = true; },
  ]) {
    const invalid = structuredClone(cursor);
    mutate(invalid);
    assert.equal(
      workflowV2SchemaRegistry.validate(WORKFLOW_V2_SCHEMA_IDS.compatibilitySourceCursor, invalid).valid,
      false,
    );
  }
});

test("registry 执行 Draft 2020-12 conditional 与 format 校验且不修改入参", () => {
  const checkpoint = {
    schemaVersion: "workflow-checkpoint-v2",
    storyId: "story-1",
    revision: 1,
    claims: [{ claimId: "c1", text: "claim", status: "VERIFIED", evidenceIds: [] }],
    actions: [],
    changes: [],
    verification: [],
    openItems: [],
    userDecisions: [],
  };
  const original = structuredClone(checkpoint);
  const checkpointResult = workflowV2SchemaRegistry.validate(WORKFLOW_V2_SCHEMA_IDS.workflowCheckpoint, checkpoint);
  assert.equal(checkpointResult.valid, false, "VERIFIED claim 必须有 evidenceIds");
  assert.deepEqual(checkpoint, original);

  const manifestResult = workflowV2SchemaRegistry.validate(WORKFLOW_V2_SCHEMA_IDS.evidenceManifest, {
    schemaVersion: "evidence-manifest-v2",
    storyId: "story-1",
    coverage: "PARTIAL",
    items: [],
  });
  assert.equal(manifestResult.valid, false, "PARTIAL manifest 必须有 coverageReason");

  const receipt = {
    schemaVersion: "evidence-receipt-v2",
    receiptId: "receipt-1",
    action: "BUILD",
    status: "PASS",
    startedAt: "not-a-date",
    finishedAt: "2026-08-07T10:00:01.000Z",
    toolName: "build",
    operationId: "operation-1",
    idempotencyKey: null,
  };
  const receiptResult = workflowV2SchemaRegistry.validate(WORKFLOW_V2_SCHEMA_IDS.evidenceReceipt, receipt);
  assert.equal(receiptResult.valid, false, "format 和副作用 idempotencyKey conditional 都必须执行");
});

test("envelope Schema 要求 Receipt args hash，非 Receipt 禁止 args hash", () => {
  const receiptEnvelope = validEnvelope(WORKFLOW_V2_SCHEMA_IDS.evidenceReceipt, null);
  assert.equal(
    workflowV2SchemaRegistry.validate(WORKFLOW_V2_SCHEMA_IDS.workflowEnvelope, receiptEnvelope).valid,
    false,
  );
  receiptEnvelope.operationArgsSha256 = "c".repeat(64);
  assert.equal(
    workflowV2SchemaRegistry.validate(WORKFLOW_V2_SCHEMA_IDS.workflowEnvelope, receiptEnvelope).valid,
    true,
  );

  const manifestEnvelope = validEnvelope(WORKFLOW_V2_SCHEMA_IDS.evidenceManifest, "c".repeat(64));
  assert.equal(
    workflowV2SchemaRegistry.validate(WORKFLOW_V2_SCHEMA_IDS.workflowEnvelope, manifestEnvelope).valid,
    false,
  );
  manifestEnvelope.operationArgsSha256 = null;
  assert.equal(
    workflowV2SchemaRegistry.validate(WORKFLOW_V2_SCHEMA_IDS.workflowEnvelope, manifestEnvelope).valid,
    true,
  );
});
