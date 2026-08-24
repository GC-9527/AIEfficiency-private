import assert from "node:assert/strict";
import test from "node:test";
import {
  prioritizeConfigInferenceCases,
  selectConfigInferenceAnnotationBatch,
} from "../services/devbench/machine-learn/active-learning.js";

function row(id, {
  confidence = 0.9,
  margin = 0.8,
  vehicle = "common",
  appName = "AppMarket",
  conflicts = 0,
  ood = false,
  incomplete = false,
} = {}) {
  return {
    id,
    projectId: "p1",
    updatedAt: Date.UTC(2026, 0, 1),
    prediction: {
      confidenceScore: confidence,
      margin,
      conflictCount: conflicts,
      ood,
      targets: [{ appName, vehicle, repositoryId: `repo-${vehicle}` }],
    },
    sourceCoverage: {
      comments: incomplete ? { available: true, complete: false } : { available: true, complete: true },
    },
  };
}

test("主动学习优先不确定、低 margin、冲突、OOD 和来源不完整案例", () => {
  const ranked = prioritizeConfigInferenceCases([
    row("certain"),
    row("uncertain", { confidence: 0.5, margin: 0.05 }),
    row("conflict", { confidence: 0.8, conflicts: 2 }),
    row("ood", { confidence: 0.8, ood: true, incomplete: true }),
  ], { now: Date.UTC(2026, 0, 2) });
  assert.equal(ranked.at(-1).id, "certain");
  assert.equal(ranked[0].activeLearning.reasons.includes("uncertain") || ranked[0].activeLearning.reasons.includes("ood"), true);
  assert.equal(ranked.find((item) => item.id === "conflict").activeLearning.reasons.includes("conflict"), true);
  assert.equal(ranked.find((item) => item.id === "ood").activeLearning.reasons.includes("source_incomplete"), true);
});

test("已复核和已占用案例默认不会进入训练批次", () => {
  const reviewed = { ...row("reviewed"), review: { decision: "correct" } };
  const claimed = { ...row("claimed"), claimed: true };
  const available = row("available", { confidence: 0.5 });
  assert.deepEqual(
    prioritizeConfigInferenceCases([reviewed, claimed, available]).map((item) => item.id),
    ["available"],
  );
});

test("已有 pending annotation 的案例不会重复进入主动学习队列", () => {
  const rows = prioritizeConfigInferenceCases([
    { ...row("pending-annotation"), annotation: { status: "pending" } },
    row("fresh"),
  ]);
  assert.deepEqual(rows.map((row) => row.id), ["fresh"]);
});

test("批次按 slice 限流，避免高频车型挤掉稀有车型", () => {
  const common = Array.from({ length: 8 }, (_, index) => row(`common-${index}`, {
    confidence: 0.5,
    margin: 0,
    vehicle: "common",
  }));
  const rare = row("rare", { confidence: 0.7, vehicle: "rare" });
  const selected = selectConfigInferenceAnnotationBatch([...common, rare], {
    limit: 4,
    maxPerSlice: 2,
    now: Date.UTC(2026, 0, 2),
  });
  assert.equal(selected.filter((item) => item.prediction.targets[0].vehicle === "common").length, 2);
  assert.equal(selected.some((item) => item.id === "rare"), true);
});

test("同一输入排序稳定，便于并发 claim 和审计回放", () => {
  const input = [row("b", { confidence: 0.5 }), row("a", { confidence: 0.5 })];
  const first = prioritizeConfigInferenceCases(input, { now: Date.UTC(2026, 0, 2) }).map((item) => item.id);
  const second = prioritizeConfigInferenceCases(input, { now: Date.UTC(2026, 0, 2) }).map((item) => item.id);
  assert.deepEqual(first, second);
});
