import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";

import {
  createGatewayWebSocket,
  getGatewayAdminToken,
  getGatewayUrl,
  getWsProtocols,
  getWsUrl,
  isGatewayAudienceUrl,
  openRemoteBrowserViewer,
  setGatewayAdminToken,
} from "./gateway.js";
import { authenticatedFetch } from "./adminAuth.js";

const originalWindow = globalThis.window;
const originalLocalStorage = globalThis.localStorage;
const originalWebSocket = globalThis.WebSocket;
const originalFetch = globalThis.fetch;

function createLocalStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem(key) {
      return values.has(key) ? values.get(key) : null;
    },
    setItem(key, value) {
      values.set(key, String(value));
    },
    removeItem(key) {
      values.delete(key);
    },
  };
}

function setBrowserLocation(url, storedGateway = "", electronAPI = null) {
  globalThis.window = {
    location: new URL(url),
    ...(electronAPI ? { electronAPI } : {}),
  };
  globalThis.localStorage = createLocalStorage(
    storedGateway ? { gateway_url: storedGateway } : {},
  );
}

beforeEach(() => {
  setBrowserLocation("http://127.0.0.1:3200/devbench");
});

afterEach(() => {
  globalThis.window = originalWindow;
  globalThis.localStorage = originalLocalStorage;
  globalThis.WebSocket = originalWebSocket;
  globalThis.fetch = originalFetch;
});

test("浏览器页面拒绝同主机不同端口的缓存网关", () => {
  setBrowserLocation("http://127.0.0.1:3200/devbench", "http://127.0.0.1:3201");

  assert.equal(getGatewayUrl(), "");
  assert.equal(localStorage.getItem("gateway_url"), null);
});

test("浏览器页面拒绝 loopback 别名和不同端口的缓存网关", () => {
  setBrowserLocation("http://127.0.0.1:3200/devbench", "http://localhost:3201");

  assert.equal(getGatewayUrl(), "");
  assert.equal(localStorage.getItem("gateway_url"), null);
});

test("同源缓存网关保持有效", () => {
  setBrowserLocation("http://127.0.0.1:3200/devbench", "http://127.0.0.1:3200");

  assert.equal(getGatewayUrl(), "http://127.0.0.1:3200");
  assert.equal(localStorage.getItem("gateway_url"), "http://127.0.0.1:3200");
});

test("不同主机的缓存网关失败关闭并清除", () => {
  setBrowserLocation("http://127.0.0.1:3200/devbench", "http://192.168.1.50:3201");

  assert.equal(getGatewayUrl(), "");
  assert.equal(localStorage.getItem("gateway_url"), null);
});

test("显式 gateway 查询参数拒绝同主机不同端口且不持久化", () => {
  setBrowserLocation(
    "http://127.0.0.1:3200/devbench?gateway=http%3A%2F%2F127.0.0.1%3A3201",
    "http://192.168.1.50:3201",
  );

  assert.equal(getGatewayUrl(), "");
  assert.equal(localStorage.getItem("gateway_url"), null);
});

test("同源 gateway 查询参数仅对当前导航生效且不持久化", () => {
  setBrowserLocation(
    "http://127.0.0.1:3200/devbench?gateway=http%3A%2F%2F127.0.0.1%3A3200",
  );

  assert.equal(getGatewayUrl(), "http://127.0.0.1:3200");
  assert.equal(localStorage.getItem("gateway_url"), null);
});

test("WebSocket URL 不携带管理员令牌，认证只使用受限子协议", () => {
  const token = "ab".repeat(24);
  setBrowserLocation("https://panel.example:3200/devbench", "https://panel.example:3200");
  setGatewayAdminToken(token);

  assert.equal(getWsUrl(), "wss://panel.example:3200/ws");
  assert.deepEqual(getWsProtocols(), [
    "aiefficiency.v1",
    `aiefficiency.auth.${token}`,
  ]);
});

test("WebSocket 构造器拒绝把损坏的本地令牌放入握手", () => {
  setBrowserLocation("http://127.0.0.1:3200/devbench");
  localStorage.setItem("admin_token", "bad token,with separators");
  let captured = null;
  globalThis.WebSocket = class {
    constructor(url, protocols) {
      captured = { url, protocols };
    }
  };

  createGatewayWebSocket();
  assert.deepEqual(captured, {
    url: "ws://127.0.0.1:3200/ws",
    protocols: ["aiefficiency.v1"],
  });
});

test("远程浏览器只在 URL fragment 传递一次性页面引导令牌", () => {
  const token = "cd".repeat(24);
  setBrowserLocation("https://panel.example:3200/devbench", "https://panel.example:3200");
  setGatewayAdminToken(token);
  let opened = "";
  window.open = (url) => {
    opened = url;
    return {};
  };

  const result = openRemoteBrowserViewer("/tb-browser", "tb-test");
  const parsed = new URL(result);
  assert.equal(parsed.searchParams.has("access_token"), false);
  assert.equal(
    new URLSearchParams(parsed.hash.slice(1)).get("access_token"),
    token,
  );
  assert.equal(opened, result);
});

test("普通 TB 用户远程扫码使用登录 challenge，不需要管理员令牌", () => {
  setBrowserLocation("https://panel.example:3200/settings", "https://panel.example:3200");
  let opened = "";
  window.open = (url) => { opened = url; return {}; };
  const loginChallenge = "a".repeat(43);
  const result = openRemoteBrowserViewer("/tb-browser", "tb-user-login", { loginChallenge });
  const parsed = new URL(result);
  const fragment = new URLSearchParams(parsed.hash.slice(1));
  assert.equal(fragment.get("login_challenge"), loginChallenge);
  assert.equal(fragment.has("access_token"), false);
  assert.equal(opened, result);
});

test("TB 管理员也会把当次登录 challenge 传给远程扫码页", () => {
  const token = "ef".repeat(24);
  const loginChallenge = "b".repeat(43);
  setBrowserLocation("https://panel.example:3200/admin", "https://panel.example:3200");
  setGatewayAdminToken(token);
  window.open = () => ({});

  const result = openRemoteBrowserViewer("/tb-browser", "tb-admin-login", { loginChallenge });
  const fragment = new URLSearchParams(new URL(result).hash.slice(1));
  assert.equal(fragment.get("access_token"), token);
  assert.equal(fragment.get("login_challenge"), loginChallenge);
});

test("HTTP page rejects query and stored Gateways on another browser host", () => {
  setBrowserLocation(
    "https://panel.example/devbench?gateway=https%3A%2F%2Fevil.example%3A3201",
    "https://other.example:3201",
  );
  localStorage.setItem("admin_token", "ef".repeat(24));

  assert.equal(getGatewayUrl(), "");
  assert.equal(localStorage.getItem("gateway_url"), null);
  assert.equal(getWsUrl(), "wss://panel.example/ws");
  assert.equal(getGatewayAdminToken("https://evil.example:3201/api/status"), "");
  assert.equal(isGatewayAudienceUrl("https://evil.example:3201/api/status"), false);
});

test("browser page rejects every same-host Gateway that is not same-origin", () => {
  setBrowserLocation(
    "https://panel.example:3200/devbench?gateway=https%3A%2F%2Fpanel.example",
  );

  assert.equal(getGatewayUrl(), "");
  assert.equal(localStorage.getItem("gateway_url"), null);
});

test("HTTPS page rejects a same-host HTTP downgrade", () => {
  setBrowserLocation(
    "https://panel.example:3200/devbench?gateway=http%3A%2F%2Fpanel.example%3A3201",
  );

  assert.equal(getGatewayUrl(), "");
});

test("file Electron renderer only trusts the preload-declared Gateway", () => {
  setBrowserLocation(
    "file:///dashboard/index.html?gateway=https%3A%2F%2Fevil.example%3A3201",
    "https://evil.example:3201",
    { isElectron: true, gatewayUrl: "http://localhost:3001" },
  );

  assert.equal(getGatewayUrl(), "http://localhost:3001");
  assert.equal(getWsUrl(), "ws://localhost:3001/ws");
  assert.equal(isGatewayAudienceUrl("http://localhost:3001/api/health"), true);
  assert.equal(isGatewayAudienceUrl("https://evil.example:3201/api/health"), false);
});

test("file renderer without a declared Electron Gateway fails closed", () => {
  setBrowserLocation(
    "file:///dashboard/index.html?gateway=http%3A%2F%2Flocalhost%3A3001",
    "http://localhost:3001",
    { isElectron: true },
  );

  assert.equal(getGatewayUrl(), "");
  assert.equal(getWsUrl(), "");
  assert.throws(() => createGatewayWebSocket(), /trusted Gateway audience/);
});

test("file Electron legacy token migrates only to the preload-declared Gateway", () => {
  const token = "01".repeat(24);
  setBrowserLocation(
    "file:///dashboard/index.html",
    "",
    { isElectron: true, gatewayUrl: "http://localhost:3001" },
  );
  localStorage.setItem("admin_token", token);

  assert.equal(
    getGatewayAdminToken("http://localhost:3001/api/health"),
    token,
  );
  assert.equal(
    localStorage.getItem("admin_token_audience"),
    "http://localhost:3001",
  );
  assert.equal(
    getGatewayAdminToken("http://localhost:3901/api/health"),
    "",
  );
});

test("WebSocket and viewer credentials are bound to the trusted Gateway origin", () => {
  const token = "12".repeat(24);
  setBrowserLocation("https://panel.example:3200/devbench", "https://panel.example:3200");
  setGatewayAdminToken(token);

  assert.deepEqual(getWsProtocols("wss://evil.example/ws"), ["aiefficiency.v1"]);
  assert.throws(
    () => createGatewayWebSocket("wss://evil.example/ws"),
    /trusted Gateway audience/,
  );

  let opened = "";
  window.open = (url) => { opened = url; };
  const result = openRemoteBrowserViewer("https://evil.example/tb-browser");
  assert.equal(new URL(result).hash, "");
  assert.equal(opened, result);
});

test("legacy token migrates only to the browser page origin", () => {
  const token = "34".repeat(24);
  setBrowserLocation("http://127.0.0.1:3200/devbench", "http://127.0.0.1:3200");
  localStorage.setItem("admin_token", token);

  assert.equal(
    getGatewayAdminToken("http://127.0.0.1:3200/api/status"),
    token,
  );
  assert.equal(localStorage.getItem("admin_token_audience"), "http://127.0.0.1:3200");
});

test("legacy token never migrates through a gateway query parameter", () => {
  const token = "56".repeat(24);
  setBrowserLocation(
    "http://127.0.0.1:3200/devbench?gateway=http%3A%2F%2Flocalhost%3A3201",
  );
  localStorage.setItem("admin_token", token);

  assert.equal(getGatewayAdminToken("http://localhost:3201/api/status"), "");
  assert.equal(localStorage.getItem("admin_token"), null);
  assert.equal(localStorage.getItem("admin_token_audience"), null);
});

test("恶意同主机 query 污染不能在无 query 重开后绑定 legacy token", () => {
  const token = "67".repeat(24);
  setBrowserLocation(
    "http://127.0.0.1:3200/devbench?gateway=http%3A%2F%2F127.0.0.1%3A3901",
  );

  // Step 1: the navigation-controlled port is rejected and never persisted.
  assert.equal(getGatewayUrl(), "");
  assert.equal(localStorage.getItem("gateway_url"), null);

  // Model storage left by an older vulnerable build, then reopen without the
  // query. The legacy bearer may bind only to the page origin, never that port.
  localStorage.setItem("gateway_url", "http://127.0.0.1:3901");
  localStorage.setItem("admin_token", token);
  window.location = new URL("http://127.0.0.1:3200/devbench");

  assert.equal(getGatewayUrl(), "");
  assert.equal(localStorage.getItem("gateway_url"), null);
  assert.equal(
    localStorage.getItem("admin_token_audience"),
    "http://127.0.0.1:3200",
  );
  assert.equal(
    getGatewayAdminToken("http://127.0.0.1:3901/api/status"),
    "",
  );
  assert.equal(
    getGatewayAdminToken("http://127.0.0.1:3200/api/status"),
    token,
  );
});

test("a bound token is cleared when its persisted audience does not match", () => {
  const token = "78".repeat(24);
  setBrowserLocation("https://panel.example/devbench");
  setGatewayAdminToken(token);
  assert.equal(localStorage.getItem("admin_token_audience"), "https://panel.example");

  localStorage.setItem("admin_token_audience", "https://panel.example:3201");
  assert.equal(
    getGatewayAdminToken("https://panel.example/api/status"),
    "",
  );
  assert.equal(localStorage.getItem("admin_token"), null);
  assert.equal(localStorage.getItem("admin_token_audience"), null);
});

test("authenticatedFetch adds bearer only for the current Gateway audience", async () => {
  const token = "9a".repeat(24);
  setBrowserLocation("https://panel.example/devbench");
  setGatewayAdminToken(token);
  const requests = [];
  globalThis.fetch = async (input, init) => {
    requests.push({ input, init });
    return { ok: true };
  };

  await authenticatedFetch("https://panel.example/api/status");
  await authenticatedFetch("https://evil.example/api/status", {
    headers: { Authorization: "Bearer caller-supplied-secret" },
  });

  assert.equal(requests[0].init.headers.get("Authorization"), `Bearer ${token}`);
  assert.equal(requests[1].init.headers.has("Authorization"), false);
});
