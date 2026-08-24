import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createHash, generateKeyPairSync } from "node:crypto";
import { PassThrough } from "node:stream";
import {
  INDEPENDENT_REPOSITORY_MODE,
  ISOLATED_WORKER_BROKER_PATH,
  NATIVE_LAUNCHER_PROCESS_IDENTITY_SCHEMA,
  WORKER_LAUNCH_CONSUME_HELPER_PATH,
  LEGACY_LINKED_WORKTREE_MODE,
  WORKER_ISOLATION_LEVELS,
  WORKER_LAUNCHER_CONFIG_SCHEMA,
  createSignedWorkerLaunchEnvelope,
  createSignedWorkerLeaseRelease,
  createStoryWorkerGrant,
  currentOsIdentity,
  dangerousCliPermissionsAllowed,
  loadManagedWorkerLauncherConfig,
  platformSupportsStrongWorkerIsolation,
  prepareWorkerLaunch,
  queryManagedWorkerLauncherProcessIdentity,
  readWorkerLauncherConfig,
  resolveTaskWorkerIsolation,
  sanitizeWorkerEnvironment,
  validateStoryWorkerGrant,
} from "../services/worker-isolation.js";
import {
  assertBrokerStoryIsolationSpec,
  assertDeniedRootParentBoundaries,
  assertInaccessibleEntriesInaccessible,
  assertWriteDeniedTreesNotWritable,
  assertIndependentGitDirectory,
  assertLowPrivilegeWorkerIdentity,
  assertProtectedCliDescriptor,
  awaitWorkerLeaseRelease,
  readProtectedWorkerFile,
  resolveWindowsSystemToolPaths,
  sanitizeBrokerEnvironment,
  verifySignedWorkerLaunchEnvelope,
} from "../services/isolated-worker-broker.mjs";

const roots = [];
const LAUNCHER_INSTANCE_A = Buffer.alloc(32, 0x41).toString("base64url");
const LAUNCHER_INSTANCE_B = Buffer.alloc(32, 0x42).toString("base64url");
const saved = new Map();
const ENV_KEYS = [
  "NODE_ENV",
  "DEVBENCH_REQUIRE_STRONG_WORKER_ISOLATION",
  "DEVBENCH_ALLOW_LEGACY_ADVISORY_WORKERS",
  "DEVBENCH_WORKER_LAUNCHER",
  "DEVBENCH_WORKER_LAUNCHER_ARGS_JSON",
  "DEVBENCH_WORKER_IDENTITY",
  "DEVBENCH_WORKER_LAUNCHER_ATTESTED",
  "DEVBENCH_WORKER_TRUST_PUBLIC_KEY",
  "DEVBENCH_WORKER_SIGNING_PRIVATE_KEY",
  "DEVBENCH_WORKER_SPEC_BYPASS_VERIFY",
  "DEVBENCH_TEST_OS_IDENTITY",
];
for (const key of ENV_KEYS) saved.set(key, process.env[key]);

function tempTree() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "worker-policy-"));
  roots.push(root);
  const story = path.join(root, "story");
  const docs = path.join(root, "docs");
  const base = path.join(root, "base");
  const mirror = path.join(root, "mirror.git");
  const secrets = path.join(root, "gateway-secrets");
  for (const item of [story, docs, base, mirror, secrets]) fs.mkdirSync(item);
  return { root, story, docs, base, mirror, secrets };
}

function grantFor(tree, mode = INDEPENDENT_REPOSITORY_MODE) {
  const deniedRoots = [tree.base, tree.mirror, tree.secrets];
  const boundarySentinels = deniedRoots.map((deniedRoot, index) => {
    const sentinelPath = path.join(tree.root, `.devbench-worker-boundary-${index}.sentinel`);
    if (!fs.existsSync(sentinelPath)) fs.writeFileSync(sentinelPath, "sentinel");
    return { deniedRoot, sentinelPath };
  });
  return createStoryWorkerGrant({
    storyId: "CARB-1",
    repositoryMode: mode,
    cwd: tree.story,
    allowedRoots: [tree.docs],
    writeDeniedRoots: [tree.base],
    inaccessibleRoots: [tree.mirror, tree.secrets],
    inaccessibleEntries: [tree.mirror, tree.secrets].map((rootPath) => ({
      root: rootPath,
      path: rootPath,
      type: "directory",
    })),
    boundarySentinels,
    workerIdentity: "uid:1001",
    aclFingerprints: ["a".repeat(64)],
  });
}

function signingPair() {
  return generateKeyPairSync("ed25519");
}

function writeManagedLauncherConfig(
  tree,
  {
    expectedIdentity = {
      "CARB-1": "sid:S-1-5-21-1001",
      "CARB-2": "sid:S-1-5-21-1002",
    },
    launcherContent = "managed launcher",
    launcherSha256,
    brokerPath = ISOLATED_WORKER_BROKER_PATH,
    consumeHelperPath = WORKER_LAUNCH_CONSUME_HELPER_PATH,
  } = {},
) {
  const launcher = path.join(tree.root, "managed-launcher.exe");
  fs.writeFileSync(launcher, launcherContent, { mode: 0o700 });
  const codex = path.join(tree.root, "codex.exe");
  fs.writeFileSync(codex, "managed codex", { mode: 0o700 });
  const configPath = path.join(tree.root, "worker-launcher.json");
  fs.writeFileSync(configPath, JSON.stringify({
    schema: WORKER_LAUNCHER_CONFIG_SCHEMA,
    version: 1,
    command: launcher,
    args: [brokerPath, consumeHelperPath],
    brokerPath,
    brokerSha256: createHash("sha256")
      .update(fs.readFileSync(brokerPath))
      .digest("hex"),
    consumeHelperPath,
    consumeHelperSha256: createHash("sha256")
      .update(fs.readFileSync(consumeHelperPath))
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
    identityScope: "per-story",
    expectedIdentity,
    launcherSha256: launcherSha256
      || createHash("sha256").update(launcherContent).digest("hex"),
  }), { mode: 0o600 });
  return { configPath, launcher, codex };
}

function signedEnvelope(privateKey, now = Date.now()) {
  return createSignedWorkerLaunchEnvelope({
    taskId: "task-CARB-1",
    command: "codex",
    args: ["exec", "-"],
    cwd: process.cwd(),
    expectedIdentity: "uid:1001",
    gatewayIdentity: "uid:1000",
    grant: { version: 2, nonce: "grant-nonce" },
    readOnly: false,
  }, {
    now,
    payloadExpiresAt: new Date(now + 30_000).toISOString(),
    testSigningPrivateKey: privateKey,
  });
}

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = saved.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

test("结构化 grant 只允许 cwd/addDirs 留在当前故事点授权根", () => {
  const tree = tempTree();
  const grant = grantFor(tree);
  const task = {
    storyScoped: true,
    cwd: tree.story,
    addDirs: [tree.docs],
    workerGrant: grant,
  };
  assert.equal(validateStoryWorkerGrant(task).ok, true);
  const outside = path.join(tree.root, "outside");
  fs.mkdirSync(outside);
  assert.equal(validateStoryWorkerGrant({ ...task, addDirs: [outside] }).code, "WORKER_GRANT_ADD_DIR_OUTSIDE");
});

test("尚不存在的敏感叶子仍保留在 grant，后续创建也不会脱离禁止范围", () => {
  const tree = tempTree();
  const configParent = path.join(tree.root, "gateway-config");
  fs.mkdirSync(configParent);
  const futurePrivateKey = path.join(configParent, "worker-launcher-private.pem");
  const sentinelPath = path.join(
    configParent,
    ".devbench-worker-boundary-private-key.sentinel",
  );
  const baseSentinel = path.join(tree.root, ".devbench-worker-boundary-base.sentinel");
  const mirrorSentinel = path.join(tree.root, ".devbench-worker-boundary-mirror.sentinel");
  fs.writeFileSync(baseSentinel, "sentinel");
  fs.writeFileSync(mirrorSentinel, "sentinel");
  fs.writeFileSync(sentinelPath, "sentinel");
  const grant = createStoryWorkerGrant({
    storyId: "CARB-future-secret",
    repositoryMode: INDEPENDENT_REPOSITORY_MODE,
    cwd: tree.story,
    allowedRoots: [tree.story],
    writeDeniedRoots: [tree.base],
    inaccessibleRoots: [tree.mirror, futurePrivateKey],
    inaccessibleEntries: [
      { root: tree.mirror, path: tree.mirror, type: "directory" },
      { root: futurePrivateKey, path: futurePrivateKey, type: "missing" },
    ],
    boundarySentinels: [
      {
        deniedRoot: tree.base,
        sentinelPath: baseSentinel,
      },
      {
        deniedRoot: tree.mirror,
        sentinelPath: mirrorSentinel,
      },
      { deniedRoot: futurePrivateKey, sentinelPath },
    ],
    workerIdentity: "uid:1001",
    aclFingerprints: ["b".repeat(64)],
  });
  assert.ok(grant.inaccessibleRoots.some((root) => path.resolve(root) === futurePrivateKey));
  fs.writeFileSync(futurePrivateKey, "created-after-grant");
  const checked = validateStoryWorkerGrant({
    storyScoped: true,
    storyId: "CARB-future-secret",
    cwd: tree.story,
    workerGrant: grant,
  });
  assert.equal(checked.ok, true);
  assert.ok(checked.grant.inaccessibleRoots.some(
    (root) => path.resolve(root) === futurePrivateKey,
  ));
});

test("禁止根父目录可创建或替换子项时，真实攻击探测失败关闭", () => {
  const tree = tempTree();
  const sentinelPath = path.join(tree.root, ".devbench-worker-boundary-live.sentinel");
  fs.writeFileSync(sentinelPath, "sentinel");
  assert.throws(
    () => assertDeniedRootParentBoundaries({
      deniedRoots: [tree.base],
      boundarySentinels: [{ deniedRoot: tree.base, sentinelPath }],
      testParentPermissionVerifier: () => true,
    }),
    (error) => error.code === "WORKER_DENIED_PARENT_MUTABLE",
  );
  assert.equal(fs.readFileSync(sentinelPath, "utf8"), "sentinel");
  assert.equal(
    fs.readdirSync(tree.root).some((name) => name.startsWith(".devbench-worker-boundary-dir-")),
    false,
  );
});

test("Windows 有效 ACL 语义检查能识别当前身份可变更的真实父链", {
  skip: process.platform !== "win32",
}, () => {
  const tree = tempTree();
  const sentinelPath = path.join(tree.root, ".devbench-worker-boundary-windows.sentinel");
  fs.writeFileSync(sentinelPath, "sentinel");
  assert.throws(
    () => assertDeniedRootParentBoundaries({
      deniedRoots: [tree.base],
      boundarySentinels: [{ deniedRoot: tree.base, sentinelPath }],
    }),
    (error) => error.code === "WORKER_DENIED_PARENT_MUTABLE",
  );
});

test("禁止根边界哨兵缺失或未覆盖全部 future leaf 时失败关闭", () => {
  const tree = tempTree();
  assert.throws(
    () => assertDeniedRootParentBoundaries({
      deniedRoots: [tree.base, path.join(tree.root, "future-secret.pem")],
      boundarySentinels: [{
        deniedRoot: tree.base,
        sentinelPath: path.join(tree.root, ".devbench-worker-boundary-base.sentinel"),
      }],
      testParentPermissionVerifier: () => true,
    }),
    (error) => error.code === "WORKER_DENIED_BOUNDARY_SENTINEL_REQUIRED",
  );
});

test("deployment probe 会发现基础仓根只读但业务文件或 .git 子项显式可写", () => {
  const tree = tempTree();
  const businessFile = path.join(tree.base, "业务 文件.txt");
  const gitDirectory = path.join(tree.base, ".git");
  const gitConfig = path.join(gitDirectory, "config");
  fs.mkdirSync(gitDirectory);
  fs.writeFileSync(businessFile, "business");
  fs.writeFileSync(gitConfig, "[core]\n");

  assert.throws(
    () => assertWriteDeniedTreesNotWritable({
      writeDeniedRoots: [tree.base],
      testWritableProbe: (target) => target === businessFile,
    }),
    (error) => error.code === "WORKER_FORBIDDEN_TREE_WRITABLE",
  );
  assert.throws(
    () => assertWriteDeniedTreesNotWritable({
      writeDeniedRoots: [tree.base],
      testWritableProbe: (target) => target === gitConfig,
    }),
    (error) => error.code === "WORKER_FORBIDDEN_TREE_WRITABLE",
  );
  const protectedTree = assertWriteDeniedTreesNotWritable({
    writeDeniedRoots: [tree.base],
    testWritableProbe: () => false,
  });
  assert.equal(protectedTree.visited, 4);
});

test("inaccessible probe 对 Controller 枚举的根和每个后代执行真实 direct access", () => {
  const tree = tempTree();
  const nested = path.join(tree.mirror, "objects");
  const secretFile = path.join(nested, "secret.bin");
  fs.mkdirSync(nested);
  fs.writeFileSync(secretFile, "secret");
  const inaccessibleEntries = [
    { root: tree.mirror, path: tree.mirror, type: "directory" },
    { root: tree.mirror, path: nested, type: "directory" },
    { root: tree.mirror, path: secretFile, type: "file" },
  ];
  const operations = [];
  const checked = assertInaccessibleEntriesInaccessible({
    inaccessibleRoots: [tree.mirror],
    inaccessibleEntries,
    testAccessProbe: (entry, operation) => {
      operations.push(`${path.basename(entry.path)}:${operation}`);
      return false;
    },
  });
  assert.equal(checked.visited, 3);
  assert.ok(operations.includes("secret.bin:direct-read-open"));
  assert.ok(operations.includes("objects:direct-child-create"));
  assert.throws(
    () => assertInaccessibleEntriesInaccessible({
      inaccessibleRoots: [tree.mirror],
      inaccessibleEntries,
    }),
    (error) => error.code === "WORKER_INACCESSIBLE_ENTRY_ACCESSIBLE",
  );
});

test("独立仓库写任务在没有独立身份 broker 时失败关闭", () => {
  const tree = tempTree();
  const result = resolveTaskWorkerIsolation({
    storyScoped: true,
    cwd: tree.story,
    addDirs: [tree.docs],
    workerGrant: grantFor(tree),
  });
  assert.equal(result.ok, false);
  assert.equal(result.level, WORKER_ISOLATION_LEVELS.DEGRADED);
  assert.equal(result.reasonCode, "WORKER_BROKER_UNAVAILABLE");
});

test("legacy linked worktree 默认禁止无限权限写 Worker", () => {
  const tree = tempTree();
  const result = resolveTaskWorkerIsolation({
    storyScoped: true,
    cwd: tree.story,
    addDirs: [tree.docs],
    workerGrant: grantFor(tree, LEGACY_LINKED_WORKTREE_MODE),
  });
  assert.equal(result.ok, false);
  assert.equal(result.reasonCode, "LEGACY_SHARED_GIT_DIR");
});

test("管理员认证的不同身份 launcher 才能形成 STRONG 启动描述", () => {
  const tree = tempTree();
  const { privateKey, publicKey } = signingPair();
  const launcher = path.join(tree.root, process.platform === "win32" ? "launcher.exe" : "launcher");
  fs.writeFileSync(launcher, "stub", { mode: 0o755 });
  const codex = path.join(tree.root, "codex.exe");
  fs.writeFileSync(codex, "pinned codex", { mode: 0o755 });
  const nodePath = path.join(tree.root, "node.exe");
  const claudeEntryPath = path.join(tree.root, "claude-entry.js");
  fs.writeFileSync(nodePath, "pinned node", { mode: 0o755 });
  fs.writeFileSync(claudeEntryPath, "console.log('claude')");
  process.env.NODE_ENV = "test";
  process.env.DEVBENCH_TEST_OS_IDENTITY = "uid:1000";
  process.env.DEVBENCH_WORKER_LAUNCHER = launcher;
  process.env.DEVBENCH_WORKER_LAUNCHER_ARGS_JSON = JSON.stringify(["broker.mjs"]);
  process.env.DEVBENCH_WORKER_IDENTITY = "uid:1001";
  process.env.DEVBENCH_WORKER_LAUNCHER_ATTESTED = "1";
  const task = {
    storyScoped: true,
    cwd: tree.story,
    addDirs: [tree.docs],
    workerGrant: grantFor(tree),
  };
  const isolation = resolveTaskWorkerIsolation(task, { platform: "win32" });
  isolation.launcher.cliAllowlist = {
    codex: {
      id: "codex",
      mode: "native",
      executablePath: codex,
      executableSha256: createHash("sha256")
        .update(fs.readFileSync(codex))
        .digest("hex"),
    },
    claude: {
      id: "claude",
      mode: "node-entry",
      nodePath,
      nodeSha256: createHash("sha256").update(fs.readFileSync(nodePath)).digest("hex"),
      entryPath: claudeEntryPath,
      entrySha256: createHash("sha256")
        .update(fs.readFileSync(claudeEntryPath))
        .digest("hex"),
    },
  };
  assert.equal(isolation.ok, true);
  assert.equal(isolation.level, WORKER_ISOLATION_LEVELS.STRONG);
  const launch = prepareWorkerLaunch({
    command: "codex",
    args: ["exec", "-"],
    cwd: tree.story,
    task,
    isolation,
    environment: { PATH: "x", DEVBENCH_GIT_CONTROLLER_SECRET: "do-not-leak" },
    testSigningPrivateKey: privateKey,
  });
  assert.equal(launch.command, fs.realpathSync.native(launcher));
  assert.deepEqual(launch.args.slice(0, 2), ["broker.mjs", "--devbench-worker-spec"]);
  assert.equal(launch.env.DEVBENCH_GIT_CONTROLLER_SECRET, undefined);
  const verified = verifySignedWorkerLaunchEnvelope(launch.args.at(-1), {
    testTrustAnchor: publicKey,
  });
  assert.equal(verified.spec.command, "");
  assert.equal(verified.spec.cliDescriptor.executablePath, codex);
  assert.equal(verified.spec.grant.nonce, task.workerGrant.nonce);
  assert.equal(verified.spec.identityScope, "test-global");
  const nodeLaunch = prepareWorkerLaunch({
    command: "claude",
    args: ["--print", "hello"],
    cwd: tree.story,
    task,
    isolation,
    environment: { PATH: tree.root },
    testSigningPrivateKey: privateKey,
  });
  const verifiedNodeLaunch = verifySignedWorkerLaunchEnvelope(nodeLaunch.args.at(-1), {
    testTrustAnchor: publicKey,
  });
  assert.deepEqual(verifiedNodeLaunch.spec.cliDescriptor, {
    id: "claude",
    mode: "node-entry",
    nodePath,
    nodeSha256: isolation.launcher.cliAllowlist.claude.nodeSha256,
    entryPath: claudeEntryPath,
    entrySha256: isolation.launcher.cliAllowlist.claude.entrySha256,
  });
  assert.throws(
    () => prepareWorkerLaunch({
      command: "claude.cmd",
      args: [],
      cwd: tree.story,
      task,
      isolation,
      testSigningPrivateKey: privateKey,
    }),
    (error) => error.code === "WORKER_CLI_NOT_MANAGED",
  );
});

test("生产环境忽略伪造的 launcher attested 环境声明并在受管配置缺失时失败关闭", () => {
  const tree = tempTree();
  const forgedLauncher = path.join(tree.root, "forged-launcher.exe");
  fs.writeFileSync(forgedLauncher, "forged", { mode: 0o755 });
  const result = readWorkerLauncherConfig({
    NODE_ENV: "production",
    DEVBENCH_WORKER_LAUNCHER: forgedLauncher,
    DEVBENCH_WORKER_LAUNCHER_ARGS_JSON: "[]",
    DEVBENCH_WORKER_IDENTITY: "sid:S-1-5-21-9999",
    DEVBENCH_WORKER_LAUNCHER_ATTESTED: "1",
  }, {
    storyId: "CARB-1",
    platform: "win32",
    gatewayIdentity: "sid:S-1-5-21-1000",
  });
  assert.equal(result.configured, false);
  assert.equal(result.command, "");
  assert.notEqual(result.error, "");
});

test("NODE_ENV 留空仍按生产模式失败关闭，非故事点可写 CLI 不得借用 Gateway 身份", () => {
  const tree = tempTree();
  const forgedLauncher = path.join(tree.root, "forged-launcher.exe");
  fs.writeFileSync(forgedLauncher, "forged", { mode: 0o755 });
  const result = readWorkerLauncherConfig({
    DEVBENCH_WORKER_LAUNCHER: forgedLauncher,
    DEVBENCH_WORKER_IDENTITY: "sid:S-1-5-21-9999",
    DEVBENCH_WORKER_LAUNCHER_ATTESTED: "1",
  }, {
    storyId: "CARB-1",
    platform: "win32",
    gatewayIdentity: "sid:S-1-5-21-1000",
  });
  assert.equal(result.configured, false);
  delete process.env.NODE_ENV;
  const mutation = resolveTaskWorkerIsolation({ commandPolicy: "workspace" });
  assert.equal(mutation.ok, false);
  assert.equal(mutation.reasonCode, "NON_STORY_MUTATING_CLI_FORBIDDEN");
  assert.equal(resolveTaskWorkerIsolation({ commandPolicy: "read_only" }).ok, true);
});

test("受管 launcher 配置绑定固定哈希、安全 ACL 和故事点专属 SID", () => {
  const tree = tempTree();
  process.env.NODE_ENV = "test";
  const { configPath, launcher } = writeManagedLauncherConfig(tree);
  const checked = loadManagedWorkerLauncherConfig(configPath, {
    storyId: "CARB-1",
    platform: "win32",
    gatewayIdentity: "sid:S-1-5-21-1000",
    aclVerifier: () => true,
  });
  assert.equal(checked.configured, true);
  assert.equal(checked.command, fs.realpathSync.native(launcher));
  assert.equal(checked.identity, "sid:S-1-5-21-1001");
  assert.equal(checked.identityScope, "per-story");
  assert.equal(checked.attested, true);
});

test("v3 node-entry 同时绑定受保护 Node 与 JS entry，且不接受任意 prefix args", () => {
  const tree = tempTree();
  process.env.NODE_ENV = "test";
  const { configPath } = writeManagedLauncherConfig(tree);
  const nodePath = path.join(tree.root, "node.exe");
  const entryPath = path.join(tree.root, "claude-entry.js");
  fs.writeFileSync(nodePath, "pinned node runtime", { mode: 0o700 });
  fs.writeFileSync(entryPath, "console.log('claude')", { mode: 0o600 });
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  config.cliAllowlist.claude = {
    mode: "node-entry",
    nodePath,
    nodeSha256: createHash("sha256").update(fs.readFileSync(nodePath)).digest("hex"),
    entryPath,
    entrySha256: createHash("sha256").update(fs.readFileSync(entryPath)).digest("hex"),
  };
  fs.writeFileSync(configPath, JSON.stringify(config), { mode: 0o600 });
  const checked = loadManagedWorkerLauncherConfig(configPath, {
    storyId: "CARB-1",
    platform: "win32",
    gatewayIdentity: "sid:S-1-5-21-1000",
    aclVerifier: () => true,
  });
  assert.deepEqual(checked.cliAllowlist.claude, {
    id: "claude",
    mode: "node-entry",
    nodePath,
    nodeSha256: config.cliAllowlist.claude.nodeSha256,
    entryPath,
    entrySha256: config.cliAllowlist.claude.entrySha256,
  });
  config.cliAllowlist.claude.prefixArgs = ["--require", "mutable-hook.js"];
  fs.writeFileSync(configPath, JSON.stringify(config), { mode: 0o600 });
  assert.throws(
    () => loadManagedWorkerLauncherConfig(configPath, {
      storyId: "CARB-1",
      platform: "win32",
      gatewayIdentity: "sid:S-1-5-21-1000",
      aclVerifier: () => true,
    }),
    (error) => error.code === "WORKER_LAUNCHER_CONFIG_SCHEMA_INVALID",
  );
});

test("Windows 实际 owner/DACL 校验仅接受 Gateway、SYSTEM、Administrators 可写", {
  skip: process.platform !== "win32",
}, () => {
  const tree = tempTree();
  process.env.NODE_ENV = "test";
  const broker = path.join(tree.root, "isolated-worker-broker.mjs");
  const consumeHelper = path.join(tree.root, "worker-launch-consume-helper.mjs");
  fs.copyFileSync(ISOLATED_WORKER_BROKER_PATH, broker);
  fs.copyFileSync(WORKER_LAUNCH_CONSUME_HELPER_PATH, consumeHelper);
  const { configPath, launcher, codex } = writeManagedLauncherConfig(tree, {
    brokerPath: broker,
    consumeHelperPath: consumeHelper,
  });
  const gatewayIdentity = currentOsIdentity();
  const gatewaySid = gatewayIdentity.replace(/^sid:/i, "");
  for (const file of [configPath, launcher, broker, consumeHelper, codex]) {
    execFileSync(
      "icacls.exe",
      [
        file,
        "/inheritance:r",
        "/grant:r",
        `*${gatewaySid}:(F)`,
        "*S-1-5-18:(F)",
        "*S-1-5-32-544:(F)",
      ],
      { windowsHide: true, stdio: "ignore", timeout: 10_000 },
    );
  }
  const checked = loadManagedWorkerLauncherConfig(configPath, {
    storyId: "CARB-1",
    platform: "win32",
    gatewayIdentity,
    parentAclVerifier: () => true,
    trustedBrokerPath: broker,
    trustedConsumeHelperPath: consumeHelper,
  });
  assert.equal(checked.configured, true);
});

test("受管 launcher 被篡改后 SHA256 精确校验失败", () => {
  const tree = tempTree();
  process.env.NODE_ENV = "test";
  const { configPath, launcher } = writeManagedLauncherConfig(tree);
  fs.appendFileSync(launcher, "tampered");
  assert.throws(
    () => loadManagedWorkerLauncherConfig(configPath, {
      storyId: "CARB-1",
      platform: "win32",
      gatewayIdentity: "sid:S-1-5-21-1000",
      aclVerifier: () => true,
    }),
    (error) => error.code === "WORKER_LAUNCHER_HASH_MISMATCH",
  );
});

test("broker runtime lease 身份只通过固定 native launcher 查询，不使用 PATH 工具", () => {
  const tree = tempTree();
  const launcher = path.join(tree.root, "managed-launcher.exe");
  fs.writeFileSync(launcher, "pinned native launcher", { mode: 0o700 });
  const launcherSha256 = createHash("sha256")
    .update(fs.readFileSync(launcher))
    .digest("hex");
  const calls = [];
  const processIdentity = queryManagedWorkerLauncherProcessIdentity({
    command: launcher,
    launcherSha256,
    gatewayIdentity: "sid:S-1-5-21-1000",
  }, 4321, {
    platform: "win32",
    aclVerifier: () => true,
    parentAclVerifier: () => true,
    execFile: (command, args) => {
      calls.push({ command, args });
      const document = {
        schema: NATIVE_LAUNCHER_PROCESS_IDENTITY_SCHEMA,
        version: 2,
        pid: 4321,
        launcherSha256,
        processIdentity: "win:638920000000000000",
        launcherInstanceEvidence: LAUNCHER_INSTANCE_A,
      };
      return `DEVBENCH_LAUNCHER_PROCESS_IDENTITY_V2=${Buffer.from(
        JSON.stringify(document),
        "utf8",
      ).toString("base64url")}\n`;
    },
  });
  assert.deepEqual(processIdentity, {
    processIdentity: "win:638920000000000000",
    launcherInstanceEvidence: LAUNCHER_INSTANCE_A,
  });
  assert.deepEqual(calls, [{
    command: fs.realpathSync.native(launcher),
    args: ["--devbench-query-process-identity-v2", "4321", launcherSha256],
  }]);
});

test("受管配置或 launcher ACL 不安全时失败关闭", () => {
  const tree = tempTree();
  process.env.NODE_ENV = "test";
  const { configPath } = writeManagedLauncherConfig(tree);
  assert.throws(
    () => loadManagedWorkerLauncherConfig(configPath, {
      storyId: "CARB-1",
      platform: "win32",
      gatewayIdentity: "sid:S-1-5-21-1000",
      aclVerifier: () => false,
    }),
    (error) => error.code === "WORKER_LAUNCHER_ACL_UNSAFE",
  );
});

test("受管配置拒绝 Gateway 同 SID 和跨故事复用 SID", () => {
  const tree = tempTree();
  process.env.NODE_ENV = "test";
  const sameGateway = writeManagedLauncherConfig(tree, {
    expectedIdentity: {
      "CARB-1": "sid:S-1-5-21-1000",
    },
  });
  assert.throws(
    () => loadManagedWorkerLauncherConfig(sameGateway.configPath, {
      storyId: "CARB-1",
      platform: "win32",
      gatewayIdentity: "sid:S-1-5-21-1000",
      aclVerifier: () => true,
    }),
    (error) => error.code === "WORKER_LAUNCHER_STORY_IDENTITY_INVALID",
  );

  const duplicate = writeManagedLauncherConfig(tree, {
    expectedIdentity: {
      "CARB-1": "sid:S-1-5-21-1001",
      "CARB-2": "sid:S-1-5-21-1001",
    },
    launcherContent: "second launcher",
  });
  assert.throws(
    () => loadManagedWorkerLauncherConfig(duplicate.configPath, {
      storyId: "CARB-1",
      platform: "win32",
      gatewayIdentity: "sid:S-1-5-21-1000",
      aclVerifier: () => true,
    }),
    (error) => error.code === "WORKER_LAUNCHER_STORY_IDENTITY_INVALID",
  );
});

test("生产 broker 要求已签名 storyId、禁止根探测范围和 per-story 身份", () => {
  const tree = tempTree();
  const grant = grantFor(tree);
  const valid = {
    schema: "devbench.worker-launch-spec.v1",
    version: 1,
    keyId: "ed25519:test",
    issuedAt: grant.issuedAt,
    expiresAt: grant.expiresAt,
    launchNonce: "11111111-1111-4111-8111-111111111111",
    releaseChallenge: "22222222-2222-4222-8222-222222222222",
    taskId: "task-CARB-1",
    operation: "cli",
    command: "",
    args: ["exec", "-"],
    cliDescriptor: {
      id: "codex",
      mode: "native",
      executablePath: path.join(tree.root, "codex.exe"),
      executableSha256: "c".repeat(64),
    },
    cwd: tree.story,
    expectedIdentity: grant.workerIdentity,
    gatewayIdentity: "uid:2000",
    identityScope: "per-story",
    readOnly: false,
    grant,
  };
  assert.equal(assertBrokerStoryIsolationSpec(valid, { production: true }), valid);
  assert.throws(
    () => assertBrokerStoryIsolationSpec({
      ...valid,
      identityScope: "test-global",
    }, { production: true }),
    (error) => error.code === "WORKER_LAUNCH_IDENTITY_SCOPE_INVALID",
  );
  assert.throws(
    () => assertBrokerStoryIsolationSpec({
      ...valid,
      grant: { ...valid.grant, storyId: "", writeDeniedRoots: [] },
    }, { production: true }),
    (error) => [
      "WORKER_LAUNCH_STORY_ID_MISSING",
      "WORKER_LAUNCH_SCOPE_INVALID",
    ].includes(error.code),
  );
});

test("broker 只接受落盘后签名的 lease release，并逐字节保留同帧 prompt", async () => {
  process.env.NODE_ENV = "test";
  const tree = tempTree();
  const grant = grantFor(tree);
  const { privateKey, publicKey } = signingPair();
  const encodedLaunch = createSignedWorkerLaunchEnvelope({
    taskId: "task-CARB-1",
    operation: "cli",
    releaseChallenge: "33333333-3333-4333-8333-333333333333",
    command: "",
    cliDescriptor: {
      id: "codex",
      mode: "native",
      executablePath: path.join(tree.root, "codex.exe"),
      executableSha256: "c".repeat(64),
    },
    args: ["exec", "-"],
    cwd: tree.story,
    expectedIdentity: grant.workerIdentity,
    identityScope: "per-story",
    gatewayIdentity: "uid:2000",
    grant,
    readOnly: false,
  }, { testSigningPrivateKey: privateKey });
  const verifiedLaunch = verifySignedWorkerLaunchEnvelope(encodedLaunch, {
    testTrustAnchor: publicKey,
  });
  const release = createSignedWorkerLeaseRelease(encodedLaunch, {
    leaseId: "lease:test",
    launcherPid: 1234,
    launcherProcessIdentity: "win:123456789",
    launcherInstanceEvidence: LAUNCHER_INSTANCE_A,
    testSigningPrivateKey: privateKey,
  });
  const stream = new PassThrough();
  const waiting = awaitWorkerLeaseRelease(verifiedLaunch, {
    stream,
    timeoutMs: 1000,
    launcherInstanceEvidence: LAUNCHER_INSTANCE_A,
    testTrustAnchor: publicKey,
  });
  stream.end(Buffer.from(`RELEASE:${release}\r\n第一行\nsecond line`, "utf8"));
  const result = await waiting;
  assert.equal(result.remainder.toString("utf8"), "第一行\nsecond line");
  assert.equal(result.release.leaseId, "lease:test");

  const forged = new PassThrough();
  const rejected = awaitWorkerLeaseRelease(verifiedLaunch, {
    stream: forged,
    timeoutMs: 1000,
    launcherInstanceEvidence: LAUNCHER_INSTANCE_A,
    testTrustAnchor: publicKey,
  });
  const tampered = JSON.parse(Buffer.from(release, "base64url").toString("utf8"));
  tampered.leaseId = "lease:forged";
  forged.end(`RELEASE:${Buffer.from(JSON.stringify(tampered), "utf8").toString("base64url")}\npayload`);
  await assert.rejects(
    rejected,
    (error) => error.code === "WORKER_LEASE_RELEASE_SIGNATURE_INVALID",
  );

  const brokerB = new PassThrough();
  const wrongInstance = awaitWorkerLeaseRelease(verifiedLaunch, {
    stream: brokerB,
    timeoutMs: 1000,
    launcherInstanceEvidence: LAUNCHER_INSTANCE_B,
    testTrustAnchor: publicKey,
  });
  brokerB.end(`RELEASE:${release}\npayload`);
  await assert.rejects(
    wrongInstance,
    (error) => error.code === "WORKER_LEASE_RELEASE_INSTANCE_MISMATCH",
  );
});

test("Worker 环境清除 Controller、mirror 与 Git 凭据入口", () => {
  const clean = sanitizeWorkerEnvironment({
    PATH: "safe",
    DEVBENCH_CONTROLLER_SECRET: "x",
    DEVBENCH_MIRROR_PATH: "x",
    DEVBENCH_WORKER_LAUNCHER: "x",
    DEVBENCH_WORKER_IDENTITY: "x",
    DEVBENCH_WORKER_LAUNCHER_ATTESTED: "1",
    DEVBENCH_WORKER_SIGNING_PRIVATE_KEY: "private",
    DEVBENCH_WORKER_TRUST_PUBLIC_KEY: "public",
    SOME_PRIVATE_KEY: "private",
    SOME_TRUST_ANCHOR: "public",
    GIT_ASKPASS: "x",
    SSH_AUTH_SOCK: "x",
    CODEUP_ACCESS_TOKEN: "x",
    ANTHROPIC_API_KEY: "x",
    OPENAI_API_KEY: "x",
    USERPROFILE: "C:\\Gateway",
    APPDATA: "C:\\Gateway\\AppData\\Roaming",
    CODEX_HOME: "C:\\Gateway\\.codex",
    CLAUDE_CONFIG_DIR: "C:\\Gateway\\.claude",
    MAX_TOKENS: "4096",
  });
  assert.equal(clean.PATH, "safe");
  assert.equal(clean.DEVBENCH_CONTROLLER_SECRET, undefined);
  assert.equal(clean.DEVBENCH_MIRROR_PATH, undefined);
  assert.equal(clean.DEVBENCH_WORKER_LAUNCHER, undefined);
  assert.equal(clean.DEVBENCH_WORKER_IDENTITY, undefined);
  assert.equal(clean.DEVBENCH_WORKER_LAUNCHER_ATTESTED, undefined);
  assert.equal(clean.DEVBENCH_WORKER_SIGNING_PRIVATE_KEY, undefined);
  assert.equal(clean.DEVBENCH_WORKER_TRUST_PUBLIC_KEY, undefined);
  assert.equal(clean.SOME_PRIVATE_KEY, undefined);
  assert.equal(clean.SOME_TRUST_ANCHOR, undefined);
  assert.equal(clean.GIT_ASKPASS, undefined);
  assert.equal(clean.SSH_AUTH_SOCK, undefined);
  assert.equal(clean.CODEUP_ACCESS_TOKEN, undefined);
  assert.equal(clean.ANTHROPIC_API_KEY, undefined);
  assert.equal(clean.OPENAI_API_KEY, undefined);
  assert.equal(clean.USERPROFILE, undefined);
  assert.equal(clean.APPDATA, undefined);
  assert.equal(clean.CODEX_HOME, undefined);
  assert.equal(clean.CLAUDE_CONFIG_DIR, undefined);
  assert.equal(clean.MAX_TOKENS, "4096");
  assert.equal(clean.DEVBENCH_WORKER_RUNTIME, "1");
});

test("broker 仅在验签通过后解析完整 launcher payload", () => {
  process.env.NODE_ENV = "test";
  const { privateKey, publicKey } = signingPair();
  const encoded = signedEnvelope(privateKey);
  const verified = verifySignedWorkerLaunchEnvelope(encoded, {
    testTrustAnchor: publicKey,
  });
  assert.equal(verified.spec.command, "codex");
  assert.equal(verified.spec.launchNonce, verified.envelope.nonce);
  assert.equal(verified.spec.keyId, verified.envelope.keyId);
  assert.equal(verified.spec.expiresAt, verified.envelope.expiresAt);
});

test("broker 拒绝 payload 篡改且不会先解析篡改后的 JSON", () => {
  process.env.NODE_ENV = "test";
  const { privateKey, publicKey } = signingPair();
  const encoded = signedEnvelope(privateKey);
  const envelope = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  envelope.payload = Buffer.from("{not-json", "utf8").toString("base64url");
  const tampered = Buffer.from(JSON.stringify(envelope), "utf8").toString("base64url");
  assert.throws(
    () => verifySignedWorkerLaunchEnvelope(tampered, { testTrustAnchor: publicKey }),
    (error) => error.code === "WORKER_LAUNCH_SIGNATURE_INVALID",
  );
});

test("broker 忽略伪造公钥环境变量并拒绝伪造签名", () => {
  process.env.NODE_ENV = "test";
  const trusted = signingPair();
  const forged = signingPair();
  process.env.DEVBENCH_WORKER_TRUST_PUBLIC_KEY = forged.publicKey.export({
    type: "spki",
    format: "pem",
  }).toString();
  const encoded = signedEnvelope(forged.privateKey);
  assert.throws(
    () => verifySignedWorkerLaunchEnvelope(encoded, { testTrustAnchor: trusted.publicKey }),
    (error) => error.code === "WORKER_LAUNCH_KEY_UNTRUSTED",
  );
});

test("broker trust anchor primitive 绑定完整父链与 fd，并拒绝 hardlink 叶子", () => {
  process.env.NODE_ENV = "test";
  const tree = tempTree();
  const protectedDirectory = path.join(tree.root, "protected", "config");
  fs.mkdirSync(protectedDirectory, { recursive: true });
  const target = path.join(protectedDirectory, "worker-public.pem");
  fs.writeFileSync(target, "public-key-bytes");
  const checked = [];
  const content = readProtectedWorkerFile(target, {
    testPermissionVerifier: (segment, details) => {
      checked.push({ segment, leaf: details.leaf });
      return true;
    },
  });
  assert.equal(content.toString("utf8"), "public-key-bytes");
  assert.ok(checked.some((entry) => entry.segment === path.parse(target).root));
  assert.ok(checked.filter((entry) => entry.leaf).length >= 2);

  const linked = path.join(protectedDirectory, "linked-public.pem");
  fs.linkSync(target, linked);
  assert.throws(
    () => readProtectedWorkerFile(target, {
      testPermissionVerifier: () => true,
    }),
    (error) => error.code === "WORKER_PROTECTED_FILE_PATH_INVALID",
  );
});

test("broker 拒绝过期的短 TTL launcher envelope", () => {
  process.env.NODE_ENV = "test";
  const { privateKey, publicKey } = signingPair();
  const issuedAt = Date.now() - 120_000;
  const encoded = signedEnvelope(privateKey, issuedAt);
  assert.throws(
    () => verifySignedWorkerLaunchEnvelope(encoded, {
      now: issuedAt + 120_000,
      testTrustAnchor: publicKey,
    }),
    (error) => error.code === "WORKER_LAUNCH_ENVELOPE_EXPIRED",
  );
});

test("生产环境禁止显式测试密钥和测试信任锚注入", () => {
  const { privateKey, publicKey } = signingPair();
  process.env.NODE_ENV = "production";
  assert.throws(
    () => signedEnvelope(privateKey),
    (error) => error.code === "WORKER_LAUNCH_TEST_KEY_FORBIDDEN",
  );
  process.env.NODE_ENV = "test";
  const encoded = signedEnvelope(privateKey);
  process.env.NODE_ENV = "production";
  assert.throws(
    () => verifySignedWorkerLaunchEnvelope(encoded, { testTrustAnchor: publicKey }),
    (error) => error.code === "WORKER_LAUNCH_TEST_TRUST_FORBIDDEN",
  );
});

test("broker 启动 CLI 前再次净化 launcher、签名、信任锚和私钥环境", () => {
  const clean = sanitizeBrokerEnvironment({
    PATH: "safe",
    DEVBENCH_WORKER_LAUNCHER: "launcher",
    DEVBENCH_WORKER_LAUNCHER_ARGS_JSON: "[]",
    DEVBENCH_WORKER_IDENTITY: "sid:worker",
    DEVBENCH_WORKER_SIGNING_PRIVATE_KEY: "private",
    DEVBENCH_WORKER_TRUST_PUBLIC_KEY: "public",
    DEVBENCH_WORKER_SPEC_BYPASS_VERIFY: "1",
    APP_SIGNING_KEY: "private",
  });
  assert.deepEqual(clean, {
    PATH: "safe",
    DEVBENCH_WORKER_RUNTIME: "1",
  });
});

test("Worker 系统身份检查不使用 PATH 或 cwd 中的伪造 Windows 工具", () => {
  const tree = tempTree();
  const fakeWhoami = path.join(tree.root, "whoami.exe");
  const fakePowershell = path.join(tree.root, "powershell.exe");
  fs.writeFileSync(fakeWhoami, "marker");
  fs.writeFileSync(fakePowershell, "marker");
  const previousPath = process.env.PATH;
  const calls = [];
  try {
    process.env.PATH = tree.root;
    const tools = resolveWindowsSystemToolPaths({
      testSystemRoot: "C:\\Windows",
      testPathVerifier: () => true,
    });
    assert.notEqual(tools.whoami.toLowerCase(), fakeWhoami.toLowerCase());
    assert.notEqual(tools.powershell.toLowerCase(), fakePowershell.toLowerCase());
    assert.equal(path.win32.isAbsolute(tools.whoami), true);
    assert.equal(path.win32.isAbsolute(tools.powershell), true);
    assert.equal(assertLowPrivilegeWorkerIdentity({
      platform: "win32",
      testSystemRoot: "C:\\Windows",
      testSystemToolPathVerifier: () => true,
      testSystemToolAclVerifier: () => true,
      execFile: (command) => {
        calls.push(command);
        return "";
      },
    }), true);
    delete process.env.PATH;
    assert.equal(resolveWindowsSystemToolPaths({
      testSystemRoot: "C:\\Windows",
      testPathVerifier: () => true,
    }).whoami, tools.whoami);
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
  }
  assert.ok(calls.length >= 2);
  assert.equal(calls.some((command) => (
    command.toLowerCase() === fakeWhoami.toLowerCase()
    || command.toLowerCase() === fakePowershell.toLowerCase()
  )), false);
});

test("broker 对签名 CLI 的绝对路径、SHA256 和不可修改父链进行二次复验", () => {
  const tree = tempTree();
  const cliPath = path.join(tree.root, "codex.exe");
  fs.writeFileSync(cliPath, "pinned-cli", { mode: 0o700 });
  const descriptor = {
    id: "codex",
    mode: "native",
    executablePath: cliPath,
    executableSha256: createHash("sha256")
      .update(fs.readFileSync(cliPath))
      .digest("hex"),
  };
  const options = {
    platform: "win32",
    testSystemRoot: "C:\\Windows",
    testSystemToolPathVerifier: () => true,
    testParentPermissionVerifier: () => true,
  };
  assert.equal(assertProtectedCliDescriptor(descriptor, options).commandPath, cliPath);
  assert.throws(
    () => assertProtectedCliDescriptor(descriptor, {
      ...options,
      testParentPermissionVerifier: (segment) => (
        path.resolve(segment) !== path.resolve(tree.root)
      ),
    }),
    (error) => error.code === "WORKER_CLI_PARENT_MUTABLE",
  );
  for (const [name, content] of [
    ["codex.cmd", "@echo off"],
    ["codex-shim.exe", "#!/usr/bin/env node\nconsole.log('shim')"],
  ]) {
    const shimPath = path.join(tree.root, name);
    fs.writeFileSync(shimPath, content, { mode: 0o700 });
    assert.throws(
      () => assertProtectedCliDescriptor({
        id: "codex",
        mode: "native",
        executablePath: shimPath,
        executableSha256: createHash("sha256")
          .update(fs.readFileSync(shimPath))
          .digest("hex"),
      }, options),
      (error) => error.code === "WORKER_CLI_EXECUTABLE_UNSAFE",
    );
  }
  fs.appendFileSync(cliPath, "drift");
  assert.throws(
    () => assertProtectedCliDescriptor(descriptor, options),
    (error) => error.code === "WORKER_CLI_HASH_MISMATCH",
  );
});

test("broker node-entry 固定 Node+JS 入口并拒绝 fake PATH、entry 漂移和可写父链", () => {
  const tree = tempTree();
  const protectedDirectory = path.join(tree.root, "protected-cli");
  const fakeDirectory = path.join(tree.root, "fake-path");
  fs.mkdirSync(protectedDirectory);
  fs.mkdirSync(fakeDirectory);
  const nodePath = path.join(protectedDirectory, "node.exe");
  const entryPath = path.join(protectedDirectory, "gemini-entry.mjs");
  const fakeNodePath = path.join(fakeDirectory, "node.exe");
  fs.writeFileSync(nodePath, "pinned node runtime", { mode: 0o700 });
  fs.writeFileSync(entryPath, "console.log('gemini')", { mode: 0o600 });
  fs.writeFileSync(fakeNodePath, "fake PATH marker", { mode: 0o700 });
  const descriptor = {
    id: "gemini",
    mode: "node-entry",
    nodePath,
    nodeSha256: createHash("sha256").update(fs.readFileSync(nodePath)).digest("hex"),
    entryPath,
    entrySha256: createHash("sha256").update(fs.readFileSync(entryPath)).digest("hex"),
  };
  const options = {
    platform: "win32",
    testSystemRoot: "C:\\Windows",
    testSystemToolPathVerifier: () => true,
    testParentPermissionVerifier: () => true,
  };
  const previousPath = process.env.PATH;
  try {
    process.env.PATH = fakeDirectory;
    const protectedDescriptor = assertProtectedCliDescriptor(descriptor, options);
    assert.equal(protectedDescriptor.commandPath, nodePath);
    assert.notEqual(protectedDescriptor.commandPath, fakeNodePath);
    assert.deepEqual(protectedDescriptor.prefixArgs, [entryPath]);
    assert.throws(
      () => assertProtectedCliDescriptor({
        ...descriptor,
        nodePath: "node",
      }, options),
      (error) => error.code === "WORKER_CLI_DESCRIPTOR_INVALID",
    );
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
  }
  assert.throws(
    () => assertProtectedCliDescriptor(descriptor, {
      ...options,
      testParentPermissionVerifier: (_segment, context) => context.role !== "JS entry",
    }),
    (error) => error.code === "WORKER_CLI_PARENT_MUTABLE",
  );
  fs.appendFileSync(entryPath, "drift");
  assert.throws(
    () => assertProtectedCliDescriptor(descriptor, options),
    (error) => error.code === "WORKER_CLI_HASH_MISMATCH",
  );
});

test("broker 直接校验独立 .git，拒绝 gitfile、commondir 与 alternate object store", () => {
  const tree = tempTree();
  const gitDirectory = path.join(tree.story, ".git");
  const infoDirectory = path.join(gitDirectory, "objects", "info");
  fs.mkdirSync(infoDirectory, { recursive: true });
  assert.equal(assertIndependentGitDirectory(tree.story).gitDirectory, gitDirectory);

  fs.writeFileSync(path.join(gitDirectory, "commondir"), "..\\external.git");
  assert.throws(
    () => assertIndependentGitDirectory(tree.story),
    (error) => error.code === "WORKER_GIT_COMMONDIR_FORBIDDEN",
  );
  fs.unlinkSync(path.join(gitDirectory, "commondir"));
  fs.writeFileSync(path.join(infoDirectory, "alternates"), path.join(tree.root, "external-objects"));
  assert.throws(
    () => assertIndependentGitDirectory(tree.story),
    (error) => error.code === "WORKER_GIT_ALTERNATES_FORBIDDEN",
  );

  const linked = path.join(tree.root, "linked-story");
  fs.mkdirSync(linked);
  fs.writeFileSync(path.join(linked, ".git"), "gitdir: ../external.git");
  assert.throws(
    () => assertIndependentGitDirectory(linked),
    (error) => error.code === "WORKER_GIT_DIRECTORY_NOT_INDEPENDENT",
  );
});

test("没有内核级 containment 的 Unix 平台不会标记 STRONG 或开放危险权限", () => {
  const tree = tempTree();
  const launcher = path.join(tree.root, "launcher");
  fs.writeFileSync(launcher, "stub", { mode: 0o755 });
  process.env.NODE_ENV = "test";
  process.env.DEVBENCH_TEST_OS_IDENTITY = "uid:1000";
  process.env.DEVBENCH_WORKER_LAUNCHER = launcher;
  process.env.DEVBENCH_WORKER_IDENTITY = "uid:1001";
  process.env.DEVBENCH_WORKER_LAUNCHER_ATTESTED = "1";
  const task = {
    storyScoped: true,
    cwd: tree.story,
    addDirs: [tree.docs],
    workerGrant: grantFor(tree),
  };
  const isolation = resolveTaskWorkerIsolation(task, { platform: "linux" });
  assert.equal(platformSupportsStrongWorkerIsolation("linux"), false);
  assert.equal(isolation.ok, false);
  assert.equal(isolation.level, WORKER_ISOLATION_LEVELS.DEGRADED);
  assert.equal(isolation.reasonCode, "WORKER_KERNEL_CONTAINMENT_UNAVAILABLE");
  assert.equal(dangerousCliPermissionsAllowed(task, isolation, { platform: "linux" }), false);
});
