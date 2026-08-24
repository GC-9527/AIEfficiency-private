import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "api-engines-cfg-"));
const cfgPath = path.join(tmp, "config.json");
fs.writeFileSync(cfgPath, JSON.stringify({
  apiEngines: {
    openai: { enabled: false, apiKey: "keep-me", model: "gpt-4o" },
    atlas: {
      enabled: true,
      apiKey: "atlas-key",
      model: "zai-org/glm-5.1",
      availableModels: ["zai-org/glm-5.1"],
    },
  },
}, null, 2), "utf8");
process.env.GATEWAY_CONFIG_PATH = cfgPath;

const {
  getConfig,
  updateConfig,
  isBuiltinApiEngineId,
  isValidCustomApiEngineId,
  mergeApiEnginesUpdate,
} = await import("../services/config.js");

test("内置 AI 模型服务含 bigmodel 与 Atlas，且校验自定义 ID", () => {
  assert.equal(isBuiltinApiEngineId("bigmodel"), true);
  assert.equal(isBuiltinApiEngineId("atlas"), true);
  assert.equal(isBuiltinApiEngineId("my-llm"), false);
  assert.equal(isValidCustomApiEngineId("my-llm"), true);
  assert.equal(isValidCustomApiEngineId("bigmodel"), false);
  assert.equal(isValidCustomApiEngineId("claude"), false);
  assert.equal(isValidCustomApiEngineId("1bad"), false);

  const cfg = getConfig();
  assert.ok(cfg.apiEngines.bigmodel, "升级合并后应出现智谱 BigModel");
  assert.ok(cfg.apiEngines.atlas, "升级合并后应出现 Atlas Coding Plan");
  assert.equal(cfg.apiEngines.atlas.baseUrl, "https://api.atlascloud.ai/v1");
  assert.equal(cfg.apiEngines.atlas.model, "zai-org/glm-5.1");
  assert.equal(cfg.apiEngines.atlas.apiKey, "atlas-key");
  assert.deepEqual(cfg.apiEngines.atlas.availableModels, [
    "deepseek-ai/deepseek-v4-flash-0731",
    "qwen/qwen3.8-max",
    "bytedance/doubao-seed-2.1-turbo-260628",
    "bytedance/doubao-seed-2.1-pro-260628",
    "zai-org/glm-5.2",
    "moonshotai/kimi-k2.7-code",
    "minimaxai/minimax-m3",
    "deepseek-ai/deepseek-v4-pro",
    "deepseek-ai/deepseek-v4-flash",
    "moonshotai/kimi-k2.6",
    "qwen/qwen3.6-plus",
    "zai-org/glm-5.1",
    "minimaxai/minimax-m2.7",
    "minimaxai/minimax-m2.5",
    "zai-org/glm-5",
    "moonshotai/kimi-k2.5",
    "deepseek-ai/deepseek-v3.2",
  ]);
  assert.equal(cfg.apiEngines.bigmodel.baseUrl, "https://open.bigmodel.cn/api/paas/v4");
  assert.equal(cfg.apiEngines.openai.apiKey, "keep-me");
});

test("可添加与删除自定义 API 引擎", () => {
  const added = mergeApiEnginesUpdate(getConfig().apiEngines, {
    "my-llm": {
      enabled: true,
      name: "My LLM",
      baseUrl: "https://example.com/v1",
      apiKey: "sk-test",
      model: "demo",
    },
  });
  assert.equal(added.error, undefined);
  updateConfig({ apiEngines: added.engines });
  assert.ok(getConfig().apiEngines["my-llm"]);
  assert.equal(getConfig().apiEngines["my-llm"].custom, true);

  const removed = mergeApiEnginesUpdate(getConfig().apiEngines, {
    "my-llm": { _delete: true },
  });
  updateConfig({ apiEngines: removed.engines });
  assert.equal(getConfig().apiEngines["my-llm"], undefined);

  const blocked = mergeApiEnginesUpdate(getConfig().apiEngines, {
    bigmodel: { _delete: true },
  });
  updateConfig({ apiEngines: blocked.engines });
  assert.ok(getConfig().apiEngines.bigmodel);

  const invalid = mergeApiEnginesUpdate(getConfig().apiEngines, {
    "Bad Id": { enabled: true, baseUrl: "https://x", model: "m", apiKey: "k" },
  });
  assert.match(invalid.error || "", /无效的自定义引擎 ID/);
});
