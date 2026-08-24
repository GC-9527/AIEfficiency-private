/**
 * 项目开发（无人值守 AI 编排从零建大型项目）前端 API 封装 —— 全部走 /api/project-dev/*
 * 返回 { ok, data } / { ok, error }；写操作携带管理后台 token（照 devbench/api.js）。
 */
import { getApiUrl } from "../../services/gateway.js";
import { getAdminToken } from "../../services/adminAuth.js";

async function call(method, path, body) {
  const opts = { method, headers: { "Content-Type": "application/json" } };
  const token = getAdminToken();
  if (token) opts.headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) opts.body = JSON.stringify(body);
  const r = await fetch(getApiUrl(`/api/project-dev${path}`), opts);
  let data;
  try { data = await r.json(); } catch { data = { ok: false, error: `HTTP ${r.status}` }; }
  if (!r.ok && data.ok === undefined) data.ok = false;
  if (data.error && data.ok === undefined) data.ok = false;
  return data;
}

export const projectDevApi = {
  // 项目 CRUD
  listProjects: () => call("GET", "/projects"),
  createProject: (body) => call("POST", "/projects", body || {}),         // { name, spec }
  getProject: (id) => call("GET", `/projects/${id}`),
  updateProject: (id, body) => call("PUT", `/projects/${id}`, body || {}), // { name?, spec? }
  deleteProject: (id) => call("DELETE", `/projects/${id}`),

  // 运行控制
  start: (id) => call("POST", `/projects/${id}/start`),
  pause: (id) => call("POST", `/projects/${id}/pause`),
  resume: (id) => call("POST", `/projects/${id}/resume`),
  stop: (id) => call("POST", `/projects/${id}/stop`),
  approve: (id, milestoneId) => call("POST", `/projects/${id}/approve`, { milestoneId }),

  // 事件 / 运行状态
  getEvents: (id, sinceId, limit) =>
    call("GET", `/projects/${id}/events?sinceId=${sinceId || 0}&limit=${limit || 200}`),
  getState: (id) => call("GET", `/projects/${id}/state`),
};

// ---- 空白 spec 模板（新建项目用）----
export function blankSpec() {
  return {
    specId: "",
    vision: "",
    projectDir: "",
    engine: "claude",
    sessionCostCapUsd: 20,
    gating: "none",
    allowedWrites: [],
    cooldownSeconds: 0,
    milestones: [
      {
        id: "m1",
        title: "里程碑 1",
        prompt: "",
        kind: "claude",
        script: "",
        maxTurns: 30,
        maxCostUsd: 5,
        acceptance: [],
      },
    ],
  };
}

// ---- 验收检查项默认值（按 type）----
export function blankAcceptance(type) {
  switch (type) {
    case "file_exists": return { type: "file_exists", path: "" };
    case "cmd": return { type: "cmd", cmd: "", timeoutSec: 120, expectRc: 0 };
    case "grep_count": return { type: "grep_count", pattern: "", path: "", min: 1, max: undefined };
    case "json_schema": return { type: "json_schema", path: "", schema: {} };
    default: return { type: "file_exists", path: "" };
  }
}
