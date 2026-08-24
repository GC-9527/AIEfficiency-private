import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import express from "express";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "admin-auth-routes-"));
process.env.NODE_ENV = "production";
process.env.GATEWAY_CONFIG_PATH = path.join(tempDir, "gateway.json");
process.env.GATEWAY_DB_PATH = path.join(tempDir, "gateway.db");
process.env.ADMIN_TOTP_DIR = path.join(tempDir, "secrets");
fs.writeFileSync(process.env.GATEWAY_CONFIG_PATH, "{}");

let baseUrl;
let server;
let auth;
let db;
let totp;
let adminRoute;
let tbChallenge;

before(async () => {
  auth = await import("../services/admin-auth.js");
  db = await import("../db/sqlite.js");
  totp = await import("../services/totp.js");
  adminRoute = await import("../routes/admin.js");
  tbChallenge = await import("../services/tb-login-challenge.js");
  const app = express();
  app.use(express.json());
  app.use("/api/admin", adminRoute.default);
  await new Promise((resolve) => {
    server = app.listen(0, "127.0.0.1", resolve);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
});

async function json(pathname, options = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, options);
  return { response, body: await response.json() };
}

test("production disables body-spoofed Ding login and requires a one-time TB browser challenge", async () => {
  const ding = await json("/api/admin/auth/ding-login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ dingUserid: "spoofed-admin" }),
  });
  assert.equal(ding.response.status, 410);
  assert.equal(ding.body.code, "LEGACY_DING_LOGIN_DISABLED");
  assert.match(ding.response.headers.get("cache-control") || "", /no-store/);

  const tb = await json("/api/admin/auth/tb-login", { method: "POST" });
  assert.equal(tb.response.status, 401);
  assert.equal(tb.body.code, "TB_LOGIN_CHALLENGE_INVALID");
});

test("completed TB challenge still needs explicit ordinary-admin membership", async () => {
  const userId = "57ad8e2fa45d0cba20025b7a";
  let challenge = tbChallenge.beginTbLoginChallenge();
  assert.equal(tbChallenge.completeTbLoginChallenge(challenge, { userId, name: "普通 TB 用户" }), true);
  const ordinary = await json("/api/admin/auth/tb-login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ loginChallenge: challenge }),
  });
  assert.equal(ordinary.response.status, 403);
  assert.equal(ordinary.body.code, "ADMIN_MEMBERSHIP_REQUIRED");

  db.addAdminUser({ subject: { issuer: "teambition", id: userId }, name: "TB 普通管理员", addedBy: "test" });
  challenge = tbChallenge.beginTbLoginChallenge();
  tbChallenge.completeTbLoginChallenge(challenge, { userId, name: "TB 普通管理员" });
  const admin = await json("/api/admin/auth/tb-login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ loginChallenge: challenge }),
  });
  assert.equal(admin.response.status, 200);
  assert.equal(admin.body.role, "admin");
  assert.deepEqual(admin.body.subject, { issuer: "teambition", id: userId });
  assert.equal(admin.body.authMethod, "teambition_login");
});

test("remote TOTP setup payload never contains the secret before or after enrollment", () => {
  const config = {
    enrolled: false,
    account: "admin",
    issuer: "AIEfficiency",
    secret: "MUST_NOT_LEAK",
    otpauth: "otpauth://must-not-leak",
  };
  const beforeEnrollment = adminRoute.totpSetupPayload(config, { localAccess: false });
  assert.equal("secret" in beforeEnrollment, false);
  assert.equal("otpauth" in beforeEnrollment, false);
  const afterEnrollment = adminRoute.totpSetupPayload({ ...config, enrolled: true }, { localAccess: false });
  assert.equal("secret" in afterEnrollment, false);
  assert.equal("otpauth" in afterEnrollment, false);
  assert.equal(adminRoute.totpSetupPayload(config, { localAccess: true }).secret, "MUST_NOT_LEAK");
  assert.equal(adminRoute.totpSetupPayload({ ...config, enrolled: true }, { localAccess: true }).secret, "MUST_NOT_LEAK");
});

test("TOTP setup honors the original proxy peer; reset requires local authenticated super and revokes its session", async () => {
  const setup = await json("/api/admin/auth/totp/setup");
  assert.ok(setup.body.data.secret, "loopback setup keeps the local bootstrap path");
  const login = await json("/api/admin/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code: totp.totp(setup.body.data.secret, {}) }),
  });
  assert.equal(login.response.status, 200);
  assert.equal(login.body.role, "super");

  const meBefore = await json("/api/admin/auth/me", {
    headers: { Authorization: `Bearer ${login.body.token}` },
  });
  assert.equal(meBefore.response.status, 200);
  assert.equal(meBefore.body.data.authMethod, "totp");
  assert.deepEqual(meBefore.body.data.subject, { issuer: "local", id: "totp-super" });
  assert.match(meBefore.response.headers.get("cache-control") || "", /no-store/);

  const enrolledSetup = await json("/api/admin/auth/totp/setup");
  assert.ok(enrolledSetup.body.data.secret, "gateway-local binding must keep the enrolled key visible for re-binding");

  const proxiedRemoteSetup = await json("/api/admin/auth/totp/setup", {
    headers: { "X-Forwarded-For": "127.0.0.1, 203.0.113.25" },
  });
  assert.equal("secret" in proxiedRemoteSetup.body.data, false, "prepended loopback XFF must not bypass local-only setup");

  const unauthenticatedReset = await json("/api/admin/auth/totp/reset", { method: "POST" });
  assert.equal(unauthenticatedReset.response.status, 401);

  const proxiedRemoteReset = await json("/api/admin/auth/totp/reset", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${login.body.token}`,
      "X-Forwarded-For": "127.0.0.1, 203.0.113.25",
    },
  });
  assert.equal(proxiedRemoteReset.response.status, 403);

  const reset = await json("/api/admin/auth/totp/reset", {
    method: "POST",
    headers: { Authorization: `Bearer ${login.body.token}` },
  });
  assert.equal(reset.response.status, 200);
  const meAfter = await json("/api/admin/auth/me", {
    headers: { Authorization: `Bearer ${login.body.token}` },
  });
  assert.equal(meAfter.response.status, 401);
  assert.equal(meAfter.body.code, "AUTH_REQUIRED");
});

test("overview aggregates revision, users and at most 50 first-screen audit rows", async () => {
  const setup = await json("/api/admin/auth/totp/setup");
  const login = await json("/api/admin/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code: totp.totp(setup.body.data.secret, {}) }),
  });
  const authorization = { Authorization: `Bearer ${login.body.token}` };

  const added = await json("/api/admin/users", {
    method: "POST",
    headers: { ...authorization, "Content-Type": "application/json" },
    body: JSON.stringify({ dingUserid: "overview-admin", name: "Overview Admin", role: "super" }),
  });
  assert.equal(added.response.status, 200);
  assert.equal(added.body.data.role, "admin");

  for (let index = 0; index < 60; index += 1) {
    db.addAudit({
      id: `overview-audit-${index}`,
      ts: Date.now() + index,
      actor: "test",
      role: "super",
      action: "test.overview",
      target: String(index),
    });
  }

  const overview = await json("/api/admin/overview", { headers: authorization });
  assert.equal(overview.response.status, 200);
  assert.equal(overview.body.data.bootstrap.adminCount, overview.body.data.users.length);
  assert.ok(overview.body.data.revision > 0);
  assert.equal(overview.body.data.audit.length, 50);
  assert.ok(overview.body.data.users.some((user) => user.dingUserid === "overview-admin" && user.role === "admin"));

  const indexes = db.default.prepare("PRAGMA index_list('admin_audit')").all();
  assert.ok(indexes.some((index) => index.name === "idx_admin_audit_ts_id"));
  assert.equal(auth.isSuperPrincipal(auth.verifyToken(login.body.token)), true);
});

test("TOTP login is rate limited by the proxy-preserved original client", async () => {
  const headers = {
    "Content-Type": "application/json",
    "X-Forwarded-For": "198.51.100.44",
  };
  for (let index = 0; index < 4; index += 1) {
    const attempt = await json("/api/admin/auth/login", {
      method: "POST",
      headers,
      body: JSON.stringify({ code: "000000" }),
    });
    assert.equal(attempt.response.status, 401);
  }
  const blocked = await json("/api/admin/auth/login", {
    method: "POST",
    headers,
    body: JSON.stringify({ code: "000000" }),
  });
  assert.equal(blocked.response.status, 429);
  assert.equal(blocked.body.code, "TOTP_RATE_LIMITED");
  assert.ok(Number(blocked.response.headers.get("retry-after")) > 0);
});
