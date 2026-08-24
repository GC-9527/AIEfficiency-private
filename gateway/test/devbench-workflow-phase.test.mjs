import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { bootGateway, waitHealth } from "./_helpers.mjs";

const unitTmp = fs.mkdtempSync(path.join(os.tmpdir(), "devbench-workflow-phase-unit-"));
process.env.GATEWAY_DB_PATH = path.join(unitTmp, "data.db");
process.env.GATEWAY_CONFIG_PATH = path.join(unitTmp, "gateway.json");
process.env.DEVBENCH_CONFIG_PATH = path.join(unitTmp, "market.json");
process.env.DEVBENCH_LOCAL_PROJECTS_PATH = path.join(unitTmp, "local-projects.json");
process.env.DEVBENCH_STORE_DIR = path.join(unitTmp, "store");
process.env.AIEFFICIENCY_CLONE_PARENT = path.join(unitTmp, "clone-parent");
fs.writeFileSync(process.env.GATEWAY_CONFIG_PATH, JSON.stringify({ servers: { nodeId: "workflow-phase-unit" } }));

const store = await import("../services/devbench/store.js");
const {
  applyWorkflow,
  confirmReject,
  isTestAcceptanceSkipped,
  isGroupDevelopmentDone,
  isTriageDone,
  reportSubmissionReadiness,
  setManualWorkflowPhase,
  setTestAcceptanceSkipped,
  WORKFLOW_PHASES,
} = await import("../services/devbench/tb-workflow.js");

const TB_URL = "https://www.teambition.com/task/0123456789abcdef01234567";

function createWorkflowTab(title, workflow = {}) {
  const created = store.createTab({ title });
  return store.updateTab(created.id, { ticketUrl: TB_URL, workflow: { enabled: true, ...workflow } });
}

test("人工切换阶段会记录历史并清理不兼容的待处理状态", () => {
  const tab = createWorkflowTab("人工切换成功", {
    phase: "reject_pending",
    pendingReject: { report: "待确认拒绝" },
    configInferencePendingRunId: "run-pending",
    configInferencePendingAt: 123,
    configInferenceReviewedRunId: "run-reviewed",
    phaseHistory: [{ fromPhase: "fixing", toPhase: "reject_pending", source: "system", at: 100 }],
  });

  const result = setManualWorkflowPhase(tab.id, "reporting", {
    actor: "tester",
    reason: "回到报告阶段补充材料",
    now: () => 456,
  });

  assert.equal(result.ok, true);
  assert.equal(result.data.workflow.phase, "reporting");
  assert.equal(result.data.workflow.phaseSource, "manual");
  assert.equal(result.data.workflow.phaseChangedAt, 456);
  assert.equal(Object.hasOwn(result.data.workflow, "pendingReject"), false);
  assert.equal(Object.hasOwn(result.data.workflow, "configInferencePendingRunId"), false);
  assert.equal(Object.hasOwn(result.data.workflow, "configInferencePendingAt"), false);
  assert.equal(result.data.workflow.configInferenceReviewedRunId, "run-reviewed");
  assert.deepEqual(result.transition, {
    fromPhase: "reject_pending",
    toPhase: "reporting",
    source: "manual",
    actor: "tester",
    reason: "回到报告阶段补充材料",
    at: 456,
    samePhase: false,
    clearedState: ["pendingReject", "configInferencePendingRunId", "configInferencePendingAt"],
    clearedPending: ["pendingReject", "configInferencePendingRunId", "configInferencePendingAt"],
  });
  assert.deepEqual(result.data.workflow.phaseHistory.at(-1), result.transition);
});

test("从已提测回退到修复会清空完成标记，不再被组流程视为开发完成", () => {
  const tab = createWorkflowTab("完成态回退修复", {
    phase: "testable",
    triagedAt: 101,
    fixedAt: 102,
    fixReportRel: "docs/story/old/fix.md",
    fixShortReport: "旧修复摘要",
    groupAcceptanceContext: { items: [{ tabId: "old" }] },
    verifiedAt: 103,
    verifyReportRel: "docs/story/old/verify.md",
    verifyPassedAt: 103,
    reportedAt: 104,
    reportPdfRel: "docs/story/old/report.pdf",
    groupReportedAt: 105,
    groupTbSync: { statusFlow: { ok: true } },
    groupTbSyncSummary: { ok: true },
    rejectedAt: 106,
    pendingReject: { shortReport: "旧拒绝依据" },
    lesson: { cause: "保留的历史经验" },
  });
  assert.equal(isGroupDevelopmentDone(tab), true);

  const result = setManualWorkflowPhase(tab.id, "fixing", { now: () => 500 });

  assert.equal(result.ok, true);
  assert.equal(result.data.workflow.phase, "fixing");
  assert.equal(result.data.workflow.triagedAt, 101);
  assert.deepEqual(result.data.workflow.lesson, { cause: "保留的历史经验" });
  for (const field of [
    "fixedAt", "fixReportRel", "fixShortReport", "groupAcceptanceContext", "verifiedAt",
    "verifyReportRel", "verifyPassedAt", "reportedAt", "reportPdfRel", "groupReportedAt",
    "groupTbSync", "groupTbSyncSummary", "rejectedAt", "pendingReject",
  ]) {
    assert.equal(Object.hasOwn(result.data.workflow, field), false, `${field} 应在回退修复时清理`);
    assert.ok(result.transition.clearedState.includes(field), `${field} 应写入切换审计`);
  }
  assert.equal(isGroupDevelopmentDone(result.data), false);
});

test("从修复重新进入验收会保留修复证据并清空旧验收、报告和拒绝结论", () => {
  const tab = createWorkflowTab("修复后重新验收", {
    phase: "fixing",
    triagedAt: 201,
    fixedAt: 202,
    fixReportRel: "docs/story/current/fix.md",
    fixShortReport: "当前修复摘要",
    verifiedAt: 203,
    verifyReportRel: "docs/story/old/verify-failed.md",
    verifyPassedAt: 203,
    reportedAt: 204,
    reportPdfRel: "docs/story/old/report.pdf",
    rejectedAt: 205,
    pendingReject: { shortReport: "旧拒绝结论" },
  });

  const result = setManualWorkflowPhase(tab.id, "verifying", { now: () => 550 });

  assert.equal(result.ok, true);
  assert.equal(result.data.workflow.fixedAt, 202);
  assert.equal(result.data.workflow.fixReportRel, "docs/story/current/fix.md");
  assert.equal(result.data.workflow.fixShortReport, "当前修复摘要");
  for (const field of ["verifiedAt", "verifyReportRel", "verifyPassedAt", "reportedAt", "reportPdfRel", "rejectedAt", "pendingReject"]) {
    assert.equal(Object.hasOwn(result.data.workflow, field), false, `${field} 不得污染新验收轮次`);
    assert.ok(result.transition.clearedState.includes(field), `${field} 应写入切换审计`);
  }
});

test("手动进入无材料的待拒绝阶段仍可重新甄别，且不能误确认旧拒绝依据", async () => {
  const tab = createWorkflowTab("拒绝分支重新甄别", {
    phase: "testable",
    pendingReject: { shortReport: "另一阶段遗留的旧拒绝依据", at: 100 },
    fixedAt: 101,
    verifiedAt: 102,
    reportedAt: 103,
  });

  const result = setManualWorkflowPhase(tab.id, "reject_pending", { now: () => 600 });

  assert.equal(result.ok, true);
  assert.equal(result.data.workflow.phase, "reject_pending");
  assert.equal(Object.hasOwn(result.data.workflow, "pendingReject"), false);
  assert.equal(result.transition.requiresEvidence, "reject");
  assert.equal(result.transition.nextAction, "triage");
  assert.equal(result.nextAction.type, "triage");
  assert.equal(isTriageDone(result.data), false);
  const confirmation = await confirmReject(tab.id);
  assert.equal(confirmation.ok, false);
  assert.match(confirmation.error, /请先完成问题甄别/);

  const evidence = createWorkflowTab("已有拒绝依据", {
    phase: "reject_pending",
    pendingReject: { shortReport: "AI 甄别生成的拒绝依据", at: 200 },
  });
  const unchanged = setManualWorkflowPhase(evidence.id, "reject_pending", { now: () => 601 });
  assert.equal(unchanged.ok, true);
  assert.equal(unchanged.data.workflow.pendingReject.shortReport, "AI 甄别生成的拒绝依据");
  assert.equal(unchanged.nextAction, undefined);
  assert.equal(isTriageDone(unchanged.data), true);
});

test("只接受完整法定阶段集合，包含 triaging 但不持久化虚拟 ready", () => {
  assert.deepEqual(WORKFLOW_PHASES, [
    "claimed", "triaging", "fixing", "group_fixed", "verify_blocked",
    "verifying", "reporting", "testable", "reject_pending", "rejected", "sync_pending",
  ]);
  const tab = createWorkflowTab("非法阶段", { phase: "claimed" });
  const before = structuredClone(store.getTab(tab.id).workflow);

  const result = setManualWorkflowPhase(tab.id, "ready");

  assert.equal(result.ok, false);
  assert.equal(result.statusCode, 400);
  assert.equal(result.code, "INVALID_WORKFLOW_PHASE");
  assert.deepEqual(store.getTab(tab.id).workflow, before);
});

test("非 TB 故事点、运行中 AI 与外部编排器均不能人工切换", () => {
  const local = store.createTab({ title: "非 TB 故事点" });
  assert.equal(setManualWorkflowPhase(local.id, "triaging").code, "NOT_TB_WORKFLOW");

  const running = createWorkflowTab("AI 运行中", { phase: "claimed" });
  store.updateTab(running.id, { runningTaskId: "task-running" });
  const busy = setManualWorkflowPhase(running.id, "triaging", {
    isTaskRunning: (taskId) => taskId === "task-running",
  });
  assert.equal(busy.statusCode, 409);
  assert.equal(busy.code, "AI_RUNNING");
  assert.equal(store.getTab(running.id).workflow.phase, "claimed");

  const coordinated = createWorkflowTab("外部编排中", {
    phase: "claimed",
    coordinator: "tb-smart-execution",
    coordinatorRunId: "run-1",
  });
  const guarded = setManualWorkflowPhase(coordinated.id, "triaging");
  assert.equal(guarded.statusCode, 409);
  assert.equal(guarded.code, "WORKFLOW_COORDINATED");
  assert.equal(store.getTab(coordinated.id).workflow.phase, "claimed");
});

test("选择跳过测试验收后修复完成直接进入报告且不伪造验收通过", async () => {
  const tab = createWorkflowTab("跳过测试验收", { phase: "fixing", triagedAt: 700 });
  const selected = setTestAcceptanceSkipped(tab.id, true, {
    actor: "tester",
    now: () => 701,
  });

  assert.equal(selected.ok, true);
  assert.equal(selected.skipped, true);
  assert.equal(isTestAcceptanceSkipped(selected.data), true);
  assert.equal(selected.data.workflow.phase, "fixing");

  const result = await applyWorkflow(store.getTab(tab.id), {
    kind: "fix_done",
    shortReport: "原因：旧状态未刷新。\n措施：修复状态刷新。",
    detailReport: "",
  });
  const fresh = store.getTab(tab.id);

  assert.equal(result.phase, "reporting");
  assert.equal(result.testAcceptanceSkipped, true);
  assert.equal(fresh.workflow.phase, "reporting");
  assert.equal(Number.isFinite(Number(fresh.workflow.fixedAt)), true);
  assert.equal(fresh.workflow.verifyPassedAt, null);
  assert.deepEqual(reportSubmissionReadiness(fresh), {
    ok: true,
    code: "WORKFLOW_REPORT_READY_WITH_TEST_ACCEPTANCE_SKIPPED",
    error: null,
    skipped: true,
  });
});

test("跳过测试验收是组级统一选择，关闭后回到真实验收门禁", () => {
  const first = createWorkflowTab("组成员一", { phase: "reporting", fixedAt: 800 });
  const second = createWorkflowTab("组成员二", { phase: "group_fixed", fixedAt: 801 });
  const groupId = "skip-acceptance-group";
  store.updateTab(first.id, { groupId, groupName: "跳过验收组" });
  store.updateTab(second.id, { groupId, groupName: "跳过验收组" });

  const selected = setTestAcceptanceSkipped(first.id, true, { actor: "tester", now: () => 802 });
  assert.equal(selected.ok, true);
  assert.equal(selected.scope, "group");
  assert.deepEqual(new Set(selected.updatedTabIds), new Set([first.id, second.id]));
  assert.equal(store.getTab(first.id).skipTestAcceptance, true);
  assert.equal(store.getTab(second.id).skipTestAcceptance, true);

  const manualVerify = setManualWorkflowPhase(first.id, "verifying");
  assert.equal(manualVerify.ok, false);
  assert.equal(manualVerify.code, "WORKFLOW_TEST_ACCEPTANCE_SKIPPED");

  const deselected = setTestAcceptanceSkipped(first.id, false, { actor: "tester", now: () => 803 });
  assert.equal(deselected.ok, true);
  assert.equal(store.getTab(first.id).skipTestAcceptance, false);
  assert.equal(store.getTab(second.id).skipTestAcceptance, false);
  assert.equal(store.getTab(first.id).workflow.phase, "verify_blocked");
  assert.equal(reportSubmissionReadiness(store.getTab(first.id)).ok, false);
});

test("跳过测试验收拒绝非法 payload，且组内任一运行任务都会阻止整组部分写入", () => {
  const first = createWorkflowTab("原子组成员一", { phase: "fixing" });
  const second = createWorkflowTab("原子组成员二", { phase: "fixing" });
  const groupId = "skip-acceptance-atomic-group";
  store.updateTab(first.id, { groupId });
  store.updateTab(second.id, { groupId, runningTaskId: "running-member-task" });

  const invalid = setTestAcceptanceSkipped(first.id, "true");
  assert.equal(invalid.code, "INVALID_SKIP_TEST_ACCEPTANCE");

  const blocked = setTestAcceptanceSkipped(first.id, true, {
    isTaskRunning: (taskId) => taskId === "running-member-task",
  });
  assert.equal(blocked.code, "AI_RUNNING");
  assert.equal(store.getTab(first.id).skipTestAcceptance, false);
  assert.equal(store.getTab(second.id).skipTestAcceptance, false);
});

const serverTmp = fs.mkdtempSync(path.join(os.tmpdir(), "devbench-workflow-phase-http-"));
const serverStore = path.join(serverTmp, "store");
const PORT = 39827;
const base = `http://localhost:${PORT}`;
let server;

before(async () => {
  server = bootGateway({
    port: PORT,
    role: "standalone",
    gwCfg: path.join(serverTmp, "gateway.json"),
    market: path.join(serverTmp, "market.json"),
    storeDir: serverStore,
    dbPath: path.join(serverTmp, "data.db"),
  });
  await waitHealth(PORT, server);
}, { timeout: 40000 });

after(() => { try { server.kill(); } catch {} });

async function jsonRequest(method, url, body) {
  const response = await fetch(base + url, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body == null ? undefined : JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

test("HTTP POST 主协议与 PATCH 兼容协议均可切换工作流阶段", async () => {
  const created = await jsonRequest("POST", "/api/devbench/tabs", { title: "HTTP 人工切换" });
  assert.equal(created.status, 200);
  assert.equal(created.body.ok, true, created.body.error);
  const linked = await jsonRequest("POST", `/api/devbench/tabs/${created.body.data.id}/ticket`, { url: TB_URL });
  assert.equal(linked.status, 200);
  assert.equal(linked.body.ok, true, linked.body.error);

  const skipped = await jsonRequest("POST", `/api/devbench/tabs/${created.body.data.id}/workflow/skip-test-acceptance`, { skipped: true });
  assert.equal(skipped.status, 200);
  assert.equal(skipped.body.ok, true, skipped.body.error);
  assert.equal(skipped.body.data.skipTestAcceptance, true);
  const verifyBlocked = await jsonRequest("POST", `/api/devbench/tabs/${created.body.data.id}/workflow/phase`, { phase: "verifying" });
  assert.equal(verifyBlocked.status, 409);
  assert.equal(verifyBlocked.body.code, "WORKFLOW_TEST_ACCEPTANCE_SKIPPED");
  const restored = await jsonRequest("POST", `/api/devbench/tabs/${created.body.data.id}/workflow/skip-test-acceptance`, { skipped: false });
  assert.equal(restored.status, 200);
  assert.equal(restored.body.data.skipTestAcceptance, false);

  const triaging = await jsonRequest("POST", `/api/devbench/tabs/${created.body.data.id}/workflow/phase`, { phase: "triaging" });
  assert.equal(triaging.status, 200);
  assert.equal(triaging.body.ok, true, triaging.body.error);
  assert.equal(triaging.body.data.workflow.phase, "triaging");
  assert.equal(triaging.body.transition.source, "manual");

  const reporting = await jsonRequest("PATCH", `/api/devbench/tabs/${created.body.data.id}/workflow/phase`, { phase: "reporting", reason: "接口兼容测试" });
  assert.equal(reporting.status, 200);
  assert.equal(reporting.body.ok, true, reporting.body.error);
  assert.equal(reporting.body.data.workflow.phase, "reporting");
  assert.equal(reporting.body.data.workflow.phaseHistory.length, 2);

  const invalid = await jsonRequest("POST", `/api/devbench/tabs/${created.body.data.id}/workflow/phase`, { phase: "ready" });
  assert.equal(invalid.status, 400);
  assert.equal(invalid.body.code, "INVALID_WORKFLOW_PHASE");

  const local = await jsonRequest("POST", "/api/devbench/tabs", { title: "HTTP 非 TB 门禁" });
  assert.equal(local.body.ok, true, local.body.error);
  const blocked = await jsonRequest("POST", `/api/devbench/tabs/${local.body.data.id}/workflow/phase`, { phase: "triaging" });
  assert.equal(blocked.status, 400);
  assert.equal(blocked.body.code, "NOT_TB_WORKFLOW");
});
