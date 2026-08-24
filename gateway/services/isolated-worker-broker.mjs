#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { createHash, createPublicKey, randomBytes, verify } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";

// This broker is deliberately self-contained. It is launched after the OS
// identity switch, so importing mutable Gateway modules before authenticating
// the launch envelope would extend the Worker trust boundary beyond the single
// broker file pinned by worker-launcher-config.v3.
const BROKER_DIR = path.dirname(fileURLToPath(import.meta.url));
const WORKER_LAUNCH_ENVELOPE_SCHEMA = "devbench.worker-launch-envelope.v1";
const WORKER_LAUNCH_PAYLOAD_SCHEMA = "devbench.worker-launch-spec.v1";
const WORKER_LEASE_RELEASE_SCHEMA = "devbench.worker-lease-release.v2";
const WORKER_LAUNCH_ENVELOPE_MAX_TTL_MS = 60_000;
const WORKER_LAUNCH_RECEIPT_SCHEMA = "devbench.worker-launch-consumption-receipt.v2";
const WORKER_LAUNCH_CHANNEL_CHALLENGE_SCHEMA =
  "devbench.worker-launch-channel-challenge.v1";
const WORKER_LAUNCH_RECEIPT_MAX_AGE_MS = 10_000;
const WORKER_LAUNCH_HANDSHAKE_TIMEOUT_MS = 5_000;
const WORKER_LAUNCH_HANDSHAKE_MAX_BYTES = 128 * 1024;
const WORKER_LAUNCH_TRUST_ANCHOR_PATH = path.resolve(
  BROKER_DIR,
  "../config/worker-launcher-public.pem",
);
const CONTROLLER_ENV_PATTERN = /(?:DEVBENCH_.*(?:CONTROLLER|MIRROR|CAPABILITY|CREDENTIAL|SECRET)|GIT_ASKPASS|SSH_ASKPASS|SSH_AUTH_SOCK|AZURE_DEVOPS_EXT_PAT)/i;
const AMBIENT_SECRET_ENV_PATTERN = /(?:^|_)(?:TOKEN|SECRET|PASSWORD|PASSWD|APIKEY|API_KEY|ACCESS_KEY|PRIVATE_KEY|CREDENTIAL|CREDENTIALS)(?:_|$)/i;
const LAUNCH_SECURITY_ENV_PATTERN = /(?:LAUNCHER|SIGNING|SIGNATURE|TRUST(?:_ANCHOR)?|PRIVATE_?KEY|PUBLIC_?KEY|WORKER_?SPEC|DEVBENCH_WORKER_(?:IDENTITY|ATTESTED)|DEVBENCH_TEST_OS_IDENTITY)/i;
const GATEWAY_PROFILE_ENV_PATTERN = /^(?:HOME|USERPROFILE|HOMEDRIVE|HOMEPATH|APPDATA|LOCALAPPDATA|XDG_(?:CONFIG|CACHE|DATA)_HOME|CODEX_HOME|CLAUDE_CONFIG_DIR|GEMINI_HOME|NPM_CONFIG_USERCONFIG|GIT_CONFIG_GLOBAL)$/i;
const GIT_ROUTING_ENV_PATTERN = /^(?:GIT_DIR|GIT_WORK_TREE|GIT_COMMON_DIR|GIT_OBJECT_DIRECTORY|GIT_ALTERNATE_OBJECT_DIRECTORIES|GIT_CONFIG_(?:GLOBAL|SYSTEM|NOSYSTEM|COUNT)|GIT_CEILING_DIRECTORIES|GIT_INDEX_FILE)$/i;
const WORKER_CLI_IDS = Object.freeze(["claude", "codex", "gemini"]);

function productionWorkerIsolationRequired(environment = process.env) {
  const mode = String(environment?.NODE_ENV || "").trim().toLowerCase();
  return mode !== "test" && mode !== "development";
}

function normalizedPath(value) {
  const resolved = path.resolve(String(value || ""));
  const normalized = resolved.replace(/[\\/]+/g, "/").replace(/\/+$/, "");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function pathIsInside(root, candidate) {
  const parent = normalizedPath(root);
  const child = normalizedPath(candidate);
  return !!parent && !!child && (child === parent || child.startsWith(`${parent}/`));
}

const WINDOWS_SYSTEM_TOOL_NAMES = Object.freeze({
  powershell: "WindowsPowerShell\\v1.0\\powershell.exe",
  whoami: "whoami.exe",
});

function configuredWindowsSystemRoot(testSystemRoot) {
  if (testSystemRoot !== undefined && process.env.NODE_ENV !== "test") {
    throw brokerError(
      "Windows SystemRoot 测试覆盖仅允许 NODE_ENV=test",
      "WORKER_SYSTEM_TOOL_TEST_OVERRIDE_FORBIDDEN",
    );
  }
  const raw = String(
    testSystemRoot
      || process.env.SystemRoot
      || `${process.env.SystemDrive || "C:"}\\Windows`,
  ).trim();
  if (
    !path.win32.isAbsolute(raw)
    || path.win32.basename(path.win32.resolve(raw)).toLowerCase() !== "windows"
  ) {
    throw brokerError(
      "无法解析固定 Windows SystemRoot",
      "WORKER_SYSTEM_ROOT_INVALID",
    );
  }
  return path.win32.resolve(raw);
}

export function resolveWindowsSystemToolPaths({
  testSystemRoot,
  testPathVerifier,
} = {}) {
  if (testPathVerifier !== undefined && process.env.NODE_ENV !== "test") {
    throw brokerError(
      "Windows 系统工具路径测试验证器仅允许 NODE_ENV=test",
      "WORKER_SYSTEM_TOOL_TEST_OVERRIDE_FORBIDDEN",
    );
  }
  const systemRoot = configuredWindowsSystemRoot(testSystemRoot);
  const tools = Object.fromEntries(Object.entries(WINDOWS_SYSTEM_TOOL_NAMES).map(([id, relative]) => {
    const target = path.win32.resolve(systemRoot, "System32", relative);
    if (
      !target.toLowerCase().startsWith(`${systemRoot.toLowerCase()}\\system32\\`)
      || path.win32.basename(target).toLowerCase()
        !== path.win32.basename(relative).toLowerCase()
    ) {
      throw brokerError(
        "Windows 系统工具路径逃逸固定 SystemRoot",
        "WORKER_SYSTEM_TOOL_PATH_INVALID",
      );
    }
    if (testPathVerifier !== undefined) {
      if (testPathVerifier(target, id) !== true) {
        throw brokerError(
          "Windows 系统工具测试路径验证失败",
          "WORKER_SYSTEM_TOOL_PATH_INVALID",
        );
      }
    } else {
      const canonical = canonicalWorkerPath(target);
      const stat = fs.lstatSync(canonical);
      if (!stat.isFile() || stat.isSymbolicLink()
        || normalizedPath(canonical) !== normalizedPath(target)) {
        throw brokerError(
          "Windows 系统工具必须是固定 SystemRoot 下的真实普通文件",
          "WORKER_SYSTEM_TOOL_PATH_INVALID",
        );
      }
    }
    return [id, target];
  }));
  return Object.freeze({ systemRoot, ...tools });
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

function canonicalWorkerPath(value, { mustExist = true } = {}) {
  const raw = String(value || "").trim();
  if (!raw || !path.isAbsolute(raw)) {
    throw brokerError("Worker 授权路径必须是绝对路径", "WORKER_GRANT_PATH_INVALID");
  }
  const resolved = path.resolve(raw);
  for (const segment of existingAncestors(resolved)) {
    if (fs.lstatSync(segment).isSymbolicLink()) {
      throw brokerError(
        `Worker 授权路径包含符号链接或目录联接：${segment}`,
        "WORKER_GRANT_PATH_LINK",
      );
    }
  }
  if (mustExist && !fs.existsSync(resolved)) {
    throw brokerError(`Worker 授权路径不存在：${resolved}`, "WORKER_GRANT_PATH_MISSING");
  }
  return fs.existsSync(resolved) ? fs.realpathSync.native(resolved) : resolved;
}

function currentWindowsSid() {
  try {
    const tools = resolveWindowsSystemToolPaths();
    const stdout = execFileSync(
      tools.whoami,
      ["/user", "/fo", "csv", "/nh"],
      {
        encoding: "utf8",
        windowsHide: true,
        timeout: 5_000,
        maxBuffer: 64 * 1024,
      },
    );
    const match = String(stdout || "").match(/"([^"]*)","(S-[^"]+)"/i);
    return match?.[2] ? `sid:${match[2].toUpperCase()}` : "";
  } catch {
    return "";
  }
}

function currentOsIdentity() {
  const testOverride = process.env.NODE_ENV === "test"
    ? String(process.env.DEVBENCH_TEST_OS_IDENTITY || "").trim()
    : "";
  if (testOverride) return testOverride;
  if (process.platform === "win32") {
    return currentWindowsSid()
      || `win-user:${String(process.env.USERNAME || os.userInfo().username || "").toLowerCase()}`;
  }
  if (typeof process.getuid === "function") return `uid:${process.getuid()}`;
  return `user:${String(os.userInfo().username || "").toLowerCase()}`;
}

function launcherEnvelopeSigningBytes(envelope = {}) {
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

function workerLeaseReleaseSigningBytes(release = {}) {
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

function workerLauncherKeyId(publicKey) {
  const key = publicKey?.type === "public" ? publicKey : createPublicKey(publicKey);
  if (key?.asymmetricKeyType !== "ed25519") {
    throw brokerError(
      "Worker launcher 信任锚必须是 Ed25519 公钥",
      "WORKER_LAUNCH_KEY_TYPE_INVALID",
    );
  }
  const der = key.export({ type: "spki", format: "der" });
  return `ed25519:${createHash("sha256").update(der).digest("base64url")}`;
}

function protectedPathIdentity(stat) {
  return [
    stat.isDirectory() ? "directory" : (stat.isFile() ? "file" : "other"),
    Number(stat.dev),
    Number(stat.ino),
    Number(stat.size),
    Number(stat.mtimeMs),
    Number(stat.ctimeMs),
    Number(stat.nlink),
  ].join(":");
}

export function readProtectedWorkerFile(
  target,
  {
    requireReadOnlyForCurrentIdentity = true,
    testPermissionVerifier,
    maxBytes = 1024 * 1024,
  } = {},
) {
  if (testPermissionVerifier !== undefined && process.env.NODE_ENV !== "test") {
    throw brokerError(
      "Worker 受保护文件权限测试验证器仅允许 NODE_ENV=test",
      "WORKER_PROTECTED_FILE_TEST_OVERRIDE_FORBIDDEN",
    );
  }
  const resolved = path.resolve(target);
  const segments = existingAncestors(resolved);
  if (
    segments.length === 0
    || normalizedPath(segments.at(-1)) !== normalizedPath(resolved)
  ) {
    throw brokerError(
      "Worker 受保护文件或其父链不存在",
      "WORKER_PROTECTED_FILE_MISSING",
    );
  }
  const before = new Map();
  for (const segment of segments) {
    const stat = fs.lstatSync(segment);
    const leaf = normalizedPath(segment) === normalizedPath(resolved);
    if (
      stat.isSymbolicLink()
      || (leaf ? !stat.isFile() : !stat.isDirectory())
      || (leaf && Number(stat.nlink) !== 1)
    ) {
      throw brokerError(
        "Worker 受保护文件父链包含 link/reparse/special/hardlink",
        "WORKER_PROTECTED_FILE_PATH_INVALID",
      );
    }
    before.set(normalizedPath(segment), protectedPathIdentity(stat));
    if (!requireReadOnlyForCurrentIdentity) continue;
    if (testPermissionVerifier !== undefined) {
      if (testPermissionVerifier(segment, { leaf, stat }) !== true) {
        throw brokerError(
          "Worker 受保护文件权限测试失败",
          "WORKER_PROTECTED_FILE_WRITABLE",
        );
      }
      continue;
    }
    if (process.platform === "win32") {
      assertWindowsParentHasNoMutationRights(segment);
    } else {
      try {
        fs.accessSync(segment, fs.constants.W_OK);
        throw brokerError(
          "当前 Worker uid 可修改受保护文件或其父链",
          "WORKER_PROTECTED_FILE_WRITABLE",
        );
      } catch (error) {
        if (error?.code === "WORKER_PROTECTED_FILE_WRITABLE") throw error;
        if (!["EACCES", "EPERM", "EROFS"].includes(error?.code)) {
          throw brokerError(
            "无法证明当前 Worker uid 对受保护文件父链只读",
            "WORKER_PROTECTED_FILE_PERMISSION_UNVERIFIED",
          );
        }
      }
    }
  }
  let fd;
  try {
    fd = fs.openSync(
      resolved,
      fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0),
    );
    const first = fs.fstatSync(fd);
    if (
      !first.isFile()
      || Number(first.nlink) !== 1
      || Number(first.size) > maxBytes
      || protectedPathIdentity(first) !== before.get(normalizedPath(resolved))
    ) {
      throw brokerError(
        "Worker 受保护文件 descriptor 与已验证路径不一致",
        "WORKER_PROTECTED_FILE_IDENTITY_DRIFT",
      );
    }
    const content = fs.readFileSync(fd);
    const second = fs.fstatSync(fd);
    if (
      content.length !== Number(first.size)
      || protectedPathIdentity(first) !== protectedPathIdentity(second)
    ) {
      throw brokerError(
        "Worker 受保护文件在 descriptor 读取期间漂移",
        "WORKER_PROTECTED_FILE_IDENTITY_DRIFT",
      );
    }
    for (const segment of segments) {
      const after = fs.lstatSync(segment);
      if (
        after.isSymbolicLink()
        || protectedPathIdentity(after) !== before.get(normalizedPath(segment))
      ) {
        throw brokerError(
          "Worker 受保护文件路径或父链在读取期间漂移",
          "WORKER_PROTECTED_FILE_IDENTITY_DRIFT",
        );
      }
      if (requireReadOnlyForCurrentIdentity && testPermissionVerifier !== undefined
        && testPermissionVerifier(segment, {
          leaf: normalizedPath(segment) === normalizedPath(resolved),
          stat: after,
        }) !== true) {
        throw brokerError(
          "Worker 受保护文件权限在读取期间漂移",
          "WORKER_PROTECTED_FILE_WRITABLE",
        );
      }
      if (requireReadOnlyForCurrentIdentity && testPermissionVerifier === undefined) {
        if (process.platform === "win32") {
          assertWindowsParentHasNoMutationRights(segment);
        } else {
          try {
            fs.accessSync(segment, fs.constants.W_OK);
            throw brokerError(
              "当前 Worker uid 可修改受保护文件或其父链",
              "WORKER_PROTECTED_FILE_WRITABLE",
            );
          } catch (error) {
            if (error?.code === "WORKER_PROTECTED_FILE_WRITABLE") throw error;
            if (!["EACCES", "EPERM", "EROFS"].includes(error?.code)) {
              throw brokerError(
                "无法复核当前 Worker uid 对受保护文件父链只读",
                "WORKER_PROTECTED_FILE_PERMISSION_UNVERIFIED",
              );
            }
          }
        }
      }
    }
    return content;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function loadWorkerLauncherTrustAnchor({ requireReadOnlyForCurrentIdentity = false } = {}) {
  let bytes;
  try {
    bytes = readProtectedWorkerFile(WORKER_LAUNCH_TRUST_ANCHOR_PATH, {
      requireReadOnlyForCurrentIdentity,
    });
  } catch (error) {
    if (String(error?.code || "").startsWith("WORKER_PROTECTED_FILE_")) {
      throw brokerError(
        `Worker launcher 信任锚保护验证失败：${error.message}`,
        error.code,
      );
    }
    throw brokerError(
      `未配置固定 Worker launcher 信任锚：${WORKER_LAUNCH_TRUST_ANCHOR_PATH}`,
      "WORKER_LAUNCH_TRUST_ANCHOR_MISSING",
    );
  }
  const key = createPublicKey(bytes);
  if (key.asymmetricKeyType !== "ed25519") {
    throw brokerError(
      "Worker launcher 信任锚必须是 Ed25519 公钥",
      "WORKER_LAUNCH_KEY_TYPE_INVALID",
    );
  }
  return key;
}

function sanitizeWorkerEnvironment(environment = process.env) {
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

const FUTURE_CLOCK_SKEW_MS = 5_000;
const ENVELOPE_FIELDS = Object.freeze([
  "algorithm",
  "expiresAt",
  "issuedAt",
  "keyId",
  "nonce",
  "payload",
  "schema",
  "signature",
  "version",
].sort());
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;
const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/;
const DEPLOYMENT_PROBE_OPERATION = "deployment-probe";
const DEPLOYMENT_PROBE_RESULT_SCHEMA = "devbench.worker-deployment-probe-result.v3";
const DEPLOYMENT_PROBE_RESULT_PREFIX = "DEVBENCH_WORKER_DEPLOYMENT_PROBE=";
const WORKER_LAUNCH_GATE_MAX_BYTES = 4096;
const WORKER_LAUNCH_GATE_TIMEOUT_MS = 30_000;
const FORBIDDEN_TREE_MAX_ENTRIES = 250_000;
const FORBIDDEN_TREE_MAX_DURATION_MS = 30_000;
const DEPLOYMENT_PROBE_FIELDS = Object.freeze([
  "args",
  "command",
  "cwd",
  "expectedIdentity",
  "expiresAt",
  "gatewayIdentity",
  "grant",
  "identityScope",
  "issuedAt",
  "keyId",
  "launchNonce",
  "operation",
  "readOnly",
  "schema",
  "taskId",
  "version",
].sort());
const CLI_FIELDS = Object.freeze([
  "args",
  "cliDescriptor",
  "command",
  "cwd",
  "expectedIdentity",
  "expiresAt",
  "gatewayIdentity",
  "grant",
  "identityScope",
  "issuedAt",
  "keyId",
  "launchNonce",
  "operation",
  "readOnly",
  "releaseChallenge",
  "schema",
  "taskId",
  "version",
].sort());
const DEPLOYMENT_PROBE_GRANT_FIELDS = Object.freeze([
  "aclFingerprints",
  "allowedRoots",
  "boundarySentinels",
  "cwd",
  "expiresAt",
  "grantId",
  "inaccessibleEntries",
  "inaccessibleRoots",
  "issuedAt",
  "nonce",
  "readOnly",
  "repositoryMode",
  "storyId",
  "topologyCwd",
  "topologyGeneration",
  "version",
  "writeDeniedRoots",
  "workerIdentity",
].sort());
const CONSUMPTION_RECEIPT_FIELDS = Object.freeze([
  "algorithm",
  "challengeSha256",
  "consumedAt",
  "envelopeNonce",
  "envelopeSha256",
  "expiresAt",
  "keyId",
  "launcherInstanceEvidenceSha256",
  "payloadSha256",
  "schema",
  "signature",
  "storyId",
  "taskId",
  "version",
  "workerIdentity",
].sort());
const LEASE_RELEASE_FIELDS = Object.freeze([
  "algorithm",
  "envelopeSha256",
  "expiresAt",
  "issuedAt",
  "keyId",
  "launcherPid",
  "launcherInstanceEvidence",
  "launcherProcessIdentity",
  "launchNonce",
  "leaseId",
  "releaseChallenge",
  "schema",
  "signature",
  "storyId",
  "taskId",
  "version",
  "workerIdentity",
].sort());

function cliDescriptorShapeValid(descriptor) {
  if (
    !descriptor
    || typeof descriptor !== "object"
    || Array.isArray(descriptor)
    || !WORKER_CLI_IDS.includes(String(descriptor.id || ""))
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

function brokerError(message, code = "WORKER_LAUNCH_SPEC_INVALID") {
  const error = new Error(message);
  error.code = code;
  return error;
}

function decodeBase64Url(value, label) {
  const encoded = String(value || "");
  if (!encoded || !BASE64URL_PATTERN.test(encoded)) {
    throw brokerError(`${label} 不是合法 base64url`, "WORKER_LAUNCH_ENCODING_INVALID");
  }
  return Buffer.from(encoded, "base64url");
}

function normalizeLauncherInstanceEvidence(value) {
  const evidence = String(value || "").trim();
  if (
    !/^[A-Za-z0-9_-]{43}$/.test(evidence)
    || Buffer.from(evidence, "base64url").length !== 32
  ) {
    throw brokerError(
      "native launcher instance channel evidence 必须是 32 字节 base64url",
      "WORKER_LAUNCHER_INSTANCE_EVIDENCE_INVALID",
    );
  }
  return evidence;
}

function fixedOrTestTrustAnchor(testTrustAnchor) {
  if (testTrustAnchor === undefined) {
    return loadWorkerLauncherTrustAnchor({ requireReadOnlyForCurrentIdentity: true });
  }
  if (process.env.NODE_ENV !== "test") {
    throw brokerError(
      "Worker launcher 测试信任锚仅允许在 NODE_ENV=test 下显式注入",
      "WORKER_LAUNCH_TEST_TRUST_FORBIDDEN",
    );
  }
  const publicKey = testTrustAnchor?.type === "public"
    ? testTrustAnchor
    : createPublicKey(testTrustAnchor);
  if (publicKey.asymmetricKeyType !== "ed25519") {
    throw brokerError("Worker launcher 测试信任锚必须是 Ed25519 公钥", "WORKER_LAUNCH_KEY_TYPE_INVALID");
  }
  return publicKey;
}

/**
 * Parse only the outer envelope, authenticate every routing field plus the raw
 * payload bytes, and parse the payload JSON only after Ed25519 verification.
 */
export function verifySignedWorkerLaunchEnvelope(
  encoded,
  { now = Date.now(), testTrustAnchor } = {},
) {
  let envelope;
  try {
    envelope = JSON.parse(decodeBase64Url(encoded, "Worker launcher envelope").toString("utf8"));
  } catch (error) {
    if (error?.code) throw error;
    throw brokerError("Worker launcher envelope JSON 无效", "WORKER_LAUNCH_ENVELOPE_INVALID");
  }
  if (!envelope || typeof envelope !== "object" || Array.isArray(envelope)
    || JSON.stringify(Object.keys(envelope).sort()) !== JSON.stringify(ENVELOPE_FIELDS)) {
    throw brokerError("Worker launcher envelope 字段集合无效", "WORKER_LAUNCH_ENVELOPE_INVALID");
  }
  if (envelope.schema !== WORKER_LAUNCH_ENVELOPE_SCHEMA
    || envelope.version !== 1
    || envelope.algorithm !== "Ed25519") {
    throw brokerError("Worker launcher envelope schema 或算法不受支持", "WORKER_LAUNCH_SCHEMA_INVALID");
  }
  if (!UUID_PATTERN.test(String(envelope.nonce || ""))) {
    throw brokerError("Worker launcher envelope nonce 无效", "WORKER_LAUNCH_NONCE_INVALID");
  }
  const issuedAt = Date.parse(envelope.issuedAt);
  const expiresAt = Date.parse(envelope.expiresAt);
  if (!Number.isFinite(issuedAt) || !Number.isFinite(expiresAt)
    || expiresAt <= issuedAt
    || expiresAt - issuedAt > WORKER_LAUNCH_ENVELOPE_MAX_TTL_MS
    || issuedAt > now + FUTURE_CLOCK_SKEW_MS) {
    throw brokerError("Worker launcher envelope 时间窗口无效", "WORKER_LAUNCH_TIME_INVALID");
  }
  if (expiresAt <= now || now - issuedAt > WORKER_LAUNCH_ENVELOPE_MAX_TTL_MS) {
    throw brokerError("Worker launcher envelope 已过期", "WORKER_LAUNCH_ENVELOPE_EXPIRED");
  }

  const publicKey = fixedOrTestTrustAnchor(testTrustAnchor);
  const trustedKeyId = workerLauncherKeyId(publicKey);
  if (envelope.keyId !== trustedKeyId) {
    throw brokerError("Worker launcher envelope keyId 不受信任", "WORKER_LAUNCH_KEY_UNTRUSTED");
  }
  const signature = decodeBase64Url(envelope.signature, "Worker launcher signature");
  if (signature.length !== 64
    || !verify(null, launcherEnvelopeSigningBytes(envelope), publicKey, signature)) {
    throw brokerError("Worker launcher envelope 签名无效", "WORKER_LAUNCH_SIGNATURE_INVALID");
  }

  let spec;
  try {
    spec = JSON.parse(decodeBase64Url(envelope.payload, "Worker launcher payload").toString("utf8"));
  } catch (error) {
    if (error?.code) throw error;
    throw brokerError("Worker launcher payload JSON 无效", "WORKER_LAUNCH_PAYLOAD_INVALID");
  }
  if (!spec || typeof spec !== "object" || Array.isArray(spec)
    || spec.schema !== WORKER_LAUNCH_PAYLOAD_SCHEMA
    || spec.version !== 1
    || spec.keyId !== envelope.keyId
    || spec.launchNonce !== envelope.nonce
    || spec.issuedAt !== envelope.issuedAt
    || spec.expiresAt !== envelope.expiresAt
    || spec.grant?.version !== 2) {
    throw brokerError("Worker launcher payload 与签名 envelope 不一致", "WORKER_LAUNCH_PAYLOAD_MISMATCH");
  }
  return { encoded: String(encoded), envelope, spec };
}

export function verifySignedWorkerLeaseRelease(
  encoded,
  {
    verifiedLaunch,
    expectedLauncherInstanceEvidence,
    now = Date.now(),
    testTrustAnchor,
  } = {},
) {
  const expectedInstanceEvidence = normalizeLauncherInstanceEvidence(
    expectedLauncherInstanceEvidence,
  );
  let release;
  try {
    release = JSON.parse(decodeBase64Url(
      encoded,
      "Worker lease release",
    ).toString("utf8"));
  } catch (error) {
    if (error?.code) throw error;
    throw brokerError(
      "Worker lease release JSON 无效",
      "WORKER_LEASE_RELEASE_INVALID",
    );
  }
  const envelope = verifiedLaunch?.envelope;
  const spec = verifiedLaunch?.spec;
  const issuedAt = Date.parse(String(release?.issuedAt || ""));
  const expiresAt = Date.parse(String(release?.expiresAt || ""));
  let releaseInstanceEvidence = "";
  try {
    releaseInstanceEvidence = normalizeLauncherInstanceEvidence(
      release?.launcherInstanceEvidence,
    );
  } catch {}
  if (
    !release
    || typeof release !== "object"
    || Array.isArray(release)
    || JSON.stringify(Object.keys(release).sort()) !== JSON.stringify(LEASE_RELEASE_FIELDS)
    || release.schema !== WORKER_LEASE_RELEASE_SCHEMA
    || release.version !== 2
    || release.algorithm !== "Ed25519"
    || !envelope
    || !spec
    || release.keyId !== envelope.keyId
    || release.envelopeSha256 !== createHash("sha256")
      .update(Buffer.from(String(verifiedLaunch.encoded || ""), "utf8"))
      .digest("hex")
    || release.launchNonce !== envelope.nonce
    || release.releaseChallenge !== spec.releaseChallenge
    || release.storyId !== String(spec.grant?.storyId || "")
    || release.taskId !== String(spec.taskId || "")
    || String(release.workerIdentity || "").toLowerCase()
      !== String(spec.expectedIdentity || "").toLowerCase()
    || !String(release.leaseId || "").trim()
    || String(release.leaseId).length > 1024
    || !Number.isSafeInteger(release.launcherPid)
    || release.launcherPid <= 0
    || !String(release.launcherProcessIdentity || "").trim()
    || String(release.launcherProcessIdentity).length > 512
    || /[\r\n\0]/.test(String(release.launcherProcessIdentity || ""))
    || !releaseInstanceEvidence
    || !Number.isFinite(issuedAt)
    || !Number.isFinite(expiresAt)
    || issuedAt > now + FUTURE_CLOCK_SKEW_MS
    || expiresAt <= now
    || expiresAt <= issuedAt
    || expiresAt - issuedAt > 10_000
    || expiresAt > Date.parse(String(envelope.expiresAt || ""))
  ) {
    throw brokerError(
      "Worker lease release 未绑定当前 launch/lease/PID/Worker 身份",
      "WORKER_LEASE_RELEASE_BINDING_INVALID",
    );
  }
  const publicKey = fixedOrTestTrustAnchor(testTrustAnchor);
  if (release.keyId !== workerLauncherKeyId(publicKey)) {
    throw brokerError(
      "Worker lease release keyId 不受信任",
      "WORKER_LEASE_RELEASE_KEY_UNTRUSTED",
    );
  }
  const signature = decodeBase64Url(release.signature, "Worker lease release signature");
  if (
    signature.length !== 64
    || !verify(null, workerLeaseReleaseSigningBytes(release), publicKey, signature)
  ) {
    throw brokerError(
      "Worker lease release 签名无效",
      "WORKER_LEASE_RELEASE_SIGNATURE_INVALID",
    );
  }
  if (releaseInstanceEvidence !== expectedInstanceEvidence) {
    throw brokerError(
      "Worker lease release 来自另一 native launcher instance channel",
      "WORKER_LEASE_RELEASE_INSTANCE_MISMATCH",
    );
  }
  return Object.freeze({ ...release });
}

export function sanitizeBrokerEnvironment(environment = process.env) {
  return sanitizeWorkerEnvironment(environment);
}

function workerProfileEnvironment(environment = process.env) {
  const clean = sanitizeBrokerEnvironment(environment);
  let home = "";
  try {
    home = String(os.userInfo().homedir || "").trim();
  } catch {}
  if (!home || !path.isAbsolute(home)) {
    throw brokerError(
      "无法解析独立 Worker 身份自己的用户配置目录",
      "WORKER_PROFILE_UNAVAILABLE",
    );
  }
  clean.HOME = home;
  if (process.platform === "win32") {
    clean.USERPROFILE = home;
    const parsed = path.parse(home);
    clean.HOMEDRIVE = parsed.root.replace(/[\\/]$/, "");
    clean.HOMEPATH = home.slice(parsed.root.length - 1);
    clean.APPDATA = path.join(home, "AppData", "Roaming");
    clean.LOCALAPPDATA = path.join(home, "AppData", "Local");
  }
  return clean;
}

function assertSignedInaccessibleEntries(grant) {
  const inaccessibleRoots = Array.isArray(grant?.inaccessibleRoots)
    ? grant.inaccessibleRoots.map((value) => path.resolve(String(value || "")))
    : [];
  const rootsByKey = new Map(
    inaccessibleRoots.map((root) => [normalizedPath(root), root]),
  );
  const entries = grant?.inaccessibleEntries;
  if (
    !Array.isArray(entries)
    || entries.length === 0
    || entries.length > FORBIDDEN_TREE_MAX_ENTRIES
  ) {
    throw brokerError(
      "独立故事 Worker 缺少有界的 Controller inaccessible tree manifest",
      "WORKER_INACCESSIBLE_MANIFEST_INVALID",
    );
  }
  const seen = new Set();
  const rootEntries = new Set();
  let previousKey = "";
  for (const entry of entries) {
    if (
      !entry
      || typeof entry !== "object"
      || Array.isArray(entry)
      || JSON.stringify(Object.keys(entry).sort())
        !== JSON.stringify(["path", "root", "type"])
    ) {
      throw brokerError(
        "Controller inaccessible tree manifest 字段无效",
        "WORKER_INACCESSIBLE_MANIFEST_INVALID",
      );
    }
    const root = String(entry.root || "").trim();
    const entryPath = String(entry.path || "").trim();
    const type = String(entry.type || "").trim();
    const canonicalRoot = rootsByKey.get(normalizedPath(root));
    const key = `${normalizedPath(root)}\0${normalizedPath(entryPath)}`;
    if (
      !path.isAbsolute(root)
      || !path.isAbsolute(entryPath)
      || !canonicalRoot
      || !pathIsInside(canonicalRoot, entryPath)
      || !["directory", "file", "missing"].includes(type)
      || (type === "missing"
        && normalizedPath(canonicalRoot) !== normalizedPath(entryPath))
      || seen.has(key)
      || (previousKey && key.localeCompare(previousKey) < 0)
    ) {
      throw brokerError(
        "Controller inaccessible tree manifest 未绑定唯一根或顺序不确定",
        "WORKER_INACCESSIBLE_MANIFEST_INVALID",
      );
    }
    previousKey = key;
    seen.add(key);
    if (normalizedPath(canonicalRoot) === normalizedPath(entryPath)) {
      rootEntries.add(normalizedPath(canonicalRoot));
    }
  }
  if (
    rootEntries.size !== rootsByKey.size
    || [...rootsByKey.keys()].some((rootKey) => !rootEntries.has(rootKey))
  ) {
    throw brokerError(
      "Controller inaccessible tree manifest 未覆盖每个禁止访问根",
      "WORKER_INACCESSIBLE_MANIFEST_INVALID",
    );
  }
  return entries;
}

export function assertBrokerStoryIsolationSpec(
  spec,
  { production = productionWorkerIsolationRequired() } = {},
) {
  if (spec?.grant?.repositoryMode !== "INDEPENDENT_REPOSITORY") return spec;
  if (!String(spec.grant.storyId || "").trim()) {
    throw brokerError(
      "独立故事点 Worker 缺少已签名 storyId",
      "WORKER_LAUNCH_STORY_ID_MISSING",
    );
  }
  if (!String(spec.taskId || "").trim() || String(spec.taskId).length > 512) {
    throw brokerError(
      "独立故事点 Worker 缺少已签名 taskId",
      "WORKER_LAUNCH_TASK_ID_MISSING",
    );
  }
  for (const [field, requireNonEmpty] of [
    ["allowedRoots", true],
    ["writeDeniedRoots", true],
    ["inaccessibleRoots", true],
  ]) {
    if (!Array.isArray(spec.grant[field])
      || (requireNonEmpty && spec.grant[field].length === 0)
      || spec.grant[field].some((item) => typeof item !== "string" || !path.isAbsolute(item))) {
      throw brokerError(
        `独立故事点 Worker 的已签名 ${field} 无效`,
        "WORKER_LAUNCH_SCOPE_INVALID",
      );
    }
  }
  assertSignedInaccessibleEntries(spec.grant);
  const deniedRoots = [
    ...spec.grant.writeDeniedRoots,
    ...spec.grant.inaccessibleRoots,
  ];
  if (
    !path.isAbsolute(String(spec.grant.topologyCwd || ""))
    || !spec.grant.allowedRoots.some((root) => (
      pathIsInside(root, spec.grant.topologyCwd)
    ))
  ) {
    throw brokerError(
      "独立故事点 Worker 缺少 Controller topology cwd",
      "WORKER_LAUNCH_SCOPE_INVALID",
    );
  }
  if (
    !Array.isArray(spec.grant.boundarySentinels)
    || spec.grant.boundarySentinels.length !== new Set(
      deniedRoots.map((value) => normalizedPath(value)),
    ).size
  ) {
    throw brokerError(
      "独立故事点 Worker 缺少禁止根父链边界哨兵",
      "WORKER_DENIED_BOUNDARY_SENTINEL_REQUIRED",
    );
  }
  if (production && spec.identityScope !== "per-story") {
    throw brokerError(
      "生产 Worker 未使用受保护的故事点专属身份认证",
      "WORKER_LAUNCH_IDENTITY_SCOPE_INVALID",
    );
  }
  const operation = spec.operation || "cli";
  if (!["cli", DEPLOYMENT_PROBE_OPERATION].includes(operation)) {
    throw brokerError(
      "Worker launcher operation 不受支持",
      "WORKER_LAUNCH_OPERATION_INVALID",
    );
  }
  if (operation === DEPLOYMENT_PROBE_OPERATION) {
    if (
      JSON.stringify(Object.keys(spec).sort()) !== JSON.stringify(DEPLOYMENT_PROBE_FIELDS)
      || JSON.stringify(Object.keys(spec.grant || {}).sort())
        !== JSON.stringify(DEPLOYMENT_PROBE_GRANT_FIELDS)
      || spec.command !== ""
      || !Array.isArray(spec.args)
      || spec.args.length !== 0
      || spec.readOnly !== false
      || spec.grant.readOnly !== false
      || spec.grant.version !== 2
      || spec.identityScope !== "per-story"
      || String(spec.expectedIdentity || "").toLowerCase()
        !== String(spec.grant.workerIdentity || "").toLowerCase()
      || spec.cwd !== spec.grant.cwd
      || !UUID_PATTERN.test(String(spec.grant.grantId || ""))
      || !UUID_PATTERN.test(String(spec.grant.nonce || ""))
      || !Number.isSafeInteger(spec.grant.topologyGeneration)
      || spec.grant.topologyGeneration < 1
      || !Array.isArray(spec.grant.aclFingerprints)
      || spec.grant.aclFingerprints.length === 0
      || spec.grant.aclFingerprints.some((value) => !SHA256_HEX_PATTERN.test(String(value || "")))
    ) {
      throw brokerError(
        "Worker deployment probe payload 字段或 Controller ACL attestation 无效",
        "WORKER_DEPLOYMENT_PROBE_PAYLOAD_INVALID",
      );
    }
  } else {
    if (
      JSON.stringify(Object.keys(spec).sort()) !== JSON.stringify(CLI_FIELDS)
      || JSON.stringify(Object.keys(spec.grant || {}).sort())
        !== JSON.stringify(DEPLOYMENT_PROBE_GRANT_FIELDS)
      || spec.command !== ""
      || !Array.isArray(spec.args)
      || spec.args.some((value) => typeof value !== "string")
      || !cliDescriptorShapeValid(spec.cliDescriptor)
      || !UUID_PATTERN.test(String(spec.releaseChallenge || ""))
    ) {
      throw brokerError(
        "Worker CLI 必须引用签名的受管绝对路径、SHA256 描述符和 lease release challenge",
        "WORKER_CLI_DESCRIPTOR_INVALID",
      );
    }
  }
  return spec;
}

/**
 * A Worker identity with administrative/root capabilities can bypass filesystem
 * ACLs and must never be considered an isolation boundary.
 */
export function assertLowPrivilegeWorkerIdentity({
  platform = process.platform,
  execFile = execFileSync,
  testSystemRoot,
  testSystemToolPathVerifier,
  testSystemToolAclVerifier,
  uid = typeof process.getuid === "function" ? process.getuid() : null,
  euid = typeof process.geteuid === "function" ? process.geteuid() : uid,
  gid = typeof process.getgid === "function" ? process.getgid() : null,
  groups = typeof process.getgroups === "function" ? process.getgroups() : [],
} = {}) {
  if (String(platform).toLowerCase() === "win32") {
    if (
      (execFile !== execFileSync
        || testSystemRoot !== undefined
        || testSystemToolPathVerifier !== undefined
        || testSystemToolAclVerifier !== undefined)
      && process.env.NODE_ENV !== "test"
    ) {
      throw brokerError(
        "Worker Windows token 测试注入仅允许 NODE_ENV=test",
        "WORKER_SYSTEM_TOOL_TEST_OVERRIDE_FORBIDDEN",
      );
    }
    try {
      const tools = resolveWindowsSystemToolPaths({
        testSystemRoot,
        testPathVerifier: testSystemToolPathVerifier,
      });
      const checked = new Set();
      for (const target of [tools.powershell, tools.whoami]) {
        for (const segment of existingAncestors(target)) {
          const key = normalizedPath(segment);
          if (checked.has(key)) continue;
          checked.add(key);
          if (testSystemToolAclVerifier !== undefined) {
            if (testSystemToolAclVerifier(segment) !== true) {
              throw brokerError(
                "Worker Windows 系统工具 ACL 测试验证失败",
                "WORKER_SYSTEM_TOOL_ACL_UNSAFE",
              );
            }
          } else {
            assertWindowsSystemToolOwner(segment, execFile, tools.powershell);
            assertWindowsParentHasNoMutationRights(segment, execFile, tools.powershell);
          }
        }
      }
      execFile(
        tools.powershell,
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          "$p=[Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent());if($p.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)){exit 9}",
        ],
        { windowsHide: true, timeout: 10_000, stdio: "ignore" },
      );
      const privileges = String(execFile(
        tools.whoami,
        ["/priv", "/fo", "csv", "/nh"],
        {
          windowsHide: true,
          timeout: 10_000,
          encoding: "utf8",
          maxBuffer: 128 * 1024,
        },
      ) || "");
      if (/Se(?:AssignPrimaryToken|Backup|ChangeNotify|CreateToken|Debug|Impersonate|LoadDriver|Restore|TakeOwnership|Tcb)Privilege/i.test(privileges)) {
        throw brokerError(
          "Worker Windows token 持有可绕过隔离的高权限 privilege",
          "WORKER_IDENTITY_PRIVILEGED",
        );
      }
    } catch (error) {
      if (error?.code === "WORKER_IDENTITY_PRIVILEGED") throw error;
      if (String(error?.code || "").startsWith("WORKER_SYSTEM_TOOL_")
        || String(error?.code || "").startsWith("WORKER_DENIED_PARENT_")) {
        throw error;
      }
      if (error?.status === 9) {
        throw brokerError(
          "Worker Windows token 属于本机 Administrators",
          "WORKER_IDENTITY_PRIVILEGED",
        );
      }
      throw brokerError(
        "无法证明 Worker Windows token 为低权限非管理员身份",
        "WORKER_IDENTITY_PRIVILEGE_UNVERIFIED",
      );
    }
    return true;
  }
  if (
    !Number.isSafeInteger(uid)
    || !Number.isSafeInteger(euid)
    || uid <= 0
    || euid !== uid
    || gid === 0
    || (Array.isArray(groups) && groups.includes(0))
  ) {
    throw brokerError(
      "Unix Worker 必须使用非 root、无 root 组且 real/effective uid 一致的独立身份",
      "WORKER_IDENTITY_PRIVILEGED",
    );
  }
  if (String(platform).toLowerCase() === "linux" && fs.existsSync("/proc/self/status")) {
    const status = fs.readFileSync("/proc/self/status", "utf8");
    for (const field of ["CapInh", "CapPrm", "CapEff", "CapAmb"]) {
      const match = status.match(new RegExp(`^${field}:\\s*([0-9a-f]+)$`, "mi"));
      if (!match || BigInt(`0x${match[1]}`) !== 0n) {
        throw brokerError(
          "Linux Worker token 仍持有 capability 或 capability 状态不可验证",
          "WORKER_IDENTITY_PRIVILEGED",
        );
      }
    }
  }
  return true;
}

function deniedBoundaryError(code, message) {
  return brokerError(message, code);
}

function assertWindowsParentHasNoMutationRights(
  target,
  execFile = execFileSync,
  powershellPath = resolveWindowsSystemToolPaths().powershell,
) {
  const encoded = Buffer.from(path.resolve(target), "utf8").toString("base64");
  const script = [
    "$ErrorActionPreference='Stop'",
    `$target=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}'))`,
    "$identity=[Security.Principal.WindowsIdentity]::GetCurrent()",
    "$token=@($identity.User.Value.ToUpperInvariant())",
    "$token+=@($identity.Groups | ForEach-Object {$_.Value.ToUpperInvariant()})",
    "$acl=Get-Acl -LiteralPath $target",
    "$danger=[Security.AccessControl.FileSystemRights]::CreateFiles -bor [Security.AccessControl.FileSystemRights]::CreateDirectories -bor [Security.AccessControl.FileSystemRights]::WriteData -bor [Security.AccessControl.FileSystemRights]::AppendData -bor [Security.AccessControl.FileSystemRights]::Delete -bor [Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles -bor [Security.AccessControl.FileSystemRights]::ChangePermissions -bor [Security.AccessControl.FileSystemRights]::TakeOwnership",
    "$bad=@($acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier]) | Where-Object {$_.AccessControlType -eq [Security.AccessControl.AccessControlType]::Allow -and $token -contains $_.IdentityReference.Value.ToUpperInvariant() -and ($_.FileSystemRights -band $danger) -ne 0})",
    "if($bad.Count -gt 0){exit 73}",
  ].join(";");
  try {
    execFile(
      powershellPath,
      ["-NoProfile", "-NonInteractive", "-Command", script],
      { windowsHide: true, timeout: 10_000, stdio: "ignore" },
    );
  } catch (error) {
    if (error?.status === 73) {
      throw deniedBoundaryError(
        "WORKER_DENIED_PARENT_MUTABLE",
        `Worker token 对禁止根父链仍有 create/rename/delete-child 权限：${target}`,
      );
    }
    throw deniedBoundaryError(
      "WORKER_DENIED_PARENT_PERMISSION_UNVERIFIED",
      `无法证明禁止根父链 Windows ACL 的有效权限（status=${error?.status ?? "unknown"}）：${target}`,
    );
  }
}

function assertWindowsSystemToolOwner(target, execFile, powershellPath) {
  const encoded = Buffer.from(path.resolve(target), "utf8").toString("base64");
  const script = [
    "$ErrorActionPreference='Stop'",
    `$target=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}'))`,
    "$acl=Get-Acl -LiteralPath $target",
    "$owner=$acl.GetOwner([Security.Principal.SecurityIdentifier]).Value.ToUpperInvariant()",
    "$allowed=@('S-1-5-18','S-1-5-32-544')",
    "try{$allowed+=([Security.Principal.NTAccount]'NT SERVICE\\TrustedInstaller').Translate([Security.Principal.SecurityIdentifier]).Value.ToUpperInvariant()}catch{}",
    "if($allowed -notcontains $owner){exit 74}",
  ].join(";");
  try {
    execFile(
      powershellPath,
      ["-NoProfile", "-NonInteractive", "-Command", script],
      { windowsHide: true, timeout: 10_000, stdio: "ignore" },
    );
  } catch (error) {
    throw brokerError(
      error?.status === 74
        ? `Windows 系统工具父链 owner 不属于 SYSTEM/Administrators/TrustedInstaller：${target}`
        : `无法验证 Windows 系统工具父链 owner：${target}`,
      error?.status === 74
        ? "WORKER_SYSTEM_TOOL_OWNER_UNSAFE"
        : "WORKER_SYSTEM_TOOL_OWNER_UNVERIFIED",
    );
  }
}

function assertUnixParentHasNoMutationRights(target) {
  try {
    fs.accessSync(target, fs.constants.W_OK | fs.constants.X_OK);
  } catch (error) {
    if (["EACCES", "EPERM", "EROFS"].includes(error?.code)) return;
    throw deniedBoundaryError(
      "WORKER_DENIED_PARENT_PERMISSION_UNVERIFIED",
      `无法证明禁止根父链 Unix 有效权限：${target}`,
    );
  }
  throw deniedBoundaryError(
    "WORKER_DENIED_PARENT_MUTABLE",
    `Worker uid 对禁止根父链仍有 write+execute，可创建、重命名或删除子项：${target}`,
  );
}

function rollbackOrFail(action, label) {
  try {
    action();
  } catch {
    throw deniedBoundaryError(
      "WORKER_DENIED_PARENT_PROBE_ROLLBACK_FAILED",
      `Worker 边界攻击探测成功后无法回滚：${label}`,
    );
  }
}

function expectMutationDenied(label, action, rollback) {
  try {
    action();
  } catch (error) {
    if (["EACCES", "EPERM", "EROFS"].includes(error?.code)) return;
    throw deniedBoundaryError(
      "WORKER_DENIED_PARENT_PROBE_UNVERIFIED",
      `Worker 边界攻击探测结果不确定（${label}，${error?.code || "unknown"}）`,
    );
  }
  rollbackOrFail(rollback, label);
  throw deniedBoundaryError(
    "WORKER_DENIED_PARENT_MUTABLE",
    `Worker 边界攻击探测实际成功：${label}`,
  );
}

/**
 * Prove that an inaccessible leaf cannot be replaced through a writable
 * ancestor. The signed sentinel gives the Worker a disposable rename target;
 * ACL/mode checks cover delete-child without deleting production data.
 */
export function assertDeniedRootParentBoundaries({
  deniedRoots,
  boundarySentinels,
  platform = process.platform,
  execFile = execFileSync,
  testSystemRoot,
  testSystemToolPathVerifier,
  testParentPermissionVerifier,
} = {}) {
  if (testParentPermissionVerifier !== undefined && process.env.NODE_ENV !== "test") {
    throw deniedBoundaryError(
      "WORKER_DENIED_PARENT_TEST_OVERRIDE_FORBIDDEN",
      "Worker 禁止根父链测试验证器仅允许 NODE_ENV=test",
    );
  }
  if (
    (execFile !== execFileSync
      || testSystemRoot !== undefined
      || testSystemToolPathVerifier !== undefined)
    && process.env.NODE_ENV !== "test"
  ) {
    throw deniedBoundaryError(
      "WORKER_DENIED_PARENT_TEST_OVERRIDE_FORBIDDEN",
      "Worker 禁止根父链工具测试覆盖仅允许 NODE_ENV=test",
    );
  }
  const roots = [...new Set(
    (Array.isArray(deniedRoots) ? deniedRoots : [])
      .map((value) => path.resolve(String(value || ""))),
  )];
  const sentinels = Array.isArray(boundarySentinels) ? boundarySentinels : [];
  const sentinelByRoot = new Map();
  for (const item of sentinels) {
    if (
      !item
      || typeof item !== "object"
      || Array.isArray(item)
      || JSON.stringify(Object.keys(item).sort())
        !== JSON.stringify(["deniedRoot", "sentinelPath"])
      || !path.isAbsolute(String(item.deniedRoot || ""))
      || !path.isAbsolute(String(item.sentinelPath || ""))
    ) {
      throw deniedBoundaryError(
        "WORKER_DENIED_BOUNDARY_SENTINEL_INVALID",
        "Worker 禁止根缺少结构化边界哨兵",
      );
    }
    const root = path.resolve(item.deniedRoot);
    const sentinelPath = path.resolve(item.sentinelPath);
    const parent = path.dirname(sentinelPath);
    if (
      !roots.some((value) => normalizedPath(value) === normalizedPath(root))
      || sentinelByRoot.has(normalizedPath(root))
      || !path.basename(sentinelPath).startsWith(".devbench-worker-boundary-")
      || !pathIsInside(parent, root)
      || normalizedPath(parent) === normalizedPath(root)
    ) {
      throw deniedBoundaryError(
        "WORKER_DENIED_BOUNDARY_SENTINEL_INVALID",
        "Worker 边界哨兵未唯一绑定到禁止根父链",
      );
    }
    sentinelByRoot.set(normalizedPath(root), sentinelPath);
  }
  if (roots.length === 0 || sentinelByRoot.size !== roots.length) {
    throw deniedBoundaryError(
      "WORKER_DENIED_BOUNDARY_SENTINEL_REQUIRED",
      "每个 forbidden/mirror/secret 根都必须绑定受保护边界哨兵",
    );
  }

  const windows = String(platform).toLowerCase() === "win32";
  const powershellPath = windows
    ? resolveWindowsSystemToolPaths({
      testSystemRoot,
      testPathVerifier: testSystemToolPathVerifier,
    }).powershell
    : "";
  for (const root of roots) {
    const ancestors = existingAncestors(root);
    for (const ancestor of ancestors) {
      let stat;
      try {
        stat = fs.lstatSync(ancestor);
      } catch {
        throw deniedBoundaryError(
          "WORKER_DENIED_PARENT_PERMISSION_UNVERIFIED",
          `禁止根父链在校验中发生变化：${ancestor}`,
        );
      }
      if (stat.isSymbolicLink()) {
        throw deniedBoundaryError(
          "WORKER_DENIED_PARENT_LINK",
          `禁止根父链包含可替换链接：${ancestor}`,
        );
      }
      if (!stat.isDirectory()) continue;
      if (testParentPermissionVerifier !== undefined) {
        if (testParentPermissionVerifier(ancestor) !== true) {
          throw deniedBoundaryError(
            "WORKER_DENIED_PARENT_PERMISSION_UNVERIFIED",
            `禁止根父链测试验证失败：${ancestor}`,
          );
        }
      } else if (windows) {
        assertWindowsParentHasNoMutationRights(ancestor, execFile, powershellPath);
      }
      else assertUnixParentHasNoMutationRights(ancestor);
    }

    const sentinelPath = sentinelByRoot.get(normalizedPath(root));
    const parent = path.dirname(sentinelPath);
    const suffix = `${process.pid}-${randomBytes(12).toString("hex")}`;
    const probeDirectory = path.join(parent, `.devbench-worker-boundary-dir-${suffix}`);
    const probeFile = path.join(parent, `.devbench-worker-boundary-file-${suffix}`);
    const probeLink = path.join(parent, `.devbench-worker-boundary-link-${suffix}`);
    const movedSentinel = path.join(parent, `.devbench-worker-boundary-move-${suffix}`);
    expectMutationDenied(
      `mkdir:${parent}`,
      () => fs.mkdirSync(probeDirectory),
      () => fs.rmdirSync(probeDirectory),
    );
    expectMutationDenied(
      `create:${parent}`,
      () => fs.writeFileSync(probeFile, "", { flag: "wx", mode: 0o600 }),
      () => fs.unlinkSync(probeFile),
    );
    expectMutationDenied(
      `symlink-swap:${parent}`,
      () => fs.symlinkSync(sentinelPath, probeLink, windows ? "file" : undefined),
      () => fs.unlinkSync(probeLink),
    );
    expectMutationDenied(
      `rename/delete-child:${sentinelPath}`,
      () => fs.renameSync(sentinelPath, movedSentinel),
      () => fs.renameSync(movedSentinel, sentinelPath),
    );
  }
  return true;
}

function forbiddenTreeError(code, message) {
  return brokerError(message, code);
}

function pathIdentity(stat) {
  return [
    stat.isDirectory() ? "directory" : (stat.isFile() ? "file" : "other"),
    Number(stat.dev),
    Number(stat.ino),
    Number(stat.size),
    Number(stat.mtimeMs),
    Number(stat.ctimeMs),
    Number(stat.nlink),
  ].join(":");
}

function probeForbiddenEntryWritable(target, stat) {
  if (stat.isDirectory()) {
    try {
      fs.accessSync(target, fs.constants.W_OK);
      return true;
    } catch (error) {
      if (["EACCES", "EPERM", "EROFS"].includes(error?.code)) return false;
      throw error;
    }
  }
  let fd;
  try {
    fd = fs.openSync(
      target,
      fs.constants.O_WRONLY | (fs.constants.O_NOFOLLOW || 0),
    );
    return true;
  } catch (error) {
    if (["EACCES", "EPERM", "EROFS"].includes(error?.code)) return false;
    throw error;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/**
 * The root-only W_OK check is insufficient on Windows because a descendant may
 * carry an explicit Allow ACE that overrides inherited protection. During the
 * real cross-identity deployment probe, walk every reachable business and Git
 * entry as the Worker token and request write access without modifying file
 * contents. Inaccessible subtrees are safe; ambiguous traversal, links, races,
 * or a bounded-scan overflow fail closed.
 */
export function assertWriteDeniedTreesNotWritable({
  writeDeniedRoots,
  maxEntries = FORBIDDEN_TREE_MAX_ENTRIES,
  maxDurationMs = FORBIDDEN_TREE_MAX_DURATION_MS,
  testWritableProbe,
} = {}) {
  if (testWritableProbe !== undefined && process.env.NODE_ENV !== "test") {
    throw forbiddenTreeError(
      "WORKER_FORBIDDEN_TREE_TEST_OVERRIDE_FORBIDDEN",
      "Worker 禁止树写权限测试验证器仅允许 NODE_ENV=test",
    );
  }
  if (
    !Number.isSafeInteger(maxEntries)
    || maxEntries < 1
    || !Number.isSafeInteger(maxDurationMs)
    || maxDurationMs < 1
  ) {
    throw forbiddenTreeError(
      "WORKER_FORBIDDEN_TREE_LIMIT_INVALID",
      "Worker 禁止树扫描上限无效",
    );
  }
  const roots = [...new Set(
    (Array.isArray(writeDeniedRoots) ? writeDeniedRoots : [])
      .map((value) => path.resolve(String(value || ""))),
  )];
  if (roots.length === 0) {
    throw forbiddenTreeError(
      "WORKER_FORBIDDEN_TREE_SCOPE_INVALID",
      "Worker deployment probe 缺少禁止写入的基础仓库",
    );
  }
  const startedAt = Date.now();
  let visited = 0;
  const assertBudget = () => {
    if (++visited > maxEntries || Date.now() - startedAt > maxDurationMs) {
      throw forbiddenTreeError(
        "WORKER_FORBIDDEN_TREE_LIMIT_EXCEEDED",
        "Worker 禁止树扫描超过安全上限，无法证明完整写保护",
      );
    }
  };
  const writable = (target, stat) => {
    try {
      if (testWritableProbe !== undefined) {
        return testWritableProbe(target, {
          directory: stat.isDirectory(),
          stat,
        }) === true;
      }
      return probeForbiddenEntryWritable(target, stat);
    } catch (error) {
      if (String(error?.code || "").startsWith("WORKER_FORBIDDEN_TREE_")) throw error;
      throw forbiddenTreeError(
        "WORKER_FORBIDDEN_TREE_PERMISSION_UNVERIFIED",
        `无法证明 Worker 对禁止树条目的有效写权限已被拒绝：${target}`,
      );
    }
  };

  const queue = [...roots];
  for (let queueIndex = 0; queueIndex < queue.length; queueIndex += 1) {
    const target = queue[queueIndex];
    assertBudget();
    let stat;
    try {
      stat = fs.lstatSync(target);
    } catch (error) {
      if (["ENOENT", "EACCES", "EPERM"].includes(error?.code)) continue;
      throw forbiddenTreeError(
        "WORKER_FORBIDDEN_TREE_PERMISSION_UNVERIFIED",
        `无法检查 Worker 禁止树条目：${target}`,
      );
    }
    if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) {
      throw forbiddenTreeError(
        "WORKER_FORBIDDEN_TREE_LINK",
        `Worker 禁止树包含链接或特殊文件，无法证明写保护：${target}`,
      );
    }
    if (stat.isFile() && Number(stat.nlink) !== 1) {
      throw forbiddenTreeError(
        "WORKER_FORBIDDEN_TREE_HARDLINK",
        `Worker 禁止树包含硬链接文件，无法证明唯一对象边界：${target}`,
      );
    }
    if (writable(target, stat)) {
      throw forbiddenTreeError(
        "WORKER_FORBIDDEN_TREE_WRITABLE",
        `Worker 对基础仓库业务文件或 Git 元数据仍有写权限：${target}`,
      );
    }
    if (!stat.isDirectory()) continue;

    let entries;
    try {
      entries = fs.readdirSync(target, { withFileTypes: true });
    } catch (error) {
      if (["EACCES", "EPERM"].includes(error?.code)) {
        // A non-traversable directory hides every descendant from this token.
        try {
          fs.accessSync(target, fs.constants.X_OK);
        } catch (accessError) {
          if (["EACCES", "EPERM"].includes(accessError?.code)) continue;
        }
      }
      throw forbiddenTreeError(
        "WORKER_FORBIDDEN_TREE_PERMISSION_UNVERIFIED",
        `Worker 可遍历但无法完整枚举禁止树目录：${target}`,
      );
    }
    for (const entry of entries) queue.push(path.join(target, entry.name));
    let after;
    try {
      after = fs.lstatSync(target);
    } catch {
      throw forbiddenTreeError(
        "WORKER_FORBIDDEN_TREE_RACE",
        `Worker 禁止树目录在扫描期间发生变化：${target}`,
      );
    }
    if (pathIdentity(stat) !== pathIdentity(after)) {
      throw forbiddenTreeError(
        "WORKER_FORBIDDEN_TREE_RACE",
        `Worker 禁止树目录在扫描期间发生变化：${target}`,
      );
    }
  }
  return Object.freeze({ roots: Object.freeze(roots), visited });
}

function inaccessibleProbeError(code, message) {
  return brokerError(message, code);
}

/**
 * Validate the exact tree enumerated and signed by the Controller. Unlike the
 * former root-only R_OK/W_OK check, every known descendant is directly opened,
 * listed, and write-probed under the real Worker token. SeChangeNotifyPrivilege
 * is rejected separately, so a denied directory cannot be treated as a safe
 * traverse barrier while a known descendant remains directly reachable.
 */
export function assertInaccessibleEntriesInaccessible({
  inaccessibleRoots,
  inaccessibleEntries,
  maxEntries = FORBIDDEN_TREE_MAX_ENTRIES,
  maxDurationMs = FORBIDDEN_TREE_MAX_DURATION_MS,
  testAccessProbe,
} = {}) {
  if (testAccessProbe !== undefined && process.env.NODE_ENV !== "test") {
    throw inaccessibleProbeError(
      "WORKER_INACCESSIBLE_TEST_OVERRIDE_FORBIDDEN",
      "Worker inaccessible access probe 测试覆盖仅允许 NODE_ENV=test",
    );
  }
  if (
    !Number.isSafeInteger(maxEntries)
    || maxEntries < 1
    || !Number.isSafeInteger(maxDurationMs)
    || maxDurationMs < 1
  ) {
    throw inaccessibleProbeError(
      "WORKER_INACCESSIBLE_LIMIT_INVALID",
      "Worker inaccessible access probe 上限无效",
    );
  }
  const grant = {
    inaccessibleRoots,
    inaccessibleEntries,
  };
  const entries = assertSignedInaccessibleEntries(grant);
  const startedAt = Date.now();
  let visited = 0;
  const assertBudget = () => {
    if (++visited > maxEntries || Date.now() - startedAt > maxDurationMs) {
      throw inaccessibleProbeError(
        "WORKER_INACCESSIBLE_LIMIT_EXCEEDED",
        "Worker inaccessible access probe 超过安全上限",
      );
    }
  };
  const deniedCodes = new Set(["EACCES", "EPERM"]);
  const expectDenied = (entry, operation, probe, { missing = false, write = false } = {}) => {
    if (testAccessProbe !== undefined) {
      const result = testAccessProbe(entry, operation);
      if (result === false) return;
      if (result === true) {
        throw inaccessibleProbeError(
          "WORKER_INACCESSIBLE_ENTRY_ACCESSIBLE",
          `Worker 仍可执行 ${operation}：${entry.path}`,
        );
      }
      throw inaccessibleProbeError(
        "WORKER_INACCESSIBLE_PERMISSION_UNVERIFIED",
        `Worker inaccessible 测试探针未返回布尔值：${entry.path}`,
      );
    }
    try {
      probe();
    } catch (error) {
      if (
        deniedCodes.has(error?.code)
        || (write && error?.code === "EROFS")
        || (missing && ["ENOENT", "ENOTDIR"].includes(error?.code))
      ) return;
      throw inaccessibleProbeError(
        "WORKER_INACCESSIBLE_PERMISSION_UNVERIFIED",
        `无法证明 Worker 的 ${operation} 已被拒绝：${entry.path}`,
      );
    }
    throw inaccessibleProbeError(
      "WORKER_INACCESSIBLE_ENTRY_ACCESSIBLE",
      `Worker 仍可执行 ${operation}：${entry.path}`,
    );
  };

  for (const entry of entries) {
    assertBudget();
    let stat = null;
    try {
      stat = fs.lstatSync(entry.path);
    } catch (error) {
      if (!deniedCodes.has(error?.code)) {
        if (entry.type === "missing" && ["ENOENT", "ENOTDIR"].includes(error?.code)) {
          stat = null;
        } else {
          throw inaccessibleProbeError(
            "WORKER_INACCESSIBLE_MANIFEST_DRIFT",
            `Controller 枚举的 inaccessible entry 已消失或无法验证：${entry.path}`,
          );
        }
      }
    }
    if (stat) {
      if (
        entry.type === "missing"
        || stat.isSymbolicLink()
        || (!stat.isDirectory() && !stat.isFile())
        || (entry.type === "directory" && !stat.isDirectory())
        || (entry.type === "file" && !stat.isFile())
        || (stat.isFile() && Number(stat.nlink) !== 1)
      ) {
        throw inaccessibleProbeError(
          "WORKER_INACCESSIBLE_MANIFEST_DRIFT",
          `Controller 枚举的 inaccessible entry 类型、链接状态或对象身份已漂移：${entry.path}`,
        );
      }
    }

    const missing = entry.type === "missing";
    expectDenied(
      entry,
      "direct-read-access",
      () => fs.accessSync(entry.path, fs.constants.R_OK),
      { missing },
    );
    expectDenied(
      entry,
      "direct-write-access",
      () => fs.accessSync(entry.path, fs.constants.W_OK),
      { missing, write: true },
    );
    if (entry.type === "file") {
      expectDenied(entry, "direct-read-open", () => {
        const fd = fs.openSync(
          entry.path,
          fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0),
        );
        fs.closeSync(fd);
      });
      expectDenied(entry, "direct-write-open", () => {
        const fd = fs.openSync(
          entry.path,
          fs.constants.O_WRONLY | (fs.constants.O_NOFOLLOW || 0),
        );
        fs.closeSync(fd);
      }, { write: true });
    } else if (entry.type === "directory") {
      expectDenied(
        entry,
        "direct-list",
        () => fs.readdirSync(entry.path),
      );
      expectDenied(entry, "direct-directory-open", () => {
        const fd = fs.openSync(
          entry.path,
          fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0),
        );
        fs.closeSync(fd);
      });
      const probePath = path.join(
        entry.path,
        `.devbench-inaccessible-write-probe-${process.pid}-${randomBytes(12).toString("hex")}`,
      );
      expectDenied(entry, "direct-child-create", () => {
        let fd;
        try {
          fd = fs.openSync(
            probePath,
            fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL,
            0o600,
          );
        } finally {
          if (fd !== undefined) fs.closeSync(fd);
          try { fs.unlinkSync(probePath); } catch {}
        }
      }, { write: true });
    }
  }
  return Object.freeze({ visited, entries: Object.freeze([...entries]) });
}

/**
 * Validate the repository layout without invoking Git. A story repository must
 * own a real `.git` directory and object store; linked worktrees, `commondir`,
 * and alternate object stores reconnect the Worker to external state.
 */
export function assertIndependentGitDirectory(cwd) {
  const repositoryRoot = canonicalWorkerPath(cwd);
  const gitDirectory = path.join(repositoryRoot, ".git");
  let gitStat;
  try {
    gitStat = fs.lstatSync(gitDirectory);
  } catch {
    throw brokerError("故事点仓库缺少独立的 .git 目录", "WORKER_GIT_DIRECTORY_MISSING");
  }
  if (!gitStat.isDirectory() || gitStat.isSymbolicLink()) {
    throw brokerError(
      "故事点仓库 .git 必须是非链接真实目录，禁止 gitfile/linked worktree",
      "WORKER_GIT_DIRECTORY_NOT_INDEPENDENT",
    );
  }
  const canonicalGitDirectory = canonicalWorkerPath(gitDirectory);
  if (
    !pathIsInside(repositoryRoot, canonicalGitDirectory)
    || normalizedPath(canonicalGitDirectory) !== normalizedPath(gitDirectory)
  ) {
    throw brokerError("故事点仓库 .git 目录逃逸出故事点仓库", "WORKER_GIT_DIRECTORY_EXTERNAL");
  }
  if (fs.existsSync(path.join(canonicalGitDirectory, "commondir"))) {
    throw brokerError("故事点仓库禁止外部 Git common dir", "WORKER_GIT_COMMONDIR_FORBIDDEN");
  }
  const objectsDirectory = path.join(canonicalGitDirectory, "objects");
  let objectsStat;
  try {
    objectsStat = fs.lstatSync(objectsDirectory);
  } catch {
    throw brokerError("故事点仓库缺少自有 Git object store", "WORKER_GIT_OBJECTS_MISSING");
  }
  if (!objectsStat.isDirectory() || objectsStat.isSymbolicLink()) {
    throw brokerError(
      "故事点仓库 Git object store 必须是非链接真实目录",
      "WORKER_GIT_OBJECTS_EXTERNAL",
    );
  }
  const canonicalObjects = canonicalWorkerPath(objectsDirectory);
  if (
    !pathIsInside(canonicalGitDirectory, canonicalObjects)
    || normalizedPath(canonicalObjects) !== normalizedPath(objectsDirectory)
  ) {
    throw brokerError(
      "故事点仓库 Git object store 逃逸出自有 .git",
      "WORKER_GIT_OBJECTS_EXTERNAL",
    );
  }
  for (const marker of ["alternates", "http-alternates"]) {
    if (fs.existsSync(path.join(canonicalObjects, "info", marker))) {
      throw brokerError(
        "故事点仓库禁止 Git alternate object store",
        "WORKER_GIT_ALTERNATES_FORBIDDEN",
      );
    }
  }
  return Object.freeze({
    repositoryRoot,
    gitDirectory: canonicalGitDirectory,
    objectsDirectory: canonicalObjects,
  });
}

/**
 * Re-check the signed CLI descriptor after switching to the Worker identity.
 * The child is launched only by this exact executable, never via PATH/cwd or a
 * shell/script shim.
 */
export function assertProtectedCliDescriptor(
  descriptor,
  {
    platform = process.platform,
    execFile = execFileSync,
    testSystemRoot,
    testSystemToolPathVerifier,
    testParentPermissionVerifier,
  } = {},
) {
  if (
    (execFile !== execFileSync
      || testSystemRoot !== undefined
      || testSystemToolPathVerifier !== undefined
      || testParentPermissionVerifier !== undefined)
    && process.env.NODE_ENV !== "test"
  ) {
    throw brokerError(
      "Worker CLI 保护测试覆盖仅允许 NODE_ENV=test",
      "WORKER_CLI_TEST_OVERRIDE_FORBIDDEN",
    );
  }
  if (!cliDescriptorShapeValid(descriptor)) {
    throw brokerError("Worker CLI 描述符结构无效", "WORKER_CLI_DESCRIPTOR_INVALID");
  }
  const windows = String(platform).toLowerCase() === "win32";
  const powershellPath = windows
    ? resolveWindowsSystemToolPaths({
      testSystemRoot,
      testPathVerifier: testSystemToolPathVerifier,
    }).powershell
    : "";
  const protectFile = (
    declaredValue,
    expectedSha256,
    role,
    { executable = false, native = false, allowNode = false } = {},
  ) => {
    const declaredPath = path.resolve(declaredValue);
    const protectedPath = canonicalWorkerPath(declaredPath);
    const stat = fs.lstatSync(protectedPath);
    if (
      !stat.isFile()
      || stat.isSymbolicLink()
      || normalizedPath(protectedPath) !== normalizedPath(declaredPath)
    ) {
      throw brokerError(
        `受管 Worker CLI ${role} 必须是绝对路径下的非链接普通文件`,
        "WORKER_CLI_FILE_INVALID",
      );
    }
    const baseName = path.basename(protectedPath).toLowerCase();
    if (
      native
      && (
        (windows && ![".exe", ".com"].includes(path.extname(protectedPath).toLowerCase()))
        || [
          "bash", "cmd.exe", "powershell.exe", "pwsh",
          "pwsh.exe", "sh", "wscript.exe", "cscript.exe", "mshta.exe",
        ].includes(baseName)
        || (!allowNode && ["node", "node.exe"].includes(baseName))
        || fs.readFileSync(protectedPath).subarray(0, 2).toString("utf8") === "#!"
      )
    ) {
      throw brokerError(
        "受管 Worker native CLI 禁止 shell、解释器或 shebang shim",
        "WORKER_CLI_EXECUTABLE_UNSAFE",
      );
    }
    const actualHash = createHash("sha256").update(fs.readFileSync(protectedPath)).digest("hex");
    if (actualHash !== String(expectedSha256).toLowerCase()) {
      throw brokerError(`受管 Worker CLI ${role} SHA256 已漂移`, "WORKER_CLI_HASH_MISMATCH");
    }
    for (const segment of existingAncestors(protectedPath)) {
      const segmentStat = fs.lstatSync(segment);
      if (segmentStat.isSymbolicLink()) {
        throw brokerError("受管 Worker CLI 父链包含链接或目录联接", "WORKER_CLI_PARENT_LINK");
      }
      if (testParentPermissionVerifier !== undefined) {
        if (testParentPermissionVerifier(segment, {
          protectedPath,
          descriptor,
          role,
          stat: segmentStat,
        }) !== true) {
          throw brokerError("受管 Worker CLI 父链测试验证失败", "WORKER_CLI_PARENT_MUTABLE");
        }
      } else if (windows) {
        try {
          assertWindowsParentHasNoMutationRights(segment, execFile, powershellPath);
        } catch (error) {
          throw brokerError(error.message, "WORKER_CLI_PARENT_MUTABLE");
        }
      } else if (segmentStat.isDirectory()) {
        try {
          assertUnixParentHasNoMutationRights(segment);
        } catch (error) {
          throw brokerError(error.message, "WORKER_CLI_PARENT_MUTABLE");
        }
      }
    }
    if (!windows && executable) {
      try {
        fs.accessSync(protectedPath, fs.constants.X_OK);
      } catch {
        throw brokerError("受管 Worker CLI 不可执行", "WORKER_CLI_EXECUTABLE_UNSAFE");
      }
    }
    if (!windows && testParentPermissionVerifier === undefined) {
      try {
        fs.accessSync(protectedPath, fs.constants.W_OK);
      } catch (error) {
        if (["EACCES", "EPERM", "EROFS"].includes(error?.code)) {
          return Object.freeze({ path: protectedPath, sha256: actualHash });
        }
        throw brokerError(
          "无法验证受管 Worker CLI 文件权限",
          "WORKER_CLI_PERMISSION_UNVERIFIED",
        );
      }
      throw brokerError("Worker 身份仍可修改受管 CLI", "WORKER_CLI_FILE_MUTABLE");
    }
    return Object.freeze({ path: protectedPath, sha256: actualHash });
  };
  if (descriptor.mode === "native") {
    const executable = protectFile(
      descriptor.executablePath,
      descriptor.executableSha256,
      "native executable",
      { executable: true, native: true },
    );
    return Object.freeze({
      ...descriptor,
      executablePath: executable.path,
      executableSha256: executable.sha256,
      commandPath: executable.path,
      prefixArgs: Object.freeze([]),
    });
  }
  const node = protectFile(
    descriptor.nodePath,
    descriptor.nodeSha256,
    "Node runtime",
    { executable: true, native: true, allowNode: true },
  );
  if (!["node", "node.exe"].includes(path.basename(node.path).toLowerCase())) {
    throw brokerError(
      "Worker node-entry 只允许固定 node/node.exe",
      "WORKER_CLI_NODE_EXECUTABLE_INVALID",
    );
  }
  const entry = protectFile(
    descriptor.entryPath,
    descriptor.entrySha256,
    "JS entry",
  );
  if (![".js", ".cjs", ".mjs"].includes(path.extname(entry.path).toLowerCase())) {
    throw brokerError("Worker node-entry 只允许固定 JS 入口", "WORKER_CLI_ENTRY_INVALID");
  }
  return Object.freeze({
    ...descriptor,
    nodePath: node.path,
    nodeSha256: node.sha256,
    entryPath: entry.path,
    entrySha256: entry.sha256,
    commandPath: node.path,
    prefixArgs: Object.freeze([entry.path]),
  });
}

function launchConsumptionReceiptSigningBytes(receipt = {}) {
  return Buffer.from(JSON.stringify({
    schema: String(receipt.schema || ""),
    version: Number(receipt.version),
    algorithm: String(receipt.algorithm || ""),
    keyId: String(receipt.keyId || ""),
    envelopeNonce: String(receipt.envelopeNonce || ""),
    envelopeSha256: String(receipt.envelopeSha256 || ""),
    payloadSha256: String(receipt.payloadSha256 || ""),
    storyId: String(receipt.storyId || ""),
    taskId: String(receipt.taskId || ""),
    workerIdentity: String(receipt.workerIdentity || ""),
    challengeSha256: String(receipt.challengeSha256 || ""),
    launcherInstanceEvidenceSha256: String(
      receipt.launcherInstanceEvidenceSha256 || "",
    ),
    consumedAt: Number(receipt.consumedAt),
    expiresAt: Number(receipt.expiresAt),
  }), "utf8");
}

export function verifyWorkerLaunchConsumptionReceipt(
  encodedReceipt,
  {
    encodedEnvelope,
    challenge,
    launcherInstanceEvidence,
    verifiedEnvelope,
    now = Date.now(),
    testTrustAnchor,
  } = {},
) {
  const publicKey = fixedOrTestTrustAnchor(testTrustAnchor);
  const verifiedLaunch = verifiedEnvelope
    || verifySignedWorkerLaunchEnvelope(encodedEnvelope, { now, testTrustAnchor });
  const { envelope, spec } = verifiedLaunch;
  let receipt;
  try {
    receipt = JSON.parse(
      decodeBase64Url(encodedReceipt, "Worker launch consumption receipt").toString("utf8"),
    );
  } catch (error) {
    if (error?.code) throw error;
    throw brokerError(
      "Worker launch consumption receipt JSON 无效",
      "WORKER_LAUNCH_RECEIPT_INVALID",
    );
  }
  const challengeBytes = Buffer.isBuffer(challenge) ? challenge : Buffer.from(challenge || "");
  const expectedInstanceEvidence = normalizeLauncherInstanceEvidence(
    launcherInstanceEvidence,
  );
  const payloadBytes = decodeBase64Url(envelope.payload, "Worker launcher payload");
  if (
    !receipt
    || typeof receipt !== "object"
    || Array.isArray(receipt)
    || JSON.stringify(Object.keys(receipt).sort())
      !== JSON.stringify(CONSUMPTION_RECEIPT_FIELDS)
    || receipt.schema !== WORKER_LAUNCH_RECEIPT_SCHEMA
    || receipt.version !== 2
    || receipt.algorithm !== "Ed25519"
    || receipt.keyId !== workerLauncherKeyId(publicKey)
    || receipt.envelopeNonce !== envelope.nonce
    || receipt.envelopeSha256
      !== createHash("sha256").update(Buffer.from(String(encodedEnvelope), "utf8")).digest("hex")
    || receipt.payloadSha256 !== createHash("sha256").update(payloadBytes).digest("hex")
    || receipt.storyId !== String(spec.grant?.storyId || "").trim()
    || receipt.taskId !== String(spec.taskId || "").trim()
    || receipt.workerIdentity !== String(spec.expectedIdentity || "").trim().toLowerCase()
    || challengeBytes.length !== 32
    || receipt.challengeSha256 !== createHash("sha256").update(challengeBytes).digest("hex")
    || receipt.launcherInstanceEvidenceSha256 !== createHash("sha256")
      .update(Buffer.from(expectedInstanceEvidence, "utf8"))
      .digest("hex")
    || !Number.isSafeInteger(receipt.consumedAt)
    || !Number.isSafeInteger(receipt.expiresAt)
    || receipt.consumedAt > now + FUTURE_CLOCK_SKEW_MS
    || receipt.expiresAt <= now
    || receipt.expiresAt - receipt.consumedAt > WORKER_LAUNCH_RECEIPT_MAX_AGE_MS
  ) {
    throw brokerError(
      "Worker launch receipt 未绑定当前 nonce/story/task/worker/payload/challenge",
      "WORKER_LAUNCH_RECEIPT_INVALID",
    );
  }
  const signature = decodeBase64Url(receipt.signature, "Worker launch receipt signature");
  if (
    signature.length !== 64
    || !verify(null, launchConsumptionReceiptSigningBytes(receipt), publicKey, signature)
  ) {
    throw brokerError(
      "Worker launch receipt 签名无效",
      "WORKER_LAUNCH_RECEIPT_INVALID",
    );
  }
  return Object.freeze({ ...receipt });
}

function readLauncherReceipt(fd = 4) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    let settled = false;
    let timer;
    let stream;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (error) reject(error);
      else resolve(value);
    };
    try {
      stream = fs.createReadStream(null, { fd, autoClose: true });
    } catch (error) {
      finish(brokerError(
        `native launcher 未提供受保护的 nonce receipt 管道：${error.message}`,
        "WORKER_LAUNCH_RECEIPT_CHANNEL_MISSING",
      ));
      return;
    }
    timer = setTimeout(() => {
      stream.destroy();
      finish(brokerError(
        "等待 native launcher nonce receipt 超时",
        "WORKER_LAUNCH_RECEIPT_TIMEOUT",
      ));
    }, WORKER_LAUNCH_HANDSHAKE_TIMEOUT_MS);
    timer.unref?.();
    stream.on("data", (chunk) => {
      total += chunk.length;
      if (total > WORKER_LAUNCH_HANDSHAKE_MAX_BYTES) {
        stream.destroy();
        finish(brokerError(
          "native launcher nonce receipt 过大",
          "WORKER_LAUNCH_RECEIPT_TOO_LARGE",
        ));
        return;
      }
      chunks.push(Buffer.from(chunk));
    });
    stream.once("error", (error) => finish(brokerError(
      `读取 native launcher nonce receipt 失败：${error.message}`,
      "WORKER_LAUNCH_RECEIPT_CHANNEL_FAILED",
    )));
    stream.once("end", () => finish(null, Buffer.concat(chunks).toString("utf8")));
  });
}

export function readLauncherInstanceEvidence(fd = 5) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    let settled = false;
    let timer;
    let stream;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (error) reject(error);
      else resolve(value);
    };
    try {
      stream = fs.createReadStream(null, { fd, autoClose: true });
    } catch (error) {
      finish(brokerError(
        `native launcher 未提供受保护的 instance evidence 管道：${error.message}`,
        "WORKER_LAUNCHER_INSTANCE_CHANNEL_MISSING",
      ));
      return;
    }
    timer = setTimeout(() => {
      stream.destroy();
      finish(brokerError(
        "等待 native launcher instance evidence 超时",
        "WORKER_LAUNCHER_INSTANCE_CHANNEL_TIMEOUT",
      ));
    }, WORKER_LAUNCH_HANDSHAKE_TIMEOUT_MS);
    timer.unref?.();
    stream.on("data", (chunk) => {
      total += chunk.length;
      if (total > 128) {
        stream.destroy();
        finish(brokerError(
          "native launcher instance evidence 过大",
          "WORKER_LAUNCHER_INSTANCE_EVIDENCE_INVALID",
        ));
        return;
      }
      chunks.push(Buffer.from(chunk));
    });
    stream.once("error", (error) => finish(brokerError(
      `读取 native launcher instance evidence 失败：${error.message}`,
      "WORKER_LAUNCHER_INSTANCE_CHANNEL_FAILED",
    )));
    stream.once("end", () => {
      try {
        finish(null, normalizeLauncherInstanceEvidence(
          Buffer.concat(chunks).toString("utf8"),
        ));
      } catch (error) {
        finish(error);
      }
    });
  });
}

async function consumeLaunchNonceThroughNativeLauncher(
  encodedEnvelope,
  verifiedEnvelope,
  launcherInstanceEvidence,
) {
  const challenge = randomBytes(32);
  const challengeFrame = Buffer.from(JSON.stringify({
    schema: WORKER_LAUNCH_CHANNEL_CHALLENGE_SCHEMA,
    version: 1,
    challenge: challenge.toString("base64url"),
    launcherInstanceEvidence: normalizeLauncherInstanceEvidence(
      launcherInstanceEvidence,
    ),
  }), "utf8");
  try {
    fs.writeSync(3, challengeFrame);
    fs.closeSync(3);
  } catch (error) {
    throw brokerError(
      `native launcher 未提供受保护的 nonce challenge 管道：${error.message}`,
      "WORKER_LAUNCH_CHALLENGE_CHANNEL_MISSING",
    );
  }
  const encodedReceipt = await readLauncherReceipt(4);
  return verifyWorkerLaunchConsumptionReceipt(encodedReceipt, {
    encodedEnvelope,
    challenge,
    launcherInstanceEvidence,
    verifiedEnvelope,
  });
}

/**
 * Hold the untrusted CLI behind a post-lease Ed25519 release until the Gateway
 * has durably registered the native launcher PID and immutable start identity.
 * The prompt may arrive in the same chunk as the gate; preserve every byte
 * after the first newline and forward it only after nonce consumption.
 */
export function awaitWorkerLeaseRelease(
  verifiedLaunch,
  {
    stream = process.stdin,
    timeoutMs = WORKER_LAUNCH_GATE_TIMEOUT_MS,
    launcherInstanceEvidence,
    now,
    testTrustAnchor,
  } = {},
) {
  if (
    !verifiedLaunch?.envelope
    || !UUID_PATTERN.test(String(verifiedLaunch?.spec?.releaseChallenge || ""))
  ) {
    return Promise.reject(brokerError(
      "Worker CLI lease release 缺少已验证 launch challenge",
      "WORKER_LEASE_RELEASE_LAUNCH_INVALID",
    ));
  }
  let expectedLauncherInstanceEvidence;
  try {
    expectedLauncherInstanceEvidence = normalizeLauncherInstanceEvidence(
      launcherInstanceEvidence,
    );
  } catch (error) {
    return Promise.reject(error);
  }
  if (!stream || typeof stream.on !== "function") {
    return Promise.reject(brokerError(
      "Worker CLI 启动门闩输入通道不可用",
      "WORKER_LAUNCH_GATE_CHANNEL_MISSING",
    ));
  }
  const boundedTimeout = Math.max(
    1,
    Math.min(WORKER_LAUNCH_GATE_TIMEOUT_MS, Number(timeoutMs) || 0),
  );
  return new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0);
    let settled = false;
    let timer;
    const cleanup = () => {
      clearTimeout(timer);
      stream.off("data", onData);
      stream.off("end", onEnd);
      stream.off("error", onError);
      stream.pause?.();
    };
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else resolve(value);
    };
    const onData = (chunk) => {
      const combined = Buffer.concat([buffer, Buffer.from(chunk)]);
      const newline = combined.indexOf(0x0a);
      if (newline < 0) {
        if (combined.length > WORKER_LAUNCH_GATE_MAX_BYTES) {
          finish(brokerError(
            "Worker CLI 启动门闩头部过长",
            "WORKER_LAUNCH_GATE_TOO_LARGE",
          ));
          return;
        }
        buffer = combined;
        return;
      }
      if (newline > WORKER_LAUNCH_GATE_MAX_BYTES) {
        finish(brokerError(
          "Worker CLI 启动门闩头部过长",
          "WORKER_LAUNCH_GATE_TOO_LARGE",
        ));
        return;
      }
      const received = combined.subarray(0, newline).toString("utf8").replace(/\r$/, "");
      if (!received.startsWith("RELEASE:")) {
        finish(brokerError(
          "Worker CLI lease release 帧格式无效",
          "WORKER_LEASE_RELEASE_FRAME_INVALID",
        ));
        return;
      }
      let release;
      try {
        release = verifySignedWorkerLeaseRelease(received.slice("RELEASE:".length), {
          verifiedLaunch,
          expectedLauncherInstanceEvidence,
          now: now === undefined ? Date.now() : now,
          testTrustAnchor,
        });
      } catch (error) {
        finish(error);
        return;
      }
      finish(null, Object.freeze({
        remainder: Buffer.from(combined.subarray(newline + 1)),
        release,
        stream,
      }));
    };
    const onEnd = () => finish(brokerError(
      "Worker CLI 启动门闩输入提前关闭",
      "WORKER_LAUNCH_GATE_EOF",
    ));
    const onError = (error) => finish(brokerError(
      `Worker CLI 启动门闩输入失败：${error?.message || "unknown"}`,
      "WORKER_LAUNCH_GATE_CHANNEL_FAILED",
    ));
    timer = setTimeout(() => finish(brokerError(
      "等待 Worker CLI post-lease release 超时",
      "WORKER_LEASE_RELEASE_TIMEOUT",
    )), boundedTimeout);
    timer.unref?.();
    stream.on("data", onData);
    stream.once("end", onEnd);
    stream.once("error", onError);
    stream.resume?.();
  });
}

function writeDeploymentProbeResult(spec, actualIdentity) {
  const result = {
    schema: DEPLOYMENT_PROBE_RESULT_SCHEMA,
    version: 3,
    ok: true,
    operation: DEPLOYMENT_PROBE_OPERATION,
    launchNonce: spec.launchNonce,
    storyId: spec.grant.storyId,
    expectedIdentity: spec.expectedIdentity,
    actualIdentity,
    checks: {
      lowPrivilegeIdentity: true,
      storyRepositoryReadWrite: true,
      writeDeniedRootsNotWritable: true,
      writeDeniedTreesNotWritable: true,
      inaccessibleRootsInaccessible: true,
      inaccessibleEntriesInaccessible: true,
      launcherInstanceChannelBound: true,
      independentGitCommonDir: true,
    },
  };
  process.stdout.write(
    `${DEPLOYMENT_PROBE_RESULT_PREFIX}${Buffer.from(JSON.stringify(result), "utf8").toString("base64url")}\n`,
  );
}

function fail(message, code = 125) {
  process.stderr.write(`DevBench Worker Broker: ${message}\n`);
  process.exit(code);
}

export async function runBroker(argv = process.argv) {
  const markerIndex = argv.indexOf("--devbench-worker-spec");
  const encoded = markerIndex >= 0 ? String(argv[markerIndex + 1] || "") : "";
  let verifiedLaunch;
  let spec;
  try {
    verifiedLaunch = verifySignedWorkerLaunchEnvelope(encoded);
    ({ spec } = verifiedLaunch);
    assertBrokerStoryIsolationSpec(spec);
  } catch (error) {
    fail(error.message);
  }

  const expiresAt = Date.parse(spec.expiresAt);
  if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) fail("Worker 授权已过期");
  const actualIdentity = currentOsIdentity();
  if (!spec.expectedIdentity || actualIdentity.toLowerCase() !== String(spec.expectedIdentity).toLowerCase()) {
    fail(`实际身份不符合策略（expected=${spec.expectedIdentity || "missing"} actual=${actualIdentity}）`);
  }
  if (String(spec.gatewayIdentity || "").toLowerCase() === actualIdentity.toLowerCase()) {
    fail("Worker 身份与 Gateway 身份相同");
  }
  try {
    assertLowPrivilegeWorkerIdentity();
  } catch (error) {
    fail(error.message);
  }

  let cwd;
  let allowedRoots;
  let writeDeniedRoots;
  let inaccessibleRoots;
  try {
    cwd = canonicalWorkerPath(spec.cwd);
    allowedRoots = (spec.grant.allowedRoots || []).map((item) => canonicalWorkerPath(item));
    // A correctly isolated identity may be unable even to traverse a mirror or
    // another story root. Those paths were canonicalized by the trusted Gateway
    // before issuance, so retain the absolute lexical value when this identity
    // cannot resolve it and let the access probes below prove denial.
    writeDeniedRoots = (spec.grant.writeDeniedRoots || [])
      .map((item) => path.resolve(String(item || "")));
    inaccessibleRoots = (spec.grant.inaccessibleRoots || [])
      .map((item) => path.resolve(String(item || "")));
  } catch (error) {
    fail(error.message);
  }
  if (!allowedRoots.some((root) => pathIsInside(root, cwd))) fail("cwd 不在允许目录内");
  for (const root of allowedRoots) {
    for (const denied of [...writeDeniedRoots, ...inaccessibleRoots]) {
      if (pathIsInside(root, denied) || pathIsInside(denied, root)) fail("允许目录与禁止目录重叠");
    }
  }

  const access = (target, mode) => {
    try {
      fs.accessSync(target, mode);
      return true;
    } catch {
      return false;
    }
  };
  const neededAccess = spec.readOnly ? fs.constants.R_OK : (fs.constants.R_OK | fs.constants.W_OK);
  if (!access(cwd, neededAccess)) fail("当前 Worker 无法按任务策略访问故事点目录");
  for (const denied of writeDeniedRoots) {
    if (access(denied, fs.constants.W_OK)) fail(`Worker 仍可写禁止目录：${denied}`);
  }
  for (const inaccessible of inaccessibleRoots) {
    if (access(inaccessible, fs.constants.R_OK) || access(inaccessible, fs.constants.W_OK)) {
      fail(`Worker 仍可访问禁止读写的受保护路径：${inaccessible}`);
    }
  }
  try {
    assertDeniedRootParentBoundaries({
      deniedRoots: [...writeDeniedRoots, ...inaccessibleRoots],
      boundarySentinels: spec.grant.boundarySentinels,
    });
  } catch (error) {
    fail(error.message);
  }
  try {
    assertInaccessibleEntriesInaccessible({
      inaccessibleRoots,
      inaccessibleEntries: spec.grant.inaccessibleEntries,
    });
  } catch (error) {
    fail(error.message);
  }
  if ((spec.operation || "cli") === DEPLOYMENT_PROBE_OPERATION) {
    try {
      assertWriteDeniedTreesNotWritable({ writeDeniedRoots });
    } catch (error) {
      fail(error.message);
    }
  }

  // Production story repositories must own their Git common dir. This rejects
  // a legacy linked worktree even though the payload is authenticated.
  if (spec.grant.repositoryMode === "INDEPENDENT_REPOSITORY") {
    try {
      assertIndependentGitDirectory(cwd);
    } catch (error) {
      fail(`无法验证独立故事点仓库：${error.message}`);
    }
  }

  let launcherInstanceEvidence = "";
  try {
    launcherInstanceEvidence = await readLauncherInstanceEvidence(5);
  } catch (error) {
    fail(error.message);
  }

  let launchGate = null;
  if ((spec.operation || "cli") === "cli") {
    try {
      launchGate = await awaitWorkerLeaseRelease(verifiedLaunch, {
        launcherInstanceEvidence,
        timeoutMs: Math.min(
          WORKER_LAUNCH_GATE_TIMEOUT_MS,
          Math.max(1, expiresAt - Date.now()),
        ),
      });
    } catch (error) {
      fail(error.message);
    }
  }

  try {
    await consumeLaunchNonceThroughNativeLauncher(
      encoded,
      verifiedLaunch,
      launcherInstanceEvidence,
    );
  } catch (error) {
    fail(error.message);
  }

  if ((spec.operation || "cli") === DEPLOYMENT_PROBE_OPERATION) {
    writeDeploymentProbeResult(spec, actualIdentity);
    process.exit(0);
  }

  const args = Array.isArray(spec.args) && spec.args.every((item) => typeof item === "string")
    ? spec.args
    : null;
  if (!args) fail("CLI 参数必须是字符串数组");
  let cliDescriptor;
  try {
    cliDescriptor = assertProtectedCliDescriptor(spec.cliDescriptor);
  } catch (error) {
    fail(error.message);
  }

  // Build the child environment only after authentication and policy checks.
  // No launcher, signing, trust-anchor, or private-key input crosses this line.
  const environment = workerProfileEnvironment(process.env);
  environment.DEVBENCH_WORKER_ATTESTED = spec.launchNonce;

  const child = spawn(cliDescriptor.commandPath, [...cliDescriptor.prefixArgs, ...args], {
    cwd,
    shell: false,
    windowsHide: true,
    env: environment,
    stdio: ["pipe", "inherit", "inherit"],
  });
  child.stdin.on("error", () => {});
  const remainder = launchGate?.remainder || Buffer.alloc(0);
  if (remainder.length) child.stdin.write(remainder);
  if (launchGate?.stream?.readableEnded) child.stdin.end();
  else {
    launchGate.stream.pipe(child.stdin);
    launchGate.stream.resume?.();
  }
  child.once("error", (error) => fail(`启动 CLI 失败：${error.message}`, 127));
  child.once("exit", (code, signal) => {
    process.exit(Number.isInteger(code) ? code : (signal ? 128 : 0));
  });
}

const isMain = process.argv[1]
  && pathToFileURL(path.resolve(process.argv[1])).href.toLowerCase() === import.meta.url.toLowerCase();
if (isMain) {
  runBroker().catch((error) => fail(error?.message || "Worker broker 未知失败"));
}
