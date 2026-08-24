import { useMemo, useSyncExternalStore } from "react";
import {
  ADMIN_AUTH_CHANGED_EVENT,
  clearGatewayAdminToken,
  createGatewayWebSocket,
  getApiUrl,
  getGatewayAdminToken,
  getGatewayAudienceOrigin,
  isGatewayAudienceUrl,
  setGatewayAdminToken,
} from "./gateway.js";

const ROLE_CACHE_KEY = "admin_role_cache_v1";
const DEFAULT_TIMEOUT_MS = 5000;

const listeners = new Set();
let snapshot = freezeSnapshot({
  status: "checking",
  principal: null,
  error: null,
  verifiedAt: null,
  refreshing: false,
});
let snapshotToken = "";
let generation = 0;
let activeRequest = null;
let runtimeStarted = false;
let authSocket = null;
let authSocketTimer = null;
let authSocketRetry = 0;

function freezeSnapshot(value) {
  const principal = value.principal && typeof value.principal === "object"
    ? Object.freeze({ ...value.principal })
    : null;
  const permissions = Object.freeze(normalizePermissions(principal));
  const role = principal?.role || null;
  const roleIsAdmin = role === "super" || role === "admin";
  const authenticated = value.status === "authenticated";
  return Object.freeze({
    status: value.status,
    principal,
    role,
    permissions,
    capabilities: permissions,
    // `principal` may remain visible during a transient outage so the page can
    // explain the last verified identity. Authorization booleans are current
    // facts, however, and therefore fail closed until /me verifies again.
    lastKnownAdmin: roleIsAdmin,
    isAdmin: authenticated && roleIsAdmin,
    canMutate: authenticated && roleIsAdmin,
    loading: value.status === "checking",
    refreshing: Boolean(value.refreshing),
    error: value.error || null,
    verifiedAt: value.verifiedAt || null,
  });
}

function normalizePermissions(principal) {
  if (!principal) return [];
  const raw = principal.permissions ?? principal.capabilities ?? principal.scopes;
  if (Array.isArray(raw)) {
    return [...new Set(raw.map((item) => String(item || "").trim()).filter(Boolean))];
  }
  if (raw && typeof raw === "object") {
    return Object.entries(raw)
      .filter(([, allowed]) => Boolean(allowed))
      .map(([permission]) => permission);
  }
  return [];
}

function emit(next, token = snapshotToken) {
  snapshotToken = token || "";
  snapshot = freezeSnapshot(next);
  for (const listener of listeners) listener();
  return snapshot;
}

function clearLegacyRoleCache() {
  try { localStorage.removeItem(ROLE_CACHE_KEY); } catch {}
}

export function clearRoleCache() {
  clearLegacyRoleCache();
}

function currentCredential() {
  try {
    const audience = getGatewayAudienceOrigin();
    const token = audience ? getGatewayAdminToken(getApiUrl("/api/admin/auth/me")) : "";
    return { token, audience };
  } catch {
    return { token: "", audience: "" };
  }
}

export function getAdminToken() {
  return currentCredential().token;
}

function errorInfo(kind, message, status) {
  return Object.freeze({ kind, message, status: status || null, at: Date.now() });
}

function cancelActiveRequest() {
  if (!activeRequest) return;
  activeRequest.controller.abort();
  activeRequest = null;
}

function stopAuthSocket() {
  if (authSocketTimer) clearTimeout(authSocketTimer);
  authSocketTimer = null;
  if (authSocket) {
    authSocket.onclose = null;
    try { authSocket.close(); } catch {}
  }
  authSocket = null;
}

function scheduleAuthSocketReconnect() {
  if (!runtimeStarted || authSocketTimer || !currentCredential().token) return;
  const delay = Math.min(30000, 1000 * (2 ** Math.min(authSocketRetry, 5)));
  authSocketRetry += 1;
  authSocketTimer = setTimeout(() => {
    authSocketTimer = null;
    connectAuthSocket();
  }, delay);
}

function connectAuthSocket() {
  if (!runtimeStarted || authSocket || typeof WebSocket === "undefined" || !currentCredential().token) return;
  try {
    const socket = createGatewayWebSocket();
    authSocket = socket;
    socket.onopen = () => { authSocketRetry = 0; };
    socket.onmessage = (event) => {
      let message = null;
      try { message = JSON.parse(event.data); } catch { return; }
      if (message?.type !== "admin_authz_invalidated" && message?.type !== ADMIN_AUTH_CHANGED_EVENT) return;
      // The server is authoritative. Keep the current principal visible while
      // revalidating, but mutation permissions fail closed until /me succeeds.
      void refreshAdminSession({ force: true, failClosed: true, reason: message.type });
    };
    socket.onclose = () => {
      if (authSocket === socket) authSocket = null;
      scheduleAuthSocketReconnect();
    };
    socket.onerror = () => {
      try { socket.close(); } catch {}
    };
  } catch {
    authSocket = null;
    scheduleAuthSocketReconnect();
  }
}

function restartAuthSocket() {
  stopAuthSocket();
  authSocketRetry = 0;
  connectAuthSocket();
}

function publishAnonymous() {
  clearLegacyRoleCache();
  return emit({
    status: "anonymous",
    principal: null,
    error: null,
    verifiedAt: null,
    refreshing: false,
  }, "");
}

function onCredentialChanged() {
  generation += 1;
  cancelActiveRequest();
  clearLegacyRoleCache();
  const { token } = currentCredential();
  if (!token) {
    stopAuthSocket();
    publishAnonymous();
    return;
  }
  const canKeepPrincipal = snapshotToken === token && snapshot.principal;
  emit({
    status: canKeepPrincipal ? snapshot.status : "checking",
    principal: canKeepPrincipal ? snapshot.principal : null,
    error: null,
    verifiedAt: canKeepPrincipal ? snapshot.verifiedAt : null,
    refreshing: Boolean(canKeepPrincipal),
  }, token);
  restartAuthSocket();
  void refreshAdminSession({ reason: "credential_changed" });
}

function onStorage(event) {
  if (["admin_token", "admin_token_audience", "gateway_url"].includes(event.key) || event.key === null) {
    onCredentialChanged();
  }
}

function onFocus() {
  connectAuthSocket();
  void refreshAdminSession({ reason: "focus" });
}

function onVisibilityChange() {
  if (document.visibilityState === "visible") {
    connectAuthSocket();
    void refreshAdminSession({ reason: "visibility" });
  }
}

function onPageShow() {
  void refreshAdminSession({ reason: "pageshow" });
}

function ensureRuntime() {
  if (runtimeStarted || typeof window === "undefined" || typeof window.addEventListener !== "function") return;
  runtimeStarted = true;
  window.addEventListener(ADMIN_AUTH_CHANGED_EVENT, onCredentialChanged);
  window.addEventListener("storage", onStorage);
  window.addEventListener("focus", onFocus);
  window.addEventListener("pageshow", onPageShow);
  if (typeof document !== "undefined") {
    document.addEventListener("visibilitychange", onVisibilityChange);
  }
  connectAuthSocket();
}

function stopRuntime() {
  if (!runtimeStarted || typeof window === "undefined") return;
  runtimeStarted = false;
  window.removeEventListener(ADMIN_AUTH_CHANGED_EVENT, onCredentialChanged);
  window.removeEventListener("storage", onStorage);
  window.removeEventListener("focus", onFocus);
  window.removeEventListener("pageshow", onPageShow);
  if (typeof document !== "undefined") {
    document.removeEventListener("visibilitychange", onVisibilityChange);
  }
  stopAuthSocket();
}

function sameCredential(request, credential) {
  return request.token === credential.token && request.audience === credential.audience;
}

function isCurrentRequest(request) {
  if (request.generation !== generation) return false;
  return sameCredential(request, currentCredential());
}

function principalFromResponse(data) {
  const candidate = data?.data && typeof data.data === "object" ? data.data : data;
  if (!candidate || typeof candidate !== "object") return null;
  return {
    ...candidate,
    role: candidate.role ? String(candidate.role) : null,
    name: candidate.name ? String(candidate.name) : "",
  };
}

export function getAdminSessionSnapshot() {
  return snapshot;
}

export function subscribeAdminSession(listener) {
  ensureRuntime();
  listeners.add(listener);
  void refreshAdminSession({ reason: "subscribe" });
  return () => listeners.delete(listener);
}

/**
 * Refresh the one process-wide admin principal. Concurrent callers for the
 * same credential share one request. A credential change aborts the old
 * generation, and every result verifies token + audience again before it can
 * publish or invalidate anything.
 */
export function refreshAdminSession({ force = false, failClosed = false, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  ensureRuntime();
  const credential = currentCredential();
  if (!credential.token) {
    generation += 1;
    cancelActiveRequest();
    return Promise.resolve(publishAnonymous());
  }

  if (activeRequest && sameCredential(activeRequest, credential) && !force) {
    return activeRequest.promise;
  }

  if (activeRequest) cancelActiveRequest();
  const request = {
    ...credential,
    generation: ++generation,
    controller: new AbortController(),
    timedOut: false,
    promise: null,
  };
  const previousPrincipal = snapshotToken === credential.token ? snapshot.principal : null;
  const previousVerifiedAt = previousPrincipal ? snapshot.verifiedAt : null;
  emit({
    status: previousPrincipal ? (failClosed ? "checking" : snapshot.status) : "checking",
    principal: previousPrincipal,
    error: null,
    verifiedAt: previousVerifiedAt,
    refreshing: Boolean(previousPrincipal),
  }, credential.token);

  const timer = timeoutMs > 0
    ? setTimeout(() => {
      request.timedOut = true;
      request.controller.abort();
    }, timeoutMs)
    : null;

  request.promise = (async () => {
    try {
      const response = await fetch(getApiUrl("/api/admin/auth/me"), {
        headers: { Authorization: `Bearer ${request.token}` },
        signal: request.controller.signal,
      });
      let data = null;
      try { data = await response.json(); } catch {}
      if (!isCurrentRequest(request)) return snapshot;

      if (response.status === 401) {
        clearGatewayAdminToken({ expectedToken: request.token, reason: "unauthorized" });
        return snapshot;
      }

      if (!response.ok || data?.ok === false) {
        const kind = response.status === 403 ? "forbidden" : "server";
        return emit({
          status: "degraded",
          principal: previousPrincipal,
          error: errorInfo(kind, data?.error || `身份服务暂不可用（HTTP ${response.status}）`, response.status),
          verifiedAt: previousVerifiedAt,
          refreshing: false,
        }, request.token);
      }

      const principal = principalFromResponse(data);
      if (!principal) {
        return emit({
          status: "degraded",
          principal: previousPrincipal,
          error: errorInfo("invalid_response", "身份服务返回了无效数据"),
          verifiedAt: previousVerifiedAt,
          refreshing: false,
        }, request.token);
      }

      clearLegacyRoleCache();
      return emit({
        status: "authenticated",
        principal,
        error: null,
        verifiedAt: Date.now(),
        refreshing: false,
      }, request.token);
    } catch (error) {
      if (!isCurrentRequest(request)) return snapshot;
      const kind = request.timedOut ? "timeout" : "network";
      return emit({
        status: "degraded",
        principal: previousPrincipal,
        error: errorInfo(
          kind,
          request.timedOut ? "管理员身份校验超时，请稍后重试" : (error?.message || "管理员身份服务不可用"),
        ),
        verifiedAt: previousVerifiedAt,
        refreshing: false,
      }, request.token);
    } finally {
      if (timer) clearTimeout(timer);
      if (activeRequest === request) activeRequest = null;
    }
  })();
  activeRequest = request;
  return request.promise;
}

export function useAdminSession() {
  return useSyncExternalStore(
    subscribeAdminSession,
    getAdminSessionSnapshot,
    getAdminSessionSnapshot,
  );
}

function matchesPermission(granted, requested) {
  if (granted === "*" || granted === requested) return true;
  return granted.endsWith(":*") && requested.startsWith(granted.slice(0, -1));
}

export function hasAdminPermission(session, permission) {
  if (!session?.principal || session.status !== "authenticated") return false;
  const requested = Array.isArray(permission) ? permission : [permission];
  const permissions = session.permissions || normalizePermissions(session.principal);
  return requested.filter(Boolean).every((item) =>
    permissions.some((granted) => matchesPermission(granted, String(item))),
  );
}

export function usePermission(permission) {
  const session = useAdminSession();
  return useMemo(() => hasAdminPermission(session, permission), [session, permission]);
}

/** Compatibility layer for existing call sites during the migration. */
export function useIsAdmin() {
  const session = useAdminSession();
  return useMemo(() => ({
    isAdmin: session.isAdmin,
    verifiedIsAdmin: session.isAdmin,
    role: session.role,
    loading: session.loading,
    status: session.status,
    principal: session.principal,
    permissions: session.permissions,
    capabilities: session.capabilities,
    canMutate: session.canMutate,
    error: session.error,
    refresh: refreshAdminSession,
  }), [session]);
}

export async function fetchAdminMe(options = {}) {
  const next = await refreshAdminSession(options);
  return next.principal;
}

export async function authenticatedFetch(input, init = {}) {
  ensureRuntime();
  const headers = new Headers(init.headers || {});
  const isGatewayRequest = isGatewayAudienceUrl(input);
  if (!isGatewayRequest) headers.delete("Authorization");
  const token = isGatewayRequest ? getGatewayAdminToken(input) : "";
  if (token && !headers.has("Authorization")) {
    headers.set("Authorization", `Bearer ${token}`);
  }
  const response = await fetch(input, { ...init, headers });
  if (response.status === 401 && token) {
    clearGatewayAdminToken({ expectedToken: token, reason: "unauthorized" });
  }
  return response;
}

export async function adminRequest(path, {
  method = "GET",
  body,
  headers: initialHeaders,
  timeoutMs = 10000,
  signal,
  auth = true,
} = {}) {
  const url = /^https?:\/\//i.test(String(path || "")) ? String(path) : getApiUrl(path);
  const controller = new AbortController();
  let timedOut = false;
  const onAbort = () => controller.abort();
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener("abort", onAbort, { once: true });
  }
  const timer = timeoutMs > 0 ? setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs) : null;
  const headers = new Headers(initialHeaders || {});
  let requestBody = body;
  const isFormData = typeof FormData !== "undefined" && body instanceof FormData;
  if (body !== undefined && !isFormData && typeof body !== "string") {
    headers.set("Content-Type", "application/json");
    requestBody = JSON.stringify(body);
  }
  try {
    const request = { method, headers, body: requestBody, signal: controller.signal };
    const response = auth ? await authenticatedFetch(url, request) : await fetch(url, request);
    let data = null;
    try { data = await response.json(); } catch {}
    const result = data && typeof data === "object" ? { ...data } : {};
    result.ok = response.ok && result.ok !== false;
    result._status = response.status;
    if (!result.ok && !result.error) result.error = `HTTP ${response.status}`;
    return result;
  } catch (error) {
    return {
      ok: false,
      error: timedOut ? "请求超时，请稍后重试" : (error?.message || "网络请求失败"),
      timeout: timedOut,
      aborted: controller.signal.aborted && !timedOut,
      networkError: !controller.signal.aborted,
    };
  } finally {
    if (timer) clearTimeout(timer);
    if (signal) signal.removeEventListener("abort", onAbort);
  }
}

export function publishAdminSession({ token, principal } = {}, { reason = "login" } = {}) {
  const value = String(token || "").trim();
  if (!value || !setGatewayAdminToken(value, { reason })) return false;
  ensureRuntime();
  if (principal && typeof principal === "object") {
    emit({
      status: "authenticated",
      principal,
      error: null,
      verifiedAt: Date.now(),
      refreshing: true,
    }, value);
  }
  void refreshAdminSession({ reason: "publish" });
  return true;
}

export async function loginAdmin(credentials = {}, options = {}) {
  const { method: loginMethod, path: credentialPath, ...body } = credentials || {};
  const path = options.path || credentialPath || "/api/admin/auth/login";
  const result = await adminRequest(path, {
    method: "POST",
    body: loginMethod ? { ...body, method: loginMethod } : body,
    auth: false,
    timeoutMs: options.timeoutMs || 10000,
  });
  const principal = result.principal || result.data?.principal || {
    ...(result.data && typeof result.data === "object" ? result.data : {}),
    role: result.role || result.data?.role || null,
    name: result.name || result.data?.name || "",
  };
  if (result.ok && result.token) {
    publishAdminSession({ token: result.token, principal }, { reason: "login" });
  }
  return { ...result, principal: result.ok ? principal : null };
}

export async function logoutAdmin() {
  const token = getAdminToken();
  const result = token
    ? await adminRequest("/api/admin/auth/logout", { method: "POST", body: {} })
    : { ok: true };
  if (token) clearGatewayAdminToken({ expectedToken: token, reason: "logout" });
  else publishAnonymous();
  return result;
}

/** Test seam for deterministic store tests; application code must not call it. */
export function __resetAdminSessionForTests() {
  generation += 1;
  cancelActiveRequest();
  stopRuntime();
  listeners.clear();
  snapshotToken = "";
  snapshot = freezeSnapshot({
    status: "checking",
    principal: null,
    error: null,
    verifiedAt: null,
    refreshing: false,
  });
}
