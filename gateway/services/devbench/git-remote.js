/**
 * DevBench Git 远程访问探测。
 *
 * 仓库定义同时保存 SSH/HTTPS 地址，但不同开发机可能只配置了其中一种认证方式。
 * 这里优先使用 HTTPS，并在认证不可用时自动回退 SSH，供权限检查、分支查询
 * 和真正 clone 共同使用，避免“检查通过但 clone 失败”或把认证方式误判为仓库权限。
 */
import { execFile } from "child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const CACHE_TTL_MS = 5 * 60 * 1000;
const lsRemoteCache = new Map();

const GIT_ENV = {
  GIT_TERMINAL_PROMPT: "0",
  GCM_INTERACTIVE: "Never",
  GIT_SSH_COMMAND: "ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new",
};

function runGit(args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile("git", args, {
      cwd: options.cwd,
      timeout: Number(options.timeout) > 0 ? Number(options.timeout) : 120000,
      windowsHide: true,
      encoding: "utf8",
      maxBuffer: Number(options.maxBuffer) > 0 ? Number(options.maxBuffer) : 2 * 1024 * 1024,
      env: { ...process.env, ...GIT_ENV },
    }, (error, stdout, stderr) => {
      if (!error) return resolve({ stdout: String(stdout || ""), stderr: String(stderr || "") });
      const failure = new Error(String(stderr || error.message || "git 命令失败").trim());
      failure.code = error.code;
      failure.stdout = String(stdout || "");
      failure.stderr = String(stderr || "");
      reject(failure);
    });
  });
}

function safeRemoteBranchName(branch) {
  const value = String(branch || "").trim();
  if (!value || value.startsWith("-") || value.startsWith("/") || value.endsWith("/")) return "";
  if (value.includes("..") || value.includes("@{") || value.includes("//") || value.endsWith(".")) return "";
  if (/[\u0000-\u0020~^:?*[\]\\]/.test(value)) return "";
  if (value.split("/").some((part) => !part || part === "." || part.endsWith(".lock"))) return "";
  return value;
}

function branchPatternRegex(pattern) {
  const source = String(pattern || "").trim();
  if (!source) return null;
  const escaped = source.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replaceAll("*", ".*");
  return new RegExp(`^${escaped}$`);
}

export function filterRemoteBranches(branches = [], patterns = []) {
  const matchers = (Array.isArray(patterns) ? patterns : []).map(branchPatternRegex).filter(Boolean);
  if (!matchers.length) return [];
  return [...new Set((Array.isArray(branches) ? branches : [])
    .map(safeRemoteBranchName)
    .filter((branch) => branch && matchers.some((matcher) => matcher.test(branch))))]
    .sort((left, right) => left.localeCompare(right));
}

async function readCandidateBranchFiles(remoteUrl, branches, filePaths, options = {}) {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "aiefficiency-vehicle-scan-"));
  const refs = new Map();
  const rows = [];
  try {
    await runGit(["init", "--bare", "--quiet", tempRoot], options);
    await runGit(["remote", "add", "origin", remoteUrl], { ...options, cwd: tempRoot });
    await runGit(["config", "remote.origin.promisor", "true"], { ...options, cwd: tempRoot });
    await runGit(["config", "remote.origin.partialclonefilter", "blob:none"], { ...options, cwd: tempRoot });

    for (const branch of branches) {
      const digest = createHash("sha256").update(branch).digest("hex").slice(0, 24);
      refs.set(branch, `refs/aiefficiency/vehicle-scan/${digest}`);
    }
    const refspecs = [...refs.entries()].map(([branch, ref]) => `+refs/heads/${branch}:${ref}`);
    for (let offset = 0; offset < refspecs.length; offset += 32) {
      await runGit([
        "fetch", "--quiet", "--no-tags", "--depth=1", "--filter=blob:none", "origin",
        ...refspecs.slice(offset, offset + 32),
      ], { ...options, cwd: tempRoot });
    }

    for (const branch of branches) {
      const ref = refs.get(branch);
      const files = {};
      const fileErrors = [];
      for (const filePath of filePaths) {
        const objectSpec = `${ref}:${filePath}`;
        try {
          await runGit(["cat-file", "-e", objectSpec], { ...options, cwd: tempRoot, maxBuffer: 128 * 1024 });
        } catch {
          continue;
        }
        try {
          const result = await runGit(["show", "--no-textconv", objectSpec], {
            ...options,
            cwd: tempRoot,
            maxBuffer: Number(options.maxFileBytes) > 0 ? Number(options.maxFileBytes) : 1024 * 1024,
          });
          files[filePath] = result.stdout;
        } catch (error) {
          fileErrors.push({ file: filePath, error: safeGitRemoteError(error.message, remoteUrl) });
        }
      }
      rows.push({ branch, files, fileErrors });
    }
    return rows;
  } finally {
    const resolvedTemp = path.resolve(tempRoot);
    const resolvedOsTemp = path.resolve(os.tmpdir());
    if (resolvedTemp.startsWith(resolvedOsTemp + path.sep) && path.basename(resolvedTemp).startsWith("aiefficiency-vehicle-scan-")) {
      fs.rmSync(resolvedTemp, { recursive: true, force: true });
    }
  }
}

export function gitRemoteTransport(url) {
  const value = String(url || "").trim();
  if (/^git@/i.test(value) || /^ssh:\/\//i.test(value)) return "ssh";
  if (/^https:\/\//i.test(value)) return "https";
  return "other";
}

export function safeGitRemoteUrl(url) {
  const value = String(url || "").trim();
  if (!/^https?:\/\//i.test(value)) return value;
  try {
    const parsed = new URL(value);
    if (parsed.username) parsed.username = "***";
    if (parsed.password) parsed.password = "***";
    return parsed.toString().replace(/\/$/, "");
  } catch {
    return value.replace(/\/\/[^/@\s]+@/, "//***@");
  }
}

export function safeGitRemoteError(error, remoteUrl) {
  let value = String(error || "ls-remote 失败").trim();
  const rawUrl = String(remoteUrl || "").trim();
  const maskedUrl = safeGitRemoteUrl(rawUrl);
  if (rawUrl && maskedUrl !== rawUrl) value = value.split(rawUrl).join(maskedUrl);
  return value
    .replace(/(https?:\/\/)[^/\s'"]+@/gi, "$1***@")
    .slice(0, 400);
}

export function gitHttpsToSsh(url) {
  try {
    const parsed = new URL(String(url || "").trim());
    if (!["http:", "https:"].includes(parsed.protocol) || !parsed.hostname) return "";
    const repositoryPath = parsed.pathname.replace(/^\/+|\/+$/g, "").replace(/\.git$/i, "");
    return repositoryPath ? `git@${parsed.hostname}:${repositoryPath}.git` : "";
  } catch {
    return "";
  }
}

export function gitRemoteUrlCandidates(url) {
  const value = String(url || "").trim();
  if (!value) return [];
  // Codeup 的仓库网页地址不带 .git；Git Smart HTTP 的 /info/refs 请求不能安全
  // 跟随登录页重定向，所以直接使用规范的 .git 克隆地址。
  if (/^https:\/\/codeup\.aliyun\.com\/.+/i.test(value) && !/\.git\/?$/i.test(value)) {
    return [`${value.replace(/\/+$/, "")}.git`];
  }
  return [value];
}

export function gitRemoteCandidates(remote) {
  const values = typeof remote === "string"
    ? gitRemoteUrlCandidates(remote)
    : [...gitRemoteUrlCandidates(remote?.https), ...gitRemoteUrlCandidates(remote?.ssh)];
  const seen = new Set();
  return values
    .map((value) => String(value || "").trim())
    .filter((value) => {
      if (!value || seen.has(value)) return false;
      seen.add(value);
      return true;
    });
}

export function clearGitRemoteCache() {
  lsRemoteCache.clear();
}

export function gitLsRemoteHeads(url, force = false, options = {}) {
  return new Promise((resolve) => {
    const remoteUrl = String(url || "").trim();
    if (!remoteUrl) return resolve({ ok: false, error: "未配置远程地址" });
    const cached = lsRemoteCache.get(remoteUrl);
    if (!force && cached && Date.now() - cached.ts < CACHE_TTL_MS) {
      return resolve({ ok: true, branches: cached.branches, cached: true });
    }
    execFile("git", ["ls-remote", "--heads", remoteUrl], {
      timeout: Number(options.timeout) > 0 ? Number(options.timeout) : 40000,
      windowsHide: true,
      encoding: "utf8",
      env: { ...process.env, ...GIT_ENV },
    }, (err, stdout, stderr) => {
      if (err) {
        return resolve({
          ok: false,
          error: String(stderr || err.message || "ls-remote 失败").trim().slice(0, 400),
        });
      }
      const branches = String(stdout).split(/\r?\n/)
        .map((line) => {
          const match = line.match(/refs\/heads\/(.+)$/);
          return match ? match[1] : null;
        })
        .filter(Boolean)
        .sort();
      lsRemoteCache.set(remoteUrl, { ts: Date.now(), branches });
      resolve({ ok: true, branches });
    });
  });
}

export async function resolveAccessibleGitRemote(remote, options = {}) {
  const candidates = gitRemoteCandidates(remote);
  if (!candidates.length) return { ok: false, url: "", attempts: [], error: "未配置远程地址" };

  const probe = typeof options.probe === "function" ? options.probe : gitLsRemoteHeads;
  const attempts = [];
  for (const [candidateIndex, url] of candidates.entries()) {
    const result = await probe(url, options.force === true, options);
    const attempt = {
      url: safeGitRemoteUrl(url),
      transport: gitRemoteTransport(url),
      ok: result?.ok === true,
      error: result?.ok === true ? null : safeGitRemoteError(result?.error, url),
    };
    attempts.push(attempt);
    if (attempt.ok) {
      return {
        ...result,
        ok: true,
        url: attempt.url,
        candidateIndex,
        transport: attempt.transport,
        fallback: attempts.length > 1,
        attempts,
      };
    }
  }

  const error = attempts
    .map((attempt) => `[${attempt.transport.toUpperCase()}] ${attempt.error || "访问失败"}`)
    .join("\n")
    .slice(0, 1200);
  return {
    ok: false,
    url: safeGitRemoteUrl(candidates[0]),
    transport: gitRemoteTransport(candidates[0]),
    fallback: false,
    attempts,
    error,
  };
}

/**
 * 只读扫描指定远程分支里的固定文件。实现使用系统临时 bare 仓库和 blobless fetch，
 * 不 checkout、不修改用户工程，也不会把远程凭据写入返回结果。
 */
export async function readRemoteBranchFiles(remote, options = {}) {
  const patterns = Array.isArray(options.branchPatterns) ? options.branchPatterns : [];
  const filePaths = [...new Set((Array.isArray(options.filePaths) ? options.filePaths : [])
    .map((item) => String(item || "").replaceAll("\\", "/").replace(/^\/+/, "").trim())
    .filter((item) => item && !item.includes("..") && !item.startsWith("-") && !item.includes("\u0000")))];
  if (!patterns.length) return { ok: false, branches: [], attempts: [], error: "未配置分支扫描规则" };
  if (!filePaths.length) return { ok: false, branches: [], attempts: [], error: "未配置远程文件白名单" };

  const candidates = gitRemoteCandidates(remote);
  if (!candidates.length) return { ok: false, branches: [], attempts: [], error: "未配置远程地址" };
  const probe = typeof options.probe === "function" ? options.probe : gitLsRemoteHeads;
  const readCandidate = typeof options.readCandidate === "function"
    ? options.readCandidate
    : readCandidateBranchFiles;
  const attempts = [];

  for (const remoteUrl of candidates) {
    const transport = gitRemoteTransport(remoteUrl);
    const safeUrl = safeGitRemoteUrl(remoteUrl);
    const heads = await probe(remoteUrl, options.force === true, options);
    if (!heads?.ok) {
      attempts.push({
        url: safeUrl,
        transport,
        ok: false,
        stage: "ls-remote",
        error: safeGitRemoteError(heads?.error, remoteUrl),
      });
      continue;
    }
    const matchedBranches = filterRemoteBranches(heads.branches, patterns);
    if (!matchedBranches.length) {
      attempts.push({ url: safeUrl, transport, ok: true, stage: "scan", matchedBranches: 0 });
      return {
        ok: true,
        branches: [],
        matchedBranches: [],
        url: safeUrl,
        transport,
        fallback: attempts.length > 1,
        attempts,
      };
    }
    try {
      const branches = await readCandidate(remoteUrl, matchedBranches, filePaths, options);
      attempts.push({
        url: safeUrl,
        transport,
        ok: true,
        stage: "scan",
        matchedBranches: matchedBranches.length,
      });
      return {
        ok: true,
        branches,
        matchedBranches,
        url: safeUrl,
        transport,
        fallback: attempts.length > 1,
        attempts,
      };
    } catch (error) {
      attempts.push({
        url: safeUrl,
        transport,
        ok: false,
        stage: "fetch",
        error: safeGitRemoteError(error?.message, remoteUrl),
      });
    }
  }

  return {
    ok: false,
    branches: [],
    matchedBranches: [],
    url: safeGitRemoteUrl(candidates[0]),
    transport: gitRemoteTransport(candidates[0]),
    fallback: false,
    attempts,
    error: attempts
      .map((attempt) => `[${String(attempt.transport || "other").toUpperCase()} ${attempt.stage}] ${attempt.error || "访问失败"}`)
      .join("\n")
      .slice(0, 1600),
  };
}
