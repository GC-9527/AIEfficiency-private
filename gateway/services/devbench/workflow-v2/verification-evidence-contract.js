const VERIFY_ACTIONS = Object.freeze(["BUILD", "TEST", "DEVICE_ACTION", "DB_QUERY", "CAPTURE"]);
const VERIFY_ACTION_SET = new Set(VERIFY_ACTIONS);
const MATERIAL_REQUIREMENTS = Object.freeze({
  video: "VIDEO",
  screenshot: "IMAGE",
  logcat: "LOG",
});

function sortedUnique(values) {
  return [...new Set(values)].sort();
}

function sameStrings(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function blocked(code, reason, details = {}) {
  return Object.freeze({ ok: false, code, reason, details: Object.freeze({ ...details }) });
}

/**
 * Semantic validation which JSON Schema cannot express: every declared
 * mandatory capability must be implemented by at least one mandatory case and
 * no mandatory case capability may be omitted. Evidence requirements use a
 * deliberately closed vocabulary; arbitrary prose can never authorize PASS.
 */
export function buildVerificationEvidenceContract(plan) {
  const cases = Array.isArray(plan?.cases) ? plan.cases : [];
  const mandatoryCases = cases.filter((entry) => entry?.mandatory === true);
  const declaredCapabilities = sortedUnique((Array.isArray(plan?.mandatoryCapabilities)
    ? plan.mandatoryCapabilities
    : []).map((entry) => String(entry || "").trim().toUpperCase()));
  const caseCapabilities = sortedUnique(mandatoryCases
    .map((entry) => String(entry?.action || "").trim().toUpperCase()));
  if (declaredCapabilities.some((entry) => !VERIFY_ACTION_SET.has(entry))
    || !sameStrings(declaredCapabilities, caseCapabilities)) {
    return blocked(
      "WORKFLOW_V2_VERIFY_MANDATORY_CAPABILITY_MISMATCH",
      "verificationPlan mandatoryCapabilities 必须由 mandatory cases 精确覆盖",
      {
        declaredCapabilities,
        caseCapabilities,
        missingMandatoryCases: declaredCapabilities.filter((entry) => !caseCapabilities.includes(entry)),
        undeclaredCaseCapabilities: caseCapabilities.filter((entry) => !declaredCapabilities.includes(entry)),
      },
    );
  }

  const casesById = new Map();
  for (const planCase of mandatoryCases) {
    const caseId = String(planCase?.caseId || "");
    const action = String(planCase?.action || "").trim().toUpperCase();
    const rawRequirements = Array.isArray(planCase?.evidenceRequirements)
      ? planCase.evidenceRequirements
      : [];
    const requirements = [];
    const seen = new Set();
    for (const rawRequirement of rawRequirements) {
      const normalized = String(rawRequirement || "").trim().toLowerCase();
      if (!normalized || seen.has(normalized)) {
        return blocked(
          "WORKFLOW_V2_VERIFY_EVIDENCE_REQUIREMENT_INVALID",
          `mandatory case ${caseId} 含空或重复 evidenceRequirement`,
          { caseId, evidenceRequirement: normalized || null },
        );
      }
      seen.add(normalized);
      if (normalized === "receipt") {
        requirements.push(Object.freeze({ kind: "CAPABILITY", requirement: normalized, action }));
        continue;
      }
      const receiptMatch = /^([a-z_]+)\s+receipt$/u.exec(normalized);
      if (receiptMatch) {
        const requiredAction = receiptMatch[1].toUpperCase();
        if (!VERIFY_ACTION_SET.has(requiredAction) || requiredAction !== action) {
          return blocked(
            "WORKFLOW_V2_VERIFY_EVIDENCE_REQUIREMENT_INVALID",
            `mandatory case ${caseId} 的 evidenceRequirement 未绑定本 case capability`,
            { caseId, evidenceRequirement: normalized, action },
          );
        }
        requirements.push(Object.freeze({ kind: "CAPABILITY", requirement: normalized, action }));
        continue;
      }
      const materialKind = MATERIAL_REQUIREMENTS[normalized];
      if (materialKind) {
        requirements.push(Object.freeze({
          kind: "MATERIAL",
          requirement: normalized,
          action: "CAPTURE",
          materialKind,
        }));
        continue;
      }
      return blocked(
        "WORKFLOW_V2_VERIFY_EVIDENCE_REQUIREMENT_UNSUPPORTED",
        `mandatory case ${caseId} 的 evidenceRequirement 无可信映射`,
        { caseId, evidenceRequirement: normalized },
      );
    }
    casesById.set(caseId, Object.freeze({
      caseId,
      action,
      capabilityRequirements: Object.freeze(requirements.filter((entry) => entry.kind === "CAPABILITY")),
      materialRequirements: Object.freeze(requirements.filter((entry) => entry.kind === "MATERIAL")),
    }));
  }
  return Object.freeze({
    ok: true,
    mandatoryCapabilities: Object.freeze(caseCapabilities),
    casesById,
  });
}

export function receiptBindsVerificationCase(receipt, dispatch, planCase) {
  return !!receipt
    && receipt.rootId === String(planCase?.target?.rootId || "")
    && receipt.selector?.contextId === dispatch?.contextId
    && receipt.selector?.contextRevision === dispatch?.contextRevision
    && receipt.selector?.caseId === String(planCase?.caseId || "")
    && receipt.selector?.executorId === String(planCase?.executorId || "");
}

export function receiptProvesVerificationMaterial(receipt, dispatch, planCase, requirement) {
  const sha256 = String(receipt?.sha256 || "");
  const outputMatch = /^storydev:\/workflow-v2\/capture-output\/([a-f0-9]{64})\.bin$/u
    .exec(String(receipt?.outputRef || ""));
  return receiptBindsVerificationCase(receipt, dispatch, planCase)
    && receipt?.status === "PASS"
    && receipt?.action === "CAPTURE"
    && receipt?.selector?.evidenceRequirement === requirement?.requirement
    && receipt?.selector?.materialKind === requirement?.materialKind
    && typeof receipt?.evidenceId === "string" && receipt.evidenceId.trim().length > 0
    && !!outputMatch
    && /^[a-f0-9]{64}$/u.test(sha256)
    && outputMatch[1] === sha256;
}

export const WORKFLOW_V2_VERIFICATION_MATERIAL_REQUIREMENTS = MATERIAL_REQUIREMENTS;
