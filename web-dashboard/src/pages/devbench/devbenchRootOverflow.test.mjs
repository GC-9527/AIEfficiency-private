import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

// devbench 顶层容器必须能横向收缩 + 兜底裁剪，避免内部宽内容把视口右侧的悬浮按钮
// （StoryTab 里 `right: 12px` 的「展开工程」按钮等）挤出可见区域。
// 根因：flex 子项 min-width 默认 auto，会被长内容撑大；父级 main 再 overflow-hidden 把右侧裁掉。

const SRC = fs.readFileSync(new URL("./index.jsx", import.meta.url), "utf8");
// 锁定 devbench 顶层 <div className> —— 唯一同时含 bg-[#0f0f10] + flex + flex-col
function getDevbenchRootClassName() {
  // 找含 bg-[#0f0f10] 的 <div className="...">，再校验含 flex/flex-col
  const re = /<div\s+className="([^"]*bg-\[#0f0f10\][^"]*)"\s*>/g;
  let m;
  while ((m = re.exec(SRC))) {
    const cls = m[1];
    if (/\bflex\b/.test(cls) && /\bflex-col\b/.test(cls)) return cls;
  }
  return null;
}

test("devbench 顶层 div 必须带 min-w-0（避免 flex 子项被内容撑大撑出视口）", () => {
  const cls = getDevbenchRootClassName();
  assert.ok(cls, "devbench 顶层 <div className> 必须包含 bg-[#0f0f10] 与 flex flex-col");
  assert.match(cls, /\bmin-w-0\b/,
    `devbench 顶层 <div> 必须包含 min-w-0（防止 flex 默认 min-width:auto 被内容撑大）。当前 className: "${cls}"`);
});

test("devbench 顶层 div 必须带 overflow-x-hidden（兜底裁剪，防止右侧悬浮按钮被裁）", () => {
  const cls = getDevbenchRootClassName();
  assert.ok(cls, "devbench 顶层 <div className> 必须包含 bg-[#0f0f10] 与 flex flex-col");
  assert.match(cls, /\boverflow-x-hidden\b/,
    `devbench 顶层 <div> 必须包含 overflow-x-hidden（裁掉横向溢出，右侧悬浮按钮留在视口内）。当前 className: "${cls}"`);
});

test("devbench 顶层 div 必须带 h-full（撑满 keep-alive 容器）", () => {
  const cls = getDevbenchRootClassName();
  assert.ok(cls, "devbench 顶层 <div className> 必须包含 bg-[#0f0f10] 与 flex flex-col");
  assert.match(cls, /\bh-full\b/,
    `devbench 顶层 <div> 必须包含 h-full（撑满 App.jsx 中 absolute inset-0 的 keep-alive 容器）。当前 className: "${cls}"`);
});
