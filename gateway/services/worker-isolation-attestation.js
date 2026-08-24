import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import {
  createHash,
  createPublicKey,
  randomUUID,
  verify,
} from "node:crypto";
import { fileURLToPath } from "node:url";

const SERVICE_DIR = path.dirname(fileURLToPath(import.meta.url));
const WINDOWS_POWERSHELL_PATH = path.win32.resolve(
  String(process.env.SystemRoot || `${process.env.SystemDrive || "C:"}\\Windows`),
  "System32",
  "WindowsPowerShell",
  "v1.0",
  "powershell.exe",
);
const WINDOWS_SYSTEM_ROOT = path.win32.resolve(
  path.win32.dirname(WINDOWS_POWERSHELL_PATH),
  "..",
  "..",
  "..",
);
const DOCUMENT_FIELDS = Object.freeze([
  "algorithm",
  "entries",
  "generation",
  "keyId",
  "schema",
  "signature",
  "version",
].sort());
const ENTRY_FIELDS = Object.freeze([
  "brokerSha256",
  "configSha256",
  "expiresAt",
  "gatewayIdentity",
  "issuedAt",
  "launcherSha256",
  "platform",
  "probeNonce",
  "probeScopeDigest",
  "storyId",
  "workerIdentity",
  "workerPolicyDigest",
].sort());
const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;
const MAX_PROTECTED_FILE_BYTES = 1024 * 1024;

export const WORKER_DEPLOYMENT_ATTESTATION_SCHEMA = "devbench.worker-deployment-attestations.v2";
export const WORKER_DEPLOYMENT_ATTESTATION_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
export const WORKER_DEPLOYMENT_ATTESTATION_PATH = path.resolve(
  SERVICE_DIR,
  "../.secrets/worker-deployment-attestations.json",
);
const WORKER_LAUNCH_TRUST_ANCHOR_PATH = path.resolve(
  SERVICE_DIR,
  "../config/worker-launcher-public.pem",
);

function normalizedPath(value, platform = process.platform) {
  const normalized = path.resolve(String(value || ""))
    .replace(/[\\/]+/g, "/")
    .replace(/\/+$/, "");
  return String(platform).toLowerCase() === "win32"
    ? normalized.toLowerCase()
    : normalized;
}

function pathIsInside(root, candidate) {
  const parent = normalizedPath(root);
  const child = normalizedPath(candidate);
  return !!parent && !!child && (child === parent || child.startsWith(`${parent}/`));
}

function attestationError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function sortedStrings(values, { lowerCase = false } = {}) {
  return [...new Set(
    (Array.isArray(values) ? values : [])
      .map((value) => String(value || "").trim())
      .filter(Boolean)
      .map((value) => (lowerCase ? value.toLowerCase() : value)),
  )].sort();
}

function canonicalInaccessibleEntries(values, inaccessibleRoots) {
  const rootsByKey = new Map(
    inaccessibleRoots.map((root) => [normalizedPath(root), root]),
  );
  const seen = new Set();
  const rootEntries = new Set();
  const entries = [];
  for (const value of Array.isArray(values) ? values : []) {
    if (
      !value
      || typeof value !== "object"
      || Array.isArray(value)
      || JSON.stringify(Object.keys(value).sort())
        !== JSON.stringify(["path", "root", "type"])
    ) {
      throw attestationError(
        "WORKER_DEPLOYMENT_ATTESTATION_GRANT_INVALID",
        "Worker deployment attestation inaccessible entry schema 无效",
      );
    }
    const root = String(value.root || "").trim();
    const entryPath = String(value.path || "").trim();
    const type = String(value.type || "").trim();
    const canonicalRoot = rootsByKey.get(normalizedPath(root));
    const entryKey = `${normalizedPath(root)}\0${normalizedPath(entryPath)}`;
    if (
      !canonicalRoot
      || !path.isAbsolute(root)
      || !path.isAbsolute(entryPath)
      || !["directory", "file", "missing"].includes(type)
      || !pathIsInside(canonicalRoot, entryPath)
      || seen.has(entryKey)
      || (type === "missing"
        && normalizedPath(canonicalRoot) !== normalizedPath(entryPath))
    ) {
      throw attestationError(
        "WORKER_DEPLOYMENT_ATTESTATION_GRANT_INVALID",
        "Worker deployment attestation inaccessible entry 未绑定唯一禁止访问根",
      );
    }
    seen.add(entryKey);
    if (normalizedPath(canonicalRoot) === normalizedPath(entryPath)) {
      rootEntries.add(normalizedPath(canonicalRoot));
    }
    entries.push({
      root: canonicalRoot,
      path: path.resolve(entryPath),
      type,
    });
  }
  if (
    entries.length === 0
    || rootEntries.size !== rootsByKey.size
    || [...rootsByKey.keys()].some((rootKey) => !rootEntries.has(rootKey))
  ) {
    throw attestationError(
      "WORKER_DEPLOYMENT_ATTESTATION_GRANT_INVALID",
      "Worker deployment attestation 缺少 Controller inaccessible tree manifest",
    );
  }
  return entries.sort((left, right) => (
    normalizedPath(left.root).localeCompare(normalizedPath(right.root))
    || normalizedPath(left.path).localeCompare(normalizedPath(right.path))
  ));
}

export function workerIsolationGrantFingerprint(grant = {}) {
  const version = Number(grant.version);
  const storyId = String(grant.storyId || "").trim();
  const repositoryMode = String(grant.repositoryMode || "").trim();
  const topologyCwd = String(grant.topologyCwd || "").trim();
  const workerIdentity = String(grant.workerIdentity || "").trim().toLowerCase();
  const aclFingerprints = sortedStrings(grant.aclFingerprints, { lowerCase: true });
  const allowedRoots = sortedStrings(grant.allowedRoots);
  const writeDeniedRoots = sortedStrings(grant.writeDeniedRoots);
  const inaccessibleRoots = sortedStrings(grant.inaccessibleRoots);
  const inaccessibleEntries = canonicalInaccessibleEntries(
    grant.inaccessibleEntries,
    inaccessibleRoots,
  );
  const deniedRoots = sortedStrings([...writeDeniedRoots, ...inaccessibleRoots]);
  const boundarySentinels = (Array.isArray(grant.boundarySentinels)
    ? grant.boundarySentinels
    : [])
    .map((item) => ({
      deniedRoot: String(item?.deniedRoot || "").trim(),
      sentinelPath: String(item?.sentinelPath || "").trim(),
    }))
    .sort((left, right) => left.deniedRoot.localeCompare(right.deniedRoot));
  const sentinelDeniedRoots = sortedStrings(
    boundarySentinels.map((item) => item.deniedRoot),
  );
  if (
    version !== 2
    || Object.hasOwn(grant, "forbiddenRoots")
    || Object.hasOwn(grant, "mirrorRoots")
    || Object.hasOwn(grant, "secretRoots")
    || !storyId
    || repositoryMode !== "INDEPENDENT_REPOSITORY"
    || !path.isAbsolute(topologyCwd)
    || !workerIdentity
    || !Number.isSafeInteger(Number(grant?.topologyGeneration))
    || Number(grant?.topologyGeneration) < 1
    || aclFingerprints.length === 0
    || aclFingerprints.some((value) => !SHA256_HEX_PATTERN.test(value))
    || [allowedRoots, writeDeniedRoots, inaccessibleRoots]
      .some((values) => values.length === 0)
    || writeDeniedRoots.some((value) => inaccessibleRoots.includes(value))
    || boundarySentinels.length !== deniedRoots.length
    || JSON.stringify(sentinelDeniedRoots) !== JSON.stringify(deniedRoots)
    || boundarySentinels.some((item) => (
      !path.isAbsolute(item.deniedRoot)
      || !path.isAbsolute(item.sentinelPath)
    ))
    || [...allowedRoots, ...deniedRoots]
      .some((value) => !path.isAbsolute(value))
    || !allowedRoots.some((root) => pathIsInside(root, topologyCwd))
    || allowedRoots.some((allowed) => deniedRoots.some((denied) => (
      pathIsInside(allowed, denied) || pathIsInside(denied, allowed)
    )))
  ) {
    throw attestationError(
      "WORKER_DEPLOYMENT_ATTESTATION_GRANT_INVALID",
      "Worker deployment attestation 需要完整独立故事仓 grant 与 Controller ACL 指纹",
    );
  }
  return createHash("sha256").update(JSON.stringify({
    version: 2,
    storyId,
    repositoryMode,
    topologyCwd,
    allowedRoots,
    writeDeniedRoots,
    inaccessibleRoots,
    inaccessibleEntries,
    boundarySentinels,
    workerIdentity,
    aclFingerprints,
    topologyGeneration: Number(grant?.topologyGeneration),
  })).digest("hex");
}

function canonicalEntry(entry = {}) {
  return {
    storyId: String(entry.storyId || ""),
    platform: String(entry.platform || ""),
    workerIdentity: String(entry.workerIdentity || ""),
    gatewayIdentity: String(entry.gatewayIdentity || ""),
    configSha256: String(entry.configSha256 || ""),
    launcherSha256: String(entry.launcherSha256 || ""),
    brokerSha256: String(entry.brokerSha256 || ""),
    workerPolicyDigest: String(entry.workerPolicyDigest || ""),
    probeScopeDigest: String(entry.probeScopeDigest || ""),
    probeNonce: String(entry.probeNonce || ""),
    issuedAt: String(entry.issuedAt || ""),
    expiresAt: String(entry.expiresAt || ""),
  };
}

export function workerDeploymentAttestationSigningBytes(document = {}) {
  return Buffer.from(JSON.stringify({
    schema: String(document.schema || ""),
    version: Number(document.version),
    generation: Number(document.generation),
    algorithm: String(document.algorithm || ""),
    keyId: String(document.keyId || ""),
    entries: (Array.isArray(document.entries) ? document.entries : [])
      .map(canonicalEntry)
      .sort((left, right) => left.storyId.localeCompare(right.storyId)),
  }), "utf8");
}

function trustAnchorKeyId(publicKey) {
  const key = publicKey?.type === "public" ? publicKey : createPublicKey(publicKey);
  if (key?.asymmetricKeyType !== "ed25519") {
    throw attestationError(
      "WORKER_DEPLOYMENT_ATTESTATION_KEY_INVALID",
      "Worker deployment attestation 信任锚必须是 Ed25519 公钥",
    );
  }
  return `ed25519:${createHash("sha256")
    .update(key.export({ type: "spki", format: "der" }))
    .digest("base64url")}`;
}

function protectedPathSegments(target) {
  const resolved = path.resolve(target);
  const parsed = path.parse(resolved);
  const parts = resolved.slice(parsed.root.length).split(path.sep).filter(Boolean);
  const segments = [parsed.root];
  let cursor = parsed.root;
  for (const part of parts) {
    cursor = path.join(cursor, part);
    segments.push(cursor);
  }
  return { resolved, segments };
}

function statValue(stat, field) {
  const value = stat?.[field];
  return typeof value === "bigint" ? value.toString() : String(value ?? "");
}

function stableObjectIdentity(stat, { includeContent = false } = {}) {
  const identity = {
    dev: statValue(stat, "dev"),
    ino: statValue(stat, "ino"),
    mode: statValue(stat, "mode"),
    uid: statValue(stat, "uid"),
    gid: statValue(stat, "gid"),
    nlink: statValue(stat, "nlink"),
    type: stat?.isDirectory() ? "directory" : stat?.isFile() ? "file" : "other",
  };
  if (includeContent) {
    identity.size = statValue(stat, "size");
    identity.mtimeNs = statValue(stat, "mtimeNs") || statValue(stat, "mtimeMs");
    identity.ctimeNs = statValue(stat, "ctimeNs") || statValue(stat, "ctimeMs");
  }
  return identity;
}

function sameObjectIdentity(left, right, { includeContent = false } = {}) {
  return JSON.stringify(stableObjectIdentity(left, { includeContent }))
    === JSON.stringify(stableObjectIdentity(right, { includeContent }));
}

function invokeTestHook(options, name, details = {}) {
  const hook = options?.testHooks?.[name];
  if (hook === undefined) return;
  if (process.env.NODE_ENV !== "test" || typeof hook !== "function") {
    throw attestationError(
      "WORKER_DEPLOYMENT_ATTESTATION_TEST_HOOK_FORBIDDEN",
      "deployment attestation 测试钩子仅允许 NODE_ENV=test",
    );
  }
  hook(Object.freeze({ ...details }));
}

function assertWindowsProtectedChain(targets, gatewayIdentity, execFile = execFileSync) {
  const gatewaySid = String(gatewayIdentity || "").replace(/^sid:/i, "").toUpperCase();
  if (!/^S-\d(?:-\d+)+$/.test(gatewaySid)) {
    throw attestationError(
      "WORKER_DEPLOYMENT_ATTESTATION_GATEWAY_IDENTITY_INVALID",
      "无法取得 Gateway Windows SID，不能验证 deployment attestation ACL",
    );
  }
  const encodedTargets = targets
    .map((target) => `'${Buffer.from(target, "utf8").toString("base64")}'`)
    .join(",");
  const script = [
    "$ErrorActionPreference='Stop'",
    `$encodedTargets=@(${encodedTargets})`,
    `$gateway='${gatewaySid}'`,
    "$allowed=@($gateway,'S-1-5-18','S-1-5-32-544')",
    "$write=[Security.AccessControl.FileSystemRights]::WriteData -bor [Security.AccessControl.FileSystemRights]::CreateFiles -bor [Security.AccessControl.FileSystemRights]::CreateDirectories -bor [Security.AccessControl.FileSystemRights]::AppendData -bor [Security.AccessControl.FileSystemRights]::WriteAttributes -bor [Security.AccessControl.FileSystemRights]::WriteExtendedAttributes -bor [Security.AccessControl.FileSystemRights]::Delete -bor [Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles -bor [Security.AccessControl.FileSystemRights]::ChangePermissions -bor [Security.AccessControl.FileSystemRights]::TakeOwnership",
    "foreach($encodedTarget in @($encodedTargets)){",
    " $target=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($encodedTarget))",
    " $item=Microsoft.PowerShell.Management\\Get-Item -Force -LiteralPath $target",
    " if(($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0){exit 30}",
    " $acl=Microsoft.PowerShell.Security\\Get-Acl -LiteralPath $target",
    " $owner=$acl.GetOwner([Security.Principal.SecurityIdentifier]).Value.ToUpperInvariant()",
    " if($allowed -notcontains $owner){exit 31}",
    " $bad=$false",
    " foreach($rule in @($acl.Access)){",
    "  if($rule.AccessControlType -eq 'Allow' -and ($rule.FileSystemRights -band $write) -ne 0){",
    "   $sid=$rule.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value.ToUpperInvariant()",
    "   if($allowed -notcontains $sid){$bad=$true;break}",
    "  }",
    " }",
    " if($bad){exit 32}",
    "}",
  ].join(";");
  try {
    execFile(
      WINDOWS_POWERSHELL_PATH,
      ["-NoProfile", "-NonInteractive", "-Command", script],
      {
        windowsHide: true,
        timeout: 10_000,
        stdio: "ignore",
        env: {
          SystemRoot: WINDOWS_SYSTEM_ROOT,
          WINDIR: WINDOWS_SYSTEM_ROOT,
          ComSpec: path.win32.join(WINDOWS_SYSTEM_ROOT, "System32", "cmd.exe"),
          PATH: path.win32.join(WINDOWS_SYSTEM_ROOT, "System32"),
        },
      },
    );
  } catch {
    throw attestationError(
      "WORKER_DEPLOYMENT_ATTESTATION_ACL_UNSAFE",
      "Worker deployment attestation 全父链允许非 Gateway 管理身份修改或包含重解析点",
    );
  }
}

function captureStrongProtectedPath(
  target,
  {
    platform = process.platform,
    gatewayIdentity,
    aclVerifier,
    execFile = execFileSync,
    directory = false,
  } = {},
) {
  const normalizedPlatform = String(platform).toLowerCase();
  const { resolved, segments } = protectedPathSegments(target);
  const captured = [];
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    let stat;
    try {
      stat = fs.lstatSync(segment, { bigint: true });
    } catch {
      const leaf = index === segments.length - 1;
      throw attestationError(
        leaf && !directory
          ? "WORKER_DEPLOYMENT_ATTESTATION_MISSING"
          : "WORKER_DEPLOYMENT_ATTESTATION_DIRECTORY_MISSING",
        leaf && !directory
          ? "Worker deployment attestation 尚未生成"
          : "Worker deployment attestation 受保护目录不存在",
      );
    }
    const leaf = index === segments.length - 1;
    let canonical;
    try {
      canonical = fs.realpathSync.native(segment);
    } catch {
      throw attestationError(
        "WORKER_DEPLOYMENT_ATTESTATION_PATH_INVALID",
        "Worker deployment attestation 路径无法规范化",
      );
    }
    if (
      stat.isSymbolicLink()
      || (!leaf && !stat.isDirectory())
      || (leaf && (directory ? !stat.isDirectory() : !stat.isFile()))
      || normalizedPath(canonical, normalizedPlatform)
        !== normalizedPath(segment, normalizedPlatform)
    ) {
      throw attestationError(
        stat.isSymbolicLink()
          ? "WORKER_DEPLOYMENT_ATTESTATION_PATH_LINK"
          : "WORKER_DEPLOYMENT_ATTESTATION_PATH_INVALID",
        "Worker deployment attestation 路径不得包含符号链接、目录联接或其他重解析点",
      );
    }
    if (leaf && !directory && Number(stat.nlink) !== 1) {
      throw attestationError(
        "WORKER_DEPLOYMENT_ATTESTATION_HARDLINK",
        "Worker deployment attestation 公钥和文档必须是 nlink=1 的普通文件",
      );
    }
    captured.push({
      path: segment,
      stat,
      identity: stableObjectIdentity(stat),
      leaf,
    });
  }
  if (aclVerifier !== undefined) {
    for (let index = 0; index < captured.length; index += 1) {
      const item = captured[index];
      if (
        process.env.NODE_ENV !== "test"
        || aclVerifier(item.path, {
          platform: normalizedPlatform,
          gatewayIdentity,
          stat: item.stat,
          directory: item.stat.isDirectory(),
          leaf: item.leaf,
          segmentIndex: index,
          segmentCount: captured.length,
        }) !== true
      ) {
        throw attestationError(
          "WORKER_DEPLOYMENT_ATTESTATION_ACL_UNSAFE",
          "Worker deployment attestation 父链 ACL 验证失败",
        );
      }
    }
  } else if (normalizedPlatform === "win32") {
    assertWindowsProtectedChain(
      captured.map((item) => item.path),
      gatewayIdentity,
      execFile,
    );
  } else {
    const currentUid = typeof process.getuid === "function" ? process.getuid() : null;
    const declaredUid = /^uid:(\d+)$/i.exec(String(gatewayIdentity || ""))?.[1];
    if (
      currentUid === null
      || (declaredUid !== undefined && Number(declaredUid) !== currentUid)
      || captured.some(({ stat }) => (
        (Number(stat.mode) & 0o022) !== 0
        || ![0, currentUid].includes(Number(stat.uid))
      ))
    ) {
      throw attestationError(
        "WORKER_DEPLOYMENT_ATTESTATION_ACL_UNSAFE",
        "Unix deployment attestation 全父链必须由 root/Gateway uid 持有且不得允许 group/other 修改",
      );
    }
  }
  return {
    resolved,
    items: captured,
    leaf: captured.at(-1),
  };
}

function assertCapturedPathUnchanged(before, after, { includeLeafContent = false } = {}) {
  if (
    before.items.length !== after.items.length
    || before.items.some((item, index) => (
      normalizedPath(item.path) !== normalizedPath(after.items[index]?.path)
      || JSON.stringify(item.identity) !== JSON.stringify(after.items[index]?.identity)
    ))
    || (includeLeafContent
      && !sameObjectIdentity(before.leaf.stat, after.leaf.stat, { includeContent: true }))
  ) {
    throw attestationError(
      "WORKER_DEPLOYMENT_ATTESTATION_PATH_CHANGED",
      "Worker deployment attestation 受保护路径在校验期间发生变化",
    );
  }
}

function readStableProtectedFile(target, options = {}, { purpose = "protected-file" } = {}) {
  const beforePath = captureStrongProtectedPath(target, options);
  let fd;
  let beforeFd;
  let afterFd;
  let bytes;
  try {
    const noFollow = Number(fs.constants.O_NOFOLLOW || 0);
    fd = fs.openSync(beforePath.resolved, Number(fs.constants.O_RDONLY) | noFollow);
    beforeFd = fs.fstatSync(fd, { bigint: true });
    if (
      !beforeFd.isFile()
      || Number(beforeFd.nlink) !== 1
      || !sameObjectIdentity(beforePath.leaf.stat, beforeFd)
      || Number(beforeFd.size) > MAX_PROTECTED_FILE_BYTES
    ) {
      throw attestationError(
        "WORKER_DEPLOYMENT_ATTESTATION_PATH_CHANGED",
        "Worker deployment attestation 文件在 open 时已漂移、被硬链接或超出大小上限",
      );
    }
    invokeTestHook(options, "afterProtectedOpen", {
      target: beforePath.resolved,
      purpose,
    });
    bytes = fs.readFileSync(fd);
    invokeTestHook(options, "afterProtectedRead", {
      target: beforePath.resolved,
      purpose,
    });
    afterFd = fs.fstatSync(fd, { bigint: true });
    if (
      bytes.length !== Number(afterFd.size)
      || !sameObjectIdentity(beforeFd, afterFd, { includeContent: true })
    ) {
      throw attestationError(
        "WORKER_DEPLOYMENT_ATTESTATION_PATH_CHANGED",
        "Worker deployment attestation 文件在 FD 读取期间发生变化",
      );
    }
  } catch (error) {
    if (String(error?.code || "").startsWith("WORKER_DEPLOYMENT_ATTESTATION_")) throw error;
    throw attestationError(
      "WORKER_DEPLOYMENT_ATTESTATION_PATH_CHANGED",
      "Worker deployment attestation 无法通过固定 FD 安全读取",
    );
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
  const afterPath = captureStrongProtectedPath(target, options);
  assertCapturedPathUnchanged(beforePath, afterPath);
  if (!sameObjectIdentity(afterFd, afterPath.leaf.stat, { includeContent: true })) {
    throw attestationError(
      "WORKER_DEPLOYMENT_ATTESTATION_PATH_CHANGED",
      "Worker deployment attestation 末次 lstat 与已读取 FD 不一致",
    );
  }
  return {
    bytes,
    path: afterPath.resolved,
    capture: afterPath,
    stat: afterFd,
  };
}

function emptyDocument() {
  return {
    schema: WORKER_DEPLOYMENT_ATTESTATION_SCHEMA,
    version: 2,
    generation: 0,
    algorithm: "Ed25519",
    keyId: "",
    entries: [],
    signature: "",
  };
}

function validateDocument(document) {
  if (
    !document
    || typeof document !== "object"
    || Array.isArray(document)
    || JSON.stringify(Object.keys(document).sort()) !== JSON.stringify(DOCUMENT_FIELDS)
    || document.schema !== WORKER_DEPLOYMENT_ATTESTATION_SCHEMA
    || document.version !== 2
    || !Number.isSafeInteger(document.generation)
    || document.generation < 0
    || document.algorithm !== "Ed25519"
    || !String(document.keyId || "").startsWith("ed25519:")
    || !BASE64URL_PATTERN.test(String(document.signature || ""))
    || !Array.isArray(document.entries)
  ) {
    throw attestationError(
      "WORKER_DEPLOYMENT_ATTESTATION_INVALID",
      "Worker deployment attestation 文档无效",
    );
  }
  const stories = new Set();
  for (const entry of document.entries) {
    if (
      !entry
      || typeof entry !== "object"
      || Array.isArray(entry)
      || JSON.stringify(Object.keys(entry).sort()) !== JSON.stringify(ENTRY_FIELDS)
      || !String(entry.storyId || "").trim()
      || stories.has(entry.storyId)
      || !["win32", "linux", "darwin"].includes(entry.platform)
      || !String(entry.workerIdentity || "").trim()
      || !String(entry.gatewayIdentity || "").trim()
      || !SHA256_HEX_PATTERN.test(String(entry.configSha256 || ""))
      || !SHA256_HEX_PATTERN.test(String(entry.launcherSha256 || ""))
      || !SHA256_HEX_PATTERN.test(String(entry.brokerSha256 || ""))
      || !SHA256_HEX_PATTERN.test(String(entry.workerPolicyDigest || ""))
      || !SHA256_HEX_PATTERN.test(String(entry.probeScopeDigest || ""))
      || !UUID_PATTERN.test(String(entry.probeNonce || ""))
      || !Number.isFinite(Date.parse(entry.issuedAt))
      || !Number.isFinite(Date.parse(entry.expiresAt))
      || Date.parse(entry.expiresAt) <= Date.parse(entry.issuedAt)
    ) {
      throw attestationError(
        "WORKER_DEPLOYMENT_ATTESTATION_INVALID",
        "Worker deployment attestation entry 无效或重复",
      );
    }
    stories.add(entry.storyId);
  }
  return document;
}

function loadTrustAnchor(options) {
  if (options.testTrustAnchor !== undefined) {
    if (process.env.NODE_ENV !== "test") {
      throw attestationError(
        "WORKER_DEPLOYMENT_ATTESTATION_TEST_KEY_FORBIDDEN",
        "deployment attestation 测试信任锚仅允许 NODE_ENV=test",
      );
    }
    const testKey = options.testTrustAnchor?.type === "public"
      ? options.testTrustAnchor
      : createPublicKey(options.testTrustAnchor);
    if (testKey.asymmetricKeyType !== "ed25519") {
      throw attestationError(
        "WORKER_DEPLOYMENT_ATTESTATION_KEY_INVALID",
        "deployment attestation 测试信任锚必须是 Ed25519 公钥",
      );
    }
    return testKey;
  }
  const publicKeyPath = options.trustAnchorPath || WORKER_LAUNCH_TRUST_ANCHOR_PATH;
  let key;
  try {
    key = createPublicKey(readStableProtectedFile(
      publicKeyPath,
      options,
      { purpose: "trust-anchor" },
    ).bytes);
  } catch (error) {
    if (String(error?.code || "").startsWith("WORKER_DEPLOYMENT_ATTESTATION_")) {
      throw error;
    }
    throw attestationError(
      "WORKER_DEPLOYMENT_ATTESTATION_KEY_INVALID",
      "Worker deployment attestation 信任锚无法解析",
    );
  }
  if (key.asymmetricKeyType !== "ed25519") {
    throw attestationError(
      "WORKER_DEPLOYMENT_ATTESTATION_KEY_INVALID",
      "Worker deployment attestation 信任锚必须是 Ed25519 公钥",
    );
  }
  return key;
}

function verifyDocumentSignature(document, options) {
  const publicKey = loadTrustAnchor(options);
  const trustedKeyId = trustAnchorKeyId(publicKey);
  if (document.keyId !== trustedKeyId) {
    throw attestationError(
      "WORKER_DEPLOYMENT_ATTESTATION_KEY_MISMATCH",
      "Worker deployment attestation keyId 与固定信任锚不一致",
    );
  }
  const signature = Buffer.from(document.signature, "base64url");
  if (
    signature.length !== 64
    || !verify(null, workerDeploymentAttestationSigningBytes(document), publicKey, signature)
  ) {
    throw attestationError(
      "WORKER_DEPLOYMENT_ATTESTATION_SIGNATURE_INVALID",
      "Worker deployment attestation 签名无效",
    );
  }
}

function readStrongDocument(attestationPath, options, { allowMissing = false } = {}) {
  try {
    fs.lstatSync(attestationPath);
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw attestationError(
        "WORKER_DEPLOYMENT_ATTESTATION_PATH_CHANGED",
        "Worker deployment attestation 路径状态无法安全读取",
      );
    }
    captureStrongProtectedPath(path.dirname(attestationPath), {
      ...options,
      directory: true,
    });
    if (allowMissing) return emptyDocument();
    throw attestationError(
      "WORKER_DEPLOYMENT_ATTESTATION_MISSING",
      "Worker deployment attestation 尚未生成",
    );
  }
  let document;
  try {
    document = JSON.parse(readStableProtectedFile(
      attestationPath,
      options,
      { purpose: "attestation-document" },
    ).bytes.toString("utf8"));
  } catch (error) {
    if (String(error?.code || "").startsWith("WORKER_DEPLOYMENT_ATTESTATION_")) {
      throw error;
    }
    throw attestationError(
      "WORKER_DEPLOYMENT_ATTESTATION_INVALID",
      "Worker deployment attestation JSON 无效",
    );
  }
  validateDocument(document);
  verifyDocumentSignature(document, options);
  return document;
}

function parentCaptureFromChild(capture) {
  const items = capture.items.slice(0, -1);
  return {
    resolved: path.dirname(capture.resolved),
    items,
    leaf: items.at(-1),
  };
}

function fsyncProtectedDirectory(directory, options, expectedCapture) {
  invokeTestHook(options, "directoryFsync", { directory });
  let fd;
  let beforeFd;
  let afterFd;
  try {
    const directoryFlag = Number(fs.constants.O_DIRECTORY || 0);
    fd = fs.openSync(directory, Number(fs.constants.O_RDONLY) | directoryFlag);
    beforeFd = fs.fstatSync(fd, { bigint: true });
    if (
      !beforeFd.isDirectory()
      || !sameObjectIdentity(beforeFd, expectedCapture.leaf.stat)
    ) {
      throw attestationError(
        "WORKER_DEPLOYMENT_ATTESTATION_PATH_CHANGED",
        "Worker deployment attestation 父目录在 fsync open 时发生变化",
      );
    }
    fs.fsyncSync(fd);
  } catch (error) {
    if (String(error?.code || "").startsWith("WORKER_DEPLOYMENT_ATTESTATION_")) {
      throw error;
    }
    // Node/Win32 does not expose a FILE_FLAG_BACKUP_SEMANTICS directory
    // FlushFileBuffers handle. The file itself is fsynced before the atomic
    // rename; still attempt the directory fsync and only accept this documented
    // platform limitation.
    if (
      String(options.platform).toLowerCase() !== "win32"
      || !["EPERM", "EACCES", "EINVAL", "EBADF"].includes(String(error?.code || ""))
    ) {
      throw attestationError(
        "WORKER_DEPLOYMENT_ATTESTATION_DIRECTORY_SYNC_FAILED",
        "Worker deployment attestation 父目录无法完成持久化同步",
      );
    }
  } finally {
    if (fd !== undefined) {
      try {
        afterFd = fs.fstatSync(fd, { bigint: true });
      } catch {}
    }
    if (fd !== undefined) fs.closeSync(fd);
  }
  if (afterFd && !sameObjectIdentity(beforeFd, afterFd)) {
    throw attestationError(
      "WORKER_DEPLOYMENT_ATTESTATION_PATH_CHANGED",
      "Worker deployment attestation 父目录在 fsync 期间发生变化",
    );
  }
  const afterPath = captureStrongProtectedPath(directory, {
    ...options,
    directory: true,
  });
  assertCapturedPathUnchanged(expectedCapture, afterPath);
}

function atomicWriteStrongDocument(attestationPath, document, options) {
  const directory = path.dirname(attestationPath);
  const parentBefore = captureStrongProtectedPath(directory, {
    ...options,
    directory: true,
  });
  const temporary = path.join(
    directory,
    `.${path.basename(attestationPath)}.${process.pid}.${randomUUID()}.tmp`,
  );
  const serialized = Buffer.from(`${JSON.stringify(document, null, 2)}\n`, "utf8");
  if (serialized.length > MAX_PROTECTED_FILE_BYTES) {
    throw attestationError(
      "WORKER_DEPLOYMENT_ATTESTATION_INVALID",
      "Worker deployment attestation 文档超出安全大小上限",
    );
  }
  let temporaryStat;
  try {
    invokeTestHook(options, "beforeTemporaryCreate", {
      directory,
      target: attestationPath,
      temporary,
    });
    const fd = fs.openSync(temporary, "wx", 0o600);
    try {
      temporaryStat = fs.fstatSync(fd, { bigint: true });
      if (!temporaryStat.isFile() || Number(temporaryStat.nlink) !== 1) {
        throw attestationError(
          "WORKER_DEPLOYMENT_ATTESTATION_HARDLINK",
          "新 deployment attestation 临时文件必须是 nlink=1 的普通文件",
        );
      }
      fs.writeFileSync(fd, serialized);
      fs.fsyncSync(fd);
      temporaryStat = fs.fstatSync(fd, { bigint: true });
      if (
        Number(temporaryStat.nlink) !== 1
        || Number(temporaryStat.size) !== serialized.length
      ) {
        throw attestationError(
          "WORKER_DEPLOYMENT_ATTESTATION_PATH_CHANGED",
          "新 deployment attestation 临时文件在写入期间发生变化",
        );
      }
    } finally {
      fs.closeSync(fd);
    }

    const temporaryCapture = captureStrongProtectedPath(temporary, options);
    if (!sameObjectIdentity(
      temporaryStat,
      temporaryCapture.leaf.stat,
      { includeContent: true },
    )) {
      throw attestationError(
        "WORKER_DEPLOYMENT_ATTESTATION_PATH_CHANGED",
        "新 deployment attestation 临时文件与已同步 FD 不一致",
      );
    }
    assertCapturedPathUnchanged(parentBefore, parentCaptureFromChild(temporaryCapture));
    invokeTestHook(options, "afterTemporaryFsync", {
      directory,
      target: attestationPath,
      temporary,
    });

    const parentBeforeMutation = captureStrongProtectedPath(directory, {
      ...options,
      directory: true,
    });
    assertCapturedPathUnchanged(parentBefore, parentBeforeMutation);
    const temporaryBeforeMutation = captureStrongProtectedPath(temporary, options);
    assertCapturedPathUnchanged(temporaryCapture, temporaryBeforeMutation, {
      includeLeafContent: true,
    });
    try {
      fs.lstatSync(attestationPath);
      captureStrongProtectedPath(attestationPath, options);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    invokeTestHook(options, "beforeAttestationRename", {
      directory,
      target: attestationPath,
      temporary,
    });

    const parentAtMutation = captureStrongProtectedPath(directory, {
      ...options,
      directory: true,
    });
    assertCapturedPathUnchanged(parentBefore, parentAtMutation);
    const temporaryAtMutation = captureStrongProtectedPath(temporary, options);
    assertCapturedPathUnchanged(temporaryCapture, temporaryAtMutation, {
      includeLeafContent: true,
    });
    fs.renameSync(temporary, attestationPath);
    invokeTestHook(options, "afterAttestationRename", {
      directory,
      target: attestationPath,
    });
    const parentAfterMutation = captureStrongProtectedPath(directory, {
      ...options,
      directory: true,
    });
    assertCapturedPathUnchanged(parentBefore, parentAfterMutation);
    const fileAfterMutation = captureStrongProtectedPath(attestationPath, options);
    if (!sameObjectIdentity(temporaryStat, fileAfterMutation.leaf.stat)) {
      throw attestationError(
        "WORKER_DEPLOYMENT_ATTESTATION_PATH_CHANGED",
        "原子替换后的 deployment attestation 路径身份与临时 FD 不一致",
      );
    }
    fsyncProtectedDirectory(directory, options, parentAfterMutation);

    const finalFile = readStableProtectedFile(
      attestationPath,
      options,
      { purpose: "written-attestation-document" },
    );
    if (
      !serialized.equals(finalFile.bytes)
      || !sameObjectIdentity(temporaryStat, finalFile.stat)
    ) {
      throw attestationError(
        "WORKER_DEPLOYMENT_ATTESTATION_PATH_CHANGED",
        "原子替换后的 deployment attestation 与已同步临时 FD 不一致",
      );
    }
    const parentAfter = captureStrongProtectedPath(directory, {
      ...options,
      directory: true,
    });
    assertCapturedPathUnchanged(parentBefore, parentAfter);
  } finally {
    try {
      const stat = fs.lstatSync(temporary);
      if (stat.isFile() || stat.isSymbolicLink()) fs.unlinkSync(temporary);
    } catch {}
  }
}

function normalizedOptions({
  platform = process.platform,
  gatewayIdentity,
  attestationPath = WORKER_DEPLOYMENT_ATTESTATION_PATH,
  aclVerifier,
  execFile = execFileSync,
  testTrustAnchor,
  trustAnchorPath = WORKER_LAUNCH_TRUST_ANCHOR_PATH,
  testHooks,
} = {}) {
  const normalizedPlatform = String(platform).toLowerCase();
  if (
    path.resolve(attestationPath) !== WORKER_DEPLOYMENT_ATTESTATION_PATH
    && process.env.NODE_ENV !== "test"
  ) {
    throw attestationError(
      "WORKER_DEPLOYMENT_ATTESTATION_PATH_OVERRIDE_FORBIDDEN",
      "生产运行只允许固定 deployment attestation 路径",
    );
  }
  if (
    (
      aclVerifier !== undefined
      || testTrustAnchor !== undefined
      || testHooks !== undefined
      || path.resolve(trustAnchorPath) !== WORKER_LAUNCH_TRUST_ANCHOR_PATH
      || execFile !== execFileSync
      || normalizedPlatform !== process.platform
    )
    && process.env.NODE_ENV !== "test"
  ) {
    throw attestationError(
      "WORKER_DEPLOYMENT_ATTESTATION_ACL_OVERRIDE_FORBIDDEN",
      "deployment attestation ACL 测试替身仅允许 NODE_ENV=test",
    );
  }
  if (
    testHooks !== undefined
    && (!testHooks || typeof testHooks !== "object" || Array.isArray(testHooks))
  ) {
    throw attestationError(
      "WORKER_DEPLOYMENT_ATTESTATION_TEST_HOOK_INVALID",
      "deployment attestation 测试钩子必须是对象",
    );
  }
  return {
    platform: normalizedPlatform,
    gatewayIdentity: String(gatewayIdentity || "").trim(),
    attestationPath: path.resolve(attestationPath),
    aclVerifier,
    execFile,
    testTrustAnchor,
    trustAnchorPath: path.resolve(trustAnchorPath),
    testHooks,
  };
}

export function recordWorkerDeploymentAttestation({
  storyId,
  launcher,
  grant,
  probeResult,
  signer,
  now = Date.now(),
  ...rawOptions
} = {}) {
  const options = normalizedOptions(rawOptions);
  const normalizedStoryId = String(storyId || "").trim();
  if (
    !normalizedStoryId
    || probeResult?.ok !== true
    || probeResult?.storyId !== normalizedStoryId
    || String(probeResult?.actualIdentity || "").toLowerCase()
      !== String(launcher?.identity || "").toLowerCase()
    || !UUID_PATTERN.test(String(probeResult?.launchNonce || ""))
    || typeof signer !== "function"
  ) {
    throw attestationError(
      "WORKER_DEPLOYMENT_ATTESTATION_PROBE_INVALID",
      "只有同故事点、同 Worker 身份的成功 deployment probe 才能生成 attestation",
    );
  }
  const issuedAt = new Date(now).toISOString();
  const entry = {
    storyId: normalizedStoryId,
    platform: options.platform,
    workerIdentity: String(launcher.identity || "").toLowerCase(),
    gatewayIdentity: String(launcher.gatewayIdentity || "").toLowerCase(),
    configSha256: String(launcher.configSha256 || "").toLowerCase(),
    launcherSha256: String(launcher.launcherSha256 || "").toLowerCase(),
    brokerSha256: String(launcher.brokerSha256 || "").toLowerCase(),
    workerPolicyDigest: String(launcher.workerPolicyDigest || "").toLowerCase(),
    probeScopeDigest: workerIsolationGrantFingerprint(grant),
    probeNonce: probeResult.launchNonce,
    issuedAt,
    expiresAt: new Date(now + WORKER_DEPLOYMENT_ATTESTATION_MAX_AGE_MS).toISOString(),
  };
  const current = readStrongDocument(options.attestationPath, options, { allowMissing: true });
  const entries = current.entries
    .filter((item) => item.storyId !== normalizedStoryId)
    .concat(entry)
    .sort((left, right) => left.storyId.localeCompare(right.storyId));
  const unsigned = {
    schema: WORKER_DEPLOYMENT_ATTESTATION_SCHEMA,
    version: 2,
    generation: current.generation + 1,
    algorithm: "Ed25519",
    entries,
  };
  let signed;
  try {
    const signature = signer(Object.freeze({
      ...unsigned,
      entries: Object.freeze(entries.map((item) => Object.freeze({ ...item }))),
    }));
    signed = {
      ...unsigned,
      keyId: String(signature?.keyId || ""),
      signature: String(signature?.signature || ""),
    };
  } catch {
    throw attestationError(
      "WORKER_DEPLOYMENT_ATTESTATION_SIGNING_FAILED",
      "无法使用固定 Gateway 信任密钥签署 deployment attestation",
    );
  }
  validateDocument(signed);
  verifyDocumentSignature(signed, options);
  atomicWriteStrongDocument(options.attestationPath, signed, options);
  return Object.freeze({ ...entry });
}

export function verifyWorkerDeploymentAttestation({
  storyId,
  launcher,
  grant,
  now = Date.now(),
  ...rawOptions
} = {}) {
  try {
    const options = normalizedOptions(rawOptions);
    const document = readStrongDocument(options.attestationPath, options);
    const normalizedStoryId = String(storyId || "").trim();
    const entry = document.entries.find((item) => item.storyId === normalizedStoryId);
    if (!entry) {
      throw attestationError(
        "WORKER_DEPLOYMENT_ATTESTATION_MISSING",
        "当前故事点没有真实跨身份 deployment attestation",
      );
    }
    const expected = {
      platform: options.platform,
      workerIdentity: String(launcher?.identity || "").toLowerCase(),
      gatewayIdentity: String(launcher?.gatewayIdentity || "").toLowerCase(),
      configSha256: String(launcher?.configSha256 || "").toLowerCase(),
      launcherSha256: String(launcher?.launcherSha256 || "").toLowerCase(),
      brokerSha256: String(launcher?.brokerSha256 || "").toLowerCase(),
      workerPolicyDigest: String(launcher?.workerPolicyDigest || "").toLowerCase(),
      probeScopeDigest: workerIsolationGrantFingerprint(grant),
    };
    for (const [field, value] of Object.entries(expected)) {
      if (entry[field] !== value) {
        throw attestationError(
          "WORKER_DEPLOYMENT_ATTESTATION_DRIFT",
          "Worker 身份、launcher、broker、ACL 或授权范围已漂移，必须重新执行真实 probe",
        );
      }
    }
    if (Date.parse(entry.expiresAt) <= now) {
      throw attestationError(
        "WORKER_DEPLOYMENT_ATTESTATION_EXPIRED",
        "Worker deployment attestation 已过期，必须重新执行真实 probe",
      );
    }
    return {
      ok: true,
      code: "WORKER_DEPLOYMENT_ATTESTED",
      entry: Object.freeze({ ...entry }),
    };
  } catch (error) {
    return {
      ok: false,
      code: error?.code || "WORKER_DEPLOYMENT_ATTESTATION_INVALID",
      error: String(error?.message || "Worker deployment attestation 无效"),
    };
  }
}
