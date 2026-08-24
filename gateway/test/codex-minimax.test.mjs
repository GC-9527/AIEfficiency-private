import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";

// 隔离的测试 config（minimax 已启用 + key），避免读真实 config.json
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "codex-minimax-"));
process.env.GATEWAY_CONFIG_PATH = path.join(tmp, "gateway.json");
process.env.NODE_ENV = "test";
fs.writeFileSync(process.env.GATEWAY_CONFIG_PATH, JSON.stringify({
  apiEngines: {
    minimax: {
      enabled: true,
      apiKey: "sk-test-config",
      baseUrl: "https://api.minimaxi.com/v1",
      model: "MiniMax-M3",
    },
  },
}));

const {
  serializeMinimaxCodexToml,
  parseCodexConfigToml,
  mergeMinimaxIntoCodexToml,
  applyMinimaxToCodex,
  readCodexMinimaxStatus,
  detectDefaultCodexSource,
  buildCodexMinimaxSpawnEnv,
  buildCodexAppServerSpawnEnv,
  isCodexMinimaxReady,
  getCodexMinimaxConfigPath,
  getDefaultCodexConfigPath,
  getCodexOfficialConfigPath,
} = await import("../services/codex-minimax.js");

function makeHome() {
  return fs.mkdtempSync(path.join(tmp, "home-"));
}

test("serializeMinimaxCodexToml 生成官方配置格式", () => {
  const toml = serializeMinimaxCodexToml({ model: "MiniMax-M3", baseUrl: "https://api.minimaxi.com/v1", apiKey: "sk-test-123" });
  assert.match(toml, /model = "MiniMax-M3"/);
  assert.match(toml, /model_provider = "minimax"/);
  assert.match(toml, /model_context_window = 1000000/);
  assert.match(toml, /\[model_providers\.minimax\]/);
  assert.match(toml, /base_url = "https:\/\/api\.minimaxi\.com\/v1"/);
  assert.match(toml, /experimental_bearer_token = "sk-test-123"/);
  assert.match(toml, /wire_api = "responses"/);
});

test("parseCodexConfigToml 解析顶层与 provider 段", () => {
  const toml = `
model = "MiniMax-M3"
model_provider = "minimax"
model_context_window = 1000000

[model_providers.minimax]
name = "MiniMax"
base_url = "https://api.minimaxi.com/v1"
experimental_bearer_token = "sk-test"
wire_api = "responses"
`;
  const parsed = parseCodexConfigToml(toml);
  assert.equal(parsed.model, "MiniMax-M3");
  assert.equal(parsed.modelProvider, "minimax");
  assert.equal(parsed.modelContextWindow, "1000000");
  assert.equal(parsed.providers.minimax.name, "MiniMax");
  assert.equal(parsed.providers.minimax.baseUrl, "https://api.minimaxi.com/v1");
  assert.equal(parsed.providers.minimax.hasToken, true);
  assert.equal(parsed.providers.minimax.wireApi, "responses");
});

test("mergeMinimaxIntoCodexToml 保留其他字段并覆盖 minimax 段", () => {
  const existing = `model_reasoning_effort = "high"
model = "gpt-5"
model_provider = "openai"

[model_providers.openai]
name = "OpenAI"

[model_providers.minimax]
name = "OldMiniMax"
base_url = "https://old.example.com/v1"
experimental_bearer_token = "old-key"
`;
  const merged = mergeMinimaxIntoCodexToml(existing, { model: "MiniMax-M3", baseUrl: "https://api.minimaxi.com/v1", apiKey: "new-key" });
  // 保留 model_reasoning_effort
  assert.match(merged, /model_reasoning_effort = "high"/);
  // 保留 [model_providers.openai]
  assert.match(merged, /\[model_providers\.openai\]/);
  // 旧 minimax 段被替换
  assert.equal(/old-key/.test(merged), false);
  assert.equal(/old\.example\.com/.test(merged), false);
  // 新 minimax 段
  const parsed = parseCodexConfigToml(merged);
  assert.equal(parsed.model, "MiniMax-M3");
  assert.equal(parsed.modelProvider, "minimax");
  assert.equal(parsed.providers.minimax.baseUrl, "https://api.minimaxi.com/v1");
  assert.equal(parsed.providers.minimax.hasToken, true);
  // openai provider 保留
  assert.equal(parsed.providers.openai?.name, "OpenAI");
});

test("detectDefaultCodexSource 区分 minimax/official", () => {
  const home = makeHome();
  try {
    // 无 config.toml -> official
    assert.equal(detectDefaultCodexSource(home), "official");
    // 写入 minimax 配置 -> minimax
    fs.mkdirSync(path.join(home, ".codex"), { recursive: true });
    fs.writeFileSync(getDefaultCodexConfigPath(home), serializeMinimaxCodexToml({ model: "MiniMax-M3", baseUrl: "https://api.minimaxi.com/v1", apiKey: "sk-test" }), "utf8");
    assert.equal(detectDefaultCodexSource(home), "minimax");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("applyMinimaxToCodex 写隔离+默认+备份官方", () => {
  const home = makeHome();
  try {
    // 预置官方 config.toml + auth.json
    fs.mkdirSync(path.join(home, ".codex"), { recursive: true });
    fs.writeFileSync(getDefaultCodexConfigPath(home), `model_reasoning_effort = "high"\n`, "utf8");
    fs.writeFileSync(path.join(home, ".codex", "auth.json"), `{"token":"official"}`, "utf8");

    const result = applyMinimaxToCodex({
      home,
      apiKey: "sk-test-123",
      baseUrl: "https://api.minimaxi.com/v1",
      model: "MiniMax-M3",
    });
    assert.equal(result.ok, true);
    // 隔离目录 ~/.codex-minimax/config.toml
    const isolated = fs.readFileSync(getCodexMinimaxConfigPath(home), "utf8");
    assert.match(isolated, /experimental_bearer_token = "sk-test-123"/);
    // 默认 ~/.codex/config.toml 已切到 minimax，且保留 model_reasoning_effort
    const defaultCfg = fs.readFileSync(getDefaultCodexConfigPath(home), "utf8");
    assert.match(defaultCfg, /model_provider = "minimax"/);
    assert.match(defaultCfg, /model_reasoning_effort = "high"/);
    // 官方备份 ~/.codex-official/config.toml + auth.json
    const officialCfg = fs.readFileSync(getCodexOfficialConfigPath(home), "utf8");
    assert.match(officialCfg, /model_reasoning_effort = "high"/);
    assert.equal(fs.existsSync(path.join(home, ".codex-official", "auth.json")), true);
    // 默认来源判定为 minimax
    assert.equal(detectDefaultCodexSource(home), "minimax");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("applyMinimaxToCodex 无 key 失败", () => {
  const home = makeHome();
  try {
    const result = applyMinimaxToCodex({ home, apiKey: "", baseUrl: "https://api.minimaxi.com/v1", model: "MiniMax-M3" });
    // overrides.apiKey 为空 -> 回退 cfg.apiKey=sk-test-config -> hasKey=true。
    // 用脱敏 key 模拟"未填真实 key"
    const result2 = applyMinimaxToCodex({ home, apiKey: "****" });
    assert.equal(result2.ok, false);
    assert.match(result2.error, /API Key/);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("buildCodexMinimaxSpawnEnv 设 CODEX_HOME 并写隔离 config", () => {
  const home = makeHome();
  try {
    const { env, configDir, creds } = buildCodexMinimaxSpawnEnv({ HOME: home }, {
      home,
      apiKey: "sk-spawn-test",
      baseUrl: "https://api.minimaxi.com/v1",
      model: "MiniMax-M3",
    });
    assert.equal(env.CODEX_HOME, configDir);
    assert.equal(creds.model, "MiniMax-M3");
    assert.equal(fs.existsSync(getCodexMinimaxConfigPath(home)), true);
    const cfg = fs.readFileSync(getCodexMinimaxConfigPath(home), "utf8");
    assert.match(cfg, /experimental_bearer_token = "sk-spawn-test"/);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("Codex Atlas app-server 使用进程级临时 CODEX_HOME 且保留 Atlas provider", () => {
  const home = makeHome();
  let runtime;
  try {
    runtime = buildCodexAppServerSpawnEnv({ HOME: home }, {
      home,
      engine: "codex-atlas",
      apiKey: "atlas-app-server-test",
      baseUrl: "https://api.atlascloud.ai/v1",
      model: "zai-org/glm-5.1",
    });
    assert.equal(runtime.modelProvider, "atlas_coding_plan");
    assert.notEqual(runtime.configDir, path.join(home, ".codex-atlas"));
    assert.equal(runtime.env.CODEX_HOME, runtime.configDir);
    const runtimeConfig = fs.readFileSync(path.join(runtime.configDir, "config.toml"), "utf8");
    assert.match(runtimeConfig, /model_provider = "atlas_coding_plan"/);
    assert.match(runtimeConfig, /wire_api = "responses"/);
    assert.doesNotMatch(runtimeConfig, /wire_api = "chat"/);
    assert.equal(JSON.parse(fs.readFileSync(path.join(runtime.configDir, "auth.json"), "utf8")).OPENAI_API_KEY, "atlas-app-server-test");
  } finally {
    const runtimeDir = runtime?.configDir;
    runtime?.cleanup();
    if (runtimeDir) assert.equal(fs.existsSync(runtimeDir), false);
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("isCodexMinimaxReady 用配置 key 判定", () => {
  // getConfig 的 minimax.enabled=true, apiKey=sk-test-config
  assert.equal(isCodexMinimaxReady(), true);
  // 脱敏 key 视为未配置
  assert.equal(isCodexMinimaxReady({ apiKey: "****" }), false);
});

test("readCodexMinimaxStatus 反映配置状态", () => {
  const home = makeHome();
  try {
    applyMinimaxToCodex({ home, apiKey: "sk-status", baseUrl: "https://api.minimaxi.com/v1", model: "MiniMax-M3" });
    const status = readCodexMinimaxStatus({ home, apiKey: "sk-status" });
    assert.equal(status.ok, true);
    assert.equal(status.settingsReady, true);
    assert.equal(status.defaultCodexReady, true);
    assert.equal(status.defaultCodexSource, "minimax");
    assert.equal(status.model, "MiniMax-M3");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
