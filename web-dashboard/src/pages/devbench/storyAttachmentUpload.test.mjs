import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";

const storage = new Map();
globalThis.localStorage = {
  getItem: (key) => storage.get(key) || null,
  setItem: (key, value) => storage.set(key, String(value)),
  removeItem: (key) => storage.delete(key),
};
globalThis.window = {
  location: {
    search: "",
    protocol: "http:",
    hostname: "127.0.0.1",
    origin: "http://127.0.0.1:3200",
  },
  electronAPI: null,
  addEventListener() {},
  removeEventListener() {},
  dispatchEvent() {},
};

const originalFetch = globalThis.fetch;
const originalSetTimeout = globalThis.setTimeout;
const { setGatewayAdminToken } = await import("../../services/gateway.js");
const { __resetAdminSessionForTests } = await import("../../services/adminAuth.js");
const { devbenchApi } = await import("./api.js");
const token = "6a".repeat(24);

beforeEach(() => {
  storage.clear();
  assert.equal(setGatewayAdminToken(token), true);
});

afterEach(() => {
  __resetAdminSessionForTests();
  globalThis.fetch = originalFetch;
  globalThis.setTimeout = originalSetTimeout;
});

test("34MiB 故事点附件使用统一登录凭证和二进制请求体", async () => {
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    return new Response(JSON.stringify({
      ok: true,
      data: {
        name: "attachment-34m.bin",
        relPath: "storydev:/archives/batch/attachment-34m.bin",
        size: 34 * 1024 * 1024,
      },
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
  const file = {
    name: "attachment-34m.bin",
    size: 34 * 1024 * 1024,
  };

  const result = await devbenchApi.uploadFile("story-1", file, "batch/attachment-34m.bin");

  assert.equal(result.ok, true);
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /\/api\/devbench\/tabs\/story-1\/upload\?filename=batch%2Fattachment-34m\.bin$/);
  assert.equal(calls[0].options.method, "POST");
  assert.equal(new Headers(calls[0].options.headers).get("Authorization"), `Bearer ${token}`);
  assert.equal(new Headers(calls[0].options.headers).get("Content-Type"), "application/octet-stream");
  assert.equal(calls[0].options.body, file);
  assert.equal(calls[0].options.signal?.aborted, false);
});

test("附件网络请求永久不返回时会中止并返回可重试终态", async () => {
  let capturedSignal = null;
  globalThis.fetch = async (_url, options = {}) => new Promise((_resolve, reject) => {
    capturedSignal = options.signal;
    options.signal?.addEventListener("abort", () => {
      const error = new Error("aborted");
      error.name = "AbortError";
      reject(error);
    }, { once: true });
  });
  globalThis.setTimeout = (callback, _timeout, ...args) => originalSetTimeout(callback, 0, ...args);

  const result = await devbenchApi.uploadFile(
    "story-1",
    { name: "stalled-34m.bin", size: 34 * 1024 * 1024 },
    "batch/stalled-34m.bin",
  );

  assert.equal(capturedSignal?.aborted, true);
  assert.equal(result.ok, false);
  assert.equal(result.code, "ATTACHMENT_UPLOAD_TIMEOUT");
  assert.equal(result.retryable, true);
  assert.match(result.error, /已停止等待/);
});

test("附件 HTTP 失败不会被包装成上传成功", async () => {
  globalThis.fetch = async () => new Response(JSON.stringify({
    ok: true,
    error: "payload too large",
  }), {
    status: 413,
    headers: { "Content-Type": "application/json" },
  });

  const result = await devbenchApi.uploadFile(
    "story-1",
    { name: "rejected.bin", size: 34 * 1024 * 1024 },
    "batch/rejected.bin",
  );

  assert.equal(result.ok, false);
  assert.equal(result.error, "payload too large");
});
