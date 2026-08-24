import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
  verify as verifySignature,
} from "node:crypto";
import { GitControllerError } from "./git-controller/index.js";

export const GIT_CONTROLLER_PROTOCOL_VERSION = 1;
export const GIT_CONTROLLER_MAX_MESSAGE_BYTES = 256 * 1024;
export const GIT_CONTROLLER_CLOCK_SKEW_MS = 30_000;
export const GIT_PROCESS_CONTAINMENT_RECEIPT_VERSION = 2;
export const GIT_PROCESS_CONTAINMENT_MAX_TTL_MS = 10_000;
export const GIT_PROCESS_CONTAINMENT_MODES = Object.freeze({
  win32: "WINDOWS_JOB_KILL_ON_CLOSE",
  linux: "LINUX_CGROUP_V2_SUPERVISED",
});

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const BRANCH = /^(?!\.)(?!.*(?:\.\.|\/\/|@\{|\.lock(?:\/|$)))[A-Za-z0-9._/-]{1,240}$/;
const SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;
const OPTIONAL_SHA = /^(?:|[0-9a-f]{40}|[0-9a-f]{64})$/i;
const ATTESTATION_CHALLENGE = /^[0-9a-f]{48}$/;
const CONTAINMENT_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const COMMAND_FIELDS = Object.freeze({
  "runtime.describe": ["attestationChallenge"],
  "registry.verify": ["repositoryId"],
  "sync.status": ["repositoryId", "branch"],
  "mirror.preview": ["repositoryId", "branch"],
  "mirror.read-accepted": ["repositoryId", "branch"],
  "mirror.execute": [
    "repositoryId", "branch", "previewId", "previewVersion",
    "expectedAcceptedSha", "candidateSha", "idempotencyKey", "actor",
    "adminApprovalId", "adminApprovedAt", "adminApprovalExpiresAt",
    "adminApprovedRelationship", "adminApprovedBy",
    "adminApprovedPreviewId", "adminApprovedPreviewVersion",
    "adminApprovedPreviousSha", "adminApprovedCandidateSha",
    "adminApprovedImpactDigest",
  ],
  "mirror.resolve-accepted": ["repositoryId", "branch", "candidateSha"],
  "base.preflight": ["repositoryId", "branch", "candidateSha"],
  "base.preview": ["repositoryId", "branch"],
  "base.execute": [
    "repositoryId", "branch", "previewId", "previewVersion",
    "expectedHead", "candidateSha", "idempotencyKey", "actor",
  ],
  "hooks.diagnose": ["repositoryId"],
  "hooks.preview": ["repositoryId", "action"],
  "hooks.execute": [
    "repositoryId", "action", "previewId", "previewVersion",
    "expectedHead", "candidateSha", "idempotencyKey", "actor",
  ],
  "hooks.standalone-uninstall": [
    "repositoryId", "installationId", "manifestSha256", "idempotencyKey",
  ],
  "story.accepted.refresh": [
    "repositoryId", "branch", "storyId", "exactSha", "idempotencyKey",
  ],
  "story.repository.provision": [
    "tabId", "repositoryId", "branch", "exactSha",
    "idempotencyKey", "detached", "primary",
    "legacySourcePath", "legacyStateDigest",
  ],
  "story.repository.legacy-migration-preview": ["tabId", "repositoryId", "sourcePath"],
  "story.repository.inspect": ["tabId", "repositoryId"],
  "story.repository.commit": [
    "tabId", "repositoryId", "operationId", "expectedHead",
    "expectedBranch", "targetFlavor", "changeSummary", "declaredChanges",
    "requiredCheckReceiptIds",
  ],
  "story.repository.retire-preview": ["tabId", "repositoryId"],
  "story.repository.retire": [
    "tabId", "repositoryId", "previewId", "previewVersion", "expectedHead",
    "registryGeneration", "force", "idempotencyKey", "actor",
  ],
  "story.repository.cleanup": [
    "tabId", "repositoryId", "provisionOperationId", "expectedBaseRevision",
    "expectedHead", "registryGeneration", "idempotencyKey",
  ],
  "story.baseline.preview": ["tabId", "repositoryId", "strategy"],
  "story.baseline.execute": [
    "tabId", "repositoryId", "strategy", "previewId", "previewVersion",
    "expectedHead", "candidateSha", "mirrorGeneration", "idempotencyKey", "actor",
  ],
});

const REQUIRED = Object.freeze({
  "runtime.describe": ["attestationChallenge"],
  "registry.verify": ["repositoryId"],
  "sync.status": ["repositoryId", "branch"],
  "mirror.preview": ["repositoryId", "branch"],
  "mirror.read-accepted": ["repositoryId", "branch"],
  "mirror.execute": [
    "repositoryId", "branch", "previewId", "previewVersion",
    "candidateSha", "idempotencyKey",
  ],
  "mirror.resolve-accepted": ["repositoryId", "branch", "candidateSha"],
  "base.preflight": ["repositoryId", "branch", "candidateSha"],
  "base.preview": ["repositoryId", "branch"],
  "base.execute": [
    "repositoryId", "branch", "previewId", "previewVersion",
    "expectedHead", "candidateSha", "idempotencyKey",
  ],
  "hooks.diagnose": ["repositoryId"],
  "hooks.preview": ["repositoryId", "action"],
  "hooks.execute": [
    "repositoryId", "action", "previewId", "previewVersion",
    "expectedHead", "candidateSha", "idempotencyKey",
  ],
  "hooks.standalone-uninstall": [
    "repositoryId", "installationId", "manifestSha256", "idempotencyKey",
  ],
  "story.accepted.refresh": ["repositoryId", "branch", "storyId", "idempotencyKey"],
  "story.repository.provision": [
    "tabId", "repositoryId", "branch", "exactSha", "idempotencyKey",
  ],
  "story.repository.legacy-migration-preview": ["tabId", "repositoryId", "sourcePath"],
  "story.repository.inspect": ["tabId", "repositoryId"],
  "story.repository.commit": [
    "tabId", "repositoryId", "operationId", "expectedHead",
    "expectedBranch", "targetFlavor", "changeSummary", "declaredChanges",
    "requiredCheckReceiptIds",
  ],
  "story.repository.retire-preview": ["tabId", "repositoryId"],
  "story.repository.retire": [
    "tabId", "repositoryId", "previewId", "previewVersion", "expectedHead",
    "registryGeneration", "force", "idempotencyKey",
  ],
  "story.repository.cleanup": [
    "tabId", "repositoryId", "provisionOperationId", "expectedBaseRevision",
    "expectedHead", "registryGeneration", "idempotencyKey",
  ],
  "story.baseline.preview": ["tabId", "repositoryId", "strategy"],
  "story.baseline.execute": [
    "tabId", "repositoryId", "strategy", "previewId", "previewVersion",
    "expectedHead", "candidateSha", "mirrorGeneration", "idempotencyKey",
  ],
});

function protocolError(code, message, details = {}) {
  return new GitControllerError(code, message, details);
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, stable(value[key])]),
    );
  }
  return value;
}

export function canonicalProtocolJson(value) {
  return JSON.stringify(stable(value));
}

export function publicKeyFingerprint(publicKey) {
  return createHash("sha256").update(publicKey).digest("hex");
}

function exactObject(value, allowedFields) {
  return !!(
    value
    && typeof value === "object"
    && !Array.isArray(value)
    && Object.keys(value).every((key) => allowedFields.has(key))
    && [...allowedFields].every((key) => Object.hasOwn(value, key))
  );
}

function verifyDetachedReceipt(receipt, signature, publicKey, code, message) {
  if (publicKey?.asymmetricKeyType !== "ed25519") {
    throw protocolError(
      "GIT_CONTROLLER_PROCESS_TREE_GUARDIAN_KEY_ALGORITHM_INVALID",
      "Native process-tree guardian trust anchor must be an Ed25519 public key",
    );
  }
  let valid = false;
  try {
    valid = verifySignature(
      null,
      Buffer.from(canonicalProtocolJson(receipt)),
      publicKey,
      Buffer.from(String(signature || ""), "base64"),
    );
  } catch {
    valid = false;
  }
  if (!valid) throw protocolError(code, message);
}

export function verifyGitProcessContainmentReceiptEnvelope(envelope, {
  publicKey,
  platform = process.platform,
  mode = GIT_PROCESS_CONTAINMENT_MODES[platform],
  daemonInstanceId,
  ownerPid,
  ownerProcessStartIdentity,
  controllerIdentity,
  challenge,
  containerPolicyId,
  containerEpoch,
  policyDigest,
  guardianKeyId,
  guardianInstanceId,
  guardianBinarySha256,
  gitBinarySha256,
  now = Date.now(),
} = {}) {
  const envelopeFields = new Set(["receipt", "signature"]);
  const receiptFields = new Set([
    "schemaVersion",
    "receiptType",
    "daemonInstanceId",
    "pid",
    "processStartIdentity",
    "controllerIdentity",
    "challenge",
    "platform",
    "mode",
    "containerPolicyId",
    "containerEpoch",
    "policyDigest",
    "guardianKeyId",
    "guardianInstanceId",
    "guardianPid",
    "guardianProcessStartIdentity",
    "guardianBinarySha256",
    "gitBinarySha256",
    "issuedAt",
    "expiresAt",
    "currentProcessContained",
    "childInheritanceEnforced",
    "breakawayDenied",
    "controllerExitKillsTree",
    "recoveryCanProveEmpty",
  ]);
  const receipt = envelope?.receipt;
  const issuedAt = Number(receipt?.issuedAt);
  const expiresAt = Number(receipt?.expiresAt);
  if (
    !exactObject(envelope, envelopeFields)
    || !exactObject(receipt, receiptFields)
    || Number(receipt.schemaVersion) !== GIT_PROCESS_CONTAINMENT_RECEIPT_VERSION
    || receipt.receiptType !== "GIT_PROCESS_TREE_CONTAINMENT"
    || !mode
    || receipt.platform !== platform
    || receipt.mode !== mode
    || !UUID.test(String(daemonInstanceId || ""))
    || receipt.daemonInstanceId !== daemonInstanceId
    || !Number.isSafeInteger(Number(ownerPid))
    || Number(receipt.pid) !== Number(ownerPid)
    || !/^(?:linux|windows)-start:[A-Za-z0-9]+$/.test(
      String(ownerProcessStartIdentity || ""),
    )
    || receipt.processStartIdentity !== ownerProcessStartIdentity
    || String(receipt.controllerIdentity || "").toLowerCase()
      !== String(controllerIdentity || "").toLowerCase()
    || !ATTESTATION_CHALLENGE.test(String(challenge || ""))
    || receipt.challenge !== challenge
    || !CONTAINMENT_ID.test(String(containerPolicyId || ""))
    || receipt.containerPolicyId !== containerPolicyId
    || !CONTAINMENT_ID.test(String(receipt.containerEpoch || ""))
    || (containerEpoch && receipt.containerEpoch !== containerEpoch)
    || !/^[0-9a-f]{64}$/.test(String(policyDigest || ""))
    || receipt.policyDigest !== policyDigest
    || !/^[0-9a-f]{64}$/.test(String(guardianKeyId || ""))
    || receipt.guardianKeyId !== guardianKeyId
    || !CONTAINMENT_ID.test(String(receipt.guardianInstanceId || ""))
    || (guardianInstanceId && receipt.guardianInstanceId !== guardianInstanceId)
    || !Number.isSafeInteger(Number(receipt.guardianPid))
    || Number(receipt.guardianPid) <= 0
    || !/^(?:linux|windows)-start:[A-Za-z0-9]+$/.test(
      String(receipt.guardianProcessStartIdentity || ""),
    )
    || !/^[0-9a-f]{64}$/.test(String(guardianBinarySha256 || ""))
    || receipt.guardianBinarySha256 !== guardianBinarySha256
    || !/^[0-9a-f]{64}$/.test(String(gitBinarySha256 || ""))
    || receipt.gitBinarySha256 !== gitBinarySha256
    || !Number.isSafeInteger(issuedAt)
    || !Number.isSafeInteger(expiresAt)
    || issuedAt > Number(now) + GIT_PROCESS_CONTAINMENT_MAX_TTL_MS
    || expiresAt <= Number(now)
    || expiresAt <= issuedAt
    || expiresAt - issuedAt > GIT_PROCESS_CONTAINMENT_MAX_TTL_MS
    || Number(now) - issuedAt > GIT_PROCESS_CONTAINMENT_MAX_TTL_MS
    || receipt.currentProcessContained !== true
    || receipt.childInheritanceEnforced !== true
    || receipt.breakawayDenied !== true
    || receipt.controllerExitKillsTree !== true
    || receipt.recoveryCanProveEmpty !== true
  ) {
    throw protocolError(
      "GIT_CONTROLLER_PROCESS_TREE_ATTESTATION_INVALID",
      "Guardian containment receipt is invalid, stale, or not bound to this Controller challenge",
    );
  }
  verifyDetachedReceipt(
    receipt,
    envelope.signature,
    publicKey,
    "GIT_CONTROLLER_PROCESS_TREE_ATTESTATION_SIGNATURE_INVALID",
    "Guardian containment receipt signature is invalid",
  );
  return Object.freeze({
    receipt: Object.freeze({ ...receipt }),
    signature: String(envelope.signature),
  });
}

export function verifyGitProcessTreeRecoveryReceiptEnvelope(envelope, {
  publicKey,
  platform = process.platform,
  mode = GIT_PROCESS_CONTAINMENT_MODES[platform],
  daemonInstanceId,
  challenge,
  containerPolicyId,
  currentContainerEpoch,
  priorContainerEpoch,
  policyDigest,
  guardianKeyId,
  guardianInstanceId,
  guardianBinarySha256,
  gitBinarySha256,
  now = Date.now(),
} = {}) {
  const envelopeFields = new Set(["receipt", "signature"]);
  const receiptFields = new Set([
    "schemaVersion",
    "receiptType",
    "daemonInstanceId",
    "challenge",
    "platform",
    "mode",
    "containerPolicyId",
    "currentContainerEpoch",
    "priorContainerEpoch",
    "policyDigest",
    "guardianKeyId",
    "guardianInstanceId",
    "guardianBinarySha256",
    "gitBinarySha256",
    "tombstoneId",
    "sealedAt",
    "issuedAt",
    "expiresAt",
    "containerSealed",
    "activeProcessCount",
  ]);
  const receipt = envelope?.receipt;
  const sealedAt = Number(receipt?.sealedAt);
  const issuedAt = Number(receipt?.issuedAt);
  const expiresAt = Number(receipt?.expiresAt);
  if (
    !exactObject(envelope, envelopeFields)
    || !exactObject(receipt, receiptFields)
    || Number(receipt.schemaVersion) !== GIT_PROCESS_CONTAINMENT_RECEIPT_VERSION
    || receipt.receiptType !== "GIT_PROCESS_TREE_RECOVERY_EMPTY"
    || !mode
    || receipt.platform !== platform
    || receipt.mode !== mode
    || receipt.daemonInstanceId !== daemonInstanceId
    || receipt.challenge !== challenge
    || receipt.containerPolicyId !== containerPolicyId
    || !CONTAINMENT_ID.test(String(currentContainerEpoch || ""))
    || receipt.currentContainerEpoch !== currentContainerEpoch
    || !CONTAINMENT_ID.test(String(priorContainerEpoch || ""))
    || priorContainerEpoch === currentContainerEpoch
    || receipt.priorContainerEpoch !== priorContainerEpoch
    || receipt.policyDigest !== policyDigest
    || receipt.guardianKeyId !== guardianKeyId
    || !CONTAINMENT_ID.test(String(guardianInstanceId || ""))
    || receipt.guardianInstanceId !== guardianInstanceId
    || receipt.guardianBinarySha256 !== guardianBinarySha256
    || receipt.gitBinarySha256 !== gitBinarySha256
    || !CONTAINMENT_ID.test(String(receipt.tombstoneId || ""))
    || !Number.isSafeInteger(sealedAt)
    || !Number.isSafeInteger(issuedAt)
    || !Number.isSafeInteger(expiresAt)
    || sealedAt > issuedAt
    || issuedAt > Number(now) + GIT_PROCESS_CONTAINMENT_MAX_TTL_MS
    || expiresAt <= Number(now)
    || expiresAt <= issuedAt
    || expiresAt - issuedAt > GIT_PROCESS_CONTAINMENT_MAX_TTL_MS
    || Number(now) - issuedAt > GIT_PROCESS_CONTAINMENT_MAX_TTL_MS
    || receipt.containerSealed !== true
    || Number(receipt.activeProcessCount) !== 0
  ) {
    throw protocolError(
      "GIT_CONTROLLER_PROCESS_TREE_RECOVERY_UNVERIFIED",
      "Guardian recovery receipt does not prove the prior container was sealed and emptied",
    );
  }
  verifyDetachedReceipt(
    receipt,
    envelope.signature,
    publicKey,
    "GIT_CONTROLLER_PROCESS_TREE_RECOVERY_SIGNATURE_INVALID",
    "Guardian process-tree recovery receipt signature is invalid",
  );
  return Object.freeze({
    receipt: Object.freeze({ ...receipt }),
    signature: String(envelope.signature),
  });
}

export function storyAcceptedRefreshIdempotencyKey({
  storyId,
  repositoryId,
  branch,
  exactSha = "",
} = {}) {
  return createHash("sha256").update([
    "story-provision",
    String(storyId || ""),
    String(repositoryId || ""),
    String(branch || ""),
    String(exactSha || ""),
  ].join("\0")).digest("hex");
}

export function validateControllerEndpoint(value, {
  platform = process.platform,
} = {}) {
  const endpoint = String(value || "").trim();
  if (platform === "win32") {
    if (!/^\\\\\.\\pipe\\devbench-git-controller-[A-Za-z0-9._-]{1,80}$/.test(endpoint)) {
      throw protocolError(
        "GIT_CONTROLLER_ENDPOINT_INVALID",
        "Production Git Controller endpoint must be a fixed DevBench named pipe",
      );
    }
    return endpoint;
  }
  if (!path.isAbsolute(endpoint) || !endpoint.endsWith(".sock")) {
    throw protocolError(
      "GIT_CONTROLLER_ENDPOINT_INVALID",
      "Production Git Controller endpoint must be an absolute Unix socket path",
    );
  }
  const normalized = path.normalize(endpoint);
  if (normalized !== endpoint || endpoint.includes("\0")) {
    throw protocolError(
      "GIT_CONTROLLER_ENDPOINT_INVALID",
      "Git Controller Unix socket path is not canonical",
    );
  }
  return endpoint;
}

export function currentProcessIdentity({
  platform = process.platform,
  uid = typeof process.getuid === "function" ? process.getuid() : null,
} = {}) {
  if (platform !== "win32") {
    if (!Number.isSafeInteger(uid) || uid < 0) {
      throw protocolError(
        "GIT_CONTROLLER_IDENTITY_UNAVAILABLE",
        "Unable to determine the current process UID",
      );
    }
    return `uid:${uid}`;
  }
  try {
    const output = execFileSync(WINDOWS_WHOAMI, ["/user", "/fo", "csv", "/nh"], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 5_000,
      maxBuffer: 16 * 1024,
    });
    const match = output.match(/"(S-\d-(?:\d+-)+\d+)"/i);
    if (!match) throw new Error("SID missing");
    return `sid:${match[1].toUpperCase()}`;
  } catch (error) {
    throw protocolError(
      "GIT_CONTROLLER_IDENTITY_UNAVAILABLE",
      "Unable to determine the current Windows process SID",
      { cause: String(error?.code || "WHOAMI_FAILED") },
    );
  }
}

function protectedFileLabel(label) {
  return label || "Controller trust file";
}

function statNumber(stat, field) {
  return Number(stat?.[field]);
}

function sameStatFields(left, right, fields) {
  return fields.every((field) => left?.[field] === right?.[field]);
}

function hasStableFileIdentity(stat) {
  const ino = stat?.ino;
  return (
    (typeof ino === "bigint" && ino !== 0n)
    || (Number.isSafeInteger(ino) && ino !== 0)
  );
}

function sameFileIdentity(left, right) {
  return (
    hasStableFileIdentity(left)
    && hasStableFileIdentity(right)
    && sameStatFields(left, right, ["dev", "ino"])
  );
}

function sameStableFileState(left, right) {
  return sameStatFields(left, right, [
    "dev",
    "ino",
    "mode",
    "nlink",
    "uid",
    "gid",
    "size",
    "mtimeNs",
    "ctimeNs",
    "birthtimeNs",
  ]);
}

function protectedFileIdentityDrift(label) {
  return protocolError(
    "GIT_CONTROLLER_TRUST_FILE_IDENTITY_DRIFT",
    `${protectedFileLabel(label)} changed while it was being verified`,
  );
}

function parentChain(resolved) {
  const result = [];
  let current = path.dirname(resolved);
  while (true) {
    result.push(current);
    const next = path.dirname(current);
    if (next === current) break;
    current = next;
  }
  return result;
}

function lstatBigInt(fsApi, target) {
  return fsApi.lstatSync(target, { bigint: true });
}

function captureProtectedPath(fsApi, resolved, label) {
  const leaf = lstatBigInt(fsApi, resolved);
  if (
    !leaf.isFile()
    || leaf.isSymbolicLink()
    || !hasStableFileIdentity(leaf)
    || statNumber(leaf, "nlink") !== 1
  ) {
    throw protocolError(
      "GIT_CONTROLLER_TRUST_FILE_INVALID",
      `${protectedFileLabel(label)} must be a single regular non-symlink file`,
    );
  }
  const parents = parentChain(resolved).map((parentPath) => {
    const stat = lstatBigInt(fsApi, parentPath);
    if (
      !stat.isDirectory()
      || stat.isSymbolicLink()
      || !hasStableFileIdentity(stat)
    ) {
      throw protocolError(
        "GIT_CONTROLLER_TRUST_FILE_INVALID",
        `${protectedFileLabel(label)} parent chain must contain only plain directories`,
      );
    }
    return { path: parentPath, stat };
  });
  return { leaf, parents };
}

function assertSameProtectedPath(before, after, label) {
  if (
    !sameStableFileState(before.leaf, after.leaf)
    || before.parents.length !== after.parents.length
    || before.parents.some((entry, index) => (
      entry.path !== after.parents[index]?.path
      || !sameStatFields(entry.stat, after.parents[index]?.stat, [
        "dev",
        "ino",
        "mode",
        "nlink",
        "uid",
        "gid",
        "size",
        "mtimeNs",
        "ctimeNs",
        "birthtimeNs",
      ])
    ))
  ) {
    throw protectedFileIdentityDrift(label);
  }
}

function validateUnixProtectedPath(snapshot, {
  label,
  secret,
  serviceUid = typeof process.getuid === "function" ? process.getuid() : null,
} = {}) {
  const allowedOwners = new Set([
    0,
    ...(Number.isSafeInteger(serviceUid) && serviceUid >= 0 ? [serviceUid] : []),
  ]);
  for (const { stat } of snapshot.parents) {
    if (
      !allowedOwners.has(statNumber(stat, "uid"))
      || (statNumber(stat, "mode") & 0o022) !== 0
    ) {
      throw protocolError(
        "GIT_CONTROLLER_TRUST_FILE_PERMISSIONS",
        `${protectedFileLabel(label)} has an unsafe Unix parent owner or mode`,
      );
    }
  }
  const forbidden = secret ? 0o077 : 0o022;
  if ((statNumber(snapshot.leaf, "mode") & forbidden) !== 0) {
    throw protocolError(
      "GIT_CONTROLLER_TRUST_FILE_PERMISSIONS",
      `${protectedFileLabel(label)} has unsafe Unix permissions`,
    );
  }
}

function probeWindowsProtectedPath({
  resolved,
  parents,
  secret,
}) {
  const encodedPaths = Buffer.from(
    JSON.stringify([resolved, ...parents]),
    "utf8",
  ).toString("base64");
  const script = [
    "$ErrorActionPreference='Stop'",
    `$paths=ConvertFrom-Json ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedPaths}')))`,
    "$me=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value.ToUpperInvariant()",
    "$leafAllowed=@($me,'S-1-5-18','S-1-5-32-544')",
    "$parentAllowed=@($leafAllowed+'S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464')",
    "$leafWrite=[int64]([Security.AccessControl.FileSystemRights]::WriteData -bor [Security.AccessControl.FileSystemRights]::AppendData -bor [Security.AccessControl.FileSystemRights]::WriteAttributes -bor [Security.AccessControl.FileSystemRights]::WriteExtendedAttributes -bor [Security.AccessControl.FileSystemRights]::Delete -bor [Security.AccessControl.FileSystemRights]::ChangePermissions -bor [Security.AccessControl.FileSystemRights]::TakeOwnership)",
    "$leafRead=[int64]([Security.AccessControl.FileSystemRights]::ReadData -bor [Security.AccessControl.FileSystemRights]::ReadAttributes -bor [Security.AccessControl.FileSystemRights]::ReadExtendedAttributes -bor [Security.AccessControl.FileSystemRights]::ReadPermissions)",
    "$parentMutation=[int64]([Security.AccessControl.FileSystemRights]::CreateFiles -bor [Security.AccessControl.FileSystemRights]::CreateDirectories -bor [Security.AccessControl.FileSystemRights]::Delete -bor [Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles -bor [Security.AccessControl.FileSystemRights]::ChangePermissions -bor [Security.AccessControl.FileSystemRights]::TakeOwnership)",
    "$genericWrite=[int64]0x40000000",
    "$genericRead=[int64]0x80000000",
    "$genericExecute=[int64]0x20000000",
    "$genericAll=[int64]0x10000000",
    "$leafWrite=($leafWrite -bor $genericWrite -bor $genericAll)",
    "$leafRead=($leafRead -bor $genericRead -bor $genericExecute -bor $genericAll)",
    "$parentMutation=($parentMutation -bor $genericWrite -bor $genericAll)",
    "$inheritOnly=[int][Security.AccessControl.PropagationFlags]::InheritOnly",
    "$unsafe=@()",
    "$invalid=@()",
    "$descriptors=@()",
    "for($index=0;$index -lt $paths.Count;$index++){",
    " $candidate=[string]$paths[$index]",
    " $item=Get-Item -Force -LiteralPath $candidate",
    " if(($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0){$invalid+=@('reparse:'+$index)}",
    " $acl=Get-Acl -LiteralPath $candidate",
    " $allowed=if($index -eq 0){$leafAllowed}else{$parentAllowed}",
    " $owner=$acl.GetOwner([Security.Principal.SecurityIdentifier]).Value.ToUpperInvariant()",
    " if($allowed -notcontains $owner){$unsafe+=@('owner:'+$index+':'+$owner)}",
    " $binary=$acl.GetSecurityDescriptorBinaryForm()",
    " $raw=[Security.AccessControl.RawSecurityDescriptor]::new($binary,0)",
    " if($null -eq $raw.DiscretionaryAcl){$unsafe+=@('null-dacl:'+$index)}",
    " foreach($rule in $acl.Access){",
    "  if($rule.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow){continue}",
    "  if((([int]$rule.PropagationFlags -band $inheritOnly) -ne 0)){continue}",
    "  try{$sid=$rule.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value}catch{$sid=$rule.IdentityReference.Value}",
    "  $sid=$sid.ToUpperInvariant()",
    "  if($allowed -contains $sid){continue}",
    "  $rights=[int64]$rule.FileSystemRights",
    `  $mask=if($index -eq 0){${secret ? "($leafRead -bor $leafWrite)" : "$leafWrite"}}else{$parentMutation}`,
    "  if(($rights -band $mask) -ne 0){$unsafe+=@('ace:'+$index+':'+$sid)}",
    " }",
    " $sddl=$acl.GetSecurityDescriptorSddlForm([Security.AccessControl.AccessControlSections]'Owner,Group,Access')",
    " $descriptors+=@($candidate+'='+$sddl)",
    "}",
    "$result=[PSCustomObject]@{unsafe=@($unsafe|Sort-Object -Unique);invalid=@($invalid|Sort-Object -Unique);descriptor=($descriptors -join \"`n\")}",
    "$result|ConvertTo-Json -Compress -Depth 4",
  ].join(";");
  const output = execFileSync(
    WINDOWS_POWERSHELL,
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
    {
      encoding: "utf8",
      windowsHide: true,
      timeout: 10_000,
      maxBuffer: 128 * 1024,
    },
  ).trim();
  const result = JSON.parse(output);
  if (
    !result
    || typeof result !== "object"
    || typeof result.descriptor !== "string"
    || !Array.isArray(result.unsafe)
    || !Array.isArray(result.invalid)
  ) {
    throw new Error("invalid ACL probe result");
  }
  return result;
}

function validateWindowsProtectedPath(snapshot, {
  resolved,
  label,
  secret,
  windowsAclProbe = probeWindowsProtectedPath,
} = {}) {
  let result;
  try {
    result = windowsAclProbe({
      resolved,
      parents: snapshot.parents.map((entry) => entry.path),
      secret,
    });
  } catch (error) {
    throw protocolError(
      "GIT_CONTROLLER_TRUST_FILE_ACL_UNVERIFIED",
      `${protectedFileLabel(label)} Windows ACL could not be verified`,
      { cause: String(error?.code || "ACL_PROBE_FAILED") },
    );
  }
  if (
    !result
    || typeof result.descriptor !== "string"
    || !Array.isArray(result.unsafe)
    || !Array.isArray(result.invalid)
  ) {
    throw protocolError(
      "GIT_CONTROLLER_TRUST_FILE_ACL_UNVERIFIED",
      `${protectedFileLabel(label)} Windows ACL could not be verified`,
      { cause: "ACL_PROBE_RESULT_INVALID" },
    );
  }
  if (result.invalid.length > 0) {
    throw protocolError(
      "GIT_CONTROLLER_TRUST_FILE_INVALID",
      `${protectedFileLabel(label)} traverses a Windows reparse point`,
    );
  }
  if (result.unsafe.length > 0) {
    throw protocolError(
      "GIT_CONTROLLER_TRUST_FILE_PERMISSIONS",
      `${protectedFileLabel(label)} grants unsafe Windows path access`,
    );
  }
  return result.descriptor;
}

function readProtectedFileWithInternals(filePath, {
  label,
  secret = false,
  platform = process.platform,
} = {}, {
  fsApi = fs,
  serviceUid,
  windowsAclProbe,
  afterValidation,
  afterOpen,
  afterRead,
} = {}) {
  const input = String(filePath || "").trim();
  if (!path.isAbsolute(input) || input.includes("\0")) {
    throw protocolError(
      "GIT_CONTROLLER_TRUST_FILE_INVALID",
      `${protectedFileLabel(label)} must use an absolute path`,
    );
  }
  const resolved = path.resolve(input);
  const initial = captureProtectedPath(fsApi, resolved, label);
  let initialAclDescriptor = "";
  if (platform !== "win32") {
    validateUnixProtectedPath(initial, { label, secret, serviceUid });
  } else {
    initialAclDescriptor = validateWindowsProtectedPath(initial, {
      resolved,
      label,
      secret,
      windowsAclProbe,
    });
  }
  afterValidation?.({ resolved });

  let descriptor;
  try {
    descriptor = fsApi.openSync(
      resolved,
      platform !== "win32" && Number.isInteger(fsApi.constants?.O_NOFOLLOW)
        ? fsApi.constants.O_RDONLY | fsApi.constants.O_NOFOLLOW
        : fsApi.constants.O_RDONLY,
    );
  } catch {
    throw protectedFileIdentityDrift(label);
  }
  try {
    const beforeRead = fsApi.fstatSync(descriptor, { bigint: true });
    if (
      !beforeRead.isFile()
      || beforeRead.isSymbolicLink()
      || statNumber(beforeRead, "nlink") !== 1
      || !sameStableFileState(initial.leaf, beforeRead)
    ) {
      throw protectedFileIdentityDrift(label);
    }
    afterOpen?.({ resolved, descriptor });
    const buffer = fsApi.readFileSync(descriptor);
    afterRead?.({ resolved, descriptor, buffer });
    const afterReadStat = fsApi.fstatSync(descriptor, { bigint: true });
    if (
      !afterReadStat.isFile()
      || afterReadStat.isSymbolicLink()
      || statNumber(afterReadStat, "nlink") !== 1
      || BigInt(buffer.length) !== afterReadStat.size
      || !sameStableFileState(beforeRead, afterReadStat)
    ) {
      throw protectedFileIdentityDrift(label);
    }

    let afterReadPath;
    try {
      afterReadPath = captureProtectedPath(fsApi, resolved, label);
    } catch {
      throw protectedFileIdentityDrift(label);
    }
    assertSameProtectedPath(initial, afterReadPath, label);
    if (!sameFileIdentity(afterReadStat, afterReadPath.leaf)) {
      throw protectedFileIdentityDrift(label);
    }

    if (platform === "win32") {
      const finalAclDescriptor = validateWindowsProtectedPath(afterReadPath, {
        resolved,
        label,
        secret,
        windowsAclProbe,
      });
      if (finalAclDescriptor !== initialAclDescriptor) {
        throw protectedFileIdentityDrift(label);
      }
      let finalPath;
      try {
        finalPath = captureProtectedPath(fsApi, resolved, label);
      } catch {
        throw protectedFileIdentityDrift(label);
      }
      assertSameProtectedPath(afterReadPath, finalPath, label);
      if (!sameFileIdentity(afterReadStat, finalPath.leaf)) {
        throw protectedFileIdentityDrift(label);
      }
    }
    return Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  } finally {
    try {
      fsApi.closeSync(descriptor);
    } catch {
      // The trust decision is already fail-closed; a close failure must not mask it.
    }
  }
}

export function readProtectedFile(filePath, options = {}) {
  return readProtectedFileWithInternals(filePath, options);
}

function assertSafeScalar(name, value) {
  if (typeof value === "object" && value !== null) {
    throw protocolError(
      "GIT_CONTROLLER_COMMAND_FIELD_INVALID",
      `Controller command field ${name} must be scalar`,
    );
  }
  const text = String(value ?? "");
  const maxLength = ["sourcePath", "legacySourcePath"].includes(name) ? 32_767 : 500;
  if (text.length > maxLength || /[\0\r\n]/.test(text)) {
    throw protocolError(
      "GIT_CONTROLLER_COMMAND_FIELD_INVALID",
      `Controller command field ${name} is invalid`,
    );
  }
  if (
    name === "repositoryId"
    || name === "tabId"
    || name === "storyId"
    || name === "operationId"
  ) {
    if (!ID.test(text)) {
      throw protocolError("GIT_CONTROLLER_COMMAND_FIELD_INVALID", `${name} is invalid`);
    }
  } else if (name === "branch" || name === "expectedBranch") {
    if (!BRANCH.test(text)) {
      throw protocolError("GIT_CONTROLLER_COMMAND_FIELD_INVALID", "branch is invalid");
    }
  } else if (["sourcePath", "legacySourcePath"].includes(name)) {
    if (!path.isAbsolute(text)) {
      throw protocolError(
        "GIT_CONTROLLER_COMMAND_FIELD_INVALID",
        `${name} must be an absolute path`,
      );
    }
  } else if (name === "legacyStateDigest" && !/^[0-9a-f]{64}$/.test(text)) {
    throw protocolError(
      "GIT_CONTROLLER_COMMAND_FIELD_INVALID",
      "legacyStateDigest is invalid",
    );
  } else if (["candidateSha", "expectedHead", "expectedBaseRevision"].includes(name)) {
    if (!SHA.test(text)) {
      throw protocolError("GIT_CONTROLLER_COMMAND_FIELD_INVALID", `${name} is invalid`);
    }
  } else if (["expectedAcceptedSha", "exactSha"].includes(name)) {
    if (!OPTIONAL_SHA.test(text)) {
      throw protocolError("GIT_CONTROLLER_COMMAND_FIELD_INVALID", `${name} is invalid`);
    }
  } else if (name === "attestationChallenge") {
    if (!ATTESTATION_CHALLENGE.test(text)) {
      throw protocolError(
        "GIT_CONTROLLER_COMMAND_FIELD_INVALID",
        "attestationChallenge is invalid",
      );
    }
  } else if (
    name === "previewVersion"
    || name === "mirrorGeneration"
    || name === "registryGeneration"
    || name === "adminApprovedAt"
    || name === "adminApprovalExpiresAt"
    || name === "adminApprovedPreviewVersion"
  ) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw protocolError("GIT_CONTROLLER_COMMAND_FIELD_INVALID", `${name} is invalid`);
    }
  } else if (name === "action" && !["install", "uninstall"].includes(text)) {
    throw protocolError("GIT_CONTROLLER_COMMAND_FIELD_INVALID", "hooks action is invalid");
  } else if (name === "strategy" && !["FF_ONLY", "MERGE"].includes(text)) {
    throw protocolError("GIT_CONTROLLER_COMMAND_FIELD_INVALID", "baseline strategy is invalid");
  } else if (
    (name === "idempotencyKey" || name === "provisionOperationId")
    && !ID.test(text)
  ) {
    throw protocolError("GIT_CONTROLLER_COMMAND_FIELD_INVALID", "idempotencyKey is invalid");
  } else if (["detached", "force", "primary"].includes(name) && typeof value !== "boolean") {
    throw protocolError("GIT_CONTROLLER_COMMAND_FIELD_INVALID", `${name} must be boolean`);
  } else if (name === "manifestSha256" && !/^[0-9a-f]{64}$/.test(text)) {
    throw protocolError("GIT_CONTROLLER_COMMAND_FIELD_INVALID", "manifestSha256 is invalid");
  } else if (name === "adminApprovedImpactDigest" && !/^[0-9a-f]{64}$/.test(text)) {
    throw protocolError(
      "GIT_CONTROLLER_COMMAND_FIELD_INVALID",
      "adminApprovedImpactDigest is invalid",
    );
  } else if (name === "installationId" && !ID.test(text)) {
    throw protocolError("GIT_CONTROLLER_COMMAND_FIELD_INVALID", "installationId is invalid");
  } else if (name === "adminApprovedPreviewId" && !ID.test(text)) {
    throw protocolError("GIT_CONTROLLER_COMMAND_FIELD_INVALID", "adminApprovedPreviewId is invalid");
  } else if (name === "adminApprovedCandidateSha" && !SHA.test(text)) {
    throw protocolError("GIT_CONTROLLER_COMMAND_FIELD_INVALID", "adminApprovedCandidateSha is invalid");
  } else if (name === "adminApprovedPreviousSha" && !OPTIONAL_SHA.test(text)) {
    throw protocolError("GIT_CONTROLLER_COMMAND_FIELD_INVALID", "adminApprovedPreviousSha is invalid");
  } else if (name === "targetFlavor" && !/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(text)) {
    throw protocolError("GIT_CONTROLLER_COMMAND_FIELD_INVALID", "targetFlavor is invalid");
  } else if (
    name === "changeSummary"
    && (
      text.length > 120
      || !/[\u3400-\u9fff]/u.test(text)
      || /^\s*(?:Co-Authored-By|Signed-off-by|Reviewed-by|Tested-by|Fixes|Closes|Refs)\s*:/i.test(text)
    )
  ) {
    throw protocolError(
      "GIT_CONTROLLER_COMMAND_FIELD_INVALID",
      "changeSummary must be a bounded Chinese description",
    );
  }
}

function assertStructuredCommitArray(name, value) {
  if (!Array.isArray(value) || value.length === 0 || value.length > 512) {
    throw protocolError(
      "GIT_CONTROLLER_COMMAND_FIELD_INVALID",
      `${name} must be a non-empty bounded array`,
    );
  }
  const normalized = [];
  const seen = new Set();
  for (const item of value) {
    if (typeof item !== "string") {
      throw protocolError(
        "GIT_CONTROLLER_COMMAND_FIELD_INVALID",
        `${name} entries must be strings`,
      );
    }
    const text = item.trim().replace(/\\/g, "/");
    if (
      !text
      || text.length > 500
      || /[\0\r\n]/.test(text)
      || seen.has(text)
    ) {
      throw protocolError(
        "GIT_CONTROLLER_COMMAND_FIELD_INVALID",
        `${name} contains an invalid or duplicate entry`,
      );
    }
    if (name === "declaredChanges") {
      const segments = text.split("/");
      if (
        path.isAbsolute(text)
        || segments.some((segment) => !segment || segment === "." || segment === "..")
        || segments[0].toLowerCase() === ".git"
      ) {
        throw protocolError(
          "GIT_CONTROLLER_COMMAND_FIELD_INVALID",
          "declaredChanges must contain repository-relative paths",
        );
      }
    } else if (!ID.test(text)) {
      throw protocolError(
        "GIT_CONTROLLER_COMMAND_FIELD_INVALID",
        "requiredCheckReceiptIds contains an invalid receipt identity",
      );
    }
    seen.add(text);
    normalized.push(text);
  }
  return normalized.sort();
}

export function validateControllerCommand(commandIdValue, payloadValue = {}) {
  const commandId = String(commandIdValue || "").trim();
  const fields = COMMAND_FIELDS[commandId];
  if (!fields) {
    throw protocolError(
      "GIT_CONTROLLER_COMMAND_NOT_ALLOWED",
      "Git Controller command is not in the structured command allowlist",
      { commandId },
    );
  }
  const payload = payloadValue && typeof payloadValue === "object" && !Array.isArray(payloadValue)
    ? payloadValue
    : {};
  const unknown = Object.keys(payload).filter((key) => !fields.includes(key));
  if (unknown.length) {
    throw protocolError(
      "GIT_CONTROLLER_COMMAND_FIELD_REJECTED",
      "Git Controller request contains forbidden fields",
      { fields: unknown.sort() },
    );
  }
  for (const required of REQUIRED[commandId] || []) {
    if (payload[required] == null || payload[required] === "") {
      throw protocolError(
        "GIT_CONTROLLER_COMMAND_FIELD_REQUIRED",
        `Git Controller command requires ${required}`,
      );
    }
  }
  const normalizedPayload = { ...payload };
  for (const [name, value] of Object.entries(payload)) {
    if (name === "declaredChanges" || name === "requiredCheckReceiptIds") {
      normalizedPayload[name] = assertStructuredCommitArray(name, value);
    } else {
      assertSafeScalar(name, value);
    }
  }
  if (
    commandId === "story.repository.provision"
    && Boolean(payload.legacySourcePath) !== Boolean(payload.legacyStateDigest)
  ) {
    throw protocolError(
      "GIT_CONTROLLER_COMMAND_FIELD_REQUIRED",
      "Legacy migration requires both legacySourcePath and legacyStateDigest",
    );
  }
  return { commandId, payload: normalizedPayload };
}

export function signControllerRequest(unsigned, secret) {
  return createHmac("sha256", secret)
    .update(canonicalProtocolJson(unsigned))
    .digest("hex");
}

export function verifyControllerRequestMac(unsigned, macValue, secret) {
  const expected = Buffer.from(signControllerRequest(unsigned, secret), "hex");
  const actual = Buffer.from(String(macValue || ""), "hex");
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export function verifyControllerResponseEnvelope(envelope, {
  publicKey,
  expectedEndpoint,
  expectedControllerIdentity,
  expectedEndpointAclFingerprint,
  expectedKeyFingerprint,
  requestId,
  now = Date.now(),
  clockSkewMs = GIT_CONTROLLER_CLOCK_SKEW_MS,
  gatewayIdentity = currentProcessIdentity(),
} = {}) {
  if (!envelope || typeof envelope !== "object" || !envelope.signature) {
    throw protocolError(
      "GIT_CONTROLLER_RESPONSE_UNSIGNED",
      "Git Controller response is unsigned",
    );
  }
  const { signature, ...unsigned } = envelope;
  const signatureOk = verifySignature(
    null,
    Buffer.from(canonicalProtocolJson(unsigned)),
    publicKey,
    Buffer.from(String(signature), "base64"),
  );
  if (!signatureOk) {
    throw protocolError(
      "GIT_CONTROLLER_RESPONSE_SIGNATURE_INVALID",
      "Git Controller response signature is invalid",
    );
  }
  if (
    unsigned.version !== GIT_CONTROLLER_PROTOCOL_VERSION
    || unsigned.requestId !== requestId
    || unsigned.endpoint !== expectedEndpoint
    || unsigned.controllerIdentity !== expectedControllerIdentity
    || unsigned.controllerIdentity === gatewayIdentity
    || unsigned.endpointAclFingerprint !== expectedEndpointAclFingerprint
    || unsigned.keyFingerprint !== expectedKeyFingerprint
    || !Number.isSafeInteger(unsigned.timestamp)
    || Math.abs(now - unsigned.timestamp) > clockSkewMs
  ) {
    throw protocolError(
      "GIT_CONTROLLER_ATTESTATION_MISMATCH",
      "Git Controller deployment attestation does not match the fixed client trust policy",
    );
  }
  return unsigned;
}

export function createControllerRequest({
  commandId,
  payload,
  clientId,
  clientIdentity = currentProcessIdentity(),
  secret,
  now = Date.now(),
} = {}) {
  const validated = validateControllerCommand(commandId, payload);
  if (!ID.test(String(clientId || ""))) {
    throw protocolError("GIT_CONTROLLER_CLIENT_ID_INVALID", "Controller client ID is invalid");
  }
  const unsigned = {
    version: GIT_CONTROLLER_PROTOCOL_VERSION,
    requestId: randomBytes(16).toString("hex"),
    timestamp: now,
    nonce: randomBytes(24).toString("hex"),
    clientId: String(clientId),
    clientIdentity: String(clientIdentity),
    commandId: validated.commandId,
    payload: validated.payload,
  };
  return { ...unsigned, mac: signControllerRequest(unsigned, secret) };
}

export function hostLabel() {
  return String(os.hostname() || "unknown").slice(0, 120);
}

export const __test = Object.freeze({
  ATTESTATION_CHALLENGE,
  BRANCH,
  COMMAND_FIELDS,
  ID,
  OPTIONAL_SHA,
  REQUIRED,
  SHA,
  readProtectedFileWithInternals,
  validateUnixProtectedPath,
});
const WINDOWS_SYSTEM32 = "C:\\Windows\\System32";
const WINDOWS_WHOAMI = path.join(WINDOWS_SYSTEM32, "whoami.exe");
const WINDOWS_POWERSHELL = path.join(
  WINDOWS_SYSTEM32,
  "WindowsPowerShell",
  "v1.0",
  "powershell.exe",
);
