import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "git-controller-mirror-"));
process.env.GATEWAY_DB_PATH = path.join(root, "gateway.db");

const {
  controllerAcceptedHistoryRef,
  controllerAcceptedRef,
  createGitController,
  processStartIdentity,
  runGitFile,
} = await import("../services/devbench/git-controller/index.js");
const persistence = await import("../db/sqlite.js");
const RECOVERY_PROCESS_IDENTITY_PROBE = () => "windows-start:999999999999999999";
const ACTIVE_PROCESS_START_IDENTITY = processStartIdentity(process.pid);
const ACTIVE_PROCESS_IDENTITY_PROBE = (pid) => (
  Number(pid) === process.pid
    ? ACTIVE_PROCESS_START_IDENTITY
    : "windows-start:222222222222222222"
);

after(() => {
  persistence.default.close();
  const resolved = path.resolve(root);
  if (resolved.startsWith(path.resolve(os.tmpdir()) + path.sep)) {
    fs.rmSync(resolved, { recursive: true, force: true });
  }
});

function git(args, cwd = root) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    windowsHide: true,
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: "0",
      GCM_INTERACTIVE: "Never",
    },
  }).trim();
}

function createFixture(label) {
  const fixtureRoot = path.join(root, label);
  fs.mkdirSync(fixtureRoot);
  const remote = path.join(fixtureRoot, "remote.git");
  git(["init", "--bare", remote]);
  const seed = path.join(fixtureRoot, "seed");
  fs.mkdirSync(seed);
  git(["init"], seed);
  git(["config", "user.name", "Controller Test"], seed);
  git(["config", "user.email", "controller@example.test"], seed);
  git(["checkout", "-b", "main"], seed);
  fs.writeFileSync(path.join(seed, "README.md"), "initial\n");
  git(["add", "README.md"], seed);
  git(["commit", "-m", "initial"], seed);
  const initialSha = git(["rev-parse", "HEAD"], seed);
  git(["remote", "add", "origin", remote], seed);
  git(["push", "-u", "origin", "main"], seed);
  const base = path.join(fixtureRoot, "base");
  git(["clone", "--branch", "main", remote, base]);
  git(["config", "user.name", "Controller Test"], base);
  git(["config", "user.email", "controller@example.test"], base);
  const dataRoot = path.join(fixtureRoot, "data");
  fs.mkdirSync(dataRoot);
  return { fixtureRoot, remote, seed, base, dataRoot, initialSha };
}

async function makeController(fixture, commandLog = [], options = {}) {
  const gitRunner = async (options) => {
    commandLog.push({
      commandId: options.commandId,
      args: [...(options.args || [])],
      childTracked: !!options.childLifecycle,
    });
    return runGitFile(options);
  };
  const controller = await createGitController({
    dataRoot: fixture.dataRoot,
    definitions: [{
      logicalDefinitionId: `logical-${path.basename(fixture.fixtureRoot)}`,
      displayName: "Mirror test",
      basePath: fixture.base,
      remoteId: "origin",
      expectedRemoteUrls: [fixture.remote],
      allowedBranches: ["main"],
      publicationPolicy: options.publicationPolicy,
    }],
    gitRunner,
    mirrorFaultInjector: options.mirrorFaultInjector,
    leaseProcessIdentityProbe: options.leaseProcessIdentityProbe
      || ACTIVE_PROCESS_IDENTITY_PROBE,
    leaseTtlMs: 20_000,
  });
  return { controller, entry: controller.registry.list()[0] };
}

function advance(seed, file, content, message) {
  fs.writeFileSync(path.join(seed, file), content);
  git(["add", file], seed);
  git(["commit", "-m", message], seed);
  git(["push", "origin", "main"], seed);
  return git(["rev-parse", "HEAD"], seed);
}

async function executePreview(
  controller,
  preview,
  idempotencyKey = randomUUID(),
  additional = {},
) {
  return controller.mirror.execute({
    repositoryId: preview.repositoryId,
    branch: preview.branch,
    previewId: preview.previewId,
    previewVersion: preview.previewVersion,
    expectedAcceptedSha: preview.lastAcceptedSha,
    candidateSha: preview.candidateSha,
    idempotencyKey,
    ...additional,
  });
}

function administrativeApproval(preview, actor = "administrator:test") {
  const approvedAt = Date.now();
  return {
    actor,
    adminApprovalId: randomUUID(),
    adminApprovedAt: approvedAt,
    adminApprovalExpiresAt: approvedAt + 5 * 60_000,
    adminApprovedRelationship: preview.relationship,
    adminApprovedBy: actor,
    adminApprovedPreviewId: preview.previewId,
    adminApprovedPreviewVersion: preview.previewVersion,
    adminApprovedPreviousSha: preview.lastAcceptedSha || "",
    adminApprovedCandidateSha: preview.candidateSha,
    adminApprovedImpactDigest: preview.rewriteImpact?.digest || "",
  };
}

function enableRewriteApprovalEvidence(controller, stories = [], publishedCommits = []) {
  controller.mirror.setStoryBaseRetentionProvider(async () => stories);
  controller.mirror.setRewritePublicationProvider(async () => ({
    status: publishedCommits.length ? "PRESENT" : "NONE",
    publishedCommits,
    truncated: false,
    evidenceId: "test-publication-ledger",
    evidenceDigest: createHash("sha256")
      .update(JSON.stringify([...publishedCommits].sort()))
      .digest("hex"),
  }));
}

test("sync status is attested by the Controller that owns the mirror path", async () => {
  const fixture = createFixture("verified-sync-status");
  const { controller, entry } = await makeController(fixture);

  const before = await controller.syncStatus({
    repositoryId: entry.repositoryId,
    branch: "main",
  });
  assert.equal(before.mirrorPresent, false);
  assert.equal(before.mirrorStatus, "NOT_INITIALIZED");

  const preview = await controller.mirror.preview({
    repositoryId: entry.repositoryId,
    branch: "main",
  });
  await executePreview(controller, preview);
  const healthy = await controller.syncStatus({
    repositoryId: entry.repositoryId,
    branch: "main",
  });
  assert.equal(healthy.mirrorPresent, true);
  assert.equal(healthy.mirrorStatus, "HEALTHY");

  fs.rmSync(entry.mirrorPath, { recursive: true });
  const missing = await controller.syncStatus({
    repositoryId: entry.repositoryId,
    branch: "main",
  });
  assert.equal(missing.mirrorPresent, false);
  assert.equal(missing.mirrorStatus, "RECOVERY_REQUIRED");
});

test("mirror publishes incoming only after connectivity, second-tip and accepted CAS checks", async () => {
  const fixture = createFixture("publish");
  const commands = [];
  const { controller, entry } = await makeController(fixture, commands);
  const preview = await controller.mirror.preview({
    repositoryId: entry.repositoryId,
    branch: "main",
  });
  assert.equal(preview.lastAcceptedSha, null);
  assert.equal(preview.candidateSha, fixture.initialSha);
  assert.equal(preview.eligible, true);

  const idempotencyKey = randomUUID();
  const result = await executePreview(controller, preview, idempotencyKey);
  assert.equal(result.ok, true);
  assert.equal(result.previousSha, null);
  assert.equal(result.candidateSha, fixture.initialSha);
  assert.equal(result.generation, 1);
  assert.equal(result.relationship, "FAST_FORWARD");
  assert.equal(
    git(["--git-dir", entry.mirrorPath, "rev-parse", controllerAcceptedRef("origin", "main")]),
    fixture.initialSha,
  );
  assert.equal(
    git(["--git-dir", entry.mirrorPath, "for-each-ref", "--format=%(refname)", "refs/devbench/incoming"]),
    "",
  );
  assert.ok(commands.some((item) => item.commandId === "mirror.fsck-candidate"));
  assert.ok(commands.filter((item) => item.commandId === "mirror.remote-tip").length >= 2);
  assert.ok(commands.some((item) => (
    item.commandId === "mirror.fetch-incoming"
    && item.args.includes("--atomic")
    && item.args.includes("--no-tags")
    && item.args.includes("--no-auto-maintenance")
  )));
  const mutations = commands.filter((item) => (
    ["init", "fetch", "update-ref", "gc"].some((command) => item.args.includes(command))
  ));
  assert.ok(mutations.length >= 6);
  assert.equal(
    mutations.every((item) => item.childTracked),
    true,
    `untracked mutations: ${
      mutations.filter((item) => !item.childTracked).map((item) => item.commandId).join(",")
    }`,
  );

  const journal = persistence.listGitControllerJournal(result.operationId);
  assert.deepEqual(
    journal.map((item) => item.phase),
    [
      "PREVIEWED",
      "MIRROR_FETCHING",
      "MIRROR_PUBLISHING",
      "MIRROR_RETENTION_VERIFIED",
      "MIRROR_ACCEPTED",
      "MIRROR_MAINTENANCE_RUNNING",
      "MIRROR_MAINTENANCE_VERIFIED",
      "VERIFIED",
    ],
  );
  assert.equal(persistence.listGitControllerAudit({ operationId: result.operationId }).length, 1);

  const replay = await executePreview(controller, preview, idempotencyKey);
  assert.equal(replay.operationId, result.operationId);
  assert.equal(replay.replayed, true);
  assert.equal(replay.generation, 1);
  await assert.rejects(
    controller.mirror.execute({
      repositoryId: preview.repositoryId,
      branch: preview.branch,
      previewId: preview.previewId,
      previewVersion: preview.previewVersion,
      expectedAcceptedSha: preview.lastAcceptedSha,
      candidateSha: "0".repeat(40),
      idempotencyKey,
    }),
    (error) => error.code === "GIT_CONTROLLER_IDEMPOTENCY_CONFLICT",
  );
});

test("foreground auto-GC remains inside the same repository lease used by fetch and clone", async () => {
  const fixture = createFixture("maintenance-lease");
  const commands = [];
  let releaseMaintenance;
  let markMaintenanceEntered;
  const maintenanceEntered = new Promise((resolve) => {
    markMaintenanceEntered = resolve;
  });
  const maintenanceRelease = new Promise((resolve) => {
    releaseMaintenance = resolve;
  });
  const { controller, entry } = await makeController(fixture, commands, {
    async mirrorFaultInjector(phase) {
      if (phase !== "before-mirror-maintenance") return;
      markMaintenanceEntered();
      await maintenanceRelease;
    },
  });
  const preview = await controller.mirror.preview({
    repositoryId: entry.repositoryId,
    branch: "main",
  });
  const executing = executePreview(controller, preview, "maintenance-lease-execute");
  await maintenanceEntered;

  const activeLease = persistence.getGitControllerRepositoryLease(entry.repositoryId);
  assert.equal(activeLease.kind, "mirror-refresh");
  assert.throws(
    () => controller.leaseManager.acquire(entry, {
      operationId: "simulated-story-clone",
      kind: "story-repository-provision",
    }),
    (error) => error.code === "GIT_CONTROLLER_REPOSITORY_BUSY",
    "mirror maintenance must exclude the story clone lease",
  );

  releaseMaintenance();
  const result = await executing;
  assert.equal(result.maintenance.attempted, true);
  assert.equal(result.maintenance.mode, "foreground-auto-gc");
  assert.equal(result.maintenance.foreground, true);
  assert.equal(result.maintenance.leaseFencingToken, activeLease.fencingToken);
  assert.equal(result.maintenance.verified, true);
  assert.equal(result.maintenance.storyRetentions, null);
  assert.equal(result.maintenance.acceptedHistory.sha, fixture.initialSha);
  assert.equal(
    result.maintenance.acceptedHistory.refName,
    controllerAcceptedHistoryRef("origin", "main", 1),
  );
  const maintenanceCommand = commands.find(
    (item) => item.commandId === "mirror.maintenance-auto-gc",
  );
  assert.ok(maintenanceCommand);
  assert.ok(maintenanceCommand.args.includes("gc.autoDetach=false"));
  assert.ok(maintenanceCommand.args.includes("maintenance.autoDetach=false"));
  assert.equal(maintenanceCommand.args.includes("gc.auto=0"), false);
  assert.equal(maintenanceCommand.args.includes("maintenance.auto=false"), false);
  assert.deepEqual(maintenanceCommand.args.slice(-2), ["gc", "--auto"]);
  assert.equal(
    commands.filter((item) => item.commandId === "mirror.maintenance-fsck").length,
    1,
  );
  assert.equal(
    persistence.getGitControllerRepositoryLease(entry.repositoryId),
    null,
  );
});

test("startup resumes a crash during lease-fenced mirror maintenance", async () => {
  const fixture = createFixture("maintenance-crash-recovery");
  const crash = Object.assign(new Error("simulated maintenance crash"), {
    simulateProcessCrash: true,
  });
  const first = await makeController(fixture, [], {
    mirrorFaultInjector(phase) {
      if (phase === "before-mirror-maintenance") throw crash;
    },
  });
  const preview = await first.controller.mirror.preview({
    repositoryId: first.entry.repositoryId,
    branch: "main",
  });
  await assert.rejects(
    executePreview(first.controller, preview, "crash-during-maintenance"),
    (error) => error === crash,
  );
  const interrupted = persistence.getGitControllerOperationByIdempotency(
    first.entry.repositoryId,
    "MIRROR_REFRESH",
    "crash-during-maintenance",
  );
  assert.equal(interrupted.status, "RUNNING");
  assert.equal(interrupted.phase, "MIRROR_MAINTENANCE_RUNNING");

  await assert.rejects(
    makeController(fixture),
    (error) => error.code === "GIT_CONTROLLER_MIRROR_RECOVERY_BLOCKED",
  );
  const restarted = await makeController(fixture, [], {
    leaseProcessIdentityProbe: RECOVERY_PROCESS_IDENTITY_PROBE,
  });
  const recovered = persistence.getGitControllerOperation(interrupted.operationId);
  assert.equal(recovered.status, "SUCCEEDED");
  assert.equal(recovered.result.recovered, true);
  assert.equal(recovered.result.maintenance.verified, true);
  assert.equal(
    git([
      "--git-dir",
      restarted.entry.mirrorPath,
      "rev-parse",
      controllerAcceptedRef("origin", "main"),
    ]),
    fixture.initialSha,
  );
});

test("startup recovers crash after accepted ref publication before durable mirror CAS", async () => {
  const fixture = createFixture("publish-crash-recovery");
  const crash = Object.assign(new Error("simulated process crash"), {
    simulateProcessCrash: true,
  });
  const first = await makeController(fixture, [], {
    mirrorFaultInjector(phase) {
      if (phase === "after-accepted-ref-publish") throw crash;
    },
  });
  const preview = await first.controller.mirror.preview({
    repositoryId: first.entry.repositoryId,
    branch: "main",
  });
  await assert.rejects(
    executePreview(first.controller, preview, "crash-after-ref"),
    (error) => error === crash,
  );
  assert.equal(
    git([
      "--git-dir",
      first.entry.mirrorPath,
      "rev-parse",
      controllerAcceptedRef("origin", "main"),
    ]),
    fixture.initialSha,
  );
  assert.equal(
    persistence.getGitControllerMirrorState(first.entry.repositoryId, "origin", "main"),
    null,
  );
  const interrupted = persistence.getGitControllerOperationByIdempotency(
    first.entry.repositoryId,
    "MIRROR_REFRESH",
    "crash-after-ref",
  );
  assert.equal(interrupted.status, "RUNNING");
  assert.equal(interrupted.phase, "MIRROR_RETENTION_VERIFIED");

  await assert.rejects(
    makeController(fixture),
    (error) => error.code === "GIT_CONTROLLER_MIRROR_RECOVERY_BLOCKED",
  );
  assert.equal(
    persistence.getGitControllerOperation(interrupted.operationId).status,
    "RUNNING",
  );
  const recoveryCommands = [];
  const restarted = await makeController(fixture, recoveryCommands, {
    leaseProcessIdentityProbe: RECOVERY_PROCESS_IDENTITY_PROBE,
  });
  const state = persistence.getGitControllerMirrorState(
    restarted.entry.repositoryId,
    "origin",
    "main",
  );
  assert.equal(state.acceptedSha, fixture.initialSha);
  const recovered = persistence.getGitControllerOperation(interrupted.operationId);
  assert.equal(recovered.status, "SUCCEEDED");
  assert.equal(recovered.result.recovered, true);
  const recoveryPassAudits = persistence.listGitControllerAudit({
    operationId: interrupted.operationId,
  }).filter((row) => (
    row.action === "mirror.accepted.publish"
    && row.result === "PASS"
  ));
  assert.equal(recoveryPassAudits.length, 1);
  assert.equal(recoveryPassAudits[0].beforeSha, null);
  assert.equal(recoveryPassAudits[0].candidateSha, fixture.initialSha);
  assert.equal(recoveryPassAudits[0].reason, "startup-recovery");
  assert.equal(
    recoveryCommands.some((item) => (
      String(item.commandId || "")
        .startsWith("mirror.recovery-cleanup-unpublished-history.")
    )),
    false,
  );
  const reclaimAudits = persistence.listGitControllerAudit({
    operationId: interrupted.operationId,
  }).filter((row) => (
    row.action === "git-controller.operation.recover-orphan"
    && row.result === "PASS"
  ));
  assert.equal(reclaimAudits.length, 1);
  assert.equal(reclaimAudits[0].reason, "owner_pid_reused");
  assert.equal(
    (await executePreview(restarted.controller, preview, "crash-after-ref")).replayed,
    true,
  );
  assert.equal(
    persistence.listGitControllerAudit({
      operationId: interrupted.operationId,
    }).filter((row) => (
      row.action === "mirror.accepted.publish"
      && row.result === "PASS"
    )).length,
    1,
  );
  assert.equal(
    persistence.listGitControllerAudit({
      operationId: interrupted.operationId,
    }).filter((row) => (
      row.action === "git-controller.operation.recover-orphan"
      && row.result === "PASS"
    )).length,
    1,
  );
});

test("startup recognizes an UNCHANGED publication committed before MIRROR_ACCEPTED", async () => {
  const fixture = createFixture("unchanged-state-crash");
  const crash = Object.assign(new Error("simulated process crash"), {
    simulateProcessCrash: true,
  });
  let crashEnabled = false;
  const first = await makeController(fixture, [], {
    mirrorFaultInjector(phase) {
      if (crashEnabled && phase === "after-mirror-state-cas") throw crash;
    },
  });
  const initial = await first.controller.mirror.preview({
    repositoryId: first.entry.repositoryId,
    branch: "main",
  });
  const initialResult = await executePreview(first.controller, initial);
  assert.equal(initialResult.generation, 1);

  const unchanged = await first.controller.mirror.preview({
    repositoryId: first.entry.repositoryId,
    branch: "main",
  });
  assert.equal(unchanged.relationship, "UNCHANGED");
  assert.equal(unchanged.lastAcceptedSha, fixture.initialSha);
  assert.equal(unchanged.candidateSha, fixture.initialSha);
  assert.equal(unchanged.mirrorGeneration, 1);

  crashEnabled = true;
  await assert.rejects(
    executePreview(first.controller, unchanged, "unchanged-after-state-cas"),
    (error) => error === crash,
  );
  const interrupted = persistence.getGitControllerOperationByIdempotency(
    first.entry.repositoryId,
    "MIRROR_REFRESH",
    "unchanged-after-state-cas",
  );
  assert.equal(interrupted.status, "RUNNING");
  assert.equal(interrupted.phase, "MIRROR_RETENTION_VERIFIED");
  const committedState = persistence.getGitControllerMirrorState(
    first.entry.repositoryId,
    "origin",
    "main",
  );
  assert.equal(committedState.acceptedSha, fixture.initialSha);
  assert.equal(committedState.generation, 2);
  assert.equal(committedState.operationId, interrupted.operationId);

  const restarted = await makeController(fixture, [], {
    leaseProcessIdentityProbe: RECOVERY_PROCESS_IDENTITY_PROBE,
  });
  const recovered = persistence.getGitControllerOperation(interrupted.operationId);
  assert.equal(recovered.status, "SUCCEEDED");
  assert.equal(recovered.result.recovered, true);
  assert.equal(recovered.result.relationship, "UNCHANGED");
  assert.equal(recovered.result.generation, 2);
  assert.equal(recovered.result.maintenance.verified, true);
  assert.equal(
    git([
      "--git-dir",
      restarted.entry.mirrorPath,
      "rev-parse",
      controllerAcceptedHistoryRef("origin", "main", 2),
    ]),
    fixture.initialSha,
  );
  assert.equal(
    (await executePreview(
      restarted.controller,
      unchanged,
      "unchanged-after-state-cas",
    )).replayed,
    true,
  );
});

test("startup deletes only the exact unpublished accepted-history generation before the next refresh", async () => {
  const fixture = createFixture("accepted-history-crash-recovery");
  const crash = Object.assign(new Error("simulated process crash"), {
    simulateProcessCrash: true,
  });
  let crashEnabled = false;
  const first = await makeController(fixture, [], {
    mirrorFaultInjector(phase) {
      if (crashEnabled && phase === "after-accepted-history-publish") throw crash;
    },
  });
  const initial = await first.controller.mirror.preview({
    repositoryId: first.entry.repositoryId,
    branch: "main",
  });
  await executePreview(first.controller, initial);
  assert.equal(
    git([
      "--git-dir",
      first.entry.mirrorPath,
      "rev-parse",
      controllerAcceptedHistoryRef("origin", "main", 1),
    ]),
    fixture.initialSha,
  );

  const abandonedCandidate = advance(
    fixture.seed,
    "abandoned-candidate.txt",
    "candidate B\n",
    "candidate B",
  );
  const abandonedPreview = await first.controller.mirror.preview({
    repositoryId: first.entry.repositoryId,
    branch: "main",
  });
  crashEnabled = true;
  await assert.rejects(
    executePreview(first.controller, abandonedPreview, "crash-after-history"),
    (error) => error === crash,
  );
  assert.equal(
    git([
      "--git-dir",
      first.entry.mirrorPath,
      "rev-parse",
      controllerAcceptedHistoryRef("origin", "main", 2),
    ]),
    abandonedCandidate,
  );
  assert.equal(
    git([
      "--git-dir",
      first.entry.mirrorPath,
      "rev-parse",
      controllerAcceptedRef("origin", "main"),
    ]),
    fixture.initialSha,
  );
  const interrupted = persistence.getGitControllerOperationByIdempotency(
    first.entry.repositoryId,
    "MIRROR_REFRESH",
    "crash-after-history",
  );
  assert.equal(interrupted.status, "RUNNING");
  assert.equal(interrupted.phase, "MIRROR_PUBLISHING");

  const restarted = await makeController(fixture, [], {
    leaseProcessIdentityProbe: RECOVERY_PROCESS_IDENTITY_PROBE,
  });
  const recovered = persistence.getGitControllerOperation(interrupted.operationId);
  assert.equal(recovered.status, "FAILED");
  assert.equal(recovered.resultCode, "GIT_CONTROLLER_INTERRUPTED_BEFORE_REF_SWAP");
  assert.equal(
    git([
      "--git-dir",
      restarted.entry.mirrorPath,
      "for-each-ref",
      "--format=%(refname)",
      controllerAcceptedHistoryRef("origin", "main", 2),
    ]),
    "",
  );
  assert.equal(
    git([
      "--git-dir",
      restarted.entry.mirrorPath,
      "rev-parse",
      controllerAcceptedHistoryRef("origin", "main", 1),
    ]),
    fixture.initialSha,
  );

  const nextCandidate = advance(
    fixture.seed,
    "next-candidate.txt",
    "candidate C\n",
    "candidate C",
  );
  const nextPreview = await restarted.controller.mirror.preview({
    repositoryId: restarted.entry.repositoryId,
    branch: "main",
  });
  const accepted = await executePreview(
    restarted.controller,
    nextPreview,
    "retry-after-history-recovery",
  );
  assert.equal(accepted.generation, 2);
  assert.equal(accepted.candidateSha, nextCandidate);
  assert.equal(
    git([
      "--git-dir",
      restarted.entry.mirrorPath,
      "rev-parse",
      controllerAcceptedHistoryRef("origin", "main", 2),
    ]),
    nextCandidate,
  );
});

test("startup recovers legacy retention phase without a publishing checkpoint", async () => {
  const fixture = createFixture("legacy-history");
  const crash = Object.assign(new Error("simulated legacy process crash"), {
    simulateProcessCrash: true,
  });
  const commands = [];
  const first = await makeController(fixture, commands);

  const initial = await first.controller.mirror.preview({
    repositoryId: first.entry.repositoryId,
    branch: "main",
  });
  await executePreview(first.controller, initial);

  const abandonedCandidate = advance(
    fixture.seed,
    "legacy-abandoned.txt",
    "candidate B\n",
    "legacy candidate B",
  );
  const abandonedPreview = await first.controller.mirror.preview({
    repositoryId: first.entry.repositoryId,
    branch: "main",
  });
  assert.equal(abandonedPreview.mirrorGeneration, 1);

  // Reproduce the previous binary's order without mutating SQLite directly:
  // accepted-history -> MIRROR_RETENTION_VERIFIED -> MIRROR_PUBLISHING.
  // The legacy crash leaves the first two effects but no publishing checkpoint.
  const originalAppend = first.controller.journal.append;
  first.controller.journal.append = function legacyAppend(operation, phase, ...args) {
    if (phase === "MIRROR_PUBLISHING") {
      return persistence.getGitControllerOperation(operation.operationId);
    }
    const appended = originalAppend.call(this, operation, phase, ...args);
    if (phase === "MIRROR_RETENTION_VERIFIED") throw crash;
    return appended;
  };
  try {
    await assert.rejects(
      executePreview(
        first.controller,
        abandonedPreview,
        "legacy-no-publishing-checkpoint",
      ),
      (error) => error === crash,
    );
  } finally {
    first.controller.journal.append = originalAppend;
  }

  const interrupted = persistence.getGitControllerOperationByIdempotency(
    first.entry.repositoryId,
    "MIRROR_REFRESH",
    "legacy-no-publishing-checkpoint",
  );
  assert.equal(interrupted.status, "RUNNING");
  assert.equal(interrupted.phase, "MIRROR_RETENTION_VERIFIED");
  assert.equal(
    persistence.listGitControllerJournal(interrupted.operationId)
      .some((row) => row.phase === "MIRROR_PUBLISHING"),
    false,
  );
  const generationTwoRef = controllerAcceptedHistoryRef("origin", "main", 2);
  const retainedThroughController = await first.controller.mirror.run(
    first.entry,
    first.controller.mirror.mirrorArgs(first.entry, [
      "rev-parse",
      "--verify",
      `${generationTwoRef}^{commit}`,
    ]),
    { commandId: "test.legacy-retained-history" },
  );
  assert.equal(
    retainedThroughController.stdout.trim(),
    abandonedCandidate,
    `legacy fixture commands: ${
      commands
        .filter((item) => String(item.commandId || "").includes("accepted-history"))
        .map((item) => item.commandId)
        .join(",")
    }`,
  );
  assert.equal(
    git([
      "--git-dir",
      first.entry.mirrorPath,
      "rev-parse",
      controllerAcceptedRef("origin", "main"),
    ]),
    fixture.initialSha,
  );

  const restarted = await makeController(fixture, [], {
    leaseProcessIdentityProbe: RECOVERY_PROCESS_IDENTITY_PROBE,
  });
  const recovered = persistence.getGitControllerOperation(interrupted.operationId);
  assert.equal(recovered.status, "FAILED");
  assert.equal(
    recovered.resultCode,
    "GIT_CONTROLLER_INTERRUPTED_BEFORE_PUBLICATION",
  );
  const failedJournal = persistence
    .listGitControllerJournal(interrupted.operationId)
    .findLast((row) => row.phase === "FAILED");
  assert.equal(failedJournal.data.historyCleanup.status, "DELETED");
  assert.equal(failedJournal.data.historyCleanup.sha, abandonedCandidate);
  assert.equal(
    git([
      "--git-dir",
      restarted.entry.mirrorPath,
      "for-each-ref",
      "--format=%(refname)",
      generationTwoRef,
    ]),
    "",
  );
  assert.equal(
    git([
      "--git-dir",
      restarted.entry.mirrorPath,
      "rev-parse",
      controllerAcceptedHistoryRef("origin", "main", 1),
    ]),
    fixture.initialSha,
  );

  const nextCandidate = advance(
    fixture.seed,
    "legacy-next.txt",
    "candidate C\n",
    "legacy candidate C",
  );
  const nextPreview = await restarted.controller.mirror.preview({
    repositoryId: restarted.entry.repositoryId,
    branch: "main",
  });
  const accepted = await executePreview(
    restarted.controller,
    nextPreview,
    "legacy-retry-after-cleanup",
  );
  assert.equal(accepted.generation, 2);
  assert.equal(accepted.candidateSha, nextCandidate);
  assert.equal(
    git([
      "--git-dir",
      restarted.entry.mirrorPath,
      "rev-parse",
      generationTwoRef,
    ]),
    nextCandidate,
  );
});

test("mirror accepts a fast-forward and rejects stale preview generation", async () => {
  const fixture = createFixture("fast-forward");
  const { controller, entry } = await makeController(fixture);
  const initial = await controller.mirror.preview({
    repositoryId: entry.repositoryId,
    branch: "main",
  });
  await executePreview(controller, initial);
  const forwardSha = advance(fixture.seed, "forward.txt", "forward\n", "forward");
  const first = await controller.mirror.preview({
    repositoryId: entry.repositoryId,
    branch: "main",
  });
  const stale = await controller.mirror.preview({
    repositoryId: entry.repositoryId,
    branch: "main",
  });
  const accepted = await executePreview(controller, first);
  assert.equal(accepted.previousSha, fixture.initialSha);
  assert.equal(accepted.candidateSha, forwardSha);
  assert.equal(accepted.relationship, "FAST_FORWARD");
  assert.equal(accepted.generation, 2);
  assert.equal(
    git([
      "--git-dir",
      entry.mirrorPath,
      "rev-parse",
      controllerAcceptedHistoryRef("origin", "main", 1),
    ]),
    fixture.initialSha,
  );
  assert.equal(
    git([
      "--git-dir",
      entry.mirrorPath,
      "rev-parse",
      controllerAcceptedHistoryRef("origin", "main", 2),
    ]),
    forwardSha,
  );

  await assert.rejects(
    executePreview(controller, stale),
    (error) => error.code === "GIT_CONTROLLER_PREVIEW_STALE",
  );
  const state = persistence.getGitControllerMirrorState(entry.repositoryId, "origin", "main");
  assert.equal(state.acceptedSha, forwardSha);
  assert.equal(state.generation, 2);
});

test("mirror rejects a remote tip that changes after preview without moving accepted", async () => {
  const fixture = createFixture("tip-change");
  const { controller, entry } = await makeController(fixture);
  const initial = await controller.mirror.preview({
    repositoryId: entry.repositoryId,
    branch: "main",
  });
  await executePreview(controller, initial);
  const stalePreview = await controller.mirror.preview({
    repositoryId: entry.repositoryId,
    branch: "main",
  });
  advance(fixture.seed, "changed.txt", "changed\n", "changed after preview");

  await assert.rejects(
    executePreview(controller, stalePreview),
    (error) => error.code === "GIT_CONTROLLER_REMOTE_CHANGED",
  );
  assert.equal(
    git(["--git-dir", entry.mirrorPath, "rev-parse", controllerAcceptedRef("origin", "main")]),
    fixture.initialSha,
  );
  assert.equal(
    git(["--git-dir", entry.mirrorPath, "for-each-ref", "--format=%(refname)", "refs/devbench/incoming"]),
    "",
  );
});

test("mirror blocks both remote rewind and divergent force-push by default", async () => {
  const fixture = createFixture("history-rewrite");
  const { controller, entry } = await makeController(fixture);
  const initial = await controller.mirror.preview({
    repositoryId: entry.repositoryId,
    branch: "main",
  });
  await executePreview(controller, initial);
  const acceptedSha = advance(fixture.seed, "accepted.txt", "accepted\n", "accepted forward");
  const forward = await controller.mirror.preview({
    repositoryId: entry.repositoryId,
    branch: "main",
  });
  await executePreview(controller, forward);

  git(["reset", "--hard", fixture.initialSha], fixture.seed);
  git(["push", "--force", "origin", "main"], fixture.seed);
  const rewind = await controller.mirror.preview({
    repositoryId: entry.repositoryId,
    branch: "main",
  });
  assert.equal(rewind.relationship, "REMOTE_REWIND");
  assert.equal(rewind.eligible, false);
  await assert.rejects(
    executePreview(controller, rewind),
    (error) => error.code === "GIT_CONTROLLER_REMOTE_HISTORY_IMPACT_UNKNOWN",
  );
  assert.equal(rewind.rewriteImpact.previousSha, acceptedSha);
  assert.equal(rewind.rewriteImpact.candidateSha, fixture.initialSha);
  assert.equal(rewind.rewriteImpact.publishedCommitStatus, "UNKNOWN");
  assert.equal(rewind.rewriteImpact.approvalAllowed, false);
  assert.equal(
    git(["--git-dir", entry.mirrorPath, "rev-parse", controllerAcceptedRef("origin", "main")]),
    acceptedSha,
  );

  fs.writeFileSync(path.join(fixture.seed, "diverged.txt"), "diverged\n");
  git(["add", "diverged.txt"], fixture.seed);
  git(["commit", "-m", "divergent history"], fixture.seed);
  const divergentSha = git(["rev-parse", "HEAD"], fixture.seed);
  git(["push", "--force", "origin", "main"], fixture.seed);
  const divergent = await controller.mirror.preview({
    repositoryId: entry.repositoryId,
    branch: "main",
  });
  assert.equal(divergent.candidateSha, divergentSha);
  await assert.rejects(
    executePreview(controller, divergent),
    (error) => error.code === "GIT_CONTROLLER_REMOTE_HISTORY_IMPACT_UNKNOWN",
  );
  assert.equal(
    git(["--git-dir", entry.mirrorPath, "rev-parse", controllerAcceptedRef("origin", "main")]),
    acceptedSha,
  );
});

test("protected exact-SHA publication ledger is wired by the production Controller", async () => {
  const fixture = createFixture("rewrite-protected-publication-ledger");
  const forwardSha = advance(
    fixture.seed,
    "published.txt",
    "published\n",
    "published forward",
  );
  const publicationPolicy = {
    schemaVersion: 1,
    mode: "PROTECTED_EXACT_SHA_POSITIVE_LEDGER",
    evidenceId: "release-ledger:mirror-test",
    publishedCommitShas: [forwardSha],
  };
  const { controller, entry } = await makeController(fixture, [], { publicationPolicy });
  controller.mirror.setStoryBaseRetentionProvider(async () => []);

  const initial = await controller.mirror.preview({
    repositoryId: entry.repositoryId,
    branch: "main",
  });
  await executePreview(controller, initial);

  git(["reset", "--hard", fixture.initialSha], fixture.seed);
  git(["push", "--force", "origin", "main"], fixture.seed);
  const rewind = await controller.mirror.preview({
    repositoryId: entry.repositoryId,
    branch: "main",
  });

  assert.equal(rewind.relationship, "REMOTE_REWIND");
  assert.deepEqual(rewind.rewriteImpact.droppedCommits, [forwardSha]);
  assert.equal(rewind.rewriteImpact.publishedCommitStatus, "PRESENT");
  assert.deepEqual(rewind.rewriteImpact.publishedCommits, [forwardSha]);
  assert.equal(
    rewind.rewriteImpact.publicationEvidenceId,
    publicationPolicy.evidenceId,
  );
  assert.equal(
    rewind.rewriteImpact.publicationEvidenceDigest,
    entry.publicationPolicy.evidenceDigest,
  );
  assert.equal(rewind.rewriteImpact.approvalAllowed, true);

  const result = await executePreview(
    controller,
    rewind,
    randomUUID(),
    administrativeApproval(rewind),
  );
  assert.equal(result.relationship, "REMOTE_REWIND");
  assert.equal(result.candidateSha, fixture.initialSha);
});

test("protected positive publication ledger never treats absence as authoritative NONE", async () => {
  const fixture = createFixture("rewrite-publication-absence-unknown");
  const forwardSha = advance(
    fixture.seed,
    "unlisted.txt",
    "unlisted\n",
    "unlisted forward",
  );
  const { controller, entry } = await makeController(fixture, [], {
    publicationPolicy: {
      schemaVersion: 1,
      mode: "PROTECTED_EXACT_SHA_POSITIVE_LEDGER",
      evidenceId: "release-ledger:absence-test",
      publishedCommitShas: [],
    },
  });
  controller.mirror.setStoryBaseRetentionProvider(async () => []);
  const initial = await controller.mirror.preview({
    repositoryId: entry.repositoryId,
    branch: "main",
  });
  await executePreview(controller, initial);

  git(["reset", "--hard", fixture.initialSha], fixture.seed);
  git(["push", "--force", "origin", "main"], fixture.seed);
  const rewind = await controller.mirror.preview({
    repositoryId: entry.repositoryId,
    branch: "main",
  });

  assert.deepEqual(rewind.rewriteImpact.droppedCommits, [forwardSha]);
  assert.equal(rewind.rewriteImpact.publishedCommitStatus, "UNKNOWN");
  assert.deepEqual(rewind.rewriteImpact.publishedCommits, []);
  assert.equal(rewind.rewriteImpact.approvalAllowed, false);
  await assert.rejects(
    executePreview(
      controller,
      rewind,
      randomUUID(),
      administrativeApproval(rewind),
    ),
    (error) => error.code === "GIT_CONTROLLER_REMOTE_HISTORY_IMPACT_UNKNOWN",
  );
});

test("remote history rewrite requires one exact short-lived admin approval and retains every accepted generation", async () => {
  const fixture = createFixture("rewrite-admin");
  const { controller, entry } = await makeController(fixture);
  const initial = await controller.mirror.preview({
    repositoryId: entry.repositoryId,
    branch: "main",
  });
  await executePreview(controller, initial);
  const forwardSha = advance(fixture.seed, "forward.txt", "forward\n", "forward");
  const forward = await controller.mirror.preview({
    repositoryId: entry.repositoryId,
    branch: "main",
  });
  await executePreview(controller, forward);
  const retentionLease = controller.leaseManager.acquire(entry, {
    operationId: `story-retention-${randomUUID()}`,
    kind: "story-retention-test",
  });
  try {
    await controller.mirror.ensureStoryBaseRetention(entry, {
      storyId: "CARB-RETENTION",
      repositoryId: entry.repositoryId,
      baseRevision: forwardSha,
    }, retentionLease);
  } finally {
    retentionLease.release();
  }
  const publishedEvidence = [forwardSha];
  enableRewriteApprovalEvidence(controller, [{
    storyId: "CARB-RETENTION",
    repositoryId: entry.repositoryId,
    baseRevision: forwardSha,
    sourceRef: "refs/heads/main",
  }], publishedEvidence);

  git(["reset", "--hard", fixture.initialSha], fixture.seed);
  git(["push", "--force", "origin", "main"], fixture.seed);
  const rewind = await controller.mirror.preview({
    repositoryId: entry.repositoryId,
    branch: "main",
  });
  assert.equal(rewind.relationship, "REMOTE_REWIND");
  assert.equal(rewind.eligible, false);
  assert.equal(rewind.requiresAdminReview, true);
  assert.equal(rewind.rewriteImpact.previousSha, forwardSha);
  assert.equal(rewind.rewriteImpact.candidateSha, fixture.initialSha);
  assert.equal(rewind.rewriteImpact.droppedCommitCount, 1);
  assert.deepEqual(rewind.rewriteImpact.droppedCommits, [forwardSha]);
  assert.equal(rewind.rewriteImpact.droppedCommitsTruncated, false);
  assert.equal(rewind.rewriteImpact.affectedStoryStatus, "KNOWN");
  assert.equal(rewind.rewriteImpact.affectedStoryCount, 1);
  assert.deepEqual(rewind.rewriteImpact.affectedStories, [{
    storyId: "CARB-RETENTION",
    baseRevision: forwardSha,
  }]);
  assert.equal(rewind.rewriteImpact.publishedCommitStatus, "PRESENT");
  assert.deepEqual(rewind.rewriteImpact.publishedCommits, [forwardSha]);
  assert.equal(rewind.rewriteImpact.approvalAllowed, true);
  assert.match(rewind.rewriteImpact.digest, /^[0-9a-f]{64}$/);

  const mismatched = administrativeApproval(rewind);
  mismatched.adminApprovedCandidateSha = forwardSha;
  await assert.rejects(
    executePreview(controller, rewind, randomUUID(), mismatched),
    (error) => error.code === "GIT_CONTROLLER_REMOTE_HISTORY_ADMIN_APPROVAL_REQUIRED",
  );
  const digestMismatch = administrativeApproval(rewind);
  digestMismatch.adminApprovedImpactDigest = "0".repeat(64);
  await assert.rejects(
    executePreview(controller, rewind, randomUUID(), digestMismatch),
    (error) => error.code === "GIT_CONTROLLER_REMOTE_HISTORY_ADMIN_APPROVAL_REQUIRED",
  );
  publishedEvidence.length = 0;
  await assert.rejects(
    executePreview(
      controller,
      rewind,
      randomUUID(),
      administrativeApproval(rewind),
    ),
    (error) => error.code === "GIT_CONTROLLER_PREVIEW_STALE",
  );
  publishedEvidence.push(forwardSha);

  const refreshed = await controller.mirror.preview({
    repositoryId: entry.repositoryId,
    branch: "main",
  });
  const result = await executePreview(
    controller,
    refreshed,
    randomUUID(),
    administrativeApproval(refreshed),
  );
  assert.equal(result.relationship, "REMOTE_REWIND");
  assert.equal(result.candidateSha, fixture.initialSha);
  assert.equal(result.administrativeApproval.previousSha, forwardSha);
  assert.equal(result.administrativeApproval.candidateSha, fixture.initialSha);
  assert.equal(result.generation, 3);

  git(["--git-dir", entry.mirrorPath, "gc", "--prune=now"]);
  assert.equal(
    git([
      "--git-dir",
      entry.mirrorPath,
      "cat-file",
      "-t",
      forwardSha,
    ]),
    "commit",
  );
  assert.equal(
    git([
      "--git-dir",
      entry.mirrorPath,
      "rev-parse",
      controllerAcceptedHistoryRef("origin", "main", 2),
    ]),
    forwardSha,
  );
  assert.equal(
    git([
      "--git-dir",
      entry.mirrorPath,
      "rev-parse",
      controllerAcceptedHistoryRef("origin", "main", 3),
    ]),
    fixture.initialSha,
  );
  const retained = await controller.mirror.resolveRetainedStoryCandidate({
    repositoryId: entry.repositoryId,
    branch: "main",
    storyId: "CARB-RETENTION",
    candidateSha: forwardSha,
  });
  assert.equal(retained.candidateSha, forwardSha);
  assert.equal(
    git([
      "--git-dir",
      entry.mirrorPath,
      "rev-parse",
      retained.retentionRef,
    ]),
    forwardSha,
  );
  const releaseLease = controller.leaseManager.acquire(entry, {
    operationId: `story-retention-release-${randomUUID()}`,
    kind: "story-retention-test-release",
  });
  try {
    const released = await controller.mirror.reconcileStoryBaseRetentions(
      entry,
      releaseLease,
      [],
    );
    assert.equal(released.active, 0);
    assert.ok(released.staleDeleted >= 2);
  } finally {
    releaseLease.release();
  }
  await assert.rejects(
    controller.mirror.resolveRetainedStoryCandidate({
      repositoryId: entry.repositoryId,
      branch: "main",
      storyId: "CARB-RETENTION",
      candidateSha: forwardSha,
    }),
    { code: "GIT_CONTROLLER_STORY_RETENTION_MISSING" },
  );
});

test("approved rewrite rechecks the remote tip after asynchronous impact evidence", async () => {
  const fixture = createFixture("rewrite-final-tip-race");
  const { controller, entry } = await makeController(fixture);
  controller.mirror.setStoryBaseRetentionProvider(async () => []);

  const initial = await controller.mirror.preview({
    repositoryId: entry.repositoryId,
    branch: "main",
  });
  await executePreview(controller, initial);
  const forwardSha = advance(
    fixture.seed,
    "accepted-before-race.txt",
    "accepted\n",
    "accepted before race",
  );
  const forward = await controller.mirror.preview({
    repositoryId: entry.repositoryId,
    branch: "main",
  });
  await executePreview(controller, forward);

  git(["reset", "--hard", fixture.initialSha], fixture.seed);
  git(["push", "--force", "origin", "main"], fixture.seed);

  let publicationCalls = 0;
  let releaseExecutionEvidence;
  let signalExecutionEvidence;
  const executionEvidenceRequested = new Promise((resolve) => {
    signalExecutionEvidence = resolve;
  });
  const executionEvidenceGate = new Promise((resolve) => {
    releaseExecutionEvidence = resolve;
  });
  const evidenceDigest = createHash("sha256")
    .update("rewrite-final-tip-race-ledger")
    .digest("hex");
  controller.mirror.setRewritePublicationProvider(async () => {
    publicationCalls += 1;
    if (publicationCalls === 2) {
      signalExecutionEvidence();
      await executionEvidenceGate;
    }
    return {
      status: "NONE",
      publishedCommits: [],
      truncated: false,
      evidenceId: "test-publication-ledger-race",
      evidenceDigest,
    };
  });

  const rewind = await controller.mirror.preview({
    repositoryId: entry.repositoryId,
    branch: "main",
  });
  assert.equal(rewind.relationship, "REMOTE_REWIND");
  assert.equal(rewind.rewriteImpact.approvalAllowed, true);

  const execution = executePreview(
    controller,
    rewind,
    randomUUID(),
    administrativeApproval(rewind),
  );
  await executionEvidenceRequested;
  const changedRemoteSha = advance(
    fixture.seed,
    "changed-during-evidence.txt",
    "changed\n",
    "changed during evidence",
  );
  releaseExecutionEvidence();

  await assert.rejects(
    execution,
    (error) => (
      error.code === "GIT_CONTROLLER_REMOTE_CHANGED"
      && error.details.observedCandidate === changedRemoteSha
    ),
  );
  assert.equal(
    git(["--git-dir", entry.mirrorPath, "rev-parse", controllerAcceptedRef("origin", "main")]),
    forwardSha,
  );
  assert.equal(
    git([
      "--git-dir",
      entry.mirrorPath,
      "for-each-ref",
      "--format=%(refname)",
      controllerAcceptedHistoryRef("origin", "main", 3),
    ]),
    "",
  );
});

test("startup recovery preserves the exact approved rewrite identity and audit binding", async () => {
  const fixture = createFixture("rewrite-approval-crash-recovery");
  const crash = Object.assign(new Error("simulated approved rewrite crash"), {
    simulateProcessCrash: true,
  });
  let crashEnabled = false;
  const first = await makeController(fixture, [], {
    mirrorFaultInjector(phase) {
      if (crashEnabled && phase === "after-accepted-ref-publish") throw crash;
    },
  });
  const initial = await first.controller.mirror.preview({
    repositoryId: first.entry.repositoryId,
    branch: "main",
  });
  await executePreview(first.controller, initial);
  const forwardSha = advance(fixture.seed, "rewrite-crash.txt", "forward\n", "forward");
  const forward = await first.controller.mirror.preview({
    repositoryId: first.entry.repositoryId,
    branch: "main",
  });
  await executePreview(first.controller, forward);
  enableRewriteApprovalEvidence(first.controller);

  git(["reset", "--hard", fixture.initialSha], fixture.seed);
  git(["push", "--force", "origin", "main"], fixture.seed);
  const rewind = await first.controller.mirror.preview({
    repositoryId: first.entry.repositoryId,
    branch: "main",
  });
  assert.equal(rewind.relationship, "REMOTE_REWIND");
  const approval = administrativeApproval(rewind, "administrator:crash-recovery");
  crashEnabled = true;
  await assert.rejects(
    executePreview(first.controller, rewind, "approved-rewrite-crash", approval),
    (error) => error === crash,
  );
  const interrupted = persistence.getGitControllerOperationByIdempotency(
    first.entry.repositoryId,
    "MIRROR_REFRESH",
    "approved-rewrite-crash",
  );
  assert.equal(interrupted.status, "RUNNING");
  assert.equal(interrupted.phase, "MIRROR_RETENTION_VERIFIED");
  const checkpoint = persistence.listGitControllerJournal(interrupted.operationId)
    .findLast((row) => row.phase === "MIRROR_PUBLISHING");
  assert.equal(checkpoint.data.relationship, "REMOTE_REWIND");
  assert.equal(checkpoint.data.actor, approval.actor);
  assert.equal(checkpoint.data.administrativeApproval.approvalId, approval.adminApprovalId);
  assert.equal(checkpoint.data.administrativeApproval.previousSha, forwardSha);
  assert.equal(checkpoint.data.administrativeApproval.candidateSha, fixture.initialSha);
  assert.equal(checkpoint.data.administrativeApproval.previewId, rewind.previewId);
  assert.equal(
    checkpoint.data.administrativeApproval.impactDigest,
    rewind.rewriteImpact.digest,
  );
  assert.equal(checkpoint.data.rewriteImpactDigest, rewind.rewriteImpact.digest);
  assert.equal(
    checkpoint.data.administrativeApproval.previewVersion,
    rewind.previewVersion,
  );

  const restarted = await makeController(fixture, [], {
    leaseProcessIdentityProbe: RECOVERY_PROCESS_IDENTITY_PROBE,
  });
  const recovered = persistence.getGitControllerOperation(interrupted.operationId);
  assert.equal(recovered.status, "SUCCEEDED");
  assert.equal(recovered.result.recovered, true);
  assert.equal(recovered.result.relationship, "REMOTE_REWIND");
  assert.equal(
    recovered.result.administrativeApproval.approvalId,
    approval.adminApprovalId,
  );
  assert.equal(recovered.result.administrativeApproval.approvedBy, approval.actor);
  assert.equal(recovered.result.administrativeApproval.previousSha, forwardSha);
  assert.equal(
    recovered.result.administrativeApproval.candidateSha,
    fixture.initialSha,
  );
  assert.equal(recovered.result.administrativeApproval.previewId, rewind.previewId);
  assert.equal(
    recovered.result.administrativeApproval.previewVersion,
    rewind.previewVersion,
  );
  assert.equal(
    recovered.result.administrativeApproval.impactDigest,
    rewind.rewriteImpact.digest,
  );
  assert.equal(
    recovered.result.approvalCheckpointAt,
    checkpoint.createdAt,
  );
  const passAudit = persistence.listGitControllerAudit({
    operationId: interrupted.operationId,
  }).find((row) => (
    row.action === "mirror.accepted.publish"
    && row.result === "PASS"
  ));
  assert.equal(passAudit.reason, "startup-recovery");
  assert.equal(passAudit.actor, approval.actor);
  assert.equal(passAudit.details.relationship, "REMOTE_REWIND");
  assert.equal(
    passAudit.details.administrativeApproval.approvalId,
    approval.adminApprovalId,
  );
  assert.equal(
    passAudit.details.administrativeApproval.approvedBy,
    approval.actor,
  );
  assert.equal(
    passAudit.details.administrativeApproval.previousSha,
    forwardSha,
  );
  assert.equal(
    passAudit.details.administrativeApproval.candidateSha,
    fixture.initialSha,
  );
  assert.equal(
    passAudit.details.administrativeApproval.impactDigest,
    rewind.rewriteImpact.digest,
  );
  assert.equal(passAudit.details.approvalCheckpointAt, checkpoint.createdAt);
  assert.equal(
    git([
      "--git-dir",
      restarted.entry.mirrorPath,
      "rev-parse",
      restarted.controller.mirror.acceptedRef(restarted.entry, "main"),
    ]),
    fixture.initialSha,
  );
});
