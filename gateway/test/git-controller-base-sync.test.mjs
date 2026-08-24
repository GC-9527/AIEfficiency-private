import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "git-controller-base-"));
process.env.GATEWAY_DB_PATH = path.join(root, "gateway.db");

const {
  BASE_COMMAND_ID,
  BASE_OPERATION_TYPE,
  controllerBaseDestinationRef,
  createNulRecordParser,
  createGitController,
  listAllRecoverableOperations,
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

test("recoverable pagination cannot hide a type or repository behind the first 100 rows", async () => {
  const fixture = createFixture("recoverable-pagination");
  const { controller, entry } = await makeController(fixture);
  const operationIds = [];
  const begin = ({
    repositoryId,
    operationType,
    startedAt,
    ordinal,
  }) => {
    const operationId = randomUUID();
    operationIds.push(operationId);
    const created = persistence.beginGitControllerOperation({
      operationId,
      repositoryId,
      operationType,
      commandId: "test.recoverable.pagination",
      idempotencyKey: `pagination-${operationType}-${ordinal}-${operationId}`,
      branch: "main",
      phase: "PREVIEWED",
      ownerInstance: "test:recoverable-pagination",
      startedAt,
    });
    assert.equal(created.created, true);
  };
  try {
    for (let index = 0; index < 100; index += 1) {
      begin({
        repositoryId: `unrelated-repository-${index}`,
        operationType: "UNRELATED_RECOVERY_OPERATION",
        startedAt: 1_000,
        ordinal: index,
      });
    }
    for (let index = 0; index < 105; index += 1) {
      begin({
        repositoryId: entry.repositoryId,
        operationType: "TARGET_RECOVERY_OPERATION",
        startedAt: 2_000,
        ordinal: index,
      });
    }

    const byType = listAllRecoverableOperations(persistence, {
      operationType: "TARGET_RECOVERY_OPERATION",
      batchSize: 25,
    });
    assert.equal(byType.length, 105);
    assert.ok(byType.every((operation) => (
      operation.operationType === "TARGET_RECOVERY_OPERATION"
    )));

    const status = await controller.syncStatus({
      repositoryId: entry.repositoryId,
      branch: "main",
    });
    assert.equal(status.recoverableOperations.length, 105);
    assert.ok(status.recoverableOperations.every((operation) => (
      operation.repositoryId === entry.repositoryId
    )));
  } finally {
    for (const operationId of operationIds) {
      persistence.finishGitControllerOperation(operationId, {
        status: "FAILED",
        phase: "FAILED",
        resultCode: "TEST_CLEANUP",
        completedAt: Date.now(),
      });
    }
  }
});

test("candidate tree NUL parser accepts a normal stream larger than 32 MiB without buffering it", () => {
  let records = 0;
  const parser = createNulRecordParser({
    onRecord(record) {
      assert.equal(record.length, 1023);
      records += 1;
    },
    maxTotalBytes: 40 * 1024 * 1024,
    maxRecords: 40_000,
    maxRecordBytes: 2048,
  });
  const chunk = Buffer.alloc(32 * 1024, 0x61);
  for (let offset = 1023; offset < chunk.length; offset += 1024) chunk[offset] = 0;
  for (let index = 0; index < 1057; index += 1) parser.push(chunk);
  const result = parser.finish();
  assert.ok(result.totalBytes > 32 * 1024 * 1024);
  assert.equal(result.recordCount, 1057 * 32);
  assert.equal(records, result.recordCount);
});

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
  // Controller Git execution deliberately ignores the operator's global
  // configuration. Materialize the fixture with the same deterministic
  // line-ending policy so an ambient core.autocrlf setting cannot manufacture
  // a dirty base repository after the trust boundary is applied.
  git(["config", "core.autocrlf", "false"], base);
  git(["reset", "--hard", "HEAD"], base);
  const dataRoot = path.join(fixtureRoot, "data");
  fs.mkdirSync(dataRoot);
  return { fixtureRoot, remote, seed, base, dataRoot, initialSha };
}

async function makeController(fixture, {
  commandLog = [],
  capabilityIssuer = null,
  allowedSubmoduleUrls = [],
  leaseProcessIdentityProbe = undefined,
} = {}) {
  const gitRunner = async (options) => {
    commandLog.push({
      commandId: options.commandId,
      args: [...(options.args || [])],
      env: { ...(options.env || {}) },
      childTracked: !!options.childLifecycle,
    });
    return runGitFile(options);
  };
  const controller = await createGitController({
    dataRoot: fixture.dataRoot,
    definitions: [{
      logicalDefinitionId: `logical-${path.basename(fixture.fixtureRoot)}`,
      displayName: "Base test",
      basePath: fixture.base,
      remoteId: "origin",
      expectedRemoteUrls: [fixture.remote],
      allowedBranches: ["main"],
      allowedSubmoduleUrls,
    }],
    gitRunner,
    capabilityIssuer,
    leaseProcessIdentityProbe: leaseProcessIdentityProbe
      || ACTIVE_PROCESS_IDENTITY_PROBE,
    leaseTtlMs: 20_000,
  });
  return { controller, entry: controller.registry.list()[0] };
}

function createAdvertisedSubmodule(fixture, name = "submodule") {
  const remote = path.join(fixture.fixtureRoot, `${name}.git`);
  git(["init", "--bare", remote]);
  const seed = path.join(fixture.fixtureRoot, `${name}-seed`);
  fs.mkdirSync(seed);
  git(["init"], seed);
  git(["config", "user.name", "Controller Test"], seed);
  git(["config", "user.email", "controller@example.test"], seed);
  git(["checkout", "-b", "main"], seed);
  fs.writeFileSync(path.join(seed, "module.txt"), `${name}\n`);
  git(["add", "module.txt"], seed);
  git(["commit", "-m", `${name} initial`], seed);
  const sha = git(["rev-parse", "HEAD"], seed);
  git(["remote", "add", "origin", remote], seed);
  git(["push", "-u", "origin", "main"], seed);
  return { remote, seed, sha };
}

function commitSubmoduleCandidate(fixture, {
  modulePath,
  moduleUrl,
  moduleSha,
  message,
  extraConfig = "",
}) {
  fs.writeFileSync(
    path.join(fixture.seed, ".gitmodules"),
    `[submodule "candidate"]\n\tpath = ${modulePath}\n\turl = ${moduleUrl}\n${extraConfig}`,
  );
  git(["add", ".gitmodules"], fixture.seed);
  git([
    "update-index",
    "--add",
    "--cacheinfo",
    `160000,${moduleSha},${modulePath}`,
  ], fixture.seed);
  git(["commit", "-m", message], fixture.seed);
  git(["push", "origin", "main"], fixture.seed);
  return git(["rev-parse", "HEAD"], fixture.seed);
}

function commitAndPush(seed, file, content, message) {
  fs.writeFileSync(path.join(seed, file), content);
  git(["add", file], seed);
  git(["commit", "-m", message], seed);
  git(["push", "origin", "main"], seed);
  return git(["rev-parse", "HEAD"], seed);
}

async function acceptRemote(controller, entry) {
  const preview = await controller.mirror.preview({
    repositoryId: entry.repositoryId,
    branch: "main",
  });
  return controller.mirror.execute({
    repositoryId: entry.repositoryId,
    branch: "main",
    previewId: preview.previewId,
    previewVersion: preview.previewVersion,
    expectedAcceptedSha: preview.lastAcceptedSha,
    candidateSha: preview.candidateSha,
    idempotencyKey: randomUUID(),
  });
}

async function executeBasePreview(controller, preview, idempotencyKey = randomUUID()) {
  return controller.base.execute({
    repositoryId: preview.repositoryId,
    branch: preview.branch,
    previewId: preview.previewId,
    previewVersion: preview.previewVersion,
    expectedHead: preview.expectedHead,
    candidateSha: preview.candidateSha,
    idempotencyKey,
  });
}

function beginOrphanBaseOperation(controller, preview, phase) {
  const begun = controller.journal.begin({
    repositoryId: preview.repositoryId,
    operationType: BASE_OPERATION_TYPE,
    commandId: BASE_COMMAND_ID,
    idempotencyKey: randomUUID(),
    previewId: preview.previewId,
    branch: preview.branch,
    expectedHead: preview.expectedHead,
    candidateSha: preview.candidateSha,
  });
  assert.equal(begun.created, true);
  const operation = begun.operation;
  assert.equal(
    controller.journal.persistence.consumeGitControllerPreview(
      preview.previewId,
      operation.operationId,
    ).ok,
    true,
  );
  controller.journal.append(operation, "BASE_PREFLIGHT_PASSED", {
    beforeHead: preview.expectedHead,
    targetHead: preview.candidateSha,
    branch: preview.branch,
  });
  controller.journal.append(operation, "BASE_OBJECTS_FETCHED", {
    beforeHead: preview.expectedHead,
    targetHead: preview.candidateSha,
    branch: preview.branch,
  });
  controller.journal.append(operation, "BASE_APPLYING", {
    beforeHead: preview.expectedHead,
    targetHead: preview.candidateSha,
    branch: preview.branch,
  });
  if (phase === "BASE_APPLIED") {
    controller.journal.append(operation, "BASE_APPLIED", {
      beforeHead: preview.expectedHead,
      targetHead: preview.candidateSha,
      branch: preview.branch,
    });
  }
  return operation;
}

test("base sync fetches only accepted ref and fast-forwards to the exact SHA", async () => {
  const fixture = createFixture("fast-forward");
  const managedHooks = path.join(
    fixture.base,
    ".git",
    "devbench-base-protection",
    "hooks",
  );
  fs.mkdirSync(managedHooks, { recursive: true });
  git(["config", "--local", "core.hooksPath", managedHooks], fixture.base);
  const commandLog = [];
  const capabilityContexts = [];
  const { controller, entry } = await makeController(fixture, {
    commandLog,
    capabilityIssuer: async (context) => {
      capabilityContexts.push(context);
      return {
        capability: `test-capability-${context.commandId}`,
        environment: {
          DEVBENCH_GIT_CONTROLLER_CAPABILITY_ROOT: path.join(
            fixture.fixtureRoot,
            "capabilities",
          ),
        },
      };
    },
  });
  await acceptRemote(controller, entry);
  const candidateSha = commitAndPush(
    fixture.seed,
    "forward.txt",
    "forward\n",
    "remote forward",
  );
  await acceptRemote(controller, entry);

  const preview = await controller.base.preview({
    repositoryId: entry.repositoryId,
    branch: "main",
  });
  assert.equal(preview.expectedHead, fixture.initialSha);
  assert.equal(preview.candidateSha, candidateSha);
  assert.equal(preview.relationship, "FAST_FORWARD");
  assert.equal(preview.eligible, true, JSON.stringify(preview, null, 2));

  const idempotencyKey = randomUUID();
  const result = await executeBasePreview(controller, preview, idempotencyKey);
  assert.equal(result.ok, true);
  assert.equal(result.beforeHead, fixture.initialSha);
  assert.equal(result.head, candidateSha);
  assert.equal(git(["rev-parse", "HEAD"], fixture.base), candidateSha);
  assert.equal(git(["symbolic-ref", "--short", "HEAD"], fixture.base), "main");
  assert.equal(git(["status", "--porcelain"], fixture.base), "");
  assert.equal(
    git(["rev-parse", controllerBaseDestinationRef("origin", "main")], fixture.base),
    candidateSha,
  );
  const merge = commandLog.find((item) => item.commandId === "base.merge-fast-forward");
  const fetch = commandLog.find((item) => item.commandId === "base.fetch-accepted");
  assert.ok(fetch);
  assert.ok(fetch.args.includes("--no-auto-maintenance"));
  assert.ok(fetch.args.includes("gc.auto=0"));
  assert.ok(fetch.args.includes("gc.autoDetach=false"));
  assert.ok(fetch.args.includes("maintenance.auto=false"));
  assert.ok(fetch.args.includes("maintenance.autoDetach=false"));
  assert.ok(merge);
  assert.deepEqual(
    merge.args.slice(-4),
    ["merge", "--ff-only", "--no-overwrite-ignore", candidateSha],
  );
  assert.equal(commandLog.some((item) => (
    item.args.includes("stash")
    || item.args.includes("checkout")
    || item.args.includes("reset")
  )), false);
  assert.deepEqual(
    capabilityContexts.map((item) => item.commandId),
    ["base.fetch-accepted", "base.merge-fast-forward"],
  );
  for (const item of commandLog.filter((entry) => (
    ["base.fetch-accepted", "base.merge-fast-forward"].includes(entry.commandId)
  ))) {
    assert.equal(item.childTracked, true);
    assert.deepEqual(
      Object.keys(item.env).sort(),
      [
        "DEVBENCH_BASE_PROTECTION_CAPABILITY",
        "DEVBENCH_BASE_PROTECTION_CONTROLLER_MUTATION",
        "DEVBENCH_GIT_CONTROLLER_CAPABILITY_ROOT",
        "GIT_ALLOW_PROTOCOL",
        "GIT_PROTOCOL_FROM_USER",
      ],
    );
    assert.equal(
      item.env.DEVBENCH_BASE_PROTECTION_CONTROLLER_MUTATION,
      "1",
    );
    assert.equal(Object.hasOwn(item.env, "DEVBENCH_SYSTEM_GIT_OP"), false);
  }

  const journal = persistence.listGitControllerJournal(result.operationId);
  assert.deepEqual(
    journal.map((item) => item.phase),
    [
      "PREVIEWED",
      "BASE_PREFLIGHT_PASSED",
      "BASE_OBJECTS_FETCHED",
      "BASE_APPLYING",
      "BASE_APPLIED",
      "VERIFIED",
    ],
  );
  assert.equal(persistence.listGitControllerAudit({ operationId: result.operationId }).length, 1);

  const replay = await executeBasePreview(controller, preview, idempotencyKey);
  assert.equal(replay.operationId, result.operationId);
  assert.equal(replay.replayed, true);
  await assert.rejects(
    controller.base.execute({
      repositoryId: preview.repositoryId,
      branch: preview.branch,
      previewId: preview.previewId,
      previewVersion: preview.previewVersion,
      expectedHead: preview.expectedHead,
      candidateSha: "0".repeat(40),
      idempotencyKey,
    }),
    (error) => error.code === "GIT_CONTROLLER_IDEMPOTENCY_CONFLICT",
  );
});

test("startup recovery reconciles BASE_APPLYING and BASE_APPLIED exact-SHA kill windows", async () => {
  for (const scenario of [
    { label: "recover-applying-before", phase: "BASE_APPLYING", moveHead: false },
    { label: "recover-applying-target", phase: "BASE_APPLYING", moveHead: true },
    { label: "recover-applied-target", phase: "BASE_APPLIED", moveHead: true },
  ]) {
    const fixture = createFixture(scenario.label);
    const { controller, entry } = await makeController(fixture);
    const candidateSha = commitAndPush(
      fixture.seed,
      "candidate.txt",
      `${scenario.label}\n`,
      scenario.label,
    );
    await acceptRemote(controller, entry);
    const preview = await controller.base.preview({
      repositoryId: entry.repositoryId,
      branch: "main",
    });
    git([
      "fetch",
      fixture.remote,
      `main:${controllerBaseDestinationRef("origin", "main")}`,
    ], fixture.base);
    const operation = beginOrphanBaseOperation(controller, preview, scenario.phase);
    if (scenario.moveHead) {
      git(["merge", "--ff-only", candidateSha], fixture.base);
    }

    const { controller: restarted } = await makeController(fixture, {
      leaseProcessIdentityProbe: RECOVERY_PROCESS_IDENTITY_PROBE,
    });
    const stored = persistence.getGitControllerOperation(operation.operationId);
    const reclaimAudits = persistence.listGitControllerAudit({
      operationId: operation.operationId,
    }).filter((row) => (
      row.action === "git-controller.operation.recover-orphan"
      && row.result === "PASS"
    ));
    assert.equal(reclaimAudits.length, 1);
    assert.equal(reclaimAudits[0].reason, "owner_pid_reused");
    if (!scenario.moveHead) {
      assert.equal(stored.status, "FAILED");
      assert.equal(
        stored.resultCode,
        "GIT_CONTROLLER_INTERRUPTED_BEFORE_BASE_APPLY",
      );
      assert.equal(git(["rev-parse", "HEAD"], fixture.base), fixture.initialSha);
      const retry = await restarted.base.preview({
        repositoryId: entry.repositoryId,
        branch: "main",
      });
      assert.equal(retry.eligible, true);
      assert.equal(retry.expectedHead, fixture.initialSha);
      assert.equal(retry.candidateSha, candidateSha);
    } else {
      assert.equal(stored.status, "SUCCEEDED");
      assert.equal(stored.result.recovered, true);
      assert.equal(stored.result.head, candidateSha);
      assert.equal(git(["status", "--porcelain"], fixture.base), "");
      const audits = persistence.listGitControllerAudit({
        operationId: operation.operationId,
      }).filter((row) => row.action === "base.fast-forward.apply");
      assert.equal(audits.length, 1);
      assert.equal(audits[0].result, "PASS");
    }
  }
});

test("ambiguous orphan base state marks RECOVERY_REQUIRED and blocks Controller ready", async () => {
  const fixture = createFixture("recover-ambiguous");
  const { controller, entry } = await makeController(fixture);
  commitAndPush(
    fixture.seed,
    "candidate.txt",
    "candidate\n",
    "candidate",
  );
  await acceptRemote(controller, entry);
  const preview = await controller.base.preview({
    repositoryId: entry.repositoryId,
    branch: "main",
  });
  git([
    "fetch",
    fixture.remote,
    `main:${controllerBaseDestinationRef("origin", "main")}`,
  ], fixture.base);
  const operation = beginOrphanBaseOperation(controller, preview, "BASE_APPLYING");
  const dirtyPath = path.join(fixture.base, "untracked-during-recovery.txt");
  fs.writeFileSync(dirtyPath, "ambiguous\n");

  await assert.rejects(
    makeController(fixture, {
      leaseProcessIdentityProbe: RECOVERY_PROCESS_IDENTITY_PROBE,
    }),
    (error) => error.code === "GIT_CONTROLLER_BASE_RECOVERY_BLOCKED",
  );
  let stored = persistence.getGitControllerOperation(operation.operationId);
  assert.equal(stored.status, "RECOVERY_REQUIRED");
  assert.equal(stored.resultCode, "GIT_CONTROLLER_BASE_RECOVERY_REQUIRED");

  fs.unlinkSync(dirtyPath);
  await makeController(fixture, {
    leaseProcessIdentityProbe: RECOVERY_PROCESS_IDENTITY_PROBE,
  });
  stored = persistence.getGitControllerOperation(operation.operationId);
  assert.equal(stored.status, "FAILED");
  assert.equal(
    stored.resultCode,
    "GIT_CONTROLLER_INTERRUPTED_BEFORE_BASE_APPLY",
  );
  assert.equal(
    persistence.listGitControllerAudit({
      operationId: operation.operationId,
    }).filter((row) => (
      row.action === "git-controller.operation.recover-orphan"
      && row.result === "PASS"
    )).length,
    1,
  );
});

test("base preview blocks tracked, untracked, wrong-branch and in-progress state", async () => {
  const fixture = createFixture("preflight-blockers");
  const { controller, entry } = await makeController(fixture);
  await acceptRemote(controller, entry);

  fs.appendFileSync(path.join(fixture.base, "README.md"), "dirty\n");
  let preview = await controller.base.preview({
    repositoryId: entry.repositoryId,
    branch: "main",
  });
  assert.equal(preview.eligible, false);
  assert.equal(preview.blockerCode, "BASE_SYNC_BLOCKED_DIRTY");
  git(["restore", "README.md"], fixture.base);

  fs.writeFileSync(path.join(fixture.base, "untracked.txt"), "untracked\n");
  preview = await controller.base.preview({
    repositoryId: entry.repositoryId,
    branch: "main",
  });
  assert.equal(preview.eligible, false);
  assert.equal(preview.blockerCode, "BASE_SYNC_BLOCKED_UNTRACKED");
  fs.unlinkSync(path.join(fixture.base, "untracked.txt"));

  git(["checkout", "-b", "topic"], fixture.base);
  preview = await controller.base.preview({
    repositoryId: entry.repositoryId,
    branch: "main",
  });
  assert.equal(preview.eligible, false);
  assert.equal(preview.blockerCode, "BASE_SYNC_BLOCKED_WRONG_BRANCH");
  git(["checkout", "main"], fixture.base);

  const mergeHead = git(["rev-parse", "--git-path", "MERGE_HEAD"], fixture.base);
  const mergeHeadPath = path.isAbsolute(mergeHead)
    ? mergeHead
    : path.join(fixture.base, mergeHead);
  fs.writeFileSync(mergeHeadPath, `${fixture.initialSha}\n`);
  preview = await controller.base.preview({
    repositoryId: entry.repositoryId,
    branch: "main",
  });
  assert.equal(preview.eligible, false);
  assert.equal(preview.blockerCode, "BASE_SYNC_BLOCKED_OPERATION_IN_PROGRESS");
  fs.unlinkSync(mergeHeadPath);
});

test("base preview distinguishes local ahead and diverged without mutating user work", async () => {
  const fixture = createFixture("ahead-diverged");
  const { controller, entry } = await makeController(fixture);
  await acceptRemote(controller, entry);

  fs.writeFileSync(path.join(fixture.base, "local.txt"), "local\n");
  git(["add", "local.txt"], fixture.base);
  git(["commit", "-m", "local ahead"], fixture.base);
  const localHead = git(["rev-parse", "HEAD"], fixture.base);
  let preview = await controller.base.preview({
    repositoryId: entry.repositoryId,
    branch: "main",
  });
  assert.equal(preview.relationship, "BASE_AHEAD");
  assert.equal(preview.blockerCode, "BASE_SYNC_BLOCKED_AHEAD");
  assert.equal(git(["rev-parse", "HEAD"], fixture.base), localHead);

  commitAndPush(fixture.seed, "remote.txt", "remote\n", "remote diverged");
  await acceptRemote(controller, entry);
  preview = await controller.base.preview({
    repositoryId: entry.repositoryId,
    branch: "main",
  });
  assert.equal(preview.relationship, "BASE_DIVERGED");
  assert.equal(preview.blockerCode, "BASE_SYNC_BLOCKED_DIVERGED");
  assert.equal(git(["rev-parse", "HEAD"], fixture.base), localHead);
  assert.equal(git(["status", "--porcelain"], fixture.base), "");
});

test("base execute requires exact preview SHA fields and current HEAD", async () => {
  const fixture = createFixture("stale-exact");
  const { controller, entry } = await makeController(fixture);
  await acceptRemote(controller, entry);
  commitAndPush(fixture.seed, "candidate.txt", "candidate\n", "candidate");
  await acceptRemote(controller, entry);
  const preview = await controller.base.preview({
    repositoryId: entry.repositoryId,
    branch: "main",
  });

  await assert.rejects(
    controller.base.execute({
      repositoryId: entry.repositoryId,
      branch: "main",
      previewId: preview.previewId,
      previewVersion: preview.previewVersion,
      expectedHead: preview.expectedHead,
      candidateSha: "0".repeat(40),
      idempotencyKey: randomUUID(),
    }),
    (error) => error.code === "GIT_CONTROLLER_PREVIEW_STALE",
  );
  assert.equal(git(["rev-parse", "HEAD"], fixture.base), fixture.initialSha);

  fs.writeFileSync(path.join(fixture.base, "local-after-preview.txt"), "local\n");
  git(["add", "local-after-preview.txt"], fixture.base);
  git(["commit", "-m", "local after preview"], fixture.base);
  const changedHead = git(["rev-parse", "HEAD"], fixture.base);
  await assert.rejects(
    executeBasePreview(controller, preview),
    (error) => (
      error.code === "BASE_SYNC_BLOCKED_DIVERGED"
      || error.code === "GIT_CONTROLLER_EXPECTED_HEAD_CHANGED"
    ),
  );
  assert.equal(git(["rev-parse", "HEAD"], fixture.base), changedHead);
});

test("managed hooks fail closed without an issuer before any base mutation", async () => {
  const fixture = createFixture("capability-required");
  const { controller, entry } = await makeController(fixture);
  await acceptRemote(controller, entry);
  commitAndPush(fixture.seed, "protected.txt", "protected\n", "protected candidate");
  await acceptRemote(controller, entry);
  const managedHooks = path.join(
    fixture.base,
    ".git",
    "devbench-base-protection",
    "hooks",
  );
  fs.mkdirSync(managedHooks, { recursive: true });
  git(["config", "core.hooksPath", managedHooks], fixture.base);
  const preview = await controller.base.preview({
    repositoryId: entry.repositoryId,
    branch: "main",
  });
  const beforeHead = git(["rev-parse", "HEAD"], fixture.base);

  await assert.rejects(
    executeBasePreview(controller, preview),
    (error) => error.code === "BASE_PROTECTION_ISSUER_UNAVAILABLE",
  );
  assert.equal(git(["rev-parse", "HEAD"], fixture.base), beforeHead);
  assert.equal(
    git([
      "for-each-ref",
      "--format=%(refname)",
      controllerBaseDestinationRef("origin", "main"),
    ], fixture.base),
    "",
  );
});

test("base preflight rejects malicious local fsmonitor without executing it", async () => {
  const fixture = createFixture("malicious-local-config");
  const { controller, entry } = await makeController(fixture);
  await acceptRemote(controller, entry);
  const marker = path.join(fixture.fixtureRoot, "fsmonitor-executed");
  const fsmonitor = path.join(
    fixture.fixtureRoot,
    process.platform === "win32" ? "fsmonitor.cmd" : "fsmonitor",
  );
  if (process.platform === "win32") {
    fs.writeFileSync(fsmonitor, `@echo invoked>\"${marker}\"\r\n@exit /b 0\r\n`);
  } else {
    fs.writeFileSync(fsmonitor, `#!/bin/sh\nprintf invoked >\"${marker}\"\nexit 0\n`);
    fs.chmodSync(fsmonitor, 0o700);
  }
  const managedHooks = path.join(
    fixture.base,
    ".git",
    "devbench-base-protection",
    "hooks",
  );
  fs.mkdirSync(managedHooks, { recursive: true });
  git(["config", "--local", "core.fsmonitor", fsmonitor], fixture.base);
  git(["config", "--local", "core.hooksPath", managedHooks], fixture.base);
  const accepted = await controller.mirror.readAccepted(entry, "main");
  await assert.rejects(
    controller.base.preflight(entry, "main", accepted.acceptedSha),
    { code: "GIT_CONTROLLER_BASE_CONFIG_UNTRUSTED" },
  );
  assert.equal(fs.existsSync(marker), false);
});

test("base mutation rejects attacker-controlled local hooksPath before any hook or HEAD change", async () => {
  const fixture = createFixture("malicious-hooks-path");
  const marker = path.join(fixture.fixtureRoot, "malicious-post-merge-executed");
  const evilHooks = path.join(fixture.base, ".git", "evil-hooks");
  fs.mkdirSync(evilHooks, { recursive: true });
  const hook = path.join(evilHooks, process.platform === "win32" ? "post-merge.cmd" : "post-merge");
  if (process.platform === "win32") {
    fs.writeFileSync(hook, `@echo invoked>\"${marker}\"\r\n@exit /b 0\r\n`);
  } else {
    fs.writeFileSync(hook, `#!/bin/sh\nprintf invoked >\"${marker}\"\n`);
    fs.chmodSync(hook, 0o700);
  }
  git(["config", "--local", "core.hooksPath", evilHooks], fixture.base);
  const { controller, entry } = await makeController(fixture, {
    capabilityIssuer: async () => ({ capability: "must-not-be-used", environment: {} }),
  });
  await acceptRemote(controller, entry);
  commitAndPush(fixture.seed, "evil-target.txt", "forward\n", "forward");
  await acceptRemote(controller, entry);
  const before = git(["rev-parse", "HEAD"], fixture.base);
  await assert.rejects(
    controller.base.preview({ repositoryId: entry.repositoryId, branch: "main" }),
    { code: "GIT_CONTROLLER_BASE_CONFIG_UNTRUSTED" },
  );
  assert.equal(git(["rev-parse", "HEAD"], fixture.base), before);
  assert.equal(fs.existsSync(marker), false);
});

test("base rejects ext URL rewrites in local config before transport or HEAD mutation", async () => {
  const fixture = createFixture("malicious-ext-rewrite");
  const { controller, entry } = await makeController(fixture);
  await acceptRemote(controller, entry);
  commitAndPush(fixture.seed, "ext-target.txt", "forward\n", "forward");
  await acceptRemote(controller, entry);
  const marker = path.join(fixture.fixtureRoot, "remote-ext-executed");
  fs.appendFileSync(
    path.join(fixture.base, ".git", "config"),
    `\n[protocol "ext"]\n\tallow = always\n[url "ext::cmd /c echo invoked>${marker.replace(/\\/g, "/")}"]\n\tinsteadOf = ${entry.mirrorPath.replace(/\\/g, "/")}\n`,
  );
  const before = git(["rev-parse", "HEAD"], fixture.base);
  await assert.rejects(
    controller.base.preview({ repositoryId: entry.repositoryId, branch: "main" }),
    { code: "GIT_CONTROLLER_BASE_CONFIG_UNTRUSTED" },
  );
  assert.equal(fs.existsSync(marker), false);
  assert.equal(git(["rev-parse", "HEAD"], fixture.base), before);
});

test("candidate executable attributes nested at the end of the streamed tree are blocked", async () => {
  const fixture = createFixture("malicious-candidate-attributes");
  const { controller, entry } = await makeController(fixture);
  await acceptRemote(controller, entry);
  const nested = path.join(fixture.seed, "zzzz-last", "nested");
  fs.mkdirSync(nested, { recursive: true });
  fs.writeFileSync(path.join(nested, ".gitattributes"), "*.pwn filter=pwn\n");
  fs.writeFileSync(path.join(nested, "payload.pwn"), "payload\n");
  git(["add", "zzzz-last/nested/.gitattributes", "zzzz-last/nested/payload.pwn"], fixture.seed);
  git(["commit", "-m", "malicious attributes"], fixture.seed);
  git(["push", "origin", "main"], fixture.seed);
  await acceptRemote(controller, entry);
  const before = git(["rev-parse", "HEAD"], fixture.base);
  const preview = await controller.base.preview({
    repositoryId: entry.repositoryId,
    branch: "main",
  });
  assert.equal(preview.eligible, false);
  assert.equal(preview.blockerCode, "BASE_SYNC_BLOCKED_CANDIDATE_ATTRIBUTES");
  assert.equal(git(["rev-parse", "HEAD"], fixture.base), before);
});

test("base execute rejects a local smudge driver before marker execution or HEAD mutation", async () => {
  const fixture = createFixture("malicious-local-smudge");
  const { controller, entry } = await makeController(fixture);
  await acceptRemote(controller, entry);
  const candidateSha = commitAndPush(
    fixture.seed,
    "smudge-target.txt",
    "forward\n",
    "forward",
  );
  await acceptRemote(controller, entry);
  const preview = await controller.base.preview({
    repositoryId: entry.repositoryId,
    branch: "main",
  });
  assert.equal(preview.eligible, true);
  const marker = path.join(fixture.fixtureRoot, "smudge-executed");
  const driver = process.platform === "win32"
    ? `cmd /d /c echo invoked>\"${marker}\"`
    : `sh -c 'printf invoked >\"${marker}\"'`;
  git(["config", "--local", "filter.pwn.smudge", driver], fixture.base);
  git(["config", "--local", "filter.pwn.required", "true"], fixture.base);
  const before = git(["rev-parse", "HEAD"], fixture.base);
  await assert.rejects(
    executeBasePreview(controller, preview),
    { code: "GIT_CONTROLLER_BASE_CONFIG_UNTRUSTED" },
  );
  assert.equal(fs.existsSync(marker), false);
  assert.equal(git(["rev-parse", "HEAD"], fixture.base), before);
  assert.notEqual(before, candidateSha);
});

test("candidate submodule outside the static allowlist is blocked before base HEAD changes", async () => {
  const fixture = createFixture("candidate-submodule-blocked");
  const malicious = createAdvertisedSubmodule(fixture, "malicious-module");
  const { controller, entry } = await makeController(fixture);
  await acceptRemote(controller, entry);
  const candidateSha = commitSubmoduleCandidate(fixture, {
    modulePath: "vendor/malicious",
    moduleUrl: pathToFileURL(malicious.remote).href,
    moduleSha: malicious.sha,
    message: "malicious submodule candidate",
  });
  await acceptRemote(controller, entry);
  const beforeHead = git(["rev-parse", "HEAD"], fixture.base);

  const preview = await controller.base.preview({
    repositoryId: entry.repositoryId,
    branch: "main",
  });

  assert.equal(preview.candidateSha, candidateSha);
  assert.equal(preview.eligible, false);
  assert.equal(preview.blockerCode, "BASE_SYNC_BLOCKED_CANDIDATE_SUBMODULE");
  assert.equal(preview.checks.candidateSubmodules.status, "BLOCKED");
  assert.equal(
    preview.checks.candidateSubmodules.reason,
    "CANDIDATE_SUBMODULE_URL_NOT_ALLOWED",
  );
  assert.equal(git(["rev-parse", "HEAD"], fixture.base), beforeHead);
  assert.equal(
    git([
      "for-each-ref",
      "--format=%(refname)",
      controllerBaseDestinationRef("origin", "main"),
    ], fixture.base),
    "",
  );
  await assert.rejects(
    executeBasePreview(controller, preview),
    (error) => error.code === "BASE_SYNC_BLOCKED_CANDIDATE_SUBMODULE",
  );
  assert.equal(git(["rev-parse", "HEAD"], fixture.base), beforeHead);
});

test("allowlisted submodule commit advertised by a head passes candidate preflight", async () => {
  const fixture = createFixture("candidate-submodule-allowed");
  const allowed = createAdvertisedSubmodule(fixture, "allowed-module");
  const commandLog = [];
  const { controller, entry } = await makeController(fixture, {
    commandLog,
    allowedSubmoduleUrls: [pathToFileURL(allowed.remote).href],
  });
  await acceptRemote(controller, entry);
  const candidateSha = commitSubmoduleCandidate(fixture, {
    modulePath: "vendor/allowed",
    moduleUrl: pathToFileURL(allowed.remote).href,
    moduleSha: allowed.sha,
    message: "allowlisted submodule candidate",
  });
  await acceptRemote(controller, entry);

  const preview = await controller.base.preview({
    repositoryId: entry.repositoryId,
    branch: "main",
  });

  assert.equal(preview.candidateSha, candidateSha);
  assert.equal(preview.eligible, true);
  assert.equal(preview.checks.candidateSubmodules.status, "VERIFIED");
  assert.equal(preview.checks.candidateSubmodules.submoduleCount, 1);
  assert.equal(preview.checks.candidateSubmodules.verifiedCommitCount, 1);
  const result = await executeBasePreview(controller, preview);
  assert.equal(result.ok, true);
  assert.equal(git(["rev-parse", "HEAD"], fixture.base), candidateSha);
  assert.ok(
    commandLog.filter((item) => item.commandId === "base.candidate-submodule-ls-remote").length >= 2,
  );
});

test("allowlisted submodule still rejects unmodeled gitmodules fields", async () => {
  const fixture = createFixture("candidate-submodule-command");
  const allowed = createAdvertisedSubmodule(fixture, "command-module");
  const { controller, entry } = await makeController(fixture, {
    allowedSubmoduleUrls: [pathToFileURL(allowed.remote).href],
  });
  await acceptRemote(controller, entry);
  const candidateSha = commitSubmoduleCandidate(fixture, {
    modulePath: "vendor/command",
    moduleUrl: pathToFileURL(allowed.remote).href,
    moduleSha: allowed.sha,
    message: "submodule candidate with unmodeled branch policy",
    extraConfig: "\tbranch = main\n",
  });
  await acceptRemote(controller, entry);
  const beforeHead = git(["rev-parse", "HEAD"], fixture.base);

  const preview = await controller.base.preview({
    repositoryId: entry.repositoryId,
    branch: "main",
  });

  assert.equal(preview.candidateSha, candidateSha);
  assert.equal(preview.eligible, false);
  assert.equal(preview.blockerCode, "BASE_SYNC_BLOCKED_CANDIDATE_SUBMODULE");
  assert.equal(
    preview.checks.candidateSubmodules.reason,
    "CANDIDATE_GITMODULES_UNPARSABLE",
  );
  assert.equal(git(["rev-parse", "HEAD"], fixture.base), beforeHead);
});
