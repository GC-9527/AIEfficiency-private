const DEFAULT_EDGE_INSET = 12;

function finiteNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function projectControlsPositionStorageKey(tabId) {
  return `devbench_project_controls_position:${String(tabId || "")}`;
}

export function projectControlsExpandedStorageKey(tabId) {
  return `devbench_project_controls_expanded:${String(tabId || "")}`;
}

/** 读取工程操作区展开状态；未记录过返回 null（由调用方按默认值兜底）。 */
export function readProjectControlsExpanded(tabId) {
  try {
    const raw = localStorage.getItem(projectControlsExpandedStorageKey(tabId));
    if (raw == null) return null;
    return raw === "1";
  } catch {
    return null;
  }
}

/** 持久化工程操作区展开状态；expanded 传 null 时清除记录（回退默认）。 */
export function writeProjectControlsExpanded(tabId, expanded) {
  try {
    const key = projectControlsExpandedStorageKey(tabId);
    if (expanded == null) localStorage.removeItem(key);
    else localStorage.setItem(key, expanded ? "1" : "0");
  } catch {}
}

export function parseProjectControlsPosition(rawValue) {
  if (!rawValue) return null;
  try {
    const parsed = typeof rawValue === "string" ? JSON.parse(rawValue) : rawValue;
    const x = finiteNumber(parsed?.x);
    const y = finiteNumber(parsed?.y);
    return x == null || y == null ? null : { x, y };
  } catch {
    return null;
  }
}

export function clampProjectControlsPosition(position, bounds, edgeInset = DEFAULT_EDGE_INSET) {
  const x = finiteNumber(position?.x);
  const y = finiteNumber(position?.y);
  if (x == null || y == null) return null;

  const containerWidth = Math.max(0, finiteNumber(bounds?.containerWidth) || 0);
  const containerHeight = Math.max(0, finiteNumber(bounds?.containerHeight) || 0);
  const itemWidth = Math.max(0, finiteNumber(bounds?.itemWidth) || 0);
  const itemHeight = Math.max(0, finiteNumber(bounds?.itemHeight) || 0);
  const inset = Math.max(0, finiteNumber(edgeInset) ?? DEFAULT_EDGE_INSET);

  const availableX = Math.max(0, containerWidth - itemWidth);
  const availableY = Math.max(0, containerHeight - itemHeight);
  const minX = Math.min(inset, availableX);
  const minY = Math.min(inset, availableY);
  const maxX = Math.max(minX, availableX - inset);
  const maxY = Math.max(minY, availableY - inset);

  return {
    x: Math.min(maxX, Math.max(minX, x)),
    y: Math.min(maxY, Math.max(minY, y)),
  };
}
