/**
 * devbench「远程拉取」模式：并发 git clone 应用市场 / WebApp / 应用市场SDK 到规则路径，
 * 并 checkout 到配置的远程分支。克隆进度通过 WebSocket 广播（type=devbench_clone_progress）。
 *
 * 路径规则（req 5）：
 *   sourcePlanVersion=2: <父路径>\SourceCache\<仓库>\<分支>-<目标哈希>
 *   legacy:
 *   <父路径>\<车型>\<年月YYYYMM>\AppMarket-<后缀>
 *   <父路径>\<车型>\<年月YYYYMM>\WebApp-<后缀>
 *   <父路径>\<车型>\<年月YYYYMM>\SDKAppMarket-<后缀>
 *   后缀 = TB单号(如 CARB-11650)，无则当前 天小时分钟(DDHHmm)
 */
import { spawn } from "child_process";
import fs from "fs";
import path from "path";
import { broadcastAll } from "../logger.js";
import * as store from "./store.js";
import {
  gitRemoteCandidates,
  resolveAccessibleGitRemote,
  safeGitRemoteError,
} from "./git-remote.js";
import {
  buildSourcePreparationTarget,
  createSourcePreparationService,
  sourcePreparationGitArgs,
} from "./source-preparation.js";
import { expandWorkspaceBundleRemoteEntries } from "./workspace-bundle.js";

const pad = (n) => String(n).padStart(2, "0");
export function dateYm() { const d = new Date(); return `${d.getFullYear()}${pad(d.getMonth() + 1)}`; }
export function dateDdhhmm() { const d = new Date(); return `${pad(d.getDate())}${pad(d.getHours())}${pad(d.getMinutes())}`; }
const normPath = (p) => String(p || "").replace(/[\\/]+/g, "/").replace(/\/+$/, "").toLowerCase();

// 克隆目录：<父路径>\<车型>\<年月>\<工程名>-<后缀>
const safeSeg = (s) => String(s || "").replace(/[\\/:*?"<>|]+/g, "").trim() || "proj";
export function cloneDirFor(parent, vehicle, projName, suffix) {
  return path.join(String(parent || "").trim(), safeSeg(vehicle) || "vehicle", dateYm(), `${safeSeg(projName)}-${suffix}`);
}

export function assignRemotePullRoles(entries = []) {
  const rows = Array.isArray(entries) ? entries : [];
  const explicitPrimaryIndex = rows.findIndex(
    (entry) => String(entry?.targetRole || "").trim().toLowerCase() === "primary",
  );
  const explicitStandaloneIndex = rows.findIndex(
    (entry) => String(entry?.targetRole || "").trim().toLowerCase() === "standalone",
  );
  const explicitAnchorIndex = explicitPrimaryIndex >= 0 ? explicitPrimaryIndex : explicitStandaloneIndex;
  let legacyPrimaryAssigned = false;
  return rows.map((entry, index) => {
    const explicitRole = String(entry?.targetRole || "").trim().toLowerCase();
    if (index === explicitAnchorIndex) return "primary";
    if (explicitRole === "webapp" || entry?.projectId === "webApp" || entry?.repositoryId === "webApp") return "webapp";
    // 仅旧版没有 targetRole 的数据按首个普通工程回退；显式 dependency 不能因排序靠前
    // 被提升为主工程；显式 primary 或 standalone 即使排在后面也始终是唯一执行锚点。
    if (explicitAnchorIndex < 0 && !explicitRole && !legacyPrimaryAssigned) {
      legacyPrimaryAssigned = true;
      return "primary";
    }
    return "extra";
  });
}

function localProjectForClone(main, web) {
  const existing = store.listProjects().find((p) => normPath(p.path) === normPath(main.path));
  const r = store.upsertProject({
    id: existing?.id,
    name: existing?.name || main.name,
    path: main.path,
    webAppPath: web?.path || existing?.webAppPath || "",
  });
  if (r.ok) return r.project;
  return existing || null;
}

export function localizeCompletedRemoteTab(tab, remoteRepos = tab.remoteRepos || [], options = {}) {
  if (!tab || tab.mode !== "remote" || !Array.isArray(remoteRepos) || !remoteRepos.length) return {};
  if (!options.force && tab.remoteLocalizedAt) return {};
  if (!remoteRepos.every((r) => r.ok)) return {};
  const main = remoteRepos.find((r) => r.role === "primary" && r.ok && r.path);
  if (!main) return {};
  const web = remoteRepos.find((r) => r.role === "webapp" && r.ok && r.path);
  const project = localProjectForClone(main, web);
  if (!project) return {};
  const extras = remoteRepos
    .filter((r) => r.role === "extra" && r.ok && r.path)
    .map((r) => ({ path: r.path, name: r.name || r.path }));
  const existingExtras = Array.isArray(tab.extraProjects) ? tab.extraProjects : [];
  const extraProjects = [...existingExtras];
  for (const ex of extras) {
    if (!extraProjects.some((item) => normPath(item.path) === normPath(ex.path))) extraProjects.push(ex);
  }
  const flavorByPath = remoteRepos.flatMap((repo) => {
    if (!repo?.ok || !repo.path) return [];
    const consumerFlavors = Array.isArray(repo.consumers)
      ? [...new Set(repo.consumers.map((consumer) => String(consumer?.flavor || "").trim()).filter(Boolean))]
      : [];
    const flavors = consumerFlavors.length ? consumerFlavors : [String(repo.flavor || "").trim()].filter(Boolean);
    return flavors.map((flavor) => ({ path: repo.path, flavor }));
  });
  return {
    mode: "local",
    primaryProjectId: project.id,
    extraProjects,
    flavors: flavorByPath,
    apkSourcePath: tab.apkSourcePath || main.path,
    remoteLocalizedAt: Date.now(),
  };
}

const CLONE_ENV = { GIT_TERMINAL_PROMPT: "0", GIT_SSH_COMMAND: "ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new" };

const sourcePreparation = createSourcePreparationService({
  // Cache/known-checkout reuse stays offline. Only a real cache miss resolves
  // the accessible transport, preserving the legacy HTTPS -> SSH fallback.
  resolveCloneUrl: async ({ repository }) => {
    const remote = { https: repository?.https, ssh: repository?.ssh };
    const access = await resolveAccessibleGitRemote(remote);
    if (!access.ok) return access;
    const url = gitRemoteCandidates(remote)[access.candidateIndex] || "";
    return {
      ok: Boolean(url),
      url,
      transport: access.transport,
      error: url ? "" : "未找到可用的远程仓库地址",
    };
  },
});

// 单仓库 clone（--progress 流式进度，--branch 直接检出目标远程分支）
function cloneRepo(url, dir, branch, onProgress) {
  return new Promise((resolve) => {
    const args = ["clone", "--progress"];
    if (branch) args.push("--branch", branch);
    args.push(url, dir);
    let child;
    try {
      child = spawn("git", sourcePreparationGitArgs(args), { windowsHide: true, env: { ...process.env, ...CLONE_ENV } });
    } catch (e) { return resolve({ ok: false, error: e.message }); }
    let stderr = "";
    child.stderr.on("data", (d) => {
      const s = d.toString();
      stderr += s;
      if (stderr.length > 20000) stderr = stderr.slice(-10000);
      for (const line of s.split(/[\r\n]+/)) {
        const m = line.match(/(Receiving objects|Resolving deltas|Counting objects|Compressing objects|Updating files):\s+(\d+)%/);
        if (m) onProgress({ phase: m[1], percent: Number(m[2]) });
      }
    });
    child.on("error", (e) => resolve({ ok: false, error: e.message }));
    child.on("close", (code) => resolve(code === 0 ? { ok: true } : { ok: false, error: (stderr || "git clone 失败").trim().slice(-400) }));
  });
}

/**
 * 执行某故事点的远程初始化：按 tab.remotePull 配置并发 clone（应用市场必拉，WebApp/SDK 按勾选），
 * checkout 到配置分支；进度经 WS 广播；结束后仅把验证过的缓存路径写入 tab.remoteRepos。
 * 故事点必须由路由层继续创建 managed worktree，成功后才能发布 cloneStatus=done/mode=local。
 * 返回 { ok, remoteRepos, error? }。
 */
export async function runRemoteInit(tab, options = {}) {
  const leaseGuard = typeof options.leaseGuard === "function" ? options.leaseGuard : null;
  const signal = options.signal || null;
  const onProgress = typeof options.onProgress === "function" ? options.onProgress : null;
  const assertLease = () => {
    if (!leaseGuard) return;
    if (signal?.aborted || leaseGuard() !== true) {
      throw Object.assign(new Error("源码初始化租约已失效，拒绝写回旧状态"), {
        code: "STORY_SOURCE_INITIALIZATION_LEASE_LOST",
      });
    }
  };
  assertLease();
  const cfg = store.getRemoteConfig();
  const rp = tab.remotePull || {};
  const vehicle = (rp.vehicle || "vehicle").trim();
  const suffix = (rp.tbId || "").trim() || dateDdhhmm();
  const parent = cfg.cloneParent;
  const sourcePlanV2 = Number(rp.sourcePlanVersion) === 2;

  // 远程拉取条目：来自车型映射 entries（兼容旧 appMarketBranch/needWebApp/needSdk）
  let entries = Array.isArray(rp.entries)
    ? rp.entries.filter((e) => e && (e.repositoryId || e.projectId))
    : [];
  if (!entries.length) {
    if (rp.appMarketBranch) entries.push({ projectId: "appMarket", branch: rp.appMarketBranch, flavor: vehicle });
    if (rp.needWebApp) entries.push({ projectId: "webApp", branch: rp.webAppBranch || rp.appMarketBranch || "", flavor: vehicle });
    if (rp.needSdk) entries.push({ projectId: "appMarketSdk", branch: rp.sdkBranch || "", flavor: vehicle });
  }

  // Bundle 配置属于共享仓库定义。远程故事点必须在 clone 前补齐强依赖，
  // 不能等主仓准备完成后才发现缺少固定兄弟仓库。
  ({ entries } = expandWorkspaceBundleRemoteEntries(entries, store.getProjectDefs()));

  // 显式 targetRole 优先；仅没有角色的旧数据保留“首个普通工程为主工程”的兼容行为。
  const assignedRoles = assignRemotePullRoles(entries);
  const jobs = entries.map((e, index) => {
    const projectId = String(e.repositoryId || e.projectId || "").trim();
    const def = store.getProjectDef(projectId);
    const projName = def?.name || projectId;
    const projectType = String(e.projectType || def?.projectType || "application").trim();
    const repositoryOnly = e.repositoryOnly === true || ["sdk", "tooling", "service", "repository"].includes(projectType);
    const role = assignedRoles[index];
    const branch = String(e.branch || "").trim();
    let dir = cloneDirFor(parent, vehicle, projName, suffix);
    if (sourcePlanV2) {
      try {
        dir = buildSourcePreparationTarget({ cloneParent: parent, repositoryId: projectId, branch }).targetPath;
      } catch {
        dir = "";
      }
    }
    return {
      key: projectId,
      repositoryId: projectId,
      targetId: String(e.targetId || "").trim(),
      remote: def ? { ssh: def.ssh, https: def.https } : null,
      repository: def || null,
      dir,
      branch,
      flavor: String(e.flavor || (repositoryOnly ? "" : vehicle)).trim(),
      consumers: Array.isArray(e.consumers)
        ? e.consumers.filter((consumer) => consumer && typeof consumer === "object").map((consumer) => ({ ...consumer }))
        : [],
      projectType,
      repositoryOnly,
      targetRole: String(e.targetRole || "").trim(),
      role,
      name: sourcePlanV2 ? safeSeg(projName) : `${safeSeg(projName)}-${suffix}`,
      sourcePlanVersion: sourcePlanV2 ? 2 : 1,
    };
  });

  const emit = (repo, patch) => {
    try { onProgress?.({ repo, ...patch }); } catch {}
    if (!tab.id) return;
    try { broadcastAll(JSON.stringify({ type: "devbench_clone_progress", data: { tabId: tab.id, repo, ...patch } })); } catch {}
  };

  if (tab.id) store.updateTab(tab.id, { cloneStatus: "cloning", cloneError: null });
  emit("__all__", { status: "cloning", started: true });

  const results = await Promise.all(jobs.map(async (j) => {
    emit(j.key, { status: "cloning", percent: 0, phase: "准备", name: j.name, branch: j.branch, dir: j.dir });
    if (!j.remote?.ssh && !j.remote?.https) {
      emit(j.key, { status: "error", error: "未配置远程地址" });
      return { ...j, ok: false, error: "未配置远程地址", path: j.dir };
    }
    if (sourcePlanV2) {
      emit(j.key, {
        status: "cloning",
        percent: 0,
        phase: "校验本机源码缓存",
        name: j.name,
        branch: j.branch,
        dir: j.dir,
      });
      let knownCheckouts = [];
      try { knownCheckouts = store.getLocalCheckouts(j.key); } catch {}
      const prepared = await sourcePreparation.prepare({
        cloneParent: parent,
        target: {
          targetId: j.targetId,
          repositoryId: j.repositoryId,
          branch: j.branch,
        },
        repository: j.repository,
        knownCheckouts,
        onProgress: (progress) => emit(j.key, {
          status: "cloning",
          name: j.name,
          branch: j.branch,
          dir: j.dir,
          ...progress,
        }),
      });
      const error = prepared.ok ? null : prepared.error || "源码准备失败";
      emit(j.key, {
        status: prepared.ok ? "done" : "error",
        percent: prepared.ok ? 100 : undefined,
        error,
        errorCode: prepared.ok ? null : prepared.code || "SOURCE_PREPARATION_FAILED",
        name: j.name,
        branch: j.branch,
        dir: prepared.path || j.dir,
        preparationStatus: prepared.status,
        source: prepared.source || null,
      });
      return {
        ...j,
        ok: prepared.ok,
        error,
        errorCode: prepared.ok ? null : prepared.code || "SOURCE_PREPARATION_FAILED",
        path: prepared.path || j.dir,
        preparationStatus: prepared.status,
        reused: prepared.reused === true,
        cloned: prepared.cloned === true,
        source: prepared.source || null,
        targetKey: prepared.targetKey || null,
        targetHash: prepared.targetHash || null,
        targetPath: prepared.targetPath || j.dir,
        candidatePath: prepared.candidatePath || null,
        transport: prepared.transport || null,
      };
    }
    if (fs.existsSync(j.dir) && fs.readdirSync(j.dir).length > 0) {
      emit(j.key, { status: "error", error: "目标目录已存在且非空" });
      return { ...j, ok: false, error: "目标目录已存在且非空", path: j.dir };
    }
    emit(j.key, { status: "cloning", percent: 0, phase: "验证仓库访问", name: j.name, branch: j.branch, dir: j.dir });
    const access = await resolveAccessibleGitRemote(j.remote);
    if (!access.ok) {
      emit(j.key, { status: "error", error: access.error || "远程仓库不可访问" });
      return { ...j, ok: false, error: access.error || "远程仓库不可访问", path: j.dir };
    }
    const remoteUrl = gitRemoteCandidates(j.remote)[access.candidateIndex] || access.url;
    const r = await cloneRepo(remoteUrl, j.dir, j.branch, (p) => emit(j.key, { status: "cloning", name: j.name, branch: j.branch, ...p }));
    const cloneError = r.ok ? null : safeGitRemoteError(r.error, remoteUrl);
    emit(j.key, { status: r.ok ? "done" : "error", percent: r.ok ? 100 : undefined, error: cloneError, name: j.name, branch: j.branch, dir: j.dir });
    return { ...j, url: access.url, transport: access.transport, ok: r.ok, error: cloneError, path: j.dir };
  }));

  const allOk = results.every((r) => r.ok);
  const remoteRepos = results.map((r) => ({
    key: r.key,
    path: r.path,
    name: r.name,
    role: r.role,
    targetRole: r.targetRole,
    ...(r.sourcePlanVersion === 2 ? {
      sourcePlanVersion: 2,
      targetId: r.targetId || null,
      repositoryId: r.repositoryId,
      consumers: r.consumers,
      preparationStatus: r.preparationStatus,
      reused: r.reused,
      cloned: r.cloned,
      source: r.source,
      targetKey: r.targetKey,
      targetHash: r.targetHash,
      targetPath: r.targetPath,
      candidatePath: r.candidatePath,
      transport: r.transport,
    } : {}),
    projectType: r.projectType,
    repositoryOnly: r.repositoryOnly,
    branch: r.branch,
    flavor: r.flavor || null,
    ok: r.ok,
    error: r.error || null,
    errorCode: r.errorCode || null,
  }));
  const cloneError = summarizeRemoteInitializationFailures(remoteRepos);
  assertLease();
  if (tab.id) {
    store.updateTab(tab.id, {
      remoteRepos,
      cloneStatus: allOk ? "cloning" : "error",
      cloneError: allOk ? null : cloneError,
    });
  }
  // 成功克隆的工程记录到当前客户端本地，供后续复用为本地源码
  for (const r of remoteRepos) {
    if (r.ok && r.path) {
      try { store.recordLocalCheckout(r.key, { path: r.path, name: r.name, vehicle, tbId: suffix, branch: r.branch }); } catch {}
    }
  }
  emit("__all__", allOk
    ? { status: "cloning", done: false, sourcePrepared: true, phase: "准备故事点独立工作区" }
    : { status: "error", done: true, error: cloneError });
  return { ok: allOk, remoteRepos, error: allOk ? null : cloneError };
}

function conciseRemoteInitializationError(value, maxLength = 420) {
  const normalized = String(value || "仓库初始化失败").replace(/\s+/g, " ").trim();
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength - 1)}…` : normalized;
}

export function summarizeRemoteInitializationFailures(remoteRepos = [], fallback = "部分仓库克隆失败") {
  const failures = (Array.isArray(remoteRepos) ? remoteRepos : []).filter((repo) => repo?.ok === false);
  if (!failures.length) return fallback;
  return failures.map((repo) => {
    const name = String(repo.name || repo.key || repo.repositoryId || "未知仓库").trim();
    const branch = String(repo.branch || "").trim();
    const label = branch ? `${name}（${branch}）` : name;
    return `${label}：${conciseRemoteInitializationError(repo.error)}`;
  }).join("；").slice(0, 1000);
}
