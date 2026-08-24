import { test } from "node:test";
import assert from "node:assert/strict";
import {
  PROMPT_COMPATIBILITY_OVERLAY_STAGES,
  PROMPT_COMPATIBILITY_OVERLAY_VARIANT,
  composePromptCompatibilityOverlay,
  normalizePromptCompatibilityRollout,
  promptCompatibilityOverlayFatalReason,
  resolvePromptCompatibilityOverlay,
} from "../services/devbench/workflow-v2/prompt-compatibility-overlay.js";

function config(promptCompatibilityRollout, enabled = true) {
  return {
    workflowV2: {
      featureFlags: { promptCompatibilityOverlay: enabled },
      promptCompatibilityRollout,
    },
  };
}

const enabledRollout = {
  percentage: 100,
  salt: "overlay-tests",
  storyIds: ["story-a"],
  providers: ["codex"],
  stages: [...PROMPT_COMPATIBILITY_OVERLAY_STAGES],
};

test("Prompt overlay 生产默认全量命中且仍可显式关闭", () => {
  const disabled = resolvePromptCompatibilityOverlay({
    config: config(enabledRollout, false),
    storyId: "story-a",
    provider: "codex",
    stageId: "REPAIR",
  });
  assert.equal(disabled.selected, false);
  assert.equal(disabled.reason, "feature_flag_disabled");

  const empty = resolvePromptCompatibilityOverlay({
    config: config({ percentage: 100 }),
    storyId: "story-a",
    provider: "codex",
    stageId: "REPAIR",
  });
  assert.equal(empty.selected, true);
  assert.equal(empty.reason, "enabled");
  assert.equal(promptCompatibilityOverlayFatalReason("rollout_scope_empty"), false);
});

test("Prompt overlay 对 story/provider/stage 稳定灰度并拒绝未知配置", () => {
  const input = {
    config: config(enabledRollout),
    storyId: "story-a",
    provider: "CODEX",
    stageId: "repair",
  };
  const first = resolvePromptCompatibilityOverlay(input);
  const second = resolvePromptCompatibilityOverlay(structuredClone(input));
  assert.deepEqual(first, second);
  assert.equal(first.selected, true);
  assert.equal(first.promptVariant, PROMPT_COMPATIBILITY_OVERLAY_VARIANT);
  assert.equal(first.stageId, "REPAIR");
  assert.equal(first.rolloutHash.length, 64);
  assert.equal(resolvePromptCompatibilityOverlay({ ...input, storyId: "story-b" }).reason, "story_not_allowlisted");
  assert.equal(resolvePromptCompatibilityOverlay({ ...input, provider: "claude" }).reason, "provider_not_allowlisted");
  assert.equal(resolvePromptCompatibilityOverlay({ ...input, stageId: "REPORT_SHORT" }).selected, true);

  for (const invalid of [
    { ...enabledRollout, percentage: 101 },
    { ...enabledRollout, stages: ["UNKNOWN"] },
    { ...enabledRollout, providers: [1] },
    { ...enabledRollout, extra: true },
  ]) {
    assert.equal(normalizePromptCompatibilityRollout(invalid).valid, false);
    assert.equal(resolvePromptCompatibilityOverlay({
      config: config(invalid),
      storyId: "story-a",
      provider: "codex",
      stageId: "REPAIR",
    }).reason, "rollout_config_invalid");
  }
});

test("五阶段 Prompt-only 模板稳定且不引入 Full V2 执行要求", () => {
  for (const stageId of PROMPT_COMPATIBILITY_OVERLAY_STAGES) {
    const first = composePromptCompatibilityOverlay(stageId);
    const second = composePromptCompatibilityOverlay(stageId);
    assert.deepEqual(first, second);
    assert.equal(first.stageId, stageId);
    assert.equal(first.promptVariant, PROMPT_COMPATIBILITY_OVERLAY_VARIANT);
    assert.equal(first.templateSha256.length, 64);
    assert.match(first.rule, /^## 阶段：/u);
    assert.match(first.rule, new RegExp(`（${stageId}）`));
    assert.doesNotMatch(first.rule, /<CONTEXT_JSON>|executionProfile|stageToolPolicy|receipt|attestation|healthChecks/i);
  }
});
