/**
 * devbench 模块前端 API 封装 —— 全部走 /api/devbench/*
 */
import { getApiUrl, getGatewayUrl } from "../../services/gateway.js";
import { authenticatedFetch, getAdminToken } from "../../services/adminAuth.js";
import { writeEngineStatusCache } from "./engineStatusCache.js";
import {
  DEFAULT_LOCAL_GATEWAY_URL,
  requestRepoAccessFromLocalGateway,
} from "./repoAccessClient.mjs";

export const DEVBENCH_TASKS_CHANGED_EVENT = "devbench:tasks-changed";

export function emitDevbenchTasksChanged(detail = {}) {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(DEVBENCH_TASKS_CHANGED_EVENT, { detail }));
}

export function storyArtifactUrl(tabId, ref, { download = false, ticket = "" } = {}) {
  const query = new URLSearchParams({ ref: String(ref || "") });
  if (download) query.set("download", "1");
  if (ticket) query.set("ticket", String(ticket));
  const target = getApiUrl(`/api/devbench/tabs/${encodeURIComponent(tabId || "")}/artifact?${query}`);
  try {
    return new URL(target, window.location.origin).href;
  } catch {
    return target;
  }
}

export const STORY_INITIALIZATION_PREPARE_TIMEOUT_MS = 30_000;
export const STORY_INITIALIZATION_CREATE_TIMEOUT_MS = 30_000;
export const CONFIG_INFERENCE_REVIEW_TIMEOUT_MS = 30_000;
export const STORY_ATTACHMENT_UPLOAD_TIMEOUT_MS = 120_000;
// TB 单解析：resolveTbTask 会触发 resolveTicketInput + getTaskDetail 等 TB OpenAPI 调用，
// 历史上出现过 TB 接口慢/挂死导致前端“正在读取 TB 单”按钮无限等待，故加硬性超时。
export const TB_TASK_RESOLVE_TIMEOUT_MS = 45_000;
// 配置推理 run：hydrateStoryTrainingTicket 会串/并行拉取 TB 详情/备注/评论/附件并解析附件内容，
// 可能很慢；reopen 路径上前端没有兜底超时会表现为“正在读取 TB 单”卡死。
export const CONFIG_INFERENCE_RUN_TIMEOUT_MS = 90_000;

async function binaryWrite(url, body, {
  timeoutMs = 0,
  timeoutCode = "REQUEST_TIMEOUT",
  timeoutMessage = "上传超时，已停止等待；请重试。",
  networkErrorPrefix = "上传失败",
} = {}) {
  const controller = timeoutMs > 0 ? new AbortController() : null;
  const timeout = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
  try {
    const response = await authenticatedFetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream" },
      body,
      ...(controller ? { signal: controller.signal } : {}),
    });
    let data;
    try {
      data = await response.json();
    } catch {
      data = { ok: false, error: `HTTP ${response.status}` };
    }
    if (!data || typeof data !== "object" || Array.isArray(data)) {
      data = { ok: false, error: `HTTP ${response.status}` };
    }
    if (!response.ok) {
      data.ok = false;
      if (!data.error) data.error = `HTTP ${response.status}`;
    }
    if (data.error && data.ok === undefined) data.ok = false;
    return data;
  } catch (error) {
    if (controller?.signal.aborted) {
      return {
        ok: false,
        code: timeoutCode,
        retryable: true,
        error: timeoutMessage,
      };
    }
    return {
      ok: false,
      code: "NETWORK_ERROR",
      retryable: true,
      error: `${networkErrorPrefix}：${error?.message || "无法连接 Gateway"}`,
    };
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function call(method, path, body, baseUrl, requestOptions = {}) {
  const opts = { method, headers: { "Content-Type": "application/json" } };
  const timeoutMs = Number(requestOptions?.timeoutMs) > 0
    ? Number(requestOptions.timeoutMs)
    : 0;
  const controller = timeoutMs ? new AbortController() : null;
  const timeout = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
  if (controller) opts.signal = controller.signal;
  // 带上管理后台 token（若已登录），供需要管理员权限的接口鉴权（如保存远程地址）
  const token = getAdminToken();
  if (token) opts.headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) opts.body = JSON.stringify(body);
  let r;
  try {
    const url = baseUrl === undefined
      ? getApiUrl(`/api/devbench${path}`)
      : `${String(baseUrl || "").replace(/\/+$/, "")}/api/devbench${path}`;
    r = await fetch(url, opts);
  } catch (error) {
    if (controller?.signal.aborted) {
      return {
        ok: false,
        code: "REQUEST_TIMEOUT",
        retryable: true,
        error: `请求超时（${Math.ceil(timeoutMs / 1000)} 秒），已停止等待；请重试。`,
      };
    }
    return { ok: false, code: "NETWORK_ERROR", error: `网络请求失败：${error?.message || "无法连接 Gateway"}` };
  } finally {
    if (timeout) clearTimeout(timeout);
  }
  let data;
  try { data = await r.json(); } catch { data = { ok: false, error: `HTTP ${r.status}` }; }
  if (!r.ok) {
    data.ok = false;
    if (!data.error) data.error = `HTTP ${r.status}`;
  }
  if (data.error && data.ok === undefined) data.ok = false;
  return data;
}

async function probeGateway(baseUrl, timeoutMs = 1800) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${String(baseUrl || "").replace(/\/+$/, "")}/api/health`, {
      signal: controller.signal,
    });
    if (!response.ok) return false;
    const data = await response.json().catch(() => null);
    return data?.status === "ok";
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

async function analyzeSummaryTemplate(file, { model = "", tier = "" } = {}) {
  if (!file) return { ok: false, error: "请选择模板文件" };
  const query = new URLSearchParams({
    filename: file.name || "template",
    mime: file.type || "application/octet-stream",
  });
  if (String(model || "").trim()) query.set("model", String(model).trim());
  if (String(tier || "").trim()) query.set("tier", String(tier).trim());
  const headers = { "Content-Type": "application/octet-stream" };
  const token = getAdminToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  try {
    const response = await authenticatedFetch(getApiUrl(`/api/devbench/summary/template/analyze?${query}`), {
      method: "POST",
      headers,
      body: file,
    });
    const data = await response.json().catch(() => ({ ok: false, error: `HTTP ${response.status}` }));
    if (!response.ok) data.ok = false;
    return data;
  } catch (error) {
    return { ok: false, code: "NETWORK_ERROR", error: `模板上传失败：${error?.message || "无法连接 Gateway"}` };
  }
}

const CLOSED_STORY_PURGE_EXECUTION_FAILURE_CODES = new Set([
  "RESOURCE_DELETE_FAILED",
  "CORE_DELETE_FAILED",
  "EXECUTION_HISTORY_DELETE_FAILED",
  "CLOSED_RECORD_DELETE_FAILED",
  "DELETE_MARKER_FAILED",
]);

// 预检失败也可能携带 data（它是最新删除范围，不是执行结果）。只有服务端明确标记
// partial、错误码属于执行阶段，且 data 具有执行结果形状时，UI 才能展示不可恢复明细。
export function getClosedStoryPurgePartialResult(response) {
  const data = response?.data;
  if (response?.ok !== false || response?.partial !== true) return null;
  if (!CLOSED_STORY_PURGE_EXECUTION_FAILURE_CODES.has(String(response?.code || ""))) return null;
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  if (!data.core || typeof data.core !== "object" || Array.isArray(data.core)) return null;
  if (!["pending", "deleted"].includes(String(data.story?.status || ""))) return null;
  for (const key of ["conversationBackups", "archiveDirectory", "attachments"]) {
    if (!data[key] || typeof data[key] !== "object" || Array.isArray(data[key])) return null;
  }
  return data;
}

function archiveLiveSnapshot(live) {
  if (!live || typeof live !== "object") return null;
  return {
    text: String(live.text || ""),
    engine: live.engine || null,
    tools: Array.isArray(live.tools) ? live.tools : [],
    usage: live.usage || null,
    startedAt: live.startedAt || live.started_at || null,
    updatedAt: live.updatedAt || live.updated_at || Date.now(),
  };
}

export const devbenchApi = {
  // 待办任务列表
  listTasks: () => call("GET", "/tasks"),
  createTask: (body) => call("POST", "/tasks", body || {}),
  createTasksBatch: (text, group) => call("POST", "/tasks/batch", { text, ...(group || {}) }),
  updateTask: (id, updates) => call("PUT", `/tasks/${id}`, updates || {}),
  deleteTask: (id) => call("DELETE", `/tasks/${id}`),
  syncTbTasks: () => call("POST", "/tasks/sync-tb"),
  resolveTbTask: (input) => call("POST", "/tb-task/resolve", { input }, undefined, { timeoutMs: TB_TASK_RESOLVE_TIMEOUT_MS }),
  importTbTask: (input, group) => call("POST", "/tasks/import-tb", { input, ...(group || {}) }),
  listTaskGroups: () => call("GET", "/task-groups"),
  createTaskGroup: (body) => call("POST", "/task-groups", body || {}),
  updateTaskGroup: (id, body) => call("PUT", `/task-groups/${encodeURIComponent(id)}`, body || {}),
  deleteTaskGroup: (id, clearTasks = true) => call("DELETE", `/task-groups/${encodeURIComponent(id)}${clearTasks ? "?clearTasks=1" : "?clearTasks=0"}`),

  // 导入/导出（工程配置 + 任务列表，跨机/跨端同步）
  exportSync: () => call("GET", "/export"),
  importSync: (data, mode) => call("POST", "/import", { data, mode }),
  // 本机工程列表 + 克隆父路径导出（导入复用 importSync，不携带任务）
  exportProjects: () => call("GET", "/export-projects"),
  clearProjects: () => call("DELETE", "/projects"),

  // 工程定义（统一维度：仓库+可选本地路径）
  getProjectDefs: () => call("GET", "/project-defs"),
  upsertProjectDef: (def) => call("PUT", "/project-defs", def || {}),
  deleteProjectDef: (id) => call("DELETE", `/project-defs/${encodeURIComponent(id)}`),
  // 统一配置推断：AI训练随机抽题与故事点开发前复核共用同一套 run/review/sample。
  getConfigInference: (projectId) => call("GET", `/ai-training/config-inference${projectId ? `?projectId=${encodeURIComponent(projectId)}` : ""}`),
  runConfigInference: (body) => call("POST", "/ai-training/config-inference/run", body || {}, undefined, { timeoutMs: CONFIG_INFERENCE_RUN_TIMEOUT_MS }),
  previewConfigTrainingSource: (projectId, sourceUrl) => call("POST", "/ai-training/config-inference/task-source/preview", { projectId, sourceUrl }),
  saveConfigTrainingSource: (projectId, sourceUrl, filter = {}) => call("PUT", "/ai-training/config-inference/task-source", { projectId, sourceUrl, pool: filter.completion || "all", statusKeys: filter.statusKeys ?? null }),
  clearConfigTrainingSource: (projectId) => call("DELETE", `/ai-training/config-inference/task-source?projectId=${encodeURIComponent(projectId || "")}`),
  runRandomConfigTraining: (projectId, pool = "staged", sourceUrl = "", excludeTaskIds = [], sessionId = "", statusKeys = null) => call("POST", "/ai-training/config-inference/random", { projectId, pool, sourceUrl, excludeTaskIds, sessionId, statusKeys }),
  exitConfigTrainingSession: (projectId, sessionId) => call("POST", "/ai-training/config-inference/session/exit", { projectId, sessionId }),
  refreshConfigInference: (projectId, id, options = {}) => call("POST", `/ai-training/config-inference/runs/${encodeURIComponent(id)}/refresh`, { projectId, ...(options || {}) }),
  reviewConfigInference: (projectId, id, review, recovery) => call("POST", `/ai-training/config-inference/runs/${encodeURIComponent(id)}/review`, {
    ...(review || {}),
    projectId,
    ...(recovery ? { recovery } : {}),
  }, undefined, { timeoutMs: CONFIG_INFERENCE_REVIEW_TIMEOUT_MS }),
  resolveConfigInferenceSymbols: (projectId, id, review) => call("POST", `/ai-training/config-inference/runs/${encodeURIComponent(id)}/resolve-symbols`, { ...(review || {}), projectId }),
  updateConfigInferenceValueBinding: (projectId, logicalKey, patch = {}) => call("PUT", `/ai-training/config-inference/value-bindings/${encodeURIComponent(logicalKey || "")}`, {
    ...(patch || {}),
    projectId,
  }),
  deleteConfigInferenceRun: (projectId, id) => call("DELETE", `/ai-training/config-inference/runs/${encodeURIComponent(id)}${projectId ? `?projectId=${encodeURIComponent(projectId)}` : ""}`),
  // AI 训练治理 v2：annotation 与 serving、共享值与本机绑定分离。
  // 旧 Gateway 可能返回 404；调用方必须明确提示“治理接口未启用”，不得降级成已成功。
  getAiTrainingGovernanceSummary: (projectId) => call("GET", `/ai-training/v2/governance/summary${projectId ? `?projectId=${encodeURIComponent(projectId)}` : ""}`),
  approveAiTrainingAnnotation: (projectId, annotationId, body = {}) => call(
    "POST",
    `/ai-training/v2/annotations/${encodeURIComponent(annotationId || "")}/approve`,
    { ...(body || {}), projectId },
  ),
  revokeAiTrainingAnnotation: (projectId, annotationId, body = {}) => call(
    "POST",
    `/ai-training/v2/annotations/${encodeURIComponent(annotationId || "")}/revoke`,
    { ...(body || {}), projectId },
  ),
  restoreAiTrainingAnnotation: (projectId, caseId, annotationId, body = {}) => call(
    "POST",
    `/ai-training/v2/cases/${encodeURIComponent(caseId || "")}/annotations`,
    { ...(body || {}), projectId, restoredFromAnnotationId: annotationId },
  ),
  getAiTrainingKnowledgeKeys: (projectId) => call("GET", `/ai-training/v2/knowledge-keys${projectId ? `?projectId=${encodeURIComponent(projectId)}` : ""}`),
  createAiTrainingKnowledgeValueDraft: (projectId, keyId, body = {}) => call(
    "POST",
    `/ai-training/v2/knowledge-keys/${encodeURIComponent(keyId || "")}/values`,
    { ...(body || {}), projectId, status: "draft" },
  ),
  approveAiTrainingKnowledgeValue: (projectId, valueId, body = {}) => call(
    "POST",
    `/ai-training/v2/knowledge-values/${encodeURIComponent(valueId || "")}/approve`,
    { ...(body || {}), projectId },
  ),
  activateAiTrainingKnowledgeValue: (projectId, valueId, body = {}) => call(
    "POST",
    `/ai-training/v2/knowledge-values/${encodeURIComponent(valueId || "")}/activate`,
    { ...(body || {}), projectId },
  ),
  rollbackAiTrainingKnowledgeValue: (projectId, valueId, body = {}) => call(
    "POST",
    `/ai-training/v2/knowledge-values/${encodeURIComponent(valueId || "")}/rollback`,
    { ...(body || {}), projectId },
  ),
  getAiTrainingKnowledgeValueImpact: (projectId, valueId) => call(
    "GET",
    `/ai-training/v2/knowledge-values/${encodeURIComponent(valueId || "")}/impact${projectId ? `?projectId=${encodeURIComponent(projectId)}` : ""}`,
  ),
  getAiTrainingMachineBindings: (projectId) => call("GET", `/ai-training/v2/machine-bindings${projectId ? `?projectId=${encodeURIComponent(projectId)}` : ""}`),
  upsertAiTrainingMachineBinding: (projectId, keyId, body = {}) => call(
    "PUT",
    `/ai-training/v2/machine-bindings/${encodeURIComponent(keyId || "")}`,
    { ...(body || {}), projectId, scope: "node" },
  ),
  listAiTrainingEvaluations: (projectId, limit = 20) => call(
    "GET",
    `/ai-training/v2/evaluations?projectId=${encodeURIComponent(projectId || "")}&limit=${encodeURIComponent(limit)}`,
  ),
  // 旧故事点训练 API 暂留兼容；新 AI训练页不再使用。
  getStoryPointTraining: (projectId) => call("GET", `/ai-training/story-point${projectId ? `?projectId=${encodeURIComponent(projectId)}` : ""}`),
  runStoryPointTrainingDryRun: (projectId, ticket) => call("POST", "/ai-training/story-point/dry-run", { projectId, ticket }),
  createStoryPointBuildLineage: (projectId, row) => call("POST", "/ai-training/story-point/build-lineage", { ...(row || {}), projectId }),
  updateStoryPointBuildLineage: (projectId, id, row) => call("PUT", `/ai-training/story-point/build-lineage/${encodeURIComponent(id)}`, { ...(row || {}), projectId }),
  createStoryPointGoldCase: (projectId, row) => call("POST", "/ai-training/story-point/gold-cases", { ...(row || {}), projectId }),
  updateStoryPointGoldCase: (projectId, id, row) => call("PUT", `/ai-training/story-point/gold-cases/${encodeURIComponent(id)}`, { ...(row || {}), projectId }),
  reviewStoryPointDryRun: (projectId, id, review) => call("POST", `/ai-training/story-point/dry-runs/${encodeURIComponent(id)}/review`, { ...(review || {}), projectId }),
  createStoryPointExecutionPlan: (projectId, id, mode = "PLAN_ONLY") => call("POST", `/ai-training/story-point/dry-runs/${encodeURIComponent(id)}/execution-plan`, { projectId, mode }),
  deleteStoryPointTrainingItem: (projectId, section, id) => call("DELETE", `/ai-training/story-point/${section}/${encodeURIComponent(id)}${projectId ? `?projectId=${encodeURIComponent(projectId)}` : ""}`),
  // 环境诊断 / 一键装环境 / 仓库权限 / 管理员联系 / AI 模型诊断
  envCheck: () => call("GET", "/env-check"),
  envInstall: (tool) => call("POST", "/env-install", { tool }),
  envAiModels: () => call("GET", "/env-ai-models"),
  envAiUpgrade: (engine) => call("POST", "/env-ai-upgrade", { engine }),
  repoAccess: (repo, refresh) => requestRepoAccessFromLocalGateway({
    gatewayUrl: getGatewayUrl(),
    browserOrigin: typeof window !== "undefined" ? window.location.origin : "",
    localGatewayUrl: DEFAULT_LOCAL_GATEWAY_URL,
    probeLocalGateway: probeGateway,
    requestRepoAccess: (baseUrl) => call(
      "GET",
      `/repo-access?repo=${encodeURIComponent(repo)}${refresh ? "&refresh=1" : ""}`,
      undefined,
      baseUrl,
    ),
  }),
  adminContacts: () => call("GET", "/admin-contacts"),
  getProjectLocal: (id) => call("GET", `/project-defs/${encodeURIComponent(id)}/local`),
  setTabLocalSource: (tabId, path, name) => call("POST", `/tabs/${tabId}/local-source`, { path, name }),
  getAppCategories: (refresh, projectId) => call("GET", `/app-categories?${refresh ? "refresh=1&" : ""}${projectId ? `projectId=${encodeURIComponent(projectId)}` : ""}`),
  // 关键词映射（标题/项目/迭代/标签/附件/评论 → 配置维度+值），按项目隔离
  getKeywordMappings: (projectId) => call("GET", `/keyword-mappings${projectId ? `?projectId=${encodeURIComponent(projectId)}` : ""}`),
  syncKeywordGroup: (group, projectId) => call("POST", "/keyword-mappings/sync", { group, projectId }),
  setKeywordMapping: (group, key, category, value, projectId, governance = {}) => call("PUT", "/keyword-mappings", {
    group, key, category, value, projectId, ...(governance || {}),
  }),
  deleteKeywordMapping: (group, key, projectId) => call("DELETE", `/keyword-mappings/${group}/${encodeURIComponent(key)}${projectId ? `?projectId=${encodeURIComponent(projectId)}` : ""}`),
  captureTitle: (title, projectId) => call("POST", "/keyword-mappings/capture-title", { title, projectId }),
  // TB 状态映射（逻辑状态→该项目 taskflow 真实状态名）
  getTaskflowStatuses: (projectId) => call("GET", `/taskflow-statuses${projectId ? `?projectId=${encodeURIComponent(projectId)}` : ""}`),
  getStatusMapping: (projectId) => call("GET", `/status-mapping${projectId ? `?projectId=${encodeURIComponent(projectId)}` : ""}`),
  setStatusMapping: (logical, realName, projectId) => call("PUT", "/status-mapping", { logical, realName, projectId }),
  // 分布式执行：服务端 AI 生成动作 + 本机执行（反思循环）
  agentRun: (tabId, task, opts) => call("POST", "/agent-run", { tabId, task, ...(opts || {}) }),

  // 远程仓库配置 + 车型源码映射（远程拉取模式）。projectId 可选（多项目隔离）
  getRemoteConfig: (projectId) => call("GET", `/remote-config${projectId ? `?projectId=${encodeURIComponent(projectId)}` : ""}`),
  initializeVehicleMap: (projectId) => call("POST", "/remote-config/initialize", { projectId }),
  syncVehicleSourceConfig: (projectId) => call("POST", "/vehicle-map/sync", { projectId }),
  previewVehicleInitialPresets: (projectId, subscriptions) => call(
    "POST",
    "/vehicle-map/initial-presets/preview",
    { projectId, subscriptions: Array.isArray(subscriptions) ? subscriptions : [] },
    undefined,
    { timeoutMs: 180000 },
  ),
  updateRemoteConfig: (patch, projectId) => call("PUT", "/remote-config", { ...(patch || {}), projectId }),
  exportVehicleSourceConfig: (projectId) => call("GET", `/vehicle-map/export${projectId ? `?projectId=${encodeURIComponent(projectId)}` : ""}`),
  importVehicleSourceConfig: (data, options = {}, projectId) => call("POST", "/vehicle-map/import", { data, projectId, ...(options || {}) }),
  setVehicleMap: (flavor, mapping, projectId) => call("PUT", "/vehicle-map", { flavor, mapping, projectId }),
  deleteVehicleMap: (flavor, projectId) => call("DELETE", `/vehicle-map/${encodeURIComponent(flavor)}${projectId ? `?projectId=${encodeURIComponent(projectId)}` : ""}`),
  saveVehicleConfigDraft: (draftId, body) => call("PUT", `/config-drafts/${encodeURIComponent(draftId)}`, body),
  previewVehicleConfigPublication: (body) => call("POST", "/config-publications/preview", body),
  publishVehicleConfig: (body) => call("POST", "/config-publications", body),
  getVehicleConfigPublication: (changeSetId) => call("GET", `/config-publications/${encodeURIComponent(changeSetId)}`),
  retryVehicleConfigPublication: (changeSetId) => call("POST", `/config-publications/${encodeURIComponent(changeSetId)}/retry`, {}),
  getVehicleConfigConflicts: () => call("GET", "/config-conflicts"),
  resolveVehicleConfigConflict: (conflictId, body) => call("POST", `/config-conflicts/${encodeURIComponent(conflictId)}/resolve`, body),
  listSyncBackups: () => call("GET", "/sync-backups"),
  createSyncBackup: (body) => call("POST", "/sync-backups", body || {}),
  runSyncAutoBackupNow: (body) => call("POST", "/sync-backups/auto/run", body || {}),
  maintainSyncBackups: (body) => call("POST", "/sync-backups/maintenance", body || {}),
  restoreSyncBackup: (id) => call("POST", `/sync-backups/${encodeURIComponent(id)}/restore`),
  updateSyncBackupSettings: (body) => call("PUT", "/sync-backups/settings", body || {}),
  remoteBranches: (repo, refresh) => call("GET", `/remote-branches?repo=${encodeURIComponent(repo)}${refresh ? "&refresh=1" : ""}`),
  // TB 项目列表（多项目）
  getTbProjects: () => call("GET", "/tb-projects"),

  // 工作/绩效总结报告
  generateSummary: (period, tabId, template, projectPath, since, until, sessionId, includeRichExports = false, options = {}) => call("POST", "/summary", {
    period, tabId, template, projectPath, since, until, sessionId, includeRichExports, ...(options || {}),
  }),
  previewSummaryAi: (model = "", tier = "") => call(
    "GET",
    `/summary/ai-preview?model=${encodeURIComponent(model || "")}&tier=${encodeURIComponent(tier || "")}`,
  ),
  analyzeSummaryTemplate,
  backupClaude: () => call("POST", "/summary/backup-claude"),

  listProjects: () => call("GET", "/projects"),
  saveProject: (p) => call("POST", "/projects", p),
  deleteProject: (id) => call("DELETE", `/projects/${id}`),
  getProjectApplications: () => call("GET", "/project-applications"),
  saveProjectApplications: (applications) => call("PUT", "/project-applications", { applications }),
  // 本机工程级 git 操作（不依赖故事点 tab，供本机工程列表 Tab 切换分支用）
  projectGitInfo: (path) => call("GET", `/projects/git-info?path=${encodeURIComponent(path || "")}`),
  projectGitCheckout: (path, branch, options = {}) => call("POST", "/projects/git/checkout", { path, branch, ...options }),
  projectGitFetch: (path) => call("POST", "/projects/git/fetch", { path }),

  listTabs: () => call("GET", "/tabs"),
  // 用户在初始化面板确认后先冻结服务端意图；真正创建只消费一次性 intent id。
  prepareStoryInitialization: (body) => call(
    "POST",
    "/story-initializations",
    body || {},
    undefined,
    { timeoutMs: STORY_INITIALIZATION_PREPARE_TIMEOUT_MS },
  ),
  createTab: (body) => call(
    "POST",
    "/tabs",
    body || {},
    undefined,
    { timeoutMs: STORY_INITIALIZATION_CREATE_TIMEOUT_MS },
  ),
  retryStoryWorkspaceInitialization: (id) => call(
    "POST",
    `/tabs/${encodeURIComponent(id)}/workspace-initialization/retry`,
    {},
  ),
  previewGitCommitStory: (body) => call("POST", "/git-commit-story/preview", body || {}),
  createGitCommitStory: (body) => call(
    "POST",
    "/git-commit-story",
    body || {},
    undefined,
    { timeoutMs: STORY_INITIALIZATION_CREATE_TIMEOUT_MS },
  ),
  resolveGitCommitStoryBatch: (body) => call("POST", "/git-commit-story/batch-resolve", body || {}),
  refreshGitCommitReviewLatest: (id) => call("POST", `/tabs/${id}/git-commit-review/refresh-latest`, { force: true }),
  startGitCommitReview: (id, extra = "") => call(
    "POST",
    `/tabs/${encodeURIComponent(id)}/git-commit-review/start`,
    String(extra || "").trim() ? { extra: String(extra).trim() } : {},
  ),
  storyArtifactUrl,
  issueStoryArtifactTickets: (id, items) => call(
    "POST",
    `/tabs/${encodeURIComponent(id)}/artifact-tickets`,
    { items: Array.isArray(items) ? items : [] },
  ),
  inspectWorktreeCleanup: (id) => call("GET", `/tabs/${id}/worktree/cleanup-inspection`),
  cleanupWorktree: (id, { token, force = false, confirmation = "" } = {}) => (
    call("POST", `/tabs/${id}/worktree/cleanup`, { token, force, confirmation })
  ),
  inspectWorktreeBranchPairs: (id) => call("GET", `/tabs/${id}/worktree/branch-pairs`),
  recreateWorktree: (id) => call("POST", `/tabs/${id}/worktree/recreate`, {}),
  reopenClosed: (id, force, reviewProof = null) => call("POST", "/tabs/reopen-closed", {
    id,
    force: !!force,
    ...(reviewProof?.projectId ? { projectId: reviewProof.projectId } : {}),
    ...(reviewProof?.configInferenceRunId
      ? { configInferenceRunId: reviewProof.configInferenceRunId }
      : {}),
  }),
  getCopySources: () => call("GET", "/tabs/copy-sources"),
  previewClosedStoryPurge: (id) => call("GET", `/closed-tabs/${encodeURIComponent(id)}/purge-preview`),
  purgeClosedStory: (id, options) => call("POST", `/closed-tabs/${encodeURIComponent(id)}/purge`, options || {}),
  renameTab: (id, title) => call("PUT", `/tabs/${id}`, { title }),
  setCenter: (id, center) => call("PUT", `/tabs/${id}`, center || { centerHost: "" }),
  deleteTab: (id) => call("DELETE", `/tabs/${id}`),
  deleteGroup: (groupId) => call("DELETE", `/groups/${encodeURIComponent(groupId)}`),
  // OneTab 风格收起：单 tab 切换隐藏态（AI/会话/工程占用保留，仅从 tab 栏移出）；hideAll 一键收起所有未隐藏的。
  // hideBatch 可选：{ id, at }，同一次收起操作内多个 tab 共享同一批次，用于隐藏面板按批次分组/整组还原。
  setTabHidden: (id, hidden, hideBatch) => call("PUT", `/tabs/${encodeURIComponent(id)}/hidden`, {
    hidden: !!hidden,
    ...(hideBatch && typeof hideBatch === "object" ? { hideBatch } : {}),
  }),
  hideAllTabs: (hideBatch) => call("POST", `/tabs/hide-all`, hideBatch ? { hideBatch } : {}),

  // AI 引擎：每个故事点独立选择（claude/gemini/codex/hermes）。引擎可用性走全局 /api/config/engine-status
  setEngine: (id, engine) => call("POST", `/tabs/${id}/engine`, { engine }),
  // 故事点级模型/档位覆盖（不改 ~/.codex 等全局配置；空字符串=清除覆盖）
  setEnginePrefs: (id, body) => call("POST", `/tabs/${id}/engine-prefs`, body || {}),
  // 只读模型/档位配置，不调用 AI；按故事点主工程解析工程级覆盖。
  getEngineMetadata: (id) => call("GET", `/tabs/${id}/engine-metadata`),
  // 复制一份工程到指定目录（"工程被占用"冲突弹窗里"复制一份"用）。tab 级：复制期间 tab.copying 锁定，进度走 WS devbench_copy_progress
  copyProject: (id, body) => call("POST", `/tabs/${id}/copy-project`, body || {}),
  // 文件夹浏览（选目标父目录）。path 空=盘符/根
  fsBrowse: (path) => call("GET", `/fs/browse?path=${encodeURIComponent(path || "")}`),
  getEngineStatus: async () => {
    try {
      const r = await fetch(getApiUrl("/api/config/engine-status"));
      const j = await r.json();
      const data = j.success && j.data && typeof j.data === "object" ? j.data : null;
      if (data) writeEngineStatusCache(data);
      return data;
    } catch { return null; }
  },

  setPrimary: (id, projectId, extra = {}) => call("POST", `/tabs/${id}/primary`, { projectId, ...(extra || {}) }),
  // 工程配置"复制 → 一键应用"（同一工程串行解不同工单；不含标题/任务/附件）
  getConfigSnapshot: (id) => call("GET", `/tabs/${id}/config-snapshot`),
  applyConfig: (id, snapshot) => call("POST", `/tabs/${id}/apply-config`, { snapshot }),
  // 旧入口别名；后端已统一委托给配置推断 run，供兼容调用方使用。
  suggestConfig: (body) => call("POST", "/suggest-config", body || {}),
  // 故事点组/队列（共用工程配置、串行解不同 TB 单）
  getGroup: (id) => call("GET", `/tabs/${id}/group`),
  groupJoin: (id, anchorTabId) => call("POST", `/tabs/${id}/group/join`, { anchorTabId }),
  groupSetActive: (id) => call("POST", `/tabs/${id}/group/active`),
  groupLeave: (id) => call("POST", `/tabs/${id}/group/leave`),
  groupRename: (id, name) => call("POST", `/tabs/${id}/group/rename`, { name }),
  // 远程拉取模式：设置模式+配置 / 开始初始化(并发克隆)
  setTabMode: (id, mode, remotePull) => call("PUT", `/tabs/${id}/mode`, { mode, remotePull }),
  remoteInit: (id) => call("POST", `/tabs/${id}/remote/init`),
  setTicket: (id, url, extra = {}) => call("POST", `/tabs/${id}/ticket`, { url, ...(extra || {}) }),
  // 把当前关联的 TB 单加入任务列表（待办）
  addTicketToTasks: (id, info) => call("POST", `/tabs/${id}/ticket/add-to-tasks`, info || {}),
  // 关联 TB 单的附件：列出 + 下载到外部 StoryDev/<slug>/archives/
  listTbAttachments: (id) => call("GET", `/tabs/${id}/tb-attachments`),
  // 单附件下载（流式 + 提前响应，进度走 WS devbench_attach_progress）。
  // attachmentKey 与服务端约定一致，来自 tbAttachmentDownloadKey；弹窗关闭不影响下载继续。
  downloadTbAttachment: (id, att, attachmentKey) => call("POST", `/tabs/${id}/tb-attachments/download`, {
    url: att.url, name: att.name, attachmentKey,
  }),
  // 主动停止单附件下载（幂等；未知/已结束返回 ok:true, stopped:false）。
  stopTbAttachment: (id, attachmentKey) => call("POST", `/tabs/${id}/tb-attachments/stop`, { attachmentKey }),
  // 批量下载（弹窗确认后调用；items 省略=下载全部未下载的）。进度走 WS devbench_attach_progress
  downloadTbAttachmentsBatch: (id, items) => call("POST", `/tabs/${id}/tb-attachments/download-batch`, items ? { items } : {}),
  // 关联 TB 单的备注（富文本图文）：预览 + 下载到外部 StoryDev/<slug>/archives/note.md
  getTbNote: (id) => call("GET", `/tabs/${id}/tb-note`),
  downloadTbNote: (id) => call("POST", `/tabs/${id}/tb-note/download`),
  addExtra: (id, path, name) => call("POST", `/tabs/${id}/extra`, { path, name }),
  removeExtra: (id, path) => call("DELETE", `/tabs/${id}/extra`, { path }),
  swapPrimary: (id, extraPath, extra = {}) => call("POST", `/tabs/${id}/swap-primary`, { extraPath, ...(extra || {}) }),
  // 工作流：点「执行开发」触发(TB 待处理→待确认；全自动模式才自动甄别) / 确认拒绝(待确认→已拒绝)
  workflowStartDev: (id) => call("POST", `/tabs/${id}/workflow/start-dev`),
  workflowContinueGroup: (id, runId) => call("POST", `/tabs/${id}/workflow/group-continue`, { runId }),
  workflowReject: (id) => call("POST", `/tabs/${id}/workflow/reject`),
  // 工作流：半自动手动触发「开始 AI 甄别」 / 切换自动化档位（semi 半自动 | full 全自动）
  // opts: { extra?, skipAttachConfirm? } — skipAttachConfirm 表示用户已确认/跳过超阈值附件弹窗
  workflowTriage: (id, opts = {}) => {
    const body = typeof opts === "string" ? { extra: opts } : { ...(opts || {}) };
    if (!body.extra && !body.skipAttachConfirm) return call("POST", `/tabs/${id}/workflow/triage`, {});
    return call("POST", `/tabs/${id}/workflow/triage`, body);
  },
  // 工作流：手动「标记修复完成」（兜底触发 可提测 流转）
  workflowMarkFixed: (id) => call("POST", `/tabs/${id}/workflow/mark-fixed`),
  workflowAutoMode: (id, mode) => call("POST", `/tabs/${id}/workflow/auto-mode`, { mode }),
  // 手动切换到任一合法工作流阶段；后端负责校验 phase 并清理与目标阶段不兼容的瞬时状态。
  workflowSetPhase: (id, phase) => call("POST", `/tabs/${id}/workflow/phase`, { phase }),
  workflowReportMode: (id, mode) => call("POST", `/tabs/${id}/workflow/report-mode`, { mode }),
  workflowSkipTestAcceptance: (id, skipped) => call("POST", `/tabs/${id}/workflow/skip-test-acceptance`, { skipped }),
  // 工作流第三步：开始自我验收（需绑定设备）/ 生成报告并提交
  workflowVerify: (id, extra) => call("POST", `/tabs/${id}/workflow/verify`, extra ? { extra } : {}),
  workflowReport: (id, extra) => call("POST", `/tabs/${id}/workflow/report`, extra ? { extra } : {}),
  // 工作流：完成后把经验导出到工程 docs/wiki / 写入工程 CLAUDE.md 已知问题段
  workflowWiki: (id) => call("POST", `/tabs/${id}/workflow/wiki`),
  workflowClaudeMd: (id) => call("POST", `/tabs/${id}/workflow/claudemd`),
  // AIWiki 一键同步：把内网 AIWiki 应用市场词条同步到工程 docs/wiki/
  aiwikiSearch: (q) => call("GET", `/aiwiki/search?q=${encodeURIComponent(q || "应用市场")}`),
  aiwikiSync: (body) => call("POST", "/aiwiki/sync", body || {}),

  getMessages: (id) => call("GET", `/tabs/${id}/messages`),
  getConversation: (id) => call("GET", `/tabs/${id}/conversation`),
  // 全量存档时把页面当前可见的流式回答一并提交，避免服务端草稿节流窗口漏掉刚显示的片段。
  // 仅发送存档需要的字段，避免把可能很长的思考流/实时命令输出重复塞进请求体。
  exportArchive: (id, live = null) => {
    const snapshot = archiveLiveSnapshot(live);
    return call("POST", `/tabs/${id}/archive`, snapshot ? { live: snapshot } : {});
  },
  getArchiveDir: (id) => call("GET", `/tabs/${id}/archive-dir`),
  setArchiveDir: (id, archiveDir) => call("PUT", `/tabs/${id}/archive-dir`, { archiveDir }),
  listArchiveFiles: (id, dir) => call("GET", `/tabs/${id}/archive-files${dir ? `?dir=${encodeURIComponent(dir)}` : ""}`),
  restoreArchive: (id, filePath, mode = "replace") => call("POST", `/tabs/${id}/archive-restore`, { filePath, mode }),
  createConversationBackup: (id, directory, live = null) => {
    const snapshot = archiveLiveSnapshot(live);
    return call("POST", `/tabs/${id}/conversation-backup`, {
      ...(directory ? { directory } : {}),
      ...(snapshot ? { live: snapshot } : {}),
    });
  },
  listConversationBackups: (id, dir) => call("GET", `/tabs/${id}/conversation-backup-files${dir ? `?dir=${encodeURIComponent(dir)}` : ""}`),
  restoreConversationBackup: (id, filePath, recoveryDirectory = "") => call("POST", `/tabs/${id}/conversation-backup-restore`, { filePath, recoveryDirectory }),
  // 一键备份：导出 .devbench-story.zip（含对话/消息/资料文件，绝对路径已剥离），返回 Blob 供前端下载。
  storyBackup: async (id) => {
    const url = getApiUrl(`/api/devbench/tabs/${encodeURIComponent(id)}/story-backup`);
    const headers = {};
    const token = getAdminToken();
    if (token) headers.Authorization = `Bearer ${token}`;
    try {
      const response = await authenticatedFetch(url, { method: "GET", headers });
      if (!response.ok) {
        let err;
        try { err = await response.json(); } catch { err = { error: `HTTP ${response.status}` }; }
        return { ok: false, error: err?.error || `HTTP ${response.status}` };
      }
      const blob = await response.blob();
      const cd = response.headers.get("content-disposition") || "";
      let fileName = "story-backup.devbench-story.zip";
      const m = /filename\*?=(?:UTF8'')?"?([^";]+)"?/i.exec(cd);
      if (m?.[1]) fileName = decodeURIComponent(m[1]);
      return { ok: true, blob, fileName };
    } catch (error) {
      return { ok: false, code: "NETWORK_ERROR", error: `备份下载失败：${error?.message || "无法连接 Gateway"}` };
    }
  },
  // 一键还原·第一步：解析备份 zip，返回初始化配置快照（不创建 tab）。
  parseStoryBackup: async (file) => {
    if (!file) return { ok: false, error: "请选择备份文件" };
    const url = getApiUrl(`/api/devbench/story-backup/parse`);
    const headers = { "Content-Type": "application/octet-stream" };
    const token = getAdminToken();
    if (token) headers.Authorization = `Bearer ${token}`;
    try {
      const response = await authenticatedFetch(url, { method: "POST", headers, body: file });
      let data;
      try { data = await response.json(); } catch { data = { ok: false, error: `HTTP ${response.status}` }; }
      if (!response.ok) { data.ok = false; if (!data.error) data.error = `HTTP ${response.status}`; }
      return data;
    } catch (error) {
      return { ok: false, code: "NETWORK_ERROR", error: `解析备份失败：${error?.message || "无法连接 Gateway"}` };
    }
  },
  // 一键还原·第二步：把备份内容（对话/消息/资料文件）应用到已存在的 tab（初始化面板创建后调用）。
  applyStoryBackup: async (tabId, file) => {
    if (!file) return { ok: false, error: "请选择备份文件" };
    if (!tabId) return { ok: false, error: "缺少目标故事点 ID" };
    const url = getApiUrl(`/api/devbench/tabs/${encodeURIComponent(tabId)}/apply-story-backup`);
    const headers = { "Content-Type": "application/octet-stream" };
    const token = getAdminToken();
    if (token) headers.Authorization = `Bearer ${token}`;
    try {
      const response = await authenticatedFetch(url, { method: "POST", headers, body: file });
      let data;
      try { data = await response.json(); } catch { data = { ok: false, error: `HTTP ${response.status}` }; }
      if (!response.ok) { data.ok = false; if (!data.error) data.error = `HTTP ${response.status}`; }
      return data;
    } catch (error) {
      return { ok: false, code: "NETWORK_ERROR", error: `还原备份失败：${error?.message || "无法连接 Gateway"}` };
    }
  },
  // 一键还原·补充：worktree 就绪后把聊天记录中的旧分支名/旧目录替换为目标故事点当前值。
  applyBackupRefRemap: (id) => call("POST", `/tabs/${encodeURIComponent(id)}/apply-backup-ref-remap`, {}),
  getBranches: (id) => call("GET", `/tabs/${id}/branches`),
  // git 分支切换 + stash 管理
  gitRepos: (id) => call("GET", `/tabs/${id}/git/repos`),
  gitCheckout: (id, path, branch) => call("POST", `/tabs/${id}/git/checkout`, { path, branch }),
  gitFetch: (id, path) => call("POST", `/tabs/${id}/git/fetch`, path ? { path } : {}),
  // Amend 本地改动到新分支（rule_1）：分支尾号+1 → amend 全部改动 → push 新分支
  gitAmendNewBranch: (id, path) => call("POST", `/tabs/${id}/git/amend-new-branch`, { path }),
  // Git 提交整理（prompt_ask）：把当前已推送分支重整为基于 MR target 的单 commit 新分支并 push（临时 worktree 中 squash）
  gitCommitReorganize: (id, body) => call("POST", `/tabs/${id}/git/commit-reorganize`, body || {}),
  // Git 提交整理：冲突解决后恢复流程（用户在保留的临时 worktree 中解决冲突后调用）
  gitCommitReorganizeResume: (id, body) => call("POST", `/tabs/${id}/git/commit-reorganize/resume`, body || {}),
  // Git 提交整理：放弃重整（清理临时 worktree + 恢复 stash）
  gitCommitReorganizeAbort: (id, body) => call("POST", `/tabs/${id}/git/commit-reorganize/abort`, body || {}),
  // 删除旧远程分支（Amend / 提交整理成功后用户确认删除；newBranch=授权基线分支，提交整理后当前检出可能不在尾号链上时必传）
  // expectedOldRemoteSha / expectedNewRemoteSha: 删除前 SHA 校验（防止删除其他人的提交）
  gitDeleteRemoteBranch: (id, path, branch, newBranch = "", opts = {}) => call("POST", `/tabs/${id}/git/delete-remote-branch`, {
    path, branch,
    ...(newBranch ? { newBranch } : {}),
    ...(opts.expectedOldRemoteSha ? { expectedOldRemoteSha: opts.expectedOldRemoteSha } : {}),
    ...(opts.expectedNewRemoteSha ? { expectedNewRemoteSha: opts.expectedNewRemoteSha } : {}),
  }),
  // 工作流第一步前：拉取远程最新（保护已跟踪改动，未跟踪文件原地保留）；冲突时返回 hasConflict + 每工程冲突文件
  gitPullLatest: (id) => call("POST", `/tabs/${id}/git/pull-latest`),
  // Android Studio「Update Project」风格：拉取远程最新，进度走 WS devbench_git_update
  gitUpdate: (id, selection = {}) => call("POST", `/tabs/${id}/git/update`, selection || {}),
  // 标记当前版本：提交 flavorConfig.json + 打 tag <flavor>_<版本>（WebApp 也打 tag）。force=覆盖已存在 tag
  gitMarkVersion: (id, force) => call("POST", `/tabs/${id}/git/mark-version`, force ? { force: true } : {}),
  // Git Push 预检（AS 风格 push 对话框）：各工程 分支/上游/领先·落后/待推 tag。fetch=false 跳过联网
  gitPushPreview: (id, fetch = true) => call("POST", `/tabs/${id}/git/push-preview`, fetch ? {} : { fetch: false }),
  // Git Push：推主工程+WebApp 当前分支（pushTags 连 tags、force 用 --force-with-lease）。返回 rejected 时需先拉取/强推
  gitPush: (id, { pushTags = false, force = false, paths } = {}) => call("POST", `/tabs/${id}/git/push`, { pushTags, force, ...(paths ? { paths } : {}) }),
  // 提 PR 预检：只读列出全部工程、来源/目标分支、已有提交和本地待提交改动。
  gitPullRequestPreview: (id) => call("POST", `/tabs/${id}/git/pull-request/preview`, {}),
  // 提 PR：只执行预检中有可提内容的工程；后端会再次复检并跳过空分支。
  gitCreatePullRequest: (id, body = {}) => call("POST", `/tabs/${id}/git/pull-request`, body || {}),
  // 让 AI 解决某工程的合并冲突（仅解决+git add，不提交，交人工审核）
  gitResolveConflicts: (id, path) => call("POST", `/tabs/${id}/git/resolve-conflicts`, path ? { path } : {}),
  gitStashes: (id, path) => call("GET", `/tabs/${id}/git/stashes?path=${encodeURIComponent(path)}`),
  gitStashApply: (id, path, index, pop) => call("POST", `/tabs/${id}/git/stash/apply`, { path, index, pop }),
  gitStashDrop: (id, path, index) => call("POST", `/tabs/${id}/git/stash/drop`, { path, index }),
  // 提交到主工程：把故事分支提交 rebase 到各工程「原始分支」并快进（仅本地，不 push）
  rebaseToOriginal: (id, body) => call("POST", `/tabs/${id}/git/rebase-original`, body || {}),
  // 提交到主工程预检（只读）：从故事分支 rebase 到原始分支的情况 + 是否有可 rebase 提交
  rebasePreview: (id) => call("POST", `/tabs/${id}/git/rebase-preview`, {}),
  getFlavors: (id) => call("GET", `/tabs/${id}/flavors`),
  setFlavor: (id, path, flavor, extra = {}) => call("POST", `/tabs/${id}/flavor`, { path, flavor, ...(extra || {}) }),
  bumpVersion: (id, path, op = "bump10") => call("POST", `/tabs/${id}/flavor-version/bump`, { path, op }),
  // 编译产物：jobs=[{ path, flavors:[], buildTypes:["debug"|"release"] }]，立即返回 buildId，日志走 WS devbench_build
  buildProjects: (id, jobs) => call("POST", `/tabs/${id}/build`, { jobs }),
  buildStop: (id, buildId) => call("POST", `/tabs/${id}/build/stop`, buildId ? { buildId } : {}),
  gitLocalChanges: (id) => call("GET", `/tabs/${id}/git/local-changes`),
  send: (id, content, draft = null) => {
    const messageInput = draft?.input && typeof draft.input === "object"
      ? { ...draft.input, ...(draft.clientMessageId ? { clientMessageId: draft.clientMessageId } : {}) }
      : draft;
    const displayContent = draft?.displayContent ?? messageInput?.text;
    return call("POST", `/tabs/${id}/send`, {
      content,
      ...(displayContent != null ? { displayContent } : {}),
      ...(messageInput && typeof messageInput === "object" ? { messageInput } : {}),
    });
  },
  editAndResendConversation: (id, messageId, content, expectedRevision) => call("POST", `/tabs/${id}/conversation/edit-and-resend`, {
    messageId,
    content,
    expectedRevision,
    acknowledgeExternalStateNotReverted: true,
  }),
  selectConversationHead: (id, messageId, expectedRevision) => call("PUT", `/tabs/${id}/conversation/head`, { messageId, expectedRevision }),
  retryBlockedQueueHead: (id, requestId) => call(
    "POST",
    `/tabs/${encodeURIComponent(id)}/queue/${encodeURIComponent(requestId)}/retry`,
    {},
  ),
  cancelBlockedQueueHead: (id, requestId) => call(
    "DELETE",
    `/tabs/${encodeURIComponent(id)}/queue/${encodeURIComponent(requestId)}`,
  ),
  stop: (id) => call("POST", `/tabs/${id}/stop`),
  openArtifact: (id, artifactPath) => call("POST", `/tabs/${id}/artifacts/open`, { path: artifactPath }),
  revealStoryArtifact: (id, ref) => call("POST", `/tabs/${id}/artifacts/reveal`, { ref }),
  importClipboardAttachments: (id) => call("POST", `/tabs/${id}/attachments/import-clipboard`, {}),

  openDir: (path) => call("POST", "/open-dir", { path }),
  openInStudio: (path, studioPath, forceStudioPath = false) => call("POST", "/open-in-studio", studioPath ? { path, studioPath, forceStudioPath } : { path }),
  listAndroidStudios: () => call("GET", "/android-studios"),
  // 把一个 HTML deck 一键导出为 PDF + PPTX（满幅图片型）
  exportDeck: (body) => call("POST", "/export-deck", body),

  fsList: (id, p) => call("GET", `/tabs/${id}/fs/list?path=${encodeURIComponent(p)}`),
  fsCopy: (id, src, destDir) => call("POST", `/tabs/${id}/fs/copy`, { src, destDir }),

  listDevices: () => call("GET", "/devices"),

  // 设备模拟（wm size / density 预设）
  listMockDevices: () => call("GET", "/mock-devices"),
  addMockDevice: (body) => call("POST", "/mock-devices", body || {}),
  deleteMockDevice: (mockId) => call("DELETE", `/mock-devices/${mockId}`),
  applyMockDevice: (id, body) => call("POST", `/tabs/${id}/mock-devices/apply`, body || {}),
  resetMockDevice: (id) => call("POST", `/tabs/${id}/mock-devices/reset`),
  rebootMockDevice: (id) => call("POST", `/tabs/${id}/mock-devices/reboot`),

  bindDevice: (id, serial) => call("POST", `/tabs/${id}/device`, { serial }),
  releaseDevice: (id) => call("DELETE", `/tabs/${id}/device`),
  scrcpy: (id, displayId) => call("POST", `/tabs/${id}/scrcpy`, displayId != null ? { displayId } : {}),
  listDisplays: (id) => call("GET", `/tabs/${id}/displays`),
  openApk: (id) => call("POST", `/tabs/${id}/open-apk`),
  apkStatus: (id) => call("GET", `/tabs/${id}/apk-status`),
  setApkSource: (id, path) => call("POST", `/tabs/${id}/apk-source`, { path }),
  publishProd: (id, projectId) => call("POST", `/tabs/${id}/publish-prod`, { projectId }),
  openProdDir: (id, projectId) => call("POST", `/tabs/${id}/open-prod-dir`, { projectId }),
  publishShareLogin: (id, payload) => call("POST", `/tabs/${id}/publish-prod/share-login`, payload || {}),
  uploadResignedApk: async (id, resignId, file) => {
    const name = file.webkitRelativePath || file.name || "signed.apk";
    const url = getApiUrl(`/api/devbench/tabs/${id}/publish-prod/resign-apk?resignId=${encodeURIComponent(resignId)}&filename=${encodeURIComponent(name)}`);
    return binaryWrite(url, file, {
      networkErrorPrefix: "二签 APK 上传失败",
    });
  },
  confirmDingtalk: (id, confirmId, message) => call("POST", `/tabs/${id}/publish-prod/confirm-dingtalk`, { confirmId, message }),
  getDingtalkMsgConfig: () => call("GET", `/dingtalk-msg-config`),
  setDingtalkMsgConfig: (config) => call("PUT", `/dingtalk-msg-config`, { config }),

  // 拖拽上传文件（二进制 raw），保存到 cloneParent/AllDocs/StoryDev/<故事点>/archives/。
  // relPath 可含子目录（如 "我的日志/sub/a.log"），用于保留拖入文件夹的层级结构。
  uploadFile: async (id, file, relPath, options = {}) => {
    const name = relPath || file.name;
    const url = getApiUrl(`/api/devbench/tabs/${id}/upload?filename=${encodeURIComponent(name)}`);
    const timeoutMs = Number(options.timeoutMs) > 0
      ? Number(options.timeoutMs)
      : STORY_ATTACHMENT_UPLOAD_TIMEOUT_MS;
    return binaryWrite(url, file, {
      timeoutMs,
      timeoutCode: "ATTACHMENT_UPLOAD_TIMEOUT",
      timeoutMessage: `附件“${file.name || name}”上传超过 ${Math.ceil(timeoutMs / 1000)} 秒，已停止等待；请检查网络后重试。`,
      networkErrorPrefix: "附件上传失败",
    });
  },

  // 把拖入的文件夹注册为故事点的"会话材料"（持久上下文，每轮都会提醒 AI）
  addMaterial: (id, material) => call("POST", `/tabs/${id}/material`, material),
  removeMaterial: (id, relPath) => call("DELETE", `/tabs/${id}/material`, { relPath }),
};
