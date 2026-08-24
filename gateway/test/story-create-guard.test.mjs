import assert from "node:assert/strict";
import test from "node:test";
import {
  inspectStoryCreateRequest,
  isGeneratedE2eStoryTitle,
  isIsolatedDevbenchTestRuntime,
  storyCreateAuditFields,
} from "../services/devbench/story-create-guard.js";

test("只识别自动生成的 E2E 故事点标题，不拦截正常用户标题", () => {
  assert.equal(isGeneratedE2eStoryTitle("E2E e2e-1785407076148-h5q2"), true);
  assert.equal(isGeneratedE2eStoryTitle("e2e-1785407076148-h5q2"), false);
  assert.equal(isGeneratedE2eStoryTitle("avatr8678国家码问题"), false);
  assert.equal(isGeneratedE2eStoryTitle("E2E 联调问题"), false);
});

test("真实 Gateway 拒绝自动生成的 E2E 故事点", () => {
  const result = inspectStoryCreateRequest({
    title: "E2E e2e-1785407076148-h5q2",
    env: {},
  });
  assert.equal(result.ok, false);
  assert.equal(result.statusCode, 409);
  assert.equal(result.code, "E2E_STORY_REQUIRES_ISOLATED_RUNTIME");
});

test("只有 test 模式加独立 DB 和 store 才允许 E2E 故事点", () => {
  const complete = {
    NODE_ENV: "test",
    GATEWAY_DB_PATH: "D:/temp/e2e/gateway.db",
    DEVBENCH_STORE_DIR: "D:/temp/e2e/store",
  };
  assert.equal(isIsolatedDevbenchTestRuntime(complete), true);
  assert.equal(isIsolatedDevbenchTestRuntime({ ...complete, GATEWAY_DB_PATH: "" }), false);
  assert.equal(isIsolatedDevbenchTestRuntime({ ...complete, DEVBENCH_STORE_DIR: "" }), false);
  assert.equal(isIsolatedDevbenchTestRuntime({ ...complete, NODE_ENV: "production" }), false);

  const result = inspectStoryCreateRequest({
    title: "E2E e2e-1785407076148-h5q2",
    headers: { "x-devbench-e2e-run": "story-create-guard" },
    env: complete,
  });
  assert.deepEqual(result, {
    ok: true,
    automated: true,
    isolated: true,
    source: "e2e:story-create-guard",
  });
});

test("显式 E2E 请求头即使使用普通标题也不能写入真实 Gateway", () => {
  const result = inspectStoryCreateRequest({
    title: "普通标题",
    headers: { "X-Devbench-E2E-Run": "browser-acceptance" },
    env: { NODE_ENV: "production" },
  });
  assert.equal(result.ok, false);
  assert.equal(result.source, "e2e:browser-acceptance");
});

test("创建审计字段有长度边界并兼容大小写请求头", () => {
  const fields = storyCreateAuditFields({
    headers: {
      "X-Request-Id": "request-1",
      "X-Devbench-Request-Source": "story-entry",
      "User-Agent": `agent ${"x".repeat(300)}`,
    },
    ip: "127.0.0.1",
  });
  assert.equal(fields.requestId, "request-1");
  assert.equal(fields.source, "story-entry");
  assert.equal(fields.remote, "127.0.0.1");
  assert.equal(fields.userAgent.length, 160);
});
