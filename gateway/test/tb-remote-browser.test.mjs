import test from "node:test";
import assert from "node:assert/strict";
import {
  canUseLocalGuiBrowser,
  looksLikeTbWorkspaceUrl,
  cookiesToHeader,
  TB_VIEWER_PATH,
} from "../services/tb-browser-shared.js";

test("canUseLocalGuiBrowser: Windows with browser uses local GUI", () => {
  assert.equal(
    canUseLocalGuiBrowser({ platform: "win32", env: {}, browserPath: "C:\\\\Chrome\\\\chrome.exe" }),
    true,
  );
});

test("canUseLocalGuiBrowser: macOS with browser uses local GUI", () => {
  assert.equal(
    canUseLocalGuiBrowser({ platform: "darwin", env: {}, browserPath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" }),
    true,
  );
});

test("canUseLocalGuiBrowser: Linux without DISPLAY goes remote", () => {
  assert.equal(
    canUseLocalGuiBrowser({ platform: "linux", env: { DISPLAY: "" }, browserPath: "/usr/bin/chromium" }),
    false,
  );
});

test("canUseLocalGuiBrowser: Linux with DISPLAY can use local GUI", () => {
  assert.equal(
    canUseLocalGuiBrowser({ platform: "linux", env: { DISPLAY: ":0" }, browserPath: "/usr/bin/chromium" }),
    true,
  );
});

test("canUseLocalGuiBrowser: missing browser always false", () => {
  assert.equal(canUseLocalGuiBrowser({ platform: "win32", env: {}, browserPath: null }), false);
});

test("looksLikeTbWorkspaceUrl detects workspace vs account login", () => {
  assert.equal(looksLikeTbWorkspaceUrl("https://www.teambition.com/project/abc"), true);
  assert.equal(looksLikeTbWorkspaceUrl("https://account.teambition.com/login"), false);
  assert.equal(looksLikeTbWorkspaceUrl("https://www.teambition.com/login?from=account.teambition.com"), false);
});

test("cookiesToHeader joins cookie pairs", () => {
  assert.equal(
    cookiesToHeader([{ name: "a", value: "1" }, { name: "b", value: "2" }]),
    "a=1; b=2",
  );
});

test("TB_VIEWER_PATH is /tb-browser", () => {
  assert.equal(TB_VIEWER_PATH, "/tb-browser");
});

test("closing last viewer releases busy session so login can restart", async () => {
  const {
    attachTbBrowserViewer,
    detachTbBrowserViewer,
    countLiveRemoteViewers,
    cancelRemoteLogin,
    getRemoteLoginStatus,
    _resetRemoteSessionForTests,
    _setRemoteSessionForTests,
    _canAutoReplaceBusySessionForTests,
  } = await import("../services/tb-remote-browser.js");

  _resetRemoteSessionForTests();
  const fakeWs = {
    readyState: 1,
    send() {},
    on() {},
  };
  _setRemoteSessionForTests({
    busy: true,
    phase: "WAITING_FOR_SCAN",
    status: "waiting",
    viewers: new Set(),
  });
  assert.equal(attachTbBrowserViewer(fakeWs), true);
  assert.equal(countLiveRemoteViewers(), 1);
  assert.equal(_canAutoReplaceBusySessionForTests(), false);

  // 模拟客户端关闭页面：socket 已死 + detach
  fakeWs.readyState = 3;
  detachTbBrowserViewer(fakeWs);
  assert.equal(countLiveRemoteViewers(), 0);
  assert.equal(_canAutoReplaceBusySessionForTests(), true);

  await cancelRemoteLogin();
  const st = getRemoteLoginStatus();
  assert.equal(st.status, "cancelled");
  assert.equal(st.phase, "CANCELLED");
  assert.equal(st.busy, false);
  _resetRemoteSessionForTests();
});

test("cancelled remote session remains queryable after browser cleanup", async () => {
  const {
    cancelRemoteLogin,
    getRemoteLoginStatus,
    _resetRemoteSessionForTests,
    _setRemoteSessionForTests,
  } = await import("../services/tb-remote-browser.js");

  _resetRemoteSessionForTests();
  _setRemoteSessionForTests({
    browser: { close: async () => {} },
    phase: "WAITING_FOR_SCAN",
    status: "waiting",
  });
  assert.equal(await cancelRemoteLogin(), true);
  assert.deepEqual(
    Object.fromEntries(Object.entries(getRemoteLoginStatus()).filter(([key]) => ["status", "phase", "busy", "message"].includes(key))),
    { status: "cancelled", phase: "CANCELLED", busy: false, message: "登录已取消" },
  );
  _resetRemoteSessionForTests();
});

test("remote start failures remain queryable instead of falling back to idle", async () => {
  const {
    startRemoteLoginSession,
    getRemoteLoginStatus,
    _resetRemoteSessionForTests,
  } = await import("../services/tb-remote-browser.js");

  _resetRemoteSessionForTests();
  const missing = await startRemoteLoginSession({ browserPath: null });
  assert.equal(missing.success, false);
  assert.equal(getRemoteLoginStatus().status, "failed");
  assert.match(getRemoteLoginStatus().message, /未找到 Chromium\/Chrome/);

  _resetRemoteSessionForTests();
  const launchFailure = await startRemoteLoginSession({
    browserPath: "C:\\fake-chrome.exe",
    launch: async () => { throw new Error("launch rejected"); },
  });
  assert.equal(launchFailure.success, false);
  assert.deepEqual(
    { status: getRemoteLoginStatus().status, phase: getRemoteLoginStatus().phase, busy: getRemoteLoginStatus().busy },
    { status: "failed", phase: "FAILED", busy: false },
  );
  assert.match(getRemoteLoginStatus().message, /launch rejected/);
  _resetRemoteSessionForTests();
});

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function fakeBrowser() {
  let closes = 0;
  const cdp = { send: async () => {}, on() {} };
  const page = {
    setViewport: async () => {},
    createCDPSession: async () => cdp,
    goto: async () => {},
  };
  const browser = {
    newPage: async () => page,
    close: async () => { closes += 1; },
  };
  return { browser, get closes() { return closes; } };
}

test("cancelled remote generation cannot overwrite or close an immediately restarted session", async () => {
  const {
    startRemoteLoginSession,
    cancelRemoteLogin,
    getRemoteLoginStatus,
    _resetRemoteSessionForTests,
  } = await import("../services/tb-remote-browser.js");

  _resetRemoteSessionForTests();
  const firstWait = deferred();
  const secondWait = deferred();
  const first = fakeBrowser();
  const second = fakeBrowser();
  let firstFailed = 0;
  let secondFailed = 0;

  const firstStart = await startRemoteLoginSession({
    browserPath: "first-browser",
    launch: async () => first.browser,
    waitForLogin: async () => firstWait.promise,
    onFailed: () => { firstFailed += 1; },
  });
  assert.equal(firstStart.success, true);
  assert.equal(await cancelRemoteLogin(), true);
  assert.equal(firstFailed, 1);

  const secondStart = await startRemoteLoginSession({
    browserPath: "second-browser",
    launch: async () => second.browser,
    waitForLogin: async () => secondWait.promise,
    onFailed: () => { secondFailed += 1; },
  });
  assert.equal(secondStart.success, true);
  assert.equal(getRemoteLoginStatus().status, "waiting");

  firstWait.resolve({ success: false, reason: "closed" });
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(getRemoteLoginStatus().status, "waiting");
  assert.equal(getRemoteLoginStatus().busy, true);
  assert.equal(second.closes, 0);

  assert.equal(await cancelRemoteLogin(), true);
  assert.equal(secondFailed, 1);
  secondWait.resolve({ success: false, reason: "cancelled" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(getRemoteLoginStatus().status, "cancelled");
  _resetRemoteSessionForTests();
});
