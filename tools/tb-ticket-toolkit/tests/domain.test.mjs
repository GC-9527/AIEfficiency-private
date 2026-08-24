import assert from "node:assert/strict";
import test from "node:test";

import {
  AttachmentPrepareState,
  ToolkitError,
  decideAttachmentSelection,
  normalizeTaskNo,
  normalizeTicketContext,
  sanitizeAttachmentName,
} from "../packages/tb-domain/src/index.js";
import { richSnapshot } from "./helpers.mjs";

test("normalizeTicketContext 保留完整字段、35 条评论、附件 provenance，并显式记录 unavailable", () => {
  const snapshot = richSnapshot({ attachmentCount: 2, remarkImageCount: 1 });
  const context = normalizeTicketContext(snapshot, { collectedAt: "2026-08-23T08:00:00.000Z" });

  assert.equal(context.schemaVersion, 2);
  assert.equal(context.task.taskId, snapshot.resolved.taskId);
  assert.equal(context.task.taskNo, "CARB-15125");
  assert.equal(context.task.currentStatus.rawName, "AI甄别");
  assert.equal(context.fields.description.value.markdown, "完整描述");
  assert.equal(context.fields.remarks[0].markdown, "补充说明");
  assert.equal(context.fields.comments.length, 35, "不得沿用旧入口 slice(-30)");
  assert.equal(context.fields.project.name, "脱敏项目");
  assert.equal(context.fields.iteration.name, "脱敏迭代");
  assert.equal(context.fields.priority.value, "P0");
  assert.equal(context.fields.labels[0].name, "缺陷");
  assert.equal(context.fields.people.participants[0].name, "参与人");
  assert.equal(context.fields.customFields[0].name, "缺陷分类");
  assert.equal(context.attachments.length, 3, "任务/评论附件与备注图片应统一聚合");
  assert.equal(context.attachments.some((item) => item.source === "remark"), true);
  assert.deepEqual(
    context.unavailableFields.map((item) => item.field),
    ["relations"],
    "接口不支持的关系字段必须显式 unavailable",
  );
});

test("normalizeTicketContext 输出不含 Cookie、Authorization、token、签名 URL，digest 不受 collectedAt 影响", () => {
  const snapshot = richSnapshot({ attachmentCount: 1, remarkImageCount: 1 });
  snapshot.attachments.items[0].downloadUrl = "https://download.example.invalid/a?signature=secret";
  snapshot.note.images[0].signed = "https://download.example.invalid/n?token=secret";
  snapshot.detail.cookie = "fixture-cookie";
  const first = normalizeTicketContext(snapshot, { collectedAt: "2026-08-23T08:00:00.000Z" });
  const second = normalizeTicketContext(snapshot, { collectedAt: "2026-08-23T08:01:00.000Z" });
  const serialized = JSON.stringify(first);

  assert.doesNotMatch(serialized, /fixture-secret|fixture-cookie|signature=secret|token=secret/i);
  assert.doesNotMatch(serialized, /downloadUrl|\"signed\"|\"cookie\"|\"Authorization\"/i);
  assert.equal(first.contextDigest, second.contextDigest);
  assert.notEqual(first.collectedAt, second.collectedAt);
});

test("附件策略固定 0/1/3 自动、4 个待选择，显式 selected/all 与已保存选择可恢复", () => {
  const attachments = richSnapshot({ attachmentCount: 4 }).attachments.items;
  for (const count of [0, 1, 3]) {
    const result = decideAttachmentSelection(attachments.slice(0, count));
    assert.equal(result.state, AttachmentPrepareState.READY);
    assert.equal(result.selectedIds.length, count);
  }

  const waiting = decideAttachmentSelection(attachments);
  assert.equal(waiting.state, AttachmentPrepareState.NEEDS_ATTACHMENT_SELECTION);
  assert.deepEqual(waiting.selectedIds, []);
  assert.equal(waiting.choices.length, 4);
  assert.deepEqual(Object.keys(waiting.choices[0]), [
    "index", "attachmentId", "name", "source", "size", "mimeType", "uploader", "createdAt",
  ]);

  const selected = decideAttachmentSelection(attachments, {
    selection: { mode: "selected", attachmentIds: ["attachment-1", "attachment-3"] },
  });
  assert.deepEqual(selected.selectedIds, ["attachment-1", "attachment-3"]);

  const all = decideAttachmentSelection(attachments, { selection: { mode: "all" } });
  assert.equal(all.selectedIds.length, 4);

  const restored = decideAttachmentSelection(attachments, { savedSelection: selected.selectionReceipt });
  assert.equal(restored.restored, true);
  assert.deepEqual(restored.selectedIds, selected.selectedIds);
});

test("附件选择稳定拒绝重复、未知和过期 ID", () => {
  const attachments = richSnapshot({ attachmentCount: 4 }).attachments.items;
  assert.throws(
    () => decideAttachmentSelection(attachments, {
      selection: { mode: "selected", attachmentIds: ["attachment-1", "attachment-1"] },
    }),
    (error) => error instanceof ToolkitError && error.code === "ATTACHMENT_SELECTION_DUPLICATE",
  );
  assert.throws(
    () => decideAttachmentSelection(attachments, {
      selection: { mode: "selected", attachmentIds: ["attachment-9"] },
    }),
    (error) => error instanceof ToolkitError && error.code === "ATTACHMENT_SELECTION_INVALID",
  );
  const current = decideAttachmentSelection(attachments, {
    selection: { mode: "selected", attachmentIds: ["attachment-1"] },
  });
  const changed = structuredClone(attachments);
  changed[0].originalName = "changed.log";
  assert.throws(
    () => decideAttachmentSelection(changed, { savedSelection: current.selectionReceipt }),
    (error) => error instanceof ToolkitError && error.code === "ATTACHMENT_SELECTION_STALE",
  );
});

test("TB 单号与附件名跨平台清洗且不使用标题回退", () => {
  assert.equal(normalizeTaskNo(" carb-15125 "), "CARB-15125");
  assert.throws(() => normalizeTaskNo("M2 脱敏工单"), (error) => error.code === "TASK_NO_REQUIRED");
  assert.equal(sanitizeAttachmentName("../CON?.log"), "_CON_.log");
  assert.equal(sanitizeAttachmentName("C:\\temp\\evidence.txt"), "evidence.txt");
  assert.equal(sanitizeAttachmentName("\u0000 bad . "), "bad");
});
