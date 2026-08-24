// AI Workbench 前端 API 层。
// 与 gateway.js 风格保持一致；统一走 getApiUrl。

import { getApiUrl } from "../../services/gateway.js";
import { authenticatedFetch } from "../../services/adminAuth.js";

async function request(path, { method = "GET", body, headers = {}, signal, auth = false } = {}) {
  const opts = {
    method,
    headers: { "Content-Type": "application/json", ...headers },
  };
  if (body !== undefined) opts.body = JSON.stringify(body);
  if (signal) opts.signal = signal;
  const url = getApiUrl(path);
  const normalizedMethod = String(method || "GET").toUpperCase();
  const transport = auth === true || (normalizedMethod !== "GET" && normalizedMethod !== "HEAD")
    ? authenticatedFetch
    : fetch;
  const resp = await transport(url, opts);
  let data;
  try { data = await resp.json(); } catch { data = null; }
  if (!resp.ok || (data && data.ok === false)) {
    const err = new Error((data && data.error && data.error.message) || `HTTP ${resp.status}`);
    err.code = (data && data.error && data.error.code) || `HTTP_${resp.status}`;
    err.status = resp.status;
    err.details = data && data.error && data.error.details;
    err.raw = data;
    throw err;
  }
  return data && "data" in data ? data.data : data;
}

export const api = {
  health: () => request("/api/aiautowork/health"),
  overview: () => request("/api/aiautowork/overview"),

  // acceptance
  listAcceptanceRuns: (params = {}) => {
    const q = new URLSearchParams();
    if (params.limit) q.set("limit", String(params.limit));
    if (params.offset) q.set("offset", String(params.offset));
    const suffix = q.toString();
    return request(`/api/aiautowork/acceptance/runs${suffix ? `?${suffix}` : ""}`, { auth: true });
  },

  // drafts
  createTaskDraft: (body) => request("/api/aiautowork/task-drafts", { method: "POST", body }),
  listTaskDrafts: (params = {}) => {
    const q = new URLSearchParams();
    if (params.status) q.set("status", params.status);
    if (params.sourceType) q.set("sourceType", params.sourceType);
    if (params.limit) q.set("limit", String(params.limit));
    if (params.offset) q.set("offset", String(params.offset));
    return request(`/api/aiautowork/task-drafts?${q.toString()}`);
  },
  getTaskDraft: (id) => request(`/api/aiautowork/task-drafts/${encodeURIComponent(id)}`),
  patchTaskDraft: (id, patch) => request(`/api/aiautowork/task-drafts/${encodeURIComponent(id)}`, { method: "PATCH", body: patch }),

  // batch
  createBatch: (body) => request("/api/aiautowork/batches", { method: "POST", body }),
  listBatches: (params = {}) => {
    const q = new URLSearchParams();
    if (params.status) q.set("status", params.status);
    if (params.limit) q.set("limit", String(params.limit));
    if (params.offset) q.set("offset", String(params.offset));
    return request(`/api/aiautowork/batches?${q.toString()}`);
  },
  getBatch: (id) => request(`/api/aiautowork/batches/${encodeURIComponent(id)}`),
  listBatchItems: (id, params = {}) => {
    const q = new URLSearchParams();
    if (params.status) q.set("status", params.status);
    if (params.pool) q.set("pool", params.pool);
    if (params.limit) q.set("limit", String(params.limit));
    if (params.offset) q.set("offset", String(params.offset));
    return request(`/api/aiautowork/batches/${encodeURIComponent(id)}/items?${q.toString()}`);
  },
  patchBatch: (id, patch) => request(`/api/aiautowork/batches/${encodeURIComponent(id)}`, { method: "PATCH", body: patch }),

  // manual
  listManualCases: (params = {}) => {
    const q = new URLSearchParams();
    if (params.status) q.set("status", params.status);
    if (params.taskDraftId) q.set("taskDraftId", params.taskDraftId);
    if (params.limit) q.set("limit", String(params.limit));
    return request(`/api/aiautowork/manual-cases?${q.toString()}`);
  },
  createManualCase: (body) => request("/api/aiautowork/manual-cases", { method: "POST", body }),
  patchManualCase: (id, body) => request(`/api/aiautowork/manual-cases/${encodeURIComponent(id)}`, { method: "PATCH", body }),

  // queue
  listExecutionQueue: (params = {}) => {
    const q = new URLSearchParams();
    if (params.pool) q.set("pool", params.pool);
    if (params.status) q.set("status", params.status);
    if (params.limit) q.set("limit", String(params.limit));
    return request(`/api/aiautowork/execution-queue?${q.toString()}`);
  },
  enqueueExecution: (body) => request("/api/aiautowork/execution-queue", { method: "POST", body }),

  // settings
  getSettings: () => request("/api/aiautowork/settings"),
  getSettingGroups: () => request("/api/aiautowork/settings/groups"),
  updateSettings: (patch, opts = {}) => request("/api/aiautowork/settings", { method: "PUT", body: { patch, ...opts } }),

  // audit
  listAudit: (params = {}) => {
    const q = new URLSearchParams();
    if (params.actor) q.set("actor", params.actor);
    if (params.action) q.set("action", params.action);
    if (params.targetType) q.set("targetType", params.targetType);
    if (params.targetId) q.set("targetId", params.targetId);
    if (params.limit) q.set("limit", String(params.limit));
    return request(`/api/aiautowork/audit?${q.toString()}`);
  },

  // review
  listReviewTargets: (params = {}) => {
    const q = new URLSearchParams();
    if (params.state) q.set("state", params.state);
    if (params.limit) q.set("limit", String(params.limit));
    return request(`/api/aiautowork/review-targets?${q.toString()}`);
  },
  getReviewTarget: (id) => request(`/api/aiautowork/review-targets/${encodeURIComponent(id)}`),
  createReviewTarget: (body) => request("/api/aiautowork/review-targets", { method: "POST", body }),
  listFindings: (params = {}) => {
    const q = new URLSearchParams();
    if (params.reviewTargetId) q.set("reviewTargetId", params.reviewTargetId);
    if (params.state) q.set("state", params.state);
    if (params.severity) q.set("severity", params.severity);
    if (params.limit) q.set("limit", String(params.limit));
    return request(`/api/aiautowork/findings?${q.toString()}`);
  },
};

export default api;
