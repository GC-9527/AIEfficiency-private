const problemNoCollator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

export function feishuSyncRecordProblemNo(row = {}) {
  return String(row.sourceProblemNo || row.problemNo || row.sourceWorkItemNo || row.sourceWorkItemId || "").trim();
}

export function isHiddenFeishuSyncRecord(row = {}) {
  return row.hidden === true
    || row.sourceInScope === false
    || String(row.scopeStatus?.state || "").trim().toLowerCase() === "transferred";
}

export function sortFeishuSyncRecords(rows = [], { field = "sourceUpdatedAt", direction = "desc" } = {}) {
  const factor = String(direction).toLowerCase() === "asc" ? 1 : -1;
  const list = Array.isArray(rows) ? rows : [];
  return list.map((row, index) => ({ row, index })).sort((left, right) => {
    let result = 0;
    if (field === "problemNo") {
      const leftValue = feishuSyncRecordProblemNo(left.row);
      const rightValue = feishuSyncRecordProblemNo(right.row);
      if (!leftValue || !rightValue) result = leftValue ? -1 : rightValue ? 1 : 0;
      else result = problemNoCollator.compare(leftValue, rightValue) * factor;
    } else {
      const leftValue = timestampValue(left.row.sourceUpdatedAt);
      const rightValue = timestampValue(right.row.sourceUpdatedAt);
      if (leftValue == null || rightValue == null) result = leftValue != null ? -1 : rightValue != null ? 1 : 0;
      else result = (leftValue - rightValue) * factor;
    }
    if (result) return result;
    const problemFallback = problemNoCollator.compare(feishuSyncRecordProblemNo(left.row), feishuSyncRecordProblemNo(right.row));
    return problemFallback || left.index - right.index;
  }).map(({ row }) => row);
}

function timestampValue(value) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const parsed = Date.parse(String(value).replace(" ", "T"));
  return Number.isNaN(parsed) ? null : parsed;
}
