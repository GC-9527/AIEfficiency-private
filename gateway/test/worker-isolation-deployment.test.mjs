import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash, createPublicKey, generateKeyPairSync } from "node:crypto";
import test from "node:test";
import {
  ISOLATED_WORKER_BROKER_PATH,
  WORKER_LAUNCH_CONSUME_HELPER_PATH,
  WORKER_LAUNCHER_CONFIG_SCHEMA,
  createStoryWorkerGrant,
  loadManagedWorkerLauncherConfig,
} from "../services/worker-isolation.js";
import {
  createManagedWorkerProbeProtectionCallbacks,
  formatWorkerDeploymentFailure,
  loadManagedWorkerDeploymentProbeConfig,
  reconcileManagedWorkerDeploymentProbeConfig,
  renewControllerManagedStoryWorkerGrant,
  resolveControllerManagedWorkerDeploymentProbeScopeForGrant,
  resolveWorkerBoundarySentinelsForGrant,
  runWorkerIsolationDeploymentPreflight,
} from "../services/worker-isolation-deployment.js";
import {
  assertBrokerStoryIsolationSpec,
  assertLowPrivilegeWorkerIdentity,
  verifySignedWorkerLaunchEnvelope,
} from "../services/isolated-worker-broker.mjs";
import {
  WORKER_DEPLOYMENT_ATTESTATION_MAX_AGE_MS,
  verifyWorkerDeploymentAttestation,
  workerIsolationGrantFingerprint,
} from "../services/worker-isolation-attestation.js";

process.env.NODE_ENV = "test";

const WINDOWS_GATEWAY = "sid:S-1-5-21-1000";
const WINDOWS_WORKER = "sid:S-1-5-21-1001";
const FIXED_NOW = Date.parse("2026-07-30T00:00:00.000Z");

function fixture(t, {
  platform = "win32",
  workerIdentity = WINDOWS_WORKER,
  gatewayIdentity = WINDOWS_GATEWAY,
  launcherName = platform === "win32" ? "managed-worker-launcher.exe" : "managed-worker-launcher",
  launcherArgs = [ISOLATED_WORKER_BROKER_PATH, WORKER_LAUNCH_CONSUME_HELPER_PATH],
} = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "worker-deployment-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const directories = Object.fromEntries(
    ["story", "base", "other-story", "mirror", "secrets"]
      .map((name) => {
        const target = path.join(root, name);
        fs.mkdirSync(target, { recursive: true });
        return [name, target];
      }),
  );
  const launcher = path.join(root, launcherName);
  fs.writeFileSync(launcher, "pinned native launcher", { mode: 0o700 });
  const codex = path.join(root, platform === "win32" ? "codex.exe" : "codex");
  fs.writeFileSync(codex, "pinned codex", { mode: 0o700 });
  const launcherSha256 = createHash("sha256").update(fs.readFileSync(launcher)).digest("hex");
  const launcherConfigPath = path.join(root, "worker-launcher.json");
  fs.writeFileSync(launcherConfigPath, JSON.stringify({
    schema: WORKER_LAUNCHER_CONFIG_SCHEMA,
    version: 1,
    identityScope: "per-story",
    command: launcher,
    args: launcherArgs,
    brokerPath: ISOLATED_WORKER_BROKER_PATH,
    brokerSha256: createHash("sha256")
      .update(fs.readFileSync(ISOLATED_WORKER_BROKER_PATH))
      .digest("hex"),
    consumeHelperPath: WORKER_LAUNCH_CONSUME_HELPER_PATH,
    consumeHelperSha256: createHash("sha256")
      .update(fs.readFileSync(WORKER_LAUNCH_CONSUME_HELPER_PATH))
      .digest("hex"),
    cliAllowlist: {
      codex: {
        mode: "native",
        executablePath: codex,
        executableSha256: createHash("sha256")
          .update(fs.readFileSync(codex))
          .digest("hex"),
      },
    },
    launcherSha256,
    expectedIdentity: {
      "story-1": workerIdentity,
    },
  }), { mode: 0o600 });
  const deniedRoots = [
    directories.base,
    directories["other-story"],
    directories.mirror,
    directories.secrets,
  ];
  const boundarySentinels = deniedRoots.map((deniedRoot, index) => {
    const sentinelPath = path.join(root, `.devbench-worker-boundary-${index}.sentinel`);
    fs.writeFileSync(sentinelPath, `sentinel:${index}`, { mode: 0o600 });
    return { deniedRoot, sentinelPath };
  });
  const inaccessibleEntries = [
    directories["other-story"],
    directories.mirror,
    directories.secrets,
  ]
    .sort((left, right) => left.toLowerCase().localeCompare(right.toLowerCase()))
    .map((rootPath) => ({ root: rootPath, path: rootPath, type: "directory" }));
  const probeConfigPath = path.join(root, "worker-deployment-probe.json");
  fs.writeFileSync(probeConfigPath, JSON.stringify({
    schema: "devbench.worker-deployment-probe-config.v5",
    version: 5,
    generation: 1,
    stories: {
      "story-1": {
        cwd: directories.story,
        allowedRoots: [directories.story],
        writeDeniedRoots: [directories.base],
        inaccessibleRoots: [
          directories["other-story"],
          directories.mirror,
          directories.secrets,
        ],
        inaccessibleEntries,
        boundarySentinels,
        aclFingerprints: ["a".repeat(64)],
        workerIdentity,
      },
    },
  }), { mode: 0o600 });
  return {
    root,
    platform,
    workerIdentity,
    gatewayIdentity,
    launcher,
    codex,
    launcherConfigPath,
    probeConfigPath,
    directories,
    boundarySentinels,
    inaccessibleEntries,
  };
}

function probeOutput(spec, overrides = {}) {
  const result = {
    schema: "devbench.worker-deployment-probe-result.v3",
    version: 3,
    ok: true,
    operation: "deployment-probe",
    launchNonce: spec.launchNonce,
    storyId: spec.grant.storyId,
    expectedIdentity: spec.expectedIdentity,
    actualIdentity: spec.expectedIdentity,
    checks: {
      lowPrivilegeIdentity: true,
      storyRepositoryReadWrite: true,
      writeDeniedRootsNotWritable: true,
      writeDeniedTreesNotWritable: true,
      inaccessibleRootsInaccessible: true,
      inaccessibleEntriesInaccessible: true,
      independentGitCommonDir: true,
      launcherInstanceChannelBound: true,
    },
    ...overrides,
  };
  return `DEVBENCH_WORKER_DEPLOYMENT_PROBE=${Buffer.from(JSON.stringify(result), "utf8").toString("base64url")}\n`;
}

function runOptions(tree, privateKey, overrides = {}) {
  return {
    storyId: "story-1",
    now: FIXED_NOW,
    platform: tree.platform,
    gatewayIdentity: tree.gatewayIdentity,
    launcherConfigPath: tree.launcherConfigPath,
    probeConfigPath: tree.probeConfigPath,
    testSigningPrivateKey: privateKey,
    testTrustAnchor: createPublicKey(privateKey),
    aclVerifier: () => true,
    attestationAclVerifier: () => true,
    attestationPath: path.join(tree.root, "worker-deployment-attestations.json"),
    identityExecFile: () => "worker-account",
    environment: {
      PATH: process.env.PATH || "",
      HOME: "gateway-home",
      OPENAI_API_KEY: "must-not-cross",
      DEVBENCH_WORKER_LAUNCHER: "must-not-cross",
      SAFE_FLAG: "preserved",
    },
    ...overrides,
  };
}

function grantForTree(
  tree,
  workerIdentity = tree.workerIdentity,
  topologyGeneration = 1,
  {
    cwd = tree.directories.story,
    topologyCwd = tree.directories.story,
    allowedRoots = [tree.directories.story],
  } = {},
) {
  return createStoryWorkerGrant({
    storyId: "story-1",
    repositoryMode: "INDEPENDENT_REPOSITORY",
    cwd,
    topologyCwd,
    allowedRoots,
    writeDeniedRoots: [tree.directories.base],
    inaccessibleRoots: [
      tree.directories["other-story"],
      tree.directories.mirror,
      tree.directories.secrets,
    ],
    inaccessibleEntries: tree.inaccessibleEntries,
    boundarySentinels: tree.boundarySentinels,
    workerIdentity,
    aclFingerprints: ["a".repeat(64)],
    topologyGeneration,
    readOnly: false,
    now: FIXED_NOW,
    ttlMs: 60_000,
  });
}

test("probe topology generation is part of the signed grant scope fingerprint", (t) => {
  const tree = fixture(t);
  const first = grantForTree(tree, tree.workerIdentity, 1);
  const second = grantForTree(tree, tree.workerIdentity, 2);
  assert.notEqual(
    workerIsolationGrantFingerprint(first),
    workerIsolationGrantFingerprint(second),
  );
});

test("runtime subproject and secondary repository cwd keep the Controller topology fingerprint", (t) => {
  const tree = fixture(t);
  const subproject = path.join(tree.directories.story, "subproject");
  const secondaryRepository = path.join(tree.root, "secondary-repository");
  fs.mkdirSync(subproject);
  fs.mkdirSync(secondaryRepository);
  const topology = {
    topologyCwd: tree.directories.story,
    allowedRoots: [tree.directories.story, secondaryRepository],
  };
  const subprojectGrant = grantForTree(
    tree,
    tree.workerIdentity,
    1,
    { ...topology, cwd: subproject },
  );
  const secondaryGrant = grantForTree(
    tree,
    tree.workerIdentity,
    1,
    { ...topology, cwd: secondaryRepository },
  );

  assert.equal(subprojectGrant.cwd, subproject);
  assert.equal(secondaryGrant.cwd, secondaryRepository);
  assert.equal(subprojectGrant.topologyCwd, tree.directories.story);
  assert.equal(secondaryGrant.topologyCwd, tree.directories.story);
  assert.deepEqual(subprojectGrant.allowedRoots, topology.allowedRoots);
  assert.deepEqual(secondaryGrant.allowedRoots, topology.allowedRoots);
  assert.equal(
    workerIsolationGrantFingerprint(subprojectGrant),
    workerIsolationGrantFingerprint(secondaryGrant),
  );
});

test("Controller production probe protection uses fixed Windows tools and verifies the parent chain", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "worker-probe-protection-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const target = path.join(root, "worker-deployment-probe.json");
  fs.writeFileSync(target, "{}\n", { mode: 0o600 });
  const calls = [];
  const callbacks = createManagedWorkerProbeProtectionCallbacks({
    controllerIdentity: "sid:S-1-5-21-999",
    gatewayIdentities: [WINDOWS_GATEWAY],
    workerIdentities: { "story-1": WINDOWS_WORKER },
    platform: "win32",
    execFile(command, args, options) {
      calls.push({ command, args, options });
      return path.win32.basename(command).toLowerCase() === "powershell.exe"
        ? "SAFE\r\n"
        : "";
    },
  });

  callbacks.configProtector(target);
  assert.equal(calls.length, 2);
  assert.ok(calls.every(({ command }) => path.win32.isAbsolute(command)));
  assert.ok(calls.every(({ command }) => (
    path.win32.basename(command).toLowerCase() === "icacls.exe"
  )));
  assert.ok(calls.every(({ options }) => (
    path.win32.isAbsolute(options.env.PATH)
    && path.win32.basename(options.env.PATH).toLowerCase() === "system32"
  )));

  assert.equal(callbacks.configVerifier(target), true);
  const verifierCall = calls.at(-1);
  assert.equal(path.win32.basename(verifierCall.command).toLowerCase(), "powershell.exe");
  assert.match(verifierCall.args.at(-1), /parent chain has an unsafe writer/);
  assert.equal(callbacks.configAclVerifier(target), true);
  assert.throws(
    () => createManagedWorkerProbeProtectionCallbacks({
      controllerIdentity: "sid:S-1-5-21-999",
      gatewayIdentities: [WINDOWS_GATEWAY],
      workerIdentities: { "story-1": WINDOWS_GATEWAY },
      platform: "win32",
      execFile: () => "",
    }),
    (error) => error.code === "WORKER_DEPLOYMENT_PROTECTION_IDENTITY_POLICY_INVALID",
  );
});

test("静态配置通过也必须保持 BLOCKED，不能伪装成已切换 Worker 身份", (t) => {
  const tree = fixture(t);
  const { privateKey } = generateKeyPairSync("ed25519");
  const result = runWorkerIsolationDeploymentPreflight(runOptions(tree, privateKey, {
    staticOnly: true,
  }));
  assert.deepEqual(result, {
    ok: false,
    status: "BLOCKED",
    code: "WORKER_DEPLOYMENT_RUNTIME_PROBE_REQUIRED",
    storyId: "story-1",
    expectedIdentity: WINDOWS_WORKER,
    identityProbe: "NOT_RUN",
    isolationLevel: "DEGRADED",
  });
});

test("legacy v3/v4 probe configs are rejected by the runtime loader", (t) => {
  const tree = fixture(t);
  const document = JSON.parse(fs.readFileSync(tree.probeConfigPath, "utf8"));
  for (const version of [3, 4]) {
    document.schema = `devbench.worker-deployment-probe-config.v${version}`;
    document.version = version;
    fs.writeFileSync(tree.probeConfigPath, JSON.stringify(document));
    assert.throws(
      () => loadManagedWorkerDeploymentProbeConfig(tree.probeConfigPath, {
        platform: "win32",
        gatewayIdentity: WINDOWS_GATEWAY,
        aclVerifier: () => true,
      }),
      (error) => error.code === "WORKER_DEPLOYMENT_CONFIG_SCHEMA_INVALID",
    );
  }
  document.schema = "devbench.worker-deployment-probe-config.v5";
  document.version = 5;
  delete document.stories["story-1"].inaccessibleEntries;
  fs.writeFileSync(tree.probeConfigPath, JSON.stringify(document));
  assert.throws(
    () => loadManagedWorkerDeploymentProbeConfig(tree.probeConfigPath, {
      platform: "win32",
      gatewayIdentity: WINDOWS_GATEWAY,
      aclVerifier: () => true,
    }),
    (error) => error.code === "WORKER_DEPLOYMENT_CONFIG_SCHEMA_INVALID",
  );
});

test("Controller legacy migration rejects hardlinks and unsafe protected-file ACL", (t) => {
  const tree = fixture(t);
  const document = JSON.parse(fs.readFileSync(tree.probeConfigPath, "utf8"));
  document.schema = "devbench.worker-deployment-probe-config.v4";
  document.version = 4;
  for (const probe of Object.values(document.stories)) delete probe.inaccessibleEntries;
  fs.writeFileSync(tree.probeConfigPath, JSON.stringify(document));
  const callbacks = {
    configPath: tree.probeConfigPath,
    expectedPreviousGeneration: 1,
    gatewayIdentities: [WINDOWS_GATEWAY],
    sentinelProtector: () => {},
    sentinelVerifier: () => true,
    configProtector: () => {},
    configVerifier: () => true,
    configAclVerifier: () => true,
  };
  const hardlink = path.join(tree.root, "probe-hardlink.json");
  fs.linkSync(tree.probeConfigPath, hardlink);
  assert.throws(
    () => reconcileManagedWorkerDeploymentProbeConfig({
      generation: 2,
      stories: [],
    }, callbacks),
    (error) => error.code === "WORKER_DEPLOYMENT_CONFIG_INVALID",
  );
  fs.unlinkSync(hardlink);
  assert.throws(
    () => reconcileManagedWorkerDeploymentProbeConfig({
      generation: 2,
      stories: [],
    }, {
      ...callbacks,
      configAclVerifier: () => false,
    }),
    (error) => error.code === "WORKER_DEPLOYMENT_CONFIG_ACL_UNSAFE",
  );
});

test("真实 grant 仅能从受保护 probe 的 exact cwd/scope/ACL 导入边界哨兵", (t) => {
  const tree = fixture(t);
  const input = {
    storyId: "story-1",
    cwd: tree.directories.story,
    allowedRoots: [tree.directories.story],
    writeDeniedRoots: [tree.directories.base],
    inaccessibleRoots: [
      tree.directories["other-story"],
      tree.directories.mirror,
      tree.directories.secrets,
    ],
    aclFingerprints: ["a".repeat(64)],
    workerIdentity: tree.workerIdentity,
    configPath: tree.probeConfigPath,
    platform: "win32",
    gatewayIdentity: WINDOWS_GATEWAY,
    aclVerifier: () => true,
  };
  assert.deepEqual(
    resolveWorkerBoundarySentinelsForGrant(input),
    tree.boundarySentinels,
  );
  assert.throws(
    () => resolveWorkerBoundarySentinelsForGrant({
      ...input,
      inaccessibleRoots: [...input.inaccessibleRoots, path.join(tree.root, "new-story")],
    }),
    (error) => error.code === "WORKER_DEPLOYMENT_PROBE_SCOPE_DRIFT",
  );
});

test("default grant resolver imports Controller identity and exact topology without Gateway widening", (t) => {
  const tree = fixture(t);
  const scope = resolveControllerManagedWorkerDeploymentProbeScopeForGrant({
    storyId: "story-1",
    cwd: tree.directories.story,
    requestedAllowedRoots: [tree.directories.story],
    configPath: tree.probeConfigPath,
    platform: "win32",
    gatewayIdentity: WINDOWS_GATEWAY,
    aclVerifier: () => true,
  });
  assert.equal(scope.topologyGeneration, 1);
  assert.equal(scope.workerIdentity, WINDOWS_WORKER);
  assert.deepEqual(scope.allowedRoots, [tree.directories.story]);
  assert.deepEqual(scope.writeDeniedRoots, [tree.directories.base]);
  assert.deepEqual(scope.inaccessibleRoots, [
    tree.directories["other-story"],
    tree.directories.mirror,
    tree.directories.secrets,
  ]);
  assert.throws(
    () => resolveControllerManagedWorkerDeploymentProbeScopeForGrant({
      storyId: "story-1",
      cwd: tree.directories.story,
      requestedAllowedRoots: [tree.directories["other-story"]],
      configPath: tree.probeConfigPath,
      platform: "win32",
      gatewayIdentity: WINDOWS_GATEWAY,
      aclVerifier: () => true,
    }),
    (error) => error.code === "WORKER_DEPLOYMENT_PROBE_SCOPE_DRIFT",
  );
});

test("queued grant cannot renew after Controller adds another active story repository", (t) => {
  const tree = fixture(t);
  const oldGrant = grantForTree(tree);
  const options = {
    configPath: tree.probeConfigPath,
    platform: "win32",
    gatewayIdentity: WINDOWS_GATEWAY,
    aclVerifier: () => true,
    now: FIXED_NOW + 1_000,
  };
  const renewed = renewControllerManagedStoryWorkerGrant(oldGrant, options);
  assert.notEqual(renewed.grantId, oldGrant.grantId);
  assert.equal(renewed.topologyGeneration, 1);

  const addedStory = path.join(tree.root, "new-active-story");
  fs.mkdirSync(addedStory);
  const addedSentinel = path.join(
    tree.root,
    ".devbench-worker-boundary-new-active-story.sentinel",
  );
  fs.writeFileSync(addedSentinel, "sentinel");
  const document = JSON.parse(fs.readFileSync(tree.probeConfigPath, "utf8"));
  document.generation = 2;
  document.stories["story-1"].inaccessibleRoots.push(addedStory);
  document.stories["story-1"].inaccessibleEntries.push({
    root: addedStory,
    path: addedStory,
    type: "directory",
  });
  document.stories["story-1"].inaccessibleEntries.sort((left, right) => (
    left.root.toLowerCase().localeCompare(right.root.toLowerCase())
    || left.path.toLowerCase().localeCompare(right.path.toLowerCase())
  ));
  document.stories["story-1"].boundarySentinels.push({
    deniedRoot: addedStory,
    sentinelPath: addedSentinel,
  });
  fs.writeFileSync(tree.probeConfigPath, JSON.stringify(document));

  assert.throws(
    () => renewControllerManagedStoryWorkerGrant(oldGrant, options),
    (error) => (
      error.code === "WORKER_GRANT_TOPOLOGY_STALE"
      && error.details?.grantGeneration === 1
      && error.details?.currentGeneration === 2
    ),
  );
});

test("Controller probe writer 原子推进 topology generation，并清理关闭故事的 stale sentinels", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "worker-probe-reconcile-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const configPath = path.join(root, "worker-deployment-probe.json");
  const storiesRoot = path.join(root, "stories");
  const baseA = path.join(root, "base-a");
  const baseB = path.join(root, "base-b");
  const storyA = path.join(storiesRoot, "story-a");
  const storyB = path.join(storiesRoot, "story-b");
  const mirror = path.join(root, "mirror");
  const secret = path.join(root, "future-secret.pem");
  for (const directory of [storiesRoot, baseA, baseB, storyA, storyB, mirror]) {
    fs.mkdirSync(directory, { recursive: true });
  }
  const mirrorChild = path.join(mirror, "objects", "pack.idx");
  fs.mkdirSync(path.dirname(mirrorChild), { recursive: true });
  fs.writeFileSync(mirrorChild, "pinned mirror child");
  const callbacks = {
    configPath,
    expectedPreviousGeneration: 0,
    sentinelProtector: () => {},
    sentinelVerifier: () => true,
    configProtector: () => {},
    configVerifier: () => true,
    configAclVerifier: () => true,
  };
  const story = ({
    storyId,
    cwd,
    base,
    otherStories = [],
    workerIdentity,
    fingerprint,
  }) => ({
    storyId,
    cwd,
    allowedRoots: [cwd],
    writeDeniedRoots: [base],
    inaccessibleRoots: [...otherStories, mirror, secret],
    workerIdentity,
    aclFingerprints: [fingerprint],
  });
  const storyAInput = (others = []) => story({
    storyId: "A",
    cwd: storyA,
    base: baseA,
    otherStories: others,
    workerIdentity: WINDOWS_WORKER,
    fingerprint: "a".repeat(64),
  });
  const storyBInput = story({
    storyId: "B",
    cwd: storyB,
    base: baseB,
    otherStories: [storyA],
    workerIdentity: "sid:S-1-5-21-1002",
    fingerprint: "b".repeat(64),
  });

  const first = reconcileManagedWorkerDeploymentProbeConfig({
    generation: 1,
    stories: [storyAInput()],
  }, callbacks);
  assert.deepEqual(first.storiesRequiringProbe, ["A"]);
  const generation1 = JSON.parse(fs.readFileSync(configPath, "utf8"));
  assert.ok(generation1.stories.A.inaccessibleEntries.some(
    (entry) => path.resolve(entry.path) === path.resolve(mirrorChild) && entry.type === "file",
  ));
  const persistentA = generation1.stories.A.boundarySentinels[0].sentinelPath;
  assert.equal(fs.existsSync(persistentA), true);
  generation1.schema = "devbench.worker-deployment-probe-config.v3";
  generation1.version = 3;
  for (const probe of Object.values(generation1.stories)) delete probe.inaccessibleEntries;
  fs.writeFileSync(configPath, JSON.stringify(generation1));

  const second = reconcileManagedWorkerDeploymentProbeConfig({
    generation: 2,
    stories: [storyAInput([storyB]), storyBInput],
  }, {
    ...callbacks,
    expectedPreviousGeneration: 1,
  });
  assert.deepEqual(second.storiesRequiringProbe, ["A", "B"]);
  const generation2 = JSON.parse(fs.readFileSync(configPath, "utf8"));
  assert.equal(generation2.schema, "devbench.worker-deployment-probe-config.v5");
  assert.equal(generation2.version, 5);
  const bSentinels = generation2.stories.B.boundarySentinels.map((item) => item.sentinelPath);
  assert.ok(bSentinels.every((target) => fs.existsSync(target)));
  generation2.schema = "devbench.worker-deployment-probe-config.v4";
  generation2.version = 4;
  for (const probe of Object.values(generation2.stories)) delete probe.inaccessibleEntries;
  fs.writeFileSync(configPath, JSON.stringify(generation2));

  const third = reconcileManagedWorkerDeploymentProbeConfig({
    generation: 3,
    stories: [storyAInput()],
  }, {
    ...callbacks,
    expectedPreviousGeneration: 2,
  });
  assert.deepEqual(third.removedStoryIds, ["B"]);
  assert.ok(third.staleSentinelsRemoved >= bSentinels.length);
  assert.ok(bSentinels.every((target) => !fs.existsSync(target)));
  assert.equal(fs.existsSync(persistentA), true);
  assert.equal(
    JSON.parse(fs.readFileSync(configPath, "utf8")).schema,
    "devbench.worker-deployment-probe-config.v5",
  );
  assert.throws(
    () => reconcileManagedWorkerDeploymentProbeConfig({
      generation: 3,
      stories: [storyAInput()],
    }, {
      ...callbacks,
      expectedPreviousGeneration: 2,
    }),
    (error) => error.code === "WORKER_DEPLOYMENT_RECONCILE_STALE_GENERATION",
  );

  const emptied = reconcileManagedWorkerDeploymentProbeConfig({
    generation: 4,
    stories: [],
  }, {
    ...callbacks,
    expectedPreviousGeneration: 3,
  });
  assert.deepEqual(emptied.removedStoryIds, ["A"]);
  assert.equal(Object.keys(JSON.parse(fs.readFileSync(configPath, "utf8")).stories).length, 0);
});

test("older generation cleanup cannot delete a sentinel reused by a newer published topology", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "worker-probe-cleanup-cas-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const configPath = path.join(root, "worker-deployment-probe.json");
  const storyRoot = path.join(root, "story-a");
  const baseRoot = path.join(root, "base");
  const mirrorRoot = path.join(root, "mirror");
  for (const directory of [storyRoot, baseRoot, mirrorRoot]) {
    fs.mkdirSync(directory, { recursive: true });
  }
  const story = {
    storyId: "A",
    cwd: storyRoot,
    allowedRoots: [storyRoot],
    writeDeniedRoots: [baseRoot],
    inaccessibleRoots: [mirrorRoot],
    workerIdentity: WINDOWS_WORKER,
    aclFingerprints: ["a".repeat(64)],
  };
  const callbacks = {
    configPath,
    gatewayIdentities: [WINDOWS_GATEWAY],
    sentinelProtector: () => {},
    sentinelVerifier: () => true,
    configProtector: () => {},
    configVerifier: () => true,
    configAclVerifier: () => true,
  };
  reconcileManagedWorkerDeploymentProbeConfig({
    generation: 1,
    stories: [story],
  }, {
    ...callbacks,
    expectedPreviousGeneration: 0,
  });
  const generation1 = JSON.parse(fs.readFileSync(configPath, "utf8"));
  const reusedSentinels = generation1.stories.A.boundarySentinels
    .map((item) => item.sentinelPath);
  const trigger = reusedSentinels[0];
  const realRename = fs.renameSync;
  let interleaved = false;
  fs.renameSync = function interleavedRename(source, destination) {
    if (
      !interleaved
      && path.resolve(source) === path.resolve(trigger)
      && path.basename(destination).startsWith(".worker-boundary-stale-")
    ) {
      interleaved = true;
      reconcileManagedWorkerDeploymentProbeConfig({
        generation: 3,
        stories: [story],
      }, {
        ...callbacks,
        expectedPreviousGeneration: 2,
      });
    }
    return realRename.call(fs, source, destination);
  };
  let older;
  try {
    older = reconcileManagedWorkerDeploymentProbeConfig({
      generation: 2,
      stories: [],
    }, {
      ...callbacks,
      expectedPreviousGeneration: 1,
    });
  } finally {
    fs.renameSync = realRename;
  }
  const current = JSON.parse(fs.readFileSync(configPath, "utf8"));
  assert.equal(interleaved, true);
  assert.equal(current.generation, 3);
  assert.ok(current.stories.A);
  assert.ok(reusedSentinels.every((sentinelPath) => fs.existsSync(sentinelPath)));
  assert.ok(older.staleSentinelsDeferred >= 1);
});

test("Windows READY 必须来自真实 launcher 链的同 nonce、同 SID 权限探测结果", (t) => {
  const tree = fixture(t);
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  let observed = null;
  const result = runWorkerIsolationDeploymentPreflight(runOptions(tree, privateKey, {
    spawn(command, args, options) {
      observed = { command, args, options };
      const encoded = args.at(-1);
      const verified = verifySignedWorkerLaunchEnvelope(encoded, {
        now: FIXED_NOW,
        testTrustAnchor: publicKey,
      });
      assertBrokerStoryIsolationSpec(verified.spec, { production: true });
      assert.equal(verified.spec.operation, "deployment-probe");
      assert.equal(verified.spec.command, "");
      assert.deepEqual(verified.spec.args, []);
      assert.equal(verified.spec.expectedIdentity, WINDOWS_WORKER);
      return {
        status: 0,
        signal: null,
        stdout: probeOutput(verified.spec),
        stderr: "",
      };
    },
  }));

  assert.equal(result.ok, true);
  assert.equal(result.status, "READY");
  assert.equal(result.code, "WORKER_DEPLOYMENT_READY");
  assert.equal(result.identityProbe, "PASS");
  assert.equal(result.isolationLevel, "STRONG");
  assert.equal(observed.command, tree.launcher);
  assert.equal(observed.args.at(-2), "--devbench-worker-spec");
  assert.equal(observed.options.shell, false);
  assert.equal(observed.options.env.OPENAI_API_KEY, undefined);
  assert.equal(observed.options.env.HOME, undefined);
  assert.equal(observed.options.env.DEVBENCH_WORKER_LAUNCHER, undefined);
  assert.equal(observed.options.env.SAFE_FLAG, "preserved");

  const attestationPath = path.join(tree.root, "worker-deployment-attestations.json");
  const launcher = loadManagedWorkerLauncherConfig(tree.launcherConfigPath, {
    storyId: "story-1",
    platform: "win32",
    gatewayIdentity: WINDOWS_GATEWAY,
    aclVerifier: () => true,
  });
  const attested = verifyWorkerDeploymentAttestation({
    storyId: "story-1",
    launcher,
    grant: grantForTree(tree),
    now: FIXED_NOW + 1,
    platform: "win32",
    gatewayIdentity: WINDOWS_GATEWAY,
    attestationPath,
    aclVerifier: () => true,
    testTrustAnchor: publicKey,
  });
  assert.equal(attested.ok, true);
  assert.equal(attested.entry.configSha256, launcher.configSha256);
  assert.equal(attested.entry.workerPolicyDigest, launcher.workerPolicyDigest);
  assert.match(attested.entry.probeScopeDigest, /^[0-9a-f]{64}$/);
  const subproject = path.join(tree.directories.story, "runtime-subproject");
  fs.mkdirSync(subproject);
  const runtimeAttested = verifyWorkerDeploymentAttestation({
    storyId: "story-1",
    launcher,
    grant: grantForTree(
      tree,
      tree.workerIdentity,
      1,
      { cwd: subproject },
    ),
    now: FIXED_NOW + 1,
    platform: "win32",
    gatewayIdentity: WINDOWS_GATEWAY,
    attestationPath,
    aclVerifier: () => true,
    testTrustAnchor: publicKey,
  });
  assert.equal(runtimeAttested.ok, true);
  assert.doesNotMatch(fs.readFileSync(attestationPath, "utf8"), /OPENAI_API_KEY|must-not-cross/);
});

test("attestation 篡改、配置/策略/范围漂移或过期均不能升级 STRONG", (t) => {
  const tree = fixture(t);
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const spawn = (_command, args) => {
    const verified = verifySignedWorkerLaunchEnvelope(args.at(-1), {
      now: FIXED_NOW,
      testTrustAnchor: publicKey,
    });
    return {
      status: 0,
      signal: null,
      stdout: probeOutput(verified.spec),
      stderr: "",
    };
  };
  runWorkerIsolationDeploymentPreflight(runOptions(tree, privateKey, { spawn }));
  const attestationPath = path.join(tree.root, "worker-deployment-attestations.json");
  const launcher = loadManagedWorkerLauncherConfig(tree.launcherConfigPath, {
    storyId: "story-1",
    platform: "win32",
    gatewayIdentity: WINDOWS_GATEWAY,
    aclVerifier: () => true,
  });
  const baseOptions = {
    storyId: "story-1",
    launcher,
    grant: grantForTree(tree),
    now: FIXED_NOW + 1,
    platform: "win32",
    gatewayIdentity: WINDOWS_GATEWAY,
    attestationPath,
    aclVerifier: () => true,
    testTrustAnchor: publicKey,
  };

  const configDrift = verifyWorkerDeploymentAttestation({
    ...baseOptions,
    launcher: { ...launcher, configSha256: "f".repeat(64) },
  });
  assert.equal(configDrift.code, "WORKER_DEPLOYMENT_ATTESTATION_DRIFT");
  const policyDrift = verifyWorkerDeploymentAttestation({
    ...baseOptions,
    launcher: { ...launcher, workerPolicyDigest: "e".repeat(64) },
  });
  assert.equal(policyDrift.code, "WORKER_DEPLOYMENT_ATTESTATION_DRIFT");
  const scopeDrift = verifyWorkerDeploymentAttestation({
    ...baseOptions,
    grant: {
      ...grantForTree(tree),
      aclFingerprints: ["b".repeat(64)],
    },
  });
  assert.equal(scopeDrift.code, "WORKER_DEPLOYMENT_ATTESTATION_DRIFT");
  const expired = verifyWorkerDeploymentAttestation({
    ...baseOptions,
    now: FIXED_NOW + WORKER_DEPLOYMENT_ATTESTATION_MAX_AGE_MS + 1,
  });
  assert.equal(expired.code, "WORKER_DEPLOYMENT_ATTESTATION_EXPIRED");

  const tampered = JSON.parse(fs.readFileSync(attestationPath, "utf8"));
  tampered.entries[0].workerIdentity = "sid:s-1-5-21-9999";
  fs.writeFileSync(attestationPath, JSON.stringify(tampered));
  const invalidSignature = verifyWorkerDeploymentAttestation(baseOptions);
  assert.equal(invalidSignature.code, "WORKER_DEPLOYMENT_ATTESTATION_SIGNATURE_INVALID");
});

test("launcher 伪造错误 nonce 的成功输出仍失败关闭", (t) => {
  const tree = fixture(t);
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  assert.throws(
    () => runWorkerIsolationDeploymentPreflight(runOptions(tree, privateKey, {
      spawn(_command, args) {
        const verified = verifySignedWorkerLaunchEnvelope(args.at(-1), {
          now: FIXED_NOW,
          testTrustAnchor: publicKey,
        });
        return {
          status: 0,
          signal: null,
          stdout: probeOutput(verified.spec, {
            launchNonce: "00000000-0000-4000-8000-000000000000",
          }),
          stderr: "",
        };
      },
    })),
    (error) => error.code === "WORKER_DEPLOYMENT_PROBE_RESULT_MISMATCH",
  );
});

test("legacy deployment probe result v2 is rejected", (t) => {
  const tree = fixture(t);
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  assert.throws(
    () => runWorkerIsolationDeploymentPreflight(runOptions(tree, privateKey, {
      spawn(command, args) {
        const verified = verifySignedWorkerLaunchEnvelope(args.at(-1), {
          now: FIXED_NOW,
          testTrustAnchor: publicKey,
        });
        return {
          status: 0,
          signal: null,
          stdout: probeOutput(verified.spec, {
            schema: "devbench.worker-deployment-probe-result.v2",
            version: 2,
          }),
          stderr: "",
        };
      },
    })),
    (error) => error.code === "WORKER_DEPLOYMENT_PROBE_RESULT_MISMATCH",
  );
});

test("launcher 非零退出只返回机器可读 BLOCKED，不泄漏 PEM 内容", (t) => {
  const tree = fixture(t);
  const { privateKey } = generateKeyPairSync("ed25519");
  let thrown;
  try {
    runWorkerIsolationDeploymentPreflight(runOptions(tree, privateKey, {
      spawn() {
        return {
          status: 125,
          signal: null,
          stdout: "",
          stderr: "<REDACTED_PRIVATE_KEY>",
        };
      },
    }));
  } catch (error) {
    thrown = error;
  }
  const result = formatWorkerDeploymentFailure(thrown);
  assert.equal(result.status, "BLOCKED");
  assert.equal(result.code, "WORKER_DEPLOYMENT_PROBE_FAILED");
  assert.doesNotMatch(JSON.stringify(result), /BEGIN PRIVATE KEY| secret /);
});

test("Unix 即使真实不同 uid probe 通过也明确返回内核 containment 不可用", (t) => {
  const tree = fixture(t, {
    platform: "linux",
    workerIdentity: "uid:1001",
    gatewayIdentity: "uid:1000",
  });
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const result = runWorkerIsolationDeploymentPreflight(runOptions(tree, privateKey, {
    spawn(_command, args) {
      const verified = verifySignedWorkerLaunchEnvelope(args.at(-1), {
        now: FIXED_NOW,
        testTrustAnchor: publicKey,
      });
      return {
        status: 0,
        signal: null,
        stdout: probeOutput(verified.spec),
        stderr: "",
      };
    },
  }));
  assert.equal(result.ok, false);
  assert.equal(result.status, "BLOCKED");
  assert.equal(result.code, "WORKER_KERNEL_CONTAINMENT_UNAVAILABLE");
  assert.equal(result.actualIdentity, "uid:1001");
  assert.equal(result.identityProbe, "PASS");
  assert.equal(result.isolationLevel, "DEGRADED");
});

test("Unix root uid 在 launcher 启动前即失败关闭", (t) => {
  const tree = fixture(t, {
    platform: "linux",
    workerIdentity: "uid:0",
    gatewayIdentity: "uid:1000",
  });
  const { privateKey } = generateKeyPairSync("ed25519");
  assert.throws(
    () => runWorkerIsolationDeploymentPreflight(runOptions(tree, privateKey)),
    (error) => error.code === "WORKER_DEPLOYMENT_PROBE_WORKER_IDENTITY_INVALID",
  );
});

test("受管 launcher 拒绝 runas 和预置签名 payload 参数", (t) => {
  const runasTree = fixture(t, { launcherName: "runas.exe" });
  assert.throws(
    () => loadManagedWorkerLauncherConfig(runasTree.launcherConfigPath, {
      storyId: "story-1",
      platform: "win32",
      gatewayIdentity: WINDOWS_GATEWAY,
      aclVerifier: () => true,
    }),
    (error) => error.code === "WORKER_LAUNCHER_COMMAND_UNSAFE",
  );

  const markerTree = fixture(t, {
    launcherArgs: [ISOLATED_WORKER_BROKER_PATH, "--devbench-worker-spec"],
  });
  assert.throws(
    () => loadManagedWorkerLauncherConfig(markerTree.launcherConfigPath, {
      storyId: "story-1",
      platform: "win32",
      gatewayIdentity: WINDOWS_GATEWAY,
      aclVerifier: () => true,
    }),
    (error) => error.code === "WORKER_LAUNCHER_ARGS_UNSAFE",
  );
});

test("broker Hash 或 broker ACL 漂移时在 launcher 启动前失败关闭", (t) => {
  const hashTree = fixture(t);
  const hashConfig = JSON.parse(fs.readFileSync(hashTree.launcherConfigPath, "utf8"));
  hashConfig.brokerSha256 = "0".repeat(64);
  fs.writeFileSync(hashTree.launcherConfigPath, JSON.stringify(hashConfig));
  assert.throws(
    () => loadManagedWorkerLauncherConfig(hashTree.launcherConfigPath, {
      storyId: "story-1",
      platform: "win32",
      gatewayIdentity: WINDOWS_GATEWAY,
      aclVerifier: () => true,
    }),
    (error) => error.code === "WORKER_LAUNCHER_BROKER_HASH_MISMATCH",
  );

  const aclTree = fixture(t);
  assert.throws(
    () => loadManagedWorkerLauncherConfig(aclTree.launcherConfigPath, {
      storyId: "story-1",
      platform: "win32",
      gatewayIdentity: WINDOWS_GATEWAY,
      aclVerifier: (target) => path.resolve(target) !== path.resolve(ISOLATED_WORKER_BROKER_PATH),
    }),
    (error) => error.code === "WORKER_LAUNCHER_ACL_UNSAFE",
  );
});

test("deployment-probe 签名 payload 拒绝任意 command、env 和缺失 ACL attestation", () => {
  const base = {
    schema: "devbench.worker-launch-spec.v1",
    version: 1,
    keyId: "ed25519:key",
    launchNonce: "00000000-0000-4000-8000-000000000001",
    issuedAt: "2026-07-30T00:00:00.000Z",
    expiresAt: "2026-07-30T00:00:30.000Z",
    operation: "deployment-probe",
    taskId: "deployment-probe:story-1:test",
    command: "",
    args: [],
    cwd: "C:\\story",
    expectedIdentity: WINDOWS_WORKER,
    identityScope: "per-story",
    gatewayIdentity: WINDOWS_GATEWAY,
    readOnly: false,
    grant: {
      version: 2,
      grantId: "00000000-0000-4000-8000-000000000002",
      nonce: "00000000-0000-4000-8000-000000000003",
      storyId: "story-1",
      topologyGeneration: 1,
      repositoryMode: "INDEPENDENT_REPOSITORY",
      cwd: "C:\\story",
      topologyCwd: "C:\\story",
      allowedRoots: ["C:\\story"],
      writeDeniedRoots: ["C:\\base"],
      inaccessibleRoots: ["C:\\mirror", "C:\\secret"],
      inaccessibleEntries: [{
        root: "C:\\mirror",
        path: "C:\\mirror",
        type: "directory",
      }, {
        root: "C:\\secret",
        path: "C:\\secret",
        type: "missing",
      }],
      boundarySentinels: [{
        deniedRoot: "C:\\base",
        sentinelPath: "C:\\.devbench-worker-boundary-base.sentinel",
      }, {
        deniedRoot: "C:\\mirror",
        sentinelPath: "C:\\.devbench-worker-boundary-mirror.sentinel",
      }, {
        deniedRoot: "C:\\secret",
        sentinelPath: "C:\\.devbench-worker-boundary-secret.sentinel",
      }],
      workerIdentity: WINDOWS_WORKER,
      aclFingerprints: ["a".repeat(64)],
      readOnly: false,
      issuedAt: "2026-07-30T00:00:00.000Z",
      expiresAt: "2026-07-30T00:01:00.000Z",
    },
  };
  assert.equal(assertBrokerStoryIsolationSpec(base, { production: true }), base);
  assert.throws(
    () => assertBrokerStoryIsolationSpec({
      ...base,
      grant: { ...base.grant, version: 1 },
    }, { production: true }),
    (error) => error.code === "WORKER_DEPLOYMENT_PROBE_PAYLOAD_INVALID",
  );
  assert.throws(
    () => assertBrokerStoryIsolationSpec({ ...base, command: "cmd.exe" }, { production: true }),
    (error) => error.code === "WORKER_DEPLOYMENT_PROBE_PAYLOAD_INVALID",
  );
  assert.throws(
    () => assertBrokerStoryIsolationSpec({ ...base, env: { PATH: "x" } }, { production: true }),
    (error) => error.code === "WORKER_DEPLOYMENT_PROBE_PAYLOAD_INVALID",
  );
  assert.throws(
    () => assertBrokerStoryIsolationSpec({
      ...base,
      grant: { ...base.grant, aclFingerprints: [] },
    }, { production: true }),
    (error) => error.code === "WORKER_DEPLOYMENT_PROBE_PAYLOAD_INVALID",
  );
});

test("broker 拒绝 root/管理员或带危险 privilege 的 Worker token", () => {
  assert.throws(
    () => assertLowPrivilegeWorkerIdentity({
      platform: "darwin",
      uid: 0,
      euid: 0,
      gid: 0,
      groups: [0],
    }),
    (error) => error.code === "WORKER_IDENTITY_PRIVILEGED",
  );
  assert.throws(
    () => assertLowPrivilegeWorkerIdentity({
      platform: "win32",
      testSystemRoot: "C:\\Windows",
      testSystemToolPathVerifier: () => true,
      testSystemToolAclVerifier: () => true,
      execFile() {
        const error = new Error("administrator");
        error.status = 9;
        throw error;
      },
    }),
    (error) => error.code === "WORKER_IDENTITY_PRIVILEGED",
  );
  let calls = 0;
  assert.throws(
    () => assertLowPrivilegeWorkerIdentity({
      platform: "win32",
      testSystemRoot: "C:\\Windows",
      testSystemToolPathVerifier: () => true,
      testSystemToolAclVerifier: () => true,
      execFile() {
        calls += 1;
        return calls === 1
          ? ""
          : '"SeBackupPrivilege","Back up files and directories","Disabled"';
      },
    }),
    (error) => error.code === "WORKER_IDENTITY_PRIVILEGED",
  );
  calls = 0;
  assert.throws(
    () => assertLowPrivilegeWorkerIdentity({
      platform: "win32",
      testSystemRoot: "C:\\Windows",
      testSystemToolPathVerifier: () => true,
      testSystemToolAclVerifier: () => true,
      execFile() {
        calls += 1;
        return calls === 1
          ? ""
          : '"SeChangeNotifyPrivilege","Bypass traverse checking","Enabled"';
      },
    }),
    (error) => error.code === "WORKER_IDENTITY_PRIVILEGED",
  );
});
