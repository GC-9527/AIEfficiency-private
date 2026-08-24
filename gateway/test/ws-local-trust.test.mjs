import { test } from "node:test";
import assert from "node:assert/strict";
import { isLocalTrustedWsRequest } from "../services/ws-local-trust.js";

function req({ remote = "127.0.0.1", origin = null } = {}) {
  return {
    socket: { remoteAddress: remote },
    headers: origin === null ? {} : { origin },
  };
}

test("回环来源 + 本机 Origin → 本机可信（vite dev proxy / 直连 localhost 面板）", () => {
  assert.equal(isLocalTrustedWsRequest(req({ remote: "127.0.0.1", origin: "http://localhost:3000" })), true);
  assert.equal(isLocalTrustedWsRequest(req({ remote: "127.0.0.1", origin: "http://127.0.0.1:3000" })), true);
  assert.equal(isLocalTrustedWsRequest(req({ remote: "::1", origin: "http://localhost:3000" })), true);
});

test("回环来源 + IPv6 表示的回环主机 Origin → 本机可信", () => {
  assert.equal(isLocalTrustedWsRequest(req({ remote: "127.0.0.1", origin: "http://[::1]:3000" })), true);
  assert.equal(isLocalTrustedWsRequest(req({ remote: "::ffff:127.0.0.1", origin: "http://localhost:3001" })), true);
});

test("回环来源 + 无 Origin（桌面版 file:// 面板 / 本机 Node 工具）→ 本机可信", () => {
  assert.equal(isLocalTrustedWsRequest(req({ remote: "127.0.0.1", origin: null })), true);
  assert.equal(isLocalTrustedWsRequest(req({ remote: "::1", origin: "" })), true);
  // 浏览器规范：file:// 页面的 Origin 是字符串 "null"
  assert.equal(isLocalTrustedWsRequest(req({ remote: "127.0.0.1", origin: "null" })), true);
});

test("回环来源 + 非本机 Origin（恶意网页）→ 拒绝", () => {
  assert.equal(isLocalTrustedWsRequest(req({ remote: "127.0.0.1", origin: "https://evil.example.com" })), false);
  assert.equal(isLocalTrustedWsRequest(req({ remote: "127.0.0.1", origin: "http://192.168.10.99:8080" })), false);
});

test("非回环来源（LAN/远程）→ 一律拒绝（保持既有安全边界）", () => {
  assert.equal(isLocalTrustedWsRequest(req({ remote: "192.168.10.110", origin: "http://localhost:3000" })), false);
  assert.equal(isLocalTrustedWsRequest(req({ remote: "10.0.0.5", origin: null })), false);
  assert.equal(isLocalTrustedWsRequest(req({ remote: "172.16.129.94", origin: "http://localhost:3000" })), false);
});

test("畸形 Origin / 缺失 socket → 安全失败", () => {
  assert.equal(isLocalTrustedWsRequest(req({ remote: "127.0.0.1", origin: "not-a-url" })), false);
  assert.equal(isLocalTrustedWsRequest({}), false);
});
