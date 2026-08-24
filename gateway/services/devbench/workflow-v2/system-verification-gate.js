import { WORKFLOW_V2_SCHEMA_IDS, workflowV2SchemaRegistry } from "./schema-registry.js";
import { canonicalSha256 } from "./envelope-store.js";
import { verifyControlledReceiptOutput } from "./controlled-receipt-evidence.js";
import {
  buildVerificationEvidenceContract,
  receiptBindsVerificationCase,
  receiptProvesVerificationMaterial,
} from "./verification-evidence-contract.js";

const GATE_SCHEMA_VERSION = "trusted-system-gate-v1";
const VERIFY_CASE_ACTIONS = Object.freeze(["BUILD", "TEST", "DEVICE_ACTION", "DB_QUERY", "CAPTURE"]);

export class WorkflowV2SystemGateError extends Error {
  constructor(message, code, details = {}) {
    super(message);
    this.name = "WorkflowV2SystemGateError";
    this.code = code;
    this.details = details;
  }
}

function fail(message, code, details = {}) {
  throw new WorkflowV2SystemGateError(message, code, details);
}

function deepFreeze(value, seen = new Set()) {
  if (!value || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
}

async function defaultReadEnvelopes(input) {
  const { readWorkflowV2Envelopes } = await import("./envelope-store.js");
  return readWorkflowV2Envelopes(input);
}

function normalizedPlanCases(plan) {
  const cases = Array.isArray(plan.cases) ? plan.cases : [];
  return cases.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)
      || typeof String(entry.caseId || "") !== "string" || !String(entry.caseId || "").trim()
      || typeof entry.mandatory !== "boolean"
      || !String(entry.executorId || "").trim()
      || !VERIFY_CASE_ACTIONS.includes(String(entry.action || ""))
      || !String(entry.target?.rootId || "").trim()
      || !Array.isArray(entry.storyIds) || entry.storyIds.length === 0) {
      fail("冻结 verificationPlan case 缺少显式 caseId/mandatory/executor/action/target", "WORKFLOW_V2_SYSTEM_GATE_PLAN_MISMATCH");
    }
    return {
      caseId: String(entry.caseId),
      mandatory: entry.mandatory,
      executorId: String(entry.executorId),
      action: String(entry.action),
      rootId: String(entry.target.rootId),
      storyIds: [...entry.storyIds],
    };
  });
}

function executionProfileExecutors(dispatch, plan) {
  const profile = dispatch.executionProfile;
  if (!profile || typeof profile !== "object" || Array.isArray(profile)
    || String(profile.profileId || "") !== String(plan.profileId || "")) return null;
  const executors = Array.isArray(profile.executors)
    ? profile.executors
    : (Array.isArray(profile.stage?.executors) ? profile.stage.executors : []);
  const byId = new Map();
  for (const executor of executors) {
    const executorId = String(executor?.executorId || "");
    if (!executorId || byId.has(executorId)) return null;
    byId.set(executorId, executor);
  }
  return byId;
}

function resultCasesById(result) {
  const byId = new Map();
  for (const entry of (Array.isArray(result.cases) ? result.cases : [])) {
    const caseId = String(entry.caseId || "");
    if (!caseId || byId.has(caseId)) {
      fail("VERIFY result cases 含空或重复 caseId", "WORKFLOW_V2_SYSTEM_GATE_CASES_INCONSISTENT");
    }
    byId.set(caseId, entry);
  }
  return byId;
}

function loadReceiptIndex(envelopes, storyId) {
  const byId = new Map();
  for (const envelope of envelopes) {
    const envelopeValidation = workflowV2SchemaRegistry.validate(WORKFLOW_V2_SCHEMA_IDS.workflowEnvelope, envelope);
    const receiptValidation = workflowV2SchemaRegistry.validate(WORKFLOW_V2_SCHEMA_IDS.evidenceReceipt, envelope?.payload);
    if (!envelopeValidation.valid || !receiptValidation.valid
      || envelope.payloadSchemaId !== WORKFLOW_V2_SCHEMA_IDS.evidenceReceipt
      || envelope.contextId !== null
      || String(envelope.storyId || "") !== storyId
      || envelope.recordId !== envelope.payload.receiptId) {
      fail("evidence receipt envelope 无效", "WORKFLOW_V2_SYSTEM_GATE_RECEIPT_ENVELOPE_INVALID");
    }
    if (byId.has(envelope.payload.receiptId)) {
      fail("evidence receipt envelope 的 receiptId 重复", "WORKFLOW_V2_SYSTEM_GATE_RECEIPT_DUPLICATE");
    }
    byId.set(envelope.payload.receiptId, envelope.payload);
  }
  return byId;
}

/**
 * M6 系统 VERIFY 门禁：最终 PASS/FAIL 只能由系统根据冻结 verificationPlan 的
 * mandatory cases、真实 evidence receipt envelope 与冻结 context 绑定计算，
 * 模型文本与结论只是待核验数据，不能直接变成 PASS。
 *
 * 返回递归冻结的 {schemaVersion, storyId, contextId, contextRevision,
 * resultSha256, planId, status}；status ∈ PASS|FAIL|BLOCKED。
 */
export async function buildTrustedSystemGate({
  tab,
  dispatch,
  result,
  readEnvelopes = defaultReadEnvelopes,
  storageApi,
  verifyReceiptOutput = verifyControlledReceiptOutput,
} = {}) {
  if (!dispatch?.context || typeof dispatch?.context !== "object") {
    fail("缺少冻结 StageContext", "WORKFLOW_V2_SYSTEM_GATE_CONTEXT_MISSING");
  }
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    fail("缺少结构化 VERIFY result", "WORKFLOW_V2_SYSTEM_GATE_RESULT_MISSING");
  }
  const storyId = String(dispatch.context.story?.storyId || "");
  const contextId = String(dispatch.contextId || "");
  const contextRevision = dispatch.contextRevision;
  const resultSha256 = canonicalSha256(result);
  const plan = dispatch.context.data?.verificationPlan;
  if (!plan || typeof plan !== "object" || Array.isArray(plan)) {
    fail("VERIFY 缺少冻结 verificationPlan", "WORKFLOW_V2_SYSTEM_GATE_PLAN_MISSING");
  }
  const planValidation = workflowV2SchemaRegistry.validate(WORKFLOW_V2_SCHEMA_IDS.verificationPlan, plan);
  if (!planValidation.valid) {
    fail("冻结 verificationPlan 不符合 exact schema", "WORKFLOW_V2_SYSTEM_GATE_PLAN_SCHEMA_INVALID", {
      errors: planValidation.errors,
    });
  }
  const planId = String(plan.planId || "");
  if (!planId || planId !== String(result.planId || "")) {
    return deepFreeze({
      schemaVersion: GATE_SCHEMA_VERSION,
      storyId,
      contextId,
      contextRevision,
      resultSha256,
      planId: result?.planId ?? null,
      status: "BLOCKED",
      reason: "result.planId 与冻结计划不一致",
    });
  }
  if (plan.status !== "READY") {
    return deepFreeze({
      schemaVersion: GATE_SCHEMA_VERSION,
      storyId,
      contextId,
      contextRevision,
      resultSha256,
      planId,
      status: "BLOCKED",
      reason: `冻结计划不可执行: ${(plan.blockers || []).join("；") || "execution profile missing"}`,
    });
  }
  if (!Array.isArray(plan.storyIds)
    || plan.storyIds.length !== new Set(plan.storyIds).size
    || !plan.storyIds.includes(storyId)) {
    return deepFreeze({
      schemaVersion: GATE_SCHEMA_VERSION,
      storyId,
      contextId,
      contextRevision,
      resultSha256,
      planId,
      status: "BLOCKED",
      reason: "冻结计划 storyIds 未绑定当前故事点",
    });
  }
  const planCases = normalizedPlanCases(plan);
  const executorById = executionProfileExecutors(dispatch, plan);
  if (!executorById || planCases.some((planCase) => {
    const executor = executorById.get(planCase.executorId);
    return !executor
      || String(executor.action || "") !== planCase.action
      || String(executor.rootId || executor.cwdRootId || "") !== planCase.rootId
      || !planCase.storyIds.includes(storyId);
  })) {
    return deepFreeze({
      schemaVersion: GATE_SCHEMA_VERSION,
      storyId,
      contextId,
      contextRevision,
      resultSha256,
      planId,
      status: "BLOCKED",
      reason: "verificationPlan case 与 Gateway 私有 executor profile 不一致",
    });
  }
  const resultById = resultCasesById(result);
  if (resultById.size !== planCases.length || [...resultById.keys()].some((caseId) => !planCases.some((c) => c.caseId === caseId))) {
    return deepFreeze({
      schemaVersion: GATE_SCHEMA_VERSION,
      storyId,
      contextId,
      contextRevision,
      resultSha256,
      planId,
      status: "BLOCKED",
      reason: "result.cases 与冻结计划不一致",
    });
  }
  const mandatory = planCases.filter((entry) => entry.mandatory);
  if (mandatory.length === 0) {
    return deepFreeze({
      schemaVersion: GATE_SCHEMA_VERSION,
      storyId,
      contextId,
      contextRevision,
      resultSha256,
      planId,
      status: "BLOCKED",
      reason: "冻结计划没有 mandatory case，无法系统计算 PASS",
    });
  }
  const evidenceContract = buildVerificationEvidenceContract(plan);
  if (!evidenceContract.ok) {
    return deepFreeze({
      schemaVersion: GATE_SCHEMA_VERSION,
      storyId,
      contextId,
      contextRevision,
      resultSha256,
      planId,
      status: "BLOCKED",
      code: evidenceContract.code,
      reason: evidenceContract.reason,
      details: evidenceContract.details,
    });
  }

  // A negative case result is already a safe system FAIL. Do not make that
  // path depend on positive evidence reads or material availability.
  for (const planCase of mandatory) {
    const entry = resultById.get(planCase.caseId);
    if (String(entry.status || "") !== "PASS") {
      return deepFreeze({
        schemaVersion: GATE_SCHEMA_VERSION,
        storyId,
        contextId,
        contextRevision,
        resultSha256,
        planId,
        status: "FAIL",
        reason: `mandatory case ${planCase.caseId} 状态不是 PASS`,
        caseId: planCase.caseId,
      });
    }
  }

  let envelopes;
  try {
    envelopes = await readEnvelopes({ tab, payloadSchemaId: WORKFLOW_V2_SCHEMA_IDS.evidenceReceipt });
  } catch (error) {
    fail("读取 evidence receipt envelopes 失败", "WORKFLOW_V2_SYSTEM_GATE_RECEIPT_READ_FAILED", {
      causeCode: String(error?.code || ""),
    });
  }
  if (!Array.isArray(envelopes)) fail("evidence receipt reader 未返回数组", "WORKFLOW_V2_SYSTEM_GATE_RECEIPT_READ_FAILED");
  const receiptById = loadReceiptIndex(envelopes, storyId);
  const claimedByCase = new Map();
  for (const planCase of mandatory) {
    const entry = resultById.get(planCase.caseId);
    const receiptIds = Array.isArray(entry.receiptIds) ? entry.receiptIds.map(String) : [];
    if (receiptIds.length === 0 || new Set(receiptIds).size !== receiptIds.length) {
      return deepFreeze({
        schemaVersion: GATE_SCHEMA_VERSION,
        storyId,
        contextId,
        contextRevision,
        resultSha256,
        planId,
        status: "FAIL",
        reason: `mandatory case ${planCase.caseId} 缺少或重复 receiptIds`,
        caseId: planCase.caseId,
      });
    }
    let verified = 0;
    for (const receiptId of receiptIds) {
      if (claimedByCase.has(receiptId)) {
        return deepFreeze({
          schemaVersion: GATE_SCHEMA_VERSION,
          storyId,
          contextId,
          contextRevision,
          resultSha256,
          planId,
          status: "FAIL",
          reason: `receiptId ${receiptId} 被多个 case 重复使用`,
          receiptId,
        });
      }
      const receipt = receiptById.get(receiptId);
      if (!receipt) {
        return deepFreeze({
          schemaVersion: GATE_SCHEMA_VERSION,
          storyId,
          contextId,
          contextRevision,
          resultSha256,
          planId,
          status: "FAIL",
          reason: `receiptId ${receiptId} 不存在`,
          receiptId,
        });
      }
      if (receipt.status !== "PASS"
        || receipt.action !== planCase.action
        || !receiptBindsVerificationCase(receipt, dispatch, {
          caseId: planCase.caseId,
          executorId: planCase.executorId,
          target: { rootId: planCase.rootId },
        })) {
        return deepFreeze({
          schemaVersion: GATE_SCHEMA_VERSION,
          storyId,
          contextId,
          contextRevision,
          resultSha256,
          planId,
          status: "FAIL",
          reason: `receiptId ${receiptId} 不是绑定当前冻结 context 的 PASS 回执`,
          receiptId,
        });
      }
      let outputEvidence;
      try {
        outputEvidence = await verifyReceiptOutput({ tab, receipt, storageApi });
      } catch (error) {
        outputEvidence = { valid: false, reason: error?.message || String(error) };
      }
      if (outputEvidence?.valid !== true) {
        return deepFreeze({
          schemaVersion: GATE_SCHEMA_VERSION,
          storyId,
          contextId,
          contextRevision,
          resultSha256,
          planId,
          status: "FAIL",
          reason: `receiptId ${receiptId} 的受控执行输出证据不可验证: ${outputEvidence?.reason || "unknown"}`,
          receiptId,
        });
      }
      claimedByCase.set(receiptId, planCase.caseId);
      verified += 1;
    }
    if (verified === 0) {
      return deepFreeze({
        schemaVersion: GATE_SCHEMA_VERSION,
        storyId,
        contextId,
        contextRevision,
        resultSha256,
        planId,
        status: "FAIL",
        reason: `mandatory case ${planCase.caseId} 无有效 PASS 回执`,
        caseId: planCase.caseId,
      });
    }

    const caseContract = evidenceContract.casesById.get(planCase.caseId);
    for (const requirement of caseContract.materialRequirements) {
      const candidates = [...receiptById.values()].filter((receipt) => (
        !claimedByCase.has(receipt.receiptId)
        && receiptProvesVerificationMaterial(receipt, dispatch, {
          caseId: planCase.caseId,
          executorId: planCase.executorId,
          target: { rootId: planCase.rootId },
        }, requirement)
      ));
      if (candidates.length !== 1) {
        return deepFreeze({
          schemaVersion: GATE_SCHEMA_VERSION,
          storyId,
          contextId,
          contextRevision,
          resultSha256,
          planId,
          status: "FAIL",
          reason: candidates.length === 0
            ? `mandatory case ${planCase.caseId} 缺少 ${requirement.requirement} 独立可信材料回执`
            : `mandatory case ${planCase.caseId} 的 ${requirement.requirement} 材料回执不唯一`,
          caseId: planCase.caseId,
          evidenceRequirement: requirement.requirement,
        });
      }
      const materialReceipt = candidates[0];
      let materialOutput;
      try {
        materialOutput = await verifyReceiptOutput({ tab, receipt: materialReceipt, storageApi });
      } catch (error) {
        materialOutput = { valid: false, reason: error?.message || String(error) };
      }
      if (materialOutput?.valid !== true) {
        return deepFreeze({
          schemaVersion: GATE_SCHEMA_VERSION,
          storyId,
          contextId,
          contextRevision,
          resultSha256,
          planId,
          status: "FAIL",
          reason: `mandatory case ${planCase.caseId} 的 ${requirement.requirement} 材料不可回读验证: ${materialOutput?.reason || "unknown"}`,
          caseId: planCase.caseId,
          evidenceRequirement: requirement.requirement,
          receiptId: materialReceipt.receiptId,
        });
      }
      claimedByCase.set(materialReceipt.receiptId, planCase.caseId);
    }
  }
  return deepFreeze({
    schemaVersion: GATE_SCHEMA_VERSION,
    storyId,
    contextId,
    contextRevision,
    resultSha256,
    planId,
    status: "PASS",
  });
}

export const trustedSystemGateSchemaVersion = GATE_SCHEMA_VERSION;
