import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  buildGitReviewTitle,
  extractGitCommitReferences,
  inferGitCommitConfiguration,
  inspectGitCommit,
  inspectGitCommitLatestBranch,
  normalizeGitCommitReviewHint,
  normalizeGitCommitRevision,
  resolveGitCommitConfigurationChoice,
  resolveGitCommitBatch,
  resolveGitRepositorySelection,
} from "../services/devbench/git-commit-story.js";

test("Git revision 与仓库输入只接受可审计的已配置目标", () => {
  assert.equal(normalizeGitCommitRevision("").code, "GIT_REVISION_REQUIRED");
  assert.equal(normalizeGitCommitRevision("abc123").ok, false);
  assert.deepEqual(normalizeGitCommitRevision("A1B2C3D"), {
    ok: true,
    revision: "a1b2c3d",
  });

  const projectDefs = [
    { id: "app", name: "应用", https: "https://code.example/team/app.git" },
    { id: "sdk", name: "SDK", ssh: "git@code.example:team/app.git" },
  ];
  assert.equal(resolveGitRepositorySelection({ repositoryId: "app", projectDefs }).definition.id, "app");
  assert.equal(
    resolveGitRepositorySelection({
      repositoryUrl: "https://code.example/team/app",
      projectDefs,
    }).code,
    "GIT_REPOSITORY_AMBIGUOUS",
  );
  assert.equal(
    resolveGitRepositorySelection({
      repositoryUrl: "https://code.example/team/unknown",
      projectDefs,
    }).code,
    "GIT_REPOSITORY_NOT_CONFIGURED",
  );

  const sensitive = resolveGitRepositorySelection({
    repositoryId: "secure",
    projectDefs: [{
      id: "secure",
      name: "Secure",
      https: "https://user:password@code.example/team/secure.git?access_token=SYNTHETIC_SECRET#private",
    }],
  });
  assert.equal(sensitive.ok, true);
  assert.doesNotMatch(sensitive.displayUrl, /user|password|SYNTHETIC_SECRET|access_token|private/);
  assert.doesNotMatch(sensitive.displayUrl, /[?#]/);
});

test("评审故事点创建必须由用户明确确认本地工程或远程拉取", () => {
  const localCandidates = [
    {
      projectId: "local-market",
      name: "应用市场本地工程",
      path: "D:\\fixture\\AppMarket",
      role: "",
    },
    {
      projectId: "local-market",
      name: "应用市场 WebApp",
      path: "D:\\fixture\\WebApp",
      role: "webapp",
    },
  ];
  assert.equal(resolveGitCommitConfigurationChoice({}, localCandidates).code, "GIT_COMMIT_CONFIGURATION_CONFIRMATION_REQUIRED");
  assert.equal(resolveGitCommitConfigurationChoice({
    configurationConfirmed: true,
    configuration: {},
  }, localCandidates).code, "GIT_COMMIT_CONFIGURATION_MODE_REQUIRED");
  assert.deepEqual(resolveGitCommitConfigurationChoice({
    configurationConfirmed: true,
    configuration: { mode: "remote" },
  }, localCandidates), {
    ok: true,
    mode: "remote",
    localCandidate: null,
  });
  const local = resolveGitCommitConfigurationChoice({
    configurationConfirmed: true,
    configuration: {
      mode: "local",
      localProjectId: "local-market",
      localRole: "webapp",
    },
  }, localCandidates);
  assert.equal(local.ok, true);
  assert.equal(local.localCandidate.path, "D:\\fixture\\WebApp");
  assert.equal(resolveGitCommitConfigurationChoice({
    configurationConfirmed: true,
    configuration: {
      mode: "local",
      localProjectId: "missing",
    },
  }, localCandidates).code, "GIT_COMMIT_LOCAL_PROJECT_NOT_FOUND");
});

test("用户提供的 commit 风险假设会清理空白、空字符并限制长度", () => {
  const normalized = normalizeGitCommitReviewHint(`  风险条：\0\n [546aeab]\t${"风险".repeat(3000)}  `);
  assert.match(normalized, /^风险条： \[546aeab\] 风险/);
  assert.equal(normalized.includes("\0"), false);
  assert.equal(normalized.includes("\n"), false);
  assert.equal(normalized.length, 4000);
});

test("commit 分支与改动路径命中车型后会带出 Flavor 和依赖工程", () => {
  const projectDefs = [
    { id: "appMarket", name: "应用市场", https: "https://code.example/app.git", projectType: "application" },
    { id: "webApp", name: "WebApp", https: "https://code.example/web.git", projectType: "application" },
  ];
  const vehicleMap = {
    avatr8678: {
      apps: [{
        appName: "应用市场",
        repos: [
          { repoId: "appMarket", branch: "feature/avatr-8678", flavor: "avatr8678", targetRole: "primary" },
          { repoId: "webApp", branch: "feature/avatr-8678", flavor: "avatr8678", targetRole: "dependency" },
        ],
      }],
    },
    geelyp155: {
      apps: [{
        appName: "应用市场",
        repos: [
          { repoId: "appMarket", branch: "feature/geely-p155", flavor: "geelyp155", targetRole: "primary" },
        ],
      }],
    },
  };
  const result = inferGitCommitConfiguration({
    repository: projectDefs[0],
    projectDefs,
    vehicleMap,
    commit: {
      subject: "修复 avatr8678 启动问题",
      branches: ["origin/feature/avatr-8678"],
      currentBranch: "",
      changedFiles: [{ path: "app/src/avatr8678/kotlin/MainFragment.kt", status: "M" }],
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.summary.vehicle, "avatr8678");
  assert.equal(result.summary.flavor, "avatr8678");
  assert.equal(result.summary.branch, "feature/avatr-8678");
  assert.equal(result.summary.branchResolution.status, "resolved");
  assert.equal(result.summary.branchResolution.source, "registered_branch");
  assert.deepEqual(result.summary.dependencies.map((item) => item.repositoryId), ["webApp"]);
  assert.equal(result.targets.find((target) => target.repositoryId === "appMarket").targetRole, "primary");
  assert.equal(result.targets.find((target) => target.repositoryId === "webApp").targetRole, "dependency");
  assert.ok(result.summary.confidence > 0.8);
});

test("commit 同时位于多个未映射分支时保留歧义而不猜当前 checkout", () => {
  const repository = {
    id: "tool",
    name: "Tool",
    https: "https://code.example/team/tool.git",
    projectType: "tooling",
    defaultBranch: "main",
  };
  const result = inferGitCommitConfiguration({
    repository,
    projectDefs: [repository],
    commit: {
      subject: "共享祖先提交",
      branches: ["main", "release/stable"],
      currentBranch: "main",
      changedFiles: [{ path: "src/shared.js", status: "M" }],
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.summary.branchResolution.status, "ambiguous");
  assert.deepEqual(result.summary.branchResolution.candidates, ["main", "release/stable"]);
});

test("批量风险文本按方括号短 SHA 保持顺序拆分并显式标记重复项", () => {
  const parsed = extractGitCommitReferences([
    "风险条：[546aeab] 陆斌 · CARB-13479 图标加载失败会跳过 Intent 迁移",
    "[c249433] 阳荣峰 缓存文件没有按资源版本失效",
    "[64d66ee] GuoChao 新类没有随提交加入",
    "[c12f80f] 阳荣峰 跨 Flavor 方法签名不一致",
    "[5016645] 李逸轩 settings.gradle 夹带本地路径",
    "[bc418b9] 阳荣峰 安全驾驶限制被注释",
    "[546aeab] 重复引用不应重复建故事点",
  ].join("  "));
  assert.equal(parsed.ok, true);
  assert.deepEqual(
    parsed.references.map((item) => item.reference),
    ["546aeab", "c249433", "64d66ee", "c12f80f", "5016645", "bc418b9", "546aeab"],
  );
  assert.equal(parsed.unique, 6);
  assert.equal(parsed.references[6].duplicateOf, 0);
  assert.match(parsed.references[0].excerpt, /CARB-13479/);
  assert.match(parsed.references[1].excerpt, /^\[c249433\]/);
  assert.doesNotMatch(parsed.references[1].excerpt, /CARB-13479/);
  const messageOnly = extractGitCommitReferences("优化WebApp断网重试");
  assert.equal(messageOnly.ok, true);
  assert.deepEqual(messageOnly.references.map((item) => ({
    reference: item.reference,
    queryType: item.queryType,
  })), [{
    reference: "优化WebApp断网重试",
    queryType: "message",
  }]);

  const fullWidth = extractGitCommitReferences("风险条：【ABC1234】中文全角括号 【c249433】第二条");
  assert.equal(fullWidth.ok, true);
  assert.deepEqual(fullWidth.references.map((item) => item.reference), ["abc1234", "c249433"]);

  const mixed = extractGitCommitReferences([
    "[abcdef1] 第一条括号 revision，日期 20260724 不应被识别",
    "0123456789abcdef0123456789abcdef01234567 第二条裸完整 revision",
  ].join("\n"));
  assert.equal(mixed.ok, true);
  assert.deepEqual(mixed.references.map((item) => item.reference), [
    "abcdef1",
    "0123456789abcdef0123456789abcdef01234567",
  ]);

  const reviewDocument = extractGitCommitReferences([
    "1. 2387424a #CARB-13633# 【P162】【JIRA转载】SWIM-1570762【P1】",
    "评审说明里的纯数字问题号不能冒充 revision",
    "2. 5ddc0f90 #CARB-13634# 【P162】【JIRA转载】SWIM-1551759【P1】",
  ].join("\n"));
  assert.equal(reviewDocument.ok, true);
  assert.deepEqual(reviewDocument.references.map((item) => item.reference), [
    "2387424a",
    "5ddc0f90",
  ]);
});

test("单号/提交/分支/标题格式会聚合成一条评审记录并保留 rebase 搜索线索", () => {
  const parsed = extractGitCommitReferences([
    "单号：CARB-13851 · 【转载】【P166-G】【台架】【左舵】【必现】进入youtube后，将悬浮小球放在...",
    "提交：zlangit · 7/30 17:44 · 82f08ca",
    "分支：story/geely_p155_CARB_13851",
    "标题：#CARB-13851# #1.2.10# #geelyp155# 【转载】【P166-G】【台架】【左舵】【必现】进入youtube后，将悬浮小球放在.(2) #状态面板展开时补偿悬浮球位置并恢复#",
    "⚠ 问题 / 影响（3 项）",
    "1. 固定100ms单次快照且无重试",
  ].join("\n"));

  assert.equal(parsed.ok, true);
  assert.equal(parsed.references.length, 1);
  assert.equal(parsed.references[0].reference, "82f08ca");
  assert.equal(parsed.references[0].queryType, "revision");
  assert.deepEqual(parsed.references[0].ticketKeys, ["CARB-13851"]);
  assert.deepEqual(parsed.references[0].branchHints, ["story/geely_p155_CARB_13851"]);
  assert.equal(parsed.references[0].searchAlternatives, true);
  assert.ok(parsed.references[0].messageQueries.some((query) => (
    query.includes("状态面板展开时补偿悬浮球位置并恢复")
  )));
  assert.ok(parsed.references[0].messageQueries.some((query) => (
    query.startsWith("【转载】【P166-G】") && !query.endsWith("...")
  )));
  assert.match(parsed.references[0].excerpt, /固定100ms单次快照/);

  const ticketOnly = extractGitCommitReferences("CARB-13851");
  assert.equal(ticketOnly.ok, true);
  assert.deepEqual(ticketOnly.references[0].ticketKeys, ["CARB-13851"]);
  assert.equal(ticketOnly.references[0].searchAlternatives, true);

  const withoutRevision = extractGitCommitReferences([
    "单号：CARB-13851 · 【转载】【P166-G】进入youtube后悬浮球消失",
    "分支：story/geely_p155_CARB_13851",
    "标题：#CARB-13851# 修复悬浮球消失",
  ].join("\n"));
  assert.equal(withoutRevision.ok, true);
  assert.equal(withoutRevision.references[0].reference, "CARB-13851");
  assert.equal(withoutRevision.references[0].queryType, "ticket");

  const sameTicketDifferentRecords = extractGitCommitReferences([
    "单号：CARB-13851 · P155 悬浮球问题",
    "分支：story/geely_p155_CARB_13851",
    "标题：#CARB-13851# P155 修复",
    "",
    "单号：CARB-13851 · E22 悬浮球问题",
    "分支：story/geely_e22_CARB_13851",
    "标题：#CARB-13851# E22 修复",
  ].join("\n"));
  assert.equal(sameTicketDifferentRecords.ok, true);
  assert.equal(sameTicketDifferentRecords.references.length, 2);
  assert.equal(sameTicketDifferentRecords.references[1].duplicateOf, undefined);
});

test("批量解析只搜索已配置本地仓库并区分唯一命中、跨仓歧义和重复 commit", async (t) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "git-commit-batch-test-"));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const repoA = path.join(temp, "repo-a");
  const repoB = path.join(temp, "repo-b");
  fs.mkdirSync(repoA);
  const gitAt = (cwd, ...args) => execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    windowsHide: true,
  }).trim();
  gitAt(repoA, "init", "-q");
  gitAt(repoA, "config", "user.name", "Batch Test");
  gitAt(repoA, "config", "user.email", "batch@example.invalid");
  fs.writeFileSync(path.join(repoA, "base.txt"), "base\n", "utf8");
  gitAt(repoA, "add", "base.txt");
  gitAt(repoA, "commit", "-q", "-m", "shared base");
  const sharedRevision = gitAt(repoA, "rev-parse", "HEAD");
  gitAt(temp, "clone", "-q", repoA, repoB);
  gitAt(repoB, "config", "user.name", "Batch Test");
  gitAt(repoB, "config", "user.email", "batch@example.invalid");

  fs.writeFileSync(path.join(repoA, "only-a.txt"), "a\n", "utf8");
  gitAt(repoA, "add", "only-a.txt");
  gitAt(repoA, "commit", "-q", "-m", "only repository a");
  const revisionA = gitAt(repoA, "rev-parse", "HEAD");
  fs.writeFileSync(path.join(repoB, "only-b.txt"), "b\n", "utf8");
  gitAt(repoB, "add", "only-b.txt");
  gitAt(repoB, "commit", "-q", "-m", "only repository b");
  const revisionB = gitAt(repoB, "rev-parse", "HEAD");

  const resolved = await resolveGitCommitBatch({
    input: [
      `[${revisionA.slice(0, 7)}] repository a risk`,
      `[${revisionB.slice(0, 8)}] repository b risk`,
      `[${sharedRevision.slice(0, 9)}] shared history is ambiguous`,
      `[${revisionA.slice(0, 12)}] same full commit through a longer prefix`,
    ].join("\n"),
    repositories: [
      {
        id: "repo-a",
        name: "Repository A",
        displayUrl: "https://example.invalid/repo-a.git",
        localCandidates: [{ path: repoA, projectId: "local-a", name: "Local A" }],
      },
      {
        id: "repo-b",
        name: "Repository B",
        displayUrl: "https://example.invalid/repo-b.git",
        localCandidates: [{ path: repoB, projectId: "local-b", name: "Local B" }],
      },
    ],
  });
  assert.equal(resolved.ok, true);
  assert.deepEqual(
    resolved.data.items.map((item) => item.status),
    ["resolved", "resolved", "ambiguous", "duplicate"],
  );
  assert.equal(resolved.data.items[0].resolution.revision, revisionA);
  assert.equal(resolved.data.items[0].resolution.repositoryId, "repo-a");
  assert.equal(resolved.data.items[1].resolution.revision, revisionB);
  assert.equal(resolved.data.items[1].resolution.repositoryId, "repo-b");
  assert.deepEqual(
    resolved.data.items[2].candidates.map((candidate) => candidate.repositoryId).sort(),
    ["repo-a", "repo-b"],
  );
  assert.equal(resolved.data.items[3].duplicateOf, 0);
  assert.deepEqual(resolved.data.summary, {
    total: 4,
    resolved: 2,
    ambiguous: 1,
    notFound: 0,
    duplicate: 1,
    repositoriesSearched: 2,
  });

  const fragmentResolved = await resolveGitCommitBatch({
    input: revisionA.slice(10, 18),
    repositories: [
      {
        id: "repo-a",
        name: "Repository A",
        displayUrl: "https://example.invalid/repo-a.git",
        localCandidates: [{ path: repoA, projectId: "local-a", name: "Local A" }],
      },
      {
        id: "repo-b",
        name: "Repository B",
        displayUrl: "https://example.invalid/repo-b.git",
        localCandidates: [{ path: repoB, projectId: "local-b", name: "Local B" }],
      },
    ],
  });
  assert.equal(fragmentResolved.ok, true);
  assert.deepEqual(fragmentResolved.data.items.map((item) => item.status), ["resolved"]);
  assert.equal(fragmentResolved.data.items[0].resolution.revision, revisionA);
  assert.equal(fragmentResolved.data.items[0].resolution.matchKind, "revision_fragment");

  const messageResolved = await resolveGitCommitBatch({
    input: "only repository b",
    repositories: [
      {
        id: "repo-a",
        name: "Repository A",
        displayUrl: "https://example.invalid/repo-a.git",
        localCandidates: [{ path: repoA, projectId: "local-a", name: "Local A" }],
      },
      {
        id: "repo-b",
        name: "Repository B",
        displayUrl: "https://example.invalid/repo-b.git",
        localCandidates: [{ path: repoB, projectId: "local-b", name: "Local B" }],
      },
    ],
  });
  assert.equal(messageResolved.ok, true);
  assert.deepEqual(messageResolved.data.items.map((item) => item.status), ["resolved"]);
  assert.equal(messageResolved.data.items[0].resolution.revision, revisionB);
  assert.equal(messageResolved.data.items[0].resolution.matchKind, "message");
});

test("本地历史未同步时按工单号和分支搜索远端 rebase 候选并要求人工选择", async (t) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "git-commit-remote-batch-test-"));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const remoteWork = path.join(temp, "remote-work");
  const staleCheckout = path.join(temp, "stale-checkout");
  fs.mkdirSync(remoteWork);
  const gitAt = (cwd, ...args) => execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    windowsHide: true,
  }).trim();

  gitAt(remoteWork, "init", "-q");
  gitAt(remoteWork, "config", "user.name", "Remote Batch Test");
  gitAt(remoteWork, "config", "user.email", "remote-batch@example.invalid");
  fs.writeFileSync(path.join(remoteWork, "base.txt"), "base\n", "utf8");
  gitAt(remoteWork, "add", "base.txt");
  gitAt(remoteWork, "commit", "-q", "-m", "shared base");
  const baseBranch = gitAt(remoteWork, "branch", "--show-current");
  gitAt(temp, "clone", "-q", remoteWork, staleCheckout);

  gitAt(remoteWork, "switch", "-q", "-c", "story/geely_p155_CARB_13851");
  fs.writeFileSync(path.join(remoteWork, "FloatingBallView.kt"), "p155\n", "utf8");
  gitAt(remoteWork, "add", "FloatingBallView.kt");
  gitAt(
    remoteWork,
    "commit",
    "-q",
    "-m",
    "#CARB-13851# #1.2.10# #geelyp155# 【转载】【P166-G】【台架】【左舵】【必现】进入youtube后，将悬浮小球放在.(2) #状态面板展开时补偿悬浮球位置并恢复#",
  );
  const p155Revision = gitAt(remoteWork, "rev-parse", "HEAD");

  gitAt(remoteWork, "switch", "-q", baseBranch);
  gitAt(remoteWork, "switch", "-q", "-c", "story/geely_e22_CARB_13851");
  fs.writeFileSync(path.join(remoteWork, "FloatingBallView.kt"), "e22\n", "utf8");
  gitAt(remoteWork, "add", "FloatingBallView.kt");
  gitAt(
    remoteWork,
    "commit",
    "-q",
    "-m",
    "#CARB-13851# 【转载】【P166-G】【台架】【左舵】【必现】进入youtube后，将悬浮小球放在.(2)",
  );
  const e22Revision = gitAt(remoteWork, "rev-parse", "HEAD");

  const input = [
    "单号：CARB-13851 · 【转载】【P166-G】【台架】【左舵】【必现】进入youtube后，将悬浮小球放在...",
    `提交：zlangit · 7/30 17:44 · ${p155Revision.slice(0, 7)}`,
    "分支：story/geely_p155_CARB_13851",
    "标题：#CARB-13851# #1.2.10# #geelyp155# 【转载】【P166-G】【台架】【左舵】【必现】进入youtube后，将悬浮小球放在.(2) #状态面板展开时补偿悬浮球位置并恢复#",
  ].join("\n");
  const resolved = await resolveGitCommitBatch({
    input,
    repositories: [{
      id: "webApp",
      name: "WebApp",
      remoteUrl: remoteWork,
      displayUrl: "https://example.invalid/WebApp.git",
      localCandidates: [{
        path: staleCheckout,
        projectId: "local-webapp",
        name: "Stale WebApp",
        role: "webapp",
      }],
    }],
  });

  assert.equal(resolved.ok, true);
  assert.equal(resolved.data.items.length, 1);
  assert.equal(resolved.data.items[0].status, "ambiguous");
  assert.deepEqual(
    resolved.data.items[0].candidates.map((candidate) => candidate.revision).sort(),
    [p155Revision, e22Revision].sort(),
  );
  const p155 = resolved.data.items[0].candidates.find((candidate) => (
    candidate.revision === p155Revision
  ));
  const e22 = resolved.data.items[0].candidates.find((candidate) => (
    candidate.revision === e22Revision
  ));
  assert.ok(p155.matchKinds.includes("remote_revision"));
  assert.ok(p155.matchKinds.includes("remote_branch"));
  assert.ok(p155.matchKinds.includes("remote_ticket"));
  assert.ok(p155.matchKinds.includes("message"));
  assert.ok(e22.matchKinds.includes("remote_ticket"));
  assert.ok(e22.matchKinds.includes("ticket"));
  assert.equal(p155.stats.files, 1);
  assert.equal(e22.stats.files, 1);
  assert.match(resolved.data.items[0].error, /明确选择/);
});

test("本地 Git commit 检查读取元数据、包含分支和改动统计且不切换分支", async (t) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "git-commit-story-test-"));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const git = (...args) => execFileSync("git", args, { cwd: temp, encoding: "utf8", windowsHide: true });
  git("init", "-q");
  git("config", "user.name", "Codex Test");
  git("config", "user.email", "codex-test@example.invalid");
  fs.writeFileSync(path.join(temp, "Main.kt"), "fun main() = println(\"review\")\n", "utf8");
  git("add", "Main.kt");
  git("commit", "-q", "-m", "新增静态检查入口");
  const revision = git("rev-parse", "HEAD").trim();
  const beforeBranch = git("branch", "--show-current").trim();

  const result = await inspectGitCommit({
    revision,
    remoteUrl: "",
    localCandidates: [{ path: temp, projectId: "local-project", name: "fixture" }],
  });
  assert.equal(result.ok, true);
  assert.equal(result.commit.revision, revision);
  assert.equal(result.commit.subject, "新增静态检查入口");
  assert.equal(result.commit.source.projectId, "local-project");
  assert.ok(result.commit.branches.includes(beforeBranch));
  assert.equal(result.commit.changedFiles[0].path, "Main.kt");
  assert.equal(result.commit.stats.files, 1);
  assert.equal(git("branch", "--show-current").trim(), beforeBranch);
  assert.match(buildGitReviewTitle(result.commit), new RegExp(result.commit.shortRevision));
});

test("远端分支已前移但本地 tracking ref 陈旧时不会冒充远端最新代码", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "git-commit-latest-branch-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, "source");
  const writer = path.join(root, "writer");
  const remote = path.join(root, "remote.git");
  fs.mkdirSync(source);
  fs.mkdirSync(remote);
  const git = (cwd, ...args) => execFileSync(
    "git",
    ["-C", cwd, ...args],
    { encoding: "utf8", windowsHide: true },
  ).trim();

  git(remote, "init", "--bare");
  git(source, "init");
  git(source, "config", "user.name", "Latest Branch Source");
  git(source, "config", "user.email", "latest-source@example.invalid");
  fs.writeFileSync(path.join(source, "Risk.kt"), "fun risky() = error(\"old issue\")\n", "utf8");
  git(source, "add", "Risk.kt");
  git(source, "commit", "-m", "引入待评审问题");
  git(source, "branch", "-M", "feature/review");
  const reviewedRevision = git(source, "rev-parse", "HEAD");
  git(source, "remote", "add", "origin", remote);
  git(source, "push", "-u", "origin", "feature/review");
  const sourceStatus = git(source, "status", "--porcelain");

  execFileSync("git", ["clone", remote, writer], { encoding: "utf8", windowsHide: true });
  git(writer, "config", "user.name", "Latest Branch Writer");
  git(writer, "config", "user.email", "latest-writer@example.invalid");
  git(writer, "checkout", "-b", "feature/review", "origin/feature/review");
  fs.writeFileSync(path.join(writer, "Risk.kt"), "fun risky() = Unit\n", "utf8");
  git(writer, "add", "Risk.kt");
  git(writer, "commit", "-m", "后续提交修复评审问题");
  git(writer, "push", "origin", "feature/review");
  const remoteLatestRevision = git(writer, "rev-parse", "HEAD");

  const comparison = await inspectGitCommitLatestBranch({
    repositoryPath: source,
    reviewContext: {
      revision: reviewedRevision,
      branches: ["feature/review", "origin/feature/review"],
      inference: {
        branch: "origin/feature/review",
        branchCandidates: ["feature/review", "origin/feature/review"],
      },
    },
  });
  assert.equal(comparison.ok, true);
  assert.equal(comparison.status, "remote_tip_not_local");
  assert.equal(comparison.branch, "feature/review");
  assert.equal(comparison.localTip, reviewedRevision);
  assert.equal(comparison.remoteTip, remoteLatestRevision);
  assert.equal(comparison.comparisonTip, "");
  assert.equal(comparison.comparisonReady, false);
  assert.equal(comparison.revisionIsAncestor, null);
  assert.equal(comparison.aheadCount, null);
  assert.match(comparison.error, /独立临时仓库/);
  assert.equal(git(source, "rev-parse", "HEAD"), reviewedRevision);
  assert.equal(git(source, "branch", "--show-current"), "feature/review");
  assert.equal(git(source, "status", "--porcelain"), sourceStatus);
  assert.equal(
    git(source, "rev-parse", "refs/remotes/origin/feature/review"),
    reviewedRevision,
    "只读远端核对不得 fetch 或改写本地 tracking ref",
  );

  git(source, "branch", "release/review", reviewedRevision);
  const ambiguous = await inspectGitCommitLatestBranch({
    repositoryPath: source,
    reviewContext: {
      revision: reviewedRevision,
      branches: ["feature/review", "release/review"],
      inference: {
        branch: "feature/review",
        branchCandidates: ["feature/review", "release/review"],
      },
    },
  });
  assert.equal(ambiguous.ok, false);
  assert.equal(ambiguous.status, "branch_ambiguous");
  assert.equal(ambiguous.comparisonReady, false);
  assert.equal(ambiguous.remoteChecked, false);
  assert.deepEqual(ambiguous.branchCandidates, ["feature/review", "release/review"]);
  assert.match(ambiguous.error, /多个候选分支/);
  git(source, "branch", "-D", "release/review");

  const offlineRemote = path.join(root, "remote-offline.git");
  fs.renameSync(remote, offlineRemote);
  const fallback = await inspectGitCommitLatestBranch({
    repositoryPath: source,
    reviewContext: {
      revision: reviewedRevision,
      branches: ["origin/feature/review"],
      inference: { branch: "origin/feature/review" },
    },
  });
  assert.equal(fallback.ok, true);
  assert.equal(fallback.status, "remote_unavailable_local_only");
  assert.equal(fallback.remoteTip, "");
  assert.equal(fallback.comparisonTip, reviewedRevision);
  assert.equal(fallback.comparisonReady, false);
  assert.match(fallback.error, /does not appear to be a git repository|无法读取|不存在/i);
  assert.equal(git(source, "status", "--porcelain"), sourceStatus);
});
