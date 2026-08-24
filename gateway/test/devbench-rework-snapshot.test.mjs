import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

// 集成测试：不可变快照 + Worktree + merge --squash + Tree 验证 + ls-remote + 原子建分支 + 远程安全发布
// 使用临时 Git 仓库和 Bare Remote 验证真实 Git 行为

function git(repo, args, opts = {}) {
  return execFileSync("git", ["-C", repo, ...args], {
    encoding: "utf8",
    windowsHide: true,
    env: { ...process.env, DEVBENCH_SYSTEM_GIT_OP: "1" },
    ...opts,
  }).trim();
}

function gitEnv(repo, args, extraEnv = {}, opts = {}) {
  return execFileSync("git", ["-C", repo, ...args], {
    encoding: "utf8",
    windowsHide: true,
    env: { ...process.env, DEVBENCH_SYSTEM_GIT_OP: "1", ...extraEnv },
    ...opts,
  }).trim();
}

function makeRepo() {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "devbench-rework-int-"));
  git(repo, ["init", "--quiet"]);
  git(repo, ["config", "user.email", "test@example.com"]);
  git(repo, ["config", "user.name", "test"]);
  git(repo, ["config", "commit.gpgsign", "false"]);
  return repo;
}

function makeBareRemote(name = "remote") {
  const remote = fs.mkdtempSync(path.join(os.tmpdir(), `devbench-remote-${name}-`));
  git(remote, ["init", "--bare", "--quiet"]);
  return remote;
}

function commit(repo, msg) {
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "--quiet", "-m", msg]);
  return git(repo, ["rev-parse", "HEAD"]);
}

function writeFile(repo, relPath, content) {
  const full = path.join(repo, relPath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

const ZERO_SHA = "0".repeat(40);

// ========== 源码契约测试 ==========

const source = fs.readFileSync(
  new URL("../routes/devbench.js", import.meta.url),
  "utf8",
);

test("1. 不可变快照模型：内部引用 refs/ai-restructure/ 存在", () => {
  assert.match(source, /RESTRUCTURE_REF_PREFIX\s*=\s*"refs\/ai-restructure\/"/, "必须有 RESTRUCTURE_REF_PREFIX 常量");
  assert.match(source, /function genOperationId\(\)/, "必须有 genOperationId 函数");
  assert.match(source, /function createInternalRef\(/, "必须有 createInternalRef 函数");
  assert.match(source, /function atomicCreateBranch\(/, "必须有 atomicCreateBranch 函数");
  assert.match(source, /function deleteReworkInternalRefs\(/, "必须有 deleteReworkInternalRefs 函数");
  assert.match(source, /function createSourceSnapshot\(/, "必须有 createSourceSnapshot 函数");
});

test("2. Worktree --detach：不再用 -b 创建正式分支", () => {
  assert.match(source, /"worktree",\s*"add",\s*"--detach"/, "worktree add 必须用 --detach");
  assert.doesNotMatch(
    source,
    /"worktree",\s*"add",\s*"-b",\s*newBranch/,
    "禁止在 worktree add 时用 -b 创建正式分支",
  );
});

test("3. Squash 使用 SOURCE_SNAPSHOT_REF 而非分支名", () => {
  assert.match(
    source,
    /"merge",\s*"--squash",\s*sourceSnapshotRef/,
    "squash 必须使用 sourceSnapshotRef",
  );
  assert.doesNotMatch(
    source,
    /"merge",\s*"--squash",\s*cur[,\s\]]/,
    "禁止用分支名 cur 做 squash",
  );
});

test("4. Tree 验证：write-tree + HEAD^{tree} 比对", () => {
  assert.match(source, /"write-tree"/, "必须有 write-tree 记录 VALIDATED_TREE_SHA");
  assert.match(source, /rev-parse.*HEAD\^\{tree\}/, "必须验证 Commit 后 tree SHA");
  assert.match(source, /validatedTreeSha/, "必须有 validatedTreeSha 变量");
});

test("5. ls-remote 校验：Push 后直接查询远程", () => {
  assert.match(source, /function lsRemoteBranchSha\(/, "必须有 lsRemoteBranchSha 函数");
  assert.match(source, /"ls-remote",\s*"--heads",\s*"origin"/, "必须用 ls-remote --heads origin 查询");
  assert.doesNotMatch(
    source,
    /pushedSha.*rev-parse.*origin\/\$?\{?newBranch/,
    "Push 后不应再用 rev-parse origin/<branch> 校验（应用 ls-remote）",
  );
});

test("6. 原子创建分支：update-ref + zero SHA（禁止覆盖）", () => {
  assert.match(source, /ZERO_SHA/, "必须有 ZERO_SHA 常量");
  assert.match(source, /atomicCreateBranch[\s\S]*update-ref[\s\S]*ZERO_SHA/, "atomicCreateBranch 必须用 update-ref + zero SHA");
});

test("7. delete-remote-branch 携带 expected SHA 校验", () => {
  assert.match(source, /expectedOldRemoteSha/, "必须接受 expectedOldRemoteSha 参数");
  assert.match(source, /expectedNewRemoteSha/, "必须接受 expectedNewRemoteSha 参数");
  assert.match(source, /旧远程分支在重整期间被更新/, "旧远程 SHA 变化时必须有中文提示");
});

test("8. Amend 验证 commit count + 隔离 Worktree", () => {
  assert.match(source, /amendCommitCount\s*!==\s*1/, "Amend 必须验证 commit count = 1");
  assert.match(source, /请使用.*Git 提交整理.*完整重整/, "不满足条件时必须引导使用完整重整");
  assert.match(source, /amend-backup/, "Amend 必须创建 backup ref");
});

test("9. include 模式不 stash（用临时 Index 快照）", () => {
  assert.match(source, /dirtyMode !== "include"/, "stash 条件必须排除 include 模式");
  assert.match(source, /GIT_INDEX_FILE/, "必须用 GIT_INDEX_FILE 创建临时 Index");
  assert.match(source, /read-tree/, "临时 Index 流程必须有 read-tree");
  assert.match(source, /commit-tree/, "临时 Index 流程必须有 commit-tree");
});

// ========== Git 行为集成测试 ==========

test("10. 多个线性 Commit 重整为一个 Commit", () => {
  const repo = makeRepo();
  const remote = makeBareRemote("multi-commit");
  try {
    git(repo, ["remote", "add", "origin", remote]);
    writeFile(repo, "base.txt", "base");
    commit(repo, "base");
    git(repo, ["push", "-u", "origin", "master", "--quiet"]);

    git(repo, ["checkout", "-b", "feature", "--quiet"]);
    writeFile(repo, "a.txt", "a");
    commit(repo, "commit 1");
    writeFile(repo, "b.txt", "b");
    commit(repo, "commit 2");
    writeFile(repo, "c.txt", "c");
    commit(repo, "commit 3");

    const targetSha = git(repo, ["rev-parse", "master"]);
    const sourceSha = git(repo, ["rev-parse", "feature"]);

    // 模拟 squash：在 target 上创建 detached worktree，squash merge source
    const wtDir = path.join(path.dirname(repo), `_test-wt-${Date.now()}`);
    git(repo, ["worktree", "add", "--detach", wtDir, targetSha, "--quiet"]);
    try {
      git(wtDir, ["merge", "--squash", sourceSha, "--quiet"]);
      git(wtDir, ["commit", "--quiet", "-m", "squashed"]);
      const resultSha = git(wtDir, ["rev-parse", "HEAD"]);

      // 验证：父节点 = targetSha，commit 数 = 1
      assert.equal(git(wtDir, ["rev-parse", "HEAD^"]), targetSha);
      assert.equal(git(wtDir, ["rev-list", "--count", `${targetSha}..HEAD`]), "1");
      assert.equal(git(wtDir, ["rev-list", "--merges", "-n", "1", `${targetSha}..HEAD`]), "");
    } finally {
      git(repo, ["worktree", "remove", "--force", wtDir]);
    }
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(remote, { recursive: true, force: true });
  }
});

test("11. Source 包含 Merge Commit 时 squash 自然消除", () => {
  const repo = makeRepo();
  try {
    writeFile(repo, "base.txt", "base");
    commit(repo, "base");
    const targetSha = git(repo, ["rev-parse", "HEAD"]);

    git(repo, ["checkout", "-b", "branch-a", "--quiet"]);
    writeFile(repo, "a.txt", "a");
    commit(repo, "a work");

    git(repo, ["checkout", "master", "--quiet"]);
    git(repo, ["checkout", "-b", "branch-b", "--quiet"]);
    writeFile(repo, "b.txt", "b");
    commit(repo, "b work");

    git(repo, ["checkout", "branch-a", "--quiet"]);
    git(repo, ["merge", "--no-ff", "branch-b", "-m", "merge b into a", "--quiet"]);

    const sourceSha = git(repo, ["rev-parse", "HEAD"]);
    const mergeCount = git(repo, ["rev-list", "--merges", "--count", `${targetSha}..${sourceSha}`]);
    assert.equal(mergeCount, "1", "Source 应包含 1 个 merge commit");

    // Squash 后 merge commit 应消除
    const wtDir = path.join(path.dirname(repo), `_test-wt-merge-${Date.now()}`);
    git(repo, ["worktree", "add", "--detach", wtDir, targetSha, "--quiet"]);
    try {
      git(wtDir, ["merge", "--squash", sourceSha, "--quiet"]);
      git(wtDir, ["commit", "--quiet", "-m", "squashed"]);
      assert.equal(git(wtDir, ["rev-list", "--count", `${targetSha}..HEAD`]), "1");
      assert.equal(git(wtDir, ["rev-list", "--merges", "-n", "1", `${targetSha}..HEAD`]), "");
    } finally {
      git(repo, ["worktree", "remove", "--force", wtDir]);
    }
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("12. 临时 Index 快照不修改真实 Index/Worktree", () => {
  const repo = makeRepo();
  try {
    writeFile(repo, "base.txt", "base");
    commit(repo, "base");
    const sourceHeadSha = git(repo, ["rev-parse", "HEAD"]);

    // 制造 dirty 状态
    writeFile(repo, "dirty.txt", "dirty content");
    fs.writeFileSync(path.join(repo, "untracked.txt"), "untracked");

    const statusBefore = git(repo, ["status", "--porcelain", "-uall"]);

    // 模拟临时 Index 快照流程
    const tempIndexDir = fs.mkdtempSync(path.join(os.tmpdir(), "temp-index-"));
    const tempIndexFile = path.join(tempIndexDir, "index");
    try {
      gitEnv(repo, ["read-tree", sourceHeadSha], { GIT_INDEX_FILE: tempIndexFile });
      gitEnv(repo, ["add", "--", "dirty.txt", "untracked.txt"], { GIT_INDEX_FILE: tempIndexFile });
      const treeSha = gitEnv(repo, ["write-tree"], { GIT_INDEX_FILE: tempIndexFile });
      assert.ok(treeSha, "write-tree 必须返回 tree SHA");

      // 验证真实 Index/Worktree 未被改变
      const statusAfter = git(repo, ["status", "--porcelain", "-uall"]);
      assert.equal(statusAfter, statusBefore, "快照前后工作区状态必须完全一致");
    } finally {
      fs.rmSync(tempIndexDir, { recursive: true, force: true });
    }
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("13. 原子创建分支：已存在且 SHA 不同时拒绝", () => {
  const repo = makeRepo();
  try {
    writeFile(repo, "a.txt", "a");
    commit(repo, "base");
    const sha1 = git(repo, ["rev-parse", "HEAD"]);

    writeFile(repo, "b.txt", "b");
    commit(repo, "second");
    const sha2 = git(repo, ["rev-parse", "HEAD"]);

    // 创建分支指向 sha1
    git(repo, ["update-ref", "refs/heads/test-branch", sha1]);

    // 尝试原子创建指向 sha2（应失败，因为分支已存在）
    let failed = false;
    try {
      git(repo, ["update-ref", "refs/heads/test-branch", sha2, ZERO_SHA]);
    } catch {
      failed = true;
    }
    assert.ok(failed, "原子创建已存在的分支必须失败");

    // 分支仍指向 sha1（未被覆盖）
    assert.equal(git(repo, ["rev-parse", "refs/heads/test-branch"]), sha1);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("14. 原子创建分支：不存在时成功", () => {
  const repo = makeRepo();
  try {
    writeFile(repo, "a.txt", "a");
    commit(repo, "base");
    const sha = git(repo, ["rev-parse", "HEAD"]);

    // 原子创建新分支（应成功）
    git(repo, ["update-ref", "refs/heads/new-branch", sha, ZERO_SHA]);
    assert.equal(git(repo, ["rev-parse", "refs/heads/new-branch"]), sha);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("15. ls-remote 直接查询远程分支 SHA", () => {
  const repo = makeRepo();
  const remote = makeBareRemote("lsremote");
  try {
    git(repo, ["remote", "add", "origin", remote]);
    writeFile(repo, "a.txt", "a");
    commit(repo, "base");
    git(repo, ["push", "-u", "origin", "master", "--quiet"]);

    const localSha = git(repo, ["rev-parse", "HEAD"]);

    // ls-remote 查询
    const lsOutput = git(repo, ["ls-remote", "--heads", "origin", "refs/heads/master"]);
    const remoteSha = lsOutput.split(/\s+/)[0];
    assert.equal(remoteSha, localSha, "ls-remote SHA 必须等于本地 SHA");

    // 查询不存在的分支
    const emptyOutput = git(repo, ["ls-remote", "--heads", "origin", "refs/heads/nonexistent"]);
    assert.equal(emptyOutput, "", "不存在的分支 ls-remote 应返回空");
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(remote, { recursive: true, force: true });
  }
});

test("16. Push 后远程 SHA 校验（ls-remote vs fetch+rev-parse 等价性）", () => {
  const repo = makeRepo();
  const remote = makeBareRemote("push-verify");
  try {
    git(repo, ["remote", "add", "origin", remote]);
    writeFile(repo, "a.txt", "a");
    commit(repo, "base");
    git(repo, ["checkout", "-b", "feature", "--quiet"]);
    git(repo, ["push", "-u", "origin", "feature", "--quiet"]);

    const localSha = git(repo, ["rev-parse", "HEAD"]);

    // ls-remote 方式
    const lsSha = git(repo, ["ls-remote", "--heads", "origin", "refs/heads/feature"]).split(/\s+/)[0];
    assert.equal(lsSha, localSha, "ls-remote SHA 必须等于本地 SHA");

    // fetch + rev-parse 方式
    git(repo, ["fetch", "origin", "feature", "--quiet"]);
    const fetchedSha = git(repo, ["rev-parse", "origin/feature"]);
    assert.equal(fetchedSha, localSha, "fetch+rev-parse SHA 必须等于本地 SHA");

    // 两种方式结果一致
    assert.equal(lsSha, fetchedSha, "ls-remote 和 fetch+rev-parse 结果必须一致");
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(remote, { recursive: true, force: true });
  }
});

test("17. 敏感文件阻断：.env / keystore / 证书", () => {
  const repo = makeRepo();
  try {
    writeFile(repo, "base.txt", "base");
    commit(repo, "base");

    // 创建敏感文件
    writeFile(repo, ".env", "SECRET=abc");
    writeFile(repo, "app.jks", "keystore content");
    writeFile(repo, "local.properties", "sdk.dir=/test");
    writeFile(repo, "cert.pem", "cert content");

    git(repo, ["add", "-A"]);
    const stagedFiles = git(repo, ["diff", "--cached", "--name-only"]).split(/\r?\n/).filter(Boolean);

    // 模拟敏感文件检测
    const SENSITIVE_PATTERNS = [
      /(^|[\\/])\.env(\..*)?$/i,
      /(^|[\\/])local\.properties$/i,
      /\.(jks|p12|pfx|keystore|pem|crt|key|p8|p7b)$/i,
      /(^|[\\/])(secret|token|password|credential|api[-_]?key)([\\/]|\.)/i,
    ];
    function isSensitive(p) {
      return SENSITIVE_PATTERNS.some((re) => re.test(p));
    }

    const sensitiveStaged = stagedFiles.filter(isSensitive);
    assert.ok(sensitiveStaged.length >= 4, `应检测到至少 4 个敏感文件，实际 ${sensitiveStaged.length}`);
    assert.ok(sensitiveStaged.includes(".env"));
    assert.ok(sensitiveStaged.includes("app.jks"));
    assert.ok(sensitiveStaged.includes("local.properties"));
    assert.ok(sensitiveStaged.includes("cert.pem"));
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("18. Tree 验证：构建后 Tree 被修改时检出不一致", () => {
  const repo = makeRepo();
  try {
    writeFile(repo, "base.txt", "base");
    commit(repo, "base");

    writeFile(repo, "feature.txt", "feature");
    git(repo, ["add", "-A"]);

    // write-tree 记录构建前的 tree
    const validatedTreeSha = git(repo, ["write-tree"]);

    // 模拟构建后文件被修改
    writeFile(repo, "feature.txt", "modified after build");
    git(repo, ["add", "-A"]);

    // commit
    git(repo, ["commit", "--quiet", "-m", "test commit"]);
    const resultTreeSha = git(repo, ["rev-parse", "HEAD^{tree}"]);

    // Tree SHA 不一致（构建后被修改）
    assert.notEqual(resultTreeSha, validatedTreeSha, "构建后 Tree 被修改时 SHA 必须不一致");

    // 如果没有被修改，Tree SHA 应一致
    git(repo, ["reset", "--hard", "HEAD~1", "--quiet"]);
    writeFile(repo, "feature.txt", "feature");
    git(repo, ["add", "-A"]);
    const validatedTreeSha2 = git(repo, ["write-tree"]);
    git(repo, ["commit", "--quiet", "-m", "test commit 2"]);
    const resultTreeSha2 = git(repo, ["rev-parse", "HEAD^{tree}"]);
    assert.equal(resultTreeSha2, validatedTreeSha2, "未被修改时 Tree SHA 必须一致");
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("19. Detached Worktree 失败不产生正式新分支", () => {
  const repo = makeRepo();
  try {
    writeFile(repo, "base.txt", "base");
    commit(repo, "base");
    const targetSha = git(repo, ["rev-parse", "HEAD"]);

    // 用 --detach 创建 worktree（不创建分支）
    const wtDir = path.join(path.dirname(repo), `_test-wt-fail-${Date.now()}`);
    git(repo, ["worktree", "add", "--detach", wtDir, targetSha, "--quiet"]);

    // 确认没有创建正式分支
    const branches = git(repo, ["branch", "--list"]).split(/\r?\n/).filter(Boolean).map(b => b.trim().replace(/^\*\s*/, ""));
    assert.ok(!branches.includes("new-branch"), "Detached worktree 不应创建正式分支");

    // 清理
    git(repo, ["worktree", "remove", "--force", wtDir]);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("20. 旧远程在删除前被其他用户更新（SHA 变化拒绝删除）", () => {
  const repo = makeRepo();
  const remote = makeBareRemote("delete-updated");
  try {
    git(repo, ["remote", "add", "origin", remote]);
    writeFile(repo, "a.txt", "a");
    commit(repo, "base");
    git(repo, ["push", "-u", "origin", "master", "--quiet"]);

    const originalSha = git(repo, ["rev-parse", "HEAD"]);

    // 模拟其他用户更新远程
    const otherRepo = fs.mkdtempSync(path.join(os.tmpdir(), "other-user-"));
    try {
      git(otherRepo, ["clone", "--quiet", remote, otherRepo]);
      git(otherRepo, ["config", "user.email", "other@example.com"]);
      git(otherRepo, ["config", "user.name", "other"]);
      git(otherRepo, ["config", "commit.gpgsign", "false"]);
      writeFile(otherRepo, "b.txt", "b");
      git(otherRepo, ["add", "-A"]);
      git(otherRepo, ["commit", "--quiet", "-m", "other user commit"]);
      git(otherRepo, ["push", "origin", "master", "--quiet"]);
    } finally {
      fs.rmSync(otherRepo, { recursive: true, force: true });
    }

    // 重新 ls-remote 查询远程 SHA
    const currentRemoteSha = git(repo, ["ls-remote", "--heads", "origin", "refs/heads/master"]).split(/\s+/)[0];

    // SHA 已变化
    assert.notEqual(currentRemoteSha, originalSha, "远程 SHA 应已被其他用户更新");
    assert.notEqual(currentRemoteSha, "", "ls-remote 应返回非空 SHA");

    // 模拟 delete-remote-branch 逻辑：expectedOldRemoteSha != currentRemoteSha -> 拒绝
    const expectedOldRemoteSha = originalSha;
    assert.notEqual(currentRemoteSha, expectedOldRemoteSha, "SHA 不匹配时应拒绝删除");
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(remote, { recursive: true, force: true });
  }
});

test("21. 原远程不存在时删除显示「不适用」", () => {
  const repo = makeRepo();
  const remote = makeBareRemote("no-remote");
  try {
    git(repo, ["remote", "add", "origin", remote]);
    writeFile(repo, "a.txt", "a");
    commit(repo, "base");
    // 不 push，远程不存在该分支

    // ls-remote 查询不存在的分支
    const lsResult = git(repo, ["ls-remote", "--heads", "origin", "refs/heads/nonexistent"]);
    assert.equal(lsResult, "", "不存在的远程分支应返回空");

    // 模拟后端逻辑：旧远程不存在 -> 返回 notApplicable
    const notApplicable = !lsResult;
    assert.ok(notApplicable, "旧远程不存在时应标记为「不适用」");
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(remote, { recursive: true, force: true });
  }
});

test("22. Amend 多 Commit 场景：commit count > 1 应拒绝快速 Amend", () => {
  const repo = makeRepo();
  try {
    writeFile(repo, "base.txt", "base");
    commit(repo, "base");
    writeFile(repo, "a.txt", "a");
    commit(repo, "commit 1");
    writeFile(repo, "b.txt", "b");
    commit(repo, "commit 2");

    const targetSha = git(repo, ["rev-parse", "HEAD^^"]);
    const curBranch = git(repo, ["branch", "--show-current"]);
    const commitCount = Number(git(repo, ["rev-list", "--count", `${targetSha}..${curBranch}`]));

    assert.equal(commitCount, 2, "当前分支相对父节点应有 2 个提交");
    assert.ok(commitCount !== 1, "多提交时应拒绝快速 Amend");
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("23. Amend 单 Commit 场景：commit count = 1 允许快速 Amend", () => {
  const repo = makeRepo();
  try {
    writeFile(repo, "base.txt", "base");
    commit(repo, "base");
    writeFile(repo, "a.txt", "a");
    commit(repo, "single commit");

    const headSha = git(repo, ["rev-parse", "HEAD"]);
    const parentInfo = git(repo, ["rev-list", "--parents", "-n", "1", "HEAD"]).split(/\s+/);
    const parentCount = parentInfo.length - 1;
    const targetSha = parentInfo[1];
    const commitCount = Number(git(repo, ["rev-list", "--count", `${targetSha}..HEAD`]));

    assert.equal(parentCount, 1, "HEAD 应只有 1 个父节点");
    assert.equal(commitCount, 1, "相对父节点应有 1 个提交");
    assert.ok(parentCount === 1 && commitCount === 1, "满足快速 Amend 条件");
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("24. 内部引用创建与清理", () => {
  const repo = makeRepo();
  try {
    writeFile(repo, "a.txt", "a");
    commit(repo, "base");
    const sha = git(repo, ["rev-parse", "HEAD"]);

    const operationId = `test-${Date.now()}`;
    const refName = `refs/ai-restructure/${operationId}/source`;

    // 创建内部引用
    git(repo, ["update-ref", refName, sha]);
    assert.equal(git(repo, ["rev-parse", refName]), sha, "内部引用应指向正确 SHA");

    // 列出内部引用
    const refs = git(repo, ["for-each-ref", "--format=%(refname)", `refs/ai-restructure/${operationId}/`]);
    assert.ok(refs.includes(refName), "for-each-ref 应列出内部引用");

    // 删除内部引用
    git(repo, ["update-ref", "-d", refName]);
    let refExists = false;
    try {
      git(repo, ["rev-parse", "--verify", "--quiet", refName]);
      refExists = true;
    } catch {
      refExists = false;
    }
    assert.ok(!refExists, "删除后内部引用不应存在");
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("25. Source 在操作期间新增 Commit：快照 SHA 不变", () => {
  const repo = makeRepo();
  try {
    writeFile(repo, "base.txt", "base");
    commit(repo, "base");
    git(repo, ["checkout", "-b", "feature", "--quiet"]);
    writeFile(repo, "a.txt", "a");
    commit(repo, "commit 1");

    // 记录快照 SHA
    const snapshotSha = git(repo, ["rev-parse", "HEAD"]);

    // 模拟操作期间 Source 分支新增 Commit
    writeFile(repo, "b.txt", "b");
    commit(repo, "commit 2");

    // Source HEAD 已移动
    const newHeadSha = git(repo, ["rev-parse", "HEAD"]);
    assert.notEqual(newHeadSha, snapshotSha, "Source HEAD 应已移动");

    // 但快照 SHA 不变（因为是固定的 ref/SHA）
    // 模拟 squash 使用快照 SHA（而非分支名）
    const targetSha = git(repo, ["rev-parse", "master"]);
    const wtDir = path.join(path.dirname(repo), `_test-wt-snapshot-${Date.now()}`);
    git(repo, ["worktree", "add", "--detach", wtDir, targetSha, "--quiet"]);
    try {
      // 用快照 SHA 做 squash（而非分支名 feature）
      git(wtDir, ["merge", "--squash", snapshotSha, "--quiet"]);
      git(wtDir, ["commit", "--quiet", "-m", "squashed with snapshot"]);
      assert.equal(git(wtDir, ["rev-list", "--count", `${targetSha}..HEAD`]), "1");
    } finally {
      git(repo, ["worktree", "remove", "--force", wtDir]);
    }
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("26. Stash 恢复失败时保留 stash OID（apply 不 pop）", () => {
  const repo = makeRepo();
  try {
    writeFile(repo, "base.txt", "base");
    commit(repo, "base");
    writeFile(repo, "dirty.txt", "dirty");

    // stash push
    git(repo, ["stash", "push", "-u", "-m", "test-stash", "--quiet"]);
    const stashOid = git(repo, ["rev-parse", "stash@{0}"]);
    assert.ok(stashOid, "stash OID 应存在");

    // 模拟恢复失败：用 stash apply（非 pop），失败后 stash 仍保留
    // 制造冲突让 apply 失败
    writeFile(repo, "dirty.txt", "conflicting content");
    commit(repo, "conflicting commit");

    let applyFailed = false;
    try {
      git(repo, ["stash", "apply", stashOid, "--quiet"]);
    } catch {
      applyFailed = true;
    }

    // 即使 apply 失败，stash 仍应存在（因为用的是 apply 不是 pop）
    let stashStillExists = false;
    try {
      const stillThere = git(repo, ["rev-parse", "--verify", "--quiet", stashOid]);
      stashStillExists = Boolean(stillThere);
    } catch {
      stashStillExists = false;
    }
    // stash apply 失败后 stash 应仍保留
    assert.ok(stashStillExists, "stash apply 失败后 stash OID 应仍保留");
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});
