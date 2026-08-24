/**
 * devbench 模块 - 持久化
 *
 * - 仓库跟踪配置：configs/market-projects.json 只作为首次启动种子，运行时只读
 * - 团队共享配置：SQLite devbench_userdata（跨 Gateway gossip 同步）
 * - 本地工程列表：configs/local/devbench-projects.json（不提交 Git）
 * - 故事点 Tab：持久化到 gateway/.tmp/devbench/tabs.json
 * - 每个 Tab 的消息历史：gateway/.tmp/devbench/msg-<tabId>.json
 *
 * .tmp/ 已在仓库 .gitignore 列表内，不污染主数据库与仓库。
 */
import fs from "fs";
import os from "os";
import path from "path";
import { execFileSync } from "child_process";
import { createHash } from "crypto";
import { fileURLToPath } from "url";
import { getTbProjectIds } from "../teambition.js";
import { getConfig } from "../config.js";
import { emitWs } from "../logger.js";
import { gitHttpsToSsh } from "./git-remote.js";
import { storyTicketIdentities } from "./story-ticket-identity.js";
import {
  normalizeWorkspaceBundle,
  validateWorkspaceBundle,
} from "./workspace-bundle.js";
import {
  listConversationBackupFiles,
  readConversationBackup,
  writeConversationBackup,
} from "./conversation-backup.js";
import {
  activeConversationPath,
  appendConversationNode as appendConversationGraphNode,
  conversationView,
  createUserRevision as createConversationGraphUserRevision,
  legacyConversationMessages,
  normalizeConversation,
  selectConversationNode,
  updateConversationNodeFields as updateConversationGraphNodeFields,
} from "./conversation/model.js";
import { createQueuedMessage } from "./conversation/queued-message.js";
import {
  normalizeBuildLineage,
  normalizeGoldCase,
  normalizeStoryTicket,
  routeStoryPointTicket,
  storyTrainingRegistryTargets,
  validateStoryTrainingTargets,
  STORY_TRAINING_BUILD_TYPES,
  STORY_TRAINING_ENVIRONMENTS,
  STORY_TRAINING_VERSIONS,
} from "./story-training.js";
import {
  CONFIG_INFERENCE_BINDABLE_FIELDS,
  CONFIG_INFERENCE_DIMENSIONS,
  CONFIG_INFERENCE_REPLACEABLE_FIELDS,
  CONFIG_INFERENCE_VERSION,
  bindConfigInferenceTargets,
  buildConfigInferenceRegistry,
  configInferenceSymbolicFields,
  extractConfigInferenceSignals,
  hasConfigInferenceSymbolicFields,
  inferConfigFromTicket,
  normalizeConfigInferenceTargets,
  normalizeConfigInferenceTicket,
  retrieveConfigInferenceMemories,
  validateConfigInferenceTargets,
} from "./config-inference.js";
import {
  activateKnowledgeValueRevision,
  createKnowledgeKey,
  createKnowledgeValueRevision,
  knowledgeValueImpact,
  knowledgeValueSensitivity,
  resolveKnowledgeValue,
  rollbackKnowledgeValueRevision,
  transitionKnowledgeValueRevision,
} from "./machine-learn/knowledge-governance.js";
import { prioritizeConfigInferenceCases } from "./machine-learn/active-learning.js";
import {
  adjudicateConfigInferenceAnnotations,
  createApprovedConfigInferenceLabel,
} from "./machine-learn/annotation-governance.js";
import {
  configInferenceDatasetHash,
  createConfigInferenceDatasetVersion,
  splitConfigInferenceCasesByTime,
} from "./machine-learn/evaluator.js";
import {
  activateConfigInferenceRelease,
  rollbackConfigInferenceRelease,
  transitionConfigInferenceRelease,
} from "./machine-learn/release-governance.js";
import {
  createConfigInferenceReleaseBundle,
  decorateConfigInferenceServingResult,
  prepareConfigInferenceReleaseEvaluation,
  resolveConfigInferenceServingBundle,
} from "./machine-learn/serving-orchestrator.js";
import {
  createInferenceSourceSnapshot,
  sanitizeSharedTrainingText,
  scanSharedSnapshotViolations,
} from "./machine-learn/source-snapshot.js";
import db, {
  getUserData,
  getUserDataRecord,
  getUserDataMetadata,
  setUserData,
  updateUserData,
  updateDevbenchStoryState,
  listSyncableUserDataRows,
  replaceSyncableUserDataRows,
  insertDevbenchSyncBackup,
  listDevbenchSyncBackups,
  getLatestDevbenchSyncBackupMeta,
  pruneDevbenchSyncBackups,
  getDevbenchSyncBackupStorageStats,
  getDevbenchSyncBackup,
  getDevbenchSyncBackupSetting,
  setDevbenchSyncBackupSetting,
  deleteDevbenchExecutionHistory,
} from "../../db/sqlite.js";

const LOCAL_ONLY_KINDS = new Set(["tabs", "closed", "deviceRuntime"]);
const CONFIG_INFERENCE_SHARED_SECTIONS = Object.freeze([
  "runs",
  "samples",
  "trainedTickets",
  "trainingClaims",
  "valueBindings",
  "keywordSuggestions",
  "datasets",
  "evaluations",
  "artifacts",
  "releases",
]);
const CONFIG_INFERENCE_SERVING_STATUSES = new Set(["pending", "approved", "revoked", "superseded"]);
const CONFIG_INFERENCE_EXECUTION_OUTCOMES = new Set([
  "started",
  "success",
  "failed",
  "aborted",
  "reverted",
  "accepted",
]);
const CONFIG_INFERENCE_KNOWLEDGE_REVISION_STATUSES = new Set([
  "draft",
  "approved",
  "active",
  "rejected",
  "retired",
]);

// 任务的"用户维度"：同 TB 账号(operatorId)→同 key→局域网 gossip 收敛；未登录用本机设备指纹，避免复制工程后 nodeId 相同导致误并。
export function configUserKey() {
  const c = getConfig();
  const tb = String(c.teambition?.operatorId || "").trim();
  if (tb) return "tb:" + tb;
  const ding = String(c.adminAuth?.dingUserid || "").trim();
  if (ding) return "ding:" + ding;
  return "device:" + machineStorageId();
}
function nodeIdSafe() { return getConfig().servers?.nodeId || ""; }

let _machineStorageId = "";
function readWindowsMachineGuid() {
  if (process.platform !== "win32") return "";
  const windowsRoot = String(process.env.SystemRoot || process.env.WINDIR || "").trim();
  const registryCli = windowsRoot
    ? path.join(windowsRoot, "System32", "reg.exe")
    : "reg";
  // Gateway 启动时磁盘/杀毒扫描偶尔会让一次 reg query 超过旧的 1.2 秒上限。
  // 不能因一次瞬时超时就切到 MAC 身份，否则 tabs/closed 会读到另一个设备桶，
  // 页面表现为全部历史和部分打开故事点凭空消失。
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const out = execFileSync(registryCli, ["query", "HKLM\\SOFTWARE\\Microsoft\\Cryptography", "/v", "MachineGuid"], {
        encoding: "utf8",
        timeout: 2500,
        windowsHide: true,
      });
      const m = out.match(/MachineGuid\s+REG_\w+\s+([^\r\n]+)/i);
      const value = String(m?.[1] || "").trim().toLowerCase();
      if (value) return value;
    } catch {
      // 有界重试；连续失败时由持久身份缓存兜底，避免切换设备桶。
    }
  }
  return "";
}
function bestMacAddress() {
  try {
    const badIface = /(virtual|vmware|hyper-v|vethernet|virtualbox|loopback|bluetooth|docker|wsl|npcap)/i;
    const candidates = [];
    for (const [iface, list] of Object.entries(os.networkInterfaces())) {
      for (const item of list || []) {
        const mac = String(item?.mac || "").toLowerCase();
        if (!mac || mac === "00:00:00:00:00:00" || item?.internal) continue;
        candidates.push({ mac, iface, score: badIface.test(iface) ? 1 : 0 });
      }
    }
    candidates.sort((a, b) => a.score - b.score || a.iface.localeCompare(b.iface) || a.mac.localeCompare(b.mac));
    return candidates[0]?.mac || "";
  } catch {
    return "";
  }
}

const MACHINE_STORAGE_ID_PATTERN = /^[a-f0-9]{16}$/;

export function resolveMachineStorageIdentity({
  guid = "",
  mac = "",
  cachedId = "",
  hostname = "",
  nodeId = "",
} = {}) {
  const stableGuid = String(guid || "").trim().toLowerCase();
  const stableMac = String(mac || "").trim().toLowerCase();
  const stableCachedId = String(cachedId || "").trim().toLowerCase();
  let source = "";
  let sourceKind = "fallback";
  if (stableGuid) {
    source = `win-machine-guid:${stableGuid}`;
    sourceKind = "win-machine-guid";
  } else if (MACHINE_STORAGE_ID_PATTERN.test(stableCachedId)) {
    return { id: stableCachedId, sourceKind: "persisted" };
  } else if (stableMac) {
    source = `mac:${stableMac}`;
    sourceKind = "mac";
  } else {
    source = `fallback:${String(hostname || "").trim()}|${String(nodeId || "machine").trim() || "machine"}`;
  }
  return {
    id: createHash("sha256").update(source).digest("hex").slice(0, 16),
    sourceKind,
  };
}

function readPersistedMachineStorageId() {
  try {
    const data = JSON.parse(fs.readFileSync(MACHINE_STORAGE_ID_FILE, "utf8"));
    const id = String(data?.id || "").trim().toLowerCase();
    return MACHINE_STORAGE_ID_PATTERN.test(id) ? id : "";
  } catch {
    return "";
  }
}

function persistMachineStorageId(identity) {
  const id = String(identity?.id || "").trim().toLowerCase();
  if (!MACHINE_STORAGE_ID_PATTERN.test(id)) return;
  // 命中已有缓存时不重复改写，保留最初解析到的权威来源并减少多 Gateway 启动竞争。
  if (identity?.sourceKind === "persisted") return;
  try {
    fs.mkdirSync(path.dirname(MACHINE_STORAGE_ID_FILE), { recursive: true });
    const tempFile = `${MACHINE_STORAGE_ID_FILE}.${process.pid}.${Date.now()}.tmp`;
    const payload = `${JSON.stringify({ version: 1, id, sourceKind: identity.sourceKind || "unknown" }, null, 2)}\n`;
    try {
      fs.writeFileSync(tempFile, payload, { encoding: "utf8", flag: "wx", mode: 0o600 });
      try {
        fs.renameSync(tempFile, MACHINE_STORAGE_ID_FILE);
      } catch {
        // Windows 不能总是用 rename 覆盖既有文件；同内容很小，直接替换后再清理临时文件。
        fs.writeFileSync(MACHINE_STORAGE_ID_FILE, payload, { encoding: "utf8", mode: 0o600 });
        try { fs.rmSync(tempFile, { force: true }); } catch {}
      }
    } finally {
      try { fs.rmSync(tempFile, { force: true }); } catch {}
    }
  } catch {
    // 缓存不可写不能阻断 Gateway；本次仍使用已解析出的设备身份。
  }
}

export function machineStorageId() {
  if (_machineStorageId) return _machineStorageId;
  const guid = readWindowsMachineGuid();
  const mac = bestMacAddress();
  const identity = resolveMachineStorageIdentity({
    guid,
    mac,
    cachedId: readPersistedMachineStorageId(),
    hostname: os.hostname() || "",
    nodeId: nodeIdSafe() || "machine",
  });
  _machineStorageId = identity.id;
  persistMachineStorageId(identity);
  return _machineStorageId;
}
export function storageUserKey(kind = "tasks") {
  if (LOCAL_ONLY_KINDS.has(kind)) return `device:${machineStorageId()}`;
  return configUserKey();
}
function readLegacyArr(file) {
  try { if (fs.existsSync(file)) { const a = JSON.parse(fs.readFileSync(file, "utf-8")); return Array.isArray(a) ? a : []; } } catch {}
  return [];
}
function loadLocalOnlyFallback(kind) {
  const nid = nodeIdSafe() || "machine";
  const accountKey = configUserKey();
  const candidates = [...new Set([`device:${nid}`, `local:${nid}`, "local:machine"])];
  if (!accountKey.startsWith("local:")) candidates.push(accountKey); // 旧版本曾把 tabs/closed 写到账号桶；只接受本机写入的行
  for (const key of candidates) {
    const rec = getUserDataRecord(key, kind);
    if (!rec || !Array.isArray(rec.data) || rec.data.length === 0) continue;
    if (key === accountKey && rec.node && rec.node !== nid) continue;
    return rec.data;
  }
  return null;
}
function renameMigratedStorySnapshot(kind, legacyFile) {
  if (!fs.existsSync(legacyFile)) return;
  if (kind !== "tabs" && kind !== "closed") {
    try { fs.renameSync(legacyFile, `${legacyFile}.migrated`); } catch {}
    return;
  }
  const claimed = claimLegacySnapshotRewriteLock({ tabId: `migration:${kind}` });
  if (!claimed.ok) return; // 数据已落 SQLite；旧镜像保留，后续启动仍可重试迁移改名。
  try {
    if (fs.existsSync(legacyFile)) fs.renameSync(legacyFile, `${legacyFile}.migrated`);
  } catch {} finally {
    const released = releaseLegacySnapshotRewriteLock(claimed.token);
    if (!released.ok) try { console.warn(`[devbench] release legacy snapshot migration lock failed: ${released.error}`); } catch {}
  }
}
// 读某类数据：tasks 按用户同步；tabs/closed 为本机打开状态，按设备保存，不跨机同步。
// 迁移后把旧文件改名 .migrated，避免被不同 userKey 重复导入(多用户共机会串数据)
function loadKind(kind, legacyFile) {
  if (!LOCAL_ONLY_KINDS.has(kind)) migrateFromLocalIfNeeded(); // 登录后 userKey 变化时，只迁移任务列表
  const uk = storageUserKey(kind);
  let data = getUserData(uk, kind);
  if (data === null || !Array.isArray(data)) {
    data = LOCAL_ONLY_KINDS.has(kind) ? (loadLocalOnlyFallback(kind) || readLegacyArr(legacyFile)) : readLegacyArr(legacyFile);
    setUserData(uk, kind, data, nodeIdSafe());
    renameMigratedStorySnapshot(kind, legacyFile);
  }
  return data;
}
function saveKind(kind, arr) { setUserData(storageUserKey(kind), kind, arr || [], nodeIdSafe()); }

// 一键登录会把 teambition.operatorId 填上，userKey 随之从 local:<机器> 变为 tb:<operatorId>，
// 导致登录前创建的故事点/任务"消失"（看起来像自动关闭）。这里做一次性迁移：当前(非 local)桶为空、
// 而本机 local:* 桶有数据时，把 tabs/tasks/closed 复制过来（不删源、持久化只迁一次）。
const _migratedKeys = new Set();
function migrateFromLocalIfNeeded() {
  try {
    const cur = configUserKey();
    if (cur.startsWith("local:") || cur.startsWith("device:")) return; // 还没登录，无需迁移
    if (_migratedKeys.has(cur)) return;          // 本进程已处理
    _migratedKeys.add(cur);
    const done = getUserData("__system__", "migratedFromLocal");
    if (Array.isArray(done) && done.includes(cur)) return; // 历史已迁过，绝不重复（避免覆盖用户后来清空的桶）
    const nid = getConfig().servers?.nodeId || "machine";
    const candidates = [...new Set([`device:${machineStorageId()}`, `local:${nid}`, "local:machine"])];
    let migratedAny = false;
    for (const kind of ["tasks", "taskGroups"]) {
      const curData = getUserData(cur, kind);
      if (Array.isArray(curData) && curData.length > 0) continue; // 当前桶已有数据，不覆盖
      for (const lk of candidates) {
        const ld = getUserData(lk, kind);
        if (Array.isArray(ld) && ld.length > 0) { setUserData(cur, kind, ld, nid); migratedAny = true; break; }
      }
    }
    setUserData("__system__", "migratedFromLocal", [...(Array.isArray(done) ? done : []), cur], nid);
    if (migratedAny) { try { console.log(`[devbench] 已把本机 local 故事点/任务迁移到 ${cur}（登录后不再消失）`); } catch {} }
  } catch {}
}

// 一次性迁移：把旧任务里"下周一/今天"等相对期限，按各任务 createdAt 作基准重算成绝对日期。
// 按 userKey 记录"已迁过"，只跑一次；之后新建/编辑由 normDeadline 即时换算。
const _deadlineMigrated = new Set();
function migrateDeadlinesIfNeeded() {
  try {
    const cur = configUserKey();
    if (_deadlineMigrated.has(cur)) return; // 本进程已处理（先置位，避免下面 loadKind 重入）
    _deadlineMigrated.add(cur);
    const done = getUserData("__system__", "deadlinesResolved");
    if (Array.isArray(done) && done.includes(cur)) return; // 历史已迁过，绝不重复
    const tasks = loadKind("tasks", TASKS_FILE);
    let changed = false;
    if (Array.isArray(tasks)) {
      for (const t of tasks) {
        if (!t || !t.deadline) continue;
        const base = t.createdAt ? new Date(t.createdAt) : new Date();
        const resolved = resolveDeadlineText(String(t.deadline), base);
        if (resolved && resolved !== t.deadline) { t.deadline = resolved.slice(0, 60); changed = true; }
      }
      if (changed) saveKind("tasks", tasks);
    }
    const nid = getConfig().servers?.nodeId || "machine";
    setUserData("__system__", "deadlinesResolved", [...(Array.isArray(done) ? done : []), cur], nid);
    if (changed) { try { console.log(`[devbench] 已按 createdAt 重算旧任务的相对期限（${cur}）`); } catch {} }
  } catch {}
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// 默认项目 id（未指定时用首个配置项目；按项目隔离的数据(车型/关键词/应用分类)用它兜底）
function defaultPid() { return getTbProjectIds().find((projectId) => safeDataKey(projectId)) || "_default"; }
function safeDataKey(value) {
  const text = String(value ?? "").trim();
  return !!text
    && !["__proto__", "prototype", "constructor"].includes(text.toLowerCase())
    && !Object.hasOwn(Object.prototype, text);
}
export function normalizeVehicleProjectId(projectId, { required = false } = {}) {
  const raw = String(projectId ?? "").trim();
  if (required && !raw) {
    throw Object.assign(new Error("projectId 不能为空"), {
      statusCode: 400,
      code: "VEHICLE_PROJECT_ID_REQUIRED",
    });
  }
  const pid = raw || defaultPid();
  if (!safeDataKey(pid)) {
    throw Object.assign(new Error("项目 ID 不合法"), {
      statusCode: 400,
      code: "VEHICLE_PROJECT_ID_INVALID",
    });
  }
  return pid;
}
// 取/建某项目的数据桶；并把旧启动种子中的顶层 vehicleMap/keywordMappings
// 一次性迁移进 SQLite 的默认项目桶。源 JSON 保持只读，所以只有真正补入共享态
// 时才返回 changed；共享态已经有值时不能因内存里丢弃旧字段而反复写数据库。
function ensureMigrated(cfg) {
  cfg.byProject = (cfg.byProject && typeof cfg.byProject === "object") ? cfg.byProject : {};
  let changed = false;
  if (cfg.vehicleMap && typeof cfg.vehicleMap === "object") {
    const pid = defaultPid();
    cfg.byProject[pid] = cfg.byProject[pid] || {};
    if (!cfg.byProject[pid].vehicleMap) {
      cfg.byProject[pid].vehicleMap = cfg.vehicleMap;
      for (const [vehicle, value] of Object.entries(cfg.vehicleMap)) {
        if (!safeSharedSegment(vehicle)) continue;
        appendSharedOp(cfg, { type: "byProject.set", projectId: pid, path: ["vehicleMap", vehicle], value });
      }
      changed = true;
    }
    delete cfg.vehicleMap;
  }
  if (cfg.keywordMappings && typeof cfg.keywordMappings === "object") {
    const pid = defaultPid();
    cfg.byProject[pid] = cfg.byProject[pid] || {};
    if (!cfg.byProject[pid].keywordMappings) {
      cfg.byProject[pid].keywordMappings = cfg.keywordMappings;
      for (const [group, mappings] of Object.entries(cfg.keywordMappings)) {
        if (!safeSharedSegment(group) || !isPlainObject(mappings)) continue;
        for (const [key, value] of Object.entries(mappings)) {
          if (!safeSharedSegment(key)) continue;
          appendSharedOp(cfg, { type: "byProject.set", projectId: pid, path: ["keywordMappings", group, key], value });
        }
      }
      changed = true;
    }
    delete cfg.keywordMappings;
  }
  return changed;
}
function projectBucket(cfg, projectId) {
  const pid = normalizeVehicleProjectId(projectId);
  cfg.byProject = (cfg.byProject && typeof cfg.byProject === "object") ? cfg.byProject : {};
  if (!Object.hasOwn(cfg.byProject, pid) || !isPlainObject(cfg.byProject[pid])) cfg.byProject[pid] = {};
  return cfg.byProject[pid];
}
const PROJECT_ROOT = path.resolve(__dirname, "..", "..", "..");
// 配置/存储路径（测试可用 DEVBENCH_CONFIG_PATH / DEVBENCH_STORE_DIR 覆盖，实现隔离）
const DEFAULT_MARKET_CONFIG = path.join(PROJECT_ROOT, "configs", "market-projects.json");
const MARKET_CONFIG = process.env.DEVBENCH_CONFIG_PATH || DEFAULT_MARKET_CONFIG;
const LOCAL_PROJECTS_CONFIG = process.env.DEVBENCH_LOCAL_PROJECTS_PATH
  || path.join(path.dirname(MARKET_CONFIG), "local", "devbench-projects.json");
const USES_REPOSITORY_MARKET_CONFIG = path.resolve(MARKET_CONFIG) === path.resolve(DEFAULT_MARKET_CONFIG);
const PREFERRED_WINDOWS_CLONE_PARENT = "D:\\workspace\\AIProjects";
const CLONE_PARENT_TAIL = path.join("workspace", "AIProjects");
let cachedPlatformDefaultCloneParent = "";

function listWindowsDriveRoots() {
  const roots = [];
  for (let code = 65; code <= 90; code += 1) {
    const root = `${String.fromCharCode(code)}:\\`;
    try {
      fs.accessSync(root);
      roots.push(root);
    } catch {
      // 盘符不存在或不可访问
    }
  }
  return roots;
}

function freeBytesForPath(target) {
  try {
    const stats = fs.statfsSync(target);
    return Number(stats.bavail) * Number(stats.bsize);
  } catch {
    return -1;
  }
}

/**
 * Pure Windows default-path selector. The caller supplies the accessible drive
 * roots and their free bytes so the policy can be tested without probing the
 * current machine.
 */
export function selectWindowsDefaultCloneParent(drives = []) {
  const candidates = (Array.isArray(drives) ? drives : [])
    .map((drive) => {
      const rawRoot = String(drive?.root ?? drive ?? "").trim();
      const match = /^([a-z]):[\\/]*$/i.exec(rawRoot);
      if (!match) return null;
      const freeBytes = Number(drive?.freeBytes);
      return {
        root: `${match[1].toUpperCase()}:\\`,
        freeBytes: Number.isFinite(freeBytes) ? freeBytes : -1,
      };
    })
    .filter(Boolean);

  if (candidates.some((candidate) => candidate.root === "D:\\")) {
    return PREFERRED_WINDOWS_CLONE_PARENT;
  }

  let best = null;
  for (const candidate of candidates) {
    if (candidate.freeBytes >= 0 && (!best || candidate.freeBytes > best.freeBytes)) {
      best = candidate;
    }
  }
  return best ? path.win32.join(best.root, "workspace", "AIProjects") : "";
}

/**
 * 解析本机默认克隆父路径：
 * 1) 环境变量 AIEFFICIENCY_CLONE_PARENT
 * 2) Windows 优先 D:\workspace\AIProjects（D 盘存在时）
 * 3) Windows 无 D 盘时选剩余空间最大的盘符 + \workspace\AIProjects
 * 4) 非 Windows：~/workspace/AIProjects
 */
export function resolveDefaultCloneParent() {
  const fromEnv = String(process.env.AIEFFICIENCY_CLONE_PARENT || "").trim();
  if (fromEnv) return path.resolve(fromEnv);
  if (cachedPlatformDefaultCloneParent) return cachedPlatformDefaultCloneParent;

  let resolved = path.join(os.homedir(), CLONE_PARENT_TAIL);
  if (process.platform === "win32") {
    const selected = selectWindowsDefaultCloneParent(
      listWindowsDriveRoots().map((root) => ({ root, freeBytes: freeBytesForPath(root) })),
    );
    if (selected) resolved = selected;
  }
  cachedPlatformDefaultCloneParent = resolved;
  return resolved;
}

function getDefaultCloneParent() {
  return resolveDefaultCloneParent();
}

export function devbenchSyncScope() {
  const explicit = String(process.env.DEVBENCH_SYNC_SCOPE || "").trim().slice(0, 160);
  if (explicit) return explicit;
  const profile = String(process.env.AIEFFICIENCY_PROFILE || "").trim();
  if (!profile || profile.toLowerCase() === "production") return "production";
  return `profile:${profile}`.slice(0, 160);
}

// 锚定到 gateway 目录(__dirname 的上两级)，不依赖启动时的 process.cwd()——
// 否则从不同工作目录启动网关会指向不同的 .tmp/devbench，导致任务/Tab"丢失"。
const GATEWAY_DIR = path.resolve(__dirname, "..", "..");
const STORE_DIR = process.env.DEVBENCH_STORE_DIR || path.join(GATEWAY_DIR, ".tmp", "devbench");
const MACHINE_STORAGE_ID_FILE = process.env.DEVBENCH_MACHINE_STORAGE_ID_FILE
  || path.join(STORE_DIR, "machine-storage-id.json");
const TABS_FILE = path.join(STORE_DIR, "tabs.json");
const CLOSED_FILE = path.join(STORE_DIR, "closed-tabs.json"); // 已关闭故事点的"配置快照"，供新建时复制
const TASKS_FILE = path.join(STORE_DIR, "tasks.json"); // devbench 待办任务列表
const TASK_GROUPS_FILE = path.join(STORE_DIR, "task-groups.json"); // devbench 待办任务组
const MOCK_DEVICES_FILE = path.join(STORE_DIR, "mock-devices.json"); // 设备模拟（wm size/density）预设列表
const LOCAL_CHECKOUTS_FILE = path.join(STORE_DIR, "local-projects.json"); // 客户端本地：每个工程已有的本地 checkout（per-client，拉取后记录复用）
const DELETION_TOMBSTONE_DIR = path.join(STORE_DIR, "delete-tombstones");
const LEGACY_SNAPSHOT_REWRITE_LOCK = path.join(DELETION_TOMBSTONE_DIR, "legacy-story-snapshots.lock");
const LEGACY_SNAPSHOT_REAP_LOCK = path.join(DELETION_TOMBSTONE_DIR, "legacy-story-snapshots.reap.lock");
const SYNC_WAIT_SIGNAL = new Int32Array(new SharedArrayBuffer(4));

// 永久删除期间阻止已停止 AI 的异步回调重新写回 msg/live/TXT。
// 内存 Set 负责本进程快速判断；持久化 tombstone 负责多个 Gateway 共享 store 时的跨进程判断。
// ID 不会复用；删除成功后永久保留 deleted marker，失败时由调用方显式释放 deleting marker。
const DELETING_TAB_IDS = new Set();

function waitSync(milliseconds) {
  Atomics.wait(SYNC_WAIT_SIGNAL, 0, 0, Math.max(1, Number(milliseconds) || 1));
}

function readLegacySnapshotRewriteLock() {
  let stat;
  try { stat = fs.lstatSync(LEGACY_SNAPSHOT_REWRITE_LOCK); }
  catch (error) {
    return error?.code === "ENOENT"
      ? { exists: false, safe: true, data: null, mtimeMs: 0 }
      : { exists: false, safe: false, data: null, mtimeMs: 0, error: error.message };
  }
  if (stat.isSymbolicLink() || !stat.isFile()) {
    return { exists: true, safe: false, data: null, mtimeMs: Number(stat.mtimeMs || 0), error: "旧快照互斥锁不是普通文件" };
  }
  try {
    const data = JSON.parse(fs.readFileSync(LEGACY_SNAPSHOT_REWRITE_LOCK, "utf-8"));
    return { exists: true, safe: true, data, mtimeMs: Number(stat.mtimeMs || 0) };
  } catch (error) {
    return { exists: true, safe: true, data: null, mtimeMs: Number(stat.mtimeMs || 0), error: error.message };
  }
}

function reapStaleLegacySnapshotRewriteLock(expectedToken) {
  if (!expectedToken) return false;
  let reaperFd;
  const reaperToken = createHash("sha256").update(`${process.pid}|${Date.now()}|${Math.random()}`).digest("hex");
  try {
    reaperFd = fs.openSync(LEGACY_SNAPSHOT_REAP_LOCK, "wx");
    fs.writeFileSync(reaperFd, JSON.stringify({ token: reaperToken, pid: process.pid, startedAt: Date.now() }), "utf8");
    fs.fsyncSync(reaperFd);
    const current = readLegacySnapshotRewriteLock();
    if (!current.safe || current.data?.token !== expectedToken) return false;
    const lockAge = Date.now() - Number(current.data?.startedAt || current.mtimeMs || Date.now());
    if (lockAge <= 15 * 60 * 1000 || current.data?.host !== os.hostname()) return false;
    const ownerPid = Number(current.data?.pid);
    if (!Number.isInteger(ownerPid) || ownerPid <= 0) return false;
    let ownerDefinitelyStopped = false;
    try { process.kill(ownerPid, 0); }
    catch (error) { ownerDefinitelyStopped = error?.code === "ESRCH"; }
    if (!ownerDefinitelyStopped) return false;
    // 固定 reaper 锁保证只有一个回收者；删除前已在锁内重读 token，不能误删新 owner。
    fs.rmSync(LEGACY_SNAPSHOT_REWRITE_LOCK, { force: true });
    return true;
  } catch {
    return false;
  } finally {
    if (reaperFd !== undefined) try { fs.closeSync(reaperFd); } catch {}
    try {
      const raw = JSON.parse(fs.readFileSync(LEGACY_SNAPSHOT_REAP_LOCK, "utf8"));
      if (raw?.token === reaperToken) fs.rmSync(LEGACY_SNAPSHOT_REAP_LOCK, { force: true });
    } catch {}
  }
}

// tabs.json / closed-tabs.json 是整文件旧镜像。不同故事点虽有各自 tombstone，
// 仍必须共享同一把跨进程锁，否则 A/B 同时读改写会互相覆盖删除结果。
function claimLegacySnapshotRewriteLock({ timeoutMs = 5000, tabId = "" } = {}) {
  ensureDir();
  fs.mkdirSync(DELETION_TOMBSTONE_DIR, { recursive: true });
  const deadline = Date.now() + Math.max(500, Number(timeoutMs) || 5000);
  const token = createHash("sha256").update(`${os.hostname()}|${process.pid}|${Date.now()}|${Math.random()}`).digest("hex");
  while (true) {
    let fd;
    let created = false;
    try {
      fd = fs.openSync(LEGACY_SNAPSHOT_REWRITE_LOCK, "wx");
      created = true;
      fs.writeFileSync(fd, JSON.stringify({
        version: 1,
        token,
        host: os.hostname(),
        pid: process.pid,
        tabId: String(tabId || ""),
        startedAt: Date.now(),
      }, null, 2), "utf-8");
      fs.fsyncSync(fd);
      return { ok: true, token };
    } catch (error) {
      if (created) {
        if (fd !== undefined) try { fs.closeSync(fd); fd = undefined; } catch {}
        try { fs.rmSync(LEGACY_SNAPSHOT_REWRITE_LOCK, { force: true }); } catch {}
      }
      if (error?.code !== "EEXIST") {
        return { ok: false, code: "LEGACY_SNAPSHOT_LOCK_FAILED", error: error.message };
      }
      const current = readLegacySnapshotRewriteLock();
      if (!current.safe) return { ok: false, code: "LEGACY_SNAPSHOT_LOCK_UNSAFE", error: current.error };
      if (reapStaleLegacySnapshotRewriteLock(current.data?.token)) continue;
      if (Date.now() >= deadline) {
        return { ok: false, code: "LEGACY_SNAPSHOT_LOCK_TIMEOUT", error: "另一个 Gateway 正在更新旧故事点快照，请稍后重试" };
      }
      waitSync(1);
    } finally {
      if (fd !== undefined) try { fs.closeSync(fd); } catch {}
    }
  }
}

function releaseLegacySnapshotRewriteLock(token) {
  const current = readLegacySnapshotRewriteLock();
  if (!current.exists) return { ok: false, error: "旧快照互斥锁已意外丢失" };
  if (!current.safe) return { ok: false, error: current.error || "旧快照互斥锁无法安全读取" };
  if (current.data?.token !== token) return { ok: false, error: "旧快照互斥锁所有者已变化" };
  try {
    fs.rmSync(LEGACY_SNAPSHOT_REWRITE_LOCK);
    // rmSync 成功即表示当前 token 对应的目录项已经删除。这里不能再用 existsSync
    // 验证：等待者可能已合法创建下一把锁，旧 owner 不能把 successor 的锁误判为
    // 自己释放失败，更不能删除或覆盖 successor 的锁。
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

function deletionTombstoneFile(tabId) {
  const key = createHash("sha256").update(String(tabId || "")).digest("hex");
  return path.join(DELETION_TOMBSTONE_DIR, `${key}.json`);
}

function deletionPermanentFile(tabId) {
  const key = createHash("sha256").update(String(tabId || "")).digest("hex");
  return path.join(DELETION_TOMBSTONE_DIR, `${key}.deleted`);
}

function readDeletionTombstone(tabId) {
  const file = deletionTombstoneFile(tabId);
  let stat = null;
  try { stat = fs.lstatSync(file); } catch {}
  if (!stat?.isFile() || stat.isSymbolicLink()) return { file, data: null, exists: !!stat, mtimeMs: Number(stat?.mtimeMs || 0) };
  try {
    return {
      file,
      data: JSON.parse(fs.readFileSync(file, "utf-8")),
      exists: true,
      mtimeMs: Number(stat.mtimeMs || 0),
    };
  } catch {
    return { file, data: null, exists: true, mtimeMs: Number(stat.mtimeMs || 0) };
  }
}

function isTabPermanentlyDeleted(tabId) {
  return fs.existsSync(deletionPermanentFile(tabId)) || readDeletionTombstone(tabId).data?.state === "deleted";
}

function claimDeletionTombstone(tabId, expectedClosedAt, state = "deleting") {
  ensureDir();
  fs.mkdirSync(DELETION_TOMBSTONE_DIR, { recursive: true });
  const file = deletionTombstoneFile(tabId);
  let fd;
  let created = false;
  try {
    fd = fs.openSync(file, "wx");
    created = true;
    fs.writeFileSync(fd, JSON.stringify({
      version: 1,
      state,
      tabId: String(tabId || ""),
      expectedClosedAt: Number(expectedClosedAt),
      startedAt: Date.now(),
      host: os.hostname(),
      pid: process.pid,
    }, null, 2), "utf-8");
    fs.fsyncSync(fd);
    return { ok: true, file };
  } catch (error) {
    if (error?.code === "EEXIST") return { ok: false, file, code: "DELETE_IN_PROGRESS" };
    // open("wx") 成功后若写入失败，不能留下一个永远阻断重试的空/半截 marker。
    if (created) try { fs.rmSync(file, { force: true }); } catch {}
    return { ok: false, file, code: "DELETE_TOMBSTONE_FAILED", error: error.message };
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch {}
  }
}

function markDeletionTombstoneDeleted(tabId) {
  const file = deletionPermanentFile(tabId);
  let fd;
  try {
    fs.mkdirSync(DELETION_TOMBSTONE_DIR, { recursive: true });
    fd = fs.openSync(file, "wx");
    fs.writeFileSync(fd, JSON.stringify({
      version: 1,
      state: "deleted",
      tabId: String(tabId || ""),
      deletedAt: Date.now(),
      pid: process.pid,
    }, null, 2), "utf-8");
    fs.fsyncSync(fd);
    try { fs.rmSync(deletionTombstoneFile(tabId), { force: true }); } catch {}
    return true;
  } catch (error) {
    if (error?.code === "EEXIST") return true;
    // 原 deleting 文件继续阻止迟到回写；调用方不得把这种终态不明情况报告为完整成功。
    return false;
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch {}
  }
}

export function isTabDeletionBlocked(tabId) {
  const id = String(tabId || "");
  return DELETING_TAB_IDS.has(id) || fs.existsSync(deletionTombstoneFile(id)) || fs.existsSync(deletionPermanentFile(id));
}

export function releaseClosedStoryDeletion(tabId) {
  const id = String(tabId || "");
  DELETING_TAB_IDS.delete(id);
  const { file, data } = readDeletionTombstone(id);
  if (data?.state === "deleted") return;
  try { fs.rmSync(file, { force: true }); } catch {}
}

function ensureDir() {
  if (!fs.existsSync(STORE_DIR)) fs.mkdirSync(STORE_DIR, { recursive: true });
}

function normPath(p) {
  // 统一分隔符（\ 与 / 视为等价）+ 去尾部斜杠 + 小写，避免重复判定漏判
  return String(p || "").replace(/[\\/]+/g, "/").replace(/\/+$/, "").toLowerCase();
}

// ========== 本地工程列表 ==========

function cleanLocalProjects(projects) {
  const source = (Array.isArray(projects) ? projects : [])
    .filter((p) => p && p.id && p.path)
    .map((p) => ({
      id: String(p.id),
      name: String(p.name || p.id),
      path: String(p.path),
      legacyWebAppPath: String(p.webAppPath || "").trim(),
    }));
  const cleaned = source.map(({ legacyWebAppPath, ...project }) => project);
  const usedIds = new Set(cleaned.map((project) => project.id));
  const usedPaths = new Set(cleaned.map((project) => normPath(project.path)));
  for (const project of source) {
    if (!project.legacyWebAppPath || usedPaths.has(normPath(project.legacyWebAppPath))) continue;
    const baseId = `${project.id}-webapp`;
    let id = baseId;
    if (usedIds.has(id)) {
      const suffix = createHash("sha256").update(project.legacyWebAppPath).digest("hex").slice(0, 8);
      id = `${baseId}-${suffix}`;
    }
    cleaned.push({
      id,
      name: `${project.name} WebApp`,
      path: project.legacyWebAppPath,
    });
    usedIds.add(id);
    usedPaths.add(normPath(project.legacyWebAppPath));
  }
  return cleaned;
}

function localApplicationId(seed, index = 0) {
  const digest = createHash("sha256")
    .update(`${String(seed || "application")}:${index}`)
    .digest("hex")
    .slice(0, 10);
  return `app-${digest}`;
}

function cleanProjectApplications(value, projects = []) {
  const projectIds = new Set(cleanLocalProjects(projects).map((project) => project.id));
  const usedApplicationIds = new Set();
  return (Array.isArray(value) ? value : [])
    .filter((application) => isPlainObject(application))
    .map((application, applicationIndex) => {
      const name = String(application.name || application.appName || "").trim();
      let id = String(application.id || "").trim() || localApplicationId(name, applicationIndex);
      if (usedApplicationIds.has(id)) id = localApplicationId(`${id}:${name}`, applicationIndex);
      usedApplicationIds.add(id);
      const repositories = [];
      for (const rawRepository of Array.isArray(application.repositories) ? application.repositories : []) {
        if (!isPlainObject(rawRepository)) continue;
        const repositoryId = String(rawRepository.repositoryId || rawRepository.repoId || "").trim();
        const referencedProjects = [...new Set((Array.isArray(rawRepository.projectIds) ? rawRepository.projectIds : [])
          .map((projectId) => String(projectId || "").trim())
          .filter((projectId) => projectId && projectIds.has(projectId)))];
        if (!repositoryId && !referencedProjects.length) continue;
        const existing = repositoryId
          ? repositories.find((repository) => repository.repositoryId === repositoryId)
          : null;
        if (existing) existing.projectIds = [...new Set([...existing.projectIds, ...referencedProjects])];
        else repositories.push({ repositoryId, projectIds: referencedProjects });
      }
      return { id, name, repositories };
    })
    .filter((application) => application.name || application.repositories.length);
}

function inferredProjectApplications(projects = []) {
  const groups = new Map();
  let definitions = null;
  for (const project of cleanLocalProjects(projects)) {
    const remoteKey = repositoryKey(gitRemoteUrl(project.path));
    if (remoteKey && !definitions) definitions = getProjectDefs();
    const remoteDefinitions = remoteKey
      ? definitions.filter((candidate) => (
        repositoryKey(candidate.ssh) === remoteKey || repositoryKey(candidate.https) === remoteKey
      ))
      : [];
    const liveBranch = gitBranch(project.path);
    const branchDefinitions = liveBranch
      ? remoteDefinitions.filter((candidate) => String(candidate.defaultBranch || "").trim() === liveBranch)
      : [];
    // AppMarket 主工程与 SDK 可以共享同一个 Git remote；此时不能永远取定义列表中的
    // 第一项。唯一命中的 defaultBranch 是比 remote 地址更具体的本机仓库身份证据。
    const definition = branchDefinitions.length === 1 ? branchDefinitions[0] : remoteDefinitions[0];
    const repositoryId = definition?.id || "";
    const groupKey = repositoryId || project.id;
    if (!groups.has(groupKey)) {
      groups.set(groupKey, {
        id: localApplicationId(groupKey),
        name: definition?.name || project.name,
        repositories: [{ repositoryId, projectIds: [] }],
      });
    }
    groups.get(groupKey).repositories[0].projectIds.push(project.id);
  }
  return [...groups.values()];
}

function projectApplicationsWithUnassigned(value, projects = []) {
  const cleanedProjects = cleanLocalProjects(projects);
  const applications = cleanProjectApplications(value, cleanedProjects);
  const assigned = new Set(applications.flatMap((application) => (
    application.repositories.flatMap((repository) => repository.projectIds)
  )));
  const unassigned = cleanedProjects.filter((project) => !assigned.has(project.id));
  if (!unassigned.length) return applications;
  return [...applications, ...inferredProjectApplications(unassigned)];
}

function withBranchSpecificRepositoryAliases(applications = [], projects = []) {
  const rows = cleanProjectApplications(applications, projects).map((application) => ({
    ...application,
    repositories: application.repositories.map((repository) => ({
      ...repository,
      projectIds: [...repository.projectIds],
    })),
  }));
  const definitions = getProjectDefs();
  for (const project of cleanLocalProjects(projects)) {
    const remoteKey = repositoryKey(gitRemoteUrl(project.path));
    const liveBranch = gitBranch(project.path);
    if (!remoteKey || !liveBranch) continue;
    const branchDefinitions = definitions.filter((definition) => (
      String(definition.defaultBranch || "").trim() === liveBranch
      && [definition.ssh, definition.https].some((remote) => repositoryKey(remote) === remoteKey)
    ));
    if (branchDefinitions.length !== 1) continue;
    const repositoryId = branchDefinitions[0].id;
    const alreadyBound = rows.some((application) => application.repositories.some((repository) => (
      repository.repositoryId === repositoryId && repository.projectIds.includes(project.id)
    )));
    if (alreadyBound) continue;
    const owner = rows.find((application) => application.repositories.some((repository) => (
      repository.projectIds.includes(project.id)
    )));
    if (!owner) continue;
    const repository = owner.repositories.find((candidate) => candidate.repositoryId === repositoryId);
    if (repository) repository.projectIds.push(project.id);
    else owner.repositories.push({ repositoryId, projectIds: [project.id] });
  }
  return rows;
}

function cleanRepositoryBindings(value) {
  const source = isPlainObject(value) ? value : {};
  const out = {};
  for (const [repositoryId, branches] of Object.entries(source)) {
    if (!safeDataKey(repositoryId) || !isPlainObject(branches)) continue;
    const cleanedBranches = {};
    for (const [branch, binding] of Object.entries(branches)) {
      if (!safeDataKey(branch) || !isPlainObject(binding)) continue;
      const projectId = String(binding.projectId || "").trim();
      if (!projectId) continue;
      cleanedBranches[branch] = {
        projectId,
        updatedAt: Math.max(0, Number(binding.updatedAt) || 0),
        source: String(binding.source || "config-inference-review").trim().slice(0, 80),
      };
    }
    if (Object.keys(cleanedBranches).length) out[repositoryId] = cleanedBranches;
  }
  return out;
}

function cleanLocalKnowledgeValueRevisions(value) {
  return (Array.isArray(value) ? value : [])
    .filter((row) => isPlainObject(row)
      && safeDataKey(String(row.id || ""))
      && safeDataKey(String(row.keyId || ""))
      && ["node", "user"].includes(String(row.scope || "")))
    .map((row) => ({
      ...cloneJson(row),
      id: String(row.id),
      keyId: String(row.keyId),
      scope: String(row.scope),
      scopeId: String(row.scopeId || ""),
      storage: "local",
    }))
    .slice(-2000);
}

function readLocalProjectsConfig() {
  try {
    const raw = JSON.parse(fs.readFileSync(LOCAL_PROJECTS_CONFIG, "utf-8"));
    return cleanLocalProjects(raw.projects);
  } catch {
    return null;
  }
}

function readLocalProjectsMeta() {
  try {
    const raw = JSON.parse(fs.readFileSync(LOCAL_PROJECTS_CONFIG, "utf-8"));
    return raw && typeof raw === "object" ? raw : null;
  } catch {
    return null;
  }
}

function normalizeCloneParentValue(value) {
  const raw = String(value || "").trim() || getDefaultCloneParent();
  if (!path.isAbsolute(raw)) {
    throw Object.assign(
      new Error("车型源码配置中的克隆父路径必须是绝对路径"),
      { code: "STORY_STORAGE_CLONE_PARENT_INVALID", statusCode: 400 },
    );
  }
  return path.resolve(raw);
}

/**
 * 故事点开始开发 / 创建 worktree 前：检测并落定本机 cloneParent。
 * 未配置时写入默认值（D:\workspace\AIProjects，无 D 盘则选剩余空间最大盘），并确保目录可用。
 */
export function ensureCloneParentReady() {
  loadLocalProjects();
  const meta = readLocalProjectsMeta();
  const configured = String(meta?.cloneParent || "").trim();
  if (!configured) {
    setLocalCloneParent(getDefaultCloneParent());
  }
  const parent = getLocalCloneParent();
  assertStoryDevRootSeparated(path.join(parent, ...STORYDEV_STORAGE_PARTS));
  ensureConfiguredStoryDevRoot(parent);
  return parent;
}

function ensureDirectory(target, label = "目录") {
  fs.mkdirSync(target, { recursive: true });
  const stat = fs.statSync(target);
  if (!stat.isDirectory()) {
    throw Object.assign(
      new Error(`${label}不是目录：${target}`),
      { code: "STORY_STORAGE_DIRECTORY_INVALID", statusCode: 400 },
    );
  }
  return target;
}

function storagePathError(message, code = "STORY_STORAGE_LINK_UNSAFE") {
  return Object.assign(new Error(message), { code, statusCode: 400 });
}

function realPathInside(root, target) {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative === "" || (relative !== ".."
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative));
}

function prospectiveRealPath(target) {
  const resolved = path.resolve(String(target || ""));
  let existing = resolved;
  while (!fs.existsSync(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) break;
    existing = parent;
  }
  if (!fs.existsSync(existing)) return resolved;
  const realExisting = fs.realpathSync.native(existing);
  return path.resolve(realExisting, path.relative(existing, resolved));
}

function storySourcePaths(projects = [], tabs = []) {
  const out = [];
  const add = (value, label) => {
    const raw = String(value || "").trim();
    if (raw && path.isAbsolute(raw)) out.push({ path: path.resolve(raw), label });
  };
  add(PROJECT_ROOT, "AIEfficiency 服务源码");
  for (const project of cleanLocalProjects(projects)) {
    add(project.path, `工程「${project.name}」`);
  }
  for (const tab of Array.isArray(tabs) ? tabs : []) {
    const label = `故事点「${String(tab?.title || tab?.id || "未命名")}」`;
    add(tab?.worktree?.root, `${label} worktree`);
    for (const entry of Array.isArray(tab?.worktree?.entries) ? tab.worktree.entries : []) {
      add(entry?.path, `${label} worktree 工程`);
      add(entry?.basePath, `${label}基仓`);
    }
    for (const repo of Array.isArray(tab?.remoteRepos) ? tab.remoteRepos : []) {
      add(repo?.path, `${label}远程工程`);
      add(repo?.basePath, `${label}远程基仓`);
    }
    for (const project of Array.isArray(tab?.extraProjects) ? tab.extraProjects : []) {
      add(project?.path, `${label}关联工程`);
    }
  }
  try {
    for (const entries of Object.values(loadLocalCheckouts())) {
      for (const checkout of Array.isArray(entries) ? entries : []) {
        add(checkout?.path, "本机 checkout");
      }
    }
  } catch {}
  return out;
}

function assertStoryDevRootSeparated(storyDevRoot, {
  projects = readLocalProjectsConfig() || [],
  tabs = loadTabs(),
  tab = null,
} = {}) {
  const lexicalRoot = path.resolve(storyDevRoot);
  const root = prospectiveRealPath(lexicalRoot);
  const sourceTabs = tab
    ? [...tabs.filter((item) => item?.id !== tab?.id), tab]
    : tabs;
  for (const source of storySourcePaths(projects, sourceTabs)) {
    const lexicalSource = path.resolve(source.path);
    const sourcePath = prospectiveRealPath(lexicalSource);
    const lexicalOverlap = realPathInside(lexicalRoot, lexicalSource)
      || realPathInside(lexicalSource, lexicalRoot);
    const physicalOverlap = realPathInside(root, sourcePath) || realPathInside(sourcePath, root);
    if (lexicalOverlap || physicalOverlap) {
      throw Object.assign(
        new Error(`故事点存储目录不能与源码路径重叠：${source.label}（${source.path}）`),
        { code: "STORY_STORAGE_SOURCE_OVERLAP", statusCode: 400 },
      );
    }
  }
  return root;
}

function ensurePlainStoryDirectory(target, label, realBoundary) {
  if (fs.existsSync(target)) {
    const linkStat = fs.lstatSync(target);
    if (linkStat.isSymbolicLink()) {
      throw storagePathError(`${label}不能是符号链接或目录联接：${target}`);
    }
    if (!linkStat.isDirectory()) {
      throw storagePathError(`${label}不是目录：${target}`, "STORY_STORAGE_DIRECTORY_INVALID");
    }
  } else {
    fs.mkdirSync(target);
  }
  const realTarget = fs.realpathSync.native(target);
  if (realBoundary && !realPathInside(realBoundary, realTarget)) {
    throw storagePathError(`${label}解析后超出 StoryDev 存储边界：${target}`);
  }
  return realTarget;
}

function ensureConfiguredStoryDevRoot(cloneParent) {
  const parent = normalizeCloneParentValue(cloneParent);
  ensureDirectory(parent, "克隆父路径");
  const realParent = fs.realpathSync.native(parent);
  const allDocs = path.join(parent, "AllDocs");
  ensurePlainStoryDirectory(allDocs, "AllDocs 目录", realParent);
  const storyDevRoot = path.join(allDocs, "StoryDev");
  ensurePlainStoryDirectory(storyDevRoot, "故事点存档目录", realParent);
  return storyDevRoot;
}

function saveLocalProjects(projects, {
  cloneParent,
  repositoryBindings,
  knowledgeValueRevisions,
  projectApplications,
} = {}) {
  const previous = readLocalProjectsMeta();
  const localCloneParent = normalizeCloneParentValue(
    cloneParent === undefined ? previous?.cloneParent : cloneParent,
  );
  const cleanedProjects = cleanLocalProjects(projects);
  assertStoryDevRootSeparated(path.join(localCloneParent, "AllDocs", "StoryDev"), {
    projects: cleanedProjects,
  });
  ensureConfiguredStoryDevRoot(localCloneParent);
  const applications = projectApplicationsWithUnassigned(
    projectApplications === undefined ? previous?.applications : projectApplications,
    cleanedProjects,
  );
  fs.mkdirSync(path.dirname(LOCAL_PROJECTS_CONFIG), { recursive: true });
  fs.writeFileSync(LOCAL_PROJECTS_CONFIG, JSON.stringify({
    version: 4,
    updatedAt: new Date().toISOString(),
    cloneParent: localCloneParent,
    repositoryBindings: cleanRepositoryBindings(
      repositoryBindings === undefined ? previous?.repositoryBindings : repositoryBindings,
    ),
    knowledgeValueRevisions: cleanLocalKnowledgeValueRevisions(
      knowledgeValueRevisions === undefined ? previous?.knowledgeValueRevisions : knowledgeValueRevisions,
    ),
    applications,
    projects: cleanedProjects,
  }, null, 2), "utf-8");
}

function loadLocalProjects() {
  const local = readLocalProjectsConfig();
  if (local !== null) return local;

  // 兼容旧版本：首次运行时把受 Git 管理配置中的绝对路径迁到本地目录。
  // 不在此处改写旧文件，避免升级过程中意外覆盖用户尚未保存的配置。
  try {
    const raw = JSON.parse(fs.readFileSync(MARKET_CONFIG, "utf-8"));
    const migrated = cleanLocalProjects(raw.projects);
    saveLocalProjects(migrated, { cloneParent: raw.cloneParent });
    return migrated;
  } catch {
    saveLocalProjects([]);
    return [];
  }
}

function getLocalCloneParent() {
  loadLocalProjects();
  return normalizeCloneParentValue(readLocalProjectsMeta()?.cloneParent);
}

function setLocalCloneParent(cloneParent) {
  const normalized = normalizeCloneParentValue(cloneParent);
  saveLocalProjects(loadLocalProjects(), { cloneParent: normalized });
}

function repositoryBindingBranchKey(branch) {
  return String(branch || "").trim() || "*";
}

function getRepositoryBindingProject(repositoryId, branch = "") {
  const bindings = cleanRepositoryBindings(readLocalProjectsMeta()?.repositoryBindings);
  const repository = bindings[String(repositoryId || "").trim()] || {};
  const exact = repository[repositoryBindingBranchKey(branch)];
  const fallback = repository["*"];
  const projectId = String(exact?.projectId || fallback?.projectId || "").trim();
  const project = projectId ? getProject(projectId) : null;
  return project?.path && fs.existsSync(project.path) ? project : null;
}

function saveRepositoryBindings(bindings = []) {
  const next = cleanRepositoryBindings(readLocalProjectsMeta()?.repositoryBindings);
  const now = Date.now();
  for (const binding of Array.isArray(bindings) ? bindings : []) {
    const repositoryId = String(binding?.repositoryId || "").trim();
    const projectId = String(binding?.projectId || "").trim();
    if (!repositoryId || !projectId || !getProject(projectId)) continue;
    const branchKey = repositoryBindingBranchKey(binding?.branch);
    next[repositoryId] = isPlainObject(next[repositoryId]) ? next[repositoryId] : {};
    next[repositoryId][branchKey] = {
      projectId,
      updatedAt: now,
      source: "config-inference-review",
    };
  }
  saveLocalProjects(loadLocalProjects(), { repositoryBindings: next });
}

function loadLocalKnowledgeValueRevisions() {
  return cleanLocalKnowledgeValueRevisions(readLocalProjectsMeta()?.knowledgeValueRevisions);
}

function saveLocalKnowledgeValueRevisions(revisions = []) {
  saveLocalProjects(loadLocalProjects(), { knowledgeValueRevisions: revisions });
}

export function __testRememberConfigInferenceLocalBindings(bindings = []) {
  saveRepositoryBindings(bindings);
  return cleanRepositoryBindings(readLocalProjectsMeta()?.repositoryBindings);
}

export function listProjects() {
  return loadLocalProjects().map((p) => ({
    ...p,
    // 路径是否存在（前端可提示）
    exists: fs.existsSync(p.path),
  }));
}

export function getProjectApplications() {
  const projects = loadLocalProjects();
  return withBranchSpecificRepositoryAliases(
    projectApplicationsWithUnassigned(readLocalProjectsMeta()?.applications, projects),
    projects,
  );
}

export function setProjectApplications(applications = []) {
  if (!Array.isArray(applications)) return { ok: false, error: "应用配置格式不正确" };
  for (const application of applications) {
    if (!String(application?.name || application?.appName || "").trim()) {
      return { ok: false, error: "应用名称不能为空" };
    }
    for (const repository of Array.isArray(application?.repositories) ? application.repositories : []) {
      if (!String(repository?.repositoryId || repository?.repoId || "").trim()) {
        return { ok: false, error: `应用「${application.name || application.appName}」存在未选择仓库的配置` };
      }
    }
  }
  const projects = loadLocalProjects();
  const cleaned = cleanProjectApplications(applications, projects);
  saveLocalProjects(projects, { projectApplications: cleaned });
  return { ok: true, applications: getProjectApplications() };
}

export function getProject(id) {
  return listProjects().find((p) => p.id === id) || null;
}

// 按本地路径找已登记工程（用于把"关联工程"提升为主工程时反查其 projectId）
export function getProjectByPath(p) {
  const k = normPath(p);
  if (!k) return null;
  return listProjects().find((x) => normPath(x.path) === k) || null;
}

/**
 * 读取某工程当前 git 分支（直接解析 .git/HEAD，无需 spawn git）。
 * 支持普通仓库与 worktree/submodule（.git 为文件指向 gitdir）。
 * 返回分支名；游离 HEAD 返回短 sha + (detached)；非仓库/出错返回 null。
 */
export function gitBranch(projPath) {
  try {
    if (!projPath || !fs.existsSync(projPath)) return null;
    let gitPath = path.join(projPath, ".git");
    if (!fs.existsSync(gitPath)) return null;
    let gitDir = gitPath;
    if (fs.statSync(gitPath).isFile()) {
      const m = fs.readFileSync(gitPath, "utf-8").trim().match(/^gitdir:\s*(.+)$/m);
      if (!m) return null;
      gitDir = path.resolve(projPath, m[1].trim());
    }
    const headPath = path.join(gitDir, "HEAD");
    if (!fs.existsSync(headPath)) return null;
    const head = fs.readFileSync(headPath, "utf-8").trim();
    const rm = head.match(/^ref:\s*refs\/heads\/(.+)$/);
    if (rm) return rm[1];
    return head.slice(0, 8) + " (detached)";
  } catch {
    return null;
  }
}

// 找到指定左大括号对应的右大括号。跳过字符串与注释里的括号，避免 URL、注释示例等干扰配平。
function findGradleBlockEnd(content, openIndex) {
  let depth = 0;
  let quote = null;
  let lineComment = false;
  let blockComment = false;
  for (let i = openIndex; i < content.length; i++) {
    const c = content[i], n = content[i + 1];
    if (lineComment) {
      if (c === "\n") lineComment = false;
      continue;
    }
    if (blockComment) {
      if (c === "*" && n === "/") { blockComment = false; i++; }
      continue;
    }
    if (quote) {
      if (c === "\\") { i++; continue; }
      if (c === quote) quote = null;
      continue;
    }
    if (c === "/" && n === "/") { lineComment = true; i++; continue; }
    if (c === "/" && n === "*") { blockComment = true; i++; continue; }
    if (c === "'" || c === '"') { quote = c; continue; }
    if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return i;
  }
  return -1;
}

// 取出 `keyword { ... }` 的大括号内容（按括号配平）。
function extractGradleBlock(content, keyword) {
  const re = new RegExp(keyword + "\\s*\\{");
  const m = re.exec(content);
  if (!m) return null;
  const open = m.index + m[0].lastIndexOf("{");
  const close = findGradleBlockEnd(content, open);
  return close >= 0 ? content.slice(open + 1, close) : null;
}

// 从 productFlavors 块里解析顶层 flavor 及其 dimension。
// 兼容 `name {}`、`create("name") {}`、`register("name") {}` 等 Groovy/Kotlin DSL 写法。
const GRADLE_NON_FLAVOR = new Set(["create", "register", "maybeCreate", "getByName", "all", "each", "configureEach", "dimension", "flavorDimensions"]);
function parseGradleFlavorEntries(block) {
  const entries = [];
  let i = 0;
  while (i < block.length) {
    const rest = block.slice(i);
    const factory = /^(?:create|register|maybeCreate)\s*\(\s*["']([A-Za-z][A-Za-z0-9_-]*)["']\s*\)\s*\{/.exec(rest);
    const direct = factory ? null : /^([A-Za-z][A-Za-z0-9_]*)\s*\{/.exec(rest);
    const m = factory || direct;
    if (!m) { i++; continue; }
    const name = m[1];
    const open = i + m[0].lastIndexOf("{");
    const close = findGradleBlockEnd(block, open);
    if (close < 0) break;
    const body = block.slice(open + 1, close);
    if (!GRADLE_NON_FLAVOR.has(name)) {
      const dm = /\bdimension\s*(?:=\s*)?["']([^"']+)["']/.exec(body);
      entries.push({ name, dimension: dm ? dm[1] : null });
    }
    i = close + 1;
  }
  return entries;
}

function parseFlavorDimensionOrder(content, entries) {
  const out = [];
  const seen = new Set();
  const add = (name) => { if (name && !seen.has(name)) { seen.add(name); out.push(name); } };
  const re = /\bflavorDimensions\b([^\r\n]*)/g;
  let m;
  while ((m = re.exec(content))) {
    for (const q of m[1].matchAll(/["']([^"']+)["']/g)) add(q[1]);
  }
  // 部分脚本没有显式 flavorDimensions，按 productFlavors 中首次出现的 dimension 顺序兜底。
  if (!out.length) for (const entry of entries) add(entry.dimension);
  return out;
}

function buildGradleFlavorInfo(content, entries) {
  const names = [...new Set(entries.map((entry) => entry.name))];
  const dimensions = parseFlavorDimensionOrder(content, entries);
  // devbench 的目标 flavor 只展示车型维度；没有 car 时兼容取第一个声明维度。
  const primaryDimension = dimensions.includes("car") ? "car" : dimensions[0];
  const primaryNames = primaryDimension
    ? entries.filter((entry) => entry.dimension === primaryDimension).map((entry) => entry.name)
    : names;
  const flavors = [...new Set(primaryNames.length ? primaryNames : names)];
  if (dimensions.length < 2) return { flavors, buildVariants: flavors };
  const groups = dimensions.map((dimension) => entries.filter((entry) => entry.dimension === dimension).map((entry) => entry.name));
  if (groups.some((group) => group.length === 0)) return { flavors, buildVariants: flavors };
  let combinations = [""];
  for (const group of groups) {
    combinations = combinations.flatMap((prefix) => group.map((name) =>
      prefix ? prefix + name.charAt(0).toUpperCase() + name.slice(1) : name));
  }
  // 无 dimension 的条目无法参与笛卡尔积，仍保留为独立 flavor，避免静默丢失自定义变体。
  const ungrouped = entries.filter((entry) => !entry.dimension || !dimensions.includes(entry.dimension)).map((entry) => entry.name);
  return { flavors, buildVariants: [...new Set([...combinations, ...ungrouped])] };
}

function parseGradleFlavorInfo(content) {
  const block = extractGradleBlock(content, "productFlavors");
  if (!block) return { flavors: [], buildVariants: [] };
  return buildGradleFlavorInfo(content, parseGradleFlavorEntries(block));
}

/**
 * 从远程分支读取到的固定文件内容解析车型。解析规则与本机工程保持同源：
 * flavorConfig.json 优先；无有效 JSON 配置时再看根目录或 app/ 下的 project_flavor.gradle。
 */
export function getAndroidFlavorInfoFromFiles(files = {}) {
  const source = isPlainObject(files) ? files : {};
  const errors = [];
  if (Object.prototype.hasOwnProperty.call(source, "flavorConfig.json")) {
    try {
      const parsed = JSON.parse(String(source["flavorConfig.json"] || ""));
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return {
          isAndroid: true,
          flavors: Object.keys(parsed),
          source: "flavorConfig.json",
          errors,
        };
      }
      errors.push("flavorConfig.json 顶层必须是对象");
    } catch (error) {
      errors.push(`flavorConfig.json 解析失败：${String(error?.message || error).slice(0, 240)}`);
    }
  }
  for (const file of ["project_flavor.gradle", "app/project_flavor.gradle"]) {
    if (!Object.prototype.hasOwnProperty.call(source, file)) continue;
    const info = parseGradleFlavorInfo(String(source[file] || ""));
    if (info.flavors.length) {
      return { isAndroid: true, ...info, source: file, errors };
    }
  }
  return {
    isAndroid: Object.keys(source).length > 0,
    flavors: [],
    buildVariants: [],
    source: "",
    errors,
  };
}

// flavorConfig.json：存在时仍是 flavor 与各 flavor 版本（versionName/versionCode）的优先来源。
function flavorConfigPath(projectPath) { return path.join(projectPath, "flavorConfig.json"); }
function readFlavorConfig(projectPath) {
  try {
    const f = flavorConfigPath(projectPath);
    if (!fs.existsSync(f)) return null;
    const obj = JSON.parse(fs.readFileSync(f, "utf-8"));
    return obj && typeof obj === "object" && !Array.isArray(obj) ? obj : null;
  } catch { return null; }
}
function looksAndroid(projectPath) {
  return ["build.gradle", "build.gradle.kts", "settings.gradle", "settings.gradle.kts"]
    .some((n) => fs.existsSync(path.join(projectPath, n)));
}

/**
 * 解析 Android 工程的 product flavors。
 * 规则：优先解析工程根目录 flavorConfig.json 的顶层 key；不存在时解析专用的
 * project_flavor.gradle。界面仅返回 car（车型）维度；同时返回内部构建变体，供编译面板把
 * car=geelyss21 展开为 geelyss21Prod / geelyss21Stg 等实际 Gradle 任务。
 * 为避免普通 build.gradle 中其它模块/示例 DSL 产生误报，不对任意 build.gradle 做 flavor 扫描。
 * 返回 { isAndroid, flavors }。
 */
export function getAndroidFlavors(projectPath) {
  if (!projectPath || !fs.existsSync(projectPath)) return { isAndroid: false, flavors: [] };
  const cfg = readFlavorConfig(projectPath);
  if (cfg) return { isAndroid: true, flavors: Object.keys(cfg) };
  const candidates = [
    path.join(projectPath, "project_flavor.gradle"),
    path.join(projectPath, "app", "project_flavor.gradle"),
  ];
  for (const file of candidates) {
    if (!fs.existsSync(file)) continue;
    const info = parseGradleFlavorInfo(readFileSafe(file));
    if (info.flavors.length) return { isAndroid: true, ...info };
  }
  return { isAndroid: looksAndroid(projectPath), flavors: [] };
}

// 把 UI 选择的 car flavor 展开成实际可执行的多维 Gradle 变体；单维/flavorConfig 工程原样返回。
export function expandAndroidBuildFlavors(projectPath, selectedFlavors) {
  const selected = [...new Set((Array.isArray(selectedFlavors) ? selectedFlavors : []).filter(Boolean))];
  const variants = getAndroidFlavors(projectPath).buildVariants || [];
  if (!variants.length) return selected;
  return [...new Set(selected.flatMap((flavor) => {
    const matched = variants.filter((variant) => variant === flavor ||
      (variant.startsWith(flavor) && /^[A-Z]/.test(variant.slice(flavor.length, flavor.length + 1))));
    return matched.length ? matched : [flavor];
  }))];
}

// ===== Android 版本名/版本号（按用户规则：versionCode = 主×10000 + 次×100 + 修订）=====

// 解析 A.B.C：末段是“两位修订号(00-99)”，单个数字视为十位（尾0默认省略），如 "7"→70、"3"→30；两位及以上字面，如 "07"→7、"80"→80。
export function splitVer(name) {
  const parts = String(name || "").trim().split(".");
  const a = parseInt(parts[0], 10) || 0;
  const b = parseInt(parts[1], 10) || 0;
  const raw = parts[2] != null ? String(parts[2]).trim() : "0";
  const num = parseInt(raw, 10) || 0;
  const tail = raw.length <= 1 ? num * 10 : num; // 单字符=十位
  return { a, b, tail };
}
function normalizedVerParts(a, b, tail) {
  let nextA = a, nextB = b, nextTail = tail;
  while (nextTail >= 100) { nextTail -= 100; nextB += 1; }
  while (nextB >= 100) { nextB -= 100; nextA += 1; }
  return { a: nextA, b: nextB, tail: nextTail };
}
// 由 a/b/tail 组回版本名：末段进位(≥100 进到次版本)，并补足两位(02/08/80/110)。
export function composeVersion(a, b, tail) {
  const p = normalizedVerParts(a, b, tail);
  return `${p.a}.${p.b}.${p.tail === 0 ? "0" : String(p.tail).padStart(2, "0")}`;
}
// versionName "A.B.C" → versionCode（末段按 splitVer 归一化为两位修订；1.1.3→10130、1.4.70→10470）
function versionNameToCodeWithWidth(name, width) {
  const { a, b, tail } = splitVer(name);
  return width === 3 ? a * 100000 + b * 1000 + tail : a * 10000 + b * 100 + tail;
}
function versionCodeWidthForName(name, code) {
  const n = Number(code);
  if (!Number.isFinite(n)) return null;
  if (n === versionNameToCodeWithWidth(name, 3)) return 3;
  if (n === versionNameToCodeWithWidth(name, 2)) return 2;
  return String(Math.abs(Math.trunc(n))).length >= 6 ? 3 : 2;
}
export function versionNameToCode(name, currentCode = null) {
  return versionNameToCodeWithWidth(name, versionCodeWidthForName(name, currentCode) || 2);
}
function nextVersionNameToCode(oldName, oldCode, newName) {
  const old = splitVer(oldName);
  const oldParts = normalizedVerParts(old.a, old.b, old.tail);
  const nextParts = splitVer(newName);
  const crossedMinor = nextParts.a !== oldParts.a || nextParts.b !== oldParts.b;
  const width = crossedMinor && nextParts.tail === 0 ? 3 : (versionCodeWidthForName(oldName, oldCode) || 2);
  return versionNameToCodeWithWidth(newName, width);
}
// 加10：末段(两位修订)+10。1.1.7(=70)→1.1.80
export function bumpVersionName(name) {
  const { a, b, tail } = splitVer(name);
  return composeVersion(a, b, tail + 10);
}
// 提升为交付版本：向上取最近的“尾号为0”的版本（即末段向上取到 10 的倍数）。1.1.01/1.1.07→1.1.10
export function deliverVersionName(name) {
  const { a, b, tail } = splitVer(name);
  return composeVersion(a, b, Math.ceil(tail / 10) * 10);
}
// 更新测试版本号：末段 +1，且结果尾号不能为 0（落到 10 倍数则再 +1）。1.1.01→1.1.02、1.1.09→1.1.11
export function testVersionName(name) {
  const { a, b, tail } = splitVer(name);
  let t = tail + 1;
  if (t % 10 === 0) t += 1;
  return composeVersion(a, b, t);
}

function readFileSafe(f) { try { return fs.readFileSync(f, "utf-8"); } catch { return ""; } }

// 工程内可能含版本定义的 gradle 文件（仅本工程目录，不扫 workspace）。project_flavor.gradle 优先。
function versionGradleFiles(projectPath) {
  const out = [];
  const add = (f) => { try { if (fs.existsSync(f) && fs.statSync(f).isFile() && !out.includes(f)) out.push(f); } catch {} };
  add(path.join(projectPath, "project_flavor.gradle"));
  add(path.join(projectPath, "app", "project_flavor.gradle"));
  add(path.join(projectPath, "app", "build.gradle"));
  add(path.join(projectPath, "app", "build.gradle.kts"));
  add(path.join(projectPath, "build.gradle"));
  add(path.join(projectPath, "build.gradle.kts"));
  add(path.join(projectPath, "config.gradle"));
  add(path.join(projectPath, "gradle.properties"));
  try {
    for (const e of fs.readdirSync(projectPath, { withFileTypes: true })) {
      if (e.isDirectory() && !e.name.startsWith(".") && !["build", "node_modules"].includes(e.name)) {
        for (const n of ["project_flavor.gradle", "build.gradle", "build.gradle.kts"]) add(path.join(projectPath, e.name, n));
      }
    }
  } catch {}
  return out;
}

// 找 versionName 字面量来源（含 `versionName rootProject.ext.X` 变量解析）。返回 { file, value, full } 或 null。
function findVersionName(files) {
  const litRe = /versionName\s*=?\s*['"]([0-9][0-9.]*)['"]/;
  for (const f of files) { const m = readFileSafe(f).match(litRe); if (m) return { file: f, value: m[1], full: m[0] }; }
  for (const f of files) {
    const m = readFileSafe(f).match(/versionName\s+([A-Za-z_][\w.]*)/);
    if (!m) continue;
    const v = m[1].split(".").pop();
    const defRe = new RegExp(v + "\\s*=\\s*['\"]([0-9][0-9.]*)['\"]");
    for (const g of files) { const mm = readFileSafe(g).match(defRe); if (mm) return { file: g, value: mm[1], full: mm[0] }; }
  }
  return null;
}
// 找 versionCode 字面量来源（含变量解析）。返回 { file, value, full } 或 null。
function findVersionCode(files) {
  for (const f of files) { const m = readFileSafe(f).match(/versionCode\s*=?\s*(\d+)\b/); if (m) return { file: f, value: parseInt(m[1], 10), full: m[0] }; }
  for (const f of files) {
    const m = readFileSafe(f).match(/versionCode\s+([A-Za-z_][\w.]*)/);
    if (!m) continue;
    const v = m[1].split(".").pop();
    const defRe = new RegExp(v + "\\s*=\\s*(\\d+)\\b");
    for (const g of files) { const mm = readFileSafe(g).match(defRe); if (mm) return { file: g, value: parseInt(mm[1], 10), full: mm[0] }; }
  }
  return null;
}

// 多 flavor 的 project_flavor.gradle：在“名字匹配所选 flavor 的 productFlavor 块”里取版本。
// flavor 可能是组合名（如 seresProd），匹配 car 维度块名（seres）—— 取能匹配到的最长块名，避免误取第一个 flavor。
// 返回 { versionName, versionCode, file } 或 null。
function findFlavorBlockVersion(files, flavor) {
  if (!flavor) return null;
  const fl = String(flavor).toLowerCase();
  let best = null;
  for (const f of files) {
    const text = readFileSafe(f);
    if (!text) continue;
    const re = /([A-Za-z]\w*)\s*\{([^{}]*)\}/g; // 平铺块（块内无嵌套花括号，flavor 块即如此）
    let m;
    while ((m = re.exec(text))) {
      const name = m[1].toLowerCase(), body = m[2];
      const vn = body.match(/versionName\s*=?\s*['"]([0-9][0-9.]*)['"]/);
      if (!vn) continue; // 只认带 versionName 的块
      if (fl === name || fl.startsWith(name) || fl.includes(name)) {
        if (!best || name.length > best.nameLen) {
          const vc = body.match(/versionCode\s*=?\s*(\d+)\b/);
          best = { nameLen: name.length, versionName: vn[1], versionCode: vc ? parseInt(vc[1], 10) : null, file: f };
        }
      }
    }
  }
  return best;
}

// 读取工程当前 versionName/versionCode（best-effort）。返回 { ok, versionName, versionCode, nameFile, codeFile } 或 { ok:false }。
export function readProjectVersion(projectPath, flavor) {
  if (!projectPath || !fs.existsSync(projectPath)) return { ok: false };
  // flavorConfig.json 优先：选定 flavor 的版本以它为准
  const cfg = readFlavorConfig(projectPath);
  if (cfg && flavor && cfg[flavor] && typeof cfg[flavor] === "object") {
    const e = cfg[flavor];
    const vn = e.versionName != null ? String(e.versionName) : null;
    const vc = e.versionCode != null ? parseInt(e.versionCode, 10) : (vn ? versionNameToCode(vn) : null);
    if (vn || vc != null) {
      return { ok: true, versionName: vn, versionCode: vc, nameFile: "flavorConfig.json", codeFile: "flavorConfig.json", source: "flavorConfig" };
    }
  }
  const files = versionGradleFiles(projectPath);
  // 多 flavor 的 project_flavor.gradle：优先取“名字匹配所选 flavor 的块”里的版本（否则会误取第一个 flavor 的版本）
  const fb = findFlavorBlockVersion(files, flavor);
  if (fb) {
    const rel = path.relative(projectPath, fb.file);
    return {
      ok: true,
      versionName: fb.versionName,
      versionCode: fb.versionCode != null ? fb.versionCode : versionNameToCode(fb.versionName),
      nameFile: rel, codeFile: rel, source: "gradle",
    };
  }
  const n = findVersionName(files);
  const c = findVersionCode(files);
  if (!n && !c) return { ok: false };
  return {
    ok: true,
    versionName: n ? n.value : null,
    versionCode: c ? c.value : (n ? versionNameToCode(n.value) : null),
    nameFile: n ? path.relative(projectPath, n.file) : null,
    codeFile: c ? path.relative(projectPath, c.file) : null,
    source: "gradle",
  };
}

// 在 gradle 文件里把“名字匹配 flavor 的 productFlavor 块”内的 versionName/versionCode 替换为新值。成功返回 true。
function writeFlavorBlockVersion(file, flavor, newName, newCode) {
  let text = readFileSafe(file);
  if (!text) return false;
  const fl = String(flavor).toLowerCase();
  const re = /([A-Za-z]\w*)\s*\{([^{}]*)\}/g;
  let m, target = null;
  while ((m = re.exec(text))) {
    const name = m[1].toLowerCase(), body = m[2];
    if (!/versionName/.test(body)) continue;
    if (fl === name || fl.startsWith(name) || fl.includes(name)) {
      if (!target || name.length > target.nameLen) target = { nameLen: name.length, start: m.index, full: m[0] };
    }
  }
  if (!target) return false;
  let nb = target.full;
  nb = nb.replace(/(versionName\s*=?\s*['"])([0-9][0-9.]*)(['"])/, `$1${newName}$3`);
  nb = nb.replace(/(versionCode\s*=?\s*)(\d+)/, `$1${newCode}`);
  text = text.slice(0, target.start) + nb + text.slice(target.start + target.full.length);
  fs.writeFileSync(file, text, "utf-8");
  return true;
}

const VERSION_OPS = { bump10: bumpVersionName, deliver: deliverVersionName, test: testVersionName };

// 对工程当前版本执行一种操作（bump10=加10 / deliver=提升为交付版本 / test=更新测试版本号）并写回（按 flavor 块）。
// 返回 { ok, versionName, versionCode, files:[改动文件名], source } 或 { ok:false, error }。
export function applyVersionOp(projectPath, flavor, opName = "bump10") {
  const op = VERSION_OPS[opName] || bumpVersionName;
  if (!projectPath || !fs.existsSync(projectPath)) return { ok: false, error: "工程路径不存在" };
  // flavorConfig.json 优先：把新版本写回 flavorConfig.json[flavor]
  const cfg = readFlavorConfig(projectPath);
  if (cfg && flavor && cfg[flavor] && typeof cfg[flavor] === "object") {
    const e = cfg[flavor];
    const oldName = e.versionName != null ? String(e.versionName) : "0.0.0";
    const newName = op(oldName);
    const oldCode = e.versionCode != null ? parseInt(e.versionCode, 10) : null;
    const newCode = nextVersionNameToCode(oldName, oldCode, newName);
    e.versionName = newName;
    e.versionCode = newCode;
    try {
      fs.writeFileSync(flavorConfigPath(projectPath), JSON.stringify(cfg, null, 2), "utf-8");
    } catch (err) {
      return { ok: false, error: `写入 flavorConfig.json 失败: ${err.message}` };
    }
    return { ok: true, versionName: newName, versionCode: newCode, files: ["flavorConfig.json"], source: "flavorConfig" };
  }
  const files = versionGradleFiles(projectPath);
  // 多 flavor：优先在所选 flavor 块内读取并写回（否则会改到第一个 flavor）
  const fb = findFlavorBlockVersion(files, flavor);
  if (fb) {
    const newName = op(fb.versionName);
    const newCode = nextVersionNameToCode(fb.versionName, fb.versionCode, newName);
    try {
      if (!writeFlavorBlockVersion(fb.file, flavor, newName, newCode)) throw new Error("未能定位 flavor 块写回");
    } catch (err) {
      return { ok: false, error: `写入失败: ${err.message}` };
    }
    return { ok: true, versionName: newName, versionCode: newCode, files: [path.basename(fb.file)], source: "gradle" };
  }
  // 退回：首个 versionName 字面量
  const n = findVersionName(files);
  if (!n) return { ok: false, error: "未找到 versionName 定义（flavorConfig.json / project_flavor.gradle / build.gradle 都没解析到）" };
  const c = findVersionCode(files);
  const newName = op(n.value);
  const newCode = nextVersionNameToCode(n.value, c?.value, newName);
  const changed = new Set();
  try {
    let nc = readFileSafe(n.file);
    nc = nc.replace(n.full, n.full.replace(n.value, newName));
    fs.writeFileSync(n.file, nc, "utf-8");
    changed.add(path.basename(n.file));
    if (c) {
      let cc = (c.file === n.file) ? readFileSafe(n.file) : readFileSafe(c.file);
      cc = cc.replace(c.full, c.full.replace(String(c.value), String(newCode)));
      fs.writeFileSync(c.file, cc, "utf-8");
      changed.add(path.basename(c.file));
    }
  } catch (e) {
    return { ok: false, error: `写入失败: ${e.message}` };
  }
  return { ok: true, versionName: newName, versionCode: newCode, files: [...changed], source: "gradle" };
}
// 兼容旧名：加10
export function bumpProjectVersion(projectPath, flavor) { return applyVersionOp(projectPath, flavor, "bump10"); }

// 读取某故事点为某工程选定的目标 flavor（无则 null）
export function getTabFlavor(tab, projectPath) {
  const k = normPath(projectPath);
  return (tab.flavors || []).find((x) => normPath(x.path) === k)?.flavor || null;
}
// 设置/清除某工程的目标 flavor（flavor 为空=清除）。返回更新后的 tab。
export function setTabFlavor(tab, projectPath, flavor) {
  const k = normPath(projectPath);
  const list = (tab.flavors || []).filter((x) => normPath(x.path) !== k);
  if (flavor) list.push({ path: projectPath, flavor });
  return updateTab(tab.id, { flavors: list });
}

// ===== 临时产物隔离 + 存档目录（slug）规则 =====

/**
 * @deprecated 故事点资料统一存到 cloneParent/AllDocs/StoryDev，禁止再修改源码 worktree。
 * 保留导出仅用于兼容旧调用方；它现在明确不执行任何文件系统写入。
 */
export function ensureTempFilesIsolation(projectPath) {
  return false;
}

// 文件系统安全 slug：去控制字符/孤立代理对/非法文件名字符，空白转下划线，限长 24 个码位
function fsSafeSlug(s, maxLen = 24) {
  const str = String(s == null ? "" : s);
  let out = "";
  for (const ch of str) {
    const cp = ch.codePointAt(0);
    if (cp < 0x20 || cp === 0x7f) continue;
    if (cp >= 0xd800 && cp <= 0xdfff) continue;
    if ("\/:*?\"<>|".indexOf(ch) >= 0) continue;
    out += /\s/.test(ch) ? "_" : ch;
  }
  out = Array.from(out).slice(0, maxLen).join("").replace(/^[._]+|[._]+$/g, "").trim();
  return out || "story";
}

/**
 * 故事点存档目录 slug：优先用标题里的 #TB单号#，否则用任务名简述。
 * 一旦确定即写回 tab.docSlug 固定下来（标题后续改动不影响已有存档路径）。
 */
// 按规则算存档目录 slug（纯函数、不读/写缓存）：
//   TB 单 → "#<TB单号>#<标题名>"（便于按单号识别归档，如 #CARB-12505#【Geely】…）；非 TB → 「标题名」。
export function computeDocSlug(tab) {
  const m = String((tab && tab.title) || "").match(/^\s*#([^#]+)#\s*([\s\S]*)$/);
  const tb = m ? m[1].trim() : "";
  const name = (m ? m[2] : ((tab && tab.title) || "")).trim();
  return tb ? fsSafeSlug(`#${tb}#${name || tb}`, 40) : fsSafeSlug(name || tb);
}
export function ensureDocSlug(tab) {
  if (tab && tab.docSlug) return tab.docSlug;
  const slug = computeDocSlug(tab);
  try { if (tab && tab.id) updateTab(tab.id, { docSlug: slug }); } catch {}
  if (tab) tab.docSlug = slug;
  return slug;
}

const STORYDEV_STORAGE_PARTS = ["AllDocs", "StoryDev"];

function cloneParentPath(value = getLocalCloneParent()) {
  return normalizeCloneParentValue(value);
}

function validFrozenStoryDevRoot(value) {
  const raw = String(value || "").trim();
  if (!raw || !path.isAbsolute(raw)) return "";
  const resolved = path.resolve(raw);
  if (path.basename(resolved).toLowerCase() !== "storydev") return "";
  if (path.basename(path.dirname(resolved)).toLowerCase() !== "alldocs") return "";
  return resolved;
}

export function configuredStoryDevRoot({ create = false } = {}) {
  const root = path.join(cloneParentPath(), ...STORYDEV_STORAGE_PARTS);
  assertStoryDevRootSeparated(root);
  if (create) return ensureConfiguredStoryDevRoot(cloneParentPath());
  return root;
}

/**
 * 故事点资料的唯一目录来源。
 *
 * 每个故事点首次落定 storyStorageRoot 后保持不变，避免用户随后修改 cloneParent 时，
 * 同一故事点的 TXT、附件、验收报告和临时脚本被拆到两个位置。
 */
export function getStoryStoragePaths(tab, { create = false, persist = true } = {}) {
  const frozenRoot = validFrozenStoryDevRoot(tab?.storyStorageRoot);
  if (String(tab?.storyStorageRoot || "").trim() && !frozenRoot) {
    throw Object.assign(
      new Error("故事点已冻结的存储根目录无效，拒绝回退到其它目录"),
      { code: "STORY_STORAGE_ROOT_INVALID", statusCode: 400 },
    );
  }
  let storyDevRoot = frozenRoot || configuredStoryDevRoot();
  assertStoryDevRootSeparated(storyDevRoot, { tab });
  if (create) {
    const ensuredRoot = ensureConfiguredStoryDevRoot(path.dirname(path.dirname(storyDevRoot)));
    if (normPath(ensuredRoot) !== normPath(storyDevRoot)) {
      throw storagePathError("故事点冻结的 StoryDev 根目录与创建结果不一致");
    }
    storyDevRoot = ensuredRoot;
    assertStoryDevRootSeparated(storyDevRoot, { tab });
  }
  const slugCheck = validateDeletionDocSlug(ensureDocSlug(tab));
  if (!slugCheck.ok) {
    throw Object.assign(
      new Error(slugCheck.reason),
      { code: "STORY_STORAGE_DOC_SLUG_INVALID", statusCode: 400 },
    );
  }
  const slug = slugCheck.value;
  const storyDirectory = path.join(storyDevRoot, slug);
  const result = {
    cloneParent: path.dirname(path.dirname(storyDevRoot)),
    storyDevRoot,
    storyDirectory,
    archiveDirectory: path.join(storyDirectory, "ask"),
    backupDirectory: path.join(storyDirectory, "ask"),
    attachmentDirectory: path.join(storyDirectory, "archives"),
    reportsDirectory: path.join(storyDirectory, "reports"),
    tempDirectory: path.join(storyDirectory, "tempFiles"),
    scriptsDirectory: path.join(storyDirectory, "tempFiles", "scripts"),
    docSlug: slug,
  };
  if (create) {
    const realStoryDevRoot = fs.realpathSync.native(result.storyDevRoot);
    let realStoryDirectory = "";
    for (const dir of [
      result.storyDirectory,
      result.archiveDirectory,
      result.attachmentDirectory,
      result.reportsDirectory,
      result.tempDirectory,
      result.scriptsDirectory,
    ]) {
      const realBoundary = dir === result.storyDirectory ? realStoryDevRoot : realStoryDirectory;
      const realDirectory = ensurePlainStoryDirectory(dir, "故事点资料目录", realBoundary);
      if (dir === result.storyDirectory) realStoryDirectory = realDirectory;
    }
  }
  if (!frozenRoot && persist && tab?.id && !Object.hasOwn(tab, "closedAt")) {
    try {
      const updated = updateTab(tab.id, { storyStorageRoot: storyDevRoot });
      if (updated) tab.storyStorageRoot = storyDevRoot;
    } catch {}
  }
  return result;
}

export function ensureStoryStorage(tab) {
  return getStoryStoragePaths(tab, { create: true });
}

function lstatOrNull(target) {
  try { return fs.lstatSync(target); }
  catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

function assertPlainPathChain(baseDirectory, targetPath, {
  createParentDirectories = false,
  createDirectory = false,
  mustExist = false,
  expectedType = "",
} = {}) {
  const base = path.resolve(String(baseDirectory || ""));
  const target = path.resolve(String(targetPath || ""));
  if (!baseDirectory || !targetPath || !realPathInside(base, target)) {
    throw storagePathError(`目标路径超出允许的存储目录：${targetPath}`);
  }
  const baseStat = lstatOrNull(base);
  if (!baseStat || baseStat.isSymbolicLink() || !baseStat.isDirectory()) {
    throw storagePathError(`存储基准目录不是普通目录：${base}`);
  }
  const realBase = fs.realpathSync.native(base);
  const relative = path.relative(base, target);
  const segments = relative ? relative.split(path.sep).filter(Boolean) : [];
  let current = base;
  for (let index = 0; index < segments.length; index++) {
    current = path.join(current, segments[index]);
    const isLeaf = index === segments.length - 1;
    let stat = lstatOrNull(current);
    if (!stat && ((createParentDirectories && !isLeaf) || (createDirectory && isLeaf))) {
      fs.mkdirSync(current);
      stat = fs.lstatSync(current);
    }
    if (!stat) {
      if (isLeaf && !mustExist) return target;
      throw storagePathError(`故事点资料路径不存在：${current}`, "STORY_STORAGE_PATH_MISSING");
    }
    if (stat.isSymbolicLink()) {
      throw storagePathError(`故事点资料路径不能包含符号链接或目录联接：${current}`);
    }
    if (!isLeaf && !stat.isDirectory()) {
      throw storagePathError(`故事点资料路径的中间节点不是目录：${current}`);
    }
    const realCurrent = fs.realpathSync.native(current);
    if (!realPathInside(realBase, realCurrent)) {
      throw storagePathError(`故事点资料路径解析后超出存储边界：${current}`);
    }
    if (isLeaf && expectedType === "file" && !stat.isFile()) {
      throw storagePathError(`故事点资料目标不是普通文件：${current}`);
    }
    if (isLeaf && expectedType === "directory" && !stat.isDirectory()) {
      throw storagePathError(`故事点资料目标不是普通目录：${current}`);
    }
  }
  if (!segments.length && expectedType === "file") {
    throw storagePathError(`故事点资料目标不能是存储目录本身：${target}`);
  }
  return target;
}

export function validateStoryStorageTarget(tab, targetPath, {
  baseDirectory = "",
  createParentDirectories = false,
  createDirectory = false,
  mustExist = false,
  expectedType = "",
} = {}) {
  const storage = getStoryStoragePaths(tab, { create: true });
  const base = baseDirectory ? path.resolve(String(baseDirectory)) : storage.storyDirectory;
  assertPlainPathChain(storage.storyDirectory, base, { mustExist: true, expectedType: "directory" });
  return assertPlainPathChain(base, targetPath, {
    createParentDirectories,
    createDirectory,
    mustExist,
    expectedType,
  });
}

export function storyStorageReference(tab, targetPath) {
  const storage = getStoryStoragePaths(tab, { create: true });
  const target = targetPath && path.isAbsolute(String(targetPath))
    ? path.resolve(String(targetPath))
    : "";
  if (!target || !pathInsideDeletionRoot(storage.storyDirectory, target)) return "";
  try {
    validateStoryStorageTarget(tab, target, { mustExist: true });
  } catch {
    return "";
  }
  const relative = path.relative(storage.storyDirectory, target).split(path.sep).join("/");
  return relative ? `storydev:/${relative}` : "storydev:/";
}

function legacyDefaultArchiveFile(project, tab, storedFile) {
  if (!project?.path || !storedFile || !path.isAbsolute(String(storedFile))) return false;
  const slug = ensureDocSlug(tab);
  const source = path.resolve(String(storedFile));
  return [
    path.join(project.path, "docs", "story", slug, "ask", `${slug}.txt`),
    path.join(project.path, "docs", slug, "ask", `${slug}.txt`),
  ].some((candidate) => normPath(candidate) === normPath(source));
}

function plainArchiveFileHash(file, label) {
  const stat = fs.lstatSync(file);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw storagePathError(`${label}必须是普通文件：${file}`, "STORY_ARCHIVE_MIGRATION_UNSAFE");
  }
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function copyArchiveWithHash(source, target, sourceHash) {
  fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL);
  try {
    const targetHash = plainArchiveFileHash(target, "迁移目标文件");
    if (sourceHash !== targetHash) throw new Error("旧故事点存档迁移校验失败，原文件已保留");
  } catch (error) {
    try { fs.unlinkSync(target); } catch {}
    throw error;
  }
}

function pruneLegacyArchiveParents(source) {
  for (const dir of [path.dirname(source), path.dirname(path.dirname(source))]) {
    try { if (fs.readdirSync(dir).length === 0) fs.rmdirSync(dir); } catch {}
  }
}

function migrateLegacyDefaultArchive(project, tab, targetFile) {
  const source = tab?.archiveFile && path.isAbsolute(String(tab.archiveFile))
    ? path.resolve(String(tab.archiveFile))
    : "";
  if (!source || normPath(source) === normPath(targetFile) || !fs.existsSync(source)) return null;
  if (tab?.archiveDir || !legacyDefaultArchiveFile(project, tab, source)) return null;
  assertPlainPathChain(project.path, source, { mustExist: true, expectedType: "file" });
  const sourceIdentity = fs.lstatSync(source, { bigint: true });
  const sourceHash = plainArchiveFileHash(source, "旧故事点存档");
  let conflictFile = "";
  if (fs.existsSync(targetFile)) {
    const targetHash = plainArchiveFileHash(targetFile, "现有 StoryDev 存档");
    if (sourceHash !== targetHash) {
      const ext = path.extname(targetFile);
      const stem = path.basename(targetFile, ext);
      const suffix = sourceHash.slice(0, 16);
      let candidate = path.join(path.dirname(targetFile), `${stem}.legacy-${suffix}${ext}`);
      let sequence = 2;
      while (fs.existsSync(candidate) && plainArchiveFileHash(candidate, "迁移冲突副本") !== sourceHash) {
        candidate = path.join(path.dirname(targetFile), `${stem}.legacy-${suffix}-${sequence++}${ext}`);
      }
      if (!fs.existsSync(candidate)) copyArchiveWithHash(source, candidate, sourceHash);
      conflictFile = candidate;
    }
  } else {
    copyArchiveWithHash(source, targetFile, sourceHash);
  }
  const persisted = tab?.id
    ? updateTab(tab.id, {
        archiveFile: targetFile,
        archiveMigrationConflictFile: conflictFile || tab?.archiveMigrationConflictFile || "",
      })
    : tab;
  if (tab?.id && !persisted) {
    throw new Error("旧故事点存档迁移状态持久化失败，原文件已保留");
  }
  assertPlainPathChain(project.path, source, { mustExist: true, expectedType: "file" });
  const latestIdentity = fs.lstatSync(source, { bigint: true });
  if (latestIdentity.dev !== sourceIdentity.dev
    || latestIdentity.ino !== sourceIdentity.ino
    || latestIdentity.size !== sourceIdentity.size
    || latestIdentity.mtimeNs !== sourceIdentity.mtimeNs
    || plainArchiveFileHash(source, "旧故事点存档") !== sourceHash) {
    throw new Error("旧故事点存档在迁移期间发生变化，原文件已保留");
  }
  const copiedFile = conflictFile || targetFile;
  if (plainArchiveFileHash(copiedFile, "迁移目标文件") !== sourceHash) {
    throw new Error("旧故事点存档迁移校验失败，原文件已保留");
  }
  fs.unlinkSync(source);
  pruneLegacyArchiveParents(source);
  return { migrated: true, conflictFile };
}

export function defaultArchiveDir(project, tab) {
  return getStoryStoragePaths(tab, { create: true }).archiveDirectory;
}

function validateArchiveWriteDirectory(tab, directory, { create = true } = {}) {
  const storage = getStoryStoragePaths(tab, { create: true });
  const resolved = path.resolve(String(directory || ""));
  return validateStoryStorageTarget(tab, resolved, {
    baseDirectory: storage.archiveDirectory,
    createDirectory: create,
    mustExist: !create,
    expectedType: "directory",
  });
}

export function getArchiveDirInfo(tab) {
  const project = getPrimaryProject(tab);
  const slug = ensureDocSlug(tab);
  const storage = getStoryStoragePaths(tab, { create: true });
  const defaultDir = storage.archiveDirectory;
  const requestedCustomDir = tab?.archiveDir ? path.resolve(String(tab.archiveDir)) : "";
  let customDir = "";
  let rejectedArchiveDir = "";
  if (requestedCustomDir) {
    try {
      customDir = validateArchiveWriteDirectory(tab, requestedCustomDir);
    } catch {
      // 旧版本允许把自定义目录指向源码树或任意绝对路径。升级后立即回退到
      // 当前故事点冻结的 ask 目录，避免后续事件/全量存档继续污染 worktree。
      rejectedArchiveDir = requestedCustomDir;
      tab.archiveDir = null;
      if (tab?.id && !Object.hasOwn(tab, "closedAt")) {
        try { updateTab(tab.id, { archiveDir: null }); } catch {}
      }
    }
  }
  const storedFile = tab?.archiveFile ? path.resolve(String(tab.archiveFile)) : "";
  const effectiveDir = customDir || defaultDir;
  const defaultFile = effectiveDir ? path.join(effectiveDir, `${slug}.txt`) : "";
  const migration = !customDir && defaultFile
    ? migrateLegacyDefaultArchive(project, tab, defaultFile)
    : null;
  const storedFileInEffectiveDir = !!(storedFile
    && normPath(path.dirname(storedFile)) === normPath(effectiveDir)
    && fs.existsSync(storedFile));
  const archiveFile = storedFileInEffectiveDir ? storedFile : defaultFile;
  if ((migration || (archiveFile && storedFile && normPath(archiveFile) !== normPath(storedFile)))
    && tab?.id && !Object.hasOwn(tab, "closedAt")) {
    try {
      const updated = updateTab(tab.id, {
        archiveFile,
        ...(migration?.conflictFile ? {
          archiveMigrationConflictFile: migration.conflictFile,
          archiveMigrationConflictAt: Date.now(),
        } : {}),
      });
      if (updated) tab.archiveFile = archiveFile;
    } catch {}
  }
  return {
    archiveDir: customDir,
    rejectedArchiveDir,
    defaultArchiveDir: defaultDir,
    effectiveArchiveDir: effectiveDir,
    archiveFile,
    archiveFileExists: !!(archiveFile && fs.existsSync(archiveFile)),
    archiveMigrationConflictFile: migration?.conflictFile || tab?.archiveMigrationConflictFile || "",
    docSlug: slug,
    storyStorageRoot: storage?.storyDevRoot || "",
    storyStorageDirectory: storage?.storyDirectory || "",
    defaultBackupDir: storage?.backupDirectory || defaultDir,
    attachmentDir: storage?.attachmentDirectory || "",
    reportsDir: storage?.reportsDirectory || "",
    tempDir: storage?.tempDirectory || "",
    scriptsDir: storage?.scriptsDirectory || "",
  };
}

export function resolveArchiveFile(project, tab) {
  try {
    const info = getArchiveDirInfo(tab);
    if (!info.archiveFile) return null;
    validateStoryStorageTarget(tab, info.archiveFile, {
      baseDirectory: info.effectiveArchiveDir,
      mustExist: false,
    });
    return info.archiveFile;
  } catch {
    return null;
  }
}

export function setTabArchiveDir(tabId, archiveDir) {
  const tab = getTab(tabId);
  if (!tab) return { ok: false, error: "故事点不存在" };
  const raw = String(archiveDir || "").trim();
  let customDir = "";
  let dir = "";
  let archiveFile = "";
  try {
    const storage = getStoryStoragePaths(tab, { create: true });
    if (raw) {
      if (!path.isAbsolute(raw)) return { ok: false, error: "存档目录必须是全路径" };
      customDir = validateArchiveWriteDirectory(tab, path.resolve(raw));
      if (normPath(customDir) === normPath(storage.archiveDirectory)) customDir = "";
    }
    dir = customDir || storage.archiveDirectory;
    archiveFile = path.join(dir, `${ensureDocSlug(tab)}.txt`);
    validateStoryStorageTarget(tab, archiveFile, {
      baseDirectory: dir,
      mustExist: false,
    });
  } catch (error) {
    return {
      ok: false,
      statusCode: error?.statusCode || 400,
      code: error?.code || "STORY_ARCHIVE_DIRECTORY_UNSAFE",
      error: `存档目录必须位于当前故事点的外置 ask 目录内：${error.message}`,
    };
  }
  const updated = updateTab(tabId, { archiveDir: customDir || null, archiveFile });
  return { ok: true, tab: updated, info: getArchiveDirInfo(updated) };
}

/**
 * 查找工程编译完成的 APK 产物目录。
 * 扫描 <root>/<module>/build/outputs/apk 与 <root>/build/outputs/apk，
 * 优先返回"最新 .apk 文件所在目录"，没有 .apk 时返回第一个 apk 输出目录，全无返回 null。
 */
export function findApkDir(root) {
  if (!root || !fs.existsSync(root)) return null;
  const candidates = [];
  try {
    for (const m of fs.readdirSync(root, { withFileTypes: true })) {
      if (!m.isDirectory()) continue;
      const apk = path.join(root, m.name, "build", "outputs", "apk");
      if (fs.existsSync(apk)) candidates.push(apk);
    }
    const rootApk = path.join(root, "build", "outputs", "apk");
    if (fs.existsSync(rootApk)) candidates.push(rootApk);
  } catch {
    return null;
  }
  if (!candidates.length) return null;

  // 在候选 apk 目录里递归找 .apk，取最新修改的那个文件所在目录
  let best = null, bestTime = -1;
  const walk = (dir, depth = 0) => {
    if (depth > 4) return;
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full, depth + 1);
      else if (e.isFile() && e.name.toLowerCase().endsWith(".apk")) {
        try {
          const t = fs.statSync(full).mtimeMs;
          if (t > bestTime) { bestTime = t; best = dir; }
        } catch {}
      }
    }
  };
  for (const c of candidates) walk(c);
  return best || candidates[0];
}

// ========== 团队共享配置（SQLite 权威，market-projects.json 只读启动种子）==========

// 用户可编辑及跨节点配置（projectDefs、dingtalkMsgConfig、byProject、_sharedVersion）
// 全部以 SQLite 为唯一权威，避免任何交互、训练、恢复或 gossip 反写 Git 文件。
// market-projects.json 仅在 SQLite 尚无共享行时作为可移植的首次启动种子读取。
const SHARED_KEY = "__devbench_shared__";
const SHARED_OP_LIMIT = 2000;
const AI_TRAINING_SNAPSHOT_VERSION = 1;
const DANGEROUS_SHARED_KEYS = new Set(["__proto__", "prototype", "constructor"]);
const SYNC_BACKUP_KIND = "devbench-sync-local-backup";
const CONFIG_INFERENCE_ADDITIVE_MERGE = "config_inference_additive";
const SYNC_BACKUP_SETTINGS_KEY = "devbench-sync-backup";
const MARKET_RUNTIME_SEED_MIGRATION_KEY = "marketProjectsRuntimeSeedV1";
const DEFAULT_SYNC_BACKUP_SETTINGS = {
  enabled: true,
  intervalMinutes: 60,
  maxAutoBackups: 48,
  lastAutoBackupAt: 0,
};
const VEHICLE_SOURCE_EXPORT_TYPE = "devbench-vehicle-source-config";
let sharedVersionCache = null;
function loadSharedStore() {
  const s = getUserData(SHARED_KEY, "shared");
  if (s && typeof s === "object" && !Array.isArray(s)) {
    const hasSharedOps = Array.isArray(s.sharedOps);
    const restoreState = hasSharedOps ? normalizeSharedRestoreState(s.sharedOps) : null;
    return {
      projectDefs: Array.isArray(s.projectDefs) ? cloneJson(s.projectDefs) : null,
      byProject: (s.byProject && typeof s.byProject === "object") ? s.byProject : {},
      dingtalkMsgConfig: (s.dingtalkMsgConfig && typeof s.dingtalkMsgConfig === "object") ? s.dingtalkMsgConfig : null,
      vehicleMapSeededAt: s.vehicleMapSeededAt || 0,
      repositoryInferenceProfilesVersion: Number(s.repositoryInferenceProfilesVersion) || 0,
      sharedOps: restoreState ? restoreState.ops : null,
      sharedOpClocks: restoreState?.clock
        ? rebuildSharedOpClocks({}, restoreState.ops)
        : (isPlainObject(s.sharedOpClocks) ? s.sharedOpClocks : {}),
      sharedRestoreClock: restoreState?.clock || null,
      _sharedVersion: s._sharedVersion || 0,
    };
  }
  return null; // 尚未迁移到 SQLite
}
function hasSharedFieldHistory(cfg, projectId, field) {
  const hasOp = (Array.isArray(cfg?.sharedOps) ? cfg.sharedOps : []).some((op) =>
    (op?.type === "byProject.set" || op?.type === "byProject.delete")
    && String(op.projectId || "") === String(projectId || "")
    && op.path?.[0] === field);
  const clockPrefix = `byProject/${encodeURIComponent(String(projectId || ""))}/${encodeURIComponent(String(field || ""))}/`;
  return hasOp || Object.keys(isPlainObject(cfg?.sharedOpClocks) ? cfg.sharedOpClocks : {})
    .some((key) => key.startsWith(clockPrefix));
}
function migrateLegacyRuntimeSeedOnce(cfg, legacySeed = {}) {
  if (getUserData("__system__", MARKET_RUNTIME_SEED_MIGRATION_KEY)?.version >= 1) return false;
  const pid = defaultPid();
  const bucket = isPlainObject(cfg?.byProject?.[pid]) ? cfg.byProject[pid] : {};
  const blockedByRestore = !!cfg?.sharedRestoreClock;
  if (!blockedByRestore
    && isPlainObject(legacySeed.vehicleMap)
    && !Object.hasOwn(bucket, "vehicleMap")
    && !hasSharedFieldHistory(cfg, pid, "vehicleMap")) {
    cfg.vehicleMap = cloneJson(legacySeed.vehicleMap);
  }
  if (!blockedByRestore
    && isPlainObject(legacySeed.keywordMappings)
    && !Object.hasOwn(bucket, "keywordMappings")
    && !hasSharedFieldHistory(cfg, pid, "keywordMappings")) {
    cfg.keywordMappings = cloneJson(legacySeed.keywordMappings);
  }
  const changed = ensureMigrated(cfg);
  if (changed) persistSharedConfig(cfg);
  setUserData("__system__", MARKET_RUNTIME_SEED_MIGRATION_KEY, { version: 1, completedAt: Date.now() }, sharedNodeId());
  return changed;
}
function buildBaselineSharedOps(cfg = {}, version = Date.now(), opts = {}) {
  const ops = [];
  let seq = 0;
  const node = sharedNodeId();
  const add = (op) => ops.push({
    ...op,
    id: `${node}:baseline:${version}:${seq++}`,
    node,
    version,
    at: Number(version) || Date.now(),
  });
  for (const def of Array.isArray(cfg.projectDefs) ? cfg.projectDefs : []) {
    const entry = normalizeDefPreservingMetadata(def);
    if (entry.id) add({ type: "projectDef.set", value: entry });
  }
  if (isPlainObject(cfg.dingtalkMsgConfig)) add({ type: "dingtalkMsgConfig.set", value: cfg.dingtalkMsgConfig });
  const byProject = isPlainObject(cfg.byProject) ? cfg.byProject : {};
  for (const [projectId, bucket] of Object.entries(byProject)) {
    if (!opts.skipVehicleMap && isPlainObject(bucket?.vehicleMap)) {
      for (const [flavor, value] of Object.entries(bucket.vehicleMap)) add({ type: "byProject.set", projectId, path: ["vehicleMap", flavor], value });
    }
    if (isPlainObject(bucket?.keywordMappings)) {
      for (const [group, mappings] of Object.entries(bucket.keywordMappings)) {
        if (!isPlainObject(mappings)) continue;
        for (const [key, value] of Object.entries(mappings)) add({ type: "byProject.set", projectId, path: ["keywordMappings", group, key], value });
      }
    }
    if (isPlainObject(bucket?.statusMap)) {
      for (const [logical, value] of Object.entries(bucket.statusMap)) add({ type: "byProject.set", projectId, path: ["statusMap", logical], value });
    }
    const storyTraining = bucket?.aiTraining?.storyPoint;
    if (isPlainObject(storyTraining)) {
      for (const section of ["buildLineage", "goldCases", "dryRuns"]) {
        if (!isPlainObject(storyTraining[section])) continue;
        for (const [id, value] of Object.entries(storyTraining[section])) {
          add({ type: "byProject.set", projectId, path: ["aiTraining", "storyPoint", section, id], value });
        }
      }
      if (isPlainObject(storyTraining.settings)) {
        add({ type: "byProject.set", projectId, path: ["aiTraining", "storyPoint", "settings"], value: storyTraining.settings });
      }
    }
    const configInference = bucket?.aiTraining?.configInference;
    if (isPlainObject(configInference)) {
      for (const section of CONFIG_INFERENCE_SHARED_SECTIONS) {
        if (!isPlainObject(configInference[section])) continue;
        for (const [id, value] of Object.entries(configInference[section])) {
          add({ type: "byProject.set", projectId, path: ["aiTraining", "configInference", section, id], value });
        }
      }
      if (isPlainObject(configInference.settings)) {
        add({ type: "byProject.set", projectId, path: ["aiTraining", "configInference", "settings"], value: configInference.settings });
      }
    }
    for (const row of Array.isArray(bucket?.lessons) ? bucket.lessons : []) if (row?.id) add({ type: "lesson.set", projectId, value: row });
    for (const row of Array.isArray(bucket?.configMemory) ? bucket.configMemory : []) if (row?.id) add({ type: "configMemory.set", projectId, value: row });
  }
  return cleanSharedOps(ops);
}
export function __testBuildBaselineSharedOps(cfg = {}, version = 1, opts = {}) {
  return buildBaselineSharedOps(cfg, version, opts);
}
function cleanSharedOps(ops = []) {
  const byId = new Map();
  for (const op of Array.isArray(ops) ? ops : []) {
    if (!isValidSharedOp(op)) continue;
    byId.set(String(op.id), op);
  }
  const sorted = [...byId.values()]
    .sort((a, b) => Number(a.version || 0) - Number(b.version || 0)
      || compareSharedText(a.node, b.node)
      || compareSharedText(a.id, b.id));
  const retained = new Map(sorted.slice(-SHARED_OP_LIMIT).map((op) => [String(op.id), op]));
  const protectedByKey = new Map();
  for (const op of sorted) {
    const configInferencePath = (op.type === "byProject.set" || op.type === "byProject.delete")
      && op.path?.[0] === "aiTraining" && op.path?.[1] === "configInference";
    // 配置推理 run/sample 由 aiTrainingSnapshot 负责完整 bootstrap，只保留最近窗口；
    // 仓库、车型、关键词、故事点训练、经验、记忆和 restore 必须逐 key 永久保留
    // 最新 set/delete，否则日志窗口滚动后新设备无法得到权威普通配置。
    if (configInferencePath) continue;
    const key = sharedOpKey(op);
    const current = key ? protectedByKey.get(key) : null;
    if (key && (!current || compareSharedClock(op, current) > 0)) protectedByKey.set(key, op);
  }
  for (const op of protectedByKey.values()) retained.set(String(op.id), op);
  return [...retained.values()].sort((a, b) => Number(a.version || 0) - Number(b.version || 0)
    || compareSharedText(a.node, b.node)
    || compareSharedText(a.id, b.id));
}
function compareSharedText(left, right) {
  const a = String(left || ""), b = String(right || "");
  return a < b ? -1 : (a > b ? 1 : 0);
}
function safeSharedSegment(value) {
  const text = String(value ?? "").trim();
  return safeDataKey(text) && !DANGEROUS_SHARED_KEYS.has(text.toLowerCase());
}
function validByProjectPath(pathParts) {
  if (!Array.isArray(pathParts) || !pathParts.length || pathParts.some((part) => !safeSharedSegment(part))) return false;
  const pathKey = pathParts.map(String);
  if (pathKey[0] === "vehicleMap") return pathKey.length === 2;
  if (pathKey[0] === "keywordMappings") return pathKey.length === 3;
  if (pathKey[0] === "statusMap") return pathKey.length === 2;
  if (pathKey[0] !== "aiTraining") return false;
  if (pathKey[1] === "storyPoint") {
    if (pathKey[2] === "settings") return pathKey.length === 3;
    return ["buildLineage", "goldCases", "dryRuns"].includes(pathKey[2]) && pathKey.length === 4;
  }
  if (pathKey[1] === "configInference") {
    if (pathKey[2] === "settings") return pathKey.length === 3;
    return CONFIG_INFERENCE_SHARED_SECTIONS.includes(pathKey[2]) && pathKey.length === 4;
  }
  return false;
}
function isValidSharedOp(op) {
  if (!op || typeof op !== "object" || !safeSharedSegment(op.id) || !safeSharedSegment(op.type)) return false;
  switch (op.type) {
    case "projectDef.set": return safeSharedSegment(op.value?.id);
    case "projectDef.delete": return safeSharedSegment(op.idValue);
    case "dingtalkMsgConfig.set": return isPlainObject(op.value);
    case "byProject.set":
    case "byProject.delete":
      return safeSharedSegment(op.projectId) && validByProjectPath(op.path);
    case "lesson.set":
    case "configMemory.set":
      return safeSharedSegment(op.projectId) && safeSharedSegment(op.value?.id);
    case "lesson.delete":
    case "configMemory.delete":
      return safeSharedSegment(op.projectId) && safeSharedSegment(op.idValue);
    case "shared.restore":
      return isPlainObject(op.value);
    default:
      return false;
  }
}
function sharedOpKey(op) {
  if (!isValidSharedOp(op)) return "";
  const enc = (value) => encodeURIComponent(String(value));
  if (op.type === "byProject.set" || op.type === "byProject.delete") {
    return `byProject/${enc(op.projectId)}/${op.path.map(enc).join("/")}`;
  }
  if (op.type === "projectDef.set") return `projectDef/${enc(op.value.id)}`;
  if (op.type === "projectDef.delete") return `projectDef/${enc(op.idValue)}`;
  if (op.type === "lesson.set" || op.type === "configMemory.set") return `${op.type.split(".")[0]}/${enc(op.projectId)}/${enc(op.value.id)}`;
  if (op.type === "lesson.delete" || op.type === "configMemory.delete") return `${op.type.split(".")[0]}/${enc(op.projectId)}/${enc(op.idValue)}`;
  return op.type;
}
function sharedOpClock(op) {
  return {
    version: Number(op?.version) || 0,
    node: String(op?.node || ""),
    id: String(op?.id || ""),
    at: Number(op?.at) || 0,
    ...(String(op?.mergeStrategy || "").trim() ? { mergeStrategy: String(op.mergeStrategy).trim() } : {}),
  };
}
function compareSharedClock(left, right) {
  const a = sharedOpClock(left), b = sharedOpClock(right);
  return a.version - b.version || compareSharedText(a.node, b.node) || compareSharedText(a.id, b.id);
}
function sameSharedClock(left, right) {
  return !!left && !!right && compareSharedClock(left, right) === 0;
}
function latestSharedRestoreOp(ops = []) {
  let latest = null;
  for (const op of Array.isArray(ops) ? ops : []) {
    if (op?.type !== "shared.restore") continue;
    if (!latest || compareSharedClock(op, latest) > 0) latest = op;
  }
  return latest;
}
function normalizeSharedRestoreState(ops = []) {
  const cleaned = cleanSharedOps(ops);
  const proof = latestSharedRestoreOp(cleaned);
  if (!proof) return { ops: cleaned, clock: null };
  const clock = sharedOpClock(proof);
  const epochOps = [proof];
  for (const op of cleaned) {
    if (op.type === "shared.restore" || Number(op.version || 0) <= clock.version) continue;
    const epoch = String(op.restoreEpoch || "");
    if (epoch && epoch !== clock.id) continue;
    epochOps.push(epoch === clock.id ? op : { ...op, restoreEpoch: clock.id });
  }
  return { ops: cleanSharedOps(epochOps), clock };
}
function rebuildSharedOpClocks(stored = {}, ops = []) {
  const out = isPlainObject(stored) ? { ...stored } : {};
  for (const op of cleanSharedOps(ops)) {
    const key = sharedOpKey(op);
    if (key && (!out[key] || compareSharedClock(op, out[key]) > 0)) out[key] = sharedOpClock(op);
  }
  return out;
}
function sharedStoreWriteData(byProject, version, dingtalkMsgConfig, meta = {}) {
  const restoreState = normalizeSharedRestoreState(meta.sharedOps);
  const data = {
    projectDefs: Array.isArray(meta.projectDefs)
      ? meta.projectDefs.map((def) => normalizeDefPreservingMetadata(def)).filter((def) => def.id)
      : [],
    byProject: byProject || {},
    dingtalkMsgConfig: dingtalkMsgConfig || null,
    _sharedVersion: version || Date.now(),
    sharedOps: restoreState.ops,
    sharedOpClocks: rebuildSharedOpClocks(
      restoreState.clock ? {} : meta.sharedOpClocks,
      restoreState.ops,
    ),
    sharedRestoreClock: restoreState.clock,
  };
  if (meta.vehicleMapSeededAt) data.vehicleMapSeededAt = meta.vehicleMapSeededAt;
  if (meta.repositoryInferenceProfilesVersion) {
    data.repositoryInferenceProfilesVersion = Number(meta.repositoryInferenceProfilesVersion) || 0;
  }
  return data;
}

function rebaseLocalSharedOps(current, candidate, node, requestedIds = []) {
  const existingIds = new Set(cleanSharedOps(current?.sharedOps).map((op) => String(op.id || "")));
  const localIds = new Set((Array.isArray(requestedIds) ? requestedIds : []).map(String).filter(Boolean));
  const incoming = cleanSharedOps(candidate?.sharedOps);
  let version = Math.max(Number(current?._sharedVersion) || 0, Number(candidate?._sharedVersion) || 0, Date.now());
  return incoming.map((op) => {
    if (!localIds.has(String(op.id || ""))
      || existingIds.has(String(op.id || ""))
      || String(op.node || "") !== String(node || "")) return op;
    version += 1;
    return {
      ...op,
      id: `${node || "local"}:${version}:${Math.random().toString(36).slice(2, 8)}`,
      version,
      at: Math.max(Date.now(), Number(op.at || 0)),
      rebasedFrom: String(op.id || ""),
    };
  });
}

function mergeSharedStoreWrite(currentInput, candidateInput, opts = {}) {
  const candidate = isPlainObject(candidateInput) ? cloneJson(candidateInput) : {};
  const hasCurrent = isPlainObject(currentInput);
  const current = hasCurrent ? cloneJson(currentInput) : {};
  if (typeof opts.guard === "function") {
    const guarded = opts.guard(current);
    if (guarded !== true) {
      const error = new Error(typeof guarded === "string" ? guarded : "共享状态已被其它 Gateway 更新");
      error.code = "SHARED_WRITE_CONFLICT";
      throw error;
    }
  }
  const currentRestoreState = normalizeSharedRestoreState(current.sharedOps);
  const currentRestoreClock = currentRestoreState.clock;
  const state = {
    // projectDefs 与车型映射一样是跨目录、跨 Gateway 的共享配置。SQLite
    // 事务内的这份快照是权威值；market-projects.json 只提供首次启动种子。
    projectDefs: Array.isArray(current.projectDefs)
      ? current.projectDefs
      : (Array.isArray(candidate.projectDefs) ? candidate.projectDefs : []),
    byProject: isPlainObject(current.byProject)
      ? current.byProject
      : (!hasCurrent && isPlainObject(candidate.byProject) ? cloneJson(candidate.byProject) : {}),
    dingtalkMsgConfig: isPlainObject(current.dingtalkMsgConfig)
      ? current.dingtalkMsgConfig
      : (!hasCurrent && isPlainObject(candidate.dingtalkMsgConfig) ? cloneJson(candidate.dingtalkMsgConfig) : null),
    vehicleMapSeededAt: Number(current.vehicleMapSeededAt) || 0,
    repositoryInferenceProfilesVersion: Number(current.repositoryInferenceProfilesVersion) || 0,
    _sharedVersion: Number(current._sharedVersion) || 0,
    sharedOps: currentRestoreState.ops,
    sharedOpClocks: rebuildSharedOpClocks(
      currentRestoreClock ? {} : current.sharedOpClocks,
      currentRestoreState.ops,
    ),
    // 候选快照携带的 clock 不能先于 shared.restore 操作建立屏障，否则伪造
    // clock 或本机刚追加的 restore 都会让真正的恢复操作被误判为已处理。
    // applySharedOps 只有在 restore 通过校验并实际应用后才会推进该时钟。
    sharedRestoreClock: currentRestoreClock,
  };

  const candidateRestoreState = normalizeSharedRestoreState(candidate.sharedOps);
  const incomingOps = opts.rebaseLocalOps
    ? rebaseLocalSharedOps(
      { ...current, sharedOps: currentRestoreState.ops },
      { ...candidate, sharedOps: candidateRestoreState.ops },
      opts.node,
      opts.localOpIds,
    )
    : candidateRestoreState.ops;
  const incomingRestoreState = normalizeSharedRestoreState(incomingOps);
  const applied = applySharedOps(state, incomingRestoreState.ops);
  const stateRestoreClock = isPlainObject(state.sharedRestoreClock) ? sharedOpClock(state.sharedRestoreClock) : null;
  const candidateRestoreClock = incomingRestoreState.clock;
  const sameRestoreEpoch = (!stateRestoreClock && !candidateRestoreClock)
    || (stateRestoreClock && candidateRestoreClock && sameSharedClock(stateRestoreClock, candidateRestoreClock));
  // restore/普通配置操作先建立权威基线，再合并完整 AI 快照。历史训练 op 可能
  // 已被 2000 条窗口裁掉，只存在于 snapshot；若先合并 snapshot，后续 restore
  // 会把这些 run/sample/trainedTicket 再次清空。
  // 同时要求候选快照属于当前 restore epoch，避免恢复前旧 Gateway 的 op 被
  // 屏障拒绝后，其旧 run 又从无 epoch 的整行 snapshot 复活。
  if (sameRestoreEpoch) {
    mergeAiTrainingSnapshot(state, buildAiTrainingSnapshot({ byProject: candidate.byProject || {} }));
  }
  state._sharedVersion = Math.max(
    Number(state._sharedVersion) || 0,
    sameRestoreEpoch ? (Number(candidate._sharedVersion) || 0) : 0,
    Number(applied.maxAcceptedVersion) || 0,
  );
  state.vehicleMapSeededAt = Math.max(
    Number(state.vehicleMapSeededAt) || 0,
    sameRestoreEpoch ? (Number(candidate.vehicleMapSeededAt) || 0) : 0,
  );
  state.repositoryInferenceProfilesVersion = Math.max(
    Number(state.repositoryInferenceProfilesVersion) || 0,
    sameRestoreEpoch ? (Number(candidate.repositoryInferenceProfilesVersion) || 0) : 0,
  );
  return sharedStoreWriteData(state.byProject, state._sharedVersion, state.dingtalkMsgConfig, state);
}

export function __testMergeSharedStoreWrite(current, candidate, opts = {}) {
  return mergeSharedStoreWrite(current, candidate, opts);
}

function saveSharedStore(byProject, version, dingtalkMsgConfig, meta = {}, opts = {}) {
  const candidate = sharedStoreWriteData(byProject, version, dingtalkMsgConfig, meta);
  const node = nodeIdSafe();
  const saved = updateUserData(SHARED_KEY, "shared", (current) => mergeSharedStoreWrite(current, candidate, {
    ...opts,
    node,
  }), node);
  sharedVersionCache = {
    updatedAt: Number(saved?.updatedAt) || 0,
    version: Number(saved?.data?._sharedVersion) || 0,
  };
  return saved;
}

function applySharedStoreSnapshot(cfg, shared) {
  if (!isPlainObject(cfg) || !isPlainObject(shared)) return cfg;
  if (Array.isArray(shared.projectDefs)) cfg.projectDefs = cloneJson(shared.projectDefs);
  cfg.byProject = isPlainObject(shared.byProject) ? cloneJson(shared.byProject) : {};
  cfg.dingtalkMsgConfig = isPlainObject(shared.dingtalkMsgConfig) ? cloneJson(shared.dingtalkMsgConfig) : null;
  cfg.vehicleMapSeededAt = Number(shared.vehicleMapSeededAt) || 0;
  cfg.repositoryInferenceProfilesVersion = Number(shared.repositoryInferenceProfilesVersion) || 0;
  cfg._sharedVersion = Number(shared._sharedVersion) || 0;
  const restoreState = normalizeSharedRestoreState(shared.sharedOps);
  cfg.sharedOps = restoreState.ops;
  cfg.sharedOpClocks = rebuildSharedOpClocks(
    restoreState.clock ? {} : shared.sharedOpClocks,
    cfg.sharedOps,
  );
  cfg.sharedRestoreClock = restoreState.clock;
  return cfg;
}

function configuredProjectDefsOrDefaults(cfg = {}) {
  if (Array.isArray(cfg.projectDefs)) return cloneJson(cfg.projectDefs);
  const remotes = isPlainObject(cfg.remotes) ? cfg.remotes : {};
  return DEFAULT_PROJECT_DEFS.map((def) => normalizeDefPreservingMetadata({
    ...def,
    https: remotes[def.id]?.https || def.https,
    ssh: remotes[def.id]?.ssh || def.ssh,
  }, def));
}

function loadRawConfig() {
  let cfg = {};
  try { cfg = JSON.parse(fs.readFileSync(MARKET_CONFIG, "utf-8")); } catch { cfg = {}; }
  const legacyRuntimeSeed = {
    vehicleMap: isPlainObject(cfg.vehicleMap) ? cloneJson(cfg.vehicleMap) : null,
    keywordMappings: isPlainObject(cfg.keywordMappings) ? cloneJson(cfg.keywordMappings) : null,
  };
  const shared = loadSharedStore();
  if (shared) {
    // 先忽略旧 JSON 的顶层运行态字段，再由独立迁移标记决定是否需要补导一次；
    // 这样既兼容“旧版已建 shared row、尚未迁移顶层字段”的库，也不会在删除/
    // shared.restore 之后反复从种子复活数据。
    delete cfg.vehicleMap;
    delete cfg.keywordMappings;
    const jsonProjectDefs = configuredProjectDefsOrDefaults(cfg);
    const needsProjectDefsMigration = !Array.isArray(shared.projectDefs);
    if (needsProjectDefsMigration) {
      // 旧共享行没有 projectDefs 快照。先在内存中按已有 op 重放，避免用旧
      // JSON 复活已删除仓库，再只为没有时钟的旧仓库补一次基线操作。
      const replay = {
        projectDefs: jsonProjectDefs,
        byProject: {},
        sharedOps: [],
        sharedOpClocks: {},
      };
      applySharedOps(replay, shared.sharedOps || []);
      cfg.projectDefs = replay.projectDefs;
      const clocks = rebuildSharedOpClocks(shared.sharedOpClocks, shared.sharedOps);
      const missingProjectDefOps = buildBaselineSharedOps(
        { projectDefs: cfg.projectDefs },
        nextSharedVersion(shared._sharedVersion),
      ).filter((op) => !clocks[sharedOpKey(op)]);
      shared.sharedOps = cleanSharedOps([...(shared.sharedOps || []), ...missingProjectDefOps]);
      shared.sharedOpClocks = rebuildSharedOpClocks(clocks, missingProjectDefOps);
      shared.projectDefs = cloneJson(cfg.projectDefs);
    } else {
      cfg.projectDefs = cloneJson(shared.projectDefs);
    }
    cfg.byProject = shared.byProject;
    cfg.dingtalkMsgConfig = shared.dingtalkMsgConfig;
    cfg.vehicleMapSeededAt = shared.vehicleMapSeededAt;
    cfg.repositoryInferenceProfilesVersion = shared.repositoryInferenceProfilesVersion;
    cfg._sharedVersion = shared._sharedVersion;
    cfg.sharedOps = Array.isArray(shared.sharedOps)
      ? normalizeSharedRestoreState(shared.sharedOps).ops
      : buildBaselineSharedOps(cfg, cfg._sharedVersion || Date.now(), { skipVehicleMap: !!cfg.vehicleMapSeededAt });
    const restoreState = normalizeSharedRestoreState(cfg.sharedOps);
    cfg.sharedOps = restoreState.ops;
    cfg.sharedOpClocks = rebuildSharedOpClocks(
      restoreState.clock ? {} : shared.sharedOpClocks,
      cfg.sharedOps,
    );
    cfg.sharedRestoreClock = restoreState.clock;
    if (needsProjectDefsMigration) {
      const saved = saveSharedStore(cfg.byProject, cfg._sharedVersion, cfg.dingtalkMsgConfig, cfg);
      applySharedStoreSnapshot(cfg, saved?.data);
    }
    migrateLegacyRuntimeSeedOnce(cfg, legacyRuntimeSeed);
  } else {
    // 一次性把 JSON 启动种子里的共享字段迁入 SQLite。源文件始终只读；以后
    // 所有显式配置变更、学习写入和跨节点同步都只更新 SQLite。
    ensureMigrated(cfg);
    const bp = (cfg.byProject && typeof cfg.byProject === "object") ? cfg.byProject : {};
    const ver = cfg._sharedVersion || Date.now();
    cfg.vehicleMapSeededAt = cfg.vehicleMapSeededAt || 0;
    cfg.repositoryInferenceProfilesVersion = Number(cfg.repositoryInferenceProfilesVersion) || 0;
    cfg.projectDefs = configuredProjectDefsOrDefaults(cfg);
    cfg.byProject = bp;
    cfg._sharedVersion = ver;
    cfg.sharedOps = Array.isArray(cfg.sharedOps) ? cfg.sharedOps : buildBaselineSharedOps(cfg, ver);
    const restoreState = normalizeSharedRestoreState(cfg.sharedOps);
    cfg.sharedOps = restoreState.ops;
    cfg.sharedOpClocks = rebuildSharedOpClocks(
      restoreState.clock ? {} : cfg.sharedOpClocks,
      cfg.sharedOps,
    );
    cfg.sharedRestoreClock = restoreState.clock;
    saveSharedStore(bp, ver, cfg.dingtalkMsgConfig, cfg);
    setUserData("__system__", MARKET_RUNTIME_SEED_MIGRATION_KEY, { version: 1, completedAt: Date.now() }, sharedNodeId());
  }
  return cfg;
}

// 配置变更（projectDefs / 恢复 / gossip 等）只做 SQLite 原子提交。
// 严禁在运行时写 MARKET_CONFIG；它是受 Git 跟踪的只读启动种子。
function persistSharedConfig(cfg) {
  return saveSharedStore(cfg.byProject || {}, cfg._sharedVersion || Date.now(), cfg.dingtalkMsgConfig, cfg);
}
function nextSharedVersion(current) {
  return Math.max(Date.now(), (Number(current) || 0) + 1);
}
function cloneJson(v) {
  return v == null ? v : JSON.parse(JSON.stringify(v));
}
function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (!value || typeof value !== "object") return JSON.stringify(value);
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}
function sharedNodeId() {
  return nodeIdSafe() || `device:${machineStorageId()}`;
}
function appendSharedOp(cfg, op) {
  cfg._sharedVersion = nextSharedVersion(cfg._sharedVersion);
  const node = sharedNodeId();
  const full = {
    ...op,
    ...(op?.type !== "shared.restore" && cfg.sharedRestoreClock?.id
      ? { restoreEpoch: String(cfg.sharedRestoreClock.id) }
      : {}),
    id: `${node}:${cfg._sharedVersion}:${Math.random().toString(36).slice(2, 8)}`,
    node,
    version: cfg._sharedVersion,
    at: Date.now(),
  };
  if ("value" in full) full.value = cloneJson(full.value);
  if (!isValidSharedOp(full)) throw new Error(`拒绝未授权的共享操作：${String(op?.type || "unknown")}`);
  const opKey = sharedOpKey(full);
  cfg.sharedOpClocks = rebuildSharedOpClocks(cfg.sharedOpClocks, []);
  cfg.sharedOpClocks[opKey] = sharedOpClock(full);
  if (full.type === "shared.restore") cfg.sharedRestoreClock = sharedOpClock(full);
  recordConfigInferenceTombstone(cfg, full);
  cfg.sharedOps = cleanSharedOps([...(Array.isArray(cfg.sharedOps) ? cfg.sharedOps : []), full]);
  return full;
}
function writeSharedOps(cfg, ops, opts = {}) {
  const list = (Array.isArray(ops) ? ops : [ops]).filter(Boolean);
  if (!list.length) return;
  const appended = list.map((op) => appendSharedOp(cfg, op));
  saveSharedStore(cfg.byProject || {}, cfg._sharedVersion, cfg.dingtalkMsgConfig, cfg, {
    rebaseLocalOps: true,
    localOpIds: appended.map((op) => op.id),
    guard: opts.guard,
  });
}
// 写共享/学习数据（高频：加经验/配置记忆/关键词时）：bump 版本，【只落 SQLite】，不触碰 market-projects.json
function writeShared(cfg) {
  cfg._sharedVersion = nextSharedVersion(cfg._sharedVersion);
  saveSharedStore(cfg.byProject || {}, cfg._sharedVersion, cfg.dingtalkMsgConfig, cfg);
}

// ===== 服务端间共享配置复制（仓库定义 + 各项目车型/关键词）=====
export function getSharedVersion() {
  const metadata = getUserDataMetadata(SHARED_KEY, "shared");
  if (sharedVersionCache
    && Number(metadata?.updatedAt || 0) === Number(sharedVersionCache.updatedAt || 0)) {
    return Number(sharedVersionCache.version) || 0;
  }
  const cfg = loadRawConfig();
  if (ensureProductionSharedPollutionCleanup(cfg)) {
    const saved = persistSharedConfig(cfg);
    return Number(saved?.data?._sharedVersion) || Number(cfg._sharedVersion) || 0;
  }
  sharedVersionCache = {
    updatedAt: Number(metadata?.updatedAt) || 0,
    version: Number(cfg._sharedVersion) || 0,
  };
  return sharedVersionCache.version;
}
function buildAiTrainingSnapshot(cfg = {}) {
  const byProject = {};
  for (const [projectId, bucket] of Object.entries(isPlainObject(cfg.byProject) ? cfg.byProject : {})) {
    if (!safeSharedSegment(projectId)) continue;
    const root = bucket?.aiTraining?.configInference;
    if (!isPlainObject(root)) continue;
    byProject[projectId] = {
      configInference: {
        runs: cloneJson(isPlainObject(root.runs) ? root.runs : {}),
        samples: cloneJson(isPlainObject(root.samples) ? root.samples : {}),
        trainedTickets: cloneJson(isPlainObject(root.trainedTickets) ? root.trainedTickets : {}),
        trainingClaims: cloneJson(isPlainObject(root.trainingClaims) ? root.trainingClaims : {}),
        valueBindings: cloneJson(isPlainObject(root.valueBindings) ? root.valueBindings : {}),
        keywordSuggestions: cloneJson(isPlainObject(root.keywordSuggestions) ? root.keywordSuggestions : {}),
        settings: cloneJson(isPlainObject(root.settings) ? root.settings : {}),
        tombstones: cloneJson(normalizeConfigInferenceTombstones(root.tombstones)),
      },
    };
  }
  return {
    schemaVersion: AI_TRAINING_SNAPSHOT_VERSION,
    version: Number(cfg._sharedVersion) || 0,
    byProject,
  };
}
// 导出共享 bundle（不含本机专属 cloneParent）
export function getSharedBundle() {
  const cfg = loadRawConfig();
  const migrated = ensureMigrated(cfg);
  const profilesMigrated = ensureRepositoryInferenceProfiles(cfg);
  const pollutionCleaned = ensureProductionSharedPollutionCleanup(cfg);
  if (migrated || profilesMigrated || pollutionCleaned) persistSharedConfig(cfg);
  return {
    syncScope: devbenchSyncScope(),
    version: cfg._sharedVersion || 0,
    projectDefs: cfg.projectDefs || getProjectDefs(),
    byProject: cfg.byProject || {},
    dingtalkMsgConfig: cfg.dingtalkMsgConfig || null,
    sharedOps: cleanSharedOps(cfg.sharedOps),
    sharedRestoreClock: isPlainObject(cfg.sharedRestoreClock) ? sharedOpClock(cfg.sharedRestoreClock) : null,
    aiTrainingSnapshot: buildAiTrainingSnapshot(cfg),
  };
}

function currentSharedBackupBundle() {
  const cfg = loadRawConfig();
  const migrated = ensureMigrated(cfg);
  const profilesMigrated = ensureRepositoryInferenceProfiles(cfg);
  const pollutionCleaned = ensureProductionSharedPollutionCleanup(cfg);
  if (migrated || profilesMigrated || pollutionCleaned) persistSharedConfig(cfg);
  return {
    sharedVersion: cfg._sharedVersion || 0,
    sharedOpsCount: cleanSharedOps(cfg.sharedOps).length,
    data: {
      projectDefs: cfg.projectDefs || getProjectDefs(),
      byProject: cfg.byProject || {},
      dingtalkMsgConfig: cfg.dingtalkMsgConfig || null,
      vehicleMapSeededAt: cfg.vehicleMapSeededAt || 0,
    },
  };
}

function compactBackupSummary(sharedBundle, userDataRows = [], syncMeta = {}) {
  const byProject = isPlainObject(sharedBundle?.byProject) ? sharedBundle.byProject : {};
  const summary = {
    sharedVersion: Number(syncMeta.sharedVersion ?? sharedBundle?.version) || 0,
    projectDefCount: Array.isArray(sharedBundle?.projectDefs) ? sharedBundle.projectDefs.length : 0,
    projectBucketCount: Object.keys(byProject).length,
    vehicleCount: 0,
    keywordCount: 0,
    statusCount: 0,
    lessonCount: 0,
    configMemoryCount: 0,
    sharedOpsCount: Number(syncMeta.sharedOpsCount)
      || (Array.isArray(sharedBundle?.sharedOps) ? sharedBundle.sharedOps.length : 0),
    userDataRowCount: userDataRows.length,
    taskCount: 0,
    taskGroupCount: 0,
  };
  for (const bucket of Object.values(byProject)) {
    if (!isPlainObject(bucket)) continue;
    if (isPlainObject(bucket.vehicleMap)) summary.vehicleCount += Object.keys(bucket.vehicleMap).length;
    if (isPlainObject(bucket.statusMap)) summary.statusCount += Object.keys(bucket.statusMap).length;
    if (isPlainObject(bucket.keywordMappings)) {
      for (const mappings of Object.values(bucket.keywordMappings)) {
        if (isPlainObject(mappings)) summary.keywordCount += Object.keys(mappings).length;
      }
    }
    if (Array.isArray(bucket.lessons)) summary.lessonCount += bucket.lessons.length;
    if (Array.isArray(bucket.configMemory)) summary.configMemoryCount += bucket.configMemory.length;
  }
  for (const row of userDataRows) {
    if (row?.kind === "tasks" && Array.isArray(row.data)) summary.taskCount += row.data.length;
    if (row?.kind === "taskGroups" && Array.isArray(row.data)) summary.taskGroupCount += row.data.length;
  }
  return summary;
}

function backupId(source, now = Date.now()) {
  const stamp = new Date(now).toISOString().replace(/\D/g, "").slice(0, 14);
  return `${source || "manual"}-${stamp}-${Math.random().toString(36).slice(2, 8)}`;
}

function backupLabel(source, now = Date.now()) {
  const d = new Date(now);
  const p = (n) => String(n).padStart(2, "0");
  const text = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  if (source === "auto") return `自动备份 ${text}`;
  if (source === "pre-restore") return `恢复前备份 ${text}`;
  return `手动备份 ${text}`;
}

function portableBackupUserDataRows(rows = []) {
  return (Array.isArray(rows) ? rows : []).map((row) => ({
    user_key: String(row?.user_key || ""),
    kind: String(row?.kind || ""),
    data: cloneJson(row?.data ?? []),
  }));
}

export function createSharedSyncBackup({
  source = "manual",
  label = "",
  note = "",
  now = Date.now(),
  deduplicate = false,
  maxAutoBackups = DEFAULT_SYNC_BACKUP_SETTINGS.maxAutoBackups,
} = {}) {
  const snapshot = currentSharedBackupBundle();
  const sharedBundle = snapshot.data;
  const userDataRows = portableBackupUserDataRows(listSyncableUserDataRows());
  const contentHash = createHash("sha256")
    .update(stableJsonText({ sharedBundle, userDataRows }))
    .digest("hex");
  const normalizedSource = String(source || "manual").trim() || "manual";
  const data = {
    type: SYNC_BACKUP_KIND,
    version: 2,
    sharedBundle: cloneJson(sharedBundle),
    userDataRows: cloneJson(userDataRows),
  };
  const summary = {
    ...compactBackupSummary(sharedBundle, userDataRows, snapshot),
    contentHash,
  };
  if (deduplicate) {
    const latest = getLatestDevbenchSyncBackupMeta(normalizedSource);
    if (latest?.summary?.contentHash === contentHash) {
      return {
        skipped: true,
        unchanged: true,
        duplicateOf: latest.id,
        createdAt: now,
        source: normalizedSource,
        summary,
      };
    }
  }
  const backup = insertDevbenchSyncBackup({
    id: backupId(source, now),
    createdAt: now,
    source: normalizedSource,
    label: String(label || "").trim() || backupLabel(normalizedSource, now),
    note: String(note || "").trim(),
    summary,
    data,
    node: sharedNodeId(),
  });
  const maintenance = normalizedSource === "auto"
    ? pruneDevbenchSyncBackups({ source: "auto", keep: maxAutoBackups })
    : null;
  return { ...backup, maintenance };
}

export function listSharedSyncBackups(opts = {}) {
  return listDevbenchSyncBackups(opts);
}

export function getSharedSyncBackupStorageStats() {
  return getDevbenchSyncBackupStorageStats();
}

export function maintainSharedSyncBackups({ maxAutoBackups = DEFAULT_SYNC_BACKUP_SETTINGS.maxAutoBackups } = {}) {
  const maintenance = pruneDevbenchSyncBackups({ source: "auto", keep: maxAutoBackups });
  return { ok: true, maintenance, storage: getDevbenchSyncBackupStorageStats() };
}

function normalizeBackupSettings(input = {}) {
  const intervalMinutes = Math.max(5, Math.min(10080, Number(input.intervalMinutes) || DEFAULT_SYNC_BACKUP_SETTINGS.intervalMinutes));
  const maxAutoBackups = Math.max(1, Math.min(720, Math.trunc(
    Number(input.maxAutoBackups) || DEFAULT_SYNC_BACKUP_SETTINGS.maxAutoBackups,
  )));
  return {
    enabled: input.enabled !== false,
    intervalMinutes,
    maxAutoBackups,
    lastAutoBackupAt: Number(input.lastAutoBackupAt) || 0,
  };
}

export function getSharedSyncBackupSettings() {
  return normalizeBackupSettings({ ...DEFAULT_SYNC_BACKUP_SETTINGS, ...(getDevbenchSyncBackupSetting(SYNC_BACKUP_SETTINGS_KEY) || {}) });
}

export function updateSharedSyncBackupSettings(patch = {}) {
  const current = getSharedSyncBackupSettings();
  const next = normalizeBackupSettings({
    ...current,
    ...(Object.prototype.hasOwnProperty.call(patch, "enabled") ? { enabled: !!patch.enabled } : {}),
    ...(Object.prototype.hasOwnProperty.call(patch, "intervalMinutes") ? { intervalMinutes: patch.intervalMinutes } : {}),
    ...(Object.prototype.hasOwnProperty.call(patch, "maxAutoBackups") ? { maxAutoBackups: patch.maxAutoBackups } : {}),
    ...(Object.prototype.hasOwnProperty.call(patch, "lastAutoBackupAt") ? { lastAutoBackupAt: patch.lastAutoBackupAt } : {}),
  });
  setDevbenchSyncBackupSetting(SYNC_BACKUP_SETTINGS_KEY, next);
  return next;
}

export function runDueSharedSyncAutoBackup(now = Date.now()) {
  const settings = getSharedSyncBackupSettings();
  if (!settings.enabled) return { ok: true, created: false, settings };
  const dueMs = settings.intervalMinutes * 60 * 1000;
  if (settings.lastAutoBackupAt && now - settings.lastAutoBackupAt < dueMs) return { ok: true, created: false, settings };
  const backup = createSharedSyncBackup({
    source: "auto",
    now,
    deduplicate: true,
    maxAutoBackups: settings.maxAutoBackups,
  });
  const next = updateSharedSyncBackupSettings({ ...settings, lastAutoBackupAt: now });
  return {
    ok: true,
    created: !backup.skipped,
    unchanged: !!backup.unchanged,
    backup: backup.skipped ? null : backup,
    duplicateOf: backup.duplicateOf || "",
    settings: next,
  };
}

let sharedBackupScheduler = null;
export function startSharedSyncBackupScheduler() {
  if (sharedBackupScheduler) return;
  const tick = () => {
    try { runDueSharedSyncAutoBackup(); } catch (e) { try { console.warn("[devbench] auto sync backup failed:", e.message); } catch {} }
  };
  setTimeout(tick, 5000).unref?.();
  sharedBackupScheduler = setInterval(tick, 60 * 1000);
  sharedBackupScheduler.unref?.();
}

function restoreSharedBundleFromBackup(sharedBundle = {}, backupIdValue = "") {
  const cfg = loadRawConfig();
  ensureMigrated(cfg);
  const restoreValue = {
    projectDefs: Array.isArray(sharedBundle.projectDefs) ? cloneJson(sharedBundle.projectDefs) : getProjectDefs(),
    byProject: isPlainObject(sharedBundle.byProject) ? cloneJson(sharedBundle.byProject) : {},
    dingtalkMsgConfig: isPlainObject(sharedBundle.dingtalkMsgConfig) ? cloneJson(sharedBundle.dingtalkMsgConfig) : null,
    vehicleMapSeededAt: Number(sharedBundle.vehicleMapSeededAt) || 0,
  };
  cfg.projectDefs = restoreValue.projectDefs;
  cfg.byProject = restoreValue.byProject;
  cfg.dingtalkMsgConfig = restoreValue.dingtalkMsgConfig;
  cfg.vehicleMapSeededAt = restoreValue.vehicleMapSeededAt;
  appendSharedOp(cfg, { type: "shared.restore", idValue: backupIdValue, value: restoreValue });
  ensureRepositoryInferenceProfiles(cfg);
  persistSharedConfig(cfg);
  return cfg._sharedVersion || 0;
}

export function restoreSharedSyncBackup(id) {
  const backup = getDevbenchSyncBackup(id);
  if (!backup?.data || backup.data.type !== SYNC_BACKUP_KIND) return { ok: false, error: "备份不存在或格式不正确" };
  const before = createSharedSyncBackup({ source: "pre-restore", label: `恢复 ${backup.label || backup.id} 前`, now: Date.now() });
  const sharedVersion = restoreSharedBundleFromBackup(backup.data.sharedBundle || {}, backup.id);
  const userData = replaceSyncableUserDataRows(backup.data.userDataRows || [], sharedNodeId());
  return {
    ok: true,
    backup: { ...backup, data: undefined },
    preRestoreBackup: before,
    restored: {
      sharedVersion,
      userDataRows: userData.restored || 0,
      summary: backup.summary || compactBackupSummary(backup.data.sharedBundle || {}, backup.data.userDataRows || []),
    },
  };
}
function isPlainObject(v) {
  return v && typeof v === "object" && !Array.isArray(v);
}
function stableJsonText(value) {
  if (Array.isArray(value)) return `[${value.map(stableJsonText).join(",")}]`;
  if (isPlainObject(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJsonText(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}
function configInferenceTimestamp(value) {
  return Number(value?.updatedAt || value?.reviewedAt || value?.createdAt || 0) || 0;
}
function compareConfigInferenceValue(left, right) {
  const timeDiff = configInferenceTimestamp(left) - configInferenceTimestamp(right);
  if (timeDiff) return timeDiff;
  return stableJsonText(left).localeCompare(stableJsonText(right));
}
function normalizeConfigInferenceTombstones(input) {
  const out = Object.fromEntries(CONFIG_INFERENCE_SHARED_SECTIONS.map((section) => [section, {}]));
  for (const section of CONFIG_INFERENCE_SHARED_SECTIONS) {
    for (const [id, value] of Object.entries(isPlainObject(input?.[section]) ? input[section] : {})) {
      if (!safeSharedSegment(id)) continue;
      const row = isPlainObject(value) ? value : { updatedAt: Number(value) || 0 };
      out[section][id] = {
        updatedAt: configInferenceTimestamp(row),
        version: Number(row.version) || 0,
        node: String(row.node || ""),
        opId: String(row.opId || row.id || ""),
      };
    }
  }
  return out;
}
function compareConfigInferenceTombstone(left, right) {
  const a = left || {}, b = right || {};
  return configInferenceTimestamp(a) - configInferenceTimestamp(b)
    || Number(a.version || 0) - Number(b.version || 0)
    || String(a.node || "").localeCompare(String(b.node || ""))
    || String(a.opId || "").localeCompare(String(b.opId || ""));
}
function mergeConfigInferenceTombstones(local, incoming) {
  const left = normalizeConfigInferenceTombstones(local);
  const right = normalizeConfigInferenceTombstones(incoming);
  const out = Object.fromEntries(CONFIG_INFERENCE_SHARED_SECTIONS.map((section) => [
    section,
    { ...(left[section] || {}) },
  ]));
  for (const section of CONFIG_INFERENCE_SHARED_SECTIONS) {
    for (const [id, tombstone] of Object.entries(right[section])) {
      if (!out[section][id] || compareConfigInferenceTombstone(tombstone, out[section][id]) > 0) out[section][id] = tombstone;
    }
  }
  return out;
}
function configInferenceTombstoneBlocks(row, tombstone) {
  return !!tombstone && configInferenceTimestamp(tombstone) >= configInferenceTimestamp(row);
}
function mergeConfigInferenceRows(local, incoming, tombstones, section) {
  const out = cloneJson(isPlainObject(local) ? local : {});
  for (const [id, row] of Object.entries(isPlainObject(incoming) ? incoming : {})) {
    if (!safeSharedSegment(id) || !isPlainObject(row) || configInferenceTombstoneBlocks(row, tombstones?.[section]?.[id])) continue;
    if (!isPlainObject(out[id]) || compareConfigInferenceValue(row, out[id]) > 0) out[id] = cloneJson(row);
  }
  for (const [id, tombstone] of Object.entries(tombstones?.[section] || {})) {
    if (out[id] && configInferenceTombstoneBlocks(out[id], tombstone)) delete out[id];
  }
  return out;
}
function mergeConfigInferenceState(local, incoming) {
  const left = isPlainObject(local) ? local : {};
  const right = isPlainObject(incoming) ? incoming : {};
  const tombstones = mergeConfigInferenceTombstones(left.tombstones, right.tombstones);
  const settings = !isPlainObject(left.settings)
    ? cloneJson(isPlainObject(right.settings) ? right.settings : {})
    : !isPlainObject(right.settings) || compareConfigInferenceValue(left.settings, right.settings) >= 0
      ? cloneJson(left.settings)
      : cloneJson(right.settings);
  return {
    ...left,
    ...right,
    runs: mergeConfigInferenceRows(left.runs, right.runs, tombstones, "runs"),
    samples: mergeConfigInferenceRows(left.samples, right.samples, tombstones, "samples"),
    trainedTickets: mergeConfigInferenceRows(left.trainedTickets, right.trainedTickets, tombstones, "trainedTickets"),
    trainingClaims: mergeConfigInferenceRows(left.trainingClaims, right.trainingClaims, tombstones, "trainingClaims"),
    valueBindings: mergeConfigInferenceRows(left.valueBindings, right.valueBindings, tombstones, "valueBindings"),
    keywordSuggestions: mergeConfigInferenceRows(
      left.keywordSuggestions,
      right.keywordSuggestions,
      tombstones,
      "keywordSuggestions",
    ),
    settings,
    tombstones,
  };
}
function mergeAiTrainingSnapshot(cfg, snapshot) {
  if (!isPlainObject(snapshot)
    || Number(snapshot.schemaVersion) !== AI_TRAINING_SNAPSHOT_VERSION
    || !isPlainObject(snapshot.byProject)) return 0;
  let changed = 0;
  for (const [projectId, projectSnapshot] of Object.entries(snapshot.byProject)) {
    if (!safeSharedSegment(projectId) || !isPlainObject(projectSnapshot?.configInference)) continue;
    const bucket = projectBucket(cfg, projectId);
    bucket.aiTraining = isPlainObject(bucket.aiTraining) ? bucket.aiTraining : {};
    const before = isPlainObject(bucket.aiTraining.configInference) ? bucket.aiTraining.configInference : {};
    const merged = mergeConfigInferenceState(before, projectSnapshot.configInference);
    if (stableJsonText(before) !== stableJsonText(merged)) {
      bucket.aiTraining.configInference = merged;
      changed++;
    }
  }
  return changed;
}
function configInferenceOpLocation(op) {
  const pathParts = Array.isArray(op?.path) ? op.path.map(String) : [];
  if (pathParts[0] !== "aiTraining" || pathParts[1] !== "configInference") return null;
  if (CONFIG_INFERENCE_SHARED_SECTIONS.includes(pathParts[2]) && pathParts.length === 4) return { section: pathParts[2], id: pathParts[3] };
  if (pathParts[2] === "settings" && pathParts.length === 3) return { section: "settings", id: "" };
  return null;
}
function recordConfigInferenceTombstone(cfg, op) {
  if (op?.type !== "byProject.delete") return false;
  const location = configInferenceOpLocation(op);
  if (!location || location.section === "settings") return false;
  const root = configInferenceRoot(cfg, op.projectId);
  root.tombstones = normalizeConfigInferenceTombstones(root.tombstones);
  const incoming = {
    updatedAt: Number(op.at || op.version) || Date.now(),
    version: Number(op.version) || 0,
    node: String(op.node || ""),
    opId: String(op.id || ""),
  };
  const current = root.tombstones[location.section][location.id];
  if (!current || compareConfigInferenceTombstone(incoming, current) > 0) {
    root.tombstones[location.section][location.id] = incoming;
    return true;
  }
  return false;
}
function applyConfigInferenceSet(cfg, op, location) {
  const root = configInferenceRoot(cfg, op.projectId);
  if (location.section === "settings") {
    if (!isPlainObject(op.value)) return false;
    if (!isPlainObject(root.settings) || compareConfigInferenceValue(op.value, root.settings) > 0) {
      root.settings = cloneJson(op.value);
      return true;
    }
    return false;
  }
  const tombstones = normalizeConfigInferenceTombstones(root.tombstones);
  root.tombstones = tombstones;
  if (!isPlainObject(op.value) || configInferenceTombstoneBlocks(op.value, tombstones[location.section][location.id])) return false;
  if (!isPlainObject(root[location.section][location.id])
    || compareConfigInferenceValue(op.value, root[location.section][location.id]) > 0) {
    root[location.section][location.id] = cloneJson(op.value);
    return true;
  }
  return false;
}
function applyConfigInferenceDelete(cfg, op, location) {
  const root = configInferenceRoot(cfg, op.projectId);
  const tombstoneChanged = recordConfigInferenceTombstone(cfg, op);
  const tombstone = root.tombstones?.[location.section]?.[location.id];
  if (root[location.section]?.[location.id]
    && configInferenceTombstoneBlocks(root[location.section][location.id], tombstone)) {
    delete root[location.section][location.id];
    return true;
  }
  return tombstoneChanged;
}
function mergeNestedObject(local, incoming) {
  const out = { ...(isPlainObject(local) ? local : {}) };
  for (const [key, value] of Object.entries(isPlainObject(incoming) ? incoming : {})) {
    out[key] = isPlainObject(out[key]) && isPlainObject(value) ? { ...out[key], ...value } : value;
  }
  return out;
}
function mergeProjectBucket(local, incoming) {
  const out = { ...(isPlainObject(local) ? local : {}), ...(isPlainObject(incoming) ? incoming : {}) };
  if (isPlainObject(local?.vehicleMap) && isPlainObject(incoming?.vehicleMap)) out.vehicleMap = { ...local.vehicleMap, ...incoming.vehicleMap };
  if (isPlainObject(local?.statusMap) && isPlainObject(incoming?.statusMap)) out.statusMap = { ...local.statusMap, ...incoming.statusMap };
  if (isPlainObject(local?.keywordMappings) && isPlainObject(incoming?.keywordMappings)) {
    out.keywordMappings = mergeNestedObject(local.keywordMappings, incoming.keywordMappings);
  }
  const localAiTraining = isPlainObject(local?.aiTraining) ? local.aiTraining : {};
  const incomingAiTraining = isPlainObject(incoming?.aiTraining) ? incoming.aiTraining : {};
  if (Object.keys(localAiTraining).length || Object.keys(incomingAiTraining).length) {
    out.aiTraining = { ...localAiTraining, ...incomingAiTraining };
    for (const [domain, sections] of [["storyPoint", ["buildLineage", "goldCases", "dryRuns"]]]) {
      const left = isPlainObject(localAiTraining[domain]) ? localAiTraining[domain] : {};
      const right = isPlainObject(incomingAiTraining[domain]) ? incomingAiTraining[domain] : {};
      if (!Object.keys(left).length && !Object.keys(right).length) continue;
      out.aiTraining[domain] = { ...left, ...right };
      for (const section of sections) {
        out.aiTraining[domain][section] = {
          ...(isPlainObject(left[section]) ? left[section] : {}),
          ...(isPlainObject(right[section]) ? right[section] : {}),
        };
      }
    }
    if (isPlainObject(localAiTraining.configInference) || isPlainObject(incomingAiTraining.configInference)) {
      out.aiTraining.configInference = mergeConfigInferenceState(localAiTraining.configInference, incomingAiTraining.configInference);
    }
  }
  return out;
}
function mergeByProject(local, incoming) {
  const out = { ...(isPlainObject(local) ? local : {}) };
  for (const [projectId, bucket] of Object.entries(isPlainObject(incoming) ? incoming : {})) {
    out[projectId] = mergeProjectBucket(out[projectId], bucket);
  }
  return out;
}
function setNestedValue(root, pathParts, value) {
  if (!Array.isArray(pathParts) || !pathParts.length || pathParts.some((part) => !safeSharedSegment(part))) return false;
  let cur = root;
  for (const part of pathParts.slice(0, -1)) {
    const key = String(part);
    if (!isPlainObject(cur[key])) cur[key] = {};
    cur = cur[key];
  }
  cur[String(pathParts[pathParts.length - 1])] = cloneJson(value);
  return true;
}
function deleteNestedValue(root, pathParts) {
  if (!Array.isArray(pathParts) || !pathParts.length || pathParts.some((part) => !safeSharedSegment(part))) return false;
  let cur = root;
  for (const part of pathParts.slice(0, -1)) {
    cur = cur?.[String(part)];
    if (!isPlainObject(cur)) return false;
  }
  delete cur[String(pathParts[pathParts.length - 1])];
  return true;
}
function upsertProjectDefInConfig(cfg, def) {
  const candidate = normalizeDef(def);
  if (!candidate.id) return;
  const list = Array.isArray(cfg.projectDefs)
    ? cfg.projectDefs.map((item) => normalizeDefPreservingMetadata(item)).filter((item) => item.id)
    : getProjectDefs();
  const idx = list.findIndex((item) => item.id === candidate.id);
  const entry = normalizeDefPreservingMetadata(def, idx >= 0 ? list[idx] : {});
  if (idx >= 0) list[idx] = entry; else list.push(entry);
  cfg.projectDefs = list;
}
function deleteProjectDefInConfig(cfg, id) {
  const key = String(id || "").trim();
  if (!key) return;
  const list = Array.isArray(cfg.projectDefs)
    ? cfg.projectDefs.map((item) => normalizeDefPreservingMetadata(item)).filter((item) => item.id)
    : getProjectDefs();
  cfg.projectDefs = list.filter((d) => d.id !== key);
}
function upsertArrayItem(list, row) {
  const arr = Array.isArray(list) ? list.slice() : [];
  if (!row?.id) return arr;
  const idx = arr.findIndex((x) => x?.id === row.id);
  if (idx >= 0) arr[idx] = cloneJson(row); else arr.push(cloneJson(row));
  return arr;
}
function mergeConfigInferenceProjectDefValues(current, incoming, preferIncoming = true, canonicalOrder = false) {
  const preferred = preferIncoming ? incoming : current;
  const secondary = preferIncoming ? current : incoming;
  const merged = {
    ...(isPlainObject(secondary) ? cloneJson(secondary) : {}),
    ...(isPlainObject(preferred) ? cloneJson(preferred) : {}),
  };
  for (const field of ["branchOptions", "flavorOptions", "requiresRepositories", "inferenceKeywords", "inheritVariant"]) {
    const values = [...new Set([
      ...(Array.isArray(preferred?.[field]) ? preferred[field] : []),
      ...(Array.isArray(secondary?.[field]) ? secondary[field] : []),
    ].map((value) => String(value || "").trim()).filter(Boolean))];
    merged[field] = canonicalOrder ? values.sort(compareSharedText) : values;
  }
  return normalizeDefPreservingMetadata(merged, merged);
}

function mergeConfigInferenceVehicleMapValues(vehicle, current, incoming, preferIncoming = true, canonicalOrder = false) {
  const preferred = configInferenceVehicleMappingForWriteback(vehicle, preferIncoming ? incoming : current);
  const secondary = configInferenceVehicleMappingForWriteback(vehicle, preferIncoming ? current : incoming);
  const merged = { ...cloneJson(secondary), ...cloneJson(preferred) };
  merged.aliases = [...new Set([...(preferred.aliases || []), ...(secondary.aliases || [])].filter(Boolean))];
  if (canonicalOrder) merged.aliases.sort(compareSharedText);
  const apps = cloneJson(preferred.apps || []);
  for (const secondaryApp of secondary.apps || []) {
    const appKey = String(secondaryApp?.appName || "").trim().toLowerCase();
    const index = apps.findIndex((app) => String(app?.appName || "").trim().toLowerCase() === appKey);
    if (index < 0) {
      apps.push(cloneJson(secondaryApp));
      continue;
    }
    const preferredApp = apps[index];
    const repos = cloneJson(preferredApp.repos || []);
    for (const repo of secondaryApp.repos || []) {
      const repoIndex = repos.findIndex((item) => configInferenceTupleKey(item) === configInferenceTupleKey(repo));
      if (repoIndex < 0) repos.push(cloneJson(repo));
      else repos[repoIndex] = { ...cloneJson(repo), ...repos[repoIndex] };
    }
    apps[index] = { ...cloneJson(secondaryApp), ...preferredApp, repos };
  }
  merged.apps = canonicalOrder
    ? apps
      .map((app) => ({
        ...app,
        repos: [...(app.repos || [])]
          .sort((left, right) => compareSharedText(configInferenceTupleKey(left), configInferenceTupleKey(right))),
      }))
      .sort((left, right) => compareSharedText(
        String(left?.appName || "").trim().toLowerCase(),
        String(right?.appName || "").trim().toLowerCase(),
      ))
    : apps;
  return configInferenceVehicleMappingForWriteback(vehicle, merged);
}

function isConfigInferenceAdditiveOp(op) {
  if (op?.mergeStrategy !== CONFIG_INFERENCE_ADDITIVE_MERGE) return false;
  return op.type === "projectDef.set"
    || (op.type === "byProject.set" && op.path?.[0] === "vehicleMap" && op.path.length === 2);
}

function applySharedOp(cfg, op) {
  if (!isValidSharedOp(op)) return false;
  switch (op?.type) {
    case "shared.restore": {
      const value = isPlainObject(op.value) ? op.value : {};
      if (Array.isArray(value.projectDefs)) cfg.projectDefs = cloneJson(value.projectDefs);
      cfg.byProject = isPlainObject(value.byProject) ? cloneJson(value.byProject) : {};
      cfg.dingtalkMsgConfig = isPlainObject(value.dingtalkMsgConfig) ? cloneJson(value.dingtalkMsgConfig) : null;
      if ("vehicleMapSeededAt" in value) cfg.vehicleMapSeededAt = Number(value.vehicleMapSeededAt) || 0;
      return true;
    }
    case "projectDef.set": {
      const current = (Array.isArray(cfg.projectDefs) ? cfg.projectDefs : [])
        .find((def) => String(def?.id || "") === String(op.value?.id || ""));
      const value = isConfigInferenceAdditiveOp(op) && current
        ? mergeConfigInferenceProjectDefValues(
          current,
          op.value,
          op.__preferIncoming !== false,
          op.__canonicalAdditiveOrder === true,
        )
        : op.value;
      upsertProjectDefInConfig(cfg, value);
      return true;
    }
    case "projectDef.delete":
      deleteProjectDefInConfig(cfg, op.idValue);
      return true;
    case "dingtalkMsgConfig.set":
      cfg.dingtalkMsgConfig = isPlainObject(op.value) ? cloneJson(op.value) : cfg.dingtalkMsgConfig;
      return true;
    case "byProject.set": {
      const location = configInferenceOpLocation(op);
      if (location) return applyConfigInferenceSet(cfg, op, location);
      const bucket = projectBucket(cfg, op.projectId);
      if (isConfigInferenceAdditiveOp(op)) {
        const vehicle = String(op.path[1]);
        bucket.vehicleMap = isPlainObject(bucket.vehicleMap) ? bucket.vehicleMap : {};
        bucket.vehicleMap[vehicle] = mergeConfigInferenceVehicleMapValues(
          vehicle,
          bucket.vehicleMap[vehicle],
          op.value,
          op.__preferIncoming !== false,
          op.__canonicalAdditiveOrder === true,
        );
        return true;
      }
      return setNestedValue(bucket, op.path, op.value);
    }
    case "byProject.delete": {
      const location = configInferenceOpLocation(op);
      if (location && location.section !== "settings") return applyConfigInferenceDelete(cfg, op, location);
      const bucket = projectBucket(cfg, op.projectId);
      return deleteNestedValue(bucket, op.path);
    }
    case "lesson.set": {
      const bucket = projectBucket(cfg, op.projectId);
      bucket.lessons = upsertArrayItem(bucket.lessons, op.value).slice(-200);
      return true;
    }
    case "lesson.delete": {
      const bucket = projectBucket(cfg, op.projectId);
      bucket.lessons = (Array.isArray(bucket.lessons) ? bucket.lessons : []).filter((x) => x?.id !== op.idValue);
      return true;
    }
    case "configMemory.set": {
      const bucket = projectBucket(cfg, op.projectId);
      // 配置记忆与经验库一样是有界共享集合。上限必须在操作重放层执行，
      // 不能只在 addConfigMemory 的调用侧裁剪；否则 SQLite 合并当前快照与
      // configMemory.set 时会重新得到 201 条，另一节点完整重放操作也会偏离快照。
      bucket.configMemory = upsertArrayItem(bucket.configMemory, op.value).slice(-200);
      return true;
    }
    case "configMemory.delete": {
      const bucket = projectBucket(cfg, op.projectId);
      bucket.configMemory = (Array.isArray(bucket.configMemory) ? bucket.configMemory : []).filter((x) => x?.id !== op.idValue);
      return true;
    }
    default:
      return false;
  }
}
function canonicalizeConfigInferenceAdditiveOps(cfg, ops = []) {
  return (Array.isArray(ops) ? ops : []).map((op) => {
    if (!isConfigInferenceAdditiveOp(op)) return op;
    const key = sharedOpKey(op);
    if (!key || String(cfg.sharedOpClocks?.[key]?.id || "") !== String(op.id || "")) return op;
    let value;
    if (op.type === "projectDef.set") {
      value = (Array.isArray(cfg.projectDefs) ? cfg.projectDefs : [])
        .find((def) => String(def?.id || "") === String(op.value?.id || ""));
    } else if (op.type === "byProject.set" && op.path?.[0] === "vehicleMap" && op.path.length === 2) {
      value = cfg.byProject?.[op.projectId]?.vehicleMap?.[op.path[1]];
    }
    return value === undefined ? op : { ...op, value: cloneJson(value) };
  });
}
function applySharedOps(cfg, ops) {
  const existingById = new Map(cleanSharedOps(cfg.sharedOps)
    .map((op) => [String(op.id || ""), op]));
  const incoming = cleanSharedOps(ops).filter((op) => op.id);
  cfg.sharedOpClocks = rebuildSharedOpClocks(cfg.sharedOpClocks, cfg.sharedOps);
  let applied = 0;
  const accepted = [];
  let maxAcceptedVersion = 0;
  let restoreApplied = false;
  for (const op of incoming) {
    const restoreBarrierVersion = Number(cfg.sharedRestoreClock?.version) || 0;
    const restoreBarrierId = String(cfg.sharedRestoreClock?.id || "");
    if (op.type !== "shared.restore" && restoreBarrierVersion > 0
      && (Number(op.version || 0) <= restoreBarrierVersion
        || String(op.restoreEpoch || "") !== restoreBarrierId)) continue;
    const key = sharedOpKey(op);
    const existingSameId = existingById.get(String(op.id));
    if (existingSameId) {
      const sameAdditiveState = key
        && key === sharedOpKey(existingSameId)
        && isConfigInferenceAdditiveOp(op)
        && isConfigInferenceAdditiveOp(existingSameId);
      if (!sameAdditiveState) continue;
      if (JSON.stringify(op.value) === JSON.stringify(existingSameId.value)) continue;
      const beforeState = op.type === "projectDef.set"
        ? (Array.isArray(cfg.projectDefs) ? cfg.projectDefs : []).find((def) => String(def?.id || "") === String(op.value?.id || ""))
        : cfg.byProject?.[op.projectId]?.vehicleMap?.[op.path?.[1]];
      const beforeStateJson = JSON.stringify(beforeState);
      const beforeStoredJson = JSON.stringify(existingSameId.value);
      if (!applySharedOp(cfg, {
        ...op,
        __preferIncoming: false,
        __canonicalAdditiveOrder: true,
      })) continue;
      const mergedState = op.type === "projectDef.set"
        ? (Array.isArray(cfg.projectDefs) ? cfg.projectDefs : []).find((def) => String(def?.id || "") === String(op.value?.id || ""))
        : cfg.byProject?.[op.projectId]?.vehicleMap?.[op.path?.[1]];
      const mergedJson = JSON.stringify(mergedState);
      if (mergedJson === beforeStateJson && mergedJson === beforeStoredJson) continue;
      // additive winner 是可增长的 checkpoint：同一 ID 的 payload 可能在其它节点
      // 折叠了更多分支/Flavor/tuple。按 join 合并而不是只按 ID 丢弃，才能让
      // 已见过旧 checkpoint 的节点接收扩大的全集。
      accepted.push({ ...op, value: cloneJson(mergedState) });
      maxAcceptedVersion = Math.max(maxAcceptedVersion, Number(op.version) || 0);
      if (mergedJson !== beforeStateJson) applied++;
      continue;
    }
    const current = key ? cfg.sharedOpClocks[key] : null;
    const clockComparison = current ? compareSharedClock(op, current) : 1;
    if (op.type === "shared.restore") {
      const currentRestore = cfg.sharedRestoreClock;
      if (!key || (currentRestore && compareSharedClock(op, currentRestore) <= 0)) continue;
      // restore 是新的因果 epoch：恢复值已经包含完整权威快照，旧 epoch 的 op/
      // clock 必须一起丢弃。否则离线节点的高时钟会在恢复后继续阻挡或复活旧值。
      cfg.sharedOps = [];
      cfg.sharedOpClocks = {};
      existingById.clear();
      accepted.length = 0;
      applied = 0;
      maxAcceptedVersion = 0;
      cfg.sharedOpClocks[key] = sharedOpClock(op);
      if (applySharedOp(cfg, op)) {
        accepted.push(op);
        applied = 1;
        maxAcceptedVersion = Number(op.version) || 0;
        cfg.sharedRestoreClock = sharedOpClock(op);
        restoreApplied = true;
      }
      continue;
    }
    const mergeLosingAdditive = !!current
      && clockComparison <= 0
      && isConfigInferenceAdditiveOp(op)
      && current.mergeStrategy === CONFIG_INFERENCE_ADDITIVE_MERGE;
    if (!key || (current && clockComparison <= 0 && !mergeLosingAdditive)) continue;
    if (!current || clockComparison > 0) cfg.sharedOpClocks[key] = sharedOpClock(op);
    accepted.push(op);
    maxAcceptedVersion = Math.max(maxAcceptedVersion, Number(op.version) || 0);
    const canonicalAdditiveOrder = isConfigInferenceAdditiveOp(op)
      && current?.mergeStrategy === CONFIG_INFERENCE_ADDITIVE_MERGE
      && String(current.node || "") !== String(op.node || "");
    const appliedOp = {
      ...op,
      ...(mergeLosingAdditive ? { __preferIncoming: false } : {}),
      ...(canonicalAdditiveOrder ? { __canonicalAdditiveOrder: true } : {}),
    };
    if (applySharedOp(cfg, appliedOp)) {
      applied++;
    }
  }
  if (accepted.length) {
    cfg.sharedOps = cleanSharedOps(canonicalizeConfigInferenceAdditiveOps(cfg, [
      ...(Array.isArray(cfg.sharedOps) ? cfg.sharedOps : []),
      ...accepted,
    ]));
  }
  return { applied, accepted: accepted.length, maxAcceptedVersion, restoreApplied };
}

function validateSharedRestoreEnvelope(cfg, bundle, normalizedOps) {
  const claimed = isPlainObject(bundle?.sharedRestoreClock) ? sharedOpClock(bundle.sharedRestoreClock) : null;
  const proof = latestSharedRestoreOp(normalizedOps);
  if ((claimed && !proof) || (!claimed && proof) || (claimed && proof && !sameSharedClock(claimed, proof))) {
    return { ok: false, error: "恢复屏障缺少匹配的 shared.restore 操作证据" };
  }
  if (claimed && normalizedOps.length !== bundle.sharedOps.length) {
    return { ok: false, error: "恢复 epoch 的共享操作集合包含无效或重复操作" };
  }
  const localRestore = isPlainObject(cfg.sharedRestoreClock) ? sharedOpClock(cfg.sharedRestoreClock) : null;
  if (localRestore && (!claimed || compareSharedClock(claimed, localRestore) < 0)) {
    return { ok: false, stale: true, error: "对端共享配置仍属于恢复前的旧 epoch" };
  }
  if (claimed) {
    for (const op of normalizedOps) {
      if (op.type === "shared.restore") continue;
      if (String(op.restoreEpoch || "") !== claimed.id || Number(op.version || 0) <= claimed.version) {
        return { ok: false, error: "恢复后的共享操作缺少匹配的因果 epoch" };
      }
    }
  }
  return { ok: true, claimed, proof };
}

function sanitizeProductionSharedValue(value = {}) {
  if (!isPlainObject(value)) return { value, changed: false, removedProjects: 0, removedProjectDefs: 0 };
  const projectDefs = Array.isArray(value.projectDefs)
    ? value.projectDefs.filter((def) => !isKnownSyntheticProjectDef(def))
    : value.projectDefs;
  const byProject = isPlainObject(value.byProject) ? { ...value.byProject } : value.byProject;
  let removedProjects = 0;
  if (isPlainObject(byProject)) {
    for (const projectId of SYNTHETIC_SHARED_PROJECT_IDS) {
      if (!Object.prototype.hasOwnProperty.call(byProject, projectId)) continue;
      delete byProject[projectId];
      removedProjects++;
    }
  }
  const removedProjectDefs = Array.isArray(value.projectDefs)
    ? value.projectDefs.length - projectDefs.length
    : 0;
  if (!removedProjects && !removedProjectDefs) {
    return { value, changed: false, removedProjects: 0, removedProjectDefs: 0 };
  }
  return {
    value: {
      ...value,
      ...(Array.isArray(value.projectDefs) ? { projectDefs } : {}),
      ...(isPlainObject(value.byProject) ? { byProject } : {}),
    },
    changed: true,
    removedProjects,
    removedProjectDefs,
  };
}

function sanitizeProductionIncomingBundle(bundle, localScope) {
  if (localScope !== "production") {
    return { bundle, ignoredSyntheticOps: 0, removedProjects: 0, removedProjectDefs: 0 };
  }
  const topLevel = sanitizeProductionSharedValue(bundle);
  let sanitized = topLevel.changed ? topLevel.value : bundle;
  let ignoredSyntheticOps = 0;
  if (Array.isArray(bundle.sharedOps)) {
    const sharedOps = [];
    for (const op of bundle.sharedOps) {
      if (SYNTHETIC_SHARED_PROJECT_IDS.has(String(op?.projectId || ""))
        || (op?.type === "projectDef.set" && isKnownSyntheticProjectDef(op.value))) {
        ignoredSyntheticOps++;
        continue;
      }
      if (op?.type === "shared.restore" && isPlainObject(op.value)) {
        const cleaned = sanitizeProductionSharedValue(op.value);
        sharedOps.push(cleaned.changed ? { ...op, value: cleaned.value } : op);
      } else {
        sharedOps.push(op);
      }
    }
    if (ignoredSyntheticOps || sharedOps.some((op, index) => op !== bundle.sharedOps[index])) {
      sanitized = { ...sanitized, sharedOps };
    }
  }
  const snapshot = bundle.aiTrainingSnapshot;
  if (isPlainObject(snapshot?.byProject)) {
    const byProject = { ...snapshot.byProject };
    let changed = false;
    for (const projectId of SYNTHETIC_SHARED_PROJECT_IDS) {
      if (!Object.prototype.hasOwnProperty.call(byProject, projectId)) continue;
      delete byProject[projectId];
      changed = true;
    }
    if (changed) {
      sanitized = {
        ...sanitized,
        aiTrainingSnapshot: { ...snapshot, byProject },
      };
    }
  }
  return {
    bundle: sanitized,
    ignoredSyntheticOps,
    removedProjects: topLevel.removedProjects,
    removedProjectDefs: topLevel.removedProjectDefs,
  };
}

// 应用对端 bundle：仅当版本更新时覆盖共享部分（保留本机 cloneParent/projects 等）
export function applySharedBundle(bundle) {
  if (!bundle || typeof bundle !== "object") return { ok: false, applied: false };
  const localScope = devbenchSyncScope();
  const remoteScope = String(bundle.syncScope || "production").trim() || "production";
  if (remoteScope !== localScope) {
    return {
      ok: false,
      applied: false,
      scopeMismatch: true,
      error: `共享配置作用域不一致（本机 ${localScope}，对端 ${remoteScope}）`,
    };
  }
  const sanitized = sanitizeProductionIncomingBundle(bundle, localScope);
  bundle = sanitized.bundle;
  const cfg = loadRawConfig();
  const localV = cfg._sharedVersion || 0;
  if (Array.isArray(bundle.sharedOps)) {
    const normalizedRemoteOps = cleanSharedOps(bundle.sharedOps);
    const hasCanonicalVersionProof = normalizedRemoteOps.length > 0
      && normalizedRemoteOps.length === bundle.sharedOps.length;
    const restoreEnvelope = validateSharedRestoreEnvelope(cfg, bundle, normalizedRemoteOps);
    if (!restoreEnvelope.ok) {
      return { ok: false, applied: false, localVersion: localV, error: restoreEnvelope.error };
    }
    const opResult = applySharedOps(cfg, bundle.sharedOps);
    // restore/普通配置操作先建立权威基线，再合并最新 AI 快照；反过来会让
    // retained shared.restore 把刚 bootstrap 的 run/sample 清回备份时状态。
    const snapshotProjects = mergeAiTrainingSnapshot(cfg, bundle.aiTrainingSnapshot);
    const remoteV = Number(bundle.version) || 0;
    if (!snapshotProjects && !opResult.accepted) {
      // 版本是本地写入水位而不是分布式内容哈希。操作集与 AI 快照均未带来
      // 任何新内容时，即使对端水位更高也不能回写整行或推进本机版本；否则
      // 多节点会仅凭彼此水位持续触发无意义写入和下一轮 gossip。
      return {
        ok: true,
        applied: false,
        localVersion: localV,
        ignoredSyntheticOps: sanitized.ignoredSyntheticOps,
        removedSyntheticProjects: sanitized.removedProjects,
        removedSyntheticProjectDefs: sanitized.removedProjectDefs,
        ...(remoteV > localV && hasCanonicalVersionProof ? { observedRemoteVersion: remoteV } : {}),
      };
    }
    const acceptedV = Number(opResult.maxAcceptedVersion) || 0;
    const winningV = Math.max(localV, remoteV, acceptedV);
    cfg._sharedVersion = winningV > localV ? winningV : nextSharedVersion(localV);
    ensureRepositoryInferenceProfiles(cfg);
    ensureProductionSharedPollutionCleanup(cfg);
    persistSharedConfig(cfg);
    const vehicleChanges = normalizedRemoteOps
      .filter((op) => (op.type === "byProject.set" || op.type === "byProject.delete")
        && op.path?.[0] === "vehicleMap")
      .map((op) => ({
        projectId: String(op.projectId || ""),
        flavor: String(op.path?.[1] || ""),
      }))
      .filter((entry) => entry.projectId && entry.flavor);
    if (vehicleChanges.length) {
      emitWs("shared_config_changed", {
        configSpace: remoteScope,
        projectIds: [...new Set(vehicleChanges.map((entry) => entry.projectId))],
        entityKeys: [...new Set(vehicleChanges.map((entry) => `${entry.projectId}/${entry.flavor}`))],
        revision: cfg._sharedVersion,
        sourceNodeId: String(normalizedRemoteOps[0]?.node || ""),
      });
    }
    return {
      ok: true,
      applied: true,
      version: cfg._sharedVersion,
      ops: opResult.applied,
      acceptedOps: opResult.accepted,
      snapshotProjects,
      restoreBarrierChanged: opResult.restoreApplied,
      ignoredSyntheticOps: sanitized.ignoredSyntheticOps,
      removedSyntheticProjects: sanitized.removedProjects,
      removedSyntheticProjectDefs: sanitized.removedProjectDefs,
    };
  }
  if (!(bundle.version > localV)) return { ok: true, applied: false, localVersion: localV };
  if (cfg.sharedRestoreClock) {
    return {
      ok: false,
      applied: false,
      localVersion: localV,
      error: "旧节点全量配置不包含恢复 epoch，已拒绝覆盖恢复后的共享状态",
    };
  }
  const localProjectDefs = cloneJson(Array.isArray(cfg.projectDefs) ? cfg.projectDefs : []);
  cfg.projectDefs = Array.isArray(bundle.projectDefs) ? bundle.projectDefs : cfg.projectDefs;
  cfg.byProject = mergeByProject(cfg.byProject, bundle.byProject);
  if ("dingtalkMsgConfig" in bundle) cfg.dingtalkMsgConfig = (bundle.dingtalkMsgConfig && typeof bundle.dingtalkMsgConfig === "object") ? bundle.dingtalkMsgConfig : cfg.dingtalkMsgConfig;
  // 旧节点没有 sharedOps，过去依赖整行覆盖来落盘。现在整行写入会在 SQLite
  // 事务内与最新状态合并，因此先把旧 bundle 翻译成同版本的增量操作，既保留
  // “缺省字段不清空本地”的兼容语义，也不会被原子合并当成旧快照丢弃。
  const legacyProjectDefs = Array.isArray(bundle.projectDefs) ? bundle.projectDefs : null;
  const legacyVersion = Number(bundle.version) || Date.now();
  const legacyOps = buildBaselineSharedOps({
    projectDefs: Array.isArray(bundle.projectDefs) ? bundle.projectDefs : [],
    byProject: isPlainObject(bundle.byProject) ? bundle.byProject : {},
    ...(Object.prototype.hasOwnProperty.call(bundle, "dingtalkMsgConfig")
      && isPlainObject(bundle.dingtalkMsgConfig)
      ? { dingtalkMsgConfig: bundle.dingtalkMsgConfig }
      : {}),
  }, legacyVersion).filter((op) => {
    if (op.type !== "projectDef.set" || !["appMarket", "webApp", "appMarketSdk", "aiEfficiency"].includes(op.value?.id)) return true;
    const raw = legacyProjectDefs?.find((def) => String(def?.id || "") === op.value.id);
    const localProfile = latestRepositoryInferenceProfileOp(cfg, op.value.id);
    return Number(raw?.inferenceProfileVersion || 0) > 0
      || Number(localProfile?.value?.inferenceProfileVersion || 0) <= 0;
  });
  if (legacyProjectDefs) {
    const remoteIds = new Set(legacyProjectDefs.map((def) => String(def?.id || "").trim()).filter(Boolean));
    let deleteSequence = 0;
    for (const def of localProjectDefs) {
      const id = String(def?.id || "").trim();
      if (!id || remoteIds.has(id)) continue;
      legacyOps.push({
        id: `${sharedNodeId()}:legacy-delete:${legacyVersion}:${deleteSequence++}`,
        node: sharedNodeId(),
        version: legacyVersion,
        at: legacyVersion,
        type: "projectDef.delete",
        idValue: id,
      });
    }
  }
  applySharedOps(cfg, legacyOps);
  cfg._sharedVersion = bundle.version;
  ensureRepositoryInferenceProfiles(cfg);
  ensureProductionSharedPollutionCleanup(cfg);
  persistSharedConfig(cfg);
  const legacyVehicleChanges = legacyOps
    .filter((op) => op.type === "byProject.set" && op.path?.[0] === "vehicleMap")
    .map((op) => `${op.projectId}/${op.path?.[1]}`)
    .filter(Boolean);
  if (legacyVehicleChanges.length) {
    emitWs("shared_config_changed", {
      configSpace: remoteScope,
      projectIds: [...new Set(legacyOps.map((op) => String(op.projectId || "")).filter(Boolean))],
      entityKeys: [...new Set(legacyVehicleChanges)],
      revision: cfg._sharedVersion,
      sourceNodeId: String(legacyOps[0]?.node || ""),
    });
  }
  return { ok: true, applied: true, version: cfg._sharedVersion };
}

// ========== 钉钉消息配置（全局共享、随 gossip 同步；管理员配置各场景的 @ 人等）==========
// 结构：{ publish: { signed:[{name,mobile}], unsigned:[{name,mobile}] }, ...后续场景 }
const DEFAULT_DING_MSG_CONFIG = {
  publish: {
    signed: [{ name: "付浩", mobile: "" }, { name: "张明", mobile: "" }],
    unsigned: [],
  },
};
export function getDingtalkMsgConfig() {
  const d = loadRawConfig().dingtalkMsgConfig;
  if (d && typeof d === "object") {
    const pub = d.publish && typeof d.publish === "object" ? d.publish : {};
    // signed 缺省时返回默认数组的**深拷贝**，绝不返回模块级 DEFAULT 的引用——
    // 否则调用方（路由回填/前端编辑）就地修改会永久污染进程内默认值。
    const defSigned = JSON.parse(JSON.stringify(DEFAULT_DING_MSG_CONFIG.publish.signed));
    return { ...DEFAULT_DING_MSG_CONFIG, ...d, publish: { signed: Array.isArray(pub.signed) ? pub.signed : defSigned, unsigned: Array.isArray(pub.unsigned) ? pub.unsigned : [] } };
  }
  return JSON.parse(JSON.stringify(DEFAULT_DING_MSG_CONFIG));
}
export function setDingtalkMsgConfig(next) {
  const cfg = loadRawConfig();
  cfg.dingtalkMsgConfig = next && typeof next === "object" ? next : {};
  writeSharedOps(cfg, { type: "dingtalkMsgConfig.set", value: cfg.dingtalkMsgConfig }); // bump 版本 + 落 SQLite + 走 gossip 同步
  return { ok: true, config: getDingtalkMsgConfig() };
}

// ========== 远程仓库配置 / 车型源码映射（远程拉取模式用）==========

// 远程仓库地址默认值（https + ssh）
const DEFAULT_REMOTES = {
  appMarket: { https: "https://codeup.aliyun.com/xunihezi/AppMarket", ssh: "git@codeup.aliyun.com:xunihezi/AppMarket.git" },
  appMarketSdk: { https: "https://codeup.aliyun.com/xunihezi/AppMarket", ssh: "git@codeup.aliyun.com:xunihezi/AppMarket.git" },
  webApp: { https: "https://codeup.aliyun.com/xunihezi/CarBoxDev/WebApp", ssh: "git@codeup.aliyun.com:xunihezi/CarBoxDev/WebApp.git" },
};
// ========== 工程定义（统一维度：仓库定义 + 可选本地路径）==========
// 把原先写死的 应用市场/SDK/WebApp 三类作为内置种子；管理员可增删（天气/媒体空间…）。
// 一个工程 = { id, name, https, ssh, localPath? }；WebApp 也作为独立工程定义和绑定。
const DEFAULT_PROJECT_DEFS = [
  {
    id: "appMarket",
    name: "应用市场",
    https: DEFAULT_REMOTES.appMarket.https,
    ssh: DEFAULT_REMOTES.appMarket.ssh,
    projectType: "application",
    inferenceProfileVersion: 3,
    inferenceEnabled: false,
    inferenceKeywords: [],
    requiresRepositories: [],
    inheritVariant: [],
    workspaceBundle: {
      enabled: true,
      id: "appmarket-webapp-bundle",
      buildEntryRepositoryId: "appMarket",
      layoutPolicy: { type: "SAME_PARENT_SIBLINGS" },
      branchPolicy: { type: "SAME_LOGICAL_BRANCH", strict: true },
      members: [
        { repositoryId: "appMarket", checkoutDirName: "AppMarket", required: true, mode: "EDITABLE" },
        { repositoryId: "webApp", checkoutDirName: "AppMarketWeb", required: true, mode: "READ_ONLY" },
      ],
    },
  },
  {
    id: "webApp",
    name: "WebApp",
    https: DEFAULT_REMOTES.webApp.https,
    ssh: DEFAULT_REMOTES.webApp.ssh,
    projectType: "repository",
    inferenceProfileVersion: 2,
    inferenceEnabled: true,
    inferenceKeywords: ["WebApp", "web app", "H5", "网页应用", "前端"],
    requiresRepositories: ["appMarket"],
    inheritVariant: ["vehicle"],
    inferenceRole: "dependency",
  },
  {
    id: "appMarketSdk",
    name: "应用市场SDK",
    https: DEFAULT_REMOTES.appMarketSdk.https,
    ssh: DEFAULT_REMOTES.appMarketSdk.ssh,
    projectType: "sdk",
    inferenceProfileVersion: 2,
    inferenceKeywords: ["语音", "voice", "tts"],
    requiresRepositories: ["appMarket"],
    inheritVariant: ["vehicle"],
    defaultBranch: "feat/202605sdkaiV4",
  },
  {
    id: "aiEfficiency",
    name: "AIEfficiency",
    https: "https://codeup.aliyun.com/xunihezi/AIEfficiency",
    ssh: "git@codeup.aliyun.com:xunihezi/AIEfficiency.git",
    projectType: "tooling",
    inferenceProfileVersion: 2,
    inferenceEnabled: true,
    inferenceKeywords: ["AIEfficiency", "DevBench", "AI训练", "脚本工具"],
    requiresRepositories: [],
    inheritVariant: [],
    defaultBranch: "feat/admin-rbac",
  },
];
const REPOSITORY_INFERENCE_PROFILES_VERSION = 3;
const SYNTHETIC_PROJECT_DEF_IDS = new Set([
  "market", "web", "same-name-a", "same-name-b", "custom-app", "voice-sdk-custom",
]);
const SYNTHETIC_SHARED_PROJECT_IDS = new Set([
  "acceptance-project",
  "project-a",
  "resolve-invariants-project",
  "project-config-writeback",
  "value-binding-concurrency-project",
  "symbol-resolution-concurrency-project",
]);

function isKnownSyntheticProjectDef(def = {}) {
  const id = String(def?.id || "").trim();
  if (!SYNTHETIC_PROJECT_DEF_IDS.has(id)) return false;
  const remotes = `${String(def?.https || "")} ${String(def?.ssh || "")}`.toLowerCase();
  return remotes.includes("example.com");
}

function stripKnownSdkFixtureMetadata(def = {}) {
  if (String(def?.id || "") !== "appMarketSdk") return { changed: false, value: def };
  const value = cloneJson(def);
  let changed = false;
  if (value.customRepositoryMetadata?.owner === "sdk-owner"
    && value.customRepositoryMetadata?.module === "voice-sdk") {
    delete value.customRepositoryMetadata;
    changed = true;
  }
  if (value.releasePolicy?.channel === "sdk-stable"
    && value.releasePolicy?.requireSignedArtifact === true) {
    delete value.releasePolicy;
    changed = true;
  }
  return { changed, value };
}

function syntheticProjectBucketDeleteOps(projectId, bucket = {}) {
  const ops = [];
  for (const key of Object.keys(isPlainObject(bucket.vehicleMap) ? bucket.vehicleMap : {})) {
    ops.push({ type: "byProject.delete", projectId, path: ["vehicleMap", key] });
  }
  for (const [group, mappings] of Object.entries(isPlainObject(bucket.keywordMappings) ? bucket.keywordMappings : {})) {
    for (const key of Object.keys(isPlainObject(mappings) ? mappings : {})) {
      ops.push({ type: "byProject.delete", projectId, path: ["keywordMappings", group, key] });
    }
  }
  for (const key of Object.keys(isPlainObject(bucket.statusMap) ? bucket.statusMap : {})) {
    ops.push({ type: "byProject.delete", projectId, path: ["statusMap", key] });
  }
  const storyPoint = bucket.aiTraining?.storyPoint;
  if (isPlainObject(storyPoint?.settings) && Object.keys(storyPoint.settings).length > 0) {
    ops.push({ type: "byProject.delete", projectId, path: ["aiTraining", "storyPoint", "settings"] });
  }
  for (const section of ["buildLineage", "goldCases", "dryRuns"]) {
    for (const key of Object.keys(isPlainObject(storyPoint?.[section]) ? storyPoint[section] : {})) {
      ops.push({ type: "byProject.delete", projectId, path: ["aiTraining", "storyPoint", section, key] });
    }
  }
  const configInference = bucket.aiTraining?.configInference;
  if (isPlainObject(configInference?.settings) && Object.keys(configInference.settings).length > 0) {
    ops.push({ type: "byProject.delete", projectId, path: ["aiTraining", "configInference", "settings"] });
  }
  for (const section of CONFIG_INFERENCE_SHARED_SECTIONS) {
    for (const key of Object.keys(isPlainObject(configInference?.[section]) ? configInference[section] : {})) {
      ops.push({ type: "byProject.delete", projectId, path: ["aiTraining", "configInference", section, key] });
    }
  }
  for (const row of Array.isArray(bucket.lessons) ? bucket.lessons : []) {
    if (row?.id) ops.push({ type: "lesson.delete", projectId, idValue: String(row.id) });
  }
  for (const row of Array.isArray(bucket.configMemory) ? bucket.configMemory : []) {
    if (row?.id) ops.push({ type: "configMemory.delete", projectId, idValue: String(row.id) });
  }
  return ops;
}

function ensureProductionSharedPollutionCleanup(cfg, opts = {}) {
  if (opts.force !== true && (!USES_REPOSITORY_MARKET_CONFIG || devbenchSyncScope() !== "production")) return false;
  const appendOps = opts.appendOps !== false;
  const stored = Array.isArray(cfg.projectDefs) ? cfg.projectDefs : [];
  const removed = stored.filter(isKnownSyntheticProjectDef);
  const syntheticBuckets = Object.entries(isPlainObject(cfg.byProject) ? cfg.byProject : {})
    .filter(([projectId]) => SYNTHETIC_SHARED_PROJECT_IDS.has(projectId))
    .map(([projectId, bucket]) => [projectId, bucket, syntheticProjectBucketDeleteOps(projectId, bucket)])
    // 空容器和删除 tombstone 需要保留以阻止旧节点复活，但不再属于有效训练数据，
    // 也不能因此让每次 getSharedVersion 都重写 JSON 镜像。
    .filter(([, , deleteOps]) => deleteOps.length > 0);
  let next = stored.filter((def) => !isKnownSyntheticProjectDef(def));
  let changed = removed.length > 0 || syntheticBuckets.length > 0;
  const sdkIndex = next.findIndex((def) => String(def?.id || "") === "appMarketSdk");
  if (sdkIndex >= 0) {
    const cleanedSdk = stripKnownSdkFixtureMetadata(next[sdkIndex]);
    if (cleanedSdk.changed) {
      next[sdkIndex] = normalizeDefPreservingMetadata(cleanedSdk.value, cleanedSdk.value);
      changed = true;
    }
  }
  if (!changed) return false;
  cfg.projectDefs = next;
  if (isPlainObject(cfg.byProject)) {
    for (const [projectId] of syntheticBuckets) delete cfg.byProject[projectId];
  }
  if (appendOps) {
    for (const def of removed) appendSharedOp(cfg, { type: "projectDef.delete", idValue: String(def.id) });
    for (const [, , deleteOps] of syntheticBuckets) {
      for (const op of deleteOps) appendSharedOp(cfg, op);
    }
    if (sdkIndex >= 0 && JSON.stringify(next[sdkIndex]) !== JSON.stringify(stored.find((def) => def?.id === "appMarketSdk"))) {
      // projectDef.set 会有意保留未知扩展元数据。清理测试夹具必须先发 delete，
      // 再发 clean set，确保旧节点也能真正移除 owner/releasePolicy，而不是继续继承。
      appendSharedOp(cfg, { type: "projectDef.delete", idValue: "appMarketSdk" });
      appendSharedOp(cfg, { type: "projectDef.set", value: next[sdkIndex] });
    }
  }
  return true;
}

export function __testCleanSyntheticProjectDefs(projectDefs = []) {
  const cfg = { projectDefs: cloneJson(projectDefs), sharedOps: [], sharedOpClocks: {}, _sharedVersion: 1 };
  ensureProductionSharedPollutionCleanup(cfg, { appendOps: false, force: true });
  return cfg.projectDefs;
}

export function __testCleanSyntheticSharedState(input = {}) {
  const cfg = {
    projectDefs: cloneJson(input.projectDefs || []),
    byProject: cloneJson(input.byProject || {}),
    sharedOps: [],
    sharedOpClocks: {},
    _sharedVersion: 1,
  };
  ensureProductionSharedPollutionCleanup(cfg, { appendOps: false, force: true });
  return { projectDefs: cfg.projectDefs, byProject: cfg.byProject };
}

// 旧版 market-projects.json 内置过的车型源码配置。共享态被空包覆盖到全空时，用它做一次兼容恢复。
const DEFAULT_VEHICLE_MAP = {
  avatr8155: { appMarketBranch: "v202605-ui", needWebApp: false, webAppBranch: "", needSdk: false, sdkBranch: "" },
  avatr8678: { appMarketBranch: "v202605-ui", needWebApp: false, webAppBranch: "", needSdk: false, sdkBranch: "" },
  zeekr9x: { appMarketBranch: "v202605-ui", needWebApp: false, webAppBranch: "", needSdk: false, sdkBranch: "" },
  geelye22: { appMarketBranch: "release/geely-e22", needWebApp: true, webAppBranch: "release/geely-e22", needSdk: false, sdkBranch: "" },
};

// git 地址 https↔ssh 互转：
//   https://host/group/repo(.git) ⇄ git@host:group/repo.git
function sshToHttps(u) {
  const m = String(u).trim().match(/^git@([^:]+):(.+?)(?:\.git)?\/?$/i);
  return m ? `https://${m[1]}/${m[2]}` : "";
}
// 只填一个时推断另一个；两个都填则原样保留
function deriveGitPair(https, ssh) {
  let h = String(https || "").trim(), s = String(ssh || "").trim();
  if (h && !s) s = gitHttpsToSsh(h);
  else if (s && !h) h = sshToHttps(s);
  return { https: h, ssh: s };
}

function normalizeProjectDefList(value, max = 100) {
  const rows = Array.isArray(value) ? value : String(value || "").split(/[,，;；\n]+/);
  return [...new Set(rows.map((item) => String(item || "").trim()).filter(Boolean))].slice(0, max);
}

function normalizeProjectDefType(value) {
  const type = String(value || "").trim().toLowerCase();
  if (type === "tool") return "tooling";
  return ["application", "sdk", "tooling", "service", "repository"].includes(type) ? type : "application";
}

const REPOSITORY_INFERENCE_FIELDS = [
  "projectType", "type", "inferenceEnabled", "inferenceKeywords", "keywords", "aliases",
  "requiresRepositories", "dependsOn", "inheritVariant", "defaultBranch", "branch",
  "defaultFlavor", "flavor", "branchOptions", "branches", "flavorOptions", "flavors",
  "inferenceOrder", "targetOrder", "inferenceRole", "targetRole",
];

function hasRepositoryInferenceFields(d = {}) {
  return REPOSITORY_INFERENCE_FIELDS.some((field) => Object.prototype.hasOwnProperty.call(d, field));
}

function hydrateLegacyRepositoryInferenceProfile(d = {}) {
  const desired = DEFAULT_PROJECT_DEFS.find((def) => def.id === String(d?.id || "").trim());
  if (!desired || !["webApp", "appMarketSdk", "aiEfficiency"].includes(desired.id)) return d;
  // 旧版仓库定义完全没有推理画像字段。只识别这种旧结构并补齐；新版用户显式填写
  // projectType/关键词/依赖（包括显式清空）时原样保留，避免自愈逻辑覆盖人工配置。
  if (hasRepositoryInferenceFields(d)) return d;
  return {
    ...d,
    projectType: desired.projectType,
    inferenceProfileVersion: desired.inferenceProfileVersion,
    inferenceEnabled: desired.inferenceEnabled === true,
    inferenceKeywords: desired.inferenceKeywords,
    requiresRepositories: desired.requiresRepositories,
    inheritVariant: desired.inheritVariant,
    defaultBranch: desired.defaultBranch,
    defaultFlavor: desired.defaultFlavor,
  };
}

function normalizeDef(d = {}) {
  d = hydrateLegacyRepositoryInferenceProfile(d);
  // 仓库定义 = 仓库名 + 唯一 git 地址（不含本地路径：一个仓库本地可有多份源码，由 仓库名+分支→本地路径 另行映射）
  const { https, ssh } = deriveGitPair(d.https, d.ssh);
  const inferenceProfileVersion = Math.max(0, Number(d.inferenceProfileVersion) || 0);
  const inferenceOrder = Math.max(0, Math.trunc(Number(d.inferenceOrder || d.targetOrder) || 0));
  const rawInferenceRole = String(d.inferenceRole || d.targetRole || "").trim().toLowerCase();
  const inferenceRole = ["primary", "dependency", "standalone"].includes(rawInferenceRole) ? rawInferenceRole : "";
  const branchOptions = normalizeProjectDefList(d.branchOptions || d.branches, 200);
  const flavorOptions = normalizeProjectDefList(d.flavorOptions || d.flavors, 200);
  const workspaceBundle = normalizeWorkspaceBundle(d.workspaceBundle, {
    definitionId: String(d.id || "").trim(),
  });
  return {
    id: String(d.id || "").trim(),
    name: String(d.name || d.id || "").trim(),
    https,
    ssh,
    projectType: normalizeProjectDefType(d.projectType || d.type),
    inferenceEnabled: d.inferenceEnabled === true,
    inferenceKeywords: normalizeProjectDefList(d.inferenceKeywords || d.keywords || d.aliases),
    requiresRepositories: normalizeProjectDefList(d.requiresRepositories || d.dependsOn, 50),
    inheritVariant: normalizeProjectDefList(d.inheritVariant, 10).filter((field) => ["vehicle", "branch", "flavor"].includes(field)),
    defaultBranch: String(d.defaultBranch || d.branch || "").trim(),
    defaultFlavor: String(d.defaultFlavor || d.flavor || "").trim(),
    ...(branchOptions.length ? { branchOptions } : {}),
    ...(flavorOptions.length ? { flavorOptions } : {}),
    ...(inferenceOrder > 0 ? { inferenceOrder } : {}),
    ...(inferenceRole ? { inferenceRole } : {}),
    ...(inferenceProfileVersion > 0 ? { inferenceProfileVersion } : {}),
    ...(workspaceBundle ? { workspaceBundle } : {}),
  };
}

// AI 训练写回和局域网增量同步只应标准化已知仓库字段，不能顺带删除配置中
// 由其它模块维护的扩展元数据（例如发布策略、负责人或自定义仓库属性）。
const PROJECT_DEF_NORMALIZED_FIELDS = new Set([
  "id", "name", "https", "ssh", "projectType", "type", "inferenceEnabled",
  "inferenceKeywords", "keywords", "aliases", "requiresRepositories", "dependsOn",
  "inheritVariant", "defaultBranch", "branch", "defaultFlavor", "flavor",
  "branchOptions", "branches", "flavorOptions", "flavors", "inferenceOrder",
  "targetOrder", "inferenceRole", "targetRole", "inferenceProfileVersion", "workspaceBundle",
]);

function normalizeDefPreservingMetadata(input = {}, base = input) {
  const source = isPlainObject(base) ? cloneJson(base) : {};
  const sourceMetadata = Object.fromEntries(
    Object.entries(source).filter(([key]) => !PROJECT_DEF_NORMALIZED_FIELDS.has(key)),
  );
  const patch = isPlainObject(input) ? cloneJson(input) : {};
  // projectDef.set 对已知字段是完整替换语义；只从旧值继承扩展元数据。
  // 否则旧操作遗漏 inferenceProfileVersion 时会错误继承新版本号并绕过画像自愈。
  const merged = { ...sourceMetadata, ...patch };
  return { ...merged, ...normalizeDef(merged) };
}

function isExactLegacyRepositoryInferenceProfile(def = {}) {
  return !def.inferenceProfileVersion
    && def.projectType === "application"
    && def.inferenceEnabled !== true
    && !def.inferenceKeywords?.length
    && !def.requiresRepositories?.length
    && !def.inheritVariant?.length
    && !def.defaultBranch
    && !def.defaultFlavor;
}

function upgradeRepositoryInferenceProfile(current, desired) {
  const normalized = normalizeDef(current);
  const desiredProfileVersion = Math.max(1, Number(desired?.inferenceProfileVersion) || REPOSITORY_INFERENCE_PROFILES_VERSION);
  const workspaceBundlePatch = desired.workspaceBundle && !Object.prototype.hasOwnProperty.call(current, "workspaceBundle")
    ? { workspaceBundle: desired.workspaceBundle }
    : {};
  if (!hasRepositoryInferenceFields(current) || isExactLegacyRepositoryInferenceProfile(normalized)) {
    return normalizeDefPreservingMetadata({
      ...desired,
      ...current,
      projectType: desired.projectType,
      inferenceProfileVersion: desiredProfileVersion,
      inferenceEnabled: desired.inferenceEnabled === true,
      inferenceKeywords: desired.inferenceKeywords,
      requiresRepositories: desired.requiresRepositories,
      inheritVariant: desired.inheritVariant,
      defaultBranch: desired.defaultBranch,
      defaultFlavor: desired.defaultFlavor,
      ...workspaceBundlePatch,
    }, current);
  }
  return normalizeDefPreservingMetadata(
    { ...normalized, ...workspaceBundlePatch, inferenceProfileVersion: desiredProfileVersion },
    current,
  );
}

function latestRepositoryInferenceProfileOp(cfg, id) {
  let winner = null;
  for (const op of cleanSharedOps(cfg?.sharedOps)) {
    let candidate = null;
    if (op.type === "projectDef.set" && op.value?.id === id) candidate = op;
    else if (op.type === "projectDef.delete" && op.idValue === id) candidate = op;
    else if (op.type === "shared.restore" && Array.isArray(op.value?.projectDefs)) {
      const restored = op.value.projectDefs.find((def) => String(def?.id || "") === id);
      candidate = restored
        ? { ...op, type: "projectDef.set", value: restored, restored: true }
        : { ...op, type: "projectDef.delete", idValue: id, restored: true };
    }
    if (candidate && (!winner || compareSharedClock(candidate, winner) > 0)) winner = candidate;
  }
  return winner;
}

function uniqueProjectDefsById(defs) {
  const out = [];
  const indexById = new Map();
  for (const def of Array.isArray(defs) ? defs : []) {
    const id = String(def?.id || "").trim();
    if (!id) continue;
    if (indexById.has(id)) out[indexById.get(id)] = def;
    else {
      indexById.set(id, out.length);
      out.push(def);
    }
  }
  return out;
}

function reconcileProjectDefsFromSharedOps(cfg) {
  if (!Array.isArray(cfg?.sharedOps) || !cfg.sharedOps.length) return false;
  const winners = new Map();
  for (const id of ["appMarket", "webApp", "appMarketSdk", "aiEfficiency"]) {
    const winner = latestRepositoryInferenceProfileOp(cfg, id);
    if (winner) winners.set(id, winner);
  }
  if (!winners.size) return false;

  const before = Array.isArray(cfg.projectDefs)
    ? uniqueProjectDefsById(cfg.projectDefs).map((def) => normalizeDefPreservingMetadata(def)).filter((def) => def.id)
    : [];
  let next = before.slice();
  for (const [id, op] of winners) {
    const index = next.findIndex((def) => def.id === id);
    if (op.type === "projectDef.delete") {
      if (index >= 0) next.splice(index, 1);
      continue;
    }
    const entry = normalizeDefPreservingMetadata(op.value, index >= 0 ? next[index] : {});
    if (index >= 0) next[index] = entry; else next.push(entry);
  }
  if (JSON.stringify(before) === JSON.stringify(next)) return false;
  cfg.projectDefs = next;
  return true;
}

function ensureRepositoryInferenceProfiles(cfg, opts = {}) {
  const appendOps = opts.appendOps !== false;
  let changed = reconcileProjectDefsFromSharedOps(cfg);
  const needsMigration = (Number(cfg.repositoryInferenceProfilesVersion) || 0) < REPOSITORY_INFERENCE_PROFILES_VERSION;
  const desiredProfiles = DEFAULT_PROJECT_DEFS.filter((def) => ["appMarket", "webApp", "appMarketSdk", "aiEfficiency"].includes(def.id));
  const storedSource = Array.isArray(cfg.projectDefs)
    ? [...cfg.projectDefs]
    : (needsMigration ? [...DEFAULT_PROJECT_DEFS] : []);
  const stored = uniqueProjectDefsById(storedSource);
  if (stored.length !== storedSource.length) changed = true;
  for (const desired of desiredProfiles) {
    const index = stored.findIndex((def) => String(def?.id || "") === desired.id);
    // 当前 schema 下缺失表示用户已经显式删除，不能在每次读取时复活。
    if (index < 0 && !needsMigration) continue;
    const current = index >= 0 && stored[index] && typeof stored[index] === "object" ? stored[index] : {};
    const normalizedCurrent = normalizeDef(current);
    const desiredProfileVersion = Math.max(1, Number(desired.inferenceProfileVersion) || REPOSITORY_INFERENCE_PROFILES_VERSION);
    const entry = Number(normalizedCurrent.inferenceProfileVersion || 0) < desiredProfileVersion
      ? upgradeRepositoryInferenceProfile(current, desired)
      : normalizeDefPreservingMetadata(normalizedCurrent, current);
    const profileChanged = index < 0 || JSON.stringify(current) !== JSON.stringify(entry);
    if (index >= 0) stored[index] = entry; else stored.push(entry);
    const sharedProfileOp = latestRepositoryInferenceProfileOp(cfg, desired.id);
    const hasVersionedSharedProfileOp = sharedProfileOp?.type === "projectDef.set"
      && Number(sharedProfileOp.value?.inferenceProfileVersion) >= desiredProfileVersion;
    // legacy 全量快照可能反复把 JSON 写回旧结构；已有版本化增量操作时只需本地落盘修复，
    // 不能每轮 gossip 都追加同值操作并制造共享版本风暴。
    if (appendOps && !hasVersionedSharedProfileOp) {
      appendSharedOp(cfg, { type: "projectDef.set", value: entry });
      changed = true;
    }
    if (profileChanged) changed = true;
  }
  cfg.projectDefs = stored;
  if (needsMigration) {
    cfg.repositoryInferenceProfilesVersion = REPOSITORY_INFERENCE_PROFILES_VERSION;
    changed = true;
  }
  return changed;
}

// 读取仓库定义列表（无则从旧 remotes 迁移种子，不落盘，首次写入时持久化）。
export function getProjectDefs() {
  const cfg = loadRawConfig();
  // 列表读取不能悄悄修改 Git 跟踪配置或共享 DB。迁移后的有效画像在副本上
  // 计算；真正的同步、增删操作会显式持久化这些默认画像。
  const effective = cloneJson(cfg);
  ensureRepositoryInferenceProfiles(effective, { appendOps: false });
  ensureProductionSharedPollutionCleanup(effective, { appendOps: false });
  return configuredProjectDefsOrDefaults(effective).map(normalizeDef).filter((d) => d.id);
}

export function getProjectDef(id) { return getProjectDefs().find((d) => d.id === id) || null; }

export function normalizeTeamProjectDef(input = {}) {
  const def = normalizeDef(input);
  if (!def.id || !def.name) {
    throw Object.assign(new Error("仓库定义缺少 id 或 name"), {
      statusCode: 400,
      code: "PROJECT_DEF_INVALID",
    });
  }
  for (const field of ["https", "ssh"]) {
    const value = String(def[field] || "");
    if (/^https?:\/\//i.test(value)) {
      try {
        const url = new URL(value);
        if (url.username || url.password) {
          throw Object.assign(new Error(`仓库定义 ${field} 不得包含 URL 凭据`), {
            statusCode: 400,
            code: "PROJECT_DEF_CREDENTIAL_FORBIDDEN",
          });
        }
      } catch (error) {
        if (error?.code) throw error;
      }
    }
  }
  return def;
}

export function upsertProjectDef(input = {}) {
  const { id, name, https, ssh } = input;
  if (!name || !String(name).trim()) return { ok: false, error: "仓库名不能为空" };
  const entryId = id || genId(name);
  const builtInProfile = DEFAULT_PROJECT_DEFS.find((definition) => definition.id === String(entryId));
  const entry = normalizeDef({
    ...input,
    id: entryId,
    name,
    https,
    ssh,
    ...(["appMarket", "webApp", "appMarketSdk", "aiEfficiency"].includes(String(entryId))
      ? { inferenceProfileVersion: Math.max(1, Number(builtInProfile?.inferenceProfileVersion) || REPOSITORY_INFERENCE_PROFILES_VERSION) }
      : {}),
  });
  const cfg = loadRawConfig();
  const stored = getProjectDefs();
  const bundleValidation = validateWorkspaceBundle(input.workspaceBundle, {
    definitionId: entryId,
    knownRepositoryIds: [...stored.map((definition) => definition.id), entryId],
  });
  if (!bundleValidation.ok) return { ok: false, code: bundleValidation.code, error: bundleValidation.error };
  if (bundleValidation.bundle) entry.workspaceBundle = bundleValidation.bundle;
  const others = stored.filter((d) => d.id !== entry.id);
  // 去重：仓库名唯一
  if (others.some((d) => d.name.toLowerCase() === entry.name.toLowerCase())) return { ok: false, error: `仓库名「${entry.name}」已存在` };
  // 去重：git 地址唯一（按 ssh，回退 https）
  const gitKey = (entry.ssh || entry.https || "").toLowerCase();
  const dup = gitKey ? others.find((d) => (d.ssh || d.https || "").toLowerCase() === gitKey) : null;
  // 同一远程可包含多个逻辑工程（例如 AppMarket 主工程与 SDK 模块）；至少一方声明为
  // SDK/工具/服务型工程时允许复用。两个普通应用定义仍保持 git 地址唯一。
  if (dup && entry.projectType === "application" && dup.projectType === "application") {
    return { ok: false, error: `该 git 地址已被仓库「${dup.name}」使用` };
  }
  const idx = stored.findIndex((d) => d.id === entry.id);
  if (idx >= 0) stored[idx] = entry; else stored.push(entry);
  cfg.projectDefs = stored;
  cfg.repositoryInferenceProfilesVersion = REPOSITORY_INFERENCE_PROFILES_VERSION;
  appendSharedOp(cfg, { type: "projectDef.set", value: entry }); // bump 版本以触发局域网 gossip 同步
  persistSharedConfig(cfg);
  return { ok: true, def: entry };
}

export function deleteProjectDef(id) {
  const cfg = loadRawConfig();
  cfg.projectDefs = getProjectDefs().filter((d) => d.id !== id);
  cfg.repositoryInferenceProfilesVersion = REPOSITORY_INFERENCE_PROFILES_VERSION;
  appendSharedOp(cfg, { type: "projectDef.delete", idValue: String(id || "") });
  persistSharedConfig(cfg);
  return { ok: true };
}


// ===== 关键词映射（key 来自 TB 单六类信号 → 配置维度和值）=====
// attachment/comment 由配置推理或实际执行时按工单快照自动采集；
// project/iteration/tag 仍可通过管理面板从 TB 主数据同步。
export const KW_GROUPS = ["title", "project", "iteration", "tag", "attachment", "comment"];
export function getKeywordMappings(projectId) {
  const cfg = loadRawConfig();
  if (ensureMigrated(cfg)) persistSharedConfig(cfg);
  const km = projectBucket(cfg, projectId).keywordMappings || {};
  const out = {};
  for (const g of KW_GROUPS) out[g] = (km[g] && typeof km[g] === "object") ? km[g] : {};
  return out;
}
// 同步某组的 key（新 key 补空映射，保留已有映射；不删除旧 key）
export function syncKeywordKeys(projectId, group, keys = [], retry = 0) {
  if (!KW_GROUPS.includes(group)) return { ok: false, error: "未知分组" };
  const cfg = loadRawConfig();
  ensureMigrated(cfg);
  const bucket = projectBucket(cfg, projectId);
  bucket.keywordMappings = bucket.keywordMappings || {};
  const m = bucket.keywordMappings[group] = bucket.keywordMappings[group] || {};
  let added = 0;
  const ops = [];
  const expectedAbsent = new Set();
  for (const k of keys) {
    const key = String(k || "").trim();
    if (key && !(key in m)) {
      m[key] = { category: "", value: "" };
      expectedAbsent.add(key);
      ops.push({ type: "byProject.set", projectId, path: ["keywordMappings", group, key], value: m[key] });
      added++;
    }
  }
  try {
    writeSharedOps(cfg, ops, {
      guard: (latest) => {
        const latestMappings = latest?.byProject?.[projectId]?.keywordMappings?.[group];
        for (const key of expectedAbsent) {
          if (isPlainObject(latestMappings) && Object.hasOwn(latestMappings, key)) {
            return `关键词 ${key} 已由其它 Gateway 设置映射`;
          }
        }
        return true;
      },
    });
  } catch (error) {
    if (error?.code === "SHARED_WRITE_CONFLICT" && retry < 2) {
      return syncKeywordKeys(projectId, group, keys, retry + 1);
    }
    throw error;
  }
  return { ok: true, added, total: Object.keys(m).length };
}
// 设置某 key 的映射（category: "app"|"vehicle"，value: 应用名/车型名）
export function setKeywordMapping(projectId, group, key, category, value) {
  if (!KW_GROUPS.includes(group)) return { ok: false, error: "未知分组" };
  const k = String(key || "").trim();
  if (!k) return { ok: false, error: "key 不能为空" };
  const cfg = loadRawConfig();
  ensureMigrated(cfg);
  const bucket = projectBucket(cfg, projectId);
  bucket.keywordMappings = bucket.keywordMappings || {};
  bucket.keywordMappings[group] = bucket.keywordMappings[group] || {};
  bucket.keywordMappings[group][k] = { category: String(category || "").trim(), value: String(value || "").trim() };
  writeSharedOps(cfg, { type: "byProject.set", projectId, path: ["keywordMappings", group, k], value: bucket.keywordMappings[group][k] });
  return { ok: true };
}
// 清理某组里满足 predicate(key) 的 key（如清旧格式残留）。返回删除数。
export function pruneKeywordKeys(projectId, group, predicate) {
  const cfg = loadRawConfig();
  const bucket = projectBucket(cfg, projectId);
  const m = bucket.keywordMappings?.[group];
  if (!m) return 0;
  let n = 0;
  const ops = [];
  for (const k of Object.keys(m)) {
    if (predicate(k)) {
      delete m[k];
      ops.push({ type: "byProject.delete", projectId, path: ["keywordMappings", group, k] });
      n++;
    }
  }
  writeSharedOps(cfg, ops);
  return n;
}
export function deleteKeywordMapping(projectId, group, key) {
  const cfg = loadRawConfig();
  const bucket = projectBucket(cfg, projectId);
  if (bucket.keywordMappings?.[group]) {
    const k = String(key);
    delete bucket.keywordMappings[group][k];
    writeSharedOps(cfg, { type: "byProject.delete", projectId, path: ["keywordMappings", group, k] });
  }
  return { ok: true };
}

// ===== TB 状态映射（逻辑状态→该项目 taskflow 真实状态名，按 TB 项目隔离、团队共享）=====
// 不同 TB 项目的状态命名各异（如"修复中"可能叫"处理中/开发中"），配了优先用，未配则回退同义词。
export const STATUS_LOGICALS = ["待处理", "待确认", "修复中", "可提测", "已拒绝"];
export function getStatusMapping(projectId) {
  const cfg = loadRawConfig();
  const m = projectBucket(cfg, projectId).statusMap;
  return (m && typeof m === "object") ? m : {};
}
export function setStatusMapping(projectId, logical, realName) {
  if (!STATUS_LOGICALS.includes(logical)) return { ok: false, error: "未知逻辑状态" };
  const cfg = loadRawConfig();
  const bucket = projectBucket(cfg, projectId);
  bucket.statusMap = bucket.statusMap || {};
  const v = String(realName || "").trim();
  if (v) bucket.statusMap[logical] = v; else delete bucket.statusMap[logical];
  writeSharedOps(cfg, v
    ? { type: "byProject.set", projectId, path: ["statusMap", logical], value: v }
    : { type: "byProject.delete", projectId, path: ["statusMap", logical] });
  return { ok: true };
}

// ===== 经验库（TB 单完成后沉淀的"问题原因 + 预防规则"，按 TB 项目隔离，自动注入后续甄别/开发）=====
// 这是"写入配置避免同类问题再次发生"的权威存储；CLAUDE.md / wiki / Bug Agent 为导出目标。
export function getLessons(projectId) {
  const cfg = loadRawConfig();
  const arr = projectBucket(cfg, projectId).lessons;
  return Array.isArray(arr) ? arr : [];
}
// 新增/更新一条经验（同 carbId 已存在则更新，否则追加；上限 200 条）。返回写入的行。
export function addLesson(projectId, lesson) {
  const cfg = loadRawConfig();
  const bucket = projectBucket(cfg, projectId);
  const list = Array.isArray(bucket.lessons) ? bucket.lessons : [];
  const idx = lesson.carbId ? list.findIndex((x) => x.carbId === lesson.carbId) : -1;
  const row = { id: idx >= 0 ? list[idx].id : `L${Date.now()}_${Math.random().toString(36).slice(2, 6)}`, at: Date.now(), ...lesson };
  if (idx >= 0) list[idx] = { ...list[idx], ...row };
  else list.push(row);
  bucket.lessons = list.slice(-200);
  writeSharedOps(cfg, { type: "lesson.set", projectId, value: row });
  return row;
}
export function deleteLesson(projectId, id) {
  const cfg = loadRawConfig();
  const bucket = projectBucket(cfg, projectId);
  if (Array.isArray(bucket.lessons)) {
    bucket.lessons = bucket.lessons.filter((x) => x.id !== id);
    writeSharedOps(cfg, { type: "lesson.delete", projectId, idValue: id });
  }
  return { ok: true };
}
// ===== 配置记忆（按 TB 项目隔离、团队共享）：成功解决过的"TB信号→工程配置"，新建故事点时据此推荐 =====
export function getConfigMemories(projectId) {
  const cfg = loadRawConfig();
  const arr = projectBucket(cfg, projectId).configMemory;
  return Array.isArray(arr) ? arr : [];
}
// 去重签名：主工程 + flavor + 车型 相同 → 视为同一类配置，合并累加权重
function memSig(m) {
  return [m?.config?.primaryProjectId || "", m?.config?.flavor || "", m?.signals?.vehicle || ""].join("|");
}
export function addConfigMemory(projectId, mem) {
  if (!mem?.config?.primaryProjectId) return null;
  const cfg = loadRawConfig();
  const bucket = projectBucket(cfg, projectId);
  const list = Array.isArray(bucket.configMemory) ? bucket.configMemory : [];
  const uniq = (a, b) => [...new Set([...(a || []), ...(b || [])])].slice(0, 30);
  const idx = list.findIndex((x) => memSig(x) === memSig(mem));
  let row;
  if (idx >= 0) {
    const ex = list[idx];
    ex.count = (ex.count || 1) + 1;
    ex.updatedAt = Date.now();
    ex.config = { ...ex.config, ...mem.config };
    ex.signals = {
      ...ex.signals, ...mem.signals,
      tags: uniq(ex.signals?.tags, mem.signals?.tags),
      titleKeywords: uniq(ex.signals?.titleKeywords, mem.signals?.titleKeywords),
    };
    ex.sampleTitle = mem.sampleTitle || ex.sampleTitle;
    row = list[idx] = ex;
  } else {
    row = { id: `CM${Date.now()}_${Math.random().toString(36).slice(2, 6)}`, count: 1, createdAt: Date.now(), updatedAt: Date.now(), ...mem };
    list.push(row);
  }
  bucket.configMemory = list.slice(-200);
  writeSharedOps(cfg, { type: "configMemory.set", projectId, value: row });
  return row;
}
export function deleteConfigMemory(projectId, id) {
  const cfg = loadRawConfig();
  const bucket = projectBucket(cfg, projectId);
  if (Array.isArray(bucket.configMemory)) {
    bucket.configMemory = bucket.configMemory.filter((x) => x.id !== id);
    writeSharedOps(cfg, { type: "configMemory.delete", projectId, idValue: id });
  }
  return { ok: true };
}

// ===== AI训练 / 故事点训练（按 TB 项目隔离、团队共享）=====
const STORY_TRAINING_SECTIONS = new Set(["buildLineage", "goldCases", "dryRuns"]);
const STORY_TRAINING_LIMITS = { buildLineage: 500, goldCases: 300, dryRuns: 200 };

function storyTrainingId(prefix) {
  return `${prefix}${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
}

function storyTrainingRoot(cfg, projectId) {
  const bucket = projectBucket(cfg, projectId);
  bucket.aiTraining = isPlainObject(bucket.aiTraining) ? bucket.aiTraining : {};
  bucket.aiTraining.storyPoint = isPlainObject(bucket.aiTraining.storyPoint) ? bucket.aiTraining.storyPoint : {};
  const root = bucket.aiTraining.storyPoint;
  for (const section of STORY_TRAINING_SECTIONS) root[section] = isPlainObject(root[section]) ? root[section] : {};
  root.settings = isPlainObject(root.settings) ? root.settings : { automationLevel: "L0_SHADOW" };
  return root;
}

function storyTrainingRows(map) {
  return Object.values(isPlainObject(map) ? map : {})
    .filter((row) => row && typeof row === "object")
    .sort((a, b) => Number(b.updatedAt || b.createdAt || 0) - Number(a.updatedAt || a.createdAt || 0));
}

function storyTrainingRegistrySnapshot(projectId) {
  const pid = projectId || defaultPid();
  const cfg = JSON.parse(JSON.stringify(loadRawConfig()));
  ensureMigrated(cfg);
  ensureDefaultVehicleMap(cfg, pid);
  const projectDefs = getProjectDefs();
  const rawVehicleMap = projectBucket(cfg, pid).vehicleMap || {};
  const vehicleMap = {};
  for (const [vehicle, mapping] of Object.entries(rawVehicleMap)) vehicleMap[vehicle] = normalizeVehicleMapping(vehicle, mapping);
  const rawKeywords = projectBucket(cfg, pid).keywordMappings || {};
  const keywordMappings = {};
  for (const group of KW_GROUPS) keywordMappings[group] = isPlainObject(rawKeywords[group]) ? rawKeywords[group] : {};
  return {
    version: getSharedVersion(),
    projectDefs,
    vehicleMap,
    keywordMappings,
    targets: storyTrainingRegistryTargets(projectDefs, vehicleMap),
    variantOptions: {
      environments: [...STORY_TRAINING_ENVIRONMENTS],
      buildTypes: [...STORY_TRAINING_BUILD_TYPES],
    },
  };
}

function validateStoredStoryTargets(projectId, root, targets) {
  const registry = storyTrainingRegistrySnapshot(projectId);
  return validateStoryTrainingTargets(targets, {
    projectDefs: registry.projectDefs,
    vehicleMap: registry.vehicleMap,
    buildLineage: storyTrainingRows(root.buildLineage),
  });
}

function trimStoryTrainingSection(root, section, projectId) {
  const limit = STORY_TRAINING_LIMITS[section];
  const rows = storyTrainingRows(root[section]);
  const ops = [];
  for (const row of rows.slice(limit)) {
    if (!row?.id) continue;
    delete root[section][row.id];
    ops.push({ type: "byProject.delete", projectId, path: ["aiTraining", "storyPoint", section, row.id] });
  }
  return ops;
}

function storyTrainingMetrics(root, registry) {
  const dryRuns = storyTrainingRows(root.dryRuns);
  const reviewed = dryRuns.filter((row) => row.review);
  const correct = reviewed.filter((row) => row.review?.decision === "correct").length;
  const insufficient = dryRuns.filter((row) => row.prediction?.status === "NEED_MORE_INFO" || row.review?.decision === "insufficient").length;
  return {
    engineeringRepositories: registry.projectDefs.length,
    registeredVehicles: Object.keys(registry.vehicleMap).length,
    buildLineage: Object.keys(root.buildLineage).length,
    goldCases: Object.keys(root.goldCases).length,
    dryRuns: dryRuns.length,
    pendingReviews: dryRuns.filter((row) => !row.review).length,
    readyExecutionPackets: dryRuns.filter((row) => row.executionPacket?.status === "PLAN_READY").length,
    reviewed: reviewed.length,
    allCorrectRate: reviewed.length ? Number((correct / reviewed.length).toFixed(3)) : null,
    rejectionRate: dryRuns.length ? Number((insufficient / dryRuns.length).toFixed(3)) : null,
  };
}

export function getStoryPointTrainingData(projectId) {
  const pid = projectId || defaultPid();
  const registry = storyTrainingRegistrySnapshot(pid);
  const cfg = loadRawConfig();
  const root = storyTrainingRoot(cfg, pid);
  return {
    projectId: pid,
    versions: STORY_TRAINING_VERSIONS,
    settings: root.settings,
    registry,
    buildLineage: storyTrainingRows(root.buildLineage),
    goldCases: storyTrainingRows(root.goldCases),
    dryRuns: storyTrainingRows(root.dryRuns),
    metrics: storyTrainingMetrics(root, registry),
  };
}

export function upsertStoryPointTrainingBuildLineage(projectId, input = {}) {
  const pid = projectId || defaultPid();
  const cfg = loadRawConfig();
  const root = storyTrainingRoot(cfg, pid);
  const id = String(input.id || storyTrainingId("BL")).trim();
  const existing = root.buildLineage[id] || {};
  const row = normalizeBuildLineage({ ...input, id }, existing);
  const registry = storyTrainingRegistrySnapshot(pid);
  if (!row.repositoryId || !registry.projectDefs.some((def) => def.id === row.repositoryId)) {
    return { ok: false, error: "构建血缘必须选择工程注册表中的仓库" };
  }
  const registeredVehicles = new Set([
    ...Object.keys(registry.vehicleMap),
    ...registry.targets.map((target) => target.vehicle),
  ].map((value) => String(value).trim().toLowerCase()));
  if (row.vehicle && !registeredVehicles.has(row.vehicle.toLowerCase())) {
    return { ok: false, error: "构建血缘车型必须来自工程注册表" };
  }
  if (row.environment && !STORY_TRAINING_ENVIRONMENTS.includes(row.environment.toLowerCase())) {
    return { ok: false, error: `环境仅允许 ${STORY_TRAINING_ENVIRONMENTS.join("/")}` };
  }
  if (row.buildType && !STORY_TRAINING_BUILD_TYPES.includes(row.buildType.toLowerCase())) {
    return { ok: false, error: `buildType 仅允许 ${STORY_TRAINING_BUILD_TYPES.join("/")}` };
  }
  if (!row.commitSha && !row.buildNumber && !row.artifactId && !row.versionName && !row.versionCode && !row.applicationId) {
    return { ok: false, error: "至少填写提交 SHA、构建号、产物 ID、版本或 applicationId 中的一项" };
  }
  root.buildLineage[id] = row;
  const ops = [
    { type: "byProject.set", projectId: pid, path: ["aiTraining", "storyPoint", "buildLineage", id], value: row },
    ...trimStoryTrainingSection(root, "buildLineage", pid),
  ];
  writeSharedOps(cfg, ops);
  return { ok: true, data: row };
}

export function upsertStoryPointTrainingGoldCase(projectId, input = {}) {
  const pid = projectId || defaultPid();
  const cfg = loadRawConfig();
  const root = storyTrainingRoot(cfg, pid);
  const id = String(input.id || storyTrainingId("GC")).trim();
  const existing = root.goldCases[id] || {};
  const row = normalizeGoldCase({ ...input, id }, existing);
  if (!row.ticket.title && !row.ticket.ticketId) return { ok: false, error: "Gold 样本至少需要 TB 单号或标题" };
  const validation = validateStoredStoryTargets(pid, root, row.actual.changeTargets);
  if (!validation.ok) return { ok: false, error: `Gold 样本无效：${validation.error}` };
  root.goldCases[id] = row;
  const ops = [
    { type: "byProject.set", projectId: pid, path: ["aiTraining", "storyPoint", "goldCases", id], value: row },
    ...trimStoryTrainingSection(root, "goldCases", pid),
  ];
  writeSharedOps(cfg, ops);
  return { ok: true, data: row };
}

export function runStoryPointTrainingDryRun(projectId, input = {}) {
  const pid = projectId || defaultPid();
  const data = getStoryPointTrainingData(pid);
  const ticket = normalizeStoryTicket(input.ticket || input);
  const prediction = routeStoryPointTicket({
    ticket,
    projectDefs: data.registry.projectDefs,
    vehicleMap: data.registry.vehicleMap,
    keywordMappings: data.registry.keywordMappings,
    buildLineage: data.buildLineage,
    goldCases: data.goldCases,
  });
  const cfg = loadRawConfig();
  const root = storyTrainingRoot(cfg, pid);
  const id = storyTrainingId("DR");
  const row = {
    id,
    ticket,
    prediction,
    review: null,
    versions: { ...data.versions, registry: String(data.registry.version || data.versions.registry) },
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  root.dryRuns[id] = row;
  const ops = [
    { type: "byProject.set", projectId: pid, path: ["aiTraining", "storyPoint", "dryRuns", id], value: row },
    ...trimStoryTrainingSection(root, "dryRuns", pid),
  ];
  writeSharedOps(cfg, ops);
  return { ok: true, data: row };
}

export function reviewStoryPointTrainingDryRun(projectId, id, input = {}) {
  const pid = projectId || defaultPid();
  const cfg = loadRawConfig();
  const root = storyTrainingRoot(cfg, pid);
  const row = root.dryRuns[String(id || "")];
  if (!row) return { ok: false, error: "Dry-run 记录不存在" };
  const decisions = new Set(["correct", "corrected", "insufficient", "ticket_wrong"]);
  const decision = String(input.decision || "").trim();
  if (!decisions.has(decision)) return { ok: false, error: "请选择有效的复核结论" };
  const finalPrediction = decision === "corrected" ? (input.correctedPrediction || {}) : row.prediction;
  const targets = Array.isArray(finalPrediction?.changeTargets) ? finalPrediction.changeTargets : [];
  if (["correct", "corrected"].includes(decision)) {
    const validation = validateStoredStoryTargets(pid, root, targets);
    if (!validation.ok) return { ok: false, error: `复核结果无效：${validation.error}` };
  }
  row.review = {
    decision,
    correctedPrediction: decision === "corrected" ? finalPrediction : null,
    reviewer: String(input.reviewer || "").trim(),
    reason: String(input.reason || "").trim().slice(0, 4000),
    reviewedAt: Date.now(),
  };
  row.updatedAt = Date.now();
  writeSharedOps(cfg, { type: "byProject.set", projectId: pid, path: ["aiTraining", "storyPoint", "dryRuns", row.id], value: row });

  let goldCase = null;
  if (input.saveAsGold && ["correct", "corrected"].includes(decision) && targets.length) {
    const result = upsertStoryPointTrainingGoldCase(pid, {
      ticket: row.ticket,
      actual: { symptomProject: finalPrediction.symptomProject || null, changeTargets: targets },
      reviewer: row.review.reviewer,
      reason: row.review.reason,
      sourceDryRunId: row.id,
      snapshotAt: row.ticket.snapshotAt,
      availableAt: row.review.reviewedAt,
      versions: row.versions,
    });
    if (!result.ok) return { ok: false, error: `复核已保存，但 Gold 样本未生成：${result.error}`, data: row };
    goldCase = result.data;
  }
  return { ok: true, data: row, goldCase };
}

export function createStoryPointTrainingExecutionPlan(projectId, id, input = {}) {
  const pid = projectId || defaultPid();
  const cfg = loadRawConfig();
  const root = storyTrainingRoot(cfg, pid);
  const row = root.dryRuns[String(id || "")];
  if (!row) return { ok: false, error: "Dry-run 记录不存在" };
  if (!row.review || !["correct", "corrected"].includes(row.review.decision)) {
    return { ok: false, error: "只有人工确认正确或已修正的路由才能生成隔离执行包" };
  }
  const finalPrediction = row.review.decision === "corrected" && row.review.correctedPrediction
    ? row.review.correctedPrediction
    : row.prediction;
  const targets = Array.isArray(finalPrediction?.changeTargets) ? finalPrediction.changeTargets : [];
  const validation = validateStoredStoryTargets(pid, root, targets);
  if (!validation.ok) return { ok: false, error: `隔离执行包目标无效：${validation.error}` };
  const defs = new Map(storyTrainingRegistrySnapshot(pid).projectDefs.map((def) => [def.id, def]));
  const requestedMode = String(input.mode || "PLAN_ONLY").toUpperCase();
  const mode = requestedMode === "PLAN_AND_PATCH" ? "PLAN_AND_PATCH" : "PLAN_ONLY";
  const now = Date.now();
  const executionPacket = {
    id: storyTrainingId("EP"),
    status: "PLAN_READY",
    mode,
    ticketSnapshotId: row.id,
    ticket: {
      ticketId: row.ticket?.ticketId || row.ticket?.tbTaskId || "",
      title: row.ticket?.title || "",
      snapshotAt: row.ticket?.snapshotAt || "",
    },
    allowedTargets: targets.map((target) => ({
      repositoryId: target.repositoryId,
      repositoryName: defs.get(target.repositoryId)?.name || target.repositoryName || target.repositoryId,
      baseBranch: target.baseBranch,
      reproductionBranch: target.reproductionBranch || "",
      variant: {
        vehicle: target.variant.vehicle,
        environment: target.variant.environment,
        buildType: target.variant.buildType,
      },
    })),
    guardrails: {
      isolatedCheckoutRequired: true,
      restrictWritesToAllowedTargets: true,
      planBeforePatch: true,
      runTestsBeforeHandoff: true,
      autoCommit: false,
      autoPush: false,
      autoMerge: false,
      agentStarted: false,
      explicitStartApprovalRequired: true,
    },
    stages: [
      { id: "prepare", name: "创建隔离 checkout 并校验目标分支", status: "pending" },
      { id: "plan", name: "基于工单快照和证据生成开发计划", status: "pending" },
      ...(mode === "PLAN_AND_PATCH" ? [{ id: "patch", name: "在允许目标内生成 patch", status: "pending" }] : []),
      { id: "verify", name: "执行目标项目测试并收集证据", status: "pending" },
      { id: "handoff", name: "等待人工确认，不提交、不推送、不合并", status: "pending" },
    ],
    versions: row.versions || STORY_TRAINING_VERSIONS,
    requestedBy: String(input.requestedBy || row.review.reviewer || "").trim(),
    createdAt: now,
  };
  row.executionPacket = executionPacket;
  row.updatedAt = now;
  writeSharedOps(cfg, { type: "byProject.set", projectId: pid, path: ["aiTraining", "storyPoint", "dryRuns", row.id], value: row });
  return { ok: true, data: row, executionPacket };
}

export function deleteStoryPointTrainingItem(projectId, section, id) {
  const pid = projectId || defaultPid();
  if (!STORY_TRAINING_SECTIONS.has(section)) return { ok: false, error: "未知训练数据类型" };
  const cfg = loadRawConfig();
  const root = storyTrainingRoot(cfg, pid);
  const key = String(id || "").trim();
  if (!root[section][key]) return { ok: false, error: "训练数据不存在" };
  delete root[section][key];
  writeSharedOps(cfg, { type: "byProject.delete", projectId: pid, path: ["aiTraining", "storyPoint", section, key] });
  return { ok: true };
}

// ===== AI 训练 / 工程配置推理（六类关键词信号 + 人工反馈 + 真实执行配置）=====
// 旧 storyPoint 数据保留兼容；新任务入口和训练页统一使用本节的数据闭环。
const CONFIG_INFERENCE_LIMITS = {
  runs: 300,
  samples: 500,
  keywordSuggestions: 1000,
  datasets: 20,
  evaluations: 50,
  artifacts: 30,
  releases: 50,
};
const CONFIG_INFERENCE_TRAINING_CLAIM_TTL_MS = 30 * 60 * 1000;
const CONFIG_INFERENCE_FEATURE_SCHEMA_VERSION = "rank-features/v1";
const CONFIG_INFERENCE_SHADOW_MIN_CASES = 200;
const CONFIG_INFERENCE_SHADOW_MIN_DURATION_MS = 14 * 24 * 60 * 60 * 1000;
const CONFIG_INFERENCE_CANARY_MIN_CASES = 50;
const CONFIG_INFERENCE_CANARY_MIN_DURATION_MS = 24 * 60 * 60 * 1000;

function configInferenceRoot(cfg, projectId) {
  const bucket = projectBucket(cfg, projectId);
  bucket.aiTraining = isPlainObject(bucket.aiTraining) ? bucket.aiTraining : {};
  bucket.aiTraining.configInference = isPlainObject(bucket.aiTraining.configInference) ? bucket.aiTraining.configInference : {};
  const root = bucket.aiTraining.configInference;
  root.runs = isPlainObject(root.runs) ? root.runs : {};
  root.samples = isPlainObject(root.samples) ? root.samples : {};
  root.trainedTickets = isPlainObject(root.trainedTickets) ? root.trainedTickets : {};
  root.trainingClaims = isPlainObject(root.trainingClaims) ? root.trainingClaims : {};
  root.valueBindings = isPlainObject(root.valueBindings) ? root.valueBindings : {};
  root.keywordSuggestions = isPlainObject(root.keywordSuggestions) ? root.keywordSuggestions : {};
  root.datasets = isPlainObject(root.datasets) ? root.datasets : {};
  root.evaluations = isPlainObject(root.evaluations) ? root.evaluations : {};
  root.artifacts = isPlainObject(root.artifacts) ? root.artifacts : {};
  root.releases = isPlainObject(root.releases) ? root.releases : {};
  root.settings = isPlainObject(root.settings) ? root.settings : {};
  root.tombstones = normalizeConfigInferenceTombstones(root.tombstones);
  return root;
}

function configInferenceSharedRoot(shared, projectId) {
  const root = shared?.byProject?.[projectId]?.aiTraining?.configInference;
  return isPlainObject(root) ? root : {};
}

function configInferenceBindingTargets(root, registry) {
  const rows = [];
  const append = (scope, id, targets) => {
    const normalized = normalizeConfigInferenceTargets(targets || []);
    if (normalized.length) rows.push({ scope, id: String(id || ""), targets: normalized });
  };
  const samples = configInferenceLearningSamples(root);
  const sampledRunIds = new Set(samples.map((sample) => String(sample.sourceRunId || "")).filter(Boolean));
  for (const sample of samples) {
    append("sample", sample.id, sample.groundTruth?.targets
      || sample.actual?.targets
      || sample.feedback?.correctedPrediction?.targets);
    append("sample_negative", sample.id, sample.negative?.rejectedTargets
      || sample.feedback?.rejectedPrediction?.targets);
  }
  for (const run of configInferenceRows(root.runs)) {
    if (!run.review || sampledRunIds.has(String(run.id || ""))) continue;
    append("run", run.id, (run.review?.correctedPrediction || run.prediction)?.targets);
  }
  return rows;
}

function configInferenceKnowledgeKeyId(logicalKey, dimension = "") {
  return `K_CFG_${configInferenceDigest(`${String(dimension || "").trim()}|${String(logicalKey || "").trim()}`)}`;
}

function configInferenceKnowledgeKeyDefinition(logicalKey, dimension, stored = {}) {
  const immutableKeyId = String(stored.keyId || configInferenceKnowledgeKeyId(logicalKey, dimension)).trim();
  return createKnowledgeKey({
    keyId: immutableKeyId,
    canonicalKey: String(stored.canonicalKey || logicalKey).trim(),
    aliases: [...(Array.isArray(stored.aliases) ? stored.aliases : []), logicalKey],
    dimension,
    valueType: String(stored.valueType || dimension || "text"),
    scopePolicy: Array.isArray(stored.scopePolicy) && stored.scopePolicy.length
      ? stored.scopePolicy
      : ["project", "environment", "task", "node", "user"],
    ownerTeam: stored.ownerTeam || "",
    sensitivity: stored.sensitivity || "internal",
    status: stored.status || "active",
    createdAt: stored.knowledgeCreatedAt
      || (Number.isFinite(Number(stored.createdAt)) && Number(stored.createdAt) > 0
        ? new Date(Number(stored.createdAt)).toISOString()
        : String(stored.createdAt || "")),
    createdBy: stored.createdBy || stored.updatedBy || "",
  }, {
    idFactory: () => immutableKeyId,
  });
}

function configInferenceKnowledgeRevisions(stored = {}, keyId = "") {
  const shared = (Array.isArray(stored.valueRevisions) ? stored.valueRevisions : [])
    .filter((row) => !keyId || String(row?.keyId || "") === keyId)
    .map(cloneJson);
  const local = loadLocalKnowledgeValueRevisions()
    .filter((row) => !keyId || String(row?.keyId || "") === keyId)
    .map(cloneJson);
  return [...shared, ...local].sort((left, right) => (
    Number(left.revision || 0) - Number(right.revision || 0)
    || String(left.id || "").localeCompare(String(right.id || ""))
  ));
}

function configInferenceKnowledgeResolution(projectId, key, revisions = []) {
  return resolveKnowledgeValue(key, revisions, {
    projectId,
    nodeId: nodeIdSafe() || `device:${machineStorageId()}`,
    userId: configUserKey(),
  });
}

function configInferenceEffectiveValueBindings(projectId, root, overrides = null) {
  const source = isPlainObject(overrides) ? overrides : (isPlainObject(root?.valueBindings) ? root.valueBindings : {});
  const effective = {};
  for (const [logicalKey, rowValue] of Object.entries(source)) {
    const row = isPlainObject(rowValue) ? rowValue : {};
    const dimension = String(row.dimension || "").trim();
    const key = configInferenceKnowledgeKeyDefinition(logicalKey, dimension, row);
    const revisions = configInferenceKnowledgeRevisions(row, key.keyId);
    const resolution = configInferenceKnowledgeResolution(projectId, key, revisions);
    effective[logicalKey] = resolution.resolved && resolution.revisionId
      ? {
        ...row,
        keyId: key.keyId,
        actualValue: resolution.actualValue,
        resolved: true,
        effectiveScope: resolution.scope,
        effectiveScopeId: resolution.scopeId,
        activeValueRevision: resolution.revision,
        activeValueRevisionId: resolution.revisionId,
      }
      : row;
  }
  return effective;
}

function configInferenceValueBindingCatalog(projectId, root, registry) {
  const byKey = new Map();
  const storedBindings = isPlainObject(root.valueBindings) ? root.valueBindings : {};
  const effectiveBindings = configInferenceEffectiveValueBindings(projectId, root);
  const add = (field, binding, source, target) => {
    const logicalKey = String(binding?.logicalKey || "").trim();
    if (!logicalKey) return;
    const stored = isPlainObject(storedBindings[logicalKey]) ? storedBindings[logicalKey] : {};
    const effectiveStored = isPlainObject(effectiveBindings[logicalKey]) ? effectiveBindings[logicalKey] : stored;
    const knowledgeKey = configInferenceKnowledgeKeyDefinition(logicalKey, field, stored);
    const valueRevisions = configInferenceKnowledgeRevisions(stored, knowledgeKey.keyId);
    const resolution = configInferenceKnowledgeResolution(projectId, knowledgeKey, valueRevisions);
    const existing = byKey.get(logicalKey) || {
      logicalKey,
      keyId: knowledgeKey.keyId,
      canonicalKey: knowledgeKey.canonicalKey,
      aliases: knowledgeKey.aliases,
      scopePolicy: knowledgeKey.scopePolicy,
      status: knowledgeKey.status,
      dimension: String(stored.dimension || field),
      actualValue: effectiveStored.actualValue ?? binding.actualValue ?? "",
      defaultValue: stored.defaultValue ?? binding.defaultValue ?? "",
      sourceValue: stored.sourceValue ?? binding.sourceValue ?? binding.defaultValue ?? "",
      scopeKey: String(stored.scopeKey || binding.scopeKey || ""),
      label: String(stored.label || binding.label || logicalKey),
      revision: Math.max(0, Math.trunc(Number(stored.revision ?? binding.revision) || 0)),
      resolved: stored.resolved !== false && !!String(stored.actualValue ?? binding.actualValue ?? "").trim(),
      replaceable: field !== "order" && CONFIG_INFERENCE_REPLACEABLE_FIELDS.includes(field),
      updatedAt: Number(stored.updatedAt || 0) || 0,
      updatedBy: String(stored.updatedBy || ""),
      history: Array.isArray(stored.history) ? cloneJson(stored.history).slice(-20) : [],
      valueRevisions,
      activeValueRevision: resolution.resolved ? resolution.revision : 0,
      activeValueRevisionId: resolution.resolved ? resolution.revisionId : "",
      effectiveScope: resolution.resolved ? resolution.scope : "",
      effectiveScopeId: resolution.resolved ? resolution.scopeId : "",
      usageCount: 0,
      sampleCount: 0,
      runCount: 0,
      registryCount: 0,
      targets: [],
      sources: [],
    };
    existing.usageCount++;
    if (source.scope.startsWith("sample")) existing.sampleCount++;
    else if (source.scope === "run") existing.runCount++;
    else if (source.scope === "registry") existing.registryCount++;
    const targetSummary = {
      targetId: String(target.targetId || ""),
      appName: String(target.appName || ""),
      vehicle: String(target.vehicle || ""),
      repositoryId: String(target.repositoryId || ""),
      repositoryName: String(target.repositoryName || ""),
      targetRole: String(target.targetRole || ""),
      order: Number(target.order || 0) || 0,
    };
    const targetKey = stableJsonText(targetSummary);
    if (!existing.targets.some((item) => stableJsonText(item) === targetKey)) existing.targets.push(targetSummary);
    const sourceKey = `${source.scope}:${source.id}`;
    if (!existing.sources.some((item) => `${item.scope}:${item.id}` === sourceKey)) {
      existing.sources.push({ scope: source.scope, id: source.id });
    }
    byKey.set(logicalKey, existing);
  };

  for (const source of configInferenceBindingTargets(root, registry)) {
    const boundTargets = bindConfigInferenceTargets(source.targets, {
      projectId,
      valueBindings: effectiveBindings,
    });
    for (const target of boundTargets) {
      for (const field of CONFIG_INFERENCE_BINDABLE_FIELDS) {
        if (target.fieldBindings?.[field]) add(field, target.fieldBindings[field], source, target);
      }
    }
  }

  // 已同步但当前没有任何保留样本引用的 binding 仍要可见，方便审计和恢复。
  for (const [logicalKey, stored] of Object.entries(storedBindings)) {
    if (byKey.has(logicalKey) || !isPlainObject(stored)) continue;
    const dimension = String(stored.dimension || "");
    if (!CONFIG_INFERENCE_REPLACEABLE_FIELDS.includes(dimension)) continue;
    const knowledgeKey = configInferenceKnowledgeKeyDefinition(logicalKey, dimension, stored);
    const valueRevisions = configInferenceKnowledgeRevisions(stored, knowledgeKey.keyId);
    const resolution = configInferenceKnowledgeResolution(projectId, knowledgeKey, valueRevisions);
    const effectiveStored = effectiveBindings[logicalKey] || stored;
    byKey.set(logicalKey, {
      logicalKey,
      keyId: knowledgeKey.keyId,
      canonicalKey: knowledgeKey.canonicalKey,
      aliases: knowledgeKey.aliases,
      scopePolicy: knowledgeKey.scopePolicy,
      status: knowledgeKey.status,
      dimension,
      actualValue: effectiveStored.actualValue ?? "",
      defaultValue: stored.defaultValue ?? "",
      sourceValue: stored.sourceValue ?? stored.defaultValue ?? "",
      scopeKey: String(stored.scopeKey || ""),
      label: String(stored.label || logicalKey),
      revision: Math.max(0, Math.trunc(Number(stored.revision) || 0)),
      resolved: stored.resolved !== false && !!String(stored.actualValue ?? "").trim(),
      replaceable: true,
      updatedAt: Number(stored.updatedAt || 0) || 0,
      updatedBy: String(stored.updatedBy || ""),
      history: Array.isArray(stored.history) ? cloneJson(stored.history).slice(-20) : [],
      valueRevisions,
      activeValueRevision: resolution.resolved ? resolution.revision : 0,
      activeValueRevisionId: resolution.resolved ? resolution.revisionId : "",
      effectiveScope: resolution.resolved ? resolution.scope : "",
      effectiveScopeId: resolution.resolved ? resolution.scopeId : "",
      usageCount: 0,
      sampleCount: 0,
      runCount: 0,
      registryCount: 0,
      targets: [],
      sources: [],
    });
  }

  return [...byKey.values()]
    .map((row) => ({
      ...row,
      targets: row.targets.slice(0, 50),
      sources: row.sources.slice(0, 100),
      field: row.dimension,
      referenceCount: row.usageCount,
      sampleCount: new Set(row.sources
        .filter((source) => String(source.scope || "").startsWith("sample"))
        .map((source) => source.id)).size,
      runCount: new Set(row.sources
        .filter((source) => source.scope === "run")
        .map((source) => source.id)).size,
      targetCount: row.targets.length,
      repositories: [...new Set(row.targets.map((target) => target.repositoryName || target.repositoryId).filter(Boolean))],
      targetRoles: [...new Set(row.targets.map((target) => target.targetRole).filter(Boolean))],
    }))
    .sort((left, right) => left.dimension.localeCompare(right.dimension)
      || left.label.localeCompare(right.label)
      || left.logicalKey.localeCompare(right.logicalKey));
}

function configInferenceSafeSharedScalar(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : "";
  const normalized = String(value ?? "").trim();
  return normalized && knowledgeValueSensitivity(normalized).safeForShared ? normalized : "";
}

// 共享层只保存稳定 logicalKey 和可移植的 canonical 值。node/user binding
// 只允许在当前 Gateway 的响应视图中物化；绝不能反向写入 run、sample 或 Golden Set。
function configInferencePersistedTargets(projectId, root, targets) {
  const effectiveBindings = configInferenceEffectiveValueBindings(projectId, root);
  const sharedBindings = isPlainObject(root?.valueBindings) ? root.valueBindings : {};
  return normalizeConfigInferenceTargets(targets).map((source) => {
    const next = { ...source };
    const fieldStates = isPlainObject(source.fieldStates) ? cloneJson(source.fieldStates) : {};
    const fieldBindings = {};
    for (const [field, rawBinding] of Object.entries(
      isPlainObject(source.fieldBindings) ? source.fieldBindings : {},
    )) {
      if (!CONFIG_INFERENCE_BINDABLE_FIELDS.includes(field)) continue;
      const binding = isPlainObject(rawBinding) ? rawBinding : {};
      const logicalKey = String(binding.logicalKey || "").trim();
      if (!safeSharedSegment(logicalKey)) continue;
      if (field === "order") {
        fieldBindings.order = {
          logicalKey,
          actualValue: Number(source.order || binding.actualValue || 0) || 0,
          resolved: Number(source.order || binding.actualValue || 0) > 0,
          replaceable: false,
        };
        continue;
      }

      const effective = isPlainObject(effectiveBindings[logicalKey])
        ? effectiveBindings[logicalKey]
        : {};
      const shared = isPlainObject(sharedBindings[logicalKey])
        ? sharedBindings[logicalKey]
        : {};
      const effectiveScope = String(
        effective.effectiveScope || effective.scope || "",
      ).trim().toLowerCase();
      const localEffective = ["node", "user"].includes(effectiveScope);
      const currentValue = String(source[field] || "").trim();
      const currentSafe = configInferenceSafeSharedScalar(currentValue);
      let canonicalValue = currentSafe;
      if (localEffective || !currentSafe) {
        const sharedCandidates = [
          shared.actualValue,
          shared.defaultValue,
          shared.sourceValue,
          binding.defaultValue,
          binding.sourceValue,
        ];
        canonicalValue = sharedCandidates
          .map(configInferenceSafeSharedScalar)
          .find(Boolean) || "";
      }

      const scopeKey = configInferenceSafeSharedScalar(binding.scopeKey);
      const label = configInferenceSafeSharedScalar(binding.label);
      fieldBindings[field] = {
        logicalKey,
        ...(scopeKey ? { scopeKey } : {}),
        ...(label ? { label } : {}),
      };
      if (canonicalValue) {
        next[field] = canonicalValue;
        delete fieldStates[field];
      } else {
        next[field] = "";
        fieldStates[field] = {
          kind: "symbolic",
          feature: label || logicalKey,
        };
      }
    }

    // 即使旧数据没有 fieldBindings，也不能让绝对路径或 secret 继续进入共享层。
    for (const field of [...CONFIG_INFERENCE_DIMENSIONS, "repositoryName", "gitUrl"]) {
      if (!next[field]) continue;
      if (configInferenceSafeSharedScalar(next[field])) continue;
      next[field] = "";
      if (CONFIG_INFERENCE_DIMENSIONS.includes(field) && fieldBindings[field]?.logicalKey) {
        fieldStates[field] = {
          kind: "symbolic",
          feature: fieldBindings[field].label || fieldBindings[field].logicalKey,
        };
      }
    }
    if (Object.keys(fieldBindings).length) next.fieldBindings = fieldBindings;
    else delete next.fieldBindings;
    if (Object.keys(fieldStates).length) {
      next.fieldStates = fieldStates;
      next.resolutionStatus = "partial";
    } else {
      delete next.fieldStates;
      if (next.resolutionStatus === "partial") next.resolutionStatus = "resolved";
    }
    return next;
  });
}

function configInferenceBoundTargets(projectId, root, targets) {
  return bindConfigInferenceTargets(normalizeConfigInferenceTargets(targets), {
    projectId,
    valueBindings: configInferenceEffectiveValueBindings(projectId, root),
  });
}

function configInferenceLocalValueReplacements(projectId, root) {
  const replacements = new Map();
  const effectiveBindings = configInferenceEffectiveValueBindings(projectId, root);
  const sharedBindings = isPlainObject(root?.valueBindings) ? root.valueBindings : {};
  for (const [logicalKey, effective] of Object.entries(effectiveBindings)) {
    const scope = String(effective?.effectiveScope || effective?.scope || "").trim().toLowerCase();
    if (!["node", "user"].includes(scope)) continue;
    const actualValue = String(effective?.actualValue || "").trim();
    if (!actualValue) continue;
    const shared = isPlainObject(sharedBindings[logicalKey]) ? sharedBindings[logicalKey] : {};
    const replacement = [
      shared.actualValue,
      shared.defaultValue,
      shared.sourceValue,
      effective.defaultValue,
      effective.sourceValue,
    ].map(configInferenceSafeSharedScalar).find(Boolean) || String(logicalKey);
    replacements.set(actualValue, replacement);
  }
  return replacements;
}

function configInferenceSharedPredictionValue(value, replacements) {
  if (typeof value === "string") {
    let normalized = value;
    for (const [localValue, replacement] of replacements) {
      if (normalized === localValue) return replacement;
      if (localValue.length >= 4 && normalized.includes(localValue)) {
        normalized = normalized.split(localValue).join(replacement);
      }
    }
    return knowledgeValueSensitivity(normalized).safeForShared ? normalized : "";
  }
  if (Array.isArray(value)) {
    return value.map((item) => configInferenceSharedPredictionValue(item, replacements));
  }
  if (!isPlainObject(value)) return value;
  return Object.fromEntries(Object.entries(value)
    .map(([key, child]) => [key, configInferenceSharedPredictionValue(child, replacements)]));
}

function configInferencePersistedPrediction(projectId, root, prediction) {
  if (!isPlainObject(prediction)) return prediction;
  const sanitized = configInferenceSharedPredictionValue(
    prediction,
    configInferenceLocalValueReplacements(projectId, root),
  );
  return {
    ...sanitized,
    ...(Array.isArray(prediction.targets)
      ? { targets: configInferencePersistedTargets(projectId, root, prediction.targets) }
      : {}),
    ...(Array.isArray(prediction.changeTargets)
      ? { changeTargets: configInferencePersistedTargets(projectId, root, prediction.changeTargets) }
      : {}),
  };
}

function configInferenceBoundPrediction(projectId, root, prediction) {
  if (!isPlainObject(prediction)) return prediction;
  return {
    ...prediction,
    ...(Array.isArray(prediction.targets)
      ? { targets: configInferenceBoundTargets(projectId, root, prediction.targets) }
      : {}),
    ...(Array.isArray(prediction.changeTargets)
      ? { changeTargets: configInferenceBoundTargets(projectId, root, prediction.changeTargets) }
      : {}),
  };
}

function configInferenceBoundSample(projectId, root, sample) {
  if (!isPlainObject(sample)) return sample;
  return {
    ...sample,
    groundTruth: configInferenceBoundPrediction(projectId, root, sample.groundTruth),
    actual: configInferenceBoundPrediction(projectId, root, sample.actual),
    feedback: isPlainObject(sample.feedback) ? {
      ...sample.feedback,
      correctedPrediction: configInferenceBoundPrediction(projectId, root, sample.feedback.correctedPrediction),
      rejectedPrediction: configInferenceBoundPrediction(projectId, root, sample.feedback.rejectedPrediction),
    } : sample.feedback,
    negative: isPlainObject(sample.negative) ? {
      ...sample.negative,
      ...(Array.isArray(sample.negative.rejectedTargets) ? {
        rejectedTargets: configInferenceBoundTargets(projectId, root, sample.negative.rejectedTargets),
      } : {}),
    } : sample.negative,
  };
}

function configInferenceBoundRun(projectId, root, run) {
  if (!isPlainObject(run)) return run;
  const storedCurrentConfig = isPlainObject(run.currentConfig)
    ? {
      ...run.currentConfig,
      targets: configInferenceBoundTargets(projectId, root, run.currentConfig.targets || []),
    }
    : run.currentConfig;
  return {
    ...run,
    prediction: configInferenceBoundPrediction(projectId, root, run.prediction),
    releaseTrial: isPlainObject(run.releaseTrial) ? {
      ...run.releaseTrial,
      candidatePrediction: configInferenceBoundPrediction(
        projectId,
        root,
        run.releaseTrial.candidatePrediction,
      ),
    } : run.releaseTrial,
    // 共享 run 只保存 canonical currentConfig。tabId 与本机 checkout 不能跨 Gateway
    // 持久化，否则同名 tab 会在另一台电脑上被错误物化。
    currentConfig: storedCurrentConfig,
    review: isPlainObject(run.review) ? {
      ...run.review,
      correctedPrediction: configInferenceBoundPrediction(projectId, root, run.review.correctedPrediction),
    } : run.review,
  };
}

function explicitConfigInferenceProjectId(...values) {
  for (const value of values) {
    const projectId = String(value || "").trim();
    if (projectId) return safeDataKey(projectId) ? projectId : "";
  }
  return "";
}

function explicitConfigInferenceRunId(value) {
  const runId = String(value || "").trim();
  return runId && safeSharedSegment(runId) ? runId : "";
}

function configInferencePersistedCurrentConfig(projectId, root, currentConfig) {
  if (!isPlainObject(currentConfig)) return null;
  return {
    mode: String(currentConfig.mode || "").trim(),
    primaryProjectId: String(currentConfig.primaryProjectId || "").trim(),
    targets: configInferencePersistedTargets(projectId, root, currentConfig.targets || []),
  };
}

function configInferenceDigest(value) {
  return createHash("sha256").update(stableJsonText(value)).digest("hex").slice(0, 20);
}

function configInferenceCaseFingerprint(projectId, ticket = {}) {
  const ticketId = String(ticket.ticketId || ticket.tbTaskId || ticket.id || "").trim();
  const snapshotId = String(
    ticket.sourceSnapshot?.snapshotId
    || ticket.sourceSnapshotId
    || ticket.snapshotId
    || "",
  ).trim();
  const identity = ticketId
    ? { kind: "tb_task", value: ticketId }
    : snapshotId
      ? { kind: "source_snapshot", value: snapshotId }
      : null;
  return identity
    ? `case_${configInferenceDigest({ projectId: String(projectId || ""), ...identity })}`
    : "";
}

function configInferenceProjectGuard(requestProjectId, ticketProjectId) {
  const requested = explicitConfigInferenceProjectId(requestProjectId);
  const ticket = explicitConfigInferenceProjectId(ticketProjectId);
  if (requestProjectId && !requested) {
    return { ok: false, statusCode: 400, code: "CONFIG_INFERENCE_PROJECT_INVALID", error: "TB 项目 ID 不合法" };
  }
  if (ticketProjectId && !ticket) {
    return { ok: false, statusCode: 400, code: "CONFIG_INFERENCE_TICKET_PROJECT_INVALID", error: "TB 工单项目 ID 无效" };
  }
  if (requested && ticket && requested !== ticket) {
    return {
      ok: false,
      statusCode: 409,
      code: "CONFIG_INFERENCE_TB_PROJECT_MISMATCH",
      error: `请求项目 ${requested} 与 TB 工单真实项目 ${ticket} 不一致`,
      requestProjectId: requested,
      ticketProjectId: ticket,
    };
  }
  const projectId = requested || ticket;
  return projectId
    ? { ok: true, projectId }
    : { ok: false, statusCode: 400, code: "CONFIG_INFERENCE_PROJECT_REQUIRED", error: "配置推理必须指定 TB 项目" };
}

function normalizeConfigInferenceSourceCoverage(value) {
  const source = isPlainObject(value) ? value : {};
  const out = {};
  for (const key of ["manual", "detail", "note", "comments", "attachments", "tags"]) {
    const row = source[key];
    if (!isPlainObject(row)) continue;
    out[key] = {
      available: row.available === true,
      ...(row.complete === true || row.complete === false ? { complete: row.complete === true } : {}),
      ...(Number.isFinite(Number(row.count)) ? { count: Math.max(0, Math.trunc(Number(row.count))) } : {}),
      ...(Number.isFinite(Number(row.images)) ? { images: Math.max(0, Math.trunc(Number(row.images))) } : {}),
      ...(Number.isFinite(Number(row.metadataCount)) ? { metadataCount: Math.max(0, Math.trunc(Number(row.metadataCount))) } : {}),
      ...(Number.isFinite(Number(row.parsedCount)) ? { parsedCount: Math.max(0, Math.trunc(Number(row.parsedCount))) } : {}),
      ...(Number.isFinite(Number(row.incompleteCount)) ? { incompleteCount: Math.max(0, Math.trunc(Number(row.incompleteCount))) } : {}),
      ...(Number.isFinite(Number(row.totalBytes)) ? { totalBytes: Math.max(0, Math.trunc(Number(row.totalBytes))) } : {}),
      ...(row.untrusted === true ? { untrusted: true } : {}),
      ...(row.source ? { source: String(row.source).slice(0, 120) } : {}),
      ...(row.error ? { error: String(row.error).slice(0, 1000) } : {}),
      ...(row.content ? { content: cloneJson(row.content) } : {}),
    };
  }
  return out;
}

function configInferenceSourceCoverageGate(ticket = {}) {
  const coverage = normalizeConfigInferenceSourceCoverage(ticket.sourceCoverage);
  const isTbTicket = !!String(ticket.tbTaskId || "").trim();
  if (!isTbTicket) {
    return {
      complete: true,
      applicable: false,
      required: [],
      missing: [],
      partial: [],
      warnings: [],
      inferenceReady: true,
    };
  }
  const advisory = ["detail", "comments", "attachments", "tags"];
  const missing = advisory.filter((key) => coverage[key]?.available !== true);
  const partial = advisory.filter((key) => coverage[key]?.available === true && coverage[key]?.complete === false);
  const usable = Object.entries(coverage)
    .filter(([, row]) => row?.available === true)
    .map(([key]) => key);
  return {
    // complete 继续记录采集质量，供训练样本审批使用；故事点配置推理只展示 warnings，
    // 不再要求 TB 详情、评论、附件、标签全部存在。
    complete: missing.length === 0 && partial.length === 0,
    applicable: true,
    required: [],
    advisory,
    missing,
    partial,
    warnings: [...missing, ...partial],
    usable,
    inferenceReady: usable.length > 0,
    warningOnly: missing.length > 0 || partial.length > 0,
  };
}

function normalizeStoredConfigInferenceTicket(input = {}, projectId = "") {
  const raw = isPlainObject(input) ? input : {};
  const normalized = normalizeConfigInferenceTicket(raw);
  const ticketProjectId = explicitConfigInferenceProjectId(raw.projectId || raw.tbProjectId || projectId);
  const snapshotCoverage = cloneJson(normalized.sourceCoverage || {});
  if (!normalized.tbTaskId) {
    const manualCapturedAt = normalized.snapshotAt;
    const manualDefaults = {
      detail: !!(normalized.title || normalized.description),
      note: false,
      comments: !!normalized.commentItems?.length,
      attachments: !!normalized.attachments?.length,
      tags: !!normalized.tags?.length,
    };
    snapshotCoverage.manual = isPlainObject(snapshotCoverage.manual)
      ? snapshotCoverage.manual
      : { available: true, complete: true };
    for (const source of ["manual", "detail", "note", "comments", "attachments", "tags"]) {
      if (!isPlainObject(snapshotCoverage[source]) && source !== "manual") {
        snapshotCoverage[source] = {
          available: manualDefaults[source] === true,
          complete: true,
          count: source === "tags"
            ? normalized.tags?.length || 0
            : source === "comments"
              ? normalized.commentItems?.length || 0
              : source === "attachments"
                ? normalized.attachments?.length || 0
                : 0,
        };
      }
      if (isPlainObject(snapshotCoverage[source]) && !snapshotCoverage[source].capturedAt) {
        snapshotCoverage[source].capturedAt = manualCapturedAt;
      }
    }
  }
  const snapshot = createInferenceSourceSnapshot({
    ...normalized,
    projectId: ticketProjectId || normalized.projectId,
    comments: normalized.commentItems || [],
    attachments: normalized.attachments || [],
    sourceCoverage: snapshotCoverage,
  }, {
    inferenceAt: normalized.snapshotAt,
    requiredSources: normalized.sourceCoverage?.requiredSources?.length
      ? normalized.sourceCoverage.requiredSources
      : ["detail"],
  });
  const safe = (value, limit) => sanitizeSharedTrainingText(value, limit);
  const commentItems = (snapshot.ticket.comments || []).map((row) => ({
    id: safe(row.id, 200),
    text: safe(row.text, 4000),
    availableAt: String(row.availableAt || ""),
  }));
  const sourceCoverage = {
    ...cloneJson(snapshot.sourceCoverage || {}),
    ...(normalized.sourceCoverage?.requiredSources?.length ? {
      requiredSources: [...new Set(normalized.sourceCoverage.requiredSources
        .map((value) => safe(value, 80))
        .filter(Boolean))],
    } : {}),
  };
  const stored = {
    ticketId: safe(normalized.ticketId || snapshot.ticket.id, 200),
    tbTaskId: safe(normalized.tbTaskId, 200),
    ...(ticketProjectId ? { projectId: ticketProjectId } : {}),
    title: safe(snapshot.ticket.title, 2000),
    description: safe(snapshot.ticket.description || snapshot.ticket.note, 12_000),
    projectName: safe(normalized.projectName, 1000),
    tasklistName: safe(normalized.tasklistName, 1000),
    tasklistId: safe(normalized.tasklistId, 500),
    projectKey: safe(normalized.projectKey, 2200),
    iterationName: safe(normalized.iterationName, 1000),
    tags: cloneJson(snapshot.ticket.tags || []),
    attachments: (snapshot.ticket.attachments || []).map((row) => ({
      id: safe(row.id, 200),
      name: safe(row.name, 300),
      textSummary: safe(row.textSummary, 1000),
      availableAt: String(row.availableAt || ""),
      status: safe(row.status, 80),
      parser: safe(row.parser, 80),
      contentHash: safe(row.contentHash, 100),
      untrusted: true,
    })),
    comments: commentItems.map((row) => row.text).filter(Boolean).join("\n").slice(0, 60_000),
    commentItems,
    sourceCoverage,
    createdAt: String(snapshot.ticket.createdAt || normalized.createdAt || ""),
    updatedAt: normalized.updatedAt,
    availableAt: normalized.availableAt,
    snapshotAt: snapshot.inferenceAt,
    sourceSnapshot: {
      schemaVersion: snapshot.schemaVersion,
      snapshotId: snapshot.snapshotId,
      inferenceAt: snapshot.inferenceAt,
      expiresAt: snapshot.expiresAt,
      sourceGate: cloneJson(snapshot.sourceGate),
      excludedFutureEvidence: cloneJson(snapshot.excludedFutureEvidence),
      excludedMissingTimeEvidence: cloneJson(snapshot.excludedMissingTimeEvidence),
    },
  };
  const portability = scanSharedSnapshotViolations(stored);
  if (!portability.portable) {
    const error = new Error(`配置推理共享输入快照仍含禁止字段：${portability.findings.join(",")}`);
    error.code = "CONFIG_INFERENCE_SHARED_SNAPSHOT_UNSAFE";
    throw error;
  }
  return stored;
}

function configInferenceRevisionSnapshot(registry, root, { legacyMemories = null } = {}) {
  const registryPayload = {
    projectDefs: registry?.projectDefs || [],
    vehicleMap: registry?.vehicleMap || {},
    targets: registry?.targets || [],
  };
  const sharedBindings = Object.fromEntries(Object.entries(isPlainObject(root?.valueBindings) ? root.valueBindings : {})
    .map(([logicalKey, rowValue]) => {
      const row = isPlainObject(rowValue) ? rowValue : {};
      const revisions = (Array.isArray(row.valueRevisions) ? row.valueRevisions : [])
        .filter((revision) => !["node", "user"].includes(String(revision?.scope || "").toLowerCase()))
        .map((revision) => ({
          id: String(revision.id || ""),
          keyId: String(revision.keyId || ""),
          scope: String(revision.scope || ""),
          scopeId: String(revision.scopeId || ""),
          status: String(revision.status || ""),
          revision: Math.max(0, Math.trunc(Number(revision.revision) || 0)),
          actualValue: revision.actualValue ?? "",
          fingerprint: String(revision.fingerprint || ""),
        }))
        .sort((left, right) => left.revision - right.revision || left.id.localeCompare(right.id));
      return [logicalKey, {
        keyId: String(row.keyId || ""),
        dimension: String(row.dimension || ""),
        actualValue: row?.actualValue ?? "",
        revisions,
        // Legacy project-scoped value remains part of the shared semantic state.
        legacy: {
          actualValue: row?.actualValue ?? "",
          revision: Math.max(0, Math.trunc(Number(row?.revision) || 0)),
          status: String(row?.status || "active"),
          scope: row?.scope || null,
        },
      }];
    }));
  const legacySamples = legacyConfigInferenceSamples(
    registry?.projectId || "",
    registry || { projectDefs: [], targets: [] },
    legacyMemories,
  );
  const servingSamples = [
    ...configInferenceLearningSamples(root),
    ...legacySamples,
  ]
    .map((sample) => ({
      id: String(sample.id || ""),
      servingStatus: sample.source === "legacy_config_memory"
        ? "legacy_compatible"
        : configInferenceSampleServingStatus(sample),
      servingRevision: Math.max(0, Math.trunc(Number(sample.serving?.revision) || 0)),
      approvedLabelFingerprint: String(sample.approvedLabel?.fingerprint || ""),
      source: String(sample.source || ""),
      availableAt: String(sample.availableAt || sample.reviewedAt || sample.updatedAt || sample.createdAt || ""),
      contentFingerprint: configInferenceDigest({
        signals: sample.signals || null,
        groundTruth: sample.groundTruth || null,
        negative: sample.negative || null,
        feedbackDecision: sample.feedback?.decision || sample.decision || "",
      }),
    }))
    .sort((left, right) => left.id.localeCompare(right.id));
  return {
    rulesRevision: CONFIG_INFERENCE_VERSION,
    registryRevision: configInferenceDigest(registryPayload),
    keywordRevision: configInferenceDigest(registry?.keywordMappings || {}),
    valueRevision: configInferenceDigest(sharedBindings),
    servingSampleRevision: configInferenceDigest(servingSamples),
  };
}

function configInferenceRegistrySnapshotFromShared(shared, projectId, fallback = null) {
  const pid = String(projectId || "").trim();
  const bucket = isPlainObject(shared?.byProject?.[pid]) ? shared.byProject[pid] : {};
  const projectDefConfig = {
    projectDefs: (Array.isArray(shared?.projectDefs)
    ? cloneJson(shared.projectDefs)
    : cloneJson(fallback?.projectDefs || [])),
    repositoryInferenceProfilesVersion: Number(shared?.repositoryInferenceProfilesVersion) || 0,
    sharedOps: cloneJson(shared?.sharedOps || []),
  };
  ensureRepositoryInferenceProfiles(projectDefConfig, { appendOps: false });
  ensureProductionSharedPollutionCleanup(projectDefConfig, { appendOps: false });
  const projectDefs = configuredProjectDefsOrDefaults(projectDefConfig)
    .map(normalizeDef)
    .filter((row) => row.id);
  const rawVehicleMap = isPlainObject(bucket.vehicleMap)
    ? bucket.vehicleMap
    : (fallback?.vehicleMap || {});
  const vehicleMap = Object.fromEntries(Object.entries(rawVehicleMap)
    .map(([vehicle, mapping]) => [vehicle, normalizeVehicleMapping(vehicle, mapping)]));
  const rawKeywordMappings = isPlainObject(bucket.keywordMappings)
    ? bucket.keywordMappings
    : (fallback?.keywordMappings || {});
  const keywordMappings = Object.fromEntries(KW_GROUPS.map((group) => [
    group,
    isPlainObject(rawKeywordMappings[group]) ? cloneJson(rawKeywordMappings[group]) : {},
  ]));
  const built = buildConfigInferenceRegistry(projectDefs, vehicleMap);
  return {
    projectId: pid,
    projectDefs,
    vehicleMap,
    keywordMappings,
    targets: Array.isArray(built) ? built : (Array.isArray(built?.targets) ? built.targets : []),
  };
}

function configInferenceRunStaleReasons(run, registry = null, root = null) {
  if (!run) return [];
  const reasons = [];
  if (String(run.version || "") !== CONFIG_INFERENCE_VERSION) reasons.push("rules");
  if (!registry || !root) return reasons;
  const current = configInferenceRevisionSnapshot(registry, root);
  // 推理时快照只约束“待复核”的旧预测。复核本身可能新增 annotation、负向样本，
  // 也可能回写 registry/value；因此已复核 run 必须改用复核事务完成后冻结的快照。
  // 旧 reviewed run 没有这份快照时不能继续充当故事点创建 proof。
  const reviewed = isPlainObject(run.review);
  const stored = reviewed
    ? (isPlainObject(run.review.inferenceRevisions) ? run.review.inferenceRevisions : null)
    : (isPlainObject(run.inferenceRevisions) ? run.inferenceRevisions : null);
  if (!stored) {
    reasons.push("revision_metadata_missing");
    return [...new Set(reasons)];
  }
  const requiredReviewRevisions = [
    "rulesRevision",
    "registryRevision",
    "keywordRevision",
    "valueRevision",
    "servingSampleRevision",
  ];
  if (reviewed && requiredReviewRevisions.some((key) => !String(stored[key] || "").trim())) {
    reasons.push("revision_metadata_missing");
    return [...new Set(reasons)];
  }
  if (stored.rulesRevision && stored.rulesRevision !== current.rulesRevision) reasons.push("rules");
  if (stored.registryRevision !== current.registryRevision) reasons.push("registry");
  if (stored.keywordRevision !== current.keywordRevision) reasons.push("keyword");
  if (stored.valueRevision !== current.valueRevision) reasons.push("value");
  if ((reviewed || stored.servingSampleRevision)
    && stored.servingSampleRevision !== current.servingSampleRevision) reasons.push("samples");
  return [...new Set(reasons)];
}

function normalizeConfigInferenceSource(source, projectId, { capturedAt = 0 } = {}) {
  const raw = typeof source === "string" ? { url: source } : source;
  if (!isPlainObject(raw)) return null;
  const sourceProjectId = String(raw.projectId || raw.tbProjectId || projectId || "").trim();
  const normalized = {
    type: String(raw.type || "teambition_section").trim().slice(0, 80),
    url: String(raw.url || raw.sectionUrl || "").trim().slice(0, 2000),
    projectId: sourceProjectId.slice(0, 160),
    sectionId: String(raw.sectionId || raw.tasklistId || raw.listId || "").trim().slice(0, 160),
    sprintId: String(raw.sprintId || "").trim().slice(0, 160),
    tasklistId: String(raw.tasklistId || "").trim().slice(0, 160),
    name: String(raw.name || raw.label || raw.tasklistName || "").trim().slice(0, 240),
    fetchSource: String(raw.fetchSource || raw.acquisition?.fetchSource || "").trim().slice(0, 80),
  };
  if (isPlainObject(raw.counts)) {
    normalized.counts = Object.fromEntries(["all", "pending", "completed"].map((key) => {
      const count = Number(raw.counts[key]);
      return [key, Number.isFinite(count) ? Math.max(0, Math.trunc(count)) : 0];
    }));
  }
  if (Array.isArray(raw.statusCounts)) {
    normalized.statusCounts = raw.statusCounts.slice(0, 200).map((row) => ({
      key: String(row?.key || row?.id || "__unknown__").trim().slice(0, 240) || "__unknown__",
      id: String(row?.id || "").trim().slice(0, 240),
      name: String(row?.name || "未标注状态").trim().slice(0, 240) || "未标注状态",
      count: Math.max(0, Math.trunc(Number(row?.count) || 0)),
      pending: Math.max(0, Math.trunc(Number(row?.pending) || 0)),
      completed: Math.max(0, Math.trunc(Number(row?.completed) || 0)),
    }));
  }
  if (isPlainObject(raw.acquisition)) {
    normalized.acquisition = {
      fetchSource: String(raw.acquisition.fetchSource || raw.fetchSource || "").trim().slice(0, 80),
      openApiMatched: Math.max(0, Math.trunc(Number(raw.acquisition.openApiMatched) || 0)),
      cookieMatched: Math.max(0, Math.trunc(Number(raw.acquisition.cookieMatched) || 0)),
      mergedMatched: Math.max(0, Math.trunc(Number(raw.acquisition.mergedMatched) || 0)),
      completionStates: ["pending", "completed"],
      taskflowStatusFilter: "none",
      cookieComplete: raw.acquisition.cookieComplete === true,
      cookiePages: Math.max(0, Math.trunc(Number(raw.acquisition.cookiePages) || 0)),
      cookieReportedTotal: Number.isFinite(Number(raw.acquisition.cookieReportedTotal))
        ? Math.max(0, Math.trunc(Number(raw.acquisition.cookieReportedTotal)))
        : null,
      openApiFailures: Math.max(0, Math.trunc(Number(raw.acquisition.openApiFailures) || 0)),
    };
  }
  const rawFilter = isPlainObject(raw.filter) ? raw.filter : {};
  const completion = ["pending", "completed", "all"].includes(String(rawFilter.completion || "").trim().toLowerCase())
    ? String(rawFilter.completion).trim().toLowerCase()
    : "all";
  normalized.filter = {
    completion,
    statusKeys: Array.isArray(rawFilter.statusKeys)
      ? [...new Set(rawFilter.statusKeys.slice(0, 200).map((value) => String(value || "").trim().slice(0, 240)).filter(Boolean))]
      : null,
  };
  if (!normalized.url && !normalized.sectionId && !normalized.sprintId && !normalized.tasklistId && !normalized.name) return null;
  if (capturedAt) normalized.capturedAt = Number(capturedAt) || Date.now();
  return normalized;
}

function configInferenceRows(map) {
  return Object.values(isPlainObject(map) ? map : {})
    .filter((row) => row && typeof row === "object")
    .sort((a, b) => Number(b.updatedAt || b.reviewedAt || b.createdAt || 0) - Number(a.updatedAt || a.reviewedAt || a.createdAt || 0));
}

function configInferenceTicketId(ticket) {
  return String(ticket?.tbTaskId || ticket?.ticketId || ticket?.id || "").trim().slice(0, 160);
}

/**
 * 同 TB 单再次创建故事点时，把最近一次人工复核（corrected/correct）作为弹窗预填草稿
 * 带回前端，避免用户每次都得重新纠正相同的配置。仅复用已落库的 review，不重算；
 * 训练随机抽题的复核同样算数（用户已确认过的配置就是该单的权威人工结论）。
 */
function buildPriorConfigInferenceReviewDraft(root, ticket) {
  const ticketId = configInferenceTicketId(ticket);
  if (!ticketId || !safeSharedSegment(ticketId)) return null;
  const latest = configInferenceRows(root.runs)
    .find((row) => row.review && configInferenceTicketId(row.ticket) === ticketId);
  if (!latest) return null;
  const decision = String(latest.review.decision || "").trim().toLowerCase();
  if (!["correct", "corrected"].includes(decision)) return null;
  const noTargets = decision === "corrected" && latest.review.correctedPrediction?.noTargets === true;
  const sourceTargets = decision === "corrected"
    ? (latest.review.correctedPrediction?.targets || latest.prediction?.targets || [])
    : (latest.prediction?.targets || []);
  const targets = normalizeConfigInferenceTargets(sourceTargets);
  if (!targets.length && !noTargets) return null;
  return {
    decision,
    rating: Number(latest.review.rating) || (decision === "correct" ? 5 : 3),
    correctedPrediction: { targets, noTargets },
    sourceRunId: latest.id,
    reviewedAt: Number(latest.review.reviewedAt || latest.updatedAt || 0),
  };
}

function configInferenceTrainingClaimActive(claim, now = Date.now()) {
  return isPlainObject(claim) && Number(claim.expiresAt || 0) > now;
}

function configInferenceTrainingClaimIdentity(claim) {
  if (!isPlainObject(claim)) return "";
  return stableJsonText({
    id: String(claim.id || claim.tbTaskId || ""),
    sessionId: String(claim.sessionId || ""),
    runId: String(claim.runId || ""),
    claimedAt: Number(claim.claimedAt || 0),
    expiresAt: Number(claim.expiresAt || 0),
    createdAt: Number(claim.createdAt || 0),
    updatedAt: Number(claim.updatedAt || 0),
  });
}

function configInferenceTrainingClaimMatchesRun(claim, run) {
  if (!isPlainObject(claim) || !isPlainObject(run)) return false;
  return !!String(run.trainingSessionId || "")
    && String(claim.sessionId || "") === String(run.trainingSessionId || "")
    && String(claim.runId || "") === String(run.id || "");
}

function configInferenceTrainingClaimOwnsRun(claim, run, now = Date.now()) {
  return configInferenceTrainingClaimActive(claim, now)
    && configInferenceTrainingClaimMatchesRun(claim, run);
}

function guardConfigInferenceTrainingClaimDeletes(latest, projectId, expectedClaims) {
  if (!(expectedClaims instanceof Map) || !expectedClaims.size) return true;
  const latestRoot = configInferenceSharedRoot(latest, projectId);
  for (const [ticketId, expected] of expectedClaims) {
    const current = latestRoot.trainingClaims?.[ticketId];
    if (!current) continue;
    if (configInferenceTrainingClaimIdentity(current) !== configInferenceTrainingClaimIdentity(expected)) {
      return `TB 单 ${ticketId} 的训练占用已由其它 Gateway 更新`;
    }
  }
  return true;
}

function pruneExpiredConfigInferenceTrainingClaims(root, projectId, now = Date.now(), expectedClaims = null) {
  const ops = [];
  for (const [ticketId, claim] of Object.entries(root.trainingClaims || {})) {
    if (!root.trainedTickets[ticketId] && configInferenceTrainingClaimActive(claim, now)) continue;
    if (expectedClaims instanceof Map) expectedClaims.set(ticketId, cloneJson(claim));
    delete root.trainingClaims[ticketId];
    ops.push({ type: "byProject.delete", projectId, path: ["aiTraining", "configInference", "trainingClaims", ticketId] });
  }
  return ops;
}

export function getConfigInferenceTrainingClaims(projectId, now = Date.now(), retry = 0) {
  const pid = explicitConfigInferenceProjectId(projectId);
  if (!pid) return { ok: false, error: "训练占用查询必须指定 TB 项目", data: [] };
  const cfg = loadRawConfig();
  const root = configInferenceRoot(cfg, pid);
  const expectedClaims = new Map();
  const ops = pruneExpiredConfigInferenceTrainingClaims(root, pid, now, expectedClaims);
  if (ops.length) {
    try {
      writeSharedOps(cfg, ops, {
        guard: (latest) => guardConfigInferenceTrainingClaimDeletes(latest, pid, expectedClaims),
      });
    } catch (error) {
      if (error?.code === "SHARED_WRITE_CONFLICT" && retry < 2) {
        return getConfigInferenceTrainingClaims(pid, now, retry + 1);
      }
      throw error;
    }
  }
  return { ok: true, data: configInferenceRows(root.trainingClaims).filter((claim) => configInferenceTrainingClaimActive(claim, now)) };
}

export function claimConfigInferenceTrainingTicket(projectId, tbTaskId, sessionId, now = Date.now()) {
  const pid = explicitConfigInferenceProjectId(projectId);
  const ticketId = String(tbTaskId || "").trim().slice(0, 160);
  const ownerSessionId = String(sessionId || "").trim().slice(0, 160);
  if (!pid || !ticketId || !ownerSessionId || !safeSharedSegment(ticketId)) {
    return { ok: false, error: "训练占用缺少有效的项目、TB 单或会话" };
  }
  const cfg = loadRawConfig();
  const root = configInferenceRoot(cfg, pid);
  const expectedClaims = new Map();
  let ops = pruneExpiredConfigInferenceTrainingClaims(root, pid, now, expectedClaims);
  if (root.trainedTickets[ticketId]) {
    if (ops.length) {
      try {
        writeSharedOps(cfg, ops, {
          guard: (latest) => guardConfigInferenceTrainingClaimDeletes(latest, pid, expectedClaims),
        });
      } catch (error) {
        if (error?.code === "SHARED_WRITE_CONFLICT") return claimConfigInferenceTrainingTicket(pid, ticketId, ownerSessionId, Date.now());
        throw error;
      }
    }
    return { ok: false, trained: true, error: "该 TB 单已经完成训练" };
  }
  const existing = root.trainingClaims[ticketId];
  if (configInferenceTrainingClaimActive(existing, now)) {
    if (ops.length) {
      try {
        writeSharedOps(cfg, ops, {
          guard: (latest) => guardConfigInferenceTrainingClaimDeletes(latest, pid, expectedClaims),
        });
      } catch (error) {
        if (error?.code === "SHARED_WRITE_CONFLICT") return claimConfigInferenceTrainingTicket(pid, ticketId, ownerSessionId, Date.now());
        throw error;
      }
    }
    return {
      ok: false,
      busy: true,
      owned: existing.sessionId === ownerSessionId,
      claim: cloneJson(existing),
      error: existing.sessionId === ownerSessionId ? "当前会话正在处理该 TB 单" : "该 TB 单正在其它训练会话中",
    };
  }
  // 同一 key 的新占用直接覆盖过期值，不先广播 delete；时间戳必须晚于历史 tombstone，确保 LAN 合并不会把新租约误删。
  ops = ops.filter((op) => String(op.path?.[3] || "") !== ticketId);
  expectedClaims.delete(ticketId);
  const claimNow = Math.max(now, configInferenceTimestamp(root.tombstones?.trainingClaims?.[ticketId]) + 1);
  const claim = {
    id: ticketId,
    tbTaskId: ticketId,
    sessionId: ownerSessionId,
    runId: "",
    claimedAt: claimNow,
    expiresAt: claimNow + CONFIG_INFERENCE_TRAINING_CLAIM_TTL_MS,
    createdAt: claimNow,
    updatedAt: claimNow,
  };
  root.trainingClaims[ticketId] = claim;
  ops.push({ type: "byProject.set", projectId: pid, path: ["aiTraining", "configInference", "trainingClaims", ticketId], value: claim });
  try {
    writeSharedOps(cfg, ops, {
      guard: (latest) => {
        const deleteGuard = guardConfigInferenceTrainingClaimDeletes(latest, pid, expectedClaims);
        if (deleteGuard !== true) return deleteGuard;
        const latestRoot = configInferenceSharedRoot(latest, pid);
        if (latestRoot.trainedTickets?.[ticketId]) return "该 TB 单已经完成训练";
        if (configInferenceTrainingClaimActive(latestRoot.trainingClaims?.[ticketId], now)) return "该 TB 单已被其它会话抢先占用";
        return true;
      },
    });
  } catch (error) {
    if (error?.code === "SHARED_WRITE_CONFLICT") return claimConfigInferenceTrainingTicket(pid, ticketId, ownerSessionId, Date.now());
    throw error;
  }
  return { ok: true, claim: cloneJson(claim), ttlMs: CONFIG_INFERENCE_TRAINING_CLAIM_TTL_MS };
}

export function releaseConfigInferenceTrainingClaims(projectId, input = {}, now = Date.now(), retry = 0) {
  const pid = explicitConfigInferenceProjectId(projectId);
  const sessionId = String(input.sessionId || "").trim().slice(0, 160);
  const requestedTicketId = String(input.tbTaskId || input.ticketId || "").trim().slice(0, 160);
  if (!pid || (!sessionId && !requestedTicketId)) return { ok: false, error: "释放训练占用必须指定项目以及会话或 TB 单", released: 0 };
  const cfg = loadRawConfig();
  const root = configInferenceRoot(cfg, pid);
  const expectedClaims = new Map();
  const ops = pruneExpiredConfigInferenceTrainingClaims(root, pid, now, expectedClaims);
  let released = 0;
  for (const [ticketId, claim] of Object.entries(root.trainingClaims || {})) {
    if (requestedTicketId && ticketId !== requestedTicketId) continue;
    if (sessionId && String(claim?.sessionId || "") !== sessionId) continue;
    expectedClaims.set(ticketId, cloneJson(claim));
    delete root.trainingClaims[ticketId];
    released++;
    ops.push({ type: "byProject.delete", projectId: pid, path: ["aiTraining", "configInference", "trainingClaims", ticketId] });
  }
  if (ops.length) {
    try {
      writeSharedOps(cfg, ops, {
        guard: (latest) => guardConfigInferenceTrainingClaimDeletes(latest, pid, expectedClaims),
      });
    } catch (error) {
      if (error?.code === "SHARED_WRITE_CONFLICT" && retry < 2) {
        return releaseConfigInferenceTrainingClaims(pid, input, now, retry + 1);
      }
      throw error;
    }
  }
  return { ok: true, released };
}

function backfillConfigInferenceTrainedTickets(root, projectId, expectedAbsent = null) {
  const ops = [];
  for (const run of configInferenceRows(root.runs)) {
    if (run?.trigger !== "training_random" || !run.review) continue;
    const ticketId = configInferenceTicketId(run.ticket);
    if (!ticketId || !safeSharedSegment(ticketId) || root.trainedTickets[ticketId]) continue;
    const trainedAt = Number(run.review.reviewedAt || run.updatedAt || run.createdAt) || Date.now();
    const trainedTicket = {
      id: ticketId,
      tbTaskId: ticketId,
      sourceRunId: run.id,
      trainingSessionId: run.trainingSessionId || "",
      decision: run.review.decision,
      rating: run.review.rating,
      trainedAt,
      createdAt: trainedAt,
      updatedAt: trainedAt,
      migrated: true,
    };
    if (expectedAbsent instanceof Set) expectedAbsent.add(ticketId);
    root.trainedTickets[ticketId] = trainedTicket;
    ops.push({ type: "byProject.set", projectId, path: ["aiTraining", "configInference", "trainedTickets", ticketId], value: trainedTicket });
  }
  return ops;
}

function guardConfigInferenceTrainedTicketBackfills(latest, projectId, expectedAbsent) {
  if (!(expectedAbsent instanceof Set) || !expectedAbsent.size) return true;
  const latestRoot = configInferenceSharedRoot(latest, projectId);
  for (const ticketId of expectedAbsent) {
    if (latestRoot.trainedTickets?.[ticketId]) {
      return `TB 单 ${ticketId} 的历史训练标记已由其它 Gateway 创建`;
    }
  }
  return true;
}

function configInferenceSampleServingStatus(sample) {
  const explicit = String(sample?.serving?.status || "").trim().toLowerCase();
  if (CONFIG_INFERENCE_SERVING_STATUSES.has(explicit)) return explicit;
  // 兼容治理状态引入前已经进入 RAG 的历史样本；真实执行事件不做这项兼容，
  // 它们必须经过 accepted + verified + approved 后才能进入 serving。
  if (sample?.source === "actual_execution" || sample?.recordType === "observation") return "pending";
  return "approved";
}

function configInferenceAllSamples(root) {
  return configInferenceRows(root.samples);
}

function configInferenceSampleHeldByRelease(root, sample) {
  const releaseId = String(sample?.serving?.releaseHold || "").trim();
  if (!releaseId) return false;
  return ["shadow", "canary", "active"].includes(
    String(root?.releases?.[releaseId]?.status || "").toLowerCase(),
  );
}

function configInferenceLearningSamples(root) {
  const stored = configInferenceAllSamples(root)
    .filter((sample) => configInferenceSampleServingStatus(sample) === "approved")
    // staged/active release 必须冻结 serving 输入。在线双审标签先用于观测，
    // release 结束后才进入下一轮 baseline，避免首条 shadow 标签让 artifact 自失效。
    .filter((sample) => !configInferenceSampleHeldByRelease(root, sample));
  const storedRunIds = new Set(stored.map((row) => String(row.sourceRunId || "")).filter(Boolean));
  const legacyInsufficient = configInferenceRows(root.runs)
    .filter((row) => row.review?.decision === "insufficient"
      && row.id
      && !storedRunIds.has(String(row.id))
      && !row.review?.annotationId
      && Array.isArray(row.prediction?.targets)
      && row.prediction.targets.length)
    .map((row) => ({
      id: `CIS_LEGACY_${row.id}`,
      projectId: row.projectId,
      source: row.trigger === "training_random" ? "training_random" : "user_feedback",
      sourceRunId: row.id,
      rating: row.review?.rating,
      score: row.review?.rating,
      ticket: row.ticket,
      signals: row.prediction?.signals,
      feedback: {
        ...row.review,
        score: row.review?.rating,
        rejectedPrediction: {
          status: row.prediction?.status,
          targets: normalizeConfigInferenceTargets(row.prediction?.targets || []),
        },
      },
      negative: {
        policyVersion: 1,
        rejectedTargets: normalizeConfigInferenceTargets(row.prediction?.targets || []),
      },
      createdAt: row.review?.reviewedAt || row.updatedAt || row.createdAt,
      updatedAt: row.updatedAt || row.review?.reviewedAt || row.createdAt,
      legacyRunOnly: true,
    }));
  return [...stored, ...legacyInsufficient]
    .sort((a, b) => Number(b.updatedAt || b.reviewedAt || b.createdAt || 0) - Number(a.updatedAt || a.reviewedAt || a.createdAt || 0));
}

function trimConfigInferenceSection(root, section, projectId, expectedDeletes = null) {
  const rows = configInferenceRows(root[section]);
  const ops = [];
  for (const row of rows.slice(CONFIG_INFERENCE_LIMITS[section])) {
    if (!row?.id) continue;
    if (expectedDeletes instanceof Map) {
      expectedDeletes.set(`${section}/${row.id}`, { section, id: row.id, row: cloneJson(row) });
    }
    delete root[section][row.id];
    ops.push({ type: "byProject.delete", projectId, path: ["aiTraining", "configInference", section, row.id] });
  }
  return ops;
}

function guardConfigInferenceTrimDeletes(latest, projectId, expectedDeletes) {
  if (!(expectedDeletes instanceof Map) || !expectedDeletes.size) return true;
  const latestRoot = configInferenceSharedRoot(latest, projectId);
  for (const { section, id, row } of expectedDeletes.values()) {
    const current = latestRoot?.[section]?.[id];
    if (!current) continue;
    if (stableJsonText(current) !== stableJsonText(row)) {
      return `配置推理 ${section}/${id} 已由其它 Gateway 更新，不能按旧快照裁剪`;
    }
  }
  return true;
}

function configInferenceRegistrySnapshot(projectId) {
  const pid = projectId || defaultPid();
  const base = storyTrainingRegistrySnapshot(pid);
  const registry = buildConfigInferenceRegistry(base.projectDefs, base.vehicleMap);
  const targets = Array.isArray(registry) ? registry : (Array.isArray(registry?.targets) ? registry.targets : []);
  const unique = (values) => [...new Set(values.map((value) => String(value || "").trim()).filter(Boolean))];
  const uniqueOptions = (values, field) => {
    const seen = new Set();
    return values.filter((value) => {
      const key = `${value.repositoryId}|${value[field]}`;
      if (!value.repositoryId || !value[field] || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  };
  // 选项必须来自已经过工程注册表约束和旧数据补全的目标；不能再把车型名回退成 flavor。
  const apps = targets.map((target) => target.appName);
  const branches = uniqueOptions(targets.map((target) => ({
    repositoryId: target.repositoryId,
    repositoryName: target.repositoryName,
    branch: target.branch,
  })), "branch");
  for (const def of base.projectDefs) {
    for (const branch of unique([def.defaultBranch, ...(def.branchOptions || [])])) {
      if (branch && !branches.some((row) => row.repositoryId === def.id && row.branch === branch)) {
        branches.push({ repositoryId: def.id, repositoryName: def.name, branch });
      }
    }
  }
  const flavors = uniqueOptions(targets.map((target) => ({
    repositoryId: target.repositoryId,
    repositoryName: target.repositoryName,
    flavor: target.flavor,
  })), "flavor");
  for (const def of base.projectDefs) {
    for (const flavor of unique([def.defaultFlavor, ...(def.flavorOptions || [])])) {
      if (flavor && !flavors.some((row) => row.repositoryId === def.id && row.flavor === flavor)) {
        flavors.push({ repositoryId: def.id, repositoryName: def.name, flavor });
      }
    }
  }
  return {
    projectId: pid,
    version: base.version,
    projectDefs: base.projectDefs,
    vehicleMap: base.vehicleMap,
    keywordMappings: base.keywordMappings,
    targets,
    options: {
      apps: unique(apps),
      vehicles: unique(targets.map((target) => target.vehicle)),
      repositories: base.projectDefs.map((def) => ({
        id: def.id,
        name: def.name,
        gitUrl: def.ssh || def.https || "",
        projectType: def.projectType,
        inferenceEnabled: def.inferenceEnabled === true,
        inferenceKeywords: def.inferenceKeywords || [],
        requiresRepositories: def.requiresRepositories || [],
        inheritVariant: def.inheritVariant || [],
        defaultBranch: def.defaultBranch || "",
        defaultFlavor: def.defaultFlavor || "",
        branchOptions: def.branchOptions || [],
        flavorOptions: def.flavorOptions || [],
        repositoryOnly: ["sdk", "tooling", "service", "repository"].includes(def.projectType),
      })),
      branches,
      flavors,
      registryTargets: targets,
    },
  };
}

function legacyConfigInferenceSamples(projectId, registry, memoriesOverride = null) {
  const defs = new Map(registry.projectDefs.map((def) => [def.id, def]));
  const memories = Array.isArray(memoriesOverride) ? memoriesOverride : getConfigMemories(projectId);
  return memories.map((memory) => {
    const requestedRepositoryId = String(memory?.config?.primaryProjectId || "").trim();
    const requestedRemote = repositoryKey(memory?.config?.primaryRemote || "");
    const requestedBranch = String(memory?.config?.primaryBranch || "").trim().toLowerCase();
    const requestedFlavor = String(memory?.config?.flavor || "").trim().toLowerCase();
    const requestedVehicle = String(memory?.signals?.vehicle || "").trim().toLowerCase();
    const requestedApp = String(memory?.signals?.app || "").trim().toLowerCase();
    const directDef = defs.get(requestedRepositoryId);
    const remoteRepositoryIds = new Set(registry.projectDefs
      .filter((def) => requestedRemote && [def.ssh, def.https, def.gitUrl]
        .some((remote) => repositoryKey(remote) === requestedRemote))
      .map((def) => def.id));
    const candidates = registry.targets.filter((target) => {
      if (target.repositoryOnly) return false;
      const repositoryMatched = directDef
        ? target.repositoryId === requestedRepositoryId
        : requestedRemote && (
          repositoryKey(target.gitUrl) === requestedRemote
          || remoteRepositoryIds.has(target.repositoryId)
        );
      if (!repositoryMatched) return false;
      if (requestedBranch && String(target.branch || "").trim().toLowerCase() !== requestedBranch) return false;
      if (requestedFlavor && String(target.flavor || "").trim().toLowerCase() !== requestedFlavor) return false;
      if (requestedVehicle && String(target.vehicle || "").trim().toLowerCase() !== requestedVehicle) return false;
      if (requestedApp && String(target.appName || "").trim().toLowerCase() !== requestedApp) return false;
      return true;
    });
    // 旧 configMemory 的 primaryProjectId 可能是本机工程副本 id，并不在仓库定义中。
    // 只有 Git 远程 + 已保存分支/Flavor/车型等特征能唯一落到当前注册表时才迁移；
    // 无法唯一确定时直接忽略，绝不把第一条车型配置当作默认值。
    if (candidates.length !== 1) return null;
    const registered = candidates[0];
    const score = Math.min(5, 3 + Math.floor(Number(memory.count || 1) / 2));
    const titleSignals = [...new Set([
      String(memory.sampleTitle || "").trim(),
      ...(Array.isArray(memory.signals?.titleKeywords) ? memory.signals.titleKeywords : []),
    ].filter(Boolean))];
    return {
      id: `legacy:${memory.id}`,
      source: "legacy_config_memory",
      rating: score,
      score,
      signals: {
        title: titleSignals,
        project: [],
        iteration: memory.signals?.sprintName ? [memory.signals.sprintName] : [],
        tag: Array.isArray(memory.signals?.tags) ? memory.signals.tags : [],
        attachment: [],
        comment: [],
      },
      ticket: { title: memory.sampleTitle || "", snapshotAt: new Date(memory.updatedAt || memory.createdAt || Date.now()).toISOString() },
      groundTruth: {
        targets: [{
          ...registered,
          confidence: 0,
          evidenceIds: [],
        }],
      },
      createdAt: memory.createdAt || memory.updatedAt || 0,
      updatedAt: memory.updatedAt || memory.createdAt || 0,
    };
  }).filter(Boolean);
}

function signalValues(signals, group) {
  const value = signals?.sources?.[group] ?? signals?.[group];
  let rows = [];
  if (Array.isArray(value)) rows = value;
  else if (Array.isArray(value?.values)) rows = value.values;
  else if (Array.isArray(value?.keywords)) rows = value.keywords;
  else if (Array.isArray(value?.captured)) rows = value.captured;
  else if (typeof value === "string") rows = [value];
  if (!["attachment", "comment"].includes(group)) return rows;
  return rows.flatMap((item) => String(item || "").split(/[\r\n]+/)).filter(Boolean);
}

function captureConfigInferenceKeywords(projectId, signals) {
  const pid = explicitConfigInferenceProjectId(projectId);
  if (!pid) return { ok: false, added: 0, updated: 0 };
  const cfg = loadRawConfig();
  const root = configInferenceRoot(cfg, pid);
  const mappings = projectBucket(cfg, pid).keywordMappings || {};
  const now = Date.now();
  const ops = [];
  let added = 0;
  let updated = 0;
  for (const group of KW_GROUPS) {
    const keys = signalValues(signals, group)
      .map((value) => String(value || "").trim())
      .filter((value) => value && value.length <= 180 && !/[\r\n]/.test(value))
      .slice(0, group === "comment" ? 30 : 100);
    for (const value of [...new Set(keys)]) {
      if (Object.hasOwn(isPlainObject(mappings[group]) ? mappings[group] : {}, value)) continue;
      const id = `KWS_${group}_${configInferenceDigest(`${pid}|${group}|${value.toLowerCase()}`)}`;
      const existing = isPlainObject(root.keywordSuggestions[id]) ? root.keywordSuggestions[id] : {};
      const row = {
        ...existing,
        id,
        projectId: pid,
        group,
        value,
        status: String(existing.status || "pending"),
        occurrences: Math.max(0, Number(existing.occurrences || 0)) + 1,
        firstSeenAt: Number(existing.firstSeenAt || 0) || now,
        lastSeenAt: now,
        createdAt: Number(existing.createdAt || 0) || now,
        updatedAt: Math.max(now, Number(existing.updatedAt || 0) + 1),
      };
      root.keywordSuggestions[id] = row;
      ops.push({ type: "byProject.set", projectId: pid, path: ["aiTraining", "configInference", "keywordSuggestions", id], value: row });
      if (existing.id) updated++;
      else added++;
    }
  }
  if (ops.length) {
    const expectedDeletes = new Map();
    ops.push(...trimConfigInferenceSection(root, "keywordSuggestions", pid, expectedDeletes));
    writeSharedOps(cfg, ops, {
      guard: (latest) => guardConfigInferenceTrimDeletes(latest, pid, expectedDeletes),
    });
  }
  return { ok: true, added, updated };
}

function configInferenceMetrics(root, registry) {
  const runs = configInferenceRows(root.runs);
  const allSamples = configInferenceAllSamples(root);
  const samples = configInferenceLearningSamples(root);
  const reviewed = runs.filter((row) => row.review);
  const dimensions = ["appName", "vehicle", "repositoryId", "branch", "flavor"];
  const field = Object.fromEntries(dimensions.map((name) => [name, { correct: 0, total: 0 }]));
  let exact = 0;
  let exactEligibleReviews = 0;
  const values = (targets, name) => [...new Set((targets || []).map((target) => String(target?.[name] || "")).filter(Boolean))].sort().join("|");
  for (const run of reviewed) {
    if (!["correct", "corrected"].includes(run.review?.decision)) continue;
    if (run.review?.correctedPrediction?.noTargets === true) continue;
    const predicted = run.prediction?.targets || [];
    const actual = run.review?.correctedPrediction?.targets || predicted;
    if (!actual.length) continue;
    exactEligibleReviews++;
    let all = true;
    for (const name of dimensions) {
      const comparable = values(actual, name);
      if (!comparable) continue;
      field[name].total++;
      if (values(predicted, name) === comparable) field[name].correct++;
      else all = false;
    }
    if (all) exact++;
  }
  const ruleCountByGroup = Object.fromEntries(KW_GROUPS.map((group) => [group, Object.values(registry.keywordMappings?.[group] || {}).filter((row) => row?.value).length]));
  return {
    rules: Object.values(ruleCountByGroup).reduce((sum, value) => sum + value, 0),
    ruleCountByGroup,
    runs: runs.length,
    reviewed: reviewed.length,
    pendingReviews: runs.filter((row) => !row.review).length,
    stalePendingRuns: runs.filter((row) => (
      !row.review && configInferenceRunNeedsRefresh(row, registry, root)
    )).length,
    learnedSamples: samples.length,
    annotations: allSamples.filter((row) => row.recordType === "annotation").length,
    pendingAnnotations: allSamples.filter((row) => (
      row.recordType === "annotation" && configInferenceSampleServingStatus(row) === "pending"
    )).length,
    approvedServingSamples: allSamples.filter((row) => configInferenceSampleServingStatus(row) === "approved").length,
    revokedServingSamples: allSamples.filter((row) => configInferenceSampleServingStatus(row) === "revoked").length,
    trainedTickets: configInferenceRows(root.trainedTickets).length,
    activeTrainingClaims: configInferenceRows(root.trainingClaims).filter((claim) => configInferenceTrainingClaimActive(claim)).length,
    positiveSamples: samples.filter((row) => (
      !["insufficient", "ticket_wrong", "incorrect"].includes(row.feedback?.decision || row.decision)
      && (row.groundTruth?.targets || []).length > 0
    )).length,
    negativeSamples: samples.filter((row) => (
      row.feedback?.decision === "insufficient" || row.groundTruth?.noTargets === true
    )).length,
    actualExecutionSamples: allSamples.filter((row) => row.source === "actual_execution").length,
    approvedExecutionSamples: samples.filter((row) => row.source === "actual_execution").length,
    noTargetSamples: samples.filter((row) => row.groundTruth?.noTargets === true).length,
    symbolicSamples: samples.filter((row) => (row.groundTruth?.targets || []).some(hasConfigInferenceSymbolicFields)).length,
    exactEligibleReviews,
    exactAccuracy: exactEligibleReviews ? Number((exact / exactEligibleReviews).toFixed(3)) : null,
    fieldAccuracy: Object.fromEntries(dimensions.map((name) => [name, field[name].total ? Number((field[name].correct / field[name].total).toFixed(3)) : null])),
  };
}

function configInferenceRunNeedsRefresh(run, registry = null, root = null) {
  return configInferenceRunStaleReasons(run, registry, root).length > 0;
}

export function getConfigInferenceData(projectId, retry = 0) {
  const pid = projectId || defaultPid();
  const registry = configInferenceRegistrySnapshot(pid);
  const cfg = loadRawConfig();
  const root = configInferenceRoot(cfg, pid);
  const expectedClaims = new Map();
  const expectedAbsentTrainedTickets = new Set();
  const maintenanceOps = [
    ...backfillConfigInferenceTrainedTickets(root, pid, expectedAbsentTrainedTickets),
    ...pruneExpiredConfigInferenceTrainingClaims(root, pid, Date.now(), expectedClaims),
  ];
  if (maintenanceOps.length) {
    try {
      writeSharedOps(cfg, maintenanceOps, {
        guard: (latest) => {
          const claimGuard = guardConfigInferenceTrainingClaimDeletes(latest, pid, expectedClaims);
          if (claimGuard !== true) return claimGuard;
          return guardConfigInferenceTrainedTicketBackfills(latest, pid, expectedAbsentTrainedTickets);
        },
      });
    } catch (error) {
      if (error?.code === "SHARED_WRITE_CONFLICT" && retry < 2) return getConfigInferenceData(pid, retry + 1);
      throw error;
    }
  }
  const storedSamples = configInferenceAllSamples(root);
  const samples = storedSamples.map((sample) => ({
    ...configInferenceBoundSample(pid, root, sample),
    servingStatus: configInferenceSampleServingStatus(sample),
  }));
  const runs = configInferenceRows(root.runs).map((run) => ({
    ...configInferenceBoundRun(pid, root, run),
    stalePrediction: configInferenceRunNeedsRefresh(run, registry, root),
    staleReasons: configInferenceRunStaleReasons(run, registry, root),
  }));
  const valueBindings = configInferenceValueBindingCatalog(pid, root, registry);
  const servingRelease = configInferenceReleaseState(pid, root, registry);
  const projectTasks = listTasks().filter((task) => task.tbTaskId
    && (!task.projectId || String(task.projectId) === String(pid)));
  return {
    projectId: pid,
    version: CONFIG_INFERENCE_VERSION,
    registry,
    options: registry.options,
    runs,
    samples,
    keywordSuggestions: configInferenceRows(root.keywordSuggestions),
    valueBindings,
    trainedTickets: configInferenceRows(root.trainedTickets),
    trainingClaims: configInferenceRows(root.trainingClaims).filter((claim) => configInferenceTrainingClaimActive(claim)),
    settings: { taskSource: cloneJson(root.settings.taskSource || null) },
    servingRelease: cloneJson(servingRelease),
    memoryScope: {
      type: "tb_project",
      projectId: pid,
      crossDirectory: true,
      lanSync: true,
      providerNeutral: true,
    },
    metrics: {
      ...configInferenceMetrics(root, registry),
      valueBindings: valueBindings.length,
      overriddenBindings: valueBindings.filter((row) => row.revision > 0).length,
      unresolvedBindings: valueBindings.filter((row) => !row.resolved).length,
    },
    taskPool: {
      all: projectTasks.length,
      staged: projectTasks.filter((task) => task.staged !== false && !task.done).length,
      pending: projectTasks.filter((task) => task.staged === false && !task.done).length,
      completed: projectTasks.filter((task) => task.done).length,
    },
  };
}

function configInferenceBindingActualValue(field, value) {
  const actualValue = String(value ?? "").trim();
  if (!CONFIG_INFERENCE_REPLACEABLE_FIELDS.includes(field)) {
    return { ok: false, error: `字段 ${field || "unknown"} 不支持单独替换实际值` };
  }
  if (!actualValue) return { ok: false, error: "实际值不能为空；尚未确定时请保留原映射" };
  if (/[\u0000\r\n]/.test(actualValue)) return { ok: false, error: "实际值不能包含换行或控制字符" };
  const maxLength = field === "branch" ? 1000 : 3000;
  if (actualValue.length > maxLength) return { ok: false, error: `实际值长度不能超过 ${maxLength}` };
  if (field === "repositoryId" && configInferenceLooksLikeGitAddress(actualValue)) {
    const gitPair = configInferenceGitPair(actualValue);
    if (!gitPair.ok) return { ok: false, error: gitPair.error };
  }
  return { ok: true, actualValue };
}

function configInferenceRepositoryBindingTarget(cfg, target, actualValue) {
  const defs = (Array.isArray(cfg.projectDefs) ? cfg.projectDefs : getProjectDefs())
    .map((def) => normalizeDefPreservingMetadata(def))
    .filter((def) => def.id);
  const normalized = String(actualValue || "").trim().toLowerCase();
  const gitPair = configInferenceLooksLikeGitAddress(actualValue)
    ? configInferenceGitPair(actualValue)
    : { ok: true, https: "", ssh: "", raw: "" };
  if (!gitPair.ok) return { ok: false, error: gitPair.error };
  const matches = defs.filter((def) => {
    const identities = [def.id, def.name, def.https, def.ssh]
      .map((value) => String(value || "").trim().toLowerCase())
      .filter(Boolean);
    if (identities.includes(normalized)) return true;
    if (!gitPair.raw) return false;
    const remotes = [gitPair.https, gitPair.ssh]
      .map((value) => String(value || "").trim().toLowerCase())
      .filter(Boolean);
    return identities.some((value) => remotes.includes(value));
  });
  if (matches.length > 1) return { ok: false, error: "Git 仓库实际值同时命中多个仓库定义，请使用唯一仓库 ID" };
  if (matches.length === 1) {
    const def = matches[0];
    return {
      ok: true,
      actualValue: def.id,
      target: {
        ...target,
        repositoryId: def.id,
        repositoryName: def.name || def.id,
        gitUrl: def.ssh || def.https || "",
        projectType: def.projectType || target.projectType,
        repositoryOnly: CONFIG_INFERENCE_REPOSITORY_ONLY_TYPES.has(def.projectType) || def.inferenceEnabled === true,
      },
    };
  }
  if (gitPair.raw) {
    const repositoryName = configInferenceRepositoryNameFromGit(actualValue) || target.repositoryName || "repository";
    return {
      ok: true,
      actualValue,
      target: {
        ...target,
        repositoryId: actualValue,
        repositoryName,
        gitUrl: actualValue,
      },
    };
  }
  return {
    ok: true,
    actualValue,
    target: {
      ...target,
      repositoryId: actualValue,
      repositoryName: actualValue,
      gitUrl: "",
    },
  };
}

function mergeConfigInferenceConfigurationUpdates(current, incoming) {
  const next = { ...(current || { changed: false }) };
  const row = incoming || {};
  for (const key of ["repositories", "applications", "vehicles", "branches", "flavors"]) {
    next[key] = [...new Set([...(next[key] || []), ...(row[key] || [])].filter(Boolean))];
  }
  next.changed = next.changed === true || row.changed === true;
  next.orderUpdated = next.orderUpdated === true || row.orderUpdated === true;
  return next;
}

function configInferenceBindingReferences(projectId, root, logicalKey, valueBindings = root.valueBindings) {
  const references = [];
  for (const source of configInferenceBindingTargets(root)) {
    const targets = bindConfigInferenceTargets(source.targets, { projectId, valueBindings });
    for (const target of targets) {
      for (const field of CONFIG_INFERENCE_REPLACEABLE_FIELDS) {
        if (target.fieldBindings?.[field]?.logicalKey !== logicalKey) continue;
        references.push({ source, field, target });
      }
    }
  }
  return references;
}

export function updateConfigInferenceValueBinding(projectId, logicalKeyInput, input = {}) {
  const pid = explicitConfigInferenceProjectId(projectId);
  const logicalKey = String(logicalKeyInput || "").trim();
  if (!pid) return { ok: false, error: "替换 RAG 实际值必须指定 TB 项目" };
  if (!safeSharedSegment(logicalKey)) return { ok: false, error: "永久 logicalKey 无效" };
  if (input.logicalKey !== undefined && String(input.logicalKey || "").trim() !== logicalKey) {
    return { ok: false, error: "永久 logicalKey 不能修改" };
  }

  const cfg = loadRawConfig();
  const root = configInferenceRoot(cfg, pid);
  const registry = configInferenceRegistrySnapshot(pid);
  const catalog = configInferenceValueBindingCatalog(pid, root, registry);
  const discovered = catalog.find((row) => row.logicalKey === logicalKey);
  if (!discovered) return { ok: false, statusCode: 404, error: "RAG 永久 Key 不存在或尚未进入学习记忆" };
  const field = String(discovered.field || discovered.dimension || "").trim();
  if (input.field !== undefined && String(input.field || "").trim() !== field) {
    return { ok: false, error: "永久 Key 所属字段不能修改" };
  }
  const normalizedValue = configInferenceBindingActualValue(field, input.actualValue);
  if (!normalizedValue.ok) return normalizedValue;

  const stored = isPlainObject(root.valueBindings[logicalKey]) ? root.valueBindings[logicalKey] : null;
  const knowledgeKey = configInferenceKnowledgeKeyDefinition(logicalKey, field, stored || discovered);
  if (input.keyId !== undefined && String(input.keyId || "").trim() !== knowledgeKey.keyId) {
    return { ok: false, statusCode: 409, code: "KNOWLEDGE_KEY_IMMUTABLE", error: "knowledge keyId 不可修改" };
  }
  if (input.scope !== undefined && String(input.scope || "project").trim() !== "project") {
    return { ok: false, statusCode: 400, error: "旧 value-binding 接口仅支持 project scope；node/user 值请使用 v2 revision 接口" };
  }
  const currentRevision = Math.max(0, Math.trunc(Number(stored?.revision ?? discovered.revision) || 0));
  if (input.expectedRevision !== undefined && input.expectedRevision !== null && input.expectedRevision !== "") {
    const expectedRevision = Number(input.expectedRevision);
    if (!Number.isInteger(expectedRevision) || expectedRevision < 0) {
      return { ok: false, error: "expectedRevision 必须是非负整数" };
    }
    if (expectedRevision !== currentRevision) {
      return {
        ok: false,
        statusCode: 409,
        code: "CONFIG_INFERENCE_BINDING_REVISION_CONFLICT",
        error: `实际值已在其它目录或设备更新（当前 rev ${currentRevision}），请刷新后重试`,
        current: discovered,
      };
    }
  }

  let actualValue = normalizedValue.actualValue;
  const sensitivity = knowledgeValueSensitivity(actualValue);
  if (!sensitivity.safeForShared) {
    return {
      ok: false,
      statusCode: 400,
      code: sensitivity.secret ? "KNOWLEDGE_SHARED_SECRET_REJECTED" : "KNOWLEDGE_SHARED_MACHINE_PATH_REJECTED",
      error: sensitivity.secret
        ? "共享 value 禁止保存 token、Cookie、密码或 secret"
        : "共享 value 禁止保存本机绝对路径；请使用 node/user scope 的本机 revision",
    };
  }
  if (field === "repositoryId") {
    const canonical = configInferenceRepositoryBindingTarget(cfg, discovered.targets?.[0] || {}, actualValue);
    if (!canonical.ok) return canonical;
    actualValue = canonical.actualValue;
  }
  const currentActualValue = String(stored?.actualValue ?? discovered.actualValue ?? "").trim();
  if (actualValue === currentActualValue) {
    return {
      ok: true,
      idempotent: true,
      data: { ...discovered, actualValue, resolved: true, revision: currentRevision },
      affected: {
        references: Number(discovered.referenceCount || 0),
        samples: Number(discovered.sampleCount || 0),
        targets: Number(discovered.targetCount || 0),
      },
      configurationUpdates: { changed: false },
    };
  }

  const now = Date.now();
  const revision = currentRevision + 1;
  const valueRevisionId = `${knowledgeKey.keyId}:project:${encodeURIComponent(pid)}:r${revision}`;
  const lifecycleAt = new Date(now).toISOString();
  const operator = String(input.reviewer || "").trim();
  const valueRevisions = [
    ...(Array.isArray(stored?.valueRevisions) ? stored.valueRevisions : []).map((row) => (
      row?.keyId === knowledgeKey.keyId
      && row?.scope === "project"
      && String(row?.scopeId || "") === pid
      && row?.status === "active"
        ? {
          ...row,
          status: "retired",
          statusReason: `由 ${valueRevisionId} 替代`,
          retiredAt: lifecycleAt,
          retiredBy: operator,
          updatedAt: lifecycleAt,
          updatedBy: operator,
          lifecycleRevision: Math.max(0, Math.trunc(Number(row.lifecycleRevision) || 0)) + 1,
        }
        : row
    )),
    {
      id: valueRevisionId,
      keyId: knowledgeKey.keyId,
      scope: "project",
      scopeId: pid,
      actualValue,
      revision,
      parentRevision: currentRevision,
      lifecycleRevision: 2,
      status: "active",
      storage: "shared",
      reason: String(input.reason || "legacy_admin_replace").trim().slice(0, 2000),
      createdAt: lifecycleAt,
      createdBy: operator,
      approvedAt: lifecycleAt,
      approvedBy: operator,
      activatedAt: lifecycleAt,
      activatedBy: operator,
      sensitivity,
    },
  ].slice(-500);
  const bindingRow = {
    ...(stored || {}),
    id: logicalKey,
    logicalKey,
    keyId: knowledgeKey.keyId,
    canonicalKey: knowledgeKey.canonicalKey,
    aliases: knowledgeKey.aliases,
    valueType: knowledgeKey.valueType,
    scopePolicy: knowledgeKey.scopePolicy,
    status: "active",
    scope: "project",
    scopeId: pid,
    dimension: field,
    actualValue,
    defaultValue: String(stored?.defaultValue ?? discovered.defaultValue ?? discovered.actualValue ?? "").trim(),
    sourceValue: String(stored?.sourceValue ?? discovered.sourceValue ?? discovered.defaultValue ?? discovered.actualValue ?? "").trim(),
    scopeKey: String(stored?.scopeKey ?? discovered.scopeKey ?? "").trim(),
    label: String(stored?.label ?? discovered.label ?? logicalKey).trim(),
    resolved: true,
    revision,
    history: [
      ...(Array.isArray(stored?.history) ? stored.history : []),
      {
        revision,
        previousActualValue: currentActualValue,
        actualValue,
        reviewer: String(input.reviewer || "").trim(),
        updatedAt: now,
        source: "rag_binding_replace",
      },
    ].slice(-20),
    updatedBy: String(input.reviewer || "").trim(),
    createdAt: Number(stored?.createdAt || 0) || now,
    updatedAt: Math.max(now, Number(stored?.updatedAt || 0) + 1),
    valueRevisions,
    activeValueRevision: revision,
    activeValueRevisionId: valueRevisionId,
    effectiveScope: "project",
    effectiveScopeId: pid,
  };
  const proposedBindings = { ...root.valueBindings, [logicalKey]: bindingRow };
  let references = configInferenceBindingReferences(pid, root, logicalKey, proposedBindings);
  const positiveReferences = references.filter((reference) => reference.source.scope === "sample" || reference.source.scope === "run");
  let configurationUpdates = { changed: false };
  const configOps = [];
  let configurationGuard = { projectDefs: [], vehicles: [] };

  if (input.persistConfig === true && positiveReferences.length) {
    // 单个 logicalKey 可能属于 dependency。写回时必须保留其所在样本/run 的完整工程图，
    // 否则单独校验 dependency 会因缺少主工程而失败，也会丢失角色和父仓库关系。
    const sourceGroups = new Map();
    for (const reference of positiveReferences) {
      const sourceKey = `${reference.source.scope}:${reference.source.id}`;
      if (!sourceGroups.has(sourceKey)) sourceGroups.set(sourceKey, reference.source);
    }
    const seenGraphs = new Set();
    for (const source of sourceGroups.values()) {
      let sourceTargets = bindConfigInferenceTargets(source.targets, {
        projectId: pid,
        valueBindings: proposedBindings,
      });
      if (field === "repositoryId") {
        const canonicalTargets = [];
        for (const sourceTarget of sourceTargets) {
          if (sourceTarget.fieldBindings?.repositoryId?.logicalKey !== logicalKey) {
            canonicalTargets.push(sourceTarget);
            continue;
          }
          const canonical = configInferenceRepositoryBindingTarget(cfg, sourceTarget, normalizedValue.actualValue);
          if (!canonical.ok) return canonical;
          canonicalTargets.push(canonical.target);
          actualValue = canonical.actualValue;
        }
        sourceTargets = canonicalTargets;
        bindingRow.actualValue = actualValue;
        bindingRow.history[bindingRow.history.length - 1].actualValue = actualValue;
        bindingRow.valueRevisions[bindingRow.valueRevisions.length - 1].actualValue = actualValue;
        proposedBindings[logicalKey] = bindingRow;
      }
      const graphKey = stableJsonText(sourceTargets.map((target) => ({
        ...Object.fromEntries(CONFIG_INFERENCE_DIMENSIONS.map((dimension) => [
          dimension,
          target.fieldBindings?.[dimension]?.logicalKey || target[dimension],
        ])),
        projectType: target.projectType,
        targetRole: target.targetRole,
        repositoryOnly: target.repositoryOnly === true,
        order: target.order,
      })));
      if (seenGraphs.has(graphKey)) continue;
      seenGraphs.add(graphKey);
      const prepared = prepareConfigInferenceTargetWriteback(cfg, pid, sourceTargets, sourceTargets);
      if (!prepared.ok) {
        return { ok: false, error: `实际值可用于 RAG，但同步工程配置失败：${prepared.error}` };
      }
      const preparedBindingTarget = prepared.targets?.find((target) => (
        target.fieldBindings?.[field]?.logicalKey === logicalKey
      ));
      if (field === "repositoryId" && preparedBindingTarget?.repositoryId) {
        actualValue = preparedBindingTarget.repositoryId;
        bindingRow.actualValue = actualValue;
        bindingRow.history[bindingRow.history.length - 1].actualValue = actualValue;
        bindingRow.valueRevisions[bindingRow.valueRevisions.length - 1].actualValue = actualValue;
        proposedBindings[logicalKey] = bindingRow;
      }
      configOps.push(...(prepared.ops || []));
      configurationGuard = mergeConfigInferenceConfigurationGuards(configurationGuard, prepared.configurationGuard);
      configurationUpdates = mergeConfigInferenceConfigurationUpdates(configurationUpdates, prepared.configurationUpdates);
    }
  }

  root.valueBindings[logicalKey] = bindingRow;
  const bindingOp = {
    type: "byProject.set",
    projectId: pid,
    path: ["aiTraining", "configInference", "valueBindings", logicalKey],
    value: bindingRow,
  };
  try {
    writeSharedOps(cfg, [...configOps, bindingOp], {
      guard: (latest) => {
        const configGuard = guardConfigInferenceConfigurationWrite(latest, pid, configurationGuard);
        if (configGuard !== true) return configGuard;
        const latestBinding = configInferenceSharedRoot(latest, pid).valueBindings?.[logicalKey];
        const latestRevision = Math.max(0, Math.trunc(Number(latestBinding?.revision) || 0));
        return latestRevision === currentRevision
          ? true
          : `RAG 永久 Key ${logicalKey} 已由其它 Gateway 更新`;
      },
    });
  } catch (error) {
    if (error?.code === "SHARED_WRITE_CONFLICT") {
      const latestCfg = loadRawConfig();
      const latestRoot = configInferenceRoot(latestCfg, pid);
      const latestStoredBinding = latestRoot.valueBindings?.[logicalKey];
      const latestStoredRevision = Math.max(0, Math.trunc(Number(latestStoredBinding?.revision) || 0));
      if (latestStoredRevision === currentRevision && Number(input.__sharedRetry || 0) < 2) {
        return updateConfigInferenceValueBinding(pid, logicalKey, {
          ...input,
          __sharedRetry: Number(input.__sharedRetry || 0) + 1,
        });
      }
      const latestRegistry = configInferenceRegistrySnapshot(pid);
      const current = configInferenceValueBindingCatalog(pid, latestRoot, latestRegistry)
        .find((row) => row.logicalKey === logicalKey) || null;
      return {
        ok: false,
        statusCode: 409,
        code: "CONFIG_INFERENCE_BINDING_REVISION_CONFLICT",
        error: `实际值已在其它目录或设备更新（当前 rev ${Number(current?.revision || 0)}），请刷新后重试`,
        current,
      };
    }
    throw error;
  }

  references = configInferenceBindingReferences(pid, root, logicalKey);
  const affectedSamples = new Set(references
    .filter((reference) => String(reference.source.scope || "").startsWith("sample"))
    .map((reference) => reference.source.id));
  const affectedTargets = new Set(references.map((reference) => stableJsonText({
    source: `${reference.source.scope}:${reference.source.id}`,
    targetId: reference.target.targetId,
    repositoryId: reference.target.repositoryId,
    targetRole: reference.target.targetRole,
  })));
  const refreshedRegistry = configurationUpdates.changed ? configInferenceRegistrySnapshot(pid) : registry;
  const refreshed = configInferenceValueBindingCatalog(pid, root, refreshedRegistry)
    .find((row) => row.logicalKey === logicalKey) || { ...bindingRow, field };
  return {
    ok: true,
    data: refreshed,
    binding: refreshed,
    previousActualValue: currentActualValue,
    affected: {
      references: references.length,
      samples: affectedSamples.size,
      targets: affectedTargets.size,
    },
    configurationUpdates,
  };
}

function configInferenceKnowledgeEntry(projectId, keyIdInput) {
  const pid = explicitConfigInferenceProjectId(projectId);
  if (!pid) return { ok: false, statusCode: 400, error: "knowledge key 必须指定有效 TB 项目" };
  const keyId = String(keyIdInput || "").trim();
  if (!safeSharedSegment(keyId)) return { ok: false, statusCode: 400, error: "knowledge keyId 无效" };
  const cfg = loadRawConfig();
  const root = configInferenceRoot(cfg, pid);
  const registry = configInferenceRegistrySnapshot(pid);
  const catalog = configInferenceValueBindingCatalog(pid, root, registry);
  const item = catalog.find((row) => row.keyId === keyId || row.logicalKey === keyId);
  if (!item) return { ok: false, statusCode: 404, error: "knowledge key 不存在" };
  const logicalKey = item.logicalKey;
  const stored = isPlainObject(root.valueBindings[logicalKey]) ? root.valueBindings[logicalKey] : {};
  const key = configInferenceKnowledgeKeyDefinition(logicalKey, item.dimension, { ...item, ...stored });
  return { ok: true, pid, cfg, root, registry, catalog, item, logicalKey, stored, key };
}

function configInferenceKnowledgeBindingRow(entry) {
  const { item, stored, key, logicalKey } = entry;
  const itemScope = String(item.effectiveScope || item.scope || "").trim().toLowerCase();
  const storedScope = String(stored.effectiveScope || stored.scope || "").trim().toLowerCase();
  const localEffective = ["node", "user"].includes(itemScope)
    || ["node", "user"].includes(storedScope);
  const storedActualValue = ["node", "user"].includes(storedScope)
    ? ""
    : configInferenceSafeSharedScalar(stored.actualValue ?? "");
  const sharedActualValue = storedActualValue
    || (localEffective ? "" : configInferenceSafeSharedScalar(item.actualValue ?? ""));
  const row = {
    ...stored,
    id: logicalKey,
    logicalKey,
    keyId: key.keyId,
    canonicalKey: key.canonicalKey,
    aliases: key.aliases,
    dimension: item.dimension,
    valueType: key.valueType,
    scopePolicy: key.scopePolicy,
    ownerTeam: key.ownerTeam,
    sensitivity: key.sensitivity,
    status: key.status,
    actualValue: sharedActualValue,
    defaultValue: configInferenceSafeSharedScalar(stored.defaultValue ?? item.defaultValue ?? ""),
    sourceValue: configInferenceSafeSharedScalar(stored.sourceValue ?? item.sourceValue ?? ""),
    label: stored.label || item.label || logicalKey,
    resolved: stored.resolved !== false,
    revision: Math.max(0, Math.trunc(Number(stored.revision ?? item.revision) || 0)),
    valueRevisions: Array.isArray(stored.valueRevisions) ? cloneJson(stored.valueRevisions) : [],
    createdAt: Number(stored.createdAt || 0) || Date.now(),
    updatedAt: Number(stored.updatedAt || 0) || 0,
  };
  if (localEffective) {
    delete row.effectiveScope;
    delete row.effectiveScopeId;
    delete row.activeValueRevision;
    delete row.activeValueRevisionId;
    row.resolved = !!sharedActualValue;
  }
  return row;
}

function configInferenceKnowledgeScope(input = {}, pid = "") {
  const scope = String(input.scope || "project").trim().toLowerCase();
  const defaultScopeId = scope === "project"
    ? pid
    : scope === "node"
      ? (nodeIdSafe() || `device:${machineStorageId()}`)
      : scope === "user"
        ? configUserKey()
        : "";
  return {
    scope,
    scopeId: scope === "global" ? "" : String(input.scopeId || defaultScopeId).trim(),
  };
}

function saveConfigInferenceKnowledgeBinding(entry, bindingRow, {
  expectedStored = entry.stored,
  localRevisions = null,
} = {}) {
  const { cfg, pid, logicalKey } = entry;
  bindingRow.updatedAt = Math.max(Date.now(), Number(bindingRow.updatedAt || 0) + 1);
  const op = {
    type: "byProject.set",
    projectId: pid,
    path: ["aiTraining", "configInference", "valueBindings", logicalKey],
    value: bindingRow,
  };
  try {
    writeSharedOps(cfg, op, {
      guard: (latest) => {
        const latestStored = configInferenceSharedRoot(latest, pid).valueBindings?.[logicalKey];
        return stableJsonText(latestStored || {}) === stableJsonText(expectedStored || {})
          ? true
          : `knowledge key ${entry.key.keyId} 已由其它 Gateway 更新`;
      },
    });
  } catch (error) {
    if (error?.code === "SHARED_WRITE_CONFLICT") {
      return {
        ok: false,
        statusCode: 409,
        code: "KNOWLEDGE_VALUE_REVISION_CONFLICT",
        error: error.message || "knowledge value 已由其它 Gateway 更新",
      };
    }
    throw error;
  }
  if (localRevisions) saveLocalKnowledgeValueRevisions(localRevisions);
  return { ok: true };
}

function configInferenceKnowledgePublicRow(projectId, root, row) {
  const key = configInferenceKnowledgeKeyDefinition(row.logicalKey, row.dimension, row);
  const revisions = configInferenceKnowledgeRevisions(row, key.keyId);
  const resolution = configInferenceKnowledgeResolution(projectId, key, revisions);
  return {
    keyId: key.keyId,
    logicalKey: row.logicalKey,
    canonicalKey: key.canonicalKey,
    aliases: key.aliases,
    dimension: key.dimension,
    valueType: key.valueType,
    scopePolicy: key.scopePolicy,
    ownerTeam: key.ownerTeam,
    sensitivity: key.sensitivity,
    status: key.status,
    defaultValue: row.defaultValue ?? "",
    effective: resolution,
    revision: Math.max(0, Math.trunc(Number(row.revision) || 0)),
    revisions: revisions.map((revision) => ({
      ...revision,
      sensitivity: revision.sensitivity || knowledgeValueSensitivity(revision.actualValue),
    })),
    updatedAt: row.updatedAt || 0,
    updatedBy: row.updatedBy || "",
  };
}

export function listConfigInferenceKnowledgeKeys(projectId) {
  const pid = explicitConfigInferenceProjectId(projectId);
  if (!pid) return { ok: false, statusCode: 400, error: "knowledge keys 必须指定有效 TB 项目" };
  const cfg = loadRawConfig();
  const root = configInferenceRoot(cfg, pid);
  const registry = configInferenceRegistrySnapshot(pid);
  const catalog = configInferenceValueBindingCatalog(pid, root, registry);
  const keys = catalog.map((item) => {
    const stored = isPlainObject(root.valueBindings[item.logicalKey]) ? root.valueBindings[item.logicalKey] : {};
    return configInferenceKnowledgePublicRow(pid, root, configInferenceKnowledgeBindingRow({
      item,
      stored,
      key: configInferenceKnowledgeKeyDefinition(item.logicalKey, item.dimension, { ...item, ...stored }),
      logicalKey: item.logicalKey,
    }));
  });
  return { ok: true, data: keys };
}

export function createConfigInferenceKnowledgeRevision(projectId, keyId, input = {}) {
  const entry = configInferenceKnowledgeEntry(projectId, keyId);
  if (!entry.ok) return entry;
  const bindingRow = configInferenceKnowledgeBindingRow(entry);
  const { scope, scopeId } = configInferenceKnowledgeScope(input, entry.pid);
  const allRevisions = configInferenceKnowledgeRevisions(bindingRow, entry.key.keyId);
  let revision;
  try {
    const normalized = configInferenceBindingActualValue(bindingRow.dimension, input.actualValue ?? input.value);
    if (!normalized.ok) return normalized;
    revision = createKnowledgeValueRevision(entry.key, allRevisions, {
      ...input,
      scope,
      scopeId,
      actualValue: normalized.actualValue,
    }, {
      operator: String(input.operator || input.reviewer || "").trim(),
    });
  } catch (error) {
    return { ok: false, statusCode: error.statusCode || 400, code: error.code, error: error.message };
  }
  let localRevisions = null;
  if (revision.storage === "local") {
    localRevisions = loadLocalKnowledgeValueRevisions();
    localRevisions.push(revision);
  } else {
    bindingRow.valueRevisions = [...bindingRow.valueRevisions, revision].slice(-500);
  }
  bindingRow.updatedBy = String(input.operator || input.reviewer || "").trim();
  const saved = saveConfigInferenceKnowledgeBinding(entry, bindingRow, { localRevisions });
  if (!saved.ok) return saved;
  return { ok: true, data: revision };
}

function transitionConfigInferenceKnowledgeRevision(projectId, keyId, revisionId, action, input = {}) {
  const entry = configInferenceKnowledgeEntry(projectId, keyId);
  if (!entry.ok) return entry;
  const bindingRow = configInferenceKnowledgeBindingRow(entry);
  const shared = Array.isArray(bindingRow.valueRevisions) ? bindingRow.valueRevisions : [];
  const local = loadLocalKnowledgeValueRevisions();
  const all = [...shared, ...local];
  const current = all.find((row) => String(row.id || "") === String(revisionId || "")
    && String(row.keyId || "") === entry.key.keyId);
  if (!current) return { ok: false, statusCode: 404, error: "knowledge value revision 不存在" };
  if (!CONFIG_INFERENCE_KNOWLEDGE_REVISION_STATUSES.has(String(current.status || ""))) {
    return { ok: false, statusCode: 409, error: `knowledge value revision 状态无效：${current.status || "unknown"}` };
  }
  const lifecycleRevision = Math.max(0, Math.trunc(Number(current.lifecycleRevision) || 0));
  if (input.expectedRevision !== undefined && Number(input.expectedRevision) !== lifecycleRevision) {
    return {
      ok: false,
      statusCode: 409,
      code: "KNOWLEDGE_VALUE_REVISION_CONFLICT",
      error: `knowledge value revision 已更新，当前 lifecycleRevision=${lifecycleRevision}`,
      current,
    };
  }
  const operator = String(input.operator || input.reviewer || "").trim();
  let updatedRows;
  try {
    if (action === "approve") {
      updatedRows = all.map((row) => row.id === current.id
        ? {
          ...transitionKnowledgeValueRevision(row, "approved", { operator, reason: input.reason }),
          lifecycleRevision: lifecycleRevision + 1,
        }
        : row);
    } else if (action === "activate") {
      updatedRows = activateKnowledgeValueRevision(all, current.id, {
        operator,
        reason: input.reason,
      }).map((row) => {
        const before = all.find((item) => item.id === row.id);
        return before && before.status !== row.status
          ? { ...row, lifecycleRevision: Math.max(0, Math.trunc(Number(before.lifecycleRevision) || 0)) + 1 }
          : row;
      });
    } else {
      return { ok: false, statusCode: 400, error: "不支持的 knowledge revision 操作" };
    }
  } catch (error) {
    return { ok: false, statusCode: error.statusCode || 409, code: error.code, error: error.message };
  }
  bindingRow.valueRevisions = updatedRows.filter((row) => row.storage !== "local");
  const localRevisions = updatedRows.filter((row) => row.storage === "local");
  const resolution = configInferenceKnowledgeResolution(entry.pid, entry.key, updatedRows);
  if (resolution.resolved && resolution.revisionId && resolution.storage !== "local") {
    const previousEffectiveId = String(bindingRow.activeValueRevisionId || "");
    bindingRow.actualValue = resolution.actualValue;
    bindingRow.resolved = true;
    bindingRow.activeValueRevision = resolution.revision;
    bindingRow.activeValueRevisionId = resolution.revisionId;
    bindingRow.effectiveScope = resolution.scope;
    bindingRow.effectiveScopeId = resolution.scopeId;
    if (previousEffectiveId !== resolution.revisionId) {
      bindingRow.revision = Math.max(0, Math.trunc(Number(bindingRow.revision) || 0)) + 1;
    }
  }
  bindingRow.updatedBy = operator;
  const saved = saveConfigInferenceKnowledgeBinding(entry, bindingRow, { localRevisions });
  if (!saved.ok) return saved;
  return {
    ok: true,
    action,
    data: updatedRows.find((row) => row.id === current.id),
    effective: resolution,
  };
}

export function approveConfigInferenceKnowledgeRevision(projectId, keyId, revisionId, input = {}) {
  return transitionConfigInferenceKnowledgeRevision(projectId, keyId, revisionId, "approve", input);
}

export function activateConfigInferenceKnowledgeRevision(projectId, keyId, revisionId, input = {}) {
  return transitionConfigInferenceKnowledgeRevision(projectId, keyId, revisionId, "activate", input);
}

export function rollbackConfigInferenceKnowledgeRevision(projectId, keyId, input = {}) {
  const entry = configInferenceKnowledgeEntry(projectId, keyId);
  if (!entry.ok) return entry;
  const bindingRow = configInferenceKnowledgeBindingRow(entry);
  const all = configInferenceKnowledgeRevisions(bindingRow, entry.key.keyId);
  const { scope, scopeId } = configInferenceKnowledgeScope(input, entry.pid);
  const operator = String(input.operator || input.reviewer || "").trim();
  let updatedRows;
  try {
    updatedRows = rollbackKnowledgeValueRevision(all, {
      keyId: entry.key.keyId,
      scope,
      scopeId,
      targetRevision: input.targetRevision,
      operator,
      reason: input.reason,
    }).map((row) => {
      const before = all.find((item) => item.id === row.id);
      return before && before.status !== row.status
        ? { ...row, lifecycleRevision: Math.max(0, Math.trunc(Number(before.lifecycleRevision) || 0)) + 1 }
        : row;
    });
  } catch (error) {
    return { ok: false, statusCode: error.statusCode || 409, code: error.code, error: error.message };
  }
  bindingRow.valueRevisions = updatedRows.filter((row) => row.storage !== "local");
  const localRevisions = updatedRows.filter((row) => row.storage === "local");
  const resolution = configInferenceKnowledgeResolution(entry.pid, entry.key, updatedRows);
  const previousEffectiveId = String(bindingRow.activeValueRevisionId || "");
  if (resolution.resolved && resolution.revisionId && resolution.storage !== "local") {
    bindingRow.actualValue = resolution.actualValue;
    bindingRow.resolved = true;
    bindingRow.activeValueRevision = resolution.revision;
    bindingRow.activeValueRevisionId = resolution.revisionId;
    bindingRow.effectiveScope = resolution.scope;
    bindingRow.effectiveScopeId = resolution.scopeId;
    if (previousEffectiveId !== resolution.revisionId) {
      bindingRow.revision = Math.max(0, Math.trunc(Number(bindingRow.revision) || 0)) + 1;
    }
  }
  bindingRow.rollback = {
    targetRevision: Number(input.targetRevision),
    scope,
    scopeId,
    reason: String(input.reason || "").trim().slice(0, 2000),
    operator,
    at: Date.now(),
  };
  bindingRow.updatedBy = operator;
  const saved = saveConfigInferenceKnowledgeBinding(entry, bindingRow, { localRevisions });
  if (!saved.ok) return saved;
  return { ok: true, data: bindingRow.rollback, effective: resolution };
}

function configInferenceKnowledgeEntryByRevision(projectId, revisionId) {
  const pid = explicitConfigInferenceProjectId(projectId);
  if (!pid) return { ok: false, statusCode: 400, error: "knowledge value 必须指定有效 TB 项目" };
  const listed = listConfigInferenceKnowledgeKeys(pid);
  if (!listed.ok) return listed;
  const valueId = String(revisionId || "").trim();
  const key = listed.data.find((row) => row.revisions.some((revision) => revision.id === valueId));
  if (!key) return { ok: false, statusCode: 404, error: "knowledge value revision 不存在" };
  const revision = key.revisions.find((row) => row.id === valueId);
  return { ok: true, pid, key, revision };
}

export function approveConfigInferenceKnowledgeValue(projectId, revisionId, input = {}) {
  const found = configInferenceKnowledgeEntryByRevision(projectId, revisionId);
  if (!found.ok) return found;
  return approveConfigInferenceKnowledgeRevision(found.pid, found.key.keyId, revisionId, input);
}

export function activateConfigInferenceKnowledgeValue(projectId, revisionId, input = {}) {
  const found = configInferenceKnowledgeEntryByRevision(projectId, revisionId);
  if (!found.ok) return found;
  return activateConfigInferenceKnowledgeRevision(found.pid, found.key.keyId, revisionId, input);
}

export function rollbackConfigInferenceKnowledgeValue(projectId, revisionId, input = {}) {
  const found = configInferenceKnowledgeEntryByRevision(projectId, revisionId);
  if (!found.ok) return found;
  const targetId = String(input.targetRevisionId || "").trim();
  const target = targetId
    ? found.key.revisions.find((row) => row.id === targetId)
    : found.revision;
  if (!target) return { ok: false, statusCode: 404, error: "rollback 目标 revision 不存在" };
  return rollbackConfigInferenceKnowledgeRevision(found.pid, found.key.keyId, {
    ...input,
    scope: target.scope,
    scopeId: target.scopeId,
    targetRevision: target.revision,
  });
}

export function getConfigInferenceKnowledgeValueImpact(projectId, revisionId) {
  const found = configInferenceKnowledgeEntryByRevision(projectId, revisionId);
  if (!found.ok) return found;
  return getConfigInferenceKnowledgeImpact(found.pid, found.key.keyId);
}

export function listConfigInferenceMachineBindings(projectId) {
  const pid = explicitConfigInferenceProjectId(projectId);
  if (!pid) return { ok: false, statusCode: 400, error: "machine bindings 必须指定有效 TB 项目" };
  const nodeScopeId = nodeIdSafe() || `device:${machineStorageId()}`;
  const listed = listConfigInferenceKnowledgeKeys(pid);
  if (!listed.ok) return listed;
  const data = listed.data.flatMap((key) => key.revisions
    .filter((revision) => revision.scope === "node" && revision.scopeId === nodeScopeId)
    .map((revision) => ({
      ...revision,
      keyId: key.keyId,
      logicalKey: key.logicalKey,
      dimension: key.dimension,
      effective: key.effective?.revisionId === revision.id,
    })));
  return { ok: true, data };
}

export function upsertConfigInferenceMachineBinding(projectId, keyId, input = {}) {
  const pid = explicitConfigInferenceProjectId(projectId);
  const operator = String(input.operator || input.reviewer || "").trim();
  const created = createConfigInferenceKnowledgeRevision(pid, keyId, {
    ...input,
    scope: "node",
    scopeId: nodeIdSafe() || `device:${machineStorageId()}`,
    operator,
    reviewer: operator,
  });
  if (!created.ok) return created;
  const approved = approveConfigInferenceKnowledgeRevision(pid, keyId, created.data.id, {
    operator,
    reviewer: operator,
    reason: input.reason,
  });
  if (!approved.ok) return { ...approved, draft: created.data };
  const activated = activateConfigInferenceKnowledgeRevision(pid, keyId, created.data.id, {
    operator,
    reviewer: operator,
    reason: input.reason,
  });
  return activated.ok
    ? { ...activated, binding: activated.data }
    : { ...activated, draft: created.data, approved: approved.data };
}

function configInferenceKnowledgeImpact(projectId, keyId, { root = null } = {}) {
  const pid = explicitConfigInferenceProjectId(projectId);
  const empty = {
    keyId,
    revisions: 0,
    activeRevisions: 0,
    sampleCount: 0,
    activeRunCount: 0,
    affectedIds: { samples: [], runs: [] },
  };
  if (!pid) return empty;
  const effectiveRoot = root || configInferenceRoot(loadRawConfig(), pid);
  const registry = configInferenceRegistrySnapshot(pid);
  const item = configInferenceValueBindingCatalog(pid, effectiveRoot, registry)
    .find((row) => row.keyId === keyId || row.logicalKey === keyId);
  if (!item) return empty;
  const references = configInferenceBindingReferences(pid, effectiveRoot, item.logicalKey);
  const sampleReferences = references
    .filter((row) => String(row.source.scope || "").startsWith("sample"))
    .map((row) => ({ id: row.source.id, keyId: item.keyId }));
  const activeRuns = references
    .filter((row) => row.source.scope === "run")
    .map((row) => ({ id: row.source.id, keyId: item.keyId }));
  const stored = isPlainObject(effectiveRoot.valueBindings[item.logicalKey])
    ? effectiveRoot.valueBindings[item.logicalKey]
    : {};
  return {
    ...knowledgeValueImpact(configInferenceKnowledgeRevisions(stored, item.keyId), {
      keyId: item.keyId,
      sampleReferences,
      activeRuns,
    }),
    logicalKey: item.logicalKey,
    targets: item.targets || [],
    referenceCount: references.length,
  };
}

export function getConfigInferenceKnowledgeImpact(projectId, keyId) {
  const entry = configInferenceKnowledgeEntry(projectId, keyId);
  if (!entry.ok) return entry;
  return {
    ok: true,
    data: configInferenceKnowledgeImpact(entry.pid, entry.key.keyId, { root: entry.root }),
  };
}

export function getConfigInferenceGovernanceSummary(projectId) {
  const pid = explicitConfigInferenceProjectId(projectId);
  if (!pid) return { ok: false, statusCode: 400, error: "governance summary 必须指定有效 TB 项目" };
  const cfg = loadRawConfig();
  const root = configInferenceRoot(cfg, pid);
  const registry = configInferenceRegistrySnapshot(pid);
  const metrics = configInferenceMetrics(root, registry);
  const allSamples = configInferenceAllSamples(root);
  const prioritized = prioritizeConfigInferenceCases(
    configInferenceRows(root.runs).filter((row) => !row.review),
    { excludeReviewed: false, excludeClaimed: false },
  );
  const keywordSuggestions = configInferenceRows(root.keywordSuggestions);
  return {
    ok: true,
    data: {
      projectId: pid,
      generatedAt: new Date().toISOString(),
      serving: {
        approved: metrics.approvedServingSamples,
        pending: allSamples.filter((row) => configInferenceSampleServingStatus(row) === "pending").length,
        revoked: metrics.revokedServingSamples,
        superseded: allSamples.filter((row) => configInferenceSampleServingStatus(row) === "superseded").length,
      },
      annotations: {
        total: metrics.annotations,
        pending: metrics.pendingAnnotations,
        approvalPolicy: {
          mode: "two_reviewer_consensus",
          requiredDistinctReviewers: 2,
          dualReviewerQuorumEnabled: true,
          sameReviewerCannotSatisfyQuorum: true,
        },
      },
      observations: {
        total: metrics.actualExecutionSamples,
        approved: metrics.approvedExecutionSamples,
        pending: allSamples.filter((row) => row.recordType === "observation"
          && configInferenceSampleServingStatus(row) === "pending").length,
      },
      activeLearning: {
        candidates: prioritized.length,
        top: prioritized.slice(0, 20).map((row) => ({
          id: row.id,
          priority: row.activeLearning?.priority || 0,
          reasons: row.activeLearning?.reasons || [],
          incompleteSources: row.activeLearning?.incompleteSources || [],
        })),
      },
      keywordSuggestions: {
        total: keywordSuggestions.length,
        pending: keywordSuggestions.filter((row) => row.status === "pending").length,
      },
      stalePendingRuns: metrics.stalePendingRuns,
      knowledgeKeys: configInferenceValueBindingCatalog(pid, root, registry).length,
      sourceCoverageBlocked: configInferenceRows(root.runs).filter((row) => (
        row.sourceCoverageGate?.applicable === true && row.sourceCoverageGate?.complete !== true
      )).length,
    },
  };
}

function configInferenceGovernanceWriteIdentity(input = {}, action = "治理操作") {
  const operator = String(input.operator || input.reviewer || input.actor || "").trim().slice(0, 200);
  const reason = sanitizeSharedTrainingText(input.reason, 4000);
  if (!operator) return { ok: false, statusCode: 403, error: `${action} 必须记录稳定 operator ID` };
  if (!reason) return { ok: false, statusCode: 400, error: `${action} 必须填写 reason` };
  return { ok: true, operator, reason };
}

function configInferenceIsoTime(value) {
  const numeric = Number(value);
  const date = Number.isFinite(numeric) && numeric > 0
    ? new Date(numeric)
    : new Date(String(value || ""));
  return Number.isFinite(date.getTime()) ? date.toISOString() : "";
}

function configInferenceDatasetCaseFromApprovedSample(root, ref = {}, index = 0) {
  const sampleId = String(ref.sampleId || ref.annotationId || ref.id || "").trim();
  const sample = root.samples?.[sampleId];
  if (!sample || configInferenceSampleServingStatus(sample) !== "approved") {
    return { ok: false, statusCode: 409, error: `Golden Set case ${sampleId || index + 1} 不是已双审批准的 serving annotation` };
  }
  if (sample?.approvedLabel?.status !== "approved" || sample?.approvedLabel?.servingEligible !== true) {
    return { ok: false, statusCode: 409, error: `Golden Set case ${sampleId} 缺少不可变 approved label` };
  }
  const reviewerIds = [...new Set((sample.approvedLabel.reviewerIds || []).map((value) => String(value || "").trim()).filter(Boolean))];
  if (reviewerIds.length < 2) {
    return { ok: false, statusCode: 409, error: `Golden Set case ${sampleId} 未满足两个独立 reviewer` };
  }
  const run = sample.sourceRunId ? root.runs?.[sample.sourceRunId] : null;
  if (!run?.prediction || !run?.ticket) {
    return { ok: false, statusCode: 409, error: `Golden Set case ${sampleId} 缺少冻结 inference run` };
  }
  const inferenceAt = configInferenceIsoTime(run.ticket.snapshotAt || run.createdAt);
  if (!inferenceAt) {
    return { ok: false, statusCode: 409, error: `Golden Set case ${sampleId} 缺少真实 inferenceAt，禁止用当前时间补齐` };
  }
  const label = cloneJson(sample.approvedLabel.label || {});
  const detailEvidence = {
    sourceType: "detail",
    sourceId: String(run.ticket.ticketId || run.ticket.tbTaskId || run.id || sampleId),
    span: "ticket_snapshot",
    availableAt: inferenceAt,
    extractorVersion: "source-coverage-snapshot-v1",
    contentHash: configInferenceDigest({
      title: run.ticket.title || "",
      description: run.ticket.description || run.ticket.note || "",
      projectId: run.ticket.projectId || run.ticket.tbProjectId || "",
      tasklistId: run.ticket.tasklistId || "",
      iterationName: run.ticket.iterationName || "",
    }),
  };
  const extractedEvidence = (Array.isArray(run.prediction.structuredEvidence)
    ? run.prediction.structuredEvidence
    : [])
    .filter((item) => {
      const availableAt = Date.parse(String(item?.availableAt || ""));
      return Number.isFinite(availableAt) && availableAt <= Date.parse(inferenceAt);
    })
    .slice(0, 500)
    .map((item) => ({
      sourceType: String(item.sourceType || "structured"),
      sourceId: String(item.sourceId || item.id || ""),
      span: cloneJson(item.span || ""),
      availableAt: String(item.availableAt),
      extractorVersion: String(item.extractorVersion || ""),
      contentHash: configInferenceDigest({
        kind: item.kind || "",
        value: item.value || "",
        negated: item.negated === true,
        sourceType: item.sourceType || "",
        sourceId: item.sourceId || "",
        span: item.span || null,
      }),
    }));
  return {
    ok: true,
    data: {
      id: sampleId,
      caseId: String(sample.approvedLabel.caseId || sample.annotation?.caseId || sample.sourceRunId || sampleId),
      groupId: String(ref.groupId || run.ticket.incidentId || run.ticket.ticketId || run.ticket.tbTaskId || sampleId),
      projectId: String(run.projectId || sample.projectId || ""),
      inferenceAt,
      sourceCoverage: cloneJson(run.ticket.sourceCoverage || {}),
      requiredSources: ["detail"],
      evidence: [detailEvidence, ...extractedEvidence],
      approvedLabel: {
        status: "approved",
        ...label,
        approvalFingerprint: sample.approvedLabel.fingerprint,
        reviewerIds,
        sourceAnnotationIds: cloneJson(sample.approvedLabel.sourceAnnotationIds || []),
      },
      ticket: cloneJson(run.ticket),
      provenance: {
        sampleId,
        runId: String(run.id || ""),
        sourcePredictionFingerprint: configInferenceDigest(run.prediction),
        approvedLabelId: String(sample.approvedLabel.id || ""),
        approvedAt: String(sample.approvedLabel.approvedAt || ""),
        registryRevision: String(sample.approvedLabel.registryRevision || ""),
        rulesVersion: String(sample.approvedLabel.rulesVersion || ""),
      },
      slices: cloneJson(ref.slices || {}),
    },
  };
}

function configInferenceCandidateTrainingMaterial(projectId, dataset) {
  if (!isPlainObject(dataset)
    || String(dataset.evaluationMode || "") !== "candidate_replay_v1"
    || dataset.validation?.ok !== true) {
    return { ok: false, reason: "candidate_dataset_invalid" };
  }
  const sourceDatasetHash = String(dataset.hash || "");
  if (!sourceDatasetHash || configInferenceDatasetHash(dataset) !== sourceDatasetHash) {
    return { ok: false, reason: "candidate_dataset_hash_mismatch" };
  }
  const snapshot = dataset.candidateSnapshot;
  if (!isPlainObject(snapshot)
    || String(snapshot.projectId || "") !== String(projectId || "")
    || String(snapshot.rulesVersion || "") !== String(dataset.rulesVersion || "")
    || String(snapshot.featureSchemaVersion || "") !== String(dataset.featureSchemaVersion || "")) {
    return { ok: false, reason: "candidate_snapshot_invalid" };
  }
  const rows = (Array.isArray(dataset.cases) ? dataset.cases : [])
    .filter((row) => String(row.split || "").toLowerCase() === "train");
  const cases = [];
  const samples = [];
  for (const row of rows) {
    const label = isPlainObject(row.approvedLabel) ? row.approvedLabel : {};
    const approvalFingerprint = String(
      label.approvalFingerprint
      || label.fingerprint
      || row.provenance?.approvedLabelFingerprint
      || "",
    ).trim();
    if (!String(row.id || "").trim() || !approvalFingerprint) {
      return { ok: false, reason: "candidate_train_label_fingerprint_missing" };
    }
    const noTargets = label.noTargets === true
      || ["insufficient", "ticket_wrong", "not_applicable", "no_target"]
        .includes(String(label.decision || "").toLowerCase());
    cases.push({
      id: String(row.id),
      approvalFingerprint,
    });
    samples.push({
      id: `golden_train:${row.id}`,
      projectId,
      source: "golden_train",
      ticket: cloneJson(row.ticket || {}),
      signals: extractConfigInferenceSignals(row.ticket || {}, snapshot.keywordMappings || {}),
      groundTruth: {
        targets: noTargets ? [] : cloneJson(label.targets || label.correctedPrediction?.targets || []),
        noTargets,
      },
      feedback: {
        decision: String(label.decision || (noTargets ? "insufficient" : "correct")).toLowerCase(),
        score: 5,
      },
      serving: { status: "approved" },
      createdAt: Date.parse(String(row.inferenceAt || "")) || 0,
      updatedAt: Date.parse(String(row.inferenceAt || "")) || 0,
    });
  }
  cases.sort((left, right) => left.id.localeCompare(right.id));
  const descriptor = {
    schemaVersion: "config-inference-artifact-training-v1",
    sourceDatasetHash,
    candidateSnapshotHash: configInferenceDigest(snapshot),
    trainingCaseIds: cases.map((row) => row.id),
    approvedLabelFingerprints: cases.map((row) => row.approvalFingerprint),
    materialHash: configInferenceDigest({ snapshot, cases }),
    trainingSplitOnly: true,
  };
  return {
    ok: true,
    descriptor,
    samples,
    snapshot: cloneJson(snapshot),
  };
}

function configInferenceReleaseState(projectId, root, registry = null) {
  const effectiveRegistry = registry || configInferenceRegistrySnapshot(projectId);
  const revisions = configInferenceRevisionSnapshot(effectiveRegistry, root);
  const bundle = resolveConfigInferenceServingBundle({
    projectId,
    releases: configInferenceRows(root.releases),
    artifacts: configInferenceRows(root.artifacts),
    currentRevisionSnapshot: revisions,
    currentFeatureSchemaVersion: CONFIG_INFERENCE_FEATURE_SCHEMA_VERSION,
  });
  if (bundle.status !== "active") return bundle;
  const release = root.releases?.[bundle.releaseId];
  const candidate = configInferenceReleaseCandidate(projectId, root, effectiveRegistry, release);
  if (candidate.ok) return bundle;
  return {
    ...bundle,
    status: "blocked_artifact_invalid",
    calibrator: null,
    gateEnforced: true,
    effectiveAutoExecution: false,
    humanConfirmationOnly: true,
    reasons: [...new Set([...(bundle.reasons || []), candidate.reason || "candidate_training_invalid"])],
  };
}

function configInferenceReleaseCandidate(projectId, root, registry, release) {
  if (!release || String(release.projectId || "") !== String(projectId || "")) {
    return { ok: false, reason: "release_project_mismatch" };
  }
  const artifact = root.artifacts?.[release.artifactId];
  if (!artifact || String(artifact.projectId || "") !== String(projectId || "")) {
    return { ok: false, reason: "artifact_project_mismatch" };
  }
  const revisions = configInferenceRevisionSnapshot(registry, root);
  const current = {
    registryRevision: revisions.registryRevision,
    keywordRevision: revisions.keywordRevision,
    servingSampleRevision: revisions.servingSampleRevision,
    knowledgeValueSetRevision: revisions.valueRevision,
    rulesVersion: revisions.rulesRevision,
    featureSchemaVersion: CONFIG_INFERENCE_FEATURE_SCHEMA_VERSION,
  };
  const staleFields = [
    "registryRevision",
    "keywordRevision",
    "servingSampleRevision",
    "knowledgeValueSetRevision",
    "rulesVersion",
    "featureSchemaVersion",
  ].filter((field) => String(artifact[field] || "") !== String(current[field] || ""));
  if (staleFields.length) {
    return { ok: false, reason: `artifact_revision_stale:${staleFields.join(",")}` };
  }
  const ranker = String(artifact.ranker?.method || artifact.ranker?.artifactType || "").toLowerCase();
  if (!["heuristic", "config-inference-heuristic"].includes(ranker)) {
    return { ok: false, reason: "artifact_ranker_unsupported" };
  }
  const dataset = root.datasets?.[artifact.datasetId];
  const training = configInferenceCandidateTrainingMaterial(projectId, dataset);
  if (!training.ok) return { ok: false, reason: training.reason };
  if (String(dataset.hash || "") !== String(artifact.datasetHash || "")) {
    return { ok: false, reason: "artifact_dataset_hash_mismatch" };
  }
  if (stableJsonText(artifact.candidateTraining || {}) !== stableJsonText(training.descriptor)) {
    return { ok: false, reason: "artifact_candidate_training_mismatch" };
  }
  return { ok: true, release, artifact, dataset, training };
}

function configInferenceStagedReleaseCandidate(projectId, root, registry) {
  const staged = configInferenceRows(root.releases)
    .filter((row) => ["shadow", "canary"].includes(String(row.status || "").toLowerCase()));
  if (staged.length !== 1) return null;
  const candidate = configInferenceReleaseCandidate(projectId, root, registry, staged[0]);
  return candidate.ok ? candidate : null;
}

function configInferenceServingSamples(projectId, root, registry, servingRelease, fallbackSamples) {
  if (servingRelease?.status !== "active") return fallbackSamples;
  const release = root.releases?.[servingRelease.releaseId];
  const candidate = configInferenceReleaseCandidate(projectId, root, registry, release);
  return candidate.ok ? candidate.training.samples : fallbackSamples;
}

function configInferenceBuildReleaseTrial(projectId, root, registry, ticket) {
  const staged = configInferenceStagedReleaseCandidate(projectId, root, registry);
  if (!staged) return null;
  const ticketId = String(ticket?.ticketId || ticket?.tbTaskId || "").trim();
  const trafficPercent = Math.max(0, Math.min(100, Number(staged.release.trafficPercent || 0)));
  const samplingPercent = staged.release.status === "shadow" ? 100 : trafficPercent;
  const bucket = parseInt(configInferenceDigest(`${staged.release.id}|${ticketId || stableJsonText(ticket)}`).slice(0, 8), 16) % 100;
  const selected = staged.release.status === "shadow" || bucket < samplingPercent;
  if (!selected) {
    return {
      releaseId: staged.release.id,
      artifactId: staged.artifact.id,
      stage: staged.release.status,
      trafficPercent,
      samplingPercent,
      selected: false,
      capturedAt: Date.now(),
    };
  }
  const candidate = inferConfigFromTicket({
    projectId,
    ticket,
    projectDefs: cloneJson(staged.training.snapshot.projectDefs || []),
    vehicleMap: cloneJson(staged.training.snapshot.vehicleMap || {}),
    keywordMappings: cloneJson(staged.training.snapshot.keywordMappings || {}),
    samples: staged.training.samples,
    valueBindings: cloneJson(staged.training.snapshot.valueBindings || {}),
    calibrator: staged.artifact.calibrator?.status === "fitted"
      ? staged.artifact.calibrator
      : null,
  });
  return {
    releaseId: staged.release.id,
    artifactId: staged.artifact.id,
    stage: staged.release.status,
    trafficPercent,
    samplingPercent,
    selected: true,
    sourceDatasetHash: staged.training.descriptor.sourceDatasetHash,
    candidateTrainingHash: staged.training.descriptor.materialHash,
    candidatePrediction: configInferencePersistedPrediction(projectId, root, candidate),
    capturedAt: Date.now(),
  };
}

function configInferenceReleaseGraphFingerprint(prediction = {}) {
  const targets = orderConfigInferenceTargets(normalizeConfigInferenceTargets(prediction?.targets || []));
  return configInferenceDigest({
    noTargets: targets.length === 0 && prediction?.noTargets === true,
    targets: configInferencePredictionReviewIdentity({
      status: "",
      targets,
      missingInformation: [],
    }).targets,
  });
}

function configInferenceReleaseOnlineGate(release, { now = Date.now() } = {}) {
  const stage = String(release?.status || "").toLowerCase();
  const policy = isPlainObject(release?.rolloutPolicy) ? release.rolloutPolicy : {};
  const approvedVehicles = [...new Set((Array.isArray(policy.approvedVehicles)
    ? policy.approvedVehicles
    : []).map((value) => String(value || "").trim()).filter(Boolean))].sort();
  const stageStartedAt = Number(policy.stageStartedAt || 0);
  const trafficPercent = Number(release?.trafficPercent || 0);
  const minCases = stage === "shadow"
    ? CONFIG_INFERENCE_SHADOW_MIN_CASES
    : stage === "canary"
      ? CONFIG_INFERENCE_CANARY_MIN_CASES
      : 0;
  const minDurationMs = stage === "shadow"
    ? CONFIG_INFERENCE_SHADOW_MIN_DURATION_MS
    : stage === "canary"
      ? CONFIG_INFERENCE_CANARY_MIN_DURATION_MS
      : 0;
  const matching = (Array.isArray(release?.onlineObservations) ? release.onlineObservations : [])
    .filter((row) => (
      row?.schemaVersion === "config-inference-release-observation-v1"
      && row.releaseId === release.id
      && row.stage === stage
      && Number(row.trafficPercent || 0) === trafficPercent
      && Number(row.observedAt || 0) >= stageStartedAt
      && Number(row.observedAt || 0) <= now
    ))
    .sort((left, right) => Number(left.observedAt || 0) - Number(right.observedAt || 0));
  const selectedRows = matching.filter((row) => row.selected === true);
  const missingCaseFingerprints = selectedRows.filter((row) => !String(row.caseFingerprint || "").trim()).length;
  const byCase = new Map();
  selectedRows.forEach((row) => {
    const fingerprint = String(row.caseFingerprint || "").trim();
    if (fingerprint) byCase.set(fingerprint, row);
  });
  // 同一 TB 单即使被重复创建多个 run，也只能贡献一个在线样本。
  const selected = [...byCase.values()];
  const invalidApprovalProofs = selected.filter((row) => (
    row.eligible === true
    && (
      !String(row.approvedLabelFingerprint || "").trim()
      || new Set((Array.isArray(row.reviewerIds) ? row.reviewerIds : [])
        .map((value) => String(value || "").trim())
        .filter(Boolean)).size < 2
    )
  )).length;
  const eligible = selected.filter((row) => (
    row.eligible === true
    && !!String(row.approvedLabelFingerprint || "").trim()
    && new Set((Array.isArray(row.reviewerIds) ? row.reviewerIds : [])
      .map((value) => String(value || "").trim())
      .filter(Boolean)).size >= 2
  ));
  const latestObservedAt = selected.reduce(
    (max, row) => Math.max(max, Number(row.observedAt || 0)),
    0,
  );
  const observedDurationMs = stageStartedAt && latestObservedAt
    ? Math.max(0, latestObservedAt - stageStartedAt)
    : 0;
  const coveredVehicles = [...new Set(eligible.flatMap((row) => (
    Array.isArray(row.vehicles) ? row.vehicles : []
  )).map((value) => String(value || "").trim()).filter(Boolean))].sort();
  const uncoveredVehicles = approvedVehicles.filter((vehicle) => !coveredVehicles.includes(vehicle));
  const baselineCorrect = eligible.filter((row) => row.baselineExact === true).length;
  const candidateCorrect = eligible.filter((row) => row.candidateExact === true).length;
  const baselineExactRate = eligible.length ? baselineCorrect / eligible.length : null;
  const candidateExactRate = eligible.length ? candidateCorrect / eligible.length : null;
  const regressions = selected.filter((row) => row.regressed === true).length;
  const sourcePolicyViolations = selected.filter((row) => row.sourcePolicyViolation === true).length;
  const vehiclePolicyViolations = selected.filter((row) => row.vehiclePolicyViolation === true).length;
  const reasons = [
    ...(!["shadow", "canary"].includes(stage) ? ["online_stage_invalid"] : []),
    ...(!stageStartedAt || policy.stage !== stage || Number(policy.trafficPercent || 0) !== trafficPercent
      ? ["stage_policy_missing"] : []),
    ...(!approvedVehicles.length ? ["approved_vehicle_policy_missing"] : []),
    ...(missingCaseFingerprints ? ["observation_case_fingerprint_missing"] : []),
    ...(invalidApprovalProofs ? ["observation_approval_proof_invalid"] : []),
    ...(eligible.length < minCases ? ["online_sample_insufficient"] : []),
    ...(observedDurationMs < minDurationMs ? ["online_duration_insufficient"] : []),
    ...uncoveredVehicles.map((vehicle) => `approved_vehicle_uncovered:${vehicle}`),
    ...(regressions ? ["candidate_regression"] : []),
    ...(sourcePolicyViolations ? ["source_policy_violation"] : []),
    ...(vehiclePolicyViolations ? ["vehicle_policy_violation"] : []),
    ...(candidateExactRate != null
      && baselineExactRate != null
      && candidateExactRate < baselineExactRate
      ? ["candidate_accuracy_below_baseline"] : []),
  ];
  return {
    schemaVersion: "config-inference-online-gate-v1",
    ready: reasons.length === 0,
    stage,
    trafficPercent,
    approvedVehicles,
    coveredVehicles,
    uncoveredVehicles,
    stageStartedAt,
    latestObservedAt,
    observedDurationMs,
    minDurationMs,
    selectedCases: selected.length,
    duplicateCases: Math.max(0, selectedRows.length - missingCaseFingerprints - selected.length),
    missingCaseFingerprints,
    invalidApprovalProofs,
    eligibleCases: eligible.length,
    minCases,
    baselineExactRate: baselineExactRate == null ? null : Number(baselineExactRate.toFixed(6)),
    candidateExactRate: candidateExactRate == null ? null : Number(candidateExactRate.toFixed(6)),
    regressions,
    sourcePolicyViolations,
    vehiclePolicyViolations,
    reasons: [...new Set(reasons)],
    evaluatedAt: now,
  };
}

export function __testEvaluateConfigInferenceOnlineReleaseGate(release, options = {}) {
  return cloneJson(configInferenceReleaseOnlineGate(release, options));
}

function configInferenceReleaseObservation(root, run, {
  sample,
  servingRevisionChanged = false,
  now = Date.now(),
} = {}) {
  const trial = isPlainObject(run?.releaseTrial) ? run.releaseTrial : null;
  if (!trial?.selected || !isPlainObject(trial.candidatePrediction)) return null;
  const release = root.releases?.[trial.releaseId];
  if (!release
    || !["shadow", "canary"].includes(String(release.status || "").toLowerCase())
    || release.artifactId !== trial.artifactId
    || release.status !== trial.stage
    || Number(release.trafficPercent || 0) !== Number(trial.trafficPercent || 0)
    || String(trial.sourceDatasetHash || "") !== String(root.artifacts?.[trial.artifactId]?.candidateTraining?.sourceDatasetHash || "")
    || String(trial.candidateTrainingHash || "") !== String(root.artifacts?.[trial.artifactId]?.candidateTraining?.materialHash || "")) {
    return null;
  }
  const approvedLabel = isPlainObject(sample?.approvedLabel) ? sample.approvedLabel : null;
  const reviewerIds = [...new Set((approvedLabel?.reviewerIds || [])
    .map((value) => String(value || "").trim())
    .filter(Boolean))].sort();
  const label = isPlainObject(approvedLabel?.label) ? approvedLabel.label : {};
  const decision = String(label.decision || "").toLowerCase();
  const targets = cloneJson(label.targets || []);
  const noTargets = label.noTargets === true
    || ["insufficient", "ticket_wrong", "not_applicable", "no_target"].includes(decision);
  const caseFingerprint = String(
    run.caseFingerprint
    || configInferenceCaseFingerprint(run.projectId, run.ticket),
  ).trim();
  const eligible = approvedLabel?.status === "approved"
    && approvedLabel?.servingEligible === true
    && !!approvedLabel?.fingerprint
    && reviewerIds.length >= 2
    && !!caseFingerprint;
  const expectedPrediction = {
    targets: eligible ? cloneJson(targets || []) : [],
    noTargets: eligible && noTargets === true,
  };
  const baselineExact = eligible
    && configInferenceReleaseGraphFingerprint(run.prediction)
      === configInferenceReleaseGraphFingerprint(expectedPrediction);
  const candidateExact = eligible
    && configInferenceReleaseGraphFingerprint(trial.candidatePrediction)
      === configInferenceReleaseGraphFingerprint(expectedPrediction);
  const sourceGate = run.sourceCoverageGate || configInferenceSourceCoverageGate(run.ticket || {});
  const candidateTargets = normalizeConfigInferenceTargets(trial.candidatePrediction.targets || []);
  const approvedVehicles = new Set((release.rolloutPolicy?.approvedVehicles || [])
    .map((value) => String(value || "").trim())
    .filter(Boolean));
  const expectedVehicles = [...new Set(normalizeConfigInferenceTargets(targets || [])
    .map((target) => String(target.vehicle || "").trim())
    .filter(Boolean))];
  const vehiclePolicyViolation = candidateTargets.length > 0
    && candidateTargets.some((target) => {
      const vehicle = String(target.vehicle || "").trim();
      return !vehicle || !approvedVehicles.has(vehicle);
    });
  const sourcePolicyViolation = sourceGate.applicable === true
    && sourceGate.complete !== true
    && candidateTargets.length > 0;
  const regressed = eligible && baselineExact && !candidateExact;
  const observation = {
    schemaVersion: "config-inference-release-observation-v1",
    id: `RO_${configInferenceDigest(`${release.id}|${release.status}|${release.trafficPercent}|${caseFingerprint || run.id}`)}`,
    releaseId: release.id,
    artifactId: release.artifactId,
    runId: run.id,
    caseFingerprint,
    ticketFingerprint: caseFingerprint,
    annotationId: String(sample?.annotation?.id || sample?.id || ""),
    approvedLabelFingerprint: String(approvedLabel?.fingerprint || ""),
    reviewerIds,
    stage: release.status,
    trafficPercent: Number(release.trafficPercent || 0),
    selected: true,
    eligible,
    baselineExact,
    candidateExact,
    regressed,
    sourceComplete: sourceGate.complete === true,
    sourcePolicyViolation,
    vehiclePolicyViolation,
    servingRevisionChanged: servingRevisionChanged === true,
    vehicles: expectedVehicles.filter((vehicle) => approvedVehicles.has(vehicle)).sort(),
    expectedGraphFingerprint: eligible
      ? configInferenceReleaseGraphFingerprint(expectedPrediction)
      : "",
    baselineGraphFingerprint: configInferenceReleaseGraphFingerprint(run.prediction),
    candidateGraphFingerprint: configInferenceReleaseGraphFingerprint(trial.candidatePrediction),
    capturedAt: Number(trial.capturedAt || 0),
    observedAt: now,
  };
  const expected = {
    status: release.status,
    trafficPercent: Number(release.trafficPercent || 0),
    historyLength: Array.isArray(release.history) ? release.history.length : 0,
    observationCount: Array.isArray(release.onlineObservations) ? release.onlineObservations.length : 0,
    updatedAt: Number(release.updatedAt || 0),
  };
  const observations = [
    ...(Array.isArray(release.onlineObservations) ? release.onlineObservations : [])
      .filter((row) => row.id !== observation.id),
    observation,
  ].slice(-5000);
  const safetyReasons = [
    ...(regressed ? ["candidate_regression"] : []),
    ...(sourcePolicyViolation ? ["source_policy_violation"] : []),
    ...(vehiclePolicyViolation ? ["vehicle_policy_violation"] : []),
    ...(servingRevisionChanged ? ["serving_revision_changed"] : []),
  ];
  let updatedRelease;
  if (safetyReasons.length) {
    const retired = transitionConfigInferenceRelease(release, "retired", {
      operator: "system:config-inference-safety",
      reason: `online_safety_stop:${safetyReasons.join(",")}`,
      now,
    });
    updatedRelease = {
      ...cloneJson(retired),
      onlineObservations: observations,
      onlineGate: configInferenceReleaseOnlineGate({
        ...retired,
        onlineObservations: observations,
      }, { now }),
      safetyStop: {
        reasons: safetyReasons,
        observationId: observation.id,
        stoppedAt: now,
      },
      updatedAt: now,
    };
  } else {
    updatedRelease = {
      ...cloneJson(release),
      onlineObservations: observations,
      onlineGate: configInferenceReleaseOnlineGate({
        ...release,
        onlineObservations: observations,
      }, { now }),
      updatedAt: now,
      updatedBy: "system:config-inference-observer",
    };
  }
  return { observation, release: updatedRelease, expected };
}

function guardConfigInferenceServingRevisionSnapshot(latest, projectId, expected, fallbackRegistry) {
  const latestRoot = configInferenceSharedRoot(latest, projectId);
  const latestRegistry = configInferenceRegistrySnapshotFromShared(latest, projectId, fallbackRegistry);
  const latestMemories = Array.isArray(latest?.byProject?.[projectId]?.configMemory)
    ? latest.byProject[projectId].configMemory
    : [];
  const current = configInferenceRevisionSnapshot(latestRegistry, latestRoot, {
    legacyMemories: latestMemories,
  });
  const fields = [
    "rulesRevision",
    "registryRevision",
    "keywordRevision",
    "valueRevision",
    "servingSampleRevision",
  ];
  const changed = fields.filter((field) => String(current[field] || "") !== String(expected?.[field] || ""));
  return changed.length ? `release 输入版本已变化：${changed.join(",")}` : true;
}

function configInferenceCandidateValueBindings(root) {
  return Object.fromEntries(Object.entries(isPlainObject(root?.valueBindings) ? root.valueBindings : {})
    .flatMap(([logicalKey, value]) => {
      if (!safeSharedSegment(logicalKey) || !isPlainObject(value)) return [];
      const scope = String(value.effectiveScope || value.scope || "").trim().toLowerCase();
      const local = ["node", "user"].includes(scope);
      const actualValue = local ? "" : configInferenceSafeSharedScalar(value.actualValue);
      const defaultValue = configInferenceSafeSharedScalar(value.defaultValue);
      const sourceValue = configInferenceSafeSharedScalar(value.sourceValue);
      return [[logicalKey, {
        logicalKey,
        dimension: String(value.dimension || "").trim(),
        ...(actualValue ? { actualValue } : {}),
        ...(defaultValue ? { defaultValue } : {}),
        ...(sourceValue ? { sourceValue } : {}),
        revision: Math.max(0, Math.trunc(Number(value.revision) || 0)),
      }]];
    }));
}

export function createConfigInferenceDataset(projectId, input = {}) {
  const pid = explicitConfigInferenceProjectId(projectId);
  if (!pid) return { ok: false, statusCode: 400, error: "Golden Set 必须指定有效 TB 项目" };
  const identity = configInferenceGovernanceWriteIdentity(input, "Golden Set 创建");
  if (!identity.ok) return identity;
  const refs = Array.isArray(input.caseRefs) ? input.caseRefs : [];
  if (!refs.length || refs.length > 5000) {
    return { ok: false, statusCode: 400, error: "Golden Set 必须引用 1~5000 个已批准 annotation" };
  }
  const cfg = loadRawConfig();
  const root = configInferenceRoot(cfg, pid);
  const registry = configInferenceRegistrySnapshot(pid);
  const resolvedCases = [];
  for (const [index, ref] of refs.entries()) {
    const resolved = configInferenceDatasetCaseFromApprovedSample(root, ref, index);
    if (!resolved.ok) return resolved;
    if (resolved.data.projectId && resolved.data.projectId !== pid) {
      return { ok: false, statusCode: 409, error: `Golden Set case ${resolved.data.id} 属于其它 TB 项目` };
    }
    resolvedCases.push(resolved.data);
  }
  const revisions = configInferenceRevisionSnapshot(registry, root);
  const cases = splitConfigInferenceCasesByTime(resolvedCases);
  const dataset = createConfigInferenceDatasetVersion({
    datasetVersion: String(input.datasetVersion || "").trim().slice(0, 160),
    registryRevision: revisions.registryRevision,
    keywordRevision: revisions.keywordRevision,
    servingSampleRevision: revisions.servingSampleRevision,
    rulesVersion: revisions.rulesRevision,
    featureSchemaVersion: CONFIG_INFERENCE_FEATURE_SCHEMA_VERSION,
    knowledgeValueSetRevision: revisions.valueRevision,
    evaluationMode: "candidate_replay_v1",
    candidateSnapshot: {
      schemaVersion: "config-inference-candidate-snapshot-v1",
      projectId: pid,
      projectDefs: cloneJson(registry.projectDefs),
      vehicleMap: cloneJson(registry.vehicleMap),
      keywordMappings: cloneJson(registry.keywordMappings),
      valueBindings: configInferenceCandidateValueBindings(root),
      rulesVersion: revisions.rulesRevision,
      featureSchemaVersion: CONFIG_INFERENCE_FEATURE_SCHEMA_VERSION,
    },
    requiredSources: ["detail"],
    cases,
  });
  if (!dataset.validation.ok) {
    return {
      ok: false,
      statusCode: 422,
      code: "CONFIG_INFERENCE_DATASET_INVALID",
      error: "Golden Set 来源、时间或标签校验未通过",
      validation: cloneJson(dataset.validation),
    };
  }
  const id = storyTrainingId("DS_");
  const now = Date.now();
  const row = {
    ...cloneJson(dataset),
    id,
    projectId: pid,
    reason: identity.reason,
    createdBy: identity.operator,
    createdAtMs: now,
    updatedAt: now,
  };
  root.datasets[id] = row;
  try {
    writeSharedOps(cfg, {
      type: "byProject.set",
      projectId: pid,
      path: ["aiTraining", "configInference", "datasets", id],
      value: row,
    }, {
      guard: (latest) => !configInferenceSharedRoot(latest, pid).datasets?.[id] || "Golden Set ID 已存在",
    });
  } catch (error) {
    if (error?.code === "SHARED_WRITE_CONFLICT") {
      return { ok: false, statusCode: 409, error: error.message || "Golden Set 并发写入冲突" };
    }
    throw error;
  }
  return {
    ok: true,
    data: cloneJson(row),
  };
}

function configInferenceCandidateReplayDataset(projectId, dataset) {
  if (String(dataset?.evaluationMode || "") !== "candidate_replay_v1") {
    return {
      ok: false,
      statusCode: 409,
      code: "CONFIG_INFERENCE_CANDIDATE_REPLAY_REQUIRED",
      error: "发布评测必须使用 candidate_replay_v1 冻结输入重推理",
    };
  }
  if (dataset?.validation?.ok !== true) {
    return {
      ok: false,
      statusCode: 422,
      code: "CONFIG_INFERENCE_DATASET_INVALID",
      error: "Golden Set 校验未通过，不能执行候选版本重推理",
    };
  }
  const training = configInferenceCandidateTrainingMaterial(projectId, dataset);
  if (!training.ok) {
    return {
      ok: false,
      statusCode: 409,
      code: "CONFIG_INFERENCE_CANDIDATE_SNAPSHOT_INVALID",
      error: `候选版本训练快照无效：${training.reason}`,
    };
  }
  const snapshot = training.snapshot;
  const rows = Array.isArray(dataset.cases) ? dataset.cases : [];
  const trainingSamples = training.samples;
  const replayedCases = rows.map((row) => {
    const prediction = inferConfigFromTicket({
      projectId,
      ticket: cloneJson(row.ticket || {}),
      projectDefs: cloneJson(snapshot.projectDefs || []),
      vehicleMap: cloneJson(snapshot.vehicleMap || {}),
      keywordMappings: cloneJson(snapshot.keywordMappings || {}),
      samples: trainingSamples,
      valueBindings: cloneJson(snapshot.valueBindings || {}),
    });
    return {
      ...cloneJson(row),
      prediction: configInferenceSharedPredictionValue(prediction, new Map()),
    };
  });
  return {
    ok: true,
    data: {
      ...cloneJson(dataset),
      evaluationMode: "candidate_replay_result_v1",
      cases: replayedCases,
      candidateReplay: {
        schemaVersion: "config-inference-candidate-replay-v1",
        sourceDatasetHash: String(dataset.hash || ""),
        predictor: "inferConfigFromTicket",
        rulesVersion: String(snapshot.rulesVersion || ""),
        featureSchemaVersion: String(snapshot.featureSchemaVersion || ""),
        trainingSplitOnly: true,
        trainingSampleCount: trainingSamples.length,
        trainingMaterialHash: training.descriptor.materialHash,
        replayedCaseCount: replayedCases.length,
      },
    },
  };
}

export function evaluateConfigInferenceDatasetRelease(projectId, input = {}) {
  const pid = explicitConfigInferenceProjectId(projectId);
  if (!pid) return { ok: false, statusCode: 400, error: "离线评测必须指定有效 TB 项目" };
  const identity = configInferenceGovernanceWriteIdentity(input, "离线评测");
  if (!identity.ok) return identity;
  const datasetId = String(input.datasetId || "").trim();
  const split = String(input.split || "test").trim().toLowerCase();
  if (!["test", "shadow"].includes(split)) {
    return { ok: false, statusCode: 400, error: "发布评测只允许 test 或 shadow split" };
  }
  const cfg = loadRawConfig();
  const root = configInferenceRoot(cfg, pid);
  const dataset = root.datasets?.[datasetId];
  if (!dataset) return { ok: false, statusCode: 404, error: "Golden Set 不存在" };
  const replay = configInferenceCandidateReplayDataset(pid, dataset);
  if (!replay.ok) return replay;
  const report = prepareConfigInferenceReleaseEvaluation(replay.data, {
    split,
    bootstrapIterations: 200,
  });
  const id = storyTrainingId("EVAL_");
  const now = Date.now();
  const row = {
    ...cloneJson(report),
    id,
    projectId: pid,
    datasetId,
    evaluationMode: "candidate_replay_v1",
    candidateReplay: cloneJson(replay.data.candidateReplay),
    reason: identity.reason,
    createdBy: identity.operator,
    createdAtMs: now,
    updatedAt: now,
  };
  root.evaluations[id] = row;
  try {
    writeSharedOps(cfg, {
      type: "byProject.set",
      projectId: pid,
      path: ["aiTraining", "configInference", "evaluations", id],
      value: row,
    }, {
      guard: (latest) => !configInferenceSharedRoot(latest, pid).evaluations?.[id] || "evaluation ID 已存在",
    });
  } catch (error) {
    if (error?.code === "SHARED_WRITE_CONFLICT") {
      return { ok: false, statusCode: 409, error: error.message || "evaluation 并发写入冲突" };
    }
    throw error;
  }
  return { ok: true, data: cloneJson(row) };
}

export function createConfigInferenceServingRelease(projectId, input = {}) {
  const pid = explicitConfigInferenceProjectId(projectId);
  if (!pid) return { ok: false, statusCode: 400, error: "serving release 必须指定有效 TB 项目" };
  const identity = configInferenceGovernanceWriteIdentity(input, "serving release 创建");
  if (!identity.ok) return identity;
  const datasetId = String(input.datasetId || "").trim();
  const evaluationId = String(input.evaluationId || "").trim();
  const cfg = loadRawConfig();
  const root = configInferenceRoot(cfg, pid);
  const dataset = root.datasets?.[datasetId];
  const evaluation = root.evaluations?.[evaluationId];
  if (!dataset) return { ok: false, statusCode: 404, error: "Golden Set 不存在" };
  if (!evaluation || evaluation.datasetId !== datasetId) {
    return { ok: false, statusCode: 409, error: "evaluation 与 Golden Set 不匹配" };
  }
  const replay = configInferenceCandidateReplayDataset(pid, dataset);
  if (!replay.ok) return replay;
  let bundle;
  try {
    bundle = createConfigInferenceReleaseBundle({
      projectId: pid,
      dataset,
      evaluation,
      evaluationDataset: replay.data,
      operator: identity.operator,
      artifactIdFactory: () => storyTrainingId("ART_"),
      releaseIdFactory: () => storyTrainingId("REL_"),
    });
  } catch (error) {
    return {
      ok: false,
      statusCode: 409,
      code: error?.code || "CONFIG_INFERENCE_RELEASE_INVALID",
      error: error?.message || "serving release 创建失败",
      validation: error?.validation || undefined,
    };
  }
  const now = Date.now();
  const candidateTraining = configInferenceCandidateTrainingMaterial(pid, dataset);
  if (!candidateTraining.ok) {
    return {
      ok: false,
      statusCode: 409,
      code: "CONFIG_INFERENCE_CANDIDATE_TRAINING_INVALID",
      error: `serving artifact 训练快照无效：${candidateTraining.reason}`,
    };
  }
  const artifact = {
    ...cloneJson(bundle.artifact),
    datasetId,
    evaluationId,
    candidateTraining: cloneJson(candidateTraining.descriptor),
    createdAtMs: now,
    updatedAt: now,
  };
  const release = {
    ...cloneJson(bundle.release),
    datasetId,
    evaluationId,
    reason: identity.reason,
    createdAtMs: now,
    updatedAt: now,
  };
  root.artifacts[artifact.id] = artifact;
  root.releases[release.id] = release;
  try {
    writeSharedOps(cfg, [
      {
        type: "byProject.set",
        projectId: pid,
        path: ["aiTraining", "configInference", "artifacts", artifact.id],
        value: artifact,
      },
      {
        type: "byProject.set",
        projectId: pid,
        path: ["aiTraining", "configInference", "releases", release.id],
        value: release,
      },
    ], {
      guard: (latest) => {
        const latestRoot = configInferenceSharedRoot(latest, pid);
        if (latestRoot.artifacts?.[artifact.id] || latestRoot.releases?.[release.id]) {
          return "artifact/release ID 已存在";
        }
        return true;
      },
    });
  } catch (error) {
    if (error?.code === "SHARED_WRITE_CONFLICT") {
      return { ok: false, statusCode: 409, error: error.message || "serving release 并发写入冲突" };
    }
    throw error;
  }
  return {
    ok: true,
    data: {
      artifact: cloneJson(artifact),
      release: cloneJson(release),
    },
  };
}

export function transitionConfigInferenceServingRelease(projectId, releaseId, input = {}) {
  const pid = explicitConfigInferenceProjectId(projectId);
  const id = String(releaseId || "").trim();
  if (!pid || !id) return { ok: false, statusCode: 400, error: "release transition 缺少项目或 releaseId" };
  const identity = configInferenceGovernanceWriteIdentity(input, "release transition");
  if (!identity.ok) return identity;
  const nextStatus = String(input.status || "").trim().toLowerCase();
  if (!["shadow", "canary", "active", "retired"].includes(nextStatus)) {
    return { ok: false, statusCode: 400, error: "release transition 状态无效" };
  }
  const cfg = loadRawConfig();
  const root = configInferenceRoot(cfg, pid);
  const releaseRegistry = configInferenceRegistrySnapshot(pid);
  const expectedServingRevisions = configInferenceRevisionSnapshot(releaseRegistry, root);
  const current = root.releases?.[id];
  if (!current) return { ok: false, statusCode: 404, error: "release 不存在" };
  const now = Date.now();
  const expected = {
    status: current.status,
    trafficPercent: Number(current.trafficPercent || 0),
    historyLength: Array.isArray(current.history) ? current.history.length : 0,
    observationCount: Array.isArray(current.onlineObservations) ? current.onlineObservations.length : 0,
    updatedAt: Number(current.updatedAt || 0),
  };
  if (nextStatus !== "retired") {
    const candidate = configInferenceReleaseCandidate(pid, root, releaseRegistry, current);
    if (!candidate.ok) {
      return {
        ok: false,
        statusCode: 409,
        code: "CONFIG_INFERENCE_RELEASE_STALE",
        error: `release 制品已失效：${candidate.reason}`,
      };
    }
  }
  let approvedVehicles = (current.rolloutPolicy?.approvedVehicles || [])
    .map((value) => String(value || "").trim())
    .filter(Boolean);
  let passedOnlineGate = null;
  if (nextStatus === "shadow") {
    const proposedVehicles = [...new Set((Array.isArray(input.approvedVehicles)
      ? input.approvedVehicles
      : []).map((value) => String(value || "").trim()).filter(Boolean))].sort();
    if (!proposedVehicles.length) {
      return {
        ok: false,
        statusCode: 400,
        code: "CONFIG_INFERENCE_RELEASE_SCOPE_REQUIRED",
        error: "进入 shadow 前必须明确选择至少一个已批准车型",
      };
    }
    const knownVehicles = new Set(Object.keys(releaseRegistry.vehicleMap || {}));
    const unknownVehicles = proposedVehicles.filter((vehicle) => !knownVehicles.has(vehicle));
    if (unknownVehicles.length) {
      return {
        ok: false,
        statusCode: 400,
        code: "CONFIG_INFERENCE_RELEASE_SCOPE_INVALID",
        error: `存在未注册车型：${unknownVehicles.join(",")}`,
      };
    }
    const otherStaged = configInferenceRows(root.releases)
      .find((row) => row.id !== id && ["shadow", "canary"].includes(String(row.status || "").toLowerCase()));
    if (otherStaged) {
      return {
        ok: false,
        statusCode: 409,
        code: "CONFIG_INFERENCE_RELEASE_STAGE_CONFLICT",
        error: `项目已有候选 release ${otherStaged.id} 处于 ${otherStaged.status}`,
      };
    }
    approvedVehicles = proposedVehicles;
  } else if (["canary", "active"].includes(nextStatus)) {
    passedOnlineGate = configInferenceReleaseOnlineGate(current, { now });
    if (!passedOnlineGate.ready) {
      return {
        ok: false,
        statusCode: 409,
        code: "CONFIG_INFERENCE_ONLINE_GATE_BLOCKED",
        error: `release 在线观测门禁未通过：${passedOnlineGate.reasons.join(",")}`,
        onlineGate: cloneJson(passedOnlineGate),
      };
    }
  }
  let updatedRows;
  try {
    if (nextStatus === "active") {
      updatedRows = activateConfigInferenceRelease(configInferenceRows(root.releases), id, {
        operator: identity.operator,
        reason: identity.reason,
        autoExecutionEnabled: input.autoExecutionEnabled === true,
        now,
      });
    } else {
      const transitioned = transitionConfigInferenceRelease(current, nextStatus, {
        operator: identity.operator,
        reason: identity.reason,
        trafficPercent: input.trafficPercent,
        autoExecutionEnabled: false,
        now,
      });
      updatedRows = configInferenceRows(root.releases).map((row) => row.id === id ? transitioned : row);
    }
  } catch (error) {
    return { ok: false, statusCode: 409, error: error?.message || "release transition 被门禁拒绝" };
  }
  if (nextStatus === "active") {
    const proposedServing = resolveConfigInferenceServingBundle({
      projectId: pid,
      releases: updatedRows,
      artifacts: configInferenceRows(root.artifacts),
      currentRevisionSnapshot: expectedServingRevisions,
      currentFeatureSchemaVersion: CONFIG_INFERENCE_FEATURE_SCHEMA_VERSION,
    });
    if (proposedServing.status !== "active") {
      return {
        ok: false,
        statusCode: 409,
        code: "CONFIG_INFERENCE_RELEASE_STALE",
        error: `release 当前不可激活：${proposedServing.reasons.join(",") || proposedServing.status}`,
        serving: cloneJson(proposedServing),
      };
    }
  }
  updatedRows = updatedRows.map((row) => {
    if (row.id !== id) return row;
    const updated = cloneJson(row);
    if (["shadow", "canary"].includes(nextStatus)) {
      updated.rolloutPolicy = {
        schemaVersion: "config-inference-rollout-policy-v1",
        projectId: pid,
        approvedVehicles,
        stage: nextStatus,
        trafficPercent: Number(updated.trafficPercent || 0),
        stageStartedAt: now,
      };
      if (passedOnlineGate && updated.history?.length) {
        updated.history[updated.history.length - 1].onlineGate = cloneJson(passedOnlineGate);
      }
      updated.onlineGate = configInferenceReleaseOnlineGate(updated, { now });
    } else if (nextStatus === "active") {
      updated.rolloutPolicy = {
        ...(isPlainObject(current.rolloutPolicy) ? cloneJson(current.rolloutPolicy) : {}),
        schemaVersion: "config-inference-rollout-policy-v1",
        projectId: pid,
        approvedVehicles,
        stage: "active",
        trafficPercent: 100,
        stageStartedAt: now,
      };
      if (passedOnlineGate && updated.history?.length) {
        updated.history[updated.history.length - 1].onlineGate = cloneJson(passedOnlineGate);
      }
      updated.onlineGate = cloneJson(passedOnlineGate);
    }
    return updated;
  });
  const changed = updatedRows
    .filter((row) => stableJsonText(row) !== stableJsonText(root.releases?.[row.id]))
    .map((row) => ({
      ...cloneJson(row),
      updatedAt: now,
    }));
  for (const row of changed) root.releases[row.id] = row;
  try {
    writeSharedOps(cfg, changed.map((row) => ({
      type: "byProject.set",
      projectId: pid,
      path: ["aiTraining", "configInference", "releases", row.id],
      value: row,
    })), {
      guard: (latest) => {
        const revisionGuard = guardConfigInferenceServingRevisionSnapshot(
          latest,
          pid,
          expectedServingRevisions,
          releaseRegistry,
        );
        if (revisionGuard !== true) return revisionGuard;
        const latestCurrent = configInferenceSharedRoot(latest, pid).releases?.[id];
        if (!latestCurrent) return "release 已不存在";
        if (
          latestCurrent.status !== expected.status
          || Number(latestCurrent.trafficPercent || 0) !== expected.trafficPercent
          || (Array.isArray(latestCurrent.history) ? latestCurrent.history.length : 0) !== expected.historyLength
          || (Array.isArray(latestCurrent.onlineObservations) ? latestCurrent.onlineObservations.length : 0)
            !== expected.observationCount
          || Number(latestCurrent.updatedAt || 0) !== expected.updatedAt
        ) {
          return "release 已由其它 Gateway 更新";
        }
        if (nextStatus === "active") {
          const otherActive = configInferenceRows(configInferenceSharedRoot(latest, pid).releases)
            .find((row) => row.id !== id && row.status === "active");
          if (otherActive && !changed.some((row) => row.id === otherActive.id && row.status === "retired")) {
            return "存在未纳入本次原子替换的 active release";
          }
        }
        return true;
      },
    });
  } catch (error) {
    if (error?.code === "SHARED_WRITE_CONFLICT") {
      return { ok: false, statusCode: 409, error: error.message || "release transition 并发冲突" };
    }
    throw error;
  }
  return {
    ok: true,
    data: {
      release: cloneJson(root.releases[id]),
      releases: changed.map(cloneJson),
      serving: cloneJson(configInferenceReleaseState(pid, root)),
    },
  };
}

export function rollbackConfigInferenceServingRelease(projectId, targetReleaseId, input = {}) {
  const pid = explicitConfigInferenceProjectId(projectId);
  const targetId = String(targetReleaseId || "").trim();
  if (!pid || !targetId) return { ok: false, statusCode: 400, error: "release rollback 缺少项目或目标 releaseId" };
  const identity = configInferenceGovernanceWriteIdentity(input, "release rollback");
  if (!identity.ok) return identity;
  const cfg = loadRawConfig();
  const root = configInferenceRoot(cfg, pid);
  const releaseRegistry = configInferenceRegistrySnapshot(pid);
  const expectedServingRevisions = configInferenceRevisionSnapshot(releaseRegistry, root);
  const beforeRows = configInferenceRows(root.releases);
  const expectedActiveIds = beforeRows.filter((row) => row.status === "active").map((row) => row.id).sort();
  const target = root.releases?.[targetId];
  if (!target) return { ok: false, statusCode: 404, error: "rollback 目标 release 不存在" };
  const expectedTarget = {
    status: target.status,
    historyLength: Array.isArray(target.history) ? target.history.length : 0,
    updatedAt: Number(target.updatedAt || 0),
  };
  let updatedRows;
  try {
    updatedRows = rollbackConfigInferenceRelease(beforeRows, targetId, {
      operator: identity.operator,
      reason: identity.reason,
      idFactory: () => storyTrainingId("REL_RB_"),
    });
  } catch (error) {
    return { ok: false, statusCode: 409, error: error?.message || "release rollback 被门禁拒绝" };
  }
  const proposedServing = resolveConfigInferenceServingBundle({
    projectId: pid,
    releases: updatedRows,
    artifacts: configInferenceRows(root.artifacts),
    currentRevisionSnapshot: expectedServingRevisions,
    currentFeatureSchemaVersion: CONFIG_INFERENCE_FEATURE_SCHEMA_VERSION,
  });
  if (proposedServing.status !== "active") {
    return {
      ok: false,
      statusCode: 409,
      code: "CONFIG_INFERENCE_ROLLBACK_STALE",
      error: `rollback 目标当前不可 serving：${proposedServing.reasons.join(",") || proposedServing.status}`,
      serving: cloneJson(proposedServing),
    };
  }
  const now = Date.now();
  const changed = updatedRows
    .filter((row) => stableJsonText(row) !== stableJsonText(root.releases?.[row.id]))
    .map((row) => ({ ...cloneJson(row), updatedAt: now }));
  for (const row of changed) root.releases[row.id] = row;
  try {
    writeSharedOps(cfg, changed.map((row) => ({
      type: "byProject.set",
      projectId: pid,
      path: ["aiTraining", "configInference", "releases", row.id],
      value: row,
    })), {
      guard: (latest) => {
        const revisionGuard = guardConfigInferenceServingRevisionSnapshot(
          latest,
          pid,
          expectedServingRevisions,
          releaseRegistry,
        );
        if (revisionGuard !== true) return revisionGuard;
        const latestRoot = configInferenceSharedRoot(latest, pid);
        const latestActiveIds = configInferenceRows(latestRoot.releases)
          .filter((row) => row.status === "active")
          .map((row) => row.id)
          .sort();
        if (stableJsonText(latestActiveIds) !== stableJsonText(expectedActiveIds)) {
          return "active release 已由其它 Gateway 更新";
        }
        const latestTarget = latestRoot.releases?.[targetId];
        if (
          !latestTarget
          || latestTarget.status !== expectedTarget.status
          || (Array.isArray(latestTarget.history) ? latestTarget.history.length : 0) !== expectedTarget.historyLength
          || Number(latestTarget.updatedAt || 0) !== expectedTarget.updatedAt
        ) {
          return "rollback 目标 release 已变化";
        }
        const newIds = changed.filter((row) => !latestRoot.releases?.[row.id]).map((row) => row.id);
        if (newIds.length !== 1) return "rollback 新 release 指针发生冲突";
        return true;
      },
    });
  } catch (error) {
    if (error?.code === "SHARED_WRITE_CONFLICT") {
      return { ok: false, statusCode: 409, error: error.message || "release rollback 并发冲突" };
    }
    throw error;
  }
  const restored = changed.find((row) => row.status === "active");
  return {
    ok: true,
    data: {
      release: cloneJson(restored),
      releases: changed.map(cloneJson),
      serving: cloneJson(configInferenceReleaseState(pid, root)),
    },
  };
}

export function listConfigInferenceServingReleases(projectId) {
  const pid = explicitConfigInferenceProjectId(projectId);
  if (!pid) return { ok: false, statusCode: 400, error: "release 查询必须指定有效 TB 项目" };
  const root = configInferenceRoot(loadRawConfig(), pid);
  return {
    ok: true,
    data: {
      projectId: pid,
      serving: cloneJson(configInferenceReleaseState(pid, root)),
      releases: configInferenceRows(root.releases).map(cloneJson),
      artifacts: configInferenceRows(root.artifacts).map((row) => ({
        id: row.id,
        projectId: row.projectId,
        datasetHash: row.datasetHash,
        datasetVersion: row.datasetVersion,
        rulesVersion: row.rulesVersion,
        featureSchemaVersion: row.featureSchemaVersion,
        registryRevision: row.registryRevision,
        keywordRevision: row.keywordRevision,
        servingSampleRevision: row.servingSampleRevision,
        knowledgeValueSetRevision: row.knowledgeValueSetRevision,
        ranker: cloneJson(row.ranker),
        calibrator: cloneJson(row.calibrator),
        createdAt: row.createdAt,
        createdBy: row.createdBy,
      })),
    },
  };
}

export function getConfigInferenceEvaluationSummary(projectId) {
  const governance = getConfigInferenceGovernanceSummary(projectId);
  if (!governance.ok) return governance;
  const pid = governance.data.projectId;
  const root = configInferenceRoot(loadRawConfig(), pid);
  const evaluations = configInferenceRows(root.evaluations);
  const latest = evaluations[0] || null;
  const serving = configInferenceReleaseState(pid, root);
  if (!latest) {
    return {
      ok: true,
      data: {
        projectId: pid,
        status: "not_evaluated",
        trustworthy: false,
        metrics: null,
        reason: "尚未提供冻结、双人批准且按时间隔离的 Golden Set；线上复核命中率不能替代独立评测",
        annotationQuorum: "two_reviewer_consensus",
        servingSampleCount: governance.data.serving.approved,
        pendingAnnotationCount: governance.data.annotations.pending,
        servingRelease: cloneJson(serving),
        generatedAt: governance.data.generatedAt,
      },
    };
  }
  const trustworthy = latest.validation?.ok === true
    && ["test", "shadow"].includes(String(latest.split || "").toLowerCase())
    && Number(latest.metrics?.eligible || 0) > 0;
  return {
    ok: true,
    data: {
      projectId: pid,
      status: trustworthy ? "evaluated" : "evaluation_blocked",
      trustworthy,
      evaluationId: latest.id,
      datasetId: latest.datasetId,
      datasetVersion: latest.datasetVersion,
      datasetHash: latest.datasetHash,
      split: latest.split,
      metrics: cloneJson(latest.metrics || null),
      slices: cloneJson(latest.slices || {}),
      validation: cloneJson(latest.validation || null),
      gate: cloneJson(latest.gate || null),
      calibration: cloneJson(latest.calibration || null),
      servingRelease: cloneJson(serving),
      reason: trustworthy
        ? "指标来自冻结 Golden Set 的独立时间切分，不等同于生产准确率"
        : "评测未通过数据、时间切分或样本完整度校验",
      annotationQuorum: "two_reviewer_consensus",
      servingSampleCount: governance.data.serving.approved,
      pendingAnnotationCount: governance.data.annotations.pending,
      generatedAt: governance.data.generatedAt,
    },
  };
}

export function getConfigInferenceTaskSource(projectId) {
  const pid = String(projectId || defaultPid()).trim();
  const root = configInferenceRoot(loadRawConfig(), pid);
  return cloneJson(root.settings.taskSource || null);
}

export function setConfigInferenceTaskSource(projectId, source) {
  const pid = explicitConfigInferenceProjectId(projectId);
  if (!pid) return { ok: false, error: "AI训练任务来源必须指定 TB 项目" };
  const normalized = normalizeConfigInferenceSource(source, pid);
  if (!normalized) return { ok: false, error: "AI训练任务来源缺少有效的列表 URL 或 sectionId" };
  if (normalized.projectId && normalized.projectId !== pid) return { ok: false, error: "AI训练任务来源与当前 TB 项目不一致" };
  const cfg = loadRawConfig();
  const root = configInferenceRoot(cfg, pid);
  const updatedAt = Math.max(Date.now(), Number(root.settings.updatedAt || 0) + 1);
  root.settings = { ...root.settings, taskSource: normalized, updatedAt };
  writeSharedOps(cfg, {
    type: "byProject.set",
    projectId: pid,
    path: ["aiTraining", "configInference", "settings"],
    value: root.settings,
  });
  return { ok: true, data: cloneJson(normalized), settings: { taskSource: cloneJson(normalized) } };
}

export function clearConfigInferenceTaskSource(projectId) {
  const pid = explicitConfigInferenceProjectId(projectId);
  if (!pid) return { ok: false, error: "AI训练任务来源必须指定 TB 项目" };
  const cfg = loadRawConfig();
  const root = configInferenceRoot(cfg, pid);
  const updatedAt = Math.max(Date.now(), Number(root.settings.updatedAt || 0) + 1);
  root.settings = { ...root.settings, taskSource: null, updatedAt };
  writeSharedOps(cfg, {
    type: "byProject.set",
    projectId: pid,
    path: ["aiTraining", "configInference", "settings"],
    value: root.settings,
  });
  return { ok: true, data: null, settings: { taskSource: null } };
}

// 模型无关的只读 RAG 入口。训练复核与真实执行继续沉淀在共享项目桶中；
// 所有 Agent 引擎从这里读取同一份结构化记忆，避免为 Claude/Codex/API 模型各建一套数据。
export function getConfigInferenceRagContext(projectId, ticketInput = {}, options = {}) {
  const pid = String(projectId || ticketInput?.projectId || "").trim();
  if (!pid) throw new Error("通用 RAG 检索必须指定 TB 项目，禁止跨项目回退");
  const registry = configInferenceRegistrySnapshot(pid);
  const cfg = loadRawConfig();
  const root = configInferenceRoot(cfg, pid);
  const servingRelease = configInferenceReleaseState(pid, root, registry);
  const rag = retrieveConfigInferenceMemories({
    projectId: pid,
    ticket: ticketInput,
    projectDefs: registry.projectDefs,
    vehicleMap: registry.vehicleMap,
    keywordMappings: registry.keywordMappings,
    samples: [
      ...configInferenceLearningSamples(root),
      ...legacyConfigInferenceSamples(pid, registry),
    ],
    valueBindings: configInferenceEffectiveValueBindings(pid, root),
    limit: options.limit,
    calibrator: servingRelease.calibrator,
  });
  const inference = decorateConfigInferenceServingResult(rag.inference || {}, servingRelease);
  return {
    ...rag,
    inference,
    servingRelease: inference.servingRelease,
    policy: {
      ...(rag.policy || {}),
      activeReleaseRequiredForCalibration: true,
      releaseGateEnforced: servingRelease.status === "active",
      humanConfirmationOnly: true,
    },
  };
}

function configInferenceRepoId(project) {
  if (!project) return "";
  if (getProjectDef(project.id)) return project.id;
  const remote = _normRemote(gitRemoteUrl(project.path));
  if (!remote) return "";
  const candidates = getProjectDefs().filter((row) => [_normRemote(row.ssh), _normRemote(row.https)].includes(remote));
  if (!candidates.length) return "";
  const currentBranch = gitBranch(project.path);
  const branchMatch = currentBranch
    ? candidates.find((row) => row.defaultBranch && row.defaultBranch === currentBranch)
    : null;
  if (branchMatch) return branchMatch.id;
  // 同远程的主应用与模块工程并存时，未命中模块专属 defaultBranch 才回退主应用。
  return candidates.find((row) => row.projectType === "application")?.id || candidates[0].id;
}

function matchConfigInferenceRegistryTarget(rows, hints = {}) {
  const candidates = rows.filter((row) => row.repositoryId === hints.repositoryId);
  if (!candidates.length) return null;
  const fields = ["appName", "vehicle", "branch", "flavor"];
  const exact = candidates.filter((candidate) => fields.every((field) => (
    !hints[field] || String(candidate[field] || "").trim().toLowerCase() === String(hints[field]).trim().toLowerCase()
  )));
  if (exact.length === 1) return exact[0];
  if (exact.length > 1) return null;
  const scored = candidates.map((candidate, index) => ({
    candidate,
    index,
    score: fields.reduce((sum, field) => {
      const expected = String(hints[field] || "").trim().toLowerCase();
      if (!expected) return sum;
      return sum + (String(candidate[field] || "").trim().toLowerCase() === expected ? 2 : -1);
    }, 0),
  })).sort((left, right) => right.score - left.score || left.index - right.index);
  if (scored.length === 1 || Number(scored[0]?.score) > Number(scored[1]?.score)) return scored[0]?.candidate || null;
  return null;
}

function configInferenceActualTargets(tab, projectId) {
  if (!tab) return [];
  const registry = configInferenceRegistrySnapshot(projectId);
  const rows = registry.targets;
  const localProjects = listProjects();
  const refs = tabProjectPaths(tab);
  const targets = [];
  const appendTarget = ({
    repositoryId,
    repositoryName = "",
    path: repoPath = "",
    branch = "",
    flavor = "",
    vehicle = "",
    appName = "",
    targetRole = "primary",
    projectType = "",
    repositoryOnly,
  }) => {
    if (!repositoryId) return;
    const matched = matchConfigInferenceRegistryTarget(rows, { repositoryId, appName, vehicle, branch, flavor });
    const def = registry.projectDefs.find((row) => row.id === repositoryId);
    const resolvedProjectType = String(projectType || matched?.projectType || def?.projectType || "application").trim();
    const resolvedRepositoryOnly = repositoryOnly === true
      || (repositoryOnly !== false && matched?.repositoryOnly === true)
      || (repositoryOnly !== false && !matched && ["sdk", "tooling", "service", "repository"].includes(resolvedProjectType));
    targets.push({
      appName: resolvedRepositoryOnly ? "" : (appName || matched?.appName || def?.name || repositoryName || repositoryId),
      vehicle: String(vehicle || matched?.vehicle || "").trim(),
      repositoryId,
      repositoryName: def?.name || matched?.repositoryName || repositoryName || repositoryId,
      gitUrl: def?.ssh || def?.https || matched?.gitUrl || (repoPath ? gitRemoteUrl(repoPath) : "") || "",
      branch: String(branch || matched?.branch || "").trim(),
      flavor: String(flavor || matched?.flavor || "").trim(),
      projectType: resolvedProjectType,
      targetRole: targetRole === "dependency" ? "dependency" : targetRole === "standalone" ? "standalone" : "primary",
      repositoryOnly: resolvedRepositoryOnly,
    });
  };
  for (const ref of refs) {
    const managedEntry = (Array.isArray(tab.worktree?.entries) ? tab.worktree.entries : [])
      .find((entry) => normPath(entry?.path) === normPath(ref.path));
    const registeredBase = managedEntry
      ? (
        localProjects.find((project) => normPath(project.path) === normPath(managedEntry.basePath))
        || localProjects.find((project) => (
          project.id === managedEntry.baseProjectId
          && normPath(project.path) === normPath(managedEntry.basePath)
        ))
      )
      : null;
    // 推理页展示的是故事点当前实际目录。受管 worktree 本身不会重复登记到 local-projects，
    // 因此用基仓身份 + worktree 路径读取真实 remote/branch，避免关联工程被静默丢掉。
    const local = localProjects.find((project) => normPath(project.path) === normPath(ref.path))
      || (registeredBase ? { ...registeredBase, path: ref.path } : null)
      || (managedEntry ? { id: "", name: ref.name, path: ref.path } : null)
      || (ref.role === "primary" ? getPrimaryProject(tab) : null);
    let repositoryId = configInferenceRepoId(local);
    if (!repositoryId) repositoryId = String(managedEntry?.repositoryId || "").trim();
    const remoteRepo = (tab.remoteRepos || []).find((repo) => repo?.path && normPath(repo.path) === normPath(ref.path));
    if (!repositoryId) repositoryId = String(remoteRepo?.projectId || remoteRepo?.repoId || remoteRepo?.key || "").trim();
    if (!repositoryId && ref.role === "primary" && getProjectDef(tab.primaryProjectId)) repositoryId = tab.primaryProjectId;
    if (!repositoryId) continue;
    const remoteEntry = (tab.remotePull?.entries || []).find((entry) => entry?.projectId === repositoryId);
    const branch = gitBranch(ref.path) || String(remoteRepo?.branch || remoteEntry?.branch || "").trim();
    const flavorEntry = (tab.flavors || []).find((entry) => normPath(entry?.path) === normPath(ref.path));
    const flavor = String(flavorEntry?.flavor || remoteRepo?.flavor || remoteEntry?.flavor || "").trim();
    appendTarget({
      repositoryId,
      repositoryName: ref.name,
      path: ref.path,
      branch,
      flavor,
      vehicle: String(tab.remotePull?.vehicle || "").trim(),
      targetRole: ref.role === "primary" ? "primary" : "dependency",
    });
  }
  // 远程初始化前还没有本地路径，但 remotePull 已是用户确认过的真实工程配置，也应进入训练样本。
  for (const entry of Array.isArray(tab.remotePull?.entries) ? tab.remotePull.entries : []) {
    const repositoryId = String(entry?.projectId || entry?.repositoryId || entry?.repoId || "").trim();
    if (!repositoryId || targets.some((target) => target.repositoryId === repositoryId)) continue;
    appendTarget({
      repositoryId,
      branch: String(entry?.branch || "").trim(),
      flavor: String(entry?.flavor || "").trim(),
      vehicle: String(tab.remotePull?.vehicle || "").trim(),
      targetRole: String(entry?.targetRole || entry?.role || "").trim() || (targets.length ? "dependency" : "primary"),
      projectType: String(entry?.projectType || "").trim(),
      repositoryOnly: entry?.repositoryOnly === true,
    });
  }
  return normalizeConfigInferenceTargets(targets);
}

export function getTabConfigInferenceActual(tabId, projectId) {
  const tab = typeof tabId === "object" ? tabId : getTab(tabId);
  if (!tab) return null;
  const targets = configInferenceActualTargets(tab, projectId || tab.tbContext?.projectId);
  const primaryTarget = targets.find((target) => target.targetRole === "primary")
    || targets.find((target) => target.targetRole === "standalone")
    || targets[0];
  return {
    tabId: tab.id,
    mode: tab.mode || "local",
    targets,
    primaryProjectId: tab.primaryProjectId || primaryTarget?.repositoryId || "",
    deviceSerial: tab.deviceSerial || "",
  };
}

function inferenceLocalBindingForTarget(target, bindings = []) {
  const rows = Array.isArray(bindings) ? bindings : [];
  const targetId = String(target?.targetId || "").trim();
  const repositoryId = String(target?.repositoryId || "").trim();
  const branch = String(target?.branch || "").trim();
  return rows.find((binding) => targetId && String(binding?.targetId || "").trim() === targetId)
    || rows.find((binding) => String(binding?.repositoryId || "").trim() === repositoryId
      && String(binding?.branch || "").trim() === branch)
    || null;
}

function inferenceLocalCandidates(target) {
  const def = getProjectDef(target.repositoryId);
  const wantedRemote = repositoryKey(def?.ssh || def?.https || target.gitUrl);
  const wantedBranch = String(target.branch || "").trim();
  return listProjects()
    .filter((project) => project.exists !== false && project.path && fs.existsSync(project.path))
    .map((project) => {
      const currentBranch = gitBranch(project.path) || "";
      const remoteMatch = !!wantedRemote && repositoryKey(gitRemoteUrl(project.path)) === wantedRemote;
      return {
        project,
        currentBranch,
        remoteMatch,
        branchMatch: !!wantedBranch && currentBranch === wantedBranch,
        idMatch: project.id === target.repositoryId,
      };
    })
    .sort((left, right) => Number(right.branchMatch) - Number(left.branchMatch)
      || Number(right.remoteMatch) - Number(left.remoteMatch)
      || Number(right.idMatch) - Number(left.idMatch)
      || String(left.project.name || left.project.id).localeCompare(String(right.project.name || right.project.id), "zh-CN"));
}

function resolveInferenceLocalProject(target, bindings = []) {
  const candidates = inferenceLocalCandidates(target);
  const requested = inferenceLocalBindingForTarget(target, bindings);
  if (requested?.useRemote === true) return { project: null, matchKind: "remote_selected", candidates };
  if (requested?.projectId) {
    const selected = candidates.find((candidate) => candidate.project.id === String(requested.projectId));
    if (selected) return { project: selected.project, matchKind: "user_selected", candidates };
  }
  const remembered = getRepositoryBindingProject(target.repositoryId, target.branch);
  if (remembered) {
    const selected = candidates.find((candidate) => candidate.project.id === remembered.id);
    if (selected) return { project: selected.project, matchKind: "remembered", candidates };
  }
  const exactBranch = candidates.filter((candidate) => candidate.remoteMatch && candidate.branchMatch);
  if (exactBranch.length === 1) return { project: exactBranch[0].project, matchKind: "exact_branch", candidates };
  const direct = candidates.find((candidate) => candidate.idMatch);
  if (direct) return { project: direct.project, matchKind: direct.branchMatch ? "exact_branch" : "project_id", candidates };
  const checkout = findLocalCheckout(target.repositoryId, target.branch);
  if (checkout?.path && fs.existsSync(checkout.path)) {
    return {
      project: { id: target.repositoryId, name: checkout.name || target.repositoryName, path: checkout.path, exists: true },
      matchKind: "checkout_record",
      candidates,
    };
  }
  const sameRemote = candidates.filter((candidate) => candidate.remoteMatch);
  if (sameRemote.length === 1) return { project: sameRemote[0].project, matchKind: "same_remote", candidates };
  return { project: null, matchKind: sameRemote.length > 1 ? "ambiguous" : "unresolved", candidates };
}

function configInferenceLocalResolution(targets, bindings = []) {
  const rawResolutions = targets.map((target) => resolveInferenceLocalProject(target, bindings));
  const resolutions = targets.map((target, index) => {
    const result = rawResolutions[index];
    return {
      targetId: String(target.targetId || `target_${index + 1}`),
      repositoryId: target.repositoryId,
      repositoryName: target.repositoryName || target.repositoryId,
      branch: target.branch || "",
      flavor: target.flavor || "",
      targetRole: target.targetRole || "",
      selectedProjectId: result.project?.id || "",
      matchKind: result.matchKind,
      resolved: !!result.project,
      selectionRequired: true,
      candidates: result.candidates.map((candidate) => ({
        id: candidate.project.id,
        name: candidate.project.name || candidate.project.id,
        currentBranch: candidate.currentBranch,
        remoteMatch: candidate.remoteMatch,
        branchMatch: candidate.branchMatch,
      })),
      project: result.project,
    };
  });
  return {
    complete: resolutions.every((row) => row.resolved),
    targets: resolutions.map(({ project, ...row }) => row),
    projects: listProjects()
      .filter((project) => project.exists !== false && project.path && fs.existsSync(project.path))
      .map((project) => ({
        id: project.id,
        name: project.name || project.id,
        currentBranch: gitBranch(project.path) || "",
      })),
    _resolved: resolutions,
  };
}

function prepareConfigInferenceLocalBindings(targets, inputBindings = []) {
  const requested = Array.isArray(inputBindings) ? inputBindings : [];
  const normalizedTargets = orderConfigInferenceTargets(normalizeConfigInferenceTargets(targets));
  const bindings = [];
  for (const raw of requested) {
    const requestedTargetId = String(raw?.targetId || "").trim();
    let targetIndex = normalizedTargets.findIndex((target, index) => (
      requestedTargetId && String(target.targetId || `target_${index + 1}`) === requestedTargetId
    ));
    if (targetIndex < 0) {
      const repositoryId = String(raw?.repositoryId || "").trim();
      const branch = String(raw?.branch || "").trim();
      const matches = normalizedTargets
        .map((target, index) => ({ target, index }))
        .filter(({ target }) => target.repositoryId === repositoryId && String(target.branch || "").trim() === branch);
      if (matches.length === 1) targetIndex = matches[0].index;
    }
    if (targetIndex < 0) {
      return { ok: false, error: "本机工程选择与当前推理目标不一致，请重新选择" };
    }
    const target = normalizedTargets[targetIndex];
    const targetId = String(target.targetId || `target_${targetIndex + 1}`);
    if (raw?.useRemote === true) {
      bindings.push({ targetId, repositoryId: target.repositoryId, branch: target.branch || "", useRemote: true });
      continue;
    }
    const projectId = String(raw?.projectId || "").trim();
    const project = projectId ? getProject(projectId) : null;
    if (!project?.path || !fs.existsSync(project.path)) {
      return { ok: false, error: `所选本机工程「${projectId || target.repositoryName || target.repositoryId}」不存在或路径已失效` };
    }
    bindings.push({
      targetId,
      repositoryId: target.repositoryId,
      branch: target.branch || "",
      projectId,
    });
  }
  return { ok: true, bindings };
}

function requireConfigInferenceLocalSelection(targets, bindings = []) {
  const localResolution = configInferenceLocalResolution(targets, bindings);
  const pending = localResolution._resolved.filter((row) => (
    !row.project
    && row.matchKind !== "remote_selected"
    && row.candidates.length > 0
  ));
  if (!pending.length) return { ok: true, localResolution };
  return {
    ok: false,
    statusCode: 409,
    localProjectSelectionRequired: true,
    localResolution: {
      ...localResolution,
      _resolved: undefined,
    },
    error: `本机存在可选源码，请先为 ${pending.map((row) => row.repositoryName || row.repositoryId).join("、")} 选择本机工程，或明确改用远程拉取`,
  };
}

function orderConfigInferenceTargets(targets) {
  return targets
    .map((target, index) => ({ target, index }))
    .sort((left, right) => {
      const explicitOrder = (row) => Number.isFinite(Number(row.target.order)) && Number(row.target.order) > 0
        ? Math.trunc(Number(row.target.order))
        : Number.POSITIVE_INFINITY;
      const rank = (target) => target.targetRole === "primary" ? 0 : target.targetRole === "standalone" ? 1 : 2;
      const leftOrder = explicitOrder(left);
      const rightOrder = explicitOrder(right);
      if (leftOrder !== rightOrder) return leftOrder < rightOrder ? -1 : 1;
      return rank(left.target) - rank(right.target) || left.index - right.index;
    })
    .map(({ target }, index) => ({
      ...target,
      order: index + 1,
      // 主/依赖是工程拓扑事实，不能再按数组位置静默改写。只有显式的“设为主工程”
      // 或删除主工程后的提升动作可以改变角色；排序只改变 order。
      targetRole: ["primary", "dependency", "standalone"].includes(target.targetRole)
        ? target.targetRole
        : (index === 0 ? "primary" : "dependency"),
    }));
}

function configInferenceAnchorIndex(targets) {
  const rows = Array.isArray(targets) ? targets : [];
  const primaryIndex = rows.findIndex((target) => target.targetRole === "primary");
  if (primaryIndex >= 0) return primaryIndex;
  const standaloneIndex = rows.findIndex((target) => target.targetRole === "standalone");
  return standaloneIndex >= 0 ? standaloneIndex : 0;
}

function validateConfigInferenceTargetGraph(targets) {
  const rows = Array.isArray(targets) ? targets : [];
  const applicationTargets = rows.filter((target) => !target.repositoryOnly);
  const primaryTargets = rows.filter((target) => target.targetRole === "primary");
  const executionAnchors = rows.filter((target) => ["primary", "standalone"].includes(target.targetRole));
  if (applicationTargets.length) {
    if (primaryTargets.length !== 1 || executionAnchors.length !== 1 || primaryTargets[0]?.repositoryOnly) {
      return {
        ok: false,
        error: `包含应用工程时，全图必须且只能有一个应用主工程，当前主工程 ${primaryTargets.length} 个、执行锚点 ${executionAnchors.length} 个`,
      };
    }
  } else if (rows.length && executionAnchors.length !== 1) {
    return {
      ok: false,
      error: `纯仓库、SDK 或工具工程必须且只能有一个主工程或独立工程，当前执行锚点 ${executionAnchors.length} 个`,
    };
  }
  const primary = primaryTargets[0];
  if (!primary) return { ok: true };
  const normalized = (value) => String(value || "").trim().toLowerCase();
  for (const dependency of applicationTargets.filter((target) => target.targetRole === "dependency")) {
    // 代号目标尚未物化时只校验已知字段；实际值替换后会再次经过本校验。
    const vehicleConflict = primary.vehicle && dependency.vehicle
      && normalized(primary.vehicle) !== normalized(dependency.vehicle);
    const appConflict = primary.appName && dependency.appName
      && normalized(primary.appName) !== normalized(dependency.appName);
    if (vehicleConflict || appConflict) {
      return {
        ok: false,
        error: `依赖工程 ${dependency.repositoryName || dependency.repositoryId || dependency.targetId || "未命名"} 必须与主工程属于同一车型和应用，不能把跨车型候选保存为依赖`,
      };
    }
  }
  return { ok: true };
}

function normalizeReviewedConfigInferenceTargets(inputTargets) {
  const rows = Array.isArray(inputTargets) ? inputTargets : [];
  const hasExplicitPrimary = rows.some((target) => String(target?.targetRole || target?.role || "").trim().toLowerCase() === "primary");
  const implicitPrimaryIndex = hasExplicitPrimary || !rows.length
    ? -1
    : rows
      .map((target, index) => ({ index, order: Number(target?.order ?? target?.sortOrder) }))
      .sort((left, right) => {
        const leftOrder = Number.isFinite(left.order) && left.order > 0 ? left.order : Number.POSITIVE_INFINITY;
        const rightOrder = Number.isFinite(right.order) && right.order > 0 ? right.order : Number.POSITIVE_INFINITY;
        return leftOrder - rightOrder || left.index - right.index;
      })[0]?.index ?? 0;
  return normalizeConfigInferenceTargets(rows.map((target, index) => {
    const explicitRole = String(target?.targetRole || target?.role || "").trim().toLowerCase();
    if (["primary", "dependency", "standalone"].includes(explicitRole)) return target;
    // 兼容旧客户端：未传角色时按显式 order 的第一项作为主工程。新 UI 总会传
    // targetRole，因此不会再因重排而静默改变角色。
    return { ...target, targetRole: index === implicitPrimaryIndex ? "primary" : "dependency" };
  }));
}

const CONFIG_INFERENCE_REPOSITORY_ONLY_TYPES = new Set(["sdk", "tooling", "service", "repository"]);

function configInferenceGitPair(value) {
  const raw = String(value || "").trim();
  if (!raw) return { ok: true, https: "", ssh: "", raw: "" };
  if (/^git@[^\s:]+:[^\s]+$/i.test(raw)) {
    if (/[?#]/.test(raw)) return { ok: false, error: "Git 仓库地址不能包含查询参数或片段，避免令牌被写入共享配置" };
    const pair = deriveGitPair("", raw);
    return pair.https ? { ok: true, ...pair, raw } : { ok: false, error: "Git 仓库 SSH 地址格式不正确" };
  }
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) {
    let parsed;
    try { parsed = new URL(raw); } catch { return { ok: false, error: "Git 仓库地址格式不正确" }; }
    if (parsed.protocol !== "https:") return { ok: false, error: "Git 仓库仅支持 HTTPS 或 git@host:path SSH 地址" };
    if (parsed.username || parsed.password) return { ok: false, error: "Git 仓库地址不能包含明文账号或密码" };
    if (parsed.search || parsed.hash) return { ok: false, error: "Git 仓库地址不能包含查询参数或片段，避免令牌被写入共享配置" };
    if (!parsed.hostname || !parsed.pathname || parsed.pathname === "/") return { ok: false, error: "Git 仓库 HTTPS 地址缺少主机或仓库路径" };
    const pair = deriveGitPair(raw, "");
    return pair.ssh ? { ok: true, ...pair, raw } : { ok: false, error: "Git 仓库 HTTPS 地址无法转换为 SSH 地址" };
  }
  return { ok: false, error: "Git 仓库地址仅支持 HTTPS 或 git@host:path SSH 格式" };
}

function configInferenceLooksLikeGitAddress(value) {
  const raw = String(value || "").trim();
  return /^git@/i.test(raw) || /^[a-z][a-z0-9+.-]*:\/\//i.test(raw);
}

function configInferenceRepositoryNameFromGit(value) {
  const raw = String(value || "").trim();
  let segment = "";
  if (/^git@/i.test(raw)) segment = raw.slice(raw.indexOf(":") + 1).split("/").filter(Boolean).pop() || "";
  else {
    try { segment = new URL(raw).pathname.split("/").filter(Boolean).pop() || ""; } catch {}
  }
  try { segment = decodeURIComponent(segment); } catch {}
  return segment.replace(/\.git$/i, "").trim();
}

function configInferenceRepositoryMatch(defs, target) {
  const repositoryIdRef = String(target.repositoryId || "").trim().toLowerCase();
  const refs = [target.repositoryId, target.repositoryName]
    .map((value) => String(value || "").trim().toLowerCase())
    .filter(Boolean);
  const rawGit = String(target.gitUrl || "").trim();
  const repositoryRef = String(target.repositoryId || target.repositoryName || "").trim();
  const gitValue = rawGit || (configInferenceLooksLikeGitAddress(repositoryRef) ? repositoryRef : "");
  let gitPair = { ok: true, https: "", ssh: "", raw: "" };
  if (gitValue) {
    gitPair = configInferenceGitPair(gitValue);
    if (!gitPair.ok) return { error: gitPair.error };
  }
  const gitRefs = [gitPair.https, gitPair.ssh]
    .map((item) => String(item || "").trim().toLowerCase())
    .filter(Boolean);
  const exactIdMatch = repositoryIdRef
    ? defs.find((def) => String(def.id || "").trim().toLowerCase() === repositoryIdRef)
    : null;
  if (exactIdMatch) {
    if (gitValue) {
      const configuredGit = [exactIdMatch.https, exactIdMatch.ssh]
        .map((value) => String(value || "").trim().toLowerCase())
        .filter(Boolean);
      if (configuredGit.length && !configuredGit.some((value) => gitRefs.includes(value))) {
        return { error: `Git 仓库「${exactIdMatch.name || exactIdMatch.id}」已配置为其他地址，不能在训练复核中静默覆盖` };
      }
    }
    return { match: exactIdMatch, gitPair, repositoryRef };
  }
  const identityMatches = defs.filter((def) => (
    refs.includes(String(def.id || "").trim().toLowerCase())
    || refs.includes(String(def.name || "").trim().toLowerCase())
  ));
  const gitMatches = gitValue
    ? defs.filter((def) => [def.https, def.ssh]
      .map((value) => String(value || "").trim().toLowerCase())
      .some((value) => value && gitRefs.includes(value)))
    : [];
  const matches = [...new Map([...identityMatches, ...gitMatches].map((def) => [def.id, def])).values()];
  if (matches.length > 1) return { error: "Git 仓库名称、ID 与地址分别指向不同的已配置仓库，请统一后再提交" };
  const match = matches[0];
  if (match && gitValue && identityMatches.includes(match)) {
    const configuredGit = [match.https, match.ssh]
      .map((value) => String(value || "").trim().toLowerCase())
      .filter(Boolean);
    if (configuredGit.length && !configuredGit.some((value) => gitRefs.includes(value))) {
      return { error: `Git 仓库「${match.name || match.id}」已配置为其他地址，不能在训练复核中静默覆盖` };
    }
  }
  return { match, gitPair, repositoryRef };
}

function configInferenceNewRepositoryId(value, name, defs) {
  const raw = String(value || "").trim();
  if (/^[a-z0-9][a-z0-9._-]{0,79}$/i.test(raw) && safeSharedSegment(raw) && !defs.some((def) => def.id === raw)) return raw;
  let id = genId(name || "repository");
  while (!safeSharedSegment(id) || defs.some((def) => def.id === id)) id = genId(name || "repository");
  return id;
}

function configInferenceTupleKey(repo = {}) {
  return [
    String(repo.repoId || repo.projectId || "").trim().toLowerCase(),
    String(repo.branch || "").trim(),
    String(repo.flavor || "").trim(),
  ].join("\u0000");
}

function configInferenceVehicleMappingForWriteback(vehicle, mapping) {
  const source = isPlainObject(mapping) ? cloneJson(mapping) : {};
  const normalized = normalizeVehicleMapping(vehicle, source);
  const sourceApps = Array.isArray(source.apps) ? source.apps : [];
  const apps = normalized.apps.map((app) => {
    const originalApp = sourceApps.find((item) => String(item?.appName || "").trim().toLowerCase() === app.appName.toLowerCase()) || {};
    const originalRepos = Array.isArray(originalApp.repos) ? originalApp.repos : [];
    return {
      ...cloneJson(originalApp),
      ...app,
      repos: app.repos.map((repo) => ({
        ...cloneJson(originalRepos.find((item) => configInferenceTupleKey(item) === configInferenceTupleKey(repo)) || {}),
        ...repo,
      })),
    };
  });
  const sourceEntries = Array.isArray(source.entries) ? source.entries : [];
  const entries = apps.flatMap((app) => app.repos.map((repo) => {
    const normalizedEntry = {
      projectId: repo.repoId,
      branch: repo.branch,
      flavor: repo.flavor,
      ...(repo.targetRole ? { targetRole: repo.targetRole } : {}),
      ...(Number(repo.order) > 0 ? { order: Math.trunc(Number(repo.order)) } : {}),
    };
    const originalEntry = sourceEntries.find((item) => configInferenceTupleKey(item) === configInferenceTupleKey(repo)) || {};
    return { ...cloneJson(originalEntry), ...normalizedEntry };
  }));
  return { ...source, ...normalized, apps, entries };
}

function configInferenceDimensionValue(value) {
  return String(value || "").trim().toLowerCase();
}

function validateConfigInferenceSymbolicTarget(target, {
  projectDefs = [],
  vehicleMap = {},
  allowCurrentTargets = [],
} = {}) {
  const fields = configInferenceSymbolicFields(target);
  if (!fields.length) return { ok: true };
  const hasFeature = fields.some((field) => (
    String(target[field] || "").trim() || String(target.fieldStates?.[field]?.feature || "").trim()
  ));
  if (!hasFeature) return { ok: false, error: "代号工程至少需要填写一个代号值或特征说明" };
  for (const field of fields) {
    if (String(target[field] || "").trim() || String(target.fieldStates?.[field]?.feature || "").trim()) continue;
    return { ok: false, error: `代号字段「${field}」需要填写代号值或特征说明` };
  }
  if (target.gitUrl) {
    const gitPair = configInferenceGitPair(target.gitUrl);
    if (!gitPair.ok) return { ok: false, error: gitPair.error };
  }
  const symbolicSet = new Set(fields);
  const required = target.repositoryOnly
    ? ["repositoryId"]
    : target.projectType === "application"
      ? CONFIG_INFERENCE_DIMENSIONS
      : CONFIG_INFERENCE_DIMENSIONS.filter((field) => field !== "appName");
  const missing = required.filter((field) => (
    !String(target[field] || "").trim()
    && !(symbolicSet.has(field) && String(target.fieldStates?.[field]?.feature || "").trim())
  ));
  if (missing.length) return { ok: false, error: `配置推理目标缺少字段：${missing.join("、")}` };

  const registry = buildConfigInferenceRegistry(projectDefs, vehicleMap);
  const registeredTargets = Array.isArray(registry?.targets) ? registry.targets : [];
  const currentTargets = normalizeConfigInferenceTargets(allowCurrentTargets);
  const literalDimensions = CONFIG_INFERENCE_DIMENSIONS.filter((field) => (
    !symbolicSet.has(field) && String(target[field] || "").trim()
  ));
  if (literalDimensions.length) {
    const compatible = [...registeredTargets, ...currentTargets].filter((candidate) => (
      (target.repositoryOnly ? candidate.repositoryOnly === true : candidate.repositoryOnly !== true)
      && literalDimensions.every((field) => (
        configInferenceDimensionValue(candidate[field]) === configInferenceDimensionValue(target[field])
      ))
    ));
    if (!compatible.length) {
      return {
        ok: false,
        error: `代号目标中的实际字段组合未在工程注册表登记：${literalDimensions.join("、")}；尚未确定或尚未配置的字段请显式标记为代号值`,
      };
    }
  }
  if (!symbolicSet.has("repositoryId") && target.repositoryId && target.gitUrl) {
    const lookup = configInferenceRepositoryMatch(projectDefs, target);
    if (lookup.error) return { ok: false, error: lookup.error };
    if (!lookup.match) return { ok: false, error: "代号目标引用的实际 Git 仓库尚未登记，请将 Git 仓库标记为代号值" };
  }
  return { ok: true };
}

function mergeConfigInferenceConfigurationGuards(base = {}, incoming = {}) {
  const out = {
    projectDefs: Array.isArray(base.projectDefs) ? base.projectDefs.map(cloneJson) : [],
    vehicles: Array.isArray(base.vehicles) ? base.vehicles.map(cloneJson) : [],
  };
  for (const item of Array.isArray(incoming.projectDefs) ? incoming.projectDefs : []) {
    if (!out.projectDefs.some((row) => row.id === item.id)) out.projectDefs.push(cloneJson(item));
  }
  for (const item of Array.isArray(incoming.vehicles) ? incoming.vehicles : []) {
    if (!out.vehicles.some((row) => row.vehicle === item.vehicle)) out.vehicles.push(cloneJson(item));
  }
  return out;
}

function guardConfigInferenceConfigurationWrite(latest, projectId, expected = {}) {
  const latestDefs = Array.isArray(latest?.projectDefs) ? latest.projectDefs : [];
  for (const item of Array.isArray(expected.projectDefs) ? expected.projectDefs : []) {
    const current = latestDefs.find((def) => String(def?.id || "") === item.id) || null;
    if (stableJsonText(current) !== stableJsonText(item.value ?? null)) {
      return `仓库 ${item.id} 的工程配置已由其它 Gateway 更新`;
    }
  }
  const latestVehicleMap = latest?.byProject?.[projectId]?.vehicleMap;
  for (const item of Array.isArray(expected.vehicles) ? expected.vehicles : []) {
    const current = isPlainObject(latestVehicleMap) && Object.hasOwn(latestVehicleMap, item.vehicle)
      ? latestVehicleMap[item.vehicle]
      : null;
    if (stableJsonText(current) !== stableJsonText(item.value ?? null)) {
      return `车型 ${item.vehicle} 的源码配置已由其它 Gateway 更新`;
    }
  }
  return true;
}

function prepareConfigInferenceTargetWriteback(cfg, projectId, inputTargets, allowCurrentTargets = []) {
  const pid = explicitConfigInferenceProjectId(projectId);
  if (!pid) return { ok: false, error: "更新配置推理选项必须指定 TB 项目" };
  const requestedTargets = orderConfigInferenceTargets(normalizeConfigInferenceTargets(inputTargets))
    .map((target, index) => ({ ...target, targetId: target.targetId || `target_${index + 1}` }));
  if (!requestedTargets.length) return { ok: false, error: "至少需要一个工程配置目标" };
  const requestedGraphValidation = validateConfigInferenceTargetGraph(requestedTargets);
  if (!requestedGraphValidation.ok) return requestedGraphValidation;
  const unresolved = requestedTargets
    .filter(hasConfigInferenceSymbolicFields)
    .map((target) => ({ targetId: target.targetId, fields: configInferenceSymbolicFields(target) }));
  if (unresolved.length) {
    const registry = configInferenceRegistrySnapshot(pid);
    for (const target of requestedTargets) {
      if (hasConfigInferenceSymbolicFields(target)) {
        const symbolicValidation = validateConfigInferenceSymbolicTarget(target, {
          projectDefs: registry.projectDefs,
          vehicleMap: registry.vehicleMap,
          allowCurrentTargets,
        });
        if (!symbolicValidation.ok) return symbolicValidation;
      } else {
        const validation = validateConfigInferenceTargets([target], {
          projectDefs: registry.projectDefs,
          vehicleMap: registry.vehicleMap,
          allowCurrentTargets,
        });
        if (!validation.ok) return validation;
      }
    }
    return {
      ok: true,
      targets: requestedTargets,
      ops: [],
      configurationGuard: { projectDefs: [], vehicles: [] },
      projectDefsChanged: false,
      configurationUpdates: {
        repositories: [],
        applications: [],
        vehicles: [],
        branches: [],
        flavors: [],
        orderUpdated: false,
        symbolicTargets: unresolved,
        unresolved,
        pendingReplacement: true,
        deferred: true,
        changed: false,
      },
    };
  }

  const originalDefs = (Array.isArray(cfg.projectDefs) ? cfg.projectDefs : getProjectDefs())
    .map((def) => normalizeDefPreservingMetadata(def))
    .filter((def) => def.id);
  const defs = cloneJson(originalDefs);
  const sourceBucket = projectBucket(cfg, pid);
  const originalVehicleMap = cloneJson(isPlainObject(sourceBucket.vehicleMap) ? sourceBucket.vehicleMap : {});
  const vehicleMap = cloneJson(originalVehicleMap);
  const touchedVehicles = new Set();
  let primaryRepositoryId = "";
  let canonicalTargets = [];
  const changes = {
    repositories: [],
    applications: [],
    vehicles: [],
    branches: [],
    flavors: [],
    orderUpdated: false,
    symbolicTargets: [],
    pendingReplacement: false,
  };

  const anchorIndex = configInferenceAnchorIndex(requestedTargets);
  const processingTargets = [
    requestedTargets[anchorIndex],
    ...requestedTargets.filter((_, index) => index !== anchorIndex),
  ];
  for (const target of processingTargets) {
    if (hasConfigInferenceSymbolicFields(target)) {
      const symbolicValidation = validateConfigInferenceSymbolicTarget(target, {
        projectDefs: defs,
        vehicleMap,
        allowCurrentTargets,
      });
      if (!symbolicValidation.ok) return symbolicValidation;
      canonicalTargets.push(target);
      changes.symbolicTargets.push({
        targetId: target.targetId,
        fields: configInferenceSymbolicFields(target),
      });
      changes.pendingReplacement = true;
      continue;
    }
    const lookup = configInferenceRepositoryMatch(defs, target);
    if (lookup.error) return { ok: false, error: lookup.error };
    let def = lookup.match;
    let createdRepository = false;
    if (!def) {
      const repositoryRef = lookup.repositoryRef;
      if (!repositoryRef) return { ok: false, error: "Git 仓库不能为空" };
      const gitName = lookup.gitPair?.raw ? configInferenceRepositoryNameFromGit(lookup.gitPair.raw) : "";
      const requestedName = String(target.repositoryName || "").trim();
      const name = (requestedName && !configInferenceLooksLikeGitAddress(requestedName) ? requestedName : "")
        || gitName
        || repositoryRef;
      const projectType = normalizeProjectDefType(target.projectType || (target.repositoryOnly ? "repository" : "application"));
      const repositoryOnly = target.repositoryOnly === true || CONFIG_INFERENCE_REPOSITORY_ONLY_TYPES.has(projectType);
      def = normalizeDef({
        id: configInferenceNewRepositoryId(repositoryRef, name, defs),
        name,
        https: lookup.gitPair?.https || "",
        ssh: lookup.gitPair?.ssh || "",
        projectType,
        inferenceEnabled: repositoryOnly,
        requiresRepositories: repositoryOnly && target.targetRole === "dependency" && primaryRepositoryId ? [primaryRepositoryId] : [],
        defaultBranch: repositoryOnly ? target.branch : "",
        defaultFlavor: repositoryOnly ? target.flavor : "",
        branchOptions: target.branch ? [target.branch] : [],
        flavorOptions: target.flavor ? [target.flavor] : [],
        inferenceOrder: repositoryOnly ? target.order : 0,
        inferenceRole: repositoryOnly ? target.targetRole : "",
      });
      defs.push(def);
      createdRepository = true;
      changes.repositories.push(def.name || def.id);
    }

    const defIndex = defs.findIndex((item) => item.id === def.id);
    const repositoryOnly = target.repositoryOnly === true
      || CONFIG_INFERENCE_REPOSITORY_ONLY_TYPES.has(def.projectType)
      || def.inferenceEnabled === true;
    const orderChanged = repositoryOnly
      && (Number(def.inferenceOrder || 0) !== Number(target.order || 0) || def.inferenceRole !== target.targetRole);
    const dependencyParents = repositoryOnly && target.targetRole === "dependency" && primaryRepositoryId && primaryRepositoryId !== def.id
      ? [...(def.requiresRepositories || []), primaryRepositoryId]
      : (def.requiresRepositories || []);
    const nextDef = normalizeDefPreservingMetadata({
      ...def,
      defaultBranch: def.defaultBranch || (repositoryOnly ? target.branch : ""),
      defaultFlavor: def.defaultFlavor || (repositoryOnly ? target.flavor : ""),
      branchOptions: [...(def.branchOptions || []), target.branch],
      flavorOptions: [...(def.flavorOptions || []), target.flavor],
      requiresRepositories: dependencyParents,
      inferenceOrder: repositoryOnly ? target.order : def.inferenceOrder,
      inferenceRole: repositoryOnly ? target.targetRole : def.inferenceRole,
    }, def);
    if (stableJsonText(nextDef) !== stableJsonText(def)) {
      defs[defIndex] = nextDef;
      if (target.branch && !(def.branchOptions || []).includes(target.branch) && target.branch !== def.defaultBranch) {
        changes.branches.push(`${nextDef.name || nextDef.id} @ ${target.branch}`);
      }
      if (target.flavor && !(def.flavorOptions || []).includes(target.flavor) && target.flavor !== def.defaultFlavor) {
        changes.flavors.push(`${nextDef.name || nextDef.id} @ ${target.flavor}`);
      }
      def = nextDef;
    }
    if (orderChanged || (createdRepository && repositoryOnly)) changes.orderUpdated = true;

    canonicalTargets.push({
      ...target,
      appName: repositoryOnly ? "" : String(target.appName || "").trim(),
      vehicle: repositoryOnly ? "" : String(target.vehicle || "").trim(),
      repositoryId: def.id,
      repositoryName: def.name || def.id,
      gitUrl: def.ssh || def.https || "",
      branch: String(target.branch || "").trim(),
      flavor: repositoryOnly ? String(target.flavor || "").trim() : String(target.flavor || "").trim(),
      projectType: def.projectType,
      repositoryOnly,
    });
    if (["primary", "standalone"].includes(target.targetRole)) primaryRepositoryId = def.id;
  }

  canonicalTargets = orderConfigInferenceTargets(canonicalTargets);
  const canonicalGraphValidation = validateConfigInferenceTargetGraph(canonicalTargets);
  if (!canonicalGraphValidation.ok) return canonicalGraphValidation;

  const desiredGroups = new Map();
  for (const target of canonicalTargets) {
    if (hasConfigInferenceSymbolicFields(target) || target.repositoryOnly || !target.vehicle || !target.appName) continue;
    if (!safeSharedSegment(target.vehicle)) return { ok: false, error: `车型「${target.vehicle}」不能作为共享配置键` };
    const vehicle = target.vehicle;
    const groupKey = `${vehicle}\u0000${target.appName.toLowerCase()}`;
    if (!Object.hasOwn(vehicleMap, vehicle) || !isPlainObject(vehicleMap[vehicle])) {
      vehicleMap[vehicle] = configInferenceVehicleMappingForWriteback(vehicle, {});
      changes.vehicles.push(vehicle);
    }
    if (!touchedVehicles.has(vehicle)) {
      vehicleMap[vehicle] = configInferenceVehicleMappingForWriteback(vehicle, vehicleMap[vehicle]);
      touchedVehicles.add(vehicle);
    }
    const mapping = vehicleMap[vehicle];
    let app = mapping.apps.find((item) => String(item.appName || "").trim().toLowerCase() === target.appName.toLowerCase());
    if (!app) {
      app = { appName: target.appName, repos: [] };
      mapping.apps.push(app);
      changes.applications.push(`${vehicle} / ${target.appName}`);
    }
    const repo = {
      repoId: target.repositoryId,
      branch: target.branch,
      flavor: target.flavor,
      targetRole: target.targetRole,
      order: target.order,
    };
    const tupleKey = configInferenceTupleKey(repo);
    const existingRepoIndex = app.repos.findIndex((item) => configInferenceTupleKey(item) === tupleKey);
    if (existingRepoIndex < 0) {
      app.repos.push(repo);
      if (target.branch) changes.branches.push(`${target.repositoryName || target.repositoryId} @ ${target.branch}`);
      if (target.flavor) changes.flavors.push(`${target.repositoryName || target.repositoryId} @ ${target.flavor}`);
    } else {
      const existingRepo = app.repos[existingRepoIndex];
      const nextRepo = { ...existingRepo, ...repo };
      if (existingRepo.targetRole !== nextRepo.targetRole || Number(existingRepo.order || 0) !== Number(nextRepo.order || 0)) {
        changes.orderUpdated = true;
      }
      app.repos[existingRepoIndex] = nextRepo;
    }
    const desired = desiredGroups.get(groupKey) || { vehicle, appName: app.appName, tuples: [] };
    if (!desired.tuples.includes(tupleKey)) desired.tuples.push(tupleKey);
    desiredGroups.set(groupKey, desired);
  }

  const appOrderByVehicle = new Map();
  for (const desired of desiredGroups.values()) {
    const mapping = vehicleMap[desired.vehicle];
    const app = mapping.apps.find((item) => String(item.appName || "").trim().toLowerCase() === desired.appName.toLowerCase());
    if (!app) continue;
    const before = app.repos.map(configInferenceTupleKey);
    const desiredRank = new Map(desired.tuples.map((key, index) => [key, index]));
    app.repos = app.repos
      .map((repo, index) => ({ repo, index, rank: desiredRank.has(configInferenceTupleKey(repo)) ? desiredRank.get(configInferenceTupleKey(repo)) : Number.POSITIVE_INFINITY }))
      .sort((left, right) => left.rank - right.rank || left.index - right.index)
      .map((row) => row.repo);
    if (before.join("|") !== app.repos.map(configInferenceTupleKey).join("|")) changes.orderUpdated = true;
    const appOrder = appOrderByVehicle.get(desired.vehicle) || [];
    const appKey = String(app.appName || "").trim().toLowerCase();
    if (!appOrder.includes(appKey)) appOrder.push(appKey);
    appOrderByVehicle.set(desired.vehicle, appOrder);
  }
  for (const [vehicle, appOrder] of appOrderByVehicle.entries()) {
    const mapping = vehicleMap[vehicle];
    const before = mapping.apps.map((app) => String(app.appName || "").trim().toLowerCase());
    const rank = new Map(appOrder.map((key, index) => [key, index]));
    mapping.apps = mapping.apps
      .map((app, index) => ({ app, index, rank: rank.has(String(app.appName || "").trim().toLowerCase()) ? rank.get(String(app.appName || "").trim().toLowerCase()) : Number.POSITIVE_INFINITY }))
      .sort((left, right) => left.rank - right.rank || left.index - right.index)
      .map((row) => row.app);
    if (before.join("|") !== mapping.apps.map((app) => String(app.appName || "").trim().toLowerCase()).join("|")) changes.orderUpdated = true;
    vehicleMap[vehicle] = configInferenceVehicleMappingForWriteback(vehicle, mapping);
  }

  const concreteTargets = canonicalTargets.filter((target) => !hasConfigInferenceSymbolicFields(target));
  const validation = concreteTargets.length ? validateConfigInferenceTargets(concreteTargets, {
    projectDefs: defs,
    vehicleMap,
    allowCurrentTargets,
  }) : { ok: true, targets: [] };
  if (!validation.ok) return { ok: false, error: validation.error };
  let concreteIndex = 0;
  const targets = orderConfigInferenceTargets(canonicalTargets.map((target) => (
    hasConfigInferenceSymbolicFields(target) ? target : validation.targets[concreteIndex++]
  )));
  const ops = [];
  for (const def of defs) {
    const previous = originalDefs.find((item) => item.id === def.id);
    if (!previous || stableJsonText(previous) !== stableJsonText(def)) {
      ops.push({ type: "projectDef.set", value: def, mergeStrategy: CONFIG_INFERENCE_ADDITIVE_MERGE });
    }
  }
  for (const vehicle of touchedVehicles) {
    const mapping = vehicleMap[vehicle];
    if (stableJsonText(originalVehicleMap[vehicle] || null) !== stableJsonText(mapping)) {
      ops.push({
        type: "byProject.set",
        projectId: pid,
        path: ["vehicleMap", vehicle],
        value: mapping,
        mergeStrategy: CONFIG_INFERENCE_ADDITIVE_MERGE,
      });
    }
  }
  cfg.projectDefs = defs;
  projectBucket(cfg, pid).vehicleMap = vehicleMap;
  const configurationGuard = {
    projectDefs: ops
      .filter((op) => op.type === "projectDef.set")
      .map((op) => ({
        id: String(op.value?.id || ""),
        value: cloneJson(originalDefs.find((def) => def.id === op.value?.id) || null),
      })),
    vehicles: ops
      .filter((op) => op.type === "byProject.set" && op.path?.[0] === "vehicleMap")
      .map((op) => ({
        vehicle: String(op.path?.[1] || ""),
        value: cloneJson(Object.hasOwn(originalVehicleMap, op.path?.[1]) ? originalVehicleMap[op.path[1]] : null),
      })),
  };
  for (const key of ["repositories", "applications", "vehicles", "branches", "flavors"]) {
    changes[key] = [...new Set(changes[key].filter(Boolean))];
  }
  return {
    ok: true,
    targets,
    ops,
    configurationGuard,
    projectDefsChanged: ops.some((op) => op.type === "projectDef.set"),
    configurationUpdates: { ...changes, changed: ops.length > 0 },
  };
}

export function buildConfigInferenceSnapshot(projectId, targets, input = {}) {
  const pid = projectId || defaultPid();
  const inputTargets = orderConfigInferenceTargets(normalizeConfigInferenceTargets(targets));
  const inputGraphValidation = validateConfigInferenceTargetGraph(inputTargets);
  if (!inputGraphValidation.ok) return inputGraphValidation;
  const registry = configInferenceRegistrySnapshot(pid);
  const validation = validateConfigInferenceTargets(inputTargets, {
    projectDefs: registry.projectDefs,
    vehicleMap: registry.vehicleMap,
    allowCurrentTargets: Array.isArray(input.allowCurrentTargets) ? input.allowCurrentTargets : [],
  });
  if (!validation.ok) return { ok: false, error: validation.error };
  const normalized = orderConfigInferenceTargets(validation.targets);
  if (!normalized.length) return { ok: false, error: "至少需要一个工程配置目标" };
  const graphValidation = validateConfigInferenceTargetGraph(normalized);
  if (!graphValidation.ok) return graphValidation;
  const localResolution = configInferenceLocalResolution(normalized, input.localProjectBindings);
  const resolved = localResolution._resolved.map((row, index) => ({
    target: normalized[index],
    project: row.project,
  }));
  // order 只控制展示/执行顺序，不能决定主工程身份。优先选择显式 primary；
  // 纯仓库/工具目标没有 primary 时以 standalone（或旧数据首项）作为执行锚点。
  const anchorIndex = configInferenceAnchorIndex(normalized);
  const anchorTarget = normalized[anchorIndex];
  const allLocal = resolved.every((item) => item.project?.path && fs.existsSync(item.project.path));
  let snapshot;
  if (allLocal) {
    const primary = resolved[anchorIndex];
    const branches = {};
    const flavors = [];
    for (const item of resolved) {
      if (item.target.branch) branches[item.project.path] = item.target.branch;
      if (item.target.flavor) flavors.push({ path: item.project.path, flavor: item.target.flavor });
    }
    snapshot = {
      mode: "local",
      primaryProjectId: primary.project.id,
      projectDefId: primary.target.repositoryId,
      extraProjects: resolved
        .filter((item, index) => index !== anchorIndex)
        .map((item) => ({ path: item.project.path, name: item.project.name || item.target.repositoryName })),
      branches,
      flavors,
      sourceTitle: String(input.sourceTitle || "AI 配置推理").slice(0, 80),
    };
  } else {
    snapshot = {
      mode: "remote",
      primaryProjectId: null,
      projectDefId: anchorTarget.repositoryId,
      extraProjects: [],
      branches: {},
      flavors: [],
      remotePull: {
        tbId: String(input.ticketId || "").trim(),
        vehicle: anchorTarget.vehicle || "",
        entries: normalized.map((target) => ({
          projectId: target.repositoryId,
          branch: target.branch,
          flavor: target.flavor,
          projectType: target.projectType,
          targetRole: target.targetRole,
          repositoryOnly: target.repositoryOnly === true,
        })),
      },
      sourceTitle: String(input.sourceTitle || "AI 配置推理").slice(0, 80),
    };
  }
  const apps = [...new Set(normalized.map((target) => target.appName).filter(Boolean))];
  const vehicles = [...new Set(normalized.map((target) => target.vehicle).filter(Boolean))];
  return {
    ok: true,
    snapshot,
    localResolution: {
      complete: localResolution.complete,
      targets: localResolution.targets,
      projects: localResolution.projects,
    },
    summary: {
      appName: apps.join("、"),
      vehicle: vehicles.join("、"),
      projectName: anchorTarget.repositoryName || anchorTarget.repositoryId,
      repositories: normalized.map((target) => target.repositoryName || target.repositoryId),
      branch: anchorTarget.branch || "",
      flavor: anchorTarget.flavor || "",
      extras: normalized
        .filter((_, index) => index !== anchorIndex)
        .map((target) => target.repositoryName || target.repositoryId),
      projectExists: allLocal,
      remoteRequired: !allLocal,
    },
  };
}

function buildReviewedConfigInferenceSnapshot(projectId, targets, input = {}) {
  const normalized = orderConfigInferenceTargets(normalizeConfigInferenceTargets(targets));
  if (!normalized.length) return { ok: false, code: "CONFIG_INFERENCE_SNAPSHOT_EMPTY", error: "没有可应用的工程配置目标" };
  const symbolicTargets = normalized.filter(hasConfigInferenceSymbolicFields);
  if (symbolicTargets.length) {
    return {
      ok: false,
      code: "CONFIG_INFERENCE_SNAPSHOT_SYMBOLIC",
      blockedBySymbolic: true,
      symbolicTargetIds: symbolicTargets.map((target, index) => String(target.targetId || `target_${index + 1}`)),
      error: "工程配置仍有代号字段，整组目标暂不应用；请先替换为实际值",
    };
  }
  return buildConfigInferenceSnapshot(projectId, normalized, input);
}

function configInferenceReviewConflictItems(row = {}) {
  const conflicts = row?.prediction?.quality?.conflicts;
  if (!isPlainObject(conflicts)) return [];
  const declared = Array.isArray(conflicts.items) ? conflicts.items : [];
  const fallbackDimensions = [
    ...(Array.isArray(conflicts.reviewDimensions) ? conflicts.reviewDimensions : []),
    ...(Array.isArray(conflicts.hardDimensions) ? conflicts.hardDimensions : []),
    ...(Array.isArray(conflicts.softDimensions) ? conflicts.softDimensions : []),
  ];
  const source = declared.length
    ? declared
    : fallbackDimensions.map((dimension) => ({ dimension, resolutionRequired: true }));
  const seen = new Set();
  return source.flatMap((item) => {
    const dimension = String(item?.dimension || "").trim();
    if (!dimension || item?.resolutionRequired === false || seen.has(dimension)) return [];
    seen.add(dimension);
    return [{
      id: String(item?.id || `source_conflict:${dimension}`).slice(0, 300),
      dimension,
      severity: "blocking",
      resolutionRequired: true,
      recommendedValue: String(item?.recommendedValue || "").slice(0, 2000),
      candidates: cloneJson(Array.isArray(item?.candidates) ? item.candidates : []),
    }];
  });
}

function configInferenceConflictTargetFingerprint(targets = []) {
  const normalized = orderConfigInferenceTargets(normalizeConfigInferenceTargets(targets));
  return stableJsonText(normalized.map((target, index) => ({
    appName: String(target.appName || "").trim(),
    vehicle: String(target.vehicle || "").trim(),
    repositoryId: String(target.repositoryId || "").trim(),
    branch: String(target.branch || "").trim(),
    flavor: String(target.flavor || "").trim(),
    targetRole: String(target.targetRole || "").trim(),
    repositoryOnly: target.repositoryOnly === true,
    order: Math.max(1, Number(target.order) || index + 1),
  })));
}

export function __testConfigInferenceConflictTargetFingerprint(targets = []) {
  return configInferenceConflictTargetFingerprint(targets);
}

function configInferenceConflictResolutionGate(row, decision, targets, input = {}) {
  const conflicts = configInferenceReviewConflictItems(row);
  if (!conflicts.length || !["correct", "corrected"].includes(decision)) {
    return { ok: true, conflicts, resolutions: {}, targetFingerprint: "" };
  }
  if (decision !== "corrected") {
    return {
      ok: false,
      statusCode: 409,
      code: "CONFIG_INFERENCE_CONFLICT_REVIEW_REQUIRED",
      error: "不同来源的推理结论存在矛盾，请逐项裁决并以“纠正后正确”提交",
      conflicts,
      unresolvedConflicts: conflicts.map((item) => item.dimension),
    };
  }
  const targetFingerprint = configInferenceConflictTargetFingerprint(targets);
  const submitted = isPlainObject(input) ? input : {};
  const resolutions = {};
  const unresolvedConflicts = [];
  for (const conflict of conflicts) {
    const raw = isPlainObject(submitted[conflict.dimension]) ? submitted[conflict.dimension] : {};
    const acknowledged = raw.acknowledged === true;
    const submittedFingerprint = String(raw.targetFingerprint || "");
    if (!acknowledged || submittedFingerprint !== targetFingerprint) {
      unresolvedConflicts.push(conflict.dimension);
      continue;
    }
    resolutions[conflict.dimension] = {
      acknowledged: true,
      selectedValue: String(raw.selectedValue || "").trim().slice(0, 2000),
      targetFingerprint,
    };
  }
  if (unresolvedConflicts.length) {
    return {
      ok: false,
      statusCode: 409,
      code: "CONFIG_INFERENCE_CONFLICT_REVIEW_REQUIRED",
      error: `以下跨来源冲突尚未按当前工程配置完成裁决：${unresolvedConflicts.join("、")}`,
      conflicts,
      unresolvedConflicts,
      targetFingerprint,
    };
  }
  return { ok: true, conflicts, resolutions, targetFingerprint };
}

function prepareConfigInferenceReviewSnapshot(projectId, id, input = {}, { rememberLocalBindings = false } = {}) {
  const pid = explicitConfigInferenceProjectId(projectId);
  const key = explicitConfigInferenceRunId(id);
  if (!pid || !key) return { ok: false, statusCode: 400, error: "配置推理快照预览必须指定有效的 TB 项目和 runId" };
  const cfg = loadRawConfig();
  const root = configInferenceRoot(cfg, pid);
  const row = root.runs[key];
  if (!row) return { ok: false, statusCode: 404, missing: true, error: "配置推理记录不存在" };
  const decision = String(input.decision || "").trim();
  if (!["correct", "corrected"].includes(decision) || input.apply !== true) {
    return { ok: false, error: "本次复核没有需要应用的工程配置" };
  }
  if (decision === "corrected" && input.correctedPrediction?.noTargets === true) {
    return { ok: false, error: "本次复核已确认不需要工程配置目标" };
  }
  const sourceTargets = decision === "corrected"
    ? normalizeReviewedConfigInferenceTargets(input.correctedPrediction?.targets || [])
    : normalizeConfigInferenceTargets(row.prediction?.targets || []);
  const persistedTargets = configInferencePersistedTargets(pid, root, sourceTargets);
  const targets = orderConfigInferenceTargets(configInferenceBoundTargets(pid, root, persistedTargets));
  const conflictGate = configInferenceConflictResolutionGate(
    row,
    decision,
    targets,
    input.conflictResolutions,
  );
  if (!conflictGate.ok) return conflictGate;
  const localBindingPreparation = prepareConfigInferenceLocalBindings(targets, input.localProjectBindings);
  if (!localBindingPreparation.ok) return localBindingPreparation;
  if (row.trigger !== "training_random") {
    const localSelectionGate = requireConfigInferenceLocalSelection(targets, localBindingPreparation.bindings);
    if (!localSelectionGate.ok) return localSelectionGate;
  }
  if (rememberLocalBindings && localBindingPreparation.bindings.some((binding) => binding.projectId)) {
    saveRepositoryBindings(localBindingPreparation.bindings);
  }
  const result = buildReviewedConfigInferenceSnapshot(pid, targets, {
    ticketId: row.ticket?.ticketId || row.ticket?.tbTaskId,
    sourceTitle: `AI复核·${row.ticket?.title || row.ticket?.ticketId || "配置"}`,
    allowCurrentTargets: row.currentConfig?.targets || [],
    localProjectBindings: localBindingPreparation.bindings,
  });
  if (result.ok && result.snapshot) {
    result.snapshot.configInference = {
      runId: row.id,
      targetFingerprint: configInferenceTargetGraphFingerprint(targets),
      reviewedDecision: decision,
    };
  }
  return result;
}

// 复核保存失败时，用户已经确认的工程配置仍应尽量继续应用；但该快照必须由
// 服务端基于当前 run、完整目标图和本机绑定重新校验，不能由前端拿旧远程快照猜测。
// 纯预览不写 review、RAG、配置或本机绑定记忆。
export function previewConfigInferenceReviewSnapshot(projectId, id, input = {}) {
  return prepareConfigInferenceReviewSnapshot(projectId, id, input);
}

// Git commit 等“先复核、后创建”入口只能消费已经落库的 AI 复核结果。
// 客户端只重传本机工程选择；车型、分支、Flavor 和依赖目标必须来自已保存的 run，
// 不能接收客户端自行拼装的 targets 或 snapshot。
export function getReviewedConfigInferenceSnapshot(projectId, id, input = {}) {
  const pid = explicitConfigInferenceProjectId(projectId);
  const key = explicitConfigInferenceRunId(id);
  if (!pid || !key) {
    return {
      ok: false,
      statusCode: 400,
      code: "CONFIG_INFERENCE_REVIEW_REQUIRED",
      error: "正式创建故事点前必须完成 AI 配置推理复核",
    };
  }
  const cfg = loadRawConfig();
  const root = configInferenceRoot(cfg, pid);
  const row = root.runs[key];
  if (!row?.review) {
    return {
      ok: false,
      statusCode: 409,
      code: "CONFIG_INFERENCE_REVIEW_REQUIRED",
      error: "AI 配置推理尚未由用户确认，不能创建故事点",
    };
  }
  const decision = String(row.review.decision || "").trim();
  if (!["correct", "corrected"].includes(decision)) {
    return {
      ok: false,
      statusCode: 409,
      code: "CONFIG_INFERENCE_REVIEW_NOT_APPLICABLE",
      error: "本次 AI 推理复核没有可应用的工程配置，不能创建故事点",
    };
  }
  const sourceTargets = decision === "corrected"
    ? row.review.correctedPrediction?.targets || []
    : row.prediction?.targets || [];
  const persistedTargets = configInferencePersistedTargets(pid, root, sourceTargets);
  const targets = orderConfigInferenceTargets(configInferenceBoundTargets(pid, root, persistedTargets));
  const conflictGate = configInferenceConflictResolutionGate(
    row,
    decision,
    targets,
    row.review.conflictResolutions,
  );
  if (!conflictGate.ok) return conflictGate;
  const localBindingPreparation = prepareConfigInferenceLocalBindings(targets, input.localProjectBindings);
  if (!localBindingPreparation.ok) return localBindingPreparation;
  const localSelectionGate = requireConfigInferenceLocalSelection(
    targets,
    localBindingPreparation.bindings,
  );
  if (!localSelectionGate.ok) return localSelectionGate;
  const result = buildReviewedConfigInferenceSnapshot(pid, targets, {
    ticketId: row.ticket?.ticketId || row.ticket?.tbTaskId,
    sourceTitle: `AI复核·${row.ticket?.title || row.ticket?.ticketId || "配置"}`,
    allowCurrentTargets: row.currentConfig?.targets || [],
    localProjectBindings: localBindingPreparation.bindings,
  });
  if (!result.ok) return result;
  return {
    ...result,
    runId: row.id,
    trigger: row.trigger,
    ticket: cloneJson(row.ticket || {}),
    targets,
    localProjectBindings: localBindingPreparation.bindings,
    conflicts: conflictGate.conflicts,
    conflictResolutions: conflictGate.resolutions,
    conflictTargetFingerprint: conflictGate.targetFingerprint,
  };
}

// 业务复核写入失败不代表用户的本机选择无效。路由确认完整目标图和本机工程均
// 可安全关联后，单独保存设备本地的“仓库+目标分支 → 本机工程 ID”记忆；绝对
// 路径仍只存在 devbench-projects.json 的 projects 中，不进入共享 RAG。
export function rememberConfigInferenceReviewLocalBindings(projectId, id, input = {}) {
  return prepareConfigInferenceReviewSnapshot(projectId, id, input, { rememberLocalBindings: true });
}

export function runConfigInference(projectId, input = {}) {
  const ticketInput = isPlainObject(input.ticket) ? input.ticket : input;
  const projectGuard = configInferenceProjectGuard(projectId, ticketInput?.projectId || ticketInput?.tbProjectId);
  const pid = projectGuard.ok ? projectGuard.projectId : "";
  if (!projectGuard.ok) return projectGuard;
  if (!pid) return { ok: false, error: "配置推理必须指定 TB 项目" };
  const sourceInputProvided = input.trainingSource !== undefined && input.trainingSource !== null;
  const trainingSource = normalizeConfigInferenceSource(input.trainingSource, pid, { capturedAt: Date.now() });
  if (sourceInputProvided && !trainingSource) return { ok: false, error: "训练来源格式无效" };
  if (trainingSource?.projectId && trainingSource.projectId !== pid) return { ok: false, error: "训练来源与配置推理 TB 项目不一致" };
  const registry = configInferenceRegistrySnapshot(pid);
  let cfg = loadRawConfig();
  let root = configInferenceRoot(cfg, pid);
  const ticket = normalizeStoredConfigInferenceTicket(ticketInput, pid);
  const trainingSessionId = String(input.trainingSessionId || "").trim().slice(0, 160);
  const trainingTicketId = configInferenceTicketId(ticket);
  if (input.trainingClaimRequired === true) {
    const claim = root.trainingClaims[trainingTicketId];
    if (!trainingSessionId || !trainingTicketId || !configInferenceTrainingClaimActive(claim) || claim.sessionId !== trainingSessionId) {
      return { ok: false, statusCode: 409, busy: true, error: "TB 单训练占用已释放或不属于当前会话，请重新抽取" };
    }
  }
  const storedSamples = configInferenceLearningSamples(root);
  const servingRelease = configInferenceReleaseState(pid, root, registry);
  const inferenceSamples = configInferenceServingSamples(
    pid,
    root,
    registry,
    servingRelease,
    [...storedSamples, ...legacyConfigInferenceSamples(pid, registry)],
  );
  const responsePrediction = decorateConfigInferenceServingResult(inferConfigFromTicket({
    projectId: pid,
    ticket,
    projectDefs: registry.projectDefs,
    vehicleMap: registry.vehicleMap,
    keywordMappings: registry.keywordMappings,
    samples: inferenceSamples,
    valueBindings: configInferenceEffectiveValueBindings(pid, root),
    calibrator: servingRelease.calibrator,
  }), servingRelease);
  if (input.captureSignals !== false) {
    captureConfigInferenceKeywords(pid, responsePrediction.signals || extractConfigInferenceSignals(ticket, registry.keywordMappings));
    // 自动采集会通过独立共享写入更新同一项目桶；重新读取，避免随后保存 run 时用旧快照覆盖新 key。
    cfg = loadRawConfig();
    root = configInferenceRoot(cfg, pid);
  }
  const prediction = configInferencePersistedPrediction(pid, root, responsePrediction);
  const releaseTrial = configInferenceBuildReleaseTrial(pid, root, registry, ticket);
  const id = storyTrainingId("CI");
  const now = Date.now();
  const row = {
    id,
    projectId: pid,
    trigger: String(input.trigger || "manual"),
    reopenScope: input.reopenScope ? cloneJson(input.reopenScope) : null,
    ...(input.createScope ? { createScope: cloneJson(input.createScope) } : {}),
    trainingSessionId,
    caseFingerprint: configInferenceCaseFingerprint(pid, ticket),
    ticket,
    trainingSource,
    prediction,
    releaseTrial,
    sourceCoverageGate: configInferenceSourceCoverageGate(ticket),
    currentConfig: input.tabId
      ? configInferencePersistedCurrentConfig(pid, root, getTabConfigInferenceActual(input.tabId, pid))
      : null,
    review: null,
    version: CONFIG_INFERENCE_VERSION,
    registryVersion: String(registry.version || ""),
    inferenceRevisions: configInferenceRevisionSnapshot(registry, root),
    createdAt: now,
    updatedAt: now,
  };
  root.runs[id] = row;
  const expectedTrimDeletes = new Map();
  const ops = [
    { type: "byProject.set", projectId: pid, path: ["aiTraining", "configInference", "runs", id], value: row },
    ...trimConfigInferenceSection(root, "runs", pid, expectedTrimDeletes),
  ];
  if (input.trainingClaimRequired === true) {
    const claimUpdatedAt = Math.max(
      now,
      configInferenceTimestamp(root.trainingClaims[trainingTicketId]),
      configInferenceTimestamp(root.tombstones?.trainingClaims?.[trainingTicketId]) + 1,
    );
    const claim = {
      ...root.trainingClaims[trainingTicketId],
      runId: id,
      expiresAt: claimUpdatedAt + CONFIG_INFERENCE_TRAINING_CLAIM_TTL_MS,
      updatedAt: claimUpdatedAt,
    };
    root.trainingClaims[trainingTicketId] = claim;
    ops.push({ type: "byProject.set", projectId: pid, path: ["aiTraining", "configInference", "trainingClaims", trainingTicketId], value: claim });
  }
  try {
    writeSharedOps(cfg, ops, {
      guard: (latest) => {
        const trimGuard = guardConfigInferenceTrimDeletes(latest, pid, expectedTrimDeletes);
        if (trimGuard !== true) return trimGuard;
        if (input.trainingClaimRequired !== true) return true;
        const latestRoot = configInferenceSharedRoot(latest, pid);
        const latestClaim = latestRoot.trainingClaims?.[trainingTicketId];
        if (latestRoot.trainedTickets?.[trainingTicketId]) return "该 TB 单已经完成训练";
        if (!configInferenceTrainingClaimActive(latestClaim)
          || latestClaim.sessionId !== trainingSessionId
          || (latestClaim.runId && latestClaim.runId !== id)) {
          return "TB 单训练占用已释放或不属于当前会话";
        }
        if (latestRoot.runs?.[id]) return "配置推理 runId 已存在";
        return true;
      },
    });
  } catch (error) {
    if (error?.code === "SHARED_WRITE_CONFLICT") {
      return { ok: false, statusCode: 409, busy: true, error: error.message || "TB 单训练状态已变化，请重新抽取" };
    }
    throw error;
  }
  const boundRow = configInferenceBoundRun(pid, root, row);
  const suggestion = buildConfigInferenceSnapshot(pid, boundRow.prediction?.targets || [], {
    ticketId: ticket.ticketId || ticket.tbTaskId,
    sourceTitle: `AI推理·${ticket.title || ticket.ticketId || "配置"}`,
    allowCurrentTargets: row.currentConfig?.targets || [],
  });
  // 同 TB 单再次创建故事点时，把上一次人工纠正带回前端预填，避免重复纠正。
  // 新 run 自身 review 为空会被 buildPriorConfigInferenceReviewDraft 跳过，
  // 命中的是同 TB 单历史 run 的已落库复核。
  const priorReviewDraft = buildPriorConfigInferenceReviewDraft(root, ticket);
  return {
    ok: true,
    data: {
      ...boundRow,
      options: registry.options,
      suggestedSnapshot: suggestion.ok ? suggestion.snapshot : null,
      summary: suggestion.ok ? suggestion.summary : null,
      localResolution: suggestion.ok ? suggestion.localResolution : null,
      _reviewDraft: priorReviewDraft,
    },
  };
}

function configInferencePredictionReviewIdentity(prediction = {}) {
  const targets = orderConfigInferenceTargets(normalizeConfigInferenceTargets(prediction?.targets || []))
    .map((target, index) => ({
      appName: String(target.appName || ""),
      vehicle: String(target.vehicle || ""),
      repositoryId: String(target.repositoryId || ""),
      branch: String(target.branch || ""),
      flavor: String(target.flavor || ""),
      projectType: String(target.projectType || ""),
      targetRole: String(target.targetRole || (index === 0 ? "primary" : "dependency")),
      repositoryOnly: target.repositoryOnly === true,
      order: index + 1,
      symbolicFields: configInferenceSymbolicFields(target).map((field) => ({
        field,
        feature: String(target.fieldStates?.[field]?.feature || ""),
      })),
    }));
  return stableJsonText({
    status: String(prediction?.status || ""),
    targets,
    missingInformation: [...new Set((prediction?.missingInformation || []).map((item) => String(item || "").trim()).filter(Boolean))].sort(),
  });
}

export function configInferenceTargetGraphFingerprint(targets = []) {
  return configInferenceDigest(configInferencePredictionReviewIdentity({
    status: targets.length ? "TARGET_GRAPH" : "NO_TARGETS",
    targets,
  }));
}

export function configInferenceTargetsContainSymbolicFields(targets = []) {
  return normalizeConfigInferenceTargets(targets).some(hasConfigInferenceSymbolicFields);
}

function guardConfigInferenceRecoveryClaim(claim, trainingSessionId, runId) {
  if (!configInferenceTrainingClaimActive(claim)) return true;
  if (claim.sessionId !== trainingSessionId) return "该 TB 单已被其它会话占用";
  if (claim.runId && claim.runId !== runId) return "该 TB 单已经生成另一条有效推理记录";
  return true;
}

export function __testGuardConfigInferenceRecoveryClaim(claim, trainingSessionId, runId) {
  return guardConfigInferenceRecoveryClaim(claim, trainingSessionId, runId);
}

/**
 * 恢复“随机抽题已经成功返回给页面，但共享整行被旧 Gateway 快照覆盖”的孤儿 run。
 * 调用方必须先用服务端审计日志验证 project/run/ticket；恢复时重新用当前注册表、
 * RAG 和 TB 快照推理，不接受客户端上传的 prediction 作为权威结果。
 */
export function recoverConfigInferenceRun(projectId, id, input = {}) {
  const projectGuard = configInferenceProjectGuard(
    projectId,
    input?.ticket?.projectId || input?.ticket?.tbProjectId,
  );
  const pid = projectGuard.ok ? projectGuard.projectId : "";
  if (!projectGuard.ok) return projectGuard;
  const key = String(id || "").trim();
  if (!pid || !key || !safeSharedSegment(key)) return { ok: false, statusCode: 400, error: "恢复配置推理缺少有效的项目或 runId" };
  if (input.verifiedRandomDraw !== true) return { ok: false, statusCode: 403, error: "缺失记录只能依据服务端随机抽题审计恢复" };

  const cfg = loadRawConfig();
  const root = configInferenceRoot(cfg, pid);
  if (root.runs[key]) {
    const registry = configInferenceRegistrySnapshot(pid);
    const data = { ...configInferenceBoundRun(pid, root, root.runs[key]), options: registry.options };
    return {
      ok: true,
      recovered: !!root.runs[key].recovery,
      idempotent: true,
      predictionMatches: configInferencePredictionReviewIdentity(data.prediction)
        === configInferencePredictionReviewIdentity(input.expectedPrediction || {}),
      data,
    };
  }
  if (root.tombstones?.runs?.[key]) {
    return { ok: false, statusCode: 410, deleted: true, error: "该配置推理记录已被明确删除，不能自动恢复" };
  }

  const ticket = normalizeStoredConfigInferenceTicket(input.ticket || {}, pid);
  const ticketId = configInferenceTicketId(ticket);
  const verifiedTicketId = String(input.verifiedTicketId || "").trim();
  if (!ticketId || ticketId !== verifiedTicketId) return { ok: false, statusCode: 409, error: "恢复记录的 TB 单与随机抽题审计不一致" };
  if (root.trainedTickets[ticketId]) {
    return { ok: false, statusCode: 409, alreadyTrained: true, error: "该 TB 单已经完成评分，不能从旧页面重复恢复训练" };
  }

  const trainingSessionId = String(input.trainingSessionId || "").trim().slice(0, 160);
  if (!trainingSessionId) return { ok: false, statusCode: 409, error: "恢复随机训练记录缺少原训练会话" };
  const currentClaim = root.trainingClaims[ticketId];
  const currentClaimGuard = guardConfigInferenceRecoveryClaim(currentClaim, trainingSessionId, key);
  if (currentClaimGuard !== true) {
    return { ok: false, statusCode: 409, busy: true, error: currentClaimGuard };
  }

  const registry = configInferenceRegistrySnapshot(pid);
  const servingRelease = configInferenceReleaseState(pid, root, registry);
  const inferenceSamples = configInferenceServingSamples(
    pid,
    root,
    registry,
    servingRelease,
    [
      ...configInferenceLearningSamples(root),
      ...legacyConfigInferenceSamples(pid, registry),
    ],
  );
  const responsePrediction = decorateConfigInferenceServingResult(inferConfigFromTicket({
    projectId: pid,
    ticket,
    projectDefs: registry.projectDefs,
    vehicleMap: registry.vehicleMap,
    keywordMappings: registry.keywordMappings,
    samples: inferenceSamples,
    valueBindings: configInferenceEffectiveValueBindings(pid, root),
    calibrator: servingRelease.calibrator,
  }), servingRelease);
  const prediction = configInferencePersistedPrediction(pid, root, responsePrediction);
  const releaseTrial = configInferenceBuildReleaseTrial(pid, root, registry, ticket);
  const now = Date.now();
  const trainingSource = normalizeConfigInferenceSource(input.trainingSource || root.settings.taskSource, pid, { capturedAt: now });
  const row = {
    id: key,
    projectId: pid,
    trigger: "training_random",
    trainingSessionId,
    caseFingerprint: configInferenceCaseFingerprint(pid, ticket),
    ticket,
    trainingSource,
    prediction,
    releaseTrial,
    sourceCoverageGate: configInferenceSourceCoverageGate(ticket),
    currentConfig: null,
    review: null,
    version: CONFIG_INFERENCE_VERSION,
    registryVersion: String(registry.version || ""),
    inferenceRevisions: configInferenceRevisionSnapshot(registry, root),
    recovery: {
      reason: "shared_snapshot_lost_after_random_draw",
      verifiedBy: "server_audit",
      auditAt: Number(input.verifiedAuditAt || 0) || now,
      recoveredAt: now,
    },
    createdAt: Number(input.verifiedAuditAt || input.createdAt || 0) || now,
    updatedAt: now,
  };
  const claimUpdatedAt = Math.max(
    now,
    configInferenceTimestamp(currentClaim),
    configInferenceTimestamp(root.tombstones?.trainingClaims?.[ticketId]) + 1,
  );
  const claim = {
    ...(isPlainObject(currentClaim) ? currentClaim : {}),
    id: ticketId,
    tbTaskId: ticketId,
    sessionId: trainingSessionId,
    runId: key,
    claimedAt: Number(currentClaim?.claimedAt || 0) || claimUpdatedAt,
    expiresAt: claimUpdatedAt + CONFIG_INFERENCE_TRAINING_CLAIM_TTL_MS,
    createdAt: Number(currentClaim?.createdAt || 0) || claimUpdatedAt,
    updatedAt: claimUpdatedAt,
  };
  root.runs[key] = row;
  root.trainingClaims[ticketId] = claim;
  const expectedTrimDeletes = new Map();
  try {
    writeSharedOps(cfg, [
      { type: "byProject.set", projectId: pid, path: ["aiTraining", "configInference", "runs", key], value: row },
      { type: "byProject.set", projectId: pid, path: ["aiTraining", "configInference", "trainingClaims", ticketId], value: claim },
      ...trimConfigInferenceSection(root, "runs", pid, expectedTrimDeletes),
    ], {
      guard: (latest) => {
        const trimGuard = guardConfigInferenceTrimDeletes(latest, pid, expectedTrimDeletes);
        if (trimGuard !== true) return trimGuard;
        const latestRoot = configInferenceSharedRoot(latest, pid);
        if (latestRoot.runs?.[key]) return "配置推理记录已经恢复";
        if (latestRoot.tombstones?.runs?.[key]) return "配置推理记录已被明确删除";
        if (latestRoot.trainedTickets?.[ticketId]) return "该 TB 单已经完成评分";
        const latestClaim = latestRoot.trainingClaims?.[ticketId];
        return guardConfigInferenceRecoveryClaim(latestClaim, trainingSessionId, key);
      },
    });
  } catch (error) {
    if (error?.code === "SHARED_WRITE_CONFLICT") return recoverConfigInferenceRun(pid, key, input);
    throw error;
  }
  const boundRow = configInferenceBoundRun(pid, root, row);
  const suggestion = buildConfigInferenceSnapshot(pid, boundRow.prediction?.targets || [], {
    ticketId,
    sourceTitle: `AI恢复·${ticket.title || ticketId}`,
  });
  return {
    ok: true,
    recovered: true,
    predictionMatches: configInferencePredictionReviewIdentity(boundRow.prediction)
      === configInferencePredictionReviewIdentity(input.expectedPrediction || {}),
    data: {
      ...boundRow,
      options: registry.options,
      suggestedSnapshot: suggestion.ok ? suggestion.snapshot : null,
      summary: suggestion.ok ? suggestion.summary : null,
      localResolution: suggestion.ok ? suggestion.localResolution : null,
    },
  };
}

export function refreshConfigInferenceRun(projectId, id, input = {}) {
  const pid = explicitConfigInferenceProjectId(projectId);
  const key = explicitConfigInferenceRunId(id);
  if (!pid || !key) return { ok: false, statusCode: 400, error: "刷新配置推理必须指定有效的 TB 项目和 runId" };
  const cfg = loadRawConfig();
  const root = configInferenceRoot(cfg, pid);
  const row = root.runs[key];
  if (!row) return { ok: false, error: "配置推理记录不存在" };
  if (row.review) return { ok: false, statusCode: 409, error: "已评分的配置推理不可重算；其学习结果必须保留审计链路" };
  const expectedRefreshState = {
    updatedAt: Number(row.updatedAt || 0),
    version: String(row.version || ""),
    predictionRevision: Number(row.predictionRevision || 0),
  };

  const registry = configInferenceRegistrySnapshot(pid);
  const staleReasons = configInferenceRunStaleReasons(row, registry, root);
  const stale = staleReasons.length > 0;
  if (!stale && input.force !== true) {
    return {
      ok: true,
      refreshed: false,
      idempotent: true,
      data: { ...configInferenceBoundRun(pid, root, row), stalePrediction: false, options: registry.options },
    };
  }

  const storedSamples = configInferenceLearningSamples(root);
  const servingRelease = configInferenceReleaseState(pid, root, registry);
  const inferenceSamples = configInferenceServingSamples(
    pid,
    root,
    registry,
    servingRelease,
    [...storedSamples, ...legacyConfigInferenceSamples(pid, registry)],
  );
  const responsePrediction = decorateConfigInferenceServingResult(inferConfigFromTicket({
    projectId: pid,
    ticket: row.ticket,
    projectDefs: registry.projectDefs,
    vehicleMap: registry.vehicleMap,
    keywordMappings: registry.keywordMappings,
    samples: inferenceSamples,
    valueBindings: configInferenceEffectiveValueBindings(pid, root),
    calibrator: servingRelease.calibrator,
  }), servingRelease);
  const prediction = configInferencePersistedPrediction(pid, root, responsePrediction);
  const releaseTrial = configInferenceBuildReleaseTrial(
    pid,
    root,
    registry,
    row.ticket,
  );
  const now = Date.now();
  const previousVersion = String(row.version || "unknown");
  row.prediction = prediction;
  row.releaseTrial = releaseTrial;
  row.version = CONFIG_INFERENCE_VERSION;
  row.registryVersion = String(registry.version || "");
  row.inferenceRevisions = configInferenceRevisionSnapshot(registry, root);
  row.caseFingerprint = configInferenceCaseFingerprint(pid, row.ticket);
  row.sourceCoverageGate = configInferenceSourceCoverageGate(row.ticket || {});
  row.predictionRevision = Math.max(0, Number(row.predictionRevision) || 0) + 1;
  row.refresh = {
    reason: String(input.reason || (stale ? `inputs_changed:${staleReasons.join(",")}` : "manual")).trim().slice(0, 200),
    staleReasons,
    fromVersion: previousVersion,
    toVersion: CONFIG_INFERENCE_VERSION,
    refreshedAt: now,
  };
  row.updatedAt = now;
  root.runs[row.id] = row;
  try {
    writeSharedOps(cfg, {
      type: "byProject.set",
      projectId: pid,
      path: ["aiTraining", "configInference", "runs", row.id],
      value: row,
    }, {
      guard: (latest) => {
        const latestRow = configInferenceSharedRoot(latest, pid).runs?.[row.id];
        if (!latestRow) return "配置推理记录已不存在";
        if (latestRow.review) return "配置推理记录已由其它请求完成评分";
        if (Number(latestRow.updatedAt || 0) !== expectedRefreshState.updatedAt
          || String(latestRow.version || "") !== expectedRefreshState.version
          || Number(latestRow.predictionRevision || 0) !== expectedRefreshState.predictionRevision) {
          return "配置推理记录已由其它 Gateway 重算";
        }
        return true;
      },
    });
  } catch (error) {
    if (error?.code === "SHARED_WRITE_CONFLICT") {
      return {
        ok: false,
        statusCode: 409,
        code: "CONFIG_INFERENCE_REFRESH_CONFLICT",
        error: error.message || "配置推理记录状态已变化，请刷新后重试",
      };
    }
    throw error;
  }
  const boundRow = configInferenceBoundRun(pid, root, row);
  const suggestion = buildConfigInferenceSnapshot(pid, boundRow.prediction?.targets || [], {
    ticketId: row.ticket?.ticketId || row.ticket?.tbTaskId,
    sourceTitle: `AI重算·${row.ticket?.title || row.ticket?.ticketId || "配置"}`,
    allowCurrentTargets: row.currentConfig?.targets || [],
  });
  return {
    ok: true,
    refreshed: true,
    data: {
      ...boundRow,
      stalePrediction: false,
      options: registry.options,
      suggestedSnapshot: suggestion.ok ? suggestion.snapshot : null,
      summary: suggestion.ok ? suggestion.summary : null,
      localResolution: suggestion.ok ? suggestion.localResolution : null,
    },
  };
}

function prepareConfigInferenceReviewedTargets(cfg, projectId, inputTargets, allowCurrentTargets, {
  persistConfig = false,
  allowEmpty = false,
} = {}) {
  let targets = orderConfigInferenceTargets(normalizeReviewedConfigInferenceTargets(inputTargets))
    .map((target, index) => ({ ...target, targetId: target.targetId || `target_${index + 1}` }));
  if (!targets.length) {
    return allowEmpty
      ? { ok: true, targets: [], configurationUpdates: { changed: false, removedAllTargets: true } }
      : { ok: false, error: "至少需要一个配置推理目标" };
  }
  const applicationTargets = targets.filter((target) => !target.repositoryOnly);
  if (applicationTargets.length === 1 && !applicationTargets.some((target) => target.targetRole === "primary")) {
    targets = targets.map((target) => target === applicationTargets[0] ? { ...target, targetRole: "primary" } : target);
  }
  const graphValidation = validateConfigInferenceTargetGraph(targets);
  if (!graphValidation.ok) return graphValidation;
  if (persistConfig) return prepareConfigInferenceTargetWriteback(cfg, projectId, targets, allowCurrentTargets);

  const unresolved = targets
    .filter(hasConfigInferenceSymbolicFields)
    .map((target) => ({ targetId: target.targetId, fields: configInferenceSymbolicFields(target) }));
  if (unresolved.length) {
    const registry = configInferenceRegistrySnapshot(projectId);
    for (const target of targets) {
      if (hasConfigInferenceSymbolicFields(target)) {
        const symbolicValidation = validateConfigInferenceSymbolicTarget(target, {
          projectDefs: registry.projectDefs,
          vehicleMap: registry.vehicleMap,
          allowCurrentTargets,
        });
        if (!symbolicValidation.ok) return symbolicValidation;
      } else {
        const validation = validateConfigInferenceTargets([target], {
          projectDefs: registry.projectDefs,
          vehicleMap: registry.vehicleMap,
          allowCurrentTargets,
        });
        if (!validation.ok) return validation;
      }
    }
    return {
      ok: true,
      targets,
      configurationUpdates: {
        changed: false,
        deferred: true,
        pendingReplacement: true,
        symbolicTargets: unresolved,
        unresolved,
      },
    };
  }

  const registry = configInferenceRegistrySnapshot(projectId);
  const validation = validateConfigInferenceTargets(targets, {
    projectDefs: registry.projectDefs,
    vehicleMap: registry.vehicleMap,
    allowCurrentTargets,
  });
  return validation.ok
    ? { ok: true, targets: orderConfigInferenceTargets(validation.targets), configurationUpdates: { changed: false } }
    : validation;
}

function configInferenceFeedbackTargetKey(target) {
  const symbolicFields = configInferenceSymbolicFields(target);
  const boundFields = target?.fieldBindings && typeof target.fieldBindings === "object"
    ? CONFIG_INFERENCE_DIMENSIONS.filter((field) => String(target.fieldBindings?.[field]?.logicalKey || "").trim())
    : [];
  if (boundFields.length && !symbolicFields.length) {
    return [
      "bound",
      ...CONFIG_INFERENCE_DIMENSIONS.map((dimension) => {
        const logicalKey = String(target.fieldBindings?.[dimension]?.logicalKey || "").trim().toLowerCase();
        return logicalKey
          ? `${dimension}.logicalKey=${logicalKey}`
          : `${dimension}.value=${String(target[dimension] || "").trim().toLowerCase()}`;
      }),
      `projectType=${String(target.projectType || "").trim().toLowerCase()}`,
      `repositoryOnly=${target.repositoryOnly === true ? "1" : "0"}`,
    ].join("|");
  }
  if (symbolicFields.length) {
    return [
      "symbolic",
      `targetId=${String(target.targetId || "").trim().toLowerCase()}`,
      ...CONFIG_INFERENCE_DIMENSIONS.map((dimension) => `${dimension}=${String(target[dimension] || "").trim().toLowerCase()}`),
      ...symbolicFields.map((field) => `${field}.feature=${String(target.fieldStates?.[field]?.feature || "").trim().toLowerCase()}`),
      `repositoryName=${String(target.repositoryName || "").trim().toLowerCase()}`,
      `gitUrl=${String(target.gitUrl || "").trim().toLowerCase()}`,
      `projectType=${String(target.projectType || "").trim().toLowerCase()}`,
      `repositoryOnly=${target.repositoryOnly === true ? "1" : "0"}`,
    ].join("|");
  }
  return target.repositoryOnly
    ? `repository|${String(target.repositoryId || "").trim().toLowerCase()}`
    : CONFIG_INFERENCE_DIMENSIONS
      .map((dimension) => String(target[dimension] || "").trim().toLowerCase())
      .join("|");
}

function configInferenceFeedbackTargetSubjectKey(target) {
  return [
    ...CONFIG_INFERENCE_DIMENSIONS.map((dimension) => String(target?.[dimension] || "").trim().toLowerCase()),
    String(target?.projectType || "").trim().toLowerCase(),
    target?.repositoryOnly === true ? "repository" : "application",
  ].join("|");
}

function preserveConfigInferenceReviewedBindings(projectId, root, requestedTargets, predictionTargets) {
  const originals = configInferencePersistedTargets(projectId, root, predictionTargets || [])
    .map((target, index) => ({ ...target, _reviewTargetId: String(target.targetId || `target_${index}`) }));
  const used = new Set();
  const requested = normalizeConfigInferenceTargets(requestedTargets || []);
  const bindingKeys = (target) => new Set(CONFIG_INFERENCE_BINDABLE_FIELDS
    .map((field) => String(target.fieldBindings?.[field]?.logicalKey || "").trim())
    .filter(Boolean));

  for (let index = 0; index < requested.length; index++) {
    const target = requested[index];
    const targetId = String(target.targetId || "").trim();
    const keys = bindingKeys(target);
    let matchIndex = originals.findIndex((candidate, candidateIndex) => (
      !used.has(candidateIndex) && targetId && candidate._reviewTargetId === targetId
    ));
    if (matchIndex < 0 && keys.size) {
      let best = { index: -1, score: 0 };
      originals.forEach((candidate, candidateIndex) => {
        if (used.has(candidateIndex)) return;
        const candidateKeys = bindingKeys(candidate);
        const score = [...keys].filter((key) => candidateKeys.has(key)).length;
        if (score > best.score) best = { index: candidateIndex, score };
      });
      matchIndex = best.index;
      if (matchIndex < 0) {
        return { ok: false, error: "工程配置目标的永久 logicalKey 不能修改或伪造" };
      }
    }
    if (matchIndex < 0) {
      // 没有 targetId 和旧 Key 的目标是用户明确新增/替换的工程身份，生成一组新 Key；
      // 被移除目标的旧 Key 仍保留在负向记忆中，不会被篡改或复用。
      const next = { ...target };
      delete next.fieldBindings;
      requested[index] = next;
      continue;
    }

    used.add(matchIndex);
    const original = originals[matchIndex];
    const fieldBindings = {};
    for (const field of CONFIG_INFERENCE_BINDABLE_FIELDS) {
      const previous = original.fieldBindings?.[field];
      const submitted = target.fieldBindings?.[field];
      const submittedKey = String(submitted?.logicalKey || "").trim();
      if (!previous?.logicalKey) {
        if (submittedKey) return { ok: false, error: `字段 ${field} 的永久 logicalKey 不能新增或伪造` };
        continue;
      }
      if (submittedKey && submittedKey !== previous.logicalKey) {
        return { ok: false, error: `字段 ${field} 的永久 logicalKey 不能修改` };
      }
      const symbolic = target.fieldStates?.[field]?.kind === "symbolic";
      const actualValue = symbolic ? "" : String(field === "order" ? target.order : target[field] || "").trim();
      fieldBindings[field] = {
        ...previous,
        ...(submitted || {}),
        logicalKey: previous.logicalKey,
        scopeKey: previous.scopeKey,
        actualValue,
        resolved: field === "order" ? Number(target.order) > 0 : !!actualValue && !symbolic,
        ...(field === "order" ? { replaceable: false } : {}),
      };
    }
    requested[index] = { ...target, fieldBindings };
  }
  return { ok: true, targets: requested };
}

export function reviewConfigInferenceRun(projectId, id, input = {}) {
  const pid = explicitConfigInferenceProjectId(projectId);
  const key = explicitConfigInferenceRunId(id);
  if (!pid || !key) return { ok: false, statusCode: 400, error: "配置推理复核必须指定有效的 TB 项目和 runId" };
  const cfg = loadRawConfig();
  const root = configInferenceRoot(cfg, pid);
  const row = root.runs[key];
  if (!row) return { ok: false, statusCode: 404, missing: true, error: "配置推理记录不存在" };
  const reviewTicketId = row.trigger === "training_random" ? configInferenceTicketId(row.ticket) : "";
  const existingTrainedTicket = reviewTicketId ? root.trainedTickets[reviewTicketId] : null;
  if (existingTrainedTicket && existingTrainedTicket.sourceRunId !== row.id) {
    return {
      ok: false,
      statusCode: 409,
      alreadyTrained: true,
      error: "该 TB 单已经由另一条训练记录完成评分，不能重复学习",
    };
  }
  if (row.trigger === "training_random" && !row.review) {
    const activeClaim = reviewTicketId ? root.trainingClaims[reviewTicketId] : null;
    if (!configInferenceTrainingClaimOwnsRun(activeClaim, row)) {
      return {
        ok: false,
        statusCode: 409,
        staleTrainingClaim: true,
        error: "当前训练记录已退出、过期或被新的训练会话接管，不能再提交评分",
      };
    }
  }
  // 页面为缺失记录恢复携带的是“用户实际看见的旧预测”。另一个并发请求可能
  // 已经先恢复 run，导致本请求不再进入 route 的 missing 分支；这里仍必须比较
  // 当前服务端预测，禁止旧请求在 RAG/注册表结果变化后盲目评分和学习。
  if (isPlainObject(input.recovery?.expectedPrediction)) {
    const boundRow = configInferenceBoundRun(pid, root, row);
    const expectedIdentity = configInferencePredictionReviewIdentity(input.recovery.expectedPrediction);
    const currentIdentity = configInferencePredictionReviewIdentity(boundRow.prediction);
    if (expectedIdentity !== currentIdentity) {
      const registry = configInferenceRegistrySnapshot(pid);
      return {
        ok: false,
        statusCode: 409,
        stale: true,
        refreshed: true,
        recovered: !!row.recovery,
        recoverable: true,
        error: "配置推理记录已按当前 TB 信息、RAG 和车型配置恢复；结果发生变化，请保留评分草稿并重新确认",
        data: { ...boundRow, options: registry.options },
      };
    }
  }
  const expectedReviewState = {
    updatedAt: Number(row.updatedAt || 0),
    version: String(row.version || ""),
    predictionRevision: Number(row.predictionRevision || 0),
  };
  const currentRevisionRegistry = configInferenceRegistrySnapshot(pid);
  if (!row.review && configInferenceRunNeedsRefresh(row, currentRevisionRegistry, root)) {
    const refreshed = refreshConfigInferenceRun(pid, row.id, { reason: "review_blocked_rules_upgraded" });
    if (!refreshed.ok) return refreshed;
    return {
      ...refreshed,
      ok: false,
      statusCode: 409,
      stale: true,
      refreshed: true,
      error: "推理规则已升级，旧预测已按当前 RAG 和车型配置重新计算；请确认新结果后再评分",
    };
  }
  const decisions = new Set(["correct", "corrected", "insufficient", "ticket_wrong"]);
  const decision = String(input.decision || "").trim();
  if (!decisions.has(decision)) return { ok: false, error: "请选择有效的复核结论" };
  let correctedTargets = normalizeReviewedConfigInferenceTargets(input.correctedPrediction?.targets || []);
  const noTargets = decision === "corrected" && input.correctedPrediction?.noTargets === true;
  if (noTargets && correctedTargets.length) {
    return { ok: false, error: "noTargets=true 只能与空工程目标一起提交" };
  }
  if (decision === "corrected"
    && !correctedTargets.length
    && !noTargets) {
    return { ok: false, error: "删除全部工程目标需要明确确认 noTargets=true" };
  }
  if (decision === "corrected" && correctedTargets.length) {
    const preserved = preserveConfigInferenceReviewedBindings(pid, root, correctedTargets, row.prediction?.targets || []);
    if (!preserved.ok) return preserved;
    correctedTargets = preserved.targets;
  }
  const rating = Math.max(1, Math.min(5, Number(input.rating) || (decision === "correct" ? 5 : decision === "corrected" ? 3 : 1)));
  const reason = String(input.reason || "").trim().slice(0, 4000);
  const finalPrediction = decision === "corrected"
    ? {
      ...(row.prediction || {}),
      ...(input.correctedPrediction || {}),
      targets: correctedTargets,
      noTargets,
    }
    : row.prediction;
  const conflictGate = configInferenceConflictResolutionGate(
    row,
    decision,
    finalPrediction?.targets || [],
    input.conflictResolutions,
  );
  if (!conflictGate.ok) return conflictGate;
  const localBindingPreparation = ["correct", "corrected"].includes(decision)
    ? prepareConfigInferenceLocalBindings(finalPrediction?.targets || [], input.localProjectBindings)
    : { ok: true, bindings: [] };
  if (!localBindingPreparation.ok) return localBindingPreparation;
  // 开发入口不能只依赖前端按钮门禁：旧页面、并发请求或直接 API 调用若省略
  // localProjectBindings，也不能把已发现的本机候选静默降级成远程拉取。
  // 随机训练只记录评分、不应用故事点配置，因此不要求选择本机 checkout。
  if (["correct", "corrected"].includes(decision) && row.trigger !== "training_random") {
    const localSelectionGate = requireConfigInferenceLocalSelection(
      finalPrediction?.targets || [],
      localBindingPreparation.bindings,
    );
    if (!localSelectionGate.ok) return localSelectionGate;
  }
  let registry = configInferenceRegistrySnapshot(pid);
  if (row.review) {
    let comparableTargets = normalizeConfigInferenceTargets(finalPrediction?.targets || []);
    if (decision === "corrected") {
      const retryPreparation = prepareConfigInferenceReviewedTargets(
        cfg,
        pid,
        comparableTargets,
        row.currentConfig?.targets || [],
        { persistConfig: input.persistConfig === true, allowEmpty: noTargets },
      );
      if (!retryPreparation.ok) return { ok: false, error: `复核结果无效：${retryPreparation.error}` };
      comparableTargets = configInferencePersistedTargets(pid, root, retryPreparation.targets);
    }
    const sameReview = row.review.decision === decision
      && Number(row.review.rating) === rating
      && String(row.review.reason || "") === reason
      && stableJsonText(row.review.conflictResolutions || {}) === stableJsonText(conflictGate.resolutions || {})
      && (decision !== "corrected" || row.review.correctedPrediction?.noTargets === noTargets)
      && (decision !== "corrected" || stableJsonText(normalizeConfigInferenceTargets(row.review.correctedPrediction?.targets || []))
        === stableJsonText(comparableTargets));
    if (!sameReview) return { ok: false, statusCode: 409, error: "该训练记录已经评分，不能覆盖已学习和记忆的结果" };
    const storedTargets = orderConfigInferenceTargets(configInferencePersistedTargets(
      pid,
      root,
      (row.review.correctedPrediction || row.prediction)?.targets || [],
    ));
    const boundStoredTargets = orderConfigInferenceTargets(
      configInferenceBoundTargets(pid, root, storedTargets),
    );
    const storedSuggestion = ["correct", "corrected"].includes(decision)
      ? buildReviewedConfigInferenceSnapshot(pid, boundStoredTargets, {
        ticketId: row.ticket?.ticketId || row.ticket?.tbTaskId,
        sourceTitle: `AI复核·${row.ticket?.title || row.ticket?.ticketId || "配置"}`,
        allowCurrentTargets: row.currentConfig?.targets || [],
        localProjectBindings: localBindingPreparation.bindings,
      })
      : { ok: false };
    const storedSample = root.samples[`CIS_${row.id}`] || null;
    const storedTicketId = row.trigger === "training_random" ? configInferenceTicketId(row.ticket) : "";
    const storedClaim = storedTicketId ? root.trainingClaims[storedTicketId] : null;
    if (configInferenceTrainingClaimMatchesRun(storedClaim, row)) {
      delete root.trainingClaims[storedTicketId];
      try {
        writeSharedOps(cfg, { type: "byProject.delete", projectId: pid, path: ["aiTraining", "configInference", "trainingClaims", storedTicketId] }, {
          guard: (latest) => guardConfigInferenceTrainingClaimDeletes(
            latest,
            pid,
            new Map([[storedTicketId, cloneJson(storedClaim)]]),
          ),
        });
      } catch (error) {
        if (error?.code === "SHARED_WRITE_CONFLICT") return reviewConfigInferenceRun(pid, row.id, input);
        throw error;
      }
    }
    if (localBindingPreparation.bindings.some((binding) => binding.projectId)) {
      saveRepositoryBindings(localBindingPreparation.bindings);
    }
    return {
      ok: true,
      data: { ...configInferenceBoundRun(pid, root, row), options: registry.options },
      sample: storedSample ? configInferenceBoundSample(pid, root, storedSample) : null,
      trainedTicket: storedTicketId ? cloneJson(root.trainedTickets[storedTicketId] || null) : null,
      learned: !!storedSample && configInferenceSampleServingStatus(storedSample) === "approved",
      annotationPending: !!storedSample && configInferenceSampleServingStatus(storedSample) === "pending",
      reviewPersisted: true,
      idempotent: true,
      snapshot: storedSuggestion.ok ? storedSuggestion.snapshot : null,
      summary: storedSuggestion.ok ? storedSuggestion.summary : null,
      localResolution: storedSuggestion.ok ? storedSuggestion.localResolution : null,
      snapshotUnavailable: storedSuggestion.ok ? null : {
        code: storedSuggestion.code || "CONFIG_INFERENCE_SNAPSHOT_INVALID",
        error: storedSuggestion.error || "复核结果不能安全应用到故事点",
      },
      configurationUpdates: row.review.configurationUpdates || { changed: false },
    };
  }
  let targets = normalizeConfigInferenceTargets(finalPrediction?.targets || []);
  let targetWriteback = null;
  if (["correct", "corrected"].includes(decision)) {
    targetWriteback = prepareConfigInferenceReviewedTargets(
      cfg,
      pid,
      targets,
      row.currentConfig?.targets || [],
      {
        persistConfig: decision === "corrected" && input.persistConfig === true,
        allowEmpty: decision === "corrected" && noTargets,
      },
    );
    if (!targetWriteback.ok) return { ok: false, error: `复核结果无效：${targetWriteback.error}` };
    targets = configInferencePersistedTargets(pid, root, targetWriteback.targets);
    finalPrediction.targets = targets;
    if (decision === "corrected") finalPrediction.noTargets = noTargets;
  }
  const originalTargets = configInferencePersistedTargets(pid, root, row.prediction?.targets || []);
  const finalTargetKeys = new Set(targets.map(configInferenceFeedbackTargetKey));
  const finalTargetSubjects = new Set(targets.map(configInferenceFeedbackTargetSubjectKey));
  const removedTargets = decision === "corrected"
    ? originalTargets.filter((target) => (
      !finalTargetKeys.has(configInferenceFeedbackTargetKey(target))
      && !finalTargetSubjects.has(configInferenceFeedbackTargetSubjectKey(target))
    ))
    : [];
  const now = Date.now();
  const sampleId = `CIS_${row.id}`;
  const correctedLearning = decision === "corrected" && (targets.length > 0 || removedTargets.length > 0 || noTargets);
  const createAnnotation = (decision === "correct" && targets.length)
    || correctedLearning
    || ["insufficient", "ticket_wrong"].includes(decision);
  row.review = {
    decision,
    rating,
    correctedPrediction: decision === "corrected" ? finalPrediction : null,
    reviewer: sanitizeSharedTrainingText(input.reviewer, 200),
    reason,
    annotationId: createAnnotation ? sampleId : "",
    governanceStatus: createAnnotation ? "pending" : "not_applicable",
    sourceCoverageGate: row.sourceCoverageGate || configInferenceSourceCoverageGate(row.ticket || {}),
    conflictResolutions: conflictGate.resolutions,
    configurationUpdates: targetWriteback?.configurationUpdates || { changed: false },
    reviewedAt: now,
  };
  row.updatedAt = now;
  const expectedTrimDeletes = new Map();
  const expectedClaimDeletes = new Map();
  const ops = [
    ...(targetWriteback?.ops || []),
    { type: "byProject.set", projectId: pid, path: ["aiTraining", "configInference", "runs", row.id], value: row },
  ];
  let sample = null;
  if (createAnnotation) {
    const positive = ["correct", "corrected"].includes(decision) && targets.length > 0;
    const rejectedTargets = decision === "corrected" ? removedTargets : positive ? [] : originalTargets;
    const hasRejectedTargets = rejectedTargets.length > 0;
    sample = {
      id: sampleId,
      projectId: pid,
      recordType: "annotation",
      source: row.trigger === "training_random" ? "training_random" : "user_feedback",
      sourceRunId: row.id,
      rating,
      score: rating,
      ticket: row.ticket,
      trainingSource: cloneJson(row.trainingSource || null),
      signals: row.prediction?.signals || extractConfigInferenceSignals(row.ticket, registry.keywordMappings),
      groundTruth: ["correct", "corrected"].includes(decision) ? { targets, noTargets } : null,
      feedback: {
        ...row.review,
        score: rating,
        rejectedPrediction: hasRejectedTargets ? {
          status: row.prediction?.status,
          targets: rejectedTargets,
        } : null,
      },
      negative: hasRejectedTargets ? {
        policyVersion: 1,
        rejectedTargets,
      } : null,
      annotation: {
        id: sampleId,
        status: "pending",
        revision: 1,
        reviewer: sanitizeSharedTrainingText(input.reviewer, 200),
        reviewedAt: now,
        sourceCoverageGate: row.sourceCoverageGate || configInferenceSourceCoverageGate(row.ticket || {}),
        votes: [],
      },
      serving: {
        status: "pending",
        revision: 0,
        reason: "awaiting_admin_approval",
        updatedAt: now,
      },
      createdAt: root.samples[sampleId]?.createdAt || now,
      updatedAt: now,
    };
    root.samples[sampleId] = sample;
    ops.push({ type: "byProject.set", projectId: pid, path: ["aiTraining", "configInference", "samples", sampleId], value: sample });
    ops.push(...trimConfigInferenceSection(root, "samples", pid, expectedTrimDeletes));
  } else if (root.samples[sampleId]) {
    delete root.samples[sampleId];
    ops.push({ type: "byProject.delete", projectId: pid, path: ["aiTraining", "configInference", "samples", sampleId] });
  }
  let trainedTicket = null;
  const trainedTicketId = configInferenceTicketId(row.ticket);
  if (row.trigger === "training_random" && trainedTicketId && safeSharedSegment(trainedTicketId)) {
    trainedTicket = {
      id: trainedTicketId,
      tbTaskId: trainedTicketId,
      sourceRunId: row.id,
      trainingSessionId: row.trainingSessionId || "",
      decision,
      rating,
      trainedAt: now,
      createdAt: root.trainedTickets[trainedTicketId]?.createdAt || now,
      updatedAt: now,
    };
    root.trainedTickets[trainedTicketId] = trainedTicket;
    ops.push({ type: "byProject.set", projectId: pid, path: ["aiTraining", "configInference", "trainedTickets", trainedTicketId], value: trainedTicket });
    const claim = root.trainingClaims[trainedTicketId];
    if (configInferenceTrainingClaimOwnsRun(claim, row, now)) {
      expectedClaimDeletes.set(trainedTicketId, cloneJson(claim));
      delete root.trainingClaims[trainedTicketId];
      ops.push({ type: "byProject.delete", projectId: pid, path: ["aiTraining", "configInference", "trainingClaims", trainedTicketId] });
    }
  }
  // 在本次复核造成的 sample / registry / value 变化都已经反映到内存候选状态后再冻结。
  // 该快照写在 run.review 内，本次保存它自身不会改变 revision digest；后续外部变化才会 stale。
  const reviewedRegistry = configInferenceRegistrySnapshotFromShared(cfg, pid, registry);
  row.review.inferenceRevisions = configInferenceRevisionSnapshot(reviewedRegistry, root);
  try {
    writeSharedOps(cfg, ops, {
      guard: (latest) => {
        const configGuard = guardConfigInferenceConfigurationWrite(latest, pid, targetWriteback?.configurationGuard);
        if (configGuard !== true) return configGuard;
        const trimGuard = guardConfigInferenceTrimDeletes(latest, pid, expectedTrimDeletes);
        if (trimGuard !== true) return trimGuard;
        const claimGuard = guardConfigInferenceTrainingClaimDeletes(latest, pid, expectedClaimDeletes);
        if (claimGuard !== true) return claimGuard;
        const latestRow = configInferenceSharedRoot(latest, pid).runs?.[row.id];
        const latestRoot = configInferenceSharedRoot(latest, pid);
        if (!latestRow) return "配置推理记录已不存在";
        // trainedTickets 只用于随机训练抽题去重。真实故事点的打开/重开/再次执行
        // 即使命中同一 TB 单，也必须允许保存 user_feedback 和本次确认配置；否则
        // 事务守卫会把普通故事点误判成“另一条训练记录”，与前置校验语义不一致。
        const latestTrainedTicket = latestRow.trigger === "training_random" && trainedTicketId
          ? latestRoot.trainedTickets?.[trainedTicketId]
          : null;
        if (latestTrainedTicket && latestTrainedTicket.sourceRunId !== row.id) {
          return "该 TB 单已经由另一条训练记录完成评分";
        }
        if (latestRow.review) return "配置推理记录已由其它请求完成评分";
        if (latestRow.trigger === "training_random") {
          const latestClaim = trainedTicketId ? latestRoot.trainingClaims?.[trainedTicketId] : null;
          if (!configInferenceTrainingClaimOwnsRun(latestClaim, latestRow)) {
            return "当前训练记录的占用已被新的训练会话接管";
          }
        }
        if (Number(latestRow.updatedAt || 0) !== expectedReviewState.updatedAt
          || String(latestRow.version || "") !== expectedReviewState.version
          || Number(latestRow.predictionRevision || 0) !== expectedReviewState.predictionRevision) {
          return "配置推理记录已被其它请求更新";
        }
        return true;
      },
    });
  } catch (error) {
    if (error?.code === "SHARED_WRITE_CONFLICT" && Number(input.__sharedRetry || 0) < 2) {
      return reviewConfigInferenceRun(pid, row.id, {
        ...input,
        __sharedRetry: Number(input.__sharedRetry || 0) + 1,
      });
    }
    if (error?.code === "SHARED_WRITE_CONFLICT") {
      return { ok: false, statusCode: 409, error: error.message || "配置推理评分状态已更新，请刷新后重试" };
    }
    throw error;
  }
  if (targetWriteback?.configurationUpdates?.changed) registry = configInferenceRegistrySnapshot(pid);
  const boundTargets = configInferenceBoundTargets(pid, root, targets);
  const suggestion = ["correct", "corrected"].includes(decision)
    ? buildReviewedConfigInferenceSnapshot(pid, boundTargets, {
      ticketId: row.ticket?.ticketId || row.ticket?.tbTaskId,
      sourceTitle: `AI复核·${row.ticket?.title || row.ticket?.ticketId || "配置"}`,
      allowCurrentTargets: row.currentConfig?.targets || [],
      localProjectBindings: localBindingPreparation.bindings,
    })
    : { ok: false };
  if (localBindingPreparation.bindings.some((binding) => binding.projectId)) {
    saveRepositoryBindings(localBindingPreparation.bindings);
  }
  return {
    ok: true,
    data: { ...configInferenceBoundRun(pid, root, row), options: registry.options },
    sample: sample ? configInferenceBoundSample(pid, root, sample) : null,
    trainedTicket,
    learned: !!sample && configInferenceSampleServingStatus(sample) === "approved",
    annotationPending: !!sample && configInferenceSampleServingStatus(sample) === "pending",
    reviewPersisted: true,
    snapshot: suggestion.ok ? suggestion.snapshot : null,
    summary: suggestion.ok ? suggestion.summary : null,
    localResolution: suggestion.ok ? suggestion.localResolution : null,
    snapshotUnavailable: suggestion.ok ? null : {
      code: suggestion.code || "CONFIG_INFERENCE_SNAPSHOT_INVALID",
      error: suggestion.error || "复核结果不能安全应用到故事点",
    },
    configurationUpdates: targetWriteback?.configurationUpdates || { changed: false },
  };
}

function findConfigInferenceAnnotation(root, id) {
  const key = String(id || "").trim();
  if (!key) return null;
  const runKey = key.replace(/^CIS_/, "");
  const runAnnotationId = String(root.runs?.[runKey]?.review?.annotationId || "").trim();
  return root.samples[key]
    || (runAnnotationId ? root.samples[runAnnotationId] : null)
    || root.samples[`CIS_${key}`]
    || configInferenceAllSamples(root).find((row) => (
      row.recordType === "annotation"
      && (String(row.annotation?.id || "") === key || String(row.sourceRunId || "") === key)
    ))
    || null;
}

function configInferenceAnnotationVote(sample, run, registry, root, input, reviewer) {
  const decision = String(
    input.vote?.decision
    || input.label?.decision
    || input.decision
    || sample.feedback?.decision
    || "",
  ).trim().toLowerCase();
  if (!["correct", "corrected", "insufficient", "ticket_wrong"].includes(decision)) {
    return {
      ok: false,
      statusCode: 400,
      code: "CONFIG_INFERENCE_ANNOTATION_DECISION_REQUIRED",
      error: "annotation approve 必须包含可治理的 decision",
    };
  }
  const noTargets = input.vote?.noTargets === true
    || input.label?.noTargets === true
    || input.noTargets === true
    || sample.groundTruth?.noTargets === true
    || ["insufficient", "ticket_wrong"].includes(decision);
  const requestedTargets = input.vote?.targets
    || input.label?.targets
    || input.targets
    || sample.groundTruth?.targets
    || sample.feedback?.correctedPrediction?.targets
    || [];
  const submittedTargets = noTargets
    ? []
    : orderConfigInferenceTargets(normalizeConfigInferenceTargets(requestedTargets));
  const positive = ["correct", "corrected"].includes(decision);
  const coverageGate = sample.annotation?.sourceCoverageGate
    || sample.feedback?.sourceCoverageGate
    || configInferenceSourceCoverageGate(sample.ticket || {});
  const sourceGatePassed = !positive || coverageGate.applicable !== true || coverageGate.complete === true;
  const unresolvedSymbolic = positive
    && !noTargets
    && submittedTargets.some(hasConfigInferenceSymbolicFields);
  const currentRevisions = configInferenceRevisionSnapshot(registry, root);
  const runRevisions = isPlainObject(run?.inferenceRevisions) ? run.inferenceRevisions : null;
  const revisionSnapshotMatches = !positive || !!runRevisions && [
    "rulesRevision",
    "registryRevision",
    "keywordRevision",
    "valueRevision",
  ].every((key) => String(runRevisions[key] || "") === String(currentRevisions[key] || ""));
  const reviewedPrediction = run?.review?.correctedPrediction || run?.prediction || {};
  const reviewedTargets = noTargets
    ? []
    : orderConfigInferenceTargets(normalizeConfigInferenceTargets(reviewedPrediction.targets || []));
  const reviewedNoTargets = run?.review?.decision === "corrected"
    ? reviewedPrediction.noTargets === true
    : false;
  const snapshotApplied = !positive || (
    !!run?.review
    && reviewedNoTargets === noTargets
    && configInferenceTargetGraphFingerprint(reviewedTargets)
      === configInferenceTargetGraphFingerprint(submittedTargets)
  );
  let registryValidation = { ok: true };
  if (positive && !noTargets && !unresolvedSymbolic) {
    registryValidation = validateConfigInferenceTargets(submittedTargets, {
      projectDefs: registry.projectDefs,
      vehicleMap: registry.vehicleMap,
      allowCurrentTargets: run?.currentConfig?.targets || [],
    });
  }
  const blockers = [
    ...(!sourceGatePassed ? ["SOURCE_GATE_NOT_PASSED"] : []),
    ...(unresolvedSymbolic ? ["SYMBOLIC_UNRESOLVED"] : []),
    ...(!snapshotApplied ? ["SNAPSHOT_NOT_APPLIED"] : []),
    ...(!revisionSnapshotMatches ? ["REGISTRY_REVISION_STALE"] : []),
    ...(!registryValidation.ok ? ["REGISTRY_TARGET_INVALID"] : []),
  ];
  if (blockers.length) {
    return {
      ok: false,
      statusCode: 409,
      code: "CONFIG_INFERENCE_ANNOTATION_APPROVAL_BLOCKED",
      error: `annotation approval gate 未通过：${blockers.join(", ")}`,
      blockers,
      sourceCoverageGate: coverageGate,
      registryError: registryValidation.error || "",
    };
  }
  // Reviewer targets are an untrusted vote over the already reviewed business graph. Once the
  // graph gate passes, persist the canonical ground truth instead of client fieldBindings so a
  // forged actualValue/defaultValue/sourceValue/revision or logicalKey cannot enter shared history.
  const targets = noTargets
    ? []
    : orderConfigInferenceTargets(configInferencePersistedTargets(
      sample.projectId || run?.projectId || "",
      root,
      sample.groundTruth?.targets || reviewedTargets,
    ));
  const votes = Array.isArray(sample.annotation?.votes) ? sample.annotation.votes : [];
  const reviewerVotes = votes
    .filter((vote) => String(vote.reviewerId || "") === reviewer)
    .sort((left, right) => Number(right.revision || 0) - Number(left.revision || 0));
  const labelIdentity = stableJsonText({ decision, noTargets, targets });
  if (reviewerVotes[0]?.labelIdentity === labelIdentity) {
    const adjudication = adjudicateConfigInferenceAnnotations(votes, { requiredReviewers: 2 });
    return { ok: true, idempotent: true, vote: reviewerVotes[0], votes, adjudication };
  }
  const voteRevision = Math.max(0, ...votes.map((vote) => Number(vote.revision) || 0)) + 1;
  const now = Date.now();
  const vote = {
    id: `${sample.id}:vote:r${voteRevision}`,
    caseId: sample.sourceRunId,
    status: "pending",
    revision: voteRevision,
    reviewerId: reviewer,
    reviewerName: sanitizeSharedTrainingText(input.reviewerName, 200),
    decision,
    noTargets,
    targets,
    sourceGatePassed,
    unresolvedSymbolic,
    registryChangeStatus: "active",
    snapshotApplied,
    labelIdentity,
    reason: sanitizeSharedTrainingText(input.reason, 4000),
    createdAt: now,
    updatedAt: now,
  };
  const nextVotes = [...votes, vote].slice(-100);
  const adjudication = adjudicateConfigInferenceAnnotations(nextVotes, { requiredReviewers: 2 });
  return { ok: true, vote, votes: nextVotes, adjudication, currentRevisions };
}

function configInferenceAnnotationTransition(projectId, id, action, input = {}) {
  const pid = explicitConfigInferenceProjectId(projectId);
  if (!pid) return { ok: false, statusCode: 400, error: "annotation 治理必须指定有效 TB 项目" };
  if (!["approve", "revoke", "restore", "supersede"].includes(action)) {
    return { ok: false, statusCode: 400, error: "不支持的 annotation 治理操作" };
  }
  const reviewer = sanitizeSharedTrainingText(input.reviewer || input.actor, 200);
  if (!reviewer) return { ok: false, statusCode: 400, error: "annotation 治理必须记录审批人" };
  const cfg = loadRawConfig();
  const root = configInferenceRoot(cfg, pid);
  const registry = configInferenceRegistrySnapshot(pid);
  const sample = findConfigInferenceAnnotation(root, id);
  if (!sample || sample.recordType !== "annotation") {
    return { ok: false, statusCode: 404, error: "annotation 不存在" };
  }
  if (input.caseId !== undefined
    && String(input.caseId || "").trim() !== String(sample.sourceRunId || "").trim()) {
    return {
      ok: false,
      statusCode: 409,
      code: "CONFIG_INFERENCE_ANNOTATION_CASE_MISMATCH",
      error: "annotation 不属于指定 case/run",
    };
  }
  const currentStatus = configInferenceSampleServingStatus(sample);
  const currentRevision = Math.max(0, Math.trunc(Number(sample.serving?.revision) || 0));
  if (input.expectedRevision !== undefined && Number(input.expectedRevision) !== currentRevision) {
    return {
      ok: false,
      statusCode: 409,
      code: "CONFIG_INFERENCE_ANNOTATION_REVISION_CONFLICT",
      error: `annotation 已更新，当前 revision=${currentRevision}`,
      current: configInferenceBoundSample(pid, root, sample),
    };
  }
  if (action === "restore") {
    if (!["revoked", "superseded"].includes(currentStatus)) {
      return { ok: false, statusCode: 409, error: `只有 revoked/superseded annotation 可恢复，当前为 ${currentStatus}` };
    }
    const existingRestore = configInferenceAllSamples(root).find((row) => (
      row.recordType === "annotation"
      && String(row.annotation?.restoredFrom || "") === String(sample.annotation?.id || sample.id)
      && configInferenceSampleServingStatus(row) === "pending"
    ));
    if (existingRestore) {
      return {
        ok: true,
        idempotent: true,
        requiresApproval: true,
        restoredFrom: sample.id,
        data: {
          ...configInferenceBoundSample(pid, root, existingRestore),
          servingStatus: "pending",
        },
      };
    }
    const now = Date.now();
    const annotationRevision = Math.max(
      Math.max(1, Math.trunc(Number(sample.annotation?.revision) || 1)),
      ...configInferenceAllSamples(root)
        .filter((row) => row.recordType === "annotation" && row.sourceRunId === sample.sourceRunId)
        .map((row) => Math.max(1, Math.trunc(Number(row.annotation?.revision) || 1))),
    ) + 1;
    const baseId = String(sample.sourceRunId || sample.id).replace(/^CIS_/, "");
    const restoredId = `CIS_${baseId}_R${annotationRevision}`;
    if (!safeSharedSegment(restoredId)) {
      return { ok: false, statusCode: 400, error: "restore annotation revision id 无效" };
    }
    const expectedSample = cloneJson(sample);
    const restored = {
      ...cloneJson(sample),
      id: restoredId,
      sourceRunId: sample.sourceRunId,
      approvedLabel: null,
      annotation: {
        ...(sample.annotation || {}),
        id: restoredId,
        status: "pending",
        revision: annotationRevision,
        restoredFrom: String(sample.annotation?.id || sample.id),
        supersedes: String(sample.annotation?.id || sample.id),
        reviewer,
        reviewedAt: now,
        governanceUpdatedAt: now,
        governanceUpdatedBy: reviewer,
        votes: [],
        adjudication: null,
      },
      serving: {
        status: "pending",
        revision: 0,
        reason: String(input.reason || "restored_as_new_revision").trim().slice(0, 4000),
        updatedAt: now,
        updatedBy: reviewer,
        history: [{
          action: "restore",
          from: currentStatus,
          to: "pending",
          revision: 0,
          reviewer,
          reason: String(input.reason || "").trim().slice(0, 4000),
          at: now,
        }],
      },
      sourceAnnotation: {
        id: String(sample.annotation?.id || sample.id),
        servingStatus: currentStatus,
      },
      createdAt: now,
      updatedAt: now,
    };
    sample.annotation = {
      ...(sample.annotation || {}),
      restoredBy: restoredId,
      governanceUpdatedAt: now,
      governanceUpdatedBy: reviewer,
    };
    sample.updatedAt = Math.max(now, Number(sample.updatedAt || 0) + 1);
    root.samples[sample.id] = sample;
    root.samples[restored.id] = restored;
    const ops = [
      {
        type: "byProject.set",
        projectId: pid,
        path: ["aiTraining", "configInference", "samples", sample.id],
        value: sample,
      },
      {
        type: "byProject.set",
        projectId: pid,
        path: ["aiTraining", "configInference", "samples", restored.id],
        value: restored,
      },
    ];
    const run = sample.sourceRunId ? root.runs[sample.sourceRunId] : null;
    const expectedRun = run ? cloneJson(run) : null;
    if (run?.review) {
      run.review = {
        ...run.review,
        annotationId: restored.id,
        governanceStatus: "pending",
        governanceRevision: 0,
        governanceUpdatedAt: now,
        governanceUpdatedBy: reviewer,
      };
      run.updatedAt = Math.max(now, Number(run.updatedAt || 0) + 1);
      root.runs[run.id] = run;
      ops.push({
        type: "byProject.set",
        projectId: pid,
        path: ["aiTraining", "configInference", "runs", run.id],
        value: run,
      });
    }
    try {
      writeSharedOps(cfg, ops, {
        guard: (latest) => {
          const latestRoot = configInferenceSharedRoot(latest, pid);
          if (stableJsonText(latestRoot.samples?.[sample.id]) !== stableJsonText(expectedSample)) {
            return "annotation 已被其它请求更新";
          }
          if (latestRoot.samples?.[restored.id]) return "restore annotation revision 已存在";
          if (expectedRun && stableJsonText(latestRoot.runs?.[expectedRun.id]) !== stableJsonText(expectedRun)) {
            return "annotation 所属 run 已被其它请求更新";
          }
          return true;
        },
      });
    } catch (error) {
      if (error?.code === "SHARED_WRITE_CONFLICT") {
        return { ok: false, statusCode: 409, error: error.message || "annotation 已被其它请求更新" };
      }
      throw error;
    }
    return {
      ok: true,
      action,
      requiresApproval: true,
      restoredFrom: sample.id,
      data: {
        ...configInferenceBoundSample(pid, root, restored),
        servingStatus: "pending",
      },
      learned: false,
    };
  }
  let targetStatus = action === "approve"
    ? "approved"
    : action === "supersede"
      ? "superseded"
      : "revoked";
  if (currentStatus === targetStatus) {
    return {
      ok: true,
      idempotent: true,
      data: {
        ...configInferenceBoundSample(pid, root, sample),
        servingStatus: currentStatus,
      },
    };
  }
  if (action === "approve" && currentStatus !== "pending") {
    return { ok: false, statusCode: 409, error: `只有 pending annotation 可批准，当前为 ${currentStatus}` };
  }
  if (action === "supersede" && !String(input.supersededBy || "").trim()) {
    return { ok: false, statusCode: 400, error: "supersede 必须指定 supersededBy annotation" };
  }
  const coverageGate = sample.annotation?.sourceCoverageGate
    || sample.feedback?.sourceCoverageGate
    || configInferenceSourceCoverageGate(sample.ticket || {});
  if (targetStatus === "approved" && coverageGate.applicable && !coverageGate.complete) {
    const overrideReason = String(input.overrideReason || "").trim();
    if (input.allowPartialCoverage !== true || !overrideReason) {
      return {
        ok: false,
        statusCode: 409,
        code: "CONFIG_INFERENCE_SOURCE_COVERAGE_INCOMPLETE",
        error: "TB 来源数据不完整，需显式填写 overrideReason 才能批准",
        sourceCoverageGate: coverageGate,
      };
    }
  }

  const run = sample.sourceRunId ? root.runs[sample.sourceRunId] : null;
  let approvalVote = null;
  let approvedLabel = null;
  if (action === "approve") {
    approvalVote = configInferenceAnnotationVote(sample, run, registry, root, input, reviewer);
    if (!approvalVote.ok) return approvalVote;
    if (approvalVote.idempotent) {
      return {
        ok: true,
        idempotent: true,
        requiresMoreReviewers: approvalVote.adjudication?.status !== "approved",
        adjudication: approvalVote.adjudication,
        data: {
          ...configInferenceBoundSample(pid, root, sample),
          servingStatus: currentStatus,
        },
        learned: false,
      };
    }
    targetStatus = approvalVote.adjudication.status === "approved" ? "approved" : "pending";
    if (targetStatus === "approved") {
      try {
        approvedLabel = createApprovedConfigInferenceLabel(approvalVote.adjudication, {
          approvedBy: "two-reviewer-consensus",
          approvedAt: new Date().toISOString(),
          registryRevision: approvalVote.currentRevisions?.registryRevision || "",
          rulesVersion: approvalVote.currentRevisions?.rulesRevision || CONFIG_INFERENCE_VERSION,
          featureSchemaVersion: CONFIG_INFERENCE_VERSION,
          portableTargets: configInferencePersistedTargets(
            pid,
            root,
            sample.groundTruth?.targets || approvalVote.adjudication.approvedLabel.targets,
          ),
        });
      } catch (error) {
        return { ok: false, statusCode: 409, error: error.message };
      }
    }
  }

  const now = Date.now();
  const nextRevision = currentRevision + 1;
  const reason = sanitizeSharedTrainingText(input.reason || input.overrideReason, 4000);
  const expectedSample = cloneJson(sample);
  const expectedRun = run ? cloneJson(run) : null;
  sample.annotation = {
    ...(sample.annotation || {}),
    status: action === "approve" ? approvalVote.adjudication.status : targetStatus,
    revision: Math.max(1, Math.trunc(Number(sample.annotation?.revision) || 1)) + 1,
    governanceUpdatedAt: now,
    governanceUpdatedBy: reviewer,
    ...(approvalVote ? {
      votes: approvalVote.votes,
      adjudication: approvalVote.adjudication,
    } : {}),
  };
  if (approvedLabel) {
    sample.approvedLabel = approvedLabel;
    sample.groundTruth = {
      targets: approvedLabel.label.targets,
      noTargets: approvedLabel.label.noTargets,
    };
  }
  const liveReleases = configInferenceRows(root.releases)
    .filter((release) => ["shadow", "canary", "active"].includes(String(release.status || "").toLowerCase()));
  const runReleaseId = String(run?.releaseTrial?.releaseId || "").trim();
  const releaseHold = targetStatus === "approved"
    ? (
      liveReleases.find((release) => release.id === runReleaseId)?.id
      || (liveReleases.length === 1 ? liveReleases[0].id : "")
    )
    : "";
  sample.serving = {
    ...(sample.serving || {}),
    status: targetStatus,
    revision: nextRevision,
    reason,
    updatedAt: now,
    updatedBy: reviewer,
    ...(targetStatus === "approved" ? { approvedAt: now, approvedBy: reviewer } : {}),
    ...(releaseHold ? { releaseHold } : {}),
    ...(action === "supersede" ? { supersededBy: String(input.supersededBy).trim() } : {}),
    history: [
      ...(Array.isArray(sample.serving?.history) ? sample.serving.history : []),
      {
        action: action === "approve" && targetStatus === "pending" ? "approve_vote" : action,
        from: currentStatus,
        to: targetStatus,
        revision: nextRevision,
        reviewer,
        reason,
        at: now,
      },
    ].slice(-50),
  };
  sample.updatedAt = Math.max(now, Number(sample.updatedAt || 0) + 1);
  root.samples[sample.id] = sample;

  const ops = [{
    type: "byProject.set",
    projectId: pid,
    path: ["aiTraining", "configInference", "samples", sample.id],
    value: sample,
  }];
  if (run?.review) {
    run.review = {
      ...run.review,
      governanceStatus: action === "approve" ? approvalVote.adjudication.status : targetStatus,
      governanceRevision: nextRevision,
      governanceUpdatedAt: now,
      governanceUpdatedBy: reviewer,
      ...(approvalVote ? { governanceAdjudication: approvalVote.adjudication } : {}),
    };
    run.updatedAt = Math.max(now, Number(run.updatedAt || 0) + 1);
    root.runs[run.id] = run;
    ops.push({
      type: "byProject.set",
      projectId: pid,
      path: ["aiTraining", "configInference", "runs", run.id],
      value: run,
    });
  }
  const releaseObservation = targetStatus === "approved" && approvedLabel && run
    ? configInferenceReleaseObservation(root, run, {
      sample,
      servingRevisionChanged: run.review?.configurationUpdates?.changed === true,
      now,
    })
    : null;
  if (releaseObservation) {
    root.releases[releaseObservation.release.id] = releaseObservation.release;
    ops.push({
      type: "byProject.set",
      projectId: pid,
      path: ["aiTraining", "configInference", "releases", releaseObservation.release.id],
      value: releaseObservation.release,
    });
  }
  try {
    writeSharedOps(cfg, ops, {
      guard: (latest) => {
        const latestRoot = configInferenceSharedRoot(latest, pid);
        const latestSample = latestRoot.samples?.[sample.id];
        if (!latestSample) return "annotation 已被删除";
        if (stableJsonText(latestSample) !== stableJsonText(expectedSample)) return "annotation 已被其它请求更新";
        if (expectedRun && stableJsonText(latestRoot.runs?.[expectedRun.id]) !== stableJsonText(expectedRun)) {
          return "annotation 所属 run 已被其它请求更新";
        }
        if (releaseObservation) {
          const latestRelease = latestRoot.releases?.[releaseObservation.release.id];
          const expectedRelease = releaseObservation.expected;
          if (!latestRelease) return "候选 release 已不存在";
          if (
            latestRelease.status !== expectedRelease.status
            || Number(latestRelease.trafficPercent || 0) !== expectedRelease.trafficPercent
            || (Array.isArray(latestRelease.history) ? latestRelease.history.length : 0) !== expectedRelease.historyLength
            || (Array.isArray(latestRelease.onlineObservations) ? latestRelease.onlineObservations.length : 0)
              !== expectedRelease.observationCount
            || Number(latestRelease.updatedAt || 0) !== expectedRelease.updatedAt
          ) {
            return "候选 release 已由其它 Gateway 更新";
          }
        }
        return true;
      },
    });
  } catch (error) {
    if (error?.code === "SHARED_WRITE_CONFLICT") {
      return { ok: false, statusCode: 409, error: error.message || "annotation 已被其它请求更新" };
    }
    throw error;
  }
  return {
    ok: true,
    action,
    requiresMoreReviewers: action === "approve" && targetStatus !== "approved",
    adjudication: approvalVote?.adjudication || null,
    releaseObservation: releaseObservation?.observation || null,
    data: {
      ...configInferenceBoundSample(pid, root, sample),
      servingStatus: targetStatus,
    },
    learned: targetStatus === "approved",
  };
}

export function approveConfigInferenceAnnotation(projectId, id, input = {}) {
  return configInferenceAnnotationTransition(projectId, id, "approve", input);
}

export function revokeConfigInferenceAnnotation(projectId, id, input = {}) {
  return configInferenceAnnotationTransition(projectId, id, "revoke", input);
}

export function restoreConfigInferenceAnnotation(projectId, id, input = {}) {
  return configInferenceAnnotationTransition(projectId, id, "restore", input);
}

export function supersedeConfigInferenceAnnotation(projectId, id, input = {}) {
  return configInferenceAnnotationTransition(projectId, id, "supersede", input);
}

export function resolveConfigInferenceSymbols(projectId, id, input = {}) {
  const pid = explicitConfigInferenceProjectId(projectId);
  const key = explicitConfigInferenceRunId(id);
  if (!pid || !key) return { ok: false, statusCode: 400, error: "替换代号值必须指定有效的 TB 项目和 runId" };
  const cfg = loadRawConfig();
  const root = configInferenceRoot(cfg, pid);
  const row = root.runs[key];
  if (!row?.review) return { ok: false, error: "只能替换已经评分并保存的代号目标" };
  const previousTargets = orderConfigInferenceTargets(configInferenceBoundTargets(
    pid,
    root,
    (row.review.correctedPrediction || row.prediction)?.targets || [],
  )).map((target, index) => ({ ...target, targetId: target.targetId || `target_${index + 1}` }));
  const persistedPreviousTargets = orderConfigInferenceTargets(configInferencePersistedTargets(
    pid,
    root,
    (row.review.correctedPrediction || row.prediction)?.targets || [],
  )).map((target, index) => ({ ...target, targetId: target.targetId || `target_${index + 1}` }));
  if (!previousTargets.some(hasConfigInferenceSymbolicFields)) return { ok: false, error: "当前训练结果没有待替换的代号字段" };

  const requestedSource = Array.isArray(input.correctedPrediction?.targets) ? input.correctedPrediction.targets : [];
  if (!requestedSource.length) return { ok: false, error: "替换代号值时不能删除全部目标，请在首次评分时使用删除功能" };
  if (requestedSource.length !== previousTargets.length) return { ok: false, error: "替换代号值不能新增或删除工程目标" };
  const requestedIds = requestedSource.map((target) => String(target?.targetId || "").trim());
  if (requestedIds.some((targetId) => !targetId)) return { ok: false, error: "替换代号值必须保留每个工程的 targetId" };
  if (new Set(requestedIds).size !== requestedIds.length) return { ok: false, error: "替换代号值的 targetId 不能重复" };
  const previousIds = previousTargets.map((target) => target.targetId);
  if (previousIds.some((targetId) => !requestedIds.includes(targetId)) || requestedIds.some((targetId) => !previousIds.includes(targetId))) {
    return { ok: false, error: "替换代号值不能交换或替换工程身份" };
  }
  const normalizedRequested = normalizeConfigInferenceTargets(requestedSource);
  if (normalizedRequested.length !== requestedSource.length) {
    return { ok: false, error: "替换代号值后出现重复工程目标，请分别保留原工程身份" };
  }
  const requestedById = new Map(normalizedRequested.map((target) => [target.targetId, target]));
  const requestedTargets = previousIds.map((targetId) => requestedById.get(targetId));
  for (let index = 0; index < previousTargets.length; index++) {
    const before = previousTargets[index];
    const after = requestedTargets[index];
    if (!after) return { ok: false, error: `替换代号值缺少工程身份 ${before.targetId}` };
    if (after.targetRole !== before.targetRole || Number(after.order) !== Number(before.order)) {
      return { ok: false, error: "替换代号值不能修改主/依赖角色或工程排序" };
    }
    if (after.projectType !== before.projectType || after.repositoryOnly !== before.repositoryOnly) {
      return { ok: false, error: "替换代号值不能修改工程类型" };
    }
    const beforeSymbolic = new Set(configInferenceSymbolicFields(before));
    const afterSymbolic = new Set(configInferenceSymbolicFields(after));
    if ([...afterSymbolic].some((field) => !beforeSymbolic.has(field))) {
      return { ok: false, error: "替换代号值不能把原实际字段新增为代号" };
    }
    for (const field of CONFIG_INFERENCE_DIMENSIONS) {
      if (beforeSymbolic.has(field)) continue;
      if (String(after[field] || "").trim() !== String(before[field] || "").trim()) {
        return { ok: false, error: `替换代号值不能修改原实际字段：${field}` };
      }
    }
    if (!beforeSymbolic.has("repositoryId")
      && (String(after.repositoryName || "").trim() !== String(before.repositoryName || "").trim()
        || String(after.gitUrl || "").trim() !== String(before.gitUrl || "").trim())) {
      return { ok: false, error: "替换代号值不能修改原实际 Git 仓库信息" };
    }
    const fieldBindings = { ...(after.fieldBindings || {}) };
    for (const field of beforeSymbolic) {
      const previousBinding = before.fieldBindings?.[field];
      if (!previousBinding?.logicalKey) return { ok: false, error: `代号字段 ${field} 缺少永久 logicalKey` };
      const requestedLogicalKey = String(fieldBindings[field]?.logicalKey || "").trim();
      if (requestedLogicalKey && requestedLogicalKey !== previousBinding.logicalKey) {
        return { ok: false, error: `代号字段 ${field} 的永久 logicalKey 不能修改` };
      }
      const stillSymbolic = afterSymbolic.has(field);
      fieldBindings[field] = {
        ...previousBinding,
        ...(fieldBindings[field] || {}),
        logicalKey: previousBinding.logicalKey,
        actualValue: stillSymbolic ? "" : String(after[field] || "").trim(),
        resolved: !stillSymbolic && !!String(after[field] || "").trim(),
      };
    }
    after.fieldBindings = fieldBindings;
  }
  const prepared = prepareConfigInferenceReviewedTargets(
    cfg,
    pid,
    requestedTargets,
    row.currentConfig?.targets || [],
    { persistConfig: input.persistConfig === true, allowEmpty: false },
  );
  if (!prepared.ok) return { ok: false, error: `代号替换结果无效：${prepared.error}` };

  const preparedTargets = prepared.targets;
  const targetById = new Map(preparedTargets.map((target) => [target.targetId, target]));
  const now = Date.now();
  const history = Array.isArray(row.review.resolutionHistory) ? row.review.resolutionHistory : [];
  const expectedResolutionState = {
    updatedAt: Number(row.updatedAt || 0),
    resolutionUpdatedAt: Number(row.review.resolutionUpdatedAt || 0),
    historyLength: history.length,
    targetsIdentity: stableJsonText(persistedPreviousTargets),
  };
  const expectedBindingRevisions = new Map();
  for (const target of previousTargets) {
    for (const field of CONFIG_INFERENCE_REPLACEABLE_FIELDS) {
      const logicalKey = String(target.fieldBindings?.[field]?.logicalKey || "").trim();
      if (!logicalKey || expectedBindingRevisions.has(logicalKey)) continue;
      const storedBinding = root.valueBindings?.[logicalKey];
      expectedBindingRevisions.set(logicalKey, Math.max(0, Math.trunc(Number(storedBinding?.revision) || 0)));
    }
  }
  const resolvedFields = [];
  for (const before of previousTargets) {
    const after = targetById.get(before.targetId) || {};
    for (const field of configInferenceSymbolicFields(before)) {
      if (!configInferenceSymbolicFields(after).includes(field)) {
        resolvedFields.push({
          targetId: after.targetId || before.targetId,
          field,
          logicalKey: before.fieldBindings?.[field]?.logicalKey || "",
          value: after[field] || "",
          actualValue: after[field] || "",
        });
      }
    }
  }
  const resolvedValuesByKey = new Map();
  for (const item of resolvedFields) {
    if (!item.logicalKey || !item.actualValue) continue;
    const previousValue = resolvedValuesByKey.get(item.logicalKey);
    if (previousValue !== undefined && previousValue !== item.actualValue) {
      return { ok: false, error: `同一永久 logicalKey ${item.logicalKey} 不能同时绑定多个实际值` };
    }
    resolvedValuesByKey.set(item.logicalKey, item.actualValue);
  }
  const bindingOps = [];
  for (const [logicalKey, actualValue] of resolvedValuesByKey) {
    const resolvedItem = resolvedFields.find((item) => item.logicalKey === logicalKey);
    const sourceTarget = previousTargets.find((target) => target.targetId === resolvedItem?.targetId) || {};
    const sourceBinding = sourceTarget.fieldBindings?.[resolvedItem?.field] || {};
    const existing = isPlainObject(root.valueBindings[logicalKey]) ? root.valueBindings[logicalKey] : {};
    const knowledgeKey = configInferenceKnowledgeKeyDefinition(logicalKey, resolvedItem.field, existing);
    const existingValueRevisions = (Array.isArray(existing.valueRevisions) ? existing.valueRevisions : [])
      .map(cloneJson);
    const latestValueRevision = Math.max(0, ...existingValueRevisions
      .filter((item) => item.keyId === knowledgeKey.keyId
        && item.scope === "project"
        && String(item.scopeId || "") === pid)
      .map((item) => Number(item.revision) || 0));
    const valueRevisionNumber = latestValueRevision + 1;
    const valueRevisionId = `${knowledgeKey.keyId}:project:${encodeURIComponent(pid)}:r${valueRevisionNumber}`;
    const operator = String(input.reviewer || "").trim();
    const lifecycleAt = new Date(now).toISOString();
    const sensitivity = knowledgeValueSensitivity(actualValue);
    if (!sensitivity.safeForShared) {
      return {
        ok: false,
        statusCode: 400,
        code: sensitivity.secret ? "KNOWLEDGE_SHARED_SECRET_REJECTED" : "KNOWLEDGE_SHARED_MACHINE_PATH_REJECTED",
        error: sensitivity.secret
          ? "共享 value 禁止保存 token、Cookie、密码或 secret"
          : "共享 value 禁止保存本机绝对路径；请先在当前 Gateway 建立 node 本机绑定",
      };
    }
    const revisionNumber = Math.max(0, Math.trunc(Number(existing.revision) || 0)) + 1;
    const bindingRow = {
      ...existing,
      id: logicalKey,
      logicalKey,
      keyId: knowledgeKey.keyId,
      canonicalKey: knowledgeKey.canonicalKey,
      aliases: knowledgeKey.aliases,
      valueType: knowledgeKey.valueType,
      scopePolicy: knowledgeKey.scopePolicy,
      status: knowledgeKey.status,
      dimension: resolvedItem.field,
      actualValue,
      defaultValue: existing.defaultValue || actualValue,
      sourceValue: existing.sourceValue || sourceBinding.sourceValue || sourceTarget[resolvedItem.field] || sourceBinding.label || "",
      scopeKey: existing.scopeKey || sourceBinding.scopeKey || "",
      label: existing.label || sourceBinding.label || logicalKey,
      resolved: true,
      revision: revisionNumber,
      history: [
        ...(Array.isArray(existing.history) ? existing.history : []),
        {
          revision: revisionNumber,
          previousActualValue: existing.actualValue || "",
          actualValue,
          reviewer: String(input.reviewer || "").trim(),
          updatedAt: now,
          source: "resolve_symbols",
        },
    ].slice(-20),
    valueRevisions: [
      ...existingValueRevisions.map((item) => (
        item.keyId === knowledgeKey.keyId
        && item.scope === "project"
        && String(item.scopeId || "") === pid
        && item.status === "active"
          ? {
            ...item,
            status: "retired",
            statusReason: `由 ${valueRevisionId} 替代`,
            retiredAt: lifecycleAt,
            retiredBy: operator,
            updatedAt: lifecycleAt,
            updatedBy: operator,
            lifecycleRevision: Math.max(0, Math.trunc(Number(item.lifecycleRevision) || 0)) + 1,
          }
          : item
      )),
      {
        id: valueRevisionId,
        keyId: knowledgeKey.keyId,
        scope: "project",
        scopeId: pid,
        actualValue,
        revision: valueRevisionNumber,
        parentRevision: latestValueRevision,
        lifecycleRevision: 2,
        status: "active",
        storage: "shared",
        reason: String(input.reason || "resolve_symbols").trim().slice(0, 2000),
        createdAt: lifecycleAt,
        createdBy: operator,
        approvedAt: lifecycleAt,
        approvedBy: operator,
        activatedAt: lifecycleAt,
        activatedBy: operator,
        sensitivity,
      },
    ].slice(-500),
    activeValueRevision: valueRevisionNumber,
    activeValueRevisionId: valueRevisionId,
    effectiveScope: "project",
    effectiveScopeId: pid,
      updatedBy: String(input.reviewer || "").trim(),
      createdAt: Number(existing.createdAt || 0) || now,
      updatedAt: Math.max(now, Number(existing.updatedAt || 0) + 1),
    };
    root.valueBindings[logicalKey] = bindingRow;
    bindingOps.push({
      type: "byProject.set",
      projectId: pid,
      path: ["aiTraining", "configInference", "valueBindings", logicalKey],
      value: bindingRow,
    });
  }
  const targets = configInferencePersistedTargets(pid, root, preparedTargets);
  const revision = {
    id: `CIR_${row.id}_${history.length + 1}`,
    previousTargets,
    targets,
    resolvedFields,
    unresolved: targets
      .filter(hasConfigInferenceSymbolicFields)
      .map((target) => ({ targetId: target.targetId, fields: configInferenceSymbolicFields(target) })),
    resolver: String(input.reviewer || "").trim(),
    resolvedAt: now,
  };
  const configurationUpdates = {
    ...(prepared.configurationUpdates || { changed: false }),
    resolutionRevision: revision.id,
    resolvedFields,
  };
  row.review.correctedPrediction = {
    ...(row.review.correctedPrediction || row.prediction || {}),
    targets,
    noTargets: false,
  };
  row.review.configurationUpdates = configurationUpdates;
  row.review.resolutionHistory = [...history, revision].slice(-20);
  row.review.resolutionUpdatedAt = now;
  row.updatedAt = now;

  const sampleId = `CIS_${row.id}`;
  const sample = root.samples[sampleId] || {
    id: sampleId,
    projectId: pid,
    source: row.trigger === "training_random" ? "training_random" : "user_feedback",
    sourceRunId: row.id,
    rating: row.review.rating,
    score: row.review.rating,
    ticket: row.ticket,
    trainingSource: cloneJson(row.trainingSource || null),
    signals: row.prediction?.signals || extractConfigInferenceSignals(row.ticket, configInferenceRegistrySnapshot(pid).keywordMappings),
    createdAt: now,
  };
  sample.groundTruth = { targets, noTargets: false };
  const finalTargetKeys = new Set(targets.map(configInferenceFeedbackTargetKey));
  const finalTargetSubjects = new Set(targets.map(configInferenceFeedbackTargetSubjectKey));
  const rejectedTargets = normalizeConfigInferenceTargets(row.prediction?.targets || [])
    .filter((target) => (
      !finalTargetKeys.has(configInferenceFeedbackTargetKey(target))
      && !finalTargetSubjects.has(configInferenceFeedbackTargetSubjectKey(target))
    ));
  sample.feedback = {
    ...(sample.feedback || {}),
    ...row.review,
    correctedPrediction: row.review.correctedPrediction,
    score: row.review.rating,
    rejectedPrediction: rejectedTargets.length ? {
      status: row.prediction?.status,
      targets: rejectedTargets,
    } : null,
  };
  sample.negative = rejectedTargets.length ? {
    policyVersion: 1,
    rejectedTargets,
  } : null;
  sample.resolutionHistory = [...(Array.isArray(sample.resolutionHistory) ? sample.resolutionHistory : []), revision].slice(-20);
  sample.updatedAt = now;
  root.samples[sampleId] = sample;

  const ops = [
    ...(prepared.ops || []),
    ...bindingOps,
    { type: "byProject.set", projectId: pid, path: ["aiTraining", "configInference", "runs", row.id], value: row },
    { type: "byProject.set", projectId: pid, path: ["aiTraining", "configInference", "samples", sampleId], value: sample },
  ];
  try {
    writeSharedOps(cfg, ops, {
      guard: (latest) => {
        const configGuard = guardConfigInferenceConfigurationWrite(latest, pid, prepared.configurationGuard);
        if (configGuard !== true) return configGuard;
        const latestRoot = configInferenceSharedRoot(latest, pid);
        const latestRow = latestRoot.runs?.[row.id];
        if (!latestRow?.review) return "配置推理评分记录已不存在";
        const latestTargets = orderConfigInferenceTargets(configInferencePersistedTargets(
          pid,
          latestRoot,
          (latestRow.review.correctedPrediction || latestRow.prediction)?.targets || [],
        )).map((target, index) => ({ ...target, targetId: target.targetId || `target_${index + 1}` }));
        if (Number(latestRow.updatedAt || 0) !== expectedResolutionState.updatedAt
          || Number(latestRow.review.resolutionUpdatedAt || 0) !== expectedResolutionState.resolutionUpdatedAt
          || (Array.isArray(latestRow.review.resolutionHistory) ? latestRow.review.resolutionHistory.length : 0) !== expectedResolutionState.historyLength
          || stableJsonText(latestTargets) !== expectedResolutionState.targetsIdentity) {
          return "代号目标已由其它 Gateway 更新";
        }
        for (const [logicalKey, expectedRevision] of expectedBindingRevisions) {
          const latestRevision = Math.max(0, Math.trunc(Number(latestRoot.valueBindings?.[logicalKey]?.revision) || 0));
          if (latestRevision !== expectedRevision) return `RAG 永久 Key ${logicalKey} 已由其它 Gateway 更新`;
        }
        return true;
      },
    });
  } catch (error) {
    if (error?.code === "SHARED_WRITE_CONFLICT") {
      return {
        ok: false,
        statusCode: 409,
        code: "CONFIG_INFERENCE_SYMBOL_RESOLUTION_CONFLICT",
        error: error.message || "代号目标已更新，请刷新后重试",
      };
    }
    throw error;
  }
  const registry = configInferenceRegistrySnapshot(pid);
  const executable = targets.length > 0 && !targets.some(hasConfigInferenceSymbolicFields);
  const suggestion = executable ? buildConfigInferenceSnapshot(pid, targets, {
    ticketId: row.ticket?.ticketId || row.ticket?.tbTaskId,
    sourceTitle: `AI代号替换·${row.ticket?.title || row.ticket?.ticketId || "配置"}`,
    allowCurrentTargets: row.currentConfig?.targets || [],
  }) : { ok: false };
  return {
    ok: true,
    data: { ...row, options: registry.options },
    sample,
    learned: true,
    reviewPersisted: true,
    snapshot: suggestion.ok ? suggestion.snapshot : null,
    summary: suggestion.ok ? suggestion.summary : null,
    configurationUpdates,
    revision,
  };
}

export function recordConfigInferenceUsage(projectId, input = {}) {
  const tab = input.tab || getTab(input.tabId);
  if (!tab) return { ok: false, error: "tab 不存在" };
  const projectGuard = configInferenceProjectGuard(
    projectId,
    input?.ticket?.projectId || tab?.tbContext?.projectId,
  );
  if (!projectGuard.ok) return projectGuard;
  const pid = projectGuard.projectId;
  if (!pid) return { ok: false, error: "记录实际工程配置必须指定 TB 项目" };
  const registry = configInferenceRegistrySnapshot(pid);
  const cfg = loadRawConfig();
  const root = configInferenceRoot(cfg, pid);
  const actualTargets = normalizeConfigInferenceTargets(input.targets || configInferenceActualTargets(tab, pid));
  if (!actualTargets.length) return { ok: false, error: "故事点尚无可记录的实际工程配置" };
  const validation = validateConfigInferenceTargets(actualTargets, {
    projectDefs: registry.projectDefs,
    vehicleMap: registry.vehicleMap,
    // 真实执行配置可能正是对注册表的纠偏来源；仍按工程类型校验必填字段，但允许已执行目标入样本。
    allowCurrentTargets: actualTargets,
  });
  if (!validation.ok) return { ok: false, error: `实际工程配置无效：${validation.error}` };
  const targets = orderConfigInferenceTargets(configInferencePersistedTargets(pid, root, validation.targets));
  const observationCapturedAt = new Date().toISOString();
  const observationTicket = input.ticket || {
    projectId: pid,
    ticketId: input.ticketId || tab.tbContext?.ticketId || "",
    tbTaskId: input.tbTaskId || String(tab.ticketUrl || "").match(/task\/([0-9a-fA-F]{24})/)?.[1] || "",
    ticketUrl: tab.ticketUrl || "",
    title: tab.tbContext?.title || tab.title || "",
    description: tab.tbContext?.description || "",
    comments: tab.tbContext?.comments || [],
    tags: tab.tbContext?.tags || [],
    projectName: tab.tbContext?.projectKey || tab.tbContext?.projectName || "",
    iterationName: tab.tbContext?.sprintName || "",
    attachments: tab.tbContext?.attachments || [],
    sourceCoverage: tab.tbContext?.sourceCoverage || {},
    snapshotAt: tab.tbContext?.fetchedAt || new Date().toISOString(),
  };
  const observationCoverage = cloneJson(observationTicket.sourceCoverage || {});
  observationCoverage.manual = {
    ...(isPlainObject(observationCoverage.manual) ? observationCoverage.manual : {}),
    available: true,
    complete: true,
    capturedAt: observationCapturedAt,
  };
  const ticket = normalizeStoredConfigInferenceTicket({
    ...observationTicket,
    sourceCoverage: observationCoverage,
    snapshotAt: observationCapturedAt,
  }, pid);
  const actionKind = String(input.actionKind || "develop_started");
  const fingerprint = createHash("sha256").update(JSON.stringify({
    ticket: ticket.tbTaskId || ticket.ticketId || tab.id,
    actionKind,
    targets: targets
      .map((target) => [
        ...CONFIG_INFERENCE_DIMENSIONS.map((dimension) => (
          // 共享 observation 的幂等身份只使用 logicalKey + 可移植 canonical 值；
          // node/user 物化值不能以明文或可枚举字段进入共享样本。
          [target.fieldBindings?.[dimension]?.logicalKey || "", target[dimension]]
        )),
        target.projectType,
        target.targetRole,
        target.repositoryOnly === true,
      ])
      .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right))),
  })).digest("hex").slice(0, 20);
  const requestedObservationId = String(input.observationId || "").trim();
  const id = requestedObservationId
    && safeSharedSegment(requestedObservationId)
    && root.samples[requestedObservationId]?.recordType === "observation"
    ? requestedObservationId
    : `CIU_${fingerprint}`;
  const existing = root.samples[id] || {};
  const expectedExistingIdentity = existing.id ? stableJsonText(existing) : "";
  const now = Date.now();
  const requestedOutcome = String(input.outcome || "started").trim().toLowerCase();
  if (!CONFIG_INFERENCE_EXECUTION_OUTCOMES.has(requestedOutcome)) {
    return {
      ok: false,
      statusCode: 400,
      code: "CONFIG_INFERENCE_EXECUTION_OUTCOME_INVALID",
      error: `不支持的真实执行状态：${requestedOutcome || "empty"}`,
      allowedOutcomes: [...CONFIG_INFERENCE_EXECUTION_OUTCOMES],
    };
  }
  // 真实执行状态只能从 started 提升到 success，迟到的开始事件或跨设备重试
  // 不能把已经成功的 5 星样本降回 4 星。
  const currentOutcome = String(existing.observation?.outcome || existing.execution?.outcome || "").trim().toLowerCase();
  const outcome = currentOutcome === "accepted" && !["accepted", "reverted"].includes(requestedOutcome)
    ? "accepted"
    : currentOutcome === "reverted" && !["reverted", "accepted"].includes(requestedOutcome)
      ? "reverted"
      : currentOutcome === "success" && requestedOutcome === "started"
        ? "success"
        : requestedOutcome;
  const reviewer = sanitizeSharedTrainingText(input.reviewer || input.approvedBy, 200);
  const verified = input.verified === true || existing.observation?.verified === true;
  const approved = input.approved === true || existing.observation?.approved === true;
  if (outcome === "accepted" && (!verified || !approved || !reviewer)) {
    return {
      ok: false,
      statusCode: 409,
      code: "CONFIG_INFERENCE_EXECUTION_ACCEPTANCE_REQUIRED",
      error: "accepted 必须同时提供 verified=true、approved=true 和审批人",
    };
  }
  const servingStatus = outcome === "accepted" && verified && approved
    ? "approved"
    : ["failed", "aborted", "reverted"].includes(outcome)
      ? "revoked"
      : "pending";
  const previousServingStatus = configInferenceSampleServingStatus(existing);
  const observationChanged = !existing.id
    || outcome !== currentOutcome
    || verified !== (existing.observation?.verified === true)
    || approved !== (existing.observation?.approved === true);
  const observationHistory = Array.isArray(existing.observation?.history)
    ? existing.observation.history
    : [];
  const sample = {
    ...existing,
    id,
    projectId: pid,
    recordType: "observation",
    source: "actual_execution",
    rating: servingStatus === "approved" ? 5 : null,
    score: servingStatus === "approved" ? 5 : null,
    ticket,
    signals: extractConfigInferenceSignals(ticket, registry.keywordMappings),
    observedConfig: { targets },
    groundTruth: servingStatus === "approved" ? { targets } : null,
    observation: {
      ...(existing.observation || {}),
      outcome,
      verified,
      approved,
      verifiedBy: verified
        ? sanitizeSharedTrainingText(input.verifiedBy || reviewer || existing.observation?.verifiedBy, 200)
        : "",
      approvedBy: approved
        ? sanitizeSharedTrainingText(input.approvedBy || reviewer || existing.observation?.approvedBy, 200)
        : "",
      reason: sanitizeSharedTrainingText(input.reason || existing.observation?.reason, 4000),
      sourceCoverageGate: configInferenceSourceCoverageGate(ticket),
      history: observationChanged
        ? [...observationHistory, {
          from: currentOutcome || null,
          to: outcome,
          verified,
          approved,
          actor: reviewer,
          at: now,
        }].slice(-50)
        : observationHistory,
      updatedAt: now,
    },
    serving: {
      ...(existing.serving || {}),
      status: servingStatus,
      revision: previousServingStatus === servingStatus
        ? Math.max(0, Math.trunc(Number(existing.serving?.revision) || 0))
        : Math.max(0, Math.trunc(Number(existing.serving?.revision) || 0)) + 1,
      reason: servingStatus === "approved" ? "accepted_verified_approved" : `execution_${outcome}`,
      updatedAt: now,
      updatedBy: reviewer,
      ...(servingStatus === "approved" ? { approvedAt: now, approvedBy: reviewer } : {}),
    },
    execution: {
      ...(existing.execution || {}),
      tabId: tab.id,
      taskId: String(input.taskId || existing.execution?.taskId || ""),
      actionKind,
      mode: tab.mode || "local",
      outcome,
      verified,
      approved,
      startedAt: existing.execution?.startedAt || now,
      updatedAt: now,
    },
    useCount: Number(existing.useCount || 0) + (existing.id ? 0 : 1),
    createdAt: existing.createdAt || now,
    updatedAt: now,
  };
  root.samples[id] = sample;
  const expectedTrimDeletes = new Map();
  try {
    writeSharedOps(cfg, [
      { type: "byProject.set", projectId: pid, path: ["aiTraining", "configInference", "samples", id], value: sample },
      ...trimConfigInferenceSection(root, "samples", pid, expectedTrimDeletes),
    ], {
      guard: (latest) => {
        const trimGuard = guardConfigInferenceTrimDeletes(latest, pid, expectedTrimDeletes);
        if (trimGuard !== true) return trimGuard;
        const latestSample = configInferenceSharedRoot(latest, pid).samples?.[id];
        if (!expectedExistingIdentity) return latestSample ? "实际执行样本已由其它 Gateway 创建" : true;
        return stableJsonText(latestSample) === expectedExistingIdentity
          ? true
          : "实际执行样本已由其它 Gateway 更新";
      },
    });
  } catch (error) {
    if (error?.code === "SHARED_WRITE_CONFLICT" && Number(input.__sharedRetry || 0) < 2) {
      return recordConfigInferenceUsage(pid, { ...input, __sharedRetry: Number(input.__sharedRetry || 0) + 1 });
    }
    if (error?.code === "SHARED_WRITE_CONFLICT") {
      return { ok: false, statusCode: 409, error: error.message || "实际执行样本已更新，请重试" };
    }
    throw error;
  }
  return {
    ok: true,
    data: { ...configInferenceBoundSample(pid, root, sample), servingStatus },
    observation: true,
    learned: servingStatus === "approved",
  };
}

export function transitionConfigInferenceObservation(projectId, id, input = {}) {
  const pid = explicitConfigInferenceProjectId(projectId);
  if (!pid) return { ok: false, statusCode: 400, error: "执行 observation 治理必须指定有效 TB 项目" };
  const cfg = loadRawConfig();
  const root = configInferenceRoot(cfg, pid);
  const key = String(id || "").trim();
  const observation = root.samples[key]
    || configInferenceAllSamples(root).find((row) => row.recordType === "observation"
      && (String(row.id || "") === key || String(row.execution?.tabId || "") === key));
  if (!observation || observation.recordType !== "observation") {
    return { ok: false, statusCode: 404, error: "执行 observation 不存在" };
  }
  const tab = getTab(observation.execution?.tabId);
  if (!tab) return { ok: false, statusCode: 409, error: "原故事点已不存在，不能无上下文修改执行 observation" };
  return recordConfigInferenceUsage(pid, {
    ...input,
    observationId: observation.id,
    tab,
    ticket: observation.ticket,
    targets: observation.observedConfig?.targets || observation.groundTruth?.targets || [],
    taskId: observation.execution?.taskId || "",
    actionKind: observation.execution?.actionKind || "develop_started",
  });
}

function guardConfigInferenceRunDelete(latestRow, expectedRowIdentity) {
  if (!latestRow) return "配置推理记录已不存在";
  return stableJsonText(latestRow) === expectedRowIdentity
    ? true
    : "配置推理记录已由其它请求更新";
}

export function __testGuardConfigInferenceRunDelete(latestRow, expectedRow) {
  return guardConfigInferenceRunDelete(latestRow, stableJsonText(expectedRow));
}

export function deleteConfigInferenceRun(projectId, id, input = {}) {
  const pid = explicitConfigInferenceProjectId(projectId);
  const key = explicitConfigInferenceRunId(id);
  if (!pid || !key) return { ok: false, statusCode: 400, error: "删除配置推理记录必须指定有效的 TB 项目和 runId" };
  const cfg = loadRawConfig();
  const root = configInferenceRoot(cfg, pid);
  const row = root.runs[key];
  if (!row) return { ok: false, error: "配置推理记录不存在" };
  const expectedRowIdentity = stableJsonText(row);
  const expectedClaimDeletes = new Map();
  const ops = [{ type: "byProject.delete", projectId: pid, path: ["aiTraining", "configInference", "runs", key] }];
  const annotation = findConfigInferenceAnnotation(root, key);
  const expectedAnnotationIdentity = annotation ? stableJsonText(annotation) : "";
  if (annotation) {
    const now = Date.now();
    annotation.sourceRun = {
      ...(annotation.sourceRun || {}),
      id: key,
      deleted: true,
      deletedAt: now,
      deletedBy: String(input.reviewer || input.actor || "").trim().slice(0, 200),
    };
    annotation.updatedAt = Math.max(now, Number(annotation.updatedAt || 0) + 1);
    root.samples[annotation.id] = annotation;
    ops.push({
      type: "byProject.set",
      projectId: pid,
      path: ["aiTraining", "configInference", "samples", annotation.id],
      value: annotation,
    });
  }
  const ticketId = row.trigger === "training_random" && !row.review ? configInferenceTicketId(row.ticket) : "";
  const claim = ticketId ? root.trainingClaims?.[ticketId] : null;
  if (ticketId && configInferenceTrainingClaimMatchesRun(claim, row)) {
    expectedClaimDeletes.set(ticketId, cloneJson(claim));
    delete root.trainingClaims[ticketId];
    ops.push({ type: "byProject.delete", projectId: pid, path: ["aiTraining", "configInference", "trainingClaims", ticketId] });
  }
  delete root.runs[key];
  try {
    writeSharedOps(cfg, ops, {
      guard: (latest) => {
        const latestRoot = configInferenceSharedRoot(latest, pid);
        const rowGuard = guardConfigInferenceRunDelete(latestRoot.runs?.[key], expectedRowIdentity);
        if (rowGuard !== true) return rowGuard;
        if (annotation && stableJsonText(latestRoot.samples?.[annotation.id]) !== expectedAnnotationIdentity) {
          return "annotation 已被其它请求更新；请先刷新，再决定是否撤销后删除 run";
        }
        return guardConfigInferenceTrainingClaimDeletes(latest, pid, expectedClaimDeletes);
      },
    });
  } catch (error) {
    if (error?.code === "SHARED_WRITE_CONFLICT") {
      return { ok: false, statusCode: 409, error: error.message || "配置推理记录已更新，请刷新后重试" };
    }
    throw error;
  }
  return {
    ok: true,
    releasedClaim: expectedClaimDeletes.size > 0,
    annotation: annotation ? {
      id: annotation.id,
      servingStatus: configInferenceSampleServingStatus(annotation),
      retained: true,
      explicitRevokeRequired: configInferenceSampleServingStatus(annotation) === "approved",
    } : null,
  };
}

// ===== "同一工程的多份备份/副本"识别（不同路径/分支/改动，但同一个 git 远程）=====
// 读取工程的 git 远程地址(origin url)。同一个 repo 拷到不同路径，remote 一致 → 视为同一工程的副本。
export function gitRemoteUrl(projPath) {
  try {
    let gitDir = path.join(projPath, ".git");
    const st = fs.statSync(gitDir);
    if (st.isFile()) { // worktree/submodule：.git 是文件，指向真实 gitdir
      const m = fs.readFileSync(gitDir, "utf-8").match(/gitdir:\s*(.+)/);
      if (m) gitDir = path.resolve(projPath, m[1].trim());
    }
    const conf = fs.readFileSync(path.join(gitDir, "config"), "utf-8");
    const mm = conf.match(/\[remote "origin"\][\s\S]*?url\s*=\s*([^\r\n]+)/);
    return mm ? mm[1].trim() : "";
  } catch { return ""; }
}
export function repositoryKey(remoteUrl) {
  const raw = String(remoteUrl || "").trim().replace(/[?#].*$/, "");
  if (!raw) return "";
  let host = "", repoPath = "";
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) {
    try {
      const parsed = new URL(raw);
      host = `${parsed.hostname || ""}${parsed.port ? `:${parsed.port}` : ""}`;
      repoPath = parsed.pathname || "";
    } catch {
      return "";
    }
  } else {
    const scp = raw.match(/^(?:[^@/\s]+@)?([^:/\s]+):(.+)$/);
    if (scp) {
      host = scp[1];
      repoPath = scp[2];
    } else {
      return raw.replace(/\\/g, "/").replace(/\.git$/i, "").replace(/^\/+|\/+$/g, "").toLowerCase();
    }
  }
  const cleanPath = repoPath.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "").replace(/\.git$/i, "");
  return host && cleanPath ? `${host.toLowerCase()}/${cleanPath.toLowerCase()}` : "";
}
const _normRemote = repositoryKey;
// 找"同一个工程的另一份本机可用备份"：优先同 git 远程；remoteUrl 可传入(记忆里存的)避免源路径已不在时读不到。
export function findAvailableSameProject(projectId, remoteUrl, branch = "") {
  const src = getProject(projectId);
  const want = _normRemote(remoteUrl || (src ? gitRemoteUrl(src.path) : ""));
  if (!want) return null;
  const wantedBranch = String(branch || "").trim();
  const candidates = listProjects().filter((p) => (
    p.id !== projectId
    && p.exists
    && _normRemote(gitRemoteUrl(p.path)) === want
  ));
  if (!candidates.length) return null;
  if (wantedBranch) {
    const exactBranch = candidates.find((candidate) => gitBranch(candidate.path) === wantedBranch);
    if (exactBranch) return exactBranch;
    // 后续应用故事点配置时会切换到目标分支；本机只有一份同远程源码时可直接复用，
    // 不应因为“当前分支”不同而错误降级为远程拉取。多份候选仍交给用户选择。
    return candidates.length === 1 ? candidates[0] : null;
  }
  return candidates[0];
}

// 按标题关键词识别 应用/车型（基础版：取标题映射里命中的第一个 app / vehicle）
export function recognizeFromTitleKeywords(projectId, keywords = []) {
  const title = getKeywordMappings(projectId).title;
  let app = "", vehicle = "";
  for (const k of keywords) {
    const m = title[k];
    if (!m || !m.value) continue;
    if (m.category === "app" && !app) app = m.value;
    else if (m.category === "vehicle" && !vehicle) vehicle = m.value;
  }
  return { app, vehicle };
}

// ===== 客户端本地 checkout 记录（per-client，工程的本地源码）=====
function loadLocalCheckouts() {
  try { return JSON.parse(fs.readFileSync(LOCAL_CHECKOUTS_FILE, "utf-8")) || {}; } catch { return {}; }
}
function saveLocalCheckouts(m) { ensureDir(); fs.writeFileSync(LOCAL_CHECKOUTS_FILE, JSON.stringify(m, null, 2), "utf-8"); }

// 某工程在本机已有的本地源码列表（只返回仍存在于磁盘的）。本地映射键 = 工程名+分支。
export function getLocalCheckouts(projectId) {
  const out = [];
  const m = loadLocalCheckouts();
  for (const x of (m[projectId] || [])) {
    if (x?.path && fs.existsSync(x.path) && !out.some((o) => normPath(o.path) === normPath(x.path))) {
      out.push({ path: x.path, name: x.name || x.path, vehicle: x.vehicle || "", tbId: x.tbId || "", branch: x.branch || "", source: "clone" });
    }
  }
  return out;
}

// 按 工程+分支 查本地源码路径（后续 TB 单新建故事点自动配本地路径用）
export function findLocalCheckout(projectId, branch) {
  const b = String(branch || "").trim();
  return getLocalCheckouts(projectId).find((x) => String(x.branch || "").trim() === b) || null;
}

// 记录一次本地 checkout（拉取完成 / 手动添加），供后续复用
export function recordLocalCheckout(projectId, info = {}) {
  if (!projectId || !info.path) return;
  const m = loadLocalCheckouts();
  m[projectId] = Array.isArray(m[projectId]) ? m[projectId] : [];
  if (!m[projectId].some((x) => normPath(x.path) === normPath(info.path))) {
    m[projectId].push({ path: String(info.path), name: info.name || "", vehicle: info.vehicle || "", tbId: info.tbId || "", branch: info.branch || "", addedAt: Date.now() });
    saveLocalCheckouts(m);
  }
}

// 工程是否有本地源码（admin 配的 localPath 存在，或本机记录过 checkout）
export function projectHasLocal(projectId) {
  return getLocalCheckouts(projectId).length > 0;
}

// 车型映射 → { apps:[{appName, repos:[{repoId,branch,flavor}]}], entries:[{projectId,branch,flavor}] }
// entries 为 apps 下所有仓库的展平（projectId=repoId），供克隆/故事点远程拉取复用。
// 兼容三代旧结构：新 apps / 上一版 entries / 最老 {appMarketBranch,...}
export function normalizeVehicleMapping(flavor, m) {
  if (!m || typeof m !== "object") return { apps: [], entries: [] };
  // 车型源码配置允许业务侧挂载扩展字段。标准化时只覆盖本模块认识的字段，
  // 其余元数据必须原样保留，否则一次 AI 训练写回就会静默裁掉发布/展示配置。
  const repo = (r) => ({
    ...(r && typeof r === "object" ? cloneJson(r) : {}),
    repoId: String(r?.repoId || r?.projectId || "").trim(),
    branch: String(r?.branch || "").trim(),
    flavor: String(r?.flavor || flavor || "").trim(),
  });
  let apps;
  if (Array.isArray(m.apps)) {
    apps = m.apps.filter((a) => a && typeof a === "object").map((a) => ({
      ...cloneJson(a),
      appName: String(a.appName || "").trim(),
      repos: (Array.isArray(a.repos) ? a.repos : []).filter((r) => r && (r.repoId || r.projectId)).map(repo),
    }));
  } else if (Array.isArray(m.entries)) {
    apps = [{ appName: "", repos: m.entries.filter((e) => e && e.projectId).map(repo) }];
  } else {
    const repos = [];
    if (m.appMarketBranch) repos.push(repo({ repoId: "appMarket", branch: m.appMarketBranch }));
    if (m.needWebApp) repos.push(repo({ repoId: "webApp", branch: m.webAppBranch || m.appMarketBranch }));
    if (m.needSdk) repos.push(repo({ repoId: "appMarketSdk", branch: m.sdkBranch }));
    apps = repos.length ? [{ appName: "", repos }] : [];
  }
  const sourceEntries = Array.isArray(m.entries) ? m.entries : [];
  const tupleKey = (r) => [
    String(r?.repoId || r?.projectId || "").trim().toLowerCase(),
    String(r?.branch || "").trim(),
    String(r?.flavor || "").trim(),
  ].join("\u0000");
  const entries = apps.flatMap((a) => a.repos.map((r) => ({
    ...cloneJson(sourceEntries.find((entry) => tupleKey(entry) === tupleKey(r)) || {}),
    projectId: r.repoId,
    branch: r.branch,
    flavor: r.flavor,
    ...(r.targetRole ? { targetRole: r.targetRole } : {}),
    ...(Number(r.order) > 0 ? { order: Math.trunc(Number(r.order)) } : {}),
  })));
  const out = { ...cloneJson(m), apps, entries };
  // 生产发布目录（每车型一个，UNC/本地路径均可）——「发布生产」时 prod release 包+mapping 拷到此处
  const prodReleaseDir = String(m.prodReleaseDir || "").trim();
  if (prodReleaseDir) out.prodReleaseDir = prodReleaseDir;
  else delete out.prodReleaseDir;
  // 是否需要重新签名（默认 false）——为 true 时发布生产的钉钉消息：版本号带 _未签名 后缀、且不 @ 人
  if (m.needsResign) out.needsResign = true;
  else delete out.needsResign;
  return out;
}

export function applyProjectDefSyncMaterialization({ action = "set", definition, id }) {
  const targetId = String(id || definition?.id || "").trim();
  if (!targetId) throw new Error("仓库定义同步缺少 id");
  if (action === "delete") return deleteProjectDef(targetId);
  return upsertProjectDef(normalizeTeamProjectDef({ ...(definition || {}), id: targetId }));
}

// 局域网团队配置采用显式白名单。prodReleaseDir、任意扩展字段和本机目录
// 只保留在各节点本地，不进入签名 op 或团队同步包。
export function normalizeTeamVehicleMapping(flavor, mapping) {
  const normalized = normalizeVehicleMapping(flavor, mapping);
  const apps = (normalized.apps || []).map((app) => ({
    appName: String(app?.appName || "").trim(),
    repos: (app?.repos || []).map((repo) => ({
      repoId: String(repo?.repoId || "").trim(),
      branch: String(repo?.branch || "").trim(),
      flavor: String(repo?.flavor || flavor || "").trim(),
      ...(repo?.targetRole ? { targetRole: String(repo.targetRole).trim() } : {}),
      ...(Number(repo?.order) > 0 ? { order: Math.trunc(Number(repo.order)) } : {}),
    })),
  }));
  return normalizeVehicleMapping(flavor, {
    apps,
    ...(normalized.needsResign ? { needsResign: true } : {}),
  });
}

export function mergeTeamVehicleMapping(flavor, localMapping, teamMapping) {
  const local = normalizeVehicleMapping(flavor, localMapping || {});
  const team = normalizeTeamVehicleMapping(flavor, teamMapping || {});
  return normalizeVehicleMapping(flavor, {
    ...local,
    apps: team.apps,
    entries: team.entries,
    ...(team.needsResign ? { needsResign: true } : { needsResign: false }),
  });
}

function hasVehicleMapEntries(map) {
  return map && typeof map === "object" && !Array.isArray(map) && Object.keys(map).length > 0;
}

function hasAnyVehicleMap(cfg) {
  if (hasVehicleMapEntries(cfg.vehicleMap)) return true;
  for (const bucket of Object.values((cfg.byProject && typeof cfg.byProject === "object") ? cfg.byProject : {})) {
    if (hasVehicleMapEntries(bucket?.vehicleMap)) return true;
  }
  return false;
}

function ensureDefaultVehicleMap(cfg, projectId) {
  if (cfg.vehicleMapSeededAt || hasAnyVehicleMap(cfg)) return false;
  const bucket = projectBucket(cfg, projectId);
  bucket.vehicleMap = JSON.parse(JSON.stringify(DEFAULT_VEHICLE_MAP));
  cfg.vehicleMapSeededAt = Date.now();
  for (const [vehicle, value] of Object.entries(bucket.vehicleMap)) {
    appendSharedOp(cfg, { type: "byProject.set", projectId: projectId || defaultPid(), path: ["vehicleMap", vehicle], value });
  }
  return true;
}

// 读取远程配置（仓库定义[全局] / 克隆父路径[全局] / 车型映射[按项目]）。
export function getRemoteConfig(projectId) {
  const normalizedProjectId = normalizeVehicleProjectId(projectId);
  const cfg = loadRawConfig();
  const migrated = ensureMigrated(cfg);
  if (migrated) persistSharedConfig(cfg);
  const defs = getProjectDefs();
  const byId = Object.fromEntries(defs.map((d) => [d.id, { https: d.https, ssh: d.ssh }]));
  const rawVm = projectBucket(cfg, normalizedProjectId).vehicleMap || {};
  const vehicleMap = {};
  for (const [flavor, m] of Object.entries(rawVm)) vehicleMap[flavor] = normalizeVehicleMapping(flavor, m);
  return {
    projectId: normalizedProjectId,
    revision: Number(cfg._sharedVersion) || 0,
    projectDefs: defs,
    remotes: {
      appMarket: byId.appMarket || { ...DEFAULT_REMOTES.appMarket },
      appMarketSdk: byId.appMarketSdk || { ...DEFAULT_REMOTES.appMarketSdk },
      webApp: byId.webApp || { ...DEFAULT_REMOTES.webApp },
    },
    cloneParent: getLocalCloneParent(),
    defaultCloneParent: resolveDefaultCloneParent(),
    vehicleMap,
  };
}

// 默认车型只能由显式初始化/迁移调用创建；普通 GET 必须保持纯读。
export function initializeVehicleMap(projectId) {
  const normalizedProjectId = normalizeVehicleProjectId(projectId, { required: true });
  const cfg = loadRawConfig();
  ensureMigrated(cfg);
  const seeded = ensureDefaultVehicleMap(cfg, normalizedProjectId);
  if (!seeded) {
    return { ok: true, noOp: true, config: getRemoteConfig(normalizedProjectId) };
  }
  persistSharedConfig(cfg);
  emitWs("shared_config_changed", {
    configSpace: devbenchSyncScope(),
    projectIds: [normalizedProjectId],
    entityKeys: Object.keys(projectBucket(cfg, normalizedProjectId).vehicleMap || {})
      .map((flavor) => `${normalizedProjectId}/${flavor}`),
    revision: cfg._sharedVersion,
    sourceNodeId: sharedNodeId(),
  });
  return { ok: true, initialized: true, config: getRemoteConfig(normalizedProjectId) };
}

// 更新克隆父路径（全局，本机路径）。remotes 已由仓库定义取代，仅保留 cloneParent。
export function updateRemoteConfig(patch = {}, projectId) {
  if (patch.cloneParent !== undefined) setLocalCloneParent(String(patch.cloneParent || "").trim() || getDefaultCloneParent());
  return getRemoteConfig(projectId);
}

// 设置/删除某项目下某 车型 的源码映射预置（按项目隔离）。mapping=null 删除。
export function setVehicleMapping(projectId, flavor, mapping, opts = {}) {
  const normalizedProjectId = normalizeVehicleProjectId(projectId, { required: true });
  const key = String(flavor || "").trim();
  if (!key) return { ok: false, error: "车型不能为空" };
  const cfg = loadRawConfig();
  ensureMigrated(cfg);
  const bucket = projectBucket(cfg, normalizedProjectId);
  bucket.vehicleMap = (bucket.vehicleMap && typeof bucket.vehicleMap === "object") ? bucket.vehicleMap : {};
  const current = Object.hasOwn(bucket.vehicleMap, key)
    ? normalizeVehicleMapping(key, bucket.vehicleMap[key])
    : null;
  const next = mapping == null
    ? null
    : (opts.teamSync
      ? mergeTeamVehicleMapping(key, current, mapping)
      : normalizeVehicleMapping(key, mapping));
  if (canonicalJson(current) === canonicalJson(next)) {
    return {
      ok: true,
      noOp: true,
      revision: Number(cfg._sharedVersion) || 0,
      config: getRemoteConfig(normalizedProjectId),
    };
  }
  if (mapping == null) {
    delete bucket.vehicleMap[key];
    writeSharedOps(cfg, { type: "byProject.delete", projectId: normalizedProjectId, path: ["vehicleMap", key] });
  } else {
    bucket.vehicleMap[key] = next;
    writeSharedOps(cfg, { type: "byProject.set", projectId: normalizedProjectId, path: ["vehicleMap", key], value: bucket.vehicleMap[key] });
  }
  if (opts.emit !== false) {
    emitWs("shared_config_changed", {
      configSpace: devbenchSyncScope(),
      projectIds: [normalizedProjectId],
      entityKeys: [`${normalizedProjectId}/${key}`],
      revision: cfg._sharedVersion,
      sourceNodeId: sharedNodeId(),
    });
  }
  return {
    ok: true,
    noOp: false,
    revision: Number(cfg._sharedVersion) || 0,
    config: getRemoteConfig(normalizedProjectId),
  };
}

export function getVehicleSyncSnapshot() {
  const cfg = loadRawConfig();
  const migrated = ensureMigrated(cfg);
  if (migrated) persistSharedConfig(cfg);
  const byProject = {};
  for (const [projectId, bucket] of Object.entries(isPlainObject(cfg.byProject) ? cfg.byProject : {})) {
    if (!safeDataKey(projectId) || !isPlainObject(bucket?.vehicleMap)) continue;
    const vehicleMap = {};
    for (const [flavor, mapping] of Object.entries(bucket.vehicleMap)) {
      if (!safeSharedSegment(flavor)) continue;
      vehicleMap[flavor] = normalizeTeamVehicleMapping(flavor, mapping);
    }
    if (Object.keys(vehicleMap).length) byProject[projectId] = vehicleMap;
  }
  return {
    revision: Number(cfg._sharedVersion) || 0,
    byProject,
  };
}

export function getVehicleSyncTombstones() {
  const cfg = loadRawConfig();
  ensureMigrated(cfg);
  const live = getVehicleSyncSnapshot().byProject;
  const latest = new Map();
  for (const op of Array.isArray(cfg.sharedOps) ? cfg.sharedOps : []) {
    if (op?.type !== "byProject.delete"
      || op?.path?.[0] !== "vehicleMap"
      || !op.path?.[1]) continue;
    const projectId = String(op.projectId || "").trim();
    const flavor = String(op.path[1] || "").trim();
    if (!projectId || !safeDataKey(projectId) || !safeSharedSegment(flavor)) continue;
    if (Object.hasOwn(live[projectId] || {}, flavor)) continue;
    const key = `${projectId}\u0000${flavor}`;
    const previous = latest.get(key);
    const version = Number(op.version) || Number(op.at) || 0;
    if (!previous || version > previous.version) {
      latest.set(key, {
        projectId,
        flavor,
        version,
        createdAt: Number(op.at) || version || Date.now(),
        legacyOpId: String(op.id || ""),
      });
    }
  }
  return [...latest.values()].sort((left, right) => (
    left.projectId.localeCompare(right.projectId) || left.flavor.localeCompare(right.flavor)
  ));
}

/**
 * 应用已经过 LAN 协议验签、幂等和冲突判断的远端车型操作。
 *
 * 这里更新物化快照，并用远端 opId 写一条 legacy sharedOps 影子记录，以便滚动
 * 升级期间旧 Gateway 仍能看见变更；不会创建新的 lan_sync_ops，也不会改变
 * origin，因此不会形成事件转发环。
 */
export function applyVehicleSyncMaterialization({
  projectId,
  flavor,
  mapping,
  action = "set",
  opId,
  originNodeId,
  originSeq,
  createdAt,
  emit = true,
}) {
  const normalizedProjectId = normalizeVehicleProjectId(projectId, { required: true });
  const key = String(flavor || "").trim();
  if (!safeSharedSegment(key)) {
    throw Object.assign(new Error("车型不合法"), { statusCode: 400, code: "VEHICLE_FLAVOR_INVALID" });
  }
  const cfg = loadRawConfig();
  ensureMigrated(cfg);
  const bucket = projectBucket(cfg, normalizedProjectId);
  bucket.vehicleMap = isPlainObject(bucket.vehicleMap) ? bucket.vehicleMap : {};
  const current = Object.hasOwn(bucket.vehicleMap, key)
    ? normalizeVehicleMapping(key, bucket.vehicleMap[key])
    : null;
  const next = action === "delete" ? null : mergeTeamVehicleMapping(key, current, mapping);
  if (canonicalJson(current) === canonicalJson(next)) {
    return { ok: true, noOp: true, config: getRemoteConfig(normalizedProjectId) };
  }
  if (next == null) delete bucket.vehicleMap[key];
  else bucket.vehicleMap[key] = next;

  cfg._sharedVersion = nextSharedVersion(cfg._sharedVersion);
  const shadow = {
    type: next == null ? "byProject.delete" : "byProject.set",
    projectId: normalizedProjectId,
    path: ["vehicleMap", key],
    ...(next == null ? {} : { value: next }),
    id: String(opId || `${originNodeId}:${originSeq}`),
    node: String(originNodeId || "lan-peer"),
    version: cfg._sharedVersion,
    at: Number(createdAt) || Date.now(),
    lanOriginSeq: Number(originSeq) || 0,
    ...(cfg.sharedRestoreClock?.id ? { restoreEpoch: String(cfg.sharedRestoreClock.id) } : {}),
  };
  if (!isValidSharedOp(shadow)) throw new Error("远端车型操作无法转换为共享操作");
  const opKey = sharedOpKey(shadow);
  cfg.sharedOpClocks = rebuildSharedOpClocks(cfg.sharedOpClocks, []);
  cfg.sharedOpClocks[opKey] = sharedOpClock(shadow);
  cfg.sharedOps = cleanSharedOps([...(Array.isArray(cfg.sharedOps) ? cfg.sharedOps : []), shadow]);
  persistSharedConfig(cfg);
  if (emit) {
    emitWs("shared_config_changed", {
      configSpace: devbenchSyncScope(),
      projectIds: [normalizedProjectId],
      entityKeys: [`${normalizedProjectId}/${key}`],
      revision: String(opId || cfg._sharedVersion),
      changeSetId: "",
      sourceNodeId: String(originNodeId || ""),
    });
  }
  return { ok: true, noOp: false, config: getRemoteConfig(normalizedProjectId) };
}

function referencedRepoIds(vehicleMap = {}) {
  const ids = new Set();
  for (const mapping of Object.values(isPlainObject(vehicleMap) ? vehicleMap : {})) {
    for (const app of Array.isArray(mapping?.apps) ? mapping.apps : []) {
      for (const repo of Array.isArray(app?.repos) ? app.repos : []) {
        const id = String(repo?.repoId || repo?.projectId || "").trim();
        if (id) ids.add(id);
      }
    }
    for (const entry of Array.isArray(mapping?.entries) ? mapping.entries : []) {
      const id = String(entry?.projectId || entry?.repoId || "").trim();
      if (id) ids.add(id);
    }
  }
  return ids;
}

export function exportVehicleSourceConfig(projectId) {
  const config = getRemoteConfig(projectId);
  const vehicleMap = cloneJson(config.vehicleMap || {});
  const ids = referencedRepoIds(vehicleMap);
  const projectDefs = getProjectDefs().filter((def) => ids.has(def.id)).map((def) => cloneJson(def));
  return {
    type: VEHICLE_SOURCE_EXPORT_TYPE,
    version: 1,
    exportedAt: new Date().toISOString(),
    projectId: projectId || defaultPid(),
    vehicleMap,
    projectDefs,
    cloneParent: config.cloneParent || "",
    summary: {
      vehicleCount: Object.keys(vehicleMap).length,
      projectDefCount: projectDefs.length,
    },
  };
}

function vehicleSourcePayload(input = {}) {
  const payload = isPlainObject(input?.data) ? input.data : input;
  if (!isPlainObject(payload)) return null;
  const vehicleMap = isPlainObject(payload.vehicleMap)
    ? payload.vehicleMap
    : (isPlainObject(payload.config?.vehicleMap) ? payload.config.vehicleMap : null);
  if (!isPlainObject(vehicleMap)) return null;
  return {
    type: payload.type || "",
    version: Number(payload.version) || 1,
    vehicleMap,
    projectDefs: Array.isArray(payload.projectDefs) ? payload.projectDefs : [],
    cloneParent: String(payload.cloneParent || ""),
  };
}

export function importVehicleSourceConfig(projectId, input = {}, opts = {}) {
  const payload = vehicleSourcePayload(input);
  if (!payload) return { ok: false, error: "导入文件格式不正确：缺少 vehicleMap" };
  if (payload.type && payload.type !== VEHICLE_SOURCE_EXPORT_TYPE) return { ok: false, error: "导入文件类型不正确" };
  const mode = opts.mode === "replace" ? "replace" : "merge";
  const importProjectDefs = opts.importProjectDefs !== false;
  const importCloneParent = opts.importCloneParent === true;
  const existing = getRemoteConfig(projectId).vehicleMap || {};
  const incoming = payload.vehicleMap || {};
  const incomingKeys = new Set(Object.keys(incoming).map((x) => String(x)));
  const result = db.transaction(() => {
    let importedProjectDefs = 0;
    if (importProjectDefs) {
      for (const def of payload.projectDefs || []) {
        const r = upsertProjectDef(def);
        if (!r?.ok) throw new Error(r?.error || "仓库定义导入失败");
        importedProjectDefs++;
      }
    }
    let deleted = 0;
    if (mode === "replace") {
      for (const flavor of Object.keys(existing)) {
        if (!incomingKeys.has(flavor)) {
          const r = setVehicleMapping(projectId, flavor, null, { emit: false });
          if (!r?.ok) throw new Error(r?.error || `车型「${flavor}」删除失败`);
          deleted++;
        }
      }
    }
    let imported = 0;
    for (const [flavor, mapping] of Object.entries(incoming)) {
      const key = String(flavor || "").trim();
      if (!key) continue;
      const r = setVehicleMapping(projectId, key, mapping, { emit: false });
      if (!r?.ok) throw new Error(r?.error || `车型「${key}」导入失败`);
      imported++;
    }
    return { importedProjectDefs, deleted, imported };
  }).immediate();
  if (importCloneParent && payload.cloneParent) updateRemoteConfig({ cloneParent: payload.cloneParent }, projectId);
  return {
    ok: true,
    mode,
    ...result,
    importedCloneParent: !!(importCloneParent && payload.cloneParent),
    config: getRemoteConfig(projectId),
  };
}

function genId(name) {
  const base = String(name || "proj")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 24) || "proj";
  return `${base}-${Math.random().toString(36).slice(2, 6)}`;
}

/**
 * 新增或更新一个工程（id 存在则更新，否则新建）。
 */
export function upsertProject({ id, name, path: p, webAppPath } = {}) {
  if (!name || !String(name).trim()) return { ok: false, error: "工程名称不能为空" };
  if (!p || !String(p).trim()) return { ok: false, error: "工程路径不能为空" };
  if (String(webAppPath || "").trim()) {
    return { ok: false, error: "WebApp 请作为独立工程配置，再在故事点中单独绑定" };
  }
  const projects = loadLocalProjects();
  const entry = {
    id: id || genId(name),
    name: String(name).trim(),
    path: String(p).trim(),
  };
  // 主工程路径不允许与其他工程重复
  const dup = projects.find((x) => x.id !== entry.id && normPath(x.path) === normPath(entry.path));
  if (dup) return { ok: false, error: `该主工程路径已存在（工程「${dup.name}」）` };
  const idx = projects.findIndex((x) => x.id === entry.id);
  if (idx >= 0) projects[idx] = entry;
  else projects.push(entry);
  saveLocalProjects(projects);
  return { ok: true, project: entry };
}

/**
 * 删除工程。被某个故事点选为主工程时拒绝删除。
 */
export function deleteProject(id) {
  const used = loadTabs().find((t) => t.primaryProjectId === id);
  if (used) return { ok: false, error: `工程被故事点「${used.title}」占用，不能删除` };
  const projects = loadLocalProjects().filter((x) => x.id !== id);
  const applications = getProjectApplications().map((application) => ({
    ...application,
    repositories: application.repositories.map((repository) => ({
      ...repository,
      projectIds: repository.projectIds.filter((projectId) => projectId !== id),
    })),
  }));
  saveLocalProjects(projects, { projectApplications: applications });
  return { ok: true };
}

export function clearProjects() {
  const cleared = loadLocalProjects().length;
  saveLocalProjects([], { repositoryBindings: {}, projectApplications: [] });
  return { ok: true, cleared };
}

// ========== Tab 持久化 ==========

function loadTabs() { return loadKind("tabs", TABS_FILE).filter((item) => !isTabPermanentlyDeleted(item?.id)); }
function saveTabs(tabs) { saveKind("tabs", (tabs || []).filter((item) => !isTabPermanentlyDeleted(item?.id))); }

export function listTabs() {
  return loadTabs();
}

export function getTab(id) {
  return loadTabs().find((t) => t.id === id) || null;
}

/**
 * 收集"除指定 tab 外"所有 tab 已引用的工程路径集合（用于互斥校验）
 * 引用包含：主工程 + 主工程的 webApp + 额外工程
 */
// 列出"其它故事点"占用的工程路径。excludeGroupId：把同组成员也排除（故事点组共用同一套工程，不算冲突）。
export function referencedPaths(excludeTabId = null, excludeGroupId = null) {
  const set = new Map(); // normPath -> { tabId, tabTitle, name }
  for (const t of loadTabs()) {
    if (t.id === excludeTabId) continue;
    if (excludeGroupId && t.groupId === excludeGroupId) continue; // 同组不算占用
    for (const ref of tabProjectPaths(t)) {
      set.set(normPath(ref.path), { tabId: t.id, tabTitle: t.title, name: ref.name });
    }
  }
  return set;
}

/**
 * 一个 tab 引用到的全部工程路径（主工程 + webApp + 额外工程）
 */
// 解析故事点的主工程（兼容本地工程模式与远程拉取模式）。返回 { id, name, path, webAppPath } 或 null。
export function getPrimaryProject(tab) {
  const managedEntries = Array.isArray(tab?.worktree?.entries) ? tab.worktree.entries : [];
  const isActiveManagedEntry = (entry) => (
    entry && entry.role !== "inactive" && entry.active !== false && entry.path
  );
  const managedPrimary = managedEntries.find((entry) => (
    isActiveManagedEntry(entry) && entry.role === "primary"
  ));
  if (managedPrimary) {
    const managedWebApp = managedEntries.find((entry) => (
      isActiveManagedEntry(entry) && entry.role === "webapp"
    ));
    return {
      id: tab?.primaryProjectId || managedPrimary.baseProjectId || null,
      name: managedPrimary.name || "主工程",
      path: managedPrimary.path,
      webAppPath: managedWebApp?.path || "",
      basePath: managedPrimary.basePath || "",
      managedWorktree: true,
      branch: managedPrimary.branch || "",
    };
  }
  // 本地故事点没有受管 worktree 时不得把登记的基仓当成工作目录，防止 AI/构建/切分支误改原工程。
  if (tab?.primaryProjectId && (tab?.mode || "local") === "local") return null;
  if (tab?.primaryProjectId) return getProject(tab.primaryProjectId);
  // 远程拉取模式：克隆完成后 remoteRepos 里的 primary(应用市场) 即主工程
  if (tab?.mode === "remote" && Array.isArray(tab.remoteRepos)) {
    const main = tab.remoteRepos.find((r) => r.role === "primary" && r.ok && r.path);
    if (main) {
      const web = tab.remoteRepos.find((r) => r.role === "webapp" && r.ok && r.path);
      return { id: null, name: main.name, path: main.path, webAppPath: web?.path || "" };
    }
  }
  return null;
}

export function tabProjectPaths(tab) {
  // 受管 worktree：一律以 entries 的真实 checkout 路径为准，避免 UI 仍显示基仓或过期目录名。
  // 优先 entry.path（可能是 worktree 内 WebApp 子目录），再回退 worktreePath。
  const managedEntries = Array.isArray(tab?.worktree?.entries) ? tab.worktree.entries : [];
  if (tab?.worktree?.managed && managedEntries.length) {
    const out = [];
    for (const entry of managedEntries) {
      if (!entry || entry.role === "inactive" || entry.active === false) continue;
      const target = String(entry.path || entry.worktreePath || "").trim();
      if (!target) continue;
      out.push({
        path: target,
        name: entry.name || path.basename(target),
        role: entry.role || "extra",
        branch: entry.branch || "",
        repositoryId: entry.repositoryId || "",
        logicalBranch: entry.logicalBranch || "",
        checkoutDirName: entry.checkoutDirName || "",
        mode: entry.mode || "EDITABLE",
        detached: entry.detached === true,
      });
    }
    if (out.length) return out;
  }
  const out = [];
  const p = getPrimaryProject(tab);
  if (p) {
    out.push({ path: p.path, name: p.name, role: "primary" });
    if (p.webAppPath) out.push({ path: p.webAppPath, name: `${p.name}/WebApp`, role: "webapp" });
  }
  // 远程拉取模式的 SDK 作为关联工程
  if (tab?.mode === "remote" && Array.isArray(tab.remoteRepos)) {
    for (const r of tab.remoteRepos) {
      if (r.role === "extra" && r.ok && r.path) out.push({ path: r.path, name: r.name, role: "extra" });
    }
  }
  for (const ex of tab.extraProjects || []) {
    out.push({ path: ex.path, name: ex.name || ex.path, role: "extra" });
  }
  return out;
}

// 基仓可被任意故事点复用；真实开发路径由各故事点 worktree 隔离。
// 保留该 API 供旧调用方兼容，但不再返回工程占用冲突。
export function checkPathAvailable() { return { ok: true }; }

/**
 * 找到第一个路径存在的本地基仓（用于新建 tab 默认主工程）。
 * 基仓不互斥，选中后由路由创建当前故事点专属 worktree。
 */
export function firstFreeProject(excludeTabId = null) {
  return listProjects().find((project) => project.exists) || null;
}

function newTabRecord({ title, projectDefId, initialUpdates = {}, occupiedIds = new Set() } = {}) {
  let id = "";
  do {
    id = `tab_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  } while (occupiedIds.has(id));
  const updates = initialUpdates && typeof initialUpdates === "object" && !Array.isArray(initialUpdates)
    ? { ...initialUpdates }
    : {};
  // URL 的稳定身份只在事务内临时计算，禁止把 url:<sha256> 作为业务字段落盘。
  delete updates.ticketIdentity;
  delete updates.ticketIdentities;
  const now = Date.now();
  return {
    id,
    sessionId: `dev_${id}`, // WS streaming + cli session 路由 key
    title: title || "新故事点",
    titleLocked: !!title,
    engine: "codex", // Claude 已下线；新建故事点统一从可用的 Codex 开始
    aiPrefs: {}, // { [engine]: { model?, tier? } } 故事点级模型/档位覆盖
    projectDefId: projectDefId || null, // 选定的工程（统一维度）
    primaryProjectId: null,
    worktree: null, // 本地工程只作为基仓；故事点实际在独立 Git worktree 中开发
    extraProjects: [], // [{ path, name }]
    reportMode: "short", // 每个 TB 单独立：short=只回写原因/措施；expert=图文影音 HTML→PDF 专家报告
    skipTestAcceptance: false, // 每个故事点持久化；故事点组切换时由工作流服务统一同步
    deviceSerial: null, // 绑定的目标设备（adb serial），跨故事点互斥
    cliSessionId: null, // claude --resume id（按 tab 续接上下文）
    cliSessionEngine: null,
    cliSessionIds: {},
    archiveDir: null, // 首条消息时落定的存档目录（绝对路径）
    storyStorageRoot: configuredStoryDevRoot(),
    turns: 0,
    createdAt: now,
    updatedAt: now,
    ...updates,
    // 初始化更新不能改写新记录的主键、会话键、标题和创建时间。
    id,
    sessionId: `dev_${id}`,
    title: title || "新故事点",
    titleLocked: !!title,
    createdAt: now,
    updatedAt: now,
  };
}

function storedStoryTicketIdentities(tab) {
  const context = tab?.tbContext || {};
  return storyTicketIdentities({
    tbTaskId: context.tbTaskId,
    ticketUrl: tab?.ticketUrl || context.ticketUrl,
    ticketId: context.ticketId || tab?.worktreeNaming?.ticketId,
    carbId: context.carbId,
    ticketBound: tab?.ticketBound === true
      || !!String(tab?.ticketUrl || context.ticketUrl || context.tbTaskId || "").trim(),
  });
}

function storyTicketIdentitySetsOverlap(requested, stored) {
  const requestedTask = requested.find((identity) => identity.startsWith("tb-task:"));
  const storedTask = stored.find((identity) => identity.startsWith("tb-task:"));
  // 两端都有一等 TB task id 时以 task id 为权威，避免标题中的 CARB 提示造成误撞。
  if (requestedTask && storedTask) return requestedTask === storedTask;
  return requested.some((identity) => stored.includes(identity));
}

/**
 * 在 tabs/closed 同一 SQLite 事务中完成最终唯一性检查与 Tab 插入。
 * 路由层的提前检查只用于快速反馈；该函数才是标题和显式票据身份的写入权威。
 */
export function createTabGuarded({ title, projectDefId, ticket = {}, initialUpdates = {} } = {}) {
  ensureCloneParentReady();
  const normalizedTitle = String(title || "").trim();
  if (!normalizedTitle) {
    return { ok: false, statusCode: 400, code: "STORY_TITLE_REQUIRED", error: "请先设置故事点标题" };
  }
  const requestedIdentities = storyTicketIdentities(ticket);
  const changed = updateDevbenchStoryState(storageUserKey("tabs"), ({ tabs, closed }) => {
    const activeStories = (Array.isArray(tabs) ? tabs : [])
      .filter((item) => !isTabPermanentlyDeleted(item?.id));
    const closedStories = (Array.isArray(closed) ? closed : [])
      .filter((item) => !isTabPermanentlyDeleted(item?.id));
    const candidates = [
      ...activeStories.map((tab) => ({ tab, closed: false })),
      ...closedStories.map((tab) => ({ tab, closed: true })),
    ];
    const titleOwner = candidates.find(({ tab }) => String(tab?.title || "").trim() === normalizedTitle);
    if (titleOwner) {
      return {
        result: {
          ok: false,
          statusCode: 409,
          code: "STORY_TITLE_TAKEN",
          error: `标题「${normalizedTitle}」已被${titleOwner.closed ? "已关闭" : "进行中"}故事点占用，请重新确认`,
          existingStory: { id: titleOwner.tab.id, title: titleOwner.tab.title, closed: titleOwner.closed },
        },
      };
    }
    const ticketOwner = requestedIdentities.length
      ? candidates.find(({ tab }) => storyTicketIdentitySetsOverlap(
        requestedIdentities,
        storedStoryTicketIdentities(tab),
      ))
      : null;
    if (ticketOwner) {
      return {
        result: {
          ok: false,
          statusCode: 409,
          code: "STORY_TICKET_TAKEN",
          error: `该任务已被${ticketOwner.closed ? "已关闭" : "进行中"}故事点「${ticketOwner.tab.title}」关联，不能重复关联`,
          existingStory: { id: ticketOwner.tab.id, title: ticketOwner.tab.title, closed: ticketOwner.closed },
        },
      };
    }
    const occupiedIds = new Set([
      ...(Array.isArray(tabs) ? tabs : []),
      ...(Array.isArray(closed) ? closed : []),
    ].map((item) => String(item?.id || "")).filter(Boolean));
    const tab = newTabRecord({
      title: normalizedTitle,
      projectDefId,
      initialUpdates,
      occupiedIds,
    });
    return {
      tabs: [...(Array.isArray(tabs) ? tabs : []), tab],
      result: { ok: true, tab },
    };
  }, nodeIdSafe());
  return changed.result || {
    ok: false,
    statusCode: 500,
    code: "STORY_CREATE_STATE_UPDATE_FAILED",
    error: "故事点原子创建失败",
  };
}

export function createTab({ title, projectDefId } = {}) {
  ensureCloneParentReady();
  const tabs = loadTabs();
  const tab = newTabRecord({
    title,
    projectDefId,
    occupiedIds: new Set(tabs.map((item) => String(item?.id || "")).filter(Boolean)),
  });
  tabs.push(tab);
  saveTabs(tabs);
  return tab;
}

const SEND_IDEMPOTENCY_MARKER_PREFIX = "devbench-send:v1:";
const SEND_IDEMPOTENCY_RESERVATIONS_FIELD = "sendIdempotencyReservations";
const SEND_IDEMPOTENCY_RESULT_KINDS = new Set([
  "queued",
  "device_queued",
  "injected",
  "started",
  "needs_confirmation",
]);

function parsePersistentSendMarker(value) {
  const marker = String(value || "");
  if (!marker.startsWith(SEND_IDEMPOTENCY_MARKER_PREFIX)) return null;
  const parts = marker.slice(SEND_IDEMPOTENCY_MARKER_PREFIX.length).split(":");
  if (parts.length !== 2 || !parts.every((part) => /^[a-f0-9]{64}$/.test(part))) return null;
  return { marker, keyHash: parts[0], payloadHash: parts[1] };
}

function persistentSendOwnerHash(ownerToken) {
  const token = String(ownerToken || "");
  return token ? createHash("sha256").update(token, "utf8").digest("hex") : "";
}

function persistentSendIdentity(value = {}) {
  const clean = (input) => String(input || "").trim().slice(0, 240);
  return {
    requestId: clean(value.requestId || value.deviceRuntimeRequestId),
    taskId: clean(value.taskId || value.deviceRuntimeTaskId),
    attemptId: clean(value.attemptId || value.workflowV2AttemptId),
    userMessageId: clean(value.userMessageId || value.workflowV2UserMessageId),
  };
}

function persistentSendReservations(tab) {
  return (Array.isArray(tab?.[SEND_IDEMPOTENCY_RESERVATIONS_FIELD])
    ? tab[SEND_IDEMPOTENCY_RESERVATIONS_FIELD]
    : [])
    .filter((item) => item && typeof item === "object" && !Array.isArray(item));
}

function persistentSendReservationIndex(tab, parsedMarker) {
  if (!parsedMarker) return -1;
  return persistentSendReservations(tab)
    .findIndex((item) => String(item?.keyHash || "") === parsedMarker.keyHash);
}

function persistentSendFailure(code, error, statusCode = 409, extra = {}) {
  return { ok: false, statusCode, code, error, ...extra };
}

/**
 * Acquire the cross-Gateway owner for one keyed /send request.
 *
 * Only hashes/marker, hashed owner proof and frozen runtime identities are
 * persisted. A process that disappears while status=reserved deliberately
 * leaves an uncertain record: another Gateway must fail closed instead of
 * repeating a possibly-completed external side effect.
 */
export function reserveTabSend({ tabId, marker, ownerToken, identities = {} } = {}) {
  const id = String(tabId || "").trim();
  const parsed = parsePersistentSendMarker(marker);
  const ownerHash = persistentSendOwnerHash(ownerToken);
  if (!id || !parsed || !ownerHash) {
    return persistentSendFailure(
      "SEND_IDEMPOTENCY_RESERVATION_INVALID",
      "发送幂等 reservation 参数无效",
      400,
    );
  }
  const frozenIdentities = persistentSendIdentity(identities);
  const changed = updateDevbenchStoryState(storageUserKey("tabs"), ({ tabs }) => {
    const currentTabs = Array.isArray(tabs) ? [...tabs] : [];
    const tabIndex = currentTabs.findIndex((tab) => (
      String(tab?.id || "") === id && !isTabPermanentlyDeleted(tab?.id)
    ));
    if (tabIndex < 0) {
      return { result: persistentSendFailure("SEND_IDEMPOTENCY_TAB_NOT_FOUND", "故事点不存在", 404) };
    }
    const current = currentTabs[tabIndex];
    const reservations = persistentSendReservations(current);
    const existingIndex = persistentSendReservationIndex(current, parsed);
    if (existingIndex >= 0) {
      const existing = reservations[existingIndex];
      if (String(existing.payloadHash || "") !== parsed.payloadHash) {
        return {
          result: persistentSendFailure(
            "SEND_IDEMPOTENCY_PAYLOAD_CONFLICT",
            "该发送幂等键已用于不同消息，请生成新的 clientMessageId 后重试",
            409,
            { conflict: true, reservation: existing },
          ),
        };
      }
      if (existing.status === "committed") {
        return { result: { ok: true, acquired: false, replay: true, reservation: existing, tab: current } };
      }
      return {
        result: persistentSendFailure(
          "SEND_IDEMPOTENCY_PENDING",
          "该发送请求已有持久 reservation，结果仍不确定；为避免重复副作用，本次不会自动重放",
          409,
          { pending: true, reservation: existing, tab: current },
        ),
      };
    }
    const now = Date.now();
    const reservation = {
      version: 1,
      marker: parsed.marker,
      keyHash: parsed.keyHash,
      payloadHash: parsed.payloadHash,
      ownerHash,
      status: "reserved",
      resultKind: null,
      identities: frozenIdentities,
      createdAt: now,
      updatedAt: now,
    };
    const updated = {
      ...current,
      [SEND_IDEMPOTENCY_RESERVATIONS_FIELD]: [...reservations, reservation],
      updatedAt: now,
    };
    currentTabs[tabIndex] = updated;
    return {
      tabs: currentTabs,
      result: { ok: true, acquired: true, replay: false, reservation, tab: updated },
    };
  }, nodeIdSafe());
  return changed.result || persistentSendFailure(
    "SEND_IDEMPOTENCY_RESERVATION_FAILED",
    "发送幂等 reservation 写入失败",
    500,
  );
}

/** Commit a keyed send outcome, optionally appending its queue item atomically. */
export function commitTabSend({
  tabId,
  marker,
  ownerToken,
  resultKind,
  identities = {},
  queueMessage = null,
} = {}) {
  const id = String(tabId || "").trim();
  const parsed = parsePersistentSendMarker(marker);
  const ownerHash = persistentSendOwnerHash(ownerToken);
  const kind = String(resultKind || "").trim();
  if (!id || !parsed || !ownerHash || !SEND_IDEMPOTENCY_RESULT_KINDS.has(kind)) {
    return persistentSendFailure(
      "SEND_IDEMPOTENCY_COMMIT_INVALID",
      "发送幂等结果提交参数无效",
      400,
    );
  }
  let normalizedQueueMessage = null;
  try {
    normalizedQueueMessage = queueMessage == null ? null : createQueuedMessage(queueMessage);
  } catch (error) {
    return persistentSendFailure(
      error?.code || "SEND_IDEMPOTENCY_QUEUE_INVALID",
      error?.message || "发送队列消息无效",
      error?.statusCode || 400,
    );
  }
  const suppliedIdentities = persistentSendIdentity(identities);
  const changed = updateDevbenchStoryState(storageUserKey("tabs"), ({ tabs }) => {
    const currentTabs = Array.isArray(tabs) ? [...tabs] : [];
    const tabIndex = currentTabs.findIndex((tab) => (
      String(tab?.id || "") === id && !isTabPermanentlyDeleted(tab?.id)
    ));
    if (tabIndex < 0) {
      return { result: persistentSendFailure("SEND_IDEMPOTENCY_TAB_NOT_FOUND", "故事点不存在", 404) };
    }
    const current = currentTabs[tabIndex];
    const reservations = persistentSendReservations(current);
    const reservationIndex = persistentSendReservationIndex(current, parsed);
    if (reservationIndex < 0) {
      return {
        result: persistentSendFailure(
          "SEND_IDEMPOTENCY_RESERVATION_MISSING",
          "发送幂等 reservation 不存在，拒绝提交副作用结果",
          409,
        ),
      };
    }
    const reservation = reservations[reservationIndex];
    if (String(reservation.payloadHash || "") !== parsed.payloadHash) {
      return {
        result: persistentSendFailure(
          "SEND_IDEMPOTENCY_PAYLOAD_CONFLICT",
          "该发送幂等键已用于不同消息",
          409,
        ),
      };
    }
    if (reservation.status === "committed") {
      return {
        result: {
          ok: true,
          idempotent: true,
          reservation,
          tab: current,
          queue: Array.isArray(current.queue) ? current.queue : [],
        },
      };
    }
    if (reservation.status !== "reserved" || reservation.ownerHash !== ownerHash) {
      return {
        result: persistentSendFailure(
          "SEND_IDEMPOTENCY_OWNER_MISMATCH",
          "发送幂等 reservation 已由其他 Gateway 持有",
          409,
        ),
      };
    }
    const mergedIdentities = persistentSendIdentity({
      ...(reservation.identities || {}),
      ...Object.fromEntries(Object.entries(suppliedIdentities).filter(([, value]) => value)),
    });
    let queue = Array.isArray(current.queue) ? [...current.queue] : [];
    if (normalizedQueueMessage) {
      const requestId = String(
        normalizedQueueMessage.deviceRuntimeRequestId || mergedIdentities.requestId || "",
      );
      const userMessageId = String(
        normalizedQueueMessage.workflowV2UserMessageId || mergedIdentities.userMessageId || "",
      );
      const duplicate = queue.some((message) => (
        (requestId && String(message?.deviceRuntimeRequestId || "") === requestId)
        || (userMessageId && String(message?.workflowV2UserMessageId || "") === userMessageId)
      ));
      if (!duplicate) queue.push(normalizedQueueMessage);
    }
    const now = Date.now();
    const committed = {
      ...reservation,
      ownerHash: reservation.ownerHash,
      status: "committed",
      resultKind: kind,
      identities: mergedIdentities,
      committedAt: now,
      updatedAt: now,
    };
    reservations[reservationIndex] = committed;
    const updated = {
      ...current,
      ...(normalizedQueueMessage ? { queue } : {}),
      [SEND_IDEMPOTENCY_RESERVATIONS_FIELD]: reservations,
      updatedAt: now,
    };
    currentTabs[tabIndex] = updated;
    return {
      tabs: currentTabs,
      result: {
        ok: true,
        idempotent: false,
        reservation: committed,
        tab: updated,
        queue,
        queuedMessage: normalizedQueueMessage,
      },
    };
  }, nodeIdSafe());
  return changed.result || persistentSendFailure(
    "SEND_IDEMPOTENCY_COMMIT_FAILED",
    "发送幂等结果写入失败",
    500,
  );
}

/** Release only this request owner's still-safe, uncommitted reservation. */
export function releaseTabSend({ tabId, marker, ownerToken } = {}) {
  const id = String(tabId || "").trim();
  const parsed = parsePersistentSendMarker(marker);
  const ownerHash = persistentSendOwnerHash(ownerToken);
  if (!id || !parsed || !ownerHash) return { ok: false, released: false };
  const changed = updateDevbenchStoryState(storageUserKey("tabs"), ({ tabs }) => {
    const currentTabs = Array.isArray(tabs) ? [...tabs] : [];
    const tabIndex = currentTabs.findIndex((tab) => String(tab?.id || "") === id);
    if (tabIndex < 0) return { result: { ok: false, released: false } };
    const current = currentTabs[tabIndex];
    const reservations = persistentSendReservations(current);
    const reservationIndex = persistentSendReservationIndex(current, parsed);
    if (reservationIndex < 0) return { result: { ok: true, released: false, tab: current } };
    const reservation = reservations[reservationIndex];
    if (reservation.status !== "reserved" || reservation.ownerHash !== ownerHash) {
      return { result: { ok: true, released: false, tab: current } };
    }
    reservations.splice(reservationIndex, 1);
    const updated = {
      ...current,
      [SEND_IDEMPOTENCY_RESERVATIONS_FIELD]: reservations,
      updatedAt: Date.now(),
    };
    currentTabs[tabIndex] = updated;
    return { tabs: currentTabs, result: { ok: true, released: true, tab: updated } };
  }, nodeIdSafe());
  return changed.result || { ok: false, released: false };
}

/**
 * Complete the runtime identity fields of a device-queued message without a
 * read-copy-write queue overwrite. The matching reservation is updated in the
 * same transaction and never stores the original client key.
 */
export function materializeTabQueuedSend({ tabId, requestId, message, marker = "" } = {}) {
  const id = String(tabId || "").trim();
  const expectedRequestId = String(requestId || "").trim();
  let normalized;
  try { normalized = createQueuedMessage(message); } catch (error) {
    return persistentSendFailure(error?.code || "SEND_QUEUE_MESSAGE_INVALID", error?.message || "队列消息无效", error?.statusCode || 400);
  }
  if (!id || !expectedRequestId) {
    return persistentSendFailure("SEND_QUEUE_IDENTITY_INVALID", "设备排队消息身份无效", 400);
  }
  const parsed = marker ? parsePersistentSendMarker(marker) : null;
  const changed = updateDevbenchStoryState(storageUserKey("tabs"), ({ tabs }) => {
    const currentTabs = Array.isArray(tabs) ? [...tabs] : [];
    const tabIndex = currentTabs.findIndex((tab) => String(tab?.id || "") === id);
    if (tabIndex < 0) return { result: persistentSendFailure("SEND_QUEUE_TAB_NOT_FOUND", "故事点不存在", 404) };
    const current = currentTabs[tabIndex];
    const queue = Array.isArray(current.queue) ? [...current.queue] : [];
    const queueIndex = queue.findIndex((item) => String(item?.deviceRuntimeRequestId || "") === expectedRequestId);
    if (queueIndex < 0) {
      return { result: persistentSendFailure("SEND_QUEUE_MESSAGE_NOT_FOUND", "设备排队消息不存在", 409) };
    }
    queue[queueIndex] = normalized;
    const reservations = persistentSendReservations(current);
    if (parsed) {
      const reservationIndex = persistentSendReservationIndex(current, parsed);
      if (reservationIndex >= 0 && reservations[reservationIndex].status === "committed") {
        const materializedIdentities = persistentSendIdentity(normalized);
        reservations[reservationIndex] = {
          ...reservations[reservationIndex],
          identities: persistentSendIdentity({
            ...(reservations[reservationIndex].identities || {}),
            ...Object.fromEntries(Object.entries(materializedIdentities).filter(([, value]) => value)),
          }),
          updatedAt: Date.now(),
        };
      }
    }
    const updated = {
      ...current,
      queue,
      [SEND_IDEMPOTENCY_RESERVATIONS_FIELD]: reservations,
      updatedAt: Date.now(),
    };
    currentTabs[tabIndex] = updated;
    return { tabs: currentTabs, result: { ok: true, tab: updated, message: normalized, queue } };
  }, nodeIdSafe());
  return changed.result || persistentSendFailure("SEND_QUEUE_MATERIALIZE_FAILED", "设备排队消息身份写入失败", 500);
}

const TB_SYNC_OPERATION_SCHEMA_VERSION = "tb-sync-operation-v1";
const TB_SYNC_OPERATION_STEPS = Object.freeze(["comment", "attachment", "status"]);
const TB_SYNC_OUTBOX_STATES = new Set([
  "planned",
  "skipped",
  "write_started",
  "write_acknowledged",
  "ambiguous",
  "completed",
]);

function tbSyncOperationFailure(code, error, statusCode = 409, extra = {}) {
  return { ok: false, statusCode, code, error, ...extra };
}

function tbSyncOperationOwnerHash(ownerToken) {
  const token = String(ownerToken || "");
  return token ? createHash("sha256").update(token, "utf8").digest("hex") : "";
}

function tbSyncOperationId(tabId, payloadSha256) {
  return `tb-sync:${createHash("sha256")
    .update(`${String(tabId)}:${String(payloadSha256)}`, "utf8")
    .digest("hex")}`;
}

function tbSyncStepIdempotencyKey(operationId, step, key) {
  return `tb-sync-step:${createHash("sha256")
    .update(`${operationId}:${step}:${key}`, "utf8")
    .digest("hex")}`;
}

function normalizedTbSyncStepKeys(value = {}) {
  const keys = Object.fromEntries(TB_SYNC_OPERATION_STEPS.map((step) => [step, String(value?.[step] || "").trim()]));
  if (!keys.comment || !keys.status) return null;
  return keys;
}

function initialTbSyncOutbox(operationId, stepKeys) {
  return Object.fromEntries(TB_SYNC_OPERATION_STEPS.map((step) => {
    const key = stepKeys[step];
    const skipped = step === "attachment" && !key;
    return [step, {
      key,
      idempotencyKey: key ? tbSyncStepIdempotencyKey(operationId, step, key) : "",
      state: skipped ? "skipped" : "planned",
      writeAttempts: 0,
      updatedAt: Date.now(),
    }];
  }));
}

function tbSyncUncertainSteps(operation) {
  return TB_SYNC_OPERATION_STEPS.filter((step) => [
    "write_started",
    "write_acknowledged",
    "ambiguous",
  ].includes(String(operation?.outbox?.[step]?.state || "")));
}

function tbSyncDerivedActiveStatus(operation) {
  const uncertain = tbSyncUncertainSteps(operation);
  if (operation?.status === "reconciling" && uncertain.length > 0) return "reconciling";
  return uncertain.length > 0 ? "ambiguous" : "owned";
}

function tbSyncReadyToSettle(operation) {
  return TB_SYNC_OPERATION_STEPS.every((step) => {
    const state = String(operation?.outbox?.[step]?.state || "");
    return state === "completed" || (step === "attachment" && state === "skipped");
  });
}

function tbSyncPlannedOnly(operation) {
  return TB_SYNC_OPERATION_STEPS.every((step) => {
    const state = String(operation?.outbox?.[step]?.state || "");
    return state === "planned" || (step === "attachment" && state === "skipped");
  });
}

function validateTbSyncOperationInput({ tabId, tbTaskId, pending, stepKeys, ownerToken }) {
  const id = String(tabId || "").trim();
  const taskId = String(tbTaskId || "").trim();
  const payloadSha256 = String(pending?.payloadSha256 || "").trim().toLowerCase();
  const ownerHash = tbSyncOperationOwnerHash(ownerToken);
  const keys = normalizedTbSyncStepKeys(stepKeys);
  if (!id || !taskId || !/^[a-f0-9]{64}$/.test(payloadSha256) || !ownerHash || !keys
    || String(pending?.storyId || "") !== id || String(pending?.tbTaskId || "") !== taskId) {
    return null;
  }
  return { id, taskId, payloadSha256, ownerHash, stepKeys: keys };
}

/**
 * Atomically freezes the immutable TB payload and elects one process owner.
 * Ownership is never transferred by timeout. A new Gateway may fence an
 * all-planned operation before any side effect, reconcile an already-attempted
 * write read-only, or finish an all-confirmed settlement.
 */
export function reserveTabTbSyncOperation({
  tabId,
  tbTaskId,
  pending,
  stepKeys,
  ownerToken,
} = {}) {
  const input = validateTbSyncOperationInput({ tabId, tbTaskId, pending, stepKeys, ownerToken });
  if (!input) {
    return tbSyncOperationFailure("TB_SYNC_OPERATION_INVALID", "TB 同步 operation reservation 参数无效", 400);
  }
  const changed = updateDevbenchStoryState(storageUserKey("tabs"), ({ tabs }) => {
    const currentTabs = Array.isArray(tabs) ? [...tabs] : [];
    const tabIndex = currentTabs.findIndex((tab) => String(tab?.id || "") === input.id);
    if (tabIndex < 0) {
      return { result: tbSyncOperationFailure("TB_SYNC_OPERATION_TAB_NOT_FOUND", "故事点不存在", 404) };
    }
    const current = currentTabs[tabIndex];
    const workflow = current.workflow && typeof current.workflow === "object" ? current.workflow : {};
    const storedPending = workflow.tbSyncPending;
    if (storedPending && String(storedPending.payloadSha256 || "") !== input.payloadSha256) {
      return {
        result: tbSyncOperationFailure(
          "TB_SYNC_OPERATION_PAYLOAD_CONFLICT",
          "当前故事点已有不同 payload 的 TB 同步 operation",
          409,
          { conflict: true },
        ),
      };
    }
    const existing = workflow.tbSyncOperation && typeof workflow.tbSyncOperation === "object"
      ? workflow.tbSyncOperation
      : null;
    if (existing && String(existing.payloadSha256 || "") === input.payloadSha256) {
      if (existing.status === "completed") {
        return { result: { ok: true, acquired: false, replay: true, operation: existing, tab: current } };
      }
      if (existing.ownerHash !== input.ownerHash) {
        const uncertainSteps = tbSyncUncertainSteps(existing);
        const readyToSettle = tbSyncReadyToSettle(existing);
        const plannedOnly = tbSyncPlannedOnly(existing);
        // A new process may fence a crashed writer only into read-only
        // reconciliation, and only when a remote write is already uncertain.
        // Reconciliation may itself survive another process crash by fencing
        // to a newer read-only owner. A merely planned operation is never
        // timeout-taken over.
        if (plannedOnly || readyToSettle || uncertainSteps.length > 0) {
          const fencingToken = Math.max(
            0,
            Number(workflow.tbSyncFencingCounter || 0),
            Number(existing.fencingToken || 0),
          ) + 1;
          const now = Date.now();
          const operation = {
            ...existing,
            previousOwnerHash: existing.ownerHash,
            ownerHash: input.ownerHash,
            fencingToken,
            status: uncertainSteps.length > 0 ? "reconciling" : "owned",
            reconciliation: {
              mode: plannedOnly
                ? "planned_takeover"
                : (readyToSettle ? "settlement_only" : "read_only"),
              uncertainSteps,
              startedAt: now,
            },
            updatedAt: now,
          };
          const updated = {
            ...current,
            workflow: {
              ...workflow,
              enabled: true,
              phase: "sync_pending",
              tbSyncOperation: operation,
              tbSyncFencingCounter: fencingToken,
              reportError: plannedOnly
                ? "TB operation ownership changed before any remote write"
                : (readyToSettle
                  ? "TB remote steps are confirmed; terminal settlement is being resumed"
                  : "TB remote write outcome is being reconciled read-only"),
            },
            updatedAt: now,
          };
          currentTabs[tabIndex] = updated;
          return {
            tabs: currentTabs,
            result: {
              ok: true,
              acquired: true,
              resumed: true,
              reconcileOnly: uncertainSteps.length > 0,
              settlementOnly: readyToSettle,
              plannedTakeover: plannedOnly,
              operation,
              tab: updated,
            },
          };
        }
        return {
          result: tbSyncOperationFailure(
            "TB_SYNC_OPERATION_PENDING",
            "TB 同步 operation 已由另一 Gateway 持有；禁止超时抢占或重复远端写入",
            409,
            { pending: true, operation: existing, tab: current },
          ),
        };
      }
      return { result: { ok: true, acquired: true, resumed: true, operation: existing, tab: current } };
    }
    if (existing && existing.status !== "completed") {
      return {
        result: tbSyncOperationFailure(
          "TB_SYNC_OPERATION_PAYLOAD_CONFLICT",
          "当前故事点已有未完成且 payload 不同的 TB 同步 operation",
          409,
          { conflict: true, operation: existing },
        ),
      };
    }
    const fencingToken = Math.max(
      0,
      Number(workflow.tbSyncFencingCounter || 0),
      Number(existing?.fencingToken || 0),
    ) + 1;
    const operationId = tbSyncOperationId(input.id, input.payloadSha256);
    const now = Date.now();
    const operation = {
      schemaVersion: TB_SYNC_OPERATION_SCHEMA_VERSION,
      operationId,
      payloadSha256: input.payloadSha256,
      ownerHash: input.ownerHash,
      fencingToken,
      status: "owned",
      outbox: initialTbSyncOutbox(operationId, input.stepKeys),
      ledger: {
        schemaVersion: "tb-sync-saga-v1",
        reportRevision: String(pending.reportRevision || ""),
        comment: null,
        attachment: null,
        status: null,
      },
      createdAt: now,
      updatedAt: now,
    };
    const updated = {
      ...current,
      workflow: {
        ...workflow,
        enabled: true,
        phase: "sync_pending",
        tbSyncPending: cloneJson(pending),
        tbSyncOperation: operation,
        tbSyncFencingCounter: fencingToken,
        reportError: null,
      },
      updatedAt: now,
    };
    currentTabs[tabIndex] = updated;
    return {
      tabs: currentTabs,
      result: { ok: true, acquired: true, resumed: false, operation, tab: updated },
    };
  }, nodeIdSafe());
  return changed.result || tbSyncOperationFailure(
    "TB_SYNC_OPERATION_RESERVATION_FAILED",
    "TB 同步 operation reservation 写入失败",
    500,
  );
}

function mutateTabTbSyncOperation({
  tabId,
  operationId,
  payloadSha256,
  ownerToken,
  fencingToken,
}, mutator) {
  const id = String(tabId || "").trim();
  const opId = String(operationId || "").trim();
  const payloadHash = String(payloadSha256 || "").trim();
  const ownerHash = tbSyncOperationOwnerHash(ownerToken);
  const fence = Number(fencingToken);
  if (!id || !opId || !payloadHash || !ownerHash || !Number.isSafeInteger(fence) || fence <= 0) {
    return tbSyncOperationFailure("TB_SYNC_OPERATION_CAS_INVALID", "TB 同步 operation CAS 参数无效", 400);
  }
  const changed = updateDevbenchStoryState(storageUserKey("tabs"), ({ tabs }) => {
    const currentTabs = Array.isArray(tabs) ? [...tabs] : [];
    const tabIndex = currentTabs.findIndex((tab) => String(tab?.id || "") === id);
    if (tabIndex < 0) return { result: tbSyncOperationFailure("TB_SYNC_OPERATION_TAB_NOT_FOUND", "故事点不存在", 404) };
    const current = currentTabs[tabIndex];
    const workflow = current.workflow && typeof current.workflow === "object" ? current.workflow : {};
    const operation = workflow.tbSyncOperation;
    if (!operation
      || operation.operationId !== opId
      || operation.payloadSha256 !== payloadHash
      || operation.ownerHash !== ownerHash
      || Number(operation.fencingToken) !== fence) {
      return {
        result: tbSyncOperationFailure(
          "TB_SYNC_OPERATION_CAS_MISMATCH",
          "TB 同步 operation owner/fencing CAS 不匹配",
          409,
        ),
      };
    }
    if (operation.status === "completed") {
      return { result: { ok: true, idempotent: true, operation, tab: current } };
    }
    const outcome = mutator(cloneJson(operation), workflow);
    if (!outcome?.ok) return { result: outcome || tbSyncOperationFailure("TB_SYNC_OPERATION_MUTATION_FAILED", "TB 同步 operation 更新失败") };
    const now = Date.now();
    const nextOperation = { ...outcome.operation, updatedAt: now };
    const outcomeWorkflow = outcome.workflow && typeof outcome.workflow === "object"
      ? outcome.workflow
      : workflow;
    const updated = {
      ...current,
      workflow: { ...outcomeWorkflow, tbSyncOperation: nextOperation },
      updatedAt: now,
    };
    currentTabs[tabIndex] = updated;
    return { tabs: currentTabs, result: { ...outcome, operation: nextOperation, tab: updated } };
  }, nodeIdSafe());
  return changed.result || tbSyncOperationFailure("TB_SYNC_OPERATION_CAS_FAILED", "TB 同步 operation CAS 写入失败", 500);
}

/** Persist write_started before invoking a remote TB write. */
export function beginTabTbSyncStepWrite(args = {}) {
  const step = String(args.step || "");
  const key = String(args.key || "");
  if (!TB_SYNC_OPERATION_STEPS.includes(step) || !key) {
    return tbSyncOperationFailure("TB_SYNC_OUTBOX_STEP_INVALID", "TB 同步 outbox step/key 无效", 400);
  }
  return mutateTabTbSyncOperation(args, (operation) => {
    const current = operation.outbox?.[step];
    if (!current || current.key !== key) {
      return tbSyncOperationFailure("TB_SYNC_OUTBOX_KEY_MISMATCH", "TB 同步 outbox step key 不匹配", 409);
    }
    if (current.state === "completed") {
      return { ok: true, idempotent: true, replay: true, operation };
    }
    if (operation.status === "reconciling") {
      return tbSyncOperationFailure(
        "TB_SYNC_OUTBOX_RECONCILE_ONLY",
        "TB 同步 operation 正在只读核对不确定写；核对完成前禁止任何远端写",
        409,
        { reconcileOnly: true, uncertainSteps: tbSyncUncertainSteps(operation) },
      );
    }
    if (current.state !== "planned") {
      return tbSyncOperationFailure(
        "TB_SYNC_OUTBOX_WRITE_ALREADY_ATTEMPTED",
        "TB 同步远端写已尝试且结果未安全结算；只允许只读核对，禁止重复写",
        409,
        { ambiguous: true, stepState: current.state },
      );
    }
    const now = Date.now();
    operation.outbox[step] = {
      ...current,
      state: "write_started",
      writeAttempts: 1,
      writeStartedAt: now,
      updatedAt: now,
    };
    return { ok: true, allowed: true, operation };
  });
}

/** Persist a durable outbox checkpoint or remote-read confirmation. */
export function recordTabTbSyncStep(args = {}) {
  const step = String(args.step || "");
  const key = String(args.key || "");
  const state = String(args.state || "");
  if (!TB_SYNC_OPERATION_STEPS.includes(step) || !key
    || !["write_acknowledged", "ambiguous", "completed"].includes(state)) {
    return tbSyncOperationFailure("TB_SYNC_OUTBOX_TRANSITION_INVALID", "TB 同步 outbox transition 无效", 400);
  }
  return mutateTabTbSyncOperation(args, (operation) => {
    const current = operation.outbox?.[step];
    if (!current || current.key !== key || !TB_SYNC_OUTBOX_STATES.has(current.state)) {
      return tbSyncOperationFailure("TB_SYNC_OUTBOX_KEY_MISMATCH", "TB 同步 outbox step key 不匹配", 409);
    }
    if (current.state === "completed") {
      return { ok: true, idempotent: true, operation };
    }
    if (state === "write_acknowledged" && current.state !== "write_started") {
      return tbSyncOperationFailure("TB_SYNC_OUTBOX_ACK_INVALID", "TB 同步写确认缺少 write_started", 409);
    }
    const now = Date.now();
    operation.outbox[step] = {
      ...current,
      state,
      ...(state === "write_acknowledged" ? { writeAcknowledgedAt: now } : {}),
      ...(state === "ambiguous" ? {
        ambiguousAt: now,
        reason: String(args.reason || "远端写结果不确定").slice(0, 1000),
      } : {}),
      ...(state === "completed" ? {
        completedAt: now,
        reason: null,
      } : {}),
      updatedAt: now,
    };
    if (state === "completed") {
      operation.ledger = operation.ledger && typeof operation.ledger === "object"
        ? operation.ledger
        : { schemaVersion: "tb-sync-saga-v1", reportRevision: "" };
      operation.ledger[step] = { key, at: now };
    }
    operation.status = tbSyncDerivedActiveStatus(operation);
    if (operation.status !== "reconciling") operation.reconciliation = null;
    return { ok: true, operation };
  });
}

/** Atomically settle Saga ledger, terminal phase and operation completion. */
export function settleTabTbSyncOperation(args = {}) {
  const completed = args.completed === true;
  return mutateTabTbSyncOperation(args, (operation, workflow) => {
    const requiredComplete = TB_SYNC_OPERATION_STEPS.every((step) => {
      const state = operation.outbox?.[step]?.state;
      return state === "completed" || (step === "attachment" && state === "skipped");
    });
    if (completed && !requiredComplete) {
      return tbSyncOperationFailure(
        "TB_SYNC_OPERATION_STEPS_INCOMPLETE",
        "TB 同步 Saga 声称完成，但 durable outbox 尚未全部确认",
        409,
      );
    }
    const now = Date.now();
    const activeStatus = tbSyncDerivedActiveStatus(operation);
    const nextOperation = {
      ...operation,
      status: completed ? "completed" : activeStatus,
      reconciliation: completed || activeStatus !== "reconciling" ? null : operation.reconciliation,
      ...(completed ? { completedAt: now } : {}),
      lastError: completed ? null : String(args.error || "TB 同步未完成").slice(0, 2000),
    };
    const nextWorkflow = {
      ...workflow,
      ...(completed && args.terminalUpdates && typeof args.terminalUpdates === "object"
        ? cloneJson(args.terminalUpdates)
        : {}),
      enabled: true,
      phase: completed ? String(args.terminalPhase || "") : "sync_pending",
      tbSyncLedger: cloneJson(nextOperation.ledger),
      tbSyncOperation: nextOperation,
      reportError: completed ? null : nextOperation.lastError,
    };
    if (completed) delete nextWorkflow.tbSyncPending;
    else if (args.pending) nextWorkflow.tbSyncPending = cloneJson(args.pending);
    return { ok: true, completed, operation: nextOperation, workflow: nextWorkflow };
  });
}

function updateTabWithReservedDeviceQueue(id, updates) {
  if (!Object.prototype.hasOwnProperty.call(updates || {}, "queue") || !Array.isArray(updates.queue)) return null;
  const incomingQueue = updates.queue;
  const candidateRequestIds = new Set(incomingQueue
    .map((message) => String(message?.deviceRuntimeRequestId || "").trim())
    .filter(Boolean));
  if (!candidateRequestIds.size) return null;
  const changed = updateDevbenchStoryState(storageUserKey("tabs"), ({ tabs }) => {
    const currentTabs = Array.isArray(tabs) ? [...tabs] : [];
    const tabIndex = currentTabs.findIndex((tab) => String(tab?.id || "") === String(id || ""));
    if (tabIndex < 0) return { result: { handled: false, tab: null } };
    const current = currentTabs[tabIndex];
    const reservations = persistentSendReservations(current);
    const reservationIndex = reservations.findIndex((reservation) => (
      reservation?.status === "reserved"
      && candidateRequestIds.has(String(reservation?.identities?.requestId || ""))
    ));
    if (reservationIndex < 0) return { result: { handled: false, tab: current } };
    const reservation = reservations[reservationIndex];
    const requestId = String(reservation.identities?.requestId || "");
    const candidate = incomingQueue.find((message) => String(message?.deviceRuntimeRequestId || "") === requestId);
    if (!candidate) return { result: { handled: false, tab: current } };
    const queue = Array.isArray(current.queue) ? [...current.queue] : [];
    if (!queue.some((message) => String(message?.deviceRuntimeRequestId || "") === requestId)) {
      queue.push(createQueuedMessage(candidate));
    }
    const now = Date.now();
    reservations[reservationIndex] = {
      ...reservation,
      status: "committed",
      resultKind: "device_queued",
      committedAt: now,
      updatedAt: now,
    };
    const updated = {
      ...current,
      ...updates,
      queue,
      [SEND_IDEMPOTENCY_RESERVATIONS_FIELD]: reservations,
      updatedAt: now,
    };
    currentTabs[tabIndex] = updated;
    return { tabs: currentTabs, result: { handled: true, tab: updated } };
  }, nodeIdSafe());
  return changed.result?.handled ? changed.result.tab : null;
}

export function updateTab(id, updates) {
  const reservedDeviceQueueUpdate = updateTabWithReservedDeviceQueue(id, updates);
  if (reservedDeviceQueueUpdate) return reservedDeviceQueueUpdate;
  const tabs = loadTabs();
  const idx = tabs.findIndex((t) => t.id === id);
  if (idx < 0) return null;
  tabs[idx] = { ...tabs[idx], ...updates, updatedAt: Date.now() };
  saveTabs(tabs);
  return tabs[idx];
}

/**
 * 原子替换或移除活动故事点的持久消息队首。
 *
 * 多个 Gateway 可能同时尝试恢复同一条持久消息；调用方必须提供它实际读取到的
 * expectedHead。只有数据库中的队首仍与该快照完全一致时才写入 nextHead；
 * nextHead 为 null 时原子移除该队首，避免
 * 两个进程为同一消息生成不同的设备 requestId 并留下幽灵租约。
 */
export function replaceTabQueueHeadIfUnchanged(id, expectedHead, nextHead) {
  const tabId = String(id || "").trim();
  if (!tabId || nextHead === undefined) {
    return { ok: false, statusCode: 400, code: "STORY_QUEUE_HEAD_INVALID", error: "消息队首更新参数不完整" };
  }
  const expectedJson = JSON.stringify(expectedHead);
  const changed = updateDevbenchStoryState(storageUserKey("tabs"), ({ tabs }) => {
    const currentTabs = Array.isArray(tabs) ? [...tabs] : [];
    const index = currentTabs.findIndex((tab) => (
      String(tab?.id || "") === tabId && !isTabPermanentlyDeleted(tab?.id)
    ));
    if (index < 0) {
      return { result: { ok: false, statusCode: 404, code: "STORY_QUEUE_TAB_NOT_FOUND", error: "故事点不存在" } };
    }
    const current = currentTabs[index];
    const queue = Array.isArray(current?.queue) ? current.queue : [];
    if (!queue.length || JSON.stringify(queue[0]) !== expectedJson) {
      return {
        result: {
          ok: false,
          statusCode: 409,
          code: "STORY_QUEUE_HEAD_CHANGED",
          error: "消息队首已被其他 Gateway 更新",
        },
      };
    }
    const nextQueue = nextHead === null ? queue.slice(1) : [nextHead, ...queue.slice(1)];
    const updated = { ...current, queue: nextQueue, updatedAt: Date.now() };
    currentTabs[index] = updated;
    return { tabs: currentTabs, result: { ok: true, tab: updated, queue: nextQueue } };
  }, nodeIdSafe());
  return changed.result || {
    ok: false,
    statusCode: 500,
    code: "STORY_QUEUE_HEAD_UPDATE_FAILED",
    error: "消息队首更新失败",
  };
}

/**
 * 原子更新故事点的目标设备绑定。绑定只是目标偏好，不代表运行时独占；多个故事点
 * 可以绑定同一 serial。真正执行脚本、安装或测试时由 device-runtime 协调器申请
 * FIFO 租约。本函数保留事务写入，避免其它 Tab 字段在并发绑定时丢失。
 */
export function updateTabDeviceBinding(id, updates = {}) {
  const tabId = String(id || "").trim();
  const patch = updates && typeof updates === "object" && !Array.isArray(updates)
    ? { ...updates }
    : {};
  const claimsDevice = Object.prototype.hasOwnProperty.call(patch, "deviceSerial");
  const requestedSerial = claimsDevice ? String(patch.deviceSerial || "").trim() : "";
  const changed = updateDevbenchStoryState(storageUserKey("tabs"), ({ tabs }) => {
    const currentTabs = Array.isArray(tabs) ? [...tabs] : [];
    const idx = currentTabs.findIndex((tab) => (
      String(tab?.id || "") === tabId && !isTabPermanentlyDeleted(tab?.id)
    ));
    if (idx < 0) {
      return {
        result: {
          ok: false,
          statusCode: 404,
          code: "STORY_DEVICE_TARGET_NOT_FOUND",
          error: "目标故事点不存在，无法更新设备绑定",
        },
      };
    }

    const target = currentTabs[idx];
    const normalizedPatch = claimsDevice
      ? { ...patch, deviceSerial: requestedSerial || null }
      : patch;
    const nextTab = { ...target, ...normalizedPatch, updatedAt: Date.now() };
    currentTabs[idx] = nextTab;
    return { tabs: currentTabs, result: { ok: true, tab: nextTab } };
  }, nodeIdSafe());
  return changed.result || {
    ok: false,
    statusCode: 500,
    code: "STORY_DEVICE_BINDING_STATE_UPDATE_FAILED",
    error: "设备绑定状态原子更新失败",
  };
}

// 后向兼容旧插件/旧路由：语义已从排他 claim 改为共享 binding。
export function updateTabWithDeviceClaim(id, updates = {}, _legacyOptions = {}) {
  return updateTabDeviceBinding(id, updates);
}

export function clearRunningTaskIfMatches(id, expectedTaskId) {
  const expected = String(expectedTaskId || "").trim();
  if (!expected) return getTab(id);
  const tabs = loadTabs();
  const idx = tabs.findIndex((t) => t.id === id);
  if (idx < 0) return null;
  if (String(tabs[idx].runningTaskId || "").trim() !== expected) return tabs[idx];
  tabs[idx] = { ...tabs[idx], runningTaskId: null, updatedAt: Date.now() };
  saveTabs(tabs);
  return tabs[idx];
}

// 仅供“新建流程尚未对外成功”时补偿回滚。与 deleteTab 不同，这里不进入
// 已关闭列表，避免把一次 worktree 创建失败伪装成用户可恢复的正式故事点。
export function discardUnpublishedTab(id) {
  const tabId = String(id || "").trim();
  if (!tabId) return { ok: false, removed: 0 };
  const tabs = loadTabs();
  const next = tabs.filter((tab) => tab.id !== tabId);
  if (next.length === tabs.length) return { ok: true, removed: 0 };
  saveTabs(next);
  return { ok: true, removed: tabs.length - next.length };
}

/**
 * 清空所有故事点的 runningTaskId（网关启动时调用）。
 * 任务进程不可能跨网关重启存活，启动时若有残留运行态，会一直用 409 挡住发送，必须清掉。
 */
export function clearAllRunningTasks() {
  const tabs = loadTabs();
  let n = 0;
  for (const t of tabs) {
    if (t.runningTaskId) { t.runningTaskId = null; n++; }
  }
  if (n) saveTabs(tabs);
  return n;
}

function deletionPathKey(value) {
  const raw = String(value || "").trim();
  if (!raw || !path.isAbsolute(raw)) return "";
  return normPath(path.resolve(raw));
}

function sameDeletionPath(left, right) {
  const a = deletionPathKey(left);
  return !!a && a === deletionPathKey(right);
}

function pathInsideDeletionRoot(root, target) {
  const base = deletionPathKey(root);
  const child = deletionPathKey(target);
  return !!base && !!child && (child === base || child.startsWith(`${base}/`));
}

function validateDeletionDocSlug(value) {
  const raw = String(value == null ? "" : value).trim();
  if (!raw) return { ok: false, value: raw, reason: "故事点存档标识为空，禁止递归删除" };
  if (raw === "." || raw === ".." || /[\\/]/.test(raw)
    || path.win32.basename(raw) !== raw || path.posix.basename(raw) !== raw
    || fsSafeSlug(raw, 40) !== raw) {
    return { ok: false, value: raw, reason: "故事点存档标识不是规范的单级安全目录名，禁止递归删除" };
  }
  return { ok: true, value: raw, reason: "" };
}

function validateDeletionTabId(value) {
  const raw = String(value || "").trim();
  // msg/live 文件名会直接包含 tabId；同时按 Windows 与 POSIX 的最严格交集校验，
  // 避免 ':'、'*' 等字符令实际聊天文件与待删除派生路径不一致，产生“成功但残留”。
  if (!raw || raw.length > 160 || raw === "." || raw === ".." || /[\\/<>:"|?*\x00-\x1f\x7f]/.test(raw)
    || path.win32.basename(raw) !== raw || path.posix.basename(raw) !== raw) {
    return { ok: false, value: raw, reason: "故事点 ID 不是安全的单级文件标识" };
  }
  return { ok: true, value: raw, reason: "" };
}

function canonicalStoryStoragePaths(rootPath, docSlug, { legacyProject = false } = {}) {
  if (!rootPath || !path.isAbsolute(String(rootPath))) {
    return {
      ok: false,
      reason: legacyProject ? "没有可验证的主工程物理路径" : "没有可验证的 StoryDev 存储根目录",
      projectPath: "",
      storyDevRoot: "",
      docSlug: String(docSlug || ""),
    };
  }
  const storageRoot = path.resolve(String(rootPath));
  const slug = validateDeletionDocSlug(docSlug);
  if (!slug.ok) {
    return {
      ...slug,
      projectPath: legacyProject ? storageRoot : "",
      storyDevRoot: legacyProject ? "" : storageRoot,
      docSlug: slug.value,
    };
  }
  if (!legacyProject) {
    const storyDirectory = path.resolve(storageRoot, slug.value);
    if (!sameDeletionPath(path.dirname(storyDirectory), storageRoot)) {
      return {
        ok: false,
        reason: "故事点资料路径发生目录折叠，禁止递归删除",
        projectPath: "",
        storyDevRoot: storageRoot,
        docSlug: slug.value,
      };
    }
    return {
      ok: true,
      reason: "",
      storageMode: "storydev",
      projectPath: "",
      storyDevRoot: storageRoot,
      deletionRoot: storageRoot,
      allowedRoots: [storyDirectory],
      storyDirectory,
      docSlug: slug.value,
      defaultArchiveDirectory: path.join(storyDirectory, "ask"),
      attachmentDirectories: [
        path.join(storyDirectory, "archives"),
        path.join(storyDirectory, "reports"),
        path.join(storyDirectory, "tempFiles"),
      ],
    };
  }
  const docsRoot = path.resolve(storageRoot, "docs");
  const storyRoot = path.resolve(docsRoot, "story");
  const storyDirectory = path.resolve(storyRoot, slug.value);
  const legacyDirectory = path.resolve(docsRoot, slug.value);
  if (!sameDeletionPath(path.dirname(storyDirectory), storyRoot)
    || !sameDeletionPath(path.dirname(legacyDirectory), docsRoot)) {
    return { ok: false, reason: "故事点资料路径发生目录折叠，禁止递归删除", projectPath: storageRoot, storyDevRoot: "", docSlug: slug.value };
  }
  return {
    ok: true,
    reason: "",
    storageMode: "legacy-project",
    projectPath: storageRoot,
    storyDevRoot: "",
    deletionRoot: storageRoot,
    allowedRoots: [storyDirectory, legacyDirectory],
    storyDirectory,
    docSlug: slug.value,
    defaultArchiveDirectory: path.join(storyDirectory, "ask"),
    attachmentDirectories: [
      path.join(storyDirectory, "archives"),
      path.join(legacyDirectory, "archives"),
    ],
  };
}

function readStorageIdentity(target) {
  try {
    const stat = fs.statSync(target, { bigint: true });
    return {
      dev: String(stat.dev),
      ino: String(stat.ino),
      birthtimeNs: String(stat.birthtimeNs || ""),
    };
  } catch { return null; }
}

function sameStorageIdentity(left, right) {
  if (!left || !right) return false;
  return String(left.dev || "") === String(right.dev || "")
    && String(left.ino || "") === String(right.ino || "")
    && String(left.birthtimeNs || "") === String(right.birthtimeNs || "");
}

function closedArchiveInfo(tab) {
  const isClosedSnapshot = !!tab && Object.hasOwn(tab, "closedAt");
  const frozen = tab?.closedStorageSnapshot && typeof tab.closedStorageSnapshot === "object"
    ? tab.closedStorageSnapshot
    : null;
  const useLegacyProjectSnapshot = isClosedSnapshot && Number(frozen?.version || 0) < 3;
  const frozenProjectPath = frozen?.projectPath && path.isAbsolute(String(frozen.projectPath))
    ? path.resolve(String(frozen.projectPath))
    : "";
  const frozenProjectRealPath = frozen?.projectRealPath && path.isAbsolute(String(frozen.projectRealPath))
    ? path.resolve(String(frozen.projectRealPath))
    : "";
  const frozenProjectIdentity = frozen?.projectIdentity && typeof frozen.projectIdentity === "object"
    ? frozen.projectIdentity
    : null;
  const currentProject = getPrimaryProject(tab);
  const project = frozenProjectPath
    ? { ...(currentProject || {}), id: frozen.projectId || tab?.primaryProjectId || null, path: frozenProjectPath }
    : currentProject;
  const docSlug = String(frozen?.docSlug || tab?.docSlug || computeDocSlug(tab) || "story");
  const frozenStoryDevRoot = validFrozenStoryDevRoot(frozen?.storyDevRoot);
  const tabStoryDevRoot = validFrozenStoryDevRoot(tab?.storyStorageRoot);
  let activeStoryDevRoot = "";
  if (!useLegacyProjectSnapshot) {
    try { activeStoryDevRoot = frozenStoryDevRoot || tabStoryDevRoot || configuredStoryDevRoot(); } catch {}
  }
  const frozenStoryDevRealPath = frozen?.storyDevRealPath && path.isAbsolute(String(frozen.storyDevRealPath))
    ? path.resolve(String(frozen.storyDevRealPath))
    : "";
  const frozenStoryDevIdentity = frozen?.storyDevIdentity && typeof frozen.storyDevIdentity === "object"
    ? frozen.storyDevIdentity
    : null;
  const canonical = useLegacyProjectSnapshot
    ? canonicalStoryStoragePaths(project?.path || "", docSlug, { legacyProject: true })
    : canonicalStoryStoragePaths(activeStoryDevRoot, docSlug);
  const frozenDefaultDir = frozen?.defaultArchiveDirectory && path.isAbsolute(String(frozen.defaultArchiveDirectory))
    ? path.resolve(String(frozen.defaultArchiveDirectory))
    : "";
  const defaultDir = canonical.ok ? canonical.defaultArchiveDirectory : frozenDefaultDir;
  const customDir = tab?.archiveDir && path.isAbsolute(String(tab.archiveDir))
    ? path.resolve(String(tab.archiveDir))
    : "";
  const frozenArchiveFile = frozen?.archiveFile && path.isAbsolute(String(frozen.archiveFile))
    ? path.resolve(String(frozen.archiveFile))
    : "";
  const storedFile = frozenArchiveFile || (tab?.archiveFile && path.isAbsolute(String(tab.archiveFile))
    ? path.resolve(String(tab.archiveFile))
    : "");
  const storedFileExists = !!(storedFile && fs.existsSync(storedFile));
  const frozenArchiveDir = frozen?.archiveDirectory && path.isAbsolute(String(frozen.archiveDirectory))
    ? path.resolve(String(frozen.archiveDirectory))
    : "";
  const effectiveDir = frozenArchiveDir || customDir || (storedFileExists ? path.dirname(storedFile) : defaultDir);
  const archiveFile = storedFileExists
    ? storedFile
    : (effectiveDir && canonical.ok ? path.join(effectiveDir, `${docSlug}.txt`) : "");
  const frozenAttachmentDirectories = Array.isArray(frozen?.attachmentDirectories)
    ? frozen.attachmentDirectories
      .filter((value) => value && path.isAbsolute(String(value)))
      .map((value) => path.resolve(String(value)))
    : [];
  let storagePathUnsafeReason = "";
  const frozenStorageRoot = useLegacyProjectSnapshot ? frozenProjectPath : frozenStoryDevRoot;
  const frozenStorageRealPath = useLegacyProjectSnapshot ? frozenProjectRealPath : frozenStoryDevRealPath;
  const frozenStorageIdentity = useLegacyProjectSnapshot ? frozenProjectIdentity : frozenStoryDevIdentity;
  const storageLabel = useLegacyProjectSnapshot ? "工程" : "StoryDev 存储根目录";
  if (isClosedSnapshot && !frozenStorageRoot) {
    storagePathUnsafeReason = useLegacyProjectSnapshot
      ? "该故事点由旧版本关闭，未冻结当时的工程物理路径，禁止按当前工程配置递归删除"
      : "该故事点关闭时未冻结 StoryDev 存储根目录，禁止按当前配置递归删除";
  } else if (isClosedSnapshot && !frozenStorageRealPath) {
    storagePathUnsafeReason = `该故事点关闭时未冻结 ${storageLabel}的真实路径，禁止递归删除`;
  } else if (isClosedSnapshot && !frozenStorageIdentity) {
    storagePathUnsafeReason = `该故事点关闭时未冻结 ${storageLabel}的文件系统身份，禁止递归删除`;
  } else if (isClosedSnapshot && frozenStorageRoot) {
    try {
      const storageStat = fs.lstatSync(frozenStorageRoot);
      const currentRealPath = path.resolve(fs.realpathSync(frozenStorageRoot));
      const currentIdentity = readStorageIdentity(frozenStorageRoot);
      if (storageStat.isSymbolicLink()) storagePathUnsafeReason = `关闭后的 ${storageLabel}已变成符号链接或 junction，禁止递归删除`;
      else if (!sameDeletionPath(currentRealPath, frozenStorageRealPath)) storagePathUnsafeReason = `关闭后的 ${storageLabel}真实路径已变化，禁止删除新占据该路径的资料`;
      else if (!sameStorageIdentity(currentIdentity, frozenStorageIdentity)) storagePathUnsafeReason = `关闭后的 ${storageLabel}文件系统身份已变化，禁止删除新占据该路径的资料`;
    } catch (error) {
      storagePathUnsafeReason = `无法验证关闭时 ${storageLabel}身份：${error.message}`;
    }
  }
  if (!storagePathUnsafeReason && !canonical.ok) {
    storagePathUnsafeReason = canonical.reason;
  } else if (!storagePathUnsafeReason && isClosedSnapshot && frozenDefaultDir && !sameDeletionPath(frozenDefaultDir, canonical.defaultArchiveDirectory)) {
    storagePathUnsafeReason = "关闭快照中的 TXT 目录与规范故事点路径不一致，禁止递归删除";
  } else if (!storagePathUnsafeReason && isClosedSnapshot && (
    frozenAttachmentDirectories.length !== canonical.attachmentDirectories.length
    || canonical.attachmentDirectories.some((expected) => !frozenAttachmentDirectories.some((actual) => sameDeletionPath(actual, expected)))
  )) {
    storagePathUnsafeReason = "关闭快照中的附件目录与规范故事点路径不一致，禁止递归删除";
  }
  return {
    project,
    docSlug,
    defaultDir,
    customDir,
    storedFile,
    effectiveDir,
    archiveFile,
    attachmentDirectories: canonical.ok ? canonical.attachmentDirectories : frozenAttachmentDirectories,
    deletionRoot: canonical.ok ? canonical.deletionRoot : frozenStorageRoot,
    allowedRoots: canonical.ok ? canonical.allowedRoots : [],
    storyDirectory: canonical.ok ? canonical.storyDirectory : "",
    storageMode: canonical.ok ? canonical.storageMode : (useLegacyProjectSnapshot ? "legacy-project" : "storydev"),
    storagePathStable: !storagePathUnsafeReason && (!!frozenStorageRoot || !isClosedSnapshot),
    storagePathUnsafeReason,
  };
}

function captureClosedStorageSnapshot(tab) {
  const project = getPrimaryProject(tab);
  const projectPath = project?.path && path.isAbsolute(String(project.path))
    ? path.resolve(String(project.path))
    : "";
  let projectRealPath = "";
  try { if (projectPath) projectRealPath = path.resolve(fs.realpathSync(projectPath)); } catch {}
  const docSlug = String(tab?.docSlug || computeDocSlug(tab) || "story");
  let storyDevRoot = "";
  try { storyDevRoot = getStoryStoragePaths(tab, { create: true }).storyDevRoot; } catch {}
  let storyDevRealPath = "";
  try { if (storyDevRoot) storyDevRealPath = path.resolve(fs.realpathSync(storyDevRoot)); } catch {}
  const storyDevIdentity = storyDevRoot ? readStorageIdentity(storyDevRoot) : null;
  const canonical = canonicalStoryStoragePaths(storyDevRoot, docSlug);
  const defaultArchiveDirectory = canonical.ok ? canonical.defaultArchiveDirectory : "";
  const customArchiveDirectory = tab?.archiveDir && path.isAbsolute(String(tab.archiveDir))
    ? path.resolve(String(tab.archiveDir))
    : "";
  const storedArchiveFile = tab?.archiveFile && path.isAbsolute(String(tab.archiveFile))
    ? path.resolve(String(tab.archiveFile))
    : "";
  const archiveDirectory = customArchiveDirectory
    || (storedArchiveFile && fs.existsSync(storedArchiveFile) ? path.dirname(storedArchiveFile) : defaultArchiveDirectory);
  const archiveFile = storedArchiveFile
    || (archiveDirectory ? path.join(archiveDirectory, `${docSlug}.txt`) : "");
  return {
    version: 3,
    capturedAt: Date.now(),
    projectId: project?.id || tab?.primaryProjectId || null,
    projectPath,
    projectRealPath,
    projectIdentity: projectPath ? readStorageIdentity(projectPath) : null,
    storyDevRoot,
    storyDevRealPath,
    storyDevIdentity,
    storyDirectory: canonical.ok ? canonical.storyDirectory : "",
    docSlug,
    defaultArchiveDirectory,
    archiveDirectory,
    archiveFile,
    attachmentDirectories: canonical.ok ? canonical.attachmentDirectories : [],
    pathValidationError: canonical.ok ? "" : canonical.reason,
  };
}

function inspectDeletionTarget(target) {
  const result = {
    path: target || "",
    exists: false,
    isDirectory: false,
    isFile: false,
    isLink: false,
    linkCount: 0,
    fileCount: 0,
    directoryCount: 0,
    bytes: 0,
    truncated: false,
    readErrors: [],
  };
  if (!target) return result;
  let rootStat;
  try { rootStat = fs.lstatSync(target); } catch (error) {
    if (error?.code !== "ENOENT") result.readErrors.push({ path: target, error: error.message });
    return result;
  }
  result.exists = true;
  result.isLink = rootStat.isSymbolicLink();
  result.isDirectory = rootStat.isDirectory();
  result.isFile = rootStat.isFile();
  if (result.isFile) {
    result.fileCount = 1;
    result.bytes = Number(rootStat.size) || 0;
    return result;
  }
  if (!result.isDirectory || result.isLink) return result;
  const stack = [target];
  let visited = 0;
  while (stack.length) {
    const current = stack.pop();
    let entries = [];
    try { entries = fs.readdirSync(current, { withFileTypes: true }); } catch (error) {
      result.readErrors.push({ path: current, error: error.message });
      continue;
    }
    for (const entry of entries) {
      visited += 1;
      if (visited > 20000) { result.truncated = true; stack.length = 0; break; }
      const full = path.join(current, entry.name);
      let stat;
      try { stat = fs.lstatSync(full); } catch (error) {
        result.readErrors.push({ path: full, error: error.message });
        continue;
      }
      if (stat.isSymbolicLink()) {
        // 只统计链接本身，不跟随 junction/symlink 到目录外。
        result.fileCount += 1;
        result.linkCount += 1;
      } else if (stat.isDirectory()) {
        result.directoryCount += 1;
        stack.push(full);
      } else if (stat.isFile()) {
        result.fileCount += 1;
        result.bytes += Number(stat.size) || 0;
      }
    }
  }
  return result;
}

function directoryRealpathSafe(storageRoot, target, allowedRoot) {
  if (!storageRoot || !target) return { ok: false, reason: "没有可验证的故事点存储根目录" };
  if (!pathInsideDeletionRoot(storageRoot, target) || sameDeletionPath(storageRoot, target)) {
    return { ok: false, reason: "目标目录不在故事点存储根目录内" };
  }
  if (!allowedRoot || !pathInsideDeletionRoot(allowedRoot, target) || sameDeletionPath(allowedRoot, target)) {
    return { ok: false, reason: "目标目录越过故事点资料的安全根目录" };
  }
  const broadTargets = [
    storageRoot,
    allowedRoot,
  ];
  if (broadTargets.some((item) => sameDeletionPath(item, target))) {
    return { ok: false, reason: "目标过宽，禁止删除故事点存储根或整个故事点目录" };
  }
  if (fs.existsSync(target)) {
    try {
      const stat = fs.lstatSync(target);
      if (stat.isSymbolicLink()) return { ok: false, reason: "目标是符号链接或 junction，禁止递归删除" };
      if (!stat.isDirectory()) return { ok: false, reason: "目标存在但不是目录" };
      const realStorageRoot = fs.realpathSync(storageRoot);
      const realAllowedRoot = fs.realpathSync(allowedRoot);
      const realTarget = fs.realpathSync(target);
      if (!pathInsideDeletionRoot(realStorageRoot, realTarget) || sameDeletionPath(realStorageRoot, realTarget)) {
        return { ok: false, reason: "目标真实路径越过故事点存储根边界" };
      }
      if (!pathInsideDeletionRoot(realAllowedRoot, realTarget) || sameDeletionPath(realAllowedRoot, realTarget)) {
        return { ok: false, reason: "目标真实路径越过故事点资料的安全根目录" };
      }
    } catch (error) {
      return { ok: false, reason: `无法验证目标目录：${error.message}` };
    }
  }
  return { ok: true, reason: "" };
}

function tabsReferencingDirectory(target, targetId, kind) {
  if (!target) return [];
  const refs = [];
  for (const item of [...loadTabs(), ...loadClosed().filter((closed) => !isTabPermanentlyDeleted(closed?.id))]) {
    if (!item || item.id === targetId) continue;
    const info = closedArchiveInfo(item);
    const directoryCandidates = [
      ...(item.conversationBackupDirectories || []),
      ...(kind === "archive" ? [info.effectiveDir] : []),
      ...(kind === "attachments" ? (info.attachmentDirectories || []) : []),
    ];
    const fileCandidates = [
      ...(item.conversationBackupFiles || []),
      item.restoredConversationBackupSource,
      ...(kind === "attachments" ? (item.materials || []).map((material) => {
        const storedPath = String(material?.path || "").trim();
        if (storedPath && path.isAbsolute(storedPath)) return path.resolve(storedPath);
        const relPath = String(material?.relPath || "").trim();
        if (!relPath) return "";
        if (path.isAbsolute(relPath)) return path.resolve(relPath);
        if (relPath.startsWith("storydev:/") && info.storyDirectory) {
          const candidate = path.resolve(info.storyDirectory, relPath.slice("storydev:/".length));
          return pathInsideDeletionRoot(info.storyDirectory, candidate) ? candidate : "";
        }
        return info.project?.path ? path.resolve(info.project.path, relPath) : "";
      }) : []),
    ];
    const referencesTarget = directoryCandidates.some((candidate) => (
      candidate && (sameDeletionPath(candidate, target) || pathInsideDeletionRoot(target, candidate))
    )) || fileCandidates.some((candidate) => candidate && pathInsideDeletionRoot(target, candidate));
    if (referencesTarget) {
      refs.push({ id: item.id, title: item.title || item.id });
    }
  }
  return refs;
}

function knownConversationBackupLocations(tab, archiveInfo) {
  const directories = new Map();
  const files = new Map();
  const addDir = (value) => {
    if (!value || !path.isAbsolute(String(value))) return;
    const resolved = path.resolve(String(value));
    directories.set(deletionPathKey(resolved), resolved);
  };
  const addFile = (value) => {
    if (!value || !path.isAbsolute(String(value))) return;
    const resolved = path.resolve(String(value));
    files.set(deletionPathKey(resolved), resolved);
    addDir(path.dirname(resolved));
  };
  addDir(archiveInfo.effectiveDir);
  addDir(archiveInfo.defaultDir);
  for (const value of archiveInfo.attachmentDirectories || []) addDir(value);
  for (const value of tab?.conversationBackupDirectories || []) addDir(value);
  for (const value of tab?.conversationBackupFiles || []) addFile(value);
  if (tab?.restoredConversationBackupSource) addFile(tab.restoredConversationBackupSource);
  return { directories: [...directories.values()], indexedFiles: [...files.values()] };
}

function scanConversationBackupsForTab(tab, archiveInfo) {
  const known = knownConversationBackupLocations(tab, archiveInfo);
  const candidates = new Map();
  let scannedFiles = 0;
  let truncated = false;
  let visited = 0;
  const readErrors = [];
  const addCandidate = (filePath) => {
    const key = deletionPathKey(filePath);
    if (key) candidates.set(key, path.resolve(filePath));
  };
  for (const filePath of known.indexedFiles) addCandidate(filePath);
  for (const root of known.directories) {
    if (truncated) break;
    if (!fs.existsSync(root)) continue;
    const stack = [root];
    while (stack.length) {
      const dir = stack.pop();
      let entries = [];
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (error) {
        readErrors.push({ path: dir, error: error.message });
        continue;
      }
      for (const entry of entries) {
        visited += 1;
        if (visited > 20000) { truncated = true; stack.length = 0; break; }
        const full = path.join(dir, entry.name);
        let stat;
        try { stat = fs.lstatSync(full); } catch (error) {
          readErrors.push({ path: full, error: error.message });
          continue;
        }
        if (stat.isSymbolicLink()) continue;
        if (stat.isDirectory()) {
          stack.push(full);
          continue;
        }
        if (!stat.isFile() || !entry.name.toLowerCase().endsWith(".devbench-chat.json")) continue;
        scannedFiles += 1;
        addCandidate(full);
      }
    }
  }
  const backups = [];
  for (const filePath of candidates.values()) {
    if (!fs.existsSync(filePath)) continue;
    let link = false;
    try { link = fs.lstatSync(filePath).isSymbolicLink(); } catch { continue; }
    if (link) continue;
    const parsed = readConversationBackup(filePath);
    if (!parsed.ok || String(parsed.data?.sourceTab?.id || "") !== String(tab.id)) continue;
    backups.push({
      path: parsed.file,
      name: path.basename(parsed.file),
      size: Number(parsed.size) || 0,
      createdAt: Number(parsed.data.createdAt) || Number(parsed.mtime) || 0,
      kind: parsed.data.kind || "manual",
    });
  }
  backups.sort((a, b) => b.createdAt - a.createdAt);
  return {
    directories: known.directories,
    files: backups,
    count: backups.length,
    bytes: backups.reduce((sum, item) => sum + item.size, 0),
    truncated,
    scanIncomplete: truncated || readErrors.length > 0,
    readErrors,
    discoveryNote: "仅删除系统已登记目录、当前 TXT 存档目录及已知还原来源中，校验通过且 sourceTab.id 精确匹配的 JSON 备份；旧版未登记的自定义目录无法自动定位。",
  };
}

function attachmentDeletionTargets(tab, archiveInfo) {
  if (archiveInfo.attachmentDirectories?.length) {
    return archiveInfo.attachmentDirectories.filter((item, index, all) => (
      all.findIndex((other) => sameDeletionPath(other, item)) === index
    ));
  }
  if (!archiveInfo.project?.path) return [];
  return [
    path.join(archiveInfo.project.path, "docs", "story", archiveInfo.docSlug, "archives"),
    path.join(archiveInfo.project.path, "docs", archiveInfo.docSlug, "archives"),
  ].filter((item, index, all) => all.findIndex((other) => sameDeletionPath(other, item)) === index);
}

function inspectDirectoryBackupOwnership(target, targetId) {
  const result = { owned: [], foreign: [], invalid: [], truncated: false, readErrors: [] };
  if (!target || !fs.existsSync(target)) return result;
  const stack = [target];
  let visited = 0;
  while (stack.length) {
    const current = stack.pop();
    let entries = [];
    try { entries = fs.readdirSync(current, { withFileTypes: true }); } catch (error) {
      result.readErrors.push({ path: current, error: error.message });
      continue;
    }
    for (const entry of entries) {
      visited += 1;
      if (visited > 20000) { result.truncated = true; stack.length = 0; break; }
      const full = path.join(current, entry.name);
      let stat;
      try { stat = fs.lstatSync(full); } catch (error) {
        result.readErrors.push({ path: full, error: error.message });
        continue;
      }
      if (stat.isSymbolicLink()) {
        if (entry.name.toLowerCase().endsWith(".devbench-chat.json")) result.invalid.push({ path: full, error: "备份文件是链接" });
        continue;
      }
      if (stat.isDirectory()) { stack.push(full); continue; }
      if (!stat.isFile() || !entry.name.toLowerCase().endsWith(".devbench-chat.json")) continue;
      const parsed = readConversationBackup(full);
      if (!parsed.ok) {
        result.invalid.push({ path: full, error: parsed.error || "无法确认备份所有者" });
        continue;
      }
      const ownerId = String(parsed.data?.sourceTab?.id || "");
      if (!ownerId || ownerId !== String(targetId)) {
        result.foreign.push({ path: parsed.file, sourceTabId: ownerId, title: parsed.data?.sourceTab?.title || "" });
      } else {
        result.owned.push({ path: parsed.file, sourceTabId: ownerId, title: parsed.data?.sourceTab?.title || "" });
      }
    }
  }
  return result;
}

function directoryDeletionPreview(tab, target, kind, expectedDefault) {
  const inspected = inspectDeletionTarget(target);
  const sharedBy = tabsReferencingDirectory(target, tab.id, kind);
  const backupOwnership = inspectDirectoryBackupOwnership(target, tab.id);
  const stableInfo = closedArchiveInfo(tab);
  let safety = { ok: false, reason: "没有可删除的目录" };
  if (target && expectedDefault && sameDeletionPath(target, expectedDefault)) {
    const storageRoot = stableInfo.deletionRoot || "";
    const allowedRoot = (stableInfo.allowedRoots || []).find((root) => (
      pathInsideDeletionRoot(root, target) && !sameDeletionPath(root, target)
    )) || "";
    safety = directoryRealpathSafe(storageRoot, target, allowedRoot);
  } else if (target) {
    safety = { ok: false, reason: "该目录是自定义或还原来源目录，缺少故事点独占标记，禁止递归删除" };
  }
  if (tab && Object.hasOwn(tab, "closedAt") && !stableInfo.storagePathStable) {
    safety = { ok: false, reason: stableInfo.storagePathUnsafeReason || "关闭时的物理路径无法安全验证，禁止递归删除" };
  }
  if (sharedBy.length) {
    safety = { ok: false, reason: `目录还被其它故事点引用：${sharedBy.map((item) => `「${item.title}」`).join("、")}` };
  }
  if (backupOwnership.foreign.length) {
    const owners = [...new Set(backupOwnership.foreign.map((item) => item.title || item.sourceTabId || "其它故事点"))];
    safety = { ok: false, reason: `目录内含其它故事点的 JSON 对话备份：${owners.map((name) => `「${name}」`).join("、")}` };
  }
  if (backupOwnership.invalid.length) {
    safety = { ok: false, reason: `目录内有 ${backupOwnership.invalid.length} 个无法确认所有者的 JSON 对话备份，禁止整目录删除` };
  }
  if (backupOwnership.readErrors.length) safety = { ok: false, reason: "目录内备份所有权扫描发生读取错误，禁止整目录删除" };
  if (backupOwnership.truncated) safety = { ok: false, reason: "目录内备份所有权扫描未完成，禁止整目录删除" };
  if (inspected.isLink) safety = { ok: false, reason: "目标是符号链接或 junction，禁止递归删除" };
  if (inspected.linkCount) safety = { ok: false, reason: `目录内含 ${inspected.linkCount} 个符号链接或 junction，禁止递归删除` };
  if (inspected.readErrors.length) safety = { ok: false, reason: "目录内容无法完整读取，禁止递归删除" };
  if (inspected.truncated) safety = { ok: false, reason: "目录内容过多，无法完成安全预检" };
  return { ...inspected, safeToDelete: !!safety.ok, unsafeReason: safety.reason || "", sharedBy, backupOwnership };
}

function effectiveExecutionSessionId(tab) {
  const explicit = String(tab?.sessionId || "").trim();
  return explicit || (tab?.id ? `dev_${tab.id}` : "");
}

function storageIdentityFromStat(stat) {
  if (!stat) return null;
  return {
    dev: String(stat.dev),
    ino: String(stat.ino),
    birthtimeNs: String(stat.birthtimeNs || ""),
  };
}

function inspectLegacyStorySnapshot(filePath, tabId, { includeRows = false } = {}) {
  const result = { path: filePath, exists: false, safeToRewrite: true, matchingRecords: 0, error: "" };
  let stat;
  try { stat = fs.lstatSync(filePath, { bigint: true }); }
  catch (error) {
    if (error?.code !== "ENOENT") return { ...result, safeToRewrite: false, error: error.message };
    return result;
  }
  result.exists = true;
  if (stat.isSymbolicLink() || !stat.isFile()) return { ...result, safeToRewrite: false, error: "旧快照目标不是普通文件" };
  let fd;
  try {
    const noFollow = Number(fs.constants.O_NOFOLLOW) || 0;
    fd = fs.openSync(filePath, fs.constants.O_RDONLY | noFollow);
    const openedStat = fs.fstatSync(fd, { bigint: true });
    if (!openedStat.isFile()) return { ...result, safeToRewrite: false, error: "旧快照打开后不是普通文件" };
    const identity = storageIdentityFromStat(stat);
    if (!sameStorageIdentity(identity, storageIdentityFromStat(openedStat))) {
      return { ...result, safeToRewrite: false, error: "旧快照在核对期间文件系统身份已变化" };
    }
    const rows = JSON.parse(fs.readFileSync(fd, "utf8"));
    if (!Array.isArray(rows)) return { ...result, safeToRewrite: false, error: "旧快照不是数组格式" };
    result.matchingRecords = rows.filter((item) => item?.id === tabId).length;
    if (includeRows) {
      result.rows = rows;
      result.identity = identity;
    }
    return result;
  } catch (error) {
    return { ...result, safeToRewrite: false, error: error.message };
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch {}
  }
}

function legacyStorySnapshotPreviews(tabId) {
  return [TABS_FILE, `${TABS_FILE}.migrated`, CLOSED_FILE, `${CLOSED_FILE}.migrated`]
    .map((filePath) => inspectLegacyStorySnapshot(filePath, tabId));
}

function writeLegacyStorySnapshotAtomically(filePath, rows, expectedIdentity) {
  const tempPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 10)}.tmp`,
  );
  let fd;
  try {
    fd = fs.openSync(tempPath, "wx");
    fs.writeFileSync(fd, `${JSON.stringify(rows, null, 2)}\n`, "utf8");
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    const currentStat = fs.lstatSync(filePath, { bigint: true });
    if (currentStat.isSymbolicLink() || !currentStat.isFile()
      || !sameStorageIdentity(storageIdentityFromStat(currentStat), expectedIdentity)) {
      throw new Error("旧快照在原子替换前文件系统身份已变化");
    }
    fs.renameSync(tempPath, filePath);
    // 支持目录 fsync 的平台上同步目录项；Windows 不支持时不影响已完成的原子替换。
    let directoryFd;
    try {
      directoryFd = fs.openSync(path.dirname(filePath), "r");
      fs.fsyncSync(directoryFd);
    } catch {} finally {
      if (directoryFd !== undefined) try { fs.closeSync(directoryFd); } catch {}
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error.message };
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch {}
    try { fs.rmSync(tempPath, { force: true }); } catch {}
  }
}

function removeLegacyStorySnapshot(item, tabId) {
  const refreshed = inspectLegacyStorySnapshot(item.path, tabId, { includeRows: true });
  if (!refreshed.safeToRewrite) return { status: "failed", path: item.path, removed: 0, error: refreshed.error || "旧快照无法安全重写" };
  if (!refreshed.exists || refreshed.matchingRecords === 0) return { status: "missing", path: item.path, removed: 0 };
  try {
    const rows = refreshed.rows;
    const next = rows.filter((row) => row?.id !== tabId);
    const written = writeLegacyStorySnapshotAtomically(item.path, next, refreshed.identity);
    if (!written.ok) return { status: "failed", path: item.path, removed: 0, error: written.error || "旧快照原子替换失败" };
    const verified = inspectLegacyStorySnapshot(item.path, tabId, { includeRows: true });
    if (!verified.safeToRewrite || verified.matchingRecords !== 0) {
      return { status: "failed", path: item.path, removed: 0, error: verified.error || "旧快照写入后校验失败" };
    }
    const verifiedRows = verified.rows;
    if (JSON.stringify(verifiedRows) !== JSON.stringify(next)) {
      return { status: "failed", path: item.path, removed: 0, error: "旧快照写入后内容发生并发变化" };
    }
    return { status: "deleted", path: item.path, removed: rows.length - next.length };
  } catch (error) {
    return { status: "failed", path: item.path, removed: 0, error: error.message };
  }
}

export function previewClosedStoryDeletion(id) {
  const tabId = String(id || "").trim();
  const validId = validateDeletionTabId(tabId);
  if (!validId.ok) return { ok: false, statusCode: 400, code: "INVALID_STORY_ID", error: validId.reason };
  if (isTabPermanentlyDeleted(tabId)) {
    return { ok: false, statusCode: 404, code: "CLOSED_STORY_NOT_FOUND", error: "已关闭故事点不存在或已被删除" };
  }
  if (getTab(tabId)) {
    return { ok: false, statusCode: 409, code: "STORY_NOT_CLOSED", error: "故事点仍在打开中，只允许物理删除已关闭的故事点" };
  }
  const tab = loadClosed().find((item) => item.id === tabId);
  if (!tab) return { ok: false, statusCode: 404, code: "CLOSED_STORY_NOT_FOUND", error: "已关闭故事点不存在或已被删除" };
  const info = closedArchiveInfo(tab);
  const executionSessionId = effectiveExecutionSessionId(tab);
  const sharedExecutionSessionBy = executionSessionId ? [...loadTabs(), ...loadClosed()]
    .filter((item) => item?.id !== tab.id && effectiveExecutionSessionId(item) === executionSessionId)
    .map((item) => ({ id: item.id, title: item.title || item.id })) : [];
  const archiveDirectory = directoryDeletionPreview(tab, info.effectiveDir, "archive", info.defaultDir);
  const attachmentTargets = attachmentDeletionTargets(tab, info).map((target) => directoryDeletionPreview(
    tab,
    target,
    "attachments",
    target,
  ));
  const attachmentDirectories = attachmentTargets.map((item) => item.path).filter(Boolean);
  const conversationBackups = scanConversationBackupsForTab(tab, info);
  conversationBackups.files = conversationBackups.files.map((file) => ({
    ...file,
    coveredByArchiveDirectory: !!(archiveDirectory.path && pathInsideDeletionRoot(archiveDirectory.path, file.path)),
    coveredByAttachmentDirectory: attachmentDirectories.some((directory) => pathInsideDeletionRoot(directory, file.path)),
  }));
  conversationBackups.coveredByArchiveDirectoryCount = conversationBackups.files.filter((file) => file.coveredByArchiveDirectory).length;
  conversationBackups.coveredByAttachmentDirectoryCount = conversationBackups.files.filter((file) => file.coveredByAttachmentDirectory).length;
  return {
    ok: true,
    data: {
      story: {
        id: tab.id,
        title: tab.title || tab.id,
        closedAt: Number(tab.closedAt) || 0,
        groupId: tab.groupId || null,
        groupName: tab.groupName || null,
      },
      core: {
        messageFile: inspectDeletionTarget(msgFile(tab.id)),
        conversationFile: inspectDeletionTarget(conversationFile(tab.id)),
        liveDraftFile: inspectDeletionTarget(liveFile(tab.id)),
        legacyStorySnapshots: legacyStorySnapshotPreviews(tab.id),
        executionHistory: {
          sessionId: executionSessionId,
          description: "该故事点在本机 SQLite 中的 AI 执行任务、日志与 Token 记录",
          safeToDelete: sharedExecutionSessionBy.length === 0,
          sharedBy: sharedExecutionSessionBy,
        },
        note: "永久删除故事点记录时固定删除；待办任务本身及其业务字段不会删除。",
      },
      conversationBackups,
      archiveDirectory,
      attachments: {
        paths: attachmentTargets,
        exists: attachmentTargets.some((item) => item.exists),
        fileCount: attachmentTargets.reduce((sum, item) => sum + item.fileCount, 0),
        bytes: attachmentTargets.reduce((sum, item) => sum + item.bytes, 0),
        safeToDelete: attachmentTargets.length > 0 && attachmentTargets.every((item) => item.safeToDelete),
        unsafeReason: attachmentTargets.find((item) => !item.safeToDelete)?.unsafeReason || info.storagePathUnsafeReason || "",
        conversationBackupCount: conversationBackups.coveredByAttachmentDirectoryCount,
        note: "仅删除主工程内本故事点的新旧 archives 本地副本，不会删除 TB 云端附件；目录内若含 JSON 对话备份，必须同时明确选择删除对话备份。",
      },
      preservationNote: "未勾选的外部资料会保留；AI 配置推理与训练样本不属于聊天存档，继续保留。",
    },
  };
}

export function beginClosedStoryDeletion(id, expectedClosedAt = null) {
  if (!Number.isFinite(expectedClosedAt) || Number(expectedClosedAt) < 0) {
    return { ok: false, statusCode: 400, code: "CLOSED_VERSION_REQUIRED", error: "永久删除必须携带预览中的有效关闭版本，请重新打开确认窗口" };
  }
  const preview = previewClosedStoryDeletion(id);
  if (!preview.ok) return preview;
  if (Number(expectedClosedAt) !== Number(preview.data.story.closedAt)) {
    return { ok: false, statusCode: 409, code: "CLOSED_STORY_CHANGED", error: "故事点关闭状态已变化，请重新打开删除确认窗口" };
  }
  const tabId = String(id || "");
  if (isTabDeletionBlocked(tabId)) {
    const markerInfo = readDeletionTombstone(tabId);
    const marker = markerInfo.data;
    const leaseStartedAt = Number(marker?.startedAt || markerInfo.mtimeMs || 0);
    let ownerDefinitelyStopped = false;
    if (marker?.host && marker.host === os.hostname() && Number.isInteger(Number(marker.pid)) && Number(marker.pid) > 0) {
      try { process.kill(Number(marker.pid), 0); }
      catch (error) { ownerDefinitelyStopped = error?.code === "ESRCH"; }
    }
    const stale = markerInfo.exists
      && marker?.state !== "deleted"
      && leaseStartedAt > 0
      && Date.now() - leaseStartedAt > 15 * 60 * 1000
      && ownerDefinitelyStopped;
    if (stale) releaseClosedStoryDeletion(tabId);
  }
  if (isTabDeletionBlocked(tabId)) {
    return { ok: false, statusCode: 409, code: "DELETE_IN_PROGRESS", error: "该故事点正在永久删除，请勿重复提交" };
  }
  const claimed = claimDeletionTombstone(tabId, expectedClosedAt);
  if (!claimed.ok) {
    return {
      ok: false,
      statusCode: claimed.code === "DELETE_IN_PROGRESS" ? 409 : 500,
      code: claimed.code,
      error: claimed.code === "DELETE_IN_PROGRESS" ? "该故事点正在被另一个网关永久删除，请勿重复提交" : `无法建立跨进程删除保护：${claimed.error || "未知错误"}`,
    };
  }
  DELETING_TAB_IDS.add(tabId);
  return { ok: true, data: preview.data };
}

// 无副作用地校验永久删除确认、版本与磁盘范围。路由必须先完成这里的全部校验，
// 才能建立 tombstone 或停止 AI；执行阶段会在 tombstone 下再次校验，防止预览后状态变化。
export function validateClosedStoryPurge(id, options = {}) {
  const tabId = String(id || "").trim();
  const preview = previewClosedStoryDeletion(tabId);
  if (!preview.ok) return preview;
  if (!Number.isFinite(options.expectedClosedAt) || Number(options.expectedClosedAt) < 0) {
    return { ok: false, statusCode: 400, code: "CLOSED_VERSION_REQUIRED", error: "永久删除必须携带预览中的有效关闭版本，请重新打开确认窗口" };
  }
  if (Number(options.expectedClosedAt) !== Number(preview.data.story.closedAt)) {
    return { ok: false, statusCode: 409, code: "CLOSED_STORY_CHANGED", error: "故事点关闭状态已变化，请重新确认删除范围" };
  }
  if (String(options.confirmId || "") !== tabId) {
    return { ok: false, statusCode: 400, code: "DELETE_CONFIRMATION_MISMATCH", error: "永久删除确认已失效，请重新确认" };
  }
  if (!preview.data.core.executionHistory.safeToDelete) {
    const names = preview.data.core.executionHistory.sharedBy.map((item) => `「${item.title}」`).join("、");
    return {
      ok: false,
      statusCode: 409,
      code: "SHARED_EXECUTION_SESSION",
      error: `AI 执行会话还被其它故事点引用：${names}；为避免误删其它故事点历史，本次永久删除已取消`,
      data: preview.data,
    };
  }
  const unsafeLegacySnapshot = preview.data.core.legacyStorySnapshots.find((item) => !item.safeToRewrite);
  if (unsafeLegacySnapshot) {
    return {
      ok: false,
      statusCode: 409,
      code: "UNSAFE_LEGACY_STORY_SNAPSHOT",
      error: `旧故事点快照无法安全核对，已取消永久删除：${unsafeLegacySnapshot.error || unsafeLegacySnapshot.path}`,
      data: preview.data,
    };
  }
  const deleteConversationBackups = options.deleteConversationBackups === true;
  const deleteArchiveDirectory = options.deleteArchiveDirectory === true;
  const deleteAttachments = options.deleteAttachments === true;
  if (deleteArchiveDirectory && !preview.data.archiveDirectory.safeToDelete) {
    return { ok: false, statusCode: 409, code: "UNSAFE_ARCHIVE_DIRECTORY", error: preview.data.archiveDirectory.unsafeReason || "TXT 存档目录不能安全删除", data: preview.data };
  }
  if (deleteAttachments && !preview.data.attachments.safeToDelete) {
    return { ok: false, statusCode: 409, code: "UNSAFE_ATTACHMENT_DIRECTORY", error: preview.data.attachments.unsafeReason || "附件目录不能安全删除", data: preview.data };
  }
  if (deleteAttachments && !deleteConversationBackups && preview.data.conversationBackups.coveredByAttachmentDirectoryCount > 0) {
    return {
      ok: false,
      statusCode: 409,
      code: "ATTACHMENT_CONTAINS_CONVERSATION_BACKUP",
      error: `附件目录内含 ${preview.data.conversationBackups.coveredByAttachmentDirectoryCount} 个 JSON 对话备份；请同时勾选删除独立 JSON 完整对话备份，或保留附件目录`,
      data: preview.data,
    };
  }
  if (deleteConversationBackups && preview.data.conversationBackups.scanIncomplete) {
    return { ok: false, statusCode: 409, code: "BACKUP_SCAN_INCOMPLETE", error: "聊天备份扫描未能完整读取，已取消永久删除", data: preview.data };
  }
  return { ok: true, data: preview.data };
}

function removeDeletionFile(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return { status: "missing", path: filePath || "" };
  try {
    const stat = fs.lstatSync(filePath);
    if (stat.isSymbolicLink() || !stat.isFile()) return { status: "failed", path: filePath, error: "目标不是可安全删除的普通文件" };
    fs.rmSync(filePath, { force: true });
    return { status: "deleted", path: filePath };
  } catch (error) {
    return { status: "failed", path: filePath, error: error.message };
  }
}

function restoreQuarantinedDeletionDirectory(originalPath, quarantinePath) {
  try {
    if (fs.existsSync(quarantinePath) && !fs.existsSync(originalPath)) {
      fs.renameSync(quarantinePath, originalPath);
      return true;
    }
  } catch {}
  return false;
}

function removeDeletionDirectory(item, {
  tab = null,
  kind = "attachments",
  expectedDefault = "",
  allowOwnedConversationBackups = false,
} = {}) {
  if (!item?.path || !item.exists) return { status: "missing", path: item?.path || "", deletedFiles: 0, deletedBytes: 0 };
  const refreshed = tab ? directoryDeletionPreview(tab, item.path, kind, expectedDefault || item.path) : item;
  if (!refreshed.exists) return { status: "missing", path: item.path, deletedFiles: 0, deletedBytes: 0 };
  if (!refreshed.safeToDelete) {
    return { status: "failed", path: item.path, error: refreshed.unsafeReason || "删除前安全复核失败", deletedFiles: 0, deletedBytes: 0 };
  }
  if (kind === "attachments" && !allowOwnedConversationBackups && refreshed.backupOwnership?.owned?.length) {
    return { status: "failed", path: item.path, error: "附件目录新增了本故事点 JSON 对话备份，必须同时确认删除备份", deletedFiles: 0, deletedBytes: 0 };
  }

  // 在同一父目录中先 rename 隔离（同卷原子操作）。隔离后其它进程即使继续向原路径写入，
  // 也只会创建一个新目录，不会进入本次删除集合；再扫描隔离目录，关闭预检到 rm 之间的 TOCTOU 窗口。
  const nonce = createHash("sha256").update(`${item.path}|${process.pid}|${Date.now()}|${Math.random()}`).digest("hex").slice(0, 12);
  const quarantinePath = path.join(path.dirname(item.path), `.${path.basename(item.path)}.devbench-delete-${nonce}`);
  try {
    fs.renameSync(item.path, quarantinePath);
  } catch (error) {
    return { status: "failed", path: item.path, error: error.message, deletedFiles: 0, deletedBytes: 0 };
  }

  const isolated = inspectDeletionTarget(quarantinePath);
  const isolatedOwnership = inspectDirectoryBackupOwnership(quarantinePath, tab?.id);
  const isolatedUnsafeReason = isolated.isLink || isolated.linkCount
    ? "隔离目录内含链接，已取消递归删除"
    : (isolated.truncated || isolated.readErrors.length || isolatedOwnership.truncated || isolatedOwnership.readErrors.length
      ? "隔离目录未能完整复核，已取消递归删除"
      : (isolatedOwnership.foreign.length || isolatedOwnership.invalid.length
        ? "隔离目录内出现其它故事点或无法确认所有者的对话备份，已取消递归删除"
        : (kind === "attachments" && !allowOwnedConversationBackups && isolatedOwnership.owned.length
          ? "隔离附件目录内出现本故事点 JSON 对话备份，必须同时确认删除备份"
          : "")));
  if (isolatedUnsafeReason) {
    const restored = restoreQuarantinedDeletionDirectory(item.path, quarantinePath);
    return {
      status: "failed",
      path: item.path,
      error: restored ? isolatedUnsafeReason : `${isolatedUnsafeReason}；隔离目录无法自动还原：${quarantinePath}`,
      deletedFiles: 0,
      deletedBytes: 0,
    };
  }

  try {
    fs.rmSync(quarantinePath, { recursive: true, force: true, maxRetries: 2, retryDelay: 50 });
    return { status: "deleted", path: item.path, deletedFiles: refreshed.fileCount, deletedBytes: refreshed.bytes };
  } catch (error) {
    const restored = restoreQuarantinedDeletionDirectory(item.path, quarantinePath);
    return {
      status: "failed",
      path: item.path,
      error: restored ? error.message : `${error.message}；剩余内容位于隔离目录：${quarantinePath}`,
      deletedFiles: 0,
      deletedBytes: 0,
    };
  }
}

export function purgeClosedStory(id, options = {}) {
  const tabId = String(id || "").trim();
  const initialValidation = validateClosedStoryPurge(tabId, options);
  if (!initialValidation.ok) return initialValidation;
  let acquiredHere = false;
  if (!DELETING_TAB_IDS.has(tabId)) {
    const begun = beginClosedStoryDeletion(tabId, options.expectedClosedAt);
    if (!begun.ok) return begun;
    acquiredHere = true;
  }
  const finishFailure = (result) => {
    if (acquiredHere) releaseClosedStoryDeletion(tabId);
    return result;
  };
  const finalValidation = validateClosedStoryPurge(tabId, options);
  if (!finalValidation.ok) return finishFailure(finalValidation);
  const preview = { ok: true, data: finalValidation.data };
  const legacySnapshotLock = claimLegacySnapshotRewriteLock({ tabId });
  if (!legacySnapshotLock.ok) {
    return finishFailure({
      ok: false,
      statusCode: legacySnapshotLock.code === "LEGACY_SNAPSHOT_LOCK_TIMEOUT" ? 409 : 500,
      code: legacySnapshotLock.code,
      error: legacySnapshotLock.error || "无法取得旧故事点快照更新锁，故事点尚未删除",
    });
  }
  const deleteConversationBackups = options.deleteConversationBackups === true;
  const deleteArchiveDirectory = options.deleteArchiveDirectory === true;
  const deleteAttachments = options.deleteAttachments === true;

  const result = {
    story: { status: "pending", id: tabId, title: preview.data.story.title },
    core: {},
    conversationBackups: {
      requested: deleteConversationBackups,
      status: deleteConversationBackups ? "pending" : "preserved",
      deletedCount: 0,
      coveredByArchiveDirectoryCount: 0,
      coveredByAttachmentDirectoryCount: 0,
      files: [],
      discoveryNote: preview.data.conversationBackups.discoveryNote,
    },
    archiveDirectory: { requested: deleteArchiveDirectory, status: deleteArchiveDirectory ? "pending" : "preserved", path: preview.data.archiveDirectory.path || "" },
    attachments: { requested: deleteAttachments, status: deleteAttachments ? "pending" : "preserved", paths: [] },
  };

  const archivePath = deleteArchiveDirectory ? preview.data.archiveDirectory.path : "";
  const attachmentPaths = deleteAttachments ? preview.data.attachments.paths.map((item) => item.path).filter(Boolean) : [];
  const backupFiles = preview.data.conversationBackups.files;
  let preDatabaseFailure = null;
  try {
  if (deleteConversationBackups) {
    for (const file of backupFiles) {
      if (archivePath && pathInsideDeletionRoot(archivePath, file.path)) {
        result.conversationBackups.coveredByArchiveDirectoryCount += 1;
        result.conversationBackups.files.push({ status: "covered_by_archive_directory", path: file.path });
        continue;
      }
      if (attachmentPaths.some((directory) => pathInsideDeletionRoot(directory, file.path))) {
        result.conversationBackups.coveredByAttachmentDirectoryCount += 1;
        result.conversationBackups.files.push({ status: "covered_by_attachment_directory", path: file.path });
        continue;
      }
      const removed = removeDeletionFile(file.path);
      result.conversationBackups.files.push(removed);
      if (removed.status === "deleted") result.conversationBackups.deletedCount += 1;
    }
    result.conversationBackups.status = result.conversationBackups.files.some((item) => item.status === "failed")
      ? "failed"
      : (backupFiles.length ? "deleted" : "missing");
  } else if (archivePath) {
    const covered = backupFiles.filter((file) => pathInsideDeletionRoot(archivePath, file.path));
    result.conversationBackups.coveredByArchiveDirectoryCount = covered.length;
    result.conversationBackups.files = covered.map((file) => ({ status: "covered_by_archive_directory", path: file.path }));
    if (covered.length) result.conversationBackups.status = "covered_by_archive_directory";
  }

  if (deleteArchiveDirectory) {
    const removed = removeDeletionDirectory(preview.data.archiveDirectory, {
      tab: loadClosed().find((item) => item.id === tabId),
      kind: "archive",
      expectedDefault: closedArchiveInfo(loadClosed().find((item) => item.id === tabId)).defaultDir,
      allowOwnedConversationBackups: true,
    });
    Object.assign(result.archiveDirectory, removed);
  }

  if (deleteAttachments) {
    const deletingTab = loadClosed().find((item) => item.id === tabId);
    result.attachments.paths = preview.data.attachments.paths.map((item) => removeDeletionDirectory(item, {
      tab: deletingTab,
      kind: "attachments",
      expectedDefault: item.path,
      allowOwnedConversationBackups: deleteConversationBackups,
    }));
    result.attachments.status = result.attachments.paths.some((item) => item.status === "failed")
      ? "failed"
      : (result.attachments.paths.some((item) => item.status === "deleted") ? "deleted" : "missing");
  }

  const optionalFailed = result.conversationBackups.status === "failed"
    || result.archiveDirectory.status === "failed"
    || result.attachments.status === "failed";
  if (optionalFailed) {
    preDatabaseFailure = { ok: false, partial: true, statusCode: 500, code: "RESOURCE_DELETE_FAILED", error: "部分资料删除失败，故事点记录仍保留，可处理失败项后重试", data: result };
  }

  if (!preDatabaseFailure) {
    conversationReadCache.delete(tabId);
    result.core.messageFile = removeDeletionFile(msgFile(tabId));
    result.core.conversationFile = removeDeletionFile(conversationFile(tabId));
    result.core.liveDraftFile = removeDeletionFile(liveFile(tabId));
    result.core.legacyStorySnapshots = preview.data.core.legacyStorySnapshots.map((item) => removeLegacyStorySnapshot(item, tabId));
    const coreFileFailed = [
      result.core.messageFile,
      result.core.liveDraftFile,
      ...result.core.legacyStorySnapshots,
    ].some((item) => item.status === "failed");
    if (coreFileFailed) {
      preDatabaseFailure = { ok: false, partial: true, statusCode: 500, code: "CORE_DELETE_FAILED", error: "页面聊天或旧故事点快照删除失败，故事点记录仍保留，可按明细重试", data: result };
    }
  }
  } finally {
    const released = releaseLegacySnapshotRewriteLock(legacySnapshotLock.token);
    if (!released.ok) {
      result.core.legacySnapshotLock = { status: "failed", error: released.error || "旧故事点快照更新锁释放失败" };
      preDatabaseFailure = {
        ok: false,
        partial: true,
        statusCode: 500,
        code: "CORE_DELETE_FAILED",
        error: `${preDatabaseFailure?.error ? `${preDatabaseFailure.error}；` : ""}旧故事点快照更新锁释放失败：${released.error || "未知错误"}`,
        data: result,
      };
    }
  }
  if (preDatabaseFailure) return finishFailure(preDatabaseFailure);
  try {
    result.core.executionHistory = { status: "deleted", ...deleteDevbenchExecutionHistory(preview.data.core.executionHistory.sessionId) };
  } catch (error) {
    result.core.executionHistory = { status: "failed", error: error.message };
    return finishFailure({ ok: false, partial: true, statusCode: 500, code: "EXECUTION_HISTORY_DELETE_FAILED", error: `AI 执行历史删除失败：${error.message}`, data: result });
  }
  try {
    removeClosed(tabId);
    result.story.status = "deleted";
  } catch (error) {
    return finishFailure({ ok: false, partial: true, statusCode: 500, code: "CLOSED_RECORD_DELETE_FAILED", error: `故事点关闭记录删除失败：${error.message}`, data: result });
  }
  if (!markDeletionTombstoneDeleted(tabId)) {
    return {
      ok: false,
      partial: true,
      statusCode: 500,
      code: "DELETE_MARKER_FAILED",
      retainDeletionMarker: true,
      error: "故事点资料已删除，但永久删除标记落盘失败；系统已保持删除锁，禁止旧快照恢复，请检查磁盘后重试",
      data: result,
    };
  }
  DELETING_TAB_IDS.delete(tabId);
  return { ok: true, data: result };
}

// 关闭故事点只做软归档：把完整 tab(含 cliSessionId/groupId/配置)存入已关闭列表、消息文件保留。
// 物理删除必须在已关闭列表完成服务端预检与二次确认，旧 purge 参数一律拒绝。
export function deleteTab(id, { purge = false } = {}) {
  if (purge) {
    return { ok: false, statusCode: 409, code: "PURGE_CLOSED_ONLY", error: "只能先关闭故事点，再从已关闭故事点列表核对范围并永久删除" };
  }
  if (isTabDeletionBlocked(id)) {
    return { ok: false, statusCode: 409, code: "STORY_OPERATION_IN_PROGRESS", error: "故事点正在永久删除或恢复，暂时不能关闭" };
  }
  const changed = updateDevbenchStoryState(storageUserKey("tabs"), ({ tabs, closed }) => {
    const visibleTabs = (Array.isArray(tabs) ? tabs : []).filter((item) => !isTabPermanentlyDeleted(item?.id));
    const index = visibleTabs.findIndex((item) => item?.id === id);
    if (index < 0) return { result: { ok: true, removed: 0 } };
    const t = visibleTabs[index];
    const nextTabs = visibleTabs.filter((item) => item.id !== id);
    // 若移除的是组内成员：修复剩余成员的活动指针（被删的是活动则迁移到剩余第一个；只剩 1 个则解散组）
    if (t.groupId) reconcileGroup(nextTabs, t.groupId);
    // 软归档：完整保留(配置/cliSessionId/groupId/聊天)，恢复同 id 可继续。
    // tabs/closed 必须在同一个事务中迁移，避免 worktree 元数据更新与关闭动作互相覆盖。
    const closedAt = Math.max(Date.now(), Number(t.lastClosedAt || 0) + 1);
    const nextClosed = (Array.isArray(closed) ? closed : [])
      .filter((item) => item?.id !== id && !isTabPermanentlyDeleted(item?.id));
    nextClosed.unshift({
      ...t,
      closedStorageSnapshot: captureClosedStorageSnapshot(t),
      groupActive: false,
      closedRunningTaskId: t.runningTaskId || null,
      runningTaskId: null,
      closedAt,
    });
    return {
      tabs: nextTabs,
      closed: nextClosed,
      result: { ok: true, removed: 1, closed: true },
    };
  }, nodeIdSafe());
  // 消息文件【保留】，恢复同 id 后继续显示历史
  return changed.result || { ok: false, statusCode: 500, code: "STORY_CLOSE_FAILED", error: "故事点关闭状态写入失败" };
}

// ========== 隐藏态（OneTab 风格收起，AI/会话继续运行，仅从 tab 栏移出）==========
// hidden:true 的 tab 仍留在 tabs.json、保留 cliSessionId/groupId/工程占用/AI 运行，
// 仅前端从 tab 栏过滤掉；与 closeTab(软归档到已关闭列表)完全不同，不动工作区、不动消息。
// 隐藏批次（hideBatchId/hideBatchAt）：同一次收起操作（单 tab / 整组 / 一键收起）内被隐藏的
// tab 共享同一 hideBatchId，供前端隐藏面板按批次分组显示与整组还原；还原时清除批次字段。
function normalizeHideBatch(hideBatch) {
  if (!hideBatch || typeof hideBatch !== "object") return null;
  const id = String(hideBatch.id || "").trim();
  if (!id) return null;
  return { id, at: Number(hideBatch.at) || Date.now() };
}

export function setTabHidden(id, hidden, hideBatch) {
  const tabId = String(id || "").trim();
  if (!tabId) return { ok: false, statusCode: 400, code: "STORY_ID_REQUIRED", error: "故事点 ID 不能为空" };
  const wantHidden = !!hidden;
  const batch = wantHidden ? normalizeHideBatch(hideBatch) : null;
  const changed = updateDevbenchStoryState(storageUserKey("tabs"), ({ tabs }) => {
    const visibleTabs = (Array.isArray(tabs) ? tabs : []).filter((item) => !isTabPermanentlyDeleted(item?.id));
    const index = visibleTabs.findIndex((item) => item?.id === tabId);
    if (index < 0) return { result: { ok: false, statusCode: 404, code: "STORY_NOT_FOUND", error: "故事点不存在或已关闭" } };
    const current = visibleTabs[index];
    if (!!current.hidden === wantHidden) {
      return { result: { ok: true, tab: current, noop: true } };
    }
    const updated = { ...current, hidden: wantHidden, updatedAt: Date.now() };
    if (wantHidden) {
      // 隐藏：写入本次收起批次；未带批次（如兼容调用）则保留已有批次字段。
      if (batch) {
        updated.hideBatchId = batch.id;
        updated.hideBatchAt = batch.at;
      }
    } else {
      // 还原：清除批次字段，下次收起再归入新批次。
      delete updated.hideBatchId;
      delete updated.hideBatchAt;
    }
    visibleTabs[index] = updated;
    return { tabs: visibleTabs, result: { ok: true, tab: updated } };
  }, nodeIdSafe());
  return changed.result || { ok: false, statusCode: 500, code: "STORY_HIDDEN_UPDATE_FAILED", error: "故事点隐藏态写入失败" };
}

// 一键收起：把当前所有未隐藏的 tab 全部置 hidden:true，并写入同一隐藏批次。已隐藏的保持不动。
// 返回 { ok, hidden: <count> }。空 tab 列表时返回 ok:true, hidden:0。
export function hideAllTabs(hideBatch) {
  const batch = normalizeHideBatch(hideBatch);
  const changed = updateDevbenchStoryState(storageUserKey("tabs"), ({ tabs }) => {
    const visibleTabs = (Array.isArray(tabs) ? tabs : []).filter((item) => !isTabPermanentlyDeleted(item?.id));
    let count = 0;
    const nextTabs = visibleTabs.map((item) => {
      if (item?.hidden) return item;
      count += 1;
      const updated = { ...item, hidden: true, updatedAt: Date.now() };
      if (batch) {
        updated.hideBatchId = batch.id;
        updated.hideBatchAt = batch.at;
      }
      return updated;
    });
    return { tabs: nextTabs, result: { ok: true, hidden: count } };
  }, nodeIdSafe());
  return changed.result || { ok: false, statusCode: 500, code: "STORY_HIDE_ALL_FAILED", error: "一键收起写入失败" };
}

// ========== 已关闭故事点（配置快照，供新建复制）==========

export function closeGroup(groupId, { purge = false } = {}) {
  if (purge) {
    return { ok: false, statusCode: 409, code: "PURGE_CLOSED_ONLY", error: "故事点组只能先关闭；永久删除请在已关闭故事点列表逐条核对范围" };
  }
  const gid = String(groupId || "").trim();
  if (!gid) return { ok: false, error: "组 ID 不能为空" };
  const tabs = loadTabs();
  const members = tabs.filter((t) => t.groupId === gid).sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
  if (!members.length) return { ok: false, error: "故事点组不存在或已全部关闭" };
  const blockedMember = members.find((item) => isTabDeletionBlocked(item.id));
  if (blockedMember) return { ok: false, statusCode: 409, code: "STORY_OPERATION_IN_PROGRESS", error: `故事点「${blockedMember.title || blockedMember.id}」正在永久删除或恢复，暂时不能关闭该组` };
  const changed = updateDevbenchStoryState(storageUserKey("tabs"), ({ tabs: currentTabs, closed }) => {
    const visibleTabs = (Array.isArray(currentTabs) ? currentTabs : [])
      .filter((item) => !isTabPermanentlyDeleted(item?.id));
    const latestMembers = visibleTabs
      .filter((item) => item.groupId === gid)
      .sort((left, right) => (left.createdAt || 0) - (right.createdAt || 0));
    if (!latestMembers.length) {
      return { result: { ok: false, statusCode: 409, code: "STORY_GROUP_CHANGED", error: "故事点组状态已变化，请刷新后重试" } };
    }
    const latestBlocked = latestMembers.find((item) => isTabDeletionBlocked(item.id));
    if (latestBlocked) {
      return { result: { ok: false, statusCode: 409, code: "STORY_OPERATION_IN_PROGRESS", error: `故事点「${latestBlocked.title || latestBlocked.id}」正在永久删除或恢复，暂时不能关闭该组` } };
    }
    const memberIds = new Set(latestMembers.map((item) => item.id));
    const closedAt = Math.max(Date.now(), ...latestMembers.map((item) => Number(item.lastClosedAt || 0) + 1));
    const existing = (Array.isArray(closed) ? closed : [])
      .filter((item) => !memberIds.has(item.id) && !isTabPermanentlyDeleted(item?.id));
    const snapshots = latestMembers.map((item) => ({
      ...item,
      closedStorageSnapshot: captureClosedStorageSnapshot(item),
      groupId: gid,
      groupName: item.groupName || latestMembers[0]?.groupName || "故事点组",
      groupActive: false,
      groupWasActive: !!item.groupActive,
      groupClosedAt: closedAt,
      closedRunningTaskId: item.runningTaskId || null,
      runningTaskId: null,
      closedAt,
    }));
    return {
      tabs: visibleTabs.filter((item) => !memberIds.has(item.id)),
      closed: [...snapshots, ...existing],
      result: { ok: true, removed: latestMembers.length, closed: true, groupId: gid },
    };
  }, nodeIdSafe());
  return changed.result || { ok: false, statusCode: 500, code: "STORY_GROUP_CLOSE_FAILED", error: "故事点组关闭状态写入失败" };
}

export function closeTabGroup(tabId, opts = {}) {
  const tab = getTab(tabId);
  if (!tab) return { ok: false, error: "故事点不存在" };
  if (!tab.groupId) return { ok: false, error: "该故事点不在任何组" };
  return closeGroup(tab.groupId, opts);
}

function loadClosed() { return loadKind("closed", CLOSED_FILE).filter((item) => !isTabPermanentlyDeleted(item?.id)); }
function saveClosed(arr) { saveKind("closed", (arr || []).filter((item) => !isTabPermanentlyDeleted(item?.id))); }
function removeClosed(id) {
  // 物理删除与另一 Gateway 正在关闭其它故事点时，必须基于数据库最新行做增量删除；
  // 不能把本进程较早读取的整个 closed 数组覆盖回去，否则会丢掉并发关闭的故事点。
  updateUserData(storageUserKey("closed"), "closed", (current) => (
    (Array.isArray(current) ? current : [])
      .filter((item) => item?.id !== id && !isTabPermanentlyDeleted(item?.id))
  ), nodeIdSafe());
}

export function listClosedTabs() {
  return loadClosed();
}

export function updateStoryWorktreeEntry(id, {
  worktreePath = "",
  expectedEntryBranch = "",
  entryUpdates = {},
} = {}) {
  const tabId = String(id || "").trim();
  const targetPath = normPath(worktreePath);
  const entryBranch = String(expectedEntryBranch || "").trim();
  if (!tabId || !targetPath || !entryBranch || !entryUpdates || typeof entryUpdates !== "object" || Array.isArray(entryUpdates)) {
    return { ok: false, code: "INVALID_WORKTREE_UPDATE", error: "worktree 更新参数不完整" };
  }
  if (isTabDeletionBlocked(tabId)) {
    return { ok: false, code: "STORY_OPERATION_IN_PROGRESS", error: "故事点正在永久删除或恢复，不能更新 worktree" };
  }
  const changed = updateDevbenchStoryState(storageUserKey("tabs"), ({ tabs, closed }) => {
    if (isTabDeletionBlocked(tabId)) {
      return { result: { ok: false, code: "STORY_OPERATION_IN_PROGRESS", error: "故事点正在永久删除或恢复，不能更新 worktree" } };
    }
    const visibleTabs = (Array.isArray(tabs) ? tabs : []).filter((item) => !isTabPermanentlyDeleted(item?.id));
    const visibleClosed = (Array.isArray(closed) ? closed : []).filter((item) => !isTabPermanentlyDeleted(item?.id));
    const activeIndex = visibleTabs.findIndex((item) => item?.id === tabId);
    const closedIndex = visibleClosed.findIndex((item) => item?.id === tabId);
    if ((activeIndex >= 0 ? 1 : 0) + (closedIndex >= 0 ? 1 : 0) !== 1) {
      return { result: { ok: false, code: "STORY_STATE_CHANGED", error: "故事点打开/关闭状态已变化，请重试" } };
    }
    const ownerClosed = closedIndex >= 0;
    const collection = ownerClosed ? visibleClosed : visibleTabs;
    const index = ownerClosed ? closedIndex : activeIndex;
    const tab = collection[index];
    const entries = Array.isArray(tab?.worktree?.entries) ? tab.worktree.entries : [];
    const entryIndex = entries.findIndex((entry) => normPath(entry?.worktreePath || entry?.path) === targetPath);
    if (entryIndex < 0) {
      return { result: { ok: false, code: "WORKTREE_ENTRY_CHANGED", error: "故事点 worktree 记录已变化，请重试" } };
    }
    if (String(entries[entryIndex]?.branch || "").trim() !== entryBranch) {
      return { result: { ok: false, code: "WORKTREE_BRANCH_CHANGED", error: "故事点 worktree 分支记录已变化，请重试" } };
    }
    const nextEntries = entries.map((entry, candidateIndex) => (
      candidateIndex === entryIndex ? { ...entry, ...entryUpdates } : entry
    ));
    const updated = {
      ...tab,
      worktree: { ...tab.worktree, entries: nextEntries },
      updatedAt: Date.now(),
    };
    collection[index] = updated;
    return {
      tabs: visibleTabs,
      closed: visibleClosed,
      result: { ok: true, tab: updated, ownerClosed },
    };
  }, nodeIdSafe());
  return changed.result || { ok: false, code: "WORKTREE_STATE_UPDATE_FAILED", error: "worktree 状态写入失败" };
}

function workspacePromotionCasIdentity(workspace) {
  return JSON.stringify({
    workspaceId: String(workspace?.workspaceId || ""),
    operationId: String(workspace?.operationId || ""),
    root: normPath(workspace?.root || ""),
    bundleMembers: (Array.isArray(workspace?.bundle?.members) ? workspace.bundle.members : [])
      .map((member) => ({
        repositoryId: String(member?.repositoryId || ""),
        checkoutDirName: String(member?.checkoutDirName || ""),
        mode: String(member?.mode || "EDITABLE"),
        association: member?.association === true,
      }))
      .sort((left, right) => left.repositoryId.localeCompare(right.repositoryId)),
    entries: (Array.isArray(workspace?.entries) ? workspace.entries : [])
      .map((entry) => ({
        repositoryId: String(entry?.repositoryId || ""),
        path: normPath(entry?.worktreePath || entry?.path || ""),
        branch: String(entry?.branch || ""),
        baseRevision: String(entry?.baseRevision || "").toLowerCase(),
        mode: String(entry?.mode || "EDITABLE"),
        detached: entry?.detached === true,
        active: entry?.active !== false && entry?.role !== "inactive",
      }))
      .sort((left, right) => left.repositoryId.localeCompare(right.repositoryId)),
  });
}

/**
 * 只读 Bundle 成员原位创建故事分支后的单次 CAS 写回。
 * 只允许成员 branch/mode/detached 和审计字段变化，禁止借此替换工作区根或成员路径。
 */
export function replaceStoryWorktreeWorkspace(id, {
  expectedWorkspace = null,
  workspace = null,
} = {}) {
  const tabId = String(id || "").trim();
  if (!tabId || !expectedWorkspace || !workspace) {
    return { ok: false, code: "INVALID_WORKSPACE_REPLACEMENT", error: "Bundle 工作区写回参数不完整" };
  }
  if (isTabDeletionBlocked(tabId)) {
    return { ok: false, code: "STORY_OPERATION_IN_PROGRESS", error: "故事点正在永久删除或恢复，不能更新 worktree" };
  }
  const expectedIdentity = workspacePromotionCasIdentity(expectedWorkspace);
  const nextEntries = Array.isArray(workspace.entries) ? workspace.entries : [];
  if (!workspace.workspaceId || workspace.bundle?.enabled !== true || !nextEntries.length) {
    return { ok: false, code: "INVALID_WORKSPACE_REPLACEMENT", error: "新的 Bundle 工作区状态不完整" };
  }
  const expectedPaths = [...new Set((expectedWorkspace.entries || [])
    .map((entry) => normPath(entry?.worktreePath || entry?.path || ""))
    .filter(Boolean))].sort();
  const nextPaths = [...new Set(nextEntries
    .map((entry) => normPath(entry?.worktreePath || entry?.path || ""))
    .filter(Boolean))].sort();
  const expectedRepositoryIds = (expectedWorkspace.entries || [])
    .map((entry) => String(entry?.repositoryId || ""))
    .filter(Boolean)
    .sort();
  const nextRepositoryIds = nextEntries
    .map((entry) => String(entry?.repositoryId || ""))
    .filter(Boolean)
    .sort();
  if (normPath(expectedWorkspace.root) !== normPath(workspace.root)
    || String(expectedWorkspace.workspaceId || "") !== String(workspace.workspaceId || "")
    || String(expectedWorkspace.bundle?.buildEntryRepositoryId || "") !== String(workspace.bundle?.buildEntryRepositoryId || "")
    || JSON.stringify(expectedPaths) !== JSON.stringify(nextPaths)
    || JSON.stringify(expectedRepositoryIds) !== JSON.stringify(nextRepositoryIds)) {
    return { ok: false, code: "WORKSPACE_TOPOLOGY_CHANGED", error: "按需创建分支不得改变 Bundle 根目录或成员路径" };
  }
  const changed = updateDevbenchStoryState(storageUserKey("tabs"), ({ tabs, closed }) => {
    if (isTabDeletionBlocked(tabId)) {
      return { result: { ok: false, code: "STORY_OPERATION_IN_PROGRESS", error: "故事点正在永久删除或恢复，不能更新 worktree" } };
    }
    const visibleTabs = (Array.isArray(tabs) ? tabs : []).filter((item) => !isTabPermanentlyDeleted(item?.id));
    const visibleClosed = (Array.isArray(closed) ? closed : []).filter((item) => !isTabPermanentlyDeleted(item?.id));
    const activeIndex = visibleTabs.findIndex((item) => item?.id === tabId);
    const closedIndex = visibleClosed.findIndex((item) => item?.id === tabId);
    if ((activeIndex >= 0 ? 1 : 0) + (closedIndex >= 0 ? 1 : 0) !== 1) {
      return { result: { ok: false, code: "STORY_STATE_CHANGED", error: "故事点打开/关闭状态已变化，请重试" } };
    }
    const ownerClosed = closedIndex >= 0;
    const collection = ownerClosed ? visibleClosed : visibleTabs;
    const index = ownerClosed ? closedIndex : activeIndex;
    const current = collection[index];
    if (workspacePromotionCasIdentity(current?.worktree) !== expectedIdentity) {
      return { result: { ok: false, code: "WORKSPACE_STATE_CHANGED", error: "故事点工作区状态已变化，请重试" } };
    }
    const updated = { ...current, worktree: workspace, updatedAt: Date.now() };
    collection[index] = updated;
    return {
      tabs: visibleTabs,
      closed: visibleClosed,
      result: { ok: true, tab: updated, ownerClosed },
    };
  }, nodeIdSafe());
  return changed.result || { ok: false, code: "WORKSPACE_STATE_UPDATE_FAILED", error: "Bundle 工作区状态写入失败" };
}

// 标题是否已被占用（进行中 + 已关闭，按去空白精确匹配）。返回 { where, id } 或 null。exceptId 排除自身。
export function titleTaken(title, exceptId = null) {
  const t = String(title || "").trim();
  if (!t) return null;
  for (const tab of loadTabs()) if (tab.id !== exceptId && String(tab.title || "").trim() === t) return { where: "进行中故事点", id: tab.id };
  for (const c of listClosedTabs()) if (c.id !== exceptId && String(c.title || "").trim() === t) return { where: "已关闭故事点", id: c.id };
  return null;
}

/**
 * 重新打开已关闭的故事点：【同 id 还原】完整 tab（配置/cliSessionId/聊天历史都在，可继续与 AI 对话）。
 * 先检测冲突：工程/设备被其它进行中故事点占用则拒绝（同组豁免；force 跳过）。无冲突才还原并从已关闭列表移除。
 * 返回 { ok, tab } 或 { ok:false, error, conflicts? }。
 */
export function reopenClosed(id, { force = false } = {}) {
  if (isTabPermanentlyDeleted(id)) return { ok: false, code: "CLOSED_STORY_NOT_FOUND", error: "已关闭故事点不存在或已被删除" };
  if (isTabDeletionBlocked(id)) return { ok: false, code: "DELETE_IN_PROGRESS", error: "该故事点正在永久删除，不能重新打开" };
  const closed = loadClosed();
  const src = closed.find((c) => c.id === id);
  if (!src) return { ok: false, error: "已关闭故事点不存在" };
  const restoreGroup = src.groupId && src.groupClosedAt
    ? closed.filter((c) => c.groupId === src.groupId && c.groupClosedAt === src.groupClosedAt)
    : [src];
  const blockedMember = restoreGroup.find((item) => isTabDeletionBlocked(item.id));
  if (blockedMember) {
    return {
      ok: false,
      code: "DELETE_IN_PROGRESS",
      error: `同组故事点「${blockedMember.title || blockedMember.id}」正在永久删除，当前不能恢复该组`,
    };
  }
  const restoring = (restoreGroup.length > 1 ? restoreGroup : [src]).map((c) => ({ ...c }));
  const restoreIds = new Set(restoring.map((c) => c.id));
  const activeTabs = loadTabs();

  // 标题唯一（对进行中故事点）。force（组队/恢复并绑定场景）时撞名不再拦：自动改成唯一名，保证能顺利打开/组队。
  for (const item of restoring) {
    const activeTitleTaken = (title) => activeTabs.find((t) => t.id !== item.id && String(t.title || "").trim() === String(title || "").trim());
    const dup = activeTitleTaken(item.title);
    if (dup) {
      if (!force) return { ok: false, error: `标题「${item.title}」已被进行中故事点占用，无法直接打开；请先改名或用「复制配置」新建` };
      const base = item.title; let t = base, n = 2;
      while (activeTitleTaken(t)) t = `${base}(${n++})`;
      item.title = t;
    }
  }

  // 本地工程由独立 worktree 隔离；目标设备绑定也允许多故事点共享。
  // 恢复时不争抢物理设备，真正开始脚本/安装/测试时再进入运行时 FIFO 租约。

  // 跨进程 Gateway 可能在上面的冲突检查期间开始删除组内成员；任何写回前再检查一次。
  const newlyBlockedMember = restoring.find((item) => isTabDeletionBlocked(item.id));
  if (newlyBlockedMember) {
    return {
      ok: false,
      code: "DELETE_IN_PROGRESS",
      error: `同组故事点「${newlyBlockedMember.title || newlyBlockedMember.id}」正在永久删除，当前不能恢复该组`,
    };
  }

  // 对整组成员按 ID 排序获取同一套跨进程互斥 marker。物理删除和恢复因此不能同时越过
  // “检查后写入”的窗口；若任一成员已在删除，释放本次已取得的 marker 后整体拒绝。
  const operationLocks = [];
  for (const item of [...restoring].sort((left, right) => String(left.id).localeCompare(String(right.id)))) {
    const claimed = claimDeletionTombstone(item.id, Number(item.closedAt) || 0, "reopening");
    if (!claimed.ok) {
      for (const lockedId of operationLocks) releaseClosedStoryDeletion(lockedId);
      return { ok: false, code: "DELETE_IN_PROGRESS", error: `同组故事点「${item.title || item.id}」正在执行永久删除或恢复，请稍后重试` };
    }
    operationLocks.push(item.id);
  }

  try {
    const changed = updateDevbenchStoryState(storageUserKey("tabs"), ({ tabs: currentTabs, closed: currentClosed }) => {
      const visibleTabs = (Array.isArray(currentTabs) ? currentTabs : []).filter((item) => !isTabPermanentlyDeleted(item?.id));
      const visibleClosed = (Array.isArray(currentClosed) ? currentClosed : []).filter((item) => !isTabPermanentlyDeleted(item?.id));
      const changedMember = restoring.find((item) => {
        const latest = visibleClosed.find((candidate) => candidate.id === item.id);
        return !latest
          || Number(latest.closedAt || 0) !== Number(item.closedAt || 0)
          || Number(latest.groupClosedAt || 0) !== Number(item.groupClosedAt || 0);
      });
      if (changedMember || restoring.some((item) => visibleTabs.some((candidate) => candidate.id === item.id))) {
        return { result: { ok: false, code: "CLOSED_STORY_CHANGED", error: "故事点关闭状态已变化，请刷新后重试" } };
      }

      for (const item of restoring) {
        // 无冲突 → 【同 id 还原】完整 tab 放回进行中列表（保留 cliSessionId/groupId/配置；消息文件未删 → 历史还在）
        const tab = { ...item };
        tab.lastClosedAt = Math.max(Number(tab.lastClosedAt || 0), Number(item.closedAt || 0));
        delete tab.closedAt;
        delete tab.groupClosedAt;
        delete tab.groupWasActive;
        delete tab.closedStorageSnapshot;
        delete tab.closedRunningTaskId;
        // 兼容旧的"摘要式"已关闭快照(缺 sessionId 等)：补必要字段，保证 WS 路由可用
        if (!tab.sessionId) tab.sessionId = `dev_${tab.id}`;
        if (tab.turns === undefined) tab.turns = 0;
        if (tab.groupId && restoring.length > 1) tab.groupActive = tab.id === id;
        tab.runningTaskId = null;
        tab.updatedAt = Date.now();
        visibleTabs.push(tab);
      }
      // 修复组活动状态：整组恢复时保持被点击成员为活动成员；若没有活动成员则选第一个。
      if (src.groupId) reconcileGroup(visibleTabs, src.groupId);
      const nextClosed = visibleClosed.filter((item) => !restoreIds.has(item.id));
      const finalTab = visibleTabs.find((item) => item.id === id) || restoring[0];
      return {
        tabs: visibleTabs,
        closed: nextClosed,
        result: { ok: true, tab: finalTab, restored: restoring.length, groupRestored: restoring.length > 1 ? src.groupId : null },
      };
    }, nodeIdSafe());
    return changed.result || { ok: false, error: "故事点恢复失败" };
  } finally {
    for (const lockedId of operationLocks) releaseClosedStoryDeletion(lockedId);
  }
}

/**
 * 按某个来源配置新建故事点：直接复制主工程 / 关联工程 / 设备，但不带入会话与存档。
 * 复制是用户有意为之，因此【不做互斥跳过】——即使来源故事点仍占用这些工程/设备，
 * 也照样复制（允许多个故事点共用，由用户自行管理）。返回 { tab, skipped: string[] }。
 */
export function createTabFromConfig(title, src) {
  // 未显式传标题时，沿用来源故事点的名字作为初始值（复制是有意为之，名字一并带过来更顺手）
  let tab = createTab({ title: title || (src && src.title) || undefined });
  if (!src) return { tab, skipped: [] };
  const tabs = loadTabs();
  const idx = tabs.findIndex((t) => t.id === tab.id);
  if (idx >= 0) {
    copySharedConfig(src, tabs[idx]);
    tabs[idx].updatedAt = Date.now();
    saveTabs(tabs);
    tab = tabs[idx];
  }
  if (src.centerHost) {
    tab = updateTab(tab.id, {
      centerHost: src.centerHost,
      centerName: src.centerName || "",
      ...(src.centerToken ? { centerToken: src.centerToken } : {}),
    });
  }
  return { tab, skipped: [] };
}

// 兼容旧调用方：worktree 模式不再接管或释放其它故事点的工程。
export function releasePathsFromOtherTabs() { return []; }

function deviceChangeNotice(from, to, reason = "") {
  return { from: from || "", to: to || "", at: Date.now(), reason };
}

function clearDeviceAiSession(t) {
  t.cliSessionId = null;
  t.cliSessionEngine = null;
  t.cliSessionIds = {};
  t.remoteAgentSessionId = null;
  t.remoteAgentLastEventId = null;
}

// 后向兼容旧插件：共享绑定模式下绝不再解除其它故事点的设备。
export function releaseDeviceFromOtherTabs() { return []; }

// ===== 故事点组/队列（同一工程串行解不同 TB 单）=====
// 同 groupId 的故事点是一组；组内只有 groupActive===true 的那个能与 AI 聊天（其余排队，仅可看/下附件）。
// 组内故事点共享工程配置，但 TB 单、备注、附件、聊天记录等仍各自独立。
const GROUP_SHARED_KEYS = [
  "engine",
  "aiPrefs",
  "projectDefId",
  "primaryProjectId",
  "mode",
  "flavors",
  "deviceSerial",
  "apkSourcePath",
  "extraProjects",
  "remotePull",
  "remoteRepos",
  "cloneStatus",
  "remoteLocalizedAt",
];

export function getGroupMembers(groupId) {
  if (!groupId) return [];
  return loadTabs().filter((t) => t.groupId === groupId).sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
}
function hasSharedConfig(tab) {
  return !!(tab?.engine
    || tab?.primaryProjectId
    || (tab?.mode === "remote" && Array.isArray(tab?.remotePull?.entries) && tab.remotePull.entries.length)
    || (Array.isArray(tab?.remoteRepos) && tab.remoteRepos.length)
    || (Array.isArray(tab?.extraProjects) && tab.extraProjects.length)
    || (Array.isArray(tab?.flavors) && tab.flavors.length)
    || tab?.deviceSerial
    || tab?.apkSourcePath);
}

function groupConfigSource(tabs, groupId, fallback, excludeId = null) {
  const members = groupId ? tabs.filter((t) => t.groupId === groupId) : [];
  const active = members.find((t) => t.groupActive && t.id !== excludeId && hasSharedConfig(t));
  if (active) return active;
  if (fallback && fallback.id !== excludeId && hasSharedConfig(fallback)) return fallback;
  return members.find((t) => t.id !== excludeId && hasSharedConfig(t)) || null;
}

function groupSourceFingerprint(source) {
  if (!source) return "";
  const payload = Object.fromEntries([
    ...GROUP_SHARED_KEYS,
    "worktree",
    "groupId",
    "groupActive",
  ].map((field) => [field, source[field] ?? null]));
  return createHash("sha256").update(stableJsonText(payload)).digest("hex");
}

function groupTransitionToken({ kind, target, anchor = null, source = null }) {
  return {
    kind,
    targetId: String(target?.id || ""),
    targetGroupId: String(target?.groupId || ""),
    anchorId: String(anchor?.id || ""),
    anchorGroupId: String(anchor?.groupId || ""),
    sourceId: String(source?.id || ""),
    sourceFingerprint: groupSourceFingerprint(source),
  };
}

function groupSourceChanged(expected, actual) {
  return stableJsonText(expected || {}) !== stableJsonText(actual || {});
}

function groupJoinPlanFromTabs(tabs, tabId, anchorTabId) {
  const target = tabs.find((tab) => tab.id === tabId);
  const anchor = tabs.find((tab) => tab.id === anchorTabId);
  if (!target || !anchor) return { ok: false, error: "故事点不存在" };
  if (target.id === anchor.id) return { ok: false, error: "不能和自己组队" };
  if (target.groupId && target.groupId === anchor.groupId) {
    return {
      ok: true,
      idempotent: true,
      target,
      anchor,
      source: null,
      token: groupTransitionToken({ kind: "join", target, anchor }),
    };
  }
  const source = groupConfigSource(tabs, anchor.groupId, anchor, target.id);
  return {
    ok: true,
    target,
    anchor,
    source,
    token: groupTransitionToken({ kind: "join", target, anchor, source }),
  };
}

export function planGroupJoin(tabId, anchorTabId) {
  const plan = groupJoinPlanFromTabs(loadTabs(), tabId, anchorTabId);
  if (!plan.ok) return plan;
  return {
    ok: true,
    idempotent: plan.idempotent === true,
    token: JSON.parse(JSON.stringify(plan.token)),
    source: plan.source ? JSON.parse(JSON.stringify(plan.source)) : null,
  };
}

function groupActivePlanFromTabs(tabs, groupId, tabId) {
  const target = tabs.find((tab) => tab.id === tabId && tab.groupId === groupId);
  if (!target) return { ok: false, error: "该故事点不在此组" };
  if (target.groupActive === true) {
    return {
      ok: true,
      idempotent: true,
      target,
      source: null,
      token: groupTransitionToken({ kind: "active", target }),
    };
  }
  const source = groupConfigSource(tabs, groupId, null, tabId);
  return {
    ok: true,
    target,
    source,
    token: groupTransitionToken({ kind: "active", target, source }),
  };
}

export function planGroupActive(groupId, tabId) {
  const plan = groupActivePlanFromTabs(loadTabs(), groupId, tabId);
  if (!plan.ok) return plan;
  return {
    ok: true,
    idempotent: plan.idempotent === true,
    token: JSON.parse(JSON.stringify(plan.token)),
    source: plan.source ? JSON.parse(JSON.stringify(plan.source)) : null,
  };
}

function tabCarbId(tab) {
  const s = String(tab?.title || "");
  return (s.match(/#\s*(CARB-\d+)\s*#/i)?.[1] || s.match(/\bCARB-\d+\b/i)?.[0] || "").toUpperCase();
}

// 把工程/设备配置复制到目标故事点（深拷贝）。只复制 GROUP_SHARED_KEYS，不碰 TB 单/备注/附件/聊天。
const GROUP_LOCAL_WORKSPACE_KEYS = new Set([
  "primaryProjectId",
  "flavors",
  "apkSourcePath",
  "extraProjects",
]);

function copySharedConfig(from, to, { preserveLocalWorkspace = false } = {}) {
  const prevDevice = to?.deviceSerial || "";
  const prevEngine = to?.engine || "claude";
  for (const k of GROUP_SHARED_KEYS) {
    if (preserveLocalWorkspace && GROUP_LOCAL_WORKSPACE_KEYS.has(k)) continue;
    if (!from || from[k] === undefined) {
      delete to[k];
      continue;
    }
    if (k === "remotePull") {
      const rp = JSON.parse(JSON.stringify(from[k] || {}));
      rp.tbId = tabCarbId(to) || to?.remotePull?.tbId || "";
      to[k] = rp;
      continue;
    }
    to[k] = (from[k] && typeof from[k] === "object") ? JSON.parse(JSON.stringify(from[k])) : from[k];
  }
  const nextDevice = to?.deviceSerial || "";
  const nextEngine = to?.engine || "claude";
  if (prevEngine !== nextEngine) {
    clearDeviceAiSession(to);
  }
  if (prevDevice !== nextDevice) {
    to.deviceChangeNotice = deviceChangeNotice(prevDevice, nextDevice, "shared_config");
    clearDeviceAiSession(to);
  }
}
// 在传入的 tabs 数组上原地修复某组的活动指针：保证组内恰好一个 active；只剩 1 个成员则解散组。
function reconcileGroup(tabs, groupId) {
  if (!groupId) return;
  const members = tabs.filter((t) => t.groupId === groupId).sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
  if (members.length === 1) { members[0].groupId = null; members[0].groupActive = false; members[0].groupName = null; }
  else if (members.length && !members.some((t) => t.groupActive)) members[0].groupActive = true;
}
// tabId 加入 anchorTabId 所在的组（anchor 无组则以它新建组）；加入者默认排队。
// 加入组即同步组内活动成员/锚点的工程配置；TB 单字段保持各自独立。
export function joinGroup(tabId, anchorTabId, options = {}) {
  if (tabId === anchorTabId) return { ok: false, error: "不能和自己组队" };
  const changed = updateDevbenchStoryState(storageUserKey("tabs"), ({ tabs }) => {
    const visibleTabs = (Array.isArray(tabs) ? tabs : [])
      .filter((item) => !isTabPermanentlyDeleted(item?.id));
    // 路由层的 plan 只用于准备 worktree；最终 plan/token 必须在同一写事务内
    // 重新计算和校验，避免另一个 Gateway 在检查与 saveTabs 之间改写组状态。
    const plan = groupJoinPlanFromTabs(visibleTabs, tabId, anchorTabId);
    if (!plan.ok) return { result: plan };
    if (options.expectedSourceToken
      && groupSourceChanged(options.expectedSourceToken, plan.token)) {
      return { result: { ok: false, statusCode: 409, code: "GROUP_SOURCE_CHANGED", error: "目标组或共享工程配置已变化，请刷新后重试" } };
    }
    const { target: tab, anchor } = plan;
    const previousGroupId = tab.groupId || null;
    let gid = anchor.groupId;
    if (!gid) {
      gid = `grp_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
      anchor.groupId = gid; anchor.groupActive = true;
      if (!anchor.groupName) { const pr = getProject(anchor.primaryProjectId); anchor.groupName = pr ? `${pr.name} · 组` : "故事点组"; }
    }
    if (previousGroupId === gid) {
      return { result: { ok: true, groupId: gid, inheritedConfig: false, movedFromGroupId: null, idempotent: true } };
    }
    tab.groupId = gid;
    tab.groupActive = false;
    tab.groupName = anchor.groupName || "故事点组";
    const source = groupConfigSource(visibleTabs, gid, anchor, tab.id);
    if (source) {
      copySharedConfig(source, tab, options);
      // 故事点组只执行一轮统一验收，新加入成员必须继承当前组的跳过选择；报告模式仍按 TB 单独立。
      tab.skipTestAcceptance = source.skipTestAcceptance === true;
    }
    if (previousGroupId && previousGroupId !== gid) reconcileGroup(visibleTabs, previousGroupId);
    reconcileGroup(visibleTabs, gid);
    return {
      tabs: visibleTabs,
      result: {
        ok: true,
        groupId: gid,
        inheritedConfig: !!source,
        movedFromGroupId: previousGroupId && previousGroupId !== gid ? previousGroupId : null,
      },
    };
  }, nodeIdSafe());
  return changed.result || { ok: false, error: "故事点组队失败" };
}
// 重命名组（更新组内所有成员的 groupName）
export function renameGroup(groupId, name) {
  const nm = String(name || "").trim().slice(0, 40);
  if (!groupId || !nm) return { ok: false, error: "组名不能为空" };
  const tabs = loadTabs();
  let n = 0;
  for (const t of tabs) { if (t.groupId === groupId) { t.groupName = nm; n++; } }
  if (n) saveTabs(tabs);
  return { ok: n > 0, name: nm };
}
// 组内切换当前活动故事点
export function setGroupActive(groupId, tabId, options = {}) {
  const changed = updateDevbenchStoryState(storageUserKey("tabs"), ({ tabs }) => {
    const visibleTabs = (Array.isArray(tabs) ? tabs : [])
      .filter((item) => !isTabPermanentlyDeleted(item?.id));
    const plan = groupActivePlanFromTabs(visibleTabs, groupId, tabId);
    if (!plan.ok) return { result: plan };
    if (options.expectedSourceToken
      && groupSourceChanged(options.expectedSourceToken, plan.token)) {
      return { result: { ok: false, statusCode: 409, code: "GROUP_SOURCE_CHANGED", error: "组内活动故事点或共享工程配置已变化，请刷新后重试" } };
    }
    if (plan.idempotent) return { result: { ok: true, inheritedConfig: false, idempotent: true } };
    let found = false;
    const { target, source } = plan;
    if (target && source) copySharedConfig(source, target, options);
    for (const tab of visibleTabs) {
      if (tab.groupId === groupId) {
        tab.groupActive = tab.id === tabId;
        if (tab.id === tabId) found = true;
      }
    }
    if (!found) return { result: { ok: false, error: "该故事点不在此组" } };
    return { tabs: visibleTabs, result: { ok: true, inheritedConfig: !!source } };
  }, nodeIdSafe());
  return changed.result || { ok: false, error: "切换活动故事点失败" };
}
// 退出组：若退出的是活动且组里还有人，自动把第一个设为活动；组内只剩 1 个则解散。
export function leaveGroup(tabId) {
  const tabs = loadTabs();
  const tab = tabs.find((t) => t.id === tabId);
  if (!tab || !tab.groupId) return { ok: true };
  const gid = tab.groupId;
  tab.groupId = null; tab.groupActive = false; tab.groupName = null;
  reconcileGroup(tabs, gid); // 剩余成员：补活动 / 只剩 1 个则解散
  saveTabs(tabs);
  return { ok: true };
}
// 在组里且不是当前活动 → 禁止与 AI 聊天（排队中）
export function isTabChatBlocked(tab) {
  return !!(tab && tab.groupId && tab.groupActive === false);
}

// ========== 待办任务列表（todoist 风格）==========

function loadTasks() { migrateDeadlinesIfNeeded(); return loadKind("tasks", TASKS_FILE); }
function saveTasks(tasks) { saveKind("tasks", tasks); }
function loadTaskGroups() { return loadKind("taskGroups", TASK_GROUPS_FILE); }
function saveTaskGroups(groups) { saveKind("taskGroups", normalizeTaskGroups(groups)); }

export function listTasks() {
  return loadTasks();
}

function cleanTaskGroup(raw = {}) {
  const name = String(raw.name || raw.taskGroupName || raw.groupName || "").trim().slice(0, 60);
  if (!name) return null;
  const id = normTaskGroupId(raw.id || raw.taskGroupId || raw.groupId) || newTaskGroupId();
  const now = Date.now();
  return {
    id,
    name,
    createdAt: Number(raw.createdAt) || now,
    updatedAt: Number(raw.updatedAt) || Number(raw.createdAt) || now,
  };
}

function normalizeTaskGroups(groups = []) {
  const byId = new Map();
  for (const raw of Array.isArray(groups) ? groups : []) {
    const g = cleanTaskGroup(raw);
    if (!g) continue;
    const prev = byId.get(g.id);
    byId.set(g.id, prev ? { ...prev, ...g, createdAt: prev.createdAt || g.createdAt } : g);
  }
  return [...byId.values()].sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0) || a.name.localeCompare(b.name, "zh-CN"));
}

function ensureTaskGroupStored(groupLike) {
  const group = cleanTaskGroup(groupLike);
  if (!group) return null;
  const groups = loadTaskGroups();
  const idx = groups.findIndex((g) => String(g.id) === group.id);
  const now = Date.now();
  if (idx >= 0) {
    groups[idx] = { ...groups[idx], name: group.name, updatedAt: now };
  } else {
    groups.push({ ...group, createdAt: group.createdAt || now, updatedAt: now });
  }
  saveTaskGroups(groups);
  return { id: group.id, name: group.name };
}

export function listTaskGroups() {
  const groups = normalizeTaskGroups(loadTaskGroups());
  saveKind("taskGroups", groups);
  return groups;
}

export function createTaskGroup(input = {}) {
  const group = cleanTaskGroup(input);
  if (!group) return { ok: false, error: "任务组名称不能为空" };
  const groups = loadTaskGroups();
  const exists = groups.find((g) => String(g.id) === group.id || String(g.name || "").trim().toLowerCase() === group.name.toLowerCase());
  if (exists) {
    const next = { ...exists, name: group.name, updatedAt: Date.now() };
    const idx = groups.findIndex((g) => String(g.id) === String(exists.id));
    groups[idx] = next;
    saveTaskGroups(groups);
    return { ok: true, group: next, existing: true };
  }
  groups.push(group);
  saveTaskGroups(groups);
  return { ok: true, group };
}

export function updateTaskGroup(id, updates = {}) {
  const gid = normTaskGroupId(id);
  if (!gid) return { ok: false, error: "任务组 ID 不正确" };
  const name = String(updates.name || updates.taskGroupName || updates.groupName || "").trim().slice(0, 60);
  if (!name) return { ok: false, error: "任务组名称不能为空" };
  const groups = loadTaskGroups();
  const idx = groups.findIndex((g) => String(g.id) === gid);
  const now = Date.now();
  const group = idx >= 0
    ? { ...groups[idx], name, updatedAt: now }
    : { id: gid, name, createdAt: now, updatedAt: now };
  if (idx >= 0) groups[idx] = group; else groups.push(group);
  saveTaskGroups(groups);

  const tasks = loadTasks();
  let changed = false;
  for (const t of tasks) {
    if (String(t.taskGroupId || "") === gid && t.taskGroupName !== name) {
      t.taskGroupName = name;
      changed = true;
    }
  }
  if (changed) saveTasks(tasks);
  return { ok: true, group, updatedTasks: changed };
}

export function deleteTaskGroup(id, { clearTasks = true } = {}) {
  const gid = normTaskGroupId(id);
  if (!gid) return { ok: false, error: "任务组 ID 不正确" };
  const groups = loadTaskGroups();
  const nextGroups = groups.filter((g) => String(g.id) !== gid);
  saveTaskGroups(nextGroups);
  let cleared = 0;
  if (clearTasks) {
    const tasks = loadTasks();
    for (const t of tasks) {
      if (String(t.taskGroupId || "") === gid) {
        delete t.taskGroupId;
        delete t.taskGroupName;
        cleared++;
      }
    }
    if (cleared) saveTasks(tasks);
  }
  return { ok: true, removed: groups.length - nextGroups.length, cleared };
}

// ========== 导入/导出（工程配置 + 任务列表，跨机/跨端同步）==========

/**
 * 仅导出应用市场工程配置（不含任务）。
 */
export function exportProjects() {
  const projects = loadLocalProjects().map((p) => ({
    id: p.id, name: p.name, path: p.path,
  }));
  return {
    type: "devbench-projects",
    version: 4,
    exportedAt: new Date().toISOString(),
    cloneParent: getLocalCloneParent(),
    applications: getProjectApplications(),
    projects,
  };
}

/**
 * 导出工程配置 + 任务列表为一个可保存/分享的 JSON 包。
 */
export function exportData() {
  const projects = loadLocalProjects().map((p) => ({
    id: p.id, name: p.name, path: p.path,
  }));
  return {
    type: "devbench-sync",
    version: 2,
    exportedAt: new Date().toISOString(),
    applications: getProjectApplications(),
    projects,
    taskGroups: listTaskGroups(),
    tasks: loadTasks(),
  };
}

/**
 * 导入工程配置 + 任务列表。
 * mode: "merge"(默认，按 key 增量合并) | "replace"(整表替换)。
 * 工程按 id 或路径去重；任务按 tbTaskId / ticketUrl / id 去重。
 * 返回 { ok, mode, projects:{added,updated}, tasks:{added,updated} }。
 */
export function importData(data, opts = {}) {
  const mode = opts.mode === "replace" ? "replace" : "merge";
  if (!data || typeof data !== "object") return { ok: false, error: "导入数据格式不正确" };
  const hasProjects = Array.isArray(data.projects);
  const hasApplications = Array.isArray(data.applications);
  const hasTasks = Array.isArray(data.tasks);
  const hasTaskGroups = Array.isArray(data.taskGroups);
  const hasCloneParent = Object.prototype.hasOwnProperty.call(data, "cloneParent");
  const inProjects = hasProjects ? cleanLocalProjects(data.projects) : [];
  const inTasks = hasTasks ? data.tasks : [];
  const inTaskGroups = hasTaskGroups ? data.taskGroups : [];
  if (!hasProjects && !hasApplications && !hasTasks && !hasTaskGroups && !hasCloneParent) return { ok: false, error: "导入文件里没有应用、工程、克隆父路径、任务组或任务数据" };

  const result = {
    ok: true,
    mode,
    projects: { added: 0, updated: 0 },
    cloneParent: { restored: hasCloneParent, value: getLocalCloneParent() },
    taskGroups: { added: 0, updated: 0 },
    tasks: { added: 0, updated: 0 },
  };
  const importedProjectIdMap = new Map();

  // ---- 工程 ----
  const cleanProj = (p) => ({
    id: String(p.id || genId(p.name || "proj")),
    name: String(p.name || p.id || "工程").trim(),
    path: String(p.path || "").trim(),
  });
  let projects = loadLocalProjects();
  if (hasProjects) {
    if (mode === "replace") {
      projects = inProjects.filter((p) => p && (p.path || p.name)).map(cleanProj);
      for (const project of projects) importedProjectIdMap.set(project.id, project.id);
      result.projects.added = projects.length;
    } else {
      const byId = new Map(projects.map((p) => [p.id, p]));
      const byPath = new Map(projects.map((p) => [normPath(p.path), p]));
      for (const raw of inProjects) {
        if (!raw || !(raw.path || raw.name)) continue;
        const p = cleanProj(raw);
        const existing = byId.get(p.id) || byPath.get(normPath(p.path));
        if (existing) {
          existing.name = p.name; existing.path = p.path;
          importedProjectIdMap.set(p.id, existing.id);
          result.projects.updated++;
        } else {
          projects.push(p); byId.set(p.id, p); byPath.set(normPath(p.path), p);
          importedProjectIdMap.set(p.id, p.id);
          result.projects.added++;
        }
      }
    }
  }
  let projectApplications;
  if (hasApplications) {
    const incoming = cleanProjectApplications(data.applications, inProjects).map((application) => ({
      ...application,
      repositories: application.repositories.map((repository) => ({
        ...repository,
        projectIds: repository.projectIds
          .map((projectId) => importedProjectIdMap.get(projectId) || projectId)
          .filter((projectId) => projects.some((project) => project.id === projectId)),
      })),
    }));
    if (mode === "replace") {
      projectApplications = incoming;
    } else {
      const merged = getProjectApplications().map((application) => cloneJson(application));
      for (const application of incoming) {
        const existing = merged.find((candidate) => candidate.id === application.id)
          || merged.find((candidate) => candidate.name.toLowerCase() === application.name.toLowerCase());
        if (!existing) {
          merged.push(application);
          continue;
        }
        for (const repository of application.repositories) {
          const target = existing.repositories.find((candidate) => candidate.repositoryId === repository.repositoryId);
          if (target) target.projectIds = [...new Set([...target.projectIds, ...repository.projectIds])];
          else existing.repositories.push(repository);
        }
      }
      projectApplications = merged;
    }
  } else if (mode === "replace" && hasProjects) {
    projectApplications = [];
  }
  saveLocalProjects(projects, {
    cloneParent: hasCloneParent ? String(data.cloneParent || "").trim() : undefined,
    projectApplications,
  });
  result.cloneParent.value = getLocalCloneParent();

  // ---- 任务组 ----
  let taskGroups = loadTaskGroups();
  if (hasTaskGroups) {
    if (mode === "replace") {
      taskGroups = normalizeTaskGroups(inTaskGroups);
      result.taskGroups.added = taskGroups.length;
    } else {
      const byId = new Map(taskGroups.map((g) => [String(g.id), g]));
      const byName = new Map(taskGroups.map((g) => [String(g.name || "").trim().toLowerCase(), g]));
      for (const raw of inTaskGroups) {
        const group = cleanTaskGroup(raw);
        if (!group) continue;
        const existing = byId.get(group.id) || byName.get(group.name.toLowerCase());
        if (existing) {
          existing.name = group.name;
          existing.updatedAt = Date.now();
          result.taskGroups.updated++;
        } else {
          taskGroups.push(group);
          byId.set(group.id, group);
          byName.set(group.name.toLowerCase(), group);
          result.taskGroups.added++;
        }
      }
    }
    saveTaskGroups(taskGroups);
  }

  // ---- 任务 ----
  const keyOf = (t) => t.tbTaskId ? `tb:${t.tbTaskId}` : (t.ticketUrl ? `url:${String(t.ticketUrl).trim()}` : (t.id ? `id:${t.id}` : null));
  let tasks = loadTasks();
  if (hasTasks) {
    if (mode === "replace") {
      tasks = inTasks.filter((t) => t && t.title).map((t) => ({ ...t, id: t.id || newTaskId() }));
      result.tasks.added = tasks.length;
    } else {
      const byKey = new Map();
      for (const t of tasks) { const k = keyOf(t); if (k) byKey.set(k, t); }
      for (const raw of inTasks) {
        if (!raw || !raw.title) continue;
        const k = keyOf(raw);
        const existing = k ? byKey.get(k) : null;
        if (existing) {
          // incoming 覆盖各字段，但保留本地 id 与「已完成」状态（避免同步把完成的任务改回未完成）
          Object.assign(existing, raw, { id: existing.id, done: existing.done || !!raw.done });
          result.tasks.updated++;
        } else {
          const nt = { ...raw, id: raw.id || newTaskId() };
          tasks.push(nt);
          if (k) byKey.set(k, nt);
          result.tasks.added++;
        }
      }
    }
    saveTasks(tasks);
  }

  return result;
}

function newTaskId() {
  return `task_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function newTaskGroupId() {
  return `task_group_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function normTaskGroupId(v) {
  const s = String(v || "").trim();
  return /^[A-Za-z0-9_-]{1,80}$/.test(s) ? s : null;
}

function normTaskGroup(v = {}) {
  const name = String(v.taskGroupName || v.groupName || "").trim().slice(0, 60);
  if (!name) return { taskGroupId: null, taskGroupName: null };
  return {
    taskGroupId: normTaskGroupId(v.taskGroupId || v.groupId) || newTaskGroupId(),
    taskGroupName: name,
  };
}

function normCustomTags(v) {
  const raw = Array.isArray(v)
    ? v
    : String(v || "").split(/[,\n，、;；]+/);
  const out = [];
  const seen = new Set();
  for (const item of raw) {
    const tag = String(item || "").trim().replace(/\s+/g, " ").slice(0, 18);
    const key = tag.toLowerCase();
    if (!tag || seen.has(key)) continue;
    seen.add(key);
    out.push(tag);
    if (out.length >= 8) break;
  }
  return out;
}

function normPriority(p) {
  if (typeof p === "number" && Number.isFinite(p)) {
    const map = ["P0", "P1", "P2", "P3"];
    return map[Math.max(0, Math.min(3, Math.trunc(p)))] || null;
  }
  const s = String(p || "").trim().toUpperCase();
  if (/^\d$/.test(s)) return normPriority(Number(s));
  if (/^(URGENT|CRITICAL|HIGH|紧急|最高|高)$/.test(s)) return "P0";
  if (/^(NORMAL|MEDIUM|普通|中)$/.test(s)) return "P1";
  if (/^(LOW|较低|低)$/.test(s)) return "P2";
  return /^P[0-3]$/.test(s) ? s : null;
}

// 把"下周一/今天/3月5日/N天后"等相对日期词，按录入时为基准换算成绝对日期 YYYY-MM-DD（就地替换）。
// 这样存的是确定日期，过了那天会显示成过去的日期，而不是永远停在"下周一"。
function resolveDeadlineText(raw, base = new Date()) {
  if (!raw) return raw;
  let s = String(raw);
  const pad = (n) => String(n).padStart(2, "0");
  const today = new Date(base.getFullYear(), base.getMonth(), base.getDate());
  const fmt = (dt) => `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}`;
  const addDays = (dt, n) => { const x = new Date(dt.getFullYear(), dt.getMonth(), dt.getDate()); x.setDate(x.getDate() + n); return x; };
  const wmap = { "一": 1, "二": 2, "三": 3, "四": 4, "五": 5, "六": 6, "日": 0, "天": 0, "1": 1, "2": 2, "3": 3, "4": 4, "5": 5, "6": 6, "7": 0 };
  // 以周一为一周起点：weekOffset=null 裸"周X"(本周该天，过了取下周)；0 本周；1 下周；2 下下周…
  const weekdayDate = (dow, weekOffset) => {
    const curIso = today.getDay() === 0 ? 7 : today.getDay();
    const tgtIso = dow === 0 ? 7 : dow;
    let diff = tgtIso - curIso;
    if (weekOffset === null) { if (diff < 0) diff += 7; } else diff += 7 * weekOffset;
    return addDays(today, diff);
  };
  // 今天/明天/后天/大后天
  for (const [w, n] of [["大后天", 3], ["后天", 2], ["明天", 1], ["明日", 1], ["今天", 0], ["今日", 0]]) {
    if (s.includes(w)) s = s.split(w).join(fmt(addDays(today, n)));
  }
  // 下(下)周X / 本周X / 这周X / 周X / 星期X / 礼拜X
  s = s.replace(/(下+周|下+个?星期|下+个?礼拜|本周|这周|本星期|这星期|周|星期|礼拜)\s*([一二三四五六日天1-7])/g, (mm, prefix, dch) => {
    const dow = wmap[dch]; if (dow === undefined) return mm;
    const downCount = (prefix.match(/下/g) || []).length;
    const weekOffset = downCount > 0 ? downCount : (/^(本|这)/.test(prefix) ? 0 : null);
    return fmt(weekdayDate(dow, weekOffset));
  });
  // X月X日/号（已过则算明年）
  s = s.replace(/(\d{1,2})\s*月\s*(\d{1,2})\s*[日号]?/g, (mm, mo, da) => {
    const cand = new Date(today.getFullYear(), Number(mo) - 1, Number(da));
    if (cand < today) cand.setFullYear(today.getFullYear() + 1);
    return fmt(cand);
  });
  // N天后/N天内
  s = s.replace(/(\d{1,3})\s*天\s*[后内]/g, (mm, n) => fmt(addDays(today, Number(n))));
  return s;
}
function normDeadline(v) {
  if (!v) return null;
  const r = resolveDeadlineText(String(v).trim());
  return r ? r.slice(0, 60) : null;
}

// 新建单个任务
export function createTask({ title, ticketUrl, priority, deadline, taskGroupId, taskGroupName, groupId, groupName, pinned, starred, customTags, tags } = {}) {
  const t = String(title || "").trim();
  if (!t) return { ok: false, error: "任务标题不能为空" };
  const tasks = loadTasks();
  const group = normTaskGroup({ taskGroupId, taskGroupName, groupId, groupName });
  const storedGroup = ensureTaskGroupStored(group);
  const labelTags = normCustomTags(customTags ?? tags);
  const task = {
    id: newTaskId(),
    title: t.slice(0, 200),
    ticketUrl: ticketUrl ? String(ticketUrl).trim() : null,
    priority: normPriority(priority),
    deadline: normDeadline(deadline),
    ...(storedGroup ? { taskGroupId: storedGroup.id, taskGroupName: storedGroup.name } : {}),
    ...(pinned ? { pinned: true } : {}),
    ...(starred ? { starred: true } : {}),
    ...(labelTags.length ? { customTags: labelTags } : {}),
    done: false,
    createdAt: Date.now(),
    completedAt: null,
  };
  tasks.push(task);
  saveTasks(tasks);
  return { ok: true, task };
}

/**
 * 把一个 TB 单加入任务列表（待办，staged=false）。已存在则把暂存的移入待办。
 * { tbTaskId, carbId, title, ticketUrl }
 */
export function addTbTaskToList({ tbTaskId, carbId, title, ticketUrl } = {}) {
  if (!tbTaskId) return { ok: false, error: "缺少 tbTaskId" };
  const tasks = loadTasks();
  const exist = tasks.find((t) => t.tbTaskId === tbTaskId);
  if (exist) {
    let changed = false;
    if (exist.staged) { exist.staged = false; changed = true; } // 从「TB工单」候选区移入待办
    if (carbId && !exist.carbId) { exist.carbId = carbId; changed = true; }
    if (ticketUrl && !exist.ticketUrl) { exist.ticketUrl = ticketUrl; changed = true; }
    if (changed) saveTasks(tasks);
    return { ok: true, task: exist, already: true };
  }
  const task = {
    id: newTaskId(),
    title: String(title || carbId || tbTaskId).trim().slice(0, 200),
    ticketUrl: ticketUrl ? String(ticketUrl).trim() : null,
    tbTaskId,
    carbId: carbId || null,
    priority: null,
    deadline: null,
    staged: false,
    done: false,
    createdAt: Date.now(),
    completedAt: null,
  };
  tasks.push(task);
  saveTasks(tasks);
  return { ok: true, task };
}

/**
 * 智能解析批量任务文本，支持如下格式：
 *   P0：                         ← 优先级分组头（半/全角冒号，或单独的 P0）
 *   1、阿维塔性能优化              ← 序号前缀自动去除，归入当前优先级
 *   2、xxx（今天给）              ← 行尾括号内容抽取为 deadline
 * 返回 [{ title, priority, deadline }]。
 */
export function parseBatchTasks(text) {
  const out = [];
  let priority = null;
  for (const raw of String(text || "").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    // 优先级分组头：必须带冒号（P0：/P0:），或整行恰为 P0，避免误判 "P155..." 这类标题
    const hm = line.match(/^(P[0-3])\s*[:：]\s*(.*)$/i) || (/^P[0-3]$/i.test(line) ? [line, line, ""] : null);
    if (hm) {
      priority = hm[1].toUpperCase();
      const rest = (hm[2] || "").trim();
      if (rest) out.push(makeBatchItem(rest, priority));
      continue;
    }
    out.push(makeBatchItem(line, priority));
  }
  return out.filter((x) => x.title);
}

function makeBatchItem(line, priority) {
  let s = String(line).trim();
  // 去掉行首序号：1、 2. 3) 等
  s = s.replace(/^\s*\d+\s*[、.,，)）：:]\s*/, "");
  // 抽取行尾括号里的期限：（今天给）(下周一完成)
  let deadline = null;
  const dm = s.match(/[（(]\s*([^（）()]*?)\s*[)）]\s*$/);
  if (dm) { deadline = normDeadline(dm[1].trim()); s = s.slice(0, dm.index).trim(); }
  return { title: s.trim(), priority: priority || null, deadline };
}

// 批量新建：items 可为字符串数组，或 [{ title, priority, deadline }]
export function createTasksBatch(items = []) {
  const list = (Array.isArray(items) ? items : [])
    .map((it) => (typeof it === "string" ? { title: it } : it))
    .map((it) => {
      const group = normTaskGroup(it || {});
      const storedGroup = ensureTaskGroupStored(group);
      const labelTags = normCustomTags(it?.customTags ?? it?.tags);
      return {
        title: String(it?.title || "").trim(),
        priority: normPriority(it?.priority),
        deadline: normDeadline(it?.deadline),
        ...(storedGroup ? { taskGroupId: storedGroup.id, taskGroupName: storedGroup.name } : {}),
        ...(it?.pinned ? { pinned: true } : {}),
        ...(it?.starred ? { starred: true } : {}),
        ...(labelTags.length ? { customTags: labelTags } : {}),
      };
    })
    .filter((it) => it.title);
  if (!list.length) return { ok: false, error: "没有可新增的任务" };
  const tasks = loadTasks();
  const base = Date.now();
  const created = list.map((it, i) => ({
    id: `task_${base}_${i}_${Math.random().toString(36).slice(2, 6)}`,
    title: it.title.slice(0, 200),
    ticketUrl: null,
    priority: it.priority,
    deadline: it.deadline,
    ...(it.taskGroupName ? { taskGroupId: it.taskGroupId, taskGroupName: it.taskGroupName } : {}),
    ...(it.pinned ? { pinned: true } : {}),
    ...(it.starred ? { starred: true } : {}),
    ...(it.customTags?.length ? { customTags: it.customTags } : {}),
    done: false,
    createdAt: base + i, // +i 保证顺序稳定
    completedAt: null,
  }));
  tasks.push(...created);
  saveTasks(tasks);
  return { ok: true, tasks: created };
}

// 更新任务（标题/工单地址/完成状态）。done 变化时维护 completedAt。
export function updateTask(id, updates = {}) {
  const tasks = loadTasks();
  const idx = tasks.findIndex((t) => t.id === id);
  if (idx < 0) return { ok: false, error: "任务不存在" };
  const cur = tasks[idx];
  const next = { ...cur };
  if (typeof updates.title === "string") {
    const t = updates.title.trim();
    if (!t) return { ok: false, error: "任务标题不能为空" };
    next.title = t.slice(0, 200);
  }
  if ("ticketUrl" in updates) {
    let url = String(updates.ticketUrl || "").trim();
    if (url && !/^https?:\/\//i.test(url)) url = "https://" + url;
    next.ticketUrl = url || null;
  }
  if ("priority" in updates) next.priority = normPriority(updates.priority);
  if ("deadline" in updates) next.deadline = normDeadline(updates.deadline);
  if ("pinned" in updates) {
    if (updates.pinned) next.pinned = true;
    else delete next.pinned;
  }
  if ("starred" in updates) {
    if (updates.starred) next.starred = true;
    else delete next.starred;
  }
  if ("customTags" in updates || "tags" in updates) {
    const labelTags = normCustomTags(updates.customTags ?? updates.tags);
    if (labelTags.length) next.customTags = labelTags;
    else delete next.customTags;
  }
  if ("taskGroupName" in updates || "taskGroupId" in updates || "groupName" in updates || "groupId" in updates) {
    const group = normTaskGroup({
      taskGroupId: updates.taskGroupId ?? next.taskGroupId,
      taskGroupName: updates.taskGroupName ?? updates.groupName ?? next.taskGroupName,
      groupId: updates.groupId,
    });
    const storedGroup = ensureTaskGroupStored(group);
    if (storedGroup) {
      next.taskGroupId = storedGroup.id;
      next.taskGroupName = storedGroup.name;
    } else {
      delete next.taskGroupId;
      delete next.taskGroupName;
    }
  }
  // staged：同步进来的 TB 单暂存在「TB工单」区（staged=true）；点「添加到任务列表」置为 false 移入待办
  if ("staged" in updates) next.staged = !!updates.staged;
  if ("tabId" in updates) next.tabId = updates.tabId || null; // 代办任务↔故事点一对一绑定
  if (typeof updates.done === "boolean" && updates.done !== cur.done) {
    next.done = updates.done;
    next.completedAt = updates.done ? Date.now() : null;
  }
  tasks[idx] = next;
  saveTasks(tasks);
  return { ok: true, task: next };
}

export function deleteTask(id) {
  const tasks = loadTasks();
  const next = tasks.filter((t) => t.id !== id);
  saveTasks(next);
  return { ok: true, removed: tasks.length - next.length };
}

/**
 * 导入/更新来自 Teambition 的工单（按 tbTaskId 去重）。
 * items: [{ tbTaskId, title, ticketUrl, statusName, deadline }]
 * 已存在 → 更新标题/工单地址/TB状态/期限（不动用户的完成状态与 staged 标记）；
 * 不存在 → 新建并标记 staged=true（暂存到「TB工单」区，由用户挑选「添加到任务列表」）。
 */
export function importTbTasks(items = []) {
  const list = Array.isArray(items) ? items : [];
  const tasks = loadTasks();
  const byTb = new Map(tasks.filter((t) => t.tbTaskId).map((t) => [t.tbTaskId, t]));
  let added = 0, updated = 0;
  const base = Date.now();
  list.forEach((it, i) => {
    const title = String(it?.title || "").trim();
    if (!it?.tbTaskId || !title) return;
    const existing = byTb.get(it.tbTaskId);
    if (existing) {
      existing.title = title.slice(0, 200);
      if (it.ticketUrl) existing.ticketUrl = it.ticketUrl;
      if (it.carbId) existing.carbId = it.carbId;
      existing.tbStatus = it.statusName || existing.tbStatus || null;
      if (it.deadline) existing.deadline = it.deadline;
      if ("priority" in it) existing.priority = normPriority(it.priority);
      // 迭代信息（重新同步时刷新）
      if (it.sprintId !== undefined) existing.sprintId = it.sprintId || existing.sprintId || null;
      if (it.sprintName) existing.sprintName = it.sprintName;
      if (it.sprintDueDate) existing.sprintDueDate = it.sprintDueDate;
      if (it.sprintStatus !== undefined) existing.sprintStatus = it.sprintStatus || null;
      if (it.projectId) existing.projectId = it.projectId;
      if (it.projectName) existing.projectName = it.projectName;
      if (it.tasklistId) existing.tasklistId = it.tasklistId;
      if (it.tasklistName) existing.tasklistName = it.tasklistName;
      updated++;
    } else {
      tasks.push({
        id: `task_${base}_${i}_${Math.random().toString(36).slice(2, 6)}`,
        title: title.slice(0, 200),
        ticketUrl: it.ticketUrl || null,
        priority: normPriority(it.priority),
        deadline: it.deadline || null,
        tbTaskId: it.tbTaskId,
        carbId: it.carbId || null,
        tbStatus: it.statusName || null,
        sprintId: it.sprintId || null,
        sprintName: it.sprintName || null,
        sprintDueDate: it.sprintDueDate || null,
        sprintStatus: it.sprintStatus || null,
        projectId: it.projectId || null,
        projectName: it.projectName || null,
        tasklistId: it.tasklistId || null,
        tasklistName: it.tasklistName || null,
        staged: true, // 暂存到「TB工单」区，不直接进待办
        done: false,
        createdAt: base + i,
        completedAt: null,
      });
      added++;
    }
  });
  saveTasks(tasks);
  return { ok: true, added, updated };
}

// ========== 设备模拟预设（wm size / density）==========

// 规范化分辨率字符串：去空格、统一小写 x，校验为 "<宽>x<高>"。返回字符串或 null。
function normSize(s) {
  const m = String(s || "").trim().toLowerCase().replace(/\s+/g, "").match(/^(\d{2,5})[x×*](\d{2,5})$/);
  return m ? `${parseInt(m[1], 10)}x${parseInt(m[2], 10)}` : null;
}

// 规范化 density：正整数（80~960 合理范围）。返回数字或 null。
function normDensity(d) {
  const n = parseInt(String(d || "").trim(), 10);
  return Number.isInteger(n) && n >= 80 && n <= 960 ? n : null;
}

function loadMockDevices() {
  ensureDir();
  try {
    if (!fs.existsSync(MOCK_DEVICES_FILE)) {
      // 首次使用：种入一个示例预设，便于用户照葫芦画瓢
      // 注意 size 是传给 `wm size` 的实参，按设备「自然方向」顺序填。
      // avatar-8155 面板自然方向为竖屏，标称横屏 2560×1440 → wm size 实参为 1440×2560。
      const seed = [{
        id: `mock_${Date.now()}_seed`,
        name: "avatar-8155",
        density: 160,
        size: "1440x2560",
        createdAt: Date.now(),
      }];
      fs.writeFileSync(MOCK_DEVICES_FILE, JSON.stringify(seed, null, 2), "utf-8");
      return seed;
    }
    const arr = JSON.parse(fs.readFileSync(MOCK_DEVICES_FILE, "utf-8"));
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

function saveMockDevices(list) {
  ensureDir();
  fs.writeFileSync(MOCK_DEVICES_FILE, JSON.stringify(list, null, 2), "utf-8");
}

export function listMockDevices() {
  return loadMockDevices();
}

// 新增一个设备模拟预设。{ name, density, size }
export function addMockDevice({ name, density, size } = {}) {
  const nm = String(name || "").trim();
  if (!nm) return { ok: false, error: "设备名不能为空" };
  const den = normDensity(density);
  if (den == null) return { ok: false, error: "density 需为 80~960 的整数" };
  const sz = normSize(size);
  if (!sz) return { ok: false, error: "wm size 格式需为 宽x高（如 2560x1440）" };
  const list = loadMockDevices();
  if (list.some((d) => d.name.toLowerCase() === nm.toLowerCase())) {
    return { ok: false, error: `设备名「${nm}」已存在` };
  }
  const device = {
    id: `mock_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    name: nm.slice(0, 60),
    density: den,
    size: sz,
    createdAt: Date.now(),
  };
  list.push(device);
  saveMockDevices(list);
  return { ok: true, device };
}

export function deleteMockDevice(id) {
  const list = loadMockDevices();
  const next = list.filter((d) => d.id !== id);
  saveMockDevices(next);
  return { ok: true, removed: list.length - next.length };
}

// ========== 消息历史（每 tab 一个文件，供 UI 重载）==========

function msgFile(tabId) {
  return path.join(STORE_DIR, `msg-${tabId}.json`);
}

function conversationFile(tabId) {
  return `${msgFile(tabId)}.conversation-v2.json`;
}

function writeJsonAtomic(filePath, value) {
  const tempPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  try {
    fs.writeFileSync(tempPath, JSON.stringify(value, null, 2), "utf-8");
    fs.renameSync(tempPath, filePath);
  } catch (error) {
    try { fs.rmSync(tempPath, { force: true }); } catch {}
    throw error;
  }
}

function writeConversationFilesAtomic(tabId, conversation, messages) {
  const token = `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const entries = [
    { target: conversationFile(tabId), value: conversation },
    { target: msgFile(tabId), value: messages },
  ].map((entry) => ({
    ...entry,
    temp: `${entry.target}.tmp-${token}`,
    backup: `${entry.target}.bak-${token}`,
    hadOriginal: fs.existsSync(entry.target),
    installed: false,
  }));
  try {
    for (const entry of entries) {
      fs.writeFileSync(entry.temp, JSON.stringify(entry.value, null, 2), "utf-8");
    }
    for (const entry of entries) {
      if (entry.hadOriginal) fs.renameSync(entry.target, entry.backup);
    }
    for (const entry of entries) {
      fs.renameSync(entry.temp, entry.target);
      entry.installed = true;
    }
    for (const entry of entries) {
      if (entry.hadOriginal) fs.rmSync(entry.backup, { force: true });
    }
  } catch (error) {
    for (const entry of entries) {
      try { fs.rmSync(entry.temp, { force: true }); } catch {}
      if (entry.installed) {
        try { fs.rmSync(entry.target, { force: true }); } catch {}
      }
    }
    for (const entry of entries) {
      if (entry.hadOriginal && fs.existsSync(entry.backup)) {
        try { fs.renameSync(entry.backup, entry.target); } catch {}
      }
    }
    throw error;
  } finally {
    for (const entry of entries) {
      try { fs.rmSync(entry.temp, { force: true }); } catch {}
      if (fs.existsSync(entry.target)) {
        try { fs.rmSync(entry.backup, { force: true }); } catch {}
      }
    }
  }
}

// ========== 对话大文件 read 缓存 + transcript 截断 ==========
// 背景：MiniMax-M3 等长思考模型单轮 transcript 可达数 MB（实测 16341 条/7.5MB），
// msg/conversation 文件随对话膨胀到几十 MB（实测 27MB+28MB）。旧实现每次消息变更都
// 同步全量读+写两个文件（写盘还带 tmp/backup 副本），冻结 gateway 事件循环，导致
// Service Control /api/health 2.5s 超时（HTTP 500 / “HTTP health check is temporarily
// unavailable for gateway; owned processes are still running.”）。修复：
// 1) transcript 截断：超长运行轨迹按“保头 + 保尾 + 省略标记”压缩后再入内存与落盘，
//    实测 27.3MB conversation 压缩后约 633KB，同步读写从秒级降到毫秒级，事件循环不再被冻结；
// 2) 读缓存：以文件 mtimeMs:size 为 key，命中直接返回内存解析结果（跨进程共享时
//    文件变化会因 statKey 失配而自动重读）。

const TRANSCRIPT_HEAD_KEEP = 60;
const TRANSCRIPT_TAIL_KEEP = 340;
const TRANSCRIPT_ITEM_CONTENT_MAX = 1000;

function compactTranscriptItem(item) {
  if (!item || typeof item !== "object" || Array.isArray(item)) return item;
  if (typeof item.content !== "string" || item.content.length <= TRANSCRIPT_ITEM_CONTENT_MAX) return item;
  return { ...item, content: `${item.content.slice(0, TRANSCRIPT_ITEM_CONTENT_MAX)}…(截断)` };
}

// 压缩单条 transcript：条数超限时保头 + 保尾 + 中间省略标记；
// 条数不超限时只裁剪单条超长 content；无任何变化时返回原数组引用（供调用方判断是否截断）。
function compactTranscriptList(transcript) {
  if (!Array.isArray(transcript) || transcript.length === 0) return transcript;
  const total = transcript.length;
  if (total <= TRANSCRIPT_HEAD_KEEP + TRANSCRIPT_TAIL_KEEP) {
    let changed = false;
    const items = transcript.map((item) => {
      const next = compactTranscriptItem(item);
      if (next !== item) changed = true;
      return next;
    });
    return changed ? items : transcript;
  }
  const head = transcript.slice(0, TRANSCRIPT_HEAD_KEEP).map((item) => compactTranscriptItem(item));
  const tail = transcript.slice(-TRANSCRIPT_TAIL_KEEP).map((item) => compactTranscriptItem(item));
  const middleNote = {
    type: "note",
    content: `…已省略 ${total - head.length - tail.length} 条运行轨迹（原共 ${total} 条），仅保留首尾关键轨迹…`,
    ts: null,
  };
  return [...head, middleNote, ...tail];
}

// 对对话图所有节点做 transcript 压缩；条数被压缩的节点补 transcriptTruncated/transcriptTotal 标记。
// 截断判定以「是否生成了中间省略标记（note）」为准：保头+保尾恰好覆盖全部条数时不标记。
function compactConversationTranscripts(conversation) {
  const nodes = conversation?.nodes;
  if (!Array.isArray(nodes)) return conversation;
  let changed = false;
  const nextNodes = nodes.map((node) => {
    if (!Array.isArray(node?.transcript) || node.transcript.length === 0) return node;
    const total = node.transcript.length;
    const compacted = compactTranscriptList(node.transcript);
    if (compacted === node.transcript) return node;
    changed = true;
    const truncated = Array.isArray(compacted) && compacted.some((item) => item?.type === "note");
    return {
      ...node,
      transcript: compacted,
      ...(truncated ? { transcriptTruncated: true, transcriptTotal: total } : {}),
    };
  });
  return changed ? { ...conversation, nodes: nextNodes } : conversation;
}

function statKeyOf(filePath) {
  try {
    const stat = fs.statSync(filePath);
    return `${stat.mtimeMs}|${stat.size}`;
  } catch {
    return "";
  }
}

const conversationReadCache = new Map(); // tabId -> { statKey, source, value }

function updateConversationCache(tabId, value, source = "conversation") {
  conversationReadCache.set(tabId, {
    statKey: statKeyOf(conversationFile(tabId)),
    source,
    value,
  });
}

function liveFile(tabId) {
  return path.join(STORE_DIR, `live-${tabId}.json`);
}

function cloneMessageMetadata(value, fallback = {}) {
  try {
    const cloned = JSON.parse(JSON.stringify(value));
    return cloned && typeof cloned === "object" && !Array.isArray(cloned) ? cloned : fallback;
  } catch {
    return fallback;
  }
}

function normalizeAiSnapshot(snapshot, fallbackEngine = "", fallbackTs = Date.now()) {
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) return null;
  return {
    ...cloneMessageMetadata(snapshot),
    engine: String(snapshot.engine || fallbackEngine || "").trim(),
    model: String(snapshot.model || "").trim(),
    tier: String(snapshot.tier || "").trim(),
    capturedAt: Number(snapshot.capturedAt) || Number(fallbackTs) || Date.now(),
  };
}

function normalizeActualAi(actual, fallbackEngine = "", fallbackTs = Date.now()) {
  if (!actual || typeof actual !== "object" || Array.isArray(actual)) return null;
  return {
    ...cloneMessageMetadata(actual),
    engine: String(actual.engine || fallbackEngine || "").trim(),
    provider: String(actual.provider || actual.engine || fallbackEngine || "").trim(),
    model: String(actual.model || "").trim(),
    providerLevel: String(actual.providerLevel || actual.providerReasoningLevel || "").trim(),
    providerReasoningLevel: String(actual.providerReasoningLevel || actual.providerLevel || "").trim(),
    reasoningEffort: String(actual.reasoningEffort || "").trim(),
    modelTier: String(actual.modelTier || "").trim(),
    executionStrategy: String(actual.executionStrategy || "").trim(),
    decisionId: String(actual.decisionId || "").trim(),
    evidence: String(actual.evidence || "").trim(),
    status: String(actual.status || "").trim(),
    appliedAt: Number(actual.appliedAt) || Number(fallbackTs) || Date.now(),
  };
}

function readLegacyMessages(tabId) {
  ensureDir();
  try {
    if (!fs.existsSync(msgFile(tabId))) return [];
    const value = JSON.parse(fs.readFileSync(msgFile(tabId), "utf-8"));
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}

function readConversationState(tabId) {
  ensureDir();
  const cached = conversationReadCache.get(tabId);
  if (cached) {
    if (cached.statKey && cached.statKey === statKeyOf(conversationFile(tabId))) return cached.value;
    if (cached.source === "messages" && cached.statKey && cached.statKey === statKeyOf(msgFile(tabId))) return cached.value;
  }
  try {
    if (fs.existsSync(conversationFile(tabId))) {
      const key = statKeyOf(conversationFile(tabId));
      const value = compactConversationTranscripts(normalizeConversation(
        JSON.parse(fs.readFileSync(conversationFile(tabId), "utf-8")),
        { tabId },
      ));
      conversationReadCache.set(tabId, { statKey: key, source: "conversation", value });
      return value;
    }
    if (fs.existsSync(msgFile(tabId))) {
      const key = statKeyOf(msgFile(tabId));
      const value = compactConversationTranscripts(normalizeConversation(
        JSON.parse(fs.readFileSync(msgFile(tabId), "utf-8")),
        { tabId },
      ));
      conversationReadCache.set(tabId, { statKey: key, source: "messages", value });
      return value;
    }
  } catch {
    return compactConversationTranscripts(normalizeConversation(readLegacyMessages(tabId), { tabId }));
  }
  return compactConversationTranscripts(normalizeConversation(readLegacyMessages(tabId), { tabId }));
}

function persistConversationState(tabId, conversation) {
  const normalized = compactConversationTranscripts(normalizeConversation(conversation, { tabId }));
  const active = legacyConversationMessages(normalized);
  writeConversationFilesAtomic(tabId, normalized, active);
  if (isTabDeletionBlocked(tabId)) {
    try { fs.rmSync(msgFile(tabId), { force: true }); } catch {}
    try { fs.rmSync(conversationFile(tabId), { force: true }); } catch {}
    return null;
  }
  // 同步落盘后更新读缓存（statKey 为最新文件状态）
  updateConversationCache(tabId, normalized);
  return normalized;
}

export function getConversation(tabId) {
  return conversationView(readConversationState(tabId));
}

export function getMessages(tabId) {
  return legacyConversationMessages(readConversationState(tabId));
}

// 故事点跨机还原：直接写入对话图 + 消息列表（保留分支结构），供 story-backup 还原使用。
// 返回 { conversation, messages }；若 tab 处于删除阻断状态则返回空。
export function restoreConversationState(tabId, conversation, messages = []) {
  ensureDir();
  if (isTabDeletionBlocked(tabId)) return { conversation: null, messages: [] };
  const source = conversation && typeof conversation === "object" && !Array.isArray(conversation)
    ? conversation
    : normalizeConversation(Array.isArray(messages) ? messages : [], { tabId });
  const persisted = persistConversationState(tabId, source);
  return {
    conversation: conversationView(persisted || source),
    messages: legacyConversationMessages(persisted || source),
  };
}

export function appendConversationNode(tabId, msg, options = {}) {
  ensureDir();
  if (isTabDeletionBlocked(tabId)) return { conversation: getConversation(tabId), node: null, messages: getMessages(tabId) };
  const result = appendConversationGraphNode(readConversationState(tabId), msg, options);
  const persisted = persistConversationState(tabId, result.conversation);
  return {
    ...result,
    conversation: conversationView(persisted || result.conversation),
    messages: persisted ? legacyConversationMessages(persisted) : [],
  };
}

export function createConversationUserRevision(tabId, input = {}) {
  ensureDir();
  if (isTabDeletionBlocked(tabId)) return { conversation: getConversation(tabId), node: null, messages: getMessages(tabId) };
  const result = createConversationGraphUserRevision(readConversationState(tabId), input);
  const persisted = persistConversationState(tabId, result.conversation);
  return {
    ...result,
    conversation: conversationView(persisted || result.conversation),
    messages: persisted ? legacyConversationMessages(persisted) : [],
  };
}

export function selectConversationHead(tabId, messageId, { expectedRevision } = {}) {
  ensureDir();
  const result = selectConversationNode(readConversationState(tabId), messageId, { expectedRevision });
  const persisted = result.changed
    ? persistConversationState(tabId, result.conversation)
    : result.conversation;
  return {
    ...result,
    conversation: conversationView(persisted),
    messages: legacyConversationMessages(persisted),
  };
}

export function patchConversationNodeFields(tabId, nodeId, fields = {}) {
  ensureDir();
  if (isTabDeletionBlocked(tabId)) return { conversation: getConversation(tabId), node: null, messages: getMessages(tabId) };
  const result = updateConversationGraphNodeFields(readConversationState(tabId), nodeId, fields);
  const persisted = result.changed
    ? persistConversationState(tabId, result.conversation)
    : result.conversation;
  return {
    ...result,
    conversation: conversationView(persisted || result.conversation),
    messages: persisted ? legacyConversationMessages(persisted) : [],
  };
}

export function appendMessage(tabId, msg) {
  return appendConversationNode(tabId, msg, {
    parentId: Object.prototype.hasOwnProperty.call(msg || {}, "parentId") ? msg.parentId : undefined,
  }).messages;
}

export function replaceMessages(tabId, messages = [], { preserveExactMetadata = false } = {}) {
  ensureDir();
  if (isTabDeletionBlocked(tabId)) return getMessages(tabId);
  const list = (Array.isArray(messages) ? messages : [])
    .filter((m) => m && (m.role === "user" || m.role === "assistant"))
    .map((m, idx) => {
      const ts = Number(m.ts) || (Date.now() + idx);
      const aiSnapshot = m.role === "assistant"
        ? (preserveExactMetadata ? cloneMessageMetadata(m.aiSnapshot, null) : normalizeAiSnapshot(m.aiSnapshot, m.engine, ts))
        : null;
      const actualAi = m.role === "assistant"
        ? (preserveExactMetadata ? cloneMessageMetadata(m.actualAi, null) : normalizeActualAi(m.actualAi, m.engine, ts))
        : null;
//      const aiSnapshot = m.role === "assistant" ? normalizeAiSnapshot(m.aiSnapshot, m.engine, ts) : null;
      return {
        // 先保留所有 JSON 可序列化元数据，保证将来新增 message 字段也可往返；
        // 再覆盖核心字段并规范化 AI 身份快照，避免备份文件注入非法 role/content。
        ...cloneMessageMetadata(m),
        role: m.role,
        content: String(m.content || ""),
        turn: Number(m.turn) || Math.floor(idx / 2) + 1,
        ts,
        ...(m.role === "assistant" && m.engine ? { engine: String(m.engine) } : {}),
        ...(aiSnapshot ? { aiSnapshot } : {}),
        ...(m.error ? { error: true } : {}),
        ...(m.stopped ? { stopped: true, error: false } : {}),
      };
    });
  const resetConversation = normalizeConversation(list, { tabId });
  resetConversation.revision = 1;
  persistConversationState(tabId, resetConversation);
  if (isTabDeletionBlocked(tabId)) {
    try { fs.rmSync(msgFile(tabId), { force: true }); } catch {}
    try { fs.rmSync(conversationFile(tabId), { force: true }); } catch {}
    return [];
  }
  return legacyConversationMessages(resetConversation);
}

function conversationBackupDirectory(tab, requestedDirectory = "", { forWrite = false } = {}) {
  const requested = String(requestedDirectory || "").trim();
  const directory = requested || getArchiveDirInfo(tab).effectiveArchiveDir || "";
  return forWrite ? validateArchiveWriteDirectory(tab, directory) : directory;
}

export function createConversationBackup(tabId, {
  directory = "",
  messages = null,
  liveIncluded = false,
  kind = "manual",
} = {}) {
  const tab = getTab(tabId);
  if (!tab) return { ok: false, statusCode: 404, error: "故事点不存在" };
  const snapshot = Array.isArray(messages) ? messages : getMessages(tabId);
  let backupDirectory = "";
  try {
    backupDirectory = conversationBackupDirectory(tab, directory, { forWrite: true });
  } catch (error) {
    return {
      ok: false,
      statusCode: error?.statusCode || 400,
      code: error?.code || "STORY_BACKUP_DIRECTORY_UNSAFE",
      error: `完整对话备份目录必须位于当前故事点的外置 ask 目录内：${error.message}`,
    };
  }
  const result = writeConversationBackup({
    directory: backupDirectory,
    tab,
    messages: snapshot,
    conversation: readConversationState(tabId),
    createdAt: Date.now(),
    kind,
    liveIncluded,
  });
  if (result.ok) {
    const directories = [...new Set([
      ...(tab.conversationBackupDirectories || []),
      result.directory,
    ].filter(Boolean).map((value) => path.resolve(String(value))))].slice(-40);
    const files = [...new Set([
      ...(tab.conversationBackupFiles || []),
      result.file,
    ].filter(Boolean).map((value) => path.resolve(String(value))))].slice(-400);
    updateTab(tabId, { conversationBackupDirectories: directories, conversationBackupFiles: files });
  }
  return result;
}

export function listConversationBackups(tabId, directory = "") {
  const tab = getTab(tabId);
  if (!tab) return { ok: false, statusCode: 404, error: "故事点不存在" };
  return listConversationBackupFiles(conversationBackupDirectory(tab, directory));
}

export function restoreConversationBackupToTab(tabId, filePath, { recoveryDirectory = "" } = {}) {
  const tab = getTab(tabId);
  if (!tab) return { ok: false, statusCode: 404, error: "故事点不存在" };
  if (tab.runningTaskId) {
    return { ok: false, statusCode: 409, code: "AI_RUNNING", error: "AI 正在工作，无法还原完整对话" };
  }
  const source = readConversationBackup(filePath);
  if (!source.ok) return source;
  if (!source.data.messages.length) return { ok: false, error: "备份中没有可还原的对话消息" };

  const currentMessages = getMessages(tabId);
  let recoveryBackup = null;
  if (currentMessages.length) {
    recoveryBackup = createConversationBackup(tabId, {
      directory: recoveryDirectory || conversationBackupDirectory(tab) || path.dirname(source.file),
      messages: currentMessages,
      kind: "pre_restore",
    });
    if (!recoveryBackup.ok) {
      return { ok: false, error: `还原前保护备份失败，当前对话未被替换：${recoveryBackup.error}` };
    }
  }

  const restoredConversation = Number(source.data.version) >= 2 && source.data.conversation
    ? persistConversationState(
      tabId,
      normalizeConversation(source.data.conversation, { tabId }),
    )
    : null;
  const restored = restoredConversation
    ? legacyConversationMessages(restoredConversation)
    : replaceMessages(tabId, source.data.messages, { preserveExactMetadata: true });
  clearLiveDraft(tabId);
  const turns = restored.filter((message) => message.role === "user").length;
  const updated = updateTab(tabId, {
    turns,
    cliSessionId: null,
    cliSessionEngine: null,
    cliSessionIds: {},
    remoteAgentSessionId: null,
    remoteAgentLastEventId: null,
    restoredConversationBackupAt: Date.now(),
    restoredConversationBackupSource: source.file,
    conversationBackupDirectories: [...new Set([
      ...((tab.conversationBackupDirectories || []).map((value) => path.resolve(String(value)))),
      path.dirname(source.file),
    ])].slice(-40),
    conversationBackupFiles: [...new Set([
      ...((tab.conversationBackupFiles || []).map((value) => path.resolve(String(value)))),
      source.file,
    ])].slice(-400),
  });
  return {
    ok: true,
    tab: updated,
    sourceBackupFile: source.file,
    imported: restored.length,
    turns,
    ...(recoveryBackup?.ok ? { recoveryBackupFile: recoveryBackup.file } : {}),
  };
}

function latestArchiveSection(text) {
  const s = String(text || "");
  const marker = "导出全部会话历史";
  const idx = s.lastIndexOf(marker);
  if (idx < 0) return s;
  const start = s.lastIndexOf("\n", idx);
  return s.slice(start >= 0 ? start : idx);
}

function cleanArchiveAssistantContent(raw) {
  let s = String(raw || "").trim();
  const cutIndexes = [];
  const op = s.search(/\n## 操作\n\s*- \[工具\]/);
  if (op >= 0) cutIndexes.push(op);
  const comm = s.search(/\n## 通信日志\n/);
  if (comm >= 0) cutIndexes.push(comm);
  const event = s.search(/\n---------- \[[^\n]+\] /);
  if (event >= 0) cutIndexes.push(event);
  if (cutIndexes.length) s = s.slice(0, Math.min(...cutIndexes)).trimEnd();
  s = s.replace(/\n\[token\]\s*输入[\s\S]*$/m, "").trimEnd();
  return s.trim();
}

export function parseArchiveMessages(text) {
  const body = latestArchiveSection(text);
  const turnRe = /(?:^|\n)=+\s*第\s+([0-9?]+)\s+轮[^\n]*=+\n【我】\n/g;
  const turns = [];
  let m;
  while ((m = turnRe.exec(body))) turns.push({ index: m.index, end: turnRe.lastIndex, turn: m[1] });
  const messages = [];
  const baseTs = Date.now();
  turns.forEach((turn, idx) => {
    const next = turns[idx + 1]?.index ?? body.length;
    const segment = body.slice(turn.end, next);
    const ai = /\n【AI(?::([^】\n]+))?】([^\n]*)\n/.exec(segment);
    const turnNo = Number(turn.turn) || idx + 1;
    const userText = (ai ? segment.slice(0, ai.index) : segment).trim();
    if (userText) messages.push({ role: "user", content: userText, turn: turnNo, ts: baseTs + messages.length });
    if (ai) {
      const assistantText = cleanArchiveAssistantContent(segment.slice(ai.index + ai[0].length));
      if (assistantText) {
        const stopped = assistantText.startsWith("## 已停止生成");
        const assistantContent = stopped
          ? assistantText.replace(/^## 已停止生成[^\n]*(?:\n|$)/, "").trim()
          : assistantText;
        const assistantTs = baseTs + messages.length;
        const modelTag = /【model:([^】\n]*)】/i.exec(ai[2] || "");
        const tierTag = /【tier:([^】\n]*)】/i.exec(ai[2] || "");
        const productTag = /【product:([^】\n]*)】/i.exec(ai[2] || "");
        const providerTag = /【provider:([^】\n]*)】/i.exec(ai[2] || "");
        const accessTag = /【access:([^】\n]*)】/i.exec(ai[2] || "");
        const endpointTag = /【endpoint:([^】\n]*)】/i.exec(ai[2] || "");
        const officialTag = /【official:(true|false)】/i.exec(ai[2] || "");
        const capturedAtTag = /【capturedAt:([0-9]+)】/i.exec(ai[2] || "");
        const hasSnapshot = !!(
          modelTag || tierTag || productTag || providerTag || accessTag
          || endpointTag || officialTag || capturedAtTag
        );
        const model = String(modelTag?.[1] || "").trim();
        const tier = String(tierTag?.[1] || "").trim();
        const product = String(productTag?.[1] || "").trim();
        const provider = String(providerTag?.[1] || "").trim();
        const access = String(accessTag?.[1] || "").trim();
        const endpoint = String(endpointTag?.[1] || "").trim();
        messages.push({
          role: "assistant",
          content: assistantContent,
          turn: turnNo,
          ts: assistantTs,
          ...(ai[1] ? { engine: ai[1] } : {}),
          ...(hasSnapshot ? { aiSnapshot: {
            engine: String(ai[1] || "").trim(),
            model: model === "默认模型" ? "" : model,
            tier: tier === "默认档位" ? "" : tier,
            ...(product && product !== ai[1] ? { name: product } : {}),
            ...(provider && provider !== "未记录" ? { provider } : {}),
            ...(access && access !== "未记录" ? { access } : {}),
            ...(endpoint ? { endpoint } : {}),
            ...(officialTag ? { official: officialTag[1].toLowerCase() === "true" } : {}),
            capturedAt: Number(capturedAtTag?.[1]) || assistantTs,
          } } : {}),
          ...(assistantText.startsWith("## 执行失败") ? { error: true } : {}),
          ...(stopped ? { stopped: true, error: false } : {}),
        });
      }
    }
  });
  return messages;
}

const ARCHIVE_SCAN_MAX_FILES = 200;
const ARCHIVE_SCAN_MAX_BYTES = 20 * 1024 * 1024;

function archiveFileSummary(filePath) {
  const stat = fs.statSync(filePath);
  let messageCount = 0;
  let turnCount = 0;
  let restorable = false;
  let tooLarge = stat.size > ARCHIVE_SCAN_MAX_BYTES;
  if (!tooLarge) {
    try {
      const messages = parseArchiveMessages(fs.readFileSync(filePath, "utf-8"));
      messageCount = messages.length;
      turnCount = messages.filter((m) => m.role === "user").length;
      restorable = messageCount > 0;
    } catch {
      restorable = false;
    }
  }
  return {
    path: filePath,
    dir: path.dirname(filePath),
    name: path.basename(filePath),
    title: path.basename(filePath, path.extname(filePath)),
    size: stat.size,
    mtime: stat.mtimeMs,
    messageCount,
    turnCount,
    restorable,
    tooLarge,
  };
}

export function listArchiveFiles(rootDir) {
  const raw = String(rootDir || "").trim();
  if (!raw) return { ok: false, error: "请选择存档目录" };
  if (!path.isAbsolute(raw)) return { ok: false, error: "存档目录必须是全路径" };
  const root = path.resolve(raw);
  if (!fs.existsSync(root)) return { ok: false, error: "存档目录不存在" };
  try {
    if (!fs.statSync(root).isDirectory()) return { ok: false, error: "请选择目录，不是文件" };
  } catch (e) {
    return { ok: false, error: e.message };
  }
  const files = [];
  const walk = (dir, depth = 0) => {
    if (files.length >= ARCHIVE_SCAN_MAX_FILES || depth > 4) return;
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (files.length >= ARCHIVE_SCAN_MAX_FILES) break;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!["node_modules", ".git", "build", "dist"].includes(entry.name)) walk(full, depth + 1);
      } else if (entry.isFile() && /\.txt$/i.test(entry.name)) {
        try {
          const summary = archiveFileSummary(full);
          if (summary.restorable || summary.tooLarge) files.push(summary);
        } catch {}
      }
    }
  };
  walk(root);
  files.sort((a, b) => b.mtime - a.mtime || a.name.localeCompare(b.name, "zh"));
  return { ok: true, dir: root, archives: files };
}

export function restoreArchiveToTab(tabId, filePath, { mode = "replace" } = {}) {
  const tab = getTab(tabId);
  if (!tab) return { ok: false, error: "故事点不存在" };
  const raw = String(filePath || "").trim();
  if (!raw) return { ok: false, error: "请选择存档文件" };
  if (!path.isAbsolute(raw)) return { ok: false, error: "存档文件必须是全路径" };
  const archiveFile = path.resolve(raw);
  if (!fs.existsSync(archiveFile)) return { ok: false, error: "存档文件不存在" };
  const stat = fs.statSync(archiveFile);
  if (!stat.isFile()) return { ok: false, error: "请选择存档文件，不是目录" };
  if (stat.size > ARCHIVE_SCAN_MAX_BYTES) return { ok: false, error: "存档文件过大，暂不支持直接还原到页面会话" };
  const imported = parseArchiveMessages(fs.readFileSync(archiveFile, "utf-8"));
  if (!imported.length) return { ok: false, error: "未从该存档解析到可还原的会话" };
  let activeArchiveFile = "";
  try {
    activeArchiveFile = getArchiveDirInfo(tab).archiveFile || "";
  } catch (error) {
    return {
      ok: false,
      statusCode: error?.statusCode || 400,
      code: error?.code || "STORY_ARCHIVE_DIRECTORY_UNSAFE",
      error: `当前故事点外置存档目录不可用：${error.message}`,
    };
  }
  const finalMessages = mode === "append" ? [...getMessages(tabId), ...imported] : imported;
  replaceMessages(tabId, finalMessages);
  const turns = finalMessages.filter((msg) => msg.role === "user").length;
  const updated = updateTab(tabId, {
    turns,
    cliSessionId: null,
    cliSessionEngine: null,
    cliSessionIds: {},
    remoteAgentSessionId: null,
    remoteAgentLastEventId: null,
    restoredArchiveAt: Date.now(),
    restoredArchiveSource: archiveFile,
  });
  return {
    ok: true,
    tab: updated,
    archiveFile,
    activeArchiveFile,
    imported: imported.length,
    turns,
    mode: mode === "append" ? "append" : "replace",
  };
}

// 运行中的 AI 对话草稿单独持久化，页面刷新后可恢复思考、工具命令和未完成回答。
// 最终消息仍只写入 msg-*.json；任务成功、失败或手动停止后清除此草稿，避免重复展示。
export function getLiveDraft(tabId) {
  ensureDir();
  try {
    if (!fs.existsSync(liveFile(tabId))) return null;
    const draft = JSON.parse(fs.readFileSync(liveFile(tabId), "utf-8"));
    return draft && typeof draft === "object" && !Array.isArray(draft) ? draft : null;
  } catch {
    return null;
  }
}

export function saveLiveDraft(tabId, draft) {
  ensureDir();
  if (isTabDeletionBlocked(tabId)) return getLiveDraft(tabId);
  const next = { ...(draft || {}), updatedAt: Date.now() };
  fs.writeFileSync(liveFile(tabId), JSON.stringify(next, null, 2), "utf-8");
  if (isTabDeletionBlocked(tabId)) {
    try { fs.rmSync(liveFile(tabId), { force: true }); } catch {}
    return null;
  }
  return next;
}

export function markLiveDraftStopped(tabId, endedAt = Date.now()) {
  const current = getLiveDraft(tabId);
  if (!current) return null;
  const startedAt = Number(current.startedAt || endedAt);
  return saveLiveDraft(tabId, {
    ...current,
    streaming: false,
    stopped: true,
    endedAt,
    durationMs: Math.max(0, endedAt - startedAt),
  });
}

export function clearLiveDraft(tabId) {
  try { fs.unlinkSync(liveFile(tabId)); } catch {}
}
