import { createHash, randomUUID } from "node:crypto";
import {
  evaluationTargetGraphKey,
  normalizeEvaluationTargetGraph,
} from "./evaluator.js";

const REVIEWABLE_STATUSES = new Set(["annotation", "pending", "submitted"]);
const POSITIVE_DECISIONS = new Set(["correct", "corrected"]);
const NEGATIVE_DECISIONS = new Set(["insufficient", "ticket_wrong", "not_applicable", "no_target"]);
const VALID_DECISIONS = new Set([...POSITIVE_DECISIONS, ...NEGATIVE_DECISIONS]);

function text(value, limit = 10_000) {
  return String(value ?? "").trim().slice(0, limit);
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
}

function digest(value) {
  return createHash("sha256").update(JSON.stringify(stable(value))).digest("hex");
}

function timestamp(value) {
  const numeric = Number(value);
  if (Number.isFinite(numeric) && String(value ?? "").trim()) return numeric;
  const parsed = Date.parse(String(value || ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.values(value).forEach(deepFreeze);
  return Object.freeze(value);
}

function cloneValue(value) {
  if (Array.isArray(value)) return value.map(cloneValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, cloneValue(child)]));
}

function labelOf(annotation = {}) {
  const decision = text(annotation?.decision || annotation?.feedback?.decision).toLowerCase();
  const targets = normalizeEvaluationTargetGraph(
    annotation?.targets
    || annotation?.correctedPrediction?.targets
    || annotation?.label?.targets
    || [],
  );
  const noTargets = annotation?.noTargets === true || NEGATIVE_DECISIONS.has(decision);
  return {
    decision,
    noTargets,
    targets: noTargets ? [] : targets,
  };
}

function labelKey(annotation) {
  const label = labelOf(annotation);
  return JSON.stringify({
    decision: label.decision,
    noTargets: label.noTargets,
    targetGraph: evaluationTargetGraphKey(label.targets),
  });
}

function portableApprovedTargets(businessTargets = [], portableTargets = []) {
  const normalizedBusiness = normalizeEvaluationTargetGraph(businessTargets);
  if (!Array.isArray(portableTargets) || portableTargets.length === 0) return normalizedBusiness;
  const normalizedPortable = normalizeEvaluationTargetGraph(portableTargets);
  if (evaluationTargetGraphKey(normalizedBusiness) !== evaluationTargetGraphKey(normalizedPortable)) {
    throw new Error("approved label 的稳定 Key 目标图与双审业务目标图不一致");
  }
  const portableByIdentity = new Map();
  for (const source of portableTargets) {
    const normalized = normalizeEvaluationTargetGraph([source])[0];
    if (!normalized) continue;
    const identity = JSON.stringify(normalized);
    if (!portableByIdentity.has(identity)) portableByIdentity.set(identity, []);
    portableByIdentity.get(identity).push(source);
  }
  return normalizedBusiness.map((target) => {
    const identity = JSON.stringify(target);
    const source = portableByIdentity.get(identity)?.shift();
    const bindings = Object.fromEntries(
      Object.entries(source?.fieldBindings || {})
        .map(([field, binding]) => [
          text(field, 100),
          { logicalKey: text(binding?.logicalKey, 500) },
        ])
        .filter(([field, binding]) => field && binding.logicalKey),
    );
    return Object.keys(bindings).length > 0
      ? { ...target, fieldBindings: bindings }
      : target;
  });
}

function latestDistinctReviewers(annotations = []) {
  const sorted = [...annotations].sort((left, right) => (
    Number(right?.revision || 0) - Number(left?.revision || 0)
    || timestamp(right?.updatedAt || right?.createdAt) - timestamp(left?.updatedAt || left?.createdAt)
    || text(right?.id).localeCompare(text(left?.id))
  ));
  const seen = new Set();
  return sorted.filter((annotation) => {
    const reviewerId = text(annotation?.reviewerId || annotation?.reviewer?.id || annotation?.createdBy);
    if (!reviewerId || seen.has(reviewerId)) return false;
    seen.add(reviewerId);
    return true;
  });
}

function annotationBlockers(annotation = {}) {
  const blockers = [];
  const label = labelOf(annotation);
  if (!VALID_DECISIONS.has(label.decision)) blockers.push("DECISION_INVALID");
  if (POSITIVE_DECISIONS.has(label.decision) && label.targets.length === 0) {
    blockers.push("TARGET_GRAPH_REQUIRED");
  }
  if (POSITIVE_DECISIONS.has(label.decision) && !annotation?.sourceGatePassed) {
    blockers.push("SOURCE_GATE_NOT_PASSED");
  }
  if (POSITIVE_DECISIONS.has(label.decision) && annotation?.unresolvedSymbolic === true) {
    blockers.push("SYMBOLIC_UNRESOLVED");
  }
  if (POSITIVE_DECISIONS.has(label.decision)) {
    const registryStatus = text(annotation?.registryChangeStatus).toLowerCase();
    if (
      (annotation?.registryChangeRequired === true && !["active", "approved"].includes(registryStatus))
      || (registryStatus && !["active", "approved", "not_required"].includes(registryStatus))
    ) {
      blockers.push("REGISTRY_CHANGE_NOT_ACTIVE");
    }
  }
  if (POSITIVE_DECISIONS.has(label.decision) && annotation?.snapshotApplied !== true) {
    blockers.push("SNAPSHOT_NOT_APPLIED");
  }
  return blockers;
}

/**
 * Resolve a case from distinct reviewer annotations. Conflicting labels always require an explicit
 * adjudicator, even if one side reaches quorum, preventing majority clicks from silently changing
 * the registry/serving truth.
 */
export function adjudicateConfigInferenceAnnotations(annotations = [], {
  requiredReviewers = 2,
} = {}) {
  const rows = (Array.isArray(annotations) ? annotations : []).filter((annotation) => (
    REVIEWABLE_STATUSES.has(text(annotation?.status || "annotation").toLowerCase())
    && !annotation?.revokedAt
    && !annotation?.supersededBy
  ));
  const caseIds = [...new Set(rows.map((row) => text(row?.caseId || row?.sourceRunId)).filter(Boolean))];
  if (caseIds.length > 1) {
    return {
      status: "invalid",
      blockers: ["MULTIPLE_CASES"],
      caseIds,
      annotations: [],
    };
  }
  const distinct = latestDistinctReviewers(rows);
  const blockers = [...new Set(distinct.flatMap(annotationBlockers))];
  const groups = new Map();
  for (const annotation of distinct) {
    const key = labelKey(annotation);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(annotation);
  }
  const labelGroups = [...groups.entries()].map(([key, members]) => ({
    key,
    count: members.length,
    annotationIds: members.map((row) => text(row?.id)),
    reviewerIds: members.map((row) => text(row?.reviewerId || row?.reviewer?.id || row?.createdBy)),
    label: labelOf(members[0]),
  })).sort((left, right) => right.count - left.count || left.key.localeCompare(right.key));
  const quorum = Math.max(1, Math.trunc(Number(requiredReviewers) || 2));

  let status = "insufficient_reviewers";
  if (blockers.length > 0) status = "blocked";
  else if (labelGroups.length > 1) status = "adjudication_required";
  else if ((labelGroups[0]?.count || 0) >= quorum) status = "approved";

  return {
    status,
    caseId: caseIds[0] || "",
    requiredReviewers: quorum,
    distinctReviewerCount: distinct.length,
    blockers,
    annotations: distinct.map((row) => ({
      id: text(row?.id),
      revision: Math.max(1, Math.trunc(Number(row?.revision) || 1)),
      reviewerId: text(row?.reviewerId || row?.reviewer?.id || row?.createdBy),
      labelKey: labelKey(row),
    })),
    labelGroups,
    approvedLabel: status === "approved" ? labelGroups[0].label : null,
  };
}

export function createApprovedConfigInferenceLabel(adjudication = {}, {
  approvedBy = "two-reviewer-consensus",
  approvedAt = new Date().toISOString(),
  registryRevision = "",
  rulesVersion = "",
  featureSchemaVersion = "",
  portableTargets = [],
  id = "",
} = {}) {
  if (adjudication?.status !== "approved" || !adjudication?.approvedLabel) {
    throw new Error("只有完成裁决的 annotation 才能生成 approved label");
  }
  const sourceAnnotationIds = [...new Set(
    (adjudication.annotations || []).map((row) => text(row?.id)).filter(Boolean),
  )].sort();
  const payload = {
    caseId: text(adjudication.caseId),
    label: {
      ...adjudication.approvedLabel,
      targets: portableApprovedTargets(adjudication.approvedLabel.targets, portableTargets),
    },
    sourceAnnotationIds,
    reviewerIds: [...new Set(
      (adjudication.annotations || []).map((row) => text(row?.reviewerId)).filter(Boolean),
    )].sort(),
    approvedBy: text(approvedBy),
    approvedAt: new Date(approvedAt).toISOString(),
    registryRevision: text(registryRevision),
    rulesVersion: text(rulesVersion),
    featureSchemaVersion: text(featureSchemaVersion),
  };
  return deepFreeze({
    id: text(id) || `label_${randomUUID()}`,
    status: "approved",
    ...cloneValue(payload),
    fingerprint: digest(payload),
    servingEligible: true,
  });
}

export function previewAnnotationImpact(annotation = {}, {
  servingSamples = [],
  datasetCases = [],
  activeRuns = [],
} = {}) {
  const id = text(annotation?.id);
  const caseId = text(annotation?.caseId || annotation?.sourceRunId);
  const references = (row) => (
    text(row?.annotationId) === id
    || (row?.sourceAnnotationIds || []).map((item) => text(item)).includes(id)
    || (caseId && text(row?.caseId || row?.sourceRunId) === caseId)
  );
  return {
    annotationId: id,
    caseId,
    servingSamples: servingSamples.filter(references).map((row) => text(row?.id)).filter(Boolean),
    datasetCases: datasetCases.filter(references).map((row) => text(row?.id || row?.caseId)).filter(Boolean),
    activeRuns: activeRuns.filter(references).map((row) => text(row?.id || row?.runId)).filter(Boolean),
  };
}
