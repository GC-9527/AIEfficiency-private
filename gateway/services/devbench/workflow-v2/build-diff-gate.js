import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

const COMMIT_MSG_HOOK_NAME = "commit-msg";
const MAX_COMMIT_SUBJECT_CHARS = 120;
const MAX_COMMIT_BODY_CHARS = 4000;
const FORBIDDEN_TRAILER_PATTERN = /^\s*(?:Co-Authored-By|Signed-off-by|Reviewed-by|Tested-by|Fixes|Closes|Refs)\s*:/im;
const ABSOLUTE_PATH_PATTERN = /(?:[a-zA-Z]:[\\/]|\\\\[^\\/\\s]+[\\/])(?:[^\\s'"<>|]*)/;
const CONVENTIONAL_PATTERN = /^(?:feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert)(?:\([a-z0-9-]{1,48}\))?:\s*\S/;
const CHINESE_PATTERN = /[\u3400-\u9fff]/u;
const COMMON_ANDROID_SOURCE_SETS = new Set([
  "main",
  "test",
  "androidtest",
  "testfixtures",
]);

export class WorkflowV2BuildGateError extends Error {
  constructor(message, code, details = {}) {
    super(message);
    this.name = "WorkflowV2BuildGateError";
    this.code = code;
    this.details = details;
  }
}

function fail(message, code, details = {}) {
  throw new WorkflowV2BuildGateError(message, code, details);
}

function normalizeFlavorName(value) {
  return String(value || "").trim().toLowerCase();
}

/**
 * FLV-001：Flavor 保存/构建前必须对项目 catalog 白名单校验。
 * catalog 为空时视为“无法解析 catalog”，不做阻断（避免误伤非 Android 工程）。
 */
export function validateFlavorAgainstCatalog({ flavor, catalog = [] } = {}) {
  const target = normalizeFlavorName(flavor);
  if (!target) return { ok: false, reason: "flavor 为空" };
  const known = new Set(catalog.map(normalizeFlavorName).filter(Boolean));
  if (known.size === 0) return { ok: true, catalogUnavailable: true };
  if (!known.has(target)) {
    return { ok: false, reason: `flavor 不在项目 catalog 中: ${flavor}`, known: [...known] };
  }
  return { ok: true, catalogUnavailable: false };
}

/**
 * Build execution is stricter than the legacy save-time flavor check.  A
 * build must be bound to a non-empty, trusted catalog and returns the exact
 * catalog spelling that is later used to derive the Gradle task.  An empty
 * catalog is never interpreted as permission to build an arbitrary flavor.
 */
export function assertBuildFlavorCatalogBinding({ flavor, catalog = [] } = {}) {
  const requested = normalizeFlavorName(flavor);
  const entries = (Array.isArray(catalog) ? catalog : [])
    .map((value) => String(value || "").trim())
    .filter(Boolean);
  if (!requested) {
    fail("构建目标缺少故事点已确认的 Flavor", "WORKFLOW_V2_BUILD_FLAVOR_REQUIRED");
  }
  if (!entries.length) {
    fail("无法从可信项目 catalog 解析 Flavor，拒绝构建", "WORKFLOW_V2_BUILD_FLAVOR_CATALOG_REQUIRED");
  }
  const matches = entries.filter((value) => normalizeFlavorName(value) === requested);
  if (matches.length !== 1) {
    fail("故事点 Flavor 不在可信项目 catalog 中", "WORKFLOW_V2_BUILD_FLAVOR_NOT_ALLOWED", {
      flavor: String(flavor || ""),
      known: entries.map(normalizeFlavorName).sort(),
    });
  }
  return { flavor: matches[0], catalog: entries };
}

/**
 * 解析项目 flavor catalog（复用 store.getAndroidFlavors 口径：flavorConfig.json
 * 顶层 key 或 project_flavor.gradle 的 car 维度）。
 */
export function resolveFlavorCatalog({ projectPath, getFlavors } = {}) {
  if (typeof getFlavors !== "function") return [];
  try {
    const result = getFlavors(projectPath);
    return Array.isArray(result?.flavors) ? result.flavors.filter(Boolean) : [];
  } catch {
    return [];
  }
}

/**
 * FLV-002：diff 门禁。sourceSets 声明每个 flavor 的源码根（相对仓库根），
 * 例如 { main: "app/src/main", prod: "app/src/prod", stg: "app/src/stg" }。
 * 规则：目标 flavor 之外的 flavor sourceSet 改动阻断；公共 main 改动触发
 * 影响评估（return warn 而非 block，由调用方按风险决定）。
 */
export function analyzeFlavorDiff({ changedPaths = [], targetFlavor, sourceSets = {} } = {}) {
  const target = normalizeFlavorName(targetFlavor);
  const entries = Object.entries(sourceSets)
    .map(([name, root]) => ({ name: String(name).toLowerCase(), root: String(root || "").replace(/\\/g, "/").replace(/\/+$/, "") }))
    .filter((entry) => entry.root);
  const normalized = entries.map((entry) => ({ ...entry, root: entry.root.toLowerCase() }));
  const blockers = [];
  const warnings = [];
  for (const rawPath of changedPaths) {
    const changed = String(rawPath || "").replace(/\\/g, "/");
    if (!changed || changed.startsWith(".git/")) continue;
    const lower = changed.toLowerCase();
    for (const entry of normalized) {
      if (entry.name === "main" || entry.name === target) continue;
      if (lower.startsWith(`${entry.root}/`) || lower === entry.root) {
        blockers.push({ path: changed, reason: `改动落在非目标 Flavor sourceSet: ${entry.name}` });
        break;
      }
    }
    const main = normalized.find((entry) => entry.name === "main");
    if (main && (lower.startsWith(`${main.root}/`) || lower === main.root)) {
      const isTarget = normalized.some((entry) => entry.name === target && (lower.startsWith(`${entry.root}/`) || lower === entry.root));
      if (!isTarget) warnings.push({ path: changed, reason: "改动落在公共 main sourceSet，需要影响评估" });
    }
  }
  return { ok: blockers.length === 0, blockers, warnings };
}

/**
 * Controller 侧 Flavor diff 门禁。优先使用配置解析出的 sourceSets；配置暂不可用时，
 * 仍从标准 `src/<sourceSet>/` 路径推导并阻断明显的其它 Flavor，避免把空 catalog
 * 当成绕过 diff 校验的通道。
 */
export function analyzeAuthoritativeFlavorDiff({
  changedPaths = [],
  targetFlavor,
  sourceSets = {},
} = {}) {
  const target = normalizeFlavorName(targetFlavor);
  if (!target) {
    return {
      ok: false,
      blockers: [{ path: "", reason: "目标 Flavor 为空" }],
      warnings: [],
      inferred: false,
    };
  }
  if (Object.keys(sourceSets || {}).length > 0) {
    return {
      ...analyzeFlavorDiff({ changedPaths, targetFlavor: target, sourceSets }),
      inferred: false,
    };
  }
  const blockers = [];
  const warnings = [];
  for (const rawPath of changedPaths) {
    const changed = String(rawPath || "").replace(/\\/g, "/");
    const match = changed.match(/(?:^|\/)src\/([^/]+)(?:\/|$)/i);
    if (!match) continue;
    const sourceSet = normalizeFlavorName(match[1]);
    if (sourceSet === "main") {
      warnings.push({
        path: changed,
        reason: "改动位于公共 main sourceSet，需要影响评估",
      });
      continue;
    }
    if (sourceSet === target || COMMON_ANDROID_SOURCE_SETS.has(sourceSet)) continue;
    blockers.push({
      path: changed,
      reason: `改动位于非目标 Flavor sourceSet: ${sourceSet}`,
    });
  }
  return { ok: blockers.length === 0, blockers, warnings, inferred: true };
}

/**
 * GIT-002：系统生成的提交信息。scope 用故事点文档 slug，正文带故事点引用与
 * 修复摘要；禁止模型/工具自由拼接。
 */
export function buildSystemCommitMessage({
  storyId,
  operationId = "",
  targetFlavor = "",
  docSlug = "",
  summary = "",
  details = "",
} = {}) {
  const scope = String(docSlug || storyId || "story")
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "story";
  const subject = String(summary || "完成故事点修复")
    .trim()
    .replace(/\s+/g, " ")
    .slice(0, MAX_COMMIT_SUBJECT_CHARS);
  const body = [
    `storyId: ${String(storyId || "")}`,
    ...(String(operationId || "").trim()
      ? [`操作标识: ${String(operationId).trim()}`]
      : []),
    ...(String(targetFlavor || "").trim()
      ? [`目标 Flavor: ${String(targetFlavor).trim()}`]
      : []),
    ...(String(details || "").trim() ? [String(details).trim().slice(0, MAX_COMMIT_BODY_CHARS)] : []),
  ].join("\n");
  return `fix(${scope}): ${subject}\n\n${body}\n`;
}

/**
 * 校验提交信息：必须非空、≤ 长度上限、无禁止尾注（Co-Authored-By 等）、
 * 无绝对路径泄露。commit-msg hook 与系统生成器共用同一规则。
 */
export function validateSystemCommitMessage(message = "") {
  const text = String(message || "");
  const issues = [];
  if (!text.trim()) issues.push("提交信息为空");
  const subject = text.split(/\n/)[0] || "";
  if (Array.from(subject).length > MAX_COMMIT_SUBJECT_CHARS) issues.push(`主题超过 ${MAX_COMMIT_SUBJECT_CHARS} 字符`);
  if (Array.from(text).length > MAX_COMMIT_BODY_CHARS + MAX_COMMIT_SUBJECT_CHARS + 64) issues.push("提交信息超长");
  if (!CONVENTIONAL_PATTERN.test(subject)) issues.push("主题不符合 conventional 格式");
  const descriptiveSubject = subject.replace(/^[^:]+:\s*/, "");
  if (!CHINESE_PATTERN.test(descriptiveSubject)) issues.push("提交摘要必须包含中文描述");
  if (FORBIDDEN_TRAILER_PATTERN.test(text)) issues.push("包含禁止的提交尾注（Co-Authored-By 等）");
  if (ABSOLUTE_PATH_PATTERN.test(text)) issues.push("包含绝对路径");
  if (/[^\u0009\u000a\u000d\u0020-\u007e\u00a0-\uffff]/u.test(text)) issues.push("包含控制字符");
  return { ok: issues.length === 0, issues };
}

const COMMIT_HOOK_JS_NAME = "commit-msg-guard.js";
const HOOK_JS = `"use strict";
// Generated by workflow-v2 commit-msg guard. 禁止删除或修改。
const fs = require("node:fs");
const message = fs.readFileSync(process.argv[2] || "", "utf8");
const issues = [];
if (!message.trim()) issues.push("empty message");
const subject = message.split(/\\n/)[0] || "";
if ([...subject].length > 120) issues.push("subject too long");
if (/^\\s*(?:Co-Authored-By|Signed-off-by|Reviewed-by|Tested-by|Fixes|Closes|Refs)\\s*:/im.test(message)) issues.push("forbidden trailer");
if (/(?:[a-zA-Z]:[\\\\/]|\\\\\\\\[^\\\\/\\\\s]+[\\\\/])(?:[^\\\\s'"<>|]*)/.test(message)) issues.push("absolute path");
if (issues.length) {
  console.error("commit-msg rejected: " + issues.join(", "));
  process.exit(1);
}
`;

function shEscape(value) {
  return "'" + String(value).replace(/'/g, "'\\''") + "'";
}

function resolveCommonGitDir(worktreeRoot) {
  try {
    const out = execFileSync("git", ["rev-parse", "--git-common-dir"], {
      cwd: worktreeRoot,
      encoding: "utf8",
    }).trim();
    if (!out) return null;
    return path.isAbsolute(out) ? out : path.resolve(worktreeRoot, out);
  } catch {
    return null;
  }
}

/**
 * 在仓库 common git 目录安装 commit-msg hook（幂等）。story worktree 的
 * hook 由 git 从 GIT_COMMON_DIR/hooks 查找（git worktree 不读 worktree
 * gitdir 的 hooks），因此一次安装保护该仓库全部 worktree。hook 由 sh 包装
 * 调用 node 校验脚本（Windows Git 的 sh 不解析 `#!/usr/bin/env node`
 * shebang）。安装失败抛 WORKFLOW_V2_COMMIT_HOOK_INSTALL_FAILED（fail closed）。
 */
export function installStoryCommitMsgHook({ worktreeRoot, gitDir } = {}) {
  const root = String(worktreeRoot || "").trim();
  if (!root) fail("缺少 worktree 根目录", "WORKFLOW_V2_COMMIT_HOOK_INSTALL_FAILED");
  const commonGitDir = String(gitDir || "").trim()
    ? gitDir
    : resolveCommonGitDir(root);
  if (!commonGitDir) fail("worktree 不是有效 git 仓库", "WORKFLOW_V2_COMMIT_HOOK_INSTALL_FAILED");
  const hooksDir = path.join(commonGitDir, "hooks");
  const hookJsPath = path.join(hooksDir, COMMIT_HOOK_JS_NAME);
  const hookPath = path.join(hooksDir, COMMIT_MSG_HOOK_NAME);
  const wrapper = `#!/bin/sh\nexec node ${shEscape(hookJsPath.replace(/\\/g, "/"))} "$@"\n`;
  try {
    mkdirSync(hooksDir, { recursive: true });
    writeFileSync(hookJsPath, HOOK_JS, "utf8");
    writeFileSync(hookPath, wrapper, "utf8");
    chmodSync(hookJsPath, 0o755);
    chmodSync(hookPath, 0o755);
  } catch (error) {
    fail(`commit-msg hook 安装失败: ${error.message}`, "WORKFLOW_V2_COMMIT_HOOK_INSTALL_FAILED", {
      causeCode: String(error?.code || ""),
    });
  }
  return { hookPath, hookJsPath, installed: true };
}

/**
 * ADB-001/002：设备动作只能来自 story 租约绑定，模型不能指定其它 serial。
 * 无租约或租约与绑定 serial 不一致即拒绝。当前 API 工具目录尚未实现设备
 * 工具（DEVICE_PROXY 组为空展开），本函数作为未来设备工具的强制前置门禁。
 */
export function assertDeviceLeaseBinding({
  requireLease = false,
  boundSerial = "",
  leasedSerial = "",
  assessedSerial = "",
  requestedSerial = "",
  frozenStoryId = "",
  leasedStoryId = "",
  expectedLeaseId = "",
  leaseId = "",
  expectedFencingToken = null,
  fencingToken = null,
  expiresAt = null,
  now = Date.now(),
} = {}) {
  const bound = String(boundSerial || "").trim();
  const leased = String(leasedSerial || "").trim();
  const assessed = String(assessedSerial || "").trim();
  const requested = String(requestedSerial || "").trim();
  const activeId = String(leaseId || "").trim();
  const activeStory = String(leasedStoryId || "").trim();
  const activeToken = Number(fencingToken);
  const expiry = Number(expiresAt);
  const observedAt = Number(now);
  if (requireLease === true && (
    !leased
    || !activeId
    || !activeStory
    || !Number.isSafeInteger(activeToken)
    || activeToken <= 0
    || !Number.isSafeInteger(expiry)
    || !Number.isSafeInteger(observedAt)
    || expiry <= observedAt
  )) {
    fail("缺少完整且有效的故事点设备 lease", "WORKFLOW_V2_DEVICE_LEASE_REQUIRED");
  }
  if (requested && requested !== (leased || bound)) {
    fail(`设备 serial 与 story 租约绑定不一致: ${requested}`, "WORKFLOW_V2_DEVICE_SERIAL_MISMATCH", { requested });
  }
  if (!leased && !bound) {
    fail("无设备租约，拒绝设备操作", "WORKFLOW_V2_DEVICE_LEASE_REQUIRED");
  }
  if (leased && bound && leased !== bound) {
    fail("设备租约与 story 绑定 serial 不一致", "WORKFLOW_V2_DEVICE_LEASE_MISMATCH", { leased, bound });
  }
  if (assessed && leased && assessed !== leased) {
    fail("验收快照 serial 与租约不一致", "WORKFLOW_V2_DEVICE_ASSESSMENT_MISMATCH", { assessed, leased });
  }
  const expectedStory = String(frozenStoryId || "").trim();
  if (expectedStory && activeStory !== expectedStory) {
    fail("设备 lease 不属于当前故事点", "WORKFLOW_V2_DEVICE_LEASE_STORY_MISMATCH", {
      frozenStoryId: expectedStory,
      leasedStoryId: activeStory,
    });
  }
  const expectedId = String(expectedLeaseId || "").trim();
  if (expectedId && activeId !== expectedId) {
    fail("设备 active leaseId 与冻结 lease 不一致", "WORKFLOW_V2_DEVICE_LEASE_ID_MISMATCH");
  }
  if (expectedFencingToken !== null && expectedFencingToken !== undefined) {
    const expectedToken = Number(expectedFencingToken);
    if (!Number.isSafeInteger(expectedToken) || expectedToken <= 0 || activeToken !== expectedToken) {
      fail("设备 fencingToken 与冻结 lease 不一致", "WORKFLOW_V2_DEVICE_FENCING_TOKEN_MISMATCH", {
        expectedFencingToken: expectedToken,
        fencingToken: activeToken,
      });
    }
  }
  if (expiresAt !== null && expiresAt !== undefined) {
    if (!Number.isSafeInteger(expiry) || !Number.isSafeInteger(observedAt) || expiry <= observedAt) {
      fail("设备 lease 已过期", "WORKFLOW_V2_DEVICE_LEASE_EXPIRED", { expiresAt: expiry, now: observedAt });
    }
  }
  return {
    serial: leased || bound,
    ...(activeStory ? { storyId: activeStory } : {}),
    ...(activeId ? { leaseId: activeId } : {}),
    ...(Number.isSafeInteger(Number(fencingToken)) && Number(fencingToken) > 0
      ? { fencingToken: Number(fencingToken) }
      : {}),
  };
}
