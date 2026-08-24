import assert from "node:assert/strict";
import test from "node:test";
import {
  activateConfigInferenceRelease,
  createConfigInferenceArtifact,
  createConfigInferenceRelease,
  evaluateConfigInferenceReleaseGate,
  rollbackConfigInferenceRelease,
  transitionConfigInferenceRelease,
  wilsonLowerBound,
} from "../services/devbench/machine-learn/release-governance.js";

const validValidation = () => ({
  ok: true,
  errors: [],
  warnings: [],
  splitCounts: { train: 500, dev: 100, test: 200, shadow: 0 },
  requiredSources: ["detail"],
});

const validGateOptions = (overrides = {}) => ({
  evaluationSplit: "test",
  calibratorStatus: "fitted",
  ...overrides,
});

test("artifact 冻结 dataset、rules、feature schema 和校准制品", () => {
  const calibrator = { status: "fitted", method: "isotonic" };
  const artifact = createConfigInferenceArtifact({
    projectId: "project-a",
    datasetHash: "a".repeat(64),
    datasetVersion: "golden-v1",
    rulesVersion: "rules-v4",
    featureSchemaVersion: "features-v2",
    calibrator,
  }, { idFactory: () => "MA_fixed", operator: "alice", now: 0 });
  assert.equal(artifact.id, "MA_fixed");
  assert.equal(artifact.projectId, "project-a");
  assert.equal(artifact.datasetHash, "a".repeat(64));
  assert.equal(artifact.calibrator.status, "fitted");
  calibrator.status = "tampered";
  assert.equal(artifact.calibrator.status, "fitted");
  assert.throws(() => {
    artifact.calibrator.status = "tampered";
  }, /read only|Cannot assign/);
});

test("发布门禁拒绝数据泄漏、注册表越界、低 Top3、高 ECE 和不足样本", () => {
  const gate = evaluateConfigInferenceReleaseGate({
    eligible: 100,
    exactMatch: 0.99,
    repositoryTop3Recall: 0.95,
    expectedCalibrationError: 0.08,
    selectiveRisk: 0.01,
    registryViolations: 1,
    requiredSourceAutoRuns: 1,
  }, {
    ok: false,
    errors: [{ code: "FUTURE_EVIDENCE_LEAKAGE" }],
    splitCounts: { train: 100, dev: 20, test: 100 },
    requiredSources: ["detail"],
  }, validGateOptions());
  assert.equal(gate.shadowReady, false);
  assert.equal(gate.canaryReady, false);
  assert.equal(gate.autoExecutionReady, false);
  assert.equal(gate.reasons.includes("dataset_leakage"), true);
  assert.equal(gate.reasons.includes("shadow_sample_insufficient"), true);
});

test("95% Wilson 下界阻止小样本偶然 100% 开放自动执行", () => {
  assert.equal(wilsonLowerBound(10, 10) < 0.97, true);
  const small = evaluateConfigInferenceReleaseGate({
    eligible: 10,
    exactMatch: 1,
    repositoryTop3Recall: 1,
    expectedCalibrationError: 0,
    selectiveRisk: 0,
  }, validValidation(), validGateOptions({ minShadowCases: 10 }));
  assert.equal(small.canaryReady, true);
  assert.equal(small.autoExecutionReady, false);
  assert.equal(small.autoExecutionReasons.includes("graph_lower_bound_below_threshold"), true);
});

test("全 train 指标不能冒充独立 test/shadow 评测开放发布", () => {
  const gate = evaluateConfigInferenceReleaseGate({
    eligible: 200,
    exactMatch: 1,
    repositoryTop3Recall: 1,
    expectedCalibrationError: 0,
    selectiveRisk: 0,
  }, {
    ok: true,
    errors: [],
    warnings: [{ code: "TEST_SPLIT_EMPTY" }, { code: "DEV_SPLIT_EMPTY" }],
    splitCounts: { train: 200, dev: 0, test: 0, shadow: 0 },
    requiredSources: [],
  }, {
    evaluationSplit: "train",
    calibratorStatus: "fitted",
  });
  assert.equal(gate.shadowReady, false);
  assert.equal(gate.canaryReady, false);
  assert.equal(gate.autoExecutionReady, false);
  assert.ok(gate.reasons.includes("evaluation_split_invalid"));
  assert.ok(gate.reasons.includes("dev_split_empty"));
  assert.ok(gate.reasons.includes("test_split_empty"));
  assert.ok(gate.reasons.includes("required_source_policy_missing"));
});

test("release 按 draft→shadow→5/25/50 canary→active 发布并保持单 active", () => {
  const gate = {
    shadowReady: true,
    canaryReady: true,
    autoExecutionReady: false,
  };
  let first = createConfigInferenceRelease({ artifactId: "MA_1", projectId: "p1", gate }, {
    idFactory: () => "REL_1", operator: "alice", now: 1,
  });
  first = transitionConfigInferenceRelease(first, "shadow", { operator: "alice", gate, now: 2 });
  first = transitionConfigInferenceRelease(first, "canary", { operator: "alice", gate, trafficPercent: 5, now: 3 });
  first = transitionConfigInferenceRelease(first, "canary", { operator: "alice", gate, trafficPercent: 25, now: 4 });
  first = transitionConfigInferenceRelease(first, "canary", { operator: "alice", gate, trafficPercent: 50, now: 5 });
  first = transitionConfigInferenceRelease(first, "active", { operator: "alice", gate, now: 6 });
  assert.equal(first.status, "active");
  assert.equal(first.trafficPercent, 100);
  assert.equal(first.autoExecutionEnabled, false);

  let second = createConfigInferenceRelease({ artifactId: "MA_2", projectId: "p1", gate }, {
    idFactory: () => "REL_2", operator: "alice", now: 7,
  });
  second = transitionConfigInferenceRelease(second, "shadow", { operator: "alice", gate, now: 8 });
  second = transitionConfigInferenceRelease(second, "canary", { operator: "alice", gate, trafficPercent: 5, now: 9 });
  second = transitionConfigInferenceRelease(second, "canary", { operator: "alice", gate, trafficPercent: 25, now: 10 });
  second = transitionConfigInferenceRelease(second, "canary", { operator: "alice", gate, trafficPercent: 50, now: 11 });
  const rows = activateConfigInferenceRelease([first, second], second.id, { operator: "alice", gate, now: 12 });
  assert.deepEqual(rows.map((row) => row.status), ["retired", "active"]);
});

test("canary 禁止跳过 5/25/50 任一档，未完成 50% 不能 active", () => {
  const gate = {
    shadowReady: true,
    canaryReady: true,
    autoExecutionReady: false,
  };
  let release = createConfigInferenceRelease({
    id: "REL_STEP",
    artifactId: "MA_1",
    projectId: "P1",
    gate,
  });
  release = transitionConfigInferenceRelease(release, "shadow", { operator: "alice" });
  assert.throws(
    () => transitionConfigInferenceRelease(release, "canary", {
      operator: "alice",
      trafficPercent: 25,
    }),
    /逐级放量/,
  );
  release = transitionConfigInferenceRelease(release, "canary", {
    operator: "alice",
    trafficPercent: 5,
  });
  assert.throws(
    () => transitionConfigInferenceRelease(release, "active", { operator: "alice" }),
    /完成 5%→25%→50%/,
  );
  assert.throws(
    () => transitionConfigInferenceRelease(release, "canary", {
      operator: "alice",
      trafficPercent: 50,
    }),
    /逐级放量/,
  );
});

test("未达到 gate 时禁止 canary 和自动执行", () => {
  const blocked = { shadowReady: true, canaryReady: false, autoExecutionReady: false };
  let release = createConfigInferenceRelease({ artifactId: "MA", projectId: "p", gate: blocked }, {
    idFactory: () => "REL", operator: "alice",
  });
  release = transitionConfigInferenceRelease(release, "shadow", { operator: "alice", gate: blocked });
  assert.throws(() => transitionConfigInferenceRelease(release, "canary", {
    operator: "alice", gate: blocked, trafficPercent: 5,
  }), /canary gate/);
});

test("transition 不能用调用方伪造 gate 覆盖冻结门禁，shadow 也必须通过 gate", () => {
  const blocked = { shadowReady: false, canaryReady: false, autoExecutionReady: false };
  const forged = { shadowReady: true, canaryReady: true, autoExecutionReady: true };
  const release = createConfigInferenceRelease({
    artifactId: "MA_BLOCKED",
    projectId: "p1",
    gate: blocked,
  }, { operator: "alice" });
  blocked.shadowReady = true;
  assert.equal(release.gate.shadowReady, false);
  blocked.shadowReady = false;
  assert.throws(
    () => transitionConfigInferenceRelease(release, "shadow", {
      operator: "alice",
      gate: forged,
    }),
    /禁止覆盖冻结 gate/,
  );
  assert.throws(
    () => transitionConfigInferenceRelease(release, "shadow", { operator: "alice" }),
    /shadow gate/,
  );
});

test("紧急 rollback 只允许恢复曾经 active 的 retired artifact，并创建新指针", () => {
  const gate = evaluateConfigInferenceReleaseGate({
    eligible: 200,
    exactMatch: 1,
    repositoryTop3Recall: 1,
    expectedCalibrationError: 0,
    selectiveRisk: 0,
  }, validValidation(), validGateOptions());
  const previous = {
    ...createConfigInferenceRelease({
      artifactId: "ART-OLD",
      projectId: "project-a",
      gate,
    }, { idFactory: () => "REL-OLD", operator: "alice", now: 0 }),
    status: "retired",
    history: [{ from: "canary", to: "active", at: new Date(1).toISOString(), by: "alice" }],
  };
  const current = {
    ...createConfigInferenceRelease({
      artifactId: "ART-CURRENT",
      projectId: "project-a",
      gate,
    }, { idFactory: () => "REL-CURRENT", operator: "alice", now: 2 }),
    status: "active",
    trafficPercent: 100,
  };
  const rolled = rollbackConfigInferenceRelease([previous, current], "REL-OLD", {
    operator: "bob",
    reason: "线上安全指标回退",
    now: 3,
    idFactory: () => "REL-ROLLBACK",
  });
  assert.equal(rolled.filter((row) => row.status === "active").length, 1);
  const active = rolled.find((row) => row.status === "active");
  assert.equal(active.id, "REL-ROLLBACK");
  assert.equal(active.artifactId, "ART-OLD");
  assert.equal(active.restoredFromReleaseId, "REL-OLD");
  assert.equal(active.autoExecutionEnabled, false);
  assert.equal(rolled.find((row) => row.id === "REL-CURRENT").status, "retired");
});
