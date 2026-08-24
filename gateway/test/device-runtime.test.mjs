import { test } from "node:test";
import assert from "node:assert/strict";

import {
  createDeviceRuntimeCoordinator,
  DEVICE_RUNTIME_ERROR,
  DEVICE_RUNTIME_STATUS,
  DeviceRuntimeError,
  MAX_DEVICE_RUNTIME_TTL_MS,
} from "../services/devbench/device-runtime.js";
import {
  ensureQueuedMessageRuntimeIdentity,
  rotateQueuedMessageDeviceRequestId,
} from "../services/devbench/conversation/queued-message.js";

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function createMemoryStorage() {
  const records = new Map();
  return {
    read(serial) {
      return clone(records.get(serial) || null);
    },
    atomicUpdate(serial, transition) {
      const envelope = transition(clone(records.get(serial) || null));
      assert.ok(envelope && typeof envelope === "object");
      assert.ok("state" in envelope);
      assert.ok("result" in envelope);
      records.set(serial, clone(envelope.state));
      return clone(envelope);
    },
    raw(serial) {
      return clone(records.get(serial) || null);
    },
  };
}

function createFixture({ startAt = 1_000, ttlMs = 100 } = {}) {
  const storage = createMemoryStorage();
  let clock = startAt;
  let leaseSequence = 0;
  const coordinator = createDeviceRuntimeCoordinator({
    ...storage,
    now: () => clock,
    idFactory: () => `lease-${++leaseSequence}`,
    defaultTtlMs: ttlMs,
    historyLimit: 20,
  });
  return {
    coordinator,
    storage,
    now: () => clock,
    advance(ms) {
      clock += ms;
    },
  };
}

function request(requestId, storyId = requestId, overrides = {}) {
  return {
    serial: "SERIAL-001",
    requestId,
    storyId,
    taskId: `task-${storyId}`,
    operationKind: "verify",
    ownerId: `gateway-${storyId}`,
    ...overrides,
  };
}

async function expectRuntimeError(promise, code, statusCode) {
  await assert.rejects(promise, (error) => {
    assert.ok(error instanceof DeviceRuntimeError);
    assert.equal(error.code, code);
    assert.equal(error.statusCode, statusCode);
    return true;
  });
}

test("device runtime grants one lease, keeps a FIFO queue, and makes requestId idempotent", async () => {
  const { coordinator } = createFixture();

  const first = await coordinator.acquire(request("request-1", "story-1"));
  assert.equal(first.status, DEVICE_RUNTIME_STATUS.ACQUIRED);
  assert.equal(first.lease.leaseId, "lease-1");
  assert.equal(first.lease.fencingToken, 1);

  const firstReplay = await coordinator.acquire(request("request-1", "story-1"));
  assert.equal(firstReplay.status, DEVICE_RUNTIME_STATUS.ACQUIRED);
  assert.equal(firstReplay.idempotent, true);
  assert.equal(firstReplay.lease.leaseId, first.lease.leaseId);

  const second = await coordinator.acquire(request("request-2", "story-2"));
  const third = await coordinator.acquire(request("request-3", "story-3"));
  assert.equal(second.status, DEVICE_RUNTIME_STATUS.QUEUED);
  assert.equal(second.position, 1);
  assert.equal(third.status, DEVICE_RUNTIME_STATUS.QUEUED);
  assert.equal(third.position, 2);

  const secondReplay = await coordinator.acquire(request("request-2", "story-2"));
  assert.equal(secondReplay.idempotent, true);
  assert.equal(secondReplay.position, 1);

  const releasedFirst = await coordinator.release({
    serial: "SERIAL-001",
    leaseId: first.lease.leaseId,
    fencingToken: first.lease.fencingToken,
  });
  assert.equal(releasedFirst.status, DEVICE_RUNTIME_STATUS.RELEASED);
  assert.equal(releasedFirst.nextLease.requestId, "request-2");
  assert.equal(releasedFirst.nextLease.leaseId, "lease-2");
  assert.equal(releasedFirst.nextLease.fencingToken, 2);
  assert.deepEqual(
    releasedFirst.snapshot.queue.map((entry) => [entry.requestId, entry.position]),
    [["request-3", 1]],
  );

  const releasedSecond = await coordinator.release({
    serial: "SERIAL-001",
    leaseId: releasedFirst.nextLease.leaseId,
    fencingToken: releasedFirst.nextLease.fencingToken,
  });
  assert.equal(releasedSecond.nextLease.requestId, "request-3");
  assert.equal(releasedSecond.nextLease.fencingToken, 3);

  const staleRelease = await coordinator.release({
    serial: "SERIAL-001",
    leaseId: first.lease.leaseId,
    fencingToken: first.lease.fencingToken,
  });
  assert.equal(staleRelease.idempotent, true);
  assert.equal(staleRelease.status, DEVICE_RUNTIME_STATUS.RELEASED);
  assert.equal(staleRelease.snapshot.lease.requestId, "request-3");

  await expectRuntimeError(
    coordinator.acquire(request("request-3", "different-story")),
    DEVICE_RUNTIME_ERROR.REQUEST_CONFLICT,
    409,
  );
});

test("pre-start release 的 terminal requestId 不能复用，轮换请求后可再次取得同 task 的租约", async () => {
  const { coordinator } = createFixture();
  const ids = ["workflow-task", "workflow-attempt", "workflow-user"];
  const frozen = ensureQueuedMessageRuntimeIdentity({ content: "设备排队重试" }, {
    storyId: "workflow-story",
    idFactory: () => ids.shift(),
  });
  const firstRequest = request(frozen.deviceRuntimeRequestId, "workflow-story", {
    taskId: frozen.deviceRuntimeTaskId,
  });
  const acquired = await coordinator.acquire(firstRequest);
  await coordinator.release({
    serial: "SERIAL-001",
    leaseId: acquired.lease.leaseId,
    fencingToken: acquired.lease.fencingToken,
    reason: "turn_rejected_before_start",
  });
  const terminalReplay = await coordinator.acquire(firstRequest);
  assert.equal(terminalReplay.status, DEVICE_RUNTIME_STATUS.RELEASED);

  const rotated = rotateQueuedMessageDeviceRequestId(frozen, {
    storyId: "workflow-story",
    idFactory: () => "retry-request",
  });
  const retried = await coordinator.acquire(request(rotated.deviceRuntimeRequestId, "workflow-story", {
    taskId: rotated.deviceRuntimeTaskId,
  }));
  assert.equal(retried.status, DEVICE_RUNTIME_STATUS.ACQUIRED);
  assert.equal(retried.lease.taskId, frozen.deviceRuntimeTaskId);
});

test("heartbeat renews only an exact lease and expired leases cannot be revived", async () => {
  const fixture = createFixture();
  const { coordinator } = fixture;
  const acquired = await coordinator.acquire(request("heartbeat-request", "heartbeat-story"));

  fixture.advance(50);
  const renewed = await coordinator.heartbeat({
    serial: "SERIAL-001",
    leaseId: acquired.lease.leaseId,
    fencingToken: acquired.lease.fencingToken,
  });
  assert.equal(renewed.status, DEVICE_RUNTIME_STATUS.RENEWED);
  assert.equal(renewed.lease.heartbeatAt, fixture.now());
  assert.equal(renewed.lease.expiresAt, fixture.now() + 100);

  await expectRuntimeError(
    coordinator.heartbeat({
      serial: "SERIAL-001",
      leaseId: acquired.lease.leaseId,
      fencingToken: acquired.lease.fencingToken + 1,
    }),
    DEVICE_RUNTIME_ERROR.LEASE_MISMATCH,
    409,
  );

  fixture.advance(101);
  const recovered = await coordinator.recoverExpired("SERIAL-001");
  assert.equal(recovered.status, DEVICE_RUNTIME_STATUS.RECOVERED);
  assert.equal(recovered.expiredLease.requestId, "heartbeat-request");
  assert.equal(recovered.snapshot.status, DEVICE_RUNTIME_STATUS.IDLE);

  await expectRuntimeError(
    coordinator.heartbeat({
      serial: "SERIAL-001",
      leaseId: acquired.lease.leaseId,
      fencingToken: acquired.lease.fencingToken,
    }),
    DEVICE_RUNTIME_ERROR.LEASE_EXPIRED,
    410,
  );
});

test("cancel removes queued work and requires exact lease credentials for active work", async () => {
  const { coordinator } = createFixture();
  const first = await coordinator.acquire(request("cancel-1", "story-1"));
  await coordinator.acquire(request("cancel-2", "story-2"));
  await coordinator.acquire(request("cancel-3", "story-3"));

  const cancelledQueue = await coordinator.cancel({
    serial: "SERIAL-001",
    requestId: "cancel-2",
    reason: "user_cancelled",
  });
  assert.equal(cancelledQueue.status, DEVICE_RUNTIME_STATUS.CANCELLED);
  assert.equal(cancelledQueue.idempotent, false);
  assert.deepEqual(
    cancelledQueue.snapshot.queue.map((entry) => [entry.requestId, entry.position]),
    [["cancel-3", 1]],
  );

  const cancelledReplay = await coordinator.cancel({
    serial: "SERIAL-001",
    requestId: "cancel-2",
  });
  assert.equal(cancelledReplay.idempotent, true);
  assert.equal(cancelledReplay.status, DEVICE_RUNTIME_STATUS.CANCELLED);

  await expectRuntimeError(
    coordinator.cancel({ serial: "SERIAL-001", requestId: "cancel-1" }),
    DEVICE_RUNTIME_ERROR.ACTIVE_CANCEL_REQUIRES_LEASE,
    409,
  );

  const cancelledActive = await coordinator.cancel({
    serial: "SERIAL-001",
    requestId: "cancel-1",
    leaseId: first.lease.leaseId,
    fencingToken: first.lease.fencingToken,
  });
  assert.equal(cancelledActive.status, DEVICE_RUNTIME_STATUS.CANCELLED);
  assert.equal(cancelledActive.nextLease.requestId, "cancel-3");
  assert.equal(cancelledActive.nextLease.fencingToken, 2);

  await expectRuntimeError(
    coordinator.cancel({ serial: "SERIAL-001", requestId: "missing-request" }),
    DEVICE_RUNTIME_ERROR.REQUEST_NOT_FOUND,
    404,
  );
});

test("TTL recovery survives coordinator restart, expires the owner, and grants the FIFO head", async () => {
  const storage = createMemoryStorage();
  let clock = 5_000;
  let leaseSequence = 0;
  const options = {
    ...storage,
    now: () => clock,
    idFactory: () => `restart-lease-${++leaseSequence}`,
    defaultTtlMs: 50,
  };
  const beforeRestart = createDeviceRuntimeCoordinator(options);
  const first = await beforeRestart.acquire(request("restart-1", "story-1"));
  await beforeRestart.acquire(request("restart-2", "story-2"));
  await beforeRestart.acquire(request("restart-3", "story-3"));

  clock += 51;
  const afterRestart = createDeviceRuntimeCoordinator(options);
  const snapshot = await afterRestart.snapshot("SERIAL-001");
  assert.equal(snapshot.lease.requestId, "restart-2");
  assert.equal(snapshot.lease.fencingToken, 2);
  assert.deepEqual(snapshot.queue.map((entry) => entry.requestId), ["restart-3"]);
  assert.equal(snapshot.recentTerminal[0].requestId, "restart-1");
  assert.equal(snapshot.recentTerminal[0].status, DEVICE_RUNTIME_STATUS.EXPIRED);

  const expiredReplay = await afterRestart.acquire(request("restart-1", "story-1"));
  assert.equal(expiredReplay.idempotent, true);
  assert.equal(expiredReplay.status, DEVICE_RUNTIME_STATUS.EXPIRED);
  assert.equal(expiredReplay.terminal.leaseId, first.lease.leaseId);
  assert.equal((await afterRestart.snapshot("SERIAL-001")).queue.length, 1);
});

test("snapshot can be read without recovery and errors expose stable codes", async () => {
  const fixture = createFixture();
  const { coordinator } = fixture;
  const acquired = await coordinator.acquire(request("snapshot-1", "story-1"));

  await expectRuntimeError(
    coordinator.release({
      serial: "SERIAL-001",
      leaseId: acquired.lease.leaseId,
      fencingToken: acquired.lease.fencingToken + 1,
    }),
    DEVICE_RUNTIME_ERROR.LEASE_MISMATCH,
    409,
  );

  fixture.advance(101);
  const staleSnapshot = await coordinator.snapshot("SERIAL-001", { recoverExpired: false });
  assert.equal(staleSnapshot.status, DEVICE_RUNTIME_STATUS.EXPIRED);
  assert.equal(staleSnapshot.lease.expired, true);

  await expectRuntimeError(
    coordinator.acquire({ serial: "SERIAL-001", requestId: "invalid" }),
    DEVICE_RUNTIME_ERROR.INVALID_ARGUMENT,
    400,
  );

  await expectRuntimeError(
    coordinator.heartbeat({ serial: "SERIAL-001", leaseId: acquired.lease.leaseId }),
    DEVICE_RUNTIME_ERROR.INVALID_ARGUMENT,
    400,
  );
});

test("lease TTL 有服务端上限，插件不能用超长续期长期锁死设备", async () => {
  const fixture = createFixture();
  await expectRuntimeError(
    fixture.coordinator.acquire(request("oversized-acquire", "story-ttl", {
      ttlMs: MAX_DEVICE_RUNTIME_TTL_MS + 1,
    })),
    DEVICE_RUNTIME_ERROR.INVALID_ARGUMENT,
    400,
  );

  const acquired = await fixture.coordinator.acquire(request("bounded-acquire", "story-ttl"));
  await expectRuntimeError(
    fixture.coordinator.heartbeat({
      serial: "SERIAL-001",
      leaseId: acquired.lease.leaseId,
      fencingToken: acquired.lease.fencingToken,
      ttlMs: 31_536_000_000,
    }),
    DEVICE_RUNTIME_ERROR.INVALID_ARGUMENT,
    400,
  );
  assert.throws(
    () => createDeviceRuntimeCoordinator({
      ...createMemoryStorage(),
      defaultTtlMs: MAX_DEVICE_RUNTIME_TTL_MS + 1,
    }),
    (error) => error?.code === DEVICE_RUNTIME_ERROR.INVALID_ARGUMENT,
  );
});

test("same storyId re-acquire evicts stale lease and grants immediately when no other stories are waiting", async () => {
  const fixture = createFixture();
  const { coordinator } = fixture;

  const first = await coordinator.acquire(request("old-request", "same-story"));
  assert.equal(first.status, DEVICE_RUNTIME_STATUS.ACQUIRED);
  assert.equal(first.lease.leaseId, "lease-1");

  const second = await coordinator.acquire(request("new-request", "same-story"));
  assert.equal(second.status, DEVICE_RUNTIME_STATUS.ACQUIRED);
  assert.equal(second.idempotent, false);
  assert.equal(second.lease.requestId, "new-request");
  assert.equal(second.lease.leaseId, "lease-2");
  assert.ok(second.evicted);
  assert.equal(second.evicted.evictedLeases.length, 1);
  assert.equal(second.evicted.evictedLeases[0].requestId, "old-request");
  assert.equal(second.evicted.evictedQueued.length, 0);

  const snapshot = await coordinator.snapshot("SERIAL-001");
  assert.equal(snapshot.lease.requestId, "new-request");
  assert.equal(snapshot.queue.length, 0);

  const firstHeartbeat = await coordinator.heartbeat({
    serial: "SERIAL-001",
    leaseId: first.lease.leaseId,
    fencingToken: first.lease.fencingToken,
  }).catch((error) => error);
  assert.ok(firstHeartbeat instanceof DeviceRuntimeError);
  assert.equal(firstHeartbeat.code, DEVICE_RUNTIME_ERROR.LEASE_NOT_FOUND);
});

test("same storyId re-acquire evicts stale lease but respects FIFO when other stories are waiting", async () => {
  const { coordinator } = createFixture();

  await coordinator.acquire(request("old-request", "same-story"));
  const other = await coordinator.acquire(request("other-request", "other-story"));
  assert.equal(other.status, DEVICE_RUNTIME_STATUS.QUEUED);

  const second = await coordinator.acquire(request("new-request", "same-story"));
  assert.equal(second.status, DEVICE_RUNTIME_STATUS.QUEUED);
  assert.equal(second.position, 1);
  assert.ok(second.evicted);
  assert.equal(second.evicted.evictedLeases.length, 1);
  assert.equal(second.evicted.evictedLeases[0].requestId, "old-request");

  const snapshot = await coordinator.snapshot("SERIAL-001");
  assert.equal(snapshot.lease.requestId, "other-request");
  assert.deepEqual(
    snapshot.queue.map((entry) => entry.requestId),
    ["new-request"],
  );
});

test("same storyId re-acquire evicts its own stale lease promoted from queue and grants immediately", async () => {
  const { coordinator } = createFixture();

  const first = await coordinator.acquire(request("req-a", "story-a"));
  const second = await coordinator.acquire(request("req-b", "story-b"));
  assert.equal(second.status, DEVICE_RUNTIME_STATUS.QUEUED);

  const released = await coordinator.release({
    serial: "SERIAL-001",
    leaseId: first.lease.leaseId,
    fencingToken: first.lease.fencingToken,
  });
  assert.equal(released.nextLease.requestId, "req-b");

  const replay = await coordinator.acquire(request("req-b2", "story-b"));
  assert.equal(replay.status, DEVICE_RUNTIME_STATUS.ACQUIRED);
  assert.ok(replay.evicted);
  assert.equal(replay.evicted.evictedLeases.length, 1);
  assert.equal(replay.evicted.evictedLeases[0].requestId, "req-b");
  assert.equal(replay.evicted.evictedQueued.length, 0);

  const snapshot = await coordinator.snapshot("SERIAL-001");
  assert.equal(snapshot.lease.requestId, "req-b2");
  assert.equal(snapshot.queue.length, 0);
});

test("same storyId acquire with no prior entries does not report evicted", async () => {
  const { coordinator } = createFixture();
  const first = await coordinator.acquire(request("fresh-request", "fresh-story"));
  assert.equal(first.status, DEVICE_RUNTIME_STATUS.ACQUIRED);
  assert.equal(first.evicted, null);
});
