import { createHash, randomUUID } from "node:crypto";

import { getUserData, updateUserData } from "../../db/sqlite.js";
import { emitWs } from "../logger.js";
import { createDeviceRuntimeCoordinator } from "./device-runtime.js";
import { storageUserKey } from "./store.js";

const STORAGE_KIND = "deviceRuntime";
const STORAGE_SCHEMA_VERSION = 1;
const DEFAULT_LEASE_TTL_MS = 30_000;

function text(value) {
  return String(value ?? "").trim();
}

function storageId(serial) {
  return createHash("sha256").update(text(serial)).digest("hex");
}

function emptyBucket() {
  return { schemaVersion: STORAGE_SCHEMA_VERSION, devices: {} };
}

function defaultGatewayOwnerId() {
  const configured = text(process.env.DEVBENCH_DEVICE_RUNTIME_OWNER_ID);
  if (configured) return configured;
  // 端口代表可重启的 Gateway 实例：同一端口无法同时监听，却能在进程重启后保持
  // 身份稳定。不能使用 process.pid，否则持久 requestId 在重启后会固定冲突。
  const port = text(process.env.PORT) || "3001";
  return `gateway:${storageUserKey(STORAGE_KIND)}:port:${port}`;
}

function readBucket() {
  const value = getUserData(storageUserKey(STORAGE_KIND), STORAGE_KIND);
  if (!value || typeof value !== "object" || Array.isArray(value)) return emptyBucket();
  return {
    schemaVersion: STORAGE_SCHEMA_VERSION,
    devices: value.devices && typeof value.devices === "object" && !Array.isArray(value.devices)
      ? value.devices
      : {},
  };
}

function readState(serial) {
  const key = storageId(serial);
  const bucket = readBucket();
  return bucket.devices[key] || null;
}

function atomicUpdateState(serial, transition) {
  const key = storageId(serial);
  let transitionEnvelope = null;
  updateUserData(storageUserKey(STORAGE_KIND), STORAGE_KIND, (current) => {
    const bucket = current && typeof current === "object" && !Array.isArray(current)
      ? current
      : emptyBucket();
    const devices = bucket.devices && typeof bucket.devices === "object" && !Array.isArray(bucket.devices)
      ? { ...bucket.devices }
      : {};
    transitionEnvelope = transition(devices[key] || null);
    if (!transitionEnvelope || typeof transitionEnvelope !== "object" || !("state" in transitionEnvelope)) {
      throw new TypeError("device runtime transition 必须返回 { state, result }");
    }
    devices[key] = transitionEnvelope.state;
    return { schemaVersion: STORAGE_SCHEMA_VERSION, devices };
  });
  return transitionEnvelope;
}

export const deviceRuntimeCoordinator = createDeviceRuntimeCoordinator({
  read: readState,
  atomicUpdate: atomicUpdateState,
  defaultTtlMs: DEFAULT_LEASE_TTL_MS,
});

function emitSnapshot(serial, snapshot, reason = "updated") {
  try {
    emitWs("devbench_device_state_changed", {
      serial,
      reason,
      revision: Number(snapshot?.revision) || 0,
      status: snapshot?.status || "idle",
      lease: snapshot?.lease || null,
      queue: Array.isArray(snapshot?.queue) ? snapshot.queue : [],
    });
  } catch {}
}

export async function acquireDeviceUse(input = {}) {
  const result = await deviceRuntimeCoordinator.acquire({
    ...input,
    requestId: text(input.requestId) || randomUUID(),
    ownerId: text(input.ownerId) || defaultGatewayOwnerId(),
  });
  emitSnapshot(input.serial, result.snapshot, result.status);
  return result;
}

export async function heartbeatDeviceUse(input = {}) {
  const result = await deviceRuntimeCoordinator.heartbeat(input);
  emitSnapshot(input.serial, result.snapshot, result.status);
  return result;
}

export async function releaseDeviceUse(input = {}) {
  const result = await deviceRuntimeCoordinator.release(input);
  emitSnapshot(input.serial, result.snapshot, input.reason || result.status);
  return result;
}

export async function cancelDeviceUse(input = {}) {
  const result = await deviceRuntimeCoordinator.cancel(input);
  emitSnapshot(input.serial, result.snapshot, input.reason || result.status);
  return result;
}

export async function getDeviceRuntimeSnapshot(serial, options = {}) {
  const snapshot = await deviceRuntimeCoordinator.snapshot(serial, options);
  if (options.emit === true) emitSnapshot(serial, snapshot, "snapshot");
  return snapshot;
}

async function recoverRuntimeSnapshot(serial) {
  const observed = await deviceRuntimeCoordinator.snapshot(serial, { recoverExpired: false });
  const needsRecovery = observed.lease?.expired === true
    || (!observed.lease && Array.isArray(observed.queue) && observed.queue.length > 0);
  if (!needsRecovery) return { snapshot: observed, recovery: null };
  const recovery = await deviceRuntimeCoordinator.recoverExpired({ serial });
  emitSnapshot(serial, recovery.snapshot, recovery.status);
  return { snapshot: recovery.snapshot, recovery };
}

export function deviceBindings(serial, tabs = []) {
  const expected = text(serial);
  return (Array.isArray(tabs) ? tabs : []).filter((tab) => text(tab?.deviceSerial) === expected).map((tab) => ({
    storyId: tab.id,
    tabId: tab.id,
    title: tab.title || "",
    groupId: tab.groupId || null,
    boundAt: Number(tab.updatedAt || tab.createdAt || 0),
  }));
}

export async function projectDeviceRuntime(serial, tabs = [], options = {}) {
  const recovered = options.recoverExpired === false
    ? { snapshot: await getDeviceRuntimeSnapshot(serial, { ...options, recoverExpired: false }), recovery: null }
    : await recoverRuntimeSnapshot(serial);
  const snapshot = recovered.snapshot;
  return {
    bindings: deviceBindings(serial, tabs),
    runtime: {
      status: snapshot.status,
      revision: snapshot.revision,
      lease: snapshot.lease || null,
      queue: Array.isArray(snapshot.queue) ? snapshot.queue : [],
    },
    recovery: recovered.recovery ? {
      status: recovered.recovery.status,
      expiredLease: recovered.recovery.expiredLease || null,
      nextLease: recovered.recovery.nextLease || null,
    } : null,
  };
}

export const __test = {
  storageId,
  defaultGatewayOwnerId,
  DEFAULT_LEASE_TTL_MS,
};
