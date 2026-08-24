import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  feishuFilterPresetConfigPatch,
  normalizeFeishuFilterPreset,
  readFeishuFilterPreset,
  saveFeishuFilterPreset,
} from "../../features/FeiShuProjects/src/feishu-filter-preset.js";

const OWNER_FILTER = {
  id: "problem-owner-role",
  enabled: true,
  kind: "role",
  fieldKey: "role_bd6222",
  fieldName: "问题责任人（角色）",
  operator: "containsAny",
  values: ["阳荣峰", "徐博超"],
};

test("飞书筛选预置独立写盘、读取并生成冷启动配置补丁", () => {
  const dir = mkdtempSync(join(tmpdir(), "feishu-filter-preset-"));
  const path = join(dir, "preset.json");
  const saved = saveFeishuFilterPreset({
    readScope: { enabled: true, match: "any", filters: [OWNER_FILTER] },
  }, path);

  assert.equal(saved.readScope.match, "any");
  assert.deepEqual(saved.requiredAssigneeKeywords, ["阳荣峰", "徐博超"]);
  assert.match(readFileSync(path, "utf8"), /feishu-project-sync-filter-preset/);

  const loaded = readFeishuFilterPreset(path);
  assert.deepEqual(loaded.readScope.filters[0].values, ["阳荣峰", "徐博超"]);
  assert.deepEqual(feishuFilterPresetConfigPatch(loaded), {
    sync: {
      readScope: loaded.readScope,
      requiredAssigneeKeywords: ["阳荣峰", "徐博超"],
    },
  });
});

test("飞书筛选预置拒绝空备份，避免清空有效规则", () => {
  assert.throws(() => normalizeFeishuFilterPreset({ readScope: { filters: [] } }), /筛选条件不能为空/);
});
