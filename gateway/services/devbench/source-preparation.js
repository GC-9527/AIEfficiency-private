/**
 * Story source preparation.
 *
 * A repository/branch target owns one stable cache directory:
 *   <cloneParent>/SourceCache/<repository>/<branch>-<targetHash>
 *
 * The service deliberately has no dependency on store/routes/clone.js. Git and
 * filesystem dependencies are injectable so callers can test the complete
 * policy without network access.
 */
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const SOURCE_CACHE_DIRECTORY = "SourceCache";
const GIT_ENV = Object.freeze({
  GIT_TERMINAL_PROMPT: "0",
  GIT_SSH_COMMAND: "ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new",
});
const DEFAULT_LOCK_WAIT_MS = 20 * 60 * 1000;
const DEFAULT_LOCK_STALE_MS = 2 * 60 * 1000;
const DEFAULT_LOCK_POLL_MS = 100;

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function defaultProcessAlive(pid) {
  const candidate = Number(pid);
  if (!Number.isInteger(candidate) || candidate <= 0) return false;
  if (candidate === process.pid) return true;
  try {
    process.kill(candidate, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function text(value) {
  return String(value ?? "").trim();
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function defaultTargetHash(value) {
  return createHash("sha256").update(String(value)).digest("hex").slice(0, 16);
}

export function safeSourcePathSegment(value, fallback = "source", maxLength = 72) {
  let result = text(value)
    .normalize("NFKC")
    .replace(/[\u0000-\u001f<>:"/\\|?*]+/g, "_")
    .replace(/\s+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^[. ]+|[. ]+$/g, "");
  if (!result || result === "." || result === "..") result = fallback;
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(result)) result = `_${result}`;
  return result.slice(0, Math.max(12, Number(maxLength) || 72));
}

function trimRepositoryPath(value) {
  return text(value)
    .replace(/\\/g, "/")
    .replace(/^\/+|\/+$/g, "")
    .replace(/\.git$/i, "");
}

function normalizedLocalRemote(value, pathApi) {
  const absolute = pathApi.resolve(value).replace(/\\/g, "/").replace(/\/+$/, "");
  return `local:${pathApi.sep === "\\" ? absolute.toLowerCase() : absolute}`;
}

/**
 * Normalize SSH, HTTPS and local Git URLs to a repository identity. Transport
 * and credentials are intentionally excluded, while host, port and repository
 * path remain part of the identity.
 */
export function canonicalGitRemote(value, { pathApi = path } = {}) {
  const raw = text(value);
  if (!raw) return "";

  const windowsAbsolute = /^[a-z]:[\\/]/i.test(raw);
  if (windowsAbsolute || pathApi.isAbsolute(raw)) return normalizedLocalRemote(raw, pathApi);

  if (/^[a-z][a-z\d+.-]*:\/\//i.test(raw)) {
    try {
      const parsed = new URL(raw);
      if (parsed.protocol === "file:") {
        let localPath = decodeURIComponent(parsed.pathname || "");
        if (/^\/[a-z]:\//i.test(localPath)) localPath = localPath.slice(1);
        return normalizedLocalRemote(localPath, pathApi);
      }
      const repositoryPath = trimRepositoryPath(decodeURIComponent(parsed.pathname || ""));
      if (!parsed.hostname || !repositoryPath) return "";
      const host = `${parsed.hostname.toLowerCase()}${parsed.port ? `:${parsed.port}` : ""}`;
      return `${host}/${repositoryPath}`;
    } catch {
      return "";
    }
  }

  const scp = raw.match(/^(?:[^@/:\s]+@)?([^:/\s]+):(.+)$/);
  if (scp) {
    const repositoryPath = trimRepositoryPath(scp[2]);
    return repositoryPath ? `${scp[1].toLowerCase()}/${repositoryPath}` : "";
  }

  const literal = trimRepositoryPath(raw);
  return literal ? `literal:${literal}` : "";
}

function repositoryRemoteValues(repository = {}, request = {}) {
  const nested = repository?.remote && typeof repository.remote === "object" ? repository.remote : {};
  return unique([
    text(request.cloneUrl),
    text(repository.cloneUrl),
    text(repository.https),
    text(repository.ssh),
    text(repository.url),
    text(repository.remoteUrl),
    text(repository.origin),
    typeof repository.remote === "string" ? text(repository.remote) : "",
    text(nested.ssh),
    text(nested.https),
    text(nested.url),
  ]);
}

function normalizedPathKey(value, pathApi) {
  const resolved = pathApi.resolve(value).replace(/[\\/]+$/g, "");
  return pathApi.sep === "\\" ? resolved.toLowerCase() : resolved;
}

export function buildSourcePreparationTarget({
  cloneParent,
  repositoryId,
  branch,
} = {}, {
  pathApi = path,
  hashTarget = defaultTargetHash,
} = {}) {
  const parent = text(cloneParent);
  const repo = text(repositoryId);
  const ref = text(branch);
  if (!parent || !pathApi.isAbsolute(parent)) {
    throw Object.assign(new Error("cloneParent must be an absolute path"), {
      code: "SOURCE_PREPARATION_CLONE_PARENT_INVALID",
    });
  }
  if (!repo) {
    throw Object.assign(new Error("repositoryId is required"), {
      code: "SOURCE_PREPARATION_REPOSITORY_REQUIRED",
    });
  }
  if (!ref) {
    throw Object.assign(new Error("branch is required"), {
      code: "SOURCE_PREPARATION_BRANCH_REQUIRED",
    });
  }

  const repositorySegment = safeSourcePathSegment(repo, "repository");
  const branchSegment = safeSourcePathSegment(ref, "branch");
  const rawTargetHash = text(hashTarget(`${repo.toLowerCase()}\u0000${ref}`));
  if (!/^[a-z\d_-]+$/i.test(rawTargetHash)) {
    throw Object.assign(new Error("target hash must be a non-empty path-safe token"), {
      code: "SOURCE_PREPARATION_TARGET_HASH_INVALID",
    });
  }
  const targetHash = rawTargetHash.slice(0, 32);
  const targetPath = pathApi.join(
    pathApi.resolve(parent),
    SOURCE_CACHE_DIRECTORY,
    repositorySegment,
    `${branchSegment}-${targetHash}`,
  );
  return {
    repositoryId: repo,
    branch: ref,
    targetHash,
    targetPath,
    targetKey: normalizedPathKey(targetPath, pathApi),
  };
}

export function sourcePreparationGitArgs(args = [], platform = process.platform) {
  const normalized = Array.isArray(args) ? [...args] : [];
  if (platform !== "win32" || normalized.includes("core.longpaths=true")) return normalized;
  // Git for Windows keeps the legacy MAX_PATH checkout behavior unless this
  // command-level override is present. Do not depend on each developer having
  // changed a global Git setting: SourceCache must be reproducible per process.
  return ["-c", "core.longpaths=true", ...normalized];
}

export function defaultGitExecutor(args, { cwd, env, onStderr } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn("git", sourcePreparationGitArgs(args), {
        cwd: cwd || undefined,
        windowsHide: true,
        env: { ...process.env, ...GIT_ENV, ...(env || {}) },
      });
    } catch (error) {
      resolve({ ok: false, error: error?.message || String(error) });
      return;
    }

    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    child.stdout?.on("data", (chunk) => {
      stdout = `${stdout}${chunk}`.slice(-65536);
    });
    child.stderr?.on("data", (chunk) => {
      try { onStderr?.(String(chunk)); } catch {}
      stderr = `${stderr}${chunk}`.slice(-65536);
    });
    child.on("error", (error) => finish({ ok: false, stdout, stderr, error: error?.message || String(error) }));
    child.on("close", (code) => finish({
      ok: code === 0,
      code,
      stdout,
      stderr,
      error: code === 0 ? "" : text(stderr || stdout || `git exited with code ${code}`),
    }));
  });
}

function commandOutput(result) {
  return text(result?.stdout).split(/\r?\n/, 1)[0];
}

function commandError(result) {
  return text(result?.error || result?.stderr || result?.stdout || "git command failed").slice(-800);
}

function redactedError(message, remotes) {
  let result = text(message);
  for (const remote of remotes) {
    if (remote) result = result.split(remote).join("<repository>");
  }
  return result || "git command failed";
}

function failure(code, error, context = {}) {
  return {
    ok: false,
    status: "rejected",
    code,
    error,
    ...context,
  };
}

function success(status, context = {}) {
  return {
    ok: true,
    status,
    reused: status === "reused",
    cloned: status === "cloned",
    ...context,
  };
}

function publicCheckout(checkout) {
  if (!checkout || typeof checkout !== "object") return checkout;
  const safe = { ...checkout };
  delete safe.originUrl;
  return safe;
}

function existingDirectory(fsApi, targetPath) {
  try {
    if (!fsApi.existsSync(targetPath)) return { exists: false, directory: false };
    return { exists: true, directory: fsApi.statSync(targetPath).isDirectory() };
  } catch (error) {
    return { exists: true, directory: false, error: error?.message || String(error) };
  }
}

function normalizeExecutionResult(result) {
  if (result && typeof result === "object") return { ...result, ok: result.ok === true };
  return { ok: result === true, stdout: "", stderr: "" };
}

function inputContext(input, pathApi, hashTarget) {
  const target = input?.target && typeof input.target === "object" ? input.target : input || {};
  const repository = input?.repository && typeof input.repository === "object"
    ? input.repository
    : (target.repository && typeof target.repository === "object" ? target.repository : {});
  const repositoryId = text(
    target.repositoryId || target.projectId || input?.repositoryId || input?.projectId || repository.id || repository.name,
  );
  const branch = text(target.branch || input?.branch);
  const cloneParent = text(input?.cloneParent || target.cloneParent);
  const descriptor = buildSourcePreparationTarget({ cloneParent, repositoryId, branch }, { pathApi, hashTarget });
  const remotes = repositoryRemoteValues(repository, input);
  const allowedRemoteIdentities = unique(remotes.map((remote) => canonicalGitRemote(remote, { pathApi })));
  if (!allowedRemoteIdentities.length) {
    throw Object.assign(new Error(`repository "${repositoryId}" has no configured remote`), {
      code: "SOURCE_PREPARATION_REMOTE_REQUIRED",
    });
  }
  const knownCheckouts = [
    ...(Array.isArray(input?.knownCheckouts) ? input.knownCheckouts : []),
    ...(Array.isArray(target.knownCheckouts) ? target.knownCheckouts : []),
  ];
  return {
    ...descriptor,
    repository,
    remotes,
    cloneUrl: remotes[0],
    allowedRemoteIdentities,
    knownCheckouts,
    onProgress: typeof input?.onProgress === "function" ? input.onProgress : null,
  };
}

function reportCloneProgress(chunk, callback) {
  if (typeof callback !== "function") return;
  for (const line of String(chunk || "").split(/[\r\n]+/)) {
    const match = line.match(
      /(Receiving objects|Resolving deltas|Counting objects|Compressing objects|Updating files):\s+(\d+)%/,
    );
    if (!match) continue;
    try { callback({ phase: match[1], percent: Number(match[2]) }); } catch {}
  }
}

export function createSourcePreparationService({
  fsApi = fs,
  pathApi = path,
  gitExecutor = defaultGitExecutor,
  hashTarget = defaultTargetHash,
  resolveCloneUrl = async ({ cloneUrl }) => ({ ok: true, url: cloneUrl }),
  lockWaitMs = DEFAULT_LOCK_WAIT_MS,
  lockStaleMs = DEFAULT_LOCK_STALE_MS,
  lockPollMs = DEFAULT_LOCK_POLL_MS,
  now = () => Date.now(),
  sleepFn = sleep,
  processAlive = defaultProcessAlive,
  ownerHost = process.env.COMPUTERNAME || process.env.HOSTNAME || "local",
} = {}) {
  const requiredFsMethods = [
    "existsSync",
    "statSync",
    "mkdirSync",
    "readFileSync",
    "writeFileSync",
    "readdirSync",
    "renameSync",
    "rmSync",
    "utimesSync",
  ];
  if (requiredFsMethods.some((method) => typeof fsApi?.[method] !== "function")) {
    throw new TypeError(`source preparation requires filesystem methods: ${requiredFsMethods.join(", ")}`);
  }
  if (typeof gitExecutor !== "function") throw new TypeError("gitExecutor must be a function");
  if (typeof resolveCloneUrl !== "function") throw new TypeError("resolveCloneUrl must be a function");
  if (typeof now !== "function" || typeof sleepFn !== "function" || typeof processAlive !== "function") {
    throw new TypeError("source preparation lock clock, sleep, and process liveness dependencies must be functions");
  }
  const effectiveLockWaitMs = Math.max(100, Number(lockWaitMs) || DEFAULT_LOCK_WAIT_MS);
  const effectiveLockStaleMs = Math.max(100, Number(lockStaleMs) || DEFAULT_LOCK_STALE_MS);
  const effectiveLockPollMs = Math.max(5, Number(lockPollMs) || DEFAULT_LOCK_POLL_MS);
  const normalizedOwnerHost = text(ownerHost).toLowerCase() || "local";
  const inFlight = new Map();

  function removeDirectory(directoryPath) {
    try {
      fsApi.rmSync(directoryPath, { recursive: true, force: true });
      return true;
    } catch {
      return false;
    }
  }

  function readLockOwner(lockPath) {
    try {
      return JSON.parse(fsApi.readFileSync(pathApi.join(lockPath, "owner.json"), "utf8"));
    } catch {
      return null;
    }
  }

  function lockIsStale(lockPath) {
    let lockStat;
    try { lockStat = fsApi.statSync(lockPath); } catch { return false; }
    const owner = readLockOwner(lockPath);
    const ownerIsLocal = text(owner?.host).toLowerCase() === normalizedOwnerHost;
    if (ownerIsLocal && processAlive(owner?.pid)) return false;
    return now() - Number(lockStat.mtimeMs || 0) >= effectiveLockStaleMs;
  }

  function removeStaleLock(lockPath) {
    if (!lockIsStale(lockPath)) return false;
    const tombstone = `${lockPath}.stale-${process.pid}-${randomUUID()}`;
    try {
      fsApi.renameSync(lockPath, tombstone);
    } catch {
      return false;
    }
    removeDirectory(tombstone);
    return true;
  }

  function releaseTargetLock(handle) {
    if (!handle) return;
    clearInterval(handle.heartbeat);
    const currentOwner = readLockOwner(handle.lockPath);
    if (currentOwner?.ownerId !== handle.ownerId) return;
    removeDirectory(handle.lockPath);
  }

  async function acquireTargetLock(context) {
    const lockPath = `${context.targetPath}.prepare.lock`;
    const deadline = now() + effectiveLockWaitMs;
    let waitingReported = false;
    fsApi.mkdirSync(pathApi.dirname(lockPath), { recursive: true });
    while (true) {
      const ownerId = `${process.pid}-${randomUUID()}`;
      try {
        fsApi.mkdirSync(lockPath);
        try {
          fsApi.writeFileSync(pathApi.join(lockPath, "owner.json"), JSON.stringify({
            ownerId,
            host: normalizedOwnerHost,
            pid: process.pid,
            targetKey: context.targetKey,
            startedAt: now(),
          }), { encoding: "utf8", flag: "wx" });
        } catch (error) {
          removeDirectory(lockPath);
          throw error;
        }
        const heartbeatMs = Math.max(50, Math.min(10_000, Math.floor(effectiveLockStaleMs / 3)));
        const heartbeat = setInterval(() => {
          try {
            if (readLockOwner(lockPath)?.ownerId !== ownerId) return;
            const timestamp = new Date(now());
            fsApi.utimesSync(lockPath, timestamp, timestamp);
          } catch {}
        }, heartbeatMs);
        heartbeat.unref?.();
        return { lockPath, ownerId, heartbeat };
      } catch (error) {
        if (error?.code !== "EEXIST") {
          throw Object.assign(new Error(`Unable to acquire source cache lock: ${error?.message || error}`), {
            code: "SOURCE_PREPARATION_LOCK_FAILED",
          });
        }
      }

      if (removeStaleLock(lockPath)) continue;
      if (!waitingReported) {
        waitingReported = true;
        try { context.onProgress?.({ phase: "等待其它 Gateway 初始化源码", percent: 0 }); } catch {}
      }
      if (now() >= deadline) {
        throw Object.assign(new Error("Timed out waiting for another Gateway to prepare the source cache"), {
          code: "SOURCE_PREPARATION_LOCK_TIMEOUT",
        });
      }
      await sleepFn(effectiveLockPollMs);
    }
  }

  function cleanupStaleTemporaryDirectories(context) {
    const parent = pathApi.dirname(context.targetPath);
    const prefix = `${pathApi.basename(context.targetPath)}.preparing-`;
    let entries = [];
    try { entries = fsApi.readdirSync(parent, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (!entry?.isDirectory?.() || !entry.name.startsWith(prefix)) continue;
      const candidate = pathApi.join(parent, entry.name);
      let candidateStat;
      try { candidateStat = fsApi.statSync(candidate); } catch { continue; }
      if (now() - Number(candidateStat.mtimeMs || 0) < effectiveLockStaleMs) continue;
      removeDirectory(candidate);
    }
  }

  async function git(args, options) {
    try {
      return normalizeExecutionResult(await gitExecutor(args, options));
    } catch (error) {
      return { ok: false, error: error?.message || String(error), stdout: "", stderr: "" };
    }
  }

  async function inspectCheckout(checkoutPath, context) {
    const resolvedPath = pathApi.resolve(text(checkoutPath));
    const state = existingDirectory(fsApi, resolvedPath);
    if (!state.exists) return { ok: false, missing: true, reason: "missing", path: resolvedPath };
    if (!state.directory) return {
      ok: false,
      reason: "not_directory",
      path: resolvedPath,
      error: state.error || "path is not a directory",
    };

    const top = await git(["-C", resolvedPath, "rev-parse", "--show-toplevel"]);
    if (!top.ok || !commandOutput(top)) return {
      ok: false,
      reason: "not_git",
      path: resolvedPath,
      error: commandError(top),
    };
    const topLevel = pathApi.resolve(commandOutput(top));
    if (normalizedPathKey(topLevel, pathApi) !== normalizedPathKey(resolvedPath, pathApi)) return {
      ok: false,
      reason: "not_repository_root",
      path: resolvedPath,
      topLevel,
      error: "checkout path is not the Git repository root",
    };

    const origin = await git(["-C", resolvedPath, "remote", "get-url", "origin"]);
    const originUrl = commandOutput(origin);
    const originIdentity = canonicalGitRemote(originUrl, { pathApi });
    if (!origin.ok || !originIdentity) return {
      ok: false,
      reason: "origin_missing",
      path: resolvedPath,
      error: commandError(origin),
    };
    if (!context.allowedRemoteIdentities.includes(originIdentity)) return {
      ok: false,
      reason: "origin_mismatch",
      path: resolvedPath,
      originIdentity,
      error: "checkout origin does not match the configured repository",
    };

    const currentBranch = await git(["-C", resolvedPath, "symbolic-ref", "--quiet", "--short", "HEAD"]);
    const branch = commandOutput(currentBranch);
    if (!currentBranch.ok || !branch) return {
      ok: false,
      reason: "detached_head",
      path: resolvedPath,
      error: commandError(currentBranch),
    };
    if (branch !== context.branch) return {
      ok: false,
      reason: "branch_mismatch",
      path: resolvedPath,
      actualBranch: branch,
      error: `checkout branch "${branch}" does not match "${context.branch}"`,
    };

    return {
      ok: true,
      path: resolvedPath,
      topLevel,
      originUrl,
      originIdentity,
      branch,
    };
  }

  function resultContext(context) {
    return {
      targetKey: context.targetKey,
      targetHash: context.targetHash,
      targetPath: context.targetPath,
      repositoryId: context.repositoryId,
      branch: context.branch,
    };
  }

  async function existingCacheResult(context, extra = {}) {
    if (!existingDirectory(fsApi, context.targetPath).exists) return null;
    const base = resultContext(context);
    const inspected = await inspectCheckout(context.targetPath, context);
    if (!inspected.ok) return failure(
      "SOURCE_PREPARATION_EXISTING_INVALID",
      `Existing source cache is invalid: ${inspected.error || inspected.reason}`,
      { ...base, path: context.targetPath, reason: inspected.reason, ...extra },
    );
    return success("reused", {
      ...base,
      path: context.targetPath,
      source: "cache",
      checkout: publicCheckout(inspected),
      ...extra,
    });
  }

  async function prepareOnce(context) {
    const base = resultContext(context);
    const existing = await existingCacheResult(context);
    if (existing) return existing;

    const targetLock = await acquireTargetLock(context);
    try {
      // Another Gateway may have published while this caller waited on the
      // filesystem lock. Always validate the winner before reusing it.
      const publishedWhileWaiting = await existingCacheResult(context, { contended: true });
      if (publishedWhileWaiting) return publishedWhileWaiting;
      cleanupStaleTemporaryDirectories(context);

      const candidateRejections = [];
      const seenCandidates = new Set([normalizedPathKey(context.targetPath, pathApi)]);
      let validCandidate = null;
      for (const candidate of context.knownCheckouts) {
        const rawPath = typeof candidate === "string"
          ? candidate
          : candidate?.path || candidate?.checkoutPath || candidate?.repositoryPath;
        if (!text(rawPath)) continue;
        const candidatePath = pathApi.resolve(text(rawPath));
        const candidateKey = normalizedPathKey(candidatePath, pathApi);
        if (seenCandidates.has(candidateKey)) continue;
        seenCandidates.add(candidateKey);
        const inspected = await inspectCheckout(candidatePath, context);
        if (inspected.ok) {
          validCandidate = inspected;
          break;
        }
        if (!inspected.missing) candidateRejections.push({
          path: candidatePath,
          reason: inspected.reason,
          error: inspected.error,
        });
      }

      let cloneUrl = validCandidate?.path || context.cloneUrl;
      const source = validCandidate ? "known-checkout" : "remote";
      let remoteResolution = null;
      if (!validCandidate) {
        try { context.onProgress?.({ phase: "验证仓库访问", percent: 0 }); } catch {}
        try {
          const resolved = await resolveCloneUrl({
            repositoryId: context.repositoryId,
            branch: context.branch,
            repository: context.repository,
            remotes: [...context.remotes],
            cloneUrl: context.cloneUrl,
          });
          remoteResolution = typeof resolved === "string" ? { ok: true, url: resolved } : resolved;
        } catch (error) {
          remoteResolution = { ok: false, error: error?.message || String(error) };
        }
        if (!remoteResolution?.ok || !text(remoteResolution.url)) return failure(
          "SOURCE_PREPARATION_REMOTE_UNAVAILABLE",
          redactedError(remoteResolution?.error || "configured repository is unavailable", context.remotes),
          { ...base, path: context.targetPath, candidateRejections },
        );
        cloneUrl = text(remoteResolution.url);
        const resolvedIdentity = canonicalGitRemote(cloneUrl, { pathApi });
        if (!context.allowedRemoteIdentities.includes(resolvedIdentity)) return failure(
          "SOURCE_PREPARATION_REMOTE_MISMATCH",
          "resolved clone URL does not match the configured repository",
          { ...base, path: context.targetPath, candidateRejections },
        );
      }

      // Git never writes the stable cache path directly. A process owns a
      // unique sibling directory, validates it, then atomically publishes it.
      // This prevents a killed clone from poisoning all later attempts.
      const temporaryPath = `${context.targetPath}.preparing-${process.pid}-${randomUUID()}`;
      let temporaryExists = false;
      try {
        const cloneResult = await git([
          "clone",
          "--progress",
          "--branch",
          context.branch,
          "--single-branch",
          "--",
          cloneUrl,
          temporaryPath,
        ], {
          env: GIT_ENV,
          onStderr: (chunk) => reportCloneProgress(chunk, context.onProgress),
        });
        temporaryExists = existingDirectory(fsApi, temporaryPath).exists;
        if (!cloneResult.ok) return failure(
          "SOURCE_PREPARATION_CLONE_FAILED",
          redactedError(commandError(cloneResult), context.remotes),
          { ...base, path: context.targetPath, candidateRejections },
        );

        // A clone from a known checkout gets a local-path origin. Restore a
        // configured repository URL before validation so every cache has the
        // same durable remote identity and can fetch normally later.
        if (validCandidate) {
          const setOrigin = await git([
            "-C",
            temporaryPath,
            "remote",
            "set-url",
            "origin",
            validCandidate.originUrl || context.cloneUrl,
          ]);
          if (!setOrigin.ok) return failure(
            "SOURCE_PREPARATION_ORIGIN_UPDATE_FAILED",
            redactedError(commandError(setOrigin), context.remotes),
            { ...base, path: context.targetPath, candidatePath: validCandidate.path, candidateRejections },
          );
        }

        const inspected = await inspectCheckout(temporaryPath, context);
        if (!inspected.ok) return failure(
          "SOURCE_PREPARATION_CLONE_INVALID",
          `Cloned checkout failed validation: ${inspected.error || inspected.reason}`,
          { ...base, path: context.targetPath, reason: inspected.reason, candidateRejections },
        );

        // The lock is the normal cross-Gateway serialization boundary. This
        // second check plus publish conflict handling also protects against a
        // conservative stale-lock takeover race.
        const publishedBeforeRename = await existingCacheResult(context, {
          contended: true,
          candidateRejections,
        });
        if (publishedBeforeRename) return publishedBeforeRename;
        try {
          fsApi.renameSync(temporaryPath, context.targetPath);
          temporaryExists = false;
        } catch (error) {
          const winner = await existingCacheResult(context, {
            contended: true,
            candidateRejections,
          });
          if (winner?.ok) return winner;
          return failure(
            "SOURCE_PREPARATION_PUBLISH_FAILED",
            `Unable to publish validated source cache: ${error?.message || error}`,
            { ...base, path: context.targetPath, candidateRejections },
          );
        }

        return success("cloned", {
          ...base,
          path: context.targetPath,
          source,
          checkout: publicCheckout({
            ...inspected,
            path: context.targetPath,
            topLevel: context.targetPath,
          }),
          candidatePath: validCandidate?.path || null,
          transport: remoteResolution?.transport || null,
          candidateRejections,
        });
      } finally {
        if (temporaryExists || existingDirectory(fsApi, temporaryPath).exists) {
          removeDirectory(temporaryPath);
        }
      }
    } finally {
      releaseTargetLock(targetLock);
    }
  }

  function prepare(input = {}) {
    let context;
    try {
      context = inputContext(input, pathApi, hashTarget);
    } catch (error) {
      return Promise.resolve(failure(
        error?.code || "SOURCE_PREPARATION_REQUEST_INVALID",
        error?.message || String(error),
      ));
    }

    const running = inFlight.get(context.targetKey);
    if (running) {
      if (context.onProgress) running.progressListeners.add(context.onProgress);
      return running.promise;
    }

    const progressListeners = new Set(context.onProgress ? [context.onProgress] : []);
    const operationContext = {
      ...context,
      onProgress: (progress) => {
        for (const listener of progressListeners) {
          try { listener(progress); } catch {}
        }
      },
    };
    const entry = { promise: null, progressListeners };
    const promise = Promise.resolve()
      .then(() => prepareOnce(operationContext))
      .catch((error) => failure(
        error?.code || "SOURCE_PREPARATION_FAILED",
        error?.message || String(error),
        resultContext(context),
      ))
      .finally(() => {
        if (inFlight.get(context.targetKey) === entry) inFlight.delete(context.targetKey);
      });
    entry.promise = promise;
    inFlight.set(context.targetKey, entry);
    return promise;
  }

  function describe(input = {}) {
    try {
      const context = inputContext(input, pathApi, hashTarget);
      return { ok: true, ...resultContext(context) };
    } catch (error) {
      return failure(error?.code || "SOURCE_PREPARATION_REQUEST_INVALID", error?.message || String(error));
    }
  }

  return Object.freeze({
    prepare,
    prepareMany: (requests = []) => Promise.all((Array.isArray(requests) ? requests : []).map(prepare)),
    describe,
    inspectCheckout: async (checkoutPath, input = {}) => {
      try {
        return await inspectCheckout(checkoutPath, inputContext(input, pathApi, hashTarget));
      } catch (error) {
        return failure(error?.code || "SOURCE_PREPARATION_REQUEST_INVALID", error?.message || String(error));
      }
    },
    inFlightCount: () => inFlight.size,
  });
}

const defaultSourcePreparationService = createSourcePreparationService();

export function prepareSource(input) {
  return defaultSourcePreparationService.prepare(input);
}

export const prepareSourceTarget = prepareSource;
