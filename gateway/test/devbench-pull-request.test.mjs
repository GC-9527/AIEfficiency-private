import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  buildPrSourceBranch,
  ensurePrBranch,
  firstPrTargetBranch,
  inspectPullRequestEntry,
  isGeneratedStoryArchivePath,
  isPrSourceBranchInFamily,
  resolvePrVehicleSlug,
  selectPrPrimaryEntry,
  summarizePullRequestPreview,
} from "../services/devbench/pull-request.js";

const tempRoots = [];

function git(repoPath, args, timeout = 60000) {
  return new Promise((resolve) => {
    execFile("git", ["-C", repoPath, "-c", "core.quotePath=false", ...args], {
      encoding: "utf8",
      timeout,
      windowsHide: true,
      maxBuffer: 4 * 1024 * 1024,
    }, (error, stdout, stderr) => {
      if (error) {
        resolve({ ok: false, error: String(stderr || error.message).trim() });
        return;
      }
      resolve({ ok: true, stdout: String(stdout || "") });
    });
  });
}

async function mustGit(repoPath, args) {
  const result = await git(repoPath, args);
  assert.equal(result.ok, true, `${args.join(" ")} failed: ${result.error || "unknown"}`);
  return result.stdout.trim();
}

async function createRepo() {
  const repoPath = fs.mkdtempSync(path.join(os.tmpdir(), "devbench-pr-"));
  tempRoots.push(repoPath);
  await mustGit(repoPath, ["init", "-b", "main"]);
  await mustGit(repoPath, ["config", "user.name", "Devbench Test"]);
  await mustGit(repoPath, ["config", "user.email", "devbench@example.invalid"]);
  fs.writeFileSync(path.join(repoPath, "base.txt"), "base\n");
  await mustGit(repoPath, ["add", "base.txt"]);
  await mustGit(repoPath, ["commit", "-m", "base"]);
  return repoPath;
}

function readNormalized(file) {
  return fs.readFileSync(file, "utf8").replace(/\r\n/g, "\n");
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

test("PR branch uses ticket plus release-branch vehicle", () => {
  assert.equal(resolvePrVehicleSlug({
    targetBranch: "release/geely-e22",
    vehicle: "geelye22",
    flavor: "geelye22",
  }), "geely-e22");
  assert.equal(buildPrSourceBranch("carb-13542", {
    targetBranch: "release/geely-e22",
    vehicle: "geelye22",
    flavor: "geelye22",
  }), "fix/CARB-13542-geely-e22");
});

test("PR branch vehicle falls back to confirmed vehicle then primary flavor", () => {
  assert.equal(buildPrSourceBranch("CARB-2", { targetBranch: "main", vehicle: "Avatr 8678" }), "fix/CARB-2-avatr-8678");
  assert.equal(buildPrSourceBranch("CARB-3", { targetBranch: "main", flavor: "geelyp162" }), "fix/CARB-3-geelyp162");
  assert.equal(buildPrSourceBranch("CARB-4", { targetBranch: "main" }), "");
});

test("PR retry excludes both legacy and vehicle-suffixed source branches from target inference", () => {
  assert.equal(isPrSourceBranchInFamily("fix/CARB-13542", "fix/CARB-13542"), true);
  assert.equal(isPrSourceBranchInFamily("fix/CARB-13542-geely-e22", "fix/CARB-13542"), true);
  assert.equal(isPrSourceBranchInFamily("fix/CARB-13543-geely-e22", "fix/CARB-13542"), false);
  assert.equal(isPrSourceBranchInFamily("release/geely-e22", "fix/CARB-13542"), false);
  assert.equal(firstPrTargetBranch([
    "fix/CARB-13542-geely-e22",
    "release/geely-e22",
  ], "fix/CARB-13542"), "release/geely-e22");
});

test("PR primary entry honors targetRole when an AppMarket SDK dependency appears first", () => {
  const entries = [
    { projectId: "appMarketSdk", targetRole: "dependency", branch: "feat/sdk", flavor: "sdkFlavor" },
    { projectId: "customApp", targetRole: "primary", branch: "release/geely-e22", flavor: "geelye22" },
  ];
  assert.deepEqual(selectPrPrimaryEntry(entries, ["appMarket"]), entries[1]);
});

test("PR preview reports committed and local work before execution", async () => {
  const repo = await createRepo();
  const bare = fs.mkdtempSync(path.join(os.tmpdir(), "devbench-pr-preview-remote-"));
  tempRoots.push(bare);
  await mustGit(bare, ["init", "--bare"]);
  await mustGit(repo, ["remote", "add", "origin", bare]);
  await mustGit(repo, ["push", "-u", "origin", "main"]);
  await mustGit(repo, ["checkout", "-b", "story/CARB-200"]);
  fs.writeFileSync(path.join(repo, "committed.txt"), "committed change\n");
  await mustGit(repo, ["add", "committed.txt"]);
  await mustGit(repo, ["commit", "-m", "story commit"]);
  fs.writeFileSync(path.join(repo, "local.txt"), "local change\n");

  const result = await inspectPullRequestEntry({
    name: "AppMarket",
    role: "primary",
    path: repo,
    branch: "story/CARB-200",
    originalBranch: "main",
  }, { runGit: git, pathExists: fs.existsSync, fetchTarget: true });

  assert.equal(result.status, "ready");
  assert.equal(result.eligible, true);
  assert.equal(result.storyBranch, "story/CARB-200");
  assert.equal(result.originalBranch, "main");
  assert.equal(result.aheadCount, 1);
  assert.equal(result.dirtyCount, 1);
  assert.equal(result.behindCount, 0);
  assert.equal(result.targetFetched, true);
  assert.equal(result.fetchWarning, "");
  assert.deepEqual(result.commits.map((commit) => commit.subject), ["story commit"]);
});

test("PR preview marks an unchanged story branch as no_changes", async () => {
  const repo = await createRepo();
  const bare = fs.mkdtempSync(path.join(os.tmpdir(), "devbench-pr-preview-empty-remote-"));
  tempRoots.push(bare);
  await mustGit(bare, ["init", "--bare"]);
  await mustGit(repo, ["remote", "add", "origin", bare]);
  await mustGit(repo, ["checkout", "-b", "story/CARB-201"]);

  const result = await inspectPullRequestEntry({
    name: "AppMarketSdk",
    path: repo,
    branch: "story/CARB-201",
    originalBranch: "main",
  }, { runGit: git, pathExists: fs.existsSync });

  assert.equal(result.status, "no_changes");
  assert.equal(result.eligible, false);
  assert.equal(result.aheadCount, 0);
  assert.equal(result.dirtyCount, 0);
  assert.match(result.reason, /没有新增提交/);
});

test("PR preview summary separates ready, unchanged, and blocked projects", () => {
  assert.deepEqual(summarizePullRequestPreview([
    { status: "ready", eligible: true },
    { status: "ready", eligible: true },
    { status: "no_changes", eligible: false },
    { status: "blocked", eligible: false },
  ]), {
    total: 4,
    eligible: 2,
    noChanges: 1,
    blocked: 1,
  });
});

test("generated story archive matcher only accepts docs/story/*/ask files", () => {
  assert.equal(isGeneratedStoryArchivePath("docs/story/avatr8678/ask/avatr8678.txt"), true);
  assert.equal(isGeneratedStoryArchivePath("docs\\story\\demo\\ask\\demo.md"), true);
  assert.equal(isGeneratedStoryArchivePath("features/StoryDev/step1/ask_1.txt"), false);
  assert.equal(isGeneratedStoryArchivePath("src/ask/demo.txt"), false);
});

test("diverged existing PR branch is reused and current dirty changes are transferred", async () => {
  const repo = await createRepo();
  await mustGit(repo, ["checkout", "-b", "fix/CARB-13386"]);
  fs.writeFileSync(path.join(repo, "source.txt"), "source branch content\n");
  await mustGit(repo, ["add", "source.txt"]);
  await mustGit(repo, ["commit", "-m", "source commit"]);
  await mustGit(repo, ["checkout", "main"]);
  fs.writeFileSync(path.join(repo, "target.txt"), "target branch content\n");
  await mustGit(repo, ["add", "target.txt"]);
  await mustGit(repo, ["commit", "-m", "target commit"]);
  fs.writeFileSync(path.join(repo, "base.txt"), "base\nworking change\n");
  fs.writeFileSync(path.join(repo, "new-file.txt"), "untracked story change\n");

  assert.equal(await mustGit(repo, ["rev-list", "--left-right", "--count", "fix/CARB-13386...HEAD"]), "1\t1");
  const result = await ensurePrBranch(repo, "fix/CARB-13386", "main", "origin", git);

  assert.equal(result.ok, true);
  assert.equal(result.reused, true);
  assert.equal(result.diverged, true);
  assert.equal(result.transferred, true);
  assert.equal(await mustGit(repo, ["branch", "--show-current"]), "fix/CARB-13386");
  assert.equal(readNormalized(path.join(repo, "source.txt")), "source branch content\n");
  assert.equal(readNormalized(path.join(repo, "base.txt")), "base\nworking change\n");
  assert.equal(readNormalized(path.join(repo, "new-file.txt")), "untracked story change\n");
  assert.equal(await mustGit(repo, ["stash", "list"]), "");
});

test("generated story archive conflict keeps the newer worktree archive and continues", async () => {
  const repo = await createRepo();
  const archive = path.join(repo, "docs", "story", "demo", "ask", "demo.txt");
  fs.mkdirSync(path.dirname(archive), { recursive: true });
  fs.writeFileSync(archive, "conversation base\n");
  await mustGit(repo, ["add", "docs/story/demo/ask/demo.txt"]);
  await mustGit(repo, ["commit", "-m", "archive base"]);

  await mustGit(repo, ["checkout", "-b", "fix/CARB-2"]);
  fs.writeFileSync(archive, "conversation base\n---------- [2026/7/14 04:07:15] 提 PR：fix/CARB-2 → main ----------\n");
  await mustGit(repo, ["add", "docs/story/demo/ask/demo.txt"]);
  await mustGit(repo, ["commit", "-m", "old PR event"]);
  await mustGit(repo, ["checkout", "main"]);
  fs.writeFileSync(path.join(repo, "target.txt"), "target advanced\n");
  await mustGit(repo, ["add", "target.txt"]);
  await mustGit(repo, ["commit", "-m", "target advanced"]);
  fs.writeFileSync(archive, "conversation base\nlatest conversation\n");

  const result = await ensurePrBranch(repo, "fix/CARB-2", "main", "origin", git);

  assert.equal(result.ok, true, result.error);
  assert.equal(result.diverged, true);
  assert.deepEqual(result.autoResolvedArchiveConflicts, ["docs/story/demo/ask/demo.txt"]);
  assert.equal(readNormalized(archive), "conversation base\nlatest conversation\n");
  assert.equal(await mustGit(repo, ["stash", "list"]), "");
  assert.equal(await mustGit(repo, ["diff", "--name-only", "--diff-filter=U"]), "");
});

test("autocrlf-normalized untracked files are recognized as fully restored", async () => {
  const repo = await createRepo();
  await mustGit(repo, ["config", "core.autocrlf", "true"]);
  const archive = path.join(repo, "docs", "story", "demo", "ask", "demo.txt");
  const untrackedRel = "sample/app/src/Rule.kt";
  const untracked = path.join(repo, ...untrackedRel.split("/"));
  fs.mkdirSync(path.dirname(archive), { recursive: true });
  fs.writeFileSync(archive, "conversation base\n");
  await mustGit(repo, ["add", "docs/story/demo/ask/demo.txt"]);
  await mustGit(repo, ["commit", "-m", "archive base"]);

  await mustGit(repo, ["checkout", "-b", "fix/CARB-8"]);
  fs.writeFileSync(archive, "conversation base\n---------- [2026/7/14 21:05:00] 提 PR：fix/CARB-8 → main ----------\n");
  await mustGit(repo, ["add", "docs/story/demo/ask/demo.txt"]);
  await mustGit(repo, ["commit", "-m", "old generated PR event"]);
  await mustGit(repo, ["checkout", "main"]);
  fs.writeFileSync(path.join(repo, "target.txt"), "target advanced\n");
  await mustGit(repo, ["add", "target.txt"]);
  await mustGit(repo, ["commit", "-m", "target advanced"]);
  fs.writeFileSync(archive, "conversation base\nlatest conversation\n");
  fs.mkdirSync(path.dirname(untracked), { recursive: true });
  fs.writeFileSync(untracked, "first line\nsecond line\n");

  const expectedBlob = await mustGit(repo, ["hash-object", `--path=${untrackedRel}`, "--", untrackedRel]);
  const result = await ensurePrBranch(repo, "fix/CARB-8", "main", "origin", git);

  assert.equal(result.ok, true, result.error);
  assert.deepEqual(result.autoResolvedArchiveConflicts, ["docs/story/demo/ask/demo.txt"]);
  assert.equal(await mustGit(repo, ["stash", "list"]), "");
  assert.equal(await mustGit(repo, ["hash-object", `--path=${untrackedRel}`, "--", untrackedRel]), expectedBlob);
  assert.notEqual(await mustGit(repo, ["hash-object", "--no-filters", "--", untrackedRel]), expectedBlob);
  assert.equal(readNormalized(untracked), "first line\nsecond line\n");
});

test("real code conflict stops safely on the reused branch and preserves the stash", async () => {
  const repo = await createRepo();
  const codeFile = path.join(repo, "code.txt");
  fs.writeFileSync(codeFile, "value=base\n");
  await mustGit(repo, ["add", "code.txt"]);
  await mustGit(repo, ["commit", "-m", "code base"]);

  await mustGit(repo, ["checkout", "-b", "fix/CARB-3"]);
  fs.writeFileSync(codeFile, "value=source\n");
  await mustGit(repo, ["add", "code.txt"]);
  await mustGit(repo, ["commit", "-m", "source code"]);
  await mustGit(repo, ["checkout", "main"]);
  fs.writeFileSync(path.join(repo, "target.txt"), "target advanced\n");
  await mustGit(repo, ["add", "target.txt"]);
  await mustGit(repo, ["commit", "-m", "target advanced"]);
  fs.writeFileSync(codeFile, "value=working\n");

  const result = await ensurePrBranch(repo, "fix/CARB-3", "main", "origin", git);

  assert.equal(result.ok, false);
  assert.equal(result.reused, true);
  assert.equal(result.diverged, true);
  assert.equal(result.transferConflict, true);
  assert.equal(result.stashPreserved, true);
  assert.deepEqual(result.conflictFiles, ["code.txt"]);
  assert.equal(await mustGit(repo, ["branch", "--show-current"]), "fix/CARB-3");
  assert.match(await mustGit(repo, ["stash", "list"]), /devbench-pr/);
  assert.equal(await mustGit(repo, ["diff", "--name-only", "--diff-filter=U"]), "code.txt");
});

test("mixed archive and untracked collisions never drop the only stashed copy", async () => {
  const repo = await createRepo();
  const archive = path.join(repo, "docs", "story", "demo", "ask", "demo.txt");
  fs.mkdirSync(path.dirname(archive), { recursive: true });
  fs.writeFileSync(archive, "conversation base\n");
  await mustGit(repo, ["add", "docs/story/demo/ask/demo.txt"]);
  await mustGit(repo, ["commit", "-m", "archive base"]);

  await mustGit(repo, ["checkout", "-b", "fix/CARB-4"]);
  fs.writeFileSync(archive, "conversation base\n---------- [2026/7/14 04:07:15] 提 PR：fix/CARB-4 → main ----------\n");
  fs.writeFileSync(path.join(repo, "collision.txt"), "source branch tracked content\n");
  await mustGit(repo, ["add", "docs/story/demo/ask/demo.txt", "collision.txt"]);
  await mustGit(repo, ["commit", "-m", "source branch content"]);

  await mustGit(repo, ["checkout", "main"]);
  fs.writeFileSync(path.join(repo, "target.txt"), "target advanced\n");
  await mustGit(repo, ["add", "target.txt"]);
  await mustGit(repo, ["commit", "-m", "target advanced"]);
  fs.writeFileSync(archive, "conversation base\nlatest conversation\n");
  fs.writeFileSync(path.join(repo, "collision.txt"), "user untracked content\n");

  const result = await ensurePrBranch(repo, "fix/CARB-4", "main", "origin", git);

  assert.equal(result.ok, false);
  assert.equal(result.transferConflict, true);
  assert.equal(result.stashPreserved, true);
  assert.deepEqual(result.conflictFiles.sort(), ["collision.txt", "docs/story/demo/ask/demo.txt"]);
  assert.match(await mustGit(repo, ["stash", "list"]), /devbench-pr/);
  assert.equal(readNormalized(path.join(repo, "collision.txt")), "user untracked content\n");
  assert.equal(await mustGit(repo, ["show", "HEAD:collision.txt"]), "source branch tracked content");
  assert.equal(await mustGit(repo, ["show", "stash@{0}^3:collision.txt"]), "user untracked content");
});

test("server-only existing branch is discovered, fetched, and reused", async () => {
  const repo = await createRepo();
  const bare = fs.mkdtempSync(path.join(os.tmpdir(), "devbench-pr-remote-"));
  tempRoots.push(bare);
  await mustGit(bare, ["init", "--bare"]);
  await mustGit(repo, ["remote", "add", "origin", bare]);
  await mustGit(repo, ["checkout", "-b", "fix/CARB-5"]);
  fs.writeFileSync(path.join(repo, "remote-only.txt"), "remote branch content\n");
  await mustGit(repo, ["add", "remote-only.txt"]);
  await mustGit(repo, ["commit", "-m", "remote branch commit"]);
  await mustGit(repo, ["push", "origin", "fix/CARB-5"]);
  await mustGit(repo, ["checkout", "main"]);
  await mustGit(repo, ["branch", "-D", "fix/CARB-5"]);
  await mustGit(repo, ["update-ref", "-d", "refs/remotes/origin/fix/CARB-5"]);
  fs.writeFileSync(path.join(repo, "base.txt"), "base\nlocal working change\n");

  assert.equal((await git(repo, ["rev-parse", "--verify", "--quiet", "refs/heads/fix/CARB-5"])).ok, false);
  assert.equal((await git(repo, ["rev-parse", "--verify", "--quiet", "refs/remotes/origin/fix/CARB-5"])).ok, false);
  const result = await ensurePrBranch(repo, "fix/CARB-5", "main", "origin", git);

  assert.equal(result.ok, true, result.error);
  assert.equal(result.reused, true);
  assert.equal(result.reusedRemote, true);
  assert.equal(result.transferred, true);
  assert.equal(await mustGit(repo, ["branch", "--show-current"]), "fix/CARB-5");
  assert.equal(readNormalized(path.join(repo, "remote-only.txt")), "remote branch content\n");
  assert.equal(readNormalized(path.join(repo, "base.txt")), "base\nlocal working change\n");
  assert.equal(await mustGit(repo, ["stash", "list"]), "");
});

test("archive conflicts with real source content are never auto-discarded", async () => {
  const repo = await createRepo();
  const archive = path.join(repo, "docs", "story", "demo", "ask", "demo.txt");
  fs.mkdirSync(path.dirname(archive), { recursive: true });
  fs.writeFileSync(archive, "conversation base\n");
  await mustGit(repo, ["add", "docs/story/demo/ask/demo.txt"]);
  await mustGit(repo, ["commit", "-m", "archive base"]);

  await mustGit(repo, ["checkout", "-b", "fix/CARB-6"]);
  fs.writeFileSync(archive, "conversation base\nimportant source conversation\n");
  await mustGit(repo, ["add", "docs/story/demo/ask/demo.txt"]);
  await mustGit(repo, ["commit", "-m", "important source archive"]);
  await mustGit(repo, ["checkout", "main"]);
  fs.writeFileSync(path.join(repo, "target.txt"), "target advanced\n");
  await mustGit(repo, ["add", "target.txt"]);
  await mustGit(repo, ["commit", "-m", "target advanced"]);
  fs.writeFileSync(archive, "conversation base\nlatest worktree conversation\n");

  const result = await ensurePrBranch(repo, "fix/CARB-6", "main", "origin", git);

  assert.equal(result.ok, false);
  assert.equal(result.transferConflict, true);
  assert.equal(result.stashPreserved, true);
  assert.deepEqual(result.conflictFiles, ["docs/story/demo/ask/demo.txt"]);
  assert.match(result.error, /非自动“提 PR”记录/);
  assert.match(await mustGit(repo, ["stash", "list"]), /devbench-pr/);
  assert.equal(await mustGit(repo, ["show", "stash@{0}:docs/story/demo/ask/demo.txt"]), "conversation base\nlatest worktree conversation");
});

test("conversation text mentioning a PR branch is not mistaken for a generated event", async () => {
  const repo = await createRepo();
  const archive = path.join(repo, "docs", "story", "demo", "ask", "demo.txt");
  fs.mkdirSync(path.dirname(archive), { recursive: true });
  fs.writeFileSync(archive, "conversation base\n");
  await mustGit(repo, ["add", "docs/story/demo/ask/demo.txt"]);
  await mustGit(repo, ["commit", "-m", "archive base"]);

  await mustGit(repo, ["checkout", "-b", "fix/CARB-7"]);
  fs.writeFileSync(archive, "conversation base\nreal conversation: do not 提 PR：fix/CARB-7 yet\n");
  await mustGit(repo, ["add", "docs/story/demo/ask/demo.txt"]);
  await mustGit(repo, ["commit", "-m", "conversation mentioning PR"]);
  await mustGit(repo, ["checkout", "main"]);
  fs.writeFileSync(path.join(repo, "target.txt"), "target advanced\n");
  await mustGit(repo, ["add", "target.txt"]);
  await mustGit(repo, ["commit", "-m", "target advanced"]);
  fs.writeFileSync(archive, "conversation base\nlatest worktree conversation\n");

  const result = await ensurePrBranch(repo, "fix/CARB-7", "main", "origin", git);

  assert.equal(result.ok, false);
  assert.equal(result.stashPreserved, true);
  assert.deepEqual(result.conflictFiles, ["docs/story/demo/ask/demo.txt"]);
  assert.match(result.error, /非自动“提 PR”记录/);
  assert.match(await mustGit(repo, ["stash", "list"]), /devbench-pr/);
  assert.equal(await mustGit(repo, ["show", "HEAD:docs/story/demo/ask/demo.txt"]), "conversation base\nreal conversation: do not 提 PR：fix/CARB-7 yet");
});
