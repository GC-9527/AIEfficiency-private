const STORAGE_KEY = "gateway_url";
const ADMIN_TOKEN_KEY = "admin_token";
const ADMIN_TOKEN_AUDIENCE_KEY = "admin_token_audience";
export const ADMIN_AUTH_CHANGED_EVENT = "admin_auth_changed";

function emitAdminAuthChanged(reason, previousToken = "") {
  if (typeof window === "undefined" || typeof window.dispatchEvent !== "function") return;
  const detail = {
    reason,
    previousToken,
    token: typeof localStorage === "undefined"
      ? ""
      : String(localStorage.getItem(ADMIN_TOKEN_KEY) || "").trim(),
    audience: typeof localStorage === "undefined"
      ? ""
      : normalizeUrl(localStorage.getItem(ADMIN_TOKEN_AUDIENCE_KEY) || ""),
  };
  try {
    window.dispatchEvent(new CustomEvent(ADMIN_AUTH_CHANGED_EVENT, { detail }));
  } catch {
    const event = new Event(ADMIN_AUTH_CHANGED_EVENT);
    event.detail = detail;
    window.dispatchEvent(event);
  }
}

function normalizeUrl(url) {
  const raw = String(url || "").trim();
  if (!raw) return "";
  const withProtocol = /^[a-z][a-z\d+.-]*:\/\//i.test(raw) ? raw : `http://${raw}`;
  try {
    const parsed = new URL(withProtocol);
    if (!["http:", "https:"].includes(parsed.protocol)) return "";
    if (parsed.username || parsed.password) return "";
    return parsed.origin.replace(/\/+$/, "");
  } catch {
    return "";
  }
}

function isHttpPage() {
  return window.location.protocol === "http:" || window.location.protocol === "https:";
}

function isTrustedHttpGateway(url) {
  if (!isHttpPage()) return false;
  try {
    const parsed = new URL(url);
    if (!["http:", "https:"].includes(parsed.protocol)) return false;
    // Browser deployments use their same-origin reverse proxy. A process on
    // the same hostname can still own a different port, so neither query
    // parameters nor localStorage may promote a cross-port URL to trusted.
    return parsed.origin === window.location.origin;
  } catch {
    return false;
  }
}

function electronDeclaredGateway() {
  if (!window.electronAPI?.isElectron) return "";
  return normalizeUrl(window.electronAPI.gatewayUrl || "");
}

function trustedGatewayCandidate(value) {
  const normalized = normalizeUrl(value);
  if (!normalized) return "";
  if (window.location.protocol === "file:") {
    const declared = electronDeclaredGateway();
    return declared && normalized === declared ? declared : "";
  }
  return isTrustedHttpGateway(normalized) ? normalized : "";
}

function enforceTokenAudience(audience, { allowLegacy = false } = {}) {
  if (typeof localStorage === "undefined") return;
  const token = String(localStorage.getItem(ADMIN_TOKEN_KEY) || "").trim();
  if (!token) {
    localStorage.removeItem(ADMIN_TOKEN_AUDIENCE_KEY);
    return;
  }
  const bound = normalizeUrl(localStorage.getItem(ADMIN_TOKEN_AUDIENCE_KEY) || "");
  if (bound === audience) return;
  if (!bound && allowLegacy) {
    localStorage.setItem(ADMIN_TOKEN_AUDIENCE_KEY, audience);
    return;
  }
  clearGatewayAdminToken({ expectedToken: token, reason: "audience_changed" });
}

export function getGatewayUrl() {
  // A file:// renderer has no browser origin that can constrain an
  // attacker-controlled query/localStorage value. Only the URL supplied by the
  // Electron preload boundary is eligible in this mode.
  if (window.location.protocol === "file:") {
    const declared = electronDeclaredGateway();
    enforceTokenAudience(declared, {
      allowLegacy: legacyTokenCanBindTo(declared),
    });
    return declared;
  }
  if (!isHttpPage()) return "";

  const params = new URLSearchParams(window.location.search);
  if (params.has("gateway")) {
    const trusted = trustedGatewayCandidate(params.get("gateway"));
    // Navigation-controlled input is transient. In particular, never persist
    // a query-selected origin for a later page load where it could become the
    // audience of a legacy bearer.
    localStorage.removeItem(STORAGE_KEY);
    enforceTokenAudience(trusted || window.location.origin);
    return trusted;
  }
  const storedValue = localStorage.getItem(STORAGE_KEY) || "";
  const stored = trustedGatewayCandidate(storedValue);
  if (stored) {
    // 缓存地址仅在当前浏览器主机上有效；loopback 别名视为同一主机。
    enforceTokenAudience(stored, {
      allowLegacy: legacyTokenCanBindTo(stored),
    });
    return stored;
  }
  if (storedValue) localStorage.removeItem(STORAGE_KEY);
  // Electron 桌面模式
  if (window.electronAPI?.isElectron) {
    // 远程模式：页面由远程网关加载，origin 就是网关地址
    if (window.location.protocol === "http:" || window.location.protocol === "https:") {
      enforceTokenAudience(window.location.origin, { allowLegacy: true });
      return window.location.origin;
    }
  }
  enforceTokenAudience(window.location.origin, { allowLegacy: true });
  return "";
}

export function setGatewayUrl(url) {
  const trusted = trustedGatewayCandidate(url);
  trusted ? localStorage.setItem(STORAGE_KEY, trusted) : localStorage.removeItem(STORAGE_KEY);
}

export function getApiUrl(path) {
  return `${getGatewayUrl()}${path}`;
}

export function getGatewayAudienceOrigin() {
  const gateway = getGatewayUrl();
  if (gateway) return gateway;
  return isHttpPage() ? window.location.origin : "";
}

function requestUrl(value) {
  if (typeof value === "string" || value instanceof URL) return String(value);
  return String(value?.url || "");
}

function httpAudienceOrigin(value) {
  const audience = getGatewayAudienceOrigin();
  if (!audience) return "";
  try {
    const parsed = new URL(requestUrl(value), `${audience}/`);
    if (parsed.protocol === "ws:") parsed.protocol = "http:";
    if (parsed.protocol === "wss:") parsed.protocol = "https:";
    if (!["http:", "https:"].includes(parsed.protocol)) return "";
    return parsed.origin;
  } catch {
    return "";
  }
}

export function isGatewayAudienceUrl(value) {
  const audience = getGatewayAudienceOrigin();
  return Boolean(audience) && httpAudienceOrigin(value) === audience;
}

function legacyTokenCanBindTo(audience) {
  if (!audience) return false;
  // Query parameters are navigation-controlled input, so even a redundant
  // same-origin query is not a migration boundary for a pre-existing bearer.
  if (new URLSearchParams(window.location.search).has("gateway")) return false;
  try {
    const parsed = new URL(audience);
    if (isHttpPage()) return parsed.origin === window.location.origin;
    return window.location.protocol === "file:"
      && parsed.origin === electronDeclaredGateway();
  } catch {
    return false;
  }
}

export function clearGatewayAdminToken({ expectedToken, reason = "cleared" } = {}) {
  if (typeof localStorage === "undefined") return false;
  const currentToken = String(localStorage.getItem(ADMIN_TOKEN_KEY) || "").trim();
  if (expectedToken !== undefined && currentToken !== String(expectedToken || "").trim()) {
    return false;
  }
  const hadAudience = Boolean(localStorage.getItem(ADMIN_TOKEN_AUDIENCE_KEY));
  localStorage.removeItem(ADMIN_TOKEN_KEY);
  localStorage.removeItem(ADMIN_TOKEN_AUDIENCE_KEY);
  if (currentToken || hadAudience) emitAdminAuthChanged(reason, currentToken);
  return true;
}

export function setGatewayAdminToken(token, { reason = "token_set" } = {}) {
  if (typeof localStorage === "undefined") return false;
  const value = String(token || "").trim();
  const audience = getGatewayAudienceOrigin();
  if (!value || !audience) {
    clearGatewayAdminToken({ reason: "invalid_token" });
    return false;
  }
  const previousToken = String(localStorage.getItem(ADMIN_TOKEN_KEY) || "").trim();
  const previousAudience = normalizeUrl(localStorage.getItem(ADMIN_TOKEN_AUDIENCE_KEY) || "");
  localStorage.setItem(ADMIN_TOKEN_KEY, value);
  localStorage.setItem(ADMIN_TOKEN_AUDIENCE_KEY, audience);
  if (previousToken !== value || previousAudience !== audience) {
    emitAdminAuthChanged(reason, previousToken);
  }
  return true;
}

export function getGatewayAdminToken(value) {
  if (!isGatewayAudienceUrl(value) || typeof localStorage === "undefined") return "";
  const token = String(localStorage.getItem(ADMIN_TOKEN_KEY) || "").trim();
  if (!token) return "";
  const audience = getGatewayAudienceOrigin();
  const boundAudience = normalizeUrl(localStorage.getItem(ADMIN_TOKEN_AUDIENCE_KEY) || "");
  if (boundAudience) {
    if (boundAudience === audience) return token;
    clearGatewayAdminToken({ expectedToken: token, reason: "audience_changed" });
    return "";
  }
  if (!legacyTokenCanBindTo(audience)) {
    clearGatewayAdminToken({ expectedToken: token, reason: "audience_changed" });
    return "";
  }
  localStorage.setItem(ADMIN_TOKEN_AUDIENCE_KEY, audience);
  return token;
}

export function getWsUrl() {
  const base = getGatewayAudienceOrigin();
  if (!base) return "";
  try {
    const url = new URL(base);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.pathname = "/ws";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return "";
  }
}

export function getWsProtocols(url = getWsUrl()) {
  const token = getGatewayAdminToken(url);
  // RFC 6455 subprotocol values cannot contain spaces or separators. Admin
  // tokens are 24 random bytes encoded as exactly 48 hexadecimal characters.
  // Reject malformed localStorage values instead of putting arbitrary input in
  // a handshake header.
  return /^[0-9a-f]{48}$/i.test(token)
    ? ["aiefficiency.v1", `aiefficiency.auth.${token.toLowerCase()}`]
    : ["aiefficiency.v1"];
}

export function createGatewayWebSocket(url = getWsUrl()) {
  if (!isGatewayAudienceUrl(url)) {
    throw new TypeError("WebSocket target is outside the trusted Gateway audience");
  }
  return new WebSocket(url, getWsProtocols(url));
}

export function getPerformanceResourceVideoWsUrl(runId) {
  const url = new URL(getWsUrl());
  url.searchParams.set("channel", "performance-resource-video");
  url.searchParams.set("runId", String(runId || ""));
  return url.toString();
}

/**
 * 发起 TB 扫码登录。远程模式会弹出局域网 /tb-browser 页面。
 * @returns {Promise<{success: boolean, mode?: string, viewerUrl?: string, message?: string, error?: string, data?: object}>}
 */
export async function startTbTasksLogin(options = {}) {
  const body = options.mode ? JSON.stringify({ mode: options.mode }) : undefined;
  const request = typeof options.request === "function" ? options.request : fetch;
  const resp = await request(getApiUrl("/api/tb-tasks/login"), {
    method: "POST",
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body,
  });
  let json = null;
  try { json = await resp.json(); } catch { json = null; }
  const data = json?.data || {};
  if (!resp.ok || json?.success === false) {
    return {
      success: false,
      error: json?.error || data.message || `HTTP ${resp.status}`,
      mode: data.mode,
      viewerUrl: data.viewerUrl,
      data,
    };
  }
  if (data.mode === "remote" && data.viewerUrl) {
    openRemoteBrowserViewer(data.viewerUrl, "tb-server-browser", { loginChallenge: data.loginChallenge });
  }
  return {
    success: true,
    mode: data.mode || "local",
    viewerUrl: data.viewerUrl,
    loginChallenge: data.loginChallenge,
    message: data.message || json?.message,
    data,
  };
}

/**
 * 打开远程浏览器 viewer（TB / 飞书共用）
 */
export function openRemoteBrowserViewer(viewerUrl, windowName = "server-browser", options = {}) {
  if (!viewerUrl) return "";
  const audience = getGatewayAudienceOrigin();
  if (!audience) return "";
  const url = new URL(viewerUrl, audience);
  const token = getGatewayAdminToken(url);
  // URL fragments are not sent in the HTTP request or Referer header. The
  // static viewer consumes this bootstrap value once, clears the fragment, and
  // moves authentication into the WebSocket subprotocol header.
  const bootstrap = new URLSearchParams();
  if (/^[0-9a-f]{48}$/i.test(token)) {
    bootstrap.set("access_token", token.toLowerCase());
  }
  if (/^[A-Za-z0-9_-]{40,100}$/.test(String(options.loginChallenge || ""))) {
    bootstrap.set("login_challenge", options.loginChallenge);
  }
  url.hash = bootstrap.toString();
  const abs = url.href;
  window.open(abs, windowName, "width=1280,height=900,resizable=yes,scrollbars=yes");
  return abs;
}
