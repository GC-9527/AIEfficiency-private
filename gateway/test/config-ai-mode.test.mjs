import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cfg-ai-mode-"));
const cfgPath = path.join(tmp, "gw.json");
process.env.GATEWAY_CONFIG_PATH = cfgPath;

fs.writeFileSync(cfgPath, JSON.stringify({
  role: "node",
  claudeProxy: { enabled: true },
  claudeProxyClient: { enabled: false, host: "http://old-server:3001" },
}, null, 2));

const configService = await import("../services/config.js");

test("加载纯客户端旧配置时自动关闭本机 AI、开启远端客户端并持久化", () => {
  assert.equal(configService.getConfig().role, "node");
  assert.equal(configService.getConfig().claudeProxy.enabled, false);
  assert.equal(configService.getConfig().claudeProxyClient.enabled, true);
  assert.equal(configService.getConfig().storyPointAiInferenceEnabled, false, "旧配置未声明时故事点 AI 推理必须默认关闭");
  const stored = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
  assert.equal(stored.claudeProxy.enabled, false);
  assert.equal(stored.claudeProxyClient.enabled, true);
});

test("standalone 更新配置时不允许本机和远端 AI 模式同时开启", () => {
  const updated = configService.updateConfig({
    role: "standalone",
    claudeProxy: { enabled: true },
    claudeProxyClient: { enabled: true, host: "http://new-server:3001" },
  });
  assert.equal(updated.claudeProxy.enabled, true);
  assert.equal(updated.claudeProxyClient.enabled, false);
});

test("切换为纯客户端角色时强制关闭本机 AI 并开启远端客户端", () => {
  const updated = configService.updateConfig({
    role: "node",
    claudeProxy: { enabled: true },
    claudeProxyClient: { enabled: false, host: "http://server:3001" },
  });
  assert.equal(updated.role, "node");
  assert.equal(updated.claudeProxy.enabled, false);
  assert.equal(updated.claudeProxyClient.enabled, true);

  const stored = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
  assert.equal(stored.claudeProxy.enabled, false);
  assert.equal(stored.claudeProxyClient.enabled, true);
});

test("切换为纯服务端角色时强制关闭远端客户端", () => {
  const updated = configService.updateConfig({
    role: "server",
    claudeProxy: { enabled: true },
    claudeProxyClient: { enabled: true, host: "http://other-server:3001" },
  });
  assert.equal(updated.role, "server");
  assert.equal(updated.claudeProxy.enabled, true);
  assert.equal(updated.claudeProxyClient.enabled, false);
});
