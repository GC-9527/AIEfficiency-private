import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "sb-"));
process.env.GATEWAY_DB_PATH = path.join(root, "gateway.db");

const {
  controllerAcceptedRef,
  createGitController,
  runGitFile,
} = await import("../services/devbench/git-controller/index.js");
const {
  createIndependentStoryRepository,
  INDEPENDENT_REPOSITORY_MODE,
} = await import("../services/devbench/git-controller/story-repository.js");
const {
  createStoryBaselineService,
  StoryBaselineService,
  STORY_BASELINE_STRATEGY,
} = await import("../services/devbench/story-baseline.js");
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
      GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_ATTR_NOSYSTEM: "1",
    },
  }).trim();
}

function createGitFixture(label) {
  const fixtureRoot = path.join(root, label);
  fs.mkdirSync(fixtureRoot);
  const remote = path.join(fixtureRoot, "remote.git");
  git(["init", "--bare", remote]);
  const seed = path.join(fixtureRoot, "seed");
  fs.mkdirSync(seed);
  git(["init"], seed);
  git(["config", "user.name", "Story Baseline Test"], seed);
  git(["config", "user.email", "story-baseline@example.test"], seed);
  git(["checkout", "-b", "main"], seed);
  fs.writeFileSync(path.join(seed, "README.md"), "accepted-a\n");
  git(["add", "README.md"], seed);
  git(["commit", "-m", "accepted A"], seed);
  const initialSha = git(["rev-parse", "HEAD"], seed);
  git(["remote", "add", "origin", remote], seed);
  git(["push", "-u", "origin", "main"], seed);
  const base = path.join(fixtureRoot, "base");
  git(["clone", "--branch", "main", remote, base]);
  git(["config", "user.name", "Story Baseline Test"], base);
  git(["config", "user.email", "story-baseline@example.test"], base);
  const dataRoot = path.join(fixtureRoot, "controller-data");
  fs.mkdirSync(dataRoot);
  return {
    label,
    fixtureRoot,
    remote,
    seed,
    base,
    dataRoot,
    storyRoot: path.join(root, "s", label.slice(0, 4)),
    initialSha,
  };
}

async function createControllerFixture(label) {
  const fixture = createGitFixture(label);
  const commandLog = [];
  const gitRunner = async (options) => {
    commandLog.push({
      commandId: options.commandId,
      args: [...(options.args || [])],
    });
    return runGitFile(options);
  };
  const controller = await createGitController({
    dataRoot: fixture.dataRoot,
    definitions: [{
      logicalDefinitionId: `logical-${label}`,
      displayName: `Story baseline ${label}`,
      basePath: fixture.base,
      remoteId: "origin",
      expectedRemoteUrls: [fixture.remote],
      allowedBranches: ["main"],
    }],
    gitRunner,
    leaseTtlMs: 20_000,
  });
  const entry = controller.registry.list()[0];
  const service = createStoryBaselineService({
    controller,
    persistence,
    gitRunner,
    previewTtlMs: 60_000,
  });
  return { ...fixture, controller, entry, service, commandLog };
}

async function acceptRemote(fixture) {
  const preview = await fixture.controller.mirror.preview({
    repositoryId: fixture.entry.repositoryId,
    branch: "main",
  });
  const result = await fixture.controller.mirror.execute({
    repositoryId: fixture.entry.repositoryId,
    branch: "main",
    previewId: preview.previewId,
    previewVersion: preview.previewVersion,
    expectedAcceptedSha: preview.lastAcceptedSha,
    candidateSha: preview.candidateSha,
    idempotencyKey: randomUUID(),
  });
  return {
    repositoryId: fixture.entry.repositoryId,
    remoteId: fixture.entry.remoteId,
    mirrorPath: fixture.entry.mirrorPath,
    candidateSha: result.candidateSha,
    sourceRef: "refs/heads/main",
    mirrorGeneration: result.generation,
  };
}

function advanceRemote(fixture, name, content = `${name}\n`) {
  fs.writeFileSync(path.join(fixture.seed, name), content);
  git(["add", name], fixture.seed);
  git(["commit", "-m", `advance ${name}`], fixture.seed);
  git(["push", "origin", "main"], fixture.seed);
  return git(["rev-parse", "HEAD"], fixture.seed);
}

test("production blocks Controller-path story Git until an OS-confined Worker executor exists", () => {
  const previous = process.env.NODE_ENV;
  const previousUnsafe = process.env.DEVBENCH_ALLOW_UNSAFE_IN_PROCESS_STORY_BASELINE;
  process.env.NODE_ENV = "production";
  delete process.env.DEVBENCH_ALLOW_UNSAFE_IN_PROCESS_STORY_BASELINE;
  try {
    assert.throws(
      () => StoryBaselineService.prototype.assertStoryRepositoryMutationBoundary.call({}),
      (error) => (
        error.code === "STORY_BASELINE_RESTRICTED_EXECUTOR_REQUIRED"
        && error.details?.controllerPathGitForbidden === true
      ),
    );
  } finally {
    if (previous == null) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previous;
    if (previousUnsafe == null) {
      delete process.env.DEVBENCH_ALLOW_UNSAFE_IN_PROCESS_STORY_BASELINE;
    } else {
      process.env.DEVBENCH_ALLOW_UNSAFE_IN_PROCESS_STORY_BASELINE = previousUnsafe;
    }
  }
});

async function createStory(fixture, storyId = `story-${fixture.label}`) {
  const accepted = await acceptRemote(fixture);
  const repository = await createIndependentStoryRepository({
    root: fixture.storyRoot,
    storyId,
    accepted,
    branch: `story/${fixture.label}`,
  });
  return {
    storyId,
    accepted,
    repository: {
      ...repository,
      repositoryMode: INDEPENDENT_REPOSITORY_MODE,
    },
  };
}

async function previewNext(
  fixture,
  story,
  accepted,
  strategy = STORY_BASELINE_STRATEGY,
) {
  return fixture.service.preview({
    tabId: story.storyId,
    repository: story.repository,
    accepted,
    strategy,
  });
}

async function executePreview(fixture, story, accepted, preview, idempotencyKey = randomUUID()) {
  return fixture.service.execute({
    tabId: story.storyId,
    repository: story.repository,
    accepted,
    strategy: preview.strategy,
    previewId: preview.previewId,
    previewVersion: preview.previewVersion,
    expectedHead: preview.expectedHead,
    candidateSha: preview.candidateSha,
    mirrorGeneration: preview.mirrorGeneration,
    idempotencyKey,
  });
}

test("independent story baseline fetches only Controller accepted ref and applies exact-SHA FF", async () => {
  const fixture = await createControllerFixture("exact-ff");
  const story = await createStory(fixture);
  const originalBaseHead = git(["rev-parse", "HEAD"], fixture.base);
  const candidate = advanceRemote(fixture, "forward.txt");
  const accepted = await acceptRemote(fixture);
  assert.equal(accepted.candidateSha, candidate);

  const preview = await previewNext(fixture, story, accepted);
  assert.equal(preview.expectedHead, fixture.initialSha);
  assert.equal(preview.expectedBaseRevision, fixture.initialSha);
  assert.equal(preview.candidateSha, candidate);
  assert.equal(preview.mirrorGeneration, 2);
  assert.equal(preview.relationship, "FAST_FORWARD");
  assert.equal(preview.eligible, true);
  assert.equal(preview.checks.clean, true);

  const idempotencyKey = randomUUID();
  const result = await executePreview(fixture, story, accepted, preview, idempotencyKey);
  assert.equal(result.ok, true);
  assert.equal(result.beforeHead, fixture.initialSha);
  assert.equal(result.head, candidate);
  assert.equal(result.baseRevision, candidate);
  assert.equal(result.entryPatch.baseRevision, candidate);
  assert.equal(result.entryPatch.mirrorGeneration, 2);
  assert.equal(git(["rev-parse", "HEAD"], story.repository.repositoryPath), candidate);
  assert.equal(
    git(["rev-parse", "refs/devbench/story-base"], story.repository.repositoryPath),
    candidate,
  );
  assert.equal(
    git(["config", "--local", "--get", "devbench.base-revision"], story.repository.repositoryPath),
    candidate,
  );
  assert.equal(
    git(["config", "--local", "--get", "devbench.source-ref"], story.repository.repositoryPath),
    "refs/heads/main",
  );
  assert.equal(
    git(["config", "--local", "--get", "devbench.mirror-generation"], story.repository.repositoryPath),
    "2",
  );
  assert.equal(git(["status", "--porcelain"], story.repository.repositoryPath), "");
  assert.equal(git(["rev-parse", "HEAD"], fixture.base), originalBaseHead);
  assert.equal(
    git([
      "--git-dir",
      fixture.entry.mirrorPath,
      "rev-parse",
      controllerAcceptedRef("origin", "main"),
    ]),
    candidate,
  );
  assert.equal(
    git([
      "-C",
      story.repository.repositoryPath,
      "for-each-ref",
      "--format=%(refname)",
      "refs/devbench/incoming",
    ]),
    "",
  );

  const storyCommands = fixture.commandLog.filter((item) => (
    String(item.commandId || "").startsWith("story.baseline.")
  ));
  const fetch = storyCommands.find((item) => item.commandId === "story.baseline.fetch-accepted");
  assert.ok(fetch);
  assert.ok(fetch.args.includes("--no-write-fetch-head"));
  assert.ok(fetch.args.some((arg) => (
    arg.startsWith(`${controllerAcceptedRef("origin", "main")}:refs/devbench/incoming/i-`)
  )));
  assert.deepEqual(
    storyCommands.find((item) => item.commandId === "story.baseline.merge-fast-forward")
      .args.slice(-3),
    ["merge", "--ff-only", candidate],
  );
  assert.equal(storyCommands.some((item) => (
    item.args.includes("stash")
    || item.args.includes("reset")
    || item.args.includes("checkout")
  )), false);

  const journal = persistence.listGitControllerJournal(result.operationId);
  assert.deepEqual(journal.map((item) => item.phase), ["PREVIEWED", "VERIFIED"]);
  assert.equal(
    persistence.listGitControllerAudit({ operationId: result.operationId }).length,
    1,
  );
  const replay = await executePreview(
    fixture,
    story,
    accepted,
    preview,
    idempotencyKey,
  );
  assert.equal(replay.operationId, result.operationId);
  assert.equal(replay.replayed, true);
});

test("preview persists clean state and blocks tracked, untracked and in-progress repositories", async () => {
  const fixture = await createControllerFixture("preflight");
  const story = await createStory(fixture);
  advanceRemote(fixture, "forward.txt");
  const accepted = await acceptRemote(fixture);
  const repositoryPath = story.repository.repositoryPath;

  fs.appendFileSync(path.join(repositoryPath, "README.md"), "dirty\n");
  let preview = await previewNext(fixture, story, accepted);
  assert.equal(preview.eligible, false);
  assert.equal(preview.blockerCode, "STORY_BASELINE_BLOCKED_DIRTY");
  assert.equal(preview.checks.clean, false);
  assert.equal(preview.checks.trackedChangeCount, 1);
  git(["restore", "README.md"], repositoryPath);

  fs.writeFileSync(path.join(repositoryPath, "untracked.txt"), "untracked\n");
  preview = await previewNext(fixture, story, accepted);
  assert.equal(preview.eligible, false);
  assert.equal(preview.blockerCode, "STORY_BASELINE_BLOCKED_UNTRACKED");
  assert.equal(preview.checks.untrackedChangeCount, 1);
  fs.unlinkSync(path.join(repositoryPath, "untracked.txt"));

  const mergeHead = git([
    "rev-parse",
    "--path-format=absolute",
    "--git-path",
    "MERGE_HEAD",
  ], repositoryPath);
  fs.writeFileSync(mergeHead, `${fixture.initialSha}\n`);
  preview = await previewNext(fixture, story, accepted);
  assert.equal(preview.eligible, false);
  assert.equal(preview.blockerCode, "STORY_BASELINE_BLOCKED_OPERATION_IN_PROGRESS");
  assert.deepEqual(preview.checks.inProgress, ["MERGE_HEAD"]);
  fs.unlinkSync(mergeHead);
});

test("execute rechecks clean state and does not move story, base or mirror after stale preflight", async () => {
  const fixture = await createControllerFixture("stale-clean");
  const story = await createStory(fixture);
  const candidate = advanceRemote(fixture, "forward.txt");
  const accepted = await acceptRemote(fixture);
  const preview = await previewNext(fixture, story, accepted);
  const repositoryPath = story.repository.repositoryPath;
  const originalMirror = git([
    "--git-dir",
    fixture.entry.mirrorPath,
    "rev-parse",
    controllerAcceptedRef("origin", "main"),
  ]);
  const originalBase = git(["rev-parse", "HEAD"], fixture.base);

  fs.writeFileSync(path.join(repositoryPath, "late-untracked.txt"), "late\n");
  await assert.rejects(
    executePreview(fixture, story, accepted, preview),
    (error) => error.code === "STORY_BASELINE_BLOCKED_UNTRACKED",
  );
  assert.equal(git(["rev-parse", "HEAD"], repositoryPath), fixture.initialSha);
  assert.equal(git(["rev-parse", "refs/devbench/story-base"], repositoryPath), fixture.initialSha);
  assert.equal(git(["rev-parse", "HEAD"], fixture.base), originalBase);
  assert.equal(
    git([
      "--git-dir",
      fixture.entry.mirrorPath,
      "rev-parse",
      controllerAcceptedRef("origin", "main"),
    ]),
    originalMirror,
  );
  assert.equal(originalMirror, candidate);
});

test("diverged story commits are rejected without rebase, reset or overwrite", async () => {
  const fixture = await createControllerFixture("diverged");
  const story = await createStory(fixture);
  const repositoryPath = story.repository.repositoryPath;
  git(["config", "user.name", "Story Baseline Test"], repositoryPath);
  git(["config", "user.email", "story-baseline@example.test"], repositoryPath);
  fs.writeFileSync(path.join(repositoryPath, "story-only.txt"), "story\n");
  git(["add", "story-only.txt"], repositoryPath);
  git(["commit", "-m", "story work"], repositoryPath);
  const storyHead = git(["rev-parse", "HEAD"], repositoryPath);
  advanceRemote(fixture, "remote-only.txt");
  const accepted = await acceptRemote(fixture);

  const preview = await previewNext(fixture, story, accepted);
  assert.equal(preview.relationship, "STORY_DIVERGED");
  assert.equal(preview.eligible, false);
  assert.equal(preview.blockerCode, "STORY_BASELINE_BLOCKED_DIVERGED");
  await assert.rejects(
    executePreview(fixture, story, accepted, preview),
    (error) => error.code === "STORY_BASELINE_BLOCKED_DIVERGED",
  );
  assert.equal(git(["rev-parse", "HEAD"], repositoryPath), storyHead);
  assert.equal(git(["rev-parse", "refs/devbench/story-base"], repositoryPath), fixture.initialSha);
});

test("explicit lowercase merge integrates a diverged exact candidate only inside the story repository", async () => {
  const fixture = await createControllerFixture("merge-success");
  const story = await createStory(fixture);
  const repositoryPath = story.repository.repositoryPath;
  git(["config", "user.name", "Story Baseline Test"], repositoryPath);
  git(["config", "user.email", "story-baseline@example.test"], repositoryPath);
  fs.writeFileSync(path.join(repositoryPath, "story-only.txt"), "story\n");
  git(["add", "story-only.txt"], repositoryPath);
  git(["commit", "-m", "story work"], repositoryPath);
  const beforeHead = git(["rev-parse", "HEAD"], repositoryPath);
  const hookMarker = path.join(fixture.fixtureRoot, "worker-hook-executed.txt");
  const postMergeHook = path.join(repositoryPath, ".git", "hooks", "post-merge");
  fs.mkdirSync(path.dirname(postMergeHook), { recursive: true });
  fs.writeFileSync(
    postMergeHook,
    `#!/bin/sh\nprintf compromised > "${hookMarker.replace(/\\/g, "/")}"\n`,
  );
  fs.chmodSync(postMergeHook, 0o755);
  const baseHead = git(["rev-parse", "HEAD"], fixture.base);
  const candidate = advanceRemote(fixture, "remote-only.txt");
  const accepted = await acceptRemote(fixture);

  const preview = await previewNext(fixture, story, accepted, "merge");
  assert.equal(preview.strategy, "MERGE");
  assert.equal(preview.relationship, "STORY_DIVERGED");
  assert.equal(preview.eligible, true);
  const result = await executePreview(fixture, story, accepted, preview);
  assert.equal(result.relationship, "STORY_DIVERGED");
  assert.notEqual(result.head, beforeHead);
  assert.notEqual(result.head, candidate);
  assert.equal(
    git(["merge-base", "--is-ancestor", beforeHead, result.head], repositoryPath),
    "",
  );
  assert.equal(
    git(["merge-base", "--is-ancestor", candidate, result.head], repositoryPath),
    "",
  );
  const parents = git(["show", "-s", "--format=%P", result.head], repositoryPath)
    .split(/\s+/);
  assert.deepEqual(new Set(parents), new Set([beforeHead, candidate]));
  assert.equal(git(["rev-parse", "refs/devbench/story-base"], repositoryPath), candidate);
  assert.equal(
    git(["config", "--local", "--get", "devbench.base-revision"], repositoryPath),
    candidate,
  );
  assert.equal(git(["status", "--porcelain"], repositoryPath), "");
  assert.equal(fs.existsSync(hookMarker), false);
  assert.equal(git(["rev-parse", "HEAD"], fixture.base), baseHead);
  assert.equal(
    git([
      "--git-dir",
      fixture.entry.mirrorPath,
      "rev-parse",
      controllerAcceptedRef("origin", "main"),
    ]),
    candidate,
  );
  const mergeCommand = fixture.commandLog.find(
    (item) => item.commandId === "story.baseline.merge-explicit",
  );
  assert.deepEqual(
    mergeCommand.args.slice(-3),
    ["merge", "--no-edit", candidate],
  );
  assert.equal(fixture.commandLog.some((item) => (
    item.commandId?.startsWith("story.baseline.")
    && (
      item.args.includes("stash")
      || item.args.includes("reset")
      || item.args.includes("checkout")
    )
  )), false);
});

test("explicit merge conflict remains recoverable in the story repository without touching base or mirror", async () => {
  const fixture = await createControllerFixture("merge-conflict");
  const story = await createStory(fixture);
  const repositoryPath = story.repository.repositoryPath;
  git(["config", "user.name", "Story Baseline Test"], repositoryPath);
  git(["config", "user.email", "story-baseline@example.test"], repositoryPath);
  fs.writeFileSync(path.join(repositoryPath, "README.md"), "story-side\n");
  git(["add", "README.md"], repositoryPath);
  git(["commit", "-m", "story side"], repositoryPath);
  const storyHead = git(["rev-parse", "HEAD"], repositoryPath);
  const baseHead = git(["rev-parse", "HEAD"], fixture.base);
  fs.writeFileSync(path.join(fixture.seed, "README.md"), "remote-side\n");
  git(["add", "README.md"], fixture.seed);
  git(["commit", "-m", "remote side"], fixture.seed);
  git(["push", "origin", "main"], fixture.seed);
  const candidate = git(["rev-parse", "HEAD"], fixture.seed);
  const accepted = await acceptRemote(fixture);

  const preview = await previewNext(fixture, story, accepted, "MeRgE");
  assert.equal(preview.strategy, "MERGE");
  assert.equal(preview.relationship, "STORY_DIVERGED");
  assert.equal(preview.eligible, true);
  const idempotencyKey = randomUUID();
  await assert.rejects(
    executePreview(fixture, story, accepted, preview, idempotencyKey),
    (error) => (
      error.code === "STORY_BASELINE_MERGE_CONFLICT"
      && error.details?.conflictCount === 1
    ),
  );
  assert.equal(git(["rev-parse", "HEAD"], repositoryPath), storyHead);
  assert.equal(git(["rev-parse", "refs/devbench/story-base"], repositoryPath), fixture.initialSha);
  assert.equal(
    git(["config", "--local", "--get", "devbench.base-revision"], repositoryPath),
    fixture.initialSha,
  );
  assert.match(git(["status", "--porcelain"], repositoryPath), /^UU README\.md$/m);
  assert.equal(git(["rev-parse", "--verify", "MERGE_HEAD"], repositoryPath), candidate);
  assert.equal(git(["rev-parse", "HEAD"], fixture.base), baseHead);
  assert.equal(
    git([
      "--git-dir",
      fixture.entry.mirrorPath,
      "rev-parse",
      controllerAcceptedRef("origin", "main"),
    ]),
    candidate,
  );
  const operation = persistence.getGitControllerOperationByIdempotency(
    fixture.entry.repositoryId,
    "STORY_BASELINE_SYNC",
    idempotencyKey,
  );
  assert.equal(operation.status, "RECOVERY_REQUIRED");
  assert.equal(operation.resultCode, "STORY_BASELINE_MERGE_CONFLICT");
  assert.equal(
    persistence.listGitControllerAudit({ operationId: operation.operationId })[0].result,
    "RECOVERY_REQUIRED",
  );
});

test("execute rejects an accepted generation changed after preview", async () => {
  const fixture = await createControllerFixture("accepted-stale");
  const story = await createStory(fixture);
  const candidateB = advanceRemote(fixture, "b.txt");
  const acceptedB = await acceptRemote(fixture);
  assert.equal(acceptedB.candidateSha, candidateB);
  const preview = await previewNext(fixture, story, acceptedB);

  const candidateC = advanceRemote(fixture, "c.txt");
  const acceptedC = await acceptRemote(fixture);
  assert.equal(acceptedC.candidateSha, candidateC);
  await assert.rejects(
    executePreview(fixture, story, acceptedB, preview),
    (error) => error.code === "GIT_CONTROLLER_PREVIEW_STALE",
  );
  assert.equal(
    git(["rev-parse", "HEAD"], story.repository.repositoryPath),
    fixture.initialSha,
  );
  assert.equal(
    git(["rev-parse", "refs/devbench/story-base"], story.repository.repositoryPath),
    fixture.initialSha,
  );
  assert.equal(
    git([
      "--git-dir",
      fixture.entry.mirrorPath,
      "rev-parse",
      controllerAcceptedRef("origin", "main"),
    ]),
    candidateC,
  );
});

test("story baseline rejects an accepted exact SHA with LFS/filter attributes before story mutation", async () => {
  const fixture = await createControllerFixture("candidate-attrs");
  const story = await createStory(fixture);
  const repositoryPath = story.repository.repositoryPath;
  const storyHead = git(["rev-parse", "HEAD"], repositoryPath);
  const baseHead = git(["rev-parse", "HEAD"], fixture.base);

  fs.writeFileSync(
    path.join(fixture.seed, ".gitattributes"),
    "*.bin filter=lfs diff=lfs merge=lfs -text\n",
  );
  fs.writeFileSync(path.join(fixture.seed, "payload.bin"), "lfs-pointer-like\n");
  git(["add", ".gitattributes", "payload.bin"], fixture.seed);
  git(["commit", "-m", "candidate with executable attributes"], fixture.seed);
  git(["push", "origin", "main"], fixture.seed);
  const candidate = git(["rev-parse", "HEAD"], fixture.seed);
  const accepted = await acceptRemote(fixture);
  assert.equal(accepted.candidateSha, candidate);

  await assert.rejects(
    previewNext(fixture, story, accepted),
    (error) => (
      error.code === "BASE_SYNC_BLOCKED_CANDIDATE_ATTRIBUTES"
      && error.details?.reason === "CANDIDATE_EXECUTABLE_ATTRIBUTES"
    ),
  );
  assert.equal(git(["rev-parse", "HEAD"], repositoryPath), storyHead);
  assert.equal(
    git(["rev-parse", "refs/devbench/story-base"], repositoryPath),
    fixture.initialSha,
  );
  assert.equal(git(["rev-parse", "HEAD"], fixture.base), baseHead);
  assert.equal(
    git([
      "--git-dir",
      fixture.entry.mirrorPath,
      "rev-parse",
      controllerAcceptedRef("origin", "main"),
    ]),
    candidate,
  );
});

test("legacy linked worktree and non-FF strategies fail closed", async () => {
  const fixture = await createControllerFixture("fail-closed");
  const accepted = await acceptRemote(fixture);
  await assert.rejects(
    fixture.service.preview({
      tabId: "legacy-story",
      repository: {
        repositoryMode: "LEGACY_LINKED_WORKTREE",
        repositoryId: fixture.entry.repositoryId,
        repositoryPath: fixture.base,
      },
      accepted,
    }),
    (error) => error.code === "STORY_BASELINE_INDEPENDENT_REPOSITORY_REQUIRED",
  );
  const story = await createStory(fixture, "strategy-story");
  await assert.rejects(
    fixture.service.preview({
      tabId: story.storyId,
      repository: story.repository,
      accepted: story.accepted,
      strategy: "REBASE",
    }),
    (error) => error.code === "STORY_BASELINE_STRATEGY_REJECTED",
  );
});
