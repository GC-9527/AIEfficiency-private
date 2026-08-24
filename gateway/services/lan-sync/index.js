import {
  createHash,
  createHmac,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import { isIP } from "node:net";
import os from "node:os";
import { WebSocket } from "ws";
import { addAudit } from "../../db/sqlite.js";
import { getConfig, updateConfig } from "../config.js";
import * as vehicleStore from "../devbench/store.js";
import { emitWs, log } from "../logger.js";
import {
  canonicalJson,
  fingerprintPublicKey,
  getLanSyncIdentity,
  lanSyncNodeId,
  signLanSyncValue,
  verifyLanSyncValue,
} from "./identity.js";
import {
  createLanSyncKeyAgreement,
  decryptLanSyncMessage,
  deriveLanSyncChannel,
  encryptLanSyncMessage,
  lanSyncChannelVersion,
} from "./channel-crypto.js";
import * as syncStore from "./store.js";
import { lanSyncDiagnostic, lanSyncDiagnosticSettings } from "./diagnostic-log.js";
import { lanSyncClientTlsOptions, lanSyncTlsConfig } from "./tls.js";

const PROTOCOL_VERSION = 2;
const SCHEMA_VERSION = 1;
// 业务因果只依赖 origin_seq/version vector；时间戳仅用于缩小重放窗口。
// 允许车间设备时钟相差 ±24h，不能让墙钟漂移造成配置丢失。
const MAX_CLOCK_SKEW_MS = 25 * 60 * 60_000;
const DEFAULT_MAX_PAYLOAD_BYTES = 256 * 1024;
const DEFAULT_MAX_OPS = 100;
const DEFAULT_TEAM_CONFIG_SPACE = "team/vehicle-source";
const INVITATION_TTL_MS = 10 * 60_000;
const MAX_ACTIVE_INVITATIONS = 8;
const connections = new Map();
const connecting = new Set();
const reconnectAttempts = new Map();
const reconnectTimers = new Map();
const publishRateWindows = new Map();
const pairingInvitations = new Map();
let retryTimer = null;
let heartbeatTimer = null;
let compactionTimer = null;
let initialized = false;
let stopping = false;

function currentNodeId() {
  // LAN 同步身份必须独立于可复制的 gateway/config.json。以本机私钥对应的
  // 公钥指纹派生节点 ID，避免克隆 profile 后 servers.nodeId 撞车。
  return lanSyncNodeId();
}

function currentNodeName() {
  const cfg = getConfig();
  return String(cfg.servers?.nodeName || cfg.servers?.nodeOwnerName || os.hostname() || currentNodeId()).trim();
}

export function requestedLanSyncMode(config = getConfig()) {
  const mode = String(
    process.env.DEVBENCH_LAN_SYNC_MODE
      || config.lanSync?.syncMode
      || "disabled",
  ).trim().toLowerCase();
  return ["peer", "receive-only", "disabled"].includes(mode) ? mode : "disabled";
}

export function configuredLanSyncGroupId(config = getConfig()) {
  return String(config.lanSync?.groupId || "").trim().slice(0, 128);
}

function automaticLanSyncGroupId(configSpace = configuredTeamConfigSpace()) {
  const hex = createHash("sha256")
    .update(`devbench-lan-sync:${String(configSpace || DEFAULT_TEAM_CONFIG_SPACE)}`, "utf8")
    .digest("hex");
  return `lan-group-${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

export function lanSyncTransportPolicy(config = getConfig()) {
  const requestedMode = requestedLanSyncMode(config);
  const mtlsEnabled = config.lanSync?.mtls?.enabled === true;
  const mtlsRequired = mtlsEnabled && config.lanSync?.mtls?.required !== false;
  const insecureTransportAllowed = config.lanSync?.allowInsecureTransport === true;
  return {
    requestedMode,
    effectiveMode: requestedMode,
    mtlsEnabled,
    mtlsRequired,
    insecureTransportAllowed,
    applicationEncryption: requestedMode !== "disabled",
    blockedByTransport: false,
  };
}

export function configuredLanSyncMode(config = getConfig()) {
  return lanSyncTransportPolicy(config).effectiveMode;
}

export function configuredTeamConfigSpace(config = getConfig()) {
  const explicit = String(
    process.env.DEVBENCH_TEAM_CONFIG_SPACE
      || config.lanSync?.teamConfigSpace
      || "",
  ).trim().slice(0, 240);
  if (explicit) return explicit;
  return DEFAULT_TEAM_CONFIG_SPACE;
}

function limits() {
  const config = getConfig().lanSync || {};
  return {
    maxPayloadBytes: Math.max(16 * 1024, Math.min(2 * 1024 * 1024, Number(config.maxPayloadBytes) || DEFAULT_MAX_PAYLOAD_BYTES)),
    maxOps: Math.max(1, Math.min(500, Number(config.maxOpsPerChangeSet) || DEFAULT_MAX_OPS)),
  };
}

function encodeEntityKey(projectId, flavor) {
  return `${encodeURIComponent(projectId)}/${encodeURIComponent(flavor)}`;
}

function encodeProjectDefKey(id) {
  return encodeURIComponent(String(id || "").trim());
}

function decodeProjectDefKey(entityKey) {
  return decodeURIComponent(String(entityKey || ""));
}

function decodeEntityKey(entityKey) {
  const slash = String(entityKey || "").indexOf("/");
  if (slash <= 0) throw new Error("车型实体 key 不合法");
  return {
    projectId: decodeURIComponent(entityKey.slice(0, slash)),
    flavor: decodeURIComponent(entityKey.slice(slash + 1)),
  };
}

function sameValue(left, right) {
  return canonicalJson(left ?? null) === canonicalJson(right ?? null);
}

function principalId(principal = {}) {
  return String(
    principal.dingUserid
      || principal.userId
      || principal.id
      || principal.uid
      || principal.sub
      || (principal.role === "super" ? "local-super" : ""),
  ).trim();
}

function enforcePublishRate(principal) {
  const actor = principalId(principal) || "anonymous";
  const now = Date.now();
  const recent = (publishRateWindows.get(actor) || []).filter((timestamp) => now - timestamp < 60_000);
  if (recent.length >= 60) {
    const error = new Error("车型配置发布过于频繁，请稍后重试");
    error.statusCode = 429;
    error.code = "LAN_SYNC_PUBLISH_RATE_LIMITED";
    throw error;
  }
  recent.push(now);
  publishRateWindows.set(actor, recent);
}

function assertConfigSpace(configSpace) {
  const expected = configuredTeamConfigSpace();
  const value = String(configSpace || "").trim();
  if (!value || value !== expected) {
    const error = new Error(`配置空间不匹配（本机 ${expected}，请求 ${value || "空"}）`);
    error.statusCode = 409;
    error.code = "LAN_SYNC_CONFIG_SPACE_MISMATCH";
    throw error;
  }
  return value;
}

function normalizeChanges(projectId, changes = [], { allowEmpty = false } = {}) {
  const normalizedProjectId = vehicleStore.normalizeVehicleProjectId(projectId, { required: true });
  const rows = [];
  const seen = new Set();
  for (const input of Array.isArray(changes) ? changes : []) {
    const flavor = String(input?.flavor || "").trim();
    if (!flavor) {
      const error = new Error("发布变更缺少车型");
      error.statusCode = 400;
      error.code = "VEHICLE_FLAVOR_REQUIRED";
      throw error;
    }
    if (seen.has(flavor)) {
      const error = new Error(`同一发布中车型「${flavor}」重复`);
      error.statusCode = 400;
      error.code = "VEHICLE_CHANGE_DUPLICATED";
      throw error;
    }
    seen.add(flavor);
    const action = String(input?.action || (input?.mapping == null ? "delete" : "set")).toLowerCase();
    if (!["set", "delete", "resolve"].includes(action)) {
      const error = new Error(`不支持的车型操作：${action}`);
      error.statusCode = 400;
      error.code = "VEHICLE_ACTION_INVALID";
      throw error;
    }
    rows.push({
      projectId: normalizedProjectId,
      flavor,
      action,
      mapping: action === "delete"
        ? null
        : vehicleStore.normalizeTeamVehicleMapping(flavor, input?.mapping || {}),
      baseRevision: String(input?.baseRevision || ""),
      resolves: Array.isArray(input?.resolves) ? input.resolves.map(String) : [],
    });
  }
  const { maxOps, maxPayloadBytes } = limits();
  if ((!allowEmpty && !rows.length) || rows.length > maxOps) {
    const error = new Error(`一次发布操作数必须为 1～${maxOps}`);
    error.statusCode = 413;
    error.code = "LAN_SYNC_OPERATION_LIMIT";
    throw error;
  }
  const businessPayloadLimit = Math.floor(maxPayloadBytes / 2);
  if (Buffer.byteLength(JSON.stringify(rows), "utf8") > businessPayloadLimit) {
    const error = new Error(`发布 payload 超过 ${businessPayloadLimit} bytes`);
    error.statusCode = 413;
    error.code = "LAN_SYNC_PAYLOAD_TOO_LARGE";
    throw error;
  }
  return rows;
}

function normalizeProjectDefChanges(projectDefs = []) {
  const rows = [];
  const seen = new Set();
  for (const input of Array.isArray(projectDefs) ? projectDefs : []) {
    const action = String(input?.action || "set").toLowerCase();
    const definition = action === "delete"
      ? null
      : vehicleStore.normalizeTeamProjectDef(input?.definition || input);
    const id = String(input?.id || definition?.id || "").trim();
    if (!id || seen.has(id) || !["set", "delete"].includes(action)) {
      throw Object.assign(new Error(`仓库定义变更不合法或重复：${id || "空"}`), {
        statusCode: 400,
        code: "PROJECT_DEF_CHANGE_INVALID",
      });
    }
    seen.add(id);
    rows.push({
      id,
      action,
      definition,
      baseRevision: String(input?.baseRevision || ""),
      resolves: Array.isArray(input?.resolves) ? input.resolves.map(String) : [],
    });
  }
  return rows;
}

export function lanSyncContext(projectId) {
  const normalizedProjectId = vehicleStore.normalizeVehicleProjectId(projectId, { required: true });
  const configSpace = configuredTeamConfigSpace();
  const config = vehicleStore.getRemoteConfig(normalizedProjectId);
  const revisions = {};
  for (const flavor of Object.keys(config.vehicleMap || {})) {
    revisions[flavor] = syncStore.getEntityRevision(
      configSpace,
      "vehicle",
      encodeEntityKey(normalizedProjectId, flavor),
    );
  }
  const policy = lanSyncTransportPolicy();
  const mode = policy.effectiveMode;
  return {
    runtimeProfile: String(process.env.AIEFFICIENCY_PROFILE || "production"),
    runtimeScope: vehicleStore.devbenchSyncScope(),
    teamConfigSpace: configSpace,
    syncMode: mode,
    requestedSyncMode: policy.requestedMode,
    transportBlocked: policy.blockedByTransport,
    sourceMode: "local",
    sourceHost: "",
    nodeId: currentNodeId(),
    nodeName: currentNodeName(),
    revision: String(config.revision || 0),
    entityRevisions: revisions,
    connectedPeers: [...connections.values()].filter((state) => state.authenticated).length,
    members: syncStore.listMembers(configSpace).map((member) => ({
      nodeId: member.nodeId,
      nodeName: member.nodeName,
      state: member.state,
      host: member.host,
      online: connections.get(member.nodeId)?.authenticated === true,
      lastSeenAt: member.lastSeenAt,
    })),
    conflicts: syncStore.listConflicts(configSpace).length,
  };
}

export function previewVehiclePublication(input = {}) {
  const configSpace = assertConfigSpace(input.configSpace || configuredTeamConfigSpace());
  const projectId = vehicleStore.normalizeVehicleProjectId(input.projectId, { required: true });
  const projectDefInputs = normalizeProjectDefChanges(input.projectDefs);
  const changes = normalizeChanges(projectId, input.changes, {
    allowEmpty: projectDefInputs.length > 0,
  });
  const config = vehicleStore.getRemoteConfig(projectId);
  const diffs = [];
  const conflicts = [];
  for (const change of changes) {
    const entityKey = encodeEntityKey(projectId, change.flavor);
    const currentRevision = syncStore.getEntityRevision(configSpace, "vehicle", entityKey);
    const requestedBase = change.baseRevision || currentRevision;
    const before = Object.hasOwn(config.vehicleMap || {}, change.flavor)
      ? vehicleStore.normalizeTeamVehicleMapping(change.flavor, config.vehicleMap[change.flavor])
      : null;
    const after = change.action === "delete" ? null : change.mapping;
    if (requestedBase !== currentRevision) {
      conflicts.push({
        flavor: change.flavor,
        entityKey,
        requestedBase,
        currentRevision,
      });
    }
    if (change.resolves.length || !sameValue(before, after)) {
      diffs.push({
        ...change,
        entityKey,
        before,
        after,
        baseRevision: requestedBase,
        currentRevision,
      });
    }
  }
  const projectDefChanges = [];
  for (const change of projectDefInputs) {
    const entityKey = encodeProjectDefKey(change.id);
    const currentRevision = syncStore.getEntityRevision(configSpace, "project-definition", entityKey);
    const requestedBase = change.baseRevision || currentRevision;
    const beforeRaw = vehicleStore.getProjectDef(change.id);
    const before = beforeRaw ? vehicleStore.normalizeTeamProjectDef(beforeRaw) : null;
    const after = change.action === "delete" ? null : change.definition;
    if (requestedBase !== currentRevision) {
      conflicts.push({
        projectDefId: change.id,
        entityKey,
        requestedBase,
        currentRevision,
      });
    }
    if (change.resolves.length || !sameValue(before, after)) {
      projectDefChanges.push({
        ...change,
        entityKey,
        before,
        after,
        baseRevision: requestedBase,
        currentRevision,
      });
    }
  }
  const availableProjectDefs = new Set(vehicleStore.getProjectDefs().map((definition) => definition.id));
  for (const change of projectDefChanges) {
    if (change.after) availableProjectDefs.add(change.id);
    else availableProjectDefs.delete(change.id);
  }
  const futureVehicleMap = { ...(config.vehicleMap || {}) };
  for (const change of diffs) {
    if (change.after) futureVehicleMap[change.flavor] = change.after;
    else delete futureVehicleMap[change.flavor];
  }
  const missingDependencies = new Set();
  for (const mapping of Object.values(futureVehicleMap)) {
    for (const app of mapping?.apps || []) {
      for (const repo of app?.repos || []) {
        const repoId = String(repo?.repoId || "").trim();
        if (repoId && !availableProjectDefs.has(repoId)) missingDependencies.add(repoId);
      }
    }
  }
  if (missingDependencies.size) {
    throw Object.assign(new Error(`发布缺少仓库定义：${[...missingDependencies].join("、")}`), {
      statusCode: 409,
      code: "PROJECT_DEF_DEPENDENCY_MISSING",
    });
  }
  const { maxOps, maxPayloadBytes } = limits();
  if (changes.length + projectDefInputs.length > maxOps
    || Buffer.byteLength(JSON.stringify({ changes, projectDefs: projectDefInputs }), "utf8") > Math.floor(maxPayloadBytes / 2)) {
    throw Object.assign(new Error("车型与仓库定义合计超过单次发布上限"), {
      statusCode: 413,
      code: "LAN_SYNC_OPERATION_LIMIT",
    });
  }
  const members = syncStore.listMembers(configSpace);
  return {
    ok: conflicts.length === 0,
    configSpace,
    projectId,
    baseRevision: String(input.baseRevision || config.revision || "0"),
    diff: {
      added: diffs.filter((row) => row.before == null && row.after != null),
      modified: diffs.filter((row) => row.before != null && row.after != null),
      deleted: diffs.filter((row) => row.before != null && row.after == null),
      noOp: changes.length - diffs.length,
    },
    changes: diffs,
    projectDefChanges,
    conflicts,
    publicationRequest: {
      configSpace,
      projectId,
      baseRevision: String(input.baseRevision || config.revision || "0"),
      changes: diffs.map(({ flavor, action, mapping, baseRevision, resolves }) => ({
        flavor, action, mapping, baseRevision, resolves,
      })),
      projectDefs: projectDefChanges.map(({ id, action, definition, baseRevision, resolves }) => ({
        id, action, definition, baseRevision, resolves,
      })),
    },
    members: members.map((member) => ({
      nodeId: member.nodeId,
      nodeName: member.nodeName,
      state: member.state,
      online: connections.get(member.nodeId)?.authenticated === true,
      authorized: member.configSpaces.includes(configSpace),
    })),
    existingConflicts: syncStore.listConflicts(configSpace),
  };
}

function auditPublication({ principal, changeSetId, configSpace, projectId, ops, requestIp = "", publicationScope = "team" }) {
  const actor = principalId(principal);
  addAudit({
    id: `${currentNodeId()}-${Date.now()}-${randomBytes(4).toString("hex")}`,
    ts: Date.now(),
    ip: requestIp,
    actor,
    role: principal?.role || "",
    action: publicationScope === "local"
      ? "车型配置.发布到当前服务"
      : "车型配置.发布到团队",
    target: `change-set:${changeSetId}`,
    before: null,
    after: {
      configSpace,
      projectId,
      changeSetId,
      opIds: ops.map((op) => op.opId),
      hash: createHash("sha256").update(canonicalJson(ops.map(syncStore.operationSigningValue))).digest("hex"),
    },
    node: currentNodeId(),
  });
}

function auditLanSyncRejection(reason, target = "", peerNodeId = "") {
  lanSyncDiagnostic("warn", "message_rejected", {
    peerNodeId: String(peerNodeId || ""),
    target: String(target || ""),
    reason: String(reason || "unknown"),
  });
  try {
    addAudit({
      id: `${currentNodeId()}-${Date.now()}-${randomBytes(4).toString("hex")}`,
      ts: Date.now(),
      ip: "",
      actor: String(peerNodeId || "untrusted-peer"),
      role: "device",
      action: "车型配置.LAN同步拒绝",
      target: String(target || "lan-sync-message"),
      before: null,
      after: { reason: String(reason || "unknown").slice(0, 500) },
      node: currentNodeId(),
    });
  } catch {}
}

function hasConflictResolutionIntent(input = {}) {
  if (Array.isArray(input.resolveConflictIds) && input.resolveConflictIds.length) return true;
  const changes = [
    ...(Array.isArray(input.changes) ? input.changes : []),
    ...(Array.isArray(input.projectDefs) ? input.projectDefs : []),
  ];
  return changes.some((change) => (
    String(change?.action || "").trim().toLowerCase() === "resolve"
    || (Array.isArray(change?.resolves) && change.resolves.length > 0)
  ));
}

export function publishVehicleChanges(input = {}, principal = {}, requestMeta = {}) {
  if (hasConflictResolutionIntent(input) && requestMeta.allowConflictResolution !== true) {
    const error = new Error("冲突解决必须使用受保护的冲突裁决接口");
    error.statusCode = 403;
    error.code = "LAN_SYNC_RESOLVE_PERMISSION_REQUIRED";
    throw error;
  }
  const policy = lanSyncTransportPolicy();
  const mode = policy.effectiveMode;
  if (policy.blockedByTransport) {
    const error = new Error(
      "LAN sync peer/receive-only mode requires mTLS; configure certificates or explicitly enable insecure compatibility",
    );
    error.statusCode = 409;
    error.code = "LAN_SYNC_MTLS_REQUIRED";
    throw error;
  }
  // 不要求管理员额外配置同步：disabled 节点第一次真正发布车型变更时自动建组。
  // 仅预览、打开页面或 no-op 不建组，也不会播种本机旧快照。
  if (mode !== "peer" && mode !== "disabled") {
    const error = new Error("本机是 receive-only 节点，不能发布车型配置");
    error.statusCode = 409;
    error.code = "LAN_SYNC_PUBLISH_DISABLED";
    throw error;
  }
  // 兼容已部署过旧版自动 peer、但尚无 groupId 的 Gateway：仅在下一次管理员
  // 真实发布时补建组，启动本身仍不改变或传播任何配置。
  const startsAutomaticGroup = mode === "disabled" || !configuredLanSyncGroupId();
  const publicationScope = "team";
  const configSpace = assertConfigSpace(input.configSpace || configuredTeamConfigSpace());
  let automaticSeededOperations = 0;
  let automaticSeedChangeSetIds = [];
  const idempotencyKey = String(input.idempotencyKey || "").trim();
  if (!idempotencyKey || idempotencyKey.length > 200) {
    const error = new Error("发布必须提供 1～200 字符的 idempotencyKey");
    error.statusCode = 400;
    error.code = "LAN_SYNC_IDEMPOTENCY_REQUIRED";
    throw error;
  }
  const existing = syncStore.findIdempotentChangeSet(configSpace, idempotencyKey);
  if (existing) {
    if (existing.startsWith("noop:")) {
      return { ok: true, noOp: true, idempotent: true, configSpace };
    }
    if (startsAutomaticGroup) {
      const seeded = publishExistingVehicleConfiguration(principal, { fanout: false });
      automaticSeededOperations = seeded.created;
      automaticSeedChangeSetIds = seeded.changeSetIds;
      const requiresRestart = configurePeerSync(configSpace, "", { createGroup: true });
      if (requiresRestart) restartLanSyncRuntime();
      fanoutChangeSet(existing, { retry: true });
      for (const seededChangeSetId of automaticSeedChangeSetIds) {
        fanoutChangeSet(seededChangeSetId, { retry: true });
      }
    }
    return {
      ...syncStore.publicationStatus(existing),
      idempotent: true,
      automaticSeededOperations,
    };
  }
  enforcePublishRate(principal);
  const preview = previewVehiclePublication({ ...input, configSpace });
  if (preview.conflicts.length) {
    const error = new Error("发布基线已过期，请刷新并处理冲突后重试");
    error.statusCode = 409;
    error.code = "LAN_SYNC_BASE_REVISION_CONFLICT";
    error.data = preview;
    throw error;
  }
  if (!preview.changes.length && !preview.projectDefChanges.length) {
    const revision = vehicleStore.getRemoteConfig(preview.projectId).revision;
    syncStore.runLanSyncTransaction(() => {
      if (!syncStore.findIdempotentChangeSet(configSpace, idempotencyKey)) {
        syncStore.recordIdempotency(
          configSpace,
          idempotencyKey,
          `noop:${preview.projectId}:${revision}`,
        );
      }
    });
    return {
      ok: true,
      noOp: true,
      configSpace,
      projectId: preview.projectId,
      revision,
    };
  }

  const changeSetId = randomUUID();
  const actorUserId = principalId(principal);
  const originNodeId = currentNodeId();
  const result = syncStore.runLanSyncTransaction(() => {
    const repeated = syncStore.findIdempotentChangeSet(configSpace, idempotencyKey);
    if (repeated) return { repeated, ops: syncStore.listChangeSetOps(repeated), members: [] };
    const ops = [];
    const materializations = [];
    for (const change of preview.projectDefChanges) {
      const currentRevision = syncStore.getEntityRevision(
        configSpace,
        "project-definition",
        change.entityKey,
      );
      if (currentRevision !== change.baseRevision) {
        throw Object.assign(new Error(`仓库定义「${change.id}」发布基线已变化`), {
          statusCode: 409,
          code: "LAN_SYNC_BASE_REVISION_CONFLICT",
        });
      }
      const op = syncStore.createLocalOperation({
        configSpace,
        changeSetId,
        originNodeId,
        entityType: "project-definition",
        entityKey: change.entityKey,
        action: change.action,
        baseRevision: change.baseRevision,
        context: syncStore.currentVersionVector(configSpace),
        actorUserId,
        payload: {
          projectId: preview.projectId,
          id: change.id,
          definition: change.after,
          ...(change.resolves.length ? { resolves: change.resolves } : {}),
        },
      });
      ops.push(op);
      materializations.push({ type: "project-definition", change, op });
    }
    for (const change of preview.changes) {
      const currentRevision = syncStore.getEntityRevision(configSpace, "vehicle", change.entityKey);
      if (currentRevision !== change.baseRevision) {
        const error = new Error(`车型「${change.flavor}」发布基线已变化`);
        error.statusCode = 409;
        error.code = "LAN_SYNC_BASE_REVISION_CONFLICT";
        throw error;
      }
      const context = syncStore.currentVersionVector(configSpace);
      const op = syncStore.createLocalOperation({
        configSpace,
        changeSetId,
        originNodeId,
        entityType: "vehicle",
        entityKey: change.entityKey,
        action: change.action,
        baseRevision: change.baseRevision,
        context,
        actorUserId,
        payload: {
          projectId: preview.projectId,
          flavor: change.flavor,
          mapping: change.after,
          ...(change.resolves.length ? { resolves: change.resolves } : {}),
        },
      });
      ops.push(op);
      materializations.push({ type: "vehicle", change, op });
    }
    syncStore.sealChangeSet(ops);
    for (const item of materializations) {
      const { change, op } = item;
      if (item.type === "project-definition") {
        const write = vehicleStore.applyProjectDefSyncMaterialization({
          action: change.action,
          definition: change.after,
          id: change.id,
        });
        if (!write?.ok) throw new Error(write?.error || `仓库定义「${change.id}」保存失败`);
        syncStore.insertOperation(op, "applied");
        continue;
      }
      const write = vehicleStore.setVehicleMapping(
        preview.projectId,
        change.flavor,
        change.after,
        { emit: false, teamSync: true },
      );
      if (!write.ok) throw new Error(write.error || `车型「${change.flavor}」保存失败`);
      syncStore.insertOperation(op, "applied");
    }
    syncStore.recordIdempotency(configSpace, idempotencyKey, changeSetId);
    const members = publicationScope === "team"
      ? syncStore.createPendingDeliveries(changeSetId, configSpace, originNodeId)
      : [];
    for (const conflictId of Array.isArray(input.resolveConflictIds) ? input.resolveConflictIds : []) {
      const conflict = syncStore.getConflict(String(conflictId || ""));
      if (!conflict || conflict.status !== "open" || conflict.configSpace !== configSpace) {
        const error = new Error(`待解决冲突不存在或已处理：${conflictId}`);
        error.statusCode = 409;
        error.code = "LAN_SYNC_CONFLICT_NOT_OPEN";
        throw error;
      }
      syncStore.resolveConflictRecord(conflict.conflictId, actorUserId);
    }
    auditPublication({
      principal,
      changeSetId,
      configSpace,
      projectId: preview.projectId,
      ops,
      requestIp: requestMeta.ip || "",
      publicationScope,
    });
    if (input.draftId && actorUserId) syncStore.deleteDraft(input.draftId, actorUserId);
    return { ops, members };
  });
  if (result.repeated) return { ...syncStore.publicationStatus(result.repeated), idempotent: true };

  if (startsAutomaticGroup) {
    const seeded = publishExistingVehicleConfiguration(principal, { fanout: false });
    automaticSeededOperations = seeded.created;
    automaticSeedChangeSetIds = seeded.changeSetIds;
    const requiresRestart = configurePeerSync(configSpace, "", { createGroup: true });
    if (requiresRestart) restartLanSyncRuntime();
  }

  const entityKeys = result.ops.map((op) => op.entityKey);
  emitWs("shared_config_changed", {
    configSpace,
    projectIds: [preview.projectId],
    entityKeys,
    revision: result.ops.at(-1)?.opId || "",
    changeSetId,
    sourceNodeId: originNodeId,
  });
  if (Array.isArray(input.resolveConflictIds) && input.resolveConflictIds.length) {
    emitConflictsChanged({ sourceNodeId: originNodeId });
  }
  fanoutChangeSet(changeSetId);
  for (const seededChangeSetId of automaticSeedChangeSetIds) fanoutChangeSet(seededChangeSetId);
  emitDeliveryChanged(changeSetId);
  lanSyncDiagnostic("info", "publication_committed", {
    changeSetId,
    projectId: preview.projectId,
    operationCount: result.ops.length,
    memberCount: result.members.length,
  });
  return {
    ok: true,
    localCommitted: true,
    publicationScope,
    automaticSeededOperations,
    ...syncStore.publicationStatus(changeSetId),
  };
}

function wirePayloadLimit() {
  // AES-GCM 密文使用 base64url，需为 4/3 膨胀和固定 envelope 预留空间。
  return Math.ceil(limits().maxPayloadBytes * 1.5) + 4096;
}

export function saveVehicleDraft(input = {}, principal = {}) {
  const ownerUserId = principalId(principal);
  if (!ownerUserId) {
    const error = new Error("保存草稿需要稳定的管理员身份");
    error.statusCode = 403;
    error.code = "LAN_SYNC_STABLE_PRINCIPAL_REQUIRED";
    throw error;
  }
  const configSpace = assertConfigSpace(input.configSpace || configuredTeamConfigSpace());
  const projectId = vehicleStore.normalizeVehicleProjectId(input.projectId, { required: true });
  const changes = normalizeChanges(projectId, input.changes);
  return syncStore.saveDraft({
    draftId: String(input.draftId || "").trim() || undefined,
    ownerUserId,
    configSpace,
    projectId,
    baseRevision: input.baseRevision || vehicleStore.getRemoteConfig(projectId).revision,
    changes,
  });
}

export function getPublication(changeSetId) {
  return syncStore.publicationStatus(String(changeSetId || ""));
}

export function retryPublication(changeSetId) {
  const publication = syncStore.publicationStatus(String(changeSetId || ""));
  if (!publication) {
    const error = new Error("发布记录不存在");
    error.statusCode = 404;
    error.code = "LAN_SYNC_PUBLICATION_NOT_FOUND";
    throw error;
  }
  fanoutChangeSet(publication.changeSetId, { retry: true });
  emitDeliveryChanged(publication.changeSetId);
  return syncStore.publicationStatus(publication.changeSetId);
}

export function listVehicleConflicts() {
  return syncStore.listConflicts(configuredTeamConfigSpace());
}

export function resolveVehicleConflict(conflictId, mapping, principal = {}, idempotencyKey = randomUUID()) {
  const conflict = syncStore.getConflict(conflictId);
  if (!conflict || conflict.status !== "open") {
    const error = new Error("待解决冲突不存在");
    error.statusCode = 404;
    error.code = "LAN_SYNC_CONFLICT_NOT_FOUND";
    throw error;
  }
  if (conflict.entityType === "project-definition") {
    const definitionId = decodeProjectDefKey(conflict.entityKey);
    const sourceOperation = syncStore.getOperation(conflict.remoteRevision)
      || syncStore.getOperation(conflict.localRevision);
    const projectId = vehicleStore.normalizeVehicleProjectId(
      sourceOperation?.payload?.projectId,
      { required: true },
    );
    const currentRevision = syncStore.getEntityRevision(
      conflict.configSpace,
      "project-definition",
      conflict.entityKey,
    );
    return publishVehicleChanges({
      configSpace: conflict.configSpace,
      projectId,
      baseRevision: currentRevision,
      idempotencyKey,
      changes: [],
      projectDefs: [{
        id: definitionId,
        action: mapping == null ? "delete" : "set",
        definition: mapping,
        baseRevision: currentRevision,
        resolves: [conflict.localRevision, conflict.remoteRevision],
      }],
      resolveConflictIds: [conflictId],
    }, principal, { allowConflictResolution: true });
  }
  const { projectId, flavor } = decodeEntityKey(conflict.entityKey);
  const currentRevision = syncStore.getEntityRevision(conflict.configSpace, "vehicle", conflict.entityKey);
  const result = publishVehicleChanges({
    configSpace: conflict.configSpace,
    projectId,
    baseRevision: currentRevision,
    idempotencyKey,
    changes: [{
      action: mapping == null ? "delete" : "resolve",
      flavor,
      mapping,
      baseRevision: currentRevision,
      resolves: [conflict.localRevision, conflict.remoteRevision],
    }],
    resolveConflictIds: [conflictId],
  }, principal, { allowConflictResolution: true });
  return result;
}

export function localPairingBundle(host = "") {
  const identity = getLanSyncIdentity();
  return {
    protocolVersion: PROTOCOL_VERSION,
    schemaVersion: SCHEMA_VERSION,
    nodeId: currentNodeId(),
    nodeName: currentNodeName(),
    publicKey: identity.publicKey,
    certificateFingerprint: identity.fingerprint,
    configSpaces: [configuredTeamConfigSpace()],
    lanSyncGroupId: configuredLanSyncGroupId(),
    host: String(host || ""),
  };
}

export function pairMember(bundle = {}, {
  allowReactivation = false,
  allowKeyReplacement = false,
} = {}) {
  if (Number(bundle.protocolVersion) !== PROTOCOL_VERSION || Number(bundle.schemaVersion) !== SCHEMA_VERSION) {
    const error = new Error("节点协议或 schema 版本不兼容");
    error.statusCode = 409;
    error.code = "LAN_SYNC_PROTOCOL_INCOMPATIBLE";
    throw error;
  }
  const fingerprint = fingerprintPublicKey(bundle.publicKey);
  if (fingerprint !== String(bundle.certificateFingerprint || "")) {
    const error = new Error("节点公钥指纹不匹配");
    error.statusCode = 400;
    error.code = "LAN_SYNC_FINGERPRINT_MISMATCH";
    throw error;
  }
  const spaces = (Array.isArray(bundle.configSpaces) ? bundle.configSpaces : []).map(String);
  if (!spaces.includes(configuredTeamConfigSpace())) {
    const error = new Error("节点未授权当前 teamConfigSpace");
    error.statusCode = 403;
    error.code = "LAN_SYNC_CONFIG_SPACE_UNAUTHORIZED";
    throw error;
  }
  const existing = syncStore.getMember(String(bundle.nodeId || "").trim());
  if (existing && existing.state !== "active" && !allowReactivation) {
    const error = new Error(`节点已处于 ${existing.state} 状态，只有超级管理员可以重新启用`);
    error.statusCode = 409;
    error.code = "LAN_SYNC_MEMBER_REACTIVATION_FORBIDDEN";
    throw error;
  }
  if (existing && existing.certificateFingerprint !== fingerprint && !allowKeyReplacement) {
    const error = new Error("节点身份指纹已变化，只有超级管理员可以确认轮换");
    error.statusCode = 409;
    error.code = "LAN_SYNC_MEMBER_IDENTITY_CHANGED";
    throw error;
  }
  const member = syncStore.upsertMember({
    nodeId: bundle.nodeId,
    nodeName: bundle.nodeName,
    publicKey: bundle.publicKey,
    certificateFingerprint: fingerprint,
    configSpaces: spaces,
    state: "active",
    host: bundle.host,
  });
  if (existing && (
    existing.state !== "active"
    || existing.certificateFingerprint !== member.certificateFingerprint
  )) {
    const stale = connections.get(member.nodeId);
    if (stale) {
      connections.delete(member.nodeId);
      stale.authenticated = false;
      stale.member = member;
      try { stale.ws.close(1008, "member identity changed"); } catch {}
    }
  }
  if (member.host) observeLanSyncPeer({ id: member.nodeId, host: member.host, teamConfigSpace: configuredTeamConfigSpace() });
  return member;
}

function assertPairingAdmin(principal = {}) {
  if (!["super", "admin"].includes(String(principal?.role || "").toLowerCase())) {
    const error = new Error("只有管理员可以创建或加入局域网车型同步组");
    error.statusCode = 403;
    error.code = "LAN_SYNC_ADMIN_REQUIRED";
    throw error;
  }
}

function privateIpv4(hostname) {
  const parts = hostname.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  return parts[0] === 10
    || parts[0] === 127
    || (parts[0] === 169 && parts[1] === 254)
    || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31)
    || (parts[0] === 192 && parts[1] === 168);
}

export function normalizeLanSyncInvitationOrigin(value) {
  try {
    const url = new URL(String(value || "").trim());
    if (!["http:", "https:"].includes(url.protocol)
      || url.username || url.password || url.search || url.hash
      || (url.pathname && url.pathname !== "/")) return "";
    const hostname = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
    const version = isIP(hostname);
    const privateAddress = hostname === "localhost"
      || (version === 4 && privateIpv4(hostname))
      || (version === 6 && (
        hostname === "::1"
        || hostname.startsWith("fc")
        || hostname.startsWith("fd")
        || /^fe[89ab]/.test(hostname)
      ));
    return privateAddress ? url.origin : "";
  } catch {
    return "";
  }
}

function invitationSigningValue({ invitationId, nonce, bundle }) {
  return { invitationId: String(invitationId || ""), nonce: String(nonce || ""), bundle };
}

function invitationProof(secret, value) {
  return createHmac("sha256", secret)
    .update(canonicalJson(invitationSigningValue(value)), "utf8")
    .digest("base64url");
}

function decodeInvitationCode(code) {
  let invitation;
  try {
    const raw = Buffer.from(String(code || "").trim(), "base64url");
    if (!raw.length || raw.length > 16 * 1024) throw new Error("size");
    invitation = JSON.parse(raw.toString("utf8"));
  } catch {
    throw Object.assign(new Error("局域网同步加入码格式无效"), {
      statusCode: 400,
      code: "LAN_SYNC_INVITATION_INVALID",
    });
  }
  const host = normalizeLanSyncInvitationOrigin(invitation?.host);
  const secret = Buffer.from(String(invitation?.secret || ""), "base64url");
  const bundle = invitation?.bundle || {};
  if (Number(invitation?.version) !== 1
    || !host
    || !invitation?.invitationId
    || !(Number(invitation?.expiresAt) > Date.now())
    || secret.length !== 32
    || Number(bundle.protocolVersion) !== PROTOCOL_VERSION
    || fingerprintPublicKey(bundle.publicKey) !== String(bundle.certificateFingerprint || "")
    || !Array.isArray(bundle.configSpaces)
    || bundle.configSpaces.length !== 1) {
    throw Object.assign(new Error("局域网同步加入码无效或已过期"), {
      statusCode: 400,
      code: "LAN_SYNC_INVITATION_INVALID",
    });
  }
  return { ...invitation, host, secret, bundle: { ...bundle, host } };
}

function prunePairingInvitations(now = Date.now()) {
  for (const [id, invitation] of pairingInvitations) {
    if (Number(invitation.expiresAt) <= now) pairingInvitations.delete(id);
  }
}

function configurePeerSync(configSpace, _peerHost = "", {
  groupId = "",
  createGroup = false,
} = {}) {
  const current = getConfig();
  const currentGroupId = configuredLanSyncGroupId(current);
  const resolvedGroupId = String(
    groupId || currentGroupId || (createGroup ? automaticLanSyncGroupId(configSpace) : ""),
  ).trim().slice(0, 128);
  const requiresRestart = requestedLanSyncMode(current) !== "peer"
    || configuredTeamConfigSpace(current) !== String(configSpace || DEFAULT_TEAM_CONFIG_SPACE)
    || currentGroupId !== resolvedGroupId;
  updateConfig({
    vehicleConfigCenter: {
      ...(current.vehicleConfigCenter || {}),
      enabled: false,
    },
    lanSync: {
      ...(current.lanSync || {}),
      syncMode: "peer",
      teamConfigSpace: String(configSpace || DEFAULT_TEAM_CONFIG_SPACE),
      groupId: resolvedGroupId,
    },
  });
  return requiresRestart;
}

function restartLanSyncRuntime() {
  stopLanSync();
  initLanSync();
}

export function createLanSyncInvitation({ host = "", seedExistingConfig = true } = {}, principal = {}) {
  assertPairingAdmin(principal);
  const normalizedHost = normalizeLanSyncInvitationOrigin(host);
  if (!normalizedHost) {
    throw Object.assign(new Error("无法确定其它设备可访问的本机局域网 Gateway 地址"), {
      statusCode: 400,
      code: "LAN_SYNC_INVITATION_HOST_INVALID",
    });
  }
  if (configurePeerSync(DEFAULT_TEAM_CONFIG_SPACE, "", { createGroup: true })) restartLanSyncRuntime();
  const seeded = seedExistingConfig
    ? publishExistingVehicleConfiguration(principal)
    : { created: 0, changeSetIds: [] };
  const invitationId = randomUUID();
  const secret = randomBytes(32);
  const expiresAt = Date.now() + INVITATION_TTL_MS;
  const bundle = localPairingBundle(normalizedHost);
  prunePairingInvitations();
  while (pairingInvitations.size >= MAX_ACTIVE_INVITATIONS) {
    pairingInvitations.delete(pairingInvitations.keys().next().value);
  }
  pairingInvitations.set(invitationId, {
    invitationId,
    secret,
    expiresAt,
    bundle,
    acceptedNodeId: "",
  });
  const code = Buffer.from(JSON.stringify({
    version: 1,
    invitationId,
    secret: secret.toString("base64url"),
    expiresAt,
    host: normalizedHost,
    bundle,
  }), "utf8").toString("base64url");
  return {
    code,
    expiresAt,
    nodeId: bundle.nodeId,
    nodeName: bundle.nodeName,
    host: normalizedHost,
    configSpace: configuredTeamConfigSpace(),
    seededOperations: seeded.created,
  };
}

export function acceptLanSyncInvitationJoin(input = {}) {
  prunePairingInvitations();
  const invitationId = String(input.invitationId || "");
  const invitation = pairingInvitations.get(invitationId);
  if (!invitation || Number(invitation.expiresAt) <= Date.now()) {
    throw Object.assign(new Error("局域网同步加入码无效或已过期"), {
      statusCode: 410,
      code: "LAN_SYNC_INVITATION_EXPIRED",
    });
  }
  const proof = Buffer.from(String(input.proof || ""), "base64url");
  const expected = Buffer.from(invitationProof(invitation.secret, input), "base64url");
  if (proof.length !== expected.length || !timingSafeEqual(proof, expected)) {
    throw Object.assign(new Error("局域网同步加入证明无效"), {
      statusCode: 403,
      code: "LAN_SYNC_INVITATION_PROOF_INVALID",
    });
  }
  const joiningBundle = input.bundle || {};
  const joiningHost = normalizeLanSyncInvitationOrigin(joiningBundle.host);
  const configSpace = invitation.bundle.configSpaces[0];
  if (!joiningHost || invitation.acceptedNodeId && invitation.acceptedNodeId !== joiningBundle.nodeId) {
    throw Object.assign(new Error("局域网同步加入节点与邀请不匹配"), {
      statusCode: 409,
      code: "LAN_SYNC_INVITATION_ALREADY_USED",
    });
  }
  const member = pairMember({
    ...joiningBundle,
    host: joiningHost,
    configSpaces: [configSpace],
  });
  const requiresRestart = configurePeerSync(configSpace, joiningHost, {
    groupId: invitation.bundle.lanSyncGroupId,
  });
  invitation.acceptedNodeId = member.nodeId;
  invitation.expiresAt = Math.min(invitation.expiresAt, Date.now() + 2 * 60_000);
  fanoutMembershipSnapshot();
  if (requiresRestart) restartLanSyncRuntime();
  return {
    bundle: localPairingBundle(invitation.bundle.host),
    member: { nodeId: member.nodeId, nodeName: member.nodeName },
  };
}

export async function joinLanSyncInvitation({ code = "", host = "" } = {}, principal = {}, {
  fetchImpl = fetch,
} = {}) {
  assertPairingAdmin(principal);
  const invitation = decodeInvitationCode(code);
  const localHost = normalizeLanSyncInvitationOrigin(host);
  if (!localHost) {
    throw Object.assign(new Error("无法确定其它设备可访问的本机局域网 Gateway 地址"), {
      statusCode: 400,
      code: "LAN_SYNC_JOIN_HOST_INVALID",
    });
  }
  const configSpace = invitation.bundle.configSpaces[0];
  const bundle = {
    ...localPairingBundle(localHost),
    configSpaces: [configSpace],
  };
  const request = {
    invitationId: invitation.invitationId,
    nonce: randomBytes(24).toString("base64url"),
    bundle,
  };
  request.proof = invitationProof(invitation.secret, request);
  const response = await fetchImpl(`${invitation.host}/api/lan-sync/invitations/accept`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(request),
    redirect: "error",
    signal: AbortSignal.timeout(7000),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || !body.ok || !body.data?.bundle) {
    throw Object.assign(new Error(body.error || `远端 Gateway 拒绝加入（HTTP ${response.status}）`), {
      statusCode: response.status >= 400 ? response.status : 502,
      code: body.code || "LAN_SYNC_JOIN_FAILED",
    });
  }
  const remoteBundle = body.data.bundle;
  if (remoteBundle.nodeId !== invitation.bundle.nodeId
    || fingerprintPublicKey(remoteBundle.publicKey) !== invitation.bundle.certificateFingerprint
    || remoteBundle.certificateFingerprint !== invitation.bundle.certificateFingerprint) {
    throw Object.assign(new Error("远端 Gateway 身份与加入码不一致"), {
      statusCode: 409,
      code: "LAN_SYNC_JOIN_IDENTITY_MISMATCH",
    });
  }
  // Stop the previous group before changing any durable sync state. Merely
  // opening the page never reaches this path: only an authenticated admin's
  // explicit Join action can discard old transport history.
  stopLanSync();
  let discardedSyncState;
  try {
    discardedSyncState = syncStore.resetLanSyncStateForJoin();
    configurePeerSync(configSpace, invitation.host, {
      groupId: remoteBundle.lanSyncGroupId || invitation.bundle.lanSyncGroupId,
    });
    const member = pairMember({
      ...remoteBundle,
      host: invitation.host,
      configSpaces: [configSpace],
    });
    initLanSync();
    addAudit({
      id: `${currentNodeId()}-${Date.now()}-${randomBytes(4).toString("hex")}`,
      ts: Date.now(),
      ip: "",
      actor: principal?.name || principalId(principal),
      role: principal?.role || "",
      action: "车型配置.加入局域网同步组",
      target: configSpace,
      before: null,
      after: {
        peerNodeId: member.nodeId,
        discardedSyncState,
      },
      node: currentNodeId(),
    });
    return {
      member: { nodeId: member.nodeId, nodeName: member.nodeName, host: member.host },
      configSpace,
      syncMode: configuredLanSyncMode(),
      discardedSyncState,
    };
  } catch (error) {
    // Keep the Gateway usable even if local persistence/configuration fails
    // after the remote invitation was accepted.
    initLanSync();
    throw error;
  }
}

export function listLanSyncMembers() {
  return syncStore.listMembers(configuredTeamConfigSpace()).map((member) => ({
    ...member,
    online: connections.get(member.nodeId)?.authenticated === true,
  }));
}

function comparableOrigin(value) {
  try { return new URL(String(value || "")).origin.toLowerCase(); } catch { return ""; }
}

export function isLanSyncPeerOnline(info = {}) {
  const nodeId = String(info.lanSyncNodeId || info.nodeId || info.id || "").trim();
  if (nodeId && connections.get(nodeId)?.authenticated === true) return true;
  const host = comparableOrigin(info.host);
  if (!host) return false;
  return [...connections.values()].some((state) => (
    state.authenticated === true
    && comparableOrigin(state.host || state.member?.host) === host
  ));
}

export function updateLanSyncMemberState(nodeId, state) {
  const member = syncStore.setMemberState(nodeId, state);
  if (state !== "active") {
    try { connections.get(nodeId)?.ws?.close(1008, `member ${state}`); } catch {}
  }
  return member;
}

function envelope(type, data) {
  const value = {
    type,
    data,
    fromNodeId: currentNodeId(),
    timestamp: Date.now(),
    nonce: randomBytes(16).toString("hex"),
  };
  return { ...value, signature: signLanSyncValue(value) };
}

function sendEnvelope(state, type, data) {
  if (!state?.ws || state.ws.readyState !== WebSocket.OPEN) return false;
  const signed = envelope(type, data);
  const plaintextBytes = Buffer.byteLength(JSON.stringify(signed), "utf8");
  const { maxPayloadBytes } = limits();
  if (plaintextBytes > maxPayloadBytes) {
    throw new Error(`LAN 同步消息超过 ${maxPayloadBytes} bytes`);
  }
  const wireValue = type === "HELLO" || type === "HELLO_ACK"
    ? signed
    : encryptLanSyncMessage(state.channel, signed);
  const message = JSON.stringify(wireValue);
  if (Buffer.byteLength(message, "utf8") > wirePayloadLimit()) {
    throw new Error("LAN 同步加密消息超过 wire payload 上限");
  }
  if (Number(state.ws.bufferedAmount) > maxPayloadBytes * 4) {
    const error = new Error("LAN 同步发送队列已达到背压上限");
    error.code = "LAN_SYNC_BACKPRESSURE";
    throw error;
  }
  state.ws.send(message);
  syncStore.incrementMetric("delta-bytes-total", Buffer.byteLength(message, "utf8"));
  return true;
}

function membershipBundle(member) {
  return {
    protocolVersion: PROTOCOL_VERSION,
    schemaVersion: SCHEMA_VERSION,
    nodeId: member.nodeId,
    nodeName: member.nodeName,
    publicKey: member.publicKey,
    certificateFingerprint: member.certificateFingerprint,
    configSpaces: [...member.configSpaces],
    host: member.host || "",
  };
}

function membershipSnapshot() {
  const members = syncStore.listMembers(configuredTeamConfigSpace())
    .filter((member) => member.state === "active")
    .map(membershipBundle);
  return {
    members: [localPairingBundle(), ...members]
      .filter((bundle, index, all) => all.findIndex((row) => row.nodeId === bundle.nodeId) === index)
      .slice(0, 128),
  };
}

function fanoutMembershipSnapshot() {
  const snapshot = membershipSnapshot();
  for (const state of connections.values()) {
    if (!state.authenticated) continue;
    try { sendEnvelope(state, "MEMBER_SNAPSHOT", snapshot); } catch {}
  }
}

function helloData(state) {
  const identity = getLanSyncIdentity();
  const configSpace = configuredTeamConfigSpace();
  return {
    protocolVersion: PROTOCOL_VERSION,
    schemaVersion: SCHEMA_VERSION,
    nodeId: currentNodeId(),
    nodeName: currentNodeName(),
    certificateFingerprint: identity.fingerprint,
    configSpaces: [configSpace],
    versionVector: syncStore.currentVersionVector(configSpace),
    channelVersion: lanSyncChannelVersion(),
    keyAgreementPublicKey: state?.keyAgreement?.publicKey || "",
    keyAgreementNonce: state?.keyAgreement?.nonce || "",
  };
}

function verifyEnvelope(message, expectedMember = null) {
  if (!message || typeof message !== "object") return { ok: false, error: "消息格式错误" };
  const member = expectedMember || syncStore.getMember(message.fromNodeId);
  if (!member || member.state !== "active") return { ok: false, error: "节点未配对或已吊销" };
  if (!member.configSpaces.includes(configuredTeamConfigSpace())) return { ok: false, error: "配置空间未授权" };
  const timestamp = Number(message.timestamp) || 0;
  if (Math.abs(Date.now() - timestamp) > MAX_CLOCK_SKEW_MS) return { ok: false, error: "消息时间戳已过期" };
  const signed = {
    type: message.type,
    data: message.data,
    fromNodeId: message.fromNodeId,
    timestamp,
    nonce: message.nonce,
  };
  if (!verifyLanSyncValue(signed, message.signature, member.publicKey)) {
    syncStore.incrementMetric("signature-failures-total");
    return { ok: false, error: "消息签名校验失败" };
  }
  if (!syncStore.rememberNonce(member.nodeId, String(message.nonce || ""), {
    now: Date.now(),
    maxAgeMs: MAX_CLOCK_SKEW_MS * 2,
  })) {
    return { ok: false, error: "检测到重放消息" };
  }
  return { ok: true, member };
}

function validateIncomingOperation(op) {
  if (!op || op.configSpace !== configuredTeamConfigSpace()) return { ok: false, error: "操作配置空间不匹配" };
  if (Number(op.schemaVersion) !== SCHEMA_VERSION) return { ok: false, error: "操作 schema 版本不兼容" };
  const vehicleOperation = op.entityType === "vehicle" && ["set", "delete", "resolve"].includes(op.action);
  const projectDefOperation = op.entityType === "project-definition" && ["set", "delete"].includes(op.action);
  if (!vehicleOperation && !projectDefOperation) {
    return { ok: false, error: "操作类型未授权" };
  }
  if (!op.opId || !op.changeSetId || !op.originNodeId || !(Number(op.originSeq) > 0)) {
    return { ok: false, error: "操作标识或 origin 序号不合法" };
  }
  try {
    const payloadProjectId = vehicleStore.normalizeVehicleProjectId(op.payload?.projectId, { required: true });
    if (vehicleOperation) {
      const entity = decodeEntityKey(op.entityKey);
      if (entity.projectId !== payloadProjectId || entity.flavor !== String(op.payload?.flavor || "").trim()) {
        return { ok: false, error: "操作 entityKey 与 payload 不一致" };
      }
      if (op.action === "delete" && op.payload?.mapping != null) {
        return { ok: false, error: "删除操作不得携带车型映射" };
      }
      if (op.action !== "delete" && (!op.payload?.mapping || typeof op.payload.mapping !== "object")) {
        return { ok: false, error: "设置操作缺少车型映射" };
      }
    } else {
      const id = decodeProjectDefKey(op.entityKey);
      if (id !== String(op.payload?.id || "").trim()) {
        return { ok: false, error: "仓库定义 entityKey 与 payload 不一致" };
      }
      if (op.action !== "delete") vehicleStore.normalizeTeamProjectDef(op.payload?.definition || {});
    }
  } catch (error) {
    return { ok: false, error: error?.message || "车型操作 payload 不合法" };
  }
  if (syncStore.payloadHash(op.payload ?? null) !== op.payloadHash) return { ok: false, error: "payload hash 不匹配" };
  const origin = syncStore.getMember(op.originNodeId);
  if (!origin || origin.state !== "active" || !origin.configSpaces.includes(op.configSpace)) {
    return { ok: false, error: `操作来源节点 ${op.originNodeId} 未授权` };
  }
  if (!verifyLanSyncValue(syncStore.operationSigningValue(op), op.signature, origin.publicKey)) {
    syncStore.incrementMetric("signature-failures-total");
    return { ok: false, error: "操作签名校验失败" };
  }
  return {
    ok: true,
    compacted: Number(op.originSeq) <= syncStore.compactionFloor(op.originNodeId),
  };
}

export function validateChangeSetManifest(ops, declaredChangeSetId) {
  const changeSetId = String(declaredChangeSetId || "");
  if (!changeSetId || ops.some((op) => String(op?.changeSetId || "") !== changeSetId)) {
    return { ok: false, error: "消息 changeSetId 与操作清单不一致" };
  }
  // 仅兼容开发期已经落盘的单操作旧记录；新的多操作发布必须携带由
  // origin 逐 op 签名的完整 manifest。
  if (ops.length === 1 && !ops[0]?.changeSetHash) return { ok: true, legacySingle: true };
  const size = Number(ops[0]?.changeSetSize) || 0;
  const manifestHash = String(ops[0]?.changeSetHash || "");
  const originNodeId = String(ops[0]?.originNodeId || "");
  if (size !== ops.length || !manifestHash || ops.some((op) => (
    Number(op?.changeSetSize) !== size
    || String(op?.changeSetHash || "") !== manifestHash
    || String(op?.originNodeId || "") !== originNodeId
  ))) {
    return { ok: false, error: "change set 来源、操作数或 manifest hash 不完整" };
  }
  const indexes = [...ops].map((op) => Number(op?.changeSetIndex)).sort((a, b) => a - b);
  if (indexes.some((value, index) => value !== index)) {
    return { ok: false, error: "change set 操作索引缺失或重复" };
  }
  if (syncStore.changeSetManifestHash(ops) !== manifestHash) {
    return { ok: false, error: "change set manifest hash 校验失败" };
  }
  return { ok: true };
}

function applyIncomingOperations(ops, fromPeerNodeId) {
  const results = [];
  const changed = [];
  const resolvedConflictIds = [];
  const checked = ops.map((op) => ({ op, validation: validateIncomingOperation(op) }));
  const invalid = checked
    .filter((row) => !row.validation.ok);
  if (invalid.length) {
    auditLanSyncRejection(
      invalid.map((row) => row.validation.error).join("；"),
      "change-set",
      fromPeerNodeId,
    );
    const errors = new Map(invalid.map((row) => [row.op?.opId, row.validation.error]));
    return ops.map((op) => ({
      opId: op?.opId || "",
      status: "failed",
      error: errors.get(op?.opId) || "同一变更集包含无效操作，已整体拒绝",
    }));
  }

  const candidates = [];
  for (const { op, validation } of checked) {
    if (syncStore.getOperation(op.opId)) {
      syncStore.incrementMetric("deduplicated-total");
      results.push({ opId: op.opId, status: "deduplicated" });
      continue;
    }
    if (validation.compacted) {
      syncStore.incrementMetric("deduplicated-total");
      results.push({ opId: op.opId, status: "deduplicated" });
      continue;
    }
    const current = syncStore.getEntityOperation(op.configSpace, op.entityType, op.entityKey);
    const currentRevision = current?.opId || "0";
    const causallyIncludesCurrent = !!current
      && Number(op.context?.[current.originNodeId] || 0) >= Number(current.originSeq || 0);
    let localPayload;
    let incomingPayload;
    if (op.entityType === "project-definition") {
      const id = decodeProjectDefKey(op.entityKey);
      const currentDef = vehicleStore.getProjectDef(id);
      localPayload = currentDef ? vehicleStore.normalizeTeamProjectDef(currentDef) : null;
      incomingPayload = op.action === "delete" ? null : (op.payload?.definition ?? null);
    } else {
      const { projectId, flavor } = decodeEntityKey(op.entityKey);
      localPayload = vehicleStore.getRemoteConfig(projectId).vehicleMap?.[flavor] ?? null;
      incomingPayload = op.action === "delete" ? null : (op.payload?.mapping ?? null);
    }
    const concurrent = currentRevision !== String(op.baseRevision || "0") && !causallyIncludesCurrent;
    candidates.push({
      op,
      currentRevision,
      localPayload,
      incomingPayload,
      status: concurrent
        ? (sameValue(localPayload, incomingPayload) ? "superseded" : "conflict")
        : "applied",
    });
  }

  if (candidates.some((candidate) => candidate.status === "conflict")) {
    // change set 是原子发布单位：其中一个实体冲突时不应用其它实体。为每个实体
    // 留冲突记录，管理员可明确选择，避免导入的一部分被静默丢弃。
    syncStore.runLanSyncTransaction(() => {
      for (const candidate of candidates) {
        const { op } = candidate;
        syncStore.insertOperation(op, "conflict");
        const conflict = syncStore.createConflict({
          configSpace: op.configSpace,
          entityType: op.entityType,
          entityKey: op.entityKey,
          localRevision: candidate.currentRevision,
          remoteRevision: op.opId,
          localPayload: candidate.localPayload,
          remotePayload: candidate.incomingPayload,
        });
        results.push({ opId: op.opId, status: "conflict", conflictId: conflict.conflictId });
      }
    });
    emitConflictsChanged({
      sourceNodeId: fromPeerNodeId,
      entityKeys: candidates.map((candidate) => candidate.op.entityKey),
    });
    return results;
  }

  syncStore.runLanSyncTransaction(() => {
    for (const candidate of candidates) {
      const { op } = candidate;
      if (candidate.status === "superseded") {
        // 保留远端 origin/seq 以推进版本向量，但不替换本机实体 head，避免两端
        // 各自迁移出的同内容 baseline 因接收顺序不同形成相反的当前 revision。
        syncStore.insertOperation(op, "superseded");
        syncStore.incrementMetric("deduplicated-total");
        results.push({ opId: op.opId, status: "deduplicated" });
        continue;
      }
      const payload = op.payload || {};
      if (op.entityType === "project-definition") {
        const write = vehicleStore.applyProjectDefSyncMaterialization({
          action: op.action,
          definition: payload.definition,
          id: payload.id,
        });
        if (!write?.ok) throw new Error(write?.error || `仓库定义「${payload.id}」应用失败`);
      } else {
        vehicleStore.applyVehicleSyncMaterialization({
          projectId: payload.projectId,
          flavor: payload.flavor,
          mapping: payload.mapping,
          action: op.action === "delete" ? "delete" : "set",
          opId: op.opId,
          originNodeId: op.originNodeId,
          originSeq: op.originSeq,
          createdAt: op.createdAt,
          emit: false,
        });
      }
      syncStore.insertOperation(op, "applied");
      resolvedConflictIds.push(...syncStore.resolveConflictsByRevisions({
        configSpace: op.configSpace,
        entityType: op.entityType,
        entityKey: op.entityKey,
        revisions: payload.resolves,
        resolvedBy: op.actorUserId || op.originNodeId,
      }));
      syncStore.incrementMetric("apply-latency-sum", Math.max(0, Date.now() - Number(op.createdAt || Date.now())));
      syncStore.incrementMetric("apply-latency-count");
      changed.push(op);
      results.push({ opId: op.opId, status: "applied" });
    }
  });
  if (changed.length) {
    emitWs("shared_config_changed", {
      configSpace: configuredTeamConfigSpace(),
      projectIds: [...new Set(changed.map((op) => op.payload?.projectId).filter(Boolean))],
      entityKeys: [...new Set(changed.map((op) => op.entityKey))],
      revision: changed.at(-1)?.opId || "",
      changeSetId: changed.at(-1)?.changeSetId || "",
      sourceNodeId: fromPeerNodeId,
    });
  }
  if (resolvedConflictIds.length) {
    emitConflictsChanged({
      sourceNodeId: fromPeerNodeId,
      entityKeys: changed.map((op) => op.entityKey),
      resolvedConflictIds,
    });
  }
  return results;
}

function registerAuthenticatedConnection(state, member, remoteHello) {
  const existing = connections.get(member.nodeId);
  if (existing && existing !== state) {
    try { existing.ws.close(1000, "replaced by canonical connection"); } catch {}
  }
  state.peerNodeId = member.nodeId;
  state.member = member;
  state.channel = deriveLanSyncChannel({
    localNodeId: currentNodeId(),
    remoteNodeId: member.nodeId,
    localAgreement: state.keyAgreement,
    remotePublicKey: remoteHello?.keyAgreementPublicKey,
    remoteNonce: remoteHello?.keyAgreementNonce,
  });
  state.authenticated = true;
  connections.set(member.nodeId, state);
  reconnectAttempts.delete(member.nodeId);
  if (reconnectTimers.has(member.nodeId)) clearTimeout(reconnectTimers.get(member.nodeId));
  reconnectTimers.delete(member.nodeId);
  state.lastPongAt = Date.now();
  syncStore.touchMember(member.nodeId, { host: state.host || member.host, seenAt: Date.now() });
  const remoteVector = remoteHello?.versionVector || {};
  state.remoteVector = { ...remoteVector };
  reconcileDeliveriesFromPeerVector(member.nodeId, remoteVector);
  // 成员清单先于缺口操作发送，保证三台及以上 Gateway 能验证被其它成员
  // 原始签名的操作；清单本身只接受已配对直连成员的加密签名消息。
  sendEnvelope(state, "MEMBER_SNAPSHOT", membershipSnapshot());
  sendMissingOperations(state, remoteVector);
  lanSyncDiagnostic("info", "peer_authenticated", {
    peerNodeId: member.nodeId,
    outbound: state.outbound,
    tlsAuthorized: state.tlsAuthorized,
    applicationEncryption: "X25519+AES-256-GCM",
  });
}

function handleMemberSnapshot(state, message) {
  const verified = verifyEnvelope(message, state.member);
  if (!verified.ok) {
    auditLanSyncRejection(verified.error, "MEMBER_SNAPSHOT", message?.fromNodeId);
    return;
  }
  const members = Array.isArray(message.data?.members) ? message.data.members.slice(0, 128) : [];
  for (const bundle of members) {
    if (!bundle?.nodeId || bundle.nodeId === currentNodeId() || bundle.nodeId === state.peerNodeId) continue;
    const host = bundle.host ? normalizeLanSyncInvitationOrigin(bundle.host) : "";
    if (bundle.host && !host) {
      auditLanSyncRejection("成员地址不是私有局域网 origin", "MEMBER_SNAPSHOT", bundle.nodeId);
      continue;
    }
    try {
      pairMember({ ...bundle, host });
    } catch (error) {
      auditLanSyncRejection(error.message || "成员清单条目无效", "MEMBER_SNAPSHOT", bundle.nodeId);
    }
  }
}

function handleHello(state, message, isAck) {
  const member = syncStore.getMember(message?.data?.nodeId || message?.fromNodeId);
  const verified = verifyEnvelope(message, member);
  if (!verified.ok
    || message.fromNodeId !== message.data?.nodeId
    || Number(message.data?.protocolVersion) !== PROTOCOL_VERSION
    || Number(message.data?.schemaVersion) !== SCHEMA_VERSION
    || Number(message.data?.channelVersion) !== lanSyncChannelVersion()
    || !message.data?.keyAgreementPublicKey
    || !message.data?.keyAgreementNonce
    || message.data?.certificateFingerprint !== member?.certificateFingerprint
    || !message.data?.configSpaces?.includes(configuredTeamConfigSpace())) {
    auditLanSyncRejection(verified.error || "HELLO 元数据不匹配", "HELLO", message?.fromNodeId);
    try { state.ws.close(1008, verified.error || "HELLO rejected"); } catch {}
    return;
  }
  try {
    if (!isAck) sendEnvelope(state, "HELLO_ACK", helloData(state));
    registerAuthenticatedConnection(state, member, message.data);
  } catch (error) {
    auditLanSyncRejection(error.message || "加密通道协商失败", "CHANNEL", message?.fromNodeId);
    try { state.ws.close(1008, "secure channel rejected"); } catch {}
  }
}

function handleChangeSet(state, message) {
  const verified = verifyEnvelope(message, state.member);
  if (!verified.ok) {
    auditLanSyncRejection(verified.error, message?.type || "CHANGE_SET", message?.fromNodeId);
    sendEnvelope(state, "ERROR", { code: "LAN_SYNC_MESSAGE_REJECTED", error: verified.error });
    return;
  }
  const ops = Array.isArray(message.data?.ops) ? message.data.ops : [];
  const { maxOps } = limits();
  if (!ops.length || ops.length > maxOps) {
    sendEnvelope(state, "ERROR", { code: "LAN_SYNC_OPERATION_LIMIT", error: "操作数量不合法" });
    return;
  }
  const manifest = validateChangeSetManifest(ops, message.data?.changeSetId);
  if (!manifest.ok) {
    auditLanSyncRejection(manifest.error, "change-set-manifest", state.peerNodeId);
    sendEnvelope(state, "ERROR", { code: "LAN_SYNC_CHANGE_SET_INCOMPLETE", error: manifest.error });
    return;
  }
  const results = applyIncomingOperations(ops, state.peerNodeId);
  const vector = syncStore.currentVersionVector(configuredTeamConfigSpace());
  sendEnvelope(state, "ACK", {
    changeSetId: String(message.data?.changeSetId || ops[0]?.changeSetId || ""),
    vector,
    results,
  });
}

function handleAck(state, message) {
  const verified = verifyEnvelope(message, state.member);
  if (!verified.ok) return;
  const changeSetId = String(message.data?.changeSetId || "");
  const results = Array.isArray(message.data?.results) ? message.data.results : [];
  const changeSetOps = changeSetId ? syncStore.listChangeSetOps(changeSetId) : [];
  const knownOpIds = new Set(changeSetOps.map((op) => op.opId));
  const resultOpIds = new Set(results.map((row) => String(row?.opId || "")));
  if (!changeSetOps.length
    || !results.length
    || results.length !== changeSetOps.length
    || resultOpIds.size !== knownOpIds.size
    || results.some((row) => !knownOpIds.has(String(row?.opId || "")))) {
    auditLanSyncRejection("ACK 未对应本机已知变更集或操作", "ACK", state.peerNodeId);
    return;
  }
  const status = results.some((row) => row.status === "failed")
    ? "failed"
    : (results.some((row) => row.status === "conflict") ? "conflict" : "applied");
  syncStore.runLanSyncTransaction(() => {
    syncStore.updatePeerCursor(state.peerNodeId, message.data?.vector || {});
    if (changeSetId) {
      syncStore.markDelivery(changeSetId, state.peerNodeId, status, {
        error: results.find((row) => row.error)?.error || "",
        acknowledgedAt: Date.now(),
      });
      const sentAt = Math.min(...changeSetOps.map((op) => Number(op.createdAt) || Date.now()));
      syncStore.incrementMetric("ack-latency-sum", Math.max(0, Date.now() - sentAt));
      syncStore.incrementMetric("ack-latency-count");
    }
  });
  if (changeSetId) emitDeliveryChanged(changeSetId);
  const acknowledgedVector = message.data?.vector || {};
  state.remoteVector = { ...acknowledgedVector };
  if (status !== "failed" && state.pendingRangeTarget) {
    const vector = acknowledgedVector;
    const covered = Object.entries(state.pendingRangeTarget).every(([originNodeId, sequence]) => (
      Number(vector?.[originNodeId] || 0) >= Number(sequence || 0)
    ));
    if (covered) {
      state.pendingRangeTarget = null;
      state.pendingRangeSentAt = 0;
      queueMicrotask(() => {
        try { sendMissingOperations(state, vector); } catch {}
      });
    }
  }
}

function normalizeManualSyncVector(value = {}) {
  return Object.fromEntries(Object.entries(value && typeof value === "object" ? value : {})
    .slice(0, 512)
    .map(([originNodeId, sequence]) => [
      String(originNodeId || "").trim().slice(0, 160),
      Math.max(0, Math.min(Number.MAX_SAFE_INTEGER, Number(sequence) || 0)),
    ])
    .filter(([originNodeId]) => !!originNodeId));
}

function handleSyncRequest(state, message) {
  const verified = verifyEnvelope(message, state.member);
  if (!verified.ok) {
    auditLanSyncRejection(verified.error, "SYNC_REQUEST", message?.fromNodeId);
    return;
  }
  const requestId = String(message.data?.requestId || "").trim().slice(0, 160);
  const remoteVector = normalizeManualSyncVector(message.data?.vector);
  state.remoteVector = remoteVector;
  reconcileDeliveriesFromPeerVector(state.peerNodeId, remoteVector);
  const sentOperations = configuredLanSyncMode() === "receive-only"
    ? 0
    : sendMissingOperations(state, remoteVector);
  sendEnvelope(state, "SYNC_STATUS", {
    requestId,
    vector: syncStore.currentVersionVector(configuredTeamConfigSpace()),
    sentOperations,
    conflictCount: syncStore.listConflicts(configuredTeamConfigSpace()).length,
  });
}

function handleSyncStatus(state, message) {
  const verified = verifyEnvelope(message, state.member);
  if (!verified.ok) {
    auditLanSyncRejection(verified.error, "SYNC_STATUS", message?.fromNodeId);
    return;
  }
  const remoteVector = normalizeManualSyncVector(message.data?.vector);
  state.remoteVector = remoteVector;
  reconcileDeliveriesFromPeerVector(state.peerNodeId, remoteVector);
  const sentOperations = configuredLanSyncMode() === "receive-only"
    ? 0
    : sendMissingOperations(state, remoteVector);
  emitWs("vehicle_config_sync_status", {
    requestId: String(message.data?.requestId || "").trim().slice(0, 160),
    peerNodeId: state.peerNodeId,
    remoteSentOperations: Math.max(0, Number(message.data?.sentOperations) || 0),
    sentOperations,
    remoteConflictCount: Math.max(0, Number(message.data?.conflictCount) || 0),
  });
}

function handleSocketMessage(state, raw) {
  const { maxPayloadBytes } = limits();
  if (Buffer.byteLength(raw) > wirePayloadLimit()) {
    try { state.ws.close(1009, "payload too large"); } catch {}
    return;
  }
  let message;
  try { message = JSON.parse(raw.toString("utf8")); } catch {
    try { state.ws.close(1003, "invalid json"); } catch {}
    return;
  }
  if (!state.authenticated) {
    if (message.type === "HELLO") return handleHello(state, message, false);
    if (message.type === "HELLO_ACK" && state.outbound) return handleHello(state, message, true);
    try { state.ws.close(1008, "HELLO required"); } catch {}
    return;
  }
  if (message.type !== "ENCRYPTED") {
    try { state.ws.close(1008, "encrypted message required"); } catch {}
    return;
  }
  try {
    message = decryptLanSyncMessage(state.channel, message);
  } catch (error) {
    auditLanSyncRejection(error.message || "密文校验失败", "CHANNEL", state.peerNodeId);
    try { state.ws.close(1008, "encrypted message rejected"); } catch {}
    return;
  }
  if (Buffer.byteLength(JSON.stringify(message), "utf8") > maxPayloadBytes) {
    try { state.ws.close(1009, "plaintext payload too large"); } catch {}
    return;
  }
  if (message.fromNodeId !== state.peerNodeId) {
    try { state.ws.close(1008, "peer identity changed"); } catch {}
    return;
  }
  if (message.type === "CHANGE_SET" || message.type === "RANGE_RESPONSE") handleChangeSet(state, message);
  else if (message.type === "ACK") handleAck(state, message);
  else if (message.type === "MEMBER_SNAPSHOT") handleMemberSnapshot(state, message);
  else if (message.type === "SYNC_REQUEST") handleSyncRequest(state, message);
  else if (message.type === "SYNC_STATUS") handleSyncStatus(state, message);
}

function attachSocket(ws, {
  outbound = false,
  host = "",
  connectKey = "",
  expectedPeerNodeId = "",
  forceOutbound = false,
} = {}) {
  const state = {
    ws,
    outbound,
    host,
    authenticated: false,
    peerNodeId: "",
    member: null,
    lastPongAt: Date.now(),
    pendingRangeTarget: null,
    pendingRangeSentAt: 0,
    remoteVector: {},
    keyAgreement: createLanSyncKeyAgreement(),
    channel: null,
    expectedPeerNodeId: String(expectedPeerNodeId || ""),
    forceOutbound: forceOutbound === true,
  };
  ws.on("pong", () => { state.lastPongAt = Date.now(); });
  ws.on("message", (raw) => {
    try { handleSocketMessage(state, raw); } catch (error) {
      log("system", "warn", "lan-sync", `处理 peer 消息失败：${error.message}`);
      try { ws.close(1011, "message processing failed"); } catch {}
    }
  });
  ws.on("close", () => {
    if (state.peerNodeId && connections.get(state.peerNodeId) === state) {
      connections.delete(state.peerNodeId);
      markPeerOffline(state.peerNodeId);
      schedulePeerReconnect(state.peerNodeId, state.member?.host || host, {
        forceOutbound: state.forceOutbound,
      });
    } else if (outbound && !state.authenticated && state.expectedPeerNodeId) {
      // A newly advertised member may still be restarting after accepting the
      // invitation. Retry pre-authentication failures as well as established
      // connection drops so three-node meshes do not depend on join timing.
      schedulePeerReconnect(state.expectedPeerNodeId, host, {
        forceOutbound: state.forceOutbound,
      });
    }
    lanSyncDiagnostic("info", "peer_disconnected", {
      peerNodeId: state.peerNodeId,
      outbound,
    });
    if (connectKey) connecting.delete(connectKey);
  });
  ws.on("error", () => {
    if (connectKey) connecting.delete(connectKey);
  });
  if (outbound) {
    ws.on("open", () => sendEnvelope(state, "HELLO", helloData(state)));
  }
  return state;
}

function schedulePeerReconnect(peerNodeId, host, { forceOutbound = false } = {}) {
  if (stopping || !peerNodeId || !host || reconnectTimers.has(peerNodeId)) return;
  if (!forceOutbound && currentNodeId().localeCompare(peerNodeId) >= 0) return;
  const attempt = Math.min(8, (reconnectAttempts.get(peerNodeId) || 0) + 1);
  reconnectAttempts.set(peerNodeId, attempt);
  const base = Math.min(30_000, 500 * (2 ** (attempt - 1)));
  const delay = Math.floor(base * (0.75 + Math.random() * 0.5));
  const timer = setTimeout(() => {
    reconnectTimers.delete(peerNodeId);
    observeLanSyncPeer({ id: peerNodeId, host }, { forceOutbound });
    if (!connections.get(peerNodeId)?.authenticated) {
      schedulePeerReconnect(peerNodeId, host, { forceOutbound });
    }
  }, delay);
  timer.unref?.();
  reconnectTimers.set(peerNodeId, timer);
}

export function handleLanSyncConnection(ws, req) {
  const mode = configuredLanSyncMode();
  if (mode === "disabled") {
    try { ws.close(1008, "LAN sync disabled"); } catch {}
    return;
  }
  const tls = lanSyncTlsConfig();
  const tlsAuthorized = req?.socket?.authorized === true;
  if (tls.required && !tlsAuthorized) {
    auditLanSyncRejection(
      String(req?.socket?.authorizationError || "mTLS client certificate required"),
      "TLS",
      "",
    );
    try { ws.close(1008, "mTLS client certificate required"); } catch {}
    return;
  }
  const state = attachSocket(ws, { outbound: false, host: "" });
  state.tlsAuthorized = tlsAuthorized;
}

function peerWsUrl(host) {
  const url = new URL(String(host || ""));
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = "/ws";
  url.search = "";
  url.searchParams.set("channel", "lan-sync");
  return url.toString();
}

export function observeLanSyncPeer(info = {}, { forceOutbound = false } = {}) {
  const mode = configuredLanSyncMode();
  if (mode === "disabled") return false;
  const peerNodeId = String(info.lanSyncNodeId || info.nodeId || info.id || "").trim();
  const host = String(info.host || "").trim();
  if (!peerNodeId || !host || peerNodeId === currentNodeId()) return false;
  const member = syncStore.getMember(peerNodeId);
  if (!member || member.state !== "active" || !member.configSpaces.includes(configuredTeamConfigSpace())) return false;
  // 在线状态完全由 WebSocket ping/pong 管理；发现包只在 IP 变化时更新持久成员地址。
  if (comparableOrigin(member.host) !== comparableOrigin(host)) {
    syncStore.touchMember(peerNodeId, { host, seenAt: member.lastSeenAt || Date.now() });
  }
  if (connections.get(peerNodeId)?.authenticated) return true;
  // nodeId 较小的一端主动连接，保证同一对节点只有一条逻辑连接。
  if (!forceOutbound && currentNodeId().localeCompare(peerNodeId) >= 0) return false;
  let url;
  try { url = peerWsUrl(host); } catch { return false; }
  if (lanSyncTlsConfig().required && !url.startsWith("wss:")) {
    auditLanSyncRejection("mTLS required，拒绝降级到 ws", "TLS_DOWNGRADE", peerNodeId);
    return false;
  }
  if (connecting.has(url)) return false;
  connecting.add(url);
  try {
    const tlsOptions = url.startsWith("wss:") ? lanSyncClientTlsOptions() : {};
    const ws = new WebSocket(url, {
      maxPayload: wirePayloadLimit(),
      handshakeTimeout: 5000,
      ...tlsOptions,
    });
    const state = attachSocket(ws, {
      outbound: true,
      host,
      connectKey: url,
      expectedPeerNodeId: peerNodeId,
      forceOutbound,
    });
    state.tlsAuthorized = url.startsWith("wss:");
    return true;
  } catch {
    connecting.delete(url);
    return false;
  }
}

function sendOps(state, ops, type = "CHANGE_SET") {
  if (!ops.length) return;
  const byChangeSet = new Map();
  for (const op of ops) {
    if (!byChangeSet.has(op.changeSetId)) byChangeSet.set(op.changeSetId, []);
    byChangeSet.get(op.changeSetId).push(op);
  }
  for (const [changeSetId, rows] of byChangeSet) {
    sendEnvelope(state, type, { changeSetId, ops: rows });
    syncStore.markDelivery(changeSetId, state.peerNodeId, "sent");
  }
}

function sendMissingOperations(state, remoteVector) {
  const ops = syncStore.listOpsMissingFromVector(configuredTeamConfigSpace(), remoteVector, { limit: 5000 });
  if (!ops.length) {
    state.pendingRangeTarget = null;
    state.pendingRangeSentAt = 0;
    return 0;
  }
  const target = { ...(remoteVector || {}) };
  for (const op of ops) {
    target[op.originNodeId] = Math.max(Number(target[op.originNodeId]) || 0, Number(op.originSeq) || 0);
  }
  state.pendingRangeTarget = target;
  state.pendingRangeSentAt = Date.now();
  // sendOps 按 changeSet 分组；同一变更集绝不拆包，接收端才能原子应用导入。
  sendOps(state, ops, "RANGE_RESPONSE");
  return ops.length;
}

export function retryConnectedRanges(now = Date.now()) {
  for (const state of connections.values()) {
    if (!state.authenticated) continue;
    const waitingForAck = state.pendingRangeTarget
      && now - Number(state.pendingRangeSentAt || 0) < 30_000;
    if (waitingForAck) continue;
    try {
      sendMissingOperations(state, state.remoteVector || {});
    } catch (error) {
      log("system", "warn", "lan-sync", `重试 peer range 失败：${error.message}`);
    }
  }
}

export function requestVehicleSyncNow({ requestId = randomUUID() } = {}) {
  const configSpace = configuredTeamConfigSpace();
  const mode = configuredLanSyncMode();
  const groupReady = !!configuredLanSyncGroupId();
  const members = syncStore.listMembers(configSpace)
    .filter((member) => member.state === "active" && member.nodeId !== currentNodeId());
  let reconnectingPeers = 0;
  let requestedPeers = 0;
  let sentOperations = 0;
  const vector = syncStore.currentVersionVector(configSpace);
  for (const member of groupReady ? members : []) {
    const state = connections.get(member.nodeId);
    if (!state?.authenticated) {
      if (member.host && observeLanSyncPeer({
        lanSyncNodeId: member.nodeId,
        host: member.host,
      })) reconnectingPeers += 1;
      continue;
    }
    if (mode !== "receive-only") {
      sentOperations += sendMissingOperations(state, state.remoteVector || {});
    }
    sendEnvelope(state, "SYNC_REQUEST", { requestId, vector });
    requestedPeers += 1;
  }
  const status = requestedPeers > 0
    ? "requested"
    : (!groupReady || mode === "disabled" ? "waiting-for-publisher" : "waiting-for-peer");
  const result = {
    ok: true,
    requestId: String(requestId || "").slice(0, 160),
    status,
    syncMode: mode,
    groupReady,
    teamConfigSpace: configSpace,
    knownMembers: members.length,
    connectedPeers: [...connections.values()].filter((state) => state.authenticated).length,
    reconnectingPeers,
    requestedPeers,
    sentOperations,
    conflictCount: syncStore.listConflicts(configSpace).length,
    vector,
  };
  lanSyncDiagnostic("info", "manual_sync_requested", result);
  return result;
}

function fanoutChangeSet(changeSetId, { retry = false } = {}) {
  const ops = syncStore.listChangeSetOps(changeSetId);
  if (!ops.length) return;
  const publication = syncStore.publicationStatus(changeSetId);
  for (const delivery of publication?.deliveries || []) {
    if (!retry && ["applied", "conflict"].includes(delivery.status)) continue;
    const state = connections.get(delivery.peerNodeId);
    if (!state?.authenticated) {
      syncStore.markDelivery(changeSetId, delivery.peerNodeId, "offline");
      continue;
    }
    try {
      sendOps(state, ops);
    } catch (error) {
      syncStore.markDelivery(changeSetId, delivery.peerNodeId, "failed", { error: error.message });
    }
  }
}

function reconcileDeliveriesFromPeerVector(peerNodeId, vector = {}) {
  const configSpace = configuredTeamConfigSpace();
  syncStore.updatePeerCursor(peerNodeId, vector);
  for (const changeSetId of syncStore.listOutstandingChangeSetsForPeer(peerNodeId, configSpace)) {
    const ops = syncStore.listChangeSetOps(changeSetId);
    if (!ops.length || !ops.every((op) => (
      Number(vector?.[op.originNodeId] || 0) >= Number(op.originSeq || 0)
    ))) continue;
    syncStore.markDelivery(changeSetId, peerNodeId, "applied", { acknowledgedAt: Date.now() });
    emitDeliveryChanged(changeSetId);
  }
}

function markPeerOffline(peerNodeId) {
  const ops = syncStore.listOpsMissingFromVector(configuredTeamConfigSpace(), {}, { limit: 5000 })
    .filter((op) => op.originNodeId === currentNodeId());
  for (const changeSetId of new Set(ops.map((op) => op.changeSetId))) {
    const delivery = syncStore.listDeliveries(changeSetId).find((row) => row.peerNodeId === peerNodeId);
    if (delivery && ["pending", "sent", "failed"].includes(delivery.status)) {
      syncStore.markDelivery(changeSetId, peerNodeId, "offline");
      emitDeliveryChanged(changeSetId);
    }
  }
}

function emitConflictsChanged({ sourceNodeId = currentNodeId(), entityKeys = [], resolvedConflictIds = [] } = {}) {
  const configSpace = configuredTeamConfigSpace();
  emitWs("shared_config_conflicts_changed", {
    configSpace,
    sourceNodeId,
    entityKeys: [...new Set((entityKeys || []).map(String).filter(Boolean))],
    resolvedConflictIds: [...new Set((resolvedConflictIds || []).map(String).filter(Boolean))],
    conflictCount: syncStore.listConflicts(configSpace).length,
  });
}

function emitDeliveryChanged(changeSetId) {
  const publication = syncStore.publicationStatus(changeSetId);
  if (!publication) return;
  emitWs("shared_config_delivery_changed", {
    changeSetId,
    applied: publication.applied,
    pending: publication.pending,
    offline: publication.offline,
    conflict: publication.conflict,
    failed: publication.failed,
    deliveries: publication.deliveries,
  });
}

export function publishExistingVehicleConfiguration(principal = {}, { fanout = true } = {}) {
  assertPairingAdmin(principal);
  const snapshot = vehicleStore.getVehicleSyncSnapshot();
  const tombstones = vehicleStore.getVehicleSyncTombstones();
  syncStore.setMetric("snapshot-bytes-total", Buffer.byteLength(JSON.stringify(snapshot), "utf8"));
  const configSpace = configuredTeamConfigSpace();
  const originNodeId = currentNodeId();
  const actorUserId = principalId(principal);
  const createdChangeSets = [];
  syncStore.runLanSyncTransaction(() => {
    for (const definition of vehicleStore.getProjectDefs()
      .map((def) => vehicleStore.normalizeTeamProjectDef(def))
      .sort((left, right) => left.id.localeCompare(right.id))) {
      const entityKey = encodeProjectDefKey(definition.id);
      if (syncStore.getEntityOperation(configSpace, "project-definition", entityKey)) continue;
      const payload = {
        projectId: vehicleStore.normalizeVehicleProjectId(
          Object.keys(snapshot.byProject)[0] || "default",
          { required: true },
        ),
        id: definition.id,
        definition,
      };
      const hash = createHash("sha256").update(canonicalJson({
        configSpace,
        originNodeId,
        entityType: "project-definition",
        entityKey,
        payload,
      })).digest("hex");
      const op = syncStore.createLocalOperation({
        configSpace,
        changeSetId: `baseline-project-def-${hash.slice(0, 20)}`,
        originNodeId,
        entityType: "project-definition",
        entityKey,
        action: "set",
        baseRevision: "0",
        context: syncStore.currentVersionVector(configSpace),
        actorUserId,
        payload,
        createdAt: Number(snapshot.revision) || Date.now(),
      });
      op.opId = `baseline-project-def-${hash}`;
      syncStore.sealChangeSet([op]);
      syncStore.insertOperation(op, "applied");
      syncStore.createPendingDeliveries(op.changeSetId, configSpace, originNodeId);
      createdChangeSets.push(op.changeSetId);
    }
    for (const projectId of Object.keys(snapshot.byProject).sort()) {
      for (const flavor of Object.keys(snapshot.byProject[projectId]).sort()) {
        const entityKey = encodeEntityKey(projectId, flavor);
        if (syncStore.getEntityOperation(configSpace, "vehicle", entityKey)) continue;
        const payload = { projectId, flavor, mapping: snapshot.byProject[projectId][flavor] };
        const hash = createHash("sha256").update(canonicalJson({
          configSpace,
          originNodeId,
          entityType: "vehicle",
          entityKey,
          payload,
        })).digest("hex");
        const op = syncStore.createLocalOperation({
          configSpace,
          changeSetId: `baseline-${hash.slice(0, 24)}`,
          originNodeId,
          entityType: "vehicle",
          entityKey,
          action: "set",
          baseRevision: "0",
          context: syncStore.currentVersionVector(configSpace),
          actorUserId,
          payload,
          createdAt: Number(snapshot.revision) || Date.now(),
        });
        op.opId = `baseline-${hash}`;
        syncStore.sealChangeSet([op]);
        syncStore.insertOperation(op, "applied");
        syncStore.createPendingDeliveries(op.changeSetId, configSpace, originNodeId);
        createdChangeSets.push(op.changeSetId);
      }
    }
    for (const tombstone of tombstones) {
      const entityKey = encodeEntityKey(tombstone.projectId, tombstone.flavor);
      if (syncStore.getEntityOperation(configSpace, "vehicle", entityKey)) continue;
      const payload = {
        projectId: tombstone.projectId,
        flavor: tombstone.flavor,
        mapping: null,
      };
      const hash = createHash("sha256").update(canonicalJson({
        configSpace,
        originNodeId,
        entityType: "vehicle",
        entityKey,
        action: "delete",
        payload,
        legacyOpId: tombstone.legacyOpId,
      })).digest("hex");
      const op = syncStore.createLocalOperation({
        configSpace,
        changeSetId: `baseline-delete-${hash.slice(0, 24)}`,
        originNodeId,
        entityType: "vehicle",
        entityKey,
        action: "delete",
        baseRevision: "0",
        context: syncStore.currentVersionVector(configSpace),
        actorUserId,
        payload,
        createdAt: tombstone.createdAt,
      });
      op.opId = `baseline-delete-${hash}`;
      syncStore.sealChangeSet([op]);
      syncStore.insertOperation(op, "applied");
      syncStore.createPendingDeliveries(op.changeSetId, configSpace, originNodeId);
      createdChangeSets.push(op.changeSetId);
    }
    if (createdChangeSets.length) {
      addAudit({
        id: `${originNodeId}-${Date.now()}-${randomBytes(4).toString("hex")}`,
        ts: Date.now(),
        ip: "",
        actor: principal?.name || actorUserId,
        role: principal?.role || "",
        action: "车型配置.首次自动建组并发布现有配置",
        target: configSpace,
        before: null,
        after: { operations: createdChangeSets.length },
        node: originNodeId,
      });
    }
  });
  if (fanout) {
    for (const changeSetId of createdChangeSets) fanoutChangeSet(changeSetId);
  }
  return { created: createdChangeSets.length, changeSetIds: createdChangeSets };
}

export function lanSyncAdvertisement(base = {}) {
  const identity = getLanSyncIdentity();
  const lanSyncGroupId = configuredLanSyncGroupId();
  const lanSyncRequestId = String(base.lanSyncRequestId || "").trim().slice(0, 160);
  const data = {
    nodeId: currentNodeId(),
    host: String(base.host || ""),
    protocolVersion: PROTOCOL_VERSION,
    schemaVersion: SCHEMA_VERSION,
    configSpaces: [configuredTeamConfigSpace()],
    certificateFingerprint: identity.fingerprint,
    timestamp: Number(base.ts) || Date.now(),
    ...(lanSyncGroupId ? { lanSyncGroupId } : {}),
    ...(lanSyncRequestId ? { lanSyncRequestId } : {}),
  };
  return {
    protocolVersion: PROTOCOL_VERSION,
    schemaVersion: SCHEMA_VERSION,
    lanSyncNodeId: data.nodeId,
    certificateFingerprint: identity.fingerprint,
    publicKey: identity.publicKey,
    configSpaces: data.configSpaces,
    lanSyncGroupId,
    ...(lanSyncRequestId ? { lanSyncRequestId } : {}),
    advertisementSignature: signLanSyncValue(data),
  };
}

function advertisementSigningData(info = {}) {
  const lanSyncGroupId = String(info.lanSyncGroupId || "").trim().slice(0, 128);
  const lanSyncRequestId = String(info.lanSyncRequestId || "").trim().slice(0, 160);
  return {
    nodeId: String(info.lanSyncNodeId || info.nodeId || info.id || ""),
    host: String(info.host || ""),
    protocolVersion: Number(info.protocolVersion) || 0,
    schemaVersion: Number(info.schemaVersion) || 0,
    configSpaces: Array.isArray(info.configSpaces) ? info.configSpaces : [],
    certificateFingerprint: String(info.certificateFingerprint || ""),
    timestamp: Number(info.ts) || 0,
    ...(lanSyncGroupId ? { lanSyncGroupId } : {}),
    ...(lanSyncRequestId ? { lanSyncRequestId } : {}),
  };
}

export function validateLanSyncDiscoverySolicitation(info = {}) {
  const requestId = String(info.lanSyncRequestId || "").trim();
  if (!/^[a-f0-9]{24,64}$/i.test(requestId)) return null;
  if (Number(info.protocolVersion) !== PROTOCOL_VERSION || Number(info.schemaVersion) !== SCHEMA_VERSION) return null;
  const publicKey = String(info.publicKey || "").trim();
  if (!publicKey) return null;
  let fingerprint;
  // quality-gate-ignore STATE-SILENT-EMPTY: malformed discovery public keys must fail closed as invalid signed solicitations.
  try { fingerprint = fingerprintPublicKey(publicKey); } catch { return null; }
  const peerNodeId = String(info.lanSyncNodeId || info.nodeId || info.id || "").trim();
  if (peerNodeId !== `lan-${fingerprint.slice(0, 24)}`) return null;
  if (fingerprint !== String(info.certificateFingerprint || "")) return null;
  const spaces = Array.isArray(info.configSpaces) ? info.configSpaces.map(String) : [];
  if (!spaces.includes(configuredTeamConfigSpace())) return null;
  if (!normalizeLanSyncInvitationOrigin(info.host)) return null;
  if (!verifyLanSyncValue(advertisementSigningData(info), info.advertisementSignature, publicKey)) return null;
  return { requestId, nodeId: peerNodeId };
}

export function verifyLanSyncAdvertisement(info = {}) {
  const peerNodeId = String(info.lanSyncNodeId || info.nodeId || info.id || "");
  const member = syncStore.getMember(peerNodeId);
  if (!member || member.state !== "active") return false;
  if (member.certificateFingerprint !== info.certificateFingerprint) return false;
  const localGroupId = configuredLanSyncGroupId();
  const advertisedGroupId = String(info.lanSyncGroupId || "").trim();
  if (!localGroupId || advertisedGroupId !== localGroupId) return false;
  const data = advertisementSigningData(info);
  return verifyLanSyncValue(data, info.advertisementSignature, member.publicKey);
}

export function validateLanSyncDiscoveryAdvertisement(info = {}) {
  const peerNodeId = String(info.lanSyncNodeId || info.nodeId || info.id || "").trim();
  if (!peerNodeId || peerNodeId === currentNodeId()) return null;
  if (String(info.syncMode || "").trim().toLowerCase() !== "peer") return null;
  if (Number(info.protocolVersion) !== PROTOCOL_VERSION || Number(info.schemaVersion) !== SCHEMA_VERSION) return null;
  const publicKey = String(info.publicKey || "").trim();
  if (!publicKey) return null;
  let fingerprint;
  // quality-gate-ignore STATE-SILENT-EMPTY: 畸形 UDP 公钥必须按不可信发现包静默丢弃，不能升级为用户页面错误态。
  try { fingerprint = fingerprintPublicKey(publicKey); } catch { return null; }
  if (fingerprint !== String(info.certificateFingerprint || "")) return null;
  if (peerNodeId !== `lan-${fingerprint.slice(0, 24)}`) return null;
  const lanSyncGroupId = String(info.lanSyncGroupId || "").trim().slice(0, 128);
  if (!/^lan-group-[0-9a-f-]{36}$/i.test(lanSyncGroupId)) return null;
  const spaces = Array.isArray(info.configSpaces) ? info.configSpaces.map(String) : [];
  if (!spaces.includes(configuredTeamConfigSpace())) return null;
  if (lanSyncGroupId !== automaticLanSyncGroupId(configuredTeamConfigSpace())) return null;
  if (!verifyLanSyncValue(advertisementSigningData(info), info.advertisementSignature, publicKey)) return null;
  const host = normalizeLanSyncInvitationOrigin(info.host);
  if (!host) return null;
  return {
    protocolVersion: PROTOCOL_VERSION,
    schemaVersion: SCHEMA_VERSION,
    nodeId: peerNodeId,
    nodeName: String(info.name || info.nodeName || peerNodeId).trim().slice(0, 160),
    publicKey,
    certificateFingerprint: fingerprint,
    configSpaces: spaces,
    lanSyncGroupId,
    host,
  };
}

/**
 * 管理员第一次正常发布车型配置即自动建组。其后同一二层局域网内的 Gateway 会依据
 * 带设备签名和 groupId 的广播自动加入；加入动作只建立成员关系，不播种本机快照。
 */
export function autoJoinLanSyncDiscovery(info = {}, { connectionHost = "" } = {}) {
  const advertisedCandidate = validateLanSyncDiscoveryAdvertisement(info);
  if (!advertisedCandidate) return { joined: false, reason: "invalid-advertisement" };
  const routedHost = connectionHost
    ? normalizeLanSyncInvitationOrigin(connectionHost)
    : advertisedCandidate.host;
  if (!routedHost) return { joined: false, reason: "invalid-connection-host" };
  const candidate = { ...advertisedCandidate, host: routedHost };
  if (requestedLanSyncMode() === "receive-only") return { joined: false, reason: "receive-only" };
  const localGroupId = configuredLanSyncGroupId();
  if (localGroupId && localGroupId !== candidate.lanSyncGroupId) {
    return { joined: false, reason: "different-group" };
  }
  const existing = syncStore.getMember(candidate.nodeId);
  if (existing?.state === "active" && localGroupId === candidate.lanSyncGroupId) {
    return { joined: false, reason: "already-member", member: existing };
  }
  try {
    // 没有组身份的节点可能残留旧版独立发布历史。自动加入前清空传输日志，
    // 但保留本机物化配置，确保它只接收而不会把陈旧操作反向带入新组。
    let discardedSyncState = null;
    if (!localGroupId) {
      stopLanSync();
      discardedSyncState = syncStore.resetLanSyncStateForJoin();
    }
    const requiresRestart = configurePeerSync(
      configuredTeamConfigSpace(),
      candidate.host,
      { groupId: candidate.lanSyncGroupId },
    );
    if (requiresRestart) restartLanSyncRuntime();
    const member = pairMember(candidate);
    addAudit({
      id: `${currentNodeId()}-${Date.now()}-${randomBytes(4).toString("hex")}`,
      ts: Date.now(),
      ip: "",
      actor: "system-lan-discovery",
      role: "system",
      action: "车型配置.自动加入局域网同步组",
      target: configuredTeamConfigSpace(),
      before: null,
      after: {
        peerNodeId: member.nodeId,
        groupId: candidate.lanSyncGroupId,
        discardedSyncState,
      },
      node: currentNodeId(),
    });
    lanSyncDiagnostic("info", "auto_join_discovered_group", {
      peerNodeId: candidate.nodeId,
      host: candidate.host,
      groupId: candidate.lanSyncGroupId,
    });
    return { joined: true, member, seededOperations: 0, discardedSyncState };
  } catch (error) {
    lanSyncDiagnostic("warn", "auto_join_discovered_group_failed", {
      peerNodeId: candidate.nodeId,
      host: candidate.host,
      error: error.message,
    });
    return { joined: false, reason: "join-failed", error: error.message };
  }
}

export function lanSyncDiagnostics() {
  const configSpace = configuredTeamConfigSpace();
  const tls = lanSyncTlsConfig();
  const policy = lanSyncTransportPolicy();
  return {
    protocolVersion: PROTOCOL_VERSION,
    schemaVersion: SCHEMA_VERSION,
    node: localPairingBundle(),
    syncMode: policy.effectiveMode,
    requestedSyncMode: policy.requestedMode,
    runtimeScope: vehicleStore.devbenchSyncScope(),
    teamConfigSpace: configSpace,
    transport: {
      mtls: {
        enabled: tls.enabled,
        required: tls.required,
        serverNameConfigured: !!tls.serverName,
      },
      insecureTransportAllowed: policy.insecureTransportAllowed,
      applicationEncryption: policy.applicationEncryption ? "X25519+AES-256-GCM" : "disabled",
      blockedByTransport: policy.blockedByTransport,
      diagnosticLog: lanSyncDiagnosticSettings(),
    },
    vector: syncStore.currentVersionVector(configSpace),
    members: listLanSyncMembers(),
    conflicts: syncStore.listConflicts(configSpace),
    metrics: {
      lan_sync_connected_peers: [...connections.values()].filter((state) => state.authenticated).length,
      ...syncStore.lanSyncMetrics(configSpace),
      lan_sync_compacted_ops_total: syncStore.metricValue("compacted-ops-total"),
    },
  };
}

export function compactLanSyncOperations() {
  const config = getConfig().lanSync?.compaction || {};
  const result = syncStore.compactOperationLog(configuredTeamConfigSpace(), {
    retentionDays: Number(config.retentionDays) || 30,
  });
  lanSyncDiagnostic("info", "operation_log_compacted", {
    deleted: result.deleted,
    retentionDays: result.retentionDays,
  });
  return result;
}

export function initLanSync() {
  if (initialized) return;
  initialized = true;
  stopping = false;
  const policy = lanSyncTransportPolicy();
  if (policy.effectiveMode === "disabled") return;
  try {
    getLanSyncIdentity();
    if (getConfig().lanSync?.compaction?.enabled !== false) compactLanSyncOperations();
    lanSyncDiagnostic("info", "service_initialized", {
      nodeId: currentNodeId(),
      syncMode: configuredLanSyncMode(),
      mtlsEnabled: lanSyncTlsConfig().enabled,
      applicationEncryption: "X25519+AES-256-GCM",
    });
  } catch (error) {
    log("system", "error", "lan-sync", `初始化失败：${error.message}`);
    return;
  }
  retryTimer = setInterval(() => {
    retryConnectedRanges();
  }, 30_000);
  retryTimer.unref?.();
  heartbeatTimer = setInterval(() => {
    const now = Date.now();
    for (const state of connections.values()) {
      if (!state.authenticated) continue;
      if (now - Number(state.lastPongAt || 0) > 75_000) {
        try { state.ws.terminate(); } catch {}
        continue;
      }
      try { state.ws.ping(); } catch {}
    }
  }, 25_000);
  heartbeatTimer.unref?.();
  if (getConfig().lanSync?.compaction?.enabled !== false) {
    compactionTimer = setInterval(() => {
      try { compactLanSyncOperations(); } catch (error) {
        lanSyncDiagnostic("error", "compaction_failed", { error: error.message });
      }
    }, 24 * 60 * 60_000);
    compactionTimer.unref?.();
  }
  for (const member of syncStore.listMembers(configuredTeamConfigSpace())) {
    if (member.state === "active" && member.host) {
      observeLanSyncPeer({
        id: member.nodeId,
        host: member.host,
        teamConfigSpace: configuredTeamConfigSpace(),
      });
    }
  }
}

export function stopLanSync() {
  stopping = true;
  if (retryTimer) clearInterval(retryTimer);
  retryTimer = null;
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  heartbeatTimer = null;
  if (compactionTimer) clearInterval(compactionTimer);
  compactionTimer = null;
  for (const timer of reconnectTimers.values()) clearTimeout(timer);
  reconnectTimers.clear();
  for (const state of connections.values()) {
    try { state.ws.close(1001, "gateway stopping"); } catch {}
  }
  connections.clear();
  connecting.clear();
  initialized = false;
}
