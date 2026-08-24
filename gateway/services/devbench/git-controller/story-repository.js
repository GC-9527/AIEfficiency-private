import fs from "fs";
import path from "path";
import os from "os";
import { createHash, randomUUID } from "crypto";
import { execFile } from "child_process";
import {
  gitLongPathsConfigArgs,
  resolveExecutable,
  sanitizedGitEnv,
} from "./path-security.js";
import { controllerAcceptedRef } from "./internal-refs.js";

let lazyDevelopmentGitBinary = null;
const DEFAULT_DISABLED_HOOKS_PATH = path.join(
  os.tmpdir(),
  `devbench-story-hooks-disabled-${process.pid}`,
);
fs.mkdirSync(DEFAULT_DISABLED_HOOKS_PATH, { recursive: true, mode: 0o700 });

export const INDEPENDENT_REPOSITORY_MODE = "INDEPENDENT_REPOSITORY";
export const LEGACY_LINKED_WORKTREE_MODE = "LEGACY_LINKED_WORKTREE";

function storyRepositoryError(message, code, details = {}) {
  return Object.assign(new Error(message), { code, ...details });
}

function normalizedPath(value) {
  const normalized = path.resolve(String(value || ""))
    .replace(/[\\/]+/g, "/")
    .replace(/\/+$/, "");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function portableSegment(value, fallback) {
  const raw = String(value || "").trim();
  if (!raw) {
    throw storyRepositoryError(
      `缺少${fallback === "story" ? "故事点" : "仓库"}标识`,
      fallback === "story" ? "STORY_REPOSITORY_STORY_ID_REQUIRED" : "STORY_REPOSITORY_ID_REQUIRED",
    );
  }
  const clean = raw
    .normalize("NFKC")
    .replace(/[^A-Za-z0-9._-]+/g, "_")
    .replace(/^[.\s]+|[.\s]+$/g, "")
    .slice(0, 48) || fallback;
  const fingerprint = createHash("sha256").update(raw).digest("hex").slice(0, 10);
  return `${clean}_${fingerprint}`;
}

function sanitizedGitEnvironment() {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    const upper = key.toUpperCase();
    if (
      upper === "GIT_DIR"
      || upper === "GIT_WORK_TREE"
      || upper === "GIT_COMMON_DIR"
      || upper === "GIT_INDEX_FILE"
      || upper === "GIT_OBJECT_DIRECTORY"
      || upper === "GIT_ALTERNATE_OBJECT_DIRECTORIES"
      || upper === "GIT_CONFIG_PARAMETERS"
      || upper === "GIT_CONFIG_COUNT"
      || upper === "GIT_EXEC_PATH"
      || upper === "GIT_TEMPLATE_DIR"
      || /^GIT_CONFIG_(?:KEY|VALUE)_\d+$/.test(upper)
    ) {
      delete env[key];
    }
  }
  env.GIT_TERMINAL_PROMPT = "0";
  // Controller 创建仓库时不继承用户或机器 Git 配置，避免 URL rewrite、模板 hooks、
  // checkout filter 和 core.autocrlf 等机器状态改变创建结果。
  env.GIT_CONFIG_GLOBAL = process.platform === "win32" ? "NUL" : "/dev/null";
  env.GIT_CONFIG_NOSYSTEM = "1";
  env.GIT_ATTR_NOSYSTEM = "1";
  return env;
}

function storyGitExecutionArgs(args, hooksPath, platform = process.platform) {
  return [
    "--no-optional-locks",
    ...gitLongPathsConfigArgs(platform),
    "-c", "gc.auto=0",
    "-c", "gc.autoDetach=false",
    "-c", "maintenance.auto=false",
    "-c", "maintenance.autoDetach=false",
    "-c", "core.fsmonitor=false",
    "-c", "core.untrackedCache=false",
    "-c", `core.hooksPath=${hooksPath.replace(/\\/g, "/")}`,
    "-c", "diff.external=",
    "-c", `core.attributesFile=${platform === "win32" ? "NUL" : "/dev/null"}`,
    "-c", "credential.helper=",
    "-c", "credential.interactive=never",
    ...args,
  ];
}

function invokeStoryGitSpawnGuard(beforeGitSpawn) {
  if (beforeGitSpawn == null) return;
  if (typeof beforeGitSpawn !== "function") {
    throw storyRepositoryError(
      "Story repository Git spawn guard must be a synchronous Controller-owned function",
      "GIT_CONTROLLER_GIT_SPAWN_GUARD_INVALID",
    );
  }
  const result = beforeGitSpawn();
  if (result && typeof result.then === "function") {
    throw storyRepositoryError(
      "Story repository Git spawn guard must complete synchronously before process creation",
      "GIT_CONTROLLER_GIT_SPAWN_GUARD_ASYNC",
    );
  }
}

function execFileWithChildLifecycle(
  executable,
  args,
  options,
  childLifecycle = null,
  beforeGitSpawn = null,
) {
  if (
    childLifecycle
    && (
      typeof childLifecycle.beforeSpawn !== "function"
      || typeof childLifecycle.afterSpawn !== "function"
      || typeof childLifecycle.afterClose !== "function"
      || typeof childLifecycle.spawnFailed !== "function"
    )
  ) {
    return Promise.reject(storyRepositoryError(
      "Story repository Git child lifecycle guard is incomplete",
      "STORY_REPOSITORY_GIT_CHILD_LIFECYCLE_INVALID",
    ));
  }
  return new Promise((resolve, reject) => {
    let ticket = null;
    let child = null;
    let registrationError = null;
    try {
      ticket = childLifecycle?.beforeSpawn() ?? null;
      if (childLifecycle && ticket == null) {
        throw storyRepositoryError(
          "Story repository Git child lifecycle guard did not issue a spawn ticket",
          "STORY_REPOSITORY_GIT_CHILD_TICKET_INVALID",
        );
      }
    } catch (error) {
      reject(error);
      return;
    }
    const complete = (error, stdout, stderr) => {
      let lifecycleError = null;
      if (childLifecycle && ticket != null) {
        try {
          childLifecycle.afterClose(ticket, {
            pid: child?.pid,
            error: error || null,
          });
        } catch (closeError) {
          lifecycleError = closeError;
        }
      }
      if (registrationError || lifecycleError) {
        reject(registrationError || lifecycleError);
        return;
      }
      if (error) {
        error.stdout ??= stdout;
        error.stderr ??= stderr;
        reject(error);
        return;
      }
      resolve({ stdout, stderr });
    };
    try {
      invokeStoryGitSpawnGuard(beforeGitSpawn);
      child = execFile(executable, args, options, complete);
    } catch (error) {
      try {
        if (childLifecycle && ticket != null) childLifecycle.spawnFailed(ticket, error);
      } catch (guardError) {
        reject(guardError);
        return;
      }
      reject(error);
      return;
    }
    if (childLifecycle && ticket != null) {
      try {
        childLifecycle.afterSpawn(ticket, { pid: child.pid });
      } catch (error) {
        registrationError = error;
        try {
          child.kill();
        } catch {}
      }
    }
  });
}

async function runGit(args, {
  gitBinary = null,
  disabledHooksPath = DEFAULT_DISABLED_HOOKS_PATH,
  cwd,
  timeout = 120_000,
  signal = null,
  code = "STORY_REPOSITORY_GIT_FAILED",
  childLifecycle = null,
  beforeGitSpawn = null,
} = {}) {
  let configuredGitBinary = String(gitBinary || "").trim();
  if (!configuredGitBinary && process.env.NODE_ENV !== "production") {
    lazyDevelopmentGitBinary ||= resolveExecutable("git");
    configuredGitBinary = lazyDevelopmentGitBinary;
  }
  const executable = path.resolve(configuredGitBinary);
  if (!path.isAbsolute(configuredGitBinary) || !fs.statSync(executable).isFile()) {
    throw storyRepositoryError(
      "Story repository Git binary must be an existing verified absolute file",
      "STORY_REPOSITORY_GIT_BINARY_INVALID",
    );
  }
  const hooksPath = path.resolve(String(disabledHooksPath || ""));
  if (!path.isAbsolute(String(disabledHooksPath || "")) || !fs.statSync(hooksPath).isDirectory()) {
    throw storyRepositoryError(
      "Story repository disabled hooks path must be an existing absolute directory",
      "STORY_REPOSITORY_HOOKS_PATH_INVALID",
    );
  }
  try {
    const result = await execFileWithChildLifecycle(
      executable,
      storyGitExecutionArgs(args, hooksPath),
      {
        cwd,
        timeout,
        windowsHide: true,
        encoding: "utf8",
        maxBuffer: 4 * 1024 * 1024,
        env: sanitizedGitEnv({
          GIT_ALLOW_PROTOCOL: "file",
          GIT_PROTOCOL_FROM_USER: "0",
        }),
        ...(signal ? { signal } : {}),
      },
      childLifecycle,
      beforeGitSpawn,
    );
    return {
      stdout: String(result.stdout || "").trim(),
      stderr: String(result.stderr || "").trim(),
    };
  } catch (error) {
    if (
      String(error?.code || "").startsWith("GIT_CONTROLLER_")
      || String(error?.code || "").startsWith("STORY_REPOSITORY_GIT_CHILD_")
    ) {
      throw error;
    }
    const stderr = String(error?.stderr || error?.stdout || error?.message || "").trim();
    throw storyRepositoryError(
      stderr || `Git 命令执行失败：git ${args.join(" ")}`,
      signal?.aborted ? "WORKTREE_MUTATION_LEASE_LOST" : code,
      { cause: error },
    );
  }
}

function descriptorSource(input = {}) {
  const nested = input?.accepted && typeof input.accepted === "object" && !Array.isArray(input.accepted)
    ? input.accepted
    : {};
  return { ...input, ...nested };
}

export function hasAcceptedDescriptorIntent(input = {}) {
  const descriptor = descriptorSource(input);
  return !!(
    input?.accepted
    || descriptor.mirrorPath
    || descriptor.candidateSha
    || descriptor.acceptedRef
    || descriptor.retentionRef
    || descriptor.mirrorGeneration !== undefined
    || descriptor.createdFromMirrorGeneration !== undefined
  );
}

export function normalizeAcceptedDescriptor(input = {}) {
  const descriptor = descriptorSource(input);
  const repositoryId = String(descriptor.repositoryId || input.repositoryId || "").trim();
  const mirrorPath = String(descriptor.mirrorPath || "").trim();
  const candidateSha = String(descriptor.candidateSha || descriptor.baseRevision || "").trim().toLowerCase();
  const acceptedTipSha = String(
    descriptor.acceptedTipSha
      || descriptor.acceptedTipRevision
      || descriptor.acceptedRevision
      || candidateSha,
  ).trim().toLowerCase();
  const sourceRef = String(descriptor.sourceRef || "").trim();
  const remoteId = String(descriptor.remoteId || "origin").trim();
  const declaredAcceptedRef = String(descriptor.acceptedRef || "").trim();
  const retentionRef = String(descriptor.retentionRef || "").trim();
  const retainedStoryId = String(descriptor.retainedStoryId || "").trim();
  const rawGeneration = (
    descriptor.mirrorGeneration
    ?? descriptor.createdFromMirrorGeneration
    ?? descriptor.generation
  );
  const mirrorGeneration = typeof rawGeneration === "string" && rawGeneration.trim()
    ? Number(rawGeneration)
    : rawGeneration;

  if (!repositoryId) {
    throw storyRepositoryError("accepted descriptor 缺少 repositoryId", "STORY_REPOSITORY_ID_REQUIRED");
  }
  if (!mirrorPath) {
    throw storyRepositoryError(
      `仓库 ${repositoryId} 的 accepted descriptor 缺少 mirrorPath`,
      "STORY_REPOSITORY_MIRROR_REQUIRED",
    );
  }
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(candidateSha)) {
    throw storyRepositoryError(
      `仓库 ${repositoryId} 必须提供完整的 40/64 位 accepted commit SHA`,
      "STORY_REPOSITORY_EXACT_SHA_REQUIRED",
    );
  }
  if (
    !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(acceptedTipSha)
    || acceptedTipSha.length !== candidateSha.length
  ) {
    throw storyRepositoryError(
      `仓库 ${repositoryId} 必须提供与基线对象格式一致的 accepted tip exact SHA`,
      "STORY_REPOSITORY_ACCEPTED_TIP_SHA_INVALID",
    );
  }
  const sourceBranch = sourceRef.replace(/^refs\/heads\//, "");
  const sourceRefInvalid = (
    !sourceRef.startsWith("refs/heads/")
    || !sourceBranch
    || !/^[A-Za-z0-9._/-]+$/.test(sourceBranch)
    || sourceBranch.startsWith(".")
    || sourceBranch.startsWith("/")
    || sourceBranch.endsWith(".")
    || sourceBranch.endsWith("/")
    || sourceBranch.includes("..")
    || sourceBranch.includes("//")
    || sourceBranch.includes("@{")
    || sourceBranch.split("/").some((segment) => segment.endsWith(".lock"))
  );
  if (sourceRefInvalid) {
    throw storyRepositoryError(
      `仓库 ${repositoryId} 的 sourceRef 必须是完整 refs/heads/*`,
      "STORY_REPOSITORY_SOURCE_REF_INVALID",
    );
  }
  if (
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(remoteId)
    || remoteId.includes("..")
    || remoteId.endsWith(".lock")
  ) {
    throw storyRepositoryError(
      `仓库 ${repositoryId} 的 remoteId 无效`,
      "STORY_REPOSITORY_REMOTE_ID_INVALID",
    );
  }
  const acceptedRef = controllerAcceptedRef(remoteId, sourceBranch);
  if (declaredAcceptedRef && declaredAcceptedRef !== acceptedRef) {
    throw storyRepositoryError(
      "accepted descriptor ref is not bound to its exact remoteId and sourceRef",
      "STORY_REPOSITORY_ACCEPTED_REF_INVALID",
    );
  }
  if (!Number.isSafeInteger(mirrorGeneration) || mirrorGeneration < 0) {
    throw storyRepositoryError(
      `仓库 ${repositoryId} 的 mirrorGeneration 无效`,
      "STORY_REPOSITORY_MIRROR_GENERATION_INVALID",
    );
  }
  if (
    retentionRef
    && (
      !/^refs\/devbench\/story-base\/b-[A-Za-z0-9_-]{20}\/s-[A-Za-z0-9_-]{16}$/
        .test(retentionRef)
      || !retainedStoryId
    )
  ) {
    throw storyRepositoryError(
      "retained story descriptor has an invalid exact-SHA retention binding",
      "STORY_REPOSITORY_RETENTION_REF_INVALID",
    );
  }

  return {
    repositoryId,
    mirrorPath: path.resolve(mirrorPath),
    candidateSha,
    baseRevision: candidateSha,
    acceptedTipSha,
    sourceRef,
    remoteId,
    acceptedRef,
    mirrorGeneration,
    retentionRef: retentionRef || null,
    retainedStoryId: retentionRef ? retainedStoryId : null,
  };
}

export function independentStoryRepositoryPath(root, storyId, repositoryId) {
  const resolvedRoot = path.resolve(String(root || ""));
  if (!root) {
    throw storyRepositoryError("缺少独立故事仓根目录", "STORY_REPOSITORY_ROOT_REQUIRED");
  }
  return path.join(
    resolvedRoot,
    portableSegment(storyId, "story"),
    portableSegment(repositoryId, "repository"),
  );
}

function alternatesFile(repositoryPath) {
  return path.join(repositoryPath, ".git", "objects", "info", "alternates");
}

function assertNoAlternates(repositoryPath) {
  for (const file of [
    alternatesFile(repositoryPath),
    path.join(repositoryPath, ".git", "objects", "info", "http-alternates"),
  ]) {
    if (!fs.existsSync(file)) continue;
    const content = fs.readFileSync(file, "utf8").trim();
    if (content) {
      throw storyRepositoryError(
        `独立故事仓仍依赖外部对象库：${repositoryPath}`,
        "STORY_REPOSITORY_ALTERNATES_PRESENT",
      );
    }
  }
}

function createStoryGitRunner(options = {}) {
  const gitChildGuard = typeof options.gitChildGuard === "function"
    ? options.gitChildGuard
    : null;
  const gitSpawnGuard = options.gitSpawnGuard == null
    ? null
    : options.gitSpawnGuard;
  if (gitSpawnGuard != null && typeof gitSpawnGuard !== "function") {
    throw storyRepositoryError(
      "Story repository Git spawn guard must be a synchronous Controller-owned function",
      "GIT_CONTROLLER_GIT_SPAWN_GUARD_INVALID",
    );
  }
  return (args, runOptions = {}) => {
    const mutation = runOptions.mutation === true;
    const commandId = String(runOptions.commandId || runOptions.code || "").trim();
    const childLifecycle = mutation && gitChildGuard
      ? gitChildGuard(commandId)
      : null;
    return runGit(args, {
      ...options,
      ...runOptions,
      childLifecycle,
      beforeGitSpawn: gitSpawnGuard,
    });
  };
}

async function readLocalConfig(run, repositoryPath, key, { required = true } = {}) {
  try {
    const result = await run(["-C", repositoryPath, "config", "--local", "--get", key], {
      code: "STORY_REPOSITORY_METADATA_INVALID",
    });
    return result.stdout;
  } catch (error) {
    if (!required && error?.cause?.code === 1) return "";
    throw error;
  }
}

async function writePortableMetadata(run, repositoryPath, {
  storyId,
  repositoryId,
  baseRevision,
  acceptedTipSha = baseRevision,
  sourceRef,
  remoteId,
  mirrorGeneration,
}) {
  const metadata = [
    ["devbench.repository-mode", INDEPENDENT_REPOSITORY_MODE],
    ["devbench.story-id", storyId],
    ["devbench.repository-id", repositoryId],
    ["devbench.created-base-revision", baseRevision],
    ["devbench.base-revision", baseRevision],
    ["devbench.accepted-tip-revision", acceptedTipSha],
    ["devbench.source-ref", sourceRef],
    ["devbench.remote-id", remoteId],
    ["devbench.mirror-generation", String(mirrorGeneration)],
  ];
  for (const [key, value] of metadata) {
    await run(["-C", repositoryPath, "config", "--local", key, String(value)], {
      code: "STORY_REPOSITORY_METADATA_WRITE_FAILED",
      mutation: true,
      commandId: "story.metadata-config",
    });
  }
  await run(
    ["-C", repositoryPath, "update-ref", "refs/devbench/story-base", baseRevision],
    {
      code: "STORY_REPOSITORY_BASE_REF_WRITE_FAILED",
      mutation: true,
      commandId: "story.metadata-base-ref",
    },
  );
}

export async function inspectIndependentStoryRepository(repositoryPath, {
  storyId,
  repositoryId,
  gitBinary = null,
  disabledHooksPath = DEFAULT_DISABLED_HOOKS_PATH,
  gitSpawnGuard = null,
} = {}) {
  const run = createStoryGitRunner({
    gitBinary,
    disabledHooksPath,
    gitSpawnGuard,
  });
  if (!fs.existsSync(repositoryPath)) return null;
  if (!fs.statSync(repositoryPath).isDirectory()) {
    throw storyRepositoryError(
      `故事仓目标不是目录：${repositoryPath}`,
      "STORY_REPOSITORY_TARGET_CONFLICT",
    );
  }
  const dotGit = path.join(repositoryPath, ".git");
  const dotGitStat = fs.existsSync(dotGit) ? fs.lstatSync(dotGit) : null;
  const objectsPath = path.join(dotGit, "objects");
  const objectsStat = fs.existsSync(objectsPath) ? fs.lstatSync(objectsPath) : null;
  if (
    !dotGitStat?.isDirectory()
    || dotGitStat.isSymbolicLink()
    || !objectsStat?.isDirectory()
    || objectsStat.isSymbolicLink()
  ) {
    throw storyRepositoryError(
      `故事仓目标已存在但没有独立 .git：${repositoryPath}`,
      "STORY_REPOSITORY_TARGET_CONFLICT",
    );
  }

  const mode = await readLocalConfig(run, repositoryPath, "devbench.repository-mode");
  const storedStoryId = await readLocalConfig(run, repositoryPath, "devbench.story-id");
  const storedRepositoryId = await readLocalConfig(run, repositoryPath, "devbench.repository-id");
  const createdBaseRevision = await readLocalConfig(run, repositoryPath, "devbench.created-base-revision");
  const baseRevision = await readLocalConfig(run, repositoryPath, "devbench.base-revision");
  const acceptedTipRevision = (
    await readLocalConfig(run, repositoryPath, "devbench.accepted-tip-revision", { required: false })
    || baseRevision
  ).toLowerCase();
  const sourceRef = await readLocalConfig(run, repositoryPath, "devbench.source-ref");
  const remoteId = await readLocalConfig(run, repositoryPath, "devbench.remote-id");
  const mirrorGenerationRaw = await readLocalConfig(run, repositoryPath, "devbench.mirror-generation");
  const mirrorGeneration = Number(mirrorGenerationRaw);
  if (
    mode !== INDEPENDENT_REPOSITORY_MODE
    || storedStoryId !== String(storyId)
    || storedRepositoryId !== String(repositoryId)
  ) {
    throw storyRepositoryError(
      `故事仓目标已被其它对象占用：${repositoryPath}`,
      "STORY_REPOSITORY_TARGET_CONFLICT",
    );
  }
  if (
    !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(createdBaseRevision)
    || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(baseRevision)
    || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(acceptedTipRevision)
    || acceptedTipRevision.length !== baseRevision.length
  ) {
    throw storyRepositoryError(
      `故事仓的固定基线元数据无效：${repositoryPath}`,
      "STORY_REPOSITORY_METADATA_INVALID",
    );
  }
  if (
    !Number.isSafeInteger(mirrorGeneration)
    || mirrorGeneration < 0
    || !sourceRef.startsWith("refs/heads/")
    || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(remoteId)
  ) {
    throw storyRepositoryError(
      `故事仓的 Controller 来源元数据无效：${repositoryPath}`,
      "STORY_REPOSITORY_METADATA_INVALID",
    );
  }

  const top = await run(["-C", repositoryPath, "rev-parse", "--show-toplevel"], {
    code: "STORY_REPOSITORY_VERIFY_FAILED",
  });
  const common = await run(["-C", repositoryPath, "rev-parse", "--git-common-dir"], {
    code: "STORY_REPOSITORY_VERIFY_FAILED",
  });
  const head = await run(["-C", repositoryPath, "rev-parse", "--verify", "HEAD^{commit}"], {
    code: "STORY_REPOSITORY_VERIFY_FAILED",
  });
  const branch = await run(["-C", repositoryPath, "branch", "--show-current"], {
    code: "STORY_REPOSITORY_VERIFY_FAILED",
  });
  const resolvedCommon = path.resolve(repositoryPath, common.stdout);
  if (
    normalizedPath(top.stdout) !== normalizedPath(repositoryPath)
    || normalizedPath(resolvedCommon) !== normalizedPath(dotGit)
  ) {
    throw storyRepositoryError(
      `故事仓没有独立 Git common-dir：${repositoryPath}`,
      "STORY_REPOSITORY_COMMON_DIR_SHARED",
    );
  }
  assertNoAlternates(repositoryPath);
  await run(["-C", repositoryPath, "cat-file", "-e", `${baseRevision}^{commit}`], {
    code: "STORY_REPOSITORY_BASE_OBJECT_MISSING",
  });
  const storyBase = await run(
    ["-C", repositoryPath, "rev-parse", "--verify", "refs/devbench/story-base^{commit}"],
    { code: "STORY_REPOSITORY_BASE_REF_INVALID" },
  );
  if (storyBase.stdout.toLowerCase() !== baseRevision.toLowerCase()) {
    throw storyRepositoryError(
      "故事仓固定基线 ref 与持久化 baseRevision 不一致",
      "STORY_REPOSITORY_BASE_REF_INVALID",
    );
  }
  await run(
    ["-C", repositoryPath, "fsck", "--connectivity-only", "HEAD", "refs/devbench/story-base"],
    { timeout: 180_000, code: "STORY_REPOSITORY_CONNECTIVITY_FAILED" },
  );

  return {
    version: 3,
    repositoryMode: INDEPENDENT_REPOSITORY_MODE,
    storyId: storedStoryId,
    repositoryId: storedRepositoryId,
    path: repositoryPath,
    repositoryPath,
    worktreePath: repositoryPath,
    gitCommonDir: resolvedCommon,
    branch: branch.stdout,
    revision: head.stdout.toLowerCase(),
    headRevision: head.stdout.toLowerCase(),
    createdBaseRevision: createdBaseRevision.toLowerCase(),
    baseRevision: baseRevision.toLowerCase(),
    acceptedTipRevision,
    sourceRef,
    remoteId,
    mirrorGeneration,
    createdFromMirrorGeneration: mirrorGeneration,
    detached: !branch.stdout,
  };
}

async function validateMirrorCandidate(descriptor, signal, run) {
  if (!fs.existsSync(descriptor.mirrorPath) || !fs.statSync(descriptor.mirrorPath).isDirectory()) {
    throw storyRepositoryError(
      `受管 mirror 不存在：${descriptor.mirrorPath}`,
      "STORY_REPOSITORY_MIRROR_MISSING",
    );
  }
  const bare = await run(
    ["--git-dir", descriptor.mirrorPath, "rev-parse", "--is-bare-repository"],
    { signal, code: "STORY_REPOSITORY_MIRROR_INVALID" },
  );
  if (bare.stdout !== "true") {
    throw storyRepositoryError(
      `受管 mirror 不是 bare repository：${descriptor.mirrorPath}`,
      "STORY_REPOSITORY_MIRROR_INVALID",
    );
  }
  const objectFormatResult = await run(
    ["--git-dir", descriptor.mirrorPath, "rev-parse", "--show-object-format"],
    { signal, code: "STORY_REPOSITORY_MIRROR_INVALID" },
  );
  const objectFormat = objectFormatResult.stdout || (descriptor.candidateSha.length === 64 ? "sha256" : "sha1");
  const expectedLength = objectFormat === "sha256" ? 64 : 40;
  if (
    descriptor.candidateSha.length !== expectedLength
    || descriptor.acceptedTipSha.length !== expectedLength
  ) {
    throw storyRepositoryError(
      `accepted SHA 与 mirror 对象格式 ${objectFormat} 不匹配`,
      "STORY_REPOSITORY_OBJECT_FORMAT_MISMATCH",
    );
  }
  const resolved = await run(
    ["--git-dir", descriptor.mirrorPath, "rev-parse", "--verify", `${descriptor.candidateSha}^{commit}`],
    { signal, code: "STORY_REPOSITORY_ACCEPTED_OBJECT_MISSING" },
  );
  if (resolved.stdout.toLowerCase() !== descriptor.candidateSha) {
    throw storyRepositoryError(
      "mirror 中的 accepted commit 未精确解析到请求 SHA",
      "STORY_REPOSITORY_ACCEPTED_OBJECT_MISMATCH",
    );
  }
  const acceptedRef = descriptor.acceptedRef;
  const accepted = await run(
    ["--git-dir", descriptor.mirrorPath, "rev-parse", "--verify", `${acceptedRef}^{commit}`],
    { signal, code: "STORY_REPOSITORY_ACCEPTED_REF_MISSING" },
  );
  if (accepted.stdout.toLowerCase() !== descriptor.acceptedTipSha) {
    throw storyRepositoryError(
      `Controller accepted ref ${acceptedRef} 与请求 SHA 不一致`,
      "STORY_REPOSITORY_ACCEPTED_REF_MISMATCH",
    );
  }
  if (descriptor.retentionRef) {
    const retained = await run(
      [
        "--git-dir",
        descriptor.mirrorPath,
        "rev-parse",
        "--verify",
        `${descriptor.retentionRef}^{commit}`,
      ],
      { signal, code: "STORY_REPOSITORY_RETENTION_REF_MISSING" },
    );
    if (retained.stdout.toLowerCase() !== descriptor.candidateSha) {
      throw storyRepositoryError(
        "Controller story retention ref does not resolve to the requested exact SHA",
        "STORY_REPOSITORY_RETENTION_REF_MISMATCH",
      );
    }
  } else try {
    await run(
      [
        "--git-dir",
        descriptor.mirrorPath,
        "merge-base",
        "--is-ancestor",
        descriptor.candidateSha,
        descriptor.acceptedTipSha,
      ],
      { signal, code: "STORY_REPOSITORY_CANDIDATE_NOT_ACCEPTED" },
    );
  } catch (error) {
    if (error?.code === "STORY_REPOSITORY_CANDIDATE_NOT_ACCEPTED" && error?.cause?.code === 1) {
      throw storyRepositoryError(
        "请求的 exact SHA 不在 Controller 已接受分支历史中",
        "STORY_REPOSITORY_CANDIDATE_NOT_ACCEPTED",
      );
    }
    throw error;
  }
  await run(
    ["--git-dir", descriptor.mirrorPath, "fsck", "--connectivity-only", descriptor.candidateSha],
    { signal, timeout: 180_000, code: "STORY_REPOSITORY_MIRROR_CONNECTIVITY_FAILED" },
  );
  return objectFormat;
}

function safeRemoveCreatingDirectory(target, expectedParent) {
  if (!target || !fs.existsSync(target)) return;
  const resolvedTarget = path.resolve(target);
  const resolvedParent = path.resolve(expectedParent);
  if (path.dirname(resolvedTarget) !== resolvedParent || !path.basename(resolvedTarget).startsWith(".")) {
    throw storyRepositoryError(
      `拒绝清理未验证的故事仓临时目录：${resolvedTarget}`,
      "STORY_REPOSITORY_TEMP_PATH_INVALID",
    );
  }
  fs.rmSync(resolvedTarget, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
}

export async function createIndependentStoryRepository({
  root,
  storyId,
  accepted,
  branch,
  detached = false,
  signal = null,
  leaseGuard = null,
  gitChildGuard = null,
  gitSpawnGuard = null,
  gitBinary = null,
  disabledHooksPath = DEFAULT_DISABLED_HOOKS_PATH,
} = {}) {
  const run = createStoryGitRunner({
    gitBinary,
    disabledHooksPath,
    gitChildGuard,
    gitSpawnGuard,
  });
  const descriptor = normalizeAcceptedDescriptor(accepted || {});
  const targetPath = independentStoryRepositoryPath(root, storyId, descriptor.repositoryId);
  const targetParent = path.dirname(targetPath);
  const assertLease = () => {
    if (signal?.aborted || (typeof leaseGuard === "function" && leaseGuard() !== true)) {
      throw storyRepositoryError(
        "独立故事仓创建租约已失效",
        "WORKTREE_MUTATION_LEASE_LOST",
      );
    }
  };
  assertLease();

  const branchName = String(branch || "").trim();
  if (!branchName) {
    throw storyRepositoryError("缺少故事分支名", "STORY_REPOSITORY_BRANCH_REQUIRED");
  }
  await run(["check-ref-format", "--branch", branchName], {
    signal,
    code: "STORY_REPOSITORY_BRANCH_INVALID",
  });
  const existing = await inspectIndependentStoryRepository(targetPath, {
    storyId,
    repositoryId: descriptor.repositoryId,
    gitBinary,
    disabledHooksPath,
    gitSpawnGuard,
  });
  if (existing) {
    return { ...existing, created: false, reused: true };
  }
  const objectFormat = await validateMirrorCandidate(descriptor, signal, run);
  assertLease();

  fs.mkdirSync(targetParent, { recursive: true });
  const temporaryPath = path.join(
    targetParent,
    `.${path.basename(targetPath)}.creating-${randomUUID()}`,
  );
  let published = false;
  try {
    const initArgs = ["init", "--template="];
    if (objectFormat === "sha256") initArgs.push("--object-format=sha256");
    initArgs.push(temporaryPath);
    await run(initArgs, {
      signal,
      code: "STORY_REPOSITORY_INIT_FAILED",
      mutation: true,
      commandId: "story.init",
    });
    assertLease();

    // 只从 Controller 已验证的 bare mirror 复制 exact SHA。使用本地 fetch 会把对象
    // 完整写入故事仓，不创建 alternates，也不会把机器绝对路径持久化为 remote URL。
    await run([
      "-C",
      temporaryPath,
      "-c",
      "protocol.file.allow=always",
      "fetch",
      "--no-auto-maintenance",
      "--quiet",
      "--no-tags",
      "--no-write-fetch-head",
      descriptor.mirrorPath,
      descriptor.candidateSha,
    ], {
      signal,
      timeout: 180_000,
      code: "STORY_REPOSITORY_COPY_FAILED",
      mutation: true,
      commandId: "story.copy-exact-sha",
    });
    assertLease();

    await run(
      ["-C", temporaryPath, "update-ref", `refs/heads/${branchName}`, descriptor.candidateSha],
      {
        signal,
        code: "STORY_REPOSITORY_BRANCH_CREATE_FAILED",
        mutation: true,
        commandId: "story.create-branch",
      },
    );
    await run(
      detached
        ? ["-C", temporaryPath, "checkout", "--quiet", "--detach", descriptor.candidateSha]
        : ["-C", temporaryPath, "checkout", "--quiet", branchName],
      {
        signal,
        timeout: 180_000,
        code: "STORY_REPOSITORY_CHECKOUT_FAILED",
        mutation: true,
        commandId: "story.checkout",
      },
    );
    await writePortableMetadata(run, temporaryPath, {
      storyId: String(storyId),
      repositoryId: descriptor.repositoryId,
      baseRevision: descriptor.candidateSha,
      acceptedTipSha: descriptor.acceptedTipSha,
      sourceRef: descriptor.sourceRef,
      remoteId: descriptor.remoteId,
      mirrorGeneration: descriptor.mirrorGeneration,
    });
    try {
      fs.rmSync(path.join(temporaryPath, ".git", "FETCH_HEAD"), { force: true });
    } catch {}
    assertNoAlternates(temporaryPath);
    await run(["-C", temporaryPath, "fsck", "--connectivity-only"], {
      signal,
      timeout: 180_000,
      code: "STORY_REPOSITORY_CONNECTIVITY_FAILED",
    });
    const exactHead = await run(
      ["-C", temporaryPath, "rev-parse", "--verify", "HEAD^{commit}"],
      { signal, code: "STORY_REPOSITORY_POST_CREATE_MISMATCH" },
    );
    if (exactHead.stdout.toLowerCase() !== descriptor.candidateSha) {
      throw storyRepositoryError(
        "独立故事仓创建后的 HEAD 与 accepted exact SHA 不一致",
        "STORY_REPOSITORY_POST_CREATE_MISMATCH",
      );
    }
    assertLease();
    if (fs.existsSync(targetPath)) {
      const raced = await inspectIndependentStoryRepository(targetPath, {
        storyId,
        repositoryId: descriptor.repositoryId,
        gitBinary,
        disabledHooksPath,
        gitSpawnGuard,
      });
      if (raced) return { ...raced, created: false, reused: true };
      throw storyRepositoryError(
        `故事仓目标在发布前被占用：${targetPath}`,
        "STORY_REPOSITORY_TARGET_CONFLICT",
      );
    }
    fs.renameSync(temporaryPath, targetPath);
    published = true;
    const verified = await inspectIndependentStoryRepository(targetPath, {
      storyId,
      repositoryId: descriptor.repositoryId,
      gitBinary,
      disabledHooksPath,
      gitSpawnGuard,
    });
    if (!verified || verified.headRevision !== descriptor.candidateSha) {
      throw storyRepositoryError(
        "独立故事仓发布后校验失败",
        "STORY_REPOSITORY_POST_CREATE_MISMATCH",
      );
    }
    return { ...verified, created: true, reused: false };
  } finally {
    if (!published && fs.existsSync(temporaryPath)) {
      safeRemoveCreatingDirectory(temporaryPath, targetParent);
    }
  }
}

export async function rollbackCreatedIndependentStoryRepository(repository, {
  gitBinary = null,
  disabledHooksPath = DEFAULT_DISABLED_HOOKS_PATH,
  gitSpawnGuard = null,
} = {}) {
  if (!repository?.created || !repository?.repositoryPath) return { removed: false };
  const target = path.resolve(repository.repositoryPath);
  const inspected = await inspectIndependentStoryRepository(target, {
    storyId: repository.storyId,
    repositoryId: repository.repositoryId,
    gitBinary,
    disabledHooksPath,
    gitSpawnGuard,
  });
  if (!inspected) return { removed: false };
  const expected = independentStoryRepositoryPath(
    path.dirname(path.dirname(target)),
    repository.storyId,
    repository.repositoryId,
  );
  if (normalizedPath(expected) !== normalizedPath(target)) {
    throw storyRepositoryError(
      `拒绝回滚路径不匹配的故事仓：${target}`,
      "STORY_REPOSITORY_ROLLBACK_PATH_INVALID",
    );
  }
  fs.rmSync(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  return { removed: true };
}

export const __test = {
  normalizedPath,
  portableSegment,
  storyGitExecutionArgs,
  inspectIndependentRepository: inspectIndependentStoryRepository,
  validateMirrorCandidate,
};
