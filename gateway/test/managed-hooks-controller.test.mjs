import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "managed-hooks-controller-"));
process.env.GATEWAY_DB_PATH = path.join(root, "gateway.db");
const secureRuntimeRoot = process.platform === "win32"
  ? path.join(
      path.resolve(String(process.env.LOCALAPPDATA || "")),
      "DevBench Hooks Tests",
      `Controller 固定 Runtime ${process.pid}-${Date.now()}`,
    )
  : "";
const secureNodeBinary = process.platform === "win32"
  ? path.join(secureRuntimeRoot, "node 固定.exe")
  : process.execPath;
if (process.platform === "win32") {
  fs.mkdirSync(secureRuntimeRoot, { recursive: true });
  fs.copyFileSync(process.execPath, secureNodeBinary);
}

const {
  createGitController,
} = await import("../services/devbench/git-controller/index.js");
const {
  createGitControllerCapabilityService,
} = await import("../services/devbench/git-controller-capability.js");
const {
  createManagedHooksController,
} = await import("../services/devbench/managed-hooks-controller.js");
const {
  installBaseProtectionHooks,
  uninstallBaseProtectionHooks,
} = await import("../services/devbench/base-protection-hooks.js");
const persistence = await import("../db/sqlite.js");

after(() => {
  persistence.default.close();
  const resolved = path.resolve(root);
  if (resolved.startsWith(`${path.resolve(os.tmpdir())}${path.sep}`)) {
    fs.rmSync(resolved, { recursive: true, force: true });
  }
  if (secureRuntimeRoot) {
    try { fs.rmSync(secureRuntimeRoot, { recursive: true, force: true }); } catch {}
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

function gitStatus(args, cwd = root) {
  return spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    windowsHide: true,
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: "0",
      GCM_INTERACTIVE: "Never",
    },
  });
}

function secureTestFile(filePath) {
  if (process.platform === "win32") {
    const identity = execFileSync("whoami", [], {
      encoding: "utf8",
      windowsHide: true,
    }).trim();
    execFileSync("icacls.exe", [
      filePath,
      "/inheritance:r",
      "/grant:r",
      `${identity}:(F)`,
      "*S-1-5-18:(F)",
    ], {
      windowsHide: true,
      stdio: "ignore",
    });
  } else {
    fs.chmodSync(filePath, 0o700);
  }
}

let harnessSequence = 0;

async function createHarness(label) {
  harnessSequence += 1;
  const name = `${String(label).replace(/[^A-Za-z0-9_-]/g, "-")}-${harnessSequence}`;
  const remote = path.join(root, `${name}-remote.git`);
  const seed = path.join(root, `${name}-seed`);
  const base = path.join(root, `${name}-base`);
  const dataRoot = path.join(root, `${name}-controller`);
  const capabilityRoot = path.join(root, `${name}-capabilities`);
  const managementHelper = path.join(root, `${name}-management-helper.mjs`);

  git(["init", "--bare", remote]);
  fs.mkdirSync(seed, { recursive: true });
  git(["init"], seed);
  git(["config", "user.name", "Managed Hooks Test"], seed);
  git(["config", "user.email", "managed-hooks@example.test"], seed);
  git(["checkout", "-b", "main"], seed);
  fs.writeFileSync(path.join(seed, "README.md"), `${name}\n`);
  git(["add", "README.md"], seed);
  git(["commit", "-m", "initial"], seed);
  git(["remote", "add", "origin", remote], seed);
  git(["push", "-u", "origin", "main"], seed);

  git(["clone", "--branch", "main", remote, base]);
  git(["config", "user.name", "Managed Hooks Test"], base);
  git(["config", "user.email", "managed-hooks@example.test"], base);
  fs.mkdirSync(dataRoot, { recursive: true });
  fs.writeFileSync(
    managementHelper,
    "process.stdout.write(JSON.stringify({ok:false,error:{code:'TEST_ONLY'}}));\n",
  );
  secureTestFile(managementHelper);

  const controller = await createGitController({
    definitions: [{
      logicalDefinitionId: `logical-${name}`,
      displayName: name,
      basePath: base,
      remoteId: "origin",
      expectedRemoteUrls: [remote],
      allowedBranches: ["main"],
    }],
    dataRoot,
    ownerInstance: `managed-hooks-test:${randomUUID()}`,
  });
  const entry = controller.registry.list()[0];
  const capabilityService = createGitControllerCapabilityService({
    dataRoot: capabilityRoot,
    resolveRepositoryFingerprint: async () => "a".repeat(64),
  });
  const service = createManagedHooksController({
    controller,
    capabilityService,
    managementClientDescriptor: {
      type: "command",
      executable: secureNodeBinary,
      helperPath: managementHelper,
      fixedArgs: [],
      timeoutMs: 5_000,
    },
    nodeBinary: secureNodeBinary,
  }, {
    previewTtlMs: 60_000,
  });
  return {
    name,
    remote,
    seed,
    base,
    dataRoot,
    controller,
    entry,
    capabilityService,
    service,
  };
}

async function executePreview(service, preview, idempotencyKey) {
  return service.execute({
    repositoryId: preview.repositoryId,
    action: preview.action,
    previewId: preview.previewId,
    previewVersion: preview.previewVersion,
    expectedHead: preview.expectedHead,
    candidateSha: preview.candidateSha,
    idempotencyKey,
    actor: "test:managed-hooks",
  });
}

async function install(harness, key = `install-${randomUUID()}`) {
  const preview = await harness.service.preview({
    repositoryId: harness.entry.repositoryId,
    action: "install",
  });
  assert.equal(preview.eligible, true);
  const result = await executePreview(harness.service, preview, key);
  assert.equal(result.protectionStatus, "ACTIVE");
  return { preview, result, key };
}

function managedHooksDirectory(base) {
  const common = git(
    ["-C", base, "rev-parse", "--path-format=absolute", "--git-common-dir"],
  );
  return path.join(common, "devbench-base-protection", "hooks");
}

function beginConsumedOperation(harness, preview, {
  operationType,
  commandId,
  idempotencyKey,
  deadOwner = false,
} = {}) {
  const journal = harness.controller.journal;
  const previousOwner = {
    ownerPid: journal.ownerPid,
    ownerProcessStartIdentity: journal.ownerProcessStartIdentity,
  };
  if (deadOwner) {
    journal.ownerPid = 2_147_483_646;
    journal.ownerProcessStartIdentity = process.platform === "win32"
      ? "windows-start:1"
      : process.platform === "darwin"
        ? "macos-start:1"
        : "linux-start:1";
  }
  let begun;
  try {
    begun = journal.begin({
      repositoryId: harness.entry.repositoryId,
      operationType,
      commandId,
      idempotencyKey,
      previewId: preview.previewId,
      branch: "__hooks__",
      expectedHead: preview.expectedHead,
      candidateSha: preview.candidateSha,
    });
  } finally {
    journal.ownerPid = previousOwner.ownerPid;
    journal.ownerProcessStartIdentity = previousOwner.ownerProcessStartIdentity;
  }
  assert.equal(begun.created, true);
  assert.equal(
    persistence.consumeGitControllerPreview(
      preview.previewId,
      begun.operation.operationId,
    ).ok,
    true,
  );
  return begun.operation;
}

function recoveryBinding(operation, preview, action) {
  const stored = persistence.getGitControllerPreview(preview.previewId);
  return {
    schemaVersion: 1,
    operationId: operation.operationId,
    previewId: operation.previewId,
    action,
    expectedHead: operation.expectedHead,
    candidateSha: operation.candidateSha,
    stateSignature: stored.payload.stateSignature,
    validatorDigest: stored.payload.validatorDigest || null,
    eligible: stored.eligible === true,
  };
}

test("hooks install/uninstall uses persisted exact-HEAD preview, fencing, journal, audit and idempotent replay", async () => {
  const harness = await createHarness("lifecycle");
  const installKey = `install-${randomUUID()}`;
  const preview = await harness.service.preview({
    repositoryId: harness.entry.repositoryId,
    action: "install",
  });
  const exactHead = git(["-C", harness.base, "rev-parse", "HEAD"]);
  assert.equal(preview.expectedHead, exactHead);
  assert.equal(preview.candidateSha, exactHead);
  assert.match(preview.expectedHead, /^[0-9a-f]{40}$/);
  assert.equal(preview.eligible, true);

  const installed = await executePreview(harness.service, preview, installKey);
  assert.equal(installed.ok, true);
  assert.equal(installed.changed, true);
  assert.equal(installed.hooks.status, "ACTIVE");
  assert.equal(installed.replayed, false);
  assert.equal(JSON.stringify(installed).includes(harness.base), false);
  assert.equal(JSON.stringify(installed).includes(harness.dataRoot), false);
  const installedManifestPath = path.join(
    git(["-C", harness.base, "rev-parse", "--path-format=absolute", "--git-common-dir"]),
    "devbench-base-protection",
    "manifest.json",
  );
  const installedManifest = JSON.parse(fs.readFileSync(installedManifestPath, "utf8"));
  assert.equal(installedManifest.controller.repositoryId, harness.entry.repositoryId);
  assert.equal(installedManifest.controller.managementClient.type, "command");
  assert.match(
    installedManifest.controller.managementClient.executableSha256,
    /^[0-9a-f]{64}$/,
  );
  assert.match(
    installedManifest.controller.managementClient.helperSha256,
    /^[0-9a-f]{64}$/,
  );

  const replay = await executePreview(harness.service, preview, installKey);
  assert.equal(replay.operationId, installed.operationId);
  assert.equal(replay.replayed, true);
  assert.equal(replay.changed, true);
  await assert.rejects(
    harness.service.execute({
      repositoryId: preview.repositoryId,
      action: preview.action,
      previewId: preview.previewId,
      previewVersion: preview.previewVersion,
      expectedHead: preview.expectedHead,
      candidateSha: "0".repeat(40),
      idempotencyKey: installKey,
      actor: "test:managed-hooks",
    }),
    (error) => error.code === "GIT_CONTROLLER_IDEMPOTENCY_CONFLICT",
  );

  const diagnosis = await harness.service.diagnose({
    repositoryId: harness.entry.repositoryId,
  });
  assert.deepEqual(
    {
      status: diagnosis.status,
      protected: diagnosis.protected,
      head: diagnosis.head,
    },
    {
      status: "ACTIVE",
      protected: true,
      head: exactHead,
    },
  );
  assert.equal(JSON.stringify(diagnosis).includes(harness.base), false);

  const journal = persistence.listGitControllerJournal(installed.operationId);
  assert.deepEqual(
    journal.map((row) => row.phase),
    [
      "PREVIEWED",
      "BASE_PREFLIGHT_PASSED",
      "BASE_APPLYING",
      "BASE_APPLIED",
      "VERIFIED",
    ],
  );
  assert.ok(journal.every((row) => Number(row.fencingToken || 0) > 0 || row.phase === "PREVIEWED"));
  const audit = persistence.listGitControllerAudit({
    repositoryId: harness.entry.repositoryId,
  });
  assert.ok(audit.some((row) => (
    row.operationId === installed.operationId
    && row.commandId === "hooks.install"
    && row.result === "PASS"
    && Number(row.fencingToken || 0) > 0
  )));

  const uninstallPreview = await harness.service.preview({
    repositoryId: harness.entry.repositoryId,
    action: "uninstall",
  });
  assert.equal(uninstallPreview.protectionStatus, "READY");
  assert.equal(uninstallPreview.eligible, true);
  const uninstallKey = `uninstall-${randomUUID()}`;
  const uninstalled = await executePreview(
    harness.service,
    uninstallPreview,
    uninstallKey,
  );
  assert.equal(uninstalled.changed, true);
  assert.equal(uninstalled.hooks.status, "UNINSTALLED");
  assert.equal(uninstalled.protectionStatus, "ALREADY_UNINSTALLED");
  const uninstallReplay = await executePreview(
    harness.service,
    uninstallPreview,
    uninstallKey,
  );
  assert.equal(uninstallReplay.operationId, uninstalled.operationId);
  assert.equal(uninstallReplay.replayed, true);
  assert.notEqual(
    gitStatus(["-C", harness.base, "config", "--local", "--get", "core.hooksPath"]).status,
    0,
  );
  assert.equal(fs.existsSync(harness.base), true);
  assert.equal(fs.existsSync(harness.remote), true);
});

test("startup recovery closes an exact install postcondition after the Controller response was lost", async () => {
  const harness = await createHarness("install-startup-recovery");
  const preview = await harness.service.preview({
    repositoryId: harness.entry.repositoryId,
    action: "install",
  });
  const operation = beginConsumedOperation(harness, preview, {
    operationType: "HOOKS_INSTALL",
    commandId: "hooks.install",
    idempotencyKey: `install-recovery-${randomUUID()}`,
    deadOwner: true,
  });
  harness.controller.journal.append(operation, "BASE_PREFLIGHT_PASSED", {
    action: "install",
  });
  harness.controller.journal.append(operation, "BASE_APPLYING", {
    action: "install",
  });
  const binding = recoveryBinding(operation, preview, "install");
  const installed = installBaseProtectionHooks(harness.entry.basePath, {
    capabilityValidatorDescriptor: harness.capabilityService.validatorDescriptor,
    repositoryId: harness.entry.repositoryId,
    managementClientDescriptor: harness.service.managementClientDescriptor,
    runtimeExecutablePaths: harness.service.runtimeExecutablePaths,
    controllerOperationBinding: binding,
  });
  assert.equal(installed.status, "ACTIVE");

  const recovery = await harness.service.recover();
  assert.deepEqual(recovery, {
    recovered: 1,
    installed: 1,
    uninstalled: 0,
  });
  const completed = persistence.getGitControllerOperation(operation.operationId);
  assert.equal(completed.status, "SUCCEEDED");
  assert.equal(completed.result?.recovered, true);
  assert.equal(completed.result?.protectionStatus, "ACTIVE");
  assert.equal(
    (await harness.service.diagnose({
      repositoryId: harness.entry.repositoryId,
    })).status,
    "ACTIVE",
  );
  const passAudit = persistence.listGitControllerAudit({
    operationId: operation.operationId,
  }).filter((row) => (
    row.action === "base-protection.hooks.install"
    && row.result === "PASS"
  ));
  assert.equal(passAudit.length, 1);
  assert.deepEqual(await harness.service.recover(), {
    recovered: 0,
    installed: 0,
    uninstalled: 0,
  });
  assert.equal(
    persistence.listGitControllerAudit({
      operationId: operation.operationId,
    }).filter((row) => (
      row.action === "base-protection.hooks.install"
      && row.result === "PASS"
    )).length,
    1,
  );
});

test("startup recovery refuses a live operation owner even when its lease and OS lock are absent", async () => {
  const harness = await createHarness("live-owner-without-lease");
  const preview = await harness.service.preview({
    repositoryId: harness.entry.repositoryId,
    action: "install",
  });
  const operation = beginConsumedOperation(harness, preview, {
    operationType: "HOOKS_INSTALL",
    commandId: "hooks.install",
    idempotencyKey: `live-owner-${randomUUID()}`,
  });

  await assert.rejects(
    harness.service.recover(),
    (error) => (
      error.code === "GIT_CONTROLLER_HOOKS_STARTUP_RECOVERY_BLOCKED"
      && error.details?.errors?.includes("GIT_CONTROLLER_OPERATION_IN_PROGRESS")
    ),
  );
  assert.equal(
    persistence.getGitControllerOperation(operation.operationId).status,
    "RUNNING",
  );
  harness.controller.journal.fail(
    operation,
    Object.assign(new Error("test cleanup"), { code: "TEST_CLEANUP" }),
  );
});

test("startup recovery keeps preview state drift RECOVERY_REQUIRED without an exact operation-bound manifest", async () => {
  const harness = await createHarness("preview-state-drift");
  const preview = await harness.service.preview({
    repositoryId: harness.entry.repositoryId,
    action: "install",
  });
  const operation = beginConsumedOperation(harness, preview, {
    operationType: "HOOKS_INSTALL",
    commandId: "hooks.install",
    idempotencyKey: `preview-drift-${randomUUID()}`,
    deadOwner: true,
  });
  harness.controller.journal.append(operation, "BASE_APPLYING", {
    action: "install",
  });
  const externalInstall = installBaseProtectionHooks(harness.entry.basePath, {
    capabilityValidatorDescriptor: harness.capabilityService.validatorDescriptor,
    repositoryId: harness.entry.repositoryId,
    managementClientDescriptor: harness.service.managementClientDescriptor,
    runtimeExecutablePaths: harness.service.runtimeExecutablePaths,
  });
  assert.equal(externalInstall.status, "ACTIVE");

  await assert.rejects(
    harness.service.recover(),
    (error) => (
      error.code === "GIT_CONTROLLER_HOOKS_STARTUP_RECOVERY_BLOCKED"
      && error.details?.errors?.includes(
        "GIT_CONTROLLER_HOOKS_RECOVERY_STATE_DRIFT",
      )
    ),
  );
  const blocked = persistence.getGitControllerOperation(operation.operationId);
  assert.equal(blocked.status, "RECOVERY_REQUIRED");
  assert.equal(
    blocked.resultCode,
    "GIT_CONTROLLER_HOOKS_RECOVERY_STATE_DRIFT",
  );
  assert.equal(
    (await harness.service.diagnose({
      repositoryId: harness.entry.repositoryId,
    })).status,
    "ACTIVE",
  );
});

test("standalone uninstall replays a persisted RECOVERY_REQUIRED operation without a new preview", async () => {
  const harness = await createHarness("crash-recovery");
  await install(harness);
  const preview = await harness.service.preview({
    repositoryId: harness.entry.repositoryId,
    action: "uninstall",
  });
  const idempotencyKey = `recovery-${randomUUID()}`;
  const normalApply = harness.service.applyAction.bind(harness.service);
  let injected = false;
  harness.service.applyAction = (
    entry,
    descriptor,
    ownLease,
    operationBinding,
  ) => {
    if (descriptor.action !== "uninstall" || injected) {
      return normalApply(entry, descriptor, ownLease, operationBinding);
    }
    injected = true;
    return uninstallBaseProtectionHooks(entry.basePath, {
      activeLeaseCheck: harness.service.activityCheck(entry, ownLease),
      controllerOperationBinding: operationBinding,
      phaseHook({ phase }) {
        if (phase === "ORIGINAL_HOOKS_RESTORED") {
          throw new Error("simulated Controller crash");
        }
      },
    });
  };
  const journal = harness.controller.journal;
  const previousOwner = {
    ownerPid: journal.ownerPid,
    ownerProcessStartIdentity: journal.ownerProcessStartIdentity,
  };
  journal.ownerPid = 2_147_483_646;
  journal.ownerProcessStartIdentity = process.platform === "win32"
    ? "windows-start:1"
    : process.platform === "darwin"
      ? "macos-start:1"
      : "linux-start:1";
  try {
    await assert.rejects(
      executePreview(harness.service, preview, idempotencyKey),
      (error) => error.code === "GIT_CONTROLLER_HOOKS_UNINSTALL_FAILED",
    );
  } finally {
    journal.ownerPid = previousOwner.ownerPid;
    journal.ownerProcessStartIdentity = previousOwner.ownerProcessStartIdentity;
  }
  const interrupted = persistence.getGitControllerOperationByIdempotency(
    harness.entry.repositoryId,
    "HOOKS_UNINSTALL",
    idempotencyKey,
  );
  assert.equal(interrupted.status, "RECOVERY_REQUIRED");

  harness.service.applyAction = normalApply;
  let exactManifestChecks = 0;
  const recovered = await harness.service.standaloneUninstall({
    repositoryId: harness.entry.repositoryId,
    idempotencyKey,
  }, {
    verifyInstallation: async () => {
      exactManifestChecks += 1;
    },
  });
  assert.equal(recovered.ok, true);
  assert.equal(recovered.recovered, true);
  assert.equal(recovered.operationId, interrupted.operationId);
  assert.ok(exactManifestChecks >= 2);
  const completed = persistence.getGitControllerOperation(interrupted.operationId);
  assert.equal(completed.status, "SUCCEEDED");
  assert.equal(completed.phase, "VERIFIED");
  assert.equal(
    (await harness.service.diagnose({
      repositoryId: harness.entry.repositoryId,
    })).status,
    "ALREADY_UNINSTALLED",
  );
});

test("execute rejects a preview when exact base HEAD changed and leaves hooks uninstalled", async () => {
  const harness = await createHarness("stale-head");
  const preview = await harness.service.preview({
    repositoryId: harness.entry.repositoryId,
    action: "install",
  });
  fs.writeFileSync(path.join(harness.base, "after-preview.txt"), "changed\n");
  git(["-C", harness.base, "add", "after-preview.txt"]);
  git(["-C", harness.base, "commit", "-m", "change after preview"]);

  const key = `stale-${randomUUID()}`;
  await assert.rejects(
    executePreview(harness.service, preview, key),
    (error) => error.code === "GIT_CONTROLLER_PREVIEW_STALE",
  );
  const operation = persistence.getGitControllerOperationByIdempotency(
    harness.entry.repositoryId,
    "HOOKS_INSTALL",
    key,
  );
  assert.equal(operation.status, "FAILED");
  assert.equal(operation.resultCode, "GIT_CONTROLLER_PREVIEW_STALE");
  const diagnosis = await harness.service.diagnose({
    repositoryId: harness.entry.repositoryId,
  });
  assert.equal(diagnosis.protected, false);
  assert.equal(fs.existsSync(managedHooksDirectory(harness.base)), false);
});

test("preview reports another Controller lease but does not misclassify its own execute lease", async () => {
  const harness = await createHarness("lease");
  await install(harness);
  const foreignLease = harness.controller.leaseManager.acquire(harness.entry, {
    operationId: randomUUID(),
    kind: "test-foreign-operation",
  });
  try {
    const blocked = await harness.service.preview({
      repositoryId: harness.entry.repositoryId,
      action: "uninstall",
    });
    assert.equal(blocked.eligible, false);
    assert.equal(blocked.blockerCode, "GIT_CONTROLLER_REPOSITORY_BUSY");
    assert.ok(blocked.issues.includes("ACTIVE_REPOSITORY_LEASE"));
  } finally {
    foreignLease.release();
  }

  const ready = await harness.service.preview({
    repositoryId: harness.entry.repositoryId,
    action: "uninstall",
  });
  assert.equal(ready.eligible, true);
  const result = await executePreview(
    harness.service,
    ready,
    `own-lease-${randomUUID()}`,
  );
  assert.equal(result.hooks.status, "UNINSTALLED");
});

test("uninstall fails closed while a legacy linked worktree exists and removes nothing", async () => {
  const harness = await createHarness("legacy-worktree");
  const linked = path.join(root, `${harness.name}-linked`);
  git([
    "-C",
    harness.base,
    "worktree",
    "add",
    "--detach",
    "--no-checkout",
    linked,
    "HEAD",
  ]);
  await install(harness);
  const dispatcher = path.join(managedHooksDirectory(harness.base), "pre-commit");
  const before = fs.readFileSync(dispatcher);

  const preview = await harness.service.preview({
    repositoryId: harness.entry.repositoryId,
    action: "uninstall",
  });
  assert.equal(preview.eligible, false);
  assert.equal(
    preview.blockerCode,
    "GIT_CONTROLLER_HOOKS_LEGACY_WORKTREE_ACTIVE",
  );
  assert.ok(preview.issues.includes("ACTIVE_LEGACY_LINKED_WORKTREE"));
  await assert.rejects(
    executePreview(
      harness.service,
      preview,
      `legacy-blocked-${randomUUID()}`,
    ),
    (error) => error.code === "GIT_CONTROLLER_HOOKS_LEGACY_WORKTREE_ACTIVE",
  );
  assert.deepEqual(fs.readFileSync(dispatcher), before);
  assert.equal(fs.existsSync(linked), true);
  const diagnosis = await harness.service.diagnose({
    repositoryId: harness.entry.repositoryId,
  });
  assert.equal(diagnosis.status, "ACTIVE");
});

test("dispatcher drift blocks uninstall and preserves the drifted bytes", async () => {
  const harness = await createHarness("drift");
  await install(harness);
  const dispatcher = path.join(managedHooksDirectory(harness.base), "pre-push");
  fs.appendFileSync(dispatcher, "\n# operator drift must be preserved\n");
  const before = fs.readFileSync(dispatcher);

  const preview = await harness.service.preview({
    repositoryId: harness.entry.repositoryId,
    action: "uninstall",
  });
  assert.equal(preview.eligible, false);
  assert.equal(preview.blockerCode, "GIT_CONTROLLER_HOOKS_DRIFTED");
  assert.ok(preview.issues.includes("DISPATCHER_HASH_DRIFT:pre-push"));
  await assert.rejects(
    executePreview(
      harness.service,
      preview,
      `drift-blocked-${randomUUID()}`,
    ),
    (error) => error.code === "GIT_CONTROLLER_HOOKS_DRIFTED",
  );
  assert.deepEqual(fs.readFileSync(dispatcher), before);
  assert.equal(fs.existsSync(harness.base), true);
  assert.equal(fs.existsSync(harness.remote), true);
});

test("repository paths cannot be substituted for registered repository ids", async () => {
  const harness = await createHarness("repository-id-only");
  await assert.rejects(
    harness.service.preview({
      repositoryId: harness.base,
      action: "install",
    }),
    (error) => error.code === "GIT_CONTROLLER_REPOSITORY_NOT_REGISTERED",
  );
  assert.notEqual(
    gitStatus(["-C", harness.base, "config", "--local", "--get", "core.hooksPath"]).status,
    0,
  );
});
