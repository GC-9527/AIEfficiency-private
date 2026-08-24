import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import { canonicalSha256 } from "../services/devbench/workflow-v2/envelope-store.js";
import { validateCompatibilityWorkflowResult } from "../services/devbench/workflow-v2/compatibility-result-gate.js";
import { validateCompatibilityWorkflowEvidence as validateCompatibilityWorkflowEvidenceRaw } from "../services/devbench/workflow-v2/compatibility-evidence-gate.js";
import { WORKFLOW_V2_SCHEMA_IDS } from "../services/devbench/workflow-v2/schema-registry.js";
import { deriveWorkflowV2EditState } from "../services/devbench/workflow-v2/edit-state-binding.js";

const STORY_ID = "story-compat-evidence";
const CONTEXT_ID = "context-compat-evidence";
const CONTEXT_REVISION = 4;
const ROOT_ID = "main";
const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

function validateCompatibilityWorkflowEvidence(options) {
  return validateCompatibilityWorkflowEvidenceRaw({
    verifyReceiptOutput: async () => ({ valid: true, reason: null }),
    ...options,
  });
}

function receipt({
  receiptId,
  action,
  selector,
  status = "PASS",
  evidenceId = null,
  outputRef = null,
  sha256 = null,
}) {
  return {
    schemaVersion: "evidence-receipt-v2",
    receiptId,
    evidenceId,
    operationId: `operation-${receiptId}`,
    action,
    status,
    toolName: action === "EDIT" ? "edit_file" : "controlled_executor",
    rootId: ROOT_ID,
    selector: {
      contextId: CONTEXT_ID,
      contextRevision: CONTEXT_REVISION,
      ...selector,
    },
    startedAt: "2026-08-08T08:00:00.000Z",
    finishedAt: "2026-08-08T08:00:01.000Z",
    exitCode: action === "EDIT" ? null : 0,
    outputRef,
    sha256,
    summary: "Gateway controlled receipt",
    error: null,
    idempotencyKey: `operation-${receiptId}`,
  };
}

function envelope(payload, revision = 1) {
  return {
    schemaVersion: "workflow-envelope-v2",
    storyId: STORY_ID,
    recordId: payload.receiptId,
    contextId: null,
    revision,
    idempotencyKey: `envelope-${payload.receiptId}`,
    payloadSchemaId: WORKFLOW_V2_SCHEMA_IDS.evidenceReceipt,
    payloadSha256: canonicalSha256(payload),
    operationArgsSha256: createHash("sha256").update(payload.operationId).digest("hex"),
    previousEnvelopeSha256: null,
    createdAt: "2026-08-08T08:00:01.000Z",
    payload,
    envelopeSha256: createHash("sha256").update(`envelope:${payload.receiptId}`).digest("hex"),
  };
}

function bindChecksToEditState(envelopes, { requireChanges = false } = {}) {
  const state = deriveWorkflowV2EditState({
    envelopes,
    storyId: STORY_ID,
    contextId: CONTEXT_ID,
    contextRevision: CONTEXT_REVISION,
    rootId: ROOT_ID,
    requireChanges,
  });
  for (const item of envelopes) {
    if (!["BUILD", "TEST"].includes(item.payload?.action)) continue;
    item.payload.selector.editStateSha256 = state.editStateSha256;
    item.payload.selector.editStateVersionSha256 = state.editStateVersionSha256;
  }
  return envelopes;
}

function repairDispatch() {
  return {
    executionStatus: { status: "READY", profileId: "profile-compat-evidence", blockers: [] },
    executionProfile: {
      profileId: "profile-compat-evidence",
      executors: [{ executorId: "executor-unit", action: "TEST", cwdRootId: ROOT_ID }],
    },
    contextId: CONTEXT_ID,
    contextRevision: CONTEXT_REVISION,
    context: {
      contextId: CONTEXT_ID,
      revision: CONTEXT_REVISION,
      story: { storyId: STORY_ID },
      data: {
        localChecks: [{
          checkId: "check-unit",
          name: "unit test",
          mandatory: true,
          executorId: "executor-unit",
          action: "TEST",
          rootId: ROOT_ID,
        }],
      },
    },
  };
}

function verificationPlan() {
  return {
    schemaVersion: "verification-plan-v2",
    planId: "plan-compat-evidence",
    profileId: "profile-compat-evidence",
    status: "READY",
    storyIds: [STORY_ID],
    mandatoryCapabilities: ["TEST"],
    blockers: [],
    cases: [{
      caseId: "case-unit",
      title: "unit verification",
      storyIds: [STORY_ID],
      mandatory: true,
      executorId: "executor-unit",
      action: "TEST",
      requirements: [],
      target: {
        rootId: ROOT_ID,
        flavor: null,
        buildType: null,
        deviceProfileId: null,
        environment: null,
      },
      preconditions: [],
      steps: ["run frozen unit executor"],
      assertions: ["exit code is zero"],
      evidenceRequirements: ["TEST receipt"],
      cleanup: [],
      failureDiagnostics: [],
    }],
  };
}

function verifyDispatch() {
  return {
    executionStatus: { status: "READY", profileId: "profile-compat-evidence", blockers: [] },
    executionProfile: {
      profileId: "profile-compat-evidence",
      executors: [{ executorId: "executor-unit", action: "TEST", cwdRootId: ROOT_ID }],
    },
    contextId: CONTEXT_ID,
    contextRevision: CONTEXT_REVISION,
    context: {
      contextId: CONTEXT_ID,
      revision: CONTEXT_REVISION,
      story: { storyId: STORY_ID },
      data: { verificationPlan: verificationPlan() },
    },
  };
}

test("外观合法但不存在的 receipt 不能让 compatibility FIX_DONE/VERIFY PASS 推进", async () => {
  const repairText = "## 修复结果\n原因：边界错误\n措施：增加校验\n改动：src/a.js\n验证：测试 PASS receipt-fake\n风险：无\n<!-- FIX_DONE -->";
  const repairStructural = validateCompatibilityWorkflowResult({ stageId: "REPAIR", text: repairText });
  assert.equal(repairStructural.ok, true);
  const repairEvidence = await validateCompatibilityWorkflowEvidence({
    tab: { id: STORY_ID },
    dispatch: repairDispatch(),
    markerKind: repairStructural.markerKind,
    readEnvelopes: async () => [],
  });
  assert.equal(repairEvidence.ok, false);
  assert.equal(repairEvidence.code, "WORKFLOW_V2_COMPATIBILITY_EDIT_RECEIPT_MISSING");

  const verifyEvidence = await validateCompatibilityWorkflowEvidence({
    tab: { id: STORY_ID },
    dispatch: verifyDispatch(),
    markerKind: "verify_pass",
    readEnvelopes: async () => [],
  });
  assert.equal(verifyEvidence.ok, false);
  assert.equal(verifyEvidence.code, "WORKFLOW_V2_COMPATIBILITY_VERIFY_RECEIPT_MISSING");
});

test("真实 EDIT + frozen local check receipt 才允许 compatibility FIX_DONE", async () => {
  const edit = receipt({
    receiptId: "receipt-edit",
    action: "EDIT",
    selector: {
      path: "src/a.js",
      beforeExists: true,
      beforeSha256: HASH_A,
      afterExists: true,
      afterSha256: HASH_B,
    },
  });
  const check = receipt({
    receiptId: "receipt-check",
    action: "TEST",
    selector: { checkId: "check-unit", executorId: "executor-unit", name: "unit test" },
  });
  const result = await validateCompatibilityWorkflowEvidence({
    tab: { id: STORY_ID },
    dispatch: repairDispatch(),
    markerKind: "fix_done",
    readEnvelopes: async () => bindChecksToEditState(
      [envelope(edit, 1), envelope(check, 2)],
      { requireChanges: true },
    ),
  });
  assert.equal(result.ok, true);
  assert.deepEqual([...result.receiptIds], ["receipt-edit", "receipt-check"]);
});

test("VERIFY PASS 必须由 exact caseId/executorId/action receipt 证明，VERIFY FAIL 安全流转", async () => {
  const valid = receipt({
    receiptId: "receipt-case",
    action: "TEST",
    selector: { caseId: "case-unit", executorId: "executor-unit" },
  });
  const pass = await validateCompatibilityWorkflowEvidence({
    tab: { id: STORY_ID },
    dispatch: verifyDispatch(),
    markerKind: "verify_pass",
    readEnvelopes: async () => bindChecksToEditState([envelope(valid)]),
  });
  assert.equal(pass.ok, true);

  const wrongExecutor = structuredClone(valid);
  wrongExecutor.receiptId = "receipt-wrong-executor";
  wrongExecutor.operationId = "operation-receipt-wrong-executor";
  wrongExecutor.idempotencyKey = wrongExecutor.operationId;
  wrongExecutor.selector.executorId = "executor-other";
  const denied = await validateCompatibilityWorkflowEvidence({
    tab: { id: STORY_ID },
    dispatch: verifyDispatch(),
    markerKind: "verify_pass",
    readEnvelopes: async () => bindChecksToEditState([envelope(wrongExecutor)]),
  });
  assert.equal(denied.ok, false);

  const safeFail = await validateCompatibilityWorkflowEvidence({
    tab: { id: STORY_ID },
    dispatch: verifyDispatch(),
    markerKind: "verify_fail",
    readEnvelopes: async () => { throw new Error("must not read receipts for safe FAIL"); },
  });
  assert.equal(safeFail.ok, true);
});

test("compatibility VERIFY 对 mandatoryCapabilities 错位和自由文本 evidenceRequirement fail-closed", async () => {
  const capabilityMismatch = verifyDispatch();
  capabilityMismatch.context.data.verificationPlan.mandatoryCapabilities = ["BUILD", "TEST"];
  let reads = 0;
  const mismatched = await validateCompatibilityWorkflowEvidence({
    tab: { id: STORY_ID },
    dispatch: capabilityMismatch,
    markerKind: "verify_pass",
    readEnvelopes: async () => { reads += 1; return []; },
  });
  assert.equal(mismatched.ok, false);
  assert.equal(mismatched.code, "WORKFLOW_V2_VERIFY_MANDATORY_CAPABILITY_MISMATCH");
  assert.equal(reads, 0);

  const unsupported = verifyDispatch();
  unsupported.context.data.verificationPlan.cases[0].evidenceRequirements = ["operator says evidence exists"];
  const blocked = await validateCompatibilityWorkflowEvidence({
    tab: { id: STORY_ID },
    dispatch: unsupported,
    markerKind: "verify_pass",
    readEnvelopes: async () => [],
  });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.code, "WORKFLOW_V2_VERIFY_EVIDENCE_REQUIREMENT_UNSUPPORTED");
});

test("compatibility VERIFY 的独立 video 材料必须精确绑定 case/executor/root/context", async () => {
  const dispatch = verifyDispatch();
  dispatch.context.data.verificationPlan.cases[0].evidenceRequirements = ["TEST receipt", "video"];
  const primary = receipt({
    receiptId: "receipt-case-material",
    action: "TEST",
    selector: { caseId: "case-unit", executorId: "executor-unit" },
  });
  const missing = await validateCompatibilityWorkflowEvidence({
    tab: { id: STORY_ID },
    dispatch,
    markerKind: "verify_pass",
    readEnvelopes: async () => bindChecksToEditState([envelope(primary)]),
  });
  assert.equal(missing.ok, false);
  assert.equal(missing.code, "WORKFLOW_V2_COMPATIBILITY_VERIFY_MATERIAL_MISSING");

  const capture = receipt({
    receiptId: "receipt-video-material",
    action: "CAPTURE",
    evidenceId: "evidence-video-material",
    outputRef: `storydev:/workflow-v2/capture-output/${HASH_A}.bin`,
    sha256: HASH_A,
    selector: {
      caseId: "case-unit",
      executorId: "executor-unit",
      evidenceRequirement: "video",
      materialKind: "VIDEO",
    },
  });
  const pass = await validateCompatibilityWorkflowEvidence({
    tab: { id: STORY_ID },
    dispatch,
    markerKind: "verify_pass",
    readEnvelopes: async () => bindChecksToEditState([envelope(primary, 1), envelope(capture, 2)]),
  });
  assert.equal(pass.ok, true);
  assert.deepEqual([...pass.receiptIds], ["receipt-case-material", "receipt-video-material"]);

  capture.selector.executorId = "executor-other";
  const wrongBinding = await validateCompatibilityWorkflowEvidence({
    tab: { id: STORY_ID },
    dispatch,
    markerKind: "verify_pass",
    readEnvelopes: async () => bindChecksToEditState([envelope(primary, 1), envelope(capture, 2)]),
  });
  assert.equal(wrongBinding.ok, false);
  assert.equal(wrongBinding.code, "WORKFLOW_V2_COMPATIBILITY_VERIFY_MATERIAL_MISSING");
});
