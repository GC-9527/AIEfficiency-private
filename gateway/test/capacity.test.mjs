/**
 * 算力上报单元测试：claude-proxy 用量/额度 + discovery selfInfo 两部分算力 + full 判定。
 * 算力两部分：① 故事点槽(maxConcurrent-运行中) ② Claude 用量/剩余(每日额度-已用)。任一不足即 full。
 */
import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dbcap-"));
process.env.GATEWAY_CONFIG_PATH = path.join(tmp, "gw.json");
process.env.GATEWAY_DB_PATH = path.join(tmp, "data.db");
fs.writeFileSync(process.env.GATEWAY_CONFIG_PATH, JSON.stringify({}));

let proxy, disc, cfg;
before(async () => {
  proxy = await import("../services/claude-proxy.js");
  disc = await import("../services/discovery.js");
  cfg = await import("../services/config.js");
});
beforeEach(() => {
  // 重置当日用量：用一个不可能的大负数不行；改为先把今日 usage 归零的办法——记一笔 0 并依赖按天重置不可控
  // 直接通过配置切换额度 + recordUsage 累加来构造各场景（每个用例自管增量）
});

test("无额度(0)：tokensRemaining=null、用量不限、不因额度 full", () => {
  cfg.updateConfig({ claudeProxy: { enabled: true, maxConcurrent: 3, dailyTokenBudget: 0 } });
  const h = proxy.proxyHealth();
  assert.equal(h.maxConcurrent, 3);
  assert.equal(h.tokenBudget, 0);
  assert.equal(h.tokensRemaining, null);
  assert.equal(h.quotaExhausted, false);
});

test("有额度且未用尽：remaining=额度-已用、未 full", () => {
  cfg.updateConfig({ claudeProxy: { enabled: true, maxConcurrent: 3, dailyTokenBudget: 100000 } });
  proxy.recordUsage({ inputTokens: 1000, outputTokens: 2000 }); // 用 3000
  const h = proxy.proxyHealth();
  assert.equal(h.tokenBudget, 100000);
  assert.equal(h.tokensUsedToday >= 3000, true);
  assert.equal(h.tokensRemaining, 100000 - h.tokensUsedToday);
  assert.equal(h.quotaExhausted, false);
});

test("额度用尽：quotaExhausted=true → selfInfo.full=true（即使有空闲槽）", () => {
  cfg.updateConfig({ claudeProxy: { enabled: true, maxConcurrent: 5, dailyTokenBudget: 1000 } });
  proxy.recordUsage({ inputTokens: 800, outputTokens: 800 }); // 累计远超 1000
  const h = proxy.proxyHealth();
  assert.equal(h.quotaExhausted, true);
  assert.equal(h.tokensRemaining, 0);
  const me = disc.selfInfo();
  assert.equal(me.capacity.free, 5, "槽仍空闲");
  assert.equal(me.full, true, "额度用尽即 full(算力不足)");
  assert.equal(me.capacity.quotaExhausted, true);
});

test("selfInfo 算力两部分字段齐全 + isServer/claudeEnabled", () => {
  cfg.updateConfig({ claudeProxy: { enabled: true, maxConcurrent: 2, dailyTokenBudget: 0 }, role: "standalone" });
  const me = disc.selfInfo();
  assert.equal(me.isServer, true);
  assert.equal(me.claudeEnabled, true);
  assert.equal(me.capacity.maxConcurrent, 2);
  assert.equal(typeof me.capacity.free, "number");
  assert.ok("tokenBudget" in me.capacity && "tokensRemaining" in me.capacity && "tokensUsedToday" in me.capacity);
  assert.ok(me.id && me.name && me.host.startsWith("http"));
});

test("node 角色非服务端：isServer=false", () => {
  process.env.ROLE = "node";
  const me = disc.selfInfo();
  assert.equal(me.isServer, false);
  delete process.env.ROLE;
});

test("analyzeImage 无 API Key → 优雅回退提示", async () => {
  cfg.updateConfig({ claudeProxy: { enabled: true, backend: "cli", anthropicApiKey: "" } });
  const r = await proxy.analyzeImage({ base64: "AAAA", mediaType: "image/png", prompt: "x" });
  assert.equal(r.ok, false);
  assert.ok(/API Key/i.test(r.error), "提示需配 API Key");
});

test("analyzeImage 无截图 → 报错不崩", async () => {
  cfg.updateConfig({ claudeProxy: { enabled: true, backend: "api", anthropicApiKey: "sk-ant-test" } });
  const r = await proxy.analyzeImage({ base64: "", prompt: "x" });
  assert.equal(r.ok, false);
  assert.ok(/无截图/.test(r.error));
});

test("代理后端支持 Codex CLI 订阅模式", () => {
  cfg.updateConfig({ claudeProxy: { enabled: true, backend: "codex", maxConcurrent: 2, dailyTokenBudget: 0 } });
  const h = proxy.proxyHealth();
  assert.equal(h.configuredBackend, "codex");
  assert.equal(h.backend, "codex");
  assert.equal(h.apiKeyConfigured, false);
});

test("代理后端支持 OpenAI 兼容 API Key 引擎", () => {
  const cur = cfg.getConfig();
  cfg.updateConfig({
    claudeProxy: { enabled: true, backend: "api-engine", apiEngineId: "openai", maxConcurrent: 2, dailyTokenBudget: 0 },
    apiEngines: {
      ...(cur.apiEngines || {}),
      openai: { ...(cur.apiEngines?.openai || {}), enabled: true, apiKey: "sk-test", baseUrl: "https://api.openai.com/v1", model: "gpt-4o-mini" },
    },
  });
  const h = proxy.proxyHealth();
  assert.equal(h.configuredBackend, "api-engine");
  assert.equal(h.backend, "api-engine");
  assert.equal(h.apiEngineId, "openai");
  assert.equal(h.apiKeyConfigured, true);
});
