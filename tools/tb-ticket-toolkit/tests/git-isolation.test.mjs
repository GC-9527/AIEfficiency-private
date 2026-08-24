import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, test } from "node:test";

import { prepareGitIsolation } from "../packages/tb-application/src/git-isolation.js";
import { createTempGitRepo, removeTree } from "./helpers.mjs";

const cleanup = [];
afterEach(() => {
  for (const target of cleanup.splice(0)) removeTree(target);
});

test("普通仓库从任意子目录解析 Git 根，精确 exclude 幂等且 temp 不进入 status", () => {
  const root = createTempGitRepo();
  cleanup.push(root);
  const nested = path.join(root, "a", "b");
  fs.mkdirSync(nested, { recursive: true });

  const first = prepareGitIsolation({ repoPath: nested, taskNo: "CARB-15125" });
  const second = prepareGitIsolation({ repoPath: nested, taskNo: "CARB-15125" });
  fs.writeFileSync(path.join(first.tempDirectory, "evidence.log"), "fixture", "utf8");

  assert.equal(first.gitRoot, fs.realpathSync(root));
  assert.equal(first.relativeDirectory, "temp/CARB-15125");
  assert.equal(first.ignoreRule, "/temp/CARB-15125/");
  assert.equal(first.verified, true);
  assert.equal(second.excludeFile, first.excludeFile);
  const exclude = fs.readFileSync(first.excludeFile, "utf8");
  assert.equal(exclude.split("\n").filter((line) => line === first.ignoreRule).length, 1);
  assert.match(execFileSync("git", ["-C", root, "check-ignore", "-v", "temp/CARB-15125/evidence.log"], { encoding: "utf8" }), /info\/exclude|info\\exclude/);
  assert.equal(execFileSync("git", ["-C", root, "status", "--porcelain", "--untracked-files=all"], { encoding: "utf8" }), "");
});

test("Git worktree 使用 rev-parse --git-path 解析自己的 info/exclude", () => {
  const main = createTempGitRepo("tb-toolkit-main-");
  const holder = fs.mkdtempSync(path.join(path.dirname(main), "tb-toolkit-worktree-holder-"));
  const worktree = path.join(holder, "worktree");
  cleanup.push(main, holder);
  execFileSync("git", ["-C", main, "worktree", "add", "--quiet", "--detach", worktree]);

  const result = prepareGitIsolation({ repoPath: worktree, taskNo: "CARB-15126" });
  const expected = execFileSync("git", ["-C", worktree, "rev-parse", "--git-path", "info/exclude"], { encoding: "utf8" }).trim();
  assert.equal(path.resolve(result.excludeFile), path.resolve(expected));
  assert.equal(result.verified, true);
});

test("已跟踪的 temp 目标失败关闭且不覆盖、不删除", () => {
  const root = createTempGitRepo();
  cleanup.push(root);
  const target = path.join(root, "temp", "CARB-15127");
  fs.mkdirSync(target, { recursive: true });
  const tracked = path.join(target, "tracked.txt");
  fs.writeFileSync(tracked, "keep", "utf8");
  execFileSync("git", ["-C", root, "add", "--", "temp/CARB-15127/tracked.txt"]);

  assert.throws(
    () => prepareGitIsolation({ repoPath: root, taskNo: "CARB-15127" }),
    (error) => error.code === "TEMP_PATH_ALREADY_TRACKED",
  );
  assert.equal(fs.readFileSync(tracked, "utf8"), "keep");
});

test("temp 中间路径为逃逸仓库的符号链接/目录联接时阻断", (t) => {
  const root = createTempGitRepo();
  const outside = fs.mkdtempSync(path.join(path.dirname(root), "tb-toolkit-outside-"));
  cleanup.push(root, outside);
  try {
    fs.symlinkSync(outside, path.join(root, "temp"), process.platform === "win32" ? "junction" : "dir");
  } catch (error) {
    if (["EPERM", "EACCES", "ENOTSUP"].includes(error.code)) {
      t.skip(`当前环境不能创建目录链接: ${error.code}`);
      return;
    }
    throw error;
  }
  assert.throws(
    () => prepareGitIsolation({ repoPath: root, taskNo: "CARB-15128" }),
    (error) => error.code === "TEMP_PATH_ESCAPE",
  );
});
