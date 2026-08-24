/**
 * 管理后台鉴权单元测试：token 签发/校验/吊销、requireAuth 角色门、超管 TOTP 登录、非名单钉钉/TB 用户拒绝。
 */
import { test, before } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dbauth-"));
process.env.GATEWAY_CONFIG_PATH = path.join(tmp, "gw.json");
process.env.GATEWAY_DB_PATH = path.join(tmp, "data.db"); // 令牌现持久化到 DB，隔离避免污染真实库
process.env.ADMIN_TOTP_DIR = path.join(tmp, "secrets");
fs.writeFileSync(process.env.GATEWAY_CONFIG_PATH, JSON.stringify({
  servers: { inboundToken: "unit-m2m-token" },
}));

let auth, totpMod, totpStore, db, logger, m2m;
before(async () => {
  auth = await import("../services/admin-auth.js");
  totpMod = await import("../services/totp.js");
  totpStore = await import("../services/admin-totp-store.js");
  db = await import("../db/sqlite.js");
  logger = await import("../services/logger.js");
  m2m = await import("../services/m2m-auth.js");
});

// 模拟 Express res
function mockRes() {
  return { _status: 200, _json: null, status(c) { this._status = c; return this; }, json(o) { this._json = o; return this; } };
}

test("token：签发→校验→吊销", () => {
  const t = auth.issueToken({ role: "super", name: "超管", dingUserid: null });
  const p = auth.verifyToken(t);
  assert.equal(p.role, "super");
  auth.revokeToken(t);
  assert.equal(auth.verifyToken(t), null);
});

test("token：无效/空 token 返回 null", () => {
  assert.equal(auth.verifyToken(""), null);
  assert.equal(auth.verifyToken("deadbeef"), null);
  assert.equal(auth.verifyToken(null), null);
});

test("token：持久化到 DB（重启可恢复），吊销即删", () => {
  const t = auth.issueToken({ role: "super", name: "超管", dingUserid: null });
  const persisted = db.loadAuthTokens();
  assert.ok(
    persisted.some((r) => /^sha256:[0-9a-f]{64}$/.test(r.tokenHash) && r.data.role === "super"),
    "DB 仅持久化不可逆 token 摘要，重启时可恢复",
  );
  assert.ok(!persisted.some((r) => r.tokenHash === t), "DB 不得持久化 bearer 明文");
  auth.revokeToken(t);
  assert.equal(db.loadAuthTokens().length, 0, "吊销后从 DB 删除");
});

test("requireAuth：无 token → 401", () => {
  const res = mockRes(); let nextCalled = false;
  auth.requireAuth()({ headers: {} }, res, () => { nextCalled = true; });
  assert.equal(res._status, 401);
  assert.equal(nextCalled, false);
});

test("requireAuth：角色不符 → 403；符合 → next", () => {
  const t = auth.issueToken({ role: "admin", name: "管理员" });
  // 要求 super，admin 不符 → 403
  let res = mockRes();
  auth.requireAuth(["super"])({ headers: { authorization: `Bearer ${t}` } }, res, () => {});
  assert.equal(res._status, 403);
  // 要求 super|admin，admin 符合 → next + principal
  res = mockRes(); let req = { headers: { authorization: `Bearer ${t}` } }; let ok = false;
  auth.requireAuth(["super", "admin"])(req, res, () => { ok = true; });
  assert.equal(ok, true);
  assert.equal(req.principal.role, "admin");
});

test("超管 TOTP 登录：正确码通过、错误码拒绝", () => {
  const { secret } = totpStore.getTotpConfig(); // 在隔离目录生成密钥
  const code = totpMod.totp(secret, {});
  const ok = auth.superAdminLogin(code);
  assert.equal(ok.ok, true);
  assert.equal(ok.role, "super");
  assert.ok(ok.token);
  assert.equal(auth.superAdminLogin("000000").ok, false);
});

test("超管 TOTP：首次登录后标记 enrolled", () => {
  totpStore.getTotpConfig();
  const code = totpMod.totp(totpStore.getTotpConfig().secret, {});
  auth.superAdminLogin(code);
  assert.equal(totpStore.getTotpConfig().enrolled, true);
});

test("钉钉与 TB 普通用户都不能绕过管理员名单", () => {
  const dingResult = auth.dingUserLogin("不存在的uid_" + Date.now(), "路人");
  assert.equal(dingResult.ok, false);
  assert.match(dingResult.error, /不是管理员/);

  const tbResult = auth.tbUserLogin("不存在的tb_uid_" + Date.now(), "路人");
  assert.equal(tbResult.ok, false);
  assert.equal(tbResult.code, "ADMIN_MEMBERSHIP_REQUIRED");
});

test("TB 名单成员签发普通管理员而不是超级管理员", () => {
  const id = "57ad8e2fa45d0cba20025b7b";
  const member = db.addAdminUser({ subject: { issuer: "teambition", id }, name: "TB 管理员", addedBy: "test" });
  assert.equal(member.subjectId, `teambition:${id}`);
  const login = auth.tbUserLogin(id, "TB 管理员");
  assert.equal(login.ok, true);
  assert.equal(login.role, "admin");
  assert.equal(login.authMethod, "teambition_login");
  assert.equal(auth.isSuperPrincipal(auth.verifyToken(login.token)), false);
});

test("管理员名单删除使用 tombstone，普通查询不返回且可增量同步", () => {
  const id = "tb-admin-tombstone-" + Date.now();
  db.addAdminUser({ dingUserid: id, name: "临时管理员", addedBy: "test" });
  assert.equal(db.getAdminUser(id)?.name, "临时管理员");

  db.removeAdminUser(id);
  assert.equal(db.getAdminUser(id), null);
  assert.ok(!db.listAdminUsers().some((u) => u.dingUserid === id));

  const row = db.listAdminUsersSince(0).find((u) => u.dingUserid === id);
  assert.ok(row?.deletedAt > 0, "删除标记需要保留用于局域网同步");
});

test("超管密钥重置后旧码失效", () => {
  const oldSecret = totpStore.getTotpConfig().secret;
  totpStore.resetTotp();
  const newSecret = totpStore.getTotpConfig().secret;
  assert.notEqual(oldSecret, newSecret);
  const oldCode = totpMod.totp(oldSecret, {});
  // 旧码对新密钥无效（极小概率碰撞，可接受）
  assert.equal(auth.superAdminLogin(oldCode).ok, false);
});

test("removing an administrator immediately invalidates every issued provider token", () => {
  const id = `admin-revoke-${Date.now()}`;
  db.addAdminUser({ dingUserid: id, name: "revoked admin", role: "super", addedBy: "test" });
  const login = auth.dingUserLogin(id, "revoked admin");
  assert.equal(login.ok, true);
  assert.equal(auth.verifyToken(login.token)?.role, "admin");

  db.removeAdminUser(id);
  assert.equal(auth.verifyToken(login.token), null);

  db.addAdminUser({ dingUserid: id, name: "re-added admin", addedBy: "test" });
  assert.equal(auth.verifyToken(login.token), null, "re-adding membership must not resurrect a revoked token");
});

test("database and replication roles are normalized to admin and cannot mint super", () => {
  const id = `admin-role-${Date.now()}`;
  const inserted = db.addAdminUser({ dingUserid: id, name: "role test", role: "super", addedBy: "test" });
  assert.equal(inserted.role, "admin");
  const login = auth.dingUserLogin(id, "role test");
  assert.equal(login.ok, true);
  assert.equal(login.role, "admin");
  assert.equal(auth.verifyToken(login.token)?.role, "admin");

  const merged = db.mergeAdminUser({
    dingUserid: id,
    name: "replicated role test",
    role: "super",
    updatedAt: inserted.updatedAt + 10,
  });
  assert.equal(merged.role, "admin");
  assert.equal(auth.verifyToken(login.token), null, "authorization revision changes revoke the old token");
});

test("public principal contract is stable and exposes centralized capabilities", () => {
  const id = `admin-contract-${Date.now()}`;
  db.addAdminUser({ dingUserid: id, name: "contract admin", addedBy: "test" });
  const login = auth.dingUserLogin(id, "contract admin");
  const principal = auth.verifyToken(login.token);
  const publicValue = auth.publicPrincipal(principal);
  assert.deepEqual(publicValue.subject, { issuer: "dingtalk", id });
  assert.equal(publicValue.subjectId, `dingtalk:${id}`);
  assert.equal(publicValue.authMethod, "dingtalk_oauth");
  assert.equal(auth.isAdminPrincipal(principal), true);
  assert.equal(auth.isSuperPrincipal(principal), false);
  assert.ok(publicValue.capabilities.includes("admin:read"));
  for (const capability of [
    "vehicle-config:read",
    "vehicle-config:edit",
    "vehicle-config:publish",
    "vehicle-config:retry",
    "vehicle-config:resolve",
  ]) {
    assert.equal(auth.hasPermission(principal, capability), true, capability);
  }
  assert.equal(auth.hasPermission(principal, "vehicle-config:force-repair"), false);
  assert.equal(auth.isSuperPrincipal({
    role: "super",
    authMethod: "totp",
    subject: { issuer: "local", id: "totp-super" },
    forwardedByM2M: true,
  }), false, "M2M-forwarded principals can never assert super");
});

test("administrator membership revision emits a WS invalidation event", () => {
  const messages = [];
  logger.setWsClients(new Set([{ readyState: 1, send(message) { messages.push(JSON.parse(message)); } }]));
  try {
    const id = `admin-ws-${Date.now()}`;
    const user = db.addAdminUser({ dingUserid: id, name: "ws admin", addedBy: "test" });
    const event = messages.find((message) => message.type === "admin_authz_invalidated" && message.data.subjectId === `dingtalk:${id}`);
    assert.ok(event);
    assert.equal(event.data.reason, "upsert");
    assert.ok(event.data.revision > 0);
    assert.ok(user.updatedAt > 0);
  } finally {
    logger.setWsClients(new Set());
  }
});

test("TOTP reset revokes all existing super sessions", () => {
  const secret = totpStore.getTotpConfig().secret;
  const login = auth.superAdminLogin(totpMod.totp(secret, {}));
  assert.equal(login.ok, true);
  assert.equal(auth.verifyToken(login.token)?.role, "super");

  totpStore.resetTotp();
  assert.ok(auth.revokeSuperSessions({ reason: "test-reset" }) >= 1);
  assert.equal(auth.verifyToken(login.token), null);
});

test("requireAuth returns stable 401 and 403 codes", () => {
  let response = mockRes();
  auth.requireAdmin({ headers: {} }, response, () => {});
  assert.equal(response._status, 401);
  assert.equal(response._json.code, "AUTH_REQUIRED");

  const viewer = auth.issueToken({ role: "viewer", name: "viewer" });
  response = mockRes();
  auth.requireAdmin(
    { headers: { authorization: `Bearer ${viewer}` } },
    response,
    () => assert.fail("viewer must not pass requireAdmin"),
  );
  assert.equal(response._status, 403);
  assert.equal(response._json.code, "PERMISSION_DENIED");
});

test("M2M 管理员委托必须匹配当前成员、请求摘要、短时效并一次性消费", () => {
  const id = `m2m-admin-${Date.now()}`;
  const member = db.addAdminUser({ dingUserid: id, name: "M2M 管理员", addedBy: "test" });
  const login = auth.dingUserLogin(id, member.name, { authMethod: "dingtalk_oauth" });
  const principal = auth.verifyToken(login.token);
  const request = {
    method: "PUT",
    originalUrl: "/api/devbench/project-defs",
    body: { id: "repo-a", name: "Repo A" },
    headers: { authorization: "Bearer unit-m2m-token" },
  };
  request.headers[m2m.FORWARDED_PRINCIPAL_HEADER] = m2m.encodeForwardedPrincipal(
    principal,
    m2m.forwardedRequestBinding(request),
  );

  const delegated = auth.requestPrincipal(request, { allowM2M: true });
  assert.equal(delegated?.role, "admin");
  assert.equal(delegated?.subject?.id, id);
  assert.equal(delegated?.authzRevision, member.updatedAt);
  assert.equal(auth.requestPrincipal(request, { allowM2M: true }), null, "nonce replay must fail closed");

  const changedBody = { ...request, body: { id: "repo-b", name: "Repo B" } };
  assert.equal(auth.requestPrincipal(changedBody, { allowM2M: true }), null, "request digest mismatch must fail closed");

  const freshHeader = m2m.encodeForwardedPrincipal(principal, m2m.forwardedRequestBinding(request));
  db.removeAdminUser(id);
  const revokedRequest = {
    ...request,
    headers: { ...request.headers, [m2m.FORWARDED_PRINCIPAL_HEADER]: freshHeader },
  };
  assert.equal(auth.requestPrincipal(revokedRequest, { allowM2M: true }), null, "center membership removal must revoke delegation");
});
