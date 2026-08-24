import assert from "node:assert/strict";
import test from "node:test";

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
};

const { devbenchApi } = await import("./api.js");

function captureFetch(response = { ok: true, data: {} }) {
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    return {
      ok: response.ok !== false,
      status: response.ok === false ? 404 : 200,
      json: async () => response,
    };
  };
  return calls;
}

function bodyOf(call) {
  return call.options.body ? JSON.parse(call.options.body) : null;
}

test("annotation 治理 API 使用 approve/revoke/restore-new 契约并保留 project/reason", async () => {
  const calls = captureFetch();
  await devbenchApi.approveAiTrainingAnnotation("project/a", "ANN/1", {
    reason: "二审一致",
    expectedRevision: 3,
  });
  await devbenchApi.revokeAiTrainingAnnotation("project/a", "ANN/1", {
    reason: "仓库选错",
    expectedRevision: 4,
  });
  await devbenchApi.restoreAiTrainingAnnotation("project/a", "CASE/1", "ANN/1", {
    reason: "重新标注",
  });

  assert.match(calls[0].url, /\/ai-training\/v2\/annotations\/ANN%2F1\/approve$/);
  assert.equal(calls[0].options.method, "POST");
  assert.deepEqual(bodyOf(calls[0]), {
    reason: "二审一致",
    expectedRevision: 3,
    projectId: "project/a",
  });
  assert.match(calls[1].url, /\/ai-training\/v2\/annotations\/ANN%2F1\/revoke$/);
  assert.equal(bodyOf(calls[1]).reason, "仓库选错");
  assert.match(calls[2].url, /\/ai-training\/v2\/cases\/CASE%2F1\/annotations$/);
  assert.equal(bodyOf(calls[2]).restoredFromAnnotationId, "ANN/1");
});

test("知识值治理区分共享 revision 与 node 本机绑定", async () => {
  const calls = captureFetch();
  await devbenchApi.createAiTrainingKnowledgeValueDraft("project-1", "K/1", {
    actualValue: "release/avatr8678",
    scope: "environment",
    scopeId: "prod",
    reason: "升级分支",
    expectedRevision: 6,
  });
  await devbenchApi.approveAiTrainingKnowledgeValue("project-1", "V/7", {
    reason: "审批通过",
    expectedRevision: 7,
  });
  await devbenchApi.activateAiTrainingKnowledgeValue("project-1", "V/7", {
    reason: "发布",
    expectedRevision: 7,
  });
  await devbenchApi.rollbackAiTrainingKnowledgeValue("project-1", "V/7", {
    targetRevisionId: "V/5",
    reason: "回滚",
    expectedRevision: 8,
  });
  await devbenchApi.upsertAiTrainingMachineBinding("project-1", "K/1", {
    actualValue: "D:\\workspace\\repo",
    reason: "本机 checkout",
    expectedRevision: 2,
  });

  assert.match(calls[0].url, /\/knowledge-keys\/K%2F1\/values$/);
  assert.equal(bodyOf(calls[0]).status, "draft");
  assert.equal(bodyOf(calls[0]).scope, "environment");
  assert.match(calls[1].url, /\/knowledge-values\/V%2F7\/approve$/);
  assert.match(calls[2].url, /\/knowledge-values\/V%2F7\/activate$/);
  assert.match(calls[3].url, /\/knowledge-values\/V%2F7\/rollback$/);
  assert.equal(bodyOf(calls[3]).targetRevisionId, "V/5");
  assert.match(calls[4].url, /\/machine-bindings\/K%2F1$/);
  assert.equal(calls[4].options.method, "PUT");
  assert.equal(bodyOf(calls[4]).scope, "node");
});

test("治理接口 404 不会被前端 API 包装成成功", async () => {
  captureFetch({ ok: false, error: "治理接口尚未启用" });
  const result = await devbenchApi.getAiTrainingGovernanceSummary("project-1");
  assert.equal(result.ok, false);
  assert.equal(result.error, "治理接口尚未启用");
});

test("故事点初始化请求超时会中止等待并返回可重试失败", async () => {
  const originalFetch = globalThis.fetch;
  const originalSetTimeout = globalThis.setTimeout;
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
  try {
    const result = await devbenchApi.prepareStoryInitialization({ title: "超时测试" });
    assert.equal(capturedSignal?.aborted, true);
    assert.equal(result.ok, false);
    assert.equal(result.code, "REQUEST_TIMEOUT");
    assert.equal(result.retryable, true);
    assert.match(result.error, /请求超时/);
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.setTimeout = originalSetTimeout;
  }
});
