import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  createOptimisticStoryMessage,
  isRetryableFailedStoryMessage,
  settleOptimisticStoryMessage,
} from "./storyMessageSendModel.mjs";

test("乐观消息在发送失败后保留为可编辑重试的本地消息", () => {
  const pending = createOptimisticStoryMessage({
    clientMessageId: "client-1",
    content: "provider prompt",
    messageInput: { displayContent: "用户正文", input: { text: "用户正文" } },
    timestamp: 123,
  });
  assert.deepEqual(pending, {
    id: "client-1",
    clientMessageId: "client-1",
    role: "user",
    content: "provider prompt",
    displayContent: "用户正文",
    input: { text: "用户正文" },
    delivery: "pending",
    localOnly: true,
    pending: true,
    ts: 123,
  });

  const failed = settleOptimisticStoryMessage([pending], "client-1", {
    ok: false,
    error: "网关暂时不可用",
  });
  assert.equal(failed[0].delivery, "failed");
  assert.equal(failed[0].pending, false);
  assert.equal(failed[0].localOnly, true);
  assert.equal(failed[0].sendError, "网关暂时不可用");
  assert.equal(isRetryableFailedStoryMessage(failed[0], "client-1"), true);
});

test("发送成功后用服务端消息 ID 替换本地乐观 ID", () => {
  const pending = createOptimisticStoryMessage({
    clientMessageId: "client-2",
    content: "hello",
    messageInput: { displayContent: "hello", input: { text: "hello" } },
  });
  const sent = settleOptimisticStoryMessage([pending], "client-2", {
    ok: true,
    data: { userMessageId: "server-user-2" },
  });
  assert.equal(sent[0].id, "server-user-2");
  assert.equal(sent[0].clientMessageId, "client-2");
  assert.equal(sent[0].delivery, "sent");
  assert.equal(sent[0].localOnly, false);
  assert.equal(sent[0].pending, false);
});

test("点击发送先冻结并清空草稿快照，Gateway 失败时恢复；本地失败消息重发走普通发送", () => {
  const storyTab = readFileSync(new URL("./StoryTab.jsx", import.meta.url), "utf8");
  const sendStart = storyTab.indexOf("async function doSend()");
  const sendEnd = storyTab.indexOf("async function startGitCommitReview", sendStart);
  const sendFlow = storyTab.slice(sendStart, sendEnd);
  const requestAt = sendFlow.indexOf("await onSend(");
  assert.ok(requestAt > 0);
  assert.ok(sendFlow.indexOf("beginSubmission(draftSnapshot)") > 0 && sendFlow.indexOf("beginSubmission(draftSnapshot)") < requestAt);
  assert.ok(sendFlow.indexOf("setAttachments([])") > 0 && sendFlow.indexOf("setAttachments([])") < requestAt);
  assert.ok(sendFlow.indexOf("setReplyTo(null)") > 0 && sendFlow.indexOf("setReplyTo(null)") < requestAt);
  assert.match(sendFlow, /settleSubmission\(submission, true\)/);
  assert.match(sendFlow, /restoreOnFailure: contextUnchanged/);
  assert.match(sendFlow, /if \(settledDraft\?\.restored\)[\s\S]*mergeStoryDraftAttachments\(sentAttachments, current\)/);

  assert.doesNotMatch(storyTab, /const \[input, setInput\] = useState/);
  assert.match(storyTab, /<StoryChatInput[\s\S]*ref=\{storyInputRef\}/);
  const inputComponent = readFileSync(new URL("./StoryChatInput.jsx", import.meta.url), "utf8");
  assert.match(inputComponent, /memo\(forwardRef/);
  assert.match(inputComponent, /nativeEvent\?\.isComposing/);
  assert.match(inputComponent, /DRAFT_PERSIST_DELAY_MS/);
  assert.match(inputComponent, /persistDraft\(draftKey, submission\.value\)/);
  assert.doesNotMatch(storyTab, /onHasTextChange/);

  const indexSource = readFileSync(new URL("./index.jsx", import.meta.url), "utf8");
  const editStart = indexSource.indexOf("async function onEditAndResend(");
  const editEnd = indexSource.indexOf("async function onSelectConversationBranch", editStart);
  const editFlow = indexSource.slice(editStart, editEnd);
  assert.match(editFlow, /isRetryableFailedStoryMessage/);
  assert.match(editFlow, /onSend/);
});
