export function pullRequestChangeSummary(entry = {}) {
  const parts = [];
  const ahead = Math.max(0, Number(entry.aheadCount) || 0);
  const dirty = Math.max(0, Number(entry.dirtyCount) || 0);
  if (ahead) parts.push(`${ahead} 个新增提交`);
  if (dirty) parts.push(`${dirty} 项本地改动待自动提交`);
  return parts.join(" · ");
}

export function pullRequestPreviewView(payload = {}) {
  const entries = Array.isArray(payload.results) ? payload.results : [];
  const eligibleEntries = entries.filter((entry) => entry?.eligible && entry?.status === "ready");
  const noChangeEntries = entries.filter((entry) => entry?.status === "no_changes");
  const blockedEntries = entries.filter((entry) => entry?.status === "blocked");
  const globalBlocker = String(payload.globalBlocker || "").trim();
  const globalWarning = String(payload.globalWarning || "").trim();
  const executionPaths = eligibleEntries.map((entry) => entry.path).filter(Boolean);
  return {
    entries,
    eligibleEntries,
    executionPaths,
    total: entries.length,
    eligible: executionPaths.length,
    noChanges: noChangeEntries.length,
    blocked: blockedEntries.length,
    globalBlocker,
    globalWarning,
    canExecute: !globalBlocker && executionPaths.length > 0,
  };
}
