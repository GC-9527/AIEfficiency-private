/**
 * 故事点工程配置变更后的 worktree 重建预览。
 * 主工程 / TB 单号会影响目录名与 story/ 分支名；变更时需删除旧 worktree 再重建。
 * Flavor 仅属于构建配置，不参与 worktree 命名，切换 Flavor 不得触发破坏性重建。
 */
import path from "path";
import { existsSync } from "fs";
import {
  buildWorktreeBranchName,
  buildWorktreeDirectoryName,
} from "./worktree-manager.js";

export function worktreeNamingSignature(naming = {}) {
  return JSON.stringify({
    ticketId: String(naming.ticketId || "").trim().toUpperCase(),
  });
}

/**
 * Bundle 运行时会附带 root/buildEntryPath 等故事点实例字段；安全重建只比较
 * 会改变目录拓扑、分支约束或成员读写模式的声明字段。
 */
export function workspaceBundleTopologySignature(bundle = null) {
  if (!bundle?.enabled) return "";
  return JSON.stringify({
    id: String(bundle.id || "").trim(),
    buildEntryRepositoryId: String(bundle.buildEntryRepositoryId || bundle.buildEntryRepoId || "").trim(),
    layoutPolicy: String(bundle.layoutPolicy?.type || bundle.layoutPolicy || "").trim(),
    branchPolicy: String(bundle.branchPolicy?.type || bundle.branchPolicy || "").trim(),
    strictBranch: bundle.strictBranch === true || bundle.branchPolicy?.strict === true,
    members: (Array.isArray(bundle.members) ? bundle.members : [])
      .filter((member) => member?.association !== true)
      .map((member) => ({
        repositoryId: String(member.repositoryId || member.repoId || "").trim(),
        checkoutDirName: String(member.checkoutDirName || "").trim(),
        required: member.required !== false,
        mode: String(member.mode || member.defaultMode || "EDITABLE").trim().toUpperCase(),
      })),
  });
}

function entryPath(entry) {
  return String(entry?.worktreePath || entry?.path || "").trim();
}

export function listDeletableWorktreeEntries(worktree) {
  const entries = Array.isArray(worktree?.entries) ? worktree.entries : [];
  return entries
    .map((entry) => {
      const target = entryPath(entry);
      return {
        role: entry?.role || "",
        name: entry?.name || path.basename(target) || "worktree",
        path: target,
        basePath: entry?.basePath || "",
        baseProjectId: entry?.baseProjectId || "",
        branch: entry?.branch || "",
        originalBranch: entry?.originalBranch || "",
        exists: !!(target && existsSync(target)),
        inactive: entry?.role === "inactive" || entry?.active === false,
      };
    })
    .filter((entry) => entry.path);
}

/**
 * @param {object} args
 * @param {object} args.tab
 * @param {object} args.nextSnapshot 即将写入的配置快照（含 primaryProjectId / flavors / worktreeNaming 等）
 * @param {object} args.currentNaming worktreeNamingContext(tab, tab)
 * @param {object} args.nextNaming worktreeNamingContext(tab, nextSnapshot)
 * @param {string} [args.nextOriginalBranch] 预估新主工程原始分支（仅展示）
 * @param {boolean} [args.workspaceTopologyChanged] Bundle 开关、成员目录或读写模式发生变化
 */
export function buildWorktreeRebuildPreview({
  tab,
  nextSnapshot = {},
  currentNaming = {},
  nextNaming = {},
  nextOriginalBranch = "",
  workspaceTopologyChanged = false,
} = {}) {
  const managed = !!(tab?.worktree?.managed);
  const deletable = listDeletableWorktreeEntries(tab?.worktree);
  const existing = deletable.filter((entry) => entry.exists);
  if (!managed || !existing.length) {
    return {
      needed: false,
      reasons: [],
      deleteEntries: [],
      currentNaming,
      nextNaming,
      expectedDirectoryName: "",
      expectedBranchName: "",
    };
  }

  const currentPrimary = String(tab?.primaryProjectId || "").trim();
  const hasPrimaryOverride = Object.prototype.hasOwnProperty.call(nextSnapshot, "primaryProjectId")
    || Object.prototype.hasOwnProperty.call(nextSnapshot, "basePrimaryProjectId");
  const nextPrimary = String(
    nextSnapshot.basePrimaryProjectId
      || (hasPrimaryOverride ? nextSnapshot.primaryProjectId : currentPrimary)
      || "",
  ).trim();
  const primaryChanged = !!(nextPrimary && currentPrimary && nextPrimary !== currentPrimary);
  const namingChanged = worktreeNamingSignature(currentNaming) !== worktreeNamingSignature(nextNaming);
  const hasInactive = existing.some((entry) => entry.inactive);

  const reasons = [];
  if (primaryChanged) reasons.push({ code: "primary_changed", label: "主工程已更换，需删除旧主工程 worktree" });
  if (namingChanged) reasons.push({ code: "naming_changed", label: "TB 单号变化，需按新规则重建目录与 story/ 分支名（将删除旧分支）" });
  if (workspaceTopologyChanged) reasons.push({
    code: "workspace_bundle_changed",
    label: "故事点工作区 Bundle 的固定目录或成员读写模式已变化，需安全清理旧 worktree 后重建",
  });
  if (hasInactive && (primaryChanged || namingChanged || workspaceTopologyChanged)) {
    reasons.push({ code: "inactive_cleanup", label: "将一并清理故事点下遗留的 inactive worktree" });
  }

  if (!reasons.length) {
    return {
      needed: false,
      reasons: [],
      deleteEntries: [],
      currentNaming,
      nextNaming,
      expectedDirectoryName: "",
      expectedBranchName: "",
    };
  }

  const originalBranch = String(
    nextOriginalBranch
      || existing.find((entry) => entry.role === "primary" && !entry.inactive)?.originalBranch
      || existing.find((entry) => entry.role === "primary")?.originalBranch
      || "branch",
  ).trim();
  const expectedDirectoryName = buildWorktreeDirectoryName({
    flavors: nextNaming.flavors,
    originalBranch,
    ticketId: nextNaming.ticketId,
    createdAt: nextNaming.createdAt || tab?.createdAt || Date.now(),
  });
  const expectedBranchName = buildWorktreeBranchName({
    flavors: nextNaming.flavors,
    originalBranch,
    ticketId: nextNaming.ticketId,
    createdAt: nextNaming.createdAt || tab?.createdAt || Date.now(),
  });

  return {
    needed: true,
    reasons,
    deleteEntries: existing,
    currentNaming,
    nextNaming,
    expectedDirectoryName,
    expectedBranchName,
    nextPrimaryProjectId: nextPrimary || currentPrimary,
    primaryChanged,
    namingChanged,
    workspaceTopologyChanged: workspaceTopologyChanged === true,
  };
}
