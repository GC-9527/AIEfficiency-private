import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { AsyncLocalStorage } from "node:async_hooks";

export const MANAGED_DIRNAME = "devbench-base-protection";
export const MANIFEST_SCHEMA_VERSION = 4;
export const HOOK_NAMES = Object.freeze([
  "pre-commit",
  "pre-rebase",
  "pre-merge-commit",
  "pre-push",
  "reference-transaction",
  "post-checkout",
]);
export const LEGACY_HOOK_MARKER = "# devbench-base-protection";
export const CAPABILITY_ENV = "DEVBENCH_BASE_PROTECTION_CAPABILITY";
export const CONTROLLER_MUTATION_ENV =
  "DEVBENCH_BASE_PROTECTION_CONTROLLER_MUTATION";
const UNINSTALL_JOURNAL_NAME = "uninstall-journal.json";
const RUNTIME_EXECUTABLE_SCHEMA_VERSION = 1;
const runtimeExecution = new AsyncLocalStorage();
const windowsAclCache = new Map();
const WINDOWS_TRUSTED_INSTALLER_SID =
  "S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464";

const LEGACY_HOOK_CONTENT = Object.freeze({
  "pre-commit": `#!/bin/sh
${LEGACY_HOOK_MARKER}
# Blocks commits on base repo non-story branches. Allows story/* (worktree) and system ops.
if [ "$DEVBENCH_SYSTEM_GIT_OP" = "1" ]; then
  exit 0
fi
branch=$(git symbolic-ref --short HEAD 2>/dev/null || echo "")
case "$branch" in
  story/*) exit 0 ;;
  *)
    echo "devbench: base repo commits on branch '$branch' are blocked. Commit in the story worktree instead." >&2
    exit 1
    ;;
esac
`,
  "pre-rebase": `#!/bin/sh
${LEGACY_HOOK_MARKER}
# Blocks rebase on base repo non-story branches. Allows story/* (worktree) and system ops.
if [ "$DEVBENCH_SYSTEM_GIT_OP" = "1" ]; then
  exit 0
fi
branch=$(git symbolic-ref --short HEAD 2>/dev/null || echo "")
case "$branch" in
  story/*) exit 0 ;;
  *)
    echo "devbench: rebase on base repo branch '$branch' is blocked. Rebase in the story worktree instead." >&2
    exit 1
    ;;
esac
`,
  "pre-merge-commit": `#!/bin/sh
${LEGACY_HOOK_MARKER}
# Blocks merge commits on base repo non-story branches. Allows story/* (worktree) and system ops.
if [ "$DEVBENCH_SYSTEM_GIT_OP" = "1" ]; then
  exit 0
fi
branch=$(git symbolic-ref --short HEAD 2>/dev/null || echo "")
case "$branch" in
  story/*) exit 0 ;;
  *)
    echo "devbench: merge commit on base repo branch '$branch' is blocked. Merge in the story worktree instead." >&2
    exit 1
    ;;
esac
`,
});

const STATE_NAMES = new Set([
  "INSTALLING",
  "ACTIVE",
  "DEGRADED",
  "DRIFTED",
  "UNINSTALLING",
  "UNINSTALLED",
]);

function nowIso() {
  return new Date().toISOString();
}

function normalizedPath(value) {
  const resolved = path.resolve(String(value || ""));
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function samePath(left, right) {
  return normalizedPath(left) === normalizedPath(right);
}

function isInside(root, target, { allowSame = false } = {}) {
  const rel = path.relative(path.resolve(root), path.resolve(target));
  if (!rel) return allowSame;
  return rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
}

function realpathExisting(value) {
  const resolved = path.resolve(String(value || ""));
  return fs.realpathSync.native ? fs.realpathSync.native(resolved) : fs.realpathSync(resolved);
}

function canonicalTarget(value) {
  let current = path.resolve(String(value || ""));
  const suffix = [];
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) break;
    suffix.unshift(path.basename(current));
    current = parent;
  }
  const base = fs.existsSync(current) ? realpathExisting(current) : current;
  return path.resolve(base, ...suffix);
}

function assertNoLinkedComponent(root, target) {
  const resolvedRoot = path.resolve(root);
  const resolvedTarget = path.resolve(target);
  if (!isInside(resolvedRoot, resolvedTarget, { allowSame: true })) {
    throw Object.assign(new Error(`受管路径越出 Git common dir: ${resolvedTarget}`), {
      code: "BASE_PROTECTION_PATH_ESCAPE",
    });
  }
  let current = resolvedRoot;
  if (fs.existsSync(current)) {
    const rootStat = fs.lstatSync(current);
    if (rootStat.isSymbolicLink()) {
      throw Object.assign(new Error(`Managed path root is a symbolic link or junction: ${current}`), {
        code: "BASE_PROTECTION_LINK_ESCAPE",
      });
    }
  }
  const rel = path.relative(resolvedRoot, resolvedTarget);
  for (const part of rel.split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    if (!fs.existsSync(current)) continue;
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink()) {
      throw Object.assign(new Error(`受管路径包含符号链接或 junction: ${current}`), {
        code: "BASE_PROTECTION_LINK_ESCAPE",
      });
    }
  }
  const canonicalRoot = canonicalTarget(resolvedRoot);
  const canonical = canonicalTarget(resolvedTarget);
  if (!isInside(canonicalRoot, canonical, { allowSame: true })) {
    throw Object.assign(new Error(`受管路径真实位置越界: ${resolvedTarget}`), {
      code: "BASE_PROTECTION_REALPATH_ESCAPE",
    });
  }
}

function assertPlainRegularFile(filePath, {
  allowMissing = false,
  code = "BASE_PROTECTION_UNSAFE_FILE",
} = {}) {
  const target = path.resolve(filePath);
  if (!fs.existsSync(target)) {
    if (allowMissing) return null;
    throw Object.assign(new Error(`Required plain file is missing: ${target}`), { code });
  }
  const stat = fs.lstatSync(target);
  if (!stat.isFile() || stat.isSymbolicLink() || Number(stat.nlink || 1) !== 1) {
    throw Object.assign(
      new Error(`File must be a non-linked regular file: ${target}`),
      { code },
    );
  }
  return stat;
}

function assertPlainTarget(root, target, options = {}) {
  assertNoLinkedComponent(root, target);
  return assertPlainRegularFile(target, options);
}

function fsyncDirectory(directory) {
  let fd = null;
  try {
    fd = fs.openSync(directory, "r");
    fs.fsyncSync(fd);
  } catch {
    // Windows commonly rejects opening a directory. File fsync plus same-directory
    // rename still provides the strongest portable primitive Node exposes.
  } finally {
    if (fd != null) {
      try { fs.closeSync(fd); } catch {}
    }
  }
}

function safeRelativePath(root, target) {
  const rel = path.relative(path.resolve(root), path.resolve(target));
  if (!rel || rel === "." || rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
    throw Object.assign(new Error(`清单路径越界: ${target}`), {
      code: "BASE_PROTECTION_MANIFEST_PATH_ESCAPE",
    });
  }
  return rel.split(path.sep).join("/");
}

function resolveManifestPath(root, relativeValue) {
  const relative = String(relativeValue || "").replaceAll("/", path.sep);
  const target = path.resolve(root, relative);
  if (!isInside(root, target)) {
    throw Object.assign(new Error(`清单相对路径越界: ${relativeValue}`), {
      code: "BASE_PROTECTION_MANIFEST_PATH_ESCAPE",
    });
  }
  assertNoLinkedComponent(root, target);
  return target;
}

export function sha256(value) {
  const buffer = Buffer.isBuffer(value) ? value : Buffer.from(String(value ?? ""), "utf8");
  return createHash("sha256").update(buffer).digest("hex");
}

function fileHash(filePath) {
  assertPlainRegularFile(filePath);
  return sha256(fs.readFileSync(filePath));
}

function readJson(filePath) {
  assertPlainRegularFile(filePath);
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function mkdirPlain(directory) {
  const target = path.resolve(directory);
  if (fs.existsSync(target)) {
    const stat = fs.lstatSync(target);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw Object.assign(new Error(`目标不是普通目录: ${target}`), {
        code: "BASE_PROTECTION_NOT_PLAIN_DIRECTORY",
      });
    }
    return;
  }
  fs.mkdirSync(target, { recursive: true });
  const stat = fs.lstatSync(target);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw Object.assign(new Error(`创建的目标不是普通目录: ${target}`), {
      code: "BASE_PROTECTION_NOT_PLAIN_DIRECTORY",
    });
  }
}

function atomicWrite(filePath, data, mode = 0o600) {
  const target = path.resolve(filePath);
  mkdirPlain(path.dirname(target));
  if (fs.existsSync(target)) {
    assertPlainRegularFile(target);
  }
  const temp = path.join(path.dirname(target), `.${path.basename(target)}.${process.pid}.${randomUUID()}.tmp`);
  const buffer = Buffer.isBuffer(data) ? data : Buffer.from(String(data), "utf8");
  let fd = null;
  try {
    fd = fs.openSync(temp, "wx", mode);
    fs.writeFileSync(fd, buffer);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    try { fs.chmodSync(temp, mode); } catch {}
    // Node maps this to the platform's same-volume replace primitive
    // (rename(2) / MoveFileExW with replace-existing semantics). Keeping the
    // temporary file in the target directory avoids a crash-visible gap where
    // the original hook path is absent.
    fs.renameSync(temp, target);
    fsyncDirectory(path.dirname(target));
  } finally {
    if (fd != null) {
      try { fs.closeSync(fd); } catch {}
    }
    try { fs.rmSync(temp, { force: true }); } catch {}
  }
}

function atomicWriteJson(filePath, value, mode = 0o600) {
  atomicWrite(filePath, `${JSON.stringify(value, null, 2)}\n`, mode);
}

let moduleExecutablePaths = null;

function executableCandidates(value) {
  const requested = String(value || "").trim();
  if (!requested) return [];
  if (path.isAbsolute(requested)) return [path.resolve(requested)];
  if (requested.includes("/") || requested.includes("\\")) return [];
  const searchPath = String(process.env.PATH || "").split(path.delimiter).filter(Boolean);
  const extensions = process.platform === "win32"
    ? String(process.env.PATHEXT || ".EXE;.CMD;.BAT;.COM")
      .split(";")
      .filter(Boolean)
    : [""];
  const hasExtension = process.platform === "win32" && path.extname(requested);
  const candidates = [];
  for (const directory of searchPath) {
    const base = path.resolve(directory, requested);
    if (process.platform !== "win32" || hasExtension) {
      candidates.push(base);
    } else {
      for (const extension of extensions) candidates.push(`${base}${extension.toLowerCase()}`);
    }
  }
  return candidates;
}

function windowsPowerShellPath() {
  const systemRoot = String(process.env.SystemRoot || process.env.WINDIR || "C:\\Windows");
  return path.join(
    path.resolve(systemRoot),
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
}

function fixedSystemTool(name, candidates) {
  const active = runtimeExecution.getStore()?.executables?.systemTools?.[name];
  if (active?.path) return active.path;
  for (const candidate of candidates) {
    try {
      return resolveExecutablePath(candidate, name);
    } catch {}
  }
  throw Object.assign(new Error(`${name} system tool is unavailable`), {
    code: `BASE_PROTECTION_${name.toUpperCase()}_UNAVAILABLE`,
  });
}

function resolveExecutablePath(value, label) {
  for (const candidate of executableCandidates(value)) {
    try {
      const canonical = realpathExisting(candidate);
      const stat = fs.lstatSync(canonical);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("not a plain executable");
      return canonical;
    } catch {}
  }
  throw Object.assign(new Error(`${label} executable is unavailable or is not an absolute plain file`), {
    code: `BASE_PROTECTION_${label.toUpperCase()}_UNAVAILABLE`,
  });
}

function defaultExecutablePaths() {
  if (!moduleExecutablePaths) {
    moduleExecutablePaths = Object.freeze({
      nodeBinary: resolveExecutablePath(process.execPath, "node"),
      gitBinary: resolveExecutablePath(
        process.env.DEVBENCH_GIT_BINARY || "git",
        "git",
      ),
    });
  }
  return moduleExecutablePaths;
}

function runtimePathsFromOptions(options = {}) {
  const defaults = defaultExecutablePaths();
  const supplied = options.runtimeExecutablePaths || {};
  return {
    nodeBinary: resolveExecutablePath(
      supplied.nodeBinary || options.nodeBinary || defaults.nodeBinary,
      "node",
    ),
    gitBinary: resolveExecutablePath(
      supplied.gitBinary || options.gitBinary || defaults.gitBinary,
      "git",
    ),
  };
}

function activeRuntimeExecutables() {
  const value = runtimeExecution.getStore();
  if (!value?.verified || !value?.executables?.git?.path) {
    throw Object.assign(new Error("A verified pinned Git runtime is required"), {
      code: "BASE_PROTECTION_RUNTIME_EXECUTABLES_UNVERIFIED",
    });
  }
  return value.executables;
}

function sanitizedGitEnvironment(gitDescriptor) {
  const selected = {};
  for (const name of [
    "SystemRoot",
    "WINDIR",
    "COMSPEC",
    "TEMP",
    "TMP",
    "TMPDIR",
    "LANG",
    "LC_ALL",
  ]) {
    if (process.env[name]) selected[name] = process.env[name];
  }
  // The executable is selected by its attested absolute path. PATH is kept
  // deliberately empty so a repository-controlled or caller-controlled
  // node/git/helper cannot be selected by a child lookup.
  selected.PATH = "";
  selected.GIT_CONFIG_NOSYSTEM = "1";
  selected.GIT_CONFIG_GLOBAL = process.platform === "win32" ? "NUL" : "/dev/null";
  selected.GIT_TERMINAL_PROMPT = "0";
  selected.GCM_INTERACTIVE = "Never";
  selected.GIT_PAGER = "cat";
  selected.PAGER = "cat";
  selected.GIT_OPTIONAL_LOCKS = "0";
  return selected;
}

function runGit(repositoryPath, args, { allowFailure = false } = {}) {
  const gitDescriptor = activeRuntimeExecutables().git;
  try {
    const stdout = execFileSync(gitDescriptor.path, [
      "-c",
      "core.fsmonitor=false",
      "-c",
      "credential.helper=",
      "-c",
      "core.sshCommand=",
      "-c",
      "protocol.ext.allow=never",
      "-C",
      repositoryPath,
      ...args,
    ], {
      encoding: "utf8",
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 16 * 1024 * 1024,
      shell: false,
      env: sanitizedGitEnvironment(gitDescriptor),
    });
    return String(stdout || "").trim();
  } catch (error) {
    if (allowFailure) return "";
    const stderr = String(error?.stderr || error?.message || "Git 执行失败").trim();
    throw Object.assign(new Error(stderr || "Git 执行失败"), {
      code: "BASE_PROTECTION_GIT_FAILED",
      gitArgs: args,
    });
  }
}

function absoluteGitPath(repositoryPath, args, fallbackBase) {
  let value = runGit(repositoryPath, ["rev-parse", "--path-format=absolute", ...args], { allowFailure: true });
  if (!value) value = runGit(repositoryPath, ["rev-parse", ...args]);
  return path.isAbsolute(value) ? path.resolve(value) : path.resolve(fallbackBase || repositoryPath, value);
}

function parseConfigEntry(output) {
  const text = String(output || "").trim();
  if (!text) return { present: false, scope: "", origin: "", value: "" };
  const fields = text.split(/\t/);
  if (fields.length >= 3) {
    return {
      present: true,
      scope: fields[0].trim(),
      origin: fields[1].trim(),
      value: fields.slice(2).join("\t"),
    };
  }
  const match = text.match(/^(\S+)\s+(\S+)\s+([\s\S]*)$/);
  return match
    ? { present: true, scope: match[1], origin: match[2], value: match[3] }
    : { present: true, scope: "", origin: "", value: text };
}

function readHooksPathConfig(repositoryPath, localOnly = false) {
  const args = ["config"];
  if (localOnly) args.push("--local");
  args.push("--show-origin", "--show-scope", "--get", "core.hooksPath");
  return parseConfigEntry(runGit(repositoryPath, args, { allowFailure: true }));
}

function repositoryRemoteFingerprint(repositoryPath) {
  const remotes = runGit(
    repositoryPath,
    ["config", "--get-regexp", "^remote\\..*\\.url$"],
    { allowFailure: true },
  )
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .sort();
  return sha256(remotes.join("\n"));
}

function resolveRepositoryInternal(repositoryPath) {
  const requested = path.resolve(String(repositoryPath || ""));
  if (!repositoryPath || !fs.existsSync(requested)) {
    throw Object.assign(new Error(`Git 仓库不存在: ${repositoryPath || "（空）"}`), {
      code: "BASE_PROTECTION_REPOSITORY_MISSING",
    });
  }
  const repositoryRoot = absoluteGitPath(requested, ["--show-toplevel"], requested);
  const commonDirRaw = absoluteGitPath(requested, ["--git-common-dir"], requested);
  const commonDir = realpathExisting(commonDirRaw);
  const gitDir = absoluteGitPath(requested, ["--git-dir"], requested);
  const effectiveHooksDir = absoluteGitPath(requested, ["--git-path", "hooks"], requested);
  const localHooksPath = readHooksPathConfig(requested, true);
  const effectiveHooksPath = readHooksPathConfig(requested, false);
  const managedRoot = path.join(commonDir, MANAGED_DIRNAME);
  const managedHooksDir = path.join(managedRoot, "hooks");
  const objectFormat = runGit(requested, ["rev-parse", "--show-object-format"], { allowFailure: true }) || "sha1";
  const identity = {
    repositoryRoot: realpathExisting(repositoryRoot),
    gitCommonDir: commonDir,
    gitDir: canonicalTarget(gitDir),
    objectFormat,
    remoteFingerprint: repositoryRemoteFingerprint(requested),
  };
  return {
    requested,
    ...identity,
    fingerprint: sha256(JSON.stringify(identity)),
    effectiveHooksDir: canonicalTarget(effectiveHooksDir),
    localHooksPath,
    effectiveHooksPath,
    managedRoot,
    managedHooksDir,
    manifestPath: path.join(managedRoot, "manifest.json"),
    statePath: path.join(managedRoot, "state.json"),
    auditPath: path.join(managedRoot, "logs", "audit.jsonl"),
    lockPath: path.join(managedRoot, "runtime", "manage.lock"),
  };
}

export function resolveRepository(repositoryPath, options = {}) {
  if (runtimeExecution.getStore()?.verified) {
    return resolveRepositoryInternal(repositoryPath);
  }
  const executables = createRuntimeExecutableDescriptor(runtimePathsFromOptions(options));
  return withVerifiedRuntimeExecutables(executables, () => (
    resolveRepositoryInternal(repositoryPath)
  ));
}

function installationPaths(repository) {
  const root = repository.managedRoot;
  return {
    root,
    hooks: path.join(root, "hooks"),
    previousHooks: path.join(root, "previous-hooks"),
    runtime: path.join(root, "runtime"),
    logs: path.join(root, "logs"),
    manifest: path.join(root, "manifest.json"),
    state: path.join(root, "state.json"),
    uninstallBat: path.join(root, "remove-devbench-base-protection.bat"),
    uninstallSh: path.join(root, "remove-devbench-base-protection.sh"),
    diagnoseBat: path.join(root, "diagnose-devbench-base-protection.bat"),
    diagnoseSh: path.join(root, "diagnose-devbench-base-protection.sh"),
    uninstallJournal: path.join(root, "runtime", UNINSTALL_JOURNAL_NAME),
  };
}

function appendAudit(repository, event) {
  mkdirPlain(path.dirname(repository.auditPath));
  assertNoLinkedComponent(repository.managedRoot, repository.auditPath);
  if (fs.existsSync(repository.auditPath)) {
    assertPlainRegularFile(repository.auditPath, {
      code: "BASE_PROTECTION_AUDIT_UNSAFE",
    });
  }
  const line = `${JSON.stringify({
    timestamp: nowIso(),
    ...event,
  })}\n`;
  const fd = fs.openSync(repository.auditPath, "a", 0o600);
  try {
    fs.writeFileSync(fd, line, { encoding: "utf8" });
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function activeInstallationAuditExists(repository, installationId) {
  if (!fs.existsSync(repository.auditPath)) return false;
  assertPlainRegularFile(repository.auditPath, {
    code: "BASE_PROTECTION_AUDIT_UNSAFE",
  });
  return fs.readFileSync(repository.auditPath, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .some((line) => {
      try {
        const event = JSON.parse(line);
        return (
          ["HOOKS_INSTALLED", "HOOKS_INSTALL_RECOVERED"].includes(event.event)
          && event.status === "ACTIVE"
          && event.installationId === installationId
        );
      } catch {
        return false;
      }
    });
}

function ensureActiveInstallationAudit(repository, manifest, details = {}) {
  if (activeInstallationAuditExists(repository, manifest.installationId)) return false;
  appendAudit(repository, {
    event: "HOOKS_INSTALL_RECOVERED",
    status: "ACTIVE",
    repositoryFingerprint: repository.fingerprint,
    installationId: manifest.installationId,
    ...details,
  });
  return true;
}

function writeState(repository, state, manifest = null) {
  const status = STATE_NAMES.has(state.status) ? state.status : "DEGRADED";
  const value = {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    status,
    updatedAt: nowIso(),
    ...(manifest ? { manifestSha256: sha256(`${JSON.stringify(manifest, null, 2)}\n`) } : {}),
    ...state,
    status,
  };
  atomicWriteJson(repository.statePath, value);
  return value;
}

function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function repositoryGitProcessActive(repository) {
  const needles = [
    path.resolve(repository.repositoryRoot),
    path.resolve(repository.gitCommonDir),
  ].map((value) => (
    process.platform === "win32" ? value.toLowerCase() : value
  ));
  if (process.platform === "win32") {
    const script = [
      "$ErrorActionPreference='Stop'",
      "$needles=@($env:DEVBENCH_REPOSITORY_ROOT.ToLowerInvariant(),$env:DEVBENCH_GIT_COMMON_DIR.ToLowerInvariant())",
      "$active=$false",
      "foreach($p in (Get-CimInstance Win32_Process -Filter \"Name='git.exe'\")){",
      " $c=[string]$p.CommandLine",
      " if(!$c){continue}",
      " $c=$c.ToLowerInvariant()",
      " foreach($n in $needles){if($c.Contains($n)){$active=$true;break}}",
      " if($active){break}",
      "}",
      "if($active){[Console]::Out.Write('ACTIVE')}else{[Console]::Out.Write('CLEAR')}",
    ].join(";");
    const result = spawnSync(
      fixedSystemTool("powershell", [windowsPowerShellPath()]),
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "-"],
      {
        input: script,
        encoding: "utf8",
        windowsHide: true,
        timeout: 10_000,
        shell: false,
        env: {
          SystemRoot: process.env.SystemRoot || "",
          WINDIR: process.env.WINDIR || "",
          PATH: "",
          TEMP: process.env.TEMP || "",
          TMP: process.env.TMP || "",
          DEVBENCH_REPOSITORY_ROOT: needles[0],
          DEVBENCH_GIT_COMMON_DIR: needles[1],
        },
      },
    );
    const output = String(result.stdout || "").trim();
    if (result.error || result.status !== 0 || !["ACTIVE", "CLEAR"].includes(output)) {
      throw Object.assign(new Error("Unable to attest repository Git process state"), {
        code: "BASE_PROTECTION_GIT_PROCESS_CHECK_FAILED",
      });
    }
    return output === "ACTIVE";
  }
  const result = spawnSync(fixedSystemTool("ps", ["/bin/ps", "/usr/bin/ps"]), [
    "-axo",
    "comm=,args=",
  ], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 10_000,
    shell: false,
    env: {
      PATH: "",
      LANG: "C",
      LC_ALL: "C",
    },
  });
  if (result.error || result.status !== 0) {
    throw Object.assign(new Error("Unable to attest repository Git process state"), {
      code: "BASE_PROTECTION_GIT_PROCESS_CHECK_FAILED",
    });
  }
  return String(result.stdout || "").split(/\r?\n/).some((line) => {
    const trimmed = line.trim();
    if (!/^(?:\S*\/)?git(?:\s|$)/.test(trimmed)) return false;
    return needles.some((needle) => trimmed.includes(needle));
  });
}

function recoverStaleManageLock(repository) {
  assertPlainTarget(repository.managedRoot, repository.lockPath, {
    code: "BASE_PROTECTION_MANAGE_LOCK_UNSAFE",
  });
  let record;
  try {
    record = readJson(repository.lockPath);
  } catch (cause) {
    throw Object.assign(new Error("Managed hooks lock is malformed"), {
      code: "BASE_PROTECTION_MANAGE_LOCK_INVALID",
      cause,
    });
  }
  const pid = Number(record?.pid);
  if (
    !Number.isSafeInteger(pid)
    || pid <= 0
    || String(record?.host || "") !== os.hostname()
  ) {
    throw Object.assign(new Error("Managed hooks lock ownership cannot be proven stale"), {
      code: "BASE_PROTECTION_MANAGE_LOCK_UNVERIFIED",
    });
  }
  if (processIsAlive(pid)) {
    throw Object.assign(new Error("Managed hooks operation is still active"), {
      code: "BASE_PROTECTION_LOCKED",
    });
  }
  if (repositoryGitProcessActive(repository)) {
    throw Object.assign(new Error("A Git process still references the protected repository"), {
      code: "BASE_PROTECTION_GIT_PROCESS_ACTIVE",
    });
  }
  const archiveDirectory = path.join(repository.managedRoot, "logs");
  mkdirPlain(archiveDirectory);
  const archived = path.join(
    archiveDirectory,
    `stale-manage-lock-${Date.now()}-${randomUUID()}.json`,
  );
  fs.renameSync(repository.lockPath, archived);
  fsyncDirectory(path.dirname(repository.lockPath));
  fsyncDirectory(archiveDirectory);
  appendAudit(repository, {
    event: "MANAGE_LOCK_RECOVERED",
    status: "RECOVERY_REQUIRED",
    staleLock: path.basename(archived),
    stalePid: pid,
    staleOperation: String(record.operation || ""),
    staleOperationId: String(record.lockId || ""),
  });
}

function acquireManageLock(repository, operation) {
  mkdirPlain(path.dirname(repository.lockPath));
  const lockId = randomUUID();
  let acquired = false;
  for (let attempt = 0; attempt < 2 && !acquired; attempt += 1) {
    try {
      const fd = fs.openSync(repository.lockPath, "wx", 0o600);
      try {
        fs.writeFileSync(fd, `${JSON.stringify({
          lockId,
          pid: process.pid,
          operation,
          startedAt: nowIso(),
          host: os.hostname(),
        })}\n`);
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      fsyncDirectory(path.dirname(repository.lockPath));
      acquired = true;
    } catch (error) {
      if (attempt === 0 && fs.existsSync(repository.lockPath)) {
        recoverStaleManageLock(repository);
        continue;
      }
      throw Object.assign(new Error(`Managed hooks operation is locked: ${repository.lockPath}`), {
        code: error?.code === "BASE_PROTECTION_LOCKED"
          ? error.code
          : "BASE_PROTECTION_LOCKED",
        cause: error,
      });
    }
  }
  return () => {
    try {
      if (!fs.existsSync(repository.lockPath)) return;
      assertPlainTarget(repository.managedRoot, repository.lockPath, {
        code: "BASE_PROTECTION_MANAGE_LOCK_UNSAFE",
      });
      const current = readJson(repository.lockPath);
      if (current.lockId !== lockId || Number(current.pid) !== process.pid) return;
      fs.rmSync(repository.lockPath, { force: true });
      fsyncDirectory(path.dirname(repository.lockPath));
    } catch {}
  };
}

function isStrictLegacyManagedHook(bytes, hookName) {
  const expected = LEGACY_HOOK_CONTENT[hookName];
  return !!expected
    && Buffer.isBuffer(bytes)
    && bytes.equals(Buffer.from(expected, "utf8"));
}

function previousHookRecord(repository, paths, hookName) {
  const sourcePath = path.join(repository.effectiveHooksDir, hookName);
  const legacyBackupPath = `${sourcePath}.pre-devbench.bak`;
  let originalPath = sourcePath;
  let legacyManaged = false;
  if (fs.existsSync(sourcePath)) {
    const sourceStat = fs.lstatSync(sourcePath);
    if (
      !sourceStat.isFile()
      || sourceStat.isSymbolicLink()
      || Number(sourceStat.nlink || 1) !== 1
    ) {
      throw Object.assign(new Error(`原 hook 不是普通文件: ${sourcePath}`), {
        code: "BASE_PROTECTION_ORIGINAL_HOOK_UNSAFE",
      });
    }
    const sourceBytes = fs.readFileSync(sourcePath);
    if (isStrictLegacyManagedHook(sourceBytes, hookName)) {
      legacyManaged = true;
      originalPath = fs.existsSync(legacyBackupPath) ? legacyBackupPath : "";
    }
  }
  if (!originalPath || !fs.existsSync(originalPath)) {
    return {
      name: hookName,
      existed: false,
      sourcePath,
      backupPath: "",
      sha256: "",
      mode: 0,
      executable: false,
      bytesBase64: "",
      legacyManaged,
      legacyBackupPath: legacyManaged && fs.existsSync(legacyBackupPath) ? legacyBackupPath : "",
    };
  }
  const stat = fs.lstatSync(originalPath);
  if (!stat.isFile() || stat.isSymbolicLink() || Number(stat.nlink || 1) !== 1) {
    throw Object.assign(new Error(`原 hook 备份不是普通文件: ${originalPath}`), {
      code: "BASE_PROTECTION_ORIGINAL_HOOK_UNSAFE",
    });
  }
  const bytes = fs.readFileSync(originalPath);
  const mode = stat.mode & 0o777;
  const backupPath = path.join(paths.previousHooks, hookName);
  atomicWrite(backupPath, bytes, mode || 0o600);
  return {
    name: hookName,
    existed: true,
    sourcePath,
    backupPath: safeRelativePath(paths.root, backupPath),
    sha256: sha256(bytes),
    mode,
    // Git for Windows does not preserve POSIX execute bits in fs.stat(), but
    // still treats hook files in the hooks directory as runnable shell files.
    executable: process.platform === "win32" || (mode & 0o111) !== 0,
    bytesBase64: bytes.toString("base64"),
    legacyManaged,
    legacyBackupPath: legacyManaged ? legacyBackupPath : "",
  };
}

function shellLiteral(value) {
  const normalized = process.platform === "win32"
    ? String(value).replaceAll("\\", "/")
    : String(value);
  return `'${normalized.replaceAll("'", "'\\''")}'`;
}

function batchLiteral(value) {
  return String(value).replaceAll("%", "%%");
}

function renderDispatcher(hookName, previous, nodeBinary) {
  const runPrevious = previous?.existed && previous?.executable
    ? [
        `PREVIOUS="$MANAGED_ROOT/${String(previous.backupPath).replaceAll("\\", "/")}"`,
        'if [ ! -f "$PREVIOUS" ]; then',
        `  echo "devbench: previous ${hookName} hook backup is missing; refusing to continue." >&2`,
        "  exit 93",
        "fi",
        '"$PREVIOUS" "$@"',
        "exit $?",
      ].join("\n")
    : "exit 0";
  return `#!/bin/sh
# devbench-base-protection-managed-v2
set -u
HOOK_DIR=$(CDPATH= cd -P -- "$(dirname -- "$0")" >/dev/null 2>&1 && pwd)
if [ -z "$HOOK_DIR" ]; then
  echo "devbench: cannot resolve managed hook directory." >&2
  exit 90
fi
MANAGED_ROOT=$(CDPATH= cd -P -- "$HOOK_DIR/.." >/dev/null 2>&1 && pwd)
if [ -z "$MANAGED_ROOT" ]; then
  echo "devbench: managed hook runtime is unavailable; operation denied." >&2
  exit 91
fi
PINNED_NODE=${shellLiteral(nodeBinary)}
if [ ! -f "$PINNED_NODE" ]; then
  echo "devbench: pinned Node.js runtime is unavailable; operation denied." >&2
  exit 91
fi
"$PINNED_NODE" "$MANAGED_ROOT/runtime/manage.mjs" guard --hook "${hookName}" -- "$@"
GUARD_RESULT=$?
if [ "$GUARD_RESULT" -ne 0 ]; then
  exit "$GUARD_RESULT"
fi
if [ "\${${CONTROLLER_MUTATION_ENV}:-}" = "1" ]; then
  exit 0
fi
${runPrevious}
`;
}

function powershellSingleQuoted(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function renderBat(command, title, nodeBinary, powershellBinary) {
  const commandArgs = [
    ...String(command).split(/\s+/).filter(Boolean),
    "--launcher=bat",
  ];
  const powershellScript = [
    `$node=${powershellSingleQuoted(nodeBinary)}`,
    "$root=[string]$env:DEVBENCH_MANAGED_ROOT",
    "if(!$root){exit 91}",
    "$manage=[IO.Path]::Combine($root,'runtime','manage.mjs')",
    `$arguments=@(${commandArgs.map(powershellSingleQuoted).join(",")})`,
    "& $node $manage @arguments",
    "exit $LASTEXITCODE",
  ].join(";");
  const encoded = Buffer.from(powershellScript, "utf16le").toString("base64");
  return `@echo off
setlocal EnableExtensions DisableDelayedExpansion
title DevBench managed hooks
cd /d "%~dp0"
set "DEVBENCH_MANAGED_ROOT=%~dp0"
rem pinned-node-path-base64=${Buffer.from(nodeBinary, "utf8").toString("base64")}
rem command="%~dp0runtime\\manage.mjs" ${command} --launcher=bat
"${batchLiteral(powershellBinary)}" -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand ${encoded}
exit /b %ERRORLEVEL%
`.replaceAll("\n", "\r\n");
}

function renderSh(command, nodeBinary) {
  return `#!/bin/sh
set -u
case "$0" in
  */*) SCRIPT_PATH=$0 ;;
  *) SCRIPT_PATH=./$0 ;;
esac
SCRIPT_DIR=\${SCRIPT_PATH%/*}
if [ -z "$SCRIPT_DIR" ]; then
  SCRIPT_DIR=/
fi
SCRIPT_DIR=$(CDPATH= cd -P "$SCRIPT_DIR" >/dev/null 2>&1 && pwd)
if [ -z "$SCRIPT_DIR" ]; then
  echo "[失败] 无法解析脚本目录。" >&2
  exit 2
fi
PINNED_NODE=${shellLiteral(nodeBinary)}
if [ ! -f "$PINNED_NODE" ]; then
  echo "[失败] 未找到 Node.js，无法安全管理 DevBench 基础仓库 hooks。" >&2
  exit 2
fi
"$PINNED_NODE" "$SCRIPT_DIR/runtime/manage.mjs" ${command} --launcher=sh "$@"
exit $?
`;
}

function normalizedValidatorDescriptor(value) {
  if (!value || typeof value !== "object") return { type: "none" };
  if (value.type === "command") {
    const rawExecutable = String(value.executable || "");
    if (!rawExecutable || !path.isAbsolute(rawExecutable)) {
      throw Object.assign(new Error("capabilityValidator command 必须是存在的绝对路径"), {
        code: "BASE_PROTECTION_VALIDATOR_INVALID",
      });
    }
    const executable = path.resolve(rawExecutable);
    if (!fs.existsSync(executable)) {
      throw Object.assign(new Error("capabilityValidator command 必须是存在的绝对路径"), {
        code: "BASE_PROTECTION_VALIDATOR_INVALID",
      });
    }
    assertPlainRegularFile(executable, {
      code: "BASE_PROTECTION_VALIDATOR_INVALID",
    });
    const args = Array.isArray(value.args) ? value.args.map(String) : [];
    const argFiles = args
      .filter((arg) => path.isAbsolute(arg) && fs.existsSync(arg))
      .map((arg) => {
        const filePath = path.resolve(arg);
        assertPlainRegularFile(filePath, {
          code: "BASE_PROTECTION_VALIDATOR_INVALID",
        });
        return { path: filePath, sha256: fileHash(filePath) };
      });
    return {
      type: "command",
      executable,
      executableSha256: fileHash(executable),
      args,
      argFiles,
      timeoutMs: Math.max(100, Math.min(30_000, Number(value.timeoutMs) || 5_000)),
    };
  }
  if (value.type === "module") {
    const rawModulePath = String(value.modulePath || "");
    if (!rawModulePath || !path.isAbsolute(rawModulePath)) {
      throw Object.assign(new Error("capabilityValidator module 必须是存在的绝对路径"), {
        code: "BASE_PROTECTION_VALIDATOR_INVALID",
      });
    }
    const modulePath = path.resolve(rawModulePath);
    if (!fs.existsSync(modulePath)) {
      throw Object.assign(new Error("capabilityValidator module 必须是存在的绝对路径"), {
        code: "BASE_PROTECTION_VALIDATOR_INVALID",
      });
    }
    return {
      type: "module",
      modulePath,
      moduleSha256: fileHash(modulePath),
      exportName: String(value.exportName || "validateCapability"),
    };
  }
  return { type: "none" };
}

function windowsAclAttestation(filePath, {
  enforceBroadWrite = true,
} = {}) {
  const target = path.resolve(filePath);
  const stat = fs.lstatSync(target, { bigint: true });
  const fingerprint = [
    String(stat.dev),
    String(stat.ino),
    String(stat.size),
    String(stat.mtimeNs),
    String(stat.ctimeNs),
    enforceBroadWrite ? "strict" : "record",
  ].join(":");
  const cacheKey = `${target}\0${enforceBroadWrite ? "strict" : "record"}`;
  const cached = windowsAclCache.get(cacheKey);
  if (cached?.fingerprint === fingerprint) return { ...cached.value };
  const script = [
    "$ErrorActionPreference='Stop'",
    "$acl=Get-Acl -LiteralPath $env:DEVBENCH_ACL_TARGET",
    "$ownerSid=[string]$acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value",
    "$currentSid=[string][System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value",
    "$value=[ordered]@{owner=[string]$acl.Owner;ownerSid=$ownerSid;currentSid=$currentSid;sddl=[string]$acl.Sddl}",
    "[Console]::Out.Write(($value|ConvertTo-Json -Compress))",
  ].join(";");
  const result = spawnSync(
    fixedSystemTool("powershell", [windowsPowerShellPath()]),
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "-"],
    {
      input: script,
      encoding: "utf8",
      windowsHide: true,
      shell: false,
      timeout: 10_000,
      env: {
        SystemRoot: process.env.SystemRoot || "",
        WINDIR: process.env.WINDIR || "",
        PATH: "",
        TEMP: process.env.TEMP || "",
        TMP: process.env.TMP || "",
        DEVBENCH_ACL_TARGET: target,
      },
    },
  );
  let parsed = null;
  try {
    parsed = JSON.parse(String(result.stdout || "").trim());
  } catch {}
  const sddl = String(parsed?.sddl || "");
  const owner = String(parsed?.owner || "");
  const ownerSid = String(parsed?.ownerSid || "");
  const currentSid = String(parsed?.currentSid || "");
  if (result.error || result.status !== 0 || !sddl || !owner || !ownerSid || !currentSid) {
    throw Object.assign(new Error("Unable to attest Windows ACL"), {
      code: "BASE_PROTECTION_MANAGEMENT_CLIENT_ACL_UNAVAILABLE",
    });
  }
  assertWindowsAclWritePolicy(sddl, {
    enforceBroadWrite,
    ownerSid,
    currentSid,
  });
  const value = windowsSecurityValue(owner, ownerSid, sddl);
  windowsAclCache.set(cacheKey, { fingerprint, value });
  return { ...value };
}

function windowsSecurityValue(owner, ownerSid, sddl) {
  return {
    owner,
    ownerSid,
    ownerSha256: sha256(owner),
    aclSha256: sha256(sddl),
  };
}

function assertWindowsAclWritePolicy(sddl, {
  enforceBroadWrite,
  ownerSid = "",
  currentSid = "",
} = {}) {
  for (const match of String(sddl || "").matchAll(/\(A;([^;]*);([^;]*);[^;]*;[^;]*;([^)]+)\)/g)) {
    const flags = match[1];
    const rights = match[2];
    const principal = match[3];
    if (flags.includes("IO")) continue;
    const numericRights = /^0x[0-9a-f]+$/i.test(rights)
      ? Number.parseInt(rights.slice(2), 16)
      : 0;
    const broadWriteMask = (
      0x00000002 // FILE_WRITE_DATA
      | 0x00000004 // FILE_APPEND_DATA
      | 0x00000010 // FILE_WRITE_EA
      | 0x00000100 // FILE_WRITE_ATTRIBUTES
      | 0x00010000 // DELETE
      | 0x00040000 // WRITE_DAC
      | 0x00080000 // WRITE_OWNER
      | 0x10000000 // GENERIC_ALL
      | 0x40000000 // GENERIC_WRITE
    );
    const privileged = ["SY", "BA", "CO"].includes(principal)
      || principal === ownerSid
      || principal === currentSid
      || principal === WINDOWS_TRUSTED_INSTALLER_SID;
    if (enforceBroadWrite && !privileged && (
      /(?:GA|GW|FA|FW|WD|AD|DC|DE|SD|WA|WE|WO)/.test(rights)
      || (numericRights & broadWriteMask) !== 0
    )) {
      throw Object.assign(new Error("Management client is writable by a broad Windows principal"), {
        code: "BASE_PROTECTION_MANAGEMENT_CLIENT_PERMISSIONS_WEAK",
      });
    }
  }
}

function windowsAclAttestMany(paths) {
  const targets = [...new Set(paths.map((item) => path.resolve(item)))];
  const script = [
    "$ErrorActionPreference='Stop'",
    "$targets=($env:DEVBENCH_ACL_TARGETS|ConvertFrom-Json)",
    "$values=@()",
    "$currentSid=[string][System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value",
    "for($index=0;$index -lt $targets.Count;$index++){",
    " $target=$targets[$index]",
    " $acl=Get-Acl -LiteralPath ([string]$target)",
    " $ownerSid=[string]$acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value",
    " $values += [ordered]@{index=$index;owner=[string]$acl.Owner;ownerSid=$ownerSid;currentSid=$currentSid;sddl=[string]$acl.Sddl}",
    "}",
    "[Console]::Out.Write(($values|ConvertTo-Json -Compress))",
  ].join(";");
  const result = spawnSync(
    fixedSystemTool("powershell", [windowsPowerShellPath()]),
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
    {
      encoding: "utf8",
      windowsHide: true,
      shell: false,
      timeout: 20_000,
      maxBuffer: 4 * 1024 * 1024,
      env: {
        SystemRoot: process.env.SystemRoot || "",
        WINDIR: process.env.WINDIR || "",
        PATH: "",
        TEMP: process.env.TEMP || "",
        TMP: process.env.TMP || "",
        DEVBENCH_ACL_TARGETS: JSON.stringify(targets),
      },
    },
  );
  if (result.error || result.status !== 0) {
    throw Object.assign(new Error("Unable to attest Windows runtime ACL chain"), {
      code: "BASE_PROTECTION_RUNTIME_ACL_UNAVAILABLE",
    });
  }
  return parseWindowsAclBatch(result.stdout, targets);
}

function parseWindowsAclBatch(stdout, expectedTargets) {
  let values;
  try {
    values = JSON.parse(String(stdout || "").trim());
  } catch (cause) {
    throw Object.assign(new Error("Windows runtime ACL response is invalid"), {
      code: "BASE_PROTECTION_RUNTIME_ACL_UNAVAILABLE",
      cause,
    });
  }
  const list = Array.isArray(values) ? values : [values];
  const byPath = new Map();
  for (const item of list) {
    const index = Number(item?.index);
    if (!Number.isSafeInteger(index) || index < 0 || index >= expectedTargets.length) continue;
    const target = path.resolve(expectedTargets[index]);
    const owner = String(item?.owner || "");
    const ownerSid = String(item?.ownerSid || "");
    const currentSid = String(item?.currentSid || "");
    const sddl = String(item?.sddl || "");
    if (!owner || !ownerSid || !currentSid || !sddl) continue;
    byPath.set(normalizedPath(target), {
      owner,
      ownerSid,
      currentSid,
      sddl,
    });
  }
  const missing = expectedTargets.filter(
    (target) => !byPath.has(normalizedPath(target)),
  );
  if (missing.length) {
    throw Object.assign(new Error(
      `Windows runtime ACL response is incomplete: ${missing.slice(0, 3).join(", ")}; got ${[...byPath.keys()].slice(0, 5).join(", ")}`,
    ), {
      code: "BASE_PROTECTION_RUNTIME_ACL_UNAVAILABLE",
    });
  }
  return byPath;
}

function fileSecurityAttestation(filePath, {
  enforceBroadWrite = true,
} = {}) {
  if (process.platform === "win32") {
    return windowsAclAttestation(filePath, { enforceBroadWrite });
  }
  const stat = fs.statSync(filePath);
  const mode = stat.mode & 0o7777;
  const stickyWritableDirectory = stat.isDirectory()
    && (mode & 0o1000) !== 0
    && (mode & 0o022) !== 0;
  if (enforceBroadWrite && (mode & 0o022) !== 0 && !stickyWritableDirectory) {
    throw Object.assign(new Error("Management client file is group/world writable"), {
      code: "BASE_PROTECTION_MANAGEMENT_CLIENT_PERMISSIONS_WEAK",
    });
  }
  return {
    mode,
    uid: Number(stat.uid),
    gid: Number(stat.gid),
  };
}

function directorySecurityRecord(directory, {
  enforceBroadWrite,
} = {}) {
  const target = path.resolve(directory);
  const stat = fs.lstatSync(target);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw Object.assign(new Error(`Runtime parent is not a plain directory: ${target}`), {
      code: "BASE_PROTECTION_RUNTIME_PARENT_UNSAFE",
    });
  }
  let security;
  try {
    security = fileSecurityAttestation(target, { enforceBroadWrite });
  } catch (cause) {
    throw Object.assign(new Error(`Runtime parent permissions are unsafe: ${target}`), {
      code: "BASE_PROTECTION_RUNTIME_PARENT_PERMISSIONS_WEAK",
      cause,
    });
  }
  return {
    path: target,
    security,
    attestationSha256: sha256(JSON.stringify({
      path: normalizedPath(target),
      security,
    })),
  };
}

function executableParentPaths(executable) {
  const paths = [];
  let current = path.dirname(path.resolve(executable));
  for (;;) {
    paths.push(current);
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return paths;
}

function executableParentChain(executable) {
  const records = [];
  for (const current of executableParentPaths(executable)) {
    // The executable's containing directory must not be writable by a broad
    // or non-owner principal. Every ancestor is checked as well: write/delete
    // rights on an ancestor can otherwise replace the protected child path.
    records.push(directorySecurityRecord(current, {
      enforceBroadWrite: true,
    }));
  }
  return records;
}

function executableSecurityRecord(executableValue, label) {
  const executable = resolveExecutablePath(executableValue, label);
  const stat = fs.lstatSync(executable);
  let security;
  try {
    security = fileSecurityAttestation(executable);
  } catch (cause) {
    throw Object.assign(new Error(`Pinned ${label} permissions are unsafe: ${executable}`), {
      code: `BASE_PROTECTION_${label.toUpperCase()}_PERMISSIONS_WEAK`,
      cause,
    });
  }
  return {
    path: executable,
    sha256: sha256(fs.readFileSync(executable)),
    fileIdentity: {
      dev: String(stat.dev),
      ino: String(stat.ino),
      nlink: Number(stat.nlink || 1),
    },
    security,
    parents: executableParentChain(executable),
  };
}

function createRuntimeExecutableDescriptor({
  nodeBinary,
  gitBinary,
}) {
  const systemTools = process.platform === "win32"
    ? {
        powershell: executableSecurityRecord(
          fixedSystemTool("powershell", [windowsPowerShellPath()]),
          "powershell",
        ),
      }
    : {
        ps: executableSecurityRecord(
          fixedSystemTool("ps", ["/bin/ps", "/usr/bin/ps"]),
          "ps",
        ),
      };
  return {
    schemaVersion: RUNTIME_EXECUTABLE_SCHEMA_VERSION,
    systemTools,
    node: executableSecurityRecord(nodeBinary, "node"),
    git: executableSecurityRecord(gitBinary, "git"),
  };
}

function assertRuntimeExecutableRecord(record, label) {
  if (
    !record
    || typeof record !== "object"
    || !path.isAbsolute(String(record.path || ""))
    || !/^[0-9a-f]{64}$/.test(String(record.sha256 || ""))
    || !Array.isArray(record.parents)
    || record.parents.length < 1
  ) {
    throw Object.assign(new Error(`Pinned ${label} descriptor is invalid`), {
      code: `BASE_PROTECTION_${label.toUpperCase()}_DESCRIPTOR_INVALID`,
    });
  }
  const executable = resolveExecutablePath(record.path, label);
  const stat = fs.lstatSync(executable);
  const currentIdentity = {
    dev: String(stat.dev),
    ino: String(stat.ino),
    nlink: Number(stat.nlink || 1),
  };
  if (
    !samePath(executable, record.path)
    || sha256(fs.readFileSync(executable)) !== record.sha256
    || JSON.stringify(currentIdentity) !== JSON.stringify(record.fileIdentity || {})
  ) {
    throw Object.assign(new Error(`Pinned ${label} executable hash has drifted`), {
      code: `BASE_PROTECTION_${label.toUpperCase()}_HASH_DRIFT`,
    });
  }
  const currentSecurity = fileSecurityAttestation(executable);
  if (JSON.stringify(currentSecurity) !== JSON.stringify(record.security || {})) {
    throw Object.assign(new Error(`Pinned ${label} executable security has drifted`), {
      code: `BASE_PROTECTION_${label.toUpperCase()}_SECURITY_DRIFT`,
    });
  }
  const currentParents = executableParentChain(executable);
  if (currentParents.length !== record.parents.length) {
    throw Object.assign(new Error(`Pinned ${label} parent chain has drifted`), {
      code: `BASE_PROTECTION_${label.toUpperCase()}_PARENT_DRIFT`,
    });
  }
  for (let index = 0; index < currentParents.length; index += 1) {
    const current = currentParents[index];
    const expected = record.parents[index] || {};
    if (
      !samePath(current.path, expected.path || "")
      || current.attestationSha256 !== expected.attestationSha256
      || JSON.stringify(current.security) !== JSON.stringify(expected.security || {})
    ) {
      throw Object.assign(new Error(`Pinned ${label} parent chain has drifted`), {
        code: `BASE_PROTECTION_${label.toUpperCase()}_PARENT_DRIFT`,
      });
    }
  }
  return record;
}

function verifyWindowsRuntimeExecutableDescriptor(value) {
  const entries = [
    ["powershell", value.systemTools?.powershell],
    ["node", value.node],
    ["git", value.git],
  ];
  if (!samePath(entries[0][1]?.path || "", windowsPowerShellPath())) {
    throw Object.assign(new Error("Pinned Windows PowerShell path is invalid"), {
      code: "BASE_PROTECTION_POWERSHELL_PATH_DRIFT",
    });
  }
  const targets = [];
  const checked = [];
  for (const [label, record] of entries) {
    if (
      !record
      || typeof record !== "object"
      || !path.isAbsolute(String(record.path || ""))
      || !/^[0-9a-f]{64}$/.test(String(record.sha256 || ""))
      || !Array.isArray(record.parents)
      || record.parents.length < 1
    ) {
      throw Object.assign(new Error(`Pinned ${label} descriptor is invalid`), {
        code: `BASE_PROTECTION_${label.toUpperCase()}_DESCRIPTOR_INVALID`,
      });
    }
    const executable = resolveExecutablePath(record.path, label);
    const stat = fs.lstatSync(executable);
    const identity = {
      dev: String(stat.dev),
      ino: String(stat.ino),
      nlink: Number(stat.nlink || 1),
    };
    if (
      !samePath(executable, record.path)
      || sha256(fs.readFileSync(executable)) !== record.sha256
      || JSON.stringify(identity) !== JSON.stringify(record.fileIdentity || {})
    ) {
      throw Object.assign(new Error(`Pinned ${label} executable has drifted`), {
        code: `BASE_PROTECTION_${label.toUpperCase()}_HASH_DRIFT`,
      });
    }
    const parents = executableParentPaths(executable);
    if (parents.length !== record.parents.length) {
      throw Object.assign(new Error(`Pinned ${label} parent chain has drifted`), {
        code: `BASE_PROTECTION_${label.toUpperCase()}_PARENT_DRIFT`,
      });
    }
    parents.forEach((parent, index) => {
      const statValue = fs.lstatSync(parent);
      if (
        !statValue.isDirectory()
        || statValue.isSymbolicLink()
        || !samePath(parent, record.parents[index]?.path || "")
      ) {
        throw Object.assign(new Error(`Pinned ${label} parent chain has drifted`), {
          code: `BASE_PROTECTION_${label.toUpperCase()}_PARENT_DRIFT`,
        });
      }
    });
    targets.push(executable, ...parents);
    checked.push({ label, record, executable, parents });
  }

  // The PowerShell bytes and path were checked above before this first launch.
  // One fixed SystemRoot process snapshots the complete ACL chain, avoiding a
  // PATH lookup and keeping hook latency bounded.
  const aclValues = windowsAclAttestMany(targets);
  const securityFor = (target, expected, label, parent = false) => {
    const raw = aclValues.get(normalizedPath(target));
    try {
      assertWindowsAclWritePolicy(raw.sddl, {
        enforceBroadWrite: true,
        ownerSid: raw.ownerSid,
        currentSid: raw.currentSid,
      });
    } catch (cause) {
      throw Object.assign(new Error(`Pinned ${label} permissions are unsafe`), {
        code: parent
          ? `BASE_PROTECTION_${label.toUpperCase()}_PARENT_PERMISSIONS_WEAK`
          : `BASE_PROTECTION_${label.toUpperCase()}_PERMISSIONS_WEAK`,
        cause,
      });
    }
    const security = windowsSecurityValue(raw.owner, raw.ownerSid, raw.sddl);
    if (JSON.stringify(security) !== JSON.stringify(expected || {})) {
      throw Object.assign(new Error(`Pinned ${label} security has drifted`), {
        code: parent
          ? `BASE_PROTECTION_${label.toUpperCase()}_PARENT_DRIFT`
          : `BASE_PROTECTION_${label.toUpperCase()}_SECURITY_DRIFT`,
      });
    }
    return security;
  };
  for (const { label, record, executable, parents } of checked) {
    securityFor(executable, record.security, label);
    parents.forEach((parent, index) => {
      const security = securityFor(
        parent,
        record.parents[index]?.security,
        label,
        true,
      );
      const attestationSha256 = sha256(JSON.stringify({
        path: normalizedPath(parent),
        security,
      }));
      if (attestationSha256 !== record.parents[index]?.attestationSha256) {
        throw Object.assign(new Error(`Pinned ${label} parent chain has drifted`), {
          code: `BASE_PROTECTION_${label.toUpperCase()}_PARENT_DRIFT`,
        });
      }
    });
  }
  return value;
}

function verifyRuntimeExecutableDescriptor(value) {
  if (
    !value
    || typeof value !== "object"
    || Number(value.schemaVersion) !== RUNTIME_EXECUTABLE_SCHEMA_VERSION
  ) {
    throw Object.assign(new Error("Pinned runtime executable descriptor is missing"), {
      code: "BASE_PROTECTION_RUNTIME_EXECUTABLES_MISSING",
    });
  }
  if (process.platform === "win32") {
    return verifyWindowsRuntimeExecutableDescriptor(value);
  } else {
    assertRuntimeExecutableRecord(value.systemTools?.ps, "ps");
  }
  assertRuntimeExecutableRecord(value.node, "node");
  assertRuntimeExecutableRecord(value.git, "git");
  return value;
}

function withVerifiedRuntimeExecutables(value, callback) {
  const executables = verifyRuntimeExecutableDescriptor(value);
  return runtimeExecution.run({
    verified: true,
    executables,
  }, callback);
}

function withRuntimeExecutablePaths(options, callback) {
  if (runtimeExecution.getStore()?.verified) return callback();
  const descriptor = createRuntimeExecutableDescriptor(runtimePathsFromOptions(options));
  return runtimeExecution.run({
    verified: true,
    executables: descriptor,
  }, callback);
}

function conventionalManagedRoot(repositoryPath) {
  const requested = path.resolve(String(repositoryPath || ""));
  let gitCommonDir = path.join(requested, ".git");
  if (path.basename(requested).toLowerCase() === ".git") gitCommonDir = requested;
  if (!fs.existsSync(gitCommonDir)) return "";
  const stat = fs.lstatSync(gitCommonDir);
  if (!stat.isDirectory() || stat.isSymbolicLink()) return "";
  return path.join(gitCommonDir, MANAGED_DIRNAME);
}

function manifestRuntimeExecutables(managedRoot) {
  const root = path.resolve(String(managedRoot || ""));
  const manifestPath = path.join(root, "manifest.json");
  const statePath = path.join(root, "state.json");
  if (!fs.existsSync(manifestPath) || !fs.existsSync(statePath)) return null;
  assertPlainTarget(root, manifestPath, {
    code: "BASE_PROTECTION_MANIFEST_UNSAFE",
  });
  assertPlainTarget(root, statePath, {
    code: "BASE_PROTECTION_STATE_UNSAFE",
  });
  const manifestBytes = fs.readFileSync(manifestPath);
  const state = readJson(statePath);
  if (
    !/^[0-9a-f]{64}$/.test(String(state.manifestSha256 || ""))
    || state.manifestSha256 !== sha256(manifestBytes)
  ) {
    throw Object.assign(new Error("Manifest hash has drifted before runtime selection"), {
      code: "BASE_PROTECTION_MANIFEST_HASH_DRIFT",
    });
  }
  const manifest = JSON.parse(manifestBytes.toString("utf8"));
  if (!samePath(root, manifest.paths?.managedRoot || "")) {
    throw Object.assign(new Error("Managed root does not match manifest"), {
      code: "BASE_PROTECTION_MANAGED_ROOT_MISMATCH",
    });
  }
  return verifyRuntimeExecutableDescriptor(manifest.runtimeExecutables);
}

function withRuntimeForRepository(repositoryPath, options, callback) {
  if (runtimeExecution.getStore()?.verified) return callback();
  const root = conventionalManagedRoot(repositoryPath);
  if (root) {
    const installed = manifestRuntimeExecutables(root);
    if (installed) return withVerifiedRuntimeExecutables(installed, callback);
  }
  return withRuntimeExecutablePaths(options, callback);
}

function withRuntimeForManagedRoot(managedRoot, callback) {
  if (runtimeExecution.getStore()?.verified) return callback();
  const descriptor = manifestRuntimeExecutables(managedRoot);
  if (!descriptor) {
    throw Object.assign(new Error("Managed runtime manifest is unavailable"), {
      code: "BASE_PROTECTION_MANIFEST_UNAVAILABLE",
    });
  }
  return withVerifiedRuntimeExecutables(descriptor, callback);
}

function normalizedManagementClientDescriptor(value) {
  if (!value || typeof value !== "object") return { type: "none" };
  if (value.type !== "command") {
    throw Object.assign(new Error("managementClient must use the fixed command transport"), {
      code: "BASE_PROTECTION_MANAGEMENT_CLIENT_INVALID",
    });
  }
  const executableValue = String(value.executable || "");
  const helperValue = String(value.helperPath || "");
  if (!path.isAbsolute(executableValue) || !path.isAbsolute(helperValue)) {
    throw Object.assign(
      new Error("managementClient executable and helper must be absolute paths"),
      { code: "BASE_PROTECTION_MANAGEMENT_CLIENT_INVALID" },
    );
  }
  const executable = path.resolve(executableValue);
  const helperPath = path.resolve(helperValue);
  assertPlainRegularFile(executable, {
    code: "BASE_PROTECTION_MANAGEMENT_CLIENT_UNSAFE",
  });
  assertPlainRegularFile(helperPath, {
    code: "BASE_PROTECTION_MANAGEMENT_CLIENT_UNSAFE",
  });
  const executableSecurity = fileSecurityAttestation(executable);
  const helperSecurity = fileSecurityAttestation(helperPath);
  return {
    type: "command",
    executable,
    executableSha256: fileHash(executable),
    helperPath,
    helperSha256: fileHash(helperPath),
    executableSecurity,
    helperSecurity,
    fixedArgs: Array.isArray(value.fixedArgs)
      ? value.fixedArgs.map((item) => String(item)).slice(0, 16)
      : [],
    timeoutMs: Math.max(1_000, Math.min(120_000, Number(value.timeoutMs) || 30_000)),
  };
}

function normalizedControllerOperationBinding(value) {
  if (value == null) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw Object.assign(new Error("controller operation binding must be an object"), {
      code: "BASE_PROTECTION_CONTROLLER_OPERATION_BINDING_INVALID",
    });
  }
  const binding = {
    schemaVersion: Number(value.schemaVersion),
    operationId: String(value.operationId || "").trim(),
    previewId: String(value.previewId || "").trim(),
    action: String(value.action || "").trim(),
    expectedHead: String(value.expectedHead || "").trim().toLowerCase(),
    candidateSha: String(value.candidateSha || "").trim().toLowerCase(),
    stateSignature: String(value.stateSignature || "").trim().toLowerCase(),
    validatorDigest: value.validatorDigest == null
      ? null
      : String(value.validatorDigest).trim().toLowerCase(),
    eligible: value.eligible === true,
  };
  const shaPattern = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
  if (
    binding.schemaVersion !== 1
    || !/^[A-Za-z0-9._:-]{1,200}$/.test(binding.operationId)
    || !/^[A-Za-z0-9._:-]{1,200}$/.test(binding.previewId)
    || !["install", "uninstall"].includes(binding.action)
    || !shaPattern.test(binding.expectedHead)
    || binding.candidateSha !== binding.expectedHead
    || !/^[0-9a-f]{64}$/.test(binding.stateSignature)
    || (
      binding.validatorDigest != null
      && !/^[0-9a-f]{64}$/.test(binding.validatorDigest)
    )
    || binding.eligible !== true
  ) {
    throw Object.assign(new Error("controller operation binding is incomplete or invalid"), {
      code: "BASE_PROTECTION_CONTROLLER_OPERATION_BINDING_INVALID",
    });
  }
  if (
    (binding.action === "install" && binding.validatorDigest == null)
    || (binding.action === "uninstall" && binding.validatorDigest != null)
  ) {
    throw Object.assign(new Error("controller operation binding validator does not match its action"), {
      code: "BASE_PROTECTION_CONTROLLER_OPERATION_BINDING_INVALID",
    });
  }
  return binding;
}

function installOptionBindingIssues(manifest, options, {
  compareOperationBinding = false,
} = {}) {
  const issues = [];
  let desiredValidator;
  let desiredManagementClient;
  let desiredOperationBinding = null;
  try {
    desiredValidator = normalizedValidatorDescriptor(
      options.capabilityValidatorDescriptor,
    );
    desiredManagementClient = normalizedManagementClientDescriptor(
      options.managementClientDescriptor,
    );
    if (compareOperationBinding) {
      desiredOperationBinding = normalizedControllerOperationBinding(
        options.controllerOperationBinding,
      );
    }
  } catch (error) {
    issues.push(`INSTALL_RECOVERY_DESCRIPTOR_INVALID:${error?.code || "UNKNOWN"}`);
  }
  if (String(manifest.controller?.repositoryId || "") !== String(options.repositoryId || "")) {
    issues.push("INSTALL_RECOVERY_REPOSITORY_ID_MISMATCH");
  }
  if (
    desiredValidator
    && JSON.stringify(manifest.capability?.validator || null)
      !== JSON.stringify(desiredValidator)
  ) {
    issues.push("INSTALL_RECOVERY_VALIDATOR_MISMATCH");
  }
  if (
    desiredManagementClient
    && JSON.stringify(manifest.controller?.managementClient || null)
      !== JSON.stringify(desiredManagementClient)
  ) {
    issues.push("INSTALL_RECOVERY_MANAGEMENT_CLIENT_MISMATCH");
  }
  if (
    compareOperationBinding
    && JSON.stringify(manifest.controller?.operationBinding || null)
      !== JSON.stringify(desiredOperationBinding)
  ) {
    issues.push("INSTALL_RECOVERY_OPERATION_BINDING_MISMATCH");
  }
  return issues;
}

function copyRuntimeAssets(paths, runtimeAssets) {
  if (!runtimeAssets?.core || !runtimeAssets?.manage) {
    throw Object.assign(new Error("缺少受管 hooks runtime 资产"), {
      code: "BASE_PROTECTION_RUNTIME_MISSING",
    });
  }
  const records = {};
  for (const [name, sourcePath] of Object.entries(runtimeAssets)) {
    if (!["core", "manage"].includes(name)) continue;
    const source = path.resolve(String(sourcePath || ""));
    const stat = fs.lstatSync(source);
    if (!stat.isFile() || stat.isSymbolicLink() || Number(stat.nlink || 1) !== 1) {
      throw Object.assign(new Error(`runtime 资产不是普通文件: ${source}`), {
        code: "BASE_PROTECTION_RUNTIME_UNSAFE",
      });
    }
    const target = path.join(paths.runtime, `${name}.mjs`);
    atomicWrite(target, fs.readFileSync(source), 0o755);
    records[name] = {
      path: safeRelativePath(paths.root, target),
      sha256: fileHash(target),
      mode: 0o755,
    };
  }
  return records;
}

function cleanupLegacyHooks(records) {
  for (const record of records) {
    if (!record.legacyManaged) continue;
    if (record.existed) {
      atomicWrite(record.sourcePath, Buffer.from(record.bytesBase64, "base64"), record.mode || 0o755);
    } else if (fs.existsSync(record.sourcePath)) {
      assertPlainRegularFile(record.sourcePath, {
        code: "BASE_PROTECTION_LEGACY_DRIFT",
      });
      const current = fs.readFileSync(record.sourcePath);
      if (!isStrictLegacyManagedHook(current, record.name)) {
        throw Object.assign(new Error(`旧 DevBench hook 已漂移，拒绝覆盖: ${record.sourcePath}`), {
          code: "BASE_PROTECTION_LEGACY_DRIFT",
        });
      }
      fs.rmSync(record.sourcePath, { force: true });
      fsyncDirectory(path.dirname(record.sourcePath));
    }
    if (record.legacyBackupPath && fs.existsSync(record.legacyBackupPath)) {
      assertPlainRegularFile(record.legacyBackupPath, {
        code: "BASE_PROTECTION_LEGACY_DRIFT",
      });
      const backupBytes = fs.readFileSync(record.legacyBackupPath);
      if (record.existed && sha256(backupBytes) !== record.sha256) {
        throw Object.assign(new Error(`旧 DevBench hook 备份已漂移: ${record.legacyBackupPath}`), {
          code: "BASE_PROTECTION_LEGACY_DRIFT",
        });
      }
      fs.rmSync(record.legacyBackupPath, { force: true });
      fsyncDirectory(path.dirname(record.legacyBackupPath));
    }
  }
}

function configValueMatches(current, expected) {
  if (!!current?.present !== !!expected?.present) return false;
  if (!current?.present) return true;
  return String(current.value) === String(expected.value);
}

function installRecoveryResult(repository, paths, manifest, state, {
  switchedHooksPath = false,
  options = {},
} = {}) {
  const issues = [];
  verifyManifestIdentity(repository, paths, manifest, state, issues);
  verifyManagedFiles(paths, manifest, issues);
  verifyOriginalRestorationTargets(manifest, issues);
  issues.push(...installOptionBindingIssues(manifest, options, {
    compareOperationBinding: true,
  }));
  if (issues.length) {
    return {
      status: "DRIFTED",
      idempotent: false,
      recovered: false,
      installed: [],
      backedUp: [],
      skipped: [...HOOK_NAMES],
      hooksDir: paths.hooks,
      managedRoot: paths.root,
      issues,
      error: "Interrupted managed hooks installation failed exact recovery verification",
      errorCode: "BASE_PROTECTION_INSTALL_RECOVERY_DRIFT",
    };
  }

  const currentLocal = readHooksPathConfig(repository.requested, true);
  const localManaged = currentLocal.present && samePath(
    path.isAbsolute(currentLocal.value)
      ? currentLocal.value
      : path.resolve(repository.repositoryRoot, currentLocal.value),
    paths.hooks,
  );
  if (!localManaged) {
    if (
      !configValueMatches(currentLocal, manifest.hooksPathBefore?.local)
      || !samePath(
        repository.effectiveHooksDir,
        manifest.hooksPathBefore?.effectiveDirectory || "",
      )
    ) {
      return {
        status: "DRIFTED",
        idempotent: false,
        recovered: false,
        installed: [],
        backedUp: [],
        skipped: [...HOOK_NAMES],
        hooksDir: paths.hooks,
        managedRoot: paths.root,
        issues: ["INSTALL_RECOVERY_HOOKS_PATH_DRIFT"],
        error: "core.hooksPath changed while managed hooks installation was interrupted",
        errorCode: "BASE_PROTECTION_INSTALL_RECOVERY_DRIFT",
      };
    }
    runGit(repository.requested, ["config", "--local", "core.hooksPath", paths.hooks]);
    switchedHooksPath = true;
  }

  const activeHooksDir = absoluteGitPath(
    repository.requested,
    ["--git-path", "hooks"],
    repository.requested,
  );
  if (!samePath(activeHooksDir, paths.hooks)) {
    return {
      status: "DRIFTED",
      idempotent: false,
      recovered: false,
      installed: [],
      backedUp: [],
      skipped: [...HOOK_NAMES],
      hooksDir: paths.hooks,
      managedRoot: paths.root,
      issues: ["INSTALL_RECOVERY_EFFECTIVE_HOOKS_PATH_DRIFT"],
      error: "Recovered core.hooksPath does not resolve to the managed hooks directory",
      errorCode: "BASE_PROTECTION_INSTALL_RECOVERY_DRIFT",
    };
  }

  cleanupLegacyHooks(
    HOOK_NAMES.map((hookName) => manifest.hooks?.[hookName]?.previous)
      .filter(Boolean),
  );
  writeState(repository, {
    status: "ACTIVE",
    operation: "install-recovery",
    recoveredAt: nowIso(),
    error: "",
  }, manifest);
  ensureActiveInstallationAudit(repository, manifest, {
    switchedHooksPath,
  });
  return {
    status: "ACTIVE",
    idempotent: true,
    recovered: true,
    installed: [...HOOK_NAMES],
    backedUp: HOOK_NAMES.filter(
      (hookName) => manifest.hooks?.[hookName]?.previous?.existed,
    ),
    skipped: [],
    hooksDir: paths.hooks,
    managedRoot: paths.root,
    manifestPath: paths.manifest,
    statePath: paths.state,
  };
}

function blockedExistingInstallationResult(repository, paths, {
  issues,
  error,
  errorCode = "BASE_PROTECTION_INSTALL_STATE_UNSAFE",
} = {}) {
  return {
    status: "DRIFTED",
    idempotent: false,
    recovered: false,
    installed: [],
    backedUp: [],
    skipped: [...HOOK_NAMES],
    hooksDir: paths.hooks,
    managedRoot: paths.root,
    issues: Array.isArray(issues) && issues.length
      ? issues
      : ["INSTALLATION_STATE_UNSAFE"],
    error: String(error || "Existing managed hooks state cannot be safely resumed"),
    errorCode,
  };
}

function installManagedHooksInternal(repositoryPath, options = {}) {
  let repository;
  let releaseLock = null;
  let switchedHooksPath = false;
  try {
    repository = resolveRepository(repositoryPath);
    const paths = installationPaths(repository);
    assertNoLinkedComponent(repository.gitCommonDir, paths.root);
    mkdirPlain(paths.root);
    for (const directory of [paths.hooks, paths.previousHooks, paths.runtime, paths.logs]) mkdirPlain(directory);
    releaseLock = acquireManageLock(repository, "install");

    const manifestExists = fs.existsSync(paths.manifest);
    const stateExists = fs.existsSync(paths.state);
    if (manifestExists || stateExists) {
      let existingManifest;
      let existingState;
      try {
        if (!manifestExists || !stateExists) {
          return blockedExistingInstallationResult(repository, paths, {
            issues: [
              manifestExists
                ? "INSTALLATION_STATE_MISSING"
                : "INSTALLATION_MANIFEST_MISSING",
            ],
            error: "Managed hooks manifest and state must either both exist or both be absent",
          });
        }
        existingManifest = readJson(paths.manifest);
        existingState = readJson(paths.state);
      } catch (error) {
        return blockedExistingInstallationResult(repository, paths, {
          issues: [`INSTALLATION_METADATA_INVALID:${error?.code || "UNKNOWN"}`],
          error: "Existing managed hooks metadata is unreadable",
          errorCode: "BASE_PROTECTION_INSTALL_METADATA_INVALID",
        });
      }
      if (existingManifest && existingState?.status === "INSTALLING") {
        return installRecoveryResult(repository, paths, existingManifest, existingState, {
          options,
          switchedHooksPath,
        });
      }
      if (existingManifest && existingState?.status === "ACTIVE") {
        const bindingIssues = installOptionBindingIssues(existingManifest, options, {
          compareOperationBinding: options.controllerOperationBinding != null,
        });
        const existingCheck = diagnoseManagedHooks(repositoryPath, {
          ignoreActivity: true,
          skipAuditProbe: true,
        });
        if (existingCheck.status === "ACTIVE" && bindingIssues.length === 0) {
          try {
            ensureActiveInstallationAudit(repository, existingManifest, {
              recoveredFromActiveState: true,
            });
          } catch (error) {
            return blockedExistingInstallationResult(repository, paths, {
              issues: [`ACTIVE_AUDIT_RECOVERY_FAILED:${error?.code || "UNKNOWN"}`],
              error: "Managed hooks are active but their local audit gap could not be repaired",
              errorCode: "BASE_PROTECTION_ACTIVE_AUDIT_RECOVERY_FAILED",
            });
          }
          return {
            status: "ACTIVE",
            idempotent: true,
            installed: [...HOOK_NAMES],
            backedUp: HOOK_NAMES.filter((name) => existingManifest.hooks?.[name]?.previous?.existed),
            skipped: [],
            hooksDir: repository.managedHooksDir,
            managedRoot: repository.managedRoot,
          };
        }
        return {
          status: "DRIFTED",
          idempotent: false,
          installed: [],
          backedUp: [],
          skipped: [...HOOK_NAMES],
          hooksDir: repository.managedHooksDir,
          managedRoot: repository.managedRoot,
          issues: [...(existingCheck.issues || []), ...bindingIssues],
          error: "现有受管 hooks 已漂移，拒绝覆盖",
        };
      }
      return blockedExistingInstallationResult(repository, paths, {
        issues: [
          `INSTALLATION_STATE_NOT_RECOVERABLE:${existingState?.status || "UNKNOWN"}`,
        ],
        error: "Existing managed hooks state is not an exact INSTALLING recovery or verified ACTIVE installation",
      });
    }

    writeState(repository, {
      status: "INSTALLING",
      operation: "install",
      error: "",
    });

    const previousHooks = {};
    for (const hookName of HOOK_NAMES) {
      previousHooks[hookName] = previousHookRecord(repository, paths, hookName);
    }

    const runtime = copyRuntimeAssets(paths, options.runtimeAssets);
    const runtimeExecutables = activeRuntimeExecutables();

    const hookRecords = {};
    for (const hookName of HOOK_NAMES) {
      const dispatcherPath = path.join(paths.hooks, hookName);
      const content = renderDispatcher(
        hookName,
        previousHooks[hookName],
        runtimeExecutables.node.path,
      );
      atomicWrite(dispatcherPath, content, 0o755);
      hookRecords[hookName] = {
        name: hookName,
        dispatcherPath: safeRelativePath(paths.root, dispatcherPath),
        dispatcherSha256: sha256(content),
        dispatcherMode: 0o755,
        previous: previousHooks[hookName],
      };
    }

    const launchers = {
      uninstallBat: {
        path: safeRelativePath(paths.root, paths.uninstallBat),
        content: renderBat(
          "hooks-uninstall --interactive",
          "DevBench 基础仓库 hooks - 安全卸载",
          runtimeExecutables.node.path,
          runtimeExecutables.systemTools.powershell?.path || "",
        ),
        mode: 0o644,
      },
      uninstallSh: {
        path: safeRelativePath(paths.root, paths.uninstallSh),
        content: renderSh("hooks-uninstall --interactive", runtimeExecutables.node.path),
        mode: 0o755,
      },
      diagnoseBat: {
        path: safeRelativePath(paths.root, paths.diagnoseBat),
        content: renderBat(
          "hooks-diagnose",
          "DevBench 基础仓库 hooks - 诊断",
          runtimeExecutables.node.path,
          runtimeExecutables.systemTools.powershell?.path || "",
        ),
        mode: 0o644,
      },
      diagnoseSh: {
        path: safeRelativePath(paths.root, paths.diagnoseSh),
        content: renderSh("hooks-diagnose", runtimeExecutables.node.path),
        mode: 0o755,
      },
    };
    for (const launcher of Object.values(launchers)) {
      const target = resolveManifestPath(paths.root, launcher.path);
      atomicWrite(target, launcher.content, launcher.mode);
      launcher.sha256 = sha256(launcher.content);
      delete launcher.content;
    }

    const manifest = {
      schemaVersion: MANIFEST_SCHEMA_VERSION,
      product: "devbench-base-protection",
      installationId: randomUUID(),
      installedAt: nowIso(),
      repository: {
        root: repository.repositoryRoot,
        gitCommonDir: repository.gitCommonDir,
        gitDir: repository.gitDir,
        objectFormat: repository.objectFormat,
        remoteFingerprint: repository.remoteFingerprint,
        fingerprint: repository.fingerprint,
      },
      paths: {
        managedRoot: paths.root,
        managedHooksDir: paths.hooks,
        manifest: safeRelativePath(paths.root, paths.manifest),
        state: safeRelativePath(paths.root, paths.state),
        audit: safeRelativePath(paths.root, repository.auditPath),
      },
      hooksPathBefore: {
        local: repository.localHooksPath,
        effective: repository.effectiveHooksPath,
        effectiveDirectory: repository.effectiveHooksDir,
      },
      hooks: hookRecords,
      runtime,
      runtimeExecutables,
      launchers,
      controller: {
        repositoryId: String(options.repositoryId || ""),
        managementClient: normalizedManagementClientDescriptor(
          options.managementClientDescriptor,
        ),
        operationBinding: normalizedControllerOperationBinding(
          options.controllerOperationBinding,
        ),
      },
      capability: {
        tokenEnvironment: CAPABILITY_ENV,
        controllerMutationEnvironment: CONTROLLER_MUTATION_ENV,
        validator: normalizedValidatorDescriptor(options.capabilityValidatorDescriptor),
        failClosed: true,
      },
    };

    atomicWriteJson(paths.manifest, manifest);
    writeState(repository, {
      status: "INSTALLING",
      operation: "switch-hooks-path",
      error: "",
    }, manifest);

    runGit(repository.requested, ["config", "--local", "core.hooksPath", paths.hooks]);
    switchedHooksPath = true;
    const activeHooksDir = absoluteGitPath(repository.requested, ["--git-path", "hooks"], repository.requested);
    if (!samePath(activeHooksDir, paths.hooks)) {
      throw Object.assign(new Error(`core.hooksPath 切换校验失败: ${activeHooksDir}`), {
        code: "BASE_PROTECTION_HOOKS_PATH_VERIFY_FAILED",
      });
    }

    cleanupLegacyHooks(Object.values(previousHooks));
    writeState(repository, {
      status: "ACTIVE",
      operation: "install",
      activatedAt: nowIso(),
      error: "",
    }, manifest);
    appendAudit(repository, {
      event: "HOOKS_INSTALLED",
      status: "ACTIVE",
      repositoryFingerprint: repository.fingerprint,
      installationId: manifest.installationId,
    });
    return {
      status: "ACTIVE",
      idempotent: false,
      installed: [...HOOK_NAMES],
      backedUp: HOOK_NAMES.filter((name) => previousHooks[name].existed),
      skipped: [],
      hooksDir: paths.hooks,
      managedRoot: paths.root,
      manifestPath: paths.manifest,
      statePath: paths.state,
    };
  } catch (error) {
    if (repository && error?.code !== "BASE_PROTECTION_LOCKED") {
      try {
        mkdirPlain(repository.managedRoot);
        writeState(repository, {
          status: "DEGRADED",
          operation: "install",
          error: String(error?.message || error),
          errorCode: String(error?.code || "BASE_PROTECTION_INSTALL_FAILED"),
          hooksPathSwitched: switchedHooksPath,
        });
        appendAudit(repository, {
          event: "HOOKS_INSTALL_FAILED",
          status: "DEGRADED",
          error: String(error?.message || error),
          errorCode: String(error?.code || "BASE_PROTECTION_INSTALL_FAILED"),
        });
      } catch {}
    }
    return {
      status: "DEGRADED",
      installed: [],
      backedUp: [],
      skipped: [...HOOK_NAMES],
      hooksDir: repository?.managedHooksDir || "",
      managedRoot: repository?.managedRoot || "",
      error: String(error?.message || error),
      errorCode: String(error?.code || "BASE_PROTECTION_INSTALL_FAILED"),
    };
  } finally {
    try { releaseLock?.(); } catch {}
  }
}

export function installManagedHooks(repositoryPath, options = {}) {
  try {
    return withRuntimeForRepository(repositoryPath, options, () => (
      installManagedHooksInternal(repositoryPath, options)
    ));
  } catch (error) {
    return {
      status: "DEGRADED",
      installed: [],
      backedUp: [],
      skipped: [...HOOK_NAMES],
      hooksDir: "",
      managedRoot: "",
      error: String(error?.message || error),
      errorCode: String(error?.code || "BASE_PROTECTION_RUNTIME_EXECUTABLES_UNSAFE"),
    };
  }
}

function currentInstallation(repositoryPath) {
  const repository = resolveRepository(repositoryPath);
  const paths = installationPaths(repository);
  assertNoLinkedComponent(repository.gitCommonDir, paths.root);
  if (!fs.existsSync(paths.manifest) || !fs.existsSync(paths.state)) {
    return { repository, paths, manifest: null, state: null };
  }
  assertPlainTarget(paths.root, paths.manifest, {
    code: "BASE_PROTECTION_MANIFEST_UNSAFE",
  });
  assertPlainTarget(paths.root, paths.state, {
    code: "BASE_PROTECTION_STATE_UNSAFE",
  });
  return {
    repository,
    paths,
    manifest: readJson(paths.manifest),
    state: readJson(paths.state),
  };
}

function activeLeaseDefault(paths) {
  throw Object.assign(
    new Error("An authenticated Git Controller lease query is required"),
    { code: "BASE_PROTECTION_CONTROLLER_LEASE_CHECK_REQUIRED" },
  );
}

function legacyWorktreeDefault(repository) {
  const output = runGit(repository.requested, ["worktree", "list", "--porcelain"]);
  const worktrees = output.split(/\r?\n/).filter((line) => line.startsWith("worktree "));
  if (worktrees.length < 1) {
    throw Object.assign(new Error("git worktree list returned no canonical worktree"), {
      code: "BASE_PROTECTION_LEGACY_WORKTREE_CHECK_INVALID",
    });
  }
  return worktrees.length > 1;
}

function callbackBoolean(callback, context, fallback) {
  if (typeof callback !== "function") return fallback();
  const result = callback(context);
  if (result && typeof result.then === "function") {
    throw Object.assign(new Error("安全预检回调必须是同步函数"), {
      code: "BASE_PROTECTION_ASYNC_CALLBACK_UNSUPPORTED",
    });
  }
  return typeof result === "object" ? !!result.active : !!result;
}

function auditWritable(repository, callback) {
  if (typeof callback === "function") {
    const result = callback({ repository });
    if (result && typeof result.then === "function") {
      throw Object.assign(new Error("审计预检回调必须是同步函数"), {
        code: "BASE_PROTECTION_ASYNC_CALLBACK_UNSUPPORTED",
      });
    }
    return result !== false;
  }
  try {
    mkdirPlain(path.dirname(repository.auditPath));
    assertNoLinkedComponent(repository.managedRoot, repository.auditPath);
    if (fs.existsSync(repository.auditPath)) {
      assertPlainRegularFile(repository.auditPath, {
        code: "BASE_PROTECTION_AUDIT_UNSAFE",
      });
    }
    const fd = fs.openSync(repository.auditPath, "a", 0o600);
    fs.closeSync(fd);
    return true;
  } catch {
    return false;
  }
}

function verifyManifestIdentity(repository, paths, manifest, state, issues) {
  if (manifest.schemaVersion !== MANIFEST_SCHEMA_VERSION) issues.push("MANIFEST_SCHEMA_MISMATCH");
  if (!samePath(manifest.paths?.managedRoot || "", paths.root)) issues.push("MANAGED_ROOT_MISMATCH");
  if (!samePath(manifest.paths?.managedHooksDir || "", paths.hooks)) issues.push("MANAGED_HOOKS_PATH_MISMATCH");
  if (manifest.repository?.fingerprint !== repository.fingerprint) issues.push("REPOSITORY_FINGERPRINT_MISMATCH");
  if (!samePath(manifest.repository?.gitCommonDir || "", repository.gitCommonDir)) issues.push("GIT_COMMON_DIR_MISMATCH");
  if (state?.manifestSha256 && state.manifestSha256 !== fileHash(paths.manifest)) issues.push("MANIFEST_HASH_DRIFT");
}

function verifyManifestFile(paths, record, issuePrefix, issues) {
  if (!record || typeof record !== "object" || !record.path || !record.sha256) {
    issues.push(`${issuePrefix}_RECORD_MISSING`);
    return null;
  }
  let target;
  try {
    target = resolveManifestPath(paths.root, record.path);
  } catch {
    issues.push(`${issuePrefix}_PATH_ESCAPE`);
    return null;
  }
  if (!fs.existsSync(target)) {
    issues.push(`${issuePrefix}_MISSING`);
    return target;
  }
  try {
    assertPlainTarget(paths.root, target);
  } catch {
    issues.push(`${issuePrefix}_UNSAFE`);
    return target;
  }
  if (fileHash(target) !== String(record.sha256)) {
    issues.push(`${issuePrefix}_HASH_DRIFT`);
  }
  return target;
}

function verifyManagedFiles(paths, manifest, issues) {
  try {
    const active = activeRuntimeExecutables();
    if (JSON.stringify(active) !== JSON.stringify(manifest.runtimeExecutables || {})) {
      issues.push("RUNTIME_EXECUTABLE_CONTEXT_MISMATCH");
    }
  } catch (error) {
    issues.push(String(error?.code || "RUNTIME_EXECUTABLES_UNSAFE"));
  }
  for (const hookName of HOOK_NAMES) {
    const hook = manifest.hooks?.[hookName];
    if (!hook) {
      issues.push(`HOOK_RECORD_MISSING:${hookName}`);
      continue;
    }
    let dispatcher;
    try {
      dispatcher = resolveManifestPath(paths.root, hook.dispatcherPath);
    } catch {
      issues.push(`DISPATCHER_PATH_ESCAPE:${hookName}`);
      continue;
    }
    if (!fs.existsSync(dispatcher)) issues.push(`DISPATCHER_MISSING:${hookName}`);
    else {
      try {
        assertPlainTarget(paths.root, dispatcher);
        if (fileHash(dispatcher) !== hook.dispatcherSha256) {
          issues.push(`DISPATCHER_HASH_DRIFT:${hookName}`);
        }
      } catch {
        issues.push(`DISPATCHER_UNSAFE:${hookName}`);
      }
    }

    const previous = hook.previous;
    if (previous?.existed) {
      let backup;
      try {
        backup = resolveManifestPath(paths.root, previous.backupPath);
      } catch {
        issues.push(`BACKUP_PATH_ESCAPE:${hookName}`);
        continue;
      }
      if (!fs.existsSync(backup)) issues.push(`BACKUP_MISSING:${hookName}`);
      else {
        try {
          assertPlainTarget(paths.root, backup);
          if (fileHash(backup) !== previous.sha256) {
            issues.push(`BACKUP_HASH_DRIFT:${hookName}`);
          } else if (fs.readFileSync(backup).toString("base64") !== previous.bytesBase64) {
            issues.push(`BACKUP_BYTES_DRIFT:${hookName}`);
          }
        } catch {
          issues.push(`BACKUP_UNSAFE:${hookName}`);
        }
      }
    }
  }
  for (const name of ["core", "manage"]) {
    verifyManifestFile(paths, manifest.runtime?.[name], `RUNTIME_${name.toUpperCase()}`, issues);
  }
  for (const requiredName of [
    "uninstallBat",
    "uninstallSh",
    "diagnoseBat",
    "diagnoseSh",
  ]) {
    if (!manifest.launchers?.[requiredName]) {
      issues.push(`LAUNCHER_RECORD_MISSING:${requiredName}`);
    }
  }
  for (const [name, launcher] of Object.entries(manifest.launchers || {})) {
    let target;
    try {
      target = resolveManifestPath(paths.root, launcher.path);
    } catch {
      issues.push(`LAUNCHER_PATH_ESCAPE:${name}`);
      continue;
    }
    if (!fs.existsSync(target)) issues.push(`LAUNCHER_MISSING:${name}`);
    else {
      try {
        assertPlainTarget(paths.root, target);
        if (fileHash(target) !== launcher.sha256) issues.push(`LAUNCHER_HASH_DRIFT:${name}`);
      } catch {
        issues.push(`LAUNCHER_UNSAFE:${name}`);
      }
    }
  }
  const managementClient = manifest.controller?.managementClient;
  if (managementClient?.type === "command") {
    for (const [label, targetValue, expectedHash, expectedSecurity] of [
      [
        "EXECUTABLE",
        managementClient.executable,
        managementClient.executableSha256,
        managementClient.executableSecurity,
      ],
      [
        "HELPER",
        managementClient.helperPath,
        managementClient.helperSha256,
        managementClient.helperSecurity,
      ],
    ]) {
      try {
        const target = path.resolve(String(targetValue || ""));
        if (!path.isAbsolute(String(targetValue || ""))) throw new Error("not absolute");
        assertPlainRegularFile(target, {
          code: "BASE_PROTECTION_MANAGEMENT_CLIENT_UNSAFE",
        });
        if (fileHash(target) !== String(expectedHash || "")) {
          issues.push(`MANAGEMENT_CLIENT_${label}_HASH_DRIFT`);
        }
        if (
          JSON.stringify(fileSecurityAttestation(target))
          !== JSON.stringify(expectedSecurity || {})
        ) {
          issues.push(`MANAGEMENT_CLIENT_${label}_ACL_DRIFT`);
        }
      } catch {
        issues.push(`MANAGEMENT_CLIENT_${label}_UNSAFE`);
      }
    }
  }
  const validator = manifest.capability?.validator;
  if (validator?.type === "module") {
    try {
      assertPlainRegularFile(validator.modulePath, {
        code: "BASE_PROTECTION_VALIDATOR_UNSAFE",
      });
      if (fileHash(validator.modulePath) !== String(validator.moduleSha256 || "")) {
        issues.push("CAPABILITY_VALIDATOR_HASH_DRIFT");
      }
    } catch {
      issues.push("CAPABILITY_VALIDATOR_UNSAFE");
    }
  } else if (validator?.type === "command") {
    try {
      assertPlainRegularFile(validator.executable, {
        code: "BASE_PROTECTION_VALIDATOR_UNSAFE",
      });
      if (fileHash(validator.executable) !== String(validator.executableSha256 || "")) {
        issues.push("CAPABILITY_VALIDATOR_HASH_DRIFT");
      }
      for (const record of validator.argFiles || []) {
        assertPlainRegularFile(record.path, {
          code: "BASE_PROTECTION_VALIDATOR_UNSAFE",
        });
        if (fileHash(record.path) !== String(record.sha256 || "")) {
          issues.push("CAPABILITY_VALIDATOR_ARG_HASH_DRIFT");
        }
      }
    } catch {
      issues.push("CAPABILITY_VALIDATOR_UNSAFE");
    }
  }
}

function verifyUninstalledState(repository, paths, manifest, state, issues) {
  verifyManifestIdentity(repository, paths, manifest, state, issues);
  for (const hookName of HOOK_NAMES) {
    const hook = manifest.hooks?.[hookName];
    if (!hook) {
      issues.push(`HOOK_RECORD_MISSING:${hookName}`);
      continue;
    }
    try {
      const dispatcher = resolveManifestPath(paths.root, hook.dispatcherPath);
      if (fs.existsSync(dispatcher)) {
        issues.push(`UNINSTALLED_DISPATCHER_REACTIVATED:${hookName}`);
      }
    } catch {
      issues.push(`DISPATCHER_PATH_ESCAPE:${hookName}`);
    }
  }
  if (fs.existsSync(paths.hooks)) {
    try {
      assertNoLinkedComponent(paths.root, paths.hooks);
      const residual = fs.readdirSync(paths.hooks);
      if (residual.length) {
        issues.push(`UNINSTALLED_MANAGED_HOOKS_RESIDUAL:${residual.sort().join(",")}`);
      }
    } catch {
      issues.push("UNINSTALLED_MANAGED_HOOKS_UNSAFE");
    }
  }
  const supportIssues = [];
  verifyManagedFiles(paths, manifest, supportIssues);
  issues.push(...supportIssues.filter(
    (issue) => !String(issue).startsWith("DISPATCHER_MISSING:"),
  ));
  const currentLocal = readHooksPathConfig(repository.requested, true);
  if (currentLocal.present) {
    const currentValue = path.isAbsolute(currentLocal.value)
      ? currentLocal.value
      : path.resolve(repository.repositoryRoot, currentLocal.value);
    if (samePath(currentValue, paths.hooks)) {
      issues.push("UNINSTALLED_HOOKS_PATH_REACTIVATED");
    }
  }
  const effectiveDir = absoluteGitPath(
    repository.requested,
    ["--git-path", "hooks"],
    repository.requested,
  );
  if (samePath(effectiveDir, paths.hooks)) {
    issues.push("UNINSTALLED_EFFECTIVE_HOOKS_REACTIVATED");
  }
}

function uninstallPreviewInternal(repositoryPath, options = {}) {
  let installation;
  try {
    installation = currentInstallation(repositoryPath);
  } catch (error) {
    return {
      status: "DRIFTED",
      canUninstall: false,
      issues: [`REPOSITORY_UNAVAILABLE:${error.message}`],
      error: error.message,
    };
  }
  const { repository, paths, manifest, state } = installation;
  if (!manifest || !state) {
    const local = repository.localHooksPath;
    const managedActive = local.present && samePath(
      path.isAbsolute(local.value) ? local.value : path.resolve(repository.repositoryRoot, local.value),
      paths.hooks,
    );
    return managedActive
      ? { status: "DRIFTED", canUninstall: false, issues: ["MANIFEST_MISSING_WITH_MANAGED_HOOKS_PATH"] }
      : { status: "ALREADY_UNINSTALLED", canUninstall: true, issues: [] };
  }
  const issues = [];
  try {
    assertNoLinkedComponent(repository.gitCommonDir, paths.root);
  } catch (error) {
    issues.push(`MANAGED_ROOT_ESCAPE:${error.message}`);
  }
  if (state.status === "UNINSTALLED") {
    verifyUninstalledState(repository, paths, manifest, state, issues);
    return issues.length
      ? {
          status: "DRIFTED",
          canUninstall: false,
          issues,
          managedRoot: paths.root,
          hooksDir: paths.hooks,
        }
      : {
          status: "ALREADY_UNINSTALLED",
          canUninstall: true,
          issues: [],
          managedRoot: paths.root,
          hooksDir: paths.hooks,
        };
  }
  if (state.status === "UNINSTALLING") {
    verifyManifestIdentity(repository, paths, manifest, state, issues);
    verifyManagedFiles(paths, manifest, issues);
    verifyOriginalRestorationTargets(manifest, issues);
    const unsafeIssues = issues.filter(
      (issue) => !String(issue).startsWith("DISPATCHER_MISSING:"),
    );
    if (unsafeIssues.length) {
      return {
        status: "DRIFTED",
        canUninstall: false,
        issues: unsafeIssues,
        managedRoot: paths.root,
        hooksDir: paths.hooks,
      };
    }
    return {
      status: "RECOVERY_REQUIRED",
      canUninstall: true,
      issues: ["UNINSTALL_JOURNAL_RECOVERY_REQUIRED"],
      managedRoot: paths.root,
      hooksDir: paths.hooks,
    };
  }
  if (state.status !== "ACTIVE") {
    issues.push(`INSTALLATION_STATE_NOT_ACTIVE:${state.status || "UNKNOWN"}`);
  }
  verifyManifestIdentity(repository, paths, manifest, state, issues);
  verifyManagedFiles(paths, manifest, issues);
  verifyOriginalRestorationTargets(manifest, issues);

  const currentLocal = readHooksPathConfig(repository.requested, true);
  if (!currentLocal.present) issues.push("LOCAL_HOOKS_PATH_NOT_MANAGED");
  else {
    const currentValue = path.isAbsolute(currentLocal.value)
      ? currentLocal.value
      : path.resolve(repository.repositoryRoot, currentLocal.value);
    if (!samePath(currentValue, paths.hooks)) issues.push("LOCAL_HOOKS_PATH_DRIFT");
  }
  const currentEffectiveDir = absoluteGitPath(repository.requested, ["--git-path", "hooks"], repository.requested);
  if (!samePath(currentEffectiveDir, paths.hooks)) issues.push("EFFECTIVE_HOOKS_PATH_DRIFT");

  if (!options.ignoreActivity) {
    let leaseActive = false;
    let legacyActive = false;
    try {
      leaseActive = callbackBoolean(
        options.activeLeaseCheck,
        { repository, manifest, state },
        () => activeLeaseDefault(paths),
      );
    } catch (error) {
      issues.push(`ACTIVE_LEASE_CHECK_FAILED:${error.message}`);
    }
    try {
      legacyActive = callbackBoolean(
        options.legacyLinkedWorktreeCheck,
        { repository, manifest, state },
        () => legacyWorktreeDefault(repository),
      );
    } catch (error) {
      issues.push(`LEGACY_WORKTREE_CHECK_FAILED:${error.message}`);
    }
    if (leaseActive) issues.push("ACTIVE_REPOSITORY_LEASE");
    if (legacyActive && options.allowLegacyLinkedWorktree !== true) issues.push("ACTIVE_LEGACY_LINKED_WORKTREE");
  }
  if (!options.skipAuditProbe && !auditWritable(repository, options.auditWritableCheck)) {
    issues.push("AUDIT_NOT_WRITABLE");
  }

  if (issues.length) {
    return {
      status: "DRIFTED",
      canUninstall: false,
      issues,
      managedRoot: paths.root,
      hooksDir: paths.hooks,
    };
  }
  return {
    status: "READY",
    canUninstall: true,
    issues: [],
    managedRoot: paths.root,
    hooksDir: paths.hooks,
    repositoryFingerprint: repository.fingerprint,
  };
}

export function uninstallPreview(repositoryPath, options = {}) {
  try {
    return withRuntimeForRepository(repositoryPath, options, () => (
      uninstallPreviewInternal(repositoryPath, options)
    ));
  } catch (error) {
    return {
      status: "DRIFTED",
      canUninstall: false,
      issues: [String(error?.code || "BASE_PROTECTION_RUNTIME_EXECUTABLES_UNSAFE")],
      error: String(error?.message || error),
    };
  }
}

function restoreHooksPath(repository, manifest) {
  const before = manifest.hooksPathBefore?.local || { present: false };
  const currentBeforeMutation = readHooksPathConfig(repository.requested, true);
  const managedValue = manifest.paths?.managedHooksDir || "";
  const currentValue = currentBeforeMutation.present
    ? (
        path.isAbsolute(currentBeforeMutation.value)
          ? currentBeforeMutation.value
          : path.resolve(repository.repositoryRoot, currentBeforeMutation.value)
      )
    : "";
  const alreadyRestored = configValueMatches(currentBeforeMutation, before);
  if (!alreadyRestored && (
    !currentBeforeMutation.present
    || !samePath(currentValue, managedValue)
  )) {
    throw Object.assign(
      new Error("core.hooksPath changed to an unknown value during uninstall"),
      { code: "BASE_PROTECTION_HOOKS_PATH_DRIFT" },
    );
  }
  if (alreadyRestored) return;
  if (before.present) {
    runGit(repository.requested, ["config", "--local", "core.hooksPath", String(before.value)]);
  } else {
    runGit(repository.requested, ["config", "--local", "--unset-all", "core.hooksPath"], { allowFailure: true });
  }
  const current = readHooksPathConfig(repository.requested, true);
  if (!configValueMatches(current, before)) {
    throw Object.assign(new Error("恢复安装前 local core.hooksPath 失败"), {
      code: "BASE_PROTECTION_HOOKS_PATH_RESTORE_FAILED",
    });
  }
  const expectedDir = manifest.hooksPathBefore?.effectiveDirectory || "";
  const actualDir = absoluteGitPath(repository.requested, ["--git-path", "hooks"], repository.requested);
  const actualCanonical = canonicalTarget(actualDir);
  if (expectedDir && !samePath(actualCanonical, expectedDir)) {
    throw Object.assign(new Error(`恢复后的有效 hooksPath 与安装前不一致: ${actualDir}`), {
      code: "BASE_PROTECTION_EFFECTIVE_HOOKS_PATH_DRIFT",
    });
  }
}

function originalHookTarget(manifest, hookName) {
  const directoryValue = String(
    manifest.hooksPathBefore?.effectiveDirectory || "",
  );
  if (!directoryValue || !path.isAbsolute(directoryValue)) {
    throw Object.assign(new Error("Original hooks directory is not absolute"), {
      code: "BASE_PROTECTION_ORIGINAL_HOOK_PATH_INVALID",
    });
  }
  const hooksDirectory = path.resolve(directoryValue);
  if (!samePath(canonicalTarget(hooksDirectory), hooksDirectory)) {
    throw Object.assign(new Error("Original hooks directory resolves through a link or junction"), {
      code: "BASE_PROTECTION_ORIGINAL_HOOK_PATH_ESCAPE",
    });
  }
  const target = path.join(hooksDirectory, hookName);
  assertNoLinkedComponent(hooksDirectory, target);
  return { hooksDirectory, target };
}

function verifyOriginalRestorationTargets(manifest, issues) {
  for (const hookName of HOOK_NAMES) {
    const previous = manifest.hooks?.[hookName]?.previous;
    if (!previous?.existed) continue;
    try {
      const { target } = originalHookTarget(manifest, hookName);
      if (!samePath(previous.sourcePath || "", target)) {
        issues.push(`ORIGINAL_TARGET_PATH_MISMATCH:${hookName}`);
        continue;
      }
      if (!fs.existsSync(target)) continue;
      assertPlainRegularFile(target, {
        code: "BASE_PROTECTION_ORIGINAL_HOOK_UNSAFE",
      });
      if (fileHash(target) !== String(previous.sha256 || "")) {
        issues.push(`ORIGINAL_TARGET_DRIFT:${hookName}`);
      } else if ((fs.statSync(target).mode & 0o777) !== Number(previous.mode)) {
        issues.push(`ORIGINAL_TARGET_MODE_DRIFT:${hookName}`);
      }
    } catch (error) {
      issues.push(`ORIGINAL_TARGET_UNSAFE:${hookName}:${error.code || "UNKNOWN"}`);
    }
  }
}

function readUninstallJournal(paths, manifest, { allowMissing = true } = {}) {
  if (!fs.existsSync(paths.uninstallJournal)) {
    if (allowMissing) return null;
    throw Object.assign(new Error("Uninstall journal is missing"), {
      code: "BASE_PROTECTION_UNINSTALL_JOURNAL_MISSING",
    });
  }
  assertPlainTarget(paths.root, paths.uninstallJournal, {
    code: "BASE_PROTECTION_UNINSTALL_JOURNAL_UNSAFE",
  });
  const journal = readJson(paths.uninstallJournal);
  if (
    journal?.schemaVersion !== 1
    || journal?.installationId !== manifest.installationId
    || journal?.manifestSha256 !== fileHash(paths.manifest)
    || typeof journal?.operationId !== "string"
    || !journal.operationId
  ) {
    throw Object.assign(new Error("Uninstall journal identity does not match the installation"), {
      code: "BASE_PROTECTION_UNINSTALL_JOURNAL_MISMATCH",
    });
  }
  return journal;
}

function writeUninstallJournal(paths, journal) {
  const next = { ...journal, updatedAt: nowIso() };
  atomicWriteJson(paths.uninstallJournal, next);
  return next;
}

function assertUninstallJournalControllerBinding(journal, options = {}) {
  const expected = normalizedControllerOperationBinding(
    options.controllerOperationBinding,
  );
  if (
    JSON.stringify(journal?.controllerOperationBinding || null)
    !== JSON.stringify(expected)
  ) {
    throw Object.assign(
      new Error("Uninstall journal is not bound to the requesting Controller operation"),
      { code: "BASE_PROTECTION_UNINSTALL_OPERATION_BINDING_MISMATCH" },
    );
  }
}

function advanceUninstallJournal(paths, journal, phase, patch, options) {
  const next = writeUninstallJournal(paths, {
    ...journal,
    ...patch,
    status: "IN_PROGRESS",
    phase,
  });
  if (typeof options.phaseHook === "function") {
    try {
      options.phaseHook({ operationId: next.operationId, phase });
    } catch (cause) {
      throw Object.assign(new Error(`Uninstall interrupted after ${phase}`), {
        code: "BASE_PROTECTION_UNINSTALL_INTERRUPTED",
        cause,
      });
    }
  }
  return next;
}

function assertUninstallActivitySafe(repository, manifest, state, options) {
  let active;
  try {
    active = callbackBoolean(
      options.activeLeaseCheck,
      { repository, manifest, state },
      () => activeLeaseDefault(),
    );
  } catch (cause) {
    throw Object.assign(new Error("Authenticated Controller lease check failed"), {
      code: "BASE_PROTECTION_CONTROLLER_LEASE_CHECK_FAILED",
      cause,
    });
  }
  if (active) {
    throw Object.assign(new Error("Repository has an active Controller lease"), {
      code: "BASE_PROTECTION_ACTIVE_REPOSITORY_LEASE",
    });
  }
  let legacyActive;
  try {
    legacyActive = callbackBoolean(
      options.legacyLinkedWorktreeCheck,
      { repository, manifest, state },
      () => legacyWorktreeDefault(repository),
    );
  } catch (cause) {
    throw Object.assign(new Error("Legacy worktree check failed"), {
      code: "BASE_PROTECTION_LEGACY_WORKTREE_CHECK_FAILED",
      cause,
    });
  }
  if (legacyActive && options.allowLegacyLinkedWorktree !== true) {
    throw Object.assign(new Error("Legacy linked worktrees are still active"), {
      code: "BASE_PROTECTION_ACTIVE_LEGACY_LINKED_WORKTREE",
    });
  }
  if (!auditWritable(repository, options.auditWritableCheck)) {
    throw Object.assign(new Error("Audit storage is not writable"), {
      code: "BASE_PROTECTION_AUDIT_NOT_WRITABLE",
    });
  }
}

function restoreOriginalHooks(paths, manifest, journal, options) {
  let next = journal;
  const restored = new Set(Array.isArray(next.restored) ? next.restored : []);
  for (const hookName of HOOK_NAMES) {
    const previous = manifest.hooks?.[hookName]?.previous;
    if (!previous?.existed) continue;
    const { hooksDirectory, target } = originalHookTarget(manifest, hookName);
    if (!samePath(previous.sourcePath || "", target)) {
      throw Object.assign(new Error(`Original hook target mismatch: ${hookName}`), {
        code: "BASE_PROTECTION_ORIGINAL_HOOK_PATH_MISMATCH",
      });
    }
    if (!fs.existsSync(hooksDirectory)) {
      throw Object.assign(new Error(`Original hooks directory is missing: ${hookName}`), {
        code: "BASE_PROTECTION_ORIGINAL_HOOK_DIRECTORY_MISSING",
      });
    }
    const backup = resolveManifestPath(paths.root, previous.backupPath);
    assertPlainTarget(paths.root, backup, {
      code: "BASE_PROTECTION_ORIGINAL_HOOK_BACKUP_UNSAFE",
    });
    const bytes = fs.readFileSync(backup);
    if (
      sha256(bytes) !== previous.sha256
      || bytes.toString("base64") !== previous.bytesBase64
    ) {
      throw Object.assign(new Error(`Original hook backup drifted: ${hookName}`), {
        code: "BASE_PROTECTION_ORIGINAL_HOOK_BACKUP_DRIFT",
      });
    }
    if (fs.existsSync(target)) {
      assertPlainRegularFile(target, {
        code: "BASE_PROTECTION_ORIGINAL_HOOK_UNSAFE",
      });
      if (fileHash(target) !== previous.sha256) {
        throw Object.assign(new Error(`Original hook target changed: ${hookName}`), {
          code: "BASE_PROTECTION_ORIGINAL_HOOK_TARGET_DRIFT",
        });
      }
      if ((fs.statSync(target).mode & 0o777) !== Number(previous.mode)) {
        throw Object.assign(new Error(`Original hook mode changed: ${hookName}`), {
          code: "BASE_PROTECTION_ORIGINAL_HOOK_MODE_DRIFT",
        });
      }
    }
    atomicWrite(target, bytes, Number(previous.mode) || 0o600);
    restored.add(hookName);
    next = advanceUninstallJournal(paths, next, `ORIGINAL_RESTORED:${hookName}`, {
      restored: [...restored].sort(),
    }, options);
  }
  return next;
}

function removeManagedDispatchers(paths, manifest, journal, options) {
  let next = journal;
  const removed = new Set(Array.isArray(next.removed) ? next.removed : []);
  for (const hookName of HOOK_NAMES) {
    const hook = manifest.hooks?.[hookName];
    if (!hook) continue;
    const dispatcher = resolveManifestPath(paths.root, hook.dispatcherPath);
    if (fs.existsSync(dispatcher)) {
      assertPlainTarget(paths.root, dispatcher, {
        code: "BASE_PROTECTION_UNINSTALL_DISPATCHER_UNSAFE",
      });
      if (fileHash(dispatcher) !== hook.dispatcherSha256) {
        throw Object.assign(new Error(`Managed dispatcher drifted: ${hookName}`), {
          code: "BASE_PROTECTION_UNINSTALL_DISPATCHER_DRIFT",
        });
      }
      fs.rmSync(dispatcher, { force: true });
      fsyncDirectory(path.dirname(dispatcher));
    }
    removed.add(hookName);
    next = advanceUninstallJournal(paths, next, `DISPATCHER_REMOVED:${hookName}`, {
      removed: [...removed].sort(),
    }, options);
  }
  try {
    if (fs.existsSync(paths.hooks) && fs.readdirSync(paths.hooks).length === 0) {
      fs.rmdirSync(paths.hooks);
      fsyncDirectory(path.dirname(paths.hooks));
    }
  } catch {}
  return next;
}

function uninstallAuditExists(repository, operationId) {
  if (!fs.existsSync(repository.auditPath)) return false;
  assertPlainRegularFile(repository.auditPath, {
    code: "BASE_PROTECTION_AUDIT_UNSAFE",
  });
  return fs.readFileSync(repository.auditPath, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .some((line) => {
      try {
        const event = JSON.parse(line);
        return event.event === "HOOKS_UNINSTALLED" && event.operationId === operationId;
      } catch {
        return false;
      }
    });
}

function executeUninstallTransaction(installation, options, existingJournal = null) {
  const {
    repository,
    paths,
    manifest,
    state,
  } = installation;
  if (existingJournal) {
    assertUninstallJournalControllerBinding(existingJournal, options);
    const recoveryIssues = [];
    verifyManifestIdentity(repository, paths, manifest, state, recoveryIssues);
    verifyManagedFiles(paths, manifest, recoveryIssues);
    verifyOriginalRestorationTargets(manifest, recoveryIssues);
    const unsafeIssues = recoveryIssues.filter(
      (issue) => !String(issue).startsWith("DISPATCHER_MISSING:"),
    );
    if (unsafeIssues.length) {
      throw Object.assign(
        new Error(`Uninstall recovery integrity failed: ${unsafeIssues.join(",")}`),
        {
          code: "BASE_PROTECTION_UNINSTALL_RECOVERY_DRIFT",
          issues: unsafeIssues,
        },
      );
    }
  }
  assertUninstallActivitySafe(repository, manifest, state, options);
  let journal = existingJournal || {
    schemaVersion: 1,
    operationId: randomUUID(),
    installationId: manifest.installationId,
    manifestSha256: fileHash(paths.manifest),
    status: "IN_PROGRESS",
    phase: "PREPARED",
    createdAt: nowIso(),
    restored: [],
    removed: [],
    controllerOperationBinding: normalizedControllerOperationBinding(
      options.controllerOperationBinding,
    ),
  };
  if (!existingJournal) {
    journal = advanceUninstallJournal(paths, journal, "PREPARED", {}, options);
  }
  writeState(repository, {
    status: "UNINSTALLING",
    operation: "uninstall",
    operationId: journal.operationId,
    phase: journal.phase,
    error: "",
  }, manifest);
  journal = advanceUninstallJournal(paths, journal, "STATE_UNINSTALLING", {}, options);
  journal = restoreOriginalHooks(paths, manifest, journal, options);
  journal = advanceUninstallJournal(paths, journal, "ORIGINAL_HOOKS_RESTORED", {}, options);
  restoreHooksPath(repository, manifest);
  journal = advanceUninstallJournal(paths, journal, "HOOKS_PATH_RESTORED", {}, options);
  journal = removeManagedDispatchers(paths, manifest, journal, options);
  journal = advanceUninstallJournal(paths, journal, "DISPATCHERS_REMOVED", {}, options);

  const postIssues = [];
  verifyUninstalledState(repository, paths, manifest, {
    manifestSha256: fileHash(paths.manifest),
  }, postIssues);
  verifyOriginalRestorationTargets(manifest, postIssues);
  if (postIssues.length) {
    throw Object.assign(new Error(`Uninstall postcondition failed: ${postIssues.join(",")}`), {
      code: "BASE_PROTECTION_UNINSTALL_POSTCONDITION_DRIFT",
      issues: postIssues,
    });
  }
  writeState(repository, {
    status: "UNINSTALLED",
    operation: "uninstall",
    operationId: journal.operationId,
    uninstalledAt: nowIso(),
    error: "",
  }, manifest);
  journal = advanceUninstallJournal(paths, journal, "STATE_UNINSTALLED", {}, options);
  if (!uninstallAuditExists(repository, journal.operationId)) {
    appendAudit(repository, {
      event: "HOOKS_UNINSTALLED",
      status: "UNINSTALLED",
      operationId: journal.operationId,
      repositoryFingerprint: repository.fingerprint,
      installationId: manifest.installationId,
      removed: journal.removed,
      restored: journal.restored,
    });
  }
  journal = writeUninstallJournal(paths, {
    ...journal,
    status: "COMPLETED",
    phase: "COMPLETED",
    completedAt: nowIso(),
  });
  return {
    status: "UNINSTALLED",
    canUninstall: true,
    issues: [],
    removed: [...journal.removed],
    restored: [...journal.restored],
    managedRoot: paths.root,
    hooksDir: paths.hooks,
    operationId: journal.operationId,
    recovered: !!existingJournal,
  };
}

function uninstallManagedHooksInternal(repositoryPath, options = {}) {
  let installation;
  try {
    installation = currentInstallation(repositoryPath);
  } catch (error) {
    return {
      status: "DRIFTED",
      canUninstall: false,
      issues: [String(error?.code || "BASE_PROTECTION_REPOSITORY_UNAVAILABLE")],
      error: String(error?.message || error),
      removed: [],
      restored: [],
    };
  }
  const {
    repository,
    paths,
    manifest,
    state,
  } = installation;
  if (!manifest || !state) {
    const initial = uninstallPreview(repositoryPath, options);
    return { ...initial, removed: [], restored: [] };
  }
  let releaseLock;
  let journal = null;
  try {
    releaseLock = acquireManageLock(repository, "uninstall");
    journal = readUninstallJournal(paths, manifest);
    if (journal?.status === "COMPLETED") {
      assertUninstallJournalControllerBinding(journal, options);
      const checked = uninstallPreview(repositoryPath, options);
      return { ...checked, removed: [], restored: [] };
    }
    if (!journal) {
      const checked = uninstallPreview(repositoryPath, options);
      if (checked.status === "ALREADY_UNINSTALLED" || checked.status === "DRIFTED") {
        return { ...checked, removed: [], restored: [] };
      }
      if (checked.status !== "READY") {
        return { ...checked, removed: [], restored: [] };
      }
    }
    return executeUninstallTransaction(installation, options, journal);
  } catch (error) {
    const errorCode = String(error?.code || "BASE_PROTECTION_UNINSTALL_FAILED");
    const blocked = /(?:DRIFT|UNSAFE|ESCAPE|MISMATCH|ACTIVE(?:_|$)|NOT_WRITABLE|NOT_PLAIN|INVALID|LOCKED)/.test(errorCode);
    const preMutationBlock = !releaseLock && !journal;
    try {
      const persistedJournal = readUninstallJournal(paths, manifest);
      if (persistedJournal) {
        journal = writeUninstallJournal(paths, {
          ...persistedJournal,
          status: blocked ? "BLOCKED" : "RECOVERY_REQUIRED",
          lastError: {
            code: errorCode,
            message: String(error?.message || error).slice(0, 500),
          },
        });
      }
      if (!preMutationBlock) {
        writeState(repository, {
          status: blocked ? "DRIFTED" : "UNINSTALLING",
          operation: "uninstall",
          error: String(error?.message || error),
          errorCode,
        }, manifest);
      }
      appendAudit(repository, {
        event: "HOOKS_UNINSTALL_FAILED",
        status: blocked ? "DRIFTED" : "RECOVERY_REQUIRED",
        error: String(error?.message || error),
        errorCode,
        operationId: journal?.operationId || null,
      });
    } catch {}
    return {
      status: blocked ? "DRIFTED" : "RECOVERY_REQUIRED",
      canUninstall: !blocked,
      issues: [errorCode],
      error: String(error?.message || error),
      removed: Array.isArray(journal?.removed) ? journal.removed : [],
      restored: Array.isArray(journal?.restored) ? journal.restored : [],
      operationId: journal?.operationId || null,
    };
  } finally {
    try { releaseLock?.(); } catch {}
  }
}

export function uninstallManagedHooks(repositoryPath, options = {}) {
  try {
    return withRuntimeForRepository(repositoryPath, options, () => (
      uninstallManagedHooksInternal(repositoryPath, options)
    ));
  } catch (error) {
    return {
      status: "DRIFTED",
      canUninstall: false,
      issues: [String(error?.code || "BASE_PROTECTION_RUNTIME_EXECUTABLES_UNSAFE")],
      error: String(error?.message || error),
      removed: [],
      restored: [],
    };
  }
}

export function diagnoseManagedHooks(repositoryPath, options = {}) {
  const preview = uninstallPreview(repositoryPath, {
    ...options,
    ignoreActivity: true,
  });
  if (preview.status === "READY") return { ...preview, status: "ACTIVE" };
  return preview;
}

export function diagnoseManagedRoot(managedRoot, options = {}) {
  if (!runtimeExecution.getStore()?.verified) {
    try {
      return withRuntimeForManagedRoot(managedRoot, () => (
        diagnoseManagedRoot(managedRoot, options)
      ));
    } catch (error) {
      return {
        status: "DRIFTED",
        canUninstall: false,
        issues: [String(error?.code || "BASE_PROTECTION_RUNTIME_EXECUTABLES_UNSAFE")],
        error: String(error?.message || error),
      };
    }
  }
  try {
    const root = path.resolve(String(managedRoot || ""));
    const manifestPath = path.join(root, "manifest.json");
    assertPlainTarget(root, manifestPath, {
      code: "BASE_PROTECTION_MANIFEST_UNSAFE",
    });
    const manifest = readJson(manifestPath);
    if (!samePath(root, manifest.paths?.managedRoot || "")) {
      throw Object.assign(new Error("Managed root does not match manifest"), {
        code: "BASE_PROTECTION_MANAGED_ROOT_MISMATCH",
      });
    }
    return diagnoseManagedHooks(String(manifest.repository?.root || ""), options);
  } catch (error) {
    return {
      status: "DRIFTED",
      canUninstall: false,
      issues: [String(error?.code || "MANIFEST_UNAVAILABLE")],
      error: String(error?.message || error),
    };
  }
}

export function invokeStandaloneController(managedRoot, operationValue, {
  launcher = "",
} = {}) {
  const operation = String(operationValue || "");
  if (operation !== "uninstall") {
    return {
      status: "CONTROLLER_REJECTED",
      canUninstall: false,
      issues: ["STANDALONE_OPERATION_NOT_ALLOWED"],
    };
  }
  if (!runtimeExecution.getStore()?.verified) {
    try {
      return withRuntimeForManagedRoot(managedRoot, () => (
        invokeStandaloneController(managedRoot, operationValue, { launcher })
      ));
    } catch (error) {
      return {
        status: "CONTROLLER_UNAVAILABLE",
        canUninstall: false,
        issues: [String(error?.code || "BASE_PROTECTION_RUNTIME_EXECUTABLES_UNSAFE")],
        error: String(error?.message || error),
      };
    }
  }
  try {
    const root = path.resolve(String(managedRoot || ""));
    const manifestPath = path.join(root, "manifest.json");
    const statePath = path.join(root, "state.json");
    assertPlainTarget(root, manifestPath, {
      code: "BASE_PROTECTION_MANIFEST_UNSAFE",
    });
    assertPlainTarget(root, statePath, {
      code: "BASE_PROTECTION_STATE_UNSAFE",
    });
    const manifest = readJson(manifestPath);
    const state = readJson(statePath);
    if (!samePath(root, manifest.paths?.managedRoot || "")) {
      throw Object.assign(new Error("Managed root does not match manifest"), {
        code: "BASE_PROTECTION_MANAGED_ROOT_MISMATCH",
      });
    }
    if (state.manifestSha256 !== fileHash(manifestPath)) {
      throw Object.assign(new Error("Manifest hash has drifted"), {
        code: "BASE_PROTECTION_MANIFEST_HASH_DRIFT",
      });
    }
    const paths = {
      root,
      runtime: path.join(root, "runtime"),
    };
    const runtimeIssues = [];
    for (const name of ["core", "manage"]) {
      verifyManifestFile(
        paths,
        manifest.runtime?.[name],
        `RUNTIME_${name.toUpperCase()}`,
        runtimeIssues,
      );
    }
    for (const [name, record] of Object.entries(manifest.launchers || {})) {
      verifyManifestFile(
        paths,
        record,
        `LAUNCHER_${name.toUpperCase()}`,
        runtimeIssues,
      );
    }
    if (runtimeIssues.length) {
      throw Object.assign(new Error(runtimeIssues.join(",")), {
        code: runtimeIssues[0],
      });
    }
    const descriptor = manifest.controller?.managementClient;
    if (!descriptor || descriptor.type !== "command") {
      throw Object.assign(new Error("Authenticated Controller helper is not configured"), {
        code: "BASE_PROTECTION_CONTROLLER_UNAVAILABLE",
      });
    }
    for (const [target, expectedHash, expectedSecurity] of [
      [
        descriptor.executable,
        descriptor.executableSha256,
        descriptor.executableSecurity,
      ],
      [
        descriptor.helperPath,
        descriptor.helperSha256,
        descriptor.helperSecurity,
      ],
    ]) {
      assertPlainRegularFile(target, {
        code: "BASE_PROTECTION_MANAGEMENT_CLIENT_UNSAFE",
      });
      if (
        fileHash(target) !== expectedHash
        || JSON.stringify(fileSecurityAttestation(target))
          !== JSON.stringify(expectedSecurity || {})
      ) {
        throw Object.assign(new Error("Authenticated Controller helper has drifted"), {
          code: "BASE_PROTECTION_MANAGEMENT_CLIENT_DRIFT",
        });
      }
    }
    const repositoryId = String(manifest.controller?.repositoryId || "");
    if (!repositoryId) {
      throw Object.assign(new Error("Controller repository ID is not configured"), {
        code: "BASE_PROTECTION_CONTROLLER_REPOSITORY_ID_MISSING",
      });
    }
    const installationId = String(manifest.installationId || "");
    const manifestSha256 = fileHash(manifestPath);
    const idempotencyKey = sha256(
      `devbench-hooks-standalone\0uninstall\0${installationId}\0${manifestSha256}`,
    );
    const result = spawnSync(
      descriptor.executable,
      [
        ...(descriptor.fixedArgs || []),
        descriptor.helperPath,
        "standalone-hooks-uninstall",
        "--repository-id",
        repositoryId,
        "--installation-id",
        installationId,
        "--manifest-sha256",
        manifestSha256,
        "--idempotency-key",
        idempotencyKey,
      ],
      {
        encoding: "utf8",
        windowsHide: true,
        timeout: descriptor.timeoutMs || 30_000,
        maxBuffer: 1024 * 1024,
        shell: false,
        env: {
          PATH: "",
          SystemRoot: process.env.SystemRoot || "",
          WINDIR: process.env.WINDIR || "",
          HOME: process.env.HOME || "",
          TMPDIR: process.env.TMPDIR || "",
          TMP: process.env.TMP || "",
          TEMP: process.env.TEMP || "",
        },
      },
    );
    let response = null;
    try {
      response = JSON.parse(String(result.stdout || "").trim());
    } catch {}
    if (result.error || result.status !== 0 || response?.ok !== true) {
      throw Object.assign(new Error("Authenticated Controller helper is unavailable"), {
        code: String(
          response?.error?.code || "BASE_PROTECTION_CONTROLLER_UNAVAILABLE",
        ),
      });
    }
    if (!response.data || typeof response.data !== "object") {
      throw Object.assign(new Error("Authenticated Controller helper rejected the request"), {
        code: String(response?.error?.code || "BASE_PROTECTION_CONTROLLER_REJECTED"),
      });
    }
    return response.data;
  } catch (error) {
    return {
      status: "CONTROLLER_UNAVAILABLE",
      canUninstall: false,
      issues: [String(error?.code || "BASE_PROTECTION_CONTROLLER_UNAVAILABLE")],
      error: String(error?.message || error),
    };
  }
}

async function descriptorValidator(descriptor, context) {
  if (!descriptor || descriptor.type === "none") {
    return { ok: false, reason: "CONTROLLER_UNAVAILABLE" };
  }
  if (descriptor.type === "command") {
    try {
      assertPlainRegularFile(descriptor.executable, {
        code: "BASE_PROTECTION_VALIDATOR_UNSAFE",
      });
      if (fileHash(descriptor.executable) !== String(descriptor.executableSha256 || "")) {
        return { ok: false, reason: "CAPABILITY_VALIDATOR_DRIFTED" };
      }
      for (const record of descriptor.argFiles || []) {
        assertPlainRegularFile(record.path, {
          code: "BASE_PROTECTION_VALIDATOR_UNSAFE",
        });
        if (fileHash(record.path) !== String(record.sha256 || "")) {
          return { ok: false, reason: "CAPABILITY_VALIDATOR_DRIFTED" };
        }
      }
    } catch {
      return { ok: false, reason: "CAPABILITY_VALIDATOR_DRIFTED" };
    }
    const result = spawnSync(descriptor.executable, [...(descriptor.args || [])], {
      input: `${JSON.stringify(context)}\n`,
      encoding: "utf8",
      windowsHide: true,
      timeout: descriptor.timeoutMs || 5_000,
      shell: false,
      env: {
        PATH: "",
        SystemRoot: process.env.SystemRoot || "",
        WINDIR: process.env.WINDIR || "",
        HOME: process.env.HOME || "",
        TMPDIR: process.env.TMPDIR || "",
        TMP: process.env.TMP || "",
        TEMP: process.env.TEMP || "",
      },
    });
    if (result.error || result.status !== 0) {
      return { ok: false, reason: "CONTROLLER_UNAVAILABLE" };
    }
    try {
      const parsed = JSON.parse(String(result.stdout || "").trim());
      return parsed?.ok === true
        ? { ok: true, reason: String(parsed.reason || "CAPABILITY_VALID") }
        : { ok: false, reason: String(parsed?.reason || "CAPABILITY_REJECTED") };
    } catch {
      return { ok: false, reason: "CAPABILITY_VALIDATOR_INVALID_RESPONSE" };
    }
  }
  if (descriptor.type === "module") {
    if (!fs.existsSync(descriptor.modulePath) || fileHash(descriptor.modulePath) !== descriptor.moduleSha256) {
      return { ok: false, reason: "CAPABILITY_VALIDATOR_DRIFTED" };
    }
    try {
      const mod = await import(`${pathToFileURL(descriptor.modulePath).href}?v=${descriptor.moduleSha256}`);
      const validator = mod[descriptor.exportName || "validateCapability"];
      if (typeof validator !== "function") return { ok: false, reason: "CAPABILITY_VALIDATOR_MISSING" };
      const result = await validator(context);
      return typeof result === "object"
        ? { ok: result.ok === true, reason: String(result.reason || (result.ok ? "CAPABILITY_VALID" : "CAPABILITY_REJECTED")) }
        : { ok: result === true, reason: result === true ? "CAPABILITY_VALID" : "CAPABILITY_REJECTED" };
    } catch {
      return { ok: false, reason: "CONTROLLER_UNAVAILABLE" };
    }
  }
  return { ok: false, reason: "CONTROLLER_UNAVAILABLE" };
}

export async function guardManagedHook(managedRoot, {
  hook,
  args = [],
  capability = "",
  capabilityValidator = null,
  invocationRepositoryPath = "",
} = {}) {
  const root = path.resolve(String(managedRoot || ""));
  if (!runtimeExecution.getStore()?.verified) {
    try {
      return await withRuntimeForManagedRoot(root, () => guardManagedHook(root, {
        hook,
        args,
        capability,
        capabilityValidator,
        invocationRepositoryPath,
      }));
    } catch (error) {
      return {
        ok: false,
        reason: String(error?.code || "BASE_PROTECTION_RUNTIME_EXECUTABLES_UNSAFE"),
      };
    }
  }
  const manifestPath = path.join(root, "manifest.json");
  const statePath = path.join(root, "state.json");
  if (!HOOK_NAMES.includes(String(hook || ""))) {
    return { ok: false, reason: "HOOK_NOT_MANAGED" };
  }
  let manifest;
  let state;
  try {
    manifest = readJson(manifestPath);
    state = readJson(statePath);
  } catch {
    return { ok: false, reason: "MANIFEST_UNAVAILABLE" };
  }
  if (state.status !== "ACTIVE") return { ok: false, reason: `INSTALLATION_${state.status || "UNKNOWN"}` };
  if (state.manifestSha256 && state.manifestSha256 !== fileHash(manifestPath)) {
    return { ok: false, reason: "MANIFEST_HASH_DRIFT" };
  }
  let repository;
  let paths;
  try {
    repository = resolveRepository(manifest.repository?.root || "");
    paths = installationPaths(repository);
    if (!samePath(root, paths.root)) {
      return { ok: false, reason: "MANAGED_ROOT_MISMATCH" };
    }
    const integrityIssues = [];
    verifyManifestIdentity(repository, paths, manifest, state, integrityIssues);
    verifyManagedFiles(paths, manifest, integrityIssues);
    if (integrityIssues.length) {
      return { ok: false, reason: integrityIssues[0] };
    }
  } catch {
    return { ok: false, reason: "MANAGED_RUNTIME_UNSAFE" };
  }
  let invocationRepository;
  try {
    invocationRepository = resolveRepository(invocationRepositoryPath || process.cwd());
  } catch {
    invocationRepository = repository;
  }
  if (!samePath(invocationRepository.gitCommonDir, repository.gitCommonDir)) {
    return { ok: false, reason: "INVOCATION_REPOSITORY_MISMATCH" };
  }
  const top = invocationRepository.repositoryRoot;
  const branch = runGit(invocationRepository.requested, ["branch", "--show-current"], { allowFailure: true });
  const currentGitDir = absoluteGitPath(
    invocationRepository.requested,
    ["--git-dir"],
    invocationRepository.requested,
  );
  const isLinkedWorktree = !samePath(top, repository.repositoryRoot)
    && !samePath(currentGitDir, repository.gitCommonDir)
    && isInside(repository.gitCommonDir, currentGitDir);
  if (isLinkedWorktree) {
    return { ok: false, reason: "LEGACY_LINKED_WORKTREE_UNSUPPORTED" };
  }
  const context = {
    hook: String(hook),
    args: Array.isArray(args) ? args.map(String) : [],
    capability: String(capability || ""),
    repositoryFingerprint: repository.fingerprint,
    repositoryRoot: repository.repositoryRoot,
    invocationRepositoryRoot: invocationRepository.repositoryRoot,
    gitCommonDir: repository.gitCommonDir,
    head: runGit(invocationRepository.requested, ["rev-parse", "HEAD"], { allowFailure: true }),
    branch,
    timestamp: nowIso(),
  };
  let validation;
  if (typeof capabilityValidator === "function") {
    try {
      const result = await capabilityValidator(context);
      validation = typeof result === "object"
        ? { ok: result.ok === true, reason: String(result.reason || "") }
        : { ok: result === true, reason: result === true ? "CAPABILITY_VALID" : "CAPABILITY_REJECTED" };
    } catch {
      validation = { ok: false, reason: "CONTROLLER_UNAVAILABLE" };
    }
  } else {
    validation = await descriptorValidator(manifest.capability?.validator, context);
  }
  return validation?.ok
    ? { ok: true, reason: validation.reason || "CAPABILITY_VALID" }
    : { ok: false, reason: validation?.reason || "CONTROLLER_UNAVAILABLE" };
}

export function managedInstallationPaths(repositoryPath, options = {}) {
  return withRuntimeForRepository(repositoryPath, options, () => {
    const repository = resolveRepository(repositoryPath);
    return { repository, ...installationPaths(repository) };
  });
}
