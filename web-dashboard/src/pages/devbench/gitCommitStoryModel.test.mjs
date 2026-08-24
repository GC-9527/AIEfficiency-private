import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildGitCommitBatchCreateRequests,
  buildGitCommitInferenceTicket,
  buildGitCommitStoryConfirmation,
  buildGitCommitReviewPrompt,
  buildGitCommitStoryRequest,
  filterGitRepositories,
  gitCommitBatchCandidateKey,
  seedGitCommitInferenceSession,
  gitCommitLatestBranchNotice,
  nextGitCommitBatchRequest,
  resolveGitCommitInferenceProjectId,
  resolveGitRepositoryInput,
  validateGitCommitRevision,
} from "./gitCommitStoryModel.mjs";

test("Git 单源推理在没有 TB 项目时使用仓库隔离域", () => {
  assert.equal(resolveGitCommitInferenceProjectId("tb-project-a", "appMarket"), "tb-project-a");
  assert.equal(resolveGitCommitInferenceProjectId("", "appMarket"), "git-repository:appMarket");
  assert.equal(resolveGitCommitInferenceProjectId("", ""), "");
});

test("Git 批量队列每次明确移除当前项，已有首项也不会重复循环", () => {
  const first = { body: { revision: "abcdef1" } };
  const second = { body: { revision: "abcdef2" } };
  const step1 = nextGitCommitBatchRequest([first, second]);
  assert.equal(step1.current, first);
  assert.deepEqual(step1.remaining, [second]);
  const step2 = nextGitCommitBatchRequest(step1.remaining);
  assert.equal(step2.current, second);
  assert.deepEqual(step2.remaining, []);
  assert.deepEqual(nextGitCommitBatchRequest([]), { current: null, remaining: [] });
});

const projectDefs = [
  {
    id: "appMarket",
    name: "应用市场",
    https: "https://code.example/x/AppMarket",
    ssh: "git@code.example:x/AppMarket.git",
    projectType: "application",
  },
  {
    id: "webApp",
    name: "WebApp",
    https: "https://code.example/x/WebApp",
    ssh: "git@code.example:x/WebApp.git",
    projectType: "application",
  },
];

test("Git commit 面板校验短 SHA 与完整 SHA", () => {
  assert.equal(validateGitCommitRevision("abc123").ok, false);
  assert.deepEqual(validateGitCommitRevision("A1B2C3D"), {
    ok: true,
    revision: "a1b2c3d",
    preview: "a1b2c3d",
  });
  assert.equal(validateGitCommitRevision("f".repeat(40)).ok, true);
  assert.match(validateGitCommitRevision("main").error, /十六进制/);
});

test("仓库组合输入支持按名称、ID、HTTPS 和 SSH 检索与精确输入", () => {
  assert.deepEqual(filterGitRepositories(projectDefs, "web").map((row) => row.id), ["webApp"]);
  assert.deepEqual(filterGitRepositories(projectDefs, "git@code.example:x/appmarket").map((row) => row.id), ["appMarket"]);
  assert.equal(resolveGitRepositoryInput(projectDefs, "应用市场").repository.id, "appMarket");
  assert.equal(resolveGitRepositoryInput(projectDefs, "https://code.example/x/WebApp").repository.id, "webApp");
  assert.match(resolveGitRepositoryInput(projectDefs, "https://unknown/repo").error, /未匹配/);
});

test("创建请求固定使用选择的逻辑仓库并保留当前 TB 项目隔离键", () => {
  assert.deepEqual(buildGitCommitStoryRequest({
    revision: "ABCDEF1",
    repositoryValue: "git@code.example:x/AppMarket.git",
    selectedRepositoryId: "appMarket",
    projectDefs,
    projectId: "tb-project-a",
  }), {
    ok: true,
    body: {
      revision: "abcdef1",
      repositoryId: "appMarket",
      repositoryUrl: "https://code.example/x/AppMarket",
      projectId: "tb-project-a",
    },
  });
});

test("commit 预览确认必须显式选择本地工程或远程拉取", () => {
  const requestBody = {
    revision: "abcdef1",
    repositoryId: "appMarket",
    repositoryUrl: "https://code.example/x/AppMarket",
  };
  assert.match(buildGitCommitStoryConfirmation({ requestBody }).error, /本地工程或远程拉取/);
  assert.deepEqual(buildGitCommitStoryConfirmation({
    requestBody,
    sourceMode: "local",
    localSource: {
      projectId: "local-market",
      role: "primary",
    },
  }), {
    ok: true,
    body: {
      ...requestBody,
      configurationConfirmed: true,
      configuration: {
        mode: "local",
        localProjectId: "local-market",
        localRole: "primary",
      },
    },
  });
  assert.deepEqual(buildGitCommitStoryConfirmation({
    requestBody,
    sourceMode: "remote",
  }).body.configuration, {
    mode: "remote",
  });
});

test("Git commit 预览会转换成 AI 配置推理工单并预选用户指定的本地工程", () => {
  const ticket = buildGitCommitInferenceTicket({
    commit: {
      revision: "a".repeat(40),
      shortRevision: "aaaaaaa",
      subject: "修复应用市场配置",
      branches: ["release/appmarket"],
      changedFiles: [{ path: "app/src/Main.kt" }],
    },
    remote: {
      repositoryId: "appMarket",
      repositoryName: "应用市场",
    },
  }, "tb-project", "复核跨 Flavor 影响");
  assert.equal(ticket.ticketId, `git:${"a".repeat(40)}`);
  assert.equal(ticket.projectId, "tb-project");
  assert.match(ticket.title, /修复应用市场配置/);
  assert.match(ticket.description, /app\/src\/Main\.kt/);
  assert.match(ticket.description, /跨 Flavor/);

  const seeded = seedGitCommitInferenceSession({
    id: "CI_git",
    prediction: {
      targets: [{
        targetId: "market",
        repositoryId: "appMarket",
        branch: "release/appmarket",
        targetRole: "primary",
      }],
    },
    localResolution: {
      complete: false,
      targets: [{
        targetId: "market",
        repositoryId: "appMarket",
        branch: "release/appmarket",
        selectionRequired: true,
        selectedProjectId: "",
        matchKind: "ambiguous",
        resolved: false,
      }],
      projects: [{ id: "local-market", name: "本地应用市场" }],
    },
  }, {
    mode: "local",
    localProjectId: "local-market",
  }, "appMarket");
  assert.deepEqual(seeded.bindings, [{
    targetId: "market",
    repositoryId: "appMarket",
    branch: "release/appmarket",
    projectId: "local-market",
  }]);
  assert.equal(seeded.session.localResolution.complete, true);
  assert.equal(seeded.session.localResolution.targets[0].matchKind, "user_selected");
  assert.equal(seeded.session.localResolution.targets[0].selectedProjectId, "local-market");

  const remoteSeeded = seedGitCommitInferenceSession(seeded.session, { mode: "remote" }, "appMarket");
  assert.deepEqual(remoteSeeded.bindings[0], {
    targetId: "market",
    repositoryId: "appMarket",
    branch: "release/appmarket",
    useRemote: true,
  });
  assert.equal(remoteSeeded.session.localResolution.targets[0].matchKind, "remote_selected");
});

test("开始评审提示固定为只读代码审查并强制复核对应分支最新代码", () => {
  const prompt = buildGitCommitReviewPrompt({
    revision: "abcdef1234567890",
    shortRevision: "abcdef123456",
  });
  assert.match(prompt, /abcdef123456/);
  assert.match(prompt, /真实 diff/);
  assert.match(prompt, /对应分支的最新代码/);
  assert.match(prompt, /实际比较的分支 ref 与最新 tip SHA/);
  assert.match(prompt, /已在对应分支最新代码修复/);
  assert.match(prompt, /修复提交/);
  assert.match(prompt, /无法验证最新分支/);
  assert.match(prompt, /静态检查/);
  assert.match(prompt, /其它 Flavor/);
  assert.match(prompt, /合入目标分支/);
  assert.match(prompt, /不要修改代码/);
});

test("最新分支刷新提示区分临时仓、历史分叉、分支歧义和远端不可用", () => {
  assert.equal(
    gitCommitLatestBranchNotice({ status: "remote_verified", comparisonReady: true }),
    null,
  );
  assert.match(
    gitCommitLatestBranchNotice({ status: "remote_tip_not_local" }).message,
    /独立临时仓库.*精确 SHA/,
  );
  assert.match(
    gitCommitLatestBranchNotice({ status: "remote_history_mismatch" }).message,
    /快照对比.*不能声称.*线性修复/,
  );
  assert.match(
    gitCommitLatestBranchNotice({ status: "branch_ambiguous" }).message,
    /多个分支.*无法验证最新分支/,
  );
  assert.match(
    gitCommitLatestBranchNotice({ status: "remote_unavailable_local_only" }).message,
    /权威远端最新代码未验证成功.*不得把本地分支当成最新代码/,
  );
});

test("批量创建计划要求消除多仓歧义、跳过重复项并携带风险假设", () => {
  const appCandidate = {
    repositoryId: "appMarket",
    repositoryUrl: "https://code.example/x/AppMarket",
    revision: "a".repeat(40),
    sourceProjectId: "local-market",
  };
  const webCandidate = {
    repositoryId: "webApp",
    repositoryUrl: "https://code.example/x/WebApp",
    revision: "b".repeat(40),
    sourceProjectId: "local-web",
    sourceRole: "webapp",
  };
  const items = [
    {
      inputIndex: 0,
      reference: "aaaaaaa",
      excerpt: "[aaaaaaa] 目标 Flavor 可能回归",
      status: "resolved",
      resolution: appCandidate,
    },
    {
      inputIndex: 1,
      reference: "bbbbbbb",
      excerpt: "[bbbbbbb] 公共接口风险",
      status: "ambiguous",
      candidates: [webCandidate, { ...appCandidate, revision: "c".repeat(40) }],
    },
    {
      inputIndex: 2,
      reference: "aaaaaaa",
      status: "duplicate",
      duplicateOf: 0,
    },
    {
      inputIndex: 3,
      reference: "ddddddd",
      status: "not_found",
      error: "未在本地历史中找到",
    },
  ];

  const blocked = buildGitCommitBatchCreateRequests({
    items,
    selections: {
      1: gitCommitBatchCandidateKey(webCandidate),
    },
    projectId: "tb-project-a",
    sourceMode: "local",
  });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.unresolved.length, 1);
  assert.equal(blocked.requests.length, 2);

  const ready = buildGitCommitBatchCreateRequests({
    items: items.slice(0, 3),
    selections: {
      1: gitCommitBatchCandidateKey(webCandidate),
    },
    projectId: "tb-project-a",
    sourceMode: "local",
  });
  assert.equal(ready.ok, true);
  assert.deepEqual(ready.requests.map((row) => row.key), [
    `appMarket:${"a".repeat(40)}`,
    `webApp:${"b".repeat(40)}`,
  ]);
  assert.equal(ready.requests[0].body.reviewHint, "[aaaaaaa] 目标 Flavor 可能回归");
  assert.equal(ready.requests[0].body.projectId, "tb-project-a");

  const retry = buildGitCommitBatchCreateRequests({
    items: items.slice(0, 3),
    selections: {
      1: gitCommitBatchCandidateKey(webCandidate),
    },
    completedKeys: [ready.requests[0].key],
    sourceMode: "local",
  });
  assert.equal(retry.ok, true);
  assert.deepEqual(retry.requests.map((row) => row.key), [ready.requests[1].key]);
  assert.deepEqual(ready.requests[0].body.configuration, {
    mode: "local",
    localProjectId: "local-market",
    localRole: "primary",
  });
  assert.deepEqual(ready.requests[1].body.configuration, {
    mode: "local",
    localProjectId: "local-web",
    localRole: "webapp",
  });

  const remoteCandidate = {
    repositoryId: "webApp",
    repositoryUrl: "https://code.example/x/WebApp",
    revision: "d".repeat(40),
    matchKinds: ["remote_ticket", "ticket", "message"],
  };
  const remoteReady = buildGitCommitBatchCreateRequests({
    items: [{
      inputIndex: 0,
      reference: "CARB-13851",
      excerpt: "单号：CARB-13851 · 悬浮球问题",
      status: "resolved",
      resolution: remoteCandidate,
    }],
    sourceMode: "remote",
  });
  assert.equal(remoteReady.ok, true);
  assert.equal(remoteReady.requests[0].body.revision, remoteCandidate.revision);
  assert.deepEqual(remoteReady.requests[0].body.configuration, { mode: "remote" });
});
