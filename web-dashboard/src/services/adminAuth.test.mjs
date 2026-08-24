import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";

import {
  __resetAdminSessionForTests,
  getAdminSessionSnapshot,
  hasAdminPermission,
  refreshAdminSession,
} from "./adminAuth.js";
import { getGatewayAdminToken, setGatewayAdminToken } from "./gateway.js";

const originals = {
  window: globalThis.window,
  document: globalThis.document,
  localStorage: globalThis.localStorage,
  fetch: globalThis.fetch,
  WebSocket: globalThis.WebSocket,
  CustomEvent: globalThis.CustomEvent,
};

function createStorage() {
  const values = new Map();
  return {
    getItem: (key) => values.has(key) ? values.get(key) : null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: (key) => values.delete(key),
  };
}

function installBrowser() {
  const browser = new EventTarget();
  browser.location = new URL("http://127.0.0.1:3000/devbench");
  const documentTarget = new EventTarget();
  documentTarget.visibilityState = "visible";
  globalThis.window = browser;
  globalThis.document = documentTarget;
  globalThis.localStorage = createStorage();
  globalThis.WebSocket = undefined;
  if (typeof globalThis.CustomEvent !== "function") {
    globalThis.CustomEvent = class CustomEvent extends Event {
      constructor(type, options = {}) { super(type); this.detail = options.detail; }
    };
  }
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

async function waitFor(predicate, timeoutMs = 200) {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error("等待会话状态超时");
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

beforeEach(() => {
  installBrowser();
  __resetAdminSessionForTests();
});

afterEach(() => {
  __resetAdminSessionForTests();
  Object.assign(globalThis, originals);
});

test("同一 token 的并发身份校验只发出一个 single-flight 请求", async () => {
  const token = "aa".repeat(24);
  setGatewayAdminToken(token);
  const response = deferred();
  let calls = 0;
  globalThis.fetch = () => { calls += 1; return response.promise; };

  const first = refreshAdminSession({ force: true, timeoutMs: 0 });
  const second = refreshAdminSession({ timeoutMs: 0 });
  assert.equal(first, second);
  assert.equal(calls, 1);

  response.resolve(jsonResponse({ ok: true, data: {
    role: "admin", name: "管理员 A", capabilities: ["vehicle-config:edit"],
  } }));
  await first;
  assert.equal(getAdminSessionSnapshot().status, "authenticated");
});

test("token A 的迟到 401 不能覆盖或清除 token B", async () => {
  const tokenA = "ab".repeat(24);
  const tokenB = "bc".repeat(24);
  const requests = new Map();
  globalThis.fetch = (_input, init) => {
    const token = init.headers.Authorization.replace("Bearer ", "");
    const pending = deferred();
    requests.set(token, pending);
    return pending.promise;
  };

  setGatewayAdminToken(tokenA);
  const requestA = refreshAdminSession({ force: true, timeoutMs: 0 });
  setGatewayAdminToken(tokenB);
  const requestB = refreshAdminSession({ timeoutMs: 0 });

  requests.get(tokenB).resolve(jsonResponse({ ok: true, data: {
    role: "admin", name: "管理员 B", capabilities: ["vehicle-config:publish"],
  } }));
  await requestB;
  requests.get(tokenA).resolve(jsonResponse({ ok: false, error: "expired" }, 401));
  await requestA;

  assert.equal(getGatewayAdminToken("http://127.0.0.1:3000/api/admin/auth/me"), tokenB);
  assert.equal(getAdminSessionSnapshot().principal.name, "管理员 B");
});

test("超时进入 degraded 并保留主体展示，但修改 capability 失败关闭", async () => {
  const token = "cd".repeat(24);
  setGatewayAdminToken(token);
  globalThis.fetch = async () => jsonResponse({ ok: true, data: {
    role: "admin", name: "管理员", capabilities: ["vehicle-config:edit"],
  } });
  await refreshAdminSession({ force: true, timeoutMs: 0 });

  globalThis.fetch = (_input, init) => new Promise((_resolve, reject) => {
    init.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
  });
  await refreshAdminSession({ force: true, timeoutMs: 10 });

  const degraded = getAdminSessionSnapshot();
  assert.equal(degraded.status, "degraded");
  assert.equal(degraded.principal.name, "管理员");
  assert.equal(degraded.lastKnownAdmin, true);
  assert.equal(degraded.isAdmin, false);
  assert.equal(degraded.canMutate, false);
  assert.equal(hasAdminPermission(degraded, "vehicle-config:edit"), false);
});

test("当前 generation 的 401 原子清理 token 并发布 anonymous", async () => {
  setGatewayAdminToken("de".repeat(24));
  globalThis.fetch = async () => jsonResponse({ ok: false, error: "expired" }, 401);
  await refreshAdminSession({ force: true, timeoutMs: 0 });
  assert.equal(localStorage.getItem("admin_token"), null);
  assert.equal(getAdminSessionSnapshot().status, "anonymous");
});

test("同窗口 setGatewayAdminToken 事件实时触发共享身份校验", async () => {
  globalThis.fetch = async () => jsonResponse({ ok: true, data: {
    role: "super", name: "同窗口管理员", capabilities: ["*"],
  } });
  await refreshAdminSession({ force: true, timeoutMs: 0 });
  assert.equal(getAdminSessionSnapshot().status, "anonymous");

  setGatewayAdminToken("ef".repeat(24));
  await waitFor(() => getAdminSessionSnapshot().status === "authenticated");
  assert.equal(getAdminSessionSnapshot().principal.name, "同窗口管理员");
  assert.equal(hasAdminPermission(getAdminSessionSnapshot(), "admin:manage"), true);
});

test("唯一认证 WebSocket 收到授权失效后立即关闭修改权限并重新校验", async () => {
  const sockets = [];
  globalThis.WebSocket = class FakeWebSocket {
    constructor(url, protocols) {
      this.url = url;
      this.protocols = protocols;
      sockets.push(this);
    }
    close() { this.onclose?.(); }
  };
  const revalidation = deferred();
  let calls = 0;
  globalThis.fetch = () => {
    calls += 1;
    if (calls === 1) return Promise.resolve(jsonResponse({ ok: true, data: {
      role: "admin", name: "管理员", capabilities: ["vehicle-config:edit"],
    } }));
    return revalidation.promise;
  };

  setGatewayAdminToken("fa".repeat(24));
  await refreshAdminSession({ force: true, timeoutMs: 0 });
  assert.equal(sockets.length, 1);
  sockets[0].onmessage({ data: JSON.stringify({ type: "admin_authz_invalidated" }) });
  assert.equal(getAdminSessionSnapshot().status, "checking");
  assert.equal(getAdminSessionSnapshot().canMutate, false);

  revalidation.resolve(jsonResponse({ ok: true, data: {
    role: "admin", name: "管理员", capabilities: ["vehicle-config:read"],
  } }));
  await waitFor(() => getAdminSessionSnapshot().status === "authenticated");
  assert.equal(hasAdminPermission(getAdminSessionSnapshot(), "vehicle-config:edit"), false);
});
