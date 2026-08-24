/**
 * 跨服务端 审计日志同步 集成测试（隔离 db，无需多机）：
 *   - A：种子里有一条审计
 *   - B：空
 * 互为手动 peer。验证：B 经 gossip 增量拉取到 A 的审计（B 本地查询即可见）。
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { bootGateway, waitHealth, GW_DIR } from "./_helpers.mjs";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dbaurep-"));
const A = 39501, B = 39502, UDP = 48913;
const Adb = path.join(tmp, "a.db"), Bdb = path.join(tmp, "b.db");
const SEED_TS = 1781000000000;

// 用独立进程把一条审计写进 A 的隔离 db（写完即退出，释放句柄再 boot A）
execFileSync(process.execPath, ["-e",
  `import('./db/sqlite.js').then(m=>{m.addAudit({id:'seed-A-1',ts:${SEED_TS},ip:'10.0.0.1',actor:'管理员A',role:'super',action:'仓库定义.新增',target:'repo:种子仓库',before:null,after:{name:'种子仓库'},node:'A'});})`],
  { cwd: GW_DIR, env: { ...process.env, GATEWAY_DB_PATH: Adb }, stdio: "ignore" });

const mk = (name, cfgObj) => { const p = path.join(tmp, name); fs.writeFileSync(p, JSON.stringify(cfgObj)); return p; };
const cfgA = mk("a.json", { role: "standalone", claudeProxy: { enabled: true, token: "t", maxConcurrent: 3 }, servers: { nodeName: "服务端A", discovery: true, discoveryPort: UDP, peers: [`http://localhost:${B}`] } });
const cfgB = mk("b.json", { role: "standalone", claudeProxy: { enabled: true, token: "t", maxConcurrent: 3 }, servers: { nodeName: "服务端B", discovery: true, discoveryPort: UDP, peers: [`http://localhost:${A}`] } });

let srvA, srvB;
before(async () => {
  srvA = bootGateway({ port: A, role: "standalone", gwCfg: cfgA, market: path.join(tmp, "ma.json"), storeDir: path.join(tmp, "sa"), dbPath: Adb });
  srvB = bootGateway({ port: B, role: "standalone", gwCfg: cfgB, market: path.join(tmp, "mb.json"), storeDir: path.join(tmp, "sb"), dbPath: Bdb });
  await waitHealth(A, srvA); await waitHealth(B, srvB);
  await new Promise((r) => setTimeout(r, 11000)); // 等 peer 轮询(8s)+reconcile 拉审计
}, { timeout: 60000 });
after(() => { try { srvA.kill(); } catch {} try { srvB.kill(); } catch {} });

test("A 自身有种子审计（audit-since 开放接口）", async () => {
  const d = await fetch(`http://localhost:${A}/api/devbench/audit-since?since=0`).then((r) => r.json());
  assert.equal(d.ok, true);
  assert.ok(d.data.some((e) => e.id === "seed-A-1" && e.actor === "管理员A"));
});

test("B 经 gossip 复制到 A 的审计", async () => {
  const d = await fetch(`http://localhost:${B}/api/devbench/audit-since?since=0`).then((r) => r.json());
  const e = d.data.find((x) => x.id === "seed-A-1");
  assert.ok(e, `B 应同步到 A 的审计，实际: ${d.data.map((x) => x.id)}`);
  assert.equal(e.actor, "管理员A");
  assert.equal(e.action, "仓库定义.新增");
  assert.equal(e.node, "A");
});
