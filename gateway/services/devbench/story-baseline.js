import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import * as defaultPersistence from "../../db/sqlite.js";
import {
  GitControllerError,
  assertIdempotencyKey,
  canonicalizeExistingDirectory,
  ensureManagedDirectory,
  normalizeSha,
  pathInside,
  pathKey,
  runGitFile,
} from "./git-controller/path-security.js";
import { controllerIncomingRef } from "./git-controller/internal-refs.js";
import {
  INDEPENDENT_REPOSITORY_MODE,
  inspectIndependentStoryRepository,
  normalizeAcceptedDescriptor,
} from "./git-controller/story-repository.js";
import {
  STORY_BASELINE_METADATA_KEYS,
  createStoryBaselineRegistryRecoveryMarker,
  validateStoryBaselineRegistryRecoveryPrior,
} from "./story-baseline-registry-recovery.js";

const STORY_BASELINE_PREVIEW_KIND = "STORY_BASELINE_SYNC";
const STORY_BASELINE_OPERATION_TYPE = "STORY_BASELINE_SYNC";
const STORY_BASELINE_COMMAND_ID = "story.baseline.refresh";
const STORY_BASELINE_FF_ONLY_STRATEGY = "FF_ONLY";
const STORY_BASELINE_MERGE_STRATEGY = "MERGE";
const STORY_BASELINE_DEFAULT_STRATEGY = STORY_BASELINE_MERGE_STRATEGY;
const STORY_BASELINE_STRATEGY = STORY_BASELINE_FF_ONLY_STRATEGY;

function normalizeStrategy(value = STORY_BASELINE_DEFAULT_STRATEGY) {
  const normalized = String(value || STORY_BASELINE_DEFAULT_STRATEGY)
    .trim()
    .toUpperCase()
    .replace(/-/g, "_");
  if (normalized === STORY_BASELINE_FF_ONLY_STRATEGY) {
    return STORY_BASELINE_FF_ONLY_STRATEGY;
  }
  if (normalized === STORY_BASELINE_MERGE_STRATEGY) {
    return STORY_BASELINE_MERGE_STRATEGY;
  }
  throw new GitControllerError(
    "STORY_BASELINE_STRATEGY_REJECTED",
    "Story baseline strategy must be FF_ONLY or MERGE",
  );
}

function asControllerError(error, fallbackCode = "STORY_BASELINE_SYNC_FAILED") {
  if (error instanceof GitControllerError) return error;
  return new GitControllerError(
    String(error?.code || fallbackCode),
    "Independent story repository baseline synchronization failed",
    {
      cause: error?.message || String(error),
    },
    { cause: error },
  );
}

function repositoryPathOf(repository = {}) {
  const aliases = [
    repository.repositoryPath,
    repository.worktreePath,
  ].map((value) => String(value || "").trim()).filter(Boolean);
  if (!aliases.length) {
    throw new GitControllerError(
      "STORY_BASELINE_REPOSITORY_PATH_REQUIRED",
      "Independent story repository root is required",
    );
  }
  const canonical = canonicalizeExistingDirectory(aliases[0], {
    label: "independent story repository",
  });
  for (const alias of aliases.slice(1)) {
    const other = canonicalizeExistingDirectory(alias, {
      label: "independent story repository alias",
    });
    if (pathKey(other) !== pathKey(canonical)) {
      throw new GitControllerError(
        "STORY_BASELINE_REPOSITORY_PATH_CONFLICT",
        "Story repository path aliases do not identify the same repository",
      );
    }
  }
  return canonical;
}

function storyIdentity({ tabId, repository = {} } = {}) {
  if (String(repository.repositoryMode || "").trim() !== INDEPENDENT_REPOSITORY_MODE) {
    throw new GitControllerError(
      "STORY_BASELINE_INDEPENDENT_REPOSITORY_REQUIRED",
      "Story baseline synchronization only supports independent repositories",
    );
  }
  const storyId = String(repository.storyId || tabId || "").trim();
  if (!storyId) {
    throw new GitControllerError(
      "STORY_BASELINE_STORY_ID_REQUIRED",
      "Story identity is required",
    );
  }
  return storyId;
}

function storyKey(storyId, repositoryId, repositoryPath) {
  return createHash("sha256")
    .update(`${storyId}\0${repositoryId}\0${pathKey(repositoryPath)}`)
    .digest("hex");
}

function statusClassification(output) {
  const text = String(output || "").replace(/\r\n/g, "\n").trimEnd();
  const lines = text ? text.split("\n").filter(Boolean) : [];
  const untracked = lines.filter((line) => line.startsWith("? "));
  const tracked = lines.filter((line) => !line.startsWith("? ") && !line.startsWith("! "));
  return {
    clean: lines.length === 0,
    trackedCount: tracked.length,
    untrackedCount: untracked.length,
    statusHash: createHash("sha256").update(text).digest("hex"),
  };
}

function replayOrThrow(operation, {
  previewId,
  expectedHead,
  candidateSha,
} = {}) {
  if (
    operation.previewId !== previewId
    || operation.expectedHead !== expectedHead
    || operation.candidateSha !== candidateSha
  ) {
    throw new GitControllerError(
      "GIT_CONTROLLER_IDEMPOTENCY_CONFLICT",
      "Idempotency key was already used for a different story baseline request",
      { operationId: operation.operationId },
    );
  }
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
    stored.message || "The idempotent story baseline operation previously failed",
    {
      ...(stored.details || {}),
      operationId: operation.operationId,
      replayed: true,
    },
  );
}

export class StoryBaselineService {
  constructor({
    controller,
    persistence = defaultPersistence,
    gitRunner = runGitFile,
    previewTtlMs = 5 * 60_000,
  } = {}) {
    if (
      !controller?.registry
      || !controller?.mirror
      || !controller?.leaseManager
      || !controller?.journal
      || !controller?.audit
    ) {
      throw new GitControllerError(
        "GIT_CONTROLLER_DEPENDENCY_MISSING",
        "Story baseline service requires a complete Git Controller",
      );
    }
    if (typeof gitRunner !== "function") {
      throw new GitControllerError(
        "GIT_CONTROLLER_GIT_RUNNER_INVALID",
        "Story baseline Git runner must be a function",
      );
    }
    this.controller = controller;
    this.persistence = persistence;
    this.gitRunner = gitRunner;
    this.previewTtlMs = Math.max(10_000, Number(previewTtlMs) || 5 * 60_000);
    this.disabledHooksPath = ensureManagedDirectory(
      path.join(this.controller.registry.dataRoot, "story-hooks-disabled"),
      {
        allowedRoot: this.controller.registry.dataRoot,
        label: "story baseline disabled hooks directory",
      },
    );
  }

  storyArgs(repositoryPath, args) {
    return [
      "--no-optional-locks",
      "-c",
      `safe.directory=${repositoryPath.replace(/\\/g, "/")}`,
      "-c",
      "core.fsmonitor=false",
      "-c",
      "core.untrackedCache=false",
      "-c",
      `core.hooksPath=${this.disabledHooksPath.replace(/\\/g, "/")}`,
      "-c",
      "diff.external=",
      "-c",
      `core.attributesFile=${process.platform === "win32" ? "NUL" : "/dev/null"}`,
      "-c",
      "credential.helper=",
      "-c",
      "credential.interactive=never",
      "-C",
      repositoryPath,
      ...args,
    ];
  }

  storyMutationArgs(repositoryPath, args) {
    return this.storyArgs(repositoryPath, args);
  }

  mirrorArgs(entry, args) {
    return ["--git-dir", entry.mirrorPath, ...args];
  }

  async run(args, {
    commandId,
    timeoutMs,
    okExitCodes = [0],
  } = {}) {
    this.controller.registry.attestGitBinary();
    return this.gitRunner({
      gitBinary: this.controller.registry.gitBinary,
      disabledHooksPath: this.disabledHooksPath,
      knownHostsPath: this.controller.registry.knownHostsPath,
      args,
      commandId,
      timeoutMs,
      okExitCodes,
    });
  }

  async runStory(context, args, options = {}) {
    return this.run(this.storyArgs(context.repositoryPath, args), options);
  }

  async runStoryMutation(context, args, options = {}) {
    return this.run(this.storyMutationArgs(context.repositoryPath, args), options);
  }

  async runMirror(context, args, options = {}) {
    return this.run(this.mirrorArgs(context.entry, args), options);
  }

  assertStoryRepositoryMutationBoundary() {
    const environment = String(process.env.NODE_ENV || "").trim().toLowerCase();
    if (environment === "test") return;
    if (
      environment === "development"
      && String(process.env.DEVBENCH_ALLOW_UNSAFE_IN_PROCESS_STORY_BASELINE || "") === "1"
    ) {
      return;
    }
    throw new GitControllerError(
      "STORY_BASELINE_RESTRICTED_EXECUTOR_REQUIRED",
      "Production story baseline refresh is blocked until Git runs under the story Worker identity or an equivalent OS-confined executor",
      {
        isolationRequired: true,
        controllerPathGitForbidden: true,
      },
    );
  }

  async resolveRequest({
    tabId,
    repository,
    accepted,
    strategy = STORY_BASELINE_DEFAULT_STRATEGY,
  } = {}) {
    const normalizedStrategy = normalizeStrategy(strategy);
    const storyId = storyIdentity({ tabId, repository });
    const descriptor = normalizeAcceptedDescriptor(accepted || {});
    const requestedRepositoryId = String(repository?.repositoryId || "").trim();
    if (requestedRepositoryId && requestedRepositoryId !== descriptor.repositoryId) {
      throw new GitControllerError(
        "STORY_BASELINE_REPOSITORY_ID_MISMATCH",
        "Story entry and accepted descriptor identify different repositories",
      );
    }
    const branch = descriptor.sourceRef.slice("refs/heads/".length);
    const resolved = await this.controller.registry.resolve(descriptor.repositoryId, branch);
    const entry = resolved.entry;
    if (entry.remoteId !== descriptor.remoteId) {
      throw new GitControllerError(
        "STORY_BASELINE_REMOTE_ID_MISMATCH",
        "Story accepted descriptor remote does not match the Controller registry",
      );
    }
    const registeredMirror = canonicalizeExistingDirectory(entry.mirrorPath, {
      label: "managed bare mirror",
    });
    const requestedMirror = canonicalizeExistingDirectory(descriptor.mirrorPath, {
      label: "accepted descriptor mirror",
    });
    if (pathKey(registeredMirror) !== pathKey(requestedMirror)) {
      throw new GitControllerError(
        "STORY_BASELINE_MIRROR_MISMATCH",
        "Story accepted descriptor does not reference the registered managed mirror",
      );
    }
    const repositoryPath = repositoryPathOf(repository);
    return {
      tabId: String(tabId || storyId),
      storyId,
      repository,
      repositoryPath,
      storyKey: storyKey(storyId, entry.repositoryId, repositoryPath),
      descriptor,
      entry,
      branch: resolved.branch,
      strategy: normalizedStrategy,
    };
  }

  async verifyAcceptedCurrent(context) {
    if (!fs.existsSync(context.entry.mirrorPath)) {
      throw new GitControllerError(
        "GIT_CONTROLLER_MIRROR_NOT_INITIALIZED",
        "Managed mirror has not been initialized",
      );
    }
    const accepted = await this.controller.mirror.readAccepted(
      context.entry,
      context.branch,
    );
    if (!accepted.acceptedSha || !accepted.state) {
      throw new GitControllerError(
        "GIT_CONTROLLER_ACCEPTED_SHA_MISSING",
        "No validated accepted SHA exists for the story source branch",
      );
    }
    if (
      accepted.acceptedSha !== context.descriptor.candidateSha
      || Number(accepted.state.generation) !== Number(context.descriptor.mirrorGeneration)
      || accepted.state.sourceRef !== context.descriptor.sourceRef
      || accepted.state.remoteId !== context.descriptor.remoteId
      || accepted.state.remoteFingerprint !== context.entry.remoteFingerprint
    ) {
      throw new GitControllerError(
        "GIT_CONTROLLER_PREVIEW_STALE",
        "Controller accepted SHA, source ref or mirror generation changed",
        {
          repositoryId: context.entry.repositoryId,
          branch: context.branch,
        },
      );
    }
    const candidateContent = await this.controller.base.candidateSubmodulePreflight(
      context.entry,
      context.descriptor.candidateSha,
    );
    if (candidateContent?.eligible !== true) {
      throw new GitControllerError(
        candidateContent?.blockerCode || "STORY_BASELINE_CANDIDATE_CONTENT_BLOCKED",
        "Accepted story baseline contains unverified submodule or executable attribute content",
        {
          repositoryId: context.entry.repositoryId,
          branch: context.branch,
          reason: candidateContent?.reason || "candidate_content_unverified",
        },
      );
    }
    return { ...accepted, candidateContent };
  }

  assertTabEntryCurrent(context, inspected) {
    const expectedBase = String(context.repository?.baseRevision || "").trim().toLowerCase();
    const expectedSourceRef = String(
      context.repository?.sourceRef || context.repository?.baseRef || "",
    ).trim();
    const expectedRemoteId = String(context.repository?.remoteId || "").trim();
    const rawGeneration = (
      context.repository?.mirrorGeneration
      ?? context.repository?.createdFromMirrorGeneration
    );
    const expectedGeneration = rawGeneration == null || rawGeneration === ""
      ? null
      : Number(rawGeneration);
    if (expectedBase && expectedBase !== inspected.baseRevision) {
      throw new GitControllerError(
        "STORY_BASELINE_ENTRY_STALE",
        "Persisted story entry baseline differs from repository metadata",
      );
    }
    if (expectedSourceRef && expectedSourceRef !== inspected.sourceRef) {
      throw new GitControllerError(
        "STORY_BASELINE_ENTRY_STALE",
        "Persisted story entry source ref differs from repository metadata",
      );
    }
    if (expectedRemoteId && expectedRemoteId !== inspected.remoteId) {
      throw new GitControllerError(
        "STORY_BASELINE_ENTRY_STALE",
        "Persisted story entry remote differs from repository metadata",
      );
    }
    if (
      expectedGeneration != null
      && (
        !Number.isSafeInteger(expectedGeneration)
        || expectedGeneration !== inspected.mirrorGeneration
      )
    ) {
      throw new GitControllerError(
        "STORY_BASELINE_ENTRY_STALE",
        "Persisted story entry mirror generation differs from repository metadata",
      );
    }
    const expectedBranch = String(context.repository?.branch || "").trim();
    if (!expectedBranch) {
      throw new GitControllerError(
        "STORY_BASELINE_ENTRY_BRANCH_REQUIRED",
        "Persisted independent story entry must bind the exact story branch",
      );
    }
    if (expectedBranch !== inspected.branch) {
      throw new GitControllerError(
        "STORY_BASELINE_ENTRY_STALE",
        "Persisted story entry branch differs from the live story branch",
      );
    }
  }

  async gitPath(context, name, commonDir) {
    const result = await this.runStory(context, [
      "rev-parse",
      "--path-format=absolute",
      "--git-path",
      name,
    ], {
      commandId: `story.baseline.git-path.${name.replace(/[^A-Za-z0-9]+/g, "-")}`,
    });
    const markerPath = path.resolve(result.stdout.trim());
    if (
      !pathInside(context.repositoryPath, markerPath)
      && !pathInside(commonDir, markerPath)
    ) {
      throw new GitControllerError(
        "STORY_BASELINE_GIT_PATH_DRIFT",
        "Story Git operation marker resolved outside the independent repository",
        { marker: name },
      );
    }
    return markerPath;
  }

  async assertSafeLocalGitConfig(context) {
    const result = await this.runStory(context, [
      "config",
      "--local",
      "--null",
      "--list",
    ], {
      commandId: "story.baseline.preflight-local-config",
    });
    const keys = String(result.stdout || "")
      .split("\0")
      .map((entry) => entry.split("\n", 1)[0].trim().toLowerCase())
      .filter(Boolean);
    const unsafeKeys = keys.filter((key) => (
      key === "core.hookspath"
      || key === "core.fsmonitor"
      || key === "core.worktree"
      || key === "core.sshcommand"
      || key === "core.gitproxy"
      || key === "core.editor"
      || key === "core.pager"
      || key === "core.alternaterefscommand"
      || key === "extensions.worktreeconfig"
      || key === "commit.gpgsign"
      || key === "gpg.program"
      || key === "merge.renormalize"
      || key === "merge.autostash"
      || key === "merge.tool"
      || key === "diff.external"
      || key === "interactive.difffilter"
      || key === "sequence.editor"
      || /^filter\..+\.(?:clean|smudge|process|required)$/.test(key)
      || /^merge\..+\.driver$/.test(key)
      || /^diff\..+\.(?:command|textconv)$/.test(key)
      || /^(?:diff|merge)tool\..+\.cmd$/.test(key)
      || /^branch\..+\.mergeoptions$/.test(key)
      || /^url\..+\.(?:insteadof|pushinsteadof)$/.test(key)
      || /^protocol\..+\.allow$/.test(key)
      || /^remote\..+\.vcs$/.test(key)
      || /^credential(?:\..+)?\.helper$/.test(key)
      || /^submodule\..+\.update$/.test(key)
      || /^pager\..+$/.test(key)
      || /^include(?:if\..+)?\.path$/.test(key)
    ));
    if (unsafeKeys.length) {
      throw new GitControllerError(
        "STORY_BASELINE_BLOCKED_EXECUTABLE_CONFIG",
        "Story repository contains local Git configuration that could execute code during Controller synchronization",
        {
          keys: [...new Set(unsafeKeys)].sort(),
        },
      );
    }
  }

  async classifyRelationship(context, head, currentBase, candidateSha) {
    if (currentBase !== candidateSha) {
      const baseExists = await this.runMirror(context, [
        "cat-file",
        "-e",
        `${currentBase}^{commit}`,
      ], {
        commandId: "story.baseline.base-exists-in-mirror",
        okExitCodes: [0, 1, 128],
      });
      if (baseExists.exitCode !== 0) {
        return {
          relationship: "BASELINE_OBJECT_MISSING",
          blockerCode: "STORY_BASELINE_BLOCKED_BASE_OBJECT_MISSING",
        };
      }
      const monotonic = await this.runMirror(context, [
        "merge-base",
        "--is-ancestor",
        currentBase,
        candidateSha,
      ], {
        commandId: "story.baseline.classify-base-forward",
        okExitCodes: [0, 1],
      });
      if (monotonic.exitCode !== 0) {
        return {
          relationship: "BASELINE_NON_FAST_FORWARD",
          blockerCode: "STORY_BASELINE_BLOCKED_NON_FAST_FORWARD_BASE",
        };
      }
    }
    if (head === candidateSha) {
      return { relationship: "UNCHANGED", blockerCode: null };
    }
    const headInMirror = await this.runMirror(context, [
      "cat-file",
      "-e",
      `${head}^{commit}`,
    ], {
      commandId: "story.baseline.head-exists-in-mirror",
      okExitCodes: [0, 1, 128],
    });
    if (headInMirror.exitCode === 0) {
      const forward = await this.runMirror(context, [
        "merge-base",
        "--is-ancestor",
        head,
        candidateSha,
      ], {
        commandId: "story.baseline.classify-head-forward",
        okExitCodes: [0, 1],
      });
      if (forward.exitCode === 0) {
        return { relationship: "FAST_FORWARD", blockerCode: null };
      }
    }
    const candidateInStory = await this.runStory(context, [
      "cat-file",
      "-e",
      `${candidateSha}^{commit}`,
    ], {
      commandId: "story.baseline.candidate-exists-in-story",
      okExitCodes: [0, 1, 128],
    });
    if (candidateInStory.exitCode === 0) {
      const included = await this.runStory(context, [
        "merge-base",
        "--is-ancestor",
        candidateSha,
        head,
      ], {
        commandId: "story.baseline.classify-candidate-included",
        okExitCodes: [0, 1],
      });
      if (included.exitCode === 0) {
        return { relationship: "CANDIDATE_ALREADY_INCLUDED", blockerCode: null };
      }
    }
    return {
      relationship: "STORY_DIVERGED",
      blockerCode: "STORY_BASELINE_BLOCKED_DIVERGED",
    };
  }

  async preflight(context) {
    const inspected = await inspectIndependentStoryRepository(context.repositoryPath, {
      storyId: context.storyId,
      repositoryId: context.entry.repositoryId,
      gitBinary: this.controller.registry.gitBinary,
      disabledHooksPath: this.disabledHooksPath,
    });
    if (!inspected || pathKey(inspected.repositoryPath) !== pathKey(context.repositoryPath)) {
      throw new GitControllerError(
        "STORY_BASELINE_REPOSITORY_BINDING_DRIFT",
        "Story repository no longer matches its persisted independent repository identity",
      );
    }
    this.assertTabEntryCurrent(context, inspected);
    if (
      inspected.repositoryMode !== INDEPENDENT_REPOSITORY_MODE
      || pathKey(inspected.gitCommonDir) !== pathKey(path.join(context.repositoryPath, ".git"))
    ) {
      throw new GitControllerError(
        "STORY_BASELINE_INDEPENDENT_REPOSITORY_REQUIRED",
        "Story repository shares Git administration data or is not independent",
      );
    }
    if (
      inspected.sourceRef !== context.descriptor.sourceRef
      || inspected.remoteId !== context.descriptor.remoteId
    ) {
      throw new GitControllerError(
        "STORY_BASELINE_SOURCE_CHANGED",
        "Story repository source ref or remote identity changed",
      );
    }
    if (context.descriptor.mirrorGeneration < inspected.mirrorGeneration) {
      throw new GitControllerError(
        "STORY_BASELINE_GENERATION_REWIND",
        "Story baseline cannot move to an older mirror generation",
      );
    }
    await this.assertSafeLocalGitConfig(context);
    const head = normalizeSha((await this.runStory(context, [
      "rev-parse",
      "--verify",
      "HEAD^{commit}",
    ], {
      commandId: "story.baseline.preflight-head",
    })).stdout.trim(), { label: "story HEAD" });
    const branchResult = await this.runStory(context, [
      "symbolic-ref",
      "--quiet",
      "--short",
      "HEAD",
    ], {
      commandId: "story.baseline.preflight-branch",
      okExitCodes: [0, 1],
    });
    const currentBranch = branchResult.exitCode === 0 ? branchResult.stdout.trim() : null;
    const status = statusClassification((await this.runStory(context, [
      "status",
      "--porcelain=v2",
      "--untracked-files=all",
    ], {
      commandId: "story.baseline.preflight-status",
    })).stdout);
    const inProgressNames = [
      "MERGE_HEAD",
      "rebase-merge",
      "rebase-apply",
      "CHERRY_PICK_HEAD",
      "REVERT_HEAD",
      "BISECT_LOG",
      "sequencer",
      "index.lock",
    ];
    const inProgress = [];
    for (const name of inProgressNames) {
      const markerPath = await this.gitPath(context, name, inspected.gitCommonDir);
      if (fs.existsSync(markerPath)) inProgress.push(name);
    }
    const relation = await this.classifyRelationship(
      context,
      head,
      inspected.baseRevision,
      context.descriptor.candidateSha,
    );
    let blockerCode = relation.blockerCode;
    if (
      relation.relationship === "STORY_DIVERGED"
      && context.strategy === STORY_BASELINE_MERGE_STRATEGY
    ) {
      blockerCode = null;
    }
    if (inProgress.length) blockerCode = "STORY_BASELINE_BLOCKED_OPERATION_IN_PROGRESS";
    else if (!currentBranch || inspected.detached) blockerCode = "STORY_BASELINE_BLOCKED_DETACHED";
    else if (!status.clean && status.trackedCount) blockerCode = "STORY_BASELINE_BLOCKED_DIRTY";
    else if (!status.clean && status.untrackedCount) blockerCode = "STORY_BASELINE_BLOCKED_UNTRACKED";
    return {
      eligible: !blockerCode,
      blockerCode,
      relationship: relation.relationship,
      head,
      currentBranch,
      currentBase: inspected.baseRevision,
      currentMirrorGeneration: inspected.mirrorGeneration,
      clean: status.clean,
      trackedCount: status.trackedCount,
      untrackedCount: status.untrackedCount,
      statusHash: status.statusHash,
      inProgress,
      inspected,
    };
  }

  async preview({
    tabId,
    repository,
    accepted,
    strategy = STORY_BASELINE_DEFAULT_STRATEGY,
    ttlMs,
  } = {}) {
    this.assertStoryRepositoryMutationBoundary();
    const context = await this.resolveRequest({
      tabId,
      repository,
      accepted,
      strategy,
    });
    const previewId = randomUUID();
    const lease = this.controller.leaseManager.acquire(context.entry, {
      operationId: previewId,
      kind: "story-baseline-preview",
    });
    try {
      lease.assertCurrent();
      await this.verifyAcceptedCurrent(context);
      const checks = await this.preflight(context);
      const now = Date.now();
      const stored = this.persistence.createGitControllerPreview({
        previewId,
        repositoryId: context.entry.repositoryId,
        kind: STORY_BASELINE_PREVIEW_KIND,
        branch: context.branch,
        expectedHead: checks.head,
        candidateSha: context.descriptor.candidateSha,
        mirrorGeneration: context.descriptor.mirrorGeneration,
        relationship: checks.relationship,
        eligible: checks.eligible,
        blockerCode: checks.blockerCode,
        remoteFingerprint: context.entry.remoteFingerprint,
        payload: {
          storyId: context.storyId,
          storyKey: context.storyKey,
          strategy: context.strategy,
          expectedBaseRevision: checks.currentBase,
          currentMirrorGeneration: checks.currentMirrorGeneration,
          sourceRef: context.descriptor.sourceRef,
          remoteId: context.descriptor.remoteId,
          currentBranch: checks.currentBranch,
          clean: checks.clean,
          trackedChangeCount: checks.trackedCount,
          untrackedChangeCount: checks.untrackedCount,
          statusHash: checks.statusHash,
          inProgress: checks.inProgress,
        },
        createdAt: now,
        expiresAt: now + Math.max(10_000, Number(ttlMs) || this.previewTtlMs),
      });
      return {
        previewId: stored.previewId,
        previewVersion: stored.previewVersion,
        repositoryId: context.entry.repositoryId,
        storyId: context.storyId,
        branch: context.branch,
        strategy: context.strategy,
        expectedHead: checks.head,
        expectedBaseRevision: checks.currentBase,
        candidateSha: context.descriptor.candidateSha,
        mirrorGeneration: context.descriptor.mirrorGeneration,
        relationship: checks.relationship,
        eligible: checks.eligible,
        blockerCode: checks.blockerCode,
        checks: {
          clean: checks.clean,
          trackedChangeCount: checks.trackedCount,
          untrackedChangeCount: checks.untrackedCount,
          statusHash: checks.statusHash,
          inProgress: checks.inProgress,
          currentBranch: checks.currentBranch,
        },
        expiresAt: stored.expiresAt,
      };
    } finally {
      lease.release();
    }
  }

  validateExecutionPreview({
    context,
    preview,
    previewVersion,
    expectedHead,
    candidateSha,
    mirrorGeneration,
  }) {
    if (
      !preview
      || preview.kind !== STORY_BASELINE_PREVIEW_KIND
      || preview.repositoryId !== context.entry.repositoryId
      || preview.branch !== context.branch
      || preview.payload?.storyKey !== context.storyKey
      || preview.payload?.storyId !== context.storyId
      || preview.payload?.strategy !== context.strategy
    ) {
      throw new GitControllerError(
        "GIT_CONTROLLER_PREVIEW_MISMATCH",
        "Story baseline preview does not match the requested story repository",
      );
    }
    if (preview.status !== "ACTIVE" || preview.expiresAt <= Date.now()) {
      throw new GitControllerError(
        "GIT_CONTROLLER_PREVIEW_EXPIRED",
        "Story baseline preview expired",
      );
    }
    if (Number(preview.previewVersion) !== Number(previewVersion)) {
      throw new GitControllerError(
        "GIT_CONTROLLER_PREVIEW_VERSION_MISMATCH",
        "Story baseline preview version changed",
      );
    }
    const expected = normalizeSha(expectedHead, { label: "expected story HEAD" });
    const candidate = normalizeSha(candidateSha, { label: "story baseline candidate SHA" });
    const generation = Number(mirrorGeneration);
    if (
      !Number.isSafeInteger(generation)
      || generation < 0
      || preview.expectedHead !== expected
      || preview.candidateSha !== candidate
      || preview.mirrorGeneration !== generation
      || context.descriptor.candidateSha !== candidate
      || context.descriptor.mirrorGeneration !== generation
      || preview.remoteFingerprint !== context.entry.remoteFingerprint
      || preview.payload?.sourceRef !== context.descriptor.sourceRef
      || preview.payload?.remoteId !== context.descriptor.remoteId
    ) {
      throw new GitControllerError(
        "GIT_CONTROLLER_PREVIEW_STALE",
        "Story baseline exact SHA or mirror generation no longer matches the preview",
      );
    }
    if (!preview.eligible) {
      throw new GitControllerError(
        preview.blockerCode || "GIT_CONTROLLER_PREVIEW_BLOCKED",
        "Story baseline preview is blocked by repository state",
      );
    }
    return { expected, candidate, generation };
  }

  async cleanupIncoming(context, incomingRef) {
    try {
      await this.runStoryMutation(context, ["update-ref", "-d", incomingRef], {
        commandId: "story.baseline.cleanup-incoming",
      });
      return null;
    } catch (error) {
      return String(error?.code || "STORY_BASELINE_INCOMING_CLEANUP_FAILED");
    }
  }

  async writeBaselineMetadata(context, {
    currentBase,
    candidate,
    generation,
  }) {
    if (currentBase !== candidate) {
      await this.runStoryMutation(context, [
        "update-ref",
        "refs/devbench/story-base",
        candidate,
        currentBase,
      ], {
        commandId: "story.baseline.update-base-ref",
      });
    }
    for (const [key, value] of [
      ["devbench.base-revision", candidate],
      ["devbench.accepted-tip-revision", candidate],
      ["devbench.source-ref", context.descriptor.sourceRef],
      ["devbench.mirror-generation", String(generation)],
    ]) {
      await this.runStory(context, [
        "config",
        "--local",
        "--replace-all",
        key,
        value,
      ], {
        commandId: `story.baseline.update-${key.replace(/[^A-Za-z0-9]+/g, "-")}`,
      });
    }
  }

  async execute({
    tabId,
    repository,
    accepted,
    strategy = STORY_BASELINE_DEFAULT_STRATEGY,
    previewId,
    previewVersion,
    expectedHead: expectedHeadValue,
    candidateSha: candidateValue,
    mirrorGeneration: mirrorGenerationValue,
    idempotencyKey: idempotencyValue,
    actor = null,
    registryMetadataPrior = null,
  } = {}) {
    this.assertStoryRepositoryMutationBoundary();
    const idempotencyKey = assertIdempotencyKey(idempotencyValue);
    const context = await this.resolveRequest({
      tabId,
      repository,
      accepted,
      strategy,
    });
    const expectedInput = normalizeSha(expectedHeadValue, {
      label: "expected story HEAD",
    });
    const candidateInput = normalizeSha(candidateValue, {
      label: "story baseline candidate SHA",
    });
    const recoveryPrior = registryMetadataPrior == null
      ? null
      : validateStoryBaselineRegistryRecoveryPrior(registryMetadataPrior);
    if (
      recoveryPrior
      && (
        recoveryPrior.tabId !== context.storyId
        || recoveryPrior.repositoryId !== context.entry.repositoryId
        || STORY_BASELINE_METADATA_KEYS.some(
          (key) => recoveryPrior.metadata[key] !== context.repository[key],
        )
      )
    ) {
      throw new GitControllerError(
        "STORY_BASELINE_REGISTRY_RECOVERY_PRIOR_MISMATCH",
        "Story baseline recovery prior state does not match the exact resolved registry metadata",
        {
          recoveryRequired: true,
          tabId: context.storyId,
          repositoryId: context.entry.repositoryId,
          expectedRegistryGeneration: recoveryPrior.registryGeneration,
        },
      );
    }
    const existing = this.persistence.getGitControllerOperationByIdempotency(
      context.entry.repositoryId,
      STORY_BASELINE_OPERATION_TYPE,
      idempotencyKey,
    );
    if (existing) {
      return replayOrThrow(existing, {
        previewId,
        expectedHead: expectedInput,
        candidateSha: candidateInput,
      });
    }
    const preview = this.persistence.getGitControllerPreview(previewId);
    const { expected, candidate, generation } = this.validateExecutionPreview({
      context,
      preview,
      previewVersion,
      expectedHead: expectedInput,
      candidateSha: candidateInput,
      mirrorGeneration: mirrorGenerationValue,
    });
    const begun = this.controller.journal.begin({
      repositoryId: context.entry.repositoryId,
      operationType: STORY_BASELINE_OPERATION_TYPE,
      commandId: STORY_BASELINE_COMMAND_ID,
      idempotencyKey,
      previewId,
      branch: context.branch,
      expectedHead: expected,
      candidateSha: candidate,
    });
    if (!begun.created) {
      return replayOrThrow(begun.operation, {
        previewId,
        expectedHead: expected,
        candidateSha: candidate,
      });
    }
    const operation = begun.operation;
    const consumed = this.persistence.consumeGitControllerPreview(
      previewId,
      operation.operationId,
    );
    if (!consumed?.ok) {
      const error = new GitControllerError(
        "GIT_CONTROLLER_PREVIEW_CONSUMED",
        "Story baseline preview was already consumed",
      );
      this.controller.journal.fail(operation, error);
      throw error;
    }

    const startedAt = Date.now();
    let lease = null;
    let incomingRef = null;
    let applyStarted = false;
    let metadataStarted = false;
    let relationship = preview.relationship;
    let cleanupWarning = null;
    let entryPatch = null;
    let registryRecoveryMarker = null;
    let result = null;
    try {
      lease = this.controller.leaseManager.acquire(context.entry, {
        operationId: operation.operationId,
        kind: "story-baseline-sync",
      });
      lease.assertCurrent();
      await this.controller.registry.verify(context.entry.repositoryId);
      await this.verifyAcceptedCurrent(context);
      let checks = await this.preflight(context);
      if (!checks.eligible) {
        throw new GitControllerError(
          checks.blockerCode || "STORY_BASELINE_PREFLIGHT_CHANGED",
          "Story repository no longer satisfies baseline synchronization preflight",
          { relationship: checks.relationship },
        );
      }
      if (
        checks.head !== expected
        || checks.currentBase !== preview.payload?.expectedBaseRevision
        || checks.statusHash !== preview.payload?.statusHash
      ) {
        throw new GitControllerError(
          "GIT_CONTROLLER_EXPECTED_HEAD_CHANGED",
          "Story repository HEAD, baseline or clean status changed after preview",
          {
            expectedHead: expected,
            actualHead: checks.head,
          },
        );
      }
      relationship = checks.relationship;
      incomingRef = controllerIncomingRef(
        `story-baseline:${operation.operationId}`,
        context.branch,
      );
      const acceptedRef = this.controller.mirror.acceptedRef(
        context.entry,
        context.branch,
      );
      lease.assertCurrent();
      await this.assertSafeLocalGitConfig(context);
      await this.runStoryMutation(context, [
        "fetch",
        "--atomic",
        "--no-tags",
        "--no-write-fetch-head",
        context.entry.mirrorPath,
        `${acceptedRef}:${incomingRef}`,
      ], {
        commandId: "story.baseline.fetch-accepted",
        timeoutMs: 120_000,
      });
      const fetched = normalizeSha((await this.runStory(context, [
        "rev-parse",
        "--verify",
        `${incomingRef}^{commit}`,
      ], {
        commandId: "story.baseline.verify-fetched-ref",
      })).stdout.trim(), { label: "story fetched candidate SHA" });
      if (fetched !== candidate) {
        throw new GitControllerError(
          "GIT_CONTROLLER_FETCHED_SHA_MISMATCH",
          "Story repository fetched ref differs from the previewed accepted SHA",
          { candidateSha: candidate, fetchedSha: fetched },
        );
      }
      if (recoveryPrior) {
        this.controller.journal.append(operation, "BASE_OBJECTS_FETCHED", {
          storyId: context.storyId,
          candidateSha: candidate,
          incomingRef,
        }, lease.fencingToken);
      }
      await this.verifyAcceptedCurrent(context);
      checks = await this.preflight(context);
      if (
        !checks.eligible
        || checks.head !== expected
        || checks.currentBase !== preview.payload?.expectedBaseRevision
        || checks.statusHash !== preview.payload?.statusHash
      ) {
        throw new GitControllerError(
          checks.blockerCode || "STORY_BASELINE_PREFLIGHT_CHANGED",
          "Story repository changed while accepted objects were fetched",
          {
            expectedHead: expected,
            actualHead: checks.head,
            relationship: checks.relationship,
          },
        );
      }
      relationship = checks.relationship;
      if (
        !["UNCHANGED", "FAST_FORWARD", "CANDIDATE_ALREADY_INCLUDED"].includes(relationship)
        && !(
          relationship === "STORY_DIVERGED"
          && context.strategy === STORY_BASELINE_MERGE_STRATEGY
        )
      ) {
        throw new GitControllerError(
          "STORY_BASELINE_BLOCKED_DIVERGED",
          "Story repository cannot safely adopt the accepted baseline with the selected strategy",
          { relationship },
        );
      }
      if (recoveryPrior) {
        this.controller.journal.append(operation, "BASE_APPLYING", {
          storyId: context.storyId,
          strategy: context.strategy,
          relationship,
          expectedHead: expected,
          candidateSha: candidate,
        }, lease.fencingToken);
      }
      if (relationship === "FAST_FORWARD" && expected !== candidate) {
        lease.assertCurrent();
        await this.controller.registry.verify(context.entry.repositoryId);
        await this.assertSafeLocalGitConfig(context);
        applyStarted = true;
        await this.runStoryMutation(context, [
          "merge",
          "--ff-only",
          candidate,
        ], {
          commandId: "story.baseline.merge-fast-forward",
          timeoutMs: 120_000,
        });
      } else if (
        relationship === "STORY_DIVERGED"
        && context.strategy === STORY_BASELINE_MERGE_STRATEGY
      ) {
        lease.assertCurrent();
        await this.controller.registry.verify(context.entry.repositoryId);
        await this.assertSafeLocalGitConfig(context);
        applyStarted = true;
        await this.runStoryMutation(context, [
          "merge",
          "--no-edit",
          candidate,
        ], {
          commandId: "story.baseline.merge-explicit",
          timeoutMs: 120_000,
        });
      }
      lease.assertCurrent();
      const applied = await inspectIndependentStoryRepository(context.repositoryPath, {
        storyId: context.storyId,
        repositoryId: context.entry.repositoryId,
        gitBinary: this.controller.registry.gitBinary,
        disabledHooksPath: this.disabledHooksPath,
      });
      const appliedStatus = statusClassification((await this.runStory(context, [
        "status",
        "--porcelain=v2",
        "--untracked-files=all",
      ], {
        commandId: "story.baseline.applied-status",
      })).stdout);
      const appliedCandidateIncluded = applied
        ? await this.runStory(context, [
          "merge-base",
          "--is-ancestor",
          candidate,
          applied.headRevision,
        ], {
          commandId: "story.baseline.applied-candidate-ancestor",
          okExitCodes: [0, 1],
        })
        : { exitCode: 1 };
      const expectedFinalHead = relationship === "FAST_FORWARD" ? candidate : expected;
      if (
        !applied
        || (
          relationship !== "STORY_DIVERGED"
          && applied.headRevision !== expectedFinalHead
        )
        || appliedCandidateIncluded.exitCode !== 0
        || !appliedStatus.clean
      ) {
        throw new GitControllerError(
          "STORY_BASELINE_APPLY_VERIFY_FAILED",
          "Story baseline mutation did not reach the exact recoverable Git state",
          {
            recoveryRequired: true,
            expectedHead: expectedFinalHead,
            actualHead: applied?.headRevision || null,
            candidateSha: candidate,
            clean: appliedStatus.clean,
          },
        );
      }
      entryPatch = {
        baseRevision: candidate,
        sourceRef: context.descriptor.sourceRef,
        baseRef: context.descriptor.sourceRef,
        resolvedRef: context.descriptor.sourceRef,
        remoteId: context.descriptor.remoteId,
        mirrorGeneration: generation,
        headRevision: applied.headRevision,
        branch: applied.branch,
        detached: applied.detached,
      };
      registryRecoveryMarker = recoveryPrior
        ? createStoryBaselineRegistryRecoveryMarker({
          prior: recoveryPrior,
          patch: Object.fromEntries(
            STORY_BASELINE_METADATA_KEYS.map((key) => [key, entryPatch[key]]),
          ),
          operationId: operation.operationId,
          idempotencyKey,
        })
        : null;
      result = {
        ok: true,
        operationId: operation.operationId,
        replayed: false,
        resultCode: "PASS",
        repositoryId: context.entry.repositoryId,
        storyId: context.storyId,
        branch: context.branch,
        strategy: context.strategy,
        beforeHead: expected,
        head: applied.headRevision,
        previousBaseRevision: checks.currentBase,
        baseRevision: candidate,
        candidateSha: candidate,
        mirrorGeneration: generation,
        relationship,
        cleanupWarning: null,
        entryPatch,
        ...(registryRecoveryMarker
          ? {
            registryRecoveryMarker,
            registryRecoveryState: "PENDING",
          }
          : {}),
      };
      if (registryRecoveryMarker) {
        this.controller.journal.stageRecovery(operation, result, {
          phase: "BASE_APPLIED",
          fencingToken: lease.fencingToken,
          data: {
            storyId: context.storyId,
            candidateSha: candidate,
            headRevision: applied.headRevision,
            registryRecoveryMarker,
          },
        });
      }
      metadataStarted = true;
      await this.writeBaselineMetadata(context, {
        currentBase: checks.currentBase,
        candidate,
        generation,
      });
      cleanupWarning = await this.cleanupIncoming(context, incomingRef);
      incomingRef = null;
      lease.assertCurrent();
      const verified = await inspectIndependentStoryRepository(context.repositoryPath, {
        storyId: context.storyId,
        repositoryId: context.entry.repositoryId,
        gitBinary: this.controller.registry.gitBinary,
        disabledHooksPath: this.disabledHooksPath,
      });
      const verifiedStatus = statusClassification((await this.runStory(context, [
        "status",
        "--porcelain=v2",
        "--untracked-files=all",
      ], {
        commandId: "story.baseline.post-status",
      })).stdout);
      const candidateIncluded = verified
        ? await this.runStory(context, [
          "merge-base",
          "--is-ancestor",
          candidate,
          verified.headRevision,
        ], {
          commandId: "story.baseline.post-candidate-ancestor",
          okExitCodes: [0, 1],
        })
        : { exitCode: 1 };
      if (
        !verified
        || (
          relationship !== "STORY_DIVERGED"
          && verified.headRevision !== expectedFinalHead
        )
        || candidateIncluded.exitCode !== 0
        || verified.baseRevision !== candidate
        || verified.sourceRef !== context.descriptor.sourceRef
        || verified.mirrorGeneration !== generation
        || !verifiedStatus.clean
      ) {
        throw new GitControllerError(
          "STORY_BASELINE_POST_VERIFY_FAILED",
          "Story repository failed exact-SHA baseline post verification",
          {
            expectedHead: expectedFinalHead,
            actualHead: verified?.headRevision || null,
            expectedBaseRevision: candidate,
            actualBaseRevision: verified?.baseRevision || null,
            clean: verifiedStatus.clean,
          },
        );
      }
      result = {
        ...result,
        head: verified.headRevision,
        cleanupWarning,
      };
      this.controller.audit.write({
        operation,
        commandId: STORY_BASELINE_COMMAND_ID,
        action: "story.baseline.apply",
        branch: context.branch,
        beforeSha: expected,
        candidateSha: candidate,
        result: "PASS",
        durationMs: Date.now() - startedAt,
        fencingToken: lease.fencingToken,
        actor,
        details: {
          storyId: context.storyId,
          previousBaseRevision: checks.currentBase,
          mirrorGeneration: generation,
          relationship,
          cleanupWarning,
        },
      });
      this.controller.journal.succeed(operation, result, lease.fencingToken);
      return result;
    } catch (rawError) {
      let error = asControllerError(rawError);
      let currentHead = null;
      let currentBase = null;
      let dirty = null;
      let mergeConflict = false;
      let conflictCount = 0;
      try {
        currentHead = normalizeSha((await this.runStory(context, [
          "rev-parse",
          "--verify",
          "HEAD^{commit}",
        ], {
          commandId: "story.baseline.failure-head",
        })).stdout.trim(), { label: "story failure HEAD" });
      } catch {}
      try {
        currentBase = normalizeSha((await this.runStory(context, [
          "rev-parse",
          "--verify",
          "refs/devbench/story-base^{commit}",
        ], {
          commandId: "story.baseline.failure-base",
        })).stdout.trim(), { label: "story failure baseline" });
      } catch {}
      try {
        dirty = !statusClassification((await this.runStory(context, [
          "status",
          "--porcelain=v2",
          "--untracked-files=all",
        ], {
          commandId: "story.baseline.failure-status",
        })).stdout).clean;
      } catch {}
      if (
        applyStarted
        && relationship === "STORY_DIVERGED"
        && context.strategy === STORY_BASELINE_MERGE_STRATEGY
      ) {
        try {
          const unmerged = (await this.runStory(context, [
            "diff",
            "--name-only",
            "--diff-filter=U",
            "-z",
          ], {
            commandId: "story.baseline.failure-conflicts",
          })).stdout.split("\0").filter(Boolean);
          conflictCount = unmerged.length;
          mergeConflict = conflictCount > 0;
        } catch {}
        if (mergeConflict) {
          error = new GitControllerError(
            "STORY_BASELINE_MERGE_CONFLICT",
            "Explicit story baseline merge has conflicts in the independent story repository",
            {
              conflictCount,
              originalError: error.code,
            },
            { cause: rawError },
          );
        }
      }
      const recoveryRequired = (
        currentHead != null && currentHead !== expected
      ) || (
        currentBase != null && currentBase !== preview.payload?.expectedBaseRevision
      ) || (
        (applyStarted || metadataStarted) && dirty === true
      ) || metadataStarted
        || error.code === "STORY_BASELINE_POST_VERIFY_FAILED";
      try {
        this.controller.audit.write({
          operation,
          commandId: STORY_BASELINE_COMMAND_ID,
          action: "story.baseline.apply",
          branch: context.branch,
          beforeSha: expected,
          candidateSha: candidate,
          result: recoveryRequired ? "RECOVERY_REQUIRED" : "FAIL",
          reason: error.code,
          durationMs: Date.now() - startedAt,
          fencingToken: lease?.fencingToken || null,
          actor,
          details: {
            storyId: context.storyId,
            relationship,
            currentHead,
            currentBase,
            dirty,
            mergeConflict,
            conflictCount,
          },
        });
      } catch (auditError) {
        const auditFailure = asControllerError(
          auditError,
          "GIT_CONTROLLER_AUDIT_WRITE_FAILED",
        );
        this.controller.journal.fail(operation, auditFailure, {
          fencingToken: lease?.fencingToken || null,
          recoveryRequired: true,
          data: {
            precedingError: error.code,
            currentHead,
            currentBase,
            dirty,
          },
        });
        throw auditFailure;
      }
      this.controller.journal.fail(operation, error, {
        fencingToken: lease?.fencingToken || null,
        recoveryRequired,
        data: {
          currentHead,
          currentBase,
          dirty,
          mergeConflict,
          conflictCount,
        },
      });
      throw error;
    } finally {
      if (incomingRef && lease && !lease.lost) {
        await this.cleanupIncoming(context, incomingRef);
      }
      lease?.release();
    }
  }
}

export function createStoryBaselineService(options = {}) {
  return new StoryBaselineService(options);
}

export {
  STORY_BASELINE_COMMAND_ID,
  STORY_BASELINE_DEFAULT_STRATEGY,
  STORY_BASELINE_FF_ONLY_STRATEGY,
  STORY_BASELINE_MERGE_STRATEGY,
  STORY_BASELINE_OPERATION_TYPE,
  STORY_BASELINE_PREVIEW_KIND,
  STORY_BASELINE_STRATEGY,
  normalizeStrategy as normalizeStoryBaselineStrategy,
};
