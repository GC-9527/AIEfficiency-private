import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  collectGitData,
  collectGitDataAsync,
  getAuthoritativeWorkReportRepositories,
  repositoryRemoteKey,
  resolveWorkReportRepositories,
} from "../services/work-report-repositories.js";

test("工作报告仓库：以仓库定义分组，同一远程的逻辑定义和本地副本去重", () => {
  const remoteByPath = new Map([
    ["D:\\src\\market", "git@codeup.aliyun.com:xunihezi/AppMarket.git"],
    ["D:\\src\\market-copy", "https://codeup.aliyun.com/xunihezi/AppMarket"],
    ["D:\\src\\web", "git@codeup.aliyun.com:xunihezi/CarBoxDev/WebApp.git"],
  ]);
  const repositories = resolveWorkReportRepositories({
    projectDefs: [
      { id: "appMarket", name: "应用市场", ssh: "git@codeup.aliyun.com:xunihezi/AppMarket.git" },
      { id: "appMarketSdk", name: "应用市场SDK", https: "https://codeup.aliyun.com/xunihezi/AppMarket" },
      { id: "webApp", name: "WebApp", ssh: "git@codeup.aliyun.com:xunihezi/CarBoxDev/WebApp.git" },
      { id: "missing", name: "未克隆仓库", ssh: "git@example.com:team/missing.git" },
    ],
    localProjects: [
      { id: "local-market", name: "本地应用市场", path: "D:\\src\\market", webAppPath: "D:\\src\\web", exists: true },
    ],
    localCheckoutsByRepository: {
      appMarket: [
        { path: "d:\\SRC\\market", name: "大小写重复路径" },
        { path: "D:\\src\\market-copy", name: "另一分支副本" },
      ],
    },
    remoteUrlForPath: (repoPath) => remoteByPath.get(repoPath)
      || remoteByPath.get([...remoteByPath.keys()].find((key) => key.toLowerCase() === String(repoPath).toLowerCase()))
      || "",
    pathExists: () => true,
  });

  assert.equal(repositoryRemoteKey("git@codeup.aliyun.com:xunihezi/AppMarket.git"), "codeup.aliyun.com/xunihezi/appmarket");
  assert.equal(repositories.length, 3);
  assert.deepEqual(repositories[0].definitionIds, ["appMarket", "appMarketSdk"]);
  assert.equal(repositories[0].name, "应用市场 / 应用市场SDK");
  assert.deepEqual(repositories[0].paths.map((row) => row.path), ["D:\\src\\market", "D:\\src\\market-copy"]);
  assert.deepEqual(repositories[1].paths.map((row) => row.path), ["D:\\src\\web"]);
  assert.equal(repositories[2].hasLocal, false);
  assert.deepEqual(repositories[2].paths, []);
});

test("工作报告提交采集：同仓库多份源码按完整 commit hash 去重", () => {
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), "aiefficiency-work-report-"));
  try {
    const first = path.join(tempRoot, "repo-a");
    const second = path.join(tempRoot, "repo-b");
    execFileSync("git", ["init", first], { stdio: "ignore" });
    execFileSync("git", ["-C", first, "config", "user.name", "工作报告测试用户"]);
    execFileSync("git", ["-C", first, "config", "user.email", "work-report@example.com"]);
    writeFileSync(path.join(first, "sample.txt"), "sample\n", "utf8");
    execFileSync("git", ["-C", first, "add", "sample.txt"]);
    execFileSync("git", ["-C", first, "commit", "-m", "test: 工作报告仓库去重"], { stdio: "ignore" });
    cpSync(first, second, { recursive: true });

    const result = collectGitData([{
      id: "sample",
      name: "示例仓库",
      definitionIds: ["sample"],
      paths: [{ path: first }, { path: second }],
    }], "2000-01-01", "2030-01-01");

    assert.equal(result.length, 1);
    assert.equal(result[0].commits.length, 1);
    assert.equal(result[0].total.commits, 1);
    assert.equal(result[0].total.files, 1);
    assert.equal(result[0].sourcePaths.length, 2);
    assert.equal(result[0].error, undefined);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("工作报告异步提交采集：与同步口径一致并保留完整 hash 去重", async () => {
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), "aiefficiency-work-report-async-"));
  try {
    const first = path.join(tempRoot, "repo-a");
    const second = path.join(tempRoot, "repo-b");
    execFileSync("git", ["init", first], { stdio: "ignore" });
    execFileSync("git", ["-C", first, "config", "user.name", "异步采集测试用户"]);
    execFileSync("git", ["-C", first, "config", "user.email", "work-report-async@example.com"]);
    writeFileSync(path.join(first, "sample.txt"), "sample\n", "utf8");
    execFileSync("git", ["-C", first, "add", "sample.txt"]);
    execFileSync("git", ["-C", first, "commit", "-m", "test: 异步工作报告采集"], { stdio: "ignore" });
    cpSync(first, second, { recursive: true });

    const repositories = [{
      id: "sample",
      name: "异步示例仓库",
      definitionIds: ["sample"],
      paths: [{ path: first }, { path: second }],
    }];
    const syncResult = collectGitData(repositories, "2000-01-01", "2030-01-01");
    const asyncResult = await collectGitDataAsync(repositories, "2000-01-01", "2030-01-01", { concurrency: 2 });

    assert.deepEqual(asyncResult, syncResult);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("工作报告提交采集：仓库定义没有本机源码时明确标记不可采集", () => {
  const result = collectGitData([{
    id: "missing",
    name: "未克隆仓库",
    definitionIds: ["missing"],
    paths: [],
  }], "2026-01-01", "2026-12-31");

  assert.equal(result[0].commits.length, 0);
  assert.equal(result[0].error, "本机未找到与仓库定义匹配的源码");
});

test("工作报告仓库：node 客户端只使用中心仓库定义，不回退本地种子", async () => {
  const store = {
    getProjectDefs: () => [{ id: "local-seed", name: "本地种子", ssh: "git@example.com:local/seed.git" }],
    listProjects: () => [{ id: "local-project", name: "中心仓库源码", path: "D:\\src\\central", exists: true }],
    getLocalCheckouts: () => [],
    gitRemoteUrl: () => "git@example.com:center/repository.git",
  };
  const fetchCalls = [];
  const repositories = await getAuthoritativeWorkReportRepositories(store, {
    role: "node",
    servers: { peers: ["http://center.example.test"] },
    claudeProxyClient: { host: "http://center.example.test/", token: "machine-secret" },
  }, async (url, options) => {
    fetchCalls.push({ url, options });
    return {
      ok: true,
      status: 200,
      json: async () => ({
        ok: true,
        data: [{ id: "central", name: "中心仓库", ssh: "git@example.com:center/repository.git" }],
      }),
    };
  }, { pathExists: () => true });

  assert.equal(fetchCalls.length, 1);
  assert.equal(fetchCalls[0].url, "http://center.example.test/api/devbench/project-defs");
  assert.equal(fetchCalls[0].options.headers.Authorization, "Bearer machine-secret");
  assert.equal(fetchCalls[0].options.redirect, "error");
  assert.equal(repositories.length, 1);
  assert.deepEqual(repositories[0].definitionIds, ["central"]);
  assert.equal(repositories[0].hasLocal, true);
});

test("工作报告仓库：node 中心不可达时明确失败，不采集本地种子", async () => {
  const store = {
    getProjectDefs: () => [{ id: "local-seed", name: "本地种子", ssh: "git@example.com:local/seed.git" }],
    listProjects: () => [],
    getLocalCheckouts: () => [],
    gitRemoteUrl: () => "",
  };
  await assert.rejects(
    () => getAuthoritativeWorkReportRepositories(store, {
      role: "node",
      servers: { peers: ["http://center.example.test"] },
      claudeProxyClient: { host: "http://center.example.test", token: "machine-secret" },
    }, async () => { throw new Error("连接超时"); }),
    /中心服务端不可达.*连接超时/,
  );
});

test("工作报告仓库：已登记 checkout 的真实 remote 不匹配时不得参与采集", () => {
  const repositories = resolveWorkReportRepositories({
    projectDefs: [{ id: "repo-a", name: "仓库A", ssh: "git@example.com:team/repo-a.git" }],
    localProjects: [],
    localCheckoutsByRepository: {
      "repo-a": [{ path: "D:\\src\\wrong-repository", name: "误登记路径" }],
    },
    remoteUrlForPath: () => "git@example.com:team/repo-b.git",
    pathExists: () => true,
  });

  assert.equal(repositories.length, 1);
  assert.equal(repositories[0].hasLocal, false);
  assert.deepEqual(repositories[0].paths, []);
});
