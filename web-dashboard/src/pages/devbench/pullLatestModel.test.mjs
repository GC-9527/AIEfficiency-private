import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import { devbenchApi } from "./api.js";
import {
  bindPullLatestPreviewKeys,
  mergePullLatestExecution,
} from "./pullLatestModel.mjs";
import { setGatewayAdminToken } from "../../services/gateway.js";

const originalFetch = globalThis.fetch;
const originalWindow = globalThis.window;
const originalLocalStorage = globalThis.localStorage;

function createLocalStorage() {
  const values = new Map();
  return {
    getItem: (key) => values.has(key) ? values.get(key) : null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: (key) => values.delete(key),
  };
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  globalThis.window = originalWindow;
  globalThis.localStorage = originalLocalStorage;
});

test("PullLatest binds one durable idempotency key to each executable preview", () => {
  const generated = ["key-preview-a", "key-preview-b"];
  const rows = bindPullLatestPreviewKeys([
    { repositoryId: "a", ok: true, preview: { previewId: "preview-a", eligible: true } },
    { repositoryId: "b", ok: true, preview: { previewId: "preview-b", eligible: true } },
    { repositoryId: "blocked", ok: true, preview: { previewId: "preview-c", eligible: false } },
  ], () => generated.shift());

  assert.equal(rows[0].idempotencyKey, "key-preview-a");
  assert.equal(rows[1].idempotencyKey, "key-preview-b");
  assert.equal(rows[2].idempotencyKey, undefined);

  const rebound = bindPullLatestPreviewKeys(rows, () => {
    throw new Error("an existing preview key must be reused");
  });
  assert.equal(rebound[0].idempotencyKey, "key-preview-a");
  assert.equal(rebound[1].idempotencyKey, "key-preview-b");
});

test("PullLatest preserves the preview key after a lost or failed response", () => {
  const row = {
    repositoryId: "main",
    ok: true,
    preview: { previewId: "preview-main", eligible: true },
    idempotencyKey: "key-preview-main",
  };
  const failed = mergePullLatestExecution(row, {
    ok: false,
    code: "NETWORK_ERROR",
    error: "connection reset",
  });

  assert.equal(failed.idempotencyKey, "key-preview-main");
  assert.equal(failed.preview.previewId, "preview-main");
  assert.equal(failed.ok, false);
  assert.equal(failed.resultCode, "NETWORK_ERROR");

  const retried = mergePullLatestExecution(failed, {
    ok: true,
    data: { replayed: true },
  });
  assert.equal(retried.idempotencyKey, "key-preview-main");
  assert.equal(retried.ok, true);
});

test("Controller write API fails locally instead of inventing a retry key", async () => {
  let fetchCount = 0;
  globalThis.fetch = async () => {
    fetchCount += 1;
    throw new Error("fetch must not run");
  };

  const response = await devbenchApi.executeRemoteRefresh(
    "repository-main",
    {
      branch: "main",
      previewId: "preview-main",
      previewVersion: 1,
      candidateSha: "a".repeat(40),
    },
  );

  assert.equal(response.ok, false);
  assert.equal(response.code, "GIT_CONTROLLER_IDEMPOTENCY_KEY_REQUIRED");
  assert.equal(fetchCount, 0);
});

test("DevBench local Gateway fallback never forwards another origin's admin token", async () => {
  globalThis.window = { location: new URL("https://panel.example/devbench") };
  globalThis.localStorage = createLocalStorage();
  const token = "ab".repeat(24);
  setGatewayAdminToken(token);
  const requests = [];
  globalThis.fetch = async (input, init = {}) => {
    requests.push({ input: String(input), headers: new Headers(init.headers || {}) });
    return {
      ok: true,
      status: 200,
      json: async () => String(input).endsWith("/api/health")
        ? ({ status: "ok" })
        : ({ ok: true, data: { hasAccess: true } }),
    };
  };

  const result = await devbenchApi.repoAccess("ssh://example/repository.git");

  assert.equal(result.ok, true);
  assert.equal(requests.length, 2);
  assert.match(requests[0].input, /^http:\/\/127\.0\.0\.1:3001\/api\/health$/);
  assert.match(requests[1].input, /^http:\/\/127\.0\.0\.1:3001\/api\/devbench\/repo-access/);
  assert.equal(requests[0].headers.has("Authorization"), false);
  assert.equal(requests[1].headers.has("Authorization"), false);
  assert.equal(localStorage.getItem("admin_token"), token);
  assert.equal(
    localStorage.getItem("admin_token_audience"),
    "https://panel.example",
  );
});
