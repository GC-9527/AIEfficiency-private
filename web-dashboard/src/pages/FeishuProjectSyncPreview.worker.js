function collectSyncResults(data) {
  if (!data || typeof data !== "object") return [];
  const candidates = [
    data.results,
    data.result?.results,
    data.result?.result?.results,
    data.resultsPreview,
    data.resultSummary?.resultsPreview,
    data.summary?.resultsPreview,
  ];
  return candidates.find(Array.isArray) || [];
}

function getSyncResultStats(data) {
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
    results,
  };
}

function syncRowId(row) {
  return row?.item?.sourceWorkItemId || row?.item?.id || row?.sourceWorkItemId || "-";
}

function formatPreviewForDisplay(data) {
  if (!data) return "dry-run 或样例预览后，这里显示转换后的 TB payload。";
  try {
    return JSON.stringify(compactPreviewData(data), null, 2);
  } catch (err) {
    return `结果已返回，但展示时压缩失败：${err?.message || String(err)}`;
  }
}

function compactPreviewData(data) {
  if (!data || typeof data !== "object") return data;
  const results = collectSyncResults(data);
  const stats = getSyncResultStats(data);
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
    out.resultsPreview = results.slice(0, 20).map(compactSyncResultRow);
    if (results.length > 20) out.resultsOmitted = results.length - 20;
  }
  out._displayNote = "结果页为避免浏览器卡顿，只展示精简 JSON；完整判断请以上方摘要和结果明细为准。";
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

function compactSyncResultRow(row = {}) {
  const item = row.item || {};
  const payload = row.payload || {};
  const verification = row.targetFieldVerification || {};
  const notePrevious = compactNotePrevious(row);
  return cleanDisplayObject({
    ok: row.ok,
    action: row.action,
    dryRun: row.dryRun,
    id: syncRowId(row),
    title: item.title || item.work_item_name || item.name,
    assignees: Array.isArray(item.assignees) ? item.assignees.map((person) => person?.name || person?.userKey || person?.email).filter(Boolean).slice(0, 8) : undefined,
    targetTaskId: row.targetTaskId || row.existing?.targetTaskId || row.remoteExisting?.targetTaskId || verification.targetTaskId || verification.task?._id || verification.task?.id || verification.task?.taskId,
    targetUniqueId: row.targetUniqueId || row.existing?.targetUniqueId || row.remoteExisting?.targetUniqueId || verification.targetUniqueId || verification.task?.uniqueId || verification.task?.unique_id,
    notePrevious,
    reason: row.reason,
    error: row.error,
    payload: Object.keys(payload).length ? cleanDisplayObject({
      content: clipText(payload.content, 300),
      note: clipText(payload.note, 4000),
      notePrevious,
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
    targetFieldVerification: row.targetFieldVerification,
    comparisonSnapshot: row.comparisonSnapshot,
    targetVerification: row.targetVerification,
    scheduleWarnings: row.scheduleWarnings,
    childPlan: row.childPlan ? cleanDisplayObject({
      needsSync: row.childPlan.needsSync,
      comments: row.childPlan.comments,
      targetComments: row.childPlan.targetComments,
      targetCommentRead: row.childPlan.targetCommentRead,
      attachments: row.childPlan.attachments,
    }) : undefined,
  });
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
    if (text) return clipText(text, 4000);
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

self.onmessage = (event) => {
  const id = event.data?.id;
  try {
    self.postMessage({ id, ok: true, text: formatPreviewForDisplay(event.data?.data) });
  } catch (err) {
    self.postMessage({ id, ok: false, error: err?.message || String(err) });
  }
};
