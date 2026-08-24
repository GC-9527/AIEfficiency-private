import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  ATLAS_CLIENT_TARGETS,
  atlasActionDisabled,
  atlasApplyConfirmation,
  atlasApplyPresentation,
  atlasClientLabel,
  atlasDetailsVisible,
  atlasTogglePlan,
} from "./atlasSetupModel.mjs";

test("Atlas 一键设置覆盖四个目标工具并生成明确确认文案", () => {
  assert.deepEqual(ATLAS_CLIENT_TARGETS.map((item) => item.id), ["codex", "claude", "opencode", "hermes"]);
  assert.equal(atlasClientLabel("opencode"), "OpenCode");
  assert.match(atlasApplyConfirmation("claude", "zai-org/glm-5.1"), /Claude Code/);
  assert.match(atlasApplyConfirmation("claude", "zai-org/glm-5.1"), /全局配置/);
  assert.match(atlasApplyConfirmation("claude", "zai-org/glm-5.1"), /自动备份/);
});

test("Atlas 一键设置结果区分成功、无需备份与安装指引", () => {
  const success = atlasApplyPresentation("codex", {
    success: true,
    data: { ok: true, hint: "已完成", paths: ["config.toml"], backups: ["one", "two"] },
  });
  assert.deepEqual(success, {
    ok: true,
    text: "已完成 · 已备份 2 个原配置文件",
    installGuide: null,
    paths: ["config.toml"],
    backups: ["one", "two"],
  });

  const fresh = atlasApplyPresentation("opencode", {
    success: true,
    data: { ok: true, hint: "已完成", backups: [] },
  });
  assert.match(fresh.text, /无需备份/);

  const missing = atlasApplyPresentation("hermes", {
    success: false,
    error: "未检测到 Hermes Agent",
    data: { installGuide: { command: "install hermes", url: "https://example.invalid" } },
  });
  assert.equal(missing.ok, false);
  assert.equal(missing.installGuide.command, "install hermes");
  assert.deepEqual(missing.paths, []);
});

test("Atlas 按钮在非管理员、请求中或缺少必填配置时禁用", () => {
  const ready = { isAdmin: true, loading: false, apiKey: "key", baseUrl: "https://api.atlascloud.ai/v1", model: "zai-org/glm-5.1" };
  assert.equal(atlasActionDisabled(ready), false);
  assert.equal(atlasActionDisabled({ ...ready, isAdmin: false }), true);
  assert.equal(atlasActionDisabled({ ...ready, loading: true }), true);
  assert.equal(atlasActionDisabled({ ...ready, apiKey: "" }), true);
});

test("Atlas 勾选后本地展开不依赖服务端 enabled 回读", () => {
  assert.deepEqual(atlasTogglePlan({ checked: true, isAdmin: false }), {
    locallyExpanded: true,
    shouldPersist: false,
    shouldRequestAdminLogin: true,
  });
  assert.deepEqual(atlasTogglePlan({ checked: true, isAdmin: true }), {
    locallyExpanded: true,
    shouldPersist: true,
    shouldRequestAdminLogin: false,
  });
  assert.equal(atlasDetailsVisible({ enabled: false, locallyExpanded: true }), true);
  assert.equal(atlasDetailsVisible({ enabled: true, locallyExpanded: false }), true);
  assert.equal(atlasDetailsVisible({ enabled: false, locallyExpanded: false }), false);
});

test("设置页接入 AI 模型命名、Atlas 官方端点与四个一键按钮", () => {
  const settings = readFileSync(new URL("../Settings.jsx", import.meta.url), "utf8");
  const storyTab = readFileSync(new URL("../devbench/StoryTab.jsx", import.meta.url), "utf8");
  const enginePicker = readFileSync(new URL("../devbench/enginePickerModel.mjs", import.meta.url), "utf8");
  const panel = readFileSync(new URL("./AtlasClientSetupPanel.jsx", import.meta.url), "utf8");
  assert.match(settings, /Section title="AI 模型（OpenAI 兼容）"/);
  assert.doesNotMatch(settings, /Section title="API 引擎/);
  assert.match(settings, /Atlas Cloud Coding Plan/);
  assert.match(settings, /readOnly=\{engineId === "atlas"\}/);
  for (const label of ["Codex", "Claude Code", "OpenCode", "Hermes"]) {
    assert.ok(ATLAS_CLIENT_TARGETS.some((item) => item.label === label));
  }
  assert.match(settings, /<AtlasClientSetupPanel/);
  assert.match(settings, /aria-expanded=\{detailsVisible\}/);
  assert.match(settings, /\{detailsVisible && \(/);
  assert.match(settings, /toggleApiEngine\(engineId, e\.target\.checked\)/);
  assert.match(panel, /一键设置到 \$\{target\.label\}/);
  assert.match(panel, /查看写入与备份位置/);
  assert.match(storyTab, /from "\.\/enginePickerModel\.mjs"/);
  for (const [engineId, label] of [
    ["claude-atlas", "Claude Code（Atlas Coding Plan）"],
    ["codex-atlas", "Codex CLI（Atlas Coding Plan）"],
    ["hermes-atlas", "Hermes（Atlas Coding Plan）"],
  ]) {
    assert.match(enginePicker, new RegExp(`id: "${engineId}"`));
    assert.match(enginePicker, new RegExp(label.replace(/[()]/g, "\\$&")));
  }
});
