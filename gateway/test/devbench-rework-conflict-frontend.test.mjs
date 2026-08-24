import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

// 源码契约：Git 提交整理的冲突处理卡片（前端）必须提供 Android Studio 打开入口，
// 让用户一键在 IDE 里解决 squash merge 冲突。

const panel = fs.readFileSync(
  new URL("../../web-dashboard/src/pages/devbench/GitCommitReworkPanel.jsx", import.meta.url),
  "utf8",
);

test("冲突处理卡片：import StudioBtn", () => {
  assert.match(
    panel,
    /import\s+StudioBtn\s+from\s+["']\.\/StudioBtn\.jsx["']/,
    "GitCommitReworkPanel 必须 import StudioBtn",
  );
});

test("冲突处理卡片：squash 冲突 needDecision 分支渲染 StudioBtn", () => {
  // 定位真正的 `{decision.type === "conflict" && (` JSX 分支（外层 className 也含 "conflict" 关键字，故找精确 token）
  const conflictBranchOpen = "{decision.type === \"conflict\" && (";
  const idx = panel.indexOf(conflictBranchOpen);
  assert.ok(idx > 0, "找不到 conflict JSX 分支开始");
  const slice = panel.slice(idx, idx + 5000);
  assert.match(
    slice,
    /<StudioBtn[\s\S]*?path=\{decision\.tmpDir\}[\s\S]*?\/>/,
    "冲突卡片必须用 decision.tmpDir 渲染 <StudioBtn>（compact 模式）",
  );
});

test("冲突处理卡片：失败保留 tmpDir 的提示里也提供 StudioBtn", () => {
  const idx = panel.indexOf("failDetail.tmpDir");
  assert.ok(idx > 0, "找不到 failDetail.tmpDir 渲染点");
  const slice = panel.slice(idx, idx + 1500);
  assert.match(
    slice,
    /<StudioBtn[\s\S]*?path=\{failDetail\.tmpDir\}[\s\S]*?\/>/,
    "非 CONFLICT 失败但保留的 worktree 也要提供 AS 打开入口，方便排查",
  );
});