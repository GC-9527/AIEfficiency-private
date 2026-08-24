/**
 * 局域网服务发现 集成测试（一机模拟）：
 *   - srv：开了 AI 代理的服务端（广播算力，maxConcurrent=2）
 *   - cli：客户端（监听广播 + 手动 peer）
 * 验证：cli 发现 srv、算力字段、手动 peer、选服务端、满载拒绝。
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import WebSocket from "ws";
import { bootGateway, waitHealth } from "./_helpers.mjs";
import { totp } from "../services/totp.js";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dbdisc-"));
const SRV = 39301, CLI = 39302, UDP = 48911;

const srvCfg = path.join(tmp, "srv.json");
fs.writeFileSync(srvCfg, JSON.stringify({
  role: "standalone",
  claudeProxy: { enabled: true, token: "t", maxConcurrent: 2 },
  servers: { nodeName: "测试服务端A", discovery: true, discoveryPort: UDP, peers: [] },
}));
const cliCfg = path.join(tmp, "cli.json");
fs.writeFileSync(cliCfg, JSON.stringify({
  role: "node",
  servers: { nodeName: "测试客户端", discovery: true, discoveryPort: UDP, peers: [] },
  claudeProxyClient: { enabled: true, host: "", token: "t" },
}));

const boot = (port, cfg) => bootGateway({ port, role: cfg === srvCfg ? "standalone" : "node", gwCfg: cfg, market: path.join(tmp, `m-${port}.json`), storeDir: path.join(tmp, `s-${port}`) });
const disc = (port, p, opts) => fetch(`http://localhost:${port}/api/discovery${p}`, opts).then((r) => r.json());

let srv, cli, discoveryWs, cliAdminToken;
const discoveryEvents = [];
async function issueSuperToken(port) {
  const setup = await fetch(`http://localhost:${port}/api/admin/auth/totp/setup`).then((response) => response.json());
  const secret = setup.data?.secret || setup.secret;
  const login = await fetch(`http://localhost:${port}/api/admin/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code: totp(secret) }),
  }).then((response) => response.json());
  assert.ok(login.ok && login.token);
  return login.token;
}
const adminOptions = (options = {}) => ({
  ...options,
  headers: {
    ...(options.headers || {}),
    Authorization: `Bearer ${cliAdminToken}`,
  },
});
before(async () => {
  // 先启动观察者并连上 WS，再启动服务端，验证 UDP 发现结果能事件化推到页面。
  cli = boot(CLI, cliCfg);
  await waitHealth(CLI, cli);
  cliAdminToken = await issueSuperToken(CLI);
  discoveryWs = new WebSocket(`ws://localhost:${CLI}/ws`);
  await new Promise((resolve, reject) => {
    discoveryWs.once("open", resolve);
    discoveryWs.once("error", reject);
  });
  discoveryWs.on("message", (raw) => {
    try {
      const message = JSON.parse(raw.toString());
      if (message.type === "discovery_servers_changed") discoveryEvents.push(message.data);
    } catch {}
  });
  srv = boot(SRV, srvCfg);
  await waitHealth(SRV, srv);
  await new Promise((r) => setTimeout(r, 6500)); // 等启动事件 burst 与 WS 推送稳定。
}, { timeout: 45000 });
after(() => { try { discoveryWs?.close(); } catch {} try { srv.kill(); } catch {} try { cli.kill(); } catch {} });

test("服务端 /info 返回算力（maxConcurrent=2, free=2, 未满）", async () => {
  const d = await disc(SRV, "/info");
  assert.equal(d.ok, true);
  assert.equal(d.data.isServer, true);
  assert.equal(d.data.capacity.maxConcurrent, 2);
  assert.equal(d.data.capacity.free, 2);
  assert.equal(d.data.full, false);
  assert.equal(d.data.name, "测试服务端A");
});

test("客户端通过 UDP 广播发现到服务端", async () => {
  const d = await disc(CLI, "/servers");
  assert.equal(d.ok, true);
  const found = d.data.find((s) => s.name === "测试服务端A");
  assert.ok(found, `客户端应发现服务端，实际: ${d.data.map((s) => s.name)}`);
  assert.equal(found.capacity.free, 2);
});

test("客户端观察者通过 WebSocket 收到服务端列表变化", () => {
  const observed = discoveryEvents.some((event) => event.servers?.some((s) => s.name === "测试服务端A"));
  assert.equal(observed, true, `应收到 discovery_servers_changed，实际事件数: ${discoveryEvents.length}`);
});

test("手动 peer：添加跨子网服务端并轮询到", async () => {
  await disc(CLI, "/peers", adminOptions({ method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ host: `http://localhost:${SRV}` }) }));
  const peers = await disc(CLI, "/peers", adminOptions());
  assert.ok(peers.data.includes(`http://localhost:${SRV}`));
  await new Promise((r) => setTimeout(r, 8500)); // 等一轮 peer 轮询(8s)
  const d = await disc(CLI, "/servers");
  assert.ok(d.data.some((s) => s.name === "测试服务端A"), "手动 peer 也应出现在列表");
});

test("客户端选服务端 → 写入 claudeProxyClient.host", async () => {
  const info = await disc(SRV, "/info");
  await disc(CLI, "/peers", adminOptions({
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ host: info.data.host }),
  }));
  const r = await disc(CLI, "/select", adminOptions({ method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ host: info.data.host }) }));
  assert.equal(r.ok, true);
  assert.equal(r.data.selectedHost.replace(/\/+$/, ""), info.data.host.replace(/\/+$/, ""));
  // 校验配置已写
  const cfg = await fetch(`http://localhost:${CLI}/api/config`).then((x) => x.json());
  assert.equal(cfg.data.claudeProxyClient.host.replace(/\/+$/, ""), info.data.host.replace(/\/+$/, ""));
});

test("UDP/列表外地址未显式加入 peers 时拒绝选择", async () => {
  const r = await disc(CLI, "/select", adminOptions({
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ host: "http://10.0.0.250:3001" }),
  }));
  assert.equal(r.ok, false);
  assert.equal(r.code, "DISCOVERY_CENTER_NOT_TRUSTED");
});
