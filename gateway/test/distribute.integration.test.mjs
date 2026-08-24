/**
 * LAN 服务端自分发 集成测试：服务端角色下 /install、/setup.ps1、/download/gateway-bundle.zip、
 * /api/gateway-version 可用；脚本自动配成客户端连本服务端；node 角色不分发。
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { bootGateway, waitHealth } from "./_helpers.mjs";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dist-"));
const S = 39911, N = 39912;
const mk = (n, o) => { const p = path.join(tmp, n); fs.writeFileSync(p, JSON.stringify(o)); return p; };
const J = (port, p) => fetch(`http://localhost:${port}${p}`);

let srvS, srvN;
before(async () => {
  srvS = bootGateway({ port: S, role: "standalone", gwCfg: mk("s.json", { role: "standalone", servers: { nodeName: "中心甲" } }), market: path.join(tmp, "ms.json"), storeDir: path.join(tmp, "ss"), dbPath: path.join(tmp, "s.db") });
  srvN = bootGateway({ port: N, role: "node", gwCfg: mk("n.json", { role: "node" }), market: path.join(tmp, "mn.json"), storeDir: path.join(tmp, "sn"), dbPath: path.join(tmp, "n.db") });
  await waitHealth(S, srvS); await waitHealth(N, srvN);
}, { timeout: 40000 });
after(() => { try { srvS.kill(); } catch {} try { srvN.kill(); } catch {} });

test("服务端 /api/gateway-version", async () => {
  const d = await J(S, "/api/gateway-version").then((r) => r.json());
  assert.ok(d.version && /\d+\.\d+/.test(d.version));
});

test("服务端 /setup.ps1 自动配成客户端并连本服务端", async () => {
  const ps = await J(S, "/setup.ps1").then((r) => r.text());
  assert.ok(ps.includes("ai-gateway"), "含安装逻辑");
  assert.ok(ps.includes('"role": "node"'), "自动 role=node");
  assert.ok(ps.includes(`http://localhost:${S}`), "claudeProxyClient 指向本服务端");
  assert.ok(ps.includes("Expand-Archive") && ps.includes("/download/gateway-bundle.zip"), "下载并解压 bundle");
});

test("client=0 时不写客户端配置（纯装网关）", async () => {
  const ps = await J(S, "/setup.ps1?client=0").then((r) => r.text());
  assert.ok(!ps.includes('"role": "node"'), "不自动配客户端");
});

test("服务端 /setup.sh (macOS/Linux) 自动配成客户端并连本服务端", async () => {
  const sh = await J(S, "/setup.sh").then((r) => r.text());
  assert.ok(sh.startsWith("#!/usr/bin/env bash"), "bash 脚本");
  assert.ok(sh.includes('"role": "node"'), "自动 role=node");
  assert.ok(sh.includes(`http://localhost:${S}`), "指向本服务端");
  assert.ok(sh.includes("/download/gateway-bundle.zip") && sh.includes("launchctl load"), "下载bundle + launchd 自启");
  const sh0 = await J(S, "/setup.sh?client=0").then((r) => r.text());
  assert.ok(!sh0.includes('"role": "node"'), "client=0 不自动配");
});

test("服务端 /install 落地页含三种入口", async () => {
  const html = await J(S, "/install").then((r) => r.text());
  assert.ok(html.includes("桌面版") && html.includes("网页版") && html.includes("PowerShell"));
  assert.ok(html.includes(`irm http://localhost:${S}/setup.ps1`), "含 Windows 一行命令");
  assert.ok(html.includes(`curl -fsSL http://localhost:${S}/setup.sh | bash`) && html.includes("macOS / Linux"), "含 macOS/Linux 一行命令");
  assert.ok(html.includes("中心甲"), "显示服务端名");
  assert.ok(html.includes("<svg") && html.includes("扫码在其它设备"), "含二维码");
  // 桌面版双平台入口（未放安装包时显示"未就绪"+放置提示）
  assert.ok(html.includes("Windows 版未就绪") || html.includes("Windows (.exe)"), "含 Windows 桌面入口");
  assert.ok(html.includes("macOS 版未就绪") || html.includes("macOS (.dmg)"), "含 macOS 桌面入口");
});

test("服务端 /download/desktop-setup.dmg 未放置时 404 带提示", async () => {
  const r = await J(S, "/download/desktop-setup.dmg");
  assert.equal(r.status, 404);
  const d = await r.json();
  assert.ok(d.error.includes("macOS"), "提示 macOS 安装包");
});

test("服务端 /download/gateway-bundle.zip 是合法 zip", async () => {
  const r = await J(S, "/download/gateway-bundle.zip");
  assert.equal(r.status, 200);
  const buf = Buffer.from(await r.arrayBuffer());
  assert.ok(buf.length > 1000, "非空");
  assert.equal(buf.slice(0, 2).toString(), "PK", "zip 魔数");
});

test("服务端 /api/discovery/ips 列出本机 IPv4 + 选定地址回写 host", async () => {
  const d = await J(S, "/api/discovery/ips").then((r) => r.json());
  assert.equal(d.ok, true);
  assert.ok(Array.isArray(d.data.ips), "返回 ips 数组");
  assert.equal(typeof d.data.advertiseIp, "string");
  if (d.data.ips.length) {
    const ip = d.data.ips[0].address;
    const post = (body) => fetch(`http://localhost:${S}/api/discovery/advertise-ip`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const set = await post({ ip }).then((r) => r.json());
    assert.ok(set.ok && set.data.host.includes(ip), "选定 IP 后 host 跟随");
    assert.equal((await post({ ip: "1.2.3.4" })).status, 400, "非本机 IP 拒绝");
  }
});

test("node 客户端不分发（无 /install 与 /setup.ps1）", async () => {
  const inst = await J(N, "/install");
  const ps = await J(N, "/setup.ps1");
  assert.notEqual(inst.status, 200);
  assert.notEqual(ps.status, 200);
});
