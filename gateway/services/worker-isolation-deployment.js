import fs from "node:fs";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  INDEPENDENT_REPOSITORY_MODE,
  WORKER_LAUNCHER_CONFIG_PATH,
  canonicalWorkerPath,
  createSignedWorkerLaunchEnvelope,
  createStoryWorkerGrant,
  currentOsIdentity,
  loadManagedWorkerLauncherConfig,
  pathIsInside,
  platformSupportsStrongWorkerIsolation,
  renewStoryWorkerGrant,
  sanitizeWorkerEnvironment,
  signWorkerDeploymentAttestationDocument,
} from "./worker-isolation.js";
import { issueWorkerLaunchNonce } from "./worker-launch-consume-helper.mjs";
import {
  WORKER_DEPLOYMENT_ATTESTATION_PATH,
  recordWorkerDeploymentAttestation,
} from "./worker-isolation-attestation.js";
import { readGitControllerClientConfig } from "./devbench/git-controller-client.js";

const SERVICE_DIR = path.dirname(fileURLToPath(import.meta.url));
const WINDOWS_POWERSHELL_PATH = path.win32.resolve(
  String(process.env.SystemRoot || `${process.env.SystemDrive || "C:"}\\Windows`),
  "System32",
  "WindowsPowerShell",
  "v1.0",
  "powershell.exe",
);
const WINDOWS_SYSTEM32_PATH = path.win32.resolve(
  WINDOWS_POWERSHELL_PATH,
  "..",
  "..",
  "..",
);
const WINDOWS_ICACLS_PATH = path.win32.join(WINDOWS_SYSTEM32_PATH, "icacls.exe");
const UNIX_SETFACL = "/usr/bin/setfacl";
const UNIX_GETFACL = "/usr/bin/getfacl";
const MANAGED_PROBE_ACL_VERIFIER = Symbol("managed-probe-acl-verifier");
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;
const PROBE_RESULT_PREFIX = "DEVBENCH_WORKER_DEPLOYMENT_PROBE=";
const PROBE_RESULT_SCHEMA = "devbench.worker-deployment-probe-result.v3";
const PROBE_CONFIG_SCHEMA = "devbench.worker-deployment-probe-config.v5";
const LEGACY_PROBE_CONFIG_SCHEMAS = new Map([
  ["devbench.worker-deployment-probe-config.v3", 3],
  ["devbench.worker-deployment-probe-config.v4", 4],
]);
const PROBE_CONFIG_FIELDS = Object.freeze(["generation", "schema", "stories", "version"].sort());
const PROBE_STORY_FIELDS = Object.freeze([
  "aclFingerprints",
  "allowedRoots",
  "boundarySentinels",
  "cwd",
  "inaccessibleEntries",
  "inaccessibleRoots",
  "writeDeniedRoots",
  "workerIdentity",
].sort());
const LEGACY_PROBE_STORY_FIELDS = Object.freeze(
  PROBE_STORY_FIELDS.filter((field) => field !== "inaccessibleEntries"),
);
const PROBE_RESULT_FIELDS = Object.freeze([
  "actualIdentity",
  "checks",
  "expectedIdentity",
  "launchNonce",
  "ok",
  "operation",
  "schema",
  "storyId",
  "version",
].sort());
const PROBE_CHECK_FIELDS = Object.freeze([
  "inaccessibleRootsInaccessible",
  "inaccessibleEntriesInaccessible",
  "independentGitCommonDir",
  "launcherInstanceChannelBound",
  "lowPrivilegeIdentity",
  "storyRepositoryReadWrite",
  "writeDeniedRootsNotWritable",
  "writeDeniedTreesNotWritable",
].sort());

export const WORKER_DEPLOYMENT_PROBE_CONFIG_PATH = path.resolve(
  SERVICE_DIR,
  "../.secrets/worker-deployment-probe.json",
);

function deploymentError(code, message, details = {}) {
  const error = new Error(message);
  error.code = code;
  error.details = details;
  return error;
}

function trustManagedProbeAclVerifier(verifier) {
  Object.defineProperty(verifier, MANAGED_PROBE_ACL_VERIFIER, {
    value: true,
    enumerable: false,
    configurable: false,
    writable: false,
  });
  return verifier;
}

function normalizedPath(value, platform = process.platform) {
  const normalized = path.resolve(String(value || ""))
    .replace(/[\\/]+/g, "/")
    .replace(/\/+$/, "");
  return String(platform).toLowerCase() === "win32"
    ? normalized.toLowerCase()
    : normalized;
}

function assertNoLinkedSegments(target, label) {
  const resolved = path.resolve(target);
  const parsed = path.parse(resolved);
  const segments = resolved.slice(parsed.root.length).split(path.sep).filter(Boolean);
  let cursor = parsed.root;
  for (const segment of segments) {
    cursor = path.join(cursor, segment);
    if (!fs.existsSync(cursor)) break;
    if (fs.lstatSync(cursor).isSymbolicLink()) {
      throw deploymentError(
        "WORKER_DEPLOYMENT_CONFIG_LINK",
        `${label} 路径包含符号链接或目录联接`,
      );
    }
  }
  return resolved;
}

function assertWindowsProtectedFile(
  target,
  gatewayIdentity,
  controllerIdentity,
  execFile = execFileSync,
) {
  const gatewaySid = String(gatewayIdentity || "").replace(/^sid:/i, "").toUpperCase();
  const controllerSid = String(controllerIdentity || "").replace(/^sid:/i, "").toUpperCase();
  if (
    !/^S-\d(?:-\d+)+$/.test(gatewaySid)
    || !/^S-\d(?:-\d+)+$/.test(controllerSid)
    || gatewaySid === controllerSid
  ) {
    throw deploymentError(
      "WORKER_DEPLOYMENT_GATEWAY_IDENTITY_INVALID",
      "无法取得 Gateway Windows SID，不能验证 deployment probe 配置 ACL",
    );
  }
  const targetBase64 = Buffer.from(target, "utf8").toString("base64");
  const script = [
    "$ErrorActionPreference='Stop'",
    `$target=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${targetBase64}'))`,
    `$gateway='${gatewaySid}'`,
    `$controller='${controllerSid}'`,
    "$acl=Get-Acl -LiteralPath $target",
    "$owners=@($controller,'S-1-5-18','S-1-5-32-544')",
    "$owner=$acl.GetOwner([Security.Principal.SecurityIdentifier]).Value.ToUpperInvariant()",
    "if($owners -notcontains $owner){exit 21}",
    "$sensitive=[Security.AccessControl.FileSystemRights]::WriteData -bor [Security.AccessControl.FileSystemRights]::AppendData -bor [Security.AccessControl.FileSystemRights]::WriteAttributes -bor [Security.AccessControl.FileSystemRights]::WriteExtendedAttributes -bor [Security.AccessControl.FileSystemRights]::Delete -bor [Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles -bor [Security.AccessControl.FileSystemRights]::ChangePermissions -bor [Security.AccessControl.FileSystemRights]::TakeOwnership",
    "$read=[Security.AccessControl.FileSystemRights]::ReadData -bor [Security.AccessControl.FileSystemRights]::ReadAttributes -bor [Security.AccessControl.FileSystemRights]::ReadPermissions",
    "$gatewayReadable=$false",
    "$bad=@($acl.Access | ForEach-Object {",
    " if($_.AccessControlType -eq 'Allow'){",
    "  try{$sid=$_.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value.ToUpperInvariant()}catch{$sid=$_.IdentityReference.Value.ToUpperInvariant()}",
    "  if($sid -eq $gateway -and ($_.FileSystemRights -band $read) -ne 0 -and ($_.FileSystemRights -band $sensitive) -eq 0){$gatewayReadable=$true}",
    "  if(($_.FileSystemRights -band $sensitive) -ne 0 -and $owners -notcontains $sid){$_}",
    " }",
    "})",
    "if($bad.Count -gt 0 -or -not $gatewayReadable){exit 22}",
    "$cursor=[IO.Directory]::GetParent($target)",
    "while($null -ne $cursor){",
    " $item=Get-Item -LiteralPath $cursor.FullName -Force",
    " if(($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0){exit 23}",
    " $parentAcl=Get-Acl -LiteralPath $cursor.FullName",
    " $parentOwner=$parentAcl.GetOwner([Security.Principal.SecurityIdentifier]).Value.ToUpperInvariant()",
    " if($owners -notcontains $parentOwner){exit 23}",
    " foreach($rule in $parentAcl.Access){",
    "  if($rule.AccessControlType -ne 'Allow'){continue}",
    "  try{$sid=$rule.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value.ToUpperInvariant()}catch{$sid=$rule.IdentityReference.Value.ToUpperInvariant()}",
    "  if(($rule.FileSystemRights -band $sensitive) -ne 0 -and $owners -notcontains $sid){exit 23}",
    " }",
    " $cursor=$cursor.Parent",
    "}",
  ].join(";");
  try {
    execFile(
      WINDOWS_POWERSHELL_PATH,
      ["-NoProfile", "-NonInteractive", "-Command", script],
      { windowsHide: true, timeout: 10_000, stdio: "ignore" },
    );
  } catch {
    throw deploymentError(
      "WORKER_DEPLOYMENT_CONFIG_ACL_UNSAFE",
      "deployment probe 配置 owner/DACL 允许非 Gateway 管理身份修改",
    );
  }
}

function assertProtectedProbeConfigFile(
  configPath,
  {
    platform = process.platform,
    gatewayIdentity = currentOsIdentity(),
    controllerIdentity = "",
    aclVerifier,
    execFile = execFileSync,
  } = {},
) {
  const resolved = assertNoLinkedSegments(configPath, "Worker deployment probe 配置");
  let expectedControllerIdentity = String(controllerIdentity || "").trim();
  if (aclVerifier === undefined && !expectedControllerIdentity) {
    expectedControllerIdentity = process.env.NODE_ENV === "test"
      ? String(gatewayIdentity || "").trim()
      : readGitControllerClientConfig({ gatewayIdentity }).expectedControllerIdentity;
  }
  if (
    aclVerifier === undefined
    && process.env.NODE_ENV !== "test"
    && expectedControllerIdentity.toLowerCase() === String(gatewayIdentity || "").toLowerCase()
  ) {
    throw deploymentError(
      "WORKER_DEPLOYMENT_CONTROLLER_IDENTITY_INVALID",
      "Controller-owned deployment probe configuration cannot be owned by Gateway",
    );
  }
  let stat;
  try {
    stat = fs.lstatSync(resolved);
  } catch {
    throw deploymentError(
      "WORKER_DEPLOYMENT_CONFIG_MISSING",
      `未配置固定 Worker deployment probe：${resolved}`,
    );
  }
  if (!stat.isFile() || stat.isSymbolicLink() || Number(stat.nlink || 1) !== 1
    || normalizedPath(fs.realpathSync.native(resolved), platform)
      !== normalizedPath(resolved, platform)) {
    throw deploymentError(
      "WORKER_DEPLOYMENT_CONFIG_INVALID",
      "Worker deployment probe 配置必须是固定路径下的非链接普通文件",
    );
  }
  if (aclVerifier !== undefined) {
    if (
      (
        process.env.NODE_ENV !== "test"
        && aclVerifier?.[MANAGED_PROBE_ACL_VERIFIER] !== true
      )
      || aclVerifier(resolved, {
      platform,
      gatewayIdentity,
      controllerIdentity: expectedControllerIdentity,
      stat,
      }) !== true
    ) {
      throw deploymentError(
        "WORKER_DEPLOYMENT_CONFIG_ACL_UNSAFE",
        "Worker deployment probe 配置 ACL 验证失败",
      );
    }
  } else if (String(platform).toLowerCase() === "win32") {
    assertWindowsProtectedFile(
      resolved,
      gatewayIdentity,
      expectedControllerIdentity,
      execFile,
    );
  } else {
    const controllerUidMatch = expectedControllerIdentity.match(/^uid:([0-9]+)$/i);
    const controllerUid = Number(controllerUidMatch?.[1]);
    if (
      !controllerUidMatch
      || !Number.isSafeInteger(controllerUid)
      || (stat.mode & 0o022) !== 0
      || stat.uid !== controllerUid
    ) {
      throw deploymentError(
        "WORKER_DEPLOYMENT_CONFIG_ACL_UNSAFE",
        "Unix deployment probe configuration must be Controller-owned and deny group/other writes",
      );
    }
    let cursor = path.dirname(resolved);
    while (true) {
      const parentStat = fs.lstatSync(cursor);
      if (
        parentStat.isSymbolicLink()
        || !parentStat.isDirectory()
        || !new Set([0, controllerUid]).has(parentStat.uid)
        || (parentStat.mode & 0o022) !== 0
      ) {
        throw deploymentError(
          "WORKER_DEPLOYMENT_CONFIG_PARENT_ACL_UNSAFE",
          "Unix deployment probe parent chain must deny Gateway rename and delete-child rights",
        );
      }
      const next = path.dirname(cursor);
      if (next === cursor) break;
      cursor = next;
    }
  }
  return resolved;
}

function assertPathArray(field, values, { canonical = true, mustExist = true } = {}) {
  if (!Array.isArray(values) || values.length === 0) {
    throw deploymentError(
      "WORKER_DEPLOYMENT_PROBE_SCOPE_INVALID",
      `Worker deployment probe 的 ${field} 必须是非空数组`,
    );
  }
  const unique = new Set();
  return values.map((value) => {
    if (typeof value !== "string" || !path.isAbsolute(value)) {
      throw deploymentError(
        "WORKER_DEPLOYMENT_PROBE_SCOPE_INVALID",
        `Worker deployment probe 的 ${field} 只能包含绝对路径`,
      );
    }
    const resolved = canonical
      ? canonicalWorkerPath(value, { mustExist })
      : path.resolve(value);
    const key = normalizedPath(resolved);
    if (unique.has(key)) {
      throw deploymentError(
        "WORKER_DEPLOYMENT_PROBE_SCOPE_INVALID",
        `Worker deployment probe 的 ${field} 包含重复路径`,
      );
    }
    unique.add(key);
    return resolved;
  });
}

function validateInaccessibleEntries(values, inaccessibleRoots) {
  if (!Array.isArray(values) || values.length === 0) {
    throw deploymentError(
      "WORKER_DEPLOYMENT_INACCESSIBLE_ENTRIES_INVALID",
      "Worker deployment probe requires inaccessibleEntries",
    );
  }
  const roots = new Map(inaccessibleRoots.map((root) => [normalizedPath(root), root]));
  const seen = new Set();
  const rootEntries = new Set();
  const entries = values.map((item) => {
    if (
      !item
      || typeof item !== "object"
      || Array.isArray(item)
      || JSON.stringify(Object.keys(item).sort()) !== JSON.stringify(["path", "root", "type"])
      || !path.isAbsolute(String(item.root || ""))
      || !path.isAbsolute(String(item.path || ""))
      || path.resolve(String(item.root)) !== String(item.root)
      || path.resolve(String(item.path)) !== String(item.path)
      || !["directory", "file", "missing"].includes(item.type)
    ) {
      throw deploymentError(
        "WORKER_DEPLOYMENT_INACCESSIBLE_ENTRIES_INVALID",
        "Worker deployment inaccessible entry fields are invalid",
      );
    }
    const root = path.resolve(item.root);
    const entryPath = path.resolve(item.path);
    const rootKey = normalizedPath(root);
    const key = `${rootKey}\0${normalizedPath(entryPath)}`;
    if (
      !roots.has(rootKey)
      || !pathIsInside(root, entryPath)
      || seen.has(key)
      || (item.type === "missing" && normalizedPath(entryPath) !== rootKey)
    ) {
      throw deploymentError(
        "WORKER_DEPLOYMENT_INACCESSIBLE_ENTRIES_INVALID",
        "Worker deployment inaccessible entries are duplicated or outside their root",
      );
    }
    if (normalizedPath(entryPath) === rootKey) rootEntries.add(rootKey);
    seen.add(key);
    return Object.freeze({ root: roots.get(rootKey), path: entryPath, type: item.type });
  });
  if (
    rootEntries.size !== roots.size
    || [...roots.keys()].some((root) => !rootEntries.has(root))
  ) {
    throw deploymentError(
      "WORKER_DEPLOYMENT_INACCESSIBLE_ENTRIES_INVALID",
      "Every inaccessible root must have an exact root entry",
    );
  }
  for (const root of roots.values()) {
    const group = entries.filter((entry) => normalizedPath(entry.root) === normalizedPath(root));
    const rootEntry = group.find(
      (entry) => normalizedPath(entry.path) === normalizedPath(root),
    );
    if (
      !rootEntry
      || (rootEntry.type !== "directory" && group.length !== 1)
      || group.some((entry) => (
        normalizedPath(entry.path) !== normalizedPath(root)
        && entry.type === "missing"
      ))
    ) {
      throw deploymentError(
        "WORKER_DEPLOYMENT_INACCESSIBLE_ENTRIES_INVALID",
        "File or missing inaccessible roots cannot declare descendants",
      );
    }
  }
  const sorted = [...entries].sort((left, right) => (
    normalizedPath(left.root).localeCompare(normalizedPath(right.root))
    || normalizedPath(left.path).localeCompare(normalizedPath(right.path))
  ));
  if (JSON.stringify(entries) !== JSON.stringify(sorted)) {
    throw deploymentError(
      "WORKER_DEPLOYMENT_INACCESSIBLE_ENTRIES_INVALID",
      "Worker deployment inaccessible entries must be sorted by root and path",
    );
  }
  return entries;
}

function inaccessibleEntrySnapshot(root) {
  const canonicalRoot = canonicalWorkerPath(root, { mustExist: false });
  const rows = [];
  const visit = (candidate) => {
    let stat;
    try {
      stat = fs.lstatSync(candidate);
    } catch (error) {
      if (error?.code === "ENOENT" && normalizedPath(candidate) === normalizedPath(canonicalRoot)) {
        rows.push({
          root: canonicalRoot,
          path: canonicalRoot,
          type: "missing",
          identity: "missing",
        });
        return;
      }
      throw error;
    }
    if (stat.isSymbolicLink()) {
      throw deploymentError(
        "WORKER_DEPLOYMENT_INACCESSIBLE_ENTRY_LINK",
        "Controller inaccessible topology contains a reparse point or symbolic link",
      );
    }
    const type = stat.isDirectory() ? "directory" : stat.isFile() ? "file" : "";
    if (!type) {
      throw deploymentError(
        "WORKER_DEPLOYMENT_INACCESSIBLE_ENTRY_SPECIAL",
        "Controller inaccessible topology contains an unsupported special file",
      );
    }
    rows.push({
      root: canonicalRoot,
      path: path.resolve(candidate),
      type,
      identity: [
        Number(stat.dev),
        Number(stat.ino),
        Number(stat.mode),
        Number(stat.size),
        Number(stat.mtimeMs),
      ].join(":"),
    });
    if (type !== "directory") return;
    for (const name of fs.readdirSync(candidate).sort()) {
      visit(path.join(candidate, name));
    }
  };
  visit(canonicalRoot);
  return rows;
}

export function enumerateControllerInaccessibleEntries(inaccessibleRoots) {
  if (
    process.env.NODE_ENV !== "test"
    && process.env.DEVBENCH_GIT_CONTROLLER_DAEMON_RUNTIME !== "1"
  ) {
    throw deploymentError(
      "WORKER_DEPLOYMENT_INACCESSIBLE_ENUMERATOR_FORBIDDEN",
      "Only the dedicated Controller may enumerate inaccessible topology entries",
    );
  }
  const canonicalRoots = assertPathArray(
    "inaccessibleRoots",
    inaccessibleRoots,
    { mustExist: false },
  );
  const orderedRoots = [...canonicalRoots].sort((left, right) => (
    normalizedPath(left).localeCompare(normalizedPath(right))
  ));
  const compare = (left, right) => (
    normalizedPath(left.root).localeCompare(normalizedPath(right.root))
    || normalizedPath(left.path).localeCompare(normalizedPath(right.path))
  );
  const first = orderedRoots.flatMap(inaccessibleEntrySnapshot).sort(compare);
  const second = orderedRoots.flatMap(inaccessibleEntrySnapshot).sort(compare);
  if (JSON.stringify(first) !== JSON.stringify(second)) {
    throw deploymentError(
      "WORKER_DEPLOYMENT_INACCESSIBLE_ENTRIES_RACED",
      "Controller inaccessible topology changed while it was enumerated",
    );
  }
  return Object.freeze(first.map(({ identity, ...entry }) => Object.freeze(entry)));
}

function assertBoundarySentinels(values, deniedRoots) {
  if (!Array.isArray(values) || values.length !== deniedRoots.length) {
    throw deploymentError(
      "WORKER_DEPLOYMENT_BOUNDARY_SENTINEL_REQUIRED",
      "每个 deployment probe 禁止根都必须配置一个受保护边界哨兵",
    );
  }
  const deniedByKey = new Map(deniedRoots.map((root) => [normalizedPath(root), root]));
  const seen = new Set();
  return values.map((item) => {
    if (
      !item
      || typeof item !== "object"
      || Array.isArray(item)
      || JSON.stringify(Object.keys(item).sort())
        !== JSON.stringify(["deniedRoot", "sentinelPath"])
    ) {
      throw deploymentError(
        "WORKER_DEPLOYMENT_BOUNDARY_SENTINEL_INVALID",
        "deployment probe 边界哨兵字段无效",
      );
    }
    const deniedRoot = canonicalWorkerPath(item.deniedRoot, { mustExist: false });
    const sentinelPath = canonicalWorkerPath(item.sentinelPath);
    const canonicalDenied = deniedByKey.get(normalizedPath(deniedRoot));
    const parent = path.dirname(sentinelPath);
    if (
      !canonicalDenied
      || seen.has(normalizedPath(canonicalDenied))
      || !fs.lstatSync(sentinelPath).isFile()
      || path.basename(sentinelPath).startsWith(".devbench-worker-boundary-") !== true
      || !pathIsInside(parent, canonicalDenied)
      || normalizedPath(parent) === normalizedPath(canonicalDenied)
    ) {
      throw deploymentError(
        "WORKER_DEPLOYMENT_BOUNDARY_SENTINEL_INVALID",
        "deployment probe 边界哨兵必须是禁止根父链中的唯一固定文件",
      );
    }
    seen.add(normalizedPath(canonicalDenied));
    return Object.freeze({ deniedRoot: canonicalDenied, sentinelPath });
  });
}

export function loadManagedWorkerDeploymentProbeConfig(
  configPath = WORKER_DEPLOYMENT_PROBE_CONFIG_PATH,
  options = {},
) {
  const allowMissingStoryRoots = options.allowMissingStoryRoots === true;
  const platform = options.platform || process.platform;
  const gatewayIdentity = options.gatewayIdentity || currentOsIdentity();
  if (
    allowMissingStoryRoots
    && process.env.NODE_ENV !== "test"
    && process.env.DEVBENCH_GIT_CONTROLLER_DAEMON_RUNTIME !== "1"
  ) {
    throw deploymentError(
      "WORKER_DEPLOYMENT_CONFIG_MISSING_ROOT_OVERRIDE_FORBIDDEN",
      "Only the dedicated Controller may parse a stale topology during recovery",
    );
  }
  const resolved = assertProtectedProbeConfigFile(configPath, options);
  let document;
  try {
    document = JSON.parse(fs.readFileSync(resolved, "utf8"));
  } catch (error) {
    throw deploymentError(
      "WORKER_DEPLOYMENT_CONFIG_JSON_INVALID",
      `Worker deployment probe 配置 JSON 无效：${error.message}`,
    );
  }
  if (
    !document
    || typeof document !== "object"
    || Array.isArray(document)
    || JSON.stringify(Object.keys(document).sort()) !== JSON.stringify(PROBE_CONFIG_FIELDS)
    || document.schema !== PROBE_CONFIG_SCHEMA
    || document.version !== 5
    || !Number.isSafeInteger(document.generation)
    || document.generation < 1
    || !document.stories
    || typeof document.stories !== "object"
    || Array.isArray(document.stories)
  ) {
    throw deploymentError(
      "WORKER_DEPLOYMENT_CONFIG_SCHEMA_INVALID",
      "Worker deployment probe 配置 schema 无效",
    );
  }
  const stories = {};
  for (const [storyId, raw] of Object.entries(document.stories)) {
    if (
      !String(storyId || "").trim()
      || !raw
      || typeof raw !== "object"
      || Array.isArray(raw)
      || JSON.stringify(Object.keys(raw).sort()) !== JSON.stringify(PROBE_STORY_FIELDS)
    ) {
      throw deploymentError(
        "WORKER_DEPLOYMENT_CONFIG_SCHEMA_INVALID",
        "Worker deployment probe 故事点字段集合无效",
      );
    }
    const cwd = canonicalWorkerPath(raw.cwd, { mustExist: !allowMissingStoryRoots });
    const allowedRoots = assertPathArray(
      "allowedRoots",
      raw.allowedRoots,
      { mustExist: !allowMissingStoryRoots },
    );
    const writeDeniedRoots = assertPathArray(
      "writeDeniedRoots",
      raw.writeDeniedRoots,
      { mustExist: false },
    );
    const inaccessibleRoots = assertPathArray(
      "inaccessibleRoots",
      raw.inaccessibleRoots,
      { mustExist: false },
    );
    const inaccessibleEntries = validateInaccessibleEntries(
      raw.inaccessibleEntries,
      inaccessibleRoots,
    );
    const boundarySentinels = assertBoundarySentinels(
      raw.boundarySentinels,
      [...writeDeniedRoots, ...inaccessibleRoots],
    );
    const aclFingerprints = [...new Set(
      (Array.isArray(raw.aclFingerprints) ? raw.aclFingerprints : [])
        .map((value) => String(value || "").toLowerCase()),
    )];
    const workerIdentity = managedProbeWorkerIdentity(raw.workerIdentity, {
      platform,
      gatewayIdentity,
    });
    if (
      aclFingerprints.length === 0
      || aclFingerprints.some((value) => !SHA256_HEX_PATTERN.test(value))
      || !allowedRoots.some((root) => pathIsInside(root, cwd))
    ) {
      throw deploymentError(
        "WORKER_DEPLOYMENT_PROBE_ACL_ATTESTATION_INVALID",
        "Worker deployment probe 缺少 Controller ACL 指纹或 cwd 不在授权根内",
      );
    }
    for (const allowed of allowedRoots) {
      for (const denied of [...writeDeniedRoots, ...inaccessibleRoots]) {
        if (pathIsInside(allowed, denied) || pathIsInside(denied, allowed)) {
          throw deploymentError(
            "WORKER_DEPLOYMENT_PROBE_SCOPE_OVERLAP",
            "Worker deployment probe 允许目录与禁止目录重叠",
          );
        }
      }
    }
    stories[storyId] = Object.freeze({
      cwd,
      allowedRoots: Object.freeze(allowedRoots),
      writeDeniedRoots: Object.freeze(writeDeniedRoots),
      inaccessibleRoots: Object.freeze(inaccessibleRoots),
      inaccessibleEntries: Object.freeze(inaccessibleEntries),
      boundarySentinels: Object.freeze(boundarySentinels),
      aclFingerprints: Object.freeze(aclFingerprints),
      workerIdentity,
    });
  }
  return Object.freeze({
    configPath: resolved,
    generation: document.generation,
    stories: Object.freeze(stories),
  });
}

/**
 * Controller-only upgrade reader. Runtime grant/probe callers intentionally
 * continue to use loadManagedWorkerDeploymentProbeConfig(), which rejects v3/v4.
 * This reader exposes only the generation and owned sentinel cleanup metadata
 * needed to replace a protected legacy document with a fresh v4 topology.
 */
function loadLegacyWorkerDeploymentProbeMigrationSource(
  configPath,
  options = {},
) {
  const resolved = assertProtectedProbeConfigFile(configPath, options);
  let document;
  try {
    document = JSON.parse(fs.readFileSync(resolved, "utf8"));
  } catch (error) {
    throw deploymentError(
      "WORKER_DEPLOYMENT_MIGRATION_JSON_INVALID",
      `Legacy Worker deployment probe migration JSON is invalid: ${error.message}`,
    );
  }
  if (
    !document
    || typeof document !== "object"
    || Array.isArray(document)
    || JSON.stringify(Object.keys(document).sort()) !== JSON.stringify(PROBE_CONFIG_FIELDS)
    || LEGACY_PROBE_CONFIG_SCHEMAS.get(document.schema) !== document.version
    || !Number.isSafeInteger(document.generation)
    || document.generation < 1
    || !document.stories
    || typeof document.stories !== "object"
    || Array.isArray(document.stories)
  ) {
    throw deploymentError(
      "WORKER_DEPLOYMENT_MIGRATION_SCHEMA_INVALID",
      "Legacy Worker deployment probe migration source is not an exact protected v3/v4 document",
    );
  }
  const stories = {};
  for (const [storyId, raw] of Object.entries(document.stories)) {
    if (
      !String(storyId || "").trim()
      || !raw
      || typeof raw !== "object"
      || Array.isArray(raw)
      || JSON.stringify(Object.keys(raw).sort()) !== JSON.stringify(LEGACY_PROBE_STORY_FIELDS)
    ) {
      throw deploymentError(
        "WORKER_DEPLOYMENT_MIGRATION_SCHEMA_INVALID",
        "Legacy Worker deployment probe story field set is invalid",
      );
    }
    const writeDeniedRoots = assertPathArray(
      "writeDeniedRoots",
      raw.writeDeniedRoots,
      { mustExist: false },
    );
    const inaccessibleRoots = assertPathArray(
      "inaccessibleRoots",
      raw.inaccessibleRoots,
      { mustExist: false },
    );
    const boundarySentinels = assertBoundarySentinels(
      raw.boundarySentinels,
      [...writeDeniedRoots, ...inaccessibleRoots],
    );
    stories[storyId] = Object.freeze({
      boundarySentinels: Object.freeze(boundarySentinels),
    });
  }
  return Object.freeze({
    configPath: resolved,
    generation: document.generation,
    stories: Object.freeze(stories),
    legacyVersion: document.version,
  });
}

function samePathSet(left, right) {
  const normalize = (values) => [...new Set(
    (Array.isArray(values) ? values : []).map((value) => normalizedPath(value)),
  )].sort();
  return JSON.stringify(normalize(left)) === JSON.stringify(normalize(right));
}

/**
 * Runtime grants may only import sentinels from the same fixed, protected
 * deployment-probe scope that produced the signed deployment attestation.
 * Dynamic request data can never name a sentinel or widen that scope.
 */
export function resolveWorkerDeploymentProbeScopeForGrant({
  storyId,
  cwd,
  allowedRoots,
  writeDeniedRoots,
  inaccessibleRoots,
  aclFingerprints,
  workerIdentity,
  configPath = WORKER_DEPLOYMENT_PROBE_CONFIG_PATH,
  platform = process.platform,
  gatewayIdentity = currentOsIdentity(),
  aclVerifier,
  protectedFileExecFile,
} = {}) {
  if (
    process.env.NODE_ENV !== "test"
    && path.resolve(configPath) !== WORKER_DEPLOYMENT_PROBE_CONFIG_PATH
  ) {
    throw deploymentError(
      "WORKER_DEPLOYMENT_CONFIG_PATH_INVALID",
      "生产 Worker grant 只能从固定受保护 deployment probe 配置导入边界哨兵",
    );
  }
  const normalizedStoryId = String(storyId || "").trim();
  const document = loadManagedWorkerDeploymentProbeConfig(configPath, {
    platform,
    gatewayIdentity,
    aclVerifier,
    execFile: protectedFileExecFile || execFileSync,
  });
  const probe = document.stories[normalizedStoryId];
  const normalizedAcl = [...new Set(
    (Array.isArray(aclFingerprints) ? aclFingerprints : [])
      .map((value) => String(value || "").toLowerCase()),
  )].sort();
  const normalizedWorker = normalizedProbeIdentity(workerIdentity, platform);
  if (
    !probe
    || normalizedPath(probe.cwd) !== normalizedPath(cwd)
    || !samePathSet(probe.allowedRoots, allowedRoots)
    || !samePathSet(probe.writeDeniedRoots, writeDeniedRoots)
    || !samePathSet(probe.inaccessibleRoots, inaccessibleRoots)
    || JSON.stringify([...probe.aclFingerprints].sort()) !== JSON.stringify(normalizedAcl)
    || normalizedProbeIdentity(probe.workerIdentity, platform) !== normalizedWorker
  ) {
    throw deploymentError(
      "WORKER_DEPLOYMENT_PROBE_SCOPE_DRIFT",
      "实时 Worker grant 与已探测的 exact allowed/forbidden/mirror/secret/ACL 范围不一致",
    );
  }
  return Object.freeze({
    topologyGeneration: document.generation,
    cwd: probe.cwd,
    topologyCwd: probe.cwd,
    allowedRoots: probe.allowedRoots,
    writeDeniedRoots: probe.writeDeniedRoots,
    inaccessibleRoots: probe.inaccessibleRoots,
    inaccessibleEntries: probe.inaccessibleEntries,
    aclFingerprints: probe.aclFingerprints,
    workerIdentity: probe.workerIdentity,
    boundarySentinels: Object.freeze(
      probe.boundarySentinels.map((item) => Object.freeze({ ...item })),
    ),
  });
}

export function resolveWorkerBoundarySentinelsForGrant(options = {}) {
  return resolveWorkerDeploymentProbeScopeForGrant(options)
    .boundarySentinels
    .map((item) => ({ ...item }));
}

/**
 * Build a runtime grant from the Controller-published topology itself. Gateway
 * request data is used only as a narrowing assertion: it may select a cwd or
 * add-dir already below an allowed repository root, but cannot name any
 * allowed/denied root, identity, ACL fingerprint, or sentinel.
 */
export function resolveControllerManagedWorkerDeploymentProbeScopeForGrant({
  storyId,
  cwd,
  requestedAllowedRoots = [],
  configPath = WORKER_DEPLOYMENT_PROBE_CONFIG_PATH,
  platform = process.platform,
  gatewayIdentity = currentOsIdentity(),
  aclVerifier,
  protectedFileExecFile,
} = {}) {
  if (
    process.env.NODE_ENV !== "test"
    && path.resolve(configPath) !== WORKER_DEPLOYMENT_PROBE_CONFIG_PATH
  ) {
    throw deploymentError(
      "WORKER_DEPLOYMENT_CONFIG_PATH_INVALID",
      "Production Worker grants may only import the fixed Controller-owned probe topology",
    );
  }
  const document = loadManagedWorkerDeploymentProbeConfig(configPath, {
    platform,
    gatewayIdentity,
    aclVerifier,
    execFile: protectedFileExecFile || execFileSync,
  });
  const probe = document.stories[String(storyId || "").trim()];
  if (!probe) {
    throw deploymentError(
      "WORKER_DEPLOYMENT_PROBE_STORY_MISSING",
      "Controller probe topology does not contain the active story",
    );
  }
  const requestedCwd = canonicalWorkerPath(cwd);
  const requested = [...new Set([
    requestedCwd,
    ...(Array.isArray(requestedAllowedRoots) ? requestedAllowedRoots : []),
  ]
    .filter(Boolean)
    .map((value) => canonicalWorkerPath(value)))];
  if (
    !probe.allowedRoots.some((root) => pathIsInside(root, requestedCwd))
    || requested.some((candidate) => (
      !probe.allowedRoots.some((root) => pathIsInside(root, candidate))
    ))
  ) {
    throw deploymentError(
      "WORKER_DEPLOYMENT_PROBE_SCOPE_DRIFT",
      "Gateway workspace requests a path outside the Controller-owned story repositories",
    );
  }
  return Object.freeze({
    topologyGeneration: document.generation,
    cwd: requestedCwd,
    topologyCwd: probe.cwd,
    allowedRoots: probe.allowedRoots,
    writeDeniedRoots: probe.writeDeniedRoots,
    inaccessibleRoots: probe.inaccessibleRoots,
    inaccessibleEntries: probe.inaccessibleEntries,
    aclFingerprints: probe.aclFingerprints,
    workerIdentity: probe.workerIdentity,
    boundarySentinels: Object.freeze(
      probe.boundarySentinels.map((item) => Object.freeze({ ...item })),
    ),
  });
}

function sameBoundarySentinelSet(left, right) {
  const normalize = (values) => (Array.isArray(values) ? values : [])
    .map((item) => ({
      deniedRoot: normalizedPath(item?.deniedRoot),
      sentinelPath: normalizedPath(item?.sentinelPath),
    }))
    .sort((a, b) => (
      a.deniedRoot.localeCompare(b.deniedRoot)
      || a.sentinelPath.localeCompare(b.sentinelPath)
    ));
  return JSON.stringify(normalize(left)) === JSON.stringify(normalize(right));
}

/**
 * A queued grant cannot renew itself across a Controller topology generation.
 * The caller must rebuild the grant from the current protected topology and
 * complete a matching real deployment probe first.
 */
export function renewControllerManagedStoryWorkerGrant(grant = {}, {
  configPath = WORKER_DEPLOYMENT_PROBE_CONFIG_PATH,
  platform = process.platform,
  gatewayIdentity = currentOsIdentity(),
  aclVerifier,
  protectedFileExecFile,
  now,
  ttlMs,
} = {}) {
  if (String(grant.repositoryMode || "") !== INDEPENDENT_REPOSITORY_MODE) {
    return renewStoryWorkerGrant(grant, { now, ttlMs });
  }
  const current = resolveControllerManagedWorkerDeploymentProbeScopeForGrant({
    storyId: grant.storyId,
    cwd: grant.cwd,
    requestedAllowedRoots: grant.allowedRoots,
    configPath,
    platform,
    gatewayIdentity,
    aclVerifier,
    protectedFileExecFile,
  });
  const normalizedAcl = (values) => [...new Set(
    (Array.isArray(values) ? values : [])
      .map((value) => String(value || "").toLowerCase()),
  )].sort();
  if (
    Number(grant.topologyGeneration) !== current.topologyGeneration
    || normalizedPath(grant.topologyCwd) !== normalizedPath(current.topologyCwd)
    || !samePathSet(grant.allowedRoots, current.allowedRoots)
    || !samePathSet(grant.writeDeniedRoots, current.writeDeniedRoots)
    || !samePathSet(grant.inaccessibleRoots, current.inaccessibleRoots)
    || JSON.stringify(grant.inaccessibleEntries || [])
      !== JSON.stringify(current.inaccessibleEntries || [])
    || JSON.stringify(normalizedAcl(grant.aclFingerprints))
      !== JSON.stringify(normalizedAcl(current.aclFingerprints))
    || normalizedProbeIdentity(grant.workerIdentity, platform)
      !== normalizedProbeIdentity(current.workerIdentity, platform)
    || !sameBoundarySentinelSet(grant.boundarySentinels, current.boundarySentinels)
  ) {
    throw deploymentError(
      "WORKER_GRANT_TOPOLOGY_STALE",
      "Queued Worker grant no longer matches the Controller topology; re-grant and re-probe are required",
      {
        grantGeneration: Number(grant.topologyGeneration || 0),
        currentGeneration: current.topologyGeneration,
      },
    );
  }
  return renewStoryWorkerGrant(grant, { now, ttlMs });
}

function fsyncDirectory(directory) {
  if (process.platform === "win32") return;
  const fd = fs.openSync(directory, "r");
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

function sentinelDocument(storyId, deniedRoot) {
  const canonical = path.resolve(deniedRoot);
  return {
    schema: "devbench.worker-boundary-sentinel.v1",
    version: 1,
    storyId,
    deniedRoot: canonical,
    digest: createHash("sha256")
      .update(`${storyId}\0${normalizedPath(canonical)}`)
      .digest("hex"),
  };
}

function sentinelPathFor(storyId, deniedRoot) {
  const canonical = canonicalWorkerPath(deniedRoot, { mustExist: false });
  let parent = path.dirname(canonical);
  while (!fs.existsSync(parent)) {
    const next = path.dirname(parent);
    if (next === parent) {
      throw deploymentError(
        "WORKER_DEPLOYMENT_SENTINEL_PARENT_MISSING",
        "无法找到禁止根的既有父目录",
      );
    }
    parent = next;
  }
  parent = canonicalWorkerPath(parent);
  if (!fs.lstatSync(parent).isDirectory()) {
    throw deploymentError(
      "WORKER_DEPLOYMENT_SENTINEL_PARENT_INVALID",
      "禁止根边界哨兵父路径不是目录",
    );
  }
  const suffix = createHash("sha256")
    .update(`${storyId}\0${normalizedPath(canonical)}`)
    .digest("hex")
    .slice(0, 32);
  return path.join(parent, `.devbench-worker-boundary-${suffix}.sentinel`);
}

function ensureManagedBoundarySentinel({
  storyId,
  deniedRoot,
  sentinelProtector,
  sentinelVerifier,
}) {
  const sentinelPath = sentinelPathFor(storyId, deniedRoot);
  const expected = `${JSON.stringify(sentinelDocument(storyId, deniedRoot))}\n`;
  if (fs.existsSync(sentinelPath)) {
    const stat = fs.lstatSync(sentinelPath);
    if (
      !stat.isFile()
      || stat.isSymbolicLink()
      || fs.readFileSync(sentinelPath, "utf8") !== expected
    ) {
      throw deploymentError(
        "WORKER_DEPLOYMENT_SENTINEL_DRIFT",
        "既有 Worker 边界哨兵类型或内容漂移",
      );
    }
  } else {
    const fd = fs.openSync(sentinelPath, "wx", 0o600);
    try {
      fs.writeFileSync(fd, expected, "utf8");
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fsyncDirectory(path.dirname(sentinelPath));
  }
  sentinelProtector(sentinelPath, { storyId, deniedRoot });
  if (sentinelVerifier(sentinelPath, { storyId, deniedRoot }) !== true) {
    throw deploymentError(
      "WORKER_DEPLOYMENT_SENTINEL_ACL_UNSAFE",
      "Controller 无法证明边界哨兵与父目录拒绝 Worker rename/delete-child",
    );
  }
  return { deniedRoot: path.resolve(deniedRoot), sentinelPath };
}

function writeProbeConfigAtomically(target, document, protector, verifier) {
  const directory = path.dirname(target);
  const temporary = path.join(
    directory,
    `.worker-deployment-probe-${process.pid}-${randomBytes(12).toString("hex")}.tmp`,
  );
  let fd;
  try {
    fd = fs.openSync(temporary, "wx", 0o600);
    fs.writeFileSync(fd, `${JSON.stringify(document, null, 2)}\n`, "utf8");
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    protector(temporary);
    if (verifier(temporary) !== true) {
      throw deploymentError(
        "WORKER_DEPLOYMENT_CONFIG_ACL_UNSAFE",
        "Controller 无法证明临时 probe 配置 ACL 安全",
      );
    }
    fs.renameSync(temporary, target);
    fsyncDirectory(directory);
    if (verifier(target) !== true) {
      throw deploymentError(
        "WORKER_DEPLOYMENT_CONFIG_ACL_UNSAFE",
        "Controller 无法证明已发布 probe 配置 ACL 安全",
      );
    }
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    try { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); } catch {}
  }
}

function protectedProbeDocumentStillEquals(target, expected, options) {
  try {
    const resolved = assertProtectedProbeConfigFile(target, options);
    const actual = JSON.parse(fs.readFileSync(resolved, "utf8"));
    return JSON.stringify(actual) === JSON.stringify(expected);
  } catch {
    return false;
  }
}

function sameFileIdentity(left, right) {
  return (
    Number(left?.dev) === Number(right?.dev)
    && Number(left?.ino) === Number(right?.ino)
    && Number(left?.size) === Number(right?.size)
    && Number(left?.nlink) === Number(right?.nlink)
  );
}

function restoreSupersededSentinel(quarantinePath, sentinelPath) {
  if (!fs.existsSync(quarantinePath)) return;
  if (!fs.existsSync(sentinelPath)) {
    fs.renameSync(quarantinePath, sentinelPath);
    fsyncDirectory(path.dirname(sentinelPath));
    return;
  }
  // A newer generation recreated the canonical sentinel path while the old
  // inode was quarantined. The quarantined inode is no longer referenced by
  // any topology and can be removed without touching the newer sentinel.
  fs.unlinkSync(quarantinePath);
  fsyncDirectory(path.dirname(quarantinePath));
}

function removeStaleSentinelWithPublishedConfigCas({
  stale,
  target,
  publishedDocument,
  protectionOptions,
}) {
  if (!protectedProbeDocumentStillEquals(target, publishedDocument, protectionOptions)) {
    return false;
  }
  const resolved = assertNoLinkedSegments(
    stale.sentinelPath,
    "Worker deployment stale boundary sentinel",
  );
  if (
    !path.basename(resolved).startsWith(".devbench-worker-boundary-")
    || normalizedPath(resolved) !== normalizedPath(stale.sentinelPath)
  ) {
    throw deploymentError(
      "WORKER_DEPLOYMENT_SENTINEL_STALE_UNSAFE",
      "Refusing to clean a non-managed boundary sentinel",
    );
  }
  const before = fs.lstatSync(resolved);
  const expected = `${JSON.stringify(sentinelDocument(stale.storyId, stale.deniedRoot))}\n`;
  if (
    !before.isFile()
    || before.isSymbolicLink()
    || Number(before.nlink || 1) !== 1
    || fs.readFileSync(resolved, "utf8") !== expected
  ) {
    throw deploymentError(
      "WORKER_DEPLOYMENT_SENTINEL_STALE_OWNERSHIP_DRIFT",
      "Stale boundary sentinel no longer matches its Controller-owned identity",
    );
  }
  const quarantinePath = path.join(
    path.dirname(resolved),
    `.worker-boundary-stale-${randomBytes(16).toString("hex")}.tmp`,
  );
  fs.renameSync(resolved, quarantinePath);
  fsyncDirectory(path.dirname(resolved));
  try {
    const quarantined = fs.lstatSync(quarantinePath);
    if (
      !quarantined.isFile()
      || quarantined.isSymbolicLink()
      || !sameFileIdentity(before, quarantined)
      || fs.readFileSync(quarantinePath, "utf8") !== expected
    ) {
      throw deploymentError(
        "WORKER_DEPLOYMENT_SENTINEL_STALE_OWNERSHIP_DRIFT",
        "Quarantined boundary sentinel changed identity during cleanup",
      );
    }
    if (!protectedProbeDocumentStillEquals(target, publishedDocument, protectionOptions)) {
      restoreSupersededSentinel(quarantinePath, resolved);
      return false;
    }
    fs.unlinkSync(quarantinePath);
    fsyncDirectory(path.dirname(quarantinePath));
    return true;
  } catch (error) {
    try { restoreSupersededSentinel(quarantinePath, resolved); } catch {}
    throw error;
  }
}

function normalizedProbeIdentity(value, platform = process.platform) {
  const identity = String(value || "").trim().toLowerCase();
  if (String(platform).toLowerCase() === "win32") {
    return /^sid:s-\d(?:-\d+)+$/.test(identity) ? identity : "";
  }
  return /^uid:[0-9]+$/.test(identity) ? identity : "";
}

function managedProbeWorkerIdentity(value, {
  platform = process.platform,
  gatewayIdentity = "",
} = {}) {
  const rawWorkerIdentity = String(value || "").trim();
  const workerIdentity = normalizedProbeIdentity(rawWorkerIdentity, platform);
  const gateway = normalizedProbeIdentity(gatewayIdentity, platform);
  const privileged = new Set([
    "uid:0",
    "sid:s-1-5-18",
    "sid:s-1-5-19",
    "sid:s-1-5-20",
    "sid:s-1-5-32-544",
  ]);
  if (!workerIdentity || workerIdentity === gateway || privileged.has(workerIdentity)) {
    throw deploymentError(
      "WORKER_DEPLOYMENT_PROBE_WORKER_IDENTITY_INVALID",
      "Controller probe topology requires a distinct, non-privileged Worker identity",
    );
  }
  return rawWorkerIdentity;
}

function assertProbeProtectionTarget(target) {
  const resolved = assertNoLinkedSegments(target, "Worker deployment protection target");
  const stat = fs.lstatSync(resolved);
  if (!stat.isFile() || stat.isSymbolicLink() || Number(stat.nlink || 1) !== 1) {
    throw deploymentError(
      "WORKER_DEPLOYMENT_PROTECTION_TARGET_UNSAFE",
      "Worker deployment protection target must be a single regular file",
    );
  }
  return { resolved, stat };
}

function windowsProbeProtectionEvidence(target, {
  controllerSid,
  gatewaySids,
  managerSids,
  workerSids,
  denyGatewayParentWrites,
  execFile,
}) {
  const encodedTarget = Buffer.from(target, "utf8").toString("base64");
  const encodedPolicy = Buffer.from(JSON.stringify({
    controllerSid,
    gatewaySids,
    managerSids,
    workerSids,
    denyGatewayParentWrites: denyGatewayParentWrites === true,
  }), "utf8").toString("base64");
  const script = [
    "$ErrorActionPreference='Stop'",
    `$target=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedTarget}'))`,
    `$policy=ConvertFrom-Json ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedPolicy}')))`,
    "$controller=$policy.controllerSid.ToUpperInvariant()",
    "$gateways=@($policy.gatewaySids|ForEach-Object{$_.ToUpperInvariant()})",
    "$managers=@($policy.managerSids|ForEach-Object{$_.ToUpperInvariant()})",
    "$workers=@($policy.workerSids|ForEach-Object{$_.ToUpperInvariant()})",
    "$privileged=@($controller,'S-1-5-18','S-1-5-32-544')",
    "$allowed=@($privileged+$gateways+$managers|Sort-Object -Unique)",
    "$parentWriters=@($privileged+$managers|Sort-Object -Unique)",
    "if(-not $policy.denyGatewayParentWrites){$parentWriters=@($parentWriters+$gateways|Sort-Object -Unique)}",
    "$writeMask=[int64]([Security.AccessControl.FileSystemRights]::WriteData -bor [Security.AccessControl.FileSystemRights]::AppendData -bor [Security.AccessControl.FileSystemRights]::WriteAttributes -bor [Security.AccessControl.FileSystemRights]::WriteExtendedAttributes -bor [Security.AccessControl.FileSystemRights]::Delete -bor [Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles -bor [Security.AccessControl.FileSystemRights]::ChangePermissions -bor [Security.AccessControl.FileSystemRights]::TakeOwnership)",
    "$readMask=[int64]([Security.AccessControl.FileSystemRights]::ReadData -bor [Security.AccessControl.FileSystemRights]::ReadAttributes -bor [Security.AccessControl.FileSystemRights]::ReadExtendedAttributes -bor [Security.AccessControl.FileSystemRights]::ReadPermissions)",
    "$file=Get-Item -LiteralPath $target -Force",
    "if(($file.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0){throw 'target reparse point'}",
    "$acl=Get-Acl -LiteralPath $target",
    "$owner=$acl.GetOwner([Security.Principal.SecurityIdentifier]).Value.ToUpperInvariant()",
    "if($privileged -notcontains $owner){throw 'target owner is not Controller/SYSTEM/Administrators'}",
    "if(-not $acl.AreAccessRulesProtected){throw 'target DACL inheritance is enabled'}",
    "$seen=@{}",
    "foreach($rule in $acl.Access){",
    " if($rule.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow){throw 'target contains deny/audit ACE'}",
    " try{$sid=$rule.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value.ToUpperInvariant()}catch{$sid=$rule.IdentityReference.Value.ToUpperInvariant()}",
    " if($allowed -notcontains $sid){throw 'target contains non-allowlisted ACE'}",
    " if($workers -contains $sid){throw 'target grants a Worker identity'}",
    " $rights=[int64]$rule.FileSystemRights",
    " if($gateways -contains $sid){",
    "  if(($rights -band $writeMask) -ne 0 -or ($rights -band $readMask) -eq 0){throw 'Gateway target ACE is not read-only'}",
    " }",
    " $seen[$sid]=$true",
    "}",
    "if(-not $seen.ContainsKey($controller)){throw 'Controller target ACE missing'}",
    "foreach($gateway in $gateways){if(-not $seen.ContainsKey($gateway)){throw 'Gateway target ACE missing'}}",
    "$cursor=[IO.Directory]::GetParent($target)",
    "while($null -ne $cursor){",
    " $item=Get-Item -LiteralPath $cursor.FullName -Force",
    " if(($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0){throw 'parent reparse point'}",
    " $parentAcl=Get-Acl -LiteralPath $cursor.FullName",
    " $parentOwner=$parentAcl.GetOwner([Security.Principal.SecurityIdentifier]).Value.ToUpperInvariant()",
    " if($parentWriters -notcontains $parentOwner){throw 'parent chain owner is unsafe'}",
    " foreach($rule in $parentAcl.Access){",
    "  if($rule.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow){continue}",
    "  try{$sid=$rule.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value.ToUpperInvariant()}catch{$sid=$rule.IdentityReference.Value.ToUpperInvariant()}",
    "  $rights=[int64]$rule.FileSystemRights",
    "  if(($rights -band $writeMask) -ne 0 -and $parentWriters -notcontains $sid){throw 'parent chain has an unsafe writer'}",
    " }",
    " $cursor=$cursor.Parent",
    "}",
    "'SAFE'",
  ].join(";");
  const output = execFile(
    WINDOWS_POWERSHELL_PATH,
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
    {
      encoding: "utf8",
      windowsHide: true,
      timeout: 20_000,
      maxBuffer: 128 * 1024,
      env: {
        SystemRoot: path.win32.dirname(WINDOWS_SYSTEM32_PATH),
        ComSpec: path.win32.join(WINDOWS_SYSTEM32_PATH, "cmd.exe"),
        PATH: WINDOWS_SYSTEM32_PATH,
      },
    },
  ).trim();
  return output === "SAFE";
}

function unixProbeAcl(target, execFile) {
  return String(execFile(UNIX_GETFACL, ["-cp", target], {
    encoding: "utf8",
    timeout: 10_000,
    maxBuffer: 128 * 1024,
    env: { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" },
  }) || "");
}

/**
 * Build the only production ACL callbacks accepted by the Controller topology
 * writer. Tests may inject callbacks, but production always uses fixed absolute
 * system tools and derives every principal from the protected daemon policy.
 */
export function createManagedWorkerProbeProtectionCallbacks({
  controllerIdentity = currentOsIdentity(),
  gatewayIdentities = [],
  humanManagerIdentities = [],
  workerIdentities = {},
  platform = process.platform,
  execFile = execFileSync,
} = {}) {
  if (
    process.env.NODE_ENV !== "test"
    && (platform !== process.platform || execFile !== execFileSync)
  ) {
    throw deploymentError(
      "WORKER_DEPLOYMENT_PROTECTION_OVERRIDE_FORBIDDEN",
      "Production probe protection cannot override the platform or system-tool executor",
    );
  }
  const normalizedPlatform = String(platform).toLowerCase();
  const controller = normalizedProbeIdentity(controllerIdentity, normalizedPlatform);
  const gateways = [...new Set(gatewayIdentities.map(
    (value) => normalizedProbeIdentity(value, normalizedPlatform),
  ))].filter(Boolean);
  const managers = [...new Set(humanManagerIdentities.map(
    (value) => normalizedProbeIdentity(value, normalizedPlatform),
  ))].filter(Boolean);
  const workers = [...new Set(Object.values(workerIdentities).map(
    (value) => normalizedProbeIdentity(value, normalizedPlatform),
  ))].filter(Boolean);
  if (
    !controller
    || gateways.length === 0
    || workers.length === 0
    || [...gateways, ...managers, ...workers].includes(controller)
    || workers.some((identity) => gateways.includes(identity) || managers.includes(identity))
  ) {
    throw deploymentError(
      "WORKER_DEPLOYMENT_PROTECTION_IDENTITY_POLICY_INVALID",
      "Probe protection requires distinct Controller, Gateway, manager, and Worker identities",
    );
  }
  if (normalizedPlatform === "win32") {
    const controllerSid = controller.slice(4).toUpperCase();
    const gatewaySids = gateways.map((identity) => identity.slice(4).toUpperCase());
    const managerSids = managers.map((identity) => identity.slice(4).toUpperCase());
    const workerSids = workers.map((identity) => identity.slice(4).toUpperCase());
    const protect = (target) => {
      const { resolved } = assertProbeProtectionTarget(target);
      execFile(WINDOWS_ICACLS_PATH, [
        resolved,
        "/inheritance:r",
        "/grant:r",
        `*${controllerSid}:F`,
        ...gatewaySids.map((sid) => `*${sid}:R`),
        ...managerSids.map((sid) => `*${sid}:R`),
        "*S-1-5-18:F",
        "*S-1-5-32-544:F",
      ], {
        encoding: "utf8",
        windowsHide: true,
        timeout: 20_000,
        maxBuffer: 128 * 1024,
        env: {
          SystemRoot: path.win32.dirname(WINDOWS_SYSTEM32_PATH),
          ComSpec: path.win32.join(WINDOWS_SYSTEM32_PATH, "cmd.exe"),
          PATH: WINDOWS_SYSTEM32_PATH,
        },
      });
      execFile(WINDOWS_ICACLS_PATH, [resolved, "/setowner", `*${controllerSid}`], {
        encoding: "utf8",
        windowsHide: true,
        timeout: 20_000,
        maxBuffer: 128 * 1024,
        env: {
          SystemRoot: path.win32.dirname(WINDOWS_SYSTEM32_PATH),
          ComSpec: path.win32.join(WINDOWS_SYSTEM32_PATH, "cmd.exe"),
          PATH: WINDOWS_SYSTEM32_PATH,
        },
      });
    };
    const verify = (target, { denyGatewayParentWrites = true } = {}) => {
      const { resolved } = assertProbeProtectionTarget(target);
      return windowsProbeProtectionEvidence(resolved, {
        controllerSid,
        gatewaySids,
        managerSids,
        workerSids,
        denyGatewayParentWrites,
        execFile,
      });
    };
    const configAclVerifier = trustManagedProbeAclVerifier(
      (target) => verify(target, { denyGatewayParentWrites: true }),
    );
    return Object.freeze({
      sentinelProtector: protect,
      sentinelVerifier: (target) => verify(target, { denyGatewayParentWrites: false }),
      configProtector: protect,
      configVerifier: configAclVerifier,
      configAclVerifier,
    });
  }
  if (normalizedPlatform !== "linux") {
    throw deploymentError(
      "WORKER_DEPLOYMENT_PROTECTION_PLATFORM_UNSUPPORTED",
      "Strong probe protection is currently supported only on Windows and Linux",
    );
  }
  const controllerUid = Number(controller.slice(4));
  const gatewayUids = gateways.map((identity) => Number(identity.slice(4)));
  const managerUids = managers.map((identity) => Number(identity.slice(4)));
  const workerUids = workers.map((identity) => Number(identity.slice(4)));
  for (const tool of [UNIX_SETFACL, UNIX_GETFACL]) {
    const stat = fs.lstatSync(tool);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== 0 || (stat.mode & 0o022) !== 0) {
      throw deploymentError(
        "WORKER_DEPLOYMENT_PROTECTION_TOOL_UNSAFE",
        "Linux probe protection requires root-owned, non-writable fixed ACL tools",
      );
    }
  }
  const protect = (target) => {
    const { resolved, stat } = assertProbeProtectionTarget(target);
    if (stat.uid !== controllerUid) {
      throw deploymentError(
        "WORKER_DEPLOYMENT_PROTECTION_OWNER_UNSAFE",
        "Controller must own the probe configuration and boundary sentinels",
      );
    }
    fs.chmodSync(resolved, 0o600);
    execFile(UNIX_SETFACL, ["-b", resolved], {
      timeout: 10_000,
      env: { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" },
    });
    execFile(UNIX_SETFACL, [
      "-m",
      [
        ...gatewayUids.map((uid) => `u:${uid}:r--`),
        ...managerUids.map((uid) => `u:${uid}:r--`),
        ...workerUids.map((uid) => `u:${uid}:---`),
        "m::r--",
        "o::---",
      ].join(","),
      resolved,
    ], {
      timeout: 10_000,
      env: { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" },
    });
  };
  const verify = (target, { denyGatewayParentWrites = true } = {}) => {
    const { resolved, stat } = assertProbeProtectionTarget(target);
    if (stat.uid !== controllerUid || (stat.mode & 0o022) !== 0) return false;
    const targetAcl = unixProbeAcl(resolved, execFile);
    if (
      gatewayUids.some((uid) => !new RegExp(`^user:${uid}:r--$`, "m").test(targetAcl))
      || workerUids.some((uid) => !new RegExp(`^user:${uid}:---$`, "m").test(targetAcl))
    ) {
      return false;
    }
    const allowedOwners = new Set([
      0,
      controllerUid,
      ...managerUids,
      ...(denyGatewayParentWrites ? [] : gatewayUids),
    ]);
    let cursor = path.dirname(resolved);
    while (true) {
      const parentStat = fs.lstatSync(cursor);
      if (
        parentStat.isSymbolicLink()
        || !parentStat.isDirectory()
        || !allowedOwners.has(parentStat.uid)
        || (parentStat.mode & 0o022) !== 0
      ) {
        return false;
      }
      const parentAcl = unixProbeAcl(cursor, execFile);
      if ([
        ...(denyGatewayParentWrites ? gatewayUids : []),
        ...workerUids,
      ].some((uid) => {
        const match = parentAcl.match(new RegExp(`^user:${uid}:([^\\r\\n]*)$`, "m"));
        return match && /w/.test(match[1]);
      })) {
        return false;
      }
      const next = path.dirname(cursor);
      if (next === cursor) break;
      cursor = next;
    }
    return true;
  };
  const configAclVerifier = trustManagedProbeAclVerifier(
    (target) => verify(target, { denyGatewayParentWrites: true }),
  );
  return Object.freeze({
    sentinelProtector: protect,
    sentinelVerifier: (target) => verify(target, { denyGatewayParentWrites: false }),
    configProtector: protect,
    configVerifier: configAclVerifier,
    configAclVerifier,
  });
}

/**
 * Controller-only topology reconciliation. Call this after provision registry
 * CAS and after retire registry CAS. It never marks a story READY: every
 * returned story must still complete the real cross-identity preflight.
 */
export function reconcileManagedWorkerDeploymentProbeConfig(
  topology,
  {
    configPath = WORKER_DEPLOYMENT_PROBE_CONFIG_PATH,
    expectedPreviousGeneration,
    controllerIdentity = currentOsIdentity(),
    gatewayIdentities = [],
    sentinelProtector,
    sentinelVerifier,
    configProtector,
    configVerifier,
    configAclVerifier,
    platform = process.platform,
    protectedFileExecFile,
  } = {},
) {
  const testMode = process.env.NODE_ENV === "test";
  if (
    !testMode
    && (
      process.env.DEVBENCH_GIT_CONTROLLER_DAEMON_RUNTIME !== "1"
      || path.resolve(configPath) !== WORKER_DEPLOYMENT_PROBE_CONFIG_PATH
      || String(controllerIdentity).toLowerCase() !== currentOsIdentity().toLowerCase()
      || gatewayIdentities.length === 0
      || gatewayIdentities.some(
        (identity) => String(identity).toLowerCase() === String(controllerIdentity).toLowerCase(),
      )
    )
  ) {
    throw deploymentError(
      "WORKER_DEPLOYMENT_RECONCILE_CALLER_FORBIDDEN",
      "probe 配置 reconcile 只能由固定独立 Git Controller 身份调用",
    );
  }
  for (const [name, callback] of Object.entries({
    sentinelProtector,
    sentinelVerifier,
    configProtector,
    configVerifier,
  })) {
    if (typeof callback !== "function") {
      throw deploymentError(
        "WORKER_DEPLOYMENT_RECONCILE_PROTECTOR_REQUIRED",
        `Controller probe reconcile 缺少 ${name}`,
      );
    }
  }
  const generation = Number(topology?.generation);
  const rawStories = Array.isArray(topology?.stories) ? topology.stories : [];
  if (
    !Number.isSafeInteger(generation)
    || generation < 1
    || !Array.isArray(topology?.stories)
  ) {
    throw deploymentError(
      "WORKER_DEPLOYMENT_RECONCILE_TOPOLOGY_INVALID",
      "Controller probe topology 必须包含递增 generation 与故事列表",
    );
  }
  const target = path.resolve(configPath);
  let previous = null;
  if (fs.existsSync(target)) {
    const migrationProtectionOptions = {
      platform,
      gatewayIdentity: gatewayIdentities[0] || currentOsIdentity(),
      aclVerifier: configAclVerifier,
      execFile: protectedFileExecFile || execFileSync,
      allowMissingStoryRoots: true,
    };
    try {
      previous = loadManagedWorkerDeploymentProbeConfig(
        target,
        migrationProtectionOptions,
      );
    } catch (error) {
      if (error?.code !== "WORKER_DEPLOYMENT_CONFIG_SCHEMA_INVALID") throw error;
      previous = loadLegacyWorkerDeploymentProbeMigrationSource(
        target,
        migrationProtectionOptions,
      );
    }
    if (
      expectedPreviousGeneration !== undefined
      && previous.generation !== expectedPreviousGeneration
    ) {
      throw deploymentError(
        "WORKER_DEPLOYMENT_RECONCILE_STALE_GENERATION",
        "Controller probe topology CAS generation 已漂移",
      );
    }
    if (generation <= previous.generation) {
      throw deploymentError(
        "WORKER_DEPLOYMENT_RECONCILE_STALE_GENERATION",
        "Controller probe topology generation 必须严格递增",
      );
    }
  } else if (expectedPreviousGeneration !== undefined && expectedPreviousGeneration !== 0) {
    throw deploymentError(
      "WORKER_DEPLOYMENT_RECONCILE_STALE_GENERATION",
      "Controller probe 初始 generation CAS 无效",
    );
  }

  const stories = {};
  const desiredSentinels = new Set();
  for (const raw of [...rawStories].sort((a, b) => String(a.storyId).localeCompare(String(b.storyId)))) {
    const storyId = String(raw?.storyId || "").trim();
    if (!storyId || stories[storyId]) {
      throw deploymentError(
        "WORKER_DEPLOYMENT_RECONCILE_TOPOLOGY_INVALID",
        "Controller probe topology storyId 缺失或重复",
      );
    }
    const cwd = canonicalWorkerPath(raw.cwd);
    const allowedRoots = assertPathArray(
      "allowedRoots",
      [...new Set([cwd, ...(raw.allowedRoots || [])].map((value) => path.resolve(value)))],
    );
    const writeDeniedRoots = assertPathArray(
      "writeDeniedRoots",
      raw.writeDeniedRoots,
      { mustExist: false },
    );
    const inaccessibleRoots = assertPathArray(
      "inaccessibleRoots",
      raw.inaccessibleRoots,
      { mustExist: false },
    );
    const inaccessibleEntries = enumerateControllerInaccessibleEntries(inaccessibleRoots);
    const aclFingerprints = [...new Set(
      (raw.aclFingerprints || []).map((value) => String(value).toLowerCase()),
    )].sort();
    const workerIdentity = managedProbeWorkerIdentity(raw.workerIdentity, {
      platform,
      gatewayIdentity: gatewayIdentities[0] || "",
    });
    if (
      aclFingerprints.length === 0
      || aclFingerprints.some((value) => !SHA256_HEX_PATTERN.test(value))
    ) {
      throw deploymentError(
        "WORKER_DEPLOYMENT_RECONCILE_TOPOLOGY_INVALID",
        "Controller probe topology 缺少 ACL fingerprint",
      );
    }
    const deniedRoots = [...writeDeniedRoots, ...inaccessibleRoots];
    const boundarySentinels = deniedRoots.map((deniedRoot) => (
      ensureManagedBoundarySentinel({
        storyId,
        deniedRoot,
        sentinelProtector,
        sentinelVerifier,
      })
    ));
    for (const item of boundarySentinels) desiredSentinels.add(normalizedPath(item.sentinelPath));
    createStoryWorkerGrant({
      storyId,
      repositoryMode: INDEPENDENT_REPOSITORY_MODE,
      cwd,
      allowedRoots,
      writeDeniedRoots,
      inaccessibleRoots,
      inaccessibleEntries,
      boundarySentinels,
      workerIdentity,
      aclFingerprints,
    });
    stories[storyId] = {
      cwd,
      allowedRoots,
      writeDeniedRoots,
      inaccessibleRoots,
      inaccessibleEntries,
      boundarySentinels,
      aclFingerprints,
      workerIdentity,
    };
  }
  const document = {
    schema: PROBE_CONFIG_SCHEMA,
    version: 5,
    generation,
    stories,
  };
  writeProbeConfigAtomically(target, document, configProtector, configVerifier);

  const staleSentinels = [];
  for (const [storyId, probe] of Object.entries(previous?.stories || {})) {
    for (const item of probe.boundarySentinels || []) {
      if (!desiredSentinels.has(normalizedPath(item.sentinelPath))) {
        staleSentinels.push({
          storyId,
          deniedRoot: item.deniedRoot,
          sentinelPath: item.sentinelPath,
        });
      }
    }
  }
  let staleSentinelsRemoved = 0;
  for (const stale of staleSentinels) {
    try {
      if (removeStaleSentinelWithPublishedConfigCas({
        stale,
        target,
        publishedDocument: document,
        protectionOptions: {
          platform,
          gatewayIdentity: gatewayIdentities[0] || currentOsIdentity(),
          aclVerifier: configAclVerifier,
          execFile: protectedFileExecFile || execFileSync,
        },
      })) {
        staleSentinelsRemoved += 1;
      }
    } catch (error) {
      throw deploymentError(
        "WORKER_DEPLOYMENT_SENTINEL_STALE_CLEANUP_FAILED",
        "Controller 已发布新 probe 配置，但无法安全清理受管旧边界哨兵",
        { causeCode: String(error?.code || "SENTINEL_STALE_CLEANUP_FAILED") },
      );
    }
  }
  return Object.freeze({
    generation,
    storiesRequiringProbe: Object.freeze(Object.keys(stories)),
    removedStoryIds: Object.freeze(
      Object.keys(previous?.stories || {}).filter((storyId) => !stories[storyId]),
    ),
    staleSentinelsRemoved,
    staleSentinelsDeferred: staleSentinels.length - staleSentinelsRemoved,
  });
}

function assertIdentityResolvable(
  identity,
  {
    platform = process.platform,
    execFile = execFileSync,
  } = {},
) {
  if (String(platform).toLowerCase() === "win32") {
    const sid = String(identity || "").replace(/^sid:/i, "").toUpperCase();
    if (!/^S-\d(?:-\d+)+$/.test(sid)) {
      throw deploymentError(
        "WORKER_DEPLOYMENT_IDENTITY_INVALID",
        "Worker deployment Windows 身份不是合法 SID",
      );
    }
    try {
      execFile(
        WINDOWS_POWERSHELL_PATH,
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          `$null=([Security.Principal.SecurityIdentifier]'${sid}').Translate([Security.Principal.NTAccount])`,
        ],
        { windowsHide: true, timeout: 10_000, stdio: "ignore" },
      );
    } catch {
      throw deploymentError(
        "WORKER_DEPLOYMENT_IDENTITY_NOT_FOUND",
        "受管配置中的 Worker SID 无法解析为现有 OS 账号",
      );
    }
    return;
  }
  const match = String(identity || "").match(/^uid:([0-9]+)$/);
  const uid = Number(match?.[1]);
  if (!match || !Number.isSafeInteger(uid) || uid <= 0) {
    throw deploymentError(
      "WORKER_DEPLOYMENT_IDENTITY_INVALID",
      "Unix Worker 必须声明现有的非 root uid",
    );
  }
  try {
    const account = String(execFile(
      "id",
      ["-nu", String(uid)],
      { encoding: "utf8", timeout: 10_000 },
    ) || "").trim();
    if (!account) throw new Error("empty account");
  } catch {
    throw deploymentError(
      "WORKER_DEPLOYMENT_IDENTITY_NOT_FOUND",
      "受管配置中的 Worker uid 无法解析为现有 OS 账号",
    );
  }
}

function envelopeNonce(encoded) {
  try {
    const envelope = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
    if (!UUID_PATTERN.test(String(envelope.nonce || ""))) throw new Error("invalid nonce");
    return envelope.nonce;
  } catch {
    throw deploymentError(
      "WORKER_DEPLOYMENT_ENVELOPE_INVALID",
      "无法读取刚生成的 Worker deployment probe envelope",
    );
  }
}

function parseProbeResult(stdout, expected) {
  const lines = String(stdout || "").split(/\r?\n/).filter(Boolean);
  const records = lines.filter((line) => line.startsWith(PROBE_RESULT_PREFIX));
  if (records.length !== 1) {
    throw deploymentError(
      "WORKER_DEPLOYMENT_PROBE_RESULT_MISSING",
      "独立 Worker broker 未返回唯一的 deployment probe 结果",
    );
  }
  const encoded = records[0].slice(PROBE_RESULT_PREFIX.length);
  if (!BASE64URL_PATTERN.test(encoded)) {
    throw deploymentError(
      "WORKER_DEPLOYMENT_PROBE_RESULT_INVALID",
      "独立 Worker broker 返回了无效的 deployment probe 编码",
    );
  }
  let result;
  try {
    result = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  } catch {
    throw deploymentError(
      "WORKER_DEPLOYMENT_PROBE_RESULT_INVALID",
      "独立 Worker broker 返回了无效的 deployment probe JSON",
    );
  }
  if (
    !result
    || typeof result !== "object"
    || Array.isArray(result)
    || JSON.stringify(Object.keys(result).sort()) !== JSON.stringify(PROBE_RESULT_FIELDS)
    || result.schema !== PROBE_RESULT_SCHEMA
    || result.version !== 3
    || result.ok !== true
    || result.operation !== "deployment-probe"
    || result.launchNonce !== expected.launchNonce
    || result.storyId !== expected.storyId
    || String(result.expectedIdentity || "").toLowerCase() !== expected.identity.toLowerCase()
    || String(result.actualIdentity || "").toLowerCase() !== expected.identity.toLowerCase()
    || !result.checks
    || JSON.stringify(Object.keys(result.checks).sort()) !== JSON.stringify(PROBE_CHECK_FIELDS)
    || Object.values(result.checks).some((value) => value !== true)
  ) {
    throw deploymentError(
      "WORKER_DEPLOYMENT_PROBE_RESULT_MISMATCH",
      "独立 Worker broker 返回的身份、nonce 或权限检查结果与签名请求不一致",
    );
  }
  return result;
}

function sanitizedFailureText(value) {
  return String(value || "")
    .replace(/-----BEGIN [^-]+-----[\s\S]*?-----END [^-]+-----/g, "[redacted-key]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 400);
}

export function runWorkerIsolationDeploymentPreflight({
  storyId,
  staticOnly = false,
  now,
  platform = process.platform,
  gatewayIdentity = currentOsIdentity(),
  launcherConfigPath = WORKER_LAUNCHER_CONFIG_PATH,
  probeConfigPath = WORKER_DEPLOYMENT_PROBE_CONFIG_PATH,
  testSigningPrivateKey,
  testTrustAnchor,
  aclVerifier,
  attestationAclVerifier,
  attestationPath = WORKER_DEPLOYMENT_ATTESTATION_PATH,
  identityExecFile,
  protectedFileExecFile,
  spawn = spawnSync,
  environment = process.env,
  testNonceOptions,
} = {}) {
  const effectiveNow = now === undefined ? Date.now() : now;
  if (
    (now !== undefined
      || testSigningPrivateKey !== undefined
      || testTrustAnchor !== undefined
      || aclVerifier !== undefined
      || attestationAclVerifier !== undefined
      || path.resolve(attestationPath) !== WORKER_DEPLOYMENT_ATTESTATION_PATH
      || identityExecFile !== undefined
      || protectedFileExecFile !== undefined
      || spawn !== spawnSync
      || environment !== process.env
      || testNonceOptions !== undefined)
    && process.env.NODE_ENV !== "test"
  ) {
    throw deploymentError(
      "WORKER_DEPLOYMENT_TEST_OVERRIDE_FORBIDDEN",
      "Worker deployment preflight 测试替身仅允许 NODE_ENV=test",
    );
  }
  if (
    process.env.NODE_ENV !== "test"
    && (
      String(platform).toLowerCase() !== process.platform
      || String(gatewayIdentity).toLowerCase() !== currentOsIdentity().toLowerCase()
    )
  ) {
    throw deploymentError(
      "WORKER_DEPLOYMENT_IDENTITY_OVERRIDE_FORBIDDEN",
      "生产 preflight 不允许覆盖实际平台或 Gateway OS 身份",
    );
  }
  const normalizedStoryId = String(storyId || "").trim();
  if (!normalizedStoryId) {
    throw deploymentError(
      "WORKER_DEPLOYMENT_STORY_ID_REQUIRED",
      "Worker deployment preflight 必须指定故事点 ID",
    );
  }
  if (
    process.env.NODE_ENV !== "test"
    && (
      path.resolve(launcherConfigPath) !== WORKER_LAUNCHER_CONFIG_PATH
      || path.resolve(probeConfigPath) !== WORKER_DEPLOYMENT_PROBE_CONFIG_PATH
    )
  ) {
    throw deploymentError(
      "WORKER_DEPLOYMENT_CONFIG_PATH_INVALID",
      "生产 preflight 只允许读取固定受保护配置路径",
    );
  }

  const launcher = loadManagedWorkerLauncherConfig(launcherConfigPath, {
    storyId: normalizedStoryId,
    platform,
    gatewayIdentity,
    aclVerifier,
  });
  const probeDocument = loadManagedWorkerDeploymentProbeConfig(probeConfigPath, {
    platform,
    gatewayIdentity,
    aclVerifier,
    execFile: protectedFileExecFile || execFileSync,
  });
  const probe = probeDocument.stories[normalizedStoryId];
  if (!probe) {
    throw deploymentError(
      "WORKER_DEPLOYMENT_PROBE_STORY_MISSING",
      "固定 deployment probe 配置没有当前故事点",
    );
  }
  if (
    normalizedProbeIdentity(launcher.identity, platform)
      !== normalizedProbeIdentity(probe.workerIdentity, platform)
  ) {
    throw deploymentError(
      "WORKER_DEPLOYMENT_PROBE_WORKER_IDENTITY_DRIFT",
      "Launcher identity differs from the Controller-owned probe topology",
    );
  }
  assertIdentityResolvable(launcher.identity, {
    platform,
    execFile: identityExecFile || execFileSync,
  });
  if (staticOnly) {
    return {
      ok: false,
      status: "BLOCKED",
      code: "WORKER_DEPLOYMENT_RUNTIME_PROBE_REQUIRED",
      storyId: normalizedStoryId,
      expectedIdentity: launcher.identity,
      identityProbe: "NOT_RUN",
      isolationLevel: "DEGRADED",
    };
  }

  const grant = createStoryWorkerGrant({
    storyId: normalizedStoryId,
    repositoryMode: INDEPENDENT_REPOSITORY_MODE,
    cwd: probe.cwd,
    allowedRoots: probe.allowedRoots,
    writeDeniedRoots: probe.writeDeniedRoots,
    inaccessibleRoots: probe.inaccessibleRoots,
    inaccessibleEntries: probe.inaccessibleEntries,
    boundarySentinels: probe.boundarySentinels,
    workerIdentity: probe.workerIdentity,
    aclFingerprints: probe.aclFingerprints,
    topologyGeneration: probeDocument.generation,
    readOnly: false,
    now: effectiveNow,
    ttlMs: 60_000,
  });
  const envelope = createSignedWorkerLaunchEnvelope({
    taskId: `deployment-probe:${normalizedStoryId}:${grant.grantId}`,
    operation: "deployment-probe",
    command: "",
    args: [],
    cwd: grant.cwd,
    expectedIdentity: launcher.identity,
    identityScope: launcher.identityScope,
    gatewayIdentity: launcher.gatewayIdentity,
    grant,
    readOnly: false,
  }, {
    now: effectiveNow,
    ttlMs: 30_000,
    payloadExpiresAt: grant.expiresAt,
    testSigningPrivateKey,
  });
  if (process.env.NODE_ENV !== "test") {
    issueWorkerLaunchNonce(envelope);
  } else if (testNonceOptions !== undefined) {
    issueWorkerLaunchNonce(envelope, testNonceOptions);
  }
  const launchNonce = envelopeNonce(envelope);
  const child = spawn(
    launcher.command,
    [...launcher.args, "--devbench-worker-spec", envelope],
    {
      cwd: SERVICE_DIR,
      shell: false,
      windowsHide: true,
      env: sanitizeWorkerEnvironment(environment),
      encoding: "utf8",
      timeout: 25_000,
      maxBuffer: 256 * 1024,
    },
  );
  if (child?.error || child?.status !== 0 || child?.signal) {
    throw deploymentError(
      child?.error?.code === "ETIMEDOUT"
        ? "WORKER_DEPLOYMENT_PROBE_TIMEOUT"
        : "WORKER_DEPLOYMENT_PROBE_FAILED",
      "受管 launcher 未能在目标 Worker 身份下完成 broker deployment probe",
      {
        exitCode: Number.isInteger(child?.status) ? child.status : null,
        signal: child?.signal || null,
        diagnostic: sanitizedFailureText(child?.stderr || child?.error?.message),
      },
    );
  }
  const result = parseProbeResult(child.stdout, {
    launchNonce,
    storyId: normalizedStoryId,
    identity: launcher.identity,
  });
  if (!platformSupportsStrongWorkerIsolation(platform)) {
    return {
      ok: false,
      status: "BLOCKED",
      code: "WORKER_KERNEL_CONTAINMENT_UNAVAILABLE",
      storyId: normalizedStoryId,
      expectedIdentity: launcher.identity,
      actualIdentity: result.actualIdentity,
      identityProbe: "PASS",
      isolationLevel: "DEGRADED",
    };
  }
  recordWorkerDeploymentAttestation({
    storyId: normalizedStoryId,
    launcher,
    grant,
    probeResult: result,
    now: effectiveNow,
    platform,
    gatewayIdentity,
    attestationPath,
    aclVerifier: attestationAclVerifier,
    testTrustAnchor,
    signer: (document) => signWorkerDeploymentAttestationDocument(document, {
      testSigningPrivateKey,
    }),
  });
  return {
    ok: true,
    status: "READY",
    code: "WORKER_DEPLOYMENT_READY",
    storyId: normalizedStoryId,
    expectedIdentity: launcher.identity,
    actualIdentity: result.actualIdentity,
    identityProbe: "PASS",
    isolationLevel: "STRONG",
  };
}

export function formatWorkerDeploymentFailure(error) {
  return {
    ok: false,
    status: "BLOCKED",
    code: error?.code || "WORKER_DEPLOYMENT_PREFLIGHT_FAILED",
    message: String(error?.message || "Worker deployment preflight 失败"),
    details: error?.details && typeof error.details === "object"
      ? { ...error.details }
      : {},
    isolationLevel: "DEGRADED",
  };
}
