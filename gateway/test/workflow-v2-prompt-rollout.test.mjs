import { test } from "node:test";
import assert from "node:assert/strict";
import {
  normalizePromptV2Rollout,
  resolveCompatibilityStage,
  resolvePromptV2Rollout,
} from "../services/devbench/workflow-v2/prompt-v2-rollout.js";

function config(promptV2Rollout = { percentage: 100 }) {
  return { workflowV2: { featureFlags: { promptV2: true }, promptV2Rollout } };
}

test("rollout 对 story/provider 稳定，provider 归一化且白名单生效", () => {
  const input = {
    config: config({
      percentage: 100,
      salt: "m3-test",
      storyIds: ["story-b", "story-a", "story-a"],
      providers: ["Codex", "CLAUDE", "codex"],
    }),
    storyId: "story-a",
    provider: "CODEX",
  };
  const first = resolvePromptV2Rollout(input);
  const second = resolvePromptV2Rollout(structuredClone(input));
  assert.deepEqual(first, second);
  assert.equal(first.selected, true);
  assert.equal(first.provider, "codex");
  assert.ok(first.bucket >= 0 && first.bucket < 100);
  assert.equal(resolvePromptV2Rollout({ ...input, storyId: "story-c" }).reason, "story_not_allowlisted");
  assert.equal(resolvePromptV2Rollout({ ...input, provider: "gemini" }).reason, "provider_not_allowlisted");
});

test("rollout 的 feature flag、非法配置和缺失身份均 fail closed", () => {
  const disabled = resolvePromptV2Rollout({
    config: { workflowV2: { featureFlags: { promptV2: false } } },
    storyId: "story-a",
    provider: "codex",
  });
  assert.equal(disabled.selected, false);
  assert.equal(disabled.reason, "feature_flag_disabled");

  for (const invalid of [
    { percentage: -1 },
    { percentage: 101 },
    { percentage: 50.5 },
    { salt: "" },
    { storyIds: "story-a" },
    { providers: [1] },
  ]) {
    const normalized = normalizePromptV2Rollout(invalid);
    assert.equal(normalized.valid, false, JSON.stringify(invalid));
    assert.equal(resolvePromptV2Rollout({
      config: config(invalid),
      storyId: "story-a",
      provider: "codex",
    }).reason, "rollout_config_invalid");
  }
  assert.equal(resolvePromptV2Rollout({ config: config(), storyId: "", provider: "codex" }).reason, "identity_missing");
});

test("compatibility stage 映射五个修复工作流边界并覆盖组队故事点", () => {
  assert.equal(resolveCompatibilityStage({ workflowKind: "triage", tab: {} }), "TRIAGE");
  assert.equal(resolveCompatibilityStage({ workflowKind: "verify", tab: {} }), "VERIFY_EXECUTE");
  assert.equal(resolveCompatibilityStage({ workflowKind: "report", tab: { reportMode: "short" } }), "REPORT_SHORT");
  assert.equal(resolveCompatibilityStage({ workflowKind: "report", tab: { reportMode: "expert" } }), "REPORT_EXPERT");
  assert.equal(resolveCompatibilityStage({ workflowKind: "repair", tab: { workflow: { phase: "verifying" } } }), "REPAIR");
  assert.equal(resolveCompatibilityStage({ workflowKind: "", tab: { workflow: { phase: "fixing" } } }), "REPAIR");
  assert.equal(resolveCompatibilityStage({
    workflowKind: "triage",
    tab: { groupId: "group-a", workflow: { phase: "triaging" } },
  }), "TRIAGE");
  assert.equal(resolveCompatibilityStage({
    workflowKind: "verify",
    tab: { groupId: "group-a", workflow: { phase: "verifying" } },
  }), "VERIFY_EXECUTE");
  assert.equal(resolveCompatibilityStage({ workflowKind: "code_review", tab: { workflow: { phase: "fixing" } } }), null);
  assert.equal(resolveCompatibilityStage({
    workflowKind: "",
    tab: { workMode: "code_review", workflow: { phase: "fixing" } },
  }), null);
  assert.equal(resolveCompatibilityStage({
    workflowKind: "triage",
    tab: { reviewContext: { kind: "git_commit" }, workflow: { phase: "triaging" } },
  }), null);
  assert.equal(resolveCompatibilityStage({ workflowKind: "chat", tab: { workflow: { phase: "triaging" } } }), null);
});

test("compatibility stage 只让未分类的内部调用跟随 phase，自由聊天不被阶段模板覆盖", () => {
  assert.equal(resolveCompatibilityStage({
    workflowKind: "",
    tab: { workflow: { phase: "verifying" } },
  }), "VERIFY_EXECUTE");
  // 未分类的内部兼容调用仍可跟随断点恢复 VERIFY；显式自由消息必须保留用户本轮意图。
  assert.equal(resolveCompatibilityStage({
    workflowKind: "",
    tab: { workflow: { phase: "verify_blocked" } },
  }), "VERIFY_EXECUTE");
  assert.equal(resolveCompatibilityStage({
    workflowKind: "follow_up",
    tab: { workflow: { phase: "verify_blocked" } },
  }), null);
  assert.equal(resolveCompatibilityStage({
    workflowKind: "chat",
    tab: { workflow: { phase: "verify_blocked" } },
  }), null);
  assert.equal(resolveCompatibilityStage({
    workflowKind: "chat",
    tab: { workflow: { phase: "fixing" } },
  }), "REPAIR");
  assert.equal(resolveCompatibilityStage({
    workflowKind: "",
    tab: { workflow: { phase: "reporting" }, reportMode: "short" },
  }), "REPORT_SHORT");
  assert.equal(resolveCompatibilityStage({
    workflowKind: "",
    tab: { workflow: { phase: "reporting" }, reportMode: "expert" },
  }), "REPORT_EXPERT");
  assert.equal(resolveCompatibilityStage({
    workflowKind: "",
    tab: { workflow: { phase: "reporting" } },
    reportMode: "expert",
  }), "REPORT_EXPERT");
  assert.equal(resolveCompatibilityStage({
    workflowKind: "chat",
    tab: { workflow: { phase: "reporting" }, reportMode: "expert" },
  }), null);
  // group_fixed 与 fixing 共享 REPAIR 模板
  assert.equal(resolveCompatibilityStage({
    workflowKind: "",
    tab: { groupId: "group-a", workflow: { phase: "group_fixed" } },
  }), "REPAIR");
  // 工作流之外的相位仍走 null，由上层回退 legacy（不静默吞掉未知 phase）
  assert.equal(resolveCompatibilityStage({
    workflowKind: "",
    tab: { workflow: { phase: "testable" } },
  }), null);
  assert.equal(resolveCompatibilityStage({
    workflowKind: "",
    tab: { workflow: { phase: "rejected" } },
  }), null);
});
