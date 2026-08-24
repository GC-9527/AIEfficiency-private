import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "workflow-v2-config-"));
const configPath = path.join(tempRoot, "gateway.json");
process.env.GATEWAY_CONFIG_PATH = configPath;
fs.writeFileSync(configPath, JSON.stringify({
  workflowV2: {
    mode: "full-v2",
    featureFlags: {
      promptV2: true,
      structuredResultsV2: "true",
      evidenceReceiptsRequired: true,
      promptCompatibilityOverlay: false,
      unknownFlag: true,
    },
    promptV2Rollout: {
      percentage: 100,
      storyIds: ["legacy-story"],
      providers: ["codex"],
    },
    activeExecutionProfileId: "legacy-profile",
    executionProfiles: [{ id: "legacy-profile" }],
  },
}), "utf8");

const configService = await import("../services/config.js");
const RETIRED_FIELDS = ["promptV2Rollout", "activeExecutionProfileId", "executionProfiles"];

test("启动时把历史 Full V2 配置收敛为 Prompt-only", () => {
  const workflow = configService.getConfig().workflowV2;
  assert.equal(workflow.mode, "prompt-only");
  assert.equal(workflow.productionPromptVersion, configService.PROMPT_ONLY_PRODUCTION_CONFIG_VERSION);
  assert.deepEqual(workflow.featureFlags, { promptCompatibilityOverlay: true });
  assert.equal(workflow.promptCompatibilityRollout.percentage, 100);
  assert.deepEqual(workflow.promptCompatibilityRollout.storyIds, []);
  assert.deepEqual(workflow.promptCompatibilityRollout.providers, []);
  assert.deepEqual(workflow.promptCompatibilityRollout.stages, []);
  assert.deepEqual(Object.keys(workflow.featureFlags), ["promptCompatibilityOverlay"]);
  for (const field of RETIRED_FIELDS) assert.equal(Object.hasOwn(workflow, field), false);
  assert.equal(Object.hasOwn(workflow.featureFlags, "promptV2"), false);
  assert.equal(Object.hasOwn(workflow.featureFlags, "structuredResultsV2"), false);
  assert.equal(Object.hasOwn(workflow.featureFlags, "evidenceReceiptsRequired"), false);
  const migrated = JSON.parse(fs.readFileSync(configPath, "utf8")).workflowV2;
  assert.deepEqual(migrated, workflow, "启动迁移必须从磁盘移除历史 Full V2 字段");
});

test("配置更新忽略 Full V2 开关、rollout 与 execution profile", () => {
  const patch = {
    workflowV2: {
      featureFlags: {
        promptV2: true,
        structuredResultsV2: true,
        evidenceReceiptsRequired: true,
        tbSyncSaga: true,
        promptCompatibilityOverlay: false,
      },
      promptV2Rollout: { percentage: 100, storyIds: ["reactivate"] },
      activeExecutionProfileId: "reactivate",
      executionProfiles: [{ id: "reactivate" }],
    },
  };
  const originalPatch = structuredClone(patch);
  const updated = configService.updateConfig(patch);
  assert.deepEqual(patch, originalPatch, "updateConfig 不得修改调用方入参");
  assert.equal(updated.workflowV2.mode, "prompt-only");
  assert.equal(updated.workflowV2.productionPromptVersion, configService.PROMPT_ONLY_PRODUCTION_CONFIG_VERSION);
  assert.deepEqual(updated.workflowV2.featureFlags, { promptCompatibilityOverlay: false });
  for (const field of RETIRED_FIELDS) assert.equal(Object.hasOwn(updated.workflowV2, field), false);

  const persisted = JSON.parse(fs.readFileSync(configPath, "utf8"));
  assert.equal(persisted.workflowV2.mode, "prompt-only");
  assert.deepEqual(persisted.workflowV2.featureFlags, { promptCompatibilityOverlay: false });
  for (const field of RETIRED_FIELDS) assert.equal(Object.hasOwn(persisted.workflowV2, field), false);
});

test("getConfig/getConfigValue/updateConfig 返回值不暴露 Prompt-only 嵌套引用", () => {
  configService.updateConfig({
    workflowV2: {
      featureFlags: { promptCompatibilityOverlay: true },
      promptCompatibilityRollout: {
        percentage: 100,
        storyIds: ["story-a"],
        providers: ["codex"],
        stages: ["REPAIR"],
      },
    },
  });
  const fromConfig = configService.getConfig();
  fromConfig.workflowV2.featureFlags.promptCompatibilityOverlay = false;
  fromConfig.workflowV2.promptCompatibilityRollout.storyIds.push("leak");
  assert.equal(configService.getConfig().workflowV2.featureFlags.promptCompatibilityOverlay, true);
  assert.deepEqual(configService.getConfig().workflowV2.promptCompatibilityRollout.storyIds, ["story-a"]);

  const fromValue = configService.getConfigValue("workflowV2");
  fromValue.featureFlags.promptCompatibilityOverlay = false;
  fromValue.promptCompatibilityRollout.providers.push("leak");
  assert.equal(configService.getConfigValue("workflowV2").featureFlags.promptCompatibilityOverlay, true);
  assert.deepEqual(configService.getConfigValue("workflowV2").promptCompatibilityRollout.providers, ["codex"]);
});

test("Prompt-only overlay 可选定向灰度并隔离数组引用", () => {
  const patch = {
    workflowV2: {
      featureFlags: { promptCompatibilityOverlay: true },
      promptCompatibilityRollout: {
        percentage: 100,
        salt: "overlay-test",
        storyIds: ["story-b", "story-a", "story-a"],
        providers: ["CODEX", "codex"],
        stages: ["repair", "TRIAGE", "repair"],
      },
    },
  };
  const original = structuredClone(patch);
  const updated = configService.updateConfig(patch);
  assert.deepEqual(patch, original);
  assert.equal(updated.workflowV2.featureFlags.promptCompatibilityOverlay, true);
  assert.deepEqual(updated.workflowV2.promptCompatibilityRollout.storyIds, ["story-a", "story-b"]);
  assert.deepEqual(updated.workflowV2.promptCompatibilityRollout.providers, ["codex"]);
  assert.deepEqual(updated.workflowV2.promptCompatibilityRollout.stages, ["REPAIR", "TRIAGE"]);

  const fromConfig = configService.getConfig();
  fromConfig.workflowV2.promptCompatibilityRollout.stages.push("VERIFY_EXECUTE");
  const fromValue = configService.getConfigValue("workflowV2");
  fromValue.promptCompatibilityRollout.storyIds.push("leak");
  assert.deepEqual(configService.getConfig().workflowV2.promptCompatibilityRollout.stages, ["REPAIR", "TRIAGE"]);
  assert.deepEqual(configService.getConfig().workflowV2.promptCompatibilityRollout.storyIds, ["story-a", "story-b"]);
});

test("非法 Prompt-only overlay 灰度持久化为 0% fail-closed 配置", () => {
  const updated = configService.updateConfig({
    workflowV2: { promptCompatibilityRollout: { stages: ["UNKNOWN_STAGE"] } },
  });
  assert.equal(updated.workflowV2.promptCompatibilityRollout.valid, false);
  assert.equal(updated.workflowV2.promptCompatibilityRollout.percentage, 0);
  const persisted = JSON.parse(fs.readFileSync(configPath, "utf8"));
  assert.equal(persisted.workflowV2.promptCompatibilityRollout.valid, false);
  assert.equal(persisted.workflowV2.promptCompatibilityRollout.percentage, 0);
});

test("config.example.json 只公开生产默认开启的 Prompt-only overlay", () => {
  const example = JSON.parse(fs.readFileSync(new URL("../config.example.json", import.meta.url), "utf8"));
  assert.equal(example.workflowV2.mode, "prompt-only");
  assert.equal(example.workflowV2.productionPromptVersion, configService.PROMPT_ONLY_PRODUCTION_CONFIG_VERSION);
  assert.deepEqual(example.workflowV2.featureFlags, configService.DEFAULT_WORKFLOW_V2_FEATURE_FLAGS);
  for (const field of RETIRED_FIELDS) assert.equal(Object.hasOwn(example.workflowV2, field), false);
  assert.deepEqual(
    example.workflowV2.promptCompatibilityRollout,
    configService.DEFAULT_WORKFLOW_V2_PROMPT_COMPATIBILITY_ROLLOUT,
  );
});

test("普通故事 Flavor 路由不再接入 Full V2 Build catalog gate", () => {
  const source = fs.readFileSync(new URL("../routes/devbench.js", import.meta.url), "utf8");
  const start = source.indexOf('router.post("/tabs/:id/flavor"');
  const end = source.indexOf('router.get("/tabs/:id/branches"', start);
  assert.ok(start >= 0 && end > start, "必须找到普通 Flavor 路由");
  const handler = source.slice(start, end);
  assert.doesNotMatch(handler, /workflow-v2|assertBuildFlavorCatalogBinding/);
  assert.match(handler, /store\.setTabFlavor|reconfigureOrRequestWorktreeRebuild/);
});
