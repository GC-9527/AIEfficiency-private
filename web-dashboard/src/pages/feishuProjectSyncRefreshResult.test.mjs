import assert from "node:assert/strict";
import test from "node:test";
import {
  createFeishuRecordsRefreshResult,
  feishuRecordsRefreshLogId,
  feishuRecordsRefreshResultView,
  feishuRecordsRefreshStatus,
} from "./feishuProjectSyncRefreshResult.js";

test("刷新日志 ID 同时兼容响应顶层和 data 内字段", () => {
  assert.equal(feishuRecordsRefreshLogId({ refreshLogId: "top-level" }), "top-level");
  assert.equal(feishuRecordsRefreshLogId({ data: { refreshLogId: "nested" } }), "nested");
  assert.equal(
    feishuRecordsRefreshLogId(
      { refreshLogId: "top-level" },
      { refreshLogId: "nested" },
    ),
    "top-level",
  );
});

test("成功刷新结果保留日志 ID 和清理统计", () => {
  const result = createFeishuRecordsRefreshResult({
    status: "success",
    data: {
      ok: true,
      refreshLogId: "refresh-success",
      refreshed: 12,
      skippedCount: 3,
      snapshotReconciled: true,
      removedUnsynced: 2,
      hiddenSynced: 1,
    },
    finishedAt: "2026-07-25T10:00:00.000Z",
  });
  const view = feishuRecordsRefreshResultView(result);
  assert.equal(view.status, "success");
  assert.equal(view.title, "飞书工单更新成功");
  assert.equal(view.refreshLogId, "refresh-success");
  assert.equal(view.refreshed, 12);
  assert.equal(view.skippedCount, 3);
  assert.equal(view.snapshotReconciled, true);
  assert.equal(view.removedUnsynced, 2);
  assert.equal(view.hiddenSynced, 1);
});

test("partial 优先于 ok=false 并汇总来源错误与去重警告", () => {
  const data = {
    ok: false,
    partial: true,
    refreshLogId: "refresh-partial",
    refreshed: 5,
    firstError: "双八来源读取失败",
    sourceResults: [
      { ok: true, warning: "已将李敏解析为唯一 user_key" },
      { ok: true, warning: "已将李敏解析为唯一 user_key" },
      { ok: false, error: "读取失败" },
    ],
  };
  assert.equal(feishuRecordsRefreshStatus(data, "success"), "partial");
  const view = feishuRecordsRefreshResultView(createFeishuRecordsRefreshResult({
    status: "success",
    data,
  }));
  assert.equal(view.status, "partial");
  assert.equal(view.refreshLogId, "refresh-partial");
  assert.equal(view.error, "双八来源读取失败");
  assert.equal(view.warning, "已将李敏解析为唯一 user_key");
  assert.equal(view.failedSources, 1);
  assert.equal(view.sourceCount, 3);
});

test("失败结果可从 Error 顶层日志 ID 构造持久结果", () => {
  const error = Object.assign(new Error("MCP 调用失败"), {
    refreshLogId: "refresh-failed",
    data: { ok: false },
  });
  const result = createFeishuRecordsRefreshResult({
    status: feishuRecordsRefreshStatus(error.data, "failed"),
    data: error.data,
    error: error.message,
    refreshLogId: feishuRecordsRefreshLogId(error, error.data),
  });
  const view = feishuRecordsRefreshResultView(result);
  assert.equal(view.status, "failed");
  assert.equal(view.title, "飞书工单更新失败");
  assert.equal(view.refreshLogId, "refresh-failed");
  assert.equal(view.error, "MCP 调用失败");
});
