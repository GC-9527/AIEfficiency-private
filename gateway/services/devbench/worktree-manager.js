import fs from "fs";
import os from "os";
import path from "path";
import { createHash, randomUUID } from "crypto";
import { execFile } from "child_process";
import { promisify } from "util";
import {
  claimWorktreeResourceLease,
  countActiveWorktreeResourceLeaseRows,
  deleteStoryWorkspaceBundle,
  listActiveWorktreeResourceLeases,
  listTaskRuntimeLeases,
  listWorktreeResourceLeases,
  releaseWorktreeResourceLease,
  releaseWorktreeResourceLeasesForTask,
  renewWorktreeResourceLease,
  saveStoryWorkspaceBundle,
} from "../../db/sqlite.js";
import { isSameLiveProcess } from "../process-identity.js";
import { repositoryGitArgs } from "./git-command.js";
import {
  WORKSPACE_BUNDLE_EDITABLE,
  WORKSPACE_BUNDLE_READ_ONLY,
  WORKSPACE_BUNDLE_VERSION,
  buildStoryWorkspaceDirectoryName,
  inspectWorkspaceBundleIntegrity,
  validateWorkspaceBundle,
  validateWorkspaceCheckoutDirName,
} from "./workspace-bundle.js";

const execFileAsync = promisify(execFile);
const worktreeMutationLocks = new Set();
const mutationLeaseByTab = new Map();
const activeResourceLeases = new Map();
const resourceLeaseOwner = `devbench-worktree-${process.pid}-${randomUUID()}`;
const RESOURCE_LEASE_TTL_MS = Math.max(
  5000,
  Number(process.env.DEVBENCH_WORKTREE_LEASE_TTL_MS) || 15000,
);
const RESOURCE_LEASE_HEARTBEAT_MS = Math.max(
  1000,
  Math.min(4000, Math.floor(RESOURCE_LEASE_TTL_MS / 3)),
);

/** 克隆父路径下的故事点 worktree 根目录名（与 UI/配置无关，代码约定） */
export const WORKTREE_SPACE_DIRNAME = "WorktreeSpace";

function normalizedPath(value) {
  let raw = String(value || "").trim();
  const slashed = raw.replace(/\\/g, "/");
  if (/^\/\/\?\/UNC\//i.test(slashed)) raw = `//${slashed.slice(8)}`;
  else if (/^\/\/\?\/(?=[A-Za-z]:\/)/.test(slashed)) raw = slashed.slice(4);
  return path.resolve(raw).replace(/[\\/]+/g, "/").replace(/\/+$/, "").toLowerCase();
}

function isInside(parent, child) {
  const parentKey = normalizedPath(parent);
  const childKey = normalizedPath(child);
  return childKey === parentKey || childKey.startsWith(`${parentKey}/`);
}

function isStrictlyInside(parent, child) {
  const parentKey = normalizedPath(parent);
  const childKey = normalizedPath(child);
  return childKey !== parentKey && childKey.startsWith(`${parentKey}/`);
}

function existingPhysicalPath(value) {
  const resolved = path.resolve(String(value || ""));
  if (!value) return "";
  try { return fs.realpathSync.native(resolved); } catch { return resolved; }
}

function prospectivePhysicalPath(value) {
  if (!value) return "";
  const resolved = path.resolve(String(value));
  const missingSegments = [];
  let existingAncestor = resolved;
  while (!fs.existsSync(existingAncestor)) {
    const parent = path.dirname(existingAncestor);
    if (parent === existingAncestor) return resolved;
    missingSegments.unshift(path.basename(existingAncestor));
    existingAncestor = parent;
  }
  let physicalAncestor;
  try { physicalAncestor = fs.realpathSync.native(existingAncestor); } catch { return resolved; }
  return path.join(physicalAncestor, ...missingSegments);
}

function hasLiveWorkerForTask(taskId, databaseFailureIsActive = true) {
  const task = String(taskId || "").trim();
  if (!task) return false;
  try {
    return listTaskRuntimeLeases(task)
      .some((lease) => isSameLiveProcess(lease.worker_pid, lease.worker_identity));
  } catch {
    return databaseFailureIsActive;
  }
}

function leaseSubject(subject, explicitWorktree = null) {
  if (subject && typeof subject === "object") {
    return {
      tabId: String(subject.id || subject.tabId || "").trim(),
      worktree: explicitWorktree || subject.worktree || null,
    };
  }
  return {
    tabId: String(subject || "").trim(),
    worktree: explicitWorktree || null,
  };
}

export function storyWorktreeResourceKeys(subject, explicitWorktree = null) {
  const { tabId, worktree } = leaseSubject(subject, explicitWorktree);
  // 只按「本故事点专属 checkout 路径」建租约 key。
  // 禁止把 worktree.root（共享的 WorktreeSpace 父目录）算进去——否则故事点 A 的 AI
  // 会锁住整个 WorktreeSpace，故事点 B 确认推理后 apply-config / kick AI 全部 409。
  const rawPaths = [];
  for (const entry of [
    ...(Array.isArray(worktree?.entries) ? worktree.entries : []),
    ...(Array.isArray(worktree?.cleanedEntries) ? worktree.cleanedEntries : []),
  ]) {
    if (!entry || entry.role === "inactive" || entry.active === false) continue;
    const candidate = entry?.worktreePath || entry?.path;
    if (candidate) rawPaths.push(candidate);
  }
  const keys = [];
  if (tabId) keys.push(`tab:${createHash("sha256").update(tabId).digest("hex")}`);
  const sharedRoot = String(worktree?.root || "").trim();
  const sharedRootKey = sharedRoot ? normalizedPath(existingPhysicalPath(sharedRoot)) : "";
  for (const value of rawPaths) {
    const normalized = normalizedPath(existingPhysicalPath(value));
    // 防御：若某 entry 误把父目录写成 path，仍跳过，避免回到「整仓互斥」
    if (!normalized || (sharedRootKey && normalized === sharedRootKey)) continue;
    keys.push(`path:${createHash("sha256").update(normalized).digest("hex")}`);
  }
  return [...new Set(keys)].sort();
}

function beginResourceLease(subject, kind, taskId = "", explicitWorktree = null) {
  const { tabId, worktree } = leaseSubject(subject, explicitWorktree);
  const resourceKeys = storyWorktreeResourceKeys({ id: tabId, worktree });
  if (!tabId || !resourceKeys.length) return null;
  try {
    const liveOrphan = listWorktreeResourceLeases(resourceKeys)
      .some((lease) => lease.kind === "ai" && hasLiveWorkerForTask(lease.task_id));
    if (liveOrphan) return null;
  } catch {
    return null;
  }
  const leaseToken = randomUUID();
  let claimed;
  try {
    claimed = claimWorktreeResourceLease({
      resourceKeys,
      leaseToken,
      kind,
      tabId,
      taskId,
      ownerInstance: resourceLeaseOwner,
      ownerPid: process.pid,
      ttlMs: RESOURCE_LEASE_TTL_MS,
    });
  } catch {
    return null;
  }
  if (!claimed?.ok) return null;
  const handle = { leaseToken, tabId, taskId, kind, resourceKeys };
  handle.lastRenewedAt = Date.now();
  handle.lost = false;
  activeResourceLeases.set(leaseToken, handle);
  return handle;
}

function endResourceLease(handleOrToken) {
  const leaseToken = typeof handleOrToken === "string"
    ? handleOrToken
    : String(handleOrToken?.leaseToken || "");
  if (!leaseToken) return false;
  const handle = typeof handleOrToken === "object"
    ? handleOrToken
    : activeResourceLeases.get(leaseToken);
  if (handle?.kind === "ai" && hasLiveWorkerForTask(handle.taskId)) {
    handle.releaseWhenWorkerStops = true;
    // 记录首次请求释放的时间，心跳定时器据此判断是否超过最大推迟上限。
    // 避免活进程下 DB 抖动导致 hasLiveWorkerForTask 恒返回 true、lease 永久续租。
    handle.releaseRequestedAt = handle.releaseRequestedAt || Date.now();
    return true;
  }
  activeResourceLeases.delete(leaseToken);
  try {
    releaseWorktreeResourceLease(leaseToken, resourceLeaseOwner);
    return true;
  } catch {
    return false;
  }
}

const resourceLeaseHeartbeat = setInterval(() => {
  for (const handle of activeResourceLeases.values()) {
    if (handle.releaseWhenWorkerStops) {
      // 推迟释放上限：超过 3 倍 TTL 后强制释放，避免活进程下 DB 抖动导致
      // hasLiveWorkerForTask 恒返回 true、lease 永久续租、/send 永久 409。
      const overdue = Date.now() - (handle.releaseRequestedAt || handle.lastRenewedAt || 0) >= RESOURCE_LEASE_TTL_MS * 3;
      if (!hasLiveWorkerForTask(handle.taskId) || overdue) {
        activeResourceLeases.delete(handle.leaseToken);
        try { releaseWorktreeResourceLease(handle.leaseToken, resourceLeaseOwner); } catch {}
        continue;
      }
      // 仍在推迟窗口内且 worker 存活：继续续租，但不再刷新 releaseRequestedAt
      try {
        const renewed = renewWorktreeResourceLease(handle.leaseToken, resourceLeaseOwner, {
          ttlMs: RESOURCE_LEASE_TTL_MS,
        });
        if (renewed.changes === handle.resourceKeys.length) {
          handle.lastRenewedAt = Date.now();
        } else {
          handle.lost = true;
        }
      } catch {
        if (Date.now() - handle.lastRenewedAt >= RESOURCE_LEASE_TTL_MS / 2) handle.lost = true;
      }
      if (handle.lost) {
        activeResourceLeases.delete(handle.leaseToken);
        try { handle.onLost?.(); } catch {}
      }
      continue;
    }
    try {
      const renewed = renewWorktreeResourceLease(handle.leaseToken, resourceLeaseOwner, {
        ttlMs: RESOURCE_LEASE_TTL_MS,
      });
      if (renewed.changes === handle.resourceKeys.length) {
        handle.lastRenewedAt = Date.now();
        continue;
      }
      handle.lost = true;
    } catch {
      if (Date.now() - handle.lastRenewedAt >= RESOURCE_LEASE_TTL_MS / 2) handle.lost = true;
    }
    if (handle.lost) {
      activeResourceLeases.delete(handle.leaseToken);
      try { handle.onLost?.(); } catch {}
    }
  }
}, RESOURCE_LEASE_HEARTBEAT_MS);
resourceLeaseHeartbeat.unref?.();

export function activeStoryWorktreeLeases(subject, explicitWorktree = null) {
  const resourceKeys = storyWorktreeResourceKeys(subject, explicitWorktree);
  if (!resourceKeys.length) return [];
  return listActiveWorktreeResourceLeases(resourceKeys);
}

export function isStoryAiLeaseActive(subject, explicitWorktree = null) {
  try {
    const resourceKeys = storyWorktreeResourceKeys(subject, explicitWorktree);
    return listWorktreeResourceLeases(resourceKeys)
      .some((lease) => (
        lease.kind === "ai"
        && (lease.expires_at > Date.now() || hasLiveWorkerForTask(lease.task_id))
      ));
  } catch {
    // DB 异常时不能无条件返回 true（会导致 /send 永久 409、AI 无法启动）。
    // 仅当该故事点确有运行中的任务时才保守阻断，否则允许新任务启动。
    const tab = subject && typeof subject === "object" ? subject : null;
    return !!(tab && (tab.runningTaskId || tab._forceLeaseActiveOnError));
  }
}

export function isStoryTaskAiLeaseActive(subject, taskId, explicitWorktree = null) {
  const expectedTaskId = String(taskId || "").trim();
  if (!expectedTaskId) return false;
  try {
    const resourceKeys = storyWorktreeResourceKeys(subject, explicitWorktree);
    return listWorktreeResourceLeases(resourceKeys)
      .some((lease) => (
        lease.kind === "ai"
        && String(lease.task_id || "").trim() === expectedTaskId
        && (
          lease.expires_at > Date.now()
          || hasLiveWorkerForTask(expectedTaskId, false)
        )
      ));
  } catch {
    // This check authorizes a new background process. Missing evidence or an
    // unreadable lease store must deny the start instead of trusting stale tab state.
    return false;
  }
}

export function beginStoryAiLease(tab, taskId) {
  return beginResourceLease(tab, "ai", taskId);
}

export function endStoryAiLease(handleOrToken) {
  return endResourceLease(handleOrToken);
}

/**
 * 强制释放某个故事点（tabId/taskId）名下的全部 AI worktree 租约。
 * 用于"卡住"任务收敛：API 引擎任务的 worker_pid 为空，挂起后心跳定时器仍持续续租，
 * 导致 isStoryAiLeaseActive 永远为 true、stop 端点永远 409。这里先清掉本进程内存里的
 * handle（停止其心跳），再按 task_id 兜底删 DB 行（覆盖不在本进程内存的残留行）。
 * 调用方必须先确认 live draft 已长时间无更新（stalled），避免误杀正常执行的任务。
 */
export function forceReleaseStoryAiLeasesForTask(tabId, taskId) {
  const tab = String(tabId || "").trim();
  const task = String(taskId || "").trim();
  let cleared = 0;
  if (tab && task) {
    for (const handle of Array.from(activeResourceLeases.values())) {
      if (handle?.kind !== "ai") continue;
      if (handle.tabId === tab && handle.taskId === task) {
        endResourceLease(handle);
        cleared += 1;
      }
    }
  }
  if (task) {
    try {
      const result = releaseWorktreeResourceLeasesForTask(task, "ai");
      cleared = Math.max(cleared, Number(result?.changes) || 0);
    } catch {}
  }
  return cleared;
}

/**
 * 按 tabId 强制释放该故事点名下的全部 AI worktree 租约（不依赖 taskId）。
 * 用于 AI 启动失败后 runningTaskId 已清空、live draft 已清除、但 lease 残留的场景：
 * /send 路由检测到「lease 活跃但无运行中任务」时自动调用，避免用户被永久 409 卡住。
 */
export function forceReleaseStoryAiLeasesForTab(subject, explicitWorktree = null) {
  const { tabId } = leaseSubject(subject, explicitWorktree);
  if (!tabId) return 0;
  let cleared = 0;
  // 1) 清理本进程内存中的 handle（心跳定时器不再续租它们）
  for (const handle of Array.from(activeResourceLeases.values()) ) {
    if (handle?.kind !== "ai") continue;
    if (handle.tabId === tabId) {
      activeResourceLeases.delete(handle.leaseToken);
      try { releaseWorktreeResourceLease(handle.leaseToken, resourceLeaseOwner); } catch {}
      cleared += 1;
    }
  }
  // 2) 清理 DB 中该 tab resourceKeys 的残留 lease 行
  try {
    const resourceKeys = storyWorktreeResourceKeys(subject, explicitWorktree);
    if (resourceKeys.length) {
      const leases = listWorktreeResourceLeases(resourceKeys);
      for (const lease of leases) {
        if (lease.kind === "ai") {
          try { releaseWorktreeResourceLease(lease.lease_token, resourceLeaseOwner); } catch {}
          cleared += 1;
        }
      }
    }
  } catch {}
  return cleared;
}

export function hasWorktreeResourceLease(handle) {
  if (!handle?.leaseToken || handle.lost) return false;
  try {
    return countActiveWorktreeResourceLeaseRows(
      handle.leaseToken,
      resourceLeaseOwner,
    ) === handle.resourceKeys.length;
  } catch {
    return false;
  }
}

export function hasWorktreeMutationLease(subject) {
  const { tabId } = leaseSubject(subject);
  return hasWorktreeResourceLease(mutationLeaseByTab.get(tabId));
}

export function isWorktreeMutationLocked(subject, explicitWorktree = null) {
  const { tabId } = leaseSubject(subject, explicitWorktree);
  if (worktreeMutationLocks.has(tabId)) return true;
  try {
    return activeStoryWorktreeLeases(subject, explicitWorktree)
      .some((lease) => lease.kind === "cleanup" || lease.kind === "recreate");
  } catch {
    return true;
  }
}

export function beginWorktreeMutation(subject, kind = "cleanup", explicitWorktree = null, onLost = null) {
  const { tabId } = leaseSubject(subject, explicitWorktree);
  if (!tabId || worktreeMutationLocks.has(tabId)) return false;
  const handle = beginResourceLease(subject, kind, "", explicitWorktree);
  if (!handle) return false;
  if (typeof onLost === "function") handle.onLost = onLost;
  worktreeMutationLocks.add(tabId);
  mutationLeaseByTab.set(tabId, handle);
  return true;
}

export function endWorktreeMutation(subject) {
  const { tabId } = leaseSubject(subject);
  worktreeMutationLocks.delete(tabId);
  const handle = mutationLeaseByTab.get(tabId);
  mutationLeaseByTab.delete(tabId);
  if (handle) endResourceLease(handle);
}

function safeSegment(value, fallback = "repo", maxLength = 52) {
  const clean = String(value || "")
    .normalize("NFKC")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^[.-]+|[.-]+$/g, "")
    .slice(0, maxLength);
  return clean || fallback;
}

export function safeWorktreeDirectorySegment(value, fallback = "branch", maxLength = 48) {
  const clean = String(value || "")
    .normalize("NFKC")
    .replace(/^refs\/heads\//i, "")
    .replace(/^refs\/remotes\/origin\//i, "")
    .replace(/^origin\//i, "")
    .replace(/[^a-zA-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .replace(/_+/g, "_")
    .slice(0, maxLength)
    .replace(/_+$/g, "");
  return clean || fallback;
}

function worktreeTimestamp(value, { withSeconds = false } = {}) {
  const date = new Date(Number(value) || Date.now());
  const safe = Number.isFinite(date.getTime()) ? date : new Date();
  const part = (number) => String(number).padStart(2, "0");
  const core = `${part(safe.getMonth() + 1)}${part(safe.getDate())}${part(safe.getHours())}${part(safe.getMinutes())}`;
  return withSeconds ? `${core}${part(safe.getSeconds())}` : core;
}

/**
 * 目录名冲突时升到含秒时间戳：
 * - …_07251823 → …_0725182311（在原月日时分后追加当前秒）
 * - 已是 10 位则整段换成当前月日时分秒
 * - 无时间后缀（如 CARB_单号）则追加 _0725182311
 */
export function applyWorktreeConflictTimestamp(directoryName, at = Date.now()) {
  const date = new Date(Number(at) || Date.now());
  const safe = Number.isFinite(date.getTime()) ? date : new Date();
  const ss = String(safe.getSeconds()).padStart(2, "0");
  const stampSec = worktreeTimestamp(at, { withSeconds: true });
  const name = String(directoryName || "").trim();
  if (!name) return stampSec;
  if (/_\d{10}$/.test(name)) return name.replace(/_\d{10}$/, `_${stampSec}`);
  if (/_\d{8}$/.test(name)) return name.replace(/(_\d{8})$/, `$1${ss}`);
  return `${name}_${stampSec}`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const WORKTREE_DIRECTORY_RESERVATION_SUFFIX = ".devbench-worktree-reservation.json";

function worktreeDirectoryReservationPath(storyRoot, directoryName) {
  return path.join(storyRoot, `.${directoryName}${WORKTREE_DIRECTORY_RESERVATION_SUFFIX}`);
}

function readWorktreeDirectoryReservation(reservationPath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(reservationPath, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function reservationBelongsToStory(reservation, { tabId, targetPath, gitCommonDir = "" }) {
  const expectedCommonDir = String(gitCommonDir || "").trim();
  return Boolean(
    reservation
    && String(reservation.tabId || "").trim() === String(tabId || "").trim()
    && normalizedPath(reservation.worktreePath) === normalizedPath(targetPath)
    && (!expectedCommonDir || normalizedPath(reservation.gitCommonDir) === normalizedPath(expectedCommonDir)),
  );
}

/**
 * The sibling sidecar is created with `wx`, making directory allocation atomic
 * across gateway processes. It survives a process crash so the same story can
 * resume an explicitly persisted path instead of allocating another worktree.
 */
function reserveWorktreeDirectory(storyRoot, directoryName, {
  tabId,
  operationId,
  gitCommonDir,
} = {}) {
  fs.mkdirSync(storyRoot, { recursive: true });
  const worktreePath = path.join(storyRoot, directoryName);
  const reservationPath = worktreeDirectoryReservationPath(storyRoot, directoryName);
  const reservation = {
    version: 1,
    tabId: String(tabId || "").trim(),
    operationId: String(operationId || "").trim(),
    worktreePath,
    gitCommonDir: path.resolve(String(gitCommonDir || "")),
    createdAt: Date.now(),
    ownerPid: process.pid,
  };
  try {
    fs.writeFileSync(reservationPath, `${JSON.stringify(reservation, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
    });
    return { acquired: true, created: true, reservationPath, reservation };
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    const existing = readWorktreeDirectoryReservation(reservationPath);
    if (reservationBelongsToStory(existing, { tabId, targetPath: worktreePath, gitCommonDir })) {
      return {
        acquired: true,
        created: false,
        reservationPath,
        reservation: existing,
      };
    }
    return { acquired: false, created: false, reservationPath, reservation: existing };
  }
}

function releaseWorktreeDirectoryReservation(worktreePath, gitCommonDir, {
  tabId = "",
  operationId = "",
} = {}) {
  const target = path.resolve(String(worktreePath || ""));
  const expectedCommonDir = String(gitCommonDir || "").trim();
  if (!worktreePath || !expectedCommonDir) return false;
  const reservationPath = worktreeDirectoryReservationPath(path.dirname(target), path.basename(target));
  const reservation = readWorktreeDirectoryReservation(reservationPath);
  if (
    !reservation
    || normalizedPath(reservation.worktreePath) !== normalizedPath(target)
    || normalizedPath(reservation.gitCommonDir) !== normalizedPath(expectedCommonDir)
    || (tabId && String(reservation.tabId || "").trim() !== String(tabId).trim())
    || (operationId && reservation.operationId && String(reservation.operationId).trim() !== String(operationId).trim())
  ) {
    return false;
  }
  try {
    fs.unlinkSync(reservationPath);
    return true;
  } catch {
    return false;
  }
}

/**
 * 分配 WorktreeSpace 下唯一目录名：无短指纹。
 * 冲突时立刻把时间升到秒；仍冲突则等 1 秒再用新秒数重试。
 * 若带 existingPath：优先用目标名；目标被占则留在原路径（同故事点复用），避免误改名。
 */
async function ensureUniqueDirectoryName(storyRoot, baseDirectoryName, usedDirectoryNames, {
  existingPath = "",
  tabId = "",
  operationId = "",
  gitCommonDir = "",
} = {}) {
  const base = String(baseDirectoryName || "").trim() || "worktree";
  const existing = String(existingPath || "").trim();
  const rootResolved = path.resolve(storyRoot);

  const reserveCandidate = (directoryName, { allowExistingPath = "" } = {}) => {
    if (usedDirectoryNames.has(directoryName.toLowerCase())) return null;
    const target = path.join(storyRoot, directoryName);
    const allowed = String(allowExistingPath || "").trim();
    if (fs.existsSync(target) && (!allowed || normalizedPath(target) !== normalizedPath(allowed))) {
      return null;
    }
    const reservation = reserveWorktreeDirectory(storyRoot, directoryName, {
      tabId,
      operationId,
      gitCommonDir,
    });
    if (!reservation.acquired) return null;
    return {
      directoryName,
      generatedTargetPath: target,
      reservationPath: reservation.reservationPath,
      reservationCreated: reservation.created,
    };
  };

  if (existing) {
    const existingResolved = path.resolve(existing);
    if (normalizedPath(path.dirname(existingResolved)) === normalizedPath(rootResolved)) {
      const existingDirectoryName = path.basename(existingResolved);
      const existingReservationPath = worktreeDirectoryReservationPath(storyRoot, existingDirectoryName);
      const existingReservation = readWorktreeDirectoryReservation(existingReservationPath);
      if (reservationBelongsToStory(existingReservation, {
        tabId,
        targetPath: existingResolved,
        gitCommonDir,
      })) {
        return {
          directoryName: existingDirectoryName,
          generatedTargetPath: existingResolved,
          reservationPath: existingReservationPath,
          reservationCreated: false,
        };
      }
      const desiredTarget = path.join(storyRoot, base);
      const desiredReservationPath = worktreeDirectoryReservationPath(storyRoot, base);
      const desiredReservation = readWorktreeDirectoryReservation(desiredReservationPath);
      if (reservationBelongsToStory(desiredReservation, {
        tabId,
        targetPath: desiredTarget,
        gitCommonDir,
      })) {
        return {
          directoryName: base,
          generatedTargetPath: desiredTarget,
          reservationPath: desiredReservationPath,
          reservationCreated: false,
        };
      }
      const resumed = reserveCandidate(existingDirectoryName, { allowExistingPath: existingResolved });
      if (resumed) return resumed;
      throw Object.assign(
        new Error(`existingWorktreePath 已被另一个故事点或仓库预留：${existingResolved}`),
        { code: "WORKTREE_EXISTING_PATH_RESERVED" },
      );
    }
    throw Object.assign(
      new Error(`已有 worktree 路径不属于当前故事点根目录：${existingResolved}`),
      { code: "WORKTREE_EXISTING_PATH_OUTSIDE_STORY" },
    );
  }

  let directoryName = base;
  let waited = false;
  for (let round = 0; round < 120; round += 1) {
    const allocated = reserveCandidate(directoryName);
    if (allocated) return allocated;
    if (waited) await sleep(1000);
    directoryName = applyWorktreeConflictTimestamp(base, Date.now());
    waited = true;
  }
  throw Object.assign(
    new Error(`无法分配唯一 worktree 目录名：${base}`),
    { code: "WORKTREE_DIR_NAME_EXHAUSTED" },
  );
}

function ensureFixedWorktreeDirectory(storyRoot, checkoutDirName, usedDirectoryNames, {
  existingPath = "",
  legacyRoot = "",
  tabId = "",
  operationId = "",
  gitCommonDir = "",
} = {}) {
  const validated = validateWorkspaceCheckoutDirName(checkoutDirName);
  if (!validated.ok) throw Object.assign(new Error(validated.error), { code: validated.code });
  const directoryName = validated.name;
  const directoryKey = directoryName.toLowerCase();
  if (usedDirectoryNames.has(directoryKey)) {
    throw Object.assign(new Error(`Bundle 固定目录名重复：${directoryName}`), { code: "WORKSPACE_BUNDLE_DIR_DUPLICATE" });
  }
  const targetPath = path.join(storyRoot, directoryName);
  const existing = String(existingPath || "").trim() ? path.resolve(existingPath) : "";
  if (existing) {
    const parent = path.dirname(existing);
    const inCurrentBundle = normalizedPath(parent) === normalizedPath(storyRoot);
    const inLegacyRoot = legacyRoot && normalizedPath(parent) === normalizedPath(legacyRoot);
    if (!inCurrentBundle && !inLegacyRoot) {
      throw Object.assign(
        new Error(`已有 worktree 路径既不属于当前 Bundle，也不属于兼容迁移根目录：${existing}`),
        { code: "WORKTREE_EXISTING_PATH_OUTSIDE_STORY" },
      );
    }
  }
  if (fs.existsSync(targetPath) && (!existing || normalizedPath(existing) !== normalizedPath(targetPath))) {
    const sidecar = readWorktreeDirectoryReservation(worktreeDirectoryReservationPath(storyRoot, directoryName));
    if (!reservationBelongsToStory(sidecar, { tabId, targetPath, gitCommonDir })) {
      throw Object.assign(
        new Error(`Bundle 固定目录已被其它内容占用：${targetPath}`),
        { code: "WORKSPACE_BUNDLE_TARGET_OCCUPIED" },
      );
    }
  }
  const reservation = reserveWorktreeDirectory(storyRoot, directoryName, {
    tabId,
    operationId,
    gitCommonDir,
  });
  if (!reservation.acquired) {
    throw Object.assign(
      new Error(`Bundle 固定目录已被其它故事点预留：${targetPath}`),
      { code: "WORKSPACE_BUNDLE_TARGET_RESERVED" },
    );
  }
  return {
    directoryName,
    generatedTargetPath: targetPath,
    reservationPath: reservation.reservationPath,
    reservationCreated: reservation.created,
    migrationSourcePath: existing && normalizedPath(existing) !== normalizedPath(targetPath) ? existing : "",
  };
}

function writeJsonAtomically(filePath, value, operationId = "workspace") {
  const tempPath = `${filePath}.${safeSegment(operationId, "workspace", 48)}.${randomUUID()}.tmp`;
  fs.writeFileSync(tempPath, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  try {
    fs.renameSync(tempPath, filePath);
  } catch (error) {
    try { fs.unlinkSync(tempPath); } catch {}
    throw error;
  }
}

function writeWorkspaceBundleMetadata(storyRoot, metadata, operationId) {
  const controlDirectory = path.join(storyRoot, ".aiefficiency");
  fs.mkdirSync(controlDirectory, { recursive: true });
  let stat;
  try { stat = fs.lstatSync(controlDirectory); } catch {}
  if (!stat?.isDirectory() || stat.isSymbolicLink()) {
    throw Object.assign(new Error(`Bundle 元数据目录不是普通目录：${controlDirectory}`), {
      code: "WORKSPACE_BUNDLE_METADATA_UNSAFE",
    });
  }
  fs.mkdirSync(path.join(controlDirectory, "logs"), { recursive: true });
  writeJsonAtomically(path.join(controlDirectory, "workspace.json"), metadata, operationId);
  writeJsonAtomically(path.join(controlDirectory, "state.json"), {
    version: 1,
    workspaceId: metadata.workspaceId,
    storyId: metadata.storyId,
    status: "READY",
    updatedAt: Date.now(),
    preflight: metadata.preflight,
  }, `${operationId}-state`);
  return controlDirectory;
}

function workspaceBundleMetadataValue(storyId, workspace) {
  const entries = Array.isArray(workspace?.entries) ? workspace.entries : [];
  const bundle = workspace?.bundle || {};
  const logicalBranch = String(
    workspace?.preflight?.logicalBranch
      || entries.find((entry) => entry?.role === "primary")?.logicalBranch
      || "",
  ).trim();
  return {
    version: 1,
    layoutVersion: Math.max(WORKSPACE_BUNDLE_VERSION, Number(workspace?.layoutVersion) || WORKSPACE_BUNDLE_VERSION),
    workspaceId: String(workspace?.workspaceId || ""),
    storyId: String(storyId || ""),
    bundleId: String(bundle.id || ""),
    logicalBranch,
    buildEntryRepositoryId: String(bundle.buildEntryRepositoryId || ""),
    rootPath: String(workspace?.root || bundle.root || ""),
    members: entries
      .filter((entry) => entry?.repositoryId && entry?.active !== false && entry?.role !== "inactive")
      .map((entry) => ({
        repositoryId: String(entry.repositoryId),
        relativeDir: String(entry.checkoutDirName || entry.directoryName || ""),
        logicalBranch: String(entry.logicalBranch || ""),
        checkoutBranch: String(entry.branch || "") || null,
        checkoutCommit: String(entry.baseRevision || "") || null,
        mode: String(entry.mode || WORKSPACE_BUNDLE_EDITABLE),
        required: entry.required !== false,
        worktreePath: String(entry.worktreePath || entry.path || ""),
      })),
    preflight: workspace?.preflight || null,
    createdAt: Math.max(0, Number(workspace?.createdAt) || Date.now()),
    updatedAt: Math.max(0, Number(workspace?.updatedAt) || Date.now()),
    promotionHistory: Array.isArray(workspace?.promotionHistory) ? workspace.promotionHistory : [],
  };
}

function writeWorkspaceBundleSnapshot(storyId, workspace, operationId) {
  const root = String(workspace?.root || workspace?.bundle?.root || "").trim();
  if (!root || workspace?.bundle?.enabled !== true) {
    throw Object.assign(new Error("写入 Bundle 快照缺少工作区根目录或 Bundle"), {
      code: "WORKSPACE_BUNDLE_SNAPSHOT_INVALID",
    });
  }
  writeWorkspaceBundleMetadata(root, workspaceBundleMetadataValue(storyId, workspace), operationId);
}

function cleanupWorkspaceBundleMetadata(storyRoot, { removeLogs = false } = {}) {
  const root = String(storyRoot || "").trim();
  if (!root) return false;
  const controlDirectory = path.join(root, ".aiefficiency");
  let stat;
  try { stat = fs.lstatSync(controlDirectory); } catch { return false; }
  if (!stat.isDirectory() || stat.isSymbolicLink()) return false;
  for (const fileName of ["workspace.json", "state.json"]) {
    const filePath = path.join(controlDirectory, fileName);
    try {
      const fileStat = fs.lstatSync(filePath);
      if (fileStat.isFile() && !fileStat.isSymbolicLink()) fs.unlinkSync(filePath);
    } catch {}
  }
  const logsDirectory = path.join(controlDirectory, "logs");
  try {
    const logsStat = fs.lstatSync(logsDirectory);
    if (logsStat.isDirectory() && !logsStat.isSymbolicLink()) {
      if (removeLogs) {
        for (const fileName of fs.readdirSync(logsDirectory)) {
          if (!/^failure-[a-zA-Z0-9._-]+\.json$/.test(fileName)) continue;
          const filePath = path.join(logsDirectory, fileName);
          const fileStat = fs.lstatSync(filePath);
          if (fileStat.isFile() && !fileStat.isSymbolicLink()) fs.unlinkSync(filePath);
        }
      }
      if (fs.readdirSync(logsDirectory).length === 0) fs.rmdirSync(logsDirectory);
    }
  } catch {}
  try {
    if (fs.readdirSync(controlDirectory).length === 0) fs.rmdirSync(controlDirectory);
  } catch {}
  return !fs.existsSync(controlDirectory);
}

function writeWorkspaceBundleFailureMetadata(storyRoot, {
  storyId = "",
  workspaceId = "",
  bundleId = "",
  operationId = "",
  error = null,
} = {}) {
  const controlDirectory = path.join(storyRoot, ".aiefficiency");
  fs.mkdirSync(controlDirectory, { recursive: true });
  const controlStat = fs.lstatSync(controlDirectory);
  if (!controlStat.isDirectory() || controlStat.isSymbolicLink()) {
    throw Object.assign(new Error(`Bundle 失败元数据目录不是普通目录：${controlDirectory}`), {
      code: "WORKSPACE_BUNDLE_METADATA_UNSAFE",
    });
  }
  const logsDirectory = path.join(controlDirectory, "logs");
  fs.mkdirSync(logsDirectory, { recursive: true });
  const logsStat = fs.lstatSync(logsDirectory);
  if (!logsStat.isDirectory() || logsStat.isSymbolicLink()) {
    throw Object.assign(new Error(`Bundle 失败日志目录不是普通目录：${logsDirectory}`), {
      code: "WORKSPACE_BUNDLE_METADATA_UNSAFE",
    });
  }
  const failedAt = Date.now();
  const failure = {
    code: String(error?.code || "WORKSPACE_BUNDLE_CREATE_FAILED"),
    message: String(error?.message || error || "工作区 Bundle 创建失败"),
    preflight: error?.preflight && typeof error.preflight === "object" ? error.preflight : null,
  };
  writeJsonAtomically(path.join(controlDirectory, "state.json"), {
    version: 1,
    workspaceId,
    storyId,
    bundleId,
    status: "FAILED",
    updatedAt: failedAt,
    failure,
  }, `${operationId || "workspace"}-failed-state`);
  writeJsonAtomically(
    path.join(logsDirectory, `failure-${failedAt}-${randomUUID()}.json`),
    { version: 1, storyId, workspaceId, bundleId, failedAt, failure },
    `${operationId || "workspace"}-failed-log`,
  );
}

export function buildWorktreeDirectoryName({
  flavors = [],
  originalBranch = "",
  ticketId = "",
  createdAt = 0,
} = {}) {
  // 命名主体取原始分支，去掉 release/ 前缀（避免与车型名重复，如 geelyp155 + release/geely-p155），
  // 不再额外拼 flavor 前缀。safeWorktreeDirectorySegment 内部会再清 refs/heads/、origin/ 并做合法化。
  // 后缀优先用 TB 单号（CARB_<n>），无论 flavor 数量；没有 TB 单号才退回月日时分时间戳。
  // flavors 参数保留以兼容调用方，但不再参与命名（旧规则按 flavor 数量切换后缀会导致无 flavor 时丢单号）。
  void flavors;
  const branchRaw = String(originalBranch || "")
    .replace(/^refs\/heads\//i, "")
    .replace(/^refs\/remotes\/origin\//i, "")
    .replace(/^origin\//i, "")
    .replace(/^release\//i, "");
  const branch = safeWorktreeDirectorySegment(branchRaw, "branch", 48);
  const stamp = worktreeTimestamp(createdAt);
  const carb = String(ticketId || "").match(/(?:CARB[\s_-]*)?(\d+)/i);
  if (carb) return `${branch}_CARB_${carb[1]}`;
  return `${branch}_${stamp}`;
}

/**
 * 故事点 worktree 开发分支名：
 * - 有 TB 单号：story/原始分支(去 release/ 前缀)_CARB_单号
 * - 无 TB 单号：story/原始分支(去 release/ 前缀)_月日时分
 * 重名时由 applyWorktreeConflictTimestamp 追加 _MMDDHHmmss。
 */
export function buildWorktreeBranchName(naming = {}) {
  const body = buildWorktreeDirectoryName(naming);
  return `story/${body}`;
}

// 其他 worktree 上的 AI 在跑 git commit/checkout/status 时会短暂持有基仓公共目录锁。
// 创建新 worktree 只读取 commit 并在公共目录注册条目，不改主工程工作区或分支，
// 因此遇到这类瞬时锁竞争时应短暂退避重试，而不是直接判失败。
const GIT_LOCK_ERROR_PATTERNS = [
  /another git process seems to be running/i,
  /unable to create '.*\.lock'/i,
  /\.lock'(?::[^]*?)? File exists/i,
  /index\.lock/i,
  /HEAD\.lock/i,
  /unable to create '.*worktrees[^']*'/i,
  /unable to create '.*commondir'/i,
];

function isGitLockError(result) {
  if (!result || result.ok) return false;
  const text = `${result.stderr || ""}\n${result.stdout || ""}`;
  return GIT_LOCK_ERROR_PATTERNS.some((pattern) => pattern.test(text));
}

async function git(cwd, args, options = {}) {
  const retryOnLock = options.retryOnLock === true;
  const execOptions = {
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024,
    timeout: options.timeout || 60_000,
    // 标记为系统发起的 git 操作，放行基仓保护钩子。AI 自跑的 git 不经过此函数。
    env: { ...process.env, DEVBENCH_SYSTEM_GIT_OP: "1" },
    ...(options.signal ? { signal: options.signal } : {}),
  };
  if (!retryOnLock) {
    try {
      const result = await execFileAsync("git", repositoryGitArgs(cwd, args), execOptions);
      return { ok: true, stdout: String(result.stdout || "").trim(), stderr: String(result.stderr || "").trim() };
    } catch (error) {
      return {
        ok: false,
        stdout: String(error.stdout || "").trim(),
        stderr: String(error.stderr || error.message || "").trim(),
        error,
      };
    }
  }
  // 锁竞争重试：100, 200, 400, 800, 1600, 1600, 1600, 1600 ms，总上限约 8s。
  const maxAttempts = 8;
  let lastResult = null;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      const result = await execFileAsync("git", repositoryGitArgs(cwd, args), execOptions);
      lastResult = { ok: true, stdout: String(result.stdout || "").trim(), stderr: String(result.stderr || "").trim() };
      return lastResult;
    } catch (error) {
      lastResult = {
        ok: false,
        stdout: String(error.stdout || "").trim(),
        stderr: String(error.stderr || error.message || "").trim(),
        error,
      };
      if (!isGitLockError(lastResult)) return lastResult;
      if (options.signal?.aborted) return lastResult;
      if (attempt < maxAttempts - 1) {
        const delay = Math.min(1600, 100 * 2 ** attempt);
        await sleep(delay);
      }
    }
  }
  return lastResult;
}

async function captureWorktreeMigrationSnapshot(worktreePath) {
  const commands = {
    head: ["rev-parse", "HEAD"],
    branch: ["rev-parse", "--abbrev-ref", "HEAD"],
    status: ["status", "--porcelain=v1", "-z"],
    worktreeDiff: ["diff", "--binary", "--no-ext-diff"],
    indexDiff: ["diff", "--cached", "--binary", "--no-ext-diff"],
  };
  const values = {};
  for (const [name, args] of Object.entries(commands)) {
    const result = await git(worktreePath, args);
    if (!result.ok) {
      throw Object.assign(
        new Error(`迁移前后无法冻结 ${name}：${result.stderr || result.stdout || worktreePath}`),
        { code: "WORKTREE_RENAME_PRECHECK_FAILED" },
      );
    }
    values[name] = result.stdout;
  }
  return {
    head: values.head,
    branch: values.branch,
    statusSha256: createHash("sha256").update(values.status).digest("hex"),
    worktreeDiffSha256: createHash("sha256").update(values.worktreeDiff).digest("hex"),
    indexDiffSha256: createHash("sha256").update(values.indexDiff).digest("hex"),
  };
}

async function resolveOriginalBranch(sourcePath, requestedRef = "", preferredOriginalBranch = "") {
  const preferred = String(preferredOriginalBranch || "").trim();
  if (preferred) return preferred;
  const requested = String(requestedRef || "").trim()
    .replace(/^refs\/heads\//i, "")
    .replace(/^refs\/remotes\/origin\//i, "")
    .replace(/^origin\//i, "");
  if (
    requested
    && !requested.startsWith("devbench/")
    && !requested.startsWith("story/")
    && !/^[0-9a-f]{40,64}$/i.test(requested)
  ) {
    return requested;
  }
  const current = await git(sourcePath, ["branch", "--show-current"]);
  if (current.ok && current.stdout) return current.stdout;
  return requested || "branch";
}

async function repositoryInfo(sourcePath) {
  const source = path.resolve(String(sourcePath || ""));
  if (!sourcePath || !fs.existsSync(source)) {
    throw Object.assign(new Error(`本地工程路径不存在：${sourcePath || "（空）"}`), { code: "WORKTREE_SOURCE_MISSING" });
  }
  const top = await git(source, ["rev-parse", "--show-toplevel"]);
  const common = await git(source, ["rev-parse", "--git-common-dir"]);
  if (!top.ok || !common.ok) {
    throw Object.assign(new Error(`本地工程不是可用的 Git 仓库：${source}`), { code: "WORKTREE_SOURCE_NOT_GIT" });
  }
  const repositoryRoot = path.resolve(top.stdout);
  // --git-common-dir 的相对路径以 git -C 的工作目录为基准；从仓库子目录调用时可能是 ../.git。
  const gitCommonDir = path.resolve(source, common.stdout);
  return { source, repositoryRoot, gitCommonDir };
}

async function resolveBaseCommit(sourcePath, requestedRef = "", preferredOriginalBranch = "") {
  const ref = String(requestedRef || "").trim();
  const candidates = [];
  if (ref) {
    candidates.push(ref);
    if (!ref.startsWith("refs/")) {
      candidates.push(`refs/heads/${ref}`, `refs/remotes/origin/${ref}`);
    }
  }
  // 显式请求分支/提交时必须失败关闭，不能悄悄退回当前 HEAD；否则 Bundle 的
  // SAME_LOGICAL_BRANCH 预检会把缺失依赖分支误判为成功。
  if (!ref) candidates.push("HEAD");
  for (const candidate of [...new Set(candidates)]) {
    const resolved = await git(sourcePath, ["rev-parse", "--verify", `${candidate}^{commit}`]);
    if (resolved.ok && /^[0-9a-f]{40,64}$/i.test(resolved.stdout)) {
      return {
        revision: resolved.stdout.toLowerCase(),
        requestedRef: ref,
        resolvedRef: candidate,
        originalBranch: await resolveOriginalBranch(sourcePath, ref, preferredOriginalBranch),
      };
    }
  }
  throw Object.assign(new Error(`无法解析 worktree 基准分支或提交：${ref || "HEAD"}`), { code: "WORKTREE_BASE_REF_NOT_FOUND" });
}

async function registeredWorktreePaths(commandPath) {
  const listed = await git(commandPath, ["-c", "core.quotePath=false", "worktree", "list", "--porcelain", "-z"]);
  if (!listed.ok) return null;
  return listed.stdout
    .split("\0")
    .map((line) => line.replace(/[\r\n]+$/g, ""))
    .filter((line) => line.startsWith("worktree "))
    .map((line) => line.slice("worktree ".length));
}

async function currentWorktreeMetadata(worktreePath, expectedCommonDir) {
  if (!fs.existsSync(worktreePath)) return null;
  let targetStat;
  try { targetStat = fs.lstatSync(worktreePath); } catch { return null; }
  if (targetStat.isSymbolicLink()) {
    throw Object.assign(
      new Error(`worktree 目标是符号链接或 junction，拒绝复用：${worktreePath}`),
      { code: "WORKTREE_TARGET_REPARSE_POINT" },
    );
  }
  const info = await repositoryInfo(worktreePath).catch(() => null);
  if (!info || normalizedPath(info.gitCommonDir) !== normalizedPath(expectedCommonDir)) {
    throw Object.assign(new Error(`worktree 目标已存在且不属于当前基仓：${worktreePath}`), { code: "WORKTREE_TARGET_CONFLICT" });
  }
  const targetPhysical = normalizedPath(existingPhysicalPath(worktreePath));
  const repositoryPhysical = normalizedPath(existingPhysicalPath(info.repositoryRoot));
  if (!targetPhysical || targetPhysical !== repositoryPhysical) {
    throw Object.assign(
      new Error(`worktree 目标真实路径与 Git 顶层目录不一致：${worktreePath}`),
      { code: "WORKTREE_TARGET_ALIAS_CONFLICT" },
    );
  }
  const registered = await registeredWorktreePaths(worktreePath);
  if (!registered || !registered.some((candidate) => normalizedPath(candidate) === normalizedPath(worktreePath))) {
    throw Object.assign(
      new Error(`worktree 目标未以该路径登记到 Git，拒绝复用其它 checkout：${worktreePath}`),
      { code: "WORKTREE_TARGET_REGISTRATION_CONFLICT" },
    );
  }
  const revision = await git(worktreePath, ["rev-parse", "HEAD"]);
  const branch = await git(worktreePath, ["branch", "--show-current"]);
  return {
    revision: revision.ok ? revision.stdout : "",
    branch: branch.ok ? branch.stdout : "",
    detached: branch.ok ? !branch.stdout : false,
    reused: true,
  };
}

async function rollbackExactRegisteredWorktree(sourcePath, targetPath, signal) {
  const registered = await registeredWorktreePaths(sourcePath);
  if (!registered?.some((candidate) => normalizedPath(candidate) === normalizedPath(targetPath))) return false;
  const removed = await git(
    sourcePath,
    ["-c", "core.longpaths=true", "worktree", "remove", "--force", targetPath],
    { timeout: 60_000, retryOnLock: true, signal },
  );
  if (removed.ok && !signal?.aborted) {
    await git(sourcePath, ["worktree", "prune"], { retryOnLock: true, signal });
  }
  return removed.ok;
}

async function checkedOutBranchNames(sourcePath) {
  const listed = await git(sourcePath, ["worktree", "list", "--porcelain"]);
  const names = new Set();
  if (!listed.ok) return names;
  for (const line of listed.stdout.split(/\r?\n/)) {
    const match = /^branch\s+(?:refs\/heads\/)?(.+)$/.exec(line);
    if (match) names.add(match[1]);
  }
  return names;
}

async function branchForExactBase(sourcePath, preferredBranch, baseRevision) {
  const checkedOut = await checkedOutBranchNames(sourcePath);
  for (let attempt = 0; attempt < 100; attempt++) {
    const candidate = attempt === 0 ? preferredBranch : `${preferredBranch}_${attempt + 1}`;
    const existing = await git(sourcePath, ["rev-parse", "--verify", `refs/heads/${candidate}^{commit}`]);
    if (!existing.ok) return { branch: candidate, exists: false };
    // 同 revision 且未被其它 worktree 占用时可复用；占用中或已漂移则换下一个可读后缀。
    if (
      existing.stdout.toLowerCase() === baseRevision.toLowerCase()
      && !checkedOut.has(candidate)
    ) {
      return { branch: candidate, exists: true };
    }
  }
  throw Object.assign(
    new Error(`无法为请求的 revision 分配未漂移分支：${preferredBranch}`),
    { code: "WORKTREE_EXACT_BRANCH_UNAVAILABLE" },
  );
}

async function selectWorktreeBranch(sourcePath, generatedBranch, baseRevision, preferredBranch = "", strictPreferredBranch = false) {
  const preserved = String(preferredBranch || "").trim();
  if (!preserved) return branchForExactBase(sourcePath, generatedBranch, baseRevision);
  const valid = await git(sourcePath, ["check-ref-format", "--branch", preserved]);
  if (!valid.ok) {
    throw Object.assign(
      new Error(`清理前保存的 worktree 分支名无效，无法安全重建：${preserved}`),
      { code: "WORKTREE_PRESERVED_BRANCH_INVALID" },
    );
  }
  const existing = await git(sourcePath, ["rev-parse", "--verify", `refs/heads/${preserved}^{commit}`]);
  if (!existing.ok) return { branch: preserved, exists: false };
  if (existing.stdout.toLowerCase() === baseRevision.toLowerCase()) {
    return { branch: preserved, exists: true };
  }
  if (strictPreferredBranch) {
    throw Object.assign(
      new Error(`清理后分支 ${preserved} 已前移或被改写；为避免静默换分支，请先确认该分支状态后重试`),
      {
        code: "WORKTREE_PRESERVED_BRANCH_MOVED",
        branch: preserved,
        expectedRevision: baseRevision,
        actualRevision: existing.stdout,
      },
    );
  }
  return branchForExactBase(sourcePath, generatedBranch, baseRevision);
}

async function createWorktree({
  sourcePath,
  targetPath,
  tabId,
  repositoryName,
  baseRef,
  baseCommit,
  originalBranch,
  detached,
  preservedBranch,
  strictPreferredBranch,
  generatedBranch: requestedGeneratedBranch = "",
  naming = {},
  signal = null,
}) {
  const source = await repositoryInfo(sourcePath);
  if (isInside(source.repositoryRoot, targetPath)) {
    throw Object.assign(new Error(`worktree 不能创建在原工程目录内：${targetPath}`), { code: "WORKTREE_TARGET_INSIDE_SOURCE" });
  }

  const base = baseCommit || await resolveBaseCommit(sourcePath, baseRef, originalBranch);
  const existing = await currentWorktreeMetadata(targetPath, source.gitCommonDir);
  if (existing) {
    // 没有显式指定 ref 时，确定性的目标目录代表“这个故事点在这个仓库中的工作区”。
    // 用户可能切走主工程后又切回来，此时数据库快照已不含旧 entry，但目录里的提交仍必须保留。
    const reuseLiveBranch = !String(baseRef || "").trim() && detached !== true && !existing.detached;
    if (!reuseLiveBranch && (
      existing.revision.toLowerCase() !== base.revision.toLowerCase()
      || existing.detached !== (detached === true)
    )) {
      throw Object.assign(
        new Error(`现有 worktree 状态与请求不一致：${targetPath}`),
        { code: "WORKTREE_STATE_MISMATCH" },
      );
    }
    return {
      ...source,
      ...existing,
      path: targetPath,
      created: false,
      baseRevision: reuseLiveBranch ? existing.revision : base.revision,
      baseRef: reuseLiveBranch ? existing.branch : base.requestedRef,
      resolvedRef: reuseLiveBranch ? `refs/heads/${existing.branch}` : base.resolvedRef,
      originalBranch: base.originalBranch,
    };
  }

  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  // The atomically reserved directory is also the branch identity. Two
  // concurrent stories therefore cannot race on the same minute-level branch.
  const generatedBranch = String(requestedGeneratedBranch || "").trim()
    || `story/${safeWorktreeDirectorySegment(path.basename(targetPath), "worktree", 96)}`;
  let branch = "";
  let args;
  if (detached) {
    args = ["-c", "core.longpaths=true", "worktree", "add", "--detach", targetPath, base.revision];
  } else {
    const selected = await selectWorktreeBranch(
      sourcePath,
      generatedBranch,
      base.revision,
      preservedBranch,
      strictPreferredBranch === true,
    );
    branch = selected.branch;
    if (selected.exists) await git(sourcePath, ["worktree", "prune"], { retryOnLock: true, signal });
    args = selected.exists
      ? ["-c", "core.longpaths=true", "worktree", "add", targetPath, branch]
      : ["-c", "core.longpaths=true", "worktree", "add", "-b", branch, targetPath, base.revision];
  }
  const added = await git(sourcePath, args, { timeout: 120_000, retryOnLock: true, signal });
  if (!added.ok) {
    if (signal?.aborted) {
      throw Object.assign(
        new Error("worktree 重建租约已失效，已终止创建命令"),
        { code: "WORKTREE_MUTATION_LEASE_LOST" },
      );
    }
    // A failed `git worktree add` does not establish ownership of targetPath.
    // Another process may have won the race, so this path must never remove it.
    throw Object.assign(
      new Error(`创建 Git worktree 失败：${added.stderr || added.stdout || targetPath}`),
      { code: "WORKTREE_CREATE_FAILED" },
    );
  }
  let actual;
  try {
    actual = await currentWorktreeMetadata(targetPath, source.gitCommonDir);
  } catch (error) {
    if (signal?.aborted) {
      throw Object.assign(
        new Error("worktree 重建租约已失效，未执行失租回滚"),
        { code: "WORKTREE_MUTATION_LEASE_LOST" },
      );
    }
    await rollbackExactRegisteredWorktree(sourcePath, targetPath, signal);
    throw error;
  }
  if (!actual || actual.revision.toLowerCase() !== base.revision.toLowerCase() || actual.detached !== (detached === true)) {
    if (signal?.aborted) {
      throw Object.assign(
        new Error("worktree 重建租约已失效，未执行失租回滚"),
        { code: "WORKTREE_MUTATION_LEASE_LOST" },
      );
    }
    await rollbackExactRegisteredWorktree(sourcePath, targetPath, signal);
    throw Object.assign(
      new Error(`worktree 创建后的真实 HEAD 或模式与请求不一致：${targetPath}`),
      { code: "WORKTREE_POST_CREATE_MISMATCH" },
    );
  }
  return {
    ...source,
    path: targetPath,
    branch: actual.branch,
    revision: actual.revision,
    baseRevision: base.revision,
    baseRef: base.requestedRef,
    resolvedRef: base.resolvedRef,
    originalBranch: base.originalBranch,
    detached: detached === true,
    created: true,
    reused: false,
  };
}

function activeWorkspaceEntries(workspace) {
  return (Array.isArray(workspace?.entries) ? workspace.entries : [])
    .filter((entry) => entry && entry.role !== "inactive" && entry.active !== false);
}

function promotionBranchForEntry(workspace, entry, naming) {
  const bundleMember = (workspace?.bundle?.members || [])
    .find((member) => String(member?.repositoryId || "") === String(entry?.repositoryId || ""));
  if (bundleMember?.association !== true) {
    const primaryBranch = String(activeWorkspaceEntries(workspace)
      .find((candidate) => candidate.role === "primary")?.branch || "").trim();
    if (!primaryBranch) {
      throw Object.assign(new Error("Bundle 主工程缺少故事分支，无法为固定成员创建同名分支"), {
        code: "WORKSPACE_MEMBER_PRIMARY_BRANCH_REQUIRED",
      });
    }
    return { branch: primaryBranch, exact: true };
  }
  return {
    branch: buildWorktreeBranchName({
      flavors: Array.isArray(naming?.flavors) ? naming.flavors : [],
      originalBranch: entry.originalBranch || entry.logicalBranch || entry.baseRef,
      ticketId: naming?.ticketId || "",
      createdAt: naming?.createdAt || workspace?.createdAt || Date.now(),
    }),
    exact: false,
  };
}

async function selectPromotionBranch(sourcePath, requestedBranch, revision, { exact = false, signal = null } = {}) {
  const valid = await git(sourcePath, ["check-ref-format", "--branch", requestedBranch], { signal });
  if (!valid.ok) {
    throw Object.assign(new Error(`按需创建的故事分支名无效：${requestedBranch}`), {
      code: "WORKSPACE_MEMBER_BRANCH_INVALID",
    });
  }
  if (!exact) return selectWorktreeBranch(sourcePath, requestedBranch, revision, "", false);
  const checkedOut = await checkedOutBranchNames(sourcePath);
  if (checkedOut.has(requestedBranch)) {
    throw Object.assign(new Error(`故事分支 ${requestedBranch} 已被该仓库的其它 worktree 使用`), {
      code: "WORKSPACE_MEMBER_BRANCH_IN_USE",
      branch: requestedBranch,
    });
  }
  const existing = await git(sourcePath, ["rev-parse", "--verify", `refs/heads/${requestedBranch}^{commit}`], { signal });
  if (!existing.ok) return { branch: requestedBranch, exists: false };
  if (existing.stdout.toLowerCase() !== revision.toLowerCase()) {
    throw Object.assign(
      new Error(`故事分支 ${requestedBranch} 已存在但没有指向只读依赖的冻结提交，拒绝改名或覆盖`),
      {
        code: "WORKSPACE_MEMBER_BRANCH_CONFLICT",
        branch: requestedBranch,
        expectedRevision: revision,
        actualRevision: existing.stdout,
      },
    );
  }
  return { branch: requestedBranch, exists: true };
}

/**
 * AI 获得源码写权限前，把 Bundle 中仍为 detached/READ_ONLY 的关联仓库原位晋升为故事分支。
 * 目录拓扑保持不变；Git、workspace.json、SQLite 与 tab 状态只有全部写入成功后才对 AI 可见。
 */
export async function promoteReadOnlyWorkspaceMembers({
  storyId = "",
  workspace = null,
  naming = {},
  targetRepositoryIds = null,
  operationId = `promote-${randomUUID()}`,
  reason = "AI_SOURCE_WRITE_GRANTED",
  persistWorkspace = null,
  signal = null,
  leaseGuard = null,
} = {}) {
  const story = String(storyId || "").trim();
  if (!story || workspace?.managed !== true || workspace?.bundle?.enabled !== true) {
    throw Object.assign(new Error("按需创建故事分支需要受管 Bundle 工作区"), {
      code: "WORKSPACE_MEMBER_PROMOTION_INVALID",
    });
  }
  if (typeof persistWorkspace !== "function") {
    throw Object.assign(new Error("按需创建故事分支缺少 tab 原子持久化回调"), {
      code: "WORKSPACE_MEMBER_PROMOTION_PERSISTENCE_REQUIRED",
    });
  }
  const integrity = inspectWorkspaceBundleIntegrity(workspace, { pathExists: fs.existsSync });
  if (!integrity.ok) {
    throw Object.assign(new Error(`Bundle 完整性检查失败：${integrity.issues.join("；")}`), {
      code: "WORKSPACE_MEMBER_PROMOTION_INTEGRITY_FAILED",
      issues: integrity.issues,
    });
  }
  const requestedIds = Array.isArray(targetRepositoryIds)
    ? new Set(targetRepositoryIds.map((value) => String(value || "").trim()).filter(Boolean))
    : null;
  const targets = activeWorkspaceEntries(workspace).filter((entry) => (
    entry.mode === WORKSPACE_BUNDLE_READ_ONLY
    && (!requestedIds || requestedIds.has(String(entry.repositoryId || "")))
  ));
  if (!targets.length) return { ok: true, promoted: false, workspace, entries: [] };

  const assertLease = () => {
    if (signal?.aborted || (typeof leaseGuard === "function" && leaseGuard() !== true)) {
      throw Object.assign(new Error("按需创建故事分支期间 worktree 变更租约已失效"), {
        code: "WORKTREE_MUTATION_LEASE_LOST",
      });
    }
  };
  const switched = [];
  let wroteSnapshot = false;
  let wroteDurable = false;
  const rollbackIssues = [];
  const rollback = async () => {
    if (wroteDurable) {
      try { saveStoryWorkspaceBundle(story, workspace); } catch (error) { rollbackIssues.push(`SQLite 回滚失败：${error.message}`); }
    }
    if (wroteSnapshot) {
      try { writeWorkspaceBundleSnapshot(story, workspace, `${operationId}-rollback`); } catch (error) { rollbackIssues.push(`workspace.json 回滚失败：${error.message}`); }
    }
    for (const item of [...switched].reverse()) {
      const detached = await git(item.worktreePath, ["checkout", "--detach", item.revision], {
        retryOnLock: true,
        signal,
      });
      if (!detached.ok) {
        rollbackIssues.push(`${item.repositoryId} 恢复 detached 失败：${detached.stderr || detached.stdout}`);
        continue;
      }
      if (item.created) {
        const removed = await git(item.worktreePath, ["branch", "-D", item.branch], {
          retryOnLock: true,
          signal,
        });
        if (!removed.ok) rollbackIssues.push(`${item.repositoryId} 删除临时分支失败：${removed.stderr || removed.stdout}`);
      }
    }
  };

  try {
    for (const entry of targets) {
      assertLease();
      const rawWorktreePath = String(entry.worktreePath || entry.path || "").trim();
      const rawSourcePath = String(entry.baseRepositoryPath || entry.basePath || "").trim();
      if (!rawWorktreePath || !rawSourcePath || !entry.gitCommonDir) {
        throw Object.assign(new Error(`${entry.name || entry.repositoryId} 缺少 worktree 或基仓身份`), {
          code: "WORKSPACE_MEMBER_PROMOTION_IDENTITY_MISSING",
        });
      }
      const worktreePath = path.resolve(rawWorktreePath);
      const sourcePath = path.resolve(rawSourcePath);
      const actual = await currentWorktreeMetadata(worktreePath, entry.gitCommonDir);
      if (!actual?.detached || actual.branch) {
        throw Object.assign(new Error(`${entry.name || entry.repositoryId} 已不在 detached 只读状态`), {
          code: "WORKSPACE_MEMBER_PROMOTION_STATE_CHANGED",
        });
      }
      const expectedRevision = String(entry.baseRevision || "").trim().toLowerCase();
      if (!expectedRevision || actual.revision.toLowerCase() !== expectedRevision) {
        throw Object.assign(new Error(`${entry.name || entry.repositoryId} 的冻结提交已变化，拒绝自动创建分支`), {
          code: "WORKSPACE_MEMBER_PROMOTION_REVISION_CHANGED",
          expectedRevision,
          actualRevision: actual.revision,
        });
      }
      const status = await git(worktreePath, ["status", "--porcelain=v1", "-uall"], { signal });
      if (!status.ok || status.stdout) {
        throw Object.assign(new Error(`${entry.name || entry.repositoryId} 的只读 worktree 不干净，拒绝自动创建分支`), {
          code: status.ok ? "WORKSPACE_MEMBER_PROMOTION_DIRTY" : "WORKSPACE_MEMBER_PROMOTION_STATUS_FAILED",
        });
      }
      const requested = promotionBranchForEntry(workspace, entry, naming);
      const selected = await selectPromotionBranch(sourcePath, requested.branch, actual.revision, {
        exact: requested.exact,
        signal,
      });
      assertLease();
      const checkout = selected.exists
        ? await git(worktreePath, ["checkout", selected.branch], { retryOnLock: true, signal })
        : await git(worktreePath, ["checkout", "-b", selected.branch, actual.revision], { retryOnLock: true, signal });
      if (!checkout.ok) {
        throw Object.assign(new Error(`创建 ${entry.name || entry.repositoryId} 故事分支失败：${checkout.stderr || checkout.stdout}`), {
          code: "WORKSPACE_MEMBER_PROMOTION_CHECKOUT_FAILED",
        });
      }
      switched.push({
        repositoryId: String(entry.repositoryId),
        worktreePath,
        revision: actual.revision,
        branch: selected.branch,
        created: !selected.exists,
      });
      const verified = await currentWorktreeMetadata(worktreePath, entry.gitCommonDir);
      if (!verified || verified.detached || verified.branch !== selected.branch || verified.revision.toLowerCase() !== actual.revision.toLowerCase()) {
        throw Object.assign(new Error(`${entry.name || entry.repositoryId} 创建分支后的 Git 状态不一致`), {
          code: "WORKSPACE_MEMBER_PROMOTION_POSTCHECK_FAILED",
        });
      }
    }
    assertLease();
    const promotedByRepository = new Map(switched.map((item) => [item.repositoryId, item]));
    const nextEntries = workspace.entries.map((entry) => {
      const promoted = promotedByRepository.get(String(entry?.repositoryId || ""));
      return promoted ? { ...entry, mode: WORKSPACE_BUNDLE_EDITABLE, detached: false, branch: promoted.branch } : entry;
    });
    const nextMembers = workspace.bundle.members.map((member) => (
      promotedByRepository.has(String(member?.repositoryId || ""))
        ? { ...member, mode: WORKSPACE_BUNDLE_EDITABLE }
        : member
    ));
    const promotedAt = Date.now();
    const dependencyChecks = Array.isArray(workspace?.preflight?.dependencyChecks)
      ? workspace.preflight.dependencyChecks.map((check) => (
        promotedByRepository.has(String(check?.repositoryId || ""))
          ? { ...check, mode: WORKSPACE_BUNDLE_EDITABLE, detached: false }
          : check
      ))
      : [];
    const nextWorkspace = {
      ...workspace,
      bundle: { ...workspace.bundle, members: nextMembers },
      preflight: workspace.preflight
        ? { ...workspace.preflight, dependencyChecks, lastWorkspaceMutationAt: promotedAt }
        : workspace.preflight,
      entries: nextEntries,
      updatedAt: promotedAt,
      lastMutationOperationId: operationId,
      promotionHistory: [
        ...(Array.isArray(workspace.promotionHistory) ? workspace.promotionHistory : []),
        ...switched.map((item) => ({
          repositoryId: item.repositoryId,
          fromMode: WORKSPACE_BUNDLE_READ_ONLY,
          toMode: WORKSPACE_BUNDLE_EDITABLE,
          branch: item.branch,
          revision: item.revision,
          reason: String(reason || "AI_SOURCE_WRITE_GRANTED"),
          promotedAt,
        })),
      ].slice(-100),
    };
    const nextIntegrity = inspectWorkspaceBundleIntegrity(nextWorkspace, { pathExists: fs.existsSync });
    if (!nextIntegrity.ok) {
      throw Object.assign(new Error(`晋升后的 Bundle 完整性检查失败：${nextIntegrity.issues.join("；")}`), {
        code: "WORKSPACE_MEMBER_PROMOTION_POST_INTEGRITY_FAILED",
      });
    }
    wroteSnapshot = true;
    writeWorkspaceBundleSnapshot(story, nextWorkspace, operationId);
    saveStoryWorkspaceBundle(story, nextWorkspace);
    wroteDurable = true;
    const persisted = await persistWorkspace(nextWorkspace, workspace);
    if (persisted?.ok !== true) {
      throw Object.assign(new Error(persisted?.error || "故事点工作区状态已变化，拒绝开放 AI 写权限"), {
        code: persisted?.code || "WORKSPACE_MEMBER_PROMOTION_STATE_PERSIST_FAILED",
      });
    }
    return {
      ok: true,
      promoted: true,
      workspace: nextWorkspace,
      tab: persisted.tab || null,
      entries: switched.map((item) => ({ ...item })),
    };
  } catch (error) {
    await rollback();
    if (rollbackIssues.length) {
      error.code = "WORKSPACE_MEMBER_PROMOTION_PARTIAL_ROLLBACK";
      error.rollbackIssues = rollbackIssues;
      error.message = `${error.message}；${rollbackIssues.join("；")}`;
    }
    throw error;
  }
}

/**
 * 为一个故事点创建独立 worktree。repositories 的每一项代表主工程、WebApp 或关联工程。
 * 同一 Git 仓库内的多个路径只创建一个 worktree，并保持相对目录结构。
 */
export async function provisionStoryWorktrees({
  tabId,
  worktreeRoot,
  repositories = [],
  workspaceBundle = null,
  leaseGuard = null,
  signal = null,
  naming = {},
  onWorktreePlanned = null,
  workspacePreflight = null,
} = {}) {
  const assertProvisionLease = () => {
    if (signal?.aborted || (typeof leaseGuard === "function" && leaseGuard() !== true)) {
      throw Object.assign(
        new Error("worktree 重建租约已失效，已停止后续创建"),
        { code: "WORKTREE_MUTATION_LEASE_LOST" },
      );
    }
  };
  assertProvisionLease();
  const storyId = String(tabId || "").trim();
  if (!storyId) throw Object.assign(new Error("缺少故事点 ID"), { code: "WORKTREE_TAB_REQUIRED" });
  const operationId = String(naming?.operationId || "").trim() || randomUUID();
  const provisionNaming = { ...naming, operationId };
  const inputs = (Array.isArray(repositories) ? repositories : [])
    .filter((entry) => entry?.path)
    .map((entry) => ({ ...entry, path: path.resolve(String(entry.path)) }));
  if (!inputs.length) {
    if (workspaceBundle?.enabled === true) {
      throw Object.assign(new Error("Bundle 没有可创建的仓库成员"), {
        code: "WORKSPACE_BUNDLE_MEMBER_MISSING",
      });
    }
    return {
      version: 2,
      namingVersion: 2,
      managed: true,
      operationId,
      root: "",
      entries: [],
      createdAt: Date.now(),
    };
  }

  const infos = [];
  for (const entry of inputs) {
    assertProvisionLease();
    infos.push({ entry, info: await repositoryInfo(entry.path) });
  }
  const bundleValidation = validateWorkspaceBundle(workspaceBundle, {
    definitionId: workspaceBundle?.buildEntryRepositoryId || workspaceBundle?.buildEntryRepoId || "",
  });
  if (!bundleValidation.ok) {
    throw Object.assign(new Error(bundleValidation.error), { code: bundleValidation.code });
  }
  let bundle = bundleValidation.bundle;
  if (bundle) {
    const members = [...bundle.members];
    const repositoryIds = new Set(members.map((member) => member.repositoryId));
    const directoryNames = new Set(members.map((member) => member.checkoutDirName.toLowerCase()));
    for (const { entry, info } of infos) {
      const repositoryId = String(entry.repositoryId || "").trim();
      if (!repositoryId || repositoryIds.has(repositoryId)) continue;
      const requestedDirectory = String(entry.checkoutDirName || "").trim()
        || path.basename(info.repositoryRoot)
        || repositoryId;
      const directory = validateWorkspaceCheckoutDirName(requestedDirectory);
      if (!directory.ok) throw Object.assign(new Error(directory.error), { code: directory.code });
      const directoryKey = directory.name.toLowerCase();
      if (directoryNames.has(directoryKey)) {
        throw Object.assign(
          new Error(`关联工程 ${repositoryId} 的固定目录名与现有 Bundle 成员冲突：${directory.name}`),
          { code: "WORKSPACE_BUNDLE_ASSOCIATION_DIR_CONFLICT" },
        );
      }
      members.push({
        repositoryId,
        checkoutDirName: directory.name,
        required: true,
        mode: WORKSPACE_BUNDLE_EDITABLE,
        association: true,
      });
      repositoryIds.add(repositoryId);
      directoryNames.add(directoryKey);
    }
    bundle = { ...bundle, members };
  }
  if (bundle) {
    const inputRepositoryIds = new Set(infos.map(({ entry }) => String(entry.repositoryId || "").trim()).filter(Boolean));
    const missingIdentity = infos.find(({ entry }) => !String(entry.repositoryId || "").trim());
    if (missingIdentity) {
      throw Object.assign(new Error(`Bundle 成员缺少仓库身份：${missingIdentity.entry.name || missingIdentity.entry.path}`), {
        code: "WORKSPACE_BUNDLE_REPOSITORY_ID_REQUIRED",
      });
    }
    for (const member of bundle.members) {
      if (member.required && !inputRepositoryIds.has(member.repositoryId)) {
        throw Object.assign(
          new Error(`Bundle 缺少必需仓库：${member.repositoryId}`),
          { code: "WORKSPACE_BUNDLE_MEMBER_MISSING" },
        );
      }
    }
    const primary = infos.find(({ entry }) => String(entry.role || "") === "primary");
    if (String(primary?.entry?.repositoryId || "").trim() !== bundle.buildEntryRepositoryId) {
      throw Object.assign(new Error("故事点主仓库不是 Bundle 构建入口"), {
        code: "WORKSPACE_BUNDLE_PRIMARY_MISMATCH",
      });
    }
    const strictRepositoryIds = new Set(bundle.members
      .filter((member) => member.association !== true)
      .map((member) => member.repositoryId));
    const strictInfos = infos.filter(({ entry }) => strictRepositoryIds.has(String(entry.repositoryId || "").trim()));
    const logicalBranches = [...new Set(strictInfos.map(({ entry }) => String(entry.logicalBranch || "").trim()).filter(Boolean))];
    if (bundle.strictBranch && (logicalBranches.length !== 1 || strictInfos.some(({ entry }) => !String(entry.logicalBranch || "").trim()))) {
      throw Object.assign(
        new Error(`Bundle 成员逻辑分支必须完全一致：${logicalBranches.join(", ") || "（空）"}`),
        { code: "WORKSPACE_BUNDLE_BRANCH_MISMATCH" },
      );
    }
    const commonDirOwners = new Map();
    for (const { entry, info } of infos) {
      const key = normalizedPath(info.gitCommonDir);
      const current = commonDirOwners.get(key);
      const repositoryId = String(entry.repositoryId || "").trim();
      if (current && current !== repositoryId) {
        throw Object.assign(
          new Error(`Bundle 仓库 ${current} 与 ${repositoryId} 指向同一个 Git Repository，无法创建两个固定兄弟目录`),
          { code: "WORKSPACE_BUNDLE_REPOSITORY_ALIAS_CONFLICT" },
        );
      }
      commonDirOwners.set(key, repositoryId);
    }
  }
  // 普通故事点保留 WorktreeSpace/<旧目录名>；Bundle 使用
  // WorktreeSpace/<故事点短标识>/<固定成员目录名>。
  const requestedRoot = path.resolve(
    String(worktreeRoot || process.env.DEVBENCH_WORKTREE_ROOT || path.join(path.dirname(infos[0].info.repositoryRoot), WORKTREE_SPACE_DIRNAME)),
  );
  for (const { info } of infos) {
    if (isInside(info.repositoryRoot, requestedRoot)) {
      throw Object.assign(
        new Error(`worktree 根目录不能位于任何原工程内部：${requestedRoot}`),
        { code: "WORKTREE_ROOT_INSIDE_SOURCE" },
      );
    }
  }
  const longestTargetProbe = bundle
    ? path.join(requestedRoot, "W".repeat(48), "W".repeat(64))
    : path.join(requestedRoot, "W".repeat(112));
  let root = requestedRoot;
  let relocatedForWindowsPath = false;
  if (process.platform === "win32" && longestTargetProbe.length >= 180) {
    const rootKey = createHash("sha1").update(requestedRoot).digest("hex").slice(0, 10);
    const shortBases = [
      process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, "AIEfficiency", "devbench-worktrees"),
      path.join(os.tmpdir(), "devbench-worktrees"),
    ].filter(Boolean);
    const shortRoot = shortBases
      .map((base) => path.join(base, rootKey))
      .find((candidate) => infos.every(({ info }) => !isInside(info.repositoryRoot, candidate)));
    if (!shortRoot) {
      throw Object.assign(
        new Error(`Windows 路径过长且找不到安全的短 worktree 根目录：${requestedRoot}`),
        { code: "WORKTREE_SHORT_ROOT_UNAVAILABLE" },
      );
    }
    root = shortRoot;
    relocatedForWindowsPath = true;
  }
  const workspaceDirectoryName = bundle
    ? buildStoryWorkspaceDirectoryName({ storyId, ticketId: provisionNaming.ticketId })
    : "";
  const storyRoot = bundle ? path.join(root, workspaceDirectoryName) : root;
  const prospectiveStoryRoot = prospectivePhysicalPath(storyRoot);
  if (normalizedPath(prospectiveStoryRoot) !== normalizedPath(storyRoot)) {
    throw Object.assign(
      new Error(`worktree 根目录不能经过符号链接或 junction：${storyRoot}`),
      { code: "WORKTREE_ROOT_REPARSE_POINT" },
    );
  }
  for (const { info } of infos) {
    const physicalRepositoryRoot = existingPhysicalPath(info.repositoryRoot);
    if (isInside(physicalRepositoryRoot, prospectiveStoryRoot)) {
      throw Object.assign(
        new Error(`worktree 根目录的真实路径不能位于任何原工程内部：${storyRoot}`),
        { code: "WORKTREE_ROOT_INSIDE_SOURCE" },
      );
    }
  }
  fs.mkdirSync(storyRoot, { recursive: true });
  let storyRootStat;
  try { storyRootStat = fs.lstatSync(storyRoot); } catch {}
  if (storyRootStat?.isSymbolicLink()) {
    throw Object.assign(
      new Error(`worktree 根目录不能是符号链接或 junction：${storyRoot}`),
      { code: "WORKTREE_ROOT_REPARSE_POINT" },
    );
  }
  const physicalStoryRoot = existingPhysicalPath(storyRoot);
  if (normalizedPath(physicalStoryRoot) !== normalizedPath(storyRoot)) {
    throw Object.assign(
      new Error(`worktree 根目录不能经过符号链接或 junction：${storyRoot}`),
      { code: "WORKTREE_ROOT_REPARSE_POINT" },
    );
  }
  for (const { info } of infos) {
    const physicalRepositoryRoot = existingPhysicalPath(info.repositoryRoot);
    if (
      isInside(info.repositoryRoot, storyRoot)
      || isInside(physicalRepositoryRoot, physicalStoryRoot)
    ) {
      throw Object.assign(
        new Error(`worktree 根目录的真实路径不能位于任何原工程内部：${storyRoot}`),
        { code: "WORKTREE_ROOT_INSIDE_SOURCE" },
      );
    }
  }
  const byRepository = new Map();
  const created = [];
  const moved = [];
  let bundlePreflight = null;
  const usedDirectoryNames = new Set();
  const materializeEntries = () => infos.map(({ entry, info }) => {
    const worktree = byRepository.get(normalizedPath(info.gitCommonDir));
    const relativePath = path.relative(info.repositoryRoot, entry.path);
    const targetPath = relativePath && relativePath !== "."
      ? path.join(worktree.path, relativePath)
      : worktree.path;
    const bundleMember = bundle?.members.find((member) => member.repositoryId === String(entry.repositoryId || "").trim()) || null;
    return {
      role: String(entry.role || "extra"),
      baseProjectId: String(entry.baseProjectId || ""),
      repositoryId: String(entry.repositoryId || ""),
      name: String(entry.name || entry.repositoryName || path.basename(entry.path)),
      basePath: entry.path,
      baseRepositoryPath: info.repositoryRoot,
      path: targetPath,
      worktreePath: worktree.path,
      gitCommonDir: info.gitCommonDir,
      branch: worktree.branch || "",
      baseRef: String(entry.baseRef || ""),
      baseRevision: worktree.baseRevision || worktree.revision || "",
      originalBranch: worktree.originalBranch || String(entry.originalBranch || ""),
      logicalBranch: String(entry.logicalBranch || worktree.originalBranch || entry.originalBranch || ""),
      directoryName: path.basename(worktree.path),
      checkoutDirName: bundleMember?.checkoutDirName || "",
      mode: bundleMember?.mode || WORKSPACE_BUNDLE_EDITABLE,
      required: bundleMember?.required !== false,
      detached: worktree.detached === true,
      preferredBranch: String(entry.preferredBranch || ""),
      reused: worktree.reused === true,
    };
  });

  try {
    for (const item of infos) {
      assertProvisionLease();
      const key = normalizedPath(item.info.gitCommonDir);
      if (byRepository.has(key)) continue;
      const bundleMember = bundle?.members.find((member) => member.repositoryId === String(item.entry.repositoryId || "").trim()) || null;
      const label = safeSegment(item.entry.repositoryName || item.entry.name || path.basename(item.info.repositoryRoot), "repo", 44);
      const base = await resolveBaseCommit(item.entry.path, item.entry.baseRef, item.entry.originalBranch);
      const baseDirectoryName = bundleMember?.checkoutDirName || buildWorktreeDirectoryName({
        flavors: provisionNaming.flavors,
        originalBranch: base.originalBranch,
        ticketId: provisionNaming.ticketId,
        createdAt: provisionNaming.createdAt,
      });
      // 目录名：Flavor + 原始分支 + TB/时间；冲突用秒消解，不写故事点指纹。
      // 同故事点复用必须传 existingWorktreePath（路由层会带），避免误占其它故事点目录。
      const requestedExistingPath = String(item.entry.existingWorktreePath || "").trim();
      const allocated = bundle
        ? ensureFixedWorktreeDirectory(
          storyRoot,
          baseDirectoryName,
          usedDirectoryNames,
          {
            existingPath: requestedExistingPath,
            legacyRoot: root,
            tabId: storyId,
            operationId,
            gitCommonDir: item.info.gitCommonDir,
          },
        )
        : await ensureUniqueDirectoryName(
          storyRoot,
          baseDirectoryName,
          usedDirectoryNames,
          {
            existingPath: requestedExistingPath,
            tabId: storyId,
            operationId,
            gitCommonDir: item.info.gitCommonDir,
          },
        );
      let directoryName = allocated.directoryName;
      let generatedTargetPath = allocated.generatedTargetPath;
      usedDirectoryNames.add(directoryName.toLowerCase());
      let targetPath = generatedTargetPath;
      let planPersisted = false;
      const persistWorktreePlan = async () => {
        if (planPersisted) return;
        if (typeof onWorktreePlanned === "function") {
          await onWorktreePlanned({
            role: String(item.entry.role || "extra"),
            basePath: item.entry.path,
            baseProjectId: String(item.entry.baseProjectId || ""),
            repositoryId: String(item.entry.repositoryId || ""),
            worktreePath: generatedTargetPath,
            gitCommonDir: item.info.gitCommonDir,
            directoryName,
            operationId,
            reservationPath: allocated.reservationPath,
          });
          assertProvisionLease();
        }
        planPersisted = true;
      };
      if (requestedExistingPath) {
        const candidate = path.resolve(requestedExistingPath);
        const candidateParent = path.dirname(candidate);
        const allowedCurrentBundle = isStrictlyInside(storyRoot, candidate)
          && normalizedPath(candidateParent) === normalizedPath(storyRoot);
        const allowedLegacyBundleSource = bundle
          && normalizedPath(candidateParent) === normalizedPath(root);
        if (!allowedCurrentBundle && !allowedLegacyBundleSource) {
          throw Object.assign(
            new Error(`已有 worktree 路径不属于当前故事点：${candidate}`),
            { code: "WORKTREE_EXISTING_PATH_OUTSIDE_STORY" },
          );
        }
        await persistWorktreePlan();
        const current = await currentWorktreeMetadata(candidate, item.info.gitCommonDir);
        if (current && path.resolve(candidate) !== path.resolve(generatedTargetPath)) {
          const beforeSnapshot = await captureWorktreeMigrationSnapshot(candidate);
          fs.mkdirSync(path.dirname(generatedTargetPath), { recursive: true });
          const renamed = await git(
            item.entry.path,
            ["worktree", "move", candidate, generatedTargetPath],
            { timeout: 120_000, retryOnLock: true, signal },
          );
          if (!renamed.ok) {
            throw Object.assign(
              new Error(`迁移 worktree 到安全目录名失败：${renamed.stderr || renamed.stdout || candidate}`),
              { code: "WORKTREE_RENAME_FAILED" },
            );
          }
          const verified = await currentWorktreeMetadata(generatedTargetPath, item.info.gitCommonDir).catch(() => null);
          const afterSnapshot = verified
            ? await captureWorktreeMigrationSnapshot(generatedTargetPath).catch(() => null)
            : null;
          if (!verified || !afterSnapshot || JSON.stringify(beforeSnapshot) !== JSON.stringify(afterSnapshot)) {
            await git(
              item.entry.path,
              ["worktree", "move", generatedTargetPath, candidate],
              { timeout: 120_000, retryOnLock: true, signal },
            );
            throw Object.assign(
              new Error(`迁移 worktree 后 Git 状态不一致：${generatedTargetPath}`),
              { code: "WORKTREE_RENAME_VERIFY_FAILED" },
            );
          }
          moved.push({ sourcePath: item.entry.path, from: candidate, to: generatedTargetPath });
          targetPath = generatedTargetPath;
        } else if (current) {
          targetPath = candidate;
        }
      }
      await persistWorktreePlan();
      const provisioned = await createWorktree({
        sourcePath: item.entry.path,
        targetPath,
        tabId: storyId,
        repositoryName: label,
        baseRef: item.entry.baseRef,
        baseCommit: base,
        originalBranch: base.originalBranch,
        detached: bundleMember
          ? bundleMember.mode === WORKSPACE_BUNDLE_READ_ONLY
          : item.entry.detached === true,
        preservedBranch: item.entry.preferredBranch,
        strictPreferredBranch: item.entry.strictPreferredBranch === true,
        generatedBranch: bundle && bundleMember?.mode === WORKSPACE_BUNDLE_EDITABLE
          ? buildWorktreeBranchName({
            ...provisionNaming,
            originalBranch: base.originalBranch,
          })
          : "",
        naming: provisionNaming,
        signal,
      });
      if (provisioned.created) created.push(provisioned);
      assertProvisionLease();
      byRepository.set(key, provisioned);
    }
    if (bundle) {
      const plannedEntries = materializeEntries();
      const parentKeys = new Set(plannedEntries.map((entry) => normalizedPath(path.dirname(entry.worktreePath))));
      const namesMatch = plannedEntries.every((entry) => (
        entry.checkoutDirName
        && path.basename(entry.worktreePath) === entry.checkoutDirName
        && fs.existsSync(entry.worktreePath)
      ));
      if (parentKeys.size !== 1 || !parentKeys.has(normalizedPath(storyRoot)) || !namesMatch) {
        throw Object.assign(new Error("Bundle 创建后固定兄弟目录校验失败"), {
          code: "WORKSPACE_BUNDLE_LAYOUT_INVALID",
        });
      }
      const buildEntry = plannedEntries.find((entry) => entry.repositoryId === bundle.buildEntryRepositoryId)?.path || "";
      let buildValidation = {
        status: "NOT_CONFIGURED",
        ok: null,
        task: "projects",
      };
      if (typeof workspacePreflight === "function") {
        assertProvisionLease();
        let validationResult;
        try {
          validationResult = await workspacePreflight({
            storyId,
            operationId,
            workspaceRoot: storyRoot,
            buildEntry,
            logicalBranch: plannedEntries.find((entry) => entry.role === "primary")?.logicalBranch || "",
            entries: plannedEntries.map((entry) => ({ ...entry })),
            signal,
          });
        } catch (error) {
          throw Object.assign(
            new Error(`Bundle 构建入口预检执行失败：${error?.message || String(error)}`),
            { code: error?.code || "WORKSPACE_BUNDLE_BUILD_PREFLIGHT_FAILED", cause: error },
          );
        }
        assertProvisionLease();
        if (validationResult?.ok !== true) {
          throw Object.assign(
            new Error(validationResult?.error || "Bundle 构建入口 Gradle 配置预检未通过"),
            {
              code: validationResult?.code || "WORKSPACE_BUNDLE_BUILD_PREFLIGHT_FAILED",
              preflight: validationResult || null,
            },
          );
        }
        buildValidation = { ...validationResult, status: validationResult.status || "PASS", ok: true };
      }
      bundlePreflight = {
        status: "PASS",
        checkedAt: Date.now(),
        workspaceRoot: storyRoot,
        buildEntry,
        logicalBranch: plannedEntries.find((entry) => entry.role === "primary")?.logicalBranch || "",
        buildValidation,
        dependencyChecks: plannedEntries.map((entry) => ({
          repositoryId: entry.repositoryId,
          expectedDirectoryName: entry.checkoutDirName,
          resolvedPath: entry.worktreePath,
          exists: true,
          mode: entry.mode,
          detached: entry.detached,
        })),
      };
      writeWorkspaceBundleMetadata(storyRoot, {
        version: 1,
        layoutVersion: WORKSPACE_BUNDLE_VERSION,
        workspaceId: workspaceDirectoryName,
        storyId,
        bundleId: bundle.id,
        logicalBranch: bundlePreflight.logicalBranch,
        buildEntryRepositoryId: bundle.buildEntryRepositoryId,
        rootPath: storyRoot,
        members: plannedEntries.map((entry) => ({
          repositoryId: entry.repositoryId,
          relativeDir: entry.checkoutDirName,
          logicalBranch: entry.logicalBranch,
          checkoutBranch: entry.branch || null,
          checkoutCommit: entry.baseRevision,
          mode: entry.mode,
          required: entry.required,
          worktreePath: entry.worktreePath,
        })),
        preflight: bundlePreflight,
        createdAt: Date.now(),
      }, operationId);
    }
  } catch (error) {
    const canRollback = () => (
      !signal?.aborted
      && (typeof leaseGuard !== "function" || leaseGuard() === true)
    );
    for (const worktree of created.reverse()) {
      if (!canRollback()) break;
      await git(
        worktree.repositoryRoot,
        ["-c", "core.longpaths=true", "worktree", "remove", "--force", worktree.path],
        { timeout: 60_000, retryOnLock: true, signal },
      );
    }
    for (const move of moved.reverse()) {
      if (!canRollback()) break;
      if (fs.existsSync(move.to) && !fs.existsSync(move.from)) {
        await git(
          move.sourcePath,
          ["worktree", "move", move.to, move.from],
          { timeout: 120_000, retryOnLock: true, signal },
        );
      }
    }
    if (bundle) {
      cleanupWorkspaceBundleMetadata(storyRoot);
      try {
        writeWorkspaceBundleFailureMetadata(storyRoot, {
          storyId,
          workspaceId: workspaceDirectoryName,
          bundleId: bundle.id,
          operationId,
          error,
        });
      } catch {}
    }
    throw error;
  }

  const entries = materializeEntries();
  const workspace = {
    version: bundle ? 3 : 2,
    namingVersion: bundle ? 3 : 2,
    layoutVersion: bundle ? WORKSPACE_BUNDLE_VERSION : 1,
    managed: true,
    operationId,
    root: storyRoot,
    requestedRoot,
    relocatedForWindowsPath,
    workspaceId: workspaceDirectoryName || "",
    bundle: bundle ? {
      ...bundle,
      root: storyRoot,
      buildEntryPath: entries.find((entry) => entry.repositoryId === bundle.buildEntryRepositoryId)?.path || "",
    } : null,
    preflight: bundle ? bundlePreflight : null,
    entries,
    createdAt: Date.now(),
  };
  if (bundle) {
    try {
      saveStoryWorkspaceBundle(storyId, workspace);
    } catch (error) {
      for (const worktree of created.reverse()) {
        await git(
          worktree.repositoryRoot,
          ["-c", "core.longpaths=true", "worktree", "remove", "--force", worktree.path],
          { timeout: 60_000, retryOnLock: true, signal },
        );
      }
      for (const move of moved.reverse()) {
        if (fs.existsSync(move.to) && !fs.existsSync(move.from)) {
          await git(
            move.sourcePath,
            ["worktree", "move", move.to, move.from],
            { timeout: 120_000, retryOnLock: true, signal },
          );
        }
      }
      cleanupWorkspaceBundleMetadata(storyRoot);
      try {
        writeWorkspaceBundleFailureMetadata(storyRoot, {
          storyId,
          workspaceId: workspaceDirectoryName,
          bundleId: bundle.id,
          operationId,
          error,
        });
      } catch {}
      throw Object.assign(new Error(`Bundle 持久化失败，已回滚 worktree：${error.message}`), {
        code: "WORKSPACE_BUNDLE_PERSIST_FAILED",
        cause: error,
      });
    }
  }
  return workspace;
}

function textLines(value) {
  return String(value || "").split(/\r?\n/).map((line) => line.trimEnd()).filter(Boolean);
}

function uniqueWorktreeRepositories(worktree) {
  const groups = new Map();
  for (const entry of Array.isArray(worktree?.entries) ? worktree.entries : []) {
    const worktreePath = path.resolve(String(entry?.worktreePath || entry?.path || ""));
    if (!entry?.path || !worktreePath) continue;
    const key = normalizedPath(worktreePath);
    const current = groups.get(key) || {
      name: entry.name || path.basename(worktreePath),
      worktreePath,
      baseRepositoryPath: entry.baseRepositoryPath || entry.basePath || "",
      gitCommonDir: entry.gitCommonDir || "",
      branch: entry.branch || "",
      detached: entry.detached === true,
      baseRevision: entry.baseRevision || "",
      entries: [],
    };
    current.entries.push({
      role: entry.role || "extra",
      name: entry.name || "",
      path: entry.path || "",
      basePath: entry.basePath || "",
    });
    if (entry.role === "primary" || current.entries.length === 1) current.name = entry.name || current.name;
    groups.set(key, current);
  }
  const managedRoot = String(worktree?.root || "").trim();
  return [...groups.values()].map((repository) => {
    const scopeErrors = [];
    if (!managedRoot) {
      scopeErrors.push("受管 worktree 缺少故事点根目录，禁止清理");
    } else if (!isStrictlyInside(managedRoot, repository.worktreePath)) {
      scopeErrors.push(`worktree 目标不在当前故事点根目录内：${repository.worktreePath}`);
    } else if (fs.existsSync(repository.worktreePath)) {
      try {
        if (!fs.existsSync(managedRoot)) {
          scopeErrors.push(`故事点 worktree 根目录不存在：${managedRoot}`);
        } else {
          const realRoot = fs.realpathSync.native(managedRoot);
          const realTarget = fs.realpathSync.native(repository.worktreePath);
          if (!isStrictlyInside(realRoot, realTarget)) {
            scopeErrors.push(`worktree 真实路径越出当前故事点根目录：${repository.worktreePath}`);
          }
        }
      } catch (error) {
        scopeErrors.push(`无法核对 worktree 真实路径：${error.message}`);
      }
    }
    return { ...repository, scopeErrors };
  });
}

async function branchRenameAliases(repoPath, branches) {
  const aliases = new Set((Array.isArray(branches) ? branches : [branches])
    .map((branch) => String(branch || "").trim())
    .filter(Boolean));
  for (const branch of [...aliases]) {
    const reflog = await git(repoPath, ["reflog", "show", "--format=%gs", "--max-count=200", `refs/heads/${branch}`]);
    if (!reflog.ok) continue;
    for (const line of textLines(reflog.stdout)) {
      const renamed = line.match(/^Branch: renamed refs\/heads\/(.+) to refs\/heads\/(.+)$/);
      if (!renamed) continue;
      aliases.add(renamed[1]);
      aliases.add(renamed[2]);
    }
  }
  return aliases;
}

async function relevantStashes(repoPath, branches, storyTitle) {
  const listed = await git(repoPath, ["stash", "list", "--format=%gd%x00%H%x00%gs"]);
  if (!listed.ok) return { stashes: [], error: listed.stderr || "无法读取 stash 列表" };
  const branchAliases = await branchRenameAliases(repoPath, branches);
  const markerTitle = String(storyTitle || "").replace(/[\r\n]+/g, " ").slice(0, 80);
  const marker = markerTitle ? `[devbench] story=${markerTitle}` : "";
  const stashes = [];
  for (const line of textLines(listed.stdout)) {
    const [ref = "", oid = "", ...subjectParts] = line.split("\0");
    const subject = subjectParts.join("\0");
    const match = subject.match(/^(?:WIP on|On)\s+([^:]+):/i);
    const stashBranch = String(match?.[1] || "").trim();
    const belongsToBranch = branchAliases.size
      ? branchAliases.has(stashBranch)
      : stashBranch === "(no branch)";
    const belongsToStory = !!marker && subject.includes(marker);
    if (belongsToBranch || belongsToStory) stashes.push({ ref, oid, subject, branch: stashBranch });
  }
  return { stashes, error: "" };
}

async function unpushedCommits(repoPath, { branch, head, baseRevision }) {
  const revisionRef = branch || head || "HEAD";
  let upstream = "";
  let countArgs = [];
  let logArgs = [];
  let method = "";
  if (branch) {
    const upstreamResult = await git(repoPath, [
      "for-each-ref",
      "--format=%(upstream:short)",
      `refs/heads/${branch}`,
    ]);
    upstream = upstreamResult.ok ? textLines(upstreamResult.stdout)[0] || "" : "";
  }
  if (upstream) {
    countArgs = ["rev-list", "--count", `${upstream}..${revisionRef}`];
    logArgs = ["log", "--format=%h%x09%s", "--max-count=20", `${upstream}..${revisionRef}`];
    method = "upstream";
  } else {
    const remotes = await git(repoPath, ["remote"]);
    if (remotes.ok && textLines(remotes.stdout).length) {
      countArgs = ["rev-list", "--count", revisionRef, "--not", "--remotes"];
      logArgs = ["log", "--format=%h%x09%s", "--max-count=20", revisionRef, "--not", "--remotes"];
      method = "all_remotes";
    } else if (baseRevision && head && baseRevision.toLowerCase() !== head.toLowerCase()) {
      countArgs = ["rev-list", "--count", `${baseRevision}..${revisionRef}`];
      logArgs = ["log", "--format=%h%x09%s", "--max-count=20", `${baseRevision}..${revisionRef}`];
      method = "base_revision";
    } else {
      return { count: 0, commits: [], upstream, method: "base_revision", error: "" };
    }
  }
  const counted = await git(repoPath, countArgs);
  if (!counted.ok || !/^\d+$/.test(counted.stdout)) {
    return {
      count: null,
      commits: [],
      upstream,
      method,
      error: counted.stderr || counted.stdout || "无法确认未推送提交",
    };
  }
  const count = Number(counted.stdout);
  const logged = count ? await git(repoPath, logArgs) : { ok: true, stdout: "" };
  const commits = logged.ok
    ? textLines(logged.stdout).map((line) => {
        const [shortRevision = "", ...subjectParts] = line.split("\t");
        return { shortRevision, subject: subjectParts.join("\t") };
      })
    : [];
  return { count, commits, upstream, method, error: logged.ok ? "" : logged.stderr || "无法读取提交摘要" };
}

async function inspectCleanupRepository(repository, storyTitle) {
  const exists = fs.existsSync(repository.worktreePath);
  let commandPath = exists
    ? repository.worktreePath
    : (repository.baseRepositoryPath ? path.resolve(String(repository.baseRepositoryPath)) : "");
  const result = {
    name: repository.name,
    path: repository.worktreePath,
    baseRepositoryPath: repository.baseRepositoryPath,
    gitCommonDir: repository.gitCommonDir,
    roles: repository.entries.map((entry) => entry.role),
    exists,
    registeredBranch: repository.branch || "",
    branch: repository.branch || "",
    detached: repository.detached === true,
    head: "",
    baseRevision: repository.baseRevision || "",
    dirty: false,
    dirtyCount: 0,
    dirtyFiles: [],
    unpushedCount: 0,
    unpushedCommits: [],
    upstream: "",
    unpushedMethod: "",
    stashCount: 0,
    stashes: [],
    inspectionErrors: [...(repository.scopeErrors || [])],
    blockers: [],
    safe: false,
    forceAllowed: false,
    orphanedDirectory: false,
    retainedDirectory: false,
    orphanReason: "",
  };
  if (result.inspectionErrors.length) {
    for (const message of result.inspectionErrors) {
      result.blockers.push({ type: "inspection", count: 1, message });
    }
    return result;
  }
  if (!repository.gitCommonDir) {
    result.inspectionErrors.push("受管 worktree 缺少 Git common-dir 归属记录");
  }
  let baseInfo = null;
  let baseIdentityValid = false;
  if (repository.baseRepositoryPath && fs.existsSync(repository.baseRepositoryPath)) {
    baseInfo = await repositoryInfo(repository.baseRepositoryPath).catch((error) => {
      result.inspectionErrors.push(`无法核对登记的原仓：${error.message}`);
      return null;
    });
    if (baseInfo) {
      const rootMatches = normalizedPath(baseInfo.repositoryRoot) === normalizedPath(repository.baseRepositoryPath);
      const commonDirMatches = Boolean(repository.gitCommonDir)
        && normalizedPath(baseInfo.gitCommonDir) === normalizedPath(repository.gitCommonDir);
      if (!rootMatches) result.inspectionErrors.push("登记的原仓路径不是 Git 仓库顶层目录");
      if (!commonDirMatches) result.inspectionErrors.push("登记的原仓与 worktree 的 Git common-dir 不一致");
      baseIdentityValid = rootMatches && commonDirMatches;
    }
  } else {
    result.inspectionErrors.push("登记的原仓路径不存在，无法确认 worktree 归属");
  }
  if (!commandPath || !fs.existsSync(commandPath)) {
    result.inspectionErrors.push("原仓和 worktree 均不存在，无法安全核对 Git 状态");
  } else if (exists) {
    let worktreeInfoError = null;
    const info = await repositoryInfo(repository.worktreePath).catch((error) => {
      worktreeInfoError = error;
      return null;
    });
    if (info) {
      if (normalizedPath(info.repositoryRoot) !== normalizedPath(repository.worktreePath)) {
        result.inspectionErrors.push("登记的 worktree 路径不是该仓库的真实顶层目录");
      }
      if (!repository.gitCommonDir || normalizedPath(info.gitCommonDir) !== normalizedPath(repository.gitCommonDir)) {
        result.inspectionErrors.push("worktree 已不属于登记的原仓");
      }
    } else if (
      baseIdentityValid
      && !fs.existsSync(path.join(repository.worktreePath, ".git"))
    ) {
      // worktree 的 Git 指针已丢失时，目录内文件无法再按 Git 状态判断。
      // 清理阶段不删除该目录，只清理原仓中的失效登记，因此这里改从可信原仓核对分支/提交/stash。
      result.orphanedDirectory = true;
      result.retainedDirectory = true;
      result.orphanReason = worktreeInfoError?.message || "worktree 的 .git 指针已丢失";
      commandPath = baseInfo.repositoryRoot;
    } else if (worktreeInfoError) {
      result.inspectionErrors.push(worktreeInfoError.message);
    }
    const revisionRef = result.orphanedDirectory
      ? (repository.branch || repository.baseRevision)
      : "HEAD";
    const head = await git(commandPath, ["rev-parse", "--verify", `${revisionRef}^{commit}`]);
    const branch = result.orphanedDirectory
      ? { ok: true, stdout: repository.branch || "" }
      : await git(commandPath, ["branch", "--show-current"]);
    if (!head.ok) result.inspectionErrors.push(head.stderr || "无法读取 HEAD");
    else result.head = head.stdout;
    if (!branch.ok) result.inspectionErrors.push(branch.stderr || "无法读取当前分支");
    else {
      result.branch = branch.stdout;
      result.detached = !branch.stdout;
    }
    if (!result.orphanedDirectory) {
      const status = await git(commandPath, ["status", "--porcelain", "-uall"]);
      if (!status.ok) result.inspectionErrors.push(status.stderr || "无法读取工作区状态");
      else {
        result.dirtyFiles = textLines(status.stdout).slice(0, 30);
        result.dirtyCount = textLines(status.stdout).length;
        result.dirty = result.dirtyCount > 0;
      }
    }
  } else {
    const ref = repository.branch || repository.baseRevision;
    if (!ref) result.inspectionErrors.push("worktree 已缺失，且没有可核对的分支或 revision");
    else {
      const head = await git(commandPath, ["rev-parse", "--verify", `${ref}^{commit}`]);
      if (!head.ok) result.inspectionErrors.push(head.stderr || `无法读取 ${ref}`);
      else result.head = head.stdout;
    }
  }
  if (commandPath && fs.existsSync(commandPath) && result.head) {
    const unpushed = await unpushedCommits(commandPath, result);
    result.unpushedCount = unpushed.count;
    result.unpushedCommits = unpushed.commits;
    result.upstream = unpushed.upstream;
    result.unpushedMethod = unpushed.method;
    if (unpushed.error) result.inspectionErrors.push(unpushed.error);
    const stash = await relevantStashes(
      commandPath,
      [result.branch, result.registeredBranch],
      storyTitle,
    );
    result.stashes = stash.stashes;
    result.stashCount = stash.stashes.length;
    if (stash.error) result.inspectionErrors.push(stash.error);
  }
  if (result.dirty) {
    result.blockers.push({ type: "dirty", count: result.dirtyCount, message: `${result.dirtyCount} 个未提交文件` });
  }
  if (result.unpushedCount == null) {
    result.blockers.push({ type: "inspection", count: 1, message: "无法确认是否存在未推送提交" });
  } else if (result.unpushedCount > 0) {
    result.blockers.push({ type: "unpushed", count: result.unpushedCount, message: `${result.unpushedCount} 个未推送提交` });
  }
  if (result.stashCount > 0) {
    result.blockers.push({ type: "stash", count: result.stashCount, message: `${result.stashCount} 个未恢复 stash` });
  }
  for (const message of result.inspectionErrors) {
    result.blockers.push({ type: "inspection", count: 1, message });
  }
  result.safe = result.blockers.length === 0;
  result.forceAllowed = result.inspectionErrors.length === 0;
  return result;
}

function cleanupInspectionToken(repositories) {
  const state = repositories.map((repository) => ({
    path: normalizedPath(repository.path),
    exists: repository.exists,
    branch: repository.branch,
    detached: repository.detached,
    head: repository.head,
    dirtyFiles: repository.dirtyFiles,
    unpushedCount: repository.unpushedCount,
    stashes: repository.stashes.map((stash) => `${stash.ref}:${stash.oid}`),
    inspectionErrors: repository.inspectionErrors,
    orphanedDirectory: repository.orphanedDirectory === true,
    retainedDirectory: repository.retainedDirectory === true,
  }));
  return createHash("sha256").update(JSON.stringify(state)).digest("hex");
}

export async function inspectStoryWorktreeCleanup({ worktree, storyTitle = "" } = {}) {
  if (!worktree?.managed) {
    return {
      available: false,
      safe: false,
      forceAllowed: false,
      code: "WORKTREE_NOT_MANAGED",
      error: "当前故事点没有受管 Git worktree",
      repositories: [],
      blockers: [],
      totals: { repositories: 0, dirty: 0, unpushed: 0, stashes: 0, inspectionErrors: 0 },
      token: "",
      inspectedAt: Date.now(),
    };
  }
  const groups = uniqueWorktreeRepositories(worktree);
  if (!groups.length) {
    return {
      available: false,
      safe: false,
      forceAllowed: false,
      code: "WORKTREE_ALREADY_CLEANED",
      error: "当前故事点的 worktree 已清理",
      repositories: [],
      blockers: [],
      totals: { repositories: 0, dirty: 0, unpushed: 0, stashes: 0, inspectionErrors: 0 },
      token: "",
      inspectedAt: Date.now(),
    };
  }
  const repositories = [];
  for (const repository of groups) repositories.push(await inspectCleanupRepository(repository, storyTitle));
  const blockers = repositories.flatMap((repository) => (
    repository.blockers.map((blocker) => ({ ...blocker, repository: repository.name, path: repository.path }))
  ));
  const totals = {
    repositories: repositories.length,
    dirty: repositories.reduce((sum, repository) => sum + repository.dirtyCount, 0),
    unpushed: repositories.reduce((sum, repository) => sum + (repository.unpushedCount || 0), 0),
    stashes: repositories.reduce((sum, repository) => sum + repository.stashCount, 0),
    inspectionErrors: repositories.reduce((sum, repository) => sum + repository.inspectionErrors.length, 0),
  };
  return {
    available: true,
    safe: blockers.length === 0,
    forceAllowed: repositories.every((repository) => repository.forceAllowed === true),
    code: blockers.length ? "WORKTREE_CLEANUP_BLOCKED" : "WORKTREE_CLEANUP_READY",
    repositories,
    blockers,
    totals,
    token: cleanupInspectionToken(repositories),
    inspectedAt: Date.now(),
  };
}

function isStoryOwnedLocalBranch(branch) {
  const name = String(branch || "").trim();
  return name.startsWith("story/");
}

/**
 * 删除故事点专属本地分支（仅 story/）。若仍被其它 worktree 占用则跳过。
 * force=true 时用 -D；安全路径也用 -D（已通过 dirty/未推送闸门），避免未合入主分支导致 -d 失败。
 */
async function deleteStoryOwnedLocalBranch(commandPath, branch, { signal = null } = {}) {
  const name = String(branch || "").trim();
  if (!isStoryOwnedLocalBranch(name)) {
    return { ok: true, skipped: true, reason: "not_story_branch", branch: name };
  }
  if (!commandPath || !fs.existsSync(commandPath)) {
    return { ok: false, skipped: true, reason: "base_missing", branch: name, error: "基仓不存在，无法删除分支" };
  }
  const listed = await git(commandPath, ["worktree", "list", "--porcelain"], { signal });
  if (!listed.ok) {
    return {
      ok: false,
      skipped: true,
      reason: "list_failed",
      branch: name,
      error: listed.stderr || "无法列出 worktree，拒绝删除分支",
    };
  }
  const stillCheckedOut = listed.stdout.split(/\r?\n/).some((line) => (
    line.startsWith("branch refs/heads/") && line.slice("branch refs/heads/".length).trim() === name
  ));
  if (stillCheckedOut) {
    return { ok: true, skipped: true, reason: "still_checked_out", branch: name };
  }
  const exists = await git(commandPath, ["show-ref", "--verify", "--quiet", `refs/heads/${name}`], { signal });
  if (!exists.ok) {
    return { ok: true, skipped: true, reason: "already_gone", branch: name };
  }
  const deleted = await git(commandPath, ["branch", "-D", name], { signal });
  if (!deleted.ok) {
    return {
      ok: false,
      skipped: false,
      reason: "delete_failed",
      branch: name,
      error: deleted.stderr || deleted.stdout || `删除分支失败：${name}`,
    };
  }
  return { ok: true, skipped: false, branch: name };
}

export async function cleanupStoryWorktrees({
  tabId = "",
  worktree,
  storyTitle = "",
  expectedToken = "",
  force = false,
  deleteLocalBranches = false,
  leaseGuard = null,
  ownershipGuard = null,
  signal = null,
} = {}) {
  const inspection = await inspectStoryWorktreeCleanup({ worktree, storyTitle });
  if (!inspection.available) return { ok: false, code: inspection.code, error: inspection.error, inspection };
  if (expectedToken && expectedToken !== inspection.token) {
    return {
      ok: false,
      code: "WORKTREE_CLEANUP_STALE",
      error: "worktree 状态已变化，请重新检查后再清理",
      inspection,
    };
  }
  if (!inspection.safe && !force) {
    return {
      ok: false,
      code: "WORKTREE_CLEANUP_BLOCKED",
      error: "存在未处理的本地改动、未推送提交、stash 或检查错误，禁止清理",
      inspection,
    };
  }
  if (force && inspection.forceAllowed !== true) {
    return {
      ok: false,
      code: "WORKTREE_FORCE_BLOCKED",
      error: "worktree 路径或 Git 归属校验失败，禁止强制删除",
      inspection,
    };
  }
  const leaseAvailable = () => (
    !signal?.aborted
    && (typeof leaseGuard !== "function" || leaseGuard() === true)
  );
  const ownershipAvailable = () => {
    if (typeof ownershipGuard !== "function") return true;
    try { return ownershipGuard() === true; } catch { return false; }
  };
  if (!ownershipAvailable()) {
    return {
      ok: false,
      code: "WORKTREE_SHARED_OWNERSHIP_CONFLICT",
      error: "当前 worktree 同时被其它故事点登记；为避免误删共享 checkout，已停止清理",
      inspection,
      removed: [],
      deletedBranches: [],
    };
  }
  if (!leaseAvailable()) {
    return {
      ok: false,
      code: "WORKTREE_MUTATION_LEASE_LOST",
      error: "worktree 清理租约已失效，未执行删除",
      inspection,
      removed: [],
      deletedBranches: [],
    };
  }
  const removed = [];
  const deletedBranches = [];
  for (const repository of inspection.repositories) {
    if (!ownershipAvailable()) {
      return {
        ok: false,
        partial: removed.length > 0,
        code: "WORKTREE_SHARED_OWNERSHIP_CONFLICT",
        error: "worktree 清理期间检测到其它故事点也登记了该 checkout，已停止后续删除",
        inspection,
        removed,
        deletedBranches,
      };
    }
    if (!leaseAvailable()) {
      return {
        ok: false,
        partial: removed.length > 0,
        code: "WORKTREE_MUTATION_LEASE_LOST",
        error: "worktree 清理租约已失效，已停止后续删除",
        inspection,
        removed,
        deletedBranches,
      };
    }
    const commandPath = fs.existsSync(repository.baseRepositoryPath)
      ? repository.baseRepositoryPath
      : repository.path;
    if (repository.orphanedDirectory) {
      // 目录已经不再是 Git worktree，且可能正被 IDE 占用。保留目录内容，只清理可信原仓中的陈旧登记。
      const pruned = await git(commandPath, ["worktree", "prune", "--expire", "now"], {
        retryOnLock: true,
        signal,
      });
      if (!pruned.ok) {
        return {
          ok: false,
          partial: removed.length > 0,
          code: "WORKTREE_CLEANUP_FAILED",
          error: pruned.stderr || `清理失效 worktree 的 Git 记录失败：${repository.path}`,
          inspection,
          removed,
          deletedBranches,
        };
      }
      removed.push({ ...repository, retainedDirectory: true });
      if (deleteLocalBranches) {
        const branchResult = await deleteStoryOwnedLocalBranch(
          commandPath,
          repository.branch || repository.registeredBranch,
          { signal },
        );
        if (!branchResult.ok) {
          return {
            ok: false,
            partial: true,
            code: "WORKTREE_BRANCH_DELETE_FAILED",
            error: branchResult.error || `删除旧分支失败：${branchResult.branch}`,
            inspection,
            removed,
            deletedBranches,
          };
        }
        if (!branchResult.skipped) deletedBranches.push(branchResult);
      }
      continue;
    }
    if (!repository.exists) {
      const pruned = await git(commandPath, ["worktree", "prune"], { retryOnLock: true, signal });
      if (!pruned.ok) {
        return {
          ok: false,
          partial: removed.length > 0,
          code: "WORKTREE_CLEANUP_FAILED",
          error: pruned.stderr || `清理缺失 worktree 的 Git 记录失败：${repository.path}`,
          inspection,
          removed,
          deletedBranches,
        };
      }
      releaseWorktreeDirectoryReservation(repository.path, repository.gitCommonDir, {
        tabId,
        operationId: worktree?.operationId,
      });
      removed.push({ ...repository, alreadyMissing: true });
      if (deleteLocalBranches) {
        const branchResult = await deleteStoryOwnedLocalBranch(
          commandPath,
          repository.branch || repository.registeredBranch,
          { signal },
        );
        if (!branchResult.ok) {
          return {
            ok: false,
            partial: true,
            code: "WORKTREE_BRANCH_DELETE_FAILED",
            error: branchResult.error || `删除旧分支失败：${branchResult.branch}`,
            inspection,
            removed,
            deletedBranches,
          };
        }
        if (!branchResult.skipped) deletedBranches.push(branchResult);
      }
      continue;
    }
    // 安全清理不带 --force，检查后的竞态写入仍会被 Git 拒绝。
    // 强制清理由 API 层要求显式确认；传两次 --force 以兼容 Git 对锁定 worktree 的保护。
    const result = await git(commandPath, [
      "-c",
      "core.longpaths=true",
      "worktree",
      "remove",
      ...(force ? ["--force", "--force"] : []),
      repository.path,
    ], { timeout: 120_000, retryOnLock: true, signal });
    if (!result.ok) {
      if (!leaseAvailable()) {
        return {
          ok: false,
          partial: removed.length > 0,
          code: "WORKTREE_MUTATION_LEASE_LOST",
          error: "worktree 清理租约已失效，已终止当前删除命令",
          inspection,
          removed,
          deletedBranches,
        };
      }
      return {
        ok: false,
        partial: removed.length > 0,
        code: "WORKTREE_CLEANUP_FAILED",
        error: result.stderr || result.stdout || `清理 worktree 失败：${repository.path}`,
        inspection,
        removed,
        deletedBranches,
      };
    }
    releaseWorktreeDirectoryReservation(repository.path, repository.gitCommonDir, {
      tabId,
      operationId: worktree?.operationId,
    });
    if (!leaseAvailable()) {
      return {
        ok: false,
        partial: true,
        code: "WORKTREE_MUTATION_LEASE_LOST",
        error: "worktree 清理租约已失效，未继续执行后续清理",
        inspection,
        removed: [...removed, repository],
        deletedBranches,
      };
    }
    await git(commandPath, ["worktree", "prune"], { retryOnLock: true, signal });
    removed.push(repository);
    if (deleteLocalBranches) {
      const branchResult = await deleteStoryOwnedLocalBranch(
        commandPath,
        repository.branch || repository.registeredBranch,
        { signal },
      );
      if (!branchResult.ok) {
        return {
          ok: false,
          partial: true,
          code: "WORKTREE_BRANCH_DELETE_FAILED",
          error: branchResult.error || `删除旧分支失败：${branchResult.branch}`,
          inspection,
          removed,
          deletedBranches,
        };
      }
      if (!branchResult.skipped) deletedBranches.push(branchResult);
    }
  }
  if (worktree?.bundle && worktree.root && fs.existsSync(worktree.root)) {
    cleanupWorkspaceBundleMetadata(worktree.root, { removeLogs: true });
  }
  if (worktree.root && fs.existsSync(worktree.root)) {
    try {
      if (fs.readdirSync(worktree.root).length === 0) fs.rmdirSync(worktree.root);
    } catch {}
  }
  if (worktree?.bundle) {
    try {
      deleteStoryWorkspaceBundle(tabId, worktree.workspaceId);
    } catch (error) {
      return {
        ok: false,
        partial: true,
        code: "WORKSPACE_BUNDLE_RECORD_CLEANUP_FAILED",
        error: `worktree 已删除，但 Bundle 恢复记录清理失败：${error.message}`,
        inspection,
        removed,
        deletedBranches,
      };
    }
  }
  return {
    ok: true,
    code: "WORKTREE_CLEANUP_DONE",
    inspection,
    removed,
    deletedBranches,
    forced: force === true,
    cleanedAt: Date.now(),
  };
}

function worktreeEntryIdentity(entry) {
  return `${String(entry?.role || "extra")}|${normalizedPath(entry?.basePath || entry?.path || "")}`;
}

export function mergeCleanedWorktreeEntries(previousEntries = [], currentEntries = []) {
  const merged = new Map();
  for (const entry of [...(previousEntries || []), ...(currentEntries || [])]) {
    if (!entry) continue;
    merged.set(worktreeEntryIdentity(entry), entry);
  }
  return [...merged.values()];
}

export const __test = {
  normalizedPath,
  safeSegment,
  repositoryInfo,
  resolveBaseCommit,
  uniqueWorktreeRepositories,
  branchRenameAliases,
  relevantStashes,
  unpushedCommits,
  selectWorktreeBranch,
  isGitLockError,
  worktreeEntryIdentity,
  isStoryOwnedLocalBranch,
  deleteStoryOwnedLocalBranch,
  worktreeDirectoryReservationPath,
  readWorktreeDirectoryReservation,
  releaseWorktreeDirectoryReservation,
};
