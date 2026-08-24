import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { restoreTrackedChanges, stashTrackedChanges } from "../services/devbench/git-update.js";

const tempRoots = [];

function git(repoPath, args, timeout = 60000) {
  return new Promise((resolve) => {
    execFile("git", ["-C", repoPath, "-c", "core.quotePath=false", ...args], {
      encoding: "utf8",
      timeout,
      windowsHide: true,
      maxBuffer: 4 * 1024 * 1024,
    }, (error, stdout, stderr) => {
      if (error) return resolve({ ok: false, error: String(stderr || error.message).trim() });
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
  const repoPath = fs.mkdtempSync(path.join(os.tmpdir(), "devbench-git-update-"));
  tempRoots.push(repoPath);
  await mustGit(repoPath, ["init", "-b", "main"]);
  await mustGit(repoPath, ["config", "user.name", "Devbench Test"]);
  await mustGit(repoPath, ["config", "user.email", "devbench@example.invalid"]);
  fs.writeFileSync(path.join(repoPath, "tracked.txt"), "base\n");
  await mustGit(repoPath, ["add", "tracked.txt"]);
  await mustGit(repoPath, ["commit", "-m", "base"]);
  return repoPath;
}

function readNormalized(filePath) {
  return fs.readFileSync(filePath, "utf8").replace(/\r\n/g, "\n");
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

test("Git Update stashes tracked changes but leaves untracked cache content in place", async () => {
  const repo = await createRepo();
  fs.writeFileSync(path.join(repo, "tracked.txt"), "staged change\n");
  await mustGit(repo, ["add", "tracked.txt"]);
  fs.mkdirSync(path.join(repo, ".pytest_cache"));
  fs.writeFileSync(path.join(repo, ".pytest_cache", "cache.bin"), "local cache\n");

  const stashed = await stashTrackedChanges(repo, "[devbench] test", git);
  assert.equal(stashed.ok, true, stashed.error);
  assert.equal(stashed.stashed, true);
  assert.equal(fs.readFileSync(path.join(repo, ".pytest_cache", "cache.bin"), "utf8"), "local cache\n");
  assert.equal(await mustGit(repo, ["status", "--porcelain", "-uno"]), "");

  const restored = await restoreTrackedChanges(repo, stashed.stashOid, git);
  assert.equal(restored.ok, true, restored.error);
  assert.equal(restored.dropped, true);
  assert.equal(await mustGit(repo, ["status", "--porcelain", "-uno"]), "M  tracked.txt");
  assert.equal(readNormalized(path.join(repo, "tracked.txt")), "staged change\n");
  assert.equal(readNormalized(path.join(repo, ".pytest_cache", "cache.bin")), "local cache\n");
  assert.equal(await mustGit(repo, ["stash", "list"]), "");
});

test("untracked-only worktree does not create or pop a stash", async () => {
  const repo = await createRepo();
  fs.writeFileSync(path.join(repo, "local-only.txt"), "keep me\n");

  const result = await stashTrackedChanges(repo, "[devbench] test", git);
  assert.deepEqual(result, { ok: true, stashed: false, trackedFiles: 0 });
  assert.equal(await mustGit(repo, ["stash", "list"]), "");
  assert.equal(readNormalized(path.join(repo, "local-only.txt")), "keep me\n");
});

test("restore drops only the exact update stash and preserves older stashes", async () => {
  const repo = await createRepo();
  fs.writeFileSync(path.join(repo, "tracked.txt"), "old stash\n");
  await mustGit(repo, ["stash", "push", "-m", "older user stash"]);
  fs.writeFileSync(path.join(repo, "tracked.txt"), "current staged change\n");
  await mustGit(repo, ["add", "tracked.txt"]);

  const stashed = await stashTrackedChanges(repo, "[devbench] current update", git);
  assert.equal(stashed.ok, true, stashed.error);
  const restored = await restoreTrackedChanges(repo, stashed.stashOid, git);

  assert.equal(restored.ok, true, restored.error);
  assert.match(await mustGit(repo, ["stash", "list"]), /older user stash/);
  assert.doesNotMatch(await mustGit(repo, ["stash", "list"]), /current update/);
  assert.equal(await mustGit(repo, ["status", "--porcelain", "-uno"]), "M  tracked.txt");
  assert.equal(readNormalized(path.join(repo, "tracked.txt")), "current staged change\n");
});
