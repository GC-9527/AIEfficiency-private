import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "gcir-"));
process.env.GATEWAY_DB_PATH = path.join(root, "gateway.db");

const {
  controllerAcceptedHistoryRef,
  controllerAcceptedRef,
  controllerBaseDestinationRef,
  controllerIncomingRef,
  controllerInternalRefToken,
  createGitController,
  gitLongPathsConfigArgs,
  INTERNAL_REF_TOKEN_LENGTH,
  runGitFile,
} = await import("../services/devbench/git-controller/index.js");
const {
  createIndependentStoryRepository,
} = await import("../services/devbench/git-controller/story-repository.js");
const persistence = await import("../db/sqlite.js");

after(() => {
  persistence.default.close();
  const resolved = path.resolve(root);
  if (resolved.startsWith(path.resolve(os.tmpdir()) + path.sep)) {
    fs.rmSync(resolved, { recursive: true, force: true });
  }
});

function isolatedGitEnv() {
  return {
    ...process.env,
    GIT_TERMINAL_PROMPT: "0",
    GCM_INTERACTIVE: "Never",
    GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
  };
}

function git(args, cwd = root) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    windowsHide: true,
    env: isolatedGitEnv(),
  }).trim();
}

function gitResult(args, cwd = root) {
  return spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    windowsHide: true,
    env: isolatedGitEnv(),
  });
}

function replacePackedHead(repositoryPath, branch, sha, { bare = false } = {}) {
  const gitDirectory = bare ? repositoryPath : path.join(repositoryPath, ".git");
  git(
    bare
      ? ["--git-dir", repositoryPath, "pack-refs", "--all", "--prune"]
      : ["pack-refs", "--all", "--prune"],
    repositoryPath,
  );
  const packedPath = path.join(gitDirectory, "packed-refs");
  const original = fs.readFileSync(packedPath, "utf8");
  const mainRecord = `${sha} refs/heads/main`;
  assert.ok(original.includes(mainRecord), "fixture must contain packed main");
  fs.writeFileSync(
    packedPath,
    original.replace(mainRecord, `${sha} refs/heads/${branch}`),
    "utf8",
  );
  fs.writeFileSync(path.join(gitDirectory, "HEAD"), `ref: refs/heads/${branch}\n`, "utf8");
}

test("Controller internal refs use stable, domain-separated fixed-width SHA-256 tokens", () => {
  const remoteId = "r".repeat(64);
  const branch = "b".repeat(240);
  const accepted = controllerAcceptedRef(remoteId, branch);
  const history1 = controllerAcceptedHistoryRef(remoteId, branch, 1);
  const history2 = controllerAcceptedHistoryRef(remoteId, branch, 2);
  const incoming = controllerIncomingRef("operation-1", branch);
  const destination = controllerBaseDestinationRef(remoteId, branch);

  assert.equal(INTERNAL_REF_TOKEN_LENGTH, 32);
  assert.equal(
    controllerInternalRefToken("accepted", [remoteId, branch]),
    controllerInternalRefToken("accepted", [remoteId, branch]),
  );
  assert.notEqual(accepted, history1);
  assert.notEqual(history1, history2);
  assert.notEqual(incoming, destination);
  for (const refName of [accepted, history1, history2, incoming, destination]) {
    assert.equal(refName.includes(remoteId), false);
    assert.equal(refName.includes(branch), false);
    assert.equal(gitResult(["check-ref-format", refName]).status, 0, refName);
  }
  assert.equal(path.basename(accepted).length, INTERNAL_REF_TOKEN_LENGTH + 2);
  assert.equal(path.basename(history1).length, INTERNAL_REF_TOKEN_LENGTH + 2);
  assert.equal(path.basename(incoming).length, INTERNAL_REF_TOKEN_LENGTH + 2);
  assert.equal(path.basename(destination).length, INTERNAL_REF_TOKEN_LENGTH + 2);
});

test("real bare mirror refresh, story provision and base sync support 64-char remote plus 240-char branch without configured core.longpaths", async (t) => {
  const fixtureRoot = path.join(root, "l");
  fs.mkdirSync(fixtureRoot);
  const remote = path.join(fixtureRoot, "r.git");
  const seed = path.join(fixtureRoot, "s");
  const base = path.join(fixtureRoot, "b");
  const dataRoot = path.join(fixtureRoot, "d");
  const storyRoot = path.join(fixtureRoot, "w");
  const remoteId = "r".repeat(64);
  const branch = "b".repeat(240);

  git(["init", "--bare", remote]);
  fs.mkdirSync(seed);
  git(["init"], seed);
  git(["config", "user.name", "Controller Internal Ref Test"], seed);
  git(["config", "user.email", "controller-internal-ref@example.test"], seed);
  git(["checkout", "-b", "main"], seed);
  fs.writeFileSync(path.join(seed, "README.md"), "exact sha\n", "utf8");
  git(["add", "README.md"], seed);
  git(["commit", "-m", "initial"], seed);
  const exactSha = git(["rev-parse", "HEAD"], seed);
  git(["remote", "add", "origin", remote], seed);
  git(["push", "origin", "main"], seed);
  git(["clone", "--branch", "main", remote, base]);
  git(["config", "user.name", "Controller Internal Ref Test"], base);
  git(["config", "user.email", "controller-internal-ref@example.test"], base);
  git(["config", "core.autocrlf", "false"], base);
  git(["reset", "--hard", "HEAD"], base);
  git(["remote", "rename", "origin", remoteId], base);

  // Keep the deliberately long external refs in packed-refs. This isolates
  // the regression to the Controller's own loose refs and preserves the
  // original refs/heads name without requiring machine-wide long-path config.
  replacePackedHead(remote, branch, exactSha, { bare: true });
  replacePackedHead(base, branch, exactSha);
  git(["config", "--remove-section", "branch.main"], base);
  git(["config", `branch.${branch}.remote`, remoteId], base);
  git(["config", `branch.${branch}.merge`, `refs/heads/${branch}`], base);

  const packedBaseRef = gitResult([
    ...gitLongPathsConfigArgs(),
    "show-ref",
    "--verify",
    `refs/heads/${branch}`,
  ], base);
  assert.equal(
    packedBaseRef.status,
    0,
    `${packedBaseRef.stderr}\n${fs.readFileSync(path.join(base, ".git", "packed-refs"), "utf8")}`,
  );
  assert.equal(git([
    ...gitLongPathsConfigArgs(),
    "symbolic-ref",
    "--short",
    "HEAD",
  ], base), branch);
  assert.equal(
    git([
      ...gitLongPathsConfigArgs(),
      "--git-dir",
      remote,
      "rev-parse",
      `refs/heads/${branch}`,
    ]),
    exactSha,
  );
  assert.notEqual(gitResult(["config", "--local", "--get", "core.longpaths"], base).status, 0);
  assert.notEqual(gitResult(["config", "--global", "--get", "core.longpaths"], base).status, 0);

  fs.mkdirSync(dataRoot);
  const commandLog = [];
  const controller = await createGitController({
    dataRoot,
    definitions: [{
      logicalDefinitionId: "long-internal-ref-fixture",
      displayName: "Long internal ref fixture",
      basePath: base,
      remoteId,
      expectedRemoteUrls: [remote],
      allowedBranches: [branch],
    }],
    gitRunner: async (options) => {
      commandLog.push({
        commandId: options.commandId,
        args: [...(options.args || [])],
      });
      return runGitFile(options);
    },
    leaseTtlMs: 20_000,
  });
  const entry = controller.registry.list()[0];

  const mirrorPreview = await controller.mirror.preview({
    repositoryId: entry.repositoryId,
    branch,
  });
  assert.equal(mirrorPreview.candidateSha, exactSha);
  const acceptedResult = await controller.mirror.execute({
    repositoryId: entry.repositoryId,
    branch,
    previewId: mirrorPreview.previewId,
    previewVersion: mirrorPreview.previewVersion,
    expectedAcceptedSha: null,
    candidateSha: exactSha,
    idempotencyKey: randomUUID(),
  });
  assert.equal(acceptedResult.ok, true);

  const acceptedRef = controllerAcceptedRef(remoteId, branch);
  const historyRef = controllerAcceptedHistoryRef(remoteId, branch, 1);
  assert.equal(git(["--git-dir", entry.mirrorPath, "rev-parse", acceptedRef]), exactSha);
  assert.equal(git(["--git-dir", entry.mirrorPath, "rev-parse", historyRef]), exactSha);
  const mirrorInternalRefs = git([
    "--git-dir",
    entry.mirrorPath,
    "for-each-ref",
    "--format=%(refname)",
    "refs/devbench",
  ]).split(/\r?\n/).filter(Boolean);
  assert.ok(mirrorInternalRefs.length >= 2);
  assert.ok(mirrorInternalRefs.every((refName) => (
    !refName.includes(remoteId)
    && !refName.includes(branch)
    && refName.length <= historyRef.length
  )));

  const accepted = await controller.mirror.resolveAcceptedCandidate({
    repositoryId: entry.repositoryId,
    branch,
    candidateSha: exactSha,
  });
  assert.equal(accepted.acceptedRef, acceptedRef);
  const story = await createIndependentStoryRepository({
    root: storyRoot,
    storyId: "long-ref-story",
    accepted,
    branch: "story/long-internal-ref",
    gitBinary: controller.registry.gitBinary,
  });
  t.after(() => {
    if (fs.existsSync(story.repositoryPath)) {
      fs.rmSync(story.repositoryPath, { recursive: true, force: true });
    }
  });
  assert.equal(git(["rev-parse", "HEAD"], story.repositoryPath), exactSha);

  const basePreview = await controller.base.preview({
    repositoryId: entry.repositoryId,
    branch,
  });
  assert.equal(basePreview.relationship, "UNCHANGED");
  assert.equal(basePreview.eligible, true, JSON.stringify(basePreview, null, 2));
  const baseResult = await controller.base.execute({
    repositoryId: entry.repositoryId,
    branch,
    previewId: basePreview.previewId,
    previewVersion: basePreview.previewVersion,
    expectedHead: basePreview.expectedHead,
    candidateSha: basePreview.candidateSha,
    idempotencyKey: randomUUID(),
  });
  assert.equal(baseResult.ok, true);
  assert.equal(git([
    ...gitLongPathsConfigArgs(),
    "symbolic-ref",
    "--short",
    "HEAD",
  ], base), branch);
  assert.equal(git([
    ...gitLongPathsConfigArgs(),
    "rev-parse",
    "HEAD",
  ], base), exactSha);
  assert.equal(
    git(["rev-parse", controllerBaseDestinationRef(remoteId, branch)], base),
    exactSha,
  );

  const mirrorFetch = commandLog.find((row) => row.commandId === "mirror.fetch-incoming");
  assert.ok(mirrorFetch.args.includes(
    `+refs/heads/${branch}:${
      controllerIncomingRef(acceptedResult.operationId, branch)
    }`,
  ));
  const baseFetch = commandLog.find((row) => row.commandId === "base.fetch-accepted");
  assert.ok(baseFetch.args.includes(
    `${acceptedRef}:${controllerBaseDestinationRef(remoteId, branch)}`,
  ));
});
