import assert from "node:assert/strict";
import test from "node:test";
import {
  isHiddenFeishuSyncRecord,
  sortFeishuSyncRecords,
} from "./feishuProjectSyncRecords.js";

const rows = [
  { sourceProblemNo: "NSCP-10", sourceUpdatedAt: "2026-07-17T10:00:00.000Z" },
  { sourceProblemNo: "NSCP-2", sourceUpdatedAt: "2026-07-18T10:00:00.000Z" },
  { sourceProblemNo: "NSCP-1", sourceUpdatedAt: "" },
];

test("映射表按源更新时间升降序排列且空值始终置后", () => {
  assert.deepEqual(sortFeishuSyncRecords(rows, { field: "sourceUpdatedAt", direction: "desc" }).map((row) => row.sourceProblemNo), ["NSCP-2", "NSCP-10", "NSCP-1"]);
  assert.deepEqual(sortFeishuSyncRecords(rows, { field: "sourceUpdatedAt", direction: "asc" }).map((row) => row.sourceProblemNo), ["NSCP-10", "NSCP-2", "NSCP-1"]);
});

test("映射表按问题编号自然排序", () => {
  assert.deepEqual(sortFeishuSyncRecords(rows, { field: "problemNo", direction: "asc" }).map((row) => row.sourceProblemNo), ["NSCP-1", "NSCP-2", "NSCP-10"]);
  assert.deepEqual(sortFeishuSyncRecords(rows, { field: "problemNo", direction: "desc" }).map((row) => row.sourceProblemNo), ["NSCP-10", "NSCP-2", "NSCP-1"]);
});

test("已流转或来源范围外的同步记录默认归入隐藏项", () => {
  assert.equal(isHiddenFeishuSyncRecord({ sourceInScope: false, targetTaskId: "tb-1" }), true);
  assert.equal(isHiddenFeishuSyncRecord({ scopeStatus: { state: "transferred" }, targetTaskId: "tb-2" }), true);
  assert.equal(isHiddenFeishuSyncRecord({ sourceInScope: true, targetTaskId: "tb-3" }), false);
});
