import React, { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { getApiUrl, getGatewayUrl, setGatewayUrl, startTbTasksLogin, openRemoteBrowserViewer } from "../services/gateway.js";
import { authenticatedFetch, getAdminToken, useAdminSession } from "../services/adminAuth.js";
import {
  buildFeishuFilterBackup,
  filterFeishuFieldChoices,
  filterValueChoices,
  nextFilterForSelectedField,
  parseFeishuFilterBackup,
} from "./feishuProjectSyncFilterConfig.js";
import {
  isHiddenFeishuSyncRecord,
  sortFeishuSyncRecords,
} from "./feishuProjectSyncRecords.js";
import {
  createFeishuProjectSyncLoader,
  feishuMcpConnectionStatus,
} from "./feishuProjectSyncLoadModel.js";
import {
  FEISHU_SOURCE_VIEW_URL_EXAMPLE as DEFAULT_FEISHU_SOURCE_VIEW_URL,
  addFeishuSourceView,
  applySourceViewsToConfig,
  normalizeFeishuSourceViewForUi,
  normalizeFeishuSourceViewsForUi,
  removeFeishuSourceView,
  setDefaultFeishuSourceView,
  sourceViewControlAriaLabels,
  sourceViewUrl,
  sourceViewValidationIssues,
  sourceViewsForRequest,
  sourceViewsSummary,
  toggleFeishuSourceView,
  updateFeishuSourceView,
  validateFeishuSourceViewUrl,
} from "./feishuProjectSyncSourceViews.js";
import {
  createFeishuRecordsRefreshResult,
  feishuRecordsRefreshLogId,
  feishuRecordsRefreshResultView,
  feishuRecordsRefreshStatus,
} from "./feishuProjectSyncRefreshResult.js";
import FeishuSyncPolicyPanel from "./FeishuSyncPolicyPanel.jsx";
import {
  TB_PRIORITY_DISPLAY_NAMES,
  policyEntityDisplayName,
  policyRoutingForUi,
  policyRuleSummary,
  policyRulesByPriority,
  policyTargetSummary,
} from "./feishuProjectSyncPolicyModel.js";

const API = "/api/feishu-project-sync";
const MAX_RENDERED_RUN_EVENTS = 120;
const RUN_EVENT_FLUSH_MS = 120;
const PREVIEW_FORMAT_DELAY_MS = 16;
const PREVIEW_FORMAT_WORKER_TIMEOUT_MS = 30000;
const RUN_CONFIRM_DELAY_MS = 2000;
const DELETE_RECORDS_CONFIRM_DELAY_MS = 2000;
const CLEAR_RECORDS_CONFIRM_DELAY_MS = 3000;
const PREVIEW_WORK_ITEM_IDS_STORAGE_KEY = "feishu_project_sync_preview_work_item_ids";
const FEISHU_AUTH_MODE_STORAGE_KEY = "feishu_project_sync_auth_mode";
const TABS = [
  { id: "sync", label: "同步执行" },
  { id: "config", label: "配置与规则" },
  { id: "preview", label: "结果预览" },
  { id: "errors", label: "错误重试" },
];

const DEFAULT_FEISHU_TASK_SHEET_URL = "https://hcn8isyrecyp.feishu.cn/sheets/Y9Gys3Ps5hiu1HtjCHaciDwenNf";
const DEFAULT_FEISHU_OWNER_FILTER_VALUES = ["阳荣峰", "徐博超", "彭俊维", "冯国梁"];
const DEFAULT_FEISHU_OWNER_FILTER = {
  id: "problem-owner-role",
  enabled: true,
  kind: "role",
  fieldKey: "role_bd6222",
  fieldName: "问题责任人（角色）",
  operator: "containsAny",
  operatorLabel: "存在选项属于",
  values: DEFAULT_FEISHU_OWNER_FILTER_VALUES,
};
const FEISHU_FILTER_OPERATORS = [
  { value: "containsAny", label: "存在选项属于" },
  { value: "notContainsAny", label: "不存在选项属于" },
  { value: "exists", label: "有值" },
  { value: "empty", label: "为空" },
];

const MISSING_LABELS = {
  "feishu.pluginId": "飞书项目插件 Plugin ID",
  "feishu.pluginSecret": "飞书项目插件 Plugin Secret",
  "feishu.userKey": "飞书项目操作用户 User Key",
  "feishu.spaceKey": "飞书项目 Space Key",
  "feishu.workItemTypeKey": "飞书工单类型 Work Item Type Key",
  "feishu.sourceViews": "飞书工单来源视图",
  "feishu.web.homepageUrl": "飞书项目个人网页登录 URL",
  "feishu.mcp": "飞书项目 MCP 连接配置",
  "teambition.projectId": "TB 测试项目",
  "teambition.sprintId": "TB 目标迭代",
  "teambition.tasklistId": "TB 任务列表",
  "teambition.stageId": "TB 阶段",
  "teambition.taskflowstatusId": "TB 状态",
};

const FEISHU_WEB_PROFILE_WARNING = "你普通浏览器已登录不一定等于这个项目的 Puppeteer profile 已登录；需要在页面点飞书网页登录，或调用 /web-login，用弹出的受控浏览器切到正确租户后再跑 source=web dry-run。";
const FEISHU_AUTH_MODE_OPTIONS = [
  {
    value: "web",
    label: "网页登录态",
    shortLabel: "Web",
    detail: "用本项目的 Puppeteer profile 读取飞书网页详情，能拿到网页上看到的字段。",
  },
  {
    value: "mcp",
    label: "MCP",
    shortLabel: "MCP",
    detail: "通过飞书 MCP Server 读取，适合授权链路稳定时使用。",
  },
  {
    value: "plugin",
    label: "OpenAPI",
    shortLabel: "OpenAPI",
    detail: "通过插件凭据读取开放接口字段，依赖 Plugin ID/Secret/User Key。",
  },
];
const FEISHU_PLUGIN_MISSING_KEYS = new Set(["feishu.pluginId", "feishu.pluginSecret", "feishu.userKey"]);

let previewFormatWorker = null;
let previewFormatRequestSeq = 0;

function authHeaders() {
  const token = getAdminToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

async function api(path, { method = "GET", body, auth = false, timeoutMs = 0 } = {}) {
  const headers = { ...(body !== undefined ? { "Content-Type": "application/json" } : {}), ...(auth ? authHeaders() : {}) };
  const apiPath = `${API}${path}`;
  const requestBody = body === undefined ? undefined : JSON.stringify(body);
  const requestJson = async (url, retryTimeoutMs = timeoutMs) => {
    const controller = new AbortController();
    const timer = retryTimeoutMs > 0 ? setTimeout(() => controller.abort(), retryTimeoutMs) : null;
    let resp;
    try {
      resp = await fetch(url, {
        method,
        headers,
        body: requestBody,
        signal: retryTimeoutMs > 0 ? controller.signal : undefined,
      });
    } catch (err) {
      if (err?.name === "AbortError") throw new Error(`请求超时：${path}`);
      throw err;
    } finally {
      if (timer) clearTimeout(timer);
    }
    let data;
    try { data = await resp.json(); } catch { data = { success: false, error: `HTTP ${resp.status}` }; }
    if (!resp.ok || data.success === false) {
      const err = new Error(data.error || `HTTP ${resp.status}`);
      err.status = resp.status;
      err.data = data.data && typeof data.data === "object" ? { ...data.data } : {};
      if (data.refreshLogId && !err.data.refreshLogId) err.data.refreshLogId = data.refreshLogId;
      err.refreshLogId = err.data.refreshLogId || "";
      err.needLogin = !!data.needLogin;
      throw err;
    }
    return data.data;
  };

  const primaryUrl = getApiUrl(apiPath);
  try {
    return await requestJson(primaryUrl);
  } catch (err) {
    if (!shouldRetrySameOrigin(path, method, body, err, primaryUrl)) throw err;
    try {
      const data = await requestJson(apiPath, Math.max(timeoutMs || 0, 15000));
      rememberSameOriginGateway();
      return data;
    } catch {
      throw err;
    }
  }
}

function shouldRetrySameOrigin(path, method, body, err, primaryUrl) {
  if (method !== "GET" || body !== undefined) return false;
  return shouldRetrySameOriginUrl(err, primaryUrl);
}

function shouldRetrySameOriginUrl(err, primaryUrl) {
  const message = String(err?.message || err || "");
  if (!/请求超时|Failed to fetch|NetworkError|Load failed/i.test(message)) return false;
  const gatewayUrl = getGatewayUrl();
  if (!gatewayUrl || typeof window === "undefined" || !/^https?:$/i.test(window.location.protocol)) return false;
  try {
    return new URL(primaryUrl, window.location.origin).origin !== window.location.origin;
  } catch {
    return true;
  }
}

function rememberSameOriginGateway() {
  try {
    if (/^https?:$/i.test(window.location.protocol)) setGatewayUrl(window.location.origin);
  } catch {}
}

function isFeishuSheetLoginError(err) {
  return !!err?.needLogin;
}

function feishuSheetLoginMessage(err) {
  const base = err?.message || "飞书在线表格需要登录或切换用户";
  return `${base}。请在弹出的飞书窗口切换到有表格权限的用户，完成后会自动继续写入。`;
}

function readPreviewWorkItemIdsDraft() {
  try {
    return typeof localStorage !== "undefined" ? localStorage.getItem(PREVIEW_WORK_ITEM_IDS_STORAGE_KEY) || "" : "";
  } catch {
    return "";
  }
}

function rememberPreviewWorkItemIdsDraft(value) {
  try {
    if (typeof localStorage === "undefined") return;
    const text = String(value ?? "");
    if (text.trim()) localStorage.setItem(PREVIEW_WORK_ITEM_IDS_STORAGE_KEY, text);
    else localStorage.removeItem(PREVIEW_WORK_ITEM_IDS_STORAGE_KEY);
  } catch {}
}

function normalizeFeishuAuthMode(value) {
  const mode = String(value || "").trim().toLowerCase();
  return FEISHU_AUTH_MODE_OPTIONS.some((option) => option.value === mode) ? mode : "";
}

function readRememberedFeishuAuthMode() {
  try {
    return typeof localStorage !== "undefined" ? normalizeFeishuAuthMode(localStorage.getItem(FEISHU_AUTH_MODE_STORAGE_KEY)) : "";
  } catch {
    return "";
  }
}

function rememberFeishuAuthMode(value) {
  const mode = normalizeFeishuAuthMode(value);
  try {
    if (typeof localStorage === "undefined") return mode;
    if (mode) localStorage.setItem(FEISHU_AUTH_MODE_STORAGE_KEY, mode);
    else localStorage.removeItem(FEISHU_AUTH_MODE_STORAGE_KEY);
  } catch {}
  return mode;
}

function applyRememberedFeishuAuthMode(config = {}) {
  const mode = readRememberedFeishuAuthMode();
  return mode ? setPath(config || {}, "feishu.authMode", mode) : config;
}

async function fetchJsonWithTimeout(url, { timeoutMs = 8000, ...options } = {}) {
  const controller = new AbortController();
  const timer = timeoutMs > 0 ? setTimeout(() => controller.abort(), timeoutMs) : null;
  try {
    const resp = await fetch(url, {
      ...options,
      signal: timeoutMs > 0 ? controller.signal : undefined,
    });
    const data = await resp.json().catch(() => ({}));
    return { resp, data };
  } catch (err) {
    if (err?.name === "AbortError") throw new Error("请求超时");
    throw err;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function fetchJsonWithSameOriginFallback(apiPath, { timeoutMs = 8000, ...options } = {}) {
  const primaryUrl = getApiUrl(apiPath);
  try {
    return await fetchJsonWithTimeout(primaryUrl, { timeoutMs, ...options });
  } catch (err) {
    if (!shouldRetrySameOriginUrl(err, primaryUrl)) throw err;
    try {
      const result = await fetchJsonWithTimeout(apiPath, { timeoutMs: Math.max(timeoutMs || 0, 15000), ...options });
      rememberSameOriginGateway();
      return result;
    } catch {
      throw err;
    }
  }
}

async function streamRunEvents(runId, { onRun, onEvent, isActive } = {}) {
  const resp = await fetch(getApiUrl(`${API}/runs/${encodeURIComponent(runId)}/events?includeResult=0`), {
    headers: { Accept: "text/event-stream", ...authHeaders() },
  });
  if (!resp.ok || !resp.body) throw new Error(`SSE unavailable: HTTP ${resp.status}`);
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let latest = null;

  function handleBlock(block) {
    const lines = String(block || "").split(/\r?\n/);
    let event = "message";
    const dataLines = [];
    for (const line of lines) {
      if (line.startsWith("event:")) event = line.slice(6).trim() || "message";
      else if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
    }
    if (!dataLines.length) return false;
    let data = null;
    try { data = JSON.parse(dataLines.join("\n")); } catch { return false; }
    if (event === "event") onEvent?.(data);
    if (event === "run") {
      latest = data;
      onRun?.(data);
      return data?.status && data.status !== "running";
    }
    return false;
  }

  try {
    while (!isActive || isActive()) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const blocks = buffer.split(/\n\n/);
      buffer = blocks.pop() || "";
      for (const block of blocks) {
        if (handleBlock(block)) {
          await reader.cancel().catch(() => {});
          return latest;
        }
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return latest;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function clone(value) {
  return JSON.parse(JSON.stringify(value ?? {}));
}

function setPath(obj, path, value) {
  const out = clone(obj);
  const keys = path.split(".");
  let cursor = out;
  for (let i = 0; i < keys.length - 1; i++) {
    const key = keys[i];
    if (!cursor[key] || typeof cursor[key] !== "object" || Array.isArray(cursor[key])) cursor[key] = {};
    cursor = cursor[key];
  }
  cursor[keys.at(-1)] = value;
  return out;
}

function getPath(obj, path, fallback = "") {
  return path.split(".").reduce((acc, key) => (acc == null ? acc : acc[key]), obj) ?? fallback;
}

function parseList(text) {
  return String(text || "").split(/[\n,;]+/).map((x) => x.trim()).filter(Boolean);
}

function normalizeListValue(value) {
  return Array.isArray(value) ? value.map((x) => String(x || "").trim()).filter(Boolean) : parseList(value);
}

function uniqList(values = []) {
  return Array.from(new Set((values || []).map((x) => String(x || "").trim()).filter(Boolean)));
}

function normalizeFeishuReadFiltersForUi(config = {}) {
  const rawFilters = getPath(config, "sync.readScope.filters", []);
  const filters = Array.isArray(rawFilters) && rawFilters.length ? rawFilters : [DEFAULT_FEISHU_OWNER_FILTER];
  return filters.map((filter, index) => {
    const fieldKey = String(filter?.fieldKey || filter?.key || filter?.roleId || "").trim();
    const fieldName = String(filter?.fieldName || filter?.name || filter?.roleName || fieldKey).trim();
    return {
      id: String(filter?.id || fieldKey || fieldName || `filter-${index}`).trim(),
      enabled: filter?.enabled !== false,
      kind: String(filter?.kind || (fieldKey.startsWith("role_") ? "role" : "field") || "field"),
      fieldKey,
      fieldName,
      operator: String(filter?.operator || "containsAny"),
      operatorLabel: String(filter?.operatorLabel || FEISHU_FILTER_OPERATORS.find((item) => item.value === filter?.operator)?.label || "存在选项属于"),
      values: normalizeListValue(filter?.values || filter?.optionValues || filter?.value || []),
    };
  }).filter((filter) => filter.fieldKey || filter.fieldName);
}

function feishuReadScopeFromConfig(config = {}) {
  const filters = normalizeFeishuReadFiltersForUi(config);
  return {
    match: String(getPath(config, "sync.readScope.match", "all")) === "any" ? "any" : "all",
    filters,
    sourceView: normalizeFeishuSourceViewForUi(config),
    sourceViews: sourceViewsForRequest(config),
    sort: syncSortForUi(config),
  };
}

function syncSortForUi(config = {}) {
  const raw = getPath(config, "sync.sort", []);
  const list = Array.isArray(raw) ? raw : (raw && typeof raw === "object" ? [raw] : []);
  return list.map((rule, index) => {
    const fieldKey = String(rule?.fieldKey || rule?.key || rule?.field || rule?.column || "").trim();
    const fieldName = String(rule?.fieldName || rule?.name || rule?.label || fieldKey).trim();
    const directionRaw = String(rule?.direction || rule?.order || rule?.sort || "desc").trim().toLowerCase();
    const direction = ["asc", "ascending", "1"].includes(directionRaw) ? "asc" : "desc";
    if (!fieldKey && !fieldName) return null;
    return {
      id: String(rule?.id || fieldKey || fieldName || `sort-${index}`).trim(),
      enabled: rule?.enabled !== false,
      fieldKey,
      fieldName,
      direction,
    };
  }).filter(Boolean);
}

function sortSummary(config = {}) {
  const sort = syncSortForUi(config).filter((rule) => rule.enabled !== false);
  if (!sort.length) return "跟随来源视图";
  return sort.map((rule) => `${rule.fieldName || rule.fieldKey} ${rule.direction === "asc" ? "升序" : "降序"}`).join(" / ");
}

function parseTeambitionSprintUrl(url = "") {
  try {
    const parsed = new URL(String(url || ""));
    if (!/(^|\.)teambition\.com$/i.test(parsed.hostname)) return {};
    const parts = parsed.pathname.split("/").filter(Boolean);
    const projectIndex = parts.findIndex((part) => part === "project");
    const sprintIndex = parts.findIndex((part) => part === "sprint");
    return {
      projectId: projectIndex >= 0 ? parts[projectIndex + 1] || "" : "",
      sprintId: sprintIndex >= 0 ? parts[parts.length - 1] || "" : "",
    };
  } catch {
    return {};
  }
}

function teambitionSprintUrl(projectId, sprintId) {
  const pid = String(projectId || "").trim();
  const sid = String(sprintId || "").trim();
  return pid && sid ? `https://www.teambition.com/project/${pid}/sprint/section/${sid}` : "";
}

function tbSprintForUi(config = {}) {
  const rawUrl = String(getPath(config, "teambition.sprintUrl", "") || "").trim();
  const parsed = parseTeambitionSprintUrl(rawUrl);
  const projectId = String(getPath(config, "teambition.projectId", "") || parsed.projectId || "").trim();
  const sprintId = String(getPath(config, "teambition.sprintId", "") || parsed.sprintId || "").trim();
  const name = String(getPath(config, "teambition.sprintName", "") || "").trim();
  const rawUrlMatches = rawUrl && (!parsed.sprintId || parsed.sprintId === sprintId) && (!parsed.projectId || parsed.projectId === projectId);
  return {
    projectId,
    sprintId,
    name,
    url: (rawUrlMatches ? rawUrl : "") || teambitionSprintUrl(projectId, sprintId),
  };
}

function tbSprintSummary(config = {}) {
  const sprint = tbSprintForUi(config);
  if (!sprint.sprintId && !sprint.name) return "未设置目标迭代";
  return sprint.name || "迭代名称未解析（请刷新迭代列表）";
}

function taskSheetUrl(config = {}) {
  return String(
    getPath(config, "sheetSync.url", getPath(config, "sheetSync.sheetUrl", getPath(config, "feishu.sheetSync.url", DEFAULT_FEISHU_TASK_SHEET_URL))) || "",
  ).trim();
}

function ownerFilterValues(config = {}) {
  const filters = normalizeFeishuReadFiltersForUi(config);
  const owner = filters.find((filter) => isDefaultOwnerFilter(filter));
  return owner?.values?.length ? owner.values : normalizeListValue(getPath(config, "sync.requiredAssigneeKeywords", DEFAULT_FEISHU_OWNER_FILTER_VALUES));
}

function isDefaultOwnerFilter(filter = {}) {
  return String(filter.fieldKey || "").trim() === DEFAULT_FEISHU_OWNER_FILTER.fieldKey
    || String(filter.fieldName || "").trim() === DEFAULT_FEISHU_OWNER_FILTER.fieldName;
}

function readScopeSummary(config = {}) {
  const filters = normalizeFeishuReadFiltersForUi(config).filter((filter) => filter.enabled !== false);
  if (!filters.length) return "不限";
  return filters.map((filter) => {
    const label = filter.fieldName || filter.fieldKey || "字段";
    const values = filter.values?.length ? filter.values.join("、") : FEISHU_FILTER_OPERATORS.find((item) => item.value === filter.operator)?.label || filter.operator;
    return `${label}: ${values}`;
  }).join(" / ");
}

function memberCacheFromList(members = []) {
  const out = {};
  for (const member of members || []) {
    const id = String(member?.id || member?.uid || member?._id || "").trim();
    if (!id) continue;
    out[id] = {
      id,
      name: String(member?.name || member?.nick || id).trim(),
      avatarUrl: String(member?.avatarUrl || member?.avatar || "").trim(),
    };
  }
  return out;
}

function tbMemberIndex(tbMembers = {}) {
  const pairs = [
    ...Object.values(tbMembers?.selectedById || {}),
    ...(tbMembers?.members || []),
  ].map((member) => {
    const id = String(member?.id || member?.uid || member?._id || "").trim();
    return id ? [id, member] : null;
  }).filter(Boolean);
  return new Map(pairs);
}

function requiredTbMemberItems(config = {}, tbMembers = {}) {
  const ids = normalizeListValue(getPath(config || {}, "teambition.requiredInvolveMembers", []));
  const byId = tbMemberIndex(tbMembers);
  const defaultExecutorId = String(getPath(config || {}, "teambition.defaultExecutorId", "")).trim();
  const defaultExecutorName = String(getPath(config || {}, "teambition.defaultExecutorName", "")).trim();
  return ids.map((id) => {
    const member = byId.get(String(id)) || {};
    const rawName = String(member?.name || member?.nick || (String(id) === defaultExecutorId ? defaultExecutorName : "")).trim();
    const displayName = rawName && rawName !== String(id) ? rawName : "未解析成员";
    return {
      id,
      displayName,
      resolved: !!rawName && rawName !== String(id),
    };
  });
}

function requiredTbMemberDisplayText(items = [], emptyText = "按人员映射") {
  if (!items.length) return emptyText;
  return items.map((item) => item.displayName).join("、");
}

function requiredTbMemberTitleText(items = [], emptyText = "按人员映射自动解析") {
  if (!items.length) return emptyText;
  return items.map((item) => `${item.displayName} (${item.id})`).join(" / ");
}

function splitDisplayPath(value = "") {
  return String(value || "").split("/").map((part) => part.trim()).filter(Boolean);
}

function pathHead(value = "") {
  return splitDisplayPath(value)[0] || "";
}

function pathTail(value = "") {
  const parts = splitDisplayPath(value);
  return parts.at(-1) || "";
}

function formatDisplayPath(value = "") {
  return splitDisplayPath(value).join(" / ");
}

function normalizeDisplayPathPart(value = "") {
  return String(value || "").replace(/\s*\/\s*/g, "/").replace(/\s+/g, "").toLowerCase();
}

function projectDisplayName(projectPath = "", projectName = "", tasklistName = "") {
  const path = formatDisplayPath(projectPath);
  if (splitDisplayPath(projectPath).length > 1) return path;
  const head = String(projectName || path || "").trim();
  const tail = String(tasklistName || "").trim();
  if (head && tail) {
    const normalizedHead = normalizeDisplayPathPart(head);
    const normalizedTail = normalizeDisplayPathPart(tail);
    if (normalizedHead !== normalizedTail && !normalizedHead.includes(normalizedTail)) return `${head} / ${tail}`;
  }
  return head || tail || "TB 项目";
}

function addReadableName(map, id, name) {
  const key = String(id ?? "").trim();
  const label = String(name || "").trim();
  if (!key || !label || label === key) return;
  if (!map[key] || map[key] === key) map[key] = label;
}

function addReadableTags(ctx, tagIds = [], tagNames = []) {
  const ids = normalizeListValue(tagIds);
  const names = normalizeListValue(tagNames);
  if (names.length) ctx.configuredTagNames = uniqList([...(ctx.configuredTagNames || []), ...names]);
  ids.forEach((id, index) => addReadableName(ctx.tags, id, names[index] || ctx.tags[id]));
}

function addReadableTasklistOptions(ctx, tasklists = []) {
  for (const tasklist of Array.isArray(tasklists) ? tasklists : []) {
    const id = String(tasklist?.id || tasklist?.tasklistId || tasklist?._id || "").trim();
    const name = String(
      tasklist?.pathName
      || tasklist?.projectPathName
      || [tasklist?.projectName, tasklist?.name || tasklist?.title].filter(Boolean).join(" / ")
      || tasklist?.name
      || tasklist?.title
      || "",
    ).trim();
    addReadableName(ctx.tasklists, id, name);
  }
}

function addReadableSprintOptions(ctx, sprints = []) {
  for (const sprint of Array.isArray(sprints) ? sprints : []) {
    const id = String(sprint?.id || sprint?.sprintId || sprint?._id || "").trim();
    const name = String(sprint?.name || sprint?.title || "").trim();
    addReadableName(ctx.sprints, id, name);
  }
}

function readableTbContext(config = {}, tbMembers = {}, tbTasklists = {}, tbSprints = {}) {
  const tb = getPath(config || {}, "teambition", {});
  const projectPath = String(tb.projectPathName || "").trim();
  const tasklistName = String(tb.tasklistName || pathTail(projectPath) || "").trim();
  const projectName = projectDisplayName(projectPath, tb.projectName || pathHead(projectPath), tasklistName);
  const defaultExecutorId = String(tb.defaultExecutorId || "").trim();
  const defaultExecutorName = String(tb.defaultExecutorName || "").trim();
  const ctx = {
    projects: {},
    tasklists: {},
    sprints: {},
    stages: {},
    statuses: {},
    members: {},
    priorities: {},
    taskTypes: {},
    tags: {},
    configuredTagNames: [],
    customFieldIds: {
      applicationCategory: String(tb.applicationCategoryCustomFieldId || "").trim(),
      defectCategory: String(tb.defectCategoryCustomFieldId || "").trim(),
    },
    customFields: {},
  };

  for (const [priority, label] of Object.entries(TB_PRIORITY_DISPLAY_NAMES)) {
    addReadableName(ctx.priorities, priority, label);
  }
  addReadableName(ctx.projects, tb.projectId, projectName);
  addReadableName(ctx.tasklists, tb.tasklistId, tasklistName);
  addReadableName(ctx.sprints, tb.sprintId, tb.sprintName);
  addReadableName(ctx.stages, tb.stageId, tb.stageName);
  addReadableName(ctx.statuses, tb.taskflowstatusId, tb.taskflowstatusName || tb.statusName);
  addReadableName(ctx.taskTypes, tb.scenariofieldconfigId, tb.taskTypeName);
  addReadableName(ctx.members, defaultExecutorId, defaultExecutorName);
  addReadableTags(ctx, tb.tagIds || tb.defaultTagIds || [], tb.tagNames || tb.defaultTagNames || []);
  addReadableName(ctx.customFields, tb.applicationCategoryCustomFieldId, tb.applicationCategoryCustomFieldName || "应用分类");
  addReadableName(ctx.customFields, tb.defectCategoryCustomFieldId, tb.defectCategoryCustomFieldName || "缺陷分类");
  addReadableName(ctx.customFields, tb.severityCustomFieldId, tb.severityCustomFieldName || "严重程度");
  addReadableName(ctx.customFields, tb.versionCustomFieldId, tb.versionCustomFieldName || "版本号");
  addReadableName(ctx.customFields, tb.reproductionProbabilityCustomFieldId, tb.reproductionProbabilityCustomFieldName || "复现概率");

  const policyTargets = Array.isArray(getPath(config || {}, "routing.targets", [])) ? getPath(config || {}, "routing.targets", []) : [];
  for (const targetProfile of policyTargets) {
    const target = targetProfile?.inheritLegacy === false ? (targetProfile?.config || {}) : { ...tb, ...(targetProfile?.config || {}) };
    const targetPath = String(target.projectPathName || "").trim();
    const targetTasklistName = String(target.tasklistName || pathTail(targetPath) || "").trim();
    addReadableName(ctx.projects, target.projectId, projectDisplayName(targetPath, target.projectName || pathHead(targetPath), targetTasklistName));
    addReadableName(ctx.tasklists, target.tasklistId, targetTasklistName);
    addReadableName(ctx.sprints, target.sprintId, target.sprintName);
    addReadableName(ctx.stages, target.stageId, target.stageName);
    addReadableName(ctx.statuses, target.taskflowstatusId, target.taskflowstatusName || target.statusName);
    addReadableName(ctx.taskTypes, target.scenariofieldconfigId, target.taskTypeName);
    addReadableName(ctx.members, target.defaultExecutorId || target.executorId, target.defaultExecutorName || target.executorName);
    addReadableTags(ctx, target.tagIds || target.defaultTagIds || [], target.tagNames || target.defaultTagNames || []);
  }

  for (const member of tbMemberIndex(tbMembers).values()) {
    addReadableName(ctx.members, member?.id || member?.uid || member?._id, member?.name || member?.nick);
  }
  for (const [sourceName, targetId] of Object.entries(getPath(config || {}, "mappings.people", {}) || {})) {
    addReadableName(ctx.members, targetId, sourceName);
  }
  for (const [sourceName, targetPriority] of Object.entries(getPath(config || {}, "mappings.priority", {}) || {})) {
    addReadableName(ctx.priorities, targetPriority, sourceName);
  }

  const rules = Array.isArray(getPath(config || {}, "mappings.keywordRules", [])) ? getPath(config || {}, "mappings.keywordRules", []) : [];
  for (const rule of rules) {
    const target = rule?.target || {};
    const targetPath = String(target.projectPathName || target.pathName || projectPath).trim();
    const targetTasklistName = String(target.tasklistName || target.tasklistPathName || pathTail(targetPath) || tasklistName).trim();
    addReadableName(ctx.projects, target.projectId, projectDisplayName(targetPath, target.projectName || pathHead(targetPath) || projectName, targetTasklistName));
    addReadableName(ctx.tasklists, target.tasklistId, targetTasklistName);
    addReadableName(ctx.sprints, target.sprintId, target.sprintName || tb.sprintName);
    addReadableName(ctx.stages, target.stageId, target.stageName || tb.stageName);
    addReadableName(ctx.statuses, target.taskflowstatusId, target.taskflowstatusName || target.statusName || tb.taskflowstatusName || tb.statusName);
    addReadableName(ctx.taskTypes, target.scenariofieldconfigId || rule?.scenariofieldconfigId, target.taskTypeName || rule?.taskTypeName || tb.taskTypeName);
    addReadableName(ctx.members, target.executorId, target.executorName);
    addReadableTags(ctx, target.tagIds || target.defaultTagIds || [], target.tagNames || target.defaultTagNames || rule?.tagNames || rule?.defaultTagNames || []);
    const memberIds = normalizeListValue(target.involveMembers || []);
    const memberNames = normalizeListValue(target.involveMemberNames || []);
    memberIds.forEach((memberId, index) => addReadableName(ctx.members, memberId, memberNames[index] || ctx.members[memberId]));
  }
  addReadableTasklistOptions(ctx, tbTasklists?.tasklists || tbTasklists?.options || []);
  addReadableSprintOptions(ctx, tbSprints?.sprints || tbSprints?.options || []);

  return ctx;
}

function configuredDisplayName(index = {}, id = "", explicitName = "", fallback = "名称未解析") {
  const explicit = String(explicitName || "").trim();
  const key = String(id || "").trim();
  const indexed = String(index?.[key] || "").trim();
  if (explicit && explicit !== key) return explicit;
  if (indexed && indexed !== key) return indexed;
  return key ? `${fallback}（请刷新选项）` : "未配置";
}

function looksLikeOpaqueIdentifier(value = "") {
  const text = String(value || "").trim();
  return /^[a-f0-9]{16,}$/i.test(text)
    || /^(?:tb|task|user|project|sprint|stage|status|field|cf|tag)[-_][a-z0-9_-]+$/i.test(text);
}

function readableMappingValue(value, kind, context = {}) {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const direct = value.name || value.label || value.title || value.displayName || value.targetName;
    if (direct) return String(direct);
    const nested = value.id || value._id || value.value || value.customFieldId || value.customfieldId;
    return readableMappingValue(nested, kind, context);
  }
  const raw = stringifyScalar(value);
  const index = kind === "people"
    ? context.members
    : kind === "status"
      ? context.statuses
      : kind === "priority"
        ? context.priorities
        : kind === "customFields"
          ? context.customFields
          : {};
  const resolved = configuredDisplayName(index, raw, "", "显示名称未解析");
  if (resolved !== "未配置" && !resolved.startsWith("显示名称未解析")) return resolved;
  return looksLikeOpaqueIdentifier(raw) ? "显示名称未解析（请补充名称）" : raw || "未配置";
}

const READABLE_RESULT_FIELD_MAP = {
  executorId: "members",
  projectId: "projects",
  tasklistId: "tasklists",
  sprintId: "sprints",
  stageId: "stages",
  taskflowstatusId: "statuses",
  priority: "priorities",
  scenariofieldconfigId: "taskTypes",
};

function readableResultFieldValue(value, field = "") {
  const token = actualValueToken(field, value);
  if (Array.isArray(token)) return token[0] ?? "";
  if (token && typeof token === "object") return firstKnownObjectValue(token, ["_id", "id", "userId", "tasklistId", "sprintId", "projectId", "value"]);
  return token;
}

function readableResultDisplayValue(value, field = "") {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const direct = firstKnownObjectValue(value, ["pathName", "projectPathName", "name", "title", "displayName", "nick", "username"]);
    if (direct !== undefined && direct !== null && direct !== "") return direct;
  }
  const token = readableValueToken(field, value);
  if (Array.isArray(token)) return token[0] ?? "";
  if (token && typeof token === "object") return firstKnownObjectValue(token, ["name", "title", "displayName", "nick", "username", "pathName", "value"]);
  return token;
}

function addReadableResultFieldName(ctx = {}, field = "", idValue, displayValue) {
  const mapKey = READABLE_RESULT_FIELD_MAP[field];
  if (!mapKey || !ctx?.[mapKey]) return;
  const id = String(readableResultFieldValue(idValue, field) ?? "").trim();
  const display = String(readableResultDisplayValue(displayValue, field) ?? "").trim();
  if (!id || !display || id === display) return;
  addReadableName(ctx[mapKey], id, display);
}

function readableResultObjectFieldValue(obj = {}, field = "") {
  const direct = obj[field] ?? obj[`_${field}`];
  if (direct !== undefined && direct !== null && direct !== "") return direct;
  for (const path of TARGET_PAYLOAD_FIELD_PATHS[field] || []) {
    const value = readObjectPath(obj, path);
    if (value !== undefined && value !== null && value !== "") return value;
  }
  return direct;
}

function readableResultObjectDisplayValue(obj = {}, field = "", fallbackValue) {
  const direct = obj[`${field}Display`] ?? obj[`${field}Name`] ?? obj[`${field}Label`];
  if (direct !== undefined && direct !== null && direct !== "") return direct;
  for (const path of TARGET_FIELD_DISPLAY_PATHS[field] || []) {
    const value = readObjectPath(obj, path);
    if (value !== undefined && value !== null && value !== "") return value;
  }
  return fallbackValue;
}

function addReadableResultObjectNames(ctx = {}, obj = {}) {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return;
  for (const field of Object.keys(READABLE_RESULT_FIELD_MAP)) {
    const idValue = readableResultObjectFieldValue(obj, field);
    const displayValue = readableResultObjectDisplayValue(obj, field, idValue);
    addReadableResultFieldName(ctx, field, idValue, displayValue);
  }
}

function addReadableSyncResultContext(ctx = {}, rows = []) {
  for (const row of Array.isArray(rows) ? rows : []) {
    addReadableResultObjectNames(ctx, row?.payload || {});
    addReadableResultObjectNames(ctx, targetTaskForRow(row));
    const mismatches = Array.isArray(row?.targetFieldVerification?.mismatches) ? row.targetFieldVerification.mismatches : [];
    for (const mismatch of mismatches) {
      addReadableResultFieldName(ctx, mismatch?.field, mismatch?.actual, mismatch?.actualDisplay || mismatch?.actualName || mismatch?.actualLabel);
      addReadableResultFieldName(ctx, mismatch?.field, mismatch?.expected, mismatch?.expectedDisplay || mismatch?.expectedName || mismatch?.expectedLabel);
    }
  }
  return ctx;
}

function readableName(map = {}, id) {
  const key = String(id ?? "").trim();
  if (!key) return "";
  return map[key] || key;
}

function stringifyList(values) {
  return (Array.isArray(values) ? values : []).join("\n");
}

function parseScalar(value) {
  const text = String(value ?? "").trim();
  if (!text) return "";
  if (/^-?\d+(\.\d+)?$/.test(text)) return Number(text);
  if (text === "true") return true;
  if (text === "false") return false;
  if ((text.startsWith("{") && text.endsWith("}")) || (text.startsWith("[") && text.endsWith("]"))) {
    try { return JSON.parse(text); } catch { return text; }
  }
  return text;
}

function stringifyScalar(value) {
  if (value == null) return "";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function parsePairs(text) {
  const out = {};
  for (const line of String(text || "").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const idx = trimmed.indexOf("=");
    if (idx < 0) {
      out[trimmed] = "";
    } else {
      out[trimmed.slice(0, idx).trim()] = parseScalar(trimmed.slice(idx + 1).trim());
    }
  }
  return out;
}

function stringifyPairs(map) {
  return Object.entries(map || {}).map(([k, v]) => `${k}=${stringifyScalar(v)}`).join("\n");
}

function parseCustomFields(text) {
  return parsePairs(text);
}

function statusColor(status) {
  if (status === "success") return "text-emerald-300 bg-emerald-500/10 border-emerald-500/30";
  if (status === "failed") return "text-red-300 bg-red-500/10 border-red-500/30";
  if (status === "syncing") return "text-blue-300 bg-blue-500/10 border-blue-500/30";
  return "text-zinc-300 bg-zinc-700/40 border-zinc-700";
}

function formatTime(value) {
  if (!value) return "-";
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? String(value) : d.toLocaleString("zh-CN", { hour12: false });
}

function collectSyncResults(data) {
  if (!data || typeof data !== "object") return [];
  const candidates = [
    data.results,
    data.result?.results,
    data.result?.result?.results,
    data.resultsPreview,
    data.resultSummary?.resultsPreview,
    data.summary?.resultsPreview,
  ];
  return candidates.find(Array.isArray) || [];
}

function getSyncResultStats(data) {
  const results = collectSyncResults(data);
  const summary = data?.resultSummary || data?.summary || {};
  const previewOnly = !!data?.resultsPreviewOnly || (!!data?.resultsPreview && !Array.isArray(data?.results));
  const hasRows = results.length > 0 && !previewOnly;
  const countAction = (action) => results.filter((row) => row?.ok !== false && row?.action === action).length;
  return {
    ok: data?.ok !== false && summary.ok !== false && !results.some((row) => row?.ok === false),
    dryRun: !!(data?.dryRun ?? summary.dryRun) || results.some((row) => row?.dryRun),
    source: data?.source || data?.mode || summary.source || "",
    captured: data?.captured?.total ?? data?.selected?.rawPayloads ?? summary.captured ?? null,
    total: Number(data?.total ?? summary.total ?? (hasRows ? results.length : 0)) || 0,
    requested: Number(data?.requested ?? summary.requested ?? data?.captured?.total ?? data?.selected?.workItemIds?.length ?? data?.total ?? summary.total ?? (hasRows ? results.length : 0)) || 0,
    created: hasRows ? countAction("create") : Number(data?.created ?? summary.created ?? summary.create ?? 0),
    updated: hasRows ? countAction("update") : Number(data?.updated ?? summary.updated ?? summary.update ?? 0),
    childSynced: hasRows ? countAction("sync-children") : Number(data?.childSynced ?? summary.childSynced ?? 0),
    skipped: hasRows ? countAction("skip") : Number(data?.skipped ?? summary.skipped ?? 0),
    failed: hasRows ? results.filter((row) => row?.ok === false).length : Number(data?.failed ?? summary.failed ?? 0),
    stoppedOnFirstError: !!(data?.stoppedOnFirstError ?? summary.stoppedOnFirstError),
    firstError: data?.firstError || summary.firstError || results.find((row) => row?.ok === false)?.error || "",
    results,
  };
}

function formatSyncResultSummary(data) {
  const stats = getSyncResultStats(data);
  const stopped = stats.stoppedOnFirstError ? "，遇到首个失败已停止" : "";
  return `总数 ${stats.total}/${stats.requested || stats.total}，创建 ${stats.created}，更新 ${stats.updated}，跳过 ${stats.skipped}，失败 ${stats.failed}${stopped}`;
}

function normalizeRunStatus(run = {}) {
  const status = String(run?.status || "").toLowerCase();
  const hasResult = !!(run?.result || run?.resultSummary || run?.hasResult);
  if (!status || status === "pending" || status === "queued" || status === "starting" || status === "running") return "running";
  if (["failed", "failure", "error", "stopped", "cancelled", "canceled"].includes(status)) return "failed";
  if (["success", "succeeded", "done", "completed", "complete"].includes(status)) return hasResult ? "done" : "settling";
  if (run?.error) return "failed";
  return hasResult ? "done" : "running";
}

function scheduleTransition(update) {
  if (typeof React.startTransition === "function") React.startTransition(update);
  else update();
}

function visibleRunEvents(events = []) {
  return Array.isArray(events) ? events.slice(-MAX_RENDERED_RUN_EVENTS) : [];
}

function runEventKey(evt = {}) {
  const seq = evt.seq ?? "";
  const globalSeq = evt.globalSeq ?? "";
  if (seq || globalSeq) return `${seq}:${globalSeq}`;
  return `${evt.at || ""}:${evt.phase || ""}:${evt.workItemId || ""}:${evt.message || ""}`;
}

function runEventKeySet(events = []) {
  return new Set(visibleRunEvents(events).map(runEventKey));
}

function appendUniqueRunEvents(current = [], incoming = []) {
  const next = visibleRunEvents(current);
  const seen = new Set(next.map(runEventKey));
  for (const evt of incoming || []) {
    const key = runEventKey(evt);
    if (seen.has(key)) continue;
    seen.add(key);
    next.push(evt);
  }
  return visibleRunEvents(next);
}

function compactRunSnapshot(run = {}) {
  if (!run || typeof run !== "object") return null;
  return {
    id: run.id || "",
    mode: run.mode || "",
    status: run.status || "",
    startedAt: run.startedAt || "",
    finishedAt: run.finishedAt || "",
    error: run.error || "",
    events: visibleRunEvents(run.events),
    hasResult: run.result !== undefined && run.result !== null,
    resultSummary: run.resultSummary || null,
  };
}

function runDisplayData(run = {}) {
  return run?.result || run?.resultSummary || compactRunSnapshot(run);
}

function isFeishuWebSource(source = "") {
  const value = String(source || "").toLowerCase();
  return value === "web" || value === "feishu-web";
}

function withFeishuWebSourceMarker(data, source = "") {
  if (!isFeishuWebSource(source) || !data || typeof data !== "object" || Array.isArray(data)) return data;
  return { ...data, source: data.source || "feishu-web" };
}

function feishuWebFailureResult(message, err = null, { dryRun = true } = {}) {
  const text = message || err?.message || String(err || "Feishu web source failed");
  return {
    ok: false,
    dryRun,
    source: "feishu-web",
    needLogin: !!err?.needLogin,
    total: 0,
    requested: 0,
    failed: 1,
    firstError: text,
    error: text,
    captured: err?.data?.captured || err?.data || undefined,
    results: [],
  };
}

function formatPreviewForDisplay(data) {
  if (data?.__previewText) return data.__previewText;
  if (!data) return "dry-run 或样例预览后，这里显示转换后的 TB payload。";
  try {
    return JSON.stringify(compactPreviewData(data), null, 2);
  } catch (err) {
    return `结果已返回，但展示时压缩失败：${err?.message || String(err)}`;
  }
}

function getPreviewFormatWorker() {
  if (typeof Worker === "undefined") return null;
  if (previewFormatWorker) return previewFormatWorker;
  try {
    previewFormatWorker = new Worker(new URL("./FeishuProjectSyncPreview.worker.js", import.meta.url), { type: "module" });
    return previewFormatWorker;
  } catch {
    previewFormatWorker = null;
    return null;
  }
}

function terminatePreviewFormatWorker() {
  try { previewFormatWorker?.terminate?.(); } catch {}
  previewFormatWorker = null;
}

function formatPreviewForDisplayAsync(data, { signal, timeoutMs = PREVIEW_FORMAT_WORKER_TIMEOUT_MS } = {}) {
  if (!data || data?.__previewText) return Promise.resolve(formatPreviewForDisplay(data));
  const worker = getPreviewFormatWorker();
  if (!worker) return Promise.resolve().then(() => formatPreviewForDisplay(data));
  const id = ++previewFormatRequestSeq;

  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      worker.removeEventListener("message", onMessage);
      worker.removeEventListener("error", onError);
      signal?.removeEventListener?.("abort", onAbort);
    };
    const onMessage = (event) => {
      if (event.data?.id !== id) return;
      cleanup();
      if (event.data?.ok) resolve(event.data.text || "");
      else reject(new Error(event.data?.error || "preview format worker failed"));
    };
    const onError = (event) => {
      cleanup();
      terminatePreviewFormatWorker();
      reject(new Error(event?.message || "preview format worker failed"));
    };
    const onAbort = () => {
      cleanup();
      terminatePreviewFormatWorker();
      reject(new Error("preview format cancelled"));
    };
    const timer = setTimeout(() => {
      cleanup();
      terminatePreviewFormatWorker();
      reject(new Error("preview format worker timeout"));
    }, timeoutMs);

    worker.addEventListener("message", onMessage);
    worker.addEventListener("error", onError);
    signal?.addEventListener?.("abort", onAbort, { once: true });

    try {
      worker.postMessage({ id, data });
    } catch (err) {
      cleanup();
      reject(err);
    }
  });
}

function compactPreviewData(data) {
  if (!data || typeof data !== "object") return data;
  const results = collectSyncResults(data);
  const stats = getSyncResultStats(data);
  const out = {};
  for (const [key, value] of Object.entries(data).slice(0, 80)) {
    if (key === "results") continue;
    if (key === "result" && value?.results) {
      out.result = compactPreviewData(value);
      continue;
    }
    out[key] = compactValue(value, 0, new WeakSet());
  }
  if (results.length) {
    out.summary = {
      total: stats.total,
      create: stats.created,
      update: stats.updated,
      skipped: stats.skipped,
      failed: stats.failed,
      stoppedOnFirstError: stats.stoppedOnFirstError,
      firstError: stats.firstError,
      dryRun: stats.dryRun,
    };
    out.resultsPreview = results.slice(0, 20).map(compactSyncResultRow);
    if (results.length > 20) out.resultsOmitted = results.length - 20;
  }
  out._displayNote = "结果页为避免浏览器卡顿，只展示精简 JSON；完整判断请以上方摘要和结果明细为准。";
  return out;
}

function compactValue(value, depth = 0, seen = new WeakSet()) {
  if (value == null || typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "string") return clipText(value, 1600);
  if (Array.isArray(value)) {
    const first = value.slice(0, depth ? 8 : 20).map((item) => compactValue(item, depth + 1, seen));
    if (value.length > first.length) first.push(`... ${value.length - first.length} more items omitted`);
    return first;
  }
  if (typeof value !== "object") return String(value);
  if (seen.has(value)) return "[Circular]";
  seen.add(value);
  const keys = Object.keys(value);
  if (depth >= 2) return `[Object with ${keys.length} keys: ${keys.slice(0, 12).join(", ")}${keys.length > 12 ? ", ..." : ""}]`;
  const out = {};
  for (const key of keys.slice(0, 40)) out[key] = compactValue(value[key], depth + 1, seen);
  if (keys.length > 40) out._omittedKeys = keys.length - 40;
  return out;
}

function compactNotePrevious(row = {}) {
  const verification = row.targetFieldVerification || {};
  const mismatches = Array.isArray(verification.mismatches) ? verification.mismatches : [];
  const noteMismatch = mismatches.find((item) => item?.field === "note") || {};
  const task = verification.task || {};
  const candidates = [
    row.notePrevious,
    row.payload?.notePrevious,
    verification.notePrevious,
    verification.previousNote,
    verification.currentNote,
    noteMismatch.actualDisplay,
    noteMismatch.actual,
    task.noteDisplay,
    task.noteMarkdown,
    task.note,
  ];
  for (const candidate of candidates) {
    const text = readableNoteText(candidate);
    if (text) return text;
  }
  if (isKnownEmptyNotePrevious(row, noteMismatch)) return "空";
  return "";
}

function compactTargetFieldVerification(row = {}) {
  const verification = row.targetFieldVerification;
  const notePrevious = compactNotePrevious(row);
  if (!verification && !notePrevious) return undefined;
  return cleanDisplayObject({
    ...(verification || {}),
    notePrevious: notePrevious || undefined,
  });
}

function compactSyncResultRow(row = {}) {
  const item = row.item || {};
  const payload = row.payload || {};
  const verification = row.targetFieldVerification || {};
  const notePrevious = compactNotePrevious(row);
  return cleanDisplayObject({
    ok: row.ok,
    action: row.action,
    dryRun: row.dryRun,
    id: syncRowId(row),
    title: item.title || item.work_item_name || item.name,
    assignees: Array.isArray(item.assignees) ? item.assignees.map((person) => person?.name || person?.userKey || person?.email).filter(Boolean).slice(0, 8) : undefined,
    targetTaskId: row.targetTaskId || row.existing?.targetTaskId || row.remoteExisting?.targetTaskId || verification.targetTaskId || verification.task?._id || verification.task?.id || verification.task?.taskId,
    targetUniqueId: row.targetUniqueId || row.existing?.targetUniqueId || row.remoteExisting?.targetUniqueId || verification.targetUniqueId || verification.task?.uniqueId || verification.task?.unique_id,
    notePrevious: notePrevious || undefined,
    reason: row.reason,
    error: row.error,
    scopeStatus: row.scopeStatus,
    bookmarks: row.bookmarks,
    payload: Object.keys(payload).length ? cleanDisplayObject({
      content: clipText(payload.content, 300),
      note: clipText(payload.note, 4000),
      notePrevious: notePrevious || undefined,
      executorId: payload.executorId,
      executorIdDisplay: payload.executorIdDisplay,
      involveMembers: payload.involveMembers,
      dueDate: payload.dueDate,
      startDate: payload.startDate,
      priority: payload.priority,
      projectId: payload.projectId,
      projectIdDisplay: payload.projectIdDisplay,
      tasklistId: payload.tasklistId,
      tasklistIdDisplay: payload.tasklistIdDisplay,
      stageId: payload.stageId,
      stageIdDisplay: payload.stageIdDisplay,
      sprintId: payload.sprintId,
      sprintIdDisplay: payload.sprintIdDisplay,
      taskflowstatusId: payload.taskflowstatusId,
      taskflowstatusIdDisplay: payload.taskflowstatusIdDisplay,
      scenariofieldconfigId: payload.scenariofieldconfigId,
      scenariofieldconfigIdDisplay: payload.scenariofieldconfigIdDisplay,
      applicationCategory: payload.applicationCategory,
      applicationCategoryCustomFieldId: payload.applicationCategoryCustomFieldId,
      defectCategory: payload.defectCategory,
      defectCategoryCustomFieldId: payload.defectCategoryCustomFieldId,
      tagIds: payload.tagIds,
      tagIdsDisplay: payload.tagIdsDisplay,
      customfields: Array.isArray(payload.customfields) ? payload.customfields.slice(0, 20) : undefined,
    }) : undefined,
    existing: row.existing ? cleanDisplayObject({
      targetTaskId: row.existing.targetTaskId,
      targetUniqueId: row.existing.targetUniqueId,
      syncStatus: row.existing.syncStatus,
      lastSyncedAt: row.existing.lastSyncedAt,
      sheetTargetOverride: row.existing.sheetTargetOverride,
      sheetTargetDisplayId: row.existing.sheetTargetDisplayId,
      sheetTargetRow: row.existing.sheetTargetRow,
      sheetTargetColumns: row.existing.sheetTargetColumns,
    }) : undefined,
    remoteExisting: row.remoteExisting ? cleanDisplayObject({
      targetTaskId: row.remoteExisting.targetTaskId,
      targetUniqueId: row.remoteExisting.targetUniqueId,
      source: row.remoteExisting.source,
      ignored: row.remoteExisting.ignored,
    }) : undefined,
    targetFieldVerification: compactTargetFieldVerification(row),
    comparisonSnapshot: row.comparisonSnapshot,
    targetVerification: row.targetVerification,
    scheduleWarnings: row.scheduleWarnings,
    childPlan: row.childPlan ? cleanDisplayObject({
      needsSync: row.childPlan.needsSync,
      comments: row.childPlan.comments,
      targetComments: row.childPlan.targetComments,
      targetCommentRead: row.childPlan.targetCommentRead,
      attachments: row.childPlan.attachments,
    }) : undefined,
  });
}

function cleanDisplayObject(obj = {}) {
  const out = {};
  for (const [key, value] of Object.entries(obj)) {
    if (value === undefined || value === null || value === "") continue;
    if (Array.isArray(value) && !value.length) continue;
    out[key] = value;
  }
  return out;
}

function clipText(value, max = 500) {
  const text = String(value ?? "");
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

function renderTbUrl(template, row) {
  const taskId = row.targetTaskId || row.target_task_id || row.taskId || "";
  if (!taskId) return "";
  const uniqueId = row.targetUniqueId || row.target_unique_id || row.uniqueId || "";
  return String(template || "https://www.teambition.com/task/{targetTaskId}")
    .replace(/\{targetTaskId\}/g, encodeURIComponent(taskId))
    .replace(/\{taskId\}/g, encodeURIComponent(taskId))
    .replace(/\{targetUniqueId\}/g, encodeURIComponent(uniqueId))
    .replace(/\{uniqueId\}/g, encodeURIComponent(uniqueId))
    .replace(/\{projectId\}/g, encodeURIComponent(row.targetProjectId || row.projectId || ""));
}

function formatTbTaskDisplayId(row = {}) {
  const uniqueId = String(row.targetUniqueId || row.target_unique_id || row.uniqueId || row.unique_id || "").trim();
  if (uniqueId) {
    const normalized = uniqueId.replace(/^#/, "");
    if (/^CARB-\d+$/i.test(normalized)) return normalized.toUpperCase();
    if (/^\d+$/.test(normalized)) return `CARB-${normalized}`;
    return normalized;
  }
  return row.targetTaskId || row.target_task_id || row.taskId || "-";
}

function targetTaskForRow(row = {}) {
  const parts = [
    row.existing?.task,
    row.remoteExisting?.task,
    row.targetVerification?.task,
    row.targetFieldVerification?.task,
  ].filter((part) => part && typeof part === "object" && !Array.isArray(part));
  return parts.length ? Object.assign({}, ...parts) : {};
}

function readCaseInsensitiveObjectKey(obj, key) {
  if (!obj || typeof obj !== "object") return undefined;
  if (Object.prototype.hasOwnProperty.call(obj, key)) return obj[key];
  const normalized = String(key || "").toLowerCase();
  const found = Object.keys(obj).find((candidate) => candidate.toLowerCase() === normalized);
  return found ? obj[found] : undefined;
}

function readObjectPath(obj, path = "") {
  let cursor = obj;
  for (const part of String(path || "").split(".").filter(Boolean)) {
    cursor = readCaseInsensitiveObjectKey(cursor, part);
    if (cursor === undefined || cursor === null) return undefined;
  }
  return cursor;
}

function firstKnownObjectValue(value, keys = []) {
  if (value === undefined || value === null || value === "") return undefined;
  if (Array.isArray(value)) {
    const values = value.map((item) => firstKnownObjectValue(item, keys)).filter((item) => item !== undefined && item !== null && item !== "");
    return values.length ? values : undefined;
  }
  if (typeof value !== "object") return value;
  for (const key of keys) {
    const nested = readObjectPath(value, key);
    if (nested !== undefined && nested !== null && nested !== "") return nested;
  }
  return undefined;
}

function targetTaskInfoForRow(row = {}) {
  const task = targetTaskForRow(row);
  const verification = row.targetFieldVerification || {};
  const targetTaskId = String(
    row.targetTaskId
    || row.target_task_id
    || row.taskId
    || row.existing?.targetTaskId
    || row.existing?.target_task_id
    || row.remoteExisting?.targetTaskId
    || row.remoteExisting?.target_task_id
    || row.state?.targetTaskId
    || row.state?.target_task_id
    || verification.targetTaskId
    || verification.target_task_id
    || task?._id
    || task?.id
    || task?.taskId
    || "",
  ).trim();
  const targetUniqueId = String(
    row.targetUniqueId
    || row.target_unique_id
    || row.uniqueId
    || row.unique_id
    || row.existing?.targetUniqueId
    || row.existing?.target_unique_id
    || row.remoteExisting?.targetUniqueId
    || row.remoteExisting?.target_unique_id
    || row.state?.targetUniqueId
    || row.state?.target_unique_id
    || verification.targetUniqueId
    || verification.target_unique_id
    || task?.uniqueId
    || task?.unique_id
    || "",
  ).trim();
  const targetProjectId = String(
    row.targetProjectId
    || row.projectId
    || row.existing?.targetProjectId
    || row.existing?.target_project_id
    || row.remoteExisting?.projectId
    || row.remoteExisting?.targetProjectId
    || row.payload?.projectId
    || task?._projectId
    || task?.projectId
    || "",
  ).trim();
  const url = String(row.targetTaskUrl || row.url || row.existing?.targetTaskUrl || row.remoteExisting?.url || row.state?.targetTaskUrl || "").trim();
  const displayId = formatTbTaskDisplayId({ targetTaskId, targetUniqueId });
  return { targetTaskId, targetUniqueId, targetProjectId, displayId, url };
}

function TargetTbLink({ row, config, className = "" }) {
  const target = targetTaskInfoForRow(row);
  if (!target.targetTaskId) return <span className={className || "text-zinc-500"}>未绑定</span>;
  const href = target.url || renderTbUrl(getPath(config || {}, "teambition.taskUrlTemplate"), {
    targetTaskId: target.targetTaskId,
    targetUniqueId: target.targetUniqueId,
    targetProjectId: target.targetProjectId,
  });
  const label = target.displayId || target.targetTaskId;
  if (!href) return <span className={className || "text-zinc-200"} title={target.targetTaskId}>{label}</span>;
  return (
    <a href={href} target="_blank" rel="noreferrer" className={className || "text-blue-300 hover:text-blue-200"} title={target.targetTaskId}>
      {label}
    </a>
  );
}

function sourceWorkItemUrlForRow(row = {}, config = {}) {
  const item = row.item || {};
  const direct = String(
    row.sourceWorkItemUrl
    || row.source_work_item_url
    || item.sourceWorkItemUrl
    || item.source_work_item_url
    || item.url
    || item.detailUrl
    || item.detail_url
    || "",
  ).trim();
  if (/^https?:\/\//i.test(direct)) return direct;
  const sourceId = String(row.sourceWorkItemId || row.source_work_item_id || item.sourceWorkItemId || item.source_work_item_id || item.id || "").trim();
  if (!sourceId || /^[A-Z][A-Z0-9]+-\d+$/i.test(sourceId)) return "";
  const spaceKey = String(getPath(config || {}, "feishu.spaceKey", "") || getPath(config || {}, "feishu.projectKey", "") || "").trim();
  const workItemTypeKey = String(getPath(config || {}, "feishu.workItemTypeKey", "") || getPath(config || {}, "feishu.typeKey", "") || "").trim();
  return spaceKey && workItemTypeKey ? `https://project.feishu.cn/${encodeURIComponent(spaceKey)}/${encodeURIComponent(workItemTypeKey)}/detail/${encodeURIComponent(sourceId)}` : "";
}

function SourceWorkItemLink({ row, config, className = "" }) {
  const label = syncRowDisplayId(row);
  const href = sourceWorkItemUrlForRow(row, config);
  if (!href) return <span className={className || "font-mono text-zinc-300"}>{label}</span>;
  return (
    <a href={href} target="_blank" rel="noreferrer" className={className || "font-mono text-blue-300 hover:text-blue-200"} title={href}>
      {label}
    </a>
  );
}

function missingAppliesToAuthMode(key = "", authMode = "plugin") {
  const value = String(key || "");
  if (FEISHU_PLUGIN_MISSING_KEYS.has(value)) return authMode === "plugin";
  if (value === "feishu.web.homepageUrl") return authMode === "web";
  if (value === "feishu.mcp") return authMode === "mcp";
  return true;
}

function visibleMissingForAuthMode(readiness, config) {
  const authMode = getPath(config || {}, "feishu.authMode", readiness?.authMode || "plugin");
  return (readiness?.missing || []).filter((key) => missingAppliesToAuthMode(key, authMode));
}

function readinessItems(readiness, config, feishuWeb, feishuMcp, configLoading = false) {
  if (!config && configLoading) {
    return [{ key: "loading", label: "配置加载中", ok: false }];
  }
  const missing = visibleMissingForAuthMode(readiness, config);
  const authMode = getPath(config || {}, "feishu.authMode", readiness?.authMode || "plugin");
  const sourceReady = authModeStatus({ mode: authMode, readiness, feishuWeb, feishuMcp }).ok;
  return [
    { key: "enabled", label: "启用", ok: readiness?.enabled },
    { key: "feishu", label: authMode === "web" ? "飞书 Web" : authMode === "mcp" ? "飞书 MCP" : "飞书凭证", ok: sourceReady },
    { key: "tb", label: "TB 目标", ok: readiness?.teambitionReady },
    { key: "missing", label: missing.length ? `${missing.length} 项缺失` : "配置完整", ok: !missing.length },
  ];
}

function syncConfigIssues({ config, readiness, canEdit, feishuWeb, feishuMcp, adminError }) {
  const issues = [];
  if (adminError) issues.push(adminError);
  if (!canEdit) issues.push("管理员未登录，无法保存配置或执行同步");
  if (!config) {
    issues.push("同步配置尚未加载");
    return uniqList(issues);
  }

  const authMode = getPath(config, "feishu.authMode", readiness?.authMode || "plugin");
  const authStatusChecking = (authMode === "mcp" && !feishuMcp?.checked) || (authMode === "web" && !feishuWeb?.checked);
  const sourceReady = authModeStatus({ mode: authMode, readiness, feishuWeb, feishuMcp }).ok;
  const missing = visibleMissingForAuthMode(readiness, config);
  if (config.enabled === false) issues.push("同步未启用");
  if (readiness && !sourceReady && !authStatusChecking) {
    issues.push(authMode === "web" && feishuWeb?.skippedBrowserLaunch
      ? "飞书网页登录态待确认（进入页面未自动弹窗）"
      : `${modeLabel(authMode)}未就绪`);
  }
  if (readiness && !readiness.teambitionReady) issues.push("TB 目标未就绪");
  for (const key of missing) issues.push(`缺少配置：${MISSING_LABELS[key] || key}`);
  for (const issue of sourceViewValidationIssues(config)) issues.push(`飞书来源：${issue.message}`);
  if (!tbSprintForUi(config).sprintId) issues.push("TB 目标迭代未配置");
  if (authMode === "mcp" && feishuMcp?.checked && !feishuMcp?.connected) {
    issues.push(feishuMcp?.degraded
      ? "飞书 MCP 状态检测暂时失败；已保存的登录配置仍保留，请稍后刷新检测"
      : feishuMcp?.needsAuthorization ? "飞书 MCP 需要授权" : "飞书 MCP 未连接");
  }
  if (authMode === "web" && feishuWeb?.checked && !feishuWeb?.valid) issues.push("飞书网页登录态未就绪或已失效");
  if (!normalizeFeishuReadFiltersForUi(config).length) issues.push("读取筛选条件为空");
  return uniqList(issues);
}

function prepareFeishuSourceViewsConfig(config = {}) {
  const prepared = applySourceViewsToConfig(config, normalizeFeishuSourceViewsForUi(config));
  const issues = sourceViewValidationIssues(prepared);
  if (issues.length) throw new Error(`飞书工单来源配置无效：${issues[0].message}`);
  return prepared;
}

export default function FeishuProjectSync() {
  const adminSession = useAdminSession();
  const canEdit = adminSession.isAdmin && adminSession.canMutate;
  const adminLoading = adminSession.loading;
  const [activeTab, setActiveTab] = useState("sync");
  const [config, setConfig] = useState(null);
  const [readiness, setReadiness] = useState(null);
  const [tbLogin, setTbLogin] = useState({ checked: false, valid: false, user: "", id: "", reason: "" });
  const [tbProjects, setTbProjects] = useState({ loaded: false, loading: false, projects: [], currentProjectId: "", error: "", pickerOpen: false, savingProjectId: "" });
  const [tbTasklists, setTbTasklists] = useState({ loaded: false, loadedProjectId: "", loading: false, tasklists: [], currentTasklistId: "", error: "", savingTasklistId: "" });
  const [tbSprints, setTbSprints] = useState({ loaded: false, loadedProjectId: "", loading: false, sprints: [], currentSprintId: "", error: "", savingSprintId: "" });
  const [tbMembers, setTbMembers] = useState({ query: "徐博超", loaded: false, loading: false, members: [], selectedById: {}, error: "", savingMemberId: "", resolving: false });
  const [feishuWeb, setFeishuWeb] = useState({ checked: false, valid: false, finalUrl: "", reason: "", passive: true, activePageRead: false, skippedBrowserLaunch: false });
  const [feishuMcp, setFeishuMcp] = useState({ checked: false, configured: false, connected: false, needsAuthorization: false, error: "" });
  const [feishuFilterMeta, setFeishuFilterMeta] = useState({ loaded: false, loading: false, fields: [], roles: [], error: "", generatedAt: "" });
  const [feishuFilterPreset, setFeishuFilterPreset] = useState(null);
  const [feishuFilterConfigBusy, setFeishuFilterConfigBusy] = useState("");
  const [records, setRecords] = useState([]);
  const [errors, setErrors] = useState([]);
  const [retryable, setRetryable] = useState([]);
  const [rawPayloads, setRawPayloads] = useState([]);
  const [recordsLoading, setRecordsLoading] = useState(false);
  const [recordsError, setRecordsError] = useState("");
  const [configLoading, setConfigLoading] = useState(true);
  const [errorsLoading, setErrorsLoading] = useState(false);
  const [errorsLoaded, setErrorsLoaded] = useState(false);
  const [errorsError, setErrorsError] = useState("");
  const [adminError, setAdminError] = useState("");
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState(null);
  const [preview, setPreview] = useState(null);
  const [previewBusy, setPreviewBusy] = useState(false);
  const [quickRunBusy, setQuickRunBusy] = useState("");
  const [quickRunResult, setQuickRunResult] = useState(null);
  const [recordsRefreshResult, setRecordsRefreshResult] = useState(null);
  const [quickRunEvents, setQuickRunEvents] = useState([]);
  const [syncViewPending, setSyncViewPending] = useState(false);
  const [workItemIds, setWorkItemIds] = useState(readPreviewWorkItemIdsDraft);
  const [sampleJson, setSampleJson] = useState("");
  const [duplicateMerge, setDuplicateMerge] = useState({
    open: false,
    checking: false,
    merging: false,
    groups: [],
    selectedBySourceId: {},
    deleteAfterMerge: false,
    error: "",
    result: null,
  });
  const [sheetUpdate, setSheetUpdate] = useState({
    loading: false,
    applying: false,
    pendingLogin: false,
    plan: null,
    result: null,
    error: "",
  });
  const [sheetMappingMerge, setSheetMappingMerge] = useState({
    open: false,
    checking: false,
    applying: false,
    conflicts: [],
    selectedByProblemNo: {},
    pendingBody: null,
    error: "",
    result: null,
  });
  const [clearRecordsDialog, setClearRecordsDialog] = useState({
    open: false,
    clearing: false,
    error: "",
  });
  const [selectedRecordKeys, setSelectedRecordKeys] = useState({});
  const [recordPreviewByKey, setRecordPreviewByKey] = useState({});
  const [deleteRecordsDialog, setDeleteRecordsDialog] = useState({
    open: false,
    deleting: false,
    records: [],
    recordKeys: [],
    error: "",
  });
  const quickRunPollRef = useRef("");
  const quickRunEventBufferRef = useRef([]);
  const quickRunEventKeysRef = useRef(new Set());
  const quickRunEventFlushTimerRef = useRef(null);
  const quickRunEventVersionRef = useRef(0);
  const syncResultGuardTimerRef = useRef(null);
  const attachmentModeDefaultMigrationRef = useRef(false);
  const initialLoadStartedRef = useRef(false);
  const initialLoaderRef = useRef(null);
  const sheetUpdatePlanRef = useRef(null);
  const retrySheetApplyAfterFeishuLoginRef = useRef(false);
  const retrySheetPreviewAfterFeishuLoginRef = useRef(null);

  if (!initialLoaderRef.current) {
    initialLoaderRef.current = createFeishuProjectSyncLoader({ request: api });
  }

  useEffect(() => {
    rememberPreviewWorkItemIdsDraft(workItemIds);
  }, [workItemIds]);

  useEffect(() => {
    const availableKeys = new Set(records.map(recordKey));
    setSelectedRecordKeys((current) => {
      const next = Object.fromEntries(Object.keys(current || {}).filter((key) => availableKeys.has(key)).map((key) => [key, true]));
      const currentKeys = Object.keys(current || {});
      return currentKeys.length === Object.keys(next).length && currentKeys.every((key) => next[key]) ? current : next;
    });
  }, [records]);

  useEffect(() => {
    sheetUpdatePlanRef.current = sheetUpdate.plan || null;
  }, [sheetUpdate.plan]);

  const showToast = (message, ok = true) => {
    setToast({ message, ok });
    setTimeout(() => setToast(null), 3200);
  };

  function holdSyncResultView(durationMs = 1200) {
    setSyncViewPending(true);
    if (syncResultGuardTimerRef.current) clearTimeout(syncResultGuardTimerRef.current);
    syncResultGuardTimerRef.current = setTimeout(() => {
      syncResultGuardTimerRef.current = null;
      setSyncViewPending(false);
    }, durationMs);
  }

  function releaseSyncResultView() {
    if (syncResultGuardTimerRef.current) clearTimeout(syncResultGuardTimerRef.current);
    syncResultGuardTimerRef.current = null;
    setSyncViewPending(false);
  }

  const setCfg = (path, value) => {
    if (!canEdit) return;
    const nextValue = path === "feishu.authMode" ? (rememberFeishuAuthMode(value) || value) : value;
    setConfig((prev) => setPath(prev || {}, path, nextValue));
  };

  async function saveConfigSnapshot(nextConfig, { quiet = false, successMessage = "同步规则已保存" } = {}) {
    if (!canEdit) {
      if (!quiet) showToast("请先登录管理后台再保存规则", false);
      return null;
    }
    if (!nextConfig) return null;
    const preparedConfig = prepareFeishuSourceViewsConfig(nextConfig);
    const data = await api("/config", { method: "PUT", body: { config: preparedConfig }, auth: true });
    setConfig(data.config || preparedConfig);
    setReadiness(data.readiness || readiness);
    loadFeishuMcpStatus();
    if (!quiet) showToast(successMessage);
    return data;
  }

  async function saveAttachmentMode(value, { quiet = false } = {}) {
    if (!canEdit) {
      if (!quiet) showToast("请先登录管理后台再保存附件处理方式", false);
      return null;
    }
    const mode = ["upload", "comment_link", "skip"].includes(String(value)) ? String(value) : "upload";
    const previousConfig = config;
    let nextConfig = setPath(config || {}, "sync.attachmentMode", mode);
    nextConfig = setPath(nextConfig, "sync.attachmentModeDefaultMigrated", true);
    setConfig(nextConfig);
    try {
      return await saveConfigSnapshot(nextConfig, { quiet, successMessage: "附件处理方式已保存" });
    } catch (err) {
      setConfig(previousConfig || nextConfig);
      showToast(`附件处理方式保存失败：${err.message}`, false);
      return null;
    }
  }

  async function loadTbLoginStatus({ refreshing = false } = {}) {
    try {
      const { resp, data } = await fetchJsonWithSameOriginFallback("/api/tb-tasks/cookie-check", { timeoutMs: 8000 });
      if (!resp.ok || !data.success) throw new Error(data.error || `HTTP ${resp.status}`);
      const status = data.data || {};
      const next = {
        checked: true,
        valid: !!status.valid,
        user: status.user || "",
        id: status.id || "",
        reason: status.reason || "",
        refreshing: refreshing && !status.valid,
      };
      setTbLogin(next);
      return next;
    } catch (err) {
      const next = { checked: true, valid: false, user: "", id: "", reason: err.message || "检测失败", refreshing };
      setTbLogin(next);
      return next;
    }
  }

  async function loadTbProjects({ open = false } = {}) {
    if (!canEdit) {
      showToast("需要先登录管理后台才能读取 TB 项目列表", false);
      setTbProjects((prev) => ({ ...prev, pickerOpen: open || prev.pickerOpen }));
      return;
    }
    setTbProjects((prev) => ({ ...prev, loading: true, error: "", pickerOpen: open || prev.pickerOpen }));
    try {
      const data = await api("/tb-projects", { auth: true });
      setTbProjects((prev) => ({
        ...prev,
        loaded: true,
        loading: false,
        projects: data.projects || [],
        currentProjectId: data.currentProjectId || getPath(config || {}, "teambition.projectId", ""),
        error: "",
        pickerOpen: open || prev.pickerOpen,
      }));
      if (!data.projects?.length) showToast("没有读取到 TB 项目，请确认 TB 登录态和项目权限", false);
    } catch (err) {
      setTbProjects((prev) => ({ ...prev, loaded: true, loading: false, error: err.message || "读取 TB 项目失败", pickerOpen: true }));
      showToast(`读取 TB 项目失败：${err.message}`, false);
    }
  }

  async function openTbProjectPicker() {
    setTbProjects((prev) => ({ ...prev, pickerOpen: true }));
    if (!tbProjects.loaded && !tbProjects.loading) await loadTbProjects({ open: true });
  }

  async function selectTbProject(projectId) {
    if (!canEdit) {
      showToast("需要先登录管理后台才能保存 TB 项目", false);
      return;
    }
    const id = String(projectId || "").trim();
    if (!id || !config) return;
    const project = (tbProjects.projects || []).find((p) => String(p.id) === id);
    let nextConfig = setPath(config, "teambition.projectId", id);
    nextConfig = setPath(nextConfig, "teambition.projectName", String(project?.name || "").trim());
    if (String(getPath(config, "teambition.projectId", "")) !== id) {
      nextConfig = setPath(nextConfig, "teambition.sprintId", "");
      nextConfig = setPath(nextConfig, "teambition.sprintName", "");
      nextConfig = setPath(nextConfig, "teambition.sprintUrl", "");
    }
    setTbProjects((prev) => ({ ...prev, savingProjectId: id, currentProjectId: id }));
    setTbTasklists((prev) => ({ ...prev, loaded: false, loadedProjectId: "", tasklists: [], currentTasklistId: "" }));
    setTbSprints((prev) => ({ ...prev, loaded: false, loadedProjectId: "", sprints: [], currentSprintId: "" }));
    setConfig(nextConfig);
    try {
      const data = await api("/config", { method: "PUT", body: { config: nextConfig }, auth: true });
      setConfig(data.config || nextConfig);
      setReadiness(data.readiness || readiness);
      setTbProjects((prev) => ({ ...prev, savingProjectId: "", currentProjectId: id, pickerOpen: false }));
      showToast(`已设置 TB 测试项目：${project?.name || id}`);
    } catch (err) {
      setTbProjects((prev) => ({ ...prev, savingProjectId: "" }));
      showToast(`保存 TB 项目失败：${err.message}`, false);
    }
  }

  async function loadTbTasklists({ projectId, refresh = false, allProjects = false } = {}) {
    if (!canEdit) {
      showToast("需要先登录管理后台才能读取 TB 项目列表", false);
      return [];
    }
    if (allProjects) {
      setTbTasklists((prev) => ({ ...prev, loading: true, error: "", loadedProjectId: "*" }));
      try {
        const data = await api(`/tb-target-options${refresh ? "?refresh=1" : ""}`, { auth: true, timeoutMs: 60000 });
        const tasklists = data.options || [];
        setTbTasklists((prev) => ({
          ...prev,
          loaded: true,
          loading: false,
          loadedProjectId: "*",
          tasklists,
          currentTasklistId: data.currentTasklistId || getPath(config || {}, "teambition.tasklistId", ""),
          error: "",
        }));
        if (!tasklists.length) showToast("娌℃湁璇诲彇鍒?TB 椤圭洰涓嬫媺椤癸紝璇风‘璁?TB 鐧诲綍鎬佸拰椤圭洰鏉冮檺", false);
        return tasklists;
      } catch (err) {
        setTbTasklists((prev) => ({ ...prev, loaded: true, loading: false, loadedProjectId: "*", error: err.message || "璇诲彇 TB 椤圭洰涓嬫媺澶辫触" }));
        showToast(`璇诲彇 TB 椤圭洰涓嬫媺澶辫触锛?{err.message}`, false);
        return [];
      }
    }
    const pid = String(projectId || getPath(config || {}, "teambition.projectId", "")).trim();
    if (!pid) {
      showToast("请先选择 TB 项目", false);
      return [];
    }
    const projectName = (tbProjects.projects || []).find((project) => String(project.id) === pid)?.name || "";
    setTbTasklists((prev) => ({ ...prev, loading: true, error: "", loadedProjectId: pid }));
    try {
      const data = await api(`/tb-tasklists?projectId=${encodeURIComponent(pid)}${projectName ? `&projectName=${encodeURIComponent(projectName)}` : ""}${refresh ? "&refresh=1" : ""}`, { auth: true, timeoutMs: 30000 });
      const tasklists = data.tasklists || [];
      setTbTasklists((prev) => ({
        ...prev,
        loaded: true,
        loading: false,
        loadedProjectId: pid,
        tasklists,
        currentTasklistId: data.currentTasklistId || getPath(config || {}, "teambition.tasklistId", ""),
        error: "",
      }));
      if (!tasklists.length) showToast("没有读取到 TB 项目下拉项，请确认 TB 登录态和项目权限", false);
      return tasklists;
    } catch (err) {
      setTbTasklists((prev) => ({ ...prev, loaded: true, loading: false, loadedProjectId: pid, error: err.message || "读取 TB 项目下拉失败" }));
      showToast(`读取 TB 项目下拉失败：${err.message}`, false);
      return [];
    }
  }

  async function selectTbTasklist(tasklist) {
    if (!canEdit) {
      showToast("需要先登录管理后台才能保存同步后的 TB 项目", false);
      return;
    }
    const tasklistId = String(tasklist?.id || tasklist?.tasklistId || "").trim();
    const projectId = String(tasklist?.projectId || getPath(config || {}, "teambition.projectId", "")).trim();
    if (!tasklistId || !projectId || !config) return;
    const tasklistName = String(tasklist?.name || tasklist?.title || "").trim();
    const projectName = String(tasklist?.projectName || (tbProjects.projects || []).find((project) => String(project.id) === projectId)?.name || "").trim();
    const projectPathName = String(tasklist?.pathName || [projectName, tasklistName].filter(Boolean).join(" / ") || tasklistName).trim();
    const previousProjectId = String(getPath(config, "teambition.projectId", "")).trim();
    let nextConfig = setPath(config, "teambition.projectId", projectId);
    nextConfig = setPath(nextConfig, "teambition.tasklistId", tasklistId);
    nextConfig = setPath(nextConfig, "teambition.tasklistName", tasklistName);
    nextConfig = setPath(nextConfig, "teambition.projectPathName", projectPathName);
    if (previousProjectId && previousProjectId !== projectId) {
      nextConfig = setPath(nextConfig, "teambition.sprintId", "");
      nextConfig = setPath(nextConfig, "teambition.sprintName", "");
      nextConfig = setPath(nextConfig, "teambition.sprintUrl", "");
      setTbSprints((prev) => ({ ...prev, loaded: false, loadedProjectId: "", sprints: [], currentSprintId: "" }));
    }
    setTbTasklists((prev) => ({ ...prev, savingTasklistId: tasklistId, currentTasklistId: tasklistId }));
    setConfig(nextConfig);
    try {
      const data = await api("/config", { method: "PUT", body: { config: nextConfig }, auth: true });
      setConfig(data.config || nextConfig);
      setReadiness(data.readiness || readiness);
      setTbTasklists((prev) => ({ ...prev, savingTasklistId: "", currentTasklistId: tasklistId }));
      showToast(`已设置同步后的 TB 项目：${projectPathName || tasklistName || tasklistId}`);
    } catch (err) {
      setTbTasklists((prev) => ({ ...prev, savingTasklistId: "" }));
      showToast(`保存同步后的 TB 项目失败：${err.message}`, false);
    }
  }

  async function loadTbSprints({ projectId, refresh = false } = {}) {
    if (!canEdit) {
      showToast("需要先登录管理后台才能读取 TB 迭代列表", false);
      return [];
    }
    const pid = String(projectId || getPath(config || {}, "teambition.projectId", "")).trim();
    if (!pid) {
      showToast("请先选择 TB 项目", false);
      return [];
    }
    setTbSprints((prev) => ({ ...prev, loading: true, error: "", loadedProjectId: pid }));
    try {
      const data = await api(`/tb-sprints?projectId=${encodeURIComponent(pid)}${refresh ? "&refresh=1" : ""}`, { auth: true, timeoutMs: 30000 });
      const sprints = data.sprints || [];
      setTbSprints((prev) => ({
        ...prev,
        loaded: true,
        loading: false,
        loadedProjectId: pid,
        sprints,
        currentSprintId: data.currentSprintId || getPath(config || {}, "teambition.sprintId", ""),
        error: "",
      }));
      if (!sprints.length) showToast("没有读取到 TB 迭代，请确认 TB 登录态和项目权限", false);
      return sprints;
    } catch (err) {
      setTbSprints((prev) => ({ ...prev, loaded: true, loading: false, loadedProjectId: pid, error: err.message || "读取 TB 迭代失败" }));
      showToast(`读取 TB 迭代失败：${err.message}`, false);
      return [];
    }
  }

  async function selectTbSprint(sprint) {
    if (!canEdit) {
      showToast("需要先登录管理后台才能保存 TB 目标迭代", false);
      return;
    }
    const sprintId = String(sprint?.id || sprint?.sprintId || "").trim();
    const projectId = String(sprint?.projectId || getPath(config || {}, "teambition.projectId", "")).trim();
    if (!sprintId || !projectId || !config) return;
    const sprintName = String(sprint?.name || sprint?.title || "").trim();
    let nextConfig = setPath(config, "teambition.projectId", projectId);
    nextConfig = setPath(nextConfig, "teambition.sprintId", sprintId);
    nextConfig = setPath(nextConfig, "teambition.sprintName", sprintName);
    nextConfig = setPath(nextConfig, "teambition.sprintUrl", sprint.url || teambitionSprintUrl(projectId, sprintId));
    setTbSprints((prev) => ({ ...prev, savingSprintId: sprintId, currentSprintId: sprintId }));
    setConfig(nextConfig);
    try {
      const data = await api("/config", { method: "PUT", body: { config: nextConfig }, auth: true });
      setConfig(data.config || nextConfig);
      setReadiness(data.readiness || readiness);
      setTbSprints((prev) => ({ ...prev, savingSprintId: "", currentSprintId: sprintId }));
      showToast(`已设置 TB 目标迭代：${sprintName || sprintId}`);
    } catch (err) {
      setTbSprints((prev) => ({ ...prev, savingSprintId: "" }));
      showToast(`保存 TB 目标迭代失败：${err.message}`, false);
    }
  }

  async function loadTbMembers({ query, refresh = false } = {}) {
    if (!canEdit) {
      showToast("需要先登录管理后台才能读取 TB 成员列表", false);
      return [];
    }
    const q = String(query ?? tbMembers.query ?? "").trim();
    setTbMembers((prev) => ({ ...prev, query: q, loading: true, error: "" }));
    try {
      const data = await api(`/tb-members?q=${encodeURIComponent(q)}${refresh ? "&refresh=1" : ""}`, { auth: true, timeoutMs: 30000 });
      const members = data.members || [];
      setTbMembers((prev) => ({
        ...prev,
        loaded: true,
        loading: false,
        members,
        selectedById: { ...(prev.selectedById || {}), ...memberCacheFromList(members) },
        error: "",
        query: q,
      }));
      if (!members.length) showToast(`没有找到 TB 成员：${q || "全部"}`, false);
      return members;
    } catch (err) {
      setTbMembers((prev) => ({ ...prev, loaded: true, loading: false, error: err.message || "读取 TB 成员失败", query: q }));
      showToast(`读取 TB 成员失败：${err.message}`, false);
      return [];
    }
  }

  async function selectRequiredTbMember(member) {
    if (!canEdit) {
      showToast("需要先登录管理后台才能保存固定参与者", false);
      return;
    }
    const id = String(member?.id || member?.uid || member?._id || "").trim();
    if (!id || !config) return;
    const current = normalizeListValue(getPath(config, "teambition.requiredInvolveMembers", []));
    const nextMembers = uniqList([...current, id]);
    if (nextMembers.length === current.length) {
      showToast(`${member?.name || id} 已经在固定参与者中`);
      return;
    }
    const nextConfig = setPath(config, "teambition.requiredInvolveMembers", nextMembers);
    setConfig(nextConfig);
    setTbMembers((prev) => ({
      ...prev,
      savingMemberId: id,
      selectedById: {
        ...(prev.selectedById || {}),
        ...memberCacheFromList([member]),
      },
    }));
    try {
      const data = await api("/config", { method: "PUT", body: { config: nextConfig }, auth: true });
      setConfig(data.config || nextConfig);
      setReadiness(data.readiness || readiness);
      showToast(`已设置固定 TB 参与者：${member?.name || id}`);
    } catch (err) {
      showToast(`保存固定参与者失败：${err.message}`, false);
    } finally {
      setTbMembers((prev) => ({ ...prev, savingMemberId: "" }));
    }
  }

  async function removeRequiredTbMember(memberId) {
    if (!canEdit) {
      showToast("需要先登录管理后台才能保存固定参与者", false);
      return;
    }
    const id = String(memberId || "").trim();
    if (!id || !config) return;
    const current = normalizeListValue(getPath(config, "teambition.requiredInvolveMembers", []));
    const nextConfig = setPath(config, "teambition.requiredInvolveMembers", current.filter((item) => item !== id));
    setConfig(nextConfig);
    try {
      const data = await api("/config", { method: "PUT", body: { config: nextConfig }, auth: true });
      setConfig(data.config || nextConfig);
      setReadiness(data.readiness || readiness);
      showToast("已移除固定 TB 参与者");
    } catch (err) {
      showToast(`移除固定参与者失败：${err.message}`, false);
    }
  }

  async function loadFeishuWebStatus({ refreshing = false, passive = true, activeOnly = false } = {}) {
    try {
      const status = await api(`/web-status?passive=${passive ? "1" : "0"}${activeOnly ? "&activeOnly=1" : ""}`, { timeoutMs: passive ? 5000 : 8000 });
      const next = {
        checked: true,
        valid: !!status.valid,
        finalUrl: status.finalUrl || "",
        homepageUrl: status.homepageUrl || "",
        reason: status.reason || "",
        cookieCount: status.cookieCount || 0,
        passive: !!status.passive,
        activePageRead: !!status.activePageRead,
        skippedBrowserLaunch: !!status.skippedBrowserLaunch,
        profileDir: status.profileDir || "",
        refreshing: refreshing && !status.valid,
      };
      setFeishuWeb(next);
      return next;
    } catch (err) {
      const next = { checked: true, valid: false, finalUrl: "", reason: err.message || "检测失败", refreshing, passive, activePageRead: false, skippedBrowserLaunch: false };
      setFeishuWeb(next);
      return next;
    }
  }

  async function loadFeishuMcpStatus({ refreshing = false, configuredFallback = false } = {}) {
    try {
      const status = await api(`/mcp-status${refreshing ? "?refresh=1" : ""}`, { timeoutMs: 30000 });
      const next = {
        checked: true,
        configured: !!status.configured,
        connected: !!status.connected,
        needsAuthorization: !!status.needsAuthorization,
        authorizationUrl: status.authorizationUrl || "",
        error: status.error || "",
        serverUrl: status.serverUrl || "",
        transport: status.transport || "",
        effectiveTransport: status.effectiveTransport || status.transport || "",
        hasHeaderToken: !!status.hasHeaderToken,
        toolCount: status.toolCount || 0,
        tools: status.tools || [],
        refreshing: false,
        degraded: false,
        lastConnected: !!status.connected,
      };
      setFeishuMcp(next);
      return next;
    } catch (err) {
      let next;
      setFeishuMcp((previous) => {
        const detail = err.message || "检测失败";
        next = {
          ...previous,
          checked: true,
          configured: !!previous.configured || !!configuredFallback,
          connected: false,
          lastConnected: !!previous.connected || !!previous.lastConnected,
          needsAuthorization: !!previous.needsAuthorization,
          error: `MCP 状态检测暂时失败：${detail}；已保存的登录配置未被清除`,
          refreshing: false,
          degraded: true,
        };
        return next;
      });
      return next || {
        checked: true,
        configured: !!configuredFallback,
        connected: false,
        needsAuthorization: false,
        error: err.message || "检测失败",
        refreshing: false,
        degraded: true,
      };
    }
  }

  async function loadFeishuFilterMetadata({ quiet = false } = {}) {
    if (!canEdit) {
      if (!quiet) showToast("需要先登录管理后台才能读取飞书筛选选项", false);
      return null;
    }
    setFeishuFilterMeta((prev) => ({ ...prev, loading: true, error: "" }));
    try {
      const data = await api("/mcp-filter-metadata", { auth: true, timeoutMs: 60000 });
      const next = {
        loaded: true,
        loading: false,
        fields: data.fields || [],
        roles: data.roles || [],
        error: "",
        generatedAt: data.generatedAt || "",
        projectKey: data.projectKey || "",
        workItemTypeKey: data.workItemTypeKey || "",
        workItemTypeName: data.workItemTypeName || "",
      };
      setFeishuFilterMeta(next);
      if (!quiet) showToast(`已读取飞书筛选选项：字段 ${next.fields.length} 个，角色 ${next.roles.length} 个`);
      return next;
    } catch (err) {
      setFeishuFilterMeta((prev) => ({ ...prev, loaded: true, loading: false, error: err.message || "读取飞书筛选选项失败" }));
      if (!quiet) showToast(`读取飞书筛选选项失败：${err.message}`, false);
      return null;
    }
  }

  async function pollFeishuWebStatus() {
    for (let i = 0; i < 100; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 3000));
      const status = await loadFeishuWebStatus({ refreshing: true, passive: true, activeOnly: true });
      if (status.valid) {
        showToast("飞书个人网页登录态已生效");
        loadAll();
        if (retrySheetApplyAfterFeishuLoginRef.current) {
          retrySheetApplyAfterFeishuLoginRef.current = false;
          setSheetUpdate((prev) => ({ ...prev, pendingLogin: false, applying: false, error: "" }));
          setTimeout(() => applySheetUpdate({ retryAfterLogin: true }), 100);
        } else if (retrySheetPreviewAfterFeishuLoginRef.current) {
          const pending = retrySheetPreviewAfterFeishuLoginRef.current;
          retrySheetPreviewAfterFeishuLoginRef.current = null;
          setSheetUpdate((prev) => ({ ...prev, pendingLogin: false, loading: true, error: "" }));
          setTimeout(() => prepareSheetUpdate(pending.syncResult, pending.options || {}), 100);
        }
        return;
      }
    }
    setFeishuWeb((prev) => ({ ...prev, refreshing: false, reason: prev.reason || "飞书网页登录检测超时" }));
  }

  async function pollTbLoginStatus() {
    for (let i = 0; i < 100; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 3000));
      const status = await loadTbLoginStatus({ refreshing: true });
      if (status.valid) {
        showToast("TB 登录态已生效");
        return;
      }
    }
    setTbLogin((prev) => ({ ...prev, refreshing: false, reason: prev.reason || "TB 登录检测超时" }));
  }

  async function loadErrors({ force = false } = {}) {
    if (errorsLoading && !force) return;
    setErrorsLoading(true);
    setErrorsError("");
    try {
      const data = await initialLoaderRef.current.loadErrors({ force });
      setErrors(data.errors || []);
      setRetryable(data.retryable || []);
      setRawPayloads(data.rawPayloads || []);
      setErrorsLoaded(true);
      if (data.failures?.length) {
        setErrorsError(`部分错误明细读取失败：${data.failures.map((item) => item.error?.message || item.key).join("；")}`);
      }
    } finally {
      setErrorsLoading(false);
    }
  }

  async function loadAll({ quiet = false } = {}) {
    if (!quiet) setAdminError("");
    setConfigLoading(true);
    setRecordsLoading(true);
    setRecordsError("");

    const initial = initialLoaderRef.current.loadInitial();
    let loadedConfig = null;
    let loadedReadiness = null;

    void initial.records.then((result) => {
      if (result.ok) setRecords(result.value || []);
      else {
        setRecordsError(result.error?.message || String(result.error));
        if (!quiet) showToast(`同步关系读取失败：${result.error?.message || result.error}`, false);
      }
      setRecordsLoading(false);
    });

    const configResult = await initial.config;
    setConfigLoading(false);
    if (configResult.ok) {
      const cfg = configResult.value || {};
      loadedConfig = applyRememberedFeishuAuthMode(cfg.config || {});
      loadedReadiness = cfg.readiness || null;
      setConfig(applySourceViewsToConfig(loadedConfig, normalizeFeishuSourceViewsForUi(loadedConfig)));
      setFeishuFilterPreset(cfg.filterPreset || null);
      setReadiness(loadedReadiness);
    } else if (!quiet) {
      setAdminError(`读取配置失败：${configResult.error?.message || configResult.error}`);
    }

    if (!quiet) {
      const authMode = getPath(loadedConfig || {}, "feishu.authMode", loadedReadiness?.authMode || "plugin");
      if (authMode === "mcp") {
        const configuredFallback = !!getPath(loadedConfig || {}, "feishu.mcp.serverUrl", "");
        void loadFeishuMcpStatus({ configuredFallback });
      } else if (authMode === "web") {
        void loadFeishuWebStatus();
      }
    }
  }

  useEffect(() => {
    if (!initialLoadStartedRef.current) {
      initialLoadStartedRef.current = true;
      loadAll();
    }
    return () => {
      quickRunPollRef.current = "";
      if (syncResultGuardTimerRef.current) clearTimeout(syncResultGuardTimerRef.current);
      if (quickRunEventFlushTimerRef.current) clearTimeout(quickRunEventFlushTimerRef.current);
      quickRunEventBufferRef.current = [];
      quickRunEventKeysRef.current = new Set();
      quickRunEventVersionRef.current += 1;
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    setAdminError((prev) => {
      if (prev?.startsWith("读取配置失败")) return prev;
      if (adminLoading) return "正在确认管理员身份，配置与同步操作暂时只读。";
      return canEdit ? "" : "未登录管理后台：当前为只读模式，可查看同步状态、映射表和规则；编辑配置、dry-run、/run 需要管理员登录。";
    });
  }, [adminLoading, canEdit]);

  useEffect(() => {
    if (activeTab !== "config" || !canEdit || !config || !feishuMcp.connected || feishuFilterMeta.loaded || feishuFilterMeta.loading) return;
    loadFeishuFilterMetadata({ quiet: true });
  }, [activeTab, canEdit, config, feishuMcp.connected, feishuFilterMeta.loaded, feishuFilterMeta.loading]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (activeTab !== "errors" || errorsLoaded || errorsLoading) return;
    loadErrors();
  }, [activeTab, errorsLoaded, errorsLoading]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (activeTab !== "config" || !config || tbLogin.checked || tbLogin.refreshing) return;
    loadTbLoginStatus();
  }, [activeTab, config, tbLogin.checked, tbLogin.refreshing]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!canEdit || !config || attachmentModeDefaultMigrationRef.current) return;
    const mode = String(getPath(config, "sync.attachmentMode", ""));
    const migrated = getPath(config, "sync.attachmentModeDefaultMigrated", false) === true;
    if (mode !== "comment_link" || migrated) return;
    attachmentModeDefaultMigrationRef.current = true;
    saveAttachmentMode("upload", { quiet: true });
  }, [canEdit, config?.sync?.attachmentMode, config?.sync?.attachmentModeDefaultMigrated]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!canEdit || !config) return;
    const requiredIds = normalizeListValue(getPath(config, "teambition.requiredInvolveMembers", []));
    const missingIds = requiredIds.filter((id) => !tbMembers.selectedById?.[id]);
    if (!missingIds.length) return;
    let cancelled = false;
    setTbMembers((prev) => ({ ...prev, resolving: true }));
    Promise.all(missingIds.map(async (id) => {
      try {
        const data = await api(`/tb-members?q=${encodeURIComponent(id)}`, { auth: true, timeoutMs: 15000 });
        const members = data.members || [];
        return members.find((member) => String(member.id) === String(id)) || members[0] || { id, name: id };
      } catch {
        return { id, name: id };
      }
    })).then((members) => {
      if (cancelled) return;
      setTbMembers((prev) => ({
        ...prev,
        resolving: false,
        selectedById: { ...(prev.selectedById || {}), ...memberCacheFromList(members) },
      }));
    });
    return () => { cancelled = true; };
  }, [canEdit, config, tbMembers.selectedById]);

  const stats = useMemo(() => ({
    total: records.length,
    success: records.filter((r) => r.syncStatus === "success").length,
    failed: records.filter((r) => r.syncStatus === "failed").length,
    retryable: retryable.length,
  }), [records, retryable]);

  async function saveConfig() {
    if (!canEdit) {
      showToast("请先登录管理后台再保存规则", false);
      return;
    }
    if (!config) return;
    setSaving(true);
    try {
      await saveConfigSnapshot(config);
    } catch (err) {
      showToast(`保存失败：${err.message}`, false);
    } finally {
      setSaving(false);
    }
  }

  async function persistConfig({ quiet = false } = {}) {
    return saveConfigSnapshot(config, { quiet });
  }

  async function setCurrentFiltersAsPreset() {
    if (!canEdit || !config || feishuFilterConfigBusy) return;
    setFeishuFilterConfigBusy("preset");
    try {
      await saveConfigSnapshot(config, { quiet: true });
      const backup = buildFeishuFilterBackup(config);
      const data = await api("/filter-preset", { method: "PUT", body: backup, auth: true });
      setFeishuFilterPreset(data.preset || null);
      showToast("当前筛选条件已设为持久预置");
    } catch (err) {
      showToast(`设置预置失败：${err.message}`, false);
    } finally {
      setFeishuFilterConfigBusy("");
    }
  }

  function backupCurrentFilters() {
    if (!config) return;
    try {
      const backup = buildFeishuFilterBackup(config);
      const blob = new Blob([`${JSON.stringify(backup, null, 2)}\n`], { type: "application/json;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `feishu-filter-backup-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
      showToast("筛选条件备份已生成");
    } catch (err) {
      showToast(`备份失败：${err.message}`, false);
    }
  }

  async function restoreFiltersFromBackup(file) {
    if (!canEdit || !config || !file || feishuFilterConfigBusy) return;
    setFeishuFilterConfigBusy("restore");
    try {
      const payload = JSON.parse(await file.text());
      const restored = parseFeishuFilterBackup(payload);
      let nextConfig = setPath(config, "sync.readScope", restored.readScope);
      nextConfig = setPath(nextConfig, "sync.requiredAssigneeKeywords", restored.requiredAssigneeKeywords);
      setConfig(nextConfig);
      await saveConfigSnapshot(nextConfig, { quiet: true });
      showToast(`已还原 ${restored.readScope.filters.length} 条筛选条件`);
    } catch (err) {
      showToast(`还原失败：${err.message}`, false);
    } finally {
      setFeishuFilterConfigBusy("");
    }
  }

  function quickRunBody({ preferMcpForProblemNos = false } = {}) {
    const authMode = getPath(config, "feishu.authMode", readiness?.authMode || "plugin");
    const limit = Number(getPath(config, "sync.batchSize", 50)) || 50;
    const scope = feishuReadScopeFromConfig(config || {});
    const view = normalizeFeishuSourceViewForUi(config || {});
    const body = {
      limit,
      scope,
      sourceView: view,
      sourceViews: sourceViewsForRequest(config || {}),
      sort: syncSortForUi(config || {}),
      requiredAssigneeKeywords: ownerFilterValues(config || {}),
    };
    if (authMode === "mcp") body.source = "mcp";
    if (view.url) body.url = view.url;
    if (authMode === "web") {
      body.source = "web";
      body.url = view.url;
    }
    if (preferMcpForProblemNos && (feishuMcp?.connected || feishuMcp?.configured) && (authMode !== "web" || !feishuWeb?.valid)) {
      body.source = "mcp";
    }
    return body;
  }

  async function runQuickDryRun() {
    if (!canEdit) {
      showToast("dry-run 需要管理员登录", false);
      return;
    }
    setSyncViewPending(true);
    resetQuickRunEvents([]);
    setQuickRunBusy("dry-run");
    setQuickRunResult({ mode: "dry-run", status: "running", startedAt: new Date().toISOString() });
    let body = null;
    try {
      await persistConfig({ quiet: true });
      body = quickRunBody();
      const started = await api("/dry-run", { method: "POST", body: { ...body, async: true }, auth: true });
      resetQuickRunEvents(started.events || []);
      setQuickRunResult({ mode: "dry-run", status: "running", runId: started.id, run: compactRunSnapshot(started), data: runDisplayData(started), startedAt: started.startedAt || new Date().toISOString() });
      const done = await observeQuickRun(started.id, "dry-run");
      const { resultData: data, previewData } = await loadCompletedRunData(started.id, done, body?.source);
      setQuickRunResult({
        mode: "dry-run",
        status: data?.ok === false ? "failed" : "done",
        runId: started.id,
        run: compactRunSnapshot(done),
        data,
        error: data?.firstError || done?.error || "",
        startedAt: started.startedAt || new Date().toISOString(),
        finishedAt: done?.finishedAt || new Date().toISOString(),
      });
      setPreview(previewData);
      setActiveTab("preview");
      holdSyncResultView();
      showToast(`一键预检已完成：${formatSyncResultSummary(data)}`);
    } catch (err) {
      const message = err?.message || String(err);
      const data = isFeishuWebSource(body?.source) ? feishuWebFailureResult(message, err, { dryRun: true }) : null;
      setQuickRunResult({ mode: "dry-run", status: "failed", error: message, ...(data ? { data } : {}), finishedAt: new Date().toISOString() });
      if (data) {
        setPreview(data);
        setActiveTab("preview");
      }
      releaseSyncResultView();
      showToast(`一键预检失败：${message}`, false);
    } finally {
      quickRunPollRef.current = "";
      setQuickRunBusy("");
    }
  }

  function resetQuickRunEvents(events = []) {
    quickRunEventVersionRef.current += 1;
    const next = visibleRunEvents(events);
    quickRunEventBufferRef.current = [];
    quickRunEventKeysRef.current = runEventKeySet(next);
    if (quickRunEventFlushTimerRef.current) {
      clearTimeout(quickRunEventFlushTimerRef.current);
      quickRunEventFlushTimerRef.current = null;
    }
    scheduleTransition(() => setQuickRunEvents(next));
  }

  function flushQuickRunEvents() {
    const pending = quickRunEventBufferRef.current;
    if (!pending.length) return;
    const version = quickRunEventVersionRef.current;
    quickRunEventBufferRef.current = [];
    scheduleTransition(() => {
      setQuickRunEvents((prev) => {
        if (version !== quickRunEventVersionRef.current) return prev;
        const next = appendUniqueRunEvents(prev, pending);
        quickRunEventKeysRef.current = runEventKeySet(next);
        return next;
      });
    });
  }

  function appendQuickRunEvent(evt) {
    if (!evt) return;
    const key = runEventKey(evt);
    if (quickRunEventKeysRef.current.has(key)) return;
    quickRunEventKeysRef.current.add(key);
    quickRunEventBufferRef.current.push(evt);
    if (quickRunEventFlushTimerRef.current) return;
    quickRunEventFlushTimerRef.current = setTimeout(() => {
      quickRunEventFlushTimerRef.current = null;
      flushQuickRunEvents();
    }, RUN_EVENT_FLUSH_MS);
  }

  function applyQuickRunSnapshot(latest, runId, mode = "run") {
    resetQuickRunEvents(latest.events || []);
    const normalizedStatus = normalizeRunStatus(latest);
    const data = runDisplayData(latest);
    setQuickRunResult({
      mode,
      status: normalizedStatus,
      runId,
      run: compactRunSnapshot(latest),
      data,
      error: normalizedStatus === "failed" ? (latest.error || latest.result?.firstError || "") : "",
      startedAt: latest.startedAt,
      finishedAt: normalizedStatus === "running" || normalizedStatus === "settling" ? "" : (latest.finishedAt || new Date().toISOString()),
    });
  }

  async function observeQuickRun(runId, mode = "run") {
    quickRunPollRef.current = runId;
    try {
      const latest = await streamRunEvents(runId, {
        onRun: (run) => applyQuickRunSnapshot(run, runId, mode),
        onEvent: appendQuickRunEvent,
        isActive: () => quickRunPollRef.current === runId,
      });
      flushQuickRunEvents();
      if (latest?.status && latest.status !== "running") {
        if (normalizeRunStatus(latest) !== "settling") return latest;
      }
      if (quickRunPollRef.current !== runId) return latest;
    } catch {
      flushQuickRunEvents();
    }
    return pollQuickRun(runId, mode);
  }

  async function pollQuickRun(runId, mode = "run") {
    quickRunPollRef.current = runId;
    let latest = null;
    let settlingPolls = 0;
    while (quickRunPollRef.current === runId) {
      await sleep(900);
      latest = await api(`/runs/${encodeURIComponent(runId)}?includeResult=0`, { auth: true, timeoutMs: 8000 });
      applyQuickRunSnapshot(latest, runId, mode);
      const normalizedStatus = normalizeRunStatus(latest);
      if (normalizedStatus === "settling" && settlingPolls < 6) {
        settlingPolls += 1;
        continue;
      }
      if (normalizedStatus !== "running") break;
    }
    return latest;
  }

  async function loadRunResultPreview(runId) {
    if (!runId) return null;
    return api(`/runs/${encodeURIComponent(runId)}/result-preview`, { auth: true, timeoutMs: 60000 });
  }

  function resultDataFromRunPreview(payload, runId, fallbackRun = {}, source = "") {
    const fallback = fallbackRun?.result || fallbackRun?.resultSummary || runDisplayData(fallbackRun) || {};
    const result = payload?.result || fallback || {};
    const data = {
      ...(result && typeof result === "object" ? result : { ok: false, firstError: String(result || "") }),
      __runId: runId || payload?.runId || "",
      runId: runId || payload?.runId || "",
      resultsPreviewOnly: result?.resultsPreviewOnly !== false,
    };
    if (String(fallbackRun?.status || "").toLowerCase() === "failed" && data.ok !== false) data.ok = false;
    if (!data.firstError && fallbackRun?.error) data.firstError = fallbackRun.error;
    return withFeishuWebSourceMarker(data, source);
  }

  function previewDataFromRunPreview(payload, resultData) {
    if (payload?.preview || payload?.previewText) {
      return {
        ...(payload.preview || {}),
        resultSummary: resultData,
        __runId: resultData?.__runId || payload?.runId || "",
        __previewText: payload.previewText || "",
      };
    }
    return resultData;
  }

  async function loadCompletedRunData(runId, done, source = "") {
    try {
      const payload = await loadRunResultPreview(runId);
      const resultData = resultDataFromRunPreview(payload, runId, done, source);
      return {
        resultData,
        previewData: previewDataFromRunPreview(payload, resultData),
      };
    } catch {
      const resultData = resultDataFromRunPreview(null, runId, done, source);
      return { resultData, previewData: resultData };
    }
  }

  async function runAsyncSyncJob(body = {}) {
    try {
      const started = await api("/run", { method: "POST", body: { ...body, async: true }, auth: true });
      resetQuickRunEvents(started.events || []);
      setQuickRunResult({ mode: "run", status: "running", runId: started.id, run: compactRunSnapshot(started), data: runDisplayData(started), startedAt: started.startedAt || new Date().toISOString() });
      const done = await observeQuickRun(started.id, "run");
      const { resultData: data, previewData } = await loadCompletedRunData(started.id, done, body?.source);
      setQuickRunResult({
        mode: "run",
        status: data?.ok === false ? "failed" : "done",
        runId: started.id,
        run: compactRunSnapshot(done),
        data,
        error: data?.firstError || done?.error || "",
        startedAt: started.startedAt || new Date().toISOString(),
        finishedAt: done?.finishedAt || new Date().toISOString(),
      });
      prepareSheetUpdate(data, { quiet: true, suppressErrorToast: true, runId: started.id }).catch(() => null);
      return previewData;
    } finally {
      quickRunPollRef.current = "";
    }
  }

  function duplicateGroupKey(group = {}) {
    return group.sourceId || group.sourceWorkItemId || JSON.stringify(group.sourceKey || {});
  }

  function duplicateInitialSelections(groups = []) {
    const out = {};
    for (const group of groups || []) {
      const key = duplicateGroupKey(group);
      out[key] = group.recommendedTargetTaskId || group.existingTargetTaskId || group.tasks?.[0]?.id || "";
    }
    return out;
  }

  function sheetMappingConflictKey(conflict = {}) {
    return conflict.sourceWorkItemNo || conflict.sourceProblemNo || conflict.problemNo || conflict.sourceWorkItemId || JSON.stringify(conflict);
  }

  async function checkSheetMappingsBeforeRun(body = {}, options = {}) {
    const openDialog = options.openDialog !== false;
    const requestBody = { ...body, config };
    setSheetMappingMerge((prev) => ({
      ...prev,
      open: false,
      checking: true,
      applying: false,
      conflicts: [],
      selectedByProblemNo: {},
      pendingBody: requestBody,
      error: "",
      result: null,
    }));
    try {
      const data = await api("/sheet/mapping/check", {
        method: "POST",
        body: requestBody,
        auth: true,
        timeoutMs: 120000,
      });
      const conflicts = Array.isArray(data?.conflicts) ? data.conflicts : [];
      if (conflicts.length) {
        setSheetMappingMerge({
          open: openDialog,
          checking: false,
          applying: false,
          conflicts,
          selectedByProblemNo: {},
          pendingBody: requestBody,
          error: "",
          result: data,
        });
        showToast(`任务表格发现 ${conflicts.length} 个 TB 映射冲突，请先选择保留哪个 TB 单`, false);
        return false;
      }
      setSheetMappingMerge((prev) => ({
        ...prev,
        open: false,
        checking: false,
        applying: false,
        conflicts: [],
        selectedByProblemNo: {},
        pendingBody: null,
        error: "",
        result: data,
      }));
      if (data?.appliedCount) {
        showToast(`已从任务表格补齐 ${data.appliedCount} 条 TB 任务 ID，继续执行同步`);
        loadAll({ quiet: true });
      }
      return true;
    } catch (err) {
      setSheetMappingMerge((prev) => ({ ...prev, checking: false, error: err.message || String(err) }));
      throw err;
    }
  }

  async function checkDuplicatesBeforeRun(body = {}, options = {}) {
    const openDialog = options.openDialog !== false;
    setDuplicateMerge((prev) => ({
      ...prev,
      open: false,
      checking: true,
      merging: false,
      groups: [],
      selectedBySourceId: {},
      error: "",
      result: null,
    }));
    try {
      const data = await api("/duplicates/check", {
        method: "POST",
        body,
        auth: true,
        timeoutMs: 180000,
      });
      const groups = Array.isArray(data?.duplicates) ? data.duplicates : [];
      if (groups.length) {
        setDuplicateMerge({
          open: openDialog,
          checking: false,
          merging: false,
          groups,
          selectedBySourceId: duplicateInitialSelections(groups),
          deleteAfterMerge: false,
          error: "",
          result: data,
        });
        showToast(`发现 ${groups.length} 组重复 TB 单，请先选择合并目标`, false);
        return false;
      }
      setDuplicateMerge((prev) => ({
        ...prev,
        open: false,
        checking: false,
        merging: false,
        groups: [],
        selectedBySourceId: {},
        error: "",
        result: data,
      }));
      return true;
    } catch (err) {
      setDuplicateMerge((prev) => ({ ...prev, checking: false, error: err.message || String(err) }));
      throw err;
    }
  }

  async function confirmDuplicateMerge() {
    const groups = duplicateMerge.groups || [];
    const selectedBySourceId = duplicateMerge.selectedBySourceId || {};
    setDuplicateMerge((prev) => ({ ...prev, merging: true, error: "" }));
    const results = [];
    try {
      for (const group of groups) {
        const key = duplicateGroupKey(group);
        const targetTaskId = selectedBySourceId[key] || group.recommendedTargetTaskId || group.tasks?.[0]?.id || "";
        const targetTask = (group.tasks || []).find((task) => task.id === targetTaskId) || {};
        const duplicateTaskIds = (group.tasks || []).map((task) => task.id).filter(Boolean);
        const result = await api("/duplicates/merge", {
          method: "POST",
          body: {
            sourceId: group.sourceId,
            sourceKey: group.sourceKey,
            targetTaskId,
            targetUniqueId: targetTask.uniqueId || "",
            targetUpdatedAt: targetTask.updatedAt || "",
            duplicateTaskIds,
            deleteDuplicateTasks: duplicateMerge.deleteAfterMerge === true,
          },
          auth: true,
          timeoutMs: 120000,
        });
        results.push(result);
      }
      const failed = results.filter((result) => result?.ok === false || result?.deleteErrors?.length);
      if (failed.length) {
        setDuplicateMerge((prev) => ({ ...prev, merging: false, result: { results }, error: "部分重复单删除失败，合并关系已更新，请查看下方结果。" }));
        showToast("重复单已合并，但有删除失败项", false);
        return;
      }
      setDuplicateMerge((prev) => ({ ...prev, open: false, merging: false, result: { results } }));
      showToast("重复 TB 单已合并，请重新点击开始同步");
      loadAll();
    } catch (err) {
      setDuplicateMerge((prev) => ({ ...prev, merging: false, error: err.message || String(err) }));
      showToast(`合并重复 TB 单失败：${err.message}`, false);
    }
  }

  function selectSheetMappingTarget(conflict, choice) {
    const key = sheetMappingConflictKey(conflict);
    setSheetMappingMerge((prev) => ({
      ...prev,
      selectedByProblemNo: { ...(prev.selectedByProblemNo || {}), [key]: choice },
    }));
  }

  async function confirmSheetMappingMerge() {
    const conflicts = sheetMappingMerge.conflicts || [];
    const selectedByProblemNo = sheetMappingMerge.selectedByProblemNo || {};
    const missing = conflicts.some((conflict) => !selectedByProblemNo[sheetMappingConflictKey(conflict)]);
    if (missing) {
      showToast("每个任务表格映射冲突都需要选择保留哪个 TB 单", false);
      return;
    }
    const selections = conflicts.map((conflict) => ({
      sourceWorkItemNo: conflict.sourceWorkItemNo || conflict.sourceProblemNo || conflict.problemNo || "",
      sourceWorkItemId: conflict.sourceWorkItemId || "",
      choice: selectedByProblemNo[sheetMappingConflictKey(conflict)],
    }));
    setSheetMappingMerge((prev) => ({ ...prev, applying: true, error: "" }));
    try {
      const data = await api("/sheet/mapping/resolve", {
        method: "POST",
        body: {
          ...(sheetMappingMerge.pendingBody || {}),
          config,
          selections,
        },
        auth: true,
        timeoutMs: 120000,
      });
      const nextConflicts = Array.isArray(data?.conflicts) ? data.conflicts : [];
      if (nextConflicts.length) {
        setSheetMappingMerge((prev) => ({
          ...prev,
          applying: false,
          conflicts: nextConflicts,
          selectedByProblemNo: {},
          result: data,
          error: "仍有未处理的映射冲突，请重新选择。",
        }));
        showToast("仍有任务表格映射冲突未处理", false);
        return;
      }
      setSheetMappingMerge((prev) => ({
        ...prev,
        open: false,
        applying: false,
        conflicts: [],
        selectedByProblemNo: {},
        pendingBody: null,
        result: data,
        error: "",
      }));
      showToast("任务表格映射冲突已处理，请重新点击开始同步");
      loadAll({ quiet: true });
    } catch (err) {
      setSheetMappingMerge((prev) => ({ ...prev, applying: false, error: err.message || String(err) }));
      showToast(`处理任务表格映射冲突失败：${err.message}`, false);
    }
  }

  function openClearRecordsDialog() {
    if (!canEdit) {
      showToast("请先登录管理后台再清空映射表", false);
      return;
    }
    setClearRecordsDialog({ open: true, clearing: false, error: "" });
  }

  async function confirmClearRecords() {
    if (!canEdit) {
      showToast("请先登录管理后台再清空映射表", false);
      return;
    }
    setClearRecordsDialog((prev) => ({ ...prev, clearing: true, error: "" }));
    try {
      const data = await api("/records/clear", {
        method: "POST",
        body: { confirm: true },
        auth: true,
        timeoutMs: 30000,
      });
      setRecords([]);
      setErrors([]);
      setRetryable([]);
      setSelectedRecordKeys({});
      setRecordPreviewByKey({});
      setClearRecordsDialog({ open: false, clearing: false, error: "" });
      const clearedCount = Number(data?.records || 0);
      showToast(`已清空 ${clearedCount} 条映射关系，后续同步会按未同步处理`);
      loadAll({ quiet: true });
    } catch (err) {
      setClearRecordsDialog((prev) => ({ ...prev, clearing: false, error: err.message || String(err) }));
      showToast(`清空映射表失败：${err.message}`, false);
    }
  }

  function toggleRecordSelection(row, selected) {
    const key = recordKey(row);
    setSelectedRecordKeys((current) => {
      const next = { ...(current || {}) };
      if (selected) next[key] = true;
      else delete next[key];
      return next;
    });
  }

  function toggleRecordPageSelection(rows, selected) {
    setSelectedRecordKeys((current) => {
      const next = { ...(current || {}) };
      for (const row of uniqueRecordRows(rows)) {
        const key = recordKey(row);
        if (selected) next[key] = true;
        else delete next[key];
      }
      return next;
    });
  }

  function clearRecordSelection() {
    setSelectedRecordKeys({});
  }

  function dismissRecordPreview(row) {
    const key = recordKey(row);
    setRecordPreviewByKey((current) => {
      if (!current?.[key]) return current;
      const next = { ...current };
      delete next[key];
      return next;
    });
  }

  async function previewRecordSync(rows = []) {
    if (!canEdit) {
      showToast("映射记录 dry-run 需要管理员登录", false);
      return;
    }
    const targets = uniqueRecordRows(rows);
    if (!targets.length) {
      showToast("请先选择要同步的映射记录", false);
      return;
    }
    const requestId = `record-preview-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const targetKeys = targets.map(recordKey);
    setRecordPreviewByKey((current) => {
      const next = { ...current };
      for (const key of targetKeys) {
        next[key] = {
          ...(next[key] || {}),
          status: "loading",
          requestId,
          result: null,
          planId: "",
          expiresAt: "",
          error: "",
          errorStage: "",
        };
      }
      return next;
    });

    try {
      await persistConfig({ quiet: true });
      const workItemIds = uniqList(targets.map((row) => String(row.sourceWorkItemId || "").trim()).filter(Boolean));
      const workItemNos = uniqList(targets
        .filter((row) => !String(row.sourceWorkItemId || "").trim())
        .map(recordProblemNo)
        .filter((value) => value && value !== "-"));
      const body = {
        ...quickRunBody({ preferMcpForProblemNos: workItemNos.length > 0 }),
        records: targets.map(recordIdentityTuple),
        limit: targets.length,
        ...(workItemIds.length ? { workItemIds } : {}),
        ...(workItemNos.length ? { workItemNos } : {}),
      };
      const data = await api("/records/sync-preview", {
        method: "POST",
        body,
        auth: true,
        timeoutMs: 120000,
      });
      const planId = String(data?.planId || "").trim();
      const expiresAt = data?.expiresAt || "";
      const items = Array.isArray(data?.items) ? data.items : [];
      const itemByKey = new Map(items.map((item) => [String(item?.recordKey || ""), item]));
      const previewUpdates = new Map();
      let readyCount = 0;
      for (const row of targets) {
        const key = recordKey(row);
        const item = itemByKey.get(key);
        const result = item?.result || null;
        const resultError = result?.ok === false ? (result?.error || result?.firstError || "dry-run 失败") : "";
        const error = !planId
          ? "后端未返回可确认生效的 planId"
          : !item
            ? "后端未返回本行 dry-run 结果"
            : !result
              ? "本行 dry-run 结果为空"
              : resultError;
        if (!error) readyCount += 1;
        previewUpdates.set(key, {
          status: error ? "error" : "ready",
          requestId,
          result,
          planId,
          expiresAt,
          error,
          errorStage: error ? "preview" : "",
        });
      }
      setRecordPreviewByKey((current) => {
        const next = { ...current };
        for (const [key, update] of previewUpdates.entries()) {
          if (next[key]?.requestId !== requestId) continue;
          next[key] = update;
        }
        return next;
      });
      showToast(`映射记录 dry-run 已完成：可确认 ${readyCount}/${targets.length} 条`, readyCount === targets.length);
    } catch (err) {
      const message = err?.message || String(err);
      setRecordPreviewByKey((current) => {
        const next = { ...current };
        for (const key of targetKeys) {
          if (next[key]?.requestId !== requestId) continue;
          next[key] = { ...next[key], status: "error", error: message, errorStage: "preview" };
        }
        return next;
      });
      showToast(`映射记录 dry-run 失败：${message}`, false);
    }
  }

  async function applyRecordPreviews(rows = []) {
    if (!canEdit) {
      showToast("确认同步需要管理员登录", false);
      return;
    }
    const targets = uniqueRecordRows(rows);
    const groups = new Map();
    const expiredKeys = [];
    for (const row of targets) {
      const key = recordKey(row);
      const previewState = recordPreviewByKey[key];
      if (!previewState || previewState.status !== "ready" || !previewState.planId) continue;
      if (recordPreviewExpired(previewState)) {
        expiredKeys.push(key);
        continue;
      }
      if (!groups.has(previewState.planId)) groups.set(previewState.planId, []);
      groups.get(previewState.planId).push(key);
    }
    if (expiredKeys.length) {
      setRecordPreviewByKey((current) => {
        const next = { ...current };
        for (const key of expiredKeys) next[key] = { ...next[key], status: "expired", error: "dry-run 方案已过期，请重新预演", errorStage: "apply" };
        return next;
      });
    }
    if (!groups.size) {
      showToast(expiredKeys.length ? "dry-run 方案已过期，请重新预演" : "没有可确认生效的 dry-run 结果", false);
      return;
    }

    let appliedCount = 0;
    let failedCount = 0;
    for (const [planId, recordKeys] of groups.entries()) {
      setRecordPreviewByKey((current) => {
        const next = { ...current };
        for (const key of recordKeys) next[key] = { ...next[key], status: "applying", error: "", errorStage: "" };
        return next;
      });
      try {
        const data = await api("/records/sync-apply", {
          method: "POST",
          body: { planId, recordKeys },
          auth: true,
          timeoutMs: 120000,
        });
        const items = Array.isArray(data?.items) ? data.items : [];
        const itemByKey = new Map(items.map((item) => [String(item?.recordKey || ""), item]));
        const applyUpdates = new Map(recordKeys.map((key) => {
          const item = itemByKey.get(key);
          const failed = !item || !item.result || recordApplyItemFailed(item);
          if (failed) failedCount += 1;
          else appliedCount += 1;
          return [key, { item, failed }];
        }));
        setRecordPreviewByKey((current) => {
          const next = { ...current };
          for (const [key, { item, failed }] of applyUpdates.entries()) {
            next[key] = {
              ...next[key],
              status: failed ? "error" : "applied",
              result: failed ? (next[key]?.result || null) : item.result,
              error: failed ? (item?.result?.error || item?.result?.firstError || item?.error || "后端未返回本行生效结果") : "",
              errorStage: failed ? "apply" : "",
            };
          }
          return next;
        });
      } catch (err) {
        const message = err?.message || String(err);
        const failedStatus = err?.status === 410 ? "expired" : "error";
        failedCount += recordKeys.length;
        setRecordPreviewByKey((current) => {
          const next = { ...current };
          for (const key of recordKeys) next[key] = { ...next[key], status: failedStatus, error: message, errorStage: "apply" };
          return next;
        });
      }
    }
    if (appliedCount) await loadAll({ quiet: true });
    showToast(`预演方案已处理：生效 ${appliedCount} 条，失败 ${failedCount} 条`, failedCount === 0);
  }

  function openDeleteRecordsDialog(rows = []) {
    if (!canEdit) {
      showToast("删除映射记录需要管理员登录", false);
      return;
    }
    const targets = uniqueRecordRows(rows);
    if (!targets.length) {
      showToast("请先选择要删除的映射记录", false);
      return;
    }
    if (targets.some((row) => !String(row.sourceWorkItemId || "").trim())) {
      showToast("存在缺少飞书 Source ID 的记录，无法安全删除", false);
      return;
    }
    setDeleteRecordsDialog({
      open: true,
      deleting: false,
      records: targets.map(recordIdentityTuple),
      recordKeys: targets.map(recordKey),
      error: "",
    });
  }

  async function confirmDeleteRecords() {
    if (!canEdit) {
      showToast("删除映射记录需要管理员登录", false);
      return;
    }
    const requestedKeys = deleteRecordsDialog.recordKeys || [];
    if (!requestedKeys.length) return;
    setDeleteRecordsDialog((current) => ({ ...current, deleting: true, error: "" }));
    try {
      const data = await api("/records/delete", {
        method: "POST",
        body: { confirm: true, records: deleteRecordsDialog.records || [] },
        auth: true,
        timeoutMs: 30000,
      });
      const deletedKeys = Array.isArray(data?.deletedKeys) ? data.deletedKeys.map(String) : [];
      const deletedKeySet = new Set(deletedKeys);
      setRecords((current) => current.filter((row) => !deletedKeySet.has(recordKey(row))));
      setSelectedRecordKeys((current) => Object.fromEntries(Object.keys(current || {}).filter((key) => !deletedKeySet.has(key)).map((key) => [key, true])));
      setRecordPreviewByKey((current) => Object.fromEntries(Object.entries(current || {}).filter(([key]) => !deletedKeySet.has(key))));
      setDeleteRecordsDialog({ open: false, deleting: false, records: [], recordKeys: [], error: "" });
      showToast(`已删除 ${deletedKeys.length} 条映射关系；不会删除飞书工单或 TB 任务`);
      loadAll({ quiet: true });
    } catch (err) {
      const message = err?.message || String(err);
      setDeleteRecordsDialog((current) => ({ ...current, deleting: false, error: message }));
      showToast(`删除映射记录失败：${message}`, false);
    }
  }

  function latestRealSyncResult() {
    const candidates = [
      quickRunResult?.data,
      quickRunResult?.run?.result,
      preview,
    ];
    for (const data of candidates) {
      const stats = getSyncResultStats(data);
      if (!stats.results.length || stats.dryRun || data?.ok === false) continue;
      return data;
    }
    return null;
  }

  async function runStandaloneDuplicateCheck() {
    if (!canEdit) {
      showToast("检测重复 TB 单需要管理员登录", false);
      return;
    }
    try {
      await persistConfig({ quiet: true });
      const ok = await checkDuplicatesBeforeRun({ ...quickRunBody(), stopOnFirstError: true }, { openDialog: false });
      if (ok) showToast("未发现重复 TB 单");
    } catch (err) {
      showToast(`检测重复 TB 单失败：${err.message}`, false);
    }
  }

  function selectDuplicateTarget(group, taskId) {
    const key = duplicateGroupKey(group);
    setDuplicateMerge((prev) => ({
      ...prev,
      selectedBySourceId: { ...(prev.selectedBySourceId || {}), [key]: taskId },
    }));
  }

  function setDuplicateDeleteAfterMerge(checked) {
    setDuplicateMerge((prev) => ({ ...prev, deleteAfterMerge: checked }));
  }

  function clearDuplicateResult() {
    setDuplicateMerge((prev) => ({
      ...prev,
      open: false,
      checking: false,
      merging: false,
      groups: [],
      selectedBySourceId: {},
      deleteAfterMerge: false,
      error: "",
      result: null,
    }));
  }

  async function runStandaloneSheetUpdate() {
    if (!canEdit) {
      showToast("更新任务表格需要管理员登录", false);
      return;
    }
    const syncResult = latestRealSyncResult();
    if (!syncResult) {
      showToast("没有可用于更新任务表格的真实同步结果，请先执行开始同步", false);
      return;
    }
    const plan = await prepareSheetUpdate(syncResult, { quiet: true });
    if (!plan) return;
    if (plan.updateCount) showToast(`任务表格待追加清单已生成：${plan.updateCount} 条，请在下方确认写入`);
    else showToast("任务表格没有需要追加的行");
  }

  async function prepareSheetUpdate(syncResult, { quiet = false, suppressErrorToast = false, runId = "" } = {}) {
    retrySheetApplyAfterFeishuLoginRef.current = false;
    retrySheetPreviewAfterFeishuLoginRef.current = null;
    const sourceRunId = String(runId || syncResult?.__runId || syncResult?.runId || "").trim();
    if ((!syncResult && !sourceRunId) || syncResult?.ok === false) {
      setSheetUpdate({ loading: false, applying: false, pendingLogin: false, plan: null, result: null, error: "" });
      return null;
    }
    setSheetUpdate({ loading: true, applying: false, pendingLogin: false, plan: null, result: null, error: "" });
    try {
      const previewBody = sourceRunId
        ? { runId: sourceRunId, readSheet: true, config }
        : { syncResult, readSheet: true, config };
      const plan = await api("/sheet/preview", {
        method: "POST",
        body: previewBody,
        auth: true,
        timeoutMs: 90000,
      });
      setSheetUpdate({ loading: false, applying: false, pendingLogin: false, plan, result: null, error: "" });
      if (!quiet && plan.updateCount) showToast(`已生成 ${plan.updateCount} 条飞书表格待追加项`);
      return plan;
    } catch (err) {
      if (isFeishuSheetLoginError(err)) {
        retrySheetPreviewAfterFeishuLoginRef.current = { syncResult, options: { quiet, suppressErrorToast, runId: sourceRunId } };
        const message = feishuSheetLoginMessage(err);
        setSheetUpdate({ loading: false, applying: false, pendingLogin: true, plan: null, result: null, error: message });
        if (!suppressErrorToast) showToast("需要切换飞书用户，完成后会自动重新生成任务表格追加清单", false);
        try {
          await startFeishuWebLogin({
            url: taskSheetUrl(config || {}) || sourceViewUrl(config || {}),
            quietToast: true,
          });
        } catch {}
        return null;
      }
      setSheetUpdate({ loading: false, applying: false, pendingLogin: false, plan: null, result: null, error: err.message || String(err) });
      if (suppressErrorToast) return null;
      showToast(`生成飞书表格追加预览失败：${err.message}`, false);
      return null;
    }
  }

  function clearSheetUpdate() {
    retrySheetApplyAfterFeishuLoginRef.current = false;
    retrySheetPreviewAfterFeishuLoginRef.current = null;
    sheetUpdatePlanRef.current = null;
    setSheetUpdate({ loading: false, applying: false, pendingLogin: false, plan: null, result: null, error: "" });
  }

  async function applySheetUpdate({ retryAfterLogin = false } = {}) {
    const plan = sheetUpdatePlanRef.current || sheetUpdate.plan;
    if (!plan || !plan.updateCount) return;
    setSheetUpdate((prev) => ({ ...prev, applying: true, pendingLogin: false, error: "", result: null }));
    try {
      const result = await api("/sheet/apply", {
        method: "POST",
        body: { plan, timeoutMs: 120000 },
        auth: true,
        timeoutMs: 120000,
      });
      retrySheetApplyAfterFeishuLoginRef.current = false;
      setSheetUpdate((prev) => ({ ...prev, applying: false, pendingLogin: false, result, error: "" }));
      showToast(`飞书表格已追加 ${result.applied || 0} 条记录`, result.ok !== false);
    } catch (err) {
      if (isFeishuSheetLoginError(err)) {
        retrySheetApplyAfterFeishuLoginRef.current = true;
        const message = feishuSheetLoginMessage(err);
        setSheetUpdate((prev) => ({ ...prev, applying: false, pendingLogin: true, error: message, result: null }));
        showToast(retryAfterLogin ? "飞书登录态仍未就绪，请在弹出的窗口完成切换后再试" : "需要切换飞书用户，完成后会自动继续追加任务表格", false);
        try {
          await startFeishuWebLogin({
            url: plan.sheetUrl || taskSheetUrl(config || {}) || sourceViewUrl(config || {}),
            quietToast: true,
          });
        } catch {}
        return;
      }
      setSheetUpdate((prev) => ({ ...prev, applying: false, pendingLogin: false, error: err.message || String(err) }));
      showToast(`追加飞书表格失败：${err.message}`, false);
    }
  }

  async function runQuickSync() {
    if (!canEdit) {
      showToast("/run 需要管理员登录", false);
      return;
    }
    setSyncViewPending(true);
    resetQuickRunEvents([]);
    setQuickRunBusy("run");
    setQuickRunResult({ mode: "run", status: "running", startedAt: new Date().toISOString() });
    let body = null;
    try {
      await persistConfig({ quiet: true });
      body = { ...quickRunBody(), stopOnFirstError: true };
      const mappingReady = await checkSheetMappingsBeforeRun(body);
      if (!mappingReady) {
        setQuickRunResult(null);
        releaseSyncResultView();
        return;
      }
      const canContinue = await checkDuplicatesBeforeRun(body);
      if (!canContinue) {
        setQuickRunResult(null);
        releaseSyncResultView();
        return;
      }
      const started = await api("/run", { method: "POST", body: { ...body, async: true }, auth: true });
      resetQuickRunEvents(started.events || []);
      setQuickRunResult({ mode: "run", status: "running", runId: started.id, run: compactRunSnapshot(started), data: runDisplayData(started), startedAt: started.startedAt || new Date().toISOString() });
      const done = await observeQuickRun(started.id);
      const { resultData: data, previewData } = await loadCompletedRunData(started.id, done, body?.source);
      setQuickRunResult({
        mode: "run",
        status: data?.ok === false ? "failed" : "done",
        runId: started.id,
        run: compactRunSnapshot(done),
        data,
        error: data?.ok === false ? (data?.firstError || done?.error || "") : "",
        startedAt: started.startedAt || new Date().toISOString(),
        finishedAt: done?.finishedAt || new Date().toISOString(),
      });
      setPreview(previewData);
      setActiveTab("preview");
      showToast(`一键同步${data?.ok === false ? "已停止" : "已完成"}：${formatSyncResultSummary(data)}`, data?.ok !== false);
      prepareSheetUpdate(data, { quiet: true, suppressErrorToast: true, runId: started.id }).catch(() => null);
      loadAll({ quiet: true }).finally(() => holdSyncResultView());
    } catch (err) {
      const message = err?.message || String(err);
      const data = isFeishuWebSource(body?.source) ? feishuWebFailureResult(message, err, { dryRun: false }) : null;
      setQuickRunResult({ mode: "run", status: "failed", error: message, ...(data ? { data } : {}), finishedAt: new Date().toISOString() });
      if (data) {
        setPreview(data);
        setActiveTab("preview");
      }
      releaseSyncResultView();
      showToast(`一键同步失败：${message}`, false);
    } finally {
      quickRunPollRef.current = "";
      setQuickRunBusy("");
    }
  }

  async function refreshFeishuWorkItems() {
    if (!canEdit) {
      showToast("更新飞书工单需要管理员登录", false);
      return;
    }
    setQuickRunBusy("refresh-records");
    setRecordsRefreshResult(createFeishuRecordsRefreshResult({ status: "running" }));
    try {
      await persistConfig({ quiet: true });
      const data = await api("/records/refresh", {
        method: "POST",
        body: { ...quickRunBody(), limit: 200, reconcileSnapshot: true },
        auth: true,
        timeoutMs: 300000,
      });
      const sourceError = Array.isArray(data?.sourceResults)
        ? data.sourceResults.filter((row) => row && row.ok === false).map((row) => `${row.name || row.id || row.url || "来源"}：${row.error || "读取失败"}`).join("；")
        : "";
      const sourceWarning = Array.isArray(data?.sourceResults)
        ? Array.from(new Set(data.sourceResults.filter((row) => row?.warning).map((row) => row.warning))).join("；")
        : "";
      const failureMessage = data?.firstError || data?.error || sourceError || "部分飞书工单来源读取失败";
      if (data?.partial === true || data?.ok === false) {
        const terminalResult = createFeishuRecordsRefreshResult({
          status: feishuRecordsRefreshStatus(data, "failed"),
          data,
          error: failureMessage,
          finishedAt: new Date().toISOString(),
        });
        setRecordsRefreshResult(terminalResult);
        const refreshLogText = data?.refreshLogId ? `（日志 ID：${data.refreshLogId}）` : "";
        if ((data.refreshed || 0) > 0) {
          showToast(`更新飞书工单部分成功：写入 ${data.refreshed} 条；失败：${failureMessage}${refreshLogText}`, false);
          loadAll({ quiet: true });
          return;
        }
        const error = new Error(failureMessage);
        error.data = data;
        error.refreshLogId = data?.refreshLogId || "";
        error.recordsRefreshResult = terminalResult;
        throw error;
      }
      setRecordsRefreshResult(createFeishuRecordsRefreshResult({
        status: "success",
        data,
        finishedAt: new Date().toISOString(),
      }));
      const cleanupText = data.snapshotReconciled
        ? `，删除未同步 ${data.removedUnsynced || 0} 条，隐藏已同步 ${data.hiddenSynced || 0} 条`
        : "，结果达到读取上限或不是完整快照，未执行历史清理";
      const warningText = sourceWarning ? `；提示：${sourceWarning}` : "";
      const refreshLogText = data?.refreshLogId ? `（日志 ID：${data.refreshLogId}）` : "";
      showToast(`飞书工单已更新：写入 ${data.refreshed || 0} 条，跳过 ${data.skippedCount || 0} 条${cleanupText}${warningText}${refreshLogText}`);
      loadAll({ quiet: true });
    } catch (err) {
      const refreshLogId = feishuRecordsRefreshLogId(err, err?.data);
      const terminalResult = err?.recordsRefreshResult || createFeishuRecordsRefreshResult({
        status: feishuRecordsRefreshStatus(err?.data, "failed"),
        data: err?.data,
        error: err?.message,
        refreshLogId,
        finishedAt: new Date().toISOString(),
      });
      setRecordsRefreshResult(terminalResult);
      const prefix = terminalResult.status === "partial" ? "更新飞书工单部分失败" : "更新飞书工单失败";
      showToast(`${prefix}：${err.message}${refreshLogId ? `（日志 ID：${refreshLogId}）` : ""}`, false);
    } finally {
      setQuickRunBusy("");
    }
  }

  async function runDryRun(source = "ids") {
    if (!canEdit) {
      showToast("dry-run 需要管理员登录", false);
      return;
    }
    setPreviewBusy(true);
    try {
      const nos = parseList(workItemIds);
      const base = quickRunBody({ preferMcpForProblemNos: source !== "poc" && nos.length > 0 });
      const body = source === "poc"
        ? { ...base, limit: Number(getPath(config, "sync.batchSize", 10)) || 10 }
        : { ...base, workItemNos: nos, limit: nos.length || 10 };
      const data = await api("/dry-run", { method: "POST", body, auth: true });
      setPreview(data);
      setActiveTab("preview");
      showToast("dry-run 已完成");
    } catch (err) {
      showToast(`dry-run 失败：${err.message}`, false);
    } finally {
      setPreviewBusy(false);
    }
  }

  async function previewSampleJson() {
    if (!canEdit) {
      showToast("Payload 预览需要管理员登录", false);
      return;
    }
    setPreviewBusy(true);
    try {
      const parsed = JSON.parse(sampleJson);
      const data = await api("/mapping-preview", {
        method: "POST",
        body: Array.isArray(parsed) ? { workItems: parsed, config } : { workItem: parsed, config },
        auth: true,
      });
      setPreview(data);
      setActiveTab("preview");
      showToast("样例 payload 已生成");
    } catch (err) {
      showToast(`预览失败：${err.message}`, false);
    } finally {
      setPreviewBusy(false);
    }
  }

  async function previewSyncPolicy(workItem, action = "update") {
    if (!canEdit) throw new Error("规则命中预览需要管理员登录");
    return api("/policy-preview", {
      method: "POST",
      body: { workItem, action, config },
      auth: true,
      timeoutMs: 15000,
    });
  }

  async function runRealSync() {
    if (!canEdit) {
      showToast("/run 需要管理员登录", false);
      return;
    }
    setPreviewBusy(true);
    try {
      const nos = parseList(workItemIds);
      const body = { ...quickRunBody(), workItemNos: nos, limit: nos.length || Number(getPath(config, "sync.batchSize", 10)) || 10 };
      if (!await checkSheetMappingsBeforeRun(body)) return;
      if (!await checkDuplicatesBeforeRun(body)) return;
      const data = await runAsyncSyncJob(body);
      setPreview(data);
      setActiveTab("preview");
      showToast("真实同步已提交");
      loadAll({ quiet: true });
    } catch (err) {
      showToast(`真实同步失败：${err.message}`, false);
    } finally {
      setPreviewBusy(false);
    }
  }

  async function startTbLogin() {
    try {
      const result = await startTbTasksLogin();
      if (!result.success) {
        showToast(`打开 TB 扫码登录失败：${result.error || "未知错误"}`, false);
        return;
      }
      setTbLogin((prev) => ({ ...prev, checked: true, refreshing: true, reason: result.mode === "remote" ? "正在等待远程扫码页面完成" : "正在等待 TB 登录窗口完成" }));
      showToast(result.mode === "remote" ? "已打开远程 TB 扫码页面" : (tbLogin.valid ? "已打开 TB 登录态刷新窗口" : "已打开 TB 扫码登录窗口"));
      pollTbLoginStatus();
    } catch (err) {
      showToast(`打开 TB 扫码登录失败：${err.message}`, false);
    }
  }

  async function startFeishuWebLogin(options = {}) {
    const opts = options && !options.nativeEvent ? options : {};
    if (!canEdit) {
      showToast("启动飞书网页登录需要先登录管理后台", false);
      return;
    }
    try {
      const data = await api("/web-login", {
        method: "POST",
        body: { url: opts.url || sourceViewUrl(config || {}) },
        auth: true,
      });
      if (data?.mode === "remote" && data?.viewerUrl) {
        openRemoteBrowserViewer(data.viewerUrl, "feishu-server-browser");
        if (!opts.quietToast) showToast("已打开远程飞书扫码页面，请在弹出窗口中登录");
      } else if (!opts.quietToast) {
        showToast("已打开飞书项目网页登录窗口");
      }
      setFeishuWeb((prev) => ({ ...prev, checked: true, refreshing: true, passive: false, skippedBrowserLaunch: false, reason: "正在等待飞书网页登录完成" }));
      pollFeishuWebStatus();
    } catch (err) {
      if (!opts.quietToast) showToast(`打开飞书网页登录失败：${err.message}`, false);
      throw err;
    }
  }

  async function fetchMcpTokenFromWeb() {
    if (!canEdit) {
      showToast("获取 MCP Token 需要管理员登录", false);
      return;
    }
    try {
      const data = await api("/mcp-token-from-web", {
        method: "POST",
        body: {},
        auth: true,
      });
      if (data?.mode === "remote" && (data?.pending || data?.viewerUrl)) {
        openRemoteBrowserViewer(data.viewerUrl || "/feishu-browser", "feishu-server-browser");
        showToast("已打开远程飞书登录页，请扫码后等待 MCP Token 自动写入");
        setTimeout(() => loadAll(), 4000);
        setTimeout(() => loadAll(), 12000);
        return;
      }
      showToast(data?.mcpStatus?.connected ? "MCP Token 已写入，连接可用" : "MCP Token 已写入，请刷新状态");
      await loadAll();
    } catch (err) {
      if (err?.data?.mode === "remote" && err?.data?.viewerUrl) {
        openRemoteBrowserViewer(err.data.viewerUrl, "feishu-server-browser");
        showToast("已打开远程飞书登录页，请扫码授权后重试获取 Token");
        return;
      }
      showToast(`获取 MCP Token 失败：${err.message}`, false);
    }
  }

  async function openMcpAuthorizationFromDesktop() {
    if (!canEdit) {
      showToast("MCP 授权需要管理员登录", false);
      return;
    }
    try {
      const data = await api("/mcp-open-authorization", {
        method: "POST",
        body: { url: feishuMcp?.authorizationUrl || "" },
        auth: true,
      });
      if (data?.mode === "remote" && data?.viewerUrl) {
        openRemoteBrowserViewer(data.viewerUrl, "feishu-server-browser");
        showToast("已打开远程飞书授权页，请在弹出窗口中扫码完成授权");
      } else {
        showToast("已打开飞书授权页，请用已登录飞书桌面端或系统浏览器完成授权");
      }
      setFeishuMcp((prev) => ({ ...prev, checked: true, refreshing: true, authorizationUrl: data?.url || prev.authorizationUrl || "" }));
      setTimeout(() => loadFeishuMcpStatus({ refreshing: true }), 3000);
      setTimeout(() => loadAll(), 10000);
    } catch (err) {
      showToast(`打开飞书 MCP 授权失败：${err.message}`, false);
    }
  }

  async function runWebCaptureDryRun() {
    if (!canEdit) {
      showToast("网页态 dry-run 需要管理员登录", false);
      return;
    }
    setPreviewBusy(true);
    try {
      const data = await api("/dry-run", {
        method: "POST",
        body: {
          source: "web",
          url: sourceViewUrl(config || {}),
          limit: Number(getPath(config, "sync.batchSize", 10)) || 10,
          scope: feishuReadScopeFromConfig(config || {}),
          sourceView: normalizeFeishuSourceViewForUi(config || {}),
          sourceViews: sourceViewsForRequest(config || {}),
          sort: syncSortForUi(config || {}),
          requiredAssigneeKeywords: ownerFilterValues(config || {}),
        },
        auth: true,
      });
      setPreview(data);
      setActiveTab("preview");
      showToast("飞书网页态 dry-run 已完成");
    } catch (err) {
      const message = err?.message || String(err);
      setPreview({
        ok: false,
        dryRun: true,
        source: "feishu-web",
        needLogin: !!err?.needLogin,
        total: 0,
        requested: 0,
        failed: 1,
        firstError: message,
        error: message,
        captured: err?.data || undefined,
        results: [],
      });
      setActiveTab("preview");
      showToast(`飞书网页态 dry-run 失败：${message}`, false);
    } finally {
      setPreviewBusy(false);
    }
  }

  async function runWebCaptureSync() {
    if (!canEdit) {
      showToast("网页态 /run 需要管理员登录", false);
      return;
    }
    setPreviewBusy(true);
    try {
      const body = {
        source: "web",
        url: sourceViewUrl(config || {}),
        limit: Number(getPath(config, "sync.batchSize", 10)) || 10,
        scope: feishuReadScopeFromConfig(config || {}),
        sourceView: normalizeFeishuSourceViewForUi(config || {}),
        sourceViews: sourceViewsForRequest(config || {}),
        sort: syncSortForUi(config || {}),
        requiredAssigneeKeywords: ownerFilterValues(config || {}),
      };
      if (!await checkSheetMappingsBeforeRun(body)) return;
      if (!await checkDuplicatesBeforeRun(body)) return;
      const data = await runAsyncSyncJob(body);
      setPreview(data);
      setActiveTab("preview");
      showToast("飞书网页态真实同步已提交");
      loadAll({ quiet: true });
    } catch (err) {
      const message = err?.message || String(err);
      const data = feishuWebFailureResult(message, err, { dryRun: false });
      setPreview(data);
      setActiveTab("preview");
      showToast(`飞书网页态真实同步失败：${message}`, false);
    } finally {
      setPreviewBusy(false);
    }
  }

  async function runMcpDryRun() {
    if (!canEdit) {
      showToast("MCP dry-run 需要管理员登录", false);
      return;
    }
    setPreviewBusy(true);
    try {
      const nos = parseList(workItemIds);
      const data = await api("/dry-run", {
        method: "POST",
        body: {
          source: "mcp",
          workItemNos: nos,
          limit: nos.length || Number(getPath(config, "sync.batchSize", 10)) || 10,
          scope: feishuReadScopeFromConfig(config || {}),
          sourceView: normalizeFeishuSourceViewForUi(config || {}),
          sourceViews: sourceViewsForRequest(config || {}),
          sort: syncSortForUi(config || {}),
          requiredAssigneeKeywords: ownerFilterValues(config || {}),
        },
        auth: true,
      });
      setPreview(data);
      setActiveTab("preview");
      showToast("飞书 MCP dry-run 已完成");
      loadFeishuMcpStatus();
    } catch (err) {
      showToast(`飞书 MCP dry-run 失败：${err.message}`, false);
    } finally {
      setPreviewBusy(false);
    }
  }

  async function runMcpSync() {
    if (!canEdit) {
      showToast("MCP /run 需要管理员登录", false);
      return;
    }
    setPreviewBusy(true);
    try {
      const nos = parseList(workItemIds);
      const body = {
        source: "mcp",
        workItemNos: nos,
        limit: nos.length || Number(getPath(config, "sync.batchSize", 10)) || 10,
        scope: feishuReadScopeFromConfig(config || {}),
        sourceView: normalizeFeishuSourceViewForUi(config || {}),
        sourceViews: sourceViewsForRequest(config || {}),
        sort: syncSortForUi(config || {}),
        requiredAssigneeKeywords: ownerFilterValues(config || {}),
      };
      if (!await checkSheetMappingsBeforeRun(body)) return;
      if (!await checkDuplicatesBeforeRun(body)) return;
      const data = await runAsyncSyncJob(body);
      setPreview(data);
      setActiveTab("preview");
      showToast("飞书 MCP 真实同步已提交");
      loadAll({ quiet: true });
    } catch (err) {
      showToast(`飞书 MCP 真实同步失败：${err.message}`, false);
    } finally {
      setPreviewBusy(false);
    }
  }

  const quickRunFinalVisible = !!quickRunResult
    && (quickRunResult.status === "done" || quickRunResult.status === "failed")
    && !!(quickRunResult.data || quickRunResult.error || quickRunResult.run);
  const recordActionBusy = Object.values(recordPreviewByKey).some((state) => ["loading", "applying"].includes(state?.status));
  const syncFlowPending = !!quickRunBusy || recordActionBusy || syncViewPending || quickRunResult?.status === "running" || quickRunResult?.status === "settling";
  const syncResultContextVisible = syncFlowPending
    || quickRunFinalVisible
    || !!quickRunResult
    || !!recordsRefreshResult
    || !!previewBusy
    || !!sheetUpdate.loading
    || !!sheetUpdate.applying
    || !!sheetMappingMerge.checking
    || !!sheetMappingMerge.applying;
  const activeAuthMode = getPath(config, "feishu.authMode", readiness?.authMode || "plugin");
  const syncPreflightChecking = !!config && !syncResultContextVisible && (
    (activeAuthMode === "mcp" && !feishuMcp?.checked)
    || (activeAuthMode === "web" && !feishuWeb?.checked)
  );
  const syncIssues = !syncResultContextVisible ? syncConfigIssues({ config, readiness, canEdit, feishuWeb, feishuMcp, adminError }) : [];

  function refreshPage() {
    void loadAll();
    if (activeTab === "errors") void loadErrors({ force: true });
  }

  return (
    <div className="h-full overflow-y-auto bg-zinc-950 text-zinc-200" data-testid="feishu-page-ready">
      {toast && (
        <div className={`fixed right-4 top-4 z-50 rounded border px-3 py-2 text-xs shadow-xl ${toast.ok ? "border-emerald-600/40 bg-emerald-950 text-emerald-200" : "border-red-600/40 bg-red-950 text-red-200"}`}>
          {toast.message}
        </div>
      )}
      {duplicateMerge.open && (
        <DuplicateMergeDialog
          state={duplicateMerge}
          onSelect={selectDuplicateTarget}
          onDeleteAfterMergeChange={setDuplicateDeleteAfterMerge}
          onCancel={() => setDuplicateMerge((prev) => ({ ...prev, open: false }))}
          onConfirm={confirmDuplicateMerge}
        />
      )}
      {sheetMappingMerge.open && (
        <SheetMappingConflictDialog
          state={sheetMappingMerge}
          onSelect={selectSheetMappingTarget}
          onCancel={() => setSheetMappingMerge((prev) => ({ ...prev, open: false }))}
          onConfirm={confirmSheetMappingMerge}
        />
      )}
      {clearRecordsDialog.open && (
        <ClearRecordsDialog
          state={clearRecordsDialog}
          recordCount={records.length}
          onCancel={() => setClearRecordsDialog((prev) => (prev.clearing ? prev : { ...prev, open: false }))}
          onConfirm={confirmClearRecords}
        />
      )}
      {deleteRecordsDialog.open && (
        <DeleteRecordsDialog
          state={deleteRecordsDialog}
          onCancel={() => setDeleteRecordsDialog((current) => (current.deleting ? current : {
            open: false,
            deleting: false,
            records: [],
            recordKeys: [],
            error: "",
          }))}
          onConfirm={confirmDeleteRecords}
        />
      )}

      <div className="mx-auto max-w-7xl p-5 space-y-4">
        <div className="flex flex-wrap items-center gap-3 border-b border-zinc-800 pb-4">
          <div>
            <h1 className="text-lg font-semibold text-zinc-100">飞书工单 / TB 任务同步</h1>
            <div className="mt-1 flex flex-wrap items-center gap-2 text-[11px] text-zinc-500">
              <span>同步关系 {stats.total}</span>
              <span>成功 {stats.success}</span>
              <span>失败 {stats.failed}</span>
              <span>可重试 {errorsLoaded ? stats.retryable : "按需加载"}</span>
            </div>
          </div>
          <div className="ml-auto flex flex-wrap items-center gap-2">
            {readinessItems(readiness, config, feishuWeb, feishuMcp, configLoading).map((item) => (
              <span key={item.key} className={`rounded border px-2 py-1 text-[11px] ${item.ok ? "border-emerald-700/50 bg-emerald-900/20 text-emerald-300" : "border-amber-700/50 bg-amber-900/20 text-amber-300"}`}>
                {item.label}
              </span>
            ))}
            <button onClick={refreshPage} className="rounded border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-xs text-zinc-300 hover:bg-zinc-800">刷新</button>
            <button onClick={saveConfig} disabled={!canEdit || !config || saving} className="rounded bg-blue-600 px-3 py-1.5 text-xs text-white hover:bg-blue-500 disabled:bg-zinc-700 disabled:text-zinc-500">
              {saving ? "保存中" : "保存规则"}
            </button>
          </div>
        </div>

        {adminError && (
          <div className="rounded border border-amber-700/40 bg-amber-950/30 px-3 py-2 text-xs text-amber-200">
            {adminError} <Link to="/admin" className="ml-2 text-blue-300 hover:text-blue-200">打开管理后台</Link>
          </div>
        )}

        <div className="flex flex-wrap gap-1 rounded bg-zinc-900 p-1">
          {TABS.map((tab) => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`rounded px-3 py-1.5 text-xs transition ${activeTab === tab.id ? "bg-zinc-700 text-zinc-100" : "text-zinc-500 hover:bg-zinc-800 hover:text-zinc-300"}`}
            >
              {tab.label}
            </button>
          ))}
        </div>

        {(configLoading || recordsLoading || (activeTab === "sync" && syncPreflightChecking)) && (
          <div className="rounded border border-sky-800/40 bg-sky-950/20 px-3 py-2 text-xs text-sky-200">
            页面已可操作；{[
              configLoading ? "同步配置正在后台加载" : "",
              recordsLoading ? "同步关系正在后台加载" : "",
              activeTab === "sync" && syncPreflightChecking ? `${modeLabel(activeAuthMode)} 状态正在后台检测` : "",
            ].filter(Boolean).join("，")}。
          </div>
        )}
        {recordsError && (
          <div className="rounded border border-amber-800/40 bg-amber-950/20 px-3 py-2 text-xs text-amber-200">
            同步关系暂未加载：{recordsError}
          </div>
        )}
        {activeTab === "sync" && (
          <div className="space-y-4">
            {config && !syncResultContextVisible && (
              <SyncConfigAlert
                issues={syncIssues}
                onOpenConfig={() => setActiveTab("config")}
              />
            )}
            {config && (
              <QuickSyncPanel
                config={config}
                readiness={readiness}
                canEdit={canEdit}
                saving={saving}
                quickRunBusy={quickRunBusy || (recordActionBusy ? "record-action" : "")}
                quickRunResult={quickRunResult}
                recordsRefreshResult={recordsRefreshResult}
                quickRunEvents={quickRunEvents}
                feishuWeb={feishuWeb}
                feishuMcp={feishuMcp}
                tbMembers={tbMembers}
                onSave={saveConfig}
                onAuthModeChange={(mode) => setCfg("feishu.authMode", mode)}
                onFeishuWebLogin={startFeishuWebLogin}
                onDryRun={runQuickDryRun}
                onRun={runQuickSync}
                onRefreshRecords={refreshFeishuWorkItems}
                duplicateMerge={duplicateMerge}
                sheetMappingMerge={sheetMappingMerge}
                sheetUpdate={sheetUpdate}
                onCheckDuplicates={runStandaloneDuplicateCheck}
                onDuplicateSelect={selectDuplicateTarget}
                onDuplicateDeleteAfterMergeChange={setDuplicateDeleteAfterMerge}
                onDuplicateConfirm={confirmDuplicateMerge}
                onDuplicateClear={clearDuplicateResult}
                onUpdateSheet={runStandaloneSheetUpdate}
                onOpenRules={() => setActiveTab("config")}
                onOpenPreview={() => setActiveTab("preview")}
              />
            )}
            <SheetUpdatePanel
              state={sheetUpdate}
              onApply={applySheetUpdate}
              onClear={clearSheetUpdate}
            />
            <RecordsPanel
              records={records}
              config={config}
              canEdit={canEdit}
              clearBusy={clearRecordsDialog.clearing}
              deleteBusy={deleteRecordsDialog.deleting}
              globalSyncBusy={!!quickRunBusy || previewBusy || syncViewPending || quickRunResult?.status === "running" || quickRunResult?.status === "settling"}
              selectedRecordKeys={selectedRecordKeys}
              recordPreviewByKey={recordPreviewByKey}
              tbMembers={tbMembers}
              tbTasklists={tbTasklists}
              tbSprints={tbSprints}
              onClearAll={openClearRecordsDialog}
              onToggleRecord={toggleRecordSelection}
              onTogglePage={toggleRecordPageSelection}
              onClearSelection={clearRecordSelection}
              onPreviewRecords={previewRecordSync}
              onApplyPreviews={applyRecordPreviews}
              onDismissPreview={dismissRecordPreview}
              onDeleteRecords={openDeleteRecordsDialog}
            />
          </div>
        )}
        {activeTab === "config" && config && (
          <div className="space-y-5">
            <OverviewPanel config={config} readiness={readiness} records={records} retryable={retryable} tbMembers={tbMembers} tbTasklists={tbTasklists} tbSprints={tbSprints} />
            <MissingAndLoginPanel
              readiness={readiness}
              canEdit={canEdit}
              config={config}
              tbLogin={tbLogin}
              tbProjects={tbProjects}
              feishuWeb={feishuWeb}
              feishuMcp={feishuMcp}
              onTbLogin={startTbLogin}
              onOpenTbProjectPicker={openTbProjectPicker}
              onLoadTbProjects={loadTbProjects}
              onSelectTbProject={selectTbProject}
              onFeishuWebLogin={startFeishuWebLogin}
              onMcpTokenFromWeb={fetchMcpTokenFromWeb}
              onMcpDesktopAuthorize={openMcpAuthorizationFromDesktop}
              onOpenRules={() => setActiveTab("config")}
            />
            <ConfigSectionHeading
              title="常用配置"
              description="保留日常同步最常改的范围、排序、目标迭代、固定参与者和附件策略，修改后点击顶部保存。"
            />
            <QuickSyncSettingsCards
              config={config}
              canEdit={canEdit}
              setCfg={setCfg}
              onAttachmentModeChange={saveAttachmentMode}
              readiness={readiness}
              feishuWeb={feishuWeb}
              feishuMcp={feishuMcp}
              onFeishuWebLogin={startFeishuWebLogin}
              tbSprints={tbSprints}
              tbMembers={tbMembers}
              feishuFilterMeta={feishuFilterMeta}
              onLoadFeishuFilterMetadata={loadFeishuFilterMetadata}
              onLoadTbSprints={loadTbSprints}
              onSelectTbSprint={selectTbSprint}
              onTbMemberQueryChange={(query) => setTbMembers((prev) => ({ ...prev, query }))}
              onLoadTbMembers={loadTbMembers}
              onSelectTbMember={selectRequiredTbMember}
              onRemoveTbMember={removeRequiredTbMember}
              feishuFilterPreset={feishuFilterPreset}
              feishuFilterConfigBusy={feishuFilterConfigBusy}
              onSetFeishuFilterPreset={setCurrentFiltersAsPreset}
              onBackupFeishuFilters={backupCurrentFilters}
              onRestoreFeishuFilters={restoreFiltersFromBackup}
            />
            <FeishuSyncPolicyPanel
              config={config}
              setCfg={setCfg}
              readOnly={!canEdit}
              tbProjects={tbProjects}
              tbTasklists={tbTasklists}
              tbSprints={tbSprints}
              onLoadTbProjects={loadTbProjects}
              onLoadTbTasklists={loadTbTasklists}
              onLoadTbSprints={loadTbSprints}
              onPreview={previewSyncPolicy}
            />
            <AdvancedConfigGroup>
              <RulesPanel
                config={config}
                setCfg={setCfg}
                readOnly={!canEdit}
                tbProjects={tbProjects}
                tbTasklists={tbTasklists}
                onLoadTbProjects={loadTbProjects}
                onSelectTbProject={selectTbProject}
                onLoadTbTasklists={loadTbTasklists}
                onSelectTbTasklist={selectTbTasklist}
              />
              <FieldsPanel config={config} setCfg={setCfg} readOnly={!canEdit} tbMembers={tbMembers} />
              <KeywordPanel
                config={config}
                setCfg={setCfg}
                readOnly={!canEdit}
                tbSprints={tbSprints}
                onLoadTbSprints={loadTbSprints}
              />
            </AdvancedConfigGroup>
          </div>
        )}
        {activeTab === "errors" && (
          <ErrorsPanel
            errors={errors}
            retryable={retryable}
            rawPayloads={rawPayloads}
            loading={errorsLoading}
            loaded={errorsLoaded}
            error={errorsError}
            onRetry={() => loadErrors({ force: true })}
          />
        )}
        {activeTab === "preview" && config && (
          <PreviewPanel
            config={config}
            workItemIds={workItemIds}
            setWorkItemIds={setWorkItemIds}
            sampleJson={sampleJson}
            setSampleJson={setSampleJson}
            preview={preview}
            previewBusy={previewBusy}
            quickRunResult={quickRunResult}
            quickRunEvents={quickRunEvents}
            onDryRun={() => runDryRun("ids")}
            onPocDryRun={() => runDryRun("poc")}
            onPreviewJson={previewSampleJson}
            onRun={runRealSync}
            onWebDryRun={runWebCaptureDryRun}
            onWebRun={runWebCaptureSync}
            onMcpDryRun={runMcpDryRun}
            onMcpRun={runMcpSync}
            canEdit={canEdit}
            feishuWeb={feishuWeb}
            feishuMcp={feishuMcp}
            tbMembers={tbMembers}
            tbTasklists={tbTasklists}
            tbSprints={tbSprints}
            sheetUpdate={sheetUpdate}
            onApplySheetUpdate={applySheetUpdate}
            onClearSheetUpdate={clearSheetUpdate}
          />
        )}
        {!config && activeTab !== "errors" && (
          <div className="rounded border border-zinc-800 bg-zinc-900/50 px-3 py-8 text-center text-sm text-zinc-500">
            {configLoading ? "同步配置仍在后台加载；错误页签和已加载的同步关系可先查看。" : "同步配置暂不可用，请点击刷新重试。"}
          </div>
        )}
      </div>
    </div>
  );
}

function DuplicateMergeDialog({ state, onSelect, onDeleteAfterMergeChange, onCancel, onConfirm }) {
  const groups = state.groups || [];
  const selectedBySourceId = state.selectedBySourceId || {};
  const missingSelection = groups.some((group) => {
    const key = duplicateDialogGroupKey(group);
    return !selectedBySourceId[key];
  });
  const disabled = state.merging || missingSelection;
  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/70 p-4">
      <div className="flex max-h-[88vh] w-full max-w-5xl flex-col rounded border border-zinc-700 bg-zinc-950 shadow-2xl">
        <div className="flex flex-wrap items-start gap-3 border-b border-zinc-800 px-4 py-3">
          <div>
            <div className="text-sm font-medium text-zinc-100">发现重复 TB 单</div>
            <div className="mt-1 text-xs leading-relaxed text-zinc-500">
              开始同步前检测到同一个飞书 Source ID 对应多个 TB 单。请选择每组以哪个 TB 单为准，确认后会把同步关系合并到目标单。
            </div>
          </div>
          <button
            type="button"
            onClick={onCancel}
            disabled={state.merging}
            className="ml-auto rounded border border-zinc-700 bg-zinc-900 px-2.5 py-1.5 text-xs text-zinc-300 hover:bg-zinc-800 disabled:text-zinc-600"
          >
            关闭
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          {state.error && (
            <div className="mb-3 rounded border border-red-800/60 bg-red-950/30 px-3 py-2 text-xs leading-relaxed text-red-200">
              {state.error}
            </div>
          )}
          <div className="space-y-3">
            {groups.map((group, index) => {
              const key = duplicateDialogGroupKey(group);
              const selected = selectedBySourceId[key] || "";
              return (
                <div key={key || index} className="rounded border border-zinc-800 bg-zinc-900/70 p-3">
                  <div className="flex flex-wrap items-start gap-2">
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-medium text-zinc-100">{group.title || group.targetTitle || "未命名飞书单"}</div>
                      <div className="mt-1 flex flex-wrap gap-2 text-[11px] text-zinc-500">
                        <code className="rounded bg-zinc-950 px-1.5 py-0.5">{group.sourceId || group.sourceWorkItemId || "-"}</code>
                        {(group.sourceProblemNo || group.problemNo || group.sourceWorkItemNo) && <span>问题编号 {group.sourceProblemNo || group.problemNo || group.sourceWorkItemNo}</span>}
                        {group.targetProjectId && <span>Project {group.targetProjectId}</span>}
                        {group.existingTargetTaskId && <span>当前同步关系 {group.existingTargetTaskId}</span>}
                      </div>
                    </div>
                    <span className="rounded bg-amber-500/15 px-2 py-1 text-[11px] text-amber-200">{group.tasks?.length || 0} 个重复单</span>
                  </div>

                  <div className="mt-3 grid gap-2">
                    {(group.tasks || []).map((task) => (
                      <label
                        key={task.id}
                        className={`flex cursor-pointer gap-3 rounded border px-3 py-2 text-xs ${selected === task.id ? "border-emerald-600/70 bg-emerald-950/25" : "border-zinc-800 bg-zinc-950 hover:bg-zinc-900"}`}
                      >
                        <input
                          type="radio"
                          name={`duplicate-target-${key}`}
                          checked={selected === task.id}
                          onChange={() => onSelect(group, task.id)}
                          className="mt-1 h-4 w-4 accent-emerald-600"
                        />
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="min-w-0 truncate font-medium text-zinc-100">{task.title || task.id}</span>
                            {task.uniqueId && <span className="rounded bg-zinc-800 px-1.5 py-0.5 font-mono text-[10px] text-zinc-400">#{task.uniqueId}</span>}
                            <code className="rounded bg-zinc-900 px-1.5 py-0.5 text-[10px] text-zinc-500">{task.id}</code>
                          </div>
                          <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-zinc-500">
                            {duplicateTaskMeta(task).map((part) => <span key={part}>{part}</span>)}
                          </div>
                        </div>
                        {task.url && (
                          <a href={task.url} target="_blank" rel="noreferrer" className="self-start text-[11px] text-blue-300 hover:text-blue-200">
                            打开
                          </a>
                        )}
                      </label>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
          {state.result?.results && (
            <pre className="mt-3 max-h-40 overflow-auto rounded border border-zinc-800 bg-zinc-950 p-3 text-[11px] text-zinc-400">
              {formatPreviewForDisplay(state.result)}
            </pre>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-3 border-t border-zinc-800 px-4 py-3">
          <label className="flex items-center gap-2 text-xs text-zinc-300">
            <input
              type="checkbox"
              checked={state.deleteAfterMerge === true}
              onChange={(event) => onDeleteAfterMergeChange(event.target.checked)}
              disabled={state.merging}
              className="h-4 w-4 accent-red-600"
            />
            合并后删除未选中的重复 TB 单
          </label>
          {missingSelection && <span className="text-[11px] text-amber-300">每组都需要选择一个目标单</span>}
          <button
            type="button"
            onClick={onCancel}
            disabled={state.merging}
            className="ml-auto rounded border border-zinc-700 bg-zinc-900 px-3 py-2 text-xs text-zinc-300 hover:bg-zinc-800 disabled:text-zinc-600"
          >
            取消
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={disabled}
            className="rounded bg-emerald-600 px-3 py-2 text-xs font-medium text-white hover:bg-emerald-500 disabled:bg-zinc-800 disabled:text-zinc-600"
          >
            {state.merging ? "合并中..." : "确认合并"}
          </button>
        </div>
      </div>
    </div>
  );
}

function SheetMappingConflictDialog({ state, onSelect, onCancel, onConfirm }) {
  const conflicts = state.conflicts || [];
  const selectedByProblemNo = state.selectedByProblemNo || {};
  const missingSelection = conflicts.some((conflict) => !selectedByProblemNo[sheetMappingDialogKey(conflict)]);
  const disabled = state.applying || missingSelection;
  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/70 p-4">
      <div className="flex max-h-[88vh] w-full max-w-5xl flex-col rounded border border-zinc-700 bg-zinc-950 shadow-2xl">
        <div className="flex flex-wrap items-start gap-3 border-b border-zinc-800 px-4 py-3">
          <div>
            <div className="text-sm font-medium text-zinc-100">任务表格映射冲突</div>
            <div className="mt-1 text-xs leading-relaxed text-zinc-500">
              开始同步前发现任务表格“钉钉单号”和网页映射表“TB 任务 ID”不一致。请选择每个飞书工单最终保留哪个 TB 单。
            </div>
          </div>
          <button
            type="button"
            onClick={onCancel}
            disabled={state.applying}
            className="ml-auto rounded border border-zinc-700 bg-zinc-900 px-2.5 py-1.5 text-xs text-zinc-300 hover:bg-zinc-800 disabled:text-zinc-600"
          >
            关闭
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          {state.error && (
            <div className="mb-3 rounded border border-red-800/60 bg-red-950/30 px-3 py-2 text-xs leading-relaxed text-red-200">
              {state.error}
            </div>
          )}
          <div className="space-y-3">
            {conflicts.map((conflict, index) => {
              const key = sheetMappingDialogKey(conflict);
              const selected = selectedByProblemNo[key] || "";
              return (
                <div key={key || index} className="rounded border border-zinc-800 bg-zinc-900/70 p-3">
                  <div className="flex flex-wrap items-start gap-2">
                    <div className="min-w-0 flex-1">
                      <div className="text-sm font-medium text-zinc-100">{conflict.sourceWorkItemNo || conflict.sourceWorkItemId || "未知飞书工单"}</div>
                      <div className="mt-1 flex flex-wrap gap-2 text-[11px] text-zinc-500">
                        {conflict.sourceWorkItemId && <code className="rounded bg-zinc-950 px-1.5 py-0.5">{conflict.sourceWorkItemId}</code>}
                        {conflict.sourceWorkItemUrl && (
                          <a href={conflict.sourceWorkItemUrl} target="_blank" rel="noreferrer" className="text-blue-300 hover:text-blue-200">
                            打开飞书单
                          </a>
                        )}
                      </div>
                    </div>
                    <span className="rounded bg-amber-500/15 px-2 py-1 text-[11px] text-amber-200">TB 映射不一致</span>
                  </div>

                  <div className="mt-3 grid gap-2 lg:grid-cols-2">
                    {[
                      {
                        choice: "current",
                        title: "保留网页映射表",
                        badge: "当前",
                        displayId: conflict.currentTargetDisplayId || conflict.currentTargetUniqueId || conflict.currentTargetTaskId || "-",
                        taskId: conflict.currentTargetTaskId || "",
                        meta: sheetMappingTargetMeta(conflict, "current"),
                      },
                      {
                        choice: "sheet",
                        title: "使用任务表格",
                        badge: "任务表格",
                        displayId: conflict.sheetTargetDisplayId || conflict.sheetTargetUniqueId || conflict.sheetTargetTaskId || "-",
                        taskId: conflict.sheetTargetTaskId || "",
                        meta: sheetMappingTargetMeta(conflict, "sheet"),
                      },
                    ].map((option) => (
                      <label
                        key={option.choice}
                        className={`flex cursor-pointer gap-3 rounded border px-3 py-2 text-xs ${selected === option.choice ? "border-emerald-600/70 bg-emerald-950/25" : "border-zinc-800 bg-zinc-950 hover:bg-zinc-900"}`}
                      >
                        <input
                          type="radio"
                          name={`sheet-mapping-${key}`}
                          checked={selected === option.choice}
                          onChange={() => onSelect(conflict, option.choice)}
                          className="mt-1 h-4 w-4 accent-emerald-600"
                        />
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="font-medium text-zinc-100">{option.title}</span>
                            <span className="rounded bg-zinc-800 px-1.5 py-0.5 text-[10px] text-zinc-400">{option.badge}</span>
                            <span className="rounded bg-zinc-900 px-1.5 py-0.5 font-mono text-[10px] text-zinc-300">{option.displayId}</span>
                          </div>
                          <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-zinc-500">
                            {option.taskId && <code className="rounded bg-zinc-900 px-1.5 py-0.5 text-[10px]">{option.taskId}</code>}
                            {option.meta.map((part) => <span key={part}>{part}</span>)}
                          </div>
                        </div>
                      </label>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
          {!!state.result?.warnings?.length && (
            <div className="mt-3 rounded border border-amber-800/50 bg-amber-950/20 px-3 py-2 text-xs leading-relaxed text-amber-200">
              {state.result.warnings.join(" / ")}
            </div>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-3 border-t border-zinc-800 px-4 py-3">
          {missingSelection && <span className="text-[11px] text-amber-300">每个冲突都需要选择一个 TB 单</span>}
          <button
            type="button"
            onClick={onCancel}
            disabled={state.applying}
            className="ml-auto rounded border border-zinc-700 bg-zinc-900 px-3 py-2 text-xs text-zinc-300 hover:bg-zinc-800 disabled:text-zinc-600"
          >
            取消
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={disabled}
            className="rounded bg-emerald-600 px-3 py-2 text-xs font-medium text-white hover:bg-emerald-500 disabled:bg-zinc-800 disabled:text-zinc-600"
          >
            {state.applying ? "确认中..." : "确认选择"}
          </button>
        </div>
      </div>
    </div>
  );
}

function RunConfirmDialog({ mode = "default", onCancel, onConfirm }) {
  const [remainingMs, setRemainingMs] = useState(RUN_CONFIRM_DELAY_MS);
  const modeCopy = {
    default: { label: "执行 /run", detail: "按当前配置和飞书问题编号执行同步" },
    web: { label: "网页态 /run", detail: "使用当前飞书网页登录态执行同步" },
    mcp: { label: "MCP /run", detail: "使用当前飞书 MCP 连接执行同步" },
  }[mode] || { label: "执行 /run", detail: "按当前配置执行同步" };

  useEffect(() => {
    const startedAt = Date.now();
    setRemainingMs(RUN_CONFIRM_DELAY_MS);
    const timer = setInterval(() => {
      const next = Math.max(0, RUN_CONFIRM_DELAY_MS - (Date.now() - startedAt));
      setRemainingMs(next);
      if (next === 0) clearInterval(timer);
    }, 100);
    return () => clearInterval(timer);
  }, [mode]);

  const remainingSeconds = Math.ceil(remainingMs / 1000);
  const confirmDisabled = remainingMs > 0;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4" data-testid="feishu-run-confirm-dialog">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="feishu-run-confirm-title"
        aria-describedby="feishu-run-confirm-description"
        className="w-full max-w-lg rounded border border-red-800/70 bg-zinc-950 shadow-2xl"
      >
        <div className="border-b border-zinc-800 px-4 py-3">
          <div id="feishu-run-confirm-title" className="text-sm font-medium text-zinc-100">确认执行真实飞书工单同步</div>
          <div id="feishu-run-confirm-description" className="mt-1 text-xs leading-relaxed text-zinc-500">
            确认后会创建或更新 TB 任务；本次操作不是 dry-run。
          </div>
        </div>
        <div className="space-y-3 px-4 py-4 text-xs leading-relaxed">
          <div className="rounded border border-red-900/60 bg-red-950/25 px-3 py-2 text-red-200">
            <div className="font-medium text-red-100">{modeCopy.label}</div>
            <div className="mt-1 text-red-200/80">{modeCopy.detail}</div>
          </div>
          <div className="text-zinc-400">请确认目标项目、飞书工单范围和 TB 配置无误后再继续。</div>
        </div>
        <div className="flex flex-wrap items-center gap-3 border-t border-zinc-800 px-4 py-3">
          {remainingMs > 0 && <span className="text-[11px] text-amber-300">请等待 {remainingSeconds} 秒后确认</span>}
          <button
            type="button"
            autoFocus
            onClick={onCancel}
            className="ml-auto rounded border border-zinc-700 bg-zinc-900 px-3 py-2 text-xs text-zinc-300 hover:bg-zinc-800"
            data-testid="feishu-run-cancel"
          >
            取消
          </button>
          <button
            type="button"
            onClick={() => {
              if (!confirmDisabled) onConfirm?.();
            }}
            disabled={confirmDisabled}
            className="rounded bg-red-600 px-3 py-2 text-xs font-medium text-white hover:bg-red-500 disabled:bg-zinc-800 disabled:text-zinc-600"
            data-testid="feishu-run-confirm"
          >
            {remainingMs > 0 ? `确认执行 (${remainingSeconds}s)` : "确认执行"}
          </button>
        </div>
      </div>
    </div>
  );
}

function ClearRecordsDialog({ state, recordCount = 0, onCancel, onConfirm }) {
  const [remainingMs, setRemainingMs] = useState(CLEAR_RECORDS_CONFIRM_DELAY_MS);

  useEffect(() => {
    const startedAt = Date.now();
    setRemainingMs(CLEAR_RECORDS_CONFIRM_DELAY_MS);
    const timer = setInterval(() => {
      setRemainingMs(Math.max(0, CLEAR_RECORDS_CONFIRM_DELAY_MS - (Date.now() - startedAt)));
    }, 100);
    return () => clearInterval(timer);
  }, []);

  const remainingSeconds = Math.ceil(remainingMs / 1000);
  const confirmDisabled = state.clearing || remainingMs > 0;
  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/70 p-4">
      <div className="w-full max-w-lg rounded border border-red-800/70 bg-zinc-950 shadow-2xl">
        <div className="border-b border-zinc-800 px-4 py-3">
          <div className="text-sm font-medium text-zinc-100">清空飞书工单 / TB 任务映射表</div>
          <div className="mt-1 text-xs leading-relaxed text-zinc-500">
            确认后会删除本地映射表、评论同步记录和附件同步记录，并把开放错误标记为已解决。不会删除飞书工单或 TB 任务。
          </div>
        </div>
        <div className="space-y-3 px-4 py-4 text-xs leading-relaxed">
          <div className="rounded border border-red-900/60 bg-red-950/25 px-3 py-2 text-red-200">
            当前将清空 {recordCount} 条映射关系；后续同步会把这些飞书工单视为从未同步过。
          </div>
          {state.error && (
            <div className="rounded border border-red-800/60 bg-red-950/30 px-3 py-2 text-red-200">
              {state.error}
            </div>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-3 border-t border-zinc-800 px-4 py-3">
          {remainingMs > 0 && <span className="text-[11px] text-amber-300">请等待 {remainingSeconds} 秒后确认</span>}
          <button
            type="button"
            onClick={onCancel}
            disabled={state.clearing}
            className="ml-auto rounded border border-zinc-700 bg-zinc-900 px-3 py-2 text-xs text-zinc-300 hover:bg-zinc-800 disabled:text-zinc-600"
          >
            取消
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={confirmDisabled}
            className="rounded bg-red-600 px-3 py-2 text-xs font-medium text-white hover:bg-red-500 disabled:bg-zinc-800 disabled:text-zinc-600"
          >
            {state.clearing ? "清空中..." : remainingMs > 0 ? `确定清空 (${remainingSeconds}s)` : "确定清空"}
          </button>
        </div>
      </div>
    </div>
  );
}

function DeleteRecordsDialog({ state, onCancel, onConfirm }) {
  const [remainingMs, setRemainingMs] = useState(DELETE_RECORDS_CONFIRM_DELAY_MS);
  const recordCount = state.recordKeys?.length || state.records?.length || 0;

  useEffect(() => {
    const startedAt = Date.now();
    setRemainingMs(DELETE_RECORDS_CONFIRM_DELAY_MS);
    const timer = setInterval(() => {
      const next = Math.max(0, DELETE_RECORDS_CONFIRM_DELAY_MS - (Date.now() - startedAt));
      setRemainingMs(next);
      if (next === 0) clearInterval(timer);
    }, 100);
    return () => clearInterval(timer);
  }, []);

  const remainingSeconds = Math.ceil(remainingMs / 1000);
  const confirmDisabled = state.deleting || remainingMs > 0 || recordCount === 0;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4" data-testid="feishu-record-delete-dialog">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="feishu-record-delete-title"
        aria-describedby="feishu-record-delete-description"
        className="w-full max-w-lg rounded border border-red-800/70 bg-zinc-950 shadow-2xl"
      >
        <div className="border-b border-zinc-800 px-4 py-3">
          <div id="feishu-record-delete-title" className="text-sm font-medium text-zinc-100">
            删除飞书工单 / TB 任务映射记录
          </div>
          <div id="feishu-record-delete-description" className="mt-1 text-xs leading-relaxed text-zinc-500">
            确认后会删除所选本地映射及关联的评论、附件和错误记录；不会删除飞书工单或 TB 任务。
          </div>
        </div>
        <div className="space-y-3 px-4 py-4 text-xs leading-relaxed">
          <div className="rounded border border-red-900/60 bg-red-950/25 px-3 py-2 text-red-200">
            当前将删除 {recordCount} 条映射关系；这些工单后续同步时会按未同步处理。
          </div>
          {state.error && (
            <div className="rounded border border-red-800/60 bg-red-950/30 px-3 py-2 text-red-200">
              {state.error}
            </div>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-3 border-t border-zinc-800 px-4 py-3">
          {remainingMs > 0 && <span className="text-[11px] text-amber-300">请等待 {remainingSeconds} 秒后确认</span>}
          <button
            type="button"
            autoFocus
            onClick={onCancel}
            disabled={state.deleting}
            className="ml-auto rounded border border-zinc-700 bg-zinc-900 px-3 py-2 text-xs text-zinc-300 hover:bg-zinc-800 disabled:text-zinc-600"
            data-testid="feishu-record-delete-cancel"
          >
            取消
          </button>
          <button
            type="button"
            onClick={() => {
              if (!confirmDisabled) onConfirm?.();
            }}
            disabled={confirmDisabled}
            className="rounded bg-red-600 px-3 py-2 text-xs font-medium text-white hover:bg-red-500 disabled:bg-zinc-800 disabled:text-zinc-600"
            data-testid="feishu-record-delete-confirm"
          >
            {state.deleting ? "删除中..." : remainingMs > 0 ? `确认删除 (${remainingSeconds}s)` : "确认删除"}
          </button>
        </div>
      </div>
    </div>
  );
}

function sheetMappingDialogKey(conflict = {}) {
  return conflict.sourceWorkItemNo || conflict.sourceProblemNo || conflict.problemNo || conflict.sourceWorkItemId || JSON.stringify(conflict);
}

function sheetMappingTargetMeta(conflict = {}, side = "current") {
  if (side === "sheet") {
    return [
      conflict.sheetTargetTitle ? `标题 ${conflict.sheetTargetTitle}` : "",
      conflict.sheetTask?.projectId ? `项目 ${conflict.sheetTask.projectId}` : "",
      conflict.sheetTask?.tasklistId ? `列表 ${conflict.sheetTask.tasklistId}` : "",
      conflict.sheetTask?.executorId ? `执行者 ${conflict.sheetTask.executorId}` : "",
      conflict.sheetTask?.updatedAt ? `更新 ${formatTime(conflict.sheetTask.updatedAt)}` : "",
    ].filter(Boolean);
  }
  return [
    conflict.currentTargetUniqueId ? `编号 CARB-${conflict.currentTargetUniqueId}` : "",
    conflict.record?.syncStatus ? `同步状态 ${conflict.record.syncStatus}` : "",
    conflict.record?.targetUpdatedAt ? `目标更新 ${formatTime(conflict.record.targetUpdatedAt)}` : "",
    conflict.record?.lastError ? `错误 ${conflict.record.lastError}` : "",
  ].filter(Boolean);
}

function duplicateDialogGroupKey(group = {}) {
  return group.sourceId || group.sourceWorkItemId || JSON.stringify(group.sourceKey || {});
}

function duplicateTaskMeta(task = {}) {
  return [
    task.projectName || task.projectId ? `项目 ${task.projectName || task.projectId}` : "",
    task.tasklistName || task.tasklistId ? `列表 ${task.tasklistName || task.tasklistId}` : "",
    task.statusName ? `状态 ${task.statusName}` : "",
    task.executorName || task.executorId ? `执行者 ${task.executorName || task.executorId}` : "",
    task.updatedAt ? `更新 ${formatTime(task.updatedAt)}` : "",
    task.createdAt ? `创建 ${formatTime(task.createdAt)}` : "",
  ].filter(Boolean);
}

function SheetUpdatePanel({ state, onApply, onClear }) {
  const plan = state.plan;
  if (!state.loading && !state.error && !state.pendingLogin && !plan && !state.result) return null;
  const items = plan?.items || [];
  const columns = plan?.columns || [];
  return (
    <Section
      title="飞书在线表格追加"
      right={(
        <div className="flex flex-wrap gap-2">
          {plan?.sheetUrl && <a href={plan.sheetUrl} target="_blank" rel="noreferrer" className="rounded border border-zinc-700 bg-zinc-950 px-2.5 py-1 text-xs text-blue-300 hover:bg-zinc-800">打开表格</a>}
          <button type="button" onClick={onClear} className="rounded border border-zinc-700 bg-zinc-950 px-2.5 py-1 text-xs text-zinc-300 hover:bg-zinc-800">清空</button>
        </div>
      )}
    >
      {state.loading && <div className="rounded border border-blue-800/50 bg-blue-950/20 px-3 py-2 text-xs text-blue-200">正在读取飞书在线表格并生成追加预览...</div>}
      {state.error && <div className="rounded border border-red-800/60 bg-red-950/30 px-3 py-2 text-xs leading-relaxed text-red-200">{state.error}</div>}
      {state.pendingLogin && (
        <div className="flex flex-wrap items-center gap-2 rounded border border-amber-800/50 bg-amber-950/20 px-3 py-2 text-xs leading-relaxed text-amber-100">
          <span>飞书用户切换完成后会自动继续写入；如果已完成切换但没有继续，请手动重试。</span>
          <button
            type="button"
            onClick={onApply}
            disabled={!plan?.updateCount || state.applying || state.loading}
            className="ml-auto rounded border border-amber-700/70 bg-amber-900/30 px-2.5 py-1 text-xs text-amber-100 hover:bg-amber-800/40 disabled:border-zinc-800 disabled:bg-zinc-900 disabled:text-zinc-600"
          >
            {plan?.updateCount ? "已完成切换，继续写入" : "等待登录后重新生成清单"}
          </button>
        </div>
      )}
      {plan && (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <span className="rounded bg-zinc-800 px-2 py-1 text-zinc-300">待追加 {plan.updateCount || 0}</span>
            <span className="rounded bg-zinc-800 px-2 py-1 text-zinc-400">表格现有 {plan.existingRowCount || 0} 行</span>
            <span className="rounded bg-zinc-800 px-2 py-1 text-zinc-400">按系统单号去重</span>
            {Object.entries(plan.actionCounts || {}).map(([key, value]) => (
              <span key={key} className="rounded bg-emerald-500/10 px-2 py-1 text-emerald-300">{key} {value}</span>
            ))}
            <button
              type="button"
              onClick={onApply}
              disabled={!plan.updateCount || state.applying}
              className="ml-auto rounded bg-emerald-600 px-3 py-2 text-xs font-medium text-white hover:bg-emerald-500 disabled:bg-zinc-800 disabled:text-zinc-600"
            >
              {state.applying ? "写入中..." : "确认追加到飞书表格"}
            </button>
          </div>
          {!!plan.warnings?.length && (
            <div className="rounded border border-amber-800/50 bg-amber-950/20 px-3 py-2 text-xs leading-relaxed text-amber-200">
              {plan.warnings.join(" / ")}
            </div>
          )}
          <div className="max-h-[520px] overflow-auto rounded border border-zinc-800 bg-zinc-950">
            {items.length ? items.map((item, index) => (
              <SheetUpdateBlock key={`${item.key || index}-${item.action}`} item={item} columns={columns} />
            )) : (
              <div className="px-3 py-6 text-center text-xs text-zinc-500">没有需要追加到飞书表格的行。</div>
            )}
          </div>
          {state.result && (
            <div className={`rounded border px-3 py-2 text-xs leading-relaxed ${state.result.ok === false ? "border-red-800/60 bg-red-950/30 text-red-200" : "border-emerald-800/60 bg-emerald-950/20 text-emerald-200"}`}>
              写入结果：{state.result.ok === false ? (state.result.error || "失败") : `已追加 ${state.result.applied || 0} 条记录`}
            </div>
          )}
        </div>
      )}
    </Section>
  );
}

function SheetUpdateBlock({ item, columns }) {
  const changed = new Set(item.changedColumns || []);
  return (
    <div className="border-b border-zinc-900 p-3 last:border-b-0">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <span className={`rounded px-2 py-1 text-[11px] ${item.action === "新增" ? "bg-emerald-500/15 text-emerald-300" : item.action === "删除" ? "bg-red-500/15 text-red-300" : "bg-blue-500/15 text-blue-300"}`}>
          动作：{item.action}
        </span>
        <span className="font-mono text-[11px] text-zinc-500">{item.sourceWorkItemNo || item.sourceWorkItemId}</span>
        {item.targetUniqueId && <span className="font-mono text-[11px] text-zinc-500">{item.targetUniqueId}</span>}
      </div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[1120px] text-left text-[11px]">
          <thead>
            <tr className="border-b border-zinc-800">
              <th className="w-16 py-1.5 pr-2 text-zinc-600"> </th>
              {columns.map((column) => <th key={column} className="py-1.5 pr-2 text-zinc-500">{column}</th>)}
            </tr>
          </thead>
          <tbody>
            {item.oldRow && (
              <tr className="border-b border-zinc-900">
                <td className="py-1.5 pr-2 text-zinc-600">当前</td>
                {columns.map((column) => <td key={column} className="max-w-72 truncate py-1.5 pr-2 text-zinc-400">{item.oldRow[column] || ""}</td>)}
              </tr>
            )}
            <tr>
              <td className="py-1.5 pr-2 text-zinc-300">{item.action === "更新" ? "变更为" : item.action}</td>
              {columns.map((column) => (
                <td key={column} className={`max-w-72 truncate py-1.5 pr-2 ${changed.has(column) ? "bg-yellow-400/20 text-yellow-100" : "text-zinc-200"}`}>
                  {item.newRow?.[column] || ""}
                </td>
              ))}
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  );
}

function OverviewPanel({ config, readiness, records, retryable, tbMembers, tbTasklists, tbSprints }) {
  const keywordRules = Array.isArray(getPath(config, "mappings.keywordRules", [])) ? getPath(config, "mappings.keywordRules", []) : [];
  const fieldMappings = getPath(config, "mappings.fields", {});
  const customFieldMappings = getPath(config, "mappings.customFields", {});
  const peopleMappings = getPath(config, "mappings.people", {});
  const statusMappings = getPath(config, "mappings.status", {});
  const priorityMappings = getPath(config, "mappings.priority", {});
  const severityMappings = getPath(config, "mappings.severity", {});
  const attachmentMode = String(getPath(config, "sync.attachmentMode", "upload"));
  const scopeText = readScopeSummary(config);
  const viewText = sourceViewsSummary(config);
  const sortText = sortSummary(config);
  const sprintText = tbSprintSummary(config);
  const requiredMembers = requiredTbMemberItems(config, tbMembers);
  const missing = visibleMissingForAuthMode(readiness, config);
  const displayContext = readableTbContext(config, tbMembers, tbTasklists, tbSprints);
  const tb = getPath(config, "teambition", {});
  const projectName = configuredDisplayName(displayContext.projects, tb.projectId, tb.projectPathName || tb.projectName, "项目名称未解析");
  const tasklistName = configuredDisplayName(displayContext.tasklists, tb.tasklistId, tb.tasklistName || pathTail(tb.projectPathName), "任务列表名称未解析");
  const stageName = configuredDisplayName(displayContext.stages, tb.stageId, tb.stageName, "阶段名称未解析");
  const statusName = configuredDisplayName(displayContext.statuses, tb.taskflowstatusId, tb.taskflowstatusName || tb.statusName, "状态名称未解析");
  const executorName = configuredDisplayName(displayContext.members, tb.defaultExecutorId, tb.defaultExecutorName, "负责人姓名未解析");
  const routing = policyRoutingForUi(config);
  const activePolicyRules = policyRulesByPriority(routing.rules).filter(({ rule }) => rule.enabled !== false);
  return (
    <div className="space-y-4">
      <Section
        title="当前生效规则"
        right={(
          <span className={`rounded border px-2.5 py-1 text-[11px] ${missing.length ? "border-amber-700/50 bg-amber-950/30 text-amber-200" : "border-emerald-700/50 bg-emerald-950/25 text-emerald-300"}`}>
            {missing.length ? `缺失 ${missing.length} 项` : "规则完整"}
          </span>
        )}
      >
        <div className="grid gap-3 lg:grid-cols-3">
          <OverviewTile title="飞书读取" lines={[
            `模式：${getPath(config, "feishu.authMode", readiness?.authMode || "plugin")}`,
            `默认空间：${getPath(config, "feishu.spaceKey", "-")}`,
            `默认类型：${getPath(config, "feishu.workItemTypeKey", "-")}`,
            `工单来源：${viewText}`,
            `MCP：${getPath(config, "feishu.mcp.enabled", false) ? "启用" : "未启用"}`,
          ]} />
          <OverviewTile title="TB 目标" lines={[
            `项目：${projectName}`,
            `迭代：${sprintText}`,
            `任务列表：${tasklistName}`,
            `阶段：${stageName}`,
            `状态：${statusName}`,
            `类型：${getPath(config, "teambition.taskTypeName", "缺陷")}`,
            `项目归属：${getPath(config, "teambition.projectPathName", "-")}`,
            `默认执行者：${executorName}`,
          ]}>
            <FixedTbMembersSummary members={requiredMembers} />
          </OverviewTile>
          <OverviewTile title="同步策略" lines={[
            `评论：${getPath(config, "sync.includeComments", true) ? "同步" : "不同步"}`,
            `附件：${describeAttachmentMode(attachmentMode)}`,
            `时间：提单时间开始 ${getPath(config, "teambition.defaultDurationDays", 3)} 天内`,
            `标题：${getPath(config, "teambition.titleTemplate", "-")}`,
            `开始时间：${getPath(config, "sync.ensureStartDate", true) ? "按飞书创建时间补写" : "不自动补写"}`,
            `读取筛选：${scopeText}`,
            `排序：${sortText}`,
            `异常重试：${retryable?.length || 0} 条`,
          ]} />
        </div>
        <div className="mt-3 rounded border border-amber-800/40 bg-amber-950/20 px-3 py-2 text-xs leading-relaxed text-amber-100">
          日期规则：飞书“期望修复日期”写入 TB 截止时间；TB 开始时间使用飞书单创建时间。若飞书截止时间早于飞书创建时间，TB 会拒绝开始时间，系统保留截止时间并在结果里返回 scheduleWarnings。
        </div>
        <div className="mt-3" data-testid="current-effective-routing-rules">
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <div className="text-xs font-medium text-zinc-200">策略路由条件</div>
            <span className="rounded bg-cyan-500/10 px-2 py-0.5 text-[10px] text-cyan-200">按优先级首条命中</span>
          </div>
          <div className="grid gap-2 lg:grid-cols-2">
            {activePolicyRules.map(({ rule }) => {
              const summary = policyRuleSummary(rule, routing);
              const target = routing.targets.find((entry) => entry.id === rule.targetId) || {};
              const destination = policyTargetSummary(target, tb);
              return (
                <div key={rule.id} className="rounded border border-cyan-900/55 bg-cyan-950/15 px-3 py-2">
                  <div className="flex flex-wrap items-center gap-2 text-[11px]">
                    <span className="font-medium text-cyan-100">{summary.name}</span>
                    <span className="ml-auto text-zinc-500">优先级 {rule.priority ?? 0}</span>
                  </div>
                  <div className="mt-1 text-[11px] leading-relaxed text-zinc-300">{summary.conditionText}</div>
                  <div className="mt-1 text-[10px] text-zinc-500">
                    命中后：{summary.targetName} / {destination.tasklistName} / {destination.sprintName} / {summary.strategyName}
                  </div>
                </div>
              );
            })}
            {!activePolicyRules.length && <div className="rounded border border-dashed border-zinc-800 px-3 py-4 text-center text-xs text-zinc-600">没有启用的策略路由规则，将使用默认目标与默认同步策略。</div>}
          </div>
        </div>
        <div className="mt-3 grid gap-3 md:grid-cols-2 xl:grid-cols-5">
          <Metric label="同步关系" value={records?.length || 0} />
          <Metric label="策略路由" value={activePolicyRules.length} />
          <Metric label="旧关键词规则" value={keywordRules.length} />
          <Metric label="字段映射" value={Object.keys(fieldMappings || {}).length + Object.keys(customFieldMappings || {}).length} />
          <Metric label="缺失配置" value={missing.length} tone={missing.length ? "warn" : "ok"} />
        </div>
      </Section>

      <Section title="关键词规则">
        <div className="grid gap-3 xl:grid-cols-2">
          {keywordRules.map((rule, idx) => (
            <div key={rule.id || idx} className="rounded border border-zinc-800 bg-zinc-950 p-3 text-xs">
              <div className="mb-2 flex items-center gap-2">
                <span className={`rounded px-2 py-0.5 text-[11px] ${rule.enabled === false ? "bg-zinc-800 text-zinc-500" : "bg-emerald-500/15 text-emerald-300"}`}>
                  {rule.enabled === false ? "停用" : "启用"}
                </span>
                <span className="font-medium text-zinc-100">{rule.name || rule.id || `规则 ${idx + 1}`}</span>
                <span className="ml-auto text-[10px] text-zinc-600">执行顺序 #{idx + 1}</span>
              </div>
              <OverviewRows rows={[
                ["匹配范围", `${rule.scope || "all"} / ${rule.match || "any"}`],
                ["关键词", (rule.keywords || []).join("、") || "-"],
                ["限定字段 Key", (rule.fieldKeys || []).join("、") || "-"],
                ["限定字段名", (rule.fieldNames || []).join("、") || "-"],
                ["目标项目", configuredDisplayName(displayContext.projects, rule.target?.projectId || tb.projectId, rule.target?.projectPathName || rule.target?.projectName || tb.projectPathName || tb.projectName, "项目名称未解析")],
                ["目标迭代", configuredDisplayName(displayContext.sprints, rule.target?.sprintId || tb.sprintId, rule.target?.sprintName || tb.sprintName, "迭代名称未解析")],
                ["目标任务列表", configuredDisplayName(displayContext.tasklists, rule.target?.tasklistId || tb.tasklistId, rule.target?.tasklistName || tb.tasklistName, "任务列表名称未解析")],
                ["目标阶段", configuredDisplayName(displayContext.stages, rule.target?.stageId || tb.stageId, rule.target?.stageName || tb.stageName, "阶段名称未解析")],
                ["执行者", configuredDisplayName(displayContext.members, rule.target?.executorId || tb.defaultExecutorId, rule.target?.executorName || tb.defaultExecutorName, "负责人姓名未解析")],
                ["标签", uniqList([...(rule.target?.tagNames || []), ...(rule.tagNames || []), ...normalizeListValue(rule.target?.tagIds || []).map((id) => configuredDisplayName(displayContext.tags, id, "", "标签名称未解析"))]).join("、") || "-"],
              ]} />
            </div>
          ))}
          {!keywordRules.length && <div className="rounded border border-dashed border-zinc-800 py-10 text-center text-sm text-zinc-600">暂无关键词规则</div>}
        </div>
      </Section>

      <Section title="字段与值映射">
        <div className="grid gap-3 lg:grid-cols-2">
          <MappingSummary title="飞书字段 -> TB 自定义字段" map={{ ...(customFieldMappings || {}), ...(fieldMappings || {}) }} resolveValue={(value) => readableMappingValue(value, "customFields", displayContext)} />
          <MappingSummary title="人员 -> TB 用户" map={peopleMappings} resolveValue={(value) => readableMappingValue(value, "people", displayContext)} />
          <MappingSummary title="状态 -> TB 状态" map={statusMappings} resolveValue={(value) => readableMappingValue(value, "status", displayContext)} />
          <MappingSummary title="优先级 / 严重程度" map={{ ...(priorityMappings || {}), ...(severityMappings || {}) }} resolveValue={(value) => readableMappingValue(value, "priority", displayContext)} />
        </div>
      </Section>
    </div>
  );
}

function SyncConfigAlert({ issues, onOpenConfig }) {
  if (!issues?.length) return null;
  const shown = issues.slice(0, 8);
  const hiddenCount = Math.max(0, issues.length - shown.length);
  return (
    <section className="rounded border border-amber-700/60 bg-amber-950/20 p-4">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
        <div className="min-w-0">
          <div className="text-sm font-medium text-amber-100">当前配置存在异常，开始同步前需要处理</div>
          <div className="mt-1 text-xs leading-relaxed text-amber-200/80">
            同步执行页已保留操作入口，但配置未正常时 dry-run、真实同步、重复检测可能会被禁用或失败。
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            {shown.map((issue) => (
              <span key={issue} className="rounded border border-amber-800/60 bg-zinc-950 px-2 py-1 text-[11px] text-amber-200">
                {issue}
              </span>
            ))}
            {hiddenCount > 0 && <span className="rounded bg-zinc-900 px-2 py-1 text-[11px] text-zinc-400">还有 {hiddenCount} 项</span>}
          </div>
        </div>
        <button
          type="button"
          onClick={onOpenConfig}
          className="shrink-0 rounded bg-amber-600 px-3 py-2 text-xs font-medium text-white hover:bg-amber-500"
        >
          去配置处理
        </button>
      </div>
    </section>
  );
}

function ConfigSectionHeading({ title, description }) {
  return (
    <div className="flex flex-col gap-1 border-t border-zinc-800/80 pt-4">
      <div className="text-sm font-medium text-zinc-100">{title}</div>
      {description && <div className="text-xs leading-relaxed text-zinc-500">{description}</div>}
    </div>
  );
}

function AdvancedConfigGroup({ children }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="space-y-3">
      <div className="flex flex-col gap-3 rounded border border-zinc-800 bg-zinc-900/55 p-3 lg:flex-row lg:items-center lg:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <div className="text-sm font-medium text-zinc-100">高级配置</div>
            <span className="rounded border border-zinc-700 bg-zinc-950 px-2 py-0.5 text-[11px] text-zinc-400">默认收起</span>
          </div>
          <div className="mt-1 text-xs leading-relaxed text-zinc-500">
            连接凭证、低频 TB 字段、字段映射和关键词路由集中在这里；日常范围、排序、目标迭代和固定参与者已整合到常用配置。
          </div>
        </div>
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className={`shrink-0 rounded border px-3 py-2 text-xs transition ${open ? "border-zinc-600 bg-zinc-800 text-zinc-100" : "border-zinc-700 bg-zinc-950 text-zinc-300 hover:bg-zinc-800"}`}
        >
          {open ? "收起高级配置" : "展开高级配置"}
        </button>
      </div>
      {open && <div className="space-y-4">{children}</div>}
    </div>
  );
}

function QuickSyncPanel({
  config,
  readiness,
  canEdit,
  saving,
  quickRunBusy,
  quickRunResult,
  recordsRefreshResult,
  quickRunEvents,
  feishuWeb,
  feishuMcp,
  tbMembers,
  onSave,
  onAuthModeChange,
  onFeishuWebLogin,
  onDryRun,
  onRun,
  onRefreshRecords,
  duplicateMerge,
  sheetMappingMerge,
  sheetUpdate,
  onCheckDuplicates,
  onDuplicateSelect,
  onDuplicateDeleteAfterMergeChange,
  onDuplicateConfirm,
  onDuplicateClear,
  onUpdateSheet,
  onOpenRules,
  onOpenPreview,
}) {
  const authMode = getPath(config, "feishu.authMode", readiness?.authMode || "plugin");
  const missing = visibleMissingForAuthMode(readiness, config);
  const requiredKeywords = ownerFilterValues(config);
  const readFilters = normalizeFeishuReadFiltersForUi(config);
  const scopeText = readScopeSummary(config);
  const viewText = sourceViewsSummary(config);
  const sourceViewIssues = sourceViewValidationIssues(config);
  const configuredSourceViews = normalizeFeishuSourceViewsForUi(config);
  const sourceViewCount = configuredSourceViews.length;
  const enabledSourceViewCount = configuredSourceViews.filter((view) => view.enabled).length;
  const sortText = sortSummary(config);
  const sprintText = tbSprintSummary(config);
  const requiredMembers = requiredTbMemberItems(config, tbMembers);
  const requiredMembersText = requiredTbMemberDisplayText(requiredMembers);
  const requiredMembersTitle = requiredTbMemberTitleText(requiredMembers);
  const batchSize = Number(getPath(config, "sync.batchSize", 50)) || 50;
  const sourceReady = authModeStatus({ mode: authMode, readiness, feishuWeb, feishuMcp }).ok;
  const blockers = [
    !canEdit ? "管理员未登录" : "",
    !config.enabled ? "同步未启用" : "",
    !readiness?.teambitionReady ? "TB 未就绪" : "",
    !tbSprintForUi(config).sprintId ? "TB 目标迭代未配置" : "",
    missing.length ? `${missing.length} 项配置缺失` : "",
    !sourceReady ? `${modeLabel(authMode)}未就绪` : "",
    sourceViewIssues.length ? `飞书来源：${sourceViewIssues[0].message}` : "",
    !readFilters.length ? "筛选条件为空" : "",
  ].filter(Boolean);
  const ready = !blockers.length;
  const buttonBusy = !!quickRunBusy;
  const duplicateBusy = !!duplicateMerge?.checking || !!duplicateMerge?.merging;
  const sheetMappingBusy = !!sheetMappingMerge?.checking || !!sheetMappingMerge?.applying;
  const sheetBusy = !!sheetUpdate?.loading || !!sheetUpdate?.applying;
  const actionBusy = buttonBusy || duplicateBusy || sheetMappingBusy || sheetBusy;
  const sourceListBlockers = [
    !canEdit ? "管理员未登录" : "",
    !config.enabled ? "同步未启用" : "",
    !sourceReady ? `${modeLabel(authMode)}未就绪` : "",
    sourceViewIssues.length ? `飞书来源：${sourceViewIssues[0].message}` : "",
    !readFilters.length ? "筛选条件为空" : "",
  ].filter(Boolean);
  const sourceListReady = !sourceListBlockers.length;
  const sheetUrl = taskSheetUrl(config);
  const primaryActionText = sheetMappingMerge?.checking ? "检查表格映射" : quickRunBusy === "run" ? "同步中" : "开始同步";
  const refreshActionText = quickRunBusy === "refresh-records" ? "更新中" : "更新飞书工单";
  const readinessText = ready ? "可以开始同步" : `还需处理 ${blockers.length} 项`;
  const readinessDetail = ready
    ? `${modeLabel(authMode)} 已连接，单次最多同步 ${batchSize} 条`
    : blockers.slice(0, 3).join(" / ");
  const blockerKey = blockers.join("|");
  const [statusOpen, setStatusOpen] = useState(() => blockers.length > 0);
  useEffect(() => {
    setStatusOpen(blockers.length > 0);
  }, [blockerKey, blockers.length]);
  return (
    <Section
      title="同步操作"
      right={(
        <div className="flex flex-wrap gap-2">
          <button onClick={onOpenRules} className="rounded border border-zinc-700 bg-zinc-950 px-2.5 py-1 text-xs text-zinc-300 hover:bg-zinc-800">配置与规则</button>
          <button onClick={onOpenPreview} className="rounded border border-zinc-700 bg-zinc-950 px-2.5 py-1 text-xs text-zinc-300 hover:bg-zinc-800">结果预览</button>
        </div>
      )}
    >
      <div className="space-y-3">
        <div className="rounded-lg border border-zinc-800 bg-zinc-950/95 p-4">
          <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(360px,520px)] lg:items-center">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${ready ? "bg-emerald-400 shadow-[0_0_14px_rgba(52,211,153,0.55)]" : "bg-amber-400 shadow-[0_0_14px_rgba(251,191,36,0.35)]"}`} />
                <div className="text-sm font-medium text-zinc-100">执行操作</div>
                <span className={`rounded px-2 py-0.5 text-[11px] ${ready ? "bg-emerald-500/15 text-emerald-300" : "bg-amber-500/15 text-amber-300"}`}>
                  {ready ? "状态正常" : `${blockers.length} 项待处理`}
                </span>
                {actionBusy && <span className="rounded bg-blue-500/15 px-2 py-0.5 text-[11px] text-blue-300">处理中</span>}
              </div>
              <div className="mt-2 max-w-3xl text-xs leading-relaxed text-zinc-500">
                先预检再同步；状态原因和配置明细在下方“同步状态”里展开查看。
              </div>
              <div className="mt-3">
                <FeishuReadModeSwitcher
                  value={authMode}
                  onChange={onAuthModeChange}
                  canEdit={canEdit && !actionBusy}
                  readiness={readiness}
                  feishuWeb={feishuWeb}
                  feishuMcp={feishuMcp}
                  onWebLogin={onFeishuWebLogin}
                  compact
                />
              </div>
            </div>

            <div className="rounded border border-zinc-800 bg-zinc-900/45 p-3">
              <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_150px_120px]">
                <button
                  onClick={onRun}
                  disabled={!ready || actionBusy}
                  className="flex h-12 min-w-0 items-center justify-center rounded bg-emerald-600 px-4 text-sm font-medium text-white shadow-lg shadow-emerald-950/40 transition hover:bg-emerald-500 disabled:bg-zinc-800 disabled:text-zinc-600 disabled:shadow-none"
                >
                  {primaryActionText}
                </button>
                <button
                  type="button"
                  onClick={onRefreshRecords}
                  disabled={!sourceListReady || actionBusy}
                  title={sourceListReady ? "只更新飞书工单列表到本地映射表，不创建或更新 TB 任务" : sourceListBlockers.join(" / ")}
                  className="h-12 rounded border border-emerald-700/60 bg-emerald-950/20 px-3 text-xs font-medium text-emerald-200 transition hover:bg-emerald-900/35 disabled:border-zinc-800 disabled:bg-zinc-900 disabled:text-zinc-600"
                >
                  {refreshActionText}
                </button>
                <button
                  onClick={onDryRun}
                  disabled={!ready || actionBusy}
                  className="h-12 rounded border border-blue-700/60 bg-blue-950/30 px-3 text-xs text-blue-200 transition hover:bg-blue-900/50 disabled:border-zinc-800 disabled:bg-zinc-900 disabled:text-zinc-600"
                >
                  {quickRunBusy === "dry-run" ? "预检中" : "预检"}
                </button>
              </div>
              <div className="mt-2 grid gap-2 sm:grid-cols-4">
                <button
                  onClick={onSave}
                  disabled={!canEdit || saving || actionBusy}
                  className="h-9 rounded border border-zinc-700 bg-zinc-950 px-3 text-xs text-zinc-200 transition hover:bg-zinc-800 disabled:text-zinc-600"
                >
                  {saving ? "保存中" : "保存规则"}
                </button>
                <button
                  type="button"
                  onClick={onCheckDuplicates}
                  disabled={!ready || actionBusy}
                  className="h-9 rounded border border-amber-700/60 bg-amber-950/20 px-3 text-xs text-amber-200 transition hover:bg-amber-900/30 disabled:border-zinc-800 disabled:bg-zinc-900 disabled:text-zinc-600"
                >
                  {duplicateBusy ? "检测中" : "查重"}
                </button>
                <button
                  type="button"
                  onClick={onUpdateSheet}
                  disabled={!canEdit || actionBusy}
                  className="h-9 rounded border border-cyan-700/60 bg-cyan-950/20 px-3 text-xs text-cyan-200 transition hover:bg-cyan-900/30 disabled:border-zinc-800 disabled:bg-zinc-900 disabled:text-zinc-600"
                >
                  {sheetUpdate?.loading ? "生成中" : sheetUpdate?.applying ? "写入中" : "更新表格"}
                </button>
                <a
                  href={sheetUrl || undefined}
                  target="_blank"
                  rel="noreferrer"
                  aria-disabled={!sheetUrl}
                  onClick={(event) => {
                    if (!sheetUrl) event.preventDefault();
                  }}
                  className={`flex h-9 items-center justify-center rounded border px-3 text-center text-xs transition ${
                    sheetUrl
                      ? "border-cyan-700/60 bg-zinc-950 text-cyan-200 hover:bg-cyan-900/20"
                      : "cursor-not-allowed border-zinc-800 bg-zinc-900 text-zinc-600"
                  }`}
                >
                  表格
                </a>
              </div>
            </div>
          </div>
        </div>

        <div className="rounded-lg border border-zinc-800 bg-zinc-950/90 p-4">
          <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${ready ? "bg-emerald-400" : "bg-amber-400"}`} />
                <div className="text-xs font-medium text-zinc-200">同步状态</div>
                <span className={`rounded px-2 py-0.5 text-[11px] ${ready ? "bg-emerald-500/15 text-emerald-300" : "bg-amber-500/15 text-amber-300"}`}>
                  {ready ? "全部就绪" : `${blockers.length} 项待处理`}
                </span>
              </div>
              <div className="mt-1 max-w-4xl truncate text-[11px] text-zinc-500" title={readinessDetail || ""}>
                {statusOpen ? (readinessDetail || "状态检查已展开") : ready ? "状态详情已收起" : "存在阻断项，已自动展开供排查"}
              </div>
            </div>
            <div className="flex shrink-0 flex-wrap gap-2">
              <button
                type="button"
                onClick={() => setStatusOpen((v) => !v)}
                className={`rounded border px-3 py-1.5 text-xs transition ${statusOpen ? "border-zinc-600 bg-zinc-800 text-zinc-100" : "border-zinc-700 bg-zinc-950 text-zinc-300 hover:bg-zinc-800"}`}
              >
                {statusOpen ? "收起状态" : blockers.length ? `查看 ${blockers.length} 项问题` : "展开状态"}
              </button>
              {blockers.length > 0 && (
                <button
                  type="button"
                  onClick={onOpenRules}
                  className="rounded bg-amber-600 px-3 py-1.5 text-xs font-medium text-white transition hover:bg-amber-500"
                >
                  去配置
                </button>
              )}
            </div>
          </div>

          {statusOpen && (
            <>
              <div className="mt-3 grid gap-2 text-xs sm:grid-cols-2 xl:grid-cols-4">
                <ActionMetric label="读取方式" value={modeLabel(authMode)} title={modeLabel(authMode)} />
                <ActionMetric label="批量上限" value={`${batchSize} 条`} />
                <ActionMetric label="目标迭代" value={sprintText} title={sprintText} />
                <ActionMetric label="固定参与者" value={requiredMembersText} title={requiredMembersTitle} />
              </div>
              <div className="mt-3 flex flex-col gap-1 text-[11px] text-zinc-500 sm:flex-row sm:items-center sm:justify-between">
                <div className="min-w-0 truncate" title={scopeText}>范围：{scopeText}</div>
                <div className="shrink-0" title={sortText}>排序：{sortText}</div>
              </div>
              <div className="mt-3 grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
                <StatusPill label="飞书" ok={sourceReady} detail={modeLabel(authMode)} />
                <StatusPill
                  label={`工单来源 ${enabledSourceViewCount}/${sourceViewCount}`}
                  ok={!sourceViewIssues.length && enabledSourceViewCount > 0}
                  detail={viewText}
                />
                <StatusPill label="TB" ok={!!readiness?.teambitionReady} detail={getPath(config, "teambition.projectPathName", getPath(config, "teambition.projectName", "项目名称未解析"))} />
                <StatusPill label="目标迭代" ok={!!tbSprintForUi(config).sprintId} detail={sprintText} />
                <StatusPill label="筛选条件" ok={!!readFilters.length} detail={scopeText} />
                <StatusPill label="排序" ok detail={sortText} />
                <StatusPill label="固定参与者" ok={!!requiredKeywords.length || !!requiredMembers.length} detail={requiredMembersText} detailTitle={requiredMembersTitle} />
                <StatusPill label="数量" ok={!!batchSize} detail={`${batchSize} 条`} />
              </div>

              {blockers.length > 0 && (
                <div className="mt-3 flex flex-col gap-2 rounded border border-amber-800/50 bg-amber-950/20 px-3 py-2 text-[11px] leading-relaxed text-amber-200 sm:flex-row sm:items-center sm:justify-between">
                  <div className="min-w-0">{blockers.join(" / ")}</div>
                  <button
                    type="button"
                    onClick={onOpenRules}
                    className="shrink-0 rounded bg-amber-600 px-2.5 py-1 text-[11px] font-medium text-white transition hover:bg-amber-500"
                  >
                    去配置处理
                  </button>
                </div>
              )}
            </>
          )}
        </div>

        <FeishuRecordsRefreshResultPanel result={recordsRefreshResult} />
        <SyncResultSummary result={quickRunResult} config={config} />
        <DuplicateCheckResultPanel
          state={duplicateMerge}
          onSelect={onDuplicateSelect}
          onDeleteAfterMergeChange={onDuplicateDeleteAfterMergeChange}
          onConfirm={onDuplicateConfirm}
          onClear={onDuplicateClear}
        />
        <SyncRunLog events={quickRunEvents} run={quickRunResult?.run} />
      </div>
    </Section>
  );
}

function QuickSyncSettingsCards({
  config,
  canEdit,
  setCfg,
  onAttachmentModeChange,
  readiness,
  feishuWeb,
  feishuMcp,
  onFeishuWebLogin,
  tbSprints,
  tbMembers,
  feishuFilterMeta,
  onLoadFeishuFilterMetadata,
  onLoadTbSprints,
  onSelectTbSprint,
  onTbMemberQueryChange,
  onLoadTbMembers,
  onSelectTbMember,
  onRemoveTbMember,
  feishuFilterPreset,
  feishuFilterConfigBusy,
  onSetFeishuFilterPreset,
  onBackupFeishuFilters,
  onRestoreFeishuFilters,
}) {
  const authMode = getPath(config, "feishu.authMode", "mcp");
  const batchSize = Number(getPath(config, "sync.batchSize", 50)) || 50;
  const attachmentOptions = [
    { value: "upload", label: "下载后上传到 TB" },
    { value: "comment_link", label: "只在评论中保留飞书链接" },
    { value: "skip", label: "跳过附件" },
  ];

  return (
    <fieldset disabled={!canEdit} className="m-0 border-0 p-0">
      <div className="grid gap-3 2xl:grid-cols-[1.15fr_0.85fr]">
        <div className="rounded border border-zinc-800 bg-zinc-950 p-3">
          <div className="mb-3 text-xs font-medium text-zinc-200">读取与范围</div>
          <div className="grid gap-3 md:grid-cols-2">
            <div className="md:col-span-2">
              <FeishuReadModeSwitcher
                value={authMode}
                onChange={(v) => setCfg("feishu.authMode", v)}
                canEdit={canEdit}
                readiness={readiness}
                feishuWeb={feishuWeb}
                feishuMcp={feishuMcp}
                onWebLogin={onFeishuWebLogin}
              />
            </div>
            <TextInput label="批量数量" type="number" value={batchSize} onChange={(v) => setCfg("sync.batchSize", v)} />
            {authMode === "mcp" && (
              <TextInput
                label="MCP 工单类型名称"
                value={getPath(config, "feishu.mcp.workItemTypeName")}
                onChange={(v) => setCfg("feishu.mcp.workItemTypeName", v)}
                placeholder="飞书项目中的类型显示名，如 缺陷"
              />
            )}
            {authMode === "mcp" && (
              <TextInput
                label="MCP 当前负责人字段"
                value={getPath(config, "feishu.mcp.assigneeFieldKey", "current_status_operator")}
                onChange={(v) => setCfg("feishu.mcp.assigneeFieldKey", v)}
                placeholder="current_status_operator"
                mono
              />
            )}
            <div className="md:col-span-2">
              <SourceViewsEditor config={config} setCfg={setCfg} canEdit={canEdit} />
            </div>
            <div className="md:col-span-2">
              <FeishuReadScopeEditor
                config={config}
                setCfg={setCfg}
                canEdit={canEdit}
                metadata={feishuFilterMeta}
                onLoadMetadata={onLoadFeishuFilterMetadata}
                preset={feishuFilterPreset}
                busy={feishuFilterConfigBusy}
                onSetPreset={onSetFeishuFilterPreset}
                onBackup={onBackupFeishuFilters}
                onRestore={onRestoreFeishuFilters}
              />
            </div>
            <div className="md:col-span-2">
              <SortRuleEditor config={config} setCfg={setCfg} canEdit={canEdit} />
            </div>
            <div className="md:col-span-2">
              <TbMemberPicker
                config={config}
                tbMembers={tbMembers}
                canEdit={canEdit}
                onQueryChange={onTbMemberQueryChange}
                onLoadTbMembers={onLoadTbMembers}
                onSelectTbMember={onSelectTbMember}
                onRemoveTbMember={onRemoveTbMember}
              />
            </div>
          </div>
        </div>

        <div className="rounded border border-zinc-800 bg-zinc-950 p-3">
          <div className="mb-3 text-xs font-medium text-zinc-200">同步选项</div>
          <div className="grid gap-3">
            <TbSprintPicker
              config={config}
              tbSprints={tbSprints}
              canEdit={canEdit}
              onLoadTbSprints={onLoadTbSprints}
              onSelectTbSprint={onSelectTbSprint}
            />
            <TaskSheetSettingsCard config={config} setCfg={setCfg} canEdit={canEdit} />
            <Toggle label="启用同步" checked={config.enabled} onChange={(v) => setCfg("enabled", v)} />
            <Toggle label="同步评论" checked={getPath(config, "sync.includeComments", true)} onChange={(v) => setCfg("sync.includeComments", v)} />
            <Toggle label="同步附件" checked={getPath(config, "sync.includeAttachments", true)} onChange={(v) => setCfg("sync.includeAttachments", v)} />
            <SelectInput label="附件处理" value={getPath(config, "sync.attachmentMode", "upload")} onChange={(v) => onAttachmentModeChange(v)} options={attachmentOptions} />
          </div>
        </div>
      </div>
    </fieldset>
  );
}

function TaskSheetSettingsCard({ config, setCfg, canEdit }) {
  const enabled = sheetSyncEnabled(config);
  const url = taskSheetUrl(config || {});
  return (
    <div className="rounded border border-zinc-800 bg-zinc-900/70 p-3">
      <div className="mb-3 flex flex-wrap items-start gap-2">
        <div className="min-w-0 flex-1">
          <div className="text-xs font-medium text-zinc-200">任务表格</div>
          <div className="mt-1 truncate text-[11px] text-zinc-500" title={url || DEFAULT_FEISHU_TASK_SHEET_URL}>
            更新任务表格会读取这个飞书在线表格，按系统单号去重后追加缺失行。
          </div>
        </div>
        {url && (
          <a href={url} target="_blank" rel="noreferrer" className="rounded border border-zinc-700 bg-zinc-950 px-2.5 py-1.5 text-[11px] text-blue-300 hover:bg-zinc-800 hover:text-blue-200">
            打开表格
          </a>
        )}
      </div>
      <div className="grid gap-3">
        <Toggle label="启用任务表格更新" checked={enabled} onChange={(v) => setCfg("sheetSync.enabled", v)} />
        <TextInput
          label="任务表格 URL"
          value={getPath(config, "sheetSync.url", DEFAULT_FEISHU_TASK_SHEET_URL)}
          onChange={(v) => setCfg("sheetSync.url", v)}
          mono
          placeholder={DEFAULT_FEISHU_TASK_SHEET_URL}
        />
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-2 text-[10px] text-zinc-500">
        <span className={`rounded border px-2 py-0.5 ${enabled ? "border-emerald-700/50 bg-emerald-900/20 text-emerald-300" : "border-amber-700/50 bg-amber-900/20 text-amber-300"}`}>
          {enabled ? "已启用" : "已关闭"}
        </span>
        <span>修改后点击页面顶部“保存规则”生效。</span>
      </div>
      {!canEdit && <div className="mt-2 text-[10px] text-amber-300">当前为只读状态，请先登录管理后台再修改。</div>}
    </div>
  );
}

function SourceViewsEditor({ config, setCfg, canEdit }) {
  const [draftUrl, setDraftUrl] = useState("");
  const [draftName, setDraftName] = useState("");
  const [addError, setAddError] = useState("");
  const [actionError, setActionError] = useState("");
  const [pendingDeleteId, setPendingDeleteId] = useState("");
  const [highlightedSourceId, setHighlightedSourceId] = useState("");
  const sources = normalizeFeishuSourceViewsForUi(config);
  const issues = sourceViewValidationIssues(sources);
  const issueById = new Map(issues.filter((issue) => issue.id).map((issue) => [issue.id, issue]));
  const enabledCount = sources.filter((view) => view.enabled).length;
  const draftValidation = draftUrl ? validateFeishuSourceViewUrl(draftUrl) : null;
  const parsedDraft = draftValidation?.parsed || {};
  const draftError = addError || (draftValidation && !draftValidation.ok ? draftValidation.error : "");
  const draftErrorId = "feishu-source-view-draft-url-error";

  const commit = (nextSources) => {
    const nextConfig = applySourceViewsToConfig(config, nextSources);
    setCfg("feishu", nextConfig.feishu);
    setActionError("");
  };

  const focusSource = (id) => {
    setHighlightedSourceId(id);
    window.setTimeout(() => setHighlightedSourceId((current) => current === id ? "" : current), 2400);
    window.setTimeout(() => {
      const card = Array.from(document.querySelectorAll("[data-source-view-id]"))
        .find((element) => element.dataset.sourceViewId === id);
      card?.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }, 0);
  };

  const addSource = (event) => {
    event?.preventDefault?.();
    if (!canEdit) return;
    const result = addFeishuSourceView(sources, { name: draftName, url: draftUrl });
    if (result.error) {
      setAddError(result.error);
      if (result.duplicateId) focusSource(result.duplicateId);
      return;
    }
    commit(result.sources);
    setDraftUrl("");
    setDraftName("");
    setAddError("");
    focusSource(result.added.id);
  };

  const toggleSource = (id, enabled) => {
    const result = toggleFeishuSourceView(sources, id, enabled);
    if (result.error) {
      setActionError(result.error);
      focusSource(id);
      return;
    }
    commit(result.sources);
  };

  const removeSource = (id) => {
    const result = removeFeishuSourceView(sources, id);
    if (result.error) {
      setActionError(result.error);
      focusSource(id);
      return;
    }
    commit(result.sources);
    setPendingDeleteId("");
  };

  return (
    <div id="feishu-source-views" className="overflow-hidden rounded-lg border border-zinc-800 bg-zinc-900/70">
      <div className="border-b border-zinc-800 bg-gradient-to-r from-sky-950/35 via-zinc-900/80 to-zinc-900 px-3 py-3">
        <div className="flex flex-wrap items-start gap-3">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <div className="text-xs font-medium text-zinc-100">飞书工单来源</div>
              <span className={`rounded-full border px-2 py-0.5 text-[10px] ${enabledCount ? "border-emerald-700/50 bg-emerald-950/35 text-emerald-300" : "border-amber-700/50 bg-amber-950/35 text-amber-300"}`}>
                已启用 {enabledCount}/{sources.length}
              </span>
              <span className="rounded-full border border-zinc-700 bg-zinc-950/70 px-2 py-0.5 text-[10px] text-zinc-400">
                多来源合并去重
              </span>
            </div>
            <div className="mt-1 text-[11px] leading-relaxed text-zinc-500">
              可添加多个飞书 workObjectView 列表。默认来源用于网页登录和快捷打开；同步会读取全部已启用来源，批量数量按合并去重后的结果计算。
            </div>
          </div>
          <div className="shrink-0 text-right text-[10px] text-zinc-500">
            <div>{sourceViewsSummary(config)}</div>
            <div className="mt-1">修改后点击页面顶部“保存规则”</div>
          </div>
        </div>

        <form onSubmit={addSource} className="mt-3 rounded-lg border border-zinc-800/90 bg-zinc-950/80 p-3" data-testid="feishu-source-view-add-form">
          <div className="grid gap-2 lg:grid-cols-[minmax(0,1fr)_220px_auto] lg:items-end">
            <label className="min-w-0">
              <span className="mb-1 block text-[11px] text-zinc-400">新增飞书工单列表 URL</span>
              <input
                type="url"
                value={draftUrl}
                onChange={(event) => {
                  setDraftUrl(event.target.value);
                  setAddError("");
                }}
                disabled={!canEdit}
                placeholder="https://project.feishu.cn/intelligentspace/workObjectView/bug_double_eight/6VIRXf5vg"
                className={`h-10 w-full rounded border bg-zinc-950 px-3 font-mono text-xs text-zinc-200 outline-none transition placeholder:text-zinc-700 focus:ring-1 ${addError || (draftValidation && !draftValidation.ok) ? "border-red-700/70 focus:border-red-500 focus:ring-red-900" : "border-zinc-700 focus:border-sky-500 focus:ring-sky-900"}`}
                aria-invalid={Boolean(draftError)}
                aria-describedby={draftError ? draftErrorId : undefined}
                aria-errormessage={draftError ? draftErrorId : undefined}
                data-testid="feishu-source-view-url-input"
              />
            </label>
            <label className="min-w-0">
              <span className="mb-1 block text-[11px] text-zinc-400">名称（可选）</span>
              <input
                value={draftName}
                onChange={(event) => setDraftName(event.target.value)}
                disabled={!canEdit}
                placeholder="例如：双八缺陷"
                className="h-10 w-full rounded border border-zinc-700 bg-zinc-950 px-3 text-xs text-zinc-200 outline-none transition placeholder:text-zinc-700 focus:border-sky-500 focus:ring-1 focus:ring-sky-900"
              />
            </label>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => {
                  setDraftUrl(DEFAULT_FEISHU_SOURCE_VIEW_URL);
                  setAddError("");
                }}
                disabled={!canEdit}
                className="h-10 rounded border border-zinc-700 bg-zinc-900 px-3 text-[11px] text-zinc-300 transition hover:bg-zinc-800 disabled:text-zinc-600"
              >
                填入示例
              </button>
              <button
                type="submit"
                disabled={!canEdit || !draftValidation?.ok}
                className="h-10 rounded bg-sky-600 px-4 text-xs font-medium text-white shadow-lg shadow-sky-950/30 transition hover:bg-sky-500 disabled:bg-zinc-800 disabled:text-zinc-600 disabled:shadow-none"
                data-testid="feishu-source-view-add-button"
              >
                添加来源
              </button>
            </div>
          </div>
          {draftValidation?.ok && (
            <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[10px]">
              <span className="text-emerald-300">已识别</span>
              <SourceViewMetaChip>{parsedDraft.sourceProjectKey || "-"}/{parsedDraft.sourceWorkItemTypeKey || "-"}</SourceViewMetaChip>
              <SourceViewMetaChip>View {parsedDraft.viewId || "-"}</SourceViewMetaChip>
              {parsedDraft.scope && <SourceViewMetaChip>Scope {parsedDraft.scope}</SourceViewMetaChip>}
              {parsedDraft.node && <SourceViewMetaChip>Node {parsedDraft.node}</SourceViewMetaChip>}
            </div>
          )}
          {draftError && (
            <div
              id={draftErrorId}
              aria-live="polite"
              aria-atomic="true"
              className="mt-2 flex items-start gap-1.5 text-[10px] leading-relaxed text-red-300"
            >
              <span aria-hidden="true">!</span>
              <span>{draftError}</span>
            </div>
          )}
        </form>
      </div>

      <div className="space-y-2 p-3">
        {sources.map((view, index) => {
          const issue = issueById.get(view.id);
          const deleting = pendingDeleteId === view.id;
          const highlighted = highlightedSourceId === view.id;
          const controlAriaLabels = sourceViewControlAriaLabels(view, index);
          const urlErrorId = `feishu-source-view-url-error-${index}`;
          return (
            <div
              key={view.id}
              data-source-view-id={view.id}
              data-testid={`feishu-source-view-card-${index}`}
              className={`rounded-lg border p-3 transition-all ${highlighted ? "border-sky-500 bg-sky-950/20 ring-1 ring-sky-700/50" : issue ? "border-red-800/65 bg-red-950/10" : view.enabled ? "border-zinc-700 bg-zinc-950/95" : "border-zinc-800 bg-zinc-950/55 opacity-75"}`}
            >
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  role="switch"
                  aria-checked={view.enabled}
                  aria-label={controlAriaLabels.toggle}
                  onClick={() => toggleSource(view.id, !view.enabled)}
                  disabled={!canEdit}
                  className={`inline-flex h-7 items-center gap-1.5 rounded-full border px-2.5 text-[10px] transition ${view.enabled ? "border-emerald-700/60 bg-emerald-950/35 text-emerald-300" : "border-zinc-700 bg-zinc-900 text-zinc-500"} disabled:cursor-not-allowed`}
                >
                  <span className={`h-1.5 w-1.5 rounded-full ${view.enabled ? "bg-emerald-400" : "bg-zinc-600"}`} />
                  {view.enabled ? "已启用" : "已停用"}
                </button>
                <button
                  type="button"
                  onClick={() => commit(setDefaultFeishuSourceView(sources, view.id))}
                  disabled={!canEdit || view.isDefault}
                  aria-label={controlAriaLabels.setDefault}
                  className={`h-7 rounded-full border px-2.5 text-[10px] transition ${view.isDefault ? "border-amber-600/60 bg-amber-950/30 text-amber-200" : "border-zinc-700 bg-zinc-900 text-zinc-400 hover:border-amber-700 hover:text-amber-200"} disabled:cursor-default`}
                  title={view.isDefault ? "网页登录和快捷打开使用此来源" : "设为默认来源"}
                >
                  {view.isDefault ? "★ 默认来源" : "☆ 设为默认"}
                </button>
                <span className="font-mono text-[10px] text-zinc-600">#{index + 1}</span>
                <div className="ml-auto flex items-center gap-2">
                  {view.valid && (
                    <a
                      href={view.url}
                      target="_blank"
                      rel="noreferrer"
                      className="h-7 rounded border border-sky-800/70 bg-sky-950/25 px-2.5 py-1.5 text-[10px] text-sky-300 transition hover:bg-sky-900/35 hover:text-sky-200"
                    >
                      打开视图 ↗
                    </a>
                  )}
                  {!deleting ? (
                    <button
                      type="button"
                      onClick={() => setPendingDeleteId(view.id)}
                      disabled={!canEdit}
                      aria-label={controlAriaLabels.remove}
                      className="h-7 rounded border border-zinc-700 bg-zinc-900 px-2.5 text-[10px] text-zinc-400 transition hover:border-red-800 hover:bg-red-950/20 hover:text-red-300 disabled:text-zinc-600"
                    >
                      删除
                    </button>
                  ) : (
                    <div className="flex items-center gap-1 rounded border border-red-800/60 bg-red-950/25 p-0.5">
                      <span className="px-1.5 text-[10px] text-red-200">确认删除？</span>
                      <button
                        type="button"
                        onClick={() => removeSource(view.id)}
                        aria-label={controlAriaLabels.confirmRemove}
                        className="rounded bg-red-600 px-2 py-1 text-[10px] text-white hover:bg-red-500"
                      >
                        删除
                      </button>
                      <button
                        type="button"
                        onClick={() => setPendingDeleteId("")}
                        aria-label={controlAriaLabels.cancelRemove}
                        className="rounded px-2 py-1 text-[10px] text-zinc-400 hover:bg-zinc-800"
                      >
                        取消
                      </button>
                    </div>
                  )}
                </div>
              </div>

              <div className="mt-3 grid gap-2 md:grid-cols-[220px_minmax(0,1fr)]">
                <label className="min-w-0">
                  <span className="mb-1 block text-[10px] text-zinc-500">来源名称</span>
                  <input
                    value={view.name}
                    onChange={(event) => commit(updateFeishuSourceView(sources, view.id, { name: event.target.value }))}
                    disabled={!canEdit}
                    className="h-9 w-full rounded border border-zinc-800 bg-zinc-900 px-2.5 text-xs text-zinc-200 outline-none transition focus:border-sky-600 disabled:text-zinc-500"
                  />
                </label>
                <label className="min-w-0">
                  <span className="mb-1 block text-[10px] text-zinc-500">飞书视图 URL</span>
                  <input
                    value={view.url}
                    onChange={(event) => commit(updateFeishuSourceView(sources, view.id, { url: event.target.value }))}
                    disabled={!canEdit}
                    aria-invalid={Boolean(issue)}
                    aria-describedby={issue ? urlErrorId : undefined}
                    aria-errormessage={issue ? urlErrorId : undefined}
                    className={`h-9 w-full rounded border bg-zinc-900 px-2.5 font-mono text-xs text-zinc-200 outline-none transition ${issue ? "border-red-700/70 focus:border-red-500" : "border-zinc-800 focus:border-sky-600"} disabled:text-zinc-500`}
                  />
                </label>
              </div>

              <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[10px]">
                {view.valid ? (
                  <>
                    <SourceViewMetaChip>{view.sourceProjectKey || "-"}/{view.sourceWorkItemTypeKey || "-"}</SourceViewMetaChip>
                    <SourceViewMetaChip>View {view.viewId || "-"}</SourceViewMetaChip>
                    {view.scope && <SourceViewMetaChip>Scope {view.scope}</SourceViewMetaChip>}
                    {view.node && <SourceViewMetaChip>Node {view.node}</SourceViewMetaChip>}
                  </>
                ) : (
                  <span className="text-red-300">未识别到有效的飞书列表视图</span>
                )}
                {issue && (
                  <span id={urlErrorId} aria-live="polite" aria-atomic="true" className="ml-auto text-red-300">
                    {issue.message}
                  </span>
                )}
              </div>
            </div>
          );
        })}
        {!sources.length && (
          <div className="rounded-lg border border-dashed border-amber-800/60 bg-amber-950/15 px-4 py-8 text-center">
            <div className="text-xs text-amber-200">尚未配置飞书工单来源</div>
            <div className="mt-1 text-[10px] text-zinc-500">在上方粘贴一个 workObjectView URL 后添加。</div>
          </div>
        )}
        {actionError && (
          <div aria-live="polite" className="rounded border border-amber-800/60 bg-amber-950/20 px-3 py-2 text-[10px] text-amber-200">
            {actionError}
          </div>
        )}
      </div>
    </div>
  );
}

function SourceViewMetaChip({ children }) {
  return (
    <span className="rounded border border-zinc-700/80 bg-zinc-900 px-2 py-0.5 font-mono text-zinc-400">
      {children}
    </span>
  );
}

function SortRuleEditor({ config, setCfg, canEdit }) {
  const rules = syncSortForUi(config);
  const displayRules = enabledFirstRows(rules);
  const commit = (nextRules) => {
    const normalized = nextRules.map((rule, index) => ({
      id: String(rule.id || rule.fieldKey || rule.fieldName || `sort-${index}`).trim(),
      enabled: rule.enabled !== false,
      fieldKey: String(rule.fieldKey || "").trim(),
      fieldName: String(rule.fieldName || rule.fieldKey || "").trim(),
      direction: rule.direction === "asc" ? "asc" : "desc",
    })).filter((rule) => rule.fieldKey || rule.fieldName);
    setCfg("sync.sort", normalized);
  };
  const updateRule = (idx, patch) => commit(rules.map((rule, i) => i === idx ? { ...rule, ...patch } : rule));
  return (
    <div className="rounded border border-zinc-800 bg-zinc-900/70 p-3">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div className="min-w-0 flex-1">
          <div className="text-xs font-medium text-zinc-200">排序规则</div>
          <div className="mt-1 truncate text-[11px] text-zinc-500">{sortSummary(config)}</div>
        </div>
        <button
          type="button"
          onClick={() => commit([...rules, { id: `sort-${Date.now()}`, enabled: true, fieldKey: "updated_at", fieldName: "更新时间", direction: "desc" }])}
          disabled={!canEdit}
          className="rounded border border-zinc-700 bg-zinc-950 px-2.5 py-1.5 text-[11px] text-zinc-300 hover:bg-zinc-800 disabled:text-zinc-600"
        >
          添加排序
        </button>
        <button
          type="button"
          onClick={() => commit([])}
          disabled={!canEdit || !rules.length}
          className="rounded border border-zinc-700 bg-zinc-950 px-2.5 py-1.5 text-[11px] text-zinc-300 hover:bg-zinc-800 disabled:text-zinc-600"
        >
          跟随视图
        </button>
      </div>
      <div className="space-y-2">
        {displayRules.map(({ value: rule, index: idx }) => (
          <div key={`${rule.id || idx}-${idx}`} className={`grid gap-2 rounded border p-2.5 md:grid-cols-[76px_auto_1fr_1fr_130px_auto] md:items-end ${rule.enabled !== false ? "border-blue-800/70 bg-zinc-950" : "border-zinc-800 bg-zinc-950/70"}`}>
            <div className={`mb-2 rounded px-1.5 py-0.5 text-center text-[10px] ${rule.enabled !== false ? "bg-blue-500/15 text-blue-200" : "bg-zinc-800 text-zinc-500"}`}>
              {rule.enabled !== false ? "生效中" : "已停用"}
              <div className="mt-0.5 text-[9px] text-zinc-600">#{idx + 1}</div>
            </div>
            <Toggle label="启用" checked={rule.enabled !== false} onChange={(v) => updateRule(idx, { enabled: v })} />
            <TextInput label="字段 Key" value={rule.fieldKey} onChange={(v) => updateRule(idx, { fieldKey: v })} mono />
            <TextInput label="字段名" value={rule.fieldName} onChange={(v) => updateRule(idx, { fieldName: v })} />
            <SelectInput
              label="方向"
              value={rule.direction}
              onChange={(v) => updateRule(idx, { direction: v })}
              options={[
                { value: "desc", label: "降序" },
                { value: "asc", label: "升序" },
              ]}
            />
            <button
              type="button"
              onClick={() => commit(rules.filter((_, i) => i !== idx))}
              disabled={!canEdit}
              className="h-9 rounded border border-zinc-700 bg-zinc-900 px-2.5 text-xs text-zinc-300 hover:bg-zinc-800 disabled:text-zinc-600"
            >
              删除
            </button>
          </div>
        ))}
        {!rules.length && <div className="rounded border border-dashed border-zinc-800 py-6 text-center text-xs text-zinc-600">未配置显式排序，优先使用来源视图保存的排序。</div>}
      </div>
    </div>
  );
}

function FeishuReadScopeEditor({ config, setCfg, canEdit, metadata, onLoadMetadata, preset, busy, onSetPreset, onBackup, onRestore }) {
  const [valueDrafts, setValueDrafts] = useState({});
  const restoreInputRef = useRef(null);
  const filters = normalizeFeishuReadFiltersForUi(config);
  const displayFilters = enabledFirstRows(filters);
  const match = String(getPath(config, "sync.readScope.match", "all")) === "any" ? "any" : "all";
  const fields = feishuFilterFieldOptions(metadata);
  const loading = !!metadata?.loading;
  const error = metadata?.error || "";

  const commitFilters = (nextFilters) => {
    const normalized = normalizeFeishuReadFiltersForUi(setPath(config || {}, "sync.readScope.filters", nextFilters));
    setCfg("sync.readScope.filters", normalized);
    const owner = normalized.find((filter) => isDefaultOwnerFilter(filter));
    setCfg("sync.requiredAssigneeKeywords", owner?.values || []);
  };

  const updateFilter = (idx, patch) => {
    commitFilters(filters.map((filter, i) => i === idx ? { ...filter, ...patch } : filter));
  };

  const selectField = (idx, value) => {
    const field = fields.find((item) => feishuFilterFieldValue(item) === value);
    if (!field) return;
    updateFilter(idx, nextFilterForSelectedField(filters[idx], field, Object.fromEntries(FEISHU_FILTER_OPERATORS.map((item) => [item.value, item.label]))));
  };

  const addFilter = () => {
    commitFilters([...filters, { ...DEFAULT_FEISHU_OWNER_FILTER, id: `filter-${Date.now()}` }]);
  };

  const resetDefault = () => {
    commitFilters([{ ...DEFAULT_FEISHU_OWNER_FILTER, values: [...DEFAULT_FEISHU_OWNER_FILTER_VALUES] }]);
    setCfg("sync.readScope.match", "all");
  };

  const addFilterValue = (idx, filter, draftKey) => {
    const value = String(valueDrafts[draftKey] || "").trim();
    if (!value) return;
    updateFilter(idx, { values: uniqList([...(filter.values || []), value]) });
    setValueDrafts((current) => ({ ...current, [draftKey]: "" }));
  };

  return (
    <div className="rounded border border-zinc-800 bg-zinc-900/70 p-3">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div className="min-w-0 flex-1">
          <div className="text-xs font-medium text-zinc-200">设置筛选条件</div>
          <div className="mt-1 text-[11px] text-zinc-500">
            {metadata?.loaded ? `飞书字段 ${metadata.fields?.length || 0} 个，角色 ${metadata.roles?.length || 0} 个` : "默认使用问题责任人（角色）筛选"}
          </div>
        </div>
        <select
          value={match}
          onChange={(e) => setCfg("sync.readScope.match", e.target.value)}
          disabled={!canEdit}
          className="h-8 rounded border border-zinc-700 bg-zinc-950 px-2 text-[11px] text-zinc-200 outline-none focus:border-blue-500"
        >
          <option value="all">全部条件</option>
          <option value="any">任一条件</option>
        </select>
        <button
          type="button"
          onClick={() => onLoadMetadata?.({ quiet: false })}
          disabled={!canEdit || loading}
          className="rounded border border-zinc-700 bg-zinc-950 px-2.5 py-1.5 text-[11px] text-zinc-300 hover:bg-zinc-800 disabled:text-zinc-600"
        >
          {loading ? "读取中" : "读取飞书选项"}
        </button>
        <button
          type="button"
          onClick={resetDefault}
          disabled={!canEdit}
          className="rounded border border-zinc-700 bg-zinc-950 px-2.5 py-1.5 text-[11px] text-zinc-300 hover:bg-zinc-800 disabled:text-zinc-600"
        >
          使用默认值
        </button>
        <button
          type="button"
          onClick={onSetPreset}
          disabled={!canEdit || !!busy}
          className="rounded border border-emerald-700/70 bg-emerald-950/30 px-2.5 py-1.5 text-[11px] text-emerald-200 hover:bg-emerald-900/40 disabled:text-zinc-600"
          title="把当前筛选条件写入独立预置文件；清空运行数据或重新部署后仍会作为默认筛选条件加载"
        >
          {busy === "preset" ? "设置中" : "设置为预置"}
        </button>
        <button
          type="button"
          onClick={onBackup}
          disabled={!config || !!busy}
          className="rounded border border-zinc-700 bg-zinc-950 px-2.5 py-1.5 text-[11px] text-zinc-300 hover:bg-zinc-800 disabled:text-zinc-600"
        >
          备份
        </button>
        <button
          type="button"
          onClick={() => restoreInputRef.current?.click()}
          disabled={!canEdit || !!busy}
          className="rounded border border-zinc-700 bg-zinc-950 px-2.5 py-1.5 text-[11px] text-zinc-300 hover:bg-zinc-800 disabled:text-zinc-600"
        >
          {busy === "restore" ? "还原中" : "还原"}
        </button>
        <input
          ref={restoreInputRef}
          type="file"
          accept="application/json,.json"
          className="hidden"
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = "";
            if (file) onRestore?.(file);
          }}
        />
      </div>

      <div className="mb-3 text-[10px] text-zinc-600">
        {preset?.updatedAt ? `当前持久预置更新于 ${formatTime(preset.updatedAt)}` : "尚未设置持久预置；“使用默认值”仍只恢复内置责任人条件。"}
      </div>

      <div className="space-y-2">
        {displayFilters.map(({ value: filter, index: idx }) => {
          const selectedField = fields.find((field) => field.key === filter.fieldKey && field.kind === filter.kind)
            || fields.find((field) => field.key === filter.fieldKey)
            || { kind: filter.kind, key: filter.fieldKey, name: filter.fieldName, options: [] };
          const choices = feishuFilterValueChoices(selectedField, filter);
          const valuesText = stringifyList(filter.values || []);
          const managesPeople = isDefaultOwnerFilter(filter);
          const draftKey = String(filter.id || filter.fieldKey || idx);
          const valueDraft = valueDrafts[draftKey] || "";
          return (
            <div key={`${filter.id || idx}-${idx}`} className={`rounded border p-2.5 ${filter.enabled !== false ? "border-blue-800/70 bg-zinc-950" : "border-zinc-800 bg-zinc-950/70"}`}>
              <div className="mb-2 flex flex-wrap items-center justify-between gap-2 text-[10px]">
                <span className={`rounded px-1.5 py-0.5 ${filter.enabled !== false ? "bg-blue-500/15 text-blue-200" : "bg-zinc-800 text-zinc-500"}`}>{filter.enabled !== false ? "生效中" : "已停用"}</span>
                <span className="text-zinc-600">执行顺序 #{idx + 1}</span>
              </div>
              <div className="grid gap-2 lg:grid-cols-[auto_minmax(180px,1fr)_minmax(150px,0.8fr)_auto] lg:items-end">
                <Toggle label="启用" checked={filter.enabled !== false} onChange={(v) => updateFilter(idx, { enabled: v })} />
                <div className="block min-w-0">
                  <span className="mb-1 block text-[11px] text-zinc-500">飞书字段</span>
                  <FeishuFieldPicker
                    fields={fields}
                    selectedField={selectedField}
                    onSelect={(value) => selectField(idx, value)}
                    disabled={!canEdit}
                  />
                </div>
                <label className="block min-w-0">
                  <span className="mb-1 block text-[11px] text-zinc-500">条件</span>
                  <select
                    value={filter.operator || "containsAny"}
                    onChange={(e) => {
                      const operator = FEISHU_FILTER_OPERATORS.find((item) => item.value === e.target.value);
                      updateFilter(idx, { operator: e.target.value, operatorLabel: operator?.label || e.target.value });
                    }}
                    className="h-9 w-full rounded border border-zinc-700 bg-zinc-900 px-2 text-xs text-zinc-200 outline-none focus:border-blue-500"
                  >
                    {FEISHU_FILTER_OPERATORS.map((operator) => (
                      <option key={operator.value} value={operator.value}>{operator.label}</option>
                    ))}
                  </select>
                </label>
                <button
                  type="button"
                  onClick={() => commitFilters(filters.filter((_, i) => i !== idx))}
                  disabled={!canEdit || filters.length <= 1}
                  className="h-9 rounded border border-zinc-700 bg-zinc-900 px-2.5 text-xs text-zinc-300 hover:bg-zinc-800 disabled:text-zinc-600"
                >
                  删除
                </button>
              </div>

              {(filter.operator || "containsAny") !== "exists" && (filter.operator || "containsAny") !== "empty" && (
                <div className={`mt-2 grid gap-2 ${managesPeople ? "lg:grid-cols-[1fr_320px]" : "lg:grid-cols-[1fr_220px]"}`}>
                  <div className="min-w-0 rounded border border-zinc-800 bg-zinc-900 p-2">
                    <div className="mb-1 text-[11px] text-zinc-500">{managesPeople ? "飞书选项（点击选择或取消人员）" : "飞书选项"}</div>
                    <div className="flex max-h-28 flex-wrap gap-1.5 overflow-auto">
                      {choices.map((choice) => {
                        const selected = (filter.values || []).includes(choice.label);
                        return (
                          <button
                            key={choice.label}
                            type="button"
                            onClick={() => updateFilter(idx, { values: toggleFilterValue(filter.values, choice.label) })}
                            disabled={!canEdit}
                            aria-pressed={selected}
                            className={`rounded border px-2 py-1 text-[11px] ${selected ? "border-blue-500/60 bg-blue-500/15 text-blue-200" : "border-zinc-700 bg-zinc-950 text-zinc-400 hover:text-zinc-200"}`}
                          >
                            {choice.label}
                          </button>
                        );
                      })}
                      {!choices.length && <span className="px-1 py-1 text-[11px] text-zinc-600">暂无可选项</span>}
                    </div>
                  </div>
                  {managesPeople ? (
                    <div className="block min-w-0 rounded border border-zinc-800 bg-zinc-900 p-2">
                      <span className="mb-1 block text-[11px] text-zinc-500">已选人员</span>
                      <div className="mb-2 flex min-h-7 flex-wrap gap-1.5">
                        {(filter.values || []).map((value) => (
                          <span key={value} className="inline-flex items-center gap-1 rounded border border-blue-500/50 bg-blue-500/10 px-2 py-1 text-[11px] text-blue-200">
                            {value}
                            <button
                              type="button"
                              onClick={() => updateFilter(idx, { values: (filter.values || []).filter((item) => item !== value) })}
                              disabled={!canEdit}
                              aria-label={`删除人员 ${value}`}
                              title={`删除 ${value}`}
                              className="text-blue-300 hover:text-white disabled:text-zinc-600"
                            >
                              ×
                            </button>
                          </span>
                        ))}
                        {!(filter.values || []).length && <span className="py-1 text-[11px] text-zinc-600">暂未选择人员</span>}
                      </div>
                      <div className="flex gap-1.5">
                        <input
                          type="text"
                          value={valueDraft}
                          onChange={(e) => setValueDrafts((current) => ({ ...current, [draftKey]: e.target.value }))}
                          onKeyDown={(e) => {
                            if (e.key !== "Enter") return;
                            e.preventDefault();
                            addFilterValue(idx, filter, draftKey);
                          }}
                          disabled={!canEdit}
                          aria-label="添加问题责任人"
                          placeholder="输入姓名"
                          className="h-8 min-w-0 flex-1 rounded border border-zinc-700 bg-zinc-950 px-2 text-xs text-zinc-200 outline-none focus:border-blue-500 disabled:text-zinc-600"
                        />
                        <button
                          type="button"
                          onClick={() => addFilterValue(idx, filter, draftKey)}
                          disabled={!canEdit || !String(valueDraft).trim()}
                          className="h-8 shrink-0 rounded border border-zinc-700 bg-zinc-950 px-2.5 text-[11px] text-zinc-300 hover:bg-zinc-800 disabled:text-zinc-600"
                        >
                          添加人员
                        </button>
                      </div>
                    </div>
                  ) : (
                    <label className="block min-w-0">
                      <span className="mb-1 block text-[11px] text-zinc-500">已选值</span>
                      <textarea
                        value={valuesText}
                        onChange={(e) => updateFilter(idx, { values: parseList(e.target.value) })}
                        disabled={!canEdit}
                        className="min-h-24 w-full rounded border border-zinc-700 bg-zinc-900 p-2 font-mono text-xs text-zinc-200 outline-none focus:border-blue-500 disabled:text-zinc-600"
                      />
                    </label>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={addFilter}
          disabled={!canEdit}
          className="rounded border border-zinc-700 bg-zinc-950 px-2.5 py-1.5 text-[11px] text-zinc-300 hover:bg-zinc-800 disabled:text-zinc-600"
        >
          添加条件
        </button>
        {error && <span className="text-[11px] text-red-300">{error}</span>}
      </div>
    </div>
  );
}

function FeishuFieldPicker({ fields = [], selectedField = {}, onSelect, disabled = false }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const rootRef = useRef(null);
  const inputRef = useRef(null);
  const selectedValue = feishuFilterFieldValue(selectedField);
  const filteredFields = filterFeishuFieldChoices(fields, query);

  useEffect(() => {
    if (!open) return undefined;
    const focusTimer = setTimeout(() => inputRef.current?.focus(), 0);
    const handlePointerDown = (event) => {
      if (!rootRef.current?.contains(event.target)) {
        setOpen(false);
        setQuery("");
      }
    };
    document.addEventListener("mousedown", handlePointerDown);
    return () => {
      clearTimeout(focusTimer);
      document.removeEventListener("mousedown", handlePointerDown);
    };
  }, [open]);

  useEffect(() => {
    if (!disabled) return;
    setOpen(false);
    setQuery("");
  }, [disabled]);

  const chooseField = (field) => {
    onSelect?.(feishuFilterFieldValue(field));
    setOpen(false);
    setQuery("");
  };

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={() => {
          if (disabled) return;
          setOpen((value) => !value);
          setQuery("");
        }}
        disabled={disabled}
        role="combobox"
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-label="选择飞书字段"
        className="flex h-9 w-full items-center justify-between gap-2 rounded border border-zinc-700 bg-zinc-900 px-2 text-left text-xs text-zinc-200 outline-none hover:border-zinc-600 focus:border-blue-500 disabled:text-zinc-600"
      >
        <span className="min-w-0 truncate">
          {selectedField.name || selectedField.key || "请选择飞书字段"}
          {selectedField.kind === "role" ? " · 角色" : ""}
        </span>
        <span aria-hidden="true" className={`shrink-0 text-[10px] text-zinc-500 transition-transform ${open ? "rotate-180" : ""}`}>▼</span>
      </button>

      {open && (
        <div className="absolute left-0 right-0 top-full z-30 mt-1 min-w-[300px] rounded border border-zinc-700 bg-zinc-950 p-2 shadow-2xl shadow-black/50">
          <input
            ref={inputRef}
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                setOpen(false);
                setQuery("");
              } else if (event.key === "Enter" && filteredFields.length === 1) {
                event.preventDefault();
                chooseField(filteredFields[0]);
              } else if (event.key === "ArrowDown") {
                event.preventDefault();
                rootRef.current?.querySelector('[role="option"]')?.focus();
              }
            }}
            aria-label="搜索飞书字段"
            placeholder="搜索字段名称 / Key / 类型"
            className="h-9 w-full rounded border border-zinc-700 bg-zinc-900 px-2.5 text-xs text-zinc-200 outline-none placeholder:text-zinc-600 focus:border-blue-500"
          />
          <div className="mt-2 flex items-center justify-between px-1 text-[10px] text-zinc-600">
            <span>{query ? `找到 ${filteredFields.length} 个字段` : `共 ${fields.length} 个字段`}</span>
            {query && (
              <button type="button" onClick={() => setQuery("")} className="hover:text-zinc-300">清空搜索</button>
            )}
          </div>
          <div role="listbox" aria-label="飞书字段选项" className="mt-1 max-h-60 overflow-auto rounded border border-zinc-800">
            {filteredFields.map((field) => {
              const value = feishuFilterFieldValue(field);
              const selected = value === selectedValue;
              return (
                <button
                  key={value}
                  type="button"
                  role="option"
                  aria-selected={selected}
                  data-feishu-field-value={value}
                  onClick={() => chooseField(field)}
                  className={`flex w-full items-center gap-2 border-b border-zinc-800/70 px-2.5 py-2 text-left last:border-b-0 ${selected ? "bg-blue-500/15 text-blue-200" : "text-zinc-300 hover:bg-zinc-900"}`}
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-xs">{field.name || field.key}</span>
                    <span className="mt-0.5 block truncate font-mono text-[10px] text-zinc-600">{field.key || "-"}{field.type ? ` · ${field.type}` : ""}</span>
                  </span>
                  <span className="shrink-0 rounded border border-zinc-700 px-1.5 py-0.5 text-[10px] text-zinc-500">{field.kind === "role" ? "角色" : "字段"}</span>
                  {selected && <span aria-hidden="true" className="shrink-0 text-blue-300">✓</span>}
                </button>
              );
            })}
            {!filteredFields.length && (
              <div className="px-3 py-7 text-center text-xs text-zinc-600">没有匹配的飞书字段</div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function feishuFilterFieldOptions(metadata = {}) {
  const raw = [
    ...(metadata?.roles || []).map((role) => ({ ...role, kind: "role" })),
    ...(metadata?.fields || []).map((field) => ({ ...field, kind: field.kind || "field" })),
    { ...DEFAULT_FEISHU_OWNER_FILTER, key: DEFAULT_FEISHU_OWNER_FILTER.fieldKey, name: DEFAULT_FEISHU_OWNER_FILTER.fieldName, kind: "role", options: DEFAULT_FEISHU_OWNER_FILTER_VALUES.map((name) => ({ label: name, value: name })) },
  ];
  const seen = new Set();
  return raw.map((field) => ({
    kind: field.kind || "field",
    key: String(field.key || field.fieldKey || field.roleId || "").trim(),
    name: String(field.name || field.fieldName || field.roleName || field.key || field.fieldKey || "").trim(),
    type: String(field.type || ""),
    options: Array.isArray(field.options) ? field.options : [],
  })).filter((field) => {
    if (!field.key && !field.name) return false;
    const key = feishuFilterFieldValue(field);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function feishuFilterFieldValue(field = {}) {
  return `${field.kind || "field"}:${field.key || field.name || ""}`;
}

function feishuFilterValueChoices(field = {}, filter = {}) {
  return filterValueChoices(field, filter, {
    ownerValues: DEFAULT_FEISHU_OWNER_FILTER_VALUES,
    isOwnerFilter: isDefaultOwnerFilter(filter),
  });
}

function toggleFilterValue(values = [], value = "") {
  const text = String(value || "").trim();
  if (!text) return values || [];
  const current = normalizeListValue(values);
  return current.includes(text) ? current.filter((item) => item !== text) : [...current, text];
}

function enabledFirstRows(list = []) {
  return (Array.isArray(list) ? list : [])
    .map((value, index) => ({ value, index }))
    .sort((a, b) => {
      const aEnabled = a.value?.enabled !== false;
      const bEnabled = b.value?.enabled !== false;
      if (aEnabled !== bEnabled) return aEnabled ? -1 : 1;
      return a.index - b.index;
    });
}

function DuplicateCheckResultPanel({ state, onSelect, onDeleteAfterMergeChange, onConfirm, onClear }) {
  const groups = state?.groups || [];
  const result = state?.result || null;
  const mergeResults = Array.isArray(result?.results) ? result.results : [];
  const selectedBySourceId = state?.selectedBySourceId || {};
  const shouldShow = !!state?.checking || !!state?.error || !!result || groups.length > 0;
  if (!shouldShow) return null;

  const missingSelection = groups.some((group) => {
    const key = duplicateDialogGroupKey(group);
    return !selectedBySourceId[key];
  });
  const mergeCompleted = mergeResults.length > 0 && !state?.error;
  const canMerge = groups.length > 0 && !state?.checking && !state?.merging && !missingSelection && !mergeCompleted;
  const inspected = Number(result?.inspected || 0);
  const total = Number(result?.total || 0);
  const skippedCount = Number(result?.skippedCount || result?.skipped?.length || 0);

  return (
    <div className="mt-3 rounded border border-amber-800/60 bg-amber-950/10 p-3">
      <div className="flex flex-wrap items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="text-xs font-medium text-amber-100">检测重复 TB 单结果</div>
          <div className="mt-1 flex flex-wrap gap-2 text-[11px] text-zinc-400">
            <span className="rounded bg-zinc-900 px-2 py-0.5">候选 {total || "-"}</span>
            <span className="rounded bg-zinc-900 px-2 py-0.5">已检查 {inspected || "-"}</span>
            <span className={`rounded px-2 py-0.5 ${groups.length ? "bg-amber-500/15 text-amber-200" : "bg-emerald-500/10 text-emerald-300"}`}>重复组 {groups.length}</span>
            {skippedCount > 0 && <span className="rounded bg-zinc-900 px-2 py-0.5">跳过 {skippedCount}</span>}
            {state?.checking && <span className="rounded bg-blue-500/10 px-2 py-0.5 text-blue-300">检测中</span>}
            {state?.merging && <span className="rounded bg-blue-500/10 px-2 py-0.5 text-blue-300">合并中</span>}
          </div>
        </div>
        <button
          type="button"
          onClick={onClear}
          disabled={state?.checking || state?.merging}
          className="rounded border border-zinc-700 bg-zinc-900 px-2.5 py-1.5 text-xs text-zinc-300 hover:bg-zinc-800 disabled:text-zinc-600"
        >
          清空结果
        </button>
      </div>

      {state?.error && (
        <div className="mt-3 rounded border border-red-800/60 bg-red-950/30 px-3 py-2 text-xs leading-relaxed text-red-200">
          {state.error}
        </div>
      )}

      {state?.checking && (
        <div className="mt-3 rounded border border-blue-800/50 bg-blue-950/20 px-3 py-2 text-xs text-blue-200">
          正在按飞书 Source ID 搜索 Teambition 任务，请稍候...
        </div>
      )}

      {!state?.checking && result && groups.length === 0 && !mergeResults.length && !state?.error && (
        <div className="mt-3 rounded border border-emerald-800/50 bg-emerald-950/20 px-3 py-2 text-xs leading-relaxed text-emerald-200">
          未发现重复 TB 单。已检查 {inspected || 0} 条候选单{skippedCount ? `，跳过 ${skippedCount} 条不在同步范围内的候选。` : "。"}
        </div>
      )}

      {groups.length > 0 && (
        <div className="mt-3 space-y-3">
          {groups.map((group, index) => {
            const key = duplicateDialogGroupKey(group);
            const selected = selectedBySourceId[key] || "";
            return (
              <div key={key || index} className="rounded border border-zinc-800 bg-zinc-950 p-3">
                <div className="flex flex-wrap items-start gap-2">
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium text-zinc-100">{group.title || group.targetTitle || "未命名飞书单"}</div>
                    <div className="mt-1 flex flex-wrap gap-2 text-[11px] text-zinc-500">
                      <code className="rounded bg-zinc-900 px-1.5 py-0.5">{group.sourceId || group.sourceWorkItemId || "-"}</code>
                      {(group.sourceProblemNo || group.problemNo || group.sourceWorkItemNo) && <span>问题编号 {group.sourceProblemNo || group.problemNo || group.sourceWorkItemNo}</span>}
                      {group.targetProjectId && <span>Project {group.targetProjectId}</span>}
                      {group.existingTargetTaskId && <span>当前同步关系 {group.existingTargetTaskId}</span>}
                    </div>
                  </div>
                  <span className="rounded bg-amber-500/15 px-2 py-1 text-[11px] text-amber-200">{group.tasks?.length || 0} 个重复单</span>
                </div>

                <div className="mt-3 grid gap-2">
                  {(group.tasks || []).map((task) => (
                    <label
                      key={task.id}
                      className={`flex cursor-pointer gap-3 rounded border px-3 py-2 text-xs ${selected === task.id ? "border-emerald-600/70 bg-emerald-950/25" : "border-zinc-800 bg-zinc-900/60 hover:bg-zinc-900"}`}
                    >
                      <input
                        type="radio"
                        name={`duplicate-inline-target-${key}`}
                        checked={selected === task.id}
                        onChange={() => onSelect(group, task.id)}
                        className="mt-1 h-4 w-4 accent-emerald-600"
                      />
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="min-w-0 truncate font-medium text-zinc-100">{task.title || task.id}</span>
                          {task.uniqueId && <span className="rounded bg-zinc-800 px-1.5 py-0.5 font-mono text-[10px] text-zinc-400">#{task.uniqueId}</span>}
                          <code className="rounded bg-zinc-950 px-1.5 py-0.5 text-[10px] text-zinc-500">{task.id}</code>
                        </div>
                        <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-zinc-500">
                          {duplicateTaskMeta(task).map((part) => <span key={part}>{part}</span>)}
                        </div>
                      </div>
                      {task.url && (
                        <a href={task.url} target="_blank" rel="noreferrer" className="self-start text-[11px] text-blue-300 hover:text-blue-200">
                          打开
                        </a>
                      )}
                    </label>
                  ))}
                </div>
              </div>
            );
          })}

          <div className="flex flex-wrap items-center gap-3 rounded border border-zinc-800 bg-zinc-950 px-3 py-2">
            <label className="flex items-center gap-2 text-xs text-zinc-300">
              <input
                type="checkbox"
                checked={state?.deleteAfterMerge === true}
                onChange={(event) => onDeleteAfterMergeChange(event.target.checked)}
                disabled={state?.merging}
                className="h-4 w-4 accent-red-600"
              />
              合并后删除未选中的重复 TB 单
            </label>
            {missingSelection && <span className="text-[11px] text-amber-300">每组都需要选择一个目标单</span>}
            <button
              type="button"
              onClick={onConfirm}
              disabled={!canMerge}
              className="ml-auto rounded bg-emerald-600 px-3 py-2 text-xs font-medium text-white hover:bg-emerald-500 disabled:bg-zinc-800 disabled:text-zinc-600"
            >
              {state?.merging ? "合并中..." : mergeCompleted ? "已完成合并" : "确认合并"}
            </button>
          </div>
        </div>
      )}

      {mergeResults.length > 0 && (
        <pre className="mt-3 max-h-44 overflow-auto rounded border border-zinc-800 bg-zinc-950 p-3 text-[11px] text-zinc-400">
          {formatPreviewForDisplay(result)}
        </pre>
      )}
    </div>
  );
}

function SyncRunLog({ events = [], run = null }) {
  const rows = (events || []).slice(-80).reverse();
  if (!rows.length && !run?.id) return null;
  return (
    <div className="mt-3 rounded border border-zinc-800 bg-zinc-950 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="text-xs font-medium text-zinc-200">实时同步日志</div>
        {run?.id && <span className="rounded bg-zinc-900 px-2 py-0.5 font-mono text-[10px] text-zinc-500">{run.id}</span>}
        {run?.status && <span className={`rounded px-2 py-0.5 text-[10px] ${run.status === "running" ? "bg-blue-500/10 text-blue-300" : run.status === "success" ? "bg-emerald-500/10 text-emerald-300" : "bg-red-500/10 text-red-300"}`}>{run.status}</span>}
      </div>
      {run?.error && (
        <div className="mt-2 rounded border border-red-800/60 bg-red-950/30 px-2.5 py-2 text-xs text-red-200">
          {run.error}
        </div>
      )}
      <div className="mt-3 max-h-72 overflow-y-auto rounded border border-zinc-900 bg-zinc-950/70">
        {rows.length ? rows.map((evt) => (
          <div key={`${evt.seq}-${evt.globalSeq || ""}`} className="grid gap-2 border-b border-zinc-900 px-3 py-2 text-[11px] last:border-b-0 md:grid-cols-[82px_92px_1fr]">
            <div className="text-zinc-500">{evt.at ? formatTime(evt.at) : ""}</div>
            <div><span className={`rounded px-2 py-0.5 ${eventTone(evt)}`}>{phaseLabel(evt.phase)}</span></div>
            <div className="min-w-0">
              <div className="truncate text-zinc-300">
                {evt.workItemId && <span className="mr-2 font-mono text-zinc-400">{evt.workItemId}</span>}
                {evt.title && <span className="mr-2">{evt.title}</span>}
                {evt.message}
              </div>
              {(evt.action || evt.targetTaskId || evt.error || evt.index) && (
                <div className="mt-1 truncate text-zinc-500">
                  {evt.index ? `第 ${evt.index}/${evt.total || "?"} 条 ` : ""}
                  {evt.action ? `动作 ${evt.action} ` : ""}
                  {evt.targetTaskId ? `TB ${evt.targetTaskId} ` : ""}
                  {evt.error ? <span className="text-red-300">错误：{evt.error}</span> : null}
                </div>
              )}
            </div>
          </div>
        )) : (
          <div className="px-3 py-3 text-xs text-zinc-500">等待同步日志...</div>
        )}
      </div>
    </div>
  );
}

function eventTone(evt = {}) {
  if (evt.level === "error" || evt.phase === "failed" || evt.phase === "stopped") return "bg-red-500/10 text-red-300";
  if (evt.phase === "success" || evt.phase === "done") return "bg-emerald-500/10 text-emerald-300";
  if (evt.phase === "skip") return "bg-amber-500/10 text-amber-300";
  return "bg-blue-500/10 text-blue-300";
}

function phaseLabel(phase = "") {
  return ({
    start: "启动",
    "capture-start": "读取",
    "items-loaded": "已读取",
    "item-queued": "排队",
    "item-start": "处理",
    "action-start": "执行",
    success: "成功",
    failed: "失败",
    stopped: "已停止",
    skip: "跳过",
    done: "完成",
    "dry-run": "预检",
  })[phase] || phase || "进度";
}

function ActionMetric({ label, value, title }) {
  return (
    <div className="min-w-0 rounded border border-zinc-800 bg-zinc-900/55 px-3 py-2">
      <div className="text-[10px] text-zinc-500">{label}</div>
      <div className="mt-1 truncate text-xs text-zinc-200" title={title || value}>{value}</div>
    </div>
  );
}

function StatusPill({ label, ok, detail, detailTitle }) {
  return (
    <div className={`min-w-0 rounded border px-3 py-2.5 ${ok ? "border-emerald-800/50 bg-emerald-950/15" : "border-amber-800/55 bg-amber-950/20"}`}>
      <div className="flex items-center gap-2">
        <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${ok ? "bg-emerald-400" : "bg-amber-400"}`} />
        <div className={`truncate text-xs font-medium ${ok ? "text-emerald-200" : "text-amber-200"}`}>{label}</div>
      </div>
      <div className="mt-1.5 truncate text-[10px] text-zinc-500" title={detailTitle || detail}>{detail}</div>
    </div>
  );
}

function FeishuRecordsRefreshResultPanel({ result }) {
  if (!result) return null;
  const view = feishuRecordsRefreshResultView(result);
  const running = view.status === "running";
  const tone = ({
    success: "border-emerald-800/55 bg-emerald-950/20 text-emerald-200",
    partial: "border-amber-800/60 bg-amber-950/20 text-amber-200",
    failed: "border-red-800/55 bg-red-950/25 text-red-200",
    running: "border-blue-800/50 bg-blue-950/20 text-blue-200",
  })[view.status] || "border-zinc-800 bg-zinc-950 text-zinc-300";
  const cleanupText = view.snapshotReconciled
    ? `完整快照：删除未同步 ${view.removedUnsynced} 条，隐藏已同步 ${view.hiddenSynced} 条`
    : "未执行完整快照清理";
  return (
    <div
      data-testid="feishu-records-refresh-result"
      data-refresh-status={view.status}
      data-refresh-log-id={view.refreshLogId}
      className={`mt-3 rounded border p-3 ${tone}`}
      aria-live="polite"
    >
      <div className="flex flex-wrap items-center gap-2">
        {running && <span className="inline-block h-3 w-3 animate-spin rounded-full border border-blue-300 border-t-transparent" />}
        <div className="text-sm font-medium">{view.title}</div>
        {!running && view.finishedAt && <span className="ml-auto text-[11px] opacity-65">{formatTime(view.finishedAt)}</span>}
      </div>
      {!running && (
        <>
          <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
            <ActionMetric label="写入本地映射" value={view.refreshed} />
            <ActionMetric label="跳过" value={view.skippedCount} />
            <ActionMetric label="来源失败" value={`${view.failedSources}/${view.sourceCount}`} />
            <ActionMetric label="快照清理" value={view.snapshotReconciled ? "已执行" : "未执行"} title={cleanupText} />
          </div>
          <div className="mt-3 rounded border border-zinc-700/50 bg-black/20 px-3 py-2 text-[11px]">
            <span className="opacity-65">刷新日志 ID：</span>
            <code className="break-all font-mono text-current">
              {view.refreshLogId || "未返回（请确认 Gateway 已更新）"}
            </code>
          </div>
          <div className="mt-2 text-[11px] opacity-70">{cleanupText}</div>
          {view.warning && (
            <div className="mt-2 rounded border border-zinc-700/50 bg-black/10 px-2.5 py-2 text-xs leading-relaxed">
              提示：{view.warning}
            </div>
          )}
          {view.error && (
            <div className="mt-2 rounded border border-zinc-700/50 bg-black/20 px-2.5 py-2 text-xs leading-relaxed">
              错误：{view.error}
            </div>
          )}
        </>
      )}
    </div>
  );
}

function SyncResultSummary({ result, data, config }) {
  const payload = result?.data || data;
  if (!result && !payload) return null;
  const mode = result?.mode || (payload?.dryRun ? "dry-run" : "run");
  const isDryRun = mode === "dry-run";
  const title = isDryRun ? "预检 dry-run" : "真实同步";
  const stillLoading = result?.status === "running" || result?.status === "settling" || (result && !payload && result?.status !== "failed");
  if (stillLoading) {
    return (
      <div className="mt-3 rounded border border-blue-800/50 bg-blue-950/20 px-3 py-2 text-xs text-blue-200">
        <span className="mr-2 inline-block h-3 w-3 animate-spin rounded-full border border-blue-300 border-t-transparent align-[-2px]" />
        {title}正在执行，请等待结果返回。
      </div>
    );
  }
  if (result?.status === "failed") {
    const warning = feishuWebProfileWarningForResult(result, payload);
    return (
      <div className="mt-3 rounded border border-red-800/50 bg-red-950/25 px-3 py-2 text-xs leading-relaxed text-red-200">
        <FeishuWebProfileWarning message={warning} compact />
        {title}失败：{result.error || "未知错误"}
      </div>
    );
  }
  const stats = getSyncResultStats(payload);
  const webProfileWarning = feishuWebProfileWarningForResult(result, payload);
  const rows = stats.results.slice(0, 6);
  const finishedAt = result?.finishedAt ? formatTime(result.finishedAt) : "";
  const displayTitle = stats.stoppedOnFirstError ? `${title}已停止` : `${title}已完成`;
  return (
    <div className="mt-3 rounded border border-zinc-800 bg-zinc-950 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className={`text-sm font-medium ${stats.failed ? "text-red-300" : "text-emerald-300"}`}>{displayTitle}</div>
        <span className="rounded bg-zinc-800 px-2 py-0.5 text-[11px] text-zinc-400">{isDryRun ? "不会写入 TB" : "已写入 TB"}</span>
        {stats.source && <span className="rounded bg-zinc-800 px-2 py-0.5 text-[11px] text-zinc-400">{stats.source}</span>}
        {finishedAt && <span className="ml-auto text-[11px] text-zinc-500">{finishedAt}</span>}
      </div>
      <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
        <ResultMetric label="总数" value={stats.total} />
        <ResultMetric label={isDryRun ? "将创建" : "已创建"} value={stats.created} tone={stats.created ? "ok" : ""} />
        <ResultMetric label={isDryRun ? "将更新" : "已更新"} value={stats.updated} tone={stats.updated ? "ok" : ""} />
        <ResultMetric label="跳过" value={stats.skipped} tone={stats.skipped ? "warn" : ""} />
        <ResultMetric label="失败" value={stats.failed} tone={stats.failed ? "bad" : ""} />
        <ResultMetric label="子项同步" value={stats.childSynced} />
      </div>
      {stats.captured !== null && (
        <div className="mt-2 text-[11px] text-zinc-500">读取到飞书候选单：{stats.captured}</div>
      )}
      <FeishuWebProfileWarning message={webProfileWarning} compact />
      {stats.stoppedOnFirstError && (
        <div className="mt-3 rounded border border-red-800/60 bg-red-950/25 px-2.5 py-2 text-xs leading-relaxed text-red-200">
          遇到第一条失败已停止，后续候选单没有继续同步。{stats.firstError ? `错误：${stats.firstError}` : ""}
        </div>
      )}
      {rows.length > 0 && (
        <div className="mt-3 overflow-x-auto">
          <table className="w-full min-w-[820px] text-left text-[11px]">
            <thead className="text-zinc-500">
              <tr className="border-b border-zinc-800">
                <th className="py-1.5 pr-3">飞书单</th>
                <th className="py-1.5 pr-3">动作</th>
                <th className="py-1.5 pr-3">目标 TB</th>
                <th className="py-1.5 pr-3">标题</th>
                <th className="py-1.5 pr-3">说明</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row, idx) => (
                <tr key={`${syncRowId(row)}-${idx}`} className="border-b border-zinc-900">
                  <td className="py-1.5 pr-3"><SourceWorkItemLink row={row} config={config} /></td>
                  <td className="py-1.5 pr-3"><span className={`rounded px-2 py-0.5 ${actionTone(row)}`}>{actionLabel(row?.action, isDryRun)}</span></td>
                  <td className="py-1.5 pr-3 font-mono"><TargetTbLink row={row} config={config} /></td>
                  <td className="max-w-xs truncate py-1.5 pr-3 text-zinc-300">{syncRowTitle(row) || "-"}</td>
                  <td className="max-w-md truncate py-1.5 pr-3 text-zinc-500" title={actionExplanation(row, isDryRun)}>{actionExplanation(row, isDryRun)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {stats.results.length > rows.length && <div className="mt-2 text-[11px] text-zinc-500">仅显示前 {rows.length} 条，完整结果见下方 JSON。</div>}
        </div>
      )}
    </div>
  );
}

function ReadableSyncResultPanel({ data, result, config, tbMembers, tbTasklists, tbSprints }) {
  const payload = result?.data || data;
  if (!payload) {
    return (
      <div className="rounded border border-dashed border-zinc-800 bg-zinc-950 px-4 py-10 text-center text-sm text-zinc-600">
        执行 dry-run 或 /run 后，这里显示每条飞书单的动作、原因和目标字段。
      </div>
    );
  }
  const stats = getSyncResultStats(payload);
  const rows = stats.results;
  const isDryRun = stats.dryRun;
  const webProfileWarning = feishuWebProfileWarningForResult(result, payload);
  const displayContext = readableTbContext(config || {}, tbMembers || {}, tbTasklists || {}, tbSprints || {});
  addReadableSyncResultContext(displayContext, rows);
  return (
    <div className="space-y-3">
      <SyncResultSummary result={result?.data === payload ? result : null} data={payload} config={config} />
      <ReadableSheetSummary stats={stats} config={config} dryRun={isDryRun} />
      <FeishuWebProfileWarning message={webProfileWarning} />
      {stats.firstError && (
        <div className="rounded border border-red-800/50 bg-red-950/25 px-3 py-2 text-xs leading-relaxed text-red-200">
          首个错误：{stats.firstError}
        </div>
      )}
      {rows.length > 0 ? (
        <div className="space-y-2">
          {rows.map((row, idx) => (
            <ReadableSyncResultRow
              key={`${syncRowDisplayId(row)}-${idx}`}
              row={row}
              index={idx}
              dryRun={isDryRun}
              config={config}
              displayContext={displayContext}
            />
          ))}
        </div>
      ) : (
        <div className="rounded border border-zinc-800 bg-zinc-950 px-4 py-8 text-center text-sm text-zinc-600">
          结果里没有可展开的单条明细；请查看“原始结果”或“原始日志”。
        </div>
      )}
    </div>
  );
}

function fieldPanelTitle(row = {}, dryRun = false) {
  if (row.action === "create") return dryRun ? "新增后将写入字段" : "新增已写入字段";
  if (row.action === "update") return dryRun ? "字段变化预览" : "字段更新摘要";
  if (row.action === "skip") return "当前规则计算出的目标字段";
  return dryRun ? "将写入字段" : "已写入字段摘要";
}

const PAYLOAD_FIELD_LABELS = {
  content: "TB 标题",
  note: "备注",
  executorId: "执行者",
  involveMembers: "参与者",
  startDate: "开始时间",
  dueDate: "截止时间",
  priority: "优先级",
  projectId: "项目归属",
  tasklistId: "项目下任务列表",
  stageId: "阶段",
  sprintId: "迭代",
  taskflowstatusId: "状态",
  scenariofieldconfigId: "TB单类型",
  applicationCategory: "\u5e94\u7528\u5206\u7c7b",
  defectCategory: "\u7f3a\u9677\u5206\u7c7b",
  tagIds: "标签",
  customfields: "自定义字段",
};

const PAYLOAD_FIELD_HINTS = {
  projectId: "对应 TB 单详情页「项目」显示的完整项目路径",
  tasklistId: "对应 TB 单详情页「项目」里的具体任务列表名称",
  sprintId: "已有 TB 单保留用户设置的迭代；新建或空值时才采用同步路由配置",
  applicationCategory: "按命中目标和策略生成；是否覆盖目标人工值由字段策略决定",
  defectCategory: "已有 TB 单保留用户设置的缺陷分类；新建或空值时默认写入功能使用BUG",
};

function payloadFieldLabel(key = "") {
  return PAYLOAD_FIELD_LABELS[key] || key || "";
}

function payloadFieldHint(key = "") {
  return PAYLOAD_FIELD_HINTS[key] || "";
}

function payloadFieldStatusMeta(status = "") {
  if (status === "write") return { label: "写入", badge: "border-emerald-800/60 bg-emerald-950/45 text-emerald-200", card: "border-emerald-900/55 bg-emerald-950/15" };
  if (status === "update") return { label: "更新", badge: "border-blue-700/60 bg-blue-950/45 text-blue-200", card: "border-blue-800/60 bg-blue-950/20" };
  if (status === "same") return { label: "不变", badge: "border-zinc-700 bg-zinc-900 text-zinc-400", card: "border-zinc-800 bg-zinc-950/40" };
  if (status === "config") return { label: "配置", badge: "border-cyan-800/60 bg-cyan-950/35 text-cyan-200", card: "border-cyan-900/50 bg-cyan-950/10" };
  if (status === "notePrevious") return { label: "旧备注", badge: "border-zinc-700 bg-zinc-900 text-zinc-300", card: "border-zinc-800 bg-zinc-950/45" };
  if (status === "noteNext") return { label: "修正后", badge: "border-blue-700/60 bg-blue-950/45 text-blue-200", card: "border-blue-800/60 bg-blue-950/20" };
  return { label: "目标", badge: "border-zinc-700 bg-zinc-900 text-zinc-300", card: "border-zinc-800 bg-zinc-950/40" };
}

function NoteTextBlock({ value, tone = "current", deleted = false }) {
  const text = String(value || "空");
  const toneClass = tone === "next"
    ? "border-blue-500/70 bg-blue-950/20 text-blue-50"
    : "border-zinc-700/80 bg-zinc-950/65 text-zinc-300";
  return (
    <div className={`max-h-72 min-w-0 overflow-auto rounded-sm border-l-2 px-3 py-2 ${toneClass}`}>
      <div className={`whitespace-pre-wrap break-words text-[11px] leading-5 ${deleted ? "text-zinc-500 line-through decoration-red-400/75 decoration-1" : ""}`}>
        {text}
      </div>
    </div>
  );
}

function PayloadNoteValue({ entry }) {
  const hasPrevious = entry.previous !== undefined && entry.previous !== null && entry.previous !== "";
  if (hasPrevious && entry.value) {
    return (
      <div className="min-w-0 space-y-2">
        <div className="min-w-0">
          <div className="mb-1 text-[10px] text-zinc-500">{entry.previousLabel || "旧 TB 备注"}</div>
          <NoteTextBlock value={entry.previous} deleted={true} />
        </div>
        <div className="flex min-w-0 items-start gap-2">
          <span className="mt-6 shrink-0 text-blue-400">→</span>
          <div className="min-w-0 flex-1">
            <div className="mb-1 text-[10px] text-blue-300">{entry.nextLabel || "修正后备注"}</div>
            <NoteTextBlock value={entry.value} tone="next" />
          </div>
        </div>
      </div>
    );
  }
  return <NoteTextBlock value={entry.value} tone={entry.status === "write" ? "next" : "current"} />;
}

function PayloadFieldValue({ entry }) {
  if (entry.valueKind === "noteBlock") {
    return <NoteTextBlock value={entry.value} tone={entry.noteTone || "current"} deleted={!!entry.deleted} />;
  }
  if (entry.key === "note") return <PayloadNoteValue entry={entry} />;
  const valueTextClass = entry.key === "note" ? "whitespace-pre-wrap" : "";
  if (entry.status === "update") {
    return (
      <div className="min-w-0 space-y-1">
        <div className={`min-w-0 break-words text-zinc-500 line-through decoration-red-400/70 ${valueTextClass}`} title={entry.previousTitle || entry.previous}>
          {entry.previous || "空"}
        </div>
        <div className="flex min-w-0 items-start gap-1.5">
          <span className="mt-0.5 text-blue-400">→</span>
          <span className={`min-w-0 break-words font-medium text-blue-100 ${valueTextClass}`} title={entry.title}>{entry.value}</span>
        </div>
      </div>
    );
  }
  if (entry.status === "same" && entry.previous) {
    return (
      <div className="min-w-0 space-y-1">
        <div className={`min-w-0 break-words text-zinc-500 ${valueTextClass}`} title={entry.previousTitle || entry.previous}>当前 TB：{entry.previous}</div>
        <div className={`min-w-0 break-words font-medium text-zinc-200 ${valueTextClass}`} title={entry.title}>保持不变：{entry.value || entry.previous}</div>
      </div>
    );
  }
  if (READABLE_CATEGORY_FIELDS.has(entry.key) && entry.previous && entry.status === "write") {
    return (
      <div className="min-w-0 space-y-1">
        <div className={`min-w-0 break-words text-zinc-500 line-through decoration-red-400/70 ${valueTextClass}`} title={entry.previousTitle || entry.previous}>
          当前 TB：{entry.previous}
        </div>
        <div className="flex min-w-0 items-start gap-1.5">
          <span className="mt-0.5 text-blue-400">→</span>
          <span className={`min-w-0 break-words font-medium text-blue-100 ${valueTextClass}`} title={entry.title}>{entry.value}</span>
        </div>
      </div>
    );
  }
  if (entry.status === "config" && entry.previous) {
    return (
      <div className="min-w-0 space-y-1">
        <div className={`min-w-0 break-words text-zinc-500 ${valueTextClass}`} title={entry.previousTitle}>当前 {entry.previous}</div>
        <div className={`min-w-0 break-words text-cyan-100 ${valueTextClass}`} title={entry.title}>{entry.value}</div>
      </div>
    );
  }
  return <span className={`min-w-0 break-words text-zinc-200 ${valueTextClass}`} title={entry.title}>{entry.value}</span>;
}

function PayloadFieldEntry({ entry }) {
  const meta = payloadFieldStatusMeta(entry.status);
  const shouldSpanFullRow = entry.key === "content" || entry.key === "note" || entry.valueKind === "noteBlock";
  return (
    <div className={`min-w-0 rounded border px-2.5 py-2 ${meta.card} ${shouldSpanFullRow ? "md:col-span-2" : ""}`}>
      <div className={`${entry.hint ? "mb-1" : "mb-1.5"} flex min-w-0 items-center gap-2`}>
        <span className="min-w-0 truncate text-zinc-500" title={entry.hint || entry.label}>{entry.label}</span>
        <span className={`ml-auto shrink-0 rounded border px-1.5 py-0.5 text-[10px] ${meta.badge}`}>{meta.label}</span>
      </div>
      {entry.hint && <div className="mb-1.5 text-[10px] leading-snug text-zinc-600">{entry.hint}</div>}
      <PayloadFieldValue entry={entry} />
    </div>
  );
}

function ReadableSyncResultRow({ row, index, dryRun, config, displayContext }) {
  const title = syncRowTitle(row);
  const target = targetTaskInfoForRow(row);
  const payloadRows = payloadEntries(row, displayContext);
  const notes = rowDetailNotes(row, displayContext);
  const explanation = actionExplanation(row, dryRun);
  const sheetAction = sheetActionForRow(row, config, dryRun);
  return (
    <div className={`rounded border bg-zinc-950 p-3 text-xs ${row.ok === false ? "border-red-800/60" : row.action === "update" ? "border-blue-800/60" : row.action === "skip" ? "border-amber-800/50" : "border-zinc-800"}`}>
      <div className="flex flex-col gap-2 md:flex-row md:items-start md:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <SourceWorkItemLink
              row={row}
              config={config}
              className="rounded bg-zinc-900 px-2 py-1 font-mono text-[11px] text-blue-200 hover:text-blue-100"
            />
            {rowBookmarks(row).map((bookmark) => <BookmarkBadge key={bookmark} label={bookmark} />)}
            <span className={`rounded px-2 py-0.5 text-[11px] ${actionTone(row)}`}>{actionLabel(row.action, dryRun)}</span>
            {row.ok === false && <span className="rounded bg-red-500/15 px-2 py-0.5 text-[11px] text-red-300">失败</span>}
          </div>
          <div className="mt-2 truncate text-sm font-medium text-zinc-100" title={title}>{title || "未返回标题"}</div>
          <div className="mt-1 leading-relaxed text-zinc-400">{explanation}</div>
        </div>
        <div className="shrink-0 rounded border border-zinc-800 bg-zinc-900/45 px-2.5 py-2 text-[11px] text-zinc-400">
          <div className="text-zinc-500">目标 TB</div>
          <div className="mt-1 max-w-[240px] truncate font-mono">
            <TargetTbLink row={row} config={config} />
          </div>
          {target.targetTaskId && target.displayId !== target.targetTaskId && (
            <div className="mt-0.5 max-w-[240px] truncate font-mono text-[10px] text-zinc-600" title={target.targetTaskId}>
              taskId {target.targetTaskId}
            </div>
          )}
        </div>
      </div>

      <ReadablePolicyDecision row={row} config={config} />

      {payloadRows.length > 0 && (
        <div className="mt-3 rounded border border-zinc-800 bg-zinc-900/40 p-2">
          <div className="mb-2 flex flex-wrap items-center gap-2 text-[11px] text-zinc-500">
            <span>{fieldPanelTitle(row, dryRun)}</span>
            {row.action === "update" && <span className="rounded bg-blue-500/10 px-1.5 py-0.5 text-blue-300">旧值 → 新值</span>}
          </div>
          <div className="grid gap-2 md:grid-cols-2">
            {payloadRows.map((entry) => <PayloadFieldEntry key={entry.key || entry.label} entry={entry} />)}
          </div>
        </div>
      )}

      <div className="mt-2 grid gap-2 lg:grid-cols-2">
        <ReadableChildActionPanel row={row} dryRun={dryRun} config={config} />
        <div className={`rounded border px-2.5 py-2 text-[11px] lg:col-span-2 ${sheetAction.tone === "ok" ? "border-cyan-800/50 bg-cyan-950/15 text-cyan-100" : "border-zinc-800 bg-zinc-900/30 text-zinc-400"}`}>
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium text-zinc-200">任务表格</span>
            <span className={`rounded px-1.5 py-0.5 text-[10px] ${sheetAction.tone === "ok" ? "bg-cyan-500/15 text-cyan-200" : "bg-zinc-800 text-zinc-400"}`}>{sheetAction.label}</span>
          </div>
          <div className="mt-1 leading-relaxed">{sheetAction.detail}</div>
          {!!sheetAction.rows?.length && (
            <div className="mt-2 grid gap-1.5">
              {sheetAction.rows.map((entry) => (
                <div key={entry.label} className="grid gap-1 rounded border border-cyan-900/40 bg-zinc-950/55 px-2 py-1.5 sm:grid-cols-[82px_minmax(0,1fr)]">
                  <div className="text-zinc-500">{entry.label}</div>
                  <div className="min-w-0 break-words text-cyan-50">{entry.value || "-"}</div>
                </div>
              ))}
            </div>
          )}
          <SheetExcelRowPreview preview={sheetAction.excelPreview} />
          {!!sheetAction.fields?.length && (
            <div className="mt-2 rounded border border-cyan-900/40 bg-zinc-950/45 p-2">
              <div className="mb-1.5 text-[10px] text-zinc-500">将写入/参与追加预览的字段</div>
              <div className="grid gap-1 sm:grid-cols-2">
                {sheetAction.fields.map((field) => (
                  <div key={field.column} className="min-w-0 rounded bg-zinc-900/80 px-2 py-1">
                    <div className="truncate text-[10px] text-zinc-500" title={field.column}>{field.column}</div>
                    <div className="mt-0.5 min-h-4 truncate text-[11px] text-zinc-200" title={field.value || ""}>
                      {field.value ? clipText(field.value, 80) : "同步时从飞书单取值"}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>

      {notes.length > 0 && (
        <div className="mt-2 space-y-1 rounded border border-zinc-800 bg-zinc-900/30 p-2 text-[11px] text-zinc-400">
          {notes.map((note, noteIdx) => <div key={`${note}-${noteIdx}`}>{note}</div>)}
        </div>
      )}
    </div>
  );
}

function ReadablePolicyDecision({ row = {}, config = {} }) {
  const decision = row.policyDecision;
  if (!decision) return null;
  const omitted = (row.strategyEffects || []).filter((effect) => effect.action === "omit").map((effect) => effect.field);
  const destination = policyTargetSummary(decision.target || {}, getPath(config, "teambition", {}));
  return (
    <div className={`mt-3 rounded border px-3 py-2 ${decision.matched ? "border-cyan-800/50 bg-cyan-950/15" : "border-amber-800/40 bg-amber-950/15"}`}>
      <div className="flex flex-wrap items-center gap-2 text-[11px]">
        <span className={`rounded px-1.5 py-0.5 ${decision.matched ? "bg-cyan-500/15 text-cyan-200" : "bg-amber-500/15 text-amber-200"}`}>
          {decision.matched ? "规则命中" : "默认路由"}
        </span>
        <span className="font-medium text-zinc-200">{decision.matched ? policyEntityDisplayName(decision.matchedRule, "未命名规则") : "未命中特定规则"}</span>
        {decision.matchedRule?.priority !== undefined && <span className="text-zinc-500">优先级 {decision.matchedRule.priority}</span>}
        <span className="ml-auto text-zinc-500">{policyEntityDisplayName(decision.target, "未命名目标档案")} · {policyEntityDisplayName(decision.strategy, "未命名同步策略")}</span>
      </div>
      <div className="mt-1.5 grid gap-1 text-[10px] text-zinc-500 sm:grid-cols-2">
        <div>目标：{destination.projectName} / {destination.tasklistName} / {destination.sprintName}</div>
        <div>{omitted.length ? `本次策略保留：${omitted.join("、")}` : "本次策略按配置同步全部启用字段"}</div>
      </div>
    </div>
  );
}

function SheetExcelRowPreview({ preview }) {
  if (!preview?.columns?.length) return null;
  const changed = preview.changedColumns instanceof Set ? preview.changedColumns : new Set(preview.changedColumns || []);
  const rowLabel = preview.hasOldRow ? (preview.hasUpdate ? "更新后" : "当前规则") : "将追加";
  return (
    <div className="mt-2 rounded border border-cyan-900/40 bg-zinc-950/45 p-2">
      <div className="mb-1.5 flex flex-wrap items-center gap-2">
        <span className="text-[10px] font-medium text-zinc-400">表格行预览</span>
        {preview.hasOldRow
          ? <span className={`rounded px-1.5 py-0.5 text-[10px] ${preview.hasUpdate ? "bg-blue-500/15 text-blue-200" : "bg-zinc-800 text-zinc-400"}`}>{preview.hasUpdate ? "有变化" : "不变"}</span>
          : <span className="rounded bg-emerald-500/15 px-1.5 py-0.5 text-[10px] text-emerald-200">未找到旧行，预计追加</span>}
      </div>
      <div className="overflow-x-auto rounded border border-zinc-800">
        <table className="min-w-max border-collapse text-left text-[11px]">
          <thead>
            <tr className="bg-zinc-900 text-zinc-500">
              <th className="sticky left-0 z-10 min-w-20 border-r border-zinc-800 bg-zinc-900 px-2 py-1.5">行</th>
              {preview.columns.map((column) => (
                <th key={column} className="min-w-28 max-w-56 border-r border-zinc-800 px-2 py-1.5 font-medium last:border-r-0" title={column}>
                  <span className="block truncate">{column}</span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {preview.hasOldRow && (
              <tr className={preview.hasUpdate ? "text-zinc-500 line-through decoration-red-400/80 decoration-1" : "text-zinc-400"}>
                <td className="sticky left-0 z-10 border-r border-t border-zinc-800 bg-zinc-950 px-2 py-1.5 font-medium">旧行</td>
                {preview.columns.map((column) => (
                  <td key={column} className={`max-w-56 border-r border-t border-zinc-800 px-2 py-1.5 last:border-r-0 ${changed.has(column) ? "bg-red-950/15" : ""}`} title={sheetCellText(preview.oldRow?.[column])}>
                    <span className={`block truncate ${preview.hasUpdate ? "line-through decoration-red-400/80 decoration-1" : ""}`}>{sheetCellText(preview.oldRow?.[column]) || "-"}</span>
                  </td>
                ))}
              </tr>
            )}
            <tr className="text-cyan-50">
              <td className="sticky left-0 z-10 border-r border-t border-zinc-800 bg-zinc-950 px-2 py-1.5 font-medium">{rowLabel}</td>
              {preview.columns.map((column) => (
                <td key={column} className={`max-w-56 border-r border-t border-zinc-800 px-2 py-1.5 last:border-r-0 ${changed.has(column) ? "bg-yellow-400/15 text-yellow-100" : ""}`} title={sheetCellText(preview.nextRow?.[column])}>
                  <span className="block truncate">{sheetCellText(preview.nextRow?.[column]) || "-"}</span>
                </td>
              ))}
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  );
}

function ReadableChildActionPanel({ row, dryRun, config }) {
  const comments = childActionRows(row, "comments");
  const attachments = childActionRows(row, "attachments");
  const targetComments = targetCommentRows(row);
  const sourceComments = sourceCommentRows(row);
  const totalComments = row.item?.comments?.length || 0;
  const totalAttachments = row.item?.attachments?.length || 0;
  if (!comments.length && !attachments.length && !totalComments && !totalAttachments && !targetComments.length) return null;
  const pendingComments = comments.filter((item) => childRowNeedsRemoteSync(item)).length;
  const existingComments = comments.filter((item) => String(item.status || "").toLowerCase() === "target-existing").length;
  const commentText = pendingComments
    ? `${pendingComments}/${totalComments || pendingComments} 条${dryRun ? "将同步" : "待同步"}`
    : existingComments
      ? `${existingComments} 条 TB 已存在`
      : totalComments ? `${totalComments} 条，本次无动作` : "无";
  const attachmentText = attachments.length
    ? `${attachments.length}/${totalAttachments || attachments.length} 个${dryRun ? "将同步" : "待同步"}`
    : totalAttachments ? `${totalAttachments} 个，本次无动作` : "无";
  return (
    <>
      {(targetComments.length || sourceComments.length || comments.length || totalComments) && (
        <div className="rounded border border-zinc-800 bg-zinc-900/30 px-2.5 py-2 text-[11px] text-zinc-400">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium text-zinc-200">评论</span>
            <span className="rounded bg-zinc-800 px-1.5 py-0.5 text-[10px] text-zinc-400">旧 TB {targetComments.length || "未返回"} 条</span>
            <span className="rounded bg-zinc-800 px-1.5 py-0.5 text-[10px] text-zinc-400">飞书 {totalComments || sourceComments.length || 0} 条</span>
            <span className={`rounded px-1.5 py-0.5 text-[10px] ${pendingComments ? "bg-blue-500/15 text-blue-200" : existingComments ? "bg-emerald-500/15 text-emerald-200" : "bg-zinc-800 text-zinc-400"}`}>
              {commentText}
            </span>
          </div>
          {row.childPlan?.targetCommentRead?.ok === false && row.childPlan.targetCommentRead.attempted && (
            <div className="mt-1 text-[10px] text-amber-300">TB 旧评论读取失败：{row.childPlan.targetCommentRead.error || row.childPlan.targetCommentRead.reason || "未知原因"}</div>
          )}
          <div className="mt-2 grid gap-2 md:grid-cols-2">
            <CommentPreviewList title="旧 TB 评论" rows={targetComments} empty={row.childPlan?.targetCommentRead?.attempted ? "TB 当前无评论" : "未读取 TB 评论"} tone="old" dryRun={dryRun} />
            <CommentPreviewList title={dryRun ? "更新后飞书评论" : "飞书评论"} rows={sourceComments} empty="飞书未返回评论" tone="next" dryRun={dryRun} />
          </div>
          <ChildActionList title="评论动作" rows={comments} empty={totalComments ? "本次不需要同步评论" : ""} dryRun={dryRun} />
        </div>
      )}
      {(attachments.length || totalAttachments) && (
        <div className="rounded border border-zinc-800 bg-zinc-900/30 px-2.5 py-2 text-[11px] text-zinc-400">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium text-zinc-200">附件</span>
            <span className="rounded bg-zinc-800 px-1.5 py-0.5 text-[10px] text-zinc-400">{attachmentText}</span>
          </div>
          {attachments.length > 0 && (
            <div className="mt-1 text-[10px] text-zinc-500">附件策略：{describeAttachmentMode(getPath(config || {}, "sync.attachmentMode", "upload"))}</div>
          )}
          <ChildActionList title="附件动作" rows={attachments} empty={totalAttachments ? "本次不需要同步附件" : ""} dryRun={dryRun} />
        </div>
      )}
    </>
  );
}

function CommentPreviewList({ title, rows, empty, tone = "old", dryRun = false }) {
  const shown = rows.slice(0, 3);
  const omitted = rows.length - shown.length;
  const toneClass = tone === "next" ? "border-blue-900/50 bg-blue-950/10" : "border-zinc-800 bg-zinc-950/45";
  return (
    <div className={`min-w-0 rounded border px-2 py-2 ${toneClass}`}>
      <div className="mb-1.5 text-[10px] font-medium text-zinc-400">{title}</div>
      {shown.length ? (
        <div className="space-y-1.5">
          {shown.map((comment) => (
            <div key={comment.id} className="min-w-0 rounded bg-zinc-950/60 px-2 py-1.5">
              <div className="mb-1 flex min-w-0 flex-wrap items-center gap-1.5">
                <span className="max-w-[180px] truncate text-[10px] text-zinc-500" title={comment.author || comment.id}>{comment.author || "unknown"}</span>
                {comment.createdAt && <span className="text-[10px] text-zinc-600">{formatTime(comment.createdAt)}</span>}
                {comment.status && <span className={`rounded px-1.5 py-0.5 text-[10px] ${childStatusClass(comment.status)}`}>{childStatusLabel(comment.status, dryRun)}</span>}
              </div>
              <div className="max-h-28 overflow-auto whitespace-pre-wrap break-words text-[11px] leading-relaxed text-zinc-300">{comment.content || "空"}</div>
            </div>
          ))}
          {omitted > 0 && <div className="text-[10px] text-zinc-500">还有 {omitted} 条未展开</div>}
        </div>
      ) : (
        <div className="rounded bg-zinc-950/45 px-2 py-3 text-center text-[10px] text-zinc-600">{empty}</div>
      )}
    </div>
  );
}

function targetCommentRows(row = {}) {
  return (Array.isArray(row.childPlan?.targetComments) ? row.childPlan.targetComments : []).map((comment, index) => ({
    id: String(comment?.id || `target-comment-${index}`),
    author: commentAuthorText(comment),
    content: comment.content || comment.text || comment.body || "",
    createdAt: comment.createdAt || comment.created_at || "",
    status: "",
  }));
}

function sourceCommentRows(row = {}) {
  const planById = new Map((Array.isArray(row.childPlan?.comments) ? row.childPlan.comments : []).map((plan) => [String(plan?.id || "").trim(), plan]));
  return (Array.isArray(row.item?.comments) ? row.item.comments : []).map((comment, index) => {
    const id = String(comment?.id || comment?.comment_id || `source-comment-${index}`).trim();
    const plan = planById.get(id);
    return {
      id,
      author: commentAuthorText(comment),
      content: comment.content || comment.text || comment.body || "",
      createdAt: comment.createdAt || comment.created_at || "",
      status: plan?.status || "success",
    };
  });
}

function commentAuthorText(comment = {}) {
  const author = comment.author || comment.creator || comment.user || {};
  if (typeof author === "string") return author;
  return author.name || author.email || author.userKey || author.displayName || comment.authorName || "";
}

function childRowNeedsRemoteSync(row = {}) {
  const status = String(row.status || "").toLowerCase();
  return !["success", "target-existing", "duplicate", "already-exists"].includes(status);
}

function ChildActionList({ title, rows, empty, dryRun }) {
  if (!rows.length) {
    return empty ? <div className="mt-1 text-[10px] text-zinc-500">{empty}</div> : null;
  }
  const shown = rows.slice(0, 3);
  const omitted = rows.length - shown.length;
  return (
    <div className="mt-2 space-y-1">
      <div className="text-[10px] text-zinc-500">{title}</div>
      {shown.map((item) => (
        <div key={`${item.id}-${item.status}`} className="flex min-w-0 items-start gap-2">
          <span className={`mt-0.5 shrink-0 rounded px-1.5 py-0.5 text-[10px] ${childStatusClass(item.status)}`}>
            {childStatusLabel(item.status, dryRun)}
          </span>
          <span className="min-w-0 break-words text-zinc-300" title={item.id}>{item.text}</span>
        </div>
      ))}
      {omitted > 0 && <div className="text-[10px] text-zinc-500">还有 {omitted} 条未展开</div>}
    </div>
  );
}

function childActionRows(row = {}, type = "comments") {
  const sourceRows = Array.isArray(row.item?.[type]) ? row.item[type] : [];
  const byId = new Map(sourceRows.map((item) => [String(item?.id || item?.comment_id || item?.file_id || "").trim(), item]));
  const planRows = Array.isArray(row.childPlan?.[type]) ? row.childPlan[type] : [];
  return planRows.map((plan, index) => {
    const id = String(plan?.id || "").trim();
    const source = byId.get(id) || {};
    return {
      id: id || `${type}-${index}`,
      status: plan?.status || "",
      text: type === "attachments" ? attachmentActionText(source, id) : commentActionText(source, id),
    };
  });
}

function commentActionText(comment = {}, id = "") {
  const author = comment.author?.name || comment.author?.email || comment.author?.userKey || comment.authorName || "";
  const content = clipText(comment.content || comment.text || comment.body || "", 90);
  return [author, content].filter(Boolean).join("：") || id || "未命名评论";
}

function attachmentActionText(attachment = {}, id = "") {
  const name = attachment.fileName || attachment.name || attachment.title || attachment.file_id || id || "未命名附件";
  const size = attachment.fileSize || attachment.size || "";
  return [name, size ? `${size} bytes` : ""].filter(Boolean).join(" · ");
}

function childStatusLabel(status = "", dryRun = false) {
  const text = String(status || "").toLowerCase();
  if (["missing", "target-missing", "pending"].includes(text)) return dryRun ? "将同步" : "待同步";
  if (text === "failed") return dryRun ? "将重试" : "待重试";
  if (text === "target-existing") return "TB 已存在";
  if (text === "success") return "已同步";
  return dryRun ? "将检查" : "待检查";
}

function childStatusClass(status = "") {
  const text = String(status || "").toLowerCase();
  if (["missing", "target-missing", "pending"].includes(text)) return "bg-blue-500/15 text-blue-200";
  if (text === "failed") return "bg-amber-500/15 text-amber-200";
  if (text === "target-existing" || text === "success") return "bg-emerald-500/15 text-emerald-200";
  return "bg-zinc-800 text-zinc-400";
}

function sheetSyncEnabled(config = {}) {
  const value = getPath(config || {}, "sheetSync.enabled", getPath(config || {}, "feishu.sheetSync.enabled", true));
  return value !== false && String(value).toLowerCase() !== "false";
}

const DEFAULT_TASK_SHEET_COLUMNS_FOR_UI = [
  "序号",
  "系统单号",
  "钉钉单号",
  "问题地址",
  "应用",
  "测试类型",
  "问题等级",
  "提单时间",
  "问题",
  "开发",
  "状态",
  "必解标签",
  "处理方",
  "结论",
  "可走单时间",
  "发版时间",
  "同步人",
];

function taskSheetColumnsForUi(config = {}) {
  const columns = getPath(config || {}, "sheetSync.columns", getPath(config || {}, "feishu.sheetSync.columns", []));
  const list = Array.isArray(columns) && columns.length ? columns : DEFAULT_TASK_SHEET_COLUMNS_FOR_UI;
  return list.map((column) => String(column || "").trim()).filter(Boolean);
}

function taskSheetKeyColumnForUi(config = {}) {
  return String(getPath(config || {}, "sheetSync.keyColumn", getPath(config || {}, "feishu.sheetSync.keyColumn", "系统单号")) || "系统单号").trim();
}

function sheetSourceNoForRow(row = {}) {
  return syncRowProblemNo(row) || String(
    row.sourceWorkItemNo
    || row.sourceProblemNo
    || row.problemNo
    || row.item?.sourceWorkItemNo
    || row.item?.sourceProblemNo
    || row.item?.problemNo
    || "",
  ).trim();
}

function normalizeTaskSheetColumnName(column = "") {
  return String(column || "").replace(/\s+/g, "").trim().toLowerCase();
}

function sourceItemFieldDisplay(item = {}, names = []) {
  const wanted = names.map((name) => String(name || "").trim().toLowerCase()).filter(Boolean);
  const rootValue = firstKnownObjectValue(item, names);
  if (rootValue !== undefined && rootValue !== null && rootValue !== "") return compactSheetDisplayValue(rootValue);
  for (const field of item.fields || []) {
    const key = String(field?.key || field?.field_key || "").trim().toLowerCase();
    const name = String(field?.name || field?.field_name || "").trim().toLowerCase();
    if (!wanted.includes(key) && !wanted.includes(name)) continue;
    const value = firstKnownObjectValue(field, ["displayValue", "display_value", "label", "name", "text", "value", "values"]);
    const display = compactSheetDisplayValue(value);
    if (display) return display;
  }
  return "";
}

function compactSheetDisplayValue(value) {
  if (value === undefined || value === null) return "";
  if (Array.isArray(value)) return value.map(compactSheetDisplayValue).filter(Boolean).join("、");
  if (typeof value === "object") {
    const direct = firstKnownObjectValue(value, ["displayValue", "display_value", "label", "name", "title", "text", "value"]);
    if (direct !== undefined && direct !== value) return compactSheetDisplayValue(direct);
    return "";
  }
  return String(value || "").trim();
}

function sheetPeopleDisplay(people = []) {
  return (Array.isArray(people) ? people : []).map((person) => person?.name || person?.email || person?.userKey || person?.id).filter(Boolean).join("、");
}

function sheetProblemNamePreview(row = {}, sourceNo = "") {
  const rawTitle = syncRowTitle(row);
  const title = stripLeadingSheetSourceNo(rawTitle, sourceNo);
  return `【缺陷转载-8678】【阿维塔】${sourceNo || ""}${title || ""}`;
}

function stripLeadingSheetSourceNo(title = "", sourceNo = "") {
  const text = String(title || "").trim();
  const no = String(sourceNo || "").trim();
  if (!text || !no) return text;
  const escaped = no.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return text.replace(new RegExp(`^${escaped}\\s*[-_：:、]?\\s*`, "i"), "").trim();
}

function formatSheetDatePreview(value) {
  if (!value) return "";
  const date = new Date(value);
  if (!Number.isNaN(date.getTime())) return `${date.getMonth() + 1}月${date.getDate()}日`;
  return String(value || "").trim();
}

function sheetLabeledText(label, value) {
  const text = String(value || "").trim();
  if (!text) return "";
  return new RegExp(`^${label}\\s*[：:]`).test(text) ? text : `${label}：${text}`;
}

function sheetConclusionPreview(item = {}) {
  const direct = sourceItemFieldDisplay(item, ["结论", "处理结论"]);
  if (direct) return direct;
  const cause = sourceItemFieldDisplay(item, ["原因", "根本原因", "问题原因", "field_52333f"]);
  const solution = sourceItemFieldDisplay(item, ["解决方案", "解决措施", "field_98c2a6"]);
  const improvement = sourceItemFieldDisplay(item, ["整改措施", "field_f73e06"]);
  return [
    sheetLabeledText("原因", cause),
    sheetLabeledText("解决方案", solution),
    sheetLabeledText("整改措施", improvement),
  ].filter(Boolean).join("\n");
}

function sheetColumnPreviewValue(row = {}, config = {}, column = "", sourceNo = "") {
  const item = row.item || {};
  const normalized = normalizeTaskSheetColumnName(column);
  const target = targetTaskInfoForRow(row);
  if (normalized.includes("系统单号") || normalized.includes("飞书问题编号")) return sourceNo;
  if (normalized.includes("问题地址") || normalized.includes("飞书链接")) return sourceWorkItemUrlForRow(row, config);
  if (normalized.includes("测试机构")) return sourceItemFieldDisplay(item, ["测试机构", "测试团队", "机构"]);
  if (normalized.includes("测试类型") || normalized.includes("测试类别")) return sourceItemFieldDisplay(item, ["测试类型", "测试类别", "类型"]);
  if (normalized.includes("问题等级") || normalized.includes("优先级") || normalized.includes("严重程度")) {
    return compactSheetDisplayValue(item.severity || item.priority || sourceItemFieldDisplay(item, ["问题等级", "严重程度", "优先级"]));
  }
  if (normalized.includes("提单时间") || normalized === "时间") return formatSheetDatePreview(item.createdAt || item.created_at || item.createTime || item.create_time);
  if (normalized.includes("提单人") || normalized.includes("报告人")) {
    return compactSheetDisplayValue(item.reporter?.name || item.reporter?.email || sourceItemFieldDisplay(item, ["提单人", "报告人", "创建人", "Reporter"]));
  }
  if (normalized.includes("问题名称") || normalized === "问题") return sheetProblemNamePreview(row, sourceNo);
  if (normalized.includes("开发")) {
    return sourceItemFieldDisplay(item, ["开发", "开发人员", "开发负责人", "问题责任人（角色）", "问题责任人", "role_bd6222", "当前负责人", "current_status_operator", "负责人"]) || sheetPeopleDisplay(item.assignees);
  }
  if (normalized.includes("状态")) return compactSheetDisplayValue(item.status || sourceItemFieldDisplay(item, ["状态", "work_item_status"]));
  if (normalized.includes("必解标签") || normalized === "必解" || normalized === "标签") return sourceItemFieldDisplay(item, ["必解标签", "必解", "标签"]);
  if (normalized.includes("处理方")) return sourceItemFieldDisplay(item, ["处理方", "责任部门", "所属部门", "field_3ec280"]);
  if (normalized.includes("结论")) return sheetConclusionPreview(item);
  if (normalized.includes("可走单时间") || normalized.includes("走单时间") || normalized.includes("可提测时间")) {
    return formatSheetDatePreview(sourceItemFieldDisplay(item, ["可走单时间", "走单时间", "可提测时间"]));
  }
  if (normalized.includes("发版时间") || normalized.includes("发布时间") || normalized.includes("发布版本时间")) {
    return formatSheetDatePreview(sourceItemFieldDisplay(item, ["发版时间", "发布时间", "发布版本时间"]));
  }
  if (normalized.includes("同步人")) return compactSheetDisplayValue(row.syncedBy || row.syncUser || row.operator || sourceItemFieldDisplay(item, ["同步人"]));
  if (normalized.includes("钉钉单号") || normalized.includes("tb单号")) return target.displayId && target.displayId !== "-" ? target.displayId : "";
  if (normalized.includes("tb任务id") || normalized.includes("任务id")) return target.targetTaskId;
  if (normalized.includes("应用")) return sourceItemFieldDisplay(item, ["应用", "功能模块", "所属应用", "模块", "field_95a8a4"]);
  return "";
}

function sheetTargetOldRowForResult(row = {}) {
  const oldRow = row.sheetTargetRow
    || row.sheet_target_row
    || row.existing?.sheetTargetRow
    || row.existing?.sheet_target_row
    || row.sheetTargetPreview?.row
    || row.sheet_target_preview?.row
    || null;
  return oldRow && typeof oldRow === "object" && !Array.isArray(oldRow) ? oldRow : null;
}

function sheetTargetColumnsForResult(row = {}, config = {}, oldRow = null, fallbackColumns = []) {
  const explicit = [
    row.sheetTargetColumns,
    row.sheet_target_columns,
    row.existing?.sheetTargetColumns,
    row.existing?.sheet_target_columns,
  ].find((value) => Array.isArray(value) && value.length) || [];
  return Array.from(new Set([
    ...explicit,
    ...Object.keys(oldRow || {}),
    ...fallbackColumns,
    ...taskSheetColumnsForUi(config),
  ].map((column) => String(column || "").trim()).filter(Boolean)));
}

function sheetCellText(value) {
  return String(value ?? "").trim();
}

function buildSheetRowPreview(row = {}, config = {}, columns = [], sourceNo = "", oldRow = null) {
  const out = {};
  for (const column of columns) {
    const computed = sheetColumnPreviewValue(row, config, column, sourceNo);
    const oldValue = oldRow && Object.prototype.hasOwnProperty.call(oldRow, column) ? oldRow[column] : "";
    out[column] = computed !== "" ? computed : String(oldValue ?? "");
  }
  return out;
}

function sheetChangedColumns(oldRow = null, nextRow = {}, columns = []) {
  if (!oldRow) return new Set();
  return new Set(columns.filter((column) => sheetCellText(oldRow[column]) !== sheetCellText(nextRow[column])));
}

function sheetExcelPreviewForRow(row = {}, config = {}, fallbackColumns = [], sourceNo = "") {
  const oldRow = sheetTargetOldRowForResult(row);
  const columns = sheetTargetColumnsForResult(row, config, oldRow, fallbackColumns);
  if (!columns.length) return null;
  const nextRow = buildSheetRowPreview(row, config, columns, sourceNo, oldRow);
  const changedColumns = sheetChangedColumns(oldRow, nextRow, columns);
  return {
    columns,
    oldRow,
    nextRow,
    hasOldRow: !!oldRow,
    hasUpdate: !!oldRow && changedColumns.size > 0,
    changedColumns,
  };
}

function sheetActionForRow(row = {}, config = {}, dryRun = false) {
  if (!sheetSyncEnabled(config)) {
    return { label: "不处理", detail: "任务表格同步已关闭。", tone: "" };
  }
  if (row.ok === false) {
    return { label: "不处理", detail: "当前飞书单同步失败，不会进入任务表格更新。", tone: "" };
  }
  if (["create", "update", "sync-children"].includes(row.action)) {
    const sourceNo = sheetSourceNoForRow(row);
    const target = targetTaskInfoForRow(row);
    const keyColumn = taskSheetKeyColumnForUi(config);
    const columns = taskSheetColumnsForUi(config);
    const excelPreview = sheetExcelPreviewForRow(row, config, columns, sourceNo);
    const previewFields = columns.map((column) => ({
      column,
      value: sheetColumnPreviewValue(row, config, column, sourceNo),
    }));
    const targetLabel = target.displayId && target.displayId !== "-" ? target.displayId : "";
    return {
      label: dryRun ? "将生成追加清单" : "可生成追加清单",
      detail: dryRun
        ? "dry-run 不写入任务表格；真实同步成功后，点击“更新任务表格”会先读在线表格，再按系统单号决定追加或跳过。"
        : "同步已完成；点击“更新任务表格”会读取在线表格，生成可确认的追加清单。",
      tone: "ok",
      rows: [
        { label: "去重/查找键", value: sourceNo ? `${keyColumn} = ${sourceNo}` : `${keyColumn} 未识别，生成追加清单时会跳过` },
        targetLabel ? { label: "关联 TB", value: [targetLabel, target.targetTaskId && target.targetTaskId !== targetLabel ? `taskId ${target.targetTaskId}` : ""].filter(Boolean).join(" · ") } : null,
        { label: "表格动作", value: sourceNo ? `读取任务表格；没有同 ${keyColumn} 时追加 1 行，已存在时跳过重复追加。` : "缺少系统单号时不会追加，避免写入无法去重的表格行。" },
        { label: "执行时机", value: dryRun ? "本次只展示预估；真实同步成功后才会进入“更新任务表格”的确认流程。" : "需要在下方确认追加后才会写入飞书在线表格。" },
      ].filter(Boolean),
      fields: previewFields,
      excelPreview,
    };
  }
  return {
    label: "不更新",
    detail: "本次没有 TB 主任务写入动作，任务表格不需要新增或补齐这一行。",
    tone: "",
  };
}

function ReadableSheetSummary({ stats, config, dryRun }) {
  if (!stats?.results?.length) return null;
  const enabled = sheetSyncEnabled(config);
  const candidates = stats.results.filter((row) => sheetActionForRow(row, config, dryRun).tone === "ok").length;
  const skipped = Math.max(0, stats.results.length - candidates);
  const url = taskSheetUrl(config || {});
  const keyColumn = taskSheetKeyColumnForUi(config);
  const columns = taskSheetColumnsForUi(config);
  return (
    <div className={`rounded border px-3 py-2 text-xs leading-relaxed ${enabled ? "border-cyan-800/50 bg-cyan-950/15 text-cyan-100" : "border-zinc-800 bg-zinc-950 text-zinc-500"}`}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium text-zinc-100">任务表格动作</span>
        <span className="rounded bg-cyan-500/15 px-2 py-0.5 text-[11px] text-cyan-200">{candidates} 条候选</span>
        {skipped > 0 && <span className="rounded bg-zinc-800 px-2 py-0.5 text-[11px] text-zinc-400">{skipped} 条不处理</span>}
        {enabled && <span className="rounded bg-zinc-900 px-2 py-0.5 text-[11px] text-zinc-400">去重键：{keyColumn}</span>}
        {url && <a href={url} target="_blank" rel="noreferrer" className="ml-auto text-blue-300 hover:text-blue-200">打开表格</a>}
      </div>
      <div className="mt-1 text-[11px] text-zinc-400">
        {enabled
          ? (dryRun ? "这是 dry-run 预估，不会写表；真实同步成功后点击“更新任务表格”，按系统单号去重，缺失时追加，已存在时跳过。" : "真实同步结果可用于生成任务表格追加清单。")
          : "任务表格同步已关闭。"}
      </div>
      {enabled && <div className="mt-1 text-[11px] text-zinc-500">写入字段：{columns.join("、")}</div>}
    </div>
  );
}

function ResultMetric({ label, value, tone = "" }) {
  const cls = tone === "ok" ? "text-emerald-300" : tone === "warn" ? "text-amber-300" : tone === "bad" ? "text-red-300" : "text-zinc-100";
  return (
    <div className="rounded border border-zinc-800 bg-zinc-900 px-2.5 py-2">
      <div className={`text-lg font-semibold ${cls}`}>{value}</div>
      <div className="text-[11px] text-zinc-500">{label}</div>
    </div>
  );
}

function syncRowId(row) {
  return row?.item?.sourceWorkItemId || row?.item?.id || row?.sourceWorkItemId || row?.id || "-";
}

function actionLabel(action, dryRun = false) {
  if (action === "create") return dryRun ? "将创建" : "创建";
  if (action === "update") return dryRun ? "将更新" : "更新";
  if (action === "sync-children") return "同步子项";
  if (action === "skip") return "跳过";
  return action || "-";
}

function actionTone(row) {
  if (row?.ok === false) return "bg-red-500/15 text-red-300";
  if (row?.action === "create") return "bg-emerald-500/15 text-emerald-300";
  if (row?.action === "update") return "bg-blue-500/15 text-blue-300";
  if (row?.action === "skip") return "bg-amber-500/15 text-amber-300";
  return "bg-zinc-800 text-zinc-300";
}

function rowBookmarks(row = {}) {
  const bookmarks = Array.isArray(row.bookmarks) ? row.bookmarks : [];
  const out = [...bookmarks];
  if ((row.scopeStatus?.transitioned || row.scopeStatus?.state === "transferred") && !out.includes("已流转")) out.push("已流转");
  return Array.from(new Set(out.filter(Boolean)));
}

function BookmarkBadge({ label }) {
  return <span className="rounded border border-amber-500/40 bg-amber-500/15 px-2 py-0.5 text-[11px] text-amber-200">{label}</span>;
}

function problemNoFromText(text = "") {
  const match = String(text || "").match(/\b[A-Z][A-Z0-9]+-\d{2,}\b/i);
  return match ? match[0].toUpperCase() : "";
}

function feishuWebProfileWarningForText(text = "") {
  const raw = String(text || "");
  if (!raw) return "";
  if (/租户不合法|Feishu web detail fetch|Feishu web capture|needLogin|project\.feishu\.cn|Puppeteer|profile|tenant|10024/i.test(raw)) {
    return FEISHU_WEB_PROFILE_WARNING;
  }
  return "";
}

function feishuWebProfileWarningForResult(result = null, payload = null, feishuWeb = null) {
  const data = payload || result?.data || result?.run?.result || {};
  const detailResponses = data?.captured?.source?.detailResponses || data?.source?.detailResponses || [];
  const detailText = Array.isArray(detailResponses)
    ? detailResponses.map((item) => `${item?.code || ""} ${item?.error || ""}`).join(" ")
    : "";
  const text = [
    result?.error,
    result?.data?.firstError,
    data?.firstError,
    data?.error,
    data?.captured?.error,
    detailText,
    feishuWeb?.reason,
    feishuWeb?.error,
  ].filter(Boolean).join("\n");
  if (data?.needLogin) return FEISHU_WEB_PROFILE_WARNING;
  if (feishuWebProfileWarningForText(text)) return FEISHU_WEB_PROFILE_WARNING;
  if (isFeishuWebSource(data?.source) && data?.ok === false) return FEISHU_WEB_PROFILE_WARNING;
  return "";
}

function FeishuWebProfileWarning({ message = FEISHU_WEB_PROFILE_WARNING, compact = false }) {
  if (!message) return null;
  return (
    <div className={`rounded border border-amber-500/70 bg-amber-500/15 text-amber-100 shadow-[0_0_0_1px_rgba(245,158,11,0.12)] ${compact ? "px-3 py-2 text-[11px]" : "px-4 py-3 text-xs"}`}>
      <div className="font-medium text-amber-200">飞书网页登录态异常</div>
      <div className="mt-1 leading-relaxed">{message}</div>
    </div>
  );
}

function syncRowTitle(row = {}) {
  return row?.item?.title || row?.title || row?.item?.name || row?.item?.work_item_name || "";
}

function syncRowProblemNo(row = {}) {
  const item = row.item || {};
  return [
    row.sourceProblemNo,
    row.sourceWorkItemNo,
    row.problemNo,
    item.sourceProblemNo,
    item.sourceWorkItemNo,
    item.problemNo,
    item.sourceWorkItemNo,
    row.title,
    item.title,
    item.name,
    row.id,
  ].map(problemNoFromText).find(Boolean) || "";
}

function syncRowDisplayId(row = {}) {
  return syncRowProblemNo(row) || syncRowId(row);
}

function targetIdForRow(row = {}) {
  return targetTaskInfoForRow(row).targetTaskId;
}

function actionExplanation(row = {}, dryRun = false) {
  if (row.ok === false) return row.error || "同步失败，原始错误见日志或原始结果。";
  if (row.scopeStatus?.transitioned || row.scopeStatus?.state === "transferred") return row.scopeStatus.message || "已流转：飞书工单当前不满足同步范围，保留既有 TB 映射，不再继续写入。";
  if (row.reason) return friendlyReason(row.reason);
  if (row.action === "skip") {
    if (row.childPlan?.needsSync) return "TB 主任务不需要更新，仅有评论或附件等子项需要检查。";
    return "已存在同步关系，飞书内容与目标 TB 记录没有需要写入的变化，因此跳过创建/更新。";
  }
  if (row.action === "update") {
    if (row.targetFieldVerification?.mismatch) return "目标 TB 字段与当前规则不一致，已按当前规则更新。";
    return dryRun ? "预检判断目标 TB 单需要更新。" : "已按当前飞书单内容更新目标 TB 单。";
  }
  if (row.action === "create") return dryRun ? "预检判断需要创建新的 TB 单。" : "已创建新的 TB 单。";
  if (row.action === "sync-children") return "主任务无需改动，已同步评论、附件或其他子项。";
  return "已完成处理。";
}

function friendlyReason(reason = "") {
  const text = String(reason || "").trim();
  if (!text) return "";
  if (/assignee gate/i.test(text)) return `飞书负责人不在当前规则允许范围内：${text}`;
  if (/read scope filter gate/i.test(text)) return `飞书单未命中读取筛选条件：${text}`;
  if (/out-of-scope/i.test(text)) return `飞书项目或工单类型不在同步范围内：${text}`;
  return text;
}

function tagDisplayName(value, displayContext = {}) {
  if (value === undefined || value === null || value === "") return "";
  if (typeof value !== "object") return readableName(displayContext.tags, value);
  const id = value._id || value.id || value.tagId || value.tag_id || value._tagId || "";
  const name = value.name || value.title || value.label || value.displayName || value.content || value.text || "";
  return String(name || readableName(displayContext.tags, id)).trim();
}

function tagNamesFromValue(value, displayContext = {}) {
  if (Array.isArray(value)) return uniqList(value.map((item) => tagDisplayName(item, displayContext)));
  if (!value || typeof value !== "object") return normalizeListValue(value).map((item) => readableName(displayContext.tags, item));
  const direct = tagDisplayName(value, displayContext);
  return direct ? [direct] : [];
}

function currentTbTagNames(row = {}, displayContext = {}) {
  const task = targetTaskForRow(row);
  if (!task || typeof task !== "object") return [];
  const namedTags = uniqList([
    ...tagNamesFromValue(task.tags, displayContext),
    ...tagNamesFromValue(task.tagList, displayContext),
    ...tagNamesFromValue(task.tagObjects, displayContext),
    ...tagNamesFromValue(task.labels, displayContext),
    ...tagNamesFromValue(task._tags, displayContext),
  ]);
  const idTags = normalizeListValue(task.tagIds || task._tagIds || task.tag_ids || [])
    .map((id) => ({ id, name: readableName(displayContext.tags, id) }))
    .filter((tag) => !namedTags.length || tag.name !== tag.id)
    .map((tag) => tag.name);
  return uniqList([...namedTags, ...idTags]);
}

function plannedTagNames(payload = {}, displayContext = {}) {
  const tagIds = normalizeListValue(payload.tagIds || payload._tagIds || payload.tag_ids || []);
  const tagNames = normalizeListValue(payload.tagNames || payload.defaultTagNames || []);
  const mappedIds = tagIds.map((id) => readableName(displayContext.tags, id));
  const fallbackNames = !tagIds.length && !tagNames.length ? (displayContext.configuredTagNames || []) : [];
  return uniqList([...tagNames, ...mappedIds, ...fallbackNames]);
}

function readableNoteText(value = "") {
  if (value === undefined || value === null) return "";
  const text = typeof value === "string" ? value : stringifyPayloadValue(value);
  return clipText(String(text || "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|tr|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim(), 4000);
}

function hasReadablePayloadValue(payload = {}) {
  return Object.values(payload || {}).some((value) => (
    value !== undefined && value !== null && value !== "" && (!Array.isArray(value) || value.length > 0)
  ));
}

const TARGET_PAYLOAD_FIELD_PATHS = {
  content: ["content", "title", "name"],
  note: ["note", "description", "desc", "detail"],
  executorId: ["executorId", "_executorId", "executor._id", "executor.id", "executor.userId", "raw.executorId", "raw._executorId", "raw.executor._id", "raw.executor.id", "raw.executor.userId"],
  involveMembers: ["involveMembers", "_involveMembers", "_involveMemberIds", "involveMemberIds"],
  startDate: ["startDate", "start_date", "startTime", "start_time", "beginDate", "begin_date", "beginTime", "begin_time"],
  dueDate: ["dueDate", "due_date", "deadline", "dueTime", "due_time", "endDate", "end_date", "endTime", "end_time", "finishTime", "finish_time"],
  priority: ["priority", "_priority", "priorityId", "priority_id", "priority.value"],
  projectId: ["projectId", "_projectId", "project._id", "project.id", "project.projectId"],
  tasklistId: ["tasklistId", "_tasklistId", "tasklist._id", "tasklist.id", "tasklist.tasklistId"],
  stageId: ["stageId", "_stageId", "stage._id", "stage.id"],
  sprintId: ["sprintId", "_sprintId", "sprint._id", "sprint.id", "sprint.sprintId"],
  taskflowstatusId: ["taskflowstatusId", "_taskflowstatusId", "taskflowstatus._id", "taskflowstatus.id", "statusId"],
  scenariofieldconfigId: [
    "scenariofieldconfigId",
    "_scenariofieldconfigId",
    "scenarioFieldConfigId",
    "_scenarioFieldConfigId",
    "scenariofieldconfig._id",
    "scenariofieldconfig.id",
    "scenariofieldconfig.scenariofieldconfigId",
    "scenariofieldconfig.name",
    "scenariofieldconfig.title",
    "scenarioFieldConfig._id",
    "scenarioFieldConfig.id",
    "scenarioFieldConfig.scenarioFieldConfigId",
    "scenarioFieldConfig.name",
    "scenarioFieldConfig.title",
    "taskType._id",
    "taskType.id",
    "taskType.name",
    "taskTypeName",
    "raw.scenariofieldconfigId",
    "raw._scenariofieldconfigId",
    "raw.scenarioFieldConfigId",
    "raw._scenarioFieldConfigId",
    "raw.scenariofieldconfig._id",
    "raw.scenariofieldconfig.id",
    "raw.scenariofieldconfig.name",
    "raw.scenarioFieldConfig._id",
    "raw.scenarioFieldConfig.id",
    "raw.scenarioFieldConfig.name",
    "raw.taskType._id",
    "raw.taskType.id",
    "raw.taskType.name",
    "raw.taskTypeName",
  ],
  tagIds: ["tagIds", "_tagIds", "tag_ids"],
  customfields: [
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
    "raw.customfields",
    "raw.customFields",
    "raw.custom_fields",
    "raw.customFieldValues",
    "raw.customfieldValues",
    "raw.custom_field_values",
    "raw.scenariofieldvalues",
    "raw.scenarioFieldValues",
    "raw.scenario_field_values",
  ],
};

const TARGET_PAYLOAD_NESTED_KEYS = {
  executorId: ["_id", "id", "userId"],
  involveMembers: ["_id", "id", "userId"],
  projectId: ["_id", "id", "projectId"],
  tasklistId: ["_id", "id", "tasklistId"],
  stageId: ["_id", "id", "stageId"],
  sprintId: ["_id", "id", "sprintId"],
  priority: ["value", "_id", "id", "key"],
  taskflowstatusId: ["_id", "id", "taskflowstatusId", "statusId"],
  scenariofieldconfigId: ["_id", "id", "scenariofieldconfigId", "scenarioFieldConfigId", "name", "title", "displayName"],
  tagIds: ["_id", "id", "tagId"],
  customfields: ["customfieldId", "customFieldId", "custom_field_id", "cfId", "_cfId", "cf_id", "_cf_id", "_customfieldId", "_customFieldId", "fieldId", "field_id", "_fieldId", "uuid", "_id", "id", "value"],
};

const TARGET_FIELD_DISPLAY_PATHS = {
  content: ["content", "title", "name"],
  note: ["note", "description", "desc", "detail"],
  executorId: ["executor.name", "executor.nick", "executor.displayName", "executor.username", "executorId", "_executorId", "executor", "raw.executor.name", "raw.executor.nick", "raw.executor.displayName", "raw.executor.username", "raw.executorId", "raw._executorId", "raw.executor"],
  involveMembers: ["involveMembers", "_involveMembers", "_involveMemberIds", "involveMemberIds"],
  startDate: ["startDate", "start_date", "startTime", "start_time", "beginDate", "begin_date", "beginTime", "begin_time"],
  dueDate: ["dueDate", "due_date", "deadline", "dueTime", "due_time", "endDate", "end_date", "endTime", "end_time", "finishTime", "finish_time"],
  priority: ["priority.label", "priority.name", "priority.title", "priority", "_priority"],
  projectId: ["project.name", "project.title", "projectName", "projectId", "_projectId", "project"],
  tasklistId: ["tasklist.pathName", "tasklist.projectPathName", "tasklist.title", "tasklist.name", "tasklistName", "tasklistId", "_tasklistId", "tasklist"],
  stageId: ["stage.name", "stage.title", "stageId", "_stageId", "stage"],
  sprintId: ["sprint.name", "sprint.title", "sprintName", "sprintId", "_sprintId", "sprint"],
  taskflowstatusId: ["taskflowstatus.name", "statusName", "status", "taskflowstatusId", "_taskflowstatusId"],
  scenariofieldconfigId: [
    "scenariofieldconfig.name",
    "scenariofieldconfig.title",
    "scenarioFieldConfig.name",
    "scenarioFieldConfig.title",
    "taskType.name",
    "taskType.title",
    "taskTypeName",
    "scenariofieldconfigId",
    "_scenariofieldconfigId",
    "scenarioFieldConfigId",
    "_scenarioFieldConfigId",
    "raw.scenariofieldconfig.name",
    "raw.scenariofieldconfig.title",
    "raw.scenarioFieldConfig.name",
    "raw.scenarioFieldConfig.title",
    "raw.taskType.name",
    "raw.taskType.title",
    "raw.taskTypeName",
    "raw.scenariofieldconfigId",
    "raw._scenariofieldconfigId",
    "raw.scenarioFieldConfigId",
    "raw._scenarioFieldConfigId",
  ],
};

function mismatchForPayloadField(row = {}, key = "") {
  const mismatches = Array.isArray(row.targetFieldVerification?.mismatches) ? row.targetFieldVerification.mismatches : [];
  return mismatches.find((item) => item?.field === key) || null;
}

const TARGET_CUSTOM_FIELD_SOURCE_PATHS = TARGET_PAYLOAD_FIELD_PATHS.customfields;

const TARGET_CUSTOM_FIELD_ID_PATHS = [
  "customfieldId",
  "customFieldId",
  "custom_field_id",
  "cfId",
  "_cfId",
  "cf_id",
  "_cf_id",
  "_customfieldId",
  "_customFieldId",
  "_custom_field_id",
  "fieldId",
  "field_id",
  "_fieldId",
  "_field_id",
  "uuid",
  "id",
  "_id",
  "key",
  "customfield._id",
  "customfield.id",
  "customfield.uuid",
  "customField._id",
  "customField.id",
  "customField.uuid",
  "custom_field._id",
  "custom_field.id",
  "field._id",
  "field.id",
  "field.uuid",
  "definition._id",
  "definition.id",
  "definition.uuid",
  "scenariofield._id",
  "scenariofield.id",
  "scenariofield.uuid",
  "scenariofield.customfieldId",
  "scenariofield.customFieldId",
  "scenariofield.customfield._id",
  "scenariofield.customfield.id",
  "scenariofield.customfield.uuid",
  "scenariofield.customField._id",
  "scenariofield.customField.id",
  "scenariofield.customField.uuid",
  "scenarioField._id",
  "scenarioField.id",
  "scenarioField.uuid",
  "scenarioField.customfieldId",
  "scenarioField.customFieldId",
  "scenarioField.customfield._id",
  "scenarioField.customfield.id",
  "scenarioField.customfield.uuid",
  "scenarioField.customField._id",
  "scenarioField.customField.id",
  "scenarioField.customField.uuid",
  "scenario_field._id",
  "scenario_field.id",
  "scenario_field.uuid",
  "scenario_field.customfieldId",
  "scenario_field.customFieldId",
  "scenario_field.customfield._id",
  "scenario_field.customfield.id",
  "scenario_field.customfield.uuid",
  "scenario_field.customField._id",
  "scenario_field.customField.id",
  "scenario_field.customField.uuid",
];

const TARGET_CUSTOM_FIELD_NAME_PATHS = [
  "customfield.name",
  "customfield.title",
  "customfield.label",
  "customfield.displayName",
  "customField.name",
  "customField.title",
  "customField.label",
  "customField.displayName",
  "custom_field.name",
  "custom_field.title",
  "field.name",
  "field.title",
  "field.label",
  "field.displayName",
  "definition.name",
  "definition.title",
  "definition.label",
  "definition.displayName",
  "scenariofield.name",
  "scenariofield.title",
  "scenariofield.label",
  "scenariofield.displayName",
  "scenariofield.customfield.name",
  "scenariofield.customfield.title",
  "scenariofield.customField.name",
  "scenariofield.customField.title",
  "scenarioField.name",
  "scenarioField.title",
  "scenarioField.label",
  "scenarioField.displayName",
  "scenarioField.customfield.name",
  "scenarioField.customfield.title",
  "scenarioField.customField.name",
  "scenarioField.customField.title",
  "scenario_field.name",
  "scenario_field.title",
  "scenario_field.label",
  "scenario_field.displayName",
  "scenario_field.customfield.name",
  "scenario_field.customfield.title",
  "scenario_field.customField.name",
  "scenario_field.customField.title",
  "name",
  "title",
  "label",
  "displayName",
];

const CATEGORY_CUSTOM_FIELD_LABELS = {
  applicationCategory: ["应用分类", "应用类别", "应用类型"],
  defectCategory: ["缺陷分类", "缺陷类别", "缺陷类型", "Bug分类", "BUG分类", "Bug类型", "BUG类型", "问题分类", "问题类型"],
};

const TARGET_CUSTOM_FIELD_VALUE_PATHS = [
  "displayValue",
  "display_value",
  "displayText",
  "display_text",
  "value.displayValue",
  "value.display_value",
  "value.label",
  "value.name",
  "value.title",
  "value.text",
  "value.value",
  "value",
  "values",
  "selectedValue.displayValue",
  "selectedValue.label",
  "selectedValue.name",
  "selectedValue.title",
  "selectedValue.text",
  "selectedValue.value",
  "selectedValue",
  "selectedValues",
  "option.displayValue",
  "option.label",
  "option.name",
  "option.title",
  "option.text",
  "option.value",
  "option",
  "options",
  "fieldValue.displayValue",
  "fieldValue.label",
  "fieldValue.name",
  "fieldValue.title",
  "fieldValue.text",
  "fieldValue.value",
  "fieldValue",
  "field_value.displayValue",
  "field_value.label",
  "field_value.name",
  "field_value.title",
  "field_value.text",
  "field_value.value",
  "field_value",
  "text",
  "label",
  "title",
  "name",
];

function parseJsonValue(value) {
  const text = String(value || "").trim();
  if (!text || !/^[\[{]/.test(text)) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function customFieldEntriesFromValue(value) {
  if (!value) return [];
  if (typeof value === "string") {
    const parsed = parseJsonValue(value);
    return parsed === undefined ? [] : customFieldEntriesFromValue(parsed);
  }
  if (Array.isArray(value)) {
    return value.flatMap((item) => {
      if (Array.isArray(item) && item.length >= 2) return [{ customfieldId: item[0], value: item[1] }];
      return item && typeof item === "object" ? [item] : [];
    });
  }
  if (typeof value !== "object") return [];
  const nested = ["items", "list", "records", "results", "data"].flatMap((key) => {
    const child = readObjectPath(value, key);
    if (Array.isArray(child)) return customFieldEntriesFromValue(child);
    return child && typeof child === "object" ? customFieldEntriesFromValue(child) : [];
  });
  if (nested.length) return nested;
  if (customFieldIdToken(value)) return [value];
  return Object.entries(value).map(([customfieldId, fieldValue]) => ({ customfieldId, value: fieldValue }));
}

function targetTaskCustomFieldEntries(task = {}) {
  if (!task || typeof task !== "object") return [];
  const entries = [];
  for (const path of TARGET_CUSTOM_FIELD_SOURCE_PATHS) {
    entries.push(...customFieldEntriesFromValue(readObjectPath(task, path)));
  }
  return entries;
}

function targetCustomFieldEntriesForRow(row = {}) {
  const entries = targetTaskCustomFieldEntries(targetTaskForRow(row));
  const mismatch = mismatchForPayloadField(row, "customfields");
  if (mismatch) entries.push(...customFieldEntriesFromValue(mismatch.actual));
  return entries;
}

function plannedCustomFieldEntriesForRow(row = {}) {
  const entries = customFieldEntriesFromValue(row.payload?.customfields);
  const mismatch = mismatchForPayloadField(row, "customfields");
  if (mismatch) entries.push(...customFieldEntriesFromValue(mismatch.expected));
  return entries;
}

function customFieldIdToken(field = {}) {
  if (Array.isArray(field) && field.length >= 2) return String(field[0] || "").trim();
  const value = firstKnownObjectValue(field, TARGET_CUSTOM_FIELD_ID_PATHS);
  const token = Array.isArray(value) ? value[0] : value;
  return token === undefined || token === null ? "" : String(token).trim();
}

function normalizedCustomFieldName(value = "") {
  return String(value || "").replace(/\s+/g, "").toLowerCase();
}

function customFieldNameToken(field = {}) {
  const value = firstKnownObjectValue(field, TARGET_CUSTOM_FIELD_NAME_PATHS);
  const token = Array.isArray(value) ? value[0] : value;
  return token === undefined || token === null ? "" : String(token).trim();
}

function categoryFieldNameSet(key = "") {
  return new Set((CATEGORY_CUSTOM_FIELD_LABELS[key] || []).map(normalizedCustomFieldName).filter(Boolean));
}

function customFieldReadableText(value, depth = 0) {
  if (value === undefined || value === null || value === "") return "";
  if (Array.isArray(value)) return value.map((item) => customFieldReadableText(item, depth + 1)).filter(Boolean).join("、");
  if (typeof value !== "object") return String(value).trim();
  if (depth >= 6) return "";
  for (const path of TARGET_CUSTOM_FIELD_VALUE_PATHS) {
    const nested = readObjectPath(value, path);
    if (nested === undefined || nested === null || nested === "" || nested === value) continue;
    const text = customFieldReadableText(nested, depth + 1);
    if (text) return text;
  }
  return stringifyPayloadValue(value);
}

function customFieldDisplayValue(field = {}) {
  const raw = firstKnownObjectValue(field, TARGET_CUSTOM_FIELD_VALUE_PATHS);
  const text = customFieldReadableText(raw);
  if (text) return text;
  return customFieldReadableText(field);
}

function targetCustomFieldValue(row = {}, fieldId = "", key = "") {
  const id = String(fieldId || "").trim();
  const entries = targetCustomFieldEntriesForRow(row);
  const hit = id ? entries.find((field) => customFieldIdToken(field) === id) : null;
  if (hit) return customFieldDisplayValue(hit);
  const plannedValue = row.payload?.[key];
  if (plannedValue !== undefined && plannedValue !== null && plannedValue !== "") {
    const plannedText = comparableText(customFieldReadableText(plannedValue) || stringifyPayloadValue(plannedValue));
    const plannedHit = plannedCustomFieldEntriesForRow(row).find((field) => {
      const valueText = comparableText(customFieldDisplayValue(field));
      return valueText && plannedText && valueText === plannedText;
    });
    const plannedId = plannedHit ? customFieldIdToken(plannedHit) : "";
    if (plannedId) {
      const currentHit = entries.find((field) => customFieldIdToken(field) === plannedId);
      if (currentHit) return customFieldDisplayValue(currentHit);
    }
  }
  const names = categoryFieldNameSet(key);
  const namedHit = names.size
    ? entries.find((field) => names.has(normalizedCustomFieldName(customFieldNameToken(field))))
    : null;
  if (namedHit) return customFieldDisplayValue(namedHit);
  return undefined;
}

function payloadCustomFieldId(row = {}, key = "", displayContext = {}) {
  const payloadKey = ({
    applicationCategory: "applicationCategoryCustomFieldId",
    defectCategory: "defectCategoryCustomFieldId",
  })[key];
  if (!payloadKey) return "";
  return String(row.payload?.[payloadKey] || displayContext.customFieldIds?.[key] || "").trim();
}

function targetFieldRawValue(row = {}, key = "", displayContext = {}) {
  if (key === "applicationCategory") return targetCustomFieldValue(row, payloadCustomFieldId(row, key, displayContext), key);
  if (key === "defectCategory") return targetCustomFieldValue(row, payloadCustomFieldId(row, key, displayContext), key);
  const task = targetTaskForRow(row);
  if (!task || typeof task !== "object") return undefined;
  for (const path of TARGET_PAYLOAD_FIELD_PATHS[key] || []) {
    const value = readObjectPath(task, path);
    const nested = firstKnownObjectValue(value, TARGET_PAYLOAD_NESTED_KEYS[key] || []);
    if (nested !== undefined && nested !== null && nested !== "") return nested;
  }
  return undefined;
}

function targetFieldFriendlyRawValue(row = {}, key = "", displayContext = {}) {
  if (key === "applicationCategory") return targetCustomFieldValue(row, payloadCustomFieldId(row, key, displayContext), key);
  if (key === "defectCategory") return targetCustomFieldValue(row, payloadCustomFieldId(row, key, displayContext), key);
  const task = targetTaskForRow(row);
  if (!task || typeof task !== "object") return undefined;
  if (key === "tagIds") {
    const tags = currentTbTagNames(row, displayContext);
    return tags.length ? tags : undefined;
  }
  const directDisplay = readObjectPath(task, `${key}Display`);
  if (directDisplay !== undefined && directDisplay !== null && directDisplay !== "") return directDisplay;
  for (const path of TARGET_FIELD_DISPLAY_PATHS[key] || []) {
    const value = readObjectPath(task, path);
    const nested = firstKnownObjectValue(value, ["name", "title", "displayName", "nick", "username", "_id", "id", "userId"]);
    if (nested !== undefined && nested !== null && nested !== "") return nested;
  }
  return undefined;
}

function notePreviousRawValue(row = {}, mismatch = null, displayContext = {}) {
  const task = targetTaskForRow(row);
  const candidates = [
    row.notePrevious,
    row.previousNote,
    row.currentNote,
    row.payload?.notePrevious,
    row.targetFieldVerification?.notePrevious,
    row.targetFieldVerification?.previousNote,
    row.targetFieldVerification?.currentNote,
    mismatch?.actualDisplay,
    mismatch?.actual,
    row.targetFieldVerification?.task?.noteDisplay,
    row.targetFieldVerification?.task?.noteMarkdown,
    row.targetFieldVerification?.task?.note,
    task.noteDisplay,
    task.noteMarkdown,
    task.note,
    targetFieldFriendlyRawValue(row, "note", displayContext),
    targetFieldRawValue(row, "note"),
  ];
  for (const candidate of candidates) {
    const text = readableNoteText(candidate);
    if (text) return text;
  }
  return "";
}

function hasOwnValue(obj = {}, key = "") {
  return !!obj && typeof obj === "object" && Object.prototype.hasOwnProperty.call(obj, key);
}

function isKnownEmptyNotePrevious(row = {}, mismatch = null) {
  const verification = row.targetFieldVerification || {};
  const explicitKeys = [
    [row, "notePrevious"],
    [row, "previousNote"],
    [row, "currentNote"],
    [row.payload || {}, "notePrevious"],
    [verification, "notePrevious"],
    [verification, "previousNote"],
    [verification, "currentNote"],
    [verification.task || {}, "noteDisplay"],
    [verification.task || {}, "noteMarkdown"],
    [verification.task || {}, "note"],
    [targetTaskForRow(row), "noteDisplay"],
    [targetTaskForRow(row), "noteMarkdown"],
    [targetTaskForRow(row), "note"],
  ];
  if (explicitKeys.some(([obj, key]) => hasOwnValue(obj, key) && readableNoteText(obj[key]) === "")) return true;
  if (mismatch && hasOwnValue(mismatch, "actual") && readableNoteText(mismatch.actual) === "") return true;
  const noteRead = verification.noteRead || {};
  return !!(noteRead.attempted && noteRead.ok !== false && noteRead.empty);
}

function payloadDisplayValue(key, value, displayContext = {}) {
  if (value === undefined || value === null || value === "") return "";
  if (Array.isArray(value) && !value.length) return "";
  if (key === "note") return readableNoteText(value);
  if (key === "startDate" || key === "dueDate") return formatTime(dateActualValue(value) || value);
  return readablePayloadValue(key, value, displayContext);
}

function comparablePayloadValue(key, value, displayContext = {}) {
  const text = payloadDisplayValue(key, value, displayContext);
  return String(text || "").replace(/\s+/g, " ").trim().toLowerCase();
}

const ACTUAL_FIELD_VALUE_KEYS = {
  executorId: ["_id", "id", "userId", "uid", "executorId", "_executorId", "value"],
  involveMembers: ["_id", "id", "userId", "uid", "value"],
  projectId: ["_id", "id", "projectId", "_projectId", "value"],
  tasklistId: ["_id", "id", "tasklistId", "_tasklistId", "value"],
  stageId: ["_id", "id", "stageId", "_stageId", "value"],
  sprintId: ["_id", "id", "sprintId", "_sprintId", "value"],
  priority: ["value", "_id", "id", "key"],
  taskflowstatusId: ["_id", "id", "taskflowstatusId", "_taskflowstatusId", "statusId", "value"],
  scenariofieldconfigId: ["_id", "id", "scenariofieldconfigId", "scenarioFieldConfigId", "_scenariofieldconfigId", "_scenarioFieldConfigId", "value"],
  applicationCategory: ["value", "name", "title", "label", "displayName"],
  defectCategory: ["value", "name", "title", "label", "displayName"],
  tagIds: ["_id", "id", "tagId", "value"],
};

function dateActualValue(value) {
  if (!value) return "";
  const direct = typeof value === "object" ? firstKnownObjectValue(value, ["iso_time", "isoTime", "date_time", "dateTime", "datetime", "date", "time", "value", "startDate", "dueDate", "startTime", "dueTime", "deadline"]) : value;
  const text = Array.isArray(direct) ? direct[0] : direct;
  if (!text) return "";
  const d = new Date(text);
  return Number.isNaN(d.getTime()) ? String(text) : d.toISOString();
}

function actualValueToken(key = "", value) {
  if (value === undefined || value === null || value === "") return "";
  if (Array.isArray(value)) return value.map((item) => actualValueToken(key, item)).filter(Boolean);
  if (typeof value !== "object") return value;
  const nested = firstKnownObjectValue(value, ACTUAL_FIELD_VALUE_KEYS[key] || ["value", "_id", "id"]);
  return nested !== undefined && nested !== null && nested !== "" ? nested : value;
}

function normalizeActualListValue(key = "", value) {
  const token = actualValueToken(key, value);
  const list = Array.isArray(token) ? token : normalizeListValue(token);
  return uniqList(list).sort();
}

function normalizeCustomFieldsActualValue(value) {
  const fields = Array.isArray(value)
    ? value
    : (value && typeof value === "object" ? Object.entries(value).map(([id, fieldValue]) => ({ id, value: fieldValue })) : []);
  const normalized = fields.map((field) => {
    const id = String(field?.customfieldId || field?.customFieldId || field?.custom_field_id || field?.cfId || field?._cfId || field?.cf_id || field?._cf_id || field?.fieldId || field?.id || field?._id || "").trim();
    const raw = field?.value ?? field?.values ?? field?.text ?? field?.displayValue ?? "";
    if (!id || raw === undefined || raw === null || raw === "" || (Array.isArray(raw) && !raw.length)) return null;
    const values = normalizeActualListValue("customfields", raw);
    return [id, values.length ? values.join("\u001f") : String(raw)];
  }).filter(Boolean);
  return normalized.length ? JSON.stringify(normalized.sort(([a], [b]) => a.localeCompare(b))) : "";
}

function payloadActualValue(key = "", value) {
  if (value === undefined || value === null || value === "" || (Array.isArray(value) && !value.length)) return "";
  if (key === "startDate" || key === "dueDate") return dateActualValue(value);
  if (key === "involveMembers" || key === "tagIds") return normalizeActualListValue(key, value).join("\u001f");
  if (key === "customfields") return normalizeCustomFieldsActualValue(value);
  const token = actualValueToken(key, value);
  if (Array.isArray(token)) return normalizeActualListValue(key, token).join("\u001f");
  if (token && typeof token === "object") return stringifyPayloadValue(token);
  return String(token || "").trim();
}

function comparableText(value = "") {
  return String(value || "").replace(/\s+/g, " ").trim().toLowerCase();
}

const READABLE_SAME_STATUS_FIELDS = new Set(["priority", "projectId", "tasklistId", "sprintId", "involveMembers", "applicationCategory", "defectCategory"]);
const READABLE_CATEGORY_FIELDS = new Set(["applicationCategory", "defectCategory"]);

function comparableReadableFieldText(key = "", value = "") {
  if (key === "involveMembers" || key === "tagIds") {
    return String(value || "")
      .split(/\u001f|[、\n,;]+/)
      .map((item) => comparableText(item))
      .filter(Boolean)
      .sort()
      .join("\u001f");
  }
  return comparableText(value);
}

function payloadFieldStatus({ row = {}, nextActual = "", previousActual = "", nextValue = "", previousValue = "" }) {
  const targetId = targetTaskInfoForRow(row).targetTaskId;
  const nextComparable = comparableText(nextActual) || comparableText(nextValue);
  const previousComparable = comparableText(previousActual) || comparableText(previousValue);
  const hasPrevious = previousComparable !== "";
  if (row.action === "create" || !targetId) return "write";
  if (previousComparable && nextComparable && previousComparable !== nextComparable) return "update";
  if (previousComparable && nextComparable && previousComparable === nextComparable) return "same";
  if (!hasPrevious) return "write";
  return "target";
}

function payloadFieldEntry(row = {}, key = "", label = "", rawValue, displayContext = {}) {
  const mismatch = mismatchForPayloadField(row, key);
  const mismatchActualDisplay = mismatch?.actualDisplay || mismatch?.actualName || mismatch?.actualLabel || "";
  const mismatchExpectedDisplay = mismatch?.expectedDisplay || mismatch?.expectedName || mismatch?.expectedLabel || "";
  const previousRaw = key === "note" ? notePreviousRawValue(row, mismatch, displayContext) : (mismatch?.actual ?? targetFieldRawValue(row, key, displayContext));
  const previousFriendlyRaw = key === "note" ? previousRaw : (mismatchActualDisplay || targetFieldFriendlyRawValue(row, key, displayContext) || previousRaw);
  const payloadDisplayRaw = row?.payload?.[`${key}Display`] || row?.payload?.[`${key}Name`] || row?.payload?.[`${key}Label`] || "";
  const nextRaw = mismatchExpectedDisplay || payloadDisplayRaw || mismatch?.expected || rawValue;
  const knownEmptyNotePrevious = key === "note" && isKnownEmptyNotePrevious(row, mismatch);
  const previousActual = payloadActualValue(key, previousRaw);
  const nextActual = payloadActualValue(key, mismatch?.expected ?? rawValue);
  const previousValue = (knownEmptyNotePrevious && !previousFriendlyRaw)
    ? "空"
    : payloadDisplayValue(key, previousFriendlyRaw, displayContext);
  const nextValue = payloadDisplayValue(key, nextRaw, displayContext);
  const readableSameForStatus = READABLE_SAME_STATUS_FIELDS.has(key)
    && comparableReadableFieldText(key, previousValue)
    && comparableReadableFieldText(key, nextValue)
    && comparableReadableFieldText(key, previousValue) === comparableReadableFieldText(key, nextValue);
  const status = readableSameForStatus
    ? "same"
    : key === "note" && previousValue && nextValue && comparableText(previousValue) !== comparableText(nextValue)
    ? "update"
    : payloadFieldStatus({ row, nextActual, previousActual, nextValue, previousValue });
  const previousTitle = previousValue || (previousFriendlyRaw === undefined ? "" : stringifyPayloadValue(previousFriendlyRaw));
  const title = nextValue || stringifyPayloadValue(nextRaw);
  const target = targetTaskInfoForRow(row);
  const targetLabel = target.displayId && target.displayId !== "-" ? `旧 TB 备注（${target.displayId}）` : "旧 TB 备注";
  return {
    key,
    label,
    status,
    value: nextValue,
    previous: previousValue,
    previousLabel: key === "note" ? targetLabel : undefined,
    nextLabel: key === "note" ? "修正后备注" : undefined,
    title,
    previousTitle,
    actual: nextActual,
    previousActual,
  };
}

function splitNotePayloadEntries(entry = {}) {
  if (!entry || entry.key !== "note") return entry ? [entry] : [];
  const previousValue = entry.previous !== undefined && entry.previous !== null && entry.previous !== ""
    ? entry.previous
    : "空";
  return [
    {
      ...entry,
      key: "note.previous",
      label: entry.previousLabel || "旧 TB 备注",
      status: "notePrevious",
      value: previousValue,
      title: entry.previousTitle || previousValue,
      valueKind: "noteBlock",
      noteTone: "current",
      deleted: true,
    },
    {
      ...entry,
      key: "note.next",
      label: entry.nextLabel || "修正后备注",
      status: "noteNext",
      value: entry.value || "空",
      title: entry.title || entry.value || "空",
      valueKind: "noteBlock",
      noteTone: "next",
      deleted: false,
    },
  ];
}

function comparisonSnapshotCurrentValue(row = {}, key = "", current = {}, displayContext = {}) {
  const direct = comparisonSnapshotFieldValue(key, current, displayContext);
  if (direct) return direct;
  const fallback = row.comparisonSnapshot?.target?.fields?.[key];
  if (fallback) {
    const fromTarget = comparisonSnapshotFieldValue(key, fallback, displayContext);
    if (fromTarget) return fromTarget;
  }
  if (READABLE_CATEGORY_FIELDS.has(key)) {
    return targetFieldFriendlyRawValue(row, key, displayContext) || "";
  }
  return "";
}

function comparisonSnapshotPayloadEntries(row = {}, displayContext = {}) {
  const comparisons = Array.isArray(row.comparisonSnapshot?.fieldComparisons)
    ? row.comparisonSnapshot.fieldComparisons
    : [];
  if (!comparisons.length) return [];
  return comparisons.flatMap((comparison) => {
    const key = comparison.fieldKey || comparison.key || "";
    if (!key) return [];
    const current = comparison.targetCurrent || comparison.current || {};
    const next = comparison.targetNext || comparison.next || {};
    const previousValue = comparisonSnapshotCurrentValue(row, key, current, displayContext);
    const nextValue = comparisonSnapshotFieldValue(key, next, displayContext);
    let status = comparisonSnapshotStatus(comparison.action);
    if (
      READABLE_CATEGORY_FIELDS.has(key)
      && previousValue
      && nextValue
      && comparableReadableFieldText(key, previousValue) === comparableReadableFieldText(key, nextValue)
    ) {
      status = "same";
    } else if (
      READABLE_CATEGORY_FIELDS.has(key)
      && previousValue
      && nextValue
      && comparableReadableFieldText(key, previousValue) !== comparableReadableFieldText(key, nextValue)
      && status === "write"
    ) {
      status = "update";
    }
    const entry = {
      key,
      label: payloadFieldLabel(key),
      status,
      value: nextValue,
      previous: previousValue,
      previousLabel: key === "note" ? "旧 TB 备注" : undefined,
      nextLabel: key === "note" ? "修正后备注" : undefined,
      title: nextValue || (next.raw === undefined ? "" : stringifyPayloadValue(next.raw)),
      previousTitle: previousValue || (current.raw === undefined ? "" : stringifyPayloadValue(current.raw)),
      actual: payloadActualValue(key, next.raw ?? nextValue),
      previousActual: payloadActualValue(key, current.raw ?? previousValue),
      hint: payloadFieldHint(key) || comparison.compare?.reason || "",
      sourceFields: comparison.sourceFields,
    };
    return key === "note" ? splitNotePayloadEntries(entry) : [entry];
  });
}

function comparisonSnapshotFieldValue(key = "", value = {}, displayContext = {}) {
  if (!value || typeof value !== "object") return "";
  const display = value.display;
  if (display !== undefined && display !== null && display !== "") return payloadDisplayValue(key, display, displayContext);
  const raw = value.raw;
  if (raw !== undefined && raw !== null && raw !== "") return payloadDisplayValue(key, raw, displayContext) || stringifyPayloadValue(raw);
  if (value.present === false) return "";
  return "";
}

function comparisonSnapshotStatus(action = "") {
  const normalized = String(action || "").trim().toLowerCase();
  if (normalized === "same" || normalized === "skip" || normalized === "unchanged") return "same";
  if (normalized === "update") return "update";
  if (normalized === "write" || normalized === "create") return "write";
  return normalized || "target";
}

function payloadEntries(row = {}, displayContext = {}) {
  const snapshotRows = comparisonSnapshotPayloadEntries(row, displayContext);
  if (snapshotRows.length) return snapshotRows;
  const payload = row.payload || {};
  const hasPayloadValue = hasReadablePayloadValue(payload);
  const labels = [
    "content",
    "note",
    "executorId",
    "involveMembers",
    "startDate",
    "dueDate",
    "priority",
    "projectId",
    "tasklistId",
    "stageId",
    "sprintId",
    "taskflowstatusId",
    "scenariofieldconfigId",
    "applicationCategory",
    "defectCategory",
    "tagIds",
    "customfields",
  ];
  const rows = labels.flatMap((key) => {
    const value = payload?.[key];
    if (value === undefined || value === null || value === "" || (Array.isArray(value) && !value.length)) return [];
    const entry = {
      ...payloadFieldEntry(row, key, payloadFieldLabel(key), value, displayContext),
      hint: payloadFieldHint(key),
    };
    return key === "note" ? splitNotePayloadEntries(entry) : [entry];
  }).filter(Boolean);
  if (hasPayloadValue && !rows.some((row) => row.label === "标签")) {
    const tags = plannedTagNames(payload, displayContext);
    if (tags.length) {
      const currentTags = currentTbTagNames(row, displayContext);
      const currentText = currentTags.join("、");
      const targetText = tags.join("、");
      rows.push({
        key: "tagNames",
        label: "标签",
        status: currentText && currentText === targetText ? "same" : "config",
        value: targetText,
        previous: currentText,
        title: `配置标签名：${targetText}`,
        previousTitle: currentText ? `当前标签：${currentText}` : "",
      });
    }
  }
  return rows;
}

const PAYLOAD_FIELD_VALUE_KEYS = {
  executorId: ["name", "nick", "displayName", "username", "_id", "id", "userId"],
  involveMembers: ["name", "nick", "displayName", "username", "_id", "id", "userId"],
  projectId: ["name", "title", "_id", "id", "projectId"],
  tasklistId: ["name", "title", "_id", "id", "tasklistId"],
  sprintId: ["name", "title", "_id", "id", "sprintId"],
  taskflowstatusId: ["name", "title", "statusName", "_id", "id", "taskflowstatusId", "statusId"],
  scenariofieldconfigId: ["name", "title", "displayName", "_id", "id", "scenariofieldconfigId", "scenarioFieldConfigId"],
  applicationCategory: ["value", "name", "title", "label", "displayName"],
  defectCategory: ["value", "name", "title", "label", "displayName"],
  priority: ["value", "targetValue", "target", "priority", "_id", "id", "key", "name", "title", "label", "displayName"],
  tagIds: ["name", "title", "_id", "id", "tagId"],
};

function readableValueToken(key = "", value) {
  if (value === undefined || value === null || value === "") return "";
  if (Array.isArray(value)) return value.map((item) => readableValueToken(key, item)).filter(Boolean);
  if (typeof value !== "object") return value;
  const nested = firstKnownObjectValue(value, PAYLOAD_FIELD_VALUE_KEYS[key] || ["name", "title", "displayName", "_id", "id"]);
  return nested !== undefined && nested !== null && nested !== "" ? nested : value;
}

function readablePriorityValue(value, displayContext = {}) {
  const candidates = [readableValueToken("priority", value), actualValueToken("priority", value), value];
  for (const candidate of candidates) {
    const token = Array.isArray(candidate) ? candidate[0] : candidate;
    if (token !== undefined && token !== null && token !== "" && typeof token !== "object") {
      return readableName(displayContext.priorities, token);
    }
  }
  return stringifyPayloadValue(value);
}

function readablePayloadValue(key, value, displayContext = {}) {
  if (key === "executorId") return readableName(displayContext.members, readableValueToken(key, value));
  if (key === "involveMembers") {
    const members = Array.isArray(value) ? readableValueToken(key, value) : normalizeListValue(value);
    return normalizeListValue(members).map((id) => readableName(displayContext.members, id)).join("、");
  }
  if (key === "projectId") return readableName(displayContext.projects, readableValueToken(key, value));
  if (key === "tasklistId") return readableName(displayContext.tasklists, readableValueToken(key, value));
  if (key === "sprintId") return readableName(displayContext.sprints, readableValueToken(key, value));
  if (key === "priority") return readablePriorityValue(value, displayContext);
  if (key === "scenariofieldconfigId") return readableName(displayContext.taskTypes, readableValueToken(key, value));
  if (key === "tagIds") {
    const tags = Array.isArray(value) ? readableValueToken(key, value) : normalizeListValue(value);
    return normalizeListValue(tags).map((id) => readableName(displayContext.tags, id)).join("、");
  }
  if (key === "note") return readableNoteText(value);
  return stringifyPayloadValue(value);
}

function stringifyPayloadValue(value) {
  if (Array.isArray(value)) {
    if (value.length && typeof value[0] === "object") {
      return value.map((item) => {
        const id = item.customfieldId || item.customFieldId || item.id || "";
        const val = item.value ?? item.values ?? item.text ?? "";
        return [id, stringifyPayloadValue(val)].filter(Boolean).join("=");
      }).filter(Boolean).join("；");
    }
    return value.join("、");
  }
  if (value && typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function readableMismatchValue(field, value, displayContext = {}) {
  const token = readableResultFieldValue(value, field);
  if (field === "executorId") return readableName(displayContext.members, token);
  if (field === "projectId") return readableName(displayContext.projects, token);
  if (field === "tasklistId") return readableName(displayContext.tasklists, token);
  if (field === "sprintId") return readableName(displayContext.sprints, token);
  if (field === "priority") return readablePriorityValue(value, displayContext);
  if (field === "scenariofieldconfigId") return readableName(displayContext.taskTypes, token);
  if (field === "involveMembers") return normalizeListValue(value).map((id) => readableName(displayContext.members, id)).join("、");
  if (field === "tagIds") return normalizeListValue(value).map((id) => readableName(displayContext.tags, id)).join("、");
  return stringifyPayloadValue(value);
}

function mismatchSideValue(mismatch = {}, side = "actual") {
  if (side === "actual") {
    if (mismatch.field === "note" && hasOwnValue(mismatch, "actual") && readableNoteText(mismatch.actual) === "") return "空";
    return mismatch.actualDisplay || mismatch.actualName || mismatch.actualLabel || mismatch.actual || "-";
  }
  return mismatch.expectedDisplay || mismatch.expectedName || mismatch.expectedLabel || mismatch.expected || "-";
}

function noteReadSummary(noteRead = null) {
  if (!noteRead || typeof noteRead !== "object") return "";
  if (noteRead.attempted) {
    if (noteRead.ok === false) return `TB备注读取失败：${noteRead.error || noteRead.reason || "未知原因"}`;
    const parts = [];
    if (noteRead.renderMode) parts.push(`格式 ${noteRead.renderMode}`);
    if (noteRead.markdownLength !== undefined) parts.push(`文本 ${noteRead.markdownLength} 字`);
    if (noteRead.imageCount !== undefined) parts.push(`图片 ${noteRead.imageCount} 张`);
    if (noteRead.linkCount !== undefined) parts.push(`链接 ${noteRead.linkCount} 个`);
    return `TB备注已读取：${parts.join("，") || (noteRead.empty ? "为空" : "有内容")}`;
  }
  if (noteRead.skipped) return `TB备注未读取：${noteRead.reason || "未满足读取条件"}`;
  return "";
}

function rowDetailNotes(row = {}, displayContext = {}) {
  const notes = [];
  if (row.remoteExisting?.targetTaskId) notes.push(`远端查重命中：${row.remoteExisting.source || "未知来源"} -> ${row.remoteExisting.targetTaskId}`);
  if (row.existing?.targetTaskId) notes.push(`本地同步关系：${row.existing.targetTaskId}${row.existing.syncStatus ? `（${row.existing.syncStatus}）` : ""}`);
  const noteRead = noteReadSummary(row.targetFieldVerification?.noteRead);
  if (noteRead) notes.push(noteRead);
  const currentTags = currentTbTagNames(row, displayContext);
  const targetTags = hasReadablePayloadValue(row.payload || {}) ? plannedTagNames(row.payload || {}, displayContext) : [];
  if (currentTags.length || targetTags.length) {
    const hasWritableTagIds = normalizeListValue(row.payload?.tagIds || []).length > 0;
    notes.push(`标签：当前 ${currentTags.join("、") || "未返回"}；${hasWritableTagIds ? "将写入" : "配置标签名"} ${targetTags.join("、") || "无"}`);
  }
  if (row.targetFieldVerification?.mismatches?.length) {
    notes.push(...row.targetFieldVerification.mismatches.map((x) => `${payloadFieldLabel(x.field)}：当前 ${readableMismatchValue(x.field, mismatchSideValue(x, "actual"), displayContext)} -> 目标 ${readableMismatchValue(x.field, mismatchSideValue(x, "expected"), displayContext)}`));
  }
  if (row.scheduleWarnings?.length) notes.push(...row.scheduleWarnings.map((x) => typeof x === "string" ? x : JSON.stringify(x)));
  if (row.childPlan?.needsSync) {
    const comments = row.childPlan.comments?.length || 0;
    const attachments = row.childPlan.attachments?.length || 0;
    notes.push(`子项待同步：评论 ${comments}，附件 ${attachments}`);
  }
  return notes;
}

function formatRawRunLog(events = [], run = null) {
  return JSON.stringify({
    run: run || null,
    events: events || [],
  }, null, 2);
}

function modeLabel(mode) {
  if (mode === "mcp") return "MCP";
  if (mode === "web") return "网页登录态";
  return "OpenAPI";
}

function authModeOption(mode) {
  return FEISHU_AUTH_MODE_OPTIONS.find((item) => item.value === mode) || FEISHU_AUTH_MODE_OPTIONS[2];
}

function authModeStatus({ mode, readiness, feishuWeb, feishuMcp }) {
  if (mode === "web") {
    if (!feishuWeb?.checked) return { ok: false, label: "待检测", detail: "进入页面不会自动弹出受控浏览器" };
    if (feishuWeb?.valid) return { ok: true, label: "已登录", detail: "当前 Puppeteer profile 可访问飞书项目" };
    if (feishuWeb?.skippedBrowserLaunch) return { ok: false, label: "待确认", detail: "已跳过自动弹窗检测，点击飞书网页登录后确认" };
    return { ok: false, label: "未就绪", detail: feishuWeb?.reason || "需要点击飞书网页登录" };
  }
  if (mode === "mcp") {
    return feishuMcpConnectionStatus(feishuMcp);
  }
  return readiness?.feishuReady
    ? { ok: true, label: "已就绪", detail: "插件凭据可用" }
    : { ok: false, label: "未就绪", detail: "需要配置 Plugin ID/Secret/User Key" };
}

function FeishuReadModeSwitcher({
  value,
  onChange,
  canEdit,
  readiness,
  feishuWeb,
  feishuMcp,
  onWebLogin,
  compact = false,
}) {
  const active = value || "plugin";
  const activeStatus = authModeStatus({ mode: active, readiness, feishuWeb, feishuMcp });
  return (
    <div className={`rounded border border-zinc-800 bg-zinc-950/80 ${compact ? "p-2.5" : "p-3"}`}>
      <div className="flex flex-wrap items-center gap-2">
        <div className="min-w-0 flex-1">
          <div className="text-xs font-medium text-zinc-100">飞书读取模式</div>
          <div className="mt-0.5 truncate text-[11px] text-zinc-500" title={authModeOption(active).detail}>
            当前：{modeLabel(active)} · {activeStatus.detail}
          </div>
        </div>
        <span className={`rounded px-2 py-0.5 text-[11px] ${activeStatus.ok ? "bg-emerald-500/15 text-emerald-300" : "bg-amber-500/15 text-amber-300"}`}>
          {activeStatus.label}
        </span>
      </div>
      <div className={`mt-2 grid gap-1.5 ${compact ? "sm:grid-cols-3" : "md:grid-cols-3"}`}>
        {FEISHU_AUTH_MODE_OPTIONS.map((option) => {
          const selected = active === option.value;
          const status = authModeStatus({ mode: option.value, readiness, feishuWeb, feishuMcp });
          return (
            <button
              key={option.value}
              type="button"
              onClick={() => onChange?.(option.value)}
              disabled={!canEdit}
              title={option.detail}
              className={`min-h-16 rounded border px-3 py-2 text-left transition ${
                selected
                  ? "border-blue-500/70 bg-blue-500/15 text-blue-100"
                  : "border-zinc-800 bg-zinc-900/55 text-zinc-300 hover:border-zinc-600 hover:bg-zinc-800"
              } disabled:border-zinc-800 disabled:bg-zinc-900 disabled:text-zinc-600`}
            >
              <div className="flex items-center gap-2">
                <span className={`h-1.5 w-1.5 rounded-full ${status.ok ? "bg-emerald-400" : "bg-amber-400"}`} />
                <span className="min-w-0 truncate text-xs font-medium">{option.label}</span>
                {selected && <span className="ml-auto rounded bg-blue-400/20 px-1.5 py-0.5 text-[10px] text-blue-200">当前</span>}
              </div>
              {!compact && <div className="mt-1 line-clamp-2 text-[11px] leading-relaxed text-zinc-500">{option.detail}</div>}
            </button>
          );
        })}
      </div>
      {active === "web" && (
        <div className="mt-2 flex flex-col gap-2 rounded border border-amber-800/50 bg-amber-950/20 px-3 py-2 text-[11px] leading-relaxed text-amber-100 sm:flex-row sm:items-center sm:justify-between">
          <span className="min-w-0">Web 模式使用本项目 Puppeteer profile；普通浏览器已登录不代表这里已登录。</span>
          <button
            type="button"
            onClick={onWebLogin}
            disabled={!canEdit}
            className="shrink-0 rounded bg-amber-600 px-2.5 py-1 text-[11px] font-medium text-white hover:bg-amber-500 disabled:bg-zinc-800 disabled:text-zinc-500"
          >
            飞书网页登录
          </button>
        </div>
      )}
      {active === "web" && feishuWeb?.checked && !feishuWeb?.valid && (
        <div className="mt-2">
          <FeishuWebProfileWarning compact />
        </div>
      )}
    </div>
  );
}

function OverviewTile({ title, lines, children }) {
  return (
    <div className="rounded border border-zinc-800 bg-zinc-950 p-3">
      <div className="mb-2 text-xs font-medium text-zinc-100">{title}</div>
      <div className="space-y-1 text-[11px] text-zinc-400">
        {(lines || []).map((line) => <div key={line} className="truncate">{line}</div>)}
      </div>
      {children}
    </div>
  );
}

function FixedTbMembersSummary({ members = [] }) {
  if (!members.length) {
    return (
      <div className="mt-2 rounded border border-zinc-800 bg-zinc-900/45 px-2 py-1.5 text-[11px] text-zinc-400">
        固定参与者：按人员映射自动解析
      </div>
    );
  }
  return (
    <div className="mt-2 rounded border border-zinc-800 bg-zinc-900/45 p-2">
      <div className="text-[11px] text-zinc-500">固定参与者</div>
      <div className="mt-1.5 flex flex-wrap gap-1.5">
        {members.map((member) => (
          <span
            key={member.id}
            className={`inline-flex max-w-full items-center gap-1.5 rounded border px-2 py-1 text-[11px] ${member.resolved ? "border-emerald-800/50 bg-emerald-950/20 text-emerald-200" : "border-amber-800/50 bg-amber-950/20 text-amber-200"}`}
            title={`${member.displayName} (${member.id})`}
          >
            <span className="min-w-0 truncate">{member.displayName}</span>
          </span>
        ))}
      </div>
    </div>
  );
}

function Metric({ label, value, tone = "" }) {
  const cls = tone === "warn" ? "text-amber-300" : tone === "ok" ? "text-emerald-300" : "text-zinc-100";
  return (
    <div className="rounded border border-zinc-800 bg-zinc-950 px-3 py-2">
      <div className={`text-lg font-semibold ${cls}`}>{value}</div>
      <div className="text-[11px] text-zinc-500">{label}</div>
    </div>
  );
}

function OverviewRows({ rows }) {
  return (
    <div className="space-y-1">
      {rows.map(([label, value]) => (
        <div key={label} className="grid grid-cols-[92px_1fr] gap-2">
          <span className="text-zinc-600">{label}</span>
          <span className="min-w-0 break-all text-zinc-300">{String(value || "-")}</span>
        </div>
      ))}
    </div>
  );
}

function MappingSummary({ title, map, resolveValue = stringifyScalar }) {
  const entries = Object.entries(map || {}).slice(0, 8);
  return (
    <div className="rounded border border-zinc-800 bg-zinc-950 p-3">
      <div className="mb-2 flex items-center gap-2">
        <div className="text-xs font-medium text-zinc-100">{title}</div>
        <span className="ml-auto rounded bg-zinc-800 px-2 py-0.5 text-[10px] text-zinc-400">{Object.keys(map || {}).length}</span>
      </div>
      <div className="space-y-1 text-[11px]">
        {entries.map(([key, value]) => (
          <div key={key} className="rounded border border-zinc-900 bg-zinc-900/35 px-2 py-1.5">
            <div className="grid grid-cols-[1fr_auto_1fr] gap-2">
              <span className="truncate text-zinc-400" title={String(key)}>{looksLikeOpaqueIdentifier(key) ? "来源名称未解析" : key}</span>
              <span className="text-zinc-700">→</span>
              <span className="truncate text-zinc-200" title={stringifyScalar(value)}>{resolveValue(value)}</span>
            </div>
            {(looksLikeOpaqueIdentifier(key) || looksLikeOpaqueIdentifier(stringifyScalar(value))) && (
              <details className="mt-1 text-[9px] text-zinc-600">
                <summary className="cursor-pointer">查看技术标识</summary>
                <code className="mt-1 block break-all">{key} → {stringifyScalar(value)}</code>
              </details>
            )}
          </div>
        ))}
        {!entries.length && <div className="py-3 text-center text-zinc-600">暂无映射</div>}
      </div>
    </div>
  );
}

function describeAttachmentMode(mode) {
  if (["upload", "download_upload", "file_upload"].includes(String(mode || "").toLowerCase())) return "下载后上传到 TB";
  if (["skip", "none"].includes(String(mode || "").toLowerCase())) return "跳过";
  return "评论里保留飞书链接";
}

function MissingAndLoginPanel({
  readiness,
  canEdit,
  config,
  tbLogin,
  tbProjects,
  feishuWeb,
  feishuMcp,
  onTbLogin,
  onOpenTbProjectPicker,
  onLoadTbProjects,
  onSelectTbProject,
  onFeishuWebLogin,
  onMcpTokenFromWeb,
  onMcpDesktopAuthorize,
  onOpenRules,
}) {
  const missing = visibleMissingForAuthMode(readiness, config);
  const feishuCredentialMissing = missing.some((key) => key.startsWith("feishu."));
  const authMode = getPath(config || {}, "feishu.authMode", readiness?.authMode || "plugin");
  const tbValid = !!tbLogin?.valid;
  const tbChecking = !tbLogin?.checked;
  const tbRefreshing = !!tbLogin?.refreshing;
  const feishuWebValid = !!feishuWeb?.valid;
  const feishuWebChecking = !feishuWeb?.checked;
  const feishuWebRefreshing = !!feishuWeb?.refreshing;
  const feishuWebSkipped = !!feishuWeb?.skippedBrowserLaunch;
  const mcpConfigured = !!feishuMcp?.configured;
  const mcpConnected = !!feishuMcp?.connected;
  const mcpChecking = !feishuMcp?.checked;
  const mcpNeedsAuthorization = !!feishuMcp?.needsAuthorization;
  const mcpStatusText = mcpChecking
    ? "MCP 检测中"
    : feishuMcp?.degraded
      ? (mcpConnected ? "MCP 最近已连接" : "MCP 状态待确认")
    : mcpConnected
      ? "MCP 已连接"
      : mcpNeedsAuthorization
        ? "MCP 需要授权"
        : mcpConfigured
          ? "MCP 未连通"
          : "MCP 未配置";
  const mcpDetail = mcpConnected
    ? (feishuMcp?.degraded
      ? (feishuMcp?.error || "本次检测失败，沿用最近一次成功状态")
      : `${feishuMcp.toolCount || 0} tools · ${feishuMcp.effectiveTransport || feishuMcp.transport || "http-oauth"}`)
    : mcpNeedsAuthorization
      ? "HTTP OAuth Server 已响应，需要完成 OAuth 或配置 X-Mcp-Token 回退"
      : mcpConfigured
        ? (feishuMcp?.error || "已配置 Server URL，等待连接验证")
        : "使用 https://project.feishu.cn/mcp_server/v1";
  const tbStatusText = tbRefreshing
    ? "TB 登录中"
    : tbChecking
      ? "TB 检测中"
      : tbValid
        ? "TB 已登录"
        : "TB 未登录";
  const tbDetail = tbRefreshing
    ? "请在弹出的浏览器窗口完成登录"
    : tbChecking
      ? "正在检测 TB Cookie"
      : tbValid
        ? `${tbLogin.user || "当前账号"} · Cookie 有效`
        : (tbLogin?.reason || "未检测到有效 TB Cookie");
  const feishuWebStatusText = feishuWebRefreshing
    ? "飞书登录中"
    : feishuWebChecking
      ? "飞书检测中"
      : feishuWebValid
        ? "飞书个人态已登录"
        : feishuWebSkipped
          ? "飞书网页态待确认"
          : "飞书个人态未登录";
  const feishuWebDetail = feishuWebRefreshing
    ? "请在弹出的浏览器窗口完成飞书登录"
    : feishuWebChecking
      ? "静默读取状态，不会自动打开受控浏览器"
      : feishuWebValid
        ? "当前浏览器 Profile 可访问飞书项目"
        : feishuWebSkipped
          ? "进入页面已跳过自动弹窗；需要网页态时点击此卡片打开飞书网页登录"
        : (feishuWeb?.reason || "未检测到有效飞书网页登录态");
  const feishuWebProfileWarning = feishuWebSkipped
    ? ""
    : authMode === "web" && !feishuWebChecking && !feishuWebRefreshing && !feishuWebValid
      ? FEISHU_WEB_PROFILE_WARNING
      : feishuWebProfileWarningForText(`${feishuWeb?.reason || ""}\n${feishuWeb?.error || ""}`);
  return (
    <div className="grid gap-3 2xl:grid-cols-[minmax(320px,0.9fr)_minmax(720px,1.5fr)]">
      <section className="rounded border border-zinc-800 bg-zinc-900/60 p-3">
        <div className="mb-2 flex items-center gap-2">
          <h2 className="text-sm font-medium text-zinc-100">缺失配置</h2>
          <span className={`rounded border px-2 py-0.5 text-[11px] ${missing.length ? "border-amber-700/50 bg-amber-900/20 text-amber-300" : "border-emerald-700/50 bg-emerald-900/20 text-emerald-300"}`}>
            {missing.length ? `${missing.length} 项缺失` : "配置完整"}
          </span>
        </div>
        {missing.length ? (
          <div className="space-y-2">
            {missing.map((key) => (
              <div key={key} className="rounded bg-zinc-950 px-2 py-1.5 text-xs">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="h-1.5 w-1.5 rounded-full bg-amber-400" />
                  <span className="text-zinc-200">{MISSING_LABELS[key] || key}</span>
                  <code className="ml-auto text-[10px] text-zinc-500">{key}</code>
                  {key === "teambition.projectId" && (
                    <button
                      type="button"
                      onClick={onOpenTbProjectPicker}
                      disabled={!canEdit}
                      className="rounded border border-amber-600/50 bg-amber-500/10 px-2 py-1 text-[11px] text-amber-200 hover:bg-amber-500/20 disabled:border-zinc-700 disabled:bg-zinc-900 disabled:text-zinc-500"
                    >
                      去设置
                    </button>
                  )}
                </div>
                {key === "teambition.projectId" && tbProjects?.pickerOpen && (
                  <div className="mt-2">
                    <TbProjectPicker
                      config={config}
                      tbProjects={tbProjects}
                      canEdit={canEdit}
                      compact
                      onLoadTbProjects={() => onLoadTbProjects({ open: true })}
                      onSelectTbProject={onSelectTbProject}
                      onTbLogin={onTbLogin}
                    />
                  </div>
                )}
              </div>
            ))}
          </div>
        ) : (
          <div className="text-xs text-zinc-500">飞书项目插件凭证和 TB 目标项目已满足同步前置条件。</div>
        )}
      </section>

      <section className="rounded border border-zinc-800 bg-zinc-900/60 p-3">
        <div className="mb-2 flex items-center gap-2">
          <h2 className="text-sm font-medium text-zinc-100">登录入口</h2>
          <span className={`rounded border px-2 py-0.5 text-[11px] ${canEdit ? "border-emerald-700/50 bg-emerald-900/20 text-emerald-300" : "border-zinc-700 bg-zinc-950 text-zinc-400"}`}>
            {canEdit ? "管理员可编辑" : "未登录只读"}
          </span>
        </div>
        <div className="grid grid-cols-[repeat(auto-fit,minmax(220px,1fr))] gap-3">
          <Link to="/admin" className="flex min-h-24 min-w-0 flex-col rounded border border-zinc-700 bg-zinc-950 px-3 py-2.5 text-xs text-zinc-200 hover:bg-zinc-800">
            <span className="font-medium">管理后台登录</span>
            <div className="mt-1 text-[10px] leading-relaxed text-zinc-500">保存规则、dry-run、/run</div>
          </Link>
          <button
            onClick={onTbLogin}
            className={`flex min-h-24 min-w-0 flex-col rounded border px-3 py-2.5 text-left text-xs hover:bg-zinc-800 ${tbValid ? "border-emerald-700/60 bg-emerald-950/20 text-emerald-200" : "border-zinc-700 bg-zinc-950 text-zinc-200"}`}
          >
            <span className="flex min-w-0 items-center justify-between gap-2">
              <span className="min-w-0 truncate font-medium">{tbStatusText}</span>
              {tbValid && <span className="rounded bg-emerald-500/15 px-1.5 py-0.5 text-[10px] text-emerald-300">有效</span>}
            </span>
            <div className={`mt-1 break-words text-[10px] leading-relaxed ${tbValid ? "text-emerald-300/80" : "text-zinc-500"}`}>{tbDetail}</div>
            <div className="mt-auto pt-1 text-[10px] leading-relaxed text-zinc-500">{tbValid ? "点击可刷新 TB 登录态" : "点击打开 TB 扫码登录"}</div>
          </button>
          <button
            onClick={onFeishuWebLogin}
            className={`flex min-h-24 min-w-0 flex-col rounded border px-3 py-2.5 text-left text-xs hover:bg-zinc-800 ${feishuWebValid ? "border-emerald-700/60 bg-emerald-950/20 text-emerald-200" : feishuWebSkipped ? "border-amber-800/60 bg-amber-950/15 text-amber-100" : "border-zinc-700 bg-zinc-950 text-zinc-200"}`}
          >
            <span className="flex min-w-0 items-center justify-between gap-2">
              <span className="min-w-0 truncate font-medium">{feishuWebStatusText}</span>
              {authMode === "web" && <span className="rounded bg-blue-500/15 px-1.5 py-0.5 text-[10px] text-blue-300">网页态</span>}
              {feishuWebValid && <span className="rounded bg-emerald-500/15 px-1.5 py-0.5 text-[10px] text-emerald-300">有效</span>}
            </span>
            <div className={`mt-1 break-words text-[10px] leading-relaxed ${feishuWebValid ? "text-emerald-300/80" : feishuWebSkipped ? "text-amber-200/80" : "text-zinc-500"}`}>{feishuWebDetail}</div>
            <div className="mt-auto pt-1 text-[10px] leading-relaxed text-zinc-500">{feishuWebValid ? "点击可刷新飞书网页登录态" : "点击打开飞书网页登录（只在点击时弹窗）"}</div>
          </button>
          <div
            className={`flex min-h-24 min-w-0 flex-col rounded border px-3 py-2.5 text-left text-xs hover:bg-zinc-800 ${mcpConnected ? "border-emerald-700/60 bg-emerald-950/20 text-emerald-200" : mcpNeedsAuthorization ? "border-amber-700/60 bg-amber-950/20 text-amber-200" : "border-zinc-700 bg-zinc-950 text-zinc-200"}`}
          >
            <span className="flex min-w-0 items-center justify-between gap-2">
              <span className="min-w-0 truncate font-medium">{mcpStatusText}</span>
              {authMode === "mcp" && <span className="rounded bg-blue-500/15 px-1.5 py-0.5 text-[10px] text-blue-300">MCP</span>}
              {mcpConnected && <span className="rounded bg-emerald-500/15 px-1.5 py-0.5 text-[10px] text-emerald-300">可用</span>}
            </span>
            <div className={`mt-1 break-words text-[10px] leading-relaxed ${mcpConnected ? "text-emerald-300/80" : mcpNeedsAuthorization ? "text-amber-300/80" : "text-zinc-500"}`}>{mcpDetail}</div>
            <div className="mt-auto flex flex-wrap gap-2 pt-2">
              <button
                type="button"
                onClick={onMcpTokenFromWeb}
                disabled={!canEdit}
                className="rounded bg-sky-700 px-2 py-1 text-[10px] text-white hover:bg-sky-600 disabled:bg-zinc-800 disabled:text-zinc-500"
              >
                从网页登录态获取 Token
              </button>
              <button
                type="button"
                onClick={onMcpDesktopAuthorize}
                disabled={!canEdit}
                className="rounded border border-sky-700/70 bg-sky-950/30 px-2 py-1 text-[10px] text-sky-200 hover:bg-sky-900/40 disabled:border-zinc-800 disabled:bg-zinc-900 disabled:text-zinc-500"
              >
                用已登录飞书授权
              </button>
              <a href="https://project.feishu.cn/b/mcp" target="_blank" rel="noreferrer" className="rounded border border-zinc-700 px-2 py-1 text-[10px] text-zinc-300 hover:bg-zinc-800">
                打开 MCP 页
              </a>
            </div>
            <div className="mt-1 text-[10px] text-zinc-500">{feishuMcp?.hasHeaderToken ? "已配置 Header Token 回退" : "未写入 Header Token"}</div>
          </div>
        </div>
        {feishuWebProfileWarning && (
          <div className="mt-2">
            <FeishuWebProfileWarning message={feishuWebProfileWarning} />
          </div>
        )}
        <div className={`mt-2 rounded border px-3 py-2 text-[11px] leading-relaxed ${feishuCredentialMissing ? "border-amber-800/50 bg-amber-950/20 text-amber-200" : "border-zinc-800 bg-zinc-950/40 text-zinc-500"}`}>
          插件 OpenAPI 模式需要 Plugin ID/Secret/User Key；个人网页登录态模式使用你当前能看到的飞书项目页面做只读采集；MCP 模式优先连接 HTTP OAuth Server，并可用 X-Mcp-Token 作为回退。
          <button type="button" onClick={onOpenRules} className="ml-2 text-blue-300 hover:text-blue-200">
            去基础规则
          </button>
        </div>
        <div className="mt-2 flex flex-wrap gap-2 text-[10px] text-zinc-500">
          <a href={sourceViewUrl(config || {})} target="_blank" rel="noreferrer" className="text-blue-300 hover:text-blue-200">打开默认飞书来源视图</a>
          <a href="https://project.feishu.cn/b/mcp" target="_blank" rel="noreferrer" className="text-blue-300 hover:text-blue-200">打开飞书 MCP 配置页</a>
          <span>网页登录态不会产生插件密钥；网页态 dry-run 会在 Payload 预览中读取当前可见数据。</span>
        </div>
      </section>
    </div>
  );
}

function Section({ title, children, right }) {
  return (
    <section className="rounded border border-zinc-800 bg-zinc-900/60">
      <div className="flex items-center gap-2 border-b border-zinc-800 px-4 py-3">
        <h2 className="text-sm font-medium text-zinc-100">{title}</h2>
        {right && <div className="ml-auto">{right}</div>}
      </div>
      <div className="p-4">{children}</div>
    </section>
  );
}

function TextInput({ label, value, onChange, type = "text", mono = false, placeholder = "" }) {
  return (
    <label className="block min-w-0">
      <span className="mb-1 block text-[11px] text-zinc-500">{label}</span>
      <input
        type={type}
        value={value ?? ""}
        placeholder={placeholder}
        onChange={(e) => onChange(type === "number" ? Number(e.target.value || 0) : e.target.value)}
        className={`h-9 w-full rounded border border-zinc-700 bg-zinc-950 px-2.5 text-xs text-zinc-200 outline-none focus:border-blue-500 ${mono ? "font-mono" : ""}`}
      />
    </label>
  );
}

function SelectInput({ label, value, onChange, options = [] }) {
  return (
    <label className="block min-w-0">
      <span className="mb-1 block text-[11px] text-zinc-500">{label}</span>
      <select
        value={value ?? ""}
        onChange={(e) => onChange(e.target.value)}
        className="h-9 w-full rounded border border-zinc-700 bg-zinc-950 px-2.5 text-xs text-zinc-200 outline-none focus:border-blue-500"
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>{option.label}</option>
        ))}
      </select>
    </label>
  );
}

function Toggle({ label, checked, onChange }) {
  return (
    <label className="flex items-center gap-2 rounded border border-zinc-800 bg-zinc-950 px-3 py-2 text-xs text-zinc-300">
      <input type="checkbox" checked={!!checked} onChange={(e) => onChange(e.target.checked)} className="h-4 w-4 accent-blue-600" />
      <span>{label}</span>
    </label>
  );
}

function TbProjectPicker({ config, tbProjects, canEdit, compact = false, onLoadTbProjects, onSelectTbProject, onTbLogin }) {
  const currentProjectId = getPath(config || {}, "teambition.projectId", "");
  const projects = tbProjects?.projects || [];
  const selected = projects.find((project) => String(project.id) === String(currentProjectId));
  const configuredName = String(getPath(config || {}, "teambition.projectName", "") || pathHead(getPath(config || {}, "teambition.projectPathName", ""))).trim();
  const loading = !!tbProjects?.loading;
  const saving = !!tbProjects?.savingProjectId;
  const error = tbProjects?.error || "";
  return (
    <div className={`rounded border border-zinc-800 bg-zinc-950 ${compact ? "p-2" : "p-3"}`}>
      <div className="flex flex-wrap items-center gap-2">
        <div className="min-w-0">
          <div className="text-xs font-medium text-zinc-200">TB 测试项目</div>
          <div className="mt-0.5 text-[11px] text-zinc-500">
            {currentProjectId
              ? selected?.name || configuredName || "项目名称未解析（请刷新项目列表）"
              : "请选择要写入转载飞书单的 Teambition 测试项目"}
          </div>
        </div>
        <button
          type="button"
          onClick={() => onLoadTbProjects?.({ open: true })}
          disabled={!canEdit || loading}
          className="ml-auto rounded border border-zinc-700 bg-zinc-900 px-2.5 py-1.5 text-[11px] text-zinc-200 hover:bg-zinc-800 disabled:text-zinc-500"
        >
          {loading ? "读取中" : projects.length ? "刷新项目" : "读取项目"}
        </button>
        {onTbLogin && (
          <button
            type="button"
            onClick={onTbLogin}
            className="rounded border border-zinc-700 bg-zinc-900 px-2.5 py-1.5 text-[11px] text-zinc-200 hover:bg-zinc-800"
          >
            TB 登录
          </button>
        )}
      </div>
      <div className="mt-2 grid gap-2 md:grid-cols-[1fr_auto]">
        <select
          value={currentProjectId}
          onChange={(e) => onSelectTbProject?.(e.target.value)}
          disabled={!canEdit || loading || saving || !projects.length}
          className="h-9 min-w-0 rounded border border-zinc-700 bg-zinc-900 px-2 text-xs text-zinc-100 outline-none focus:border-blue-500 disabled:text-zinc-500"
        >
          <option value="">{projects.length ? "选择 TB 项目" : "先读取当前账号可见项目"}</option>
          {projects.map((project) => (
            <option key={project.id} value={project.id}>{project.name || "项目名称未解析"}</option>
          ))}
        </select>
        <span className={`inline-flex h-9 items-center rounded border px-2 text-[11px] ${currentProjectId ? "border-emerald-700/50 bg-emerald-900/20 text-emerald-300" : "border-amber-700/50 bg-amber-900/20 text-amber-300"}`}>
          {saving ? "保存中" : currentProjectId ? "已配置" : "未配置"}
        </span>
      </div>
      {currentProjectId && (
        <details className="mt-2 text-[10px] text-zinc-600">
          <summary className="cursor-pointer">查看项目技术标识</summary>
          <code className="mt-1 block break-all">{currentProjectId}</code>
        </details>
      )}
      {error && <div className="mt-2 text-[11px] text-red-300">{error}</div>}
      {!canEdit && <div className="mt-2 text-[11px] text-zinc-500">需要管理员登录后才能读取项目并保存配置。</div>}
    </div>
  );
}

function TbTasklistPicker({
  config,
  tbProjects,
  tbTasklists,
  canEdit,
  compact = false,
  onLoadTbTasklists,
  onSelectTbTasklist,
}) {
  const projectId = String(getPath(config || {}, "teambition.projectId", "")).trim();
  const tasklistId = String(getPath(config || {}, "teambition.tasklistId", "")).trim();
  const tasklistName = String(getPath(config || {}, "teambition.tasklistName", "")).trim();
  const configuredPath = String(getPath(config || {}, "teambition.projectPathName", "")).trim();
  const projectName = (tbProjects?.projects || []).find((project) => String(project.id) === projectId)?.name || configuredPath.split("/")[0]?.trim() || "";
  const allProjectMode = tbTasklists?.loadedProjectId === "*";
  const tasklists = (tbTasklists?.tasklists || []).filter((tasklist) => {
    if (allProjectMode) return true;
    const itemProjectId = String(tasklist.projectId || "").trim();
    return !projectId || !itemProjectId || itemProjectId === projectId || tbTasklists?.loadedProjectId === projectId;
  });
  const selected = tasklists.find((tasklist) => String(tasklist.id || tasklist.tasklistId) === tasklistId);
  const loading = !!tbTasklists?.loading;
  const saving = !!tbTasklists?.savingTasklistId;
  const error = tbTasklists?.error || "";
  const displayPath = selected?.pathName
    || [selected?.projectName || projectName, selected?.name || tasklistName].filter(Boolean).join(" / ")
    || configuredPath
    || (tasklistId ? "任务列表名称未解析（请刷新下拉）" : "");

  return (
    <div className={`rounded border border-zinc-800 bg-zinc-950 ${compact ? "p-2" : "p-3"}`}>
      <div className="flex flex-wrap items-start gap-2">
        <div className="min-w-0 flex-1">
          <div className="text-xs font-medium text-zinc-200">同步后的 TB 项目</div>
          <div className="mt-0.5 truncate text-[11px] text-zinc-500">{displayPath || "请选择 TB 项目 / 任务列表"}</div>
        </div>
        <button
          type="button"
          onClick={() => onLoadTbTasklists?.({ allProjects: true, refresh: true })}
          disabled={!canEdit || loading}
          className="rounded border border-zinc-700 bg-zinc-900 px-2.5 py-1.5 text-[11px] text-zinc-200 hover:bg-zinc-800 disabled:text-zinc-500"
        >
          {loading ? "读取中" : tasklists.length ? "刷新下拉" : "读取下拉"}
        </button>
      </div>
      <select
        value={selected?.id || tasklistId || ""}
        onFocus={() => {
          if (canEdit && (!tbTasklists?.loaded || tbTasklists?.loadedProjectId !== "*") && !loading) onLoadTbTasklists?.({ allProjects: true });
        }}
        onChange={(event) => {
          const hit = tasklists.find((tasklist) => String(tasklist.id || tasklist.tasklistId) === event.target.value);
          if (hit) onSelectTbTasklist?.(hit);
        }}
        disabled={!canEdit || loading || saving}
        className="mt-3 h-9 w-full rounded border border-zinc-700 bg-zinc-900 px-2.5 text-xs text-zinc-200 outline-none focus:border-blue-500 disabled:text-zinc-500"
      >
        <option value={tasklistId}>{displayPath || "当前配置未命名"}</option>
        {tasklists.filter((tasklist) => String(tasklist.id || tasklist.tasklistId || "") !== tasklistId).map((tasklist) => {
          const id = String(tasklist.id || tasklist.tasklistId || "");
          const label = tasklist.pathName || [tasklist.projectName || projectName, tasklist.name || tasklist.title].filter(Boolean).join(" / ") || "任务列表名称未解析";
          return <option key={id} value={id}>{label}</option>;
        })}
      </select>
      <div className="mt-2 flex flex-wrap gap-2 text-[10px] text-zinc-500">
        <span className={`rounded border px-2 py-0.5 ${saving ? "border-amber-700/50 bg-amber-900/20 text-amber-300" : "border-emerald-700/50 bg-emerald-900/20 text-emerald-300"}`}>
          {saving ? "保存中" : tasklistId ? "已配置" : "未配置"}
        </span>
      </div>
      {tasklistId && (
        <details className="mt-2 text-[10px] text-zinc-600">
          <summary className="cursor-pointer">查看任务列表技术标识</summary>
          <code className="mt-1 block break-all">{tasklistId}</code>
        </details>
      )}
      {error && <div className="mt-2 text-[11px] text-red-300">{error}</div>}
    </div>
  );
}

function TbSprintPicker({
  config,
  tbSprints,
  canEdit,
  compact = false,
  value = null,
  projectId = "",
  onLoadTbSprints,
  onSelectTbSprint,
  onChange,
}) {
  const [query, setQuery] = useState("");
  const fallback = tbSprintForUi(config || {});
  const currentProjectId = String(projectId || fallback.projectId || getPath(config || {}, "teambition.projectId", "")).trim();
  const selectedSprintId = String(value?.sprintId || value?.id || fallback.sprintId || "").trim();
  const selectedName = String(value?.name || value?.title || fallback.name || "").trim();
  const sprints = (tbSprints?.sprints || []).filter((sprint) => {
    const sprintProjectId = String(sprint.projectId || "").trim();
    return !currentProjectId || !sprintProjectId || sprintProjectId === currentProjectId || tbSprints?.loadedProjectId === currentProjectId;
  });
  const loading = !!tbSprints?.loading;
  const saving = !!tbSprints?.savingSprintId;
  const error = tbSprints?.error || "";
  const q = query.trim().toLowerCase();
  const filtered = sprints.filter((sprint) => {
    if (!q) return true;
    return [sprint.name, sprint.id, sprint.status, sprint.dueDate]
      .map((part) => String(part || "").toLowerCase())
      .some((text) => text.includes(q));
  }).slice(0, 80);
  const selected = sprints.find((sprint) => String(sprint.id || sprint.sprintId) === selectedSprintId);

  const commitSprint = (sprint) => {
    const normalized = {
      id: String(sprint?.id || sprint?.sprintId || "").trim(),
      sprintId: String(sprint?.sprintId || sprint?.id || "").trim(),
      name: String(sprint?.name || sprint?.title || "").trim(),
      title: String(sprint?.title || sprint?.name || "").trim(),
      projectId: String(sprint?.projectId || currentProjectId || "").trim(),
      url: String(sprint?.url || teambitionSprintUrl(sprint?.projectId || currentProjectId, sprint?.id || sprint?.sprintId) || "").trim(),
    };
    if (!normalized.id) return;
    if (onChange) onChange(normalized);
    else onSelectTbSprint?.(normalized);
  };

  const useDefaultSprint = () => commitSprint({
    id: fallback.sprintId,
    sprintId: fallback.sprintId,
    name: fallback.name,
    projectId: fallback.projectId,
    url: fallback.url,
  });

  return (
    <div className={`rounded border border-zinc-800 bg-zinc-950 ${compact ? "p-2" : "p-3"}`}>
      <div className="flex flex-wrap items-start gap-2">
        <div className="min-w-0 flex-1">
          <div className="text-xs font-medium text-zinc-200">TB 目标迭代</div>
          <div className="mt-0.5 truncate text-[11px] text-zinc-500">
            {selectedName || selected?.name || (selectedSprintId ? "迭代名称未解析（请刷新迭代列表）" : "请选择新建 TB 单写入的迭代")}
          </div>
        </div>
        <button
          type="button"
          onClick={() => onLoadTbSprints?.({ projectId: currentProjectId, refresh: true })}
          disabled={!canEdit || loading || !currentProjectId}
          className="rounded border border-zinc-700 bg-zinc-900 px-2.5 py-1.5 text-[11px] text-zinc-200 hover:bg-zinc-800 disabled:text-zinc-500"
        >
          {loading ? "读取中" : sprints.length ? "刷新迭代" : "读取迭代"}
        </button>
        {fallback.sprintId && (
          <button
            type="button"
            onClick={useDefaultSprint}
            disabled={!canEdit || saving}
            className="rounded border border-zinc-700 bg-zinc-900 px-2.5 py-1.5 text-[11px] text-zinc-200 hover:bg-zinc-800 disabled:text-zinc-500"
          >
            使用默认迭代
          </button>
        )}
      </div>
      <div className="mt-3">
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onFocus={() => {
            if (canEdit && currentProjectId && (!tbSprints?.loaded || tbSprints?.loadedProjectId !== currentProjectId) && !loading) onLoadTbSprints?.({ projectId: currentProjectId });
          }}
          placeholder="搜索迭代名称 / 状态 / 日期（也支持技术 ID）"
          className="h-9 w-full rounded border border-zinc-700 bg-zinc-900 px-2.5 text-xs text-zinc-200 outline-none focus:border-blue-500"
        />
      </div>
      <div className="mt-2 max-h-56 overflow-auto rounded border border-zinc-800">
        {filtered.length ? filtered.map((sprint) => {
          const id = String(sprint.id || sprint.sprintId || "");
          const active = id && id === selectedSprintId;
          return (
            <button
              type="button"
              key={id}
              onClick={() => commitSprint(sprint)}
              disabled={!canEdit || saving}
              className={`flex w-full min-w-0 items-start gap-2 border-b border-zinc-900 px-2.5 py-2 text-left text-xs last:border-b-0 hover:bg-zinc-900 disabled:text-zinc-600 ${active ? "bg-emerald-950/30 text-emerald-200" : "text-zinc-200"}`}
            >
              <span className={`mt-1 h-2 w-2 flex-none rounded-full ${active ? "bg-emerald-400" : "bg-zinc-700"}`} />
              <span className="min-w-0 flex-1">
                <span className="block truncate font-medium" title={id}>{sprint.name || "迭代名称未解析"}</span>
                <span className="mt-0.5 block truncate text-[10px] text-zinc-500">
                  {[sprint.status, sprint.dueDate].filter(Boolean).join(" · ") || "无附加说明"}
                </span>
              </span>
            </button>
          );
        }) : (
          <div className="px-3 py-6 text-center text-xs text-zinc-600">
            {loading ? "正在读取迭代列表..." : query ? "没有匹配的迭代" : "读取迭代后可搜索选择"}
          </div>
        )}
      </div>
      {selectedSprintId && (
        <div className="mt-2 flex flex-wrap items-center gap-2 text-[10px] text-zinc-500">
          <span className={`rounded border px-2 py-0.5 ${saving ? "border-amber-700/50 bg-amber-900/20 text-amber-300" : "border-emerald-700/50 bg-emerald-900/20 text-emerald-300"}`}>
            {saving ? "保存中" : "已配置"}
          </span>
          {(selected?.url || fallback.url || value?.url) && (
            <a href={selected?.url || fallback.url || value?.url} target="_blank" rel="noreferrer" className="text-blue-300 hover:text-blue-200">
              打开迭代
            </a>
          )}
        </div>
      )}
      {selectedSprintId && (
        <details className="mt-2 text-[10px] text-zinc-600">
          <summary className="cursor-pointer">查看迭代技术标识</summary>
          <code className="mt-1 block break-all">{selectedSprintId}</code>
        </details>
      )}
      {error && <div className="mt-2 text-[11px] text-red-300">{error}</div>}
    </div>
  );
}

function TbMemberPicker({
  config,
  tbMembers,
  canEdit,
  onQueryChange,
  onLoadTbMembers,
  onSelectTbMember,
  onRemoveTbMember,
}) {
  const requiredIds = normalizeListValue(getPath(config || {}, "teambition.requiredInvolveMembers", []));
  const members = tbMembers?.members || [];
  const selectedMembers = Object.values(tbMembers?.selectedById || {});
  const loading = !!tbMembers?.loading;
  const resolving = !!tbMembers?.resolving;
  const savingMemberId = tbMembers?.savingMemberId || "";
  const error = tbMembers?.error || "";
  const query = tbMembers?.query ?? "徐博超";
  const byId = new Map([...selectedMembers, ...members].map((member) => [String(member.id), member]));
  const runSearch = (refresh = false) => onLoadTbMembers?.({ query, refresh });
  return (
    <div className="rounded border border-zinc-800 bg-zinc-950 p-3">
      <div className="flex flex-wrap items-start gap-2">
        <div className="min-w-0 flex-1">
          <div className="text-xs font-medium text-zinc-200">固定 TB 参与者</div>
          <div className="mt-0.5 text-[11px] leading-relaxed text-zinc-500">按姓名搜索并加入成员；系统在后台保存技术标识，同步创建/更新 TB 单时都会追加这些参与者。</div>
        </div>
        <span className={`rounded border px-2 py-0.5 text-[11px] ${requiredIds.length ? "border-emerald-700/50 bg-emerald-900/20 text-emerald-300" : "border-amber-700/50 bg-amber-900/20 text-amber-300"}`}>
          {requiredIds.length ? `${requiredIds.length} 个固定参与者` : "未设置"}
        </span>
      </div>

      <div className="mt-3 grid gap-2 md:grid-cols-[minmax(180px,1fr)_auto_auto]">
        <input
          value={query}
          onChange={(e) => onQueryChange?.(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              runSearch(false);
            }
          }}
          placeholder="输入成员姓名，如：徐博超（也支持技术 ID）"
          className="h-9 min-w-0 rounded border border-zinc-700 bg-zinc-900 px-2.5 text-xs text-zinc-200 outline-none focus:border-blue-500"
        />
        <button
          type="button"
          onClick={() => runSearch(false)}
          disabled={!canEdit || loading}
          className="rounded bg-blue-600 px-3 py-2 text-xs text-white hover:bg-blue-500 disabled:bg-zinc-800 disabled:text-zinc-600"
        >
          {loading ? "搜索中" : "搜索成员"}
        </button>
        <button
          type="button"
          onClick={() => runSearch(true)}
          disabled={!canEdit || loading}
          className="rounded border border-zinc-700 bg-zinc-900 px-3 py-2 text-xs text-zinc-200 hover:bg-zinc-800 disabled:text-zinc-600"
        >
          刷新列表
        </button>
      </div>

      {requiredIds.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-2">
          {requiredIds.map((id) => {
            const member = byId.get(String(id));
            const displayName = member?.name && String(member.name) !== String(id)
              ? member.name
              : resolving
                ? "正在获取姓名"
                : "未找到姓名";
            return (
              <span key={id} title={id} className="inline-flex max-w-full items-center gap-2 rounded border border-emerald-800/50 bg-emerald-950/20 px-2 py-1 text-[11px] text-emerald-200">
                <span className="min-w-0 truncate">{displayName}</span>
                <button
                  type="button"
                  onClick={() => onRemoveTbMember?.(id)}
                  disabled={!canEdit}
                  className="rounded px-1 text-emerald-300/70 hover:bg-emerald-500/10 hover:text-red-200 disabled:text-zinc-600"
                  title="移除固定参与者"
                >
                  ×
                </button>
              </span>
            );
          })}
        </div>
      )}

      {error && <div className="mt-2 text-[11px] text-red-300">{error}</div>}

      <div className="mt-3 max-h-56 overflow-auto rounded border border-zinc-800">
        {members.length ? (
          <div className="divide-y divide-zinc-900">
            {members.map((member) => {
              const selected = requiredIds.includes(String(member.id));
              const saving = savingMemberId && String(savingMemberId) === String(member.id);
              return (
                <div key={member.id} className="grid gap-2 px-2.5 py-2 text-xs md:grid-cols-[1fr_auto] md:items-center">
                  <div className="min-w-0" title={member.id}>
                    <div className="truncate text-zinc-200">{member.name || "成员姓名未解析"}</div>
                  </div>
                  <button
                    type="button"
                    onClick={() => onSelectTbMember?.(member)}
                    disabled={!canEdit || selected || saving}
                    className={`rounded px-2.5 py-1.5 text-[11px] ${selected ? "bg-emerald-500/15 text-emerald-300" : "border border-zinc-700 bg-zinc-900 text-zinc-200 hover:bg-zinc-800"} disabled:text-zinc-500`}
                  >
                    {saving ? "保存中" : selected ? "已加入" : "设为固定参与者"}
                  </button>
                </div>
              );
            })}
          </div>
        ) : (
          <div className="px-3 py-6 text-center text-xs text-zinc-600">
            {tbMembers?.loaded ? "没有匹配成员，请换一个关键词" : "输入关键词后搜索 TB 成员"}
          </div>
        )}
      </div>
    </div>
  );
}

function RulesPanel({
  config,
  setCfg,
  readOnly = false,
  tbProjects,
  tbTasklists,
  onLoadTbProjects,
  onSelectTbProject,
  onLoadTbTasklists,
  onSelectTbTasklist,
}) {
  const pocText = stringifyList(config.pocWorkItemIds || []);
  return (
    <fieldset disabled={readOnly} className="m-0 border-0 p-0">
      <div className="grid gap-4 xl:grid-cols-2">
      <Section title="飞书连接高级配置">
        <div className="grid gap-3 md:grid-cols-2">
          <TextInput label="Space Key" value={getPath(config, "feishu.spaceKey")} onChange={(v) => setCfg("feishu.spaceKey", v)} mono />
          <TextInput label="Work Item Type Key" value={getPath(config, "feishu.workItemTypeKey")} onChange={(v) => setCfg("feishu.workItemTypeKey", v)} mono />
          <div className="md:col-span-2">
            <TextInput label="个人网页登录 URL" value={getPath(config, "feishu.web.homepageUrl", "https://project.feishu.cn/intelligentspace/bug/homepage")} onChange={(v) => setCfg("feishu.web.homepageUrl", v)} mono />
          </div>
          <Toggle label="启用 MCP" checked={getPath(config, "feishu.mcp.enabled", false)} onChange={(v) => setCfg("feishu.mcp.enabled", v)} />
          <SelectInput
            label="MCP 连接方式"
            value={getPath(config, "feishu.mcp.transport", "http-oauth")}
            onChange={(v) => setCfg("feishu.mcp.transport", v)}
            options={[
              { value: "http-oauth", label: "HTTP OAuth 优先" },
              { value: "http-header", label: "HTTP Header Token" },
            ]}
          />
          <div className="md:col-span-2">
            <TextInput label="MCP Server URL" value={getPath(config, "feishu.mcp.serverUrl", "https://project.feishu.cn/mcp_server/v1")} onChange={(v) => setCfg("feishu.mcp.serverUrl", v)} mono />
          </div>
          <TextInput label="MCP Header Name" value={getPath(config, "feishu.mcp.headerName", "X-Mcp-Token")} onChange={(v) => setCfg("feishu.mcp.headerName", v)} mono />
          <TextInput label="MCP Token" type="password" value={getPath(config, "feishu.mcp.token")} onChange={(v) => setCfg("feishu.mcp.token", v)} mono />
          <div className="md:col-span-2">
            <TextInput label="MCP Tool Name（可选）" value={getPath(config, "feishu.mcp.toolName")} onChange={(v) => setCfg("feishu.mcp.toolName", v)} mono />
          </div>
          <TextInput label="Plugin ID" value={getPath(config, "feishu.pluginId")} onChange={(v) => setCfg("feishu.pluginId", v)} mono />
          <TextInput label="Plugin Secret" value={getPath(config, "feishu.pluginSecret")} onChange={(v) => setCfg("feishu.pluginSecret", v)} mono />
          <TextInput label="User Key" value={getPath(config, "feishu.userKey")} onChange={(v) => setCfg("feishu.userKey", v)} mono />
          <TextInput label="Base URL" value={getPath(config, "feishu.baseUrl")} onChange={(v) => setCfg("feishu.baseUrl", v)} mono />
          <TextInput label="Page Size" type="number" value={getPath(config, "feishu.pageSize", 50)} onChange={(v) => setCfg("feishu.pageSize", v)} />
        </div>
      </Section>

      <Section title="TB 目标高级配置">
        <div className="grid gap-3 md:grid-cols-2">
          <div className="md:col-span-2">
            <TbProjectPicker
              config={config}
              tbProjects={tbProjects}
              canEdit={!readOnly}
              onLoadTbProjects={onLoadTbProjects}
              onSelectTbProject={onSelectTbProject}
            />
          </div>
          <div className="md:col-span-2">
            <TbTasklistPicker
              config={config}
              tbProjects={tbProjects}
              tbTasklists={tbTasklists}
              canEdit={!readOnly}
              onLoadTbTasklists={onLoadTbTasklists}
              onSelectTbTasklist={onSelectTbTasklist}
            />
          </div>
          <TextInput label="项目显示名称" value={getPath(config, "teambition.projectName", "")} onChange={(v) => setCfg("teambition.projectName", v)} />
          <TextInput label="任务列表显示名称" value={getPath(config, "teambition.tasklistName", "")} onChange={(v) => setCfg("teambition.tasklistName", v)} />
          <TextInput label="阶段显示名称" value={getPath(config, "teambition.stageName", "")} onChange={(v) => setCfg("teambition.stageName", v)} />
          <TextInput label="状态显示名称" value={getPath(config, "teambition.taskflowstatusName", "")} onChange={(v) => setCfg("teambition.taskflowstatusName", v)} />
          <TextInput label="默认负责人姓名" value={getPath(config, "teambition.defaultExecutorName", "")} onChange={(v) => setCfg("teambition.defaultExecutorName", v)} />
          <TextInput label="任务类型名称" value={getPath(config, "teambition.taskTypeName", "缺陷")} onChange={(v) => setCfg("teambition.taskTypeName", v)} />
          <TextInput label="项目归属说明" value={getPath(config, "teambition.projectPathName", "")} onChange={(v) => setCfg("teambition.projectPathName", v)} />
          <TextInput label="默认周期天数" type="number" value={getPath(config, "teambition.defaultDurationDays", 3)} onChange={(v) => setCfg("teambition.defaultDurationDays", v)} />
          <TextInput label="标签名称" value={stringifyList(getPath(config, "teambition.tagNames", []))} onChange={(v) => setCfg("teambition.tagNames", parseList(v))} placeholder="每行一个标签名称" />
          <TextInput label="应用分类字段名称" value={getPath(config, "teambition.applicationCategoryCustomFieldName", "应用分类")} onChange={(v) => setCfg("teambition.applicationCategoryCustomFieldName", v)} />
          <TextInput label="应用分类默认值" value={getPath(config, "teambition.applicationCategoryValue", "App Market")} onChange={(v) => setCfg("teambition.applicationCategoryValue", v)} />
          <TextInput label="缺陷分类字段名称" value={getPath(config, "teambition.defectCategoryCustomFieldName", "缺陷分类")} onChange={(v) => setCfg("teambition.defectCategoryCustomFieldName", v)} />
          <TextInput label="缺陷分类默认值" value={getPath(config, "teambition.defectCategoryValue", "\u529f\u80fd\u4f7f\u7528BUG")} onChange={(v) => setCfg("teambition.defectCategoryValue", v)} />
          <details className="md:col-span-2 rounded border border-zinc-800 bg-zinc-950/60 px-3 py-2 text-[11px] text-zinc-500">
            <summary className="cursor-pointer hover:text-zinc-300">技术标识（仅下拉无法解析、手工迁移或排障时编辑）</summary>
            <div className="mt-3 grid gap-3 md:grid-cols-2 xl:grid-cols-3">
              <TextInput label="Project ID" value={getPath(config, "teambition.projectId")} onChange={(v) => setCfg("teambition.projectId", v)} mono />
              <TextInput label="Tasklist ID" value={getPath(config, "teambition.tasklistId", "")} onChange={(v) => setCfg("teambition.tasklistId", v)} mono />
              <TextInput label="Stage ID" value={getPath(config, "teambition.stageId")} onChange={(v) => setCfg("teambition.stageId", v)} mono />
              <TextInput label="Sprint ID" value={getPath(config, "teambition.sprintId")} onChange={(v) => setCfg("teambition.sprintId", v)} mono />
              <TextInput label="Status ID" value={getPath(config, "teambition.taskflowstatusId")} onChange={(v) => setCfg("teambition.taskflowstatusId", v)} mono />
              <TextInput label="任务类型配置 ID" value={getPath(config, "teambition.scenariofieldconfigId")} onChange={(v) => setCfg("teambition.scenariofieldconfigId", v)} mono />
              <TextInput label="默认负责人 ID" value={getPath(config, "teambition.defaultExecutorId", "")} onChange={(v) => setCfg("teambition.defaultExecutorId", v)} mono />
              <TextInput label="标签 ID" value={stringifyList(getPath(config, "teambition.tagIds", []))} onChange={(v) => setCfg("teambition.tagIds", parseList(v))} mono placeholder="每行一个" />
              <TextInput label="应用分类字段 ID" value={getPath(config, "teambition.applicationCategoryCustomFieldId")} onChange={(v) => setCfg("teambition.applicationCategoryCustomFieldId", v)} mono />
              <TextInput label="缺陷分类字段 ID" value={getPath(config, "teambition.defectCategoryCustomFieldId")} onChange={(v) => setCfg("teambition.defectCategoryCustomFieldId", v)} mono />
            </div>
          </details>
          <div className="md:col-span-2">
            <TextInput label="TB 标题模板" value={getPath(config, "teambition.titleTemplate", "")} onChange={(v) => setCfg("teambition.titleTemplate", v)} mono />
          </div>
          <div className="md:col-span-2">
            <TextInput label="TB 任务链接模板" value={getPath(config, "teambition.taskUrlTemplate")} onChange={(v) => setCfg("teambition.taskUrlTemplate", v)} mono />
          </div>
        </div>
      </Section>

      <Section title="同步高级选项">
        <div className="grid gap-3 md:grid-cols-2">
          <Toggle label="开始时间=飞书创建时间" checked={getPath(config, "sync.ensureStartDate", true)} onChange={(v) => setCfg("sync.ensureStartDate", v)} />
          <Toggle label="评论失败阻断主任务" checked={getPath(config, "sync.failOnCommentError", true)} onChange={(v) => setCfg("sync.failOnCommentError", v)} />
          <Toggle label="附件失败阻断主任务" checked={getPath(config, "sync.failOnAttachmentError", true)} onChange={(v) => setCfg("sync.failOnAttachmentError", v)} />
          <TextInput label="Raw JSON Max Length" type="number" value={getPath(config, "sync.rawJsonMaxLength", 6000)} onChange={(v) => setCfg("sync.rawJsonMaxLength", v)} />
          <div className="md:col-span-2">
            <TextInput
              label="任务表格 URL"
              value={getPath(config, "sheetSync.url", DEFAULT_FEISHU_TASK_SHEET_URL)}
              onChange={(v) => setCfg("sheetSync.url", v)}
              mono
              placeholder={DEFAULT_FEISHU_TASK_SHEET_URL}
            />
          </div>
          <div className="md:col-span-2">
            <TextInput label="Webhook Secret" value={getPath(config, "sync.webhookSecret")} onChange={(v) => setCfg("sync.webhookSecret", v)} mono />
          </div>
        </div>
      </Section>

      <Section title="PoC 工单">
        <textarea
          value={pocText}
          onChange={(e) => setCfg("pocWorkItemIds", parseList(e.target.value))}
          className="min-h-44 w-full rounded border border-zinc-700 bg-zinc-950 p-3 font-mono text-xs text-zinc-200 outline-none focus:border-blue-500"
          placeholder="每行一个飞书工单 ID"
        />
      </Section>
      </div>
    </fieldset>
  );
}

function FieldsPanel({ config, setCfg, readOnly = false, tbMembers = {} }) {
  const displayContext = readableTbContext(config, tbMembers);
  return (
    <fieldset disabled={readOnly} className="m-0 border-0 p-0">
      <div className="space-y-4">
      <Section title="人员 / 状态 / 优先级 / 严重程度映射">
        <div className="grid gap-4 xl:grid-cols-2">
          <KeyValueEditor title="飞书人员 -> TB 用户" value={getPath(config, "mappings.people", {})} onChange={(v) => setCfg("mappings.people", v)} left="飞书 user_key / 邮箱 / 姓名" right="TB 用户姓名" technicalValue resolveValue={(value, key) => configuredDisplayName(displayContext.members, value, key, "成员姓名未解析")} />
          <KeyValueEditor title="飞书状态 -> TB 状态" value={getPath(config, "mappings.status", {})} onChange={(v) => setCfg("mappings.status", v)} left="飞书状态值" right="TB 状态名称" technicalValue resolveValue={(value) => configuredDisplayName(displayContext.statuses, value, "", "状态名称未解析")} />
          <KeyValueEditor title="飞书优先级 -> TB 优先级" value={getPath(config, "mappings.priority", {})} onChange={(v) => setCfg("mappings.priority", v)} left="飞书优先级" right="TB priority" />
          <KeyValueEditor title="飞书严重程度 -> TB 字段值" value={getPath(config, "mappings.severity", {})} onChange={(v) => setCfg("mappings.severity", v)} left="飞书严重程度" right="目标值" />
        </div>
      </Section>

      <Section title="飞书字段 -> TB 自定义字段">
        <FieldMappingEditor value={getPath(config, "mappings.fields", {})} onChange={(v) => setCfg("mappings.fields", v)} />
      </Section>

      <Section title="标准同步字段">
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
          <TextInput label="源工单标识字段名称" value={getPath(config, "teambition.sourceIdCustomFieldName", "源工单 ID")} onChange={(v) => setCfg("teambition.sourceIdCustomFieldName", v)} />
          <TextInput label="源工单链接字段名称" value={getPath(config, "teambition.sourceUrlCustomFieldName", "源工单 URL")} onChange={(v) => setCfg("teambition.sourceUrlCustomFieldName", v)} />
          <TextInput label="状态字段名称" value={getPath(config, "teambition.statusCustomFieldName", "状态")} onChange={(v) => setCfg("teambition.statusCustomFieldName", v)} />
          <TextInput label="优先级字段名称" value={getPath(config, "teambition.priorityCustomFieldName", "优先级")} onChange={(v) => setCfg("teambition.priorityCustomFieldName", v)} />
          <TextInput label="严重程度字段名称" value={getPath(config, "teambition.severityCustomFieldName", "严重程度")} onChange={(v) => setCfg("teambition.severityCustomFieldName", v)} />
          <TextInput label="评论摘要字段名称" value={getPath(config, "teambition.commentsSummaryCustomFieldName", "评论摘要")} onChange={(v) => setCfg("teambition.commentsSummaryCustomFieldName", v)} />
          <TextInput label="附件摘要字段名称" value={getPath(config, "teambition.attachmentsSummaryCustomFieldName", "附件摘要")} onChange={(v) => setCfg("teambition.attachmentsSummaryCustomFieldName", v)} />
          <TextInput label="关联项摘要字段名称" value={getPath(config, "teambition.relatedItemsSummaryCustomFieldName", "关联项摘要")} onChange={(v) => setCfg("teambition.relatedItemsSummaryCustomFieldName", v)} />
        </div>
        <details className="mt-3 rounded border border-zinc-800 bg-zinc-950/50 px-3 py-2 text-[10px] text-zinc-600">
          <summary className="cursor-pointer">标准同步字段技术标识</summary>
          <div className="mt-3 grid gap-3 md:grid-cols-2 xl:grid-cols-4">
            <TextInput label="源 ID 字段 ID" value={getPath(config, "teambition.sourceIdCustomFieldId")} onChange={(v) => setCfg("teambition.sourceIdCustomFieldId", v)} mono />
            <TextInput label="源 URL 字段 ID" value={getPath(config, "teambition.sourceUrlCustomFieldId")} onChange={(v) => setCfg("teambition.sourceUrlCustomFieldId", v)} mono />
            <TextInput label="状态字段 ID" value={getPath(config, "teambition.statusCustomFieldId")} onChange={(v) => setCfg("teambition.statusCustomFieldId", v)} mono />
            <TextInput label="优先级字段 ID" value={getPath(config, "teambition.priorityCustomFieldId")} onChange={(v) => setCfg("teambition.priorityCustomFieldId", v)} mono />
            <TextInput label="严重程度字段 ID" value={getPath(config, "teambition.severityCustomFieldId")} onChange={(v) => setCfg("teambition.severityCustomFieldId", v)} mono />
            <TextInput label="评论摘要字段 ID" value={getPath(config, "teambition.commentsSummaryCustomFieldId")} onChange={(v) => setCfg("teambition.commentsSummaryCustomFieldId", v)} mono />
            <TextInput label="附件摘要字段 ID" value={getPath(config, "teambition.attachmentsSummaryCustomFieldId")} onChange={(v) => setCfg("teambition.attachmentsSummaryCustomFieldId", v)} mono />
            <TextInput label="关联项摘要字段 ID" value={getPath(config, "teambition.relatedItemsSummaryCustomFieldId")} onChange={(v) => setCfg("teambition.relatedItemsSummaryCustomFieldId", v)} mono />
          </div>
        </details>
      </Section>
      </div>
    </fieldset>
  );
}

function KeyValueEditor({ title, value, onChange, left, right, technicalValue = false, resolveValue = (entry) => entry }) {
  const [rows, setRows] = useState(() => Object.entries(value || {}).map(([key, val]) => ({ key, val: stringifyScalar(val) })));
  useEffect(() => {
    setRows(Object.entries(value || {}).map(([key, val]) => ({ key, val: stringifyScalar(val) })));
  }, [JSON.stringify(value || {})]); // eslint-disable-line react-hooks/exhaustive-deps
  const updateRows = (nextRows) => {
    setRows(nextRows);
    const next = {};
    for (const row of nextRows) if (row.key.trim()) next[row.key.trim()] = parseScalar(row.val);
    onChange(next);
  };
  return (
    <div className="rounded border border-zinc-800 bg-zinc-950 p-3">
      <div className="mb-2 flex items-center gap-2">
        <h3 className="text-xs font-medium text-zinc-200">{title}</h3>
        <button onClick={() => updateRows([...rows, { key: "", val: "" }])} className="ml-auto rounded bg-zinc-800 px-2 py-1 text-[11px] text-zinc-300 hover:bg-zinc-700">新增</button>
      </div>
      <div className="grid grid-cols-[1fr_1fr_32px] gap-2 text-[11px] text-zinc-500">
        <span>{left}</span><span>{right}</span><span />
      </div>
      <div className="mt-1 space-y-2">
        {rows.map((row, idx) => (
          <div key={idx} className="grid grid-cols-[1fr_1fr_32px] gap-2">
            <input value={row.key} onChange={(e) => updateRows(rows.map((r, i) => i === idx ? { ...r, key: e.target.value } : r))} className="rounded border border-zinc-800 bg-zinc-900 px-2 py-1.5 font-mono text-xs text-zinc-200 outline-none focus:border-blue-500" />
            {technicalValue ? (
              <div className="rounded border border-zinc-800 bg-zinc-900 px-2 py-1.5 text-xs text-zinc-200">
                <div className="truncate">{resolveValue(row.val, row.key)}</div>
                <details className="mt-1 text-[9px] text-zinc-600">
                  <summary className="cursor-pointer">编辑技术标识</summary>
                  <input value={row.val} onChange={(e) => updateRows(rows.map((r, i) => i === idx ? { ...r, val: e.target.value } : r))} className="mt-1 w-full rounded border border-zinc-800 bg-zinc-950 px-2 py-1 font-mono text-[10px] text-zinc-300 outline-none focus:border-blue-500" />
                </details>
              </div>
            ) : (
              <input value={row.val} onChange={(e) => updateRows(rows.map((r, i) => i === idx ? { ...r, val: e.target.value } : r))} className="rounded border border-zinc-800 bg-zinc-900 px-2 py-1.5 font-mono text-xs text-zinc-200 outline-none focus:border-blue-500" />
            )}
            <button onClick={() => updateRows(rows.filter((_, i) => i !== idx))} className="rounded border border-zinc-800 text-zinc-500 hover:text-red-300">×</button>
          </div>
        ))}
        {!rows.length && <div className="py-3 text-center text-xs text-zinc-600">暂无映射</div>}
      </div>
    </div>
  );
}

function mappingToRows(value) {
  return Object.entries(value || {}).map(([sourceKey, raw]) => {
    const mapping = typeof raw === "string" ? { customFieldId: raw } : (raw || {});
    return {
      sourceKey,
      customFieldId: mapping.customFieldId || mapping.customfieldId || mapping.targetFieldId || mapping.id || "",
      displayName: mapping.displayName || mapping.customFieldName || mapping.targetFieldName || "",
      type: mapping.type || mapping.valueType || "",
      defaultValue: stringifyScalar(mapping.defaultValue ?? mapping.default ?? ""),
      useRawValue: mapping.useRawValue === true || mapping.rawValue === true,
      valuesText: stringifyPairs(mapping.values || mapping.options || {}),
    };
  });
}

function rowsToMapping(rows) {
  const out = {};
  for (const row of rows) {
    if (!row.sourceKey.trim() || !row.customFieldId.trim()) continue;
    out[row.sourceKey.trim()] = {
      customFieldId: row.customFieldId.trim(),
      displayName: row.displayName.trim(),
      type: row.type.trim(),
      defaultValue: parseScalar(row.defaultValue),
      useRawValue: !!row.useRawValue,
      values: parsePairs(row.valuesText),
    };
  }
  return out;
}

function FieldMappingEditor({ value, onChange }) {
  const [rows, setRows] = useState(() => mappingToRows(value));
  useEffect(() => {
    setRows(mappingToRows(value));
  }, [JSON.stringify(value || {})]); // eslint-disable-line react-hooks/exhaustive-deps
  const update = (next) => {
    setRows(next);
    onChange(rowsToMapping(next));
  };
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-[1fr_1fr_120px_100px_1.4fr_36px] gap-2 text-[11px] text-zinc-500">
        <span>飞书字段名称 / Key</span><span>TB 自定义字段名称</span><span>类型</span><span>原始值</span><span>值映射 from=to</span><span />
      </div>
      {rows.map((row, idx) => (
        <div key={idx} className="grid grid-cols-[1fr_1fr_120px_100px_1.4fr_36px] gap-2">
          <input value={row.sourceKey} onChange={(e) => update(rows.map((r, i) => i === idx ? { ...r, sourceKey: e.target.value } : r))} className="rounded border border-zinc-800 bg-zinc-950 px-2 py-2 font-mono text-xs text-zinc-200 outline-none focus:border-blue-500" />
          <div className="rounded border border-zinc-800 bg-zinc-950 px-2 py-1.5">
            <input value={row.displayName} onChange={(e) => update(rows.map((r, i) => i === idx ? { ...r, displayName: e.target.value } : r))} placeholder="例如：应用分类" className="w-full bg-transparent text-xs text-zinc-200 outline-none" />
            <details className="mt-1 text-[9px] text-zinc-600">
              <summary className="cursor-pointer">字段技术标识</summary>
              <input value={row.customFieldId} onChange={(e) => update(rows.map((r, i) => i === idx ? { ...r, customFieldId: e.target.value } : r))} className="mt-1 w-full rounded border border-zinc-800 bg-zinc-950 px-2 py-1 font-mono text-[10px] text-zinc-300 outline-none focus:border-blue-500" />
            </details>
          </div>
          <input value={row.type} onChange={(e) => update(rows.map((r, i) => i === idx ? { ...r, type: e.target.value } : r))} className="rounded border border-zinc-800 bg-zinc-950 px-2 py-2 text-xs text-zinc-200 outline-none focus:border-blue-500" />
          <label className="flex items-center justify-center gap-2 rounded border border-zinc-800 bg-zinc-950 text-xs text-zinc-400">
            <input type="checkbox" checked={row.useRawValue} onChange={(e) => update(rows.map((r, i) => i === idx ? { ...r, useRawValue: e.target.checked } : r))} className="accent-blue-600" />
            raw
          </label>
          <textarea value={row.valuesText} onChange={(e) => update(rows.map((r, i) => i === idx ? { ...r, valuesText: e.target.value } : r))} className="min-h-16 rounded border border-zinc-800 bg-zinc-950 px-2 py-2 font-mono text-xs text-zinc-200 outline-none focus:border-blue-500" />
          <button onClick={() => update(rows.filter((_, i) => i !== idx))} className="rounded border border-zinc-800 text-zinc-500 hover:text-red-300">×</button>
        </div>
      ))}
      <button onClick={() => update([...rows, { sourceKey: "", customFieldId: "", displayName: "", type: "", defaultValue: "", useRawValue: false, valuesText: "" }])} className="rounded border border-zinc-700 bg-zinc-900 px-3 py-2 text-xs text-zinc-300 hover:bg-zinc-800">新增字段映射</button>
    </div>
  );
}

function KeywordPanel({ config, setCfg, readOnly = false, tbSprints, onLoadTbSprints }) {
  const rawRules = getPath(config, "mappings.keywordRules", []);
  const rules = Array.isArray(rawRules) ? rawRules : [];
  const displayRules = enabledFirstRows(rules);
  const updateRules = (next) => setCfg("mappings.keywordRules", next);
  const updateRule = (idx, patch) => updateRules(rules.map((rule, i) => i === idx ? { ...rule, ...patch } : rule));
  const updateTarget = (idx, patch) => updateRule(idx, { target: { ...(rules[idx]?.target || {}), ...patch } });
  return (
    <fieldset disabled={readOnly} className="m-0 border-0 p-0">
      <Section
        title="关键词命中后改写 TB 创建规则"
        right={<button onClick={() => updateRules([...rules, { enabled: true, id: `rule-${Date.now()}`, name: "新规则", scope: "all", match: "any", keywords: [], target: {} }])} className="rounded bg-zinc-800 px-2.5 py-1 text-xs text-zinc-200 hover:bg-zinc-700">新增规则</button>}
      >
        <div className="space-y-3">
        {displayRules.map(({ value: rule, index: idx }) => (
          <div key={`${rule.id || idx}-${idx}`} className={`rounded border p-3 ${rule.enabled !== false ? "border-blue-800/70 bg-zinc-950" : "border-zinc-800 bg-zinc-950/70"}`}>
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2 text-[10px]">
              <span className={`rounded px-1.5 py-0.5 ${rule.enabled !== false ? "bg-blue-500/15 text-blue-200" : "bg-zinc-800 text-zinc-500"}`}>{rule.enabled !== false ? "生效中" : "已停用"}</span>
              <span className="text-zinc-600">执行顺序 #{idx + 1}</span>
            </div>
            <div className="grid gap-3 md:grid-cols-[80px_1fr_120px_120px_36px]">
              <Toggle label="启用" checked={rule.enabled !== false} onChange={(v) => updateRule(idx, { enabled: v })} />
              <TextInput label="规则名" value={rule.name || ""} onChange={(v) => updateRule(idx, { name: v })} />
              <label className="block">
                <span className="mb-1 block text-[11px] text-zinc-500">范围</span>
                <select value={rule.scope || "all"} onChange={(e) => updateRule(idx, { scope: e.target.value })} className="h-9 w-full rounded border border-zinc-700 bg-zinc-950 px-2 text-xs text-zinc-200 outline-none">
                  <option value="all">全部</option>
                  <option value="title">标题</option>
                  <option value="description">描述</option>
                  <option value="fields">字段</option>
                  <option value="standard">标准字段</option>
                </select>
              </label>
              <label className="block">
                <span className="mb-1 block text-[11px] text-zinc-500">匹配</span>
                <select value={rule.match || "any"} onChange={(e) => updateRule(idx, { match: e.target.value })} className="h-9 w-full rounded border border-zinc-700 bg-zinc-950 px-2 text-xs text-zinc-200 outline-none">
                  <option value="any">任一关键词</option>
                  <option value="all">全部关键词</option>
                </select>
              </label>
              <button onClick={() => updateRules(rules.filter((_, i) => i !== idx))} className="mt-5 rounded border border-zinc-800 text-zinc-500 hover:text-red-300">×</button>
            </div>
            <details className="mt-2 text-[10px] text-zinc-600">
              <summary className="cursor-pointer">查看或编辑规则技术标识</summary>
              <div className="mt-2 max-w-md"><TextInput label="规则 ID" value={rule.id || ""} onChange={(v) => updateRule(idx, { id: v })} mono /></div>
            </details>
            <div className="mt-3 grid gap-3 lg:grid-cols-[1fr_1.6fr]">
              <label className="block">
                <span className="mb-1 block text-[11px] text-zinc-500">关键词，每行一个</span>
                <textarea value={stringifyList(rule.keywords || [])} onChange={(e) => updateRule(idx, { keywords: parseList(e.target.value) })} className="min-h-28 w-full rounded border border-zinc-800 bg-zinc-900 p-2 font-mono text-xs text-zinc-200 outline-none focus:border-blue-500" />
              </label>
              <label className="block">
                <span className="mb-1 block text-[11px] text-zinc-500">限定飞书字段 Key</span>
                <textarea value={stringifyList(rule.fieldKeys || [])} onChange={(e) => updateRule(idx, { fieldKeys: parseList(e.target.value) })} className="min-h-28 w-full rounded border border-zinc-800 bg-zinc-900 p-2 font-mono text-xs text-zinc-200 outline-none focus:border-blue-500" />
              </label>
              <label className="block">
                <span className="mb-1 block text-[11px] text-zinc-500">限定飞书字段名</span>
                <textarea value={stringifyList(rule.fieldNames || [])} onChange={(e) => updateRule(idx, { fieldNames: parseList(e.target.value) })} className="min-h-28 w-full rounded border border-zinc-800 bg-zinc-900 p-2 font-mono text-xs text-zinc-200 outline-none focus:border-blue-500" />
              </label>
              <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                <TextInput label="目标项目名称 / 路径" value={rule.target?.projectPathName || rule.target?.projectName || ""} onChange={(v) => updateTarget(idx, { projectPathName: v })} />
                <TextInput label="目标任务列表名称" value={rule.target?.tasklistName || ""} onChange={(v) => updateTarget(idx, { tasklistName: v })} />
                <TextInput label="目标阶段名称" value={rule.target?.stageName || ""} onChange={(v) => updateTarget(idx, { stageName: v })} />
                <TextInput label="目标状态名称" value={rule.target?.taskflowstatusName || rule.target?.statusName || ""} onChange={(v) => updateTarget(idx, { taskflowstatusName: v })} />
                <TextInput label="执行者姓名" value={rule.target?.executorName || ""} onChange={(v) => updateTarget(idx, { executorName: v })} />
                <TextInput label="优先级" value={stringifyScalar(rule.target?.priority ?? "")} onChange={(v) => updateTarget(idx, { priority: parseScalar(v) })} />
              </div>
              <details className="mt-3 rounded border border-zinc-800 bg-zinc-950/50 px-3 py-2 text-[10px] text-zinc-600">
                <summary className="cursor-pointer">目标技术标识（仅手工迁移或排障时编辑）</summary>
                <div className="mt-3 grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                  <TextInput label="Project ID" value={rule.target?.projectId || ""} onChange={(v) => updateTarget(idx, { projectId: v })} mono />
                  <TextInput label="Tasklist ID" value={rule.target?.tasklistId || ""} onChange={(v) => updateTarget(idx, { tasklistId: v })} mono />
                  <TextInput label="Stage ID" value={rule.target?.stageId || ""} onChange={(v) => updateTarget(idx, { stageId: v })} mono />
                  <TextInput label="Sprint ID" value={rule.target?.sprintId || ""} onChange={(v) => updateTarget(idx, { sprintId: v })} mono />
                  <TextInput label="Status ID" value={rule.target?.taskflowstatusId || ""} onChange={(v) => updateTarget(idx, { taskflowstatusId: v })} mono />
                  <TextInput label="Executor ID" value={rule.target?.executorId || ""} onChange={(v) => updateTarget(idx, { executorId: v })} mono />
                </div>
              </details>
              <div className="mt-3">
                <TbSprintPicker
                  config={config}
                  tbSprints={tbSprints}
                  canEdit={!readOnly}
                  compact
                  projectId={rule.target?.projectId || getPath(config, "teambition.projectId", "")}
                  value={{
                    sprintId: rule.target?.sprintId || "",
                    name: rule.target?.sprintName || "",
                    url: rule.target?.sprintUrl || "",
                    projectId: rule.target?.projectId || getPath(config, "teambition.projectId", ""),
                  }}
                  onLoadTbSprints={onLoadTbSprints}
                  onChange={(sprint) => updateTarget(idx, {
                    sprintId: sprint.sprintId || sprint.id,
                    sprintName: sprint.name || sprint.title,
                    sprintUrl: sprint.url,
                    projectId: sprint.projectId || rule.target?.projectId || getPath(config, "teambition.projectId", ""),
                  })}
                />
              </div>
            </div>
            <div className="mt-3 grid gap-3 lg:grid-cols-2">
              <label className="block">
                <span className="mb-1 block text-[11px] text-zinc-500">额外参与人姓名，每行一个</span>
                <textarea value={stringifyList(rule.target?.involveMemberNames || [])} onChange={(e) => updateTarget(idx, { involveMemberNames: parseList(e.target.value) })} className="min-h-20 w-full rounded border border-zinc-800 bg-zinc-900 p-2 text-xs text-zinc-200 outline-none focus:border-blue-500" placeholder="姓名顺序与技术标识一致" />
              </label>
              <label className="block">
                <span className="mb-1 block text-[11px] text-zinc-500">额外参与人技术标识，每行一个</span>
                <textarea value={stringifyList(rule.target?.involveMembers || [])} onChange={(e) => updateTarget(idx, { involveMembers: parseList(e.target.value) })} className="min-h-20 w-full rounded border border-zinc-800 bg-zinc-900 p-2 font-mono text-xs text-zinc-200 outline-none focus:border-blue-500" />
              </label>
              <label className="block">
                <span className="mb-1 block text-[11px] text-zinc-500">目标标签 Tag ID，每行一个</span>
                <textarea value={stringifyList(rule.target?.tagIds || [])} onChange={(e) => updateTarget(idx, { tagIds: parseList(e.target.value) })} className="min-h-20 w-full rounded border border-zinc-800 bg-zinc-900 p-2 font-mono text-xs text-zinc-200 outline-none focus:border-blue-500" />
              </label>
              <label className="block">
                <span className="mb-1 block text-[11px] text-zinc-500">目标标签名称，每行一个</span>
                <textarea value={stringifyList(rule.target?.tagNames || rule.tagNames || [])} onChange={(e) => updateTarget(idx, { tagNames: parseList(e.target.value) })} className="min-h-20 w-full rounded border border-zinc-800 bg-zinc-900 p-2 text-xs text-zinc-200 outline-none focus:border-blue-500" placeholder="阿维塔" />
              </label>
              <label className="block">
                <span className="mb-1 block text-[11px] text-zinc-500">命中后写入自定义字段，fieldId=value</span>
                <textarea value={stringifyPairs(rule.target?.customFields || {})} onChange={(e) => updateTarget(idx, { customFields: parseCustomFields(e.target.value) })} className="min-h-20 w-full rounded border border-zinc-800 bg-zinc-900 p-2 font-mono text-xs text-zinc-200 outline-none focus:border-blue-500" />
              </label>
            </div>
          </div>
        ))}
        {!rules.length && <div className="rounded border border-dashed border-zinc-800 py-10 text-center text-sm text-zinc-600">暂无关键词规则</div>}
        </div>
      </Section>
    </fieldset>
  );
}

function recordIdentityTuple(row = {}) {
  return {
    sourceSystem: String(row.sourceSystem || "feishu_project"),
    sourceProjectKey: String(row.sourceProjectKey || ""),
    sourceWorkItemTypeKey: String(row.sourceWorkItemTypeKey || ""),
    sourceWorkItemId: String(row.sourceWorkItemId || ""),
    targetSystem: String(row.targetSystem || "teambition"),
  };
}

function recordKey(row = {}) {
  const identity = recordIdentityTuple(row);
  return [
    identity.sourceSystem,
    identity.sourceProjectKey,
    identity.sourceWorkItemTypeKey,
    identity.sourceWorkItemId,
    identity.targetSystem,
  ].map((part) => encodeURIComponent(part)).join("/");
}

function uniqueRecordRows(rows = []) {
  const seen = new Set();
  return (Array.isArray(rows) ? rows : []).filter((row) => {
    const key = recordKey(row);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function recordPreviewExpired(previewState = {}) {
  if (!previewState.expiresAt) return false;
  const expiresAt = new Date(previewState.expiresAt).getTime();
  return Number.isFinite(expiresAt) && expiresAt <= Date.now();
}

function recordApplyItemFailed(item = {}) {
  const status = String(item.status || "").trim().toLowerCase();
  return item.ok === false
    || item.result?.ok === false
    || ["failed", "failure", "error", "expired", "rejected"].includes(status);
}

function recordProblemNo(row = {}) {
  return row.sourceProblemNo || row.problemNo || row.sourceWorkItemNo || row.sourceWorkItemId || "-";
}

function recordSearchText(row = {}) {
  return [
    row.syncStatus,
    recordProblemNo(row),
    row.sourceWorkItemId,
    row.sourceProjectKey,
    row.sourceWorkItemTypeKey,
    row.sourceWorkItemUrl,
    formatTbTaskDisplayId(row),
    row.targetTaskId,
    row.targetUniqueId,
    row.uniqueId,
    row.targetProjectId,
    ...(rowBookmarks(row) || []),
    row.scopeStatus?.state,
    row.scopeStatus?.message,
    row.lastError,
    row.sourceUpdatedAt,
    row.lastSyncedAt,
  ].filter(Boolean).join(" ").toLowerCase();
}

function RecordsPanel({
  records,
  config,
  canEdit = false,
  clearBusy = false,
  deleteBusy = false,
  globalSyncBusy = false,
  selectedRecordKeys = {},
  recordPreviewByKey = {},
  tbMembers,
  tbTasklists,
  tbSprints,
  onClearAll,
  onToggleRecord,
  onTogglePage,
  onClearSelection,
  onPreviewRecords,
  onApplyPreviews,
  onDismissPreview,
  onDeleteRecords,
}) {
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [sort, setSort] = useState({ field: "sourceUpdatedAt", direction: "desc" });
  const [showHidden, setShowHidden] = useState(false);
  const pageSelectRef = useRef(null);
  const normalizedQuery = query.trim().toLowerCase();
  const hiddenCount = useMemo(() => records.filter(isHiddenFeishuSyncRecord).length, [records]);
  const scopeRecords = useMemo(
    () => showHidden ? records : records.filter((row) => !isHiddenFeishuSyncRecord(row)),
    [records, showHidden],
  );
  const filteredRecords = useMemo(() => {
    const terms = normalizedQuery.split(/\s+/).filter(Boolean);
    const matched = !terms.length ? scopeRecords : scopeRecords.filter((row) => {
      const text = recordSearchText(row);
      return terms.every((term) => text.includes(term));
    });
    return sortFeishuSyncRecords(matched, sort);
  }, [scopeRecords, normalizedQuery, sort]);
  const totalPages = Math.max(1, Math.ceil(filteredRecords.length / pageSize));
  const safePage = Math.min(page, totalPages);
  const pageStartIndex = (safePage - 1) * pageSize;
  const pageRecords = filteredRecords.slice(pageStartIndex, pageStartIndex + pageSize);
  const visibleStart = filteredRecords.length ? pageStartIndex + 1 : 0;
  const visibleEnd = Math.min(pageStartIndex + pageRecords.length, filteredRecords.length);
  const selectedRecords = useMemo(
    () => scopeRecords.filter((row) => selectedRecordKeys[recordKey(row)]),
    [scopeRecords, selectedRecordKeys],
  );
  const selectedReadyRecords = useMemo(
    () => selectedRecords.filter((row) => {
      const previewState = recordPreviewByKey[recordKey(row)];
      return previewState?.status === "ready" && !!previewState.planId && !recordPreviewExpired(previewState);
    }),
    [selectedRecords, recordPreviewByKey],
  );
  const pageSelectedCount = pageRecords.filter((row) => selectedRecordKeys[recordKey(row)]).length;
  const allPageSelected = pageRecords.length > 0 && pageSelectedCount === pageRecords.length;
  const selectedBusy = selectedRecords.some((row) => ["loading", "applying"].includes(recordPreviewByKey[recordKey(row)]?.status));
  const anyRecordBusy = globalSyncBusy || Object.values(recordPreviewByKey).some((state) => ["loading", "applying"].includes(state?.status));
  const previewRows = useMemo(
    () => Object.values(recordPreviewByKey).map(recordPreviewDisplayRow).filter(Boolean),
    [recordPreviewByKey],
  );
  const displayContext = useMemo(() => {
    const context = readableTbContext(config || {}, tbMembers || {}, tbTasklists || {}, tbSprints || {});
    addReadableSyncResultContext(context, previewRows);
    return context;
  }, [config, tbMembers, tbTasklists, tbSprints, previewRows]);

  const changeSort = (field) => {
    setSort((current) => current.field === field
      ? { field, direction: current.direction === "asc" ? "desc" : "asc" }
      : { field, direction: field === "sourceUpdatedAt" ? "desc" : "asc" });
  };

  const sortMark = (field) => sort.field === field ? (sort.direction === "asc" ? "↑" : "↓") : "↕";

  useEffect(() => {
    setPage(1);
  }, [normalizedQuery, pageSize, records.length]);

  useEffect(() => {
    if (page > totalPages) setPage(totalPages);
  }, [page, totalPages]);

  useEffect(() => {
    if (pageSelectRef.current) {
      pageSelectRef.current.indeterminate = pageSelectedCount > 0 && !allPageSelected;
    }
  }, [pageSelectedCount, allPageSelected]);

  return (
    <Section
      title={`飞书工单 / TB 任务映射表 (${scopeRecords.length})`}
      right={(
        <div className="flex flex-wrap items-center justify-end gap-2">
          <span className="text-[11px] text-zinc-500">
            {normalizedQuery ? `匹配 ${filteredRecords.length} 条` : `共 ${records.length} 条${hiddenCount ? `，隐藏 ${hiddenCount} 条` : ""}`}
          </span>
          {hiddenCount > 0 && (
            <button
              type="button"
              onClick={() => setShowHidden((value) => !value)}
              className={`rounded border px-2.5 py-1.5 text-[11px] ${showHidden ? "border-amber-700/70 bg-amber-950/30 text-amber-200" : "border-zinc-700 bg-zinc-950 text-zinc-300 hover:bg-zinc-800"}`}
            >
              {showHidden ? "隐藏已流转记录" : `显示已隐藏 (${hiddenCount})`}
            </button>
          )}
          {selectedRecords.length > 0 && (
            <div className="flex items-center gap-1.5 rounded border border-blue-800/60 bg-blue-950/20 px-2 py-1 text-[11px] text-blue-200">
              <span>已选 {selectedRecords.length} 条</span>
              <button
                type="button"
                onClick={onClearSelection}
                disabled={selectedBusy || deleteBusy}
                className="text-blue-300 underline-offset-2 hover:text-blue-100 hover:underline disabled:text-zinc-600"
              >
                取消选择
              </button>
            </div>
          )}
          <button
            type="button"
            onClick={() => onPreviewRecords?.(selectedRecords)}
            disabled={!canEdit || clearBusy || deleteBusy || anyRecordBusy || !selectedRecords.length}
            title="对已选记录执行 dry-run，结果会展开在对应行"
            className="rounded border border-blue-700/70 bg-blue-950/30 px-2.5 py-1.5 text-[11px] font-medium text-blue-200 hover:bg-blue-900/40 disabled:border-zinc-800 disabled:bg-zinc-900 disabled:text-zinc-600"
          >
            {selectedRecords.some((row) => recordPreviewByKey[recordKey(row)]?.status === "loading") ? "预演中..." : "一键同步"}
          </button>
          <button
            type="button"
            onClick={() => onApplyPreviews?.(selectedReadyRecords)}
            disabled={!canEdit || clearBusy || deleteBusy || anyRecordBusy || !selectedReadyRecords.length}
            title="直接应用已保存的 dry-run 方案，不会重新执行 /run"
            className="rounded border border-emerald-700/70 bg-emerald-950/25 px-2.5 py-1.5 text-[11px] font-medium text-emerald-200 hover:bg-emerald-900/35 disabled:border-zinc-800 disabled:bg-zinc-900 disabled:text-zinc-600"
          >
            确认生效{selectedReadyRecords.length ? ` (${selectedReadyRecords.length})` : ""}
          </button>
          <button
            type="button"
            onClick={() => onDeleteRecords?.(selectedRecords)}
            disabled={!canEdit || clearBusy || deleteBusy || anyRecordBusy || !selectedRecords.length}
            className="rounded border border-red-800/70 bg-red-950/20 px-2.5 py-1.5 text-[11px] font-medium text-red-200 hover:bg-red-900/35 disabled:border-zinc-800 disabled:bg-zinc-900 disabled:text-zinc-600"
          >
            {deleteBusy ? "删除中..." : "一键删除"}
          </button>
          <button
            type="button"
            onClick={onClearAll}
            disabled={!canEdit || clearBusy || deleteBusy || anyRecordBusy || !records.length}
            className="rounded border border-red-800/70 bg-red-950/30 px-2.5 py-1.5 text-[11px] font-medium text-red-200 hover:bg-red-900/40 disabled:border-zinc-800 disabled:bg-zinc-900 disabled:text-zinc-600"
          >
            {clearBusy ? "清空中..." : "一键清空"}
          </button>
        </div>
      )}
    >
      <div className="mb-3 flex flex-col gap-2 lg:flex-row lg:items-center lg:justify-between">
        <label className="relative block min-w-0 flex-1">
          <span className="sr-only">搜索映射表</span>
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索问题编号、飞书 ID、TB 任务 ID、状态或错误"
            className="h-9 w-full rounded border border-zinc-700 bg-zinc-950 px-3 text-xs text-zinc-200 outline-none focus:border-blue-500"
          />
        </label>
        <div className="flex flex-wrap items-center gap-2 text-[11px] text-zinc-500">
          <span>
            显示 {visibleStart}-{visibleEnd} / {filteredRecords.length}
          </span>
          <select
            value={pageSize}
            onChange={(event) => setPageSize(Number(event.target.value) || 20)}
            className="h-9 rounded border border-zinc-700 bg-zinc-950 px-2 text-xs text-zinc-200 outline-none focus:border-blue-500"
          >
            <option value={10}>10 / 页</option>
            <option value={20}>20 / 页</option>
            <option value={50}>50 / 页</option>
            <option value={100}>100 / 页</option>
          </select>
        </div>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[1180px] text-left text-xs">
          <thead className="text-[11px] uppercase text-zinc-500">
            <tr className="border-b border-zinc-800">
              <th className="w-10 py-2 pr-3">
                <input
                  ref={pageSelectRef}
                  type="checkbox"
                  checked={allPageSelected}
                  onChange={(event) => onTogglePage?.(pageRecords, event.target.checked)}
                  disabled={!canEdit || !pageRecords.length || selectedBusy || deleteBusy}
                  aria-label="选择当前页映射记录"
                  className="h-4 w-4 accent-blue-600"
                />
              </th>
              <th className="py-2 pr-3">状态</th>
              <th className="py-2 pr-3" aria-sort={sort.field === "problemNo" ? (sort.direction === "asc" ? "ascending" : "descending") : "none"}>
                <button type="button" onClick={() => changeSort("problemNo")} className="inline-flex items-center gap-1 hover:text-zinc-200" title="按问题编号排序">
                  问题编号 <span aria-hidden="true">{sortMark("problemNo")}</span>
                </button>
              </th>
              <th className="py-2 pr-3">TB 任务 ID</th>
              <th className="py-2 pr-3" aria-sort={sort.field === "sourceUpdatedAt" ? (sort.direction === "asc" ? "ascending" : "descending") : "none"}>
                <button type="button" onClick={() => changeSort("sourceUpdatedAt")} className="inline-flex items-center gap-1 hover:text-zinc-200" title="按源更新时间排序">
                  源更新时间 <span aria-hidden="true">{sortMark("sourceUpdatedAt")}</span>
                </button>
              </th>
              <th className="py-2 pr-3">最后同步</th>
              <th className="py-2 pr-3">错误</th>
              <th className="py-2 pr-3">操作</th>
            </tr>
          </thead>
          <tbody>
            {pageRecords.map((row) => {
              const key = recordKey(row);
              const tbUrl = renderTbUrl(getPath(config, "teambition.taskUrlTemplate"), row);
              const problemNo = recordProblemNo(row);
              const tbTaskDisplayId = formatTbTaskDisplayId(row);
              const bookmarks = rowBookmarks(row);
              const previewState = recordPreviewByKey[key];
              const rowBusy = ["loading", "applying"].includes(previewState?.status);
              const syncLabel = row.targetTaskId ? "更新" : "同步";
              const hidden = isHiddenFeishuSyncRecord(row);
              return (
                <React.Fragment key={key}>
                  <tr className={`border-b border-zinc-900 text-zinc-300 ${selectedRecordKeys[key] ? "bg-blue-950/10" : ""} ${hidden ? "opacity-60" : ""}`}>
                    <td className="py-2 pr-3 align-top">
                      <input
                        type="checkbox"
                        checked={!!selectedRecordKeys[key]}
                        onChange={(event) => onToggleRecord?.(row, event.target.checked)}
                        disabled={!canEdit || rowBusy || deleteBusy}
                        aria-label={`选择映射记录 ${problemNo}`}
                        className="h-4 w-4 accent-blue-600"
                      />
                    </td>
                    <td className="py-2 pr-3 align-top"><span className={`rounded border px-2 py-0.5 ${statusColor(row.syncStatus)}`}>{row.syncStatus || "-"}</span></td>
                    <td className="py-2 pr-3 align-top font-mono">
                      <div className="flex flex-wrap items-center gap-1.5">
                        {row.sourceWorkItemUrl ? <a href={row.sourceWorkItemUrl} target="_blank" rel="noreferrer" className="text-blue-300 hover:text-blue-200">{problemNo}</a> : <span>{problemNo}</span>}
                        {bookmarks.map((bookmark) => <BookmarkBadge key={bookmark} label={bookmark} />)}
                      </div>
                      {row.scopeStatus?.message && <div className="mt-1 max-w-[360px] whitespace-normal break-words font-sans text-[10px] leading-relaxed text-amber-200">{row.scopeStatus.message}</div>}
                      <div className="mt-0.5 text-[10px] text-zinc-600">
                        {row.sourceWorkItemId ? `飞书ID ${row.sourceWorkItemId}` : ""}{row.sourceProjectKey || row.sourceWorkItemTypeKey ? ` · ${row.sourceProjectKey}/${row.sourceWorkItemTypeKey}` : ""}
                      </div>
                    </td>
                    <td className="py-2 pr-3 align-top font-mono">
                      {row.targetTaskId ? (tbUrl ? <a href={tbUrl} target="_blank" rel="noreferrer" className="text-blue-300 hover:text-blue-200">{tbTaskDisplayId}</a> : tbTaskDisplayId) : "-"}
                      {row.targetTaskId && <div className="mt-0.5 text-[10px] text-zinc-600">taskId {row.targetTaskId}</div>}
                    </td>
                    <td className="py-2 pr-3 align-top text-zinc-500">{formatTime(row.sourceUpdatedAt)}</td>
                    <td className="py-2 pr-3 align-top text-zinc-500">{formatTime(row.lastSyncedAt)}</td>
                    <td className="max-w-sm truncate py-2 pr-3 align-top text-red-300" title={row.lastError || ""}>{row.lastError || ""}</td>
                    <td className="py-2 pr-3 align-top">
                      <div className="flex flex-wrap gap-1.5">
                        <button
                          type="button"
                          onClick={() => onPreviewRecords?.([row])}
                          disabled={!canEdit || clearBusy || deleteBusy || anyRecordBusy}
                          title="先执行 dry-run，确认行内结果后才会生效"
                          className="rounded border border-blue-700/70 bg-blue-950/25 px-2.5 py-1.5 text-[11px] text-blue-200 hover:bg-blue-900/35 disabled:border-zinc-800 disabled:bg-zinc-900 disabled:text-zinc-600"
                        >
                          {previewState?.status === "loading" ? "预演中..." : previewState?.status === "applying" ? "生效中..." : syncLabel}
                        </button>
                        <button
                          type="button"
                          onClick={() => onDeleteRecords?.([row])}
                          disabled={!canEdit || clearBusy || deleteBusy || anyRecordBusy}
                          className="rounded border border-red-800/70 bg-red-950/20 px-2.5 py-1.5 text-[11px] text-red-200 hover:bg-red-900/35 disabled:border-zinc-800 disabled:bg-zinc-900 disabled:text-zinc-600"
                        >
                          删除
                        </button>
                      </div>
                    </td>
                  </tr>
                  {previewState && (
                    <tr className="border-b border-zinc-800 bg-zinc-950/80">
                      <td colSpan={8} className="px-3 py-3">
                        <InlineRecordDryRunResult
                          record={row}
                          state={previewState}
                          config={config}
                          canEdit={canEdit}
                          displayContext={displayContext}
                          actionBusy={anyRecordBusy}
                          onApply={onApplyPreviews}
                          onDismiss={onDismissPreview}
                        />
                      </td>
                    </tr>
                  )}
                </React.Fragment>
              );
            })}
          </tbody>
        </table>
        {!records.length && <div className="py-10 text-center text-sm text-zinc-600">暂无同步关系</div>}
        {records.length > 0 && !filteredRecords.length && <div className="py-10 text-center text-sm text-zinc-600">没有匹配的同步关系</div>}
      </div>
      <div className="mt-3 flex flex-col gap-2 border-t border-zinc-800 pt-3 text-xs text-zinc-500 sm:flex-row sm:items-center sm:justify-between">
        <div>
          第 {safePage} / {totalPages} 页
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => setPage(1)}
            disabled={safePage <= 1}
            className="rounded border border-zinc-700 bg-zinc-950 px-2.5 py-1.5 text-xs text-zinc-300 hover:bg-zinc-800 disabled:text-zinc-600"
          >
            首页
          </button>
          <button
            type="button"
            onClick={() => setPage((current) => Math.max(1, current - 1))}
            disabled={safePage <= 1}
            className="rounded border border-zinc-700 bg-zinc-950 px-2.5 py-1.5 text-xs text-zinc-300 hover:bg-zinc-800 disabled:text-zinc-600"
          >
            上一页
          </button>
          <button
            type="button"
            onClick={() => setPage((current) => Math.min(totalPages, current + 1))}
            disabled={safePage >= totalPages}
            className="rounded border border-zinc-700 bg-zinc-950 px-2.5 py-1.5 text-xs text-zinc-300 hover:bg-zinc-800 disabled:text-zinc-600"
          >
            下一页
          </button>
          <button
            type="button"
            onClick={() => setPage(totalPages)}
            disabled={safePage >= totalPages}
            className="rounded border border-zinc-700 bg-zinc-950 px-2.5 py-1.5 text-xs text-zinc-300 hover:bg-zinc-800 disabled:text-zinc-600"
          >
            末页
          </button>
        </div>
      </div>
    </Section>
  );
}

function recordPreviewDisplayRow(previewState = {}) {
  const result = previewState?.result;
  if (!result || typeof result !== "object") return null;
  return collectSyncResults(result)[0] || result;
}

function InlineRecordDryRunResult({ record, state, config, canEdit = false, displayContext, actionBusy = false, onApply, onDismiss }) {
  const resultRow = recordPreviewDisplayRow(state);
  const isLoading = state.status === "loading";
  const isApplying = state.status === "applying";
  const isApplied = state.status === "applied";
  const isExpired = state.status === "expired" || (state.status === "ready" && recordPreviewExpired(state));
  const effectiveStatus = isExpired ? "expired" : state.status;
  const canApply = effectiveStatus === "ready" && !!state.planId;
  const statusCopy = {
    loading: { label: "dry-run 执行中", tone: "border-blue-700/60 bg-blue-950/25 text-blue-200" },
    ready: { label: "dry-run 已完成，等待确认", tone: "border-amber-700/60 bg-amber-950/20 text-amber-200" },
    applying: { label: "正在按预演方案生效", tone: "border-blue-700/60 bg-blue-950/25 text-blue-200" },
    applied: { label: "预演方案已生效", tone: "border-emerald-700/60 bg-emerald-950/20 text-emerald-200" },
    expired: { label: "dry-run 方案已过期", tone: "border-red-800/60 bg-red-950/25 text-red-200" },
    error: { label: state.errorStage === "apply" ? "预演方案生效失败" : "dry-run 失败", tone: "border-red-800/60 bg-red-950/25 text-red-200" },
  }[effectiveStatus] || { label: effectiveStatus || "dry-run", tone: "border-zinc-700 bg-zinc-900 text-zinc-300" };
  const expiresAt = state.expiresAt ? formatTime(state.expiresAt) : "";
  return (
    <div className="rounded border border-zinc-800 bg-zinc-950 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className={`rounded border px-2 py-1 text-[11px] ${statusCopy.tone}`}>{statusCopy.label}</span>
        {expiresAt && !isApplied && <span className="text-[11px] text-zinc-500">方案有效期至 {expiresAt}</span>}
        {state.planId && <span className="max-w-[260px] truncate font-mono text-[10px] text-zinc-600" title={state.planId}>plan {state.planId}</span>}
        <div className="ml-auto flex flex-wrap gap-2">
          {canApply && (
            <button
              type="button"
              onClick={() => onApply?.([record])}
              disabled={!canEdit || actionBusy}
              className="rounded bg-emerald-600 px-3 py-1.5 text-[11px] font-medium text-white hover:bg-emerald-500 disabled:bg-zinc-800 disabled:text-zinc-600"
            >
              {record.targetTaskId ? "确认更新" : "确认同步"}
            </button>
          )}
          <button
            type="button"
            onClick={() => onDismiss?.(record)}
            disabled={isLoading || isApplying}
            className="rounded border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-[11px] text-zinc-300 hover:bg-zinc-800 disabled:text-zinc-600"
          >
            收起结果
          </button>
        </div>
      </div>
      {(isLoading || isApplying) && (
        <div className="mt-3 rounded border border-blue-800/40 bg-blue-950/15 px-3 py-2 text-xs text-blue-200">
          <span className="mr-2 inline-block h-3 w-3 animate-spin rounded-full border border-blue-300 border-t-transparent align-[-2px]" />
          {isLoading ? "正在生成本行 dry-run 易读结果..." : "正在直接应用已保存的 dry-run 方案，不会重新执行 /run..."}
        </div>
      )}
      {state.error && (
        <div className="mt-3 rounded border border-red-800/50 bg-red-950/25 px-3 py-2 text-xs leading-relaxed text-red-200">
          {state.error}
        </div>
      )}
      {isExpired && !state.error && (
        <div className="mt-3 rounded border border-red-800/50 bg-red-950/25 px-3 py-2 text-xs leading-relaxed text-red-200">
          该 dry-run 方案已过有效期，请点击本行“{record.targetTaskId ? "更新" : "同步"}”重新预演。
        </div>
      )}
      {resultRow && (
        <div className="mt-3">
          <ReadableSyncResultRow
            row={resultRow}
            index={0}
            dryRun={!isApplied}
            config={config}
            displayContext={displayContext}
          />
        </div>
      )}
    </div>
  );
}

function ErrorsPanel({ errors, retryable, rawPayloads, loading = false, loaded = false, error = "", onRetry }) {
  return (
    <div className="space-y-4">
      {loading && !loaded && (
        <div className="rounded border border-sky-800/40 bg-sky-950/20 px-3 py-3 text-xs text-sky-200">
          正在按需加载错误与重试数据；不会阻塞其他页签。
        </div>
      )}
      {error && (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded border border-amber-800/40 bg-amber-950/20 px-3 py-2 text-xs text-amber-200">
          <span>{error}</span>
          <button type="button" onClick={onRetry} disabled={loading} className="rounded border border-amber-700/60 px-2 py-1 hover:bg-amber-900/30 disabled:opacity-50">
            {loading ? "重试中" : "重试"}
          </button>
        </div>
      )}
      <Section title={`开放错误 (${errors.length})`}>
        <Rows rows={errors} columns={[
          ["stage", "阶段"],
          ["sourceWorkItemId", "飞书工单"],
          ["targetTaskId", "TB 任务"],
          ["errorMessage", "错误"],
          ["retryCount", "重试"],
          ["nextRetryAt", "下次重试"],
        ]} />
      </Section>
      <Section title={`可重试错误 (${retryable.length})`}>
        <Rows rows={retryable} columns={[
          ["stage", "阶段"],
          ["sourceWorkItemId", "飞书工单"],
          ["targetTaskId", "TB 任务"],
          ["errorMessage", "错误"],
          ["retryCount", "重试"],
        ]} />
      </Section>
      <Section title={`最近原始 payload (${rawPayloads.length})`}>
        <Rows rows={rawPayloads} columns={[
          ["sourceWorkItemId", "飞书工单"],
          ["payloadHash", "Hash"],
          ["createdAt", "创建时间"],
        ]} />
      </Section>
    </div>
  );
}

function Rows({ rows, columns }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[760px] text-left text-xs">
        <thead className="text-[11px] text-zinc-500">
          <tr className="border-b border-zinc-800">{columns.map(([, label]) => <th key={label} className="py-2 pr-3">{label}</th>)}</tr>
        </thead>
        <tbody>
          {rows.map((row, idx) => (
            <tr key={row.id || row.errorKey || row.payloadHash || idx} className="border-b border-zinc-900">
              {columns.map(([key]) => <td key={key} className="max-w-md truncate py-2 pr-3 text-zinc-300">{String(row[key] ?? "")}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
      {!rows.length && <div className="py-8 text-center text-xs text-zinc-600">暂无记录</div>}
    </div>
  );
}

function PreviewPanel({
  config,
  workItemIds,
  setWorkItemIds,
  sampleJson,
  setSampleJson,
  preview,
  previewBusy,
  quickRunResult,
  quickRunEvents = [],
  onDryRun,
  onPocDryRun,
  onPreviewJson,
  onRun,
  onWebDryRun,
  onWebRun,
  onMcpDryRun,
  onMcpRun,
  canEdit = false,
  feishuWeb,
  feishuMcp,
  tbMembers,
  tbTasklists,
  tbSprints,
  sheetUpdate,
  onApplySheetUpdate,
  onClearSheetUpdate,
}) {
  const previewLoading = !!previewBusy || quickRunResult?.status === "running" || quickRunResult?.status === "settling";
  const [resultView, setResultView] = useState("readable");
  const [sampleExpanded, setSampleExpanded] = useState(false);
  const [runConfirmMode, setRunConfirmMode] = useState("");
  const [previewDisplayText, setPreviewDisplayText] = useState(() => formatPreviewForDisplay(preview));
  const resultPayload = preview || quickRunResult?.data || null;
  const rawLogText = useMemo(
    () => formatRawRunLog(quickRunEvents, quickRunResult?.run || quickRunResult),
    [quickRunEvents, quickRunResult],
  );
  const confirmRun = () => {
    const action = runConfirmMode === "web" ? onWebRun : runConfirmMode === "mcp" ? onMcpRun : onRun;
    setRunConfirmMode("");
    action?.();
  };

  useEffect(() => {
    if (previewLoading) {
      setPreviewDisplayText("正在执行飞书同步，请等待最终结果返回...");
      return undefined;
    }

    let cancelled = false;
    const controller = typeof AbortController !== "undefined" ? new AbortController() : null;
    let timer = null;

    const commitPreviewText = (text) => {
      if (cancelled) return;
      scheduleTransition(() => {
        if (!cancelled) setPreviewDisplayText(text);
      });
    };

    if (!preview) {
      commitPreviewText(formatPreviewForDisplay(preview));
      return () => {
        cancelled = true;
        controller?.abort();
      };
    }

    setPreviewDisplayText("正在后台整理预览结果...");
    timer = setTimeout(() => {
      formatPreviewForDisplayAsync(preview, { signal: controller?.signal })
        .then(commitPreviewText)
        .catch((err) => {
          if (cancelled || err?.message === "preview format cancelled") return;
          commitPreviewText(formatPreviewForDisplay(preview));
        });
    }, PREVIEW_FORMAT_DELAY_MS);

    return () => {
      cancelled = true;
      controller?.abort();
      clearTimeout(timer);
    };
  }, [preview, previewLoading]);
  return (
    <div className="space-y-4">
      <Section title="执行控制">
        <div className="space-y-3">
          <label className="block">
            <div className="mb-1 flex items-center justify-between gap-2">
              <span className="block text-[11px] text-zinc-500">飞书问题编号（NSCP-xxxx），每行一个</span>
              <button
                type="button"
                onClick={() => setWorkItemIds("")}
                disabled={!workItemIds}
                className="rounded border border-zinc-700 bg-zinc-900 px-2 py-1 text-[11px] text-zinc-300 hover:bg-zinc-800 disabled:border-zinc-800 disabled:text-zinc-600"
              >
                清空
              </button>
            </div>
            <textarea value={workItemIds} onChange={(e) => setWorkItemIds(e.target.value)} placeholder={"NSCP-15889\nNSCP-16045"} className="min-h-28 w-full rounded border border-zinc-700 bg-zinc-950 p-3 font-mono text-xs text-zinc-200 outline-none focus:border-blue-500" />
          </label>
          <div className="flex flex-wrap items-center gap-2">
            <button onClick={onDryRun} disabled={!canEdit || previewBusy} className="rounded bg-blue-600 px-3 py-2 text-xs text-white hover:bg-blue-500 disabled:bg-zinc-700">按飞书问题编号 dry-run</button>
            <button onClick={onPocDryRun} disabled={!canEdit || previewBusy || !(config?.pocWorkItemIds || []).length} className="rounded border border-zinc-700 bg-zinc-900 px-3 py-2 text-xs text-zinc-200 hover:bg-zinc-800 disabled:text-zinc-600">PoC dry-run</button>
            <button onClick={onWebDryRun} disabled={!canEdit || previewBusy || !feishuWeb?.valid} className="rounded border border-blue-700/60 bg-blue-950/20 px-3 py-2 text-xs text-blue-200 hover:bg-blue-900/30 disabled:border-zinc-800 disabled:bg-zinc-900 disabled:text-zinc-600">网页态 dry-run</button>
            <button onClick={onMcpDryRun} disabled={!canEdit || previewBusy || !feishuMcp?.configured} className="rounded border border-sky-700/60 bg-sky-950/20 px-3 py-2 text-xs text-sky-200 hover:bg-sky-900/30 disabled:border-zinc-800 disabled:bg-zinc-900 disabled:text-zinc-600">MCP dry-run</button>
            <div className="mx-1 hidden h-6 w-px bg-red-900/60 sm:block" />
            <button onClick={() => setRunConfirmMode("default")} disabled={!canEdit || previewBusy} className="rounded bg-red-600 px-3 py-2 text-xs text-white hover:bg-red-500 disabled:bg-zinc-800 disabled:text-zinc-600" data-testid="feishu-run-request-default">执行 /run</button>
            <button onClick={() => setRunConfirmMode("web")} disabled={!canEdit || previewBusy || !feishuWeb?.valid} className="rounded border border-red-700/70 bg-red-950/30 px-3 py-2 text-xs text-red-200 hover:bg-red-900/40 disabled:border-zinc-800 disabled:bg-zinc-900 disabled:text-zinc-600" data-testid="feishu-run-request-web">网页态 /run</button>
            <button onClick={() => setRunConfirmMode("mcp")} disabled={!canEdit || previewBusy || !feishuMcp?.configured} className="rounded border border-red-700/70 bg-red-950/30 px-3 py-2 text-xs text-red-200 hover:bg-red-900/40 disabled:border-zinc-800 disabled:bg-zinc-900 disabled:text-zinc-600" data-testid="feishu-run-request-mcp">MCP /run</button>
          </div>
          <div className="text-xs text-red-300">真实 /run 会创建或更新 TB 任务。确认目标是 TB 测试项目后再执行。</div>
          <div className="border-t border-zinc-800 pt-3">
            <button
              type="button"
              onClick={() => setSampleExpanded((value) => !value)}
              className="flex w-full items-center justify-between rounded border border-zinc-800 bg-zinc-950 px-3 py-2 text-left text-xs text-zinc-300 hover:bg-zinc-900"
            >
              <span>样例飞书工单 JSON</span>
              <span className="text-[11px] text-zinc-500">{sampleExpanded ? "收起" : "展开"}</span>
            </button>
            {sampleExpanded && (
              <div className="mt-2">
                <label className="block">
                  <span className="sr-only">样例飞书工单 JSON</span>
                  <textarea value={sampleJson} onChange={(e) => setSampleJson(e.target.value)} className="min-h-36 w-full rounded border border-zinc-700 bg-zinc-950 p-3 font-mono text-xs text-zinc-200 outline-none focus:border-blue-500" />
                </label>
                <button onClick={onPreviewJson} disabled={!canEdit || previewBusy || !sampleJson.trim()} className="mt-2 rounded border border-zinc-700 bg-zinc-900 px-3 py-2 text-xs text-zinc-200 hover:bg-zinc-800 disabled:text-zinc-600">用样例生成 payload</button>
              </div>
            )}
          </div>
        </div>
      </Section>
      <Section title="结果分析">
        <div className="mb-3 flex flex-wrap gap-2">
          {[
            ["readable", "易读结果"],
            ["raw", "原始结果"],
            ["logs", "原始日志"],
          ].map(([key, label]) => (
            <button
              key={key}
              type="button"
              onClick={() => setResultView(key)}
              className={`rounded border px-3 py-1.5 text-xs transition ${resultView === key ? "border-blue-700 bg-blue-950/40 text-blue-200" : "border-zinc-700 bg-zinc-950 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200"}`}
            >
              {label}
            </button>
          ))}
        </div>
        {previewLoading ? (
          <div className="mb-2 rounded border border-blue-800/50 bg-blue-950/20 px-3 py-2 text-xs text-blue-200">
            <span className="mr-2 inline-block h-3 w-3 animate-spin rounded-full border border-blue-300 border-t-transparent align-[-2px]" />
            正在执行，请等待最终同步结果返回。
          </div>
        ) : null}

        {resultView === "readable" && !previewLoading && (
          <div className="space-y-4">
            <ReadableSyncResultPanel data={resultPayload} result={quickRunResult} config={config} tbMembers={tbMembers} tbTasklists={tbTasklists} tbSprints={tbSprints} />
            <SheetUpdatePanel
              state={sheetUpdate || {}}
              onApply={onApplySheetUpdate}
              onClear={onClearSheetUpdate}
            />
          </div>
        )}

        {resultView === "raw" && (
          <>
            {!previewLoading && preview && (
              <div className="mb-2 rounded border border-zinc-800 bg-zinc-950 px-3 py-2 text-[11px] leading-relaxed text-zinc-500">
                这里展示网关返回的原始结果预览 JSON；大批量结果会被网关精简，便于浏览器稳定打开。
              </div>
            )}
            <pre className="max-h-[560px] overflow-auto rounded border border-zinc-800 bg-zinc-950 p-3 text-xs leading-relaxed text-zinc-300">
              {previewDisplayText}
            </pre>
          </>
        )}

        {resultView === "logs" && (
          <>
            <div className="mb-2 rounded border border-zinc-800 bg-zinc-950 px-3 py-2 text-[11px] leading-relaxed text-zinc-500">
              这里是本次运行事件日志的原始 JSON，包含阶段、动作、目标 TB、错误消息和时间戳。
            </div>
            <pre className="max-h-[560px] overflow-auto rounded border border-zinc-800 bg-zinc-950 p-3 text-xs leading-relaxed text-zinc-300">
              {rawLogText}
            </pre>
          </>
        )}
      </Section>
      {runConfirmMode && (
        <RunConfirmDialog
          mode={runConfirmMode}
          onCancel={() => setRunConfirmMode("")}
          onConfirm={confirmRun}
        />
      )}
    </div>
  );
}
