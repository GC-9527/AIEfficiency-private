import assert from "node:assert/strict";
import test from "node:test";
import {
  extractStructuredConfigEvidence,
  structuredEvidenceSummary,
} from "../services/devbench/machine-learn/evidence-extractor.js";

test("抽取 Git、Gradle、包名、堆栈、源码路径和车型硬证据并保留来源", () => {
  const evidence = extractStructuredConfigEvidence({
    snapshotAt: "2026-01-02T00:00:00Z",
    title: "P155 assembleGeelyp155ProdRelease 构建失败",
    description: "仓库 https://git.example/appmarket.git branch: release/p155",
    commentItems: [{
      id: "comment-1",
      createdAt: "2026-01-01T12:00:00Z",
      text: "FATAL at com.example.app.MainActivity.onCreate(MainActivity.kt:10)",
    }],
    attachments: [{
      id: "log-1",
      name: "stack.log",
      text: "app/src/main/java/com/example/app/MainActivity.kt",
      availableAt: "2026-01-01T13:00:00Z",
    }],
  });
  const kinds = new Set(evidence.map((row) => row.kind));
  assert.equal(kinds.has("git_url"), true);
  assert.equal(kinds.has("git_branch"), true);
  assert.equal(kinds.has("gradle_task"), true);
  assert.equal(kinds.has("stack_frame"), true);
  assert.equal(kinds.has("source_path"), true);
  assert.equal(kinds.has("vehicle_hint"), true);
  assert.equal(evidence.every((row) => row.untrusted && row.availableAt && row.extractorVersion), true);
  assert.equal(evidence.find((row) => row.sourceId === "comment-1").sourceType, "comment");
});

test("否定语境进入 negative evidence，不与正向车型混合", () => {
  const evidence = extractStructuredConfigEvidence({
    snapshotAt: "2026-01-02T00:00:00Z",
    title: "不是 P162，是 P155 应用市场问题",
  });
  const summary = structuredEvidenceSummary(evidence);
  assert.deepEqual(summary.byKind.vehicle_hint.negative, ["P162"]);
  assert.deepEqual(summary.byKind.vehicle_hint.positive, ["P155"]);
});

test("晚于 inferenceAt 的解决后评论被时间截断", () => {
  const evidence = extractStructuredConfigEvidence({
    snapshotAt: "2026-01-02T00:00:00Z",
    title: "启动失败",
    commentItems: [
      { id: "before", createdAt: "2026-01-01T00:00:00Z", text: "branch: release/current" },
      { id: "future", createdAt: "2026-01-03T00:00:00Z", text: "branch: leaked/final-answer" },
    ],
  });
  assert.equal(evidence.some((row) => row.value === "release/current"), true);
  assert.equal(evidence.some((row) => row.value === "leaked/final-answer"), false);
});

test("缺失或非法快照/证据时点 fail closed，不把当前时间伪装成历史证据", () => {
  assert.deepEqual(extractStructuredConfigEvidence({
    title: "branch: leaked/no-snapshot",
  }), []);
  const evidence = extractStructuredConfigEvidence({
    snapshotAt: "2026-01-02T00:00:00Z",
    title: "branch: release/core",
    commentItems: [
      { id: "missing", text: "branch: leaked/missing-time" },
      { id: "invalid", availableAt: "not-a-time", text: "branch: leaked/invalid-time" },
    ],
    attachments: [{
      id: "missing-attachment-time",
      text: "branch: leaked/attachment",
    }],
  });
  assert.equal(evidence.some((row) => row.value === "release/core"), true);
  assert.equal(evidence.some((row) => row.value.startsWith("leaked/")), false);
});

test("结构化摘要按证据类型去重", () => {
  const summary = structuredEvidenceSummary([
    { kind: "git_branch", value: "main", negated: false },
    { kind: "git_branch", value: "main", negated: false },
    { kind: "git_branch", value: "old", negated: true },
  ]);
  assert.deepEqual(summary.byKind.git_branch, { positive: ["main"], negative: ["old"] });
});
