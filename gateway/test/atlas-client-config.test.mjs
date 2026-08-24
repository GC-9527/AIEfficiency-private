import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  ATLAS_CLAUDE_ENGINE_ID,
  ATLAS_CODEX_ENGINE_ID,
  ATLAS_DEFAULT_MODEL,
  ATLAS_HERMES_ENGINE_ID,
  ATLAS_OPENAI_BASE_URL,
  applyAtlasToClient,
  buildClaudeAtlasSpawnEnv,
  buildCodexAtlasSpawnEnv,
  buildHermesAtlasSpawnEnv,
  getAtlasClientPaths,
  isAtlasStoryEngine,
  mergeAtlasIntoClaudeSettings,
  mergeAtlasIntoCodexToml,
  mergeAtlasIntoOpenCodeConfig,
  mergeDotEnv,
} from "../services/atlas-client-config.js";

function tempHome(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-client-config-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return home;
}

function write(filePath, text) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, text, "utf8");
}

const credentials = {
  apiKey: "atlas-test-secret",
  baseUrl: ATLAS_OPENAI_BASE_URL,
  model: ATLAS_DEFAULT_MODEL,
};

test("Atlas 故事点引擎按 Claude Code、Codex CLI 与 Hermes 三种真实客户端区分", (t) => {
  const home = tempHome(t);
  assert.deepEqual([
    ATLAS_CLAUDE_ENGINE_ID,
    ATLAS_CODEX_ENGINE_ID,
    ATLAS_HERMES_ENGINE_ID,
  ], ["claude-atlas", "codex-atlas", "hermes-atlas"]);
  for (const engine of ["claude-atlas", "codex-atlas", "hermes-atlas"]) {
    assert.equal(isAtlasStoryEngine(engine), true);
  }

  const claude = buildClaudeAtlasSpawnEnv({ KEEP_ME: "yes", ANTHROPIC_API_KEY: "wrong" }, { ...credentials, home });
  assert.equal(claude.env.KEEP_ME, "yes");
  assert.equal(claude.env.ANTHROPIC_AUTH_TOKEN, credentials.apiKey);
  assert.equal(claude.env.ANTHROPIC_API_KEY, undefined);
  assert.equal(claude.env.ANTHROPIC_BASE_URL, "https://api.atlascloud.ai");
  assert.match(claude.configDir, /\.claude-atlas$/);

  const codex = buildCodexAtlasSpawnEnv({ KEEP_ME: "yes" }, { ...credentials, home });
  assert.equal(codex.env.KEEP_ME, "yes");
  assert.match(codex.env.CODEX_HOME, /\.codex-atlas$/);
  const codexConfig = fs.readFileSync(path.join(codex.configDir, "config.toml"), "utf8");
  assert.match(codexConfig, /model_provider = "atlas_coding_plan"/);
  assert.match(codexConfig, /wire_api = "responses"/);
  assert.doesNotMatch(codexConfig, /wire_api = "chat"/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(codex.configDir, "auth.json"), "utf8")).OPENAI_API_KEY, credentials.apiKey);

  const hermes = buildHermesAtlasSpawnEnv({ KEEP_ME: "yes" }, { ...credentials, home });
  assert.equal(hermes.env.KEEP_ME, "yes");
  assert.equal(hermes.env.OPENAI_API_KEY, credentials.apiKey);
  assert.match(hermes.env.HERMES_HOME, /\.hermes-atlas$/);
  const hermesConfig = fs.readFileSync(path.join(hermes.configDir, "config.yaml"), "utf8");
  assert.match(hermesConfig, /provider: custom/);
  assert.match(hermesConfig, /base_url: "https:\/\/api\.atlascloud\.ai\/v1"/);
  assert.match(hermesConfig, /default: "zai-org\/glm-5\.1"/);
});

test("Codex TOML 合并保留其它配置且重复执行不产生重复 Atlas provider", () => {
  const existing = `model = "old"\nmodel_provider = "other"\nmodel_reasoning_effort = "high"\n\n[model_providers.other]\nbase_url = "https://other.invalid/v1"\n\n[model_providers.atlas_coding_plan]\nbase_url = "https://stale.invalid"\n`;
  const first = mergeAtlasIntoCodexToml(existing, credentials);
  const second = mergeAtlasIntoCodexToml(first, credentials);
  assert.match(second, /model_provider = "atlas_coding_plan"/);
  assert.match(second, /model = "zai-org\/glm-5\.1"/);
  assert.match(second, /model_reasoning_effort = "high"/);
  assert.match(second, /\[model_providers\.other\]/);
  assert.match(second, /base_url = "https:\/\/api\.atlascloud\.ai\/v1"/);
  assert.match(second, /wire_api = "responses"/);
  assert.doesNotMatch(second, /wire_api = "chat"/);
  assert.equal((second.match(/\[model_providers\.atlas_coding_plan\]/g) || []).length, 1);
  assert.doesNotMatch(second, /stale\.invalid/);
});

test("Claude 与 OpenCode 合并保留无关字段并按 Atlas 官方协议写入", () => {
  const claude = mergeAtlasIntoClaudeSettings({
    permissions: { allow: ["Read"] },
    env: { KEEP_ME: "yes", ANTHROPIC_API_KEY: "previous-provider-key" },
  }, credentials);
  assert.deepEqual(claude.permissions, { allow: ["Read"] });
  assert.equal(claude.env.KEEP_ME, "yes");
  assert.equal(claude.env.ANTHROPIC_BASE_URL, "https://api.atlascloud.ai");
  assert.equal(claude.env.ANTHROPIC_AUTH_TOKEN, credentials.apiKey);
  assert.equal(claude.env.ANTHROPIC_API_KEY, undefined);
  assert.equal(claude.env.ANTHROPIC_MODEL, ATLAS_DEFAULT_MODEL);

  const openCode = mergeAtlasIntoOpenCodeConfig({
    theme: "dark",
    provider: { keep: { npm: "keep-package", options: { baseURL: "https://keep.invalid" } } },
  }, credentials);
  assert.equal(openCode.theme, "dark");
  assert.equal(openCode.provider.keep.npm, "keep-package");
  assert.equal(openCode.model, `atlascloud/${ATLAS_DEFAULT_MODEL}`);
  assert.equal(openCode.provider.atlascloud.options.baseURL, ATLAS_OPENAI_BASE_URL);
  assert.equal(openCode.provider.atlascloud.options.apiKey, credentials.apiKey);
});

test("Codex/Claude/OpenCode 写入使用临时 home、创建备份且响应不泄露 API Key", async (t) => {
  const home = tempHome(t);
  const paths = getAtlasClientPaths(home);
  write(paths.codexConfig, `model_reasoning_effort = "max"\n`);
  write(paths.codexAuth, `${JSON.stringify({ auth_mode: "chatgpt", tokens: { access_token: "keep" } }, null, 2)}\n`);
  write(paths.claudeSettings, `${JSON.stringify({
    permissions: { allow: ["Read"] },
    env: { KEEP_ME: "yes", ANTHROPIC_API_KEY: "previous-provider-key" },
  }, null, 2)}\n`);
  write(paths.openCodeConfig, `${JSON.stringify({ theme: "dark", provider: { keep: { name: "Keep" } } }, null, 2)}\n`);

  const opts = { home, now: () => new Date("2026-08-20T04:00:00.000Z") };
  for (const tool of ["codex", "claude", "opencode"]) {
    const result = await applyAtlasToClient(tool, credentials, opts);
    assert.equal(result.ok, true, `${tool}: ${result.error || ""}`);
    assert.ok(result.backups.length >= 1);
    assert.equal(JSON.stringify(result).includes(credentials.apiKey), false);
    for (const backup of result.backups) assert.equal(fs.existsSync(backup), true);
  }

  const codexAuth = JSON.parse(fs.readFileSync(paths.codexAuth, "utf8"));
  assert.equal(codexAuth.auth_mode, "chatgpt");
  assert.equal(codexAuth.tokens.access_token, "keep");
  assert.equal(codexAuth.OPENAI_API_KEY, credentials.apiKey);
  assert.match(fs.readFileSync(paths.codexConfig, "utf8"), /model_reasoning_effort = "max"/);
  const claudeSettings = JSON.parse(fs.readFileSync(paths.claudeSettings, "utf8"));
  assert.deepEqual(claudeSettings.permissions, { allow: ["Read"] });
  assert.equal(claudeSettings.env.KEEP_ME, "yes");
  assert.equal(claudeSettings.env.ANTHROPIC_AUTH_TOKEN, credentials.apiKey);
  assert.equal(claudeSettings.env.ANTHROPIC_API_KEY, undefined);
  assert.equal(JSON.parse(fs.readFileSync(paths.openCodeConfig, "utf8")).theme, "dark");
});

test("无效 Atlas 地址与损坏的客户端 JSON 均 fail closed", async (t) => {
  const home = tempHome(t);
  const paths = getAtlasClientPaths(home);
  const invalidHost = await applyAtlasToClient("claude", { ...credentials, baseUrl: "https://evil.invalid/v1" }, { home });
  assert.equal(invalidHost.ok, false);
  assert.match(invalidHost.error, /官方地址/);
  assert.equal(fs.existsSync(paths.claudeSettings), false);

  write(paths.openCodeConfig, "{ broken json");
  const before = fs.readFileSync(paths.openCodeConfig, "utf8");
  const broken = await applyAtlasToClient("opencode", credentials, { home });
  assert.equal(broken.ok, false);
  assert.match(broken.error, /解析失败/);
  assert.equal(fs.readFileSync(paths.openCodeConfig, "utf8"), before);
});

test("Hermes 通过官方 config set 写非敏感字段，Key 单独合并到 .env", async (t) => {
  const home = tempHome(t);
  const paths = getAtlasClientPaths(home);
  write(paths.hermesConfig, "model:\n  default: old-model\n  provider: old\n");
  write(paths.hermesEnv, "KEEP_ME=yes\nOPENAI_API_KEY=old-key\nOPENAI_API_KEY=duplicate\n");
  const calls = [];
  const run = async (_command, args) => {
    calls.push(args);
    if (args[0] === "--version") return { stdout: "Hermes 1.0\n", stderr: "" };
    if (args.join(" ") === "config path") return { stdout: `${paths.hermesConfig}\n`, stderr: "" };
    if (args.join(" ") === "config env-path") return { stdout: `${paths.hermesEnv}\n`, stderr: "" };
    return { stdout: "", stderr: "" };
  };

  const result = await applyAtlasToClient("hermes", credentials, {
    home,
    run,
    hermesCommand: "hermes-test",
    now: () => new Date("2026-08-20T04:00:00.000Z"),
  });
  assert.equal(result.ok, true);
  assert.equal(JSON.stringify(result).includes(credentials.apiKey), false);
  assert.deepEqual(calls.filter((args) => args[0] === "config" && args[1] === "set"), [
    ["config", "set", "model.provider", "custom"],
    ["config", "set", "model.base_url", ATLAS_OPENAI_BASE_URL],
    ["config", "set", "model.default", ATLAS_DEFAULT_MODEL],
    ["config", "set", "model.api_mode", "chat_completions"],
  ]);
  const envText = fs.readFileSync(paths.hermesEnv, "utf8");
  assert.match(envText, /^KEEP_ME=yes$/m);
  assert.equal((envText.match(/^OPENAI_API_KEY=/gm) || []).length, 1);
  assert.match(envText, /^OPENAI_API_KEY=atlas-test-secret$/m);
  assert.equal(result.backups.length, 2);
});

test("Hermes 未安装不写文件；配置命令中途失败会恢复原配置", async (t) => {
  const home = tempHome(t);
  const paths = getAtlasClientPaths(home);
  const missing = await applyAtlasToClient("hermes", credentials, {
    home,
    run: async () => { throw new Error("ENOENT"); },
    hermesCommand: "missing-hermes",
  });
  assert.equal(missing.ok, false);
  assert.equal(missing.code, "HERMES_NOT_INSTALLED");
  assert.ok(missing.installGuide?.url);
  assert.equal(fs.existsSync(paths.hermesConfig), false);

  write(paths.hermesConfig, "model:\n  default: before\n");
  write(paths.hermesEnv, "KEEP_ME=before\n");
  const originalConfig = fs.readFileSync(paths.hermesConfig, "utf8");
  const originalEnv = fs.readFileSync(paths.hermesEnv, "utf8");
  let setCount = 0;
  const run = async (_command, args) => {
    if (args[0] === "--version") return { stdout: "Hermes 1.0", stderr: "" };
    if (args.join(" ") === "config path") return { stdout: paths.hermesConfig, stderr: "" };
    if (args.join(" ") === "config env-path") return { stdout: paths.hermesEnv, stderr: "" };
    if (args[0] === "config" && args[1] === "set") {
      setCount += 1;
      write(paths.hermesConfig, `changed-${setCount}\n`);
      if (setCount === 2) throw new Error("simulated config failure");
    }
    return { stdout: "", stderr: "" };
  };
  const failed = await applyAtlasToClient("hermes", credentials, { home, run, hermesCommand: "hermes-test" });
  assert.equal(failed.ok, false);
  assert.equal(failed.code, "HERMES_CONFIG_FAILED");
  assert.match(failed.error, /已恢复原配置/);
  assert.equal(fs.readFileSync(paths.hermesConfig, "utf8"), originalConfig);
  assert.equal(fs.readFileSync(paths.hermesEnv, "utf8"), originalEnv);
});

test("dotenv 合并保留其它变量并移除目标 Key 的重复定义", () => {
  const merged = mergeDotEnv("A=1\nexport OPENAI_API_KEY=old\nOPENAI_API_KEY=duplicate\nB=2\n", "OPENAI_API_KEY", "new");
  assert.match(merged, /^A=1$/m);
  assert.match(merged, /^B=2$/m);
  assert.equal((merged.match(/^OPENAI_API_KEY=/gm) || []).length, 1);
  assert.match(merged, /^OPENAI_API_KEY=new$/m);
});
