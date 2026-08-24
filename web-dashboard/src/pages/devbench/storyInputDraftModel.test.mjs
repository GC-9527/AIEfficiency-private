import test from "node:test";
import assert from "node:assert/strict";
import {
  mergeStoryDraftAttachments,
  resolveStoryInputSubmission,
  storyInputDraftStorageKey,
} from "./storyInputDraftModel.mjs";

test("Gateway 500 且发送后没有新输入时恢复原始草稿", () => {
  const result = resolveStoryInputSubmission({
    submission: { value: "不能丢失的文字", revision: 3, clearedRevision: 4 },
    currentValue: "",
    currentRevision: 4,
    ok: false,
  });
  assert.deepEqual(result, {
    value: "不能丢失的文字",
    restored: true,
    unchangedSinceClear: true,
  });
});

test("发送期间形成的新草稿不会被成功或失败回调覆盖", () => {
  const submission = { value: "已发送文字", revision: 8, clearedRevision: 9 };
  for (const ok of [true, false]) {
    assert.deepEqual(resolveStoryInputSubmission({
      submission,
      currentValue: "下一条新草稿",
      currentRevision: 10,
      ok,
    }), {
      value: "下一条新草稿",
      restored: false,
      unchangedSinceClear: false,
    });
  }
});

test("发送期间引用或附件变化时，即使正文仍为空也不恢复旧提交", () => {
  assert.deepEqual(resolveStoryInputSubmission({
    submission: { value: "旧正文", revision: 11, clearedRevision: 12 },
    currentValue: "",
    currentRevision: 12,
    ok: false,
    restoreAllowed: false,
  }), {
    value: "",
    restored: false,
    unchangedSinceClear: true,
  });
});

test("发送成功只消费对应快照，且附件恢复时去重", () => {
  assert.deepEqual(resolveStoryInputSubmission({
    submission: { value: "已发送文字", revision: 1, clearedRevision: 2 },
    currentValue: "",
    currentRevision: 2,
    ok: true,
  }), {
    value: "",
    restored: false,
    unchangedSinceClear: true,
  });
  assert.deepEqual(mergeStoryDraftAttachments(
    [{ id: "a", name: "a.txt" }, { relPath: "b.txt", name: "b.txt" }],
    [{ id: "a", name: "a.txt" }, { id: "c", name: "c.txt" }],
  ).map((item) => item.name), ["a.txt", "b.txt", "c.txt"]);
  assert.equal(storyInputDraftStorageKey("story-1"), "devbench_input_story-1");
});
