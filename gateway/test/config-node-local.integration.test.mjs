/**
 * 纯客户端 node 可登录本机管理员后切回本地模式；本机执行相关设置仍可在设置页直接保存。
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { totp } from "../services/totp.js";
import { bootGateway, waitHealth } from "./_helpers.mjs";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cfgnode-"));
const PORT = 39741;
const cfgPath = path.join(tmp, "gw.json");
const marketPath = path.join(tmp, "market.json");
const storeDir = path.join(tmp, "store");
const dbPath = path.join(tmp, "data.db");
const totpDir = path.join(tmp, "secrets");
const preparedRoot = path.join(tmp, "executor-test");
const configuredRoot = path.join(tmp, "configured-root");
const suggestedRoot = path.join(tmp, "suggested-executor-root");

fs.writeFileSync(cfgPath, JSON.stringify({
  role: "node",
  servers: { inboundToken: "", discovery: false },
  executor: { enabled: false, allowedRoots: [] },
  distributedExecution: { enabled: true, maxRounds: 12, requireRelativePaths: true, audit: true },
}, null, 2));
fs.writeFileSync(marketPath, JSON.stringify({ projects: [], cloneParent: suggestedRoot }, null, 2));

const base = `http://127.0.0.1:${PORT}`;
const srv = bootGateway({
  port: PORT,
  role: "node",
  gwCfg: cfgPath,
  market: marketPath,
  storeDir,
  dbPath,
  totpDir,
});
after(() => { try { srv.kill(); } catch {} });

const getCfg = () => fetch(`${base}/api/config`).then((r) => r.json()).then((d) => d.data);
const putCfg = (body, token) => fetch(`${base}/api/config`, {
  method: "PUT",
  headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
  body: JSON.stringify(body),
});

test("node 角色可无管理员保存本机执行设置；管理员登录后可切回本地模式", async () => {
  await waitHealth(PORT, srv);

  const cur = await getCfg();
  const local = await putCfg({
    ...cur,
    executor: { ...(cur.executor || {}), enabled: true, allowedRoots: [configuredRoot] },
    distributedExecution: { ...(cur.distributedExecution || {}), enabled: false, maxRounds: 4 },
    servers: { ...(cur.servers || {}), inboundToken: "node-local-token" },
  });
  assert.equal(local.status, 200);

  const afterLocal = await getCfg();
  assert.equal(afterLocal.executor.enabled, true);
  assert.deepEqual(afterLocal.executor.allowedRoots, [configuredRoot]);
  assert.equal(afterLocal.distributedExecution.enabled, false);
  assert.equal(afterLocal.distributedExecution.maxRounds, 4);
  assert.equal(afterLocal.servers.inboundToken, "node-local-token");

  const deniedRole = await putCfg({ ...afterLocal, role: "standalone" });
  assert.equal(deniedRole.status, 403);

  const deniedProxy = await putCfg({ ...afterLocal, claudeProxy: { ...(afterLocal.claudeProxy || {}), enabled: true } });
  assert.equal(deniedProxy.status, 403);

  const setup = await fetch(`${base}/api/admin/auth/totp/setup`).then((r) => r.json());
  const secret = setup.data?.secret || setup.secret;
  assert.ok(secret, "node 角色应能读取本机管理员 TOTP 初始化信息");
  const login = await fetch(`${base}/api/admin/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code: totp(secret) }),
  }).then((r) => r.json());
  assert.ok(login.ok && login.token, "node 角色应能登录本机管理员");

  const allowedRole = await putCfg({ ...afterLocal, role: "standalone" }, login.token);
  assert.equal(allowedRole.status, 200);
  assert.equal((await getCfg()).role, "standalone");

  const suggested = await fetch(`${base}/api/executor/suggested-root`).then((r) => r.json());
  assert.equal(suggested.ok, true);
  assert.equal(suggested.data.root, suggestedRoot);
  assert.equal(suggested.data.source, "cloneParent");

  const prepared = await fetch(`${base}/api/executor/prepare-root`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ root: preparedRoot }),
  });
  const preparedBody = await prepared.json();
  assert.equal(prepared.status, 200, preparedBody.error);
  assert.equal(preparedBody.ok, true);
  assert.equal(fs.existsSync(preparedRoot), true);

  const finalCfg = await getCfg();
  assert.equal(finalCfg.executor.enabled, true);
  assert.ok(finalCfg.executor.allowedRoots.includes(preparedRoot));

  const preparedSuggested = await fetch(`${base}/api/executor/prepare-root`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });
  const preparedSuggestedBody = await preparedSuggested.json();
  assert.equal(preparedSuggested.status, 200, preparedSuggestedBody.error);
  assert.equal(preparedSuggestedBody.data.root, suggestedRoot);
  assert.equal(fs.existsSync(suggestedRoot), true);
});
