/**
 * 远端执行器（阶段1 的「手脚」）：被中心大脑驱动，在本机的工程根目录(root)内安全执行工具。
 * 工具与本机 API Agent 一致：搜索、分段读取、补丁、Git、测试和长进程。
 * 安全：① root 必须在白名单(配置工程 / cloneParent / executor.allowedRoots)内
 *       ② 文件路径不得越出 root（防 ..）
 *       ③ 调用需 executor.token 鉴权（路由层校验）
 * 脑无关：中心可以是 Claude-API / api-engine / 其它，只要按本协议调 /api/executor/run-tool。
 */
import fs from "fs";
import path from "path";
import { createHash } from "crypto";
import { getConfig } from "./config.js";
import * as store from "./devbench/store.js";
import { executeTool } from "./api-tools.js";
import { ensureExternalTempDirectory } from "./external-temp.js";
import { isStoryTaskAiLeaseActive } from "./devbench/worktree-manager.js";

const norm = (p) => path.resolve(String(p || "")).replace(/[\\/]+/g, "/").replace(/\/+$/, "").toLowerCase();

// 允许被操作的工程根：配置的 devbench 工程路径 + cloneParent + executor.allowedRoots
export function allowedRoots() {
  const cfg = getConfig();
  const roots = new Set();
  try { for (const p of store.listProjects()) { if (p.path) roots.add(norm(p.path)); if (p.webAppPath) roots.add(norm(p.webAppPath)); } } catch {}
  try { const rc = store.getRemoteConfig?.(); if (rc?.cloneParent) roots.add(norm(rc.cloneParent)); } catch {}
  for (const r of (cfg.executor?.allowedRoots || [])) roots.add(norm(r));
  return roots;
}

function isRootAllowed(root) {
  const r = norm(root);
  for (const a of allowedRoots()) { if (r === a || r.startsWith(a + "/")) return true; }
  return false;
}

// 把 p 限制在 root 内，越界抛错
function safeResolve(root, p) {
  const r = path.resolve(root);
  const abs = path.isAbsolute(p || "") ? path.resolve(p) : path.resolve(r, p || ".");
  const rel = path.relative(r, abs);
  if (rel === ".." || rel.startsWith(".." + path.sep) || path.isAbsolute(rel)) throw new Error(`路径越界（须在工程内）: ${p}`);
  return abs;
}

function requiredArtifactScopeField(value, field, maxLength) {
  if (typeof value !== "string") {
    throw new Error(`artifactScope.${field} 必须是字符串`);
  }
  const cleaned = value.trim();
  if (!cleaned || cleaned.length > maxLength || /[\u0000-\u001f\u007f]/.test(cleaned)) {
    throw new Error(`artifactScope.${field} 无效`);
  }
  return cleaned;
}

function normalizeArtifactScope(value) {
  if (value == null) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("artifactScope 必须是对象");
  }
  if (value.kind === "generic") {
    return {
      kind: "generic",
      id: requiredArtifactScopeField(value.id, "id", 240),
    };
  }
  if (value.kind !== "story") {
    throw new Error("artifactScope 仅支持 story 或 generic 逻辑标识");
  }
  return {
    kind: "story",
    id: requiredArtifactScopeField(value.id, "id", 240),
    title: requiredArtifactScopeField(value.title, "title", 1000),
    docSlug: requiredArtifactScopeField(value.docSlug, "docSlug", 240),
  };
}

function safeGenericArtifactId(id) {
  const original = String(id || "");
  const cleaned = original.replace(/[^A-Za-z0-9_.-]+/g, "_").replace(/^[._-]+|[._-]+$/g, "").slice(0, 96);
  const isAlreadySafe = cleaned === original
    && cleaned !== "."
    && cleaned !== ".."
    && !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(cleaned);
  if (isAlreadySafe) return cleaned;
  const digest = createHash("sha256").update(original).digest("hex").slice(0, 12);
  return `${cleaned || "artifact"}-${digest}`;
}

function genericArtifactTempRoot(id, sourceRoot) {
  return ensureExternalTempDirectory(
    ["aiefficiency", "api-artifacts", safeGenericArtifactId(id)],
    { avoidRoots: [sourceRoot] },
  );
}

function artifactContext(value, sourceRoot) {
  const artifactScope = normalizeArtifactScope(value);
  if (!artifactScope) return null;
  if (artifactScope.kind === "generic") {
    const tempRoot = genericArtifactTempRoot(artifactScope.id, sourceRoot);
    return {
      artifactScope,
      allowedDirectory: tempRoot,
      tempRoot,
    };
  }
  const persistedTab = store.getTab(artifactScope.id);
  if (!persistedTab || Object.hasOwn(persistedTab, "closedAt")) {
    throw new Error("artifactScope 对应的活动故事点不存在或已关闭");
  }
  const persistedDocSlug = String(persistedTab.docSlug || store.computeDocSlug(persistedTab));
  if (!persistedDocSlug || artifactScope.docSlug !== persistedDocSlug) {
    throw new Error("artifactScope.docSlug 与活动故事点不匹配");
  }
  const normalizeTitle = (title) => String(title || "").normalize("NFKC").trim().replace(/\s+/g, " ");
  const persistedTitle = normalizeTitle(persistedTab.title);
  const requestedTitle = normalizeTitle(artifactScope.title);
  // 标题允许在故事点存续期间重命名；只有双方标题都仍能映射到冻结 slug 时，
  // 才把差异视为身份不匹配，避免合法的重命名竞态误伤正在运行的任务。
  if (persistedTitle !== requestedTitle
    && store.computeDocSlug({ title: persistedTab.title }) === persistedDocSlug
    && store.computeDocSlug({ title: artifactScope.title }) === persistedDocSlug) {
    throw new Error("artifactScope.title 与活动故事点不匹配");
  }
  const storage = store.getStoryStoragePaths(
    { ...persistedTab, docSlug: persistedDocSlug },
    { create: true, persist: false },
  );
  if (!storage?.storyDirectory || !storage?.tempDirectory) {
    throw new Error("无法推导故事点临时产物目录");
  }
  return {
    artifactScope,
    allowedDirectory: storage.storyDirectory,
    tempRoot: storage.tempDirectory,
    persistedStoryTaskId: String(persistedTab.runningTaskId || "").trim(),
    persistedStoryTab: persistedTab,
  };
}

function verifiedStoryProcessTaskId(scopedArtifacts, requestedTaskId) {
  if (scopedArtifacts?.artifactScope?.kind !== "story") return "";
  const requested = String(requestedTaskId || "").trim();
  const persisted = String(scopedArtifacts.persistedStoryTaskId || "").trim();
  if (!requested) {
    throw new Error("故事点 start_process 缺少 taskId，拒绝启动无法归属的后台进程");
  }
  if (!persisted) {
    throw new Error("故事点当前没有可验证的运行中 AI 任务，拒绝启动后台进程");
  }
  if (requested !== persisted) {
    throw new Error("taskId 与故事点当前运行任务不一致，拒绝启动后台进程");
  }
  if (!isStoryTaskAiLeaseActive(scopedArtifacts.persistedStoryTab, requested)) {
    throw new Error("故事点 taskId 没有对应的活动 AI/worktree 租约，拒绝启动后台进程");
  }
  return requested;
}

/**
 * 在 root 工程内执行一个工具。返回 { ok, result } 或 { ok:false, error }。
 */
export async function runTool(root, name, args = {}, options = {}) {
  if (!root || !fs.existsSync(root)) return { ok: false, error: "工程根目录不存在" };
  if (!isRootAllowed(root)) return { ok: false, error: "该工程不在执行器白名单内（仅允许本机配置的工程/克隆目录）" };
  try {
    // 只接受逻辑产物标识；story 由本机 cloneParent 推导 StoryDev 路径，
    // generic 由本机系统临时目录推导。options.tempRoot 等绝对路径不会参与工具上下文。
    const scopedArtifacts = artifactContext(options.artifactScope, root);
    // safeResolve 保留为本模块的安全边界说明；通用执行器会再次校验 root。
    if (args.path) safeResolve(root, args.path);
    const rootCfg = getConfig();
    const apiCfg = rootCfg.apiAgent || {};
    const distCfg = rootCfg.distributedExecution || {};
    const storyTaskId = name === "start_process"
      ? verifiedStoryProcessTaskId(scopedArtifacts, options.taskId)
      : "";
    const result = await executeTool(name, args, {
      cwd: root,
      allowedRoots: [root, ...(scopedArtifacts ? [scopedArtifacts.allowedDirectory] : [])],
      workspaceIsolation: true,
      commandPolicy: options.commandPolicy || distCfg.commandPolicy || apiCfg.commandPolicy || "trusted",
      signal: options.signal || null,
      ...(scopedArtifacts ? {
        tempRoot: scopedArtifacts.tempRoot,
        artifactScope: scopedArtifacts.artifactScope,
        storyTaskId,
      } : {}),
    });
    if (/^(?:错误|工具执行异常):/.test(String(result))) return { ok: false, error: String(result) };
    return { ok: true, result };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}
