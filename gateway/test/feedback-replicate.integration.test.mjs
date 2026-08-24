/**
 * 跨服务端 问题反馈同步 集成测试（隔离 db，无需多机）：
 *   - A：种子里有一条反馈（status=open）
 *   - B：空
 * 互为手动 peer。验证：
 *   1) B 经 gossip 拉到 A 的反馈；
 *   2) A 上更新该反馈（加评论，updated_at 抬升）后，B 经下一轮 reconcile 拿到"新者胜"的版本。
 * （反馈用 upsert 合并，区别于审计的 INSERT OR IGNORE，故专门验证更新传播。）
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { bootGateway, waitHealth, GW_DIR } from "./_helpers.mjs";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "fbrep-"));
const A = 39801, B = 39802, UDP = 48915;
const Adb = path.join(tmp, "a.db"), Bdb = path.join(tmp, "b.db");
const SEED_TS = 1700000000000; // 明确早于当前，确保后续 A 上更新的 updated_at 严格更大

// 独立进程把一条反馈写进 A 的隔离 db（写完即退出，释放句柄再 boot A）
execFileSync(process.execPath, ["-e",
  `import('./db/sqlite.js').then(m=>{m.upsertFeedback({id:'seed-fb-1',ts:${SEED_TS},updated_at:${SEED_TS},reporter_id:'zhangsan',reporter_name:'张三',reporter_kind:'name',title:'A的反馈',body:'种子',status:'open',priority:'high',node:'A'});})`],
  { cwd: GW_DIR, env: { ...process.env, GATEWAY_DB_PATH: Adb }, stdio: "ignore" });

const mk = (name, cfgObj) => { const p = path.join(tmp, name); fs.writeFileSync(p, JSON.stringify(cfgObj)); return p; };
const cfgA = mk("a.json", { role: "standalone", claudeProxy: { enabled: true, token: "feedback-peer-m2m", maxConcurrent: 3 }, servers: { nodeName: "服务端A", discovery: true, discoveryPort: UDP, peers: [`http://localhost:${B}`] } });
const cfgB = mk("b.json", { role: "standalone", claudeProxy: { enabled: true, token: "feedback-peer-m2m", maxConcurrent: 3 }, servers: { nodeName: "服务端B", discovery: true, discoveryPort: UDP, peers: [`http://localhost:${A}`] } });
const fbOnB = () => fetch(`http://localhost:${B}/api/feedback/since?since=0`).then((r) => r.json()).then((d) => (d.data || []).find((f) => f.id === "seed-fb-1"));

let srvA, srvB;
before(async () => {
  srvA = bootGateway({ port: A, role: "standalone", gwCfg: cfgA, market: path.join(tmp, "ma.json"), storeDir: path.join(tmp, "sa"), dbPath: Adb });
  srvB = bootGateway({ port: B, role: "standalone", gwCfg: cfgB, market: path.join(tmp, "mb.json"), storeDir: path.join(tmp, "sb"), dbPath: Bdb });
  await waitHealth(A, srvA); await waitHealth(B, srvB);
  await new Promise((r) => setTimeout(r, 11000)); // peer 轮询(8s)+reconcile 拉反馈
}, { timeout: 60000 });
after(() => { try { srvA.kill(); } catch {} try { srvB.kill(); } catch {} });

test("A 自身有种子反馈", async () => {
  const d = await fetch(`http://localhost:${A}/api/feedback/since?since=0`).then((r) => r.json());
  assert.ok(d.data.some((f) => f.id === "seed-fb-1" && f.reporter_name === "张三"));
});

test("B 经 gossip 复制到 A 的反馈", async () => {
  const e = await fbOnB();
  assert.ok(e, "B 应同步到 A 的反馈");
  assert.equal(e.title, "A的反馈");
  assert.equal(e.status, "open");
  assert.equal(e.node, "A");
});

test("A 上更新反馈(加评论)后，B 经下一轮 reconcile 拿到新者胜版本", async () => {
  // 在 A 上加评论 → updated_at 抬升（无需管理员）
  const r = await fetch(`http://localhost:${A}/api/feedback/seed-fb-1/comments`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: "A侧补充：必现", author: "张三" }),
  }).then((x) => x.json());
  assert.equal(r.ok, true);
  // 等下一轮 reconcile（每 8s）
  await new Promise((res) => setTimeout(res, 10000));
  const e = await fbOnB();
  assert.ok(e, "B 仍应有该反馈");
  assert.ok((e.comments || []).some((c) => c.text.includes("必现")), `B 应拿到更新后的评论(新者胜)，实际评论: ${JSON.stringify(e.comments)}`);
}, { timeout: 30000 });
