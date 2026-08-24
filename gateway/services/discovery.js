/**
 * 局域网服务发现 —— 多服务端 + 客户端选服务端 + 算力感知。
 * - UDP socket 持续异步监听；启动、IP/拓扑变化时立即广播，90s 低频兜底。
 * - 手动 peer 仅在 LAN WebSocket 断线时按指数退避执行 HTTP 探活。
 * - 算力 = maxConcurrent - 运行中 = 还能开几个故事点；满了客户端不可选。
 */
import dgram from "dgram";
import os from "os";
import { randomBytes } from "crypto";
import { getConfig, updateConfig } from "./config.js";
import { proxyHealth } from "./claude-proxy.js";
import { configuredNodeDisplayName } from "./node-name.js";
import { getSharedVersion, getSharedBundle, applySharedBundle } from "./devbench/store.js";
import {
  addAudit,
  maxAuditTs,
  mergeAdminUser,
  upsertFeedback,
  maxFeedbackUpdated,
  mergeUserData,
  maxUserDataUpdated,
  mergeFeishuProjectSyncState,
} from "../db/sqlite.js";
import { emitWs, log } from "./logger.js";
import {
  autoJoinLanSyncDiscovery,
  configuredLanSyncMode,
  configuredTeamConfigSpace,
  isLanSyncPeerOnline,
  lanSyncAdvertisement,
  normalizeLanSyncInvitationOrigin,
  observeLanSyncPeer,
  validateLanSyncDiscoverySolicitation,
  verifyLanSyncAdvertisement,
} from "./lan-sync/index.js";
import {
  configuredPeerOutboundM2MToken,
  isTrustedPeerOrigin,
  normalizeHttpOrigin,
} from "./m2m-auth.js";

const DISCOVERY_BROADCAST_INTERVAL_MS = Math.max(60_000, Math.min(120_000,
  Number(process.env.DEVBENCH_DISCOVERY_BROADCAST_INTERVAL_MS) || 90_000));
const TTL_MS = DISCOVERY_BROADCAST_INTERVAL_MS * 3;
const PEER_METADATA_INTERVAL_MS = Math.max(
  5_000,
  Number(process.env.DEVBENCH_PEER_METADATA_INTERVAL_MS) || 60_000,
);
const PEER_RECONCILE_INTERVAL_MS = Math.max(
  30_000,
  Number(process.env.DEVBENCH_PEER_RECONCILE_INTERVAL_MS) || 5 * 60_000,
);
const PEER_EVENT_RECONCILE_DEBOUNCE_MS = Math.max(
  500,
  Number(process.env.DEVBENCH_PEER_EVENT_RECONCILE_DEBOUNCE_MS) || 10_000,
);
const PEER_BACKOFF_BASE_MS = 8000;
const PEER_BACKOFF_MAX_MS = 5 * 60 * 1000;
const PEER_BACKOFF_MAX_ENTRIES = 256;
const registry = new Map(); // id -> { info, lastSeen, via:"udp"|"manual"|"seed" }
const discoverySeedStates = new Map(); // origin -> latest bounded bootstrap state
const feishuMappingPeerWatermarks = new Map(); // peerKey -> highest replicated_at fetched from that peer
const feishuMappingPeerFullSyncAt = new Map(); // peerKey -> last full scan time
const sharedPeerVersions = new Map(); // peerKey -> last sharedVersion fetched from that peer
let sock = null, broadcastTimer = null, peerTimer = null, peerMetadataTimer = null, peerEventTimer = null;
const announcementTimers = new Set();
const pendingSharedPeers = new Map();
const handledLanSyncSolicitations = new Map();
let lastPublishedServerState = "";

function splitDiscoverySeedList(value) {
  return String(value || "")
    .split(/[\s,;]+/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

/**
 * Deployment-owned rendezvous origins. These are deliberately separate from
 * servers.peers: a discovery seed may only serve the public signed node
 * advertisement and never becomes trusted for audit/admin/user-data M2M APIs.
 */
export function configuredDiscoverySeeds(config = getConfig(), environment = process.env) {
  const configured = Array.isArray(config.servers?.discoverySeeds)
    ? config.servers.discoverySeeds
    : [];
  const fromEnvironment = [
    ...splitDiscoverySeedList(environment.AIEFFICIENCY_DISCOVERY_SEEDS),
    ...splitDiscoverySeedList(environment.DEVBENCH_DISCOVERY_SEEDS),
  ];
  return [...new Set([...configured, ...fromEnvironment]
    .map(normalizeLanSyncInvitationOrigin)
    .filter(Boolean))];
}

function isDiscoverySeedOrigin(value, config = getConfig()) {
  const origin = normalizeLanSyncInvitationOrigin(value);
  return !!origin && configuredDiscoverySeeds(config).includes(origin);
}

function recordDiscoverySeedState(origin, result = {}) {
  const normalized = normalizeLanSyncInvitationOrigin(origin);
  if (!normalized) return;
  const now = Date.now();
  const previous = discoverySeedStates.get(normalized) || {};
  const reachable = result.reachable === true;
  const joined = result.joined === true || ["already-member", "already-online"].includes(result.reason);
  discoverySeedStates.set(normalized, {
    origin: normalized,
    reachable,
    joined,
    reason: String(result.reason || "").slice(0, 80),
    nodeId: String(result.nodeId || "").slice(0, 160),
    nodeName: String(result.nodeName || "").slice(0, 160),
    lastAttemptAt: now,
    lastSuccessAt: reachable ? now : Number(previous.lastSuccessAt || 0),
  });
}

export function discoveryBootstrapStatus(config = getConfig()) {
  const seeds = configuredDiscoverySeeds(config);
  const states = seeds.map((origin) => discoverySeedStates.get(origin) || {
    origin,
    reachable: false,
    joined: false,
    reason: "pending",
    lastAttemptAt: 0,
    lastSuccessAt: 0,
  });
  const connectedSeeds = states.filter((state) => isLanSyncPeerOnline({ host: state.origin })).length;
  const reachableSeeds = states.filter((state) => state.reachable).length;
  const joinedSeeds = states.filter((state) => state.joined).length;
  const attemptedSeeds = states.filter((state) => state.lastAttemptAt > 0).length;
  const status = connectedSeeds > 0
    ? "connected"
    : (joinedSeeds > 0 || reachableSeeds > 0
      ? "joining"
      : (seeds.length === 0 ? "same-subnet-only" : (attemptedSeeds > 0 ? "retrying" : "discovering")));
  return {
    enabled: seeds.length > 0,
    status,
    seedCount: seeds.length,
    attemptedSeeds,
    reachableSeeds,
    joinedSeeds,
    connectedSeeds,
    lastAttemptAt: Math.max(0, ...states.map((state) => Number(state.lastAttemptAt || 0))),
    lastSuccessAt: Math.max(0, ...states.map((state) => Number(state.lastSuccessAt || 0))),
  };
}

function createSingleFlightRunner(task) {
  let inFlight = null;
  return (...args) => {
    if (inFlight) return inFlight;
    inFlight = Promise.resolve()
      .then(() => task(...args))
      .finally(() => { inFlight = null; });
    return inFlight;
  };
}

export function __testCreateSingleFlightRunner(task) {
  return createSingleFlightRunner(task);
}

function createPeerBackoffTracker({
  baseMs = PEER_BACKOFF_BASE_MS,
  maxMs = PEER_BACKOFF_MAX_MS,
  maxEntries = PEER_BACKOFF_MAX_ENTRIES,
  now = () => Date.now(),
} = {}) {
  const entries = new Map();
  const keyOf = (value) => normalizeHost(value);
  const trimFor = (key) => {
    if (entries.has(key) || entries.size < maxEntries) return;
    let oldestKey = "";
    let oldestAt = Number.POSITIVE_INFINITY;
    for (const [candidate, state] of entries) {
      if (Number(state.lastFailureAt || 0) < oldestAt) {
        oldestKey = candidate;
        oldestAt = Number(state.lastFailureAt || 0);
      }
    }
    if (oldestKey) entries.delete(oldestKey);
  };
  return {
    canAttempt(value) {
      const key = keyOf(value);
      if (!key) return false;
      return Number(entries.get(key)?.nextAttemptAt || 0) <= Number(now());
    },
    failure(value) {
      const key = keyOf(value);
      if (!key) return null;
      trimFor(key);
      const at = Number(now());
      const failures = Math.min(31, Number(entries.get(key)?.failures || 0) + 1);
      const delayMs = Math.min(maxMs, baseMs * (2 ** Math.min(30, failures - 1)));
      const state = { failures, delayMs, lastFailureAt: at, nextAttemptAt: at + delayMs };
      entries.set(key, state);
      return { ...state };
    },
    success(value) {
      entries.delete(keyOf(value));
    },
    clear() {
      entries.clear();
    },
    inspect(value) {
      const state = entries.get(keyOf(value));
      return state ? { ...state } : null;
    },
    size() {
      return entries.size;
    },
  };
}

export function __testCreatePeerBackoffTracker(options) {
  return createPeerBackoffTracker(options);
}

function createPeerJsonFetcher(fetchImpl, backoff) {
  return async (base, requestPath, timeoutMs = 5000) => {
    const peer = normalizeHost(base);
    if (!peer || !backoff.canAttempt(peer)) {
      return { attempted: false, available: false, skipped: true };
    }
    let response;
    try {
      response = await fetchImpl(peer + requestPath, {
        redirect: "error",
        signal: AbortSignal.timeout(Math.max(1, Number(timeoutMs) || 5000)),
      });
    } catch {
      return {
        attempted: true,
        available: false,
        skipped: false,
        backoff: backoff.failure(peer),
      };
    }
    // 任意 HTTP 响应都证明主机可达；旧 Gateway 缺少某个新接口或返回非 JSON
    // 时不能把整台主机放进退避，避免其它兼容接口被连带暂停。
    backoff.success(peer);
    try {
      const data = await response.json();
      return { attempted: true, available: true, response, data };
    } catch {
      return { attempted: true, available: true, response, data: null, invalidJson: true };
    }
  };
}

export function __testCreatePeerJsonFetcher(fetchImpl, backoff) {
  return createPeerJsonFetcher(fetchImpl, backoff);
}

function shouldProbeManualPeer({ lanSyncOnline = false } = {}) {
  return lanSyncOnline !== true;
}

export function __testShouldProbeManualPeer(state) {
  return shouldProbeManualPeer(state);
}

const peerBackoff = createPeerBackoffTracker();
const discoveryPeerBackoff = createPeerBackoffTracker();
const fetchPeerJson = createPeerJsonFetcher((url, options = {}) => {
  const current = getConfig();
  const parsed = new URL(String(url || ""));
  const targetOrigin = normalizeHttpOrigin(parsed.origin);
  if (
    parsed.username
    || parsed.password
    || parsed.hash
    || !targetOrigin
    || !isTrustedPeerOrigin(targetOrigin, current)
  ) {
    throw new Error("peer request target is no longer trusted");
  }
  const token = configuredPeerOutboundM2MToken(current);
  if (!token) throw new Error("peer M2M token is required");
  const headers = new Headers(options.headers || {});
  headers.delete("Authorization");
  headers.set("Authorization", `Bearer ${token}`);
  return fetch(url, { ...options, headers });
}, peerBackoff);

// /api/discovery/info 是公开的签名节点公告。手动 peer 首次探测不能依赖尚未
// 建立的 M2M 共享口令，否则“无需额外设置”的加密 LAN 自动入组永远无法启动。
// 这里仍只允许管理员已持久化到 trusted peers 的固定 discovery 路径；审计、
// 用户数据与 shared-bundle 等敏感接口继续使用上方强制 M2M token 的客户端。
const fetchPeerDiscoveryInfo = createPeerJsonFetcher((url, options = {}) => {
  const current = getConfig();
  const parsed = new URL(String(url || ""));
  const targetOrigin = normalizeHttpOrigin(parsed.origin);
  if (parsed.username
    || parsed.password
    || parsed.hash
    || parsed.search
    || parsed.pathname !== "/api/discovery/info"
    || !targetOrigin
    || (!isTrustedPeerOrigin(targetOrigin, current)
      && !isDiscoverySeedOrigin(targetOrigin, current))) {
    throw new Error("discovery peer request target is no longer trusted");
  }
  const headers = new Headers(options.headers || {});
  headers.delete("Authorization");
  return fetch(url, { ...options, headers });
}, discoveryPeerBackoff);

// 列出本机所有非内网 IPv4（多网卡时供用户选定对外地址）
export function listLocalIps() {
  const out = [];
  for (const [iface, ifs] of Object.entries(os.networkInterfaces())) {
    for (const i of ifs || []) if (i.family === "IPv4" && !i.internal) out.push({ address: i.address, iface });
  }
  return out;
}
// 对外 IP：优先用户在设置里选定的 servers.advertiseIp（且当前仍存在），否则取第一个非内网 IPv4
function ipRank(item) {
  const ip = String(item?.address || "");
  const iface = String(item?.iface || "").toLowerCase();
  let score = 0;
  if (/wlan|wi-?fi|wireless|无线/.test(iface)) score += 50;
  if (/ethernet|以太网/.test(iface)) score += 20;
  if (/virtual|vbox|virtualbox|vmware|hyper-v|vethernet|docker|loopback|bluetooth|蓝牙/.test(iface)) score -= 80;
  if (/^192\.168\.56\./.test(ip)) score -= 100; // VirtualBox host-only 默认网段，通常不是局域网对外地址
  if (/^169\.254\./.test(ip)) score -= 100;
  if (/^172\.(1[7-9]|2\d|3[01])\./.test(ip)) score -= 25; // Docker/容器网段常见范围
  if (/^10\./.test(ip) || /^172\.16\./.test(ip) || /^192\.168\./.test(ip)) score += 10;
  return score;
}
let localIpCache = { configured: "", value: "", expiresAt: 0 };
function localIp() {
  const adv = String(getConfig().servers?.advertiseIp || "").trim();
  const now = Date.now();
  if (localIpCache.value && localIpCache.configured === adv && localIpCache.expiresAt > now) {
    return localIpCache.value;
  }
  const all = listLocalIps();
  const value = adv && all.some((x) => x.address === adv)
    ? adv
    : all.slice().sort((a, b) => ipRank(b) - ipRank(a))[0]?.address || "127.0.0.1";
  localIpCache = { configured: adv, value, expiresAt: now + 30_000 };
  return value;
}
function httpPort() { return Number(process.env.PORT) || 3001; }
function role() { return String(process.env.ROLE || getConfig().role || "standalone").toLowerCase(); }
export function resolveLanSyncMode(config = getConfig()) {
  return configuredLanSyncMode(config);
}
export function __testResolveSyncScope(explicitScope, profile) {
  const explicit = String(explicitScope || "").trim().slice(0, 160);
  if (explicit) return explicit;
  const profileName = String(profile || "").trim();
  if (!profileName || profileName.toLowerCase() === "production") return "production";
  return `profile:${profileName}`.slice(0, 160);
}
export function __testNormalizeAdvertisedSyncScope(value) {
  return String(value || "production").trim().slice(0, 160) || "production";
}
function localSyncScope() {
  return __testResolveSyncScope(process.env.DEVBENCH_SYNC_SCOPE, process.env.AIEFFICIENCY_PROFILE);
}
export function localTeamConfigSpace(config = getConfig()) {
  return configuredTeamConfigSpace(config);
}
function normalizeHost(host) { return normalizeHttpOrigin(host); }
function serverKey(info, host = "") { return `${String(info?.id || "")}|${normalizeHost(host || info?.host)}`; }
function sameServer(a, b) {
  return String(a?.id || "") === String(b?.id || "") && normalizeHost(a?.host) === normalizeHost(b?.host);
}
function peerHostname(host) {
  try {
    return new URL(normalizeHost(host)).hostname.toLowerCase();
  } catch {
    return normalizeHost(host).toLowerCase();
  }
}
function replicationPeerKey(info) {
  return [
    String(info?.id || ""),
    peerHostname(info?.host),
    __testNormalizeAdvertisedSyncScope(info?.syncScope),
  ].join("|");
}
function dedupeReplicationPeers(servers = [], me = null) {
  const selected = new Map();
  for (const server of servers) {
    if (!server?.host || (me && sameServer(server, me))) continue;
    const key = replicationPeerKey(server);
    const current = selected.get(key);
    if (!current
      || Number(server.sharedVersion || 0) > Number(current.sharedVersion || 0)
      || (Number(server.sharedVersion || 0) === Number(current.sharedVersion || 0)
        && Number(server.ts || 0) > Number(current.ts || 0))) {
      selected.set(key, server);
    }
  }
  return [...selected.values()];
}

export function nodeId() {
  const cfg = getConfig();
  let id = cfg.servers?.nodeId;
  if (!id) { id = randomBytes(6).toString("hex"); updateConfig({ servers: { ...(cfg.servers || {}), nodeId: id } }); }
  return id;
}
function nodeName() {
  const cfg = getConfig();
  return configuredNodeDisplayName(cfg, os.hostname());
}

// 本机节点信息（含算力）
export function selfInfo({ lanSyncRequestId = "" } = {}) {
  const cfg = getConfig();
  const r = role();
  const h = proxyHealth();
  const max = h.maxConcurrent || 0, active = h.busy || 0;
  const free = Math.max(0, max - active);
  // 算力两部分：① 故事点槽(free) ② Claude 用量/剩余(token 额度)。任一不足即"满/不可连"。
  const clientProxyEnabled = !!cfg.claudeProxyClient?.enabled;
  const isServerRole = (r === "server" || r === "standalone") && !clientProxyEnabled;
  const syncMode = resolveLanSyncMode(cfg);
  const full = free <= 0 || h.quotaExhausted;
  const info = {
    id: nodeId(), name: nodeName(), role: r,
    host: `${cfg.lanSync?.mtls?.enabled === true ? "https" : "http"}://${localIp()}:${httpPort()}`,
    isServer: isServerRole,
    claudeEnabled: isServerRole && !!cfg.claudeProxy?.enabled,
    backend: h.backend || "cli",
    capacity: {
      maxConcurrent: max, active, free,                          // 故事点槽
      tokensUsedToday: h.tokensUsedToday, tokenBudget: h.tokenBudget, tokensRemaining: h.tokensRemaining, // Claude 用量
      quotaExhausted: h.quotaExhausted,
    },
    full,
    configPeer: syncMode === "peer",
    syncMode,
    syncScope: localSyncScope(),
    teamConfigSpace: localTeamConfigSpace(cfg),
    sharedVersion: getSharedVersion(),
    ts: Date.now(),
    ...(lanSyncRequestId ? { lanSyncRequestId: String(lanSyncRequestId).slice(0, 160) } : {}),
  };
  // 显式兼容期开关把本机降级公告为旧节点；关闭后只允许签名增量协议，
  // 未配对的新节点不会再回退拉取 shared-bundle。
  return cfg.lanSync?.legacyCompatibility === true
    ? info
    : { ...info, ...lanSyncAdvertisement(info) };
}

async function reconcileSharedConfigFromPeer(s, currentSyncScope) {
  if (!(s?.configPeer ?? s?.isServer) || s.via === "self") return false;
  // 已配对的新协议节点通过签名 WebSocket 增量通道复制车型配置；不再定时拉取整包。
  if (Number(s.protocolVersion) >= 1) {
    if (s.syncMode !== "disabled" && verifyLanSyncAdvertisement(s)) observeLanSyncPeer(s);
    return false;
  }
  if (getConfig().lanSync?.legacyCompatibility !== true) return false;
  // 测试/验收节点只能与同一隔离作用域复制共享配置；旧生产节点未携带字段时按
  // production 兼容，避免测试夹具再次进入真实 AI 学习和仓库定义。
  const sharedScopeMatches = __testNormalizeAdvertisedSyncScope(s.syncScope) === currentSyncScope;
  if (!sharedScopeMatches) return false;
  const base = String(s.host || "").replace(/\/+$/, "");
  if (!base || !peerBackoff.canAttempt(base)) return false;
  const key = replicationPeerKey(s);
  const peerSharedVersion = Number(s.sharedVersion || 0);
  if (peerSharedVersion <= Number(sharedPeerVersions.get(key) || 0)) return false;
  const request = await fetchPeerJson(base, "/api/discovery/shared-bundle");
  if (!request.available) return false;
  const d = request.data;
  if (!d?.ok || !d.data) return false;
  const result = applySharedBundle(d.data);
  if (result.applied) log("system", "info", "discovery", `已从「${s.name}」同步共享配置 v${d.data.version}`);
  if (!result?.ok) {
    log("system", "warn", "discovery", `从「${s.name}」应用共享配置失败，将保留重试状态：${result?.error || "未知错误"}`);
    return false;
  }
  sharedPeerVersions.set(key, peerSharedVersion);
  return true;
}

const runSharedConfigReconcile = createSingleFlightRunner(async (servers, me) => {
  if (!(me?.configPeer ?? me?.isServer)) return;
  const currentSyncScope = localSyncScope();
  for (const server of servers || []) {
    if (sameServer(server, me)) continue;
    await reconcileSharedConfigFromPeer(server, currentSyncScope);
  }
});

// 服务端间共享配置复制（pull 式 gossip）：本机为服务端时，从版本更新的对端服务端拉取并应用
async function reconcileReplicatedData(me = selfInfo(), { includeShared = true } = {}) {
  // 管理员、审计、反馈等既有 gossip 仍只属于 AI 服务节点；车型 LAN 同步
  // 由独立的 configPeer/WebSocket 通道处理，不能用它关闭这些既有复制链路。
  if (!me.isServer) return;
  const cfg = getConfig();
  const auditSince = Math.max(0, maxAuditTs() - 60000); // 留 1min 缓冲应对时钟漂移；id 去重
  const adminSince = 0; // 管理员名单很小：全量拉取可避免新加 peer 时漏掉远端旧管理员
  const fbSince = Math.max(0, maxFeedbackUpdated() - 60000); // 反馈增量水位（updated_at 新者胜）
  const udSince = Math.max(0, maxUserDataUpdated() - 60000); // devbench 用户数据(任务/Tab)增量水位
  const servers = dedupeReplicationPeers(getServers(me), me);
  if (includeShared) await runSharedConfigReconcile(servers, me);
  for (const s of servers) {
    if (s.via === "self" || !s.isServer) continue;
    if (!isTrustedPeerOrigin(s.host, cfg)) continue;
    const base = normalizeHttpOrigin(s.host);
    if (!base || !peerBackoff.canAttempt(base)) continue;
    // 审计日志（增量拉取，addAudit INSERT OR IGNORE 去重）
    let request = await fetchPeerJson(base, `/api/devbench/audit-since?since=${auditSince}`);
    if (!request.available) continue;
    if (request.data?.ok && Array.isArray(request.data.data)) for (const e of request.data.data) addAudit(e);
    // 管理员名单（增删都同步；删除以 deletedAt tombstone 传播，避免远端复活旧管理员）
    request = await fetchPeerJson(base, `/api/admin/users-since?since=${adminSince}`);
    if (!request.available) continue;
    if (request.data?.ok && Array.isArray(request.data.data)) for (const e of request.data.data) mergeAdminUser(e);
    // 问题反馈（增量拉取，upsertFeedback 按 updated_at 新者胜，幂等）
    request = await fetchPeerJson(base, `/api/feedback/since?since=${fbSince}`);
    if (!request.available) continue;
    if (request.data?.ok && Array.isArray(request.data.data)) for (const e of request.data.data) upsertFeedback(e);
    // devbench 用户数据：只同步任务等共享数据；tabs/closed 是每台设备自己的打开状态，mergeUserData 会忽略
    request = await fetchPeerJson(base, `/api/devbench/userdata-since?since=${udSince}`);
    if (!request.available) continue;
    if (request.data?.ok && Array.isArray(request.data.data)) for (const e of request.data.data) mergeUserData(e);
  }
}

// 飞书工单 / TB 任务映射表只在管理员显式信任的 peers 间复制。
// 接收端保留远端 replicated_at，不在 merge 时 bump，本地随后再被拉取也会因同版本跳过，避免 gossip 回环。
async function reconcileFeishuProjectMappings(me = selfInfo()) {
  const cfg = getConfig();
  if (cfg.feishuProjectSync?.lanSync === false) return;
  const now = Date.now();
  const fullIntervalMs = 10 * 60 * 1000;
  const limit = 5000;
  for (const s of dedupeReplicationPeers(getKnownNodes(me), me)) {
    if (s.via === "self" || sameServer(s, me) || !s.host) continue;
    if (!isTrustedPeerOrigin(s.host, cfg)) continue;
    const base = normalizeHttpOrigin(s.host);
    const key = serverKey(s, base);
    if (!peerBackoff.canAttempt(base)) continue;
    const watermark = Number(feishuMappingPeerWatermarks.get(key) || 0);
    const lastFull = Number(feishuMappingPeerFullSyncAt.get(key) || 0);
    const full = !watermark || now - lastFull > fullIntervalMs;
    const since = full ? 0 : watermark + 1;
    const request = await fetchPeerJson(
      base,
      `/api/feishu-project-sync/records-since?since=${since}&limit=${limit}`,
    );
    if (!request.available) continue;
    const d = request.data;
    if (d?.success && Array.isArray(d.data)) {
      let maxSeen = watermark;
      for (const row of d.data) {
        mergeFeishuProjectSyncState(row);
        maxSeen = Math.max(maxSeen, Number(row.replicatedAt || row.replicated_at || 0));
      }
      if (maxSeen > watermark) feishuMappingPeerWatermarks.set(key, maxSeen);
      if (full && d.data.length < limit) feishuMappingPeerFullSyncAt.set(key, now);
    }
  }
}

function collectRegistryEntries() {
  const now = Date.now();
  const out = [];
  for (const [id, e] of registry) {
    if (now - e.lastSeen > TTL_MS) { registry.delete(id); continue; }
    out.push({ ...e.info, via: e.via, ageMs: now - e.lastSeen });
  }
  return out;
}

// 合并的局域网节点列表（广播 + 手动 + 本机自身）
export function getKnownNodes(me = selfInfo()) {
  const out = collectRegistryEntries();
  if (!out.some((s) => sameServer(s, me))) out.push({ ...me, via: "self", ageMs: 0 });
  return out.sort((a, b) => String(a.name || "").localeCompare(String(b.name || "")));
}

// 合并的服务端列表（广播 + 手动 + 本机自身若为可用服务端）
export function getServers(me = selfInfo()) {
  const out = collectRegistryEntries().filter((s) => s.isServer);
  // 本机若为服务端(含单机standalone)都纳入列表，供配置同步发现；是否"可连接的Claude服务端"由 claudeEnabled 区分
  if (me.isServer && !out.some((s) => sameServer(s, me))) out.push({ ...me, via: "self", ageMs: 0 });
  return out.sort((a, b) => (b.capacity.free - a.capacity.free)); // 空闲多的在前
}

// 浏览器不再高频轮询：本机作为局域网发现观察者，仅在服务端列表/算力发生实质变化时推送 WS 事件。
// 排除每次广播都会变化的 ts/ageMs，避免把 UDP 发现包放大成前端刷新风暴。
function publishServersIfChanged(me = selfInfo()) {
  const servers = getServers(me);
  const state = JSON.stringify(servers.map((s) => ({
    id: s.id,
    name: s.name,
    role: s.role,
    host: s.host,
    claudeEnabled: s.claudeEnabled,
    backend: s.backend,
    capacity: s.capacity,
    full: s.full,
  })));
  if (state === lastPublishedServerState) return false;
  lastPublishedServerState = state;
  emitWs("discovery_servers_changed", { servers, observedAt: Date.now() });
  return true;
}

function broadcastSelf(port, options = {}) {
  if (!sock) return;
  const me = selfInfo(options);
  const buf = Buffer.from(JSON.stringify(me));
  try { sock.send(buf, 0, buf.length, port, "255.255.255.255"); } catch {}
  // 同时观察本机算力变化；服务端自己的 Web 页面也能立即收到状态更新。
  publishServersIfChanged(me);
}

async function announcePeerNow(peer) {
  const target = normalizeHttpOrigin(peer);
  const current = getConfig();
  if (!target || (!isTrustedPeerOrigin(target, current) && !isDiscoverySeedOrigin(target, current))) {
    return false;
  }
  let hostname;
  try { hostname = new URL(target).hostname.replace(/^\[|\]$/g, ""); } catch { return false; }
  const port = Number(getConfig().servers?.discoveryPort) || 48900;
  const payload = Buffer.from(JSON.stringify(selfInfo()));
  const sender = sock || dgram.createSocket("udp4");
  return new Promise((resolve) => {
    const finish = (sent) => {
      if (sender !== sock) {
        try { sender.close(); } catch {}
      }
      resolve(sent);
    };
    try {
      sender.send(payload, 0, payload.length, port, hostname, (error) => finish(!error));
    } catch {
      finish(false);
    }
  });
}

export function announceDiscoveryNow(options = {}) {
  const port = Number(getConfig().servers?.discoveryPort) || 48900;
  for (const delayMs of [0, 250, 1000, 2500]) {
    const send = () => broadcastSelf(port, options);
    if (delayMs === 0) {
      send();
      continue;
    }
    const timer = setTimeout(() => {
      announcementTimers.delete(timer);
      send();
    }, delayMs);
    timer.unref?.();
    announcementTimers.add(timer);
  }
  return true;
}

export function requestLanSyncDiscoveryNow() {
  const requestId = randomBytes(16).toString("hex");
  let joinedPeers = 0;
  let observedPeers = 0;
  for (const info of collectRegistryEntries()) {
    const joined = autoJoinLanSyncDiscovery(info);
    if (joined.joined) joinedPeers += 1;
    if (verifyLanSyncAdvertisement(info) && observeLanSyncPeer(info)) observedPeers += 1;
  }
  announceDiscoveryNow({ lanSyncRequestId: requestId });
  return {
    requestId,
    knownNodes: collectRegistryEntries().length,
    joinedPeers,
    observedPeers,
  };
}

async function probeKnownPeer(base, me = selfInfo(), { via = "manual" } = {}) {
  const peer = normalizeHost(base);
  if (!peer) {
    return { reachable: false, joined: false, code: "DISCOVERY_PEER_ORIGIN_INVALID" };
  }
  const existingEntry = [...registry.values()]
    .find((entry) => normalizeHost(entry.info?.host) === peer);
  const lanSyncOnline = isLanSyncPeerOnline({ host: peer });
  if (!shouldProbeManualPeer({ lanSyncOnline })) {
    if (existingEntry) existingEntry.lastSeen = Date.now();
    return {
      reachable: true,
      joined: false,
      reason: "already-online",
      nodeId: existingEntry?.info?.lanSyncNodeId || existingEntry?.info?.id || "",
      nodeName: existingEntry?.info?.name || "",
    };
  }

  const request = await fetchPeerDiscoveryInfo(peer, "/api/discovery/info", 4000);
  if (!request.available) {
    return {
      reachable: false,
      joined: false,
      reason: request.skipped ? "backoff" : "unreachable",
    };
  }
  const signedInfo = request.data?.data?.id
    ? request.data.data
    : null;
  if (!signedInfo) {
    return { reachable: true, joined: false, reason: "discovery-info-invalid" };
  }
  if (sameServer(signedInfo, me)) {
    return { reachable: true, joined: false, reason: "self" };
  }

  const info = { ...signedInfo, advertisedHost: signedInfo.host, host: peer };
  registry.set(serverKey(info), { info, lastSeen: Date.now(), via });
  const signedProtocol = signedInfo.syncMode !== "disabled" && Number(signedInfo.protocolVersion) >= 1;
  const join = signedProtocol
    ? autoJoinLanSyncDiscovery(signedInfo, { connectionHost: peer })
    : { joined: false, reason: "sync-disabled" };
  const reciprocalAnnounced = signedProtocol && ["joined", "already-member"].includes(
    join.joined ? "joined" : join.reason,
  ) ? await announcePeerNow(peer) : false;
  if (reciprocalAnnounced) {
    // 让旧远端先按既有 UDP 签名公告登记本机，再建立强制从手动地址发起的连接。
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  if (signedProtocol && verifyLanSyncAdvertisement(signedInfo)) {
    observeLanSyncPeer({ ...signedInfo, host: peer }, {
      forceOutbound: reciprocalAnnounced && join.joined === true,
    });
  } else if (!signedProtocol) {
    queueSharedPeer(info);
  }
  publishServersIfChanged(me);
  return {
    reachable: true,
    joined: join.joined === true,
    reason: join.reason || (join.joined ? "joined" : "not-joined"),
    nodeId: info.lanSyncNodeId || info.id || "",
    nodeName: info.name || "",
    syncMode: info.syncMode || "disabled",
    protocolVersion: Number(info.protocolVersion) || 0,
    reciprocalAnnounced,
  };
}

export async function probeManualPeer(base, me = selfInfo()) {
  return probeKnownPeer(base, me, { via: "manual" });
}

async function probeDiscoverySeed(base, me = selfInfo()) {
  const result = await probeKnownPeer(base, me, { via: "seed" });
  recordDiscoverySeedState(base, result);
  return result;
}

async function pollPeers(me = selfInfo()) {
  const peers = [...new Set((getConfig().servers?.peers || []).map(normalizeHost).filter(Boolean))];
  const seeds = configuredDiscoverySeeds();
  const seedSet = new Set(seeds);
  const origins = [...new Set([...peers, ...seeds])];
  await Promise.all(origins.map((base) => (
    seedSet.has(base) ? probeDiscoverySeed(base, me) : probeManualPeer(base, me)
  )));
}

const runPeerReconcileCycle = createSingleFlightRunner(async () => {
  const me = selfInfo();
  await pollPeers(me);
  publishServersIfChanged(me);
  await reconcileReplicatedData(me);
  await reconcileFeishuProjectMappings(me);
});

const runPeerMetadataCycle = createSingleFlightRunner(async () => {
  const me = selfInfo();
  await pollPeers(me);
  publishServersIfChanged(me);
  await reconcileReplicatedData(me, { includeShared: false });
  await reconcileFeishuProjectMappings(me);
});

function queueSharedPeer(info) {
  if (Number(info?.protocolVersion) >= 1) {
    if (info?.syncMode !== "disabled" && verifyLanSyncAdvertisement(info)) observeLanSyncPeer(info);
    return false;
  }
  if (getConfig().lanSync?.legacyCompatibility !== true) return false;
  const sameScope = __testNormalizeAdvertisedSyncScope(info?.syncScope) === localSyncScope();
  const advertisedVersion = Number(info?.sharedVersion || 0);
  const replicationKey = replicationPeerKey(info);
  if (!sameScope || !(info?.configPeer ?? info?.isServer) || advertisedVersion <= 0
    || advertisedVersion <= Number(sharedPeerVersions.get(replicationKey) || 0)) return false;
  const pending = pendingSharedPeers.get(replicationKey);
  if (pending && advertisedVersion <= Number(pending.info?.sharedVersion || 0)) return false;
  pendingSharedPeers.set(replicationKey, { info, changedAt: Date.now() });
  schedulePeerReconcile();
  return true;
}

function schedulePeerReconcile(delayMs = 50) {
  if (peerEventTimer) clearTimeout(peerEventTimer);
  if (!pendingSharedPeers.size) {
    peerEventTimer = null;
    return;
  }
  const now = Date.now();
  const nextDueAt = Math.min(...[...pendingSharedPeers.values()]
    .map((entry) => Number(entry.changedAt || now) + PEER_EVENT_RECONCILE_DEBOUNCE_MS));
  const waitMs = Math.max(Math.max(0, Number(delayMs) || 0), nextDueAt - now);
  peerEventTimer = setTimeout(() => {
    peerEventTimer = null;
    const readyAt = Date.now();
    const peers = [];
    for (const [key, entry] of pendingSharedPeers) {
      if (readyAt - Number(entry.changedAt || 0) < PEER_EVENT_RECONCILE_DEBOUNCE_MS) continue;
      peers.push(entry.info);
      pendingSharedPeers.delete(key);
    }
    if (peers.length) {
      const me = selfInfo();
      runSharedConfigReconcile(dedupeReplicationPeers(peers, me), me).catch(() => {});
    }
    schedulePeerReconcile();
  }, waitMs);
  peerEventTimer.unref?.();
}

export function initDiscovery() {
  const cfg = getConfig();
  const port = cfg.servers?.discoveryPort || 48900;
  // 监听广播（所有端都监听，以便客户端发现服务端）
  if (cfg.servers?.discovery !== false) {
    try {
      sock = dgram.createSocket({ type: "udp4", reuseAddr: true });
      sock.on("message", (msg) => {
        try {
          const info = JSON.parse(msg.toString());
          const me = selfInfo();
          if (info?.id && !sameServer(info, me)) {
            const key = serverKey(info);
            registry.set(key, { info, lastSeen: Date.now(), via: "udp" });
            publishServersIfChanged(me);
            const solicitation = validateLanSyncDiscoverySolicitation(info);
            if (solicitation && configuredLanSyncMode() === "peer") {
              const now = Date.now();
              for (const [requestId, seenAt] of handledLanSyncSolicitations) {
                if (now - seenAt > 30_000) handledLanSyncSolicitations.delete(requestId);
              }
              if (!handledLanSyncSolicitations.has(solicitation.requestId)) {
                while (handledLanSyncSolicitations.size >= 256) {
                  handledLanSyncSolicitations.delete(handledLanSyncSolicitations.keys().next().value);
                }
                handledLanSyncSolicitations.set(solicitation.requestId, now);
                announceDiscoveryNow();
              }
            }
            // 只有管理员真实发布后才会出现 groupId。其它 Gateway 自动加入，但绝不
            // 从发现路径播种本机旧快照；在线状态继续由 WebSocket ping/pong 维护。
            const join = info.syncMode !== "disabled" && Number(info.protocolVersion) >= 1
              ? autoJoinLanSyncDiscovery(info)
              : { joined: false };
            if (join.joined) announceDiscoveryNow();
            if (info.syncMode !== "disabled" && Number(info.protocolVersion) >= 1
              && verifyLanSyncAdvertisement(info)) observeLanSyncPeer(info);
            // 同一节点同一主机上的多端口 Gateway 只算一个复制源；版本连续变化时等待稳定，
            // 防止旧节点的写入风暴把 UDP 发现包放大成大 JSON 拉取风暴。
            queueSharedPeer(info);
          }
        } catch {}
      });
      sock.on("error", () => {});
      sock.bind(port, () => {
        try { sock.setBroadcast(true); } catch {}
        announceDiscoveryNow(); // 启动事件短促重发，避免 UDP 丢包；不等待低频兜底周期。
      });
      // 广播自身。/servers 仍只返回服务端；全节点广播用于局域网节点名冲突检测。
      broadcastTimer = setInterval(() => broadcastSelf(port), DISCOVERY_BROADCAST_INTERVAL_MS);
      log("system", "info", "discovery", `服务发现已启动（UDP ${port}，角色 ${role()}）`);
    } catch (e) { log("system", "warn", "discovery", `UDP 发现启动失败：${e.message}`); }
  }
  // 重型共享 bundle 由 UDP/手动 peer 版本事件触发；5 分钟全量周期只做丢包兜底。
  peerTimer = setInterval(() => {
    if (peerEventTimer) clearTimeout(peerEventTimer);
    peerEventTimer = null;
    pendingSharedPeers.clear();
    runPeerReconcileCycle().catch(() => {});
  }, PEER_RECONCILE_INTERVAL_MS);
  // 审计/管理员/反馈/用户数据都是增量小响应，保留 60 秒低频同步与手动 peer 探活。
  peerMetadataTimer = setInterval(() => {
    runPeerMetadataCycle().catch(() => {});
  }, PEER_METADATA_INTERVAL_MS);
  runPeerMetadataCycle().catch(() => {});
}

export function stopDiscovery() {
  if (broadcastTimer) clearInterval(broadcastTimer);
  if (peerTimer) clearInterval(peerTimer);
  if (peerMetadataTimer) clearInterval(peerMetadataTimer);
  if (peerEventTimer) clearTimeout(peerEventTimer);
  for (const timer of announcementTimers) clearTimeout(timer);
  announcementTimers.clear();
  handledLanSyncSolicitations.clear();
  discoverySeedStates.clear();
  try { sock?.close(); } catch {}
  sock = null;
  broadcastTimer = null;
  peerTimer = null;
  peerMetadataTimer = null;
  peerEventTimer = null;
  pendingSharedPeers.clear();
  lastPublishedServerState = "";
  peerBackoff.clear();
  discoveryPeerBackoff.clear();
}
