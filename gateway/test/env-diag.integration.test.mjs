/**
 * 环境诊断/仓库权限/管理员联系 集成测试（起一台隔离网关，真实探测本机环境）。
 * 注意：env-install 只测错误路径，不真正触发 winget 安装。
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { bootGateway, waitHealth, apiGet } from "./_helpers.mjs";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dbenv-"));
const PORT = 39201;
const market = path.join(tmp, "market.json");
const localBareRepo = path.join(tmp, "accessible.git");
execFileSync("git", ["init", "--bare", localBareRepo], { windowsHide: true, stdio: "ignore" });
// 预置一个可访问仓库(沿用默认 appMarket 种子) + 一个铁定无法访问的仓库
fs.writeFileSync(market, JSON.stringify({
  projectDefs: [
    { id: "appMarket", name: "应用市场", ssh: "git@codeup.aliyun.com:xunihezi/AppMarket.git" },
    { id: "bad", name: "坏仓库", ssh: "git@127.0.0.1:nope/none.git" },
    { id: "fallback", name: "回退仓库", ssh: localBareRepo, https: `https://127.0.0.1:${PORT}/fallback.git` },
    { id: "credential", name: "凭证仓库", https: `https://alice:secret@127.0.0.1:${PORT}/nope.git` },
  ],
}));
fs.writeFileSync(path.join(tmp, "gw.json"), JSON.stringify({ role: "standalone" }));

let gw;
before(async () => {
  gw = bootGateway({ port: PORT, role: "standalone", gwCfg: path.join(tmp, "gw.json"), market, storeDir: path.join(tmp, "store") });
  await waitHealth(PORT, gw);
}, { timeout: 45000 });
after(() => { try { gw.kill(); } catch {} });

test("env-check：结构 + 必需项(git/java) + okToCompile 布尔", async () => {
  const d = await apiGet(PORT, "/env-check");
  assert.equal(d.ok, true);
  const keys = d.data.results.map((r) => r.key);
  assert.deepEqual(keys, ["git", "java", "adb", "node"]);
  const git = d.data.results.find((r) => r.key === "git");
  assert.equal(git.required, true);
  assert.equal(typeof git.installed, "boolean");
  assert.equal(typeof d.data.okToCompile, "boolean");
  assert.equal(typeof d.data.hasWinget, "boolean");
  // 本机装了 git/java，应可编译
  assert.equal(d.data.okToCompile, d.data.results.filter((r) => r.required).every((r) => r.installed));
});

test("env-install：未知工具 → 拒绝", async () => {
  const r = await fetch(`http://localhost:${PORT}/api/devbench/env-install`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ tool: "不存在" }),
  }).then((x) => x.json());
  assert.equal(r.ok, false);
  assert.match(r.error, /未知工具/);
});

test("repo-access：未知仓库 → 错误", async () => {
  const d = await apiGet(PORT, "/repo-access?repo=不存在的仓库");
  assert.equal(d.ok, false);
  assert.match(d.error, /未知仓库/);
});

test("repo-access：无法访问的仓库 → hasAccess=false（无需真实凭证）", async () => {
  const d = await apiGet(PORT, "/repo-access?repo=bad");
  assert.equal(d.ok, true);
  assert.equal(d.data.hasAccess, false);
  assert.ok(d.data.error, "应带 ls-remote 失败原因");
});

test("repo-access：HTTPS 不可用时回退到可访问的备用地址", async () => {
  const d = await apiGet(PORT, "/repo-access?repo=fallback&refresh=1");
  assert.equal(d.ok, true);
  assert.equal(d.data.hasAccess, true);
  assert.equal(d.data.url, localBareRepo);
  assert.deepEqual(d.data.attempts.map((attempt) => attempt.ok), [false, true]);
});

test("remote-branches：分支查询复用相同的认证回退结果", async () => {
  const d = await apiGet(PORT, "/remote-branches?repo=fallback&refresh=1");
  assert.equal(d.ok, true);
  assert.deepEqual(d.data, []);
  assert.equal(d.url, localBareRepo);
  assert.equal(d.fallback, true);
});

test("remote-branches：失败响应不会泄露 HTTPS 内嵌凭证", async () => {
  const d = await apiGet(PORT, "/remote-branches?repo=credential&refresh=1");
  assert.equal(d.ok, false);
  const serialized = JSON.stringify(d);
  assert.doesNotMatch(serialized, /alice|secret/);
  assert.match(d.url, /\*\*\*/);
});

test("admin-contacts：返回数组（standalone 直读本地 admin_users）", async () => {
  const d = await apiGet(PORT, "/admin-contacts");
  assert.equal(d.ok, true);
  assert.ok(Array.isArray(d.data));
  // 名单为空或含 {name,dingUserid}
  for (const c of d.data) { assert.ok("name" in c); assert.ok("dingUserid" in c); }
});

test("env-ai-models：结构含 engines/summary/可见模型", async () => {
  const d = await apiGet(PORT, "/env-ai-models");
  assert.equal(d.ok, true);
  assert.ok(Array.isArray(d.data.engines));
  assert.equal(d.data.engines.length, 6);
  assert.ok(d.data.summary);
  assert.equal(typeof d.data.summary.installed, "number");
  for (const eng of d.data.engines) {
    assert.ok(["claude", "codex", "gemini", "hermes", "opencode", "arkcli"].includes(eng.id));
    assert.ok(Array.isArray(eng.models));
    assert.ok(Array.isArray(eng.latestModels));
    assert.ok(["up_to_date", "outdated", "not_installed", "unknown"].includes(eng.status));
  }
}, { timeout: 90000 });

test("env-ai-upgrade：未知引擎 → 拒绝", async () => {
  const r = await fetch(`http://localhost:${PORT}/api/devbench/env-ai-upgrade`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ engine: "nope" }),
  }).then((x) => x.json());
  assert.equal(r.ok, false);
  assert.match(r.error, /未知引擎/);
});
