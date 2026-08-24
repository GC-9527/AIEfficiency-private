import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

// 复现 CARB-14180 Git 提交整理的“新分支包含 merge commit，禁止”误判：
// 检查点用 `rev-list --merges HEAD` 会把 target 基线历史里已有的 release merge 也计入，
// 导致 squash 后的单 commit 整理结果被误判。正确范围是 `${targetSha}..HEAD`（仅增量）。

function git(repo, args, opts = {}) {
  return execFileSync("git", ["-C", repo, ...args], {
    encoding: "utf8",
    windowsHide: true,
    ...opts,
  }).trim();
}

test("rework merge 校验只看增量：基线含 merge 时 HEAD 全历史会误判", () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "devbench-rework-merge-"));
  try {
    git(repo, ["init", "--quiet"]);
    git(repo, ["config", "user.email", "test@example.com"]);
    git(repo, ["config", "user.name", "test"]);
    git(repo, ["config", "commit.gpgsign", "false"]);

    // 基线：master 通过 --no-ff 合并 feature，产生 merge commit（模拟 release 分支历史）
    fs.writeFileSync(path.join(repo, "a.txt"), "a");
    git(repo, ["add", "a.txt"]);
    git(repo, ["commit", "-m", "base"]);
    git(repo, ["checkout", "-b", "feature"]);
    fs.writeFileSync(path.join(repo, "b.txt"), "b");
    git(repo, ["add", "b.txt"]);
    git(repo, ["commit", "-m", "feature work"]);
    git(repo, ["checkout", "master"]);
    git(repo, ["merge", "--no-ff", "feature", "-m", "merge feature into baseline"]);
    const targetSha = git(repo, ["rev-parse", "HEAD"]); // 含 merge commit 的基线

    // 模拟 rework 结果：在基线上 squash 一个改动并提交（单 commit，父 = target）
    git(repo, ["checkout", "-b", "rework", targetSha]);
    fs.writeFileSync(path.join(repo, "c.txt"), "c");
    git(repo, ["add", "c.txt"]);
    git(repo, ["commit", "-m", "squashed single commit"]);
    const head = git(repo, ["rev-parse", "HEAD"]);

    // 修复前（旧检查）：HEAD 全历史 → 祖先链里有 merge commit → 误判
    const before = git(repo, ["rev-list", "--merges", "-n", "1", "HEAD"]);
    assert.ok(before, "基线含 merge 时旧检查必然误判（HEAD 全历史非空）");

    // 修复后（增量范围）：targetSha..HEAD 无 merge
    const after = git(repo, ["rev-list", "--merges", "-n", "1", `${targetSha}..HEAD`]);
    assert.equal(after, "", "增量范围 targetSha..HEAD 应无 merge commit");

    // 增量 commit 数仍为 1（单 commit 整理结果不变）
    assert.equal(git(repo, ["rev-list", "--count", `${targetSha}..HEAD`]), "1");
    assert.equal(git(repo, ["rev-parse", "HEAD^"]), targetSha);
    void head;
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("rework merge 校验不误放行：新分支真的包含 merge commit 时增量检查仍能抓到", () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "devbench-rework-merge-neg-"));
  try {
    git(repo, ["init", "--quiet"]);
    git(repo, ["config", "user.email", "test@example.com"]);
    git(repo, ["config", "user.name", "test"]);
    git(repo, ["config", "commit.gpgsign", "false"]);

    // 纯线性基线（无 merge，避免基线干扰）
    fs.writeFileSync(path.join(repo, "a.txt"), "a");
    git(repo, ["add", "a.txt"]);
    git(repo, ["commit", "-m", "base"]);
    const targetSha = git(repo, ["rev-parse", "HEAD"]);

    // 新分支真实带 merge：从基线分叉出 branch-a / branch-b，再 --no-ff 合并
    git(repo, ["checkout", "-b", "branch-a", targetSha]);
    fs.writeFileSync(path.join(repo, "x.txt"), "x");
    git(repo, ["add", "x.txt"]);
    git(repo, ["commit", "-m", "a work"]);
    git(repo, ["checkout", "-b", "branch-b", targetSha]);
    fs.writeFileSync(path.join(repo, "y.txt"), "y");
    git(repo, ["add", "y.txt"]);
    git(repo, ["commit", "-m", "b work"]);
    git(repo, ["checkout", "branch-a"]);
    git(repo, ["merge", "--no-ff", "branch-b", "-m", "real merge in new branch"]);

    // 增量范围必须仍能抓到该 merge commit（修复不得放宽到放行真实 merge）
    const merges = git(repo, ["rev-list", "--merges", "-n", "1", `${targetSha}..HEAD`]);
    assert.ok(merges, "新分支真实包含 merge commit 时增量检查必须非空（禁止）");
    // 全历史检查同样抓到（一致性）
    assert.ok(git(repo, ["rev-list", "--merges", "-n", "1", "HEAD"]));
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("routes/devbench.js 的 merge commit 检查必须限定增量范围（源码契约）", () => {
  const source = fs.readFileSync(
    new URL("../routes/devbench.js", import.meta.url),
    "utf8",
  );
  // 检查点必须使用 targetSha..HEAD 增量，禁止裸 HEAD 全历史
  assert.match(
    source,
    /rev-list[\s\S]{0,200}--merges[\s\S]{0,200}\$\{targetSha\}\.\.HEAD/,
    "merge commit 检查必须用 `${targetSha}..HEAD` 增量范围",
  );
  assert.doesNotMatch(
    source,
    /rev-list[\s\S]{0,80}--merges[\s\S]{0,60}"HEAD"[\s\S]{0,40}mergeCommit/,
    "禁止把 merge 检查限定在 HEAD 全历史（会误判基线自带 merge）",
  );
});
