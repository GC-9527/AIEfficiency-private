import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "devbench-send-idempotency-"));
const projectPath = path.join(root, "story-worktree");
const baseProjectPath = path.join(root, "base-repository");
const cloneParent = path.join(root, "clone-parent");

process.env.NODE_ENV = "test";
process.env.GATEWAY_DB_PATH = path.join(root, "gateway.db");
process.env.GATEWAY_CONFIG_PATH = path.join(root, "gateway.json");
process.env.DEVBENCH_CONFIG_PATH = path.join(root, "market.json");
process.env.DEVBENCH_LOCAL_PROJECTS_PATH = path.join(root, "local", "devbench-projects.json");
process.env.DEVBENCH_STORE_DIR = path.join(root, "store");
process.env.AIEFFICIENCY_CLONE_PARENT = cloneParent;
process.env.DEVBENCH_SYNC_SCOPE = `send-idempotency-${Date.now()}`;
process.env.ROLE = "standalone";

fs.mkdirSync(path.dirname(process.env.DEVBENCH_LOCAL_PROJECTS_PATH), { recursive: true });
fs.mkdirSync(projectPath, { recursive: true });
fs.mkdirSync(baseProjectPath, { recursive: true });
fs.mkdirSync(cloneParent, { recursive: true });
fs.writeFileSync(process.env.GATEWAY_CONFIG_PATH, JSON.stringify({
  role: "standalone",
  servers: { nodeId: "send-idempotency-test", discovery: false, peers: [] },
}), "utf8");
fs.writeFileSync(process.env.DEVBENCH_CONFIG_PATH, "{}", "utf8");
fs.writeFileSync(process.env.DEVBENCH_LOCAL_PROJECTS_PATH, JSON.stringify({
  version: 2,
  cloneParent,
  projects: [],
}), "utf8");

const express = (await import("express")).default;
const router = (await import("../routes/devbench.js")).default;
const store = await import("../services/devbench/store.js");
const configService = await import("../services/config.js");
const runtime = await import("../services/devbench/device-runtime-service.js");
const agentRunner = await import("../services/agent-runner.js");
const { createTask, listTasks, updateTask } = await import("../db/sqlite.js");

async function post(base, tabId, body) {
  const response = await fetch(`${base}/tabs/${tabId}/send`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

function createBusyStory() {
  const tab = store.createTab({ title: `发送幂等-${Date.now()}` });
  const busyTaskId = `busy-${tab.id}`;
  store.updateTab(tab.id, {
    engine: "codex",
    worktreeStatus: "ready",
    worktree: {
      managed: true,
      entries: [{
        role: "primary",
        active: true,
        name: "测试工程",
        path: projectPath,
        worktreePath: projectPath,
        basePath: baseProjectPath,
      }],
    },
    workflow: { enabled: true, phase: "fixing", autoMode: "semi" },
    runningTaskId: busyTaskId,
  });
  configService.updateConfig({
    workflowV2: {
      featureFlags: { promptV2: false, promptCompatibilityOverlay: true },
      promptCompatibilityRollout: {
        percentage: 100,
        salt: "send-idempotency-overlay",
        storyIds: [tab.id],
        providers: ["codex"],
        stages: ["REPAIR"],
      },
    },
  });
  createTask({
    id: busyTaskId,
    title: "占用发送队列",
    description: "测试中的已有任务",
    type: "general",
    status: "running",
    priority: 3,
    source: "devbench",
    sourceId: tab.sessionId,
  });
  return { tab: store.getTab(tab.id), busyTaskId };
}

test("/send 在任何刷新或派发前按客户端键幂等，并冻结队列运行身份", { timeout: 30_000 }, async (t) => {
  const app = express();
  app.use(express.json());
  app.use("/api/devbench", router);
  const server = await new Promise((resolve) => {
    const instance = app.listen(0, "127.0.0.1", () => resolve(instance));
  });
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch {}
  });
  const base = `http://127.0.0.1:${server.address().port}/api/devbench`;
  const { tab, busyTaskId } = createBusyStory();
  const key = "client-send-001";
  const payload = {
    content: "保持同一条发送请求",
    displayContent: "保持同一条发送请求",
    messageInput: { text: "保持同一条发送请求", clientMessageId: key },
  };

  const first = await post(base, tab.id, payload);
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.equal(first.body.ok, true, JSON.stringify(first.body));
  assert.equal(first.body.queued, true, JSON.stringify(first.body));
  const afterFirst = store.getTab(tab.id);
  assert.equal(afterFirst.queue.length, 1);
  const queued = afterFirst.queue[0];
  assert.ok(queued.deviceRuntimeTaskId, JSON.stringify(queued));
  assert.ok(queued.workflowV2AttemptId, JSON.stringify(queued));
  assert.ok(queued.workflowV2UserMessageId, JSON.stringify(queued));
  assert.equal(queued.promptOverlayDecision?.selected, true, JSON.stringify(queued));
  assert.equal(queued.promptOverlayDecision?.stageId, "REPAIR");
  assert.equal(queued.promptOverlayDecision?.provider, "codex");
  assert.equal(first.body.data.taskId, queued.deviceRuntimeTaskId);
  assert.equal(first.body.data.attemptId, queued.workflowV2AttemptId);
  assert.equal(first.body.data.userMessageId, queued.workflowV2UserMessageId);
  assert.equal(JSON.stringify(afterFirst).includes(key), false, "tab/queue/reservation 不得持久化原始客户端幂等键");

  const tasksBeforeReplay = listTasks({ limit: 100 }).length;
  const replay = await post(base, tab.id, {
    content: payload.content,
    displayContent: payload.displayContent,
    messageInput: { text: payload.content },
    idempotencyKey: key,
  });
  assert.equal(replay.status, 200, JSON.stringify(replay.body));
  assert.equal(replay.body.duplicate, true, JSON.stringify(replay.body));
  assert.equal(replay.body.data.taskId, queued.deviceRuntimeTaskId);
  assert.equal(replay.body.data.attemptId, queued.workflowV2AttemptId);
  assert.equal(replay.body.data.userMessageId, queued.workflowV2UserMessageId);
  assert.equal(replay.body.data.queueStatus, "queued");
  assert.deepEqual(store.getTab(tab.id).queue[0].promptOverlayDecision, queued.promptOverlayDecision);
  assert.equal(store.getTab(tab.id).queue.length, 1, "重放不得新增队列消息");
  assert.equal(store.getConversation(tab.id).nodes.length, 0, "重放不得新增对话节点");
  assert.equal(listTasks({ limit: 100 }).length, tasksBeforeReplay, "重放不得新增任务");

  const conflict = await post(base, tab.id, {
    content: "同一个键但正文已变化",
    messageInput: { text: "同一个键但正文已变化", idempotencyKey: key },
  });
  assert.equal(conflict.status, 409, JSON.stringify(conflict.body));
  assert.equal(conflict.body.code, "SEND_IDEMPOTENCY_PAYLOAD_CONFLICT");
  assert.equal(store.getTab(tab.id).queue.length, 1, "冲突请求不得新增队列消息");

  const inconsistentAliases = await post(base, tab.id, {
    content: payload.content,
    clientMessageId: key,
    idempotencyKey: "另一个键",
  });
  assert.equal(inconsistentAliases.status, 400, JSON.stringify(inconsistentAliases.body));
  assert.equal(inconsistentAliases.body.code, "SEND_IDEMPOTENCY_KEY_CONFLICT");
  assert.equal(store.getTab(tab.id).queue.length, 1, "键别名冲突不得新增队列消息");

  const legacyQueued = await post(base, tab.id, { content: "无幂等键的排队消息也冻结身份" });
  assert.equal(legacyQueued.status, 200, JSON.stringify(legacyQueued.body));
  assert.equal(legacyQueued.body.queued, true, JSON.stringify(legacyQueued.body));
  const legacyMessage = store.getTab(tab.id).queue[1];
  assert.ok(legacyMessage.deviceRuntimeTaskId, JSON.stringify(legacyMessage));
  assert.ok(legacyMessage.workflowV2AttemptId, JSON.stringify(legacyMessage));
  assert.ok(legacyMessage.workflowV2UserMessageId, JSON.stringify(legacyMessage));
  assert.deepEqual(legacyMessage.promptOverlayDecision, queued.promptOverlayDecision);

  updateTask(busyTaskId, { status: "completed" });
  createTask({
    id: queued.deviceRuntimeTaskId,
    title: "已从队列启动",
    description: payload.content,
    type: "general",
    status: "running",
    priority: 3,
    source: "devbench",
    sourceId: tab.sessionId,
  });
  store.updateTab(tab.id, { queue: [], runningTaskId: queued.deviceRuntimeTaskId });
  store.appendConversationNode(tab.id, {
    id: queued.workflowV2UserMessageId,
    role: "user",
    content: payload.content,
    displayContent: payload.displayContent,
    input: payload.messageInput,
    taskId: queued.deviceRuntimeTaskId,
    attemptId: queued.workflowV2AttemptId,
    clientIdempotencyKey: queued.conversation.idempotencyKey,
    delivery: "normal",
  });
  const runningNodeCount = store.getConversation(tab.id).nodes.length;
  const runningReplay = await post(base, tab.id, payload);
  assert.equal(runningReplay.status, 200, JSON.stringify(runningReplay.body));
  assert.equal(runningReplay.body.duplicate, true, JSON.stringify(runningReplay.body));
  assert.equal(runningReplay.body.data.taskId, queued.deviceRuntimeTaskId);
  assert.equal(runningReplay.body.data.attemptId, queued.workflowV2AttemptId);
  assert.equal(runningReplay.body.data.userMessageId, queued.workflowV2UserMessageId);
  assert.equal(runningReplay.body.data.queueStatus, "running");
  assert.equal(store.getConversation(tab.id).nodes.length, runningNodeCount, "running 重放不得新增对话节点");

  updateTask(queued.deviceRuntimeTaskId, { status: "completed" });
  store.updateTab(tab.id, { runningTaskId: null });
  const finishedReplay = await post(base, tab.id, payload);
  assert.equal(finishedReplay.status, 200, JSON.stringify(finishedReplay.body));
  assert.equal(finishedReplay.body.duplicate, true, JSON.stringify(finishedReplay.body));
  assert.equal(finishedReplay.body.data.taskId, queued.deviceRuntimeTaskId);
  assert.equal(finishedReplay.body.data.attemptId, queued.workflowV2AttemptId);
  assert.equal(finishedReplay.body.data.userMessageId, queued.workflowV2UserMessageId);
  assert.equal(finishedReplay.body.data.queueStatus, "finished");
  assert.equal(store.getConversation(tab.id).nodes.length, runningNodeCount, "finished 重放不得新增对话节点");
  fs.rmSync(projectPath, { recursive: true, force: true });
  const replayAfterWorkspaceLoss = await post(base, tab.id, payload);
  assert.equal(replayAfterWorkspaceLoss.status, 200, JSON.stringify(replayAfterWorkspaceLoss.body));
  assert.equal(replayAfterWorkspaceLoss.body.duplicate, true, "已完成请求重放不得被当前 worktree 预检改写");
  assert.equal(replayAfterWorkspaceLoss.body.data.queueStatus, "finished");

  const serial = `SEND-IDEMPOTENCY-${Date.now()}`;
  const blocker = store.createTab({ title: `设备占用-${Date.now()}` });
  const deviceStory = store.createTab({ title: `设备排队幂等-${Date.now()}` });
  const deviceWorktree = path.join(root, "device-story-worktree");
  const deviceBase = path.join(root, "device-base-repository");
  fs.mkdirSync(deviceWorktree, { recursive: true });
  fs.mkdirSync(deviceBase, { recursive: true });
  store.updateTab(deviceStory.id, {
    engine: "codex",
    worktreeStatus: "ready",
    worktree: {
      managed: true,
      entries: [{
        role: "primary",
        active: true,
        name: "设备测试工程",
        path: deviceWorktree,
        worktreePath: deviceWorktree,
        basePath: deviceBase,
      }],
    },
    workflow: { enabled: true, phase: "fixing", autoMode: "semi" },
  });
  configService.updateConfig({
    workflowV2: {
      promptCompatibilityRollout: {
        percentage: 100,
        salt: "send-idempotency-overlay",
        storyIds: [tab.id, deviceStory.id],
        providers: ["codex"],
        stages: ["REPAIR"],
      },
    },
  });
  store.updateTabDeviceBinding(deviceStory.id, { deviceSerial: serial });
  const active = await runtime.acquireDeviceUse({
    serial,
    requestId: "send-idempotency-device-blocker",
    storyId: blocker.id,
    taskId: "send-idempotency-device-blocker-task",
    operationKind: "integration-test",
  });
  const devicePayload = {
    content: "等待设备后只执行一次",
    messageInput: { text: "等待设备后只执行一次", clientMessageId: "device-send-key" },
  };
  const deviceFirst = await post(base, deviceStory.id, devicePayload);
  assert.equal(deviceFirst.status, 202, JSON.stringify(deviceFirst.body));
  assert.equal(deviceFirst.body.deviceQueued, true, JSON.stringify(deviceFirst.body));
  const persistedDeviceMessage = store.getTab(deviceStory.id).queue[0];
  assert.ok(persistedDeviceMessage.deviceRuntimeRequestId, JSON.stringify(persistedDeviceMessage));
  assert.ok(persistedDeviceMessage.deviceRuntimeTaskId, JSON.stringify(persistedDeviceMessage));
  assert.ok(persistedDeviceMessage.workflowV2AttemptId, JSON.stringify(persistedDeviceMessage));
  assert.ok(persistedDeviceMessage.workflowV2UserMessageId, JSON.stringify(persistedDeviceMessage));
  assert.equal(persistedDeviceMessage.promptOverlayDecision?.selected, true, JSON.stringify(persistedDeviceMessage));
  assert.equal(persistedDeviceMessage.promptOverlayDecision?.stageId, "REPAIR");
  assert.equal(deviceFirst.body.data.taskId, persistedDeviceMessage.deviceRuntimeTaskId);
  assert.equal(deviceFirst.body.data.attemptId, persistedDeviceMessage.workflowV2AttemptId);
  assert.equal(deviceFirst.body.data.userMessageId, persistedDeviceMessage.workflowV2UserMessageId);
  const deviceReservation = store.getTab(deviceStory.id).sendIdempotencyReservations
    .find((item) => item.marker === persistedDeviceMessage.conversation.idempotencyKey);
  assert.equal(deviceReservation.status, "committed");
  assert.equal(deviceReservation.resultKind, "device_queued");
  assert.equal(JSON.stringify(store.getTab(deviceStory.id)).includes("device-send-key"), false);

  const runtimeBeforeReplay = await runtime.getDeviceRuntimeSnapshot(serial, { recoverExpired: false });
  const deviceReplay = await post(base, deviceStory.id, devicePayload);
  assert.equal(deviceReplay.status, 200, JSON.stringify(deviceReplay.body));
  assert.equal(deviceReplay.body.duplicate, true, JSON.stringify(deviceReplay.body));
  assert.equal(deviceReplay.body.data.taskId, persistedDeviceMessage.deviceRuntimeTaskId);
  assert.equal(deviceReplay.body.data.attemptId, persistedDeviceMessage.workflowV2AttemptId);
  assert.equal(deviceReplay.body.data.userMessageId, persistedDeviceMessage.workflowV2UserMessageId);
  assert.equal(store.getTab(deviceStory.id).queue.length, 1, "设备排队重放不得新增持久队列");
  const runtimeAfterReplay = await runtime.getDeviceRuntimeSnapshot(serial, { recoverExpired: false });
  assert.equal(runtimeAfterReplay.queue.length, runtimeBeforeReplay.queue.length, "设备排队重放不得新增设备 FIFO 请求");

  await runtime.cancelDeviceUse({
    serial,
    requestId: persistedDeviceMessage.deviceRuntimeRequestId,
    reason: "integration-test-cleanup",
  });
  await runtime.releaseDeviceUse({
    serial,
    leaseId: active.lease.leaseId,
    fencingToken: active.lease.fencingToken,
    reason: "integration-test-cleanup",
  });

  const concurrentWorktree = path.join(root, "concurrent-story-worktree");
  const concurrentBase = path.join(root, "concurrent-base-repository");
  fs.mkdirSync(concurrentWorktree, { recursive: true });
  fs.mkdirSync(concurrentBase, { recursive: true });
  const concurrentStory = store.createTab({ title: `并发发送幂等-${Date.now()}` });
  const concurrentBusyTaskId = `busy-${concurrentStory.id}`;
  store.updateTab(concurrentStory.id, {
    worktreeStatus: "ready",
    worktree: {
      managed: true,
      entries: [{
        role: "primary",
        active: true,
        name: "并发测试工程",
        path: concurrentWorktree,
        worktreePath: concurrentWorktree,
        basePath: concurrentBase,
      }],
    },
    runningTaskId: concurrentBusyTaskId,
  });
  createTask({
    id: concurrentBusyTaskId,
    title: "并发发送占用",
    description: "并发幂等测试中的已有任务",
    type: "general",
    status: "running",
    priority: 3,
    source: "devbench",
    sourceId: concurrentStory.sessionId,
  });
  const concurrentPayload = {
    content: "两次并发请求只排队一次",
    messageInput: { text: "两次并发请求只排队一次", clientMessageId: "concurrent-send-key" },
  };
  const concurrentResponses = await Promise.all([
    post(base, concurrentStory.id, concurrentPayload),
    post(base, concurrentStory.id, concurrentPayload),
  ]);
  assert.deepEqual(concurrentResponses.map((item) => item.status), [200, 200]);
  assert.equal(concurrentResponses.filter((item) => item.body.duplicate === true).length, 1);
  assert.equal(store.getTab(concurrentStory.id).queue.length, 1, "并发同键请求必须只持久化一个队列项");
  assert.equal(concurrentResponses[0].body.data.taskId, concurrentResponses[1].body.data.taskId);
  assert.equal(concurrentResponses[0].body.data.attemptId, concurrentResponses[1].body.data.attemptId);
  assert.equal(concurrentResponses[0].body.data.userMessageId, concurrentResponses[1].body.data.userMessageId);
  updateTask(concurrentBusyTaskId, { status: "completed" });

  // Two independently-evaluated store modules model two Gateway processes
  // sharing the same SQLite file. The database reservation, not the local
  // route lock, must select exactly one owner.
  const storeA = await import(`../services/devbench/store.js?send-owner-a=${Date.now()}`);
  const storeB = await import(`../services/devbench/store.js?send-owner-b=${Date.now()}`);
  const atomicStory = store.createTab({ title: `跨 Gateway 持久幂等-${Date.now()}` });
  const marker = (rawKey, rawPayload) => {
    const digest = (value) => createHash("sha256").update(value, "utf8").digest("hex");
    return `devbench-send:v1:${digest(rawKey)}:${digest(rawPayload)}`;
  };
  const asyncCall = (fn) => new Promise((resolve) => setImmediate(() => resolve(fn())));
  const rawAtomicKey = "raw-key-must-not-be-persisted";
  const atomicMarker = marker(rawAtomicKey, "same-payload");
  const atomicIdentity = {
    requestId: "atomic-request-1",
    taskId: "atomic-task-1",
    attemptId: "atomic-attempt-1",
    userMessageId: "atomic-user-1",
  };
  const [claimA, claimB] = await Promise.all([
    asyncCall(() => storeA.reserveTabSend({
      tabId: atomicStory.id,
      marker: atomicMarker,
      ownerToken: "gateway-owner-a",
      identities: atomicIdentity,
    })),
    asyncCall(() => storeB.reserveTabSend({
      tabId: atomicStory.id,
      marker: atomicMarker,
      ownerToken: "gateway-owner-b",
      identities: atomicIdentity,
    })),
  ]);
  assert.equal([claimA, claimB].filter((claim) => claim.acquired === true).length, 1);
  assert.equal([claimA, claimB].filter((claim) => claim.pending === true).length, 1);
  let sideEffectCount = 0;
  const winner = claimA.acquired
    ? { owner: "gateway-owner-a", module: storeA }
    : { owner: "gateway-owner-b", module: storeB };
  if (claimA.acquired || claimB.acquired) sideEffectCount += 1;
  const committedAtomic = winner.module.commitTabSend({
    tabId: atomicStory.id,
    marker: atomicMarker,
    ownerToken: winner.owner,
    resultKind: "queued",
    identities: atomicIdentity,
    queueMessage: {
      content: "跨 Gateway 只追加一次",
      displayContent: "跨 Gateway 只追加一次",
      messageInput: { text: "跨 Gateway 只追加一次" },
      conversation: { idempotencyKey: atomicMarker },
      deviceRuntimeRequestId: atomicIdentity.requestId,
      deviceRuntimeTaskId: atomicIdentity.taskId,
      workflowV2AttemptId: atomicIdentity.attemptId,
      workflowV2UserMessageId: atomicIdentity.userMessageId,
    },
  });
  assert.equal(committedAtomic.ok, true, JSON.stringify(committedAtomic));
  assert.equal(sideEffectCount, 1, "两个 Gateway 同键只能有一个 owner 继续副作用");
  assert.equal(store.getTab(atomicStory.id).queue.length, 1);
  assert.equal(JSON.stringify(store.getTab(atomicStory.id)).includes(rawAtomicKey), false, "不得持久化原始幂等键");

  const conflictClaim = storeB.reserveTabSend({
    tabId: atomicStory.id,
    marker: marker(rawAtomicKey, "different-payload"),
    ownerToken: "gateway-owner-b-conflict",
    identities: atomicIdentity,
  });
  assert.equal(conflictClaim.code, "SEND_IDEMPOTENCY_PAYLOAD_CONFLICT");

  // A crash leaves status=reserved. A different process must diagnose pending
  // and fail closed until an operator-safe owner release occurs.
  const crashMarker = marker("crash-key", "crash-payload");
  const crashClaim = storeA.reserveTabSend({
    tabId: atomicStory.id,
    marker: crashMarker,
    ownerToken: "crashed-owner",
    identities: { requestId: "crash-request" },
  });
  assert.equal(crashClaim.acquired, true);
  const crashReplay = storeB.reserveTabSend({
    tabId: atomicStory.id,
    marker: crashMarker,
    ownerToken: "retry-owner",
    identities: { requestId: "crash-request" },
  });
  assert.equal(crashReplay.code, "SEND_IDEMPOTENCY_PENDING");
  assert.equal(crashReplay.pending, true);
  assert.equal(storeA.releaseTabSend({
    tabId: atomicStory.id,
    marker: crashMarker,
    ownerToken: "wrong-owner",
  }).released, false);
  assert.equal(storeA.releaseTabSend({
    tabId: atomicStory.id,
    marker: crashMarker,
    ownerToken: "crashed-owner",
  }).released, true);

  // Different keyed messages append against the latest SQLite queue in one
  // transaction each; neither read-copy-write update may erase its peer.
  const concurrentMarkers = [
    marker("queue-key-a", "queue-payload-a"),
    marker("queue-key-b", "queue-payload-b"),
  ];
  const queueClaims = [
    storeA.reserveTabSend({
      tabId: atomicStory.id,
      marker: concurrentMarkers[0],
      ownerToken: "queue-owner-a",
      identities: { requestId: "queue-request-a", taskId: "queue-task-a", attemptId: "queue-attempt-a", userMessageId: "queue-user-a" },
    }),
    storeB.reserveTabSend({
      tabId: atomicStory.id,
      marker: concurrentMarkers[1],
      ownerToken: "queue-owner-b",
      identities: { requestId: "queue-request-b", taskId: "queue-task-b", attemptId: "queue-attempt-b", userMessageId: "queue-user-b" },
    }),
  ];
  assert.ok(queueClaims.every((claim) => claim.acquired));
  const queueCommits = await Promise.all([
    asyncCall(() => storeA.commitTabSend({
      tabId: atomicStory.id,
      marker: concurrentMarkers[0],
      ownerToken: "queue-owner-a",
      resultKind: "queued",
      identities: queueClaims[0].reservation.identities,
      queueMessage: {
        content: "queue-a",
        displayContent: "queue-a",
        messageInput: { text: "queue-a" },
        conversation: { idempotencyKey: concurrentMarkers[0] },
        deviceRuntimeRequestId: "queue-request-a",
        deviceRuntimeTaskId: "queue-task-a",
        workflowV2AttemptId: "queue-attempt-a",
        workflowV2UserMessageId: "queue-user-a",
      },
    })),
    asyncCall(() => storeB.commitTabSend({
      tabId: atomicStory.id,
      marker: concurrentMarkers[1],
      ownerToken: "queue-owner-b",
      resultKind: "queued",
      identities: queueClaims[1].reservation.identities,
      queueMessage: {
        content: "queue-b",
        displayContent: "queue-b",
        messageInput: { text: "queue-b" },
        conversation: { idempotencyKey: concurrentMarkers[1] },
        deviceRuntimeRequestId: "queue-request-b",
        deviceRuntimeTaskId: "queue-task-b",
        workflowV2AttemptId: "queue-attempt-b",
        workflowV2UserMessageId: "queue-user-b",
      },
    })),
  ]);
  assert.ok(queueCommits.every((commit) => commit.ok));
  const atomicQueue = store.getTab(atomicStory.id).queue;
  assert.equal(atomicQueue.length, 3);
  assert.deepEqual(
    atomicQueue.map((message) => message.deviceRuntimeRequestId).sort(),
    ["atomic-request-1", "queue-request-a", "queue-request-b"],
  );

  // The injection acknowledgement is persisted before appendMessage. Even if
  // the conversation filesystem write fails, a retry replays the committed
  // injected result and never invokes the underlying injection a second time.
  const injectionWorktree = path.join(root, "injection-story-worktree");
  const injectionBase = path.join(root, "injection-base-repository");
  fs.mkdirSync(injectionWorktree, { recursive: true });
  fs.mkdirSync(injectionBase, { recursive: true });
  const injectionStory = store.createTab({ title: `注入结果先持久化-${Date.now()}` });
  const injectionTaskId = `injection-${injectionStory.id}`;
  store.updateTab(injectionStory.id, {
    worktreeStatus: "ready",
    worktree: {
      managed: true,
      entries: [{
        role: "primary",
        active: true,
        name: "注入测试工程",
        path: injectionWorktree,
        worktreePath: injectionWorktree,
        basePath: injectionBase,
      }],
    },
    runningTaskId: injectionTaskId,
  });
  createTask({
    id: injectionTaskId,
    title: "注入幂等测试",
    description: "模拟底层已确认但会话文件写入失败",
    type: "general",
    status: "running",
    priority: 3,
    source: "devbench",
    sourceId: injectionStory.sessionId,
  });
  let injectionCount = 0;
  const virtualProcessKey = `idempotency-inject-${injectionStory.id}`;
  agentRunner.registerVirtualProcess(virtualProcessKey, {
    taskId: injectionTaskId,
    streamingInput: true,
    injectUser: async () => {
      injectionCount += 1;
      return true;
    },
  });
  t.after(() => agentRunner.unregisterProcess(virtualProcessKey));
  const injectionPayload = {
    content: "底层只允许注入一次",
    messageInput: { text: "底层只允许注入一次", clientMessageId: "inject-once-key" },
  };
  fs.rmSync(process.env.DEVBENCH_STORE_DIR, { recursive: true, force: true });
  fs.writeFileSync(process.env.DEVBENCH_STORE_DIR, "block conversation file writes", "utf8");
  const injectionFirst = await post(base, injectionStory.id, injectionPayload);
  assert.equal(injectionFirst.status, 500, JSON.stringify(injectionFirst.body));
  assert.equal(injectionFirst.body.code, "SEND_IDEMPOTENCY_RESULT_PERSIST_FAILED");
  assert.equal(injectionFirst.body.partial, true);
  assert.equal(injectionCount, 1);
  fs.rmSync(process.env.DEVBENCH_STORE_DIR, { force: true });
  fs.mkdirSync(process.env.DEVBENCH_STORE_DIR, { recursive: true });
  const injectionReplay = await post(base, injectionStory.id, injectionPayload);
  assert.equal(injectionReplay.status, 200, JSON.stringify(injectionReplay.body));
  assert.equal(injectionReplay.body.duplicate, true, JSON.stringify(injectionReplay.body));
  assert.equal(injectionReplay.body.injected, true, JSON.stringify(injectionReplay.body));
  assert.equal(injectionReplay.body.data.taskId, injectionTaskId);
  assert.equal(injectionCount, 1, "会话写入失败后的重试不得再次注入");
  agentRunner.unregisterProcess(virtualProcessKey);
  updateTask(injectionTaskId, { status: "completed" });

});

test("legacy sendTurn 出队时复用已冻结的 task/attempt/user 三元身份", () => {
  const source = fs.readFileSync(new URL("../services/devbench/index.js", import.meta.url), "utf8");
  assert.match(source, /opts\.taskId \|\| opts\.deviceRuntimeTaskId/);
  assert.match(source, /opts\.attemptId \|\| opts\.workflowV2AttemptId/);
  assert.match(source, /opts\.userMessageId \|\| opts\.workflowV2UserMessageId/);
});

test("/send 持久 reservation 早于所有刷新和派发边界，注入确认早于会话落盘", () => {
  const source = fs.readFileSync(new URL("../routes/devbench.js", import.meta.url), "utf8");
  const start = source.indexOf('router.post("/tabs/:id/send"');
  const end = source.indexOf("async function kickTriage", start);
  const route = source.slice(start, end);
  const reservation = route.indexOf("store.reserveTabSend({");
  assert.ok(reservation >= 0, "keyed send 必须先建立 SQLite reservation");
  for (const boundary of [
    "refreshGitCommitLatestBranch",
    "fetchAndSaveTbNote",
    "fetchAndSaveTbContext",
    "prepareTbAttachmentsForAgent",
    "injectIntoTask",
    "enqueueReservedTabMessage",
    "kickTriage",
    "kickVerify",
    "kickReport",
    "sendTurnWithDeviceRuntime",
  ]) {
    assert.ok(route.indexOf(boundary) > reservation, `${boundary} 必须晚于持久 reservation`);
  }
  const injection = route.indexOf("await injectIntoTask");
  const injectedCommit = route.indexOf('"injected"', injection);
  const appendMessage = route.indexOf("store.appendMessage", injection);
  assert.ok(injection > reservation && injectedCommit > injection && appendMessage > injectedCommit);
  assert.doesNotMatch(route, /messageInput\.clientMessageId\s*=\s*idempotencyInput\.key/);
  assert.match(route, /store\.releaseTabSend\(/);
});
