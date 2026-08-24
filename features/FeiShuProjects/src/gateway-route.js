import {
  createHash,
  randomUUID,
} from "crypto";
import {
  DEFAULT_FEISHU_PROJECT_SYNC_CONFIG,
  annotateFeishuSourceWorkItem,
  configForFeishuSourceView,
  feishuSourceWorkItemIdentity,
  getFeishuSourceViews,
  getFeishuProjectSyncConfig,
  getFeishuProjectSyncReadiness,
  mergeFeishuSourceWorkItems,
  parseFeishuProjectUrl,
  validateFeishuSourceViewsConfig,
  runFeishuProjectSync,
  syncFeishuProjectWorkItem,
  backfillFeishuProjectSync,
  handleFeishuProjectWebhook,
  reconcileFeishuProjectSync,
  verifyFeishuProjectSyncTargets,
  refreshFeishuProjectSyncSourceRecords,
  listFeishuProjectSyncRecords,
  listFeishuProjectSyncRecordsSince,
  listFeishuProjectRawPayloadRecords,
  listFeishuProjectCommentSyncRecords,
  listFeishuProjectAttachmentSyncRecords,
  listFeishuProjectRetryableErrorRecords,
  detectFeishuProjectDuplicateTasks,
  mergeFeishuProjectDuplicateTasks,
  previewFeishuProjectSyncPolicy,
} from "./gateway-sync-service.js";
import { assertValidSyncPolicyConfig } from "./sync-policy-engine.js";
import {
  captureFeishuProjectWebItems,
  getFeishuProjectMcpTokenFromWeb,
  getFeishuProjectWebStatus,
  openFeishuProjectSystemUrl,
  openFeishuProjectWebLogin,
} from "./feishu-web-session.js";
import {
  cancelFeishuRemoteSession,
  getFeishuRemoteStatus,
} from "../../../gateway/services/feishu-remote-browser.js";
import {
  captureFeishuProjectMcpItems,
  getFeishuProjectMcpFilterMetadata,
  getFeishuProjectMcpStatus,
  sanitizeFeishuProjectMcpPayload,
  sanitizeFeishuProjectMcpStatus,
} from "./feishu-mcp-client.js";
import {
  applyFeishuSheetUpdatePlan,
  previewFeishuSheetUpdates,
  readFeishuSheetRows,
} from "./feishu-sheet-sync.js";
import {
  readFeishuFilterPreset as defaultReadFeishuFilterPreset,
  saveFeishuFilterPreset as defaultSaveFeishuFilterPreset,
} from "./feishu-filter-preset.js";
import { getConfig as defaultGetConfig, updateConfig as defaultUpdateConfig } from "../../../gateway/services/config.js";
import {
  getOrgMembers as defaultListTbMembers,
  listOrgProjects as defaultListTbProjects,
  listProjectTasklists as defaultListTbTasklists,
  listProjectSprints as defaultListTbSprints,
  searchTask as defaultResolveTbTask,
} from "../../../gateway/services/teambition.js";
import {
  clearFeishuProjectSyncRecords as defaultClearFeishuProjectSyncRecords,
  deleteFeishuProjectSyncRecords as defaultDeleteFeishuProjectSyncRecords,
  repointFeishuProjectSyncTarget as defaultRepointFeishuProjectSyncTarget,
} from "../../../gateway/db/sqlite.js";
import { log } from "../../../gateway/services/logger.js";

const isMasked = (value) => typeof value === "string" && /\*{3,}/.test(value);
const RUN_PUBLIC_EVENT_LIMIT = 120;
const PREPARED_SYNC_PLAN_TTL_MS = 10 * 60 * 1000;
const PREPARED_SYNC_PLAN_LIMIT = 100;
const FEISHU_SOURCE_KEYS = ["mcp", "web", "plugin"];
const DEFECT_DESCRIPTION_FIELD_KEYS = new Set([
  "field_ee70e6",
  "defect_description",
  "defectdescription",
  "bug_description",
  "bugdescription",
  "缺陷描述",
  "问题描述",
]);

function isSensitiveKey(key) {
  const normalized = String(key || "").trim().toLowerCase();
  if (!normalized) return false;
  if (["token", "secret", "password", "apikey", "api_key", "privatekey", "private_key"].includes(normalized)) return true;
  if (["userkey", "pluginsecret", "webhooksecret", "clientsecret", "appsecret", "inboundtoken"].includes(normalized)) return true;
  if (/(^|[_-])(secret|password|credential|apikey|api_key|privatekey|private_key)([_-]|$)/i.test(normalized)) return true;
  return normalized.endsWith("token") && !["tokenpath", "tokenheadername", "tokenheaderprefix"].includes(normalized);
}

function maskDeep(value) {
  if (Array.isArray(value)) return value.map(maskDeep);
  if (value && typeof value === "object") {
    const out = {};
    for (const [key, val] of Object.entries(value)) out[key] = isSensitiveKey(key) ? (val ? "***" : "") : maskDeep(val);
    return out;
  }
  return value;
}

function mergeMasked(current, incoming) {
  if (isMasked(incoming)) return current;
  if (Array.isArray(incoming)) return incoming;
  if (incoming && typeof incoming === "object") {
    const out = { ...(current && typeof current === "object" && !Array.isArray(current) ? current : {}) };
    for (const [key, value] of Object.entries(incoming)) out[key] = mergeMasked(out[key], value);
    return out;
  }
  return incoming;
}

function pickConfigPatch(body = {}) {
  return body.config && typeof body.config === "object" ? body.config : body;
}

function currentTbTargetOption(cfg = {}) {
  const tb = cfg.teambition || {};
  const defaults = DEFAULT_FEISHU_PROJECT_SYNC_CONFIG.teambition || {};
  const projectId = String(tb.projectId || defaults.projectId || "").trim();
  const tasklistId = String(tb.tasklistId || defaults.tasklistId || "").trim();
  const tasklistName = String(tb.tasklistName || defaults.tasklistName || tasklistId).trim();
  const pathName = String(tb.projectPathName || defaults.projectPathName || tasklistName).trim();
  const projectName = pathName.includes("/") ? pathName.split("/")[0].trim() : "";
  return {
    id: tasklistId,
    tasklistId,
    name: tasklistName,
    title: tasklistName,
    projectId,
    projectName,
    pathName,
    url: String(tb.tasklistUrl || "").trim(),
    source: "current-config",
  };
}

const SHEET_SOURCE_COLUMN_CANDIDATES = [
  "系统单号",
  "飞书问题编号",
  "问题编号",
  "飞书工单问题编号",
  "sourceWorkItemNo",
  "sourceProblemNo",
  "problemNo",
  "workItemNo",
];

const SHEET_TB_COLUMN_CANDIDATES = [
  "钉钉单号",
  "TB任务ID",
  "TB 任务 ID",
  "TB单号",
  "TB 单号",
  "任务ID",
  "任务 ID",
  "CARB",
  "targetUniqueId",
  "targetTaskId",
];

function normalizeSheetHeader(value) {
  return String(value || "").trim().replace(/\s+/g, "").toLowerCase();
}

function rowValueByNames(row = {}, names = []) {
  const wanted = new Set((names || []).map(normalizeSheetHeader).filter(Boolean));
  for (const [key, value] of Object.entries(row || {})) {
    if (wanted.has(normalizeSheetHeader(key))) {
      const text = String(value ?? "").trim();
      if (text) return text;
    }
  }
  return "";
}

function normalizeProblemNo(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  const match = raw.match(/[A-Z][A-Z0-9]+-\d+/i);
  return (match ? match[0] : raw).toUpperCase();
}

function normalizeTbDisplayId(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  const carb = raw.match(/CARB-\d+/i);
  if (carb) return carb[0].toUpperCase();
  const numeric = raw.match(/^\d+$/);
  if (numeric) return `CARB-${numeric[0]}`;
  return raw;
}

function tbUniqueIdFromDisplay(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  const carb = raw.match(/CARB-(\d+)/i);
  if (carb) return carb[1];
  if (/^\d+$/.test(raw)) return raw;
  return "";
}

function taskObjectId(task = {}) {
  return String(task?._id || task?.id || task?.taskId || task?.targetTaskId || task?.task_id || "").trim();
}

function taskUniqueId(task = {}) {
  return String(task?.uniqueId || task?.unique_id || task?.targetUniqueId || task?.target_unique_id || "").trim();
}

function taskUpdatedAt(task = {}) {
  return String(task?.updatedAt || task?.updated_at || task?._updatedAt || task?.modified || "").trim();
}

function taskTitle(task = {}) {
  return String(task?.title || task?.content || task?.name || task?.raw?.content || task?.raw?.title || "").trim();
}

function currentTargetDisplayId(row = {}) {
  const uniqueId = String(row.targetUniqueId || row.target_unique_id || "").trim();
  if (uniqueId) return normalizeTbDisplayId(uniqueId);
  return String(row.targetTaskId || row.target_task_id || "").trim();
}

function syncRecordKey(row = {}) {
  return {
    sourceSystem: row.sourceSystem || row.source_system || "feishu_project",
    sourceProjectKey: row.sourceProjectKey || row.source_project_key || "",
    sourceWorkItemTypeKey: row.sourceWorkItemTypeKey || row.source_work_item_type_key || "",
    sourceWorkItemId: row.sourceWorkItemId || row.source_work_item_id || "",
    sourceWorkItemUrl: row.sourceWorkItemUrl || row.source_work_item_url || "",
    sourceProblemNo: row.sourceProblemNo || row.source_problem_no || row.problemNo || row.problem_no || "",
    sourceWorkItemNo: row.sourceWorkItemNo || row.source_work_item_no || "",
    targetSystem: row.targetSystem || row.target_system || "teambition",
  };
}

function compactSheetMappingObject(obj = {}) {
  const out = {};
  for (const [key, value] of Object.entries(obj || {})) {
    if (value === undefined || value === null || value === "") continue;
    if (Array.isArray(value) && !value.length) continue;
    out[key] = value;
  }
  return out;
}

function sheetRowSnapshot(row = {}) {
  if (!row || typeof row !== "object" || Array.isArray(row)) return {};
  const out = {};
  for (const [key, value] of Object.entries(row)) {
    const column = String(key || "").trim();
    if (!column) continue;
    out[column] = String(value ?? "");
  }
  return out;
}

function compactSyncRecord(row = {}) {
  return compactSheetMappingObject({
    sourceWorkItemId: row.sourceWorkItemId || row.source_work_item_id,
    sourceProblemNo: row.sourceProblemNo || row.source_problem_no || row.problemNo,
    sourceWorkItemNo: row.sourceWorkItemNo || row.source_work_item_no,
    sourceWorkItemUrl: row.sourceWorkItemUrl || row.source_work_item_url,
    targetTaskId: row.targetTaskId || row.target_task_id,
    targetUniqueId: row.targetUniqueId || row.target_unique_id,
    targetUpdatedAt: row.targetUpdatedAt || row.target_updated_at,
    syncStatus: row.syncStatus || row.sync_status,
    lastError: row.lastError || row.last_error,
  });
}

function sheetColumnCandidates(configured, defaults) {
  return Array.from(new Set([configured, ...(defaults || [])].map((value) => String(value || "").trim()).filter(Boolean)));
}

function collectScalarValues(...values) {
  const out = [];
  const visit = (value) => {
    if (value === undefined || value === null || value === "") return;
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (typeof value === "object") return;
    const text = String(value || "").trim();
    if (!text) return;
    for (const part of text.split(/[\s,，;；]+/).map((x) => x.trim()).filter(Boolean)) out.push(part);
  };
  for (const value of values) visit(value);
  return out;
}

function sheetRouteErrorResponse(err) {
  return {
    success: false,
    error: err?.message || String(err),
    needLogin: !!err?.needLogin,
    data: {
      finalUrl: err?.finalUrl || "",
      targetUrl: err?.targetUrl || "",
      profileDir: err?.profileDir || "",
    },
  };
}

export function createFeishuProjectSyncRouter({
  Router,
  verifyToken,
  requirePeerReplicationAuth = (req, res, next) => next(),
  getConfig = defaultGetConfig,
  updateConfig = defaultUpdateConfig,
  listFeishuProjectSyncErrors,
  listSyncRecords = listFeishuProjectSyncRecords,
  verifySyncTargets = verifyFeishuProjectSyncTargets,
  listFeishuProjectRawPayloads = listFeishuProjectRawPayloadRecords,
  listFeishuProjectCommentSync = listFeishuProjectCommentSyncRecords,
  listFeishuProjectAttachmentSync = listFeishuProjectAttachmentSyncRecords,
  listFeishuProjectRetryableErrors = listFeishuProjectRetryableErrorRecords,
  listFeishuProjectSyncStatesSince = listFeishuProjectSyncRecordsSince,
  runSync = runFeishuProjectSync,
  backfillSync = backfillFeishuProjectSync,
  handleWebhook = handleFeishuProjectWebhook,
  reconcileSync = reconcileFeishuProjectSync,
  detectDuplicates = detectFeishuProjectDuplicateTasks,
  mergeDuplicates = mergeFeishuProjectDuplicateTasks,
  refreshSourceRecords = refreshFeishuProjectSyncSourceRecords,
  previewSheetUpdates = previewFeishuSheetUpdates,
  applySheetUpdates = applyFeishuSheetUpdatePlan,
  readSheetRows = readFeishuSheetRows,
  resolveTbTask = defaultResolveTbTask,
  repointSyncTarget = defaultRepointFeishuProjectSyncTarget,
  getMcpStatus = getFeishuProjectMcpStatus,
  getMcpFilterMetadata = getFeishuProjectMcpFilterMetadata,
  getMcpTokenFromWeb = getFeishuProjectMcpTokenFromWeb,
  captureMcpItems = captureFeishuProjectMcpItems,
  captureWebItems = captureFeishuProjectWebItems,
  getWebStatus = getFeishuProjectWebStatus,
  openWebLogin = openFeishuProjectWebLogin,
  syncWorkItem = syncFeishuProjectWorkItem,
  openSystemUrl = openFeishuProjectSystemUrl,
  listTbProjects = defaultListTbProjects,
  listTbTasklists = defaultListTbTasklists,
  listTbSprints = defaultListTbSprints,
  listTbMembers = defaultListTbMembers,
  clearSyncRecords = defaultClearFeishuProjectSyncRecords,
  deleteSyncRecords = defaultDeleteFeishuProjectSyncRecords,
  readFilterPreset = defaultReadFeishuFilterPreset,
  saveFilterPreset = defaultSaveFeishuFilterPreset,
  preparedPlanTtlMs = PREPARED_SYNC_PLAN_TTL_MS,
  now = () => Date.now(),
  writeLog = log,
}) {
  const router = Router();
  const runs = new Map();
  const preparedSyncPlans = new Map();
  const applyingPreparedRecordKeys = new Set();
  let runSeq = 0;

  function createRun(mode = "run") {
    const run = {
      id: `feishu-sync-${Date.now()}-${randomUUID().slice(0, 8)}`,
      mode,
      status: "running",
      startedAt: new Date().toISOString(),
      finishedAt: "",
      events: [],
      result: null,
      error: "",
      seq: 0,
      subscribers: new Set(),
    };
    runs.set(run.id, run);
    pruneRuns();
    appendRunEvent(run, { level: "info", phase: "start", message: "同步任务已启动" });
    return run;
  }

  function pruneRuns() {
    const maxRuns = 50;
    if (runs.size <= maxRuns) return;
    const sorted = Array.from(runs.values()).sort((a, b) => String(a.startedAt).localeCompare(String(b.startedAt)));
    for (const run of sorted.slice(0, Math.max(0, runs.size - maxRuns))) {
      closeRunSubscribers(run);
      runs.delete(run.id);
    }
  }

  function writeSse(res, event, data) {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  }

  function notifyRunSubscribers(run, event, data) {
    for (const subscriber of run?.subscribers || []) {
      try { subscriber.send(event, data); } catch {}
    }
  }

  function closeRunSubscribers(run) {
    for (const subscriber of run?.subscribers || []) {
      try { subscriber.close(); } catch {}
    }
    run?.subscribers?.clear?.();
  }

  function appendRunEvent(run, event = {}) {
    if (!run) return null;
    const evt = {
      seq: ++run.seq,
      globalSeq: ++runSeq,
      at: new Date().toISOString(),
      level: event.level || "info",
      phase: event.phase || "progress",
      message: event.message || "",
      workItemId: event.workItemId || event.sourceWorkItemId || "",
      title: event.title || "",
      action: event.action || "",
      targetTaskId: event.targetTaskId || "",
      error: event.error || "",
      index: event.index || 0,
      total: event.total || 0,
    };
    run.events.push(evt);
    if (run.events.length > 500) run.events.splice(0, run.events.length - 500);
    try { log(run.id, evt.level, "feishu-project-sync", formatRunLogMessage(evt)); } catch {}
    notifyRunSubscribers(run, "event", evt);
    return evt;
  }

  function formatRunLogMessage(evt) {
    const parts = [
      evt.phase ? `[${evt.phase}]` : "",
      evt.workItemId ? `飞书单 ${evt.workItemId}` : "",
      evt.action ? `动作 ${evt.action}` : "",
      evt.targetTaskId ? `TB ${evt.targetTaskId}` : "",
      evt.message || "",
      evt.error ? `错误：${evt.error}` : "",
    ].filter(Boolean);
    return parts.join(" ");
  }

  function collectSyncResults(data) {
    if (!data || typeof data !== "object") return [];
    const candidates = [
      data.results,
      data.result?.results,
      data.result?.result?.results,
    ];
    return candidates.find(Array.isArray) || [];
  }

  function syncRowId(row) {
    return row?.item?.sourceWorkItemId || row?.item?.id || row?.sourceWorkItemId || "-";
  }

  function syncResultSummary(data = {}) {
    const results = collectSyncResults(data);
    const hasRows = results.length > 0;
    const countAction = (action) => results.filter((row) => row?.ok !== false && row?.action === action).length;
    return {
      ok: data?.ok !== false && !results.some((row) => row?.ok === false),
      dryRun: !!data?.dryRun || results.some((row) => row?.dryRun),
      source: data?.source || data?.mode || "",
      captured: data?.captured?.total ?? data?.selected?.rawPayloads ?? null,
      total: Number(data?.total ?? (hasRows ? results.length : 0)) || 0,
      requested: Number(data?.requested ?? data?.captured?.total ?? data?.selected?.workItemIds?.length ?? data?.total ?? (hasRows ? results.length : 0)) || 0,
      created: hasRows ? countAction("create") : Number(data?.created || 0),
      updated: hasRows ? countAction("update") : Number(data?.updated || 0),
      childSynced: hasRows ? countAction("sync-children") : Number(data?.childSynced || 0),
      skipped: hasRows ? countAction("skip") : Number(data?.skipped || 0),
      failed: hasRows ? results.filter((row) => row?.ok === false).length : Number(data?.failed || 0),
      stoppedOnFirstError: !!data?.stoppedOnFirstError,
      firstError: data?.firstError || results.find((row) => row?.ok === false)?.error || "",
      resultsPreviewOnly: true,
      resultsPreview: results.slice(0, 20).map(compactSyncResultRow),
      resultsOmitted: Math.max(0, results.length - 20),
    };
  }

  function compactPreviewData(data) {
    if (!data || typeof data !== "object") return data;
    const results = collectSyncResults(data);
    const stats = syncResultSummary(data);
    const out = {};
    for (const [key, value] of Object.entries(data).slice(0, 80)) {
      if (key === "results") continue;
      if (key === "result" && value?.results) {
        out.result = compactPreviewData(value);
        continue;
      }
      out[key] = compactValue(value, 0, new WeakSet());
    }
    if (results.length) {
      out.summary = {
        total: stats.total,
        create: stats.created,
        update: stats.updated,
        skipped: stats.skipped,
        failed: stats.failed,
        stoppedOnFirstError: stats.stoppedOnFirstError,
        firstError: stats.firstError,
        dryRun: stats.dryRun,
      };
      out.resultsPreview = stats.resultsPreview;
      if (stats.resultsOmitted) out.resultsOmitted = stats.resultsOmitted;
    }
    out._displayNote = "结果页为避免浏览器卡顿，只展示网关生成的精简 JSON；完整同步结果保留在网关运行上下文中。";
    return out;
  }

  function compactValue(value, depth = 0, seen = new WeakSet()) {
    if (value == null || typeof value === "number" || typeof value === "boolean") return value;
    if (typeof value === "string") return clipText(value, 1600);
    if (Array.isArray(value)) {
      const first = value.slice(0, depth ? 8 : 20).map((item) => compactValue(item, depth + 1, seen));
      if (value.length > first.length) first.push(`... ${value.length - first.length} more items omitted`);
      return first;
    }
    if (typeof value !== "object") return String(value);
    if (seen.has(value)) return "[Circular]";
    seen.add(value);
    const keys = Object.keys(value);
    if (depth >= 2) return `[Object with ${keys.length} keys: ${keys.slice(0, 12).join(", ")}${keys.length > 12 ? ", ..." : ""}]`;
    const out = {};
    for (const key of keys.slice(0, 40)) out[key] = compactValue(value[key], depth + 1, seen);
    if (keys.length > 40) out._omittedKeys = keys.length - 40;
    return out;
  }

  function compactNotePrevious(row = {}) {
    const verification = row.targetFieldVerification || {};
    const mismatches = Array.isArray(verification.mismatches) ? verification.mismatches : [];
    const noteMismatch = mismatches.find((item) => item?.field === "note") || {};
    const task = verification.task || {};
    const candidates = [
      row.notePrevious,
      row.payload?.notePrevious,
      verification.notePrevious,
      verification.previousNote,
      verification.currentNote,
      noteMismatch.actualDisplay,
      noteMismatch.actual,
      task.noteDisplay,
      task.noteMarkdown,
      task.note,
    ];
    for (const candidate of candidates) {
      const text = String(candidate || "").trim();
      if (text) return text;
    }
    if (isKnownEmptyNotePrevious(row, noteMismatch)) return "空";
    return "";
  }

  function hasOwnValue(obj = {}, key = "") {
    return !!obj && typeof obj === "object" && Object.prototype.hasOwnProperty.call(obj, key);
  }

  function isKnownEmptyNotePrevious(row = {}, mismatch = null) {
    const verification = row.targetFieldVerification || {};
    const task = verification.task || {};
    const explicitKeys = [
      [row, "notePrevious"],
      [row.payload || {}, "notePrevious"],
      [verification, "notePrevious"],
      [verification, "previousNote"],
      [verification, "currentNote"],
      [task, "noteDisplay"],
      [task, "noteMarkdown"],
      [task, "note"],
    ];
    if (explicitKeys.some(([obj, key]) => hasOwnValue(obj, key) && String(obj[key] || "").trim() === "")) return true;
    if (mismatch && hasOwnValue(mismatch, "actual") && String(mismatch.actual || "").trim() === "") return true;
    const noteRead = verification.noteRead || {};
    return !!(noteRead.attempted && noteRead.ok !== false && noteRead.empty);
  }

  function compactTargetFieldVerification(row = {}) {
    const verification = row.targetFieldVerification;
    const notePrevious = compactNotePrevious(row);
    if (!verification && !notePrevious) return undefined;
    return cleanDisplayObject({
      ...(verification || {}),
      notePrevious: notePrevious ? clipText(notePrevious, 4000) : undefined,
    });
  }

  function compactSyncResultRow(row = {}) {
    const item = row.item || {};
    const payload = row.payload || {};
    const verification = row.targetFieldVerification || {};
    const notePrevious = compactNotePrevious(row);
    return cleanDisplayObject({
      ok: row.ok,
      action: row.action,
      dryRun: row.dryRun,
      sourceWorkItemId: syncRowId(row),
      item: { title: item.title || item.work_item_name || item.name || "" },
      targetTaskId: row.targetTaskId || row.existing?.targetTaskId || row.remoteExisting?.targetTaskId || verification.targetTaskId || verification.task?._id || verification.task?.id || verification.task?.taskId,
      targetUniqueId: row.targetUniqueId || row.existing?.targetUniqueId || row.remoteExisting?.targetUniqueId || verification.targetUniqueId || verification.task?.uniqueId || verification.task?.unique_id,
      notePrevious: notePrevious ? clipText(notePrevious, 4000) : undefined,
      reason: row.reason,
      error: row.error,
      payload: Object.keys(payload).length ? cleanDisplayObject({
        content: clipText(payload.content, 300),
        note: clipText(payload.note, 4000),
        notePrevious: notePrevious ? clipText(notePrevious, 4000) : undefined,
        executorId: payload.executorId,
        executorIdDisplay: payload.executorIdDisplay,
        involveMembers: payload.involveMembers,
        dueDate: payload.dueDate,
        startDate: payload.startDate,
        priority: payload.priority,
        projectId: payload.projectId,
        projectIdDisplay: payload.projectIdDisplay,
        tasklistId: payload.tasklistId,
        tasklistIdDisplay: payload.tasklistIdDisplay,
        stageId: payload.stageId,
        stageIdDisplay: payload.stageIdDisplay,
        sprintId: payload.sprintId,
        sprintIdDisplay: payload.sprintIdDisplay,
        taskflowstatusId: payload.taskflowstatusId,
        taskflowstatusIdDisplay: payload.taskflowstatusIdDisplay,
        scenariofieldconfigId: payload.scenariofieldconfigId,
        scenariofieldconfigIdDisplay: payload.scenariofieldconfigIdDisplay,
        applicationCategory: payload.applicationCategory,
        applicationCategoryCustomFieldId: payload.applicationCategoryCustomFieldId,
        defectCategory: payload.defectCategory,
        defectCategoryCustomFieldId: payload.defectCategoryCustomFieldId,
        tagIds: payload.tagIds,
        tagIdsDisplay: payload.tagIdsDisplay,
        customfields: Array.isArray(payload.customfields) ? payload.customfields.slice(0, 20) : undefined,
      }) : undefined,
      existing: row.existing ? cleanDisplayObject({
        targetTaskId: row.existing.targetTaskId,
        targetUniqueId: row.existing.targetUniqueId,
        syncStatus: row.existing.syncStatus,
        lastSyncedAt: row.existing.lastSyncedAt,
        sheetTargetOverride: row.existing.sheetTargetOverride,
        sheetTargetDisplayId: row.existing.sheetTargetDisplayId,
        sheetTargetRow: row.existing.sheetTargetRow,
        sheetTargetColumns: row.existing.sheetTargetColumns,
      }) : undefined,
      remoteExisting: row.remoteExisting ? cleanDisplayObject({
        targetTaskId: row.remoteExisting.targetTaskId,
        targetUniqueId: row.remoteExisting.targetUniqueId,
        source: row.remoteExisting.source,
        ignored: row.remoteExisting.ignored,
      }) : undefined,
      targetFieldVerification: compactTargetFieldVerification(row),
      comparisonSnapshot: row.comparisonSnapshot,
      targetVerification: row.targetVerification,
      scheduleWarnings: row.scheduleWarnings,
      policyDecision: row.policyDecision,
      strategyEffects: Array.isArray(row.strategyEffects) ? row.strategyEffects.slice(0, 20) : undefined,
      childPlan: row.childPlan ? cleanDisplayObject({
        needsSync: row.childPlan.needsSync,
        comments: row.childPlan.comments,
        targetComments: row.childPlan.targetComments,
        targetCommentRead: row.childPlan.targetCommentRead,
        attachments: row.childPlan.attachments,
      }) : undefined,
    });
  }

  function cleanDisplayObject(obj = {}) {
    const out = {};
    for (const [key, value] of Object.entries(obj)) {
      if (value === undefined || value === null || value === "") continue;
      if (Array.isArray(value) && !value.length) continue;
      out[key] = value;
    }
    return out;
  }

  function clipText(value, max = 500) {
    const text = String(value ?? "");
    return text.length > max ? `${text.slice(0, max)}...` : text;
  }

  function refreshLogSourceResults(data = {}) {
    const rows = Array.isArray(data?.sourceResults)
      ? data.sourceResults
      : Array.isArray(data?.captured?.sourceResults)
        ? data.captured.sourceResults
        : [];
    return rows.map((row) => cleanDisplayObject({
      id: clipText(row?.id || row?.viewId || "", 160),
      name: clipText(row?.name || "", 160),
      projectKey: clipText(row?.projectKey || "", 160),
      workItemTypeKey: clipText(row?.workItemTypeKey || "", 160),
      ok: row?.ok !== false,
      returned: Number(row?.returned || 0),
      selected: Number(row?.selected || 0),
      complete: row?.complete === true,
      warning: clipText(row?.warning || "", 1000),
      error: clipText(row?.error || "", 1600),
    }));
  }

  function writeRecordsRefreshLog(refreshLogId, level, status, body = {}, data = {}, error = "") {
    try {
      let currentConfig;
      try {
        currentConfig = configFromBody(body);
      } catch {
        currentConfig = getFeishuProjectSyncConfig(getConfig()?.feishuProjectSync || {});
      }
      const sourceViews = getFeishuSourceViews(currentConfig).filter((view) => view.enabled !== false);
      const safe = sanitizeFeishuProjectMcpPayload({
        event: "records-refresh",
        refreshLogId,
        status,
        source: String(body.source || "records"),
        limit: parseLimit(body.limit, 20, 200),
        reconcileSnapshot: body.reconcileSnapshot === true,
        sourceCount: sourceViews.length,
        sourceTypes: sourceViews.map((view) => view.sourceWorkItemTypeKey || "").filter(Boolean),
        ...(status === "started" ? {} : { ok: status === "failed" ? false : data?.ok !== false }),
        partial: data?.partial === true,
        refreshed: Number(data?.refreshed || 0),
        skippedCount: Number(data?.skippedCount || 0),
        firstError: clipText(data?.firstError || data?.error || "", 1600),
        error: clipText(error || "", 1600),
        sources: refreshLogSourceResults(data),
      }, currentConfig);
      writeLog("system", level, "feishu-project-sync", `[records-refresh] ${JSON.stringify(safe)}`);
    } catch (logError) {
      try {
        writeLog(
          "system",
          "error",
          "feishu-project-sync",
          `[records-refresh] 日志写入失败 refreshLogId=${refreshLogId}: ${clipText(logError?.message || logError, 500)}`,
        );
      } catch {}
    }
  }

  function safeRecordsRefreshError(body = {}, error = "") {
    try {
      const currentConfig = configFromBody(body);
      return sanitizeFeishuProjectMcpPayload({ error: clipText(error, 1600) }, currentConfig).error;
    } catch {
      return clipText(error, 1600);
    }
  }

  function runResultPreview(run) {
    if (!run?.result) return { available: false, result: null, preview: null, previewText: "" };
    const preview = compactPreviewData(run.result);
    return {
      available: true,
      result: syncResultSummary(run.result),
      preview,
      previewText: JSON.stringify(preview, null, 2),
    };
  }

  function publicRun(run, { includeResult = false, includePreview = false } = {}) {
    if (!run) return null;
    const hasResult = run.result !== undefined && run.result !== null;
    const out = {
      id: run.id,
      mode: run.mode,
      status: run.status,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
      events: Array.isArray(run.events) ? run.events.slice(-RUN_PUBLIC_EVENT_LIMIT) : [],
      hasResult,
      resultSummary: hasResult ? syncResultSummary(run.result) : null,
      error: run.error,
    };
    if (includeResult) out.result = run.result;
    if (includePreview) Object.assign(out, runResultPreview(run));
    return {
      ...out,
    };
  }

  function runProgress(run) {
    return (event) => appendRunEvent(run, event);
  }

  function finishRun(run, status, patch = {}) {
    run.status = status;
    run.finishedAt = new Date().toISOString();
    if (patch.result !== undefined) run.result = patch.result;
    if (patch.error !== undefined) run.error = patch.error;
    appendRunEvent(run, {
      level: status === "success" ? "info" : "error",
      phase: status === "success" ? "done" : "failed",
      message: status === "success" ? "同步任务已完成" : "同步任务已停止",
      error: run.error || run.result?.firstError || "",
    });
    notifyRunSubscribers(run, "run", publicRun(run));
  }

  function planNow() {
    const value = typeof now === "function" ? now() : Date.now();
    return Number.isFinite(Number(value)) ? Number(value) : Date.now();
  }

  function syncRecordRef(value = {}) {
    const row = value?.item && typeof value.item === "object" ? value.item : value;
    return {
      sourceSystem: String(row?.sourceSystem || row?.source_system || "feishu_project").trim(),
      sourceProjectKey: String(row?.sourceProjectKey || row?.source_project_key || row?.spaceKey || row?.space_key || row?.projectKey || row?.project_key || "").trim(),
      sourceWorkItemTypeKey: String(row?.sourceWorkItemTypeKey || row?.source_work_item_type_key || row?.workItemTypeKey || row?.work_item_type_key || row?.typeKey || row?.type_key || "").trim(),
      sourceWorkItemId: String(row?.sourceWorkItemId || row?.source_work_item_id || row?.workItemId || row?.work_item_id || "").trim(),
      targetSystem: String(row?.targetSystem || row?.target_system || "teambition").trim(),
    };
  }

  function syncRecordRefWithFallback(value = {}, fallback = {}) {
    const primary = syncRecordRef(value);
    const secondary = syncRecordRef(fallback);
    return Object.fromEntries(Object.keys(secondary).map((key) => [key, primary[key] || secondary[key]]));
  }

  function syncRecordIdentityKey(value = {}) {
    const ref = syncRecordRef(value);
    if (!ref.sourceProjectKey || !ref.sourceWorkItemTypeKey || !ref.sourceWorkItemId) return "";
    return [
      ref.sourceSystem,
      ref.sourceProjectKey,
      ref.sourceWorkItemTypeKey,
      ref.sourceWorkItemId,
      ref.targetSystem,
    ].map((part) => encodeURIComponent(part)).join("/");
  }

  function requestOwnerKey(req) {
    const token = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "").trim();
    return token ? createHash("sha256").update(token).digest("hex") : "";
  }

  function cleanupPreparedSyncPlans() {
    const current = planNow();
    for (const [id, plan] of preparedSyncPlans) {
      if (!plan || plan.expiresAt <= current) preparedSyncPlans.delete(id);
    }
    while (preparedSyncPlans.size >= PREPARED_SYNC_PLAN_LIMIT) {
      const oldest = preparedSyncPlans.keys().next().value;
      if (!oldest) break;
      preparedSyncPlans.delete(oldest);
    }
  }

  function publicPreparedResult(result = {}) {
    if (!result || typeof result !== "object") return result;
    const item = result.item && typeof result.item === "object" ? { ...result.item } : result.item;
    if (item && typeof item === "object") delete item.raw;
    return { ...result, ...(item ? { item } : {}) };
  }

  function normalizePreparedRecordPreviewResult(previewResult, recordRef) {
    const result = previewResult && typeof previewResult === "object" ? previewResult : {};
    const skipped = result.action === "skip" || result.skipped === true;
    const failed = !previewResult || result.ok === false || skipped;
    const error = failed
      ? String(result.error || result.firstError || result.reason || result.scopeStatus?.message || (previewResult ? "dry-run 未生成可生效操作" : "本行 dry-run 结果为空")).trim()
      : "";
    return {
      result: {
        ...result,
        item: result.item && typeof result.item === "object" ? result.item : recordRef,
        ...(failed ? { ok: false, error } : {}),
      },
      status: failed ? "failed" : "ready",
    };
  }

  function principal(req) {
    return verifyToken(String(req.headers.authorization || "").replace(/^Bearer\s+/i, "").trim());
  }

  function isAdminReq(req) {
    const p = principal(req);
    return !!p && (p.role === "super" || p.role === "admin");
  }

  function requireAdmin(req, res) {
    if (isAdminReq(req)) return true;
    res.status(403).json({ success: false, error: "feishu project sync requires admin" });
    return false;
  }

  function parseLimit(value, fallback = 100, max = 1000) {
    const n = Number.parseInt(value, 10);
    if (!Number.isFinite(n) || n <= 0) return fallback;
    return Math.min(n, max);
  }

  function parseBool(value) {
    if (value === undefined || value === null || value === "") return undefined;
    return !["false", "0", "no", "off"].includes(String(value).toLowerCase());
  }

  function runOptions(body = {}, extra = {}) {
    const config = configFromBody(body);
    return {
      ...extra,
      workItems: body?.workItems,
      workItemIds: body?.workItemIds,
      workItemId: body?.workItemId,
      workItemNos: body?.workItemNos || body?.problemNos || body?.sourceProblemNos,
      workItemNo: body?.workItemNo || body?.problemNo || body?.sourceProblemNo,
      projectKey: body?.projectKey,
      typeKey: body?.typeKey,
      stage: body?.stage,
      retryErrors: body?.retryErrors,
      includeFuture: body?.includeFuture,
      source: body?.source,
      useRawPayloads: body?.useRawPayloads,
      stopOnFirstError: body?.stopOnFirstError,
      failFast: body?.failFast,
      sheetTargetByProblemNo: body?.sheetTargetByProblemNo,
      onProgress: extra.onProgress || body?.onProgress,
      onPreparedItems: extra.onPreparedItems || body?.onPreparedItems,
      now: body?.preparedSyncNow,
      scope: body?.scope,
      limit: body?.limit,
      config,
    };
  }

  function configFromBody(body = {}) {
    const base = body.config && typeof body.config === "object" ? body.config : {};
    const scope = body.scope && typeof body.scope === "object" ? body.scope : null;
    const filters = Array.isArray(scope?.filters) ? scope.filters : Array.isArray(scope?.readScope?.filters) ? scope.readScope.filters : [];
    const rawSourceViews = body.sourceViews ?? scope?.sourceViews;
    const hasSourceViews = Array.isArray(rawSourceViews);
    const sourceViews = hasSourceViews ? rawSourceViews.map(normalizeSourceViewInput).filter(Boolean) : [];
    const sourceView = hasSourceViews ? null : normalizeSourceViewInput(body.sourceView || scope?.sourceView || {
      url: body.sourceViewUrl || body.viewUrl || body.url || body.homepageUrl,
      viewId: body.sourceViewId || body.viewId,
    });
    const sort = normalizeSortInput(body.sort || scope?.sort);
    if (!filters.length && !Array.isArray(body.requiredAssigneeKeywords) && !hasSourceViews && !sourceView && !sort.length) {
      return Object.keys(base).length ? base : undefined;
    }
    const patch = { ...base };
    const syncPatch = {};
    if (filters.length) {
      syncPatch.readScope = {
        enabled: true,
        match: scope?.match || scope?.readScope?.match || "all",
        filters,
      };
    }
    if (sort.length) syncPatch.sort = sort;
    if (Array.isArray(body.requiredAssigneeKeywords)) syncPatch.requiredAssigneeKeywords = body.requiredAssigneeKeywords;
    if (Object.keys(syncPatch).length) patch.sync = { ...(base.sync || {}), ...syncPatch };
    if (hasSourceViews) {
      patch.feishu = {
        ...(base.feishu || {}),
        sourceViews,
      };
    }
    if (sourceView) {
      const parsed = parseFeishuProjectUrl(sourceView.url || "");
      patch.feishu = {
        ...(base.feishu || {}),
        sourceViews: [sourceView],
        sourceView,
        ...(parsed.sourceProjectKey ? { spaceKey: parsed.sourceProjectKey } : {}),
        ...(parsed.sourceWorkItemTypeKey ? { workItemTypeKey: parsed.sourceWorkItemTypeKey } : {}),
        ...(sourceView.url ? { web: { ...(base.feishu?.web || {}), homepageUrl: sourceView.url } } : {}),
      };
    }
    return patch;
  }

  function normalizeSourceViewInput(value) {
    if (!value) return null;
    const input = typeof value === "string" ? { url: value } : value;
    if (!input || typeof input !== "object") return null;
    const parsed = parseFeishuProjectUrl(input.url || "");
    const out = {
      id: String(input.id || "").trim(),
      name: String(input.name || input.label || "").trim(),
      enabled: input.enabled !== false,
      isDefault: input.isDefault === true || input.default === true || input.primary === true,
      url: String(input.url || "").trim(),
      viewId: String(parsed.viewId || input.viewId || input.view_id || "").trim(),
      scope: String(input.scope || parsed.scope || "").trim(),
      node: String(input.node || parsed.node || "").trim(),
      sourceProjectKey: String(parsed.sourceProjectKey || input.sourceProjectKey || input.projectKey || "").trim(),
      sourceWorkItemTypeKey: String(parsed.sourceWorkItemTypeKey || input.sourceWorkItemTypeKey || input.workItemTypeKey || input.typeKey || "").trim(),
    };
    return out.url || out.viewId ? out : null;
  }

  function rawSourceViewsFromConfig(config = undefined) {
    const feishu = config?.feishu;
    if (!feishu || typeof feishu !== "object" || Array.isArray(feishu)) return undefined;
    if (Object.prototype.hasOwnProperty.call(feishu, "sourceViews")) {
      return Array.isArray(feishu.sourceViews) ? feishu.sourceViews : [null];
    }
    if (Object.prototype.hasOwnProperty.call(feishu, "sourceView")) {
      const sourceView = typeof feishu.sourceView === "string"
        ? { url: feishu.sourceView }
        : feishu.sourceView;
      return [sourceView];
    }
    return undefined;
  }

  function rawSourceViewsFromBody(body = {}) {
    const scope = body.scope && typeof body.scope === "object" ? body.scope : {};
    if (Object.prototype.hasOwnProperty.call(body, "sourceViews")) {
      return Array.isArray(body.sourceViews) ? body.sourceViews : [null];
    }
    if (Object.prototype.hasOwnProperty.call(scope, "sourceViews")) {
      return Array.isArray(scope.sourceViews) ? scope.sourceViews : [null];
    }
    const explicitSingle = body.sourceView ?? scope.sourceView;
    if (explicitSingle !== undefined) {
      return [typeof explicitSingle === "string" ? { url: explicitSingle } : explicitSingle];
    }
    const directUrl = body.sourceViewUrl || body.viewUrl || body.url || body.homepageUrl;
    if (directUrl || body.sourceViewId || body.viewId) {
      return [{
        url: directUrl,
        viewId: body.sourceViewId || body.viewId,
      }];
    }
    return rawSourceViewsFromConfig(body.config);
  }

  function sourceViewsValidationError(validation) {
    const duplicate = validation.errors.some((error) => ["duplicate", "duplicate-id"].includes(error.code));
    const error = new Error(validation.errors.map((item) => item.message).join("；") || "飞书工单来源配置无效");
    error.statusCode = duplicate ? 409 : 400;
    error.sourceViewsValidation = validation;
    return error;
  }

  function assertValidSourceViews(body = {}, config = undefined) {
    const explicit = rawSourceViewsFromBody(body);
    const configured = explicit === undefined
      ? rawSourceViewsFromConfig(config)
        ?? rawSourceViewsFromConfig(getConfig()?.feishuProjectSync)
      : explicit;
    if (configured === undefined) return { ok: true, errors: [], enabledCount: 0, total: 0 };
    const validation = validateFeishuSourceViewsConfig(configured);
    if (!validation.ok) throw sourceViewsValidationError(validation);
    return validation;
  }

  function normalizeSortInput(value) {
    const list = Array.isArray(value) ? value : (value && typeof value === "object" ? [value] : []);
    return list.map((rule, index) => {
      if (!rule || typeof rule !== "object") return null;
      const fieldKey = String(rule.fieldKey || rule.key || rule.field || rule.column || "").trim();
      const fieldName = String(rule.fieldName || rule.name || rule.label || fieldKey).trim();
      const directionRaw = String(rule.direction || rule.order || rule.sort || "desc").trim().toLowerCase();
      const direction = ["asc", "ascending", "1"].includes(directionRaw) ? "asc" : "desc";
      if (!fieldKey && !fieldName) return null;
      return {
        id: String(rule.id || fieldKey || fieldName || `sort-${index}`).trim(),
        enabled: rule.enabled !== false,
        fieldKey,
        fieldName,
        direction,
      };
    }).filter(Boolean);
  }

  function validWebhookSecret(req, cfg) {
    const secret = cfg.sync?.webhookSecret || "";
    if (!secret) return false;
    const provided = String(req.headers["x-feishu-project-sync-secret"] || req.headers["x-feishu-webhook-secret"] || "");
    return provided === secret;
  }

  function webUrlFrom(body = {}, sourceView = null, cfg = getFeishuProjectSyncConfig()) {
    return sourceView?.url || body.url || body.homepageUrl || body.sourceView?.url || cfg.feishu?.sourceView?.url || cfg.feishu?.web?.homepageUrl || "";
  }

  function webCaptureOptions(body = {}, limit = 20, cfg = getFeishuProjectSyncConfig(), config = undefined, sourceView = null) {
    return {
      url: webUrlFrom(body, sourceView, cfg),
      limit,
      timeoutMs: Math.max(30000, Number(body.timeoutMs || 60000)),
      workItemIds: resolveWebCaptureWorkItemIds(body, cfg, config),
      spaceKey: sourceView?.sourceProjectKey || cfg.feishu?.spaceKey || body.projectKey || "",
      workItemTypeKey: sourceView?.sourceWorkItemTypeKey || cfg.feishu?.workItemTypeKey || body.typeKey || "",
    };
  }

  function explicitSourceViewsFromBody(body = {}) {
    const scope = body.scope && typeof body.scope === "object" ? body.scope : {};
    const rawMany = body.sourceViews ?? scope.sourceViews;
    if (Array.isArray(rawMany)) return rawMany.map(normalizeSourceViewInput).filter(Boolean);
    const rawOne = body.sourceView || scope.sourceView;
    if (rawOne) {
      const normalized = normalizeSourceViewInput(rawOne);
      return normalized ? [normalized] : [];
    }
    const directUrl = body.sourceViewUrl || body.viewUrl || body.url || body.homepageUrl;
    if (directUrl || body.sourceViewId || body.viewId) {
      const normalized = normalizeSourceViewInput({
        url: directUrl,
        viewId: body.sourceViewId || body.viewId,
      });
      return normalized ? [normalized] : [];
    }
    return undefined;
  }

  function sourceViewContexts(body = {}, config = undefined) {
    const cfg = getFeishuProjectSyncConfig(config || {});
    const explicit = explicitSourceViewsFromBody(body);
    const sourceViews = explicit === undefined
      ? getFeishuSourceViews(cfg)
      : explicit;
    return (Array.isArray(sourceViews) ? sourceViews : [])
      .filter((sourceView) => sourceView && sourceView.enabled !== false)
      .map((sourceView, index) => {
        const parsed = parseFeishuProjectUrl(sourceView.url || "");
        const normalized = {
          ...sourceView,
          id: String(sourceView.id || sourceView.viewId || parsed.viewId || `source-${index + 1}`).trim(),
          name: String(sourceView.name || sourceView.label || "").trim(),
          sourceProjectKey: String(parsed.sourceProjectKey || sourceView.sourceProjectKey || sourceView.projectKey || "").trim(),
          sourceWorkItemTypeKey: String(parsed.sourceWorkItemTypeKey || sourceView.sourceWorkItemTypeKey || sourceView.workItemTypeKey || sourceView.typeKey || "").trim(),
          viewId: String(parsed.viewId || sourceView.viewId || "").trim(),
          scope: String(parsed.scope || sourceView.scope || "").trim(),
          node: String(parsed.node || sourceView.node || "").trim(),
        };
        const isolatedConfig = getFeishuProjectSyncConfig(configForFeishuSourceView(cfg, normalized));
        normalized.sourceProjectKey = normalized.sourceProjectKey || String(isolatedConfig.feishu?.spaceKey || "").trim();
        normalized.sourceWorkItemTypeKey = normalized.sourceWorkItemTypeKey || String(isolatedConfig.feishu?.workItemTypeKey || "").trim();
        return {
          sourceView: normalized,
          config: isolatedConfig,
          projectKey: normalized.sourceProjectKey,
          typeKey: normalized.sourceWorkItemTypeKey,
        };
      });
  }

  function capturedWorkItemIdentity(item = {}, context = {}) {
    const projectKey = String(
      item.sourceProjectKey
        || item.source_project_key
        || item._feishuSourceView?.sourceProjectKey
        || item.spaceKey
        || item.space_key
        || item.projectKey
        || item.project_key
        || context.projectKey
        || "",
    ).trim();
    const typeKey = String(
      item.sourceWorkItemTypeKey
        || item.source_work_item_type_key
        || item._feishuSourceView?.sourceWorkItemTypeKey
        || item.workItemTypeKey
        || item.work_item_type_key
        || item.typeKey
        || item.type_key
        || context.typeKey
        || "",
    ).trim();
    const workItemId = String(
      item.sourceWorkItemId
        || item.source_work_item_id
        || item.workItemId
        || item.work_item_id
        || item.id
        || "",
    ).trim();
    return {
      projectKey,
      typeKey,
      workItemId,
      key: workItemId ? feishuSourceWorkItemIdentity(item, context.config || {}) : "",
    };
  }

  function withCapturedSourceIdentity(item = {}, context = {}) {
    return annotateFeishuSourceWorkItem(item, {
      ...(context.sourceView || {}),
      sourceProjectKey: context.projectKey || context.sourceView?.sourceProjectKey || "",
      sourceWorkItemTypeKey: context.typeKey || context.sourceView?.sourceWorkItemTypeKey || "",
    });
  }

  function sourceResultSummary(context, capture = {}, added = 0, deduped = 0, captureLimit = 200) {
    const sourceView = context.sourceView || {};
    const returned = Array.isArray(capture.items) ? capture.items.length : 0;
    const total = Number.isFinite(Number(capture.total)) ? Number(capture.total) : returned;
    return {
      id: sourceView.id || sourceView.viewId || sourceView.url || "",
      name: sourceView.name || "",
      url: sourceView.url || "",
      projectKey: context.projectKey || "",
      workItemTypeKey: context.typeKey || "",
      viewId: sourceView.viewId || "",
      ok: capture.ok !== false,
      total,
      returned,
      selected: added,
      deduped,
      complete: capture.ok !== false && returned < captureLimit && total <= returned,
      finalUrl: capture.finalUrl || "",
      tool: capture.tool,
      effectiveTransport: capture.effectiveTransport || "",
      warning: capture.warning || "",
      error: capture.ok === false ? String(capture.error || "Feishu source capture failed") : "",
    };
  }

  async function captureConfiguredSources(kind, body = {}, {
    limit = parseLimit(body.limit, 20, 200),
    config = configFromBody(body),
    preparedMcp = false,
  } = {}) {
    assertValidSourceViews(body, config);
    const contexts = sourceViewContexts(body, config);
    if (!contexts.length) {
      return {
        ok: false,
        partial: true,
        error: "No enabled Feishu source view is configured",
        items: [],
        total: 0,
        capturedTotal: 0,
        sourceResults: [],
      };
    }

    const items = [];
    const seen = new Set();
    const sourceResults = [];
    const captures = [];
    const sourceBatches = [];
    const configByIdentity = new Map();
    const attachmentRefreshByIdentity = new Map();

    for (const context of contexts) {
      let capture;
      try {
        if (kind === "web") {
          capture = await captureWebItems(webCaptureOptions(
            body,
            limit,
            context.config,
            context.config,
            context.sourceView,
          ));
        } else {
          const captureOptions = {
            ...body,
            limit,
            sourceView: context.sourceView,
            sourceViewUrl: context.sourceView.url,
            url: context.sourceView.url || body.url,
            projectKey: context.projectKey,
            typeKey: context.typeKey,
            workItemIds: body.workItemIds,
            workItemId: body.workItemId,
            workItemNos: body.workItemNos || body.problemNos || body.sourceProblemNos,
            workItemNo: body.workItemNo || body.problemNo || body.sourceProblemNo,
            scope: {
              ...(body.scope && typeof body.scope === "object" ? body.scope : {}),
              sourceView: context.sourceView,
              projectKey: context.projectKey,
              typeKey: context.typeKey,
            },
            config: context.config,
          };
          capture = preparedMcp
            ? await capturePreparedMcpItems(context.config, captureOptions)
            : await captureMcpItems(context.config, captureOptions);
        }
      } catch (err) {
        capture = {
          ok: false,
          error: err?.message || String(err),
          items: [],
          total: 0,
        };
      }
      if (!capture || typeof capture !== "object") {
        capture = {
          ok: false,
          error: "Feishu source capture returned an invalid response",
          items: [],
          total: 0,
        };
      }
      if (kind === "mcp") {
        capture = sanitizeFeishuProjectMcpPayload(capture, context.config);
      }

      const capturedItems = Array.isArray(capture?.items) ? capture.items : [];
      let added = 0;
      let deduped = 0;
      for (const rawItem of capturedItems) {
        const item = withCapturedSourceIdentity(rawItem, context);
        const identity = capturedWorkItemIdentity(item, context);
        if (!identity.key) continue;
        if (seen.has(identity.key)) {
          deduped += 1;
          continue;
        }
        seen.add(identity.key);
        items.push(item);
        configByIdentity.set(identity.key, context.config);
        if (typeof capture?.refreshAttachmentDownload === "function") {
          attachmentRefreshByIdentity.set(identity.key, capture.refreshAttachmentDownload);
        }
        added += 1;
      }
      captures.push({ context, capture });
      sourceBatches.push({ sourceView: context.sourceView, items: capturedItems });
      sourceResults.push(sourceResultSummary(context, capture || {}, added, deduped, limit));
    }

    const failedSources = sourceResults.filter((result) => !result.ok);
    const selectedItems = mergeFeishuSourceWorkItems(sourceBatches, config || {}, {
      limit,
      sort: body.sort || body.scope?.sort,
    });
    const firstCapture = captures.length === 1 ? captures[0].capture || {} : {};
    const error = failedSources.map((result) => `${result.name || result.id || result.url}: ${result.error}`).join("; ");
    const configForItem = (item) => {
      const identity = capturedWorkItemIdentity(item);
      return configByIdentity.get(identity.key) || config;
    };
    const refreshAttachmentDownload = attachmentRefreshByIdentity.size
      ? (attachment, item) => {
          const identity = capturedWorkItemIdentity(item);
          const refresh = attachmentRefreshByIdentity.get(identity.key);
          if (!refresh) throw new Error(`No Feishu MCP attachment refresher for ${identity.key || "unknown work item"}`);
          return refresh(attachment, item);
        }
      : firstCapture.refreshAttachmentDownload;

    return {
      ...firstCapture,
      ok: failedSources.length === 0,
      partial: failedSources.length > 0,
      error: error || (failedSources.length ? "One or more Feishu source views failed" : ""),
      items: selectedItems,
      total: selectedItems.length,
      capturedTotal: items.length,
      sourceResults,
      configForItem,
      refreshAttachmentDownload,
    };
  }

  function resolveWebCaptureWorkItemIds(body = {}, cfg = getFeishuProjectSyncConfig(), config = undefined) {
    const directIds = collectScalarValues(
      body.workItemIds,
      body.workItemId,
      body.scope?.workItemIds,
      body.scope?.workItemId,
    ).filter((value) => !/[A-Z][A-Z0-9]+-\d+/i.test(String(value || "")));
    const requested = requestedProblemNoSet(body);
    const ids = [...directIds];
    if (requested.size) {
      const records = listFeishuProjectSyncRecords({
        projectKey: cfg.feishu?.spaceKey || body.projectKey || "",
        typeKey: cfg.feishu?.workItemTypeKey || body.typeKey || "",
        limit: parseLimit(body.stateLimit || body.recordLimit, 1000, 10000),
        config,
      });
      const byProblem = syncRecordsByProblemNo(records);
      for (const problemNo of requested) {
        const record = byProblem.get(problemNo);
        const id = String(record?.sourceWorkItemId || record?.source_work_item_id || "").trim();
        if (id) ids.push(id);
      }
    }
    return Array.from(new Set(ids.map((value) => String(value || "").trim()).filter(Boolean)));
  }

  function shouldStopOnFirstError(body = {}, dryRun = true, cfg = getFeishuProjectSyncConfig()) {
    if (dryRun) return false;
    const explicit = parseBool(body.stopOnFirstError ?? body.failFast ?? body.scope?.stopOnFirstError ?? body.scope?.failFast);
    if (explicit !== undefined) return explicit;
    return cfg.sync?.stopOnFirstError !== false;
  }

  function failedConfiguredCaptureResult(capture = {}, {
    source,
    dryRun,
    captured = {},
  } = {}) {
    const sourceResults = Array.isArray(capture.sourceResults) ? capture.sourceResults : [];
    const capturedItems = Array.isArray(capture.items) ? capture.items.length : 0;
    return {
      ok: false,
      partial: !!capture.partial,
      source,
      dryRun,
      total: 0,
      requested: capturedItems,
      stoppedOnFirstError: false,
      firstError: capture.error || "One or more Feishu source views failed",
      sourceResults,
      captured: {
        total: capture.total,
        capturedTotal: capture.capturedTotal,
        partial: !!capture.partial,
        sourceResults,
        ...captured,
      },
      results: [],
    };
  }

  async function runWebCapture(body = {}, { dryRun = true } = {}) {
    const limit = parseLimit(body.limit, 20, 200);
    const config = configFromBody(body);
    const cfg = getFeishuProjectSyncConfig(config || {});
    const stopOnFirstError = shouldStopOnFirstError(body, dryRun, cfg);
    const progress = typeof body.onProgress === "function" ? body.onProgress : null;
    if (progress) progress({ phase: "capture-start", level: "info", message: "开始读取飞书网页列表" });
    const capture = await captureConfiguredSources("web", body, { limit, config });
    if (capture.ok === false || capture.partial === true) {
      progress?.({
        phase: "capture-failed",
        level: "error",
        message: capture.error || "One or more Feishu Web source views failed; no work items were synchronized",
      });
      return failedConfiguredCaptureResult(capture, {
        source: "feishu-web",
        dryRun,
        captured: {
          finalUrl: capture.finalUrl,
          source: capture.source,
        },
      });
    }
    const results = [];
    const selectedItems = capture.items.slice(0, limit);
    const loaderScope = {};
    if (progress) progress({ phase: "items-loaded", level: "info", message: `已读取 ${selectedItems.length} 条候选飞书单`, total: selectedItems.length });
    for (let index = 0; index < selectedItems.length; index++) {
      const workItem = selectedItems[index];
      if (progress) progress({ phase: "item-queued", level: "info", message: `处理第 ${index + 1}/${selectedItems.length} 条`, index: index + 1, total: selectedItems.length });
      const itemConfig = capture.configForItem?.(workItem) || config;
      const result = await syncWorkItem(workItem, { dryRun, config: itemConfig, onProgress: progress, loaderScope, sheetTargetByProblemNo: body.sheetTargetByProblemNo, now: body.preparedSyncNow });
      results.push(result);
      if (result?.ok === false && stopOnFirstError) {
        if (progress) progress({ phase: "stopped", level: "error", message: "遇到第一条失败，已停止后续同步", error: result.error || "", index: index + 1, total: selectedItems.length });
        break;
      }
    }
    if (typeof body.onPreparedItems === "function") {
      body.onPreparedItems({
        source: "web",
        workItems: selectedItems.slice(0, results.length),
        results,
        config: cfg,
        itemConfigs: selectedItems.slice(0, results.length).map((item) => capture.configForItem?.(item) || config),
        loaderScope,
        sheetTargetByProblemNo: body.sheetTargetByProblemNo || {},
      });
    }
    return {
      ok: capture.ok && results.every((r) => r.ok),
      partial: !!capture.partial,
      sourceResults: capture.sourceResults,
      source: "feishu-web",
      dryRun,
      total: results.length,
      requested: selectedItems.length,
      stoppedOnFirstError: stopOnFirstError && results.some((r) => r?.ok === false) && results.length < selectedItems.length,
      firstError: results.find((r) => !r.ok)?.error || capture.error || "",
      captured: {
        total: capture.total,
        capturedTotal: capture.capturedTotal,
        finalUrl: capture.finalUrl,
        source: capture.source,
        partial: !!capture.partial,
        sourceResults: capture.sourceResults,
      },
      results,
    };
  }

  function mcpCapturedWorkItemId(value = {}) {
    return String(value?.sourceWorkItemId || value?.source_work_item_id || value?.workItemId || value?.work_item_id || value?.id || "").trim();
  }

  async function capturePreparedMcpItems(cfg, options = {}) {
    const batch = await captureMcpItems(cfg, options);
    if (options.explicitRecordCapture !== true) return batch;
    const requestedIds = Array.from(new Set([
      ...(Array.isArray(options.workItemIds) ? options.workItemIds : []),
      options.workItemId,
    ].map((value) => String(value || "").trim()).filter(Boolean)));
    if (requestedIds.length < 2) return batch;

    const batchItems = Array.isArray(batch?.items) ? batch.items : [];
    const requestedIdSet = new Set(requestedIds);
    const items = batchItems.filter((item) => requestedIdSet.has(mcpCapturedWorkItemId(item)));
    const foundIds = new Set(items.map(mcpCapturedWorkItemId).filter(Boolean));
    const missingIds = requestedIds.filter((id) => !foundIds.has(id));
    const recoveredIds = [];
    const recoveryWarnings = [];
    let refreshAttachmentDownload = batch?.refreshAttachmentDownload;
    for (const id of missingIds) {
      let recovered;
      try {
        recovered = await captureMcpItems(cfg, {
          ...options,
          limit: 1,
          workItemIds: [id],
          workItemId: id,
          workItemNos: [],
          workItemNo: undefined,
          problemNos: [],
          problemNo: undefined,
          sourceProblemNos: [],
          sourceProblemNo: undefined,
          scope: {
            ...(options.scope && typeof options.scope === "object" ? options.scope : {}),
            workItemIds: [id],
            workItemId: id,
            workItemNos: [],
            workItemNo: undefined,
            problemNos: [],
            problemNo: undefined,
          },
        });
      } catch (err) {
        recoveryWarnings.push(`${id}: ${err?.message || String(err)}`);
        continue;
      }
      if (!refreshAttachmentDownload && recovered?.refreshAttachmentDownload) {
        refreshAttachmentDownload = recovered.refreshAttachmentDownload;
      }
      const recoveredItem = (Array.isArray(recovered?.items) ? recovered.items : [])
        .find((item) => mcpCapturedWorkItemId(item) === id);
      if (recoveredItem) {
        items.push(recoveredItem);
        foundIds.add(id);
        recoveredIds.push(id);
      } else {
        recoveryWarnings.push(`${id}: ${recovered?.error || recovered?.warning || "单条 MCP 读取仍未返回该工单"}`);
      }
    }
    const remainingIds = requestedIds.filter((id) => !foundIds.has(id));
    const itemById = new Map(items.map((item) => [mcpCapturedWorkItemId(item), item]));
    const orderedItems = requestedIds.map((id) => itemById.get(id)).filter(Boolean);
    const warning = [
      batch?.warning,
      ...recoveryWarnings,
      remainingIds.length ? `明确选择的飞书工单仍未返回：${remainingIds.join(", ")}` : "",
    ].map((value) => String(value || "").trim()).filter(Boolean).join("; ");
    return {
      ...(batch || {}),
      ok: batch?.ok === true || orderedItems.length > 0,
      error: orderedItems.length ? undefined : batch?.error,
      items: orderedItems,
      total: orderedItems.length,
      warning,
      refreshAttachmentDownload,
      explicitRecordRecovery: {
        requestedIds,
        batchReturnedIds: batchItems.map(mcpCapturedWorkItemId).filter(Boolean),
        attemptedIds: missingIds,
        recoveredIds,
        missingIds: remainingIds,
      },
    };
  }

  async function runMcpCapture(body = {}, { dryRun = true } = {}) {
    const limit = parseLimit(body.limit, 20, 200);
    const config = configFromBody(body);
    const cfg = getFeishuProjectSyncConfig(config || {});
    const stopOnFirstError = shouldStopOnFirstError(body, dryRun, cfg);
    const progress = typeof body.onProgress === "function" ? body.onProgress : null;
    const captureBody = body.preparedRecordSync === true
      ? {
          ...body,
          filters: [],
          requiredAssigneeKeywords: [],
          scope: {
            ...(body.scope && typeof body.scope === "object" ? body.scope : {}),
            filters: [],
            requiredAssigneeKeywords: [],
            readScope: {
              ...(body.scope?.readScope && typeof body.scope.readScope === "object" ? body.scope.readScope : {}),
              enabled: false,
              filters: [],
            },
          },
          explicitRecordCapture: true,
        }
      : body;
    if (progress) progress({ phase: "capture-start", level: "info", message: "开始读取飞书 MCP 列表" });
    const capture = await captureConfiguredSources("mcp", captureBody, {
      limit,
      config,
      preparedMcp: true,
    });
    if (capture.ok === false || capture.partial === true) {
      progress?.({
        phase: "capture-failed",
        level: "error",
        message: capture.error || "One or more Feishu MCP source views failed; no work items were synchronized",
      });
      return failedConfiguredCaptureResult(capture, {
        source: "feishu-mcp",
        dryRun,
        captured: {
          tool: capture.tool,
          effectiveTransport: capture.effectiveTransport,
          degraded: !!capture.degraded,
          fallback: capture.fallback,
          warning: capture.warning,
          explicitRecordRecovery: capture.explicitRecordRecovery,
        },
      });
    }
    const results = [];
    const selectedItems = capture.items.slice(0, limit);
    const loaderScope = {
      refreshAttachmentDownload: capture.refreshAttachmentDownload,
    };
    if (progress) progress({ phase: "items-loaded", level: "info", message: `已读取 ${selectedItems.length} 条候选飞书单`, total: selectedItems.length });
    for (let index = 0; index < selectedItems.length; index++) {
      const workItem = selectedItems[index];
      if (progress) progress({ phase: "item-queued", level: "info", message: `处理第 ${index + 1}/${selectedItems.length} 条`, index: index + 1, total: selectedItems.length });
      const syncMcpWorkItem = body.preparedRecordSync === true ? syncWorkItem : syncFeishuProjectWorkItem;
      const itemConfig = capture.configForItem?.(workItem) || config;
      const result = await syncMcpWorkItem(workItem, { dryRun, config: itemConfig, onProgress: progress, loaderScope, sheetTargetByProblemNo: body.sheetTargetByProblemNo, now: body.preparedSyncNow });
      results.push(result);
      if (result?.ok === false && stopOnFirstError) {
        if (progress) progress({ phase: "stopped", level: "error", message: "遇到第一条失败，已停止后续同步", error: result.error || "", index: index + 1, total: selectedItems.length });
        break;
      }
    }
    if (typeof body.onPreparedItems === "function") {
      body.onPreparedItems({
        source: "mcp",
        workItems: selectedItems.slice(0, results.length),
        results,
        config: cfg,
        itemConfigs: selectedItems.slice(0, results.length).map((item) => capture.configForItem?.(item) || config),
        loaderScope,
        sheetTargetByProblemNo: body.sheetTargetByProblemNo || {},
      });
    }
    return {
      ok: capture.ok && results.every((r) => r.ok),
      partial: !!capture.partial,
      sourceResults: capture.sourceResults,
      source: "feishu-mcp",
      dryRun,
      total: results.length,
      requested: selectedItems.length,
      stoppedOnFirstError: stopOnFirstError && results.some((r) => r?.ok === false) && results.length < selectedItems.length,
      firstError: results.find((r) => !r.ok)?.error || capture.error || "",
      captured: {
        total: capture.total,
        capturedTotal: capture.capturedTotal,
        tool: capture.tool,
        effectiveTransport: capture.effectiveTransport,
        degraded: !!capture.degraded,
        fallback: capture.fallback,
        warning: capture.warning,
        explicitRecordRecovery: capture.explicitRecordRecovery,
        partial: !!capture.partial,
        sourceResults: capture.sourceResults,
      },
      results,
    };
  }

  async function runAdaptiveSync(body = {}, { dryRun = true } = {}) {
    assertValidSourceViews(body, configFromBody(body));
    const effectiveBody = dryRun ? await withDryRunSheetTargetOverrides(body) : body;
    if (!dryRun && shouldUseSourceFallback(body)) {
      const progress = typeof body.onProgress === "function" ? body.onProgress : null;
      progress?.({ phase: "source-preflight", level: "info", message: "先用 dry-run 选择最完整的飞书读取来源" });
      const preflight = await runAdaptiveSourceSelection(body, { dryRun: true, preflight: true });
      const selectedSource = normalizeSourceKey(preflight?.sourceFallback?.selectedSource) || sourceCandidates(body)[0] || "plugin";
      progress?.({ phase: "source-selected", level: "info", message: `已选择飞书读取来源：${sourceLabel(selectedSource)}` });
      const execution = await runSingleSource(selectedSource, body, { dryRun: false });
      const assessment = assessSourceResult(execution, body);
      return attachSourceFallback(execution, [
        ...(preflight?.sourceAttempts || []),
        summarizeSourceAttempt(selectedSource, execution, assessment, null, { execution: true }),
      ], {
        source: selectedSource,
        assessment,
        preflight: preflight?.sourceFallback || null,
        execution: true,
      });
    }
    const result = await runAdaptiveSourceSelection(effectiveBody, { dryRun });
    if (effectiveBody.sheetTargetPreview) return { ...result, sheetTargetPreview: effectiveBody.sheetTargetPreview };
    return result;
  }

  async function withDryRunSheetTargetOverrides(body = {}) {
    if (body.disableSheetTargetOverrides === true || body.sheetTargetOverrides === false) return body;
    const requested = requestedProblemNoSet(body);
    if (!requested.size) return body;
    const existing = body.sheetTargetByProblemNo && typeof body.sheetTargetByProblemNo === "object" ? body.sheetTargetByProblemNo : {};
    const sheet = await dryRunSheetTargetOverrides(body, requested);
    const overrides = { ...existing, ...sheet.byProblemNo };
    if (!Object.keys(overrides).length && !sheet.checked) return body;
    return {
      ...body,
      sheetTargetByProblemNo: overrides,
      sheetTargetPreview: {
        checked: sheet.checked,
        resolved: Object.keys(sheet.byProblemNo).length,
        skipped: sheet.skipped,
        warnings: sheet.warnings,
      },
    };
  }

  async function dryRunSheetTargetOverrides(body = {}, requested = requestedProblemNoSet(body)) {
    const out = { byProblemNo: {}, checked: 0, skipped: [], warnings: [] };
    try {
      const config = configFromBody(body);
      const cfg = getFeishuProjectSyncConfig(config || {});
      const sheetCfg = cfg.sheetSync || cfg.feishu?.sheetSync || {};
      if (sheetCfg.enabled === false) {
        out.warnings.push("任务表格同步已关闭，跳过 dry-run TB 映射预检查。");
        return out;
      }
      const read = await loadSheetMappingRows(sheetMappingReadBody(body), sheetCfg);
      out.warnings.push(...(read.warnings || []));
      const mappings = extractSheetMappings(read.rows || [], sheetCfg)
        .filter((mapping) => requested.has(mapping.sourceWorkItemNo));
      out.checked = mappings.length;
      for (const mapping of mappings) {
        try {
          const resolved = await resolveSheetTarget(mapping);
          if (!resolved.ok) {
            out.skipped.push({ sourceWorkItemNo: mapping.sourceWorkItemNo, sheetTargetDisplayId: mapping.sheetTargetDisplayId, reason: resolved.error });
            continue;
          }
          const rowSnapshot = sheetRowSnapshot(mapping.row);
          out.byProblemNo[mapping.sourceWorkItemNo] = {
            sourceWorkItemNo: mapping.sourceWorkItemNo,
            targetTaskId: resolved.targetTaskId,
            targetUniqueId: resolved.targetUniqueId || mapping.sheetTargetUniqueId || "",
            targetDisplayId: resolved.targetDisplayId || mapping.sheetTargetDisplayId,
            targetUpdatedAt: resolved.targetUpdatedAt || "",
            task: resolved.task || undefined,
            sheetTargetRow: rowSnapshot,
            sheetTargetColumns: Object.keys(rowSnapshot),
            source: "task-sheet-mapping",
          };
        } catch (err) {
          out.skipped.push({ sourceWorkItemNo: mapping.sourceWorkItemNo, sheetTargetDisplayId: mapping.sheetTargetDisplayId, reason: err?.message || String(err) });
        }
      }
    } catch (err) {
      out.warnings.push(`dry-run TB 映射预检查失败：${err?.message || String(err)}`);
    }
    return out;
  }

  function sheetMappingReadBody(body = {}) {
    return {
      ...body,
      url: body.sheetUrl || body.sheet_url || undefined,
    };
  }

  async function runAdaptiveSourceSelection(body = {}, { dryRun = true, preflight = false } = {}) {
    const candidates = sourceCandidates(body);
    const attempts = [];
    let best = null;
    for (const source of candidates) {
      const progress = typeof body.onProgress === "function" ? body.onProgress : null;
      progress?.({ phase: preflight ? "source-preflight-attempt" : "source-attempt", level: "info", message: `尝试飞书读取来源：${sourceLabel(source)}`, source });
      try {
        const result = await runSingleSource(source, body, { dryRun });
        const assessment = assessSourceResult(result, body);
        attempts.push(summarizeSourceAttempt(source, result, assessment));
        if (!best || assessment.score > best.assessment.score) best = { source, result, assessment };
        if (assessment.met) break;
      } catch (err) {
        const assessment = {
          met: false,
          score: 0,
          total: 0,
          requested: requestedProblemNoSet(body).size,
          missingProblemNos: Array.from(requestedProblemNoSet(body)),
          issues: [err?.message || String(err)],
        };
        attempts.push(summarizeSourceAttempt(source, null, assessment, err));
      }
    }
    if (!best) {
      const firstError = attempts.find((attempt) => attempt.error)?.error || "all Feishu source attempts failed";
      return {
        ok: false,
        dryRun,
        source: "feishu-auto",
        total: 0,
        requested: requestedProblemNoSet(body).size,
        failed: attempts.length,
        firstError,
        sourceAttempts: attempts,
        sourceFallback: {
          selectedSource: "",
          met: false,
          reason: firstError,
        },
        results: [],
      };
    }
    return attachSourceFallback(best.result, attempts, best);
  }

  async function runSingleSource(source = "plugin", body = {}, { dryRun = true } = {}) {
    const key = normalizeSourceKey(source) || "plugin";
    if (key === "mcp") return runMcpCapture({ ...body, source: "mcp" }, { dryRun });
    if (key === "web") return runWebCapture({ ...body, source: "web" }, { dryRun });
    return runSync(runOptions({ ...body, source: undefined }, {
      dryRun,
      onProgress: body.onProgress,
      onPreparedItems: body.onPreparedItems,
    }));
  }

  function shouldUseSourceFallback(body = {}) {
    if (body.sourceFallback === false || body.disableSourceFallback === true) return false;
    if (hasDirectWorkItems(body)) return false;
    return true;
  }

  function hasDirectWorkItems(body = {}) {
    return Array.isArray(body.workItems) || !!body.workItem;
  }

  function sourceCandidates(body = {}) {
    if (!shouldUseSourceFallback(body)) return [normalizeSourceKey(body.source) || "plugin"];
    const config = configFromBody(body);
    const cfg = getFeishuProjectSyncConfig(config || {});
    const explicitOrder = Array.isArray(body.sourceFallbackOrder)
      ? body.sourceFallbackOrder
      : Array.isArray(body.sources)
        ? body.sources
        : [];
    const requestedProblems = requestedProblemNoSet(body).size > 0;
    const ordered = [
      ...explicitOrder,
      body.source,
      ...(requestedProblems ? ["mcp", "web", cfg.feishu?.authMode] : [cfg.feishu?.authMode, "mcp", "web"]),
      "plugin",
    ].map(normalizeSourceKey).filter(Boolean);
    return Array.from(new Set(ordered)).filter((source) => FEISHU_SOURCE_KEYS.includes(source));
  }

  function normalizeSourceKey(value = "") {
    const key = String(value || "").trim().toLowerCase();
    if (!key || key === "auto" || key === "all") return "";
    if (["mcp", "feishu-mcp"].includes(key)) return "mcp";
    if (["web", "feishu-web", "browser"].includes(key)) return "web";
    if (["plugin", "openapi", "api", "feishu-openapi"].includes(key)) return "plugin";
    return "";
  }

  function sourceLabel(source = "") {
    if (source === "mcp") return "MCP";
    if (source === "web") return "Web";
    return "OpenAPI";
  }

  function attachSourceFallback(result = {}, attempts = [], selected = {}) {
    const assessment = selected.assessment || assessSourceResult(result, {});
    return {
      ...(result || {}),
      sourceAttempts: attempts,
      sourceFallback: {
        selectedSource: selected.source || normalizeSourceKey(result?.source) || "",
        selectedLabel: sourceLabel(selected.source),
        met: !!assessment.met,
        score: assessment.score,
        reason: assessment.issues?.[0] || "",
        issues: assessment.issues || [],
        missingProblemNos: assessment.missingProblemNos || [],
        preflight: selected.preflight || undefined,
        execution: selected.execution || undefined,
      },
    };
  }

  function summarizeSourceAttempt(source, result, assessment = {}, err = null, extra = {}) {
    return {
      source,
      label: sourceLabel(source),
      ok: !err && result?.ok !== false,
      met: !!assessment.met,
      score: Number(assessment.score || 0),
      total: Number(assessment.total || result?.total || 0),
      requested: Number(assessment.requested || result?.requested || 0),
      missingProblemNos: assessment.missingProblemNos || [],
      foundProblemNos: assessment.foundProblemNos || [],
      issues: assessment.issues || [],
      error: err ? (err?.message || String(err)) : "",
      execution: !!extra.execution,
    };
  }

  function assessSourceResult(result = {}, body = {}) {
    const requested = requestedProblemNoSet(body);
    const results = collectSyncResults(result);
    const relevantRows = requested.size
      ? results.filter((row) => rowProblemNos(row).some((no) => requested.has(no)))
      : results;
    const foundProblemNos = Array.from(new Set(results.flatMap(rowProblemNos))).filter((no) => requested.size ? requested.has(no) : true);
    const foundSet = new Set(foundProblemNos);
    const missingProblemNos = requested.size
      ? Array.from(requested).filter((no) => !foundSet.has(no))
      : [];
    const activeRows = relevantRows.filter((row) => row?.ok !== false && row?.action !== "skip");
    const failedRows = results.filter((row) => row?.ok === false);
    const sourceScopeSkipped = relevantRows.filter((row) => {
      const reason = String(row?.reason || row?.error || "");
      return row?.action === "skip" && /(assignee gate|read scope|source scope|范围|负责人)/i.test(reason);
    });
    const missingDescriptionRows = activeRows.filter((row) => !rowDescriptionText(row));
    const missingNoteRows = activeRows.filter((row) => !rowPayloadNoteText(row));
    const weakDefectRows = requested.size ? activeRows.filter((row) => !rowHasDefectDescriptionEvidence(row)) : [];
    const issues = [];
    if (!result || result.ok === false) issues.push(result?.firstError || result?.error || "读取或同步结果失败");
    if (requested.size && !results.length) issues.push("没有返回请求的问题编号");
    if (!requested.size && !hasDirectWorkItems(body) && !results.length) issues.push("没有返回候选飞书单");
    if (missingProblemNos.length) issues.push(`未找到问题编号：${missingProblemNos.join(", ")}`);
    if (failedRows.length) issues.push(`${failedRows.length} 条结果失败`);
    if (sourceScopeSkipped.length) issues.push("结果被负责人/读取范围过滤，继续尝试其它来源补齐字段");
    if (missingDescriptionRows.length) issues.push(`${missingDescriptionRows.length} 条结果缺少飞书缺陷描述`);
    if (missingNoteRows.length) issues.push(`${missingNoteRows.length} 条结果缺少 TB 备注待更新值`);
    if (weakDefectRows.length) issues.push(`${weakDefectRows.length} 条结果缺少明确的缺陷描述字段证据`);

    let score = 0;
    if (result && result.ok !== false) score += 20;
    if (results.length) score += 15;
    if (!failedRows.length) score += 10;
    if (requested.size && !missingProblemNos.length) score += 20;
    if (activeRows.length && !missingDescriptionRows.length) score += 15;
    if (activeRows.length && !missingNoteRows.length) score += 10;
    if (requested.size && activeRows.length && !weakDefectRows.length) score += 30;
    if (sourceScopeSkipped.length) score -= 20;
    score -= failedRows.length * 10 + missingProblemNos.length * 20 + missingDescriptionRows.length * 15 + missingNoteRows.length * 10 + weakDefectRows.length * 20;

    const met = issues.length === 0 && (results.length > 0 || !requested.size);
    return {
      met,
      score,
      total: results.length,
      requested: requested.size || Number(result?.requested || 0),
      foundProblemNos,
      missingProblemNos,
      issues,
    };
  }

  function rowProblemNos(row = {}) {
    const item = row?.item || {};
    const values = [
      row.sourceProblemNo,
      row.problemNo,
      row.sourceWorkItemNo,
      row.workItemNo,
      item.sourceProblemNo,
      item.problemNo,
      item.sourceWorkItemNo,
      item.title,
      item.sourceWorkItemUrl,
      row.payload?.content,
    ];
    return Array.from(new Set(values.flatMap((value) => {
      const matches = String(value || "").match(/[A-Z][A-Z0-9]+-\d+/gi) || [];
      const normalized = normalizeProblemNo(value);
      if (/[A-Z][A-Z0-9]+-\d+/.test(normalized)) matches.push(normalized);
      return matches.map(normalizeProblemNo).filter(Boolean);
    })));
  }

  function rowDescriptionText(row = {}) {
    return String(row?.item?.description || row?.payload?.description || "").trim();
  }

  function rowPayloadNoteText(row = {}) {
    return String(row?.payload?.note || row?.payload?.noteDisplay || "").trim();
  }

  function rowHasDefectDescriptionEvidence(row = {}) {
    const item = row?.item || {};
    if (fieldsHaveDefectDescription(item.fields)) return true;
    if (fieldsHaveDefectDescription(item.raw?.fields)) return true;
    return rawHasDefectDescription(item.raw || row.raw || {});
  }

  function fieldsHaveDefectDescription(fields = []) {
    if (!Array.isArray(fields)) return false;
    return fields.some((field) => {
      const key = normalizeFieldKey(field?.key || field?.field_key || field?.uuid);
      const name = normalizeFieldKey(field?.name || field?.field_name || field?.label);
      if (!DEFECT_DESCRIPTION_FIELD_KEYS.has(key) && !DEFECT_DESCRIPTION_FIELD_KEYS.has(name)) return false;
      return hasAnyText(field?.value) || hasAnyText(field?.displayValue) || hasAnyText(field?.uiValue);
    });
  }

  function rawHasDefectDescription(raw = {}) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return false;
    for (const [key, value] of Object.entries(raw)) {
      if (DEFECT_DESCRIPTION_FIELD_KEYS.has(normalizeFieldKey(key)) && hasAnyText(value)) return true;
    }
    return false;
  }

  function normalizeFieldKey(value = "") {
    return String(value || "").trim().replace(/\s+/g, "").toLowerCase();
  }

  function hasAnyText(value) {
    if (value === undefined || value === null) return false;
    if (typeof value === "string") return value.trim().length > 0;
    if (typeof value === "number" || typeof value === "boolean") return true;
    if (Array.isArray(value)) return value.some(hasAnyText);
    if (typeof value === "object") return Object.values(value).some(hasAnyText);
    return false;
  }

  async function duplicateCheckOptions(body = {}) {
    const limit = parseLimit(body.limit, 20, 200);
    const config = configFromBody(body);
    if (body.source === "web") {
      const capture = await captureConfiguredSources("web", body, { limit, config });
      if (!capture.ok && !capture.items.length) {
        const err = new Error(capture.error || "Feishu web capture failed");
        err.capture = capture;
        throw err;
      }
      const selectedItems = capture.items.slice(0, limit);
      return {
        options: runOptions({ ...body, workItems: selectedItems, limit, config }),
        captured: {
          total: capture.total,
          finalUrl: capture.finalUrl,
          source: capture.source,
          selected: selectedItems.length,
          capturedTotal: capture.capturedTotal,
          partial: !!capture.partial,
          error: capture.error || "",
          sourceResults: capture.sourceResults,
        },
        capturePartial: !!capture.partial,
      };
    }
    if (body.source === "mcp") {
      const capture = await captureConfiguredSources("mcp", body, { limit, config });
      if (!capture.ok && !capture.items.length) {
        const err = new Error(capture.error || "Feishu MCP capture failed");
        err.capture = capture;
        throw err;
      }
      const selectedItems = capture.items.slice(0, limit);
      return {
        options: runOptions({ ...body, workItems: selectedItems, limit, config }),
        captured: {
          total: capture.total,
          tool: capture.tool,
          effectiveTransport: capture.effectiveTransport,
          warning: capture.warning,
          selected: selectedItems.length,
          capturedTotal: capture.capturedTotal,
          partial: !!capture.partial,
          error: capture.error || "",
          sourceResults: capture.sourceResults,
        },
        capturePartial: !!capture.partial,
      };
    }
    return { options: runOptions({ ...body, limit, config }), captured: null };
  }

  async function refreshSourceRecordsFromBody(body = {}) {
    const limit = parseLimit(body.limit, 20, 200);
    const config = configFromBody(body);
    if (body.source === "web") {
      const capture = await captureConfiguredSources("web", body, { limit, config });
      if (!capture.ok && !capture.items.length) {
        const err = new Error(capture.error || "Feishu web capture failed");
        err.capture = capture;
        throw err;
      }
      const selectedItems = capture.items.slice(0, limit);
      const snapshotComplete = capture.ok && refreshCaptureIsComplete(body, capture, selectedItems, limit);
      const data = await refreshSourceRecords({
        ...body,
        source: "feishu-web",
        workItems: selectedItems,
        sourceResults: capture.sourceResults,
        limit,
        config,
        reconcileSnapshot: capture.ok && body.reconcileSnapshot === true,
        snapshotComplete,
      });
      return {
        ...data,
        ok: capture.ok && data?.ok !== false,
        partial: !!capture.partial,
        sourceResults: capture.sourceResults,
        firstError: data?.firstError || capture.error || "",
        captured: {
          total: capture.total,
          capturedTotal: capture.capturedTotal,
          finalUrl: capture.finalUrl,
          source: capture.source,
          selected: selectedItems.length,
          partial: !!capture.partial,
          error: capture.error || "",
          sourceResults: capture.sourceResults,
        },
      };
    }
    if (body.source === "mcp") {
      const capture = await captureConfiguredSources("mcp", body, { limit, config });
      if (!capture.ok && !capture.items.length) {
        const err = new Error(capture.error || "Feishu MCP capture failed");
        err.capture = capture;
        throw err;
      }
      const selectedItems = capture.items.slice(0, limit);
      const snapshotComplete = capture.ok && refreshCaptureIsComplete(body, capture, selectedItems, limit);
      const data = await refreshSourceRecords({
        ...body,
        source: "feishu-mcp",
        workItems: selectedItems,
        sourceResults: capture.sourceResults,
        limit,
        config,
        reconcileSnapshot: capture.ok && body.reconcileSnapshot === true,
        snapshotComplete,
      });
      return {
        ...data,
        ok: capture.ok && data?.ok !== false,
        partial: !!capture.partial,
        sourceResults: capture.sourceResults,
        firstError: data?.firstError || capture.error || "",
        captured: {
          total: capture.total,
          capturedTotal: capture.capturedTotal,
          tool: capture.tool,
          effectiveTransport: capture.effectiveTransport,
          warning: capture.warning,
          selected: selectedItems.length,
          partial: !!capture.partial,
          error: capture.error || "",
          sourceResults: capture.sourceResults,
        },
      };
    }
    return refreshSourceRecords({ ...body, limit, config, snapshotComplete: false });
  }

  function refreshCaptureIsComplete(body = {}, capture = {}, selectedItems = [], limit = 200) {
    if (body.reconcileSnapshot !== true) return false;
    if (capture.ok === false || capture.partial === true) return false;
    if (Array.isArray(capture.sourceResults) && capture.sourceResults.some((source) => source.complete !== true)) return false;
    const targeted = collectScalarValues(body.workItemIds, body.workItemId, body.scope?.workItemIds, body.scope?.workItemId).length
      || requestedProblemNoSet(body).size;
    if (targeted) return false;
    const total = Number(capture.capturedTotal ?? capture.total);
    return selectedItems.length < limit && (!Number.isFinite(total) || total <= selectedItems.length);
  }

  function requestedProblemNoSet(body = {}) {
    const values = collectScalarValues(
      body.workItemNos,
      body.workItemNo,
      body.problemNos,
      body.problemNo,
      body.sourceProblemNos,
      body.sourceProblemNo,
      body.scope?.workItemNos,
      body.scope?.workItemNo,
      body.scope?.problemNos,
      body.scope?.problemNo,
      body.scope?.sourceProblemNos,
      body.scope?.sourceProblemNo,
      body.workItemIds,
      body.workItemId,
    );
    const normalized = values.map(normalizeProblemNo).filter((value) => /[A-Z][A-Z0-9]+-\d+/.test(value));
    return new Set(normalized);
  }

  function syncRecordsByProblemNo(records = []) {
    const out = new Map();
    for (const row of records || []) {
      const keys = [
        row.sourceProblemNo,
        row.problemNo,
        row.sourceWorkItemNo,
        row.source_problem_no,
        row.problem_no,
        row.source_work_item_no,
      ].map(normalizeProblemNo).filter(Boolean);
      for (const key of keys) {
        if (!out.has(key)) out.set(key, row);
      }
    }
    return out;
  }

  function selectionByProblemNo(selections = []) {
    const out = new Map();
    for (const selection of selections || []) {
      const key = normalizeProblemNo(selection?.sourceWorkItemNo || selection?.sourceProblemNo || selection?.problemNo || selection?.key || "");
      if (key) out.set(key, selection);
    }
    return out;
  }

  async function loadSheetMappingRows(body = {}, sheetCfg = {}) {
    const requestRows = body.rows || body.sheetRows || body.existingRows;
    if (Array.isArray(requestRows)) {
      return { ok: true, rows: requestRows, source: "request-rows", warnings: [] };
    }
    const url = body.url || body.sheetUrl || sheetCfg.url || sheetCfg.sheetUrl || "";
    if (!url) return { ok: true, rows: [], source: "disabled", warnings: ["任务表格 URL 为空，已跳过表格映射预检查。"] };
    return readSheetRows({
      url,
      timeoutMs: Math.max(15000, Number(body.timeoutMs || 60000)),
      columns: sheetCfg.columns,
    });
  }

  function extractSheetMappings(rows = [], sheetCfg = {}) {
    const sourceColumns = sheetColumnCandidates(sheetCfg.keyColumn || sheetCfg.sourceColumn, SHEET_SOURCE_COLUMN_CANDIDATES);
    const targetColumns = sheetColumnCandidates(
      sheetCfg.targetColumn || sheetCfg.tbColumn || sheetCfg.dingtalkColumn || sheetCfg.dingdingColumn,
      SHEET_TB_COLUMN_CANDIDATES,
    );
    const mappings = [];
    for (const row of rows || []) {
      const sourceWorkItemNo = normalizeProblemNo(rowValueByNames(row, sourceColumns));
      const targetRaw = rowValueByNames(row, targetColumns);
      const sheetTargetDisplayId = normalizeTbDisplayId(targetRaw);
      if (!sourceWorkItemNo || !sheetTargetDisplayId) continue;
      mappings.push({
        sourceWorkItemNo,
        sheetTargetDisplayId,
        sheetTargetUniqueId: tbUniqueIdFromDisplay(sheetTargetDisplayId),
        row,
      });
    }
    return mappings;
  }

  async function resolveSheetTarget(mapping = {}) {
    const query = mapping.sheetTargetDisplayId || "";
    const task = query ? await resolveTbTask(query) : null;
    const objectId = taskObjectId(task) || (/^[a-f0-9]{24}$/i.test(query) ? query : "");
    const uniqueId = taskUniqueId(task) || mapping.sheetTargetUniqueId || "";
    if (!objectId) {
      return {
        ok: false,
        error: `未能通过 ${query || "空单号"} 找到 TB 任务对象 ID`,
        targetDisplayId: query,
        targetUniqueId: uniqueId,
      };
    }
    return {
      ok: true,
      targetTaskId: objectId,
      targetUniqueId: uniqueId,
      targetDisplayId: normalizeTbDisplayId(uniqueId || query),
      targetUpdatedAt: taskUpdatedAt(task),
      title: taskTitle(task),
      task: compactSheetMappingObject({
        id: objectId,
        uniqueId,
        title: taskTitle(task),
        projectId: task?.projectId || task?._projectId || task?.raw?.projectId || task?.raw?._projectId,
        tasklistId: task?.tasklistId || task?._tasklistId || task?.raw?.tasklistId || task?.raw?._tasklistId,
        executorId: task?.executorId || task?._executorId || task?.raw?.executorId || task?.raw?._executorId,
        updatedAt: taskUpdatedAt(task),
      }),
    };
  }

  function targetMatchesRecord(record = {}, resolved = {}) {
    const currentTaskId = String(record.targetTaskId || record.target_task_id || "").trim();
    const currentUniqueId = String(record.targetUniqueId || record.target_unique_id || "").trim();
    const currentDisplay = currentTargetDisplayId(record);
    const sheetTaskId = String(resolved.targetTaskId || "").trim();
    const sheetUniqueId = String(resolved.targetUniqueId || "").trim();
    const sheetDisplay = normalizeTbDisplayId(resolved.targetDisplayId || sheetUniqueId || "");
    if (currentTaskId && sheetTaskId && currentTaskId === sheetTaskId) return true;
    if (currentUniqueId && sheetUniqueId && String(currentUniqueId) === String(sheetUniqueId)) return true;
    if (currentDisplay && sheetDisplay && normalizeTbDisplayId(currentDisplay) === sheetDisplay) return true;
    return false;
  }

  function buildSheetMappingConflict(record = {}, mapping = {}, resolved = {}) {
    return {
      sourceWorkItemNo: mapping.sourceWorkItemNo,
      sourceWorkItemId: record.sourceWorkItemId || record.source_work_item_id || "",
      sourceWorkItemUrl: record.sourceWorkItemUrl || record.source_work_item_url || "",
      currentTargetTaskId: record.targetTaskId || record.target_task_id || "",
      currentTargetUniqueId: String(record.targetUniqueId || record.target_unique_id || "").trim(),
      currentTargetDisplayId: currentTargetDisplayId(record),
      sheetTargetTaskId: resolved.targetTaskId || "",
      sheetTargetUniqueId: resolved.targetUniqueId || mapping.sheetTargetUniqueId || "",
      sheetTargetDisplayId: mapping.sheetTargetDisplayId,
      sheetTargetTitle: resolved.title || "",
      record: compactSyncRecord(record),
      sheetTask: resolved.task || null,
    };
  }

  function repointRecordToSheetTarget(record = {}, mapping = {}, resolved = {}) {
    return repointSyncTarget(syncRecordKey(record), {
      targetTaskId: resolved.targetTaskId,
      targetUniqueId: resolved.targetUniqueId || mapping.sheetTargetUniqueId || "",
      targetUpdatedAt: resolved.targetUpdatedAt || new Date().toISOString(),
      syncStatus: "pending",
      lastError: "",
      originNode: "task-sheet-mapping",
    });
  }

  async function reconcileSheetMappings(body = {}, { apply = true } = {}) {
    const config = configFromBody(body);
    const cfg = getFeishuProjectSyncConfig(config || {});
    const sheetCfg = cfg.sheetSync || cfg.feishu?.sheetSync || {};
    const sheetUrl = body.url || body.sheetUrl || sheetCfg.url || sheetCfg.sheetUrl || "";
    if (sheetCfg.enabled === false) {
      return { ok: true, enabled: false, sheetUrl, checked: 0, appliedCount: 0, conflicts: [], hasConflicts: false, updates: [], noops: [], skipped: [], warnings: ["任务表格同步已关闭，跳过表格映射预检查。"] };
    }

    const read = await loadSheetMappingRows(body, sheetCfg);
    const warnings = [...(read.warnings || [])];
    const requested = requestedProblemNoSet(body);
    const allMappings = extractSheetMappings(read.rows || [], sheetCfg);
    const mappings = requested.size
      ? allMappings.filter((mapping) => requested.has(mapping.sourceWorkItemNo))
      : allMappings;
    const records = listFeishuProjectSyncRecords({
      projectKey: cfg.feishu?.spaceKey || body.projectKey || "",
      typeKey: cfg.feishu?.workItemTypeKey || body.typeKey || "",
      limit: parseLimit(body.stateLimit || body.recordLimit, 1000, 10000),
      config,
    });
    const recordsByProblem = syncRecordsByProblemNo(records);
    const selections = selectionByProblemNo(body.selections || body.resolutions || []);
    const updates = [];
    const conflicts = [];
    const skipped = [];
    const noops = [];
    const seen = new Set();

    for (const mapping of mappings) {
      if (seen.has(mapping.sourceWorkItemNo)) {
        skipped.push({ sourceWorkItemNo: mapping.sourceWorkItemNo, sheetTargetDisplayId: mapping.sheetTargetDisplayId, reason: "任务表格存在重复问题编号，已忽略后续重复行" });
        continue;
      }
      seen.add(mapping.sourceWorkItemNo);
      const record = recordsByProblem.get(mapping.sourceWorkItemNo);
      if (!record) {
        skipped.push({ sourceWorkItemNo: mapping.sourceWorkItemNo, sheetTargetDisplayId: mapping.sheetTargetDisplayId, reason: "本地映射表还没有这条飞书工单记录" });
        continue;
      }
      const resolved = await resolveSheetTarget(mapping);
      if (!resolved.ok) {
        skipped.push({ sourceWorkItemNo: mapping.sourceWorkItemNo, sheetTargetDisplayId: mapping.sheetTargetDisplayId, reason: resolved.error });
        warnings.push(`${mapping.sourceWorkItemNo} 的任务表格 TB 单号 ${mapping.sheetTargetDisplayId} 未能解析到 TB 对象 ID`);
        continue;
      }

      const hasCurrentTarget = !!String(record.targetTaskId || record.target_task_id || record.targetUniqueId || record.target_unique_id || "").trim();
      if (!hasCurrentTarget) {
        if (apply) {
          const result = repointRecordToSheetTarget(record, mapping, resolved);
          updates.push({
            sourceWorkItemNo: mapping.sourceWorkItemNo,
            action: "fill-empty",
            sheetTargetDisplayId: mapping.sheetTargetDisplayId,
            targetTaskId: resolved.targetTaskId,
            targetUniqueId: resolved.targetUniqueId || mapping.sheetTargetUniqueId || "",
            result,
          });
        } else {
          updates.push({
            sourceWorkItemNo: mapping.sourceWorkItemNo,
            action: "would-fill-empty",
            sheetTargetDisplayId: mapping.sheetTargetDisplayId,
            targetTaskId: resolved.targetTaskId,
            targetUniqueId: resolved.targetUniqueId || mapping.sheetTargetUniqueId || "",
          });
        }
        continue;
      }

      if (targetMatchesRecord(record, resolved)) {
        noops.push({
          sourceWorkItemNo: mapping.sourceWorkItemNo,
          reason: "任务表格与本地映射一致",
          targetTaskId: record.targetTaskId || record.target_task_id || resolved.targetTaskId,
          targetUniqueId: record.targetUniqueId || record.target_unique_id || resolved.targetUniqueId || "",
        });
        continue;
      }

      const selection = selections.get(mapping.sourceWorkItemNo);
      const choice = String(selection?.choice || selection?.source || selection?.side || "").trim().toLowerCase();
      if (apply && ["sheet", "task-sheet", "table", "remote"].includes(choice)) {
        const result = repointRecordToSheetTarget(record, mapping, resolved);
        updates.push({
          sourceWorkItemNo: mapping.sourceWorkItemNo,
          action: "resolved-to-sheet",
          sheetTargetDisplayId: mapping.sheetTargetDisplayId,
          targetTaskId: resolved.targetTaskId,
          targetUniqueId: resolved.targetUniqueId || mapping.sheetTargetUniqueId || "",
          result,
        });
        continue;
      }
      if (apply && ["current", "local", "web", "mapping"].includes(choice)) {
        noops.push({
          sourceWorkItemNo: mapping.sourceWorkItemNo,
          action: "resolved-to-current",
          reason: "用户选择保留网页映射表中的 TB 任务 ID",
          targetTaskId: record.targetTaskId || record.target_task_id || "",
          targetUniqueId: record.targetUniqueId || record.target_unique_id || "",
        });
        continue;
      }
      conflicts.push(buildSheetMappingConflict(record, mapping, resolved));
    }

    return {
      ok: true,
      enabled: true,
      sheetUrl: sheetUrl || read.url || sheetCfg.url || "",
      readSource: read.source || "",
      rowCount: Array.isArray(read.rows) ? read.rows.length : 0,
      checked: mappings.length,
      matchedLocalCount: updates.length + conflicts.length + noops.length,
      appliedCount: updates.length,
      conflictCount: conflicts.length,
      hasConflicts: conflicts.length > 0,
      updates,
      conflicts,
      noops,
      skipped,
      warnings,
    };
  }

  router.get("/status", (req, res) => {
    const readiness = getFeishuProjectSyncReadiness();
    const records = listFeishuProjectSyncRecords({ limit: parseLimit(req.query.limit, 20, 100) });
    res.json({ success: true, data: { readiness, recent: records } });
  });

  router.get("/tb-projects", async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      const projects = await listTbProjects();
      const cfg = getFeishuProjectSyncConfig();
      res.json({
        success: true,
        data: {
          projects: (projects || []).map((project) => ({
            id: String(project.id || project._id || ""),
            name: String(project.name || project.id || project._id || ""),
          })).filter((project) => project.id),
          currentProjectId: cfg.teambition?.projectId || "",
        },
      });
    } catch (err) {
      res.status(err?.needLogin ? 401 : 500).json({
        success: false,
        error: err?.message || String(err),
        needLogin: !!err?.needLogin,
      });
    }
  });

  router.get("/tb-sprints", async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      const cfg = getFeishuProjectSyncConfig();
      const projectId = String(req.query.projectId || cfg.teambition?.projectId || "").trim();
      if (!projectId) return res.status(400).json({ success: false, error: "projectId is required" });
      const sprints = await listTbSprints(projectId);
      res.json({
        success: true,
        data: {
          projectId,
          currentSprintId: cfg.teambition?.sprintId || "",
          sprints: (sprints || []).map((sprint) => ({
            id: String(sprint.id || sprint.sprintId || sprint._id || ""),
            sprintId: String(sprint.sprintId || sprint.id || sprint._id || ""),
            name: String(sprint.name || sprint.title || sprint.id || ""),
            title: String(sprint.title || sprint.name || ""),
            projectId: String(sprint.projectId || projectId || ""),
            status: String(sprint.status || ""),
            dueDate: String(sprint.dueDate || ""),
            startDate: String(sprint.startDate || ""),
            url: String(sprint.url || ""),
          })).filter((sprint) => sprint.id),
        },
      });
    } catch (err) {
      res.status(err?.needLogin ? 401 : 500).json({
        success: false,
        error: err?.message || String(err),
        needLogin: !!err?.needLogin,
      });
    }
  });

  router.get("/tb-tasklists", async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      const cfg = getFeishuProjectSyncConfig();
      const projectId = String(req.query.projectId || cfg.teambition?.projectId || "").trim();
      if (!projectId) return res.status(400).json({ success: false, error: "projectId is required" });
      const projectName = String(req.query.projectName || "").trim();
      const tasklists = await listTbTasklists(projectId);
      res.json({
        success: true,
        data: {
          projectId,
          currentTasklistId: cfg.teambition?.tasklistId || "",
          tasklists: (tasklists || []).map((tasklist) => {
            const id = String(tasklist.id || tasklist.tasklistId || tasklist._id || "").trim();
            const name = String(tasklist.name || tasklist.title || id || "").trim();
            const pathName = String(tasklist.pathName || tasklist.projectPathName || [projectName, name].filter(Boolean).join(" / ")).trim();
            return {
              id,
              tasklistId: String(tasklist.tasklistId || id),
              name,
              title: String(tasklist.title || name),
              projectId: String(tasklist.projectId || projectId || ""),
              projectName,
              pathName,
              url: String(tasklist.url || ""),
            };
          }).filter((tasklist) => tasklist.id),
        },
      });
    } catch (err) {
      res.status(err?.needLogin ? 401 : 500).json({
        success: false,
        error: err?.message || String(err),
        needLogin: !!err?.needLogin,
      });
    }
  });

  router.get("/tb-target-options", async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      const cfg = getFeishuProjectSyncConfig();
      const projects = await listTbProjects();
      const options = [];
      const errors = [];
      for (const project of projects || []) {
        const projectId = String(project.id || project._id || "").trim();
        if (!projectId) continue;
        const projectName = String(project.name || projectId).trim();
        try {
          const tasklists = await listTbTasklists(projectId);
          for (const tasklist of tasklists || []) {
            const id = String(tasklist.id || tasklist.tasklistId || tasklist._id || "").trim();
            if (!id) continue;
            const name = String(tasklist.name || tasklist.title || id).trim();
            const pathName = String(tasklist.pathName || tasklist.projectPathName || [projectName, name].filter(Boolean).join(" / ")).trim();
            options.push({
              id,
              tasklistId: String(tasklist.tasklistId || id),
              name,
              title: String(tasklist.title || name),
              projectId,
              projectName,
              pathName,
              url: String(tasklist.url || ""),
            });
          }
        } catch (err) {
          errors.push({ projectId, projectName, error: err?.message || String(err) });
        }
      }
      const current = currentTbTargetOption(cfg);
      if (current.id && !options.some((option) => option.id === current.id)) options.push(current);
      res.json({
        success: true,
        data: {
          options,
          errors,
          currentProjectId: cfg.teambition?.projectId || "",
          currentTasklistId: cfg.teambition?.tasklistId || "",
        },
      });
    } catch (err) {
      res.status(err?.needLogin ? 401 : 500).json({
        success: false,
        error: err?.message || String(err),
        needLogin: !!err?.needLogin,
      });
    }
  });

  router.get("/tb-members", async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      const members = await listTbMembers({
        q: req.query.q || "",
        force: req.query.refresh === "1",
      });
      res.json({
        success: true,
        data: {
          members: (members || []).map((member) => ({
            id: String(member.uid || member.id || member._id || ""),
            name: String(member.name || member.nick || member.uid || member.id || member._id || ""),
            avatarUrl: String(member.avatarUrl || member.avatar || ""),
          })).filter((member) => member.id),
        },
      });
    } catch (err) {
      res.status(err?.needLogin ? 401 : 500).json({
        success: false,
        error: err?.message || String(err),
        needLogin: !!err?.needLogin,
      });
    }
  });

  router.get("/config", (req, res) => {
    const config = getFeishuProjectSyncConfig();
    res.json({
      success: true,
      data: {
        config: maskDeep(config),
        defaults: maskDeep(DEFAULT_FEISHU_PROJECT_SYNC_CONFIG),
        filterPreset: maskDeep(readFilterPreset()),
        readiness: getFeishuProjectSyncReadiness(),
      },
    });
  });

  router.get("/web-status", async (req, res) => {
    try {
      const cfg = getFeishuProjectSyncConfig();
      const passive = req.query.passive === undefined ? true : parseBool(req.query.passive) !== false;
      const data = await getWebStatus({
        url: req.query.url || cfg.feishu?.web?.homepageUrl,
        timeoutMs: parseLimit(req.query.timeoutMs, 8000, 60000),
        passive,
        allowActivePageRead: parseBool(req.query.activeOnly ?? req.query.allowActivePageRead) === true,
      });
      res.json({ success: true, data });
    } catch (err) {
      res.status(500).json({ success: false, error: err?.message || String(err) });
    }
  });

  router.get("/mcp-status", async (req, res) => {
    let syncConfig = {};
    try {
      const storedConfig = getConfig();
      syncConfig = getFeishuProjectSyncConfig(storedConfig?.feishuProjectSync || {});
      const data = await getMcpStatus(syncConfig, {
        forceRefresh: parseBool(req.query.refresh),
      });
      res.json({ success: true, data: sanitizeFeishuProjectMcpStatus(data, syncConfig) });
    } catch (err) {
      const safeError = sanitizeFeishuProjectMcpStatus({ error: err?.message || String(err) }, syncConfig);
      res.status(500).json({ success: false, error: safeError.error });
    }
  });

  router.get("/mcp-filter-metadata", async (req, res) => {
    if (!requireAdmin(req, res)) return;
    const cfg = getFeishuProjectSyncConfig(getConfig()?.feishuProjectSync || {});
    try {
      const data = await getMcpFilterMetadata(cfg, {
        projectKey: req.query.projectKey || "",
        workItemType: req.query.workItemType || "",
      });
      res.json({ success: true, data: sanitizeFeishuProjectMcpPayload(data, cfg) });
    } catch (err) {
      const safeError = sanitizeFeishuProjectMcpPayload({ error: err?.message || String(err) }, cfg);
      res.status(500).json({ success: false, error: safeError.error });
    }
  });

  router.post("/mcp-open-authorization", async (req, res) => {
    if (!requireAdmin(req, res)) return;
    let cfg = getFeishuProjectSyncConfig(getConfig()?.feishuProjectSync || {});
    try {
      const rawStatus = await getMcpStatus(cfg).catch((err) => ({
        connected: false,
        needsAuthorization: true,
        authorizationUrl: "",
        error: err?.message || String(err),
      }));
      const status = sanitizeFeishuProjectMcpStatus(rawStatus, cfg);
      const configuredAuthorization = sanitizeFeishuProjectMcpStatus({
        authorizationUrl: cfg.feishu?.mcp?.authorizationUrl || "",
      }, cfg).authorizationUrl || "";
      const discoveredAuthorization = status.authorizationUrl?.includes("[REDACTED]")
        ? ""
        : status.authorizationUrl;
      const safeConfiguredAuthorization = configuredAuthorization.includes("[REDACTED]")
        ? ""
        : configuredAuthorization;
      const requestedAuthorization = sanitizeFeishuProjectMcpPayload({
        authorizationUrl: req.body?.url || "",
      }, cfg).authorizationUrl || "";
      const safeRequestedAuthorization = requestedAuthorization.includes("[REDACTED]")
        ? ""
        : requestedAuthorization;
      const targetUrl = String(
        safeRequestedAuthorization
        || discoveredAuthorization
        || safeConfiguredAuthorization
        || "https://project.feishu.cn/b/mcp",
      ).trim();
      const opened = await openSystemUrl(targetUrl);
      res.json({
        success: true,
        data: {
          ...opened,
          mode: opened.mode || (opened.viewerUrl ? "remote" : "local"),
          viewerUrl: opened.viewerUrl || undefined,
          mcpStatus: status,
        },
      });
    } catch (err) {
      const safeError = sanitizeFeishuProjectMcpStatus({ error: err?.message || String(err) }, cfg);
      res.status(500).json({ success: false, error: safeError.error });
    }
  });

  router.post("/mcp-capture", async (req, res) => {
    if (!requireAdmin(req, res)) return;
    let responseConfig = getFeishuProjectSyncConfig(getConfig()?.feishuProjectSync || {});
    try {
      const body = req.body || {};
      const storedConfig = getConfig()?.feishuProjectSync || {};
      const requestConfig = configFromBody(body);
      const config = mergeMasked(storedConfig, requestConfig || {});
      responseConfig = getFeishuProjectSyncConfig(config);
      const data = await captureConfiguredSources("mcp", body, {
        config,
        limit: parseLimit(body.limit, 20, 200),
      });
      res.json({ success: true, data: sanitizeFeishuProjectMcpPayload(data, responseConfig) });
    } catch (err) {
      const safeError = sanitizeFeishuProjectMcpPayload({
        error: err?.message || String(err),
        data: err?.sourceViewsValidation,
      }, responseConfig);
      res.status(err?.statusCode || 500).json({
        success: false,
        error: safeError.error,
        ...(safeError.data ? { data: safeError.data } : {}),
      });
    }
  });

  router.post("/mcp-token-from-web", async (req, res) => {
    if (!requireAdmin(req, res)) return;
    let responseConfig = getFeishuProjectSyncConfig(getConfig()?.feishuProjectSync || {});
    try {
      const tokenResult = await getMcpTokenFromWeb({
        timeoutMs: Math.max(30000, Number(req.body?.timeoutMs || 45000)),
        forceRemote: req.body?.forceRemote === true,
      });
      if (tokenResult?.mode === "remote" && tokenResult?.pending) {
        return res.json({
          success: true,
          data: {
            mode: "remote",
            pending: true,
            viewerUrl: tokenResult.viewerUrl || "/feishu-browser",
            message: tokenResult.message || "远程浏览器已启动，请在弹出的页面中扫码",
            purpose: tokenResult.purpose || "mcp-token",
          },
        });
      }
      if (!tokenResult.ok) {
        const safeResult = sanitizeFeishuProjectMcpPayload(tokenResult, responseConfig);
        return res.status(400).json({
          success: false,
          error: safeResult.error || "Feishu MCP token not returned",
          data: {
            ...safeResult,
            mode: tokenResult.mode,
            viewerUrl: tokenResult.viewerUrl,
          },
        });
      }
      const current = getConfig();
      const currentSync = current.feishuProjectSync || {};
      const currentFeishu = currentSync.feishu || {};
      const currentMcp = currentFeishu.mcp || {};
      const nextSync = {
        ...currentSync,
        enabled: true,
        feishu: {
          ...currentFeishu,
          authMode: "mcp",
          mcp: {
            ...currentMcp,
            enabled: true,
            transport: currentMcp.transport || "http-oauth",
            serverUrl: currentMcp.serverUrl || "https://project.feishu.cn/mcp_server/v1",
            headerName: currentMcp.headerName || "X-Mcp-Token",
            token: tokenResult.token,
          },
        },
      };
      responseConfig = getFeishuProjectSyncConfig(nextSync);
      updateConfig({ feishuProjectSync: nextSync });
      const rawStatus = await getMcpStatus(responseConfig).catch((err) => ({
        connected: false,
        error: err?.message || String(err),
      }));
      const status = sanitizeFeishuProjectMcpStatus(rawStatus, responseConfig);
      res.json({
        success: true,
        data: {
          saved: true,
          mode: tokenResult.mode || "local",
          authMode: "mcp",
          tokenLength: tokenResult.tokenLength,
          mcpStatus: status,
        },
      });
    } catch (err) {
      const safeError = sanitizeFeishuProjectMcpStatus({ error: err?.message || String(err) }, responseConfig);
      res.status(500).json({ success: false, error: safeError.error });
    }
  });

  router.get("/remote-browser/status", (req, res) => {
    try {
      res.json({ success: true, data: getFeishuRemoteStatus() });
    } catch (err) {
      res.status(500).json({ success: false, error: err?.message || String(err) });
    }
  });

  router.post("/remote-browser/cancel", async (req, res) => {
    try {
      const cancelled = await cancelFeishuRemoteSession();
      res.json({ success: true, data: { cancelled } });
    } catch (err) {
      res.status(500).json({ success: false, error: err?.message || String(err) });
    }
  });

  router.post("/web-login", async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      const current = getConfig();
      const currentSync = current.feishuProjectSync || {};
      const currentFeishu = currentSync.feishu || {};
      const homepageUrl = webUrlFrom(req.body || {});
      const nextSync = {
        ...currentSync,
        feishu: {
          ...currentFeishu,
          authMode: "web",
          web: {
            ...(currentFeishu.web || {}),
            homepageUrl,
          },
        },
      };
      updateConfig({ feishuProjectSync: nextSync });
      const data = await openWebLogin({ url: homepageUrl });
      res.json({ success: true, data: { ...data, authMode: "web" } });
    } catch (err) {
      res.status(500).json({ success: false, error: err?.message || String(err) });
    }
  });

  router.post("/web-capture", async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      const body = req.body || {};
      const config = configFromBody(body);
      const limit = parseLimit(body.limit, 20, 200);
      const capture = await captureConfiguredSources("web", body, { limit, config });
      res.json({ success: true, data: capture });
    } catch (err) {
      res.status(err?.statusCode || 500).json({
        success: false,
        error: err?.message || String(err),
        ...(err?.sourceViewsValidation ? { data: err.sourceViewsValidation } : {}),
      });
    }
  });

  router.put("/config", (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      const current = getConfig();
      const currentSync = current.feishuProjectSync || {};
      const incoming = pickConfigPatch(req.body || {});
      assertValidSourceViews({ config: incoming });
      const incomingFeishu = incoming?.feishu && typeof incoming.feishu === "object" && !Array.isArray(incoming.feishu)
        ? incoming.feishu
        : null;
      let canonicalIncoming = incoming;
      if (
        incomingFeishu
        && Object.prototype.hasOwnProperty.call(incomingFeishu, "sourceView")
        && !Object.prototype.hasOwnProperty.call(incomingFeishu, "sourceViews")
      ) {
        const normalizedLegacy = normalizeSourceViewInput(incomingFeishu.sourceView);
        canonicalIncoming = {
          ...incoming,
          feishu: {
            ...incomingFeishu,
            sourceViews: normalizedLegacy ? [{ ...normalizedLegacy, enabled: normalizedLegacy.enabled !== false, isDefault: true }] : [],
          },
        };
      }
      const nextSync = mergeMasked(currentSync, canonicalIncoming || {});
      assertValidSourceViews({}, nextSync);
      assertValidSyncPolicyConfig(nextSync);
      const nextConfig = updateConfig({ feishuProjectSync: nextSync });
      res.json({
        success: true,
        data: {
          config: maskDeep(getFeishuProjectSyncConfig(nextConfig.feishuProjectSync || {})),
          readiness: getFeishuProjectSyncReadiness(nextConfig.feishuProjectSync || {}),
        },
      });
    } catch (err) {
      res.status(err?.statusCode || 500).json({
        success: false,
        error: err?.message || String(err),
        ...(err?.sourceViewsValidation ? { data: err.sourceViewsValidation } : {}),
        ...(err?.policyValidation ? { policyValidation: err.policyValidation } : {}),
      });
    }
  });

  router.put("/filter-preset", (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      const preset = saveFilterPreset(req.body || {});
      res.json({ success: true, data: { preset: maskDeep(preset) } });
    } catch (err) {
      res.status(400).json({ success: false, error: err?.message || String(err) });
    }
  });

  router.get("/records", async (req, res) => {
    const { status, projectKey, typeKey, limit } = req.query;
    try {
      const query = {
        status,
        projectKey,
        typeKey,
        limit: parseLimit(limit, 100),
        enrich: req.query.enrich === undefined ? true : parseBool(req.query.enrich),
      };
      let targetVerification = null;
      if (parseBool(req.query.verifyTargets)) {
        targetVerification = await verifySyncTargets({
          ...query,
          resetMissingTargets: req.query.resetMissingTargets === undefined ? true : parseBool(req.query.resetMissingTargets),
        });
      }
      res.json({
        success: true,
        data: listSyncRecords(query),
        meta: targetVerification ? { targetVerification } : undefined,
      });
    } catch (err) {
      res.status(500).json({ success: false, error: err?.message || String(err) });
    }
  });

  router.post("/records/clear", (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      const body = req.body || {};
      if (body.confirm !== true) {
        return res.status(400).json({ success: false, error: "clear confirmation is required" });
      }
      res.json({ success: true, data: clearSyncRecords() });
    } catch (err) {
      res.status(500).json({ success: false, error: err?.message || String(err) });
    }
  });

  router.post("/records/sync-preview", async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      const body = req.body || {};
      const requestedRecords = (Array.isArray(body.records) ? body.records : [])
        .map(syncRecordRef)
        .filter((record) => syncRecordIdentityKey(record));
      const requestedKeys = new Set(requestedRecords.map(syncRecordIdentityKey));
      if (!requestedKeys.size) {
        return res.status(400).json({ success: false, error: "records are required" });
      }

      const capturedBySource = new Map();
      const preparedSyncNow = new Date(planNow()).toISOString();
      const onPreparedItems = (context = {}) => {
        const source = normalizeSourceKey(context.source) || String(context.source || "plugin");
        capturedBySource.set(source, context);
      };
      const recordPreviewConfig = getFeishuProjectSyncConfig(configFromBody(body) || {});
      const previewSource = normalizeSourceKey(body.source) || normalizeSourceKey(recordPreviewConfig.feishu?.authMode) || "plugin";
      const result = await runAdaptiveSync({
        ...body,
        source: previewSource,
        sourceFallback: false,
        async: false,
        preparedRecordSync: true,
        preparedSyncNow,
        onPreparedItems,
      }, { dryRun: true });
      const selectedSource = normalizeSourceKey(result?.sourceFallback?.selectedSource || result?.source) || previewSource;
      const preparedContext = capturedBySource.get(selectedSource) || Array.from(capturedBySource.values()).at(-1);
      const workItems = Array.isArray(preparedContext?.workItems) ? preparedContext.workItems : [];
      const previewRows = Array.isArray(preparedContext?.results) ? preparedContext.results : [];
      const itemConfigs = Array.isArray(preparedContext?.itemConfigs) ? preparedContext.itemConfigs : [];
      const entries = new Map();
      for (let index = 0; index < Math.min(workItems.length, previewRows.length); index += 1) {
        const previewResult = previewRows[index];
        const recordRef = syncRecordRefWithFallback(previewResult, workItems[index]);
        const recordKey = syncRecordIdentityKey(recordRef);
        if (!recordKey || !requestedKeys.has(recordKey)) continue;
        const prepared = normalizePreparedRecordPreviewResult(previewResult, recordRef);
        const preparedResult = prepared.result;
        entries.set(recordKey, {
          recordKey,
          recordRef,
          raw: workItems[index],
          config: itemConfigs[index] || preparedContext?.config || configFromBody(body) || {},
          previewResult: preparedResult,
          preparedFingerprint: String(preparedResult?.preparedFingerprint || ""),
          status: prepared.status,
          result: null,
        });
      }
      const missingKeys = Array.from(requestedKeys).filter((key) => !entries.has(key));
      const missingReason = result?.firstError || result?.sourceFallback?.reason || "";
      for (const recordKey of missingKeys) {
        const recordRef = requestedRecords.find((record) => syncRecordIdentityKey(record) === recordKey);
        const previewResult = {
          ok: false,
          dryRun: true,
          action: "",
          item: recordRef,
          error: `飞书读取未返回所选工单，无法执行 dry-run${missingReason ? `：${missingReason}` : ""}`,
          errorStage: "capture",
        };
        entries.set(recordKey, {
          recordKey,
          recordRef,
          raw: null,
          previewResult,
          preparedFingerprint: "",
          status: "failed",
          result: null,
        });
      }
      if (!entries.size) {
        return res.status(422).json({
          success: false,
          error: result?.firstError || "预演没有返回所选映射记录，请检查飞书读取来源后重试",
          data: { result },
        });
      }

      cleanupPreparedSyncPlans();
      const createdAt = planNow();
      const ttlMs = Math.max(1, Number(preparedPlanTtlMs) || PREPARED_SYNC_PLAN_TTL_MS);
      const planId = `feishu-record-plan-${createdAt}-${randomUUID().slice(0, 8)}`;
      const plan = {
        id: planId,
        ownerKey: requestOwnerKey(req),
        createdAt,
        expiresAt: createdAt + ttlMs,
        source: selectedSource,
        config: preparedContext?.config || configFromBody(body) || {},
        loaderScope: preparedContext?.loaderScope || {},
        sheetTargetByProblemNo: preparedContext?.sheetTargetByProblemNo || {},
        preparedSyncNow,
        entries,
      };
      preparedSyncPlans.set(planId, plan);
      res.json({
        success: true,
        data: {
          planId,
          source: selectedSource,
          createdAt: new Date(plan.createdAt).toISOString(),
          expiresAt: new Date(plan.expiresAt).toISOString(),
          total: entries.size,
          ready: Array.from(entries.values()).filter((entry) => entry.status === "ready").length,
          failed: Array.from(entries.values()).filter((entry) => entry.status !== "ready").length,
          missingKeys,
          captureRecovery: result?.captured?.explicitRecordRecovery || null,
          items: Array.from(entries.values()).map((entry) => ({
            recordKey: entry.recordKey,
            result: publicPreparedResult(entry.previewResult),
            status: entry.status,
          })),
        },
      });
    } catch (err) {
      res.status(500).json({ success: false, error: err?.message || String(err) });
    }
  });

  router.post("/records/sync-apply", async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      cleanupPreparedSyncPlans();
      const body = req.body || {};
      const planId = String(body.planId || "").trim();
      const plan = preparedSyncPlans.get(planId);
      if (!plan) {
        return res.status(410).json({ success: false, error: "预演计划不存在或已过期，请重新预演" });
      }
      if (!plan.ownerKey || plan.ownerKey !== requestOwnerKey(req)) {
        return res.status(403).json({ success: false, error: "预演计划不属于当前管理员会话" });
      }
      const recordKeys = Array.from(new Set((Array.isArray(body.recordKeys) ? body.recordKeys : [])
        .map((value) => String(value || "").trim())
        .filter(Boolean)));
      if (!recordKeys.length) {
        return res.status(400).json({ success: false, error: "recordKeys are required" });
      }
      const entries = recordKeys.map((key) => plan.entries.get(key));
      if (entries.some((entry) => !entry)) {
        return res.status(400).json({ success: false, error: "预演计划不包含部分所选记录" });
      }
      if (entries.some((entry) => entry.status !== "ready")) {
        return res.status(409).json({ success: false, error: "部分预演记录已经确认或已失效，请重新预演" });
      }
      if (recordKeys.some((key) => applyingPreparedRecordKeys.has(key))) {
        return res.status(409).json({ success: false, error: "部分映射记录正在由其他预演计划生效，请稍后重新预演" });
      }

      for (const key of recordKeys) applyingPreparedRecordKeys.add(key);
      for (const entry of entries) entry.status = "applying";

      const items = [];
      try {
        for (const entry of entries) {
          let result;
          try {
            result = await syncWorkItem(entry.raw, {
              dryRun: false,
              config: entry.config || plan.config,
              loaderScope: plan.loaderScope,
              sheetTargetByProblemNo: plan.sheetTargetByProblemNo,
              expectedPreparedFingerprint: entry.preparedFingerprint || undefined,
              preparedPlanId: plan.id,
              now: plan.preparedSyncNow,
            });
          } catch (err) {
            result = { ok: false, action: entry.previewResult?.action || "", error: err?.message || String(err) };
          }
          entry.status = result?.ok === false ? (result?.stale ? "stale" : "failed") : "applied";
          entry.result = result;
          entry.appliedAt = planNow();
          items.push({ recordKey: entry.recordKey, status: entry.status, result: publicPreparedResult(result) });
        }
      } finally {
        for (const key of recordKeys) applyingPreparedRecordKeys.delete(key);
      }
      const results = items.map((item) => item.result);
      res.json({
        success: true,
        data: {
          ok: results.every((result) => result?.ok !== false),
          planId,
          total: items.length,
          applied: items.filter((item) => item.status === "applied").length,
          failed: items.filter((item) => item.status !== "applied").length,
          items,
          results,
        },
      });
    } catch (err) {
      res.status(500).json({ success: false, error: err?.message || String(err) });
    }
  });

  router.post("/records/delete", (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      const body = req.body || {};
      if (body.confirm !== true) {
        return res.status(400).json({ success: false, error: "delete confirmation is required" });
      }
      const byKey = new Map();
      for (const value of Array.isArray(body.records) ? body.records : []) {
        const record = syncRecordRef(value);
        const recordKey = syncRecordIdentityKey(record);
        if (recordKey) byKey.set(recordKey, record);
      }
      if (!byKey.size) {
        return res.status(400).json({ success: false, error: "records are required" });
      }
      res.json({ success: true, data: deleteSyncRecords(Array.from(byKey.values())) });
    } catch (err) {
      res.status(500).json({ success: false, error: err?.message || String(err) });
    }
  });

  router.post("/records/refresh", async (req, res) => {
    if (!requireAdmin(req, res)) return;
    const refreshLogId = randomUUID();
    writeRecordsRefreshLog(refreshLogId, "info", "started", req.body || {});
    try {
      const data = await refreshSourceRecordsFromBody(req.body || {});
      writeRecordsRefreshLog(
        refreshLogId,
        data?.partial === true || data?.ok === false ? "warn" : "info",
        data?.partial === true || data?.ok === false ? "partial" : "succeeded",
        req.body || {},
        data,
      );
      res.json({ success: true, data: { ...data, refreshLogId } });
    } catch (err) {
      const rawError = err?.message || String(err);
      const error = safeRecordsRefreshError(req.body || {}, rawError);
      writeRecordsRefreshLog(refreshLogId, "error", "failed", req.body || {}, err?.capture || {}, rawError);
      res.status(500).json({
        success: false,
        error,
        refreshLogId,
        data: { ...(err?.capture || {}), refreshLogId },
      });
    }
  });

  router.get("/errors", (req, res) => {
    const { projectKey, typeKey, workItemId, status, stage, retryable, limit } = req.query;
    res.json({
      success: true,
      data: listFeishuProjectSyncErrors({
        projectKey,
        typeKey,
        workItemId,
        status,
        stage,
        retryable: parseBool(retryable),
        limit: parseLimit(limit, 100),
      }),
    });
  });

  router.get("/retryable-errors", (req, res) => {
    const { projectKey, typeKey, workItemId, stage, limit } = req.query;
    res.json({
      success: true,
      data: listFeishuProjectRetryableErrors({
        projectKey,
        typeKey,
        workItemId,
        stage,
        limit: parseLimit(limit, 100),
      }),
    });
  });

  router.get("/raw-payloads", (req, res) => {
    const { projectKey, typeKey, workItemId, payloadHash, limit } = req.query;
    res.json({
      success: true,
      data: listFeishuProjectRawPayloads({
        projectKey,
        typeKey,
        workItemId,
        payloadHash,
        limit: parseLimit(limit, 100),
        includePayload: req.query.includePayload === undefined ? true : parseBool(req.query.includePayload),
      }),
    });
  });

  router.get("/comments", (req, res) => {
    const { projectKey, typeKey, workItemId, status, targetTaskId, limit } = req.query;
    res.json({
      success: true,
      data: listFeishuProjectCommentSync({
        projectKey,
        typeKey,
        workItemId,
        status,
        targetTaskId,
        limit: parseLimit(limit, 100),
      }),
    });
  });

  router.get("/attachments", (req, res) => {
    const { projectKey, typeKey, workItemId, status, targetTaskId, limit } = req.query;
    res.json({
      success: true,
      data: listFeishuProjectAttachmentSync({
        projectKey,
        typeKey,
        workItemId,
        status,
        targetTaskId,
        limit: parseLimit(limit, 100),
      }),
    });
  });

  router.get("/reconcile", async (req, res) => {
    try {
      const data = await reconcileSync({
        projectKey: req.query.projectKey,
        typeKey: req.query.typeKey,
        workItemId: req.query.workItemId,
        includeFuture: parseBool(req.query.includeFuture),
        verifyTargets: parseBool(req.query.verifyTargets),
        resetMissingTargets: req.query.resetMissingTargets === undefined ? true : parseBool(req.query.resetMissingTargets),
        limit: parseLimit(req.query.limit, 200),
      });
      res.json({ success: true, data });
    } catch (err) {
      res.status(500).json({ success: false, error: err?.message || String(err) });
    }
  });

  router.get("/runs/:runId", (req, res) => {
    if (!requireAdmin(req, res)) return;
    const run = runs.get(String(req.params.runId || ""));
    if (!run) return res.status(404).json({ success: false, error: "sync run not found" });
    res.json({
      success: true,
      data: publicRun(run, {
        includeResult: parseBool(req.query.includeResult) === true,
        includePreview: parseBool(req.query.includePreview) === true,
      }),
    });
  });

  router.get("/runs/:runId/result-preview", (req, res) => {
    if (!requireAdmin(req, res)) return;
    const run = runs.get(String(req.params.runId || ""));
    if (!run) return res.status(404).json({ success: false, error: "sync run not found" });
    if (!run.result) return res.status(409).json({ success: false, error: "sync run result is not ready" });
    res.json({ success: true, data: { runId: run.id, ...runResultPreview(run) } });
  });

  router.get("/runs/:runId/result", (req, res) => {
    if (!requireAdmin(req, res)) return;
    const run = runs.get(String(req.params.runId || ""));
    if (!run) return res.status(404).json({ success: false, error: "sync run not found" });
    if (!run.result) return res.status(409).json({ success: false, error: "sync run result is not ready" });
    res.json({ success: true, data: run.result });
  });

  router.get("/runs/:runId/events", (req, res) => {
    if (!requireAdmin(req, res)) return;
    const run = runs.get(String(req.params.runId || ""));
    if (!run) return res.status(404).json({ success: false, error: "sync run not found" });
    res.status(200);
    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders?.();

    const subscriber = {
      send: (event, data) => writeSse(res, event, data),
      close: () => {
        try { res.end(); } catch {}
      },
    };
    run.subscribers?.add?.(subscriber);
    writeSse(res, "run", publicRun(run));
    const keepAlive = setInterval(() => {
      try { res.write(": keep-alive\n\n"); } catch {}
    }, 15000);
    req.on("close", () => {
      clearInterval(keepAlive);
      run.subscribers?.delete?.(subscriber);
    });
  });

  router.get("/records-since", requirePeerReplicationAuth, (req, res) => {
    res.json({
      success: true,
      data: listFeishuProjectSyncStatesSince(Number(req.query.since) || 0, {
        limit: parseLimit(req.query.limit, 1000, 5000),
      }),
    });
  });

  router.get("/runs", (req, res) => {
    if (!requireAdmin(req, res)) return;
    const limit = parseLimit(req.query.limit, 20, 100);
    const data = Array.from(runs.values())
      .sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)))
      .slice(0, limit)
      .map(publicRun);
    res.json({ success: true, data });
  });

  router.post("/duplicates/check", async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      const prepared = await duplicateCheckOptions(req.body || {});
      const data = await detectDuplicates(prepared.options);
      res.json({
        success: true,
        data: {
          ...data,
          ok: prepared.capturePartial ? false : data?.ok,
          partial: !!prepared.capturePartial,
          sourceResults: prepared.captured?.sourceResults || [],
          firstError: data?.firstError || prepared.captured?.error || "",
          captured: prepared.captured,
        },
      });
    } catch (err) {
      res.status(500).json({ success: false, error: err?.message || String(err), data: err?.capture || undefined });
    }
  });

  router.post("/duplicates/merge", async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      const data = await mergeDuplicates(req.body || {});
      res.json({ success: true, data });
    } catch (err) {
      res.status(500).json({ success: false, error: err?.message || String(err) });
    }
  });

  router.post("/sheet/mapping/check", async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      const data = await reconcileSheetMappings(req.body || {}, { apply: true });
      res.json({ success: true, data });
    } catch (err) {
      res.status(500).json({ success: false, error: err?.message || String(err) });
    }
  });

  router.post("/sheet/mapping/resolve", async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      const data = await reconcileSheetMappings(req.body || {}, { apply: true });
      res.json({ success: true, data });
    } catch (err) {
      res.status(500).json({ success: false, error: err?.message || String(err) });
    }
  });

  router.post("/sheet/preview", async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      const body = req.body || {};
      const runId = String(body.runId || "").trim();
      const run = runId ? runs.get(runId) : null;
      if (runId && !run) return res.status(404).json({ success: false, error: "sync run not found" });
      if (runId && !run?.result) return res.status(409).json({ success: false, error: "sync run result is not ready" });
      const syncResult = runId ? run.result : (body.syncResult || body.result || body);
      const data = await previewSheetUpdates(syncResult, {
        config: body.config,
        url: body.url,
        readSheet: body.readSheet,
        existingRows: body.existingRows,
        timeoutMs: Math.max(15000, Number(body.timeoutMs || 60000)),
      });
      res.json({ success: true, data });
    } catch (err) {
      res.status(err?.needLogin ? 401 : 500).json(sheetRouteErrorResponse(err));
    }
  });

  router.post("/sheet/apply", async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      const body = req.body || {};
      const plan = body.plan || body;
      const data = await applySheetUpdates(plan, {
        url: body.url,
        timeoutMs: Math.max(15000, Number(body.timeoutMs || 60000)),
      });
      res.json({ success: true, data });
    } catch (err) {
      res.status(err?.needLogin ? 401 : 500).json(sheetRouteErrorResponse(err));
    }
  });

  router.post("/dry-run", async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      assertValidSourceViews(req.body || {}, configFromBody(req.body || {}));
      if (req.body?.async === true) {
        const run = createRun(req.body?.source ? `dry-run-${req.body.source}` : "dry-run");
        const progress = runProgress(run);
        const body = { ...(req.body || {}), async: false, onProgress: progress };
        Promise.resolve().then(async () => {
          try {
            const result = await runAdaptiveSync(body, { dryRun: true });
            finishRun(run, result?.ok === false ? "failed" : "success", {
              result,
              error: result?.firstError || "",
            });
          } catch (err) {
            finishRun(run, "failed", { error: err?.message || String(err) });
          }
        });
        return res.json({ success: true, data: publicRun(run) });
      }
      const result = await runAdaptiveSync(req.body || {}, { dryRun: true });
      res.json({ success: true, data: result });
    } catch (err) {
      res.status(err?.statusCode || 500).json({
        success: false,
        error: err?.message || String(err),
        ...(err?.sourceViewsValidation ? { data: err.sourceViewsValidation } : {}),
      });
    }
  });

  router.post("/mapping-preview", async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      const body = req.body || {};
      const config = body.config && typeof body.config === "object" ? body.config : undefined;
      const workItems = Array.isArray(body.workItems)
        ? body.workItems
        : body.workItem
          ? [body.workItem]
          : [];
      if (workItems.length) {
        const results = [];
        const loaderScope = {};
        for (const workItem of workItems.slice(0, parseLimit(body.limit, 10, 50))) {
          results.push(await syncFeishuProjectWorkItem(workItem, { dryRun: true, config, loaderScope }));
        }
        return res.json({ success: true, data: { ok: true, dryRun: true, total: results.length, results } });
      }
      const ids = [
        ...(Array.isArray(body.workItemIds) ? body.workItemIds : []),
        body.workItemId,
      ].map((x) => String(x || "").trim()).filter(Boolean);
      if (!ids.length) return res.status(400).json({ success: false, error: "workItem/workItems or workItemId/workItemIds is required" });
      const result = await runSync(runOptions({ ...body, workItemIds: ids, config }, { dryRun: true }));
      res.json({ success: true, data: result });
    } catch (err) {
      res.status(500).json({ success: false, error: err?.message || String(err) });
    }
  });

  router.post("/policy-preview", (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      const body = req.body || {};
      const currentSync = getConfig().feishuProjectSync || {};
      const incoming = body.config && typeof body.config === "object" ? body.config : {};
      const config = mergeMasked(currentSync, incoming);
      assertValidSyncPolicyConfig(config);
      const workItem = body.workItem && typeof body.workItem === "object" ? body.workItem : {};
      const data = previewFeishuProjectSyncPolicy(workItem, { config, action: body.action });
      res.json({ success: true, data });
    } catch (err) {
      res.status(err?.statusCode || 400).json({
        success: false,
        error: err?.message || String(err),
        ...(err?.policyValidation ? { policyValidation: err.policyValidation } : {}),
      });
    }
  });

  router.post("/run", async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      assertValidSourceViews(req.body || {}, configFromBody(req.body || {}));
      if (req.body?.async === true) {
        const run = createRun(req.body?.source ? `run-${req.body.source}` : "run");
        const progress = runProgress(run);
        const body = { ...(req.body || {}), async: false, onProgress: progress };
        Promise.resolve().then(async () => {
          try {
            const result = await runAdaptiveSync(body, { dryRun: false });
            finishRun(run, result?.ok === false ? "failed" : "success", {
              result,
              error: result?.firstError || "",
            });
          } catch (err) {
            finishRun(run, "failed", { error: err?.message || String(err) });
          }
        });
        return res.json({ success: true, data: publicRun(run) });
      }
      const result = await runAdaptiveSync(req.body || {}, { dryRun: false });
      res.json({ success: true, data: result });
    } catch (err) {
      res.status(err?.statusCode || 500).json({
        success: false,
        error: err?.message || String(err),
        ...(err?.sourceViewsValidation ? { data: err.sourceViewsValidation } : {}),
      });
    }
  });

  router.post("/backfill", async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      const result = await backfillSync(runOptions(req.body));
      res.json({ success: true, data: result });
    } catch (err) {
      res.status(500).json({ success: false, error: err?.message || String(err) });
    }
  });

  router.post("/webhook", async (req, res) => {
    const cfg = getFeishuProjectSyncConfig();
    if (!cfg.enabled) return res.json({ success: true, data: { accepted: true, skipped: true, reason: "sync disabled" } });
    if (!validWebhookSecret(req, cfg) && !isAdminReq(req)) {
      if (cfg.sync?.webhookSecret) {
        return res.status(401).json({ success: false, error: "invalid webhook secret" });
      }
      return res.status(403).json({ success: false, error: "feishu project webhook requires secret or admin" });
    }
    try {
      const result = await handleWebhook(req.body || {});
      res.json({ success: true, data: result });
    } catch (err) {
      res.status(500).json({ success: false, error: err?.message || String(err) });
    }
  });

  return router;
}
