import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  bootstrapConfigInferenceMetrics,
  compareConfigInferenceEvaluationReports,
  configInferenceDatasetHash,
  createConfigInferenceDatasetVersion,
  evaluateConfigInferenceDataset,
  evaluationTargetGraphKey,
  renderConfigInferenceEvaluationHtml,
  splitConfigInferenceCasesByTime,
  validateConfigInferenceDataset,
} from "../services/devbench/machine-learn/evaluator.js";

const primary = (repositoryId, overrides = {}) => ({
  targetId: overrides.targetId || `target-${repositoryId}`,
  targetRole: "primary",
  order: 1,
  appName: "AppMarket",
  vehicle: "avatr8678",
  repositoryId,
  branch: "release/8678",
  flavor: "avatr8678ProdRelease",
  ...overrides,
});

function approvedCase(id, {
  split = "test",
  expected = [primary("appmarket")],
  predicted = expected,
  candidates = predicted,
  confidence = 0.9,
  decision = "correct",
  status = predicted.length ? "NEED_HUMAN_CONFIRMATION" : "NEED_MORE_INFO",
} = {}) {
  return {
    id,
    groupId: id,
    split,
    inferenceAt: "2026-01-02T00:00:00.000Z",
    evidence: [{
      sourceType: "detail",
      sourceId: id,
      span: "ticket_snapshot",
      availableAt: "2026-01-01T00:00:00.000Z",
      extractorVersion: "test-v1",
    }],
    sourceCoverage: {
      detail: { available: true, complete: true },
      comments: { available: true, complete: true },
    },
    prediction: { status, confidenceScore: confidence, targets: predicted, candidates },
    approvedLabel: {
      status: "approved",
      decision,
      targets: expected,
      noTargets: expected.length === 0,
    },
  };
}

test("完整目标图比较保留 target tuple、角色和顺序", () => {
  const graph = [
    primary("main", { targetId: "main", order: 1 }),
    primary("web", { targetId: "web", targetRole: "dependency", order: 2, branch: "web-main" }),
  ];
  const swapped = [
    graph[0],
    { ...graph[1], branch: graph[0].branch },
  ];
  assert.notEqual(evaluationTargetGraphKey(graph), evaluationTargetGraphKey(swapped));
});

test("评测同时输出完整图、Top-k、coverage、selective risk、Brier 和 ECE", () => {
  const wrong = primary("wrong");
  const expected = primary("expected");
  const dataset = {
    datasetVersion: "golden-v1",
    cases: [
      approvedCase("correct"),
      approvedCase("top3", {
        expected: [expected],
        predicted: [wrong],
        candidates: [wrong, primary("second"), expected],
        confidence: 0.8,
      }),
      approvedCase("negative", {
        expected: [],
        predicted: [],
        candidates: [],
        confidence: 0.1,
        decision: "insufficient",
        status: "NEED_MORE_INFO",
      }),
    ],
  };
  const report = evaluateConfigInferenceDataset(dataset);
  assert.equal(report.metrics.eligible, 3);
  assert.equal(report.metrics.coverage, 0.666667);
  assert.equal(report.metrics.exactMatch, 0.666667);
  assert.equal(report.metrics.repositoryTop1Accuracy, 0.5);
  assert.equal(report.metrics.repositoryTop3Recall, 1);
  assert.equal(report.metrics.selectiveRisk, 0.5);
  assert.equal(report.metrics.insufficientRecall, 1);
  assert.equal(typeof report.metrics.brierScore, "number");
  assert.equal(typeof report.metrics.expectedCalibrationError, "number");
  assert.equal(report.slices.vehicle.avatr8678.eligible, 2);
  assert.equal(report.slices.sourceCompleteness.complete.eligible, 3);
});

test("Golden Set 校验拒绝未来证据、跨 split 近重复和未批准标签", () => {
  const first = approvedCase("one", { split: "train" });
  first.groupId = "incident-1";
  first.evidence = [{
    sourceType: "detail",
    sourceId: "one",
    span: "ticket_snapshot",
    availableAt: "2026-01-03T00:00:00.000Z",
    extractorVersion: "test-v1",
  }];
  const second = approvedCase("two", { split: "test" });
  second.groupId = "incident-1";
  second.approvedLabel.status = "draft";
  const validation = validateConfigInferenceDataset({ cases: [first, second] });
  assert.equal(validation.ok, false);
  assert.deepEqual(
    new Set(validation.errors.map((row) => row.code)),
    new Set(["FUTURE_EVIDENCE_LEAKAGE", "GROUP_SPLIT_LEAKAGE", "LABEL_NOT_APPROVED"]),
  );
});

test("缺失 evidence.availableAt 是阻断发布的泄漏风险而非普通 warning", () => {
  const row = approvedCase("missing-evidence-time");
  row.evidence = [{ type: "comment", value: "没有来源时间" }];
  const validation = validateConfigInferenceDataset({ cases: [row] });
  assert.equal(validation.ok, false);
  assert.ok(validation.errors.some((item) => item.code === "EVIDENCE_TIME_MISSING"));
});

test("Golden Set 对 required source 和显式批准状态执行硬门禁", () => {
  const row = approvedCase("required-source");
  row.approvedLabel.status = "";
  row.sourceCoverage.attachments = { available: true, complete: false };
  const validation = validateConfigInferenceDataset({
    requiredSources: ["attachments"],
    cases: [row],
  });
  assert.equal(validation.ok, false);
  assert.deepEqual(
    new Set(validation.errors.map((item) => item.code)),
    new Set(["LABEL_NOT_APPROVED", "REQUIRED_SOURCE_INCOMPLETE", "REQUIRED_SOURCE_EVIDENCE_MISSING"]),
  );
});

test("数据集 hash 对对象字段顺序稳定，并把验证结果固化到版本对象", () => {
  const row = approvedCase("stable");
  const left = { datasetVersion: "v1", cases: [row] };
  const right = { cases: [row], datasetVersion: "v1" };
  assert.equal(configInferenceDatasetHash(left), configInferenceDatasetHash(right));
  const versioned = createConfigInferenceDatasetVersion(left);
  assert.equal(versioned.validation.ok, true);
  assert.match(versioned.hash, /^[a-f0-9]{64}$/);
});

test("冻结数据集深拷贝案例，外部后续修改不能使 hash 与 validation 漂移", () => {
  const source = approvedCase("immutable");
  const versioned = createConfigInferenceDatasetVersion({
    datasetVersion: "immutable-v1",
    cases: [source],
  });
  const originalHash = versioned.hash;
  source.approvedLabel.status = "draft";
  source.evidence.push({
    availableAt: "2099-01-01T00:00:00.000Z",
    type: "future",
  });
  assert.equal(versioned.validation.ok, true);
  assert.equal(configInferenceDatasetHash(versioned), originalHash);
  assert.equal(versioned.cases[0].approvedLabel.status, "approved");
  assert.throws(() => {
    versioned.cases[0].approvedLabel.status = "draft";
  }, /read only|Cannot assign/);
});

test("时间切分保持近重复组在同一 split，并把最新案例放入 test", () => {
  const cases = Array.from({ length: 10 }, (_, index) => ({
    ...approvedCase(`time-${index + 1}`),
    split: "",
    inferenceAt: `2026-01-${String(index + 1).padStart(2, "0")}T00:00:00.000Z`,
  }));
  cases[6].groupId = "duplicate-pair";
  cases[7].groupId = "duplicate-pair";
  const split = splitConfigInferenceCasesByTime(cases, { train: 0.6, dev: 0.2, test: 0.2 });
  assert.equal(new Set(split.filter((row) => row.groupId === "duplicate-pair").map((row) => row.split)).size, 1);
  assert.equal(split.find((row) => row.id === "time-10").split, "test");
  assert.equal(split.find((row) => row.id === "time-1").split, "train");
  assert.equal(validateConfigInferenceDataset({ cases: split }).errors.some((row) => row.code === "GROUP_SPLIT_LEAKAGE"), false);
});

test("HTML 报告转义不可信案例字段", () => {
  const report = evaluateConfigInferenceDataset({
    datasetVersion: "<script>alert(1)</script>",
    cases: [approvedCase("<img src=x onerror=alert(1)>")],
  });
  const html = renderConfigInferenceEvaluationHtml(report, { errors: [], warnings: [] });
  assert.doesNotMatch(html, /<script>alert/);
  assert.doesNotMatch(html, /<img src=x/);
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /没有发现时间泄漏/);
});

test("bootstrap 区间确定性输出并覆盖完整图、Top3、coverage 与 ECE", () => {
  const rows = [
    approvedCase("correct"),
    approvedCase("wrong", {
      predicted: [primary("wrong")],
      candidates: [primary("wrong"), primary("appmarket")],
      confidence: 0.8,
    }),
    approvedCase("abstain", {
      expected: [],
      predicted: [],
      candidates: [],
      status: "NEED_MORE_INFO",
      confidence: 0.1,
      noTargets: true,
    }),
  ];
  const first = bootstrapConfigInferenceMetrics(rows, { iterations: 100, seed: "fixed" });
  const second = bootstrapConfigInferenceMetrics(rows, { iterations: 100, seed: "fixed" });
  assert.deepEqual(first, second);
  assert.equal(first.exactMatch.samples, 100);
  assert.ok(first.exactMatch.lower <= first.exactMatch.upper);
  assert.ok(first.repositoryTop3Recall);
  assert.ok(first.coverage);
  assert.ok(first.expectedCalibrationError);
});

test("新旧评测报告输出逐案例改进/回退和聚合 delta", () => {
  const baseline = evaluateConfigInferenceDataset({
    datasetVersion: "baseline",
    cases: [
      approvedCase("fixed", { predicted: [primary("wrong")] }),
      approvedCase("regressed"),
      approvedCase("stable"),
    ],
  }, { bootstrapIterations: 0 });
  const candidate = evaluateConfigInferenceDataset({
    datasetVersion: "candidate",
    cases: [
      approvedCase("fixed"),
      approvedCase("regressed", { predicted: [primary("wrong")] }),
      approvedCase("stable"),
    ],
  }, { bootstrapIterations: 0 });
  const diff = compareConfigInferenceEvaluationReports(baseline, candidate);
  assert.equal(diff.counts.improved, 1);
  assert.equal(diff.counts.regressed, 1);
  assert.equal(diff.cases.find((row) => row.id === "fixed").change, "improved");
  assert.equal(diff.cases.find((row) => row.id === "regressed").change, "regressed");
  assert.equal(diff.aggregateDelta.exactMatch, 0);
});

test("评测 CLI 生成机器可读 JSON 和离线 HTML", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "config-inference-eval-"));
  try {
    const input = path.join(dir, "dataset.json");
    const output = path.join(dir, "report.json");
    const html = path.join(dir, "report.html");
    fs.writeFileSync(input, JSON.stringify({
      datasetVersion: "cli-v1",
      cases: [approvedCase("cli-case")],
    }), "utf8");
    const script = fileURLToPath(new URL("../tools/evaluate-config-inference.mjs", import.meta.url));
    const result = spawnSync(process.execPath, [
      script,
      "--input", input,
      "--output", output,
      "--html", html,
      "--split", "test",
      "--fail-on-leak",
    ], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const report = JSON.parse(fs.readFileSync(output, "utf8"));
    assert.equal(report.datasetVersion, "cli-v1");
    assert.equal(report.metrics.exactMatch, 1);
    assert.match(fs.readFileSync(html, "utf8"), /故事点配置推理离线评测/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
