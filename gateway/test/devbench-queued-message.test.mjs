import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import {
  createQueuedMessage,
  ensureQueuedMessageRuntimeIdentity,
  isQueuedMessageBlocked,
  markQueuedMessageBlocked,
  normalizeQueuedMessage,
  queuedMessagesEqual,
  queuedMessageToSendTurn,
  retryBlockedQueuedMessage,
  rotateQueuedMessageDeviceRequestId,
  takeNextQueuedMessage,
} from "../services/devbench/conversation/queued-message.js";

test("create builds a safe envelope and deep-clones supported metadata", () => {
  const attachments = [{ name: "report.txt", ref: "storydev:/archives/report.txt", metadata: { size: 12 } }];
  const queued = createQueuedMessage({
    content: "provider prompt with attachment instructions",
    displayContent: "please inspect the report",
    messageInput: {
      text: "please inspect the report",
      replyToMessageId: "visible-message-1",
      attachments,
      clientMessageId: "client-message-1",
      parentId: "must-not-be-trusted",
      taskId: "must-not-be-trusted",
    },
    parentId: "must-not-be-trusted",
  });
  attachments[0].metadata.size = 99;

  assert.deepEqual(queued, {
    content: "provider prompt with attachment instructions",
    displayContent: "please inspect the report",
    messageInput: {
      text: "please inspect the report",
      replyToMessageId: "visible-message-1",
      attachments: [{ name: "report.txt", ref: "storydev:/archives/report.txt", metadata: { size: 12 } }],
      clientMessageId: "client-message-1",
    },
  });
  assert.equal("parentId" in queued, false);
  assert.equal("parentId" in queued.messageInput, false);
  assert.equal("taskId" in queued.messageInput, false);
});

test("normalize safely handles malformed persisted values", () => {
  assert.equal(normalizeQueuedMessage(null), null);
  assert.equal(normalizeQueuedMessage([]), null);
  assert.equal(normalizeQueuedMessage("   "), null);
  assert.equal(normalizeQueuedMessage({ content: "valid", messageInput: { attachments: {} } }), null);
  assert.throws(
    () => createQueuedMessage({ content: "valid", messageInput: { attachments: {} } }),
    (error) => error.code === "QUEUED_MESSAGE_INVALID" && error.statusCode === 400,
  );
});

test("legacy string dequeues with identical provider, display, and input text", () => {
  const next = takeNextQueuedMessage(["legacy follow up"]);
  assert.deepEqual(next.request, {
    content: "legacy follow up",
    options: {
      conversation: {
        displayContent: "legacy follow up",
        messageInput: { text: "legacy follow up" },
      },
      fromPersistentQueue: true,
    },
  });
  assert.deepEqual(next.remaining, []);
});

test("new envelopes preserve FIFO order and the sendTurn display contract", () => {
  const first = createQueuedMessage({
    content: "provider prompt one",
    displayContent: "visible one",
    messageInput: { text: "visible one", clientMessageId: "one" },
  });
  const second = createQueuedMessage({
    content: "provider prompt two",
    displayContent: "visible two",
    messageInput: {
      text: "visible two",
      replyToMessageId: "answer-one",
      attachments: [{ name: "two.log" }],
      clientMessageId: "two",
    },
  });
  const firstTake = takeNextQueuedMessage([first, second]);
  const secondTake = takeNextQueuedMessage(firstTake.remaining);

  assert.equal(firstTake.request.content, "provider prompt one");
  assert.equal(firstTake.request.options.conversation.displayContent, "visible one");
  assert.equal(secondTake.request.content, "provider prompt two");
  assert.deepEqual(secondTake.request.options.conversation.messageInput, {
    text: "visible two",
    replyToMessageId: "answer-one",
    attachments: [{ name: "two.log" }],
    clientMessageId: "two",
  });
  assert.deepEqual(secondTake.remaining, []);
});

test("persisted envelope equality survives JSON round-trip while preserving duplicate FIFO entries", () => {
  const queued = createQueuedMessage({ content: "same", displayContent: "same", messageInput: { text: "same" } });
  const restored = JSON.parse(JSON.stringify(queued));
  assert.equal(queuedMessagesEqual(queued, restored), true);
  const first = takeNextQueuedMessage([queued, restored]);
  assert.equal(first.remaining.length, 1);
  assert.deepEqual(queuedMessageToSendTurn(first.remaining[0]), queuedMessageToSendTurn(queued));
});

test("Prompt overlay selected 决策严格归一化、深拷贝并透传到 sendTurn", () => {
  const decision = {
    schemaVersion: "prompt-compatibility-overlay-decision-v1",
    selected: true,
    storyId: " story-overlay ",
    provider: "CODEX",
    stageId: "repair",
    reason: "ENABLED",
    rolloutHash: "A".repeat(64),
    version: "phase2-prompt-overlay-v1",
    templateFile: "repair.md",
    templateSha256: "B".repeat(64),
    promptVariant: "PHASE2_OVERLAY",
  };
  const queued = createQueuedMessage({ content: "冻结 Prompt overlay", promptOverlayDecision: decision });
  decision.storyId = "mutated-story";
  decision.templateFile = "triage.md";

  const expected = {
    schemaVersion: "prompt-compatibility-overlay-decision-v1",
    selected: true,
    storyId: "story-overlay",
    provider: "codex",
    stageId: "REPAIR",
    reason: "enabled",
    rolloutHash: "a".repeat(64),
    version: "phase2-prompt-overlay-v1",
    templateFile: "repair.md",
    templateSha256: "b".repeat(64),
    promptVariant: "phase2_overlay",
  };
  assert.deepEqual(queued.promptOverlayDecision, expected);
  assert.notStrictEqual(queued.promptOverlayDecision, decision);

  const restored = JSON.parse(JSON.stringify(queued));
  const request = queuedMessageToSendTurn(restored);
  assert.deepEqual(request.options.promptOverlayDecision, expected);
  assert.notStrictEqual(request.options.promptOverlayDecision, restored.promptOverlayDecision);
  request.options.promptOverlayDecision.storyId = "mutated-after-dequeue";
  assert.equal(restored.promptOverlayDecision.storyId, "story-overlay");
});

test("Prompt overlay 未选中决策保留服务端选择原因且不接受 selected-only 字段", () => {
  const decision = {
    schemaVersion: "prompt-compatibility-overlay-decision-v1",
    selected: false,
    storyId: "story-overlay-control",
    provider: "center",
    stageId: "REPORT_SHORT",
    reason: "outside_percentage",
    rolloutHash: "c".repeat(64),
    version: "phase2-prompt-overlay-v1",
    promptVariant: "phase2_overlay",
  };
  const queued = createQueuedMessage({ content: "冻结 legacy 对照组", promptOverlayDecision: decision });
  assert.deepEqual(queued.promptOverlayDecision, decision);
  assert.notStrictEqual(queued.promptOverlayDecision, decision);
  const restored = JSON.parse(JSON.stringify(queued));
  const requestDecision = queuedMessageToSendTurn(restored).options.promptOverlayDecision;
  assert.deepEqual(requestDecision, decision);
  assert.notStrictEqual(requestDecision, restored.promptOverlayDecision);

  assert.equal(normalizeQueuedMessage({
    content: "不能给未选中决策附带模板",
    promptOverlayDecision: { ...decision, templateFile: "report-short.md" },
  }), null);
  assert.equal(normalizeQueuedMessage({
    content: "不能给未选中决策附带模板摘要",
    promptOverlayDecision: { ...decision, templateSha256: "c".repeat(64) },
  }), null);
  assert.equal(normalizeQueuedMessage({
    content: "未选中决策也必须冻结 Prompt variant",
    promptOverlayDecision: { ...decision, promptVariant: undefined },
  }), null);
});

test("非法 Prompt overlay 决策使整条持久消息失败关闭而不是降级 legacy", () => {
  const valid = {
    schemaVersion: "prompt-compatibility-overlay-decision-v1",
    selected: true,
    storyId: "story-overlay-invalid",
    provider: "codex",
    stageId: "VERIFY_EXECUTE",
    reason: "enabled",
    rolloutHash: "d".repeat(64),
    version: "phase2-prompt-overlay-v1",
    templateFile: "verify.md",
    templateSha256: "e".repeat(64),
    promptVariant: "phase2_overlay",
  };
  const invalid = [
    null,
    { ...valid, selected: "true" },
    { ...valid, schemaVersion: undefined },
    { ...valid, schemaVersion: "v2" },
    { ...valid, storyId: undefined },
    { ...valid, provider: undefined },
    { ...valid, provider: {} },
    { ...valid, stageId: undefined },
    { ...valid, reason: undefined },
    { ...valid, rolloutHash: undefined },
    { ...valid, version: undefined },
    { ...valid, unknown: true },
    { ...valid, stageId: "UNKNOWN" },
    { ...valid, reason: "outside_percentage" },
    { ...valid, rolloutHash: "not-a-sha" },
    { ...valid, rolloutHash: "d".repeat(65) },
    { ...valid, templateFile: "../verify.md" },
    { ...valid, templateSha256: "short" },
    { ...valid, templateSha256: "e".repeat(65) },
    { ...valid, promptVariant: "compatibility" },
    { ...valid, promptVariant: undefined },
    { ...valid, templateFile: undefined },
    { ...valid, selected: false, reason: "enabled" },
  ];
  for (const promptOverlayDecision of invalid) {
    const input = { content: "invalid overlay decision", promptOverlayDecision };
    assert.equal(normalizeQueuedMessage(input), null, JSON.stringify(promptOverlayDecision));
    assert.throws(
      () => createQueuedMessage(input),
      (error) => error.code === "QUEUED_MESSAGE_INVALID" && error.statusCode === 400,
    );
  }
});

test("持久消息在申请设备前固化 requestId/taskId，并在重放时复用同一身份", () => {
  const queued = createQueuedMessage({ content: "等待设备", displayContent: "等待设备", messageInput: { text: "等待设备" } });
  const materialized = ensureQueuedMessageRuntimeIdentity(queued, {
    storyId: "story-device-queue",
    idFactory: () => "task-fixed",
  });
  assert.equal(materialized.deviceRuntimeTaskId, "task-fixed");
  assert.equal(materialized.deviceRuntimeRequestId, "story:story-device-queue:task-fixed");

  const restored = JSON.parse(JSON.stringify(materialized));
  const replay = ensureQueuedMessageRuntimeIdentity(restored, {
    storyId: "story-device-queue",
    idFactory: () => { throw new Error("已有身份时不应重新生成"); },
  });
  assert.equal(replay.deviceRuntimeRequestId, materialized.deviceRuntimeRequestId);
  assert.equal(queuedMessageToSendTurn(replay).options.deviceRuntimeTaskId, "task-fixed");
  assert.equal(queuedMessageToSendTurn(replay).options.fromPersistentQueue, true);
});

test("设备 pre-start 拒绝后只轮换 terminal requestId，冻结 task/attempt/user 身份不变", () => {
  const promptOverlayDecision = {
    schemaVersion: "prompt-compatibility-overlay-decision-v1",
    selected: true,
    storyId: "story-device-retry",
    provider: "codex",
    stageId: "REPAIR",
    reason: "enabled",
    rolloutHash: "f".repeat(64),
    version: "phase2-prompt-overlay-v1",
    templateFile: "repair.md",
    templateSha256: "1".repeat(64),
    promptVariant: "phase2_overlay",
  };
  const frozen = ensureQueuedMessageRuntimeIdentity(createQueuedMessage({
    content: "等待设备重试",
    promptOverlayDecision,
  }), {
    storyId: "story-device-retry",
    idFactory: (() => {
      const ids = ["task-fixed", "attempt-fixed", "user-fixed"];
      return () => ids.shift();
    })(),
  });
  const rotated = rotateQueuedMessageDeviceRequestId(frozen, {
    storyId: "story-device-retry",
    idFactory: () => "retry-2",
  });
  assert.notEqual(rotated.deviceRuntimeRequestId, frozen.deviceRuntimeRequestId);
  assert.match(rotated.deviceRuntimeRequestId, /:task-fixed:retry:retry-2$/);
  assert.equal(rotated.deviceRuntimeTaskId, frozen.deviceRuntimeTaskId);
  assert.equal(rotated.workflowV2AttemptId, frozen.workflowV2AttemptId);
  assert.equal(rotated.workflowV2UserMessageId, frozen.workflowV2UserMessageId);
  assert.deepEqual(rotated.promptOverlayDecision, frozen.promptOverlayDecision);
  assert.notStrictEqual(rotated.promptOverlayDecision, frozen.promptOverlayDecision);
});

test("确定性失败标记 blocked 时保留 terminal request 与 task/attempt/user，且可持久化识别", () => {
  const ids = ["task-terminal", "attempt-terminal", "user-terminal"];
  const frozen = ensureQueuedMessageRuntimeIdentity(createQueuedMessage({ content: "确定性失败后等待人工处理" }), {
    storyId: "story-blocked-queue",
    idFactory: () => ids.shift(),
  });
  const blocked = markQueuedMessageBlocked(frozen, {
    code: "WORKFLOW_V2_COMPATIBILITY_DISPATCH_STALE",
    error: "冻结上下文已失效",
    now: 1_786_108_900_000,
  });

  assert.equal(isQueuedMessageBlocked(frozen), false);
  assert.equal(isQueuedMessageBlocked(blocked), true);
  assert.equal(blocked.deviceRuntimeRequestId, frozen.deviceRuntimeRequestId);
  assert.equal(blocked.deviceRuntimeTaskId, frozen.deviceRuntimeTaskId);
  assert.equal(blocked.workflowV2AttemptId, frozen.workflowV2AttemptId);
  assert.equal(blocked.workflowV2UserMessageId, frozen.workflowV2UserMessageId);
  assert.match(JSON.stringify(blocked), /WORKFLOW_V2_COMPATIBILITY_DISPATCH_STALE/);
  assert.match(JSON.stringify(blocked), /冻结上下文已失效/);

  const restored = JSON.parse(JSON.stringify(blocked));
  assert.equal(isQueuedMessageBlocked(restored), true);
  assert.equal(queuedMessagesEqual(restored, blocked), true);
  assert.deepEqual(normalizeQueuedMessage(restored), blocked);
});

test("只有显式 retry 才轮换 blocked requestId；blocked 清除但冻结三元身份不变", () => {
  const ids = ["task-stable", "attempt-stable", "user-stable"];
  const frozen = ensureQueuedMessageRuntimeIdentity(createQueuedMessage({ content: "人工重试 blocked head" }), {
    storyId: "story-explicit-retry",
    idFactory: () => ids.shift(),
  });
  const blocked = markQueuedMessageBlocked(frozen, {
    code: "WORKFLOW_V2_COMPATIBILITY_SETTLEMENT_BLOCKED",
    error: "上一轮结算未完成",
    now: 1_786_108_900_100,
  });
  let idCalls = 0;
  const retried = retryBlockedQueuedMessage(blocked, {
    storyId: "story-explicit-retry",
    idFactory: () => {
      idCalls += 1;
      return "manual-retry-1";
    },
  });

  assert.equal(idCalls, 1);
  assert.equal(isQueuedMessageBlocked(retried), false);
  assert.notEqual(retried.deviceRuntimeRequestId, blocked.deviceRuntimeRequestId);
  assert.match(retried.deviceRuntimeRequestId, /:task-stable:retry:manual-retry-1$/);
  assert.equal(retried.deviceRuntimeTaskId, blocked.deviceRuntimeTaskId);
  assert.equal(retried.workflowV2AttemptId, blocked.workflowV2AttemptId);
  assert.equal(retried.workflowV2UserMessageId, blocked.workflowV2UserMessageId);
  assert.doesNotMatch(JSON.stringify(retried), /WORKFLOW_V2_COMPATIBILITY_SETTLEMENT_BLOCKED|上一轮结算未完成/);
  assert.ok(queuedMessageToSendTurn(retried));

  assert.throws(
    () => retryBlockedQueuedMessage(frozen, { storyId: "story-explicit-retry", idFactory: () => "unused" }),
    (error) => error.code === "QUEUED_MESSAGE_NOT_RETRYABLE",
  );
});

test("blocked retry 轮换设备 requestId 时 Prompt overlay 决策保持不漂移", () => {
  const decision = {
    schemaVersion: "prompt-compatibility-overlay-decision-v1",
    selected: false,
    storyId: "story-overlay-retry",
    provider: "deepseek",
    stageId: "TRIAGE",
    reason: "story_not_allowlisted",
    rolloutHash: "2".repeat(64),
    version: "phase2-prompt-overlay-v1",
    promptVariant: "phase2_overlay",
  };
  const ids = ["task-overlay-retry", "attempt-overlay-retry", "user-overlay-retry"];
  const frozen = ensureQueuedMessageRuntimeIdentity(createQueuedMessage({
    content: "overlay blocked retry",
    promptOverlayDecision: decision,
  }), {
    storyId: "story-overlay-retry",
    idFactory: () => ids.shift(),
  });
  const blocked = markQueuedMessageBlocked(frozen, {
    code: "PROMPT_COMPATIBILITY_OVERLAY_ROLLOUT_STALE",
    error: "overlay 决策已冻结",
    now: 1_786_108_900_200,
  });
  const retried = retryBlockedQueuedMessage(blocked, {
    storyId: "story-overlay-retry",
    idFactory: () => "retry-overlay-1",
  });

  assert.deepEqual(retried.promptOverlayDecision, decision);
  assert.notStrictEqual(retried.promptOverlayDecision, blocked.promptOverlayDecision);
  assert.notEqual(retried.deviceRuntimeRequestId, blocked.deviceRuntimeRequestId);
  assert.equal(retried.deviceRuntimeTaskId, blocked.deviceRuntimeTaskId);
  assert.equal(retried.workflowV2AttemptId, blocked.workflowV2AttemptId);
  assert.equal(retried.workflowV2UserMessageId, blocked.workflowV2UserMessageId);
});

test("blocked queue head 不会被 drain 自动派发，确定性失败标记后不安排 microtask 自旋", () => {
  const source = fs.readFileSync(new URL("../services/devbench/index.js", import.meta.url), "utf8");
  const start = source.indexOf("async function drainQueue(tabId)");
  const end = source.indexOf("export function scheduleTabQueueDrain", start);
  const drain = source.slice(start, end);
  assert.match(drain, /isQueuedMessageBlocked\(/);
  const blockedGuard = drain.indexOf("isQueuedMessageBlocked(");
  const dispatch = drain.indexOf("sendTurnWithDeviceRuntime(");
  assert.ok(blockedGuard >= 0 && dispatch > blockedGuard, "blocked head guard must run before Provider dispatch");

  const mark = drain.indexOf("markQueuedMessageBlocked(");
  assert.ok(mark >= 0, "deterministic queue failure must persist a blocked head");
  assert.match(drain, /started\.blocked === true[\s\S]{0,160}markQueuedMessageBlocked\(/,
    "no-device v2 preparation failures must enter the same explicit blocked-head path");
  const markBranch = drain.slice(mark, Math.min(drain.length, mark + 1_600));
  assert.match(markBranch, /replaceTabQueueHeadIfUnchanged/);
  const persisted = markBranch.indexOf("if (replaced.ok)");
  const headChanged = markBranch.indexOf('if (replaced.code === "STORY_QUEUE_HEAD_CHANGED")', persisted);
  assert.ok(persisted >= 0 && headChanged > persisted, "blocked persistence must distinguish success from a changed head");
  const persistedBranch = markBranch.slice(persisted, headChanged);
  assert.match(persistedBranch, /return;/);
  assert.doesNotMatch(persistedBranch, /scheduleTabQueueDrain\(tabId\)/,
    "successfully persisting a deterministic blocked head must not recursively schedule another drain");
  assert.match(markBranch, /if \(replaced\.code === "STORY_QUEUE_HEAD_CHANGED"\) scheduleTabQueueDrain\(tabId\)/,
    "a concurrently replaced head may schedule a fresh drain");

  const boundaryStart = source.indexOf("async function sendTurnAtDispatchBoundary");
  const boundaryEnd = source.indexOf("export async function sendTurnWithDeviceRuntime", boundaryStart);
  const boundary = source.slice(boundaryStart, boundaryEnd);
  assert.match(boundary, /WORKFLOW_V2_COMPATIBILITY_WORKTREE_LEASE_UNAVAILABLE/,
    "a selected-v2 worktree lease failure must be typed");
  assert.match(boundary, /blockRetainedWorkflowV2QueueResult\(started, opts\)/,
    "all selected-v2 synchronous send errors must be converted into an explicit blocked head");
});

test("blocked queue head 只能通过匹配 requestId 的 retry/cancel API 显式处理", () => {
  const routes = fs.readFileSync(new URL("../routes/devbench.js", import.meta.url), "utf8");
  const retryStart = routes.indexOf('router.post("/tabs/:id/queue/:requestId/retry"');
  const cancelStart = routes.indexOf('router.delete("/tabs/:id/queue/:requestId"', retryStart);
  const cancelEnd = routes.indexOf('router.delete("/tabs/:id/device-use/queue/:requestId"', cancelStart);
  assert.ok(retryStart >= 0 && cancelStart > retryStart && cancelEnd > cancelStart);

  const retryRoute = routes.slice(retryStart, cancelStart);
  assert.match(retryRoute, /head\?\.deviceRuntimeRequestId/);
  assert.match(retryRoute, /STORY_QUEUE_HEAD_CHANGED/);
  assert.match(retryRoute, /isQueuedMessageBlocked\(head\)/);
  assert.match(retryRoute, /retryBlockedQueuedMessage\(head/);
  assert.match(retryRoute, /replaceTabQueueHeadIfUnchanged\(tab\.id, head, retrying\)/);
  assert.match(retryRoute, /scheduleTabQueueDrain\(tab\.id\)/);

  const cancelRoute = routes.slice(cancelStart, cancelEnd);
  assert.match(cancelRoute, /head\?\.deviceRuntimeRequestId/);
  assert.match(cancelRoute, /STORY_QUEUE_HEAD_CHANGED/);
  assert.match(cancelRoute, /isQueuedMessageBlocked\(head\)/);
  assert.match(cancelRoute, /replaceTabQueueHeadIfUnchanged\(tab\.id, head, null\)/);

  const api = fs.readFileSync(new URL("../../web-dashboard/src/pages/devbench/api.js", import.meta.url), "utf8");
  assert.match(api, /retryBlockedQueueHead:\s*\(id, requestId\)[\s\S]*?\/queue\/\$\{encodeURIComponent\(requestId\)\}\/retry/);
  assert.match(api, /cancelBlockedQueueHead:\s*\(id, requestId\)[\s\S]*?\/queue\/\$\{encodeURIComponent\(requestId\)\}/);
});

test("设备排队不会把编辑并重发降级为普通新消息", () => {
  const queued = createQueuedMessage({
    content: "修订后的正文",
    displayContent: "修订后的正文",
    messageInput: { text: "修订后的正文", clientMessageId: "client-edit-1" },
    conversation: {
      mode: "edit",
      messageId: "user-message-1",
      expectedRevision: 7,
      idempotencyKey: "edit-once",
      forceFreshSession: true,
      unsafeField: "drop-me",
    },
  });
  const request = queuedMessageToSendTurn(JSON.parse(JSON.stringify(queued)));
  assert.deepEqual(request.options.conversation, {
    displayContent: "修订后的正文",
    messageInput: { text: "修订后的正文", clientMessageId: "client-edit-1" },
    mode: "edit",
    messageId: "user-message-1",
    expectedRevision: 7,
    idempotencyKey: "edit-once",
    forceFreshSession: true,
  });
});
