import assert from "node:assert/strict";
import test from "node:test";
import {
  calibrateConfigInferenceScore,
  evaluateConfigInferencePolicy,
  fitIsotonicCalibrator,
} from "../services/devbench/machine-learn/calibration.js";

test("isotonic calibrator 学到单调经验概率并可插值", () => {
  const samples = [
    ...Array.from({ length: 10 }, (_, index) => ({ score: index, label: index >= 8 ? 1 : 0 })),
    ...Array.from({ length: 10 }, (_, index) => ({ score: 10 + index, label: index >= 2 ? 1 : 0 })),
  ];
  const model = fitIsotonicCalibrator(samples, { minSamples: 10 });
  assert.equal(model.status, "fitted");
  assert.equal(model.sampleCount, 20);
  const low = calibrateConfigInferenceScore(model, 1);
  const middle = calibrateConfigInferenceScore(model, 9.5);
  const high = calibrateConfigInferenceScore(model, 18);
  assert.equal(low <= middle && middle <= high, true);
  assert.equal(low >= 0 && high <= 1, true);
});

test("样本不足时拒绝把启发式分数伪装成概率", () => {
  const model = fitIsotonicCalibrator([{ score: 10, label: 1 }], { minSamples: 20 });
  assert.equal(model.status, "insufficient_data");
  assert.equal(calibrateConfigInferenceScore(model, 10), null);
});

test("策略门禁明确报告来源、概率、margin、注册表、本机与人工确认阻塞", () => {
  const result = evaluateConfigInferencePolicy({
    targets: [{ repositoryId: "repo" }],
    calibratedProbability: 0.98,
    heuristicConfidence: 0.95,
    margin: 0.1,
    sourceCoverage: { comments: { available: true, complete: false } },
    requiredSources: ["comments"],
    registryValid: false,
    remoteRefsValid: false,
    localBindingComplete: false,
    humanConfirmationRequired: true,
  });
  assert.equal(result.canAutoApply, false);
  assert.equal(result.abstain, true);
  assert.deepEqual(new Set(result.reasons), new Set([
    "required_source_incomplete",
    "registry_invalid",
    "remote_ref_unverified",
    "local_binding_incomplete",
    "probability_below_threshold",
    "margin_below_threshold",
    "human_confirmation_required",
  ]));
  assert.deepEqual(result.missingSources, ["comments"]);
});

test("只有全部硬门禁、校准概率和 margin 达标时才允许自动采用", () => {
  const result = evaluateConfigInferencePolicy({
    targets: [{ repositoryId: "repo" }],
    calibratedProbability: 0.999,
    heuristicConfidence: 0.97,
    margin: 0.3,
    sourceCoverage: { comments: { available: true, complete: true } },
    requiredSources: ["comments"],
    registryValid: true,
    remoteRefsValid: true,
    localBindingComplete: true,
    humanConfirmationRequired: false,
  });
  assert.equal(result.canAutoApply, true);
  assert.equal(result.abstain, false);
  assert.deepEqual(result.reasons, []);
});

test("候选 margin 过低时进入拒答而不是任取第一项", () => {
  const result = evaluateConfigInferencePolicy({
    targets: [{ repositoryId: "repo-a" }],
    calibratedProbability: 0.999,
    margin: 0.01,
    registryValid: true,
    remoteRefsValid: true,
    localBindingComplete: true,
    humanConfirmationRequired: false,
  });
  assert.equal(result.canAutoApply, false);
  assert.equal(result.abstain, true);
  assert.deepEqual(result.reasons, ["margin_below_threshold"]);
});
