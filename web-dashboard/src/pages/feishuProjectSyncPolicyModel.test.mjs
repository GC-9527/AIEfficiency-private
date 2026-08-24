import test from "node:test";
import assert from "node:assert/strict";

import {
  TB_PRIORITY_DISPLAY_NAMES,
  createPolicyCondition,
  createPolicyRule,
  createPolicyStrategy,
  createPolicyTarget,
  policyPreviewSample,
  policyConditionSummary,
  policyEntityDisplayName,
  policyRuleSummary,
  priorityMappingForUi,
  policyRoutingForUi,
  policyRulesByPriority,
  policySummary,
  policyTargetSummary,
  updatePolicyEntryConfig,
} from "./feishuProjectSyncPolicyModel.js";

test("priority labels match the Feishu P0-P3 to TB contract", () => {
  assert.deepEqual(TB_PRIORITY_DISPLAY_NAMES, {
    "-10": "较低",
    0: "普通",
    1: "紧急",
    2: "非常紧急",
  });
});

test("priority mapping rows expose the configured TB value and readable label", () => {
  assert.deepEqual(priorityMappingForUi({ mappings: { priority: { P0: 2, P1: 1, P2: 0, P3: -10 } } }), [
    { source: "P0", target: 2, label: "非常紧急" },
    { source: "P1", target: 1, label: "紧急" },
    { source: "P2", target: 0, label: "普通" },
    { source: "P3", target: -10, label: "较低" },
  ]);
});

test("policy UI model keeps configured targets, strategies, and rules", () => {
  const routing = policyRoutingForUi({
    routing: {
      enabled: true,
      defaultTargetId: "a",
      defaultStrategyId: "full",
      targets: [{ id: "a" }],
      strategies: [{ id: "full" }],
      rules: [{ id: "rule-a" }],
    },
  });
  assert.equal(routing.targets[0].id, "a");
  assert.equal(routing.strategies[0].id, "full");
  assert.equal(routing.rules[0].id, "rule-a");
});

test("policy UI model sorts rule display by priority without losing source indexes", () => {
  const ordered = policyRulesByPriority([
    { id: "low", priority: 10 },
    { id: "high", priority: 100 },
  ]);
  assert.deepEqual(ordered.map((entry) => entry.rule.id), ["high", "low"]);
  assert.deepEqual(ordered.map((entry) => entry.index), [1, 0]);
});

test("policy UI factories create complete editable records", () => {
  const target = createPolicyTarget(1);
  const strategy = createPolicyStrategy(2);
  const rule = createPolicyRule({ defaultTargetId: target.id, defaultStrategyId: strategy.id }, 3);
  assert.equal(target.id, "target-1");
  assert.equal(strategy.fields.attachments.enabled, true);
  assert.equal(rule.targetId, target.id);
  assert.deepEqual(rule.conditions, [createPolicyCondition()]);
});

test("target config updates do not overwrite sibling target fields", () => {
  const rows = updatePolicyEntryConfig([{ id: "a", config: { projectId: "p", tasklistId: "t" } }], 0, { sprintId: "s" });
  assert.deepEqual(rows[0].config, { projectId: "p", tasklistId: "t", sprintId: "s" });
});

test("preview samples derive matching input from the selected configured rule", () => {
  const normal = policyPreviewSample();
  const configured = policyPreviewSample({
    id: "module-route",
    name: "模块归属规则",
    conditions: [{
      field: "fields",
      operator: "containsAny",
      fieldKeys: ["module-key"],
      fieldNames: ["功能模块"],
      values: ["configured-value"],
    }],
  });
  assert.deepEqual(normal.fields, []);
  assert.equal(configured.id, "preview-module-route");
  assert.deepEqual(configured.fields, [{
    field_key: "module-key",
    field_name: "功能模块",
    field_value: "configured-value",
  }]);

  const regexTitle = policyPreviewSample({
    id: "d8cdc-route",
    conditions: [{ field: "item.title", operator: "regex", values: ["^D8CDC-"] }],
  });
  assert.equal(regexTitle.title, "D8CDC-1001 预览值");

  const negativeModule = policyPreviewSample({
    id: "non-spotify-route",
    conditions: [{
      field: "fields",
      operator: "notEquals",
      fieldKeys: ["module-key"],
      fieldNames: ["功能模块"],
      values: ["spotify"],
    }],
  });
  assert.notEqual(negativeModule.fields[0].field_value.toLocaleLowerCase(), "spotify");
});

test("policy summary reports enabled objects and selected defaults", () => {
  const summary = policySummary({ routing: {
    defaultTargetId: "a",
    defaultStrategyId: "full",
    targets: [{ id: "a" }, { id: "off", enabled: false }],
    strategies: [{ id: "full" }],
    rules: [{ id: "one" }, { id: "off", enabled: false }],
  } });
  assert.equal(summary.enabledRules, 1);
  assert.equal(summary.targets, 1);
  assert.equal(summary.strategies, 1);
  assert.equal(summary.defaultTarget.id, "a");
});

test("policy condition summaries explain the D8CDC branches in business language", () => {
  assert.equal(policyConditionSummary({
    field: "item.title",
    operator: "regex",
    values: ["^D8CDC-"],
    caseSensitive: true,
  }), "标题以“D8CDC-”开头（区分大小写）");
  assert.equal(policyConditionSummary({
    field: "fields",
    fieldNames: ["功能模块"],
    operator: "equals",
    values: ["spotify"],
  }), "功能模块等于 “spotify”（不区分大小写）");
  assert.equal(policyConditionSummary({
    field: "fields",
    fieldNames: ["功能模块"],
    operator: "notEquals",
    values: ["spotify"],
  }), "功能模块不等于 “spotify”（不区分大小写）");
});

test("policy readable summaries prefer names and never fall back to opaque IDs", () => {
  const routing = {
    targets: [{ id: "69ddf5744b9a04cb08c4c2fa", name: "双8平台应用市场" }],
    strategies: [{ id: "strategy-internal", name: "8155 标题策略" }],
  };
  const rule = {
    id: "rule-internal",
    name: "D8CDC 非 Spotify",
    targetId: "69ddf5744b9a04cb08c4c2fa",
    strategyId: "strategy-internal",
    conditions: [{ field: "fields", fieldNames: ["功能模块"], operator: "notEquals", values: ["spotify"] }],
  };
  assert.deepEqual(policyRuleSummary(rule, routing), {
    name: "D8CDC 非 Spotify",
    conditionText: "功能模块不等于 “spotify”（不区分大小写）",
    targetName: "双8平台应用市场",
    strategyName: "8155 标题策略",
  });
  assert.equal(policyEntityDisplayName({ id: "69ddf5744b9a04cb08c4c2fa" }, "未解析任务列表"), "未解析任务列表");
  assert.deepEqual(policyTargetSummary({
    inheritLegacy: false,
    config: {
      projectPathName: "平台组件 / 双8平台应用市场",
      tasklistName: "双8平台应用市场",
      sprintName: "Ava_应用市场_8155_待规划",
      defaultExecutorName: "徐博超",
    },
  }), {
    projectName: "平台组件 / 双8平台应用市场",
    tasklistName: "双8平台应用市场",
    sprintName: "Ava_应用市场_8155_待规划",
    executorName: "徐博超",
  });
});
