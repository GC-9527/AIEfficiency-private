import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tb-cookie-login-"));
process.env.GATEWAY_CONFIG_PATH = path.join(tmp, "gateway.json");
fs.writeFileSync(process.env.GATEWAY_CONFIG_PATH, JSON.stringify({}));

const {
  probeTbCookie,
  verifyAndSaveTbCookie,
  waitForVerifiedTbLogin,
} = await import("../services/tb-browser-shared.js");
const { getConfig, updateConfig } = await import("../services/config.js");
const { checkTbCookie } = await import("../services/teambition.js");

function response(body, status = 200, headers = { "Content-Type": "application/json" }) {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers });
}

test("Cookie 探测：缺失、有效和过期返回稳定状态码且不回传 Cookie", async () => {
  let called = false;
  const missing = await probeTbCookie("", { request: async () => { called = true; } });
  assert.equal(missing.code, "COOKIE_MISSING");
  assert.equal(missing.hasCookie, false);
  assert.equal(called, false);

  const cookie = "TEAMBITION_SESSIONID=top-secret";
  const valid = await probeTbCookie(cookie, {
    request: async (_url, options) => {
      assert.equal(options.headers.Cookie, cookie);
      assert.equal(options.redirect, "manual");
      return response({ _id: "user-1", name: "测试用户", email: "test@example.com" });
    },
    now: () => Date.parse("2026-08-03T00:00:00.000Z"),
  });
  assert.equal(valid.code, "COOKIE_VALID");
  assert.equal(valid.user, "测试用户");
  assert.equal(valid.checkedAt, "2026-08-03T00:00:00.000Z");
  assert.doesNotMatch(JSON.stringify(valid), /top-secret/);

  const expired = await probeTbCookie(cookie, { request: async () => response({ message: "Unauthorized" }, 401) });
  assert.equal(expired.code, "COOKIE_EXPIRED");
  assert.match(expired.reason, /重新登录/);
  assert.doesNotMatch(JSON.stringify(expired), /top-secret/);

  const forbidden = await probeTbCookie(cookie, { request: async () => response({ message: "Forbidden" }, 403) });
  assert.equal(forbidden.code, "COOKIE_EXPIRED");
});

test("Cookie 探测：登录 HTML、服务异常和网络异常不会误报 Cookie 过期", async () => {
  const loginRedirect = await probeTbCookie("sid=old", {
    request: async () => response("", 302, { Location: "https://account.teambition.com/login" }),
  });
  assert.equal(loginRedirect.code, "COOKIE_EXPIRED");

  const maintenanceRedirect = await probeTbCookie("sid=kept", {
    request: async () => response("", 302, { Location: "https://status.teambition.com/maintenance" }),
  });
  assert.equal(maintenanceRedirect.code, "TB_UNAVAILABLE");
  assert.match(maintenanceRedirect.reason, /稍后重试/);

  const html = await probeTbCookie("sid=old", {
    request: async () => response("<!doctype html><html><title>登录</title></html>", 200, { "Content-Type": "text/html" }),
  });
  assert.equal(html.code, "COOKIE_EXPIRED");

  const loginForm = await probeTbCookie("sid=old", {
    request: async () => response("<html><title>Teambition</title><input type=\"password\"></html>", 200, { "Content-Type": "text/html" }),
  });
  assert.equal(loginForm.code, "COOKIE_EXPIRED");

  const maintenanceHtml = await probeTbCookie("sid=kept", {
    request: async () => response("<!doctype html><html><title>系统维护中</title></html>", 200, { "Content-Type": "text/html" }),
  });
  assert.equal(maintenanceHtml.code, "TB_UNAVAILABLE");
  assert.match(maintenanceHtml.reason, /稍后重试/);

  const ordinaryHtml = await probeTbCookie("sid=bad", {
    request: async () => response("<!doctype html><html><title>Unexpected page</title></html>", 200, { "Content-Type": "text/html" }),
  });
  assert.equal(ordinaryHtml.code, "COOKIE_INVALID");

  const serverError = await probeTbCookie("sid=kept", { request: async () => response({ message: "busy" }, 503) });
  assert.equal(serverError.code, "TB_UNAVAILABLE");
  assert.match(serverError.reason, /稍后重试/);

  const throttled = await probeTbCookie("sid=kept", { request: async () => response({ message: "slow down" }, 429) });
  assert.equal(throttled.code, "TB_UNAVAILABLE");

  const invalid = await probeTbCookie("sid=bad", { request: async () => response({ message: "bad cookie sid=bad" }, 200) });
  assert.equal(invalid.code, "COOKIE_INVALID");
  assert.doesNotMatch(JSON.stringify(invalid), /sid=bad/);

  const networkError = await probeTbCookie("sid=kept", { request: async () => { throw new Error("ECONNRESET sid=kept"); } });
  assert.equal(networkError.code, "TB_UNAVAILABLE");
  assert.match(networkError.reason, /检查网络/);
  assert.doesNotMatch(JSON.stringify(networkError), /sid=kept|ECONNRESET/);
});

test("浏览器提取必须等到 Cookie 验证成功，不能保存首个部分 Cookie", async () => {
  let tick = 0;
  let validations = 0;
  const states = [];
  const page = {
    url: () => "https://www.teambition.com/project/demo",
    cookies: async () => [{ name: "sid", value: tick < 1 ? "partial" : "ready" }],
  };
  const browser = { isConnected: () => true };
  const login = await waitForVerifiedTbLogin({
    page,
    browser,
    maxWaitMs: 20,
    pollMs: 1,
    recheckMs: 1,
    now: () => tick,
    sleep: async () => { tick += 1; },
    onState: (state) => states.push(state.status),
    validateCookie: async (cookie) => {
      validations += 1;
      if (cookie.includes("partial")) return { valid: false, status: "invalid", code: "COOKIE_INVALID" };
      return {
        valid: true,
        status: "valid",
        code: "COOKIE_VALID",
        userInfo: { userId: "user-ready", name: "已登录用户" },
      };
    },
  });
  assert.equal(login.success, true);
  assert.equal(login.cookie, "sid=ready");
  assert.equal(login.userInfo.name, "已登录用户");
  assert.equal(validations, 2);
  assert.deepEqual(states, ["verifying", "waiting", "verifying"]);
});

test("公共 Cookie 检查接口模型只返回必要用户字段和过期状态", async () => {
  const originalFetch = globalThis.fetch;
  updateConfig({ teambition: { ...getConfig().teambition, userCookie: "sid=stored-secret" } });
  globalThis.fetch = async () => response({ message: "Unauthorized" }, 403);
  try {
    const health = await checkTbCookie();
    assert.equal(health.status, "expired");
    assert.equal(health.code, "COOKIE_EXPIRED");
    assert.equal(health.hasCookie, true);
    assert.doesNotMatch(JSON.stringify(health), /stored-secret|userInfo|email/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("手工候选 Cookie 先验证再原子保存，失败时保留旧值", async () => {
  updateConfig({ teambition: { ...getConfig().teambition, userCookie: "sid=original" } });

  const rejected = await verifyAndSaveTbCookie("sid=invalid", {
    validateCookie: async () => ({ valid: false, status: "invalid", code: "COOKIE_INVALID", reason: "无效" }),
  });
  assert.equal(rejected.valid, false);
  assert.equal(getConfig().teambition.userCookie, "sid=original");

  const accepted = await verifyAndSaveTbCookie("sid=replacement", {
    validateCookie: async () => ({
      valid: true,
      status: "valid",
      code: "COOKIE_VALID",
      reason: "Cookie 有效",
      userInfo: { userId: "manual-user", name: "手工验证用户" },
    }),
  });
  assert.equal(accepted.valid, true);
  assert.equal(getConfig().teambition.userCookie, "sid=replacement");
  assert.equal(getConfig().teambition.operatorId, "manual-user");
});

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function fakeLocalBrowser() {
  let closes = 0;
  const page = { goto: async () => {} };
  const browser = {
    newPage: async () => page,
    close: async () => { closes += 1; },
  };
  return { browser, get closes() { return closes; } };
}

test("本机登录取消后立即重启时，旧任务不得关闭或改写新会话", async () => {
  const {
    cancelTbLogin,
    getTbLoginStatus,
    _extractTbCookieLocalForTests,
    _resetLocalSessionForTests,
  } = await import("../services/tb-cookie-extractor.js");

  await _resetLocalSessionForTests();
  const firstWait = deferred();
  const secondWait = deferred();
  const first = fakeLocalBrowser();
  const second = fakeLocalBrowser();

  const firstRun = _extractTbCookieLocalForTests({
    browserPath: "first-browser",
    launch: async () => first.browser,
    waitForLogin: async () => firstWait.promise,
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(getTbLoginStatus().status, "waiting");
  assert.equal(await cancelTbLogin(), true);

  const secondRun = _extractTbCookieLocalForTests({
    browserPath: "second-browser",
    launch: async () => second.browser,
    waitForLogin: async () => secondWait.promise,
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(getTbLoginStatus().status, "waiting");

  firstWait.resolve({ success: false, reason: "cancelled" });
  assert.equal((await firstRun).success, false);
  assert.equal(getTbLoginStatus().status, "waiting");
  assert.equal(getTbLoginStatus().busy, true);
  assert.equal(second.closes, 0);

  assert.equal(await cancelTbLogin(), true);
  secondWait.resolve({ success: false, reason: "cancelled" });
  assert.equal((await secondRun).success, false);
  assert.equal(getTbLoginStatus().status, "cancelled");
  await _resetLocalSessionForTests();
});

test("进行中的远程会话优先于本机残留终态", async () => {
  const {
    getTbLoginStatus,
    _extractTbCookieLocalForTests,
    _resetLocalSessionForTests,
  } = await import("../services/tb-cookie-extractor.js");
  const {
    _resetRemoteSessionForTests,
    _setRemoteSessionForTests,
  } = await import("../services/tb-remote-browser.js");

  await _resetLocalSessionForTests();
  _resetRemoteSessionForTests();
  await _extractTbCookieLocalForTests({ browserPath: null });
  assert.equal(getTbLoginStatus().status, "failed");

  _setRemoteSessionForTests({ status: "waiting", phase: "WAITING_FOR_SCAN", busy: true });
  assert.deepEqual(
    { mode: getTbLoginStatus().mode, status: getTbLoginStatus().status, busy: getTbLoginStatus().busy },
    { mode: "remote", status: "waiting", busy: true },
  );

  _resetRemoteSessionForTests();
  await _resetLocalSessionForTests();
});
