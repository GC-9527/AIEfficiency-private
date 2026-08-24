function stringValue(value) {
  return String(value ?? "").trim();
}

function objectValue(value) {
  return value && typeof value === "object" ? value : {};
}

export function feishuRecordsRefreshLogId(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
    const row = objectValue(value);
    const direct = stringValue(row.refreshLogId);
    if (direct) return direct;
    const nested = stringValue(objectValue(row.data).refreshLogId);
    if (nested) return nested;
  }
  return "";
}

export function feishuRecordsRefreshStatus(data = {}, fallback = "failed") {
  const payload = objectValue(data);
  if (payload.partial === true) return "partial";
  if (payload.ok === false) return "failed";
  if (fallback === "running" || fallback === "success" || fallback === "partial" || fallback === "failed") {
    return fallback;
  }
  return "failed";
}

export function createFeishuRecordsRefreshResult({
  status = "failed",
  data = {},
  error = "",
  refreshLogId = "",
  finishedAt = "",
} = {}) {
  const payload = objectValue(data);
  const normalizedStatus = feishuRecordsRefreshStatus(payload, status);
  return {
    status: normalizedStatus,
    data: payload,
    refreshLogId: feishuRecordsRefreshLogId(refreshLogId, payload),
    error: stringValue(error || payload.firstError || payload.error),
    finishedAt: stringValue(finishedAt),
  };
}

export function feishuRecordsRefreshResultView(result = {}) {
  const normalized = createFeishuRecordsRefreshResult(result);
  const payload = normalized.data;
  const sourceResults = Array.isArray(payload.sourceResults) ? payload.sourceResults : [];
  const warnings = Array.from(new Set(
    sourceResults.map((row) => stringValue(row?.warning)).filter(Boolean),
  ));
  const failedSources = sourceResults.filter((row) => row?.ok === false).length;
  const labels = {
    running: "飞书工单更新中",
    success: "飞书工单更新成功",
    partial: "飞书工单部分完成",
    failed: "飞书工单更新失败",
  };
  return {
    status: normalized.status,
    title: labels[normalized.status] || labels.failed,
    refreshLogId: normalized.refreshLogId,
    error: normalized.error,
    warning: warnings.join("；"),
    refreshed: Number(payload.refreshed || 0),
    skippedCount: Number(payload.skippedCount || 0),
    removedUnsynced: Number(payload.removedUnsynced || 0),
    hiddenSynced: Number(payload.hiddenSynced || 0),
    failedSources,
    sourceCount: sourceResults.length,
    snapshotReconciled: payload.snapshotReconciled === true,
    finishedAt: normalized.finishedAt,
  };
}
