import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";

import { repositoryGitArgs } from "../services/devbench/git-command.js";

test("repositoryGitArgs 仅为当前绝对仓库路径临时设置 safe.directory", () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "devbench-safe-git-"));
  try {
    execFileSync("git", ["init", "--quiet", repo], { windowsHide: true });
    const args = repositoryGitArgs(repo, ["status", "--porcelain"], { quotePath: true });
    const expectedPath = path.resolve(repo).replace(/\\/g, "/");

    assert.deepEqual(args.slice(0, 6), [
      "-c",
      `safe.directory=${expectedPath}`,
      "-C",
      path.resolve(repo),
      "-c",
      "core.quotePath=false",
    ]);
    assert.equal(args.includes("safe.directory=*"), false);

    const withoutSafe = spawnSync("git", ["-C", repo, "status", "--porcelain"], {
      encoding: "utf8",
      windowsHide: true,
      env: { ...process.env, GIT_TEST_ASSUME_DIFFERENT_OWNER: "1" },
    });
    assert.notEqual(withoutSafe.status, 0, "测试前提：模拟异主仓库时 Git 应拒绝访问");

    const withSafe = spawnSync("git", args, {
      encoding: "utf8",
      windowsHide: true,
      env: { ...process.env, GIT_TEST_ASSUME_DIFFERENT_OWNER: "1" },
    });
    assert.equal(withSafe.status, 0, withSafe.stderr);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});
