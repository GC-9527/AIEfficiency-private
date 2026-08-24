export const WORKFLOW_PHASES = Object.freeze([
  Object.freeze({ id: "claimed", label: "待甄别", description: "等待开始 AI 甄别" }),
  Object.freeze({ id: "triaging", label: "甄别中", description: "AI 正在判断问题归属" }),
  Object.freeze({ id: "fixing", label: "修复中", description: "开发并完成必要自测" }),
  Object.freeze({ id: "group_fixed", label: "组内已修复", description: "等待组内故事点完成" }),
  Object.freeze({ id: "verify_blocked", label: "待连设备验收", description: "绑定目标设备后继续验收" }),
  Object.freeze({ id: "verifying", label: "自我验收", description: "执行构建、复现与证据采集" }),
  Object.freeze({ id: "reporting", label: "生成报告", description: "整理报告并同步 TB" }),
  Object.freeze({ id: "sync_pending", label: "TB 同步待续跑", description: "TB 评论、附件或状态尚未完成确认，可安全重试" }),
  Object.freeze({ id: "testable", label: "已提测", description: "主流程已完成" }),
  Object.freeze({ id: "reject_pending", label: "待确认拒绝", description: "甄别为非本侧问题，等待确认" }),
  Object.freeze({ id: "rejected", label: "已拒绝", description: "拒绝分支已完成" }),
]);

export const WORKFLOW_PHASE_IDS = Object.freeze(WORKFLOW_PHASES.map((phase) => phase.id));

export const WORKFLOW_LANES = Object.freeze([
  Object.freeze({
    id: "main",
    label: "正常主线",
    phaseIds: Object.freeze([
      "claimed",
      "triaging",
      "fixing",
      "group_fixed",
      "verify_blocked",
      "verifying",
      "reporting",
      "sync_pending",
      "testable",
    ]),
  }),
  Object.freeze({
    id: "reject",
    label: "甄别拒绝分支",
    phaseIds: Object.freeze(["reject_pending", "rejected"]),
  }),
]);

const PHASE_BY_ID = new Map(WORKFLOW_PHASES.map((phase) => [phase.id, phase]));

export function isWorkflowPhase(value) {
  return PHASE_BY_ID.has(String(value || ""));
}

export function normalizeWorkflowPhase(value) {
  const phase = String(value || "");
  return isWorkflowPhase(phase) ? phase : "claimed";
}

export function getWorkflowPhase(value) {
  return PHASE_BY_ID.get(normalizeWorkflowPhase(value));
}

export function workflowPhaseItems(currentPhase, { skipTestAcceptance = false } = {}) {
  const activePhase = normalizeWorkflowPhase(currentPhase);
  return WORKFLOW_PHASES
    .filter((phase) => !skipTestAcceptance || !["verify_blocked", "verifying"].includes(phase.id))
    .map((phase) => ({ ...phase, current: phase.id === activePhase }));
}

export function hasWorkflowRepairAttempt(messages, workflow = {}) {
  const triagedAt = Number(workflow?.triagedAt || 0);
  return (Array.isArray(messages) ? messages : []).some((message) => {
    if (message?.role !== "user") return false;
    const telemetry = message.aiPromptTelemetry && typeof message.aiPromptTelemetry === "object"
      ? message.aiPromptTelemetry
      : {};
    const stage = String(telemetry.stage || telemetry.overlayStage || "").trim().toUpperCase();
    const kind = String(telemetry.workflowKind || "").trim().toLowerCase();
    if (stage === "REPAIR" || kind === "repair" || kind === "fix") return true;
    const messageAt = Number(message.ts || message.createdAt || 0);
    return triagedAt > 0
      && messageAt >= triagedAt
      && !["triage", "verify", "report", "code_review"].includes(kind);
  });
}

export function workflowRepairTriggerContent(actionId = "start_fix") {
  return actionId === "continue_fix" ? "继续修复" : "开始修复";
}

function pendingRejectHasEvidence(workflow) {
  const pending = workflow?.pendingReject;
  return !!pending
    && typeof pending === "object"
    && !Array.isArray(pending)
    && [pending.shortReport, pending.reason, pending.detailRel, pending.detailAbsPath]
      .some((value) => String(value || "").trim());
}

export function workflowStatusActions(tab = {}, messages = [], { ready = !!tab?.primaryProjectId } = {}) {
  const workflow = tab?.workflow && typeof tab.workflow === "object" ? tab.workflow : {};
  const phase = normalizeWorkflowPhase(workflow.phase);
  const action = (id, label, description, extra = {}) => ({ id, label, description, ...extra });

  if (phase === "fixing") {
    if (!ready) return [];
    if (!hasWorkflowRepairAttempt(messages, workflow)) {
      return [action("start_fix", "🔧 开始修复", "发送“开始修复”，由后端注入完整上下文并进入可写 REPAIR 回合")];
    }
    return [
      action("continue_fix", "🔧 继续修复", "发送“继续修复”，由后端注入完整上下文处理剩余修复"),
      action("mark_fixed", "✅ 核对修复完成", "让 AI 核对修复与自测；只有输出 FIX_DONE 才进入验收"),
    ];
  }
  if (phase === "verifying") {
    return [action("start_verify", "🔬 开始自我验收", "生成测试、构建 debug/release 并在绑定设备复现")];
  }
  if (phase === "verify_blocked") {
    const hasDevice = !!String(tab?.deviceSerial || "").trim();
    return [action("execute_verify", "▶ 执行验收", "绑定目标设备后继续自我验收", { disabled: !hasDevice })];
  }
  if (phase === "reporting") {
    return [action("start_report", "📝 生成报告并提交", "整理验收报告并执行独立的 TB 同步")];
  }
  if (phase === "sync_pending") {
    return [action("retry_sync", "↻ 重试 TB 同步", "复用冻结 payload 和幂等键续跑未确认的 TB 步骤")];
  }
  if (["group_fixed", "testable", "rejected"].includes(phase)) return [];
  if (phase === "reject_pending" && pendingRejectHasEvidence(workflow)) return [];
  if (!ready) return [];
  return [action("start_triage", "▶ 开始 AI 甄别", "只判断问题归属，不修改代码")];
}

const SYNC_KIND_LABEL = Object.freeze({
  report: "报告同步",
  reject: "拒绝同步",
  group: "故事点组同步",
});

/**
 * 将后端持久化的 tbSyncPending/ledger 规范化成只读 UI 模型。
 * 这里不推测远端成功；没有带可验证 ledger key 的步骤始终显示为待续跑。
 */
export function workflowSyncPendingInfo(workflow) {
  const wf = workflow && typeof workflow === "object" ? workflow : {};
  const pending = wf.tbSyncPending && typeof wf.tbSyncPending === "object" ? wf.tbSyncPending : {};
  const explicitKind = String(pending.kind || "").trim();
  const kind = Object.hasOwn(SYNC_KIND_LABEL, explicitKind)
    ? explicitKind
    : (wf.groupTbSync || wf.groupTbSyncSummary ? "group" : "report");
  const ledger = wf.tbSyncLedger && typeof wf.tbSyncLedger === "object" ? wf.tbSyncLedger : {};
  const attachmentRequired = !!pending.attachment;
  const complete = (name) => !!ledger?.[name]?.key;
  const steps = [
    { id: "comment", label: "TB 评论", done: complete("comment") },
    { id: "attachment", label: "报告附件", done: !attachmentRequired || complete("attachment"), skipped: !attachmentRequired },
    { id: "status", label: "TB 状态", done: complete("status") },
  ];
  const rawErrors = [
    wf.reportError,
    pending.error,
    ...(Array.isArray(pending.errors) ? pending.errors : []),
    ...(Array.isArray(wf.groupTbSyncSummary?.errors) ? wf.groupTbSyncSummary.errors : []),
  ];
  const errors = [...new Set(rawErrors.map((value) => String(value || "").trim()).filter(Boolean))].slice(0, 5);
  return Object.freeze({
    kind,
    label: SYNC_KIND_LABEL[kind],
    retryAction: kind === "reject" ? "reject" : "report",
    steps: Object.freeze(steps.map((step) => Object.freeze(step))),
    pendingSteps: Object.freeze(steps.filter((step) => !step.done).map((step) => step.id)),
    errors: Object.freeze(errors),
    revision: String(pending.reportRevision || ledger.reportRevision || "").trim(),
  });
}
