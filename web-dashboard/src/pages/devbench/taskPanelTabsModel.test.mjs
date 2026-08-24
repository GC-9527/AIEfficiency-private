import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import {
  TASK_PANEL_ACTIVE_TAB_STORAGE_KEY,
  TASK_PANEL_TAB_IDS,
  TASK_PANEL_TABS,
  normalizeTaskPanelActiveTab,
  readTaskPanelActiveTab,
  saveTaskPanelActiveTab,
} from "./taskPanelTabsModel.mjs";

test("故事点任务面板永久保留待办与 TB 单两个 Tab", () => {
  assert.deepEqual(
    TASK_PANEL_TABS.map(({ id, label }) => ({ id, label })),
    [
      { id: "todo", label: "待办列表" },
      { id: "tbpool", label: "TB单列表" },
    ],
  );
  assert.equal(TASK_PANEL_TAB_IDS.TODO, "todo");
  assert.equal(TASK_PANEL_TAB_IDS.TB_POOL, "tbpool");
});

test("任务面板 Tab 缓存只接受合同中声明的 Tab", () => {
  assert.equal(normalizeTaskPanelActiveTab("tbpool"), "tbpool");
  assert.equal(normalizeTaskPanelActiveTab("todo"), "todo");
  assert.equal(normalizeTaskPanelActiveTab("removed-tab"), "todo");

  const values = new Map([[TASK_PANEL_ACTIVE_TAB_STORAGE_KEY, "tbpool"]]);
  const storage = {
    getItem: (key) => values.get(key),
    setItem: (key, value) => values.set(key, value),
  };
  assert.equal(readTaskPanelActiveTab(storage), "tbpool");
  assert.equal(saveTaskPanelActiveTab("todo", storage), "todo");
  assert.equal(values.get(TASK_PANEL_ACTIVE_TAB_STORAGE_KEY), "todo");
});

test("TaskPanel JSX 使用集中式双 Tab 合同和持久化接口", () => {
  const source = fs.readFileSync(
    new URL("./TaskPanel.jsx", import.meta.url),
    "utf8",
  );
  assert.match(source, /TASK_PANEL_TABS\.map\(\(tab\) =>/);
  assert.match(source, /useState\(readTaskPanelActiveTab\)/);
  assert.match(source, /saveTaskPanelActiveTab\(activeTab\)/);
  assert.doesNotMatch(source, /const TASK_TAB_CACHE_KEY/);
});
