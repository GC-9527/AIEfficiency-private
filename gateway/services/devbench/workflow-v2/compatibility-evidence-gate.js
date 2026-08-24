import { WORKFLOW_V2_SCHEMA_IDS, workflowV2SchemaRegistry } from "./schema-registry.js";
import { readWorkflowV2Envelopes } from "./envelope-store.js";
import { verifyControlledReceiptOutput } from "./controlled-receipt-evidence.js";
import {
  deriveWorkflowV2EditState,
  receiptBindsWorkflowV2EditState,
} from "./edit-state-binding.js";
import {
  buildVerificationEvidenceContract,
  receiptProvesVerificationMaterial,
} from "./verification-evidence-contract.js";

const RECEIPT_ACTIONS = new Set(["BUILD", "TEST", "DEVICE_ACTION", "DB_QUERY", "CAPTURE"]);

function blocked(code, error, details = {}) {
  return Object.freeze({ ok: false, status: "BLOCKED", code, error, details: Object.freeze({ ...details }) });
}

function passed(receiptIds) {
  return Object.freeze({
    ok: true,
    status: "PASS",
    code: null,
    error: null,
    receiptIds: Object.freeze([...receiptIds]),
  });
}

function receiptIndex(envelopes, storyId) {
  const receipts = [];
  const seen = new Set();
  for (const envelope of envelopes) {
    const envelopeValidation = workflowV2SchemaRegistry.validate(WORKFLOW_V2_SCHEMA_IDS.workflowEnvelope, envelope);
    const receiptValidation = workflowV2SchemaRegistry.validate(WORKFLOW_V2_SCHEMA_IDS.evidenceReceipt, envelope?.payload);
    if (!envelopeValidation.valid || !receiptValidation.valid
      || envelope.payloadSchemaId !== WORKFLOW_V2_SCHEMA_IDS.evidenceReceipt
      || envelope.contextId !== null
      || envelope.storyId !== storyId
      || envelope.recordId !== envelope.payload?.receiptId
      || seen.has(envelope.payload?.receiptId)) {
      return { error: blocked(
        "WORKFLOW_V2_COMPATIBILITY_EVIDENCE_ENVELOPE_INVALID",
        "evidence receipt envelope 无效或重复",
      ) };
    }
    seen.add(envelope.payload.receiptId);
    receipts.push(envelope.payload);
  }
  return { receipts, envelopes };
}

function bindsContext(receipt, dispatch) {
  return receipt?.selector?.contextId === dispatch.contextId
    && receipt?.selector?.contextRevision === dispatch.contextRevision;
}

function exactReceiptForEntry(receipts, dispatch, entry, selectorField, editState = null) {
  const expectedAction = String(entry.expectedReceiptAction || entry.action || "").trim().toUpperCase();
  const expectedId = String(entry[selectorField] || "").trim();
  const executorId = String(entry.executorId || "").trim();
  const rootId = String(entry.target?.rootId || entry.rootId || "").trim();
  if (!RECEIPT_ACTIONS.has(expectedAction) || !expectedId || !executorId || !rootId) return null;
  return receipts.find((receipt) => (
    receipt.status === "PASS"
    && receipt.action === expectedAction
    && receipt.rootId === rootId
    && bindsContext(receipt, dispatch)
    && receipt.selector?.[selectorField] === expectedId
    && receipt.selector?.executorId === executorId
    && (!["BUILD", "TEST"].includes(expectedAction)
      || receiptBindsWorkflowV2EditState(receipt, editState))
  )) || null;
}

function executorProfileMatches(dispatch, entries) {
  const profile = dispatch?.executionProfile;
  if (!profile || dispatch?.executionStatus?.status !== "READY"
    || dispatch.executionStatus.profileId !== profile.profileId
    || !Array.isArray(profile.executors)) return false;
  const executors = new Map();
  for (const executor of profile.executors) {
    const executorId = String(executor?.executorId || "");
    if (!executorId || executors.has(executorId)) return false;
    executors.set(executorId, executor);
  }
  return entries.every((entry) => {
    const executor = executors.get(String(entry?.executorId || ""));
    return executor
      && String(executor.action || "") === String(entry?.action || entry?.expectedReceiptAction || "")
      && String(executor.cwdRootId || "") === String(entry?.target?.rootId || entry?.rootId || "");
  });
}

async function validateRepairEvidence(receipts, envelopes, dispatch, { tab, storageApi, verifyReceiptOutput }) {
  const checks = dispatch.context?.data?.localChecks;
  const mandatory = Array.isArray(checks) ? checks.filter((entry) => entry?.mandatory === true) : [];
  if (mandatory.length === 0) {
    return blocked(
      "WORKFLOW_V2_COMPATIBILITY_REPAIR_PROFILE_MISSING",
      "FIX_DONE 缺少冻结的 mandatory 本地检查配置",
    );
  }
  const checkIds = mandatory.map((entry) => String(entry?.checkId || ""));
  if (checkIds.some((id) => !id) || new Set(checkIds).size !== checkIds.length) {
    return blocked(
      "WORKFLOW_V2_COMPATIBILITY_REPAIR_PROFILE_INVALID",
      "冻结 localChecks 含空或重复 checkId",
    );
  }
  if (!executorProfileMatches(dispatch, mandatory)) {
    return blocked(
      "WORKFLOW_V2_COMPATIBILITY_REPAIR_PROFILE_INVALID",
      "冻结 localChecks 与 Gateway 私有 executor profile 不一致",
    );
  }
  const stateByRoot = new Map();
  const mandatoryRootIds = [...new Set(mandatory
    .map((entry) => String(entry?.rootId || entry?.target?.rootId || ""))
    .filter(Boolean))];
  try {
    for (const rootId of mandatoryRootIds) {
      stateByRoot.set(rootId, deriveWorkflowV2EditState({
        envelopes,
        storyId: String(tab.id),
        contextId: dispatch.contextId,
        contextRevision: dispatch.contextRevision,
        rootId,
      }));
    }
  } catch (error) {
    return blocked(
      "WORKFLOW_V2_COMPATIBILITY_EDIT_STATE_INVALID",
      "无法从 append-only receipt stream 派生最终 EDIT 状态",
      { causeCode: String(error?.code || "") },
    );
  }
  const changedStates = [...stateByRoot.values()].filter((state) => state.files.length > 0);
  if (!changedStates.length) {
    return blocked(
      "WORKFLOW_V2_COMPATIBILITY_EDIT_RECEIPT_MISSING",
      "FIX_DONE 缺少绑定当前 context 的真实 EDIT/PASS 前后哈希回执",
    );
  }
  const selected = changedStates.flatMap((state) => state.files.map((entry) => entry.receiptId));
  for (const check of mandatory) {
    const rootId = String(check?.rootId || check?.target?.rootId || "");
    const receipt = exactReceiptForEntry(receipts, dispatch, check, "checkId", stateByRoot.get(rootId));
    if (!receipt) {
      return blocked(
        "WORKFLOW_V2_COMPATIBILITY_LOCAL_CHECK_RECEIPT_MISSING",
        `FIX_DONE 缺少 mandatory check ${check.checkId} 的可信 PASS 回执`,
        { checkId: check.checkId },
      );
    }
    let outputEvidence;
    try {
      outputEvidence = await verifyReceiptOutput({ tab, receipt, storageApi });
    } catch (error) {
      outputEvidence = { valid: false, reason: error?.message || String(error) };
    }
    if (outputEvidence?.valid !== true) {
      return blocked(
        "WORKFLOW_V2_COMPATIBILITY_RECEIPT_OUTPUT_INVALID",
        `mandatory check ${check.checkId} 的受控输出证据不可验证`,
        { checkId: check.checkId, reason: outputEvidence?.reason || "unknown" },
      );
    }
    selected.push(receipt.receiptId);
  }
  if (new Set(selected).size !== selected.length) {
    return blocked(
      "WORKFLOW_V2_COMPATIBILITY_RECEIPT_REUSE",
      "同一 receipt 不能重复证明多个修复要求",
    );
  }
  return passed(selected);
}

async function validateVerifyEvidence(receipts, envelopes, dispatch, {
  tab,
  storageApi,
  verifyReceiptOutput,
  verificationContract = null,
}) {
  const plan = dispatch.context?.data?.verificationPlan;
  const schemaId = WORKFLOW_V2_SCHEMA_IDS.verificationPlan;
  if (!schemaId) {
    return blocked("WORKFLOW_V2_COMPATIBILITY_VERIFY_PLAN_SCHEMA_MISSING", "verificationPlan schema 未注册");
  }
  const validation = workflowV2SchemaRegistry.validate(schemaId, plan);
  if (!validation.valid) {
    return blocked(
      "WORKFLOW_V2_COMPATIBILITY_VERIFY_PLAN_INVALID",
      "冻结 verificationPlan 不符合 exact schema",
      { errors: validation.errors },
    );
  }
  const storyId = String(dispatch.context?.story?.storyId || "");
  if (!storyId || !Array.isArray(plan.storyIds)
    || plan.storyIds.length !== new Set(plan.storyIds).size
    || !plan.storyIds.includes(storyId)) {
    return blocked(
      "WORKFLOW_V2_COMPATIBILITY_VERIFY_PLAN_STORY_MISMATCH",
      "verificationPlan 未精确绑定当前故事点",
    );
  }
  const mandatory = plan.cases.filter((entry) => entry.mandatory === true);
  const caseIds = plan.cases.map((entry) => entry.caseId);
  if (mandatory.length === 0 || new Set(caseIds).size !== caseIds.length) {
    return blocked(
      "WORKFLOW_V2_COMPATIBILITY_VERIFY_PLAN_CASES_INVALID",
      "verificationPlan 缺少 mandatory case 或包含重复 caseId",
    );
  }
  const evidenceContract = verificationContract || buildVerificationEvidenceContract(plan);
  if (!evidenceContract.ok) {
    return blocked(evidenceContract.code, evidenceContract.reason, evidenceContract.details);
  }
  if (plan.profileId !== dispatch?.executionStatus?.profileId
    || !executorProfileMatches(dispatch, mandatory)) {
    return blocked(
      "WORKFLOW_V2_COMPATIBILITY_VERIFY_PROFILE_INVALID",
      "verificationPlan 与 Gateway 私有 executor profile 不一致",
    );
  }
  const selected = [];
  const stateByRoot = new Map();
  for (const planCase of mandatory) {
    const rootId = String(planCase?.target?.rootId || planCase?.rootId || "");
    let state = null;
    if (["BUILD", "TEST"].includes(String(planCase?.action || ""))) {
      try {
        if (!stateByRoot.has(rootId)) {
          stateByRoot.set(rootId, deriveWorkflowV2EditState({
            envelopes,
            storyId: String(tab.id),
            contextId: dispatch.contextId,
            contextRevision: dispatch.contextRevision,
            rootId,
          }));
        }
        state = stateByRoot.get(rootId);
      } catch (error) {
        return blocked(
          "WORKFLOW_V2_COMPATIBILITY_EDIT_STATE_INVALID",
          "无法派生 VERIFY BUILD/TEST 的最终 EDIT 状态",
          { caseId: planCase.caseId, causeCode: String(error?.code || "") },
        );
      }
    }
    const receipt = exactReceiptForEntry(receipts, dispatch, planCase, "caseId", state);
    if (!receipt) {
      return blocked(
        "WORKFLOW_V2_COMPATIBILITY_VERIFY_RECEIPT_MISSING",
        `VERIFY PASS 缺少 mandatory case ${planCase.caseId} 的可信 PASS 回执`,
        { caseId: planCase.caseId },
      );
    }
    let outputEvidence;
    try {
      outputEvidence = await verifyReceiptOutput({ tab, receipt, storageApi });
    } catch (error) {
      outputEvidence = { valid: false, reason: error?.message || String(error) };
    }
    if (outputEvidence?.valid !== true) {
      return blocked(
        "WORKFLOW_V2_COMPATIBILITY_RECEIPT_OUTPUT_INVALID",
        `mandatory case ${planCase.caseId} 的受控输出证据不可验证`,
        { caseId: planCase.caseId, reason: outputEvidence?.reason || "unknown" },
      );
    }
    selected.push(receipt.receiptId);
    const caseContract = evidenceContract.casesById.get(String(planCase.caseId));
    for (const requirement of caseContract.materialRequirements) {
      const candidates = receipts.filter((candidate) => (
        !selected.includes(candidate.receiptId)
        && receiptProvesVerificationMaterial(candidate, dispatch, planCase, requirement)
      ));
      if (candidates.length !== 1) {
        return blocked(
          candidates.length === 0
            ? "WORKFLOW_V2_COMPATIBILITY_VERIFY_MATERIAL_MISSING"
            : "WORKFLOW_V2_COMPATIBILITY_VERIFY_MATERIAL_AMBIGUOUS",
          candidates.length === 0
            ? `VERIFY PASS 缺少 mandatory case ${planCase.caseId} 的 ${requirement.requirement} 独立可信材料回执`
            : `mandatory case ${planCase.caseId} 的 ${requirement.requirement} 材料回执不唯一`,
          { caseId: planCase.caseId, evidenceRequirement: requirement.requirement },
        );
      }
      const materialReceipt = candidates[0];
      let materialOutput;
      try {
        materialOutput = await verifyReceiptOutput({ tab, receipt: materialReceipt, storageApi });
      } catch (error) {
        materialOutput = { valid: false, reason: error?.message || String(error) };
      }
      if (materialOutput?.valid !== true) {
        return blocked(
          "WORKFLOW_V2_COMPATIBILITY_RECEIPT_OUTPUT_INVALID",
          `mandatory case ${planCase.caseId} 的 ${requirement.requirement} 材料不可回读验证`,
          {
            caseId: planCase.caseId,
            evidenceRequirement: requirement.requirement,
            reason: materialOutput?.reason || "unknown",
          },
        );
      }
      selected.push(materialReceipt.receiptId);
    }
  }
  if (new Set(selected).size !== selected.length) {
    return blocked(
      "WORKFLOW_V2_COMPATIBILITY_RECEIPT_REUSE",
      "同一 receipt 不能重复证明多个验收 case",
    );
  }
  return passed(selected);
}

/**
 * Compatibility text is only a structural proposal. Positive REPAIR/VERIFY
 * transitions are authorized from persisted Gateway receipts, never from a
 * receipt-looking string in Provider output. VERIFY FAIL remains a safe
 * fail-closed transition and does not require positive evidence.
 */
export async function validateCompatibilityWorkflowEvidence({
  tab,
  dispatch,
  markerKind,
  readEnvelopes = readWorkflowV2Envelopes,
  storageApi,
  verifyReceiptOutput = verifyControlledReceiptOutput,
} = {}) {
  if (!["fix_done", "verify_pass"].includes(markerKind)) return passed([]);
  const storyId = String(dispatch?.context?.story?.storyId || "");
  if (!tab || !storyId || String(tab.id || "") !== storyId
    || dispatch?.contextId !== dispatch?.context?.contextId
    || dispatch?.contextRevision !== dispatch?.context?.revision) {
    return blocked(
      "WORKFLOW_V2_COMPATIBILITY_EVIDENCE_IDENTITY_MISMATCH",
      "compatibility evidence gate 与冻结 context 身份不一致",
    );
  }
  let verificationContract = null;
  if (markerKind === "verify_pass") {
    const plan = dispatch.context?.data?.verificationPlan;
    const validation = workflowV2SchemaRegistry.validate(WORKFLOW_V2_SCHEMA_IDS.verificationPlan, plan);
    if (!validation.valid) {
      return blocked(
        "WORKFLOW_V2_COMPATIBILITY_VERIFY_PLAN_INVALID",
        "冻结 verificationPlan 不符合 exact schema",
        { errors: validation.errors },
      );
    }
    verificationContract = buildVerificationEvidenceContract(plan);
    if (!verificationContract.ok) {
      return blocked(verificationContract.code, verificationContract.reason, verificationContract.details);
    }
  }
  let envelopes;
  try {
    envelopes = await readEnvelopes({ tab, payloadSchemaId: WORKFLOW_V2_SCHEMA_IDS.evidenceReceipt });
  } catch (error) {
    return blocked(
      "WORKFLOW_V2_COMPATIBILITY_EVIDENCE_READ_FAILED",
      `读取 evidence receipt 失败: ${error?.message || error}`,
    );
  }
  if (!Array.isArray(envelopes)) {
    return blocked("WORKFLOW_V2_COMPATIBILITY_EVIDENCE_READ_FAILED", "receipt reader 未返回数组");
  }
  const indexed = receiptIndex(envelopes, storyId);
  if (indexed.error) return indexed.error;
  return markerKind === "fix_done"
    ? validateRepairEvidence(indexed.receipts, indexed.envelopes, dispatch, { tab, storageApi, verifyReceiptOutput })
    : validateVerifyEvidence(indexed.receipts, indexed.envelopes, dispatch, {
      tab,
      storageApi,
      verifyReceiptOutput,
      verificationContract,
    });
}
