#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  randomBytes,
  sign,
  verify,
} from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";

const HELPER_DIR = path.dirname(fileURLToPath(import.meta.url));
const WINDOWS_SYSTEM_ROOT = path.win32.resolve(
  String(process.env.SystemRoot || `${process.env.SystemDrive || "C:"}\\Windows`),
);
const WINDOWS_WHOAMI_PATH = path.win32.resolve(
  WINDOWS_SYSTEM_ROOT,
  "System32",
  "whoami.exe",
);
const WINDOWS_POWERSHELL_PATH = path.win32.resolve(
  WINDOWS_SYSTEM_ROOT,
  "System32",
  "WindowsPowerShell",
  "v1.0",
  "powershell.exe",
);
const ENVELOPE_SCHEMA = "devbench.worker-launch-envelope.v1";
const PAYLOAD_SCHEMA = "devbench.worker-launch-spec.v1";
const STATE_SCHEMA = "devbench.worker-launch-nonce-state.v1";
export const WORKER_LAUNCH_RECEIPT_SCHEMA = "devbench.worker-launch-consumption-receipt.v2";
export const WORKER_LAUNCH_CHANNEL_CHALLENGE_SCHEMA =
  "devbench.worker-launch-channel-challenge.v1";
export const WORKER_LAUNCH_NONCE_ROOT = path.resolve(
  HELPER_DIR,
  "../.secrets/worker-launch-nonces",
);
const PUBLIC_KEY_PATH = path.resolve(HELPER_DIR, "../config/worker-launcher-public.pem");
const PRIVATE_KEY_PATH = path.resolve(HELPER_DIR, "../config/worker-launcher-private.pem");
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const MAX_ENVELOPE_BYTES = 128 * 1024;
const MAX_FRAME_BYTES = 128 * 1024;
const MAX_RECEIPT_AGE_MS = 10_000;
const MAX_CLOCK_SKEW_MS = 5_000;
const DEFAULT_MAX_STATE_FILES = 8_192;
const DEFAULT_MAX_AUDIT_FILES = 32;
const DEFAULT_MAX_AUDIT_RECORDS = 256;
const GC_LOCK_STALE_MS = 60_000;
const MAX_PROTECTED_FILE_BYTES = 2 * 1024 * 1024;
const AUDIT_SCHEMA = "devbench.worker-launch-nonce-audit.v1";
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
const RECEIPT_FIELDS = Object.freeze([
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
const AUDIT_FIELDS = Object.freeze([
  "algorithm",
  "archivedAt",
  "keyId",
  "records",
  "schema",
  "signature",
  "version",
].sort());
const STATE_FIELDS = Object.freeze([
  "envelopeSha256",
  "expiresAt",
  "issuedAt",
  "keyId",
  "nonce",
  "payloadSha256",
  "schema",
  "signature",
  "storyId",
  "taskId",
  "version",
  "workerIdentity",
].sort());

function nonceError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function normalizeLauncherInstanceEvidence(value) {
  const evidence = String(value || "").trim();
  if (
    !/^[A-Za-z0-9_-]{43}$/.test(evidence)
    || Buffer.from(evidence, "base64url").length !== 32
  ) {
    throw nonceError(
      "WORKER_LAUNCHER_INSTANCE_EVIDENCE_INVALID",
      "native launcher instance channel evidence 必须是 32 字节 base64url",
    );
  }
  return evidence;
}

function normalizedPath(value) {
  const normalized = path.resolve(String(value || ""))
    .replace(/[\\/]+/g, "/")
    .replace(/\/+$/, "");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function testOnlyOption(name, value) {
  if (value === undefined) return undefined;
  if (process.env.NODE_ENV !== "test") {
    throw nonceError(
      "WORKER_LAUNCH_NONCE_TEST_INJECTION_FORBIDDEN",
      `Worker launch nonce ${name} 仅允许 NODE_ENV=test`,
    );
  }
  return value;
}

function currentIdentity() {
  if (process.platform === "win32") {
    try {
      const stdout = execFileSync(
        WINDOWS_WHOAMI_PATH,
        ["/user", "/fo", "csv", "/nh"],
        { encoding: "utf8", windowsHide: true, timeout: 5_000 },
      );
      const match = String(stdout || "").match(/"([^"]*)","(S-[^"]+)"/i);
      if (match?.[2]) return `sid:${match[2].toUpperCase()}`;
    } catch {}
  }
  if (typeof process.getuid === "function") return `uid:${process.getuid()}`;
  return `user:${String(os.userInfo().username || "").toLowerCase()}`;
}

function allPathSegments(target) {
  const resolved = path.resolve(target);
  const parsed = path.parse(resolved);
  const parts = resolved.slice(parsed.root.length).split(path.sep).filter(Boolean);
  const result = [parsed.root];
  let cursor = parsed.root;
  for (const part of parts) {
    cursor = path.join(cursor, part);
    result.push(cursor);
  }
  return result;
}

function statIdentity(stat) {
  return Object.freeze({
    dev: String(stat.dev),
    ino: String(stat.ino),
    type: String(stat.mode & BigInt(fs.constants.S_IFMT)),
  });
}

function stableFileIdentity(stat) {
  return Object.freeze({
    ...statIdentity(stat),
    mode: String(stat.mode),
    nlink: String(stat.nlink),
    size: String(stat.size),
    mtimeNs: String(stat.mtimeNs),
    ctimeNs: String(stat.ctimeNs),
  });
}

function sameIdentity(left, right) {
  return Boolean(
    left
    && right
    && left.dev === right.dev
    && left.ino === right.ino
    && left.type === right.type
  );
}

function sameStableFile(left, right) {
  return sameIdentity(left, right)
    && left.mode === right.mode
    && left.nlink === right.nlink
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs;
}

function sameRenamedFile(left, right) {
  return sameIdentity(left, right)
    && left.mode === right.mode
    && left.nlink === right.nlink
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs;
}

function assertWindowsAclChain(
  entries,
  {
    gatewayIdentity,
  },
) {
  const gatewaySid = String(gatewayIdentity || "").replace(/^sid:/i, "").toUpperCase();
  if (!/^S-\d(?:-\d+)+$/.test(gatewaySid)) {
    throw nonceError(
      "WORKER_LAUNCH_NONCE_GATEWAY_IDENTITY_INVALID",
      "无法验证 Worker launch nonce Windows ACL",
    );
  }
  const entriesBase64 = Buffer.from(JSON.stringify(entries), "utf8").toString("base64");
  const script = [
    "$ErrorActionPreference='Stop'",
    `$entries=ConvertFrom-Json ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${entriesBase64}')))`,
    `$gateway='${gatewaySid}'`,
    "$trustedInstaller='S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464'",
    "$allowed=@($gateway,'S-1-5-18','S-1-5-32-544',$trustedInstaller)",
    "$identityMutation=[Security.AccessControl.FileSystemRights]::Delete -bor [Security.AccessControl.FileSystemRights]::ChangePermissions -bor [Security.AccessControl.FileSystemRights]::TakeOwnership",
    "$contentMutation=[Security.AccessControl.FileSystemRights]::WriteData -bor [Security.AccessControl.FileSystemRights]::CreateFiles -bor [Security.AccessControl.FileSystemRights]::CreateDirectories -bor [Security.AccessControl.FileSystemRights]::AppendData -bor [Security.AccessControl.FileSystemRights]::WriteAttributes -bor [Security.AccessControl.FileSystemRights]::WriteExtendedAttributes -bor [Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles",
    "$read=[Security.AccessControl.FileSystemRights]::ReadData -bor [Security.AccessControl.FileSystemRights]::ReadAttributes -bor [Security.AccessControl.FileSystemRights]::ReadExtendedAttributes -bor [Security.AccessControl.FileSystemRights]::ExecuteFile",
    "foreach($entry in @($entries)){",
    " $target=[string]$entry.target",
    " $private=[bool]$entry.privateFile",
    " $item=Get-Item -LiteralPath $target -Force",
    " if(($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0){exit 40}",
    " $acl=Get-Acl -LiteralPath $target",
    " $owner=$acl.GetOwner([Security.Principal.SecurityIdentifier]).Value.ToUpperInvariant()",
    " if($allowed -notcontains $owner){exit 41}",
    " $mutation=if([bool]$entry.parent){$identityMutation -bor [Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles}else{$identityMutation -bor $contentMutation}",
    " $sensitive=if($private){$mutation -bor $read}else{$mutation}",
    " $bad=@($acl.Access | ForEach-Object {",
    "  $inheritOnly=($_.PropagationFlags -band [Security.AccessControl.PropagationFlags]::InheritOnly) -ne 0",
    "  if(!$inheritOnly -and $_.AccessControlType -eq 'Allow' -and ($_.FileSystemRights -band $sensitive) -ne 0){",
    "   $sid=$_.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value.ToUpperInvariant()",
    "   if($allowed -notcontains $sid){$_}",
    "  }",
    " })",
    " if($bad.Count -gt 0){exit 42}",
    "}",
  ].join(";");
  try {
    execFileSync(
      WINDOWS_POWERSHELL_PATH,
      ["-NoProfile", "-NonInteractive", "-Command", script],
      { windowsHide: true, timeout: 10_000, stdio: "ignore" },
    );
  } catch {
    throw nonceError(
      "WORKER_LAUNCH_NONCE_ACL_UNSAFE",
      "Worker launch nonce 路径 owner/DACL 或 reparse 状态不安全",
    );
  }
}

function assertPathAcl(resolved, stat, {
  directory,
  privateFile,
  gatewayIdentity,
  aclVerifier,
  phase,
  parent,
} = {}) {
  if (aclVerifier !== undefined) {
    if (
      process.env.NODE_ENV !== "test"
      || aclVerifier(resolved, {
        stat,
        directory,
        privateFile,
        gatewayIdentity,
        phase,
        parent,
      }) !== true
    ) {
      throw nonceError(
        "WORKER_LAUNCH_NONCE_ACL_UNSAFE",
        "Worker launch nonce 路径 ACL 验证失败",
      );
    }
    return;
  }
  if (process.platform === "win32") {
    assertWindowsAclChain(
      [{ target: resolved, privateFile }],
      { gatewayIdentity },
    );
    return;
  }
  const currentUid = typeof process.getuid === "function" ? BigInt(process.getuid()) : undefined;
  const trustedOwner = currentUid === undefined
    || stat.uid === currentUid
    || stat.uid === 0n;
  const mask = privateFile ? 0o077n : 0o022n;
  if (!trustedOwner || (stat.mode & mask) !== 0n) {
    throw nonceError(
      "WORKER_LAUNCH_NONCE_ACL_UNSAFE",
      "Worker launch nonce 路径必须由 Gateway/root uid 持有且不可被非受信身份修改",
    );
  }
}

function assertProtectedPath(target, {
  directory = false,
  privateFile = false,
  gatewayIdentity = currentIdentity(),
  aclVerifier,
  expectedChain,
  phase = "verify",
} = {}) {
  const resolved = path.resolve(target);
  const segments = allPathSegments(resolved);
  const chain = [];
  const windowsAclEntries = [];
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    let stat;
    try {
      stat = fs.lstatSync(segment, { bigint: true });
    } catch {
      throw nonceError(
        "WORKER_LAUNCH_NONCE_PATH_MISSING",
        "Worker launch nonce 受保护路径或父链不存在",
      );
    }
    const isTarget = index === segments.length - 1;
    const expectDirectory = !isTarget || directory;
    if (
      stat.isSymbolicLink()
      || (expectDirectory ? !stat.isDirectory() : !stat.isFile())
    ) {
      throw nonceError(
        "WORKER_LAUNCH_NONCE_PATH_LINK",
        "Worker launch nonce 路径父链包含链接、reparse 或类型漂移",
      );
    }
    if (!expectDirectory && stat.nlink !== 1n) {
      throw nonceError(
        "WORKER_LAUNCH_NONCE_PATH_HARDLINK",
        "Worker launch nonce 普通文件必须只有一个硬链接",
      );
    }
    const segmentPrivate = isTarget ? privateFile : false;
    if (process.platform === "win32" && aclVerifier === undefined) {
      windowsAclEntries.push({
        target: segment,
        privateFile: segmentPrivate,
        directory: expectDirectory,
        parent: !isTarget,
      });
    } else {
      assertPathAcl(segment, stat, {
        directory: expectDirectory,
        privateFile: segmentPrivate,
        gatewayIdentity,
        aclVerifier,
        phase,
        parent: !isTarget,
      });
    }
    chain.push(Object.freeze({
      path: normalizedPath(segment),
      identity: statIdentity(stat),
      fileIdentity: !expectDirectory ? stableFileIdentity(stat) : undefined,
    }));
  }
  if (windowsAclEntries.length > 0) {
    assertWindowsAclChain(windowsAclEntries, { gatewayIdentity });
  }
  let realPath;
  try {
    realPath = normalizedPath(fs.realpathSync.native(resolved));
  } catch {
    throw nonceError(
      "WORKER_LAUNCH_NONCE_PATH_INVALID",
      "Worker launch nonce 受保护路径无法解析",
    );
  }
  if (realPath !== normalizedPath(resolved)) {
    throw nonceError(
      "WORKER_LAUNCH_NONCE_PATH_INVALID",
      "Worker launch nonce 路径必须是固定非链接对象",
    );
  }
  if (expectedChain !== undefined) {
    if (
      !Array.isArray(expectedChain)
      || expectedChain.length !== chain.length
      || expectedChain.some((expected, index) => (
        expected.path !== chain[index].path
        || !sameIdentity(expected.identity, chain[index].identity)
      ))
    ) {
      throw nonceError(
        "WORKER_LAUNCH_NONCE_PATH_IDENTITY_DRIFT",
        "Worker launch nonce 受保护路径父链对象身份已漂移",
      );
    }
  }
  return Object.freeze({ resolved, chain });
}

function readFdBoundProtectedFile(target, {
  directory = false,
  privateFile = false,
  gatewayIdentity = currentIdentity(),
  aclVerifier,
  expectedParentChain,
  phase = "read",
  testHook,
  maxBytes = MAX_PROTECTED_FILE_BYTES,
} = {}) {
  if (directory) {
    throw nonceError(
      "WORKER_LAUNCH_NONCE_PATH_INVALID",
      "FD 绑定读取只接受普通文件",
    );
  }
  const initial = assertProtectedPath(target, {
    privateFile,
    gatewayIdentity,
    aclVerifier,
    phase: `${phase}:initial`,
  });
  if (
    expectedParentChain
    && (
      expectedParentChain.length !== initial.chain.length - 1
      || expectedParentChain.some((expected, index) => (
        expected.path !== initial.chain[index].path
        || !sameIdentity(expected.identity, initial.chain[index].identity)
      ))
    )
  ) {
    throw nonceError(
      "WORKER_LAUNCH_NONCE_PATH_IDENTITY_DRIFT",
      "Worker launch nonce 文件父链对象身份已漂移",
    );
  }
  const flags = fs.constants.O_RDONLY
    | (fs.constants.O_NOFOLLOW || 0)
    | (fs.constants.O_NONBLOCK || 0);
  let fd;
  try {
    fd = fs.openSync(initial.resolved, flags);
    const before = fs.fstatSync(fd, { bigint: true });
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n) {
      throw nonceError(
        "WORKER_LAUNCH_NONCE_PATH_HARDLINK",
        "Worker launch nonce FD 必须绑定单链接普通文件",
      );
    }
    const beforeIdentity = stableFileIdentity(before);
    const initialFileIdentity = initial.chain.at(-1)?.fileIdentity;
    if (!sameStableFile(beforeIdentity, initialFileIdentity)) {
      throw nonceError(
        "WORKER_LAUNCH_NONCE_PATH_IDENTITY_DRIFT",
        "Worker launch nonce open 后 FD 与路径对象不一致",
      );
    }
    if (before.size > BigInt(maxBytes)) {
      throw nonceError(
        "WORKER_LAUNCH_NONCE_PROTECTED_FILE_TOO_LARGE",
        "Worker launch nonce 受保护文件超过大小上限",
      );
    }
    const chunks = [];
    let total = 0;
    const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, maxBytes + 1));
    while (true) {
      const count = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (count === 0) break;
      total += count;
      if (total > maxBytes) {
        throw nonceError(
          "WORKER_LAUNCH_NONCE_PROTECTED_FILE_TOO_LARGE",
          "Worker launch nonce 受保护文件超过大小上限",
        );
      }
      chunks.push(Buffer.from(buffer.subarray(0, count)));
    }
    if (testHook) {
      testHook("stable-read-after-fd-read", Object.freeze({
        target: initial.resolved,
        phase,
      }));
    }
    const after = fs.fstatSync(fd, { bigint: true });
    const afterIdentity = stableFileIdentity(after);
    if (!sameStableFile(beforeIdentity, afterIdentity)) {
      throw nonceError(
        "WORKER_LAUNCH_NONCE_PATH_IDENTITY_DRIFT",
        "Worker launch nonce 文件在 FD 读取期间发生变化",
      );
    }
    const finalPath = assertProtectedPath(initial.resolved, {
      privateFile,
      gatewayIdentity,
      aclVerifier,
      expectedChain: initial.chain,
      phase: `${phase}:final`,
    });
    if (!sameStableFile(beforeIdentity, finalPath.chain.at(-1)?.fileIdentity)) {
      throw nonceError(
        "WORKER_LAUNCH_NONCE_PATH_IDENTITY_DRIFT",
        "Worker launch nonce FD 与末次 lstat 对象不一致",
      );
    }
    return Object.freeze({
      bytes: Buffer.concat(chunks),
      pathSnapshot: finalPath,
      fileIdentity: beforeIdentity,
    });
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function keyId(publicKey) {
  const key = publicKey?.type === "public" ? publicKey : createPublicKey(publicKey);
  if (key.asymmetricKeyType !== "ed25519") {
    throw nonceError("WORKER_LAUNCH_NONCE_KEY_INVALID", "Worker launch key 必须是 Ed25519");
  }
  return `ed25519:${createHash("sha256")
    .update(key.export({ type: "spki", format: "der" }))
    .digest("base64url")}`;
}

function loadKeys({
  testPrivateKey,
  testPublicKey,
  testPrivateKeyPath,
  testPublicKeyPath,
  aclVerifier,
  gatewayIdentity,
  testHook,
} = {}) {
  if (testPrivateKey !== undefined || testPublicKey !== undefined) {
    if (
      process.env.NODE_ENV !== "test"
      || testPrivateKey === undefined
      || testPublicKey === undefined
      || testPrivateKeyPath !== undefined
      || testPublicKeyPath !== undefined
    ) {
      throw nonceError(
        "WORKER_LAUNCH_NONCE_TEST_KEY_FORBIDDEN",
        "Worker launch nonce 测试密钥仅允许 NODE_ENV=test 且必须成对提供",
      );
    }
    const privateKey = testPrivateKey?.type === "private"
      ? testPrivateKey
      : createPrivateKey(testPrivateKey);
    const publicKey = testPublicKey?.type === "public"
      ? testPublicKey
      : createPublicKey(testPublicKey);
    if (
      privateKey.asymmetricKeyType !== "ed25519"
      || publicKey.asymmetricKeyType !== "ed25519"
      || keyId(createPublicKey(privateKey)) !== keyId(publicKey)
    ) {
      throw nonceError("WORKER_LAUNCH_NONCE_KEY_INVALID", "Worker launch nonce 测试密钥不匹配");
    }
    return { privateKey, publicKey };
  }
  if ((testPrivateKeyPath === undefined) !== (testPublicKeyPath === undefined)) {
    throw nonceError(
      "WORKER_LAUNCH_NONCE_TEST_KEY_FORBIDDEN",
      "Worker launch nonce 测试密钥路径必须成对提供",
    );
  }
  const privatePath = testPrivateKeyPath === undefined
    ? PRIVATE_KEY_PATH
    : path.resolve(testOnlyOption("testPrivateKeyPath", testPrivateKeyPath));
  const publicPath = testPublicKeyPath === undefined
    ? PUBLIC_KEY_PATH
    : path.resolve(testOnlyOption("testPublicKeyPath", testPublicKeyPath));
  const privateRead = readFdBoundProtectedFile(privatePath, {
    privateFile: true,
    aclVerifier,
    gatewayIdentity,
    phase: "private-key",
    testHook,
  });
  const publicRead = readFdBoundProtectedFile(publicPath, {
    aclVerifier,
    gatewayIdentity,
    phase: "public-key",
    testHook,
  });
  const privateKey = createPrivateKey(privateRead.bytes);
  const publicKey = createPublicKey(publicRead.bytes);
  if (
    privateKey.asymmetricKeyType !== "ed25519"
    || publicKey.asymmetricKeyType !== "ed25519"
    || keyId(createPublicKey(privateKey)) !== keyId(publicKey)
  ) {
    throw nonceError("WORKER_LAUNCH_NONCE_KEY_INVALID", "Worker launch nonce 固定密钥不匹配");
  }
  return { privateKey, publicKey };
}

function envelopeSigningBytes(envelope = {}) {
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

function parseEnvelope(encoded, { now = Date.now(), publicKey } = {}) {
  const text = String(encoded || "");
  if (
    !BASE64URL_PATTERN.test(text)
    || Buffer.byteLength(text, "utf8") > MAX_ENVELOPE_BYTES
  ) {
    throw nonceError("WORKER_LAUNCH_NONCE_ENVELOPE_INVALID", "Worker launch envelope 编码无效");
  }
  let envelope;
  let payloadBytes;
  let payload;
  try {
    envelope = JSON.parse(Buffer.from(text, "base64url").toString("utf8"));
    payloadBytes = Buffer.from(String(envelope.payload || ""), "base64url");
  } catch {
    throw nonceError("WORKER_LAUNCH_NONCE_ENVELOPE_INVALID", "Worker launch envelope JSON 无效");
  }
  if (
    !envelope
    || typeof envelope !== "object"
    || Array.isArray(envelope)
    || JSON.stringify(Object.keys(envelope).sort()) !== JSON.stringify(ENVELOPE_FIELDS)
    || envelope.schema !== ENVELOPE_SCHEMA
    || envelope.version !== 1
    || envelope.algorithm !== "Ed25519"
    || !UUID_PATTERN.test(String(envelope.nonce || ""))
    || envelope.keyId !== keyId(publicKey)
    || !BASE64URL_PATTERN.test(String(envelope.payload || ""))
    || !BASE64URL_PATTERN.test(String(envelope.signature || ""))
  ) {
    throw nonceError("WORKER_LAUNCH_NONCE_ENVELOPE_INVALID", "Worker launch envelope schema 无效");
  }
  const issuedAt = Date.parse(envelope.issuedAt);
  const expiresAt = Date.parse(envelope.expiresAt);
  if (
    !Number.isFinite(issuedAt)
    || !Number.isFinite(expiresAt)
    || expiresAt <= now
    || expiresAt <= issuedAt
    || expiresAt - issuedAt > 60_000
    || issuedAt > now + 5_000
  ) {
    throw nonceError("WORKER_LAUNCH_NONCE_EXPIRED", "Worker launch envelope 已过期");
  }
  const signature = Buffer.from(envelope.signature, "base64url");
  if (
    signature.length !== 64
    || !verify(null, envelopeSigningBytes(envelope), publicKey, signature)
  ) {
    throw nonceError("WORKER_LAUNCH_NONCE_SIGNATURE_INVALID", "Worker launch envelope 签名无效");
  }
  try {
    payload = JSON.parse(payloadBytes.toString("utf8"));
  } catch {
    throw nonceError("WORKER_LAUNCH_NONCE_PAYLOAD_INVALID", "Worker launch payload JSON 无效");
  }
  const storyId = String(payload?.grant?.storyId || "").trim();
  const taskId = String(payload?.taskId || "").trim();
  const workerIdentity = String(payload?.expectedIdentity || "").trim().toLowerCase();
  if (
    payload?.schema !== PAYLOAD_SCHEMA
    || payload.version !== 1
    || payload.launchNonce !== envelope.nonce
    || payload.keyId !== envelope.keyId
    || payload.issuedAt !== envelope.issuedAt
    || payload.expiresAt !== envelope.expiresAt
    || !storyId
    || !taskId
    || taskId.length > 512
    || !workerIdentity
    || String(payload.grant?.workerIdentity || "").trim().toLowerCase() !== workerIdentity
  ) {
    throw nonceError(
      "WORKER_LAUNCH_NONCE_PAYLOAD_INVALID",
      "Worker launch payload 缺少 story/task/worker 绑定",
    );
  }
  return {
    envelope,
    payload,
    context: {
      nonce: envelope.nonce,
      envelopeSha256: sha256(Buffer.from(text, "utf8")),
      payloadSha256: sha256(payloadBytes),
      storyId,
      taskId,
      workerIdentity,
      issuedAt,
      expiresAt,
    },
  };
}

function stateSigningBytes(state = {}) {
  return Buffer.from(JSON.stringify({
    schema: String(state.schema || ""),
    version: Number(state.version),
    keyId: String(state.keyId || ""),
    nonce: String(state.nonce || ""),
    envelopeSha256: String(state.envelopeSha256 || ""),
    payloadSha256: String(state.payloadSha256 || ""),
    storyId: String(state.storyId || ""),
    taskId: String(state.taskId || ""),
    workerIdentity: String(state.workerIdentity || ""),
    issuedAt: Number(state.issuedAt),
    expiresAt: Number(state.expiresAt),
  }), "utf8");
}

export function workerLaunchReceiptSigningBytes(receipt = {}) {
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

function statePaths(root, nonce) {
  const digest = sha256(Buffer.from(nonce, "utf8"));
  return {
    issued: path.join(root, `${digest}.issued.json`),
    consumed: path.join(root, `${digest}.consumed.json`),
    archivingIssued: path.join(root, `${digest}.issued.archiving.json`),
    archivingConsumed: path.join(root, `${digest}.consumed.archiving.json`),
  };
}

function storeOptions(options = {}) {
  const root = path.resolve(options.root || WORKER_LAUNCH_NONCE_ROOT);
  if (root !== WORKER_LAUNCH_NONCE_ROOT && process.env.NODE_ENV !== "test") {
    throw nonceError(
      "WORKER_LAUNCH_NONCE_ROOT_OVERRIDE_FORBIDDEN",
      "生产运行只允许固定 Worker launch nonce root",
    );
  }
  const gatewayIdentity = String(options.gatewayIdentity || currentIdentity());
  const testHook = testOnlyOption("testHook", options.testHook);
  if (testHook !== undefined && typeof testHook !== "function") {
    throw nonceError(
      "WORKER_LAUNCH_NONCE_TEST_INJECTION_INVALID",
      "Worker launch nonce testHook 必须是函数",
    );
  }
  const rootSnapshot = assertProtectedPath(root, {
    directory: true,
    privateFile: true,
    gatewayIdentity,
    aclVerifier: options.aclVerifier,
    phase: "store-open",
  });
  const keys = loadKeys({
    testPrivateKey: options.testPrivateKey,
    testPublicKey: options.testPublicKey,
    testPrivateKeyPath: options.testPrivateKeyPath,
    testPublicKeyPath: options.testPublicKeyPath,
    aclVerifier: options.aclVerifier,
    gatewayIdentity,
    testHook,
  });
  const boundedInteger = (name, fallback) => {
    if (options[name] === undefined) return fallback;
    if (
      process.env.NODE_ENV !== "test"
      || !Number.isSafeInteger(options[name])
      || options[name] < 1
    ) {
      throw nonceError(
        "WORKER_LAUNCH_NONCE_LIMIT_OVERRIDE_FORBIDDEN",
        "Worker launch nonce 容量测试参数仅允许 NODE_ENV=test",
      );
    }
    return options[name];
  };
  return {
    root,
    rootSnapshot,
    gatewayIdentity,
    aclVerifier: options.aclVerifier,
    testHook,
    maxStateFiles: boundedInteger("maxStateFiles", DEFAULT_MAX_STATE_FILES),
    maxAuditFiles: boundedInteger("maxAuditFiles", DEFAULT_MAX_AUDIT_FILES),
    maxAuditRecords: boundedInteger("maxAuditRecords", DEFAULT_MAX_AUDIT_RECORDS),
    ...keys,
  };
}

function signedState(context, privateKey, publicKey) {
  const state = {
    schema: STATE_SCHEMA,
    version: 1,
    keyId: keyId(publicKey),
    ...context,
  };
  return {
    ...state,
    signature: sign(null, stateSigningBytes(state), privateKey).toString("base64url"),
  };
}

function validateState(state, expected, publicKey) {
  if (
    !state
    || typeof state !== "object"
    || Array.isArray(state)
    || JSON.stringify(Object.keys(state).sort()) !== JSON.stringify(STATE_FIELDS)
    || state.schema !== STATE_SCHEMA
    || state.version !== 1
    || state.keyId !== keyId(publicKey)
    || !BASE64URL_PATTERN.test(String(state.signature || ""))
    || !verify(
      null,
      stateSigningBytes(state),
      publicKey,
      Buffer.from(state.signature, "base64url"),
    )
  ) {
    throw nonceError("WORKER_LAUNCH_NONCE_STATE_INVALID", "Worker launch nonce state 签名无效");
  }
  for (const [field, value] of Object.entries(expected)) {
    if (state[field] !== value) {
      throw nonceError(
        "WORKER_LAUNCH_NONCE_STATE_DRIFT",
        "Worker launch nonce state 与 story/task/worker/payload 不一致",
      );
    }
  }
}

function assertProtectedRoot(opened, phase) {
  return assertProtectedPath(opened.root, {
    directory: true,
    privateFile: true,
    gatewayIdentity: opened.gatewayIdentity,
    aclVerifier: opened.aclVerifier,
    expectedChain: opened.rootSnapshot.chain,
    phase,
  });
}

function invokeTestHook(opened, event, context = {}) {
  if (!opened.testHook) return;
  opened.testHook(event, Object.freeze({
    root: opened.root,
    ...context,
  }));
}

function fsyncProtectedRoot(opened) {
  let fd;
  try {
    fd = fs.openSync(
      opened.root,
      fs.constants.O_RDONLY
        | (fs.constants.O_DIRECTORY || 0)
        | (fs.constants.O_NOFOLLOW || 0),
    );
    const before = statIdentity(fs.fstatSync(fd, { bigint: true }));
    const expected = opened.rootSnapshot.chain.at(-1)?.identity;
    if (!sameIdentity(before, expected)) {
      throw nonceError(
        "WORKER_LAUNCH_NONCE_PATH_IDENTITY_DRIFT",
        "Worker launch nonce root FD 与固定目录对象不一致",
      );
    }
    try {
      fs.fsyncSync(fd);
    } catch (error) {
      if (
        process.platform !== "win32"
        || !["EINVAL", "ENOTSUP", "EPERM"].includes(error?.code)
      ) {
        throw error;
      }
    }
    const after = statIdentity(fs.fstatSync(fd, { bigint: true }));
    if (!sameIdentity(before, after)) {
      throw nonceError(
        "WORKER_LAUNCH_NONCE_PATH_IDENTITY_DRIFT",
        "Worker launch nonce root 在 fsync 期间发生对象漂移",
      );
    }
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function withProtectedRootMutation(opened, operation, targets, mutation) {
  assertProtectedRoot(opened, `${operation}:pre`);
  invokeTestHook(opened, "mutation-after-precheck", {
    operation,
    targets: Object.freeze([...targets]),
  });
  if (opened.testHook) {
    assertProtectedRoot(opened, `${operation}:immediate-pre`);
  }
  let result;
  try {
    result = mutation();
  } catch (error) {
    assertProtectedRoot(opened, `${operation}:failed-post`);
    throw error;
  }
  fsyncProtectedRoot(opened);
  invokeTestHook(opened, "mutation-before-postcheck", {
    operation,
    targets: Object.freeze([...targets]),
  });
  assertProtectedRoot(opened, `${operation}:post`);
  return result;
}

function assertImmediateRootChild(opened, target) {
  const resolved = path.resolve(target);
  if (normalizedPath(path.dirname(resolved)) !== normalizedPath(opened.root)) {
    throw nonceError(
      "WORKER_LAUNCH_NONCE_PATH_INVALID",
      "Worker launch nonce 状态文件必须是固定 root 的直接子项",
    );
  }
  return resolved;
}

function writeAll(fd, bytes) {
  let offset = 0;
  while (offset < bytes.length) {
    const written = fs.writeSync(fd, bytes, offset, bytes.length - offset, null);
    if (written <= 0) {
      throw nonceError(
        "WORKER_LAUNCH_NONCE_DURABLE_WRITE_FAILED",
        "Worker launch nonce 受保护文件写入未取得进展",
      );
    }
    offset += written;
  }
}

function createProtectedFile(
  target,
  contents,
  opened,
  {
    operation = "create",
    keepOpen = false,
  } = {},
) {
  const resolved = assertImmediateRootChild(opened, target);
  const bytes = Buffer.isBuffer(contents) ? contents : Buffer.from(String(contents), "utf8");
  if (bytes.length > MAX_PROTECTED_FILE_BYTES) {
    throw nonceError(
      "WORKER_LAUNCH_NONCE_PROTECTED_FILE_TOO_LARGE",
      "Worker launch nonce 受保护文件超过大小上限",
    );
  }
  let fd;
  let completed = false;
  try {
    const result = withProtectedRootMutation(opened, operation, [resolved], () => {
      fd = fs.openSync(
        resolved,
        fs.constants.O_WRONLY
          | fs.constants.O_CREAT
          | fs.constants.O_EXCL
          | (fs.constants.O_NOFOLLOW || 0),
        0o600,
      );
      const openedStat = fs.fstatSync(fd, { bigint: true });
      if (!openedStat.isFile() || openedStat.isSymbolicLink() || openedStat.nlink !== 1n) {
        throw nonceError(
          "WORKER_LAUNCH_NONCE_PATH_HARDLINK",
          "Worker launch nonce 新建对象必须是单链接普通文件",
        );
      }
      writeAll(fd, bytes);
      fs.fsyncSync(fd);
      const durableStat = fs.fstatSync(fd, { bigint: true });
      const durableIdentity = stableFileIdentity(durableStat);
      if (
        !durableStat.isFile()
        || durableStat.nlink !== 1n
        || durableStat.size !== BigInt(bytes.length)
      ) {
        throw nonceError(
          "WORKER_LAUNCH_NONCE_PATH_IDENTITY_DRIFT",
          "Worker launch nonce 新建文件 FD 状态异常",
        );
      }
      const pathSnapshot = assertProtectedPath(resolved, {
        privateFile: true,
        gatewayIdentity: opened.gatewayIdentity,
        aclVerifier: opened.aclVerifier,
        phase: `${operation}:created`,
      });
      if (
        pathSnapshot.chain.length !== opened.rootSnapshot.chain.length + 1
        || opened.rootSnapshot.chain.some((expected, index) => (
          expected.path !== pathSnapshot.chain[index].path
          || !sameIdentity(expected.identity, pathSnapshot.chain[index].identity)
        ))
        || !sameStableFile(durableIdentity, pathSnapshot.chain.at(-1)?.fileIdentity)
      ) {
        throw nonceError(
          "WORKER_LAUNCH_NONCE_PATH_IDENTITY_DRIFT",
          "Worker launch nonce 新建文件未绑定固定 root 与 FD",
        );
      }
      return Object.freeze({ fd, pathSnapshot, fileIdentity: durableIdentity });
    });
    completed = true;
    if (!keepOpen) {
      fs.closeSync(fd);
      fd = undefined;
    }
    return result;
  } finally {
    if (!completed || !keepOpen) {
      if (fd !== undefined) {
        try { fs.closeSync(fd); } catch {}
      }
    }
  }
}

function readProtectedRootFile(target, opened, phase) {
  const resolved = assertImmediateRootChild(opened, target);
  assertProtectedRoot(opened, `${phase}:root-pre`);
  const result = readFdBoundProtectedFile(resolved, {
    privateFile: true,
    gatewayIdentity: opened.gatewayIdentity,
    aclVerifier: opened.aclVerifier,
    expectedParentChain: opened.rootSnapshot.chain,
    phase,
    testHook: opened.testHook,
  });
  assertProtectedRoot(opened, `${phase}:root-post`);
  return result;
}

function renameProtectedFile(
  source,
  target,
  opened,
  {
    operation = "rename",
    sourceSnapshot,
  } = {},
) {
  const resolvedSource = assertImmediateRootChild(opened, source);
  const resolvedTarget = assertImmediateRootChild(opened, target);
  const initial = sourceSnapshot || readProtectedRootFile(
    resolvedSource,
    opened,
    `${operation}:source`,
  );
  return withProtectedRootMutation(
    opened,
    operation,
    [resolvedSource, resolvedTarget],
    () => {
      const current = assertProtectedPath(resolvedSource, {
        privateFile: true,
        gatewayIdentity: opened.gatewayIdentity,
        aclVerifier: opened.aclVerifier,
        expectedChain: initial.pathSnapshot.chain,
        phase: `${operation}:source-immediate`,
      });
      if (!sameStableFile(initial.fileIdentity, current.chain.at(-1)?.fileIdentity)) {
        throw nonceError(
          "WORKER_LAUNCH_NONCE_PATH_IDENTITY_DRIFT",
          "Worker launch nonce rename 前源文件发生变化",
        );
      }
      try {
        fs.lstatSync(resolvedTarget, { bigint: true });
        throw nonceError(
          "WORKER_LAUNCH_NONCE_COLLISION",
          "Worker launch nonce rename 目标已存在",
        );
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
      fs.renameSync(resolvedSource, resolvedTarget);
      const final = assertProtectedPath(resolvedTarget, {
        privateFile: true,
        gatewayIdentity: opened.gatewayIdentity,
        aclVerifier: opened.aclVerifier,
        phase: `${operation}:target`,
      });
      if (!sameRenamedFile(initial.fileIdentity, final.chain.at(-1)?.fileIdentity)) {
        throw nonceError(
          "WORKER_LAUNCH_NONCE_PATH_IDENTITY_DRIFT",
          "Worker launch nonce rename 后目标未绑定原文件对象",
        );
      }
      try {
        fs.lstatSync(resolvedSource, { bigint: true });
        throw nonceError(
          "WORKER_LAUNCH_NONCE_PATH_IDENTITY_DRIFT",
          "Worker launch nonce rename 后源路径仍存在",
        );
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
      return Object.freeze({
        pathSnapshot: final,
        fileIdentity: final.chain.at(-1)?.fileIdentity,
      });
    },
  );
}

function unlinkProtectedFile(
  target,
  opened,
  {
    operation = "unlink",
    sourceSnapshot,
  } = {},
) {
  const resolved = assertImmediateRootChild(opened, target);
  const initial = sourceSnapshot || readProtectedRootFile(
    resolved,
    opened,
    `${operation}:source`,
  );
  return withProtectedRootMutation(opened, operation, [resolved], () => {
    const current = assertProtectedPath(resolved, {
      privateFile: true,
      gatewayIdentity: opened.gatewayIdentity,
      aclVerifier: opened.aclVerifier,
      expectedChain: initial.pathSnapshot.chain,
      phase: `${operation}:immediate`,
    });
    if (!sameStableFile(initial.fileIdentity, current.chain.at(-1)?.fileIdentity)) {
      throw nonceError(
        "WORKER_LAUNCH_NONCE_PATH_IDENTITY_DRIFT",
        "Worker launch nonce unlink 前文件发生变化",
      );
    }
    fs.unlinkSync(resolved);
    try {
      fs.lstatSync(resolved, { bigint: true });
      throw nonceError(
        "WORKER_LAUNCH_NONCE_PATH_IDENTITY_DRIFT",
        "Worker launch nonce unlink 后路径仍存在",
      );
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  });
}

function readProtectedRootEntries(opened, phase) {
  assertProtectedRoot(opened, `${phase}:pre`);
  const entries = fs.readdirSync(opened.root);
  assertProtectedRoot(opened, `${phase}:post`);
  return entries;
}

function protectedRootFileExists(target, opened, phase) {
  const resolved = assertImmediateRootChild(opened, target);
  try {
    assertProtectedPath(resolved, {
      privateFile: true,
      gatewayIdentity: opened.gatewayIdentity,
      aclVerifier: opened.aclVerifier,
      phase,
    });
    return true;
  } catch (error) {
    if (error?.code === "WORKER_LAUNCH_NONCE_PATH_MISSING") return false;
    throw error;
  }
}

function auditSigningBytes(document = {}) {
  return Buffer.from(JSON.stringify({
    schema: String(document.schema || ""),
    version: Number(document.version),
    algorithm: String(document.algorithm || ""),
    keyId: String(document.keyId || ""),
    archivedAt: Number(document.archivedAt),
    records: (Array.isArray(document.records) ? document.records : []).map((record) => ({
      stateDigest: String(record.stateDigest || ""),
      nonceDigest: String(record.nonceDigest || ""),
      envelopeSha256: String(record.envelopeSha256 || ""),
      payloadSha256: String(record.payloadSha256 || ""),
      storyId: String(record.storyId || ""),
      taskId: String(record.taskId || ""),
      workerIdentity: String(record.workerIdentity || ""),
      issuedAt: Number(record.issuedAt),
      expiresAt: Number(record.expiresAt),
      disposition: String(record.disposition || ""),
    })),
  }), "utf8");
}

function archiveRecord(state, disposition) {
  return {
    stateDigest: sha256(Buffer.from(JSON.stringify(state), "utf8")),
    nonceDigest: sha256(Buffer.from(String(state.nonce || ""), "utf8")),
    envelopeSha256: String(state.envelopeSha256 || ""),
    payloadSha256: String(state.payloadSha256 || ""),
    storyId: String(state.storyId || ""),
    taskId: String(state.taskId || ""),
    workerIdentity: String(state.workerIdentity || ""),
    issuedAt: Number(state.issuedAt),
    expiresAt: Number(state.expiresAt),
    disposition,
  };
}

function readAuditDocument(target, opened) {
  const read = readProtectedRootFile(target, opened, "audit-read");
  let document;
  try {
    document = JSON.parse(read.bytes.toString("utf8"));
  } catch {
    throw nonceError(
      "WORKER_LAUNCH_NONCE_AUDIT_INVALID",
      "Worker launch nonce audit 不可读",
    );
  }
  if (
    !document
    || typeof document !== "object"
    || Array.isArray(document)
    || JSON.stringify(Object.keys(document).sort()) !== JSON.stringify(AUDIT_FIELDS)
    || document.schema !== AUDIT_SCHEMA
    || document.version !== 1
    || document.algorithm !== "Ed25519"
    || document.keyId !== keyId(opened.publicKey)
    || !Number.isSafeInteger(document.archivedAt)
    || !Array.isArray(document.records)
    || document.records.length === 0
    || document.records.length > opened.maxAuditRecords
    || document.records.some((record) => (
      !SHA256_PATTERN.test(String(record?.stateDigest || ""))
      || !SHA256_PATTERN.test(String(record?.nonceDigest || ""))
      || !SHA256_PATTERN.test(String(record?.envelopeSha256 || ""))
      || !SHA256_PATTERN.test(String(record?.payloadSha256 || ""))
      || !Number.isSafeInteger(record?.issuedAt)
      || !Number.isSafeInteger(record?.expiresAt)
      || !["expired-issued", "expired-consumed"].includes(record?.disposition)
    ))
    || !BASE64URL_PATTERN.test(String(document.signature || ""))
    || !verify(
      null,
      auditSigningBytes(document),
      opened.publicKey,
      Buffer.from(document.signature, "base64url"),
    )
  ) {
    throw nonceError(
      "WORKER_LAUNCH_NONCE_AUDIT_INVALID",
      "Worker launch nonce audit 签名或字段无效",
    );
  }
  return document;
}

function writeAuditDocument(records, archivedAt, opened) {
  const body = {
    schema: AUDIT_SCHEMA,
    version: 1,
    algorithm: "Ed25519",
    keyId: keyId(opened.publicKey),
    archivedAt,
    records,
  };
  const document = {
    ...body,
    signature: sign(null, auditSigningBytes(body), opened.privateKey).toString("base64url"),
  };
  const target = path.join(
    opened.root,
    `audit-${String(archivedAt).padStart(16, "0")}-${randomBytes(12).toString("hex")}.json`,
  );
  createProtectedFile(
    target,
    `${JSON.stringify(document)}\n`,
    opened,
    { operation: "audit-create" },
  );
  return target;
}

function acquireGcLock(opened, now) {
  const lockPath = path.join(opened.root, ".worker-launch-nonce-gc.lock");
  try {
    const created = createProtectedFile(
      lockPath,
      `${process.pid}\n`,
      opened,
      { operation: "gc-lock-create", keepOpen: true },
    );
    return {
      acquired: true,
      fd: created.fd,
      lockPath,
      opened,
      sourceSnapshot: created,
    };
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
  }
  let existing;
  try {
    existing = readProtectedRootFile(lockPath, opened, "gc-lock-existing");
  } catch (error) {
    if (error?.code !== "WORKER_LAUNCH_NONCE_PATH_MISSING") throw error;
    return { acquired: false };
  }
  const mtimeMs = Number(BigInt(existing.fileIdentity.mtimeNs) / 1_000_000n);
  if (
    now - mtimeMs <= GC_LOCK_STALE_MS
  ) {
    return { acquired: false };
  }
  const stalePath = path.join(
    opened.root,
    `.worker-launch-nonce-gc.stale-${process.pid}-${randomBytes(8).toString("hex")}`,
  );
  try {
    const stale = renameProtectedFile(lockPath, stalePath, opened, {
      operation: "gc-lock-stale-rename",
      sourceSnapshot: existing,
    });
    unlinkProtectedFile(stalePath, opened, {
      operation: "gc-lock-stale-unlink",
      sourceSnapshot: stale,
    });
  } catch (error) {
    if (
      error?.code === "ENOENT"
      || error?.code === "EEXIST"
      || error?.code === "EPERM"
      || error?.code === "WORKER_LAUNCH_NONCE_COLLISION"
      || error?.code === "WORKER_LAUNCH_NONCE_PATH_MISSING"
    ) {
      return { acquired: false };
    }
    throw error;
  }
  return acquireGcLock(opened, now);
}

function releaseGcLock(lock) {
  if (!lock?.acquired) return;
  try { fs.closeSync(lock.fd); } catch {}
  unlinkProtectedFile(lock.lockPath, lock.opened, {
    operation: "gc-lock-release",
    sourceSnapshot: lock.sourceSnapshot,
  });
}

function stateFileEntries(opened) {
  return readProtectedRootEntries(opened, "state-list")
    .filter((name) => (
      /^[0-9a-f]{64}\.(?:issued|consumed)(?:\.archiving)?\.json$/.test(name)
    ))
    .sort();
}

function assertLedgerCapacity(opened) {
  if (stateFileEntries(opened).length >= opened.maxStateFiles) {
    throw nonceError(
      "WORKER_LAUNCH_NONCE_CAPACITY_EXCEEDED",
      "Worker launch nonce ledger 已达安全容量上限，拒绝签发新启动",
    );
  }
}

export function garbageCollectWorkerLaunchNonces(options = {}) {
  const opened = storeOptions(options);
  const now = options.now ?? Date.now();
  if (!Number.isSafeInteger(now)) {
      throw nonceError("WORKER_LAUNCH_NONCE_GC_TIME_INVALID", "nonce GC 时间无效");
  }
  assertProtectedRoot(opened, "gc:pre");
  const lock = acquireGcLock(opened, now);
  if (!lock.acquired) {
    assertProtectedRoot(opened, "gc:skipped-post");
    return Object.freeze({ archived: 0, skipped: true });
  }
  let archived = 0;
  try {
    let auditFiles = readProtectedRootEntries(opened, "audit-list")
      .filter((name) => /^audit-[0-9]{16}-[0-9a-f]{24}\.json$/.test(name))
      .sort();
    const auditedDigests = new Set();
    for (const name of auditFiles) {
      const document = readAuditDocument(path.join(opened.root, name), opened);
      for (const record of document.records) auditedDigests.add(record.stateDigest);
    }

    const eligible = [];
    for (const name of stateFileEntries(opened)) {
      const target = path.join(opened.root, name);
      const stateRead = readProtectedRootFile(target, opened, "gc-state-read");
      let state;
      try {
        state = JSON.parse(stateRead.bytes.toString("utf8"));
      } catch {
        throw nonceError(
          "WORKER_LAUNCH_NONCE_STATE_INVALID",
          "Worker launch nonce GC 遇到不可读 state",
        );
      }
      validateState(state, {}, opened.publicKey);
      if (
        !Number.isSafeInteger(state.expiresAt)
        || state.expiresAt + MAX_CLOCK_SKEW_MS > now
      ) {
        continue;
      }
      const expectedDigest = sha256(Buffer.from(String(state.nonce || ""), "utf8"));
      if (!name.startsWith(`${expectedDigest}.`)) {
        throw nonceError(
          "WORKER_LAUNCH_NONCE_STATE_DRIFT",
          "Worker launch nonce state 文件名与签名 nonce 不一致",
        );
      }
      let archivingPath = target;
      let archivingSnapshot = stateRead;
      const disposition = name.includes(".issued")
        ? "expired-issued"
        : "expired-consumed";
      if (!name.endsWith(".archiving.json")) {
        const paths = statePaths(opened.root, state.nonce);
        archivingPath = disposition === "expired-issued"
          ? paths.archivingIssued
          : paths.archivingConsumed;
        try {
          archivingSnapshot = renameProtectedFile(target, archivingPath, opened, {
            operation: "gc-state-archive-rename",
            sourceSnapshot: stateRead,
          });
        } catch (error) {
          if (
            String(error?.code || "").startsWith("WORKER_LAUNCH_NONCE_PATH_")
            || error?.code === "WORKER_LAUNCH_NONCE_ACL_UNSAFE"
          ) {
            throw error;
          }
          throw nonceError(
            "WORKER_LAUNCH_NONCE_GC_TRANSITION_FAILED",
            "Worker launch nonce 无法原子转入归档态",
          );
        }
      }
      eligible.push({
        archivingPath,
        archivingSnapshot,
        record: archiveRecord(state, disposition),
      });
    }

    for (let offset = 0; offset < eligible.length; offset += opened.maxAuditRecords) {
      const batch = eligible.slice(offset, offset + opened.maxAuditRecords);
      const fresh = batch
        .map((item) => item.record)
        .filter((record) => !auditedDigests.has(record.stateDigest));
      if (fresh.length > 0) {
        writeAuditDocument(fresh, now, opened);
        for (const record of fresh) auditedDigests.add(record.stateDigest);
      }
      for (const item of batch) {
        unlinkProtectedFile(item.archivingPath, opened, {
          operation: "gc-state-archive-unlink",
          sourceSnapshot: item.archivingSnapshot,
        });
        archived += 1;
      }
    }

    auditFiles = readProtectedRootEntries(opened, "audit-rotation-list")
      .filter((name) => /^audit-[0-9]{16}-[0-9a-f]{24}\.json$/.test(name))
      .sort();
    while (auditFiles.length > opened.maxAuditFiles) {
      unlinkProtectedFile(
        path.join(opened.root, auditFiles.shift()),
        opened,
        { operation: "audit-rotation-unlink" },
      );
    }
    assertProtectedRoot(opened, "gc:body-post");
    return Object.freeze({ archived, skipped: false });
  } finally {
    releaseGcLock(lock);
    assertProtectedRoot(opened, "gc:post");
  }
}

export function issueWorkerLaunchNonce(encodedEnvelope, options = {}) {
  garbageCollectWorkerLaunchNonces(options);
  const opened = storeOptions(options);
  assertLedgerCapacity(opened);
  const parsed = parseEnvelope(encodedEnvelope, {
    now: options.now,
    publicKey: opened.publicKey,
  });
  const paths = statePaths(opened.root, parsed.context.nonce);
  if (
    protectedRootFileExists(paths.issued, opened, "issue-collision-issued")
    || protectedRootFileExists(paths.consumed, opened, "issue-collision-consumed")
    || protectedRootFileExists(paths.archivingIssued, opened, "issue-collision-archiving-issued")
    || protectedRootFileExists(
      paths.archivingConsumed,
      opened,
      "issue-collision-archiving-consumed",
    )
  ) {
    throw nonceError(
      "WORKER_LAUNCH_NONCE_COLLISION",
      "Worker launch envelope nonce 已存在",
    );
  }
  const state = signedState(parsed.context, opened.privateKey, opened.publicKey);
  try {
    createProtectedFile(
      paths.issued,
      `${JSON.stringify(state)}\n`,
      opened,
      { operation: "nonce-issue-create" },
    );
  } catch (error) {
    if (error?.code === "EEXIST") {
      throw nonceError("WORKER_LAUNCH_NONCE_COLLISION", "Worker launch envelope nonce 已存在");
    }
    throw error;
  }
  return Object.freeze({ ...parsed.context });
}

export function consumeWorkerLaunchNonce(encodedEnvelope, challenge, options = {}) {
  const challengeBytes = Buffer.isBuffer(challenge) ? challenge : Buffer.from(challenge || "");
  if (challengeBytes.length !== 32) {
    throw nonceError(
      "WORKER_LAUNCH_NONCE_CHALLENGE_INVALID",
      "Worker launch nonce challenge 必须是 32 字节",
    );
  }
  const launcherInstanceEvidence = normalizeLauncherInstanceEvidence(
    options.launcherInstanceEvidence,
  );
  const opened = storeOptions(options);
  const parsed = parseEnvelope(encodedEnvelope, {
    now: options.now,
    publicKey: opened.publicKey,
  });
  const paths = statePaths(opened.root, parsed.context.nonce);
  if (
    protectedRootFileExists(paths.consumed, opened, "consume-consumed-check")
    || !protectedRootFileExists(paths.issued, opened, "consume-issued-check")
  ) {
    throw nonceError("WORKER_LAUNCH_NONCE_REPLAYED", "Worker launch envelope 已消费或未签发");
  }
  const stateRead = readProtectedRootFile(paths.issued, opened, "consume-state-read");
  let state;
  try {
    state = JSON.parse(stateRead.bytes.toString("utf8"));
  } catch {
    throw nonceError("WORKER_LAUNCH_NONCE_STATE_INVALID", "Worker launch nonce state 不可读");
  }
  validateState(state, parsed.context, opened.publicKey);
  if (parsed.context.expiresAt <= (options.now ?? Date.now())) {
    throw nonceError("WORKER_LAUNCH_NONCE_EXPIRED", "Worker launch nonce 已过期");
  }
  try {
    renameProtectedFile(paths.issued, paths.consumed, opened, {
      operation: "nonce-consume-rename",
      sourceSnapshot: stateRead,
    });
  } catch (error) {
    if (
      error?.code === "ENOENT"
      || error?.code === "EEXIST"
      || error?.code === "EPERM"
      || error?.code === "WORKER_LAUNCH_NONCE_COLLISION"
      || error?.code === "WORKER_LAUNCH_NONCE_PATH_MISSING"
    ) {
      throw nonceError("WORKER_LAUNCH_NONCE_REPLAYED", "Worker launch envelope 并发重放");
    }
    throw error;
  }
  if (options.testCrashAfterConsume === true) {
    if (process.env.NODE_ENV !== "test") {
      throw nonceError(
        "WORKER_LAUNCH_NONCE_TEST_CRASH_FORBIDDEN",
        "nonce crash 注入仅允许 NODE_ENV=test",
      );
    }
    throw nonceError(
      "WORKER_LAUNCH_NONCE_TEST_CRASH",
      "模拟 nonce 已消费但 receipt 尚未返回的崩溃",
    );
  }
  const consumedAt = options.now ?? Date.now();
  const receipt = {
    schema: WORKER_LAUNCH_RECEIPT_SCHEMA,
    version: 2,
    algorithm: "Ed25519",
    keyId: keyId(opened.publicKey),
    envelopeNonce: parsed.context.nonce,
    envelopeSha256: parsed.context.envelopeSha256,
    payloadSha256: parsed.context.payloadSha256,
    storyId: parsed.context.storyId,
    taskId: parsed.context.taskId,
    workerIdentity: parsed.context.workerIdentity,
    challengeSha256: sha256(challengeBytes),
    launcherInstanceEvidenceSha256: sha256(
      Buffer.from(launcherInstanceEvidence, "utf8"),
    ),
    consumedAt,
    expiresAt: Math.min(parsed.context.expiresAt, consumedAt + MAX_RECEIPT_AGE_MS),
  };
  return Buffer.from(JSON.stringify({
    ...receipt,
    signature: sign(
      null,
      workerLaunchReceiptSigningBytes(receipt),
      opened.privateKey,
    ).toString("base64url"),
  }), "utf8").toString("base64url");
}

export function verifyWorkerLaunchConsumptionReceipt(
  encodedReceipt,
  {
    encodedEnvelope,
    challenge,
    launcherInstanceEvidence,
    now = Date.now(),
    testPublicKey,
  } = {},
) {
  const publicKey = testPublicKey !== undefined
    ? (() => {
      if (process.env.NODE_ENV !== "test") {
        throw nonceError(
          "WORKER_LAUNCH_RECEIPT_TEST_KEY_FORBIDDEN",
          "Worker launch receipt 测试公钥仅允许 NODE_ENV=test",
        );
      }
      return testPublicKey?.type === "public" ? testPublicKey : createPublicKey(testPublicKey);
    })()
    : createPublicKey(readFdBoundProtectedFile(PUBLIC_KEY_PATH, {
      phase: "receipt-public-key",
    }).bytes);
  const parsed = parseEnvelope(encodedEnvelope, { now, publicKey });
  let receipt;
  try {
    receipt = JSON.parse(Buffer.from(String(encodedReceipt || ""), "base64url").toString("utf8"));
  } catch {
    throw nonceError("WORKER_LAUNCH_RECEIPT_INVALID", "Worker launch receipt JSON 无效");
  }
  const challengeBytes = Buffer.isBuffer(challenge) ? challenge : Buffer.from(challenge || "");
  const expectedInstanceEvidence = normalizeLauncherInstanceEvidence(
    launcherInstanceEvidence,
  );
  if (
    !receipt
    || typeof receipt !== "object"
    || Array.isArray(receipt)
    || JSON.stringify(Object.keys(receipt).sort()) !== JSON.stringify(RECEIPT_FIELDS)
    || receipt.schema !== WORKER_LAUNCH_RECEIPT_SCHEMA
    || receipt.version !== 2
    || receipt.algorithm !== "Ed25519"
    || receipt.keyId !== keyId(publicKey)
    || receipt.envelopeNonce !== parsed.context.nonce
    || receipt.envelopeSha256 !== parsed.context.envelopeSha256
    || receipt.payloadSha256 !== parsed.context.payloadSha256
    || receipt.storyId !== parsed.context.storyId
    || receipt.taskId !== parsed.context.taskId
    || receipt.workerIdentity !== parsed.context.workerIdentity
    || receipt.challengeSha256 !== sha256(challengeBytes)
    || receipt.launcherInstanceEvidenceSha256 !== sha256(
      Buffer.from(expectedInstanceEvidence, "utf8"),
    )
    || !Number.isSafeInteger(receipt.consumedAt)
    || !Number.isSafeInteger(receipt.expiresAt)
    || receipt.expiresAt <= now
    || receipt.expiresAt - receipt.consumedAt > MAX_RECEIPT_AGE_MS
    || !BASE64URL_PATTERN.test(String(receipt.signature || ""))
    || !verify(
      null,
      workerLaunchReceiptSigningBytes(receipt),
      publicKey,
      Buffer.from(receipt.signature, "base64url"),
    )
  ) {
    throw nonceError(
      "WORKER_LAUNCH_RECEIPT_INVALID",
      "Worker launch receipt 未绑定当前 nonce/story/task/worker/payload/challenge",
    );
  }
  return Object.freeze({ ...receipt });
}

function readFrame(fd) {
  const chunks = [];
  let total = 0;
  const buffer = Buffer.allocUnsafe(8192);
  while (true) {
    const read = fs.readSync(fd, buffer, 0, buffer.length, null);
    if (read === 0) break;
    total += read;
    if (total > MAX_FRAME_BYTES) {
      throw nonceError("WORKER_LAUNCH_NONCE_FRAME_TOO_LARGE", "nonce helper frame 过大");
    }
    chunks.push(Buffer.from(buffer.subarray(0, read)));
  }
  return Buffer.concat(chunks);
}

export function parseWorkerLaunchChannelChallenge(frame) {
  let document;
  try {
    document = JSON.parse(Buffer.from(frame || "").toString("utf8"));
  } catch {
    throw nonceError(
      "WORKER_LAUNCH_CHANNEL_CHALLENGE_INVALID",
      "native launcher channel challenge JSON 无效",
    );
  }
  if (
    !document
    || typeof document !== "object"
    || Array.isArray(document)
    || JSON.stringify(Object.keys(document).sort()) !== JSON.stringify([
      "challenge",
      "launcherInstanceEvidence",
      "schema",
      "version",
    ])
    || document.schema !== WORKER_LAUNCH_CHANNEL_CHALLENGE_SCHEMA
    || document.version !== 1
    || !/^[A-Za-z0-9_-]{43}$/.test(String(document.challenge || ""))
    || Buffer.from(String(document.challenge || ""), "base64url").length !== 32
  ) {
    throw nonceError(
      "WORKER_LAUNCH_CHANNEL_CHALLENGE_INVALID",
      "native launcher channel challenge schema 无效",
    );
  }
  return Object.freeze({
    challenge: Buffer.from(document.challenge, "base64url"),
    launcherInstanceEvidence: normalizeLauncherInstanceEvidence(
      document.launcherInstanceEvidence,
    ),
  });
}

function runCli(argv = process.argv) {
  const marker = argv.indexOf("--devbench-worker-spec");
  const envelope = marker >= 0 ? String(argv[marker + 1] || "") : "";
  if (!envelope || argv.filter((value) => value === "--devbench-worker-spec").length !== 1) {
    throw nonceError(
      "WORKER_LAUNCH_NONCE_HELPER_ARGS_INVALID",
      "nonce helper 只接受一个固定 Worker envelope",
    );
  }
  const channelChallenge = parseWorkerLaunchChannelChallenge(readFrame(3));
  const receipt = consumeWorkerLaunchNonce(
    envelope,
    channelChallenge.challenge,
    { launcherInstanceEvidence: channelChallenge.launcherInstanceEvidence },
  );
  fs.writeSync(4, Buffer.from(receipt, "utf8"));
  fs.closeSync(4);
}

const isMain = process.argv[1]
  && pathToFileURL(path.resolve(process.argv[1])).href.toLowerCase() === import.meta.url.toLowerCase();
if (isMain) {
  try {
    runCli();
  } catch (error) {
    process.stderr.write(`DevBench Worker Nonce Helper: ${error.code || "FAILED"}\n`);
    process.exit(125);
  }
}
