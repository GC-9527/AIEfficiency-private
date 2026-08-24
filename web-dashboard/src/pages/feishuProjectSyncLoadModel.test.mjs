import test from "node:test";
import assert from "node:assert/strict";

import {
  FEISHU_SYNC_ERROR_REQUESTS,
  FEISHU_SYNC_INITIAL_REQUESTS,
  createFeishuProjectSyncLoader,
  feishuMcpConnectionStatus,
} from "./feishuProjectSyncLoadModel.js";

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

test("initial requests are exposed independently so a hung config cannot block page reveal", async () => {
  const config = deferred();
  const records = deferred();
  const calls = [];
  const loader = createFeishuProjectSyncLoader({
    request: (path) => {
      calls.push(path);
      if (path === FEISHU_SYNC_INITIAL_REQUESTS.config.path) return config.promise;
      if (path === FEISHU_SYNC_INITIAL_REQUESTS.records.path) return records.promise;
      throw new Error(`unexpected request ${path}`);
    },
  });

  const loading = loader.loadInitial();
  await Promise.resolve();

  assert.deepEqual(calls.sort(), [
    FEISHU_SYNC_INITIAL_REQUESTS.config.path,
    FEISHU_SYNC_INITIAL_REQUESTS.records.path,
  ].sort());

  const configRace = await Promise.race([
    loading.config.then(() => "config"),
    Promise.resolve("page-ready"),
  ]);
  assert.equal(configRace, "page-ready");

  records.resolve([]);
  assert.equal((await loading.records).ok, true);
  config.resolve({ config: { enabled: true } });
  assert.equal((await loading.config).ok, true);
});

test("initial request contract excludes remote target verification and heavy error payloads", () => {
  const initialPaths = Object.values(FEISHU_SYNC_INITIAL_REQUESTS).map((item) => item.path);
  assert.equal(initialPaths.some((path) => path.includes("verifyTargets")), false);
  assert.equal(initialPaths.some((path) => path.includes("resetMissingTargets")), false);
  assert.equal(initialPaths.some((path) => path.includes("raw-payloads")), false);
  assert.equal(initialPaths.some((path) => path.includes("/errors")), false);
  assert.equal(FEISHU_SYNC_INITIAL_REQUESTS.records.path.includes("enrich=0"), true);
});

test("error details are lazy, metadata-only, cached, and force-refreshable", async () => {
  const calls = [];
  const loader = createFeishuProjectSyncLoader({
    request: async (path) => {
      calls.push(path);
      return [{ path }];
    },
  });

  assert.equal(calls.length, 0);
  const first = await loader.loadErrors();
  assert.equal(first.failures.length, 0);
  assert.equal(calls.length, FEISHU_SYNC_ERROR_REQUESTS.length);
  assert.equal(
    FEISHU_SYNC_ERROR_REQUESTS.find((item) => item.key === "rawPayloads").path.includes("includePayload=0"),
    true,
  );

  const cached = await loader.loadErrors();
  assert.equal(cached.cached, true);
  assert.equal(calls.length, FEISHU_SYNC_ERROR_REQUESTS.length);

  await loader.loadErrors({ force: true });
  assert.equal(calls.length, FEISHU_SYNC_ERROR_REQUESTS.length * 2);
});

test("concurrent error-tab loads share one request batch", async () => {
  const gate = deferred();
  let calls = 0;
  const loader = createFeishuProjectSyncLoader({
    request: async () => {
      calls += 1;
      await gate.promise;
      return [];
    },
  });

  const first = loader.loadErrors();
  const second = loader.loadErrors();
  await Promise.resolve();
  assert.equal(calls, FEISHU_SYNC_ERROR_REQUESTS.length);
  gate.resolve();
  assert.deepEqual(await first, await second);
});

test("a failed MCP probe never reports a stale connection as currently ready", () => {
  const status = feishuMcpConnectionStatus({
    checked: true,
    configured: true,
    connected: false,
    lastConnected: true,
    degraded: true,
    error: "MCP 状态检测暂时失败",
    toolCount: 48,
  });

  assert.equal(status.ok, false);
  assert.equal(status.label, "连接检查失败");
  assert.match(status.detail, /检测暂时失败/);
});
