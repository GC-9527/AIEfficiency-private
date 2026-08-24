import { randomUUID } from "node:crypto";

const DEFAULT_TTL_MS = 30_000;
const MIN_HEARTBEAT_INTERVAL_MS = 1_000;

function text(value) {
  return String(value ?? "").trim();
}

function errorPayload(error, fallbackCode, fallbackMessage, statusCode = 500) {
  return {
    ok: false,
    statusCode: Number(error?.statusCode) || statusCode,
    code: text(error?.code) || fallbackCode,
    error: text(error?.message) || fallbackMessage,
    ...(error?.details === undefined ? {} : { details: error.details }),
  };
}

function snapshotWithoutRequest(snapshot, requestId) {
  if (!snapshot || typeof snapshot !== "object") return null;
  return {
    ...snapshot,
    queue: (Array.isArray(snapshot.queue) ? snapshot.queue : [])
      .filter((entry) => text(entry?.requestId) !== requestId),
  };
}

function busyPayload({ serial, operationKind, position, snapshot }) {
  const currentOwner = snapshot?.lease || null;
  const queue = Array.isArray(snapshot?.queue) ? snapshot.queue : [];
  const ownerLabel = currentOwner?.metadata?.title
    || currentOwner?.storyId
    || currentOwner?.ownerId
    || "其它任务";
  const ownerOperation = currentOwner?.operationKind ? `（${currentOwner.operationKind}）` : "";
  return {
    ok: false,
    statusCode: 409,
    code: "DEVICE_RUNTIME_BUSY",
    error: `设备 ${serial} 正由 ${ownerLabel}${ownerOperation} 使用，当前等待队列 ${queue.length} 项；此入口不支持安全排队，请稍后重试`,
    serial,
    operationKind,
    currentOwner,
    queue,
    runtime: snapshot || null,
    position: Number(position) || null,
  };
}

/**
 * 为无法安全进入故事点持久队列的短期 HTTP/插件操作提供 fail-fast 设备互斥。
 *
 * 关键约束：
 * - acquire 本身就是持久化原子操作，不能先 snapshot 再执行，避免 TOCTOU；
 * - 若排到队列，立即撤销本次临时 request 并返回结构化 409；
 * - 已获得 lease 时用 heartbeat 覆盖耗时安装，并在成功/失败后 finally 释放；
 * - serial 为空时不接管旧的 ADB 默认设备语义。
 */
export function createImmediateDeviceOperationGuard({
  acquire,
  cancel,
  heartbeat,
  release,
  idFactory = () => randomUUID(),
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
} = {}) {
  if (
    typeof acquire !== "function"
    || typeof cancel !== "function"
    || typeof heartbeat !== "function"
    || typeof release !== "function"
  ) {
    throw new TypeError("acquire/cancel/heartbeat/release callbacks are required");
  }
  return async function runImmediateDeviceOperation(input = {}, operation) {
    if (typeof operation !== "function") {
      return {
        ok: false,
        statusCode: 500,
        code: "DEVICE_OPERATION_INVALID",
        error: "device operation callback is required",
      };
    }

    const serial = text(input.serial);
    if (!serial) {
      try {
        return { ok: true, guarded: false, value: await operation(null, null) };
      } catch (error) {
        return errorPayload(error, "DEVICE_OPERATION_FAILED", "设备操作失败");
      }
    }

    const operationKind = text(input.operationKind) || "immediate_device_operation";
    const storyId = text(input.storyId) || "external:device-operation";
    const requestId = text(input.requestId) || `device-op:${idFactory()}`;
    const taskId = text(input.taskId) || requestId;
    const ttlMs = Number.isSafeInteger(Number(input.ttlMs)) && Number(input.ttlMs) > 0
      ? Number(input.ttlMs)
      : DEFAULT_TTL_MS;

    let acquired;
    try {
      acquired = await acquire({
        serial,
        requestId,
        storyId,
        taskId,
        operationKind,
        ownerId: text(input.ownerId) || undefined,
        ttlMs,
        metadata: input.metadata,
      });
    } catch (error) {
      return errorPayload(error, "DEVICE_RUNTIME_ACQUIRE_FAILED", "申请设备运行时租约失败");
    }

    if (acquired?.status !== "acquired" || !acquired?.lease) {
      let snapshot = acquired?.snapshot || null;
      try {
        const cancelled = await cancel({
          serial,
          requestId,
          reason: "immediate_operation_busy",
        });
        snapshot = cancelled?.snapshot || snapshot;
      } catch {
        // 即使撤销回包失败，也不能越过未取得的 lease 执行底层命令。
      }
      return busyPayload({
        serial,
        operationKind,
        position: acquired?.position,
        snapshot: snapshotWithoutRequest(snapshot, requestId),
      });
    }

    const lease = acquired.lease;
    const heartbeatEveryMs = Math.max(
      MIN_HEARTBEAT_INTERVAL_MS,
      Math.floor(ttlMs / 3),
    );
    let heartbeatTimer = null;
    let heartbeatInFlight = null;
    let heartbeatError = null;

    const renew = () => {
      if (heartbeatInFlight || heartbeatError) return;
      heartbeatInFlight = Promise.resolve(heartbeat({
        serial,
        leaseId: lease.leaseId,
        fencingToken: lease.fencingToken,
        ttlMs,
      }))
        .catch((error) => { heartbeatError = error; })
        .finally(() => { heartbeatInFlight = null; });
    };
    heartbeatTimer = setIntervalFn(renew, heartbeatEveryMs);
    heartbeatTimer?.unref?.();

    let value;
    let operationError = null;
    let released = null;
    let releaseError = null;
    try {
      value = await operation(serial, lease);
    } catch (error) {
      operationError = error;
    } finally {
      if (heartbeatTimer) clearIntervalFn(heartbeatTimer);
      if (heartbeatInFlight) await heartbeatInFlight;
      try {
        released = await release({
          serial,
          leaseId: lease.leaseId,
          fencingToken: lease.fencingToken,
          reason: text(input.releaseReason) || `${operationKind}_finished`,
        });
        try { await input.onReleased?.(released); } catch {}
      } catch (error) {
        releaseError = error;
      }
    }

    if (operationError) {
      return {
        ...errorPayload(operationError, "DEVICE_OPERATION_FAILED", "设备操作失败"),
        serial,
        operationKind,
        releaseError: releaseError ? errorPayload(
          releaseError,
          "DEVICE_RUNTIME_RELEASE_FAILED",
          "释放设备运行时租约失败",
        ) : null,
      };
    }
    if (heartbeatError) {
      return {
        ...errorPayload(
          heartbeatError,
          "DEVICE_RUNTIME_HEARTBEAT_FAILED",
          "设备操作期间租约续期失败",
          409,
        ),
        serial,
        operationKind,
      };
    }
    if (releaseError) {
      return {
        ...errorPayload(
          releaseError,
          "DEVICE_RUNTIME_RELEASE_FAILED",
          "释放设备运行时租约失败",
        ),
        serial,
        operationKind,
      };
    }
    return {
      ok: true,
      guarded: true,
      value,
      lease,
      released,
    };
  };
}

export const __test = {
  DEFAULT_TTL_MS,
  busyPayload,
  snapshotWithoutRequest,
};
