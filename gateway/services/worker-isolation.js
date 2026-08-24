import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  randomUUID,
  sign,
} from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  verifyWorkerDeploymentAttestation,
  workerDeploymentAttestationSigningBytes,
} from "./worker-isolation-attestation.js";
import { issueWorkerLaunchNonce } from "./worker-launch-consume-helper.mjs";

export const INDEPENDENT_REPOSITORY_MODE = "INDEPENDENT_REPOSITORY";
export const LEGACY_LINKED_WORKTREE_MODE = "LEGACY_LINKED_WORKTREE";
export const WORKER_ISOLATION_LEVELS = Object.freeze({
  STRONG: "STRONG",
  ADVISORY: "ADVISORY",
  DEGRADED: "DEGRADED",
});

export function productionWorkerIsolationRequired(environment = process.env) {
  const mode = String(environment?.NODE_ENV || "").trim().toLowerCase();
  return mode !== "test" && mode !== "development";
}

const DEFAULT_GRANT_TTL_MS = 5 * 60 * 1000;
const CONTROLLER_ENV_PATTERN = /(?:DEVBENCH_.*(?:CONTROLLER|MIRROR|CAPABILITY|CREDENTIAL|SECRET)|GIT_ASKPASS|SSH_ASKPASS|SSH_AUTH_SOCK|AZURE_DEVOPS_EXT_PAT)/i;
// Production Workers must use credentials owned by their isolated OS identity
// (credential store, service profile, or scoped broker), never inherit the
// Gateway's ambient provider/Git secrets. Keep this provider-agnostic so names
// such as CODEUP_ACCESS_TOKEN and ANTHROPIC_API_KEY cannot slip through a
// hand-maintained vendor list.
const AMBIENT_SECRET_ENV_PATTERN = /(?:^|_)(?:TOKEN|SECRET|PASSWORD|PASSWD|APIKEY|API_KEY|ACCESS_KEY|PRIVATE_KEY|CREDENTIAL|CREDENTIALS)(?:_|$)/i;
const LAUNCH_SECURITY_ENV_PATTERN = /(?:LAUNCHER|SIGNING|SIGNATURE|TRUST(?:_ANCHOR)?|PRIVATE_?KEY|PUBLIC_?KEY|WORKER_?SPEC|DEVBENCH_WORKER_(?:IDENTITY|ATTESTED)|DEVBENCH_TEST_OS_IDENTITY)/i;
const GATEWAY_PROFILE_ENV_PATTERN = /^(?:HOME|USERPROFILE|HOMEDRIVE|HOMEPATH|APPDATA|LOCALAPPDATA|XDG_(?:CONFIG|CACHE|DATA)_HOME|CODEX_HOME|CLAUDE_CONFIG_DIR|GEMINI_HOME|NPM_CONFIG_USERCONFIG|GIT_CONFIG_GLOBAL)$/i;
const GIT_ROUTING_ENV_PATTERN = /^(?:GIT_DIR|GIT_WORK_TREE|GIT_COMMON_DIR|GIT_OBJECT_DIRECTORY|GIT_ALTERNATE_OBJECT_DIRECTORIES|GIT_CONFIG_(?:GLOBAL|SYSTEM|NOSYSTEM|COUNT)|GIT_CEILING_DIRECTORIES|GIT_INDEX_FILE)$/i;
const WORKER_CLI_IDS = Object.freeze(["claude", "codex", "gemini"]);
const SERVICE_DIR = path.dirname(fileURLToPath(import.meta.url));

export const WORKER_LAUNCH_ENVELOPE_SCHEMA = "devbench.worker-launch-envelope.v1";
export const WORKER_LAUNCH_PAYLOAD_SCHEMA = "devbench.worker-launch-spec.v1";
export const WORKER_LEASE_RELEASE_SCHEMA = "devbench.worker-lease-release.v2";
export const NATIVE_LAUNCHER_PROCESS_IDENTITY_SCHEMA =
  "devbench.native-launcher-process-identity.v2";
export const WORKER_LAUNCH_ENVELOPE_TTL_MS = 30_000;
export const WORKER_LAUNCH_ENVELOPE_MAX_TTL_MS = 60_000;
export const WORKER_LEASE_RELEASE_TTL_MS = 10_000;
export const WORKER_LAUNCH_TRUST_ANCHOR_PATH = path.resolve(
  SERVICE_DIR,
  "../config/worker-launcher-public.pem",
);
export const WORKER_LAUNCH_PRIVATE_KEY_PATH = path.resolve(
  SERVICE_DIR,
  "../config/worker-launcher-private.pem",
);
export const WORKER_LAUNCHER_CONFIG_PATH = path.resolve(
  SERVICE_DIR,
  "../config/worker-launcher.json",
);
export const ISOLATED_WORKER_BROKER_PATH = path.resolve(
  SERVICE_DIR,
  "isolated-worker-broker.mjs",
);
export const WORKER_LAUNCH_CONSUME_HELPER_PATH = path.resolve(
  SERVICE_DIR,
  "worker-launch-consume-helper.mjs",
);
export const WORKER_LAUNCHER_CONFIG_SCHEMA = "devbench.worker-launcher-config.v3";
const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/;
const LAUNCHER_INSTANCE_EVIDENCE_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const WINDOWS_SID_PATTERN = /^(?:sid:)?S-\d(?:-\d+)+$/i;
const UNIX_UID_PATTERN = /^uid:(?:0|[1-9][0-9]*)$/;

function fixedWindowsSystemTool(relativePath) {
  const systemRoot = path.win32.resolve(String(
    process.env.SystemRoot || `${process.env.SystemDrive || "C:"}\\Windows`,
  ));
  const target = path.win32.resolve(systemRoot, "System32", relativePath);
  if (
    path.win32.basename(systemRoot).toLowerCase() !== "windows"
    || !target.toLowerCase().startsWith(`${systemRoot.toLowerCase()}\\system32\\`)
  ) {
    const error = new Error("无法解析固定 Windows SystemRoot 系统工具");
    error.code = "WORKER_SYSTEM_TOOL_PATH_INVALID";
    throw error;
  }
  return target;
}

const WINDOWS_WHOAMI_PATH = fixedWindowsSystemTool("whoami.exe");
const WINDOWS_POWERSHELL_PATH = fixedWindowsSystemTool(
  "WindowsPowerShell\\v1.0\\powershell.exe",
);

export function platformSupportsStrongWorkerIsolation(platform = process.platform) {
  // The current Windows design requires a distinct SID plus administrator-
  // attested ACLs. On Unix, the existing supervisor has no cgroup, namespace,
  // MAC, or equivalent kernel boundary, so a hostile child can double-fork,
  // setsid, and clear its environment. It must never be reported as STRONG.
  return String(platform || "").toLowerCase() === "win32";
}

function normalizedPath(value) {
  const resolved = path.resolve(String(value || ""));
  const normalized = resolved.replace(/[\\/]+/g, "/").replace(/\/+$/, "");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

export function pathIsInside(root, candidate) {
  const parent = normalizedPath(root);
  const child = normalizedPath(candidate);
  return !!parent && !!child && (child === parent || child.startsWith(`${parent}/`));
}

function existingAncestors(target) {
  const resolved = path.resolve(target);
  const parsed = path.parse(resolved);
  const relative = resolved.slice(parsed.root.length).split(path.sep).filter(Boolean);
  const out = fs.existsSync(parsed.root) ? [parsed.root] : [];
  let cursor = parsed.root;
  for (const segment of relative) {
    cursor = path.join(cursor, segment);
    if (!fs.existsSync(cursor)) break;
    out.push(cursor);
  }
  return out;
}

/**
 * Resolve an existing path without accepting a symlink/junction/reparse escape.
 * Every existing path segment is inspected because checking only the leaf lets a
 * parent junction redirect the grant outside its declared boundary.
 */
export function canonicalWorkerPath(value, { mustExist = true } = {}) {
  const raw = String(value || "").trim();
  if (!raw || !path.isAbsolute(raw)) {
    const error = new Error("Worker 授权路径必须是绝对路径");
    error.code = "WORKER_GRANT_PATH_INVALID";
    throw error;
  }
  const resolved = path.resolve(raw);
  for (const segment of existingAncestors(resolved)) {
    const stat = fs.lstatSync(segment);
    if (stat.isSymbolicLink()) {
      const error = new Error(`Worker 授权路径包含符号链接或目录联接：${segment}`);
      error.code = "WORKER_GRANT_PATH_LINK";
      throw error;
    }
  }
  if (mustExist && !fs.existsSync(resolved)) {
    const error = new Error(`Worker 授权路径不存在：${resolved}`);
    error.code = "WORKER_GRANT_PATH_MISSING";
    throw error;
  }
  return fs.existsSync(resolved) ? fs.realpathSync.native(resolved) : resolved;
}

function uniqueCanonicalPaths(values, options = {}) {
  const seen = new Set();
  const out = [];
  for (const value of Array.isArray(values) ? values : []) {
    if (!value) continue;
    const canonical = canonicalWorkerPath(value, options);
    const key = normalizedPath(canonical);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(canonical);
  }
  return out;
}

function canonicalBoundarySentinels(values, deniedRoots) {
  const deniedByKey = new Map(deniedRoots.map((root) => [normalizedPath(root), root]));
  const seen = new Set();
  const out = [];
  for (const value of Array.isArray(values) ? values : []) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      const error = new Error("Worker 边界哨兵必须声明 deniedRoot 与 sentinelPath");
      error.code = "WORKER_GRANT_BOUNDARY_SENTINEL_INVALID";
      throw error;
    }
    const deniedRoot = canonicalWorkerPath(value.deniedRoot, { mustExist: false });
    const canonicalDenied = deniedByKey.get(normalizedPath(deniedRoot));
    const sentinelPath = canonicalWorkerPath(value.sentinelPath);
    const parent = path.dirname(sentinelPath);
    let stat;
    try {
      stat = fs.lstatSync(sentinelPath);
    } catch {
      stat = null;
    }
    if (
      !canonicalDenied
      || !stat?.isFile()
      || stat.isSymbolicLink()
      || !path.basename(sentinelPath).startsWith(".devbench-worker-boundary-")
      || !pathIsInside(parent, canonicalDenied)
      || normalizedPath(parent) === normalizedPath(canonicalDenied)
      || seen.has(normalizedPath(canonicalDenied))
    ) {
      const error = new Error("Worker 边界哨兵必须是禁止根父链中的唯一固定非链接文件");
      error.code = "WORKER_GRANT_BOUNDARY_SENTINEL_INVALID";
      throw error;
    }
    seen.add(normalizedPath(canonicalDenied));
    out.push(Object.freeze({
      deniedRoot: canonicalDenied,
      sentinelPath,
    }));
  }
  return out;
}

function canonicalInaccessibleEntries(values, inaccessibleRoots) {
  const rootsByKey = new Map(
    inaccessibleRoots.map((root) => [normalizedPath(root), root]),
  );
  if (rootsByKey.size === 0) {
    if (Array.isArray(values) && values.length > 0) {
      const error = new Error("没有 inaccessibleRoot 时不得声明 inaccessible entry");
      error.code = "WORKER_GRANT_INACCESSIBLE_ENTRY_INVALID";
      throw error;
    }
    return [];
  }
  const seen = new Set();
  const rootEntries = new Set();
  const out = [];
  for (const value of Array.isArray(values) ? values : []) {
    if (
      !value
      || typeof value !== "object"
      || Array.isArray(value)
      || JSON.stringify(Object.keys(value).sort())
        !== JSON.stringify(["path", "root", "type"])
    ) {
      const error = new Error("Worker inaccessible entry 必须精确声明 root/path/type");
      error.code = "WORKER_GRANT_INACCESSIBLE_ENTRY_INVALID";
      throw error;
    }
    const rawRoot = String(value.root || "").trim();
    const rawPath = String(value.path || "").trim();
    const type = String(value.type || "").trim();
    if (
      !path.isAbsolute(rawRoot)
      || !path.isAbsolute(rawPath)
      || !["directory", "file", "missing"].includes(type)
    ) {
      const error = new Error("Worker inaccessible entry 路径或类型无效");
      error.code = "WORKER_GRANT_INACCESSIBLE_ENTRY_INVALID";
      throw error;
    }
    const root = rootsByKey.get(normalizedPath(rawRoot));
    const entryPath = path.resolve(rawPath);
    const entryKey = `${normalizedPath(rawRoot)}\0${normalizedPath(entryPath)}`;
    if (
      !root
      || !pathIsInside(root, entryPath)
      || seen.has(entryKey)
      || (type === "missing" && normalizedPath(root) !== normalizedPath(entryPath))
    ) {
      const error = new Error("Worker inaccessible entry 未绑定唯一禁止访问根");
      error.code = "WORKER_GRANT_INACCESSIBLE_ENTRY_INVALID";
      throw error;
    }
    seen.add(entryKey);
    if (normalizedPath(root) === normalizedPath(entryPath)) {
      if (rootEntries.has(normalizedPath(root))) {
        const error = new Error("Worker inaccessible root entry 重复");
        error.code = "WORKER_GRANT_INACCESSIBLE_ENTRY_INVALID";
        throw error;
      }
      rootEntries.add(normalizedPath(root));
    }
    out.push(Object.freeze({ root, path: entryPath, type }));
  }
  if (
    out.length === 0
    || rootEntries.size !== rootsByKey.size
    || [...rootsByKey.keys()].some((rootKey) => !rootEntries.has(rootKey))
  ) {
    const error = new Error("每个 inaccessibleRoot 必须包含 Controller 枚举的根条目");
    error.code = "WORKER_GRANT_INACCESSIBLE_ENTRY_REQUIRED";
    throw error;
  }
  return out.sort((left, right) => (
    normalizedPath(left.root).localeCompare(normalizedPath(right.root))
    || normalizedPath(left.path).localeCompare(normalizedPath(right.path))
  ));
}

export function normalizeLauncherInstanceEvidence(value) {
  const evidence = String(value || "").trim();
  if (
    !LAUNCHER_INSTANCE_EVIDENCE_PATTERN.test(evidence)
    || Buffer.from(evidence, "base64url").length !== 32
  ) {
    const error = new Error("native launcher instance channel evidence 必须是 32 字节 base64url");
    error.code = "WORKER_LAUNCHER_INSTANCE_EVIDENCE_INVALID";
    throw error;
  }
  return evidence;
}

function currentWindowsSid() {
  try {
    const stdout = execFileSync(
      WINDOWS_WHOAMI_PATH,
      ["/user", "/fo", "csv", "/nh"],
      {
        encoding: "utf8",
        windowsHide: true,
        timeout: 5000,
        maxBuffer: 64 * 1024,
      },
    );
    const matches = String(stdout || "").match(/"([^"]*)","(S-[^"]+)"/i);
    return matches?.[2] ? `sid:${matches[2].toUpperCase()}` : "";
  } catch {
    return "";
  }
}

export function currentOsIdentity() {
  const testOverride = process.env.NODE_ENV === "test"
    ? String(process.env.DEVBENCH_TEST_OS_IDENTITY || "").trim()
    : "";
  if (testOverride) return testOverride;
  if (process.platform === "win32") {
    return currentWindowsSid() || `win-user:${String(process.env.USERNAME || os.userInfo().username || "").toLowerCase()}`;
  }
  if (typeof process.getuid === "function") return `uid:${process.getuid()}`;
  return `user:${String(os.userInfo().username || "").toLowerCase()}`;
}

function assertEd25519Key(key, label) {
  if (key?.asymmetricKeyType !== "ed25519") {
    const error = new Error(`${label} 必须是 Ed25519 密钥`);
    error.code = "WORKER_LAUNCH_KEY_TYPE_INVALID";
    throw error;
  }
  return key;
}

export function workerLauncherKeyId(publicKey) {
  const key = assertEd25519Key(
    publicKey?.type === "public" ? publicKey : createPublicKey(publicKey),
    "Worker launcher 信任锚",
  );
  const der = key.export({ type: "spki", format: "der" });
  return `ed25519:${createHash("sha256").update(der).digest("base64url")}`;
}

export function launcherEnvelopeSigningBytes(envelope = {}) {
  return Buffer.from([
    String(envelope.schema || ""),
    String(envelope.version || ""),
    String(envelope.algorithm || ""),
    String(envelope.keyId || ""),
    String(envelope.issuedAt || ""),
    String(envelope.expiresAt || ""),
    String(envelope.nonce || ""),
    String(envelope.payload || ""),
  ].join("\n"), "utf8");
}

export function workerLeaseReleaseSigningBytes(release = {}) {
  return Buffer.from([
    String(release.schema || ""),
    String(release.version || ""),
    String(release.algorithm || ""),
    String(release.keyId || ""),
    String(release.issuedAt || ""),
    String(release.expiresAt || ""),
    String(release.envelopeSha256 || ""),
    String(release.launchNonce || ""),
    String(release.releaseChallenge || ""),
    String(release.storyId || ""),
    String(release.taskId || ""),
    String(release.workerIdentity || ""),
    String(release.leaseId || ""),
    String(release.launcherPid || ""),
    String(release.launcherProcessIdentity || ""),
    String(release.launcherInstanceEvidence || ""),
  ].join("\n"), "utf8");
}

function assertProtectedPrivateKeyFile(privateKeyPath) {
  const resolved = path.resolve(privateKeyPath);
  if (resolved !== WORKER_LAUNCH_PRIVATE_KEY_PATH) {
    const error = new Error("Worker launcher 私钥只能从固定受保护路径加载");
    error.code = "WORKER_LAUNCH_PRIVATE_KEY_PATH_INVALID";
    throw error;
  }
  let stat;
  try {
    stat = fs.lstatSync(resolved);
  } catch {
    const error = new Error(`未配置 Worker launcher 私钥：${resolved}`);
    error.code = "WORKER_LAUNCH_PRIVATE_KEY_MISSING";
    throw error;
  }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    const error = new Error("Worker launcher 私钥必须是固定路径下的非链接普通文件");
    error.code = "WORKER_LAUNCH_PRIVATE_KEY_INVALID";
    throw error;
  }
  if (normalizedPath(fs.realpathSync.native(resolved)) !== normalizedPath(resolved)) {
    const error = new Error("Worker launcher 私钥固定路径不得经过符号链接或目录联接");
    error.code = "WORKER_LAUNCH_PRIVATE_KEY_LINK";
    throw error;
  }
  if (process.platform !== "win32") {
    if ((stat.mode & 0o077) !== 0
      || (typeof process.getuid === "function" && stat.uid !== process.getuid())) {
      const error = new Error("Worker launcher 私钥必须由 Gateway 身份持有且权限不宽于 0600");
      error.code = "WORKER_LAUNCH_PRIVATE_KEY_PERMISSIONS";
      throw error;
    }
  } else {
    // Reject any write-capable Windows ACE outside Gateway, SYSTEM, and the
    // local Administrators group. The separate Worker identity must never be
    // able to replace or read the signing key.
    const resolvedBase64 = Buffer.from(resolved, "utf8").toString("base64");
    const script = [
      "$ErrorActionPreference='Stop'",
      `$target=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${resolvedBase64}'))`,
      "$acl=Get-Acl -LiteralPath $target",
      "$me=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value",
      "$allowed=@($me,'S-1-5-18','S-1-5-32-544')",
      "$owner=$acl.GetOwner([Security.Principal.SecurityIdentifier]).Value",
      "if($allowed -notcontains $owner){exit 6}",
      "$sensitive=[Security.AccessControl.FileSystemRights]::ReadData -bor [Security.AccessControl.FileSystemRights]::WriteData -bor [Security.AccessControl.FileSystemRights]::AppendData -bor [Security.AccessControl.FileSystemRights]::Delete -bor [Security.AccessControl.FileSystemRights]::ChangePermissions -bor [Security.AccessControl.FileSystemRights]::TakeOwnership",
      "$bad=@($acl.Access | Where-Object {",
      " $_.AccessControlType -eq 'Allow' -and ($_.FileSystemRights -band $sensitive) -ne 0 -and",
      " $allowed -notcontains $_.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value",
      "})",
      "if($bad.Count -gt 0){exit 7}",
    ].join(";");
    try {
      execFileSync(
        WINDOWS_POWERSHELL_PATH,
        ["-NoProfile", "-NonInteractive", "-Command", script],
        { windowsHide: true, timeout: 10_000, stdio: "ignore" },
      );
    } catch {
      const error = new Error("Worker launcher 私钥 ACL 允许非 Gateway 管理身份读取或修改");
      error.code = "WORKER_LAUNCH_PRIVATE_KEY_PERMISSIONS";
      throw error;
    }
  }
  assertManagedPathParentChain(resolved, {
    label: "Worker launcher 私钥 ",
    mutableCode: "WORKER_LAUNCH_PRIVATE_KEY_PERMISSIONS",
    linkCode: "WORKER_LAUNCH_PRIVATE_KEY_LINK",
  });
  return resolved;
}

export function loadWorkerLauncherTrustAnchor({ requireReadOnlyForCurrentIdentity = false } = {}) {
  let stat;
  try {
    stat = fs.lstatSync(WORKER_LAUNCH_TRUST_ANCHOR_PATH);
  } catch {
    const error = new Error(`未配置固定 Worker launcher 信任锚：${WORKER_LAUNCH_TRUST_ANCHOR_PATH}`);
    error.code = "WORKER_LAUNCH_TRUST_ANCHOR_MISSING";
    throw error;
  }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    const error = new Error("Worker launcher 信任锚必须是固定路径下的非链接普通文件");
    error.code = "WORKER_LAUNCH_TRUST_ANCHOR_INVALID";
    throw error;
  }
  if (normalizedPath(fs.realpathSync.native(WORKER_LAUNCH_TRUST_ANCHOR_PATH))
    !== normalizedPath(WORKER_LAUNCH_TRUST_ANCHOR_PATH)) {
    const error = new Error("Worker launcher 信任锚固定路径不得经过符号链接或目录联接");
    error.code = "WORKER_LAUNCH_TRUST_ANCHOR_LINK";
    throw error;
  }
  if (requireReadOnlyForCurrentIdentity) {
    for (const candidate of [
      WORKER_LAUNCH_TRUST_ANCHOR_PATH,
      ...existingAncestors(path.dirname(WORKER_LAUNCH_TRUST_ANCHOR_PATH)),
    ]) {
      try {
        fs.accessSync(candidate, fs.constants.W_OK);
        const error = new Error("当前 Worker 身份可写 launcher 信任锚或其父链");
        error.code = "WORKER_LAUNCH_TRUST_ANCHOR_WRITABLE";
        throw error;
      } catch (error) {
        if (error?.code === "WORKER_LAUNCH_TRUST_ANCHOR_WRITABLE") throw error;
      }
    }
  } else {
    assertManagedFileAcl(WORKER_LAUNCH_TRUST_ANCHOR_PATH, stat);
    assertManagedPathParentChain(WORKER_LAUNCH_TRUST_ANCHOR_PATH, {
      label: "Worker launcher 信任锚 ",
    });
  }
  return assertEd25519Key(
    createPublicKey(readStableManagedFile(
      WORKER_LAUNCH_TRUST_ANCHOR_PATH,
      "Worker launcher 信任锚",
    )),
    "Worker launcher 信任锚",
  );
}

function loadWorkerLauncherSigner(testSigningPrivateKey) {
  if (testSigningPrivateKey !== undefined) {
    if (process.env.NODE_ENV !== "test") {
      const error = new Error("Worker launcher 测试签名密钥仅允许在 NODE_ENV=test 下显式注入");
      error.code = "WORKER_LAUNCH_TEST_KEY_FORBIDDEN";
      throw error;
    }
    const privateKey = assertEd25519Key(
      testSigningPrivateKey?.type === "private"
        ? testSigningPrivateKey
        : createPrivateKey(testSigningPrivateKey),
      "Worker launcher 测试私钥",
    );
    return { privateKey, publicKey: createPublicKey(privateKey) };
  }

  const privateKeyPath = assertProtectedPrivateKeyFile(WORKER_LAUNCH_PRIVATE_KEY_PATH);
  const privateKey = assertEd25519Key(
    createPrivateKey(readStableManagedFile(
      privateKeyPath,
      "Worker launcher 私钥",
    )),
    "Worker launcher 私钥",
  );
  const publicKey = loadWorkerLauncherTrustAnchor();
  const derivedKeyId = workerLauncherKeyId(createPublicKey(privateKey));
  const trustedKeyId = workerLauncherKeyId(publicKey);
  if (derivedKeyId !== trustedKeyId) {
    const error = new Error("Worker launcher 私钥与固定信任锚不匹配");
    error.code = "WORKER_LAUNCH_KEY_MISMATCH";
    throw error;
  }
  return { privateKey, publicKey };
}

export function createSignedWorkerLaunchEnvelope(
  payloadFields = {},
  {
    now = Date.now(),
    ttlMs = WORKER_LAUNCH_ENVELOPE_TTL_MS,
    payloadExpiresAt,
    testSigningPrivateKey,
  } = {},
) {
  const issuedAtMs = Number(now);
  const boundedTtl = Math.min(
    WORKER_LAUNCH_ENVELOPE_MAX_TTL_MS,
    Math.max(1_000, Number(ttlMs) || WORKER_LAUNCH_ENVELOPE_TTL_MS),
  );
  const outerLimit = issuedAtMs + boundedTtl;
  const payloadLimit = Date.parse(payloadExpiresAt || "");
  const expiresAtMs = Number.isFinite(payloadLimit)
    ? Math.min(outerLimit, payloadLimit)
    : outerLimit;
  if (!Number.isFinite(issuedAtMs) || expiresAtMs <= issuedAtMs) {
    const error = new Error("Worker launcher 签名窗口无效或已过期");
    error.code = "WORKER_LAUNCH_ENVELOPE_EXPIRED";
    throw error;
  }

  const { privateKey, publicKey } = loadWorkerLauncherSigner(testSigningPrivateKey);
  const keyId = workerLauncherKeyId(publicKey);
  const nonce = randomUUID();
  const issuedAt = new Date(issuedAtMs).toISOString();
  const expiresAt = new Date(expiresAtMs).toISOString();
  const payload = Buffer.from(JSON.stringify({
    ...payloadFields,
    schema: WORKER_LAUNCH_PAYLOAD_SCHEMA,
    version: 1,
    keyId,
    launchNonce: nonce,
    issuedAt,
    expiresAt,
  }), "utf8").toString("base64url");
  const envelope = {
    schema: WORKER_LAUNCH_ENVELOPE_SCHEMA,
    version: 1,
    algorithm: "Ed25519",
    keyId,
    issuedAt,
    expiresAt,
    nonce,
    payload,
  };
  const signature = sign(null, launcherEnvelopeSigningBytes(envelope), privateKey);
  return Buffer.from(
    JSON.stringify({ ...envelope, signature: signature.toString("base64url") }),
    "utf8",
  ).toString("base64url");
}

/**
 * Create a second, short-lived signature only after the native launcher PID
 * has been persisted in the runtime lease. The initial argv contains merely a
 * unique challenge; seeing it does not let an older same-SID Worker release a
 * new CLI because only the Gateway-owned Ed25519 key can sign this record.
 */
export function createSignedWorkerLeaseRelease(
  encodedLaunchEnvelope,
  {
    leaseId,
    launcherPid,
    launcherProcessIdentity,
    launcherInstanceEvidence,
    now = Date.now(),
    testSigningPrivateKey,
  } = {},
) {
  let envelope;
  let spec;
  try {
    envelope = JSON.parse(
      Buffer.from(String(encodedLaunchEnvelope || ""), "base64url").toString("utf8"),
    );
    spec = JSON.parse(
      Buffer.from(String(envelope.payload || ""), "base64url").toString("utf8"),
    );
  } catch {
    const error = new Error("无法解析待放行的 Worker launch envelope");
    error.code = "WORKER_LEASE_RELEASE_LAUNCH_INVALID";
    throw error;
  }
  const normalizedLeaseId = String(leaseId || "").trim();
  const normalizedProcessIdentity = String(launcherProcessIdentity || "").trim();
  let normalizedInstanceEvidence = "";
  try {
    normalizedInstanceEvidence = normalizeLauncherInstanceEvidence(launcherInstanceEvidence);
  } catch {
    normalizedInstanceEvidence = "";
  }
  const normalizedPid = Number(launcherPid);
  if (
    envelope?.schema !== WORKER_LAUNCH_ENVELOPE_SCHEMA
    || spec?.schema !== WORKER_LAUNCH_PAYLOAD_SCHEMA
    || spec.launchNonce !== envelope.nonce
    || spec.operation !== "cli"
    || !UUID_PATTERN.test(String(spec.releaseChallenge || ""))
    || !String(spec.grant?.storyId || "").trim()
    || !String(spec.taskId || "").trim()
    || !String(spec.expectedIdentity || "").trim()
    || !normalizedLeaseId
    || normalizedLeaseId.length > 1024
    || !Number.isSafeInteger(normalizedPid)
    || normalizedPid <= 0
    || !normalizedProcessIdentity
    || normalizedProcessIdentity.length > 512
    || /[\r\n\0]/.test(normalizedProcessIdentity)
    || !normalizedInstanceEvidence
  ) {
    const error = new Error("Worker lease release 缺少 launch/lease/PID 身份绑定");
    error.code = "WORKER_LEASE_RELEASE_BINDING_INVALID";
    throw error;
  }
  const issuedAtMs = Number(now);
  const launchExpiresAt = Date.parse(String(envelope.expiresAt || ""));
  const expiresAtMs = Math.min(
    issuedAtMs + WORKER_LEASE_RELEASE_TTL_MS,
    launchExpiresAt,
  );
  if (!Number.isFinite(issuedAtMs) || !Number.isFinite(expiresAtMs) || expiresAtMs <= issuedAtMs) {
    const error = new Error("Worker lease release 时间窗口无效或 launch 已过期");
    error.code = "WORKER_LEASE_RELEASE_EXPIRED";
    throw error;
  }
  const { privateKey, publicKey } = loadWorkerLauncherSigner(testSigningPrivateKey);
  const keyId = workerLauncherKeyId(publicKey);
  if (String(envelope.keyId || "") !== keyId || String(spec.keyId || "") !== keyId) {
    const error = new Error("Worker lease release 与 launch 签名密钥不一致");
    error.code = "WORKER_LEASE_RELEASE_KEY_MISMATCH";
    throw error;
  }
  const release = {
    schema: WORKER_LEASE_RELEASE_SCHEMA,
    version: 2,
    algorithm: "Ed25519",
    keyId,
    issuedAt: new Date(issuedAtMs).toISOString(),
    expiresAt: new Date(expiresAtMs).toISOString(),
    envelopeSha256: createHash("sha256")
      .update(Buffer.from(String(encodedLaunchEnvelope), "utf8"))
      .digest("hex"),
    launchNonce: envelope.nonce,
    releaseChallenge: spec.releaseChallenge,
    storyId: String(spec.grant.storyId),
    taskId: String(spec.taskId),
    workerIdentity: String(spec.expectedIdentity).toLowerCase(),
    leaseId: normalizedLeaseId,
    launcherPid: normalizedPid,
    launcherProcessIdentity: normalizedProcessIdentity,
    launcherInstanceEvidence: normalizedInstanceEvidence,
  };
  const signature = sign(null, workerLeaseReleaseSigningBytes(release), privateKey);
  return Buffer.from(JSON.stringify({
    ...release,
    signature: signature.toString("base64url"),
  }), "utf8").toString("base64url");
}

export function signWorkerDeploymentAttestationDocument(
  document,
  { testSigningPrivateKey } = {},
) {
  const { privateKey, publicKey } = loadWorkerLauncherSigner(testSigningPrivateKey);
  const keyId = workerLauncherKeyId(publicKey);
  const signature = sign(
    null,
    workerDeploymentAttestationSigningBytes({
      ...document,
      algorithm: "Ed25519",
      keyId,
    }),
    privateKey,
  );
  return {
    algorithm: "Ed25519",
    keyId,
    signature: signature.toString("base64url"),
  };
}

function cleanExpectedIdentity(value) {
  const identity = String(value || "").trim();
  if (!WINDOWS_SID_PATTERN.test(identity)) return identity;
  return `sid:${identity.replace(/^sid:/i, "").toUpperCase()}`;
}

function workerIdentityPattern(platform = process.platform) {
  return String(platform || "").toLowerCase() === "win32"
    ? WINDOWS_SID_PATTERN
    : UNIX_UID_PATTERN;
}

function workerLauncherConfigError(message, code = "WORKER_LAUNCHER_CONFIG_INVALID") {
  const error = new Error(message);
  error.code = code;
  return error;
}

function assertNoLinkedPathSegments(target, label) {
  const resolved = path.resolve(target);
  for (const segment of existingAncestors(resolved)) {
    const stat = fs.lstatSync(segment);
    if (stat.isSymbolicLink()) {
      throw workerLauncherConfigError(
        `${label} 路径包含符号链接或目录联接：${segment}`,
        "WORKER_LAUNCHER_PATH_LINK",
      );
    }
  }
  return resolved;
}

function assertManagedRegularFile(target, label) {
  const resolved = assertNoLinkedPathSegments(target, label);
  let stat;
  try {
    stat = fs.lstatSync(resolved);
  } catch {
    throw workerLauncherConfigError(`${label} 不存在：${resolved}`, "WORKER_LAUNCHER_FILE_MISSING");
  }
  if (!stat.isFile() || stat.isSymbolicLink() || Number(stat.nlink || 1) !== 1) {
    throw workerLauncherConfigError(
      `${label} 必须是非链接、非硬链接的单一普通文件`,
      "WORKER_LAUNCHER_FILE_INVALID",
    );
  }
  if (normalizedPath(fs.realpathSync.native(resolved)) !== normalizedPath(resolved)) {
    throw workerLauncherConfigError(
      `${label} realpath 与受管路径不一致`,
      "WORKER_LAUNCHER_PATH_LINK",
    );
  }
  return { resolved, stat };
}

function assertWindowsManagedFileAcl(target, gatewayIdentity) {
  const gatewaySid = cleanExpectedIdentity(gatewayIdentity).replace(/^sid:/i, "").toUpperCase();
  if (!WINDOWS_SID_PATTERN.test(gatewaySid)) {
    throw workerLauncherConfigError(
      "无法取得 Gateway Windows SID，不能验证 launcher ACL",
      "WORKER_LAUNCHER_GATEWAY_SID_INVALID",
    );
  }
  const targetBase64 = Buffer.from(target, "utf8").toString("base64");
  const script = [
    "$ErrorActionPreference='Stop'",
    `$target=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${targetBase64}'))`,
    `$gateway='${gatewaySid}'`,
    "$acl=Get-Acl -LiteralPath $target",
    "$trusted=([Security.Principal.NTAccount]'NT SERVICE\\TrustedInstaller').Translate([Security.Principal.SecurityIdentifier]).Value.ToUpperInvariant()",
    "$allowed=@($gateway,'S-1-5-18','S-1-5-32-544',$trusted)",
    "$owner=$acl.GetOwner([Security.Principal.SecurityIdentifier]).Value",
    "if($allowed -notcontains $owner.ToUpperInvariant()){exit 11}",
    "$write=[Security.AccessControl.FileSystemRights]::WriteData -bor [Security.AccessControl.FileSystemRights]::CreateFiles -bor [Security.AccessControl.FileSystemRights]::CreateDirectories -bor [Security.AccessControl.FileSystemRights]::AppendData -bor [Security.AccessControl.FileSystemRights]::Delete -bor [Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles -bor [Security.AccessControl.FileSystemRights]::WriteAttributes -bor [Security.AccessControl.FileSystemRights]::WriteExtendedAttributes -bor [Security.AccessControl.FileSystemRights]::ChangePermissions -bor [Security.AccessControl.FileSystemRights]::TakeOwnership",
    "$bad=@($acl.Access | ForEach-Object {",
    " if($_.AccessControlType -eq 'Allow' -and ($_.FileSystemRights -band $write) -ne 0){",
    "  $sid=$_.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value.ToUpperInvariant()",
    "  if($allowed -notcontains $sid){$_}",
    " }",
    "})",
    "if($bad.Count -gt 0){exit 12}",
  ].join(";");
  try {
    execFileSync(
      WINDOWS_POWERSHELL_PATH,
      ["-NoProfile", "-NonInteractive", "-Command", script],
      { windowsHide: true, timeout: 10_000, encoding: "utf8" },
    );
  } catch (cause) {
    const detail = String(cause?.stderr || "").trim().replace(/\s+/g, " ").slice(0, 240);
    throw workerLauncherConfigError(
      `Worker launcher 配置或程序的 owner/DACL 允许非 Gateway 管理身份修改（acl-check=${cause?.status ?? "error"}${detail ? `: ${detail}` : ""}）`,
      "WORKER_LAUNCHER_ACL_UNSAFE",
    );
  }
}

function assertPosixManagedFileMode(stat) {
  if ((stat.mode & 0o022) !== 0
    || (typeof process.getuid === "function" && stat.uid !== process.getuid())) {
    throw workerLauncherConfigError(
      "Worker launcher 配置或程序必须由 Gateway 身份持有且不得允许 group/other 写入",
      "WORKER_LAUNCHER_ACL_UNSAFE",
    );
  }
}

function assertManagedFileAcl(
  target,
  stat,
  {
    platform = process.platform,
    gatewayIdentity = currentOsIdentity(),
    aclVerifier,
  } = {},
) {
  if (aclVerifier !== undefined) {
    if (process.env.NODE_ENV !== "test") {
      throw workerLauncherConfigError(
        "launcher ACL 测试验证器仅允许 NODE_ENV=test",
        "WORKER_LAUNCHER_TEST_ACL_FORBIDDEN",
      );
    }
    if (aclVerifier(target, { platform, gatewayIdentity, stat }) !== true) {
      throw workerLauncherConfigError(
        "Worker launcher 配置或程序 ACL 验证失败",
        "WORKER_LAUNCHER_ACL_UNSAFE",
      );
    }
    return;
  }
  if (String(platform).toLowerCase() === "win32") {
    assertWindowsManagedFileAcl(target, gatewayIdentity);
  } else {
    assertPosixManagedFileMode(stat);
  }
}

function assertManagedPathParentChain(
  target,
  {
    platform = process.platform,
    gatewayIdentity = currentOsIdentity(),
    aclVerifier,
    label = "Worker 受管文件",
    linkCode = "WORKER_LAUNCHER_PARENT_LINK",
    mutableCode = "WORKER_LAUNCHER_PARENT_MUTABLE",
  } = {},
) {
  for (const segment of existingAncestors(path.dirname(path.resolve(target)))) {
    const stat = fs.lstatSync(segment);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw workerLauncherConfigError(
        `${label}父链包含非目录、符号链接或目录联接：${segment}`,
        linkCode,
      );
    }
    if (aclVerifier !== undefined) {
      if (aclVerifier(segment, {
        platform,
        gatewayIdentity,
        stat,
        parent: true,
        label,
      }) !== true) {
        throw workerLauncherConfigError(
          `${label}父链 ACL 验证失败：${segment}`,
          mutableCode,
        );
      }
    } else if (String(platform).toLowerCase() === "win32") {
      try {
        assertManagedFileAcl(segment, stat, {
          platform,
          gatewayIdentity,
        });
      } catch (error) {
        throw workerLauncherConfigError(
          `${label}父链允许非管理身份创建、替换或删除子项：${segment}`,
          mutableCode,
        );
      }
    } else {
      const currentUid = typeof process.getuid === "function" ? process.getuid() : null;
      if (
        (stat.mode & 0o022) !== 0
        || (currentUid !== null && stat.uid !== currentUid && stat.uid !== 0)
      ) {
        throw workerLauncherConfigError(
          `${label}父链必须由 root/Gateway uid 持有且不得允许 group/other 修改：${segment}`,
          mutableCode,
        );
      }
    }
  }
}

function assertManagedCliParentChain(target, options = {}) {
  try {
    assertManagedPathParentChain(target, {
      ...options,
      label: "Worker CLI ",
      linkCode: "WORKER_CLI_PARENT_LINK",
      mutableCode: "WORKER_CLI_PARENT_MUTABLE",
    });
  } catch (error) {
    if (
      error?.code === "WORKER_CLI_PARENT_LINK"
      || error?.code === "WORKER_CLI_PARENT_MUTABLE"
    ) {
      throw error;
    }
    throw workerLauncherConfigError(
      error?.message || "Worker CLI 父链验证失败",
      "WORKER_CLI_PARENT_MUTABLE",
    );
  }
}

function sameFileIdentity(left, right) {
  return !!left
    && !!right
    && left.isFile()
    && right.isFile()
    && !left.isSymbolicLink()
    && !right.isSymbolicLink()
    && Number(left.nlink || 1) === 1
    && Number(right.nlink || 1) === 1
    && Number(left.dev) === Number(right.dev)
    && Number(left.ino) === Number(right.ino)
    && Number(left.size) === Number(right.size)
    && Number(left.mtimeMs) === Number(right.mtimeMs)
    && Number(left.ctimeMs) === Number(right.ctimeMs);
}

function readStableManagedFile(target, label) {
  const resolved = path.resolve(target);
  const beforePath = fs.lstatSync(resolved);
  const noFollow = Number(fs.constants.O_NOFOLLOW || 0);
  let descriptor;
  try {
    descriptor = fs.openSync(resolved, fs.constants.O_RDONLY | noFollow);
    const beforeDescriptor = fs.fstatSync(descriptor);
    if (!sameFileIdentity(beforePath, beforeDescriptor)) {
      throw workerLauncherConfigError(
        `${label}在打开时发生身份漂移`,
        "WORKER_LAUNCHER_FILE_RACE",
      );
    }
    const bytes = fs.readFileSync(descriptor);
    const afterDescriptor = fs.fstatSync(descriptor);
    const afterPath = fs.lstatSync(resolved);
    if (
      !sameFileIdentity(beforeDescriptor, afterDescriptor)
      || !sameFileIdentity(afterDescriptor, afterPath)
    ) {
      throw workerLauncherConfigError(
        `${label}在读取期间被修改或替换`,
        "WORKER_LAUNCHER_FILE_RACE",
      );
    }
    return bytes;
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function configuredCliDescriptorShapeValid(descriptor) {
  if (!descriptor || typeof descriptor !== "object" || Array.isArray(descriptor)) return false;
  if (descriptor.mode === "native") {
    return JSON.stringify(Object.keys(descriptor).sort())
        === JSON.stringify(["executablePath", "executableSha256", "mode"])
      && path.isAbsolute(String(descriptor.executablePath || ""))
      && SHA256_HEX_PATTERN.test(String(descriptor.executableSha256 || ""));
  }
  if (descriptor.mode === "node-entry") {
    return JSON.stringify(Object.keys(descriptor).sort())
        === JSON.stringify(["entryPath", "entrySha256", "mode", "nodePath", "nodeSha256"])
      && path.isAbsolute(String(descriptor.nodePath || ""))
      && path.isAbsolute(String(descriptor.entryPath || ""))
      && SHA256_HEX_PATTERN.test(String(descriptor.nodeSha256 || ""))
      && SHA256_HEX_PATTERN.test(String(descriptor.entrySha256 || ""));
  }
  return false;
}

function runtimeCliDescriptorShapeValid(descriptor, id = descriptor?.id) {
  if (
    !descriptor
    || typeof descriptor !== "object"
    || Array.isArray(descriptor)
    || descriptor.id !== id
    || !WORKER_CLI_IDS.includes(String(id || ""))
  ) return false;
  if (descriptor.mode === "native") {
    return JSON.stringify(Object.keys(descriptor).sort())
        === JSON.stringify(["executablePath", "executableSha256", "id", "mode"])
      && path.isAbsolute(String(descriptor.executablePath || ""))
      && SHA256_HEX_PATTERN.test(String(descriptor.executableSha256 || ""));
  }
  if (descriptor.mode === "node-entry") {
    return JSON.stringify(Object.keys(descriptor).sort())
        === JSON.stringify(["entryPath", "entrySha256", "id", "mode", "nodePath", "nodeSha256"])
      && path.isAbsolute(String(descriptor.nodePath || ""))
      && path.isAbsolute(String(descriptor.entryPath || ""))
      && SHA256_HEX_PATTERN.test(String(descriptor.nodeSha256 || ""))
      && SHA256_HEX_PATTERN.test(String(descriptor.entrySha256 || ""));
  }
  return false;
}

/**
 * Load and verify a managed launcher declaration. Production callers must use
 * WORKER_LAUNCHER_CONFIG_PATH; the path parameter exists for isolated tests and
 * deployment diagnostics only and is never derived from a request or env var.
 */
export function loadManagedWorkerLauncherConfig(
  configPath = WORKER_LAUNCHER_CONFIG_PATH,
  {
    storyId,
    platform = process.platform,
    gatewayIdentity = currentOsIdentity(),
    aclVerifier,
    parentAclVerifier,
    trustedBrokerPath = ISOLATED_WORKER_BROKER_PATH,
    trustedConsumeHelperPath = WORKER_LAUNCH_CONSUME_HELPER_PATH,
  } = {},
) {
  if (parentAclVerifier !== undefined && process.env.NODE_ENV !== "test") {
    throw workerLauncherConfigError(
      "Worker CLI 父链 ACL 测试验证器仅允许 NODE_ENV=test",
      "WORKER_LAUNCHER_TEST_ACL_FORBIDDEN",
    );
  }
  if (
    normalizedPath(trustedBrokerPath) !== normalizedPath(ISOLATED_WORKER_BROKER_PATH)
    && process.env.NODE_ENV !== "test"
  ) {
    throw workerLauncherConfigError(
      "Worker launcher broker 测试路径仅允许 NODE_ENV=test",
      "WORKER_LAUNCHER_TEST_BROKER_FORBIDDEN",
    );
  }
  if (
    normalizedPath(trustedConsumeHelperPath) !== normalizedPath(WORKER_LAUNCH_CONSUME_HELPER_PATH)
    && process.env.NODE_ENV !== "test"
  ) {
    throw workerLauncherConfigError(
      "Worker launcher nonce helper 测试路径仅允许 NODE_ENV=test",
      "WORKER_LAUNCHER_TEST_CONSUME_HELPER_FORBIDDEN",
    );
  }
  const fixedConfigPath = path.resolve(configPath);
  const configFile = assertManagedRegularFile(fixedConfigPath, "Worker launcher 受管配置");
  assertManagedFileAcl(configFile.resolved, configFile.stat, {
    platform,
    gatewayIdentity,
    aclVerifier,
  });
  assertManagedPathParentChain(configFile.resolved, {
    platform,
    gatewayIdentity,
    aclVerifier: parentAclVerifier ?? aclVerifier,
    label: "Worker launcher 受管配置 ",
  });
  const configBytes = readStableManagedFile(
    configFile.resolved,
    "Worker launcher 受管配置",
  );

  let config;
  try {
    config = JSON.parse(configBytes.toString("utf8"));
  } catch (error) {
    throw workerLauncherConfigError(
      `Worker launcher 受管配置 JSON 无效：${error.message}`,
      "WORKER_LAUNCHER_CONFIG_JSON_INVALID",
    );
  }
  const expectedKeys = [
    "args",
    "brokerPath",
    "brokerSha256",
    "cliAllowlist",
    "command",
    "consumeHelperPath",
    "consumeHelperSha256",
    "expectedIdentity",
    "identityScope",
    "launcherSha256",
    "schema",
    "version",
  ];
  if (!config || typeof config !== "object" || Array.isArray(config)
    || JSON.stringify(Object.keys(config).sort()) !== JSON.stringify(expectedKeys)
    || config.schema !== WORKER_LAUNCHER_CONFIG_SCHEMA
    || config.version !== 1
    || config.identityScope !== "per-story"
    || !Array.isArray(config.args)
    || config.args.some((item) => typeof item !== "string")
    || !config.cliAllowlist
    || typeof config.cliAllowlist !== "object"
    || Array.isArray(config.cliAllowlist)
    || Object.keys(config.cliAllowlist).length === 0
    || Object.keys(config.cliAllowlist).some((id) => !WORKER_CLI_IDS.includes(id))
    || Object.values(config.cliAllowlist).some(
      (descriptor) => !configuredCliDescriptorShapeValid(descriptor),
    )
    || !SHA256_HEX_PATTERN.test(String(config.brokerSha256 || ""))
    || !SHA256_HEX_PATTERN.test(String(config.consumeHelperSha256 || ""))
    || !config.expectedIdentity
    || typeof config.expectedIdentity !== "object"
    || Array.isArray(config.expectedIdentity)
    || !SHA256_HEX_PATTERN.test(String(config.launcherSha256 || ""))) {
    throw workerLauncherConfigError(
      "Worker launcher 受管配置 schema 无效；生产环境要求 identityScope=per-story",
      "WORKER_LAUNCHER_CONFIG_SCHEMA_INVALID",
    );
  }
  const storyIdentityEntries = Object.entries(config.expectedIdentity);
  const identityKeys = new Set();
  const identityPattern = workerIdentityPattern(platform);
  for (const [declaredStoryId, declaredIdentity] of storyIdentityEntries) {
    const normalizedIdentity = cleanExpectedIdentity(declaredIdentity);
    const identityKey = normalizedIdentity.toLowerCase();
    if (!String(declaredStoryId || "").trim()
      || !identityPattern.test(normalizedIdentity)
      || identityKeys.has(identityKey)
      || identityKey === cleanExpectedIdentity(gatewayIdentity).toLowerCase()) {
      throw workerLauncherConfigError(
        "每个故事点必须声明唯一且合法的 Worker OS 身份，并与 Gateway 身份不同",
        "WORKER_LAUNCHER_STORY_IDENTITY_INVALID",
      );
    }
    identityKeys.add(identityKey);
  }
  const configSha256 = createHash("sha256").update(configBytes).digest("hex");
  const workerPolicyDigest = createHash("sha256").update(JSON.stringify(
    storyIdentityEntries
      .map(([declaredStoryId, declaredIdentity]) => [
        String(declaredStoryId),
        cleanExpectedIdentity(declaredIdentity).toLowerCase(),
      ])
      .sort(([left], [right]) => left.localeCompare(right)),
  )).digest("hex");
  const command = String(config.command || "").trim();
  if (!path.isAbsolute(command)) {
    throw workerLauncherConfigError(
      "Worker launcher command 必须是绝对路径",
      "WORKER_LAUNCHER_COMMAND_INVALID",
    );
  }
  const launcherFile = assertManagedRegularFile(command, "Worker launcher 程序");
  const launcherName = path.basename(launcherFile.resolved).toLowerCase();
  if (
    (String(platform).toLowerCase() === "win32" && path.extname(launcherName) !== ".exe")
    || ["runas.exe", "cmd.exe", "powershell.exe", "pwsh.exe", "wscript.exe", "cscript.exe", "mshta.exe"]
      .includes(launcherName)
  ) {
    throw workerLauncherConfigError(
      "Worker launcher 必须是固定的专用原生程序，禁止 runas 或命令解释器",
      "WORKER_LAUNCHER_COMMAND_UNSAFE",
    );
  }
  if (
    String(platform).toLowerCase() !== "win32"
    && (launcherFile.stat.mode & 0o100) === 0
    && !(process.env.NODE_ENV === "test" && aclVerifier !== undefined)
  ) {
    throw workerLauncherConfigError(
      "Unix Worker launcher 必须是 Gateway 所有且 owner 可执行的固定程序",
      "WORKER_LAUNCHER_COMMAND_NOT_EXECUTABLE",
    );
  }
  if (config.args.some((item) => (
    item === "--devbench-worker-spec"
    || item.startsWith("--devbench-worker-spec=")
    || item === "--devbench-worker-operation"
  ))) {
    throw workerLauncherConfigError(
      "Worker launcher 固定参数不得预置 DevBench 签名 payload 标记",
      "WORKER_LAUNCHER_ARGS_UNSAFE",
    );
  }
  const brokerPath = String(config.brokerPath || "").trim();
  if (
    !path.isAbsolute(brokerPath)
    || normalizedPath(brokerPath) !== normalizedPath(trustedBrokerPath)
  ) {
    throw workerLauncherConfigError(
      "Worker launcher brokerPath 必须绑定当前部署中的固定 broker 入口",
      "WORKER_LAUNCHER_BROKER_PATH_INVALID",
    );
  }
  const brokerFile = assertManagedRegularFile(brokerPath, "Worker launcher broker");
  assertManagedFileAcl(brokerFile.resolved, brokerFile.stat, {
    platform,
    gatewayIdentity,
    aclVerifier,
  });
  assertManagedPathParentChain(brokerFile.resolved, {
    platform,
    gatewayIdentity,
    aclVerifier: parentAclVerifier ?? aclVerifier,
    label: "Worker launcher broker ",
  });
  const brokerHash = createHash("sha256")
    .update(readStableManagedFile(brokerFile.resolved, "Worker launcher broker"))
    .digest("hex");
  if (brokerHash !== String(config.brokerSha256).toLowerCase()) {
    throw workerLauncherConfigError(
      "Worker launcher broker SHA256 与受管配置不一致",
      "WORKER_LAUNCHER_BROKER_HASH_MISMATCH",
    );
  }
  const consumeHelperPath = String(config.consumeHelperPath || "").trim();
  if (
    !path.isAbsolute(consumeHelperPath)
    || normalizedPath(consumeHelperPath) !== normalizedPath(trustedConsumeHelperPath)
  ) {
    throw workerLauncherConfigError(
      "Worker launcher consumeHelperPath 必须绑定当前部署中的固定 nonce 消费 helper",
      "WORKER_LAUNCHER_CONSUME_HELPER_PATH_INVALID",
    );
  }
  const consumeHelperFile = assertManagedRegularFile(
    consumeHelperPath,
    "Worker launcher nonce 消费 helper",
  );
  assertManagedFileAcl(consumeHelperFile.resolved, consumeHelperFile.stat, {
    platform,
    gatewayIdentity,
    aclVerifier,
  });
  assertManagedPathParentChain(consumeHelperFile.resolved, {
    platform,
    gatewayIdentity,
    aclVerifier: parentAclVerifier ?? aclVerifier,
    label: "Worker launcher nonce helper ",
  });
  const consumeHelperHash = createHash("sha256")
    .update(readStableManagedFile(
      consumeHelperFile.resolved,
      "Worker launcher nonce helper",
    ))
    .digest("hex");
  if (consumeHelperHash !== String(config.consumeHelperSha256).toLowerCase()) {
    throw workerLauncherConfigError(
      "Worker launcher nonce 消费 helper SHA256 与受管配置不一致",
      "WORKER_LAUNCHER_CONSUME_HELPER_HASH_MISMATCH",
    );
  }
  if (
    config.args.length !== 2
    || normalizedPath(config.args[0]) !== normalizedPath(brokerFile.resolved)
    || normalizedPath(config.args[1]) !== normalizedPath(consumeHelperFile.resolved)
  ) {
    throw workerLauncherConfigError(
      "Worker launcher 固定参数必须依次为已校验的 broker 与 nonce helper 绝对路径",
      "WORKER_LAUNCHER_ARGS_UNSAFE",
    );
  }
  assertManagedFileAcl(launcherFile.resolved, launcherFile.stat, {
    platform,
    gatewayIdentity,
    aclVerifier,
  });
  assertManagedPathParentChain(launcherFile.resolved, {
    platform,
    gatewayIdentity,
    aclVerifier: parentAclVerifier ?? aclVerifier,
    label: "Worker native launcher ",
  });
  const actualHash = createHash("sha256")
    .update(readStableManagedFile(launcherFile.resolved, "Worker native launcher"))
    .digest("hex");
  if (actualHash !== String(config.launcherSha256).toLowerCase()) {
    throw workerLauncherConfigError(
      "Worker launcher SHA256 与受管配置不一致",
      "WORKER_LAUNCHER_HASH_MISMATCH",
    );
  }
  const cliAllowlist = {};
  const protectCliFile = (
    target,
    expectedSha256,
    label,
    { executable = false, native = false, allowNode = false } = {},
  ) => {
    const managedFile = assertManagedRegularFile(target, label);
    const baseName = path.basename(managedFile.resolved).toLowerCase();
    let managedBytes;
    if (
      executable
      && String(platform).toLowerCase() !== "win32"
      && (managedFile.stat.mode & 0o100) === 0
      && !(process.env.NODE_ENV === "test" && aclVerifier !== undefined)
    ) {
      throw workerLauncherConfigError(
        `${label} 缺少 owner execute 权限`,
        "WORKER_CLI_EXECUTABLE_UNSAFE",
      );
    }
    if (
      native
      && (
        (String(platform).toLowerCase() === "win32"
          && ![".exe", ".com"].includes(path.extname(baseName)))
        || [
          "bash", "cmd.exe", "powershell.exe", "pwsh",
          "pwsh.exe", "sh", "wscript.exe", "cscript.exe", "mshta.exe",
        ].includes(baseName)
        || (!allowNode && ["node", "node.exe"].includes(baseName))
      )
    ) {
      throw workerLauncherConfigError(
        `${label} 必须是受管原生可执行文件，禁止 shell、解释器或 shebang shim`,
        "WORKER_CLI_EXECUTABLE_UNSAFE",
      );
    }
    assertManagedFileAcl(managedFile.resolved, managedFile.stat, {
      platform,
      gatewayIdentity,
      aclVerifier,
    });
    assertManagedCliParentChain(managedFile.resolved, {
      platform,
      gatewayIdentity,
      aclVerifier: parentAclVerifier ?? aclVerifier,
    });
    managedBytes = readStableManagedFile(managedFile.resolved, label);
    if (
      native
      && managedBytes.subarray(0, 2).toString("utf8") === "#!"
    ) {
      throw workerLauncherConfigError(
        `${label} 必须是受管原生可执行文件，禁止 shebang shim`,
        "WORKER_CLI_EXECUTABLE_UNSAFE",
      );
    }
    const actualSha256 = createHash("sha256").update(managedBytes).digest("hex");
    if (actualSha256 !== String(expectedSha256).toLowerCase()) {
      throw workerLauncherConfigError(
        `${label} SHA256 与受管配置不一致`,
        "WORKER_CLI_HASH_MISMATCH",
      );
    }
    return Object.freeze({
      path: managedFile.resolved,
      sha256: actualSha256,
    });
  };
  for (const id of Object.keys(config.cliAllowlist).sort()) {
    const configuredCli = config.cliAllowlist[id];
    if (configuredCli.mode === "native") {
      const executable = protectCliFile(
        configuredCli.executablePath,
        configuredCli.executableSha256,
        `Worker ${id} native CLI`,
        { executable: true, native: true },
      );
      cliAllowlist[id] = Object.freeze({
        id,
        mode: "native",
        executablePath: executable.path,
        executableSha256: executable.sha256,
      });
      continue;
    }
    const node = protectCliFile(
      configuredCli.nodePath,
      configuredCli.nodeSha256,
      `Worker ${id} Node runtime`,
      { executable: true, native: true, allowNode: true },
    );
    if (!["node", "node.exe"].includes(path.basename(node.path).toLowerCase())) {
      throw workerLauncherConfigError(
        `Worker ${id} node-entry 只允许固定 node/node.exe`,
        "WORKER_CLI_NODE_EXECUTABLE_INVALID",
      );
    }
    const entry = protectCliFile(
      configuredCli.entryPath,
      configuredCli.entrySha256,
      `Worker ${id} JS entry`,
    );
    if (![".js", ".cjs", ".mjs"].includes(path.extname(entry.path).toLowerCase())) {
      throw workerLauncherConfigError(
        `Worker ${id} node-entry 只允许固定 JS 入口文件`,
        "WORKER_CLI_ENTRY_INVALID",
      );
    }
    cliAllowlist[id] = Object.freeze({
      id,
      mode: "node-entry",
      nodePath: node.path,
      nodeSha256: node.sha256,
      entryPath: entry.path,
      entrySha256: entry.sha256,
    });
  }

  const normalizedStoryId = String(storyId || "").trim();
  const identity = cleanExpectedIdentity(config.expectedIdentity[normalizedStoryId]);
  if (!normalizedStoryId || !identity || !identityPattern.test(identity)) {
    throw workerLauncherConfigError(
      "受管配置未为当前故事点声明独立 Worker OS 身份",
      "WORKER_LAUNCHER_STORY_IDENTITY_MISSING",
    );
  }
  if (identity.toLowerCase() === cleanExpectedIdentity(gatewayIdentity).toLowerCase()) {
    throw workerLauncherConfigError(
      "Worker 身份与 Gateway 身份相同",
      "WORKER_LAUNCHER_SAME_IDENTITY",
    );
  }
  return {
    configured: true,
    command: launcherFile.resolved,
    args: [...config.args],
    identity,
    identityScope: "per-story",
    attested: true,
    attestationSource: configFile.resolved,
    launcherSha256: actualHash,
    brokerPath: brokerFile.resolved,
    brokerSha256: brokerHash,
    consumeHelperPath: consumeHelperFile.resolved,
    consumeHelperSha256: consumeHelperHash,
    cliAllowlist: Object.freeze(cliAllowlist),
    configSha256,
    workerPolicyDigest,
    gatewayIdentity,
    error: "",
  };
}

/**
 * Ask the already pinned native launcher to query the immutable start identity
 * of the just-spawned launcher client. This deliberately avoids PATH,
 * PowerShell, mutable JS watchdogs, and PID-only leases in the production
 * broker path. The native deployment must implement this exact read-only
 * protocol with platform process handles/APIs.
 */
export function queryManagedWorkerLauncherProcessIdentity(
  launcher,
  pidValue,
  {
    platform = process.platform,
    execFile = execFileSync,
    aclVerifier,
    parentAclVerifier,
  } = {},
) {
  if (
    (execFile !== execFileSync
      || aclVerifier !== undefined
      || parentAclVerifier !== undefined)
    && process.env.NODE_ENV !== "test"
  ) {
    throw workerLauncherConfigError(
      "Worker native launcher 进程身份测试覆盖仅允许 NODE_ENV=test",
      "WORKER_LAUNCHER_PROCESS_IDENTITY_TEST_FORBIDDEN",
    );
  }
  const pid = Number(pidValue);
  const command = String(launcher?.command || "").trim();
  const expectedSha256 = String(launcher?.launcherSha256 || "").toLowerCase();
  if (
    !Number.isSafeInteger(pid)
    || pid <= 0
    || !path.isAbsolute(command)
    || !SHA256_HEX_PATTERN.test(expectedSha256)
  ) {
    throw workerLauncherConfigError(
      "Worker native launcher 进程身份查询缺少固定 binary/PID",
      "WORKER_LAUNCHER_PROCESS_IDENTITY_INPUT_INVALID",
    );
  }
  const managedFile = assertManagedRegularFile(command, "Worker native launcher");
  assertManagedFileAcl(managedFile.resolved, managedFile.stat, {
    platform,
    gatewayIdentity: launcher?.gatewayIdentity || currentOsIdentity(),
    aclVerifier,
  });
  assertManagedPathParentChain(managedFile.resolved, {
    platform,
    gatewayIdentity: launcher?.gatewayIdentity || currentOsIdentity(),
    aclVerifier: parentAclVerifier ?? aclVerifier,
    label: "Worker native launcher ",
  });
  const actualSha256 = createHash("sha256")
    .update(readStableManagedFile(managedFile.resolved, "Worker native launcher"))
    .digest("hex");
  if (actualSha256 !== expectedSha256) {
    throw workerLauncherConfigError(
      "Worker native launcher 在进程身份查询前发生漂移",
      "WORKER_LAUNCHER_HASH_MISMATCH",
    );
  }
  let stdout;
  try {
    stdout = execFile(
      managedFile.resolved,
      [
        "--devbench-query-process-identity-v2",
        String(pid),
        expectedSha256,
      ],
      {
        cwd: SERVICE_DIR,
        env: sanitizeWorkerEnvironment(process.env),
        encoding: "utf8",
        windowsHide: true,
        timeout: 5_000,
        maxBuffer: 16 * 1024,
        stdio: ["ignore", "pipe", "ignore"],
      },
    );
  } catch {
    throw workerLauncherConfigError(
      "固定 native launcher 无法查询目标 launcher client 的启动身份",
      "WORKER_LAUNCHER_PROCESS_IDENTITY_UNAVAILABLE",
    );
  }
  const lines = String(stdout || "").trim().split(/\r?\n/).filter(Boolean);
  const prefix = "DEVBENCH_LAUNCHER_PROCESS_IDENTITY_V2=";
  if (lines.length !== 1 || !lines[0].startsWith(prefix)) {
    throw workerLauncherConfigError(
      "固定 native launcher 返回了无效的进程身份帧",
      "WORKER_LAUNCHER_PROCESS_IDENTITY_INVALID",
    );
  }
  let document;
  try {
    const encoded = lines[0].slice(prefix.length);
    if (!/^[A-Za-z0-9_-]+$/.test(encoded)) throw new Error("invalid encoding");
    document = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  } catch {
    throw workerLauncherConfigError(
      "固定 native launcher 进程身份帧无法解析",
      "WORKER_LAUNCHER_PROCESS_IDENTITY_INVALID",
    );
  }
  if (
    !document
    || typeof document !== "object"
    || Array.isArray(document)
    || JSON.stringify(Object.keys(document).sort())
      !== JSON.stringify([
        "launcherInstanceEvidence",
        "launcherSha256",
        "pid",
        "processIdentity",
        "schema",
        "version",
      ])
    || document.schema !== NATIVE_LAUNCHER_PROCESS_IDENTITY_SCHEMA
    || document.version !== 2
    || document.pid !== pid
    || String(document.launcherSha256 || "").toLowerCase() !== expectedSha256
    || !String(document.processIdentity || "").trim()
    || String(document.processIdentity).length > 512
    || /[\r\n\0]/.test(String(document.processIdentity))
  ) {
    throw workerLauncherConfigError(
      "固定 native launcher 进程身份未绑定 PID、binary hash 和启动实例",
      "WORKER_LAUNCHER_PROCESS_IDENTITY_INVALID",
    );
  }
  let launcherInstanceEvidence;
  try {
    launcherInstanceEvidence = normalizeLauncherInstanceEvidence(
      document.launcherInstanceEvidence,
    );
  } catch {
    throw workerLauncherConfigError(
      "固定 native launcher 未返回受保护 channel 的 32 字节实例证据",
      "WORKER_LAUNCHER_INSTANCE_EVIDENCE_INVALID",
    );
  }
  return Object.freeze({
    processIdentity: String(document.processIdentity),
    launcherInstanceEvidence,
  });
}

function readDevelopmentWorkerLauncherConfig(env = process.env) {
  const command = String(env.DEVBENCH_WORKER_LAUNCHER || "").trim();
  const identity = cleanExpectedIdentity(env.DEVBENCH_WORKER_IDENTITY);
  let args = [];
  const rawArgs = String(env.DEVBENCH_WORKER_LAUNCHER_ARGS_JSON || "").trim();
  if (rawArgs) {
    try {
      const parsed = JSON.parse(rawArgs);
      if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== "string")) {
        throw new Error("must be a string array");
      }
      args = parsed;
    } catch (error) {
      return {
        configured: false,
        command,
        args: [],
        identity,
        attested: false,
        error: `DEVBENCH_WORKER_LAUNCHER_ARGS_JSON 无效：${error.message}`,
      };
    }
  }
  if (!command || !path.isAbsolute(command) || !fs.existsSync(command)) {
    return {
      configured: false,
      command,
      args,
      identity,
      attested: false,
      error: command
        ? "独立 Worker launcher 必须是存在的绝对路径"
        : "未配置独立 Worker launcher",
    };
  }
  let stat;
  try { stat = fs.lstatSync(command); } catch {}
  if (!stat?.isFile() || stat.isSymbolicLink()) {
    return {
      configured: false,
      command,
      args,
      identity,
      attested: false,
      error: "独立 Worker launcher 必须是非链接普通文件",
    };
  }
  const attested = String(env.DEVBENCH_WORKER_LAUNCHER_ATTESTED || "") === "1";
  const gatewayIdentity = currentOsIdentity();
  if (!identity) {
    return { configured: false, command, args, identity, attested, gatewayIdentity, error: "未配置独立 Worker 身份" };
  }
  if (identity.toLowerCase() === gatewayIdentity.toLowerCase()) {
    return {
      configured: false,
      command,
      args,
      identity,
      attested,
      gatewayIdentity,
      error: "Worker 身份与 Gateway 身份相同",
    };
  }
  if (!attested) {
    return {
      configured: false,
      command,
      args,
      identity,
      attested,
      gatewayIdentity,
      error: "Worker launcher 尚未完成管理员侧身份与 ACL 认证",
    };
  }
  return {
    configured: true,
    command: fs.realpathSync.native(command),
    args,
    identity,
    identityScope: "test-global",
    attested,
    gatewayIdentity,
    error: "",
  };
}

export function readWorkerLauncherConfig(
  env = process.env,
  {
    storyId,
    platform = process.platform,
    gatewayIdentity = currentOsIdentity(),
  } = {},
) {
  if (!productionWorkerIsolationRequired(env)) {
    return readDevelopmentWorkerLauncherConfig(env);
  }
  try {
    return loadManagedWorkerLauncherConfig(WORKER_LAUNCHER_CONFIG_PATH, {
      storyId,
      platform,
      gatewayIdentity,
    });
  } catch (error) {
    return {
      configured: false,
      command: "",
      args: [],
      identity: "",
      identityScope: "per-story",
      attested: false,
      gatewayIdentity,
      error: error.message,
      errorCode: error.code || "WORKER_LAUNCHER_CONFIG_INVALID",
    };
  }
}

export function createStoryWorkerGrant({
  storyId,
  repositoryMode,
  cwd,
  topologyCwd = cwd,
  allowedRoots = [],
  writeDeniedRoots = [],
  inaccessibleRoots = [],
  inaccessibleEntries = [],
  boundarySentinels = [],
  workerIdentity = "",
  aclFingerprints = [],
  topologyGeneration = 1,
  readOnly = false,
  now = Date.now(),
  ttlMs = DEFAULT_GRANT_TTL_MS,
} = {}) {
  const mode = String(repositoryMode || "").trim();
  const canonicalCwd = canonicalWorkerPath(cwd);
  const canonicalTopologyCwd = canonicalWorkerPath(topologyCwd);
  const declaredAllowed = uniqueCanonicalPaths(allowedRoots);
  const allowed = declaredAllowed.some((root) => pathIsInside(root, canonicalCwd))
    ? declaredAllowed
    : uniqueCanonicalPaths([canonicalCwd, ...declaredAllowed]);
  // Denied paths are policy objects even while their leaf does not yet exist.
  // Dropping an absent private key/config here would let the Worker create or
  // replace it later under the same still-valid grant.
  const writeDenied = uniqueCanonicalPaths(writeDeniedRoots, { mustExist: false });
  const inaccessible = uniqueCanonicalPaths(inaccessibleRoots, { mustExist: false });
  const inaccessibleManifest = canonicalInaccessibleEntries(
    inaccessibleEntries,
    inaccessible,
  );
  const deniedRoots = [...writeDenied, ...inaccessible];
  const sentinels = canonicalBoundarySentinels(boundarySentinels, deniedRoots);
  if (
    !allowed.some((root) => pathIsInside(root, canonicalCwd))
    || !allowed.some((root) => pathIsInside(root, canonicalTopologyCwd))
  ) {
    const error = new Error("Worker cwd 不在故事点授权目录中");
    error.code = "WORKER_GRANT_CWD_OUTSIDE";
    throw error;
  }
  for (const allowedRoot of allowed) {
    for (const deniedRoot of deniedRoots) {
      if (pathIsInside(allowedRoot, deniedRoot) || pathIsInside(deniedRoot, allowedRoot)) {
        const error = new Error("Worker 允许目录与禁止目录重叠");
        error.code = "WORKER_GRANT_SCOPE_OVERLAP";
        throw error;
      }
    }
  }
  return Object.freeze({
    version: 2,
    grantId: randomUUID(),
    nonce: randomUUID(),
    storyId: String(storyId || "").trim(),
    repositoryMode: mode,
    cwd: canonicalCwd,
    topologyCwd: canonicalTopologyCwd,
    allowedRoots: Object.freeze(allowed),
    writeDeniedRoots: Object.freeze(writeDenied),
    inaccessibleRoots: Object.freeze(inaccessible),
    inaccessibleEntries: Object.freeze(inaccessibleManifest),
    boundarySentinels: Object.freeze(sentinels),
    workerIdentity: String(workerIdentity || "").trim(),
    aclFingerprints: Object.freeze(
      [...new Set((aclFingerprints || []).map(String).filter((value) => /^[0-9a-f]{64}$/.test(value)))],
    ),
    topologyGeneration: Number.isSafeInteger(Number(topologyGeneration))
      && Number(topologyGeneration) >= 1
      ? Number(topologyGeneration)
      : 0,
    readOnly: readOnly === true,
    issuedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + Math.max(30_000, Number(ttlMs) || DEFAULT_GRANT_TTL_MS)).toISOString(),
  });
}

/**
 * Grants are issued when the process is about to start, not when a task first
 * enters a queue. Re-canonicalize every root and rotate both nonce and grant ID
 * so a queued task never extends or reuses an earlier launch capability.
 */
export function renewStoryWorkerGrant(grant = {}, options = {}) {
  return createStoryWorkerGrant({
    storyId: grant.storyId,
    repositoryMode: grant.repositoryMode,
    cwd: grant.cwd,
    topologyCwd: grant.topologyCwd,
    allowedRoots: grant.allowedRoots,
    writeDeniedRoots: grant.writeDeniedRoots,
    inaccessibleRoots: grant.inaccessibleRoots,
    inaccessibleEntries: grant.inaccessibleEntries,
    boundarySentinels: grant.boundarySentinels,
    workerIdentity: grant.workerIdentity,
    aclFingerprints: grant.aclFingerprints,
    topologyGeneration: grant.topologyGeneration,
    readOnly: grant.readOnly === true,
    now: options.now,
    ttlMs: options.ttlMs,
  });
}

export function validateStoryWorkerGrant(task = {}, { now = Date.now() } = {}) {
  const grant = task.workerGrant;
  if (!task.storyScoped) return { ok: true, storyScoped: false, grant: null };
  if (!grant || grant.version !== 2 || !grant.grantId || !grant.nonce) {
    return { ok: false, code: "WORKER_GRANT_REQUIRED", error: "故事点任务缺少结构化 Worker 授权" };
  }
  const taskStoryId = String(task?.artifactScope?.id || task?.storyId || "").trim();
  if (taskStoryId && String(grant.storyId || "").trim() !== taskStoryId) {
    return { ok: false, code: "WORKER_GRANT_STORY_MISMATCH", error: "故事点 Worker 授权与任务身份不一致" };
  }
  if (task.workerRepositoryMode
    && String(task.workerRepositoryMode) !== String(grant.repositoryMode || "")) {
    return { ok: false, code: "WORKER_GRANT_MODE_MISMATCH", error: "故事点仓库模式与 Worker 授权不一致" };
  }
  if (
    grant.repositoryMode === INDEPENDENT_REPOSITORY_MODE
    && (
      !String(grant.workerIdentity || "").trim()
      || !String(grant.topologyCwd || "").trim()
      || !Array.isArray(grant.aclFingerprints)
      || grant.aclFingerprints.length === 0
      || !Number.isSafeInteger(grant.topologyGeneration)
      || grant.topologyGeneration < 1
    )
  ) {
    return {
      ok: false,
      code: "WORKER_GRANT_ACL_ATTESTATION_REQUIRED",
      error: "独立故事仓 Worker 授权缺少 Controller ACL attestation",
    };
  }
  const expiresAt = Date.parse(grant.expiresAt);
  if (!Number.isFinite(expiresAt) || expiresAt <= now) {
    return { ok: false, code: "WORKER_GRANT_EXPIRED", error: "故事点 Worker 授权已过期" };
  }
  let cwd;
  let topologyCwd;
  let allowed;
  let writeDenied;
  let inaccessible;
  let inaccessibleEntries;
  let boundarySentinels;
  try {
    cwd = canonicalWorkerPath(task.cwd);
    topologyCwd = canonicalWorkerPath(grant.topologyCwd || grant.cwd);
    allowed = uniqueCanonicalPaths(grant.allowedRoots);
    writeDenied = uniqueCanonicalPaths(grant.writeDeniedRoots || [], { mustExist: false });
    inaccessible = uniqueCanonicalPaths(grant.inaccessibleRoots || [], { mustExist: false });
    inaccessibleEntries = canonicalInaccessibleEntries(
      grant.inaccessibleEntries || [],
      inaccessible,
    );
    boundarySentinels = canonicalBoundarySentinels(
      grant.boundarySentinels || [],
      [...writeDenied, ...inaccessible],
    );
  } catch (error) {
    return { ok: false, code: error.code || "WORKER_GRANT_INVALID", error: error.message };
  }
  if (normalizedPath(cwd) !== normalizedPath(grant.cwd)
    || !allowed.some((root) => pathIsInside(root, cwd))
    || !allowed.some((root) => pathIsInside(root, topologyCwd))) {
    return { ok: false, code: "WORKER_GRANT_CWD_MISMATCH", error: "故事点 cwd 与 Worker 授权不一致" };
  }
  for (const item of Array.isArray(task.addDirs) ? task.addDirs : []) {
    let candidate;
    try { candidate = canonicalWorkerPath(item); }
    catch (error) { return { ok: false, code: error.code || "WORKER_GRANT_INVALID", error: error.message }; }
    if (!allowed.some((root) => pathIsInside(root, candidate))) {
      return { ok: false, code: "WORKER_GRANT_ADD_DIR_OUTSIDE", error: `附加目录未获故事点授权：${candidate}` };
    }
  }
  for (const allowedRoot of allowed) {
    for (const deniedRoot of [...writeDenied, ...inaccessible]) {
      if (pathIsInside(allowedRoot, deniedRoot) || pathIsInside(deniedRoot, allowedRoot)) {
        return { ok: false, code: "WORKER_GRANT_SCOPE_OVERLAP", error: "Worker 允许目录与禁止目录重叠" };
      }
    }
  }
  return {
    ok: true,
    storyScoped: true,
    grant: {
      ...grant,
      cwd,
      topologyCwd,
      allowedRoots: allowed,
      writeDeniedRoots: writeDenied,
      inaccessibleRoots: inaccessible,
      inaccessibleEntries,
      boundarySentinels,
    },
  };
}

function strictWorkerRequired(task = {}) {
  if (!task.storyScoped) {
    return productionWorkerIsolationRequired()
      && task.commandPolicy !== "read_only";
  }
  if (String(process.env.DEVBENCH_REQUIRE_STRONG_WORKER_ISOLATION || "") === "1") return true;
  if (productionWorkerIsolationRequired()) return true;
  if (task.workerGrant?.repositoryMode === INDEPENDENT_REPOSITORY_MODE) return true;
  return task.commandPolicy !== "read_only"
    && String(process.env.DEVBENCH_ALLOW_LEGACY_ADVISORY_WORKERS || "") !== "1";
}

export function resolveTaskWorkerIsolation(task = {}, { platform = process.platform } = {}) {
  const checked = validateStoryWorkerGrant(task);
  if (!task.storyScoped) {
    if (strictWorkerRequired(task)) {
      return {
        ok: false,
        level: WORKER_ISOLATION_LEVELS.DEGRADED,
        launchMode: "blocked",
        reasonCode: "NON_STORY_MUTATING_CLI_FORBIDDEN",
        error: "生产环境中的可写 CLI 任务必须绑定独立故事点 Worker；Gateway 身份禁止直接执行",
        grant: null,
        launcher: null,
      };
    }
    return {
      ok: true,
      level: WORKER_ISOLATION_LEVELS.ADVISORY,
      launchMode: "direct",
      reasonCode: "NON_STORY_TASK",
      grant: null,
      launcher: null,
    };
  }
  if (!checked.ok) {
    return {
      ok: false,
      level: WORKER_ISOLATION_LEVELS.DEGRADED,
      launchMode: "blocked",
      reasonCode: checked.code,
      error: checked.error,
      grant: null,
      launcher: null,
    };
  }
  const independent = checked.grant.repositoryMode === INDEPENDENT_REPOSITORY_MODE;
  const launcher = readWorkerLauncherConfig(process.env, {
    storyId: checked.grant.storyId,
    platform,
  });
  if (
    independent
    && launcher.configured
    && String(launcher.identity || "").toLowerCase()
      !== String(checked.grant.workerIdentity || "").toLowerCase()
  ) {
    return {
      ok: false,
      level: WORKER_ISOLATION_LEVELS.DEGRADED,
      launchMode: "blocked",
      reasonCode: "WORKER_GRANT_IDENTITY_MISMATCH",
      error: "Worker launcher 身份与 Controller 故事仓 ACL attestation 不一致",
      grant: checked.grant,
      launcher,
    };
  }
  let deploymentAttestation = null;
  if (
    independent
    && launcher.configured
    && platformSupportsStrongWorkerIsolation(platform)
    && productionWorkerIsolationRequired()
  ) {
    deploymentAttestation = verifyWorkerDeploymentAttestation({
      storyId: checked.grant.storyId,
      launcher,
      grant: checked.grant,
      platform,
      gatewayIdentity: launcher.gatewayIdentity,
    });
    if (!deploymentAttestation.ok) {
      return {
        ok: false,
        level: WORKER_ISOLATION_LEVELS.DEGRADED,
        launchMode: "blocked",
        reasonCode: deploymentAttestation.code,
        error: deploymentAttestation.error,
        grant: checked.grant,
        launcher,
        deploymentAttestation,
      };
    }
  }
  if (independent && launcher.configured && platformSupportsStrongWorkerIsolation(platform)) {
    return {
      ok: true,
      level: WORKER_ISOLATION_LEVELS.STRONG,
      launchMode: "broker",
      reasonCode: "SEPARATE_IDENTITY_BROKER",
      grant: checked.grant,
      launcher,
      deploymentAttestation,
    };
  }
  if (strictWorkerRequired(task)) {
    const unsupportedPlatform = independent
      && launcher.configured
      && !platformSupportsStrongWorkerIsolation(platform);
    return {
      ok: false,
      level: WORKER_ISOLATION_LEVELS.DEGRADED,
      launchMode: "blocked",
      reasonCode: unsupportedPlatform
        ? "WORKER_KERNEL_CONTAINMENT_UNAVAILABLE"
        : (independent ? "WORKER_BROKER_UNAVAILABLE" : "LEGACY_SHARED_GIT_DIR"),
      error: unsupportedPlatform
        ? "当前平台没有可验证的内核级 Worker containment，不能授予 STRONG 或危险 CLI 权限"
        : independent
        ? `独立 Worker 不可用：${launcher.error || "未配置"}`
        : "旧 linked worktree 与基础仓库共享 Git common dir，禁止以无限权限 Worker 执行写任务",
      grant: checked.grant,
      launcher,
    };
  }
  return {
    ok: true,
    level: WORKER_ISOLATION_LEVELS.ADVISORY,
    launchMode: "direct",
    reasonCode: independent ? "DEVELOPMENT_DIRECT_MODE" : "LEGACY_READ_ONLY_MODE",
    grant: checked.grant,
    launcher,
  };
}

export function assertTaskWorkerIsolation(task = {}) {
  const result = resolveTaskWorkerIsolation(task);
  if (result.ok) return result;
  const error = new Error(result.error || "故事点 Worker 隔离预检失败");
  error.code = result.reasonCode || "WORKER_ISOLATION_REQUIRED";
  error.workerIsolation = result;
  error.terminalFailure = true;
  throw error;
}

export function dangerousCliPermissionsAllowed(
  task = {},
  isolation = resolveTaskWorkerIsolation(task),
  { platform = process.platform } = {},
) {
  if (task.commandPolicy === "read_only") return false;
  if (!task.storyScoped) return !productionWorkerIsolationRequired();
  return platformSupportsStrongWorkerIsolation(platform)
    && isolation?.ok === true
    && isolation.level === WORKER_ISOLATION_LEVELS.STRONG;
}

export function sanitizeWorkerEnvironment(environment = process.env) {
  const clean = {};
  for (const [key, value] of Object.entries(environment || {})) {
    if (
      CONTROLLER_ENV_PATTERN.test(key)
      || LAUNCH_SECURITY_ENV_PATTERN.test(key)
      || AMBIENT_SECRET_ENV_PATTERN.test(key)
      || GATEWAY_PROFILE_ENV_PATTERN.test(key)
      || GIT_ROUTING_ENV_PATTERN.test(key)
    ) continue;
    clean[key] = value;
  }
  clean.DEVBENCH_WORKER_RUNTIME = "1";
  return clean;
}

export function prepareWorkerLaunch({
  command,
  args,
  cwd,
  task,
  isolation,
  environment,
  testSigningPrivateKey,
  testNonceOptions,
  now = Date.now(),
} = {}) {
  const resolved = isolation || assertTaskWorkerIsolation(task);
  if (resolved.launchMode !== "broker") {
    return {
      command,
      args: Array.isArray(args) ? args : [],
      cwd,
      env: environment,
      isolation: resolved,
    };
  }
  const expiresAt = Date.parse(resolved.grant.expiresAt);
  if (!Number.isFinite(expiresAt) || expiresAt <= now) {
    const error = new Error("Worker 授权在启动前已过期");
    error.code = "WORKER_GRANT_EXPIRED";
    throw error;
  }
  const requestedCliName = path.basename(String(command || "").trim()).toLowerCase();
  const cliId = requestedCliName.replace(/\.(?:exe|com)$/i, "");
  const cliDescriptor = resolved.launcher?.cliAllowlist?.[cliId];
  if (
    /\.(?:cmd|bat|ps1)$/i.test(requestedCliName)
    || !WORKER_CLI_IDS.includes(cliId)
    || !runtimeCliDescriptorShapeValid(cliDescriptor, cliId)
  ) {
    const error = new Error(
      "Worker CLI 未绑定到 v3 受管配置中的绝对路径、SHA256 和父链保护",
    );
    error.code = "WORKER_CLI_NOT_MANAGED";
    throw error;
  }
  if (!Array.isArray(args) || args.some((item) => typeof item !== "string")) {
    const error = new Error("Worker CLI 参数必须是字符串数组");
    error.code = "WORKER_CLI_ARGS_INVALID";
    throw error;
  }
  // The broker must not consume the one-time nonce or start the untrusted CLI
  // until agent-runner has persisted the native launcher PID in the runtime
  // lease. This signed challenge is not itself a release credential; a second
  // short-lived Ed25519 record is minted only after the lease write succeeds.
  const releaseChallenge = randomUUID();
  const encoded = createSignedWorkerLaunchEnvelope({
    taskId: String(task?.id || task?.taskId || "").trim(),
    operation: "cli",
    releaseChallenge,
    command: "",
    cliDescriptor: { ...cliDescriptor },
    args: [...args],
    cwd: canonicalWorkerPath(cwd),
    expectedIdentity: resolved.launcher.identity,
    identityScope: resolved.launcher.identityScope,
    gatewayIdentity: resolved.launcher.gatewayIdentity,
    grant: resolved.grant,
    readOnly: task.commandPolicy === "read_only",
  }, {
    now,
    payloadExpiresAt: resolved.grant.expiresAt,
    testSigningPrivateKey,
  });
  if (productionWorkerIsolationRequired()) {
    if (!String(task?.id || task?.taskId || "").trim()) {
      const error = new Error("生产 Worker 启动必须绑定非空 taskId");
      error.code = "WORKER_LAUNCH_TASK_ID_REQUIRED";
      throw error;
    }
    issueWorkerLaunchNonce(encoded);
  } else if (testNonceOptions !== undefined) {
    if (process.env.NODE_ENV !== "test") {
      const error = new Error("Worker launch nonce 测试选项仅允许 NODE_ENV=test");
      error.code = "WORKER_LAUNCH_NONCE_TEST_OPTIONS_FORBIDDEN";
      throw error;
    }
    issueWorkerLaunchNonce(encoded, testNonceOptions);
  }
  return {
    command: resolved.launcher.command,
    args: [...resolved.launcher.args, "--devbench-worker-spec", encoded],
    cwd,
    env: sanitizeWorkerEnvironment(environment),
    releaseChallenge,
    encodedLaunchEnvelope: encoded,
    isolation: resolved,
  };
}

export function describeWorkerIsolation(task = {}) {
  const result = resolveTaskWorkerIsolation(task);
  return {
    level: result.level,
    launchMode: result.launchMode,
    reasonCode: result.reasonCode,
    error: result.error || "",
    workerIdentity: result.launcher?.identity || "",
    gatewayIdentity: result.launcher?.gatewayIdentity || currentOsIdentity(),
  };
}
