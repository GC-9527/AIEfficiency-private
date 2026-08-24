import fs from "node:fs";
import path from "node:path";
import { execFile, spawn } from "node:child_process";

const SHA_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const MAX_GIT_OUTPUT = 256 * 1024;
const DEFAULT_GIT_TIMEOUT_MS = 60_000;
const DEFAULT_GIT_STREAM_BYTES = 512 * 1024 * 1024;
const DEFAULT_GIT_STREAM_RECORDS = 2_000_000;
const DEFAULT_GIT_STREAM_RECORD_BYTES = 16 * 1024;

export class GitControllerError extends Error {
  constructor(code, message, details = {}, options = {}) {
    super(message, options);
    this.name = "GitControllerError";
    this.code = String(code || "GIT_CONTROLLER_ERROR");
    this.details = details && typeof details === "object" ? details : {};
  }
}

export function pathKey(value, platform = process.platform) {
  const resolved = path.resolve(String(value || ""));
  return platform === "win32" ? resolved.toLowerCase() : resolved;
}

export function pathInside(rootValue, targetValue, platform = process.platform) {
  const root = path.resolve(String(rootValue || ""));
  const target = path.resolve(String(targetValue || ""));
  const relative = path.relative(root, target);
  const inside = relative === ""
    || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
  if (!inside) return false;
  if (platform !== "win32") return true;
  return pathKey(path.join(root, relative), platform) === pathKey(target, platform);
}

function assertAbsolutePath(value, label) {
  const input = String(value || "").trim();
  if (!input || (!path.isAbsolute(input) && !/^[A-Za-z]:[\\/]/.test(input))) {
    throw new GitControllerError(
      "GIT_CONTROLLER_PATH_NOT_ABSOLUTE",
      `${label} must be an absolute path`,
      { label },
    );
  }
  if (input.includes("\0")) {
    throw new GitControllerError("GIT_CONTROLLER_PATH_INVALID", `${label} contains NUL`, { label });
  }
  return path.resolve(input);
}

function existingSegments(resolvedPath) {
  const parsed = path.parse(resolvedPath);
  const relative = resolvedPath.slice(parsed.root.length);
  const segments = relative.split(/[\\/]+/).filter(Boolean);
  const result = [];
  let current = parsed.root;
  for (const segment of segments) {
    current = path.join(current, segment);
    if (!fs.existsSync(current)) break;
    result.push(current);
  }
  return result;
}

export function assertNoReparseSegments(value, { label = "path" } = {}) {
  const resolved = assertAbsolutePath(value, label);
  for (const segment of existingSegments(resolved)) {
    let stat;
    try {
      stat = fs.lstatSync(segment);
    } catch (error) {
      throw new GitControllerError(
        "GIT_CONTROLLER_PATH_INSPECTION_FAILED",
        `Unable to inspect ${label}`,
        { label, cause: error.code || error.message },
      );
    }
    if (stat.isSymbolicLink()) {
      throw new GitControllerError(
        "GIT_CONTROLLER_REPARSE_POINT_REJECTED",
        `${label} traverses a symbolic link, junction or reparse point`,
        { label },
      );
    }
  }
  return resolved;
}

export function canonicalizeExistingDirectory(value, { label = "directory" } = {}) {
  const resolved = assertNoReparseSegments(value, { label });
  let stat;
  try {
    stat = fs.lstatSync(resolved);
  } catch (error) {
    throw new GitControllerError(
      "GIT_CONTROLLER_PATH_NOT_FOUND",
      `${label} does not exist`,
      { label, cause: error.code || error.message },
    );
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new GitControllerError(
      "GIT_CONTROLLER_PATH_NOT_DIRECTORY",
      `${label} is not a plain directory`,
      { label },
    );
  }
  const real = fs.realpathSync.native(resolved);
  if (pathKey(real) !== pathKey(resolved)) {
    throw new GitControllerError(
      "GIT_CONTROLLER_REPARSE_POINT_REJECTED",
      `${label} resolves outside its configured path`,
      { label },
    );
  }
  return real;
}

export function canonicalizeManagedPath(value, {
  allowedRoot,
  label = "managed path",
  allowMissing = true,
  expectedType = "any",
} = {}) {
  const resolved = assertNoReparseSegments(value, { label });
  const root = canonicalizeExistingDirectory(allowedRoot, { label: "managed data root" });
  if (!pathInside(root, resolved)) {
    throw new GitControllerError(
      "GIT_CONTROLLER_PATH_OUTSIDE_MANAGED_ROOT",
      `${label} is outside the managed data root`,
      { label },
    );
  }
  if (fs.existsSync(resolved)) {
    const stat = fs.lstatSync(resolved);
    if (stat.isSymbolicLink()) {
      throw new GitControllerError(
        "GIT_CONTROLLER_REPARSE_POINT_REJECTED",
        `${label} is a symbolic link, junction or reparse point`,
        { label },
      );
    }
    if (expectedType === "directory" && !stat.isDirectory()) {
      throw new GitControllerError(
        "GIT_CONTROLLER_PATH_NOT_DIRECTORY",
        `${label} is not a plain directory`,
        { label },
      );
    }
    if (expectedType === "file" && !stat.isFile()) {
      throw new GitControllerError(
        "GIT_CONTROLLER_PATH_NOT_FILE",
        `${label} is not a plain file`,
        { label },
      );
    }
    const real = fs.realpathSync.native(resolved);
    if (pathKey(real) !== pathKey(resolved)) {
      throw new GitControllerError(
        "GIT_CONTROLLER_REPARSE_POINT_REJECTED",
        `${label} resolves outside its configured path`,
        { label },
      );
    }
    return real;
  }
  if (!allowMissing) {
    throw new GitControllerError("GIT_CONTROLLER_PATH_NOT_FOUND", `${label} does not exist`, { label });
  }
  return resolved;
}

export function ensureManagedDirectory(value, options = {}) {
  const resolved = canonicalizeManagedPath(value, {
    ...options,
    allowMissing: true,
    expectedType: "directory",
  });
  fs.mkdirSync(resolved, { recursive: true, mode: 0o700 });
  return canonicalizeManagedPath(resolved, {
    ...options,
    allowMissing: false,
    expectedType: "directory",
  });
}

export function normalizeSha(value, { required = true, label = "SHA" } = {}) {
  const sha = String(value || "").trim().toLowerCase();
  if (!sha && !required) return null;
  if (!SHA_PATTERN.test(sha)) {
    throw new GitControllerError(
      "GIT_CONTROLLER_INVALID_SHA",
      `${label} must be an exact 40- or 64-character object id`,
      { label },
    );
  }
  return sha;
}

export function assertBranchName(value) {
  const branch = String(value || "").trim();
  const invalid = !branch
    || branch.length > 240
    || branch.startsWith("-")
    || branch.startsWith("/")
    || branch.endsWith("/")
    || branch.endsWith(".")
    || branch.includes("..")
    || branch.includes("@{")
    || branch.includes("//")
    || /[\x00-\x20\x7f~^:?*[\]\\]/.test(branch)
    || branch.split("/").some((part) => !part || part.startsWith(".") || part.endsWith(".lock"));
  if (invalid) {
    throw new GitControllerError(
      "GIT_CONTROLLER_INVALID_BRANCH",
      "Branch name is not a safe registered Git branch",
    );
  }
  return branch;
}

export function assertRemoteId(value) {
  const remoteId = String(value || "").trim();
  if (
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(remoteId)
    || remoteId.includes("..")
    || remoteId.endsWith(".lock")
  ) {
    throw new GitControllerError("GIT_CONTROLLER_INVALID_REMOTE", "Registered remote id is invalid");
  }
  return remoteId;
}

export function assertIdempotencyKey(value) {
  const key = String(value || "").trim();
  if (!key || key.length > 200 || /[\x00-\x1f\x7f]/.test(key)) {
    throw new GitControllerError(
      "GIT_CONTROLLER_IDEMPOTENCY_KEY_REQUIRED",
      "A valid idempotency key is required",
    );
  }
  return key;
}

export function safeRemoteUrl(value) {
  const remote = String(value || "").trim();
  if (!remote) return "";
  if (/^https?:\/\//i.test(remote)) {
    try {
      const parsed = new URL(remote);
      if (parsed.username) parsed.username = "***";
      if (parsed.password) parsed.password = "***";
      parsed.search = "";
      parsed.hash = "";
      return parsed.toString();
    } catch {
      return remote.replace(/(https?:\/\/)[^/@\s]+@/gi, "$1***@");
    }
  }
  return remote.replace(/(ssh:\/\/)[^/@\s]+@/gi, "$1***@");
}

export function redactGitOutput(value, secrets = [], maxLength = MAX_GIT_OUTPUT) {
  let output = String(value || "");
  for (const secretValue of secrets || []) {
    const secret = String(secretValue || "");
    if (secret && secret.length >= 4) {
      const replacement = safeRemoteUrl(secret) || "***";
      output = output.split(secret).join(replacement);
      output = output.split(secret.replace(/\\/g, "/")).join(replacement);
    }
  }
  return output
    .replace(/(https?:\/\/)[^/\s'"]+@/gi, "$1***@")
    .replace(/((?:password|passwd|token|authorization)\s*[:=]\s*)[^\s'"]+/gi, "$1***")
    .slice(0, Math.max(1, Number(maxLength) || MAX_GIT_OUTPUT));
}

function redactProtectedPaths(value, protectedPaths = []) {
  let output = String(value || "");
  for (const pathValue of protectedPaths) {
    const protectedPath = String(pathValue || "");
    if (!protectedPath) continue;
    output = output.split(protectedPath).join("***");
    output = output.split(protectedPath.replace(/\\/g, "/")).join("***");
  }
  return output;
}

const ENV_ALLOWLIST = new Set([
  "PATH",
  "PATHEXT",
  "SystemRoot",
  "SYSTEMROOT",
  "WINDIR",
  "ComSpec",
  "COMSPEC",
  "TEMP",
  "TMP",
  "TMPDIR",
  "HOME",
  "USERPROFILE",
  "HOMEDRIVE",
  "HOMEPATH",
  "APPDATA",
  "LOCALAPPDATA",
  "PROGRAMDATA",
  "USER",
  "LOGNAME",
]);

export function sanitizedGitEnv(extra = {}) {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (ENV_ALLOWLIST.has(key) && value != null) env[key] = String(value);
  }
  Object.assign(env, {
    GIT_TERMINAL_PROMPT: "0",
    GCM_INTERACTIVE: "Never",
    GIT_ALLOW_PROTOCOL: "file:https",
    GIT_PROTOCOL_FROM_USER: "0",
    GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_ATTR_NOSYSTEM: "1",
    LC_ALL: "C",
    LANG: "C",
  });
  for (const [key, value] of Object.entries(extra || {})) {
    if (!/^(?:DEVBENCH_[A-Z0-9_]+|GIT_TERMINAL_PROMPT|GCM_INTERACTIVE|GIT_ALLOW_PROTOCOL|GIT_PROTOCOL_FROM_USER|GIT_NO_REPLACE_OBJECTS)$/.test(key)) {
      throw new GitControllerError(
        "GIT_CONTROLLER_ENV_REJECTED",
        `Git environment variable is not allowed: ${key}`,
      );
    }
    if (value != null) env[key] = String(value);
    if (
      key === "GIT_ALLOW_PROTOCOL"
      && !/^(?:file|https|ssh|file:https|https:file|file:ssh|ssh:file)$/.test(String(value))
    ) {
      throw new GitControllerError(
        "GIT_CONTROLLER_TRANSPORT_REJECTED",
        "Git transport allowlist is not an exact Controller-approved transport set",
      );
    }
  }
  return env;
}

export function resolveExecutable(value = "git") {
  const configured = String(value || "").trim();
  if (!configured || configured.includes("\0")) {
    throw new GitControllerError(
      "GIT_CONTROLLER_EXECUTABLE_INVALID",
      "Configured Git executable is invalid",
    );
  }
  const candidates = [];
  if (path.isAbsolute(configured)) {
    candidates.push(configured);
  } else {
    const extensions = process.platform === "win32"
      ? String(process.env.PATHEXT || ".EXE;.CMD;.BAT;.COM").split(";").filter(Boolean)
      : [""];
    for (const directory of String(process.env.PATH || "").split(path.delimiter).filter(Boolean)) {
      if (path.extname(configured) || process.platform !== "win32") {
        candidates.push(path.join(directory, configured));
      } else {
        for (const extension of extensions) candidates.push(path.join(directory, configured + extension));
      }
    }
  }
  for (const candidate of candidates) {
    try {
      const stat = fs.statSync(candidate);
      if (!stat.isFile()) continue;
      return fs.realpathSync.native(candidate);
    } catch {}
  }
  throw new GitControllerError(
    "GIT_CONTROLLER_EXECUTABLE_NOT_FOUND",
    "Configured Git executable was not found on PATH",
  );
}

function protectedRegularFile(value, label) {
  const input = String(value || "");
  if (!input || !path.isAbsolute(input) || input.includes("\0")) {
    throw new GitControllerError(
      "GIT_CONTROLLER_EXECUTION_POLICY_INVALID",
      `Controller ${label} is not an absolute protected file`,
    );
  }
  let stat;
  try {
    stat = fs.lstatSync(input);
  } catch {
    throw new GitControllerError(
      "GIT_CONTROLLER_EXECUTION_POLICY_INVALID",
      `Controller ${label} is unavailable`,
    );
  }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new GitControllerError(
      "GIT_CONTROLLER_EXECUTION_POLICY_INVALID",
      `Controller ${label} is not a regular file`,
    );
  }
  return path.resolve(input);
}

function shellSafeProtectedPath(value, label) {
  const resolved = protectedRegularFile(value, label).replace(/\\/g, "/");
  if (!/^(?:[A-Za-z]:)?\/[A-Za-z0-9._/+-]+$/.test(resolved)) {
    throw new GitControllerError(
      "GIT_CONTROLLER_SSH_PATH_UNSAFE",
      `Controller ${label} path cannot be represented safely in GIT_SSH_COMMAND`,
    );
  }
  return resolved;
}

function internalSshEnvironment(sshTransport) {
  if (!sshTransport || typeof sshTransport !== "object" || Array.isArray(sshTransport)) {
    return {};
  }
  const sshBinary = shellSafeProtectedPath(sshTransport.sshBinaryPath, "SSH executable");
  const privateKey = shellSafeProtectedPath(sshTransport.privateKeyPath, "SSH private key");
  const knownHosts = shellSafeProtectedPath(sshTransport.knownHostsPath, "SSH known_hosts");
  const nullPath = process.platform === "win32" ? "NUL" : "/dev/null";
  const tokens = [
    sshBinary,
    "-F", nullPath,
    "-oBatchMode=yes",
    "-oStrictHostKeyChecking=yes",
    "-oIdentitiesOnly=yes",
    "-oIdentityAgent=none",
    "-oPasswordAuthentication=no",
    "-oKbdInteractiveAuthentication=no",
    "-oChallengeResponseAuthentication=no",
    "-oHostbasedAuthentication=no",
    "-oPubkeyAuthentication=yes",
    "-oForwardAgent=no",
    "-oForwardX11=no",
    "-oClearAllForwardings=yes",
    "-oPermitLocalCommand=no",
    "-oProxyCommand=none",
    "-oProxyJump=none",
    "-oRequestTTY=no",
    "-oUpdateHostKeys=no",
    "-oVerifyHostKeyDNS=no",
    `-oUserKnownHostsFile=${knownHosts}`,
    `-oGlobalKnownHostsFile=${nullPath}`,
    "-i", privateKey,
  ];
  return {
    GIT_SSH_COMMAND: tokens.join(" "),
    GIT_SSH_VARIANT: "ssh",
  };
}

export function gitLongPathsConfigArgs(platform = process.platform) {
  return platform === "win32"
    ? ["-c", "core.longpaths=true"]
    : [];
}

function prepareGitExecution({
  gitBinary,
  disabledHooksPath,
  trustedHooksPath = null,
  knownHostsPath,
  args,
  env = {},
  sshTransport = null,
  commandId = "git.command",
} = {}) {
  if (!Array.isArray(args) || args.some((arg) => typeof arg !== "string" || arg.includes("\0"))) {
    throw new GitControllerError(
      "GIT_CONTROLLER_ARGS_INVALID",
      "Internal Git argv is invalid",
      { commandId },
    );
  }
  const executable = String(gitBinary || "").trim();
  let executableStat;
  try {
    executableStat = fs.statSync(executable);
  } catch {}
  if (
    !executable
    || executable.includes("\0")
    || !path.isAbsolute(executable)
    || !executableStat?.isFile()
  ) {
    throw new GitControllerError(
      "GIT_CONTROLLER_EXECUTABLE_INVALID",
      "Configured Git executable is invalid",
      { commandId },
    );
  }
  const hooksInput = String(trustedHooksPath || disabledHooksPath || "");
  const knownHostsInput = String(knownHostsPath || "");
  const hooksPath = path.resolve(hooksInput);
  const knownHosts = path.resolve(knownHostsInput);
  let hooksStat;
  let knownHostsStat;
  try {
    hooksStat = fs.statSync(hooksPath);
    knownHostsStat = fs.statSync(knownHosts);
  } catch {}
  if (
    !path.isAbsolute(hooksInput)
    || !hooksStat?.isDirectory()
    || !path.isAbsolute(knownHostsInput)
    || !knownHostsStat?.isFile()
    || /["\r\n]/.test(knownHosts)
  ) {
    throw new GitControllerError(
      "GIT_CONTROLLER_EXECUTION_POLICY_INVALID",
      "Git execution requires absolute protected hooks and known_hosts paths",
      { commandId },
    );
  }
  const hardenedArgs = [
    "--no-pager",
    "--no-optional-locks",
    ...gitLongPathsConfigArgs(),
    "-c", "core.fsmonitor=false",
    "-c", "core.untrackedCache=false",
    "-c", `core.hooksPath=${hooksPath.replace(/\\/g, "/")}`,
    "-c", "diff.external=",
    "-c", `core.attributesFile=${process.platform === "win32" ? "NUL" : "/dev/null"}`,
    "-c", "credential.helper=",
    "-c", "credential.interactive=never",
    ...args,
  ];
  const executionEnv = sanitizedGitEnv(env);
  if (sshTransport) {
    if (executionEnv.GIT_ALLOW_PROTOCOL !== "ssh") {
      throw new GitControllerError(
        "GIT_CONTROLLER_SSH_PROTOCOL_POLICY_INVALID",
        "Attested SSH execution requires the exact ssh protocol allowlist",
        { commandId },
      );
    }
    Object.assign(executionEnv, internalSshEnvironment(sshTransport));
  }
  return { executable, hardenedArgs, executionEnv };
}

export const __test = Object.freeze({
  gitLongPathsConfigArgs,
  prepareGitExecution,
});

function invokeGitSpawnGuard(beforeGitSpawn, commandId) {
  if (beforeGitSpawn == null) return;
  if (typeof beforeGitSpawn !== "function") {
    throw new GitControllerError(
      "GIT_CONTROLLER_GIT_SPAWN_GUARD_INVALID",
      "Git spawn guard must be a synchronous Controller-owned function",
      { commandId },
    );
  }
  const result = beforeGitSpawn(Object.freeze({ commandId }));
  if (result && typeof result.then === "function") {
    throw new GitControllerError(
      "GIT_CONTROLLER_GIT_SPAWN_GUARD_ASYNC",
      "Git spawn guard must complete synchronously before process creation",
      { commandId },
    );
  }
}

export function runGitFile({
  gitBinary,
  disabledHooksPath,
  trustedHooksPath = null,
  knownHostsPath,
  args,
  cwd,
  timeoutMs = DEFAULT_GIT_TIMEOUT_MS,
  okExitCodes = [0],
  env = {},
  secrets = [],
  maxOutputBytes = MAX_GIT_OUTPUT,
  commandId = "git.command",
  sshTransport = null,
  childLifecycle = null,
  beforeGitSpawn = null,
} = {}) {
  let execution;
  try {
    execution = prepareGitExecution({
      gitBinary,
      disabledHooksPath,
      trustedHooksPath,
      knownHostsPath,
      args,
      env,
      sshTransport,
      commandId,
    });
  } catch (error) {
    return Promise.reject(error);
  }
  const allowedExitCodes = new Set(okExitCodes.map((code) => Number(code)));
  const protectedPaths = sshTransport
    ? [
        sshTransport.sshBinaryPath,
        sshTransport.privateKeyPath,
        sshTransport.knownHostsPath,
      ]
    : [];
  const outputLimit = Math.min(
    64 * 1024 * 1024,
    Math.max(MAX_GIT_OUTPUT, Number(maxOutputBytes) || MAX_GIT_OUTPUT),
  );
  return new Promise((resolve, reject) => {
    if (
      childLifecycle
      && (
        typeof childLifecycle.beforeSpawn !== "function"
        || typeof childLifecycle.afterSpawn !== "function"
        || typeof childLifecycle.afterClose !== "function"
        || typeof childLifecycle.spawnFailed !== "function"
      )
    ) {
      reject(new GitControllerError(
        "GIT_CONTROLLER_GIT_CHILD_LIFECYCLE_INVALID",
        "Git child lifecycle guard is incomplete",
        { commandId },
      ));
      return;
    }
    let ticket = null;
    let child = null;
    let registrationError = null;
    try {
      ticket = childLifecycle?.beforeSpawn() ?? null;
      if (childLifecycle && ticket == null) {
        throw new GitControllerError(
          "GIT_CONTROLLER_GIT_CHILD_TICKET_INVALID",
          "Git child lifecycle guard did not issue a spawn ticket",
          { commandId },
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
      const exitCode = error ? Number(error.code) : 0;
      const result = {
        commandId,
        exitCode: Number.isFinite(exitCode) ? exitCode : -1,
        stdout: redactGitOutput(redactProtectedPaths(stdout, protectedPaths), secrets, outputLimit),
        stderr: redactGitOutput(redactProtectedPaths(stderr, protectedPaths), secrets, outputLimit),
      };
      if (!error || allowedExitCodes.has(result.exitCode)) {
        resolve(result);
        return;
      }
      const timedOut = error?.killed === true && error?.signal;
      reject(new GitControllerError(
        timedOut ? "GIT_CONTROLLER_COMMAND_TIMEOUT" : "GIT_CONTROLLER_COMMAND_FAILED",
        `${commandId} failed`,
        {
          commandId,
          exitCode: result.exitCode,
          stderr: result.stderr.slice(0, 4000),
        },
        { cause: error },
      ));
    };
    try {
      invokeGitSpawnGuard(beforeGitSpawn, commandId);
      child = execFile(execution.executable, execution.hardenedArgs, {
        cwd: cwd || undefined,
        timeout: Math.max(1000, Number(timeoutMs) || DEFAULT_GIT_TIMEOUT_MS),
        windowsHide: true,
        encoding: "utf8",
        maxBuffer: outputLimit,
        env: execution.executionEnv,
        shell: false,
      }, complete);
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

export function createNulRecordParser({
  onRecord,
  maxTotalBytes = DEFAULT_GIT_STREAM_BYTES,
  maxRecords = DEFAULT_GIT_STREAM_RECORDS,
  maxRecordBytes = DEFAULT_GIT_STREAM_RECORD_BYTES,
} = {}) {
  if (typeof onRecord !== "function") {
    throw new GitControllerError(
      "GIT_CONTROLLER_STREAM_HANDLER_REQUIRED",
      "NUL-stream execution requires a record handler",
    );
  }
  const totalLimit = Math.max(1, Number(maxTotalBytes) || DEFAULT_GIT_STREAM_BYTES);
  const recordLimit = Math.max(1, Number(maxRecords) || DEFAULT_GIT_STREAM_RECORDS);
  const recordByteLimit = Math.max(1, Number(maxRecordBytes) || DEFAULT_GIT_STREAM_RECORD_BYTES);
  let pending = Buffer.alloc(0);
  let totalBytes = 0;
  let recordCount = 0;
  return Object.freeze({
    push(chunkValue) {
      const chunk = Buffer.isBuffer(chunkValue) ? chunkValue : Buffer.from(chunkValue || "");
      totalBytes += chunk.length;
      if (totalBytes > totalLimit) throw new Error("stream-byte-limit");
      const data = pending.length ? Buffer.concat([pending, chunk]) : chunk;
      let start = 0;
      for (let index = 0; index < data.length; index += 1) {
        if (data[index] !== 0) continue;
        const record = data.subarray(start, index);
        if (record.length > recordByteLimit) throw new Error("stream-record-byte-limit");
        recordCount += 1;
        if (recordCount > recordLimit) throw new Error("stream-record-limit");
        onRecord(record);
        start = index + 1;
      }
      const remainder = data.subarray(start);
      if (remainder.length > recordByteLimit) throw new Error("stream-record-byte-limit");
      pending = remainder.length ? Buffer.from(remainder) : Buffer.alloc(0);
    },
    finish() {
      if (pending.length) throw new Error("stream-truncated-record");
      return Object.freeze({ totalBytes, recordCount });
    },
  });
}

export function streamGitNulRecords({
  gitBinary,
  disabledHooksPath,
  trustedHooksPath = null,
  knownHostsPath,
  args,
  cwd,
  timeoutMs = DEFAULT_GIT_TIMEOUT_MS,
  env = {},
  secrets = [],
  commandId = "git.stream",
  sshTransport = null,
  onRecord,
  maxTotalBytes = DEFAULT_GIT_STREAM_BYTES,
  maxRecords = DEFAULT_GIT_STREAM_RECORDS,
  maxRecordBytes = DEFAULT_GIT_STREAM_RECORD_BYTES,
  beforeGitSpawn = null,
} = {}) {
  let execution;
  let parser;
  try {
    execution = prepareGitExecution({
      gitBinary,
      disabledHooksPath,
      trustedHooksPath,
      knownHostsPath,
      args,
      env,
      sshTransport,
      commandId,
    });
    parser = createNulRecordParser({
      onRecord,
      maxTotalBytes,
      maxRecords,
      maxRecordBytes,
    });
  } catch (error) {
    return Promise.reject(error);
  }
  return new Promise((resolve, reject) => {
    const protectedPaths = sshTransport
      ? [
          sshTransport.sshBinaryPath,
          sshTransport.privateKeyPath,
          sshTransport.knownHostsPath,
        ]
      : [];
    let terminalError = null;
    let stderr = Buffer.alloc(0);
    let timedOut = false;
    let child;
    try {
      invokeGitSpawnGuard(beforeGitSpawn, commandId);
      child = spawn(execution.executable, execution.hardenedArgs, {
        cwd: cwd || undefined,
        windowsHide: true,
        env: execution.executionEnv,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      reject(error);
      return;
    }
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, Math.max(1000, Number(timeoutMs) || DEFAULT_GIT_TIMEOUT_MS));
    child.stdout.on("data", (chunk) => {
      if (terminalError) return;
      try {
        parser.push(chunk);
      } catch (error) {
        terminalError = error;
        child.kill();
      }
    });
    child.stderr.on("data", (chunk) => {
      if (stderr.length >= MAX_GIT_OUTPUT) return;
      stderr = Buffer.concat([stderr, chunk]).subarray(0, MAX_GIT_OUTPUT);
    });
    child.once("error", (error) => {
      terminalError ||= error;
    });
    child.once("close", (exitCode) => {
      clearTimeout(timeout);
      if (!terminalError && !timedOut && exitCode === 0) {
        try {
          const summary = parser.finish();
          resolve({
            commandId,
            exitCode: 0,
            stderr: redactGitOutput(
              redactProtectedPaths(stderr.toString("utf8"), protectedPaths),
              secrets,
            ),
            ...summary,
          });
          return;
        } catch (error) {
          terminalError = error;
        }
      }
      reject(new GitControllerError(
        timedOut ? "GIT_CONTROLLER_COMMAND_TIMEOUT" : "GIT_CONTROLLER_STREAM_COMMAND_FAILED",
        `${commandId} failed`,
        {
          commandId,
          exitCode: Number.isFinite(Number(exitCode)) ? Number(exitCode) : -1,
          stderr: redactGitOutput(
            redactProtectedPaths(stderr.toString("utf8"), protectedPaths),
            secrets,
          ).slice(0, 4000),
        },
        { cause: terminalError || undefined },
      ));
    });
  });
}
