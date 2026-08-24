import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash, generateKeyPairSync } from "node:crypto";
import test from "node:test";

process.env.NODE_ENV = "test";

const {
  __testBuildStoryWorkerGrant,
} = await import("../services/devbench/index.js");
const {
  prepareWorkerLaunch,
  renewStoryWorkerGrant,
} = await import("../services/worker-isolation.js");
const {
  assertBrokerStoryIsolationSpec,
  verifySignedWorkerLaunchEnvelope,
} = await import("../services/isolated-worker-broker.mjs");
const {
  workerIsolationGrantFingerprint,
} = await import("../services/worker-isolation-attestation.js");

test("DevBench 实际 grant 构造到 agent launch envelope 保留 exact scope、cwd 与全部边界哨兵", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "worker-integration-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const directories = {};
  for (const name of [
    "story-repository",
    "story-docs",
    "story-temp",
    "base",
    "mirror",
    "gateway-secret",
    "other-story",
  ]) {
    directories[name] = path.join(root, name);
    fs.mkdirSync(directories[name]);
  }
  const aclFingerprint = "a".repeat(64);
  const tab = {
    id: "CARB-integration-A",
    worktree: {
      repositoryMode: "INDEPENDENT_REPOSITORY",
      entries: [{
        repositoryPath: directories["story-repository"],
        baseRepositoryPath: directories.base,
        mirrorPath: directories.mirror,
        workerIdentity: "uid:1001",
        storyAclFingerprint: aclFingerprint,
      }],
    },
  };
  let resolverInput;
  const boundarySentinelResolver = (input) => {
    resolverInput = input;
    const denied = [
      ...input.writeDeniedRoots,
      ...input.inaccessibleRoots,
    ];
    return [...new Map(denied.map((deniedRoot) => [
      path.resolve(deniedRoot),
      deniedRoot,
    ])).values()].map((deniedRoot, index) => {
      const sentinelPath = path.join(
        root,
        `.devbench-worker-boundary-integration-${index}.sentinel`,
      );
      fs.writeFileSync(sentinelPath, `sentinel:${index}`);
      return { deniedRoot, sentinelPath };
    });
  };
  const grant = __testBuildStoryWorkerGrant(tab, {
    workspace: {
      cwd: directories["story-repository"],
      addDirs: [directories["story-temp"]],
    },
    storyDirectory: directories["story-docs"],
    projects: [],
    tabs: [{
      id: "CARB-integration-B",
      worktree: { entries: [{ repositoryPath: directories["other-story"] }] },
    }],
    sensitiveRoots: [directories["gateway-secret"]],
    inaccessibleEntries: [
      directories["gateway-secret"],
      directories.mirror,
      directories["other-story"],
    ].sort().map((rootPath) => ({
      root: rootPath,
      path: rootPath,
      type: "directory",
    })),
    boundarySentinelResolver,
  });

  assert.notEqual(directories["story-repository"], directories["story-docs"]);
  assert.ok(resolverInput.allowedRoots.includes(directories["story-repository"]));
  assert.ok(resolverInput.allowedRoots.includes(directories["story-docs"]));
  assert.ok(resolverInput.allowedRoots.includes(directories["story-temp"]));
  assert.ok(grant.inaccessibleRoots.includes(directories["other-story"]));
  assert.equal(
    grant.boundarySentinels.length,
    new Set([
      ...grant.writeDeniedRoots,
      ...grant.inaccessibleRoots,
    ].map((value) => path.resolve(value))).size,
  );

  const renewed = renewStoryWorkerGrant(grant);
  assert.deepEqual(
    renewed.boundarySentinels.map((item) => item.deniedRoot).sort(),
    grant.boundarySentinels.map((item) => item.deniedRoot).sort(),
  );
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const task = {
    id: "task-integration-A",
    storyScoped: true,
    cwd: directories["story-repository"],
    commandPolicy: "workspace",
  };
  const codexPath = path.join(root, "codex.exe");
  fs.writeFileSync(codexPath, "pinned codex", { mode: 0o700 });
  const launch = prepareWorkerLaunch({
    command: "codex",
    args: ["exec", "-"],
    cwd: task.cwd,
    task,
    isolation: {
      ok: true,
      level: "STRONG",
      launchMode: "broker",
      grant: renewed,
      launcher: {
        command: path.join(root, "native-launcher.exe"),
        args: [
          path.join(root, "isolated-worker-broker.mjs"),
          path.join(root, "worker-launch-consume-helper.mjs"),
        ],
        identity: "uid:1001",
        identityScope: "per-story",
        gatewayIdentity: "uid:1000",
        cliAllowlist: {
          codex: {
            id: "codex",
            mode: "native",
            executablePath: codexPath,
            executableSha256: createHash("sha256")
              .update(fs.readFileSync(codexPath))
              .digest("hex"),
          },
        },
      },
    },
    environment: { PATH: process.env.PATH || "", OPENAI_API_KEY: "must-not-cross" },
    testSigningPrivateKey: privateKey,
  });
  const encoded = launch.args.at(-1);
  const verified = verifySignedWorkerLaunchEnvelope(encoded, {
    testTrustAnchor: publicKey,
  });
  assert.equal(verified.spec.taskId, task.id);
  assert.equal(verified.spec.grant.cwd, directories["story-repository"]);
  assert.deepEqual(
    verified.spec.grant.boundarySentinels,
    renewed.boundarySentinels,
  );
  assert.match(launch.releaseChallenge, /^[0-9a-f-]{36}$/i);
  assert.equal(verified.spec.releaseChallenge, launch.releaseChallenge);
  assert.equal(launch.encodedLaunchEnvelope, launch.args.at(-1));
  assert.equal(assertBrokerStoryIsolationSpec(verified.spec, { production: true }), verified.spec);
  assert.equal("OPENAI_API_KEY" in launch.env, false);
});

test("DevBench default grant keeps Controller topology for subproject and secondary repository cwd", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "worker-controller-scope-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const directories = Object.fromEntries([
    "repository",
    "secondary-repository",
    "story-docs",
    "base",
    "other-story",
    "mirror",
    "secret",
  ].map((name) => {
    const target = path.join(root, name);
    fs.mkdirSync(target);
    return [name, target];
  }));
  const repositorySubproject = path.join(directories.repository, "subproject");
  fs.mkdirSync(repositorySubproject);
  const deniedRoots = [
    directories.base,
    directories["other-story"],
    directories.mirror,
    directories.secret,
  ];
  const boundarySentinels = deniedRoots.map((deniedRoot, index) => {
    const sentinelPath = path.join(
      root,
      `.devbench-worker-boundary-controller-${index}.sentinel`,
    );
    fs.writeFileSync(sentinelPath, `sentinel:${index}`);
    return { deniedRoot, sentinelPath };
  });
  const configPath = path.join(root, "worker-deployment-probe.json");
  fs.writeFileSync(configPath, JSON.stringify({
    schema: "devbench.worker-deployment-probe-config.v5",
    version: 5,
    generation: 7,
    stories: {
      "CARB-controller-scope": {
        cwd: directories.repository,
        allowedRoots: [
          directories.repository,
          directories["secondary-repository"],
        ],
        writeDeniedRoots: [directories.base],
        inaccessibleRoots: [
          directories["other-story"],
          directories.mirror,
          directories.secret,
        ],
        inaccessibleEntries: [
          directories["other-story"],
          directories.mirror,
          directories.secret,
        ].sort().map((rootPath) => ({
          root: rootPath,
          path: rootPath,
          type: "directory",
        })),
        boundarySentinels,
        aclFingerprints: ["a".repeat(64)],
        workerIdentity: "uid:1001",
      },
    },
  }), { mode: 0o600 });
  const tab = {
    id: "CARB-controller-scope",
    worktree: {
      repositoryMode: "INDEPENDENT_REPOSITORY",
      entries: [{
        repositoryPath: directories.repository,
        workerIdentity: "uid:9999",
        storyAclFingerprint: "b".repeat(64),
      }, {
        repositoryPath: directories["secondary-repository"],
        workerIdentity: "uid:9999",
        storyAclFingerprint: "b".repeat(64),
      }],
    },
  };

  const grantOptions = {
    storyDirectory: directories["story-docs"],
    projects: [],
    tabs: [],
    sensitiveRoots: [],
    controllerProbeOptions: {
      configPath,
      platform: "linux",
      gatewayIdentity: "uid:1000",
      aclVerifier: () => true,
    },
  };
  const grant = __testBuildStoryWorkerGrant(tab, {
    ...grantOptions,
    workspace: {
      cwd: repositorySubproject,
      addDirs: [directories["story-docs"]],
    },
  });
  const secondaryGrant = __testBuildStoryWorkerGrant(tab, {
    ...grantOptions,
    workspace: {
      cwd: directories["secondary-repository"],
      addDirs: [],
    },
  });

  assert.equal(grant.topologyGeneration, 7);
  assert.equal(grant.workerIdentity, "uid:1001");
  assert.equal(grant.cwd, repositorySubproject);
  assert.equal(secondaryGrant.cwd, directories["secondary-repository"]);
  assert.equal(grant.topologyCwd, directories.repository);
  assert.equal(secondaryGrant.topologyCwd, directories.repository);
  assert.deepEqual(grant.allowedRoots, [
    directories.repository,
    directories["secondary-repository"],
  ]);
  assert.deepEqual(secondaryGrant.allowedRoots, grant.allowedRoots);
  assert.equal(grant.allowedRoots.includes(directories["story-docs"]), false);
  assert.deepEqual(grant.writeDeniedRoots, [directories.base]);
  assert.deepEqual(grant.inaccessibleRoots, [
    directories["other-story"],
    directories.mirror,
    directories.secret,
  ]);
  assert.deepEqual(grant.aclFingerprints, ["a".repeat(64)]);
  assert.equal(
    workerIsolationGrantFingerprint(grant),
    workerIsolationGrantFingerprint(secondaryGrant),
  );
});
