import { test } from "node:test";
import assert from "node:assert/strict";
import {
  evaluateStructuredWorkflowResult as evaluateStructuredWorkflowResultRaw,
  parseStrictStructuredResult,
} from "../services/devbench/workflow-v2/structured-result-gate.js";
import { WORKFLOW_V2_SCHEMA_IDS } from "../services/devbench/workflow-v2/schema-registry.js";
import { canonicalSha256 } from "../services/devbench/workflow-v2/envelope-store.js";
import { deriveWorkflowV2EditState } from "../services/devbench/workflow-v2/edit-state-binding.js";

const STORY_ID = "story-m4-structured";
const CONTEXT_ID = "ctx-m4-structured";
const CONTEXT_KEY = "prompt-v2:m4-structured-key";
const TAB = Object.freeze({ id: STORY_ID });
const EDIT_BEFORE_SHA = "1".repeat(64);
const EDIT_AFTER_SHA = "2".repeat(64);

function evaluateStructuredWorkflowResult(options) {
  return evaluateStructuredWorkflowResultRaw({
    verifyReceiptOutput: async () => ({ valid: true, reason: null }),
    ...options,
  });
}

const SCHEMA_BY_STAGE = Object.freeze({
  TRIAGE: WORKFLOW_V2_SCHEMA_IDS.triageResult,
  REPAIR: WORKFLOW_V2_SCHEMA_IDS.repairResult,
  VERIFY_EXECUTE: WORKFLOW_V2_SCHEMA_IDS.verificationResult,
  REPORT_SHORT: WORKFLOW_V2_SCHEMA_IDS.shortReportResult,
  REPORT_EXPERT: WORKFLOW_V2_SCHEMA_IDS.expertReportResult,
});

function deepFreeze(value, seen = new Set()) {
  if (!value || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
}

function evidenceManifest(items = []) {
  return {
    schemaVersion: "evidence-manifest-v2",
    storyId: STORY_ID,
    coverage: "COMPLETE",
    items,
  };
}

function evidenceItem(evidenceId, {
  required = true,
  availability = "AVAILABLE",
  type = "TEXT",
  sha256 = null,
} = {}) {
  return {
    evidenceId,
    type,
    name: evidenceId,
    availability,
    required,
    contentRef: `storydev:/evidence/${evidenceId}`,
    ...(sha256 ? { sha256 } : {}),
  };
}

function verificationPlanCase(caseId, action, mandatory) {
  return {
    caseId,
    title: caseId,
    storyIds: [STORY_ID],
    mandatory,
    executorId: `executor-${caseId}`,
    action,
    requirements: [],
    target: {
      rootId: "main",
      flavor: null,
      buildType: null,
      deviceProfileId: null,
      environment: null,
    },
    preconditions: [],
    steps: ["run frozen executor"],
    assertions: ["exit code is zero"],
    evidenceRequirements: [`${action} receipt`],
    cleanup: [],
    failureDiagnostics: [],
  };
}

function verificationPlanFixture() {
  return {
    schemaVersion: "verification-plan-v2",
    planId: "plan-m4",
    profileId: "profile-verify",
    status: "READY",
    storyIds: [STORY_ID],
    mandatoryCapabilities: ["TEST"],
    blockers: [],
    cases: [
      verificationPlanCase("mandatory-1", "TEST", true),
      verificationPlanCase("optional-1", "CAPTURE", false),
    ],
  };
}

function dispatchFor(stageId, {
  data = {},
  maxChars = stageId === "REPORT_SHORT" ? 100 : null,
  outputPath = stageId === "REPORT_EXPERT" ? "storydev:/reports/acceptance-report.html" : null,
  riskLevel = "MEDIUM",
  mutate,
} = {}) {
  const schemaId = SCHEMA_BY_STAGE[stageId];
  let executionStatus = { status: "READY", profileId: null, blockers: [] };
  let executionProfile = null;
  let effectiveData = data;
  if (stageId === "REPAIR") {
    executionStatus = { status: "READY", profileId: "profile-repair", blockers: [] };
    executionProfile = {
      profileId: "profile-repair",
      rootId: "main",
      stageId,
      executors: [{ executorId: "executor-unit", action: "TEST", cwdRootId: "main", argv: ["test"], timeoutMs: 1000 }],
    };
    effectiveData = {
      ...data,
      localChecks: data.localChecks || [{
        checkId: "check-unit",
        name: "unit test",
        executorId: "executor-unit",
        action: "TEST",
        mandatory: true,
        rootId: "main",
      }],
    };
  } else if (stageId === "VERIFY_EXECUTE") {
    const plan = data.verificationPlan || verificationPlanFixture();
    executionStatus = { status: "READY", profileId: plan.profileId, blockers: [] };
    executionProfile = {
      profileId: plan.profileId,
      rootId: "main",
      stageId,
      executors: plan.cases.map((entry) => ({
        executorId: entry.executorId,
        action: entry.action,
        cwdRootId: entry.target.rootId,
        adapterId: "fixture",
        timeoutMs: 1000,
      })),
    };
    effectiveData = { ...data, verificationPlan: plan };
  }
  const context = {
    schemaVersion: "tb-stage-context-v2",
    contextId: CONTEXT_ID,
    revision: 3,
    idempotencyKey: CONTEXT_KEY,
    story: {
      storyId: STORY_ID,
      title: "M4 structured result",
    },
    stage: {
      id: stageId,
      attempt: 1,
      riskLevel,
      ...(stageId.startsWith("REPORT_") ? {
        reportMode: stageId === "REPORT_SHORT" ? "SHORT" : "EXPERT",
      } : {}),
    },
    task: {
      instruction: "仅执行当前冻结阶段",
      successCriteria: ["满足结构化结果合同"],
    },
    scope: {
      roots: [{ rootId: "main", kind: "MAIN", writable: stageId === "REPAIR" }],
    },
    capabilities: {
      allowedTools: [],
      canWriteSource: stageId === "REPAIR",
      canReadGit: false,
      canWriteGit: false,
      canCommit: false,
      canUseDevice: stageId === "VERIFY_EXECUTE",
      canWriteTb: false,
      canWriteReport: stageId === "REPORT_EXPERT",
      maxToolIterations: 0,
      structuredOutput: "JSON_TEXT",
      longProcessProtocol: "NONE",
    },
    checkpoint: { ref: "storydev:/workflow-v2/checkpoint/1" },
    data: effectiveData,
    output: {
      schemaId,
      maxChars,
      outputPath,
    },
  };
  const dispatch = {
    promptMode: "structured",
    stageId,
    resultSchemaId: schemaId,
    contextId: context.contextId,
    contextRevision: context.revision,
    context,
    executionStatus,
    executionProfile,
    structuredOutput: {
      mode: "structured",
      strategy: "json_text",
      schemaId,
      contextId: context.contextId,
      contextRevision: context.revision,
      idempotencyKey: context.idempotencyKey,
    },
  };
  mutate?.(dispatch);
  return deepFreeze(dispatch);
}

function identity() {
  return {
    contextId: CONTEXT_ID,
    contextRevision: 3,
    idempotencyKey: CONTEXT_KEY,
  };
}

function triageResult(overrides = {}) {
  return {
    schemaVersion: "triage-result-v2",
    ...identity(),
    status: "COMPLETED",
    classification: "CLIENT_ISSUE",
    confidence: "HIGH",
    rootCause: {
      symptom: "页面错误",
      trigger: "点击入口",
      observedBehavior: "状态未更新",
      directCause: "边界遗漏",
      faultOwner: "客户端",
      workaroundOwner: "客户端",
    },
    claims: [{
      text: "客户端边界遗漏导致状态未更新",
      status: "SUPPORTED",
      evidenceFor: ["ev-available", "ev-partial"],
      evidenceAgainst: [],
    }],
    evidenceRead: [],
    evidenceUnread: [],
    recommendedAction: "进入修复",
    userSummary: "已确认客户端边界错误",
    nextStage: "REPAIR",
    ...overrides,
  };
}

function repairResult(overrides = {}) {
  return {
    schemaVersion: "repair-result-v2",
    ...identity(),
    status: "COMPLETED",
    outcome: "FIXED",
    rootCause: "边界遗漏",
    changes: [{
      rootId: "main",
      path: "src/a.js",
      summary: "增加边界检查",
      receiptIds: ["receipt-edit"],
    }],
    localChecks: [{
      name: "unit test",
      status: "PASS",
      receiptIds: ["receipt-test"],
    }],
    risks: [],
    remaining: [],
    userFriendlyCause: "边界值没有被识别",
    userFriendlyMeasure: "补充边界检查",
    changeSummary: "修复边界判断",
    evidenceRead: [],
    evidenceUnread: [],
    nextStage: "LOCAL_GATE",
    summary: "修复完成",
    ...overrides,
  };
}

function verificationResult(overrides = {}) {
  return {
    schemaVersion: "verification-result-v2",
    ...identity(),
    status: "COMPLETED",
    conclusion: "PASS",
    planId: "plan-m4",
    environment: {},
    cases: [
      {
        caseId: "mandatory-1",
        status: "PASS",
        receiptIds: ["receipt-verify"],
        evidenceRefs: ["ev-verify"],
      },
      {
        caseId: "optional-1",
        status: "NOT_RUN",
        receiptIds: [],
      },
    ],
    mandatorySummary: {
      total: 1,
      passed: 1,
      failed: 0,
      blocked: 0,
      notRun: 0,
    },
    remaining: [],
    nextStage: "REPORT_SHORT",
    summary: "mandatory case passed",
    ...overrides,
  };
}

function shortReportResult(reportText = "原因：边界遗漏。措施：补充检查。") {
  return {
    schemaVersion: "short-report-result-v2",
    ...identity(),
    reportText,
  };
}

function expertReportResult(overrides = {}) {
  return {
    schemaVersion: "expert-report-result-v2",
    ...identity(),
    status: "COMPLETED",
    htmlRef: "storydev:/reports/acceptance-report.html",
    usedEvidenceIds: ["ev-verify"],
    usedAssetIds: [],
    warnings: [],
    summary: "报告已生成",
    ...overrides,
  };
}

function receiptEnvelope(receiptId, {
  evidenceId = null,
  status = "PASS",
  action = "READ",
  rootId = null,
  selector = {},
  sha256 = null,
} = {}) {
  const payloadIdempotencyKey = action === "READ" ? null : `operation-key-${receiptId}`;
  const effectiveSelector = {
    contextId: CONTEXT_ID,
    contextRevision: 3,
    ...selector,
  };
  if (action === "EDIT" && effectiveSelector.path) {
    effectiveSelector.beforeExists ??= true;
    effectiveSelector.beforeSha256 ??= EDIT_BEFORE_SHA;
    effectiveSelector.afterExists ??= true;
    effectiveSelector.afterSha256 ??= EDIT_AFTER_SHA;
  }
  if (["BUILD", "TEST"].includes(action) && effectiveSelector.name) {
    effectiveSelector.checkId ??= "check-unit";
    effectiveSelector.executorId ??= "executor-unit";
  }
  if (effectiveSelector.caseId) {
    effectiveSelector.executorId ??= `executor-${effectiveSelector.caseId}`;
  }
  return {
    schemaVersion: "workflow-envelope-v2",
    storyId: STORY_ID,
    recordId: receiptId,
    contextId: null,
    revision: 1,
    idempotencyKey: `envelope-key-${receiptId}`,
    payloadSchemaId: WORKFLOW_V2_SCHEMA_IDS.evidenceReceipt,
    payloadSha256: "a".repeat(64),
    operationArgsSha256: "b".repeat(64),
    previousEnvelopeSha256: null,
    createdAt: "2026-08-07T10:00:00.000Z",
    payload: {
      schemaVersion: "evidence-receipt-v2",
      receiptId,
      evidenceId,
      action,
      status,
      startedAt: "2026-08-07T09:59:59.000Z",
      finishedAt: "2026-08-07T10:00:00.000Z",
      toolName: "m4-fixture",
      operationId: `operation-${receiptId}`,
      idempotencyKey: payloadIdempotencyKey,
      rootId: rootId ?? (["EDIT", "BUILD", "TEST", "DEVICE_ACTION", "DB_QUERY", "CAPTURE"].includes(action) ? "main" : null),
      selector: effectiveSelector,
      sha256,
    },
    envelopeSha256: "c".repeat(64),
  };
}

function systemGate(dispatch, result, {
  status = "PASS",
  planId,
  htmlRef,
  overrides = {},
} = {}) {
  return deepFreeze({
    status,
    storyId: dispatch.context.story.storyId,
    contextId: dispatch.contextId,
    contextRevision: dispatch.contextRevision,
    resultSha256: canonicalSha256(result),
    ...(planId !== undefined ? { planId } : {}),
    ...(htmlRef !== undefined ? { htmlRef } : {}),
    ...overrides,
  });
}

function receiptReader(envelopes, onRead = () => {}) {
  return async ({ tab, payloadSchemaId }) => {
    onRead();
    assert.equal(tab, TAB);
    assert.equal(payloadSchemaId, WORKFLOW_V2_SCHEMA_IDS.evidenceReceipt);
    const snapshot = structuredClone(envelopes);
    for (const envelope of snapshot) {
      const receipt = envelope?.payload;
      if (!["BUILD", "TEST"].includes(receipt?.action)
        || receipt?.selector?.editStateSha256) continue;
      const state = deriveWorkflowV2EditState({
        envelopes: snapshot,
        storyId: STORY_ID,
        contextId: receipt.selector.contextId,
        contextRevision: receipt.selector.contextRevision,
        rootId: receipt.rootId,
      });
      receipt.selector.editStateSha256 = state.editStateSha256;
      receipt.selector.editStateVersionSha256 = state.editStateVersionSha256;
    }
    return snapshot;
  };
}

function bindRepairChecksToLatestEditState(envelopes) {
  const state = deriveWorkflowV2EditState({
    envelopes,
    storyId: STORY_ID,
    contextId: CONTEXT_ID,
    contextRevision: 3,
    rootId: "main",
    requireChanges: true,
  });
  for (const envelope of envelopes) {
    if (!["BUILD", "TEST"].includes(envelope.payload?.action)) continue;
    envelope.payload.selector.editStateSha256 = state.editStateSha256;
    envelope.payload.selector.editStateVersionSha256 = state.editStateVersionSha256;
  }
  return envelopes;
}

test("strict parser 只接受单一 JSON object，并对 object 输入 clone + deep freeze", () => {
  for (const rawResult of [
    "```json\n{\"ok\":true}\n```",
    "前言 {\"ok\":true}",
    "{\"ok\":true} 后缀",
    "{\"one\":1}{\"two\":2}",
  ]) {
    assert.throws(
      () => parseStrictStructuredResult(rawResult),
      { code: "WORKFLOW_V2_STRUCTURED_RESULT_JSON_INVALID" },
      rawResult,
    );
  }
  for (const rawResult of ["[]", "null", "true", "1", [], null]) {
    assert.throws(() => parseStrictStructuredResult(rawResult), undefined, String(rawResult));
  }

  const original = { nested: { values: [1, 2] } };
  const parsed = parseStrictStructuredResult(original);
  assert.deepEqual(parsed, original);
  assert.notEqual(parsed, original);
  assert.notEqual(parsed.nested, original.nested);
  assert.equal(Object.isFrozen(parsed), true);
  assert.equal(Object.isFrozen(parsed.nested), true);
  assert.equal(Object.isFrozen(parsed.nested.values), true);
  original.nested.values.push(3);
  assert.deepEqual(parsed.nested.values, [1, 2]);
  assert.throws(() => { parsed.nested.values[0] = 9; }, TypeError);

  let getterCalls = 0;
  const accessor = {};
  Object.defineProperty(accessor, "value", {
    enumerable: true,
    get() { getterCalls += 1; return 1; },
  });
  assert.throws(
    () => parseStrictStructuredResult(accessor),
    { code: "WORKFLOW_V2_STRUCTURED_RESULT_VALUE_INVALID" },
  );
  assert.equal(getterCalls, 0, "parser 不得执行 object 输入的 getter");
});

test("gate 使用 registry exact stage schema，并精确绑定冻结 dispatch identity", async () => {
  const dispatch = dispatchFor("REPORT_SHORT");
  const valid = await evaluateStructuredWorkflowResult({
    dispatch,
    rawResult: `  ${JSON.stringify(shortReportResult())}\n`,
    tab: TAB,
  });
  assert.equal(valid.ok, true, valid.error);
  assert.equal(valid.legacyEvent.kind, "report_done");
  assert.equal(Object.isFrozen(valid.result), true);

  for (const mutate of [
    (value) => { value.contextId = "another-context"; },
    (value) => { value.contextRevision = 4; },
    (value) => { value.idempotencyKey = "another-idempotency-key"; },
  ]) {
    const result = shortReportResult();
    mutate(result);
    const rejected = await evaluateStructuredWorkflowResult({ dispatch, rawResult: result, tab: TAB });
    assert.equal(rejected.ok, false);
    assert.equal(rejected.code, "WORKFLOW_V2_STRUCTURED_RESULT_IDENTITY_MISMATCH");
    assert.equal(rejected.legacyEvent, null);
  }

  const wrongSchemaDispatch = dispatchFor("REPORT_SHORT", {
    mutate(value) { value.resultSchemaId = WORKFLOW_V2_SCHEMA_IDS.repairResult; },
  });
  const wrongSchema = await evaluateStructuredWorkflowResult({
    dispatch: wrongSchemaDispatch,
    rawResult: shortReportResult(),
    tab: TAB,
  });
  assert.equal(wrongSchema.ok, false);
  assert.equal(wrongSchema.code, "WORKFLOW_V2_STRUCTURED_SCHEMA_IDENTITY_MISMATCH");

  const mutableDispatch = structuredClone(dispatch);
  const mutable = await evaluateStructuredWorkflowResult({
    dispatch: mutableDispatch,
    rawResult: shortReportResult(),
    tab: TAB,
  });
  assert.equal(mutable.ok, false);
  assert.equal(mutable.code, "WORKFLOW_V2_STRUCTURED_DISPATCH_NOT_FROZEN");
});

test("deepseek 回带的 $schema 元字段被剥离，其它额外字段仍拒绝", async () => {
  const dispatch = dispatchFor("REPORT_SHORT");
  const withMeta = shortReportResult();
  withMeta.$schema = "https://json-schema.org/draft/2020-12/schema";
  const accepted = await evaluateStructuredWorkflowResult({
    dispatch,
    rawResult: withMeta,
    tab: TAB,
  });
  assert.equal(accepted.ok, true, accepted.error);
  assert.equal(accepted.legacyEvent.kind, "report_done");
  assert.equal(Object.hasOwn(accepted.result, "$schema"), false, "清洗后的结果不得残留 $schema");

  const extraField = shortReportResult();
  extraField.sneaky = "must-reject";
  const rejected = await evaluateStructuredWorkflowResult({
    dispatch,
    rawResult: extraField,
    tab: TAB,
  });
  assert.equal(rejected.ok, false);
  assert.equal(rejected.code, "WORKFLOW_V2_STRUCTURED_SCHEMA_VALIDATION_FAILED");
});

test("TRIAGE required AVAILABLE/PARTIAL evidence 必须逐项绑定真实 PASS receipt", async () => {
  const availableSha256 = "d".repeat(64);
  const manifest = evidenceManifest([
    evidenceItem("ev-available", { type: "TEXT", sha256: availableSha256 }),
    evidenceItem("ev-partial", { availability: "PARTIAL", type: "LOG" }),
    evidenceItem("ev-missing", { required: false, availability: "MISSING" }),
  ]);
  const dispatch = dispatchFor("TRIAGE", { data: { evidenceManifest: manifest } });
  const rawResult = triageResult({
    classification: "CROSS_COMPONENT",
    evidenceRead: [
      { evidenceId: "ev-available", receiptIds: ["receipt-available"], finding: "读取完成" },
      { evidenceId: "ev-partial", receiptIds: ["receipt-partial"], finding: "读取可用部分" },
    ],
  });
  const receipts = [
    receiptEnvelope("receipt-available", { evidenceId: "ev-available", sha256: availableSha256 }),
    receiptEnvelope("receipt-partial", { evidenceId: "ev-partial" }),
  ];
  const accepted = await evaluateStructuredWorkflowResult({
    dispatch,
    rawResult,
    tab: TAB,
    readEnvelopes: receiptReader(receipts),
  });
  assert.equal(accepted.ok, true, accepted.error);
  assert.equal(accepted.legacyEvent.kind, "triage_is_bug");
  assert.deepEqual(accepted.receiptIds, ["receipt-available", "receipt-partial"]);
  assert.notEqual(accepted.result, rawResult, "object input 必须 snapshot");

  const nonClient = await evaluateStructuredWorkflowResult({
    dispatch,
    rawResult: {
      ...structuredClone(rawResult),
      classification: "NON_CLIENT_ISSUE",
      nextStage: "REJECT_PENDING",
    },
    tab: TAB,
    readEnvelopes: receiptReader(receipts),
  });
  assert.equal(nonClient.ok, true);
  assert.equal(nonClient.legacyEvent.kind, "triage_not_bug");

  const missingRequired = structuredClone(rawResult);
  missingRequired.evidenceRead.pop();
  const missing = await evaluateStructuredWorkflowResult({
    dispatch,
    rawResult: missingRequired,
    tab: TAB,
    readEnvelopes: receiptReader(receipts),
  });
  assert.equal(missing.ok, false);
  assert.equal(missing.code, "WORKFLOW_V2_STRUCTURED_TRIAGE_EVIDENCE_INSUFFICIENT");
  assert.equal(missing.legacyEvent, null);

  const unavailableDispatch = dispatchFor("TRIAGE", {
    data: {
      evidenceManifest: evidenceManifest([
        evidenceItem("ev-available"),
        evidenceItem("ev-required-missing", { availability: "MISSING" }),
      ]),
    },
  });
  const unavailable = await evaluateStructuredWorkflowResult({
    dispatch: unavailableDispatch,
    rawResult: triageResult({
      evidenceRead: [{ evidenceId: "ev-available", receiptIds: ["receipt-available"] }],
      evidenceUnread: [{ evidenceId: "ev-required-missing", reason: "材料缺失" }],
    }),
    tab: TAB,
    readEnvelopes: receiptReader(receipts),
  });
  assert.equal(unavailable.ok, false);
  assert.equal(unavailable.code, "WORKFLOW_V2_STRUCTURED_TRIAGE_REQUIRED_EVIDENCE_UNAVAILABLE");

  for (const invalidReference of [
    triageResult({
      evidenceRead: [
        ...structuredClone(rawResult.evidenceRead),
        { evidenceId: "ev-outside", receiptIds: ["receipt-outside"] },
      ],
    }),
    triageResult({
      evidenceRead: structuredClone(rawResult.evidenceRead),
      evidenceUnread: [{ evidenceId: "ev-outside", reason: "not in manifest" }],
    }),
  ]) {
    const rejected = await evaluateStructuredWorkflowResult({
      dispatch,
      rawResult: invalidReference,
      tab: TAB,
      readEnvelopes: receiptReader(receipts),
    });
    assert.equal(rejected.ok, false);
    assert.equal(rejected.code, "WORKFLOW_V2_STRUCTURED_TRIAGE_EVIDENCE_REFERENCE_INVALID");
  }

  const duplicateEvidenceRead = structuredClone(rawResult);
  duplicateEvidenceRead.evidenceRead.push(structuredClone(duplicateEvidenceRead.evidenceRead[0]));
  duplicateEvidenceRead.evidenceRead[2].receiptIds = ["receipt-available-2"];
  const duplicateEvidenceRejected = await evaluateStructuredWorkflowResult({
    dispatch,
    rawResult: duplicateEvidenceRead,
    tab: TAB,
    readEnvelopes: receiptReader(receipts),
  });
  assert.equal(duplicateEvidenceRejected.ok, false);
  assert.equal(duplicateEvidenceRejected.code, "WORKFLOW_V2_STRUCTURED_EVIDENCE_CLAIM_INVALID");

  for (const [label, alteredReceipts, expectedCode] of [
    ["missing receipt", receipts.slice(0, 1), "WORKFLOW_V2_STRUCTURED_RECEIPT_NOT_FOUND"],
    ["failed receipt", [receipts[0], receiptEnvelope("receipt-partial", { evidenceId: "ev-partial", status: "FAIL" })], "WORKFLOW_V2_STRUCTURED_RECEIPT_NOT_PASS"],
    ["wrong evidence", [receipts[0], receiptEnvelope("receipt-partial", { evidenceId: "ev-other" })], "WORKFLOW_V2_STRUCTURED_RECEIPT_EVIDENCE_MISMATCH"],
    ["wrong action", [receipts[0], receiptEnvelope("receipt-partial", { evidenceId: "ev-partial", action: "TEST" })], "WORKFLOW_V2_STRUCTURED_RECEIPT_ACTION_MISMATCH"],
  ]) {
    const rejected = await evaluateStructuredWorkflowResult({
      dispatch,
      rawResult,
      tab: TAB,
      readEnvelopes: receiptReader(alteredReceipts),
    });
    assert.equal(rejected.ok, false, label);
    assert.equal(rejected.code, expectedCode, label);
    assert.equal(rejected.legacyEvent, null, label);
  }

  const insufficient = await evaluateStructuredWorkflowResult({
    dispatch,
    rawResult: {
      ...structuredClone(rawResult),
      classification: "INSUFFICIENT_EVIDENCE",
      nextStage: "BLOCKED",
    },
    tab: TAB,
    readEnvelopes: receiptReader(receipts),
  });
  assert.equal(insufficient.ok, false);
  assert.equal(insufficient.code, "WORKFLOW_V2_STRUCTURED_TRIAGE_EVIDENCE_INSUFFICIENT");
});

test("REPAIR 仅 COMPLETED+FIXED、非空 changes/localChecks、检查全 PASS 且 receipt 真实才 FIX_DONE", async () => {
  const dispatch = dispatchFor("REPAIR");
  const receipts = bindRepairChecksToLatestEditState([
    receiptEnvelope("receipt-edit", {
      action: "EDIT",
      rootId: "main",
      selector: { path: "src/a.js" },
    }),
    receiptEnvelope("receipt-test", { action: "TEST", selector: { name: "unit test" } }),
  ]);
  const accepted = await evaluateStructuredWorkflowResult({
    dispatch,
    rawResult: repairResult(),
    tab: TAB,
    readEnvelopes: receiptReader(receipts),
  });
  assert.equal(accepted.ok, true, accepted.error);
  assert.equal(accepted.legacyEvent.kind, "fix_done");

  const staleAfterSecondEdit = await evaluateStructuredWorkflowResult({
    dispatch,
    rawResult: repairResult(),
    tab: TAB,
    readEnvelopes: receiptReader([
      ...receipts,
      receiptEnvelope("receipt-edit-second", {
        action: "EDIT",
        rootId: "main",
        selector: {
          path: "src/a.js",
          beforeExists: true,
          beforeSha256: EDIT_AFTER_SHA,
          afterExists: true,
          afterSha256: "e".repeat(64),
        },
      }),
    ]),
  });
  assert.equal(staleAfterSecondEdit.ok, false);
  assert.equal(staleAfterSecondEdit.code, "WORKFLOW_V2_STRUCTURED_EDIT_STATE_STALE");

  const invalidCases = [
    repairResult({ status: "PARTIAL" }),
    repairResult({ outcome: "NOT_FIXED" }),
    repairResult({ changes: [] }),
    repairResult({ localChecks: [] }),
    repairResult({ localChecks: [{ name: "unit test", status: "FAIL", receiptIds: ["receipt-test"] }] }),
    repairResult({ changes: [{ rootId: "main", path: "src/a.js", summary: "change", receiptIds: [] }] }),
  ];
  for (const rawResult of invalidCases) {
    const rejected = await evaluateStructuredWorkflowResult({
      dispatch,
      rawResult,
      tab: TAB,
      readEnvelopes: receiptReader(receipts),
    });
    assert.equal(rejected.ok, false);
    assert.equal(rejected.code, "WORKFLOW_V2_STRUCTURED_REPAIR_GATE_BLOCKED");
    assert.equal(rejected.legacyEvent, null);
  }

  const missingReceipt = await evaluateStructuredWorkflowResult({
    dispatch,
    rawResult: repairResult(),
    tab: TAB,
    readEnvelopes: receiptReader(receipts.slice(0, 1)),
  });
  assert.equal(missingReceipt.ok, false);
  assert.equal(missingReceipt.code, "WORKFLOW_V2_STRUCTURED_RECEIPT_NOT_FOUND");

  const wrongAction = await evaluateStructuredWorkflowResult({
    dispatch,
    rawResult: repairResult(),
    tab: TAB,
    readEnvelopes: receiptReader([
      receiptEnvelope("receipt-edit", { action: "READ" }),
      receiptEnvelope("receipt-test", { action: "TEST", selector: { name: "unit test" } }),
    ]),
  });
  assert.equal(wrongAction.ok, false);
  assert.equal(wrongAction.code, "WORKFLOW_V2_STRUCTURED_RECEIPT_ACTION_MISMATCH");

  const duplicateReceipt = repairResult();
  duplicateReceipt.localChecks[0].receiptIds = ["receipt-edit"];
  const duplicateRejected = await evaluateStructuredWorkflowResult({
    dispatch,
    rawResult: duplicateReceipt,
    tab: TAB,
    readEnvelopes: receiptReader(receipts),
  });
  assert.equal(duplicateRejected.ok, false);
  assert.equal(duplicateRejected.code, "WORKFLOW_V2_STRUCTURED_RECEIPT_CLAIM_DUPLICATE");

  const duplicateCheck = repairResult();
  duplicateCheck.localChecks.push({
    name: "unit test",
    status: "PASS",
    receiptIds: ["receipt-test-2"],
  });
  const duplicateCheckRejected = await evaluateStructuredWorkflowResult({
    dispatch,
    rawResult: duplicateCheck,
    tab: TAB,
    readEnvelopes: receiptReader(receipts),
  });
  assert.equal(duplicateCheckRejected.ok, false);
  assert.equal(duplicateCheckRejected.code, "WORKFLOW_V2_STRUCTURED_REPAIR_CLAIM_DUPLICATE");

  const duplicateChange = repairResult();
  duplicateChange.changes.push({
    rootId: "main",
    path: "src/a.js",
    summary: "重复声明",
    receiptIds: ["receipt-edit-2"],
  });
  const duplicateChangeRejected = await evaluateStructuredWorkflowResult({
    dispatch,
    rawResult: duplicateChange,
    tab: TAB,
    readEnvelopes: receiptReader(receipts),
  });
  assert.equal(duplicateChangeRejected.ok, false);
  assert.equal(duplicateChangeRejected.code, "WORKFLOW_V2_STRUCTURED_REPAIR_CLAIM_DUPLICATE");
});

test("VERIFY 默认 blocked；只有显式系统 PASS、计划/cases/summary 一致且 mandatory receipts 完整才 PASS", async () => {
  const dispatch = dispatchFor("VERIFY_EXECUTE", {
    data: {
      verificationPlan: verificationPlanFixture(),
    },
  });
  const receipts = [receiptEnvelope("receipt-verify", {
    evidenceId: "ev-verify",
    action: "TEST",
    selector: { caseId: "mandatory-1" },
  })];
  const passingResult = verificationResult();
  let defaultReads = 0;
  const blocked = await evaluateStructuredWorkflowResult({
    dispatch,
    rawResult: passingResult,
    tab: TAB,
    readEnvelopes: receiptReader(receipts, () => { defaultReads += 1; }),
  });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.code, "WORKFLOW_V2_STRUCTURED_VERIFY_SYSTEM_GATE_BLOCKED");
  assert.equal(blocked.legacyEvent, null);
  assert.equal(defaultReads, 0, "默认 blocked 不应先执行 receipt I/O");

  const accepted = await evaluateStructuredWorkflowResult({
    dispatch,
    rawResult: passingResult,
    tab: TAB,
    trustedSystemGate: systemGate(dispatch, passingResult, { planId: passingResult.planId }),
    readEnvelopes: receiptReader(receipts),
  });
  assert.equal(accepted.ok, true, accepted.error);
  assert.equal(accepted.legacyEvent.kind, "verify_pass");

  const inconsistentSummary = verificationResult({
    mandatorySummary: { total: 2, passed: 2, failed: 0, blocked: 0, notRun: 0 },
  });
  const summaryRejected = await evaluateStructuredWorkflowResult({
    dispatch,
    rawResult: inconsistentSummary,
    tab: TAB,
    trustedSystemGate: systemGate(dispatch, inconsistentSummary, { planId: inconsistentSummary.planId }),
    readEnvelopes: receiptReader(receipts),
  });
  assert.equal(summaryRejected.ok, false);
  assert.equal(summaryRejected.code, "WORKFLOW_V2_STRUCTURED_VERIFY_SUMMARY_INCONSISTENT");

  const failedMandatory = verificationResult({
    cases: [
      { caseId: "mandatory-1", status: "FAIL", receiptIds: ["receipt-verify"], evidenceRefs: ["ev-verify"] },
      { caseId: "optional-1", status: "NOT_RUN", receiptIds: [] },
    ],
    mandatorySummary: { total: 1, passed: 0, failed: 1, blocked: 0, notRun: 0 },
  });
  const caseRejected = await evaluateStructuredWorkflowResult({
    dispatch,
    rawResult: failedMandatory,
    tab: TAB,
    trustedSystemGate: systemGate(dispatch, failedMandatory, { planId: failedMandatory.planId }),
    readEnvelopes: receiptReader(receipts),
  });
  assert.equal(caseRejected.ok, false);
  assert.equal(caseRejected.code, "WORKFLOW_V2_STRUCTURED_VERIFY_PASS_BLOCKED");

  const missingMandatoryReceipt = verificationResult();
  missingMandatoryReceipt.cases[0].receiptIds = [];
  const receiptRejected = await evaluateStructuredWorkflowResult({
    dispatch,
    rawResult: missingMandatoryReceipt,
    tab: TAB,
    trustedSystemGate: systemGate(dispatch, missingMandatoryReceipt, { planId: missingMandatoryReceipt.planId }),
    readEnvelopes: receiptReader(receipts),
  });
  assert.equal(receiptRejected.ok, false);
  assert.equal(receiptRejected.code, "WORKFLOW_V2_STRUCTURED_VERIFY_PASS_BLOCKED");

  const missingEvidenceRef = verificationResult();
  missingEvidenceRef.cases[0].evidenceRefs = [];
  const evidenceRefRejected = await evaluateStructuredWorkflowResult({
    dispatch,
    rawResult: missingEvidenceRef,
    tab: TAB,
    trustedSystemGate: systemGate(dispatch, missingEvidenceRef, { planId: missingEvidenceRef.planId }),
    readEnvelopes: receiptReader(receipts),
  });
  assert.equal(evidenceRefRejected.ok, false);
  assert.equal(evidenceRefRejected.code, "WORKFLOW_V2_STRUCTURED_VERIFY_PASS_BLOCKED");

  const wrongAction = await evaluateStructuredWorkflowResult({
    dispatch,
    rawResult: passingResult,
    tab: TAB,
    trustedSystemGate: systemGate(dispatch, passingResult, { planId: passingResult.planId }),
    readEnvelopes: receiptReader([
      receiptEnvelope("receipt-verify", {
        evidenceId: "ev-verify",
        action: "READ",
        selector: { caseId: "mandatory-1" },
      }),
    ]),
  });
  assert.equal(wrongAction.ok, false);
  assert.equal(wrongAction.code, "WORKFLOW_V2_STRUCTURED_RECEIPT_ACTION_MISMATCH");

  const duplicateReceipt = verificationResult();
  duplicateReceipt.cases[1] = {
    caseId: "optional-1",
    status: "PASS",
    receiptIds: ["receipt-verify"],
    evidenceRefs: ["ev-verify"],
  };
  const duplicateReceiptRejected = await evaluateStructuredWorkflowResult({
    dispatch,
    rawResult: duplicateReceipt,
    tab: TAB,
    trustedSystemGate: systemGate(dispatch, duplicateReceipt, { planId: duplicateReceipt.planId }),
    readEnvelopes: receiptReader(receipts),
  });
  assert.equal(duplicateReceiptRejected.ok, false);
  assert.equal(duplicateReceiptRejected.code, "WORKFLOW_V2_STRUCTURED_RECEIPT_CLAIM_DUPLICATE");

  const duplicateCaseId = verificationResult();
  duplicateCaseId.cases[1].caseId = "mandatory-1";
  const duplicateCaseRejected = await evaluateStructuredWorkflowResult({
    dispatch,
    rawResult: duplicateCaseId,
    tab: TAB,
    trustedSystemGate: systemGate(dispatch, duplicateCaseId, { planId: duplicateCaseId.planId }),
    readEnvelopes: receiptReader(receipts),
  });
  assert.equal(duplicateCaseRejected.ok, false);
  assert.equal(duplicateCaseRejected.code, "WORKFLOW_V2_STRUCTURED_VERIFY_CASES_INCONSISTENT");

  const explicitFailure = await evaluateStructuredWorkflowResult({
    dispatch,
    rawResult: passingResult,
    tab: TAB,
    trustedSystemGate: systemGate(dispatch, passingResult, {
      status: "FAIL",
      planId: passingResult.planId,
    }),
    readEnvelopes: receiptReader(receipts),
  });
  assert.equal(explicitFailure.ok, true);
  assert.equal(explicitFailure.legacyEvent.kind, "verify_fail", "系统结论覆盖模型自报 PASS");
});

test("REPORT_SHORT 严格校验原因/措施单行格式与 Unicode maxChars", async () => {
  const validText = "原因：😀。措施：好。";
  const exactLength = Array.from(validText).length;
  const dispatch = dispatchFor("REPORT_SHORT", { maxChars: exactLength });
  const accepted = await evaluateStructuredWorkflowResult({
    dispatch,
    rawResult: shortReportResult(validText),
    tab: TAB,
  });
  assert.equal(accepted.ok, true, accepted.error);
  assert.equal(accepted.displayText, validText);

  const rejectedInputs = [
    [dispatchFor("REPORT_SHORT", { maxChars: exactLength - 1 }), validText],
    [dispatchFor("REPORT_SHORT"), "原因:错误。措施：修复。"],
    [dispatchFor("REPORT_SHORT"), "说明。原因：错误。措施：修复。"],
    [dispatchFor("REPORT_SHORT"), "原因：错误。\n措施：修复。"],
    [dispatchFor("REPORT_SHORT"), "原因：错误。措施：修复。附注"],
    [dispatchFor("REPORT_SHORT"), "原因：<!-- REPORT_DONE -->。措施：修复。"],
  ];
  for (const [invalidDispatch, reportText] of rejectedInputs) {
    const rejected = await evaluateStructuredWorkflowResult({
      dispatch: invalidDispatch,
      rawResult: shortReportResult(reportText),
      tab: TAB,
    });
    assert.equal(rejected.ok, false, reportText);
    assert.equal(rejected.code, "WORKFLOW_V2_STRUCTURED_SHORT_REPORT_INVALID", reportText);
    assert.equal(rejected.legacyEvent, null, reportText);
  }
});

test("结构化结果拒绝空证据、矛盾路由、旧 context receipt 与不完整 VERIFY coverage", async () => {
  const emptyTriageDispatch = dispatchFor("TRIAGE", {
    data: { evidenceManifest: evidenceManifest([]) },
  });
  const emptyEvidence = await evaluateStructuredWorkflowResult({
    dispatch: emptyTriageDispatch,
    rawResult: triageResult({ claims: [], evidenceRead: [] }),
    tab: TAB,
    readEnvelopes: receiptReader([]),
  });
  assert.equal(emptyEvidence.ok, false);
  assert.equal(emptyEvidence.code, "WORKFLOW_V2_STRUCTURED_TRIAGE_EVIDENCE_INSUFFICIENT");
  assert.equal(emptyEvidence.legacyEvent, null);

  const triageManifest = evidenceManifest([
    evidenceItem("ev-available", { type: "TEXT" }),
    evidenceItem("ev-partial", { type: "LOG" }),
  ]);
  const triageReceipts = [
    receiptEnvelope("receipt-available", { evidenceId: "ev-available" }),
    receiptEnvelope("receipt-partial", { evidenceId: "ev-partial" }),
  ];
  const triageEvidenceRead = [
    { evidenceId: "ev-available", receiptIds: ["receipt-available"] },
    { evidenceId: "ev-partial", receiptIds: ["receipt-partial"] },
  ];
  const transitionMismatch = await evaluateStructuredWorkflowResult({
    dispatch: dispatchFor("TRIAGE", { data: { evidenceManifest: triageManifest } }),
    rawResult: triageResult({ evidenceRead: triageEvidenceRead, nextStage: "REJECT_PENDING" }),
    tab: TAB,
    readEnvelopes: receiptReader(triageReceipts),
  });
  assert.equal(transitionMismatch.ok, false);
  assert.equal(transitionMismatch.code, "WORKFLOW_V2_STRUCTURED_TRIAGE_TRANSITION_MISMATCH");

  const highRiskDispatch = dispatchFor("TRIAGE", {
    data: { evidenceManifest: triageManifest },
    riskLevel: "HIGH",
  });
  const highRiskTriage = await evaluateStructuredWorkflowResult({
    dispatch: highRiskDispatch,
    rawResult: triageResult({ evidenceRead: triageEvidenceRead, nextStage: "DIAGNOSE_PLAN" }),
    tab: TAB,
    readEnvelopes: receiptReader(triageReceipts),
  });
  assert.equal(highRiskTriage.ok, false);
  assert.equal(highRiskTriage.code, "WORKFLOW_V2_STRUCTURED_LEGACY_ROUTE_UNSUPPORTED");
  assert.equal(highRiskTriage.legacyEvent, null);

  const validRepairReceipts = bindRepairChecksToLatestEditState([
    receiptEnvelope("receipt-edit", {
      action: "EDIT",
      rootId: "main",
      selector: { path: "src/a.js" },
    }),
    receiptEnvelope("receipt-test", {
      action: "TEST",
      selector: { name: "unit test" },
    }),
  ]);
  const repairTransitionMismatch = await evaluateStructuredWorkflowResult({
    dispatch: dispatchFor("REPAIR"),
    rawResult: repairResult({ nextStage: "BLOCKED" }),
    tab: TAB,
    readEnvelopes: receiptReader(validRepairReceipts),
  });
  assert.equal(repairTransitionMismatch.ok, false);
  assert.equal(repairTransitionMismatch.code, "WORKFLOW_V2_STRUCTURED_REPAIR_TRANSITION_MISMATCH");

  const highRiskRepair = await evaluateStructuredWorkflowResult({
    dispatch: dispatchFor("REPAIR", { riskLevel: "CRITICAL" }),
    rawResult: repairResult(),
    tab: TAB,
    readEnvelopes: receiptReader(validRepairReceipts),
  });
  assert.equal(highRiskRepair.ok, false);
  assert.equal(highRiskRepair.code, "WORKFLOW_V2_STRUCTURED_LEGACY_ROUTE_UNSUPPORTED");

  const staleReceipt = await evaluateStructuredWorkflowResult({
    dispatch: dispatchFor("REPAIR"),
    rawResult: repairResult(),
    tab: TAB,
    readEnvelopes: receiptReader([
      receiptEnvelope("receipt-edit", {
        action: "EDIT",
        rootId: "main",
        selector: { path: "src/a.js", contextRevision: 2 },
      }),
      receiptEnvelope("receipt-test", {
        action: "TEST",
        selector: { name: "unit test", contextRevision: 2 },
      }),
    ]),
  });
  assert.equal(staleReceipt.ok, false);
  assert.equal(staleReceipt.code, "WORKFLOW_V2_STRUCTURED_RECEIPT_SEMANTIC_MISMATCH");

  const verifyDispatch = dispatchFor("VERIFY_EXECUTE", {
    data: {
      verificationPlan: verificationPlanFixture(),
    },
  });
  const incompleteCoverage = verificationResult();
  incompleteCoverage.cases[0].evidenceRefs = ["ev-verify", "ev-second"];
  const missingCoverage = await evaluateStructuredWorkflowResult({
    dispatch: verifyDispatch,
    rawResult: incompleteCoverage,
    tab: TAB,
    trustedSystemGate: systemGate(verifyDispatch, incompleteCoverage, {
      planId: incompleteCoverage.planId,
    }),
    readEnvelopes: receiptReader([
      receiptEnvelope("receipt-verify", {
        evidenceId: "ev-verify",
        action: "TEST",
        selector: { caseId: "mandatory-1" },
      }),
    ]),
  });
  assert.equal(missingCoverage.ok, false);
  assert.equal(missingCoverage.code, "WORKFLOW_V2_STRUCTURED_RECEIPT_EVIDENCE_COVERAGE_MISSING");
});

test("REPORT_EXPERT 只有 rendererGate 与 pdfGate 显式 PASS 且绑定 frozen outputPath 才 REPORT_DONE", async () => {
  const dispatch = dispatchFor("REPORT_EXPERT");
  const rawResult = expertReportResult();
  const rendererPass = systemGate(dispatch, rawResult, { htmlRef: rawResult.htmlRef });
  const pdfPass = systemGate(dispatch, rawResult, { htmlRef: rawResult.htmlRef });
  for (const gates of [
    {},
    { rendererGate: rendererPass },
    {
      rendererGate: rendererPass,
      pdfGate: systemGate(dispatch, rawResult, {
        status: "FAIL",
        htmlRef: rawResult.htmlRef,
      }),
    },
  ]) {
    const rejected = await evaluateStructuredWorkflowResult({
      dispatch,
      rawResult,
      tab: TAB,
      ...gates,
    });
    assert.equal(rejected.ok, false);
    assert.equal(rejected.code, "WORKFLOW_V2_STRUCTURED_EXPERT_REPORT_GATE_BLOCKED");
    assert.equal(rejected.legacyEvent, null);
  }

  const accepted = await evaluateStructuredWorkflowResult({
    dispatch,
    rawResult,
    tab: TAB,
    rendererGate: rendererPass,
    pdfGate: pdfPass,
  });
  assert.equal(accepted.ok, true, accepted.error);
  assert.equal(accepted.legacyEvent.kind, "report_done");

  const wrongOutput = await evaluateStructuredWorkflowResult({
    dispatch,
    rawResult: expertReportResult({ htmlRef: "storydev:/reports/other.html" }),
    tab: TAB,
    rendererGate: systemGate(
      dispatch,
      expertReportResult({ htmlRef: "storydev:/reports/other.html" }),
      { htmlRef: "storydev:/reports/other.html" },
    ),
    pdfGate: systemGate(
      dispatch,
      expertReportResult({ htmlRef: "storydev:/reports/other.html" }),
      { htmlRef: "storydev:/reports/other.html" },
    ),
  });
  assert.equal(wrongOutput.ok, false);
  assert.equal(wrongOutput.code, "WORKFLOW_V2_STRUCTURED_EXPERT_REPORT_GATE_BLOCKED");

  const mutableGate = await evaluateStructuredWorkflowResult({
    dispatch,
    rawResult,
    tab: TAB,
    rendererGate: { ...structuredClone(rendererPass) },
    pdfGate: pdfPass,
  });
  assert.equal(mutableGate.ok, false);
  assert.equal(mutableGate.code, "WORKFLOW_V2_STRUCTURED_SYSTEM_GATE_INVALID");

  const wrongGateIdentity = await evaluateStructuredWorkflowResult({
    dispatch,
    rawResult,
    tab: TAB,
    rendererGate: systemGate(dispatch, rawResult, {
      htmlRef: rawResult.htmlRef,
      overrides: { contextRevision: dispatch.contextRevision + 1 },
    }),
    pdfGate: pdfPass,
  });
  assert.equal(wrongGateIdentity.ok, false);
  assert.equal(wrongGateIdentity.code, "WORKFLOW_V2_STRUCTURED_SYSTEM_GATE_IDENTITY_MISMATCH");
});
