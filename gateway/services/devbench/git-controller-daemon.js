import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { execFileSync } from "node:child_process";
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  randomBytes,
  randomUUID,
  sign as signPayload,
} from "node:crypto";
import { createManagedHooksController } from "./managed-hooks-controller.js";
import { listBaseProtectionHooks } from "./base-protection-hooks.js";
import { createStoryRepositoryController } from "./story-repository-controller.js";
import {
  recoverStoryBaselineOperationMetadata,
  recoverStoryBaselineMetadataByIdempotency,
} from "./story-baseline-registry-recovery.js";
import {
  GIT_CONTROLLER_CLOCK_SKEW_MS,
  GIT_CONTROLLER_MAX_MESSAGE_BYTES,
  GIT_CONTROLLER_PROTOCOL_VERSION,
  GIT_PROCESS_CONTAINMENT_MODES,
  canonicalProtocolJson,
  currentProcessIdentity,
  publicKeyFingerprint,
  readProtectedFile,
  storyAcceptedRefreshIdempotencyKey,
  validateControllerCommand,
  validateControllerEndpoint,
  verifyGitProcessContainmentReceiptEnvelope,
  verifyGitProcessTreeRecoveryReceiptEnvelope,
  verifyControllerRequestMac,
} from "./git-controller-process-protocol.js";
import {
  GitControllerError,
  assertIdempotencyKey,
  canonicalRemoteIdentity,
} from "./git-controller/index.js";
import {
  isTrustedProcessStartIdentity,
  pidIsAlive,
  processStartIdentity,
} from "./git-controller/lease.js";

const WINDOWS_SYSTEM32 = "C:\\Windows\\System32";
const WINDOWS_ICACLS = path.join(WINDOWS_SYSTEM32, "icacls.exe");
const WINDOWS_POWERSHELL = path.join(
  WINDOWS_SYSTEM32,
  "WindowsPowerShell",
  "v1.0",
  "powershell.exe",
);
const UNIX_SETFACL = "/usr/bin/setfacl";
const UNIX_GETFACL = "/usr/bin/getfacl";
const UNIX_DAEMON_INSTANCE_LOCK = "git-controller-daemon.instance.lock";
const UNIX_ENDPOINT_PROBE_TIMEOUT_MS = 1_500;
const WINDOWS_LEGACY_MAX_PATH = 260;
const WINDOWS_EXTENDED_MAX_PATH = 32_767;
const STORY_PORTABLE_SEGMENT_MAX_LENGTH = 59;
const STORY_CREATING_UUID_LENGTH = 36;
const STORY_TRACKED_RELATIVE_PATH_BUDGET = 1_024;
const STORY_GIT_METADATA_RELATIVE_PATH_BUDGET = 128;
const GIT_PROCESS_CONTAINMENT_ATTESTATION_PREFIX =
  "DEVBENCH_GIT_PROCESS_TREE_ATTESTATION_V2=";
const GIT_PROCESS_CONTAINMENT_EMPTY_PREFIX =
  "DEVBENCH_GIT_PROCESS_TREE_EMPTY_V2=";
const GIT_PROCESS_CONTAINMENT_SESSION = Symbol(
  "devbench.git-controller.process-containment-session",
);

function daemonError(code, message, details = {}, cause) {
  return new GitControllerError(code, message, details, cause ? { cause } : undefined);
}

export function diagnoseGitControllerStoryPathBudget(storyRoot, {
  platform = process.platform,
  trackedRelativePathBudget = STORY_TRACKED_RELATIVE_PATH_BUDGET,
} = {}) {
  const resolvedRoot = path.resolve(String(storyRoot || ""));
  const relativeBudget = Number(trackedRelativePathBudget);
  if (
    !path.isAbsolute(String(storyRoot || ""))
    || !String(storyRoot || "").trim()
    || !Number.isSafeInteger(relativeBudget)
    || relativeBudget < 1
  ) {
    throw daemonError(
      "GIT_CONTROLLER_STORY_ROOT_PATH_BUDGET_INVALID",
      "Story root path-budget diagnostics require an absolute root and positive tracked-path budget",
    );
  }
  const creatingLeafLength = (
    1
    + STORY_PORTABLE_SEGMENT_MAX_LENGTH
    + ".creating-".length
    + STORY_CREATING_UUID_LENGTH
  );
  const finalRepositoryPathLength = (
    resolvedRoot.length
    + 1
    + STORY_PORTABLE_SEGMENT_MAX_LENGTH
    + 1
    + STORY_PORTABLE_SEGMENT_MAX_LENGTH
  );
  const creatingRepositoryPathLength = (
    resolvedRoot.length
    + 1
    + STORY_PORTABLE_SEGMENT_MAX_LENGTH
    + 1
    + creatingLeafLength
  );
  const projectedTrackedPathLength = (
    creatingRepositoryPathLength
    + 1
    + relativeBudget
  );
  const projectedGitMetadataPathLength = (
    creatingRepositoryPathLength
    + 1
    + STORY_GIT_METADATA_RELATIVE_PATH_BUDGET
  );
  const projectedMaximumPathLength = Math.max(
    projectedTrackedPathLength,
    projectedGitMetadataPathLength,
  );
  const windows = platform === "win32";
  const exceedsWindowsExtendedLimit = (
    windows
    && projectedMaximumPathLength >= WINDOWS_EXTENDED_MAX_PATH
  );
  return Object.freeze({
    platform,
    storyRootLength: resolvedRoot.length,
    portableStorySegmentLength: STORY_PORTABLE_SEGMENT_MAX_LENGTH,
    portableRepositorySegmentLength: STORY_PORTABLE_SEGMENT_MAX_LENGTH,
    creatingLeafLength,
    finalRepositoryPathLength,
    creatingRepositoryPathLength,
    trackedRelativePathBudget: relativeBudget,
    gitMetadataRelativePathBudget: STORY_GIT_METADATA_RELATIVE_PATH_BUDGET,
    projectedTrackedPathLength,
    projectedGitMetadataPathLength,
    projectedMaximumPathLength,
    legacyMaxPath: windows ? WINDOWS_LEGACY_MAX_PATH : null,
    legacyRemaining: windows
      ? WINDOWS_LEGACY_MAX_PATH - projectedMaximumPathLength
      : null,
    windowsExtendedMaxPath: windows ? WINDOWS_EXTENDED_MAX_PATH : null,
    windowsExtendedRemaining: windows
      ? WINDOWS_EXTENDED_MAX_PATH - projectedMaximumPathLength
      : null,
    longPathsRequired: windows && projectedMaximumPathLength >= WINDOWS_LEGACY_MAX_PATH,
    exceedsWindowsExtendedLimit,
    status: !windows
      ? "NOT_APPLICABLE"
      : (
          exceedsWindowsExtendedLimit
            ? "WINDOWS_EXTENDED_LIMIT_EXCEEDED"
            : (
                projectedMaximumPathLength >= WINDOWS_LEGACY_MAX_PATH
                  ? "LONG_PATHS_REQUIRED"
                  : "WITHIN_LEGACY_LIMIT"
              )
        ),
  });
}

export function assertGitControllerStoryPathBudget(storyRoot, options = {}) {
  const budget = diagnoseGitControllerStoryPathBudget(storyRoot, options);
  if (budget.exceedsWindowsExtendedLimit) {
    throw daemonError(
      "GIT_CONTROLLER_STORY_ROOT_PATH_BUDGET_EXCEEDED",
      "Controller story root leaves insufficient Windows extended-path budget for independent repository creation",
      {
        storyRootLength: budget.storyRootLength,
        creatingRepositoryPathLength: budget.creatingRepositoryPathLength,
        trackedRelativePathBudget: budget.trackedRelativePathBudget,
        projectedMaximumPathLength: budget.projectedMaximumPathLength,
        windowsExtendedMaxPath: budget.windowsExtendedMaxPath,
      },
    );
  }
  return budget;
}

function unixFileIdentity(stat) {
  return Object.freeze({
    dev: Number(stat.dev),
    ino: Number(stat.ino),
    mode: Number(stat.mode),
    nlink: Number(stat.nlink),
    uid: Number(stat.uid),
    gid: Number(stat.gid),
  });
}

function sameUnixFileIdentity(left, right) {
  return !!left
    && !!right
    && left.dev === right.dev
    && left.ino === right.ino
    && left.mode === right.mode
    && left.nlink === right.nlink
    && left.uid === right.uid
    && left.gid === right.gid;
}

function readUnixDaemonLock(lockPath, {
  expectedUid = typeof process.getuid === "function" ? process.getuid() : null,
} = {}) {
  let before;
  let bytes;
  let after;
  try {
    before = fs.lstatSync(lockPath);
    if (
      !before.isFile()
      || before.isSymbolicLink()
      || Number(before.nlink) !== 1
      || (Number(before.mode) & 0o077) !== 0
      || (
        Number.isSafeInteger(expectedUid)
        && Number(before.uid) !== expectedUid
      )
    ) {
      throw daemonError(
        "GIT_CONTROLLER_DAEMON_LOCK_UNSAFE",
        "Controller daemon singleton lock is not a protected regular file",
      );
    }
    bytes = fs.readFileSync(lockPath);
    after = fs.lstatSync(lockPath);
  } catch (error) {
    if (error instanceof GitControllerError) throw error;
    throw daemonError(
      "GIT_CONTROLLER_DAEMON_LOCK_UNVERIFIED",
      "Controller daemon singleton lock could not be verified",
      { cause: String(error?.code || "LOCK_READ_FAILED") },
      error,
    );
  }
  const beforeIdentity = unixFileIdentity(before);
  const afterIdentity = unixFileIdentity(after);
  if (
    !sameUnixFileIdentity(beforeIdentity, afterIdentity)
    || bytes.length < 2
    || bytes.length > 64 * 1024
  ) {
    throw daemonError(
      "GIT_CONTROLLER_DAEMON_LOCK_CHANGED",
      "Controller daemon singleton lock changed while it was inspected",
    );
  }
  let owner;
  try {
    owner = JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    throw daemonError(
      "GIT_CONTROLLER_DAEMON_LOCK_INVALID",
      "Controller daemon singleton lock owner record is invalid",
      {},
      error,
    );
  }
  if (
    owner?.schemaVersion !== 1
    || !/^[0-9a-f-]{36}$/i.test(String(owner.lockId || ""))
    || !Number.isSafeInteger(Number(owner.pid))
    || Number(owner.pid) <= 0
    || !isTrustedProcessStartIdentity(owner.processStartIdentity)
    || !String(owner.endpoint || "")
    || !String(owner.controllerIdentity || "")
  ) {
    throw daemonError(
      "GIT_CONTROLLER_DAEMON_LOCK_INVALID",
      "Controller daemon singleton lock owner identity is incomplete",
    );
  }
  return Object.freeze({
    owner: Object.freeze({ ...owner, pid: Number(owner.pid) }),
    identity: afterIdentity,
  });
}

function daemonLockOwnerState(owner, {
  pidAliveProbe = pidIsAlive,
  processIdentityProbe = processStartIdentity,
} = {}) {
  if (!pidAliveProbe(owner.pid)) return "STALE";
  const observed = String(processIdentityProbe(owner.pid) || "");
  if (
    isTrustedProcessStartIdentity(observed)
    && observed !== owner.processStartIdentity
  ) {
    return "STALE";
  }
  if (observed === owner.processStartIdentity) return "LIVE";
  return "UNVERIFIED";
}

function writeUnixDaemonLock(lockPath, owner) {
  const descriptor = fs.openSync(lockPath, "wx", 0o600);
  try {
    fs.writeFileSync(descriptor, `${JSON.stringify(owner)}\n`, { encoding: "utf8" });
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

export function acquireGitControllerDaemonInstanceLock(config, {
  platform = process.platform,
  ownerPid = process.pid,
  now = () => Date.now(),
  pidAliveProbe = pidIsAlive,
  processIdentityProbe = processStartIdentity,
  lockIdFactory = randomUUID,
} = {}) {
  if (platform === "win32") return null;
  const dataRoot = path.resolve(String(config?.dataRoot || ""));
  let rootStat;
  try {
    rootStat = fs.lstatSync(dataRoot);
  } catch (error) {
    throw daemonError(
      "GIT_CONTROLLER_DAEMON_LOCK_ROOT_INVALID",
      "Controller daemon singleton requires the prepared data root",
      { cause: String(error?.code || "DATA_ROOT_MISSING") },
      error,
    );
  }
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw daemonError(
      "GIT_CONTROLLER_DAEMON_LOCK_ROOT_INVALID",
      "Controller daemon singleton data root is not a plain directory",
    );
  }
  const processIdentity = String(processIdentityProbe(ownerPid) || "");
  if (!isTrustedProcessStartIdentity(processIdentity)) {
    throw daemonError(
      "GIT_CONTROLLER_DAEMON_PROCESS_IDENTITY_UNVERIFIED",
      "Controller daemon process start identity is unavailable",
      { pid: ownerPid },
    );
  }
  const lockPath = path.join(dataRoot, UNIX_DAEMON_INSTANCE_LOCK);
  const owner = Object.freeze({
    schemaVersion: 1,
    lockId: lockIdFactory(),
    pid: ownerPid,
    processStartIdentity: processIdentity,
    endpoint: String(config.endpoint || ""),
    controllerIdentity: String(config.controllerIdentity || ""),
    acquiredAt: now(),
  });
  let recoveredLockPath = null;

  const createLease = () => {
    writeUnixDaemonLock(lockPath, owner);
    const created = readUnixDaemonLock(lockPath);
    if (created.owner.lockId !== owner.lockId) {
      throw daemonError(
        "GIT_CONTROLLER_DAEMON_LOCK_CHANGED",
        "Controller daemon singleton lock owner changed during acquisition",
      );
    }
    let released = false;
    const release = () => {
      if (released) return { ok: true, replayed: true };
      released = true;
      process.off("exit", release);
      try {
        const current = readUnixDaemonLock(lockPath);
        if (current.owner.lockId !== owner.lockId) {
          return { ok: false, reason: "lock_owner_changed" };
        }
        fs.unlinkSync(lockPath);
        return { ok: true, replayed: false };
      } catch (error) {
        if (error?.code === "ENOENT") return { ok: true, replayed: false };
        return { ok: false, reason: String(error?.code || "lock_release_failed") };
      }
    };
    process.on("exit", release);
    return Object.freeze({
      lockPath,
      owner,
      recoveredLockPath,
      release,
    });
  };

  try {
    return createLease();
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
  }

  const existing = readUnixDaemonLock(lockPath);
  const existingState = daemonLockOwnerState(existing.owner, {
    pidAliveProbe,
    processIdentityProbe,
  });
  if (existingState === "LIVE") {
    throw daemonError(
      "GIT_CONTROLLER_DAEMON_ALREADY_RUNNING",
      "A live Git Controller daemon already owns the singleton lock",
      {
        ownerPid: existing.owner.pid,
        ownerProcessStartIdentity: existing.owner.processStartIdentity,
      },
    );
  }
  if (existingState !== "STALE") {
    throw daemonError(
      "GIT_CONTROLLER_DAEMON_LOCK_OWNER_UNVERIFIED",
      "Existing Git Controller daemon ownership cannot be proven stale",
      { ownerPid: existing.owner.pid },
    );
  }

  const takeoverPath = `${lockPath}.takeover`;
  const takeoverOwner = {
    ...owner,
    replacesLockId: existing.owner.lockId,
  };
  try {
    writeUnixDaemonLock(takeoverPath, takeoverOwner);
  } catch (error) {
    if (error?.code === "EEXIST") {
      throw daemonError(
        "GIT_CONTROLLER_DAEMON_TAKEOVER_BUSY",
        "Another Controller daemon is already recovering the stale singleton lock",
      );
    }
    throw error;
  }
  try {
    const current = readUnixDaemonLock(lockPath);
    if (
      current.owner.lockId !== existing.owner.lockId
      || !sameUnixFileIdentity(current.identity, existing.identity)
      || daemonLockOwnerState(current.owner, {
        pidAliveProbe,
        processIdentityProbe,
      }) !== "STALE"
    ) {
      throw daemonError(
        "GIT_CONTROLLER_DAEMON_LOCK_CHANGED",
        "Controller daemon singleton lock changed during stale-owner recovery",
      );
    }
    recoveredLockPath = `${lockPath}.stale.${now()}.${existing.owner.lockId}`;
    fs.renameSync(lockPath, recoveredLockPath);
    return createLease();
  } finally {
    try {
      const takeover = readUnixDaemonLock(takeoverPath);
      if (takeover.owner.lockId === owner.lockId) fs.unlinkSync(takeoverPath);
    } catch {}
  }
}

export function probeUnixControllerEndpoint(endpoint, {
  timeoutMs = UNIX_ENDPOINT_PROBE_TIMEOUT_MS,
  connector = net.createConnection,
} = {}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let socket;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket?.removeAllListeners();
      socket?.destroy();
      callback(value);
    };
    const timer = setTimeout(() => {
      finish(reject, daemonError(
        "GIT_CONTROLLER_ENDPOINT_LIVENESS_UNVERIFIED",
        "Timed out while probing the existing Controller endpoint",
      ));
    }, Math.max(100, Number(timeoutMs) || UNIX_ENDPOINT_PROBE_TIMEOUT_MS));
    timer.unref?.();
    try {
      socket = connector({ path: endpoint });
      socket.once("connect", () => finish(resolve, { live: true }));
      socket.once("error", (error) => {
        if (["ECONNREFUSED", "ENOENT"].includes(error?.code)) {
          finish(resolve, { live: false, reason: error.code });
          return;
        }
        finish(reject, daemonError(
          "GIT_CONTROLLER_ENDPOINT_LIVENESS_UNVERIFIED",
          "Existing Controller endpoint liveness could not be verified",
          { cause: String(error?.code || "ENDPOINT_PROBE_FAILED") },
          error,
        ));
      });
    } catch (error) {
      finish(reject, daemonError(
        "GIT_CONTROLLER_ENDPOINT_LIVENESS_UNVERIFIED",
        "Existing Controller endpoint liveness probe could not start",
        { cause: String(error?.code || "ENDPOINT_PROBE_FAILED") },
        error,
      ));
    }
  });
}

export async function assertGitControllerDaemonEndpointAvailable(config, {
  platform = process.platform,
  endpointProbe = probeUnixControllerEndpoint,
} = {}) {
  if (platform === "win32" || !fs.existsSync(config.endpoint)) {
    return { status: "AVAILABLE" };
  }
  const before = fs.lstatSync(config.endpoint);
  if (!before.isSocket() || before.isSymbolicLink()) {
    throw daemonError(
      "GIT_CONTROLLER_ENDPOINT_OCCUPIED",
      "Refusing to start while a non-socket Controller endpoint exists",
    );
  }
  const beforeIdentity = unixFileIdentity(before);
  const probe = await endpointProbe(config.endpoint);
  if (probe?.live !== false) {
    throw daemonError(
      "GIT_CONTROLLER_ENDPOINT_LIVE",
      "A live process is already listening on the Controller endpoint",
    );
  }
  if (!fs.existsSync(config.endpoint)) return { status: "AVAILABLE" };
  const after = fs.lstatSync(config.endpoint);
  const afterIdentity = unixFileIdentity(after);
  if (
    !after.isSocket()
    || after.isSymbolicLink()
    || !sameUnixFileIdentity(beforeIdentity, afterIdentity)
  ) {
    throw daemonError(
      "GIT_CONTROLLER_ENDPOINT_CHANGED",
      "Controller endpoint changed while startup liveness was verified",
    );
  }
  return {
    status: "STALE",
    identity: afterIdentity,
  };
}

function readJson(filePath, label) {
  try {
    return JSON.parse(readProtectedFile(filePath, { label }).toString("utf8"));
  } catch (error) {
    if (error instanceof GitControllerError) throw error;
    throw daemonError(
      "GIT_CONTROLLER_DAEMON_CONFIG_INVALID",
      `${label} is not valid JSON`,
      {},
      error,
    );
  }
}

export function attestGitControllerDeploymentFile({
  filePath,
  expectedSha256,
  expectedAclSha256,
  executable = false,
  secret = false,
  label = executable ? "Controller executable" : "Controller deployment file",
  driftCode = executable ? "GIT_CONTROLLER_EXECUTABLE_DRIFT" : "GIT_CONTROLLER_DEPLOYMENT_FILE_DRIFT",
  allowedOwnerIdentity = "",
  platform = process.platform,
} = {}) {
  const content = readProtectedFile(filePath, {
    label,
    secret,
    platform,
  });
  const resolved = path.resolve(String(filePath || "").trim());
  const stat = fs.lstatSync(resolved);
  if (
    !stat.isFile()
    || stat.isSymbolicLink()
    || Number(stat.nlink || 1) !== 1
    || (executable && platform !== "win32" && (stat.mode & 0o111) === 0)
  ) {
    throw daemonError(
      "GIT_CONTROLLER_DEPLOYMENT_FILE_UNSAFE",
      "Pinned Controller deployment file is not a single regular file",
    );
  }
  const contentSha256 = createHash("sha256").update(content).digest("hex");
  if (contentSha256 !== String(expectedSha256 || "").toLowerCase()) {
    throw daemonError(
      driftCode,
      "Pinned Controller deployment file content fingerprint has drifted",
    );
  }
  let aclDescriptor;
  if (platform === "win32") {
    const encoded = Buffer.from(resolved, "utf8").toString("base64");
    const allowedWriterSid = String(allowedOwnerIdentity || "")
      .replace(/^sid:/i, "")
      .toUpperCase();
    const allowedWriterSidEncoded = Buffer.from(allowedWriterSid, "utf8").toString("base64");
    const secretLiteral = secret ? "$true" : "$false";
    const script = [
      "$ErrorActionPreference='Stop'",
      `$target=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}'))`,
      `$allowed=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${allowedWriterSidEncoded}'))`,
      `$secret=${secretLiteral}`,
      " $priv=@('S-1-5-18','S-1-5-32-544','S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464',$allowed)|Where-Object{$_}",
      "$paths=@($target)",
      "$parent=[IO.Directory]::GetParent($target)",
      "while($null -ne $parent){$paths+=@($parent.FullName);$parent=$parent.Parent}",
      "$descriptors=@()",
      "foreach($candidate in $paths){",
      " $acl=Get-Acl -LiteralPath $candidate",
      " $sddl=$acl.GetSecurityDescriptorSddlForm([Security.AccessControl.AccessControlSections]'Owner,Group,Access')",
      " $owner=try{$acl.Owner.Translate([Security.Principal.SecurityIdentifier]).Value.ToUpperInvariant()}catch{([Security.Principal.NTAccount]$acl.Owner).Translate([Security.Principal.SecurityIdentifier]).Value.ToUpperInvariant()}",
      " if($priv -notcontains $owner){throw 'deployment path has non-privileged owner'}",
      " $unsafe=@($acl.Access|Where-Object{",
      "  $sid=try{$_.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value.ToUpperInvariant()}catch{$_.IdentityReference.Value.ToUpperInvariant()}",
      "  $rights=$_.FileSystemRights.ToString()",
      "  $allow=$_.AccessControlType.ToString() -eq 'Allow'",
      "  $write=$allow -and $rights -match 'Write|Modify|FullControl|Create|Delete|ChangePermissions|TakeOwnership'",
      "  $readSecret=$secret -and $candidate -eq $target -and $allow -and $rights -match 'Read|Execute|Modify|FullControl'",
      "  ($write -or $readSecret) -and $priv -notcontains $sid",
      " })",
      " if($unsafe.Count -gt 0){throw 'deployment path has non-privileged writer'}",
      " $descriptors+=@($candidate+'='+$sddl)",
      "}",
      "$descriptors -join \"`n\"",
    ].join(";");
    aclDescriptor = execFileSync(
      WINDOWS_POWERSHELL,
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
      { encoding: "utf8", windowsHide: true, timeout: 15_000, maxBuffer: 128 * 1024 },
    ).trim();
  } else {
    const allowedUid = /^uid:[0-9]+$/.test(String(allowedOwnerIdentity || ""))
      ? Number(String(allowedOwnerIdentity).slice(4))
      : null;
    const allowedOwners = new Set([0, ...(allowedUid == null ? [] : [allowedUid])]);
    const segments = [];
    let current = path.dirname(resolved);
    while (true) {
      const parent = fs.statSync(current);
      if (!allowedOwners.has(parent.uid) || (parent.mode & 0o022) !== 0) {
        throw daemonError(
          "GIT_CONTROLLER_DEPLOYMENT_FILE_UNSAFE",
          "Unix deployment file parent chain has an unapproved owner or writer",
        );
      }
      segments.push(`${current}:${parent.uid}:${(parent.mode & 0o777).toString(8)}`);
      const next = path.dirname(current);
      if (next === current) break;
      current = next;
    }
    if (
      !allowedOwners.has(stat.uid)
      || (stat.mode & 0o022) !== 0
      || (secret && (allowedUid == null || stat.uid !== allowedUid || (stat.mode & 0o077) !== 0))
    ) {
      throw daemonError(
        "GIT_CONTROLLER_DEPLOYMENT_FILE_UNSAFE",
        "Unix deployment file has an unapproved owner or access mode",
      );
    }
    aclDescriptor = `unix:${stat.uid}:${(stat.mode & 0o777).toString(8)}:${segments.join("|")}`;
  }
  const aclSha256 = createHash("sha256").update(aclDescriptor).digest("hex");
  if (aclSha256 !== String(expectedAclSha256 || "").toLowerCase()) {
    throw daemonError(
      "GIT_CONTROLLER_DEPLOYMENT_FILE_ACL_DRIFT",
      "Pinned Controller deployment file ACL fingerprint has drifted",
    );
  }
  return { path: resolved, contentSha256, aclSha256, aclDescriptor };
}

function parseGuardianEnvelope(output, prefix, code, message) {
  const lines = String(output || "").trim().split(/\r?\n/).filter(Boolean);
  try {
    if (lines.length !== 1 || !lines[0].startsWith(prefix)) {
      throw new Error("invalid-envelope");
    }
    return JSON.parse(Buffer.from(
      lines[0].slice(prefix.length),
      "base64url",
    ).toString("utf8"));
  } catch (error) {
    throw daemonError(code, message, {}, error);
  }
}

function currentTime(clock) {
  const value = typeof clock === "function" ? clock() : clock;
  return Number.isSafeInteger(Number(value)) ? Number(value) : Date.now();
}

export function validateGitControllerProcessTreeAttestation(envelope, options = {}) {
  const verified = verifyGitProcessContainmentReceiptEnvelope(envelope, options);
  return Object.freeze({
    ...verified.receipt,
    guardianSignature: verified.signature,
  });
}

function isVerifiedGitProcessContainmentSession(value) {
  return !!(
    value
    && value[GIT_PROCESS_CONTAINMENT_SESSION] === true
    && value.isolationLevel === "STRONG"
    && typeof value.refresh === "function"
    && typeof value.publicEvidence === "function"
    && typeof value.proveEmpty === "function"
  );
}

export function attestGitControllerProcessTreeContainment({
  descriptor,
  controllerIdentity,
  gitBinarySha256,
  daemonInstanceId = randomUUID(),
  platform = process.platform,
  ownerPid = process.pid,
  ownerProcessStartIdentity = processStartIdentity(ownerPid),
  now = () => Date.now(),
  challenge = randomBytes(24).toString("hex"),
  runner = execFileSync,
  fileAttestor = attestGitControllerDeploymentFile,
  publicKeyReader = readProtectedFile,
} = {}) {
  const expectedMode = GIT_PROCESS_CONTAINMENT_MODES[platform];
  const allowedDescriptorFields = new Set([
    "schemaVersion",
    "mode",
    "guardianPath",
    "guardianSha256",
    "guardianAclSha256",
    "guardianPublicKeyPath",
    "guardianKeyId",
    "containerPolicyId",
    "policyDigest",
  ]);
  if (
    !expectedMode
    || !descriptor
    || typeof descriptor !== "object"
    || Array.isArray(descriptor)
    || Object.keys(descriptor).some((key) => !allowedDescriptorFields.has(key))
    || [...allowedDescriptorFields].some((key) => !Object.hasOwn(descriptor, key))
    || Number(descriptor.schemaVersion) !== 2
    || descriptor.mode !== expectedMode
    || !/^[0-9a-f]{64}$/.test(String(descriptor.guardianSha256 || ""))
    || !/^[0-9a-f]{64}$/.test(String(descriptor.guardianAclSha256 || ""))
    || !/^[0-9a-f]{64}$/.test(String(descriptor.guardianKeyId || ""))
    || !/^[0-9a-f]{64}$/.test(String(descriptor.policyDigest || ""))
    || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/.test(
      String(descriptor.containerPolicyId || ""),
    )
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      String(daemonInstanceId || ""),
    )
    || !isTrustedProcessStartIdentity(ownerProcessStartIdentity)
  ) {
    throw daemonError(
      "GIT_CONTROLLER_PROCESS_TREE_CONTAINMENT_REQUIRED",
      "Controller daemon requires a protected native guardian trust policy",
    );
  }
  const guardian = fileAttestor({
    filePath: descriptor.guardianPath,
    expectedSha256: descriptor.guardianSha256,
    expectedAclSha256: descriptor.guardianAclSha256,
    executable: true,
    label: "Git process-tree native guardian",
    driftCode: "GIT_CONTROLLER_PROCESS_TREE_GUARDIAN_DRIFT",
    platform,
  });
  let guardianPublicKey;
  try {
    guardianPublicKey = createPublicKey(publicKeyReader(
      descriptor.guardianPublicKeyPath,
      { label: "Git process-tree guardian public key", platform },
    ));
  } catch (error) {
    throw daemonError(
      "GIT_CONTROLLER_PROCESS_TREE_GUARDIAN_KEY_INVALID",
      "Native guardian public key is unavailable or invalid",
      {},
      error,
    );
  }
  const guardianKeyId = publicKeyFingerprint(
    guardianPublicKey.export({ type: "spki", format: "der" }),
  );
  if (guardianKeyId !== descriptor.guardianKeyId) {
    throw daemonError(
      "GIT_CONTROLLER_PROCESS_TREE_GUARDIAN_KEY_DRIFT",
      "Native guardian public key does not match the pinned key id",
    );
  }

  let current = null;
  const runChallenge = ({
    attestationChallenge = randomBytes(24).toString("hex"),
    expectedContainerEpoch = current?.receipt?.containerEpoch,
    expectedGuardianInstanceId = current?.receipt?.guardianInstanceId,
  } = {}) => {
    let output;
    try {
      output = runner(
        guardian.path,
        [
          "--devbench-attest-git-process-tree-v2",
          daemonInstanceId,
          String(ownerPid),
          ownerProcessStartIdentity,
          attestationChallenge,
          gitBinarySha256,
          descriptor.policyDigest,
          descriptor.containerPolicyId,
          descriptor.guardianKeyId,
        ],
        {
          encoding: "utf8",
          windowsHide: true,
          timeout: 5_000,
          maxBuffer: 64 * 1024,
        },
      );
    } catch (error) {
      throw daemonError(
        "GIT_CONTROLLER_PROCESS_TREE_ATTESTATION_FAILED",
        "Native process-tree guardian challenge failed",
        {},
        error,
      );
    }
    const envelope = parseGuardianEnvelope(
      output,
      GIT_PROCESS_CONTAINMENT_ATTESTATION_PREFIX,
      "GIT_CONTROLLER_PROCESS_TREE_ATTESTATION_INVALID",
      "Native process-tree guardian returned an invalid receipt envelope",
    );
    return verifyGitProcessContainmentReceiptEnvelope(envelope, {
      publicKey: guardianPublicKey,
      platform,
      mode: expectedMode,
      daemonInstanceId,
      ownerPid,
      ownerProcessStartIdentity,
      controllerIdentity,
      challenge: attestationChallenge,
      containerPolicyId: descriptor.containerPolicyId,
      containerEpoch: expectedContainerEpoch,
      policyDigest: descriptor.policyDigest,
      guardianKeyId: descriptor.guardianKeyId,
      guardianBinarySha256: guardian.contentSha256,
      gitBinarySha256,
      guardianInstanceId: expectedGuardianInstanceId,
      now: currentTime(now),
    });
  };
  current = runChallenge({
    attestationChallenge: challenge,
    expectedContainerEpoch: null,
    expectedGuardianInstanceId: null,
  });

  const session = {
    [GIT_PROCESS_CONTAINMENT_SESSION]: true,
    isolationLevel: "STRONG",
    get schemaVersion() {
      return 2;
    },
    get daemonInstanceId() {
      return current.receipt.daemonInstanceId;
    },
    get platform() {
      return current.receipt.platform;
    },
    get mode() {
      return current.receipt.mode;
    },
    get containerPolicyId() {
      return current.receipt.containerPolicyId;
    },
    get containerEpoch() {
      return current.receipt.containerEpoch;
    },
    get policyDigest() {
      return current.receipt.policyDigest;
    },
    get guardianKeyId() {
      return current.receipt.guardianKeyId;
    },
    get guardianInstanceId() {
      return current.receipt.guardianInstanceId;
    },
    get issuedAt() {
      return current.receipt.issuedAt;
    },
    get expiresAt() {
      return current.receipt.expiresAt;
    },
    refresh({ attestationChallenge = randomBytes(24).toString("hex") } = {}) {
      current = runChallenge({ attestationChallenge });
      return session;
    },
    publicEvidence({ attestationChallenge } = {}) {
      if (
        attestationChallenge
        && current.receipt.challenge !== attestationChallenge
      ) {
        session.refresh({ attestationChallenge });
      }
      return Object.freeze({
        isolationLevel: "STRONG",
        receipt: current.receipt,
        signature: current.signature,
      });
    },
    proveEmpty({ containerEpoch: priorContainerEpoch } = {}) {
      const prior = String(priorContainerEpoch || "");
      if (
        !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/.test(prior)
        || prior === current.receipt.containerEpoch
      ) {
        throw daemonError(
          "GIT_CONTROLLER_PROCESS_TREE_RECOVERY_IDENTITY_INVALID",
          "Recovery must target a prior native process-tree container epoch",
        );
      }
      const recoveryChallenge = randomBytes(24).toString("hex");
      let output;
      try {
        output = runner(
          guardian.path,
          [
            "--devbench-seal-and-prove-git-process-tree-empty-v2",
            daemonInstanceId,
            current.receipt.containerEpoch,
            prior,
            recoveryChallenge,
            descriptor.policyDigest,
            descriptor.containerPolicyId,
            descriptor.guardianKeyId,
            gitBinarySha256,
          ],
          {
            encoding: "utf8",
            windowsHide: true,
            timeout: 15_000,
            maxBuffer: 64 * 1024,
          },
        );
      } catch (error) {
        throw daemonError(
          "GIT_CONTROLLER_PROCESS_TREE_RECOVERY_FAILED",
          "Native guardian could not seal and empty the prior process tree",
          {},
          error,
        );
      }
      const envelope = parseGuardianEnvelope(
        output,
        GIT_PROCESS_CONTAINMENT_EMPTY_PREFIX,
        "GIT_CONTROLLER_PROCESS_TREE_RECOVERY_INVALID",
        "Native guardian returned an invalid recovery receipt envelope",
      );
      const verified = verifyGitProcessTreeRecoveryReceiptEnvelope(envelope, {
        publicKey: guardianPublicKey,
        platform,
        mode: expectedMode,
        daemonInstanceId,
        challenge: recoveryChallenge,
        containerPolicyId: descriptor.containerPolicyId,
        currentContainerEpoch: current.receipt.containerEpoch,
        priorContainerEpoch: prior,
        policyDigest: descriptor.policyDigest,
        guardianKeyId: descriptor.guardianKeyId,
        guardianInstanceId: current.receipt.guardianInstanceId,
        guardianBinarySha256: guardian.contentSha256,
        gitBinarySha256,
        now: currentTime(now),
      });
      return Object.freeze({
        ok: true,
        schemaVersion: 2,
        platform,
        mode: expectedMode,
        containerPolicyId: descriptor.containerPolicyId,
        containerEpoch: prior,
        currentContainerEpoch: current.receipt.containerEpoch,
        containerSealed: true,
        containerClosed: true,
        activeProcessCount: 0,
        tombstoneId: verified.receipt.tombstoneId,
        issuedAt: verified.receipt.issuedAt,
        guardianReceipt: verified,
      });
    },
  };
  return Object.freeze(session);
}

export function validateUnixIpcIdentityPolicy({
  controllerIdentity,
  gatewayIdentities = [],
  humanManagerIdentities = [],
  workerIdentities = {},
  ipcGid,
  groupsForUid,
} = {}) {
  if (!Number.isSafeInteger(ipcGid) || ipcGid < 0 || typeof groupsForUid !== "function") {
    throw daemonError(
      "GIT_CONTROLLER_IPC_GROUP_REQUIRED",
      "Unix Controller IPC requires a numeric ipcGid and live group membership resolver",
    );
  }
  const controllerUid = String(controllerIdentity || "").replace(/^uid:/, "");
  const required = [
    controllerIdentity,
    ...gatewayIdentities,
    ...humanManagerIdentities,
  ].map((identity) => String(identity || "").replace(/^uid:/, ""));
  const workers = Object.values(workerIdentities)
    .map((identity) => String(identity || "").replace(/^uid:/, ""));
  if (
    !/^[0-9]+$/.test(controllerUid)
    || required.some((uid) => !/^[0-9]+$/.test(uid))
    || workers.some((uid) => !/^[0-9]+$/.test(uid))
    || required.some((uid) => !groupsForUid(uid).includes(ipcGid))
    || workers.some((uid) => groupsForUid(uid).includes(ipcGid))
  ) {
    throw daemonError(
      "GIT_CONTROLLER_IPC_GROUP_UNSAFE",
      "IPC group must include Controller, Gateway, and managers, and exclude every Worker",
    );
  }
  return { ipcGid, requiredUids: required, excludedWorkerUids: workers };
}

function createCredentialDescriptorPolicy(rawDescriptors, controllerIdentity) {
  const pins = new Map();
  const descriptors = {};
  for (const [credentialRef, rawDescriptor] of Object.entries(rawDescriptors || {})) {
    if (
      !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(credentialRef)
      || !rawDescriptor
      || typeof rawDescriptor !== "object"
      || Array.isArray(rawDescriptor)
    ) {
      throw daemonError(
        "GIT_CONTROLLER_SSH_DESCRIPTOR_INVALID",
        "Protected SSH credential descriptor is invalid",
      );
    }
    const pin = Object.freeze({
      sshBinaryPath: rawDescriptor.sshBinaryPath,
      sshBinarySha256: rawDescriptor.sshBinarySha256,
      sshBinaryAclSha256: rawDescriptor.sshBinaryAclSha256,
      privateKeyPath: rawDescriptor.privateKeyPath,
      privateKeySha256: rawDescriptor.privateKeySha256,
      privateKeyAclSha256: rawDescriptor.privateKeyAclSha256,
      knownHostsPath: rawDescriptor.knownHostsPath,
      knownHostsSha256: rawDescriptor.knownHostsSha256,
      knownHostsAclSha256: rawDescriptor.knownHostsAclSha256,
    });
    for (const field of [
      "sshBinarySha256",
      "sshBinaryAclSha256",
      "privateKeySha256",
      "privateKeyAclSha256",
      "knownHostsSha256",
      "knownHostsAclSha256",
    ]) {
      if (!/^[0-9a-f]{64}$/.test(String(pin[field] || "").trim().toLowerCase())) {
        throw daemonError(
          "GIT_CONTROLLER_SSH_DESCRIPTOR_ATTESTATION_REQUIRED",
          "Protected SSH descriptor requires content and ACL SHA256 pins",
          { credentialRef },
        );
      }
    }
    pins.set(credentialRef, pin);
  }
  const attest = (credentialRef) => {
    const pin = pins.get(String(credentialRef || ""));
    if (!pin) {
      throw daemonError(
        "GIT_CONTROLLER_SSH_DESCRIPTOR_MISSING",
        "Repository credentialRef has no protected SSH descriptor",
        { credentialRef: String(credentialRef || "") },
      );
    }
    const ssh = attestGitControllerDeploymentFile({
      filePath: pin.sshBinaryPath,
      expectedSha256: pin.sshBinarySha256,
      expectedAclSha256: pin.sshBinaryAclSha256,
      executable: true,
      label: "SSH executable",
      driftCode: "GIT_CONTROLLER_SSH_DESCRIPTOR_DRIFT",
      allowedOwnerIdentity: controllerIdentity,
    });
    const privateKey = attestGitControllerDeploymentFile({
      filePath: pin.privateKeyPath,
      expectedSha256: pin.privateKeySha256,
      expectedAclSha256: pin.privateKeyAclSha256,
      secret: true,
      label: "SSH private key",
      driftCode: "GIT_CONTROLLER_SSH_DESCRIPTOR_DRIFT",
      allowedOwnerIdentity: controllerIdentity,
    });
    const knownHosts = attestGitControllerDeploymentFile({
      filePath: pin.knownHostsPath,
      expectedSha256: pin.knownHostsSha256,
      expectedAclSha256: pin.knownHostsAclSha256,
      label: "SSH known_hosts",
      driftCode: "GIT_CONTROLLER_SSH_DESCRIPTOR_DRIFT",
      allowedOwnerIdentity: controllerIdentity,
    });
    descriptors[credentialRef] = Object.freeze({
      sshBinaryPath: ssh.path,
      privateKeyPath: privateKey.path,
      knownHostsPath: knownHosts.path,
    });
    return descriptors[credentialRef];
  };
  for (const credentialRef of pins.keys()) attest(credentialRef);
  return Object.freeze({
    descriptors: Object.freeze({ ...descriptors }),
    attest,
    refs: Object.freeze([...pins.keys()].sort()),
  });
}

export function readGitControllerDaemonConfig({
  configPath = process.env.DEVBENCH_GIT_CONTROLLER_DAEMON_CONFIG,
  controllerIdentity = currentProcessIdentity(),
} = {}) {
  const sourcePath = String(configPath || "").trim();
  if (!sourcePath) {
    throw daemonError(
      "GIT_CONTROLLER_DAEMON_CONFIG_REQUIRED",
      "Independent Controller daemon requires a protected configuration",
    );
  }
  const raw = readJson(sourcePath, "Git Controller daemon configuration");
  const gitBinaryAttestation = attestGitControllerDeploymentFile({
    filePath: raw.gitBinaryPath,
    expectedSha256: raw.gitBinarySha256,
    expectedAclSha256: raw.gitBinaryAclSha256,
    executable: true,
  });
  const knownHostsAttestation = attestGitControllerDeploymentFile({
    filePath: raw.knownHostsPath,
    expectedSha256: raw.knownHostsSha256,
    expectedAclSha256: raw.knownHostsAclSha256,
    label: "Git fallback known_hosts",
    driftCode: "GIT_CONTROLLER_KNOWN_HOSTS_DRIFT",
  });
  const endpoint = validateControllerEndpoint(raw.endpoint);
  const expectedOwnIdentity = String(raw.expectedOwnIdentity || "").trim();
  const endpointAclFingerprint = String(raw.endpointAclFingerprint || "")
    .trim()
    .toLowerCase();
  if (!expectedOwnIdentity || expectedOwnIdentity !== controllerIdentity) {
    throw daemonError(
      "GIT_CONTROLLER_DAEMON_IDENTITY_MISMATCH",
      "Controller daemon OS identity does not match its deployment policy",
    );
  }
  if (!/^[0-9a-f]{64}$/.test(endpointAclFingerprint)) {
    throw daemonError(
      "GIT_CONTROLLER_ENDPOINT_ACL_ATTESTATION_REQUIRED",
      "Controller daemon requires an administrator-pinned endpoint ACL fingerprint",
    );
  }
  const gitProcessContainment = attestGitControllerProcessTreeContainment({
    descriptor: raw.gitProcessContainment,
    controllerIdentity,
    gitBinarySha256: gitBinaryAttestation.contentSha256,
  });
  const credentialPolicy = createCredentialDescriptorPolicy(
    raw.credentialDescriptors,
    controllerIdentity,
  );
  const dataRoot = path.resolve(String(raw.dataRoot || ""));
  if (!path.isAbsolute(String(raw.dataRoot || "")) || !String(raw.dataRoot || "").trim()) {
    throw daemonError(
      "GIT_CONTROLLER_DATA_ROOT_INVALID",
      "Controller daemon data root must use an absolute protected path",
    );
  }
  const dataRootAclSha256 = String(raw.dataRootAclSha256 || "").trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(dataRootAclSha256)) {
    throw daemonError(
      "GIT_CONTROLLER_DATA_ROOT_ACL_ATTESTATION_REQUIRED",
      "Controller daemon requires a pinned data-root ACL fingerprint",
    );
  }
  const registryRaw = readJson(
    raw.registryPath,
    "Git Controller fixed repository registry",
  );
  const definitions = Array.isArray(registryRaw)
    ? registryRaw
    : registryRaw?.definitions;
  if (!Array.isArray(definitions) || !definitions.length) {
    throw daemonError(
      "GIT_CONTROLLER_FIXED_REGISTRY_REQUIRED",
      "Controller daemon requires a non-empty protected fixed repository registry",
    );
  }
  const credentialRefs = new Set(credentialPolicy.refs);
  for (const definition of definitions) {
    const expectedUrls = Array.isArray(definition?.expectedRemoteUrls)
      ? definition.expectedRemoteUrls
      : [];
    const requiresSsh = expectedUrls.some((remoteUrl) => (
      canonicalRemoteIdentity(remoteUrl).startsWith("ssh:")
    ));
    const credentialRef = String(definition?.credentialRef || "").trim();
    if (
      (requiresSsh && !credentialRef)
      || (credentialRef && !credentialRefs.has(credentialRef))
    ) {
      throw daemonError(
        "GIT_CONTROLLER_SSH_DESCRIPTOR_BINDING_INVALID",
        "Protected repository definition has no matching credentialRef descriptor",
        {
          logicalDefinitionId: String(
            definition?.logicalDefinitionId
            || definition?.definitionId
            || definition?.id
            || "",
          ),
        },
      );
    }
  }
  const workerPolicy = readJson(
    raw.workerIdentityPolicyPath,
    "Git Controller worker identity policy",
  );
  const workerIdentities = workerPolicy?.expectedIdentity;
  if (!workerIdentities || typeof workerIdentities !== "object" || Array.isArray(workerIdentities)) {
    throw daemonError(
      "GIT_CONTROLLER_WORKER_IDENTITY_POLICY_REQUIRED",
      "Controller requires a protected per-story Worker identity policy",
    );
  }
  const workerIdentitySet = new Set();
  for (const [storyId, identityValue] of Object.entries(workerIdentities)) {
    const identity = String(identityValue || "").trim().toLowerCase();
    const valid = process.platform === "win32"
      ? /^sid:s-\d(?:-\d+)+$/.test(identity)
      : /^uid:[0-9]+$/.test(identity);
    if (
      !storyId
      || !valid
      || identity === controllerIdentity.toLowerCase()
      || workerIdentitySet.has(identity)
    ) {
      throw daemonError(
        "GIT_CONTROLLER_WORKER_IDENTITY_POLICY_INVALID",
        "Each story must map to a unique Worker identity distinct from Controller",
      );
    }
    workerIdentitySet.add(identity);
  }
  const normalizePolicyIdentity = (value) => String(value || "").trim().toLowerCase();
  const identityValid = (identity) => (
    process.platform === "win32"
      ? /^sid:s-\d(?:-\d+)+$/.test(identity)
      : /^uid:[0-9]+$/.test(identity)
  );
  const gatewayIdentities = [...new Set(
    (Array.isArray(raw.gatewayIdentities) ? raw.gatewayIdentities : [])
      .map(normalizePolicyIdentity),
  )];
  const humanManagerIdentities = [...new Set(
    (Array.isArray(raw.humanManagerIdentities) ? raw.humanManagerIdentities : [])
      .map(normalizePolicyIdentity),
  )];
  if (
    !gatewayIdentities.length
    || !humanManagerIdentities.length
    || [...gatewayIdentities, ...humanManagerIdentities].some((identity) => (
      !identityValid(identity)
      || identity === controllerIdentity.toLowerCase()
      || workerIdentitySet.has(identity)
    ))
    || gatewayIdentities.some((identity) => humanManagerIdentities.includes(identity))
  ) {
    throw daemonError(
      "GIT_CONTROLLER_STORY_IDENTITY_ALLOWLIST_INVALID",
      "Story ACL policy requires distinct Controller, Gateway RX, human-manager, and Worker identities",
    );
  }
  const ipcGid = raw.ipcGid;
  if (
    process.platform !== "win32"
    && (!Number.isSafeInteger(ipcGid) || ipcGid < 0)
  ) {
    throw daemonError(
      "GIT_CONTROLLER_IPC_GROUP_REQUIRED",
      "Unix Controller IPC requires a protected numeric ipcGid shared only by Controller, Gateway, and managers",
    );
  }
  if (process.platform !== "win32") {
    const idBinary = ["/usr/bin/id", "/bin/id"].find((candidate) => fs.existsSync(candidate));
    if (!idBinary) {
      throw daemonError(
        "GIT_CONTROLLER_IPC_GROUP_UNVERIFIED",
        "Unix Controller requires an absolute trusted id executable for IPC group attestation",
      );
    }
    validateUnixIpcIdentityPolicy({
      controllerIdentity,
      gatewayIdentities,
      humanManagerIdentities,
      workerIdentities,
      ipcGid,
      groupsForUid(uid) {
        return execFileSync(idBinary, ["-G", uid], {
          encoding: "utf8",
          timeout: 5_000,
        }).trim().split(/\s+/).map(Number);
      },
    });
  }
  const storyRoot = path.resolve(String(raw.storyRoot || ""));
  const storyRootAclSha256 = String(raw.storyRootAclSha256 || "").trim().toLowerCase();
  if (
    !path.isAbsolute(String(raw.storyRoot || ""))
    || !String(raw.storyRoot || "").trim()
    || !/^[0-9a-f]{64}$/.test(storyRootAclSha256)
  ) {
    throw daemonError(
      "GIT_CONTROLLER_STORY_ROOT_INVALID",
      "Controller daemon requires an absolute story root and pinned ACL fingerprint",
    );
  }
  const storyPathBudget = assertGitControllerStoryPathBudget(storyRoot);
  const inside = (root, candidate) => {
    const relative = path.relative(path.resolve(root), path.resolve(candidate));
    return relative === "" || (
      relative !== ".."
      && !relative.startsWith(`..${path.sep}`)
      && !path.isAbsolute(relative)
    );
  };
  if (
    inside(dataRoot, storyRoot)
    || inside(storyRoot, dataRoot)
    || definitions.some((definition) => (
      inside(definition.basePath, storyRoot) || inside(storyRoot, definition.basePath)
    ))
  ) {
    throw daemonError(
      "GIT_CONTROLLER_STORY_ROOT_OVERLAP",
      "Controller story root must be separate from data root and every base repository",
    );
  }
  const workerSecretRootInputs = (Array.isArray(raw.workerSecretRoots)
    ? raw.workerSecretRoots
    : [])
    .map((value) => String(value || "").trim())
    .filter(Boolean);
  const workerSecretRoots = [...new Set(
    workerSecretRootInputs.map((value) => path.resolve(value)),
  )];
  if (
    workerSecretRoots.length === 0
    || workerSecretRootInputs.some((value) => !path.isAbsolute(value))
    || workerSecretRoots.some((value) => (
      inside(storyRoot, value)
      || inside(value, storyRoot)
    ))
  ) {
    throw daemonError(
      "GIT_CONTROLLER_WORKER_SECRET_ROOTS_INVALID",
      "Controller daemon requires protected absolute Worker secret roots outside the story root",
    );
  }
  const privateKey = createPrivateKey(readProtectedFile(raw.serverPrivateKeyPath, {
    label: "Git Controller signing private key",
    secret: true,
  }));
  const publicKey = createPublicKey(privateKey);
  const keyFingerprint = publicKeyFingerprint(
    publicKey.export({ type: "spki", format: "der" }),
  );
  if (
    raw.serverPublicKeySha256
    && String(raw.serverPublicKeySha256).toLowerCase() !== keyFingerprint
  ) {
    throw daemonError(
      "GIT_CONTROLLER_DAEMON_KEY_DRIFT",
      "Controller daemon signing key does not match deployment fingerprint",
    );
  }
  const clients = new Map();
  for (const [clientId, descriptor] of Object.entries(raw.clients || {})) {
    const secret = readProtectedFile(descriptor?.secretPath, {
      label: `Git Controller client secret (${clientId})`,
      secret: true,
    });
    if (secret.length < 32) {
      throw daemonError(
        "GIT_CONTROLLER_CLIENT_SECRET_WEAK",
        "Controller client authentication secret must contain at least 32 bytes",
        { clientId },
      );
    }
    const expectedIdentity = normalizePolicyIdentity(descriptor?.expectedIdentity);
    if (
      !identityValid(expectedIdentity)
      || ![...gatewayIdentities, ...humanManagerIdentities].includes(expectedIdentity)
    ) {
      throw daemonError(
        "GIT_CONTROLLER_CLIENT_IDENTITY_INVALID",
        "Each Controller client must bind its secret to an allowlisted OS identity",
        { clientId },
      );
    }
    clients.set(clientId, Object.freeze({ secret, expectedIdentity }));
  }
  if (!clients.size) {
    throw daemonError(
      "GIT_CONTROLLER_CLIENTS_REQUIRED",
      "Controller daemon must configure at least one authenticated client",
    );
  }
  return Object.freeze({
    configPath: path.resolve(sourcePath),
    endpoint,
    gitBinaryPath: gitBinaryAttestation.path,
    gitBinarySha256: gitBinaryAttestation.contentSha256,
    gitBinaryAclSha256: gitBinaryAttestation.aclSha256,
    gitProcessContainment,
    knownHostsPath: knownHostsAttestation.path,
    knownHostsSha256: knownHostsAttestation.contentSha256,
    knownHostsAclSha256: knownHostsAttestation.aclSha256,
    credentialDescriptors: credentialPolicy.descriptors,
    credentialDescriptorAttestor: credentialPolicy.attest,
    controllerIdentity,
    endpointAclFingerprint,
    dataRoot,
    dataRootAclSha256,
    storyRoot,
    storyRootAclSha256,
    storyPathBudget,
    definitions: structuredClone(definitions),
    workerIdentities: structuredClone(workerIdentities),
    gatewayIdentities,
    humanManagerIdentities,
    workerSecretRoots,
    ipcGid: process.platform === "win32" ? null : ipcGid,
    privateKey,
    keyFingerprint,
    clients,
  });
}

export function prepareGitControllerDataRoot(config, {
  platform = process.platform,
} = {}) {
  fs.mkdirSync(config.dataRoot, { recursive: true });
  const stat = fs.lstatSync(config.dataRoot);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw daemonError(
      "GIT_CONTROLLER_DATA_ROOT_INVALID",
      "Controller data root must be a regular non-symlink directory",
    );
  }
  let descriptor;
  if (platform === "win32") {
    if (!String(config.controllerIdentity || "").startsWith("sid:")) {
      throw daemonError(
        "GIT_CONTROLLER_DAEMON_IDENTITY_MISMATCH",
        "Windows Controller identity must be an attested SID",
      );
    }
    const controllerSid = String(config.controllerIdentity).slice(4);
    try {
      execFileSync(
        WINDOWS_ICACLS,
        [
          config.dataRoot,
          "/inheritance:r",
          "/grant:r",
          `*${controllerSid}:(OI)(CI)F`,
          "*S-1-5-18:(OI)(CI)F",
          "*S-1-5-32-544:(OI)(CI)F",
        ],
        {
          encoding: "utf8",
          windowsHide: true,
          timeout: 15_000,
          maxBuffer: 64 * 1024,
        },
      );
    } catch (error) {
      throw daemonError(
        "GIT_CONTROLLER_DATA_ROOT_ACL_FAILED",
        "Controller data/capability root Windows DACL could not be applied",
        { cause: String(error?.code || "ICACLS_FAILED") },
        error,
      );
    }
    const encodedRoot = Buffer.from(config.dataRoot, "utf8").toString("base64");
    const script = [
      "$ErrorActionPreference='Stop'",
      `$root=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedRoot}'))`,
      "$actual=Get-Acl -LiteralPath $root",
      `$controller='${controllerSid.toUpperCase()}'`,
      "$allowed=@($controller,'S-1-5-18','S-1-5-32-544')",
      "$owner=$actual.GetOwner([System.Security.Principal.SecurityIdentifier]).Value.ToUpperInvariant()",
      "if($allowed -notcontains $owner){throw 'owner not allowlisted'}",
      "$bad=@($actual.Access|ForEach-Object{",
      " try{$sid=$_.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value.ToUpperInvariant()}catch{$sid=$_.IdentityReference.Value.ToUpperInvariant()}",
      " if($allowed -notcontains $sid){$_}",
      "})",
      "if($bad.Count -gt 0){throw 'DACL principal not allowlisted'}",
      "$actual.GetSecurityDescriptorSddlForm([System.Security.AccessControl.AccessControlSections]'Owner,Group,Access')",
    ].join(";");
    try {
      descriptor = execFileSync(
        WINDOWS_POWERSHELL,
        [
          "-NoLogo", "-NoProfile", "-NonInteractive", "-Command",
          script,
        ],
        {
          encoding: "utf8",
          windowsHide: true,
          timeout: 15_000,
          maxBuffer: 64 * 1024,
        },
      ).trim();
    } catch (error) {
      throw daemonError(
        "GIT_CONTROLLER_DATA_ROOT_ACL_FAILED",
        "Controller data/capability root Windows DACL could not be applied and verified",
        { cause: String(error?.code || "SET_ACL_FAILED") },
        error,
      );
    }
  } else {
    fs.chmodSync(config.dataRoot, 0o700);
    const secured = fs.statSync(config.dataRoot);
    if (
      (secured.mode & 0o777) !== 0o700
      || (
        typeof process.getuid === "function"
        && Number.isSafeInteger(secured.uid)
        && secured.uid !== process.getuid()
      )
    ) {
      throw daemonError(
        "GIT_CONTROLLER_DATA_ROOT_ACL_FAILED",
        "Controller data/capability root ownership or Unix mode is unsafe",
      );
    }
    descriptor = `unix:uid:${secured.uid}:mode:0700`;
  }
  const fingerprint = createHash("sha256").update(descriptor).digest("hex");
  if (fingerprint !== config.dataRootAclSha256) {
    throw daemonError(
      "GIT_CONTROLLER_DATA_ROOT_ACL_DRIFT",
      "Controller data/capability root ACL differs from the pinned deployment policy",
      { actualFingerprint: fingerprint },
    );
  }
  return { descriptor, fingerprint };
}

export function prepareGitControllerStoryRoot(config, options = {}) {
  const platform = options.platform || process.platform;
  fs.mkdirSync(config.storyRoot, { recursive: true });
  const stat = fs.lstatSync(config.storyRoot);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw daemonError(
      "GIT_CONTROLLER_STORY_ROOT_INVALID",
      "Controller story root must be a regular non-symlink directory",
    );
  }
  const traversers = [...new Set([
    ...config.gatewayIdentities,
    ...config.humanManagerIdentities,
    ...Object.values(config.workerIdentities || {}),
  ].map((identity) => String(identity).toLowerCase()))].sort();
  let descriptor;
  if (platform === "win32") {
    const controllerSid = String(config.controllerIdentity).slice(4);
    const traverseSids = traversers.map((identity) => String(identity).slice(4));
    execFileSync(WINDOWS_ICACLS, [
      config.storyRoot,
      "/inheritance:r",
      "/grant:r",
      `*${controllerSid}:(OI)(CI)F`,
      ...traverseSids.map((sid) => `*${sid}:(RX)`),
      "*S-1-5-18:(OI)(CI)F",
      "*S-1-5-32-544:(OI)(CI)F",
    ], { windowsHide: true, timeout: 30_000, stdio: "ignore" });
    const encodedRoot = Buffer.from(config.storyRoot, "utf8").toString("base64");
    const allowedJson = Buffer.from(JSON.stringify([
      controllerSid,
      ...traverseSids,
      "S-1-5-18",
      "S-1-5-32-544",
    ].map((sid) => sid.toUpperCase())), "utf8").toString("base64");
    const script = [
      "$ErrorActionPreference='Stop'",
      `$root=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedRoot}'))`,
      `$allowed=@(ConvertFrom-Json ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${allowedJson}'))))`,
      "$actual=Get-Acl -LiteralPath $root",
      "$bad=@($actual.Access|ForEach-Object{",
      " try{$sid=$_.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value.ToUpperInvariant()}catch{$sid=$_.IdentityReference.Value.ToUpperInvariant()}",
      " if($allowed -notcontains $sid){$_}",
      "})",
      "if($bad.Count -gt 0){throw 'DACL principal not allowlisted'}",
      "$actual.GetSecurityDescriptorSddlForm([System.Security.AccessControl.AccessControlSections]'Owner,Group,Access')",
    ].join(";");
    descriptor = execFileSync(
      WINDOWS_POWERSHELL,
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
      {
        encoding: "utf8",
        windowsHide: true,
        timeout: 15_000,
        maxBuffer: 64 * 1024,
      },
    ).trim();
  } else if (platform === "linux") {
    const currentUid = typeof process.getuid === "function" ? process.getuid() : null;
    if (!Number.isSafeInteger(currentUid)) {
      throw daemonError(
        "GIT_CONTROLLER_STORY_ROOT_ACL_FAILED",
        "Unix Controller UID is unavailable",
      );
    }
    const traverseUids = traversers.map((identity) => String(identity).slice(4));
    fs.chmodSync(config.storyRoot, 0o700);
    execFileSync(UNIX_SETFACL, ["-b", config.storyRoot], { timeout: 15_000 });
    execFileSync(UNIX_SETFACL, [
      "-m",
      [
        ...traverseUids.map((uid) => `u:${uid}:--x`),
        "m::--x",
        "o::---",
      ].join(","),
      config.storyRoot,
    ], { timeout: 15_000 });
    const secured = fs.statSync(config.storyRoot);
    const acl = execFileSync(UNIX_GETFACL, ["-cp", config.storyRoot], {
      encoding: "utf8",
      timeout: 15_000,
    }).trim();
    const unexpected = [...acl.matchAll(/^user:([0-9]+):/gm)]
      .map((match) => match[1])
      .filter((uid) => !traverseUids.includes(uid));
    if (
      secured.uid !== currentUid
      || unexpected.length
      || traverseUids.some((uid) => !new RegExp(`^user:${uid}:--x$`, "m").test(acl))
    ) {
      throw daemonError(
        "GIT_CONTROLLER_STORY_ROOT_ACL_FAILED",
        "Story root Unix owner or stable traversal ACL is unsafe",
      );
    }
    descriptor = `linux-story-root:uid:${secured.uid}\n${acl}`;
  } else {
    throw daemonError(
      "GIT_CONTROLLER_STORY_ROOT_ACL_FAILED",
      "Story root ACL attestation is unsupported on this platform",
    );
  }
  const fingerprint = createHash("sha256").update(descriptor).digest("hex");
  if (fingerprint !== config.storyRootAclSha256) {
    throw daemonError(
      "GIT_CONTROLLER_STORY_ROOT_ACL_DRIFT",
      "Story root ACL differs from the pinned stable identity allowlist",
      { actualFingerprint: fingerprint },
    );
  }
  return { descriptor, fingerprint };
}

function publicRepositoryEntry(entry) {
  return {
    repositoryId: entry.repositoryId,
    logicalDefinitionId: entry.logicalDefinitionId,
    displayName: entry.displayName,
    basePath: entry.basePath,
    mirrorPath: entry.mirrorPath,
    remoteId: entry.remoteId,
    allowedBranches: [...entry.allowedBranches],
    isolationMode: entry.isolationMode,
  };
}

function exactManagedHooksManifest(entry, installationId, manifestSha256) {
  const listed = listBaseProtectionHooks(entry.basePath);
  const manifestPath = path.join(String(listed.managedRoot || ""), "manifest.json");
  if (!listed.managedRoot || !fs.existsSync(manifestPath)) {
    throw daemonError(
      "GIT_CONTROLLER_HOOKS_NOT_INSTALLED",
      "Managed hooks manifest is unavailable",
    );
  }
  const stat = fs.lstatSync(manifestPath);
  if (!stat.isFile() || stat.isSymbolicLink() || Number(stat.nlink || 1) !== 1) {
    throw daemonError(
      "GIT_CONTROLLER_HOOKS_MANIFEST_INVALID",
      "Managed hooks manifest is not a regular file",
    );
  }
  const bytes = fs.readFileSync(manifestPath);
  const actualSha256 = createHash("sha256").update(bytes).digest("hex");
  let manifest;
  try { manifest = JSON.parse(bytes.toString("utf8")); } catch {
    throw daemonError(
      "GIT_CONTROLLER_HOOKS_MANIFEST_INVALID",
      "Managed hooks manifest is invalid JSON",
    );
  }
  if (
    String(manifest.installationId || "") !== installationId
    || actualSha256 !== manifestSha256
  ) {
    throw daemonError(
      "GIT_CONTROLLER_HOOKS_MANIFEST_MISMATCH",
      "Managed hooks installation identity or exact manifest hash changed",
    );
  }
  return { installationId, manifestSha256 };
}

async function acceptedForStory(runtime, repository) {
  const requestedBranch = String(repository.sourceRef || repository.baseRef || "")
    .replace(/^refs\/heads\//, "");
  const { entry, branch } = await runtime.controller.registry.resolve(
    repository.repositoryId,
    requestedBranch,
  );
  const accepted = await runtime.controller.mirror.readAccepted(entry, branch);
  if (!accepted.acceptedSha) {
    throw daemonError(
      "GIT_CONTROLLER_ACCEPTED_REF_MISSING",
      "The managed branch has no accepted mirror tip for story baseline synchronization",
      {
        repositoryId: repository.repositoryId,
        branch,
      },
    );
  }
  return runtime.controller.mirror.resolveAcceptedCandidate({
    repositoryId: repository.repositoryId,
    branch,
    candidateSha: accepted.acceptedSha,
  });
}

export async function refreshStoryAcceptedRevision(controller, payload = {}) {
  const idempotencyKey = assertIdempotencyKey(payload.idempotencyKey);
  const expectedKey = storyAcceptedRefreshIdempotencyKey(payload);
  if (idempotencyKey !== expectedKey) {
    throw daemonError(
      "GIT_CONTROLLER_IDEMPOTENCY_BINDING_INVALID",
      "Story accepted-refresh idempotency key is not bound to the exact request",
    );
  }
  const persistence = controller?.journal?.persistence;
  if (typeof persistence?.getGitControllerOperationByIdempotency !== "function") {
    throw daemonError(
      "GIT_CONTROLLER_DAEMON_RUNTIME_INVALID",
      "Story accepted-refresh requires the durable Controller operation journal",
    );
  }
  const repositoryId = String(payload.repositoryId || "");
  const branch = String(payload.branch || "");
  const existing = persistence.getGitControllerOperationByIdempotency(
    repositoryId,
    "MIRROR_REFRESH",
    idempotencyKey,
  );
  let accepted;
  if (existing) {
    accepted = await controller.mirror.execute({
      repositoryId,
      branch,
      previewId: existing.previewId,
      previewVersion: 0,
      expectedAcceptedSha: existing.expectedHead || "",
      candidateSha: existing.candidateSha,
      idempotencyKey,
      actor: "controller:story-provision",
    });
  } else {
    const preview = await controller.mirror.preview({ repositoryId, branch });
    if (!preview.eligible) {
      throw daemonError(
        preview.blockerCode || "GIT_CONTROLLER_MIRROR_REFRESH_BLOCKED",
        "Remote candidate did not pass the managed mirror policy",
      );
    }
    accepted = await controller.mirror.execute({
      repositoryId,
      branch,
      previewId: preview.previewId,
      previewVersion: preview.previewVersion,
      expectedAcceptedSha: preview.lastAcceptedSha || "",
      candidateSha: preview.candidateSha,
      idempotencyKey,
      actor: "controller:story-provision",
    });
  }
  const candidateSha = String(payload.exactSha || accepted.candidateSha).toLowerCase();
  return controller.mirror.resolveAcceptedCandidate({
    repositoryId,
    branch,
    candidateSha,
  });
}

export function createGitControllerCommandDispatcher(runtime, {
  getGitProcessContainment = () => runtime?.gitProcessContainment,
} = {}) {
  const controller = runtime?.controller;
  if (!controller?.registry || !controller?.mirror || !controller?.base) {
    throw daemonError(
      "GIT_CONTROLLER_DAEMON_RUNTIME_INVALID",
      "Controller daemon requires a complete local Controller runtime",
    );
  }
  const hooks = runtime.managedHooks || createManagedHooksController(runtime);
  const baseline = runtime.storyBaseline;
  const storyRepositories = runtime.storyRepositories || createStoryRepositoryController({
    controller,
    storyRoot: runtime.storyRoot,
    dataRoot: runtime.dataRoot,
    workerIdentities: runtime.workerIdentities,
    gatewayIdentities: runtime.gatewayIdentities,
    humanManagerIdentities: runtime.humanManagerIdentities,
    controllerIdentity: runtime.controllerIdentity,
    workerSecretRoots: runtime.workerSecretRoots,
    gitSpawnGuard: runtime.gitSpawnGuard,
    requiredCheckVerifier: runtime.requiredCheckVerifier,
    flavorPolicyResolver: runtime.flavorPolicyResolver,
  });
  return async function dispatch(commandId, payload) {
    switch (commandId) {
      case "runtime.describe":
        {
          const session = getGitProcessContainment();
          const containment = isVerifiedGitProcessContainmentSession(session)
            ? session.publicEvidence({
                attestationChallenge: payload.attestationChallenge,
              })
            : null;
        return {
          isolationLevel: containment?.isolationLevel || "DIRECT_PID_GUARDED",
          gitProcessContainment: containment,
          adapter: "process-daemon",
          repositories: [...controller.registry.entries.values()].map(publicRepositoryEntry),
          warnings: runtime.warnings || controller.registrationErrors || [],
          storyPathBudget: runtime.storyPathBudget || null,
        };
        }
      case "registry.verify":
        return controller.registry.verify(payload.repositoryId);
      case "sync.status":
        return controller.syncStatus(payload);
      case "mirror.preview":
        return controller.mirror.preview(payload);
      case "mirror.read-accepted": {
        const { entry, branch } = await controller.registry.resolve(
          payload.repositoryId,
          payload.branch,
        );
        return controller.mirror.readAccepted(entry, branch);
      }
      case "mirror.execute":
        return controller.mirror.execute(payload);
      case "mirror.resolve-accepted":
        return controller.mirror.resolveAcceptedCandidate(payload);
      case "base.preflight": {
        const { entry, branch } = await controller.registry.resolve(
          payload.repositoryId,
          payload.branch,
        );
        return controller.base.preflight(entry, branch, payload.candidateSha);
      }
      case "base.preview":
        return controller.base.preview(payload);
      case "base.execute":
        return controller.base.execute(payload);
      case "hooks.diagnose":
        return hooks.diagnose(payload);
      case "hooks.preview":
        return hooks.preview(payload);
      case "hooks.execute":
        return hooks.execute(payload);
      case "hooks.standalone-uninstall": {
        const entry = controller.registry.get(payload.repositoryId);
        await controller.registry.verify(entry.repositoryId);
        const verifyInstallation = () => exactManagedHooksManifest(
          entry,
          payload.installationId,
          payload.manifestSha256,
        );
        verifyInstallation();
        return hooks.standaloneUninstall({
          repositoryId: entry.repositoryId,
          idempotencyKey: payload.idempotencyKey,
          actor: "controller:standalone-hooks-uninstall",
        }, {
          verifyInstallation,
        });
      }
      case "story.accepted.refresh": {
        return refreshStoryAcceptedRevision(controller, payload);
      }
      case "story.repository.provision": {
        const {
          legacySourcePath,
          legacyStateDigest,
          ...provisionPayload
        } = payload;
        return storyRepositories.provision({
          ...provisionPayload,
          ...(legacySourcePath && legacyStateDigest
            ? {
                legacyMigration: {
                  sourcePath: legacySourcePath,
                  stateDigest: legacyStateDigest,
                },
              }
            : {}),
        });
      }
      case "story.repository.legacy-migration-preview":
        return storyRepositories.previewLegacyMigration(payload);
      case "story.repository.inspect":
        return storyRepositories.inspect(payload);
      case "story.repository.commit":
        return storyRepositories.commit(payload);
      case "story.repository.retire-preview":
        return storyRepositories.retirePreview(payload);
      case "story.repository.retire":
        return storyRepositories.retire(payload);
      case "story.repository.cleanup":
        return storyRepositories.cleanup(payload);
      case "story.baseline.preview": {
        if (!baseline) {
          throw daemonError(
            "STORY_BASELINE_CONTROLLER_UNAVAILABLE",
            "Story baseline service is unavailable inside Controller daemon",
          );
        }
        const repository = await storyRepositories.resolve(payload);
        return baseline.preview({
          tabId: payload.tabId,
          repository,
          accepted: await acceptedForStory(runtime, repository),
          strategy: payload.strategy,
        });
      }
      case "story.baseline.execute": {
        if (!baseline) {
          throw daemonError(
            "STORY_BASELINE_CONTROLLER_UNAVAILABLE",
            "Story baseline service is unavailable inside Controller daemon",
          );
        }
        const recovery = await recoverStoryBaselineMetadataByIdempotency({
          storyRepositories,
          persistence: baseline.persistence,
          repositoryId: payload.repositoryId,
          idempotencyKey: payload.idempotencyKey,
        });
        const repository = await storyRepositories.resolve(payload);
        const registryMetadataPrior = recovery.found
          ? null
          : storyRepositories.captureBaselineMetadataRecoveryPrior(
            payload.tabId,
            payload.repositoryId,
          );
        const result = await baseline.execute({
          ...payload,
          repository,
          accepted: await acceptedForStory(runtime, repository),
          registryMetadataPrior,
        });
        if (result.registryRecoveryMarker) {
          if (result.registryRecoveryState === "APPLIED") {
            return result;
          }
          const durableOperation = baseline.persistence.getGitControllerOperation(
            result.operationId,
          );
          const applied = await recoverStoryBaselineOperationMetadata({
            storyRepositories,
            persistence: baseline.persistence,
            operation: durableOperation,
          });
          if (!applied.acknowledged) {
            throw daemonError(
              "STORY_BASELINE_REGISTRY_RECOVERY_ACK_MISSING",
              "Successful process-daemon baseline did not acknowledge registry recovery",
              {
                recoveryRequired: true,
                operationId: result.operationId,
                repositoryId: payload.repositoryId,
                tabId: payload.tabId,
              },
            );
          }
          return applied.operation?.result || {
            ...result,
            registryRecoveryState: "APPLIED",
          };
        } else if (!result.replayed) {
          throw daemonError(
            "STORY_BASELINE_REGISTRY_RECOVERY_MARKER_MISSING",
            "Successful process-daemon baseline did not persist its registry recovery marker",
            {
              recoveryRequired: true,
              operationId: result.operationId,
              repositoryId: payload.repositoryId,
              tabId: payload.tabId,
            },
          );
        }
        return result;
      }
      default:
        throw daemonError(
          "GIT_CONTROLLER_COMMAND_NOT_ALLOWED",
          "Git Controller command is not implemented by the daemon",
        );
    }
  };
}

function safeError(error) {
  return {
    code: String(error?.code || "GIT_CONTROLLER_COMMAND_FAILED").slice(0, 160),
    message: String(error?.message || "Git Controller command failed").slice(0, 500),
    details: error?.details && typeof error.details === "object" ? error.details : {},
  };
}

function windowsNamedPipeSddl(endpoint) {
  const typeSource = [
    "using System;",
    "using System.Runtime.InteropServices;",
    "using System.Security.AccessControl;",
    "using Microsoft.Win32.SafeHandles;",
    "public static class DevBenchPipeAcl {",
    " [DllImport(\"kernel32.dll\", CharSet=CharSet.Unicode, SetLastError=true)]",
    " static extern SafeFileHandle CreateFile(string n,uint a,uint sh,IntPtr sa,uint c,uint f,IntPtr t);",
    " [DllImport(\"advapi32.dll\", SetLastError=true)]",
    " static extern uint GetSecurityInfo(SafeFileHandle h,int t,uint i,out IntPtr o,out IntPtr g,out IntPtr d,out IntPtr s,out IntPtr sd);",
    " [DllImport(\"advapi32.dll\", SetLastError=true)] static extern uint GetSecurityDescriptorLength(IntPtr p);",
    " [DllImport(\"kernel32.dll\")] static extern IntPtr LocalFree(IntPtr p);",
    " public static string Read(string name){",
    "  using(var h=CreateFile(name,0x20000,3,IntPtr.Zero,3,0,IntPtr.Zero)){",
    "   if(h.IsInvalid) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());",
    "   IntPtr o,g,d,s,sd; uint r=GetSecurityInfo(h,6,5,out o,out g,out d,out s,out sd);",
    "   if(r!=0) throw new System.ComponentModel.Win32Exception((int)r);",
    "   try{ uint len=GetSecurityDescriptorLength(sd); byte[] b=new byte[len]; Marshal.Copy(sd,b,0,(int)len);",
    "   return new RawSecurityDescriptor(b,0).GetSddlForm(AccessControlSections.Owner|AccessControlSections.Access);",
    "   } finally { LocalFree(sd); }",
    "  }",
    " }",
    "}",
  ].join("");
  const encodedEndpoint = Buffer.from(endpoint, "utf8").toString("base64");
  const encodedSource = Buffer.from(typeSource, "utf8").toString("base64");
  const script = [
    "$ErrorActionPreference='Stop'",
    `$pipe=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedEndpoint}'))`,
    `$source=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedSource}'))`,
    "Add-Type -TypeDefinition $source -Language CSharp",
    "[DevBenchPipeAcl]::Read($pipe)",
  ].join(";");
  try {
    return execFileSync(
      WINDOWS_POWERSHELL,
      [
        "-NoLogo", "-NoProfile", "-NonInteractive", "-Command",
        script,
      ],
      {
        encoding: "utf8",
        windowsHide: true,
        timeout: 15_000,
        maxBuffer: 128 * 1024,
      },
    ).trim();
  } catch (error) {
    throw daemonError(
      "GIT_CONTROLLER_ENDPOINT_ACL_UNVERIFIED",
      "Windows named-pipe DACL could not be read from the live endpoint",
      { cause: String(error?.code || "PIPE_ACL_PROBE_FAILED") },
      error,
    );
  }
}

export function validateWindowsPipeSddl(config, sddl) {
  const aces = [...String(sddl || "").matchAll(/\(([^()]*)\)/g)].map((match) => {
    const fields = match[1].split(";");
    return {
      type: String(fields[0] || "").toUpperCase(),
      rights: String(fields[2] || "").toUpperCase(),
      principal: String(fields[5] || "").toUpperCase(),
    };
  });
  const normalize = (identity) => String(identity || "").replace(/^sid:/i, "").toUpperCase();
  const controller = normalize(config.controllerIdentity);
  const clients = [
    ...(config.gatewayIdentities || []),
    ...(config.humanManagerIdentities || []),
  ].map(normalize);
  const privileged = new Set([controller, "SY", "BA", "S-1-5-18", "S-1-5-32-544"]);
  const allowed = new Set([...privileged, ...clients]);
  const broadAliases = new Set(["WD", "AU", "BU", "IU", "SU", "AC", "AN", "NU", "RU", "RC"]);
  const clientRightsSafe = (rights) => {
    if (/(?:GA|FA|WD|WO|SD)/.test(rights)) return false;
    if (rights.includes("GR") && rights.includes("GW")) return true;
    if (!/^0X[0-9A-F]+$/.test(rights)) return false;
    const bits = Number.parseInt(rights.slice(2), 16);
    const forbidden = 0x10000 | 0x40000 | 0x80000 | 0x10000000;
    const canRead = (bits & (0x1 | 0x8 | 0x80 | 0x80000000)) !== 0;
    const canWrite = (bits & (0x2 | 0x4 | 0x10 | 0x100 | 0x40000000)) !== 0;
    return (bits & forbidden) === 0 && canRead && canWrite;
  };
  if (
    !aces.length
    || aces.some((ace) => (
      ace.type !== "A"
      || broadAliases.has(ace.principal)
      || !allowed.has(ace.principal)
      || (clients.includes(ace.principal) && !clientRightsSafe(ace.rights))
    ))
    || [controller, ...clients].some((principal) => !aces.some((ace) => (
      ace.principal === principal
      && ace.type === "A"
      && (privileged.has(principal) || clientRightsSafe(ace.rights))
    )))
  ) {
    throw daemonError(
      "GIT_CONTROLLER_ENDPOINT_ACL_UNSAFE",
      "Named-pipe DACL ACE type, rights, or principal does not match the exact deployment allowlist",
    );
  }
  const workers = new Set(Object.values(config.workerIdentities || {}).map(normalize));
  if (aces.some((ace) => workers.has(ace.principal))) {
    throw daemonError(
      "GIT_CONTROLLER_ENDPOINT_ACL_UNSAFE",
      "Named-pipe DACL grants access to a Worker identity",
    );
  }
  return aces;
}

export function attestGitControllerEndpoint(config, {
  platform = process.platform,
} = {}) {
  let descriptor;
  if (platform === "win32") {
    const sddl = windowsNamedPipeSddl(config.endpoint);
    if (Array.isArray(config.gatewayIdentities) && config.gatewayIdentities.length) {
      validateWindowsPipeSddl(config, sddl);
    }
    descriptor = `windows-pipe:${sddl}`;
  } else {
    const stat = fs.lstatSync(config.endpoint);
    const currentUid = typeof process.getuid === "function" ? process.getuid() : null;
    if (
      !stat.isSocket()
      || stat.isSymbolicLink()
      || (stat.mode & 0o777) !== 0o660
      || !Number.isSafeInteger(currentUid)
      || stat.uid !== currentUid
      || !Number.isSafeInteger(config.ipcGid)
      || stat.gid !== config.ipcGid
    ) {
      throw daemonError(
        "GIT_CONTROLLER_ENDPOINT_ACL_UNSAFE",
        "Live Unix Controller socket must be Controller-owned, group-bound to ipcGid, and mode 0660",
      );
    }
    descriptor = `unix-socket:uid:${stat.uid}:gid:${stat.gid}:mode:0660`;
  }
  const fingerprint = createHash("sha256").update(descriptor).digest("hex");
  if (fingerprint !== config.endpointAclFingerprint) {
    throw daemonError(
      "GIT_CONTROLLER_ENDPOINT_ACL_DRIFT",
      "Live Controller endpoint ACL differs from the pinned deployment policy",
      { actualFingerprint: fingerprint },
    );
  }
  return { descriptor, fingerprint };
}

export class GitControllerDaemon {
  constructor({
    config,
    dispatch,
    now = () => Date.now(),
    serverFactory = net.createServer,
    endpointAttestor = attestGitControllerEndpoint,
    platform = process.platform,
    instanceLock = null,
    instanceLockFactory = acquireGitControllerDaemonInstanceLock,
    endpointProbe = probeUnixControllerEndpoint,
  } = {}) {
    this.config = config;
    this.dispatch = dispatch;
    this.now = now;
    this.serverFactory = serverFactory;
    this.endpointAttestor = endpointAttestor;
    this.platform = platform;
    this.instanceLock = instanceLock;
    this.instanceLockFactory = instanceLockFactory;
    this.endpointProbe = endpointProbe;
    this.server = null;
    this.endpointIdentity = null;
    this.retiredEndpointPath = null;
    this.nonces = new Map();
    this.processContainment = null;
    this.ready = false;
    this.failStopped = false;
  }

  refreshProcessContainment(attestationChallenge = randomBytes(24).toString("hex")) {
    const session = this.config?.gitProcessContainment;
    if (!isVerifiedGitProcessContainmentSession(session)) {
      throw daemonError(
        "GIT_CONTROLLER_PROCESS_TREE_CONTAINMENT_REQUIRED",
        "Controller daemon requires a live guardian-verified containment session",
      );
    }
    try {
      session.refresh({ attestationChallenge });
    } catch (error) {
      this.failStopped = true;
      this.ready = false;
      throw error;
    }
    if (
      !isVerifiedGitProcessContainmentSession(session)
      || session.daemonInstanceId !== this.config.gitProcessContainment.daemonInstanceId
    ) {
      this.failStopped = true;
      this.ready = false;
      throw daemonError(
        "GIT_CONTROLLER_PROCESS_TREE_ATTESTATION_INVALID",
        "Guardian containment session changed identity during refresh",
      );
    }
    this.processContainment = session;
    return session;
  }

  getReadyAttestation({ attestationChallenge } = {}) {
    if (!this.ready || this.failStopped || !this.processContainment) {
      throw daemonError(
        "GIT_CONTROLLER_DAEMON_NOT_READY",
        "Controller daemon has no current ready containment attestation",
      );
    }
    const challenge = attestationChallenge || randomBytes(24).toString("hex");
    this.refreshProcessContainment(challenge);
    return this.processContainment.publicEvidence({
      attestationChallenge: challenge,
    });
  }

  verifyRequest(request) {
    const now = this.now();
    if (
      !request
      || request.version !== GIT_CONTROLLER_PROTOCOL_VERSION
      || !Number.isSafeInteger(request.timestamp)
      || Math.abs(now - request.timestamp) > GIT_CONTROLLER_CLOCK_SKEW_MS
      || !/^[0-9a-f]{32}$/i.test(String(request.requestId || ""))
      || !/^[0-9a-f]{48}$/i.test(String(request.nonce || ""))
    ) {
      throw daemonError(
        "GIT_CONTROLLER_REQUEST_ATTESTATION_INVALID",
        "Git Controller request envelope is invalid or expired",
      );
    }
    const client = this.config.clients.get(String(request.clientId || ""));
    if (!client) {
      throw daemonError(
        "GIT_CONTROLLER_CLIENT_UNAUTHORIZED",
        "Git Controller client is not authorized",
      );
    }
    const secret = Buffer.isBuffer(client) ? client : client.secret;
    const expectedClientIdentity = Buffer.isBuffer(client)
      ? String(request.clientIdentity || "")
      : client.expectedIdentity;
    if (
      !expectedClientIdentity
      || String(request.clientIdentity || "").toLowerCase()
        !== String(expectedClientIdentity).toLowerCase()
    ) {
      throw daemonError(
        "GIT_CONTROLLER_CLIENT_IDENTITY_MISMATCH",
        "Controller client identity does not match the protected client credential policy",
      );
    }
    const { mac, ...unsigned } = request;
    if (!verifyControllerRequestMac(unsigned, mac, secret)) {
      throw daemonError(
        "GIT_CONTROLLER_REQUEST_SIGNATURE_INVALID",
        "Git Controller request authentication failed",
      );
    }
    if (this.nonces.has(request.nonce)) {
      throw daemonError(
        "GIT_CONTROLLER_REQUEST_REPLAYED",
        "Git Controller request nonce was already consumed",
      );
    }
    for (const [nonce, expiresAt] of this.nonces) {
      if (expiresAt <= now) this.nonces.delete(nonce);
    }
    this.nonces.set(request.nonce, now + GIT_CONTROLLER_CLOCK_SKEW_MS * 2);
    return validateControllerCommand(request.commandId, request.payload);
  }

  response(requestId, body) {
    const unsigned = {
      version: GIT_CONTROLLER_PROTOCOL_VERSION,
      requestId: String(requestId || ""),
      timestamp: this.now(),
      endpoint: this.config.endpoint,
      controllerIdentity: this.config.controllerIdentity,
      endpointAclFingerprint: this.config.endpointAclFingerprint,
      keyFingerprint: this.config.keyFingerprint,
      body,
    };
    return {
      ...unsigned,
      signature: signPayload(
        null,
        Buffer.from(canonicalProtocolJson(unsigned)),
        this.config.privateKey,
      ).toString("base64"),
    };
  }

  handleSocket(socket) {
    socket.setEncoding("utf8");
    let text = "";
    let bytes = 0;
    let handled = false;
    socket.on("data", async (chunk) => {
      if (handled) return;
      bytes += Buffer.byteLength(chunk);
      if (bytes > GIT_CONTROLLER_MAX_MESSAGE_BYTES) {
        handled = true;
        socket.destroy();
        return;
      }
      text += chunk;
      const newline = text.indexOf("\n");
      if (newline < 0) return;
      handled = true;
      let request = null;
      let body;
      try {
        if (!this.ready || this.failStopped) {
          throw daemonError(
            "GIT_CONTROLLER_DAEMON_NOT_READY",
            "Controller daemon is not ready to accept commands",
          );
        }
        request = JSON.parse(text.slice(0, newline));
        const validated = this.verifyRequest(request);
        this.refreshProcessContainment(
          validated.commandId === "runtime.describe"
            ? validated.payload.attestationChallenge
            : randomBytes(24).toString("hex"),
        );
        const data = await this.dispatch(validated.commandId, validated.payload);
        body = { ok: true, data };
      } catch (error) {
        body = { ok: false, error: safeError(error) };
      }
      socket.end(`${JSON.stringify(this.response(request?.requestId, body))}\n`);
    });
  }

  ensureInstanceLock() {
    if (
      this.platform === "win32"
      || this.instanceLock
      || !String(this.config?.dataRoot || "").trim()
    ) {
      return this.instanceLock;
    }
    this.instanceLock = this.instanceLockFactory(this.config, {
      platform: this.platform,
    });
    return this.instanceLock;
  }

  releaseInstanceLock() {
    const lock = this.instanceLock;
    this.instanceLock = null;
    return lock?.release?.() || { ok: true, skipped: true };
  }

  async retireStaleUnixEndpoint() {
    const endpoint = this.config.endpoint;
    if (!fs.existsSync(endpoint)) return null;
    const before = fs.lstatSync(endpoint);
    if (!before.isSocket() || before.isSymbolicLink()) {
      throw daemonError(
        "GIT_CONTROLLER_ENDPOINT_OCCUPIED",
        "Refusing to replace a non-socket Controller endpoint",
      );
    }
    const beforeIdentity = unixFileIdentity(before);
    const probe = await this.endpointProbe(endpoint);
    if (probe?.live !== false) {
      throw daemonError(
        "GIT_CONTROLLER_ENDPOINT_LIVE",
        "A live process is already listening on the Controller endpoint",
      );
    }
    if (!fs.existsSync(endpoint)) return null;
    const after = fs.lstatSync(endpoint);
    const afterIdentity = unixFileIdentity(after);
    if (
      !after.isSocket()
      || after.isSymbolicLink()
      || !sameUnixFileIdentity(beforeIdentity, afterIdentity)
    ) {
      throw daemonError(
        "GIT_CONTROLLER_ENDPOINT_CHANGED",
        "Controller endpoint changed while stale ownership was verified",
      );
    }
    const retired = `${endpoint}.stale.${this.now()}.${randomUUID()}`;
    fs.renameSync(endpoint, retired);
    this.retiredEndpointPath = retired;
    return retired;
  }

  removeOwnedUnixEndpoint() {
    if (
      this.platform === "win32"
      || !this.endpointIdentity
      || !fs.existsSync(this.config.endpoint)
    ) {
      return false;
    }
    const current = fs.lstatSync(this.config.endpoint);
    const identity = unixFileIdentity(current);
    if (
      !current.isSocket()
      || current.isSymbolicLink()
      || identity.dev !== this.endpointIdentity.dev
      || identity.ino !== this.endpointIdentity.ino
    ) {
      return false;
    }
    fs.unlinkSync(this.config.endpoint);
    this.endpointIdentity = null;
    return true;
  }

  async listen() {
    if (this.server) return this;
    try {
      this.failStopped = false;
      this.ready = false;
      this.refreshProcessContainment();
      this.ensureInstanceLock();
      if (this.platform !== "win32") {
        await this.retireStaleUnixEndpoint();
      }
      this.server = this.serverFactory((socket) => this.handleSocket(socket));
      await new Promise((resolve, reject) => {
        this.server.once("error", reject);
        const listenOptions = this.platform === "win32"
          ? {
              path: this.config.endpoint,
              readableAll: false,
              writableAll: false,
            }
          : this.config.endpoint;
        this.server.listen(listenOptions, () => {
          this.server.off("error", reject);
          resolve();
        });
      });
      if (this.platform !== "win32") {
        this.endpointIdentity = unixFileIdentity(fs.lstatSync(this.config.endpoint));
        fs.chownSync(this.config.endpoint, -1, this.config.ipcGid);
        fs.chmodSync(this.config.endpoint, 0o660);
        this.endpointIdentity = unixFileIdentity(fs.lstatSync(this.config.endpoint));
      }
      this.endpointAttestor(this.config);
      this.refreshProcessContainment();
      this.ready = true;
      if (this.retiredEndpointPath) {
        try {
          fs.unlinkSync(this.retiredEndpointPath);
          this.retiredEndpointPath = null;
        } catch {}
      }
      return this;
    } catch (error) {
      const server = this.server;
      this.server = null;
      this.ready = false;
      if (server) {
        await new Promise((resolve) => {
          try {
            server.close(() => resolve());
          } catch {
            resolve();
          }
        });
      }
      try {
        this.removeOwnedUnixEndpoint();
      } catch {}
      this.releaseInstanceLock();
      throw error;
    }
  }

  async close() {
    const server = this.server;
    this.server = null;
    this.ready = false;
    let closeError = null;
    try {
      if (server) {
        await new Promise((resolve, reject) => server.close((error) => (
          error ? reject(error) : resolve()
        )));
      }
    } catch (error) {
      closeError = error;
    } finally {
      try {
        this.removeOwnedUnixEndpoint();
      } catch (error) {
        closeError ||= error;
      }
      this.releaseInstanceLock();
    }
    if (closeError) throw closeError;
  }
}

export async function createGitControllerDaemon({
  runtime,
  config = readGitControllerDaemonConfig(),
  ...options
} = {}) {
  let daemon = null;
  const dispatch = createGitControllerCommandDispatcher(runtime, {
    getGitProcessContainment: () => daemon?.processContainment,
  });
  daemon = new GitControllerDaemon({
    config,
    dispatch,
    ...options,
  });
  await daemon.listen();
  return daemon;
}
