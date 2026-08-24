/**
 * 管理员「在此开发」端点 集成测试：鉴权 + git-info + run 路径校验 + run-result。
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { totp } from "../services/totp.js";
import { bootGateway, waitHealth, GW_DIR } from "./_helpers.mjs";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dm-"));
const P = 39811;
const base = `http://localhost:${P}`;
fs.writeFileSync(path.join(tmp, "g.json"), JSON.stringify({ role: "standalone", codexEnabled: true, autoFallback: false, maxCliConcurrency: 1 }));

const fakeCodex = path.join(tmp, "fake-codex.mjs");
fs.writeFileSync(fakeCodex, `
if (!process.argv.includes("--image")) {
  process.stderr.write("missing --image\\n");
  process.exit(2);
}
process.stdout.write(JSON.stringify({
  type: "item.completed",
  item: { type: "agent_message", text: "任务状态：已完成\\n已按页面截图理解需求。" },
}) + "\\n");
`);
if (process.platform === "win32") {
  fs.writeFileSync(path.join(tmp, "codex.cmd"), `@echo off\r\nnode "${fakeCodex}" %*\r\n`);
} else {
  const bin = path.join(tmp, "codex");
  fs.writeFileSync(bin, `#!/bin/sh\nexec node "${fakeCodex}" "$@"\n`);
  fs.chmodSync(bin, 0o755);
}
process.env.PATH = `${tmp}${path.delimiter}${process.env.PATH || ""}`;

let srv, token;
before(async () => {
  srv = bootGateway({ port: P, role: "standalone", gwCfg: path.join(tmp, "g.json"), market: path.join(tmp, "m.json"), storeDir: path.join(tmp, "s"), dbPath: path.join(tmp, "d.db"), totpDir: path.join(tmp, "sec") });
  await waitHealth(P, srv);
  const setup = await fetch(base + "/api/admin/auth/totp/setup").then((r) => r.json());
  const login = await fetch(base + "/api/admin/auth/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code: totp(setup.data?.secret || setup.secret) }) }).then((r) => r.json());
  token = login.token;
}, { timeout: 40000 });
after(() => { try { srv.kill(); } catch {} });

const TK = () => ({ Authorization: `Bearer ${token}` });

test("git-info / run / run-result 均需管理员", async () => {
  assert.equal((await fetch(base + "/api/devbench/devmode/git-info?root=x")).status, 403);
  assert.equal((await fetch(base + "/api/devbench/devmode/run", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ message: "x", root: "y" }) })).status, 403);
  assert.equal((await fetch(base + "/api/devbench/devmode/run-result?runId=x")).status, 403);
});

test("git-info 读取仓库分支/改动", async () => {
  const repoRoot = path.resolve(GW_DIR, ".."); // 仓库根(git 仓库)
  const d = await fetch(base + `/api/devbench/devmode/git-info?root=${encodeURIComponent(repoRoot)}`, { headers: TK() }).then((r) => r.json());
  assert.equal(d.ok, true);
  assert.equal(d.data.exists, true);
  assert.equal(d.data.isRepo, true);
  assert.equal(typeof d.data.branch, "string");
});

test("git-info 路径不存在 → exists:false", async () => {
  const d = await fetch(base + `/api/devbench/devmode/git-info?root=${encodeURIComponent("/no/such/path/xyz")}`, { headers: TK() }).then((r) => r.json());
  assert.equal(d.data.exists, false);
});

test("run 缺消息/路径 → 400", async () => {
  const noMsg = await fetch(base + "/api/devbench/devmode/run", { method: "POST", headers: { "Content-Type": "application/json", ...TK() }, body: JSON.stringify({ root: path.resolve(GW_DIR, "..") }) });
  assert.equal(noMsg.status, 400);
  const badPath = await fetch(base + "/api/devbench/devmode/run", { method: "POST", headers: { "Content-Type": "application/json", ...TK() }, body: JSON.stringify({ message: "改色", root: "/no/such/path" }) });
  assert.equal(badPath.status, 400);
});

test("run-result 未知 runId → pending", async () => {
  const d = await fetch(base + "/api/devbench/devmode/run-result?runId=nope", { headers: TK() }).then((r) => r.json());
  assert.equal(d.ok, true);
  assert.equal(d.data.pending, true);
});

test("run 使用 Codex + 截图时先创建 tasks 行，避免外键失败", async () => {
  const shot = Buffer.from("fake-jpeg").toString("base64");
  const start = await fetch(base + "/api/devbench/devmode/run", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...TK() },
    body: JSON.stringify({
      root: tmp,
      message: "根据截图调整这两个控件",
      engine: "codex",
      route: "/devbench",
      page: "工程开发工作台",
      elements: [{ kind: "region", alias: "两个控件", rect: { x: 1, y: 2, width: 30, height: 40 } }],
      screenshot: shot,
      screenshotType: "image/jpeg",
    }),
  }).then((r) => r.json());
  assert.equal(start.ok, true, start.error);
  const runId = start.data.runId;
  let result = null;
  for (let i = 0; i < 20; i++) {
    const rr = await fetch(base + `/api/devbench/devmode/run-result?runId=${encodeURIComponent(runId)}`, { headers: TK() }).then((r) => r.json());
    if (rr.ok && rr.data && !rr.data.pending) { result = rr.data; break; }
    await new Promise((r) => setTimeout(r, 250));
  }
  assert.ok(result, "run-result should complete");
  assert.equal(result.ok, true, result.error);
  assert.equal(result.engine, "codex");
});

test("部署动作均需管理员(无 token → 403)", async () => {
  // 不带 token 仅验证鉴权；不触发真实构建/重启(有副作用)
  for (const p of ["/api/devbench/devmode/rebuild-web", "/api/devbench/devmode/restart-gateway", "/api/devbench/devmode/repackage-desktop"]) {
    assert.equal((await fetch(base + p, { method: "POST" })).status, 403, p);
  }
});

test("proc-info 返回启动方式 + 手动重启命令", async () => {
  assert.equal((await fetch(base + "/api/devbench/devmode/proc-info")).status, 403); // 无 token
  const d = await fetch(base + "/api/devbench/devmode/proc-info", { headers: TK() }).then((r) => r.json());
  assert.equal(d.ok, true);
  assert.ok(["web", "electron"].includes(d.data.mode));
  assert.ok(d.data.manualRestart && d.data.manualRestart.includes("server.js") || d.data.mode === "electron");
  assert.ok(d.data.port);
});

test("recording upload requires admin and generic recordings stay in OS temp", async () => {
  const url = `${base}/api/devbench/devmode/recording?root=${encodeURIComponent(tmp)}`;
  const denied = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "video/webm" },
    body: Buffer.from("fake-video"),
  });
  assert.equal(denied.status, 403);

  const saved = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "video/webm", ...TK() },
    body: Buffer.from("fake-video"),
  }).then((r) => r.json());
  assert.equal(saved.ok, true, saved.error);
  assert.ok(saved.data.path.endsWith(".webm"));
  assert.ok(saved.data.relPath.startsWith("devtool-recordings/"));
  assert.equal(path.resolve(saved.data.path).startsWith(path.resolve(tmp) + path.sep), false);
  assert.equal(fs.readFileSync(saved.data.path, "utf8"), "fake-video");

  const staleResponse = await fetch(`${url}&tabId=missing-tab-after-restart`, {
    method: "POST",
    headers: { "Content-Type": "video/webm", ...TK() },
    body: Buffer.from("fake-video-stale-tab"),
  });
  const stale = await staleResponse.json();
  assert.equal(staleResponse.status, 400);
  assert.equal(stale.ok, false);
  assert.match(stale.error, /拒绝回退到源码工程目录/);
  assert.equal(fs.existsSync(path.join(tmp, "docs", "tempFiles", "devtool-recordings")), false);

  const openDenied = await fetch(base + "/api/devbench/devmode/recording/open", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: saved.data.path }),
  });
  assert.equal(openDenied.status, 403);
  fs.rmSync(saved.data.path, { force: true });
});
