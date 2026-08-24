import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "git-controller-registry-"));
process.env.GATEWAY_DB_PATH = path.join(root, "gateway.db");

const {
  createGitController,
  createRepositoryLeaseManager,
  RepositoryRegistry,
  fingerprintRemote,
} = await import("../services/devbench/git-controller/index.js");
const persistence = await import("../db/sqlite.js");
const { runGitFile } = await import("../services/devbench/git-controller/path-security.js");

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

function initRemote(name = "remote.git") {
  const remote = path.join(root, name);
  git(["init", "--bare", remote]);
  return remote;
}

function seedRemote(remote, name = "seed") {
  const seed = path.join(root, name);
  fs.mkdirSync(seed, { recursive: true });
  git(["init"], seed);
  git(["config", "user.name", "Controller Test"], seed);
  git(["config", "user.email", "controller@example.test"], seed);
  git(["checkout", "-b", "main"], seed);
  fs.writeFileSync(path.join(seed, "README.md"), "initial\n");
  git(["add", "README.md"], seed);
  git(["commit", "-m", "initial"], seed);
  git(["remote", "add", "origin", remote], seed);
  git(["push", "-u", "origin", "main"], seed);
  return seed;
}

function cloneBase(remote, name) {
  const base = path.join(root, name);
  git(["clone", "--branch", "main", remote, base]);
  git(["config", "user.name", "Controller Test"], base);
  git(["config", "user.email", "controller@example.test"], base);
  return base;
}

function definition(basePath, remote, overrides = {}) {
  return {
    logicalDefinitionId: "appMarket",
    displayName: "AppMarket",
    basePath,
    remoteId: "origin",
    expectedRemoteUrls: [remote],
    allowedBranches: ["main"],
    ...overrides,
  };
}

test("Registry derives a stable physical id and preserves logical definitions", async () => {
  const remote = initRemote("stable.git");
  seedRemote(remote, "stable-seed");
  const base = cloneBase(remote, "stable-base");
  const dataRoot = path.join(root, "stable-data");
  fs.mkdirSync(dataRoot);

  const first = await RepositoryRegistry.create({
    dataRoot,
    definitions: [definition(base, remote)],
  });
  const second = await RepositoryRegistry.create({
    dataRoot,
    definitions: [definition(base, remote)],
  });
  const firstEntry = first.list()[0];
  const secondEntry = second.list()[0];

  assert.match(firstEntry.repositoryId, /^repo-[0-9a-f]{64}$/);
  assert.equal(firstEntry.repositoryId, secondEntry.repositoryId);
  assert.deepEqual(firstEntry.logicalDefinitionIds, ["appMarket"]);
  assert.equal(first.getByLogicalDefinitionId("appMarket").repositoryId, firstEntry.repositoryId);
  assert.equal(first.getByBasePath(base).repositoryId, firstEntry.repositoryId);
  assert.equal(firstEntry.remoteFingerprint, fingerprintRemote(remote));
  assert.equal(
    firstEntry.baseGitCommonPath,
    fs.realpathSync.native(path.join(base, ".git")),
  );
  assert.equal(
    persistence.getGitControllerRepository(firstEntry.repositoryId).baseGitCommonRealpath,
    firstEntry.baseGitCommonPath,
  );
  assert.equal(firstEntry.baseOwnershipMode, "MANAGED_SYNC");
  assert.equal(firstEntry.baseSyncPolicy.allowAutomaticStash, false);
  await assert.rejects(
    RepositoryRegistry.create({
      dataRoot,
      definitions: [definition(base, remote, {
        baseSyncPolicy: {
          allowRemoteRewind: true,
        },
      })],
    }),
    (error) => error.code === "GIT_CONTROLLER_UNSAFE_POLICY",
  );
});

test("Registry validates, normalizes and uniquely binds a protected publication ledger", async () => {
  const remote = initRemote("publication-policy.git");
  const seed = seedRemote(remote, "publication-policy-seed");
  const publishedSha = git(["rev-parse", "HEAD"], seed);
  const base = cloneBase(remote, "publication-policy-base");
  const dataRoot = path.join(root, "publication-policy-data");
  fs.mkdirSync(dataRoot);
  const publicationPolicy = {
    schemaVersion: 1,
    mode: "PROTECTED_EXACT_SHA_POSITIVE_LEDGER",
    evidenceId: "release-ledger:registry-test",
    publishedCommitShas: [publishedSha.toUpperCase(), publishedSha],
  };

  const registry = await RepositoryRegistry.create({
    dataRoot,
    definitions: [definition(base, remote, { publicationPolicy })],
  });
  const entry = registry.list()[0];
  assert.equal(entry.publicationPolicy.evidenceId, publicationPolicy.evidenceId);
  assert.deepEqual(entry.publicationPolicy.publishedCommitShas, [publishedSha]);
  assert.match(entry.publicationPolicy.evidenceDigest, /^[0-9a-f]{64}$/);
  assert.equal(Object.isFrozen(entry.publicationPolicy), true);
  assert.equal(Object.isFrozen(entry.publicationPolicy.publishedCommitShas), true);

  const invalidDataRoot = path.join(root, "publication-policy-invalid-data");
  fs.mkdirSync(invalidDataRoot);
  await assert.rejects(
    RepositoryRegistry.create({
      dataRoot: invalidDataRoot,
      definitions: [definition(base, remote, {
        publicationPolicy: {
          ...publicationPolicy,
          publishedCommitShas: [publishedSha.slice(0, 12)],
        },
      })],
    }),
    (error) => error.code === "GIT_CONTROLLER_PUBLICATION_POLICY_INVALID",
  );

  await assert.rejects(
    RepositoryRegistry.create({
      dataRoot,
      definitions: [
        definition(base, remote, {
          logicalDefinitionId: "publication-policy-a",
          publicationPolicy,
        }),
        definition(base, remote, {
          logicalDefinitionId: "publication-policy-b",
          publicationPolicy: {
            ...publicationPolicy,
            evidenceId: "release-ledger:conflicting-source",
          },
        }),
      ],
    }),
    (error) => error.code === "GIT_CONTROLLER_PUBLICATION_POLICY_CONFLICT",
  );
});

test("Registry does not silently collapse one logical definition across physical checkouts", async () => {
  const remote = initRemote("ambiguous.git");
  seedRemote(remote, "ambiguous-seed");
  const baseA = cloneBase(remote, "ambiguous-base-a");
  const baseB = cloneBase(remote, "ambiguous-base-b");
  const dataRoot = path.join(root, "ambiguous-data");
  fs.mkdirSync(dataRoot);

  const registry = await RepositoryRegistry.create({
    dataRoot,
    definitions: [
      definition(baseA, remote),
      definition(baseB, remote),
    ],
  });

  assert.equal(registry.list().length, 2);
  assert.throws(
    () => registry.getByLogicalDefinitionId("appMarket"),
    (error) => error.code === "GIT_CONTROLLER_LOGICAL_REPOSITORY_AMBIGUOUS",
  );
  assert.equal(
    registry.getByLogicalDefinitionId("appMarket", { basePath: baseA }).basePath,
    fs.realpathSync.native(baseA),
  );
  assert.equal(registry.getByBasePath(baseB).basePath, fs.realpathSync.native(baseB));
});

test("Registry rejects different physical repositories sharing one managed mirror path", async () => {
  const remote = initRemote("mirror-path-conflict.git");
  seedRemote(remote, "mirror-path-conflict-seed");
  const baseA = cloneBase(remote, "mirror-path-conflict-base-a");
  const baseB = cloneBase(remote, "mirror-path-conflict-base-b");
  const dataRoot = path.join(root, "mirror-path-conflict-data");
  const mirrorPath = path.join(dataRoot, "shared", "repo.git");
  fs.mkdirSync(dataRoot);

  await assert.rejects(
    RepositoryRegistry.create({
      dataRoot,
      definitions: [
        definition(baseA, remote, {
          logicalDefinitionId: "mirror-conflict-a",
          mirrorPath,
        }),
        definition(baseB, remote, {
          logicalDefinitionId: "mirror-conflict-b",
          mirrorPath,
        }),
      ],
    }),
    (error) => error.code === "GIT_CONTROLLER_MIRROR_PATH_CONFLICT",
  );
});

test("Registry keeps a persisted mirror path reserved after its definition is removed", async () => {
  const remote = initRemote("persisted-mirror-path-conflict.git");
  seedRemote(remote, "persisted-mirror-path-conflict-seed");
  const baseA = cloneBase(remote, "persisted-mirror-path-conflict-base-a");
  const baseB = cloneBase(remote, "persisted-mirror-path-conflict-base-b");
  const dataRoot = path.join(root, "persisted-mirror-path-conflict-data");
  const mirrorPath = path.join(dataRoot, "shared", "repo.git");
  fs.mkdirSync(dataRoot);

  const first = await RepositoryRegistry.create({
    dataRoot,
    definitions: [definition(baseA, remote, {
      logicalDefinitionId: "persisted-mirror-conflict-a",
      mirrorPath,
    })],
  });
  const firstEntry = first.list()[0];
  assert.equal(
    persistence.getGitControllerRepository(firstEntry.repositoryId).mirrorRealpath,
    firstEntry.mirrorPath,
  );

  await assert.rejects(
    RepositoryRegistry.create({
      dataRoot,
      definitions: [definition(baseB, remote, {
        logicalDefinitionId: "persisted-mirror-conflict-b",
        mirrorPath,
      })],
    }),
    (error) => (
      error.code === "GIT_CONTROLLER_MIRROR_PATH_CONFLICT"
      && error.details.conflictingRepositoryId === firstEntry.repositoryId
      && error.details.persistedBinding === true
    ),
  );
});

test("Registry rejects an origin not present in the shared remote allowlist", async () => {
  const expectedRemote = initRemote("expected.git");
  const maliciousRemote = initRemote("malicious.git");
  seedRemote(maliciousRemote, "malicious-seed");
  const base = cloneBase(maliciousRemote, "malicious-base");
  const dataRoot = path.join(root, "malicious-data");
  fs.mkdirSync(dataRoot);

  await assert.rejects(
    RepositoryRegistry.create({
      dataRoot,
      definitions: [definition(base, expectedRemote)],
    }),
    (error) => error.code === "GIT_CONTROLLER_REMOTE_NOT_REGISTERED",
  );
});

test("Registry detects remote fingerprint drift after registration", async () => {
  const remote = initRemote("drift-original.git");
  const replacement = initRemote("drift-replacement.git");
  seedRemote(remote, "drift-seed");
  const base = cloneBase(remote, "drift-base");
  const dataRoot = path.join(root, "drift-data");
  fs.mkdirSync(dataRoot);
  const registry = await RepositoryRegistry.create({
    dataRoot,
    definitions: [definition(base, remote)],
  });
  const entry = registry.list()[0];

  git(["remote", "set-url", "origin", replacement], base);
  await assert.rejects(
    registry.verify(entry.repositoryId),
    (error) => error.code === "GIT_CONTROLLER_REMOTE_FINGERPRINT_DRIFT",
  );
});

test("Registry persists and rejects canonical base Git common-dir drift", async () => {
  const remote = initRemote("common-dir-drift.git");
  seedRemote(remote, "common-dir-drift-seed");
  const base = cloneBase(remote, "common-dir-drift-base");
  const dataRoot = path.join(root, "common-dir-drift-data");
  const driftedCommon = path.join(base, "drifted-common");
  fs.mkdirSync(dataRoot);
  fs.mkdirSync(driftedCommon);
  let drift = false;
  const gitRunner = async (input) => {
    const result = await runGitFile(input);
    if (drift && input.commandId === "registry.base-git-common-dir") {
      return { ...result, stdout: `${driftedCommon}\n` };
    }
    return result;
  };
  const registry = await RepositoryRegistry.create({
    dataRoot,
    definitions: [definition(base, remote)],
    gitRunner,
  });
  const entry = registry.list()[0];
  assert.equal(
    persistence.getGitControllerRepository(entry.repositoryId).baseGitCommonRealpath,
    entry.baseGitCommonPath,
  );
  drift = true;
  await assert.rejects(
    registry.verify(entry.repositoryId),
    (error) => error.code === "GIT_CONTROLLER_BASE_GIT_COMMON_DRIFT",
  );
});

test("Registry requires an explicit shared remote allowlist and allowed branch", async () => {
  const remote = initRemote("required.git");
  seedRemote(remote, "required-seed");
  const base = cloneBase(remote, "required-base");
  const dataRoot = path.join(root, "required-data");
  fs.mkdirSync(dataRoot);

  await assert.rejects(
    RepositoryRegistry.create({
      dataRoot,
      definitions: [{
        logicalDefinitionId: "missingRemote",
        basePath: base,
        remoteId: "origin",
        allowedBranches: ["main"],
      }],
    }),
    (error) => error.code === "GIT_CONTROLLER_EXPECTED_REMOTE_REQUIRED",
  );
});

test("Registry canonicalizes and freezes the static submodule remote allowlist in its config digest", async () => {
  const remote = initRemote("submodule-policy.git");
  const submoduleRemote = initRemote("submodule-policy-allowed.git");
  seedRemote(remote, "submodule-policy-seed");
  const base = cloneBase(remote, "submodule-policy-base");
  const dataRoot = path.join(root, "submodule-policy-data");
  fs.mkdirSync(dataRoot);

  const withPolicy = await RepositoryRegistry.create({
    dataRoot,
    definitions: [definition(base, remote, {
      allowedSubmoduleUrls: [submoduleRemote],
      submoduleAllowlist: [{ url: submoduleRemote }],
    })],
  });
  const entry = withPolicy.list()[0];
  const firstDigest = persistence.getGitControllerRepository(entry.repositoryId).configDigest;

  assert.deepEqual(entry.allowedSubmoduleRemoteFingerprints, [fingerprintRemote(submoduleRemote)]);
  assert.equal(entry.allowedSubmoduleRemotes.length, 1);
  assert.equal(Object.isFrozen(entry.allowedSubmoduleRemoteFingerprints), true);
  assert.equal(Object.isFrozen(entry.allowedSubmoduleRemotes), true);
  assert.equal(Object.isFrozen(entry.allowedSubmoduleRemotes[0]), true);

  await RepositoryRegistry.create({
    dataRoot,
    definitions: [definition(base, remote)],
  });
  const withoutPolicyDigest = persistence
    .getGitControllerRepository(entry.repositoryId)
    .configDigest;
  assert.notEqual(withoutPolicyDigest, firstDigest);
});

test("Registry can isolate one bad local binding without weakening strict default behavior", async () => {
  const expectedRemote = initRemote("partial-expected.git");
  const unexpectedRemote = initRemote("partial-unexpected.git");
  seedRemote(expectedRemote, "partial-good-seed");
  seedRemote(unexpectedRemote, "partial-bad-seed");
  const goodBase = cloneBase(expectedRemote, "partial-good-base");
  const badBase = cloneBase(unexpectedRemote, "partial-bad-base");
  const dataRoot = path.join(root, "partial-data");
  fs.mkdirSync(dataRoot);

  const controller = await createGitController({
    dataRoot,
    continueOnDefinitionError: true,
    definitions: [
      definition(badBase, expectedRemote, {
        logicalDefinitionId: "sharedLogical",
        displayName: "Bad local binding",
      }),
      definition(goodBase, expectedRemote, {
        logicalDefinitionId: "sharedLogical",
        displayName: "Good local binding",
      }),
    ],
  });
  const { registry } = controller;

  assert.equal(registry.list().length, 1);
  assert.equal(controller.registrationErrors, registry.registrationErrors);
  assert.equal(registry.registrationErrors.length, 1);
  assert.deepEqual(
    {
      logicalDefinitionId: registry.registrationErrors[0].logicalDefinitionId,
      displayName: registry.registrationErrors[0].displayName,
      code: registry.registrationErrors[0].code,
    },
    {
      logicalDefinitionId: "sharedLogical",
      displayName: "Bad local binding",
      code: "GIT_CONTROLLER_REMOTE_NOT_REGISTERED",
    },
  );
  assert.equal(JSON.stringify(registry.registrationErrors).includes(unexpectedRemote), false);
  assert.equal(
    registry.getByLogicalDefinitionId("sharedLogical", { basePath: goodBase }).basePath,
    fs.realpathSync.native(goodBase),
  );
  assert.throws(
    () => registry.getByLogicalDefinitionId("sharedLogical", { basePath: badBase }),
    (error) => error.code === "GIT_CONTROLLER_BASE_NOT_REGISTERED",
  );
});

test("repository lease recovers only an expired dead-owner OS lock and advances fencing", async () => {
  const remote = initRemote("lease.git");
  seedRemote(remote, "lease-seed");
  const base = cloneBase(remote, "lease-base");
  const dataRoot = path.join(root, "lease-data");
  fs.mkdirSync(dataRoot);
  const registry = await RepositoryRegistry.create({
    dataRoot,
    definitions: [definition(base, remote, { logicalDefinitionId: "leaseLogical" })],
  });
  const entry = registry.list()[0];
  const expiredAt = Date.now() - 10_000;
  const oldLeaseId = randomUUID();
  const old = persistence.claimGitControllerRepositoryLease({
    repositoryId: entry.repositoryId,
    leaseId: oldLeaseId,
    operationId: randomUUID(),
    kind: "mirror-refresh",
    ownerInstance: "dead-owner",
    ownerPid: 2_147_483_647,
    now: expiredAt,
    ttlMs: 1000,
  });
  assert.equal(old.ok, true);
  fs.mkdirSync(path.dirname(entry.lockPath), { recursive: true });
  fs.writeFileSync(entry.lockPath, `${JSON.stringify({
    schemaVersion: 2,
    lockRevision: 1,
    gitChildren: {},
    repositoryId: entry.repositoryId,
    leaseId: oldLeaseId,
    operationId: old.lease.operationId,
    kind: "mirror-refresh",
    ownerInstance: "dead-owner",
    ownerPid: 2_147_483_647,
    hostname: os.hostname(),
    fencingToken: old.lease.fencingToken,
    acquiredAt: expiredAt,
    heartbeatAt: expiredAt,
    expiresAt: expiredAt + 1000,
  })}\n`);
  const manager = createRepositoryLeaseManager({
    dataRoot,
    ownerInstance: `new-owner-${randomUUID()}`,
    ttlMs: 10_000,
  });
  const lease = manager.acquire(entry, {
    operationId: randomUUID(),
    kind: "base-sync",
  });
  try {
    assert.ok(lease.fencingToken > old.lease.fencingToken);
    lease.assertCurrent();
    assert.equal(
      fs.readdirSync(path.dirname(entry.lockPath))
        .some((name) => name.startsWith("controller.lock.stale.")),
      true,
    );
    assert.equal(
      persistence.listGitControllerAudit({ repositoryId: entry.repositoryId })
        .some((row) => row.commandId === "repository.lease.recover"),
      true,
    );
  } finally {
    lease.release();
  }
});
