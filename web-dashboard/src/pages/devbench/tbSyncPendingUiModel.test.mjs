import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { workflowSyncPendingInfo } from "./workflowMapModel.js";

test("报告与组同步待续跑复用 report API，拒绝待续跑复用 reject API", () => {
  assert.equal(workflowSyncPendingInfo({ tbSyncPending: { kind: "report" } }).retryAction, "report");
  assert.equal(workflowSyncPendingInfo({ tbSyncPending: { kind: "group" } }).retryAction, "report");
  assert.equal(workflowSyncPendingInfo({ tbSyncPending: { kind: "reject" } }).retryAction, "reject");
});

test("StoryTab 展示持久步骤与错误，并把重试动作交给容器", () => {
  const source = readFileSync(new URL("./StoryTab.jsx", import.meta.url), "utf8");
  assert.match(source, /data-testid="devbench-tb-sync-pending"/);
  assert.match(source, /workflowSyncPendingInfo\(wf\)/);
  assert.match(source, /onRetryTbSync\?\.\(syncPending\?\.retryAction\)/);
  assert.match(source, /syncPending\.errors\.join/);
});

test("容器按冻结 payload 的种类调用既有 report/reject API，并在结果后刷新", () => {
  const source = readFileSync(new URL("./index.jsx", import.meta.url), "utf8");
  assert.match(source, /async function onRetryTbSync\(tabId, action\)/);
  assert.match(source, /devbenchApi\.workflowReject\(tabId\)/);
  assert.match(source, /devbenchApi\.workflowReport\(tabId\)/);
  assert.match(source, /onRetryTbSync=\{\(action\) => onRetryTbSync\(active\.id, action\)\}/);
});
