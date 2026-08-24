import { createHash } from "node:crypto";

function text(value, limit = 2000) {
  return String(value ?? "").trim().slice(0, limit);
}

function finite(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function clamp(value, min = 0, max = 1) {
  return Math.min(max, Math.max(min, finite(value)));
}

function deterministicJitter(value) {
  const hash = createHash("sha256").update(String(value || "")).digest();
  return hash.readUInt16BE(0) / 0xffff;
}

function timestamp(value, fallback) {
  if (Number.isFinite(Number(value)) && String(value || "").trim()) return Number(value);
  const parsed = Date.parse(String(value || ""));
  return Number.isFinite(parsed) ? parsed : fallback;
}

function incompleteSources(row = {}) {
  const coverage = row.sourceCoverage && typeof row.sourceCoverage === "object"
    ? row.sourceCoverage
    : row.ticket?.sourceCoverage && typeof row.ticket.sourceCoverage === "object"
      ? row.ticket.sourceCoverage
      : {};
  return Object.entries(coverage)
    .filter(([, state]) => state?.available === false || state?.complete === false)
    .map(([source]) => source);
}

function caseDimensions(row = {}) {
  const targets = row.prediction?.targets || row.targets || [];
  const first = Array.isArray(targets) ? targets[0] || {} : {};
  return {
    project: text(row.projectId),
    application: text(first.appName || row.appName) || "(empty)",
    vehicle: text(first.vehicle || row.vehicle) || "(empty)",
    repository: text(first.repositoryId || row.repositoryId) || "(empty)",
  };
}

function rarityKey(dimensions) {
  return [dimensions.project, dimensions.application, dimensions.vehicle, dimensions.repository].join("\u0000");
}

/**
 * Order candidate TB cases for human annotation. This is deterministic and deliberately favors:
 * uncertainty, conflicting/OOD results, incomplete-source diagnosis, rare slices and recent drift.
 */
export function prioritizeConfigInferenceCases(cases = [], {
  sliceCounts = {},
  now = Date.now(),
  excludeReviewed = true,
  excludeClaimed = true,
} = {}) {
  const rows = Array.isArray(cases) ? cases : [];
  return rows.flatMap((row, index) => {
    const annotationStatus = text(row.annotation?.status || row.governanceStatus).toLowerCase();
    if (
      excludeReviewed
      && (
        row.review
        || ["annotation", "pending", "submitted", "approved", "active"].includes(annotationStatus)
      )
    ) return [];
    if (excludeClaimed && (row.claimed === true || row.trainingClaim?.active === true)) return [];
    const id = text(row.id || row.ticketId || row.tbTaskId) || `case_${index + 1}`;
    const prediction = row.prediction || row.inference || {};
    const confidence = clamp(prediction.calibratedProbability ?? prediction.confidenceScore ?? prediction.confidence, 0, 1);
    const margin = clamp(prediction.margin ?? prediction.top1Top2Margin, 0, 1);
    const conflicts = Math.max(0, finite(prediction.conflictCount ?? prediction.quality?.conflictCount));
    const ood = prediction.ood === true || prediction.quality?.outOfDistribution === true;
    const missing = incompleteSources(row);
    const dimensions = caseDimensions(row);
    const count = Math.max(0, finite(sliceCounts[rarityKey(dimensions)]));
    const updatedAt = timestamp(row.updatedAt || row.snapshotAt, now);
    const ageDays = Math.max(0, (now - updatedAt) / 86_400_000);

    const uncertaintyScore = (1 - Math.abs(confidence - 0.5) * 2) * 35;
    const lowMarginScore = (1 - margin) * 22;
    const conflictScore = Math.min(24, conflicts * 8);
    const oodScore = ood ? 24 : 0;
    const sourceDiagnosisScore = Math.min(18, missing.length * 6);
    const rarityScore = 20 / Math.sqrt(count + 1);
    const recencyScore = Math.max(0, 8 - Math.min(8, ageDays / 7));
    const jitter = deterministicJitter(id) * 0.001;
    const priority = uncertaintyScore + lowMarginScore + conflictScore + oodScore
      + sourceDiagnosisScore + rarityScore + recencyScore + jitter;

    return [{
      ...row,
      activeLearning: {
        priority: Number(priority.toFixed(6)),
        reasons: [
          ...(uncertaintyScore >= 20 ? ["uncertain"] : []),
          ...(lowMarginScore >= 15 ? ["low_margin"] : []),
          ...(conflicts ? ["conflict"] : []),
          ...(ood ? ["ood"] : []),
          ...(missing.length ? ["source_incomplete"] : []),
          ...(count < 3 ? ["rare_slice"] : []),
        ],
        incompleteSources: missing,
        dimensions,
        sliceCount: count,
      },
    }];
  }).sort((left, right) => (
    right.activeLearning.priority - left.activeLearning.priority
    || text(left.id || left.ticketId).localeCompare(text(right.id || right.ticketId))
  ));
}

/**
 * Select a stratified annotation batch without allowing one high-frequency slice to dominate.
 */
export function selectConfigInferenceAnnotationBatch(cases = [], {
  limit = 20,
  maxPerSlice = 4,
  ...options
} = {}) {
  const ranked = prioritizeConfigInferenceCases(cases, options);
  const selected = [];
  const counts = new Map();
  for (const row of ranked) {
    if (selected.length >= Math.max(0, Math.trunc(finite(limit, 20)))) break;
    const key = rarityKey(row.activeLearning.dimensions);
    const count = counts.get(key) || 0;
    if (count >= Math.max(1, Math.trunc(finite(maxPerSlice, 4)))) continue;
    counts.set(key, count + 1);
    selected.push(row);
  }
  return selected;
}
