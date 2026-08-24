import assert from "node:assert/strict";
import test from "node:test";

import { createImmediateDeviceOperationGuard } from "../services/devbench/device-operation-guard.js";

function acquiredResult(overrides = {}) {
  return {
    ok: true,
    status: "acquired",
    requestId: "temporary-request",
    lease: {
      serial: "SERIAL-GUARD",
      requestId: "temporary-request",
      storyId: "external:test",
      taskId: "temporary-request",
      operationKind: "test_operation",
      leaseId: "lease-temporary",
      fencingToken: 7,
    },
    snapshot: { status: "busy", lease: null, queue: [] },
    ...overrides,
  };
}

test("忙碌设备返回结构化 409，撤销临时请求且不调用底层操作", async () => {
  let operationCalls = 0;
  const cancelled = [];
  const activeLease = {
    requestId: "story-request",
    storyId: "story-running",
    operationKind: "apk_install",
    ownerId: "gateway:other",
    metadata: { title: "正在安装的故事点" },
  };
  const waiting = { requestId: "story-waiting", storyId: "story-waiting" };
  const guard = createImmediateDeviceOperationGuard({
    idFactory: () => "temporary-request",
    acquire: async () => ({
      ok: true,
      status: "queued",
      position: 2,
      snapshot: {
        status: "busy",
        lease: activeLease,
        queue: [waiting, { requestId: "device-op:temporary-request", storyId: "external:test" }],
      },
    }),
    cancel: async (input) => {
      cancelled.push(input);
      return {
        ok: true,
        status: "cancelled",
        snapshot: { status: "busy", lease: activeLease, queue: [waiting] },
      };
    },
    heartbeat: async () => ({ ok: true }),
    release: async () => {
      assert.fail("未取得 lease 时不得 release");
    },
  });

  const result = await guard({
    serial: "SERIAL-GUARD",
    storyId: "external:test",
    operationKind: "raw_adb",
  }, async () => {
    operationCalls += 1;
  });

  assert.equal(result.ok, false);
  assert.equal(result.statusCode, 409);
  assert.equal(result.code, "DEVICE_RUNTIME_BUSY");
  assert.equal(result.currentOwner.storyId, "story-running");
  assert.deepEqual(result.queue.map((item) => item.requestId), ["story-waiting"]);
  assert.equal(result.position, 2);
  assert.equal(operationCalls, 0, "忙碌时底层 ADB/安装命令必须保持零调用");
  assert.equal(cancelled.length, 1);
  assert.equal(cancelled[0].requestId, "device-op:temporary-request");
});

test("空闲设备先取得 lease，执行成功后释放并通知下一位", async () => {
  const calls = [];
  const nextLease = { storyId: "story-next", requestId: "request-next" };
  let releasedNotification = null;
  const guard = createImmediateDeviceOperationGuard({
    acquire: async (input) => {
      calls.push(["acquire", input]);
      return acquiredResult();
    },
    cancel: async () => assert.fail("已取得 lease 时不得 cancel"),
    heartbeat: async (input) => {
      calls.push(["heartbeat", input]);
      return { ok: true };
    },
    release: async (input) => {
      calls.push(["release", input]);
      return { ok: true, status: "released", nextLease };
    },
  });

  const result = await guard({
    serial: "SERIAL-GUARD",
    requestId: "temporary-request",
    storyId: "external:test",
    operationKind: "shell",
    onReleased(value) { releasedNotification = value; },
  }, async (serial, lease) => {
    calls.push(["operation", { serial, lease }]);
    return { ok: true, stdout: "done" };
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.value, { ok: true, stdout: "done" });
  assert.deepEqual(calls.map(([kind]) => kind), ["acquire", "operation", "release"]);
  assert.equal(calls[1][1].serial, "SERIAL-GUARD");
  assert.equal(calls[2][1].leaseId, "lease-temporary");
  assert.equal(calls[2][1].fencingToken, 7);
  assert.equal(releasedNotification.nextLease.storyId, "story-next");
});

test("底层操作抛异常也必须释放 lease，并返回可诊断失败", async () => {
  let releaseCalls = 0;
  const guard = createImmediateDeviceOperationGuard({
    acquire: async () => acquiredResult(),
    cancel: async () => assert.fail("已取得 lease 时不得 cancel"),
    heartbeat: async () => ({ ok: true }),
    release: async () => {
      releaseCalls += 1;
      return { ok: true, status: "released", nextLease: null };
    },
  });

  const result = await guard({
    serial: "SERIAL-GUARD",
    requestId: "temporary-request",
    storyId: "external:test",
    operationKind: "apk_install",
  }, async () => {
    throw new Error("simulated install failure");
  });

  assert.equal(result.ok, false);
  assert.equal(result.statusCode, 500);
  assert.equal(result.code, "DEVICE_OPERATION_FAILED");
  assert.match(result.error, /simulated install failure/);
  assert.equal(releaseCalls, 1, "异常路径也必须释放设备 lease");
});

test("未提供 serial 时保留旧默认设备语义且不申请租约", async () => {
  let acquireCalls = 0;
  const guard = createImmediateDeviceOperationGuard({
    acquire: async () => { acquireCalls += 1; },
    cancel: async () => {},
    heartbeat: async () => {},
    release: async () => {},
  });
  const result = await guard({ operationKind: "shell" }, async (serial) => ({ serial }));
  assert.equal(result.ok, true);
  assert.equal(result.guarded, false);
  assert.deepEqual(result.value, { serial: null });
  assert.equal(acquireCalls, 0);
});
