function safeHttpUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  try {
    const parsed = new URL(raw);
    return ["http:", "https:"].includes(parsed.protocol) ? parsed.toString() : "";
  } catch {
    return "";
  }
}

function nestedObjects(value) {
  const queue = [value];
  const seen = new Set();
  const result = [];
  while (queue.length && result.length < 12) {
    const current = queue.shift();
    if (!current || typeof current !== "object" || seen.has(current)) continue;
    seen.add(current);
    result.push(current);
    for (const child of [current.result, current.data]) {
      if (child && typeof child === "object") queue.push(child);
    }
  }
  return result;
}

function pullRequestLocalId(value) {
  for (const current of nestedObjects(value)) {
    const localId = String(current.localId || "").trim();
    if (/^\d+$/.test(localId) && Number(localId) > 0) return Number(localId);
  }
  return null;
}

function detailPageUrl(value, localId = null) {
  const target = safeHttpUrl(value);
  if (!target) return "";
  const parsed = new URL(target);
  const detailMatch = parsed.pathname.match(/\/change\/(\d+)\/?$/i);
  if (!localId) return detailMatch ? parsed.toString() : "";
  if (detailMatch && Number(detailMatch[1]) === Number(localId)) return parsed.toString();

  parsed.search = "";
  parsed.hash = "";
  parsed.pathname = parsed.pathname
    .replace(/\/(?:changes?|merge_requests?)(?:\/\d+)?\/?$/i, "")
    .replace(/\/+$/, "");
  parsed.pathname = `${parsed.pathname}/change/${localId}`;
  return parsed.toString();
}

export function isEmbeddedElectron(windowObject = globalThis.window) {
  return !!windowObject?.electronAPI?.isElectron
    || /\bElectron\//i.test(String(windowObject?.navigator?.userAgent || ""));
}

export function openPullRequestWindow(target, windowObject = globalThis.window) {
  const url = safeHttpUrl(target);
  if (!url || typeof windowObject?.open !== "function") return false;
  try {
    const openedWindow = windowObject.open(url, "_blank");
    if (openedWindow) openedWindow.opener = null;
    // Service Control 用 setWindowOpenHandler 拦截 window.open 并交给 shell.openExternal，
    // Electron 此时会返回 null，但系统浏览器已经接管，仍应视为成功。
    return !!openedWindow || isEmbeddedElectron(windowObject);
  } catch {
    return false;
  }
}

export function createdPullRequestUrl(data = {}) {
  const mergeRequest = data?.mergeRequest || {};
  if (mergeRequest.created !== true) return "";
  const candidates = [];
  for (const value of nestedObjects(mergeRequest)) {
    for (const candidate of [value.webUrl, value.detailUrl, value.url]) {
      const url = safeHttpUrl(candidate);
      if (url) candidates.push(url);
    }
  }
  const localId = pullRequestLocalId(mergeRequest);
  for (const candidate of candidates) {
    const detail = detailPageUrl(candidate);
    if (detail && (!localId || new URL(detail).pathname.endsWith(`/change/${localId}`))) return detail;
  }
  if (!localId) return "";
  for (const candidate of [...candidates, data?.fallbackUrl, mergeRequest?.changesUrl]) {
    const detail = detailPageUrl(candidate, localId);
    if (detail) return detail;
  }
  return "";
}

/**
 * 成功后自动打开对应 PR：桌面端优先系统浏览器；Web 端优先复用点击时预开的窗口，
 * 再尝试新窗口。浏览器阻止新窗口时返回 blocked，绝不替换当前工作页。
 */
export async function openPullRequestPage(url, options = {}) {
  const target = safeHttpUrl(url);
  if (!target) return { opened: false, method: "invalid" };

  if (typeof options.openExternal === "function") {
    try {
      if (await options.openExternal(target)) return { opened: true, method: "external" };
    } catch {}
  }

  const popup = options.popupWindow;
  try {
    if (popup && !popup.closed) {
      popup.location.href = target;
      return { opened: true, method: "reserved-window" };
    }
  } catch {}

  if (typeof options.openWindow === "function") {
    try {
      if (options.openWindow(target)) return { opened: true, method: "new-window" };
    } catch {}
  }

  return { opened: false, method: "blocked" };
}
