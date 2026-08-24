/**
 * Teambition 开放平台 API 服务
 * 网关直接调用，不依赖 MCP Server
 * 用于工作报告数据采集
 */
import { getConfig, updateConfig } from "./config.js";
import { probeTbCookie } from "./tb-browser-shared.js";
import { getUserTbProjectSelection } from "./tb-project-prefs.js";
import { log } from "./logger.js";
import { createHash, createHmac } from "crypto";
import { lookup } from "node:dns/promises";
import { request as httpRequest } from "http";
import { request as httpsRequest } from "https";
import { isIP } from "node:net";

const BASE_URL = "https://open.teambition.com";

// 项目访问白名单（只允许访问这些项目的数据）。
// 新版由调用方传入当前账号选择；config.teambition.projects 仅作为旧版本兼容回退。
const LEGACY_PROJECT_IDS = ["65a5f274950780b816cf905e"]; // 平台组件（旧默认）
const LEGACY_PROJECT_NAMES = {
  "65a5f274950780b816cf905e": "\u5e73\u53f0\u7ec4\u4ef6",
};

function isBrokenProjectName(name) {
  const text = String(name || "").trim();
  return !text || /^[?\uFFFD]+$/.test(text);
}

export function normalizeTbProject(p) {
  const id = String(p?.id || "").trim();
  const rawName = String(p?.name || "").trim();
  return { id, name: isBrokenProjectName(rawName) ? (LEGACY_PROJECT_NAMES[id] || id) : rawName };
}

export function getTbProjects(projects = null) {
  const list = Array.isArray(projects) ? projects : getConfig().teambition?.projects;
  if (Array.isArray(list) && list.length) return list.filter((p) => p && p.id).map(normalizeTbProject);
  // config 未配置时回退到账号级项目选择（设置页「Teambition → 操作的 TB 项目」保存的偏好）。
  try {
    const selection = getUserTbProjectSelection();
    if (selection && Array.isArray(selection.projects) && selection.projects.length) {
      return selection.projects.filter((p) => p && p.id).map(normalizeTbProject);
    }
  } catch {
    // 账号偏好读取失败时继续走 LEGACY 回退
  }
  return LEGACY_PROJECT_IDS.map((id) => ({ id, name: LEGACY_PROJECT_NAMES[id] || id }));
}
export function getTbProjectIds(projects = null) { return getTbProjects(projects).map((p) => p.id); }
// 默认项目 id（未指定时用第一个）
function defaultProjectId() { return getTbProjectIds()[0] || LEGACY_PROJECT_IDS[0]; }

let appToken = "";
let tokenExpireTime = 0;

/**
 * 获取/刷新 App Token
 */
async function getAppToken() {
  if (appToken && Date.now() < tokenExpireTime) {
    return appToken;
  }

  const config = getConfig();
  const tb = config.teambition || {};
  // 兼容：优先用 teambition 配置，fallback 到钉钉配置
  const appId = tb.appId || config.dingtalkAppKey || "";
  const appSecret = tb.appSecret || config.dingtalkAppSecret || "";

  if (!appId || !appSecret) {
    throw new Error("未配置 Teambition AppId/AppSecret，请在设置页 > 工作报告 中配置");
  }

  const resp = await fetch(`${BASE_URL}/api/appToken`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ appId, appSecret }),
  });
  const data = await resp.json();

  if (!data.appToken) {
    throw new Error(`获取 appToken 失败: ${JSON.stringify(data)}`);
  }

  appToken = data.appToken;
  tokenExpireTime = Date.now() + (data.expire - 300) * 1000;
  return appToken;
}

/**
 * 通用 API 调用
 */
export class TeambitionOpenApiError extends Error {
  constructor({ method, path, status, apiCode, data }) {
    const codePart = apiCode == null ? "" : ` code ${apiCode}`;
    const detail = clip(data?.errorMessage || data?.message || data?.error || JSON.stringify(data || {}), 500);
    super(`Teambition OpenAPI ${String(method || "GET").toUpperCase()} ${path} HTTP ${status || 0}${codePart}: ${detail}`);
    this.name = "TeambitionOpenApiError";
    this.method = String(method || "GET").toUpperCase();
    this.path = path;
    this.status = status;
    this.apiCode = apiCode;
    this.data = data;
  }
}

async function tbAPI(method, path, body = null, apiOptions = {}) {
  const token = await getAppToken();
  const config = getConfig();
  const tb = config.teambition || {};
  const orgId = tb.orgId || "";

  if (!orgId) {
    throw new Error("未配置 Teambition Org ID");
  }

  const options = {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "X-Tenant-Id": orgId,
      "X-Tenant-Type": "organization",
      ...(apiOptions.headers || {}),
    },
  };

  const operatorId = apiOptions.operatorId || apiOptions.headers?.["X-Operator-Id"] || tb.operatorId;
  if (operatorId) {
    options.headers["X-Operator-Id"] = operatorId;
  }

  if (body !== undefined && body !== null) {
    options.body = JSON.stringify(body);
  }

  const resp = await fetch(teambitionOpenApiUrl(path), options);
  const data = await readJsonResponse(resp);
  const apiCode = getTeambitionApiCode(data);
  const apiFailed = data?.success === false || !isOkTeambitionApiCode(apiCode);

  if (!resp.ok || apiFailed) {
    throw new TeambitionOpenApiError({ method, path, status: resp.status, apiCode, data });
  }

  return data;
}

function teambitionOpenApiUrl(path) {
  if (/^https?:\/\//i.test(String(path || ""))) return String(path);
  return `${BASE_URL}/${String(path || "").replace(/^\/+/, "")}`;
}

async function readJsonResponse(resp) {
  if (typeof resp?.text === "function") {
    const text = await resp.text();
    if (!text) return {};
    try { return JSON.parse(text); } catch { return { raw: text }; }
  }
  if (typeof resp?.json === "function") return resp.json();
  return {};
}

function getTeambitionApiCode(data) {
  const code = data?.code ?? data?.errCode ?? data?.err_code;
  return code === undefined || code === null || code === "" ? null : code;
}

function isOkTeambitionApiCode(code) {
  return code === null || code === 0 || code === "0" || code === 200 || code === "200";
}

function unwrapTeambitionResult(data) {
  return data?.result || data?.data || data;
}

function preserveTeambitionCreateResult(data) {
  const result = unwrapTeambitionResult(data);
  if (!data || typeof data !== "object" || Array.isArray(data)) return result;
  if (!result || typeof result !== "object") return data;
  if (Array.isArray(result)) return { ...data, result };
  return { ...data, ...result, result };
}

/**
 * 查询指定时间范围内的任务
 * @param {string} since - ISO 日期字符串 (e.g. "2026-03-25")
 * @param {string} until - ISO 日期字符串
 * @returns {Array} 任务列表
 */
export async function callTeambitionOpenApi(method, path, body = null, options = {}) {
  return tbAPI(method, path, body, options);
}

export async function createTeambitionTask(payload, { path = "/api/v3/task/create" } = {}) {
  const data = await tbAPI("POST", path, normalizeTeambitionTaskWritePayload(payload));
  return preserveTeambitionCreateResult(data);
}

export async function updateTeambitionTask(taskId, payload, { path = "/api/v3/task/update" } = {}) {
  const body = { taskId, id: taskId, ...normalizeTeambitionTaskWritePayload(payload) };
  try {
    const data = await tbAPI("POST", path, body);
    return unwrapTeambitionResult(data);
  } catch (err) {
    if (!shouldFallbackToCookieTaskUpdate(err)) throw err;
    log("system", "warn", "teambition", `OpenAPI task update failed, falling back to cookie: ${err.message}`);
    return updateTeambitionTaskByCookie(taskId, payload);
  }
}

function shouldFallbackToCookieTaskUpdate(err) {
  const msg = String(err?.message || err || "");
  return /MisdirectedRequest|url not found|HTTP 404|HTTP 405|code 421/i.test(msg);
}

async function updateTeambitionTaskByCookie(taskId, payload = {}) {
  const tbConfig = getConfig().teambition || {};
  const cookie = tbConfig.userCookie || "";
  if (!cookie) throw new Error("Teambition cookie is missing; cannot fallback update task");
  const body = {};
  for (const key of ["content", "dueDate", "startDate"]) {
    if (payload[key] !== undefined && payload[key] !== null && payload[key] !== "") body[key] = payload[key];
  }
  if (typeof payload.priority === "number" && Number.isFinite(payload.priority)) body.priority = payload.priority;
  if (payload.executorId) {
    body._executorId = payload.executorId;
    body.executorId = payload.executorId;
  }
  if (payload.tagIds !== undefined) {
    const tagIds = normalizeCookieStringList(payload.tagIds);
    body._tagIds = tagIds;
    body.tagIds = tagIds;
  }
  let result = null;
  if (Object.keys(body).length) {
    const resp = await fetch(`https://www.teambition.com/api/tasks/${encodeURIComponent(taskId)}`, {
      method: "PUT",
      headers: { Cookie: cookie, "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(body),
    });
    const data = await readJsonResponse(resp);
    if (!resp.ok) throw new Error(`Teambition cookie task update HTTP ${resp.status}: ${data?.message || data?.error || JSON.stringify(data).slice(0, 300)}`);
    result = unwrapTeambitionResult(data);
  }
  const moveTarget = {
    projectId: payload.projectId,
    tasklistId: payload.tasklistId,
    sprintId: payload.sprintId,
    stageId: payload.stageId,
    organizationId: payload.organizationId || payload.orgId || payload._organizationId || tbConfig.orgId,
  };
  if ([moveTarget.projectId, moveTarget.tasklistId, moveTarget.sprintId, moveTarget.stageId].some((value) => value !== undefined && value !== null && value !== "")) {
    result = await moveTeambitionTaskByCookie(taskId, moveTarget, cookie);
  }
  if (payload.note !== undefined && payload.note !== null) {
    result = await updateTeambitionTaskNoteByCookie(taskId, payload.note, cookie);
  }
  return result || { id: taskId, _id: taskId, skipped: true };
}

async function updateTeambitionTaskNoteByCookie(taskId, note, cookie) {
  const resp = await fetch(`https://www.teambition.com/api/tasks/${encodeURIComponent(taskId)}/note`, {
    method: "PUT",
    headers: { Cookie: cookie, "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ note: String(note || "") }),
  });
  if (!resp.ok && resp.status !== 204) {
    const data = await readJsonResponse(resp);
    throw new Error(`Teambition cookie task note update HTTP ${resp.status}: ${data?.message || data?.error || JSON.stringify(data).slice(0, 300)}`);
  }
  return { id: taskId, _id: taskId, noteUpdated: true };
}

function normalizeCookieStringList(value) {
  if (Array.isArray(value)) return value.map((entry) => String(entry || "").trim()).filter(Boolean);
  if (value == null || value === "") return [];
  return String(value).split(/[\n,;]+/).map((entry) => entry.trim()).filter(Boolean);
}

function uniqueStrings(values = []) {
  return Array.from(new Set((values || []).map((value) => String(value || "").trim()).filter(Boolean)));
}

async function moveTeambitionTaskByCookie(taskId, target, cookie) {
  const move = target && typeof target === "object" ? target : { stageId: target };
  const current = await readTeambitionCookieTaskForMove(taskId, cookie);
  const body = {};
  const requestedProjectId = firstNonEmpty(move.projectId, move._projectId);
  const requestedTasklistId = firstNonEmpty(move.tasklistId, move._tasklistId);
  const requestedSprintId = firstNonEmpty(move.sprintId, move._sprintId);
  const requestedStageId = firstNonEmpty(move.stageId, move._stageId);
  const currentProjectId = firstNonEmpty(current?._projectId, current?.projectId, current?.project?._id, current?.project?.id);
  const currentTasklistId = firstNonEmpty(current?._tasklistId, current?.tasklistId, current?.tasklist?._id, current?.tasklist?.id);
  const currentSprintId = firstNonEmpty(current?._sprintId, current?.sprintId, current?.sprint?._id, current?.sprint?.id);
  const currentStageId = firstNonEmpty(current?._stageId, current?.stageId, current?.stage?._id, current?.stage?.id);
  if (!hasCookieMoveDifference([
    [requestedProjectId, currentProjectId],
    [requestedTasklistId, currentTasklistId],
    [requestedSprintId, currentSprintId],
    [requestedStageId, currentStageId],
  ])) {
    return { id: taskId, _id: taskId, skipped: true, reason: "move-target-unchanged" };
  }
  const projectId = firstNonEmpty(requestedProjectId, currentProjectId);
  const tasklistId = firstNonEmpty(requestedTasklistId, currentTasklistId);
  const sprintId = firstNonEmpty(requestedSprintId, currentSprintId);
  const stageId = firstNonEmpty(requestedStageId, currentStageId);
  const organizationId = firstNonEmpty(
    move.organizationId,
    move._organizationId,
    move.orgId,
    current?._organizationId,
    current?.organizationId,
    current?.organization?._id,
    current?.organization?.id,
  );
  if (projectId) {
    body._projectId = projectId;
    body.projectId = projectId;
  }
  if (tasklistId) {
    body._tasklistId = tasklistId;
    body.tasklistId = tasklistId;
  }
  if (sprintId) {
    body._sprintId = sprintId;
    body.sprintId = sprintId;
  }
  if (stageId) {
    body._stageId = stageId;
    body.stageId = stageId;
  }
  if (organizationId) {
    body._organizationId = organizationId;
    body.organizationId = organizationId;
  }
  if (!Object.keys(body).length) return { id: taskId, _id: taskId, skipped: true };
  const resp = await fetch(`https://www.teambition.com/api/tasks/${encodeURIComponent(taskId)}/move`, {
    method: "PUT",
    headers: { Cookie: cookie, "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(body),
  });
  const data = await readJsonResponse(resp);
  if (!resp.ok) throw new Error(`Teambition cookie task move HTTP ${resp.status}: ${data?.message || data?.error || JSON.stringify(data).slice(0, 300)}`);
  return unwrapTeambitionResult(data);
}

function firstNonEmpty(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null && value !== "") return value;
  }
  return "";
}

function hasCookieMoveDifference(pairs = []) {
  return pairs.some(([requested, current]) => {
    if (requested === undefined || requested === null || requested === "") return false;
    return String(requested) !== String(current || "");
  });
}

async function readTeambitionCookieTaskForMove(taskId, cookie) {
  try {
    const resp = await fetch(`https://www.teambition.com/api/tasks/${encodeURIComponent(taskId)}`, {
      headers: { Cookie: cookie, Accept: "application/json" },
    });
    if (!resp.ok) return null;
    return unwrapTeambitionResult(await readJsonResponse(resp)) || null;
  } catch {
    return null;
  }
}

export async function updateTeambitionTaskCustomFields(taskId, customfields, { pathTemplate = "/api/v3/task/{taskId}/customfield/update", operatorId = "" } = {}) {
  const fields = normalizeTeambitionCustomFieldWrites(customfields);
  const results = [];
  for (const field of fields) {
    const path = teambitionCustomFieldUpdatePath(taskId, field.customfieldId, pathTemplate);
    try {
      const data = await tbAPI("POST", path, field, { operatorId });
      results.push(unwrapTeambitionResult(data));
    } catch (err) {
      if (!(err instanceof TeambitionOpenApiError) || Number(err.apiCode) !== 204) throw err;
      results.push({ customfieldId: field.customfieldId, updated: false, noChange: true });
    }
  }
  return results;
}

export async function updateTeambitionTaskTags(taskId, tagIds = [], { pathTemplate = "/api/v3/task/{taskId}/tag" } = {}) {
  const path = String(pathTemplate || "/api/v3/task/{taskId}/tag")
    .replace("{taskId}", encodeURIComponent(taskId));
  const data = await tbAPI("PUT", path, { tagIds: normalizeCookieStringList(tagIds) });
  return unwrapTeambitionResult(data);
}

function normalizeTeambitionTaskWritePayload(payload = {}) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return payload;
  const next = { ...payload };
  if (Array.isArray(next.customfields)) {
    next.customfields = normalizeTeambitionCustomFieldWrites(next.customfields).map((field) => ({
      cfId: field.customfieldId,
      value: field.value,
    }));
  }
  return next;
}

function normalizeTeambitionCustomFieldWrites(customfields = []) {
  return (Array.isArray(customfields) ? customfields : []).map((field) => {
    const customfieldId = String(field?.customfieldId || field?.customFieldId || field?.cfId || field?.id || "").trim();
    if (!customfieldId) return null;
    const rawValue = field?.value ?? field?.values ?? field?.text;
    const values = (Array.isArray(rawValue) ? rawValue : [rawValue]).map((entry) => {
      if (entry && typeof entry === "object") {
        const id = String(entry.id || entry.valueId || entry.choiceId || "").trim();
        const title = String(entry.title || entry.label || entry.name || entry.text || entry.value || id || "").trim();
        if (!title) return null;
        return {
          ...(id ? { id } : {}),
          title,
          ...(entry.metaString ? { metaString: String(entry.metaString) } : {}),
        };
      }
      const title = String(entry ?? "").trim();
      return title ? { title } : null;
    }).filter(Boolean);
    if (!values.length) return null;
    return { customfieldId, value: values };
  }).filter(Boolean);
}

function teambitionCustomFieldUpdatePath(taskId, customfieldId, pathTemplate = "") {
  const encodedTaskId = encodeURIComponent(taskId);
  const encodedCustomFieldId = encodeURIComponent(customfieldId);
  const configured = String(pathTemplate || "").trim();
  if (configured.includes("{customfieldId}")) {
    return configured
      .replace("{taskId}", encodedTaskId)
      .replace("{customfieldId}", encodedCustomFieldId);
  }
  if (configured && !/\/customfields\/?$/i.test(configured)) {
    return configured.replace("{taskId}", encodedTaskId);
  }
  return `/api/v3/task/${encodedTaskId}/customfield/update`;
}

export async function getTasksInRange(since, until) {
  const allTasks = [];
  let pageToken = null;

  try {
    // 按配置项目拉取任务
    const projectIds = getTbProjectIds().length > 0 ? getTbProjectIds() : [null];
    for (const pid of projectIds) {
    pageToken = null;
    for (let page = 0; page < 10; page++) {
      let path = `/api/task/query?pageSize=100`;
      if (pid) path += `&projectId=${pid}`;
      if (pageToken) path += `&pageToken=${pageToken}`;

      const data = await tbAPI("GET", path);
      const tasks = data.result || data.data || [];

      if (tasks.length === 0) break;

      // 按时间范围过滤
      for (const task of tasks) {
        const updated = task.updated || task.created || "";
        if (updated >= since && updated <= until) {
          allTasks.push({
            id: task._id || task.id,
            title: task.content || task.title || "",
            status: task.isDone ? "completed" : (task.status || "open"),
            priority: task.priority || 0,
            created: task.created,
            updated: task.updated,
            dueDate: task.dueDate,
            projectName: task.project?.name || "",
          });
        }
      }

      pageToken = data.nextPageToken;
      if (!pageToken) break;
    }
    }
  } catch (err) {
    log("system", "warn", "teambition", `获取任务失败: ${err.message}`);
  }

  return allTasks;
}

function normalizeTaskSearchTitle(value) {
  return String(value || "").trim().replace(/\s+/g, " ");
}

function normalizeTaskSourceSearch(value) {
  return String(value || "").trim().replace(/\s+/g, "");
}

function taskSearchTitle(task) {
  return normalizeTaskSearchTitle(task?.content || task?.title || task?.name || "");
}

function taskSearchText(value) {
  if (value == null) return "";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return String(value);
  try { return JSON.stringify(value); } catch { return String(value); }
}

function taskSearchSourceText(task) {
  return [
    task?.note,
    task?.description,
    task?.desc,
    task?.detail,
    task?.customfields,
    task?.customFields,
  ].map(taskSearchText).filter(Boolean).join("\n");
}

function taskSearchFullText(task) {
  return [
    taskSearchTitle(task),
    taskSearchSourceText(task),
    task?._id,
    task?.id,
    task?.uniqueId,
    task?.unique_id,
    task?.displayId,
    task?.display_id,
  ].map(taskSearchText).filter(Boolean).join("\n");
}

function taskSearchId(task) {
  return String(task?._id || task?.id || task?.taskId || task?.task_id || task?.objectId || "").trim();
}

function taskCandidateView(task) {
  const id = taskSearchId(task);
  return {
    _id: id,
    id,
    taskId: id,
    targetTaskId: id,
    uniqueId: task?.uniqueId || task?.unique_id || task?.displayId || task?.display_id || "",
    content: taskSearchTitle(task),
    title: taskSearchTitle(task),
    projectId: task?._projectId || task?.projectId || task?.project?._id || task?.project?.id || "",
    projectName: task?.project?.name || task?.projectName || "",
    tasklistId: task?._tasklistId || task?.tasklistId || task?.tasklist?._id || task?.tasklist?.id || "",
    tasklistName: task?.tasklist?.title || task?.tasklist?.name || task?.tasklistName || "",
    stageId: task?._stageId || task?.stageId || task?.stage?._id || task?.stage?.id || "",
    stageName: task?.stage?.name || task?.stageName || "",
    executorId: task?.executor?._id || task?.executor?.id || task?.executorId || task?._executorId || "",
    executorName: task?.executor?.name || task?.executorName || "",
    createdAt: task?.created || task?.createdAt || task?._createdAt || "",
    updatedAt: task?.updated || task?.updatedAt || task?._updatedAt || task?.modified || "",
    isDone: task?.isDone ?? task?.done ?? false,
    statusId: task?.taskflowstatus?._id || task?.taskflowstatus?.id || task?._taskflowstatusId || task?.taskflowstatusId || "",
    statusName: task?.taskflowstatus?.name || task?.statusName || task?.status || "",
    url: id ? `https://www.teambition.com/task/${encodeURIComponent(id)}` : "",
    raw: task,
  };
}

function isTaskLikeObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  if (!taskSearchTitle(value)) return false;
  return Boolean(taskSearchId(value) || value.uniqueId || value.unique_id || value._projectId || value.projectId);
}

function taskSearchList(data, depth = 0) {
  if (data == null || depth > 4) return [];
  if (Array.isArray(data)) {
    const out = [];
    for (const item of data) {
      if (isTaskLikeObject(item)) out.push(item);
      else out.push(...taskSearchList(item, depth + 1));
    }
    return out;
  }
  if (typeof data !== "object") return [];
  const out = [];
  if (isTaskLikeObject(data)) out.push(data);
  for (const key of ["result", "data", "tasks", "list", "items", "records", "rows"]) {
    if (data[key] !== undefined && data[key] !== data) out.push(...taskSearchList(data[key], depth + 1));
  }
  return out;
}

function taskSearchNextPageToken(data) {
  return String(data?.nextPageToken || data?.pageToken || data?.result?.nextPageToken || data?.data?.nextPageToken || "");
}

function taskSearchTime(task) {
  return String(task?.updated || task?.updatedAt || task?._updatedAt || task?.modified || task?.created || task?.createdAt || task?._createdAt || "");
}

function pushMatchingTaskCandidates(candidates, data, title) {
  let count = 0;
  for (const task of taskSearchList(data)) {
    if (taskSearchTitle(task) !== title) continue;
    candidates.push(task);
    count += 1;
  }
  return count;
}

function pushMatchingSourceCandidates(candidates, data, sourceId) {
  const needle = normalizeTaskSourceSearch(`Source ID:${sourceId}`);
  let count = 0;
  for (const task of taskSearchList(data)) {
    const haystack = normalizeTaskSourceSearch(taskSearchSourceText(task));
    if (!haystack || !haystack.includes(needle)) continue;
    candidates.push(task);
    count += 1;
  }
  return count;
}

function dedupeTaskCandidates(tasks) {
  const out = [];
  const seen = new Set();
  for (const task of tasks || []) {
    const key = taskSearchId(task) || `${taskSearchTitle(task)}:${taskSearchTime(task)}`;
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(task);
  }
  return out;
}

async function findCookieTaskCandidatesByContent(title, projectId, { maxPages = 3 } = {}) {
  const candidates = [];
  if (!projectId || !tbCookie()) return candidates;
  const pid = encodeURIComponent(projectId);
  for (const path of [
    `/api/projects/${pid}/tasks?count=500`,
    `/api/projects/${pid}/tasks?count=500&isDone=false`,
    `/api/projects/${pid}/tasks?count=500&isDone=true`,
  ]) {
    try {
      if (pushMatchingTaskCandidates(candidates, await tbGet(path), title)) return candidates;
    } catch {}
  }

  for (const isDone of ["false", "true"]) {
    let pageToken = "";
    for (let page = 0; page < maxPages; page++) {
      let path = `/api/v2/tasks?count=500&_projectId=${pid}&isDone=${isDone}`;
      if (pageToken) path += `&pageToken=${encodeURIComponent(pageToken)}`;
      let data;
      try { data = await tbGet(path); } catch { break; }
      if (pushMatchingTaskCandidates(candidates, data, title)) return candidates;
      pageToken = taskSearchNextPageToken(data);
      if (!pageToken) break;
    }
  }
  return candidates;
}

async function listCookieTaskSearchCandidates(projectId, { maxPages = 3, includeCoverage = false } = {}) {
  const candidates = [];
  const coverage = { pending: false, completed: false };
  const output = () => includeCoverage ? { tasks: candidates, coverage } : candidates;
  if (!projectId || !tbCookie()) return output();
  const pid = encodeURIComponent(projectId);
  for (const item of [
    { path: `/api/projects/${pid}/tasks?count=500`, state: "" },
    { path: `/api/projects/${pid}/tasks?count=500&isDone=false`, state: "pending" },
    { path: `/api/projects/${pid}/tasks?count=500&isDone=true`, state: "completed" },
  ]) {
    try {
      const tasks = taskSearchList(await tbGet(item.path));
      candidates.push(...tasks);
      // 该端点没有分页游标；少于请求上限时才能证明对应完成状态已完整读取。
      if (item.state && tasks.length < 500) coverage[item.state] = true;
    } catch {}
  }

  for (const isDone of ["false", "true"]) {
    const state = isDone === "true" ? "completed" : "pending";
    let pageToken = "";
    let complete = false;
    for (let page = 0; page < maxPages; page++) {
      let path = `/api/v2/tasks?count=500&_projectId=${pid}&isDone=${isDone}`;
      if (pageToken) path += `&pageToken=${encodeURIComponent(pageToken)}`;
      let data;
      try { data = await tbGet(path); } catch { break; }
      const tasks = taskSearchList(data);
      candidates.push(...tasks);
      pageToken = taskSearchNextPageToken(data);
      if (!pageToken || !tasks.length) {
        complete = true;
        break;
      }
    }
    if (complete) coverage[state] = true;
  }
  return output();
}

async function findCookieTaskCandidatesBySourceId(sourceId, projectId, { maxPages = 3 } = {}) {
  const candidates = [];
  if (!projectId || !tbCookie()) return candidates;
  const pid = encodeURIComponent(projectId);
  for (const path of [
    `/api/projects/${pid}/tasks?count=500`,
    `/api/projects/${pid}/tasks?count=500&isDone=false`,
    `/api/projects/${pid}/tasks?count=500&isDone=true`,
  ]) {
    try {
      pushMatchingSourceCandidates(candidates, await tbGet(path), sourceId);
    } catch {}
  }

  for (const isDone of ["false", "true"]) {
    let pageToken = "";
    for (let page = 0; page < maxPages; page++) {
      let path = `/api/v2/tasks?count=500&_projectId=${pid}&isDone=${isDone}`;
      if (pageToken) path += `&pageToken=${encodeURIComponent(pageToken)}`;
      let data;
      try { data = await tbGet(path); } catch { break; }
      pushMatchingSourceCandidates(candidates, data, sourceId);
      pageToken = taskSearchNextPageToken(data);
      if (!pageToken) break;
    }
  }
  return candidates;
}

export async function findTeambitionTaskByContent(content, { projectId = "", pageSize = 200, maxPages = 3 } = {}) {
  const title = normalizeTaskSearchTitle(content);
  if (!title) return null;
  const projectIds = uniqueStrings([
    projectId,
    ...(projectId ? [] : await getOrgProjectIds()),
  ]);
  const candidates = [];
  for (const pid of projectIds) {
    for (const isDone of ["false", "true"]) {
      let pageToken = null;
      for (let page = 0; page < maxPages; page++) {
        let path = `/api/task/query?pageSize=${Math.max(1, Math.min(Number(pageSize) || 200, 200))}&isDone=${isDone}`;
        if (pid) path += `&projectId=${encodeURIComponent(pid)}`;
        if (pageToken) path += `&pageToken=${encodeURIComponent(pageToken)}`;
        try {
          const data = await tbAPI("GET", path);
          const tasks = taskSearchList(data);
          pushMatchingTaskCandidates(candidates, data, title);
          pageToken = taskSearchNextPageToken(data);
          if (!pageToken || !tasks.length) break;
        } catch {
          break;
        }
      }
    }
    if (!candidates.length) {
      candidates.push(...await findCookieTaskCandidatesByContent(title, pid, { maxPages }));
    }
  }
  const uniqueCandidates = dedupeTaskCandidates(candidates);
  uniqueCandidates.sort((a, b) => taskSearchTime(b).localeCompare(taskSearchTime(a)));
  return uniqueCandidates[0] || null;
}

export async function findTeambitionTaskBySourceId(sourceId, { projectId = "", pageSize = 200, maxPages = 3 } = {}) {
  const matches = await findTeambitionTasksBySourceId(sourceId, { projectId, pageSize, maxPages });
  return matches[0] || null;
}

export async function findTeambitionTasksBySourceId(sourceId, { projectId = "", pageSize = 200, maxPages = 3 } = {}) {
  const normalizedSourceId = normalizeTaskSourceSearch(sourceId);
  if (!normalizedSourceId) return [];
  const projectIds = uniqueStrings([
    projectId,
    ...(projectId ? [] : await getOrgProjectIds()),
  ]);
  const candidates = [];
  for (const pid of projectIds) {
    for (const isDone of ["false", "true"]) {
      let pageToken = null;
      for (let page = 0; page < maxPages; page++) {
        let path = `/api/task/query?pageSize=${Math.max(1, Math.min(Number(pageSize) || 200, 200))}&isDone=${isDone}`;
        if (pid) path += `&projectId=${encodeURIComponent(pid)}`;
        if (pageToken) path += `&pageToken=${encodeURIComponent(pageToken)}`;
        try {
          const data = await tbAPI("GET", path);
          const tasks = taskSearchList(data);
          pushMatchingSourceCandidates(candidates, data, normalizedSourceId);
          pageToken = taskSearchNextPageToken(data);
          if (!pageToken || !tasks.length) break;
        } catch {
          break;
        }
      }
    }
    candidates.push(...await findCookieTaskCandidatesBySourceId(normalizedSourceId, pid, { maxPages }));
  }
  const uniqueCandidates = dedupeTaskCandidates(candidates);
  uniqueCandidates.sort((a, b) => taskSearchTime(b).localeCompare(taskSearchTime(a)));
  return uniqueCandidates.map(taskCandidateView);
}

async function collectTaskSearchCandidates({ projectId = "", pageSize = 200, maxPages = 3 } = {}) {
  const projectIds = uniqueStrings([
    projectId,
    ...(projectId ? [] : await getOrgProjectIds()),
  ]);
  const candidates = [];
  for (const pid of projectIds) {
    for (const isDone of ["false", "true"]) {
      let pageToken = null;
      for (let page = 0; page < maxPages; page++) {
        let path = `/api/task/query?pageSize=${Math.max(1, Math.min(Number(pageSize) || 200, 200))}&isDone=${isDone}`;
        if (pid) path += `&projectId=${encodeURIComponent(pid)}`;
        if (pageToken) path += `&pageToken=${encodeURIComponent(pageToken)}`;
        try {
          const data = await tbAPI("GET", path);
          const tasks = taskSearchList(data);
          candidates.push(...tasks);
          pageToken = taskSearchNextPageToken(data);
          if (!pageToken || !tasks.length) break;
        } catch {
          break;
        }
      }
    }
    candidates.push(...await listCookieTaskSearchCandidates(pid, { maxPages }));
  }
  return dedupeTaskCandidates(candidates);
}

export function createTeambitionTaskSearchSession({ pageSize = 200, maxPages = 3 } = {}) {
  const cache = new Map();

  async function candidatesFor({ projectId = "" } = {}) {
    const key = `${String(projectId || "").trim()}|${Math.max(1, Math.min(Number(pageSize) || 200, 200))}|${Math.max(1, Number(maxPages) || 3)}`;
    if (!cache.has(key)) {
      cache.set(key, collectTaskSearchCandidates({ projectId, pageSize, maxPages }));
    }
    return cache.get(key);
  }

  function newestFirst(rows) {
    const out = dedupeTaskCandidates(rows);
    out.sort((a, b) => taskSearchTime(b).localeCompare(taskSearchTime(a)));
    return out;
  }

  return {
    async findByContent(content, options = {}) {
      const title = normalizeTaskSearchTitle(content);
      if (!title) return null;
      const rows = await candidatesFor(options);
      return newestFirst(rows.filter((task) => taskSearchTitle(task) === title))[0] || null;
    },
    async findBySourceId(sourceId, options = {}) {
      const normalizedSourceId = normalizeTaskSourceSearch(sourceId);
      if (!normalizedSourceId) return null;
      const needle = normalizeTaskSourceSearch(`Source ID:${normalizedSourceId}`);
      const rows = await candidatesFor(options);
      return newestFirst(rows.filter((task) => normalizeTaskSourceSearch(taskSearchSourceText(task)).includes(needle)))[0] || null;
    },
    async findAllBySourceId(sourceId, options = {}) {
      const normalizedSourceId = normalizeTaskSourceSearch(sourceId);
      if (!normalizedSourceId) return [];
      const needle = normalizeTaskSourceSearch(`Source ID:${normalizedSourceId}`);
      const rows = await candidatesFor(options);
      return newestFirst(rows.filter((task) => normalizeTaskSourceSearch(taskSearchSourceText(task)).includes(needle))).map(taskCandidateView);
    },
    async findAllByTextToken(token, options = {}) {
      const normalizedToken = normalizeTaskSourceSearch(token);
      if (!normalizedToken) return [];
      const rows = await candidatesFor(options);
      return newestFirst(rows.filter((task) => normalizeTaskSourceSearch(taskSearchFullText(task)).includes(normalizedToken))).map(taskCandidateView);
    },
    clear() {
      cache.clear();
    },
  };
}

/**
 * 查询分配给指定执行者的未完成任务
 */
async function queryMyTasksDetailed(executorId, projectIds = []) {
  const allTasks = [];
  const failures = [];
  // 必须按项目查询，否则会因跨组织项目权限报错
  const queryProjects = projectIds.length > 0 ? projectIds : await getOrgProjectIds();

  for (const pid of queryProjects) {
    for (const isDone of ["false", "true"]) {
      let pageToken = null;
      let complete = false;
      let failed = false;
      for (let page = 0; page < 20; page++) {
        let path = `/api/task/query?pageSize=100&isDone=${isDone}&projectId=${pid}`;
        if (executorId) path += `&executorId=${executorId}`;
        if (pageToken) path += `&pageToken=${pageToken}`;
        try {
          const data = await tbAPI("GET", path);
          const tasks = data.result || [];
          allTasks.push(...tasks);
          pageToken = data.nextPageToken;
          if (!pageToken || tasks.length === 0) {
            complete = true;
            break;
          }
        } catch (error) {
          failures.push({ projectId: String(pid), isDone, error: String(error?.message || error) });
          failed = true;
          break;
        }
      }
      if (!complete && !failed) failures.push({ projectId: String(pid), isDone, error: "分页超过安全上限" });
    }
  }
  return { tasks: allTasks, failures };
}

export async function getMyTasks(executorId, projectIds = []) {
  const { tasks, failures } = await queryMyTasksDetailed(executorId, projectIds);
  // OpenAPI 未配置/失败（AppId/AppSecret 缺失）时用 Cookie 通道兜底拉任务列表：
  // 与 getMyActiveTasks 的 fallback 策略一致，避免"扫描到 0 个任务"。
  if ((tasks.length === 0 || failures.length > 0) && tbCookie()) {
    try {
      const queryProjects = projectIds.length > 0 ? projectIds : await getOrgProjectIds();
      const cookieTasks = [];
      for (const pid of queryProjects) {
        const list = await getCookieProjectTasks(pid, executorId);
        for (const t of list) {
          const id = t?._id || t?.taskId || t?.id;
          if (id) cookieTasks.push(t);
        }
      }
      if (cookieTasks.length > 0) return cookieTasks;
    } catch (error) {
      log("system", "warn", "teambition", `getMyTasks cookie 兜底失败: ${error?.message || error}`);
    }
  }
  return tasks;
}

const TEAMBITION_OBJECT_ID_RE = /^[0-9a-f]{24}$/i;

function normalizeTeambitionObjectId(value) {
  const id = String(value || "").trim();
  return TEAMBITION_OBJECT_ID_RE.test(id) ? id.toLowerCase() : "";
}

function canonicalTrainingSource(source = {}) {
  const type = String(source.type || "").trim().toLowerCase();
  const projectId = normalizeTeambitionObjectId(source.projectId);
  if (!projectId || !["sprint", "tasklist"].includes(type)) return null;
  if (type === "sprint") {
    const sprintId = normalizeTeambitionObjectId(source.sprintId || source.sectionId);
    if (!sprintId) return null;
    return {
      type,
      projectId,
      sprintId,
      sectionId: sprintId,
      tasklistId: "",
      name: String(source.name || "").trim(),
      url: `https://www.teambition.com/project/${projectId}/sprint/section/${sprintId}`,
    };
  }
  const tasklistId = normalizeTeambitionObjectId(source.tasklistId || source.sectionId);
  if (!tasklistId) return null;
  return {
    type,
    projectId,
    sprintId: "",
    sectionId: tasklistId,
    tasklistId,
    name: String(source.name || "").trim(),
    url: `https://www.teambition.com/project/${projectId}/tasks/scrum/field/${tasklistId}`,
  };
}

/**
 * 解析 AI 训练使用的 Teambition 列表 URL。只接受 Teambition 域名和固定路径，
 * 后续请求仅使用解析出的 ObjectId 重新构造 URL，避免把用户输入当作任意远程地址访问。
 */
export function parseTeambitionTrainingSourceUrl(value = "") {
  const raw = String(value || "").trim();
  if (!raw) throw new Error("请输入 Teambition 迭代或任务列表 URL");
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error("Teambition 列表 URL 格式不正确");
  }
  if (!["http:", "https:"].includes(parsed.protocol)) throw new Error("Teambition 列表 URL 仅支持 HTTP/HTTPS");
  const hostname = parsed.hostname.toLowerCase().replace(/\.$/, "");
  if (hostname !== "teambition.com" && !hostname.endsWith(".teambition.com")) {
    throw new Error("列表 URL 必须属于 teambition.com");
  }
  const sprintMatch = parsed.pathname.match(/^\/project\/([0-9a-f]{24})\/sprint\/section\/([0-9a-f]{24})\/?$/i);
  if (sprintMatch) {
    return canonicalTrainingSource({ type: "sprint", projectId: sprintMatch[1], sprintId: sprintMatch[2] });
  }
  const tasklistMatch = parsed.pathname.match(/^\/project\/([0-9a-f]{24})\/tasks\/scrum\/field\/([0-9a-f]{24})\/?$/i);
  if (tasklistMatch) {
    return canonicalTrainingSource({ type: "tasklist", projectId: tasklistMatch[1], tasklistId: tasklistMatch[2] });
  }
  throw new Error("仅支持 Teambition 迭代或任务列表 URL，且项目 ID、列表 ID 必须为 24 位十六进制");
}

function trainingTaskProjectId(task = {}) {
  return String(task._projectId || task.projectId || task.project?._id || task.project?.id || "").trim();
}

function trainingTaskSprintId(task = {}) {
  return String(task._sprintId || task.sprintId || task.sprint?._id || task.sprint?.sprintId || task.sprint?.id || "").trim();
}

function trainingTaskTasklistId(task = {}) {
  return String(task._tasklistId || task.tasklistId || task.tasklist?._id || task.tasklist?.tasklistId || task.tasklist?.id || "").trim();
}

function trainingTaskDone(task = {}) {
  const value = task.isDone ?? task.done ?? task.completed;
  if (value === true || value === 1) return true;
  return /^(?:1|true)$/i.test(String(value ?? "").trim());
}

function trainingTaskStatusId(task = {}) {
  return String(task.taskflowstatus?._id || task.taskflowstatus?.id || task._taskflowstatusId || task.taskflowstatusId || "").trim();
}

function trainingTaskStatusKey(task = {}) {
  const statusId = String(task.statusId || trainingTaskStatusId(task) || "").trim();
  if (statusId) return statusId;
  const statusName = String(task.statusName || task.taskflowstatus?.name || "").trim();
  return statusName ? `name:${statusName.toLowerCase()}` : "__unknown__";
}

function normalizedTrainingTask(task, source) {
  const tbTaskId = String(task?._id || task?.taskId || task?.id || task?.objectId || "").trim();
  if (!tbTaskId) return null;
  const title = String(task.content || task.title || task.name || "(无标题)").trim() || "(无标题)";
  const sprintId = trainingTaskSprintId(task) || (source.type === "sprint" ? source.sprintId : "");
  const tasklistId = trainingTaskTasklistId(task) || (source.type === "tasklist" ? source.tasklistId : "");
  const statusId = trainingTaskStatusId(task);
  const statusName = String(task.taskflowstatus?.name || task.statusName || (typeof task.status === "string" ? task.status : "") || "").trim();
  return {
    tbTaskId,
    title,
    ticketUrl: `https://www.teambition.com/task/${encodeURIComponent(tbTaskId)}`,
    projectId: source.projectId,
    projectName: String(task.project?.name || task.projectName || "").trim(),
    tasklistId,
    tasklistName: String(task.tasklist?.title || task.tasklist?.name || task.tasklistName || "").trim(),
    sprintId,
    sprintName: String(task.sprint?.name || task.sprint?.title || task.sprintName || "").trim(),
    done: trainingTaskDone(task),
    statusId,
    statusName,
    statusKey: statusId || (statusName ? `name:${statusName.toLowerCase()}` : "__unknown__"),
    priority: task.priority ?? null,
    deadline: dateOnly(task.dueDate),
  };
}

async function enrichTrainingTaskStatuses(tasks, projectId) {
  if (!tbCookie() || !Array.isArray(tasks) || !tasks.length) return tasks;
  let statusNames = {};
  try {
    statusNames = { ...(await buildProjectStatusIndex(projectId)).flat };
  } catch {}

  const unresolved = new Map();
  for (const task of tasks) {
    const statusId = String(task.statusId || "").trim();
    if (statusId && !task.statusName && !statusNames[statusId] && !unresolved.has(statusId)) {
      unresolved.set(statusId, task.tbTaskId);
    }
  }
  // 项目工作流索引可能不含历史/归档工作流。每个未知状态只读取一条任务详情，
  // 既补全“关闭/可提测”等真实名称，又避免按 42 条任务逐条请求。
  await Promise.all([...unresolved.entries()].map(async ([statusId, tbTaskId]) => {
    try {
      const detail = await cookieTaskDetail(tbTaskId);
      const detailStatusId = String(detail?.taskflowstatus?._id || detail?._taskflowstatusId || statusId).trim();
      const detailStatusName = String(detail?.taskflowstatus?.name || detail?.statusName || "").trim();
      if (detailStatusId && detailStatusName) statusNames[detailStatusId] = detailStatusName;
      if (statusId && detailStatusName) statusNames[statusId] = detailStatusName;
    } catch {}
  }));

  return tasks.map((task) => {
    const statusName = task.statusName || statusNames[task.statusId] || "";
    return {
      ...task,
      statusName,
      statusKey: trainingTaskStatusKey({ ...task, statusName }),
    };
  });
}

function summarizeTrainingTaskStatuses(tasks = []) {
  const rows = new Map();
  for (const task of tasks) {
    const key = trainingTaskStatusKey(task);
    const current = rows.get(key) || {
      key,
      id: String(task.statusId || "").trim(),
      name: String(task.statusName || "").trim() || "未标注状态",
      count: 0,
      pending: 0,
      completed: 0,
    };
    current.count += 1;
    current[task.done ? "completed" : "pending"] += 1;
    rows.set(key, current);
  }
  return [...rows.values()].sort((left, right) => right.count - left.count || left.name.localeCompare(right.name, "zh-CN"));
}

async function listCookieTrainingSourceCandidates(source, { maxPages = 100 } = {}) {
  if (!tbCookie()) {
    return { tasks: [], complete: false, pages: 0, totalSize: null, error: "未配置 TB Cookie" };
  }
  const field = source.type === "sprint" ? "sprintId" : "tasklistId";
  const sourceId = source.type === "sprint" ? source.sprintId : source.tasklistId;
  // 这是 Teambition 列表页自身使用的来源级 TQL 查询。与项目级 /tasks?count=500
  // 不同，它返回 totalSize + nextPageToken，因此可以证明指定迭代/任务列表是否读完整。
  const filter = `(${field} = ${sourceId}) ORDER BY isDone ASC, created ASC`;
  const tasks = [];
  let pageToken = "";
  let totalSize = null;
  for (let page = 0; page < maxPages; page++) {
    const params = new URLSearchParams({
      filter,
      includesAnotherProjectTask: "false",
      pageToken,
      pageSize: "40",
    });
    let data;
    try {
      data = await tbGet(`/api/v2/projects/${encodeURIComponent(source.projectId)}/tasks?${params.toString()}`);
    } catch (error) {
      return { tasks, complete: false, pages: page, totalSize, error: String(error?.message || error) };
    }
    const rows = taskSearchList(data);
    tasks.push(...rows);
    const reported = Number(data?.totalSize ?? data?.result?.totalSize);
    if (Number.isFinite(reported) && reported >= 0) totalSize = Math.max(totalSize ?? 0, Math.trunc(reported));
    pageToken = taskSearchNextPageToken(data);
    if (!pageToken) {
      const unique = dedupeTaskCandidates(tasks);
      // “没有下一页”只能证明服务端停止了分页，不能证明返回了来源中的全部任务。
      // 用户输入的训练列表必须有来源级 totalSize 才能做完整性校验；上游若省略
      // totalSize 就 fail closed，避免再次把一个成功返回的小子集当成完整列表。
      const complete = totalSize !== null && unique.length === totalSize;
      return {
        tasks: unique,
        complete,
        pages: page + 1,
        totalSize,
        error: complete
          ? ""
          : totalSize === null
            ? `Teambition 来源响应缺少 totalSize，无法证明 ${unique.length} 条为完整列表`
            : `Teambition 报告 ${totalSize} 条，实际仅读取 ${unique.length} 条`,
      };
    }
  }
  return {
    tasks: dedupeTaskCandidates(tasks),
    complete: false,
    pages: maxPages,
    totalSize,
    error: `Teambition 列表分页超过安全上限 ${maxPages}`,
  };
}

function mergeNormalizedTrainingTask(previous, next) {
  if (!previous) return next;
  const merged = { ...previous };
  for (const [key, value] of Object.entries(next || {})) {
    if (value !== "" && value !== null && value !== undefined) merged[key] = value;
  }
  merged.done = !!(previous.done || next?.done);
  return merged;
}

/**
 * 从项目全量任务中过滤指定 sprint/tasklist，并输出不含 raw 的稳定训练任务结构。
 */
export function filterTeambitionTrainingSourceTasks(tasks = [], sourceInput = {}) {
  const source = canonicalTrainingSource(sourceInput);
  if (!source) return [];
  const byId = new Map();
  for (const task of Array.isArray(tasks) ? tasks : []) {
    if (!task || typeof task !== "object") continue;
    const taskProjectId = trainingTaskProjectId(task);
    // 列表来源是项目级安全边界；缺少项目身份的任务不允许仅凭同名 section/tasklist 混入。
    if (!taskProjectId || taskProjectId.toLowerCase() !== source.projectId) continue;
    const matches = source.type === "sprint"
      ? trainingTaskSprintId(task).toLowerCase() === source.sprintId
      : trainingTaskTasklistId(task).toLowerCase() === source.tasklistId;
    if (!matches) continue;
    const normalized = normalizedTrainingTask(task, source);
    if (!normalized) continue;
    const key = normalized.tbTaskId.toLowerCase();
    byId.set(key, mergeNormalizedTrainingTask(byId.get(key), normalized));
  }
  return [...byId.values()];
}

/**
 * 读取指定训练来源中的全部 TB 单。OpenAPI 会同时查询完成/未完成；只要本机有用户
 * Cookie 就同时读取 Web API 并合并，因为 OpenAPI 即使成功也可能只返回当前可见子集。
 * 这里不按 taskflow 状态过滤，“关闭/可提测”等状态必须保留在原始来源列表中。
 */
export async function listTeambitionTrainingSourceTasks(sourceInput = {}) {
  const source = canonicalTrainingSource(sourceInput);
  if (!source) throw new Error("无效的 Teambition 训练来源");
  const openApiResult = await queryMyTasksDetailed("", [source.projectId]);
  const openApiTasks = filterTeambitionTrainingSourceTasks(openApiResult.tasks, source);
  if (!tbCookie()) {
    throw new Error("Teambition 任务列表读取不完整：用户输入列表必须通过 TB Cookie 读取来源级总数，请先完成 TB 登录绑定");
  }
  const cookieResult = await listCookieTrainingSourceCandidates(source);
  if (!cookieResult.complete) {
    throw new Error(`Teambition 任务列表读取不完整：${cookieResult.error || "来源级分页未完成"}，请检查 Cookie 登录状态后重试`);
  }
  const cookieTasks = filterTeambitionTrainingSourceTasks(cookieResult.tasks, source);
  if (cookieTasks.length !== cookieResult.tasks.length
    || (cookieResult.totalSize !== null && cookieTasks.length !== cookieResult.totalSize)) {
    throw new Error(`Teambition 任务列表读取不完整：来源报告 ${cookieResult.totalSize ?? cookieResult.tasks.length} 条，严格项目/列表边界匹配 ${cookieTasks.length} 条，禁止使用不一致子集训练`);
  }
  // 来源级 Cookie 查询带 totalSize 和完整分页，是训练列表的权威集合；OpenAPI 只用于
  // 显示交叉核对数量，不再把其权限子集或陈旧额外记录混入权威列表。
  let tasks = cookieTasks;
  const fetchSource = "open-api+cookie-source";

  let info = null;
  if (source.type === "sprint") info = await getProjectSprint(source.sprintId, source.projectId);
  else info = await getProjectTasklist(source.tasklistId, source.projectId);
  if (info?.projectId && info.projectId.toLowerCase() !== source.projectId) {
    throw new Error("Teambition 列表不属于 URL 中指定的项目");
  }
  if (!tasks.length && !info) {
    throw new Error("Teambition 列表不存在或不属于 URL 中指定的项目");
  }
  const inferredName = source.type === "sprint"
    ? tasks.find((task) => task.sprintName)?.sprintName
    : tasks.find((task) => task.tasklistName)?.tasklistName;
  source.name = String(info?.name || inferredName || `${source.type === "sprint" ? "迭代" : "任务列表"} ${source.sectionId}`).trim();
  if (source.type === "sprint") {
    source.status = String(info?.status || "").trim();
    source.startDate = String(info?.startDate || "").trim();
    source.dueDate = String(info?.dueDate || "").trim();
    tasks = tasks.map((task) => ({ ...task, sprintName: task.sprintName || source.name }));
  } else {
    tasks = tasks.map((task) => ({ ...task, tasklistName: task.tasklistName || source.name }));
  }
  tasks = await enrichTrainingTaskStatuses(tasks, source.projectId);
  const completed = tasks.filter((task) => task.done).length;
  return {
    source: { ...source, fetchSource },
    tasks,
    counts: {
      all: tasks.length,
      pending: tasks.length - completed,
      completed,
    },
    statusCounts: summarizeTrainingTaskStatuses(tasks),
    acquisition: {
      fetchSource,
      openApiMatched: openApiTasks.length,
      cookieMatched: cookieTasks.length,
      mergedMatched: tasks.length,
      completionStates: ["pending", "completed"],
      taskflowStatusFilter: "none",
      cookieComplete: true,
      cookiePages: cookieResult.pages,
      cookieReportedTotal: cookieResult.totalSize,
      openApiFailures: openApiResult.failures.length,
    },
  };
}

// 目标工单状态（待处理/开发中/进行中 及常见同义写法）
const ACTIVE_STATUS_KEYWORDS = ["待处理", "开发中", "进行中", "处理中", "待开发", "开发", "进行"];

// ===== TB taskflow 状态（Cookie web API；端点据真实浏览器抓包）=====
// 正确端点（开放平台不暴露状态名/列表）：
//   取某 taskflow 全部状态：GET /api/taskflows/{taskflowId}/taskflowstatus  → { result:[{_id,name,...}] }（单数）
//   改任务状态：           PUT /api/tasks/{id}/taskflowstatus  body {_taskflowstatusId, sfcRequiredValidateEnable, persistentValidatorEnable, disableRequiredCfIds}
// 一个项目常有多个 taskflow，同名状态在不同 taskflow 下 id 不同，故解析须限定到任务所属 taskflow。
function tbCookie() { return getConfig().teambition?.userCookie || ""; }
async function cookieGetJson(url) {
  const cookie = tbCookie();
  if (!cookie) throw new Error("未配置 TB Cookie（请在设置里一键登录）");
  const r = await fetch(url, { headers: { Cookie: cookie } });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}
// 任务详情（cookie，含完整 taskflowstatus{_id,name,_taskflowId}）
async function cookieTaskDetail(tbTaskId) {
  return cookieGetJson(`https://www.teambition.com/api/tasks/${encodeURIComponent(tbTaskId)}`);
}

function tbArray(data) {
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.result)) return data.result;
  if (Array.isArray(data?.tasks)) return data.tasks;
  return [];
}

function dateOnly(v) {
  return v ? String(v).slice(0, 10) : null;
}

// 某 taskflow 的全部状态 [{id,name}]，缓存 5 分钟
const _tfStatusCache = new Map();
async function getTaskflowStatuses(taskflowId, force = false) {
  if (!taskflowId) return [];
  const c = _tfStatusCache.get(taskflowId);
  if (!force && c && Date.now() - c.at < 300000) return c.statuses;
  let statuses = [];
  try {
    const d = await cookieGetJson(`https://www.teambition.com/api/taskflows/${encodeURIComponent(taskflowId)}/taskflowstatus`);
    const arr = d.result || (Array.isArray(d) ? d : []);
    statuses = arr.map((s) => ({ id: s._id || s.id, name: s.name, pos: s.pos || 0, allowFromAny: !!s.payload?.allowFromAny })).filter((s) => s.id && s.name);
  } catch (e) { log("system", "warn", "teambition", `取 taskflow ${taskflowId} 状态失败: ${e.message}`); }
  _tfStatusCache.set(taskflowId, { at: Date.now(), statuses });
  return statuses;
}

// 项目状态索引缓存：pid -> { at, data:{ byTaskflow:{tfid:[{id,name}]}, flat:{id:name}, names:[去重名] } }
// 项目的 taskflow 来源：① /projects/{pid}/taskflows（新建/风险等）② 采样任务详情拿其实际 taskflow（覆盖旧默认工作流）。
const _statusIndexCache = new Map();
async function buildProjectStatusIndex(projectId, force = false) {
  if (!projectId) return { byTaskflow: {}, flat: {}, names: [] };
  const cached = _statusIndexCache.get(projectId);
  if (!force && cached && Date.now() - cached.at < 300000) return cached.data;
  const tfIds = new Set();
  try {
    const d = await cookieGetJson(`https://www.teambition.com/api/projects/${projectId}/taskflows`);
    for (const tf of (d.result || (Array.isArray(d) ? d : []))) if (tf._id) tfIds.add(tf._id);
  } catch {}
  try {
    const tasks = await cookieGetJson(`https://www.teambition.com/api/projects/${projectId}/tasks?count=60`);
    const seen = new Map();
    for (const t of (Array.isArray(tasks) ? tasks : [])) { const s = t._taskflowstatusId; if (s && !seen.has(s)) seen.set(s, t._id); }
    let n = 0;
    for (const [, tid] of seen) { if (n++ >= 12) break; try { const d = await cookieTaskDetail(tid); const tf = d.taskflowstatus?._taskflowId; if (tf) tfIds.add(tf); } catch {} }
  } catch (e) { log("system", "warn", "teambition", `采样项目 ${projectId} taskflow 失败: ${e.message}`); }

  const byTaskflow = {}, flat = {};
  for (const tfid of tfIds) {
    const statuses = await getTaskflowStatuses(tfid);
    byTaskflow[tfid] = statuses;
    for (const s of statuses) flat[s.id] = s.name;
  }
  const names = [...new Set(Object.values(flat))];
  const data = { byTaskflow, flat, names };
  _statusIndexCache.set(projectId, { at: Date.now(), data });
  return data;
}

// 迭代(sprint)信息缓存：sprintId -> { name, dueDate, status } | null（解析失败也缓存 null，避免重复请求）
const _sprintCache = new Map();
async function getSprintInfo(sprintId) {
  if (!sprintId) return null;
  if (_sprintCache.has(sprintId)) return _sprintCache.get(sprintId);
  let info = null;
  try {
    const d = await tbAPI("GET", `/api/sprint/info?sprintId=${encodeURIComponent(sprintId)}`);
    const s = d.result || d.data || d;
    if (s && (s.name || s.sprintId)) {
      info = {
        name: s.name || "",
        dueDate: s.dueDate ? String(s.dueDate).slice(0, 10) : null,
        status: s.status || "",
      };
    }
  } catch { info = null; }
  if (!info) info = await getSprintInfoFromCookie(sprintId);
  _sprintCache.set(sprintId, info);
  return info;
}

async function getSprintInfoFromCookie(sprintId) {
  if (!sprintId || !tbCookie()) return null;
  for (const pid of getTbProjectIds()) {
    try {
      const d = await cookieGetJson(`https://www.teambition.com/api/projects/${encodeURIComponent(pid)}/sprints`);
      const hit = tbArray(d).find((s) => String(s._id || s.id || s.sprintId || "") === String(sprintId));
      if (hit) {
        return {
          name: hit.name || hit.title || "",
          dueDate: dateOnly(hit.dueDate),
          status: hit.status || "",
        };
      }
    } catch {}
  }
  return null;
}

function toSyncTask(t, statusMap = {}) {
  const tbTaskId = t?._id || t?.taskId || t?.id;
  if (!tbTaskId) return null;
  const title = t.content || t.title || "(无标题)";
  const statusName = statusMap[t._taskflowstatusId] || statusMap[t.tfsId] || statusMap[t.stageId] || statusMap[t._stageId]
    || t.taskflowstatus?.name || t.tfs?.name || "";
  return {
    tbTaskId,
    carbId: t.uniqueId ? `CARB-${t.uniqueId}` : (String(title).match(/CARB-\d+/i)?.[0] || null),
    title,
    ticketUrl: `https://www.teambition.com/task/${tbTaskId}`,
    statusName,
    priority: t.priority,
    deadline: dateOnly(t.dueDate),
    sprintId: t.sprintId || t._sprintId || t.sprint?._id || t.sprint?.sprintId || null,
    projectId: t._projectId || t.projectId || t.project?._id || t.project?.id || null,
    projectName: t.project?.name || t.projectName || null,
    tasklistId: t._tasklistId || t.tasklistId || t.tasklist?._id || t.tasklist?.id || null,
    tasklistName: t.tasklist?.title || t.tasklist?.name || t.tasklistName || null,
  };
}

function filterActiveTasks(collected, anyStatus) {
  return anyStatus
    ? collected.filter((t) => !t.statusName || ACTIVE_STATUS_KEYWORDS.some((k) => t.statusName.includes(k)))
    : collected;
}

async function finishActiveTasks(collected, anyStatus, source) {
  const filtered = filterActiveTasks(collected, anyStatus);
  const sprintIds = [...new Set(filtered.map((t) => t.sprintId).filter(Boolean))];
  const sprintMap = {};
  for (const sid of sprintIds) {
    const info = await getSprintInfo(sid);
    if (info) sprintMap[sid] = info;
  }
  for (const t of filtered) {
    const info = t.sprintId ? sprintMap[t.sprintId] : null;
    t.sprintName = info?.name || null;
    t.sprintDueDate = info?.dueDate || null;
    t.sprintStatus = info?.status || null;
  }
  return { tasks: filtered, statusResolved: anyStatus, source };
}

async function getCookieProjectTasks(projectId, executorId) {
  const out = [];
  const seen = new Set();
  const push = (items) => {
    for (const t of tbArray(items)) {
      const id = t?._id || t?.taskId || t?.id;
      if (!id || seen.has(id)) continue;
      if (t.isDone === true || t.isArchived === true) continue;
      if (projectId && t._projectId && String(t._projectId) !== String(projectId)) continue;
      if (executorId && t._executorId && String(t._executorId) !== String(executorId)) continue;
      seen.add(id);
      out.push(t);
    }
  };

  const pid = encodeURIComponent(projectId);
  const uid = executorId ? `&_executorId=${encodeURIComponent(executorId)}` : "";
  try {
    push(await cookieGetJson(`https://www.teambition.com/api/projects/${pid}/tasks?count=500&isDone=false${uid}`));
  } catch {}

  let pageToken = "";
  for (let page = 0; page < 20; page++) {
    let url = `https://www.teambition.com/api/v2/tasks?count=500&_projectId=${pid}&isDone=false${uid}`;
    if (pageToken) url += `&pageToken=${encodeURIComponent(pageToken)}`;
    let data;
    try { data = await cookieGetJson(url); } catch { break; }
    push(data);
    pageToken = data?.nextPageToken || "";
    if (!pageToken) break;
  }
  return out;
}

async function getMyActiveTasksByCookie(executorId, projectIds) {
  if (!tbCookie()) throw Object.assign(new Error("Teambition 未登录，请扫码登录后重试"), { needLogin: true });
  const collected = [];
  let anyStatus = false;
  for (const pid of projectIds) {
    const statusMap = (await buildProjectStatusIndex(pid).catch(() => ({ flat: {} }))).flat;
    if (Object.keys(statusMap).length) anyStatus = true;
    const tasks = await getCookieProjectTasks(pid, executorId);
    for (const t of tasks) {
      const item = toSyncTask(t, statusMap);
      if (item) collected.push(item);
    }
  }
  return finishActiveTasks(collected, anyStatus, "cookie");
}

/**
 * 拉取分配给当前用户、状态为「待处理/开发中/进行中」的工单（即未完成任务）。
 * 能解析到 taskflow 状态名时按目标状态过滤；解析不到则退化为"全部未完成"。
 * 返回 { tasks: [{ tbTaskId, title, ticketUrl, statusName, deadline, sprintId, sprintName, sprintDueDate }], statusResolved }。
 */
export async function getMyActiveTasks(executorId, projectIdsOverride = null) {
  const projectIds = Array.isArray(projectIdsOverride) && projectIdsOverride.length
    ? projectIdsOverride
    : await getOrgProjectIds();
  const collected = [];
  let anyStatus = false;
  let openApiFailed = false;

  for (const pid of projectIds) {
    const statusMap = (await buildProjectStatusIndex(pid).catch(() => ({ flat: {} }))).flat; // { 状态id: 名 }
    if (Object.keys(statusMap).length) anyStatus = true;
    let pageToken = null;
    for (let page = 0; page < 20; page++) {
      let path = `/api/task/query?pageSize=100&isDone=false&projectId=${pid}`;
      if (executorId) path += `&executorId=${executorId}`;
      if (pageToken) path += `&pageToken=${pageToken}`;
      let data;
      try { data = await tbAPI("GET", path); } catch { openApiFailed = true; break; }
      const tasks = data.result || [];
      for (const t of tasks) {
        const tbTaskId = t._id || t.taskId || t.id;
        if (!tbTaskId) continue;
        const statusName = statusMap[t.tfsId] || statusMap[t.stageId]
          || t.taskflowstatus?.name || t.tfs?.name || "";
        collected.push({
          tbTaskId,
          carbId: t.uniqueId ? `CARB-${t.uniqueId}` : ((t.content || t.title || "").match(/CARB-\d+/i)?.[0] || null),
          title: t.content || t.title || "(无标题)",
          ticketUrl: `https://www.teambition.com/task/${tbTaskId}`,
          statusName,
          priority: t.priority,
          deadline: t.dueDate ? String(t.dueDate).slice(0, 10) : null,
          // 任务所属迭代 ID（兼容多种字段名），稍后解析成迭代名/结束日期
          sprintId: t.sprintId || t._sprintId || t.sprint?._id || t.sprint?.sprintId || null,
          projectId: t._projectId || t.projectId || t.project?._id || t.project?.id || pid,
          projectName: t.project?.name || t.projectName || null,
          tasklistId: t._tasklistId || t.tasklistId || t.tasklist?._id || t.tasklist?.id || null,
          tasklistName: t.tasklist?.title || t.tasklist?.name || t.tasklistName || null,
        });
      }
      pageToken = data.nextPageToken;
      if (!pageToken || tasks.length === 0) break;
    }
  }

  // 状态名可用时过滤到目标状态（无状态名的未完成任务也保留为兜底）
  if (tbCookie() && (openApiFailed || collected.length === 0)) {
    try {
      const fallback = await getMyActiveTasksByCookie(executorId, projectIds);
      if (fallback.tasks.length > 0 || collected.length === 0) return fallback;
    } catch (e) {
      if (collected.length === 0) throw e;
      log("system", "warn", "teambition", `Cookie 兜底同步 TB 任务失败: ${e.message}`);
    }
  }

  const filtered = anyStatus
    ? collected.filter((t) => !t.statusName || ACTIVE_STATUS_KEYWORDS.some((k) => t.statusName.includes(k)))
    : collected;

  // 解析迭代信息：按唯一 sprintId 逐个查名称/结束日期（带缓存），附到任务上
  const sprintIds = [...new Set(filtered.map((t) => t.sprintId).filter(Boolean))];
  const sprintMap = {};
  for (const sid of sprintIds) {
    const info = await getSprintInfo(sid);
    if (info) sprintMap[sid] = info;
  }
  for (const t of filtered) {
    const info = t.sprintId ? sprintMap[t.sprintId] : null;
    t.sprintName = info?.name || null;
    t.sprintDueDate = info?.dueDate || null;
    t.sprintStatus = info?.status || null; // future-未开始 / active-进行中 / complete-完成
  }
  return { tasks: filtered, statusResolved: anyStatus, source: "open-api" };
}

async function getOrgProjectIds() {
  // 白名单限制：只返回配置的项目
  if (getTbProjectIds().length > 0) return [...getTbProjectIds()];
  try {
    const data = await tbAPI("GET", "/api/v3/project/query?pageSize=50");
    return (data.result || []).map(p => p.id);
  } catch {
    try { return (await listOrgProjects()).map((p) => p.id); } catch { return []; }
  }
}

/**
 * 查询单个 TB 工单当前状态名 + 是否仍处于「待处理/开发中/进行中」。
 * 返回 { ok, statusName, isDone, isActive } 或 { ok:false, error }。
 * isActive=true 表示状态仍属活跃中（不允许在任务列表里标记完成）。
 */
export async function getTaskStatusName(tbTaskId) {
  // 优先 Cookie 详情（含 taskflowstatus.name，最可靠；开放平台任务不带状态名）
  try {
    const d = await cookieTaskDetail(tbTaskId);
    if (d && (d._id || d.id)) {
      if (d.isDone) return { ok: true, statusName: "已完成", isDone: true, isActive: false };
      const name = d.taskflowstatus?.name || "";
      if (name) {
        const isActive = ACTIVE_STATUS_KEYWORDS.some((k) => name.includes(k));
        return { ok: true, statusName: name, isDone: false, isActive };
      }
    }
  } catch {}
  // 回退开放平台
  let detail;
  try { detail = await getTaskDetail(tbTaskId); } catch (e) { return { ok: false, error: e.message }; }
  if (!detail) return { ok: false, error: "未在 Teambition 找到该工单" };
  if (detail.isDone) return { ok: true, statusName: "已完成", isDone: true, isActive: false };
  const statusName = detail.taskflowstatus?.name || detail.tfs?.name || "";
  const isActive = statusName ? ACTIVE_STATUS_KEYWORDS.some((k) => statusName.includes(k)) : false;
  return { ok: true, statusName: statusName || "(未知状态)", isDone: false, isActive };
}

/**
 * 获取任务详情
 */
export async function getTaskDetail(taskId) {
  let detail = null;
  // 1. 开放平台直查
  try {
    const d = await tbAPI("GET", `/api/task/query?taskId=${taskId}`);
    if (d.result?.[0]) detail = d.result[0];
  } catch {}

  // 2. 开放平台按项目搜索
  if (!detail) {
    const projectIds = await getOrgProjectIds();
    for (const pid of projectIds) {
      try {
        const d = await tbAPI("GET", `/api/task/query?projectId=${pid}&pageSize=100&isDone=false`);
        const found = (d.result || []).find(t => t.taskId === taskId);
        if (found) {
          detail = found;
          break;
        }
        const d2 = await tbAPI("GET", `/api/task/query?projectId=${pid}&pageSize=100&isDone=true`);
        const found2 = (d2.result || []).find(t => t.taskId === taskId);
        if (found2) {
          detail = found2;
          break;
        }
      } catch {}
    }
  }

  // 3. Cookie 搜索 API 兜底（转载任务 _id 和 taskId 不同时）
  const config = getConfig();
  const cookie = config.teambition?.userCookie;
  if (cookie && (!detail || !hasTaskCustomFieldData(detail))) {
    try {
      const resp = await fetch(`https://www.teambition.com/api/tasks/${taskId}`, { headers: { Cookie: cookie } });
      if (resp.ok) {
        const task = await resp.json();
        if (task._id) {
          detail = mergeTaskDetail(detail, normalizeCookieTaskDetail(task));
        }
      }
    } catch {}
  }

  return await ensureTaskCustomFields(detail, taskId);
}

const TASK_CUSTOM_FIELD_KEYS = [
  "customfields",
  "customFields",
  "custom_fields",
  "customFieldValues",
  "customfieldValues",
  "custom_field_values",
  "customFieldsValues",
  "customfieldsValues",
  "fieldValues",
  "field_values",
  "scenariofields",
  "scenarioFields",
  "scenario_fields",
  "scenariofieldvalues",
  "scenarioFieldValues",
  "scenario_field_values",
];

function hasTaskDetailValue(value) {
  if (value === undefined || value === null || value === "") return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") return Object.keys(value).length > 0;
  return true;
}

function hasTaskCustomFieldData(task = {}) {
  return TASK_CUSTOM_FIELD_KEYS.some((key) => hasTaskDetailValue(task?.[key]));
}

function copyTaskCustomFields(out = {}, task = {}) {
  for (const key of TASK_CUSTOM_FIELD_KEYS) {
    if (hasTaskDetailValue(task?.[key]) && !hasTaskDetailValue(out[key])) out[key] = task[key];
  }
  return out;
}

function normalizeCookieTaskDetail(task = {}) {
  const result = {
    taskId: task._id, uniqueId: task.uniqueId,
    content: task.content, note: task.note,
    creatorId: task._creatorId, executorId: task._executorId,
    tasklistId: task._tasklistId,
    sprintId: task._sprintId || task.sprintId || task.sprint?._id,
    stageId: task._stageId,
    taskflowstatusId: task._taskflowstatusId,
    priority: task.priority, isDone: task.isDone,
    dueDate: task.dueDate, projectId: task._projectId,
    startDate: task.startDate,
    created: task.created, updated: task.updated,
    tagIds: task._tagIds || task.tagIds,
  };
  if (task.tasklist && typeof task.tasklist === "object") result.tasklist = task.tasklist;
  if (task.executor && typeof task.executor === "object") result.executor = task.executor;
  if (task.project && typeof task.project === "object") result.project = task.project;
  if (task.sprint && typeof task.sprint === "object") result.sprint = task.sprint;
  if (task.stage && typeof task.stage === "object") result.stage = task.stage;
  if (task.scenariofieldconfig && typeof task.scenariofieldconfig === "object") result.scenariofieldconfig = task.scenariofieldconfig;
  if (task.involveMembers && Array.isArray(task.involveMembers)) result.involveMembers = task.involveMembers;
  if (task.taskflowstatus && typeof task.taskflowstatus === "object") result.taskflowstatus = task.taskflowstatus;
  return copyTaskCustomFields(result, task);
}

export function mergeTaskDetail(primary = null, fallback = null) {
  if (!primary) return fallback;
  if (!fallback) return primary;
  return copyTaskCustomFields({ ...fallback, ...primary }, fallback);
}

export async function ensureTaskCustomFields(detail, taskId) {
  const id = String(taskId || detail?.taskId || detail?._id || detail?.id || "").trim();
  if (!id || hasTaskCustomFieldData(detail)) return detail || null;
  const cookie = getConfig().teambition?.userCookie;
  if (!cookie) return detail || null;
  try {
    const resp = await fetch(`https://www.teambition.com/api/tasks/${encodeURIComponent(id)}`, {
      headers: { Cookie: cookie, Accept: "application/json" },
    });
    if (!resp.ok) return detail || null;
    const task = unwrapTeambitionResult(await readJsonResponse(resp)) || {};
    if (!task || typeof task !== "object") return detail || null;
    return mergeTaskDetail(detail, normalizeCookieTaskDetail(task));
  } catch {
    return detail || null;
  }
}

function isDeletedTeambitionTask(task = {}) {
  if (!task || typeof task !== "object") return false;
  if (task.isDeleted === true || task.deleted === true || task.isRemoved === true || task.removed === true) return true;
  if (task._isDeleted === true || task._deleted === true || task._isRemoved === true) return true;
  if (task.isArchived === true || task.archived === true || task._isArchived === true) return true;
  if (task.deletedAt || task.deleted_at || task.removedAt || task.removed_at) return true;
  return false;
}

export async function getTeambitionTaskExistence(taskId) {
  const id = String(taskId || "").trim();
  if (!id) throw new Error("Teambition taskId is required");
  const cookie = getConfig().teambition?.userCookie;
  if (cookie) {
    const resp = await fetch(`https://www.teambition.com/api/tasks/${encodeURIComponent(id)}`, {
      headers: { Cookie: cookie, Accept: "application/json" },
    });
    const data = await readJsonResponse(resp);
    if (resp.status === 401) throw Object.assign(new Error("Teambition 登录已过期，请扫码登录后重试"), { needLogin: true });
    if (resp.status === 404) return { exists: false, source: "cookie", status: 404 };
    if (!resp.ok) {
      throw new Error(`Teambition task existence check HTTP ${resp.status}: ${clip(data?.message || data?.error || data?.raw || JSON.stringify(data || {}), 240)}`);
    }
    const task = unwrapTeambitionResult(data) || data;
    if (isDeletedTeambitionTask(task)) return { exists: false, task, source: "cookie", reason: "deleted" };
    return task && (task._id || task.id || task.taskId)
      ? { exists: true, task, source: "cookie" }
      : { exists: false, source: "cookie" };
  }

  let openApiError = null;
  try {
    const data = await tbAPI("GET", `/api/task/query?taskId=${encodeURIComponent(id)}`);
    const result = Array.isArray(data?.result) ? data.result : (Array.isArray(data?.data) ? data.data : []);
    const found = result.find((task) => String(task.taskId || task.id || task._id || "") === id) || result[0] || null;
    if (!found) return { exists: false, source: "openapi" };
    return isDeletedTeambitionTask(found)
      ? { exists: false, task: found, source: "openapi", reason: "deleted" }
      : { exists: true, task: found, source: "openapi" };
  } catch (err) {
    openApiError = err;
  }

  throw openApiError || new Error("Teambition task existence check unavailable");
}

/**
 * 获取任务评论/动态
 * v3 API: GET /api/v3/task/{taskId}/activity/list
 * @param {string} taskId
 * @param {string} actions - 过滤动态类型，逗号分隔，默认空（全部）。传 "comment" 只拿评论
 */
function activityMatchesActions(activity, actions = "") {
  const filters = String(actions || "").split(",").map((item) => item.trim().toLowerCase()).filter(Boolean);
  if (!filters.length) return true;
  const action = String(activity?.action || activity?.actionType || activity?.type || "").toLowerCase();
  return filters.some((filter) => {
    if (filter === "comment") {
      return action.includes("comment") || activity?.content?.comment != null;
    }
    return action === filter || action.endsWith(`.${filter}`) || action.includes(filter);
  });
}

function dedupeTaskActivities(items) {
  const result = [];
  const seenIds = new Set();
  for (const item of (items || []).filter(Boolean)) {
    const id = String(item?._id || item?.id || "").trim();
    if (id && seenIds.has(id)) continue;
    if (id) seenIds.add(id);
    result.push(item);
  }
  return result;
}

async function getTaskActivitiesByV2Api(taskId) {
  const cookie = getConfig().teambition?.userCookie;
  if (!cookie) throw new Error("未配置 TB Cookie");
  const resp = await fetch(
    `https://www.teambition.com/api/v2/tasks/${encodeURIComponent(taskId)}/activities`,
    { headers: { Cookie: cookie } },
  );
  let data = null;
  try {
    data = await resp.json();
  } catch {
    throw new Error(`TB Cookie 活动接口返回了无法解析的数据（HTTP ${resp.status || 0}）`);
  }
  if (!resp.ok) {
    const detail = data?.message || data?.errorMessage || data?.error || `HTTP ${resp.status || 0}`;
    throw new Error(`TB Cookie 活动接口读取失败: ${detail}`);
  }
  const items = data?.result || data;
  if (!Array.isArray(items)) throw new Error("TB Cookie 活动接口返回格式异常");
  const total = Number(data?.total);
  const hasTotal = !Array.isArray(data) && Number.isFinite(total) && total >= 0;
  const complete = !hasTotal || items.length >= total;
  return {
    items: dedupeTaskActivities(items),
    complete,
    error: complete ? "" : `TB Cookie 活动只返回 ${items.length}/${total} 条`,
  };
}

function sourceFailureMessage(label, errors) {
  const messages = (errors || []).map((item) => item?.message || String(item || "")).filter(Boolean);
  return `${label}读取失败${messages.length ? `：${[...new Set(messages)].join("；")}` : ""}`;
}

function sourcePartialMessage(label, errors) {
  const messages = (errors || []).map((item) => item?.message || String(item || "")).filter(Boolean);
  return `${label}读取不完整${messages.length ? `：${[...new Set(messages)].join("；")}` : ""}`;
}

const TB_ACTIVITY_MAX_PAGES = 5;

async function getOpenApiTaskActivities(taskId, actions = "") {
  const items = [];
  const seenPageTokens = new Set();
  let pageToken = "";
  for (let page = 0; page < TB_ACTIVITY_MAX_PAGES; page++) {
    let path = `/api/v3/task/${encodeURIComponent(taskId)}/activity/list?pageSize=100`;
    if (actions) path += `&actions=${encodeURIComponent(actions)}`;
    if (pageToken) path += `&pageToken=${encodeURIComponent(pageToken)}`;
    let data = null;
    try {
      data = await tbAPI("GET", path);
      if (!Array.isArray(data?.result)) {
        throw new Error("Teambition OpenAPI 活动列表返回格式异常：result 不是数组");
      }
    } catch (error) {
      if (page === 0) throw error;
      return {
        items,
        complete: false,
        error: `Teambition OpenAPI 活动第 ${page + 1} 页读取失败：${error.message}`,
      };
    }
    const mergedItems = dedupeTaskActivities([...items, ...data.result]);
    items.length = 0;
    items.push(...mergedItems);
    const nextPageToken = String(data?.nextPageToken || "").trim();
    if (!nextPageToken) return { items, complete: true, error: "" };
    if (seenPageTokens.has(nextPageToken)) {
      return { items, complete: false, error: "Teambition OpenAPI 活动分页游标重复" };
    }
    seenPageTokens.add(nextPageToken);
    pageToken = nextPageToken;
  }
  return {
    items,
    complete: false,
    error: `Teambition OpenAPI 活动超过 ${TB_ACTIVITY_MAX_PAGES} 页，结果已截断`,
  };
}

async function getOpenApiTaskWorks(taskId) {
  const items = [];
  const seenPageTokens = new Set();
  let pageToken = "";
  for (let page = 0; page < TB_ACTIVITY_MAX_PAGES; page++) {
    let path = `/api/v3/work/list?parentId=${encodeURIComponent(taskId)}&pageSize=100`;
    if (pageToken) path += `&pageToken=${encodeURIComponent(pageToken)}`;
    let data = null;
    try {
      data = await tbAPI("GET", path);
      if (!Array.isArray(data?.result)) {
        throw new Error("Teambition OpenAPI 附件列表返回格式异常：result 不是数组");
      }
    } catch (error) {
      if (page === 0) throw error;
      return {
        items,
        complete: false,
        error: `Teambition OpenAPI 附件第 ${page + 1} 页读取失败：${error.message}`,
      };
    }
    items.push(...data.result);
    const nextPageToken = String(data?.nextPageToken || "").trim();
    if (!nextPageToken) return { items, complete: true, error: "" };
    if (seenPageTokens.has(nextPageToken)) {
      return { items, complete: false, error: "Teambition OpenAPI 附件分页游标重复" };
    }
    seenPageTokens.add(nextPageToken);
    pageToken = nextPageToken;
  }
  return {
    items,
    complete: false,
    error: `Teambition OpenAPI 附件超过 ${TB_ACTIVITY_MAX_PAGES} 页，结果已截断`,
  };
}

export async function getTaskCommentsWithStatus(taskId, actions = "") {
  const id = String(taskId || "").trim();
  if (!id) return { available: false, complete: false, source: "none", items: [], error: "缺少 TB taskId" };
  const errors = [];
  const openApiComments = [];
  try {
    const result = await getOpenApiTaskActivities(id, actions);
    openApiComments.push(...result.items);
    if (result.complete) {
      return { available: true, complete: true, source: "open-api", items: openApiComments, error: "" };
    }
    const error = new Error(result.error || "Teambition OpenAPI 评论读取不完整");
    errors.push(error);
    log("system", "warn", "teambition", `${error.message}，尝试 Cookie`);
  } catch (error) {
    errors.push(error);
    log("system", "warn", "teambition", `OpenAPI 获取评论失败，尝试 Cookie: ${error.message}`);
  }

  try {
    const result = await getTaskActivitiesByV2Api(id);
    const cookieItems = result.items.filter((activity) => activityMatchesActions(activity, actions));
    if (!result.complete) {
      const partialErrors = result.error ? [...errors, new Error(result.error)] : errors;
      return {
        available: true,
        complete: false,
        source: openApiComments.length ? "open-api+cookie" : "cookie",
        items: dedupeTaskActivities([...openApiComments, ...cookieItems]),
        error: sourcePartialMessage("TB 评论", partialErrors),
      };
    }
    return {
      available: true,
      complete: true,
      source: "cookie",
      items: cookieItems,
      error: "",
    };
  } catch (error) {
    errors.push(error);
    log("system", "warn", "teambition", `Cookie 获取评论失败: ${error.message}`);
  }

  if (openApiComments.length) {
    return {
      available: true,
      complete: false,
      source: "open-api",
      items: openApiComments,
      error: sourcePartialMessage("TB 评论", errors),
    };
  }
  return {
    available: false,
    complete: false,
    source: "none",
    items: [],
    error: sourceFailureMessage("TB 评论", errors),
  };
}

export async function getTaskComments(taskId, actions = "") {
  const result = await getTaskCommentsWithStatus(taskId, actions);
  if (!result.available) throw new Error(result.error);
  return result.items;
}

/**
 * 获取任务附件
 * 策略：
 *   1. 先尝试 work/list（直接附件）
 *   2. 从 activity/list 评论中提取 content.files 文件 ID
 *   3. 用 work/query 批量查文件详情（含下载链接）
 *   4. 403 时仍返回文件 ID 列表（标记权限不足）
 */
function commentContent(activity) {
  let content = activity?.content;
  if (typeof content === "string") {
    try { content = JSON.parse(content); } catch {}
  }
  return content && typeof content === "object" ? content : {};
}

function attachmentId(work) {
  return String(work?.id || work?._id || "").trim();
}

function attachmentName(work) {
  return String(work?.fileName || work?.name || "").trim();
}

function attachmentCreatedAt(value) {
  for (const candidate of [value?.created, value?.createdAt, value?._createdAt]) {
    if (candidate != null && String(candidate).trim() !== "") return candidate;
  }
  return "";
}

// 评论内嵌文件不一定自带 work.created；此时用所属活动的创建时间作为上传时间。
// 文件自身的时间戳优先，避免后续引用同一文件时覆盖真实创建时间。
function activityInheritedFileTime(activity, file) {
  if (!file || typeof file !== "object" || attachmentCreatedAt(file) !== "") return file;
  const createdAt = attachmentCreatedAt(activity);
  return createdAt === "" ? file : { ...file, createdAt };
}

function mergeTaskAttachments(works) {
  const merged = [];
  const positions = new Map();
  for (const work of (works || []).filter(Boolean)) {
    const id = attachmentId(work);
    const name = attachmentName(work);
    const size = Number(work?.fileSize || work?.size || 0);
    const url = String(work?.downloadUrl || work?.url || "").trim();
    const key = id ? `id:${id}` : (url ? `url:${url}` : `file:${name.toLowerCase()}:${size}`);
    if (!positions.has(key)) {
      positions.set(key, merged.length);
      merged.push(work);
      continue;
    }
    const index = positions.get(key);
    const existing = merged[index];
    const existingUrl = existing?.downloadUrl || existing?.url;
    let next = existing;
    if (!existingUrl && url) next = { ...existing, ...work };
    const incomingCreatedAt = attachmentCreatedAt(work);
    if (attachmentCreatedAt(next) === "" && incomingCreatedAt !== "") {
      next = { ...next, createdAt: incomingCreatedAt };
    }
    if (next !== existing) merged[index] = next;
  }
  return merged;
}

export async function getTaskAttachmentsWithStatus(taskId) {
  const id = String(taskId || "").trim();
  if (!id) return { available: false, complete: false, source: "none", items: [], error: "缺少 TB taskId" };
  const allWorks = [];
  const fileIdSet = new Set();
  const errors = [];
  const sources = new Set();
  let directAvailable = false;
  let directComplete = false;
  let commentsReadable = false;
  let commentsComplete = false;

  // 1. 尝试 work/list（可能 403）
  try {
    const works = await getOpenApiTaskWorks(id);
    directAvailable = true;
    directComplete = works.complete;
    sources.add("open-api");
    if (!works.complete) errors.push(new Error(works.error || "Teambition OpenAPI 直接附件读取不完整"));
    for (const w of works.items) {
      const workId = attachmentId(w);
      if (workId) fileIdSet.add(workId);
      allWorks.push(w);
    }
  } catch (err) {
    errors.push(err);
    log("system", "debug", "teambition", `work/list 失败(可能权限不足): ${err.message}`);
  }

  // 2. 从评论活动中提取文件 ID
  const commentFileIds = [];
  const commentFileCreatedAt = new Map();
  let commentActivityAvailable = false;
  let commentActivityComplete = false;
  try {
    const activities = await getOpenApiTaskActivities(id, "comment");
    commentActivityAvailable = true;
    commentActivityComplete = activities.complete;
    commentsReadable = true;
    sources.add("open-api");
    if (!activities.complete) errors.push(new Error(activities.error || "Teambition OpenAPI 评论附件活动读取不完整"));
    for (const act of activities.items) {
      const content = commentContent(act);
      if (content?.files?.length) {
        for (const file of content.files) {
          const fid = typeof file === "object" ? attachmentId(file) : String(file || "").trim();
          if (!fid) continue;
          const inheritedFile = activityInheritedFileTime(act, typeof file === "object" ? file : {});
          const inheritedCreatedAt = attachmentCreatedAt(inheritedFile);
          if (inheritedCreatedAt !== "" && !commentFileCreatedAt.has(fid)) {
            commentFileCreatedAt.set(fid, inheritedCreatedAt);
          }
          if (typeof file === "object" && (file.downloadUrl || file.url)) {
            allWorks.push(inheritedFile);
            fileIdSet.add(fid);
            continue;
          }
          if (!fileIdSet.has(fid)) {
            fileIdSet.add(fid);
            commentFileIds.push(fid);
          }
        }
      }
    }
  } catch (err) {
    errors.push(err);
    log("system", "debug", "teambition", `评论附件提取失败: ${err.message}`);
  }

  // 3. 用 work/query 查文件详情
  let remaining = [...commentFileIds];
  if (commentActivityAvailable && commentActivityComplete && commentFileIds.length === 0) commentsComplete = true;
  if (commentFileIds.length > 0) {
    try {
      const data = await tbAPI("GET", `/api/v3/work/query?workIds=${encodeURIComponent(commentFileIds.join(","))}&needSign=true`);
      if (!Array.isArray(data?.result)) {
        throw new Error("Teambition OpenAPI 附件详情返回格式异常：result 不是数组");
      }
      for (const w of data.result) {
        const workId = attachmentId(w);
        allWorks.push(activityInheritedFileTime({ createdAt: commentFileCreatedAt.get(workId) }, w));
        const idx = remaining.indexOf(workId);
        if (idx >= 0) remaining.splice(idx, 1);
      }
      if (commentActivityComplete && remaining.length === 0) commentsComplete = true;
    } catch (err) {
      errors.push(err);
      log("system", "debug", "teambition", `work/query 失败(权限不足): ${err.message}`);
    }
  }

  // 4. OpenAPI 无法完整读取评论附件时，使用 v2 API + Cookie 独立枚举评论附件。
  if (!commentsComplete) {
    try {
      const v2Result = await getCommentFilesByV2Api(id);
      sources.add("cookie");
      commentsReadable = true;
      if (!v2Result.complete) errors.push(new Error(v2Result.error || "TB Cookie 评论附件活动读取不完整"));
      for (const f of v2Result.files) {
        const idx = remaining.indexOf(f.id);
        allWorks.push(f);
        if (idx >= 0) remaining.splice(idx, 1);
      }
      commentsComplete = v2Result.complete && remaining.length === 0;
    } catch (err) {
      errors.push(err);
      log("system", "debug", "teambition", `v2 API 获取评论附件失败: ${err.message}`);
    }
    if (remaining.length > 0) {
      for (const fid of remaining) {
        const config = getConfig();
        const hasCookie = !!config.teambition?.userCookie;
        allWorks.push({
          id: fid, fileName: `评论附件 ${fid.slice(-6)}`, downloadUrl: null,
          createdAt: commentFileCreatedAt.get(fid) || "",
          _noDownload: true, _source: "comment",
          _reason: hasCookie
            ? "Cookie 无法获取此文件（可能已过期），请在设置页更新 TB Cookie"
            : "评论内嵌附件，需在设置页配置 TB Cookie 才能下载",
        });
      }
    }
  }

  const available = directAvailable || commentsReadable;
  const complete = directComplete && commentsComplete;
  return {
    available,
    complete,
    source: sources.size ? [...sources].join("+") : "none",
    items: mergeTaskAttachments(allWorks),
    error: complete
      ? ""
      : (available
          ? sourcePartialMessage("TB 附件", errors)
          : sourceFailureMessage("TB 附件", errors)),
  };
}

export async function getTaskAttachments(taskId) {
  const result = await getTaskAttachmentsWithStatus(taskId);
  if (!result.available) throw new Error(result.error);
  return result.items;
}

/**
 * 通过 v2 API + Cookie 获取任务评论中的附件详情（含签名下载链接）
 * API: GET https://www.teambition.com/api/v2/tasks/{taskId}/activities
 * 返回的评论 files 中 url 字段是带 JWT token 的下载直链
 */
async function getCommentFilesByV2Api(taskId) {
  const activities = await getTaskActivitiesByV2Api(taskId);
  const files = [];
  for (const act of activities.items) {
    const content = commentContent(act);
    if (content?.files?.length) {
      for (const f of content.files) {
        const baseName = String(f?.name || "file");
        const ext = String(f?.ext || "").replace(/^\./, "");
        const fileName = ext && !baseName.toLowerCase().endsWith(`.${ext.toLowerCase()}`)
          ? `${baseName}.${ext}`
          : baseName;
        files.push(activityInheritedFileTime(act, {
          id: f?._id || f?.id || "",
          fileName,
          fileSize: f?.size || 0,
          mimeType: f?.mimeType || "",
          downloadUrl: f?.url || null,
          previewUrl: f?.previewUrl || null,
          thumbnailUrl: f?.thumbnailUrl || null,
          _source: "v2_api",
        }));
      }
    }
  }
  return { files, complete: activities.complete, error: activities.error };
}

/**
 * 下载附件到本地
 */
export async function downloadAttachment(url, destPath) {
  const { writeFileSync, mkdirSync } = await import("fs");
  const { dirname } = await import("path");
  mkdirSync(dirname(destPath), { recursive: true });
  // v2 API 签名链接含 teambition.com 域名，需带 Cookie
  const headers = {};
  if (url.includes("teambition.com")) {
    const config = getConfig();
    const cookie = config.teambition?.userCookie;
    if (cookie) headers.Cookie = cookie;
  }
  const resp = await fetch(url, { headers });
  if (!resp.ok) throw new Error(`下载失败: ${resp.status}`);
  const buffer = Buffer.from(await resp.arrayBuffer());
  writeFileSync(destPath, buffer);
  return buffer.length;
}

/**
 * 流式下载（带 AbortSignal + 节流进度回调）。
 *
 * 与 downloadAttachment 的区别：
 * - 按 chunk 写入磁盘，可从 AbortSignal 取消；
 * - 节流调用 onProgress({ received, total })：每 256 KB 或每 250 ms 一次；
 * - 中止时**保留部分文件**到 destPath，方便"停止下载"按钮后续清理或重试；
 * - 没有 content-length 时 total=0（调用方按 indeterminate 处理）。
 *
 * 取消语义：
 * - 抛错前会先 out.destroy() 关流；用户取消时 err.code === "ABORTED"。
 *
 * 与 downloadAttachment 共用：teambition.com 域名带 Cookie 头、mkdir -p 父目录。
 */
export async function downloadAttachmentWithProgress(url, destPath, { signal, onProgress } = {}) {
  const { createWriteStream, mkdirSync } = await import("fs");
  const { dirname } = await import("path");
  mkdirSync(dirname(destPath), { recursive: true });
  const headers = {};
  if (url.includes("teambition.com")) {
    const config = getConfig();
    const cookie = config.teambition?.userCookie;
    if (cookie) headers.Cookie = cookie;
  }
  let reader = null;
  let out = null;
  let received = 0;
  let total = 0;
  // force=true 跳过节流，用于流结束/中止时确保最后一次回调触发
  const emit = (force = false) => {
    const now = Date.now();
    if (!force && received - lastBytes < 256 * 1024 && now - lastT < 250) return;
    lastBytes = received;
    lastT = now;
    try { onProgress?.({ received, total }); } catch {}
  };
  let lastBytes = 0;
  let lastT = 0;
  try {
    const resp = await fetch(url, { headers, signal });
    if (!resp.ok) throw new Error(`下载失败: ${resp.status}`);
    if (!resp.body) throw new Error("下载失败: 无响应体");
    total = Number(resp.headers.get("content-length")) || 0;
    reader = resp.body.getReader();
    out = createWriteStream(destPath);
    while (true) {
      if (signal?.aborted) throw new Error("aborted");
      const chunk = await reader.read();
      if (chunk.done) break;
      if (!chunk.value || chunk.value.byteLength === 0) continue;
      const buf = Buffer.from(chunk.value);
      if (!out.write(buf)) {
        await new Promise((resolve) => out.once("drain", resolve));
      }
      received += buf.length;
      emit();
    }
    await new Promise((resolve) => out.end(resolve));
    // 流结束：强制触发一次最终回调（节流规则可能跳过）
    emit(true);
    return { received, total };
  } catch (e) {
    try { out?.destroy(); } catch {}
    // 中止时也可能强制触发一次最终回调，让前端知道收到了多少字节
    if (signal?.aborted) emit(true);
    if (signal?.aborted || e?.code === "ABORTED" || e?.name === "AbortError") {
      // Node.js fetch 在 signal 已 abort 时会把 signal.reason（字符串）作为 reject value 抛出，
      // 或者抛 DOMException({ name: "AbortError" })。统一翻译成带 ABORTED code 的 Error 对象。
      const err = new Error("已停止下载");
      err.code = "ABORTED";
      err.received = received;
      err.total = total;
      throw err;
    }
    throw e;
  }
}

/**
 * Read a bounded attachment into memory for inference evidence extraction.
 * Unlike downloadAttachment this never writes a workspace file.
 */
export function isTrustedTeambitionCookieHost(hostname) {
  const host = String(hostname || "").trim().toLowerCase().replace(/\.$/, "");
  return host === "teambition.com" || host.endsWith(".teambition.com");
}

function privateNetworkAddress(address) {
  const value = String(address || "").trim().toLowerCase();
  if (!value) return true;
  if (value === "::" || value === "::1") return true;
  if (value.startsWith("fc") || value.startsWith("fd") || value.startsWith("fe8")
    || value.startsWith("fe9") || value.startsWith("fea") || value.startsWith("feb")
    || value.startsWith("ff")) return true;
  const dottedMapped = value.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)?.[1];
  const hexMapped = value.match(/^(?:::ffff:|::|64:ff9b::)([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  const mapped = dottedMapped || (hexMapped
    ? [
        Number.parseInt(hexMapped[1], 16) >> 8,
        Number.parseInt(hexMapped[1], 16) & 0xff,
        Number.parseInt(hexMapped[2], 16) >> 8,
        Number.parseInt(hexMapped[2], 16) & 0xff,
      ].join(".")
    : "");
  const ipv4 = mapped || (isIP(value) === 4 ? value : "");
  if (!ipv4) return false;
  const octets = ipv4.split(".").map(Number);
  return octets[0] === 0
    || octets[0] === 10
    || octets[0] === 127
    || (octets[0] === 100 && octets[1] >= 64 && octets[1] <= 127)
    || (octets[0] === 169 && octets[1] === 254)
    || (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31)
    || (octets[0] === 192 && octets[1] === 168)
    || octets[0] >= 224;
}

function attachmentHostname(value) {
  const hostname = String(value || "").trim().toLowerCase().replace(/\.$/, "");
  return hostname.startsWith("[") && hostname.endsWith("]")
    ? hostname.slice(1, -1)
    : hostname;
}

function pinnedAttachmentLookup(address, family) {
  return (_hostname, options, callback) => {
    let lookupOptions = options;
    let done = callback;
    if (typeof lookupOptions === "function") {
      done = lookupOptions;
      lookupOptions = {};
    }
    if (lookupOptions?.all) {
      done(null, [{ address, family }]);
      return;
    }
    done(null, address, family);
  };
}

/**
 * Keep the URL hostname as the HTTP Host/TLS SNI identity, but force the
 * socket lookup to return only the address that passed SSRF validation.
 */
export function createPinnedAttachmentRequestOptions(
  value,
  { address, family },
  { headers = {}, signal } = {},
) {
  const parsed = value instanceof URL ? value : new URL(String(value || ""));
  const hostname = attachmentHostname(parsed.hostname);
  const resolvedFamily = isIP(address);
  if (!hostname || !resolvedFamily || (Number(family) && Number(family) !== resolvedFamily)) {
    throw new Error("附件下载域名解析失败");
  }
  const options = {
    protocol: parsed.protocol,
    hostname,
    port: parsed.port || undefined,
    method: "GET",
    path: `${parsed.pathname}${parsed.search}`,
    headers: {
      ...headers,
      Host: parsed.host,
    },
    lookup: pinnedAttachmentLookup(address, resolvedFamily),
    signal,
  };
  if (parsed.protocol === "https:" && !isIP(hostname)) {
    options.servername = hostname;
  }
  return options;
}

async function validatedAttachmentUrl(value, {
  allowPrivateHostsForTests = false,
  dnsLookup = lookup,
} = {}) {
  let parsed;
  try {
    parsed = new URL(String(value || "").trim());
  } catch {
    throw new Error("附件下载地址无效");
  }
  if (!["https:", "http:"].includes(parsed.protocol) || parsed.username || parsed.password) {
    throw new Error("附件下载地址无效");
  }
  if (parsed.protocol !== "https:" && !allowPrivateHostsForTests) {
    throw new Error("附件下载只允许 HTTPS");
  }
  const hostname = attachmentHostname(parsed.hostname);
  if (
    !hostname
    || hostname === "localhost"
    || hostname.endsWith(".localhost")
    || hostname.endsWith(".local")
  ) {
    throw new Error("附件下载地址禁止访问本机或私有网络");
  }
  let addresses;
  if (isIP(hostname)) {
    addresses = [{ address: hostname, family: isIP(hostname) }];
  } else {
    try {
      addresses = await dnsLookup(hostname, { all: true, verbatim: true });
    } catch {
      throw new Error("附件下载域名解析失败");
    }
  }
  if (!Array.isArray(addresses) || !addresses.length) {
    throw new Error("附件下载域名解析失败");
  }
  const normalized = addresses.map((row) => {
    const address = attachmentHostname(row?.address);
    const family = isIP(address);
    if (!address || !family || (Number(row?.family) && Number(row.family) !== family)) {
      throw new Error("附件下载域名解析失败");
    }
    return { address, family };
  });
  if (!allowPrivateHostsForTests && normalized.some((row) => privateNetworkAddress(row.address))) {
    throw new Error("附件下载地址禁止访问本机或私有网络");
  }
  return {
    url: parsed,
    address: normalized[0].address,
    family: normalized[0].family,
  };
}

function requestValidatedAttachment(validated, { headers, signal }) {
  const options = createPinnedAttachmentRequestOptions(validated.url, validated, {
    headers,
    signal,
  });
  const request = validated.url.protocol === "https:" ? httpsRequest : httpRequest;
  return new Promise((resolve, reject) => {
    const req = request(options, resolve);
    req.once("error", reject);
    req.end();
  });
}

function attachmentResponseHeader(response, name) {
  const value = response.headers[String(name || "").toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}

export async function readAttachmentBuffer(url, {
  maxBytes = 2 * 1024 * 1024,
  timeoutMs = 20_000,
  allowPrivateHostsForTests = false,
  dnsLookup = lookup,
} = {}) {
  const source = String(url || "").trim();
  const limit = Math.max(1, Math.min(20 * 1024 * 1024, Number(maxBytes) || 2 * 1024 * 1024));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1000, Number(timeoutMs) || 20_000));
  try {
    let current = await validatedAttachmentUrl(source, { allowPrivateHostsForTests, dnsLookup });
    let response;
    for (let redirect = 0; redirect <= 3; redirect += 1) {
      const headers = {};
      if (isTrustedTeambitionCookieHost(current.url.hostname)) {
        const cookie = getConfig().teambition?.userCookie;
        if (cookie) headers.Cookie = cookie;
      }
      response = await requestValidatedAttachment(current, {
        headers,
        signal: controller.signal,
      });
      const status = Number(response.statusCode || 0);
      if (![301, 302, 303, 307, 308].includes(status)) break;
      if (redirect === 3) {
        response.destroy();
        throw new Error("附件下载重定向次数过多");
      }
      const location = attachmentResponseHeader(response, "location");
      if (!location) {
        response.destroy();
        throw new Error("附件下载重定向缺少地址");
      }
      response.resume();
      current = await validatedAttachmentUrl(new URL(location, current.url).toString(), {
        allowPrivateHostsForTests,
        dnsLookup,
      });
    }
    const status = Number(response?.statusCode || 0);
    if (status < 200 || status > 299) {
      response?.destroy();
      throw new Error(`下载失败: ${status}`);
    }
    const declared = Number(attachmentResponseHeader(response, "content-length") || 0);
    if (declared > limit) {
      response.destroy();
      throw new Error(`附件超过推理读取上限 ${limit} bytes`);
    }
    if ([204, 205].includes(status)) {
      response.destroy();
      throw new Error("附件响应没有内容");
    }
    const chunks = [];
    let total = 0;
    for await (const value of response) {
      const chunk = Buffer.from(value);
      total += chunk.length;
      if (total > limit) {
        response.destroy();
        throw new Error(`附件超过推理读取上限 ${limit} bytes`);
      }
      chunks.push(chunk);
    }
    const buffer = Buffer.concat(chunks, total);
    return {
      buffer,
      contentType: String(attachmentResponseHeader(response, "content-type") || "").split(";")[0].trim(),
      size: buffer.length,
    };
  } catch (error) {
    if (error?.name === "AbortError" || error?.code === "ABORT_ERR") {
      throw new Error(`附件读取超时（${timeoutMs}ms）`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

// ====== 任务备注（note，新版富文本 rtf）======

// 取备注描述符：result 含 url(OSS 富文本 json) 与 attachments(图片路径→新鲜签名URL 的映射)
async function fetchNoteDesc(taskId, cookie) {
  try {
    const r = await fetch(`https://www.teambition.com/api/tasks/${taskId}/note?_=${Date.now()}`, {
      headers: { Cookie: cookie, Accept: "application/json" },
    });
    if (!r.ok) return null;
    const j = await r.json();
    return j.result || null;
  } catch { return null; }
}

function noteEscapeHtml(s) {
  return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// 取一个 rtf 节点子树的纯文本
function noteNodeText(node) {
  if (typeof node === "string") return node;
  if (!Array.isArray(node)) return "";
  let s = "";
  for (let i = 2; i < node.length; i++) s += noteNodeText(node[i]);
  return s;
}

/**
 * 解析 Teambition rtf 备注树（JSON-ML: [tag, attrs, ...children]）。
 * @param tree 富文本 JSON
 * @param amap { "/oss路径": "新鲜签名URL" }
 * 返回 { markdown, html, images:[{name,src,signed,width,height}], links:[url] }
 */
function parseRtfNote(tree, amap) {
  const images = [];
  const links = [];
  const signOf = (src) => {
    if (!src) return null;
    let pn = src;
    try { pn = new URL(src).pathname; } catch {}
    return amap[pn] || amap[decodeURIComponent(pn)] || amap[encodeURI(pn)] || null;
  };
  let md = "";
  let html = "";
  const walk = (node) => {
    if (typeof node === "string") { md += node; html += noteEscapeHtml(node); return; }
    if (!Array.isArray(node)) return;
    const tag = node[0], attr = node[1] || {};
    if (tag === "img") {
      const signed = signOf(attr.src);
      const name = attr.name || `image_${images.length + 1}`;
      images.push({ name, src: attr.src, signed, width: attr.width, height: attr.height });
      md += `\n![${name}](${attr.src})\n`;
      html += `<img src="${noteEscapeHtml(signed || attr.src)}" alt="${noteEscapeHtml(name)}" style="max-width:100%;border-radius:6px;margin:6px 0;" />`;
      return;
    }
    if (tag === "a") {
      const t = noteNodeText(node) || attr.href || "";
      if (attr.href) links.push(attr.href);
      md += `[${t}](${attr.href || ""})`;
      html += `<a href="${noteEscapeHtml(attr.href || "")}" target="_blank" rel="noopener noreferrer" style="color:#818cf8;text-decoration:underline;">${noteEscapeHtml(t)}</a>`;
      return;
    }
    if (tag === "p") {
      html += "<p style=\"margin:4px 0;\">";
      for (let i = 2; i < node.length; i++) walk(node[i]);
      html += "</p>";
      md += "\n\n";
      return;
    }
    // root/span/leaf 等：递归子节点
    for (let i = 2; i < node.length; i++) walk(node[i]);
  };
  walk(tree);
  md = md.replace(/\n{3,}/g, "\n\n").trim();
  return { markdown: md, html, images, links: [...new Set(links)] };
}

/**
 * 获取任务备注（含图文）。优先解析新版 rtf 富文本（图片为新鲜签名 URL）；
 * 失败回退到 task.note 的 markdown 文本。
 * 返回 { ok, renderMode, markdown, html, images:[{name,src,signed,width,height}], links } 或 { ok:false, error }。
 */
export async function getTaskNote(taskId) {
  const cookie = getConfig().teambition?.userCookie;
  if (!cookie) return { ok: false, error: "未配置 TB Cookie，无法读取备注" };
  let desc = await fetchNoteDesc(taskId, cookie);
  // attachments 偶尔首次请求未生成；若有富文本 url 但无 attachments，重试一次
  if (desc && desc.url && (!desc.attachments || Object.keys(desc.attachments || {}).length === 0)) {
    const d2 = await fetchNoteDesc(taskId, cookie);
    if (d2 && d2.attachments && Object.keys(d2.attachments).length) desc = d2;
  }
  if (desc && desc.renderMode === "rtf" && desc.url) {
    try {
      const tree = JSON.parse(await (await fetch(desc.url)).text());
      const amap = (desc.attachments && typeof desc.attachments === "object") ? desc.attachments : {};
      const parsed = parseRtfNote(tree, amap);
      return { ok: true, renderMode: "rtf", ...parsed };
    } catch (e) {
      log("system", "warn", "teambition", `解析 rtf 备注失败: ${e.message}`);
    }
  }
  // 回退：尝试从 detail.note 提取可读文本
  const detail = await getTaskDetail(taskId).catch(() => null);
  let markdown = "";
  let html = "";
  let images = [];
  let links = [];
  const rawNote = detail?.note;
  if (rawNote && typeof rawNote === "object" && !Array.isArray(rawNote)) {
    // 可能是 { markdown, html } 结构
    markdown = String(rawNote.markdown || rawNote.plainText || rawNote.text || "");
    html = String(rawNote.html || "");
  } else if (Array.isArray(rawNote) && rawNote.length > 0) {
    // 可能是 RTF JSON-ML 树，直接尝试解析提取纯文本
    try {
      const parsed = parseRtfNote(rawNote, {});
      markdown = parsed.markdown || "";
      html = parsed.html || "";
      images = parsed.images || [];
      links = parsed.links || [];
    } catch {
      markdown = String(rawNote);
    }
  } else {
    markdown = String(rawNote || "");
  }
  if (!markdown.trim() && !html.trim()) {
    markdown = "";
    html = "";
  }
  if (!links.length) {
    links = [...new Set([...markdown.matchAll(/\((https?:\/\/[^)]+)\)/g)].map((m) => m[1]))];
  }
  if (!html && markdown) {
    html = markdown.split(/\n{2,}/).map((p) => `<p style="margin:4px 0;">${noteEscapeHtml(p)}</p>`).join("");
  }
  return { ok: true, renderMode: markdown ? "markdown" : "rtf", markdown, html, images, links };
}

/**
 * 获取用户信息
 */
const userCache = new Map();
export async function getUserInfo(userId) {
  if (!userId) return { name: "未知" };
  if (userCache.has(userId)) return userCache.get(userId);
  try {
    const data = await tbAPI("GET", `/api/user/info?userId=${userId}`);
    const info = { name: data.result?.name || data.name || userId, id: userId };
    userCache.set(userId, info);
    return info;
  } catch {
    return { name: userId, id: userId };
  }
}

// 简易 MIME 推断（附件上传用）
function mimeOf(ext) {
  const e = String(ext || "").toLowerCase().replace(/^\./, "");
  return ({ md: "text/markdown", txt: "text/plain", log: "text/plain", json: "application/json", csv: "text/csv",
    png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp",
    pdf: "application/pdf", zip: "application/zip", mp4: "video/mp4", html: "text/html", xml: "application/xml" })[e]
    || "application/octet-stream";
}

// 把本地文件上传到 TB 附件存储（AWOS 取凭证 → 阿里云 OSS，AWS SigV4 签名），返回 fileToken（供 activities 挂载）。
// 端点与负载据真实浏览器抓包：POST /api/awos/upload-token → PUT https://{Bucket}.{endpoint}/{Key}
async function awosUploadFile(taskId, body, fileName, fileType, fileSize) {
  const cookie = tbCookie();
  if (!cookie) throw new Error("未配置 TB Cookie");
  const tok = await fetch("https://www.teambition.com/api/awos/upload-token", {
    method: "POST", headers: { Cookie: cookie, "Content-Type": "application/json" },
    body: JSON.stringify({ scope: `task:${taskId}/activity/attachment`, category: "attachment", payload: {}, fileName, fileType, fileSize }),
  }).then((r) => r.json());
  if (!tok?.sdk || !tok?.upload || !tok?.token) throw new Error("获取上传凭证失败");
  const { endpoint, region, credentials: cr } = tok.sdk;
  const { Bucket, Key, ContentDisposition, ContentType } = tok.upload;
  const host = `${Bucket}.${endpoint}`;
  const d = new Date(), p = (n) => String(n).padStart(2, "0");
  const amz = `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
  const date = amz.slice(0, 8);
  const enc = (s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());
  const canonURI = "/" + String(Key).split("/").map(enc).join("/");
  const signed = "content-disposition;host;x-amz-content-sha256;x-amz-date;x-amz-security-token";
  const canonHeaders = `content-disposition:${ContentDisposition}\nhost:${host}\nx-amz-content-sha256:UNSIGNED-PAYLOAD\nx-amz-date:${amz}\nx-amz-security-token:${cr.sessionToken}\n`;
  const canonReq = `PUT\n${canonURI}\n\n${canonHeaders}\n${signed}\nUNSIGNED-PAYLOAD`;
  const scope = `${date}/${region}/s3/aws4_request`;
  const sha256hex = (s) => createHash("sha256").update(s).digest("hex");
  const hmac = (k, s) => createHmac("sha256", k).update(s).digest();
  const sts = `AWS4-HMAC-SHA256\n${amz}\n${scope}\n${sha256hex(canonReq)}`;
  const kKey = hmac(hmac(hmac(hmac("AWS4" + cr.secretAccessKey, date), region), "s3"), "aws4_request");
  const sig = createHmac("sha256", kKey).update(sts).digest("hex");
  const auth = `AWS4-HMAC-SHA256 Credential=${cr.accessKeyId}/${scope}, SignedHeaders=${signed}, Signature=${sig}`;
  const uploadUrl = `https://${host}${canonURI}`;
  const uploadHeaders = { "Content-Disposition": ContentDisposition, "Content-Type": ContentType, "Content-Length": String(fileSize), "x-amz-content-sha256": "UNSIGNED-PAYLOAD", "x-amz-date": amz, "x-amz-security-token": cr.sessionToken, Authorization: auth };
  if (fileSize >= 64 * 1024 * 1024) {
    const r = await putTeambitionUploadStream(uploadUrl, uploadHeaders, body);
    if (!r.ok) throw new Error(`OSS 上传失败 ${r.status}: ${r.body.slice(0, 150)}`);
  } else {
    const r = await fetch(uploadUrl, {
      method: "PUT",
      headers: uploadHeaders,
      body,
      duplex: "half",
    });
    if (!r.ok && r.status !== 200) throw new Error(`OSS 上传失败 ${r.status}: ${(await r.text().catch(() => "")).slice(0, 150)}`);
  }
  return tok.token;
}

export function putTeambitionUploadStream(url, headers, body) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(String(url));
    const request = parsed.protocol === "https:" ? httpsRequest : httpRequest;
    let settled = false;
    let responseReceived = false;
    const fail = (err) => {
      if (settled) return;
      settled = true;
      reject(err instanceof Error ? err : new Error(String(err || "Teambition upload stream failed")));
    };
    const req = request(parsed, { method: "PUT", headers }, (resp) => {
      responseReceived = true;
      const chunks = [];
      let bytes = 0;
      resp.on("data", (chunk) => {
        if (bytes >= 4096) return;
        const remaining = 4096 - bytes;
        const part = Buffer.from(chunk).subarray(0, remaining);
        chunks.push(part);
        bytes += part.length;
      });
      resp.on("end", () => {
        if (settled) return;
        settled = true;
        const status = Number(resp.statusCode || 0);
        resolve({
          ok: status >= 200 && status < 300,
          status,
          body: Buffer.concat(chunks).toString("utf8"),
        });
      });
      resp.on("aborted", () => fail(new Error("OSS upload response aborted before completion")));
      resp.on("error", fail);
      resp.on("close", () => {
        if (!resp.complete) fail(new Error("OSS upload response closed before completion"));
      });
    });
    req.on("error", fail);
    req.on("close", () => {
      if (!responseReceived) fail(new Error("OSS upload request closed before a response was received"));
    });
    body.on?.("error", (err) => req.destroy(err));
    body.pipe(req);
  });
}

/**
 * 发表任务评论（可带附件 fileTokens）。真实端点：POST /api/v2/tasks/{id}/activities（Cookie）。
 * @param {string} taskId
 * @param {string} content 评论正文（markdown）
 * @param {string} renderMode 默认 markdown
 * @param {string[]} fileTokens AWOS 上传得到的 fileToken 列表（附件）
 * @param {object|null} operation durable operation identity。TB 当前写端点不提供
 * 原生幂等键，因此调用方必须先用持久 owner/fencing CAS 取得唯一写权限。
 */
export async function postTaskComment(taskId, content, renderMode = "markdown", fileTokens = [], operation = null) {
  normalizeTbWriteOperation(operation, "comment");
  return postTaskCommentOpenApiOrCookie(taskId, content, renderMode, fileTokens, operation);
  const cookie = tbCookie();
  if (!cookie) throw new Error("未配置 TB Cookie，无法发表评论");
  const body = {
    content: String(content || ""),
    attachments: [], fileTokens: Array.isArray(fileTokens) ? fileTokens : [], dingFiles: [],
    renderMode: renderMode || "markdown",
    isOnlyNotifyMentions: false, mentions: {}, mentionedTeams: [], mentionedGroups: [],
  };
  const r = await fetch(`https://www.teambition.com/api/v2/tasks/${encodeURIComponent(taskId)}/activities`, {
    method: "POST", headers: { Cookie: cookie, "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  if (!r.ok) { const t = await r.text().catch(() => ""); throw new Error(`评论失败 HTTP ${r.status}: ${t.slice(0, 160)}`); }
  return { ok: true };
}

// ====== TB 写操作：状态流转 + 附件上传（devbench 全自动工作流用）======
//
// ⚠️ 需联调：状态流转/附件上传依赖 TB 真实接口，下面按开放平台 + Cookie 两条路径做了
// 多端点容错尝试；首次接入真实工单时若失败，按日志里打印的 endpoint/响应调整即可。

// 逻辑状态 → 该工程 taskflow 里可能的同义写法（用于动态读取后的容错匹配）
const STATUS_SYNONYMS = {
  待处理: ["待处理", "待办", "新建", "未开始", "待开发", "待接收", "待领取", "未处理", "open", "todo", "backlog", "new"],
  待确认: ["待确认", "确认中", "待确定", "待评估", "待复现", "待分析", "待排查", "待审", "评审中", "已确认", "待跟进"],
  修复中: ["修复中", "开发中", "处理中", "进行中", "修复", "解决中", "编码中", "实现中", "联调中", "调查中", "正在处理", "正在修复", "已接收", "fixing", "in progress", "inprogress", "doing", "developing", "wip"],
  可提测: ["可提测", "待提测", "提测中", "待测试", "测试中", "提测", "可测试", "待验证", "可验证", "已修复", "待回归", "回归中", "已解决", "已完成开发", "testing", "to verify", "resolved"],
  已拒绝: ["已拒绝", "拒绝", "驳回", "不予处理", "无效", "已关闭", "关闭", "挂起", "暂不处理", "非问题", "重复", "rejected", "won't fix", "wontfix", "closed", "invalid", "duplicate"],
};

function _norm(s) { return String(s || "").trim().toLowerCase().replace(/\s+/g, ""); }

/**
 * 把 TB 真实状态名归一到逻辑状态（待处理/待确认/修复中/可提测/已拒绝）。
 * 用于工作流"仅当前状态属于允许集合时才流转"的门控判断。匹配不到返回 null。
 */
// 列出某 TB 项目的真实状态名 [{id,name}]（设置页"状态映射"下拉用）。按 Cookie 任务采样得到，去重名。
export async function listTaskflowStatuses(projectId) {
  if (!projectId) return [];
  const idx = await buildProjectStatusIndex(projectId, true); // 设置页点击时强制刷新
  // 同名状态可能跨 taskflow 出现多个 id，这里按名去重（映射按名匹配，解析时再按任务 taskflow 定位具体 id）
  const seen = new Set(); const out = [];
  for (const [id, name] of Object.entries(idx.flat)) { if (!seen.has(name)) { seen.add(name); out.push({ id, name }); } }
  return out;
}

export function canonicalStatus(statusName) {
  const n = _norm(statusName);
  if (!n) return null;
  for (const [logical, group] of Object.entries(STATUS_SYNONYMS)) {
    if (group.some((w) => { const wn = _norm(w); return n === wn || n.includes(wn) || wn.includes(n); })) return logical;
  }
  return null;
}

function normalizeTbWriteOperation(operation, expectedStep) {
  if (operation == null) return null; // legacy callers retain their old contract
  if (!operation || typeof operation !== "object" || Array.isArray(operation)) {
    throw Object.assign(new Error("TB durable write operation metadata is invalid"), { code: "TB_WRITE_OPERATION_INVALID" });
  }
  const normalized = {
    operationId: String(operation.operationId || "").trim(),
    idempotencyKey: String(operation.idempotencyKey || "").trim(),
    fencingToken: Number(operation.fencingToken),
    step: String(operation.step || "").trim(),
    stepKey: String(operation.stepKey || "").trim(),
  };
  if (!normalized.operationId || !normalized.idempotencyKey || !normalized.stepKey
    || !Number.isSafeInteger(normalized.fencingToken) || normalized.fencingToken <= 0
    || normalized.step !== expectedStep) {
    throw Object.assign(new Error("TB durable write operation identity is incomplete or mismatched"), {
      code: "TB_WRITE_OPERATION_INVALID",
    });
  }
  return Object.freeze(normalized);
}

const TB_REQUIRED_TRANSITION_FIELDS = Object.freeze([
  Object.freeze({ name: "应用分类", defaultValue: "App Market", type: "dropDown" }),
  Object.freeze({ name: "缺陷分类", defaultValue: "功能使用BUG", type: "commongroup" }),
  Object.freeze({ name: "复现概率", defaultValue: "一般", type: "text" }),
]);

const TB_REQUIRED_TAG_ALIASES = Object.freeze({
  Geely: Object.freeze(["p162g"]),
});

function taskScenarioFieldConfigId(detail = {}) {
  return String(
    detail?._scenariofieldconfigId
    || detail?.scenariofieldconfigId
    || detail?._scenarioFieldConfigId
    || detail?.scenarioFieldConfigId
    || detail?.scenariofieldconfig?._id
    || detail?.scenariofieldconfig?.id
    || detail?.scenarioFieldConfig?._id
    || detail?.scenarioFieldConfig?.id
    || "",
  ).trim();
}

function semanticTbText(value) {
  return String(value || "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[【】\[\]()（）{}<>《》〈〉「」『』“”‘’'"`·•._\-—–/\\:：;,，。!?！？\s]+/g, "");
}

function taskRequiredFieldMatchText(detail = {}) {
  return [
    detail.content,
    detail.title,
    detail.name,
    detail.tasklist?.title,
    detail.tasklist?.name,
    detail.tasklistName,
    detail.sprint?.name,
    detail.sprintName,
  ].map((value) => String(value || "").trim()).filter(Boolean).join("\n");
}

function taskCustomFieldRows(detail = {}) {
  const rows = [];
  for (const key of TASK_CUSTOM_FIELD_KEYS) {
    const value = detail?.[key];
    if (Array.isArray(value)) rows.push(...value.filter((row) => row && typeof row === "object"));
  }
  return rows;
}

function taskCustomFieldIdentity(row = {}) {
  const nested = row.customfield || row.customField || row.custom_field || {};
  return {
    id: firstStringFromKeys(row, TB_CUSTOM_FIELD_REF_ID_KEYS)
      || firstStringFromKeys(nested, [...TB_CUSTOM_FIELD_REF_ID_KEYS, ...TB_CUSTOM_FIELD_SELF_ID_KEYS]),
    name: firstStringFromKeys(row, TB_CUSTOM_FIELD_NAME_KEYS)
      || firstStringFromKeys(nested, TB_CUSTOM_FIELD_NAME_KEYS),
  };
}

function taskCustomFieldSelectedChoice(row = {}) {
  const raw = Array.isArray(row.value) ? row.value[0] : row.value;
  if (raw === undefined || raw === null || raw === "") return null;
  if (typeof raw !== "object") return { id: "", name: String(raw).trim() };
  const name = firstStringFromKeys(raw, ["title", "label", "name", "displayName", "display_name", "text", "value"]);
  const id = firstStringFromKeys(raw, ["_id", "id", "valueId", "value_id", "choiceId", "choice_id", "optionId", "option_id"]);
  return name ? { id, name } : null;
}

function existingTaskCustomField(detail, def, semanticName) {
  const targetName = semanticTbText(semanticName);
  for (const row of taskCustomFieldRows(detail)) {
    const identity = taskCustomFieldIdentity(row);
    if ((def?.id && identity.id === def.id) || (identity.name && semanticTbText(identity.name) === targetName)) {
      const choice = taskCustomFieldSelectedChoice(row);
      if (choice?.name) return choice;
    }
  }
  return null;
}

async function resolveRequiredFieldChoice(projectId, def, value, cookie) {
  const target = semanticTbText(value);
  const fromDef = (def?.choiceEntries || []).find((entry) => semanticTbText(entry?.name) === target && entry?.id);
  if (fromDef) return { id: String(fromDef.id), name: String(fromDef.name) };
  const url = new URL(`https://www.teambition.com/api/v2/projects/${encodeURIComponent(projectId)}/customfieldentities/choices`);
  url.searchParams.set("customfieldId", def.id);
  url.searchParams.set("customfieldentityId", def.id);
  const response = await fetch(url, { headers: { Cookie: cookie, Accept: "application/json" } });
  const data = await readJsonResponse(response);
  if (!response.ok) {
    throw new Error(`读取「${def.name}」选项失败（HTTP ${response.status}）`);
  }
  const choices = mergeTeambitionChoiceEntries(collectTeambitionChoiceEntries(data));
  const hit = choices.find((entry) => semanticTbText(entry?.name) === target && entry?.id);
  if (!hit) throw new Error(`「${def.name}」没有可写选项「${value}」`);
  return { id: String(hit.id), name: String(hit.name) };
}

function existingTaskTagIds(detail = {}) {
  return uniqueStrings([
    ...normalizeCookieStringList(detail.tagIds),
    ...normalizeCookieStringList(detail._tagIds),
  ]);
}

function matchRequiredProjectTag(detail, tags = []) {
  const existing = existingTaskTagIds(detail);
  if (existing.length) return existing;
  const taskText = semanticTbText(taskRequiredFieldMatchText(detail));
  const directNames = new Set(directTaskTagNames(detail).map(semanticTbText).filter(Boolean));
  if (!taskText && !directNames.size) return [];
  const matches = tags
    .map((tag) => {
      const semanticName = semanticTbText(tag?.name);
      const aliasMatch = (TB_REQUIRED_TAG_ALIASES[tag?.name] || [])
        .map(semanticTbText)
        .some((alias) => alias && taskText.includes(alias));
      return { ...tag, semanticName, aliasMatch };
    })
    .filter((tag) => tag.id && tag.semanticName.length >= 2
      && (directNames.has(tag.semanticName) || taskText.includes(tag.semanticName) || tag.aliasMatch))
    .sort((a, b) => b.semanticName.length - a.semanticName.length || a.name.localeCompare(b.name, "zh"));
  if (!matches.length) return [];
  const bestLength = matches[0].semanticName.length;
  const best = matches.filter((tag) => tag.semanticName.length === bestLength);
  return best.length === 1 ? [best[0].id] : [];
}

function requiredApplicationCategory(detail = {}) {
  const text = semanticTbText(taskRequiredFieldMatchText(detail));
  return text.includes("spotify") || text.includes("s应用") ? "S" : "App Market";
}

async function buildRequiredTransitionTaskUpdate(detail, projectId, cookie) {
  const scenarioId = taskScenarioFieldConfigId(detail);
  if (!scenarioId) throw new Error("无法确定任务类型配置，不能自动填写流转必填项");
  const [defs, tags] = await Promise.all([
    listTeambitionTaskCustomFieldDefs({ projectId, force: true }),
    listProjectTags(projectId),
  ]);
  const tagIds = matchRequiredProjectTag(detail, tags);
  if (!tagIds.length) throw new Error("无法从 TB 标题或已有标签唯一确定流转必填标签");

  const customfields = [];
  for (const field of TB_REQUIRED_TRANSITION_FIELDS) {
    const def = defs.find((item) => semanticTbText(item?.name) === semanticTbText(field.name));
    if (!def?.id) throw new Error(`未找到 TB 必填字段「${field.name}」的定义`);
    const current = existingTaskCustomField(detail, def, field.name);
    const defaultValue = field.name === "应用分类" ? requiredApplicationCategory(detail) : field.defaultValue;
    const selectedName = current?.name || defaultValue;
    let selectedId = current?.id || "";
    if (field.type !== "text" && !selectedId) {
      const choice = await resolveRequiredFieldChoice(projectId, def, selectedName, cookie);
      selectedId = choice.id;
    }
    customfields.push({
      value: [{ title: selectedName, ...(selectedId ? { _id: selectedId } : {}) }],
      _customfieldId: def.id,
      type: field.type,
    });
  }

  return {
    tagIds,
    customfields,
    targetSfcId: scenarioId,
    targetProjectId: projectId,
  };
}

async function fillRequiredTransitionFields(tbTaskId, detail, projectId, cookie) {
  const body = await buildRequiredTransitionTaskUpdate(detail, projectId, cookie);
  const response = await fetch(`https://www.teambition.com/api/v2/tasks/${encodeURIComponent(tbTaskId)}`, {
    method: "PUT",
    headers: { Cookie: cookie, Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await readJsonResponse(response);
  if (!response.ok) {
    const message = clip(data?.message || data?.error?.message || data?.error || data?.raw || "", 240);
    throw new Error(`填写 TB 流转必填项失败（HTTP ${response.status}${message ? `：${message}` : ""}）`);
  }
  return body;
}

/**
 * 在指定工程（限定到任务所属 taskflow）的状态里，容错解析"逻辑状态名"对应的真实状态 { id, name }。
 * 优先级：用户配置映射 > 精确 > 互相包含 > 同义词组。找不到返回 null。
 * @param {string} projectId
 * @param {string} logicalName 待处理/待确认/修复中/可提测/已拒绝（也接受真实名）
 * @param {string|null} taskflowId 任务所属 taskflow（同名状态跨流 id 不同，必须限定；为空则用全项目）
 */
export async function resolveStatusId(projectId, logicalName, taskflowId = null) {
  if (!logicalName) return null;
  // 优先按任务所属 taskflow 直接取状态（同名跨流 id 不同，必须限定）；取不到再退回全项目索引
  let entries = taskflowId ? await getTaskflowStatuses(taskflowId) : [];
  if (!entries.length && projectId) entries = Object.entries((await buildProjectStatusIndex(projectId)).flat).map(([id, name]) => ({ id, name }));
  if (!entries.length) return null;
  const targetN = _norm(logicalName);
  // 0. 用户在设置里配的"逻辑状态→真实状态名"映射（最高优先；配了但找不到则继续兜底）
  try {
    const { getStatusMapping } = await import("./devbench/store.js");
    const real = getStatusMapping(projectId)?.[logicalName];
    if (real) { const h = entries.find((e) => _norm(e.name) === _norm(real)); if (h) return h; }
  } catch {}
  // 1. 精确
  let hit = entries.find((e) => _norm(e.name) === targetN);
  if (hit) return hit;
  // 2. 互相包含
  hit = entries.find((e) => { const n = _norm(e.name); return n.includes(targetN) || targetN.includes(n); });
  if (hit) return hit;
  // 3. 同义词组
  const group = STATUS_SYNONYMS[logicalName] || Object.values(STATUS_SYNONYMS).find((g) => g.some((w) => _norm(w) === targetN));
  if (group) {
    for (const e of entries) {
      const n = _norm(e.name);
      if (group.some((w) => { const wn = _norm(w); return n === wn || n.includes(wn) || wn.includes(n); })) return e;
    }
  }
  return null;
}

/**
 * 把 TB 工单流转到目标逻辑状态。幂等：已在目标态则跳过。
 * @param {string} tbTaskId
 * @param {string} logicalName 目标逻辑状态（待确认/修复中/可提测/已拒绝…）
 * @param {object|null} operation stable durable operation identity
 * @returns {Promise<{ok, skipped?, from?, to?, error?}>}
 */
export async function updateTaskStatus(tbTaskId, logicalName, operation = null) {
  normalizeTbWriteOperation(operation, "status");
  const cookie = tbCookie();
  if (!cookie) return { ok: false, error: "未配置 TB Cookie，无法流转状态（请在设置里一键登录）" };

  // Cookie 任务详情：拿当前状态 {_id,name} + 所属 taskflow + 项目（状态写入/解析都基于它）
  let detail;
  try { detail = await cookieTaskDetail(tbTaskId); } catch (e) { return { ok: false, error: `读取任务失败（需 TB 登录）：${e.message}` }; }
  const pid = detail._projectId || detail.projectId || null;
  if (!pid) return { ok: false, error: "无法确定工单所属工程，无法流转状态" };
  const cur = detail.taskflowstatus || {};
  const taskflowId = cur._taskflowId || null;
  const fromName = cur.name || "(未知)";
  const scenarioId = taskScenarioFieldConfigId(detail);

  const target = await resolveStatusId(pid, logicalName, taskflowId);
  if (!target) {
    const names = (await getTaskflowStatuses(taskflowId)).map((s) => s.name);
    log("system", "warn", "teambition", `状态流转失败：「${logicalName}」无匹配。该工作流可选状态：${names.join(" / ") || "(空)"}`);
    return { ok: false, error: `找不到与「${logicalName}」匹配的状态；该工作流可选：${names.join(" / ") || "(无，请确认已 TB 登录)"}`, available: names };
  }
  if (cur._id && cur._id === target.id) return { ok: true, skipped: true, from: fromName, to: target.name };

  // 单步写入 + 写后校验。真实端点 PUT /api/tasks/{id}/taskflowstatus，validate 须 true。
  // scenario/persistentValidator 参数与 TB 网页成功请求保持一致。
  //（false 时 TB 反而报 CanNotMove；true 时缺必填项会明确报 MissingRequiredField）。
  const putStatus = async (statusId) => {
    try {
      const r = await fetch(`https://www.teambition.com/api/tasks/${encodeURIComponent(tbTaskId)}/taskflowstatus`, {
        method: "PUT", headers: { Cookie: cookie, "Content-Type": "application/json" },
        body: JSON.stringify({
          _taskflowstatusId: statusId,
          sfcRequiredValidateEnable: true,
          ...(scenarioId
            ? { _scenariofieldconfigId: scenarioId, persistentValidatorEnable: false }
            : { persistentValidatorEnable: true }),
          disableRequiredCfIds: [],
        }),
      });
      if (r.ok || r.status === 204) {
        let ok = false; try { const d2 = await cookieTaskDetail(tbTaskId); ok = d2?.taskflowstatus?._id === statusId; } catch {}
        return { ok };
      }
      const txt = await r.text().catch(() => ""); let body = {}; try { body = JSON.parse(txt); } catch {}
      return { ok: false, code: body.code, message: body.message, http: r.status };
    } catch (e) { return { ok: false, message: e.message }; }
  };
  const missMsg = (m) => String(m || "").replace(/^操作失败。?/, "").trim() || "某些必填项";

  const putStatusWithRequiredFieldRecovery = async (statusId) => {
    const first = await putStatus(statusId);
    if (first.ok || first.code !== "MissingRequiredField") return first;
    try {
      await fillRequiredTransitionFields(tbTaskId, detail, pid, cookie);
    } catch (error) {
      return { ...first, requiredFieldRecoveryError: error.message };
    }
    const retried = await putStatus(statusId);
    return retried.ok
      ? { ...retried, recoveredRequiredFields: true }
      : { ...retried, requiredFieldRecoveryAttempted: true };
  };

  // 1) 直接流转
  const direct = await putStatusWithRequiredFieldRecovery(target.id);
  if (direct.ok) {
    log("system", "info", "teambition", `状态流转成功: ${fromName} → ${target.name}${direct.recoveredRequiredFields ? "（已自动补全必填项）" : ""}`);
    return { ok: true, from: fromName, to: target.name, ...(direct.recoveredRequiredFields ? { recoveredRequiredFields: true } : {}) };
  }
  if (direct.code === "MissingRequiredField") {
    const recovery = direct.requiredFieldRecoveryError ? `；自动填写失败：${direct.requiredFieldRecoveryError}` : "";
    log("system", "warn", "teambition", `流转到「${target.name}」需先补必填项：${missMsg(direct.message)}${recovery}`);
    return { ok: false, error: `流转到「${target.name}」前，TB 要求该工单先填：${missMsg(direct.message)}${recovery}（请在 TB 补全后重试）`, needFields: true };
  }

  // 2) 不能直达（CanNotMove）+ 目标在前方(pos 更大) → 沿 taskflow 的 pos 顺序逐步前进
  //    很多缺陷/任务工作流的"前进"只允许沿相邻状态走（如 待确认→重新打开→修复中），不能跨级直跳。
  if (direct.code === "CanNotMoveToTheTaskflowstatus") {
    const all = await getTaskflowStatuses(taskflowId);
    const curPos = typeof cur.pos === "number" ? cur.pos : (all.find((s) => s.id === cur._id)?.pos);
    const tgt = all.find((s) => s.id === target.id);
    if (curPos != null && tgt && tgt.pos > curPos) {
      const path = all.filter((s) => s.pos > curPos && s.pos <= tgt.pos).sort((a, b) => a.pos - b.pos);
      log("system", "info", "teambition", `「${fromName}→${target.name}」不能直达，沿工作流逐步前进：${path.map((s) => s.name).join("→")}`);
      let last = fromName;
      let recoveredRequiredFields = false;
      for (const step of path) {
        const sr = await putStatusWithRequiredFieldRecovery(step.id);
        if (!sr.ok) {
          if (sr.code === "MissingRequiredField") {
            const recovery = sr.requiredFieldRecoveryError ? `；自动填写失败：${sr.requiredFieldRecoveryError}` : "";
            return { ok: false, error: `前进到「${step.name}」前 TB 要求补必填项：${missMsg(sr.message)}${recovery}`, needFields: true, stoppedAt: last };
          }
          log("system", "warn", "teambition", `逐步前进卡在「${last}→${step.name}」: ${sr.message || sr.code}`);
          return { ok: false, error: `从「${fromName}」前进到「${target.name}」时卡在「${last}→${step.name}」(${sr.message || sr.code || sr.http})，已停在「${last}」` };
        }
        recoveredRequiredFields ||= sr.recoveredRequiredFields === true;
        last = step.name;
      }
      log("system", "info", "teambition", `状态流转成功(逐步): ${fromName} → ${target.name}`);
      return { ok: true, from: fromName, to: target.name, viaSteps: path.map((s) => s.name), ...(recoveredRequiredFields ? { recoveredRequiredFields: true } : {}) };
    }
    return { ok: false, error: `TB 工作流不允许从「${fromName}」流转到「${target.name}」（可能需先经其它状态，或在 TB 手动调整）` };
  }

  log("system", "warn", "teambition", `状态写入失败: ${direct.message || direct.code || direct.http}`);
  return { ok: false, error: `状态写入失败：${direct.message || direct.code || ("HTTP " + direct.http)}` };
}

/**
 * 上传本地文件作为 TB 工单附件。
 * 走经典 striker 上传 + works 挂载（Cookie 模式，真实环境最稳）。
 * @param {string} tbTaskId
 * @param {string} filePath 本地文件绝对路径
 * @param {object|null} operation stable durable operation identity
 * @returns {Promise<{ok, fileName?, error?}>}
 */
export async function uploadTaskAttachment(tbTaskId, filePath, comment = "", operation = null) {
  normalizeTbWriteOperation(operation, "attachment");
  const cookie = tbCookie();
  if (!cookie) return { ok: false, error: "未配置 TB Cookie，无法上传附件" };
  const { createReadStream, existsSync, statSync } = await import("fs");
  const { basename, extname } = await import("path");
  if (!existsSync(filePath)) return { ok: false, error: `文件不存在: ${basename(filePath)}` };
  const fileName = basename(filePath);
  const fileSize = statSync(filePath).size;
  try {
    const token = await awosUploadFile(tbTaskId, createReadStream(filePath), fileName, mimeOf(extname(fileName)), fileSize);
    // 以一条活动把附件挂到任务；TB 支持正文为空的附件评论。
    // The attachment is mounted through a comment, but it remains one logical
    // attachment operation and therefore keeps the attachment idempotency key.
    await postTaskCommentOpenApiOrCookie(tbTaskId, comment, "markdown", [token], operation);
    log("system", "info", "teambition", `附件已上传并挂到任务: ${fileName}`);
    return { ok: true, fileName, fileToken: token };
  } catch (e) {
    log("system", "warn", "teambition", `附件上传失败 ${fileName}: ${e.message}`);
    return { ok: false, error: `附件上传失败: ${e.message}` };
  }
}

/**
 * 按 CARB 编号或 taskId 精准查找任务（开放平台 API）
 * 支持: CARB-11080 / 11080 / MongoDB ObjectId
 */
export async function searchTask(query) {
  const input = query.trim();

  // 1. 提取 uniqueId 数字（CARB-11080 → 11080）
  const uidMatch = input.match(/^(?:CARB-)?(\d+)$/i);
  const uniqueIdNum = uidMatch ? parseInt(uidMatch[1]) : null;

  // 2. 如果是 ObjectId 格式，直接按 taskId 查
  if (/^[a-f0-9]{24}$/.test(input)) {
    try {
      const d = await tbAPI("GET", `/api/task/query?taskId=${input}`);
      if (d.result?.[0]) return d.result[0];
    } catch {}
    try {
      const task = await cookieTaskDetail(input);
      if (task && (task._id || task.id || task.taskId)) return task;
    } catch {}
  }

  // 3. 按 uniqueId 在白名单项目中查找
  if (uniqueIdNum) {
    const cookieMatch = await findCookieTaskByUniqueId(uniqueIdNum).catch(() => null);
    if (cookieMatch) return cookieMatch;

    const projectIds = getTbProjectIds().length > 0 ? getTbProjectIds() : await getOrgProjectIds();
    for (const pid of projectIds) {
      for (const isDone of ["false", "true"]) {
        let pageToken = null;
        for (let page = 0; page < 20; page++) {
          let path = `/api/task/query?projectId=${pid}&pageSize=200&isDone=${isDone}`;
          if (pageToken) path += `&pageToken=${encodeURIComponent(pageToken)}`;
          try {
            const d = await tbAPI("GET", path);
            const tasks = d.result || [];
            const match = tasks.find(t => String(t.uniqueId || t.unique_id || "") === String(uniqueIdNum));
            if (match) return match;
            pageToken = d.nextPageToken || "";
            if (!pageToken || tasks.length === 0) break;
          } catch { break; }
        }
      }
    }
    if (tbCookie()) {
      for (const pid of projectIds) {
        try {
          const candidates = listUniqueTasks(await listCookieTaskSearchCandidates(pid, { maxPages: 20 }));
          const match = candidates.find((task) => {
            const uniqueId = task?.uniqueId || task?.unique_id || task?.displayId || task?.display_id || task?.raw?.uniqueId || task?.raw?.unique_id;
            return String(uniqueId || "") === String(uniqueIdNum);
          });
          if (match) return taskCandidateView(match);
        } catch {}
      }
    }
  }

  return null;
}

async function findCookieTaskByUniqueId(uniqueIdNum) {
  if (!tbCookie() || !uniqueIdNum) return null;
  const data = await cookieGetJson(`https://www.teambition.com/api/v2/tasks/search?uniqueId=${encodeURIComponent(uniqueIdNum)}&uniqueIdPrefix=CARB`);
  const tasks = taskSearchList(data);
  const match = tasks.find((task) => {
    const uniqueId = task?.uniqueId || task?.unique_id || task?.displayId || task?.display_id || task?.raw?.uniqueId || task?.raw?.unique_id;
    return String(uniqueId || "") === String(uniqueIdNum);
  }) || tasks[0] || null;
  return match ? taskCandidateView(match) : null;
}

/**
 * Resolve one ticket strictly through the currently logged-in user's Cookie.
 * This deliberately never falls back to the application token: callers use it
 * as the authorization proof that a normal user can read the requested ticket.
 */
export async function getCurrentUserAccessibleTask(query) {
  const input = String(query || "").trim();
  const taskId = input.match(/(?:^|\/task\/)([0-9a-f]{24})(?:\/|$|[?#])/i)?.[1]
    || (/^[0-9a-f]{24}$/i.test(input) ? input : "");
  const uniqueId = input.match(/^(?:CARB-)?(\d+)$/i)?.[1] || "";
  if (!taskId && !uniqueId) return null;

  const cookie = tbCookie();
  if (!cookie) {
    throw Object.assign(new Error("Teambition 未登录，请扫码登录后重试"), {
      statusCode: 401,
      code: "TB_LOGIN_REQUIRED",
      needLogin: true,
    });
  }

  const url = taskId
    ? `https://www.teambition.com/api/tasks/${encodeURIComponent(taskId)}`
    : `https://www.teambition.com/api/v2/tasks/search?uniqueId=${encodeURIComponent(uniqueId)}&uniqueIdPrefix=CARB`;
  let response;
  try {
    response = await fetch(url, { headers: { Cookie: cookie } });
  } catch (error) {
    throw Object.assign(new Error(`读取当前用户可见 TB 单失败：${error?.message || "网络异常"}`), {
      statusCode: 502,
      code: "TB_USER_TICKET_LOOKUP_FAILED",
    });
  }
  if (response.status === 401) {
    throw Object.assign(new Error("Teambition 登录已过期，请扫码登录后重试"), {
      statusCode: 401,
      code: "TB_LOGIN_EXPIRED",
      needLogin: true,
    });
  }
  if (response.status === 403 || response.status === 404) return null;
  if (!response.ok) {
    throw Object.assign(new Error(`读取当前用户可见 TB 单失败：HTTP ${response.status}`), {
      statusCode: 502,
      code: "TB_USER_TICKET_LOOKUP_FAILED",
    });
  }

  const data = await response.json();
  const candidates = taskSearchList(data);
  const matched = taskId
    ? candidates.find((task) => taskSearchId(task).toLowerCase() === taskId.toLowerCase())
    : candidates.find((task) => String(
      task?.uniqueId || task?.unique_id || task?.displayId || task?.display_id || "",
    ) === uniqueId);
  return matched ? taskCandidateView(matched) : null;
}

/**
 * 验证 TB Cookie 是否有效
 */
export async function checkTbCookie() {
  const config = getConfig();
  const cookie = config.teambition?.userCookie;
  const health = await probeTbCookie(cookie);
  return {
    valid: health.valid,
    status: health.status,
    code: health.code,
    reason: health.reason,
    checkedAt: health.checkedAt,
    hasCookie: health.hasCookie,
    httpStatus: health.httpStatus,
    user: health.user,
    id: health.id,
  };
}

/**
 * 拉取组织全部成员（用户态 Cookie，无需管理员/应用通讯录权限）。
 * 这正是 TB 里 @ 同事时背后的接口，读的是登录用户有权看到的组织架构。
 * 返回 [{ uid, name, avatarUrl }]（uid = TB _userId，作为管理员名单主键）。带 5 分钟缓存。
 *
 * 若未配置 orgId：用 Cookie 调 /api/organizations 自动解析并回写配置（局域网部署常因云端 shared-config 不可达而缺 orgId）。
 */
let _orgMembersCache = { list: [], ts: 0, orgId: "" };

export async function listTbOrganizations(cookie) {
  const resp = await fetch("https://www.teambition.com/api/organizations?pageSize=50", {
    headers: { Cookie: cookie },
  });
  let data = null;
  try { data = await resp.json(); } catch { data = null; }
  if (resp.status === 401 || !Array.isArray(data)) {
    const err = Object.assign(new Error("Teambition 登录已过期，请扫码登录后重试"), { needLogin: true });
    throw err;
  }
  return data
    .map((o) => ({
      id: String(o?._id || o?.id || "").trim(),
      name: String(o?.name || "").trim(),
      projectCount: Array.isArray(o?.projectIds) ? o.projectIds.length : 0,
    }))
    .filter((o) => o.id);
}

async function probeOrgMemberCount(cookie, orgId) {
  try {
    const resp = await fetch(`https://www.teambition.com/api/organizations/${orgId}/members?pageSize=2000`, {
      headers: { Cookie: cookie },
    });
    let data = null;
    try { data = await resp.json(); } catch { data = null; }
    if (!resp.ok || !Array.isArray(data)) return -1;
    return data.length;
  } catch {
    return -1;
  }
}

/**
 * 解析可用的 Teambition orgId：优先配置；否则从 Cookie 组织列表自动挑选并落盘。
 */
export async function resolveTbOrgId({ cookie, persist = true } = {}) {
  const configured = String(getConfig().teambition?.orgId || "").trim();
  if (configured) return configured;
  if (!cookie) return "";

  const orgs = await listTbOrganizations(cookie);
  if (!orgs.length) return "";

  let chosen = orgs[0];
  if (orgs.length > 1) {
    let best = null;
    for (const org of orgs) {
      const score = await probeOrgMemberCount(cookie, org.id);
      if (score < 0) continue;
      if (!best || score > best.score || (score === best.score && org.projectCount > best.org.projectCount)) {
        best = { org, score };
      }
    }
    if (best) chosen = best.org;
  }

  if (persist && chosen?.id) {
    const tb = { ...(getConfig().teambition || {}), orgId: chosen.id };
    updateConfig({ teambition: tb });
    log("system", "info", "tb-members", `已自动写入 Teambition orgId（${chosen.name || chosen.id.slice(-6)}）`);
  }
  return chosen?.id || "";
}

export async function getOrgMembers({ q = "", force = false } = {}) {
  const config = getConfig();
  const cookie = config.teambition?.userCookie;
  const loginErr = (msg) => Object.assign(new Error(msg), { needLogin: true });
  if (!cookie) throw loginErr("Teambition 未登录，请扫码登录后重试");

  let orgId = String(config.teambition?.orgId || "").trim();
  if (!orgId) {
    try {
      orgId = await resolveTbOrgId({ cookie, persist: true });
    } catch (e) {
      if (e?.needLogin) throw e;
      throw new Error(`未配置 Teambition orgId，且自动解析失败：${e.message}`);
    }
  }
  if (!orgId) throw new Error("未配置 Teambition orgId（扫码登录后仍无法从账号组织列表解析，请在设置中填写 Org ID）");

  let list = _orgMembersCache.list;
  if (
    force
    || !list.length
    || _orgMembersCache.orgId !== orgId
    || Date.now() - _orgMembersCache.ts > 5 * 60 * 1000
  ) {
    const resp = await fetch(`https://www.teambition.com/api/organizations/${orgId}/members?pageSize=2000`, {
      headers: { Cookie: cookie },
    });
    // Cookie 失效时 TB 会回 401 或重定向到 HTML 登录页（json() 解析失败）
    let data = null;
    try { data = await resp.json(); } catch { data = null; }
    if (resp.status === 401 || !Array.isArray(data)) throw loginErr("Teambition 登录已过期，请扫码登录后重试");
    list = data.filter((m) => m._userId).map((m) => ({ uid: m._userId, name: m.name || m._userId, avatarUrl: m.avatarUrl || "" }));
    list.sort((a, b) => a.name.localeCompare(b.name, "zh"));
    _orgMembersCache = { list, ts: Date.now(), orgId };
    log("system", "info", "tb-members", `拉取 TB 组织成员 ${list.length} 人`);
  }

  const kw = String(q || "").trim().toLowerCase();
  return kw ? list.filter((m) => m.name.toLowerCase().includes(kw) || m.uid.toLowerCase().includes(kw)) : list;
}

/**
 * 拉取某项目 task 维度的全部自定义字段定义（用户态 Cookie）。projectId 默认首个配置项目。
 * 返回 [{ id, name, choices:[string] }]，按项目带 5 分钟缓存。
 * getAppCategories 与飞书同步（应用分类/缺陷分类字段 ID 解析）共用同一份定义与缓存。
 */
const _customFieldDefsCache = new Map(); // projectId -> { defs, ts }
const TB_CUSTOM_FIELD_REF_ID_KEYS = [
  "customfieldId",
  "customFieldId",
  "custom_field_id",
  "_customfieldId",
  "_customFieldId",
  "cfId",
  "_cfId",
];
const TB_CUSTOM_FIELD_SELF_ID_KEYS = ["_id", "id", "customfield_id", "customField_id"];
const TB_CUSTOM_FIELD_NAME_KEYS = ["name", "title", "displayName", "display_name", "label", "fieldName", "field_name"];
const TB_CUSTOM_FIELD_CHOICE_KEYS = ["choices", "options", "values"];
const TB_CUSTOM_FIELD_NESTED_KEYS = ["customfield", "customField", "custom_field"];
const TB_SCENARIO_FIELD_NESTED_KEYS = ["scenariofield", "scenarioField", "scenario_field"];

function firstStringFromKeys(obj = {}, keys = []) {
  for (const key of keys) {
    const value = obj?.[key];
    if (value === undefined || value === null) continue;
    const text = String(value).trim();
    if (text) return text;
  }
  return "";
}

function firstObjectFromKeys(obj = {}, keys = []) {
  for (const key of keys) {
    const value = obj?.[key];
    if (value && typeof value === "object" && !Array.isArray(value)) return value;
  }
  return null;
}

function hasArrayValueForKeys(obj = {}, keys = []) {
  return keys.some((key) => Array.isArray(obj?.[key]) && obj[key].length > 0);
}

function readTeambitionChoiceLabel(choice) {
  if (choice === undefined || choice === null || choice === "") return "";
  if (typeof choice !== "object") return String(choice).trim();
  return firstStringFromKeys(choice, ["value", "label", "name", "title", "displayName", "display_name", "text"]);
}

function readTeambitionChoiceId(choice) {
  if (!choice || typeof choice !== "object" || Array.isArray(choice)) return "";
  return firstStringFromKeys(choice, ["_id", "id", "valueId", "value_id", "choiceId", "choice_id", "optionId", "option_id"]);
}

function collectTeambitionChoiceEntries(obj = {}) {
  const entries = [];
  const visit = (value) => {
    if (!Array.isArray(value)) return;
    for (const choice of value) {
      const name = readTeambitionChoiceLabel(choice);
      if (!name) continue;
      entries.push({ id: readTeambitionChoiceId(choice), name });
    }
  };
  for (const key of TB_CUSTOM_FIELD_CHOICE_KEYS) visit(obj?.[key]);
  for (const key of TB_CUSTOM_FIELD_NESTED_KEYS) {
    const nested = obj?.[key];
    if (nested && typeof nested === "object") {
      for (const choiceKey of TB_CUSTOM_FIELD_CHOICE_KEYS) visit(nested?.[choiceKey]);
    }
  }
  const byKey = new Map();
  for (const entry of entries) {
    const key = `${entry.id}\u0000${entry.name}`;
    if (!byKey.has(key)) byKey.set(key, entry);
  }
  return [...byKey.values()];
}

function collectTeambitionChoiceLabels(obj = {}) {
  return uniqueStrings(collectTeambitionChoiceEntries(obj).map((entry) => entry.name));
}

function normalizeTeambitionCustomFieldDef(obj = {}, contextKey = "") {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return null;
  const context = String(contextKey || "").toLowerCase();
  const customField = firstObjectFromKeys(obj, TB_CUSTOM_FIELD_NESTED_KEYS);
  const scenarioField = firstObjectFromKeys(obj, TB_SCENARIO_FIELD_NESTED_KEYS);
  const directRefId = firstStringFromKeys(obj, TB_CUSTOM_FIELD_REF_ID_KEYS);
  const nestedRefId = firstStringFromKeys(customField || {}, [...TB_CUSTOM_FIELD_REF_ID_KEYS, ...TB_CUSTOM_FIELD_SELF_ID_KEYS]);
  const scenarioRefId = firstStringFromKeys(scenarioField || {}, TB_CUSTOM_FIELD_REF_ID_KEYS);
  const selfId = firstStringFromKeys(obj, TB_CUSTOM_FIELD_SELF_ID_KEYS);
  const looksLikeCustomField = context.includes("customfield")
    || Boolean(customField)
    || Boolean(directRefId)
    || hasArrayValueForKeys(obj, TB_CUSTOM_FIELD_CHOICE_KEYS)
    || /customfield/i.test(String(obj?.type || obj?.fieldType || obj?.field_type || obj?.kind || ""));
  const id = directRefId || nestedRefId || scenarioRefId || (looksLikeCustomField ? selfId : "");
  const name = firstStringFromKeys(obj, TB_CUSTOM_FIELD_NAME_KEYS)
    || firstStringFromKeys(customField || {}, TB_CUSTOM_FIELD_NAME_KEYS)
    || firstStringFromKeys(scenarioField || {}, TB_CUSTOM_FIELD_NAME_KEYS);
  if (!id || !name || !looksLikeCustomField) return null;
  return {
    id,
    name,
    choices: collectTeambitionChoiceLabels(obj),
    choiceEntries: collectTeambitionChoiceEntries(obj),
  };
}

function mergeTeambitionCustomFieldDefs(defs = []) {
  const byKey = new Map();
  for (const def of defs) {
    const id = String(def?.id || def?._id || def?.customfieldId || "").trim();
    const name = String(def?.name || "").trim();
    if (!id || !name) continue;
    const key = id || name;
    const prev = byKey.get(key);
    if (!prev) {
      byKey.set(key, {
        id,
        name,
        choices: uniqueStrings(def?.choices || []),
        choiceEntries: mergeTeambitionChoiceEntries(def?.choiceEntries || []),
      });
      continue;
    }
    prev.name = prev.name || name;
    prev.choices = uniqueStrings([...(prev.choices || []), ...(def?.choices || [])]);
    prev.choiceEntries = mergeTeambitionChoiceEntries([...(prev.choiceEntries || []), ...(def?.choiceEntries || [])]);
  }
  return Array.from(byKey.values());
}

function mergeTeambitionChoiceEntries(entries = []) {
  const byName = new Map();
  for (const entry of entries) {
    const id = String(entry?.id || entry?._id || "").trim();
    const name = String(entry?.name || entry?.title || entry?.label || "").trim();
    if (!name) continue;
    const key = name.toLowerCase();
    const prev = byName.get(key);
    if (!prev || (!prev.id && id)) byName.set(key, { id, name });
  }
  return [...byName.values()];
}

function collectTeambitionCustomFieldDefs(payload, contextKey = "") {
  const defs = [];
  const seen = new WeakSet();
  const visit = (value, key = contextKey, depth = 0) => {
    if (!value || depth > 8) return;
    if (Array.isArray(value)) {
      for (const item of value) visit(item, key, depth + 1);
      return;
    }
    if (typeof value !== "object") return;
    if (seen.has(value)) return;
    seen.add(value);
    const def = normalizeTeambitionCustomFieldDef(value, key);
    if (def) defs.push(def);
    for (const [childKey, childValue] of Object.entries(value)) {
      if (childValue && typeof childValue === "object") visit(childValue, childKey, depth + 1);
    }
  };
  visit(payload, contextKey, 0);
  return mergeTeambitionCustomFieldDefs(defs);
}

async function fetchTeambitionCookieJson(url, cookie, loginErr, { required = false } = {}) {
  const resp = await fetch(url, { headers: { Cookie: cookie, Accept: "application/json" } });
  const data = await readJsonResponse(resp);
  if (resp.status === 401) throw loginErr("Teambition 登录已过期，请扫码登录后重试");
  if (!resp.ok) {
    if (required) throw new Error(`Teambition custom field defs HTTP ${resp.status}: ${clip(data?.message || data?.error || data?.raw || JSON.stringify(data || {}), 240)}`);
    return null;
  }
  if (data?.raw && /<html|<!doctype/i.test(String(data.raw))) {
    if (required) throw loginErr("Teambition 登录已过期，请扫码登录后重试");
    return null;
  }
  return data;
}

export async function listTeambitionTaskCustomFieldDefs({ force = false, projectId } = {}) {
  const pid = projectId || defaultProjectId();
  const cookie = getConfig().teambition?.userCookie;
  const loginErr = (m) => Object.assign(new Error(m), { needLogin: true });
  if (!cookie) throw loginErr("Teambition 未登录，请扫码登录后重试");
  const cached = _customFieldDefsCache.get(pid);
  if (!force && cached && Date.now() - cached.ts < 5 * 60 * 1000) return cached.defs;
  const encodedPid = encodeURIComponent(pid);
  const sources = [
    {
      context: "customfields",
      required: true,
      url: `https://www.teambition.com/api/customfields?_projectId=${encodedPid}&_boundToObjectType=task`,
    },
    {
      context: "scenariofieldconfigs",
      url: `https://www.teambition.com/api/v2/projects/${encodedPid}/scenariofieldconfigs?objectType=task&withTaskflowstatus=true&withCustomfields=true`,
    },
    {
      context: "scenariofields",
      url: `https://www.teambition.com/api/projects/${encodedPid}/scenariofields/search?scope=taskTableHeader&pageSize=2000`,
    },
    {
      context: "customfieldlinks",
      url: `https://www.teambition.com/api/projects/${encodedPid}/customfieldlinks?boundType=application&withRootCommongroup=true`,
    },
    {
      context: "appscenariofieldconfigs",
      url: `https://www.teambition.com/api/projects/${encodedPid}/appscenariofieldconfigs`,
    },
  ];
  const collected = [];
  for (const source of sources) {
    try {
      const data = await fetchTeambitionCookieJson(source.url, cookie, loginErr, { required: source.required });
      if (data) collected.push(...collectTeambitionCustomFieldDefs(data, source.context));
    } catch (err) {
      if (source.required || err?.needLogin) throw err;
      log("system", "debug", "tb-customfield", `读取字段定义补充来源失败: ${source.context} ${err.message}`);
    }
  }
  const defs = mergeTeambitionCustomFieldDefs(collected);
  _customFieldDefsCache.set(pid, { defs, ts: Date.now() });
  log("system", "info", "tb-customfield", `拉取自定义字段定义 ${defs.length} 个（项目 ${pid}）`);
  return defs;
}

/**
 * 拉取某项目的「应用分类」自定义字段选项（用户态 Cookie）。projectId 默认首个配置项目。
 * 返回 [string]（如 App Market / Media Space / Voice …）。复用 listTeambitionTaskCustomFieldDefs 的缓存。
 */
export async function getAppCategories({ force = false, projectId } = {}) {
  const defs = await listTeambitionTaskCustomFieldDefs({ force, projectId });
  const field = defs.find((f) => f.name === "应用分类");
  if (!field) throw new Error("未找到「应用分类」自定义字段");
  return field.choices;
}

// ===== 关键词映射：从 TB 单提取各类 key（用户态 Cookie）=====
function tbCookieOrThrow() {
  const cookie = getConfig().teambition?.userCookie;
  if (!cookie) throw Object.assign(new Error("Teambition 未登录，请扫码登录后重试"), { needLogin: true });
  return cookie;
}
async function tbGet(path) {
  const cookie = tbCookieOrThrow();
  const r = await fetch(`https://www.teambition.com${path}`, { headers: { Cookie: cookie } });
  let d = null; try { d = await r.json(); } catch { d = null; }
  if (r.status === 401) throw Object.assign(new Error("Teambition 登录已过期，请扫码登录后重试"), { needLogin: true });
  if (!r.ok) {
    const detail = String(d?.message || d?.error?.message || d?.error || r.statusText || "").trim();
    const suffix = detail ? `：${detail}` : "";
    throw Object.assign(new Error(`Teambition 请求失败（HTTP ${r.status}）${suffix}`), { status: r.status });
  }
  return d;
}

export async function deleteTeambitionTask(taskId) {
  const id = String(taskId || "").trim();
  if (!id) throw new Error("Teambition taskId is required to delete a task");
  const cookie = tbCookieOrThrow();
  const attempts = [
    `https://www.teambition.com/api/tasks/${encodeURIComponent(id)}`,
    `https://www.teambition.com/api/v2/tasks/${encodeURIComponent(id)}`,
  ];
  let lastError = null;
  for (const url of attempts) {
    const resp = await fetch(url, {
      method: "DELETE",
      headers: { Cookie: cookie, Accept: "application/json" },
    });
    const data = await readJsonResponse(resp);
    if (resp.status === 401) throw Object.assign(new Error("Teambition 登录已过期，请扫码登录后重试"), { needLogin: true });
    if (resp.ok) return unwrapTeambitionResult(data) || { ok: true, id };
    lastError = new Error(`Teambition delete task failed HTTP ${resp.status}: ${clip(data?.message || data?.error || data?.raw || JSON.stringify(data || {}), 240)}`);
    if (![404, 405].includes(resp.status)) break;
  }
  throw lastError || new Error("Teambition delete task failed");
}

// 列出当前用户可见的 TB 项目（用户态 Cookie）—— 供"项目列表"设置选择。返回 [{id,name}]。
export async function listOrgProjects() {
  const orgId = getConfig().teambition?.orgId || "";
  const candidates = [
    orgId ? `/api/organizations/${orgId}/projects?pageSize=200` : null,
    `/api/projects?pageSize=200`,
    `/api/v2/projects`,
  ].filter(Boolean);
  for (const path of candidates) {
    try {
      const d = await tbGet(path);
      const arr = Array.isArray(d) ? d : (d?.result || d?.projects);
      if (Array.isArray(arr) && arr.length) {
        return arr.filter((p) => p && (p._id || p.id)).map((p) => ({ id: String(p._id || p.id), name: String(p.name || p._id || p.id) }));
      }
    } catch (e) { if (e.needLogin) throw e; }
  }
  return [];
}

export async function repairTbProjectNames(projectList = null) {
  const cfg = getConfig();
  const tb = cfg.teambition || {};
  const projects = (Array.isArray(projectList) ? projectList : tb.projects || []).filter((p) => p && p.id);
  if (!projects.length) return getTbProjects(projectList);

  let fixed = projects.map((p) => {
    return normalizeTbProject(p);
  });

  if (fixed.some((p) => p.name === p.id)) {
    try {
      const available = await listOrgProjects();
      const names = new Map((available || []).map((p) => [String(p.id), String(p.name || "").trim()]));
      fixed = fixed.map((p) => {
        const remoteName = names.get(p.id);
        if (remoteName && !isBrokenProjectName(remoteName) && remoteName !== p.name) {
          return { ...p, name: remoteName };
        }
        return p;
      });
    } catch {}
  }

  return fixed;
}

// 从标题提取【】/[]里的关键词
export function extractTitleKeywords(title) {
  const out = [];
  for (const m of String(title || "").matchAll(/[【\[]([^】\]]+)[】\]]/g)) {
    const k = m[1].trim();
    if (k && !out.includes(k)) out.push(k);
  }
  return out;
}

// 项目标签列表（projectId 默认首个配置项目）
export async function listProjectTags(projectId) {
  const pid = projectId || defaultProjectId();
  let d = null;
  let lastError = null;
  let resolved = false;
  for (const endpoint of [
    `/api/tags?tagType=project&_projectId=${encodeURIComponent(pid)}`,
    `/api/projects/${encodeURIComponent(pid)}/tags`,
  ]) {
    try {
      d = await tbGet(endpoint);
      if (Array.isArray(d) || Array.isArray(d?.result) || Array.isArray(d?.tags)) {
        resolved = true;
        break;
      }
    } catch (error) {
      lastError = error;
    }
  }
  if (!resolved) throw lastError || new Error(`Teambition 项目 ${pid} 未返回标签列表`);
  const rows = Array.isArray(d) ? d : (d?.result || d?.tags || []);
  const byId = new Map();
  for (const tag of Array.isArray(rows) ? rows : []) {
    const id = String(tag?._id || tag?.id || tag?.tagId || "").trim();
    const name = String(tag?.name || tag?.title || tag?.label || "").trim();
    if (!id || !name) continue;
    byId.set(id, { id, name });
  }
  return [...byId.values()];
}

// 项目标签名列表（projectId 默认首个配置项目）
export async function getProjectTags(projectId) {
  return [...new Set((await listProjectTags(projectId)).map((tag) => tag.name).filter(Boolean))];
}

function directTaskTagNames(detail = {}) {
  const values = [detail.tags, detail.labels, detail.tagNames].flatMap((value) => (
    Array.isArray(value) ? value : value == null || value === "" ? [] : [value]
  ));
  return uniqueStrings(values.map((value) => (
    value && typeof value === "object"
      ? value.name || value.title || value.label || value.value || ""
      : value
  )));
}

export async function getTaskTagNames(detail = {}) {
  const directNames = directTaskTagNames(detail);
  const tagIds = uniqueStrings([
    ...normalizeCookieStringList(detail.tagIds),
    ...normalizeCookieStringList(detail._tagIds),
  ]);
  if (!tagIds.length) return directNames;
  const projectId = String(detail.projectId || detail._projectId || detail.project?._id || detail.project?.id || "").trim();
  if (!projectId) return directNames;
  const byId = new Map((await listProjectTags(projectId)).map((tag) => [tag.id, tag.name]));
  return uniqueStrings([...directNames, ...tagIds.map((id) => byId.get(id))]);
}
// 项目迭代(sprint)名列表
export async function getProjectSprints(projectId) {
  return [...new Set((await listProjectSprints(projectId)).map((s) => s.name).filter(Boolean))];
}

export async function listProjectSprints(projectId) {
  const pid = projectId || defaultProjectId();
  const byId = new Map();
  const paths = [
    `/api/projects/${pid}/sprints`,
    `/api/projects/${pid}/sprints?status=active`,
    `/api/projects/${pid}/sprints?status=future`,
  ];
  for (const path of paths) {
    try {
      const d = await tbGet(path);
      for (const sprint of tbArray(d).map((s) => normalizeProjectSprint(s, pid))) {
        if (sprint.id && sprint.name) byId.set(sprint.id, { ...(byId.get(sprint.id) || {}), ...sprint });
      }
    } catch {}
  }
  return [...byId.values()];
}

export async function getProjectSprint(sprintId, projectId = "") {
  const id = String(sprintId || "").trim();
  if (!id) return null;
  try {
    const d = await tbGet(`/api/sprints/${encodeURIComponent(id)}`);
    const actualProjectId = trainingTaskProjectId(d);
    if (projectId && actualProjectId && actualProjectId.toLowerCase() !== String(projectId).toLowerCase()) return null;
    const sprint = normalizeProjectSprint(d, actualProjectId || projectId);
    return sprint.id ? sprint : null;
  } catch {
    return null;
  }
}

function normalizeProjectSprint(s = {}, projectId = "") {
  const id = String(s._id || s.id || s.sprintId || s.sprint_id || "").trim();
  const name = String(s.name || s.title || "").trim();
  return {
    id,
    sprintId: id,
    name,
    title: name,
    projectId: String(s._projectId || s.projectId || projectId || "").trim(),
    status: String(s.status || "").trim(),
    dueDate: dateOnly(s.dueDate || s.endDate || s.endTime),
    startDate: dateOnly(s.startDate || s.startTime),
    url: id && projectId ? `https://www.teambition.com/project/${projectId}/sprint/section/${id}` : "",
    raw: s,
  };
}
// 项目关键词 key = "项目名>任务列表名"。
// TB 单"项目"栏显示 项目>任务列表(如 平台组件>阿维塔_8678平台_应用市场)，任务列表即更细分的"项目"。
export async function listProjectTasklists(projectId) {
  const pid = projectId || defaultProjectId();
  const byId = new Map();
  for (const path of [`/api/projects/${pid}/tasklists`, `/api/tasklists?_projectId=${pid}`]) {
    try {
      const d = await tbGet(path);
      for (const tasklist of tbArray(d).map((item) => normalizeProjectTasklist(item, pid))) {
        if (tasklist.id && tasklist.name) byId.set(tasklist.id, { ...(byId.get(tasklist.id) || {}), ...tasklist });
      }
    } catch {}
  }
  return [...byId.values()];
}

export async function getProjectTasklist(tasklistId, projectId = "") {
  const id = String(tasklistId || "").trim();
  if (!id) return null;
  try {
    const d = await tbGet(`/api/tasklists/${encodeURIComponent(id)}`);
    const actualProjectId = trainingTaskProjectId(d);
    if (projectId && actualProjectId && actualProjectId.toLowerCase() !== String(projectId).toLowerCase()) return null;
    const tasklist = normalizeProjectTasklist(d, actualProjectId || projectId);
    return tasklist.id ? tasklist : null;
  } catch {
    return null;
  }
}

function normalizeProjectTasklist(tasklist = {}, projectId = "") {
  const id = String(tasklist._id || tasklist.id || tasklist.tasklistId || tasklist.tasklist_id || "").trim();
  const name = String(tasklist.title || tasklist.name || "").trim();
  return {
    id,
    tasklistId: id,
    name,
    title: name,
    projectId: String(tasklist._projectId || tasklist.projectId || projectId || "").trim(),
    url: id && projectId ? `https://www.teambition.com/project/${projectId}/tasks/scrum/field/${id}` : "",
    raw: tasklist,
  };
}

export async function listProjectMembers(projectId) {
  const pid = projectId || defaultProjectId();
  const d = await tbGet(`/api/v4/projects/${pid}/members?users=1&all=true&_projectId=${pid}&pageSize=500&needCount=true`);
  return tbArray(d).map(normalizeProjectMember).filter((member) => member.id && member.name);
}

function normalizeProjectMember(member = {}) {
  const user = member.user && typeof member.user === "object" ? member.user : {};
  const id = String(
    member._userId
    || member.userId
    || member.uid
    || user._id
    || user.id
    || member._id
    || member.id
    || "",
  ).trim();
  const name = String(
    member.name
    || member.displayName
    || member.nick
    || user.name
    || user.displayName
    || user.nick
    || "",
  ).trim();
  return {
    id,
    uid: id,
    name,
    avatarUrl: member.avatarUrl || user.avatarUrl || "",
    raw: member,
  };
}

export async function getProjectKeywordKeys(projectId) {
  const pid = projectId || defaultProjectId();
  let projName = getTbProjects().find((p) => p.id === pid)?.name;
  if (!projName) { const proj = await tbGet(`/api/projects/${pid}`); projName = proj?.name || pid; }
  const tls = await tbGet(`/api/projects/${pid}/tasklists`);
  const titles = Array.isArray(tls) ? [...new Set(tls.map((t) => String(t.title || t.name || "").trim()).filter(Boolean))] : [];
  return titles.map((t) => `${projName}>${t}`);
}
// 扫任务标题，汇总【】关键词（count 控制扫描数量）
export async function getTitleKeywords(count = 200, projectId) {
  const d = await tbGet(`/api/projects/${projectId || defaultProjectId()}/tasks?count=${count}`);
  const set = new Set();
  if (Array.isArray(d)) for (const t of d) for (const k of extractTitleKeywords(t.content || t.title || "")) set.add(k);
  return [...set];
}

/**
 * 读取当前 Cookie 对应的 TB 登录用户（用于 TB 身份登录管理后台）。
 * 返回 { uid, name } 或 null。
 */
export async function getTbMe() {
  const cookie = getConfig().teambition?.userCookie;
  if (!cookie) return null;
  try {
    const resp = await fetch("https://www.teambition.com/api/users/me", { headers: { Cookie: cookie } });
    const d = await resp.json();
    const uid = d._id || d.id;
    return uid ? { uid, name: d.name || uid } : null;
  } catch { return null; }
}

/**
 * 检测 Teambition 是否已配置且可用
 */
export async function checkTeambitionStatus() {
  const config = getConfig();
  const tb = config.teambition || {};
  const appId = tb.appId || config.dingtalkAppKey || "";
  const appSecret = tb.appSecret || config.dingtalkAppSecret || "";
  const orgId = tb.orgId || "";

  if (!appId || !appSecret || !orgId) {
    const cookie = await checkTbCookie();
    if (cookie.valid) return { available: true, source: "cookie", user: cookie.user, openApiReason: "open-api not configured" };
    return { available: false, reason: "未配置" };
  }

  try {
    await getAppToken();
    return { available: true, source: "open-api" };
  } catch (err) {
    const cookie = await checkTbCookie();
    if (cookie.valid) return { available: true, source: "cookie", user: cookie.user, openApiReason: err.message };
    return { available: false, reason: err.message };
  }
}

async function postTaskCommentOpenApiOrCookie(taskId, content, renderMode = "markdown", fileTokens = [], _operation = null) {
  // Teambition does not currently expose a native idempotency header/body
  // field for this endpoint. `_operation` is intentionally carried through
  // the adapter contract while durable single-owner enforcement happens in
  // the SQLite outbox before this function is entered.
  const options = normalizeTaskCommentOptions(renderMode, fileTokens);
  if (!taskId) throw new Error("Teambition taskId is required to post a comment");
  const body = {
    taskId,
    content: String(content || ""),
    renderMode: options.renderMode || "markdown",
    fileTokens: Array.isArray(options.fileTokens) ? options.fileTokens : [],
    attachments: Array.isArray(options.attachments) ? options.attachments : [],
  };
  const path = renderTaskPath(
    options.pathTemplate || getConfig().feishuProjectSync?.teambition?.commentPathTemplate || "/api/v3/task/{taskId}/comment",
    taskId,
  );

  if (options.transport !== "cookie" && hasTeambitionOpenApiCredentials()) {
    try {
      const data = await tbAPI("POST", path, body);
      return unwrapTeambitionResult(data);
    } catch (err) {
      if (options.transport === "openapi" || !tbCookie()) throw err;
      log("system", "warn", "teambition", `OpenAPI comment failed, falling back to cookie: ${err.message}`);
    }
  }

  return postTaskCommentByCookie(taskId, content, options.renderMode, options.fileTokens);
}

function normalizeTaskCommentOptions(renderMode, fileTokens) {
  if (renderMode && typeof renderMode === "object" && !Array.isArray(renderMode)) {
    return {
      renderMode: renderMode.renderMode || "markdown",
      fileTokens: renderMode.fileTokens || [],
      attachments: renderMode.attachments || [],
      pathTemplate: renderMode.pathTemplate || "",
      transport: renderMode.transport || "",
    };
  }
  return {
    renderMode: renderMode || "markdown",
    fileTokens: Array.isArray(fileTokens) ? fileTokens : [],
    attachments: [],
    pathTemplate: "",
    transport: "",
  };
}

function renderTaskPath(pathTemplate, taskId) {
  return String(pathTemplate || "").replace(/\{taskId\}/g, encodeURIComponent(taskId));
}

function hasTeambitionOpenApiCredentials() {
  const config = getConfig();
  const tb = config.teambition || {};
  const appId = tb.appId || config.dingtalkAppKey || "";
  const appSecret = tb.appSecret || config.dingtalkAppSecret || "";
  return !!(appId && appSecret && tb.orgId);
}

async function postTaskCommentByCookie(taskId, content, renderMode = "markdown", fileTokens = []) {
  const cookie = tbCookie();
  if (!cookie) throw new Error("Teambition comment requires OpenAPI credentials or a TB Cookie");
  const body = {
    content: String(content || ""),
    attachments: [],
    fileTokens: Array.isArray(fileTokens) ? fileTokens : [],
    dingFiles: [],
    renderMode: renderMode || "markdown",
    isOnlyNotifyMentions: false,
    mentions: {},
    mentionedTeams: [],
    mentionedGroups: [],
  };
  const r = await fetch(`https://www.teambition.com/api/v2/tasks/${encodeURIComponent(taskId)}/activities`, {
    method: "POST",
    headers: { Cookie: cookie, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    const t = await r.text().catch(() => "");
    throw new Error(`Teambition comment failed HTTP ${r.status}: ${t.slice(0, 160)}`);
  }
  return { ok: true };
}

function clip(value, max = 500) {
  const text = String(value ?? "");
  return text.length <= max ? text : `${text.slice(0, max)}...`;
}
