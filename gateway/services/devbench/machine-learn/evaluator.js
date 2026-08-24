import { createHash } from "node:crypto";

const TARGET_FIELDS = ["appName", "vehicle", "repositoryId", "branch", "flavor"];
const VALID_SPLITS = new Set(["train", "dev", "test", "shadow"]);
const ABSTAIN_STATUSES = new Set(["NEED_MORE_INFO", "ABSTAIN", "INSUFFICIENT"]);
const NEGATIVE_DECISIONS = new Set(["insufficient", "ticket_wrong", "not_applicable", "no_target"]);
const APPROVED_LABEL_STATUSES = new Set(["approved", "active", "verified"]);

function text(value, limit = 10_000) {
  return String(value ?? "").trim().slice(0, limit);
}

function finite(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function clamp(value, min = 0, max = 1) {
  return Math.min(max, Math.max(min, finite(value)));
}

function unique(values = []) {
  return [...new Set(values.map((value) => text(value)).filter(Boolean))];
}

function targetRole(value, index) {
  const role = text(value).toLowerCase();
  if (["primary", "dependency", "standalone"].includes(role)) return role;
  return index === 0 ? "primary" : "dependency";
}

function targetOrder(target, index) {
  const order = Math.trunc(finite(target?.order, index + 1));
  return order > 0 ? order : index + 1;
}

/**
 * Convert a prediction/label target graph to a deterministic business representation.
 * targetId is retained when supplied because swapping stable graph identities must be visible.
 */
export function normalizeEvaluationTargetGraph(targets = []) {
  const rows = Array.isArray(targets) ? targets : [];
  return rows.map((target, index) => ({
    targetId: text(target?.targetId),
    targetRole: targetRole(target?.targetRole, index),
    order: targetOrder(target, index),
    appName: text(target?.appName),
    vehicle: text(target?.vehicle),
    repositoryId: text(target?.repositoryId || target?.repoId),
    branch: text(target?.branch),
    flavor: text(target?.flavor),
  })).sort((left, right) => (
    left.order - right.order
    || left.targetRole.localeCompare(right.targetRole)
    || left.repositoryId.localeCompare(right.repositoryId)
    || left.branch.localeCompare(right.branch)
  ));
}

export function evaluationTargetGraphKey(targets = []) {
  return JSON.stringify(normalizeEvaluationTargetGraph(targets));
}

function labelFromCase(row = {}) {
  const source = row.approvedLabel || row.label || row.groundTruth || {};
  const decision = text(source.decision || source.feedback?.decision).toLowerCase();
  const targets = normalizeEvaluationTargetGraph(
    source.targets
    || source.correctedPrediction?.targets
    || source.actual?.targets
    || [],
  );
  const noTargets = source.noTargets === true
    || source.correctedPrediction?.noTargets === true
    || NEGATIVE_DECISIONS.has(decision);
  return {
    decision,
    status: text(source.status || row.labelStatus).toLowerCase(),
    targets: noTargets ? [] : targets,
    noTargets,
  };
}

function predictionFromCase(row = {}) {
  const source = row.prediction || row.inference || {};
  const targets = normalizeEvaluationTargetGraph(source.targets || []);
  // Candidate order is the rank itself; graph normalization must not sort it.
  const candidateSource = source.candidates || source.rankedTargets || source.targets || [];
  const candidates = (Array.isArray(candidateSource) ? candidateSource : [])
    .flatMap((target) => normalizeEvaluationTargetGraph([target]));
  const status = text(source.status).toUpperCase();
  const abstained = ABSTAIN_STATUSES.has(status) || targets.length === 0;
  return {
    status,
    targets,
    candidates,
    abstained,
    confidence: clamp(source.calibratedProbability ?? source.confidenceScore ?? source.confidence),
  };
}

function primaryRepository(targets = []) {
  return targets.find((target) => target.targetRole === "primary")?.repositoryId
    || targets.find((target) => target.targetRole === "standalone")?.repositoryId
    || targets[0]?.repositoryId
    || "";
}

function graphExact(prediction, label) {
  return evaluationTargetGraphKey(prediction.targets) === evaluationTargetGraphKey(label.targets);
}

function fieldComparisons(predictedTargets, expectedTargets) {
  const result = Object.fromEntries(TARGET_FIELDS.map((field) => [field, { correct: 0, total: 0 }]));
  const length = Math.max(predictedTargets.length, expectedTargets.length);
  for (let index = 0; index < length; index++) {
    const predicted = predictedTargets[index] || {};
    const expected = expectedTargets[index] || {};
    for (const field of TARGET_FIELDS) {
      if (!text(expected[field]) && !text(predicted[field])) continue;
      result[field].total++;
      if (text(predicted[field]) === text(expected[field])) result[field].correct++;
    }
  }
  return result;
}

function dependencyStats(predictedTargets, expectedTargets) {
  const signature = (target) => [
    target.repositoryId,
    target.branch,
    target.flavor,
    target.targetRole,
  ].map(text).join("\u0000");
  const predicted = new Set(predictedTargets
    .filter((target) => target.targetRole === "dependency")
    .map(signature));
  const expected = new Set(expectedTargets
    .filter((target) => target.targetRole === "dependency")
    .map(signature));
  let truePositive = 0;
  for (const key of predicted) if (expected.has(key)) truePositive++;
  return {
    truePositive,
    predicted: predicted.size,
    expected: expected.size,
  };
}

function reliabilityBins(rows, binCount = 10) {
  const count = Math.max(2, Math.min(50, Math.trunc(finite(binCount, 10))));
  const bins = Array.from({ length: count }, (_, index) => ({
    from: index / count,
    to: (index + 1) / count,
    count: 0,
    confidenceSum: 0,
    correct: 0,
  }));
  for (const row of rows) {
    const confidence = clamp(row.confidence);
    const index = Math.min(count - 1, Math.floor(confidence * count));
    bins[index].count++;
    bins[index].confidenceSum += confidence;
    if (row.correct) bins[index].correct++;
  }
  return bins.map((bin) => ({
    from: bin.from,
    to: bin.to,
    count: bin.count,
    averageConfidence: bin.count ? bin.confidenceSum / bin.count : null,
    accuracy: bin.count ? bin.correct / bin.count : null,
  }));
}

function divide(numerator, denominator) {
  return denominator ? numerator / denominator : null;
}

function rounded(value, digits = 6) {
  return value == null || !Number.isFinite(value) ? null : Number(value.toFixed(digits));
}

function aggregateEvaluatedRows(rows, { binCount = 10 } = {}) {
  const eligible = rows.length;
  const coveredRows = rows.filter((row) => !row.prediction.abstained);
  const positiveRows = rows.filter((row) => !row.label.noTargets);
  const negativeRows = rows.filter((row) => row.label.noTargets);
  const exact = rows.filter((row) => row.exact).length;
  const coveredExact = coveredRows.filter((row) => row.exact).length;
  const top1 = positiveRows.filter((row) => row.repositoryTop1).length;
  const top3 = positiveRows.filter((row) => row.repositoryTop3).length;
  const correctAbstentions = negativeRows.filter((row) => row.prediction.abstained).length;
  const wrongAbstentions = positiveRows.filter((row) => row.prediction.abstained).length;
  const field = Object.fromEntries(TARGET_FIELDS.map((name) => [name, { correct: 0, total: 0 }]));
  const dependencies = { truePositive: 0, predicted: 0, expected: 0 };

  for (const row of rows) {
    for (const name of TARGET_FIELDS) {
      field[name].correct += row.fields[name].correct;
      field[name].total += row.fields[name].total;
    }
    dependencies.truePositive += row.dependencies.truePositive;
    dependencies.predicted += row.dependencies.predicted;
    dependencies.expected += row.dependencies.expected;
  }

  const probabilityRows = rows.map((row) => ({
    confidence: row.prediction.confidence,
    correct: row.exact,
  }));
  const brier = divide(
    probabilityRows.reduce((sum, row) => sum + ((row.confidence - (row.correct ? 1 : 0)) ** 2), 0),
    probabilityRows.length,
  );
  const bins = reliabilityBins(probabilityRows, binCount);
  const ece = bins.reduce((sum, bin) => (
    sum + (bin.count && bin.accuracy != null && bin.averageConfidence != null
      ? (bin.count / Math.max(1, probabilityRows.length)) * Math.abs(bin.accuracy - bin.averageConfidence)
      : 0)
  ), 0);

  return {
    eligible,
    positive: positiveRows.length,
    negative: negativeRows.length,
    coverage: rounded(divide(coveredRows.length, eligible)),
    abstained: eligible - coveredRows.length,
    correctAbstentions,
    wrongAbstentions,
    insufficientRecall: rounded(divide(correctAbstentions, negativeRows.length)),
    exactMatch: rounded(divide(exact, eligible)),
    coveredExactMatch: rounded(divide(coveredExact, coveredRows.length)),
    selectiveRisk: rounded(coveredRows.length ? 1 - (coveredExact / coveredRows.length) : null),
    repositoryTop1Accuracy: rounded(divide(top1, positiveRows.length)),
    repositoryTop3Recall: rounded(divide(top3, positiveRows.length)),
    fieldAccuracy: Object.fromEntries(TARGET_FIELDS.map((name) => [
      name,
      rounded(divide(field[name].correct, field[name].total)),
    ])),
    fieldCounts: field,
    dependencyPrecision: rounded(divide(dependencies.truePositive, dependencies.predicted)),
    dependencyRecall: rounded(divide(dependencies.truePositive, dependencies.expected)),
    brierScore: rounded(brier),
    expectedCalibrationError: rounded(ece),
    reliabilityBins: bins.map((bin) => ({
      ...bin,
      averageConfidence: rounded(bin.averageConfidence),
      accuracy: rounded(bin.accuracy),
    })),
  };
}

function seededRandom(seedValue) {
  const digest = createHash("sha256").update(String(seedValue || "config-inference")).digest();
  let state = digest.readUInt32LE(0) || 0x6d2b79f5;
  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function percentile(values, probability) {
  const rows = values.filter(Number.isFinite).sort((left, right) => left - right);
  if (rows.length === 0) return null;
  const index = (rows.length - 1) * clamp(probability);
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return rows[lower];
  return rows[lower] + (rows[upper] - rows[lower]) * (index - lower);
}

/**
 * Deterministic non-parametric bootstrap. The interval quantifies finite Golden Set uncertainty;
 * it is not a replacement for time-split leakage checks.
 */
export function bootstrapConfigInferenceMetrics(cases = [], {
  iterations = 500,
  confidenceLevel = 0.95,
  seed = "config-inference-evaluation-v1",
  binCount = 10,
} = {}) {
  const rows = cases.length > 0 && cases[0]?.prediction && cases[0]?.label
    ? cases
    : evaluateRows(Array.isArray(cases) ? cases : []);
  const count = Math.max(0, Math.min(10_000, Math.trunc(finite(iterations, 500))));
  if (rows.length === 0 || count === 0) return {};
  const random = seededRandom(seed);
  const keys = [
    "exactMatch",
    "repositoryTop1Accuracy",
    "repositoryTop3Recall",
    "coverage",
    "selectiveRisk",
    "expectedCalibrationError",
  ];
  const samples = Object.fromEntries(keys.map((key) => [key, []]));
  for (let iteration = 0; iteration < count; iteration += 1) {
    const resampled = Array.from({ length: rows.length }, () => (
      rows[Math.floor(random() * rows.length)]
    ));
    const metrics = aggregateEvaluatedRows(resampled, { binCount });
    keys.forEach((key) => {
      if (Number.isFinite(metrics[key])) samples[key].push(metrics[key]);
    });
  }
  const alpha = (1 - clamp(confidenceLevel, 0.5, 0.999)) / 2;
  return Object.fromEntries(keys.map((key) => [
    key,
    {
      lower: rounded(percentile(samples[key], alpha)),
      upper: rounded(percentile(samples[key], 1 - alpha)),
      confidenceLevel: rounded(1 - 2 * alpha),
      samples: samples[key].length,
    },
  ]));
}

function caseSliceValues(row = {}) {
  const source = row.slice && typeof row.slice === "object" ? row.slice : {};
  const label = labelFromCase(row);
  const primary = label.targets.find((target) => target.targetRole === "primary")
    || label.targets[0]
    || {};
  const coverage = row.sourceCoverage && typeof row.sourceCoverage === "object"
    ? row.sourceCoverage
    : {};
  const incompleteSources = Object.entries(coverage)
    .filter(([, value]) => value?.available === false || value?.complete === false)
    .map(([key]) => key);
  return {
    project: text(source.project || row.projectId),
    vehicle: text(source.vehicle || primary.vehicle) || "(empty)",
    application: text(source.application || primary.appName) || "(empty)",
    repository: text(source.repository || primary.repositoryId) || "(empty)",
    sourceCompleteness: text(source.sourceCompleteness)
      || (incompleteSources.length ? "partial" : "complete"),
  };
}

function evaluateRows(cases = []) {
  return cases.map((row) => {
    const label = labelFromCase(row);
    const prediction = predictionFromCase(row);
    const expectedRepository = primaryRepository(label.targets);
    const candidateRepositories = unique(prediction.candidates.map((target) => target.repositoryId));
    const exact = graphExact(prediction, label);
    return {
      id: text(row.id || row.caseId || row.ticketId),
      split: text(row.split).toLowerCase(),
      label,
      prediction,
      exact,
      repositoryTop1: !!expectedRepository && candidateRepositories[0] === expectedRepository,
      repositoryTop3: !!expectedRepository && candidateRepositories.slice(0, 3).includes(expectedRepository),
      fields: fieldComparisons(prediction.targets, label.targets),
      dependencies: dependencyStats(prediction.targets, label.targets),
      slices: caseSliceValues(row),
    };
  });
}

/**
 * Evaluate a frozen dataset or one of its splits without mutating serving state.
 */
export function evaluateConfigInferenceDataset(dataset = {}, options = {}) {
  const cases = Array.isArray(dataset) ? dataset : Array.isArray(dataset.cases) ? dataset.cases : [];
  const requestedSplit = text(options.split).toLowerCase();
  const filtered = requestedSplit
    ? cases.filter((row) => text(row.split).toLowerCase() === requestedSplit)
    : cases;
  const rows = evaluateRows(filtered);
  const metrics = aggregateEvaluatedRows(rows, options);
  const bootstrapIterations = options.bootstrapIterations === undefined
    ? 500
    : Math.max(0, Math.trunc(finite(options.bootstrapIterations)));
  metrics.confidenceIntervals = bootstrapConfigInferenceMetrics(rows, {
    iterations: bootstrapIterations,
    confidenceLevel: options.confidenceLevel,
    seed: options.bootstrapSeed || `${text(dataset.datasetVersion || dataset.version)}:${requestedSplit || "all"}`,
    binCount: options.binCount,
  });
  const slices = {};
  for (const dimension of ["project", "vehicle", "application", "repository", "sourceCompleteness"]) {
    const values = unique(rows.map((row) => row.slices[dimension]));
    slices[dimension] = Object.fromEntries(values.map((value) => [
      value,
      aggregateEvaluatedRows(rows.filter((row) => row.slices[dimension] === value), options),
    ]));
  }
  return {
    schemaVersion: "config-inference-evaluation-v1",
    datasetVersion: text(dataset.datasetVersion || dataset.version),
    evaluatedAt: new Date().toISOString(),
    split: requestedSplit || "all",
    metrics,
    slices,
    cases: rows.map((row) => ({
      id: row.id,
      split: row.split,
      exact: row.exact,
      abstained: row.prediction.abstained,
      confidence: row.prediction.confidence,
      repositoryTop1: row.repositoryTop1,
      repositoryTop3: row.repositoryTop3,
      expectedGraph: row.label.targets,
      predictedGraph: row.prediction.targets,
    })),
  };
}

function metricDelta(candidate, baseline) {
  const left = Number(candidate);
  const right = Number(baseline);
  return Number.isFinite(left) && Number.isFinite(right) ? rounded(left - right) : null;
}

/**
 * Produce an auditable per-case and aggregate diff between two frozen evaluation reports.
 */
export function compareConfigInferenceEvaluationReports(baseline = {}, candidate = {}) {
  const baselineCases = new Map((baseline.cases || []).map((row) => [text(row.id), row]));
  const candidateCases = new Map((candidate.cases || []).map((row) => [text(row.id), row]));
  const ids = unique([...baselineCases.keys(), ...candidateCases.keys()]).sort();
  const cases = ids.map((id) => {
    const before = baselineCases.get(id);
    const after = candidateCases.get(id);
    let change = "unchanged";
    if (!before) change = "added";
    else if (!after) change = "removed";
    else if (!before.exact && after.exact) change = "improved";
    else if (before.exact && !after.exact) change = "regressed";
    else if (before.abstained !== after.abstained) change = after.abstained
      ? "new_abstention"
      : "new_coverage";
    return {
      id,
      change,
      baselineExact: before?.exact ?? null,
      candidateExact: after?.exact ?? null,
      baselineAbstained: before?.abstained ?? null,
      candidateAbstained: after?.abstained ?? null,
      confidenceDelta: metricDelta(after?.confidence, before?.confidence),
      baselineGraph: before?.predictedGraph || null,
      candidateGraph: after?.predictedGraph || null,
    };
  });
  const keys = [
    "exactMatch",
    "repositoryTop1Accuracy",
    "repositoryTop3Recall",
    "coverage",
    "selectiveRisk",
    "expectedCalibrationError",
  ];
  return {
    baselineDatasetVersion: text(baseline.datasetVersion),
    candidateDatasetVersion: text(candidate.datasetVersion),
    aggregateDelta: Object.fromEntries(keys.map((key) => [
      key,
      metricDelta(candidate?.metrics?.[key], baseline?.metrics?.[key]),
    ])),
    counts: {
      compared: cases.filter((row) => !["added", "removed"].includes(row.change)).length,
      improved: cases.filter((row) => row.change === "improved").length,
      regressed: cases.filter((row) => row.change === "regressed").length,
      added: cases.filter((row) => row.change === "added").length,
      removed: cases.filter((row) => row.change === "removed").length,
    },
    cases,
  };
}

function timestamp(value) {
  const time = Date.parse(String(value || ""));
  return Number.isFinite(time) ? time : null;
}

/**
 * Validate approval, time-cutoff and split isolation before a dataset is accepted as Golden Set.
 */
export function validateConfigInferenceDataset(dataset = {}) {
  const cases = Array.isArray(dataset) ? dataset : Array.isArray(dataset.cases) ? dataset.cases : [];
  const errors = [];
  const warnings = [];
  const ids = new Set();
  const groupSplits = new Map();
  const datasetRequiredSources = unique(
    Array.isArray(dataset.requiredSources) && dataset.requiredSources.length
      ? dataset.requiredSources
      : ["detail"],
  );
  const candidateReplay = text(dataset.evaluationMode).toLowerCase() === "candidate_replay_v1";
  if (candidateReplay && (!dataset.candidateSnapshot || typeof dataset.candidateSnapshot !== "object")) {
    errors.push({ code: "CANDIDATE_SNAPSHOT_REQUIRED" });
  }

  for (const [index, row] of cases.entries()) {
    const id = text(row.id || row.caseId || row.ticketId);
    const label = labelFromCase(row);
    const split = text(row.split).toLowerCase();
    const inferenceAt = timestamp(row.inferenceAt || row.snapshotAt);
    if (!id) errors.push({ code: "CASE_ID_REQUIRED", index });
    else if (ids.has(id)) errors.push({ code: "DUPLICATE_CASE_ID", id });
    else ids.add(id);
    if (!VALID_SPLITS.has(split)) errors.push({ code: "INVALID_SPLIT", id, split });
    if (!APPROVED_LABEL_STATUSES.has(label.status)) {
      errors.push({ code: "LABEL_NOT_APPROVED", id, status: label.status });
    }
    if (!inferenceAt) errors.push({ code: "INFERENCE_TIME_REQUIRED", id });
    if (candidateReplay && (!row.ticket || typeof row.ticket !== "object")) {
      errors.push({ code: "FROZEN_TICKET_REQUIRED", id });
    }
    if (candidateReplay && (row.prediction || row.inference)) {
      errors.push({ code: "SOURCE_PREDICTION_FORBIDDEN", id });
    }

    const coverage = row.sourceCoverage && typeof row.sourceCoverage === "object"
      ? row.sourceCoverage
      : {};
    for (const source of unique([...(row.requiredSources || []), ...datasetRequiredSources])) {
      const state = coverage[source];
      if (!state || state.available !== true || state.complete !== true) {
        errors.push({
          code: "REQUIRED_SOURCE_INCOMPLETE",
          id,
          source,
          state: state || null,
        });
      }
      const hasSourceEvidence = (Array.isArray(row.evidence) ? row.evidence : [])
        .some((item) => text(item?.sourceType).toLowerCase() === source.toLowerCase());
      if (!hasSourceEvidence) {
        errors.push({
          code: "REQUIRED_SOURCE_EVIDENCE_MISSING",
          id,
          source,
        });
      }
    }

    const groupId = text(row.groupId || row.incidentId || row.nearDuplicateGroup || id);
    if (groupId && split) {
      const known = groupSplits.get(groupId);
      if (known && known !== split) {
        errors.push({ code: "GROUP_SPLIT_LEAKAGE", id, groupId, splits: unique([known, split]) });
      } else {
        groupSplits.set(groupId, split);
      }
    }

    const evidence = Array.isArray(row.evidence) ? row.evidence : [];
    for (const [evidenceIndex, item] of evidence.entries()) {
      const availableAt = timestamp(item?.availableAt);
      if (!availableAt) {
        errors.push({ code: "EVIDENCE_TIME_MISSING", id, evidenceIndex });
      } else if (inferenceAt && availableAt > inferenceAt) {
        errors.push({
          code: "FUTURE_EVIDENCE_LEAKAGE",
          id,
          evidenceIndex,
          availableAt: item.availableAt,
          inferenceAt: row.inferenceAt || row.snapshotAt,
        });
      }
    }
  }

  const splitCounts = Object.fromEntries([...VALID_SPLITS].map((split) => [
    split,
    cases.filter((row) => text(row.split).toLowerCase() === split).length,
  ]));
  if (!splitCounts.test) warnings.push({ code: "TEST_SPLIT_EMPTY" });
  if (!splitCounts.dev) warnings.push({ code: "DEV_SPLIT_EMPTY" });

  return {
    ok: errors.length === 0,
    caseCount: cases.length,
    splitCounts,
    requiredSources: datasetRequiredSources,
    errors,
    warnings,
  };
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
  }
  return value;
}

function cloneValue(value) {
  if (Array.isArray(value)) return value.map(cloneValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, cloneValue(child)]));
  }
  return value;
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.values(value).forEach(deepFreeze);
  return Object.freeze(value);
}

export function configInferenceDatasetHash(dataset = {}) {
  const payload = {
    schemaVersion: text(dataset.schemaVersion || "config-inference-dataset-v1"),
    datasetVersion: text(dataset.datasetVersion || dataset.version),
    registryRevision: text(dataset.registryRevision),
    keywordRevision: text(dataset.keywordRevision),
    servingSampleRevision: text(dataset.servingSampleRevision),
    rulesVersion: text(dataset.rulesVersion),
    featureSchemaVersion: text(dataset.featureSchemaVersion),
    retrievalSnapshotId: text(dataset.retrievalSnapshotId),
    knowledgeValueSetRevision: text(dataset.knowledgeValueSetRevision),
    evaluationMode: text(dataset.evaluationMode),
    candidateSnapshot: dataset.candidateSnapshot && typeof dataset.candidateSnapshot === "object"
      ? dataset.candidateSnapshot
      : null,
    requiredSources: unique(dataset.requiredSources || []).sort(),
    cases: Array.isArray(dataset.cases) ? dataset.cases : [],
  };
  return createHash("sha256").update(JSON.stringify(stableValue(payload))).digest("hex");
}

export function createConfigInferenceDatasetVersion(input = {}) {
  const cases = cloneValue(Array.isArray(input.cases) ? input.cases : []);
  const dataset = {
    schemaVersion: "config-inference-dataset-v1",
    datasetVersion: text(input.datasetVersion || input.version)
      || `ds_${new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}`,
    createdAt: text(input.createdAt) || new Date().toISOString(),
    registryRevision: text(input.registryRevision),
    keywordRevision: text(input.keywordRevision),
    servingSampleRevision: text(input.servingSampleRevision),
    rulesVersion: text(input.rulesVersion),
    featureSchemaVersion: text(input.featureSchemaVersion),
    retrievalSnapshotId: text(input.retrievalSnapshotId),
    knowledgeValueSetRevision: text(input.knowledgeValueSetRevision),
    evaluationMode: text(input.evaluationMode),
    candidateSnapshot: input.candidateSnapshot && typeof input.candidateSnapshot === "object"
      ? cloneValue(input.candidateSnapshot)
      : null,
    requiredSources: unique(
      Array.isArray(input.requiredSources) && input.requiredSources.length
        ? input.requiredSources
        : ["detail"],
    ),
    cases,
  };
  return deepFreeze({
    ...dataset,
    hash: configInferenceDatasetHash(dataset),
    validation: validateConfigInferenceDataset(dataset),
  });
}

/**
 * Deterministic chronological split that keeps the same incident/near-duplicate group together.
 * The newest groups become test data, matching the real "predict future tickets" objective.
 */
export function splitConfigInferenceCasesByTime(cases = [], {
  train = 0.7,
  dev = 0.15,
  test = 0.15,
} = {}) {
  const rows = Array.isArray(cases) ? cases : [];
  const totalRatio = Math.max(0.0001, finite(train) + finite(dev) + finite(test));
  const trainRatio = Math.max(0, finite(train)) / totalRatio;
  const devRatio = Math.max(0, finite(dev)) / totalRatio;
  const groups = new Map();
  for (const [index, row] of rows.entries()) {
    const id = text(row.id || row.caseId || row.ticketId) || `case_${index + 1}`;
    const groupId = text(row.groupId || row.incidentId || row.nearDuplicateGroup || id);
    if (!groups.has(groupId)) groups.set(groupId, []);
    groups.get(groupId).push({ ...row, id });
  }
  const ordered = [...groups.entries()].map(([groupId, groupRows]) => ({
    groupId,
    rows: groupRows,
    time: Math.max(...groupRows.map((row) => timestamp(row.inferenceAt || row.snapshotAt) || 0)),
  })).sort((left, right) => left.time - right.time || left.groupId.localeCompare(right.groupId));

  const trainLimit = rows.length * trainRatio;
  const devLimit = rows.length * (trainRatio + devRatio);
  let assigned = 0;
  const result = [];
  for (const group of ordered) {
    const midpoint = assigned + (group.rows.length / 2);
    const split = midpoint <= trainLimit
      ? "train"
      : midpoint <= devLimit
        ? "dev"
        : "test";
    result.push(...group.rows.map((row) => ({ ...row, groupId: group.groupId, split })));
    assigned += group.rows.length;
  }
  return result;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function percent(value) {
  return value == null ? "—" : `${(value * 100).toFixed(2)}%`;
}

export function renderConfigInferenceEvaluationHtml(report = {}, validation = null) {
  const metrics = report.metrics || {};
  const cards = [
    ["完整目标图", percent(metrics.exactMatch)],
    ["Repository Top-1", percent(metrics.repositoryTop1Accuracy)],
    ["Repository Top-3", percent(metrics.repositoryTop3Recall)],
    ["Coverage", percent(metrics.coverage)],
    ["Selective risk", percent(metrics.selectiveRisk)],
    ["ECE", metrics.expectedCalibrationError == null ? "—" : metrics.expectedCalibrationError.toFixed(4)],
  ];
  const cases = Array.isArray(report.cases) ? report.cases : [];
  const validationRows = [
    ...(validation?.errors || []).map((row) => ({ level: "ERROR", ...row })),
    ...(validation?.warnings || []).map((row) => ({ level: "WARN", ...row })),
  ];
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>配置推理评测 ${escapeHtml(report.datasetVersion || "")}</title>
  <style>
    body{margin:0;background:#09090b;color:#e4e4e7;font:14px/1.5 system-ui,sans-serif}main{max-width:1200px;margin:auto;padding:24px}
    h1,h2{margin:0 0 16px}.meta{color:#71717a;margin-bottom:20px}.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:10px}
    .card,table{border:1px solid #27272a;background:#18181b}.card{border-radius:8px;padding:12px}.card b{display:block;font-size:20px;color:#67e8f9}
    table{width:100%;border-collapse:collapse;margin-top:12px}th,td{border-bottom:1px solid #27272a;padding:8px;text-align:left}th{color:#a1a1aa}
    .ok{color:#86efac}.bad{color:#fda4af}.warn{color:#fde047}code{color:#c4b5fd}
  </style>
</head>
<body><main>
  <h1>故事点配置推理离线评测</h1>
  <div class="meta">Dataset <code>${escapeHtml(report.datasetVersion || "unknown")}</code> · split ${escapeHtml(report.split || "all")} · ${escapeHtml(report.evaluatedAt || "")}</div>
  <section class="cards">${cards.map(([label, value]) => `<div class="card"><span>${escapeHtml(label)}</span><b>${escapeHtml(value)}</b></div>`).join("")}</section>
  <h2>逐案例结果</h2>
  <table><thead><tr><th>ID</th><th>Split</th><th>完整图</th><th>拒答</th><th>置信度</th><th>Top-1</th><th>Top-3</th></tr></thead>
  <tbody>${cases.map((row) => `<tr><td>${escapeHtml(row.id)}</td><td>${escapeHtml(row.split)}</td><td class="${row.exact ? "ok" : "bad"}">${row.exact ? "PASS" : "FAIL"}</td><td>${row.abstained ? "是" : "否"}</td><td>${percent(row.confidence)}</td><td>${row.repositoryTop1 ? "PASS" : "FAIL"}</td><td>${row.repositoryTop3 ? "PASS" : "FAIL"}</td></tr>`).join("")}</tbody></table>
  <h2>数据集校验</h2>
  <table><thead><tr><th>级别</th><th>代码</th><th>案例</th><th>详情</th></tr></thead>
  <tbody>${validationRows.length ? validationRows.map((row) => `<tr><td class="${row.level === "ERROR" ? "bad" : "warn"}">${row.level}</td><td>${escapeHtml(row.code)}</td><td>${escapeHtml(row.id || row.index)}</td><td><code>${escapeHtml(JSON.stringify(row))}</code></td></tr>`).join("") : `<tr><td class="ok" colspan="4">没有发现时间泄漏、跨 split 重复或未批准标签</td></tr>`}</tbody></table>
</main></body></html>`;
}
