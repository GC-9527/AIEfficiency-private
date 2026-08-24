import assert from "node:assert/strict";
import test from "node:test";

import {
  annotationGovernance,
  confidencePresentation,
  configInferenceConflictGate,
  configInferenceConflictTargetFingerprint,
  configInferenceSourceGate,
  evaluationSummary,
  governanceSummary,
  keywordGovernanceStatus,
  knowledgeScopeMeta,
  looksMachineLocalValue,
  normalizeKnowledgeBinding,
  sourceCoverageRows,
  trainingMetricSummary,
  validateKnowledgeDraft,
} from "./aiTrainingGovernanceModel.mjs";

test("sourceCoverage 逐源区分完整、部分、失败，缺失来源只告警不阻止正向提交", () => {
  const session = {
    sourceCoverage: {},
    sourceCoverageGate: { applicable: true, required: ["detail", "comments"] },
    ticket: {
      sourceCoverage: {
        manual: { available: true },
        detail: { available: true },
        comments: { available: true, complete: false, count: 30, error: "仅取到第一页" },
        attachments: { available: false, error: "权限不足" },
        tags: { available: true, count: 2 },
      },
    },
  };
  const rows = sourceCoverageRows(session);
  assert.equal(rows.find((row) => row.key === "detail").state, "complete");
  assert.equal(rows.find((row) => row.key === "comments").state, "partial");
  assert.equal(rows.find((row) => row.key === "attachments").state, "failed");
  assert.equal(configInferenceSourceGate(session, "correct").allowed, true);
  assert.deepEqual(configInferenceSourceGate(session, "correct").blockers, []);
  assert.ok(configInferenceSourceGate(session, "correct").warnings.some((row) => row.key === "comments"));
  assert.equal(configInferenceSourceGate(session, "insufficient").allowed, true, "信息不足标注必须允许提交");
});

test("旧 run 没有 coverage 快照时只提示 legacy，不把全部历史记录永久锁死", () => {
  const gate = configInferenceSourceGate({ prediction: { targets: [{ repositoryId: "appMarket" }] } }, "correct");
  assert.equal(gate.hasSnapshot, false);
  assert.equal(gate.status, "legacy");
  assert.equal(gate.allowed, true);
});

test("手工输入 gate 明确不适用时不把缺失的 TB 来源误判为 required blocker", () => {
  const gate = configInferenceSourceGate({
    sourceCoverageGate: { applicable: false, required: [] },
    sourceCoverage: { manual: { available: true, complete: true } },
  }, "correct");
  assert.equal(gate.hasSnapshot, true);
  assert.deepEqual(gate.blockers, []);
  assert.equal(gate.allowed, true);
  assert.equal(gate.status, "complete");
});

test("后端旧版 passed=false/missingRequired 兼容为来源告警", () => {
  const gate = configInferenceSourceGate({
    sourceCoverageGate: {
      applicable: true,
      passed: false,
      missingRequired: ["detail"],
    },
  }, "correct");
  assert.equal(gate.allowed, true);
  assert.equal(gate.status, "warning");
  assert.deepEqual(gate.blockers, []);
  assert.ok(gate.warnings.some((row) => row.key === "detail" || row.key === "backend_gate"));
});

test("跨来源冲突必须切换为纠正并逐项确认当前目标图，目标变化后确认自动失效", () => {
  const session = {
    prediction: {
      quality: {
        conflicts: {
          items: [{
            id: "source_conflict:vehicle",
            dimension: "vehicle",
            resolutionRequired: true,
            recommendedValue: "geelyp155",
            candidates: [
              { value: "geelyp155", sourceGroups: ["title"], signalIds: ["S1"] },
              { value: "geelyp162", sourceGroups: ["comment"], signalIds: ["S2"] },
            ],
          }],
        },
      },
    },
  };
  const targets = [{
    appName: "AppMarket",
    vehicle: "geelyp155",
    repositoryId: "appMarket",
    branch: "release/p155",
    flavor: "geelyp155",
    targetRole: "primary",
    order: 1,
  }];
  assert.equal(configInferenceConflictGate(session, "correct", {}, targets).allowed, false);
  assert.equal(configInferenceConflictGate(session, "insufficient", {}, targets).allowed, true);

  const fingerprint = configInferenceConflictTargetFingerprint(targets);
  const resolutions = {
    vehicle: {
      acknowledged: true,
      selectedValue: "geelyp155",
      targetFingerprint: fingerprint,
    },
  };
  const resolved = configInferenceConflictGate(session, "corrected", resolutions, targets);
  assert.equal(resolved.allowed, true);
  assert.equal(resolved.rows[0].currentValue, "geelyp155");
  assert.deepEqual(resolved.rows[0].candidates.map((row) => row.value), ["geelyp155", "geelyp162"]);

  const changed = [{ ...targets[0], vehicle: "geelyp162", branch: "release/p162" }];
  assert.equal(configInferenceConflictGate(session, "corrected", resolutions, changed).allowed, false);
});

test("confidence 未校准时明确标为启发式分，指标把旧 exactAccuracy 降级为人工同意率", () => {
  assert.deepEqual(confidencePresentation({ confidenceScore: 0.86 }), {
    calibrated: false,
    value: 0.86,
    label: "启发式匹配分",
    note: "未校准，不能解释为预测正确概率",
  });
  const calibrated = confidencePresentation({
    calibratedProbability: 0.72,
    calibration: { status: "calibrated", method: "isotonic" },
  });
  assert.equal(calibrated.label, "校准正确概率");
  assert.equal(calibrated.note, "isotonic");

  const metrics = trainingMetricSummary({ exactAccuracy: 0.91, evaluation: { targetGraphExactRate: 0.82, cases: 100 } });
  assert.equal(metrics.humanAgreementRate, 0.91);
  assert.equal(metrics.targetGraphExactRate, 0.82);
  assert.equal(metrics.evaluatedCases, 100);
  assert.equal(trainingMetricSummary({ humanAgreementRate: null, exactAccuracy: 0.66 }).humanAgreementRate, 0.66);
});

test("只有真实 calibratedProbability 才显示校准概率，方法名不能冒充概率", () => {
  const falseClaim = confidencePresentation({
    confidenceKind: "isotonic",
    confidenceScore: 0.91,
  });
  assert.equal(falseClaim.calibrated, false);
  assert.equal(falseClaim.label, "启发式匹配分");

  const probability = confidencePresentation({
    calibratedProbability: 0.87,
    confidenceScore: 0.42,
  });
  assert.equal(probability.calibrated, true);
  assert.equal(probability.value, 0.87);
});

test("annotation、approved、active、revoked 状态和兼容旧复核可稳定归一", () => {
  assert.equal(annotationGovernance({ review: { decision: "correct" } }).status, "annotation");
  assert.equal(annotationGovernance({ annotation: { id: "A1", status: "approved" } }).status, "approved");
  assert.equal(annotationGovernance({ annotation: { id: "A2", status: "serving" } }).status, "active");
  assert.equal(annotationGovernance({ annotation: { id: "A3", status: "superseded" } }).status, "revoked");
  assert.equal(annotationGovernance({ _learnedSample: { governanceStatus: "approved" } }).status, "approved");
  assert.equal(annotationGovernance({}).status, "unreviewed");
  assert.equal(
    annotationGovernance({ annotation: { updatedAt: "2026-07-29T00:00:00.000Z" } }).updatedAt,
    Date.parse("2026-07-29T00:00:00.000Z"),
  );

  const summary = governanceSummary({
    runs: [
      { review: { decision: "correct" } },
      { annotation: { status: "approved" } },
      { annotation: { status: "revoked" } },
    ],
  });
  assert.deepEqual({ annotation: summary.annotation, approved: summary.approved, revoked: summary.revoked }, {
    annotation: 1,
    approved: 1,
    revoked: 1,
  });
});

test("Key/Value 作用域禁止把机器路径写入共享值，但允许 node 本机绑定", () => {
  assert.equal(looksMachineLocalValue("D:\\workspace\\repo"), true);
  assert.equal(looksMachineLocalValue("\\\\server\\release"), true);
  assert.equal(looksMachineLocalValue("/root/private"), true);
  assert.equal(looksMachineLocalValue("checkout=/root/private"), true);
  assert.equal(looksMachineLocalValue("checkout=D:\\workspace\\repo"), true);
  assert.equal(looksMachineLocalValue("release/avatr8678"), false);

  const shared = validateKnowledgeDraft({
    actualValue: "D:\\workspace\\repo",
    scope: "project",
    scopeId: "project-1",
    reason: "迁移",
  });
  assert.equal(shared.ok, false);
  assert.match(shared.error, /本机绑定/);

  const local = validateKnowledgeDraft({
    actualValue: "D:\\workspace\\repo",
    scope: "node",
    reason: "本机 checkout",
  });
  assert.equal(local.ok, true);
  assert.equal(local.localOnly, true);
  assert.equal(local.machineBinding, true);
  assert.equal(validateKnowledgeDraft({
    actualValue: "/root/private",
    scope: "project",
    scopeId: "project-1",
    reason: "bad",
  }).ok, false);
});

test("旧 valueBinding 兼容为 project active，v2 revision 保留 scope/status/history", () => {
  const legacy = normalizeKnowledgeBinding({
    logicalKey: "ci.branch.main",
    actualValue: "main",
    revision: 3,
  }, "project-1");
  assert.equal(legacy.governanceV2, false);
  assert.equal(legacy.scope.value, "project");
  assert.equal(legacy.scopeId, "project-1");
  assert.equal(legacy.current.status, "active");

  const modern = normalizeKnowledgeBinding({
    keyId: "K1",
    logicalKey: "ci.branch.main",
    actualValue: "stale-legacy-value",
    valueRevisions: [
      { id: "V1", revision: 1, actualValue: "main", status: "retired", scope: "environment", scopeId: "prod" },
      { id: "V2", revision: 2, actualValue: "release/main", status: "active", scope: "environment", scopeId: "prod" },
    ],
  }, "project-1");
  assert.equal(modern.governanceV2, true);
  assert.equal(modern.current.id, "V2");
  assert.equal(modern.actualValue, "release/main");
  assert.equal(modern.scope.value, "environment");
  assert.equal(modern.revisions.length, 2);
  assert.equal(knowledgeScopeMeta(modern.revisions[0].scope).value, "environment");
});

test("关键词空映射是待审批 suggestion，完整映射才显示为 active", () => {
  assert.equal(keywordGovernanceStatus({ category: "", value: "" }), "suggestion");
  assert.equal(keywordGovernanceStatus({ category: "vehicle", value: "geelyp162" }), "active");
  assert.equal(keywordGovernanceStatus({ category: "vehicle", value: "geelyp162", status: "pending" }), "suggestion");
  assert.equal(keywordGovernanceStatus({ category: "vehicle", value: "geelyp162", status: "approved" }), "approved");
});

test("评测摘要没有冻结结果时不伪造完整目标图准确率", () => {
  assert.equal(evaluationSummary({}).available, false);
  const summary = evaluationSummary({
    evaluation: {
      latest: {
        id: "E1",
        datasetVersion: "gold-v1",
        status: "passed",
        evaluatedAt: "2026-07-29T00:00:00.000Z",
        metrics: { cases: 300, targetGraphExactRate: 0.97, repositoryTop3Recall: 0.99, coverage: 0.8, ece: 0.04 },
      },
    },
  });
  assert.equal(summary.available, true);
  assert.equal(summary.targetGraphExactRate, 0.97);
  assert.equal(summary.ece, 0.04);
  assert.equal(summary.evaluatedAt, Date.parse("2026-07-29T00:00:00.000Z"));
});
