import { createHash } from "node:crypto";
import path from "node:path";

export const WORKSPACE_BUNDLE_VERSION = 2;
export const WORKSPACE_BUNDLE_FEATURE_FLAG = "workspace.bundle.v2";
export const WORKSPACE_BUNDLE_LAYOUT = "SAME_PARENT_SIBLINGS";
export const WORKSPACE_BUNDLE_BRANCH_POLICY = "SAME_LOGICAL_BRANCH";
export const WORKSPACE_BUNDLE_EDITABLE = "EDITABLE";
export const WORKSPACE_BUNDLE_READ_ONLY = "READ_ONLY";

const WINDOWS_RESERVED_NAMES = new Set([
  "con", "prn", "aux", "nul",
  "com1", "com2", "com3", "com4", "com5", "com6", "com7", "com8", "com9",
  "lpt1", "lpt2", "lpt3", "lpt4", "lpt5", "lpt6", "lpt7", "lpt8", "lpt9",
]);

function text(value) {
  return String(value || "").trim();
}

function list(value) {
  return Array.isArray(value) ? value : [];
}

function policyType(value, fallback) {
  return text(value && typeof value === "object" ? value.type : value).toUpperCase() || fallback;
}

export function validateWorkspaceCheckoutDirName(value) {
  const name = text(value);
  if (!name) return { ok: false, code: "WORKSPACE_BUNDLE_DIR_REQUIRED", error: "固定目录名不能为空" };
  if (name.length > 64) return { ok: false, code: "WORKSPACE_BUNDLE_DIR_TOO_LONG", error: `固定目录名不能超过 64 个字符：${name}` };
  if (name === "." || name === ".." || /[\\/:*?"<>|\u0000-\u001f]/.test(name)) {
    return { ok: false, code: "WORKSPACE_BUNDLE_DIR_INVALID", error: `固定目录名包含路径或非法字符：${name}` };
  }
  if (/[. ]$/.test(name)) {
    return { ok: false, code: "WORKSPACE_BUNDLE_DIR_INVALID", error: `固定目录名不能以点或空格结尾：${name}` };
  }
  const stem = name.split(".")[0].toLowerCase();
  if (WINDOWS_RESERVED_NAMES.has(stem)) {
    return { ok: false, code: "WORKSPACE_BUNDLE_DIR_RESERVED", error: `固定目录名是 Windows 保留名称：${name}` };
  }
  return { ok: true, name };
}

export function normalizeWorkspaceBundle(input = {}, { definitionId = "" } = {}) {
  if (!input || typeof input !== "object" || input.enabled !== true) return null;
  const buildEntryRepositoryId = text(input.buildEntryRepositoryId || input.buildEntryRepoId || definitionId);
  const members = [];
  for (const raw of list(input.members)) {
    if (!raw || typeof raw !== "object") continue;
    const repositoryId = text(raw.repositoryId || raw.repoId);
    if (!repositoryId) continue;
    const rawMode = text(raw.mode || raw.defaultMode).toUpperCase();
    members.push({
      repositoryId,
      checkoutDirName: text(raw.checkoutDirName || raw.relativeDir),
      required: raw.required !== false,
      mode: rawMode === WORKSPACE_BUNDLE_READ_ONLY ? WORKSPACE_BUNDLE_READ_ONLY : WORKSPACE_BUNDLE_EDITABLE,
      ...(raw.association === true ? { association: true } : {}),
    });
  }
  return {
    version: WORKSPACE_BUNDLE_VERSION,
    featureFlag: WORKSPACE_BUNDLE_FEATURE_FLAG,
    enabled: true,
    id: text(input.id) || `${buildEntryRepositoryId || "workspace"}-bundle`,
    buildEntryRepositoryId,
    layoutPolicy: policyType(input.layoutPolicy, WORKSPACE_BUNDLE_LAYOUT),
    branchPolicy: policyType(input.branchPolicy, WORKSPACE_BUNDLE_BRANCH_POLICY),
    strictBranch: input.strictBranch !== false && input.branchPolicy?.strict !== false,
    members,
  };
}

export function validateWorkspaceBundle(input = {}, {
  definitionId = "",
  knownRepositoryIds = [],
} = {}) {
  const bundle = normalizeWorkspaceBundle(input, { definitionId });
  if (!bundle) return { ok: true, bundle: null };
  if (bundle.layoutPolicy !== WORKSPACE_BUNDLE_LAYOUT) {
    return { ok: false, code: "WORKSPACE_BUNDLE_LAYOUT_UNSUPPORTED", error: "工作区 Bundle 仅支持同父目录兄弟仓库布局" };
  }
  if (bundle.branchPolicy !== WORKSPACE_BUNDLE_BRANCH_POLICY) {
    return { ok: false, code: "WORKSPACE_BUNDLE_BRANCH_POLICY_UNSUPPORTED", error: "工作区 Bundle 仅支持相同逻辑分支策略" };
  }
  if (!bundle.strictBranch) {
    return { ok: false, code: "WORKSPACE_BUNDLE_STRICT_BRANCH_REQUIRED", error: "工作区 Bundle 必须严格使用相同逻辑分支" };
  }
  if (!bundle.buildEntryRepositoryId) {
    return { ok: false, code: "WORKSPACE_BUNDLE_BUILD_ENTRY_REQUIRED", error: "工作区 Bundle 缺少构建入口仓库" };
  }
  if (definitionId && bundle.buildEntryRepositoryId !== text(definitionId)) {
    return { ok: false, code: "WORKSPACE_BUNDLE_BUILD_ENTRY_MISMATCH", error: "Bundle 必须配置在其构建入口仓库定义上" };
  }
  if (bundle.members.length === 0) {
    return { ok: false, code: "WORKSPACE_BUNDLE_MEMBERS_REQUIRED", error: "工作区 Bundle 至少需要一个成员仓库" };
  }
  if (!bundle.members.some((member) => member.repositoryId === bundle.buildEntryRepositoryId)) {
    return { ok: false, code: "WORKSPACE_BUNDLE_BUILD_ENTRY_MISSING", error: "Bundle 成员中缺少构建入口仓库" };
  }
  const known = new Set(list(knownRepositoryIds).map(text).filter(Boolean));
  const repositoryIds = new Set();
  const directoryNames = new Set();
  for (const member of bundle.members) {
    if (repositoryIds.has(member.repositoryId)) {
      return { ok: false, code: "WORKSPACE_BUNDLE_REPOSITORY_DUPLICATE", error: `Bundle 成员仓库重复：${member.repositoryId}` };
    }
    repositoryIds.add(member.repositoryId);
    if (known.size && !known.has(member.repositoryId)) {
      return { ok: false, code: "WORKSPACE_BUNDLE_REPOSITORY_UNKNOWN", error: `Bundle 引用了不存在的仓库：${member.repositoryId}` };
    }
    const directory = validateWorkspaceCheckoutDirName(member.checkoutDirName);
    if (!directory.ok) return directory;
    const key = directory.name.toLowerCase();
    if (directoryNames.has(key)) {
      return { ok: false, code: "WORKSPACE_BUNDLE_DIR_DUPLICATE", error: `Bundle 固定目录名重复：${directory.name}` };
    }
    directoryNames.add(key);
  }
  const buildEntry = bundle.members.find((member) => member.repositoryId === bundle.buildEntryRepositoryId);
  if (buildEntry.required === false) {
    return { ok: false, code: "WORKSPACE_BUNDLE_BUILD_ENTRY_OPTIONAL", error: "构建入口仓库必须是必需成员" };
  }
  if (buildEntry.mode !== WORKSPACE_BUNDLE_EDITABLE) {
    return { ok: false, code: "WORKSPACE_BUNDLE_BUILD_ENTRY_READ_ONLY", error: "构建入口仓库必须可修改" };
  }
  return { ok: true, bundle };
}

function safeWorkspaceSegment(value, fallback = "story", maxLength = 40) {
  const clean = text(value)
    .normalize("NFKC")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^[.-]+|[.-]+$/g, "")
    .slice(0, maxLength)
    .replace(/[.-]+$/g, "");
  return clean || fallback;
}

export function buildStoryWorkspaceDirectoryName({ storyId = "", ticketId = "" } = {}) {
  const story = text(storyId);
  const ticket = text(ticketId).match(/(?:CARB[\s_-]*)?(\d+)/i);
  const slug = ticket ? `CARB-${ticket[1]}` : safeWorkspaceSegment(story, "story", 36);
  const fingerprint = createHash("sha256").update(story || slug).digest("hex").slice(0, 8);
  return `${slug}-${fingerprint}`;
}

export function workspaceBundleMember(bundle, repositoryId) {
  const normalized = normalizeWorkspaceBundle(bundle, { definitionId: bundle?.buildEntryRepositoryId });
  return normalized?.members.find((member) => member.repositoryId === text(repositoryId)) || null;
}

function comparablePath(value) {
  return path.resolve(String(value || "")).replace(/[\\/]+/g, "/").replace(/\/+$/, "").toLowerCase();
}

/**
 * AI 派发、Worker 重启恢复和 UI 状态读取共用的确定性 Bundle 结构门禁。
 * 这里不执行 Git/Gradle，也不修复任何内容；调用方只需注入 existsSync 即可测试。
 */
export function inspectWorkspaceBundleIntegrity(worktree, { pathExists } = {}) {
  const bundle = normalizeWorkspaceBundle(worktree?.bundle, {
    definitionId: worktree?.bundle?.buildEntryRepositoryId,
  });
  if (!bundle) return { ok: true, issues: [], bundle: null };
  const issues = [];
  const root = String(worktree?.root || bundle.root || "").trim();
  const entries = list(worktree?.entries).filter((entry) => entry && entry.active !== false && entry.role !== "inactive");
  if (!path.isAbsolute(root)) issues.push("Bundle 工作区根目录不是绝对路径");
  if (typeof pathExists === "function" && root && !pathExists(root)) issues.push("Bundle 工作区根目录不存在");
  const byRepository = new Map(entries.map((entry) => [text(entry.repositoryId), entry]).filter(([repositoryId]) => repositoryId));
  const actualParents = new Set();
  for (const member of bundle.members) {
    const entry = byRepository.get(member.repositoryId);
    if (!entry) {
      if (member.required) issues.push(`Bundle 缺少必需仓库：${member.repositoryId}`);
      continue;
    }
    const worktreePath = String(entry.worktreePath || entry.path || "").trim();
    if (!path.isAbsolute(worktreePath)) {
      issues.push(`Bundle 成员 ${member.repositoryId} 的 worktree 路径不是绝对路径`);
      continue;
    }
    actualParents.add(comparablePath(path.dirname(worktreePath)));
    if (path.basename(worktreePath) !== member.checkoutDirName) {
      issues.push(`Bundle 成员 ${member.repositoryId} 的目录名不是固定值 ${member.checkoutDirName}`);
    }
    if (comparablePath(path.dirname(worktreePath)) !== comparablePath(root)) {
      issues.push(`Bundle 成员 ${member.repositoryId} 不在工作区根目录的直接子级`);
    }
    if (text(entry.checkoutDirName) !== member.checkoutDirName) {
      issues.push(`Bundle 成员 ${member.repositoryId} 的登记目录名与配置不一致`);
    }
    if (member.mode === WORKSPACE_BUNDLE_READ_ONLY && entry.detached !== true) {
      issues.push(`Bundle 只读成员 ${member.repositoryId} 未使用 detached checkout`);
    }
    if (typeof pathExists === "function" && !pathExists(worktreePath)) {
      issues.push(`Bundle 成员 ${member.repositoryId} 的 worktree 目录不存在`);
    }
  }
  if (actualParents.size > 1) issues.push("Bundle 成员不在同一个父目录下");
  const primary = byRepository.get(bundle.buildEntryRepositoryId);
  if (!primary || primary.role !== "primary") issues.push("Bundle 构建入口没有登记为故事点主仓库");
  const strictRepositoryIds = new Set(bundle.members
    .filter((member) => member.association !== true)
    .map((member) => member.repositoryId));
  const strictEntries = entries.filter((entry) => strictRepositoryIds.has(text(entry.repositoryId)));
  const logicalBranches = [...new Set(strictEntries.map((entry) => text(entry.logicalBranch)).filter(Boolean))];
  if (bundle.strictBranch && (logicalBranches.length !== 1 || strictEntries.some((entry) => !text(entry.logicalBranch)))) {
    issues.push("Bundle 成员的逻辑分支不完全一致");
  }
  return {
    ok: issues.length === 0,
    issues: [...new Set(issues)],
    bundle,
    workspaceRoot: root,
    buildEntry: String(primary?.path || primary?.worktreePath || "").trim(),
    logicalBranch: logicalBranches.length === 1 ? logicalBranches[0] : "",
  };
}

export function expandWorkspaceBundleRemoteEntries(entries = [], definitions = []) {
  const rows = list(entries).filter((entry) => entry && typeof entry === "object").map((entry) => ({ ...entry }));
  const defs = new Map(list(definitions).map((definition) => [text(definition?.id), definition]));
  const explicitPrimary = rows.find((entry) => ["primary", "standalone"].includes(text(entry.targetRole).toLowerCase())) || rows[0];
  const primaryRepositoryId = text(explicitPrimary?.repositoryId || explicitPrimary?.projectId);
  const validated = validateWorkspaceBundle(defs.get(primaryRepositoryId)?.workspaceBundle, {
    definitionId: primaryRepositoryId,
    knownRepositoryIds: [...defs.keys()],
  });
  if (!validated.ok) throw Object.assign(new Error(validated.error), { code: validated.code });
  if (!validated.bundle) return { entries: rows, bundle: null };
  const bundle = validated.bundle;
  if (primaryRepositoryId !== bundle.buildEntryRepositoryId) {
    throw Object.assign(new Error("故事点主仓库不是 Bundle 构建入口"), { code: "WORKSPACE_BUNDLE_PRIMARY_MISMATCH" });
  }
  const logicalBranch = text(explicitPrimary?.branch);
  if (bundle.strictBranch && !logicalBranch) {
    throw Object.assign(new Error("Bundle 构建入口缺少逻辑分支"), { code: "WORKSPACE_BUNDLE_LOGICAL_BRANCH_REQUIRED" });
  }
  const byRepository = new Map(rows.map((entry) => [text(entry.repositoryId || entry.projectId), entry]));
  for (const member of bundle.members) {
    let entry = byRepository.get(member.repositoryId);
    if (!entry && member.required) {
      entry = {
        repositoryId: member.repositoryId,
        projectId: member.repositoryId,
        branch: logicalBranch,
        targetRole: member.mode === WORKSPACE_BUNDLE_READ_ONLY ? "webapp" : "dependency",
        repositoryOnly: true,
      };
      rows.push(entry);
      byRepository.set(member.repositoryId, entry);
    }
    if (!entry) continue;
    const memberBranch = text(entry.branch) || logicalBranch;
    if (bundle.strictBranch && memberBranch !== logicalBranch) {
      throw Object.assign(
        new Error(`Bundle 成员 ${member.repositoryId} 的逻辑分支 ${memberBranch || "（空）"} 与 ${logicalBranch} 不一致`),
        { code: "WORKSPACE_BUNDLE_BRANCH_MISMATCH" },
      );
    }
    entry.branch = memberBranch;
    entry.workspaceBundleMember = member;
  }
  return { entries: rows, bundle };
}
