import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "story-device-close-"));
process.env.NODE_ENV = "test";
process.env.GATEWAY_DB_PATH = path.join(root, "gateway.db");
process.env.GATEWAY_CONFIG_PATH = path.join(root, "gateway.json");
process.env.DEVBENCH_CONFIG_PATH = path.join(root, "market.json");
process.env.DEVBENCH_LOCAL_PROJECTS_PATH = path.join(root, "local", "devbench-projects.json");
process.env.DEVBENCH_STORE_DIR = path.join(root, "store");
process.env.AIEFFICIENCY_CLONE_PARENT = path.join(root, "clone-parent");
process.env.ROLE = "standalone";
fs.mkdirSync(path.dirname(process.env.DEVBENCH_LOCAL_PROJECTS_PATH), { recursive: true });
fs.mkdirSync(process.env.AIEFFICIENCY_CLONE_PARENT, { recursive: true });
fs.writeFileSync(process.env.GATEWAY_CONFIG_PATH, JSON.stringify({ role: "standalone", servers: { nodeId: "device-close" } }));
fs.writeFileSync(process.env.DEVBENCH_CONFIG_PATH, "{}");
fs.writeFileSync(process.env.DEVBENCH_LOCAL_PROJECTS_PATH, JSON.stringify({
  version: 2,
  cloneParent: process.env.AIEFFICIENCY_CLONE_PARENT,
  projects: [],
}));

const express = (await import("express")).default;
const router = (await import("../routes/devbench.js")).default;
const store = await import("../services/devbench/store.js");
const runtime = await import("../services/devbench/device-runtime-service.js");
const { scheduleTabQueueDrain } = await import("../services/devbench/index.js");

async function waitFor(read, predicate, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await read();
    if (predicate(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("等待设备持久队列状态超时");
}

test("关闭故事点会取消它的设备 FIFO 请求，活动设备任务则必须先停止", { timeout: 30_000 }, async (t) => {
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
  const serial = "CLOSE-QUEUE-SERIAL-17008";
  const blocker = store.createTab({ title: "设备关闭门禁-占用者" });
  const closing = store.createTab({ title: "设备关闭门禁-待关闭" });
  store.updateTabDeviceBinding(blocker.id, { deviceSerial: serial });
  store.updateTabDeviceBinding(closing.id, { deviceSerial: serial });

  const active = await runtime.acquireDeviceUse({
    serial,
    requestId: "close-blocker",
    storyId: blocker.id,
    taskId: "close-blocker-task",
    operationKind: "integration-test",
    ownerId: "close-test",
  });
  store.updateTab(closing.id, { queue: ["one", "two"] });
  scheduleTabQueueDrain(closing.id);
  const materialized = await waitFor(
    () => Promise.resolve(store.getTab(closing.id)),
    (tab) => !!tab?.queue?.[0]?.deviceRuntimeRequestId,
  );
  const persistedRequestId = materialized.queue[0].deviceRuntimeRequestId;
  const persistedTaskId = materialized.queue[0].deviceRuntimeTaskId;
  assert.ok(persistedRequestId);
  assert.ok(persistedTaskId);
  scheduleTabQueueDrain(closing.id);
  scheduleTabQueueDrain(closing.id);
  const queuedOnce = await waitFor(
    () => runtime.getDeviceRuntimeSnapshot(serial, { recoverExpired: false }),
    (snapshot) => snapshot.queue.some((item) => item.requestId === persistedRequestId),
  );
  assert.deepEqual(
    queuedOnce.queue.filter((item) => item.storyId === closing.id).map((item) => item.requestId),
    [persistedRequestId],
    "重复 drain 必须复用已持久化的 requestId，不能生成 R2/R3",
  );
  assert.equal(store.getTab(closing.id).queue[0].deviceRuntimeTaskId, persistedTaskId);

  const closedResponse = await fetch(`${base}/tabs/${closing.id}`, { method: "DELETE" });
  const closed = await closedResponse.json();
  assert.equal(closedResponse.status, 200, JSON.stringify(closed));
  assert.equal(closed.ok, true, JSON.stringify(closed));
  assert.equal(store.getTab(closing.id), null);
  const afterClose = await runtime.getDeviceRuntimeSnapshot(serial, { recoverExpired: false });
  assert.equal(afterClose.lease.requestId, "close-blocker");
  assert.deepEqual(afterClose.queue.filter((item) => item.storyId === closing.id), []);

  await runtime.releaseDeviceUse({
    serial,
    leaseId: active.lease.leaseId,
    fencingToken: active.lease.fencingToken,
    reason: "integration-test",
  });
  const running = store.createTab({ title: "设备关闭门禁-运行中" });
  store.updateTabDeviceBinding(running.id, { deviceSerial: serial });
  const runningLease = await runtime.acquireDeviceUse({
    serial,
    requestId: "close-active-story",
    storyId: running.id,
    taskId: "close-active-story-task",
    operationKind: "external-plugin",
    ownerId: "close-test",
  });
  const rejectedResponse = await fetch(`${base}/tabs/${running.id}`, { method: "DELETE" });
  const rejected = await rejectedResponse.json();
  assert.equal(rejectedResponse.status, 409, JSON.stringify(rejected));
  assert.equal(rejected.code, "DEVICE_RUNTIME_STORY_ACTIVE");
  assert.ok(store.getTab(running.id));
  await runtime.cancelDeviceUse({
    serial,
    requestId: runningLease.requestId,
    leaseId: runningLease.lease.leaseId,
    fencingToken: runningLease.lease.fencingToken,
    reason: "test_cleanup",
  });
});
