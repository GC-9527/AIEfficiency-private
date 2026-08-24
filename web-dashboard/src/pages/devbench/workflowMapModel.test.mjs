import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import {
  WORKFLOW_LANES,
  WORKFLOW_PHASE_IDS,
  isWorkflowPhase,
  normalizeWorkflowPhase,
  hasWorkflowRepairAttempt,
  workflowRepairTriggerContent,
  workflowStatusActions,
  workflowSyncPendingInfo,
  workflowPhaseItems,
} from "./workflowMapModel.js";

test("工作流阶段清单覆盖全部合法 phase 且没有重复", () => {
  assert.deepEqual(WORKFLOW_PHASE_IDS, [
    "claimed",
    "triaging",
    "fixing",
    "group_fixed",
    "verify_blocked",
    "verifying",
    "reporting",
    "sync_pending",
    "testable",
    "reject_pending",
    "rejected",
  ]);
  assert.equal(new Set(WORKFLOW_PHASE_IDS).size, WORKFLOW_PHASE_IDS.length);
  assert.deepEqual(WORKFLOW_LANES.flatMap((lane) => lane.phaseIds), WORKFLOW_PHASE_IDS);
});

test("工作流 phase 合法性只接受清单中的精确值", () => {
  for (const phase of WORKFLOW_PHASE_IDS) assert.equal(isWorkflowPhase(phase), true, phase);
  assert.equal(isWorkflowPhase(""), false);
  assert.equal(isWorkflowPhase("fix"), false);
  assert.equal(isWorkflowPhase("FIXING"), false);
  assert.equal(isWorkflowPhase(null), false);
});

test("当前 phase 在完整清单中只高亮一项", () => {
  const items = workflowPhaseItems("reporting");
  assert.deepEqual(items.filter((item) => item.current).map((item) => item.id), ["reporting"]);
});

test("选择跳过测试验收后完整工作流图不返回测试与验收节点", () => {
  const items = workflowPhaseItems("reporting", { skipTestAcceptance: true });
  assert.equal(items.some((item) => item.id === "verify_blocked"), false);
  assert.equal(items.some((item) => item.id === "verifying"), false);
  assert.deepEqual(items.filter((item) => item.current).map((item) => item.id), ["reporting"]);
});

test("未知 phase 安全回退到待甄别并保持单一高亮", () => {
  assert.equal(normalizeWorkflowPhase("legacy_phase"), "claimed");
  assert.deepEqual(
    workflowPhaseItems("legacy_phase").filter((item) => item.current).map((item) => item.id),
    ["claimed"],
  );
});

test("sync_pending 是受支持的持久阶段，不能回退为 claimed", () => {
  assert.equal(normalizeWorkflowPhase("sync_pending"), "sync_pending");
  assert.deepEqual(
    workflowPhaseItems("sync_pending").filter((item) => item.current).map((item) => item.id),
    ["sync_pending"],
  );
});

test("同步待续跑模型从持久 payload 和 ledger 恢复重试类型、步骤和错误", () => {
  const info = workflowSyncPendingInfo({
    tbSyncPending: { kind: "reject", reportRevision: "reject-1", attachment: { fileName: "detail.pdf" } },
    tbSyncLedger: { reportRevision: "reject-1", comment: { key: "comment:1" } },
    reportError: "附件回读未确认",
  });
  assert.equal(info.label, "拒绝同步");
  assert.equal(info.retryAction, "reject");
  assert.deepEqual(info.pendingSteps, ["attachment", "status"]);
  assert.deepEqual(info.errors, ["附件回读未确认"]);
});

test("CARB-15059 甄别完成但尚无 REPAIR 回合时只显示开始修复", () => {
  const workflow = { phase: "fixing", triagedAt: 1787278467957 };
  const triageOnlyMessages = [{
    role: "user",
    ts: 1787277561403,
    aiPromptTelemetry: { workflowKind: "triage", stage: "TRIAGE" },
  }];

  assert.equal(hasWorkflowRepairAttempt(triageOnlyMessages, workflow), false);
  assert.deepEqual(
    workflowStatusActions({ workflow, primaryProjectId: "primary" }, triageOnlyMessages).map((action) => action.id),
    ["start_fix"],
  );
});

test("CARB-15059 修复按钮只生成简短且与动作一致的聊天文字", () => {
  assert.equal(workflowRepairTriggerContent("start_fix"), "开始修复");
  assert.equal(workflowRepairTriggerContent("continue_fix"), "继续修复");
  assert.equal(workflowRepairTriggerContent("unknown"), "开始修复");
});

test("已有 REPAIR 回合仍停在 fixing 时显示继续修复和核对完成", () => {
  const workflow = { phase: "fixing", triagedAt: 100 };
  const messages = [{
    role: "user",
    ts: 120,
    aiPromptTelemetry: { workflowKind: "chat", stage: "REPAIR" },
  }];

  assert.equal(hasWorkflowRepairAttempt(messages, workflow), true);
  assert.deepEqual(
    workflowStatusActions({ workflow, primaryProjectId: "primary" }, messages).map((action) => action.id),
    ["continue_fix", "mark_fixed"],
  );
});

test("故事点工作流空闲按钮矩阵保持下一步动作语义", () => {
  const actions = (phase, extra = {}) => workflowStatusActions({
    ...extra,
    primaryProjectId: "primary",
    workflow: { phase, ...(extra.workflow || {}) },
  }).map((action) => `${action.id}${action.disabled ? ":disabled" : ""}`);

  assert.deepEqual(actions("claimed"), ["start_triage"]);
  assert.deepEqual(actions("triaging"), ["start_triage"]);
  assert.deepEqual(actions("group_fixed"), []);
  assert.deepEqual(actions("verifying"), ["start_verify"]);
  assert.deepEqual(actions("verify_blocked"), ["execute_verify:disabled"]);
  assert.deepEqual(actions("verify_blocked", { deviceSerial: "device-1" }), ["execute_verify"]);
  assert.deepEqual(actions("reporting"), ["start_report"]);
  assert.deepEqual(actions("sync_pending"), ["retry_sync"]);
  assert.deepEqual(actions("testable"), []);
  assert.deepEqual(actions("rejected"), []);
  assert.deepEqual(actions("reject_pending", { workflow: { pendingReject: { reason: "非本侧问题" } } }), []);
});

test("CARB-15059 WorkflowStatusBar 接入开始修复，完成核对只在已有 REPAIR 后出现", () => {
  const source = fs.readFileSync(new URL("./StoryTab.jsx", import.meta.url), "utf8");
  const start = source.indexOf("function WorkflowStatusBar");
  const end = source.indexOf("// 故事点组面板", start);
  const statusBar = source.slice(start, end);
  assert.match(statusBar, /workflowStatusActions\(tab, messages, \{ ready \}\)/);
  assert.match(statusBar, /data-testid="devbench-workflow-start-fix"/);
  assert.match(statusBar, /onClick=\{\(\) => onStartFix\?\.\(repairAction\.id\)\}/);
  assert.match(statusBar, /completionAction && \(/);
  assert.match(statusBar, /data-testid="devbench-workflow-mark-fixed"/);
  assert.match(source, /<WorkflowStatusBar tab=\{tab\} messages=\{messages\}/);
  assert.match(source, /onStartFix=\{startFix\}/);
  const startFixStart = source.indexOf("async function startFix(");
  const startFixEnd = source.indexOf("function jumpToMessage", startFixStart);
  const startFixSource = source.slice(startFixStart, startFixEnd);
  assert.match(startFixSource, /workflowRepairTriggerContent\(actionId\)/);
  assert.doesNotMatch(startFixSource, /buildDiagnostics\(\)/);
});

test("TB 工作流状态栏接入跳过测试验收开关并把选择传给完整工作流图", () => {
  const storySource = fs.readFileSync(new URL("./StoryTab.jsx", import.meta.url), "utf8");
  const apiSource = fs.readFileSync(new URL("./api.js", import.meta.url), "utf8");
  const mapSource = fs.readFileSync(new URL("./WorkflowMap.jsx", import.meta.url), "utf8");
  assert.match(storySource, /data-testid="devbench-skip-test-acceptance"/);
  assert.match(storySource, /aria-pressed=\{skipTestAcceptance\}/);
  assert.match(storySource, /skipTestAcceptance=\{tab\.skipTestAcceptance === true\}/);
  assert.match(apiSource, /workflow\/skip-test-acceptance/);
  assert.match(mapSource, /workflowPhaseItems\(currentPhase, \{ skipTestAcceptance \}\)/);
  assert.match(mapSource, /lane\.phaseIds\.filter\(\(phaseId\) => phases\.has\(phaseId\)\)/);
});

test("current workflow card description keeps high contrast", () => {
  const mapSource = fs.readFileSync(new URL("./WorkflowMap.jsx", import.meta.url), "utf8");
  assert.match(mapSource, /phase\.current \? "text-\[var\(--color-accent-ink\)\]" : "text-zinc-500"/);
  assert.doesNotMatch(mapSource, /phase\.current \? "text-blue-100" : "text-zinc-500"/);
});
