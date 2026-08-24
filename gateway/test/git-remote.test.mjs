import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  filterRemoteBranches,
  gitHttpsToSsh,
  gitRemoteCandidates,
  gitRemoteTransport,
  readRemoteBranchFiles,
  resolveAccessibleGitRemote,
} from "../services/devbench/git-remote.js";

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", windowsHide: true }).trim();
}

test("gitRemoteCandidates：HTTPS 优先、去空并去重", () => {
  assert.deepEqual(gitRemoteCandidates({
    ssh: " git@example.com:team/repo.git ",
    https: "https://example.com/team/repo.git",
  }), [
    "https://example.com/team/repo.git",
    "git@example.com:team/repo.git",
  ]);
  assert.deepEqual(gitRemoteCandidates({ ssh: "same", https: "same" }), ["same"]);
});

test("gitRemoteCandidates：Codeup HTTPS 网页地址规范化为 .git 克隆地址", () => {
  assert.deepEqual(gitRemoteCandidates({
    ssh: "git@codeup.aliyun.com:xunihezi/AIEfficiency.git",
    https: "https://codeup.aliyun.com/xunihezi/AIEfficiency",
  }), [
    "https://codeup.aliyun.com/xunihezi/AIEfficiency.git",
    "git@codeup.aliyun.com:xunihezi/AIEfficiency.git",
  ]);
});

test("gitHttpsToSsh：派生 SSH 地址时丢弃 HTTPS 凭证、端口和查询参数", () => {
  assert.equal(
    gitHttpsToSsh("https://alice:secret@example.com:8443/team/repo.git?token=hidden"),
    "git@example.com:team/repo.git",
  );
});

test("gitRemoteTransport：识别 SSH 与 HTTPS", () => {
  assert.equal(gitRemoteTransport("git@example.com:team/repo.git"), "ssh");
  assert.equal(gitRemoteTransport("ssh://git@example.com/team/repo.git"), "ssh");
  assert.equal(gitRemoteTransport("https://example.com/team/repo.git"), "https");
});

test("resolveAccessibleGitRemote：HTTPS 失败后回退 SSH", async () => {
  const calls = [];
  const result = await resolveAccessibleGitRemote({
    ssh: "git@example.com:team/repo.git",
    https: "https://example.com/team/repo.git",
  }, {
    probe: async (url) => {
      calls.push(url);
      return url.startsWith("https:")
        ? { ok: false, error: "HTTP 403" }
        : { ok: true, branches: ["main"] };
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.url, "git@example.com:team/repo.git");
  assert.equal(result.transport, "ssh");
  assert.equal(result.fallback, true);
  assert.deepEqual(result.branches, ["main"]);
  assert.deepEqual(calls, [
    "https://example.com/team/repo.git",
    "git@example.com:team/repo.git",
  ]);
});

test("resolveAccessibleGitRemote：所有认证方式失败时保留逐项证据", async () => {
  const result = await resolveAccessibleGitRemote({
    ssh: "git@example.com:team/repo.git",
    https: "https://example.com/team/repo.git",
  }, {
    probe: async (url) => ({ ok: false, error: url.startsWith("https:") ? "HTTP 403" : "publickey" }),
  });

  assert.equal(result.ok, false);
  assert.equal(result.attempts.length, 2);
  assert.match(result.error, /\[SSH\] publickey/);
  assert.match(result.error, /\[HTTPS\] HTTP 403/);
});

test("resolveAccessibleGitRemote：返回结果和错误不会泄露 HTTPS 内嵌凭证", async () => {
  const credentialUrl = "https://alice:secret@example.com/team/repo.git";
  const result = await resolveAccessibleGitRemote({ https: credentialUrl }, {
    probe: async () => ({
      ok: false,
      error: `fatal: Authentication failed for '${credentialUrl}'`,
    }),
  });

  const serialized = JSON.stringify(result);
  assert.doesNotMatch(serialized, /alice|secret/);
  assert.match(result.url, /\*\*\*/);
  assert.match(result.error, /\*\*\*/);
  assert.match(result.attempts[0].url, /\*\*\*/);
});

test("filterRemoteBranches：只保留 release/* 与指定版本分支", () => {
  assert.deepEqual(filterRemoteBranches([
    "main", "release/car-b", "v202601", "release/car-a", "v202605-ui",
  ], ["release/*", "v202605-ui", "v202601"]), [
    "release/car-a", "release/car-b", "v202601", "v202605-ui",
  ]);
});

test("readRemoteBranchFiles：从真实 bare remote 只读目标分支的固定车型配置文件", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aiefficiency-git-remote-test-"));
  const work = path.join(root, "work");
  const bare = path.join(root, "remote.git");
  try {
    fs.mkdirSync(work, { recursive: true });
    git(work, "init", "--initial-branch=main");
    git(work, "config", "user.email", "test@example.com");
    git(work, "config", "user.name", "AIEfficiency Test");
    fs.writeFileSync(path.join(work, "README.md"), "fixture\n");
    git(work, "add", "README.md");
    git(work, "commit", "-m", "main");

    git(work, "checkout", "-b", "release/car-a");
    fs.writeFileSync(path.join(work, "flavorConfig.json"), JSON.stringify({ carA: { versionName: "1.0.0" } }));
    git(work, "add", "flavorConfig.json");
    git(work, "commit", "-m", "release flavor");

    git(work, "checkout", "main");
    git(work, "checkout", "-b", "v202605-ui");
    fs.writeFileSync(path.join(work, "project_flavor.gradle"), "android { productFlavors { carB { dimension 'car' } } }");
    git(work, "add", "project_flavor.gradle");
    git(work, "commit", "-m", "ui flavor");

    git(root, "init", "--bare", bare);
    git(work, "remote", "add", "origin", bare);
    git(work, "push", "--all", "origin");

    const result = await readRemoteBranchFiles(bare, {
      branchPatterns: ["release/*", "v202605-ui", "v202601"],
      filePaths: ["flavorConfig.json", "project_flavor.gradle"],
    });

    assert.equal(result.ok, true, result.error);
    assert.deepEqual(result.matchedBranches, ["release/car-a", "v202605-ui"]);
    assert.match(result.branches.find((row) => row.branch === "release/car-a")?.files?.["flavorConfig.json"] || "", /carA/);
    assert.match(result.branches.find((row) => row.branch === "v202605-ui")?.files?.["project_flavor.gradle"] || "", /carB/);
    assert.equal(result.branches.some((row) => row.branch === "main"), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
