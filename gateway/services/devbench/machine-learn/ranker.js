import { createHash } from "node:crypto";

export const CONFIG_INFERENCE_RANK_FEATURES = Object.freeze([
  "hard_identifier_score",
  "bm25_score",
  "ngram_score",
  "embedding_cosine",
  "same_project",
  "same_vehicle",
  "same_application",
  "same_attachment_signature",
  "case_similarity",
  "case_recency",
  "reviewer_trust",
  "approved_success_count",
  "failure_count",
  "registry_freshness",
  "source_completeness",
  "topology_compatibility",
  "conflict_count",
  "ood_score",
]);

const COUNT_FEATURES = new Set(["approved_success_count", "failure_count", "conflict_count"]);
const NEGATIVE_FEATURES = new Set(["failure_count", "conflict_count", "ood_score"]);

function finite(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function clamp(value, min = 0, max = 1) {
  return Math.min(max, Math.max(min, finite(value)));
}

function sigmoid(value) {
  const bounded = Math.max(-35, Math.min(35, finite(value)));
  return 1 / (1 + Math.exp(-bounded));
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
}

function sha256(value) {
  return createHash("sha256").update(JSON.stringify(stable(value))).digest("hex");
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.values(value).forEach(deepFreeze);
  return Object.freeze(value);
}

function normalizeFeature(name, value) {
  if (COUNT_FEATURES.has(name)) return Math.log1p(Math.max(0, finite(value)));
  if (name === "embedding_cosine") return clamp((finite(value) + 1) / 2);
  return clamp(value);
}

export function vectorizeRankFeatures(features = {}, featureNames = CONFIG_INFERENCE_RANK_FEATURES) {
  return featureNames.map((name) => normalizeFeature(name, features?.[name]));
}

function featureStats(vectors, width) {
  const means = Array(width).fill(0);
  const scales = Array(width).fill(1);
  if (vectors.length === 0) return { means, scales };
  vectors.forEach((vector) => vector.forEach((value, index) => {
    means[index] += value;
  }));
  means.forEach((_value, index) => {
    means[index] /= vectors.length;
  });
  vectors.forEach((vector) => vector.forEach((value, index) => {
    const delta = value - means[index];
    scales[index] += delta * delta;
  }));
  scales.forEach((_value, index) => {
    scales[index] = Math.sqrt(scales[index] / vectors.length);
    if (scales[index] < 1e-6) scales[index] = 1;
  });
  return { means, scales };
}

function standardize(vector, means, scales) {
  return vector.map((value, index) => (value - means[index]) / scales[index]);
}

function approvedTrainingRow(row) {
  const status = String(row?.labelStatus || row?.status || "").toLowerCase();
  return ["approved", "active", "verified"].includes(status);
}

/**
 * Train an interpretable pointwise logistic ranker using only the train split.
 *
 * This deliberately does not support incremental click updates: a new immutable artifact must be
 * trained, evaluated and released before weights can affect serving.
 */
export function trainConfigInferenceRanker(examples = [], {
  featureNames = CONFIG_INFERENCE_RANK_FEATURES,
  epochs = 500,
  learningRate = 0.08,
  l2 = 0.001,
  trainedAt = new Date().toISOString(),
  datasetVersion = "",
  featureSchemaVersion = "rank-features/v1",
} = {}) {
  if (!Array.isArray(examples) || examples.length < 4) {
    throw new Error("可学习排序至少需要 4 条训练候选");
  }
  const invalidSplit = examples.find((row) => String(row?.split || "train").toLowerCase() !== "train");
  if (invalidSplit) throw new Error("排序权重只能使用 train split 学习");
  const unapproved = examples.find((row) => !approvedTrainingRow(row));
  if (unapproved) throw new Error("排序训练只接受 approved/active/verified 标签");

  const labels = examples.map((row) => (row?.label === true || Number(row?.label) === 1 ? 1 : 0));
  if (!labels.includes(1) || !labels.includes(0)) {
    throw new Error("排序训练必须同时包含正候选和负候选");
  }
  const names = [...featureNames];
  const rawVectors = examples.map((row) => vectorizeRankFeatures(row?.features, names));
  const { means, scales } = featureStats(rawVectors, names.length);
  const vectors = rawVectors.map((vector) => standardize(vector, means, scales));
  const weights = Array(names.length).fill(0);
  let intercept = 0;
  const iterations = Math.max(1, Math.min(10_000, Math.trunc(finite(epochs, 500))));
  const rate = Math.max(0.0001, Math.min(1, finite(learningRate, 0.08)));
  const regularization = Math.max(0, Math.min(1, finite(l2, 0.001)));

  for (let epoch = 0; epoch < iterations; epoch += 1) {
    const gradient = Array(names.length).fill(0);
    let interceptGradient = 0;
    for (let rowIndex = 0; rowIndex < vectors.length; rowIndex += 1) {
      const vector = vectors[rowIndex];
      const logit = intercept + vector.reduce(
        (sum, value, index) => sum + value * weights[index],
        0,
      );
      const error = sigmoid(logit) - labels[rowIndex];
      interceptGradient += error;
      vector.forEach((value, index) => {
        gradient[index] += error * value;
      });
    }
    const divisor = vectors.length;
    intercept -= rate * interceptGradient / divisor;
    weights.forEach((_value, index) => {
      weights[index] -= rate * (gradient[index] / divisor + regularization * weights[index]);
    });
  }

  const dataFingerprint = examples.map((row, index) => ({
    id: String(row?.id || row?.candidateId || index),
    label: labels[index],
    features: rawVectors[index],
  }));
  const model = {
    artifactType: "config-inference-logistic-ranker",
    artifactVersion: 1,
    featureSchemaVersion: String(featureSchemaVersion),
    featureNames: names,
    datasetVersion: String(datasetVersion),
    trainedAt: new Date(trainedAt).toISOString(),
    trainingDataHash: sha256(dataFingerprint),
    trainingRows: examples.length,
    positiveRows: labels.filter(Boolean).length,
    negativeRows: labels.filter((value) => !value).length,
    intercept,
    weights,
    means,
    scales,
    hyperparameters: {
      epochs: iterations,
      learningRate: rate,
      l2: regularization,
    },
  };
  return deepFreeze({
    ...model,
    artifactId: `ranker_${sha256(model).slice(0, 24)}`,
  });
}

export function scoreConfigInferenceCandidate(model, candidate = {}) {
  if (model?.artifactType !== "config-inference-logistic-ranker") {
    throw new Error("排序制品类型无效");
  }
  const names = Array.isArray(model?.featureNames) ? model.featureNames : [];
  if (
    names.length === 0
    || !Array.isArray(model?.weights)
    || model.weights.length !== names.length
    || model?.means?.length !== names.length
    || model?.scales?.length !== names.length
  ) {
    throw new Error("排序制品特征维度无效");
  }
  const raw = vectorizeRankFeatures(candidate?.features, names);
  const vector = standardize(raw, model.means, model.scales);
  const contributions = names.map((name, index) => ({
    feature: name,
    rawValue: raw[index],
    standardizedValue: vector[index],
    weight: model.weights[index],
    contribution: vector[index] * model.weights[index],
  }));
  const logit = finite(model.intercept) + contributions.reduce(
    (sum, item) => sum + item.contribution,
    0,
  );
  return {
    candidateId: String(candidate?.candidateId || candidate?.id || ""),
    score: sigmoid(logit),
    logit,
    contributions: contributions.sort(
      (left, right) => Math.abs(right.contribution) - Math.abs(left.contribution),
    ),
    artifactId: String(model?.artifactId || ""),
  };
}

export function rankConfigInferenceCandidates(model, candidates = [], {
  limit = 20,
  requireRegistryAllowed = true,
} = {}) {
  const rows = (Array.isArray(candidates) ? candidates : [])
    .filter((candidate) => !requireRegistryAllowed || candidate?.registryAllowed === true)
    .map((candidate) => ({
      candidate,
      prediction: scoreConfigInferenceCandidate(model, candidate),
    }))
    .sort((left, right) => (
      right.prediction.score - left.prediction.score
      || left.prediction.candidateId.localeCompare(right.prediction.candidateId)
    ));
  return rows.slice(0, Math.max(0, Math.trunc(finite(limit, 20)))).map((row, index) => ({
    ...row.candidate,
    rank: index + 1,
    rankScore: row.prediction.score,
    rankExplanation: row.prediction.contributions,
    rankerArtifactId: row.prediction.artifactId,
  }));
}

export function expectedRankFeatureDirection(featureName) {
  return NEGATIVE_FEATURES.has(featureName) ? "negative" : "positive";
}
