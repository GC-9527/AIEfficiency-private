import { test } from "node:test";
import assert from "node:assert/strict";

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

const { devbenchApi, getClosedStoryPurgePartialResult } = await import("./api.js");

test("物理删除 API 在网络拒绝和异常 HTTP 状态下始终返回可恢复失败", async () => {
  globalThis.fetch = async () => { throw new Error("socket closed"); };
  const networkFailure = await devbenchApi.previewClosedStoryPurge("closed-1");
  assert.equal(networkFailure.ok, false);
  assert.equal(networkFailure.code, "NETWORK_ERROR");
  assert.match(networkFailure.error, /socket closed/);

  globalThis.fetch = async () => ({
    ok: false,
    status: 500,
    json: async () => ({ ok: true }),
  });
  const contradictoryHttpFailure = await devbenchApi.purgeClosedStory("closed-1", {
    confirmId: "closed-1",
    expectedClosedAt: 123,
  });
  assert.equal(contradictoryHttpFailure.ok, false, "HTTP 非 2xx 不能被响应体中的 ok:true 覆盖");
  assert.equal(contradictoryHttpFailure.error, "HTTP 500");
});

test("只把服务端明确标记的删除执行结果识别为部分完成，预检 data 不能冒充已删除明细", () => {
  const previewData = {
    story: { id: "closed-1", closedAt: 123 },
    core: { executionHistory: { safeToDelete: false, sharedBy: [{ id: "closed-2" }] } },
  };
  assert.equal(getClosedStoryPurgePartialResult({
    ok: false,
    code: "UNSAFE_ARCHIVE_DIRECTORY",
    error: "预检拒绝",
    data: previewData,
  }), null);
  assert.equal(getClosedStoryPurgePartialResult({
    ok: false,
    code: "AI_RUNNING_ON_OTHER_GATEWAY",
    error: "其它节点仍在执行",
    data: { taskIds: ["task-1"] },
  }), null);

  const executionData = {
    story: { id: "closed-1", status: "pending" },
    core: {},
    conversationBackups: { status: "preserved" },
    archiveDirectory: { status: "failed" },
    attachments: { status: "preserved" },
  };
  for (const code of [
    "RESOURCE_DELETE_FAILED",
    "CORE_DELETE_FAILED",
    "EXECUTION_HISTORY_DELETE_FAILED",
    "CLOSED_RECORD_DELETE_FAILED",
    "DELETE_MARKER_FAILED",
  ]) {
    assert.equal(getClosedStoryPurgePartialResult({ ok: false, partial: true, code, data: executionData }), executionData, code);
    assert.equal(getClosedStoryPurgePartialResult({ ok: false, code, data: executionData }), null, `${code} 缺少服务端 partial 标记时不能误报`);
  }
  assert.equal(getClosedStoryPurgePartialResult({ ok: false, partial: true, code: "RESOURCE_DELETE_FAILED", data: previewData }), null, "畸形执行结果不能展示部分完成");
  assert.equal(getClosedStoryPurgePartialResult({
    ok: false,
    partial: true,
    code: "RESOURCE_DELETE_FAILED",
    data: { ...executionData, attachments: null },
  }), null, "缺少任一执行结果分区时不能展示部分完成");
});
