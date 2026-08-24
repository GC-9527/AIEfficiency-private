import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import { DEFAULT_NEW_STORY_TAB, NEW_STORY_TABS } from "./newStoryPanelModel.mjs";

test("新建故事点面板把从 TB 单新建放在首个并设为默认 Tab", () => {
  assert.equal(NEW_STORY_TABS[0]?.id, "tb");
  assert.equal(NEW_STORY_TABS[0]?.label, "从 TB 单新建");
  assert.equal(DEFAULT_NEW_STORY_TAB, "tb");
});

test("新建故事点面板保留其它创建入口且不重复", () => {
  assert.deepEqual(NEW_STORY_TABS.map((item) => item.id), [
    "tb",
    "blank",
    "backup",
    "git-commit",
    "git-commit-batch",
    "history",
  ]);
  assert.equal(new Set(NEW_STORY_TABS.map((item) => item.id)).size, NEW_STORY_TABS.length);
});

test("TB 复合输入框只由圆角容器呈现焦点环", () => {
  const source = fs.readFileSync(new URL("./TbTaskEntryModal.jsx", import.meta.url), "utf8");
  assert.match(
    source,
    /focus-within:border-cyan-500\/70 focus-within:ring-2 focus-within:ring-cyan-500\/10/,
    "复合输入框外层必须保留可见的圆角焦点态",
  );
  assert.match(
    source,
    /data-testid="tb-task-entry-input"[\s\S]{0,180}?className="[^"]*focus-visible:outline-none[^"]*"|className="[^"]*focus-visible:outline-none[^"]*"[\s\S]{0,180}?data-testid="tb-task-entry-input"/,
    "内部原生 input 必须抑制重复的直角焦点轮廓",
  );
});
