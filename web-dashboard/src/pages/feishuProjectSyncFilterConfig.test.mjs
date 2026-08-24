import assert from "node:assert/strict";
import test from "node:test";
import {
  buildFeishuFilterBackup,
  filterFeishuFieldChoices,
  filterValueChoices,
  nextFilterForSelectedField,
  parseFeishuFilterBackup,
} from "./feishuProjectSyncFilterConfig.js";

const people = ["阳荣峰", "徐博超", "彭俊维", "冯国梁"];
const ownerFilter = {
  kind: "role",
  fieldKey: "role_bd6222",
  fieldName: "问题责任人（角色）",
  operator: "containsAny",
  values: people,
};
const statusField = {
  kind: "field",
  key: "status",
  name: "状态",
  options: [
    { value: "processing", label: "处理中" },
    { value: "resolved", label: "已解决" },
  ],
};

test("飞书字段搜索支持名称、Key 和角色类型且忽略大小写", () => {
  const fields = [
    statusField,
    { kind: "field", key: "TITLE", name: "标题", type: "text" },
    { kind: "role", key: "role_bd6222", name: "问题责任人", type: "user" },
  ];
  assert.deepEqual(filterFeishuFieldChoices(fields, "状态").map((field) => field.key), ["status"]);
  assert.deepEqual(filterFeishuFieldChoices(fields, "title").map((field) => field.key), ["TITLE"]);
  assert.deepEqual(filterFeishuFieldChoices(fields, "问题 角色").map((field) => field.key), ["role_bd6222"]);
  assert.equal(filterFeishuFieldChoices(fields, "   ").length, fields.length);
});

test("筛选条件从人员角色切换为状态时清空旧人员值", () => {
  const patch = nextFilterForSelectedField(ownerFilter, statusField, { containsAny: "存在选项属于" });
  assert.deepEqual(patch.values, []);
  assert.equal(patch.fieldName, "状态");
  assert.deepEqual(filterValueChoices(statusField, { ...ownerFilter, ...patch }).map((item) => item.label), ["处理中", "已解决"]);
});

test("状态选项会过滤历史错误人员值", () => {
  const choices = filterValueChoices(statusField, { ...ownerFilter, kind: "field", fieldKey: "status", fieldName: "状态" });
  assert.deepEqual(choices.map((item) => item.label), ["处理中", "已解决"]);
});

test("筛选备份只包含 readScope 并可还原", () => {
  const config = {
    feishu: { pluginSecret: "不得进入备份" },
    sync: { readScope: { enabled: true, match: "all", filters: [ownerFilter] } },
  };
  const backup = buildFeishuFilterBackup(config, "2026-07-18T00:00:00.000Z");
  assert.doesNotMatch(JSON.stringify(backup), /不得进入备份/);
  assert.deepEqual(parseFeishuFilterBackup(backup).readScope.filters[0].values, people);
});
