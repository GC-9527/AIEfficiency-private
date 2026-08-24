import { createHash } from "node:crypto";
import {
  calibrateConfigInferenceScore,
  fitIsotonicCalibrator,
} from "./calibration.js";
import {
  createConfigInferenceArtifact,
  createConfigInferenceRelease,
  evaluateConfigInferenceReleaseGate,
} from "./release-governance.js";
import {
  evaluateConfigInferenceDataset,
  validateConfigInferenceDataset,
} from "./evaluator.js";

const SUPPORTED_SERVING_RANKERS = new Set([
  "heuristic",
  "config-inference-heuristic",
]);

function text(value, limit = 1000) {
  return String(value ?? "").trim().slice(0, limit);
}

function finiteOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function cloneValue(value) {
  if (Array.isArray(value)) return value.map(cloneValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, cloneValue(child)]));
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.values(value).forEach(deepFreeze);
  return Object.freeze(value);
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
}

function fingerprint(value) {
  return createHash("sha256").update(JSON.stringify(stableValue(value))).digest("hex");
}

function releaseMetricFingerprintPayload(metrics = {}) {
  const keys = [
    "eligible",
    "positive",
    "negative",
    "coverage",
    "abstained",
    "correctAbstentions",
    "wrongAbstentions",
    "insufficientRecall",
    "exactMatch",
    "coveredExactMatch",
    "selectiveRisk",
    "repositoryTop1Accuracy",
    "repositoryTop3Recall",
    "fieldAccuracy",
    "fieldCounts",
    "dependencyPrecision",
    "dependencyRecall",
    "brierScore",
    "expectedCalibrationError",
    "reliabilityBins",
    "evaluationSplit",
    "calibratorStatus",
    "registryViolations",
    "requiredSourceAutoRuns",
  ];
  return Object.fromEntries(keys.map((key) => [key, cloneValue(metrics?.[key] ?? null)]));
}

function caseId(row = {}, index = 0) {
  return text(row.id || row.caseId || row.ticketId || `case_${index + 1}`, 300);
}

function rawInferenceScore(row = {}) {
  const prediction = row.prediction || row.inference || {};
  return finiteOrNull(
    prediction?.confidenceMetadata?.rawTopScore
    ?? prediction?.quality?.margin?.topScore
    ?? prediction?.rawScore
    ?? prediction?.confidenceScore
    ?? prediction?.confidence,
  );
}

function calibratedDataset(dataset = {}, calibrator = null) {
  const copy = cloneValue(dataset);
  copy.cases = (Array.isArray(copy.cases) ? copy.cases : []).map((row) => {
    const score = rawInferenceScore(row);
    const calibratedProbability = calibrateConfigInferenceScore(calibrator, score);
    const prediction = cloneValue(row.prediction || row.inference || {});
    if (calibratedProbability != null) prediction.calibratedProbability = calibratedProbability;
    return {
      ...row,
      prediction,
    };
  });
  return copy;
}

function registryViolationCount(cases = []) {
  return cases.filter((row) => {
    const prediction = row?.prediction || row?.inference || {};
    return prediction?.policy?.registryValid !== true
      || prediction?.versions?.stale === true
      || row?.registryViolation === true;
  }).length;
}

function requiredSourceAutoRunCount(cases = [], requiredSources = []) {
  return cases.filter((row) => {
    const prediction = row?.prediction || row?.inference || {};
    const autoExecuted = row?.autoExecuted === true
      || prediction?.policy?.canAutoApply === true
      || prediction?.policy?.canExecute === true;
    if (!autoExecuted) return false;
    return requiredSources.some((source) => {
      const state = row?.sourceCoverage?.[source];
      return !state || state.available !== true || state.complete !== true;
    });
  }).length;
}

/**
 * Fit calibration only on the dev split, then evaluate a frozen test/shadow split.
 * The returned report embeds the calibrator and validation result used by release gates.
 */
export function prepareConfigInferenceReleaseEvaluation(dataset = {}, {
  split = "test",
  minCalibrationSamples = 20,
  bootstrapIterations = 500,
  confidenceLevel = 0.95,
  minShadowCases = 200,
} = {}) {
  const validation = validateConfigInferenceDataset(dataset);
  const devReport = evaluateConfigInferenceDataset(dataset, {
    split: "dev",
    bootstrapIterations: 0,
  });
  const devExact = new Map(devReport.cases.map((row) => [text(row.id, 300), row.exact === true]));
  const devCases = (Array.isArray(dataset?.cases) ? dataset.cases : [])
    .filter((row) => text(row?.split, 40).toLowerCase() === "dev");
  const calibrationSamples = devCases.flatMap((row, index) => {
    const score = rawInferenceScore(row);
    const id = caseId(row, index);
    if (score == null || !devExact.has(id)) return [];
    return [{
      id,
      score,
      label: devExact.get(id),
    }];
  });
  const calibrator = fitIsotonicCalibrator(calibrationSamples, {
    minSamples: Math.max(20, Number(minCalibrationSamples) || 20),
  });
  const frozenEvaluationDataset = calibratedDataset(dataset, calibrator);
  const evaluationSplit = text(split, 40).toLowerCase() || "test";
  const report = evaluateConfigInferenceDataset(frozenEvaluationDataset, {
    split: evaluationSplit,
    bootstrapIterations,
    confidenceLevel,
  });
  const evaluatedCases = (frozenEvaluationDataset.cases || [])
    .filter((row) => text(row?.split, 40).toLowerCase() === evaluationSplit);
  const requiredSources = Array.isArray(dataset?.requiredSources) && dataset.requiredSources.length
    ? [...new Set(dataset.requiredSources.map((source) => text(source, 80)).filter(Boolean))]
    : ["detail"];
  const metrics = {
    ...report.metrics,
    evaluationSplit,
    calibratorStatus: calibrator.status,
    registryViolations: registryViolationCount(evaluatedCases),
    requiredSourceAutoRuns: requiredSourceAutoRunCount(evaluatedCases, requiredSources),
  };
  const gate = evaluateConfigInferenceReleaseGate(metrics, validation, {
    evaluationSplit,
    calibratorStatus: calibrator.status,
    requiredSources,
    minShadowCases,
  });
  const result = {
    ...report,
    datasetHash: text(dataset?.hash, 128),
    metrics,
    calibrator: cloneValue(calibrator),
    validation: cloneValue(validation),
    gate: cloneValue(gate),
    calibration: {
      split: "dev",
      sampleCount: calibrationSamples.length,
      minSamples: Math.max(20, Number(minCalibrationSamples) || 20),
    },
    candidateReplay: cloneValue(dataset?.candidateReplay || null),
  };
  return deepFreeze({
    ...result,
    evaluationFingerprint: fingerprint({
      datasetHash: result.datasetHash,
      datasetVersion: result.datasetVersion,
      split: result.split,
      // Bootstrap confidence intervals are report evidence, not release-decision input.
      // Excluding them keeps a server-side zero-bootstrap recomputation byte-stable.
      metrics: releaseMetricFingerprintPayload(result.metrics),
      calibrator: result.calibrator,
      validation: result.validation,
      gate: result.gate,
      candidateReplay: result.candidateReplay,
    }),
  });
}

export function createConfigInferenceReleaseBundle({
  projectId = "",
  dataset = {},
  evaluation = {},
  evaluationDataset = null,
  ranker = null,
  operator = "",
  now = Date.now(),
  artifactIdFactory,
  releaseIdFactory,
} = {}) {
  const evaluationSplit = text(evaluation?.split, 40).toLowerCase();
  if (!["test", "shadow"].includes(evaluationSplit)) {
    throw new Error("serving release 只能引用 test 或 shadow 评估");
  }
  const requiresCandidateReplay = text(dataset?.evaluationMode, 80).toLowerCase() === "candidate_replay_v1";
  const recomputeDataset = evaluationDataset && typeof evaluationDataset === "object"
    ? evaluationDataset
    : dataset;
  if (requiresCandidateReplay && (
    text(recomputeDataset?.evaluationMode, 80).toLowerCase() !== "candidate_replay_result_v1"
    || text(recomputeDataset?.candidateReplay?.sourceDatasetHash, 128) !== text(dataset?.hash, 128)
    || recomputeDataset?.candidateReplay?.trainingSplitOnly !== true
  )) {
    const error = new Error("serving release 必须基于冻结 ticket 的候选版本隔离重推理");
    error.code = "CONFIG_INFERENCE_CANDIDATE_REPLAY_REQUIRED";
    throw error;
  }
  const recomputedEvaluation = prepareConfigInferenceReleaseEvaluation(recomputeDataset, {
    split: evaluationSplit,
    bootstrapIterations: 0,
  });
  if (
    text(evaluation?.datasetHash, 128) !== text(dataset?.hash, 128)
    || text(evaluation?.datasetVersion, 160) !== text(dataset?.datasetVersion, 160)
    || text(evaluation?.evaluationFingerprint, 128) !== recomputedEvaluation.evaluationFingerprint
  ) {
    const error = new Error("evaluation 与冻结 dataset 不同源，不能创建 serving release");
    error.code = "CONFIG_INFERENCE_EVALUATION_MISMATCH";
    throw error;
  }
  if (!recomputedEvaluation.validation.ok) {
    const error = new Error("Golden Set 校验未通过，不能创建 serving release");
    error.code = "CONFIG_INFERENCE_DATASET_INVALID";
    error.validation = recomputedEvaluation.validation;
    throw error;
  }
  if (!text(dataset?.hash, 128)) throw new Error("serving release 必须引用冻结 dataset hash");
  if (!text(dataset?.registryRevision, 160)) throw new Error("serving release 必须冻结 registry revision");
  if (!text(dataset?.rulesVersion, 160)) throw new Error("serving release 必须冻结 rules version");
  if (!text(dataset?.featureSchemaVersion, 160)) throw new Error("serving release 必须冻结 feature schema version");
  const selectedRanker = cloneValue(ranker || {
    method: "config-inference-heuristic",
    version: dataset.rulesVersion,
    servingAdapter: "config-inference-v4",
  });
  const rankerMethod = text(selectedRanker?.method || selectedRanker?.artifactType, 120).toLowerCase();
  if (!SUPPORTED_SERVING_RANKERS.has(rankerMethod)) {
    const error = new Error("该 ranker 尚无线上 serving adapter，不能创建可激活 release");
    error.code = "CONFIG_INFERENCE_RANKER_NOT_SERVABLE";
    throw error;
  }
  const artifact = createConfigInferenceArtifact({
    projectId,
    datasetHash: dataset.hash,
    datasetVersion: dataset.datasetVersion,
    registryRevision: dataset.registryRevision,
    keywordRevision: dataset.keywordRevision,
    servingSampleRevision: dataset.servingSampleRevision,
    knowledgeValueSetRevision: dataset.knowledgeValueSetRevision,
    rulesVersion: dataset.rulesVersion,
    featureSchemaVersion: dataset.featureSchemaVersion,
    ranker: selectedRanker,
    calibrator: cloneValue(recomputedEvaluation.calibrator),
  }, {
    operator,
    now,
    ...(artifactIdFactory ? { idFactory: artifactIdFactory } : {}),
  });
  const gate = cloneValue(recomputedEvaluation.gate);
  const release = createConfigInferenceRelease({
    artifactId: artifact.id,
    projectId,
    gate,
  }, {
    operator,
    now,
    ...(releaseIdFactory ? { idFactory: releaseIdFactory } : {}),
  });
  return deepFreeze({
    artifact,
    release,
    gate,
  });
}

/**
 * Resolve the only active release. Corrupt or unsupported state fails closed to
 * human-confirmation-only legacy inference and never exposes a calibrator.
 */
export function resolveConfigInferenceServingBundle({
  releases = [],
  artifacts = [],
  projectId = "",
  currentRevisionSnapshot = null,
  currentFeatureSchemaVersion = "rank-features/v1",
} = {}) {
  const active = (Array.isArray(releases) ? releases : [])
    .filter((row) => row?.status === "active")
    .filter((row) => !projectId || text(row?.projectId, 300) === text(projectId, 300));
  if (!active.length) {
    return deepFreeze({
      status: "legacy_unreleased",
      releaseId: null,
      artifactId: null,
      calibrator: null,
      ranker: null,
      gateEnforced: false,
      effectiveAutoExecution: false,
      humanConfirmationOnly: true,
      reasons: ["active_release_missing"],
    });
  }
  if (active.length !== 1) {
    return deepFreeze({
      status: "blocked_multiple_active",
      releaseId: null,
      artifactId: null,
      calibrator: null,
      ranker: null,
      gateEnforced: true,
      effectiveAutoExecution: false,
      humanConfirmationOnly: true,
      reasons: ["multiple_active_releases"],
    });
  }
  const release = active[0];
  const artifact = (Array.isArray(artifacts) ? artifacts : [])
    .find((row) => text(row?.id, 160) === text(release?.artifactId, 160));
  if (!artifact) {
    return deepFreeze({
      status: "blocked_artifact_missing",
      releaseId: text(release.id, 160),
      artifactId: text(release.artifactId, 160),
      calibrator: null,
      ranker: null,
      gateEnforced: true,
      effectiveAutoExecution: false,
      humanConfirmationOnly: true,
      reasons: ["active_artifact_missing"],
    });
  }
  const rankerMethod = text(artifact?.ranker?.method || artifact?.ranker?.artifactType, 120).toLowerCase();
  const current = currentRevisionSnapshot && typeof currentRevisionSnapshot === "object"
    ? currentRevisionSnapshot
    : null;
  const reasons = [
    ...(text(artifact?.projectId, 300) !== text(projectId, 300) ? ["artifact_project_mismatch"] : []),
    ...(!release?.gate?.canaryReady ? ["active_gate_invalid"] : []),
    ...(!SUPPORTED_SERVING_RANKERS.has(rankerMethod) ? ["ranker_adapter_unsupported"] : []),
    ...(artifact?.calibrator?.status !== "fitted" ? ["calibrator_not_fitted"] : []),
    ...(!current ? ["current_revision_snapshot_missing"] : []),
    ...(current && text(artifact?.registryRevision, 160) !== text(current?.registryRevision, 160)
      ? ["registry_revision_stale"] : []),
    ...(current && text(artifact?.keywordRevision, 160) !== text(current?.keywordRevision, 160)
      ? ["keyword_revision_stale"] : []),
    ...(current && text(artifact?.servingSampleRevision, 160) !== text(current?.servingSampleRevision, 160)
      ? ["serving_sample_revision_stale"] : []),
    ...(current && text(artifact?.knowledgeValueSetRevision, 160) !== text(current?.valueRevision, 160)
      ? ["knowledge_value_revision_stale"] : []),
    ...(current && text(artifact?.rulesVersion, 160) !== text(current?.rulesRevision, 160)
      ? ["rules_revision_stale"] : []),
    ...(text(artifact?.featureSchemaVersion, 160) !== text(currentFeatureSchemaVersion, 160)
      ? ["feature_schema_revision_stale"] : []),
  ];
  if (reasons.length) {
    return deepFreeze({
      status: "blocked_artifact_invalid",
      releaseId: text(release.id, 160),
      artifactId: text(artifact.id, 160),
      calibrator: null,
      ranker: cloneValue(artifact.ranker || null),
      gateEnforced: true,
      effectiveAutoExecution: false,
      humanConfirmationOnly: true,
      reasons,
    });
  }
  return deepFreeze({
    status: "active",
    releaseId: text(release.id, 160),
    artifactId: text(artifact.id, 160),
    datasetHash: text(artifact.datasetHash, 128),
    datasetVersion: text(artifact.datasetVersion, 160),
    rulesVersion: text(artifact.rulesVersion, 160),
    featureSchemaVersion: text(artifact.featureSchemaVersion, 160),
    registryRevision: text(artifact.registryRevision, 160),
    servingSampleRevision: text(artifact.servingSampleRevision, 160),
    calibrator: cloneValue(artifact.calibrator),
    ranker: cloneValue(artifact.ranker),
    gate: cloneValue(release.gate),
    gateEnforced: true,
    requestedAutoExecution: release.autoExecutionEnabled === true,
    // Current StoryDev entry still mandates human confirmation. A release can calibrate
    // serving now, but cannot silently enable automatic development execution.
    effectiveAutoExecution: false,
    humanConfirmationOnly: true,
    reasons: release.autoExecutionEnabled === true
      ? ["story_entry_human_confirmation_still_required"]
      : [],
  });
}

export function decorateConfigInferenceServingResult(prediction = {}, bundle = {}) {
  const servingRelease = {
    status: text(bundle?.status, 80) || "legacy_unreleased",
    releaseId: bundle?.releaseId || null,
    artifactId: bundle?.artifactId || null,
    datasetHash: bundle?.datasetHash || null,
    datasetVersion: bundle?.datasetVersion || null,
    rulesVersion: bundle?.rulesVersion || null,
    featureSchemaVersion: bundle?.featureSchemaVersion || null,
    registryRevision: bundle?.registryRevision || null,
    servingSampleRevision: bundle?.servingSampleRevision || null,
    rankerMethod: text(bundle?.ranker?.method || bundle?.ranker?.artifactType, 120) || null,
    gateEnforced: bundle?.gateEnforced === true,
    effectiveAutoExecution: false,
    humanConfirmationOnly: true,
    reasons: [...new Set(Array.isArray(bundle?.reasons) ? bundle.reasons : [])],
  };
  const active = servingRelease.status === "active";
  const existingReasons = Array.isArray(prediction?.policy?.abstainReasons)
    ? prediction.policy.abstainReasons
    : [];
  return {
    ...prediction,
    servingRelease,
    policy: {
      ...(prediction?.policy || {}),
      release: servingRelease,
      activeReleaseRequiredForCalibration: true,
      releaseGateEnforced: active,
      canAutoApply: false,
      canExecute: false,
      requiresHumanConfirmation: true,
      abstainReasons: [
        ...new Set([
          ...existingReasons,
          ...(active ? [] : servingRelease.reasons),
        ]),
      ],
    },
  };
}
