function finite(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function clamp(value, min = 0, max = 1) {
  return Math.min(max, Math.max(min, finite(value)));
}

function sourceIncomplete(coverage = {}, requiredSources = []) {
  return [...new Set(requiredSources.map((value) => String(value || "").trim()).filter(Boolean))]
    .filter((source) => {
      const state = coverage?.[source];
      return !state || state.available !== true || state.complete !== true;
    });
}

/**
 * Pool-adjacent-violators isotonic regression. It learns a monotonic mapping from heuristic
 * rank scores to empirical correctness without pretending an arbitrary score is probability.
 */
export function fitIsotonicCalibrator(samples = [], {
  scoreField = "score",
  labelField = "label",
  minSamples = 20,
} = {}) {
  const rows = (Array.isArray(samples) ? samples : []).flatMap((row) => {
    const score = Number(row?.[scoreField]);
    const label = row?.[labelField] === true ? 1 : row?.[labelField] === false ? 0 : Number(row?.[labelField]);
    const weight = Math.max(0.000001, finite(row?.weight, 1));
    if (!Number.isFinite(score) || ![0, 1].includes(label)) return [];
    return [{ score, label, weight }];
  }).sort((left, right) => left.score - right.score);

  if (rows.length < Math.max(2, Math.trunc(finite(minSamples, 20)))) {
    return {
      schemaVersion: "config-inference-calibrator-v1",
      method: "isotonic",
      status: "insufficient_data",
      sampleCount: rows.length,
      minSamples: Math.max(2, Math.trunc(finite(minSamples, 20))),
      points: [],
    };
  }

  const grouped = [];
  for (const row of rows) {
    const last = grouped.at(-1);
    if (last && last.maxScore === row.score) {
      last.weight += row.weight;
      last.positiveWeight += row.label * row.weight;
      last.probability = last.positiveWeight / last.weight;
    } else {
      grouped.push({
        minScore: row.score,
        maxScore: row.score,
        weight: row.weight,
        positiveWeight: row.label * row.weight,
        probability: row.label,
      });
    }
  }

  const blocks = [];
  for (const group of grouped) {
    blocks.push({ ...group });
    while (blocks.length >= 2 && blocks.at(-2).probability > blocks.at(-1).probability) {
      const right = blocks.pop();
      const left = blocks.pop();
      const weight = left.weight + right.weight;
      const positiveWeight = left.positiveWeight + right.positiveWeight;
      blocks.push({
        minScore: left.minScore,
        maxScore: right.maxScore,
        weight,
        positiveWeight,
        probability: positiveWeight / weight,
      });
    }
  }

  return {
    schemaVersion: "config-inference-calibrator-v1",
    method: "isotonic",
    status: "fitted",
    sampleCount: rows.length,
    scoreRange: [rows[0].score, rows.at(-1).score],
    points: blocks.map((block) => ({
      minScore: block.minScore,
      maxScore: block.maxScore,
      probability: Number(clamp(block.probability).toFixed(8)),
      sampleWeight: Number(block.weight.toFixed(6)),
    })),
  };
}

export function calibrateConfigInferenceScore(calibrator, score) {
  const points = Array.isArray(calibrator?.points) ? calibrator.points : [];
  const raw = Number(score);
  if (calibrator?.status !== "fitted" || !points.length || !Number.isFinite(raw)) return null;
  if (raw <= points[0].maxScore) return clamp(points[0].probability);
  if (raw >= points.at(-1).minScore) return clamp(points.at(-1).probability);
  for (let index = 0; index < points.length - 1; index++) {
    const left = points[index];
    const right = points[index + 1];
    if (raw <= left.maxScore) return clamp(left.probability);
    if (raw >= right.minScore) continue;
    const width = Math.max(Number.EPSILON, right.minScore - left.maxScore);
    const ratio = clamp((raw - left.maxScore) / width);
    return clamp(left.probability + (right.probability - left.probability) * ratio);
  }
  return clamp(points.at(-1).probability);
}

/**
 * Centralized abstention/auto-apply policy. The current product can keep requiresHumanConfirmation
 * true while still reporting exactly which gates prevent future safe automation.
 */
export function evaluateConfigInferencePolicy({
  targets = [],
  calibratedProbability = null,
  heuristicConfidence = 0,
  margin = 0,
  sourceCoverage = {},
  requiredSources = [],
  conflictCount = 0,
  outOfDistribution = false,
  registryValid = true,
  remoteRefsValid = false,
  hasSymbolic = false,
  localBindingComplete = false,
  humanConfirmationRequired = true,
  probabilityThreshold = 0.995,
  marginThreshold = 0.15,
} = {}) {
  const missingSources = sourceIncomplete(sourceCoverage, requiredSources);
  const probability = calibratedProbability == null ? null : clamp(calibratedProbability);
  const reasons = [
    ...(!Array.isArray(targets) || targets.length === 0 ? ["no_targets"] : []),
    ...(missingSources.length ? ["required_source_incomplete"] : []),
    ...(finite(conflictCount) > 0 ? ["conflicting_evidence"] : []),
    ...(outOfDistribution ? ["out_of_distribution"] : []),
    ...(!registryValid ? ["registry_invalid"] : []),
    ...(!remoteRefsValid ? ["remote_ref_unverified"] : []),
    ...(hasSymbolic ? ["symbolic_value_unresolved"] : []),
    ...(!localBindingComplete ? ["local_binding_incomplete"] : []),
    ...(probability == null ? ["probability_uncalibrated"] : []),
    ...(probability != null && probability < probabilityThreshold ? ["probability_below_threshold"] : []),
    ...(clamp(margin) < marginThreshold ? ["margin_below_threshold"] : []),
    ...(humanConfirmationRequired ? ["human_confirmation_required"] : []),
  ];
  return {
    canAutoApply: reasons.length === 0,
    abstain: reasons.some((reason) => [
      "no_targets",
      "required_source_incomplete",
      "conflicting_evidence",
      "out_of_distribution",
      "registry_invalid",
      "symbolic_value_unresolved",
      "margin_below_threshold",
    ].includes(reason)),
    reasons: [...new Set(reasons)],
    missingSources,
    calibratedProbability: probability,
    heuristicConfidence: clamp(heuristicConfidence),
    margin: clamp(margin),
    thresholds: {
      probability: probabilityThreshold,
      margin: marginThreshold,
    },
  };
}
