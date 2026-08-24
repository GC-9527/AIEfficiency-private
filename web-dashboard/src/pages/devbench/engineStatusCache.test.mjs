import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ENGINE_STATUS_CACHE_KEY,
  answerAiModelTier,
  answerAiModelTierText,
  engineModelTier,
  engineModelTierText,
  engineStatusLabel,
  readEngineStatusCache,
  writeEngineStatusCache,
} from "./engineStatusCache.js";

function memoryStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: (key) => values.has(key) ? values.get(key) : null,
    setItem: (key, value) => values.set(key, String(value)),
  };
}

test("模型状态缓存：写入后可跨组件同步读取最后一次结果", () => {
  const storage = memoryStorage();
  const data = {
    claude: { available: false, status: "need_login" },
    codex: { available: true, status: "available" },
  };
  assert.equal(writeEngineStatusCache(data, storage), true);
  const cached = readEngineStatusCache(storage);
  assert.deepEqual(cached.data, data);
  assert.ok(cached.checkedAt > 0);
});

test("模型状态缓存：损坏或旧版数据安全降级为无缓存", () => {
  assert.equal(readEngineStatusCache(memoryStorage({ [ENGINE_STATUS_CACHE_KEY]: "{" })), null);
  assert.equal(readEngineStatusCache(memoryStorage({ [ENGINE_STATUS_CACHE_KEY]: JSON.stringify({ version: 0, data: {} }) })), null);
  assert.equal(writeEngineStatusCache([], memoryStorage()), false);
});

test("模型状态文案：区分可用、未安装、未登录和配置缺失", () => {
  assert.equal(engineStatusLabel({ available: true, status: "available" }), "可用");
  assert.equal(engineStatusLabel({ available: false, status: "not_installed" }), "未安装");
  assert.equal(engineStatusLabel({ available: false, status: "need_login" }), "未登录");
  assert.equal(engineStatusLabel({ available: false, status: "missing_key" }), "缺少 Key");
  assert.equal(engineStatusLabel(null), "待检测");
});

test("聊天框模型文案：展示当前 AI 的真实 model 与档位", () => {
  const metadata = { codex: { model: "gpt-5.6-sol", tier: "max" } };
  assert.deepEqual(engineModelTier(metadata, "codex"), {
    model: "gpt-5.6-sol",
    tier: "max",
    modelConfigured: true,
    tierConfigured: true,
  });
  assert.equal(engineModelTierText(metadata, "codex"), "gpt-5.6-sol · max");
});

test("聊天框模型文案：未显式配置时明确显示默认值", () => {
  assert.deepEqual(engineModelTier({}, "claude"), {
    model: "默认模型",
    tier: "默认档位",
    modelConfigured: false,
    tierConfigured: false,
  });
});

test("AI 回答模型文案：使用回答生成时保存的快照", () => {
  const message = {
    engine: "codex",
    aiSnapshot: { engine: "codex", model: "gpt-5.6-sol", tier: "max", capturedAt: 123 },
  };
  assert.deepEqual(answerAiModelTier(message), {
    engine: "codex",
    model: "gpt-5.6-sol",
    tier: "max",
    recorded: true,
  });
  assert.equal(answerAiModelTierText(message), "gpt-5.6-sol · max");
});

test("AI 回答模型文案：区分当时使用默认值与旧历史未记录", () => {
  assert.deepEqual(answerAiModelTier({ engine: "claude", aiSnapshot: { engine: "claude", model: "", tier: "" } }), {
    engine: "claude",
    model: "默认模型",
    tier: "默认档位",
    recorded: true,
  });
  assert.deepEqual(answerAiModelTier({ engine: "gemini" }), {
    engine: "gemini",
    model: "模型未记录",
    tier: "档位未记录",
    recorded: false,
  });
});

test("AI 回答身份：固化服务商、CLI 外壳和兼容端点，避免把方舟误标成官方", () => {
  const info = answerAiModelTier({
    engine: "codex",
    aiSnapshot: {
      engine: "codex",
      name: "Codex CLI（火山方舟）",
      provider: "火山方舟",
      access: "Codex CLI · app-server",
      endpoint: "https://ark.cn-beijing.volces.com/api/coding/v1",
      official: false,
      model: "doubao-seed-code",
      tier: "high",
    },
  });
  assert.equal(info.name, "Codex CLI（火山方舟）");
  assert.equal(info.provider, "火山方舟");
  assert.equal(info.access, "Codex CLI · app-server");
  assert.equal(info.official, false);
});
