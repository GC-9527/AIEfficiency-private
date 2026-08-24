/**
 * 管理员名单跨服务端同步集成测试：
 *   - A 有新增管理员，以及对另一个管理员的删除 tombstone
 *   - B 有该被删管理员的旧记录
 * 互为手动 peer。验证：B 经 discovery gossip 同步到 A 的新增与删除。
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { bootGateway, waitHealth, GW_DIR } from "./_helpers.mjs";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dbadminrep-"));
const A = 39521, B = 39522, UDP = 48915;
const Adb = path.join(tmp, "a.db"), Bdb = path.join(tmp, "b.db");

function seed(dbPath, script) {
  execFileSync(process.execPath, ["-e", `import('./db/sqlite.js').then((m)=>{${script}})`], {
    cwd: GW_DIR,
    env: { ...process.env, GATEWAY_DB_PATH: dbPath },
    stdio: "ignore",
  });
}

seed(Bdb, "m.addAdminUser({dingUserid:'tb-delete-me',name:'旧管理员',addedBy:'B',node:'B'});");
await new Promise((r) => setTimeout(r, 20));
seed(Adb, [
  "m.addAdminUser({dingUserid:'tb-active-a',name:'A管理员',addedBy:'A',node:'A'});",
  "m.addAdminUser({dingUserid:'tb-delete-me',name:'旧管理员',addedBy:'A',node:'A'});",
  "m.removeAdminUser('tb-delete-me');",
].join(""));

const mk = (name, cfgObj) => { const p = path.join(tmp, name); fs.writeFileSync(p, JSON.stringify(cfgObj)); return p; };
const cfgA = mk("a.json", { role: "standalone", claudeProxy: { enabled: true, token: "t", maxConcurrent: 3 }, servers: { nodeId: "copied-node-id", nodeName: "服务端A", discovery: true, discoveryPort: UDP, peers: [`http://localhost:${B}`] } });
const cfgB = mk("b.json", { role: "standalone", claudeProxy: { enabled: true, token: "t", maxConcurrent: 3 }, servers: { nodeId: "copied-node-id", nodeName: "服务端B", discovery: true, discoveryPort: UDP, peers: [`http://localhost:${A}`] } });

let srvA, srvB;
before(async () => {
  srvA = bootGateway({ port: A, role: "standalone", gwCfg: cfgA, market: path.join(tmp, "ma.json"), storeDir: path.join(tmp, "sa"), dbPath: Adb });
  srvB = bootGateway({ port: B, role: "standalone", gwCfg: cfgB, market: path.join(tmp, "mb.json"), storeDir: path.join(tmp, "sb"), dbPath: Bdb });
  await waitHealth(A, srvA);
  await waitHealth(B, srvB);
  await new Promise((r) => setTimeout(r, 11000));
}, { timeout: 60000 });

after(() => { try { srvA.kill(); } catch {} try { srvB.kill(); } catch {} });

test("nodeId 被复制时 B 仍经 gossip 同步到 A 的管理员新增与删除", async () => {
  const d = await fetch(`http://localhost:${B}/api/admin/users-since?since=0`).then((r) => r.json());
  assert.equal(d.ok, true);
  const active = d.data.find((x) => x.dingUserid === "tb-active-a");
  assert.ok(active, `B 应同步到 A 的新增管理员，实际: ${d.data.map((x) => x.dingUserid)}`);
  assert.equal(active.name, "A管理员");
  assert.equal(active.deletedAt || 0, 0);

  const deleted = d.data.find((x) => x.dingUserid === "tb-delete-me");
  assert.ok(deleted?.deletedAt > 0, "B 应同步到 A 的删除 tombstone，避免旧管理员复活");
});
