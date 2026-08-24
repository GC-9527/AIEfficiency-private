import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "git-controller-base-ignored-"));
process.env.GATEWAY_DB_PATH = path.join(root, "gateway.db");

const {
  createGitController,
  runGitFile,
} = await import("../services/devbench/git-controller/index.js");
const persistence = await import("../db/sqlite.js");

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
  git(["remote", "add", "origin", remote], seed);
  git(["push", "-u", "origin", "main"], seed);
  const base = path.join(fixtureRoot, "base");
  git(["clone", "--branch", "main", remote, base]);
  git(["config", "user.name", "Controller Test"], base);
  git(["config", "user.email", "controller@example.test"], base);
  git(["config", "core.autocrlf", "false"], base);
  git(["reset", "--hard", "HEAD"], base);
  const dataRoot = path.join(fixtureRoot, "data");
  fs.mkdirSync(dataRoot);
  return { fixtureRoot, remote, seed, base, dataRoot };
}

async function makeController(fixture, {
  commandLog = [],
  beforeGitCommand = null,
} = {}) {
  const gitRunner = async (options) => {
    if (typeof beforeGitCommand === "function") {
      await beforeGitCommand(options);
    }
    commandLog.push({
      commandId: options.commandId,
      args: [...(options.args || [])],
    });
    return runGitFile(options);
  };
  const controller = await createGitController({
    dataRoot: fixture.dataRoot,
    definitions: [{
      logicalDefinitionId: `logical-${path.basename(fixture.fixtureRoot)}`,
      displayName: "Ignored path safety test",
      basePath: fixture.base,
      remoteId: "origin",
      expectedRemoteUrls: [fixture.remote],
      allowedBranches: ["main"],
    }],
    gitRunner,
    leaseTtlMs: 20_000,
  });
  return { controller, entry: controller.registry.list()[0] };
}

function commitAndPush(seed, file, content, message, { force = false } = {}) {
  const destination = path.join(seed, file);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, content);
  git(["add", ...(force ? ["-f"] : []), file], seed);
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

async function executeBasePreview(controller, preview) {
  return controller.base.execute({
    repositoryId: preview.repositoryId,
    branch: preview.branch,
    previewId: preview.previewId,
    previewVersion: preview.previewVersion,
    expectedHead: preview.expectedHead,
    candidateSha: preview.candidateSha,
    idempotencyKey: randomUUID(),
  });
}

async function installIgnoredPathPolicy(fixture, controller, entry, contents) {
  const policySha = commitAndPush(
    fixture.seed,
    ".gitignore",
    contents,
    "configure ignored test paths",
  );
  await acceptRemote(controller, entry);
  const preview = await controller.base.preview({
    repositoryId: entry.repositoryId,
    branch: "main",
  });
  assert.equal(preview.eligible, true, JSON.stringify(preview, null, 2));
  const result = await executeBasePreview(controller, preview);
  assert.equal(result.head, policySha);
}

test("base sync preserves unrelated ignored cache while fast-forwarding", async () => {
  const fixture = createFixture("unrelated");
  const { controller, entry } = await makeController(fixture);
  await acceptRemote(controller, entry);
  await installIgnoredPathPolicy(fixture, controller, entry, "cache.bin\n");

  const cachePath = path.join(fixture.base, "cache.bin");
  fs.writeFileSync(cachePath, "LOCAL-IGNORED-DATA\n");
  const candidateSha = commitAndPush(
    fixture.seed,
    "remote-change.txt",
    "remote\n",
    "unrelated remote change",
  );
  await acceptRemote(controller, entry);

  const preview = await controller.base.preview({
    repositoryId: entry.repositoryId,
    branch: "main",
  });
  assert.equal(preview.eligible, true, JSON.stringify(preview, null, 2));
  assert.equal(preview.checks.ignoredPathSafety.status, "VERIFIED");
  assert.equal(preview.checks.ignoredPathSafety.conflictCount, 0);
  assert.ok(preview.checks.ignoredPathSafety.ignoredPathCount >= 1);
  const result = await executeBasePreview(controller, preview);
  assert.equal(result.head, candidateSha);
  assert.equal(fs.readFileSync(cachePath, "utf8"), "LOCAL-IGNORED-DATA\n");
});

test("base preview blocks candidate writes that collide with ignored files and directories", async () => {
  const fixture = createFixture("preview-conflict");
  const { controller, entry } = await makeController(fixture);
  await acceptRemote(controller, entry);
  await installIgnoredPathPolicy(
    fixture,
    controller,
    entry,
    "缓存 文件.bin\ncache-dir/\n",
  );

  const ignoredFile = path.join(fixture.base, "缓存 文件.bin");
  const ignoredDirectory = path.join(fixture.base, "cache-dir");
  fs.mkdirSync(ignoredDirectory);
  fs.writeFileSync(ignoredFile, "LOCAL-FILE\n");
  fs.writeFileSync(path.join(ignoredDirectory, "local.bin"), "LOCAL-DIRECTORY\n");
  commitAndPush(
    fixture.seed,
    "缓存 文件.bin",
    "REMOTE-FILE\n",
    "candidate ignored file",
    { force: true },
  );
  commitAndPush(
    fixture.seed,
    "cache-dir/remote.txt",
    "REMOTE-DIRECTORY\n",
    "candidate ignored directory",
    { force: true },
  );
  await acceptRemote(controller, entry);
  const beforeHead = git(["rev-parse", "HEAD"], fixture.base);

  const preview = await controller.base.preview({
    repositoryId: entry.repositoryId,
    branch: "main",
  });
  assert.equal(preview.eligible, false);
  assert.equal(preview.blockerCode, "BASE_SYNC_BLOCKED_IGNORED_COLLISION");
  assert.equal(preview.checks.ignoredPathSafety.status, "BLOCKED");
  assert.ok(preview.checks.ignoredPathSafety.conflictCount >= 2);
  assert.ok(preview.checks.ignoredPathSafety.conflicts.some((item) => (
    item.ignoredPath === "缓存 文件.bin"
    && item.candidatePath === "缓存 文件.bin"
  )));
  assert.ok(preview.checks.ignoredPathSafety.conflicts.some((item) => (
    item.ignoredPath === "cache-dir"
    && item.candidatePath === "cache-dir/remote.txt"
  )));
  assert.equal(git(["rev-parse", "HEAD"], fixture.base), beforeHead);
  assert.equal(fs.readFileSync(ignoredFile, "utf8"), "LOCAL-FILE\n");
  assert.equal(
    fs.readFileSync(path.join(ignoredDirectory, "local.bin"), "utf8"),
    "LOCAL-DIRECTORY\n",
  );
});

test("base merge refuses an ignored collision created after the final preflight", async () => {
  const fixture = createFixture("race-conflict");
  const racePath = path.join(fixture.base, "race.bin");
  let injectRace = false;
  let injected = false;
  const commandLog = [];
  const { controller, entry } = await makeController(fixture, {
    commandLog,
    beforeGitCommand(options) {
      if (
        injectRace
        && !injected
        && options.commandId === "base.merge-fast-forward"
      ) {
        fs.writeFileSync(racePath, "LOCAL-RACE-DATA\n");
        injected = true;
      }
    },
  });
  await acceptRemote(controller, entry);
  await installIgnoredPathPolicy(fixture, controller, entry, "race.bin\n");
  commitAndPush(
    fixture.seed,
    "race.bin",
    "REMOTE-RACE-DATA\n",
    "candidate race path",
    { force: true },
  );
  await acceptRemote(controller, entry);
  const preview = await controller.base.preview({
    repositoryId: entry.repositoryId,
    branch: "main",
  });
  assert.equal(preview.eligible, true, JSON.stringify(preview, null, 2));
  const beforeHead = git(["rev-parse", "HEAD"], fixture.base);
  injectRace = true;

  await assert.rejects(
    executeBasePreview(controller, preview),
    (error) => (
      error.code === "GIT_CONTROLLER_COMMAND_FAILED"
      || error.code === "GIT_CONTROLLER_BASE_SYNC_FAILED"
    ),
  );
  assert.equal(injected, true);
  assert.equal(git(["rev-parse", "HEAD"], fixture.base), beforeHead);
  assert.equal(fs.readFileSync(racePath, "utf8"), "LOCAL-RACE-DATA\n");
  const merge = commandLog.findLast((item) => item.commandId === "base.merge-fast-forward");
  assert.ok(merge?.args.includes("--no-overwrite-ignore"));
});
