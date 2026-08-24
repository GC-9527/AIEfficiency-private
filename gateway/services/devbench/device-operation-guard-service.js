import {
  acquireDeviceUse,
  cancelDeviceUse,
  getDeviceRuntimeSnapshot,
  heartbeatDeviceUse,
  releaseDeviceUse,
} from "./device-runtime-service.js";
import { createImmediateDeviceOperationGuard } from "./device-operation-guard.js";
import * as store from "./store.js";
import { canonicalSha256 } from "./workflow-v2/envelope-store.js";
import { assertDeviceLeaseBinding } from "./workflow-v2/build-diff-gate.js";

export const runImmediateDeviceOperation = createImmediateDeviceOperationGuard({
  acquire: acquireDeviceUse,
  cancel: cancelDeviceUse,
  heartbeat: heartbeatDeviceUse,
  release: releaseDeviceUse,
});

const DEVICE_PROXY_INPUT_KEYS = new Set(["businessAction"]);
const DEVICE_ACTION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const DEVICE_ADAPTER_ATTESTATION = "workflow-v2-story-device-adapter-v1";
const DEVICE_RECEIPT_ACTIONS = new Set(["DEVICE_ACTION", "INSTALL", "CAPTURE"]);

function cleanText(value, max = 1000) {
  return Array.from(String(value ?? "").trim()).slice(0, max).join("");
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

function validPositiveInteger(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

function deviceTimestamp(now) {
  const value = now();
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new TypeError("now() must return a valid date");
  return date.toISOString();
}

function proxyReceipt({
  storyId,
  businessAction,
  receiptAction = "DEVICE_ACTION",
  status,
  startedAt,
  finishedAt,
  serial,
  leaseId,
  fencingToken,
  summary,
  error = null,
}) {
  const selector = {
    storyId,
    businessAction,
    serialSha256: canonicalSha256(serial || ""),
    leaseId: leaseId || null,
    fencingToken: validPositiveInteger(fencingToken),
  };
  const operationId = `device-${canonicalSha256(selector).slice(0, 32)}`;
  return {
    schemaVersion: "evidence-receipt-v2",
    receiptId: `gateway-device-${canonicalSha256({ operationId, status }).slice(0, 32)}`,
    action: DEVICE_RECEIPT_ACTIONS.has(receiptAction) ? receiptAction : "DEVICE_ACTION",
    status,
    startedAt,
    finishedAt,
    toolName: "device_proxy",
    operationId,
    idempotencyKey: operationId,
    rootId: null,
    selector,
    exitCode: null,
    outputRef: null,
    sha256: null,
    summary: cleanText(summary, 2000),
    error: error == null ? null : cleanText(error, 2000),
  };
}

function blockedDeviceResult(context, businessAction, startedAt, now, code, message) {
  const finishedAt = deviceTimestamp(now);
  return {
    ok: false,
    status: "BLOCKED",
    statusCode: 409,
    code,
    error: message,
    receipt: proxyReceipt({
      storyId: context.storyId,
      businessAction,
      status: "BLOCKED",
      startedAt,
      finishedAt,
      serial: context.serial,
      leaseId: context.leaseId,
      fencingToken: context.fencingToken,
      summary: message,
      error: `${code}: ${message}`,
    }),
  };
}

/**
 * Freeze the only device identity that a workflow-v2 stage may use.  This is
 * Gateway-owned dispatch data; it is never constructed from model arguments.
 */
export function freezeStoryDeviceLeaseContext({ story, lease } = {}) {
  const storyId = cleanText(story?.id, 160);
  const serial = cleanText(story?.deviceSerial, 300);
  const leaseSerial = cleanText(lease?.serial, 300);
  const leaseId = cleanText(lease?.leaseId, 300);
  const leaseStoryId = cleanText(lease?.storyId, 160);
  const fencingToken = validPositiveInteger(lease?.fencingToken);
  if (!storyId || !serial || !leaseId || !fencingToken
    || serial !== leaseSerial || (leaseStoryId && leaseStoryId !== storyId)) {
    throw Object.assign(new Error("无法冻结故事点设备 lease 身份"), {
      code: "WORKFLOW_V2_DEVICE_FROZEN_LEASE_INVALID",
    });
  }
  return deepFreeze({ storyId, serial, leaseId, fencingToken });
}

/**
 * Create a Device Proxy bound to one frozen story lease.  Its public execute
 * surface accepts only `{ businessAction }`; serial/leaseId/fencingToken are
 * injected from the frozen context.  Before every handler call it re-reads the
 * live story binding, re-reads and atomically heartbeats the active lease, then
 * applies the shared binding assertion.  The proxy never acquires or broadens
 * a lease and therefore can only reuse the same story's still-valid lease.
 */
export function createStoryLeaseDeviceProxy({
  frozenContext,
  actions = {},
  readStory = store.getTab,
  readRuntimeSnapshot = getDeviceRuntimeSnapshot,
  heartbeat = heartbeatDeviceUse,
  nowMs = () => Date.now(),
  now = () => new Date(),
} = {}) {
  const context = deepFreeze({
    storyId: cleanText(frozenContext?.storyId, 160),
    serial: cleanText(frozenContext?.serial, 300),
    leaseId: cleanText(frozenContext?.leaseId, 300),
    fencingToken: validPositiveInteger(frozenContext?.fencingToken),
  });

  return Object.freeze({
    async execute(input = {}) {
      const startedAt = deviceTimestamp(now);
      const businessAction = cleanText(input?.businessAction, 128);
      const invalidShape = !input || typeof input !== "object" || Array.isArray(input)
        || Object.keys(input).some((key) => !DEVICE_PROXY_INPUT_KEYS.has(key));
      if (invalidShape || !DEVICE_ACTION_ID.test(businessAction)) {
        return blockedDeviceResult(
          context,
          businessAction,
          startedAt,
          now,
          "WORKFLOW_V2_DEVICE_PROXY_INPUT_INVALID",
          "Device Proxy 只接受已登记的 businessAction，不接受 serial、lease 或自由命令参数",
        );
      }
      if (!context.storyId || !context.serial || !context.leaseId || !context.fencingToken) {
        return blockedDeviceResult(
          context,
          businessAction,
          startedAt,
          now,
          "WORKFLOW_V2_DEVICE_FROZEN_LEASE_INVALID",
          "缺少冻结的故事点设备 lease",
        );
      }
      const adapter = actions?.[businessAction];
      if (!adapter || typeof adapter.attest !== "function" || typeof adapter.execute !== "function") {
        return blockedDeviceResult(
          context,
          businessAction,
          startedAt,
          now,
          "WORKFLOW_V2_DEVICE_ADAPTER_UNAVAILABLE",
          "未配置受证明的设备业务动作适配器",
        );
      }
      try {
        const attestation = await adapter.attest({
          storyId: context.storyId,
          businessAction,
        });
        if (attestation?.ok !== true
          || attestation?.kind !== DEVICE_ADAPTER_ATTESTATION
          || attestation?.businessAction !== businessAction) {
          throw Object.assign(new Error("设备业务动作适配器证明无效"), {
            code: "WORKFLOW_V2_DEVICE_ADAPTER_ATTESTATION_INVALID",
          });
        }
        const liveStory = await readStory(context.storyId);
        const liveSerial = cleanText(liveStory?.deviceSerial, 300);
        if (!liveStory || liveSerial !== context.serial) {
          throw Object.assign(new Error("故事点设备 binding 已漂移"), {
            code: "WORKFLOW_V2_DEVICE_BINDING_DRIFT",
          });
        }
        const snapshot = await readRuntimeSnapshot(context.serial, { recoverExpired: false });
        const active = snapshot?.lease || null;
        if (!active || snapshot?.status !== "acquired" || active.expired === true) {
          throw Object.assign(new Error("故事点设备 lease 不存在或已过期"), {
            code: "WORKFLOW_V2_DEVICE_LEASE_REQUIRED",
          });
        }
        assertDeviceLeaseBinding({
          boundSerial: liveSerial,
          leasedSerial: cleanText(snapshot?.serial, 300),
          frozenStoryId: context.storyId,
          leasedStoryId: active.storyId,
          expectedLeaseId: context.leaseId,
          leaseId: active.leaseId,
          expectedFencingToken: context.fencingToken,
          fencingToken: active.fencingToken,
          expiresAt: active.expiresAt,
          now: nowMs(),
        });
        const renewed = await heartbeat({
          serial: context.serial,
          leaseId: context.leaseId,
          fencingToken: context.fencingToken,
          ttlMs: active.leaseTtlMs,
        });
        const renewedLease = renewed?.lease;
        const latestStory = await readStory(context.storyId);
        const latestSerial = cleanText(latestStory?.deviceSerial, 300);
        assertDeviceLeaseBinding({
          boundSerial: latestSerial,
          leasedSerial: context.serial,
          frozenStoryId: context.storyId,
          leasedStoryId: renewedLease?.storyId,
          expectedLeaseId: context.leaseId,
          leaseId: renewedLease?.leaseId,
          expectedFencingToken: context.fencingToken,
          fencingToken: renewedLease?.fencingToken,
          expiresAt: renewedLease?.expiresAt,
          now: nowMs(),
        });
        if (!latestStory || latestSerial !== context.serial) {
          throw Object.assign(new Error("设备动作执行前故事 binding 已漂移"), {
            code: "WORKFLOW_V2_DEVICE_BINDING_DRIFT",
          });
        }
        const value = await adapter.execute(Object.freeze({
          businessAction,
          storyId: context.storyId,
          serial: context.serial,
          leaseId: context.leaseId,
          fencingToken: context.fencingToken,
        }));
        if (!value || typeof value !== "object" || Array.isArray(value) || value.ok !== true) {
          throw Object.assign(new Error("Device adapter did not return an explicit successful acknowledgement"), {
            code: "WORKFLOW_V2_DEVICE_ADAPTER_RESULT_INVALID",
          });
        }
        if (value.businessAction !== businessAction) {
          throw Object.assign(new Error("Device adapter acknowledgement is not bound to the executed businessAction"), {
            code: "WORKFLOW_V2_DEVICE_ADAPTER_RESULT_BINDING_MISMATCH",
          });
        }
        const completionStory = await readStory(context.storyId);
        const completionSerial = cleanText(completionStory?.deviceSerial, 300);
        if (!completionStory || completionSerial !== context.serial) {
          throw Object.assign(new Error("Story device binding drifted while the device action was executing"), {
            code: "WORKFLOW_V2_DEVICE_BINDING_DRIFT",
          });
        }
        const completionSnapshot = await readRuntimeSnapshot(context.serial, { recoverExpired: false });
        const completionLease = completionSnapshot?.lease || null;
        if (!completionLease || completionSnapshot?.status !== "acquired") {
          throw Object.assign(new Error("Device lease completion state could not be confirmed"), {
            code: "WORKFLOW_V2_DEVICE_COMPLETION_LEASE_UNCONFIRMED",
          });
        }
        if (completionLease.expired === true) {
          throw Object.assign(new Error("Device lease expired while the device action was executing"), {
            code: "WORKFLOW_V2_DEVICE_LEASE_EXPIRED",
          });
        }
        assertDeviceLeaseBinding({
          boundSerial: completionSerial,
          leasedSerial: cleanText(completionSnapshot?.serial, 300),
          frozenStoryId: context.storyId,
          leasedStoryId: completionLease.storyId,
          expectedLeaseId: context.leaseId,
          leaseId: completionLease.leaseId,
          expectedFencingToken: context.fencingToken,
          fencingToken: completionLease.fencingToken,
          expiresAt: completionLease.expiresAt,
          now: nowMs(),
        });
        const completionHeartbeat = await heartbeat({
          serial: context.serial,
          leaseId: context.leaseId,
          fencingToken: context.fencingToken,
          ttlMs: completionLease.leaseTtlMs,
        });
        if (completionHeartbeat?.ok !== true
          || completionHeartbeat?.status !== "renewed"
          || !completionHeartbeat?.lease
          || completionHeartbeat.lease.expired === true) {
          throw Object.assign(new Error("Device lease completion heartbeat was not confirmed"), {
            code: "WORKFLOW_V2_DEVICE_COMPLETION_HEARTBEAT_UNCONFIRMED",
          });
        }
        const completedLease = completionHeartbeat.lease;
        const finalStory = await readStory(context.storyId);
        const finalSerial = cleanText(finalStory?.deviceSerial, 300);
        assertDeviceLeaseBinding({
          boundSerial: finalSerial,
          leasedSerial: context.serial,
          frozenStoryId: context.storyId,
          leasedStoryId: completedLease.storyId,
          expectedLeaseId: context.leaseId,
          leaseId: completedLease.leaseId,
          expectedFencingToken: context.fencingToken,
          fencingToken: completedLease.fencingToken,
          expiresAt: completedLease.expiresAt,
          now: nowMs(),
        });
        if (!finalStory || finalSerial !== context.serial) {
          throw Object.assign(new Error("Story device binding drifted before completion receipt signing"), {
            code: "WORKFLOW_V2_DEVICE_BINDING_DRIFT",
          });
        }
        const finishedAt = deviceTimestamp(now);
        const receiptAction = DEVICE_RECEIPT_ACTIONS.has(adapter.receiptAction)
          ? adapter.receiptAction
          : "DEVICE_ACTION";
        const receipt = proxyReceipt({
          storyId: context.storyId,
          businessAction,
          receiptAction,
          status: "PASS",
          startedAt,
          finishedAt,
          serial: context.serial,
          leaseId: context.leaseId,
          fencingToken: context.fencingToken,
          summary: "设备业务动作执行通过",
        });
        return { ok: true, status: "PASS", value, receipt };
      } catch (error) {
        const code = cleanText(error?.code, 160) || "WORKFLOW_V2_DEVICE_ACTION_BLOCKED";
        const message = cleanText(error?.message || error, 1800) || "设备动作被安全阻断";
        return blockedDeviceResult(context, businessAction, startedAt, now, code, message);
      }
    },
  });
}

export const WORKFLOW_V2_DEVICE_ADAPTER_ATTESTATION = DEVICE_ADAPTER_ATTESTATION;
