import assert from "node:assert/strict";
import test from "node:test";
import {
  clampProjectControlsPosition,
  parseProjectControlsPosition,
  projectControlsExpandedStorageKey,
  projectControlsPositionStorageKey,
  readProjectControlsExpanded,
  writeProjectControlsExpanded,
} from "./projectControlsFloatingModel.mjs";

// node:test 环境无 localStorage，注入内存版 mock（与浏览器语义一致：string/null）
const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};

test("工程悬浮按钮按故事点隔离保存位置", () => {
  assert.equal(
    projectControlsPositionStorageKey("story-a"),
    "devbench_project_controls_position:story-a",
  );
  assert.notEqual(
    projectControlsPositionStorageKey("story-a"),
    projectControlsPositionStorageKey("story-b"),
  );
});

test("工程操作区展开状态按故事点隔离持久化（展开后刷新保持，Git 分支/worktree 分支不消失）", () => {
  assert.equal(
    projectControlsExpandedStorageKey("story-a"),
    "devbench_project_controls_expanded:story-a",
  );
  // 未记录 → null（由调用方按默认收起兜底）
  assert.equal(readProjectControlsExpanded("story-untouched"), null);
  // 展开 → 读回 true；收起 → 读回 false
  writeProjectControlsExpanded("story-a", true);
  assert.equal(readProjectControlsExpanded("story-a"), true);
  writeProjectControlsExpanded("story-a", false);
  assert.equal(readProjectControlsExpanded("story-a"), false);
  // 清除 → 回退默认
  writeProjectControlsExpanded("story-a", null);
  assert.equal(readProjectControlsExpanded("story-a"), null);
  // 隔离：不同故事点互不影响
  writeProjectControlsExpanded("story-b", true);
  assert.equal(readProjectControlsExpanded("story-a"), null);
  assert.equal(readProjectControlsExpanded("story-b"), true);
});

test("工程悬浮按钮只接受有效的坐标缓存", () => {
  assert.deepEqual(parseProjectControlsPosition('{"x":120,"y":36}'), { x: 120, y: 36 });
  assert.equal(parseProjectControlsPosition('{"x":"bad","y":36}'), null);
  assert.equal(parseProjectControlsPosition("{"), null);
});

test("工程悬浮按钮拖动位置始终限制在故事点页面可见范围", () => {
  const bounds = {
    containerWidth: 500,
    containerHeight: 300,
    itemWidth: 76,
    itemHeight: 44,
  };
  assert.deepEqual(clampProjectControlsPosition({ x: -100, y: -20 }, bounds), { x: 12, y: 12 });
  assert.deepEqual(clampProjectControlsPosition({ x: 999, y: 999 }, bounds), { x: 412, y: 244 });
  assert.deepEqual(clampProjectControlsPosition({ x: 140, y: 80 }, bounds), { x: 140, y: 80 });
});

test("故事点页面小于按钮时仍返回可见坐标", () => {
  assert.deepEqual(clampProjectControlsPosition(
    { x: 80, y: 80 },
    { containerWidth: 40, containerHeight: 30, itemWidth: 76, itemHeight: 44 },
  ), { x: 0, y: 0 });
});
