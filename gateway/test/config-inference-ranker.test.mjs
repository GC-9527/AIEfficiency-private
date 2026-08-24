import assert from "node:assert/strict";
import test from "node:test";

import {
  expectedRankFeatureDirection,
  rankConfigInferenceCandidates,
  scoreConfigInferenceCandidate,
  trainConfigInferenceRanker,
  vectorizeRankFeatures,
} from "../services/devbench/machine-learn/ranker.js";

function trainingRows() {
  return [
    {
      id: "a-positive",
      split: "train",
      status: "approved",
      label: 1,
      features: {
        hard_identifier_score: 1,
        bm25_score: 0.9,
        same_project: 1,
        source_completeness: 1,
        conflict_count: 0,
      },
    },
    {
      id: "b-positive",
      split: "train",
      status: "active",
      label: 1,
      features: {
        hard_identifier_score: 0.9,
        bm25_score: 0.8,
        same_project: 1,
        source_completeness: 0.9,
        conflict_count: 0,
      },
    },
    {
      id: "a-negative",
      split: "train",
      status: "verified",
      label: 0,
      features: {
        hard_identifier_score: 0,
        bm25_score: 0.1,
        same_project: 0,
        source_completeness: 0.4,
        conflict_count: 3,
        ood_score: 1,
      },
    },
    {
      id: "b-negative",
      split: "train",
      status: "approved",
      label: 0,
      features: {
        hard_identifier_score: 0.1,
        bm25_score: 0.2,
        same_project: 0,
        source_completeness: 0.5,
        conflict_count: 2,
        ood_score: 0.8,
      },
    },
  ];
}

test("排序器只允许 train split 和已批准标签", () => {
  assert.throws(
    () => trainConfigInferenceRanker(
      trainingRows().map((row, index) => (index === 0 ? { ...row, split: "dev" } : row)),
    ),
    /train split/,
  );
  assert.throws(
    () => trainConfigInferenceRanker(
      trainingRows().map((row, index) => (index === 0 ? { ...row, status: "pending" } : row)),
    ),
    /approved/,
  );
});

test("logistic ranker 学到强标识正向、冲突和 OOD 负向关系", () => {
  const model = trainConfigInferenceRanker(trainingRows(), {
    trainedAt: "2026-07-29T00:00:00.000Z",
    datasetVersion: "golden-v1",
  });
  const positive = scoreConfigInferenceCandidate(model, {
    id: "good",
    features: {
      hard_identifier_score: 1,
      bm25_score: 1,
      same_project: 1,
      source_completeness: 1,
    },
  });
  const negative = scoreConfigInferenceCandidate(model, {
    id: "bad",
    features: {
      conflict_count: 4,
      ood_score: 1,
      source_completeness: 0.2,
    },
  });
  assert.ok(positive.score > negative.score);
  assert.ok(positive.score > 0.8);
  assert.ok(negative.score < 0.2);
  assert.equal(model.datasetVersion, "golden-v1");
  assert.match(model.artifactId, /^ranker_/);
});

test("候选排序硬过滤注册表越界结果并提供逐特征解释", () => {
  const model = trainConfigInferenceRanker(trainingRows(), {
    trainedAt: "2026-07-29T00:00:00.000Z",
  });
  const ranked = rankConfigInferenceCandidates(model, [
    {
      id: "invented",
      registryAllowed: false,
      features: { hard_identifier_score: 1 },
    },
    {
      id: "legal-low",
      registryAllowed: true,
      features: { conflict_count: 2, ood_score: 0.8 },
    },
    {
      id: "legal-high",
      registryAllowed: true,
      features: { hard_identifier_score: 1, bm25_score: 1, same_project: 1 },
    },
  ]);
  assert.deepEqual(ranked.map((row) => row.id), ["legal-high", "legal-low"]);
  assert.equal(ranked[0].rank, 1);
  assert.ok(ranked[0].rankExplanation.length > 0);
  assert.equal(ranked[0].rankerArtifactId, model.artifactId);
});

test("相同训练数据和配置产生相同模型 ID", () => {
  const options = {
    trainedAt: "2026-07-29T00:00:00.000Z",
    datasetVersion: "v1",
  };
  const first = trainConfigInferenceRanker(trainingRows(), options);
  const second = trainConfigInferenceRanker(trainingRows(), options);
  assert.equal(first.artifactId, second.artifactId);
  assert.deepEqual(first.weights, second.weights);
});

test("排序制品深度不可变，artifactId 下的权重不能被原地篡改", () => {
  const model = trainConfigInferenceRanker(trainingRows(), {
    trainedAt: "2026-07-29T00:00:00.000Z",
  });
  const before = scoreConfigInferenceCandidate(model, {
    id: "candidate",
    features: { hard_identifier_score: 0.7, conflict_count: 1 },
  }).score;
  assert.throws(() => {
    model.weights[0] = 999;
  }, /read only|Cannot assign/);
  const after = scoreConfigInferenceCandidate(model, {
    id: "candidate",
    features: { hard_identifier_score: 0.7, conflict_count: 1 },
  }).score;
  assert.equal(after, before);
});

test("特征规范化和方向元数据明确", () => {
  const vector = vectorizeRankFeatures({
    embedding_cosine: -1,
    approved_success_count: 99,
    conflict_count: 3,
  });
  assert.ok(vector.every(Number.isFinite));
  assert.equal(expectedRankFeatureDirection("hard_identifier_score"), "positive");
  assert.equal(expectedRankFeatureDirection("conflict_count"), "negative");
});
