import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  DEFAULT_FEISHU_PRIORITY_MAPPING,
  DEFAULT_SYNC_POLICY_CONFIG,
  applyResolvedSyncPolicy,
  applySyncPayloadStrategy,
  normalizeSyncPolicyConfig,
  resolveSyncPolicy,
  validateSyncPolicyConfig,
} from "../../features/FeiShuProjects/src/sync-policy-engine.js";
import {
  getFeishuProjectSyncConfig,
  getFeishuProjectSyncReadiness,
  previewFeishuProjectSyncPolicy,
} from "../../features/FeiShuProjects/src/gateway-sync-service.js";

function baseConfig() {
  return {
    teambition: {
      projectId: "project-default",
      tasklistId: "tasklist-default",
      sprintId: "sprint-default",
      defaultExecutorId: "executor-default",
    },
    sync: {
      includeComments: true,
      includeAttachments: true,
      attachmentMode: "upload",
    },
    routing: {
      defaultTargetId: "legacy-default",
      defaultStrategyId: "legacy-default",
      targets: [
        {
          id: "business-a",
          name: "业务线 A",
          system: "teambition",
          config: {
            projectId: "project-a",
            tasklistId: "tasklist-a",
            sprintId: "sprint-a",
          },
        },
        {
          id: "business-b",
          name: "业务线 B",
          system: "teambition",
          config: {
            projectId: "project-b",
            tasklistId: "tasklist-b",
            sprintId: "sprint-b",
          },
        },
      ],
      strategies: [
        {
          id: "preserve-managed-fields",
          name: "保留人工字段",
          fields: {
            title: { enabled: false, mode: "preserve" },
            description: { enabled: false, mode: "preserve" },
            attachments: { enabled: false, mode: "skip" },
            comments: { enabled: false, mode: "skip" },
            status: { enabled: false, mode: "preserve" },
            tags: { enabled: false, mode: "preserve" },
            priority: { enabled: false, mode: "preserve" },
            assignee: { enabled: false, mode: "preserve" },
            fieldMappings: { enabled: false, mode: "preserve" },
          },
        },
      ],
      rules: [
        {
          id: "project-a-high",
          name: "Project A 优先规则",
          priority: 200,
          sourceSystem: "feishu_project",
          conditions: [{ field: "source.projectKey", operator: "equals", values: ["project-a"] }],
          targetId: "business-a",
          strategyId: "preserve-managed-fields",
        },
        {
          id: "business-line-b",
          name: "业务线 B 规则",
          priority: 100,
          sourceSystem: "feishu_project",
          conditions: [{ field: "fields.business_line", operator: "containsAny", values: ["B-Line"] }],
          targetId: "business-b",
          strategyId: "legacy-default",
        },
      ],
    },
  };
}

test("policy engine resolves two different configured routes by priority and custom field", () => {
  const config = baseConfig();
  const projectDecision = resolveSyncPolicy({
    config,
    source: { system: "feishu_project", projectKey: "project-a" },
    item: {
      sourceProjectKey: "project-a",
      fields: [{ key: "business_line", displayValue: "B-Line" }],
    },
  });
  assert.equal(projectDecision.matchedRule.id, "project-a-high");
  assert.equal(projectDecision.target.id, "business-a");
  assert.equal(projectDecision.target.config.tasklistId, "tasklist-a");
  assert.equal(projectDecision.strategy.id, "preserve-managed-fields");

  const businessDecision = resolveSyncPolicy({
    config,
    source: { system: "feishu_project", projectKey: "project-other" },
    item: {
      sourceProjectKey: "project-other",
      fields: [{ key: "business_line", displayValue: "B-Line / cockpit" }],
    },
  });
  assert.equal(businessDecision.matchedRule.id, "business-line-b");
  assert.equal(businessDecision.target.id, "business-b");
  assert.equal(businessDecision.target.config.projectId, "project-b");
});

test("policy engine falls back to the existing teambition target when no rule matches", () => {
  const decision = resolveSyncPolicy({
    config: baseConfig(),
    source: { system: "feishu_project", projectKey: "unmatched" },
    item: { sourceProjectKey: "unmatched", fields: [] },
  });
  assert.equal(decision.matched, false);
  assert.equal(decision.fallback, true);
  assert.equal(decision.target.id, "legacy-default");
  assert.equal(decision.target.config.tasklistId, "tasklist-default");
});

test("built-in D8CDC routes select the two 8155 targets and leave unrelated tickets unchanged", () => {
  const preview = (title, module, priority = "P1") => previewFeishuProjectSyncPolicy({
    id: `${title}-${module}`,
    space_key: "intelligentspace",
    work_item_type_key: "bug_double_eight",
    title,
    priority,
    fields: [{ field_key: "function_module", field_name: "功能模块", field_value: module }],
  }, {
    config: {
      sync: { enforceSourceScope: false, readScope: { enabled: false, filters: [] } },
    },
    action: "create",
  });

  const spotify = preview("D8CDC-1001 播放失败", "SpOtIfY", "P0");
  assert.equal(spotify.policyDecision.matchedRule.id, "builtin-d8cdc-spotify");
  assert.equal(spotify.policyDecision.target.id, "double-eight-spotify");
  assert.equal(spotify.policyDecision.target.config.tasklistId, "6952674a8440a2928c3b737e");
  assert.equal(spotify.policyDecision.target.config.sprintId, "689c245b34a93a18aba2b2eb");
  assert.equal(spotify.payload.content, "【缺陷转载8155】【阿维塔】D8CDC-1001播放失败");
  assert.equal(spotify.payload.priority, 2);
  assert.deepEqual(spotify.policyDecision.trace[0].conditions[1].fieldNames, ["功能模块"]);
  assert.equal(spotify.policyDecision.trace[0].conditions[1].caseSensitive, false);

  const appMarket = preview("D8CDC-1002 安装失败", "应用市场", "P3");
  assert.equal(appMarket.policyDecision.matchedRule.id, "builtin-d8cdc-non-spotify");
  assert.equal(appMarket.policyDecision.target.id, "double-eight-appmarket");
  assert.equal(appMarket.policyDecision.target.config.tasklistId, "69ddf581904cbb651c6722e6");
  assert.equal(appMarket.policyDecision.target.config.sprintId, "6a2bbc262e6e708c4fc1b0d9");
  assert.equal(appMarket.payload.content, "【缺陷转载8155】【阿维塔】D8CDC-1002安装失败");
  assert.equal(appMarket.payload.priority, -10);

  const spotifyLikeButNotEqual = preview("D8CDC-1005 套餐失败", "spotify premium");
  assert.equal(spotifyLikeButNotEqual.policyDecision.matchedRule.id, "builtin-d8cdc-non-spotify");
  assert.equal(spotifyLikeButNotEqual.policyDecision.target.id, "double-eight-appmarket");

  const existingSpotify = preview("CARB-1003 播放失败", "spotify");
  assert.equal(existingSpotify.policyDecision.matchedRule.id, "builtin-module-spotify");
  assert.equal(existingSpotify.policyDecision.target.id, "spotify-8678");
  assert.equal(existingSpotify.payload.content.includes("缺陷转载8155"), false);

  const defaultTicket = preview("CARB-1004 安装失败", "应用市场");
  assert.equal(defaultTicket.policyDecision.matched, false);
  assert.equal(defaultTicket.policyDecision.target.id, "legacy-default");
  assert.equal(defaultTicket.payload.content.includes("缺陷转载8155"), false);
});

test("all P0-P3 priority mappings are canonical even when persisted legacy values exist", () => {
  assert.deepEqual(DEFAULT_FEISHU_PRIORITY_MAPPING, { P0: 2, P1: 1, P2: 0, P3: -10 });
  const config = getFeishuProjectSyncConfig({
    mappings: { priority: { P0: 0, P1: 1, P2: 2, P3: 2, custom: 7 } },
  });
  assert.deepEqual(config.mappings.priority, { P0: 2, P1: 1, P2: 0, P3: -10, custom: 7 });
  assert.equal(DEFAULT_SYNC_POLICY_CONFIG.routing.rules[0].id, "builtin-d8cdc-spotify");
});

test("disabling policy routing skips every rule and keeps the configured default path", () => {
  const config = baseConfig();
  config.routing.enabled = false;
  const decision = resolveSyncPolicy({
    config,
    source: { system: "feishu_project", projectKey: "project-a" },
    item: { sourceProjectKey: "project-a", fields: [] },
  });
  assert.equal(decision.enabled, false);
  assert.equal(decision.matched, false);
  assert.equal(decision.trace.length, 0);
  assert.equal(decision.target.id, "legacy-default");
  assert.equal(decision.strategy.id, "legacy-default");
});

test("strategy controls update payload and child synchronization without changing create title invariant", () => {
  const decision = resolveSyncPolicy({
    config: baseConfig(),
    source: { system: "feishu_project", projectKey: "project-a" },
    item: { sourceProjectKey: "project-a", fields: [] },
  });
  const effective = applyResolvedSyncPolicy(baseConfig(), decision);
  assert.equal(effective.sync.includeComments, false);
  assert.equal(effective.sync.includeAttachments, false);

  const payload = {
    content: "source title",
    note: "source description",
    taskflowstatusId: "status",
    tagIds: ["tag"],
    priority: 1,
    executorId: "executor",
    customfields: [{ id: "field", value: "value" }],
  };
  const updated = applySyncPayloadStrategy(payload, "update", decision);
  assert.deepEqual(updated.payload, {});
  const created = applySyncPayloadStrategy(payload, "create", decision);
  assert.equal(created.payload.content, "source title");
  assert.equal(created.payload.note, undefined);
  assert.equal(created.effects.find((effect) => effect.field === "title").action, "required-on-create");
});

test("policy validation rejects missing target references and incomplete TB targets", () => {
  const config = baseConfig();
  config.routing.rules.push({
    id: "broken-reference",
    priority: 999,
    conditions: [{ field: "item.title", operator: "equals", values: ["x"] }],
    targetId: "missing-target",
    strategyId: "legacy-default",
  });
  const validation = validateSyncPolicyConfig(config);
  assert.equal(validation.valid, false);
  assert.ok(validation.errors.some((entry) => entry.path.endsWith("targetId")));
});

test("policy validation rejects duplicate IDs and references to disabled entries", () => {
  const config = baseConfig();
  config.routing.targets.push({ ...config.routing.targets[0] });
  config.routing.strategies[0].enabled = false;
  const validation = validateSyncPolicyConfig(config);
  assert.equal(validation.valid, false);
  assert.ok(validation.errors.some((entry) => entry.message.includes("ID 重复")));
  assert.ok(validation.errors.some((entry) => entry.path.endsWith("strategyId") && entry.message.includes("已停用")));
  const readiness = getFeishuProjectSyncReadiness(config);
  assert.equal(readiness.policyValidation.valid, false);
  assert.ok(readiness.policyValidation.errors.some((entry) => entry.message.includes("ID 重复")));
});

test("normalization keeps configured default rules configurable and ordered", () => {
  const config = baseConfig();
  config.routing.rules = [{ id: "builtin-module-spotify", enabled: false, priority: 999 }];
  const routing = normalizeSyncPolicyConfig(config);
  const spotify = routing.rules.find((rule) => rule.id === "builtin-module-spotify");
  assert.equal(spotify.enabled, false);
  assert.equal(spotify.priority, 999);
  assert.equal(routing.strategies.find((strategy) => strategy.id === "legacy-default").fields.tags.mode, "replace");
});

test("Feishu to TB adapter applies two configured policy hits to the actual payload preview", () => {
  const config = baseConfig();
  config.sync.enforceSourceScope = false;
  config.sync.readScope = { enabled: false, filters: [] };
  const projectPreview = previewFeishuProjectSyncPolicy({
    id: "policy-preview-project-a",
    space_key: "project-a",
    work_item_type_key: "bug",
    title: "Project A ticket",
    fields: [],
  }, { config, action: "update" });
  assert.equal(projectPreview.policyDecision.matchedRule.id, "project-a-high");
  assert.equal(projectPreview.payload.projectId, "project-a");
  assert.equal(projectPreview.payload.tasklistId, "tasklist-a");
  assert.equal(projectPreview.payload.content, undefined);

  const businessPreview = previewFeishuProjectSyncPolicy({
    id: "policy-preview-business-b",
    space_key: "project-other",
    work_item_type_key: "bug",
    title: "Business B ticket",
    fields: [{ field_key: "business_line", field_name: "业务线", field_value: "B-Line" }],
  }, { config, action: "create" });
  assert.equal(businessPreview.policyDecision.matchedRule.id, "business-line-b");
  assert.equal(businessPreview.payload.projectId, "project-b");
  assert.equal(businessPreview.payload.tasklistId, "tasklist-b");
});

test("TB destination literals live only in the JSON policy configuration", () => {
  const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
  const defaults = JSON.parse(readFileSync(new URL("../../features/FeiShuProjects/src/default-sync-policy.json", import.meta.url), "utf8"));
  const ids = new Set([
    defaults.legacyTeambition.projectId,
    defaults.legacyTeambition.tasklistId,
    defaults.legacyTeambition.sprintId,
    ...defaults.routing.targets.flatMap((target) => [target.config?.projectId, target.config?.tasklistId, target.config?.sprintId]),
  ].filter(Boolean));
  const codePaths = [
    "features/FeiShuProjects/src/gateway-sync-service.js",
    "gateway/services/config.js",
    "web-dashboard/src/pages/FeishuProjectSync.jsx",
    "web-dashboard/src/pages/FeishuSyncPolicyPanel.jsx",
  ];
  for (const relativePath of codePaths) {
    const source = readFileSync(`${repoRoot}${relativePath}`, "utf8");
    for (const id of ids) assert.equal(source.includes(id), false, `${relativePath} hardcodes ${id}`);
  }
});
