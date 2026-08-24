import assert from "node:assert/strict";
import test from "node:test";

import { createConfigInferenceDatasetVersion } from "../services/devbench/machine-learn/evaluator.js";
import {
  activateConfigInferenceRelease,
  transitionConfigInferenceRelease,
} from "../services/devbench/machine-learn/release-governance.js";
import {
  createConfigInferenceReleaseBundle,
  decorateConfigInferenceServingResult,
  prepareConfigInferenceReleaseEvaluation,
  resolveConfigInferenceServingBundle,
} from "../services/devbench/machine-learn/serving-orchestrator.js";

const GRAPH = [{
  targetId: "market-primary",
  targetRole: "primary",
  order: 1,
  appName: "应用市场",
  vehicle: "P162",
  repositoryId: "market",
  branch: "release/p162",
  flavor: "p162Prod",
}];

function goldenCase(id, split, { exact = true, rawScore = exact ? 90 : 10 } = {}) {
  return {
    id,
    groupId: id,
    split,
    inferenceAt: "2026-07-20T00:00:00.000Z",
    requiredSources: ["detail"],
    sourceCoverage: {
      detail: { available: true, complete: true },
    },
    evidence: [{
      sourceType: "detail",
      sourceId: id,
      span: "title",
      availableAt: "2026-07-19T00:00:00.000Z",
      extractorVersion: "test-v1",
    }],
    approvedLabel: {
      status: "approved",
      targets: GRAPH,
    },
    prediction: {
      status: "NEED_HUMAN_CONFIRMATION",
      targets: exact ? GRAPH : [{
        ...GRAPH[0],
        repositoryId: "wrong",
      }],
      candidates: exact ? GRAPH : [{
        ...GRAPH[0],
        repositoryId: "wrong",
      }, ...GRAPH],
      confidenceScore: exact ? 0.9 : 0.1,
      confidenceMetadata: { rawTopScore: rawScore },
      policy: {
        registryValid: true,
        canAutoApply: false,
      },
      versions: { stale: false },
    },
  };
}

function validDataset() {
  const cases = [
    ...Array.from({ length: 20 }, (_, index) => goldenCase(
      `dev-${index + 1}`,
      "dev",
      { exact: index >= 10, rawScore: index >= 10 ? 90 : 10 },
    )),
    ...Array.from({ length: 200 }, (_, index) => goldenCase(`test-${index + 1}`, "test")),
  ];
  return createConfigInferenceDatasetVersion({
    datasetVersion: "golden-v1",
    registryRevision: "registry-v1",
    servingSampleRevision: "samples-v1",
    rulesVersion: "config-inference-v4",
    featureSchemaVersion: "rank-features/v1",
    knowledgeValueSetRevision: "values-v1",
    requiredSources: ["detail"],
    cases,
  });
}

test("dev 校准与 test 评估冻结为可发布 gate，test 不参与拟合", () => {
  const dataset = validDataset();
  const evaluation = prepareConfigInferenceReleaseEvaluation(dataset, {
    split: "test",
    bootstrapIterations: 0,
  });
  assert.equal(evaluation.validation.ok, true);
  assert.equal(evaluation.calibration.split, "dev");
  assert.equal(evaluation.calibration.sampleCount, 20);
  assert.equal(evaluation.calibrator.status, "fitted");
  assert.equal(evaluation.metrics.evaluationSplit, "test");
  assert.equal(evaluation.metrics.eligible, 200);
  assert.equal(evaluation.metrics.exactMatch, 1);
  assert.equal(evaluation.metrics.registryViolations, 0);
  assert.equal(evaluation.gate.canaryReady, true);
  assert.equal(evaluation.gate.autoExecutionReady, true);
});

test("release 必须按 shadow、5%、25%、50%、active 顺序并绑定冻结 artifact", () => {
  const dataset = validDataset();
  const evaluation = prepareConfigInferenceReleaseEvaluation(dataset, { split: "test" });
  const bundle = createConfigInferenceReleaseBundle({
    projectId: "project-a",
    dataset,
    evaluation,
    operator: "admin-a",
    artifactIdFactory: () => "ART-1",
    releaseIdFactory: () => "REL-1",
  });
  assert.equal(bundle.artifact.datasetHash, dataset.hash);
  assert.equal(bundle.artifact.calibrator.status, "fitted");
  assert.equal(bundle.release.gate.canaryReady, true);

  const shadow = transitionConfigInferenceRelease(bundle.release, "shadow", {
    operator: "admin-a",
  });
  const canary5 = transitionConfigInferenceRelease(shadow, "canary", {
    operator: "admin-a",
    trafficPercent: 5,
  });
  const canary25 = transitionConfigInferenceRelease(canary5, "canary", {
    operator: "admin-a",
    trafficPercent: 25,
  });
  const canary50 = transitionConfigInferenceRelease(canary25, "canary", {
    operator: "admin-a",
    trafficPercent: 50,
  });
  const releases = activateConfigInferenceRelease([canary50], "REL-1", {
    operator: "admin-a",
  });
  const serving = resolveConfigInferenceServingBundle({
    projectId: "project-a",
    releases,
    artifacts: [bundle.artifact],
    currentRevisionSnapshot: {
      registryRevision: "registry-v1",
      keywordRevision: "",
      servingSampleRevision: "samples-v1",
      valueRevision: "values-v1",
      rulesRevision: "config-inference-v4",
    },
  });
  assert.equal(serving.status, "active");
  assert.equal(serving.releaseId, "REL-1");
  assert.equal(serving.artifactId, "ART-1");
  assert.equal(serving.calibrator.status, "fitted");
  assert.equal(serving.effectiveAutoExecution, false);
});

test("无 active release 与损坏 release 都 fail closed，不能伪装成已校准 serving", () => {
  const legacy = resolveConfigInferenceServingBundle({
    projectId: "project-a",
    releases: [],
    artifacts: [],
  });
  assert.equal(legacy.status, "legacy_unreleased");
  assert.equal(legacy.calibrator, null);
  assert.equal(legacy.effectiveAutoExecution, false);

  const broken = resolveConfigInferenceServingBundle({
    projectId: "project-a",
    releases: [{
      id: "REL-BROKEN",
      projectId: "project-a",
      artifactId: "ART-MISSING",
      status: "active",
      gate: { canaryReady: true },
    }],
    artifacts: [],
    currentRevisionSnapshot: {
      registryRevision: "registry-v1",
      keywordRevision: "",
      servingSampleRevision: "samples-v1",
      valueRevision: "values-v1",
      rulesRevision: "config-inference-v4",
    },
  });
  assert.equal(broken.status, "blocked_artifact_missing");
  assert.equal(broken.calibrator, null);

  const decorated = decorateConfigInferenceServingResult({
    policy: {
      canAutoApply: true,
      canExecute: true,
      requiresHumanConfirmation: false,
      abstainReasons: [],
    },
  }, broken);
  assert.equal(decorated.policy.canAutoApply, false);
  assert.equal(decorated.policy.canExecute, false);
  assert.equal(decorated.policy.requiresHumanConfirmation, true);
  assert.deepEqual(decorated.policy.abstainReasons, ["active_artifact_missing"]);
});

test("伪造 evaluation、跨项目 artifact 与陈旧 revision 均不能进入 active serving", () => {
  const dataset = validDataset();
  const evaluation = prepareConfigInferenceReleaseEvaluation(dataset, {
    split: "test",
    bootstrapIterations: 0,
  });
  assert.throws(() => createConfigInferenceReleaseBundle({
    projectId: "project-a",
    dataset,
    evaluation: {
      ...evaluation,
      evaluationFingerprint: "forged",
      gate: { canaryReady: true, autoExecutionReady: true },
    },
    operator: "admin-a",
  }), (error) => error?.code === "CONFIG_INFERENCE_EVALUATION_MISMATCH");

  const bundle = createConfigInferenceReleaseBundle({
    projectId: "project-a",
    dataset,
    evaluation,
    operator: "admin-a",
    artifactIdFactory: () => "ART-SECURITY",
    releaseIdFactory: () => "REL-SECURITY",
  });
  const activeRelease = {
    ...bundle.release,
    status: "active",
    trafficPercent: 100,
  };
  const crossProject = resolveConfigInferenceServingBundle({
    projectId: "project-b",
    releases: [{ ...activeRelease, projectId: "project-b" }],
    artifacts: [bundle.artifact],
    currentRevisionSnapshot: {
      registryRevision: "registry-v1",
      keywordRevision: "",
      servingSampleRevision: "samples-v1",
      valueRevision: "values-v1",
      rulesRevision: "config-inference-v4",
    },
  });
  assert.equal(crossProject.status, "blocked_artifact_invalid");
  assert.ok(crossProject.reasons.includes("artifact_project_mismatch"));

  const stale = resolveConfigInferenceServingBundle({
    projectId: "project-a",
    releases: [activeRelease],
    artifacts: [bundle.artifact],
    currentRevisionSnapshot: {
      registryRevision: "registry-v2",
      keywordRevision: "",
      servingSampleRevision: "samples-v2",
      valueRevision: "values-v2",
      rulesRevision: "config-inference-v5",
    },
  });
  assert.equal(stale.status, "blocked_artifact_invalid");
  assert.ok(stale.reasons.includes("registry_revision_stale"));
  assert.ok(stale.reasons.includes("serving_sample_revision_stale"));
  assert.ok(stale.reasons.includes("knowledge_value_revision_stale"));
  assert.ok(stale.reasons.includes("rules_revision_stale"));
  assert.equal(stale.calibrator, null);
});

test("尚未接 serving adapter 的离线 logistic ranker 不能创建可激活 release", () => {
  const dataset = validDataset();
  const evaluation = prepareConfigInferenceReleaseEvaluation(dataset, {
    split: "test",
    bootstrapIterations: 0,
  });
  assert.throws(() => createConfigInferenceReleaseBundle({
    projectId: "project-a",
    dataset,
    evaluation,
    operator: "admin-a",
    ranker: {
      artifactType: "config-inference-logistic-ranker",
      artifactId: "ranker-1",
    },
  }), (error) => error?.code === "CONFIG_INFERENCE_RANKER_NOT_SERVABLE");
});
