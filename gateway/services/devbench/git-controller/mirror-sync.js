import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import * as defaultPersistence from "../../../db/sqlite.js";
import {
  GitControllerError,
  canonicalizeManagedPath,
  ensureManagedDirectory,
  normalizeSha,
  assertIdempotencyKey,
  runGitFile,
} from "./path-security.js";
import { listAllRecoverableOperations } from "./journal.js";
import {
  controllerAcceptedHistoryRef,
  controllerAcceptedRef,
  controllerIncomingRef,
} from "./internal-refs.js";

const MIRROR_PREVIEW_KIND = "MIRROR_REFRESH";
const MIRROR_OPERATION_TYPE = "MIRROR_REFRESH";
const MIRROR_COMMAND_ID = "mirror.refresh.accept";
const ADMIN_APPROVAL_MAX_TTL_MS = 10 * 60_000;
const ADMIN_APPROVAL_CLOCK_SKEW_MS = 30_000;
const APPROVAL_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const REWRITE_IMPACT_VERSION = 1;
const REWRITE_DROPPED_COMMIT_LIMIT = 256;
const REWRITE_AFFECTED_STORY_LIMIT = 256;
const REWRITE_ACTIVE_STORY_SCAN_LIMIT = 4096;
const REWRITE_RELATIONSHIPS = Object.freeze([
  "REMOTE_REWIND",
  "DIVERGED_FROM_ACCEPTED",
]);

function asControllerError(error, fallbackCode = "GIT_CONTROLLER_MIRROR_SYNC_FAILED") {
  if (error instanceof GitControllerError) return error;
  return new GitControllerError(
    fallbackCode,
    "Managed mirror synchronization failed",
    { cause: error?.code || error?.message || String(error) },
    { cause: error },
  );
}

function replayOrThrow(operation) {
  if (operation.status === "SUCCEEDED" && operation.result) {
    return { ...operation.result, replayed: true };
  }
  if (operation.status === "RUNNING") {
    throw new GitControllerError(
      "GIT_CONTROLLER_OPERATION_IN_PROGRESS",
      "An operation with this idempotency key is still running",
      { operationId: operation.operationId },
    );
  }
  const stored = operation.error || {};
  throw new GitControllerError(
    stored.code || operation.resultCode || "GIT_CONTROLLER_OPERATION_FAILED",
    stored.message || "The idempotent operation previously failed",
    { ...(stored.details || {}), operationId: operation.operationId, replayed: true },
  );
}

function assertReplayBinding(operation, {
  previewId,
  branch,
  expectedHead,
  candidateSha,
}) {
  if (
    operation.previewId !== previewId
    || operation.branch !== branch
    || operation.expectedHead !== expectedHead
    || operation.candidateSha !== candidateSha
  ) {
    throw new GitControllerError(
      "GIT_CONTROLLER_IDEMPOTENCY_CONFLICT",
      "Idempotency key was already used for a different mirror refresh request",
      { operationId: operation.operationId },
    );
  }
}

function storyRetentionBindingToken(storyId, repositoryId) {
  const story = String(storyId || "").trim();
  const repository = String(repositoryId || "").trim();
  if (!story || !repository) {
    throw new GitControllerError(
      "GIT_CONTROLLER_MIRROR_RETENTION_ID_INVALID",
      "Mirror story retention requires both story and repository identities",
    );
  }
  // Keep loose-ref paths below legacy Windows MAX_PATH even when the
  // Controller data root is deep. 120 collision-resistant bits remain bound
  // to both exact identities; the registry is the authoritative reverse map.
  return `b-${createHash("sha256")
    .update(`${story}\0${repository}`)
    .digest("base64url")
    .slice(0, 20)}`;
}

function storyRetentionShaToken(shaValue) {
  // This is only a compact locator. Every read/create path verifies that the
  // referenced commit equals the full exact SHA, so a token collision fails
  // closed instead of aliasing or overwriting another baseline.
  return `s-${createHash("sha256")
    .update(String(shaValue || ""))
    .digest("base64url")
    .slice(0, 16)}`;
}

export class MirrorSyncService {
  constructor({
    registry,
    persistence = defaultPersistence,
    leaseManager,
    journal,
    audit,
    gitRunner = runGitFile,
    faultInjector = null,
    previewTtlMs = 5 * 60_000,
  } = {}) {
    if (!registry || !leaseManager || !journal || !audit) {
      throw new GitControllerError(
        "GIT_CONTROLLER_DEPENDENCY_MISSING",
        "Mirror sync service dependencies are incomplete",
      );
    }
    this.registry = registry;
    this.persistence = persistence;
    this.leaseManager = leaseManager;
    this.journal = journal;
    this.audit = audit;
    this.gitRunner = gitRunner;
    this.faultInjector = faultInjector;
    this.previewTtlMs = Math.max(10_000, Number(previewTtlMs) || 5 * 60_000);
    this.storyRetentionProvider = null;
    this.rewritePublicationProvider = null;
  }

  mirrorArgs(entry, args) {
    // Git may otherwise start detached auto-maintenance after fetch and release
    // the Controller lease while that background process still mutates the
    // mirror. All implicit maintenance is disabled; the Controller runs a
    // foreground, lease-fenced maintenance pass explicitly.
    return [
      "-c",
      "gc.auto=0",
      "-c",
      "gc.autoDetach=false",
      "-c",
      "maintenance.auto=false",
      "-c",
      "maintenance.autoDetach=false",
      "--git-dir",
      entry.mirrorPath,
      ...args,
    ];
  }

  mirrorMaintenanceArgs(entry, args) {
    // Explicit maintenance is allowed to evaluate normal thresholds, but it
    // must remain foreground-bound to the tracked direct Git process.
    return [
      "-c",
      "gc.autoDetach=false",
      "-c",
      "maintenance.autoDetach=false",
      "--git-dir",
      entry.mirrorPath,
      ...args,
    ];
  }

  baseArgs(entry, args) {
    return [
      "-c",
      `safe.directory=${entry.basePath.replace(/\\/g, "/")}`,
      "-C",
      entry.basePath,
      ...args,
    ];
  }

  async run(entry, args, options = {}) {
    this.registry.attestGitBinary();
    const remoteUrl = String(options.remoteUrl || "");
    let protocol = "file";
    let sshTransport = null;
    if (remoteUrl) {
      const readCommand = args.includes("ls-remote")
        ? "ls-remote"
        : (args.includes("fetch") ? "fetch" : "");
      if (!readCommand || args.includes("push") || !args.includes(remoteUrl)) {
        throw new GitControllerError(
          "GIT_CONTROLLER_MIRROR_WRITE_FORBIDDEN",
          "Managed mirror remote transport permits only fixed read operations",
        );
      }
      protocol = entry.remoteScheme.replace(/:$/, "");
      if (!["file", "https", "ssh"].includes(protocol)) {
        throw new GitControllerError(
          "GIT_CONTROLLER_TRANSPORT_REJECTED",
          "Mirror synchronization requested an unapproved remote transport",
        );
      }
      if (protocol === "ssh") {
        sshTransport = this.registry.transportFor(entry, { remoteUrl });
      }
    }
    return this.gitRunner({
      gitBinary: this.registry.gitBinary,
      disabledHooksPath: this.registry.disabledHooksPath,
      knownHostsPath: this.registry.knownHostsPath,
      args,
      commandId: options.commandId,
      timeoutMs: options.timeoutMs,
      okExitCodes: options.okExitCodes || [0],
      cwd: options.cwd,
      env: {
        ...(options.env || {}),
        GIT_ALLOW_PROTOCOL: protocol,
        GIT_PROTOCOL_FROM_USER: "0",
      },
      sshTransport,
      secrets: [entry.remoteUrl],
      childLifecycle: options.childLifecycle || null,
    });
  }

  async runMutation(entry, args, lease, options = {}) {
    if (!lease || typeof lease.gitChildGuard !== "function") {
      throw new GitControllerError(
        "GIT_CONTROLLER_MUTATION_LEASE_REQUIRED",
        "Repository-mutating Git commands require a child-tracking lease",
        { repositoryId: entry.repositoryId, commandId: options.commandId || null },
      );
    }
    lease.assertCurrent();
    return this.run(entry, args, {
      ...options,
      childLifecycle: lease.gitChildGuard(options.commandId),
    });
  }

  acceptedRef(entry, branch) {
    return controllerAcceptedRef(entry.remoteId, branch);
  }

  acceptedHistoryRef(entry, branch, generation) {
    const value = Number(generation);
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new GitControllerError(
        "GIT_CONTROLLER_MIRROR_GENERATION_INVALID",
        "Accepted history retention requires a positive mirror generation",
      );
    }
    return controllerAcceptedHistoryRef(entry.remoteId, branch, value);
  }

  storyBaseRefPrefix(storyId, repositoryId) {
    return `refs/devbench/story-base/${
      storyRetentionBindingToken(storyId, repositoryId)
    }`;
  }

  setStoryBaseRetentionProvider(provider) {
    if (typeof provider !== "function") {
      throw new GitControllerError(
        "GIT_CONTROLLER_STORY_RETENTION_PROVIDER_INVALID",
        "Story retention provider must be a Controller-owned function",
      );
    }
    if (this.storyRetentionProvider && this.storyRetentionProvider !== provider) {
      throw new GitControllerError(
        "GIT_CONTROLLER_STORY_RETENTION_PROVIDER_DRIFT",
        "Story retention provider cannot be replaced after Controller initialization",
      );
    }
    this.storyRetentionProvider = provider;
  }

  setRewritePublicationProvider(provider) {
    if (typeof provider !== "function") {
      throw new GitControllerError(
        "GIT_CONTROLLER_REWRITE_PUBLICATION_PROVIDER_INVALID",
        "Rewrite publication evidence provider must be a Controller-owned function",
      );
    }
    if (
      this.rewritePublicationProvider
      && this.rewritePublicationProvider !== provider
    ) {
      throw new GitControllerError(
        "GIT_CONTROLLER_REWRITE_PUBLICATION_PROVIDER_DRIFT",
        "Rewrite publication evidence provider cannot be replaced after Controller initialization",
      );
    }
    this.rewritePublicationProvider = provider;
  }

  incomingRef(operationId, branch) {
    return controllerIncomingRef(operationId, branch);
  }

  async ensureImmutableRetentionRef(entry, refName, shaValue, {
    commandId = "mirror.retention.ensure",
    lease = null,
  } = {}) {
    const sha = normalizeSha(shaValue, { label: "retained accepted SHA" });
    const existing = await this.run(entry, this.mirrorArgs(entry, [
      "rev-parse",
      "--verify",
      `${refName}^{commit}`,
    ]), {
      commandId: `${commandId}.read`,
      okExitCodes: [0, 1, 128],
    });
    if (existing.exitCode === 0) {
      const actual = normalizeSha(existing.stdout.trim(), {
        label: "existing retained accepted SHA",
      });
      if (actual !== sha) {
        throw new GitControllerError(
          "GIT_CONTROLLER_MIRROR_RETENTION_DRIFT",
          "Immutable mirror retention ref points to a different exact SHA",
          { refName, expectedSha: sha, actualSha: actual },
        );
      }
      return { refName, sha, created: false };
    }
    await this.runMutation(entry, this.mirrorArgs(entry, [
      "update-ref",
      refName,
      sha,
      "0".repeat(sha.length),
    ]), lease, {
      commandId: `${commandId}.create`,
    });
    const verified = normalizeSha((await this.run(entry, this.mirrorArgs(entry, [
      "rev-parse",
      "--verify",
      `${refName}^{commit}`,
    ]), {
      commandId: `${commandId}.verify`,
    })).stdout.trim(), { label: "verified retained accepted SHA" });
    if (verified !== sha) {
      throw new GitControllerError(
        "GIT_CONTROLLER_MIRROR_RETENTION_DRIFT",
        "Mirror retention ref changed while it was being published",
        { refName, expectedSha: sha, actualSha: verified },
      );
    }
    return { refName, sha, created: true };
  }

  async ensureStoryBaseRetention(entry, {
    storyId,
    repositoryId = entry.repositoryId,
    baseRevision,
  } = {}, lease, {
    commandId = "mirror.story-base-retention",
  } = {}) {
    if (!lease) {
      throw new GitControllerError(
        "GIT_CONTROLLER_STORY_RETENTION_LEASE_REQUIRED",
        "Story base retention requires the active repository lease",
      );
    }
    lease.assertCurrent();
    if (String(repositoryId || "") !== entry.repositoryId) {
      throw new GitControllerError(
        "GIT_CONTROLLER_STORY_RETENTION_REPOSITORY_MISMATCH",
        "Story base retention is bound to a different managed repository",
      );
    }
    const sha = normalizeSha(baseRevision, { label: "story base exact SHA" });
    const prefix = this.storyBaseRefPrefix(storyId, entry.repositoryId);
    const immutable = await this.ensureImmutableRetentionRef(
      entry,
      `${prefix}/${storyRetentionShaToken(sha)}`,
      sha,
      { commandId: `${commandId}.immutable`, lease },
    );
    lease.assertCurrent();
    const currentRef = `${prefix}/c`;
    const current = await this.run(entry, this.mirrorArgs(entry, [
      "rev-parse",
      "--verify",
      `${currentRef}^{commit}`,
    ]), {
      commandId: `${commandId}.current-read`,
      okExitCodes: [0, 1, 128],
    });
    const previous = current.exitCode === 0
      ? normalizeSha(current.stdout.trim(), { label: "current story base SHA" })
      : null;
    if (previous !== sha) {
      await this.runMutation(entry, this.mirrorArgs(entry, [
        "update-ref",
        currentRef,
        sha,
        previous || "0".repeat(sha.length),
      ]), lease, {
        commandId: `${commandId}.current-publish`,
      });
    }
    const verified = normalizeSha((await this.run(entry, this.mirrorArgs(entry, [
      "rev-parse",
      "--verify",
      `${currentRef}^{commit}`,
    ]), {
      commandId: `${commandId}.current-verify`,
    })).stdout.trim(), { label: "verified story base SHA" });
    if (verified !== sha) {
      throw new GitControllerError(
        "GIT_CONTROLLER_STORY_RETENTION_DRIFT",
        "Story base retention changed during Controller publication",
        { storyId: String(storyId), repositoryId: entry.repositoryId },
      );
    }
    lease.assertCurrent();
    return Object.freeze({
      storyId: String(storyId),
      repositoryId: entry.repositoryId,
      baseRevision: sha,
      currentRef,
      immutableRef: immutable.refName,
      previousSha: previous,
    });
  }

  async reconcileStoryBaseRetentions(entry, lease, rowsValue = null) {
    if (!lease) {
      throw new GitControllerError(
        "GIT_CONTROLLER_STORY_RETENTION_LEASE_REQUIRED",
        "Story base retention reconciliation requires the active repository lease",
      );
    }
    lease.assertCurrent();
    const supplied = rowsValue == null
      ? (this.storyRetentionProvider ? await this.storyRetentionProvider() : [])
      : rowsValue;
    if (!Array.isArray(supplied)) {
      throw new GitControllerError(
        "GIT_CONTROLLER_STORY_RETENTION_PROVIDER_INVALID",
        "Story retention provider returned an invalid registry snapshot",
      );
    }
    const rows = supplied.filter((row) => (
      String(row?.repositoryId || "") === entry.repositoryId
    ));
    const expectedPrefixes = new Set();
    const retained = [];
    for (const row of rows) {
      const prefix = this.storyBaseRefPrefix(row.storyId, entry.repositoryId);
      if (expectedPrefixes.has(prefix)) {
        throw new GitControllerError(
          "GIT_CONTROLLER_STORY_RETENTION_REGISTRY_DRIFT",
          "Story retention registry contains a duplicate story repository",
        );
      }
      expectedPrefixes.add(prefix);
      retained.push(await this.ensureStoryBaseRetention(entry, row, lease, {
        commandId: "mirror.story-base-reconcile",
      }));
    }
    const listed = await this.run(entry, this.mirrorArgs(entry, [
      "for-each-ref",
      "--format=%(refname)",
      "refs/devbench/story-base",
    ]), {
      commandId: "mirror.story-base-list",
    });
    const existing = listed.stdout.split(/\r?\n/).map((value) => value.trim()).filter(Boolean);
    const stale = existing.filter((refName) => (
      ![...expectedPrefixes].some((prefix) => (
        refName === prefix || refName.startsWith(`${prefix}/`)
      ))
    ));
    for (const refName of stale) {
      lease.assertCurrent();
      await this.runMutation(entry, this.mirrorArgs(entry, [
        "update-ref",
        "-d",
        refName,
      ]), lease, {
        commandId: "mirror.story-base-delete-stale",
      });
    }
    lease.assertCurrent();
    return Object.freeze({
      repositoryId: entry.repositoryId,
      active: retained.length,
      staleDeleted: stale.length,
      retained,
    });
  }

  validateAdministrativeApproval({
    relationship,
    repositoryId,
    branch,
    previewId,
    previewVersion,
    expected,
    candidate,
    actor,
    adminApprovalId,
    adminApprovedAt,
    adminApprovalExpiresAt,
    adminApprovedRelationship,
    adminApprovedBy,
    adminApprovedPreviewId,
    adminApprovedPreviewVersion,
    adminApprovedPreviousSha,
    adminApprovedCandidateSha,
    impactDigest,
    adminApprovedImpactDigest,
    now = Date.now(),
  } = {}) {
    if (!REWRITE_RELATIONSHIPS.includes(relationship)) {
      return null;
    }
    const approvalId = String(adminApprovalId || "").trim();
    const approvedBy = String(adminApprovedBy || "").trim();
    const operationActor = String(actor || "").trim();
    const approvedRelationship = String(adminApprovedRelationship || "").trim();
    const approvedAt = Number(adminApprovedAt);
    const expiresAt = Number(adminApprovalExpiresAt);
    const expectedImpactDigest = String(impactDigest || "").trim().toLowerCase();
    const approvedImpactDigest = String(adminApprovedImpactDigest || "").trim().toLowerCase();
    if (
      !APPROVAL_ID.test(approvalId)
      || !operationActor
      || approvedBy !== operationActor
      || approvedRelationship !== relationship
      || String(adminApprovedPreviewId || "") !== String(previewId || "")
      || Number(adminApprovedPreviewVersion) !== Number(previewVersion)
      || String(adminApprovedPreviousSha || "").toLowerCase() !== String(expected || "")
      || String(adminApprovedCandidateSha || "").toLowerCase() !== String(candidate || "")
      || !/^[0-9a-f]{64}$/.test(expectedImpactDigest)
      || approvedImpactDigest !== expectedImpactDigest
      || !Number.isSafeInteger(approvedAt)
      || !Number.isSafeInteger(expiresAt)
      || approvedAt > now + ADMIN_APPROVAL_CLOCK_SKEW_MS
      || expiresAt <= now
      || expiresAt <= approvedAt
      || expiresAt - approvedAt > ADMIN_APPROVAL_MAX_TTL_MS
    ) {
      throw new GitControllerError(
        "GIT_CONTROLLER_REMOTE_HISTORY_ADMIN_APPROVAL_REQUIRED",
        "Remote history rewrite requires a current one-time administrator approval bound to the exact preview",
        {
          repositoryId,
          branch,
          previewId,
          previewVersion,
          previousSha: expected,
          candidateSha: candidate,
          relationship,
        },
      );
    }
    return Object.freeze({
      approvalId,
      approvedAt,
      expiresAt,
      relationship,
      approvedBy,
      repositoryId,
      branch,
      previewId,
      previewVersion: Number(previewVersion),
      previousSha: expected,
      candidateSha: candidate,
      impactDigest: expectedImpactDigest,
    });
  }

  validateRecoveryPublishingCheckpoint({
    entry,
    operation,
    publishing,
  } = {}) {
    const data = publishing?.data;
    const branch = String(operation?.branch || "");
    const expected = operation?.expectedHead || null;
    const candidate = operation?.candidateSha;
    const expectedGeneration = Number(data?.expectedGeneration);
    const previewVersion = Number(data?.previewVersion);
    const relationship = String(data?.relationship || "");
    const actor = data?.actor == null ? null : String(data.actor).trim();
    const rewriteImpactDigest = data?.rewriteImpactDigest == null
      ? null
      : String(data.rewriteImpactDigest).trim().toLowerCase();
    if (
      !publishing
      || !data
      || publishing.operationId !== operation?.operationId
      || publishing.repositoryId !== entry?.repositoryId
      || data.repositoryId !== entry?.repositoryId
      || data.branch !== branch
      || data.previewId !== operation?.previewId
      || !Number.isSafeInteger(previewVersion)
      || previewVersion < 1
      || data.previousSha !== expected
      || data.candidateSha !== candidate
      || !Number.isSafeInteger(expectedGeneration)
      || expectedGeneration < 0
      || !["FAST_FORWARD", "UNCHANGED", "REMOTE_REWIND", "DIVERGED_FROM_ACCEPTED"]
        .includes(relationship)
      || !Number.isSafeInteger(Number(publishing.createdAt))
      || Number(publishing.createdAt) < 1
    ) {
      throw new GitControllerError(
        "GIT_CONTROLLER_MIRROR_RECOVERY_CHECKPOINT_INVALID",
        "Mirror publication recovery checkpoint is incomplete or does not match the exact operation",
        {
          operationId: operation?.operationId || null,
          repositoryId: entry?.repositoryId || null,
        },
      );
    }
    const rewrite = REWRITE_RELATIONSHIPS.includes(relationship);
    if (
      (rewrite && !/^[0-9a-f]{64}$/.test(rewriteImpactDigest || ""))
      || (!rewrite && rewriteImpactDigest != null)
    ) {
      throw new GitControllerError(
        "GIT_CONTROLLER_MIRROR_RECOVERY_CHECKPOINT_INVALID",
        "Mirror publication recovery checkpoint has an invalid rewrite impact binding",
        { operationId: operation.operationId },
      );
    }
    const storedApproval = data.administrativeApproval;
    if (!rewrite && storedApproval != null) {
      throw new GitControllerError(
        "GIT_CONTROLLER_MIRROR_RECOVERY_CHECKPOINT_INVALID",
        "A non-rewrite mirror publication contains an unexpected administrative approval",
        { operationId: operation.operationId },
      );
    }
    let administrativeApproval = null;
    if (rewrite) {
      if (
        !storedApproval
        || typeof storedApproval !== "object"
        || Array.isArray(storedApproval)
        || storedApproval.repositoryId !== entry.repositoryId
        || storedApproval.branch !== branch
      ) {
        throw new GitControllerError(
          "GIT_CONTROLLER_MIRROR_RECOVERY_APPROVAL_MISSING",
          "Remote history rewrite recovery requires the exact durable administrative approval",
          { operationId: operation.operationId },
        );
      }
      administrativeApproval = this.validateAdministrativeApproval({
        relationship,
        repositoryId: entry.repositoryId,
        branch,
        previewId: operation.previewId,
        previewVersion,
        expected,
        candidate,
        actor,
        adminApprovalId: storedApproval.approvalId,
        adminApprovedAt: storedApproval.approvedAt,
        adminApprovalExpiresAt: storedApproval.expiresAt,
        adminApprovedRelationship: storedApproval.relationship,
        adminApprovedBy: storedApproval.approvedBy,
        adminApprovedPreviewId: storedApproval.previewId,
        adminApprovedPreviewVersion: storedApproval.previewVersion,
        adminApprovedPreviousSha: storedApproval.previousSha,
        adminApprovedCandidateSha: storedApproval.candidateSha,
        impactDigest: rewriteImpactDigest,
        adminApprovedImpactDigest: storedApproval.impactDigest,
        // Approval validity is judged at the durable publication checkpoint.
        // A later restart must not retroactively expire an approval that was
        // valid when the accepted ref CAS began.
        now: Number(publishing.createdAt),
      });
    }
    return Object.freeze({
      expectedGeneration,
      previewVersion,
      relationship,
      actor,
      administrativeApproval,
      checkpointAt: Number(publishing.createdAt),
    });
  }

  async observeRemoteTip(entry, branch) {
    const sourceRef = `refs/heads/${branch}`;
    const result = await this.run(entry, [
      "ls-remote",
      "--heads",
      "--refs",
      entry.remoteUrl,
      sourceRef,
    ], {
      commandId: "mirror.remote-tip",
      timeoutMs: 60_000,
      remoteUrl: entry.remoteUrl,
    });
    const lines = result.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    if (!lines.length) return null;
    if (lines.length !== 1) {
      throw new GitControllerError(
        "GIT_CONTROLLER_REMOTE_TIP_AMBIGUOUS",
        "Registered remote returned an ambiguous branch tip",
        { branch },
      );
    }
    const [sha, ref, ...rest] = lines[0].split(/\s+/);
    if (rest.length || ref !== sourceRef) {
      throw new GitControllerError(
        "GIT_CONTROLLER_REMOTE_TIP_INVALID",
        "Registered remote returned an unexpected ref",
        { branch },
      );
    }
    return normalizeSha(sha, { label: "observed remote SHA" });
  }

  async ensureMirror(entry, lease) {
    const mirrorParent = path.dirname(entry.mirrorPath);
    ensureManagedDirectory(mirrorParent, {
      allowedRoot: this.registry.dataRoot,
      label: "managed mirror parent",
    });
    if (!fs.existsSync(entry.mirrorPath)) {
      const objectFormat = (await this.run(entry, this.baseArgs(entry, [
        "rev-parse",
        "--show-object-format",
      ]), {
        commandId: "mirror.base-object-format",
      })).stdout.trim();
      const initArgs = ["init", "--bare"];
      if (objectFormat === "sha256") initArgs.push("--object-format=sha256");
      initArgs.push(entry.mirrorPath);
      await this.runMutation(entry, initArgs, lease, {
        commandId: "mirror.init-bare",
        cwd: mirrorParent,
      });
    }
    canonicalizeManagedPath(entry.mirrorPath, {
      allowedRoot: this.registry.dataRoot,
      label: "managed bare mirror",
      allowMissing: false,
      expectedType: "directory",
    });
    const bare = (await this.run(entry, this.mirrorArgs(entry, [
      "rev-parse",
      "--is-bare-repository",
    ]), {
      commandId: "mirror.verify-bare",
    })).stdout.trim();
    if (bare !== "true") {
      throw new GitControllerError(
        "GIT_CONTROLLER_MIRROR_NOT_BARE",
        "Managed mirror is not a bare Git repository",
        { repositoryId: entry.repositoryId },
      );
    }
    const baseFormat = (await this.run(entry, this.baseArgs(entry, [
      "rev-parse",
      "--show-object-format",
    ]), {
      commandId: "mirror.base-object-format",
    })).stdout.trim();
    const mirrorFormat = (await this.run(entry, this.mirrorArgs(entry, [
      "rev-parse",
      "--show-object-format",
    ]), {
      commandId: "mirror.object-format",
    })).stdout.trim();
    if (baseFormat !== mirrorFormat) {
      throw new GitControllerError(
        "GIT_CONTROLLER_OBJECT_FORMAT_MISMATCH",
        "Managed mirror object format differs from the registered base repository",
      );
    }
    return entry.mirrorPath;
  }

  async readAccepted(entry, branch, { mirrorMayBeMissing = false } = {}) {
    const state = this.persistence.getGitControllerMirrorState(
      entry.repositoryId,
      entry.remoteId,
      branch,
    );
    if (!fs.existsSync(entry.mirrorPath)) {
      if (state?.acceptedSha && !mirrorMayBeMissing) {
        throw new GitControllerError(
          "GIT_CONTROLLER_MIRROR_STATE_CORRUPT",
          "Persisted accepted SHA exists but the managed mirror is missing",
        );
      }
      return {
        state,
        refSha: null,
        acceptedSha: state?.acceptedSha || null,
        mirrorPresent: false,
        mirrorStatus: state?.acceptedSha ? "RECOVERY_REQUIRED" : "NOT_INITIALIZED",
      };
    }
    const acceptedRef = this.acceptedRef(entry, branch);
    const resolved = await this.run(entry, this.mirrorArgs(entry, [
      "rev-parse",
      "--verify",
      `${acceptedRef}^{commit}`,
    ]), {
      commandId: "mirror.read-accepted",
      okExitCodes: [0, 1, 128],
    });
    const refSha = resolved.exitCode === 0
      ? normalizeSha(resolved.stdout.trim(), { label: "accepted SHA" })
      : null;
    const stateSha = state?.acceptedSha || null;
    if (stateSha !== refSha) {
      throw new GitControllerError(
        "GIT_CONTROLLER_MIRROR_STATE_CORRUPT",
        "Managed accepted ref and persisted mirror state disagree",
        {
          repositoryId: entry.repositoryId,
          branch,
          stateSha,
          refSha,
        },
      );
    }
    return {
      state,
      refSha,
      acceptedSha: refSha,
      mirrorPresent: true,
      mirrorStatus: refSha ? "HEALTHY" : "EMPTY",
    };
  }

  async resolveAcceptedCandidate({
    repositoryId,
    branch: branchValue,
    candidateSha: candidateValue,
  } = {}) {
    const { entry, branch } = await this.registry.resolve(repositoryId, branchValue);
    const candidateSha = normalizeSha(candidateValue, { label: "story exact SHA" });
    const accepted = await this.readAccepted(entry, branch);
    if (!accepted.acceptedSha) {
      throw new GitControllerError(
        "GIT_CONTROLLER_ACCEPTED_REF_MISSING",
        "The managed branch has no accepted mirror tip",
        { repositoryId: entry.repositoryId, branch },
      );
    }
    const resolved = await this.run(entry, this.mirrorArgs(entry, [
      "rev-parse",
      "--verify",
      `${candidateSha}^{commit}`,
    ]), {
      commandId: "mirror.resolve-story-candidate",
      okExitCodes: [0, 1, 128],
    });
    if (
      resolved.exitCode !== 0
      || normalizeSha(resolved.stdout.trim(), { label: "resolved story SHA" }) !== candidateSha
    ) {
      throw new GitControllerError(
        "GIT_CONTROLLER_STORY_SHA_MISSING",
        "The requested exact SHA is not present in the managed mirror",
        { repositoryId: entry.repositoryId, branch, candidateSha },
      );
    }
    const ancestry = await this.run(entry, this.mirrorArgs(entry, [
      "merge-base",
      "--is-ancestor",
      candidateSha,
      accepted.acceptedSha,
    ]), {
      commandId: "mirror.verify-story-candidate",
      okExitCodes: [0, 1],
    });
    if (ancestry.exitCode !== 0) {
      throw new GitControllerError(
        "GIT_CONTROLLER_STORY_SHA_NOT_ACCEPTED",
        "The requested exact SHA is outside the accepted branch history",
        {
          repositoryId: entry.repositoryId,
          branch,
          candidateSha,
          acceptedTipSha: accepted.acceptedSha,
        },
      );
    }
    await this.run(entry, this.mirrorArgs(entry, [
      "fsck",
      "--connectivity-only",
      candidateSha,
      accepted.acceptedSha,
    ]), {
      commandId: "mirror.fsck-story-candidate",
      timeoutMs: 120_000,
    });
    return {
      repositoryId: entry.repositoryId,
      remoteId: entry.remoteId,
      branch,
      sourceRef: `refs/heads/${branch}`,
      acceptedRef: this.acceptedRef(entry, branch),
      mirrorPath: entry.mirrorPath,
      candidateSha,
      acceptedTipSha: accepted.acceptedSha,
      mirrorGeneration: Number(accepted.state?.generation || 0),
    };
  }

  async resolveRetainedStoryCandidate({
    repositoryId,
    branch: branchValue,
    storyId,
    candidateSha: candidateValue,
  } = {}) {
    const { entry, branch } = await this.registry.resolve(repositoryId, branchValue);
    const candidateSha = normalizeSha(candidateValue, {
      label: "retained story exact SHA",
    });
    const accepted = await this.readAccepted(entry, branch);
    if (!accepted.acceptedSha) {
      throw new GitControllerError(
        "GIT_CONTROLLER_ACCEPTED_REF_MISSING",
        "The managed branch has no accepted mirror tip",
        { repositoryId: entry.repositoryId, branch },
      );
    }
    const retentionRef = `${
      this.storyBaseRefPrefix(storyId, entry.repositoryId)
    }/${storyRetentionShaToken(candidateSha)}`;
    const retained = await this.run(entry, this.mirrorArgs(entry, [
      "rev-parse",
      "--verify",
      `${retentionRef}^{commit}`,
    ]), {
      commandId: "mirror.resolve-retained-story-candidate",
      okExitCodes: [0, 1, 128],
    });
    if (
      retained.exitCode !== 0
      || normalizeSha(retained.stdout.trim(), {
        label: "resolved retained story SHA",
      }) !== candidateSha
    ) {
      throw new GitControllerError(
        "GIT_CONTROLLER_STORY_RETENTION_MISSING",
        "The active story exact SHA is not pinned by its Controller mirror retention ref",
        {
          repositoryId: entry.repositoryId,
          branch,
          storyId: String(storyId || ""),
          candidateSha,
        },
      );
    }
    await this.run(entry, this.mirrorArgs(entry, [
      "fsck",
      "--connectivity-only",
      candidateSha,
      accepted.acceptedSha,
    ]), {
      commandId: "mirror.fsck-retained-story-candidate",
      timeoutMs: 120_000,
    });
    return {
      repositoryId: entry.repositoryId,
      remoteId: entry.remoteId,
      branch,
      sourceRef: `refs/heads/${branch}`,
      acceptedRef: this.acceptedRef(entry, branch),
      mirrorPath: entry.mirrorPath,
      candidateSha,
      acceptedTipSha: accepted.acceptedSha,
      mirrorGeneration: Number(accepted.state?.generation || 0),
      retentionRef,
      retainedStoryId: String(storyId || ""),
    };
  }

  async classify(entry, previousSha, candidateSha) {
    if (!previousSha) return "FAST_FORWARD";
    if (previousSha === candidateSha) return "UNCHANGED";
    const forward = await this.run(entry, this.mirrorArgs(entry, [
      "merge-base",
      "--is-ancestor",
      previousSha,
      candidateSha,
    ]), {
      commandId: "mirror.classify-forward",
      okExitCodes: [0, 1],
    });
    if (forward.exitCode === 0) return "FAST_FORWARD";
    const rewind = await this.run(entry, this.mirrorArgs(entry, [
      "merge-base",
      "--is-ancestor",
      candidateSha,
      previousSha,
    ]), {
      commandId: "mirror.classify-rewind",
      okExitCodes: [0, 1],
    });
    return rewind.exitCode === 0 ? "REMOTE_REWIND" : "DIVERGED_FROM_ACCEPTED";
  }

  async inspectCandidateForPreview(entry, branch, {
    acceptedSha,
    candidateSha,
  } = {}) {
    const operationId = `mirror-preview-${randomUUID()}`;
    const incomingRef = this.incomingRef(operationId, branch);
    let lease = null;
    let cleanupRequired = false;
    try {
      lease = this.leaseManager.acquire(entry, {
        operationId,
        kind: "mirror-preview",
      });
      await this.ensureMirror(entry, lease);
      lease.assertCurrent();
      const current = await this.readAccepted(entry, branch);
      if (current.acceptedSha !== acceptedSha) {
        throw new GitControllerError(
          "GIT_CONTROLLER_PREVIEW_STALE",
          "Accepted mirror state changed while the rewrite impact preview was being prepared",
        );
      }
      cleanupRequired = true;
      await this.runMutation(entry, this.mirrorArgs(entry, [
        "fetch",
        "--no-auto-maintenance",
        "--atomic",
        "--no-tags",
        "--no-write-fetch-head",
        entry.remoteUrl,
        `+refs/heads/${branch}:${incomingRef}`,
      ]), lease, {
        commandId: "mirror.preview-fetch-incoming",
        timeoutMs: 120_000,
        remoteUrl: entry.remoteUrl,
      });
      const fetchedSha = normalizeSha((await this.run(entry, this.mirrorArgs(entry, [
        "rev-parse",
        "--verify",
        `${incomingRef}^{commit}`,
      ]), {
        commandId: "mirror.preview-verify-incoming",
      })).stdout.trim(), { label: "preview incoming SHA" });
      if (fetchedSha !== candidateSha) {
        throw new GitControllerError(
          "GIT_CONTROLLER_REMOTE_CHANGED",
          "Fetched preview candidate differs from the observed remote tip",
          { observedCandidate: candidateSha, fetchedCandidate: fetchedSha },
        );
      }
      await this.run(entry, this.mirrorArgs(entry, [
        "fsck",
        "--connectivity-only",
        candidateSha,
      ]), {
        commandId: "mirror.preview-fsck-candidate",
        timeoutMs: 120_000,
      });
      const secondObservedSha = await this.observeRemoteTip(entry, branch);
      if (secondObservedSha !== candidateSha) {
        throw new GitControllerError(
          "GIT_CONTROLLER_REMOTE_CHANGED",
          "Remote branch changed while the rewrite impact preview was being prepared",
          { observedCandidate: candidateSha, secondObservedCandidate: secondObservedSha },
        );
      }
      const relationship = await this.classify(entry, acceptedSha, candidateSha);
      const rewriteImpact = REWRITE_RELATIONSHIPS.includes(relationship)
        ? await this.computeRewriteImpact(entry, {
            branch,
            previousSha: acceptedSha,
            candidateSha,
          })
        : null;
      const cleanupWarning = await this.cleanupIncoming(entry, incomingRef, lease);
      if (cleanupWarning) {
        throw new GitControllerError(
          "GIT_CONTROLLER_PREVIEW_CLEANUP_FAILED",
          "Rewrite impact preview could not remove its isolated candidate ref",
          { cleanupWarning },
        );
      }
      cleanupRequired = false;
      lease.assertCurrent();
      return { relationship, rewriteImpact };
    } finally {
      if (cleanupRequired && lease && !lease.lost && fs.existsSync(entry.mirrorPath)) {
        await this.cleanupIncoming(entry, incomingRef, lease);
      }
      lease?.release();
    }
  }

  async isDroppedCommit(entry, previousSha, candidateSha, commitSha, commandSuffix) {
    const inPrevious = await this.run(entry, this.mirrorArgs(entry, [
      "merge-base",
      "--is-ancestor",
      commitSha,
      previousSha,
    ]), {
      commandId: `mirror.rewrite-impact-${commandSuffix}-previous`,
      okExitCodes: [0, 1],
    });
    if (inPrevious.exitCode !== 0) return false;
    const inCandidate = await this.run(entry, this.mirrorArgs(entry, [
      "merge-base",
      "--is-ancestor",
      commitSha,
      candidateSha,
    ]), {
      commandId: `mirror.rewrite-impact-${commandSuffix}-candidate`,
      okExitCodes: [0, 1],
    });
    return inCandidate.exitCode !== 0;
  }

  async computeAffectedStories(entry, {
    branch,
    previousSha,
    candidateSha,
  } = {}) {
    if (!this.storyRetentionProvider) {
      return {
        status: "UNKNOWN",
        count: 0,
        stories: [],
        truncated: false,
        evidenceCode: "STORY_REGISTRY_PROVIDER_MISSING",
      };
    }
    let rows;
    try {
      rows = await this.storyRetentionProvider();
    } catch {
      return {
        status: "UNKNOWN",
        count: 0,
        stories: [],
        truncated: false,
        evidenceCode: "STORY_REGISTRY_PROVIDER_FAILED",
      };
    }
    if (!Array.isArray(rows)) {
      return {
        status: "UNKNOWN",
        count: 0,
        stories: [],
        truncated: false,
        evidenceCode: "STORY_REGISTRY_PROVIDER_INVALID",
      };
    }
    const sourceRef = `refs/heads/${branch}`;
    const active = rows.filter((row) => (
      String(row?.repositoryId || "") === entry.repositoryId
      && String(row?.sourceRef || "") === sourceRef
    ));
    if (active.length > REWRITE_ACTIVE_STORY_SCAN_LIMIT) {
      return {
        status: "UNKNOWN",
        count: active.length,
        stories: [],
        truncated: true,
        evidenceCode: "STORY_REGISTRY_SCAN_LIMIT_EXCEEDED",
      };
    }
    const affected = [];
    try {
      for (const row of active) {
        const storyId = String(row?.storyId || "").trim();
        const baseRevision = normalizeSha(row?.baseRevision, {
          label: "active story base SHA",
        });
        if (!storyId) {
          throw new GitControllerError(
            "GIT_CONTROLLER_REWRITE_STORY_ID_INVALID",
            "Active story registry entry has no story identity",
          );
        }
        if (await this.isDroppedCommit(
          entry,
          previousSha,
          candidateSha,
          baseRevision,
          "story",
        )) {
          affected.push({ storyId, baseRevision });
        }
      }
    } catch {
      return {
        status: "UNKNOWN",
        count: 0,
        stories: [],
        truncated: false,
        evidenceCode: "STORY_REGISTRY_IMPACT_UNVERIFIED",
      };
    }
    affected.sort((left, right) => (
      left.storyId.localeCompare(right.storyId)
      || left.baseRevision.localeCompare(right.baseRevision)
    ));
    return {
      status: "KNOWN",
      count: affected.length,
      stories: affected.slice(0, REWRITE_AFFECTED_STORY_LIMIT),
      truncated: affected.length > REWRITE_AFFECTED_STORY_LIMIT,
      evidenceCode: "STORY_REGISTRY_VERIFIED",
    };
  }

  async computePublishedCommitImpact(entry, {
    branch,
    previousSha,
    candidateSha,
    droppedCommitCount,
    droppedCommits,
    droppedCommitsTruncated,
  } = {}) {
    if (!this.rewritePublicationProvider) {
      return {
        status: "UNKNOWN",
        commits: [],
        truncated: false,
        evidenceCode: "PUBLICATION_PROVIDER_MISSING",
      };
    }
    let evidence;
    try {
      evidence = await this.rewritePublicationProvider({
        repositoryId: entry.repositoryId,
        remoteId: entry.remoteId,
        branch,
        previousSha,
        candidateSha,
        droppedCommitCount,
        droppedCommits: Object.freeze([...(droppedCommits || [])]),
        droppedCommitsTruncated: droppedCommitsTruncated === true,
      });
    } catch {
      return {
        status: "UNKNOWN",
        commits: [],
        truncated: false,
        evidenceCode: "PUBLICATION_PROVIDER_FAILED",
      };
    }
    const status = String(evidence?.status || "").toUpperCase();
    const rawCommits = Array.isArray(evidence?.publishedCommits)
      ? evidence.publishedCommits
      : [];
    const truncated = evidence?.truncated === true;
    const evidenceId = String(evidence?.evidenceId || "").trim();
    const evidenceDigest = String(evidence?.evidenceDigest || "").trim().toLowerCase();
    if (status === "UNKNOWN") {
      return {
        status: "UNKNOWN",
        commits: [],
        truncated: truncated || droppedCommitsTruncated === true,
        evidenceId: APPROVAL_ID.test(evidenceId) ? evidenceId : null,
        evidenceDigest: /^[0-9a-f]{64}$/.test(evidenceDigest) ? evidenceDigest : null,
        evidenceCode: "PUBLICATION_PROVIDER_UNKNOWN",
      };
    }
    if (
      !["NONE", "PRESENT"].includes(status)
      || (status === "NONE" && (rawCommits.length || truncated))
      || (status === "PRESENT" && rawCommits.length === 0)
      || rawCommits.length > REWRITE_DROPPED_COMMIT_LIMIT
      || !APPROVAL_ID.test(evidenceId)
      || !/^[0-9a-f]{64}$/.test(evidenceDigest)
    ) {
      return {
        status: "UNKNOWN",
        commits: [],
        truncated: false,
        evidenceCode: "PUBLICATION_PROVIDER_INVALID",
      };
    }
    const commits = [];
    try {
      for (const value of rawCommits) {
        const sha = normalizeSha(value, { label: "published dropped SHA" });
        if (
          commits.includes(sha)
          || !(await this.isDroppedCommit(
            entry,
            previousSha,
            candidateSha,
            sha,
            "published",
          ))
        ) {
          throw new GitControllerError(
            "GIT_CONTROLLER_REWRITE_PUBLICATION_EVIDENCE_INVALID",
            "Published commit evidence is not an exact dropped commit set",
          );
        }
        commits.push(sha);
      }
    } catch {
      return {
        status: "UNKNOWN",
        commits: [],
        truncated: false,
        evidenceCode: "PUBLICATION_PROVIDER_UNVERIFIED",
      };
    }
    commits.sort();
    return {
      status,
      commits,
      truncated,
      evidenceId,
      evidenceDigest,
      evidenceCode: "PUBLICATION_PROVIDER_VERIFIED",
    };
  }

  async computeRewriteImpact(entry, {
    branch,
    previousSha: previousValue,
    candidateSha: candidateValue,
  } = {}) {
    const previousSha = normalizeSha(previousValue, { label: "rewrite previous SHA" });
    const candidateSha = normalizeSha(candidateValue, { label: "rewrite candidate SHA" });
    const countText = (await this.run(entry, this.mirrorArgs(entry, [
      "rev-list",
      "--count",
      previousSha,
      "--not",
      candidateSha,
    ]), {
      commandId: "mirror.rewrite-impact-count",
    })).stdout.trim();
    if (!/^\d+$/.test(countText) || !Number.isSafeInteger(Number(countText))) {
      throw new GitControllerError(
        "GIT_CONTROLLER_REWRITE_IMPACT_INVALID",
        "Git returned an invalid dropped commit count for remote history rewrite",
      );
    }
    const droppedCommitCount = Number(countText);
    const listed = (await this.run(entry, this.mirrorArgs(entry, [
      "rev-list",
      `--max-count=${REWRITE_DROPPED_COMMIT_LIMIT + 1}`,
      previousSha,
      "--not",
      candidateSha,
    ]), {
      commandId: "mirror.rewrite-impact-list",
    })).stdout.split(/\r?\n/).map((value) => value.trim()).filter(Boolean);
    const droppedCommits = [...new Set(listed.map((value) => normalizeSha(value, {
      label: "dropped commit SHA",
    })))].slice(0, REWRITE_DROPPED_COMMIT_LIMIT).sort();
    const droppedCommitsTruncated = (
      droppedCommitCount > droppedCommits.length
      || listed.length > REWRITE_DROPPED_COMMIT_LIMIT
    );
    const affected = await this.computeAffectedStories(entry, {
      branch,
      previousSha,
      candidateSha,
    });
    const published = await this.computePublishedCommitImpact(entry, {
      branch,
      previousSha,
      candidateSha,
      droppedCommitCount,
      droppedCommits,
      droppedCommitsTruncated,
    });
    const approvalAllowed = (
      affected.status === "KNOWN"
      && published.status !== "UNKNOWN"
      && !droppedCommitsTruncated
      && !affected.truncated
      && !published.truncated
    );
    const impact = {
      version: REWRITE_IMPACT_VERSION,
      previousSha,
      candidateSha,
      droppedCommitCount,
      droppedCommits,
      droppedCommitsTruncated,
      affectedStoryStatus: affected.status,
      affectedStoryCount: affected.count,
      affectedStories: affected.stories,
      affectedStoriesTruncated: affected.truncated,
      affectedStoriesEvidenceCode: affected.evidenceCode,
      publishedCommitStatus: published.status,
      publishedCommits: published.commits,
      publishedCommitsTruncated: published.truncated,
      publicationEvidenceId: published.evidenceId || null,
      publicationEvidenceDigest: published.evidenceDigest || null,
      publicationEvidenceCode: published.evidenceCode,
      approvalAllowed,
    };
    const digest = createHash("sha256")
      .update("devbench-remote-rewrite-impact-v1\0")
      .update(JSON.stringify(impact))
      .digest("hex");
    return Object.freeze({ ...impact, digest });
  }

  async preview({ repositoryId, branch: branchValue, ttlMs } = {}) {
    const { entry, branch } = await this.registry.resolve(repositoryId, branchValue);
    const accepted = await this.readAccepted(entry, branch, { mirrorMayBeMissing: true });
    const credentialStatus = String(entry.credentialStatus || "MISSING");
    if (credentialStatus === "MISSING") {
      const now = Date.now();
      const stored = this.persistence.createGitControllerPreview({
        previewId: randomUUID(),
        repositoryId: entry.repositoryId,
        kind: MIRROR_PREVIEW_KIND,
        branch,
        expectedHead: accepted.acceptedSha,
        candidateSha: null,
        mirrorGeneration: Number(accepted.state?.generation || 0),
        relationship: "CREDENTIAL_MISSING",
        eligible: false,
        blockerCode: "GIT_CONTROLLER_CREDENTIAL_MISSING",
        remoteFingerprint: entry.remoteFingerprint,
        payload: {
          remoteId: entry.remoteId,
          sourceRef: `refs/heads/${branch}`,
          lastAcceptedSha: accepted.acceptedSha,
          credentialStatus,
          mirrorStatus: fs.existsSync(entry.mirrorPath) ? "HEALTHY" : "NOT_INITIALIZED",
        },
        createdAt: now,
        expiresAt: now + Math.max(10_000, Number(ttlMs) || this.previewTtlMs),
      });
      return {
        previewId: stored.previewId,
        previewVersion: stored.previewVersion,
        repositoryId: entry.repositoryId,
        remoteId: entry.remoteId,
        branch,
        lastAcceptedSha: accepted.acceptedSha,
        candidateSha: null,
        mirrorGeneration: stored.mirrorGeneration,
        relationship: stored.relationship,
        eligible: false,
        blockerCode: stored.blockerCode,
        credentialStatus,
        mirrorStatus: stored.payload.mirrorStatus,
        expiresAt: stored.expiresAt,
      };
    }
    const candidateSha = await this.observeRemoteTip(entry, branch);
    let relationship = candidateSha ? "UNKNOWN" : "BRANCH_DELETED";
    let rewriteImpact = null;
    if (candidateSha) {
      const inspected = await this.inspectCandidateForPreview(entry, branch, {
        acceptedSha: accepted.acceptedSha,
        candidateSha,
      });
      relationship = inspected.relationship;
      rewriteImpact = inspected.rewriteImpact;
    }
    const requiresAdminReview = REWRITE_RELATIONSHIPS.includes(relationship);
    const blockerCode = !candidateSha
      ? "GIT_CONTROLLER_REMOTE_BRANCH_DELETED"
      : (requiresAdminReview
          ? (
              rewriteImpact?.approvalAllowed
                ? "GIT_CONTROLLER_REMOTE_HISTORY_ADMIN_REVIEW_REQUIRED"
                : "GIT_CONTROLLER_REMOTE_HISTORY_IMPACT_UNKNOWN"
            )
          : null);
    const now = Date.now();
    const stored = this.persistence.createGitControllerPreview({
      previewId: randomUUID(),
      repositoryId: entry.repositoryId,
      kind: MIRROR_PREVIEW_KIND,
      branch,
      expectedHead: accepted.acceptedSha,
      candidateSha,
      mirrorGeneration: Number(accepted.state?.generation || 0),
      relationship,
      eligible: !blockerCode,
      blockerCode,
      remoteFingerprint: entry.remoteFingerprint,
      payload: {
        remoteId: entry.remoteId,
        sourceRef: `refs/heads/${branch}`,
          lastAcceptedSha: accepted.acceptedSha,
          credentialStatus,
          mirrorStatus: fs.existsSync(entry.mirrorPath) ? "HEALTHY" : "NOT_INITIALIZED",
          requiresAdminReview,
          rewriteImpact,
        },
      createdAt: now,
      expiresAt: now + Math.max(10_000, Number(ttlMs) || this.previewTtlMs),
    });
    return {
      previewId: stored.previewId,
      previewVersion: stored.previewVersion,
      repositoryId: entry.repositoryId,
      remoteId: entry.remoteId,
      branch,
      lastAcceptedSha: accepted.acceptedSha,
      candidateSha,
      mirrorGeneration: stored.mirrorGeneration,
      relationship,
      eligible: stored.eligible,
      blockerCode: stored.blockerCode,
      credentialStatus,
      mirrorStatus: stored.payload.mirrorStatus,
      requiresAdminReview,
      rewriteImpact: stored.payload.rewriteImpact || null,
      expiresAt: stored.expiresAt,
    };
  }

  validateExecutionPreview({
    entry,
    branch,
    preview,
    previewVersion,
    expectedAcceptedSha,
    candidateSha,
    administrativeApproval = null,
  }) {
    if (
      !preview
      || preview.kind !== MIRROR_PREVIEW_KIND
      || preview.repositoryId !== entry.repositoryId
      || preview.branch !== branch
    ) {
      throw new GitControllerError(
        "GIT_CONTROLLER_PREVIEW_MISMATCH",
        "Mirror refresh preview does not match the requested repository and branch",
      );
    }
    if (preview.status !== "ACTIVE" || preview.expiresAt <= Date.now()) {
      throw new GitControllerError("GIT_CONTROLLER_PREVIEW_EXPIRED", "Mirror refresh preview expired");
    }
    if (Number(preview.previewVersion) !== Number(previewVersion)) {
      throw new GitControllerError(
        "GIT_CONTROLLER_PREVIEW_VERSION_MISMATCH",
        "Mirror refresh preview version changed",
      );
    }
    const expected = expectedAcceptedSha ? normalizeSha(expectedAcceptedSha, {
      label: "expected accepted SHA",
    }) : null;
    const candidate = normalizeSha(candidateSha, { label: "candidate SHA" });
    if (
      preview.expectedHead !== expected
      || preview.candidateSha !== candidate
      || preview.remoteFingerprint !== entry.remoteFingerprint
    ) {
      throw new GitControllerError(
        "GIT_CONTROLLER_PREVIEW_STALE",
        "Mirror refresh exact SHA fields no longer match the preview",
      );
    }
    const rewrite = [
      "REMOTE_REWIND",
      "DIVERGED_FROM_ACCEPTED",
    ].includes(preview.relationship);
    if (
      rewrite
      && administrativeApproval
      && (
        preview.payload?.rewriteImpact?.approvalAllowed !== true
        || administrativeApproval.impactDigest
          !== String(preview.payload?.rewriteImpact?.digest || "").toLowerCase()
      )
    ) {
      throw new GitControllerError(
        "GIT_CONTROLLER_REMOTE_HISTORY_IMPACT_UNKNOWN",
        "Remote history rewrite cannot be approved without complete impact and publication evidence",
      );
    }
    if (!preview.eligible && !(rewrite && administrativeApproval)) {
      throw new GitControllerError(
        preview.blockerCode || "GIT_CONTROLLER_PREVIEW_BLOCKED",
        "Mirror refresh preview is blocked by repository policy",
      );
    }
    return { expected, candidate };
  }

  async cleanupIncoming(entry, incomingRef, lease) {
    try {
      await this.runMutation(entry, this.mirrorArgs(entry, [
        "update-ref",
        "-d",
        incomingRef,
      ]), lease, {
        commandId: "mirror.cleanup-incoming",
      });
      return null;
    } catch (error) {
      return error.code || "GIT_CONTROLLER_INCOMING_CLEANUP_FAILED";
    }
  }

  async cleanupUnpublishedAcceptedHistory(entry, {
    branch,
    expectedSha = null,
    expectedGeneration,
    candidateSha,
    lease,
    commandId = "mirror.cleanup-unpublished-accepted-history",
  } = {}) {
    if (!lease) {
      throw new GitControllerError(
        "GIT_CONTROLLER_MIRROR_RETENTION_CLEANUP_LEASE_REQUIRED",
        "Unpublished accepted-history cleanup requires the active repository lease",
      );
    }
    const generation = Number(expectedGeneration);
    if (!Number.isSafeInteger(generation) || generation < 0) {
      throw new GitControllerError(
        "GIT_CONTROLLER_MIRROR_GENERATION_INVALID",
        "Unpublished accepted-history cleanup requires a valid durable generation",
      );
    }
    const expected = expectedSha
      ? normalizeSha(expectedSha, { label: "cleanup expected accepted SHA" })
      : null;
    const candidate = normalizeSha(candidateSha, {
      label: "cleanup unpublished accepted SHA",
    });
    const refName = this.acceptedHistoryRef(entry, branch, generation + 1);

    const assertDurableBaseline = async (stage) => {
      lease.assertCurrent();
      const state = this.persistence.getGitControllerMirrorState(
        entry.repositoryId,
        entry.remoteId,
        branch,
      );
      const stateSha = state?.acceptedSha || null;
      const stateGeneration = Number(state?.generation || 0);
      if (!fs.existsSync(entry.mirrorPath)) {
        if (expected === null && generation === 0 && stateSha === null && stateGeneration === 0) {
          return { acceptedSha: null, stateSha, stateGeneration, mirrorPresent: false };
        }
        throw new GitControllerError(
          "GIT_CONTROLLER_MIRROR_RETENTION_CLEANUP_UNSAFE",
          "Managed mirror disappeared while validating unpublished accepted-history cleanup",
          { stage, expectedSha: expected, stateSha, expectedGeneration: generation, stateGeneration },
        );
      }
      const acceptedResult = await this.run(entry, this.mirrorArgs(entry, [
        "rev-parse",
        "--verify",
        this.acceptedRef(entry, branch),
      ]), {
        commandId: `${commandId}.accepted-${stage}`,
        okExitCodes: [0, 1, 128],
      });
      const acceptedSha = acceptedResult.exitCode === 0
        ? normalizeSha(acceptedResult.stdout.trim(), {
            label: "cleanup observed accepted SHA",
          })
        : null;
      if (
        acceptedSha !== expected
        || stateSha !== expected
        || stateGeneration !== generation
      ) {
        throw new GitControllerError(
          "GIT_CONTROLLER_MIRROR_RETENTION_CLEANUP_UNSAFE",
          "Accepted ref or durable generation changed before unpublished history cleanup",
          {
            stage,
            expectedSha: expected,
            acceptedSha,
            stateSha,
            expectedGeneration: generation,
            stateGeneration,
          },
        );
      }
      return { acceptedSha, stateSha, stateGeneration, mirrorPresent: true };
    };

    const baseline = await assertDurableBaseline("initial");
    if (!baseline.mirrorPresent) {
      return {
        refName,
        sha: candidate,
        deleted: false,
        status: "MIRROR_NOT_INITIALIZED",
      };
    }
    const retainedResult = await this.run(entry, this.mirrorArgs(entry, [
      "rev-parse",
      "--verify",
      refName,
    ]), {
      commandId: `${commandId}.read`,
      okExitCodes: [0, 1, 128],
    });
    if (retainedResult.exitCode !== 0) {
      return {
        refName,
        sha: candidate,
        deleted: false,
        status: "NOT_PRESENT",
      };
    }
    const retainedSha = normalizeSha(retainedResult.stdout.trim(), {
      label: "cleanup observed retained accepted SHA",
    });
    if (retainedSha !== candidate) {
      throw new GitControllerError(
        "GIT_CONTROLLER_MIRROR_RETENTION_CLEANUP_UNSAFE",
        "Uncommitted accepted-history ref does not match this operation's exact candidate",
        { refName, expectedSha: candidate, actualSha: retainedSha },
      );
    }

    await assertDurableBaseline("pre-delete");
    if (typeof lease.heartbeat !== "function") {
      throw new GitControllerError(
        "GIT_CONTROLLER_MIRROR_RETENTION_CLEANUP_LEASE_INVALID",
        "Unpublished accepted-history cleanup requires a renewable repository lease",
      );
    }
    // Renew synchronously immediately before spawning the compare-and-delete
    // process. There is no await/yield between this fence renewal and spawn.
    // A second Controller cannot replace the live owner's protected OS lock;
    // a dead owner cannot resume this code path.
    lease.heartbeat();
    await this.runMutation(entry, this.mirrorArgs(entry, [
      "update-ref",
      "-d",
      refName,
      candidate,
    ]), lease, {
      commandId: `${commandId}.delete`,
    });
    const verified = await this.run(entry, this.mirrorArgs(entry, [
      "rev-parse",
      "--verify",
      refName,
    ]), {
      commandId: `${commandId}.verify`,
      okExitCodes: [0, 1, 128],
    });
    if (verified.exitCode === 0) {
      throw new GitControllerError(
        "GIT_CONTROLLER_MIRROR_RETENTION_CLEANUP_FAILED",
        "Unpublished accepted-history ref still exists after exact compare-and-delete",
        { refName, candidateSha: candidate },
      );
    }
    await assertDurableBaseline("post-delete");
    lease.assertCurrent();
    return {
      refName,
      sha: candidate,
      deleted: true,
      status: "DELETED",
    };
  }

  async runAutomaticMaintenance(entry, lease, {
    operation,
    branch,
    acceptedSha,
    recovered = false,
  } = {}) {
    if (!lease || !operation) {
      throw new GitControllerError(
        "GIT_CONTROLLER_MAINTENANCE_LEASE_REQUIRED",
        "Managed mirror maintenance requires the active repository lease",
      );
    }
    lease.assertCurrent();
    const storyRetentions = this.storyRetentionProvider
      ? await this.reconcileStoryBaseRetentions(entry, lease)
      : null;
    const acceptedState = await this.readAccepted(entry, branch);
    if (
      acceptedSha
      && (
        acceptedState.acceptedSha !== acceptedSha
        || !Number.isSafeInteger(Number(acceptedState.state?.generation))
        || Number(acceptedState.state?.generation) < 1
      )
    ) {
      throw new GitControllerError(
        "GIT_CONTROLLER_MIRROR_MAINTENANCE_STATE_DRIFT",
        "Managed mirror durable state changed before retention reconciliation",
      );
    }
    const acceptedHistory = acceptedSha
      ? await this.ensureImmutableRetentionRef(
          entry,
          this.acceptedHistoryRef(
            entry,
            branch,
            Number(acceptedState.state.generation),
          ),
          acceptedSha,
          { commandId: "mirror.maintenance-accepted-history", lease },
        )
      : null;
    if (
      !storyRetentions
      && String(process.env.DEVBENCH_GIT_CONTROLLER_DAEMON_RUNTIME || "") === "1"
    ) {
      this.journal.append(operation, "MIRROR_MAINTENANCE_VERIFIED", {
        branch,
        acceptedSha,
        mode: "deferred-until-story-retention-reconcile",
        recovered,
        acceptedHistory,
      }, lease.fencingToken);
      return {
        attempted: false,
        mode: "deferred-until-story-retention-reconcile",
        foreground: true,
        leaseFencingToken: lease.fencingToken,
        verified: false,
        deferred: true,
        acceptedHistory,
      };
    }
    this.journal.append(operation, "MIRROR_MAINTENANCE_RUNNING", {
      branch,
      acceptedSha,
      mode: "foreground-auto-gc",
      recovered,
      storyRetentions,
      acceptedHistory,
    }, lease.fencingToken);
    if (this.faultInjector) {
      await this.faultInjector("before-mirror-maintenance", {
        operation,
        entry,
        branch,
        acceptedSha,
        lease,
        recovered,
      });
    }
    // --auto retains Git's threshold policy, but autoDetach=false guarantees
    // the process completes before the repository lease can be released.
    await this.runMutation(entry, this.mirrorMaintenanceArgs(entry, [
      "gc",
      "--auto",
    ]), lease, {
      commandId: "mirror.maintenance-auto-gc",
      timeoutMs: 15 * 60_000,
    });
    lease.assertCurrent();
    const verified = await this.readAccepted(entry, branch);
    if (verified.acceptedSha !== acceptedSha) {
      throw new GitControllerError(
        "GIT_CONTROLLER_MIRROR_MAINTENANCE_REF_CHANGED",
        "Managed mirror accepted ref changed during maintenance",
        {
          repositoryId: entry.repositoryId,
          branch,
          expectedAcceptedSha: acceptedSha,
          actualAcceptedSha: verified.acceptedSha,
        },
      );
    }
    await this.run(entry, this.mirrorArgs(entry, [
      "fsck",
      "--connectivity-only",
    ]), {
      commandId: "mirror.maintenance-fsck",
      timeoutMs: 120_000,
    });
    lease.assertCurrent();
    this.journal.append(operation, "MIRROR_MAINTENANCE_VERIFIED", {
      branch,
      acceptedSha,
      mode: "foreground-auto-gc",
      recovered,
      storyRetentions,
      acceptedHistory,
    }, lease.fencingToken);
    return {
      attempted: true,
      mode: "foreground-auto-gc",
      foreground: true,
      leaseFencingToken: lease.fencingToken,
      verified: true,
      storyRetentions,
      acceptedHistory,
    };
  }

  async recover() {
    const operations = listAllRecoverableOperations(this.persistence, {
      operationType: MIRROR_OPERATION_TYPE,
    });
    const unresolved = [];
    for (const operation of operations) {
      let entry = null;
      let lease = null;
      let reclaimed = false;
      try {
        entry = this.registry.get(operation.repositoryId);
        this.leaseManager.reclaimOrphanedOperation(entry, operation);
        reclaimed = true;
        const branch = operation.branch;
        const expected = operation.expectedHead || null;
        const candidate = operation.candidateSha;
        const incomingRef = this.incomingRef(operation.operationId, branch);
        lease = this.leaseManager.acquire(entry, {
          operationId: operation.operationId,
          kind: "mirror-recovery",
        });
        lease.assertCurrent();
        const operationJournal = this.persistence.listGitControllerJournal(
          operation.operationId,
        );
        const publishing = operationJournal
          .findLast((row) => row.phase === "MIRROR_PUBLISHING");
        const hasDurablePublishingCheckpoint = !!publishing;
        if (![
          "MIRROR_PUBLISHING",
          "MIRROR_ACCEPTED",
          "MIRROR_MAINTENANCE_RUNNING",
          "MIRROR_MAINTENANCE_VERIFIED",
          "RECOVERY_REQUIRED",
        ].includes(operation.phase) && !(
          operation.phase === "MIRROR_RETENTION_VERIFIED"
          && hasDurablePublishingCheckpoint
        )) {
          const recoveryPreview = this.persistence.getGitControllerPreview(
            operation.previewId,
          );
          const expectedGeneration = Number(recoveryPreview?.mirrorGeneration);
          if (
            recoveryPreview?.repositoryId !== entry.repositoryId
            || recoveryPreview?.branch !== branch
            || recoveryPreview?.expectedHead !== expected
            || recoveryPreview?.candidateSha !== candidate
            || !Number.isSafeInteger(expectedGeneration)
            || expectedGeneration < 0
          ) {
            throw new GitControllerError(
              "GIT_CONTROLLER_MIRROR_RECOVERY_CHECKPOINT_INVALID",
              "Pre-publication recovery cannot prove the exact preview generation",
              { operationId: operation.operationId },
            );
          }
          const historyCleanup = await this.cleanupUnpublishedAcceptedHistory(entry, {
            branch,
            expectedSha: expected,
            expectedGeneration,
            candidateSha: candidate,
            lease,
            commandId: "mirror.recovery-cleanup-pre-publication-history",
          });
          await this.cleanupIncoming(entry, incomingRef, lease);
          this.journal.fail(operation, new GitControllerError(
            "GIT_CONTROLLER_INTERRUPTED_BEFORE_PUBLICATION",
            "Interrupted mirror operation was recovered before accepted ref publication",
          ), {
            fencingToken: lease.fencingToken,
            data: { historyCleanup },
          });
          continue;
        }
        const checkpoint = this.validateRecoveryPublishingCheckpoint({
          entry,
          operation,
          publishing,
        });
        const {
          expectedGeneration,
          relationship,
          actor,
          administrativeApproval,
          checkpointAt,
        } = checkpoint;
        const refResult = await this.run(entry, this.mirrorArgs(entry, [
          "rev-parse",
          "--verify",
          `${this.acceptedRef(entry, branch)}^{commit}`,
        ]), {
          commandId: "mirror.recovery-read-ref",
          okExitCodes: [0, 1, 128],
        });
        const refSha = refResult.exitCode === 0
          ? normalizeSha(refResult.stdout.trim(), { label: "recovery accepted ref" })
          : null;
        let state = this.persistence.getGitControllerMirrorState(
          entry.repositoryId,
          entry.remoteId,
          branch,
        );
        const stateSha = state?.acceptedSha || null;
        const stateGeneration = Number(state?.generation || 0);
        const durablePublicationCommitted = (
          refSha === candidate
          && stateSha === candidate
          && state?.operationId === operation.operationId
          && state?.remoteFingerprint === entry.remoteFingerprint
          && stateGeneration === expectedGeneration + 1
        );
        if (!durablePublicationCommitted) {
          if (
            refSha === expected
            && stateSha === expected
            && stateGeneration === expectedGeneration
          ) {
            const historyCleanup = await this.cleanupUnpublishedAcceptedHistory(entry, {
              branch,
              expectedSha: expected,
              expectedGeneration,
              candidateSha: candidate,
              lease,
              commandId: "mirror.recovery-cleanup-unpublished-history",
            });
            await this.cleanupIncoming(entry, incomingRef, lease);
            this.journal.fail(operation, new GitControllerError(
              "GIT_CONTROLLER_INTERRUPTED_BEFORE_REF_SWAP",
              "Interrupted mirror publication was safely closed before the accepted ref moved",
            ), {
              fencingToken: lease.fencingToken,
              data: { historyCleanup },
            });
            continue;
          }
          if (
            refSha !== candidate
            || stateSha !== expected
            || stateGeneration !== expectedGeneration
          ) {
            throw new GitControllerError(
              "GIT_CONTROLLER_MIRROR_RECOVERY_REQUIRED",
              "Mirror accepted ref and durable state cannot be safely reconciled",
              { expected, candidate, refSha, stateSha },
            );
          }
          const swapped = this.persistence.compareAndSwapGitControllerMirrorState({
            repositoryId: entry.repositoryId,
            remoteId: entry.remoteId,
            branch,
            expectedSha: expected,
            expectedGeneration,
            acceptedSha: candidate,
            sourceRef: `refs/heads/${branch}`,
            operationId: operation.operationId,
            fencingToken: lease.fencingToken,
            remoteFingerprint: entry.remoteFingerprint,
            acceptedAt: Date.now(),
          });
          if (!swapped?.ok) {
            throw new GitControllerError(
              "GIT_CONTROLLER_MIRROR_RECOVERY_REQUIRED",
              "Mirror ref publication recovery CAS failed",
            );
          }
          state = swapped.state;
        }
        this.journal.append(operation, "MIRROR_ACCEPTED", {
          previousSha: expected,
          candidateSha: candidate,
          relationship,
          administrativeApproval,
          generation: state.generation,
          recovered: true,
        }, lease.fencingToken);
        await this.cleanupIncoming(entry, incomingRef, lease);
        const maintenance = await this.runAutomaticMaintenance(entry, lease, {
          operation,
          branch,
          acceptedSha: candidate,
          recovered: true,
        });
        const result = {
          ok: true,
          operationId: operation.operationId,
          replayed: false,
          recovered: true,
          resultCode: "PASS",
          repositoryId: entry.repositoryId,
          remoteId: entry.remoteId,
          branch,
          previousSha: expected,
          candidateSha: candidate,
          generation: state.generation,
          relationship,
          administrativeApproval,
          approvalCheckpointAt: checkpointAt,
          cleanupWarning: null,
          maintenance,
        };
        const existingPassAudit = this.persistence.listGitControllerAudit({
          operationId: operation.operationId,
        }).some((row) => (
          row.action === "mirror.accepted.publish"
          && row.result === "PASS"
          && row.beforeSha === expected
          && row.candidateSha === candidate
          && Number(row.details?.generation) === Number(state.generation)
        ));
        if (!existingPassAudit) {
          this.audit.write({
            operation,
            commandId: MIRROR_COMMAND_ID,
            action: "mirror.accepted.publish",
            branch,
            beforeSha: expected,
            candidateSha: candidate,
            result: "PASS",
            reason: "startup-recovery",
            durationMs: Math.max(0, Date.now() - Number(operation.startedAt || 0)),
            fencingToken: lease.fencingToken,
            actor: actor || "controller:mirror-recovery",
            details: {
              relationship,
              generation: state.generation,
              administrativeApproval,
              approvalCheckpointAt: checkpointAt,
              cleanupWarning: null,
              maintenance,
              recovered: true,
            },
          });
        }
        this.journal.succeed(operation, result, lease.fencingToken);
      } catch (error) {
        const converted = asControllerError(error);
        if (reclaimed) {
          try {
            this.journal.fail(operation, converted, {
              fencingToken: lease?.fencingToken || null,
              recoveryRequired: true,
            });
          } catch {}
        }
        unresolved.push(converted);
      } finally {
        lease?.release();
      }
    }
    if (unresolved.length) {
      throw new GitControllerError(
        "GIT_CONTROLLER_MIRROR_RECOVERY_BLOCKED",
        "One or more mirror operations require administrative recovery",
        { errors: unresolved.map((error) => error.code) },
      );
    }
    return { recovered: operations.length };
  }

  async execute({
    repositoryId,
    branch: branchValue,
    previewId,
    previewVersion,
    expectedAcceptedSha = null,
    candidateSha: candidateValue,
    idempotencyKey: idempotencyValue,
    actor = null,
    adminApprovalId = "",
    adminApprovedAt = null,
    adminApprovalExpiresAt = null,
    adminApprovedRelationship = "",
    adminApprovedBy = "",
    adminApprovedPreviewId = "",
    adminApprovedPreviewVersion = null,
    adminApprovedPreviousSha = "",
    adminApprovedCandidateSha = "",
    adminApprovedImpactDigest = "",
  } = {}) {
    const idempotencyKey = assertIdempotencyKey(idempotencyValue);
    const { entry, branch } = await this.registry.resolve(repositoryId, branchValue);
    const expectedInput = expectedAcceptedSha
      ? normalizeSha(expectedAcceptedSha, { label: "expected accepted SHA" })
      : null;
    const candidateInput = normalizeSha(candidateValue, { label: "candidate SHA" });
    const replayBinding = {
      previewId,
      branch,
      expectedHead: expectedInput,
      candidateSha: candidateInput,
    };
    const existing = this.persistence.getGitControllerOperationByIdempotency(
      entry.repositoryId,
      MIRROR_OPERATION_TYPE,
      idempotencyKey,
    );
    if (existing) {
      assertReplayBinding(existing, replayBinding);
      return replayOrThrow(existing);
    }
    const preview = this.persistence.getGitControllerPreview(previewId);
    const approvalInputPresent = !!(
      adminApprovalId
      || adminApprovedAt != null
      || adminApprovalExpiresAt != null
      || adminApprovedRelationship
      || adminApprovedBy
      || adminApprovedPreviewId
      || adminApprovedPreviewVersion != null
      || adminApprovedPreviousSha
      || adminApprovedCandidateSha
      || adminApprovedImpactDigest
    );
    const previewApproval = approvalInputPresent
      ? this.validateAdministrativeApproval({
          relationship: preview?.relationship,
          repositoryId: entry.repositoryId,
          branch,
          previewId,
          previewVersion,
          expected: expectedInput,
          candidate: candidateInput,
          actor,
          adminApprovalId,
          adminApprovedAt,
          adminApprovalExpiresAt,
          adminApprovedRelationship,
          adminApprovedBy,
          adminApprovedPreviewId,
          adminApprovedPreviewVersion,
          adminApprovedPreviousSha,
          adminApprovedCandidateSha,
          impactDigest: preview?.payload?.rewriteImpact?.digest,
          adminApprovedImpactDigest,
        })
      : null;
    const { expected, candidate } = this.validateExecutionPreview({
      entry,
      branch,
      preview,
      previewVersion,
      expectedAcceptedSha: expectedInput,
      candidateSha: candidateInput,
      administrativeApproval: previewApproval,
    });
    const begun = this.journal.begin({
      repositoryId: entry.repositoryId,
      operationType: MIRROR_OPERATION_TYPE,
      commandId: MIRROR_COMMAND_ID,
      idempotencyKey,
      previewId,
      branch,
      expectedHead: expected,
      candidateSha: candidate,
    });
    if (!begun.created) {
      assertReplayBinding(begun.operation, replayBinding);
      return replayOrThrow(begun.operation);
    }
    const operation = begun.operation;
    const consumed = this.persistence.consumeGitControllerPreview(previewId, operation.operationId);
    if (!consumed?.ok) {
      const error = new GitControllerError(
        "GIT_CONTROLLER_PREVIEW_CONSUMED",
        "Mirror refresh preview was already consumed",
      );
      this.journal.fail(operation, error);
      throw error;
    }

    const startedAt = Date.now();
    let lease = null;
    let incomingRef = null;
    let relationship = preview.relationship;
    let acceptedPublished = false;
    let retainedHistory = null;
    let cleanupWarning = null;
    try {
      lease = this.leaseManager.acquire(entry, {
        operationId: operation.operationId,
        kind: "mirror-refresh",
      });
      await this.ensureMirror(entry, lease);
      lease.assertCurrent();
      const current = await this.readAccepted(entry, branch);
      if (
        current.acceptedSha !== expected
        || Number(current.state?.generation || 0) !== Number(preview.mirrorGeneration)
      ) {
        throw new GitControllerError(
          "GIT_CONTROLLER_PREVIEW_STALE",
          "Accepted mirror state changed after preview",
        );
      }
      incomingRef = this.incomingRef(operation.operationId, branch);
      this.journal.append(operation, "MIRROR_FETCHING", {
        previousSha: expected,
        candidateSha: candidate,
        branch,
      }, lease.fencingToken);
      await this.runMutation(entry, this.mirrorArgs(entry, [
        "fetch",
        "--no-auto-maintenance",
        "--atomic",
        "--no-tags",
        "--no-write-fetch-head",
        entry.remoteUrl,
        `+refs/heads/${branch}:${incomingRef}`,
      ]), lease, {
        commandId: "mirror.fetch-incoming",
        timeoutMs: 120_000,
        remoteUrl: entry.remoteUrl,
      });
      const incomingSha = normalizeSha((await this.run(entry, this.mirrorArgs(entry, [
        "rev-parse",
        "--verify",
        `${incomingRef}^{commit}`,
      ]), {
        commandId: "mirror.verify-incoming",
      })).stdout.trim(), { label: "incoming SHA" });
      if (incomingSha !== candidate) {
        throw new GitControllerError(
          "GIT_CONTROLLER_REMOTE_CHANGED",
          "Fetched candidate differs from the previewed remote tip",
          { previewCandidate: candidate, fetchedCandidate: incomingSha },
        );
      }
      await this.run(entry, this.mirrorArgs(entry, [
        "fsck",
        "--connectivity-only",
        candidate,
      ]), {
        commandId: "mirror.fsck-candidate",
        timeoutMs: 120_000,
      });
      const secondObservedSha = await this.observeRemoteTip(entry, branch);
      if (secondObservedSha !== candidate) {
        throw new GitControllerError(
          "GIT_CONTROLLER_REMOTE_CHANGED",
          "Remote branch changed while the candidate was being validated",
          { previewCandidate: candidate, observedCandidate: secondObservedSha },
        );
      }
      await this.registry.verify(entry.repositoryId);
      relationship = await this.classify(entry, expected, candidate);
      const executionRewriteImpact = REWRITE_RELATIONSHIPS.includes(relationship)
        ? await this.computeRewriteImpact(entry, {
            branch,
            previousSha: expected,
            candidateSha: candidate,
          })
        : null;
      if (
        REWRITE_RELATIONSHIPS.includes(relationship)
        && (
          !executionRewriteImpact?.approvalAllowed
          || executionRewriteImpact.digest
            !== String(preview.payload?.rewriteImpact?.digest || "").toLowerCase()
        )
      ) {
        throw new GitControllerError(
          "GIT_CONTROLLER_PREVIEW_STALE",
          "Remote history rewrite impact changed after preview or remains incomplete",
          {
            previewImpactDigest: preview.payload?.rewriteImpact?.digest || null,
            executionImpactDigest: executionRewriteImpact?.digest || null,
          },
        );
      }
      const administrativeApproval = this.validateAdministrativeApproval({
        relationship,
        repositoryId: entry.repositoryId,
        branch,
        previewId,
        previewVersion,
        expected,
        candidate,
        actor,
        adminApprovalId,
        adminApprovedAt,
        adminApprovalExpiresAt,
        adminApprovedRelationship,
        adminApprovedBy,
        adminApprovedPreviewId,
        adminApprovedPreviewVersion,
        adminApprovedPreviousSha,
        adminApprovedCandidateSha,
        impactDigest: executionRewriteImpact?.digest,
        adminApprovedImpactDigest,
      });
      lease.assertCurrent();
      const beforePublish = await this.readAccepted(entry, branch);
      if (
        beforePublish.acceptedSha !== expected
        || Number(beforePublish.state?.generation || 0) !== Number(preview.mirrorGeneration)
      ) {
        throw new GitControllerError(
          "GIT_CONTROLLER_ACCEPTED_CAS_FAILED",
          "Accepted mirror ref changed before publication",
        );
      }
      const finalObservedSha = await this.observeRemoteTip(entry, branch);
      if (finalObservedSha !== candidate) {
        throw new GitControllerError(
          "GIT_CONTROLLER_REMOTE_CHANGED",
          "Remote branch changed after rewrite impact approval and before publication",
          { previewCandidate: candidate, observedCandidate: finalObservedSha },
        );
      }
      lease.assertCurrent();
      const oldValue = expected || "0".repeat(candidate.length);
      this.journal.append(operation, "MIRROR_PUBLISHING", {
        repositoryId: entry.repositoryId,
        branch,
        previewId,
        previewVersion: Number(previewVersion),
        previousSha: expected,
        candidateSha: candidate,
        relationship,
        expectedGeneration: preview.mirrorGeneration,
        actor: actor == null ? null : String(actor).trim(),
        rewriteImpactDigest: executionRewriteImpact?.digest || null,
        administrativeApproval,
      }, lease.fencingToken);
      // Re-fence immediately before the first accepted-history mutation. The
      // heartbeat is synchronous, so a handler whose SQLite fence was advanced
      // while it was suspended cannot resume and create a retained generation.
      lease.heartbeat();
      retainedHistory = await this.ensureImmutableRetentionRef(
        entry,
        this.acceptedHistoryRef(
          entry,
          branch,
          Number(preview.mirrorGeneration) + 1,
        ),
        candidate,
        { commandId: "mirror.accepted-history", lease },
      );
      if (this.faultInjector) {
        await this.faultInjector("after-accepted-history-publish", {
          operation,
          entry,
          branch,
          expected,
          candidate,
          retainedHistory,
        });
      }
      this.journal.append(operation, "MIRROR_RETENTION_VERIFIED", {
        refName: retainedHistory.refName,
        candidateSha: candidate,
        generation: Number(preview.mirrorGeneration) + 1,
        created: retainedHistory.created,
      }, lease.fencingToken);
      // The retention helper and fault-injection hook are asynchronous. Renew
      // and revalidate both the durable fence and protected OS lock before the
      // accepted ref CAS.
      lease.heartbeat();
      await this.runMutation(entry, this.mirrorArgs(entry, [
        "update-ref",
        this.acceptedRef(entry, branch),
        candidate,
        oldValue,
      ]), lease, {
        commandId: "mirror.publish-accepted",
      });
      if (this.faultInjector) {
        await this.faultInjector("after-accepted-ref-publish", {
          operation,
          entry,
          branch,
          expected,
          candidate,
        });
      }
      const swapped = this.persistence.compareAndSwapGitControllerMirrorState({
        repositoryId: entry.repositoryId,
        remoteId: entry.remoteId,
        branch,
        expectedSha: expected,
        expectedGeneration: preview.mirrorGeneration,
        acceptedSha: candidate,
        sourceRef: `refs/heads/${branch}`,
        operationId: operation.operationId,
        fencingToken: lease.fencingToken,
        remoteFingerprint: entry.remoteFingerprint,
        acceptedAt: Date.now(),
      });
      if (!swapped?.ok) {
        let rolledBack = false;
        try {
          lease.assertCurrent();
          if (expected) {
            await this.runMutation(entry, this.mirrorArgs(entry, [
              "update-ref",
              this.acceptedRef(entry, branch),
              expected,
              candidate,
            ]), lease, { commandId: "mirror.rollback-accepted" });
          } else {
            await this.runMutation(entry, this.mirrorArgs(entry, [
              "update-ref",
              "-d",
              this.acceptedRef(entry, branch),
              candidate,
            ]), lease, { commandId: "mirror.rollback-accepted" });
          }
          rolledBack = true;
        } catch {}
        throw new GitControllerError(
          rolledBack
            ? "GIT_CONTROLLER_ACCEPTED_CAS_FAILED"
            : "GIT_CONTROLLER_MIRROR_RECOVERY_REQUIRED",
          "Accepted mirror state compare-and-swap failed",
          { rolledBack },
        );
      }
      if (this.faultInjector) {
        await this.faultInjector("after-mirror-state-cas", {
          operation,
          entry,
          branch,
          expected,
          candidate,
          state: swapped.state,
        });
      }
      acceptedPublished = true;
      this.journal.append(operation, "MIRROR_ACCEPTED", {
        previousSha: expected,
        candidateSha: candidate,
        relationship,
        generation: swapped.state.generation,
      }, lease.fencingToken);
      cleanupWarning = await this.cleanupIncoming(entry, incomingRef, lease);
      incomingRef = null;
      const maintenance = await this.runAutomaticMaintenance(entry, lease, {
        operation,
        branch,
        acceptedSha: candidate,
      });
      const result = {
        ok: true,
        operationId: operation.operationId,
        replayed: false,
        resultCode: "PASS",
        repositoryId: entry.repositoryId,
        remoteId: entry.remoteId,
        branch,
        previousSha: expected,
        candidateSha: candidate,
        generation: swapped.state.generation,
        relationship,
        administrativeApproval,
        cleanupWarning,
        maintenance,
      };
      this.audit.write({
        operation,
        commandId: MIRROR_COMMAND_ID,
        action: "mirror.accepted.publish",
        branch,
        beforeSha: expected,
        candidateSha: candidate,
        result: "PASS",
        durationMs: Date.now() - startedAt,
        fencingToken: lease.fencingToken,
        actor,
        details: {
          relationship,
          generation: swapped.state.generation,
          administrativeApproval,
          cleanupWarning,
          maintenance,
        },
      });
      this.journal.succeed(operation, result, lease.fencingToken);
      return result;
    } catch (rawError) {
      if (rawError?.simulateProcessCrash === true) throw rawError;
      let error = asControllerError(rawError);
      let historyCleanup = null;
      if (retainedHistory && !acceptedPublished) {
        if (!lease || lease.lost) {
          error = new GitControllerError(
            "GIT_CONTROLLER_MIRROR_RECOVERY_REQUIRED",
            "Unpublished accepted-history could not be cleaned without the active repository lease",
            { precedingError: error.code },
            { cause: error },
          );
        } else {
          try {
            historyCleanup = await this.cleanupUnpublishedAcceptedHistory(entry, {
              branch,
              expectedSha: expected,
              expectedGeneration: preview.mirrorGeneration,
              candidateSha: candidate,
              lease,
              commandId: "mirror.failure-cleanup-unpublished-history",
            });
          } catch (cleanupError) {
            const convertedCleanupError = asControllerError(
              cleanupError,
              "GIT_CONTROLLER_MIRROR_RETENTION_CLEANUP_FAILED",
            );
            error = new GitControllerError(
              "GIT_CONTROLLER_MIRROR_RECOVERY_REQUIRED",
              "Unpublished accepted-history requires fenced startup recovery",
              {
                precedingError: error.code,
                cleanupError: convertedCleanupError.code,
              },
              { cause: error },
            );
          }
        }
      }
      const recoveryRequired = acceptedPublished
        || error.code === "GIT_CONTROLLER_MIRROR_RECOVERY_REQUIRED";
      try {
        this.audit.write({
          operation,
          commandId: MIRROR_COMMAND_ID,
          action: "mirror.accepted.publish",
          branch,
          beforeSha: expected,
          candidateSha: candidate,
          result: recoveryRequired ? "RECOVERY_REQUIRED" : "FAIL",
          reason: error.code,
          durationMs: Date.now() - startedAt,
          fencingToken: lease?.fencingToken || null,
          actor,
          details: {
            relationship,
            administrativeApproval: adminApprovalId
              ? {
                  approvalId: String(adminApprovalId),
                  approvedBy: String(adminApprovedBy || actor || ""),
                }
              : null,
            historyCleanup,
          },
        });
      } catch (auditError) {
        const auditFailure = asControllerError(auditError, "GIT_CONTROLLER_AUDIT_WRITE_FAILED");
        this.journal.fail(operation, auditFailure, {
          fencingToken: lease?.fencingToken || null,
          recoveryRequired: true,
          data: { precedingError: error.code, historyCleanup },
        });
        throw auditFailure;
      }
      this.journal.fail(operation, error, {
        fencingToken: lease?.fencingToken || null,
        recoveryRequired,
        data: { historyCleanup },
      });
      throw error;
    } finally {
      if (incomingRef && fs.existsSync(entry.mirrorPath) && lease && !lease.lost) {
        await this.cleanupIncoming(entry, incomingRef, lease);
      }
      lease?.release();
    }
  }
}

export function createMirrorSyncService(options = {}) {
  return new MirrorSyncService(options);
}

export {
  MIRROR_COMMAND_ID,
  MIRROR_OPERATION_TYPE,
  MIRROR_PREVIEW_KIND,
};
