import { execFile } from "child_process";
import { existsSync } from "fs";
import { mkdtemp, rm } from "fs/promises";
import os from "os";
import path from "path";
import { promisify } from "util";
import {
  buildConfigInferenceRegistry,
  normalizeConfigInferenceTargets,
} from "./config-inference.js";

const execFileAsync = promisify(execFile);
const REVISION_RE = /^[0-9a-f]{7,64}$/i;
const MAX_CHANGED_FILES = 400;
const MAX_BATCH_INPUT_LENGTH = 100_000;
const MAX_BATCH_REVISIONS = 30;
const MAX_BATCH_MATCHES_PER_CHECKOUT = 50;
const MAX_BATCH_CANDIDATES_PER_QUERY = 30;
const MAX_BATCH_MESSAGE_QUERIES = 4;
const MAX_REVIEW_HINT_LENGTH = 4_000;

function uniqueStrings(values = []) {
  return [...new Set(values.map((value) => String(value || "").trim()).filter(Boolean))];
}

function safeRemoteUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) {
    return raw
      .replace(/\/\/[^/@\s]+@/, "//***@")
      .replace(/[?#].*$/, "");
  }
  try {
    const parsed = new URL(raw);
    if (parsed.username) parsed.username = "***";
    if (parsed.password) parsed.password = "***";
    // 仓库展示、持久化上下文和错误日志都不需要 query/fragment。
    // 这些位置常携带 access_token/private_token，必须整段移除而不是仅遮常见键名。
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString().replace(/\/$/, "");
  } catch {
    return raw
      .replace(/\/\/[^/@\s]+@/, "//***@")
      .replace(/[?#].*$/, "");
  }
}

function safeGitError(error, remoteUrl = "") {
  const rawUrl = String(remoteUrl || "").trim();
  const maskedUrl = safeRemoteUrl(rawUrl);
  let text = String(error?.stderr || error?.message || error || "Git 命令执行失败").trim();
  if (rawUrl && maskedUrl !== rawUrl) text = text.split(rawUrl).join(maskedUrl);
  return text
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^/\s'"]+@/gi, "$1***@")
    .replace(/((?:https?|ssh|git):\/\/[^\s'"]+?)[?#][^\s'"]*/gi, "$1")
    .replace(/([?&](?:access_token|private_token|token|password|passwd|secret|auth|key)=)[^&\s'"]+/gi, "$1***")
    .slice(0, 800);
}

export function normalizeGitCommitRevision(value) {
  const revision = String(value || "").trim();
  if (!revision) {
    return { ok: false, code: "GIT_REVISION_REQUIRED", error: "请输入 Git commit revision number" };
  }
  if (!REVISION_RE.test(revision)) {
    return {
      ok: false,
      code: "GIT_REVISION_INVALID",
      error: "revision 格式不正确，请输入 7 至 64 位十六进制 commit hash",
    };
  }
  return { ok: true, revision: revision.toLowerCase() };
}

export function normalizeGitCommitReviewHint(value) {
  return String(value || "")
    .replace(/\0/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_REVIEW_HINT_LENGTH);
}

function normalizeBatchMessageQuery(value) {
  return String(value || "")
    .replace(/\0/g, "")
    .replace(/^\s*(?:[-*•]\s+|\d{1,3}\s*[.)、]\s*)/, "")
    .replace(/^\s*(?:\[|【)?[0-9a-f]{7,64}(?:\]|】)?\s*/i, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 360);
}

function extractBatchTicketKeys(value) {
  return uniqueStrings(
    [...String(value || "").matchAll(/\bCARB[-_\s]*(\d+)\b/gi)]
      .map((match) => `CARB-${match[1]}`.toUpperCase()),
  );
}

function stripBatchEllipsis(value) {
  return String(value || "")
    .replace(/(?:\.{3,}|…+)\s*$/u, "")
    .trim();
}

function batchLabeledValues(value, label) {
  const pattern = new RegExp(`^[\\t ]*${label}[\\t ]*[:：][\\t ]*(.+)$`, "gimu");
  return [...String(value || "").matchAll(pattern)]
    .map((match) => String(match[1] || "").trim())
    .filter(Boolean);
}

function batchMessageQueries(value, fallback = "") {
  const input = String(value || "");
  const ticketKeys = extractBatchTicketKeys(input);
  const titles = batchLabeledValues(input, "标题");
  const orderSummaries = batchLabeledValues(input, "单号").map((line) => {
    let summary = line;
    for (const ticketKey of ticketKeys) {
      summary = summary.replace(new RegExp(ticketKey.replace("-", "[-_\\s]*"), "ig"), "");
    }
    return stripBatchEllipsis(summary.replace(/^[\s·:：|｜-]+/, ""));
  });
  return uniqueStrings([
    ...ticketKeys,
    ...titles,
    ...orderSummaries,
    normalizeBatchMessageQuery(fallback),
  ])
    .filter((query) => query.length >= 2)
    .slice(0, MAX_BATCH_MESSAGE_QUERIES);
}

function extractStructuredBatchReferences(input) {
  const starts = [...String(input || "").matchAll(/^[\t ]*单号[\t ]*[:：]/gimu)]
    .map((match) => match.index);
  if (!starts.length) return null;

  const references = [];
  const firstIndexByKey = new Map();
  for (let index = 0; index < starts.length; index += 1) {
    const start = starts[index];
    const end = starts[index + 1] ?? input.length;
    const block = input.slice(start, end).trim();
    if (!block) continue;
    const revisions = uniqueStrings(
      [...block.matchAll(/\b[0-9a-f]{7,64}\b/gi)]
        .map((match) => String(match[0] || "").toLowerCase())
        .filter((revision) => /[a-f]/i.test(revision)),
    );
    const revision = revisions[0] || "";
    const ticketKeys = extractBatchTicketKeys(block);
    const branchHints = uniqueStrings(batchLabeledValues(block, "分支"));
    const messageQueries = batchMessageQueries(block);
    const reference = revision || ticketKeys[0] || messageQueries[0] || "";
    if (!reference) continue;
    const nonTicketQuery = messageQueries.find((query) => !ticketKeys.includes(query)) || "";
    const duplicateKey = revision
      ? `revision:${revision}`
      : [
        `ticket:${ticketKeys[0] || ""}`,
        `branch:${branchHints[0] || ""}`,
        `message:${nonTicketQuery.toLocaleLowerCase()}`,
      ].join("|");
    const duplicateOf = firstIndexByKey.get(duplicateKey);
    const inputIndex = references.length;
    references.push({
      reference,
      queryType: revision ? "revision" : ticketKeys.length ? "ticket" : "message",
      messageQuery: messageQueries.find((query) => !ticketKeys.includes(query)) || messageQueries[0] || "",
      messageQueries,
      ticketKeys,
      branchHints,
      searchAlternatives: true,
      excerpt: block.replace(/\s+/g, " ").trim().slice(0, 2_000),
      inputIndex,
      ...(duplicateOf != null ? { duplicateOf } : {}),
    });
    if (duplicateOf == null) firstIndexByKey.set(duplicateKey, inputIndex);
  }
  return { references, unique: firstIndexByKey.size };
}

function extractBatchMessageReferences(input) {
  const rows = String(input || "")
    .split(/\r?\n/)
    .map((line) => ({
      excerpt: line.replace(/\s+/g, " ").trim().slice(0, 360),
      query: normalizeBatchMessageQuery(line),
    }))
    .filter((row) => row.query.length >= 2);
  const references = [];
  const firstIndexByQuery = new Map();
  for (const row of rows) {
    const inputIndex = references.length;
    const duplicateKey = row.query.toLocaleLowerCase();
    const duplicateOf = firstIndexByQuery.get(duplicateKey);
    const ticketKeys = extractBatchTicketKeys(row.query);
    const messageQueries = batchMessageQueries(row.query, row.query);
    references.push({
      reference: row.query,
      queryType: "message",
      messageQuery: row.query,
      messageQueries,
      ticketKeys,
      branchHints: [],
      searchAlternatives: ticketKeys.length > 0,
      excerpt: row.excerpt,
      inputIndex,
      ...(duplicateOf != null ? { duplicateOf } : {}),
    });
    if (duplicateOf == null) firstIndexByQuery.set(duplicateKey, inputIndex);
  }
  return { references, unique: firstIndexByQuery.size };
}

export function extractGitCommitReferences(value) {
  const input = String(value || "");
  if (!input.trim()) {
    return {
      ok: false,
      code: "GIT_BATCH_INPUT_REQUIRED",
      error: "请粘贴 Git commit revision、message 关键词或评审信息",
    };
  }
  if (input.length > MAX_BATCH_INPUT_LENGTH) {
    return {
      ok: false,
      code: "GIT_BATCH_INPUT_TOO_LARGE",
      error: `输入内容过长，请控制在 ${MAX_BATCH_INPUT_LENGTH} 个字符以内`,
    };
  }

  const structured = extractStructuredBatchReferences(input);
  if (structured) {
    if (!structured.references.length) {
      return {
        ok: false,
        code: "GIT_BATCH_QUERY_NOT_FOUND",
        error: "没有从评审记录中识别到 revision、工单号或标题关键词",
      };
    }
    if (structured.references.length > MAX_BATCH_REVISIONS) {
      return {
        ok: false,
        code: "GIT_BATCH_TOO_MANY_REVISIONS",
        error: `一次最多解析 ${MAX_BATCH_REVISIONS} 条评审记录，当前识别到 ${structured.references.length} 条`,
      };
    }
    return {
      ok: true,
      references: structured.references,
      total: structured.references.length,
      unique: structured.unique,
    };
  }

  const collect = (pattern, groupIndex = 0) => {
    const matches = [];
    let match;
    while ((match = pattern.exec(input)) !== null) {
      const reference = String(match[groupIndex] || "").toLowerCase();
      if (reference) matches.push({ reference, index: match.index, raw: match[0] });
    }
    return matches;
  };
  const bracketed = [
    ...collect(/\[([0-9a-f]{7,64})\]/gi, 1),
    ...collect(/【([0-9a-f]{7,64})】/gi, 1),
  ].sort((left, right) => left.index - right.index);
  const bracketedLineStarts = new Set(bracketed.map((match) => (
    Math.max(0, input.lastIndexOf("\n", Math.max(0, match.index - 1)) + 1)
  )));
  // 兼容混合粘贴：含括号的行只认明确括号项，避免把日期/统计数字误当 SHA；
  // 没有括号的其它行仍接受裸短 SHA 或完整 SHA。
  const bareLineStarts = new Set();
  const bare = collect(/\b[0-9a-f]{7,64}\b/gi)
    .filter((match) => {
      const lineStart = Math.max(0, input.lastIndexOf("\n", Math.max(0, match.index - 1)) + 1);
      if (bracketedLineStarts.has(lineStart) || bareLineStarts.has(lineStart)) return false;
      const prefix = input.slice(lineStart, match.index)
        .replace(/^\s*(?:[-*•]\s+|\d{1,3}\s*[.)、]\s*)/, "")
        .trim();
      const plausiblePosition = !prefix || /(?:revision|commit|sha)\s*[:=：]?\s*$/i.test(prefix);
      const plausibleToken = match.reference.length >= 12 || /[a-f]/i.test(match.reference);
      if (!plausiblePosition && !plausibleToken) return false;
      bareLineStarts.add(lineStart);
      return true;
    });
  const matches = [...bracketed, ...bare].sort((left, right) => left.index - right.index);
  if (!matches.length) {
    const messageReferences = extractBatchMessageReferences(input);
    if (!messageReferences.references.length) {
      return {
        ok: false,
        code: "GIT_BATCH_QUERY_NOT_FOUND",
        error: "没有识别到可搜索的 revision 或 commit message 关键词",
      };
    }
    if (messageReferences.references.length > MAX_BATCH_REVISIONS) {
      return {
        ok: false,
        code: "GIT_BATCH_TOO_MANY_REVISIONS",
        error: `一次最多解析 ${MAX_BATCH_REVISIONS} 个 Git commit 查询，当前识别到 ${messageReferences.references.length} 个`,
      };
    }
    return {
      ok: true,
      references: messageReferences.references,
      total: messageReferences.references.length,
      unique: messageReferences.unique,
    };
  }

  const references = [];
  const firstIndexByReference = new Map();
  for (let index = 0; index < matches.length; index += 1) {
    const match = matches[index];
    const nextIndex = matches[index + 1]?.index ?? input.length;
    const lineStart = Math.max(0, input.lastIndexOf("\n", Math.max(0, match.index - 1)) + 1);
    const previousMatch = matches[index - 1];
    const previousEnd = previousMatch
      ? previousMatch.index + String(previousMatch.raw || "").length
      : -1;
    // 同一行可能连续粘贴多个风险条；后续条目必须从自己的 SHA 开始，
    // 不能把前一条风险描述重复带入 reviewHint。
    const excerptStart = previousEnd >= lineStart ? match.index : lineStart;
    const excerpt = input
      .slice(excerptStart, nextIndex)
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 360);
    const lineEnd = input.indexOf("\n", match.index);
    const messageQuery = normalizeBatchMessageQuery(
      input.slice(lineStart, lineEnd < 0 ? input.length : lineEnd),
    );
    const ticketKeys = extractBatchTicketKeys(excerpt);
    const messageQueries = batchMessageQueries(excerpt, messageQuery);
    const duplicateOf = firstIndexByReference.get(match.reference);
    if (duplicateOf != null) {
      references.push({
        reference: match.reference,
        queryType: "revision",
        messageQuery,
        messageQueries,
        ticketKeys,
        branchHints: [],
        searchAlternatives: ticketKeys.length > 0,
        excerpt,
        inputIndex: index,
        duplicateOf,
      });
      continue;
    }
    firstIndexByReference.set(match.reference, index);
    references.push({
      reference: match.reference,
      queryType: "revision",
      messageQuery,
      messageQueries,
      ticketKeys,
      branchHints: [],
      searchAlternatives: ticketKeys.length > 0,
      excerpt,
      inputIndex: index,
    });
  }
  if (references.length > MAX_BATCH_REVISIONS) {
    return {
      ok: false,
      code: "GIT_BATCH_TOO_MANY_REVISIONS",
      error: `一次最多解析 ${MAX_BATCH_REVISIONS} 个 Git commit，当前识别到 ${references.length} 个`,
    };
  }
  return {
    ok: true,
    references,
    total: references.length,
    unique: firstIndexByReference.size,
  };
}

export function repositoryKey(value) {
  const raw = String(value || "").trim().replace(/[?#].*$/, "");
  if (!raw) return "";
  let host = "";
  let repoPath = "";
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

export function resolveGitRepositorySelection({
  repositoryId,
  repositoryUrl,
  projectDefs = [],
} = {}) {
  const definitions = Array.isArray(projectDefs) ? projectDefs : [];
  const id = String(repositoryId || "").trim();
  if (id) {
    const definition = definitions.find((row) => String(row?.id || "").trim() === id);
    if (!definition) {
      return { ok: false, code: "GIT_REPOSITORY_UNKNOWN", error: "所选 Git 仓库已不存在，请刷新后重新选择" };
    }
    const remoteUrl = String(definition.ssh || definition.https || "").trim();
    if (!remoteUrl) {
      return { ok: false, code: "GIT_REPOSITORY_URL_MISSING", error: `仓库「${definition.name || id}」尚未配置 Git 地址` };
    }
    return {
      ok: true,
      definition,
      remoteUrl,
      displayUrl: safeRemoteUrl(definition.https || definition.ssh || remoteUrl),
    };
  }

  const url = String(repositoryUrl || "").trim();
  const key = repositoryKey(url);
  if (!key) {
    return { ok: false, code: "GIT_REPOSITORY_REQUIRED", error: "请选择或输入已配置的 Git 仓库地址" };
  }
  const matches = definitions.filter((definition) => (
    [definition?.ssh, definition?.https].some((candidate) => repositoryKey(candidate) === key)
  ));
  if (!matches.length) {
    return {
      ok: false,
      code: "GIT_REPOSITORY_NOT_CONFIGURED",
      error: "该 Git 地址尚未加入工程配置，请先在「工程配置」中登记后再创建故事点",
    };
  }
  if (matches.length > 1) {
    return {
      ok: false,
      code: "GIT_REPOSITORY_AMBIGUOUS",
      error: `该地址对应多个逻辑工程（${matches.map((row) => row.name || row.id).join("、")}），请从下拉列表明确选择`,
    };
  }
  const definition = matches[0];
  return {
    ok: true,
    definition,
    remoteUrl: String(definition.ssh || definition.https || url).trim(),
    displayUrl: safeRemoteUrl(definition.https || definition.ssh || url),
  };
}

export function resolveGitCommitConfigurationChoice(input = {}, localCandidates = []) {
  if (input?.configurationConfirmed !== true) {
    return {
      ok: false,
      code: "GIT_COMMIT_CONFIGURATION_CONFIRMATION_REQUIRED",
      error: "请先在预设置页面选择本地工程或远程拉取，并确认后再创建评审故事点",
    };
  }
  const configuration = input?.configuration && typeof input.configuration === "object"
    ? input.configuration
    : {};
  const mode = String(configuration.mode || "").trim().toLowerCase();
  if (!["local", "remote"].includes(mode)) {
    return {
      ok: false,
      code: "GIT_COMMIT_CONFIGURATION_MODE_REQUIRED",
      error: "请明确选择“使用本地工程”或“远程拉取”",
    };
  }
  if (mode === "remote") {
    return { ok: true, mode, localCandidate: null };
  }

  const projectId = String(configuration.localProjectId || "").trim();
  const role = String(configuration.localRole || "").trim() || "primary";
  if (!projectId) {
    return {
      ok: false,
      code: "GIT_COMMIT_LOCAL_PROJECT_REQUIRED",
      error: "选择本地工程模式时必须指定一个本机工程",
    };
  }
  const matches = (Array.isArray(localCandidates) ? localCandidates : []).filter((candidate) => (
    String(candidate?.projectId || candidate?.id || "").trim() === projectId
    && (String(candidate?.role || "").trim() || "primary") === role
  ));
  if (matches.length !== 1) {
    return {
      ok: false,
      code: matches.length
        ? "GIT_COMMIT_LOCAL_PROJECT_AMBIGUOUS"
        : "GIT_COMMIT_LOCAL_PROJECT_NOT_FOUND",
      error: matches.length
        ? "所选本机工程对应多个源码目录，请返回预设置页面重新选择"
        : "所选本机工程不存在、路径已失效或配置已经变化，请刷新后重新选择",
    };
  }
  return {
    ok: true,
    mode,
    localCandidate: matches[0],
    localProjectId: projectId,
    localRole: role,
  };
}

async function defaultGitRunner(args, options = {}) {
  const { stdout = "", stderr = "" } = await execFileAsync("git", args, {
    cwd: options.cwd,
    timeout: options.timeoutMs || 45000,
    maxBuffer: 8 * 1024 * 1024,
    windowsHide: true,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: "0",
      GCM_INTERACTIVE: "Never",
      GIT_SSH_COMMAND: "ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new",
    },
  });
  return { stdout: String(stdout), stderr: String(stderr) };
}

function parseChangedFiles(nameStatusText, numstatText) {
  const stats = new Map();
  for (const line of String(numstatText || "").split(/\r?\n/)) {
    if (!line.trim()) continue;
    const parts = line.split("\t");
    if (parts.length < 3) continue;
    const file = parts.at(-1);
    const additions = /^\d+$/.test(parts[0]) ? Number(parts[0]) : null;
    const deletions = /^\d+$/.test(parts[1]) ? Number(parts[1]) : null;
    stats.set(file, { additions, deletions, binary: additions == null || deletions == null });
  }

  const files = [];
  for (const line of String(nameStatusText || "").split(/\r?\n/)) {
    if (!line.trim()) continue;
    const parts = line.split("\t");
    if (parts.length < 2) continue;
    const status = parts[0];
    const file = parts.at(-1);
    const previousPath = /^[RC]/.test(status) && parts.length > 2 ? parts[1] : "";
    files.push({
      status,
      path: file,
      ...(previousPath ? { previousPath } : {}),
      ...(stats.get(file) || { additions: null, deletions: null, binary: false }),
    });
    if (files.length >= MAX_CHANGED_FILES) break;
  }
  return files;
}

function normalizeBranchName(value) {
  return String(value || "")
    .trim()
    .replace(/^refs\/(?:heads|remotes)\//, "")
    .replace(/^[^/]+\/(?=.+)/, (prefix) => (prefix.toLowerCase() === "origin/" ? "" : prefix));
}

function branchIdentityFromRef(value) {
  const raw = String(value || "").trim();
  if (raw.startsWith("refs/heads/")) return raw.slice("refs/heads/".length);
  if (raw.startsWith("refs/remotes/")) {
    const rest = raw.slice("refs/remotes/".length);
    const slash = rest.indexOf("/");
    return slash > 0 ? rest.slice(slash + 1) : "";
  }
  return normalizeBranchName(raw);
}

function branchVariants(values = []) {
  const out = [];
  for (const value of values) {
    const raw = String(value || "").trim();
    if (!raw || /\/HEAD$/.test(raw)) continue;
    out.push(raw);
    const normalized = normalizeBranchName(raw);
    if (normalized) out.push(normalized);
  }
  return uniqueStrings(out);
}

async function inspectCommitAt({
  repositoryPath,
  revision,
  gitRunner,
  remoteBranches = [],
  source,
} = {}) {
  const verify = await gitRunner(["-C", repositoryPath, "rev-parse", "--verify", `${revision}^{commit}`]);
  const fullRevision = String(verify.stdout || "").trim().split(/\r?\n/)[0];
  if (!/^[0-9a-f]{40,64}$/i.test(fullRevision)) {
    throw new Error("Git 未返回有效的 commit hash");
  }
  const [metadata, nameStatus, numstat, refs, current] = await Promise.all([
    gitRunner(["-C", repositoryPath, "show", "-s", "--format=%H%x00%h%x00%s%x00%an%x00%aI%x00%P", fullRevision]),
    gitRunner(["-C", repositoryPath, "show", "--format=", "--name-status", "--find-renames", "--first-parent", fullRevision]),
    gitRunner(["-C", repositoryPath, "show", "--format=", "--numstat", "--find-renames", "--first-parent", fullRevision]),
    gitRunner([
      "-C", repositoryPath, "for-each-ref",
      "--format=%(refname)",
      `--contains=${fullRevision}`,
      "refs/heads",
      "refs/remotes",
    ]).catch(() => ({ stdout: "" })),
    gitRunner(["-C", repositoryPath, "branch", "--show-current"]).catch(() => ({ stdout: "" })),
  ]);
  const [hash, shortHash, subject, author, committedAt, parents] = String(metadata.stdout || "")
    .trimEnd()
    .split("\u0000");
  const localBranches = String(refs.stdout || "").split(/\r?\n/)
    .map(branchIdentityFromRef)
    .filter((row) => row && !/\/HEAD$/i.test(row));
  const exactRemoteBranches = (Array.isArray(remoteBranches) ? remoteBranches : [])
    .filter((row) => String(row?.hash || "").toLowerCase() === String(hash || fullRevision).toLowerCase())
    .map((row) => row.branch);
  const changedFiles = parseChangedFiles(nameStatus.stdout, numstat.stdout);
  const additions = changedFiles.reduce((sum, file) => sum + (Number.isFinite(file.additions) ? file.additions : 0), 0);
  const deletions = changedFiles.reduce((sum, file) => sum + (Number.isFinite(file.deletions) ? file.deletions : 0), 0);
  return {
    revision: hash || fullRevision,
    shortRevision: shortHash || fullRevision.slice(0, 12),
    subject: String(subject || "").trim(),
    author: String(author || "").trim(),
    committedAt: String(committedAt || "").trim(),
    parents: String(parents || "").trim().split(/\s+/).filter(Boolean),
    branches: branchVariants([...localBranches, ...exactRemoteBranches]),
    currentBranch: String(current.stdout || "").trim(),
    changedFiles,
    stats: {
      files: changedFiles.length,
      additions,
      deletions,
      truncated: changedFiles.length >= MAX_CHANGED_FILES,
    },
    source,
  };
}

function parseRemoteBranches(text) {
  return String(text || "").split(/\r?\n/).map((line) => {
    const [hash, ref] = line.trim().split(/\s+/);
    return hash && ref?.startsWith("refs/heads/")
      ? { hash, branch: ref.slice("refs/heads/".length) }
      : null;
  }).filter(Boolean);
}

export async function inspectGitCommit({
  revision,
  remoteUrl,
  localCandidates = [],
  gitRunner = defaultGitRunner,
} = {}) {
  const normalized = normalizeGitCommitRevision(revision);
  if (!normalized.ok) return normalized;
  const candidates = (Array.isArray(localCandidates) ? localCandidates : [])
    .filter((candidate) => candidate?.path && existsSync(candidate.path));
  const failures = [];
  for (const candidate of candidates) {
    try {
      const commit = await inspectCommitAt({
        repositoryPath: candidate.path,
        revision: normalized.revision,
        gitRunner,
        source: {
          kind: "local",
          projectId: String(candidate.projectId || candidate.id || "").trim(),
          projectName: String(candidate.name || "").trim(),
          path: candidate.path,
          role: String(candidate.role || "").trim(),
        },
      });
      return { ok: true, commit };
    } catch (error) {
      failures.push(`${candidate.name || path.basename(candidate.path)}：${safeGitError(error)}`);
    }
  }

  const remote = String(remoteUrl || "").trim();
  if (!remote) {
    return {
      ok: false,
      code: "GIT_COMMIT_NOT_FOUND",
      error: failures.length
        ? `本机候选仓库均不包含该 commit：${failures.join("；")}`
        : "没有可读取的本地仓库或远程 Git 地址",
    };
  }

  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "aiefficiency-git-review-"));
  try {
    await gitRunner(["init", "--bare", tempRoot]);
    const remoteBranchResult = await gitRunner(["ls-remote", "--heads", remote], { timeoutMs: 45000 })
      .catch(() => ({ stdout: "" }));
    const remoteBranches = parseRemoteBranches(remoteBranchResult.stdout);
    await gitRunner([
      "-C", tempRoot, "fetch", "--quiet", "--no-tags", "--depth=2", remote, normalized.revision,
    ], { timeoutMs: 90000 });
    const commit = await inspectCommitAt({
      repositoryPath: tempRoot,
      revision: "FETCH_HEAD",
      gitRunner,
      remoteBranches,
      source: { kind: "remote", url: safeRemoteUrl(remote) },
    });
    return { ok: true, commit };
  } catch (error) {
    return {
      ok: false,
      code: "GIT_COMMIT_NOT_FOUND",
      error: [
        failures.length ? `本地未命中（${failures.join("；")}）` : "",
        `远程仓库无法解析 revision：${safeGitError(error, remote)}`,
        "请确认 commit 属于所选仓库、当前账号有读取权限，或先在本机同步该仓库",
      ].filter(Boolean).join("；"),
    };
  } finally {
    const resolvedTemp = path.resolve(tempRoot);
    const resolvedOsTemp = path.resolve(os.tmpdir());
    if (resolvedTemp.startsWith(`${resolvedOsTemp}${path.sep}`) && path.basename(resolvedTemp).startsWith("aiefficiency-git-review-")) {
      await rm(resolvedTemp, { recursive: true, force: true }).catch(() => {});
    }
  }
}

function branchLookup(value, remoteNames = []) {
  const raw = String(value || "").trim();
  if (!raw) return { raw: "", branch: "", remoteName: "" };
  if (raw.startsWith("refs/remotes/")) {
    const rest = raw.slice("refs/remotes/".length);
    const slash = rest.indexOf("/");
    return slash > 0
      ? { raw, remoteName: rest.slice(0, slash), branch: rest.slice(slash + 1) }
      : { raw, remoteName: "", branch: rest };
  }
  if (raw.startsWith("remotes/")) {
    const rest = raw.slice("remotes/".length);
    const slash = rest.indexOf("/");
    return slash > 0
      ? { raw, remoteName: rest.slice(0, slash), branch: rest.slice(slash + 1) }
      : { raw, remoteName: "", branch: rest };
  }
  if (raw.startsWith("refs/heads/")) {
    return { raw, remoteName: "", branch: raw.slice("refs/heads/".length) };
  }
  if (raw.startsWith("heads/")) {
    return { raw, remoteName: "", branch: raw.slice("heads/".length) };
  }
  for (const remoteName of remoteNames) {
    if (raw.startsWith(`${remoteName}/`)) {
      return { raw, remoteName, branch: raw.slice(remoteName.length + 1) };
    }
  }
  return { raw, remoteName: "", branch: raw };
}

async function optionalGit(gitRunner, args, options = {}) {
  try {
    const result = await gitRunner(args, options);
    return { ok: true, stdout: String(result?.stdout || "").trim(), error: "" };
  } catch (error) {
    return { ok: false, stdout: "", error: safeGitError(error, options.remoteUrl || "") };
  }
}

function firstCommitHash(value) {
  const hash = String(value || "").trim().split(/\s+/)[0];
  return /^[0-9a-f]{40,64}$/i.test(hash) ? hash.toLowerCase() : "";
}

// 评审开始前只读刷新“对应分支最新代码”证据。
// 不 fetch、不 checkout、不写原基仓：远端只用 ls-remote 核对 tip；远端对象不在本地时显式降级，
// 后续 AI 只能在独立临时仓库读取，不能把陈旧的本地 tracking ref 冒充远端最新代码。
export async function inspectGitCommitLatestBranch({
  repositoryPath,
  reviewContext = {},
  remoteUrl = "",
  gitRunner = defaultGitRunner,
  now = () => Date.now(),
} = {}) {
  const checkedAt = new Date(now()).toISOString();
  const revision = String(reviewContext?.revision || "").trim().toLowerCase();
  const base = {
    ok: false,
    status: "unavailable",
    checkedAt,
    revision,
    branch: "",
    branchSource: "",
    branchCandidates: [],
    localRef: "",
    localTip: "",
    remoteName: "",
    remoteRef: "",
    remoteTip: "",
    remoteChecked: false,
    comparisonRef: "",
    comparisonTip: "",
    comparisonReady: false,
    revisionIsAncestor: null,
    aheadCount: null,
    error: "",
  };
  if (!repositoryPath || !existsSync(repositoryPath)) {
    return { ...base, error: "评审 worktree 不存在，无法复核对应分支最新代码" };
  }
  if (!REVISION_RE.test(revision)) {
    return { ...base, error: "评审 revision 无效，无法复核对应分支最新代码" };
  }

  const remoteList = await optionalGit(gitRunner, ["-C", repositoryPath, "remote"]);
  const remoteNames = uniqueStrings(String(remoteList.stdout || "").split(/\r?\n/));
  const configuredRemoteUrl = String(remoteUrl || "").trim();
  const configuredRemoteKey = repositoryKey(configuredRemoteUrl);
  const localRemotes = [];
  for (const name of remoteNames) {
    const urlResult = await optionalGit(
      gitRunner,
      ["-C", repositoryPath, "remote", "get-url", name],
    );
    if (urlResult.stdout) {
      localRemotes.push({
        name,
        url: urlResult.stdout,
        key: repositoryKey(urlResult.stdout),
      });
    }
  }
  const inference = reviewContext?.inference || {};
  const branchResolution = inference.branchResolution && typeof inference.branchResolution === "object"
    ? inference.branchResolution
    : null;
  const branchEvidence = uniqueStrings([
    ...(Array.isArray(inference.branchCandidates) ? inference.branchCandidates : []),
    ...(Array.isArray(reviewContext?.branches) ? reviewContext.branches : []),
  ]);
  const canonicalEvidence = uniqueStrings(branchEvidence.map((candidate) => (
    branchLookup(candidate, remoteNames).branch
  )));
  const recordedCandidates = uniqueStrings([
    ...(Array.isArray(branchResolution?.candidates) ? branchResolution.candidates : []),
    ...canonicalEvidence,
  ]);
  if (branchResolution?.status === "ambiguous"
    || (!branchResolution && canonicalEvidence.length > 1)) {
    return {
      ...base,
      status: "branch_ambiguous",
      branchCandidates: recordedCandidates,
      error: `该 commit 同时位于多个候选分支（${recordedCandidates.join("、")}），无法自动确定应复核哪一个最新分支`,
    };
  }
  if (branchResolution?.status === "unavailable") {
    return {
      ...base,
      status: "branch_unavailable",
      branchCandidates: recordedCandidates,
      error: "没有能证明包含该 commit 的对应分支，无法复核最新代码",
    };
  }
  const candidates = uniqueStrings([
    branchResolution?.status === "resolved" ? branchResolution.branch : "",
    !branchResolution ? inference.branch : "",
    ...(!branchResolution ? canonicalEvidence : []),
  ]);
  if (!candidates.length) {
    return {
      ...base,
      status: "branch_unavailable",
      branchCandidates: recordedCandidates,
      error: "没有可用于最新代码复核的对应分支候选",
    };
  }

  let selected = null;
  for (const candidate of candidates) {
    const lookup = branchLookup(candidate, remoteNames);
    const candidateRefs = uniqueStrings([
      lookup.raw,
      lookup.branch ? `refs/heads/${lookup.branch}` : "",
      ...remoteNames.map((remoteName) => (
        lookup.branch ? `refs/remotes/${remoteName}/${lookup.branch}` : ""
      )),
    ]);
    for (const ref of candidateRefs) {
      const verified = await optionalGit(
        gitRunner,
        ["-C", repositoryPath, "rev-parse", "--verify", `${ref}^{commit}`],
      );
      const tip = firstCommitHash(verified.stdout);
      if (!tip) continue;
      const ancestry = await optionalGit(
        gitRunner,
        ["-C", repositoryPath, "merge-base", "--is-ancestor", revision, tip],
      );
      if (!ancestry.ok) continue;
      selected = {
        lookup,
        branchSource: candidate,
        localRef: ref,
        localTip: tip,
      };
      break;
    }
    if (selected) break;
  }

  const fallbackLookup = branchLookup(candidates[0], remoteNames);
  const lookup = selected?.lookup || fallbackLookup;
  const configuredRemote = configuredRemoteKey
    ? localRemotes.find((item) => item.key === configuredRemoteKey)
    : null;
  const explicitRemote = lookup.remoteName
    ? localRemotes.find((item) => item.name === lookup.remoteName)
    : null;
  // 创建故事点时选择的仓库地址是权威来源。即使本地存在多个 remote，
  // 也不能让字典序靠前的 fork/backup 覆盖它并冒充“对应分支最新代码”。
  const resolvedRemoteUrl = configuredRemote?.url
    || configuredRemoteUrl
    || explicitRemote?.url
    || (localRemotes.length === 1 ? localRemotes[0].url : "");
  const remoteName = configuredRemote?.name
    || (!configuredRemoteUrl ? (explicitRemote?.name || (localRemotes.length === 1 ? localRemotes[0].name : "")) : "");

  const remoteRef = lookup.branch ? `refs/heads/${lookup.branch}` : "";
  let remoteTip = "";
  let remoteChecked = false;
  let remoteError = "";
  if (resolvedRemoteUrl && remoteRef) {
    const remoteResult = await optionalGit(
      gitRunner,
      ["ls-remote", "--heads", resolvedRemoteUrl, remoteRef],
      { timeoutMs: 15_000, remoteUrl: resolvedRemoteUrl },
    );
    remoteChecked = true;
    remoteTip = firstCommitHash(remoteResult.stdout);
    if (!remoteResult.ok) remoteError = remoteResult.error;
    else if (!remoteTip) remoteError = `远端未找到对应分支 ${lookup.branch}`;
  }

  let remoteTipAvailableLocally = false;
  if (remoteTip) {
    const objectCheck = await optionalGit(
      gitRunner,
      ["-C", repositoryPath, "cat-file", "-e", `${remoteTip}^{commit}`],
    );
    remoteTipAvailableLocally = objectCheck.ok;
  }

  const localRef = selected?.localRef || "";
  const localTip = selected?.localTip || "";
  const comparisonTip = remoteTip
    ? (remoteTipAvailableLocally ? remoteTip : "")
    : localTip;
  const comparisonRef = remoteTip
    ? (remoteTipAvailableLocally ? remoteTip : "")
    : localRef;
  let revisionIsAncestor = null;
  let aheadCount = null;
  if (comparisonTip && (!remoteTip || remoteTipAvailableLocally)) {
    const ancestry = await optionalGit(
      gitRunner,
      ["-C", repositoryPath, "merge-base", "--is-ancestor", revision, comparisonTip],
    );
    revisionIsAncestor = ancestry.ok;
    if (ancestry.ok) {
      const count = await optionalGit(
        gitRunner,
        ["-C", repositoryPath, "rev-list", "--count", `${revision}..${comparisonTip}`],
      );
      if (/^\d+$/.test(count.stdout)) aheadCount = Number(count.stdout);
    }
  }

  let status = "unavailable";
  if (remoteTip) {
    status = remoteTipAvailableLocally ? "remote_verified" : "remote_tip_not_local";
  } else if (localTip) {
    status = remoteChecked ? "remote_unavailable_local_only" : "local_only";
  }
  if (status === "remote_verified" && revisionIsAncestor === false) {
    status = "remote_history_mismatch";
  }
  const comparisonReady = !!(
    comparisonTip
    && revisionIsAncestor === true
    && remoteTip
    && remoteTipAvailableLocally
  );
  const errors = [
    remoteError,
    !configuredRemoteUrl && !lookup.remoteName && localRemotes.length > 1
      ? "本地存在多个远端且故事点未记录权威仓库地址，无法确认应复核哪个远端"
      : "",
    configuredRemoteUrl && !configuredRemote
      ? "所选权威仓库地址未绑定到本地 remote，已直接按该地址只读核对远端 tip"
      : "",
    configuredRemoteUrl && explicitRemote && explicitRemote.key !== configuredRemoteKey
      ? `分支候选中的 remote ${lookup.remoteName} 与所选权威仓库不一致，未使用该 remote 的 tip`
      : "",
    !selected ? "本地分支候选无法解析或不再包含被评审 revision" : "",
    remoteTip && !remoteTipAvailableLocally
      ? "远端最新 tip 尚不在本地对象库，必须使用独立临时仓库读取后才能判断是否已修复"
      : "",
    revisionIsAncestor === false ? "被评审 revision 不在实际比较 tip 的历史中" : "",
  ].filter(Boolean);

  return {
    ...base,
    ok: !!comparisonTip || !!remoteTip,
    status,
    branch: lookup.branch,
    branchSource: branchResolution?.source || selected?.branchSource || candidates[0],
    branchCandidates: recordedCandidates,
    localRef,
    localTip,
    remoteName,
    remoteRef,
    remoteTip,
    remoteChecked,
    comparisonRef,
    comparisonTip,
    comparisonReady,
    revisionIsAncestor,
    aheadCount,
    error: errors.join("；"),
  };
}

const BATCH_MATCH_PRIORITY = {
  revision: 100,
  remote_revision: 95,
  branch: 90,
  remote_branch: 85,
  message: 80,
  ticket: 75,
  remote_ticket: 70,
  message_terms: 60,
  ticket_terms: 55,
  revision_fragment: 50,
};

function preferredBatchMatchKind(values = []) {
  return uniqueStrings(values).sort((left, right) => (
    (BATCH_MATCH_PRIORITY[right] || 0) - (BATCH_MATCH_PRIORITY[left] || 0)
  ))[0] || "";
}

function publicBatchCandidate(repository, commit, matchKinds = []) {
  const normalizedMatchKinds = uniqueStrings(Array.isArray(matchKinds) ? matchKinds : [matchKinds]);
  const matchKind = preferredBatchMatchKind(normalizedMatchKinds);
  return {
    key: `${repository.id}:${commit.revision}`,
    repositoryId: repository.id,
    repositoryName: repository.name || repository.id,
    repositoryUrl: safeRemoteUrl(repository.displayUrl || repository.remoteUrl || ""),
    revision: commit.revision,
    shortRevision: commit.shortRevision || commit.revision.slice(0, 12),
    subject: commit.subject || "",
    author: commit.author || "",
    committedAt: commit.committedAt || "",
    branches: Array.isArray(commit.branches) ? commit.branches : [],
    stats: commit.stats || null,
    sourceProjectId: commit.source?.projectId || "",
    sourceProjectName: commit.source?.projectName || "",
    sourceRole: commit.source?.role || "",
    matchKind,
    matchKinds: normalizedMatchKinds,
    matchScore: BATCH_MATCH_PRIORITY[matchKind] || 0,
  };
}

function mergeBatchCandidate(candidates, incoming) {
  const existing = candidates.find((candidate) => candidate.key === incoming.key);
  if (!existing) {
    candidates.push(incoming);
    return;
  }
  existing.matchKinds = uniqueStrings([...(existing.matchKinds || []), ...(incoming.matchKinds || [])]);
  existing.matchKind = preferredBatchMatchKind(existing.matchKinds);
  existing.matchScore = BATCH_MATCH_PRIORITY[existing.matchKind] || 0;
  existing.branches = uniqueStrings([...(existing.branches || []), ...(incoming.branches || [])]);
  if (!existing.sourceProjectId && incoming.sourceProjectId) {
    existing.sourceProjectId = incoming.sourceProjectId;
    existing.sourceProjectName = incoming.sourceProjectName;
    existing.sourceRole = incoming.sourceRole;
  }
}

function batchMessageSearchTerms(value) {
  const full = normalizeBatchMessageQuery(value);
  const terms = uniqueStrings(full
    .split(/[\s,，。.!！?？:：;；、/\\|()[\]{}【】<>《》"'“”‘’#]+/u)
    .map((term) => term.trim())
    .filter((term) => term.length >= 2 && !REVISION_RE.test(term)));
  return { full, terms };
}

async function searchCommitMessageHashes(
  repositoryPath,
  query,
  gitRunner,
  { exactKind = "message", termsKind = "message_terms" } = {},
) {
  const { full, terms } = batchMessageSearchTerms(query);
  if (!full) return [];
  const runSearch = async (patterns, allMatch = false) => {
    if (!patterns.length) return [];
    const args = [
      "-C",
      repositoryPath,
      "log",
      "--all",
      "--format=%H",
      "--fixed-strings",
      "--regexp-ignore-case",
      `--max-count=${MAX_BATCH_MATCHES_PER_CHECKOUT}`,
      ...(allMatch ? ["--all-match"] : []),
      ...patterns.map((pattern) => `--grep=${pattern}`),
    ];
    const result = await gitRunner(args);
    return uniqueStrings(String(result.stdout || "").split(/\r?\n/))
      .map((hash) => hash.toLowerCase())
      .filter((hash) => /^[0-9a-f]{40,64}$/.test(hash));
  };
  const exact = await runSearch([full]).catch(() => []);
  if (exact.length || terms.length <= 1) {
    return exact.map((revision) => ({ revision, matchKind: exactKind }));
  }
  const fuzzy = await runSearch(terms, true).catch(() => []);
  return fuzzy.map((revision) => ({ revision, matchKind: termsKind }));
}

async function searchRevisionFragmentHashes(repositoryPath, reference, gitRunner) {
  const fragment = String(reference || "").trim().toLowerCase();
  if (!REVISION_RE.test(fragment)) return [];
  const result = await gitRunner(["-C", repositoryPath, "rev-list", "--all"]);
  return uniqueStrings(String(result.stdout || "").split(/\r?\n/))
    .map((hash) => hash.toLowerCase())
    .filter((hash) => /^[0-9a-f]{40,64}$/.test(hash) && hash.includes(fragment))
    .slice(0, MAX_BATCH_MATCHES_PER_CHECKOUT);
}

async function resolveLocalBatchHashes(reference, localCandidate, gitRunner) {
  const hashes = [];
  const append = (values, matchKind) => {
    for (const revision of values) {
      const existing = hashes.find((row) => row.revision === revision);
      if (existing) {
        existing.matchKinds = uniqueStrings([...(existing.matchKinds || []), matchKind]);
        existing.matchKind = preferredBatchMatchKind(existing.matchKinds);
      } else {
        hashes.push({ revision, matchKind, matchKinds: [matchKind] });
      }
    }
  };
  if (reference.queryType !== "message") {
    try {
      const verified = await gitRunner([
        "-C",
        localCandidate.path,
        "rev-parse",
        "--verify",
        `${reference.reference}^{commit}`,
      ]);
      const fullRevision = String(verified.stdout || "").trim().split(/\r?\n/)[0].toLowerCase();
      if (/^[0-9a-f]{40,64}$/.test(fullRevision)) append([fullRevision], "revision");
    } catch {
      const fragments = await searchRevisionFragmentHashes(
        localCandidate.path,
        reference.reference,
        gitRunner,
      ).catch(() => []);
      append(fragments, "revision_fragment");
    }
  }
  if (!hashes.length || reference.searchAlternatives) {
    const queryRows = [
      ...(Array.isArray(reference.ticketKeys) ? reference.ticketKeys : [])
        .map((query) => ({ query, exactKind: "ticket", termsKind: "ticket_terms" })),
      ...(Array.isArray(reference.messageQueries) && reference.messageQueries.length
        ? reference.messageQueries
        : [reference.messageQuery])
        .filter((query) => query && !(reference.ticketKeys || []).includes(query))
        .map((query) => ({ query, exactKind: "message", termsKind: "message_terms" })),
    ];
    for (const queryRow of queryRows.slice(0, MAX_BATCH_MESSAGE_QUERIES)) {
      const messageMatches = await searchCommitMessageHashes(
        localCandidate.path,
        queryRow.query,
        gitRunner,
        queryRow,
      );
      for (const match of messageMatches) append([match.revision], match.matchKind);
    }
  }
  return hashes;
}

function normalizedBranchSearchValue(value) {
  return String(value || "").toLocaleLowerCase().replace(/[^a-z0-9]+/g, "");
}

async function remoteBranchesForRepository(repository, gitRunner, cache) {
  const remoteUrl = String(repository?.remoteUrl || "").trim();
  if (!remoteUrl) return [];
  const key = repositoryKey(remoteUrl) || remoteUrl;
  if (!cache.has(key)) {
    cache.set(key, gitRunner(["ls-remote", "--heads", remoteUrl], {
      timeoutMs: 45_000,
      remoteUrl,
    }).then((result) => parseRemoteBranches(result.stdout)));
  }
  return cache.get(key);
}

function remoteBatchMatches(reference, remoteBranches = []) {
  const matches = new Map();
  const append = (revision, matchKind, branch = "") => {
    const normalizedRevision = String(revision || "").trim().toLowerCase();
    if (!/^[0-9a-f]{40,64}$/.test(normalizedRevision)) return;
    const current = matches.get(normalizedRevision) || {
      revision: normalizedRevision,
      matchKinds: [],
      branches: [],
    };
    current.matchKinds = uniqueStrings([...current.matchKinds, matchKind]);
    current.branches = uniqueStrings([...current.branches, branch]);
    matches.set(normalizedRevision, current);
  };
  const revisionFragment = reference.queryType === "revision"
    ? String(reference.reference || "").trim().toLowerCase()
    : "";
  const ticketValues = (Array.isArray(reference.ticketKeys) ? reference.ticketKeys : [])
    .map(normalizedBranchSearchValue)
    .filter(Boolean);
  const branchValues = (Array.isArray(reference.branchHints) ? reference.branchHints : [])
    .map(normalizedBranchSearchValue)
    .filter(Boolean);
  for (const remoteBranch of remoteBranches) {
    const branchValue = normalizedBranchSearchValue(remoteBranch.branch);
    if (revisionFragment && String(remoteBranch.hash || "").toLowerCase().includes(revisionFragment)) {
      append(remoteBranch.hash, "remote_revision", remoteBranch.branch);
    }
    if (branchValues.some((value) => value === branchValue)) {
      append(remoteBranch.hash, "remote_branch", remoteBranch.branch);
    }
    if (ticketValues.some((value) => branchValue.includes(value))) {
      append(remoteBranch.hash, "remote_ticket", remoteBranch.branch);
    }
  }
  if (/^[0-9a-f]{40,64}$/.test(revisionFragment)) {
    append(revisionFragment, "remote_revision");
  }
  return [...matches.values()].slice(0, MAX_BATCH_MATCHES_PER_CHECKOUT);
}

function commitSubjectMatchKinds(subject, reference) {
  const normalizedSubject = String(subject || "").toLocaleLowerCase();
  if (!normalizedSubject) return [];
  const matchKinds = [];
  for (const ticketKey of Array.isArray(reference.ticketKeys) ? reference.ticketKeys : []) {
    if (normalizedSubject.includes(ticketKey.toLocaleLowerCase())) matchKinds.push("ticket");
  }
  for (const query of Array.isArray(reference.messageQueries) ? reference.messageQueries : []) {
    if (!query || (reference.ticketKeys || []).includes(query)) continue;
    const normalizedQuery = query.toLocaleLowerCase();
    if (normalizedSubject.includes(normalizedQuery)) {
      matchKinds.push("message");
      continue;
    }
    const { terms } = batchMessageSearchTerms(query);
    if (terms.length > 1 && terms.every((term) => normalizedSubject.includes(term.toLocaleLowerCase()))) {
      matchKinds.push("message_terms");
    }
  }
  return uniqueStrings(matchKinds);
}

export async function resolveGitCommitBatch({
  input,
  repositories = [],
  repositoryId = "",
  gitRunner = defaultGitRunner,
} = {}) {
  const extracted = extractGitCommitReferences(input);
  if (!extracted.ok) return extracted;

  const requestedRepositoryId = String(repositoryId || "").trim();
  const catalog = (Array.isArray(repositories) ? repositories : [])
    .filter((repository) => !requestedRepositoryId || String(repository?.id || "") === requestedRepositoryId)
    .map((repository) => ({
      id: String(repository?.id || "").trim(),
      name: String(repository?.name || repository?.id || "").trim(),
      remoteUrl: String(repository?.remoteUrl || "").trim(),
      displayUrl: String(repository?.displayUrl || repository?.remoteUrl || "").trim(),
      localCandidates: (Array.isArray(repository?.localCandidates) ? repository.localCandidates : [])
        .filter((candidate) => candidate?.path && existsSync(candidate.path)),
    }))
    .filter((repository) => repository.id && repository.localCandidates.length);
  if (!catalog.length) {
    return {
      ok: false,
      code: "GIT_BATCH_LOCAL_REPOSITORY_REQUIRED",
      error: requestedRepositoryId
        ? "所选仓库没有可读取的本地 Git 工程，请先在工程配置中登记并同步"
        : "没有可用于批量检索的本地 Git 工程，请先在工程配置中登记本机 checkout",
    };
  }

  const items = [];
  const resolvedKeyToIndex = new Map();
  const preferredCheckoutByRepository = new Map();
  const remoteBranchesCache = new Map();
  for (const reference of extracted.references) {
    if (reference.duplicateOf != null) {
      items.push({
        ...reference,
        status: "duplicate",
        candidates: [],
      });
      continue;
    }

    let candidates = [];
    const inspectionErrors = [];
    for (const repository of catalog) {
      const preferredPath = preferredCheckoutByRepository.get(repository.id);
      const localCandidates = preferredPath
        ? [
          ...repository.localCandidates.filter((candidate) => candidate.path === preferredPath),
          ...repository.localCandidates.filter((candidate) => candidate.path !== preferredPath),
        ]
        : repository.localCandidates;
      for (const localCandidate of localCandidates) {
        const candidateCountBeforeCheckout = candidates.length;
        try {
          const matches = await resolveLocalBatchHashes(reference, localCandidate, gitRunner);
          for (const match of matches) {
            const inspected = await inspectGitCommit({
              revision: match.revision,
              remoteUrl: "",
              localCandidates: [localCandidate],
              gitRunner,
            });
            if (!inspected.ok) {
              inspectionErrors.push(`${repository.name}：${inspected.error}`);
              continue;
            }
            const candidate = publicBatchCandidate(
              repository,
              inspected.commit,
              match.matchKinds || [match.matchKind],
            );
            mergeBatchCandidate(candidates, candidate);
          }
          // 同一逻辑仓库可能登记了多份 checkout。按配置顺序使用首个有结果的历史，
          // 没命中时才继续尝试下一份，避免对大量同源 WebApp 副本重复执行 git log/show。
          if (candidates.length > candidateCountBeforeCheckout) {
            preferredCheckoutByRepository.set(repository.id, localCandidate.path);
            break;
          }
        } catch (error) {
          const message = safeGitError(error);
          if (/ambiguous/i.test(message)) inspectionErrors.push(`${repository.name}：revision 在该仓库内不唯一`);
        }
      }
    }

    if (!candidates.length || reference.searchAlternatives) {
      for (const repository of catalog) {
        if (!repository.remoteUrl) continue;
        try {
          const remoteBranches = await remoteBranchesForRepository(
            repository,
            gitRunner,
            remoteBranchesCache,
          );
          const remoteMatches = remoteBatchMatches(reference, remoteBranches);
          for (const match of remoteMatches) {
            const inspected = await inspectGitCommit({
              revision: match.revision,
              remoteUrl: repository.remoteUrl,
              localCandidates: [],
              gitRunner,
            });
            if (!inspected.ok) {
              inspectionErrors.push(`${repository.name}：${inspected.error}`);
              continue;
            }
            inspected.commit.branches = uniqueStrings([
              ...(inspected.commit.branches || []),
              ...(match.branches || []),
            ]);
            const candidate = publicBatchCandidate(repository, inspected.commit, [
              ...(match.matchKinds || []),
              ...commitSubjectMatchKinds(inspected.commit.subject, reference),
            ]);
            mergeBatchCandidate(candidates, candidate);
          }
        } catch (error) {
          inspectionErrors.push(`${repository.name}：远程分支检索失败：${safeGitError(error, repository.remoteUrl)}`);
        }
      }
    }
    if (!reference.searchAlternatives && candidates.some((candidate) => candidate.matchKind === "message")) {
      candidates = candidates.filter((candidate) => candidate.matchKind === "message");
    }
    candidates = candidates
      .sort((left, right) => (
        Number(right.matchScore || 0) - Number(left.matchScore || 0)
        || String(right.committedAt || "").localeCompare(String(left.committedAt || ""))
        || left.key.localeCompare(right.key)
      ))
      .slice(0, MAX_BATCH_CANDIDATES_PER_QUERY);

    if (!candidates.length) {
      items.push({
        ...reference,
        status: "not_found",
        candidates: [],
        error: inspectionErrors[0]
          || `未在 ${catalog.length} 个已配置本地仓库中找到「${reference.reference}」`,
      });
      continue;
    }
    if (candidates.length > 1) {
      items.push({
        ...reference,
        status: "ambiguous",
        candidates,
        error: `查询同时命中 ${candidates.length} 个提交，请明确选择`,
      });
      continue;
    }

    const resolution = candidates[0];
    const duplicateOf = resolvedKeyToIndex.get(resolution.key);
    if (duplicateOf != null) {
      items.push({
        ...reference,
        status: "duplicate",
        duplicateOf,
        candidates,
        resolution,
      });
      continue;
    }
    resolvedKeyToIndex.set(resolution.key, reference.inputIndex);
    items.push({
      ...reference,
      status: "resolved",
      candidates,
      resolution,
    });
  }

  const count = (status) => items.filter((item) => item.status === status).length;
  return {
    ok: true,
    data: {
      items,
      summary: {
        total: items.length,
        resolved: count("resolved"),
        ambiguous: count("ambiguous"),
        notFound: count("not_found"),
        duplicate: count("duplicate"),
        repositoriesSearched: catalog.length,
      },
    },
  };
}

function evidenceText(commit = {}) {
  return [
    commit.subject,
    ...(commit.branches || []),
    ...(commit.changedFiles || []).flatMap((file) => [file.path, file.previousPath]),
  ].filter(Boolean).join("\n").toLowerCase();
}

function includesEvidence(haystack, value) {
  const needle = String(value || "").trim().toLowerCase();
  return !!needle && haystack.includes(needle);
}

function scoreRegisteredTarget(target, commit, branchSet, text) {
  let score = 0;
  const reasons = [];
  if (target.branch && branchSet.has(String(target.branch).toLowerCase())) {
    score += 120;
    reasons.push(`commit 位于配置分支 ${target.branch}`);
  }
  if (target.flavor && includesEvidence(text, target.flavor)) {
    score += 48;
    reasons.push(`改动路径或提交信息命中 Flavor ${target.flavor}`);
  }
  if (target.vehicle && includesEvidence(text, target.vehicle)) {
    score += 36;
    reasons.push(`改动路径、分支或提交信息命中车型 ${target.vehicle}`);
  }
  if (target.appName && includesEvidence(text, target.appName)) {
    score += 18;
    reasons.push(`提交信息命中应用 ${target.appName}`);
  }
  return { score, reasons };
}

function chooseCommitBranch(commit, mappedBranches = [], defaultBranch = "") {
  const variants = branchVariants(commit?.branches || []);
  const byLower = new Map(variants.map((branch) => [branch.toLowerCase(), branch]));
  for (const mapped of mappedBranches) {
    const hit = byLower.get(String(mapped || "").trim().toLowerCase());
    if (hit) return hit;
  }
  const current = String(commit?.currentBranch || "").trim();
  if (current && byLower.has(current.toLowerCase())) return byLower.get(current.toLowerCase());
  const configured = String(defaultBranch || "").trim();
  if (configured && byLower.has(configured.toLowerCase())) return byLower.get(configured.toLowerCase());
  return variants.find((branch) => !/^HEAD$/i.test(branch)) || configured || String(mappedBranches[0] || "").trim();
}

function canonicalCommitBranchCandidates(values = []) {
  const rawBranches = uniqueStrings(values)
    .map(branchIdentityFromRef)
    .filter((value) => value && !/(?:^|\/)HEAD$/i.test(value));
  return uniqueStrings(rawBranches.map((branch) => (
    /^origin\//i.test(branch) ? branch.slice(branch.indexOf("/") + 1) : branch
  )));
}

function resolveCommitBranchIdentity(commit, mappedBranches = []) {
  const candidates = canonicalCommitBranchCandidates(commit?.branches || []);
  const candidateByLower = new Map(candidates.map((branch) => [branch.toLowerCase(), branch]));
  const mappedMatches = uniqueStrings(mappedBranches
    .map((branch) => candidateByLower.get(String(branch || "").trim().toLowerCase()) || "")
    .filter(Boolean));
  if (mappedMatches.length === 1) {
    return {
      status: "resolved",
      source: "registered_branch",
      branch: mappedMatches[0],
      candidates,
    };
  }
  if (candidates.length === 1) {
    return {
      status: "resolved",
      source: "single_containing_branch",
      branch: candidates[0],
      candidates,
    };
  }
  if (candidates.length > 1) {
    return {
      status: "ambiguous",
      source: mappedMatches.length > 1 ? "multiple_registered_branches" : "multiple_containing_branches",
      branch: "",
      candidates,
    };
  }
  return {
    status: "unavailable",
    source: "no_containing_branch",
    branch: "",
    candidates: [],
  };
}

function targetIdentity(target) {
  return [
    target.repositoryId,
    target.vehicle,
    target.appName,
    target.branch,
    target.flavor,
  ].map((value) => String(value || "").trim().toLowerCase()).join("\u0000");
}

export function inferGitCommitConfiguration({
  repository,
  commit,
  projectDefs = [],
  vehicleMap = {},
} = {}) {
  const definition = repository || {};
  const registry = buildConfigInferenceRegistry(projectDefs, vehicleMap);
  const repositoryId = String(definition.id || "").trim();
  if (!repositoryId) {
    return { ok: false, code: "GIT_REPOSITORY_REQUIRED", error: "缺少仓库定义，无法推导故事点配置" };
  }
  const repositoryTargets = registry.targets.filter((target) => target.repositoryId === repositoryId);
  const branchSet = new Set(branchVariants(commit?.branches || []).map((branch) => branch.toLowerCase()));
  const text = evidenceText(commit);
  const ranked = repositoryTargets
    .filter((target) => !target.repositoryOnly)
    .map((target, index) => ({ target, index, ...scoreRegisteredTarget(target, commit, branchSet, text) }))
    .sort((left, right) => right.score - left.score || left.index - right.index);
  const positive = ranked.filter((row) => row.score > 0);
  const best = positive[0] || (ranked.length === 1 ? ranked[0] : null);
  const mappedBranches = repositoryTargets
    .filter((target) => !target.repositoryOnly)
    .map((target) => target.branch)
    .filter(Boolean);
  const branchResolution = resolveCommitBranchIdentity(commit, mappedBranches);
  const commitBranch = branchResolution.branch
    || chooseCommitBranch(commit, mappedBranches, definition.defaultBranch);
  const selectedBase = best?.target || repositoryTargets.find((target) => target.repositoryOnly) || {
    appName: "",
    vehicle: "",
    repositoryId,
    repositoryName: definition.name || repositoryId,
    gitUrl: definition.ssh || definition.https || "",
    branch: definition.defaultBranch || "",
    flavor: definition.defaultFlavor || "",
    projectType: definition.projectType || "application",
    targetRole: "standalone",
    repositoryOnly: definition.projectType !== "application",
  };

  let targets = [];
  if (best?.target) {
    targets = registry.targets.filter((target) => (
      !target.repositoryOnly
      && target.vehicle === best.target.vehicle
      && target.appName === best.target.appName
    ));
  } else {
    targets = [selectedBase];
  }

  const requiredIds = uniqueStrings(definition.requiresRepositories || []);
  for (const requiredId of requiredIds) {
    if (targets.some((target) => target.repositoryId === requiredId)) continue;
    const dependency = registry.targets.find((target) => (
      target.repositoryId === requiredId
      && (!best?.target || (
        target.vehicle === best.target.vehicle
        && target.appName === best.target.appName
      ))
    )) || registry.targets.find((target) => target.repositoryId === requiredId);
    if (dependency) targets.push(dependency);
  }

  const deduped = [];
  const seen = new Set();
  for (const target of targets) {
    const key = targetIdentity(target);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    deduped.push({ ...target });
  }
  targets = deduped;

  const selectedIndex = targets.findIndex((target) => target.repositoryId === repositoryId);
  if (selectedIndex < 0) targets.unshift({ ...selectedBase });
  const applicationTargets = targets.filter((target) => !target.repositoryOnly);
  const selectedApplication = targets.find((target) => target.repositoryId === repositoryId && !target.repositoryOnly);
  const applicationPrimary = selectedApplication || applicationTargets.find((target) => target.targetRole === "primary") || applicationTargets[0];
  targets = targets.map((target, index) => {
    const selected = target.repositoryId === repositoryId;
    let targetRole;
    if (applicationPrimary) targetRole = target === applicationPrimary ? "primary" : "dependency";
    else targetRole = selected ? "standalone" : "dependency";
    return {
      ...target,
      ...(selected ? { branch: commitBranch || target.branch } : {}),
      targetRole,
      order: selected ? 1 : index + 2,
      confidence: best?.score
        ? Math.min(0.99, Number((0.62 + Math.min(best.score, 180) / 500).toFixed(2)))
        : (repositoryTargets.length === 1 ? 0.55 : 0.35),
      evidenceIds: selected ? ["git:revision", "git:branches", "git:changed-files"] : ["vehicle-map:dependency"],
    };
  });

  targets = normalizeConfigInferenceTargets(targets);
  const primary = targets.find((target) => ["primary", "standalone"].includes(target.targetRole)) || targets[0];
  const selected = targets.find((target) => target.repositoryId === repositoryId) || primary;
  const dependencies = targets
    .filter((target) => target.repositoryId !== repositoryId)
    .map((target) => ({
      repositoryId: target.repositoryId,
      repositoryName: target.repositoryName,
      branch: target.branch,
      flavor: target.flavor,
      targetRole: target.targetRole,
    }));
  return {
    ok: true,
    targets,
    summary: {
      repositoryId,
      repositoryName: definition.name || repositoryId,
      branch: selected?.branch || commitBranch || "",
      branchCandidates: branchVariants(commit?.branches || []),
      branchResolution,
      appName: selected?.appName || primary?.appName || "",
      vehicle: selected?.vehicle || primary?.vehicle || "",
      flavor: selected?.flavor || primary?.flavor || "",
      dependencies,
      confidence: selected?.confidence || 0.35,
      reasons: best?.reasons?.length
        ? best.reasons
        : ["已确认 commit 与所选仓库；车型/Flavor 暂无唯一强证据，保留仓库默认配置"],
    },
  };
}

export function buildGitReviewTitle(commit = {}) {
  const shortRevision = String(commit.shortRevision || commit.revision || "").slice(0, 12);
  const subject = String(commit.subject || "").replace(/\s+/g, " ").trim();
  return `Review ${shortRevision}${subject ? ` · ${subject}` : ""}`.slice(0, 120);
}
