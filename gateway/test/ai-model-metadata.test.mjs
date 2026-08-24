import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  getClaudeProxyAiSnapshot,
  getAiModelSnapshot,
  getAiModelMetadata,
  parseHermesModelConfig,
  parseTomlMetadata,
  readCodexModelMetadata,
  readHermesModelMetadata,
} from "../services/ai-model-metadata.js";

function tempFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ai-model-meta-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function write(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, "utf8");
}

test("TOML 元数据解析只读取当前层，并保留带 # 的引号值", () => {
  const parsed = parseTomlMetadata(`
model = "gpt-5.6-sol#preview" # comment
model_reasoning_effort = 'max'

[profiles.fast]
model = "gpt-fast"
model_reasoning_effort = "low"
`);
  assert.equal(parsed.root.model, "gpt-5.6-sol#preview");
  assert.equal(parsed.root.model_reasoning_effort, "max");
  assert.equal(parsed.sections["profiles.fast"].model, "gpt-fast");
});

test("Hermes 元数据只读取 model/provider，不暴露同文件中的凭据", (t) => {
  const root = tempFixture(t);
  const home = path.join(root, "home");
  write(path.join(home, ".hermes", "config.yaml"), `
model:
  default: deepseek-v4-flash
  provider: deepseek
api_key: must-not-be-returned
`);
  assert.deepEqual(parseHermesModelConfig(`model:\n  default: local-model\n  provider: ollama\nsecret: hidden\n`), {
    model: "local-model",
    provider: "ollama",
  });
  assert.deepEqual(readHermesModelMetadata({ home, env: {} }), {
    name: "Hermes Agent（本地）",
    model: "deepseek-v4-flash",
    tier: "",
    source: "用户配置",
    provider: "deepseek",
    access: "Hermes Agent CLI · oneshot",
  });
});

test("Codex 元数据按用户配置、profile、工程配置依次覆盖", (t) => {
  const root = tempFixture(t);
  const home = path.join(root, "home");
  const project = path.join(root, "repo");
  fs.mkdirSync(path.join(project, ".git"), { recursive: true });
  write(path.join(home, ".codex", "config.toml"), `
model = "gpt-user"
model_reasoning_effort = "high"
profile = "work"
`);
  write(path.join(home, ".codex", "work.config.toml"), `
model = "gpt-profile"
model_reasoning_effort = "max"
`);
  write(path.join(project, ".codex", "config.toml"), `
model = "gpt-5.6-sol"
`);

  assert.deepEqual(readCodexModelMetadata({ home, cwd: project, env: {} }), {
    name: "Codex CLI（OpenAI 官方）",
    model: "gpt-5.6-sol",
    tier: "max",
    source: "工程配置",
    provider: "OpenAI",
    access: "Codex CLI · app-server",
    official: true,
  });
});

test("所有 AI 元数据统一返回 model 与档位，API 引擎反映真实思考配置", (t) => {
  const root = tempFixture(t);
  const home = path.join(root, "home");
  write(path.join(home, ".codex", "config.toml"), `model = "gpt-5.6-sol"\nmodel_reasoning_effort = "max"\n`);
  write(path.join(home, ".claude", "settings.json"), JSON.stringify({ model: "claude-opus", effortLevel: "high" }));

  const result = getAiModelMetadata({
    home,
    env: {},
    config: {
      apiEngines: {
        deepseek: { name: "DeepSeek", model: "deepseek-v4-pro", thinkingEnabled: true, reasoningEffort: "max" },
        openai: { name: "OpenAI", model: "gpt-api" },
        atlas: {
          name: "Atlas Coding Plan",
          model: "zai-org/glm-5.1",
          baseUrl: "https://api.atlascloud.ai/v1",
          availableModels: ["zai-org/glm-5.1", "moonshotai/kimi-k2.6"],
        },
      },
    },
  });

  assert.deepEqual(result.codex, {
    name: "Codex CLI（OpenAI 官方）", model: "gpt-5.6-sol", tier: "max", source: "用户配置",
    provider: "OpenAI", access: "Codex CLI · app-server", official: true,
  });
  assert.deepEqual(result.claude, {
    name: "Claude Code（Anthropic 官方）", model: "claude-opus", tier: "high", source: "用户配置",
    provider: "Anthropic", access: "Claude Code CLI", official: true,
  });
  assert.deepEqual(result.deepseek, {
    name: "DeepSeek", model: "deepseek-v4-pro", tier: "max", source: "网关配置",
    provider: "DeepSeek", access: "网关直连 · OpenAI 兼容 API", official: false,
  });
  assert.deepEqual(result.openai, {
    name: "OpenAI", model: "gpt-api", tier: "", source: "网关配置",
    provider: "OpenAI", access: "网关直连 · OpenAI 兼容 API", official: false,
  });
  assert.deepEqual(result.atlas, {
    name: "Atlas Coding Plan", model: "zai-org/glm-5.1", tier: "", source: "网关配置",
    provider: "Atlas Coding Plan", access: "网关直连 · OpenAI 兼容 API",
    endpoint: "https://api.atlascloud.ai/v1", official: false,
    availableModels: ["zai-org/glm-5.1", "moonshotai/kimi-k2.6"],
  });
  assert.equal(result["claude-atlas"].name, "Claude Code（Atlas Coding Plan）");
  assert.equal(result["claude-atlas"].access, "Claude Code CLI · Anthropic 兼容端点");
  assert.deepEqual(result["claude-atlas"].availableModels, result.atlas.availableModels);
  assert.equal(result["codex-atlas"].name, "Codex CLI（Atlas Coding Plan）");
  assert.equal(result["codex-atlas"].access, "Codex CLI · OpenAI 兼容端点");
  assert.equal(result["hermes-atlas"].name, "Hermes（Atlas Coding Plan）");
  assert.equal(result["hermes-atlas"].access, "Hermes Agent CLI · OpenAI 兼容端点");
  assert.deepEqual(result.gemini, {
    name: "Gemini CLI（Google）", model: "", tier: "",
    provider: "Google", access: "Gemini CLI", official: true,
  });
});

test("回答快照固化生成时的 engine、model 与档位", (t) => {
  const root = tempFixture(t);
  const home = path.join(root, "home");
  const configFile = path.join(home, ".codex", "config.toml");
  write(configFile, `model = "gpt-5.6-sol"\nmodel_reasoning_effort = "max"\n`);

  const first = getAiModelSnapshot({
    engine: "codex",
    capturedAt: 123456,
    home,
    env: {},
  });
  write(configFile, `model = "gpt-5.7-sol"\nmodel_reasoning_effort = "high"\n`);
  const second = getAiModelSnapshot({ engine: "codex", capturedAt: 234567, home, env: {} });

  assert.deepEqual(first, {
    engine: "codex",
    model: "gpt-5.6-sol",
    tier: "max",
    name: "Codex CLI（OpenAI 官方）",
    provider: "OpenAI",
    access: "Codex CLI · app-server",
    official: true,
    capturedAt: 123456,
  });
  assert.deepEqual(second, {
    engine: "codex",
    model: "gpt-5.7-sol",
    tier: "high",
    name: "Codex CLI（OpenAI 官方）",
    provider: "OpenAI",
    access: "Codex CLI · app-server",
    official: true,
    capturedAt: 234567,
  });
});

test("getAiModelSnapshot 支持故事点 model/tier 覆盖", (t) => {
  const root = tempFixture(t);
  const home = path.join(root, "home");
  write(path.join(home, ".codex", "config.toml"), `model = "gpt-user"\nmodel_reasoning_effort = "medium"\n`);
  assert.deepEqual(getAiModelSnapshot({
    engine: "codex",
    modelOverride: "gpt-story",
    tierOverride: "max",
    capturedAt: 42,
    home,
    env: {},
  }), {
    engine: "codex",
    model: "gpt-story",
    tier: "max",
    name: "Codex CLI（OpenAI 官方）",
    provider: "OpenAI",
    access: "Codex CLI · app-server",
    official: true,
    capturedAt: 42,
  });
});

test("Codex 自定义 provider 不冒充 OpenAI 官方，端点快照会移除查询凭证", (t) => {
  const root = tempFixture(t);
  const home = path.join(root, "home");
  write(path.join(home, ".codex-official", "config.toml"), `
model = "doubao-seed-code"
model_provider = "ark"
[model_providers.ark]
name = "Ark gateway"
base_url = "https://ark.cn-beijing.volces.com/api/coding/v1?token=secret"
`);

  const result = getAiModelMetadata({ home, env: {}, config: {} }).codex;
  assert.equal(result.name, "Codex CLI（火山方舟）");
  assert.equal(result.provider, "火山方舟");
  assert.equal(result.official, false);
  assert.equal(result.endpoint, "https://ark.cn-beijing.volces.com/api/coding/v1");
  assert.equal(result.model, "doubao-seed-code");
});

test("Codex requires_openai_auth 的无端点 provider 识别为官方认证，而非自定义中转", (t) => {
  const root = tempFixture(t);
  const home = path.join(root, "home");
  write(path.join(home, ".codex", "config.toml"), `
model = "gpt-official"
model_provider = "code-switch"
[model_providers.code-switch]
name = "OpenAI"
requires_openai_auth = true
wire_api = "responses"
`);
  const result = getAiModelMetadata({ home, env: {}, config: {} }).codex;
  assert.equal(result.name, "Codex CLI（OpenAI 官方）");
  assert.equal(result.provider, "OpenAI");
  assert.equal(result.official, true);
  assert.equal(result.model, "gpt-official");
});

test("官方协议键改写到未知 API 地址时只标兼容协议，不猜成官方服务商", (t) => {
  const root = tempFixture(t);
  const home = path.join(root, "home");
  write(path.join(home, ".codex", "config.toml"), `
model = "proxy-model"
model_provider = "openai"
[model_providers.openai]
base_url = "https://proxy.example.test/openai/v1?token=secret"
`);
  write(path.join(home, ".claude", "settings.json"), JSON.stringify({
    model: "proxy-claude",
    env: { ANTHROPIC_BASE_URL: "https://proxy.example.test/anthropic?key=secret" },
  }));

  const result = getAiModelMetadata({ home, env: {}, config: {} });
  assert.equal(result.codex.name, "Codex CLI（自定义服务商）");
  assert.equal(result.codex.provider, "自定义服务商");
  assert.equal(result.codex.official, false);
  assert.equal(result.codex.endpoint, "https://proxy.example.test/openai/v1");
  assert.equal(result.claude.name, "Claude Code（自定义服务商）");
  assert.equal(result.claude.provider, "自定义服务商");
  assert.equal(result.claude.official, false);
  assert.equal(result.claude.endpoint, "https://proxy.example.test/anthropic");
});

test("同一 MiniMax 服务区分 Claude Code、Codex CLI 与网关 API 三种接入", (t) => {
  const root = tempFixture(t);
  const result = getAiModelMetadata({
    home: path.join(root, "home"),
    env: {},
    config: {
      apiEngines: {
        minimax: {
          enabled: true,
          apiKey: "secret",
          name: "MiniMax API",
          model: "MiniMax-M3",
          baseUrl: "https://api.minimaxi.com/v1",
        },
      },
    },
  });
  assert.equal(result["claude-minimax"].provider, "MiniMax");
  assert.equal(result["claude-minimax"].access, "Claude Code CLI · Anthropic 兼容端点");
  assert.equal(result["codex-minimax"].access, "Codex CLI · OpenAI 兼容端点");
  assert.equal(result.minimax.access, "网关直连 · OpenAI 兼容 API");
  assert.equal(result["claude-minimax"].endpoint, "https://api.minimaxi.com/anthropic");
  assert.equal(result["codex-minimax"].endpoint, "https://api.minimaxi.com/v1");
});

test("中心机快照按实际代理后端回传，而不是冒用客户端请求的引擎", (t) => {
  const root = tempFixture(t);
  const home = path.join(root, "home");
  write(path.join(home, ".codex", "config.toml"), `
model = "doubao-seed-code"
model_provider = "ark"
[model_providers.ark]
base_url = "https://ark.cn-beijing.volces.com/api/coding/v1?key=secret"
`);
  const codexCenter = getClaudeProxyAiSnapshot({
    home,
    env: {},
    capturedAt: 99,
    config: { claudeProxy: { backend: "codex" } },
  });
  assert.equal(codexCenter.engine, "center");
  assert.equal(codexCenter.name, "中心机 · Codex CLI（火山方舟）");
  assert.equal(codexCenter.provider, "火山方舟");
  assert.equal(codexCenter.access, "Agent V2 → Codex CLI · exec");
  assert.equal(codexCenter.endpoint, "https://ark.cn-beijing.volces.com/api/coding/v1");
  assert.equal(codexCenter.model, "doubao-seed-code");

  const apiCenter = getClaudeProxyAiSnapshot({
    home,
    env: {},
    config: {
      claudeProxy: { backend: "api-engine", apiEngineId: "volcengine" },
      apiEngines: {
        volcengine: {
          enabled: true,
          apiKey: "secret",
          name: "火山方舟",
          model: "ark-code-latest",
          baseUrl: "https://ark.cn-beijing.volces.com/api/coding/v3",
        },
      },
    },
  });
  assert.equal(apiCenter.provider, "火山方舟");
  assert.equal(apiCenter.access, "Agent V2 → 网关直连 · OpenAI 兼容 API");
  assert.equal(apiCenter.model, "ark-code-latest");
});
