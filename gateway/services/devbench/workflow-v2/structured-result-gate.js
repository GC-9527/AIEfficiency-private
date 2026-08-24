import {
  WORKFLOW_V2_SCHEMA_IDS,
  workflowV2SchemaRegistry,
} from "./schema-registry.js";
import { canonicalSha256 } from "./envelope-store.js";
import { adaptStructuredResultToLegacyEvent } from "./legacy-result-adapter.js";
import {
  isControlledReceiptAction,
  verifyControlledReceiptOutput,
} from "./controlled-receipt-evidence.js";
import {
  deriveWorkflowV2EditState,
  receiptBindsWorkflowV2EditState,
} from "./edit-state-binding.js";

const RESULT_SCHEMA_BY_STAGE = Object.freeze({
  TRIAGE: WORKFLOW_V2_SCHEMA_IDS.triageResult,
  REPAIR: WORKFLOW_V2_SCHEMA_IDS.repairResult,
  VERIFY_EXECUTE: WORKFLOW_V2_SCHEMA_IDS.verificationResult,
  REPORT_SHORT: WORKFLOW_V2_SCHEMA_IDS.shortReportResult,
  REPORT_EXPERT: WORKFLOW_V2_SCHEMA_IDS.expertReportResult,
});

const RECEIPT_REQUIRED_AVAILABILITY = new Set(["AVAILABLE", "PARTIAL"]);
const EVIDENCE_READ_ACTIONS = Object.freeze(["READ", "SEARCH", "EXTRACT", "INSPECT"]);
const REPAIR_CHANGE_ACTIONS = Object.freeze(["EDIT"]);
const REPAIR_CHECK_ACTIONS = Object.freeze(["BUILD", "TEST"]);
const VERIFY_CASE_ACTIONS = Object.freeze(["BUILD", "TEST", "DEVICE_ACTION", "DB_QUERY", "CAPTURE"]);
const SHORT_REPORT_PATTERN = /^原因：([^\r\n]+)。措施：([^\r\n]+)。$/u;
const SHORT_REPORT_CONTROL_PATTERN = /<!--[\s\S]*?-->|\b(?:TRIAGE|VERIFY|IS_BUG|NOT_A_BUG|FIX_DONE|REPORT_DONE|NEXT|MARKER)\b/i;

function hasVerifiedEditTransition(selector) {
  if (!selector || typeof selector.beforeExists !== "boolean" || typeof selector.afterExists !== "boolean") return false;
  const validHash = (value) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
  if (selector.beforeExists ? !validHash(selector.beforeSha256) : selector.beforeSha256 !== null) return false;
  if (selector.afterExists ? !validHash(selector.afterSha256) : selector.afterSha256 !== null) return false;
  return selector.beforeExists !== selector.afterExists
    || selector.beforeSha256 !== selector.afterSha256;
}

export class WorkflowV2StructuredResultGateError extends Error {
  constructor(message, code, details = {}) {
    super(message);
    this.name = "WorkflowV2StructuredResultGateError";
    this.code = code;
    this.details = details;
  }
}

function fail(message, code, details = {}) {
  throw new WorkflowV2StructuredResultGateError(message, code, details);
}

function cloneJsonValue(value, seen = new Set(), path = "$") {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      fail("structured result 包含非有限数字", "WORKFLOW_V2_STRUCTURED_RESULT_VALUE_INVALID", { path });
    }
    return value;
  }
  if (!value || typeof value !== "object") {
    fail("structured result 包含非 JSON 值", "WORKFLOW_V2_STRUCTURED_RESULT_VALUE_INVALID", { path });
  }
  if (seen.has(value)) {
    fail("structured result 包含循环引用", "WORKFLOW_V2_STRUCTURED_RESULT_VALUE_INVALID", { path });
  }
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      for (const key of Reflect.ownKeys(value)) {
        if (key === "length") continue;
        if (typeof key !== "string" || !/^(?:0|[1-9]\d*)$/.test(key) || Number(key) >= value.length) {
          fail("structured result 数组包含非 JSON 属性", "WORKFLOW_V2_STRUCTURED_RESULT_VALUE_INVALID", { path });
        }
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value")) {
          fail("structured result 包含 accessor 或非枚举属性", "WORKFLOW_V2_STRUCTURED_RESULT_VALUE_INVALID", {
            path: `${path}[${key}]`,
          });
        }
      }
      const clone = [];
      for (let index = 0; index < value.length; index += 1) {
        if (!Object.hasOwn(value, index)) {
          fail("structured result 数组不能包含空槽", "WORKFLOW_V2_STRUCTURED_RESULT_VALUE_INVALID", {
            path: `${path}[${index}]`,
          });
        }
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        clone.push(cloneJsonValue(descriptor.value, seen, `${path}[${index}]`));
      }
      return clone;
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      fail("structured result 只接受普通 JSON 对象", "WORKFLOW_V2_STRUCTURED_RESULT_VALUE_INVALID", { path });
    }
    const clone = {};
    for (const key of Reflect.ownKeys(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (typeof key !== "string" || !descriptor?.enumerable || !Object.hasOwn(descriptor, "value")) {
        fail("structured result 包含非 JSON 属性", "WORKFLOW_V2_STRUCTURED_RESULT_VALUE_INVALID", { path });
      }
      Object.defineProperty(clone, key, {
        configurable: true,
        enumerable: true,
        writable: true,
        value: cloneJsonValue(descriptor.value, seen, `${path}.${key}`),
      });
    }
    return clone;
  } finally {
    seen.delete(value);
  }
}

function deepFreeze(value, seen = new Set()) {
  if (!value || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
}

/**
 * Parse exactly one JSON object. JSON whitespace is accepted; Markdown fences,
 * prose, suffixes, arrays, primitives, and concatenated objects are rejected.
 * Object inputs are copied without invoking accessors, then recursively frozen.
 */
export function parseStrictStructuredResult(rawResult) {
  let parsed;
  if (typeof rawResult === "string") {
    if (!rawResult.trim()) {
      fail("structured result 为空", "WORKFLOW_V2_STRUCTURED_RESULT_JSON_INVALID");
    }
    try {
      parsed = JSON.parse(rawResult);
    } catch {
      fail("structured result 不是单一合法 JSON", "WORKFLOW_V2_STRUCTURED_RESULT_JSON_INVALID");
    }
  } else if (rawResult && typeof rawResult === "object") {
    parsed = rawResult;
  } else {
    fail("structured result 必须是 JSON 文本或对象", "WORKFLOW_V2_STRUCTURED_RESULT_TYPE_INVALID");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    fail("structured result 顶层必须是单一 JSON object", "WORKFLOW_V2_STRUCTURED_RESULT_OBJECT_REQUIRED");
  }
  return deepFreeze(cloneJsonValue(parsed));
}

function isDeepFrozen(value, seen = new Set()) {
  if (!value || typeof value !== "object" || seen.has(value)) return true;
  if (!Object.isFrozen(value)) return false;
  seen.add(value);
  return Object.values(value).every((entry) => isDeepFrozen(entry, seen));
}

function assertFrozenDispatch(dispatch, tab, registry) {
  if (!dispatch || typeof dispatch !== "object" || Array.isArray(dispatch)) {
    fail("structured result 缺少 dispatch", "WORKFLOW_V2_STRUCTURED_DISPATCH_REQUIRED");
  }
  if (!isDeepFrozen(dispatch)) {
    fail("structured result 只能绑定递归冻结的 dispatch", "WORKFLOW_V2_STRUCTURED_DISPATCH_NOT_FROZEN");
  }
  const stageId = String(dispatch.stageId || "");
  const schemaId = RESULT_SCHEMA_BY_STAGE[stageId];
  if (!schemaId) {
    fail("structured dispatch 阶段不受支持", "WORKFLOW_V2_STRUCTURED_STAGE_UNSUPPORTED", { stageId });
  }
  if (dispatch.promptMode !== "structured"
    || dispatch.context?.stage?.id !== stageId
    || dispatch.resultSchemaId !== schemaId
    || dispatch.context?.output?.schemaId !== schemaId
    || dispatch.structuredOutput?.mode !== "structured"
    || dispatch.structuredOutput?.schemaId !== schemaId) {
    fail("structured dispatch 未绑定 registry 中的 exact result schema", "WORKFLOW_V2_STRUCTURED_SCHEMA_IDENTITY_MISMATCH", {
      stageId,
      expectedSchemaId: schemaId,
    });
  }
  const contextValidation = registry.validate(WORKFLOW_V2_SCHEMA_IDS.stageContext, dispatch.context);
  if (!contextValidation.valid) {
    fail("structured dispatch 的 StageContext Schema 无效", "WORKFLOW_V2_STRUCTURED_DISPATCH_CONTEXT_INVALID", {
      validationErrors: contextValidation.errors,
    });
  }
  const contextId = dispatch.context?.contextId;
  const contextRevision = dispatch.context?.revision;
  const idempotencyKey = dispatch.context?.idempotencyKey;
  if (dispatch.contextId !== contextId
    || dispatch.contextRevision !== contextRevision
    || dispatch.structuredOutput?.contextId !== contextId
    || dispatch.structuredOutput?.contextRevision !== contextRevision
    || dispatch.structuredOutput?.idempotencyKey !== idempotencyKey) {
    fail("structured dispatch 内部身份不一致", "WORKFLOW_V2_STRUCTURED_DISPATCH_IDENTITY_MISMATCH");
  }
  if (!tab || String(tab.id || "") !== dispatch.context?.story?.storyId) {
    fail("structured dispatch 与 story tab 身份不一致", "WORKFLOW_V2_STRUCTURED_STORY_IDENTITY_MISMATCH");
  }
  return { stageId, schemaId, contextId, contextRevision, idempotencyKey };
}

function assertResultSchemaAndIdentity(result, identity, dispatch, registry) {
  if (!registry.has(identity.schemaId)) {
    fail("structured result schema 未注册", "WORKFLOW_V2_STRUCTURED_SCHEMA_NOT_REGISTERED", {
      schemaId: identity.schemaId,
    });
  }
  const validation = registry.validate(identity.schemaId, result);
  if (!validation.valid) {
    fail("structured result 不符合 exact stage schema", "WORKFLOW_V2_STRUCTURED_SCHEMA_VALIDATION_FAILED", {
      schemaId: identity.schemaId,
      validationErrors: validation.errors,
    });
  }
  if (result.contextId !== identity.contextId
    || result.contextRevision !== identity.contextRevision
    || result.idempotencyKey !== identity.idempotencyKey) {
    fail("structured result 与冻结 dispatch 身份不一致", "WORKFLOW_V2_STRUCTURED_RESULT_IDENTITY_MISMATCH", {
      expectedContextId: identity.contextId,
      expectedContextRevision: identity.contextRevision,
    });
  }
  if (dispatch.resultSchemaId !== identity.schemaId) {
    fail("structured result schema 与 dispatch 不一致", "WORKFLOW_V2_STRUCTURED_SCHEMA_IDENTITY_MISMATCH");
  }
}

function addReceiptClaims(
  claims,
  receiptIds,
  expectedEvidenceIds,
  expectedActions,
  semanticBinding,
  location,
) {
  if (!Array.isArray(receiptIds)) return;
  const local = new Set();
  for (const rawReceiptId of receiptIds) {
    const sourceReceiptId = String(rawReceiptId || "");
    const receiptId = sourceReceiptId.trim();
    if (!receiptId || receiptId !== sourceReceiptId || local.has(receiptId)) {
      fail("structured result 的 receiptIds 为空或重复", "WORKFLOW_V2_STRUCTURED_RECEIPT_CLAIM_INVALID", {
        location,
      });
    }
    local.add(receiptId);
    claims.push({
      receiptId,
      expectedEvidenceIds: new Set(expectedEvidenceIds.filter(Boolean).map(String)),
      expectedActions: new Set(expectedActions),
      ...semanticBinding,
      location,
    });
  }
}

function collectReceiptClaims(stageId, result, dispatch) {
  const claims = [];
  const contextBinding = {
    expectedContextId: String(dispatch?.contextId || ""),
    expectedContextRevision: dispatch?.contextRevision,
  };
  const manifestItems = Array.isArray(dispatch?.context?.data?.evidenceManifest?.items)
    ? dispatch.context.data.evidenceManifest.items
    : [];
  const manifestByEvidenceId = new Map(manifestItems.map((item) => [item.evidenceId, item]));
  const evidenceReadIds = new Set();
  for (const [index, entry] of (Array.isArray(result.evidenceRead) ? result.evidenceRead : []).entries()) {
    if (!String(entry.evidenceId || "") || evidenceReadIds.has(entry.evidenceId)) {
      fail("structured result 的 evidenceRead 含空或重复 evidenceId", "WORKFLOW_V2_STRUCTURED_EVIDENCE_CLAIM_INVALID", {
        location: `evidenceRead[${index}]`,
      });
    }
    evidenceReadIds.add(entry.evidenceId);
    addReceiptClaims(
      claims,
      entry.receiptIds,
      [entry.evidenceId],
      EVIDENCE_READ_ACTIONS,
      {
        ...contextBinding,
        expectedSha256: String(manifestByEvidenceId.get(entry.evidenceId)?.sha256 || ""),
      },
      `evidenceRead[${index}]`,
    );
  }
  if (stageId === "REPAIR") {
    const configuredChecks = Array.isArray(dispatch?.context?.data?.localChecks)
      ? dispatch.context.data.localChecks
      : [];
    const configuredCheckByName = new Map(configuredChecks.map((entry) => [String(entry?.name || ""), entry]));
    const changeKeys = new Set();
    for (const [index, entry] of result.changes.entries()) {
      const changeKey = `${String(entry.rootId || "")}\u0000${String(entry.path || "")}`;
      if (changeKeys.has(changeKey)) {
        fail("REPAIR changes 含重复 rootId/path", "WORKFLOW_V2_STRUCTURED_REPAIR_CLAIM_DUPLICATE", {
          location: `changes[${index}]`,
        });
      }
      changeKeys.add(changeKey);
      addReceiptClaims(claims, entry.receiptIds, [], REPAIR_CHANGE_ACTIONS, {
        ...contextBinding,
        expectedRootId: String(entry.rootId || ""),
        expectedPath: String(entry.path || ""),
      }, `changes[${index}]`);
    }
    const checkNames = new Set();
    for (const [index, entry] of result.localChecks.entries()) {
      const checkName = String(entry.name || "").trim();
      if (checkNames.has(checkName)) {
        fail("REPAIR localChecks 含重复 name", "WORKFLOW_V2_STRUCTURED_REPAIR_CLAIM_DUPLICATE", {
          location: `localChecks[${index}]`,
        });
      }
      checkNames.add(checkName);
      const configured = configuredCheckByName.get(checkName);
      if (!configured || configured.mandatory !== true
        || !String(configured.checkId || "").trim()
        || !String(configured.executorId || "").trim()
        || !REPAIR_CHECK_ACTIONS.includes(String(configured.action || ""))) {
        fail("REPAIR localCheck 未绑定 Gateway 冻结执行配置", "WORKFLOW_V2_STRUCTURED_REPAIR_CHECK_PROFILE_MISMATCH", {
          location: `localChecks[${index}]`,
        });
      }
      addReceiptClaims(claims, entry.receiptIds, [], [configured.action], {
        ...contextBinding,
        expectedCheckName: String(entry.name || ""),
        expectedCheckId: String(configured.checkId),
        expectedExecutorId: String(configured.executorId),
        expectedRootId: String(configured.rootId || configured.cwdRootId || ""),
      }, `localChecks[${index}]`);
    }
  } else if (stageId === "VERIFY_EXECUTE") {
    const plan = dispatch?.context?.data?.verificationPlan;
    const planValidation = workflowV2SchemaRegistry.validate(WORKFLOW_V2_SCHEMA_IDS.verificationPlan, plan);
    if (!planValidation.valid || plan?.status !== "READY") {
      fail("VERIFY verificationPlan 未处于可执行的 exact schema 状态", "WORKFLOW_V2_STRUCTURED_VERIFY_PLAN_MISMATCH", {
        validationErrors: planValidation.errors,
      });
    }
    const planCaseById = new Map(plan.cases.map((entry) => [String(entry.caseId), entry]));
    for (const [index, entry] of result.cases.entries()) {
      const planCase = planCaseById.get(String(entry.caseId || ""));
      if (!planCase) {
        fail("VERIFY result case 未绑定冻结 plan case", "WORKFLOW_V2_STRUCTURED_VERIFY_PLAN_MISMATCH", {
          location: `cases[${index}]`,
        });
      }
      addReceiptClaims(
        claims,
        entry.receiptIds,
        Array.isArray(entry.evidenceRefs) ? entry.evidenceRefs : [],
        [planCase.action],
        {
          ...contextBinding,
          expectedCaseId: String(entry.caseId || ""),
          expectedExecutorId: String(planCase.executorId || ""),
          expectedRootId: String(planCase.target?.rootId || ""),
        },
        `cases[${index}]`,
      );
    }
  }
  const globallyClaimedReceiptIds = new Set();
  for (const claim of claims) {
    if (globallyClaimedReceiptIds.has(claim.receiptId)) {
      fail("同一 receiptId 不得跨独立结果项重复使用", "WORKFLOW_V2_STRUCTURED_RECEIPT_CLAIM_DUPLICATE", {
        receiptId: claim.receiptId,
        location: claim.location,
      });
    }
    globallyClaimedReceiptIds.add(claim.receiptId);
  }
  return claims;
}

async function defaultReadEnvelopes(input) {
  const { readWorkflowV2Envelopes } = await import("./envelope-store.js");
  return readWorkflowV2Envelopes(input);
}

async function loadReceiptIndex({
  tab,
  claims,
  readEnvelopes,
  registry,
  storageApi,
  verifyReceiptOutput,
}) {
  if (!claims.length) return new Map();
  let envelopes;
  try {
    envelopes = await readEnvelopes({
      tab,
      payloadSchemaId: WORKFLOW_V2_SCHEMA_IDS.evidenceReceipt,
    });
  } catch (error) {
    fail("读取 evidence receipt envelopes 失败", "WORKFLOW_V2_STRUCTURED_RECEIPT_READ_FAILED", {
      causeCode: String(error?.code || ""),
    });
  }
  if (!Array.isArray(envelopes)) {
    fail("evidence receipt reader 未返回数组", "WORKFLOW_V2_STRUCTURED_RECEIPT_READ_FAILED");
  }
  const byId = new Map();
  for (const envelope of envelopes) {
    const envelopeValidation = registry.validate(WORKFLOW_V2_SCHEMA_IDS.workflowEnvelope, envelope);
    const receiptValidation = registry.validate(WORKFLOW_V2_SCHEMA_IDS.evidenceReceipt, envelope?.payload);
    if (!envelopeValidation.valid || !receiptValidation.valid
      || envelope.payloadSchemaId !== WORKFLOW_V2_SCHEMA_IDS.evidenceReceipt
      || envelope.contextId !== null
      || envelope.storyId !== String(tab.id)
      || envelope.recordId !== envelope.payload.receiptId) {
      fail("evidence receipt envelope 无效", "WORKFLOW_V2_STRUCTURED_RECEIPT_ENVELOPE_INVALID");
    }
    if (byId.has(envelope.payload.receiptId)) {
      fail("evidence receipt envelope 的 receiptId 重复", "WORKFLOW_V2_STRUCTURED_RECEIPT_ENVELOPE_DUPLICATE", {
        receiptId: envelope.payload.receiptId,
      });
    }
    byId.set(envelope.payload.receiptId, envelope.payload);
  }
  for (const claim of claims) {
    const receipt = byId.get(claim.receiptId);
    if (!receipt) {
      fail("structured result 声明的 receiptId 不存在", "WORKFLOW_V2_STRUCTURED_RECEIPT_NOT_FOUND", {
        receiptId: claim.receiptId,
        location: claim.location,
      });
    }
    if (receipt.status !== "PASS") {
      fail("structured result 声明的 receipt 不是 PASS", "WORKFLOW_V2_STRUCTURED_RECEIPT_NOT_PASS", {
        receiptId: claim.receiptId,
        location: claim.location,
      });
    }
    if (claim.expectedActions.size && !claim.expectedActions.has(receipt.action)) {
      fail("receipt action 不能证明对应的 structured result 项", "WORKFLOW_V2_STRUCTURED_RECEIPT_ACTION_MISMATCH", {
        receiptId: claim.receiptId,
        location: claim.location,
        action: receipt.action,
      });
    }
    if (claim.expectedEvidenceIds.size
      && (!receipt.evidenceId || !claim.expectedEvidenceIds.has(String(receipt.evidenceId)))) {
      fail("receipt 的 evidenceId 与 structured result 不匹配", "WORKFLOW_V2_STRUCTURED_RECEIPT_EVIDENCE_MISMATCH", {
        receiptId: claim.receiptId,
        location: claim.location,
      });
    }
    if (claim.expectedSha256 && receipt.sha256 !== claim.expectedSha256) {
      fail("evidence receipt sha256 与 manifest 不一致", "WORKFLOW_V2_STRUCTURED_RECEIPT_SEMANTIC_MISMATCH", {
        receiptId: claim.receiptId,
        location: claim.location,
        field: "sha256",
      });
    }
    if (receipt.selector?.contextId !== claim.expectedContextId
      || receipt.selector?.contextRevision !== claim.expectedContextRevision) {
      fail("receipt 未绑定当前冻结 context", "WORKFLOW_V2_STRUCTURED_RECEIPT_SEMANTIC_MISMATCH", {
        receiptId: claim.receiptId,
        location: claim.location,
        field: "context",
      });
    }
    if ((claim.expectedRootId || claim.expectedPath)
      && (receipt.rootId !== claim.expectedRootId
        || (claim.expectedPath && receipt.selector?.path !== claim.expectedPath))) {
      fail("receipt 未精确绑定 rootId/path", "WORKFLOW_V2_STRUCTURED_RECEIPT_SEMANTIC_MISMATCH", {
        receiptId: claim.receiptId,
        location: claim.location,
        field: "change",
      });
    }
    if (claim.expectedPath && !hasVerifiedEditTransition(receipt.selector)) {
      fail("EDIT receipt 缺少真实且不同的前后内容哈希", "WORKFLOW_V2_STRUCTURED_RECEIPT_SEMANTIC_MISMATCH", {
        receiptId: claim.receiptId,
        location: claim.location,
        field: "editHash",
      });
    }
    if (claim.expectedCheckName && receipt.selector?.name !== claim.expectedCheckName) {
      fail("BUILD/TEST receipt 未精确绑定 localCheck name", "WORKFLOW_V2_STRUCTURED_RECEIPT_SEMANTIC_MISMATCH", {
        receiptId: claim.receiptId,
        location: claim.location,
        field: "localCheck",
      });
    }
    if (claim.expectedCheckId && receipt.selector?.checkId !== claim.expectedCheckId) {
      fail("BUILD/TEST receipt 未绑定 checkId", "WORKFLOW_V2_STRUCTURED_RECEIPT_SEMANTIC_MISMATCH", {
        receiptId: claim.receiptId,
        location: claim.location,
        field: "checkId",
      });
    }
    if (claim.expectedExecutorId && receipt.selector?.executorId !== claim.expectedExecutorId) {
      fail("receipt 未绑定冻结 executorId", "WORKFLOW_V2_STRUCTURED_RECEIPT_SEMANTIC_MISMATCH", {
        receiptId: claim.receiptId,
        location: claim.location,
        field: "executorId",
      });
    }
    if (claim.expectedCaseId && receipt.selector?.caseId !== claim.expectedCaseId) {
      fail("VERIFY receipt 未绑定 caseId", "WORKFLOW_V2_STRUCTURED_RECEIPT_SEMANTIC_MISMATCH", {
        receiptId: claim.receiptId,
        location: claim.location,
        field: "caseId",
      });
    }
    if (isControlledReceiptAction(receipt.action)) {
      let outputEvidence;
      try {
        outputEvidence = await verifyReceiptOutput({ tab, receipt, storageApi });
      } catch (error) {
        outputEvidence = { valid: false, reason: error?.message || String(error) };
      }
      if (outputEvidence?.valid !== true) {
        fail("controlled receipt 的 outputRef/sha256 无法回读验证", "WORKFLOW_V2_STRUCTURED_RECEIPT_OUTPUT_INVALID", {
          receiptId: claim.receiptId,
          location: claim.location,
          reason: outputEvidence?.reason || "unknown",
        });
      }
    }
  }
  const editStateClaims = claims.filter((claim) => (
    claim.expectedPath
    || claim.expectedCheckId
    || (claim.expectedCaseId && [...claim.expectedActions].some((action) => REPAIR_CHECK_ACTIONS.includes(action)))
  ));
  if (editStateClaims.length) {
    const rootIds = [...new Set(editStateClaims.map((claim) => claim.expectedRootId).filter(Boolean))];
    for (const rootId of rootIds) {
      let state;
      try {
        state = deriveWorkflowV2EditState({
          envelopes,
          storyId: String(tab.id),
          contextId: String(editStateClaims[0].expectedContextId || ""),
          contextRevision: editStateClaims[0].expectedContextRevision,
          rootId,
          requireChanges: editStateClaims.some((claim) => claim.expectedRootId === rootId && claim.expectedPath),
        });
      } catch (error) {
        fail(
          "无法从 append-only receipt stream 派生最终 EDIT 状态",
          "WORKFLOW_V2_STRUCTURED_EDIT_STATE_INVALID",
          { rootId, causeCode: String(error?.code || "") },
        );
      }
      const pathClaims = editStateClaims.filter((claim) => claim.expectedRootId === rootId && claim.expectedPath);
      const claimedPaths = [...new Set(pathClaims.map((claim) => claim.expectedPath))].sort();
      const statePaths = state.files.map((entry) => entry.path);
      if (claimedPaths.length !== statePaths.length
        || claimedPaths.some((value, index) => value !== statePaths[index])) {
        fail(
          "REPAIR changes 未精确覆盖当前 root 的最终 EDIT 状态",
          "WORKFLOW_V2_STRUCTURED_EDIT_STATE_CHANGE_MISMATCH",
          { rootId, claimedPaths, statePaths },
        );
      }
      const latestReceiptByPath = new Map(state.files.map((entry) => [entry.path, entry.receiptId]));
      for (const claim of pathClaims) {
        if (latestReceiptByPath.get(claim.expectedPath) !== claim.receiptId) {
          fail(
            "REPAIR change 声明了过期 EDIT receipt",
            "WORKFLOW_V2_STRUCTURED_EDIT_STATE_STALE",
            { rootId, path: claim.expectedPath, receiptId: claim.receiptId },
          );
        }
      }
      for (const claim of editStateClaims.filter((entry) => (
        entry.expectedRootId === rootId
        && (entry.expectedCheckId || entry.expectedCaseId)
        && [...entry.expectedActions].some((action) => REPAIR_CHECK_ACTIONS.includes(action))
      ))) {
        if (!receiptBindsWorkflowV2EditState(byId.get(claim.receiptId), state)) {
          fail(
            "mandatory BUILD/TEST receipt 未绑定同一最新 EDIT state digest",
            "WORKFLOW_V2_STRUCTURED_CHECK_EDIT_STATE_MISMATCH",
            { rootId, receiptId: claim.receiptId, checkId: claim.expectedCheckId || claim.expectedCaseId },
          );
        }
      }
    }
  }
  const evidenceCoverageByLocation = new Map();
  for (const claim of claims) {
    if (!claim.expectedEvidenceIds.size) continue;
    const coverage = evidenceCoverageByLocation.get(claim.location) || {
      expected: new Set(),
      covered: new Set(),
    };
    for (const evidenceId of claim.expectedEvidenceIds) coverage.expected.add(evidenceId);
    const receiptEvidenceId = byId.get(claim.receiptId)?.evidenceId;
    if (receiptEvidenceId) coverage.covered.add(String(receiptEvidenceId));
    evidenceCoverageByLocation.set(claim.location, coverage);
  }
  for (const [location, coverage] of evidenceCoverageByLocation) {
    const missing = [...coverage.expected].filter((evidenceId) => !coverage.covered.has(evidenceId));
    if (missing.length) {
      fail("result evidenceRefs 未由独立 PASS receipts 完整覆盖", "WORKFLOW_V2_STRUCTURED_RECEIPT_EVIDENCE_COVERAGE_MISSING", {
        location,
        evidenceIds: missing,
      });
    }
  }
  return byId;
}

function evaluateTriage(result, dispatch) {
  const manifest = dispatch.context?.data?.evidenceManifest;
  const validation = workflowV2SchemaRegistry.validate(WORKFLOW_V2_SCHEMA_IDS.evidenceManifest, manifest);
  if (!validation.valid || manifest.storyId !== dispatch.context.story.storyId) {
    fail("TRIAGE 缺少可信 evidence manifest", "WORKFLOW_V2_STRUCTURED_TRIAGE_MANIFEST_INVALID");
  }
  const manifestIds = new Set();
  for (const item of manifest.items) {
    if (manifestIds.has(item.evidenceId)) {
      fail("TRIAGE evidence manifest 含重复 evidenceId", "WORKFLOW_V2_STRUCTURED_TRIAGE_MANIFEST_INVALID");
    }
    manifestIds.add(item.evidenceId);
  }
  const unavailableRequired = manifest.items
    .filter((item) => item.required === true && !RECEIPT_REQUIRED_AVAILABILITY.has(item.availability))
    .map((item) => item.evidenceId);
  if (unavailableRequired.length) {
    fail("TRIAGE required evidence 不可用且无 M4 降级策略", "WORKFLOW_V2_STRUCTURED_TRIAGE_REQUIRED_EVIDENCE_UNAVAILABLE", {
      evidenceIds: unavailableRequired,
    });
  }
  const evidenceUnreadIds = new Set();
  for (const [index, entry] of result.evidenceUnread.entries()) {
    if (!manifestIds.has(entry.evidenceId)
      || evidenceUnreadIds.has(entry.evidenceId)
      || result.evidenceRead.some((read) => read.evidenceId === entry.evidenceId)) {
      fail("TRIAGE evidenceUnread 必须唯一、来自 manifest 且不能同时声明已读", "WORKFLOW_V2_STRUCTURED_TRIAGE_EVIDENCE_REFERENCE_INVALID", {
        location: `evidenceUnread[${index}]`,
      });
    }
    evidenceUnreadIds.add(entry.evidenceId);
  }
  const readByEvidence = new Map();
  for (const entry of result.evidenceRead) {
    if (!manifestIds.has(entry.evidenceId)) {
      fail("TRIAGE evidenceRead 引用了 manifest 外 evidenceId", "WORKFLOW_V2_STRUCTURED_TRIAGE_EVIDENCE_REFERENCE_INVALID", {
        evidenceId: entry.evidenceId,
      });
    }
    const receiptIds = readByEvidence.get(entry.evidenceId) || new Set();
    for (const receiptId of entry.receiptIds) receiptIds.add(receiptId);
    readByEvidence.set(entry.evidenceId, receiptIds);
  }
  for (const [index, claim] of result.claims.entries()) {
    const evidenceFor = Array.isArray(claim.evidenceFor) ? claim.evidenceFor : [];
    const evidenceAgainst = Array.isArray(claim.evidenceAgainst) ? claim.evidenceAgainst : [];
    const evidenceForSet = new Set(evidenceFor);
    const evidenceAgainstSet = new Set(evidenceAgainst);
    const invalidReference = evidenceForSet.size !== evidenceFor.length
      || evidenceAgainstSet.size !== evidenceAgainst.length
      || [...evidenceForSet].some((evidenceId) => !manifestIds.has(evidenceId))
      || [...evidenceAgainstSet].some((evidenceId) => !manifestIds.has(evidenceId))
      || [...evidenceForSet].some((evidenceId) => evidenceAgainstSet.has(evidenceId));
    if (invalidReference) {
      fail("TRIAGE claim evidence 引用无效或正反重复", "WORKFLOW_V2_STRUCTURED_TRIAGE_EVIDENCE_INSUFFICIENT", {
        location: `claims[${index}]`,
      });
    }
  }
  const missingRequired = manifest.items
    .filter((item) => item.required === true && RECEIPT_REQUIRED_AVAILABILITY.has(item.availability))
    .filter((item) => !(readByEvidence.get(item.evidenceId)?.size > 0))
    .map((item) => item.evidenceId);
  if (missingRequired.length) {
    fail("TRIAGE required AVAILABLE/PARTIAL evidence 缺少 PASS receipt", "WORKFLOW_V2_STRUCTURED_TRIAGE_EVIDENCE_INSUFFICIENT", {
      evidenceIds: missingRequired,
    });
  }
  const rootCauseFields = [
    "symptom",
    "trigger",
    "observedBehavior",
    "directCause",
    "faultOwner",
    "workaroundOwner",
  ];
  const rootCauseComplete = rootCauseFields.every((field) => String(result.rootCause?.[field] || "").trim());
  const readEvidenceIds = new Set(
    [...readByEvidence.entries()]
      .filter(([, receiptIds]) => receiptIds.size > 0)
      .map(([evidenceId]) => evidenceId),
  );
  const readEvidenceTypes = new Set(
    manifest.items
      .filter((item) => readEvidenceIds.has(item.evidenceId))
      .map((item) => item.type),
  );
  const supportedClaims = result.claims.filter((claim) => claim.status === "SUPPORTED");
  const allClaimEvidenceRead = result.claims.every((claim) => (
    [...claim.evidenceFor, ...claim.evidenceAgainst].every((evidenceId) => readEvidenceIds.has(evidenceId))
  ));
  const supportedClaimsValid = supportedClaims.length > 0 && supportedClaims.every((claim) => (
    String(claim.text || "").trim()
    && claim.evidenceFor.length >= 2
    && claim.evidenceFor.every((evidenceId) => readEvidenceIds.has(evidenceId))
    && new Set(claim.evidenceFor.map((evidenceId) => (
      manifest.items.find((item) => item.evidenceId === evidenceId)?.type
    ))).size >= 2
  ));

  if (result.classification === "INSUFFICIENT_EVIDENCE") {
    if (result.nextStage !== "BLOCKED") {
      fail("INSUFFICIENT_EVIDENCE 只能进入 BLOCKED", "WORKFLOW_V2_STRUCTURED_TRIAGE_TRANSITION_MISMATCH");
    }
    fail("TRIAGE 证据不足，不产生推进事件", "WORKFLOW_V2_STRUCTURED_TRIAGE_EVIDENCE_INSUFFICIENT");
  }
  if (result.status !== "COMPLETED") {
    fail("TRIAGE 未完成，不得推进", "WORKFLOW_V2_STRUCTURED_TRIAGE_INCOMPLETE");
  }
  if (!rootCauseComplete || readEvidenceTypes.size < 2 || !allClaimEvidenceRead || !supportedClaimsValid) {
    fail("TRIAGE 分类缺少两类独立证据、SUPPORTED claim 或完整 rootCause", "WORKFLOW_V2_STRUCTURED_TRIAGE_EVIDENCE_INSUFFICIENT");
  }
  const riskLevel = dispatch.context.stage.riskLevel;
  const expectedNextStage = result.classification === "NON_CLIENT_ISSUE"
    ? "REJECT_PENDING"
    : (["HIGH", "CRITICAL"].includes(riskLevel) ? "DIAGNOSE_PLAN" : "REPAIR");
  if (result.nextStage !== expectedNextStage) {
    fail("TRIAGE classification/risk 与 nextStage 不一致", "WORKFLOW_V2_STRUCTURED_TRIAGE_TRANSITION_MISMATCH", {
      expectedNextStage,
      actualNextStage: result.nextStage,
    });
  }
  if (["CLIENT_ISSUE", "CROSS_COMPONENT"].includes(result.classification)
    && ["HIGH", "CRITICAL"].includes(riskLevel)) {
    fail("旧状态机无法表达 TRIAGE 到 DIAGNOSE_PLAN 的路由", "WORKFLOW_V2_STRUCTURED_LEGACY_ROUTE_UNSUPPORTED", {
      stageId: "TRIAGE",
      expectedNextStage,
    });
  }
  if (result.classification === "CLIENT_ISSUE" || result.classification === "CROSS_COMPONENT") {
    return "triage_is_bug";
  }
  if (result.classification === "NON_CLIENT_ISSUE") return "triage_not_bug";
  fail("TRIAGE classification 不受支持", "WORKFLOW_V2_STRUCTURED_TRIAGE_EVIDENCE_INSUFFICIENT");
}

function meaningfulRepairEntries(result) {
  return result.changes.every((entry) => (
    String(entry.rootId || "").trim()
    && String(entry.path || "").trim()
    && String(entry.summary || "").trim()
    && entry.receiptIds.length > 0
  )) && result.localChecks.every((entry) => (
    String(entry.name || "").trim()
    && entry.status === "PASS"
    && entry.receiptIds.length > 0
  ));
}

function evaluateRepair(result, dispatch) {
  if (result.status !== "COMPLETED"
    || result.outcome !== "FIXED"
    || result.changes.length === 0
    || result.localChecks.length === 0
    || !meaningfulRepairEntries(result)) {
    fail("REPAIR 仅在完成修复、存在改动且本地检查全 PASS 时推进", "WORKFLOW_V2_STRUCTURED_REPAIR_GATE_BLOCKED");
  }
  if (result.nextStage !== "LOCAL_GATE") {
    fail("REPAIR FIXED/COMPLETED 只能进入 LOCAL_GATE", "WORKFLOW_V2_STRUCTURED_REPAIR_TRANSITION_MISMATCH");
  }
  if (["HIGH", "CRITICAL"].includes(dispatch.context.stage.riskLevel)) {
    fail("旧状态机无法表达 REPAIR 到 INDEPENDENT_REVIEW 的路由", "WORKFLOW_V2_STRUCTURED_LEGACY_ROUTE_UNSUPPORTED", {
      stageId: "REPAIR",
      expectedNextStage: "INDEPENDENT_REVIEW",
    });
  }
  return "fix_done";
}

function systemGateStatus(gate, {
  label,
  dispatch,
  resultSha256,
  planId = null,
  htmlRef = null,
} = {}) {
  if (gate == null) return "";
  if (!gate || typeof gate !== "object" || Array.isArray(gate) || !isDeepFrozen(gate)) {
    fail(`${label} 必须是递归冻结的系统 gate`, "WORKFLOW_V2_STRUCTURED_SYSTEM_GATE_INVALID", { label });
  }
  if (!["PASS", "FAIL", "BLOCKED"].includes(gate.status)) {
    fail(`${label} status 无效`, "WORKFLOW_V2_STRUCTURED_SYSTEM_GATE_INVALID", { label });
  }
  const hasRequiredIdentity = typeof gate.storyId === "string" && gate.storyId.trim().length > 0
    && typeof gate.contextId === "string" && gate.contextId.trim().length > 0
    && Number.isSafeInteger(gate.contextRevision) && gate.contextRevision >= 1
    && typeof gate.resultSha256 === "string" && /^[a-f0-9]{64}$/.test(gate.resultSha256)
    && (planId === null || (typeof planId === "string" && planId.trim().length > 0))
    && (htmlRef === null || (typeof htmlRef === "string" && htmlRef.trim().length > 0));
  const identityMatches = hasRequiredIdentity
    && gate.storyId === dispatch.context.story.storyId
    && gate.contextId === dispatch.contextId
    && gate.contextRevision === dispatch.contextRevision
    && gate.resultSha256 === resultSha256
    && (planId === null || gate.planId === planId)
    && (htmlRef === null || gate.htmlRef === htmlRef);
  if (!identityMatches) {
    fail(`${label} 未绑定当前 structured result`, "WORKFLOW_V2_STRUCTURED_SYSTEM_GATE_IDENTITY_MISMATCH", {
      label,
    });
  }
  return gate.status;
}

function verificationPlanCases(dispatch, result) {
  const plan = dispatch.context?.data?.verificationPlan;
  if (!plan || typeof plan !== "object" || Array.isArray(plan)) {
    fail("VERIFY 缺少冻结 verificationPlan", "WORKFLOW_V2_STRUCTURED_VERIFY_PLAN_MISSING");
  }
  if (typeof plan.planId !== "string"
    || !plan.planId.trim()
    || typeof result.planId !== "string"
    || !result.planId.trim()
    || result.planId !== plan.planId) {
    fail("VERIFY result.planId 与冻结计划不一致", "WORKFLOW_V2_STRUCTURED_VERIFY_PLAN_MISMATCH");
  }
  const resultById = new Map();
  for (const entry of result.cases) {
    if (!String(entry.caseId || "") || resultById.has(entry.caseId)) {
      fail("VERIFY cases 含空或重复 caseId", "WORKFLOW_V2_STRUCTURED_VERIFY_CASES_INCONSISTENT");
    }
    resultById.set(entry.caseId, entry);
  }
  const planCases = Array.isArray(plan.cases) ? plan.cases : [];
  if (!planCases.length) return [...resultById.values()];

  const normalizedPlanCases = planCases.map((entry) => {
    if (typeof entry === "string") {
      return { caseId: entry, mandatory: plan.mandatory !== false };
    }
    if (!entry || typeof entry !== "object" || Array.isArray(entry) || typeof entry.mandatory !== "boolean") {
      fail("冻结 verificationPlan case 缺少显式 mandatory", "WORKFLOW_V2_STRUCTURED_VERIFY_PLAN_MISMATCH");
    }
    return { caseId: String(entry.caseId || ""), mandatory: entry.mandatory };
  });
  const planIds = new Set();
  for (const entry of normalizedPlanCases) {
    if (!entry.caseId || planIds.has(entry.caseId)) {
      fail("冻结 verificationPlan 含空或重复 caseId", "WORKFLOW_V2_STRUCTURED_VERIFY_PLAN_MISMATCH");
    }
    planIds.add(entry.caseId);
  }
  if (resultById.size !== planIds.size || [...resultById.keys()].some((caseId) => !planIds.has(caseId))) {
    fail("VERIFY result.cases 与冻结计划不一致", "WORKFLOW_V2_STRUCTURED_VERIFY_CASES_INCONSISTENT");
  }
  return normalizedPlanCases
    .filter((entry) => entry.mandatory)
    .map((entry) => resultById.get(entry.caseId));
}

function assertMandatorySummary(result, mandatoryCases) {
  const counts = {
    total: mandatoryCases.length,
    passed: mandatoryCases.filter((entry) => entry.status === "PASS").length,
    failed: mandatoryCases.filter((entry) => entry.status === "FAIL").length,
    blocked: mandatoryCases.filter((entry) => entry.status === "BLOCKED").length,
    notRun: mandatoryCases.filter((entry) => entry.status === "NOT_RUN").length,
  };
  if (Object.entries(counts).some(([key, value]) => result.mandatorySummary[key] !== value)) {
    fail("VERIFY mandatorySummary 与 cases 不一致", "WORKFLOW_V2_STRUCTURED_VERIFY_SUMMARY_INCONSISTENT", {
      expected: counts,
    });
  }
}

function evaluateVerification(result, dispatch, trustedSystemGate, resultSha256) {
  const gateStatus = systemGateStatus(trustedSystemGate, {
    label: "trustedSystemGate",
    dispatch,
    resultSha256,
    planId: result.planId,
  });
  if (gateStatus === "FAIL") return "verify_fail";
  if (gateStatus !== "PASS") {
    fail("VERIFY 缺少显式可信系统门禁结论", "WORKFLOW_V2_STRUCTURED_VERIFY_SYSTEM_GATE_BLOCKED");
  }
  const mandatoryCases = verificationPlanCases(dispatch, result);
  assertMandatorySummary(result, mandatoryCases);
  if (result.status !== "COMPLETED"
    || result.conclusion !== "PASS"
    || mandatoryCases.length === 0
    || mandatoryCases.some((entry) => (
      entry.status !== "PASS"
      || entry.receiptIds.length === 0
      || !Array.isArray(entry.evidenceRefs)
      || entry.evidenceRefs.length === 0
    ))) {
    fail("VERIFY PASS 要求 mandatory cases 全 PASS 且均有 receipt", "WORKFLOW_V2_STRUCTURED_VERIFY_PASS_BLOCKED");
  }
  return "verify_pass";
}

function evaluateShortReport(result, dispatch) {
  const maxChars = dispatch.context?.output?.maxChars;
  const match = SHORT_REPORT_PATTERN.exec(result.reportText);
  if (!Number.isSafeInteger(maxChars) || maxChars < 1
    || !match
    || match[1].trim() !== match[1]
    || match[2].trim() !== match[2]
    || !match[1].trim()
    || !match[2].trim()
    || match[1].includes("原因：")
    || match[1].includes("措施：")
    || match[2].includes("原因：")
    || match[2].includes("措施：")
    || SHORT_REPORT_CONTROL_PATTERN.test(result.reportText)
    || Array.from(result.reportText).length > maxChars) {
    fail("REPORT_SHORT 必须严格为原因/措施单行格式且不超过 maxChars", "WORKFLOW_V2_STRUCTURED_SHORT_REPORT_INVALID", {
      maxChars,
    });
  }
  return "report_done";
}

function evaluateExpertReport(result, dispatch, rendererGate, pdfGate, resultSha256) {
  const expectedHtmlRef = dispatch.context?.output?.outputPath;
  const rendererStatus = systemGateStatus(rendererGate, {
    label: "rendererGate",
    dispatch,
    resultSha256,
    htmlRef: result.htmlRef || expectedHtmlRef,
  });
  const pdfStatus = systemGateStatus(pdfGate, {
    label: "pdfGate",
    dispatch,
    resultSha256,
    htmlRef: result.htmlRef || expectedHtmlRef,
  });
  if (result.status !== "COMPLETED"
    || !String(result.htmlRef || "").trim()
    || result.htmlRef !== expectedHtmlRef
    || rendererStatus !== "PASS"
    || pdfStatus !== "PASS") {
    fail("REPORT_EXPERT 仅在 renderer/PDF 系统门禁显式 PASS 后推进", "WORKFLOW_V2_STRUCTURED_EXPERT_REPORT_GATE_BLOCKED");
  }
  return "report_done";
}

function evaluateStage({
  identity,
  result,
  resultSha256,
  dispatch,
  trustedSystemGate,
  rendererGate,
  pdfGate,
}) {
  if (identity.stageId === "TRIAGE") return evaluateTriage(result, dispatch);
  if (identity.stageId === "REPAIR") return evaluateRepair(result, dispatch);
  if (identity.stageId === "VERIFY_EXECUTE") {
    return evaluateVerification(result, dispatch, trustedSystemGate, resultSha256);
  }
  if (identity.stageId === "REPORT_SHORT") return evaluateShortReport(result, dispatch);
  if (identity.stageId === "REPORT_EXPERT") {
    return evaluateExpertReport(result, dispatch, rendererGate, pdfGate, resultSha256);
  }
  fail("structured result 的阶段不受支持", "WORKFLOW_V2_STRUCTURED_STAGE_UNSUPPORTED");
}

function failureResult(error, result, receiptIds) {
  const known = error instanceof WorkflowV2StructuredResultGateError;
  return Object.freeze({
    ok: false,
    result,
    displayText: "",
    legacyEvent: null,
    code: known ? error.code : "WORKFLOW_V2_STRUCTURED_RESULT_GATE_FAILED",
    error: known ? error.message : "structured result gate 执行失败",
    receiptIds: Object.freeze([...receiptIds]),
  });
}

/**
 * Provider 适配：deepseek 等会在结果对象顶层回带 `$schema` 元引用（它是
 * Schema 文档引用，不是业务数据）。剥离该单一已知元字段后再做 Schema 校验
 * 与身份绑定；其它额外字段仍由 additionalProperties: false 拒绝。
 */
function stripProviderResultMeta(result) {
  if (!result || typeof result !== "object" || Array.isArray(result)) return result;
  if (typeof result.$schema !== "string") return result;
  const cleaned = { ...result };
  delete cleaned.$schema;
  return deepFreeze(cleaned);
}

/**
 * Read-only M4 result boundary. It validates model output and consumes existing
 * receipt/system-gate facts; it does not execute tools, create receipts, render
 * reports, validate PDFs, control Git/devices, or write workflow state.
 */
export async function evaluateStructuredWorkflowResult({
  dispatch,
  rawResult,
  tab,
  trustedSystemGate = null,
  rendererGate = null,
  pdfGate = null,
  readEnvelopes = defaultReadEnvelopes,
  storageApi,
  verifyReceiptOutput = verifyControlledReceiptOutput,
} = {}) {
  let result = null;
  let receiptIds = [];
  try {
    const registry = workflowV2SchemaRegistry;
    const identity = assertFrozenDispatch(dispatch, tab, registry);
    result = stripProviderResultMeta(parseStrictStructuredResult(rawResult));
    assertResultSchemaAndIdentity(result, identity, dispatch, registry);
    const resultSha256 = canonicalSha256(result);
    const claims = collectReceiptClaims(identity.stageId, result, dispatch);
    receiptIds = [...new Set(claims.map((claim) => claim.receiptId))].sort();
    const legacyKind = evaluateStage({
      identity,
      result,
      resultSha256,
      dispatch,
      trustedSystemGate,
      rendererGate,
      pdfGate,
    });
    if (claims.length && typeof readEnvelopes !== "function") {
      fail("structured result 缺少 evidence receipt reader", "WORKFLOW_V2_STRUCTURED_RECEIPT_READ_FAILED");
    }
    await loadReceiptIndex({
      tab,
      claims,
      readEnvelopes,
      registry,
      storageApi,
      verifyReceiptOutput,
    });
    const adapted = adaptStructuredResultToLegacyEvent({
      stageId: identity.stageId,
      result,
      legacyKind,
    });
    return Object.freeze({
      ok: true,
      result,
      displayText: adapted.displayText,
      legacyEvent: adapted.legacyEvent,
      code: null,
      error: null,
      receiptIds: Object.freeze([...receiptIds]),
    });
  } catch (error) {
    return failureResult(error, result, receiptIds);
  }
}
