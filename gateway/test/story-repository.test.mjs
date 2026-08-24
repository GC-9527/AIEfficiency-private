import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";

const TEST_RUNTIME = fs.mkdtempSync(path.join(os.tmpdir(), "devbench-story-repository-suite-"));
const GIT_BINARY = fs.realpathSync(
  process.platform === "win32"
    ? execFileSync("where.exe", ["git"], { encoding: "utf8" }).split(/\r?\n/)[0].trim()
    : execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim(),
);
process.env.GATEWAY_DB_PATH = path.join(TEST_RUNTIME, "gateway.db");
process.on("exit", () => {
  try { fs.rmSync(TEST_RUNTIME, { recursive: true, force: true }); } catch {}
});

const {
  cleanupStoryWorktrees,
  INDEPENDENT_REPOSITORY_MODE,
  inspectStoryWorktreeCleanup,
  LEGACY_LINKED_WORKTREE_MODE,
  provisionStoryWorktrees,
} = await import("../services/devbench/worktree-manager.js");
const {
  createStoryRepositoryController,
  __test: storyRepositoryTest,
} = await import("../services/devbench/story-repository-controller.js");
const {
  reconcileManagedWorkerDeploymentProbeConfig,
} = await import("../services/worker-isolation-deployment.js");
const {
  CONTROLLER_PHASES,
} = await import("../services/devbench/git-controller/journal.js");
const {
  independentStoryRepositoryPath,
  __test: independentStoryRepositoryTest,
} = await import("../services/devbench/git-controller/story-repository.js");
const {
  controllerAcceptedRef,
} = await import("../services/devbench/git-controller/internal-refs.js");

test("independent story Git runner forces Windows longpaths without changing non-Windows argv", () => {
  const windowsArgs = independentStoryRepositoryTest.storyGitExecutionArgs(
    ["status", "--porcelain"],
    path.join(TEST_RUNTIME, "disabled-hooks"),
    "win32",
  );
  const longPathsIndex = windowsArgs.indexOf("core.longpaths=true");
  assert.ok(longPathsIndex > 0);
  assert.equal(windowsArgs[longPathsIndex - 1], "-c");
  assert.equal(
    windowsArgs.filter((arg) => arg === "core.longpaths=true").length,
    1,
  );
  assert.equal(
    independentStoryRepositoryTest.storyGitExecutionArgs(
      ["status", "--porcelain"],
      path.join(TEST_RUNTIME, "disabled-hooks"),
      "linux",
    ).includes("core.longpaths=true"),
    false,
  );
  for (const disabledMaintenanceSetting of [
    "gc.auto=0",
    "gc.autoDetach=false",
    "maintenance.auto=false",
    "maintenance.autoDetach=false",
  ]) {
    assert.ok(windowsArgs.includes(disabledMaintenanceSetting));
  }
});

test("synchronous story Git inspection guard fails before process creation", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "devbench-story-git-spawn-guard-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const blockedTarget = path.join(root, "must-not-start.git");
  const sentinel = Object.assign(new Error("guardian channel closed"), {
    code: "GIT_CONTROLLER_PROCESS_TREE_ATTESTATION_FAILED",
  });
  let guardCalls = 0;
  assert.throws(
    () => storyRepositoryTest.storyGit(
      GIT_BINARY,
      root,
      root,
      ["init", "--bare", blockedTarget],
      () => {
        guardCalls += 1;
        throw sentinel;
      },
    ),
    (error) => error === sentinel,
  );
  assert.equal(guardCalls, 1);
  assert.equal(fs.existsSync(blockedTarget), false);
});

test("Windows story ACL policy allows only Controller, current Worker, read-only Gateway and managers", () => {
  const controllerSid = "S-1-5-21-100-200-300-400";
  const workerSid = "S-1-5-21-100-200-300-500";
  const gatewaySid = "S-1-5-21-100-200-300-600";
  const managerSid = "S-1-5-21-100-200-300-700";
  const evidence = {
    owner: controllerSid,
    sddl: [
      "O:", controllerSid,
      "G:SYD:",
      `(D;;0X000C0000;;;${workerSid})`,
      `(A;;FA;;;${controllerSid})`,
      `(A;;0X1301BF;;;${workerSid})`,
      `(A;;GRGX;;;${gatewaySid})`,
      `(A;;0X1301BF;;;${managerSid})`,
      "(A;;FA;;;SY)",
      "(A;;FA;;;BA)",
    ].join(""),
  };
  assert.doesNotThrow(() => storyRepositoryTest.assertWindowsStoryAcl({
    evidence,
    controllerSid,
    workerSid,
    gatewaySids: [gatewaySid],
    managerSids: [managerSid],
    workerWritable: true,
  }));
  assert.throws(() => storyRepositoryTest.assertWindowsStoryAcl({
    evidence: {
      ...evidence,
      sddl: evidence.sddl.replace(`(D;;0X000C0000;;;${workerSid})`, ""),
    },
    controllerSid,
    workerSid,
    gatewaySids: [gatewaySid],
    managerSids: [managerSid],
    workerWritable: true,
  }), { code: "STORY_REPOSITORY_WORKER_ACL_UNVERIFIED" });
  assert.throws(() => storyRepositoryTest.assertWindowsStoryAcl({
    evidence: { ...evidence, owner: "S-1-5-18" },
    controllerSid,
    workerSid,
    gatewaySids: [gatewaySid],
    managerSids: [managerSid],
    workerWritable: true,
  }), { code: "STORY_REPOSITORY_WORKER_ACL_OWNER" });
  assert.throws(() => storyRepositoryTest.assertWindowsStoryAcl({
    evidence: {
      ...evidence,
      sddl: evidence.sddl.replace(
        `(A;;GRGX;;;${gatewaySid})`,
        `(A;;GW;;;${gatewaySid})`,
      ),
    },
    controllerSid,
    workerSid,
    gatewaySids: [gatewaySid],
    managerSids: [managerSid],
    workerWritable: true,
  }), { code: "STORY_REPOSITORY_WORKER_ACL_UNVERIFIED" });
  assert.throws(() => storyRepositoryTest.assertWindowsStoryAcl({
    evidence: {
      ...evidence,
      sddl: `${evidence.sddl}(A;;GRGX;;;S-1-5-21-100-200-300-501)`,
    },
    controllerSid,
    workerSid,
    gatewaySids: [gatewaySid],
    managerSids: [managerSid],
    workerWritable: true,
  }), { code: "STORY_REPOSITORY_WORKER_ACL_UNVERIFIED" });
  assert.throws(() => storyRepositoryTest.assertWindowsStoryAcl({
    evidence: {
      ...evidence,
      sddl: `${evidence.sddl}(A;;GRGX;;;WD)`,
    },
    controllerSid,
    workerSid,
    gatewaySids: [gatewaySid],
    managerSids: [managerSid],
    workerWritable: true,
  }), { code: "STORY_REPOSITORY_WORKER_ACL_UNVERIFIED" });

  const parentEvidence = {
    owner: controllerSid,
    sddl: [
      "O:", controllerSid,
      "G:SYD:",
      `(D;OICI;0X000C0000;;;${workerSid})`,
      `(A;OICI;FA;;;${controllerSid})`,
      `(A;OICI;GRGX;;;${workerSid})`,
      `(A;OICI;GRGX;;;${gatewaySid})`,
      `(A;OICI;0X1200A9;;;${managerSid})`,
      "(A;OICI;FA;;;SY)",
      "(A;OICI;FA;;;BA)",
    ].join(""),
  };
  const parentPolicy = {
    controllerSid,
    workerSid,
    gatewaySids: [gatewaySid],
    managerSids: [managerSid],
    workerWritable: false,
  };
  assert.doesNotThrow(() => storyRepositoryTest.assertWindowsStoryAcl({
    evidence: parentEvidence,
    ...parentPolicy,
  }));
  for (const unsafeSddl of [
    parentEvidence.sddl.replace(
      `(A;OICI;GRGX;;;${workerSid})`,
      `(A;OICI;FA;;;${workerSid})`,
    ),
    `${parentEvidence.sddl}(A;OICI;FA;;;${workerSid})`,
    parentEvidence.sddl.replace(
      `(A;OICI;0X1200A9;;;${managerSid})`,
      `(A;OICI;0X1301BF;;;${managerSid})`,
    ),
  ]) {
    assert.throws(() => storyRepositoryTest.assertWindowsStoryAcl({
      evidence: { ...parentEvidence, sddl: unsafeSddl },
      ...parentPolicy,
    }), { code: "STORY_REPOSITORY_WORKER_ACL_UNVERIFIED" });
  }
});

function git(cwd, ...args) {
  return execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    windowsHide: true,
  }).trim();
}

function gitBare(repositoryPath, ...args) {
  return execFileSync("git", ["--git-dir", repositoryPath, ...args], {
    encoding: "utf8",
    windowsHide: true,
  }).trim();
}

function resolvedCommonDir(repositoryPath, { bare = false } = {}) {
  const raw = bare
    ? gitBare(repositoryPath, "rev-parse", "--git-common-dir")
    : git(repositoryPath, "rev-parse", "--git-common-dir");
  return path.resolve(repositoryPath, raw);
}

function repositoryFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "devbench-story-repository-"));
  const source = path.join(root, "base");
  const mirror = path.join(root, "managed-mirror.git");
  const worktreeRoot = path.join(root, "story-repositories");
  fs.mkdirSync(source);
  git(source, "init");
  git(source, "config", "user.name", "Devbench Test");
  git(source, "config", "user.email", "devbench@example.test");
  fs.writeFileSync(path.join(source, "tracked.txt"), "accepted-a\n");
  git(source, "add", "tracked.txt");
  git(source, "commit", "-m", "accepted A");
  const acceptedA = git(source, "rev-parse", "HEAD");
  const branch = git(source, "branch", "--show-current");
  const sourceRef = `refs/heads/${branch}`;
  execFileSync("git", ["clone", "--bare", source, mirror], {
    encoding: "utf8",
    windowsHide: true,
  });
  gitBare(mirror, "update-ref", controllerAcceptedRef("origin", branch), acceptedA);

  fs.writeFileSync(path.join(source, "tracked.txt"), "base advanced to B\n");
  git(source, "add", "tracked.txt");
  git(source, "commit", "-m", "base B");
  const baseB = git(source, "rev-parse", "HEAD");
  assert.notEqual(baseB, acceptedA);

  return {
    root,
    source,
    mirror,
    worktreeRoot,
    acceptedA,
    baseB,
    sourceRef,
  };
}

function deepenStoryRepositoryFixture(fixture) {
  const deepRelativePath = path.join(
    ...Array.from(
      { length: 7 },
      (_, index) => `tracked-level-${index}-${"x".repeat(18)}`,
    ),
    "deep-tracked-file.txt",
  );
  const deepSourcePath = path.join(fixture.source, deepRelativePath);
  fs.mkdirSync(path.dirname(deepSourcePath), { recursive: true });
  fs.writeFileSync(deepSourcePath, "deep tracked content\n");
  git(fixture.source, "config", "core.longpaths", "true");
  git(fixture.source, "-c", "core.longpaths=true", "add", deepRelativePath);
  git(fixture.source, "-c", "core.longpaths=true", "commit", "-m", "deep tracked path");
  const acceptedDeep = git(fixture.source, "rev-parse", "HEAD");
  gitBare(
    fixture.mirror,
    "-c",
    "core.longpaths=true",
    "fetch",
    fixture.source,
    acceptedDeep,
  );
  gitBare(
    fixture.mirror,
    "update-ref",
    controllerAcceptedRef(
      "origin",
      fixture.sourceRef.slice("refs/heads/".length),
    ),
    acceptedDeep,
  );

  let worktreeRoot = path.join(fixture.root, "deep-story-repositories");
  let segmentIndex = 0;
  while (worktreeRoot.length < 115) {
    worktreeRoot = path.join(
      worktreeRoot,
      `root-level-${segmentIndex}-${"r".repeat(18)}`,
    );
    segmentIndex += 1;
  }
  fs.mkdirSync(worktreeRoot, { recursive: true });

  return {
    ...fixture,
    acceptedA: acceptedDeep,
    deepRelativePath,
    worktreeRoot,
  };
}

function acceptedRepository(
  fixture,
  candidateSha,
  mirrorGeneration = 1,
  acceptedTipSha = candidateSha,
) {
  return {
    role: "primary",
    name: "App",
    path: fixture.source,
    accepted: {
      repositoryId: "repository-main",
      mirrorPath: fixture.mirror,
      candidateSha,
      acceptedTipSha,
      sourceRef: fixture.sourceRef,
      mirrorGeneration,
    },
  };
}

function storyControllerFixture(fixture, options = {}) {
  const entries = new Map(["repository-main", "repository-second"].map((repositoryId) => [
    repositoryId,
    {
      repositoryId,
      remoteId: "origin",
      basePath: fixture.source,
      baseGitCommonPath: path.join(fixture.source, ".git"),
      mirrorPath: fixture.mirror,
      allowedBranches: [fixture.sourceRef.slice("refs/heads/".length)],
      lockPath: path.join(fixture.root, `${repositoryId}.lock`),
    },
  ]));
  const state = options.state || {};
  const operations = state.operations ||= new Map();
  const previews = state.previews ||= new Map();
  const journalRows = state.journalRows ||= [];
  const audits = state.audits ||= [];
  const storyRetentions = state.storyRetentions ||= new Map();
  const persistence = {
    getGitControllerOperation(operationId) {
      return [...operations.values()].find(
        (operation) => operation.operationId === operationId,
      ) || null;
    },
    getGitControllerOperationByIdempotency(repositoryId, operationType, idempotencyKey) {
      return operations.get(`${repositoryId}\0${operationType}\0${idempotencyKey}`) || null;
    },
    createGitControllerPreview(row) {
      const preview = {
        ...row,
        previewVersion: 1,
        status: "ACTIVE",
      };
      previews.set(preview.previewId, preview);
      return preview;
    },
    getGitControllerPreview(previewId) {
      return previews.get(previewId) || null;
    },
    consumeGitControllerPreview(previewId, operationId) {
      const preview = previews.get(previewId);
      if (!preview || preview.status !== "ACTIVE") {
        return { ok: false, reason: "already_consumed", preview };
      }
      preview.status = "CONSUMED";
      preview.operationId = operationId;
      return { ok: true, preview };
    },
    listGitControllerRecoverableOperations(request = 100) {
      const options = typeof request === "number" ? { limit: request } : request;
      return [...operations.values()]
        .filter((operation) => ["RUNNING", "RECOVERY_REQUIRED"].includes(operation.status))
        .filter((operation) => (
          !options.operationType || operation.operationType === options.operationType
        ))
        .filter((operation) => (
          !options.repositoryId || operation.repositoryId === options.repositoryId
        ))
        .filter((operation) => (
          !options.afterOperationId
          || operation.updatedAt > options.afterUpdatedAt
          || (
            operation.updatedAt === options.afterUpdatedAt
            && operation.operationId > options.afterOperationId
          )
        ))
        .sort((left, right) => (
          left.updatedAt - right.updatedAt
          || left.operationId.localeCompare(right.operationId)
        ))
        .slice(0, Number(options.limit) || 100);
    },
    listGitControllerJournal(operationId) {
      return journalRows.filter((row) => row.operationId === operationId);
    },
    listGitControllerAudit({ operationId } = {}) {
      return audits.filter((row) => !operationId || row.operationId === operationId);
    },
  };
  const controller = {
    registry: {
      entries,
      gitBinary: GIT_BINARY,
      get(repositoryId) {
        const entry = entries.get(repositoryId);
        if (!entry) throw Object.assign(new Error("missing"), { code: "MISSING" });
        return entry;
      },
      async resolve(repositoryId, branch) {
        return { entry: this.get(repositoryId), branch };
      },
      async verify() {},
    },
    mirror: {
      setStoryBaseRetentionProvider(provider) {
        state.storyRetentionProvider = provider;
      },
      async ensureStoryBaseRetention(entry, row) {
        const binding = `b-${createHash("sha256")
          .update(`${row.storyId}\0${entry.repositoryId}`)
          .digest("base64url")
          .slice(0, 20)}`;
        const shaToken = `s-${createHash("sha256")
          .update(String(row.baseRevision))
          .digest("base64url")
          .slice(0, 16)}`;
        const retention = {
          storyId: String(row.storyId),
          repositoryId: entry.repositoryId,
          baseRevision: String(row.baseRevision),
          currentRef: `refs/devbench/story-base/${binding}/c`,
          immutableRef:
            `refs/devbench/story-base/${binding}/${shaToken}`,
          previousSha: storyRetentions.get(
            `${row.storyId}\0${entry.repositoryId}`,
          )?.baseRevision || null,
        };
        storyRetentions.set(
          `${retention.storyId}\0${retention.repositoryId}`,
          retention,
        );
        gitBare(
          fixture.mirror,
          "update-ref",
          retention.immutableRef,
          retention.baseRevision,
        );
        gitBare(
          fixture.mirror,
          "update-ref",
          retention.currentRef,
          retention.baseRevision,
        );
        return retention;
      },
      async reconcileStoryBaseRetentions(entry, _lease, rows = []) {
        const activeKeys = new Set(
          rows
            .filter((row) => row.repositoryId === entry.repositoryId)
            .map((row) => `${row.storyId}\0${entry.repositoryId}`),
        );
        let staleDeleted = 0;
        for (const key of [...storyRetentions.keys()]) {
          if (
            key.endsWith(`\0${entry.repositoryId}`)
            && !activeKeys.has(key)
          ) {
            const retention = storyRetentions.get(key);
            gitBare(fixture.mirror, "update-ref", "-d", retention.currentRef);
            gitBare(fixture.mirror, "update-ref", "-d", retention.immutableRef);
            storyRetentions.delete(key);
            staleDeleted += 1;
          }
        }
        return {
          repositoryId: entry.repositoryId,
          active: activeKeys.size,
          staleDeleted,
          retained: [...storyRetentions.values()].filter(
            (row) => row.repositoryId === entry.repositoryId,
          ),
        };
      },
      async resolveAcceptedCandidate({ repositoryId, candidateSha }) {
        return {
          repositoryId,
          mirrorPath: fixture.mirror,
          candidateSha,
          acceptedTipSha: candidateSha,
          sourceRef: fixture.sourceRef,
          remoteId: "origin",
          mirrorGeneration: 1,
        };
      },
      async resolveRetainedStoryCandidate({
        repositoryId,
        storyId,
        candidateSha,
      }) {
        const retention = storyRetentions.get(`${storyId}\0${repositoryId}`);
        if (!retention || retention.baseRevision !== candidateSha) {
          throw Object.assign(new Error("missing retained story SHA"), {
            code: "GIT_CONTROLLER_STORY_RETENTION_MISSING",
          });
        }
        return {
          repositoryId,
          mirrorPath: fixture.mirror,
          candidateSha,
          acceptedTipSha: candidateSha,
          sourceRef: fixture.sourceRef,
          remoteId: "origin",
          mirrorGeneration: 1,
          retentionRef: retention.immutableRef,
          retainedStoryId: String(storyId),
        };
      },
    },
    base: {
      async candidateSubmodulePreflight(entry, candidateSha) {
        if (typeof options.candidateContentPreflight === "function") {
          return options.candidateContentPreflight(entry, candidateSha);
        }
        return {
          eligible: true,
          blockerCode: null,
          status: "NOT_PRESENT",
          reason: null,
          submoduleCount: 0,
          verifiedCommitCount: 0,
        };
      },
    },
    leaseManager: {
      reclaimOrphanedOperation(repository, operation) {
        (state.reclaims ||= []).push({
          repositoryId: repository.repositoryId,
          operationId: operation.operationId,
          operationType: operation.operationType,
        });
        return { orphaned: true };
      },
      acquire() {
        return {
          fencingToken: 1,
          assertCurrent() {},
          gitChildGuard(commandId) {
            const executionId = `git-child-${(state.gitChildCommands ||= []).length + 1}`;
            const record = {
              executionId,
              commandId,
              phases: [],
            };
            state.gitChildCommands.push(record);
            return {
              beforeSpawn() {
                record.phases.push("SPAWNING");
                return executionId;
              },
              afterSpawn(ticket, child) {
                assert.equal(ticket, executionId);
                assert.ok(Number.isInteger(Number(child?.pid)));
                record.phases.push("RUNNING");
              },
              afterClose(ticket) {
                assert.equal(ticket, executionId);
                record.phases.push("CLEARED");
              },
              spawnFailed(ticket) {
                assert.equal(ticket, executionId);
                record.phases.push("CLEARED");
              },
            };
          },
          release() {},
        };
      },
    },
    journal: {
      persistence,
      begin(input) {
        const key = `${input.repositoryId}\0${input.operationType}\0${input.idempotencyKey}`;
        if (operations.has(key)) return { created: false, operation: operations.get(key) };
        const operation = {
          ...input,
          operationId: `operation-${operations.size + 1}`,
          status: "RUNNING",
          phase: "PREVIEWED",
          startedAt: Date.now(),
          updatedAt: Date.now(),
        };
        operations.set(key, operation);
        journalRows.push({
          operationId: operation.operationId,
          phase: "PREVIEWED",
          data: {},
        });
        return { created: true, operation };
      },
      succeed(operation, result) {
        operation.status = "SUCCEEDED";
        operation.phase = "VERIFIED";
        operation.result = result;
        operation.updatedAt = Date.now();
        journalRows.push({
          operationId: operation.operationId,
          phase: "VERIFIED",
          data: { resultCode: result?.resultCode || "PASS" },
        });
      },
      append(operation, phase, data) {
        assert.ok(CONTROLLER_PHASES.includes(phase), `unregistered Controller phase: ${phase}`);
        operation.phases ||= [];
        operation.phases.push({ phase, data });
        operation.phase = phase;
        operation.updatedAt = Date.now();
        journalRows.push({ operationId: operation.operationId, phase, data });
      },
      fail(operation, error, { recoveryRequired = false } = {}) {
        operation.status = recoveryRequired ? "RECOVERY_REQUIRED" : "FAILED";
        operation.phase = recoveryRequired ? "RECOVERY_REQUIRED" : "FAILED";
        operation.error = { code: error.code, message: error.message };
        operation.resultCode = error.code;
        operation.updatedAt = Date.now();
        journalRows.push({
          operationId: operation.operationId,
          phase: operation.phase,
          data: { error: operation.error },
        });
      },
    },
    audit: {
      write(row) {
        audits.push({
          operationId: row.operation.operationId,
          action: row.action,
          result: row.result,
          reason: row.reason || null,
          details: row.details || {},
        });
      },
    },
  };
  const rootTraversalRevocations = [];
  const service = createStoryRepositoryController({
    controller,
    storyRoot: options.storyRoot || fixture.worktreeRoot,
    dataRoot: path.join(fixture.root, "controller-data"),
    workerIdentities: {
      "story-controller": "sid:S-1-5-21-100-200-300-401",
      "story-other": "sid:S-1-5-21-100-200-300-402",
    },
    controllerIdentity: "sid:S-1-5-21-100-200-300-400",
    aclProtector: ({ workerIdentity }) => ({
      workerIdentity,
      aclFingerprint: "a".repeat(64),
    }),
    aclAttestor: ({ workerIdentity }) => ({
      workerIdentity,
      aclFingerprint: "a".repeat(64),
    }),
    aclRevoker(_root, workerIdentity) {
      rootTraversalRevocations.push(workerIdentity);
    },
    quarantineProtector(rootPath) {
      fs.mkdirSync(rootPath, { recursive: true });
    },
    repositoryQuarantineRevoker() {},
    faultInjector: options.faultInjector || null,
    workerSecretRoots: options.workerSecretRoots || [],
    workerProbeConfigPath: options.workerProbeConfigPath,
    workerProbeReconciler: options.workerProbeReconciler,
    workerProbeProtection: options.workerProbeProtection,
    gitSpawnGuard: options.gitSpawnGuard || null,
  });
  service.rootTraversalRevocations = rootTraversalRevocations;
  service.testState = state;
  return service;
}

function workerProbeControllerOptions(fixture, {
  reconciler = reconcileManagedWorkerDeploymentProbeConfig,
} = {}) {
  const secretRoot = path.join(fixture.root, "worker-secret-root");
  fs.mkdirSync(secretRoot, { recursive: true });
  return {
    workerSecretRoots: [secretRoot],
    workerProbeConfigPath: path.join(fixture.root, "worker-deployment-probe.json"),
    workerProbeReconciler: reconciler,
    workerProbeProtection: {
      sentinelProtector() {},
      sentinelVerifier() { return true; },
      configProtector() {},
      configVerifier() { return true; },
      configAclVerifier() { return true; },
    },
  };
}

function rewindProvisionOperationForCrash(service, operationId, phase) {
  const operation = [...service.testState.operations.values()]
    .find((candidate) => candidate.operationId === operationId);
  assert.ok(operation);
  const rows = service.testState.journalRows;
  const operationRows = rows
    .map((row, index) => ({ row, index }))
    .filter(({ row }) => row.operationId === operationId);
  const cutoff = operationRows.findLast(({ row }) => row.phase === phase)?.index;
  assert.ok(Number.isInteger(cutoff), `missing crash phase ${phase}`);
  for (let index = rows.length - 1; index > cutoff; index -= 1) {
    if (rows[index].operationId === operationId) rows.splice(index, 1);
  }
  for (let index = service.testState.audits.length - 1; index >= 0; index -= 1) {
    if (service.testState.audits[index].operationId === operationId) {
      service.testState.audits.splice(index, 1);
    }
  }
  operation.status = "RUNNING";
  operation.phase = phase;
  operation.result = null;
  operation.resultCode = null;
  operation.error = null;
  operation.updatedAt = Date.now();
  return operation;
}

test("story repository read-only inspection fails before its first Git child after guardian loss", async (t) => {
  const fixture = repositoryFixture();
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  const sentinel = Object.assign(new Error("guardian channel closed"), {
    code: "GIT_CONTROLLER_PROCESS_TREE_ATTESTATION_FAILED",
  });
  let guardianLive = true;
  const guardCalls = [];
  const service = storyControllerFixture(fixture, {
    gitSpawnGuard() {
      guardCalls.push(guardianLive ? "LIVE" : "LOST");
      if (!guardianLive) throw sentinel;
    },
  });
  const branch = fixture.sourceRef.slice("refs/heads/".length);
  const provisioned = await service.provision({
    tabId: "story-controller",
    repositoryId: "repository-main",
    branch,
    exactSha: fixture.acceptedA,
    idempotencyKey: "provision-spawn-guard",
  });
  assert.ok(guardCalls.length > 0);
  const mutationChildCount = service.testState.gitChildCommands.length;
  guardCalls.length = 0;
  guardianLive = false;
  await assert.rejects(
    service.inspect({
      tabId: "story-controller",
      repositoryId: "repository-main",
    }),
    (error) => error === sentinel,
  );
  assert.deepEqual(guardCalls, ["LOST"]);
  assert.equal(service.testState.gitChildCommands.length, mutationChildCount);
  assert.equal(fs.existsSync(provisioned.repository.repositoryPath), true);
});

test("Controller 迁移旧 linked worktree 时保留最终文件快照并签发独立仓证明", async (t) => {
  const fixture = repositoryFixture();
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  const legacyPath = path.join(fixture.root, "legacy-linked-worktree");
  git(fixture.source, "worktree", "add", "-b", "legacy-story-migration", legacyPath, fixture.baseB);
  fs.writeFileSync(path.join(legacyPath, "committed-only.txt"), "legacy committed\n");
  git(legacyPath, "add", "committed-only.txt");
  git(
    legacyPath,
    "-c", "user.name=Legacy Test",
    "-c", "user.email=legacy@example.test",
    "commit", "-m", "legacy story commit",
  );
  fs.writeFileSync(path.join(legacyPath, "tracked.txt"), "legacy final dirty state\n");
  fs.writeFileSync(path.join(legacyPath, "untracked.txt"), "legacy untracked state\n");

  const service = storyControllerFixture(fixture);
  const preview = await service.previewLegacyMigration({
    tabId: "story-controller",
    repositoryId: "repository-main",
    sourcePath: legacyPath,
  });
  assert.equal(preview.canMigrate, true);
  assert.equal(preview.dirtyTrackedCount, 1);
  assert.equal(preview.untrackedCount, 1);
  assert.equal(preview.sourceBranch, "legacy-story-migration");

  const branch = fixture.sourceRef.slice("refs/heads/".length);
  const provisioned = await service.provision({
    tabId: "story-controller",
    repositoryId: "repository-main",
    branch,
    exactSha: fixture.acceptedA,
    idempotencyKey: "provision-legacy-migration",
    legacyMigration: {
      sourcePath: legacyPath,
      stateDigest: preview.stateDigest,
    },
  });
  const target = provisioned.repository.repositoryPath;
  assert.equal(provisioned.created, true);
  assert.equal(provisioned.repository.baseRevision, fixture.acceptedA);
  assert.equal(provisioned.repository.headRevision, fixture.acceptedA);
  assert.equal(provisioned.legacyMigration.sourceHeadRevision, preview.sourceHeadRevision);
  assert.equal(fs.readFileSync(path.join(target, "tracked.txt"), "utf8"), "legacy final dirty state\n");
  assert.equal(fs.readFileSync(path.join(target, "committed-only.txt"), "utf8"), "legacy committed\n");
  assert.equal(fs.readFileSync(path.join(target, "untracked.txt"), "utf8"), "legacy untracked state\n");
  assert.match(git(target, "status", "--porcelain=v1", "-uall"), /tracked\.txt/);
  assert.equal(fs.existsSync(legacyPath), true, "升级不得删除旧 linked worktree");
  assert.equal(service.registryEntry("story-controller", "repository-main").aclFingerprint, "a".repeat(64));
  const inspected = await service.inspect({
    tabId: "story-controller",
    repositoryId: "repository-main",
  });
  assert.equal(inspected.workerIdentity, provisioned.workerIdentity);
  assert.equal(inspected.aclFingerprint, provisioned.aclFingerprint);
});

test("旧 worktree 在预览后变化时 Controller 停止升级并补偿新仓", async (t) => {
  const fixture = repositoryFixture();
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  const legacyPath = path.join(fixture.root, "legacy-preview-stale");
  git(fixture.source, "worktree", "add", "-b", "legacy-preview-stale", legacyPath, fixture.baseB);
  fs.writeFileSync(path.join(legacyPath, "tracked.txt"), "preview state\n");
  const service = storyControllerFixture(fixture);
  const preview = await service.previewLegacyMigration({
    tabId: "story-controller",
    repositoryId: "repository-main",
    sourcePath: legacyPath,
  });
  fs.writeFileSync(path.join(legacyPath, "tracked.txt"), "changed after preview\n");
  const branch = fixture.sourceRef.slice("refs/heads/".length);
  await assert.rejects(
    service.provision({
      tabId: "story-controller",
      repositoryId: "repository-main",
      branch,
      exactSha: fixture.acceptedA,
      idempotencyKey: "provision-legacy-preview-stale",
      legacyMigration: {
        sourcePath: legacyPath,
        stateDigest: preview.stateDigest,
      },
    }),
    { code: "STORY_REPOSITORY_LEGACY_PREVIEW_STALE" },
  );
  assert.equal(
    fs.existsSync(independentStoryRepositoryPath(
      fixture.worktreeRoot,
      "story-controller",
      "repository-main",
    )),
    false,
  );
  assert.equal(fs.existsSync(legacyPath), true);
});

test("旧 worktree 的隐藏索引标记阻断迁移以免遗漏本地代码", async (t) => {
  const fixture = repositoryFixture();
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  const legacyPath = path.join(fixture.root, "legacy-hidden-index");
  git(fixture.source, "worktree", "add", "-b", "legacy-hidden-index", legacyPath, fixture.baseB);
  git(legacyPath, "update-index", "--skip-worktree", "tracked.txt");
  const service = storyControllerFixture(fixture);
  const preview = await service.previewLegacyMigration({
    tabId: "story-controller",
    repositoryId: "repository-main",
    sourcePath: legacyPath,
  });
  assert.equal(preview.canMigrate, false);
  assert.equal(preview.hiddenIndexCount, 1);
  assert.deepEqual(
    preview.blockers.map((blocker) => blocker.code),
    ["LEGACY_HIDDEN_INDEX_FLAGS"],
  );
});

test("Controller 原位刷新已有独立仓证明时不复制或覆盖当前代码", async (t) => {
  const fixture = repositoryFixture();
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  const service = storyControllerFixture(fixture);
  const branch = fixture.sourceRef.slice("refs/heads/".length);
  const first = await service.provision({
    tabId: "story-controller",
    repositoryId: "repository-main",
    branch,
    exactSha: fixture.acceptedA,
    idempotencyKey: "provision-attestation-refresh-initial",
  });
  const target = first.repository.repositoryPath;
  fs.writeFileSync(path.join(target, "tracked.txt"), "refresh-only local state\n");
  fs.writeFileSync(path.join(target, "refresh-only-untracked.txt"), "keep me\n");

  const inspected = await service.inspect({
    tabId: "story-controller",
    repositoryId: "repository-main",
  });
  assert.equal(inspected.repositoryPath, target);
  assert.equal(inspected.workerIdentity, first.workerIdentity);
  assert.equal(inspected.aclFingerprint, first.aclFingerprint);

  const refreshed = await service.provision({
    tabId: "story-controller",
    repositoryId: "repository-main",
    branch,
    exactSha: fixture.acceptedA,
    idempotencyKey: "provision-attestation-refresh-existing",
  });
  assert.equal(refreshed.reused, true);
  assert.equal(refreshed.repository.repositoryPath, target);
  assert.equal(
    fs.readFileSync(path.join(target, "tracked.txt"), "utf8"),
    "refresh-only local state\n",
  );
  assert.equal(
    fs.readFileSync(path.join(target, "refresh-only-untracked.txt"), "utf8"),
    "keep me\n",
  );
  assert.equal(refreshed.workerIdentity, first.workerIdentity);
  assert.equal(refreshed.aclFingerprint, first.aclFingerprint);
});

test("Controller story registry 原子持久化、幂等复用并隔离同故事多仓", async (t) => {
  const fixture = repositoryFixture();
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  const service = storyControllerFixture(fixture);
  const branch = fixture.sourceRef.slice("refs/heads/".length);
  const first = await service.provision({
    tabId: "story-controller",
    repositoryId: "repository-main",
    branch,
    exactSha: fixture.acceptedA,
    idempotencyKey: "provision-main",
  });
  const replay = await service.provision({
    tabId: "story-controller",
    repositoryId: "repository-main",
    branch,
    exactSha: fixture.acceptedA,
    idempotencyKey: "provision-main",
  });
  const second = await service.provision({
    tabId: "story-controller",
    repositoryId: "repository-second",
    branch,
    exactSha: fixture.acceptedA,
    idempotencyKey: "provision-second",
  });
  assert.equal(first.created, true);
  assert.equal(replay.replayed, true);
  await assert.rejects(
    service.provision({
      tabId: "story-other",
      repositoryId: "repository-main",
      branch,
      exactSha: fixture.acceptedA,
      idempotencyKey: "provision-main",
    }),
    { code: "GIT_CONTROLLER_IDEMPOTENCY_CONFLICT" },
  );
  assert.notEqual(
    first.repository.repositoryPath,
    second.repository.repositoryPath,
  );
  const registryPath = path.join(
    fixture.root,
    "controller-data",
    "story-repositories",
    "registry.json",
  );
  const registry = JSON.parse(fs.readFileSync(registryPath, "utf8"));
  assert.equal(registry.entries.length, 2);
  assert.equal(
    (await service.resolve({
      tabId: "story-controller",
      repositoryId: "repository-main",
    })).baseRevision,
    fixture.acceptedA,
  );
  await assert.rejects(
    service.provision({
      tabId: "story-controller",
      repositoryId: "repository-main",
      branch,
      exactSha: fixture.baseB,
      idempotencyKey: "provision-mismatch",
    }),
    { code: "STORY_REPOSITORY_EXACT_SHA_CONFLICT" },
  );
  await assert.rejects(
    service.provision({
      tabId: "story-controller",
      repositoryId: "repository-main",
      branch: "release",
      exactSha: fixture.acceptedA,
      idempotencyKey: "provision-source-ref-conflict",
    }),
    { code: "STORY_REPOSITORY_SOURCE_REF_CONFLICT" },
  );
  await assert.rejects(
    service.cleanup({
      tabId: "story-controller",
      repositoryId: "repository-second",
      provisionOperationId: "operation-forged",
      expectedBaseRevision: second.repository.baseRevision,
      expectedHead: second.repository.headRevision,
      registryGeneration: second.registryGeneration,
      idempotencyKey: "cleanup-forged",
    }),
    { code: "STORY_REPOSITORY_COMPENSATION_NOT_AUTHORIZED" },
  );
  const cleaned = await service.cleanup({
    tabId: "story-controller",
    repositoryId: "repository-second",
    provisionOperationId: second.operationId,
    expectedBaseRevision: second.repository.baseRevision,
    expectedHead: second.repository.headRevision,
    registryGeneration: second.registryGeneration,
    idempotencyKey: "cleanup-second",
  });
  assert.equal(cleaned.removed, true);
  const cleanupReplay = await service.cleanup({
    tabId: "story-controller",
    repositoryId: "repository-second",
    provisionOperationId: second.operationId,
    expectedBaseRevision: second.repository.baseRevision,
    expectedHead: second.repository.headRevision,
    registryGeneration: second.registryGeneration,
    idempotencyKey: "cleanup-second",
  });
  assert.equal(cleanupReplay.operationId, cleaned.operationId);
  assert.equal(cleanupReplay.replayed, true);
  await assert.rejects(
    service.cleanup({
      tabId: "story-controller",
      repositoryId: "repository-second",
      provisionOperationId: second.operationId,
      expectedBaseRevision: second.repository.baseRevision,
      expectedHead: fixture.baseB,
      registryGeneration: second.registryGeneration,
      idempotencyKey: "cleanup-second",
    }),
    { code: "GIT_CONTROLLER_IDEMPOTENCY_CONFLICT" },
  );
  const hostileBin = path.join(fixture.root, "hostile-bin");
  fs.mkdirSync(hostileBin);
  const fakeGitMarker = path.join(hostileBin, "git-invoked");
  const fsmonitorMarker = path.join(hostileBin, "fsmonitor-invoked");
  const fakeGit = path.join(hostileBin, process.platform === "win32" ? "git.cmd" : "git");
  const fakeFsmonitor = path.join(
    hostileBin,
    process.platform === "win32" ? "fsmonitor.cmd" : "fsmonitor",
  );
  if (process.platform === "win32") {
    fs.writeFileSync(fakeGit, '@echo invoked>"%~dp0git-invoked"\r\n@exit /b 77\r\n');
    fs.writeFileSync(fakeFsmonitor, '@echo invoked>"%~dp0fsmonitor-invoked"\r\n@exit /b 0\r\n');
  } else {
    fs.writeFileSync(fakeGit, '#!/bin/sh\nprintf invoked >"$(dirname "$0")/git-invoked"\nexit 77\n');
    fs.writeFileSync(fakeFsmonitor, '#!/bin/sh\nprintf invoked >"$(dirname "$0")/fsmonitor-invoked"\nexit 0\n');
    fs.chmodSync(fakeGit, 0o700);
    fs.chmodSync(fakeFsmonitor, 0o700);
  }
  const originalBranch = git(first.repository.repositoryPath, "branch", "--show-current");
  git(first.repository.repositoryPath, "checkout", "-b", "side-local-commit");
  fs.writeFileSync(path.join(first.repository.repositoryPath, "side.txt"), "side\n");
  git(first.repository.repositoryPath, "add", "side.txt");
  git(
    first.repository.repositoryPath,
    "-c", "user.name=Controller Test",
    "-c", "user.email=controller@example.test",
    "commit", "-m", "side branch local commit",
  );
  git(first.repository.repositoryPath, "checkout", originalBranch);
  git(first.repository.repositoryPath, "config", "--local", "core.fsmonitor", fakeFsmonitor);
  const previousPath = process.env.PATH;
  process.env.PATH = `${hostileBin}${path.delimiter}${previousPath || ""}`;
  t.after(() => { process.env.PATH = previousPath; });
  fs.writeFileSync(path.join(first.repository.repositoryPath, "untracked.txt"), "local\n");
  const retirePreview = await service.retirePreview({
    tabId: "story-controller",
    repositoryId: "repository-main",
  });
  assert.equal(retirePreview.safe, false);
  assert.equal(retirePreview.forceAllowed, true);
  assert.equal(retirePreview.dirtyCount, 1);
  assert.ok(retirePreview.unpushedCount > 0);
  assert.ok(retirePreview.localRefCount > 0);
  assert.equal(fs.existsSync(fakeGitMarker), false);
  assert.equal(fs.existsSync(fsmonitorMarker), false);
  await assert.rejects(
    service.retire({
      tabId: "story-controller",
      repositoryId: "repository-main",
      previewId: retirePreview.previewId,
      previewVersion: retirePreview.previewVersion,
      expectedHead: retirePreview.headRevision,
      registryGeneration: retirePreview.entryGeneration,
      force: false,
      idempotencyKey: "retire-main-safe",
    }),
    { code: "STORY_REPOSITORY_RETIRE_RISK" },
  );
  const retired = await service.retire({
    tabId: "story-controller",
    repositoryId: "repository-main",
    previewId: retirePreview.previewId,
    previewVersion: retirePreview.previewVersion,
    expectedHead: retirePreview.headRevision,
    registryGeneration: retirePreview.entryGeneration,
    force: true,
    idempotencyKey: "retire-main-force",
  });
  assert.equal(retired.removed, true);
  assert.equal(fs.existsSync(first.repository.repositoryPath), false);
  const retireReplay = await service.retire({
    tabId: "story-controller",
    repositoryId: "repository-main",
    previewId: retirePreview.previewId,
    previewVersion: retirePreview.previewVersion,
    expectedHead: retirePreview.headRevision,
    registryGeneration: retirePreview.entryGeneration,
    force: true,
    idempotencyKey: "retire-main-force",
  });
  assert.equal(retireReplay.operationId, retired.operationId);
  assert.equal(retireReplay.replayed, true);
  await assert.rejects(
    service.retire({
      tabId: "story-controller",
      repositoryId: "repository-main",
      previewId: retirePreview.previewId,
      previewVersion: retirePreview.previewVersion,
      expectedHead: retirePreview.headRevision,
      registryGeneration: retirePreview.entryGeneration,
      force: false,
      idempotencyKey: "retire-main-force",
    }),
    { code: "GIT_CONTROLLER_IDEMPOTENCY_CONFLICT" },
  );
  assert.deepEqual(service.rootTraversalRevocations, []);
});

test("Controller 启动恢复会回滚已创建但未登记的故事仓，并完成已登记的 provision", async (t) => {
  const branchFor = (fixture) => fixture.sourceRef.slice("refs/heads/".length);

  await t.test("创建完成但 registry 未发布时只回滚完全未变化的 Controller 产物", async (t) => {
    const fixture = repositoryFixture();
    t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
    const state = {};
    const probeOptions = workerProbeControllerOptions(fixture);
    const service = storyControllerFixture(fixture, { ...probeOptions, state });
    const provisioned = await service.provision({
      tabId: "story-controller",
      repositoryId: "repository-main",
      branch: branchFor(fixture),
      exactSha: fixture.acceptedA,
      idempotencyKey: "recover-created-before-registry",
      primary: true,
    });
    await service.mutateRegistryTopology((registry) => {
      registry.entries = registry.entries.filter((row) => (
        row.createdByProvisionOperationId !== provisioned.operationId
      ));
      return registry;
    }, { reason: "test-simulated-crash-before-registry-publication" });
    rewindProvisionOperationForCrash(
      service,
      provisioned.operationId,
      "STORY_PROVISION_CREATED",
    );

    const restarted = storyControllerFixture(fixture, { ...probeOptions, state });
    await restarted.recoverWorkerProbeTopology();
    const recovered = await restarted.recoverProvisionOperations();
    assert.equal(recovered.rolledBack, 1);
    assert.equal(recovered.succeeded, 0);
    assert.equal(fs.existsSync(provisioned.repository.repositoryPath), false);
    const operation = restarted.testState.operations.get(
      `repository-main\0STORY_REPOSITORY_PROVISION\0recover-created-before-registry`,
    );
    assert.equal(operation.status, "FAILED");
    assert.equal(
      operation.error.code,
      "STORY_REPOSITORY_PROVISION_INTERRUPTED_ROLLED_BACK",
    );
    assert.ok(state.reclaims.some((row) => (
      row.operationId === provisioned.operationId
      && row.operationType === "STORY_REPOSITORY_PROVISION"
    )));
  });

  await t.test("registry 与 Worker topology 已发布时恢复为成功且 PASS 审计只写一次", async (t) => {
    const fixture = repositoryFixture();
    t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
    const state = {};
    const probeOptions = workerProbeControllerOptions(fixture);
    const service = storyControllerFixture(fixture, { ...probeOptions, state });
    const provisioned = await service.provision({
      tabId: "story-controller",
      repositoryId: "repository-main",
      branch: branchFor(fixture),
      exactSha: fixture.acceptedA,
      idempotencyKey: "recover-after-registry",
      primary: true,
    });
    rewindProvisionOperationForCrash(
      service,
      provisioned.operationId,
      "STORY_PROVISION_REGISTRY_RECORDED",
    );

    const restarted = storyControllerFixture(fixture, { ...probeOptions, state });
    await restarted.recoverWorkerProbeTopology();
    const recovered = await restarted.recoverProvisionOperations();
    assert.equal(recovered.succeeded, 1);
    assert.equal(recovered.rolledBack, 0);
    const operation = restarted.testState.operations.get(
      `repository-main\0STORY_REPOSITORY_PROVISION\0recover-after-registry`,
    );
    assert.equal(operation.status, "SUCCEEDED");
    assert.equal(operation.result.recovered, true);
    assert.ok(state.reclaims.some((row) => (
      row.operationId === provisioned.operationId
      && row.operationType === "STORY_REPOSITORY_PROVISION"
    )));
    assert.equal(operation.result.repository.baseRevision, fixture.acceptedA);
    assert.equal(operation.result.repository.headRevision, fixture.acceptedA);
    assert.equal(
      restarted.testState.audits.filter((row) => (
        row.operationId === provisioned.operationId
        && row.action === "story.repository.provision"
        && row.result === "PASS"
      )).length,
      1,
    );
    assert.equal((await restarted.recoverProvisionOperations()).recovered, 0);
    assert.equal(
      restarted.testState.audits.filter((row) => (
        row.operationId === provisioned.operationId
        && row.action === "story.repository.provision"
        && row.result === "PASS"
      )).length,
      1,
    );
  });
});

test("Controller provision 补偿拒绝删除含未跟踪文件、额外 ref 或 stash 的孤儿仓", async (t) => {
  const mutations = [
    {
      name: "untracked",
      apply(repositoryPath) {
        fs.writeFileSync(path.join(repositoryPath, "worker-untracked.txt"), "worker data\n");
      },
    },
    {
      name: "extra-ref",
      apply(repositoryPath, fixture) {
        git(
          repositoryPath,
          "update-ref",
          "refs/heads/worker-safety-ref",
          fixture.acceptedA,
        );
      },
    },
    {
      name: "stash",
      apply(repositoryPath) {
        fs.writeFileSync(path.join(repositoryPath, "tracked.txt"), "worker stash\n");
        git(repositoryPath, "stash", "push", "-m", "worker-safety-stash");
      },
    },
  ];

  for (const mutation of mutations) {
    await t.test(mutation.name, async (t) => {
      const fixture = repositoryFixture();
      t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
      const state = {};
      const probeOptions = workerProbeControllerOptions(fixture);
      const service = storyControllerFixture(fixture, { ...probeOptions, state });
      const idempotencyKey = `recover-drift-${mutation.name}`;
      const provisioned = await service.provision({
        tabId: "story-controller",
        repositoryId: "repository-main",
        branch: fixture.sourceRef.slice("refs/heads/".length),
        exactSha: fixture.acceptedA,
        idempotencyKey,
        primary: true,
      });
      await service.mutateRegistryTopology((registry) => {
        registry.entries = registry.entries.filter((row) => (
          row.createdByProvisionOperationId !== provisioned.operationId
        ));
        return registry;
      }, { reason: `test-simulated-crash-${mutation.name}` });
      rewindProvisionOperationForCrash(
        service,
        provisioned.operationId,
        "STORY_PROVISION_CREATED",
      );
      mutation.apply(provisioned.repository.repositoryPath, fixture);

      const restarted = storyControllerFixture(fixture, { ...probeOptions, state });
      await restarted.recoverWorkerProbeTopology();
      await assert.rejects(
        restarted.recoverProvisionOperations(),
        { code: "STORY_REPOSITORY_PROVISION_RECOVERY_BLOCKED" },
      );
      const operation = restarted.testState.operations.get(
        `repository-main\0STORY_REPOSITORY_PROVISION\0${idempotencyKey}`,
      );
      assert.equal(operation.status, "RECOVERY_REQUIRED");
      assert.equal(
        operation.error.code,
        "STORY_REPOSITORY_COMPENSATION_STATE_DRIFT",
      );
      assert.equal(fs.existsSync(provisioned.repository.repositoryPath), true);
    });
  }
});

test("retained exact-SHA rebuild distinguishes crashes before and after registry publication", async (t) => {
  for (const scenario of [
    {
      phase: "after-story-provision-created",
      expectedRecovered: { rolledBack: 1, succeeded: 0 },
    },
    {
      phase: "after-story-provision-registry-recorded",
      expectedRecovered: { rolledBack: 0, succeeded: 1 },
    },
  ]) {
    await t.test(scenario.phase, async (t) => {
      const fixture = repositoryFixture();
      t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
      const state = {};
      const probeOptions = workerProbeControllerOptions(fixture);
      const initial = storyControllerFixture(fixture, { ...probeOptions, state });
      const branch = fixture.sourceRef.slice("refs/heads/".length);
      const first = await initial.provision({
        tabId: "story-controller",
        repositoryId: "repository-main",
        branch,
        exactSha: fixture.acceptedA,
        idempotencyKey: `retained-rebuild-initial-${scenario.phase}`,
        primary: true,
      });
      const prior = initial.registryEntry("story-controller", "repository-main");
      fs.rmSync(first.repository.repositoryPath, { recursive: true, force: true });

      let inject = true;
      const interrupted = storyControllerFixture(fixture, {
        ...probeOptions,
        state,
        async faultInjector(phase) {
          if (inject && phase === scenario.phase) {
            inject = false;
            throw Object.assign(new Error("simulated retained rebuild crash"), {
              code: "TEST_RETAINED_REBUILD_CRASH",
            });
          }
        },
      });
      const interruptedKey = `retained-rebuild-${scenario.phase}`;
      await assert.rejects(
        interrupted.provision({
          tabId: "story-controller",
          repositoryId: "repository-main",
          branch,
          exactSha: fixture.acceptedA,
          idempotencyKey: interruptedKey,
          primary: true,
        }),
        { code: "TEST_RETAINED_REBUILD_CRASH" },
      );
      const interruptedOperation = state.operations.get(
        `repository-main\0STORY_REPOSITORY_PROVISION\0${interruptedKey}`,
      );
      assert.equal(interruptedOperation.status, "RECOVERY_REQUIRED");

      const restarted = storyControllerFixture(fixture, { ...probeOptions, state });
      await restarted.recoverWorkerProbeTopology();
      const recovered = await restarted.recoverProvisionOperations();
      assert.equal(recovered.rolledBack, scenario.expectedRecovered.rolledBack);
      assert.equal(recovered.succeeded, scenario.expectedRecovered.succeeded);

      if (scenario.expectedRecovered.rolledBack) {
        assert.equal(fs.existsSync(first.repository.repositoryPath), false);
        const retainedRow = restarted.registryEntry(
          "story-controller",
          "repository-main",
        );
        assert.equal(retainedRow.entryGeneration, prior.entryGeneration);
        assert.equal(
          retainedRow.createdByProvisionOperationId,
          prior.createdByProvisionOperationId,
        );
        const retried = await restarted.provision({
          tabId: "story-controller",
          repositoryId: "repository-main",
          branch,
          exactSha: fixture.acceptedA,
          idempotencyKey: `${interruptedKey}-retry`,
          primary: true,
        });
        assert.equal(retried.repository.baseRevision, fixture.acceptedA);
      } else {
        assert.equal(interruptedOperation.status, "SUCCEEDED");
        assert.equal(
          interruptedOperation.result.repository.baseRevision,
          fixture.acceptedA,
        );
      }
      const resolved = await restarted.resolve({
        tabId: "story-controller",
        repositoryId: "repository-main",
      });
      assert.equal(resolved.baseRevision, fixture.acceptedA);
      assert.equal(resolved.headRevision, fixture.acceptedA);
      assert.equal(
        fs.existsSync(path.join(
          resolved.repositoryPath,
          ".git",
          "objects",
          "info",
          "alternates",
        )),
        false,
      );
      assert.doesNotThrow(() => (
        git(resolved.repositoryPath, "fsck", "--connectivity-only")
      ));
    });
  }
});

test("story provision reuses candidate content preflight and rejects LFS/filter attributes before clone", async (t) => {
  const fixture = repositoryFixture();
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  fs.writeFileSync(
    path.join(fixture.source, ".gitattributes"),
    "*.bin filter=lfs diff=lfs merge=lfs -text\n",
  );
  fs.writeFileSync(path.join(fixture.source, "payload.bin"), "lfs-pointer-like\n");
  git(fixture.source, "add", ".gitattributes", "payload.bin");
  git(fixture.source, "commit", "-m", "candidate with executable attributes");
  const candidateSha = git(fixture.source, "rev-parse", "HEAD");
  gitBare(
    fixture.mirror,
    "fetch",
    "--force",
    fixture.source,
    `${fixture.sourceRef}:${fixture.sourceRef}`,
  );
  gitBare(
    fixture.mirror,
    "update-ref",
    controllerAcceptedRef(
      "origin",
      fixture.sourceRef.slice("refs/heads/".length),
    ),
    candidateSha,
  );
  assert.match(
    gitBare(fixture.mirror, "show", `${candidateSha}:.gitattributes`),
    /filter=lfs/,
  );
  let preflightCalls = 0;
  const service = storyControllerFixture(fixture, {
    candidateContentPreflight(_entry, inspectedSha) {
      preflightCalls += 1;
      assert.equal(inspectedSha, candidateSha);
      return {
        eligible: false,
        blockerCode: "BASE_SYNC_BLOCKED_CANDIDATE_ATTRIBUTES",
        status: "CANDIDATE_EXECUTABLE_ATTRIBUTES",
        reason: "CANDIDATE_EXECUTABLE_ATTRIBUTES",
        submoduleCount: 0,
        verifiedCommitCount: 0,
      };
    },
  });
  await assert.rejects(
    service.provision({
      tabId: "story-controller",
      repositoryId: "repository-main",
      branch: fixture.sourceRef.slice("refs/heads/".length),
      exactSha: candidateSha,
      idempotencyKey: "candidate-content-lfs-block",
    }),
    (error) => (
      error.code === "STORY_REPOSITORY_CANDIDATE_CONTENT_BLOCKED"
      && error.details?.blockerCode === "BASE_SYNC_BLOCKED_CANDIDATE_ATTRIBUTES"
    ),
  );
  assert.equal(preflightCalls, 1);
  assert.equal(service.readRegistry().entries.length, 0);
  assert.equal(
    fs.existsSync(independentStoryRepositoryPath(
      fixture.worktreeRoot,
      "story-controller",
      "repository-main",
    )),
    false,
  );
  const operation = service.testState.operations.get(
    "repository-main\0STORY_REPOSITORY_PROVISION\0candidate-content-lfs-block",
  );
  assert.equal(operation.status, "FAILED");
  assert.deepEqual(
    service.testState.journalRows
      .filter((row) => row.operationId === operation.operationId)
      .map((row) => row.phase),
    ["PREVIEWED", "FAILED"],
  );
});

test("Controller registry CAS atomically rebuilds exact Worker topology for concurrent provision and retire", async (t) => {
  const fixture = repositoryFixture();
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  const probeOptions = workerProbeControllerOptions(fixture);
  const service = storyControllerFixture(fixture, probeOptions);
  const branch = fixture.sourceRef.slice("refs/heads/".length);
  const [first, second] = await Promise.all([
    service.provision({
      tabId: "story-controller",
      repositoryId: "repository-main",
      branch,
      exactSha: fixture.acceptedA,
      idempotencyKey: "probe-concurrent-main",
      primary: true,
    }),
    service.provision({
      tabId: "story-other",
      repositoryId: "repository-second",
      branch,
      exactSha: fixture.acceptedA,
      idempotencyKey: "probe-concurrent-other",
      primary: true,
    }),
  ]);
  assert.notEqual(first.workerProbeGeneration, second.workerProbeGeneration);
  const registry = service.readRegistry();
  const config = JSON.parse(fs.readFileSync(probeOptions.workerProbeConfigPath, "utf8"));
  assert.equal(config.schema, "devbench.worker-deployment-probe-config.v5");
  assert.equal(config.generation, registry.generation);
  assert.deepEqual(Object.keys(config.stories).sort(), ["story-controller", "story-other"]);
  assert.equal(
    config.stories["story-controller"].workerIdentity,
    "sid:S-1-5-21-100-200-300-401",
  );
  assert.equal(
    config.stories["story-other"].workerIdentity,
    "sid:S-1-5-21-100-200-300-402",
  );
  assert.ok(config.stories["story-controller"].inaccessibleRoots.includes(
    second.repository.repositoryPath,
  ));
  assert.ok(config.stories["story-other"].inaccessibleRoots.includes(
    first.repository.repositoryPath,
  ));
  assert.deepEqual(
    config.stories["story-controller"].writeDeniedRoots,
    [fixture.source],
  );
  assert.ok(config.stories["story-controller"].inaccessibleRoots.includes(
    path.join(fixture.source, ".git"),
  ));
  assert.ok(config.stories["story-controller"].inaccessibleRoots.includes(fixture.mirror));
  const orderedResults = [first, second].sort(
    (left, right) => left.workerProbeGeneration - right.workerProbeGeneration,
  );
  assert.deepEqual(orderedResults[0].storiesRequiringProbe, [
    orderedResults[0].repository.storyId,
  ]);
  assert.deepEqual(
    [...orderedResults[1].storiesRequiringProbe].sort(),
    ["story-controller", "story-other"],
  );
  const topology = service.buildWorkerProbeTopology(registry);
  assert.equal(service.workerProbeTopologyMatches(topology, config), true);
  const manifestDrift = path.join(fixture.mirror, ".worker-probe-manifest-drift");
  fs.writeFileSync(manifestDrift, "drift");
  assert.equal(service.workerProbeTopologyMatches(topology, config), false);
  fs.unlinkSync(manifestDrift);
  assert.equal(service.workerProbeTopologyMatches(topology, config), true);
  const generationBeforeMetadataCas = service.readRegistry().generation;
  await service.updateMetadata("story-controller", "repository-main", {});
  const afterMetadataCas = JSON.parse(
    fs.readFileSync(probeOptions.workerProbeConfigPath, "utf8"),
  );
  assert.equal(afterMetadataCas.generation, generationBeforeMetadataCas + 1);
  assert.equal(afterMetadataCas.generation, service.readRegistry().generation);

  const preview = await service.retirePreview({
    tabId: "story-other",
    repositoryId: "repository-second",
  });
  const retired = await service.retire({
    tabId: "story-other",
    repositoryId: "repository-second",
    previewId: preview.previewId,
    previewVersion: preview.previewVersion,
    expectedHead: preview.headRevision,
    registryGeneration: preview.entryGeneration,
    force: preview.safe !== true,
    idempotencyKey: "probe-retire-other",
  });
  const after = JSON.parse(fs.readFileSync(probeOptions.workerProbeConfigPath, "utf8"));
  assert.equal(after.generation, service.readRegistry().generation);
  assert.deepEqual(Object.keys(after.stories), ["story-controller"]);
  assert.deepEqual(retired.storiesRequiringProbe, ["story-controller"]);

  const registered = service.registryEntry("story-controller", "repository-main");
  const cleaned = await service.cleanup({
    tabId: "story-controller",
    repositoryId: "repository-main",
    provisionOperationId: first.operationId,
    expectedBaseRevision: registered.baseRevision,
    expectedHead: registered.headRevision,
    registryGeneration: registered.entryGeneration,
    idempotencyKey: "probe-cleanup-main",
  });
  const afterCleanup = JSON.parse(
    fs.readFileSync(probeOptions.workerProbeConfigPath, "utf8"),
  );
  assert.equal(afterCleanup.generation, service.readRegistry().generation);
  assert.deepEqual(Object.keys(afterCleanup.stories), []);
  assert.deepEqual(cleaned.storiesRequiringProbe, []);
});

test("provision probe reconcile failure compensates registry and repository without silent drift", async (t) => {
  const fixture = repositoryFixture();
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  let calls = 0;
  const probeOptions = workerProbeControllerOptions(fixture, {
    reconciler(topology, options) {
      calls += 1;
      if (calls === 1) {
        throw Object.assign(new Error("simulated probe publication failure"), {
          code: "SIMULATED_PROBE_RECONCILE_FAILURE",
        });
      }
      return reconcileManagedWorkerDeploymentProbeConfig(topology, options);
    },
  });
  const service = storyControllerFixture(fixture, probeOptions);
  const branch = fixture.sourceRef.slice("refs/heads/".length);
  await assert.rejects(
    service.provision({
      tabId: "story-controller",
      repositoryId: "repository-main",
      branch,
      exactSha: fixture.acceptedA,
      idempotencyKey: "probe-compensated-provision",
      primary: true,
    }),
    (error) => (
      error.code === "WORKER_DEPLOYMENT_TOPOLOGY_RECONCILE_FAILED"
      && error.details?.compensated === true
      && error.details?.recoveryRequired === false
    ),
  );
  assert.equal(service.readRegistry().entries.length, 0);
  assert.equal(fs.existsSync(independentStoryRepositoryPath(
    fixture.worktreeRoot,
    "story-controller",
    "repository-main",
  )), false);
  const config = JSON.parse(fs.readFileSync(probeOptions.workerProbeConfigPath, "utf8"));
  assert.equal(config.generation, service.readRegistry().generation);
  assert.deepEqual(config.stories, {});
  assert.equal(fs.existsSync(service.workerProbePendingPath), false);
});

test("retire reconcile failure remains blocked and restart recovery rebuilds registry-owned topology", async (t) => {
  const fixture = repositoryFixture();
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  const state = {};
  const probeOptions = workerProbeControllerOptions(fixture);
  const firstService = storyControllerFixture(fixture, { ...probeOptions, state });
  const branch = fixture.sourceRef.slice("refs/heads/".length);
  await firstService.provision({
    tabId: "story-controller",
    repositoryId: "repository-main",
    branch,
    exactSha: fixture.acceptedA,
    idempotencyKey: "probe-recovery-provision",
    primary: true,
  });
  const preview = await firstService.retirePreview({
    tabId: "story-controller",
    repositoryId: "repository-main",
  });
  firstService.workerProbeReconciler = () => {
    throw Object.assign(new Error("simulated restart-required failure"), {
      code: "SIMULATED_PROBE_RESTART_FAILURE",
    });
  };
  await assert.rejects(
    firstService.retire({
      tabId: "story-controller",
      repositoryId: "repository-main",
      previewId: preview.previewId,
      previewVersion: preview.previewVersion,
      expectedHead: preview.headRevision,
      registryGeneration: preview.entryGeneration,
      force: preview.safe !== true,
      idempotencyKey: "probe-recovery-retire",
    }),
    (error) => (
      error.code === "WORKER_DEPLOYMENT_TOPOLOGY_RECONCILE_FAILED"
      && error.details?.recoveryRequired === true
    ),
  );
  assert.equal(fs.existsSync(firstService.workerProbePendingPath), true);
  await assert.rejects(
    firstService.updateMetadata("story-controller", "repository-main", {}),
    { code: "WORKER_DEPLOYMENT_TOPOLOGY_RECONCILE_FAILED" },
  );

  const restarted = storyControllerFixture(fixture, { ...probeOptions, state });
  const recovery = await restarted.recoverWorkerProbeTopology();
  assert.equal(recovery.recovered, true);
  assert.deepEqual(recovery.storiesRequiringProbe, []);
  await restarted.recoverQuarantines();
  const config = JSON.parse(fs.readFileSync(probeOptions.workerProbeConfigPath, "utf8"));
  assert.equal(config.generation, restarted.readRegistry().generation);
  assert.deepEqual(config.stories, {});
  assert.equal(fs.existsSync(restarted.workerProbePendingPath), false);
});

test("already-missing story retire publishes a tombstone and recovers after registry removal", async (t) => {
  const fixture = repositoryFixture();
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  const state = {};
  const probeOptions = workerProbeControllerOptions(fixture);
  const initial = storyControllerFixture(fixture, { ...probeOptions, state });
  const provisioned = await initial.provision({
    tabId: "story-controller",
    repositoryId: "repository-main",
    branch: fixture.sourceRef.slice("refs/heads/".length),
    exactSha: fixture.acceptedA,
    idempotencyKey: "already-missing-retire-provision",
    primary: true,
  });
  fs.rmSync(provisioned.repository.repositoryPath, {
    recursive: true,
    force: true,
  });

  let inject = true;
  const interrupted = storyControllerFixture(fixture, {
    ...probeOptions,
    state,
    async faultInjector(phase) {
      if (inject && phase === "after-story-retire-registry-removed") {
        inject = false;
        throw Object.assign(new Error("simulated already-missing retire crash"), {
          code: "TEST_ALREADY_MISSING_RETIRE_CRASH",
        });
      }
    },
  });
  const preview = await interrupted.retirePreview({
    tabId: "story-controller",
    repositoryId: "repository-main",
  });
  assert.equal(preview.exists, false);
  await assert.rejects(
    interrupted.retire({
      tabId: "story-controller",
      repositoryId: "repository-main",
      previewId: preview.previewId,
      previewVersion: preview.previewVersion,
      expectedHead: preview.headRevision,
      registryGeneration: preview.entryGeneration,
      idempotencyKey: "already-missing-retire",
    }),
    { code: "TEST_ALREADY_MISSING_RETIRE_CRASH" },
  );
  const operation = state.operations.get(
    "repository-main\0STORY_REPOSITORY_RETIRE\0already-missing-retire",
  );
  assert.equal(operation.status, "RECOVERY_REQUIRED");
  assert.equal(
    fs.existsSync(path.join(
      fixture.worktreeRoot,
      ".controller-quarantine",
      `${operation.operationId}.json`,
    )),
    true,
  );

  const restarted = storyControllerFixture(fixture, { ...probeOptions, state });
  await restarted.recoverWorkerProbeTopology();
  const recovered = await restarted.recoverQuarantines();
  assert.equal(recovered.recovered, 1);
  assert.equal(operation.status, "SUCCEEDED");
  assert.equal(operation.result.removed, false);
  assert.equal(operation.result.alreadyMissing, true);
  assert.equal(
    restarted.registryEntry("story-controller", "repository-main"),
    null,
  );
  assert.equal(state.storyRetentions.size, 0);
});

test("story retire quarantines before delete and startup recovery completes an interrupted quarantine", async (t) => {
  const fixture = repositoryFixture();
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  const state = {};
  const crash = Object.assign(new Error("simulated quarantine crash"), {
    code: "SIMULATED_QUARANTINE_CRASH",
  });
  let observedOriginal = "";
  let observedQuarantine = "";
  const firstService = storyControllerFixture(fixture, {
    state,
    faultInjector(phase, context) {
      if (phase !== "after-story-quarantine-rename") return;
      observedOriginal = context.registered.repositoryPath;
      observedQuarantine = context.quarantinePath;
      assert.equal(fs.existsSync(observedOriginal), false);
      assert.equal(fs.existsSync(observedQuarantine), true);
      throw crash;
    },
  });
  const branch = fixture.sourceRef.slice("refs/heads/".length);
  const provisioned = await firstService.provision({
    tabId: "story-controller",
    repositoryId: "repository-main",
    branch,
    exactSha: fixture.acceptedA,
    idempotencyKey: "quarantine-provision",
  });
  const preview = await firstService.retirePreview({
    tabId: "story-controller",
    repositoryId: "repository-main",
  });
  await assert.rejects(
    firstService.retire({
      tabId: "story-controller",
      repositoryId: "repository-main",
      previewId: preview.previewId,
      previewVersion: preview.previewVersion,
      expectedHead: preview.headRevision,
      registryGeneration: preview.entryGeneration,
      force: false,
      idempotencyKey: "quarantine-retire",
    }),
    { code: "SIMULATED_QUARANTINE_CRASH" },
  );
  assert.equal(fs.existsSync(provisioned.repository.repositoryPath), false);
  assert.equal(fs.existsSync(observedQuarantine), true);

  const restarted = storyControllerFixture(fixture, { state });
  const recovery = await restarted.recoverQuarantines();
  assert.equal(recovery.recovered, 1);
  assert.equal(fs.existsSync(observedQuarantine), false);
  assert.equal(fs.existsSync(observedOriginal), false);
  const retireOperation = state.operations.get(
    "repository-main\0STORY_REPOSITORY_RETIRE\0quarantine-retire",
  );
  assert.equal(retireOperation.status, "SUCCEEDED");
  assert.equal(retireOperation.result.recovered, true);
  assert.equal(
    state.audits.filter((row) => (
      row.operationId === retireOperation.operationId
      && row.action === "story.repository.retire"
      && row.result === "PASS"
    )).length,
    1,
  );
  assert.ok(state.reclaims.some((row) => (
    row.operationId === retireOperation.operationId
    && row.operationType === "STORY_REPOSITORY_RETIRE"
  )));
  assert.equal((await restarted.recoverQuarantines()).recovered, 0);
  assert.equal(
    state.audits.filter((row) => (
      row.operationId === retireOperation.operationId
      && row.action === "story.repository.retire"
      && row.result === "PASS"
    )).length,
    1,
  );
  await assert.rejects(
    restarted.resolve({
      tabId: "story-controller",
      repositoryId: "repository-main",
    }),
    { code: "STORY_REPOSITORY_NOT_REGISTERED" },
  );
});

test("story cleanup uses the same durable quarantine transaction and startup recovery", async (t) => {
  const fixture = repositoryFixture();
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  const state = {};
  const crash = Object.assign(new Error("simulated cleanup quarantine crash"), {
    code: "SIMULATED_CLEANUP_QUARANTINE_CRASH",
  });
  let observedQuarantine = "";
  const service = storyControllerFixture(fixture, {
    state,
    faultInjector(phase, context) {
      if (phase !== "after-story-quarantine-rename") return;
      observedQuarantine = context.quarantinePath;
      assert.equal(fs.existsSync(context.registered.repositoryPath), false);
      assert.equal(fs.existsSync(observedQuarantine), true);
      throw crash;
    },
  });
  const provisioned = await service.provision({
    tabId: "story-controller",
    repositoryId: "repository-main",
    branch: fixture.sourceRef.slice("refs/heads/".length),
    exactSha: fixture.acceptedA,
    idempotencyKey: "cleanup-recovery-provision",
  });
  const registered = service.registryEntry(
    "story-controller",
    "repository-main",
  );
  await assert.rejects(
    service.cleanup({
      tabId: "story-controller",
      repositoryId: "repository-main",
      provisionOperationId: provisioned.operationId,
      expectedBaseRevision: registered.baseRevision,
      expectedHead: registered.headRevision,
      registryGeneration: registered.entryGeneration,
      idempotencyKey: "cleanup-recovery-operation",
    }),
    { code: "SIMULATED_CLEANUP_QUARANTINE_CRASH" },
  );
  assert.equal(fs.existsSync(observedQuarantine), true);

  const restarted = storyControllerFixture(fixture, { state });
  const recovery = await restarted.recoverQuarantines();
  assert.equal(recovery.recovered, 1);
  const cleanupOperation = state.operations.get(
    "repository-main\0STORY_REPOSITORY_CLEANUP\0cleanup-recovery-operation",
  );
  assert.equal(cleanupOperation.status, "SUCCEEDED");
  assert.equal(cleanupOperation.result.recovered, true);
  assert.equal(fs.existsSync(observedQuarantine), false);
  assert.equal(fs.existsSync(provisioned.repository.repositoryPath), false);
  assert.equal(restarted.readRegistry().entries.length, 0);
  assert.equal(
    state.audits.filter((row) => (
      row.operationId === cleanupOperation.operationId
      && row.action === "story.repository.cleanup"
      && row.result === "PASS"
    )).length,
    1,
  );
  assert.ok(state.reclaims.some((row) => (
    row.operationId === cleanupOperation.operationId
    && row.operationType === "STORY_REPOSITORY_CLEANUP"
  )));
});

test("story removal recovery scans operations in both directions and blocks a missing destructive manifest", async (t) => {
  const fixture = repositoryFixture();
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  const state = {};
  const service = storyControllerFixture(fixture, { state });
  await service.provision({
    tabId: "story-controller",
    repositoryId: "repository-main",
    branch: fixture.sourceRef.slice("refs/heads/".length),
    exactSha: fixture.acceptedA,
    idempotencyKey: "removal-scan-provision",
  });
  const safe = service.controller.journal.begin({
    repositoryId: "repository-main",
    operationType: "STORY_REPOSITORY_RETIRE",
    commandId: "story.repository.retire",
    idempotencyKey: "removal-scan-safe",
    previewId: "preview-safe",
    branch: "__test_retire__",
    expectedHead: fixture.acceptedA,
    candidateSha: fixture.acceptedA,
  }).operation;
  const safelyClosed = await service.recoverQuarantines();
  assert.equal(safelyClosed.safelyFailed, 1);
  assert.equal(safe.status, "FAILED");
  assert.equal(
    safe.error.code,
    "STORY_REPOSITORY_REMOVAL_INTERRUPTED_BEFORE_QUARANTINE",
  );

  const ambiguous = service.controller.journal.begin({
    repositoryId: "repository-main",
    operationType: "STORY_REPOSITORY_RETIRE",
    commandId: "story.repository.retire",
    idempotencyKey: "removal-scan-ambiguous",
    previewId: "preview-ambiguous",
    branch: "__test_retire__",
    expectedHead: fixture.acceptedA,
    candidateSha: fixture.acceptedA,
  }).operation;
  service.controller.journal.append(
    ambiguous,
    "STORY_RETIRE_QUARANTINING",
    {
      manifest: `${ambiguous.operationId}.json`,
      expectedHead: fixture.acceptedA,
      expectedContentSignature: "a".repeat(64),
    },
  );
  await assert.rejects(
    service.recoverQuarantines(),
    { code: "STORY_REPOSITORY_QUARANTINE_RECOVERY_BLOCKED" },
  );
  assert.equal(ambiguous.status, "RECOVERY_REQUIRED");
  assert.equal(
    ambiguous.error.code,
    "STORY_REPOSITORY_QUARANTINE_MANIFEST_MISSING",
  );
  assert.equal(
    fs.existsSync(independentStoryRepositoryPath(
      fixture.worktreeRoot,
      "story-controller",
      "repository-main",
    )),
    true,
  );
});

test("历史 exact SHA 仅在 accepted tip 祖先链内创建并持久化双 SHA", async (t) => {
  const fixture = repositoryFixture();
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  gitBare(
    fixture.mirror,
    "fetch",
    "--force",
    fixture.source,
    `${fixture.sourceRef}:${fixture.sourceRef}`,
  );
  gitBare(
    fixture.mirror,
    "update-ref",
    controllerAcceptedRef(
      "origin",
      fixture.sourceRef.slice("refs/heads/".length),
    ),
    fixture.baseB,
    fixture.acceptedA,
  );

  const story = await provisionStoryWorktrees({
    tabId: "story-historical-exact",
    worktreeRoot: fixture.worktreeRoot,
    repositories: [
      acceptedRepository(fixture, fixture.acceptedA, 2, fixture.baseB),
    ],
  });
  const entry = story.entries[0];
  assert.equal(entry.baseRevision, fixture.acceptedA);
  assert.equal(entry.acceptedTipRevision, fixture.baseB);
  assert.equal(git(entry.repositoryPath, "rev-parse", "HEAD"), fixture.acceptedA);
  assert.equal(
    git(entry.repositoryPath, "config", "--local", "--get", "devbench.accepted-tip-revision"),
    fixture.baseB,
  );

  git(fixture.source, "checkout", "--orphan", "unaccepted-side");
  fs.rmSync(path.join(fixture.source, "tracked.txt"), { force: true });
  fs.writeFileSync(path.join(fixture.source, "side.txt"), "outside accepted history\n");
  git(fixture.source, "add", "-A");
  git(fixture.source, "commit", "-m", "outside accepted history");
  const outsideSha = git(fixture.source, "rev-parse", "HEAD");
  gitBare(fixture.mirror, "fetch", fixture.source, outsideSha);

  await assert.rejects(
    provisionStoryWorktrees({
      tabId: "story-historical-rejected",
      worktreeRoot: fixture.worktreeRoot,
      repositories: [
        acceptedRepository(fixture, outsideSha, 2, fixture.baseB),
      ],
    }),
    (error) => error?.code === "STORY_REPOSITORY_CANDIDATE_NOT_ACCEPTED",
  );
});

test("accepted exact SHA 创建独立 .git，故事间和基础仓、mirror 均不共享 common-dir", async (t) => {
  const fixture = repositoryFixture();
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));

  const storyOne = await provisionStoryWorktrees({
    tabId: "story-one",
    worktreeRoot: fixture.worktreeRoot,
    naming: { ticketId: "CARB-1001", createdAt: Date.UTC(2026, 6, 29, 1, 2, 3) },
    repositories: [acceptedRepository(fixture, fixture.acceptedA)],
  });
  const storyTwo = await provisionStoryWorktrees({
    tabId: "story-two",
    worktreeRoot: fixture.worktreeRoot,
    naming: { ticketId: "CARB-1002", createdAt: Date.UTC(2026, 6, 29, 1, 2, 4) },
    repositories: [acceptedRepository(fixture, fixture.acceptedA)],
  });

  assert.equal(storyOne.version, 3);
  assert.equal(storyOne.repositoryMode, INDEPENDENT_REPOSITORY_MODE);
  assert.equal(storyOne.entries[0].repositoryMode, INDEPENDENT_REPOSITORY_MODE);
  assert.equal(storyOne.entries[0].baseRevision, fixture.acceptedA);
  assert.equal(storyOne.entries[0].createdBaseRevision, fixture.acceptedA);
  assert.equal(storyOne.entries[0].headRevision, fixture.acceptedA);
  assert.equal(storyOne.entries[0].remoteId, "origin");
  assert.equal(git(storyOne.entries[0].path, "rev-parse", "HEAD"), fixture.acceptedA);
  assert.notEqual(git(fixture.source, "rev-parse", "HEAD"), fixture.acceptedA);
  assert.equal(fs.statSync(path.join(storyOne.entries[0].repositoryPath, ".git")).isDirectory(), true);

  const commonDirs = [
    resolvedCommonDir(fixture.source),
    resolvedCommonDir(fixture.mirror, { bare: true }),
    resolvedCommonDir(storyOne.entries[0].repositoryPath),
    resolvedCommonDir(storyTwo.entries[0].repositoryPath),
  ].map((value) => path.normalize(value).toLowerCase());
  assert.equal(new Set(commonDirs).size, commonDirs.length);
  assert.notEqual(storyOne.entries[0].repositoryPath, storyTwo.entries[0].repositoryPath);

  for (const entry of [storyOne.entries[0], storyTwo.entries[0]]) {
    const alternates = path.join(entry.repositoryPath, ".git", "objects", "info", "alternates");
    assert.equal(fs.existsSync(alternates) ? fs.readFileSync(alternates, "utf8").trim() : "", "");
    assert.equal(git(entry.repositoryPath, "remote"), "");
    const localConfig = git(entry.repositoryPath, "config", "--local", "--list").replaceAll("\\", "/").toLowerCase();
    assert.match(localConfig, /devbench\.repository-mode=independent_repository/);
    assert.doesNotMatch(localConfig, new RegExp(
      fixture.mirror.replaceAll("\\", "/").replace(/[.*+?^${}()|[\]\\]/g, "\\$&").toLowerCase(),
    ));
    assert.doesNotMatch(localConfig, new RegExp(
      fixture.source.replaceAll("\\", "/").replace(/[.*+?^${}()|[\]\\]/g, "\\$&").toLowerCase(),
    ));
  }

  gitBare(fixture.mirror, "gc", "--prune=now");
  assert.equal(git(storyOne.entries[0].repositoryPath, "cat-file", "-t", fixture.acceptedA), "commit");
  assert.equal(git(storyTwo.entries[0].repositoryPath, "show", "-s", "--format=%H", "HEAD"), fixture.acceptedA);
});

test("故事仓提交及复用不会随 mirror 新 generation 漂移 baseRevision", async (t) => {
  const fixture = repositoryFixture();
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));

  const first = await provisionStoryWorktrees({
    tabId: "story-pinned",
    worktreeRoot: fixture.worktreeRoot,
    naming: { ticketId: "CARB-2001", createdAt: Date.UTC(2026, 6, 29, 2, 3, 4) },
    repositories: [acceptedRepository(fixture, fixture.acceptedA, 1)],
  });
  const repositoryPath = first.entries[0].repositoryPath;
  git(repositoryPath, "config", "user.name", "Devbench Story");
  git(repositoryPath, "config", "user.email", "story@example.test");
  fs.writeFileSync(path.join(repositoryPath, "story-change.txt"), "story-only\n");
  git(repositoryPath, "add", "story-change.txt");
  git(repositoryPath, "commit", "-m", "story change");
  const storyHead = git(repositoryPath, "rev-parse", "HEAD");
  assert.notEqual(storyHead, fixture.acceptedA);

  gitBare(
    fixture.mirror,
    "fetch",
    "--force",
    fixture.source,
    `${fixture.sourceRef}:${fixture.sourceRef}`,
  );
  assert.equal(gitBare(fixture.mirror, "rev-parse", fixture.sourceRef), fixture.baseB);
  gitBare(
    fixture.mirror,
    "update-ref",
    controllerAcceptedRef(
      "origin",
      fixture.sourceRef.slice("refs/heads/".length),
    ),
    fixture.baseB,
    fixture.acceptedA,
  );

  const reused = await provisionStoryWorktrees({
    tabId: "story-pinned",
    worktreeRoot: fixture.worktreeRoot,
    naming: { ticketId: "CARB-2001", createdAt: Date.UTC(2026, 6, 29, 2, 3, 4) },
    repositories: [acceptedRepository(fixture, fixture.baseB, 2)],
  });
  assert.equal(reused.entries[0].reused, true);
  assert.equal(reused.entries[0].headRevision, storyHead);
  assert.equal(reused.entries[0].baseRevision, fixture.acceptedA);
  assert.equal(reused.entries[0].createdBaseRevision, fixture.acceptedA);
  assert.equal(reused.entries[0].mirrorGeneration, 1);
  assert.equal(git(repositoryPath, "rev-parse", "refs/devbench/story-base"), fixture.acceptedA);
  assert.equal(git(repositoryPath, "rev-parse", "HEAD"), storyHead);

  const newerStory = await provisionStoryWorktrees({
    tabId: "story-new-generation",
    worktreeRoot: fixture.worktreeRoot,
    naming: { ticketId: "CARB-2002", createdAt: Date.UTC(2026, 6, 29, 2, 3, 5) },
    repositories: [acceptedRepository(fixture, fixture.baseB, 2)],
  });
  assert.equal(newerStory.entries[0].baseRevision, fixture.baseB);
  assert.equal(newerStory.entries[0].headRevision, fixture.baseB);
  assert.equal(newerStory.entries[0].mirrorGeneration, 2);
});

test("既有独立故事仓不依赖 mirror 存活即可复用", async (t) => {
  const fixture = repositoryFixture();
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));

  const first = await provisionStoryWorktrees({
    tabId: "story-mirror-independent",
    worktreeRoot: fixture.worktreeRoot,
    repositories: [acceptedRepository(fixture, fixture.acceptedA, 1)],
  });
  const repositoryPath = first.entries[0].repositoryPath;
  const expectedHead = git(repositoryPath, "rev-parse", "HEAD");
  fs.rmSync(fixture.mirror, { recursive: true, force: true });

  const reused = await provisionStoryWorktrees({
    tabId: "story-mirror-independent",
    worktreeRoot: fixture.worktreeRoot,
    repositories: [acceptedRepository(fixture, fixture.acceptedA, 1)],
  });
  assert.equal(reused.entries[0].reused, true);
  assert.equal(git(repositoryPath, "rev-parse", "HEAD"), expectedHead);
  assert.equal(reused.entries[0].baseRevision, fixture.acceptedA);
});

test("存在 accepted 意图但 descriptor 不完整时直接失败且不回退基础仓 HEAD", async (t) => {
  const fixture = repositoryFixture();
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));

  await assert.rejects(
    provisionStoryWorktrees({
      tabId: "story-abbreviated",
      worktreeRoot: fixture.worktreeRoot,
      repositories: [{
        ...acceptedRepository(fixture, fixture.acceptedA),
        accepted: {
          ...acceptedRepository(fixture, fixture.acceptedA).accepted,
          candidateSha: fixture.acceptedA.slice(0, 12),
        },
      }],
    }),
    (error) => error?.code === "STORY_REPOSITORY_EXACT_SHA_REQUIRED",
  );
  await assert.rejects(
    provisionStoryWorktrees({
      tabId: "story-missing-generation",
      worktreeRoot: fixture.worktreeRoot,
      repositories: [{
        role: "primary",
        path: fixture.source,
        repositoryId: "repository-main",
        mirrorPath: fixture.mirror,
        candidateSha: fixture.acceptedA,
        sourceRef: fixture.sourceRef,
      }],
    }),
    (error) => error?.code === "STORY_REPOSITORY_MIRROR_GENERATION_INVALID",
  );
  await assert.rejects(
    provisionStoryWorktrees({
      tabId: "story-accepted-ref-drift",
      worktreeRoot: fixture.worktreeRoot,
      repositories: [{
        ...acceptedRepository(fixture, fixture.acceptedA),
        accepted: {
          ...acceptedRepository(fixture, fixture.acceptedA).accepted,
          acceptedRef: controllerAcceptedRef("origin", "different-branch"),
        },
      }],
    }),
    (error) => error?.code === "STORY_REPOSITORY_ACCEPTED_REF_INVALID",
  );
  assert.equal(fs.existsSync(fixture.worktreeRoot), false);
});

test("mirror 中可达但未由 Controller accepted ref 发布的 SHA 必须拒绝", async (t) => {
  const fixture = repositoryFixture();
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  gitBare(
    fixture.mirror,
    "fetch",
    "--force",
    fixture.source,
    `${fixture.sourceRef}:${fixture.sourceRef}`,
  );
  assert.equal(gitBare(fixture.mirror, "cat-file", "-t", fixture.baseB), "commit");
  assert.equal(
    gitBare(
      fixture.mirror,
      "rev-parse",
      controllerAcceptedRef(
        "origin",
        fixture.sourceRef.slice("refs/heads/".length),
      ),
    ),
    fixture.acceptedA,
  );

  await assert.rejects(
    provisionStoryWorktrees({
      tabId: "story-unaccepted",
      worktreeRoot: fixture.worktreeRoot,
      repositories: [acceptedRepository(fixture, fixture.baseB, 2)],
    }),
    (error) => error?.code === "STORY_REPOSITORY_ACCEPTED_REF_MISMATCH",
  );
  assert.equal(fs.existsSync(fixture.worktreeRoot), false);
});

test("独立故事仓清理校验身份并仅删除登记 repositoryPath，不触碰基础仓", async (t) => {
  const fixture = repositoryFixture();
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  const baseHeadBefore = git(fixture.source, "rev-parse", "HEAD");
  const baseCommonBefore = resolvedCommonDir(fixture.source);
  const story = await provisionStoryWorktrees({
    tabId: "story-cleanup",
    worktreeRoot: fixture.worktreeRoot,
    naming: { ticketId: "CARB-4001", createdAt: Date.UTC(2026, 6, 29, 4, 5, 6) },
    repositories: [acceptedRepository(fixture, fixture.acceptedA, 1)],
  });
  const repositoryPath = story.entries[0].repositoryPath;
  const inspection = await inspectStoryWorktreeCleanup({
    worktree: story,
    storyTitle: "独立故事仓清理",
  });
  assert.equal(inspection.safe, true, JSON.stringify(inspection.blockers));
  assert.equal(inspection.forceAllowed, true);
  assert.equal(inspection.repositories[0].repositoryMode, INDEPENDENT_REPOSITORY_MODE);

  const tampered = {
    ...story,
    entries: story.entries.map((entry) => ({
      ...entry,
      repositoryPath: fixture.source,
    })),
  };
  const tamperedInspection = await inspectStoryWorktreeCleanup({
    worktree: tampered,
    storyTitle: "篡改独立故事仓路径",
  });
  assert.equal(tamperedInspection.forceAllowed, false);
  const refused = await cleanupStoryWorktrees({
    worktree: tampered,
    storyTitle: "篡改独立故事仓路径",
    expectedToken: tamperedInspection.token,
    force: true,
    leaseGuard: () => true,
  });
  assert.equal(refused.ok, false);
  assert.equal(refused.code, "WORKTREE_FORCE_BLOCKED");
  assert.equal(fs.existsSync(repositoryPath), true);
  assert.equal(fs.existsSync(fixture.source), true);

  const cleaned = await cleanupStoryWorktrees({
    worktree: story,
    storyTitle: "独立故事仓清理",
    expectedToken: inspection.token,
    deleteLocalBranches: true,
    leaseGuard: () => true,
  });
  assert.equal(cleaned.ok, false);
  assert.equal(cleaned.code, "STORY_REPOSITORY_CONTROLLER_RETIRE_REQUIRED");
  assert.equal(fs.existsSync(repositoryPath), true);
  assert.equal(git(fixture.source, "rev-parse", "HEAD"), baseHeadBefore);
  assert.equal(resolvedCommonDir(fixture.source), baseCommonBefore);
  assert.equal(git(fixture.source, "status", "--porcelain"), "");
});

test("无 accepted descriptor 的历史调用保持 linked worktree 并显式标记 legacy", async (t) => {
  const fixture = repositoryFixture();
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));

  const legacy = await provisionStoryWorktrees({
    tabId: "story-legacy",
    worktreeRoot: fixture.worktreeRoot,
    naming: { ticketId: "CARB-3001", createdAt: Date.UTC(2026, 6, 29, 3, 4, 5) },
    repositories: [{
      role: "primary",
      name: "App",
      path: fixture.source,
      repositoryId: "repository-main",
    }],
  });
  assert.equal(legacy.version, 2);
  assert.equal(legacy.namingVersion, 2);
  assert.equal(legacy.repositoryMode, LEGACY_LINKED_WORKTREE_MODE);
  assert.equal(legacy.entries[0].repositoryMode, LEGACY_LINKED_WORKTREE_MODE);
  assert.equal(
    path.normalize(resolvedCommonDir(legacy.entries[0].path)).toLowerCase(),
    path.normalize(resolvedCommonDir(fixture.source)).toLowerCase(),
  );
});

test("Controller creates, inspects, and retires an exact-SHA story repository with deep Windows paths", async (t) => {
  const fixture = deepenStoryRepositoryFixture(repositoryFixture());
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  const service = storyControllerFixture(fixture, {
    storyRoot: fixture.worktreeRoot,
  });
  const branch = fixture.sourceRef.slice("refs/heads/".length);

  const provisioned = await service.provision({
    tabId: "story-controller",
    repositoryId: "repository-main",
    branch,
    exactSha: fixture.acceptedA,
    idempotencyKey: "provision-deep-path-main",
    primary: true,
  });
  assert.equal(provisioned.repository.baseRevision, fixture.acceptedA);
  assert.equal(provisioned.repository.headRevision, fixture.acceptedA);
  const trackedCommands = service.testState.gitChildCommands || [];
  assert.ok(trackedCommands.length >= 9);
  assert.ok(trackedCommands.some(({ commandId }) => commandId === "story.init"));
  assert.ok(trackedCommands.some(({ commandId }) => commandId === "story.copy-exact-sha"));
  assert.ok(trackedCommands.some(({ commandId }) => commandId === "story.create-branch"));
  assert.ok(trackedCommands.some(({ commandId }) => commandId === "story.checkout"));
  assert.ok(trackedCommands.some(({ commandId }) => commandId === "story.metadata-config"));
  assert.ok(trackedCommands.some(({ commandId }) => commandId === "story.metadata-base-ref"));
  assert.ok(trackedCommands.every(({ phases }) => (
    phases.join(">") === "SPAWNING>RUNNING>CLEARED"
  )));

  const deepStoryFile = path.join(
    provisioned.repository.repositoryPath,
    fixture.deepRelativePath,
  );
  if (process.platform === "win32") {
    assert.ok(
      deepStoryFile.length >= 260,
      `expected a Windows long path, got ${deepStoryFile.length}`,
    );
  }
  assert.equal(fs.readFileSync(deepStoryFile, "utf8"), "deep tracked content\n");

  const inspected = await service.inspect({
    tabId: "story-controller",
    repositoryId: "repository-main",
  });
  assert.equal(inspected.repositoryPath, provisioned.repository.repositoryPath);
  assert.equal(inspected.baseRevision, fixture.acceptedA);
  assert.equal(inspected.headRevision, fixture.acceptedA);

  const preview = await service.retirePreview({
    tabId: "story-controller",
    repositoryId: "repository-main",
  });
  assert.equal(preview.safe, true);
  assert.equal(preview.forceAllowed, true);
  const retired = await service.retire({
    tabId: "story-controller",
    repositoryId: "repository-main",
    previewId: preview.previewId,
    previewVersion: preview.previewVersion,
    expectedHead: preview.headRevision,
    registryGeneration: preview.entryGeneration,
    force: false,
    idempotencyKey: "retire-deep-path-main",
  });
  assert.equal(retired.removed, true);
  assert.equal(fs.existsSync(provisioned.repository.repositoryPath), false);
});
