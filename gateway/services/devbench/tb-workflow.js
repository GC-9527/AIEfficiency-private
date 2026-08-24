/**
 * devbench TB 全自动工作流（状态机）
 *
 * 三步工作流（半自动/全自动流程一致，区别仅在是否需要人点按钮推进下一步）：
 *   点「执行开发」    : 待处理 → 待确认（仅当前为待处理类才动）
 *   第一步·甄别 NOT_BUG: 生成报告 + 醒目提示，挂起待用户确认 → 确认后 待确认 → 已拒绝 + 评论 + 附件
 *   第一步·甄别 IS_BUG : (待处理|待确认) → 修复中
 *   第二步·修复完成    : 生成修复报告 + 沉淀经验 → 进入【自我验收】(verifying)；未绑定设备则暂停(verify_blocked)并醒目提示
 *   第三步·自我验收    : 新开验收 Agent 出单测/用例/mock/脚本，打 debug+release 包在绑定设备复现验证
 *                       PASS → reporting；FAIL → 回到 fixing
 *   第三步·报告与提交  : 生成全量支撑文档 → (修复中)→ 可提测 + 评论(简短) + 附件(全量报告)
 *
 * ⚠️ TB 写操作（评论/附件/状态）依赖真实接口与远端回读。任一步未确认时，
 *    本地必须停留 sync_pending，不得提前标记 testable/rejected。
 */
import fs from "fs";
import path from "path";
import { createHash, randomUUID } from "crypto";
import {
  updateTaskStatus as rawUpdateTaskStatus,
  uploadTaskAttachment as rawUploadTaskAttachment,
  postTaskComment as rawPostTaskComment,
  getTaskStatusName,
  getTaskCommentsWithStatus,
  getTaskAttachmentsWithStatus,
  canonicalStatus,
} from "../teambition.js";
import {
  runTbSyncSaga,
  tbSyncAttachmentKey,
  tbSyncCommentKey,
  tbSyncStatusKey,
} from "./workflow-v2/tb-sync-saga.js";
import { canonicalSha256 } from "./workflow-v2/envelope-store.js";
import {
  recordTbWriteObservation,
  recordWorkflowStageObservation,
} from "../../db/sqlite.js";
import { log, broadcastChatMessage, emitWs } from "../logger.js";
import { recordLessonToBugAgent } from "./lessons.js";
import { recordConfigMemory } from "./config-memory.js";
import { htmlToPdf, findAcceptanceHtml } from "./report-pdf.js";
import * as store from "./store.js";

function tbWriteFingerprint(value) {
  return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}

function observeTbWrite(storyId, tbTaskId, writeKind, payload, result, error = null) {
  const outcome = error || result?.ok === false
    ? "failed"
    : result?.skipped ? "skipped" : "succeeded";
  try {
    return recordTbWriteObservation({
      storyId,
      tbTaskId,
      writeKind,
      payloadSha256: tbWriteFingerprint(payload),
      outcome,
      errorCode: error?.code || result?.code || null,
    });
  } catch (observationError) {
    log("system", "warn", "devbench-observability", `TB 写入观测失败: ${observationError.message}`);
    return null;
  }
}

export function __testObserveTbWrite({ storyId, tbTaskId, writeKind, payload, result, error = null }) {
  return observeTbWrite(storyId, tbTaskId, writeKind, payload, result, error);
}

async function updateTaskStatus(tbTaskId, logicalName, storyId = null, operation = null) {
  try {
    const result = await rawUpdateTaskStatus(tbTaskId, logicalName, operation);
    observeTbWrite(storyId, tbTaskId, "status", { logicalName, operation }, result);
    return result;
  } catch (error) {
    observeTbWrite(storyId, tbTaskId, "status", { logicalName, operation }, null, error);
    throw error;
  }
}

async function postTaskComment(tbTaskId, content, format, attachments, storyId = null, operation = null) {
  const payload = {
    content: String(content || ""),
    format: format === undefined ? "markdown" : format,
    attachments: attachments === undefined ? [] : attachments,
    operation,
  };
  try {
    const result = await rawPostTaskComment(tbTaskId, content, format, attachments, operation);
    observeTbWrite(storyId, tbTaskId, "comment", payload, result);
    return result;
  } catch (error) {
    observeTbWrite(storyId, tbTaskId, "comment", payload, null, error);
    throw error;
  }
}

async function uploadTaskAttachment(tbTaskId, filePath, comment = "", storyId = null, operation = null) {
  let sizeBytes = null;
  try { sizeBytes = fs.statSync(filePath).size; } catch {}
  const payload = { fileName: path.basename(String(filePath || "")), sizeBytes, comment: String(comment || ""), operation };
  try {
    const result = await rawUploadTaskAttachment(tbTaskId, filePath, comment, operation);
    observeTbWrite(storyId, tbTaskId, "attachment", payload, result);
    return result;
  } catch (error) {
    observeTbWrite(storyId, tbTaskId, "attachment", payload, null, error);
    throw error;
  }
}

// 从故事点关联任务 URL 提取 TB 任务 id（24 位十六进制）
function tabTbTaskId(tab) {
  const m = String(tab?.ticketUrl || "").match(/task\/([0-9a-fA-F]{24})/);
  return m ? m[1] : null;
}

// 从故事点标题/上下文提取 CARB 单号（如 CARB-12605），用于经验库去重
function tabCarbId(tab) {
  const m = String(tab?.title || "").match(/#?(CARB-\d+)#?/i);
  return m ? m[1].toUpperCase() : "";
}

/**
 * 把一条经验沉淀到：devbench 经验库（按 TB 项目隔离，权威存储，自动注入后续轮）+ Bug Agent 记忆(best-effort)。
 * 工程 CLAUDE.md / docs/wiki 由用户在完成卡片上点按钮导出（避免静默改 git 跟踪文件）。
 * 返回写入的经验行（含 id），或 null（无有效经验时）。
 */
function persistLesson(tab, kind, lesson, detailRel) {
  if (!lesson || !(lesson.cause || lesson.prevention)) return null;
  const row = {
    ...lesson,
    kind: kind === "triage_not_bug" ? "reject" : "fix",
    tbId: tabTbTaskId(tab),
    carbId: tabCarbId(tab),
    title: tab.tbContext?.title || tab.title || "",
    ticketUrl: tab.ticketUrl || "",
    detailRel: detailRel || null,
  };
  const projectId = tab.tbContext?.projectId || "";
  try { store.addLesson(projectId, row); } catch (e) { log("system", "warn", "devbench", `经验库写入失败: ${e.message}`); }
  try { recordLessonToBugAgent(row); } catch {}
  try {
    const wf = store.getTab(tab.id)?.workflow || tab.workflow || {};
    store.updateTab(tab.id, { workflow: { ...wf, lesson: row } });
  } catch {}
  return row;
}

// 真实进入开发/修复时，把当次实际使用的工程配置沉淀为配置推理样本。
// onStartDev、确认进入 fixing、fix_done 可能属于同一次执行；固定 actionKind 让 store
// 按「工单 + 实际配置」幂等更新同一条记录，修复完成时再把 outcome 提升为 success。
function recordActualConfigUsage(tab, outcome = "started", options = {}) {
  const fresh = tab?.id ? (store.getTab(tab.id) || tab) : tab;
  if (!fresh) return null;
  try {
    return store.recordConfigInferenceUsage(fresh.tbContext?.projectId || "", {
      tab: fresh,
      taskId: fresh.runningTaskId || "",
      actionKind: "develop_started",
      outcome,
      ...options,
    });
  } catch (e) {
    log("system", "warn", "devbench", `实际工程配置学习记录失败: ${e.message}`);
    return null;
  }
}

// 该故事点是否走 TB 工作流：关联了真实 TB 单，且未显式关闭
export function isWorkflowTab(tab) {
  return !!tabTbTaskId(tab) && tab?.workflow?.enabled !== false;
}

// 前后端共同认可的可落盘工作流阶段。"ready" 只是一键执行器读取旧数据时的虚拟兜底，
// 不允许通过手动切换接口写入，避免生成页面无法识别的持久化状态。
export const WORKFLOW_PHASES = Object.freeze([
  "claimed",
  "triaging",
  "fixing",
  "group_fixed",
  "verify_blocked",
  "verifying",
  "reporting",
  "testable",
  "reject_pending",
  "rejected",
  "sync_pending",
]);

const WORKFLOW_PHASE_SET = new Set(WORKFLOW_PHASES);
const CONFIG_INFERENCE_PENDING_PHASES = new Set(["claimed", "triaging"]);
const PHASE_SCOPED_WORKFLOW_FIELDS = Object.freeze([
  "pendingReject",
  "triagedAt",
  "fixedAt",
  "fixReportRel",
  "fixShortReport",
  "groupAcceptanceContext",
  "verifiedAt",
  "verifyReportRel",
  "verifyPassedAt",
  "reportedAt",
  "reportPdfRel",
  "groupReportedAt",
  "groupTbSync",
  "groupTbSyncSummary",
  "rejectedAt",
  "tbSyncLedger",
  "tbSyncPending",
]);
const PHASE_ALLOWED_WORKFLOW_FIELDS = Object.freeze({
  claimed: new Set(),
  triaging: new Set(),
  fixing: new Set(["triagedAt"]),
  group_fixed: new Set(["triagedAt", "fixedAt", "fixReportRel", "fixShortReport"]),
  verify_blocked: new Set(["triagedAt", "fixedAt", "fixReportRel", "fixShortReport", "groupAcceptanceContext"]),
  verifying: new Set(["triagedAt", "fixedAt", "fixReportRel", "fixShortReport", "groupAcceptanceContext"]),
  reporting: new Set(["triagedAt", "fixedAt", "fixReportRel", "fixShortReport", "groupAcceptanceContext", "verifiedAt", "verifyReportRel", "verifyPassedAt"]),
  testable: new Set([
    "triagedAt", "fixedAt", "fixReportRel", "fixShortReport", "groupAcceptanceContext",
    "verifiedAt", "verifyReportRel", "verifyPassedAt", "reportedAt", "reportPdfRel", "groupReportedAt",
    "groupTbSync", "groupTbSyncSummary", "tbSyncLedger",
  ]),
  reject_pending: new Set(["pendingReject"]),
  rejected: new Set(["rejectedAt", "tbSyncLedger"]),
  sync_pending: new Set([
    "triagedAt", "fixedAt", "fixReportRel", "fixShortReport", "groupAcceptanceContext",
    "verifiedAt", "verifyReportRel", "verifyPassedAt", "reportedAt", "reportPdfRel",
    "reportHtmlRel", "groupReportedAt", "groupTbSync", "groupTbSyncSummary", "tbSyncLedger",
    "tbSyncPending", "pendingReject",
  ]),
});
const PENDING_WORKFLOW_FIELDS = new Set(["pendingReject", "configInferencePendingRunId", "configInferencePendingAt"]);

function hasActionablePendingReject(workflow) {
  const pending = workflow?.pendingReject;
  if (!pending || typeof pending !== "object" || Array.isArray(pending)) return false;
  return [pending.shortReport, pending.reason, pending.detailRel, pending.detailAbsPath]
    .some((value) => String(value || "").trim());
}

/**
 * 仅在本地持久化一次人工工作流阶段切换。
 *
 * 该函数刻意不调用 TB 接口、不发送 AI 对话，也不自动推进后续阶段；调用方必须在
 * 确认没有运行中的 AI/外部编排器后使用。人工切换会留下有界历史，并清掉与目标
 * 阶段不兼容的待处理门禁，避免旧弹窗或旧拒绝动作在新阶段误触发。
 */
export function setManualWorkflowPhase(tabId, rawPhase, {
  actor = "",
  reason = "",
  isTaskRunning = () => false,
  now = () => Date.now(),
} = {}) {
  const tab = store.getTab(tabId);
  if (!tab) return { ok: false, statusCode: 404, code: "TAB_NOT_FOUND", error: "tab 不存在" };

  const phase = String(rawPhase || "").trim().toLowerCase();
  if (!WORKFLOW_PHASE_SET.has(phase)) {
    return {
      ok: false,
      statusCode: 400,
      code: "INVALID_WORKFLOW_PHASE",
      error: `不支持的工作流阶段：${phase || "（空）"}`,
      allowedPhases: WORKFLOW_PHASES,
    };
  }
  if (!isWorkflowTab(tab)) {
    return {
      ok: false,
      statusCode: 400,
      code: "NOT_TB_WORKFLOW",
      error: "非 TB 单故事点或工作流已关闭，不能切换阶段",
    };
  }
  if (isTestAcceptanceSkipped(tab) && ["verifying", "verify_blocked"].includes(phase)) {
    return {
      ok: false,
      statusCode: 409,
      code: "WORKFLOW_TEST_ACCEPTANCE_SKIPPED",
      error: "当前故事点已选择跳过测试验收，请先关闭该选项再进入验收阶段",
    };
  }
  if (tab.runningTaskId && isTaskRunning(tab.runningTaskId)) {
    return { ok: false, statusCode: 409, code: "AI_RUNNING", error: "AI 正在运行，不能切换工作流阶段" };
  }
  if (String(tab.workflow?.coordinator || "").trim()) {
    return {
      ok: false,
      statusCode: 409,
      code: "WORKFLOW_COORDINATED",
      error: "受控自动工作流仍在运行，请先停止后再手动切换阶段",
    };
  }

  const workflow = { ...(tab.workflow || {}) };
  const currentPhase = String(workflow.phase || "").trim().toLowerCase();
  const fromPhase = WORKFLOW_PHASE_SET.has(currentPhase) ? currentPhase : "claimed";
  const allowedFields = PHASE_ALLOWED_WORKFLOW_FIELDS[phase];
  const clearedState = [];
  // 拒绝材料只属于生成它的当前 reject_pending 分支。不能把其它阶段遗留的旧材料
  // 带入一次新的人工跳转，否则“确认拒绝”可能把旧结论误写回 TB。
  const keepCurrentRejectEvidence = phase === "reject_pending"
    && fromPhase === "reject_pending"
    && hasActionablePendingReject(workflow);
  for (const key of PHASE_SCOPED_WORKFLOW_FIELDS) {
    const compatible = allowedFields.has(key)
      && (key !== "pendingReject" || keepCurrentRejectEvidence);
    if (compatible || !Object.hasOwn(workflow, key)) continue;
    delete workflow[key];
    clearedState.push(key);
  }
  if (!CONFIG_INFERENCE_PENDING_PHASES.has(phase)) {
    for (const key of ["configInferencePendingRunId", "configInferencePendingAt"]) {
      if (!Object.hasOwn(workflow, key)) continue;
      delete workflow[key];
      clearedState.push(key);
    }
  }
  const clearedPending = clearedState.filter((key) => PENDING_WORKFLOW_FIELDS.has(key));
  const requiresRejectEvidence = phase === "reject_pending" && !hasActionablePendingReject(workflow);

  const candidateAt = Number(now());
  const at = Number.isFinite(candidateAt) ? candidateAt : Date.now();
  const transition = {
    fromPhase,
    toPhase: phase,
    source: "manual",
    actor: String(actor || "").trim().slice(0, 100),
    reason: String(reason || "").trim().slice(0, 500),
    at,
    samePhase: fromPhase === phase,
    clearedState,
    clearedPending,
    ...(requiresRejectEvidence ? { requiresEvidence: "reject", nextAction: "triage" } : {}),
  };
  const phaseHistory = Array.isArray(workflow.phaseHistory) ? workflow.phaseHistory.slice(-99) : [];
  workflow.enabled = true;
  workflow.phase = phase;
  workflow.phaseSource = "manual";
  workflow.phaseChangedAt = at;
  workflow.phaseHistory = [...phaseHistory, transition];

  const updated = store.updateTab(tab.id, { workflow });
  if (!updated) return { ok: false, statusCode: 404, code: "TAB_NOT_FOUND", error: "tab 不存在" };
  return {
    ok: true,
    data: updated,
    transition,
    allowedPhases: WORKFLOW_PHASES,
    ...(requiresRejectEvidence ? {
      nextAction: {
        type: "triage",
        message: "当前没有可确认的拒绝材料；请继续发消息或触发 AI 甄别，生成依据后再确认拒绝",
      },
    } : {}),
  };
}

// 工作流自动化档位：full=全自动（工程就绪即自动甄别，预留）/ semi=半自动（默认，手动或发消息触发甄别）
export function getAutoMode(tab) {
  return tab?.workflow?.autoMode === "full" ? "full" : "semi";
}

// 报告模式是每个 TB 单自己的配置，不属于故事点组共享工程配置。
// 兼容历史数据：未保存过该字段的旧故事点也默认走简短模式。
export function getReportMode(tab) {
  return tab?.reportMode === "expert" ? "expert" : "short";
}

export function isTestAcceptanceSkipped(tab) {
  return tab?.skipTestAcceptance === true;
}

/**
 * 持久化“跳过测试验收”选择。故事点组只有一轮统一验收，因此组内成员必须同步选择，
 * 避免最后一个成员完成修复时出现互相矛盾的门禁。该操作只改变本地工作流状态，不调用 TB。
 */
export function setTestAcceptanceSkipped(tabId, skipped, {
  actor = "",
  isTaskRunning = () => false,
  now = () => Date.now(),
} = {}) {
  const tab = store.getTab(tabId);
  if (!tab) return { ok: false, statusCode: 404, code: "TAB_NOT_FOUND", error: "tab 不存在" };
  if (typeof skipped !== "boolean") {
    return { ok: false, statusCode: 400, code: "INVALID_SKIP_TEST_ACCEPTANCE", error: "skipped 必须是布尔值" };
  }
  if (!isWorkflowTab(tab)) {
    return { ok: false, statusCode: 400, code: "NOT_TB_WORKFLOW", error: "非 TB 单故事点，无测试验收流程" };
  }

  const groupMembers = tab.groupId ? store.getGroupMembers(tab.groupId) : [];
  const targets = groupMembers.length ? groupMembers : [tab];
  for (const member of targets) {
    if (member.runningTaskId && isTaskRunning(member.runningTaskId)) {
      return { ok: false, statusCode: 409, code: "AI_RUNNING", error: "组内有 AI 正在运行，不能切换测试验收选项" };
    }
    if (String(member.workflow?.coordinator || "").trim()) {
      return { ok: false, statusCode: 409, code: "WORKFLOW_COORDINATED", error: "组内受控自动工作流仍在运行，请先停止后再切换" };
    }
    const phase = String(member.workflow?.phase || "claimed");
    if (skipped && ["verifying", "verify_blocked"].includes(phase) && !Number(member.workflow?.fixedAt)) {
      return { ok: false, statusCode: 409, code: "WORKFLOW_FIX_REQUIRED", error: "尚无修复完成事实，不能直接跳到报告阶段" };
    }
  }

  const candidateAt = Number(now());
  const at = Number.isFinite(candidateAt) ? candidateAt : Date.now();
  const updatedTabIds = [];
  const transitions = [];
  for (const member of targets) {
    const workflow = { ...(member.workflow || {}) };
    const fromPhase = String(workflow.phase || "claimed");
    let toPhase = fromPhase;
    if (skipped && ["verifying", "verify_blocked"].includes(fromPhase)) {
      toPhase = "reporting";
    } else if (!skipped && fromPhase === "reporting" && !Number(workflow.verifyPassedAt) && Number(workflow.fixedAt)) {
      toPhase = hasBoundDevice(member) ? "verifying" : "verify_blocked";
    }
    workflow.testAcceptanceSkipUpdatedAt = at;
    workflow.testAcceptanceSkipUpdatedBy = String(actor || "").trim().slice(0, 100);
    if (toPhase !== fromPhase) {
      const transition = {
        fromPhase,
        toPhase,
        source: "skip_test_acceptance",
        actor: String(actor || "").trim().slice(0, 100),
        at,
        enabled: skipped,
      };
      const phaseHistory = Array.isArray(workflow.phaseHistory) ? workflow.phaseHistory.slice(-99) : [];
      workflow.phase = toPhase;
      workflow.phaseSource = "skip_test_acceptance";
      workflow.phaseChangedAt = at;
      workflow.phaseHistory = [...phaseHistory, transition];
      if (!skipped) delete workflow.reportError;
      transitions.push({ tabId: member.id, ...transition });
    }
    const updated = store.updateTab(member.id, { skipTestAcceptance: skipped, workflow });
    if (updated) updatedTabIds.push(member.id);
  }

  return {
    ok: true,
    data: store.getTab(tabId),
    skipped,
    scope: targets.length > 1 ? "group" : "story",
    updatedTabIds,
    transitions,
  };
}

// 故事点组统一做报告时，只要组内有一个 TB 单选择专家模式，就需要生成一次专家 HTML/PDF；
// 最终同步时仍按每个成员自己的模式决定是否给该 TB 单上传 PDF。
export function requiresExpertReport(tab, suppliedMembers = null) {
  if (getReportMode(tab) === "expert") return true;
  const members = Array.isArray(suppliedMembers)
    ? suppliedMembers
    : (tab?.groupId ? store.getGroupMembers(tab.groupId) : []);
  return members.some((member) => getReportMode(member) === "expert");
}

// 该故事点是否已经过"问题甄别"（甄别后才会进入这些阶段）：用于避免重复甄别
export function isTriageDone(tab) {
  const phase = tab?.workflow?.phase;
  // 人工可切到 reject_pending，但没有 AI 生成的拒绝依据时它是“待重新甄别”而不是
  // 已完成甄别。这样下一条聊天或显式甄别操作仍会进入 triage，不会形成死状态。
  if (phase === "reject_pending") return hasActionablePendingReject(tab?.workflow);
  return ["fixing", "group_fixed", "verifying", "verify_blocked", "reporting", "testable", "rejected", "sync_pending"].includes(phase);
}

// 该故事点是否已绑定目标设备（自我验收必需：要在 TB 指定机型上打 debug/release 包复现验证）
export function hasBoundDevice(tab) {
  return !!(tab?.deviceSerial && String(tab.deviceSerial).trim());
}

// 该故事点是否已通过自测验收（verify_pass）。
// verifyPassedAt 只在验收通过时写入；fix_done 重新修复时会清空，确保新一轮修复必须重新验收。
// 报告默认必须经过本轮 VERIFY PASS；用户显式选择跳过时则只接受修复完成事实，并要求报告明确未执行验收。
export function hasSelfAcceptancePassed(tab) {
  return !!Number(tab?.workflow?.verifyPassedAt);
}

export function reportSubmissionReadiness(tab) {
  const phase = String(tab?.workflow?.phase || "");
  if (phase !== "reporting") {
    return {
      ok: false,
      code: "WORKFLOW_REPORT_PHASE_INVALID",
      error: `报告提交只允许从 reporting 阶段执行，当前阶段为 ${phase || "unknown"}`,
    };
  }
  if (hasSelfAcceptancePassed(tab)) {
    return { ok: true, code: "WORKFLOW_REPORT_READY", error: null };
  }
  if (isTestAcceptanceSkipped(tab)) {
    if (!Number(tab?.workflow?.fixedAt)) {
      return {
        ok: false,
        code: "WORKFLOW_REPORT_FIX_REQUIRED",
        error: "跳过测试验收后仍必须先完成修复，才能提交报告",
      };
    }
    return {
      ok: true,
      code: "WORKFLOW_REPORT_READY_WITH_TEST_ACCEPTANCE_SKIPPED",
      error: null,
      skipped: true,
    };
  }
  if (!hasSelfAcceptancePassed(tab)) {
    return {
      ok: false,
      code: "WORKFLOW_REPORT_VERIFY_REQUIRED",
      error: "报告提交前必须先完成并通过本轮自我验收",
    };
  }
  return { ok: true, code: "WORKFLOW_REPORT_READY", error: null };
}

const GROUP_DEVELOPMENT_DONE_PHASES = new Set(["group_fixed", "verifying", "verify_blocked", "reporting", "testable", "rejected", "sync_pending"]);

export function isGroupDevelopmentDone(tab) {
  const wf = tab?.workflow || {};
  return !!wf.fixedAt || GROUP_DEVELOPMENT_DONE_PHASES.has(wf.phase);
}

function buildGroupAcceptanceContext(members, lastTabId) {
  const sorted = [...(members || [])].sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
  return {
    groupId: sorted[0]?.groupId || "",
    groupName: sorted[0]?.groupName || "故事点组",
    lastTabId,
    generatedAt: Date.now(),
    items: sorted.map((m) => {
      const wf = m.workflow || {};
      return {
        tabId: m.id,
        title: m.title || "",
        carbId: tabCarbId(m),
        ticketUrl: m.ticketUrl || "",
        tbTaskId: tabTbTaskId(m),
        phase: wf.phase || "",
        fixedAt: wf.fixedAt || null,
        fixReportRel: wf.fixReportRel || null,
        fixShortReport: wf.fixShortReport || "",
        reportMode: getReportMode(m),
      };
    }),
  };
}

function formatGroupAcceptanceContext(context) {
  const items = Array.isArray(context?.items) ? context.items : [];
  if (!items.length) return "";
  return items.map((item, idx) => {
    const id = item.carbId || item.tbTaskId || item.tabId;
    const lines = [`${idx + 1}. ${id} ${item.title || ""}`.trim()];
    if (item.ticketUrl) lines.push(`   TB: ${item.ticketUrl}`);
    if (item.fixReportRel) lines.push(`   修复报告: ${item.fixReportRel}`);
    if (item.fixShortReport) lines.push(`   修复摘要: ${String(item.fixShortReport).replace(/\n+/g, " ").slice(0, 240)}`);
    return lines.join("\n");
  }).join("\n");
}

function handleGroupFixDone(tab, wf, detail, savedLesson) {
  if (!tab?.groupId) return null;
  const baseWorkflow = store.getTab(tab.id)?.workflow || tab.workflow || {};
  store.updateTab(tab.id, {
    workflow: {
      ...baseWorkflow,
      enabled: true,
      phase: "group_fixed",
      fixedAt: Date.now(),
      fixReportRel: detail?.rel || null,
      fixShortReport: wf.shortReport || "",
      verifyPassedAt: null,
      verifiedAt: null,
      verifyReportRel: null,
    },
  });

  const current = store.getTab(tab.id) || tab;
  const members = store.getGroupMembers(tab.groupId);
  const pending = members.filter((m) => m.id !== tab.id && !isGroupDevelopmentDone(m));
  if (pending.length) {
    const next = pending[0];
    store.setGroupActive(tab.groupId, next.id);
    const nextFresh = store.getTab(next.id) || next;
    const doneCount = members.length - pending.length;
    const skipGroupAcceptance = isTestAcceptanceSkipped(current);
    pushWorkflowMsg(current, {
      level: "info",
      title: "故事点修复完成，已切换到组内下一个故事点",
      body: `修复报告已生成${detail?.rel ? `（${detail.rel}）` : ""}。\n\n组队开发规则：本故事点先不进入自我验收；系统已切换到下一个故事点「${nextFresh.title || nextFresh.id}」。等整组 ${members.length} 个故事点都修复完成后，${skipGroupAcceptance ? "将按用户选择跳过统一测试验收并直接进入报告" : "会在最后完成的故事点里统一验收"}。\n\n进度：已完成 ${doneCount}/${members.length}。${savedLesson ? "\n（修复经验已入库）" : ""}`,
      alert: { kind: "group_fixed", detailRel: detail?.rel || null, lessonSaved: !!savedLesson, nextTabId: nextFresh.id },
    });
    pushWorkflowMsg(nextFresh, {
      level: "info",
      title: "已切换到本故事点继续组队开发",
      body: `上一故事点「${current.title || current.id}」已完成修复。请继续处理本故事点；本故事点完成后同样输出 FIX_DONE，系统会继续切换，整组完成后${skipGroupAcceptance ? "直接进入报告" : "进入统一验收"}。`,
      alert: { kind: "group_active", previousTabId: current.id },
    });
    emitWs("devbench_group_advance", { groupId: tab.groupId, fromTabId: tab.id, toTabId: nextFresh.id, remaining: pending.length });
    return { phase: "group_fixed", kind: wf.kind, detailRel: detail?.rel || null, lessonSaved: !!savedLesson, groupAdvance: { groupId: tab.groupId, nextTabId: nextFresh.id, remaining: pending.length } };
  }

  store.setGroupActive(tab.groupId, tab.id);
  const finalTab = store.getTab(tab.id) || current;
  const finalMembers = store.getGroupMembers(tab.groupId);
  const context = buildGroupAcceptanceContext(finalMembers, tab.id);
  const contextText = formatGroupAcceptanceContext(context);
  const hasDevice = hasBoundDevice(finalTab);
  const testAcceptanceSkipped = finalMembers.length > 0 && finalMembers.every(isTestAcceptanceSkipped);
  const phase = testAcceptanceSkipped ? "reporting" : (hasDevice ? "verifying" : "verify_blocked");
  store.updateTab(tab.id, {
    workflow: {
      ...(finalTab.workflow || {}),
      enabled: true,
      phase,
      fixedAt: finalTab.workflow?.fixedAt || Date.now(),
      fixReportRel: finalTab.workflow?.fixReportRel || detail?.rel || null,
      fixShortReport: finalTab.workflow?.fixShortReport || wf.shortReport || "",
      groupAcceptanceContext: context,
    },
  });
  pushWorkflowMsg(finalTab, {
    level: testAcceptanceSkipped || hasDevice ? "info" : "warn",
    title: testAcceptanceSkipped ? "故事点组全部修复完成，已跳过整组测试验收" : (hasDevice ? "故事点组全部修复完成，进入整组统一验收" : "故事点组全部修复完成，但未绑定设备"),
    body: `${testAcceptanceSkipped ? "已按用户选择跳过测试与验收流程，下一步直接生成报告；这不表示验收通过，报告必须明确标注未执行测试验收。" : (hasDevice ? "下一步会在本故事点里统一验收整组所有故事点。" : "自我验收需要先绑定目标设备；绑定后在本故事点执行验收，范围覆盖整组所有故事点。")}\n\n${testAcceptanceSkipped ? "报告覆盖范围" : "统一验收范围"}：\n${contextText}`,
    alert: { kind: phase, detailRel: detail?.rel || null, lessonSaved: !!savedLesson, groupAcceptanceContext: context },
  });
  emitWs("devbench_group_advance", { groupId: tab.groupId, fromTabId: tab.id, toTabId: tab.id, complete: true });
  return { phase, kind: wf.kind, detailRel: detail?.rel || null, lessonSaved: !!savedLesson, groupAcceptanceContext: context, testAcceptanceSkipped };
}

function timeStamp() { return new Date().toLocaleString("zh-CN"); }

// ========== AI 回复里的工作流标记解析 ==========

/**
 * 解析 Claude 回复中的工作流标记。约定：
 *   <!-- TRIAGE: NOT_A_BUG -->  / <!-- TRIAGE: IS_BUG -->
 *   <!-- FIX_DONE -->
 * 报告分区（markdown 小标题）：## 简短报告 / ## 详细报告
 * 返回 { kind, shortReport, detailReport, cleaned } —— cleaned 为剥离标记后的展示文本。
 */
export function parseWorkflowMarkers(text) {
  const s = String(text || "");
  let kind = null;
  const triage = s.match(/<!--\s*TRIAGE:\s*(NOT_A_BUG|IS_BUG)\s*-->/i);
  const verify = s.match(/<!--\s*VERIFY:\s*(PASS|FAIL)\s*-->/i);
  if (triage) kind = triage[1].toUpperCase() === "NOT_A_BUG" ? "triage_not_bug" : "triage_is_bug";
  else if (verify) kind = verify[1].toUpperCase() === "PASS" ? "verify_pass" : "verify_fail";
  else if (/<!--\s*REPORT_DONE\s*-->/i.test(s)) kind = "report_done";
  else if (/<!--\s*FIX_DONE\s*-->/i.test(s)) kind = "fix_done";
  if (!kind) return { kind: null, cleaned: s };

  // 提取经验沉淀块 <!-- LESSON  原因:/预防:/关键词: -->（供避免同类问题，写入经验库/CLAUDE.md/wiki）
  let lesson = null;
  const lm = s.match(/<!--\s*LESSON([\s\S]*?)-->/i);
  if (lm) {
    const body = lm[1];
    const grab = (re) => { const m = body.match(re); return m ? m[1].trim() : ""; };
    const cause = grab(/原因[:：]\s*([^\n]+)/);
    const prevention = grab(/预防[:：]\s*([^\n]+)/);
    const keywords = grab(/关键词[:：]\s*([^\n]+)/);
    if (cause || prevention) lesson = { cause, prevention, keywords };
  }

  // 剥离所有工作流标记（含 LESSON），避免泄漏给用户
  const cleaned = s
    .replace(/<!--\s*TRIAGE:[\s\S]*?-->/gi, "")
    .replace(/<!--\s*VERIFY:[\s\S]*?-->/gi, "")
    .replace(/<!--\s*REPORT_DONE\s*-->/gi, "")
    .replace(/<!--\s*FIX_DONE\s*-->/gi, "")
    .replace(/<!--\s*LESSON[\s\S]*?-->/gi, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  // 提取"简短报告"小节；取不到则用 cleaned 前若干行兜底
  const shortReport = sectionText(cleaned, "简短报告") || firstLines(cleaned, 6);
  // 详细报告：优先"详细报告"小节，否则用整段 cleaned
  const detailReport = sectionText(cleaned, "详细报告") || cleaned;
  return { kind, shortReport, detailReport, cleaned, lesson };
}

// 取 markdown 里 "## <title>" 到下一个同级/更高级标题之间的正文
function sectionText(md, title) {
  const re = new RegExp(`(^|\\n)#{1,3}\\s*${title}\\s*\\n([\\s\\S]*?)(?=\\n#{1,3}\\s|$)`, "i");
  const m = String(md || "").match(re);
  return m ? m[2].trim() : "";
}

function firstLines(s, n) {
  return String(s || "").split("\n").filter((l) => l.trim()).slice(0, n).join("\n").trim();
}

// ========== 报告落盘 ==========

// 详细报告写到故事点外部 archives/，返回 { absPath, rel, fileName } 或 null。
function writeDetailReport(tab, kind, detailReport) {
  const project = store.getPrimaryProject(tab);
  if (!project) return null;
  const storage = store.getStoryStoragePaths(tab, { create: true });
  const slug = storage.docSlug || store.ensureDocSlug(tab);
  const relDir = "storydev:/archives";
  const absDir = storage.attachmentDirectory;
  const kindLabel = kind === "triage_not_bug" ? "拒绝说明"
    : kind === "fix_done" ? "修复报告"
    : kind === "verify" ? "验收报告"
    : kind === "report" ? "总览报告"
    : "工作流报告";
  const fileName = `${kindLabel}_${slug}.md`;
  const header = `# ${kindLabel}（${tab.title || slug}）\n\n> TB 单：${tab.ticketUrl || tabTbTaskId(tab)}\n> 生成于 ${timeStamp()}\n\n`;
  try {
    const reportPath = path.join(absDir, fileName);
    store.validateStoryStorageTarget(tab, reportPath, {
      baseDirectory: absDir,
      mustExist: false,
    });
    fs.writeFileSync(reportPath, header + String(detailReport || "") + "\n", "utf-8");
    store.validateStoryStorageTarget(tab, reportPath, {
      baseDirectory: absDir,
      mustExist: true,
      expectedType: "file",
    });
    return { absPath: reportPath, rel: `${relDir}/${fileName}`, fileName };
  } catch (e) {
    log("system", "warn", "devbench", `写详细报告失败: ${e.message}`);
    return null;
  }
}

export function validateExpertReportHtml(html, { skipTestAcceptance = false } = {}) {
  const source = String(html || "");
  const text = source
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ");
  const checks = [
    ["问题原因", /(?:问题原因|根本原因|根因|原因)/i.test(text)],
    ["解决方案", /(?:解决方案|修复方案|处理方案|改进措施)/i.test(text)],
    ["改动范围", /(?:改动范围|修改范围|影响范围|改动文件)/i.test(text)],
    ["测试建议", /(?:测试建议|建议测试|建议测试范围|回归建议)/i.test(text)],
    ...(skipTestAcceptance
      ? [["跳过说明", /(?:跳过.{0,12}(?:测试|自测|验收)|(?:测试|自测|验收).{0,12}(?:已跳过|未执行|未开展))/i.test(text)]]
      : [
        ["自测报告", /(?:自测报告|自测结果|验收报告|验收结果)/i.test(text)],
        ["图片证据", /<(?:img|svg|canvas)\b/i.test(source)],
        ["音视频证据", /<(?:video|audio)\b/i.test(source) || /(?:href|src)\s*=\s*["'][^"']+\.(?:mp4|webm|mov|m4v|mp3|wav|m4a|ogg)(?:[?#][^"']*)?["']/i.test(source)],
      ]),
  ];
  const missing = checks.filter(([, ok]) => !ok).map(([label]) => label);
  return { ok: missing.length === 0, missing };
}

// 专家报告必须先有 Agent 产出的 HTML，再由系统把这份 HTML 转为 PDF。
// 不再用 markdown 兜底，避免“专家报告”在缺少图文影音 HTML 时仍被误报为已完成。
async function buildExpertReportPdf(tab) {
  try {
    const project = store.getPrimaryProject(tab);
    if (!project) return { ok: false, error: "未选择主工程，无法生成专家报告" };
    const storage = store.getStoryStoragePaths(tab, { create: true });
    const slug = storage.docSlug || store.ensureDocSlug(tab);
    const reportsAbs = storage.reportsDirectory;
    const pdfName = `验收报告_${slug}.pdf`;
    const pdfAbs = path.join(reportsAbs, pdfName);
    const relPdf = `storydev:/reports/${pdfName}`;
    const htmlAbs = findAcceptanceHtml(reportsAbs);
    if (!htmlAbs) {
      return { ok: false, error: `专家报告模式要求先生成 ${path.join(reportsAbs, "acceptance-report.html")}（storydev:/reports/acceptance-report.html）` };
    }
    store.validateStoryStorageTarget(tab, htmlAbs, {
      baseDirectory: reportsAbs,
      mustExist: true,
      expectedType: "file",
    });
    store.validateStoryStorageTarget(tab, pdfAbs, {
      baseDirectory: reportsAbs,
      mustExist: false,
    });
    const validation = validateExpertReportHtml(fs.readFileSync(htmlAbs, "utf-8"), {
      skipTestAcceptance: isTestAcceptanceSkipped(tab) && !hasSelfAcceptancePassed(tab),
    });
    if (!validation.ok) {
      return { ok: false, error: `专家 HTML 报告内容不完整，缺少：${validation.missing.join("、")}` };
    }
    await htmlToPdf(htmlAbs, pdfAbs);
    store.validateStoryStorageTarget(tab, pdfAbs, {
      baseDirectory: reportsAbs,
      mustExist: true,
      expectedType: "file",
    });
    if (!fs.existsSync(pdfAbs)) return { ok: false, error: "HTML 已生成，但 PDF 文件未落盘" };
    return {
      ok: true,
      artifact: { absPath: pdfAbs, rel: relPdf, fileName: pdfName },
      htmlRel: `storydev:/reports/${path.basename(htmlAbs)}`,
    };
  } catch (e) {
    log("system", "warn", "devbench", `生成验收 PDF 失败: ${e.message}`);
    return { ok: false, error: e.message };
  }
}

// ========== TB 同步：状态流转 + 评论 + 附件 ==========

const TB_SYNC_PENDING_SCHEMA_VERSION = "tb-sync-pending-v1";
const TB_SYNC_STEP_SUCCESS = new Set(["done", "deduped_remote", "replayed", "skipped"]);
const TB_SYNC_TERMINAL_PHASES = new Set(["testable", "rejected"]);
const TB_SYNC_KINDS = new Set(["report", "reject"]);
const TB_SYNC_TERMINAL_UPDATE_KEYS = new Set([
  "reportedAt",
  "reportHtmlRel",
  "reportPdfRel",
  "groupReportedAt",
  "rejectedAt",
]);
const tbSyncInFlight = new Map();
// Stable for the lifetime of this Gateway module instance. Query-imported
// module instances deliberately get different owners, matching real Gateways.
const TB_SYNC_PROCESS_OWNER_TOKEN = randomUUID();

function sha256File(filePath) {
  return createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function cloneJson(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function sealTbSyncPending(input) {
  const kind = String(input?.kind || "").trim();
  const terminalPhase = String(input?.terminalPhase || "").trim();
  if (!TB_SYNC_KINDS.has(kind) || !TB_SYNC_TERMINAL_PHASES.has(terminalPhase)) {
    throw new Error("TB 同步 pending 的 kind/terminalPhase 无效");
  }
  const rawAttachmentPath = String(input?.attachment?.absPath || "").trim();
  const attachment = input?.attachment
    ? {
      sourceStoryId: String(input.attachment.sourceStoryId || input.storyId || "").trim(),
      absPath: rawAttachmentPath ? path.resolve(rawAttachmentPath) : "",
      fileName: String(input.attachment.fileName || "").trim(),
      sha256: String(input.attachment.sha256 || "").trim().toLowerCase(),
    }
    : null;
  if (attachment && (!attachment.sourceStoryId || !attachment.absPath || !attachment.fileName
    || !/^[a-f0-9]{64}$/.test(attachment.sha256))) {
    throw new Error("TB 同步 pending 的附件绑定无效");
  }
  const terminalUpdates = {};
  for (const [key, value] of Object.entries(input?.terminalUpdates || {})) {
    if (!TB_SYNC_TERMINAL_UPDATE_KEYS.has(key)) throw new Error(`TB 同步 pending 不允许终态字段 ${key}`);
    terminalUpdates[key] = value == null ? null : value;
  }
  const body = {
    schemaVersion: TB_SYNC_PENDING_SCHEMA_VERSION,
    kind,
    storyId: String(input?.storyId || "").trim(),
    tbTaskId: String(input?.tbTaskId || "").trim(),
    reportRevision: String(input?.reportRevision || "").trim(),
    commentText: String(input?.commentText || ""),
    attachment,
    allowedFromStatuses: [...new Set((Array.isArray(input?.allowedFromStatuses) ? input.allowedFromStatuses : [])
      .map((value) => String(value || "").trim())
      .filter(Boolean))].sort(),
    targetStatus: String(input?.targetStatus || "").trim(),
    terminalPhase,
    reportMode: input?.reportMode === "expert" ? "expert" : "short",
    terminalUpdates,
    createdAt: Number.isFinite(Number(input?.createdAt)) ? Number(input.createdAt) : Date.now(),
  };
  if (!body.storyId || !body.tbTaskId || !body.reportRevision || !body.commentText.trim()
    || !body.allowedFromStatuses.length || !body.targetStatus) {
    throw new Error("TB 同步 pending 缺少必需的不可变字段");
  }
  // createdAt is diagnostic metadata, not part of the semantic operation
  // identity. Concurrent Gateways sealing the same business payload must CAS
  // against the same immutable hash even when their clocks differ slightly.
  const identity = { ...body };
  delete identity.createdAt;
  return Object.freeze({ ...body, payloadSha256: canonicalSha256(identity) });
}

function validateStoredTbSyncPending(value, { storyId, tbTaskId, expectedKind = "" } = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("TB 同步 pending 不存在");
  const suppliedHash = String(value.payloadSha256 || "");
  const copy = cloneJson(value);
  delete copy.payloadSha256;
  const sealed = sealTbSyncPending(copy);
  const legacyBody = { ...sealed };
  delete legacyBody.payloadSha256;
  const legacyHash = canonicalSha256(legacyBody);
  if (![sealed.payloadSha256, legacyHash].includes(suppliedHash)
    || sealed.storyId !== String(storyId || "")
    || sealed.tbTaskId !== String(tbTaskId || "")
    || (expectedKind && sealed.kind !== expectedKind)) {
    throw new Error("TB 同步 pending 身份或内容哈希不一致");
  }
  return suppliedHash === sealed.payloadSha256
    ? sealed
    : Object.freeze({ ...sealed, payloadSha256: suppliedHash });
}

function tbSyncPendingMatchesCandidate(pending, input) {
  const sealed = sealTbSyncPending({ ...input, createdAt: pending.createdAt });
  if (sealed.payloadSha256 === pending.payloadSha256) return true;
  const legacyBody = { ...sealed };
  delete legacyBody.payloadSha256;
  return canonicalSha256(legacyBody) === pending.payloadSha256;
}

async function withTbSyncLock(storyId, callback) {
  const key = String(storyId || "");
  while (tbSyncInFlight.has(key)) await tbSyncInFlight.get(key);
  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  tbSyncInFlight.set(key, pending);
  try {
    return await callback();
  } finally {
    if (tbSyncInFlight.get(key) === pending) tbSyncInFlight.delete(key);
    release();
  }
}

function requireCompleteRemoteList(result, label) {
  if (result?.available !== true || result?.complete !== true || !Array.isArray(result?.items)) {
    throw new Error(`${label}回读不完整：${String(result?.error || "远端数据不可用")}`);
  }
  return result.items;
}

async function remoteAttachmentSha256(item, expectedFileName) {
  const existing = String(item?.sha256 || item?.contentSha256 || "").trim().toLowerCase();
  if (/^[a-f0-9]{64}$/.test(existing)) return existing;
  const fileName = String(item?.fileName || item?.name || "").trim();
  if (!expectedFileName || fileName !== expectedFileName) return "";
  const url = String(item?.downloadUrl || item?.url || "").trim();
  if (!/^https:\/\//i.test(url)) return "";

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30_000);
  try {
    const response = await fetch(url, { method: "GET", redirect: "follow", signal: controller.signal });
    if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`);
    const declaredSize = Number(response.headers.get("content-length") || 0);
    const maxBytes = 128 * 1024 * 1024;
    if (declaredSize > maxBytes) throw new Error("远端附件超过 128 MiB 回读上限");
    const digest = createHash("sha256");
    const reader = response.body.getReader();
    let bytes = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new Error("远端附件超过 128 MiB 回读上限");
      }
      digest.update(value);
    }
    return digest.digest("hex");
  } catch (error) {
    throw new Error(`TB 附件回读哈希失败（${fileName || "未命名"}）：${error.message}`);
  } finally {
    clearTimeout(timer);
  }
}

function defaultPersistedTbApi(tab, tbTaskId, pending) {
  return {
    postComment: (text, operation) => postTaskComment(tbTaskId, text, undefined, undefined, tab.id, operation),
    findComments: async (_operation) => requireCompleteRemoteList(
      await getTaskCommentsWithStatus(tbTaskId),
      "TB 评论",
    ).map((item) => ({
      id: String(item?.id || item?._id || ""),
      content: String(item?.content || item?.note || item?.plainText || item?.text || ""),
    })),
    uploadAttachment: (absPath, operation) => uploadTaskAttachment(tbTaskId, absPath, "", tab.id, operation),
    findAttachments: async (_operation) => {
      const items = requireCompleteRemoteList(await getTaskAttachmentsWithStatus(tbTaskId), "TB 附件");
      const expectedFileName = String(pending?.attachment?.fileName || "");
      const normalized = [];
      for (const item of items) {
        normalized.push({
          id: String(item?.id || item?._id || ""),
          fileName: String(item?.fileName || item?.name || ""),
          sha256: await remoteAttachmentSha256(item, expectedFileName),
        });
      }
      return normalized;
    },
    currentStatus: async (_operation) => {
      const current = await getTaskStatusName(tbTaskId);
      if (current?.ok !== true || !String(current?.statusName || "").trim()) {
        throw new Error(String(current?.error || "TB 当前状态不可读"));
      }
      return canonicalStatus(current.statusName) || String(current.statusName).trim();
    },
    // Saga 已在写前校验当前状态；这里只做单次受控写，
    // 写后仍由 Saga 独立回读确认。
    flowStatus: (target, operation) => updateTaskStatus(tbTaskId, target, tab.id, operation),
  };
}

function tbSyncResultComplete(pending, saga) {
  if (saga?.ok !== true || !Array.isArray(saga?.pending) || saga.pending.length !== 0) return false;
  const commentOk = TB_SYNC_STEP_SUCCESS.has(String(saga?.steps?.comment?.status || ""));
  const attachmentStatus = String(saga?.steps?.attachment?.status || "");
  const attachmentOk = pending.attachment
    ? TB_SYNC_STEP_SUCCESS.has(attachmentStatus) && attachmentStatus !== "skipped"
    : attachmentStatus === "skipped" || TB_SYNC_STEP_SUCCESS.has(attachmentStatus);
  const statusOk = TB_SYNC_STEP_SUCCESS.has(String(saga?.steps?.status?.status || ""))
    && String(saga?.steps?.status?.status || "") !== "skipped";
  return commentOk && attachmentOk && statusOk;
}

function completedLedgerMatches(pending, ledger) {
  if (!ledger || ledger.reportRevision !== pending.reportRevision) return false;
  const commentKey = tbSyncCommentKey({
    storyId: pending.storyId,
    reportRevision: pending.reportRevision,
    content: pending.commentText,
  });
  const statusKey = tbSyncStatusKey({
    storyId: pending.storyId,
    allowedFromStatuses: pending.allowedFromStatuses,
    targetStatus: pending.targetStatus,
    reportRevision: pending.reportRevision,
  });
  if (ledger.comment?.key !== commentKey || ledger.status?.key !== statusKey) return false;
  if (!pending.attachment) return true;
  return ledger.attachment?.key === tbSyncAttachmentKey({
    storyId: pending.storyId,
    reportRevision: pending.reportRevision,
    fileSha256: pending.attachment.sha256,
    fileName: pending.attachment.fileName,
  });
}

function tbSyncStepKeysForPending(pending) {
  return {
    comment: tbSyncCommentKey({
      storyId: pending.storyId,
      reportRevision: pending.reportRevision,
      content: pending.commentText,
    }),
    attachment: pending.attachment
      ? tbSyncAttachmentKey({
        storyId: pending.storyId,
        reportRevision: pending.reportRevision,
        fileSha256: pending.attachment.sha256,
        fileName: pending.attachment.fileName,
      })
      : "",
    status: tbSyncStatusKey({
      storyId: pending.storyId,
      allowedFromStatuses: pending.allowedFromStatuses,
      targetStatus: pending.targetStatus,
      reportRevision: pending.reportRevision,
    }),
  };
}

function supportsDurableTbSync(storeApi) {
  return [
    "reserveTabTbSyncOperation",
    "beginTabTbSyncStepWrite",
    "recordTabTbSyncStep",
    "settleTabTbSyncOperation",
  ].every((name) => typeof storeApi?.[name] === "function");
}

function missingDurableTbSyncCapabilities(storeApi) {
  return [
    "reserveTabTbSyncOperation",
    "beginTabTbSyncStepWrite",
    "recordTabTbSyncStep",
    "settleTabTbSyncOperation",
  ].filter((name) => typeof storeApi?.[name] !== "function");
}

function tbSyncOperationError(result, fallback) {
  const error = new Error(String(result?.error || fallback || "TB durable operation failed"));
  error.code = String(result?.code || "TB_SYNC_OPERATION_FAILED");
  error.statusCode = Number(result?.statusCode || 409);
  error.operation = result?.operation || null;
  return error;
}

function tbSyncOperationMeta(operation, step, { readOnly = false } = {}) {
  const outbox = operation?.outbox?.[step] || {};
  return Object.freeze({
    operationId: String(operation?.operationId || ""),
    idempotencyKey: String(outbox.idempotencyKey || ""),
    fencingToken: Number(operation?.fencingToken || 0),
    step,
    stepKey: String(outbox.key || ""),
    readOnly: readOnly === true,
  });
}

function createDurableTbApi({
  baseApi,
  storeApi,
  tabId,
  pending,
  ownerToken,
  reservation,
}) {
  let operation = reservation.operation;
  const stepKeys = tbSyncStepKeysForPending(pending);
  const casArgs = () => ({
    tabId,
    operationId: operation.operationId,
    payloadSha256: operation.payloadSha256,
    ownerToken,
    fencingToken: operation.fencingToken,
  });
  const acceptMutation = (result, fallback) => {
    if (!result?.ok) throw tbSyncOperationError(result, fallback);
    if (result.operation) operation = result.operation;
    return result;
  };
  const completeFromRemoteRead = (step) => acceptMutation(storeApi.recordTabTbSyncStep({
    ...casArgs(),
    step,
    key: stepKeys[step],
    state: "completed",
  }), `TB ${step} remote confirmation could not be persisted`);
  const markAmbiguous = (step, reason) => {
    const result = storeApi.recordTabTbSyncStep({
      ...casArgs(),
      step,
      key: stepKeys[step],
      state: "ambiguous",
      reason,
    });
    if (result?.ok && result.operation) operation = result.operation;
    return result;
  };
  const writeOnce = async (step, invoke) => {
    const begun = acceptMutation(storeApi.beginTabTbSyncStepWrite({
      ...casArgs(),
      step,
      key: stepKeys[step],
    }), `TB ${step} write is already attempted; read-only reconciliation is required`);
    if (begun.allowed !== true) {
      return { ok: true, skipped: true, replayed: true };
    }
    const meta = tbSyncOperationMeta(operation, step);
    try {
      const result = await invoke(meta);
      if (result?.ok === false) {
        markAmbiguous(step, result?.error || `${step} write returned a failure`);
        return result;
      }
      acceptMutation(storeApi.recordTabTbSyncStep({
        ...casArgs(),
        step,
        key: stepKeys[step],
        state: "write_acknowledged",
      }), `TB ${step} acknowledgement could not be persisted`);
      return result;
    } catch (error) {
      markAmbiguous(step, error?.message || String(error));
      throw error;
    }
  };

  return {
    postComment: (text) => writeOnce("comment", (meta) => baseApi.postComment(text, meta)),
    findComments: async () => {
      const items = await baseApi.findComments(tbSyncOperationMeta(operation, "comment", { readOnly: true }));
      if (Array.isArray(items)
        && items.some((entry) => String(entry?.content ?? entry?.text ?? "") === pending.commentText.trim())) {
        completeFromRemoteRead("comment");
      }
      return items;
    },
    uploadAttachment: (absPath) => writeOnce(
      "attachment",
      (meta) => baseApi.uploadAttachment(absPath, meta),
    ),
    findAttachments: async () => {
      const items = await baseApi.findAttachments(tbSyncOperationMeta(operation, "attachment", { readOnly: true }));
      if (pending.attachment && Array.isArray(items)
        && items.some((entry) => (
          String(entry?.fileName ?? entry?.name ?? "") === pending.attachment.fileName
          && String(entry?.sha256 ?? "").toLowerCase() === pending.attachment.sha256
        ))) {
        completeFromRemoteRead("attachment");
      }
      return items;
    },
    currentStatus: async () => {
      const current = await baseApi.currentStatus(tbSyncOperationMeta(operation, "status", { readOnly: true }));
      const normalized = String(current || "").trim();
      if (normalized === pending.targetStatus || canonicalStatus(normalized) === pending.targetStatus) {
        completeFromRemoteRead("status");
      }
      return current;
    },
    flowStatus: (target) => writeOnce("status", (meta) => baseApi.flowStatus(target, meta)),
    operation: () => operation,
  };
}

function validateDurableTbSyncAttachment(storeApi, pending) {
  if (!pending.attachment) return;
  const sourceTab = storeApi.getTab(pending.attachment.sourceStoryId);
  if (!sourceTab) throw new Error("TB sync attachment source story does not exist");
  const sourceStorage = storeApi.getStoryStoragePaths(sourceTab, { create: false });
  storeApi.validateStoryStorageTarget(sourceTab, pending.attachment.absPath, {
    baseDirectory: sourceStorage.storyDirectory,
    mustExist: true,
    expectedType: "file",
  });
  if (sha256File(pending.attachment.absPath) !== pending.attachment.sha256) {
    throw new Error("TB sync attachment SHA-256 drifted");
  }
}

function replayedTbSyncResult(pending, ledger, tab) {
  return {
    ok: true,
    phase: pending.terminalPhase,
    pending,
    replayed: true,
    saga: {
      ok: true,
      pending: [],
      errors: [],
      ledger,
      steps: {
        comment: { status: "replayed", key: ledger.comment.key },
        attachment: pending.attachment
          ? { status: "replayed", key: ledger.attachment.key }
          : { status: "skipped", reason: "no attachment" },
        status: { status: "replayed", key: ledger.status.key },
      },
    },
    tab,
  };
}

async function runDurablePersistedTbSync(fresh, candidate, {
  expectedKind,
  sagaRunner,
  storeApi,
  api,
  ownerToken,
}) {
  const tbTaskId = tabTbTaskId(fresh);
  let pending;
  try {
    if (fresh.workflow?.tbSyncPending) {
      pending = validateStoredTbSyncPending(fresh.workflow.tbSyncPending, {
        storyId: fresh.id,
        tbTaskId,
        expectedKind,
      });
      if (candidate) {
        if (!tbSyncPendingMatchesCandidate(pending, { ...candidate, storyId: fresh.id, tbTaskId })) {
          return {
            ok: false,
            phase: "sync_pending",
            statusCode: 409,
            code: "TB_SYNC_OPERATION_PAYLOAD_CONFLICT",
            conflict: true,
            error: "TB sync already has a different immutable payload",
            pending,
          };
        }
      }
    } else {
      pending = sealTbSyncPending({ ...candidate, storyId: fresh.id, tbTaskId });
      if (expectedKind && pending.kind !== expectedKind) throw new Error("TB sync pending kind mismatch");
      if (fresh.workflow?.phase === pending.terminalPhase
        && completedLedgerMatches(pending, fresh.workflow?.tbSyncLedger)) {
        return replayedTbSyncResult(pending, fresh.workflow.tbSyncLedger, fresh);
      }
    }
    validateDurableTbSyncAttachment(storeApi, pending);
  } catch (error) {
    return { ok: false, phase: "sync_pending", error: error.message, pending: pending || null };
  }

  const reservation = storeApi.reserveTabTbSyncOperation({
    tabId: fresh.id,
    tbTaskId,
    pending,
    stepKeys: tbSyncStepKeysForPending(pending),
    ownerToken,
  });
  if (!reservation?.ok) {
    return {
      ok: false,
      phase: "sync_pending",
      statusCode: reservation?.statusCode || 409,
      code: reservation?.code || "TB_SYNC_OPERATION_PENDING",
      error: reservation?.error || "TB sync operation is pending",
      conflict: reservation?.conflict === true,
      durablePending: reservation?.pending === true,
      pending,
      operation: reservation?.operation || null,
      tab: reservation?.tab || fresh,
    };
  }
  if (reservation.replay === true) {
    return replayedTbSyncResult(pending, reservation.operation.ledger, reservation.tab || fresh);
  }

  const durableApi = createDurableTbApi({
    baseApi: api || defaultPersistedTbApi(reservation.tab || fresh, tbTaskId, pending),
    storeApi,
    tabId: fresh.id,
    pending,
    ownerToken,
    reservation,
  });
  let saga;
  try {
    saga = await sagaRunner({
      storyId: pending.storyId,
      tbTaskId: pending.tbTaskId,
      reportRevision: pending.reportRevision,
      shortReport: pending.commentText,
      attachment: pending.attachment,
      fromStatus: pending.allowedFromStatuses.join("|"),
      allowedFromStatuses: pending.allowedFromStatuses,
      targetStatus: pending.targetStatus,
      ledger: reservation.operation.ledger,
      canonicalizeStatus: canonicalStatus,
      operation: reservation.operation,
      api: durableApi,
    });
  } catch (error) {
    saga = {
      ok: false,
      pending: ["saga"],
      errors: [error.message],
      steps: {},
      ledger: durableApi.operation()?.ledger || reservation.operation.ledger,
    };
  }

  const settled = tbSyncResultComplete(pending, saga);
  const errors = Array.isArray(saga?.errors) ? saga.errors.map(String) : [];
  const error = errors.slice(0, 3).join("; ") || "TB sync is incomplete";
  const latestOperation = durableApi.operation();
  const settlement = storeApi.settleTabTbSyncOperation({
    tabId: fresh.id,
    operationId: latestOperation.operationId,
    payloadSha256: latestOperation.payloadSha256,
    ownerToken,
    fencingToken: latestOperation.fencingToken,
    completed: settled,
    pending,
    terminalPhase: pending.terminalPhase,
    terminalUpdates: pending.terminalUpdates,
    error,
  });
  if (!settlement?.ok) {
    return {
      ok: false,
      phase: "sync_pending",
      statusCode: settlement?.statusCode || 409,
      code: settlement?.code || "TB_SYNC_OPERATION_SETTLEMENT_FAILED",
      error: settlement?.error || error,
      pending,
      saga,
      operation: settlement?.operation || latestOperation,
    };
  }
  saga.ledger = settlement.operation?.ledger || saga.ledger;
  if (!settled) {
    return {
      ok: false,
      phase: "sync_pending",
      error,
      pending,
      saga,
      operation: settlement.operation,
      tab: settlement.tab,
    };
  }
  return {
    ok: true,
    phase: pending.terminalPhase,
    pending,
    saga,
    operation: settlement.operation,
    tab: settlement.tab,
  };
}

/**
 * 先持久化不可变 TB 同步 payload，再执行可重入 Saga。重试时忽略新文案/新附件，
 * 只复用首次持久化的 comment/hash/revision。
 */
export async function runPersistedTbSync(tab, candidate = null, {
  expectedKind = "",
  sagaRunner = runTbSyncSaga,
  storeApi = store,
  api = null,
  ownerToken = TB_SYNC_PROCESS_OWNER_TOKEN,
  // Explicit compatibility escape hatch for isolated unit-test fake stores.
  // Production callers must keep the default fail-closed behavior.
  allowVolatileTestStore = false,
} = {}) {
  if (!tab?.id) return { ok: false, phase: "sync_pending", error: "故事点不存在" };
  return withTbSyncLock(tab.id, async () => {
    let fresh = storeApi.getTab(tab.id) || tab;
    const tbTaskId = tabTbTaskId(fresh);
    if (!tbTaskId) return { ok: false, phase: "sync_pending", error: "该故事点未关联 TB 单" };

    if (supportsDurableTbSync(storeApi)) {
      return runDurablePersistedTbSync(fresh, candidate, {
        expectedKind,
        sagaRunner,
        storeApi,
        api,
        ownerToken,
      });
    }

    if (allowVolatileTestStore !== true) {
      const missingCapabilities = missingDurableTbSyncCapabilities(storeApi);
      return {
        ok: false,
        phase: "sync_pending",
        statusCode: 503,
        code: "TB_SYNC_DURABLE_STORE_REQUIRED",
        blocked: true,
        durableBlocked: true,
        error: `TB sync requires durable reservation/outbox capabilities: ${missingCapabilities.join(", ")}`,
        missingCapabilities,
        tab: fresh,
      };
    }

    let pending;
    try {
      if (fresh.workflow?.tbSyncPending) {
        pending = validateStoredTbSyncPending(fresh.workflow.tbSyncPending, {
          storyId: fresh.id,
          tbTaskId,
          expectedKind,
        });
      } else {
        pending = sealTbSyncPending({ ...candidate, storyId: fresh.id, tbTaskId });
        if (expectedKind && pending.kind !== expectedKind) throw new Error("TB 同步 pending kind 不匹配");
        if (fresh.workflow?.phase === pending.terminalPhase
          && completedLedgerMatches(pending, fresh.workflow?.tbSyncLedger)) {
          return {
            ok: true,
            phase: pending.terminalPhase,
            pending,
            replayed: true,
            saga: {
              ok: true,
              pending: [],
              errors: [],
              ledger: fresh.workflow.tbSyncLedger,
              steps: {
                comment: { status: "replayed", key: fresh.workflow.tbSyncLedger.comment.key },
                attachment: pending.attachment
                  ? { status: "replayed", key: fresh.workflow.tbSyncLedger.attachment.key }
                  : { status: "skipped", reason: "无附件" },
                status: { status: "replayed", key: fresh.workflow.tbSyncLedger.status.key },
              },
            },
            tab: fresh,
          };
        }
        storeApi.updateTab(fresh.id, {
          workflow: {
            ...(fresh.workflow || {}),
            enabled: true,
            phase: "sync_pending",
            tbSyncPending: cloneJson(pending),
            reportError: null,
          },
        });
        fresh = storeApi.getTab(fresh.id) || fresh;
        pending = validateStoredTbSyncPending(fresh.workflow?.tbSyncPending, {
          storyId: fresh.id,
          tbTaskId,
          expectedKind,
        });
      }
    } catch (error) {
      const workflow = storeApi.getTab(fresh.id)?.workflow || fresh.workflow || {};
      storeApi.updateTab(fresh.id, {
        workflow: { ...workflow, enabled: true, phase: "sync_pending", reportError: error.message },
      });
      return { ok: false, phase: "sync_pending", error: error.message, pending: null };
    }

    if (pending.attachment) {
      try {
        const sourceTab = storeApi.getTab(pending.attachment.sourceStoryId);
        if (!sourceTab) throw new Error("TB 同步附件来源故事点不存在");
        const sourceStorage = storeApi.getStoryStoragePaths(sourceTab, { create: false });
        storeApi.validateStoryStorageTarget(sourceTab, pending.attachment.absPath, {
          baseDirectory: sourceStorage.storyDirectory,
          mustExist: true,
          expectedType: "file",
        });
        if (sha256File(pending.attachment.absPath) !== pending.attachment.sha256) {
          throw new Error("TB 同步附件 SHA-256 已漂移");
        }
      } catch (error) {
        const workflow = storeApi.getTab(fresh.id)?.workflow || fresh.workflow || {};
        storeApi.updateTab(fresh.id, {
          workflow: {
            ...workflow,
            enabled: true,
            phase: "sync_pending",
            tbSyncPending: cloneJson(pending),
            reportError: error.message,
          },
        });
        return { ok: false, phase: "sync_pending", error: error.message, pending };
      }
    }

    let saga;
    try {
      saga = await sagaRunner({
        storyId: pending.storyId,
        tbTaskId: pending.tbTaskId,
        reportRevision: pending.reportRevision,
        shortReport: pending.commentText,
        attachment: pending.attachment,
        fromStatus: pending.allowedFromStatuses.join("|"),
        allowedFromStatuses: pending.allowedFromStatuses,
        targetStatus: pending.targetStatus,
        ledger: fresh.workflow?.tbSyncLedger,
        canonicalizeStatus: canonicalStatus,
        api: api || defaultPersistedTbApi(fresh, tbTaskId, pending),
      });
    } catch (error) {
      saga = { ok: false, pending: ["saga"], errors: [error.message], steps: {}, ledger: fresh.workflow?.tbSyncLedger || null };
    }

    const settled = tbSyncResultComplete(pending, saga);
    const workflow = storeApi.getTab(fresh.id)?.workflow || fresh.workflow || {};
    if (!settled) {
      const errors = Array.isArray(saga?.errors) ? saga.errors.map(String) : [];
      const error = errors.slice(0, 3).join("；") || "TB 同步未完成";
      storeApi.updateTab(fresh.id, {
        workflow: {
          ...workflow,
          enabled: true,
          phase: "sync_pending",
          tbSyncPending: cloneJson(pending),
          tbSyncLedger: saga?.ledger || workflow.tbSyncLedger || null,
          reportError: error,
        },
      });
      return { ok: false, phase: "sync_pending", error, pending, saga };
    }

    const completedWorkflow = {
      ...workflow,
      ...pending.terminalUpdates,
      enabled: true,
      phase: pending.terminalPhase,
      tbSyncLedger: saga.ledger,
      reportError: null,
    };
    delete completedWorkflow.tbSyncPending;
    storeApi.updateTab(fresh.id, { workflow: completedWorkflow });
    return { ok: true, phase: pending.terminalPhase, pending, saga, tab: storeApi.getTab(fresh.id) || fresh };
  });
}

export function __testSealTbSyncPending(input) {
  return sealTbSyncPending(input);
}

function freezeTbSyncAttachment(sourceTab, artifact, { storeApi = store } = {}) {
  if (!artifact) return null;
  const rawPath = String(artifact.absPath || "").trim();
  if (!sourceTab?.id || !rawPath || !path.isAbsolute(rawPath)) {
    throw new Error("TB 同步附件必须绑定来源故事点内的绝对文件路径");
  }
  const absPath = path.resolve(rawPath);
  const storage = storeApi.getStoryStoragePaths(sourceTab, { create: false });
  storeApi.validateStoryStorageTarget(sourceTab, absPath, {
    baseDirectory: storage.storyDirectory,
    mustExist: true,
    expectedType: "file",
  });
  const actualSha256 = sha256File(absPath);
  const suppliedSha256 = String(artifact.sha256 || "").trim().toLowerCase();
  if (suppliedSha256 && suppliedSha256 !== actualSha256) {
    throw new Error("TB 同步附件描述中的 SHA-256 与实际字节不一致");
  }
  return {
    sourceStoryId: sourceTab.id,
    absPath,
    fileName: String(artifact.fileName || path.basename(absPath)).trim(),
    sha256: actualSha256,
  };
}

function tbSyncRevision(kind, tab, { basis = null, commentText = "", attachment = null } = {}) {
  const digest = canonicalSha256({
    kind,
    storyId: String(tab?.id || ""),
    basis,
    commentText: String(commentText || ""),
    attachment: attachment ? { fileName: attachment.fileName, sha256: attachment.sha256 } : null,
  });
  return `${kind}-${digest.slice(0, 48)}`;
}

function buildReportTbSyncCandidate(tab, {
  sourceTab = tab,
  commentText,
  artifact = null,
  reportMode = "short",
  htmlRel = null,
  pdfRel = null,
  reportedAt = Date.now(),
  group = false,
  basis = null,
  storeApi = store,
} = {}) {
  const mode = reportMode === "expert" ? "expert" : "short";
  const attachment = mode === "expert"
    ? freezeTbSyncAttachment(sourceTab, artifact, { storeApi })
    : null;
  if (mode === "expert" && !attachment) throw new Error("专家报告缺少可冻结的 PDF 附件");
  const terminalUpdates = {
    reportedAt,
    reportHtmlRel: mode === "expert" ? htmlRel : null,
    reportPdfRel: mode === "expert" ? (pdfRel || artifact?.rel || null) : null,
  };
  if (group) terminalUpdates.groupReportedAt = reportedAt;
  return {
    kind: "report",
    reportRevision: tbSyncRevision("report", tab, { basis, commentText, attachment }),
    commentText,
    attachment,
    allowedFromStatuses: ["待处理", "待确认", "修复中"],
    targetStatus: "可提测",
    terminalPhase: "testable",
    reportMode: mode,
    terminalUpdates,
    createdAt: reportedAt,
  };
}

function buildRejectTbSyncCandidate(tab, pendingReject, {
  rejectedAt = Date.now(),
  storeApi = store,
} = {}) {
  const artifact = pendingReject?.detailAbsPath
    ? { absPath: pendingReject.detailAbsPath, rel: pendingReject.detailRel || null }
    : null;
  const attachment = freezeTbSyncAttachment(tab, artifact, { storeApi });
  const commentText = `🤖 AI 自动工作流\n\n${String(pendingReject?.shortReport || pendingReject?.reason || "")}`;
  return {
    kind: "reject",
    reportRevision: tbSyncRevision("reject", tab, {
      basis: pendingReject?.at || null,
      commentText,
      attachment,
    }),
    commentText,
    attachment,
    allowedFromStatuses: ["待处理", "待确认", "修复中"],
    targetStatus: "已拒绝",
    terminalPhase: "rejected",
    reportMode: attachment ? "expert" : "short",
    terminalUpdates: { rejectedAt },
    createdAt: rejectedAt,
  };
}

export function __testBuildReportTbSyncCandidate(tab, options) {
  return buildReportTbSyncCandidate(tab, options);
}

export function __testBuildRejectTbSyncCandidate(tab, pendingReject, options) {
  return buildRejectTbSyncCandidate(tab, pendingReject, options);
}

/**
 * 仅当 TB 单当前状态属于 allowedLogicals 之一时，才流转到 target 逻辑状态。
 * 返回 { ok, skipped?, from?, to?, error? }。
 */
async function flowIfAllowed(tbTaskId, target, allowedLogicals, storyId = null) {
  let cur;
  try {
    cur = await getTaskStatusName(tbTaskId);
  } catch (error) {
    const result = { ok: false, from: null, to: target, error: `当前状态读取失败：${error.message}` };
    observeTbWrite(storyId, tbTaskId, "status", { logicalName: target }, result, error);
    return result;
  }
  if (cur?.ok !== true || !String(cur?.statusName || "").trim()) {
    const result = { ok: false, from: null, to: target, error: String(cur?.error || "当前状态不可确认") };
    observeTbWrite(storyId, tbTaskId, "status", { logicalName: target }, result);
    return result;
  }
  const logical = canonicalStatus(cur.statusName);
  if (!logical) {
    const result = { ok: false, from: cur.statusName, to: target, error: "当前 TB 状态无法映射，拒绝盲目流转" };
    observeTbWrite(storyId, tbTaskId, "status", { logicalName: target }, result);
    return result;
  }
  if (!allowedLogicals.includes(logical)) {
    const result = { ok: true, skipped: true, from: cur.statusName, to: target, reason: "当前状态不在允许流转的集合内" };
    observeTbWrite(storyId, tbTaskId, "status", { logicalName: target }, result);
    return result;
  }
  return await updateTaskStatus(tbTaskId, target, storyId);
}

function compactPlainText(value) {
  return String(value || "")
    .replace(/<!--[^]*?-->/g, " ")
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/[`*_>#|]/g, " ")
    .replace(/^\s*[-+•]\s*/gm, "")
    .replace(/(?:经\s*AI\s*分析|AI\s*分析(?:认为)?|经分析(?:认为)?|经研判|综上所述)\s*[,，:：]?\s*/gi, "")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{2,}/g, "\n")
    .trim();
}

function limitPlainText(value, max = 180) {
  const text = compactPlainText(value).replace(/\s*\n\s*/g, " ").trim();
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(1, max - 1)).replace(/[，。；、\s]+$/g, "")}…`;
}

function shortTbReportFields(report) {
  const text = compactPlainText(report)
    .replace(/^(?:简短报告|问题分析总结|结论)\s*[:：]?\s*/i, "")
    .trim();
  const cause = text.match(/(?:^|\n)\s*(?:问题原因|根本原因|根因|原因)\s*[:：]\s*([\s\S]*?)(?=(?:\n|\s)+(?:解决措施|处理措施|改进措施|修复措施|措施|解决方案)\s*[:：]|$)/i)?.[1] || "";
  const action = text.match(/(?:^|\n|\s)(?:解决措施|处理措施|改进措施|修复措施|措施|解决方案)\s*[:：]\s*([\s\S]*)$/i)?.[1] || "";
  return { text, cause: cause.trim(), action: action.trim() };
}

const GENERIC_SHORT_REPORT_VALUE = /^(?:任务状态[:：]?\s*(?:已完成|部分完成|未完成)|任务已完成|问题原因已定位|已完成对应修复并加强检查|[\w#-]*\s*简短报告与提测收尾完成)[。！! ]*$/i;
const GENERIC_SHORT_REPORT_TOKENS = /(?:任务状态|简短报告|提测收尾|问题原因|解决方案|处理措施|修复措施|改进措施|相关工作|相关问题|本次|此次|上述|任务|工作|状态|报告|提测|验收|收尾|评论|流程|提交|整理|内容|问题|原因|措施|处理|修复|解决|定位|完成|成功|完毕|执行|进行|已经|相关|对应|发现|结果|通过|已|了|并)/gi;
const CONCRETE_CAUSE_SIGNAL = /(?:未|没有|无法|不能|不一致|不同步|异常|错误|失败|崩溃|闪退|卡死|遗漏|漏|缺少|丢失|冲突|重复|超时|写死|固定|误(?:把|判|投|触发)?|只|仅|一直|导致|因为|由于|占用|竞争|残留|失效|越界|空指针)/i;
const CONCRETE_ACTION_TERMS = ["新增", "增加", "加入", "补充", "修改", "改为", "调整", "更新", "同步", "刷新", "清理", "释放", "移除", "删除", "替换", "重构", "修正", "修复", "校验", "判空", "拦截", "阻断", "阻止", "限制", "统一", "复用", "接入", "绑定", "解除", "恢复", "重试", "关闭", "开启", "保存", "保留", "透传", "注入", "跟随", "跟着", "联动", "兜底", "回滚", "收紧", "过滤", "防止", "避免", "结束", "停止", "终止", "退出", "跳过", "短路"];
const CONCRETE_ACTION_SIGNAL = new RegExp(`(?:${CONCRETE_ACTION_TERMS.join("|")})`, "i");

function concreteReportText(value) {
  return compactPlainText(value)
    .replace(/\s+/g, "")
    .replace(/\bCARB-\d+\b/gi, "")
    .replace(GENERIC_SHORT_REPORT_TOKENS, "")
    .replace(/[^\p{L}\p{N}]/gu, "");
}

function hasConcreteShortReportValue(value, kind) {
  const text = compactPlainText(value)
    .replace(/\s+/g, "")
    .replace(/\bCARB-\d+\b/gi, "");
  if (text.length < 4 || concreteReportText(text).length < 3) return false;
  // 原因必须说出一种实际故障/因果关系，措施必须说出一种实际改动动作。
  // 这比枚举“办妥/落实/到位”等无穷同义空话稳定，同时允许“空指针崩溃 /
  // 增加判空”“缓存未清 / 清理缓存”这类短而具体的报告。
  return kind === "cause"
    ? CONCRETE_CAUSE_SIGNAL.test(text)
    : CONCRETE_ACTION_SIGNAL.test(text);
}

function evidenceNgrams(value) {
  const text = concreteReportText(value).toLowerCase();
  const grams = new Set();
  for (let i = 0; i < text.length - 1; i++) grams.add(text.slice(i, i + 2));
  return grams;
}

function hasReportEvidenceOverlap(fields, evidence) {
  const expected = evidenceNgrams(evidence);
  if (!expected.size) return false;
  const actual = evidenceNgrams(`${fields.cause}${fields.action}`);
  let overlap = 0;
  for (const gram of actual) {
    if (expected.has(gram)) overlap++;
  }
  if (overlap < 4) return false;

  const evidenceFields = shortTbReportFields(evidence);
  const evidenceAction = evidenceFields.action || evidence;
  const expectedActions = new Set(CONCRETE_ACTION_TERMS.filter((term) => evidenceAction.includes(term)));
  return CONCRETE_ACTION_TERMS.some((term) => fields.action.includes(term) && expectedActions.has(term));
}

export function validateShortTbReport(report, options = {}) {
  const fields = shortTbReportFields(report);
  const missing = [];
  if (!fields.cause) missing.push("原因");
  if (!fields.action) missing.push("措施");
  if (fields.cause && (GENERIC_SHORT_REPORT_VALUE.test(compactPlainText(fields.cause)) || !hasConcreteShortReportValue(fields.cause, "cause"))) missing.push("具体原因");
  if (fields.action && (GENERIC_SHORT_REPORT_VALUE.test(compactPlainText(fields.action)) || !hasConcreteShortReportValue(fields.action, "action"))) missing.push("具体措施");
  if (options.requireEvidence === true && !hasReportEvidenceOverlap(fields, options.evidence || "")) missing.push("修复事实依据");
  return {
    ok: missing.length === 0,
    missing: [...new Set(missing)],
    cause: fields.cause,
    action: fields.action,
  };
}

// 简短模式写入 TB 的最终文案：固定为“原因 + 措施”，去掉 markdown、AI 自述和报告腔。
// 内容本身由报告轮生成；这里只做确定性的格式收敛和长度保护。
export function formatShortTbComment(report, { testAcceptanceSkipped = false } = {}) {
  const { text, cause, action } = shortTbReportFields(report);
  const fallback = text.split(/\n|(?<=[。！？；])\s*/).map((line) => line.trim()).filter(Boolean);
  const finalCause = limitPlainText(cause || fallback[0] || "问题原因已定位", 140);
  const finalAction = limitPlainText(action || fallback.find((line) => line !== fallback[0]) || "已完成对应修复并加强检查", 140);
  return `原因：${finalCause}\n措施：${finalAction}${testAcceptanceSkipped ? "\n测试验收：已按用户选择跳过，本轮未执行。" : ""}`;
}

function invalidTbCommentsForSubmission(tab, wf) {
  const current = store.getTab(tab.id) || tab;
  const contextItems = current.workflow?.groupAcceptanceContext?.items || [];
  const members = current.groupId ? store.getGroupMembers(current.groupId) : [];
  const grouped = contextItems.length > 1 && members.length > 1;
  const targets = grouped ? members : [current];
  return targets
    .map((member) => {
      const source = grouped
        ? (wf.memberShortReports?.[member.id] || member.workflow?.fixShortReport || wf.shortReport || "")
        : (wf.shortReport || "");
      // “修复事实依据”要求简短报告与既有验收/修复事实有实质重合，防止 AI 编造。
      // 但没有自测验收时（未绑定设备跳过验收、或仍在修复阶段直接出报告），
      // 没有验收报告可作为对照证据，此时只校验“原因 + 措施”是否具体，
      // 不再强制 bigram 重合，避免 AI 合理的重新措辞被误判为缺少依据而死循环。
      const validation = validateShortTbReport(source, {
        requireEvidence: wf.deterministic !== true && hasSelfAcceptancePassed(member),
        evidence: member.workflow?.fixShortReport || "",
      });
      return {
        tabId: member.id,
        label: tabCarbId(member) || member.title || member.id,
        validation,
      };
    })
    .filter((item) => !item.validation.ok);
}

function groupMemberSummaryComment(member, memberWorkflow, groupShortReport, fallbackAttachRel) {
  const id = tabCarbId(member) || tabTbTaskId(member) || member.id;
  const testAcceptanceSkipped = isTestAcceptanceSkipped(member) && !Number(memberWorkflow?.verifyPassedAt);
  const lines = [
    `🤖 AI 自动工作流 - 故事点组开发完成`,
    ``,
    `本 TB 单：${id} ${member.title || ""}`.trim(),
    testAcceptanceSkipped
      ? `整组已完成开发；测试验收已按用户选择跳过、本轮未执行，当前进入提测流程。`
      : `整组已完成开发并通过统一自测验收，当前进入提测流程。`,
  ];
  if (memberWorkflow?.fixShortReport) {
    lines.push(``, `## 本单开发完成总结`, memberWorkflow.fixShortReport);
  }
  if (groupShortReport) {
    lines.push(``, `## 整组验收摘要`, groupShortReport);
  }
  if (memberWorkflow?.fixReportRel) lines.push(``, `本评论附件为本 TB 单的开发完成总结：${memberWorkflow.fixReportRel}`);
  else if (fallbackAttachRel) lines.push(``, `本评论附件为整组统一验收报告：${fallbackAttachRel}`);
  return lines.join("\n");
}

async function syncGroupReportDoneToTb(tab, wf, finalAttach, pdf, htmlRel = null, {
  storeApi = store,
  sagaRunner = runTbSyncSaga,
  apiFactory = null,
  allowVolatileTestStore = false,
} = {}) {
  const current = storeApi.getTab(tab.id) || tab;
  const ctxItems = current.workflow?.groupAcceptanceContext?.items || [];
  const members = current.groupId ? storeApi.getGroupMembers(current.groupId) : [];
  if (!current.groupId || ctxItems.length <= 1 || members.length <= 1) return null;

  const results = [];
  const reportedAt = Date.now();
  for (const member of members) {
    const freshMember = storeApi.getTab(member.id) || member;
    const memberWorkflow = freshMember.workflow || {};
    const taskId = tabTbTaskId(freshMember);
    const reportMode = getReportMode(freshMember);
    const result = {
      tabId: freshMember.id,
      title: freshMember.title || "",
      tbTaskId: taskId,
      statusFlow: null,
      commentOk: false,
      uploadOk: false,
      reportMode,
      attachmentRequired: reportMode === "expert",
      attachmentSkipped: reportMode !== "expert",
      detailRel: memberWorkflow.fixReportRel || null,
      errors: [],
    };

    if (!taskId) {
      result.errors.push("未关联 TB 单，无法同步");
      storeApi.updateTab(freshMember.id, {
        workflow: {
          ...memberWorkflow,
          enabled: true,
          phase: "sync_pending",
          reportError: result.errors[0],
          groupTbSync: result,
        },
      });
      results.push(result);
      continue;
    }

    const attach = result.attachmentRequired ? (finalAttach || null) : null;
    const comment = result.reportMode === "short"
      ? (wf.deterministic === true && wf.memberShortReports?.[freshMember.id]
        ? wf.memberShortReports[freshMember.id]
        : formatShortTbComment(memberWorkflow.fixShortReport || wf.shortReport || "", {
          testAcceptanceSkipped: isTestAcceptanceSkipped(freshMember) && !Number(memberWorkflow.verifyPassedAt),
        }))
      : groupMemberSummaryComment(freshMember, memberWorkflow, wf.shortReport || "", attach?.rel || pdf?.rel || null);
    try {
      const candidate = buildReportTbSyncCandidate(freshMember, {
        sourceTab: current,
        commentText: comment,
        artifact: attach,
        reportMode,
        htmlRel,
        pdfRel: pdf?.rel || attach?.rel || null,
        reportedAt,
        group: true,
        basis: {
          groupId: current.groupId,
          groupVerifiedAt: current.workflow?.verifyPassedAt || current.workflow?.verifiedAt || null,
          memberFixedAt: memberWorkflow.fixedAt || null,
        },
        storeApi,
      });
      const sync = await runPersistedTbSync(freshMember, candidate, {
        expectedKind: "report",
        sagaRunner,
        storeApi,
        api: typeof apiFactory === "function" ? apiFactory(freshMember, candidate) : null,
        allowVolatileTestStore,
      });
      result.statusFlow = sync.saga?.steps?.status || null;
      result.commentOk = TB_SYNC_STEP_SUCCESS.has(String(sync.saga?.steps?.comment?.status || ""));
      result.uploadOk = reportMode === "short"
        || (TB_SYNC_STEP_SUCCESS.has(String(sync.saga?.steps?.attachment?.status || ""))
          && String(sync.saga?.steps?.attachment?.status || "") !== "skipped");
      result.detailRel = reportMode === "expert" ? (attach?.rel || result.detailRel) : result.detailRel;
      if (!sync.ok) result.errors.push(sync.error || "TB 同步未完成");
      result.ok = sync.ok === true;
      result.pending = Array.isArray(sync.saga?.pending) ? [...sync.saga.pending] : [];
    } catch (error) {
      result.errors.push(error.message);
      result.ok = false;
      const workflow = storeApi.getTab(freshMember.id)?.workflow || memberWorkflow;
      storeApi.updateTab(freshMember.id, {
        workflow: { ...workflow, enabled: true, phase: "sync_pending", reportError: error.message },
      });
    }
    const afterWorkflow = storeApi.getTab(freshMember.id)?.workflow || memberWorkflow;
    storeApi.updateTab(freshMember.id, {
      workflow: { ...afterWorkflow, groupTbSync: result },
    });
    results.push(result);
  }

  const failed = results.filter((item) => item.ok !== true);
  return { ok: failed.length === 0, results, total: results.length, failed: failed.length };
}

export async function __testSyncGroupReportDoneToTb(tab, wf, finalAttach, pdf, htmlRel, options) {
  return syncGroupReportDoneToTb(tab, wf, finalAttach, pdf, htmlRel, options);
}

export async function resumePendingTbSync(tabId, {
  storeApi = store,
  sagaRunner = runTbSyncSaga,
  api = null,
  apiFactory = null,
  notify = true,
  allowVolatileTestStore = false,
} = {}) {
  const tab = storeApi.getTab(tabId);
  if (!tab) return { ok: false, phase: "sync_pending", error: "故事点不存在" };
  const contextItems = tab.workflow?.groupAcceptanceContext?.items || [];
  const members = tab.groupId ? storeApi.getGroupMembers(tab.groupId) : [];
  const grouped = contextItems.length > 1 && members.length > 1;

  if (grouped) {
    const previous = new Map((tab.workflow?.groupTbSyncSummary?.results || []).map((item) => [item.tabId, item]));
    const results = [];
    for (const member of members) {
      const fresh = storeApi.getTab(member.id) || member;
      const storedPending = fresh.workflow?.tbSyncPending;
      let resumed;
      if (storedPending?.kind === "report") {
        resumed = await runPersistedTbSync(fresh, null, {
          expectedKind: "report",
          sagaRunner,
          storeApi,
          api: typeof apiFactory === "function" ? apiFactory(fresh, storedPending) : api,
          allowVolatileTestStore,
        });
      } else if (fresh.workflow?.phase === "testable" || previous.get(fresh.id)?.ok === true) {
        resumed = { ok: true, phase: "testable", saga: null };
      } else {
        resumed = {
          ok: false,
          phase: "sync_pending",
          error: fresh.workflow?.reportError || "该组员没有可恢复的冻结 TB 同步 payload",
          saga: null,
        };
      }
      const prior = previous.get(fresh.id) || {};
      const item = {
        ...prior,
        tabId: fresh.id,
        title: fresh.title || prior.title || "",
        tbTaskId: tabTbTaskId(fresh),
        ok: resumed.ok === true,
        statusFlow: resumed.saga?.steps?.status || prior.statusFlow || null,
        commentOk: resumed.saga
          ? TB_SYNC_STEP_SUCCESS.has(String(resumed.saga.steps?.comment?.status || ""))
          : prior.commentOk === true,
        uploadOk: resumed.saga
          ? (!storedPending?.attachment
            || (TB_SYNC_STEP_SUCCESS.has(String(resumed.saga.steps?.attachment?.status || ""))
              && resumed.saga.steps?.attachment?.status !== "skipped"))
          : prior.uploadOk === true,
        pending: resumed.saga?.pending || [],
        errors: resumed.ok ? [] : [resumed.error || "TB 同步未完成"],
      };
      const memberWorkflow = storeApi.getTab(fresh.id)?.workflow || fresh.workflow || {};
      storeApi.updateTab(fresh.id, { workflow: { ...memberWorkflow, groupTbSync: item } });
      results.push(item);
    }
    const failed = results.filter((item) => item.ok !== true);
    const groupSync = { ok: failed.length === 0, results, total: results.length, failed: failed.length, resumed: true };
    const leader = storeApi.getTab(tabId) || tab;
    const phase = groupSync.ok ? "testable" : "sync_pending";
    const error = groupSync.ok ? null : `整组 TB 同步未完成：${failed.length}/${results.length} 个故事点待续跑`;
    storeApi.updateTab(tabId, {
      workflow: {
        ...(leader.workflow || {}),
        enabled: true,
        phase,
        groupTbSyncSummary: groupSync,
        reportError: error,
      },
    });
    if (notify) {
      pushWorkflowMsg(leader, {
        level: groupSync.ok ? "success" : "warn",
        title: groupSync.ok ? "整组 TB 同步续跑完成" : "整组 TB 同步仍有未确认步骤",
        body: groupSync.ok
          ? `已确认 ${results.length}/${results.length} 个故事点的评论、附件和状态。`
          : `${error}。已成功的步骤不会重复执行。`,
        alert: { kind: phase, groupSync },
      });
    }
    return { ok: groupSync.ok, phase, resumed: true, groupSync, ...(error ? { error } : {}) };
  }

  const storedPending = tab.workflow?.tbSyncPending;
  if (!storedPending) {
    return { ok: false, phase: "sync_pending", error: "没有可恢复的 TB 同步 payload" };
  }
  if (storedPending.kind === "reject") {
    return confirmReject(tabId, { storeApi, sagaRunner, api, allowVolatileTestStore });
  }
  const result = await runPersistedTbSync(tab, null, {
    expectedKind: "report",
    sagaRunner,
    storeApi,
    api,
    allowVolatileTestStore,
  });
  if (notify) {
    const fresh = storeApi.getTab(tabId) || tab;
    pushWorkflowMsg(fresh, {
      level: result.ok ? "success" : "warn",
      title: result.ok ? "TB 同步续跑完成" : "TB 同步仍有未确认步骤",
      body: result.ok
        ? "评论、附件（如有）和状态均已由远端回读确认。"
        : `${result.error || "TB 同步未完成"}。已成功的步骤不会重复执行。`,
      alert: { kind: result.ok ? "testable" : "sync_pending", syncPending: result.saga || null },
    });
  }
  return { ...result, resumed: true };
}

function pushWorkflowMsg(tab, { level = "info", title, body, alert = null }) {
  const content = body ? `**${title}**\n\n${body}` : `**${title}**`;
  try {
    store.appendMessage(tab.id, { role: "assistant", content, workflow: { level, title, alert } });
  } catch {}
  broadcastChatMessage({
    role: "assistant",
    content,
    session_id: tab.sessionId,
    workflow: { level, title, alert },
    created_at: new Date().toISOString(),
  });
}

// ========== 对外：点「执行开发」时调用 ==========

/**
 * 执行开发起步：待处理 → 待确认（仅当前为待处理类才动）。返回流转结果。
 * 注意：这里只做"认领/状态流转"，不触发任何 AI 分析——是否自动甄别由调用方按 autoMode 决定。
 * phase 置为 "claimed"（已认领、待甄别）；若该故事点早已甄别过则保留原 phase 不回退。
 */
export async function onStartDev(tab) {
  const tbTaskId = tabTbTaskId(tab);
  if (!tbTaskId) return { ok: false, error: "非 TB 单，跳过工作流" };
  const r = await flowIfAllowed(tbTaskId, "待确认", ["待处理"], tab.id);
  const wf = tab.workflow || {};
  store.updateTab(tab.id, {
    workflow: {
      ...wf,
      enabled: true,
      autoMode: wf.autoMode === "full" ? "full" : "semi", // 默认半自动
      phase: isTriageDone(tab) ? wf.phase : "claimed",
      startedAt: wf.startedAt || Date.now(),
    },
  });
  recordActualConfigUsage(store.getTab(tab.id) || tab);
  if (r.ok && !r.skipped) log("system", "info", "devbench", `[${tab.title}] TB 状态 ${r.from} → ${r.to}`);
  return r;
}

// ========== 对外：sendTurn 结果里解析到工作流标记后调用 ==========

/**
 * 处理 AI 回复中的工作流标记。返回附加到聊天消息的 workflow 摘要（供前端渲染），或 null。
 * - triage_not_bug：生成报告 + 醒目提示 + 挂起待确认拒绝（不立即写 TB）
 * - triage_is_bug ：(待处理|待确认) → 修复中
 * - fix_done      ：生成报告 →(待处理|待确认|修复中)→ 可提测 + 评论 + 附件（自动）
 */
async function applyWorkflowInternal(tab, wf) {
  const tbTaskId = tabTbTaskId(tab);
  if (!tbTaskId) return null;

  if (wf.kind === "triage_not_bug") {
    const detail = writeDetailReport(tab, "triage_not_bug", wf.detailReport);
    const pendingReject = {
      shortReport: wf.shortReport || "",
      detailRel: detail?.rel || null,
      detailAbsPath: detail?.absPath || null,
      reason: wf.shortReport || "",
      lesson: wf.lesson || null, // 拒绝经验在用户「确认拒绝」时才正式沉淀
      at: Date.now(),
    };
    store.updateTab(tab.id, { workflow: { ...(tab.workflow || {}), enabled: true, phase: "reject_pending", pendingReject } });
    pushWorkflowMsg(tab, {
      level: "warn",
      title: "⚠️ 经甄别：这可能不是客户端/应用市场的问题",
      body: `已暂停修复。原因摘要：\n\n${wf.shortReport || "(见上方分析)"}\n\n如确认拒绝该 TB 单，请点击下方「确认拒绝」——届时才会把状态切为「已拒绝」并写入评论与附件。`,
      alert: { kind: "reject_pending", detailRel: detail?.rel || null },
    });
    return { phase: "reject_pending", kind: wf.kind, detailRel: detail?.rel || null };
  }

  if (wf.kind === "triage_is_bug") {
    const r = await flowIfAllowed(tbTaskId, "修复中", ["待处理", "待确认"], tab.id);
    store.updateTab(tab.id, { workflow: { ...(tab.workflow || {}), enabled: true, phase: "fixing", triagedAt: Date.now() } });
    recordActualConfigUsage(store.getTab(tab.id) || tab);
    const statusLine = r.ok
      ? (r.skipped ? `TB 状态当前为「${r.from}」。` : `TB 状态已切为「${r.to}」。`)
      : `TB 状态同步失败（${r.error}），请稍后手动处理。`;
    pushWorkflowMsg(tab, {
      level: "info",
      title: "✅ 经甄别：确认为需在本侧修复的问题",
      // 半自动：甄别只下结论，实际修复由用户继续发消息推进（不会自动改代码）
      body: `${statusLine}\n\n👉 请在下方继续发消息让 AI 开始修复（例如「按你上面的定位开始修复并自测」）。修复完成时它会自动生成报告、把 TB 切「可提测」并沉淀经验。`,
      alert: { kind: "fixing", statusFlow: r },
    });
    return { phase: "fixing", kind: wf.kind, statusFlow: r };
  }

  // 第二步收尾：代码修复完成 → 不再直接「可提测」，而是进入第三步【自我验收】。
  // 自我验收必须在 TB 指定机型上打 debug/release 包复现验证：未绑定设备 → 半自动暂停并醒目提示。
  if (wf.kind === "fix_done") {
    const detail = writeDetailReport(tab, "fix_done", wf.detailReport);
    // 修复经验先沉淀（验收/报告完成不再重复沉淀）
    const savedLesson = persistLesson(tab, "fix_done", wf.lesson, detail?.rel);
    // 配置记忆：本次成功解决用到的"TB信号→工程配置"沉淀，供后续新建故事点自动推荐
    try { recordConfigMemory(store.getTab(tab.id) || tab); } catch {}
    const fresh = store.getTab(tab.id) || tab;
    recordActualConfigUsage(fresh, "success");
    const groupResult = handleGroupFixDone(fresh, wf, detail, savedLesson);
    if (groupResult) return groupResult;
    const hasDevice = hasBoundDevice(fresh);
    const testAcceptanceSkipped = isTestAcceptanceSkipped(fresh);
    const phase = testAcceptanceSkipped ? "reporting" : (hasDevice ? "verifying" : "verify_blocked");
    // 重新修复后旧的验收通过标志必须作废：新一轮修复需要重新自测验收才能生成专家报告。
    store.updateTab(tab.id, { workflow: { ...(fresh.workflow || {}), enabled: true, phase, fixedAt: Date.now(), fixReportRel: detail?.rel || null, fixShortReport: wf.shortReport || "", verifyPassedAt: null, verifiedAt: null, verifyReportRel: null } });
    if (testAcceptanceSkipped) {
      pushWorkflowMsg(tab, {
        level: "info",
        title: "🛠 代码修复完成 → 已跳过测试验收",
        body: `修复报告已生成${detail?.rel ? `（${detail.rel}）` : ""}。\n已按用户选择不执行测试与验收相关流程，下一步直接生成报告并提交。此选择不代表验收通过，报告会明确标注测试验收未执行。${savedLesson ? "\n（修复经验已入库）" : ""}`,
        alert: { kind: "reporting", detailRel: detail?.rel || null, lessonSaved: !!savedLesson, testAcceptanceSkipped: true },
      });
    } else if (hasDevice) {
      pushWorkflowMsg(tab, {
        level: "info",
        title: "🛠 代码修复完成 → 进入【自我验收】",
        body: `修复报告已生成${detail?.rel ? `（${detail.rel}）` : ""}。\n下一步：AI 新开验收 Agent 生成单测/用例/App-mock/测试脚本，分别打 **debug / release 包** 装到绑定设备复现 TB 场景验证。\n\n半自动：点「开始自我验收」；全自动：将自动开始。${savedLesson ? "\n（修复经验已入库）" : ""}`,
        alert: { kind: "verifying", detailRel: detail?.rel || null, lessonSaved: !!savedLesson },
      });
    } else {
      pushWorkflowMsg(tab, {
        level: "warn",
        title: "⚠️ 修复完成，但未绑定设备——自我验收已暂停",
        body: `自我验收需要在 **TB 指定机型** 上打 debug/release 包复现验证，本故事点尚未绑定目标设备。\n\n请在「配置工程」里连接并绑定目标设备后，点「执行验收」继续；在此之前流程停在此处（半自动）。`,
        alert: { kind: "verify_blocked", detailRel: detail?.rel || null, lessonSaved: !!savedLesson },
      });
    }
    return { phase, kind: wf.kind, detailRel: detail?.rel || null, lessonSaved: !!savedLesson, testAcceptanceSkipped };
  }

  // 第三步·自我验收结论
  if (["verify_pass", "verify_fail"].includes(wf.kind) && isTestAcceptanceSkipped(store.getTab(tab.id) || tab)) {
    return {
      phase: store.getTab(tab.id)?.workflow?.phase || tab.workflow?.phase || "reporting",
      kind: wf.kind,
      blocked: true,
      code: "WORKFLOW_TEST_ACCEPTANCE_SKIPPED",
      error: "当前故事点已选择跳过测试验收，忽略验收结果标记",
    };
  }
  if (wf.kind === "verify_pass") {
    const detail = writeDetailReport(tab, "verify", wf.detailReport);
    store.updateTab(tab.id, { workflow: { ...(store.getTab(tab.id)?.workflow || tab.workflow || {}), enabled: true, phase: "reporting", verifiedAt: Date.now(), verifyPassedAt: Date.now(), verifyReportRel: detail?.rel || null } });
    recordActualConfigUsage(store.getTab(tab.id) || tab, "success", {
      verified: true,
      verifiedBy: "workflow:verify_pass",
      reason: "self_acceptance_passed",
    });
    pushWorkflowMsg(tab, {
      level: "success",
      title: "✅ 自我验收通过",
      body: `已在绑定设备上用 debug/release 包复现并验证修复${detail?.rel ? `（验收报告：${detail.rel}）` : ""}。\n下一步：生成全量支撑报告并提交 TB（评论简短报告 + 附件全量报告 + 流转「可提测」）。\n\n半自动：点「生成报告并提交」；全自动：将自动开始。`,
      alert: { kind: "reporting", detailRel: detail?.rel || null },
    });
    return { phase: "reporting", kind: wf.kind, detailRel: detail?.rel || null };
  }

  if (wf.kind === "verify_fail") {
    const detail = writeDetailReport(tab, "verify", wf.detailReport);
    store.updateTab(tab.id, { workflow: { ...(store.getTab(tab.id)?.workflow || tab.workflow || {}), enabled: true, phase: "fixing", verifiedAt: Date.now(), verifyReportRel: detail?.rel || null } });
    recordActualConfigUsage(store.getTab(tab.id) || tab, "failed", {
      reason: "self_acceptance_failed",
    });
    pushWorkflowMsg(tab, {
      level: "warn",
      title: "❌ 自我验收未通过 → 回到修复",
      body: `${wf.shortReport || "复现验证发现问题尚未修复或有回归。"}\n\n请根据验收发现的问题继续修复，修完再次触发验收。`,
      alert: { kind: "fixing", detailRel: detail?.rel || null },
    });
    return { phase: "fixing", kind: wf.kind, detailRel: detail?.rel || null };
  }

  // 第三步收尾：按每个 TB 单自己的报告模式提交。
  // - 简短模式：只写“原因 + 措施”的通俗短评，不生成/上传 HTML、PDF 或其它附件。
  // - 专家模式：必须先有图文影音 HTML，再由系统生成 PDF，写评论并上传唯一 PDF 附件。
  if (wf.kind === "report_done") {
    const freshTab = store.getTab(tab.id) || tab;
    if (freshTab.workflow?.phase === "sync_pending"
      && (freshTab.workflow?.tbSyncPending?.kind === "report" || freshTab.workflow?.groupTbSyncSummary)) {
      const resumed = await resumePendingTbSync(freshTab.id);
      return { ...resumed, kind: wf.kind, reportMode: getReportMode(freshTab) };
    }
    const reportReadiness = reportSubmissionReadiness(freshTab);
    if (!reportReadiness.ok) {
      return {
        phase: freshTab.workflow?.phase || "",
        kind: wf.kind,
        blocked: true,
        error: reportReadiness.error,
        code: reportReadiness.code,
      };
    }
    const invalidShortReports = invalidTbCommentsForSubmission(freshTab, wf);
    if (invalidShortReports.length) {
      const detail = invalidShortReports
        .map((item) => `${item.label} 缺少${item.validation.missing.join("、")}`)
        .join("；");
      const error = `简短报告未生成有效的“原因 + 措施”：${detail}`;
      const freshWorkflow = freshTab.workflow || {};
      store.updateTab(tab.id, {
        workflow: {
          ...freshWorkflow,
          enabled: true,
          phase: "reporting",
          reportError: error,
        },
      });
      pushWorkflowMsg(tab, {
        level: "warn",
        title: "简短报告尚未完成，未提交 TB",
        body: `${error}\n\n请让 AI 根据已有修复/验收事实重新总结后再提交。本次没有流转 TB 状态、写评论或上传附件。`,
        alert: { kind: "reporting", blocked: true, error },
      });
      return { phase: "reporting", kind: wf.kind, blocked: true, error };
    }
    // reportSubmissionReadiness 已在 TB 副作用前强制本轮 VERIFY PASS，或确认用户显式选择跳过且存在修复完成事实；
    // 这里仅按冻结报告模式选择短评或专家 HTML/PDF，不允许伪造验收证据或静默降级。
    const expertRequired = requiresExpertReport(freshTab);
    const detail = expertRequired ? writeDetailReport(tab, "report", wf.detailReport) : null;
    let pdf = null;
    let htmlRel = null;
    if (expertRequired) {
      const built = await buildExpertReportPdf(store.getTab(tab.id) || tab);
      if (!built.ok) {
        const freshWorkflow = store.getTab(tab.id)?.workflow || tab.workflow || {};
        store.updateTab(tab.id, {
          workflow: {
            ...freshWorkflow,
            enabled: true,
            phase: "reporting",
            reportError: built.error,
            reportDetailRel: detail?.rel || null,
          },
        });
        pushWorkflowMsg(tab, {
          level: "warn",
          title: "专家报告尚未完成，未提交 TB",
          body: `${built.error}\n\n请补齐专家 HTML 报告后重新点击“生成报告并提交”。本次没有流转 TB 状态，也没有写评论或上传附件。`,
          alert: { kind: "reporting", blocked: true, error: built.error, detailRel: detail?.rel || null },
        });
        return { phase: "reporting", kind: wf.kind, blocked: true, error: built.error, detailRel: detail?.rel || null };
      }
      pdf = built.artifact;
      htmlRel = built.htmlRel || null;
    }
    const attach = pdf;
    const groupSync = await syncGroupReportDoneToTb(tab, wf, attach, pdf, htmlRel);
    if (groupSync) {
      const currentMode = getReportMode(store.getTab(tab.id) || tab);
      const groupPhase = groupSync.ok ? "testable" : "sync_pending";
      const groupError = groupSync.ok
        ? null
        : `整组 TB 同步未完成：${groupSync.failed}/${groupSync.total} 个故事点待续跑`;
      store.updateTab(tab.id, { workflow: {
        ...(store.getTab(tab.id)?.workflow || tab.workflow || {}),
        enabled: true,
        phase: groupPhase,
        reportHtmlRel: currentMode === "expert" ? htmlRel : null,
        reportPdfRel: currentMode === "expert" ? (pdf?.rel || null) : null,
        groupReportHtmlRel: htmlRel,
        groupReportPdfRel: pdf?.rel || null,
        reportError: groupError,
        groupTbSyncSummary: groupSync,
      } });
      const savedLesson = !!(store.getTab(tab.id)?.workflow?.lesson);
      const lines = [];
      lines.push(`整组 TB 同步：${groupSync.total - groupSync.failed}/${groupSync.total} 个成功`);
      for (const item of groupSync.results) {
        const label = item.tbTaskId || item.title || item.tabId;
        const ok = item.ok === true;
        const successText = item.reportMode === "expert"
          ? "已流转可提测并写入专家评论及 PDF"
          : "已流转可提测并写入原因/措施短评（无附件）";
        lines.push(`${ok ? "✅" : "⚠️"} ${label}：${ok ? successText : item.errors.join("；") || "同步异常"}`);
      }
      pushWorkflowMsg(tab, {
        level: groupSync.failed ? "warn" : "success",
        title: groupSync.ok
          ? (isTestAcceptanceSkipped(freshTab) && !Number(freshTab.workflow?.verifyPassedAt) ? "🎉 故事点组已跳过测试验收并逐个同步 TB" : "🎉 故事点组已统一验收并逐个同步 TB")
          : "TB 同步未全部完成，整组停留待续跑",
        body: `${lines.join("\n")}${groupError ? `\n\n${groupError}。重试只会续跑未确认步骤。` : ""}`,
        alert: { kind: groupPhase, groupSync, reportMode: expertRequired ? "expert" : "short", detailRel: attach?.rel || null, htmlRel, pdfRel: pdf?.rel || null, lessonSaved: savedLesson, canExport: groupSync.ok && savedLesson },
      });
      emitWs("devbench_group_sync", { groupId: tab.groupId, phase: groupPhase, ok: groupSync.ok, total: groupSync.total, failed: groupSync.failed });
      return { phase: groupPhase, kind: wf.kind, reportMode: expertRequired ? "expert" : "short", groupSync, detailRel: attach?.rel || null, htmlRel, pdfRel: pdf?.rel || null, lessonSaved: savedLesson, ...(groupError ? { error: groupError } : {}) };
    }
    const mode = getReportMode(store.getTab(tab.id) || tab);
    const freshWorkflow = store.getTab(tab.id)?.workflow || tab.workflow || {};
    const commentText = mode === "short"
      ? (wf.deterministic === true
        ? String(wf.shortReport || "")
        : formatShortTbComment(wf.shortReport, {
          testAcceptanceSkipped: isTestAcceptanceSkipped(freshTab) && !Number(freshWorkflow.verifyPassedAt),
        }))
      : `🤖 AI 自动工作流\n\n${String(wf.shortReport || "")}`;
    let candidate;
    try {
      candidate = buildReportTbSyncCandidate(freshTab, {
        commentText,
        artifact: attach,
        reportMode: mode,
        htmlRel,
        pdfRel: pdf?.rel || attach?.rel || null,
        basis: {
          fixedAt: freshWorkflow.fixedAt || null,
          verifyPassedAt: freshWorkflow.verifyPassedAt || freshWorkflow.verifiedAt || null,
        },
      });
    } catch (error) {
      store.updateTab(tab.id, {
        workflow: { ...freshWorkflow, enabled: true, phase: "reporting", reportError: error.message },
      });
      return { phase: "reporting", kind: wf.kind, blocked: true, error: error.message };
    }
    const syncResult = await runPersistedTbSync(freshTab, candidate, { expectedKind: "report" });
    const saga = syncResult.saga || { steps: {}, pending: ["saga"], errors: [syncResult.error || "TB 同步未完成"] };
    if (!syncResult.ok) {
      pushWorkflowMsg(tab, {
        level: "warn",
        title: "TB 同步部分失败，本地停留在 sync_pending",
        body: `${(saga.errors || [syncResult.error]).filter(Boolean).slice(0, 5).join("\n")}\n\n重试「TB 同步」会复用首次冻结的评论、附件哈希和 revision，只续跑未确认步骤。`,
        alert: { kind: "sync_pending", reportMode: mode, syncPending: saga, detailRel: attach?.rel || null, htmlRel, pdfRel: pdf?.rel || null },
      });
      return { phase: "sync_pending", kind: wf.kind, reportMode: mode, syncPending: saga, error: syncResult.error, detailRel: attach?.rel || null, htmlRel, pdfRel: pdf?.rel || null };
    }
    const sync = {
      commentOk: TB_SYNC_STEP_SUCCESS.has(String(saga.steps?.comment?.status || "")),
      uploadOk: mode === "short" || (TB_SYNC_STEP_SUCCESS.has(String(saga.steps?.attachment?.status || "")) && saga.steps?.attachment?.status !== "skipped"),
      attachmentRequired: mode === "expert",
      attachmentSkipped: mode !== "expert",
      errors: [...(saga.errors || [])],
    };
    const savedLesson = !!(store.getTab(tab.id)?.workflow?.lesson);
    const statusStep = saga.steps?.status || {};
    const statusLine = statusStep.status === "done"
      ? `TB 状态已切为「${statusStep.to}」`
      : statusStep.status === "deduped_remote" || statusStep.status === "replayed"
        ? `TB 状态已为「可提测」（未重复流转）`
        : `TB 状态同步异常：${statusStep.reason || "未知"}`;
    const lines = [];
    lines.push(statusLine);
    lines.push(sync.commentOk
      ? (mode === "expert" ? "已写入 TB 评论（一条·专家摘要）" : "已写入 TB 评论（原因 + 措施，通俗短评）")
      : "TB 评论写入失败");
    lines.push(mode === "expert"
      ? (sync.uploadOk ? "已上传专家报告 PDF 附件" : `专家报告 PDF 上传失败${attach?.rel ? `（本地已存：${attach.rel}）` : ""}`)
      : "简短模式不生成、不上传报告附件");
    if (sync.errors.length) lines.push(`同步告警：${sync.errors.slice(0, 3).join("；")}`);
    pushWorkflowMsg(tab, {
      level: sync.errors.length || statusStep.status === "pending_ambiguous" ? "warn" : "success",
      title: "🎉 全流程完成（甄别 → 修复 → 自我验收 → 报告提交）",
      body: lines.join("\n"),
      alert: { kind: "testable", reportMode: mode, statusFlow: statusStep, sync, detailRel: attach?.rel || null, htmlRel: mode === "expert" ? htmlRel : null, pdfRel: mode === "expert" ? (pdf?.rel || null) : null, lessonSaved: savedLesson, canExport: savedLesson },
    });
    return { phase: "testable", kind: wf.kind, reportMode: mode, statusFlow: statusStep, sync, detailRel: attach?.rel || null, htmlRel: mode === "expert" ? htmlRel : null, pdfRel: mode === "expert" ? (pdf?.rel || null) : null, lessonSaved: savedLesson };
  }

  return null;
}

export function __testClassifyWorkflowObservationOutcome(result, phaseBefore = "") {
  if (result?.blocked) return "blocked";
  const before = String(phaseBefore || "");
  const after = String(result?.phase || before);
  return result?.phase && after !== before ? "advanced" : "no_transition";
}

export async function applyWorkflow(tab, wf, observation = {}) {
  const phaseBefore = String(tab?.workflow?.phase || "");
  const markerKind = String(wf?.kind || "");
  const stage = String(observation.stage || observation.workflowKind || markerKind || phaseBefore || "UNKNOWN").toUpperCase();
  const reportAttempt = observation.workflowKind === "report"
    || stage === "REPORT"
    || markerKind === "report_done";
  try {
    const result = await applyWorkflowInternal(tab, wf);
    const outcome = __testClassifyWorkflowObservationOutcome(result, phaseBefore);
    const phaseAfter = String(result?.phase || phaseBefore || "");
    try {
      recordWorkflowStageObservation({
        storyId: tab?.id || null,
        taskId: observation.taskId || null,
        attemptId: observation.attemptId || null,
        workflowKind: observation.workflowKind || null,
        stage,
        markerKind: markerKind || null,
        phaseBefore: phaseBefore || null,
        phaseAfter: phaseAfter || null,
        outcome,
        reportValidationRetry: reportAttempt && outcome !== "advanced",
        errorCode: result?.error ? "WORKFLOW_BLOCKED" : null,
      });
    } catch (error) {
      log("system", "warn", "devbench-observability", `阶段观测落库失败: ${error.message}`);
    }
    return result;
  } catch (error) {
    try {
      recordWorkflowStageObservation({
        storyId: tab?.id || null,
        taskId: observation.taskId || null,
        attemptId: observation.attemptId || null,
        workflowKind: observation.workflowKind || null,
        stage,
        markerKind: markerKind || null,
        phaseBefore: phaseBefore || null,
        phaseAfter: phaseBefore || null,
        outcome: "execution_failed",
        reportValidationRetry: reportAttempt,
        errorCode: error?.code || "WORKFLOW_ERROR",
      });
    } catch (observationError) {
      log("system", "warn", "devbench-observability", `失败阶段观测落库失败: ${observationError.message}`);
    }
    throw error;
  }
}

// ========== 对外：用户点「确认拒绝」时调用 ==========

/**
 * 确认拒绝该 TB 单：待确认 → 已拒绝 + 评论(简短) + 附件(详细)。
 * 返回 { ok, statusFlow, sync, error? }。
 */
export async function confirmReject(tabId, {
  storeApi = store,
  sagaRunner = runTbSyncSaga,
  api = null,
  persistLessonFn = persistLesson,
  recordConfigUsageFn = recordActualConfigUsage,
  pushWorkflowMsgFn = pushWorkflowMsg,
  allowVolatileTestStore = false,
} = {}) {
  const tab = storeApi.getTab(tabId);
  if (!tab) return { ok: false, error: "故事点不存在" };
  const tbTaskId = tabTbTaskId(tab);
  if (!tbTaskId) return { ok: false, error: "该故事点未关联 TB 单" };
  const pending = tab.workflow?.pendingReject;
  const storedSync = tab.workflow?.tbSyncPending;
  if (!hasActionablePendingReject(tab.workflow) && storedSync?.kind !== "reject") {
    return { ok: false, error: "没有可确认的拒绝材料（请先完成问题甄别）" };
  }

  let candidate = null;
  if (!storedSync) {
    try {
      candidate = buildRejectTbSyncCandidate(tab, pending, { storeApi });
    } catch (error) {
      const workflow = storeApi.getTab(tabId)?.workflow || tab.workflow || {};
      storeApi.updateTab(tabId, { workflow: { ...workflow, enabled: true, phase: "reject_pending", reportError: error.message } });
      return { ok: false, phase: "reject_pending", error: error.message };
    }
  }
  const syncResult = await runPersistedTbSync(tab, candidate, {
    expectedKind: "reject",
    sagaRunner,
    storeApi,
    api,
    allowVolatileTestStore,
  });
  if (!syncResult.ok) {
    const sagaErrors = Array.isArray(syncResult.saga?.errors) ? syncResult.saga.errors : [];
    pushWorkflowMsgFn(tab, {
      level: "warn",
      title: "拒绝材料尚未完整同步到 TB",
      body: `${sagaErrors.slice(0, 5).join("\n") || syncResult.error || "TB 同步未完成"}\n\n本地保留拒绝材料并停在 sync_pending；重试只会续跑未确认步骤。`,
      alert: { kind: "sync_pending", pendingKind: "reject", syncPending: syncResult.saga || null },
    });
    return {
      ok: false,
      phase: "sync_pending",
      resumed: !!storedSync,
      pending: true,
      error: syncResult.error || "TB 同步未完成",
      pendingSteps: syncResult.saga?.pending || [],
      sync: syncResult.saga || null,
    };
  }

  // 仅在评论、附件（如有）和状态均经回读确认后，才沉淀拒绝经验与终态。
  const savedLesson = pending
    ? persistLessonFn(storeApi.getTab(tabId) || tab, "triage_not_bug", pending.lesson, pending.detailRel)
    : null;
  const completed = storeApi.getTab(tabId) || tab;
  storeApi.updateTab(tabId, {
    workflow: { ...(completed.workflow || {}), enabled: true, phase: "rejected", pendingReject: null, reportError: null },
  });
  recordConfigUsageFn(storeApi.getTab(tabId) || tab, "aborted", {
    reason: "ticket_rejected_after_triage",
  });

  const saga = syncResult.saga;
  const statusStep = saga.steps?.status || {};
  const sync = {
    commentOk: TB_SYNC_STEP_SUCCESS.has(String(saga.steps?.comment?.status || "")),
    uploadOk: !syncResult.pending?.attachment
      || (TB_SYNC_STEP_SUCCESS.has(String(saga.steps?.attachment?.status || "")) && saga.steps?.attachment?.status !== "skipped"),
    errors: [...(saga.errors || [])],
  };
  const lines = [];
  lines.push(statusStep.status === "done"
    ? `TB 状态已切为「${statusStep.to || "已拒绝"}」`
    : "TB 状态已为「已拒绝」（未重复流转）");
  lines.push(sync.commentOk ? "已写入 TB 评论（拒绝说明）" : "TB 评论写入失败");
  lines.push(syncResult.pending?.attachment
    ? (sync.uploadOk ? "已上传详细说明附件" : "详细说明附件未确认")
    : "本次拒绝说明无附件");
  if (savedLesson) lines.push("已沉淀经验到经验库（后续同项目甄别自动参考）；可在下方导出到 Wiki / 工程 CLAUDE.md");
  pushWorkflowMsgFn(tab, {
    level: "success",
    title: "🚫 已按确认拒绝该 TB 单",
    body: lines.join("\n"),
    alert: { kind: "rejected", statusFlow: statusStep, sync, lessonSaved: !!savedLesson, canExport: !!savedLesson },
  });
  return { ok: true, phase: "rejected", resumed: !!storedSync, pending: false, statusFlow: statusStep, sync, lessonSaved: !!savedLesson };
}

// 测试专用导出：避免 applyWorkflow 成功路径触发真实 TB API 调用。
export function __testInvalidTbCommentsForSubmission(tab, wf) {
  return invalidTbCommentsForSubmission(tab, wf);
}
