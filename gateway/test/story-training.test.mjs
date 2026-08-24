import { before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { routeStoryPointTicket, validateStoryTrainingTargets } from "../services/devbench/story-training.js";
import { bootGateway, waitHealth } from "./_helpers.mjs";

const PROJECT_DEFS = [
  { id: "appMarket", name: "应用市场" },
  { id: "webApp", name: "WebApp" },
];

const VEHICLE_MAP = {
  avatr8678: {
    apps: [{
      appName: "应用市场",
      repos: [
        { repoId: "appMarket", branch: "release/avatr", flavor: "avatr8678" },
        { repoId: "webApp", branch: "release/web-avatr", flavor: "avatr8678" },
      ],
    }],
  },
};

test("故事点路由：车型注册项可产生多个变更目标，且仓库严格受候选集约束", () => {
  const result = routeStoryPointTicket({
    ticket: { ticketId: "CARB-1", title: "avatr8678 应用市场页面异常", environment: "test", buildType: "release" },
    projectDefs: PROJECT_DEFS,
    vehicleMap: VEHICLE_MAP,
    buildLineage: [{ repositoryId: "inventedRepo", buildNumber: "991", branch: "bad", vehicle: "avatr8678" }],
  });

  assert.equal(result.status, "NEED_HUMAN_CONFIRMATION");
  assert.deepEqual(result.changeTargets.map((target) => target.repositoryId).sort(), ["appMarket", "webApp"]);
  assert.equal(result.changeTargets.some((target) => target.repositoryId === "inventedRepo"), false);
  assert.equal(result.policy.candidateConstrained, true);
  assert.equal(result.policy.canExecute, false);
  assert.equal(result.policy.automationLevel, "L0_SHADOW");
});

test("故事点路由：非法环境和 buildType 不得进入自动候选", () => {
  const result = routeStoryPointTicket({
    ticket: { title: "avatr8678 应用市场异常", environment: "qa", buildType: "profile" },
    projectDefs: PROJECT_DEFS,
    vehicleMap: VEHICLE_MAP,
  });
  const target = result.changeTargets.find((item) => item.repositoryId === "appMarket");
  assert.ok(target);
  assert.equal(target.variant.environment, "");
  assert.equal(target.variant.buildType, "");
  assert.ok(result.missingInformation.includes("缺少环境维度"));
  assert.ok(result.missingInformation.includes("缺少 buildType"));
});

test("故事点路由：构建血缘硬证据补充复现分支，但不覆盖车型映射的目标分支", () => {
  const result = routeStoryPointTicket({
    ticket: { title: "avatr8678 启动失败", logs: "Jenkins build 8821 commit abcdef1234" },
    projectDefs: PROJECT_DEFS,
    vehicleMap: VEHICLE_MAP,
    buildLineage: [{
      id: "BL-1",
      repositoryId: "appMarket",
      buildNumber: "8821",
      commitSha: "abcdef1234",
      branch: "repro/nightly-8821",
      vehicle: "avatr8678",
      environment: "test",
      buildType: "release",
    }],
  });

  const target = result.changeTargets.find((item) => item.repositoryId === "appMarket");
  assert.ok(target);
  assert.equal(target.baseBranch, "release/avatr");
  assert.equal(target.reproductionBranch, "repro/nightly-8821");
  assert.equal(target.variant.vehicle, "avatr8678");
  assert.ok(result.evidence.some((item) => item.tier === "hard" && item.field === "commitSha"));
  assert.ok(target.confidence > 0.8);
});

test("故事点路由：仅命中构建源分支时不得把复现分支写成目标分支", () => {
  const result = routeStoryPointTicket({
    ticket: { title: "repro/nightly-99 分支上的偶现问题" },
    projectDefs: PROJECT_DEFS,
    vehicleMap: {},
    buildLineage: [{
      id: "BL-branch",
      repositoryId: "appMarket",
      branch: "repro/nightly-99",
      vehicle: "avatr8678",
    }],
  });

  const target = result.changeTargets[0];
  assert.ok(target);
  assert.equal(target.baseBranch, "");
  assert.equal(target.reproductionBranch, "repro/nightly-99");
  assert.ok(result.missingInformation.includes("缺少变更目标分支"));
});

test("故事点路由：无候选证据时主动要求补充信息", () => {
  const result = routeStoryPointTicket({
    ticket: { title: "偶现异常，无更多信息" },
    projectDefs: PROJECT_DEFS,
    vehicleMap: VEHICLE_MAP,
  });

  assert.equal(result.status, "NEED_MORE_INFO");
  assert.deepEqual(result.changeTargets, []);
  assert.ok(result.missingInformation.includes("未命中工程注册表中的候选仓库"));
});

test("故事点路由：Gold Dataset 仅作为软证据且仍受工程注册表约束", () => {
  const result = routeStoryPointTicket({
    ticket: { title: "搜索页白屏", tags: ["搜索"] },
    projectDefs: PROJECT_DEFS,
    vehicleMap: VEHICLE_MAP,
    goldCases: [{
      id: "GC-1",
      ticket: { ticketId: "CARB-OLD", title: "搜索页白屏", tags: ["搜索"] },
      actual: { changeTargets: [
        { repositoryId: "webApp", baseBranch: "release/web-avatr", variant: { vehicle: "avatr8678", environment: "prod", buildType: "release" } },
        { repositoryId: "notRegistered", baseBranch: "main", variant: { vehicle: "x" } },
      ] },
    }],
  });

  assert.deepEqual(result.changeTargets.map((target) => target.repositoryId), ["webApp"]);
  assert.ok(result.evidence.some((item) => item.tier === "soft" && item.source === "gold_dataset"));
});

test("故事点目标约束：拒绝未登记目标组合、非法 variant 和无血缘复现分支", () => {
  const base = {
    projectDefs: PROJECT_DEFS,
    vehicleMap: VEHICLE_MAP,
    buildLineage: [{ repositoryId: "appMarket", branch: "repro/nightly-1" }],
  };
  assert.equal(validateStoryTrainingTargets([{
    repositoryId: "appMarket",
    baseBranch: "release/avatr",
    reproductionBranch: "repro/nightly-1",
    variant: { vehicle: "avatr8678", environment: "test", buildType: "release" },
  }], base).ok, true);
  assert.match(validateStoryTrainingTargets([{
    repositoryId: "appMarket",
    baseBranch: "repro/nightly-1",
    variant: { vehicle: "avatr8678", environment: "test", buildType: "release" },
  }], base).error, /未在工程注册表中登记/);
  assert.match(validateStoryTrainingTargets([{
    repositoryId: "appMarket",
    baseBranch: "release\/avatr",
    variant: { vehicle: "avatr8678", environment: "qa", buildType: "release" },
  }], base).error, /环境仅允许/);
  assert.match(validateStoryTrainingTargets([{
    repositoryId: "appMarket",
    baseBranch: "release\/avatr",
    variant: { vehicle: "avatr8678", environment: "test", buildType: "profile" },
  }], base).error, /buildType 仅允许/);
  assert.match(validateStoryTrainingTargets([{
    repositoryId: "appMarket",
    baseBranch: "release\/avatr",
    reproductionBranch: "repro/not-recorded",
    variant: { vehicle: "avatr8678", environment: "test", buildType: "release" },
  }], base).error, /复现分支必须来自/);
});

test("故事点路由：历史回放不得使用工单快照之后产生的 Gold 样本", () => {
  const result = routeStoryPointTicket({
    ticket: { title: "搜索页白屏", tags: ["搜索"], snapshotAt: "2026-01-01T00:00:00.000Z" },
    projectDefs: PROJECT_DEFS,
    vehicleMap: VEHICLE_MAP,
    goldCases: [{
      id: "GC-FUTURE",
      snapshotAt: "2026-02-01T00:00:00.000Z",
      ticket: { title: "搜索页白屏", tags: ["搜索"] },
      actual: { changeTargets: [{ repositoryId: "webApp", baseBranch: "release/web-avatr", variant: { vehicle: "avatr8678", environment: "test", buildType: "release" } }] },
    }],
  });

  assert.equal(result.status, "NEED_MORE_INFO");
  assert.deepEqual(result.changeTargets, []);
  assert.equal(result.evidence.some((item) => item.source === "gold_dataset"), false);
});

test("故事点路由：Gold 标签可用与创建时间晚于回放快照时不得泄漏", () => {
  const result = routeStoryPointTicket({
    ticket: { title: "搜索页白屏", tags: ["搜索"], snapshotAt: "2026-01-15T00:00:00.000Z" },
    projectDefs: PROJECT_DEFS,
    vehicleMap: VEHICLE_MAP,
    goldCases: [{
      id: "GC-LABEL-FUTURE",
      snapshotAt: "2026-01-01T00:00:00.000Z",
      availableAt: "2026-02-01T00:00:00.000Z",
      createdAt: Date.parse("2026-02-01T00:00:00.000Z"),
      ticket: { title: "搜索页白屏", tags: ["搜索"] },
      actual: { changeTargets: [{ repositoryId: "webApp", baseBranch: "release/web-avatr", variant: { vehicle: "avatr8678", environment: "test", buildType: "release" } }] },
    }],
  });

  assert.equal(result.status, "NEED_MORE_INFO");
  assert.equal(result.evidence.some((item) => item.source === "gold_dataset"), false);
});

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "story-training-"));
const market = path.join(tmp, "market.json");
process.env.DEVBENCH_CONFIG_PATH = market;
process.env.AIEFFICIENCY_CLONE_PARENT = path.join(tmp, "clone-parent");
process.env.DEVBENCH_STORE_DIR = path.join(tmp, "store");
process.env.GATEWAY_CONFIG_PATH = path.join(tmp, "gateway.json");
process.env.GATEWAY_DB_PATH = path.join(tmp, "data.db");
fs.writeFileSync(process.env.GATEWAY_CONFIG_PATH, JSON.stringify({ teambition: { projects: [{ id: "project-a", name: "Project A" }] } }), "utf8");

let store;
let db;
before(async () => {
  store = await import("../services/devbench/store.js");
  db = await import("../db/sqlite.js");
});

beforeEach(() => {
  fs.writeFileSync(market, "{}", "utf8");
  db.setUserData("__devbench_shared__", "shared", { byProject: {}, dingtalkMsgConfig: null, _sharedVersion: 1 }, "test");
});

test("故事点训练存储：构建血缘、Dry-run、人工复核和 Gold 样本形成闭环", () => {
  const lineage = store.upsertStoryPointTrainingBuildLineage("project-a", {
    repositoryId: "appMarket",
    buildNumber: "7788",
    commitSha: "abc7788def",
    branch: "repro/build-7788",
    vehicle: "avatr8678",
    environment: "test",
    buildType: "release",
    source: "Jenkins/app-market/7788",
  });
  assert.equal(lineage.ok, true);

  const dryRun = store.runStoryPointTrainingDryRun("project-a", {
    ticket: { ticketId: "CARB-7788", title: "avatr8678 启动失败", logs: "build 7788 commit abc7788def" },
  });
  assert.equal(dryRun.ok, true);
  assert.equal(dryRun.data.prediction.status, "NEED_HUMAN_CONFIRMATION");
  assert.ok(dryRun.data.prediction.changeTargets.some((target) => target.repositoryId === "appMarket"));

  const rejectedReview = store.reviewStoryPointTrainingDryRun("project-a", dryRun.data.id, {
    decision: "corrected",
    correctedPrediction: {
      changeTargets: [{
        repositoryId: "appMarket",
        baseBranch: "repro/build-7788",
        variant: { vehicle: "avatr8678", environment: "test", buildType: "release" },
      }],
    },
  });
  assert.equal(rejectedReview.ok, false);
  assert.match(rejectedReview.error, /未在工程注册表中登记/);

  const reviewed = store.reviewStoryPointTrainingDryRun("project-a", dryRun.data.id, {
    decision: "correct",
    reviewer: "tester",
    reason: "构建血缘与车型映射一致",
    saveAsGold: true,
  });
  assert.equal(reviewed.ok, true);
  assert.ok(reviewed.goldCase?.id);
  assert.equal(reviewed.goldCase.availableAt, reviewed.data.review.reviewedAt);
  assert.equal(reviewed.goldCase.versions.router, dryRun.data.versions.router);
  assert.equal(reviewed.goldCase.versions.registry, dryRun.data.versions.registry);

  assert.equal(store.deleteStoryPointTrainingItem("project-a", "buildLineage", lineage.data.id).ok, true);
  const staleExecution = store.createStoryPointTrainingExecutionPlan("project-a", dryRun.data.id, { mode: "PLAN_ONLY" });
  assert.equal(staleExecution.ok, false);
  assert.match(staleExecution.error, /复现分支必须来自/);
  assert.equal(store.upsertStoryPointTrainingBuildLineage("project-a", { ...lineage.data, id: lineage.data.id }).ok, true);

  const execution = store.createStoryPointTrainingExecutionPlan("project-a", dryRun.data.id, {
    mode: "PLAN_ONLY",
    requestedBy: "tester",
  });
  assert.equal(execution.ok, true);
  assert.equal(execution.executionPacket.status, "PLAN_READY");
  assert.equal(execution.executionPacket.guardrails.agentStarted, false);
  assert.equal(execution.executionPacket.guardrails.autoCommit, false);
  assert.equal(execution.executionPacket.guardrails.autoPush, false);
  assert.equal(execution.executionPacket.guardrails.autoMerge, false);
  assert.equal(execution.executionPacket.allowedTargets[0].reproductionBranch, "repro/build-7788");

  const overview = store.getStoryPointTrainingData("project-a");
  assert.equal(overview.buildLineage.length, 1);
  assert.equal(overview.goldCases.length, 1);
  assert.equal(overview.dryRuns.length, 1);
  assert.equal(overview.metrics.pendingReviews, 0);
  assert.equal(overview.metrics.readyExecutionPackets, 1);
  assert.equal(overview.metrics.allCorrectRate, 1);
  assert.equal(overview.settings.automationLevel, "L0_SHADOW");
});

test("故事点训练存储：Gold 和血缘写入拒绝未登记 variant", () => {
  const badLineage = store.upsertStoryPointTrainingBuildLineage("project-a", {
    repositoryId: "appMarket",
    buildNumber: "bad-1",
    vehicle: "unknown-car",
  });
  assert.equal(badLineage.ok, false);
  assert.match(badLineage.error, /车型必须来自工程注册表/);

  const badGold = store.upsertStoryPointTrainingGoldCase("project-a", {
    ticket: { ticketId: "CARB-BAD" },
    actual: { changeTargets: [{
      repositoryId: "appMarket",
      baseBranch: "v202605-ui",
      variant: { vehicle: "avatr8678", environment: "qa", buildType: "release" },
    }] },
  });
  assert.equal(badGold.ok, false);
  assert.match(badGold.error, /环境仅允许/);
});

test("故事点训练接口：可读取总览并执行不访问 TB 的手工 Dry-run", async () => {
  const childTmp = fs.mkdtempSync(path.join(os.tmpdir(), "story-training-api-"));
  const port = 19000 + Math.floor(Math.random() * 1000);
  const gwCfg = path.join(childTmp, "gateway.json");
  const childMarket = path.join(childTmp, "market.json");
  const childStore = path.join(childTmp, "store");
  const childDb = path.join(childTmp, "data.db");
  fs.writeFileSync(gwCfg, JSON.stringify({ teambition: { projects: [{ id: "project-a", name: "Project A" }] } }), "utf8");
  fs.writeFileSync(childMarket, "{}", "utf8");
  const adminToken = "story-training-admin-token";
  const authDb = new Database(childDb);
  authDb.exec("CREATE TABLE IF NOT EXISTS admin_tokens (token TEXT PRIMARY KEY, data TEXT, exp INTEGER)");
  authDb.prepare("INSERT INTO admin_tokens (token, data, exp) VALUES (?, ?, ?)").run(adminToken, JSON.stringify({ role: "admin", name: "Test Admin" }), Date.now() + 60000);
  authDb.close();
  const child = bootGateway({ port, gwCfg, market: childMarket, storeDir: childStore, dbPath: childDb });
  try {
    await waitHealth(port, child);
    const beforeOverview = fs.readFileSync(childMarket, "utf8");
    const overview = await fetch(`http://127.0.0.1:${port}/api/devbench/ai-training/story-point?projectId=project-a`).then((response) => response.json());
    assert.equal(overview.ok, true);
    assert.ok(Array.isArray(overview.data.registry.projectDefs));
    assert.equal(fs.readFileSync(childMarket, "utf8"), beforeOverview);

    const unauthorized = await fetch(`http://127.0.0.1:${port}/api/devbench/ai-training/story-point/dry-run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectId: "project-a", ticket: { title: "avatr8678 应用市场启动失败", logs: "applicationId com.example.market" } }),
    });
    assert.equal(unauthorized.status, 403);

    const dryRun = await fetch(`http://127.0.0.1:${port}/api/devbench/ai-training/story-point/dry-run`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({ projectId: "project-a", ticket: { title: "avatr8678 应用市场启动失败", environment: "test", buildType: "release", logs: "applicationId com.example.market" } }),
    }).then((response) => response.json());
    assert.equal(dryRun.ok, true);
    assert.equal(dryRun.data.prediction.policy.canExecute, false);
    assert.ok(dryRun.data.prediction.changeTargets.some((target) => target.repositoryId === "appMarket"));

    const review = await fetch(`http://127.0.0.1:${port}/api/devbench/ai-training/story-point/dry-runs/${dryRun.data.id}/review`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({ projectId: "project-a", decision: "correct", saveAsGold: true }),
    }).then((response) => response.json());
    assert.equal(review.ok, true);
    assert.ok(review.goldCase?.id);

    const audit = await fetch(`http://127.0.0.1:${port}/api/devbench/audit?limit=50`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    }).then((response) => response.json());
    const goldAudit = audit.data.find((row) => row.action === "AI训练.Gold样本.复核生成");
    assert.ok(goldAudit);
    assert.equal(goldAudit.target, `gold:${review.goldCase.id}`);
    assert.equal(JSON.parse(goldAudit.after).sourceDryRunId, dryRun.data.id);
  } finally {
    child.kill();
  }
});
