import { createHash } from "crypto";
import { createWriteStream } from "fs";
import { mkdir, rename, rm, writeFile } from "fs/promises";
import { extname, join } from "path";
import { Readable, Transform } from "stream";
import { pipeline } from "stream/promises";
import { fileURLToPath } from "url";
import {
  DEFAULT_FEISHU_EXTRACTOR_CONFIG,
  FeishuProjectExtractor,
  FeishuProjectRateLimiter,
  normalizeFeishuFieldMetadata,
} from "./feishu-extractor.js";
import {
  defaultFeishuProjectMcpConfig,
  refreshFeishuProjectMcpAttachmentDownload,
} from "./feishu-mcp-client.js";
import { defaultFeishuProjectWebConfig } from "./feishu-web-session.js";
import { feishuFilterPresetConfigPatch } from "./feishu-filter-preset.js";
import {
  DEFAULT_FEISHU_PRIORITY_MAPPING,
  DEFAULT_SYNC_ROUTING,
  LEGACY_TEAMBITION_DEFAULTS,
  applyResolvedSyncPolicy,
  applySyncPayloadStrategy,
  normalizeSyncPolicyConfig,
  publicDecision,
  resolveSyncPolicy,
  validateSyncPolicyConfig,
} from "./sync-policy-engine.js";
import { getConfig } from "../../../gateway/services/config.js";
import { log } from "../../../gateway/services/logger.js";
import {
  createTeambitionTask,
  updateTeambitionTask,
  updateTeambitionTaskCustomFields,
  updateTeambitionTaskTags,
  postTaskComment,
  uploadTaskAttachment,
  getTaskDetail,
  getTaskNote,
  getTaskComments,
  getTeambitionTaskExistence,
  mergeTaskDetail,
  deleteTeambitionTask,
  createTeambitionTaskSearchSession,
  listProjectTasklists,
  listProjectSprints,
  getProjectTasklist,
  getProjectSprint,
  listProjectMembers,
  listProjectTags,
  listTeambitionTaskCustomFieldDefs,
} from "../../../gateway/services/teambition.js";
import {
  getFeishuProjectSyncState,
  upsertFeishuProjectSyncState,
  listFeishuProjectSyncStates,
  listFeishuProjectSyncStatesSince,
  insertFeishuProjectRawPayload,
  upsertFeishuProjectSyncError,
  resolveFeishuProjectSyncErrors,
  listFeishuProjectRawPayloads,
  getLatestFeishuProjectRawPayload,
  listFeishuProjectSyncErrors as listFeishuProjectSyncErrorRows,
  listFeishuProjectCommentSync as listFeishuProjectCommentSyncRows,
  listFeishuProjectAttachmentSync as listFeishuProjectAttachmentSyncRows,
  listFeishuProjectRetryableSyncErrors,
  getFeishuProjectCommentSync,
  upsertFeishuProjectCommentSync,
  getFeishuProjectAttachmentSync,
  upsertFeishuProjectAttachmentSync,
  repointFeishuProjectSyncTarget,
  resetFeishuProjectSyncTarget,
  upsertFeishuProjectSyncSourceRecord,
  deleteFeishuProjectSyncRecords,
} from "../../../gateway/db/sqlite.js";

export const SOURCE_SYSTEM = "feishu_project";
export const TARGET_SYSTEM = "teambition";
export const DEFAULT_TB_TITLE_TEMPLATE = LEGACY_TEAMBITION_DEFAULTS.titleTemplate;
export const DEFAULT_FEISHU_SOURCE_VIEW_URL = "https://project.feishu.cn/intelligentspace/workObjectView/bug/2OuLlBcDg?scope=workspaces&node=28602134";
export const MAX_FEISHU_SOURCE_VIEWS = 20;
export const DEFAULT_TB_TARGET_PROJECT_ID = LEGACY_TEAMBITION_DEFAULTS.projectId;
export const DEFAULT_TB_TARGET_TASKLIST_ID = LEGACY_TEAMBITION_DEFAULTS.tasklistId;
export const DEFAULT_TB_TARGET_TASKLIST_NAME = LEGACY_TEAMBITION_DEFAULTS.tasklistName;
export const DEFAULT_TB_TARGET_PROJECT_PATH_NAME = LEGACY_TEAMBITION_DEFAULTS.projectPathName;
export const DEFAULT_TB_TARGET_SPRINT_ID = LEGACY_TEAMBITION_DEFAULTS.sprintId;
export const DEFAULT_TB_TARGET_SPRINT_NAME = LEGACY_TEAMBITION_DEFAULTS.sprintName;
export const DEFAULT_TB_TARGET_SPRINT_URL = LEGACY_TEAMBITION_DEFAULTS.sprintUrl;
export const DEFAULT_TB_APPLICATION_CATEGORY_VALUE = LEGACY_TEAMBITION_DEFAULTS.applicationCategoryValue;
export const DEFAULT_TB_DEFECT_CATEGORY_VALUE = LEGACY_TEAMBITION_DEFAULTS.defectCategoryValue;
export const DEFAULT_TB_TARGET_SCENARIO_FIELD_CONFIG_ID = LEGACY_TEAMBITION_DEFAULTS.scenariofieldconfigId;
export const DEFAULT_TB_TARGET_TASK_TYPE_NAME = LEGACY_TEAMBITION_DEFAULTS.taskTypeName;
export const DEFAULT_TB_EXECUTOR_ID = LEGACY_TEAMBITION_DEFAULTS.defaultExecutorId;
export const DEFAULT_TB_EXECUTOR_NAME = LEGACY_TEAMBITION_DEFAULTS.defaultExecutorName;
export const DEFAULT_FEISHU_OWNER_ROLE_FILTER_VALUES = ["阳荣峰", "徐博超", "彭俊维", "冯国梁"];
export const DEFAULT_FEISHU_OWNER_ROLE_FILTER = {
  id: "problem-owner-role",
  enabled: true,
  kind: "role",
  fieldKey: "role_bd6222",
  fieldName: "问题责任人（角色）",
  operator: "containsAny",
  operatorLabel: "存在选项属于",
  values: DEFAULT_FEISHU_OWNER_ROLE_FILTER_VALUES,
};
const ATTACHMENT_DOWNLOAD_ROOT = fileURLToPath(new URL("../../../docs/tempFiles/feishu_project_attachments/", import.meta.url));
const LEGACY_TB_TITLE_TEMPLATES = new Set([
  "\u3010\u8f6c\u8f7d\u3011\u3010{sourceWorkItemNo}\u3011{title}",
  "\u3010\u963f\u7ef4\u5854\u3011\u3010\u8f6c\u8f7d\u3011\u3010{sourceWorkItemNo}\u3011{title}",
  "\u3010\u963f\u7ef4\u5854\u3011\u3010\u8f6c\u8f7d\u3011\u3010{sourceWorkItemNo}\u3011{problemSummary}",
]);

export { FeishuProjectExtractor, FeishuProjectRateLimiter } from "./feishu-extractor.js";

export const DEFAULT_FEISHU_PROJECT_SYNC_CONFIG = {
  enabled: false,
  routing: DEFAULT_SYNC_ROUTING,
  feishu: {
    ...DEFAULT_FEISHU_EXTRACTOR_CONFIG,
    authMode: "plugin",
    sourceView: {
      url: DEFAULT_FEISHU_SOURCE_VIEW_URL,
      viewId: "2OuLlBcDg",
      scope: "workspaces",
      node: "28602134",
    },
    web: defaultFeishuProjectWebConfig(),
    mcp: defaultFeishuProjectMcpConfig(),
  },
  teambition: {
    projectId: DEFAULT_TB_TARGET_PROJECT_ID,
    tasklistId: DEFAULT_TB_TARGET_TASKLIST_ID,
    tasklistName: DEFAULT_TB_TARGET_TASKLIST_NAME,
    stageId: "",
    sprintId: DEFAULT_TB_TARGET_SPRINT_ID,
    sprintName: DEFAULT_TB_TARGET_SPRINT_NAME,
    sprintUrl: DEFAULT_TB_TARGET_SPRINT_URL,
    taskflowstatusId: "",
    scenariofieldconfigId: DEFAULT_TB_TARGET_SCENARIO_FIELD_CONFIG_ID,
    defaultExecutorId: DEFAULT_TB_EXECUTOR_ID,
    defaultExecutorName: DEFAULT_TB_EXECUTOR_NAME,
    requiredInvolveMembers: [],
    titleTemplate: DEFAULT_TB_TITLE_TEMPLATE,
    tagIds: [],
    sourceIdCustomFieldId: "",
    sourceUrlCustomFieldId: "",
    statusCustomFieldId: "",
    priorityCustomFieldId: "",
    severityCustomFieldId: "",
    versionCustomFieldId: "",
    reproductionProbabilityCustomFieldId: "",
    commentsSummaryCustomFieldId: "",
    attachmentsSummaryCustomFieldId: "",
    childItemsSummaryCustomFieldId: "",
    relatedItemsSummaryCustomFieldId: "",
    createTaskPath: "/api/v3/task/create",
    updateTaskPath: "/api/v3/task/update",
    customFieldsPathTemplate: "/api/v3/task/{taskId}/customfields",
    commentPathTemplate: "/api/v3/task/{taskId}/comment",
    taskUrlTemplate: "https://www.teambition.com/task/{targetTaskId}",
    writeCustomFieldsAfterCreate: false,
    defaultDurationDays: 3,
    taskTypeName: DEFAULT_TB_TARGET_TASK_TYPE_NAME,
    projectPathName: DEFAULT_TB_TARGET_PROJECT_PATH_NAME,
    applicationCategoryCustomFieldId: "",
    applicationCategoryValue: DEFAULT_TB_APPLICATION_CATEGORY_VALUE,
    defectCategoryCustomFieldId: "",
    defectCategoryValue: DEFAULT_TB_DEFECT_CATEGORY_VALUE,
    tagNames: LEGACY_TEAMBITION_DEFAULTS.tagNames,
  },
  mappings: {
    people: {},
    priority: DEFAULT_FEISHU_PRIORITY_MAPPING,
    status: {},
    severity: {},
    customFields: {},
    fields: {},
    keywordRules: [],
  },
  sync: {
    batchSize: 50,
    includeComments: true,
    includeAttachments: true,
    attachmentMode: "upload",
    attachmentDownloadAttempts: 3,
    attachmentDownloadRetryBaseDelayMs: 500,
    ensureStartDate: true,
    failOnCommentError: true,
    failOnAttachmentError: true,
    stopOnFirstError: true,
    includeRawJsonInNote: "fallback",
    rawJsonMaxLength: 6000,
    noteMaxLength: 10000,
    unmappedFieldsMax: 80,
    enforceSourceScope: true,
    requiredAssigneeKeywords: DEFAULT_FEISHU_OWNER_ROLE_FILTER_VALUES,
    readScope: {
      match: "all",
      filters: [DEFAULT_FEISHU_OWNER_ROLE_FILTER],
    },
    sort: [],
    webhookSecret: "",
  },
  sheetSync: {
    enabled: true,
    url: "https://hcn8isyrecyp.feishu.cn/sheets/Y9Gys3Ps5hiu1HtjCHaciDwenNf",
    keyColumn: "系统单号",
  },
  pocWorkItemIds: [],
};

const LEGACY_STD_FIELD_KEYS = {
  title: ["title", "name", "summary", "work_item_name", "work_item_title", "标题"],
  description: ["description", "desc", "detail", "body", "描述", "详情"],
  status: ["status", "state", "workflow_status", "flow_state", "状态"],
  priority: ["priority", "priority_level", "优先级"],
  severity: ["severity", "severity_level", "field_5a215d", "严重程度", "严重度"],
  assignees: ["assignee", "assignees", "owner", "owners", "handler", "handlers", "负责人", "当前负责人", "处理人", "当前处理人"],
  reporter: ["reporter", "creator", "created_by", "reporter_id", "报告人", "创建人"],
  dueDate: ["due_date", "deadline", "finish_time", "截止时间"],
  createdAt: ["created_at", "created", "create_time", "创建时间"],
  updatedAt: ["updated_at", "updated", "update_time", "修改时间", "更新时间"],
};

const STD_FIELD_KEYS = {
  id: ["id", "work_item_id", "workItemId", "issue_id", "workObjectId"],
  title: ["title", "name", "summary", "work_item_name", "workItemName", "work_item_title", "workItemTitle", "\u6807\u9898"],
  description: ["description", "desc", "detail", "details", "body", "content", "defect_description", "defectDescription", "bug_description", "bugDescription", "field_ee70e6", "\u63cf\u8ff0", "\u8be6\u60c5", "\u7f3a\u9677\u63cf\u8ff0", "\u95ee\u9898\u63cf\u8ff0"],
  status: ["status", "state", "workflow_status", "workflowStatus", "flow_state", "flowState", "node", "workflow_node", "workflowNode", "\u72b6\u6001"],
  priority: ["priority", "priority_level", "priorityLevel", "priority_key", "priorityKey", "\u4f18\u5148\u7ea7"],
  severity: ["severity", "severity_level", "severityLevel", "impact", "impact_level", "impactLevel", "field_5a215d", "\u4e25\u91cd\u7a0b\u5ea6", "\u4e25\u91cd\u5ea6"],
  assignees: ["assignee", "assignees", "assigned_to", "assignedTo", "current_status_operator", "currentStatusOperator", "current_status_operators", "currentStatusOperators", "owner", "owners", "handler", "handlers", "processor", "processors", "developer", "resolver", "\u8d1f\u8d23\u4eba", "\u5f53\u524d\u8d1f\u8d23\u4eba", "\u5904\u7406\u4eba", "\u5f53\u524d\u5904\u7406\u4eba"],
  reporter: ["reporter", "creator", "created_by", "createdBy", "reporter_id", "reporterId", "author", "opened_by", "openedBy", "\u62a5\u544a\u4eba", "\u521b\u5efa\u4eba"],
  dueDate: ["due_date", "dueDate", "deadline", "finish_time", "finishTime", "end_time", "endTime", "plan_fix_date", "Plan Fix Date", "field_8ec9f4", "field_51e0ee", "field_04beac", "field_794102", "\u622a\u6b62\u65f6\u95f4", "\u671f\u671b\u4fee\u590d\u65e5\u671f", "\u671f\u671b\u4fee\u590d\u65e5\u671f(\u8ba1\u7b97)", "\u671f\u671b\u4fee\u590d\u65e5\u671f\uff08\u8f85\u52a9\u901a\u77e5\u7528\uff09"],
  createdAt: ["created_at", "createdAt", "created", "create_time", "createTime", "\u521b\u5efa\u65f6\u95f4"],
  updatedAt: ["updated_at", "updatedAt", "updated", "update_time", "updateTime", "\u4fee\u6539\u65f6\u95f4", "\u66f4\u65b0\u65f6\u95f4"],
};

const DISPLAY_VALUE_KEYS = [
  "display_value",
  "displayValue",
  "display_name",
  "displayName",
  "label",
  "name",
  "title",
  "text",
  "content",
  "value",
  "field_value",
  "fieldValue",
  "option_name",
  "optionName",
  "status_name",
  "statusName",
  "node_name",
  "nodeName",
  "key",
  "id",
];

const MAPPING_VALUE_KEYS = [
  "id",
  "key",
  "value",
  "field_value",
  "fieldValue",
  "label",
  "name",
  "title",
  "text",
  "display_value",
  "displayValue",
  "option_id",
  "optionId",
  "option_key",
  "optionKey",
  "option_name",
  "optionName",
  "status_id",
  "statusId",
  "status_key",
  "statusKey",
  "status_name",
  "statusName",
  "node_id",
  "nodeId",
  "node_key",
  "nodeKey",
  "node_name",
  "nodeName",
];

const PERSON_ARRAY_KEYS = ["users", "members", "people", "owners", "assignees", "handlers", "processors", "value", "values"];
const PERSON_OBJECT_KEYS = ["user", "member", "person", "owner", "assignee", "handler", "processor", "creator", "reporter", "value", "field_value", "fieldValue"];

const CHILD_ITEM_KEYS = [
  "children",
  "child_items",
  "childItems",
  "child_work_items",
  "childWorkItems",
  "subtasks",
  "sub_tasks",
  "subTasks",
  "sub_task_list",
  "subTaskList",
];

const RELATED_ITEM_KEYS = [
  "related_items",
  "relatedItems",
  "related_work_items",
  "relatedWorkItems",
  "relations",
  "relation_items",
  "relationItems",
  "linked_items",
  "linkedItems",
  "dependencies",
];

const INTERNAL_FIELD_KEYS = new Set([
  "fields",
  "fieldvalues",
  "fieldmetadata",
  "customfields",
  "comments",
  "commentlist",
  "attachments",
  "attachmentlist",
  "spacekey",
  "projectkey",
  "typekey",
  "workitemtypekey",
  "sourceurl",
  "weburl",
  "raw",
]);

const STANDARD_FIELD_NORMS = new Set([
  ...Object.values(STD_FIELD_KEYS).flat(),
  ...CHILD_ITEM_KEYS,
  ...RELATED_ITEM_KEYS,
].map(normKey));

export function getFeishuProjectSyncConfig(overrides = {}) {
  const compatibleOverrides = withLegacySourceViewOverride(overrides);
  const cfg = deepMerge(
    DEFAULT_FEISHU_PROJECT_SYNC_CONFIG,
    feishuFilterPresetConfigPatch(),
    getConfig().feishuProjectSync || {},
    compatibleOverrides || {},
  );
  cfg.teambition = cfg.teambition || {};
  cfg.teambition.titleTemplate = normalizeTeambitionTitleTemplate(cfg.teambition.titleTemplate);
  normalizeTeambitionTargetConfig(cfg);
  normalizeTeambitionSprintConfig(cfg);
  normalizeFeishuSourceViewConfig(cfg);
  normalizeFeishuReadScopeConfig(cfg);
  normalizeFeishuSortConfig(cfg);
  cfg.mappings = cfg.mappings || {};
  cfg.mappings.priority = {
    ...(cfg.mappings.priority || {}),
    ...DEFAULT_FEISHU_PRIORITY_MAPPING,
  };
  cfg.routing = normalizeSyncPolicyConfig(cfg);
  return cfg;
}

function withLegacySourceViewOverride(overrides = {}) {
  const feishu = overrides?.feishu;
  if (!feishu || typeof feishu !== "object" || Array.isArray(feishu)) return overrides;
  const hasLegacy = Object.prototype.hasOwnProperty.call(feishu, "sourceView");
  const hasMultiple = Object.prototype.hasOwnProperty.call(feishu, "sourceViews");
  if (!hasLegacy || hasMultiple || !feishu.sourceView || typeof feishu.sourceView !== "object") return overrides;
  return deepMerge(overrides, {
    feishu: {
      sourceViews: [{
        ...feishu.sourceView,
        enabled: feishu.sourceView.enabled !== false,
        isDefault: true,
      }],
    },
  });
}

function normalizeTeambitionTargetConfig(cfg = {}) {
  cfg.teambition = cfg.teambition || {};
  const tb = cfg.teambition;
  if (!tb.tasklistId && tb.projectId === DEFAULT_TB_TARGET_PROJECT_ID) tb.tasklistId = DEFAULT_TB_TARGET_TASKLIST_ID;
  if (!tb.tasklistName && tb.tasklistId === DEFAULT_TB_TARGET_TASKLIST_ID) tb.tasklistName = DEFAULT_TB_TARGET_TASKLIST_NAME;
  if (!tb.scenariofieldconfigId && tb.projectId === DEFAULT_TB_TARGET_PROJECT_ID) tb.scenariofieldconfigId = DEFAULT_TB_TARGET_SCENARIO_FIELD_CONFIG_ID;
  if (!tb.taskTypeName && tb.scenariofieldconfigId === DEFAULT_TB_TARGET_SCENARIO_FIELD_CONFIG_ID) tb.taskTypeName = DEFAULT_TB_TARGET_TASK_TYPE_NAME;
  if (!tb.defaultExecutorId) tb.defaultExecutorId = DEFAULT_TB_EXECUTOR_ID;
  if (!tb.defaultExecutorName && tb.defaultExecutorId === DEFAULT_TB_EXECUTOR_ID) tb.defaultExecutorName = DEFAULT_TB_EXECUTOR_NAME;
  if (!tb.defectCategoryValue || tb.defectCategoryValue === "\u529f\u80fd\u4f7f\u7528bug") tb.defectCategoryValue = DEFAULT_TB_DEFECT_CATEGORY_VALUE;
  const normalizedPath = normKey(tb.projectPathName);
  const legacyPaths = [
    "平台组件/ 阿维塔8678平台S应用",
    "平台组件 / 阿维塔8678平台S应用",
    "平台组件/阿维塔8678平台S应用",
  ].map(normKey);
  if (!tb.projectPathName || legacyPaths.includes(normalizedPath) || tb.tasklistId === DEFAULT_TB_TARGET_TASKLIST_ID) {
    tb.projectPathName = DEFAULT_TB_TARGET_PROJECT_PATH_NAME;
  }
  return cfg;
}

function normalizeTeambitionSprintConfig(cfg = {}) {
  cfg.teambition = cfg.teambition || {};
  const tb = cfg.teambition;
  const parsed = parseTeambitionSprintUrl(tb.sprintUrl || tb.iterationUrl || "");
  if (!tb.projectId && parsed.projectId) tb.projectId = parsed.projectId;
  if (!tb.sprintId && (parsed.sprintId || tb.sprintSectionId || tb.sectionId)) {
    tb.sprintId = parsed.sprintId || tb.sprintSectionId || tb.sectionId;
  }
  const urlMismatch = tb.sprintUrl && tb.sprintId && parsed.sprintId && parsed.sprintId !== tb.sprintId;
  const projectMismatch = tb.sprintUrl && tb.projectId && parsed.projectId && parsed.projectId !== tb.projectId;
  if ((!tb.sprintUrl || urlMismatch || projectMismatch) && tb.projectId && tb.sprintId) {
    tb.sprintUrl = `https://www.teambition.com/project/${tb.projectId}/sprint/section/${tb.sprintId}`;
  }
  if (!tb.sprintName && tb.sprintId === DEFAULT_TB_TARGET_SPRINT_ID) tb.sprintName = DEFAULT_TB_TARGET_SPRINT_NAME;
  return cfg;
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

function normalizeFeishuSourceViewConfig(cfg = {}) {
  cfg.feishu = cfg.feishu || {};
  const feishu = cfg.feishu;
  const current = feishu.sourceView && typeof feishu.sourceView === "object" ? feishu.sourceView : {};
  const fallbackUrl = current.url || feishu.web?.homepageUrl || "";
  const listedViews = Array.isArray(feishu.sourceViews)
    ? feishu.sourceViews.filter((view) => view && typeof view === "object" && !Array.isArray(view))
    : null;
  // 空数组视为未配置，回退到旧版 sourceView，避免出现“空来源 + 新来源”变成两条。
  const hasSourceViews = Array.isArray(listedViews) && listedViews.length > 0;
  const rawViews = hasSourceViews
    ? listedViews.slice(0, MAX_FEISHU_SOURCE_VIEWS)
    : [{ ...current, url: current.url || fallbackUrl, enabled: current.enabled !== false, isDefault: true }];
  const normalized = [];
  const seen = new Set();
  const seenIds = new Set();
  for (let index = 0; index < rawViews.length; index += 1) {
    let sourceView = normalizeFeishuSourceViewEntry(rawViews[index], {
      index,
      fallbackProjectKey: feishu.spaceKey,
      fallbackWorkItemTypeKey: feishu.workItemTypeKey,
    });
    if (!sourceView) continue;
    const key = canonicalFeishuSourceViewKey(sourceView) || `row:${index}`;
    if (seen.has(key)) continue;
    seen.add(key);
    let normalizedId = stringValue(sourceView.id);
    if (seenIds.has(normKey(normalizedId))) {
      normalizedId = `source-${createHash("sha1").update(key).digest("hex").slice(0, 10)}`;
      if (seenIds.has(normKey(normalizedId))) normalizedId = `${normalizedId}-${index + 1}`;
      sourceView = { ...sourceView, id: normalizedId };
    }
    seenIds.add(normKey(normalizedId));
    normalized.push(sourceView);
  }

  const usableDefaultIndex = normalized.findIndex((sourceView) => sourceView.isDefault && sourceView.enabled !== false && isUsableFeishuSourceView(sourceView));
  const enabledDefaultIndex = normalized.findIndex((sourceView) => sourceView.isDefault && sourceView.enabled !== false);
  const usableIndex = normalized.findIndex((sourceView) => sourceView.enabled !== false && isUsableFeishuSourceView(sourceView));
  const enabledIndex = normalized.findIndex((sourceView) => sourceView.enabled !== false);
  const requestedDefaultIndex = normalized.findIndex((sourceView) => sourceView.isDefault);
  const defaultIndex = [usableDefaultIndex, enabledDefaultIndex, usableIndex, enabledIndex, requestedDefaultIndex, normalized.length ? 0 : -1]
    .find((index) => index >= 0) ?? -1;
  feishu.sourceViews = normalized.map((sourceView, index) => ({
    ...sourceView,
    isDefault: index === defaultIndex,
  }));

  const primary = feishu.sourceViews[defaultIndex] || feishu.sourceViews[0] || null;
  feishu.sourceView = primary ? sourceViewCompatibilityShape(primary) : {};
  if (primary?.sourceProjectKey) feishu.spaceKey = primary.sourceProjectKey;
  if (primary?.sourceWorkItemTypeKey) feishu.workItemTypeKey = primary.sourceWorkItemTypeKey;
  if (primary?.url) {
    feishu.web = feishu.web || {};
    feishu.web.homepageUrl = primary.url;
  }
  return cfg;
}

function normalizeFeishuSourceViewEntry(value = {}, options = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const url = stringValue(value.url || value.viewUrl || "");
  const parsed = parseFeishuProjectUrl(url);
  const viewId = stringValue(value.viewId || value.view_id || parsed.viewId);
  const configuredProjectKey = value.sourceProjectKey || value.projectKey || value.spaceKey;
  const configuredWorkItemTypeKey = value.sourceWorkItemTypeKey || value.workItemTypeKey || value.typeKey;
  // URL 解析结果优先于全局 fallback，避免多来源时把 bug_double_eight 错写成默认 bug。
  const sourceProjectKey = stringValue(
    configuredProjectKey || parsed.sourceProjectKey || options.fallbackProjectKey,
  );
  const sourceWorkItemTypeKey = stringValue(
    configuredWorkItemTypeKey || parsed.sourceWorkItemTypeKey || options.fallbackWorkItemTypeKey,
  );
  if (!url && !viewId) return null;
  const identitySeed = [sourceProjectKey, sourceWorkItemTypeKey, viewId || url || options.index].filter(Boolean).join("-");
  const id = stringValue(value.id) || `source-${createHash("sha1").update(identitySeed || String(options.index || 0)).digest("hex").slice(0, 10)}`;
  const name = stringValue(value.name || value.label || value.title)
    || [sourceWorkItemTypeKey, viewId].filter(Boolean).join(" · ")
    || `飞书来源 ${Number(options.index || 0) + 1}`;
  return cleanObject({
    id,
    name,
    url,
    enabled: value.enabled !== false,
    isDefault: value.isDefault === true || value.default === true || value.primary === true,
    viewId,
    scope: stringValue(value.scope || parsed.scope),
    node: stringValue(value.node || parsed.node),
    sourceProjectKey,
    sourceWorkItemTypeKey,
  });
}

function sourceViewCompatibilityShape(sourceView = {}) {
  return cleanObject({
    url: stringValue(sourceView.url),
    viewId: stringValue(sourceView.viewId),
    scope: stringValue(sourceView.scope),
    node: stringValue(sourceView.node),
  });
}

function normalizeFeishuReadScopeConfig(cfg = {}) {
  cfg.sync = cfg.sync || {};
  const scope = cfg.sync.readScope && typeof cfg.sync.readScope === "object" ? cfg.sync.readScope : {};
  const filters = normalizeFeishuReadFilters(scope.filters);
  if (scope.enabled === false) {
    cfg.sync.readScope = {
      enabled: false,
      match: String(scope.match || "all").toLowerCase() === "any" ? "any" : "all",
      filters,
    };
    return cfg;
  }
  cfg.sync.readScope = {
    enabled: true,
    match: String(scope.match || "all").toLowerCase() === "any" ? "any" : "all",
    filters: filters.length ? filters : normalizeFeishuReadFilters([DEFAULT_FEISHU_OWNER_ROLE_FILTER]),
  };
  const ownerFilter = cfg.sync.readScope.filters.find((filter) => isProblemOwnerRoleFilter(filter));
  if (ownerFilter?.values?.length) cfg.sync.requiredAssigneeKeywords = ownerFilter.values;
  return cfg;
}

function normalizeFeishuSortConfig(cfg = {}) {
  cfg.sync = cfg.sync || {};
  cfg.sync.sort = normalizeFeishuSortRules(cfg.sync.sort || cfg.sync.orderBy || cfg.feishu?.sourceView?.sort);
  return cfg;
}

export function getFeishuProjectSyncReadiness(overrides) {
  const rawOverrides = overrides === undefined
    ? (getConfig().feishuProjectSync || {})
    : (overrides || {});
  const cfg = getFeishuProjectSyncConfig(rawOverrides);
  const missing = [];
  const rawRouting = rawOverrides?.routing && typeof rawOverrides.routing === "object" && !Array.isArray(rawOverrides.routing)
    ? rawOverrides.routing
    : cfg.routing;
  const policyValidation = validateSyncPolicyConfig({ ...cfg, routing: rawRouting });
  const authMode = String(cfg.feishu.authMode || "plugin").toLowerCase();
  const sourceViews = getFeishuSourceViews(cfg);
  if (authMode === "web") {
    if (!sourceViews.some((sourceView) => sourceView.url) && !cfg.feishu.web?.homepageUrl) missing.push("feishu.web.homepageUrl");
  } else if (authMode === "mcp") {
    if (!cfg.feishu.mcp?.serverUrl) missing.push("feishu.mcp");
  } else {
    if (!cfg.feishu.pluginId) missing.push("feishu.pluginId");
    if (!cfg.feishu.pluginSecret) missing.push("feishu.pluginSecret");
    if (!cfg.feishu.userKey) missing.push("feishu.userKey");
  }
  if (!sourceViews.length) missing.push("feishu.sourceViews");
  if (!cfg.teambition.projectId) missing.push("teambition.projectId");
  if (!cfg.teambition.tasklistId) missing.push("teambition.tasklistId");
  if (!cfg.teambition.sprintId) missing.push("teambition.sprintId");
  return {
    enabled: !!cfg.enabled,
    authMode,
    feishuReady: missing.every((x) => !x.startsWith("feishu.")),
    teambitionReady: missing.every((x) => !x.startsWith("teambition.")),
    missing,
    policyValidation: {
      valid: policyValidation.valid,
      errors: policyValidation.errors,
      warnings: policyValidation.warnings,
    },
  };
}

export class FeishuProjectClient extends FeishuProjectExtractor {
  constructor(config = {}, options = {}) {
    const cfg = getFeishuProjectSyncConfig(config);
    super({
      ...cfg.feishu,
      pageSize: cfg.feishu.pageSize || cfg.sync.batchSize,
    }, options);
  }
}

export function normalizeFeishuWorkItem(raw, config = {}) {
  const cfg = getFeishuProjectSyncConfig(config);
  const capturedSourceView = raw?._feishuSourceView && typeof raw._feishuSourceView === "object"
    ? raw._feishuSourceView
    : {};
  const fieldMetadata = normalizeFeishuFieldMetadata(raw?._fieldMetadata || raw?.fieldMetadata || cfg.feishu.fieldMetadata || null);
  const fields = normalizeFields(raw, fieldMetadata);
  const fieldMap = buildFieldLookup(fields);
  const read = (name) => readStandardField(raw, fields, fieldMap, STD_FIELD_KEYS[name] || []);
  const id = stringValue(getFirst(raw, ["id", "work_item_id", "workItemId", "issue_id", "workObjectId"]) || read("id"));
  let sourceProjectKey = stringValue(
    getFirst(raw, ["space_key", "spaceKey", "project_key", "projectKey"])
      || capturedSourceView.sourceProjectKey
      || cfg.feishu.spaceKey,
  );
  let sourceWorkItemTypeKey = stringValue(
    getFirst(raw, ["work_item_type_key", "workItemTypeKey", "type_key", "typeKey"])
      || capturedSourceView.sourceWorkItemTypeKey
      || cfg.feishu.workItemTypeKey,
  );
  const title = displayValue(read("title")) || stringValue(getFirst(raw, ["title", "name", "summary"])) || id || "(untitled)";
  const description = readDescriptionField(raw, fields, fieldMap) || displayValue(read("description"));
  const statusRaw = read("status");
  const priorityRaw = read("priority");
  const severityRaw = read("severity");
  const status = displayValue(statusRaw);
  const priority = displayValue(priorityRaw);
  const severity = displayValue(severityRaw);
  const assigneesRaw = read("assignees");
  const reporterRaw = read("reporter");
  const assignees = normalizePeople(assigneesRaw);
  const reporter = normalizePeople(reporterRaw)[0] || null;
  const createdAt = dateValue(read("createdAt") || getFirst(raw, ["created_at", "created", "create_time", "createTime"]));
  const updatedAt = dateValue(read("updatedAt") || getFirst(raw, ["updated_at", "updated", "update_time", "updateTime"]));
  const dueDate = dateValue(read("dueDate") || getFirst(raw, ["due_date", "dueDate", "deadline", "finish_time", "finishTime", "end_time", "endTime"]));
  const sourceUrl = stringValue(getFirst(raw, ["url", "source_url", "sourceUrl", "web_url", "webUrl", "work_item_url", "workItemUrl", "detail_url", "detailUrl"]))
    || renderTemplate(cfg.feishu.sourceUrlTemplate, {
      ...cfg.feishu,
      spaceKey: sourceProjectKey,
      workItemTypeKey: sourceWorkItemTypeKey,
      workItemId: id,
    });
  const sourceUrlScope = parseFeishuProjectUrl(sourceUrl);
  if (
    cfg.feishu?.spaceKey
    && cfg.feishu?.workItemTypeKey
    && normKey(sourceUrlScope.sourceProjectKey) === normKey(cfg.feishu.spaceKey)
    && normKey(sourceUrlScope.sourceWorkItemTypeKey) === normKey(cfg.feishu.workItemTypeKey)
  ) {
    sourceProjectKey = stringValue(cfg.feishu.spaceKey);
    sourceWorkItemTypeKey = stringValue(cfg.feishu.workItemTypeKey);
  }
  const childItems = normalizeLinkedItems(getFirst(raw, CHILD_ITEM_KEYS) || [], "child");
  const relatedItems = normalizeLinkedItems(getFirst(raw, RELATED_ITEM_KEYS) || [], "related");
  const comments = normalizeComments(getFirst(raw, ["comments", "comment_list", "commentList", "comment_records", "commentRecords"]) || []);
  const attachments = mergeNormalizedAttachments(
    normalizeAttachments(getFirst(raw, ["attachments", "attachment_list", "attachmentList", "files", "file_list", "fileList"]) || []),
    normalizeAttachmentFields(fields),
    comments.flatMap((comment) => comment.attachments || []),
  );

  return {
    sourceSystem: SOURCE_SYSTEM,
    sourceProjectKey,
    sourceWorkItemTypeKey,
    sourceViewId: stringValue(capturedSourceView.viewId || capturedSourceView.id),
    sourceViewName: stringValue(capturedSourceView.name),
    sourceWorkItemId: id,
    sourceWorkItemUrl: sourceUrl,
    title,
    description,
    status,
    statusRaw,
    priority,
    priorityRaw,
    severity,
    severityRaw,
    assignees,
    assigneesRaw,
    reporter,
    reporterRaw,
    createdAt,
    updatedAt,
    dueDate,
    fields,
    fieldMetadata,
    comments,
    attachments,
    childItems,
    relatedItems,
    raw,
  };
}

/**
 * 回填空缺的「应用分类 / 缺陷分类」自定义字段 ID。
 * 真实 TB 单详情的 customfields 条目只带 _customfieldId、不带字段名，
 * 若配置里字段 ID 为空且条目也无名字，dry-run 就读不到「当前 TB 应用分类」，
 * 从而把动作误判成“写入”。这里用项目的 task 自定义字段定义按字段名解析出 ID，
 * 使后续 targetCategoryCustomFieldSnapshot 能按 ID 命中当前值并正确判定 不变/更新。
 * cfg 由 getFeishuProjectSyncConfig 每次 deepMerge 生成，teambition 为全新对象，改标量安全。
 */
async function resolveCategoryCustomFieldIds(cfg = {}, loader = null, enforceRequiredFieldPlan = false) {
  const tb = cfg.teambition || (cfg.teambition = {});
  if (typeof loader?.listTaskCustomFieldDefs !== "function") return cfg;
  let defs = [];
  try {
    defs = await loader.listTaskCustomFieldDefs(tb.projectId, cfg);
  } catch (err) {
    if (shouldEnforceWrittenFieldVerification(loader, cfg, enforceRequiredFieldPlan)) {
      throw new Error(`读取 TB 自定义字段定义失败，已阻止不完整同步：${err?.message || String(err)}`);
    }
    return cfg;
  }
  if (!Array.isArray(defs) || !defs.length) {
    if (shouldEnforceWrittenFieldVerification(loader, cfg, enforceRequiredFieldPlan)) throw new Error("未读取到 TB 自定义字段定义，已阻止不完整同步");
    return cfg;
  }
  const choiceEntriesByFieldId = {};
  for (const def of defs) {
    const id = stringValue(def?.id || def?._id || def?.customfieldId);
    if (!id) continue;
    const entries = (Array.isArray(def?.choiceEntries) ? def.choiceEntries : []).map((entry) => cleanObject({
      id: stringValue(entry?.id || entry?._id || entry?.valueId || entry?.choiceId),
      name: stringValue(entry?.name || entry?.title || entry?.label || entry?.value),
    })).filter((entry) => entry.name);
    if (entries.length) choiceEntriesByFieldId[id] = entries;
  }
  tb._runtimeCustomFieldChoiceEntries = choiceEntriesByFieldId;
  for (const fieldKey of TARGET_NAMED_CUSTOM_FIELD_KEYS) {
    const names = new Set((TARGET_NAMED_CUSTOM_FIELD_NAME_MAP[fieldKey] || []).map(normalizedCustomFieldName).filter(Boolean));
    if (!names.size) continue;
    const configuredId = stringValue(tb[`${fieldKey}CustomFieldId`]);
    const hit = (configuredId ? defs.find((def) => stringValue(def?.id || def?._id || def?.customfieldId) === configuredId) : null)
      || defs.find((def) => names.has(normalizedCustomFieldName(def?.name)));
    const id = stringValue(hit?.id || hit?._id || hit?.customfieldId);
    if (id && !configuredId) tb[`${fieldKey}CustomFieldId`] = id;
  }
  if (shouldEnforceWrittenFieldVerification(loader, cfg, enforceRequiredFieldPlan)) {
    const missing = TARGET_NAMED_CUSTOM_FIELD_KEYS.filter((fieldKey) => !stringValue(tb[`${fieldKey}CustomFieldId`]));
    if (missing.length) throw new Error(`TB 必写自定义字段未解析：${missing.join(", ")}`);
  }
  return cfg;
}

async function resolveConfiguredTagIds(cfg = {}, loader = null, enforceRequiredFieldPlan = false) {
  if (typeof loader?.listProjectTags !== "function") return cfg;
  const tb = cfg.teambition || (cfg.teambition = {});
  const configuredRules = Array.isArray(cfg.mappings?.keywordRules) ? cfg.mappings.keywordRules : [];
  const targets = [tb];
  for (const rule of configuredRules) {
    if (!rule || typeof rule !== "object") continue;
    targets.push(rule.target && typeof rule.target === "object" ? rule.target : rule);
  }
  if (!targets.some((target) => normalizeStringList(target.tagNames || target.defaultTagNames).length)) return cfg;

  let tags = [];
  try {
    tags = await loader.listProjectTags(tb.projectId, cfg);
  } catch (err) {
    if (shouldEnforceWrittenFieldVerification(loader, cfg, enforceRequiredFieldPlan)) {
      throw new Error(`读取 TB 标签定义失败，已阻止不完整同步：${err?.message || String(err)}`);
    }
    return cfg;
  }
  if (!Array.isArray(tags) || !tags.length) {
    if (shouldEnforceWrittenFieldVerification(loader, cfg, enforceRequiredFieldPlan)) throw new Error("未读取到 TB 标签定义，已阻止不完整同步");
    return cfg;
  }
  const exact = new Map();
  const comparable = new Map();
  for (const tag of tags) {
    const id = stringValue(tag?.id || tag?._id || tag?.tagId);
    const name = stringValue(tag?.name || tag?.title || tag?.label);
    if (!id || !name) continue;
    exact.set(normKey(name), id);
    const key = comparableTeambitionTagName(name);
    if (key && !comparable.has(key)) comparable.set(key, id);
  }
  for (const target of targets) {
    const names = normalizeStringList(target.tagNames || target.defaultTagNames);
    if (!names.length) continue;
    const resolved = names.map((name) => (
      exact.get(normKey(name)) || comparable.get(comparableTeambitionTagName(name)) || ""
    )).filter(Boolean);
    if (resolved.length) target.tagIds = uniq([...normalizeStringList(target.tagIds || target.defaultTagIds), ...resolved]);
    if (shouldEnforceWrittenFieldVerification(loader, cfg, enforceRequiredFieldPlan) && resolved.length !== names.length) {
      const unresolved = names.filter((name) => !exact.has(normKey(name)) && !comparable.has(comparableTeambitionTagName(name)));
      throw new Error(`TB 必写标签未解析：${unresolved.join(", ")}`);
    }
  }
  return cfg;
}

function shouldEnforceWrittenFieldVerification(loader, cfg = {}, enforceRequiredFieldPlan = false) {
  return enforceRequiredFieldPlan === true
    && loader?.enforceWrittenFieldVerification === true
    && cfg.sync?.verifyWrittenTargetFields !== false;
}

function hasCompleteRequiredFieldSourceValues(item = {}) {
  return hasValue(item.severity)
    && hasValue(sourceFieldDisplayValue(item, ["field_5d5056", "软件版本", "版本号"]))
    && hasValue(sourceFieldDisplayValue(item, ["field_be6bf1", "发生概率", "复现概率"]));
}

function comparableTeambitionTagName(value = "") {
  return normKey(value).replace(/[\[\]【】()（）<>《》]/g, "");
}

export function buildTeambitionTaskPayload(item, config = {}) {
  let cfg = getFeishuProjectSyncConfig(config);
  const inlinePolicyDecision = resolveSyncPolicy({
    config: cfg,
    source: {
      system: item.sourceSystem || SOURCE_SYSTEM,
      projectKey: item.sourceProjectKey,
      typeKey: item.sourceWorkItemTypeKey,
      viewId: item.sourceViewId,
    },
    item,
    raw: item.raw,
  });
  if (inlinePolicyDecision.target?.system === TARGET_SYSTEM) cfg = applyResolvedSyncPolicy(cfg, inlinePolicyDecision);
  const tb = cfg.teambition || {};
  const mappedAssignees = (item.assignees || []).map((p) => mapPerson(p, cfg.mappings.people)).filter(Boolean);
  const mappedReporter = item.reporter ? mapPerson(item.reporter, cfg.mappings.people) : "";
  const executorId = tb.defaultExecutorId || mappedAssignees[0] || "";
  const involveMembers = uniq([...mappedAssignees, mappedReporter].filter(Boolean));
  const requiredInvolveMembers = resolveRequiredInvolveMembers(cfg);
  const mappedStatus = mapByValue(item.statusRaw ?? item.status, cfg.mappings.status) || mapByValue(item.status, cfg.mappings.status);
  const mappedPriority = mapByValue(item.priorityRaw ?? item.priority, cfg.mappings.priority) || mapByValue(item.priority, cfg.mappings.priority);
  const mappedSeverity = mapByValue(item.severityRaw ?? item.severity, cfg.mappings.severity)
    || mapByValue(item.severity, cfg.mappings.severity)
    || defaultTeambitionSeverityValue(item.severityRaw ?? item.severity);
  const keywordMatch = applyKeywordRules(item, cfg);
  const applicationCategory = teambitionApplicationCategoryValue(cfg, keywordMatch);
  const defectCategory = teambitionDefectCategoryValue(cfg);
  const version = sourceFieldDisplayValue(item, ["field_5d5056", "软件版本", "版本号"]);
  const reproductionProbability = sourceFieldDisplayValue(item, ["field_be6bf1", "发生概率", "复现概率"]);
  const mappingContext = {
    mappedAssignees,
    mappedReporter,
    mappedStatus,
    mappedPriority,
    mappedSeverity,
    applicationCategory,
    defectCategory,
    version,
    reproductionProbability,
    matchedKeywordRules: keywordMatch.matched,
    unresolvedPeople: unresolvedPeople(item, cfg.mappings.people),
  };
  const customfields = mergeCustomFields(buildCustomFields(item, cfg, mappingContext), keywordMatch.customfields);
  const target = keywordMatch.target || {};
  const nativePriority = normalizeTeambitionPriority(hasValue(target.priority) ? target.priority : (hasValue(mappedPriority) ? mappedPriority : item.priority));
  const tagIds = uniq([
    ...normalizeStringList(tb.tagIds || tb.defaultTagIds),
    ...normalizeStringList(target.tagIds || target.defaultTagIds),
  ]);
  const targetInvolveMembers = normalizeStringList(target.involveMembers);
  const finalInvolveMembers = uniq([
    ...(target.replaceInvolveMembers ? targetInvolveMembers : [...involveMembers, ...targetInvolveMembers]),
    ...requiredInvolveMembers,
  ]);
  const schedule = buildTeambitionTaskSchedule(item, cfg);
  const payload = cleanObject({
    projectId: target.projectId || tb.projectId,
    content: formatTeambitionTaskTitle(item, cfg),
    executorId: target.executorId || executorId,
    involveMembers: finalInvolveMembers,
    stageId: target.stageId || tb.stageId,
    tasklistId: target.tasklistId || tb.tasklistId,
    sprintId: target.sprintId || target.sprintSectionId || target.sectionId || tb.sprintId || tb.sprintSectionId || tb.sectionId,
    taskflowstatusId: target.taskflowstatusId || target.statusId || (hasValue(mappedStatus) ? mappedStatus : tb.taskflowstatusId),
    startDate: schedule.startDate,
    dueDate: schedule.dueDate,
    note: buildTaskNote(item, cfg, mappingContext),
    priority: nativePriority,
    scenariofieldconfigId: target.scenariofieldconfigId || tb.scenariofieldconfigId,
    tagIds: tagIds.length ? tagIds : undefined,
    customfields: customfields.length ? customfields : undefined,
  });
  return {
    payload,
    customfields,
    display: cleanObject({
      applicationCategory,
      applicationCategoryCustomFieldId: tb.applicationCategoryCustomFieldId,
      defectCategory,
      defectCategoryCustomFieldId: tb.defectCategoryCustomFieldId,
      severity: mappedSeverity,
      severityCustomFieldId: tb.severityCustomFieldId,
      version,
      versionCustomFieldId: tb.versionCustomFieldId,
      reproductionProbability,
      reproductionProbabilityCustomFieldId: tb.reproductionProbabilityCustomFieldId,
    }),
  };
}

export function previewFeishuProjectSyncPolicy(raw = {}, options = {}) {
  const baseConfig = getFeishuProjectSyncConfig(options.config || options || {});
  const item = normalizeFeishuWorkItem(raw, baseConfig);
  const decision = resolveSyncPolicy({
    config: baseConfig,
    source: {
      system: item.sourceSystem,
      projectKey: item.sourceProjectKey,
      typeKey: item.sourceWorkItemTypeKey,
      viewId: item.sourceViewId,
    },
    item,
    raw,
  });
  const effectiveConfig = applyResolvedSyncPolicy(baseConfig, decision);
  const built = buildTeambitionTaskPayload(item, effectiveConfig);
  const action = String(options.action || "create").toLowerCase() === "update" ? "update" : "create";
  const strategyResult = applySyncPayloadStrategy(built.payload, action, decision);
  return {
    ok: true,
    action,
    item: {
      sourceSystem: item.sourceSystem,
      sourceProjectKey: item.sourceProjectKey,
      sourceWorkItemTypeKey: item.sourceWorkItemTypeKey,
      sourceWorkItemId: item.sourceWorkItemId,
      sourceViewId: item.sourceViewId,
      title: item.title,
    },
    policyDecision: publicDecision(decision),
    strategyEffects: strategyResult.effects,
    payload: cleanObject({
      projectId: strategyResult.payload.projectId,
      tasklistId: strategyResult.payload.tasklistId,
      sprintId: strategyResult.payload.sprintId,
      executorId: strategyResult.payload.executorId,
      content: strategyResult.payload.content,
      taskflowstatusId: strategyResult.payload.taskflowstatusId,
      priority: strategyResult.payload.priority,
      tagIds: strategyResult.payload.tagIds,
      customFieldCount: Array.isArray(strategyResult.payload.customfields) ? strategyResult.payload.customfields.length : 0,
      hasDescription: hasValue(strategyResult.payload.note),
    }),
  };
}

export function formatTeambitionTaskTitle(item, config = {}) {
  const cfg = getFeishuProjectSyncConfig(config);
  const template = normalizeTeambitionTitleTemplate(cfg.teambition?.titleTemplate);
  const sourceWorkItemNo = getSourceWorkItemNo(item);
  const title = stringValue(item?.title) || sourceWorkItemNo || stringValue(item?.sourceWorkItemId) || "(untitled)";
  const rawProblemSummary = getSourceProblemSummary(item) || title;
  const problemSummary = stripLeadingSourceNo(rawProblemSummary, sourceWorkItemNo);
  return renderTemplate(template, {
    title,
    problemSummary,
    rawProblemSummary,
    summary: problemSummary,
    sourceWorkItemNo,
    workItemNo: sourceWorkItemNo,
    sourceWorkItemId: item?.sourceWorkItemId || "",
    workItemId: item?.sourceWorkItemId || "",
    sourceProjectKey: item?.sourceProjectKey || "",
    sourceWorkItemTypeKey: item?.sourceWorkItemTypeKey || "",
    sourceId: `${item?.sourceProjectKey || ""}/${item?.sourceWorkItemTypeKey || ""}/${item?.sourceWorkItemId || ""}`,
  }) || title;
}

function buildTeambitionTaskSchedule(item = {}, cfg = {}) {
  const startDate = dateValue(item.createdAt);
  if (!startDate) return cleanObject({ dueDate: dateValue(item.dueDate) });
  const days = Math.max(1, Number(cfg.teambition?.defaultDurationDays ?? 3) || 3);
  return {
    startDate,
    dueDate: addDaysIso(startDate, days),
  };
}

function addDaysIso(value, days) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString();
}

function stripLeadingSourceNo(value = "", sourceWorkItemNo = "") {
  const text = stringValue(value).trim();
  const no = stringValue(sourceWorkItemNo).trim();
  if (!text || !no) return text;
  const escaped = no.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return text.replace(new RegExp(`^${escaped}\\s*[-_：:、]?\\s*`, "i"), "").trim();
}

function normalizeTeambitionTitleTemplate(template) {
  const value = stringValue(template);
  if (!value || LEGACY_TB_TITLE_TEMPLATES.has(value)) return DEFAULT_TB_TITLE_TEMPLATE;
  return value;
}

export function getSourceProblemNo(item = {}) {
  return readSourceWorkItemNoFromItem(item);
}

export function getSourceWorkItemNo(item = {}) {
  return readSourceWorkItemNoFromItem(item) || stringValue(item.sourceWorkItemId);
}

function readSourceWorkItemNoFromItem(item = {}) {
  const fromRaw = stringValue(getFirst(item.raw || {}, [
    "work_item_no",
    "workItemNo",
    "work_item_key",
    "workItemKey",
    "issue_key",
    "issueKey",
    "issue_no",
    "issueNo",
    "ticket_no",
    "ticketNo",
    "bug_no",
    "bugNo",
    "display_id",
    "displayId",
    "identifier",
    "number",
    "no",
  ]));
  const fromRawProblemNo = sourceProblemNoFromText(fromRaw);
  if (fromRawProblemNo) return fromRawProblemNo;
  const fallbackRawNo = fromRaw;

  const fromTitle = sourceProblemNoFromText(item.title);
  if (fromTitle) return fromTitle;

  const noField = (item.fields || []).find((field) => {
    const text = `${field.key || ""}\n${field.name || ""}`.toLowerCase();
    if (/auto.?number|\u81ea\u589e\u6570\u5b57/i.test(text)) return false;
    return /(work.?item.?no|work.?item.?key|issue.?key|issue.?no|ticket.?no|bug.?no|display.?id|identifier|\bno\b|number|编号|单号|工单号|问题编号|缺陷编号)/i.test(text);
  });
  const fromField = displayValue(noField?.value ?? noField?.displayValue);
  const fromFieldProblemNo = sourceProblemNoFromText(fromField);
  if (fromFieldProblemNo) return fromFieldProblemNo;
  if (fromField) return fromField;

  return fallbackRawNo || "";
}

function sourceProblemNoFromText(value = "") {
  return stringValue(value).match(/\b[A-Z][A-Z0-9]+-\d+\b/i)?.[0] || "";
}

const PROBLEM_SUMMARY_FIELD_KEYS = new Set([
  "field80c785",
  "fieldb70d7e",
  "problemsummary",
  "issuesummary",
  "summary",
]);

const PROBLEM_SUMMARY_FIELD_NAME_RE = /(?:\u95ee\u9898\u6982\u8981|problem.?summary|issue.?summary|\bsummary\b)/i;

export function getSourceProblemSummary(item = {}) {
  const sourceWorkItemNo = getSourceWorkItemNo(item);
  const raw = item.raw || {};
  const fromRaw = displayValue(getFirst(raw, [
    "field_80c785",
    "field_b70d7e",
    "problem_summary",
    "issue_summary",
    "summary",
    "\u95ee\u9898\u6982\u8981",
    "\u95ee\u9898\u6982\u8981\uff08\u6574\u8f66\uff09",
  ]));
  if (isUsefulProblemSummary(fromRaw, sourceWorkItemNo)) return fromRaw;

  const summaryField = (item.fields || []).find((field) => {
    const key = normKey(field.key || field.field_key || "");
    const name = `${field.name || field.field_name || ""}`;
    return PROBLEM_SUMMARY_FIELD_KEYS.has(key) || PROBLEM_SUMMARY_FIELD_NAME_RE.test(name);
  });
  const fromField = displayValue(summaryField?.value ?? summaryField?.displayValue ?? summaryField?.display_value);
  if (isUsefulProblemSummary(fromField, sourceWorkItemNo)) return fromField;

  const title = stringValue(item.title);
  return isUsefulProblemSummary(title, sourceWorkItemNo) ? title : "";
}

function isUsefulProblemSummary(value, sourceWorkItemNo = "") {
  const text = stringValue(value).replace(/\s+/g, " ").trim();
  if (!text) return false;
  if (sourceWorkItemNo && normKey(text) === normKey(sourceWorkItemNo)) return false;
  if (/^[A-Z][A-Z0-9]+-\d+$/i.test(text)) return false;
  return true;
}

export function getFeishuSourceScope(config = {}) {
  const cfg = getFeishuProjectSyncConfig(config);
  const sourceView = getFeishuSourceView(cfg);
  const parsed = parseFeishuProjectUrl(sourceView.url || cfg.feishu?.web?.homepageUrl || "");
  return {
    sourceProjectKey: stringValue(sourceView.sourceProjectKey || cfg.feishu?.spaceKey) || parsed.sourceProjectKey,
    sourceWorkItemTypeKey: stringValue(sourceView.sourceWorkItemTypeKey || cfg.feishu?.workItemTypeKey) || parsed.sourceWorkItemTypeKey,
  };
}

export function parseFeishuProjectUrl(url = "") {
  try {
    const parsed = new URL(String(url || "").trim());
    if (parsed.protocol !== "https:" || parsed.hostname.toLowerCase() !== "project.feishu.cn" || parsed.username || parsed.password) return {};
    const parts = parsed.pathname.split("/").filter(Boolean);
    if (parts.length < 2) return {};
    if (normKey(parts[1]) === "workobjectview") {
      if (!parts[0] || !parts[2] || !parts[3]) return {};
      return {
        sourceProjectKey: parts[0] || "",
        sourceWorkItemTypeKey: parts[2] || "",
        viewId: parts[3] || "",
        scope: parsed.searchParams.get("scope") || "",
        node: parsed.searchParams.get("node") || "",
        url: parsed.toString(),
      };
    }
    return {
      sourceProjectKey: parts[0] || "",
      sourceWorkItemTypeKey: parts[1] || "",
      viewId: "",
      scope: parsed.searchParams.get("scope") || "",
      node: parsed.searchParams.get("node") || "",
      url: parsed.toString(),
    };
  } catch {
    return {};
  }
}

export function canonicalFeishuSourceViewKey(sourceView = {}) {
  const parsed = parseFeishuProjectUrl(sourceView.url || "");
  const sourceProjectKey = stringValue(parsed.sourceProjectKey || sourceView.sourceProjectKey || sourceView.projectKey || sourceView.spaceKey);
  const sourceWorkItemTypeKey = stringValue(parsed.sourceWorkItemTypeKey || sourceView.sourceWorkItemTypeKey || sourceView.workItemTypeKey || sourceView.typeKey);
  const viewId = stringValue(parsed.viewId || sourceView.viewId || sourceView.view_id);
  if (!sourceProjectKey || !sourceWorkItemTypeKey || !viewId) return "";
  return [sourceProjectKey, sourceWorkItemTypeKey, viewId].map(normKey).join(":");
}

export function validateFeishuSourceViewUrl(url = "") {
  const value = stringValue(url);
  if (!value) return { ok: false, error: "飞书工单来源 URL 不能为空" };
  let parsedUrl;
  try {
    parsedUrl = new URL(value);
  } catch {
    return { ok: false, error: "URL 格式不正确" };
  }
  if (parsedUrl.protocol !== "https:") return { ok: false, error: "飞书工单来源必须使用 HTTPS" };
  if (parsedUrl.hostname.toLowerCase() !== "project.feishu.cn") return { ok: false, error: "只支持 project.feishu.cn 的飞书项目 URL" };
  if (parsedUrl.username || parsedUrl.password) return { ok: false, error: "URL 不能包含账号或密码" };
  const parsed = parseFeishuProjectUrl(value);
  if (!parsed.viewId || !parsed.sourceProjectKey || !parsed.sourceWorkItemTypeKey) {
    return {
      ok: false,
      error: "请输入飞书工单列表 URL，格式为 /{空间}/workObjectView/{工单类型}/{View ID}",
    };
  }
  return { ok: true, value: parsed.url || value, parsed };
}

function isUsableFeishuSourceView(sourceView = {}) {
  if (sourceView.enabled === false) return false;
  const parsed = parseFeishuProjectUrl(sourceView.url || "");
  const hasContext = !!stringValue(parsed.sourceProjectKey || sourceView.sourceProjectKey)
    && !!stringValue(parsed.sourceWorkItemTypeKey || sourceView.sourceWorkItemTypeKey)
    && !!stringValue(parsed.viewId || sourceView.viewId);
  if (!hasContext) return false;
  return sourceView.url ? validateFeishuSourceViewUrl(sourceView.url).ok : true;
}

export function getFeishuSourceViews(config = {}, options = {}) {
  const cfg = getFeishuProjectSyncConfig(config);
  const sourceViews = Array.isArray(cfg.feishu?.sourceViews) ? cfg.feishu.sourceViews : [];
  if (options.includeDisabled === true || options.includeInvalid === true) {
    return sourceViews
      .filter((sourceView) => options.includeDisabled === true || sourceView.enabled !== false)
      .filter((sourceView) => options.includeInvalid === true || isUsableFeishuSourceView(sourceView))
      .map((sourceView) => ({ ...sourceView }));
  }
  return sourceViews.filter(isUsableFeishuSourceView).map((sourceView) => ({ ...sourceView }));
}

export function getFeishuSourceView(config = {}) {
  const cfg = getFeishuProjectSyncConfig(config);
  const sourceViews = Array.isArray(cfg.feishu?.sourceViews) ? cfg.feishu.sourceViews : [];
  const sourceView = sourceViews.find((view) => view.isDefault && isUsableFeishuSourceView(view))
    || sourceViews.find(isUsableFeishuSourceView)
    || sourceViews.find((view) => view.isDefault)
    || sourceViews[0]
    || cfg.feishu?.sourceView
    || {};
  const parsed = parseFeishuProjectUrl(sourceView.url || cfg.feishu?.web?.homepageUrl || "");
  return cleanObject({
    id: sourceView.id || "",
    name: sourceView.name || sourceView.label || "",
    enabled: sourceView.enabled !== false,
    isDefault: sourceView.isDefault === true,
    url: sourceView.url || parsed.url || "",
    viewId: sourceView.viewId || parsed.viewId || "",
    scope: sourceView.scope || parsed.scope || "",
    node: sourceView.node || parsed.node || "",
    sourceProjectKey: sourceView.sourceProjectKey || parsed.sourceProjectKey || cfg.feishu?.spaceKey || "",
    sourceWorkItemTypeKey: sourceView.sourceWorkItemTypeKey || parsed.sourceWorkItemTypeKey || cfg.feishu?.workItemTypeKey || "",
  });
}

export function configForFeishuSourceView(config = {}, sourceView = {}) {
  const cfg = getFeishuProjectSyncConfig(config);
  const normalized = normalizeFeishuSourceViewEntry(sourceView, {
    index: 0,
    fallbackProjectKey: cfg.feishu?.spaceKey,
    fallbackWorkItemTypeKey: cfg.feishu?.workItemTypeKey,
  });
  if (!normalized || !isUsableFeishuSourceView(normalized)) {
    throw new Error("飞书工单来源缺少有效的 URL、空间、工单类型或 View ID");
  }
  const primary = { ...normalized, enabled: true, isDefault: true };
  return getFeishuProjectSyncConfig(deepMerge(cfg, {
    feishu: {
      sourceViews: [primary],
      sourceView: sourceViewCompatibilityShape(primary),
      spaceKey: primary.sourceProjectKey,
      workItemTypeKey: primary.sourceWorkItemTypeKey,
      web: { homepageUrl: primary.url },
    },
  }));
}

export function validateFeishuSourceViewsConfig(configOrViews = {}, options = {}) {
  const rawViews = Array.isArray(configOrViews)
    ? configOrViews
    : Array.isArray(configOrViews?.feishu?.sourceViews)
      ? configOrViews.feishu.sourceViews
      : configOrViews?.feishu?.sourceView && typeof configOrViews.feishu.sourceView === "object"
        ? [{ ...configOrViews.feishu.sourceView, enabled: configOrViews.feishu.sourceView.enabled !== false, isDefault: true }]
        : [];
  const errors = [];
  const keys = new Map();
  const ids = new Map();
  let enabledCount = 0;
  rawViews.slice(0, MAX_FEISHU_SOURCE_VIEWS + 1).forEach((raw, index) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      errors.push({ code: "invalid-row", index, message: `第 ${index + 1} 个来源不是有效配置` });
      return;
    }
    const normalized = normalizeFeishuSourceViewEntry(raw, { index });
    if (raw.enabled !== false) enabledCount += 1;
    const id = stringValue(raw.id);
    const idKey = normKey(id);
    if (idKey && ids.has(idKey)) {
      errors.push({
        code: "duplicate-id",
        index,
        duplicateOf: ids.get(idKey),
        message: `第 ${index + 1} 个来源与第 ${ids.get(idKey) + 1} 个来源使用了相同 ID`,
      });
    } else if (idKey) {
      ids.set(idKey, index);
    }
    const urlValidation = validateFeishuSourceViewUrl(raw.url || "");
    if (!urlValidation.ok) {
      errors.push({ code: "invalid-url", index, message: `第 ${index + 1} 个来源：${urlValidation.error}` });
      return;
    }
    const parsed = urlValidation.parsed || {};
    const declaredProjectKey = stringValue(raw.sourceProjectKey || raw.projectKey || raw.spaceKey);
    const declaredTypeKey = stringValue(raw.sourceWorkItemTypeKey || raw.workItemTypeKey || raw.typeKey);
    const declaredViewId = stringValue(raw.viewId || raw.view_id);
    if (
      (declaredProjectKey && normKey(declaredProjectKey) !== normKey(parsed.sourceProjectKey))
      || (declaredTypeKey && normKey(declaredTypeKey) !== normKey(parsed.sourceWorkItemTypeKey))
      || (declaredViewId && normKey(declaredViewId) !== normKey(parsed.viewId))
    ) {
      errors.push({
        code: "context-mismatch",
        index,
        message: `第 ${index + 1} 个来源的空间、工单类型或 View ID 与 URL 不一致`,
      });
      return;
    }
    const key = canonicalFeishuSourceViewKey(normalized || raw);
    if (!key) {
      errors.push({ code: "missing-context", index, message: `第 ${index + 1} 个来源无法解析空间、工单类型或 View ID` });
      return;
    }
    if (keys.has(key)) {
      errors.push({
        code: "duplicate",
        index,
        duplicateOf: keys.get(key),
        message: `第 ${index + 1} 个来源与第 ${keys.get(key) + 1} 个来源重复`,
      });
      return;
    }
    keys.set(key, index);
  });
  if (rawViews.length > MAX_FEISHU_SOURCE_VIEWS) {
    errors.push({ code: "too-many", index: MAX_FEISHU_SOURCE_VIEWS, message: `飞书工单来源最多支持 ${MAX_FEISHU_SOURCE_VIEWS} 个` });
  }
  if (options.requireEnabled !== false && enabledCount < 1) {
    errors.push({ code: "no-enabled-source", index: -1, message: "至少需要启用一个飞书工单来源" });
  }
  return {
    ok: errors.length === 0,
    errors,
    enabledCount,
    total: rawViews.length,
  };
}

function assertExplicitFeishuSourceViewsConfig(config = {}) {
  const feishu = config?.feishu;
  if (!feishu || typeof feishu !== "object" || Array.isArray(feishu)) return;
  const hasSourceOverride = Object.prototype.hasOwnProperty.call(feishu, "sourceViews")
    || Object.prototype.hasOwnProperty.call(feishu, "sourceView");
  if (!hasSourceOverride) return;
  const validation = validateFeishuSourceViewsConfig(config);
  if (validation.ok) return;
  const error = new Error(validation.errors.map((item) => item.message).join("；") || "飞书工单来源配置无效");
  error.code = "FEISHU_SOURCE_VIEWS_INVALID";
  error.validation = validation;
  throw error;
}

export function normalizeFeishuSortRules(sort = []) {
  const list = Array.isArray(sort) ? sort : (sort && typeof sort === "object" ? [sort] : []);
  return list.map((rule, index) => {
    if (!rule || typeof rule !== "object") return null;
    const fieldKey = stringValue(rule.fieldKey || rule.key || rule.field || rule.column || "");
    const fieldName = stringValue(rule.fieldName || rule.name || rule.label || fieldKey);
    const directionRaw = stringValue(rule.direction || rule.order || rule.sort || "desc").toLowerCase();
    const direction = ["asc", "ascending", "1"].includes(directionRaw) ? "asc" : "desc";
    if (!fieldKey && !fieldName) return null;
    return {
      id: stringValue(rule.id) || `${fieldKey || fieldName}-${index}`,
      enabled: rule.enabled !== false,
      fieldKey,
      fieldName,
      direction,
    };
  }).filter(Boolean);
}

export function annotateFeishuSourceWorkItem(raw, sourceView = {}) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw;
  const parsed = parseFeishuProjectUrl(sourceView.url || "");
  const sourceProjectKey = stringValue(sourceView.sourceProjectKey || sourceView.projectKey || sourceView.spaceKey || parsed.sourceProjectKey);
  const sourceWorkItemTypeKey = stringValue(sourceView.sourceWorkItemTypeKey || sourceView.workItemTypeKey || sourceView.typeKey || parsed.sourceWorkItemTypeKey);
  const annotated = {
    ...raw,
    _feishuSourceView: cleanObject({
      id: sourceView.id || "",
      name: sourceView.name || sourceView.label || "",
      url: sourceView.url || parsed.url || "",
      viewId: sourceView.viewId || parsed.viewId || "",
      scope: sourceView.scope || parsed.scope || "",
      node: sourceView.node || parsed.node || "",
      sourceProjectKey,
      sourceWorkItemTypeKey,
    }),
  };
  if (!getFirst(raw, ["space_key", "spaceKey", "project_key", "projectKey", "sourceProjectKey"]) && sourceProjectKey) {
    annotated.space_key = sourceProjectKey;
  }
  if (!getFirst(raw, ["work_item_type_key", "workItemTypeKey", "type_key", "typeKey", "sourceWorkItemTypeKey"]) && sourceWorkItemTypeKey) {
    annotated.work_item_type_key = sourceWorkItemTypeKey;
  }
  return annotated;
}

export function feishuSourceWorkItemIdentity(raw, config = {}) {
  const item = raw?.sourceWorkItemId && raw?.sourceProjectKey && raw?.sourceWorkItemTypeKey
    ? raw
    : normalizeFeishuWorkItem(raw, config);
  const id = stringValue(item.sourceWorkItemId || getSourceProblemNo(item));
  if (!id) return `raw:${hashStable(raw || {})}`;
  return [
    stringValue(item.sourceProjectKey),
    stringValue(item.sourceWorkItemTypeKey),
    id,
  ].map(normKey).join(":");
}

export function mergeFeishuSourceWorkItems(sourceBatches = [], config = {}, options = {}) {
  const cfg = getFeishuProjectSyncConfig(config);
  const limit = clampLimit(options.limit, cfg.sync?.batchSize || 50, 1000);
  const rows = [];
  for (const batch of sourceBatches || []) {
    const sourceView = batch?.sourceView || {};
    for (const raw of batch?.items || []) rows.push(annotateFeishuSourceWorkItem(raw, sourceView));
  }
  const unique = uniqueRows(rows, (raw) => feishuSourceWorkItemIdentity(raw, cfg));
  const sortRules = normalizeFeishuSortRules(options.sort || options.scope?.sort || cfg.sync?.sort)
    .filter((rule) => rule.enabled !== false);
  if (sortRules.length > 0) {
    const normalized = new WeakMap();
    const itemFor = (raw) => {
      if (!raw || typeof raw !== "object") return normalizeFeishuWorkItem(raw, cfg);
      if (!normalized.has(raw)) normalized.set(raw, normalizeFeishuWorkItem(raw, cfg));
      return normalized.get(raw);
    };
    unique.sort((left, right) => compareFeishuWorkItems(itemFor(left), itemFor(right), sortRules));
  }
  return unique.slice(0, limit);
}

function compareFeishuWorkItems(left = {}, right = {}, rules = []) {
  for (const rule of rules) {
    const leftValue = feishuSortValue(left, rule);
    const rightValue = feishuSortValue(right, rule);
    const compared = compareSortValues(leftValue, rightValue);
    if (compared !== 0) return rule.direction === "asc" ? compared : -compared;
  }
  return 0;
}

function feishuSortValue(item = {}, rule = {}) {
  const key = normKey(rule.fieldKey || rule.fieldName);
  const standard = {
    id: item.sourceWorkItemId,
    workitemid: item.sourceWorkItemId,
    sourceworkitemid: item.sourceWorkItemId,
    title: item.title,
    name: item.title,
    status: item.status,
    priority: item.priority,
    severity: item.severity,
    createdat: item.createdAt,
    createdtime: item.createdAt,
    updatedat: item.updatedAt,
    updatetime: item.updatedAt,
    duedate: item.dueDate,
  };
  if (Object.prototype.hasOwnProperty.call(standard, key)) return standard[key];
  const field = (item.fields || []).find((candidate) => (
    normKey(candidate?.fieldKey || candidate?.key) === key
      || normKey(candidate?.fieldName || candidate?.name) === key
  ));
  return field ? displayValue(field.value ?? field.fieldValue ?? field) : "";
}

function compareSortValues(left, right) {
  const leftText = stringValue(left);
  const rightText = stringValue(right);
  if (!leftText && !rightText) return 0;
  if (!leftText) return 1;
  if (!rightText) return -1;
  const leftTime = Date.parse(leftText);
  const rightTime = Date.parse(rightText);
  if (Number.isFinite(leftTime) && Number.isFinite(rightTime)) return leftTime - rightTime;
  const leftNumber = Number(leftText);
  const rightNumber = Number(rightText);
  if (Number.isFinite(leftNumber) && Number.isFinite(rightNumber)) return leftNumber - rightNumber;
  return leftText.localeCompare(rightText, "zh-CN", { numeric: true, sensitivity: "base" });
}

function checkSourceScope(item, cfg) {
  if (cfg.sync?.enforceSourceScope === false) return { ok: true };
  const sourceViews = getFeishuSourceViews(cfg);
  if (!sourceViews.length) return { ok: false, reason: "no enabled Feishu source view is configured" };
  const projectMatches = sourceViews.filter((sourceView) => (
    !sourceView.sourceProjectKey || normKey(item.sourceProjectKey) === normKey(sourceView.sourceProjectKey)
  ));
  if (!projectMatches.length) {
    const expectedProjects = uniq(sourceViews.map((sourceView) => sourceView.sourceProjectKey).filter(Boolean));
    return {
      ok: false,
      reason: `out-of-scope Feishu project ${item.sourceProjectKey || "(missing)"}; expected ${expectedProjects.join(", ") || "(configured source)"}`,
    };
  }
  const typeMatches = projectMatches.filter((sourceView) => (
    !sourceView.sourceWorkItemTypeKey || normKey(item.sourceWorkItemTypeKey) === normKey(sourceView.sourceWorkItemTypeKey)
  ));
  if (typeMatches.length) return { ok: true };
  const expectedTypes = uniq(projectMatches.map((sourceView) => sourceView.sourceWorkItemTypeKey).filter(Boolean));
  return {
    ok: false,
    reason: `out-of-scope Feishu work item type ${item.sourceWorkItemTypeKey || "(missing)"}; expected ${expectedTypes.join(", ") || "(configured source)"}`,
  };
}

function checkRequiredAssigneeScope(item, cfg) {
  const readScope = normalizeFeishuReadScopeConfig({ sync: cfg.sync || {} }).sync.readScope;
  if (readScope.enabled !== false && readScope.filters.length) {
    return checkReadScopeFilters(item, readScope);
  }
  const keywords = normalizeStringList(cfg.sync?.requiredAssigneeKeywords);
  if (!keywords.length) return { ok: true };
  const assignees = Array.isArray(item.assignees) ? item.assignees : [];
  const matched = assignees.some((person) => personMatchesKeywords(person, keywords));
  if (matched) return { ok: true };
  const actual = formatPeople(assignees) || "(empty)";
  return {
    ok: false,
    reason: `assignee gate: item.assignees (${actual}) does not contain required keyword(s): ${keywords.join(", ")}`,
  };
}

function checkReadScopeFilters(item = {}, readScope = {}) {
  const filters = normalizeFeishuReadFilters(readScope.filters).filter((filter) => filter.enabled !== false);
  if (!filters.length) return { ok: true };
  const results = filters.map((filter) => ({ filter, ok: readScopeFilterMatches(item, filter) }));
  const matchAny = String(readScope.match || "all").toLowerCase() === "any";
  const passed = matchAny ? results.some((result) => result.ok) : results.every((result) => result.ok);
  if (passed) return { ok: true };
  const failed = results.filter((result) => !result.ok).map((result) => {
    const values = result.filter.values?.length ? result.filter.values.join(", ") : "(empty)";
    return `${result.filter.fieldName || result.filter.fieldKey}: ${result.filter.operatorLabel || result.filter.operator} ${values}`;
  });
  return {
    ok: false,
    reason: `read scope filter gate: ${failed.join(" / ")}`,
  };
}

function buildOutOfScopeStatus(item = {}, cfg = {}, gate = {}, existing = null, key = {}) {
  const history = findHistoricalInScopeObservation(key, cfg);
  const hasExistingMapping = !!(existing?.targetTaskId || existing?.target_task_id);
  const transitioned = hasExistingMapping || !!history;
  const gateType = scopeGateType(gate.reason);
  const currentAssignees = formatPeople(item.assignees) || "";
  const bookmark = transitioned ? "已流转" : "";
  return cleanObject({
    ok: false,
    state: transitioned ? "transferred" : "initial-out-of-scope",
    transitioned,
    bookmark,
    bookmarks: bookmark ? [bookmark] : [],
    gate: gateType,
    reason: gate.reason || "",
    message: transitioned
      ? `已流转：飞书工单当前不满足同步范围，${gate.reason || "当前规则未命中"}`
      : gate.reason || "",
    current: cleanObject({
      sourceWorkItemId: item.sourceWorkItemId,
      sourceProblemNo: getSourceProblemNo(item),
      sourceWorkItemNo: getSourceWorkItemNo(item),
      title: item.title,
      assignees: currentAssignees,
      sourceUpdatedAt: item.updatedAt,
    }),
    previous: cleanObject({
      source: hasExistingMapping ? "sync-state" : history?.source,
      targetTaskId: existing?.targetTaskId || existing?.target_task_id || "",
      targetUniqueId: existing?.targetUniqueId || existing?.target_unique_id || "",
      lastSyncedAt: existing?.lastSyncedAt || existing?.last_synced_at || "",
      capturedAt: history?.capturedAt || "",
      assignees: history?.assignees || "",
    }),
  });
}

function findHistoricalInScopeObservation(key = {}, cfg = {}) {
  const rows = listFeishuProjectRawPayloads({
    projectKey: key.sourceProjectKey || key.projectKey || "",
    typeKey: key.sourceWorkItemTypeKey || key.typeKey || "",
    workItemId: key.sourceWorkItemId || key.workItemId || "",
    limit: 50,
  });
  for (const row of rows || []) {
    if (!row?.payloadJson) continue;
    try {
      const raw = JSON.parse(row.payloadJson);
      const item = normalizeFeishuWorkItem(raw, cfg);
      if (!checkSourceScope(item, cfg).ok) continue;
      if (!checkRequiredAssigneeScope(item, cfg).ok) continue;
      return {
        source: "raw-payload",
        capturedAt: row.capturedAt || row.captured_at || "",
        assignees: formatPeople(item.assignees) || "",
      };
    } catch {}
  }
  return null;
}

function scopeGateType(reason = "") {
  const text = stringValue(reason);
  if (/read scope filter gate/i.test(text)) return "read-scope";
  if (/assignee gate/i.test(text)) return "assignee";
  if (/out-of-scope/i.test(text)) return "source-scope";
  return "scope";
}

function persistOutOfScopeObservation({ item, key, sourceIdentity, payloadHash, raw, existing, scopeStatus, options } = {}) {
  if (options?.dryRun) return;
  insertFeishuProjectRawPayload({ ...key, payloadHash, payloadJson: raw });
  const targetTaskId = existing?.targetTaskId || existing?.target_task_id || "";
  if (!targetTaskId) return;
  upsertFeishuProjectSyncState({
    ...key,
    ...sourceIdentity,
    sourceWorkItemUrl: item.sourceWorkItemUrl,
    targetTaskId,
    targetUniqueId: existing?.targetUniqueId || existing?.target_unique_id || "",
    sourceUpdatedAt: item.updatedAt,
    targetUpdatedAt: existing?.targetUpdatedAt || existing?.target_updated_at || "",
    lastSyncedAt: existing?.lastSyncedAt || existing?.last_synced_at || "",
    sourcePayloadHash: payloadHash,
    commentsHash: existing?.commentsHash || existing?.comments_hash || "",
    attachmentsHash: existing?.attachmentsHash || existing?.attachments_hash || "",
    syncStatus: existing?.syncStatus || existing?.sync_status || "success",
    lastError: existing?.lastError || existing?.last_error || "",
  });
}

function readScopeFilterMatches(item = {}, filter = {}) {
  const values = normalizeStringList(filter.values || filter.optionValues || filter.value);
  const operator = normKey(filter.operator || "containsAny");
  const fields = findItemFieldsForFilter(item, filter);
  const tokens = uniq(fields.flatMap((field) => fieldValueTokens(field.value, field.displayValue)));
  if (["exists", "notempty", "isnotempty"].includes(operator)) return tokens.length > 0;
  if (["empty", "isempty"].includes(operator)) return tokens.length === 0;
  if (!values.length) return true;
  const matched = values.some((expected) => tokenListContains(tokens, expected));
  if (["notcontainsany", "notin", "notbelongs"].includes(operator)) return !matched;
  return matched;
}

function findItemFieldsForFilter(item = {}, filter = {}) {
  const expectedKeys = [filter.fieldKey, filter.roleId, filter.key].map(normKey).filter(Boolean);
  const expectedNames = [filter.fieldName, filter.roleName, filter.name].map(normKey).filter(Boolean);
  const expectedAliases = uniq([...expectedKeys, ...expectedNames]);
  if (!expectedAliases.length) return [];
  const ranked = (item.fields || []).map((field, index) => {
    const fieldKeys = [field.key, field.metadata?.key, field.field_key].map(normKey).filter(Boolean);
    const fieldNames = [field.name, field.metadata?.name, field.field_name].map(normKey).filter(Boolean);
    const fieldAliases = uniq([...fieldKeys, ...fieldNames]);
    let rank = 0;
    if (expectedKeys.length && fieldKeys.some((value) => expectedKeys.includes(value))) rank = 1;
    else if (expectedNames.length && fieldNames.some((value) => expectedNames.includes(value))) rank = 2;
    else if (fieldAliases.some((value) => expectedAliases.includes(value))) rank = 3;
    else if (fieldAliases.some((value) => expectedAliases.some((expected) => expected && value.includes(expected)))) rank = 4;
    return rank ? { field, index, rank } : null;
  }).filter(Boolean);
  if (!ranked.length) return [];
  const bestRank = Math.min(...ranked.map((entry) => entry.rank));
  return ranked.filter((entry) => entry.rank === bestRank).sort((a, b) => a.index - b.index).map((entry) => entry.field);
}

function fieldValueTokens(value, display = "") {
  const out = [];
  const visit = (v) => {
    if (v == null || v === "") return;
    if (Array.isArray(v)) {
      for (const item of v) visit(item);
      return;
    }
    if (typeof v === "object") {
      for (const key of DISPLAY_VALUE_KEYS) {
        const nested = getCaseInsensitive(v, key);
        if (nested !== null && nested !== undefined && nested !== v) visit(nested);
      }
      for (const key of ["user_key", "userKey", "email", "employee_id", "employeeId", "id", "key", "value"]) {
        const nested = getCaseInsensitive(v, key);
        if (nested !== null && nested !== undefined && nested !== v) visit(nested);
      }
      return;
    }
    const text = stringValue(v);
    if (text) out.push(text);
  };
  visit(value);
  visit(display);
  return uniq(out);
}

function tokenListContains(tokens = [], expected = "") {
  const raw = stringValue(expected);
  if (!raw) return false;
  const normalized = normKey(raw);
  return tokens.some((token) => {
    const text = stringValue(token);
    return text.includes(raw) || normKey(text).includes(normalized);
  });
}

function normalizeFeishuReadFilters(filters = []) {
  const list = Array.isArray(filters) ? filters : [];
  return list.map((filter, index) => {
    if (!filter || typeof filter !== "object") return null;
    const values = normalizeStringList(filter.values || filter.optionValues || filter.value);
    const fieldKey = stringValue(filter.fieldKey || filter.key || filter.roleId || "");
    const fieldName = stringValue(filter.fieldName || filter.name || filter.roleName || fieldKey);
    if (!fieldKey && !fieldName) return null;
    return {
      id: stringValue(filter.id) || `${fieldKey || fieldName}-${index}`,
      enabled: filter.enabled !== false,
      kind: stringValue(filter.kind || (String(fieldKey).startsWith("role_") ? "role" : "field")) || "field",
      fieldKey,
      fieldName,
      operator: stringValue(filter.operator || "containsAny"),
      operatorLabel: stringValue(filter.operatorLabel || (filter.operator === "equals" ? "等于" : "存在选项属于")),
      values,
    };
  }).filter(Boolean);
}

function isProblemOwnerRoleFilter(filter = {}) {
  return normKey(filter.fieldKey) === normKey(DEFAULT_FEISHU_OWNER_ROLE_FILTER.fieldKey)
    || normKey(filter.fieldName) === normKey(DEFAULT_FEISHU_OWNER_ROLE_FILTER.fieldName);
}

function personMatchesKeywords(person, keywords = []) {
  const text = [
    person?.name,
    person?.userKey,
    person?.email,
    person?.employeeId,
    person?.phone,
    person?.id,
  ].filter(Boolean).join(" ");
  const normalizedText = normKey(text);
  return keywords.some((keyword) => {
    const rawKeyword = String(keyword || "").trim();
    if (!rawKeyword) return false;
    return text.includes(rawKeyword) || normalizedText.includes(normKey(rawKeyword));
  });
}

function payloadForSyncAction(payload, action, options = {}, preservedUserFields = {}) {
  let actionPayload = payload;
  if (action === "update" && preservedUserFields?.sprintId) {
    actionPayload = { ...actionPayload };
    delete actionPayload.sprintId;
  }
  if (action === "update" && preservedUserFields?.defectCategory) {
    const defectFieldId = stringValue(preservedUserFields.defectCategoryCustomFieldId);
    const fields = Array.isArray(actionPayload.customfields) ? actionPayload.customfields : [];
    const filtered = fields.filter((field) => (
      !defectFieldId || stringValue(field?.customfieldId || field?.customFieldId || field?.id) !== defectFieldId
    ));
    if (filtered.length !== fields.length) {
      if (actionPayload === payload) actionPayload = { ...actionPayload };
      if (filtered.length) actionPayload.customfields = filtered;
      else delete actionPayload.customfields;
    }
  }
  if (action !== "create") return actionPayload;
  const now = options.now instanceof Date
    ? options.now
    : options.now
      ? new Date(options.now)
      : new Date();
  const startDate = Number.isNaN(now.getTime()) ? new Date().toISOString() : now.toISOString();
  const result = { ...actionPayload, startDate };
  if (actionPayload.dueDate) {
    const due = new Date(actionPayload.dueDate);
    if (!Number.isNaN(due.getTime()) && due.getTime() >= new Date(startDate).getTime()) {
      return result;
    }
  }
  result.dueDate = addDaysIso(startDate, 3);
  return result;
}

function payloadForResolvedSyncAction(payload, action, options = {}, preservedUserFields = {}, policyDecision = {}) {
  const compatiblePayload = payloadForSyncAction(payload, action, options, preservedUserFields);
  return applySyncPayloadStrategy(compatiblePayload, action, policyDecision);
}

function payloadForPolicyAction(payload, managedUpdatePayload, action, options = {}, preservedUserFields = {}, policyDecision = {}) {
  const policySource = action === "create" ? payload : managedUpdatePayload;
  return payloadForResolvedSyncAction(policySource, action, options, preservedUserFields, policyDecision);
}

function mergeExistingTargetTagsForPolicy(payload = {}, targetFieldVerification = {}, policyDecision = {}) {
  const tagPolicy = policyDecision?.strategy?.fields?.tags || {};
  if (tagPolicy.enabled === false || tagPolicy.mode !== "merge" || !Array.isArray(payload.tagIds)) {
    return { payload, changed: false };
  }
  const existingTagIds = normalizeTargetListValue(targetFieldVerification?.task?.tagIds);
  if (!existingTagIds.length) return { payload, changed: false };
  const mergedTagIds = uniq([...existingTagIds, ...normalizeStringList(payload.tagIds)]);
  if (mergedTagIds.length === payload.tagIds.length && mergedTagIds.every((id, index) => id === payload.tagIds[index])) {
    return { payload, changed: false };
  }
  return { payload: { ...payload, tagIds: mergedTagIds }, changed: true };
}

async function syncTargetTaskDates(targetTaskId, payload, loader, cfg, options = {}) {
  if (cfg.sync?.ensureStartDate === false || !targetTaskId || !loader?.updateTask || !loader?.getTaskDetail) return [];
  const dueDate = dateValue(payload?.dueDate);
  let detail = null;
  try {
    detail = await loader.getTaskDetail(targetTaskId, cfg);
  } catch (err) {
    return [scheduleWarning("read-target-failed", `Unable to read TB task dates: ${err?.message || String(err)}`)];
  }
  const currentStartDate = dateValue(detail?.startDate || detail?.start_date);
  const currentDueDate = dateValue(detail?.dueDate || detail?.due_date);
  const fallbackNow = options.now instanceof Date ? options.now.toISOString() : dateValue(options.now);
  const targetStartDate = dateValue(payload?.startDate)
    || currentStartDate
    || dateValue(detail?.created || detail?.createdAt || detail?.created_at)
    || fallbackNow
    || new Date().toISOString();
  if (!targetStartDate) return [];
  if (currentStartDate && sameDateInstant(currentStartDate, targetStartDate) && (!dueDate || sameDateInstant(currentDueDate, dueDate))) return [];

  const updatePayload = cleanObject({
    startDate: targetStartDate,
    dueDate,
  });
  if (!updatePayload.startDate && !updatePayload.dueDate) return [];

  if (dueDate && isDateBefore(dueDate, targetStartDate)) {
    const msg = `TB startDate ${targetStartDate} is later than dueDate ${dueDate}; Teambition rejects this date combination.`;
    log("system", "warn", "feishu-project-sync", msg);
    return [scheduleWarning("due-before-start", msg, { startDate: targetStartDate, dueDate })];
  }

  try {
    await loader.updateTask(targetTaskId, updatePayload, cfg);
    return [];
  } catch (err) {
    const message = err?.message || String(err);
    if (/开始时间必须早于截止时间|start.*before.*due|due.*after.*start/i.test(message)) {
      log("system", "warn", "feishu-project-sync", `TB rejected startDate sync for ${targetTaskId}: ${message}`);
      if (dueDate) {
        await loader.updateTask(targetTaskId, { dueDate }, cfg).catch(() => null);
      }
      return [scheduleWarning("due-before-start", message, { startDate: targetStartDate, dueDate })];
    }
    log("system", "warn", "feishu-project-sync", `TB date sync failed for ${targetTaskId}: ${message}`);
    return [scheduleWarning("date-sync-failed", message, { startDate: targetStartDate, dueDate })];
  }
}

function scheduleWarning(code, message, extra = {}) {
  return cleanObject({ stage: "schedule", code, message, ...extra });
}

function isDateBefore(left, right) {
  const a = new Date(left);
  const b = new Date(right);
  return !Number.isNaN(a.getTime()) && !Number.isNaN(b.getTime()) && a.getTime() < b.getTime();
}

function sameDateInstant(left, right) {
  if (!left && !right) return true;
  const a = new Date(left);
  const b = new Date(right);
  if (Number.isNaN(a.getTime()) || Number.isNaN(b.getTime())) return String(left || "") === String(right || "");
  return a.getTime() === b.getTime();
}

function syncProgress(options = {}, event = {}) {
  if (typeof options.onProgress !== "function") return;
  const item = event.item || {};
  try {
    options.onProgress({
      ...event,
      item: undefined,
      workItemId: event.workItemId || item.sourceWorkItemId || item.work_item_id || item.id || "",
      title: event.title || item.title || "",
    });
  } catch {}
}

function shouldVerifyExistingTarget(options = {}, cfg = {}) {
  const explicit = options.verifyExistingTarget
    ?? options.verifyTargetExists
    ?? options.verifyTargets
    ?? options.scope?.verifyExistingTarget
    ?? options.scope?.verifyTargets
    ?? cfg.sync?.verifyExistingTarget;
  return parseBooleanOption(explicit, true);
}

function shouldResetMissingExistingTarget(options = {}, cfg = {}) {
  if (options.dryRun) return false;
  const explicit = options.resetMissingTarget
    ?? options.resetMissingTargets
    ?? options.scope?.resetMissingTarget
    ?? options.scope?.resetMissingTargets
    ?? cfg.sync?.resetMissingTargets;
  return parseBooleanOption(explicit, true);
}

function normalizeTargetExistenceCheck(checked, targetTaskId = "") {
  if (checked === false) {
    return { checked: true, exists: false, targetTaskId };
  }
  if (checked === true) {
    return { checked: true, exists: true, targetTaskId };
  }
  return cleanObject({
    checked: true,
    exists: checked?.exists !== false,
    targetTaskId,
    source: checked?.source,
    status: checked?.status,
    reason: checked?.reason,
    task: checked?.task,
  });
}

async function checkTargetExists(loader, targetTaskId, cfg) {
  if (!targetTaskId) return { checked: false, exists: false, reason: "missing-target-id" };
  if (loader?.checkTaskExists) {
    return normalizeTargetExistenceCheck(await loader.checkTaskExists(targetTaskId, cfg), targetTaskId);
  }
  if (loader?.getTaskDetail) {
    return normalizeTargetExistenceCheck({ exists: !!(await loader.getTaskDetail(targetTaskId, cfg)), source: "detail" }, targetTaskId);
  }
  return { checked: false, exists: true, targetTaskId, reason: "loader-missing-target-check" };
}

async function verifyExistingTargetForWorkItem(key, existing, loader, cfg, options = {}) {
  const targetTaskId = existing?.targetTaskId || existing?.target_task_id || "";
  if (!targetTaskId || !shouldVerifyExistingTarget(options, cfg)) {
    return { existing, missing: false, info: null };
  }
  try {
    const info = await checkTargetExists(loader, targetTaskId, cfg);
    if (!info.checked || info.exists !== false) {
      return { existing, missing: false, info };
    }
    const shouldReset = shouldResetMissingExistingTarget(options, cfg);
    const deferReset = shouldReset && !!options.expectedPreparedFingerprint;
    const reset = shouldReset && !deferReset
      ? resetFeishuProjectSyncTarget(key, { targetTaskId, syncStatus: "pending", lastError: "" })
      : null;
    return {
      existing: null,
      missing: true,
      info: cleanObject({ ...info, reset: reset ? reset.changes : undefined }),
      deferredReset: deferReset ? { key: { ...key }, targetTaskId } : null,
    };
  } catch (err) {
    return {
      existing,
      missing: false,
      info: cleanObject({ checked: false, exists: true, targetTaskId, error: err?.message || String(err) }),
    };
  }
}

function shouldVerifyExistingTargetFields(options = {}, cfg = {}) {
  const explicit = options.verifyExistingTargetFields
    ?? options.verifyTargetFields
    ?? options.scope?.verifyExistingTargetFields
    ?? options.scope?.verifyTargetFields
    ?? cfg.sync?.verifyExistingTargetFields
    ?? cfg.sync?.verifyTargetFields;
  return parseBooleanOption(explicit, true);
}

const TARGET_FIELD_KEY_MAP = {
  content: ["content", "title", "name"],
  note: ["note", "description", "desc", "detail"],
  startDate: ["startDate", "start_date", "startTime", "start_time", "beginDate", "begin_date", "beginTime", "begin_time"],
  dueDate: ["dueDate", "due_date", "deadline", "dueTime", "due_time", "endDate", "end_date", "endTime", "end_time", "finishTime", "finish_time"],
  priority: ["priority", "_priority", "priorityId", "priority_id", "priority.value"],
  projectId: ["projectId", "_projectId", "project._id", "project.id", "project.projectId"],
  tasklistId: ["tasklistId", "_tasklistId", "tasklist._id", "tasklist.id", "tasklist.tasklistId"],
  stageId: ["stageId", "_stageId", "stage._id", "stage.id"],
  sprintId: ["sprintId", "_sprintId", "sprint._id", "sprint.id", "sprint.sprintId"],
  executorId: ["executorId", "_executorId", "executor._id", "executor.id", "executor.userId"],
  involveMembers: ["involveMembers", "_involveMembers", "_involveMemberIds", "involveMemberIds"],
  taskflowstatusId: ["taskflowstatusId", "_taskflowstatusId", "taskflowstatus._id", "taskflowstatus.id", "statusId"],
  scenariofieldconfigId: [
    "scenariofieldconfigId",
    "_scenariofieldconfigId",
    "scenarioFieldConfigId",
    "_scenarioFieldConfigId",
    "scenariofieldconfig._id",
    "scenariofieldconfig.id",
    "scenarioFieldConfig._id",
    "scenarioFieldConfig.id",
    "taskType._id",
    "taskType.id",
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
  ],
  applicationCategory: ["applicationCategory", "application_category"],
  defectCategory: ["defectCategory", "defect_category"],
};

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

const DEFECT_DESCRIPTION_FIELD_KEYS = [
  "field_ee70e6",
  "defect_description",
  "defectDescription",
  "bug_description",
  "bugDescription",
  "\u7f3a\u9677\u63cf\u8ff0",
  "\u95ee\u9898\u63cf\u8ff0",
];

const TARGET_TASK_SNAPSHOT_FIELD_MAP = TARGET_FIELD_KEY_MAP;

const TARGET_FIELD_DISPLAY_KEY_MAP = {
  content: ["content", "title", "name"],
  note: ["note", "description", "desc", "detail"],
  startDate: ["startDate", "start_date", "startTime", "start_time", "beginDate", "begin_date", "beginTime", "begin_time"],
  dueDate: ["dueDate", "due_date", "deadline", "dueTime", "due_time", "endDate", "end_date", "endTime", "end_time", "finishTime", "finish_time"],
  priority: ["priority.label", "priority.name", "priority.title", "priority", "_priority"],
  projectId: ["project.name", "project.title", "projectName", "project"],
  tasklistId: ["tasklist.title", "tasklist.name", "tasklistName", "tasklist.pathName", "tasklist"],
  stageId: ["stage.name", "stage.title", "stageName", "stage"],
  sprintId: ["sprint.name", "sprint.title", "sprintName", "sprint"],
  executorId: ["executor.name", "executor.nick", "executor.displayName", "executor.username", "executorName", "executor"],
  involveMembers: ["involveMembers", "_involveMembers", "_involveMemberIds", "involveMemberIds"],
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
  ],
  tagIds: ["tags", "tagList", "tagObjects", "labels", "_tags", "tagIds", "_tagIds", "tag_ids"],
  applicationCategory: ["applicationCategoryDisplay", "applicationCategory"],
  defectCategory: ["defectCategoryDisplay", "defectCategory"],
};

const TEAMBITION_PRIORITY_DISPLAY_NAMES = {
  0: "\u666e\u901a",
  1: "\u7d27\u6025",
  2: "\u975e\u5e38\u7d27\u6025",
  "-10": "\u8f83\u4f4e",
};

const TEAMBITION_TASKLIST_DISPLAY_NAMES = {
  [DEFAULT_TB_TARGET_TASKLIST_ID]: DEFAULT_TB_TARGET_TASKLIST_NAME,
  ...Object.fromEntries((DEFAULT_SYNC_ROUTING.targets || [])
    .map((target) => [target?.config?.tasklistId, target?.config?.tasklistName])
    .filter(([id, name]) => id && name)),
};

const TEAMBITION_TASKLIST_PROJECT_PATH_NAMES = {
  [DEFAULT_TB_TARGET_TASKLIST_ID]: DEFAULT_TB_TARGET_PROJECT_PATH_NAME,
  ...Object.fromEntries((DEFAULT_SYNC_ROUTING.targets || [])
    .map((target) => [target?.config?.tasklistId, target?.config?.projectPathName])
    .filter(([id, name]) => id && name)),
};

const TEAMBITION_SPRINT_DISPLAY_NAMES = {
  [DEFAULT_TB_TARGET_SPRINT_ID]: DEFAULT_TB_TARGET_SPRINT_NAME,
  ...Object.fromEntries((DEFAULT_SYNC_ROUTING.targets || [])
    .map((target) => [target?.config?.sprintId, target?.config?.sprintName])
    .filter(([id, name]) => id && name)),
};

const TEAMBITION_MEMBER_DISPLAY_NAMES = {
  [DEFAULT_TB_EXECUTOR_ID]: DEFAULT_TB_EXECUTOR_NAME,
};

const TARGET_COMPARISON_FIELD_KEYS = [
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
  "severity",
  "version",
  "reproductionProbability",
  "tagIds",
];

const TARGET_CATEGORY_CUSTOM_FIELD_NAME_MAP = {
  applicationCategory: ["应用分类", "应用类别", "应用类型"],
  defectCategory: ["缺陷分类", "缺陷类别", "缺陷类型", "Bug分类", "BUG分类", "Bug类型", "BUG类型", "问题分类", "问题类型"],
};

const TARGET_AUTO_CUSTOM_FIELD_NAME_MAP = {
  severity: ["严重程度", "严重度"],
  version: ["版本号"],
  reproductionProbability: ["复现概率", "发生概率"],
};

const TARGET_NAMED_CUSTOM_FIELD_NAME_MAP = {
  ...TARGET_CATEGORY_CUSTOM_FIELD_NAME_MAP,
  ...TARGET_AUTO_CUSTOM_FIELD_NAME_MAP,
};

const SOURCE_FIELDS_BY_TARGET_FIELD = {
  content: ["title", "name", "summary", "auto_number", "系统单号"],
  note: [...DEFECT_DESCRIPTION_FIELD_KEYS, "description", "desc"],
  executorId: ["assignee", "assignees", "处理人", "负责人"],
  involveMembers: ["assignee", "assignees", "reporter", "报告人", "创建人"],
  priority: ["priority", "优先级"],
  taskflowstatusId: ["status", "状态"],
  applicationCategory: ["field_95a8a4", "function_module", "functionModule", "module", "功能模块"],
  projectId: ["field_95a8a4", "function_module", "functionModule", "module", "功能模块"],
  tasklistId: ["field_95a8a4", "function_module", "functionModule", "module", "功能模块"],
  sprintId: ["field_95a8a4", "function_module", "functionModule", "module", "功能模块"],
  defectCategory: ["category", "defect_category", "defectCategory", "缺陷分类"],
  severity: ["field_5a215d", "severity", "严重程度", "严重度"],
  version: ["field_5d5056", "软件版本", "版本号"],
  reproductionProbability: ["field_be6bf1", "发生概率", "复现概率"],
};

const TARGET_CATEGORY_FIELD_KEYS = ["applicationCategory", "defectCategory"];
const TARGET_NAMED_CUSTOM_FIELD_KEYS = [...TARGET_CATEGORY_FIELD_KEYS, "severity", "version", "reproductionProbability"];

async function verifyExistingTargetFields(targetTaskId, payload = {}, loader, cfg = {}, options = {}, targetInfo = null) {
  if (!targetTaskId || !shouldVerifyExistingTargetFields(options, cfg)) {
    return { checked: false, mismatch: false };
  }

  let task = targetInfo?.task || null;
  if (loader?.getTaskDetail) {
    try {
      const detail = await loader.getTaskDetail(targetTaskId, cfg);
      if (detail && typeof detail === "object") {
        task = task && typeof task === "object" ? mergeTaskDetail(detail, task) : detail;
      }
    } catch (err) {
      if (!task) {
        return cleanObject({
          checked: false,
          mismatch: false,
          reason: "read-target-failed",
          error: err?.message || String(err),
        });
      }
    }
  }

  if (!task || typeof task !== "object") {
    return { checked: false, mismatch: false, reason: "target-detail-unavailable" };
  }

  const noteRead = await enrichTargetTaskNote(task, targetTaskId, payload, loader, cfg);
  if (loader) await enrichTargetTaskDisplayContext(task, payload, loader, cfg);
  enrichTargetCategoryCustomFields(task, payload, cfg);
  const notePrevious = targetTaskNoteText(task.noteMarkdown || task.noteDisplay || task.note)
    || targetTaskNoteText(readTargetFieldValue(task, TARGET_FIELD_KEY_MAP.note))
    || targetTaskNoteText({ html: task.noteHtml });

  const compared = [];
  const mismatches = [];
  for (const [field, keys] of Object.entries(TARGET_FIELD_KEY_MAP)) {
    const expected = normalizeTargetCompareValue(field, payload[field]);
    if (!expected) continue;
    let actual = normalizeTargetCompareValue(field, readTargetFieldValue(task, keys));
    // 对于 note 字段，如果 normalizeTargetCompareValue 返回空（例如 task.note 是 RTF 数组无法直接用 stringValue 提取），
    // 尝试用 targetTaskNoteText 从原始 task 数据中提取可读文本
    if (!actual && field === "note") {
      const rawNoteValue = readTargetFieldValue(task, TARGET_FIELD_KEY_MAP.note);
      const noteText = targetTaskNoteText(rawNoteValue);
      if (noteText) actual = normalizeTargetCompareValue(field, noteText);
    }
    if (!actual) {
      if (field === "note" && noteRead?.attempted && noteRead.ok !== false) {
        compared.push(field);
        mismatches.push({ field, expected, actual: "", actualDisplay: "空", expectedDisplay: payload[field] });
      }
      continue;
    }
    compared.push(field);
    if (!sameTargetCompareValue(field, actual, expected)) {
      const actualDisplay = await readTargetFieldDisplay(task, field, actual, payload, loader, cfg);
      const expectedDisplay = await readPayloadFieldDisplay(field, payload[field], payload, loader, cfg);
      mismatches.push(cleanObject({ field, expected, actual, actualDisplay, expectedDisplay }));
    }
  }

  for (const fieldKey of TARGET_NAMED_CUSTOM_FIELD_KEYS) {
    const fieldId = stringValue(cfg.teambition?.[`${fieldKey}CustomFieldId`]);
    const expected = plannedCategoryCustomFieldValue(fieldKey, payload, cfg, fieldId);
    if (!expected) continue;
    const currentSnapshot = targetCategoryCustomFieldSnapshot(task, fieldId, fieldKey);
    if (!currentSnapshot.present) continue;
    const actual = currentSnapshot.raw ?? currentSnapshot.display ?? "";
    compared.push(fieldKey);
    const actualDisplay = currentSnapshot.display || displayValue(actual);
    const expectedDisplay = expected;
    if (!sameTargetCompareValue(fieldKey, normalizeTargetCompareValue(fieldKey, actual), normalizeTargetCompareValue(fieldKey, expected))) {
      mismatches.push(cleanObject({ field: fieldKey, expected, actual, actualDisplay, expectedDisplay }));
    }
  }

  return cleanObject({
    checked: compared.length > 0,
    mismatch: mismatches.length > 0,
    compared,
    mismatches,
    targetTaskId,
    notePrevious,
    task: summarizeTargetTaskForDisplay(task),
    noteRead,
  });
}

async function verifyWrittenTargetFields(targetTaskId, payload = {}, loader, cfg = {}, options = {}) {
  if (!targetTaskId || loader?.enforceWrittenFieldVerification !== true || cfg.sync?.verifyWrittenTargetFields === false) {
    return { checked: false, mismatch: false };
  }
  if (typeof loader?.getTaskDetail !== "function") {
    return { checked: false, mismatch: false, reason: "target-detail-unavailable" };
  }
  const expectedTagIds = normalizeStringList(payload.tagIds);
  const expectedCustomfields = (Array.isArray(payload.customfields) ? payload.customfields : []).map((field) => ({
    customfieldId: stringValue(field?.customfieldId || field?.customFieldId || field?.cfId || field?.id),
    values: targetCustomFieldReadableParts(field?.value).map(normKey).filter(Boolean),
  })).filter((field) => field.customfieldId && field.values.length);
  if (!expectedTagIds.length && !expectedCustomfields.length) return { checked: false, mismatch: false, reason: "no-supplemental-fields" };

  const attempts = Math.max(1, Number(options.postWriteVerifyAttempts ?? cfg.sync?.postWriteVerifyAttempts ?? 3) || 3);
  const delayMs = Math.max(0, Number(options.postWriteVerifyDelayMs ?? cfg.sync?.postWriteVerifyDelayMs ?? 250) || 0);
  let last = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const task = await loader.getTaskDetail(targetTaskId, cfg);
    const mismatches = [];
    if (expectedTagIds.length) {
      const actualTagIds = normalizeTargetListValue(readTargetFieldValue(task || {}, TARGET_FIELD_KEY_MAP.tagIds));
      const missing = expectedTagIds.filter((id) => !actualTagIds.includes(id));
      if (missing.length) mismatches.push({ field: "tagIds", expected: expectedTagIds, actual: actualTagIds, missing });
    }
    if (expectedCustomfields.length) {
      const actualFields = targetCustomFieldEntries(readTargetFieldValue(task || {}, TARGET_FIELD_KEY_MAP.customfields));
      for (const expected of expectedCustomfields) {
        const actual = actualFields.find((field) => readTargetCustomFieldId(field) === expected.customfieldId);
        const actualValues = actual
          ? targetCustomFieldReadableParts(readTargetCustomFieldPath(actual, TARGET_CUSTOM_FIELD_VALUE_PATHS)).map(normKey).filter(Boolean)
          : [];
        const missing = expected.values.filter((value) => !actualValues.includes(value));
        if (missing.length) mismatches.push({
          field: "customfield",
          customfieldId: expected.customfieldId,
          expected: expected.values,
          actual: actualValues,
          missing,
        });
      }
    }
    last = { checked: true, mismatch: mismatches.length > 0, attempt, attempts, mismatches };
    if (!mismatches.length) return last;
    if (attempt < attempts && delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  const summary = (last?.mismatches || []).map((row) => (
    row.field === "tagIds" ? `标签缺少 ${row.missing.join(",")}` : `自定义字段 ${row.customfieldId} 缺少 ${row.missing.join(",")}`
  )).join("；");
  const error = new Error(`TB 字段写后回读不一致：${summary || "字段未真实落库"}`);
  error.code = "TARGET_FIELD_WRITE_MISMATCH";
  error.failures = [{ stage: "target-field-verify", targetTaskId, error: error.message, verification: last }];
  throw error;
}

function preserveExistingTargetUserFields(payload = {}, payloadDisplay = {}, targetFieldVerification = {}, cfg = {}) {
  const targetTask = targetFieldVerification?.task || {};
  let nextPayload = payload;
  let nextPayloadDisplay = payloadDisplay;
  const preserved = {};
  for (const field of ["executorId", "startDate", "dueDate", "sprintId"]) {
    if (!hasValue(payload?.[field]) || !hasValue(targetTask?.[field])) continue;
    const currentValue = field === "executorId"
      ? stringValue(targetTask[field])
      : (dateValue(targetTask[field]) || stringValue(targetTask[field]));
    if (!currentValue) continue;
    const currentComparable = normalizeTargetCompareValue(field, currentValue);
    const plannedComparable = normalizeTargetCompareValue(field, payload[field]);
    const same = sameTargetCompareValue(field, currentComparable, plannedComparable);
    if (field === "sprintId") {
      const currentDisplay = stringValue(targetTask.sprintIdDisplay || targetTask.sprintName);
      if (currentDisplay && payloadDisplay?.sprintIdDisplay !== currentDisplay) {
        if (nextPayloadDisplay === payloadDisplay) nextPayloadDisplay = { ...payloadDisplay };
        nextPayloadDisplay.sprintIdDisplay = currentDisplay;
      }
      preserved[field] = currentValue;
    }
    if (same) continue;
    if (nextPayload === payload) nextPayload = { ...payload };
    nextPayload[field] = currentValue;
    preserved[field] = currentValue;
  }

  const defectFieldId = stringValue(cfg.teambition?.defectCategoryCustomFieldId);
  const currentDefect = targetCategoryCustomFieldSnapshot(targetTask, defectFieldId, "defectCategory");
  const currentDefectDisplay = stringValue(currentDefect.display || displayValue(currentDefect.raw));
  const currentDefectFieldId = stringValue(currentDefect.customFieldId || defectFieldId);
  if (currentDefect.present && currentDefectDisplay) {
    const plannedDefectDisplay = stringValue(payloadDisplay?.defectCategory);
    const plannedFields = Array.isArray(nextPayload.customfields) ? nextPayload.customfields : [];
    const hasPlannedDefectField = !!currentDefectFieldId && plannedFields.some((field) => (
      stringValue(field?.customfieldId || field?.customFieldId || field?.id) === currentDefectFieldId
    ));
    if (plannedDefectDisplay !== currentDefectDisplay || hasPlannedDefectField) {
      if (nextPayload === payload) nextPayload = { ...payload };
      if (hasPlannedDefectField) {
        nextPayload.customfields = plannedFields.map((field) => {
          const id = stringValue(field?.customfieldId || field?.customFieldId || field?.id);
          return id === currentDefectFieldId ? { ...field, value: currentDefectDisplay } : field;
        });
      }
      if (nextPayloadDisplay === payloadDisplay) nextPayloadDisplay = { ...payloadDisplay };
      nextPayloadDisplay.defectCategory = currentDefectDisplay;
      if (currentDefectFieldId) nextPayloadDisplay.defectCategoryCustomFieldId = currentDefectFieldId;
      preserved.defectCategory = currentDefectDisplay;
      preserved.defectCategoryCustomFieldId = currentDefectFieldId;
    }
  }
  return {
    payload: nextPayload,
    payloadDisplay: nextPayloadDisplay,
    changed: nextPayload !== payload || nextPayloadDisplay !== payloadDisplay,
    preserved,
  };
}

async function enrichTargetTaskNote(task = {}, targetTaskId = "", payload = {}, loader = null, cfg = {}) {
  if (!task || typeof task !== "object") return { attempted: false, skipped: true, reason: "target-task-unavailable" };
  if (!targetTaskId) return { attempted: false, skipped: true, reason: "target-task-id-empty" };
  if (!payload?.note) return { attempted: false, skipped: true, reason: "payload-note-empty" };
  if (!loader?.getTaskNote) return { attempted: false, skipped: true, reason: "loader-getTaskNote-unavailable" };
  try {
    const note = await loader.getTaskNote(targetTaskId, cfg);
    if (note && typeof note === "object" && note.ok === false) {
      return cleanObject({
        attempted: true,
        ok: false,
        reason: "loader-returned-not-ok",
        error: note.error || note.message || "",
      });
    }
    const markdown = targetTaskNoteText(note);
    const info = cleanObject({
      attempted: true,
      ok: true,
      renderMode: stringValue(note?.renderMode),
      markdownLength: markdown.length,
      htmlLength: stringValue(note?.html).length,
      imageCount: Array.isArray(note?.images) ? note.images.length : undefined,
      linkCount: Array.isArray(note?.links) ? note.links.length : undefined,
      empty: !markdown,
    });
    if (!markdown) return info;
    task.note = markdown;
    task.noteDisplay = markdown;
    task.noteMarkdown = markdown;
    task.noteRenderMode = stringValue(note?.renderMode);
    if (stringValue(note?.html)) task.noteHtml = stringValue(note.html);
    return info;
  } catch (err) {
    return cleanObject({
      attempted: true,
      ok: false,
      reason: "read-failed",
      error: err?.message || String(err),
    });
  }
}

function targetTaskNoteText(note) {
  if (typeof note === "string") return note.trim();
  if (!note || typeof note !== "object") return "";
  // 处理 RTF JSON-ML 数组（Teambition 富文本格式）
  if (Array.isArray(note)) {
    try {
      // 如果 note 是一个包含单个 RTF 根节点的数组（如 [["root", {}, ...]]），展开它
      let tree = note;
      if (tree.length === 1 && Array.isArray(tree[0]) && typeof tree[0][0] === "string") {
        tree = tree[0];
      }
      let text = "";
      const walk = (node) => {
        if (typeof node === "string") { text += node; return; }
        if (!Array.isArray(node)) return;
        const tag = node[0], attr = node[1] || {};
        if (tag === "img") { text += `\n[image: ${attr.name || attr.src || "unknown"}]\n`; return; }
        if (tag === "a") {
          if (attr.href) text += attr.href;
          for (let i = 2; i < node.length; i++) walk(node[i]);
          return;
        }
        if (tag === "p") { text += "\n"; }
        for (let i = 2; i < node.length; i++) walk(node[i]);
      };
      walk(tree);
      const result = text.replace(/\n{3,}/g, "\n\n").trim();
      if (result) return result;
    } catch { /* fall through */ }
  }
  const direct = stringValue(
    note.markdown
      || note.plainText
      || note.plain_text
      || note.text
      || note.note
      || note.content
  );
  if (direct) return direct;
  const htmlText = htmlToPlainText(note.html);
  if (htmlText) return htmlText;
  const images = Array.isArray(note.images) ? note.images : [];
  if (images.length) {
    return images.map((image, index) => {
      const name = stringValue(image?.name || image?.fileName || image?.src || image?.signed || image?.localRel);
      return `[image ${index + 1}${name ? `: ${name}` : ""}]`;
    }).join("\n");
  }
  return "";
}

function htmlToPlainText(value = "") {
  return stringValue(value)
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|tr|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'")
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function normalizeTargetCompareValue(field = "", value) {
  if (field === "startDate" || field === "dueDate") return dateValue(value);
  if (field === "involveMembers" || field === "tagIds") return normalizeTargetListValue(value).sort().join("\u001f");
  if (field === "customfields") return normalizeTargetCustomFieldsValue(value);
  return stringValue(value);
}

function sameTargetCompareValue(field = "", actual = "", expected = "") {
  if (field === "startDate" || field === "dueDate") return sameDateInstant(actual, expected);
  if (field === "priority") {
    const actualPriority = comparableTeambitionPriority(actual);
    const expectedPriority = comparableTeambitionPriority(expected);
    if (actualPriority && expectedPriority) return actualPriority === expectedPriority;
  }
  if (field === "tasklistId") {
    const actualTasklist = comparableTeambitionTasklist(actual);
    const expectedTasklist = comparableTeambitionTasklist(expected);
    if (actualTasklist && expectedTasklist) return actualTasklist === expectedTasklist;
  }
  if (field === "involveMembers") {
    const actualMembers = comparableTeambitionMemberList(actual);
    const expectedMembers = comparableTeambitionMemberList(expected);
    if (actualMembers && expectedMembers) return actualMembers === expectedMembers;
  }
  return String(actual) === String(expected);
}

function comparableTeambitionPriority(value) {
  return teambitionPriorityDisplay(value) || stringValue(value);
}

function comparableTeambitionTasklist(value) {
  return teambitionTasklistDisplay(value) || stringValue(value);
}

function comparableTeambitionMemberList(value) {
  const members = normalizeComparableTargetListValue(value)
    .map((memberId) => teambitionMemberDisplay(memberId) || memberId)
    .filter(Boolean)
    .map((member) => stringValue(member).toLowerCase())
    .sort();
  return members.length ? members.join("\u001f") : "";
}

function normalizeComparableTargetListValue(value) {
  if (Array.isArray(value) || (value && typeof value === "object")) return normalizeTargetListValue(value);
  return stringValue(value)
    .split(/\u001f|[\n,;]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

async function enrichTargetTaskDisplayContext(task = {}, payload = {}, loader = null, cfg = {}) {
  if (!task || typeof task !== "object" || !loader) return task;
  const projectId = stringValue(readTargetField(task, TARGET_FIELD_KEY_MAP.projectId) || payload.projectId || cfg.teambition?.projectId);

  const rawTasklistId = stringValue(readTargetFieldValue(task, TARGET_FIELD_KEY_MAP.tasklistId));
  if (rawTasklistId && (!task.tasklist || typeof task.tasklist !== "object" || !(task.tasklist.title || task.tasklist.name))) {
    const tasklist = await findTasklistDisplay(loader, rawTasklistId, projectId, cfg);
    const name = stringValue(tasklist?.pathName || tasklist?.projectPathName || tasklist?.name || tasklist?.title);
    if (name) {
      task.tasklist = {
        ...(task.tasklist && typeof task.tasklist === "object" ? task.tasklist : {}),
        _id: rawTasklistId,
        id: rawTasklistId,
        tasklistId: rawTasklistId,
        title: tasklist?.title || name,
        name: tasklist?.name || name,
        pathName: tasklist?.pathName || tasklist?.projectPathName || name,
      };
    }
  }

  const rawSprintId = stringValue(readTargetFieldValue(task, TARGET_FIELD_KEY_MAP.sprintId));
  if (rawSprintId && (!task.sprint || typeof task.sprint !== "object" || !(task.sprint.name || task.sprint.title))) {
    const sprint = await findSprintDisplay(loader, rawSprintId, projectId, cfg);
    const name = stringValue(sprint?.name || sprint?.title);
    if (name) {
      task.sprint = {
        ...(task.sprint && typeof task.sprint === "object" ? task.sprint : {}),
        _id: rawSprintId,
        id: rawSprintId,
        sprintId: rawSprintId,
        name,
        title: sprint?.title || name,
      };
    }
  }

  const rawExecutorId = stringValue(readTargetFieldValue(task, TARGET_FIELD_KEY_MAP.executorId));
  if (rawExecutorId && (!task.executor || typeof task.executor !== "object" || !(task.executor.name || task.executor.displayName))) {
    const member = await findMemberDisplay(loader, rawExecutorId, projectId, cfg);
    const name = stringValue(member?.name || member?.displayName || member?.nick);
    if (name) {
      task.executor = {
        ...(task.executor && typeof task.executor === "object" ? task.executor : {}),
        _id: rawExecutorId,
        id: rawExecutorId,
        userId: rawExecutorId,
        name,
        displayName: member?.displayName || name,
        nick: member?.nick || name,
      };
    }
  }

  return task;
}

async function readTargetFieldDisplay(task = {}, field = "", actual = "", payload = {}, loader = null, cfg = {}) {
  const fromTask = stringValue(readTargetFieldDisplayPath(task, TARGET_FIELD_DISPLAY_KEY_MAP[field] || []));
  if (fromTask && fromTask !== actual) return fromTask;
  if (field === "priority") {
    const display = teambitionPriorityDisplay(actual || readTargetFieldValue(task, TARGET_FIELD_KEY_MAP.priority));
    if (display && display !== actual) return display;
  }
  if (field === "executorId") {
    const projectId = stringValue(readTargetField(task, TARGET_FIELD_KEY_MAP.projectId) || payload.projectId || cfg.teambition?.projectId);
    const member = await findMemberDisplay(loader, actual, projectId, cfg);
    const name = stringValue(member?.name || member?.displayName || member?.nick);
    if (name && name !== actual) return name;
  }
  if (field === "tasklistId") {
    const projectId = stringValue(readTargetField(task, TARGET_FIELD_KEY_MAP.projectId) || payload.projectId || cfg.teambition?.projectId);
    const tasklist = await findTasklistDisplay(loader, actual, projectId, cfg);
    const name = stringValue(tasklist?.pathName || tasklist?.projectPathName || tasklist?.name || tasklist?.title);
    if (name && name !== actual) return name;
  }
  if (field === "sprintId") {
    const projectId = stringValue(readTargetField(task, TARGET_FIELD_KEY_MAP.projectId) || payload.projectId || cfg.teambition?.projectId);
    const sprint = await findSprintDisplay(loader, actual, projectId, cfg);
    const name = stringValue(sprint?.name || sprint?.title);
    if (name && name !== actual) return name;
  }
  return "";
}

async function readPayloadFieldDisplay(field = "", value, payload = {}, loader = null, cfg = {}) {
  if (field === "startDate" || field === "dueDate") return dateValue(value) || stringValue(value);
  if (field === "involveMembers" || field === "tagIds") return normalizeTargetListValue(value).join(", ");
  if (field === "customfields") return normalizeTargetCustomFieldsValue(value);
  if (field === "priority") return teambitionPriorityDisplay(value) || stringValue(value);
  const id = stringValue(value);
  const projectId = stringValue(payload.projectId || cfg.teambition?.projectId);
  if (field === "projectId") {
    const display = teambitionProjectDisplayForPayload(payload, cfg);
    if (display && display !== id) return display;
  }
  if (field === "executorId") {
    const member = await findMemberDisplay(loader, id, projectId, cfg);
    const name = stringValue(member?.name || member?.displayName || member?.nick);
    if (name && name !== id) return name;
  }
  if (field === "tasklistId") {
    const known = teambitionTasklistDisplay(id);
    if (known && known !== id) return known;
    const tasklist = await findTasklistDisplay(loader, id, projectId, cfg);
    const name = stringValue(tasklist?.pathName || tasklist?.projectPathName || tasklist?.name || tasklist?.title);
    if (name && name !== id) return name;
  }
  if (field === "sprintId") {
    const known = teambitionSprintDisplay(id);
    if (known && known !== id) return known;
    const sprint = await findSprintDisplay(loader, id, projectId, cfg);
    const name = stringValue(sprint?.name || sprint?.title);
    if (name && name !== id) return name;
  }
  return stringValue(value);
}

function teambitionTasklistDisplay(tasklistId = "") {
  return TEAMBITION_TASKLIST_DISPLAY_NAMES[stringValue(tasklistId)] || "";
}

function teambitionSprintDisplay(sprintId = "") {
  return TEAMBITION_SPRINT_DISPLAY_NAMES[stringValue(sprintId)] || "";
}

function teambitionMemberDisplay(memberId = "") {
  return TEAMBITION_MEMBER_DISPLAY_NAMES[stringValue(memberId)] || "";
}

function teambitionProjectDisplayForPayload(payload = {}, cfg = {}) {
  const tasklistId = stringValue(payload.tasklistId);
  const knownPath = TEAMBITION_TASKLIST_PROJECT_PATH_NAMES[tasklistId];
  if (knownPath) return knownPath;
  const configuredPath = stringValue(cfg.teambition?.projectPathName);
  if (configuredPath) return configuredPath;
  const tasklistName = teambitionTasklistDisplay(tasklistId);
  return tasklistName ? `平台组件 / ${tasklistName}` : "";
}

function summarizeTargetTaskForDisplay(task = {}) {
  if (!task || typeof task !== "object") return null;
  const out = {
    taskId: readTargetField(task, ["taskId", "_id", "id"]),
    uniqueId: readTargetField(task, ["uniqueId", "unique_id"]),
  };
  for (const [field, keys] of Object.entries(TARGET_TASK_SNAPSHOT_FIELD_MAP)) {
    const value = readTargetFieldValue(task, keys);
    if (!hasValue(value)) continue;
    out[field] = field === "startDate" || field === "dueDate" ? (dateValue(value) || value) : value;
  }
  for (const [field, paths] of Object.entries(TARGET_FIELD_DISPLAY_KEY_MAP)) {
    const display = field === "priority"
      ? (teambitionPriorityDisplay(out[field] ?? readTargetFieldValue(task, TARGET_FIELD_KEY_MAP.priority)) || readTargetFieldDisplayPath(task, paths))
      : readTargetFieldDisplayPath(task, paths);
    if (display && String(display) !== String(out[field] ?? "")) out[`${field}Display`] = display;
  }
  return cleanObject(out);
}

function readTargetFieldDisplayPath(task = {}, paths = []) {
  for (const path of paths) {
    const value = readCaseInsensitivePath(task, path);
    const direct = stringValue(value);
    if (direct) return direct;
    const nested = firstKnownTargetValue(value, ["name", "title", "displayName", "nick", "username", "pathName"]);
    if (nested) return nested;
  }
  return "";
}

async function findTasklistDisplay(loader, tasklistId = "", projectId = "", cfg = {}) {
  const id = stringValue(tasklistId);
  if (!id || !loader) return null;
  const project = stringValue(projectId || cfg.teambition?.projectId);
  const cacheKey = `${project || "_"}:${id}`;
  if (!loader.__feishuTasklistNameCache) loader.__feishuTasklistNameCache = new Map();
  if (loader.__feishuTasklistNameCache.has(cacheKey)) return loader.__feishuTasklistNameCache.get(cacheKey);
  let hit = null;
  if (loader.listTasklists) {
    try {
      const tasklists = await loader.listTasklists(project, cfg);
      hit = (tasklists || []).find((tasklist) => {
        const candidateId = stringValue(tasklist?.id || tasklist?.tasklistId || tasklist?._id);
        return candidateId === id;
      }) || null;
    } catch {}
  }
  if (!hit && loader.getTasklist) {
    try {
      hit = await loader.getTasklist(id, project, cfg);
    } catch {}
  }
  if (hit) loader.__feishuTasklistNameCache.set(cacheKey, hit);
  return hit;
}

async function findSprintDisplay(loader, sprintId = "", projectId = "", cfg = {}) {
  const id = stringValue(sprintId);
  if (!id || !loader) return null;
  const project = stringValue(projectId || cfg.teambition?.projectId);
  const cacheKey = `${project || "_"}:${id}`;
  if (!loader.__feishuSprintNameCache) loader.__feishuSprintNameCache = new Map();
  if (loader.__feishuSprintNameCache.has(cacheKey)) return loader.__feishuSprintNameCache.get(cacheKey);
  let hit = null;
  if (loader.listSprints) {
    try {
      const sprints = await loader.listSprints(project, cfg);
      hit = (sprints || []).find((sprint) => {
        const candidateId = stringValue(sprint?.id || sprint?.sprintId || sprint?._id);
        return candidateId === id;
      }) || null;
    } catch {}
  }
  if (!hit && loader.getSprint) {
    try {
      hit = await loader.getSprint(id, project, cfg);
    } catch {}
  }
  if (hit) loader.__feishuSprintNameCache.set(cacheKey, hit);
  return hit;
}

async function findMemberDisplay(loader, memberId = "", projectId = "", cfg = {}) {
  const id = stringValue(memberId);
  if (!id || !loader) return null;
  const project = stringValue(projectId || cfg.teambition?.projectId);
  const cacheKey = `${project || "_"}:${id}`;
  if (!loader.__feishuMemberNameCache) loader.__feishuMemberNameCache = new Map();
  if (loader.__feishuMemberNameCache.has(cacheKey)) return loader.__feishuMemberNameCache.get(cacheKey);
  let hit = null;
  if (loader.listMembers) {
    try {
      const members = await loader.listMembers(project, cfg);
      hit = (members || []).find((member) => {
        const candidateId = stringValue(member?.id || member?.uid || member?._id || member?.userId || member?._userId);
        return candidateId === id;
      }) || null;
    } catch {}
  }
  if (hit) loader.__feishuMemberNameCache.set(cacheKey, hit);
  return hit;
}

function readTargetField(task, paths = []) {
  const value = readTargetFieldValue(task, paths);
  if (Array.isArray(value)) return normalizeTargetListValue(value).join(",");
  if (value && typeof value === "object") return firstKnownTargetValue(value, ["_id", "id", "userId", "tasklistId", "sprintId", "projectId", "value"]) || "";
  return stringValue(value);
}

function readTargetFieldValue(task, paths = []) {
  for (const path of paths) {
    const value = readCaseInsensitivePath(task, path);
    if (!hasValue(value)) continue;
    if (Array.isArray(value)) return value;
    const direct = stringValue(value);
    if (direct) return direct;
    const nested = firstKnownTargetValue(value, ["_id", "id", "userId", "tasklistId", "sprintId", "projectId", "value"]);
    if (nested) return nested;
    if (value && typeof value === "object") return value;
  }
  return undefined;
}

function normalizeTargetListValue(value) {
  if (Array.isArray(value)) {
    return value.flatMap((item) => normalizeTargetListValue(item)).filter(Boolean);
  }
  if (value == null || value === "") return [];
  if (typeof value === "object") {
    const direct = firstKnownTargetValue(value, ["_id", "id", "userId", "uid", "tagId", "value"]);
    return direct ? [direct] : [];
  }
  return normalizeStringList(value);
}

function targetCustomFieldEntries(value) {
  if (Array.isArray(value)) {
    return value.flatMap((item) => {
      if (Array.isArray(item) && item.length >= 2) return [{ customfieldId: item[0], value: item[1] }];
      return item && typeof item === "object" ? [item] : [];
    });
  }
  if (!value || typeof value !== "object") return [];
  const nested = ["items", "list", "records", "results", "data"].flatMap((key) => {
    const child = getCaseInsensitive(value, key);
    return Array.isArray(child) ? targetCustomFieldEntries(child) : [];
  });
  if (nested.length) return nested;
  if (readTargetCustomFieldId(value)) return [value];
  return Object.entries(value).map(([id, fieldValue]) => ({ id, value: fieldValue }));
}

function readTargetCustomFieldPath(field = {}, paths = []) {
  for (const path of paths) {
    const value = readCaseInsensitivePath(field, path);
    if (hasValue(value)) return value;
  }
  return undefined;
}

function readTargetCustomFieldId(field = {}) {
  if (Array.isArray(field) && field.length >= 2) return stringValue(field[0]);
  return stringValue(readTargetCustomFieldPath(field, TARGET_CUSTOM_FIELD_ID_PATHS));
}

function targetCustomFieldReadableParts(value, depth = 0) {
  if (!hasValue(value)) return [];
  if (isPrimitiveValue(value)) return [stringValue(value)].filter(Boolean);
  if (Array.isArray(value)) return value.flatMap((item) => targetCustomFieldReadableParts(item, depth + 1)).filter(Boolean);
  if (!value || typeof value !== "object" || depth >= 6) return [];
  for (const path of TARGET_CUSTOM_FIELD_VALUE_PATHS) {
    const nested = readCaseInsensitivePath(value, path);
    if (!hasValue(nested) || nested === value) continue;
    const parts = targetCustomFieldReadableParts(nested, depth + 1);
    if (parts.length) return parts;
  }
  const fallback = firstKnownTargetValue(value, ["value", "label", "name", "title", "_id", "id", "key"]);
  return fallback ? [fallback] : [];
}

function normalizeTargetCustomFieldsValue(value) {
  const fields = targetCustomFieldEntries(value);
  const normalized = fields.map((field) => {
    const id = readTargetCustomFieldId(field);
    const fieldValue = readTargetCustomFieldPath(field, TARGET_CUSTOM_FIELD_VALUE_PATHS);
    if (!id || !hasValue(fieldValue)) return null;
    const values = targetCustomFieldReadableParts(fieldValue);
    return [id, values.length ? values.join("\u001f") : stringValue(fieldValue)];
  }).filter(Boolean);
  return normalized.length ? JSON.stringify(normalized.sort(([a], [b]) => a.localeCompare(b))) : "";
}

function readCaseInsensitivePath(obj, path = "") {
  let cur = obj;
  for (const part of String(path || "").split(".").filter(Boolean)) {
    if (!cur || typeof cur !== "object") return "";
    cur = getCaseInsensitive(cur, part);
  }
  return cur;
}

function getFreshChildSyncPlan(item, cfg, status = "missing") {
  const plan = { needsSync: false, comments: [], attachments: [] };
  if (cfg.sync.includeComments) {
    for (const comment of item.comments || []) {
      if (comment.id) plan.comments.push({ id: comment.id, payloadHash: comment.payloadHash, status });
    }
  }
  if (cfg.sync.includeAttachments) {
    for (const attachment of item.attachments || []) {
      if (attachment.id) plan.attachments.push({ id: attachment.id, payloadHash: attachment.payloadHash, status });
    }
  }
  plan.needsSync = plan.comments.length > 0 || plan.attachments.length > 0;
  return plan;
}

async function readTargetCommentContext(targetTaskId = "", loader = null, cfg = {}) {
  const id = stringValue(targetTaskId);
  if (!id) return { attempted: false, ok: false, reason: "target-task-id-empty", comments: [] };
  if (!loader?.getTaskComments) return { attempted: false, ok: false, reason: "loader-getTaskComments-unavailable", comments: [] };
  try {
    const raw = await loader.getTaskComments(id, cfg);
    const comments = normalizeTargetComments(raw);
    const bySourceCommentId = new Map();
    const byNormalizedText = new Map();
    for (const comment of comments) {
      const sourceCommentId = stringValue(comment.sourceCommentId);
      if (sourceCommentId && !bySourceCommentId.has(sourceCommentId)) bySourceCommentId.set(sourceCommentId, comment);
      const text = normalizeCommentCompareText(comment.content);
      if (text && !byNormalizedText.has(text)) byNormalizedText.set(text, comment);
    }
    return {
      attempted: true,
      ok: true,
      targetTaskId: id,
      comments,
      count: comments.length,
      bySourceCommentId,
      byNormalizedText,
    };
  } catch (err) {
    return {
      attempted: true,
      ok: false,
      targetTaskId: id,
      comments: [],
      error: err?.message || String(err),
    };
  }
}

function attachTargetCommentContext(plan = {}, context = null) {
  if (!context) return plan;
  const targetCommentRead = cleanObject({
    attempted: context.attempted,
    ok: context.ok,
    reason: context.reason,
    error: context.error,
    count: context.count,
  });
  return cleanObject({
    ...plan,
    targetCommentRead,
    targetComments: (context.comments || []).slice(0, 20).map((comment) => cleanObject({
      id: comment.id,
      author: comment.author,
      content: comment.content,
      createdAt: comment.createdAt,
      sourceCommentId: comment.sourceCommentId,
    })),
  });
}

function normalizeTargetComments(rawComments) {
  const arr = arrayValue(rawComments, ["comments", "items", "list", "records", "result", "data", "activities"]);
  return arr.map((entry, idx) => {
    const source = entry && typeof entry === "object" ? entry : { content: entry };
    const content = targetCommentText(source);
    const sourceCommentId = stringValue(getFirst(source, ["sourceCommentId", "source_comment_id", "commentId", "comment_id"])) || extractSourceCommentId(content);
    return cleanObject({
      id: stringValue(getFirst(source, ["id", "_id", "commentId", "comment_id", "activityId", "activity_id", "uuid"])) || `target-comment-${idx}`,
      author: normalizePeople(getFirst(source, ["author", "creator", "user", "member", "created_by", "createdBy", "operator"]))[0] || null,
      content,
      createdAt: dateValue(getFirst(source, ["created_at", "createdAt", "created", "time", "create_time", "createTime", "updated_at", "updatedAt"])),
      sourceCommentId,
    });
  }).filter((comment) => comment.content || comment.id);
}

function targetCommentText(source = {}) {
  if (!source || typeof source !== "object") return targetCommentValueText(source);
  const value = getFirst(source, ["content", "text", "body", "comment", "message", "rich_text", "richText", "reply_content", "replyContent", "description"]);
  return targetCommentValueText(value ?? source);
}

function targetCommentValueText(value, depth = 0) {
  if (value == null || value === "") return "";
  if (isPrimitiveValue(value)) {
    const text = stringValue(value);
    if (!text) return "";
    const parsed = parseJsonLikeText(text);
    if (parsed !== null && parsed !== text) {
      const parsedText = targetCommentValueText(parsed, depth + 1);
      if (parsedText) return parsedText;
    }
    return htmlToPlainText(text) || text;
  }
  if (Array.isArray(value)) return value.map((item) => targetCommentValueText(item, depth + 1)).filter(Boolean).join("\n");
  if (typeof value !== "object" || depth >= 6) return stringValue(value);
  const rich = richTextValue(value);
  if (rich) return rich;
  for (const key of ["markdown", "text", "plainText", "plain_text", "html", "body", "content", "message", "comment", "value", "displayValue", "display_value"]) {
    const child = getCaseInsensitive(value, key);
    if (child === null || child === undefined || child === value) continue;
    const text = targetCommentValueText(child, depth + 1);
    if (text) return text;
  }
  return displayValue(value);
}

function parseJsonLikeText(text = "") {
  const value = stringValue(text);
  if (!/^[\[{]/.test(value)) return null;
  try { return JSON.parse(value); } catch { return null; }
}

function extractSourceCommentId(text = "") {
  const hit = stringValue(text).match(/Source\s+comment\s+ID\s*[:：]\s*([^\s\r\n]+)/i);
  return hit ? stringValue(hit[1]) : "";
}

function normalizeCommentCompareText(text = "") {
  return stringValue(text)
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .toLowerCase();
}

function findMatchingTargetComment(targetCommentContext = null, comment = {}, item = {}) {
  if (!targetCommentContext?.ok) return null;
  const sourceCommentId = stringValue(comment.id);
  if (sourceCommentId && targetCommentContext.bySourceCommentId?.has(sourceCommentId)) {
    return targetCommentContext.bySourceCommentId.get(sourceCommentId);
  }
  const planned = normalizeCommentCompareText(formatComment(comment, item));
  if (planned && targetCommentContext.byNormalizedText?.has(planned)) {
    return targetCommentContext.byNormalizedText.get(planned);
  }
  const sourceContent = normalizeCommentCompareText(comment.content);
  const marker = sourceCommentId ? normalizeCommentCompareText(`Source comment ID: ${sourceCommentId}`) : "";
  return (targetCommentContext.comments || []).find((target) => {
    const targetText = normalizeCommentCompareText(target.content);
    if (!targetText) return false;
    if (marker && targetText.includes(marker)) return true;
    return !!(sourceContent && targetText.includes(sourceContent));
  }) || null;
}

function findExistingTargetOverride(options = {}, key = {}, item = {}, sourceProblemNo = "", sourceWorkItemNo = "") {
  const collections = [
    options.sheetTargetByProblemNo,
    options.existingByProblemNo,
    options.targetByProblemNo,
    options.existingOverrides,
  ].filter(Boolean);
  if (!collections.length) return null;
  const keys = [
    sourceProblemNo,
    sourceWorkItemNo,
    item.sourceWorkItemNo,
    item.sourceProblemNo,
    item.workItemNo,
    item.problemNo,
    item.sourceWorkItemId,
    key.sourceWorkItemId,
    `${key.sourceProjectKey || ""}/${key.sourceWorkItemTypeKey || ""}/${key.sourceWorkItemId || ""}`,
  ].map((value) => stringValue(value)).filter(Boolean);
  for (const collection of collections) {
    const hit = readOverrideCollection(collection, keys);
    if (hit) return hit;
  }
  return null;
}

function readOverrideCollection(collection, keys = []) {
  if (!collection) return null;
  if (collection instanceof Map) {
    for (const key of keys) {
      const hit = collection.get(key) || collection.get(key.toUpperCase?.() || key);
      if (hit) return hit;
    }
    return null;
  }
  if (Array.isArray(collection)) {
    for (const row of collection) {
      const rowKeys = [
        row?.sourceWorkItemNo,
        row?.sourceProblemNo,
        row?.problemNo,
        row?.sourceWorkItemId,
        row?.key,
      ].map((value) => stringValue(value)).filter(Boolean);
      if (rowKeys.some((rowKey) => keys.includes(rowKey))) return row;
    }
    return null;
  }
  if (typeof collection === "object") {
    for (const key of keys) {
      const direct = collection[key] || collection[key.toUpperCase?.() || key] || collection[key.toLowerCase?.() || key];
      if (direct) return direct;
    }
  }
  return null;
}

function normalizeSheetTargetRow(row = null) {
  if (!row || typeof row !== "object" || Array.isArray(row)) return null;
  const out = {};
  for (const [key, value] of Object.entries(row)) {
    const column = stringValue(key);
    if (!column) continue;
    out[column] = String(value ?? "");
  }
  return Object.keys(out).length ? out : null;
}

function normalizeSheetTargetColumns(columns = null, row = null) {
  const raw = Array.isArray(columns) ? columns : [];
  const fromRow = row && typeof row === "object" && !Array.isArray(row) ? Object.keys(row) : [];
  return Array.from(new Set([...raw, ...fromRow].map((column) => stringValue(column)).filter(Boolean)));
}

function mergeExistingTargetOverride(existing = null, override = {}) {
  const targetTaskId = stringValue(
    override.targetTaskId
    || override.target_task_id
    || override.taskId
    || override.task_id
    || override.id
    || override._id
    || override.task?._id
    || override.task?.id,
  );
  const targetUniqueId = stringValue(
    override.targetUniqueId
    || override.target_unique_id
    || override.uniqueId
    || override.unique_id
    || override.targetDisplayId
    || override.target_display_id
    || override.task?.uniqueId
    || override.task?.unique_id,
  ).replace(/^CARB-/i, "");
  if (!targetTaskId && !targetUniqueId) return existing;
  const sheetTargetRow = normalizeSheetTargetRow(
    override.sheetTargetRow
    || override.sheet_target_row
    || override.sheetRow
    || override.sheet_row
    || override.row,
  );
  const sheetTargetColumns = normalizeSheetTargetColumns(
    override.sheetTargetColumns || override.sheet_target_columns || override.columns,
    sheetTargetRow,
  );
  return {
    ...(existing || {}),
    targetTaskId: targetTaskId || existing?.targetTaskId || existing?.target_task_id || "",
    targetUniqueId: targetUniqueId || existing?.targetUniqueId || existing?.target_unique_id || "",
    targetUpdatedAt: stringValue(override.targetUpdatedAt || override.target_updated_at || override.updatedAt || override.updated_at) || existing?.targetUpdatedAt || existing?.target_updated_at || "",
    syncStatus: existing?.syncStatus || existing?.sync_status || "sheet-target",
    lastError: existing?.lastError || existing?.last_error || "",
    sheetTargetOverride: true,
    sheetTargetDisplayId: override.targetDisplayId || override.target_display_id || "",
    sheetTargetRow: sheetTargetRow || existing?.sheetTargetRow || existing?.sheet_target_row || undefined,
    sheetTargetColumns: sheetTargetColumns.length ? sheetTargetColumns : (existing?.sheetTargetColumns || existing?.sheet_target_columns || undefined),
  };
}

export async function syncFeishuProjectWorkItem(raw, options = {}) {
  let cfg = getFeishuProjectSyncConfig(options.config || {});
  const item = normalizeFeishuWorkItem(raw, cfg);
  if (!item.sourceWorkItemId) throw new Error("Feishu work item id is missing");
  const key = syncKey(item);
  let existingBeforeScope = getFeishuProjectSyncState(key);
  const payloadHashForScope = hashStable({ item: hashableSyncItem(item) });
  const sourceProblemNo = getSourceProblemNo(item);
  const sourceWorkItemNo = getSourceWorkItemNo(item);
  const existingOverride = findExistingTargetOverride(options, key, item, sourceProblemNo, sourceWorkItemNo);
  if (existingOverride) existingBeforeScope = mergeExistingTargetOverride(existingBeforeScope, existingOverride);
  const sourceIdentity = {
    sourceProblemNo,
    problemNo: sourceProblemNo,
    sourceWorkItemNo,
  };
  syncProgress(options, { phase: "item-start", level: "info", item, message: "开始处理飞书单" });
  const sourceScope = checkSourceScope(item, cfg);
  if (!sourceScope.ok) {
    const scopeStatus = buildOutOfScopeStatus(item, cfg, sourceScope, existingBeforeScope, key);
    const preparedFingerprint = hashStable({
      version: 1,
      key,
      action: "skip",
      reason: sourceScope.reason,
      payloadHash: payloadHashForScope,
      targetTaskId: existingBeforeScope?.targetTaskId || "",
    });
    if (options.expectedPreparedFingerprint && options.expectedPreparedFingerprint !== preparedFingerprint) {
      return preparedSyncStaleResult(item, "skip", preparedFingerprint);
    }
    persistOutOfScopeObservation({ item, key, sourceIdentity, payloadHash: payloadHashForScope, raw, existing: existingBeforeScope, scopeStatus, options });
    const result = {
      ok: true,
      dryRun: !!options.dryRun,
      action: "skip",
      skipped: true,
      reason: sourceScope.reason,
      item,
      scopeStatus,
      bookmarks: scopeStatus.bookmarks || [],
      preparedFingerprint,
    };
    syncProgress(options, { phase: "skip", level: "info", item, action: "skip", message: scopeStatus.message || sourceScope.reason });
    return result;
  }
  const assigneeScope = checkRequiredAssigneeScope(item, cfg);
  if (!assigneeScope.ok) {
    const scopeStatus = buildOutOfScopeStatus(item, cfg, assigneeScope, existingBeforeScope, key);
    const preparedFingerprint = hashStable({
      version: 1,
      key,
      action: "skip",
      reason: assigneeScope.reason,
      payloadHash: payloadHashForScope,
      targetTaskId: existingBeforeScope?.targetTaskId || "",
    });
    if (options.expectedPreparedFingerprint && options.expectedPreparedFingerprint !== preparedFingerprint) {
      return preparedSyncStaleResult(item, "skip", preparedFingerprint);
    }
    persistOutOfScopeObservation({ item, key, sourceIdentity, payloadHash: payloadHashForScope, raw, existing: existingBeforeScope, scopeStatus, options });
    const result = {
      ok: true,
      dryRun: !!options.dryRun,
      action: "skip",
      skipped: true,
      reason: assigneeScope.reason,
      item,
      scopeStatus,
      bookmarks: scopeStatus.bookmarks || [],
      preparedFingerprint,
    };
    syncProgress(options, { phase: "skip", level: "info", item, action: "skip", message: scopeStatus.message || assigneeScope.reason });
    return result;
  }
  const policyDecision = resolveSyncPolicy({
    config: cfg,
    source: {
      system: item.sourceSystem,
      projectKey: item.sourceProjectKey,
      typeKey: item.sourceWorkItemTypeKey,
      viewId: item.sourceViewId,
    },
    item,
    raw,
  });
  if (policyDecision.target?.system !== TARGET_SYSTEM) {
    const matchedRule = policyDecision.matchedRule?.name || policyDecision.matchedRule?.id || "默认规则";
    throw new Error(`规则“${matchedRule}”命中了尚未安装的 Target 适配器：${policyDecision.target?.system || "unknown"}`);
  }
  cfg = applyResolvedSyncPolicy(cfg, policyDecision);
  syncProgress(options, {
    phase: "policy-resolved",
    level: "info",
    item,
    message: policyDecision.matched
      ? `命中规则“${policyDecision.matchedRule?.name || policyDecision.matchedRule?.id}”，目标“${policyDecision.target?.name || policyDecision.target?.id}”`
      : `未命中特定规则，使用默认目标“${policyDecision.target?.name || policyDecision.target?.id}”`,
  });
  const loader = resolveLoader(options);
  const enforceRequiredFieldPlan = hasCompleteRequiredFieldSourceValues(item);
  await resolveCategoryCustomFieldIds(cfg, loader, enforceRequiredFieldPlan);
  await resolveConfiguredTagIds(cfg, loader, enforceRequiredFieldPlan);
  const builtPayload = buildTeambitionTaskPayload(item, cfg);
  let payload = builtPayload.payload;
  let managedUpdatePayload = applySyncPayloadStrategy(payload, "update", policyDecision).payload;
  let { display: payloadDisplay } = builtPayload;
  let payloadHash = hashSyncPayloadForPolicy(item, managedUpdatePayload, policyDecision);
  const commentsHash = hashStable(item.comments);
  const attachmentsHash = hashStable(item.attachments);
  let existing = existingBeforeScope;
  const targetVerification = await verifyExistingTargetForWorkItem(key, existing, loader, cfg, options);
  existing = targetVerification.existing;
  let targetFieldVerification = targetVerification.missing
    ? { checked: false, mismatch: false, reason: "target-missing" }
    : await verifyExistingTargetFields(existing?.targetTaskId || existing?.target_task_id || "", managedUpdatePayload, loader, cfg, options, targetVerification.info);
  const mergedLocalTags = mergeExistingTargetTagsForPolicy(managedUpdatePayload, targetFieldVerification, policyDecision);
  if (mergedLocalTags.changed) {
    managedUpdatePayload = mergedLocalTags.payload;
    payloadHash = hashSyncPayloadForPolicy(item, managedUpdatePayload, policyDecision);
    targetFieldVerification = await verifyExistingTargetFields(existing?.targetTaskId || existing?.target_task_id || "", managedUpdatePayload, loader, cfg, options, targetVerification.info);
  }
  const preservedLocalUserFields = preserveExistingTargetUserFields(managedUpdatePayload, payloadDisplay, targetFieldVerification, cfg);
  let preservedTargetUserFields = preservedLocalUserFields.preserved;
  if (preservedLocalUserFields.changed) {
    managedUpdatePayload = preservedLocalUserFields.payload;
    payloadDisplay = preservedLocalUserFields.payloadDisplay;
    payloadHash = hashSyncPayloadForPolicy(item, managedUpdatePayload, policyDecision);
    targetFieldVerification = await verifyExistingTargetFields(existing?.targetTaskId || existing?.target_task_id || "", managedUpdatePayload, loader, cfg, options, targetVerification.info);
  }
  let targetCommentContext = !cfg.sync.includeComments
    ? { attempted: false, ok: false, reason: "comments-disabled", comments: [] }
    : targetVerification.missing
    ? { attempted: false, ok: false, reason: "target-missing", comments: [] }
    : await readTargetCommentContext(existing?.targetTaskId || existing?.target_task_id || "", loader, cfg);
  let childPlan = targetVerification.missing
    ? getFreshChildSyncPlan(item, cfg, "target-missing")
    : getChildSyncPlan(item, cfg, targetCommentContext);
  const samePayload = existing?.sourcePayloadHash === payloadHash;
  const wasChildSyncFailure = existing?.syncStatus === "failed"
    && /^Teambition loader child sync failed/i.test(existing?.lastError || "");
  let action = existing?.targetTaskId
    ? (
      samePayload && existing.syncStatus === "success" && !childPlan.needsSync
        ? "skip"
        : samePayload && childPlan.needsSync && (existing.syncStatus === "success" || wasChildSyncFailure)
          ? "sync-children"
          : "update"
    )
    : "create";
  if ((action === "skip" || action === "sync-children") && targetFieldVerification.mismatch) {
    action = "update";
  }
  let actionPolicy = payloadForPolicyAction(payload, managedUpdatePayload, action, options, preservedTargetUserFields, policyDecision);
  let actionPayload = actionPolicy.payload;
  let strategyEffects = actionPolicy.effects;
  let remoteExisting = null;

  if (action === "create" && !shouldRecoverCreatedTaskBeforeCreate(existing) && shouldCheckRemoteExistingBeforeCreate(options, cfg)) {
    remoteExisting = await findRemoteExistingBeforeCreate(actionPayload, loader, cfg, sourceIdFromSyncKey(key), sourceProblemNo || sourceWorkItemNo);
    if (remoteExisting?.targetTaskId) {
      const remoteTarget = await checkTargetExists(loader, remoteExisting.targetTaskId, cfg);
      if (remoteTarget.exists === false) {
        remoteExisting = { ...remoteExisting, targetVerification: remoteTarget, ignored: true };
      } else {
        remoteExisting = { ...remoteExisting, targetVerification: remoteTarget };
        existing = syncStateFromRemoteExisting(existing, remoteExisting);
        action = "update";
        targetFieldVerification = await verifyExistingTargetFields(remoteExisting.targetTaskId, managedUpdatePayload, loader, cfg, options, remoteTarget);
        const mergedRemoteTags = mergeExistingTargetTagsForPolicy(managedUpdatePayload, targetFieldVerification, policyDecision);
        if (mergedRemoteTags.changed) {
          managedUpdatePayload = mergedRemoteTags.payload;
          payloadHash = hashSyncPayloadForPolicy(item, managedUpdatePayload, policyDecision);
          targetFieldVerification = await verifyExistingTargetFields(remoteExisting.targetTaskId, managedUpdatePayload, loader, cfg, options, remoteTarget);
        }
        const preservedRemoteUserFields = preserveExistingTargetUserFields(managedUpdatePayload, payloadDisplay, targetFieldVerification, cfg);
        preservedTargetUserFields = { ...preservedTargetUserFields, ...preservedRemoteUserFields.preserved };
        if (preservedRemoteUserFields.changed) {
          managedUpdatePayload = preservedRemoteUserFields.payload;
          payloadDisplay = preservedRemoteUserFields.payloadDisplay;
          payloadHash = hashSyncPayloadForPolicy(item, managedUpdatePayload, policyDecision);
          targetFieldVerification = await verifyExistingTargetFields(remoteExisting.targetTaskId, managedUpdatePayload, loader, cfg, options, remoteTarget);
        }
        actionPolicy = payloadForPolicyAction(payload, managedUpdatePayload, action, options, preservedTargetUserFields, policyDecision);
        actionPayload = actionPolicy.payload;
        strategyEffects = actionPolicy.effects;
        targetCommentContext = cfg.sync.includeComments
          ? await readTargetCommentContext(remoteExisting.targetTaskId, loader, cfg)
          : { attempted: false, ok: false, reason: "comments-disabled", comments: [] };
        childPlan = getChildSyncPlan(item, cfg, targetCommentContext);
      }
    }
  }

  const comparisonPayload = action === "create" ? actionPayload : managedUpdatePayload;
  const payloadSummary = attachTargetNotePreviousToPayloadSummary(
    await summarizeSyncPayload(comparisonPayload, loader, cfg, payloadDisplay),
    targetFieldVerification,
  );
  const comparisonSnapshot = await buildSyncComparisonSnapshot({
    item,
    key,
    payload: comparisonPayload,
    payloadSummary,
    targetFieldVerification,
    targetVerification: targetVerification.info,
    existing,
    remoteExisting,
    action,
    loader,
    cfg,
    policyDecision,
  });
  const preparedFingerprint = buildPreparedSyncFingerprint({
    key,
    action,
    actionPayload,
    payloadHash,
    commentsHash,
    attachmentsHash,
    existing,
    targetFieldVerification,
    childPlan,
  });

  if (options.expectedPreparedFingerprint && options.expectedPreparedFingerprint !== preparedFingerprint) {
    return preparedSyncStaleResult(item, action, preparedFingerprint);
  }

  if (targetVerification.deferredReset) {
    const reset = resetFeishuProjectSyncTarget(targetVerification.deferredReset.key, {
      targetTaskId: targetVerification.deferredReset.targetTaskId,
      syncStatus: "pending",
      lastError: "",
    });
    targetVerification.info = cleanObject({ ...targetVerification.info, reset: reset?.changes });
    targetVerification.deferredReset = null;
  }

  if (options.dryRun) {
    const result = { ok: true, dryRun: true, action, item, payload: payloadSummary, existing, remoteExisting, childPlan, policyDecision: publicDecision(policyDecision), strategyEffects, targetVerification: targetVerification.info, targetFieldVerification, comparisonSnapshot, preparedFingerprint };
    syncProgress(options, { phase: "dry-run", level: "info", item, action, message: `预检动作：${action}` });
    return result;
  }

  insertFeishuProjectRawPayload({ ...key, payloadHash, payloadJson: raw });
  if (action === "skip") {
    const scheduleWarnings = await syncTargetTaskDates(existing.targetTaskId, actionPayload, loader, cfg, options);
    persistTargetExistingCommentSyncs(item, existing.targetTaskId, childPlan);
    upsertFeishuProjectSyncState({
      ...key,
      ...sourceIdentity,
      sourceWorkItemUrl: item.sourceWorkItemUrl,
      targetTaskId: existing.targetTaskId,
      targetUniqueId: existing.targetUniqueId,
      sourceUpdatedAt: item.updatedAt,
      targetUpdatedAt: existing.targetUpdatedAt,
      lastSyncedAt: existing.lastSyncedAt,
      sourcePayloadHash: payloadHash,
      commentsHash,
      attachmentsHash,
      syncStatus: "success",
      lastError: "",
    });
    resolveFeishuProjectSyncErrors({ ...key, targetObjectType: "task" });
    const result = { ok: true, action, item, targetTaskId: existing.targetTaskId, payload: payloadSummary, policyDecision: publicDecision(policyDecision), strategyEffects, scheduleWarnings, targetFieldVerification, comparisonSnapshot, preparedFingerprint };
    syncProgress(options, { phase: "success", level: "info", item, action, targetTaskId: existing.targetTaskId, message: "无需更新，已确认同步状态" });
    return result;
  }

  upsertFeishuProjectSyncState({
    ...key,
    ...sourceIdentity,
    sourceWorkItemUrl: item.sourceWorkItemUrl,
    targetTaskId: existing?.targetTaskId || "",
    sourceUpdatedAt: item.updatedAt,
    targetUpdatedAt: existing?.targetUpdatedAt || "",
    sourcePayloadHash: payloadHash,
    commentsHash,
    attachmentsHash,
    syncStatus: "syncing",
    lastError: "",
  });

  let targetTaskId = existing?.targetTaskId || "";
  let targetUniqueId = existing?.targetUniqueId || "";
  let targetUpdatedAt = existing?.targetUpdatedAt || "";
  let missingTargetTaskIdDetail = "";
  let postWriteFieldVerification = { checked: false, mismatch: false };
  try {
    syncProgress(options, { phase: "action-start", level: "info", item, action, targetTaskId, message: `准备${action === "create" ? "创建" : action === "update" ? "更新" : "同步子项"} TB 单` });
    if (action === "sync-children") {
      if (!targetTaskId) throw new Error("Teambition task id missing from existing sync state");
    } else {
      let target = null;
      if (action === "create" && shouldRecoverCreatedTaskBeforeCreate(existing)) {
        const recovered = await recoverCreatedTargetTask(actionPayload, loader, cfg);
        targetTaskId = extractTargetTaskId(recovered) || targetTaskId;
        targetUniqueId = extractTargetUniqueId(recovered) || targetUniqueId || "";
        targetUpdatedAt = extractTargetUpdatedAt(recovered) || targetUpdatedAt;
      }
      if (action === "update" || !targetTaskId) {
        target = action === "update"
          ? await loader.updateTask(existing.targetTaskId, actionPayload, cfg)
          : await loader.createTask(actionPayload, cfg);
        targetTaskId = extractTargetTaskId(target) || targetTaskId;
        targetUniqueId = extractTargetUniqueId(target) || targetUniqueId || "";
        targetUpdatedAt = extractTargetUpdatedAt(target) || targetUpdatedAt;
        if (!targetTaskId && action === "create") {
          missingTargetTaskIdDetail = describeTargetTaskResult(target);
          const recovered = await recoverCreatedTargetTask(actionPayload, loader, cfg);
          targetTaskId = extractTargetTaskId(recovered) || targetTaskId;
          targetUniqueId = extractTargetUniqueId(recovered) || targetUniqueId || "";
          targetUpdatedAt = extractTargetUpdatedAt(recovered) || targetUpdatedAt;
        }
      }
      if (!targetTaskId) throw new Error(missingTargetTaskIdDetail || "Teambition task id missing from loader result");
    }

    const actionCustomfields = Array.isArray(actionPayload.customfields) ? actionPayload.customfields : [];
    let supplementalFieldWrites = null;
    if (action !== "sync-children" && Array.isArray(actionPayload.tagIds) && loader.updateTags) {
      const tagResult = await loader.updateTags(targetTaskId, actionPayload.tagIds, cfg);
      supplementalFieldWrites = {
        tags: {
          attempted: true,
          count: actionPayload.tagIds.length,
          resultCount: tagResult == null ? 0 : 1,
        },
      };
    }
    if (action !== "sync-children" && actionCustomfields.length && loader.updateCustomFields) {
      const customFieldResults = await loader.updateCustomFields(targetTaskId, actionCustomfields, cfg, {
        operatorId: stringValue(actionPayload.executorId),
      });
      supplementalFieldWrites = {
        ...(supplementalFieldWrites || {}),
        customfields: {
          attempted: true,
          count: actionCustomfields.length,
          resultCount: Array.isArray(customFieldResults) ? customFieldResults.length : 1,
        },
      };
    }
    if (action !== "sync-children") {
      postWriteFieldVerification = await verifyWrittenTargetFields(targetTaskId, actionPayload, loader, cfg, options);
    }
    const scheduleWarnings = await syncTargetTaskDates(targetTaskId, actionPayload, loader, cfg, options);
    const childFailures = [];
    if (cfg.sync.includeComments) childFailures.push(...await syncComments(
      item,
      targetTaskId,
      loader,
      payloadHash,
      cfg,
      action === "create" ? { attempted: false, ok: false, reason: "new-target", comments: [] } : targetCommentContext,
    ));
    if (cfg.sync.includeAttachments) childFailures.push(...await syncAttachments(item, targetTaskId, loader, attachmentsHash, cfg));
    const fatalFailures = childFailures.filter((failure) => isFatalChildFailure(failure, cfg));
    if (fatalFailures.length) throw new FeishuProjectLoaderError(fatalFailures);

    const state = upsertFeishuProjectSyncState({
      ...key,
      ...sourceIdentity,
      sourceWorkItemUrl: item.sourceWorkItemUrl,
      targetTaskId,
      targetUniqueId,
      sourceUpdatedAt: item.updatedAt,
      targetUpdatedAt,
      lastSyncedAt: new Date().toISOString(),
      sourcePayloadHash: payloadHash,
      commentsHash,
      attachmentsHash,
      syncStatus: "success",
      lastError: "",
    });
    resolveFeishuProjectSyncErrors({ ...key, targetObjectType: "task" });
    const result = { ok: true, action, item, targetTaskId, payload: payloadSummary, state, policyDecision: publicDecision(policyDecision), strategyEffects, scheduleWarnings, supplementalFieldWrites, postWriteFieldVerification, targetFieldVerification, comparisonSnapshot, preparedFingerprint };
    syncProgress(options, { phase: "success", level: "info", item, action, targetTaskId, message: "TB 单同步成功" });
    return result;
  } catch (err) {
    const message = err?.message || String(err);
    upsertFeishuProjectSyncState({
      ...key,
      ...sourceIdentity,
      sourceWorkItemUrl: item.sourceWorkItemUrl,
      targetTaskId,
      targetUniqueId,
      sourceUpdatedAt: item.updatedAt,
      targetUpdatedAt,
      sourcePayloadHash: payloadHash,
      commentsHash,
      attachmentsHash,
      syncStatus: "failed",
      lastError: message,
    });
    upsertFeishuProjectSyncError({
      ...key,
      stage: err?.stage || action,
      targetObjectType: "task",
      targetTaskId,
      sourcePayloadHash: payloadHash,
      errorMessage: message,
      errorDetail: err?.failures || err?.stack || err,
      retryable: true,
    });
    log("system", "warn", "feishu-project-sync", `sync failed ${item.sourceWorkItemId}: ${message}`);
    const result = { ok: false, action, item, targetTaskId, payload: payloadSummary, error: message, failures: err?.failures || undefined, postWriteFieldVerification, targetFieldVerification, comparisonSnapshot, preparedFingerprint };
    syncProgress(options, { phase: "failed", level: "error", item, action, targetTaskId, error: message, message: "TB 单同步失败" });
    return result;
  }
}

function buildPreparedSyncFingerprint({
  key = {},
  action = "",
  actionPayload = {},
  payloadHash = "",
  commentsHash = "",
  attachmentsHash = "",
  existing = null,
  targetFieldVerification = {},
  childPlan = {},
} = {}) {
  const mismatches = (Array.isArray(targetFieldVerification?.mismatches) ? targetFieldVerification.mismatches : []).map((row) => ({
    field: row?.field || "",
    actual: row?.actual,
    expected: row?.expected,
  }));
  const childRows = (rows = []) => (Array.isArray(rows) ? rows : []).map((row) => ({
    id: row?.id || "",
    payloadHash: row?.payloadHash || "",
    status: row?.status || "",
  }));
  return hashStable({
    version: 1,
    key,
    action,
    actionPayload,
    payloadHash,
    commentsHash,
    attachmentsHash,
    target: {
      taskId: existing?.targetTaskId || existing?.target_task_id || "",
      uniqueId: existing?.targetUniqueId || existing?.target_unique_id || "",
    },
    targetFields: {
      checked: !!targetFieldVerification?.checked,
      mismatch: !!targetFieldVerification?.mismatch,
      mismatches,
    },
    childPlan: {
      needsSync: !!childPlan?.needsSync,
      comments: childRows(childPlan?.comments),
      attachments: childRows(childPlan?.attachments),
    },
  });
}

function preparedSyncStaleResult(item, action = "", preparedFingerprint = "") {
  return {
    ok: false,
    stale: true,
    action,
    item,
    preparedFingerprint,
    error: "预演结果已过期：飞书快照或 TB 当前状态已变化，请重新预演后确认。",
  };
}

function workItemSelectorsFromOptions(options = {}, cfg = {}, { includePoc = false } = {}) {
  const rawIds = normalizeSelectorList(
    options.workItemIds,
    options.workItemId,
    options.scope?.workItemIds,
    options.scope?.workItemId,
    includePoc ? cfg.pocWorkItemIds : [],
  );
  const explicitNos = normalizeSelectorList(
    options.workItemNos,
    options.workItemNo,
    options.problemNos,
    options.problemNo,
    options.sourceProblemNos,
    options.sourceProblemNo,
    options.scope?.workItemNos,
    options.scope?.workItemNo,
    options.scope?.problemNos,
    options.scope?.problemNo,
    options.scope?.sourceProblemNos,
    options.scope?.sourceProblemNo,
  );
  const workItemNos = [];
  const workItemIds = [];
  for (const id of rawIds) {
    if (isProblemNoLike(id)) workItemNos.push(normalizeProblemNo(id));
    else workItemIds.push(id);
  }
  workItemNos.push(...explicitNos.map(normalizeProblemNo).filter(Boolean));
  return {
    workItemIds: uniq(workItemIds),
    workItemNos: uniq(workItemNos),
  };
}

function normalizeSelectorList(...values) {
  return values.flatMap((value) => normalizeStringList(value)).map((value) => stringValue(value).trim()).filter(Boolean);
}

function normalizeProblemNo(value = "") {
  return stringValue(value).replace(/\s+/g, "").toUpperCase();
}

function isProblemNoLike(value = "") {
  return /^[A-Z][A-Z0-9]+-\d{2,}$/i.test(normalizeProblemNo(value));
}

async function fetchWorkItemsByProblemNos(client, problemNos = [], cfg = {}, options = {}, childOptions = {}) {
  const requested = uniq(problemNos.map(normalizeProblemNo).filter(Boolean));
  if (!requested.length) return { items: [], missing: [] };
  if (typeof client.fetchWorkItemsByProblemNos === "function") {
    const result = await client.fetchWorkItemsByProblemNos(requested, childOptions);
    const items = Array.isArray(result) ? result : (result?.items || []);
    const found = new Set(items.map((raw) => normalizeProblemNo(getSourceProblemNo(normalizeFeishuWorkItem(raw, cfg)))).filter(Boolean));
    return {
      items,
      missing: Array.isArray(result?.missing) ? result.missing : requested.filter((no) => !found.has(no)),
    };
  }
  if (typeof client.fetchWorkItems !== "function") {
    throw new Error("Feishu client does not support searching by problem number");
  }
  const items = [];
  const missing = [];
  const fetchBase = buildFeishuFetchOptions(cfg, { ...options, query: "" });
  const perNoLimit = clampLimit(options.problemNoCandidateLimit || options.scope?.problemNoCandidateLimit || cfg.sync?.problemNoCandidateLimit, 20, 200);
  const maxPages = clampLimit(options.problemNoSearchMaxPages || options.scope?.problemNoSearchMaxPages || cfg.sync?.problemNoSearchMaxPages, 3, 20);
  for (const no of requested) {
    const candidates = await client.fetchWorkItems({
      ...fetchBase,
      query: no,
      limit: perNoLimit,
      maxPages,
      includeComments: childOptions.includeComments,
      includeAttachments: childOptions.includeAttachments,
    });
    const match = (candidates || []).find((raw) => workItemMatchesProblemNo(raw, no, cfg));
    if (match) items.push(match);
    else missing.push(no);
  }
  return { items, missing };
}

function workItemMatchesProblemNo(raw, expectedNo, cfg = {}) {
  const expected = normalizeProblemNo(expectedNo);
  if (!expected) return false;
  const item = raw?.sourceWorkItemId ? raw : normalizeFeishuWorkItem(raw, cfg);
  const direct = [
    getSourceProblemNo(item),
    getSourceWorkItemNo(item),
    item.sourceWorkItemNo,
    item.problemNo,
  ].map(normalizeProblemNo).filter(Boolean);
  if (direct.includes(expected)) return true;
  const text = [
    item.title,
    item.sourceWorkItemUrl,
    item.sourceWorkItemId,
    JSON.stringify(item.raw || {}),
  ].filter(Boolean).join("\n");
  return problemNosFromText(text).map(normalizeProblemNo).includes(expected);
}

function problemNosFromText(text = "") {
  return String(text || "").match(/\b[A-Z][A-Z0-9]+-\d{2,}\b/gi) || [];
}

async function loadFeishuWorkItemsAcrossSourceViews(options = {}, cfg = {}, limit = 50, childOptions = {}) {
  const sourceViews = getFeishuSourceViews(cfg);
  if (!sourceViews.length) throw new Error("没有可用的飞书工单来源，请先在设置中添加并启用来源视图 URL");
  const selectors = childOptions.selectors || workItemSelectorsFromOptions(options, cfg, { includePoc: true });
  const selectedIds = selectors.workItemIds.slice(0, limit);
  const selectedNos = selectors.workItemNos.slice(0, Math.max(0, limit - selectedIds.length));
  const sourceBatches = [];
  const sourceResults = [];
  for (let index = 0; index < sourceViews.length; index += 1) {
    const sourceView = sourceViews[index];
    const sourceCfg = configForFeishuSourceView(cfg, sourceView);
    const client = typeof options.clientFactory === "function"
      ? await options.clientFactory(sourceCfg, sourceView, index)
      : options.client || new FeishuProjectClient(sourceCfg);
    const context = {
      projectKey: sourceView.sourceProjectKey,
      typeKey: sourceView.sourceWorkItemTypeKey,
      sourceView,
      sourceViewId: sourceView.viewId,
      sourceViewUrl: sourceView.url,
      url: sourceView.url,
    };
    syncProgress(options, {
      phase: "source-view-loading",
      level: "info",
      message: `正在读取飞书来源 ${index + 1}/${sourceViews.length}：${sourceView.name || sourceView.sourceWorkItemTypeKey || sourceView.viewId}`,
      sourceView,
      index: index + 1,
      total: sourceViews.length,
    });
    try {
      let items = [];
      let missingWorkItemNos = [];
      if (selectedIds.length || selectedNos.length) {
        const byId = selectedIds.length
          ? await client.fetchWorkItemsByIds(selectedIds, {
            ...context,
            includeComments: childOptions.includeComments,
            includeAttachments: childOptions.includeAttachments,
          })
          : [];
        const byNo = selectedNos.length
          ? await fetchWorkItemsByProblemNos(client, selectedNos, sourceCfg, { ...options, ...context }, {
            ...context,
            includeComments: childOptions.includeComments,
            includeAttachments: childOptions.includeAttachments,
          })
          : { items: [], missing: [] };
        missingWorkItemNos = byNo.missing || [];
        items = [...(byId || []), ...(byNo.items || [])];
      } else {
        items = await client.fetchWorkItems({
          limit,
          ...buildFeishuFetchOptions(sourceCfg, { ...options, ...context }),
          includeComments: childOptions.includeComments,
          includeAttachments: childOptions.includeAttachments,
        });
      }
      const annotatedItems = (items || []).map((raw) => annotateFeishuSourceWorkItem(raw, sourceView));
      sourceBatches.push({ sourceView, items: annotatedItems });
      sourceResults.push({
        ok: true,
        sourceView,
        requested: selectedIds.length + selectedNos.length || limit,
        returned: annotatedItems.length,
        missingWorkItemNos,
      });
    } catch (err) {
      sourceResults.push({
        ok: false,
        sourceView,
        requested: selectedIds.length + selectedNos.length || limit,
        returned: 0,
        error: err?.message || String(err),
      });
    }
  }
  const failedSources = sourceResults.filter((result) => result.ok === false);
  if (failedSources.length) {
    const err = new Error(`读取 ${failedSources.length}/${sourceViews.length} 个飞书工单来源失败：${failedSources.map((result) => `${result.sourceView?.name || result.sourceView?.viewId || "未命名来源"}（${result.error}）`).join("；")}`);
    err.code = "FEISHU_SOURCE_VIEWS_PARTIAL_FAILURE";
    err.partial = failedSources.length < sourceViews.length;
    err.sourceResults = sourceResults;
    throw err;
  }
  const items = mergeFeishuSourceWorkItems(sourceBatches, cfg, {
    ...options,
    limit,
  });
  const foundProblemNos = new Set(items
    .map((raw) => normalizeProblemNo(getSourceProblemNo(normalizeFeishuWorkItem(raw, cfg))))
    .filter(Boolean));
  return {
    items,
    sourceResults,
    missingWorkItemNos: selectedNos.filter((value) => !foundProblemNos.has(normalizeProblemNo(value))),
  };
}

export async function runFeishuProjectSync(options = {}) {
  assertExplicitFeishuSourceViewsConfig(options.config || {});
  const cfg = getFeishuProjectSyncConfig(options.config || {});
  const limit = Number(options.limit || options.scope?.limit || cfg.sync.batchSize || 50);
  const stopOnFirstError = shouldStopOnFirstError(options, cfg);
  const syncOptions = options.loader
    ? options
    : { ...options, loaderScope: options.loaderScope || {} };
  const selectors = workItemSelectorsFromOptions(options, cfg, { includePoc: true });
  const selection = { requested: 0, workItemIds: [], workItemNos: [], missingWorkItemNos: [], sourceResults: [] };
  let workItems;
  if (Array.isArray(options.workItems)) {
    workItems = options.workItems.slice(0, limit);
    selection.requested = workItems.length;
  } else if (selectors.workItemIds.length || selectors.workItemNos.length) {
    selection.workItemIds = selectors.workItemIds.slice(0, limit);
    const remaining = Math.max(0, limit - selection.workItemIds.length);
    selection.workItemNos = selectors.workItemNos.slice(0, remaining);
    selection.requested = selection.workItemIds.length + selection.workItemNos.length;
    const loaded = await loadFeishuWorkItemsAcrossSourceViews(options, cfg, limit, {
      selectors: {
        workItemIds: selection.workItemIds,
        workItemNos: selection.workItemNos,
      },
      includeComments: cfg.sync.includeComments,
      includeAttachments: cfg.sync.includeAttachments,
    });
    workItems = loaded.items;
    selection.missingWorkItemNos = loaded.missingWorkItemNos;
    selection.sourceResults = loaded.sourceResults;
  } else {
    const loaded = await loadFeishuWorkItemsAcrossSourceViews(options, cfg, limit, {
      selectors,
      includeComments: cfg.sync.includeComments,
      includeAttachments: cfg.sync.includeAttachments,
    });
    workItems = loaded.items;
    selection.sourceResults = loaded.sourceResults;
    selection.requested = workItems.length;
  }
  syncProgress(options, { phase: "items-loaded", level: "info", message: `已读取 ${workItems.length} 条候选飞书单`, total: workItems.length });
  const results = [];
  for (let index = 0; index < workItems.length; index++) {
    const raw = workItems[index];
    syncProgress(options, { phase: "item-queued", level: "info", message: `处理第 ${index + 1}/${workItems.length} 条`, index: index + 1, total: workItems.length });
    const result = await syncFeishuProjectWorkItem(raw, syncOptions);
    results.push(result);
    if (result?.ok === false && stopOnFirstError) {
      syncProgress(options, { phase: "stopped", level: "error", message: "遇到第一条失败，已停止后续同步", error: result.error || "", index: index + 1, total: workItems.length });
      break;
    }
  }
  if (typeof options.onPreparedItems === "function") {
    options.onPreparedItems({
      source: "plugin",
      workItems: workItems.slice(0, results.length),
      results,
      config: cfg,
      loaderScope: syncOptions.loaderScope || {},
      sheetTargetByProblemNo: options.sheetTargetByProblemNo || {},
    });
  }
  return summarizeResults(results, {
    requested: selection.requested || workItems.length,
    selection,
    stoppedOnFirstError: stopOnFirstError && results.some((r) => r?.ok === false) && results.length < workItems.length,
  });
}

export async function refreshFeishuProjectSyncSourceRecords(options = {}) {
  const cfg = getFeishuProjectSyncConfig(options.config || {});
  const limit = Number(options.limit || options.scope?.limit || cfg.sync.batchSize || 50);
  const loaded = await loadFeishuProjectWorkItemsForSync(options, cfg, limit);
  const workItems = loaded.items;
  syncProgress(options, { phase: "items-loaded", level: "info", message: `已读取 ${workItems.length} 条候选飞书单`, total: workItems.length });
  const results = [];
  const skipped = [];
  const refreshed = [];
  const refreshedKeys = new Set();
  const removedUnsyncedKeys = new Set();
  const hiddenSyncedKeys = new Set();
  const restoredVisibleKeys = new Set();
  const selectors = workItemSelectorsFromOptions(options, cfg, { includePoc: false });
  const capturedScopes = (loaded.sourceResults || [])
    .filter((result) => result?.ok !== false)
    .map((result) => ({
      projectKey: result.projectKey || result.sourceView?.sourceProjectKey,
      typeKey: result.workItemTypeKey || result.typeKey || result.sourceView?.sourceWorkItemTypeKey,
    }))
    .filter((scope) => scope.projectKey && scope.typeKey);
  const itemScopes = workItems
    .map((raw) => syncKey(normalizeFeishuWorkItem(raw, cfg)))
    .map((key) => ({
      projectKey: key.sourceProjectKey,
      typeKey: key.sourceWorkItemTypeKey,
    }))
    .filter((scope) => scope.projectKey && scope.typeKey);
  // 快照清理必须跟随本次实际抓取到的来源。调用方显式传入 workItems 时，
  // 不能回退到进程里的全局来源配置，否则会误隐藏其他项目/工单类型的历史映射。
  const configuredScopes = Array.isArray(options.workItems)
    ? []
    : getFeishuSourceViews(cfg).map((sourceView) => ({
      projectKey: sourceView.sourceProjectKey,
      typeKey: sourceView.sourceWorkItemTypeKey,
    }));
  const snapshotScopes = uniqueRows(
    capturedScopes.length ? capturedScopes : (itemScopes.length ? itemScopes : configuredScopes),
    (scope) => `${normKey(scope.projectKey)}:${normKey(scope.typeKey)}`,
  );
  const snapshotReconciled = options.reconcileSnapshot === true
    && options.snapshotComplete === true
    && selectors.workItemIds.length === 0
    && selectors.workItemNos.length === 0
    && snapshotScopes.length > 0;

  for (let index = 0; index < workItems.length; index += 1) {
    const raw = workItems[index];
    const item = normalizeFeishuWorkItem(raw, cfg);
    const key = syncKey(item);
    const sourceProblemNo = getSourceProblemNo(item);
    const sourceWorkItemNo = getSourceWorkItemNo(item);
    const sourceKeyId = sourceIdFromSyncKey(key);
    const sourceIdentity = {
      sourceProblemNo,
      problemNo: sourceProblemNo,
      sourceWorkItemNo,
    };
    const hasKey = !!(key.sourceProjectKey && key.sourceWorkItemTypeKey && key.sourceWorkItemId);
    const existing = hasKey ? getFeishuProjectSyncState(key) : null;
    syncProgress(options, { phase: "item-queued", level: "info", item, message: `更新第 ${index + 1}/${workItems.length} 条飞书单`, index: index + 1, total: workItems.length });
    const sourceScope = checkSourceScope(item, cfg);
    const assigneeScope = sourceScope.ok ? checkRequiredAssigneeScope(item, cfg) : null;
    const failedScope = sourceScope.ok ? assigneeScope : sourceScope;
    if (failedScope && !failedScope.ok) {
      let cleanupAction = "none";
      if (snapshotReconciled && existing && syncRecordWasEverSynced(existing)) {
        const sourcePayloadHash = hashStable({ item: hashableSyncItem(item), sourceOnly: true });
        insertFeishuProjectRawPayload({ ...key, payloadHash: sourcePayloadHash, payloadJson: raw });
        upsertFeishuProjectSyncSourceRecord({
          ...key,
          ...sourceIdentity,
          sourceWorkItemUrl: item.sourceWorkItemUrl,
          sourceUpdatedAt: item.updatedAt,
          sourceInScope: false,
        });
        if (existing.sourceInScope !== false) hiddenSyncedKeys.add(sourceKeyId);
        cleanupAction = "hide-synced";
      } else if (snapshotReconciled && existing) {
        const deleted = deleteFeishuProjectSyncRecords([existing]);
        if (deleted.records) removedUnsyncedKeys.add(sourceKeyId);
        cleanupAction = deleted.records ? "delete-unsynced" : "none";
      }
      const row = {
        ok: true,
        action: "skip",
        skipped: true,
        reason: failedScope.reason,
        item,
        cleanupAction,
      };
      skipped.push(row);
      results.push(row);
      continue;
    }
    if (!key.sourceProjectKey || !key.sourceWorkItemTypeKey || !key.sourceWorkItemId) {
      const row = {
        ok: false,
        action: "skip",
        skipped: true,
        reason: "Feishu work item id is missing",
        item,
      };
      skipped.push(row);
      results.push(row);
      continue;
    }
    const sourcePayloadHash = hashStable({ item: hashableSyncItem(item), sourceOnly: true });
    insertFeishuProjectRawPayload({ ...key, payloadHash: sourcePayloadHash, payloadJson: raw });
    const state = upsertFeishuProjectSyncSourceRecord({
      ...key,
      ...sourceIdentity,
      sourceWorkItemUrl: item.sourceWorkItemUrl,
      sourceUpdatedAt: item.updatedAt,
      sourceInScope: true,
    });
    refreshedKeys.add(sourceKeyId);
    if (existing?.sourceInScope === false) restoredVisibleKeys.add(sourceKeyId);
    const row = {
      ok: true,
      action: "refresh-source-record",
      item,
      state,
      sourceWorkItemId: item.sourceWorkItemId,
      sourceProblemNo,
      sourceWorkItemNo,
    };
    refreshed.push(row);
    results.push(row);
  }

  if (snapshotReconciled) {
    for (const scope of snapshotScopes) {
      const existingRecords = listFeishuProjectSyncStates({
        projectKey: scope.projectKey,
        typeKey: scope.typeKey,
        limit: 1000,
      });
      for (const record of existingRecords) {
        const keyId = sourceIdFromSyncKey({
          sourceProjectKey: record.sourceProjectKey || scope.projectKey,
          sourceWorkItemTypeKey: record.sourceWorkItemTypeKey || scope.typeKey,
          sourceWorkItemId: record.sourceWorkItemId,
        });
        if (!record.sourceWorkItemId || refreshedKeys.has(keyId) || removedUnsyncedKeys.has(keyId)) continue;
        if (syncRecordWasEverSynced(record)) {
          if (record.sourceInScope !== false) {
            upsertFeishuProjectSyncSourceRecord({ ...record, sourceInScope: false });
            hiddenSyncedKeys.add(keyId);
          }
        } else {
          const deleted = deleteFeishuProjectSyncRecords([record]);
          if (deleted.records) removedUnsyncedKeys.add(keyId);
        }
      }
    }
  }

  return {
    ok: !results.some((row) => row.ok === false),
    source: options.source || "feishu-project",
    mode: "refresh-source-records",
    dryRun: false,
    total: results.length,
    requested: workItems.length,
    refreshed: refreshed.length,
    skippedCount: skipped.length,
    snapshotComplete: options.snapshotComplete === true,
    snapshotReconciled,
    sourceResults: loaded.sourceResults || [],
    removedUnsynced: removedUnsyncedKeys.size,
    hiddenSynced: hiddenSyncedKeys.size,
    restoredVisible: restoredVisibleKeys.size,
    failed: results.filter((row) => row.ok === false).length,
    firstError: results.find((row) => row.ok === false)?.reason || "",
    results,
    skipped,
  };
}

function syncRecordWasEverSynced(row = {}) {
  return !!String(row.targetTaskId || row.target_task_id || row.targetUniqueId || row.target_unique_id || row.lastSyncedAt || row.last_synced_at || "").trim();
}

async function loadFeishuProjectWorkItemsForSync(options = {}, cfg = {}, limit = 50) {
  const selectors = workItemSelectorsFromOptions(options, cfg, { includePoc: true });
  if (Array.isArray(options.workItems)) {
    return {
      items: options.workItems.slice(0, limit),
      sourceResults: Array.isArray(options.sourceResults) ? options.sourceResults : [],
    };
  }
  return loadFeishuWorkItemsAcrossSourceViews(options, cfg, limit, {
    selectors,
    includeComments: cfg.sync.includeComments,
    includeAttachments: cfg.sync.includeAttachments,
  });
}

export async function detectFeishuProjectDuplicateTasks(options = {}) {
  const cfg = getFeishuProjectSyncConfig(options.config || {});
  const limit = clampLimit(options.limit || options.scope?.limit || cfg.sync.batchSize, 50, 1000);
  const loader = resolveLoader(options);
  const loaded = await loadDuplicateCheckWorkItems(options, cfg, limit);
  const workItems = loaded.items;
  const searchAllProjects = parseBooleanOption(options.searchAllProjects ?? options.scope?.searchAllProjects ?? cfg.sync?.duplicateSearchAllProjects, true);
  const activeScopes = uniqueRows(getFeishuSourceViews(cfg).map((sourceView) => ({
    projectKey: sourceView.sourceProjectKey,
    typeKey: sourceView.sourceWorkItemTypeKey,
  })), (scope) => `${normKey(scope.projectKey)}:${normKey(scope.typeKey)}`);
  const singleScope = activeScopes.length === 1 ? activeScopes[0] : {};
  const stateIndex = buildDuplicateSyncStateIndex(cfg, {
    projectKey: options.projectKey || options.scope?.projectKey || singleScope.projectKey || "",
    typeKey: options.typeKey || options.scope?.typeKey || singleScope.typeKey || "",
    limit: clampLimit(options.stateLimit || options.scope?.stateLimit || Math.max(limit * 5, 1000), 1000, 10000),
  });
  const duplicates = [];
  const skipped = [];
  let inspected = 0;

  for (const raw of workItems) {
    const item = normalizeFeishuWorkItem(raw, cfg);
    const key = syncKey(item);
    const sourceId = sourceIdFromSyncKey(key);
    const identity = duplicateIdentityForItem(item, key);
    const sourceScope = checkSourceScope(item, cfg);
    if (!sourceScope.ok) {
      skipped.push({ sourceId, sourceKey: key, reason: sourceScope.reason });
      continue;
    }
    const assigneeScope = checkRequiredAssigneeScope(item, cfg);
    if (!assigneeScope.ok) {
      skipped.push({ sourceId, sourceKey: key, reason: assigneeScope.reason });
      continue;
    }
    const { payload } = buildTeambitionTaskPayload(item, cfg);
    const findCfg = searchAllProjects
      ? { ...cfg, teambition: { ...(cfg.teambition || {}), projectId: "" } }
      : payload.projectId
      ? { ...cfg, teambition: { ...(cfg.teambition || {}), projectId: payload.projectId } }
      : cfg;
    let tasks = [];
    if (loader?.findTasksBySourceId) {
      tasks = await loader.findTasksBySourceId(sourceId, findCfg);
    } else if (loader?.findTaskBySourceId) {
      const single = await loader.findTaskBySourceId(sourceId, findCfg);
      tasks = single ? [single] : [];
    }
    tasks = (tasks || []).map((task) => ({ ...task, matchedBy: task?.matchedBy || "source-id", matchedValue: task?.matchedValue || sourceId }));
    for (const token of identity.textTokens) {
      if (!loader?.findTasksByTextToken) break;
      const matches = await loader.findTasksByTextToken(token, findCfg);
      tasks.push(...(matches || []).map((task) => ({ ...task, matchedBy: "feishu-work-item-id", matchedValue: token })));
    }
    tasks.push(...duplicateStateTasksForIdentity(stateIndex, identity));
    inspected += 1;
    const normalizedTasks = uniqueRows((tasks || [])
      .map(normalizeDuplicateTask)
      .filter((task) => task.id), (task) => task.id);
    if (normalizedTasks.length < 2) continue;
    const existing = getFeishuProjectSyncState(key);
    const existingTargetId = existing?.targetTaskId || "";
    const recommendedTargetTaskId = normalizedTasks.some((task) => task.id === existingTargetId)
      ? existingTargetId
      : normalizedTasks[0].id;
    duplicates.push({
      sourceId,
      sourceKey: key,
      sourceWorkItemId: item.sourceWorkItemId,
      sourceProblemNo: identity.sourceProblemNo,
      problemNo: identity.sourceProblemNo,
      sourceWorkItemNo: identity.sourceWorkItemNo,
      sourceWorkItemUrl: item.sourceWorkItemUrl,
      duplicateKey: identity.primaryKey,
      duplicateMatchValues: identity.searchValues,
      title: item.title,
      targetProjectId: payload.projectId || cfg.teambition?.projectId || "",
      targetTitle: payload.content || "",
      recommendedTargetTaskId,
      existingTargetTaskId: existingTargetId,
      tasks: normalizedTasks,
    });
  }

  return {
    ok: true,
    total: workItems.length,
    inspected,
    skipped,
    skippedCount: skipped.length,
    sourceResults: loaded.sourceResults || [],
    hasDuplicates: duplicates.length > 0,
    duplicates,
  };
}

export async function mergeFeishuProjectDuplicateTasks(options = {}) {
  const cfg = getFeishuProjectSyncConfig(options.config || {});
  const loader = resolveLoader(options);
  const sourceKey = duplicateMergeSourceKey(options, cfg);
  const sourceId = options.sourceId || sourceIdFromSyncKey(sourceKey);
  if (!sourceKey.sourceProjectKey || !sourceKey.sourceWorkItemTypeKey || !sourceKey.sourceWorkItemId) {
    throw new Error("sourceKey/sourceId is required");
  }
  const targetTaskId = String(options.targetTaskId || options.target_task_id || "").trim();
  if (!targetTaskId) throw new Error("targetTaskId is required");
  const duplicateTaskIds = uniq([
    ...(Array.isArray(options.duplicateTaskIds) ? options.duplicateTaskIds : []),
    ...(Array.isArray(options.duplicate_task_ids) ? options.duplicate_task_ids : []),
    ...(Array.isArray(options.taskIds) ? options.taskIds : []),
  ].map(String).map((id) => id.trim()).filter(Boolean));
  const toDelete = duplicateTaskIds.filter((id) => id && id !== targetTaskId);
  const deleteDuplicateTasks = parseBooleanOption(options.deleteDuplicateTasks ?? options.deleteDuplicates, false);
  const targetUniqueId = String(options.targetUniqueId || options.target_unique_id || "").trim();
  const repointed = repointFeishuProjectSyncTarget(sourceKey, {
    targetTaskId,
    targetUniqueId,
    targetUpdatedAt: options.targetUpdatedAt || options.target_updated_at || "",
    syncStatus: "success",
    lastError: "",
  });

  const commentText = formatDuplicateMergeComment({
    sourceId,
    targetTaskId,
    duplicateTaskIds: toDelete,
    deleteDuplicateTasks,
  });
  let comment = null;
  let commentError = "";
  if (loader?.postComment) {
    try {
      comment = await loader.postComment(targetTaskId, commentText, cfg);
    } catch (err) {
      commentError = err?.message || String(err);
      log("system", "warn", "feishu-project-sync", `duplicate merge comment failed ${targetTaskId}: ${commentError}`);
    }
  }

  const deleted = [];
  const deleteErrors = [];
  if (deleteDuplicateTasks) {
    if (!loader?.deleteTask) {
      deleteErrors.push({ taskId: "", error: "Teambition loader deleteTask is not configured" });
    } else {
      for (const taskId of toDelete) {
        try {
          const result = await loader.deleteTask(taskId, cfg);
          deleted.push({ taskId, result });
        } catch (err) {
          deleteErrors.push({ taskId, error: err?.message || String(err) });
        }
      }
    }
  }

  return {
    ok: deleteErrors.length === 0,
    sourceId,
    sourceKey,
    targetTaskId,
    duplicateTaskIds: toDelete,
    deleteDuplicateTasks,
    repointed,
    comment,
    commentError,
    deleted,
    deleteErrors,
  };
}

export async function backfillFeishuProjectSync(options = {}) {
  const cfg = getFeishuProjectSyncConfig(options.config || {});
  const limit = clampLimit(options.limit || options.scope?.limit || cfg.sync.batchSize, 50, 1000);
  const retryErrors = options.retryErrors !== false;
  const retryableErrors = retryErrors
    ? listFeishuProjectRetryableSyncErrors({
      projectKey: options.projectKey || options.scope?.projectKey,
      typeKey: options.typeKey || options.scope?.typeKey,
      workItemId: options.workItemId || options.scope?.workItemId,
      stage: options.stage || options.scope?.stage,
      includeFuture: options.includeFuture === true || options.scope?.includeFuture === true,
      limit,
    })
    : [];
  const explicitIds = [
    ...(Array.isArray(options.workItemIds) ? options.workItemIds : []),
    ...(Array.isArray(options.scope?.workItemIds) ? options.scope.workItemIds : []),
    options.workItemId || options.scope?.workItemId || "",
  ].map(String).filter(Boolean);
  const workItemIds = uniq([
    ...explicitIds,
    ...retryableErrors.map((row) => row.sourceWorkItemId).filter(Boolean),
  ]).slice(0, limit);
  const rawPayloadReplay = options.useRawPayloads === true || options.source === "raw-payloads";
  const rawWorkItems = !options.workItems && rawPayloadReplay && workItemIds.length
    ? workItemIds.map((id) => readLatestRawPayload({
      projectKey: options.projectKey || options.scope?.projectKey || cfg.feishu.spaceKey,
      typeKey: options.typeKey || options.scope?.typeKey || cfg.feishu.workItemTypeKey,
      workItemId: id,
    })).filter(Boolean)
    : null;
  const result = await runFeishuProjectSync({
    ...options,
    limit,
    scope: { ...(options.scope || {}), limit },
    workItemIds,
    workItems: options.workItems || rawWorkItems || undefined,
  });
  return {
    ok: !!result.ok,
    mode: rawPayloadReplay && rawWorkItems?.length ? "raw-payload-backfill" : "backfill",
    selected: {
      retryableErrors: retryableErrors.length,
      workItemIds,
      rawPayloads: rawWorkItems?.length || 0,
    },
    result,
  };
}

export async function handleFeishuProjectWebhook(body, options = {}) {
  const workItem = body?.work_item || body?.workItem || body?.event?.work_item || body?.event?.workItem || null;
  if (workItem) {
    const result = await syncFeishuProjectWorkItem(workItem, options);
    return { accepted: true, mode: "inline-work-item", result };
  }
  const workItemId = getFirst(body || {}, ["work_item_id", "workItemId", "id"]) || getFirst(body?.event || {}, ["work_item_id", "workItemId", "id"]);
  if (!workItemId) return { accepted: true, mode: "ignored", reason: "no work item id in webhook" };
  const client = new FeishuProjectClient(options.config || {});
  if (!client.isReady()) return { accepted: true, mode: "queued", workItemId, reason: "credentials incomplete" };
  const cfg = getFeishuProjectSyncConfig(options.config || {});
  const detail = await client.hydrateWorkItem({ work_item_id: workItemId }, {
    includeComments: cfg.sync.includeComments,
    includeAttachments: cfg.sync.includeAttachments,
  });
  const result = await syncFeishuProjectWorkItem(detail, options);
  return { accepted: true, mode: "fetched-detail", result };
}

export function listFeishuProjectSyncRecords(query = {}) {
  const cfg = getFeishuProjectSyncConfig(query.config || {});
  const rows = listFeishuProjectSyncStates(query);
  if (!parseBooleanOption(query.enrich, true)) return rows;
  return rows.map((row) => enrichFeishuProjectSyncRecord(row, cfg));
}

export function listFeishuProjectSyncRecordsSince(since = 0, query = {}) {
  const cfg = getFeishuProjectSyncConfig(query.config || {});
  return listFeishuProjectSyncStatesSince(since, query).map((row) => enrichFeishuProjectSyncRecord(row, cfg));
}

export async function verifyFeishuProjectSyncTargets(query = {}) {
  const limit = clampLimit(query.limit, 100, 1000);
  const projectKey = query.projectKey || query.sourceProjectKey || "";
  const typeKey = query.typeKey || query.sourceWorkItemTypeKey || "";
  const workItemId = query.workItemId || query.sourceWorkItemId || "";
  const resetMissingTargets = parseBooleanOption(query.resetMissingTargets ?? query.reset_missing_targets, true);
  const cfg = getFeishuProjectSyncConfig(query.config || {});
  const loader = resolveLoader(query);
  const records = (query.records || listFeishuProjectSyncStates({ projectKey, typeKey, limit }))
    .filter((row) => (!workItemId || row.sourceWorkItemId === workItemId) && row.targetTaskId);
  const rows = uniqueRows(records, (row) => row.targetTaskId).slice(0, limit);
  const existing = [];
  const missing = [];
  const reset = [];
  const errors = [];

  for (const row of rows) {
    const targetTaskId = row.targetTaskId;
    try {
      const checked = loader?.checkTaskExists
        ? await loader.checkTaskExists(targetTaskId, cfg)
        : { exists: !!(await loader.getTaskDetail(targetTaskId, cfg)) };
      if (checked === false || checked?.exists === false) {
        missing.push({ ...row, targetTaskId, check: cleanObject({ source: checked?.source, status: checked?.status, reason: checked?.reason }) });
        if (resetMissingTargets) {
          const result = resetFeishuProjectSyncTarget(row, { targetTaskId, syncStatus: "pending", lastError: "" });
          reset.push({ ...row, targetTaskId, reset: result });
        }
      } else {
        existing.push({ ...row, targetTaskId, check: cleanObject({ source: checked?.source, status: checked?.status, reason: checked?.reason }) });
      }
    } catch (err) {
      errors.push({ ...row, targetTaskId, error: err?.message || String(err) });
    }
  }

  return {
    checked: rows.length,
    existingCount: existing.length,
    missingCount: missing.length,
    resetCount: reset.length,
    existing,
    missing,
    reset,
    errors,
  };
}

function enrichFeishuProjectSyncRecord(row = {}, cfg = {}) {
  const raw = readLatestRawPayload(row);
  let sourceProblemNo = row.sourceProblemNo || row.source_problem_no || row.problemNo || row.problem_no || "";
  let sourceWorkItemNo = row.sourceWorkItemNo || row.source_work_item_no || "";
  let scopeStatus = null;
  if (raw) {
    try {
      const item = normalizeFeishuWorkItem(raw, cfg);
      sourceProblemNo = getSourceProblemNo(item) || sourceProblemNo;
      sourceWorkItemNo = getSourceWorkItemNo(item) || sourceWorkItemNo;
      const sourceScope = checkSourceScope(item, cfg);
      const assigneeScope = sourceScope.ok ? checkRequiredAssigneeScope(item, cfg) : null;
      const failedScope = sourceScope.ok ? assigneeScope : sourceScope;
      if (failedScope && !failedScope.ok) {
        scopeStatus = buildOutOfScopeStatus(item, cfg, failedScope, row, {
          sourceProjectKey: row.sourceProjectKey || row.source_project_key || cfg.feishu?.spaceKey || "",
          sourceWorkItemTypeKey: row.sourceWorkItemTypeKey || row.source_work_item_type_key || cfg.feishu?.workItemTypeKey || "",
          sourceWorkItemId: row.sourceWorkItemId || row.source_work_item_id || "",
        });
      }
    } catch {}
  }
  if (row.sourceInScope === false) {
    scopeStatus = {
      ...(scopeStatus || {}),
      state: "transferred",
      transitioned: true,
      hidden: true,
      message: scopeStatus?.message || "该飞书工单已不在当前筛选结果中；同步映射已保留，列表默认隐藏。",
      bookmarks: scopeStatus?.bookmarks?.length ? scopeStatus.bookmarks : ["已流转"],
    };
  }
  return {
    ...row,
    sourceProblemNo,
    problemNo: sourceProblemNo,
    sourceWorkItemNo: sourceProblemNo || sourceWorkItemNo,
    sourceInScope: row.sourceInScope !== false,
    hidden: row.sourceInScope === false || scopeStatus?.state === "transferred",
    scopeStatus: scopeStatus || undefined,
    bookmarks: scopeStatus?.bookmarks?.length ? scopeStatus.bookmarks : undefined,
  };
}

export function listFeishuProjectRawPayloadRecords(query = {}) {
  return listFeishuProjectRawPayloads(query);
}

export function listFeishuProjectCommentSyncRecords(query = {}) {
  return listFeishuProjectCommentSyncRows(query);
}

export function listFeishuProjectAttachmentSyncRecords(query = {}) {
  return listFeishuProjectAttachmentSyncRows(query);
}

export function listFeishuProjectRetryableErrorRecords(query = {}) {
  return listFeishuProjectRetryableSyncErrors(query);
}

export async function reconcileFeishuProjectSync(query = {}) {
  const limit = clampLimit(query.limit, 200, 1000);
  const projectKey = query.projectKey || query.sourceProjectKey || "";
  const typeKey = query.typeKey || query.sourceWorkItemTypeKey || "";
  const workItemId = query.workItemId || query.sourceWorkItemId || "";
  let records = listFeishuProjectSyncStates({ projectKey, typeKey, limit })
    .filter((row) => !workItemId || row.sourceWorkItemId === workItemId);
  const targetVerification = parseBooleanOption(query.verifyTargets ?? query.verify_targets, false)
    ? await verifyFeishuProjectSyncTargets({
      ...query,
      records,
      projectKey,
      typeKey,
      workItemId,
      limit,
      resetMissingTargets: query.resetMissingTargets ?? query.reset_missing_targets ?? true,
    })
    : null;
  if (targetVerification?.resetCount) {
    records = listFeishuProjectSyncStates({ projectKey, typeKey, limit })
      .filter((row) => !workItemId || row.sourceWorkItemId === workItemId);
  }
  const openErrors = listFeishuProjectSyncErrorRows({ projectKey, typeKey, workItemId, status: query.errorStatus || "open", limit });
  const retryableErrors = listFeishuProjectRetryableSyncErrors({
    projectKey,
    typeKey,
    workItemId,
    includeFuture: query.includeFuture === true || query.includeFuture === "true",
    limit,
  });
  const failedComments = listFeishuProjectCommentSyncRows({ projectKey, typeKey, workItemId, status: "failed", limit });
  const failedAttachments = listFeishuProjectAttachmentSyncRows({ projectKey, typeKey, workItemId, status: "failed", limit });
  const rawPayloads = listFeishuProjectRawPayloads({ projectKey, typeKey, workItemId, limit: Math.min(limit, 100) });
  const recordsWithoutTarget = records.filter((row) => row.syncStatus === "success" && !row.targetTaskId);
  const problemRecords = uniqueRows([
    ...records.filter((row) => row.syncStatus && row.syncStatus !== "success"),
    ...recordsWithoutTarget,
  ], (row) => `${row.sourceProjectKey}/${row.sourceWorkItemTypeKey}/${row.sourceWorkItemId}`).slice(0, limit);
  const targetTaskIds = uniq(records.map((row) => row.targetTaskId).filter(Boolean));
  return {
    generatedAt: new Date().toISOString(),
    query: cleanObject({ projectKey, typeKey, workItemId, limit }),
    readiness: getFeishuProjectSyncReadiness(),
    summary: {
      sourceRecordCount: records.length,
      targetTaskCount: targetTaskIds.length,
      recordsWithoutTarget: recordsWithoutTarget.length,
      openErrorCount: openErrors.length,
      retryableErrorCount: retryableErrors.length,
      failedCommentCount: failedComments.length,
      failedAttachmentCount: failedAttachments.length,
      rawPayloadCount: rawPayloads.length,
    },
    statusCounts: countBy(records, (row) => row.syncStatus || "unknown"),
    problemRecords,
    errors: { open: openErrors, retryable: retryableErrors },
    childRecords: { failedComments, failedAttachments },
    rawPayloads,
    targetVerification,
  };
}

function defaultLoader(options = {}) {
  const taskSearch = createTeambitionTaskSearchSession({ maxPages: 10 });
  return {
    createTask: (payload, cfg) => createTeambitionTask(payload, { path: cfg.teambition.createTaskPath }),
    updateTask: (taskId, payload, cfg) => updateTeambitionTask(taskId, payload, { path: cfg.teambition.updateTaskPath }),
    updateCustomFields: (taskId, customfields, cfg, writeOptions = {}) => updateTeambitionTaskCustomFields(taskId, customfields, {
      pathTemplate: cfg.teambition.customFieldsPathTemplate,
      operatorId: writeOptions.operatorId,
    }),
    updateTags: (taskId, tagIds, cfg) => updateTeambitionTaskTags(taskId, tagIds, { pathTemplate: cfg.teambition.tagsPathTemplate }),
    enforceWrittenFieldVerification: true,
    getTaskDetail: (taskId) => getTaskDetail(taskId),
    getTaskNote: (taskId) => getTaskNote(taskId),
    getTaskComments: (taskId) => getTaskComments(taskId, "comment"),
    checkTaskExists: (taskId) => getTeambitionTaskExistence(taskId),
    listTasklists: (projectId) => listProjectTasklists(projectId),
    listSprints: (projectId) => listProjectSprints(projectId),
    getTasklist: (tasklistId, projectId) => getProjectTasklist(tasklistId, projectId),
    getSprint: (sprintId, projectId) => getProjectSprint(sprintId, projectId),
    listMembers: (projectId) => listProjectMembers(projectId),
    listProjectTags: (projectId) => listProjectTags(projectId),
    listTaskCustomFieldDefs: (projectId) => listTeambitionTaskCustomFieldDefs({ projectId }),
    findTaskByContent: (content, cfg) => taskSearch.findByContent(content, { projectId: cfg.teambition?.projectId }),
    findTaskBySourceId: (sourceId, cfg) => taskSearch.findBySourceId(sourceId, { projectId: cfg.teambition?.projectId }),
    findTasksBySourceId: (sourceId, cfg) => taskSearch.findAllBySourceId(sourceId, { projectId: cfg.teambition?.projectId }),
    findTasksByTextToken: (token, cfg) => taskSearch.findAllByTextToken(token, { projectId: cfg.teambition?.projectId }),
    deleteTask: (taskId) => deleteTeambitionTask(taskId),
    postComment: (taskId, content, cfg) => postTaskComment(taskId, content, { pathTemplate: cfg.teambition.commentPathTemplate }),
    syncAttachment: async (taskId, attachment, item, cfg) => {
      const mode = String(cfg.sync.attachmentMode || "upload").toLowerCase();
      if (mode === "skip" || mode === "none") return { skipped: true };
      if (["upload", "download_upload", "file_upload"].includes(mode)) {
        return uploadFeishuAttachmentToTeambition(taskId, attachment, item, cfg, {
          refreshDownload: options.refreshAttachmentDownload,
        });
      }
      return postTaskComment(taskId, formatAttachmentComment(attachment, item), { pathTemplate: cfg.teambition.commentPathTemplate });
    },
  };
}

function resolveLoader(options = {}) {
  if (options.loader) return options.loader;
  const scope = options.loaderScope;
  if (scope && typeof scope === "object") {
    if (!scope.defaultLoader) scope.defaultLoader = defaultLoader(scope);
    return scope.defaultLoader;
  }
  return defaultLoader();
}

class FeishuProjectLoaderError extends Error {
  constructor(failures = []) {
    const summary = failures.map((f) => `${f.stage}:${f.sourceId} ${f.error}`).join("; ");
    super(`Teambition loader child sync failed: ${summary}`);
    this.name = "FeishuProjectLoaderError";
    this.stage = "child-sync";
    this.failures = failures;
  }
}

function isFatalChildFailure(failure, cfg) {
  if (failure.stage === "comment") return cfg.sync.failOnCommentError !== false;
  if (failure.stage === "attachment") return cfg.sync.failOnAttachmentError !== false;
  return true;
}

function getChildSyncPlan(item, cfg, targetCommentContext = null) {
  const plan = { needsSync: false, comments: [], attachments: [] };
  if (cfg.sync.includeComments) {
    for (const comment of item.comments || []) {
      if (!comment.id) continue;
      const key = { ...syncKey(item), sourceCommentId: comment.id };
      const existing = getFeishuProjectCommentSync(key);
      const targetComment = findMatchingTargetComment(targetCommentContext, comment, item);
      if (!isSuccessfulChildSync(existing, comment.payloadHash) && targetComment) {
        plan.comments.push(cleanObject({
          id: comment.id,
          payloadHash: comment.payloadHash,
          status: "target-existing",
          targetCommentId: targetComment.id,
          reason: "target-comment-exists",
        }));
        continue;
      }
      if (!isSuccessfulChildSync(existing, comment.payloadHash)) {
        plan.comments.push({ id: comment.id, payloadHash: comment.payloadHash, status: syncRowStatus(existing) || "missing" });
      }
    }
  }
  if (cfg.sync.includeAttachments) {
    for (const attachment of item.attachments || []) {
      if (!attachment.id) continue;
      const key = { ...syncKey(item), sourceAttachmentId: attachment.id };
      const existing = getFeishuProjectAttachmentSync(key);
      if (!isSuccessfulChildSync(existing, attachment.payloadHash)) {
        plan.attachments.push({ id: attachment.id, payloadHash: attachment.payloadHash, status: syncRowStatus(existing) || "missing" });
      }
    }
  }
  plan.needsSync = plan.comments.some(childPlanRowNeedsSync) || plan.attachments.some(childPlanRowNeedsSync);
  return attachTargetCommentContext(plan, targetCommentContext);
}

function childPlanRowNeedsSync(row = {}) {
  const status = stringValue(row.status).toLowerCase();
  return !["success", "target-existing", "duplicate", "already-exists"].includes(status);
}

function isSuccessfulChildSync(row, payloadHash) {
  return syncRowStatus(row) === "success" && syncRowPayloadHash(row) === payloadHash;
}

function syncRowStatus(row) {
  return row?.syncStatus || row?.sync_status || "";
}

function syncRowPayloadHash(row) {
  return row?.sourcePayloadHash || row?.source_payload_hash || "";
}

function persistTargetExistingCommentSyncs(item, targetTaskId, childPlan = {}) {
  for (const row of childPlan.comments || []) {
    if (stringValue(row.status) !== "target-existing") continue;
    const key = { ...syncKey(item), sourceCommentId: row.id };
    upsertFeishuProjectCommentSync({
      ...key,
      targetTaskId,
      targetCommentId: row.targetCommentId || "",
      sourcePayloadHash: row.payloadHash || "",
      syncStatus: "success",
      lastError: "",
    });
    resolveFeishuProjectSyncErrors({
      ...key,
      stage: "comment",
      targetObjectType: "comment",
      sourceChildId: row.id,
    });
  }
}

async function syncComments(item, targetTaskId, loader, payloadHash, cfg, targetCommentContext = null) {
  const failures = [];
  const commentContext = targetCommentContext || await readTargetCommentContext(targetTaskId, loader, cfg);
  for (const comment of item.comments.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))) {
    if (!comment.id) continue;
    const key = { ...syncKey(item), sourceCommentId: comment.id };
    const existing = getFeishuProjectCommentSync(key);
    if (isSuccessfulChildSync(existing, comment.payloadHash)) continue;
    try {
      const existingTargetComment = findMatchingTargetComment(commentContext, comment, item);
      if (existingTargetComment) {
        upsertFeishuProjectCommentSync({
          ...key,
          targetTaskId,
          targetCommentId: existingTargetComment.id || "",
          sourcePayloadHash: comment.payloadHash || payloadHash,
          syncStatus: "success",
          lastError: "",
        });
        resolveFeishuProjectSyncErrors({
          ...key,
          stage: "comment",
          targetObjectType: "comment",
          sourceChildId: comment.id,
        });
        continue;
      }
      if (!loader.postComment) throw new Error("Teambition loader postComment is not configured");
      const r = await loader.postComment(targetTaskId, formatComment(comment, item), cfg);
      upsertFeishuProjectCommentSync({
        ...key,
        targetTaskId,
        targetCommentId: r?.id || r?.commentId || r?._id || r?.result?.id || "",
        sourcePayloadHash: comment.payloadHash || payloadHash,
        syncStatus: "success",
        lastError: "",
      });
      resolveFeishuProjectSyncErrors({
        ...key,
        stage: "comment",
        targetObjectType: "comment",
        sourceChildId: comment.id,
      });
    } catch (err) {
      const error = err?.message || String(err);
      upsertFeishuProjectCommentSync({
        ...key,
        targetTaskId,
        sourcePayloadHash: comment.payloadHash || payloadHash,
        syncStatus: "failed",
        lastError: error,
      });
      upsertFeishuProjectSyncError({
        ...key,
        stage: "comment",
        targetObjectType: "comment",
        sourceChildId: comment.id,
        targetTaskId,
        sourcePayloadHash: comment.payloadHash || payloadHash,
        errorMessage: error,
        errorDetail: err?.stack || err,
        retryable: true,
      });
      failures.push({ stage: "comment", sourceId: comment.id, targetTaskId, error });
    }
  }
  return failures;
}

async function uploadFeishuAttachmentToTeambition(taskId, attachment, item = null, cfg = {}, options = {}) {
  const downloaded = await downloadFeishuAttachmentToTempFile(attachment, item, {
    config: cfg,
    refreshDownload: options.refreshDownload,
  });
  const result = await uploadTaskAttachment(
    taskId,
    downloaded.filePath,
    "",
  );
  if (result?.ok === false) throw new Error(result.error || "Teambition attachment upload failed");
  return { ...result, fileName: result?.fileName || downloaded.fileName, bytes: downloaded.bytes };
}

export async function downloadFeishuAttachmentToTempFile(attachment, item = null, options = {}) {
  if (!attachment?.url) throw new Error(`Feishu attachment ${attachment?.id || ""} has no download URL`);
  const sourceId = sanitizePathPart(attachment.sourceWorkItemId || item?.sourceWorkItemId || "unknown");
  const dir = join(options.downloadRoot || ATTACHMENT_DOWNLOAD_ROOT, sourceId);
  await mkdir(dir, { recursive: true });
  const fileName = sanitizeFileName(
    attachment.fileName || fileNameFromUrl(attachment.sourceUrl || attachment.originalUrl || attachment.url) || attachment.id || "attachment",
    attachment.mimeType || "",
  );
  const filePath = join(dir, fileName);
  const partPath = `${filePath}.part`;
  const cfg = options.config || {};
  const attempts = clampLimit(
    options.attempts ?? cfg.sync?.attachmentDownloadAttempts,
    3,
    5,
  );
  const retryBaseDelayMs = Math.max(0, Number(
    options.retryBaseDelayMs ?? cfg.sync?.attachmentDownloadRetryBaseDelayMs ?? 500,
  ) || 0);
  const refreshDownload = options.refreshDownload
    || ((candidate) => refreshFeishuProjectMcpAttachmentDownload(candidate, item || {}, cfg));
  let candidate = attachment;
  let lastError = null;
  let lastRefreshError = null;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    await rm(partPath, { force: true }).catch(() => {});
    try {
      const downloaded = await downloadFeishuAttachmentAttempt(candidate, partPath);
      await rm(filePath, { force: true }).catch(() => {});
      await rename(partPath, filePath);
      return {
        filePath,
        fileName,
        bytes: downloaded.bytes,
        contentType: downloaded.contentType || attachment.mimeType || "",
        attempts: attempt,
      };
    } catch (err) {
      lastError = err;
      await rm(partPath, { force: true }).catch(() => {});
      if (attempt >= attempts || !isRetryableAttachmentDownloadError(err)) break;

      if (canRefreshFeishuAttachmentDownload(candidate) && typeof refreshDownload === "function") {
        try {
          candidate = await refreshDownload(candidate, item || {});
          lastRefreshError = null;
        } catch (refreshErr) {
          lastRefreshError = refreshErr;
        }
      }
      log(
        "system",
        "warn",
        "feishu-project-sync",
        `飞书附件下载失败，准备重试 ${fileName} (${attempt}/${attempts}): ${clip(err?.message || String(err), 180)}`,
      );
      if (retryBaseDelayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, retryBaseDelayMs * (2 ** (attempt - 1))));
      }
    }
  }

  const message = lastError?.message || String(lastError || "unknown download error");
  const refreshMessage = lastRefreshError
    ? `; MCP download URL refresh failed: ${lastRefreshError?.message || String(lastRefreshError)}`
    : "";
  throw new Error(`Feishu attachment download failed after ${attempts} attempts: ${message}${refreshMessage}`);
}

async function downloadFeishuAttachmentAttempt(attachment, partPath) {
  const headers = attachment.downloadHeaders && typeof attachment.downloadHeaders === "object"
    ? attachment.downloadHeaders
    : {};
  if (attachment.isMultipart && Array.isArray(attachment.multipart?.need) && attachment.multipart.need.length) {
    return downloadFeishuMultipartAttachmentAttempt(attachment, partPath, headers);
  }
  const url = withFeishuAttachmentDownloadFlag(attachment.url);
  const resp = await fetchFeishuAttachmentResponse(url, headers);

  const expectedBytes = Number(resp.headers.get("content-length") || 0);
  const contentType = resp.headers.get("content-type") || attachment.mimeType || "";
  const bytes = await writeAttachmentResponseBody(resp, partPath);
  if (Number.isFinite(expectedBytes) && expectedBytes > 0 && bytes !== expectedBytes) {
    const error = new Error(`Feishu attachment download terminated early: expected ${expectedBytes} bytes, received ${bytes}`);
    error.code = "ATTACHMENT_INCOMPLETE";
    throw error;
  }
  return { bytes, contentType };
}

async function downloadFeishuMultipartAttachmentAttempt(attachment, partPath, headers) {
  const parts = attachment.multipart.need
    .map((part) => ({
      partIndex: Number(part?.part_index ?? part?.partIndex),
      startByte: Number(part?.start_byte ?? part?.startByte),
      endByte: Number(part?.end_byte ?? part?.endByte),
    }))
    .filter((part) => Number.isInteger(part.partIndex) && part.partIndex >= 0)
    .sort((left, right) => left.partIndex - right.partIndex);
  if (!parts.length) throw new Error("Feishu multipart attachment metadata contains no downloadable parts");

  let totalBytes = 0;
  let contentType = attachment.mimeType || "";
  for (const part of parts) {
    const partUrl = withFeishuAttachmentDownloadFlag(feishuMultipartPartUrl(attachment.url, part.partIndex));
    const resp = await fetchFeishuAttachmentResponse(partUrl, headers);
    if (!contentType) contentType = resp.headers.get("content-type") || "";
    const responseLength = Number(resp.headers.get("content-length") || 0);
    const bytes = await writeAttachmentResponseBody(resp, partPath, { append: totalBytes > 0 });
    const metadataLength = Number.isFinite(part.startByte) && Number.isFinite(part.endByte) && part.endByte >= part.startByte
      ? part.endByte - part.startByte + 1
      : 0;
    const expectedBytes = responseLength > 0 ? responseLength : metadataLength;
    if (expectedBytes > 0 && bytes !== expectedBytes) {
      const error = new Error(`Feishu multipart attachment part ${part.partIndex} terminated early: expected ${expectedBytes} bytes, received ${bytes}`);
      error.code = "ATTACHMENT_INCOMPLETE";
      throw error;
    }
    totalBytes += bytes;
  }
  return { bytes: totalBytes, contentType };
}

async function fetchFeishuAttachmentResponse(url, headers) {
  const resp = await fetch(url, { headers });
  if (resp.ok) return resp;
  const body = await resp.text().catch(() => "");
  const error = new Error(`Feishu attachment download failed HTTP ${resp.status}: ${clip(body, 240)}`);
  error.status = resp.status;
  throw error;
}

function feishuMultipartPartUrl(url, partIndex) {
  const raw = String(url || "");
  const replaced = raw
    .replace(/:part_number(?=\/|\?|#|$)/gi, String(partIndex))
    .replace(/%3apart_number(?=\/|\?|#|$)/gi, String(partIndex));
  if (replaced === raw) throw new Error("Feishu multipart attachment URL is missing the :part_number placeholder");
  return replaced;
}

async function writeAttachmentResponseBody(resp, partPath, { append = false } = {}) {
  if (resp.body && typeof resp.body.getReader === "function") {
    let bytes = 0;
    const counter = new Transform({
      transform(chunk, _encoding, callback) {
        bytes += chunk.length;
        callback(null, chunk);
      },
    });
    await pipeline(Readable.fromWeb(resp.body), counter, createWriteStream(partPath, { flags: append ? "a" : "w" }));
    return bytes;
  }
  const buffer = Buffer.from(await resp.arrayBuffer());
  await writeFile(partPath, buffer, { flag: append ? "a" : "w" });
  return buffer.length;
}

function withFeishuAttachmentDownloadFlag(url) {
  try {
    const parsed = new URL(String(url || ""));
    if (/(^|\.)project\.feishu\.cn$/i.test(parsed.hostname)
      && /\/goapi\/v5\/platform\/file\/stream\/download\//i.test(parsed.pathname)) {
      parsed.searchParams.set("dflag", "t");
    }
    return parsed.toString();
  } catch {
    return String(url || "");
  }
}

function canRefreshFeishuAttachmentDownload(attachment = {}) {
  const sourceUrl = attachment.sourceUrl || attachment.originalUrl || "";
  try {
    const parsed = new URL(String(sourceUrl));
    return /(^|\.)project\.feishu\.cn$/i.test(parsed.hostname)
      && /\/goapi\/v5\/platform\/file\/stream\/download\//i.test(parsed.pathname);
  } catch {
    return false;
  }
}

function isRetryableAttachmentDownloadError(err) {
  const status = Number(err?.status || 0);
  if (status) return status === 401 || status === 403 || status === 408 || status === 425 || status === 429 || status >= 500;
  if (err?.code === "ATTACHMENT_INCOMPLETE") return true;
  const text = `${err?.name || ""} ${err?.code || ""} ${err?.message || err || ""}`.toLowerCase();
  return /terminated|fetch failed|network|socket|econn|etimedout|timeout|premature|aborted|und_err/.test(text);
}

async function syncAttachments(item, targetTaskId, loader, payloadHash, cfg) {
  const failures = [];
  for (const attachment of item.attachments) {
    if (!attachment.id) continue;
    const key = { ...syncKey(item), sourceAttachmentId: attachment.id };
    const existing = getFeishuProjectAttachmentSync(key);
    if (isSuccessfulChildSync(existing, attachment.payloadHash)) continue;
    try {
      const syncAttachment = loader.syncAttachment
        || ((taskId, a, sourceItem, loaderCfg) => {
          if (!loader.postComment) throw new Error("Teambition loader postComment is not configured");
          return loader.postComment(taskId, formatAttachmentComment(a, sourceItem), loaderCfg);
        });
      const r = await syncAttachment(targetTaskId, attachment, item, cfg);
      upsertFeishuProjectAttachmentSync({
        ...key,
        targetTaskId,
        targetFileId: r?.fileId || r?.fileToken || r?.workId || r?.id || r?.commentId || r?.fileName || (r?.skipped ? "skipped" : "comment_link"),
        sourcePayloadHash: attachment.payloadHash || payloadHash,
        syncStatus: "success",
        lastError: "",
      });
      resolveFeishuProjectSyncErrors({
        ...key,
        stage: "attachment",
        targetObjectType: "attachment",
        sourceChildId: attachment.id,
      });
    } catch (err) {
      const error = err?.message || String(err);
      upsertFeishuProjectAttachmentSync({
        ...key,
        targetTaskId,
        sourcePayloadHash: attachment.payloadHash || payloadHash,
        syncStatus: "failed",
        lastError: error,
      });
      upsertFeishuProjectSyncError({
        ...key,
        stage: "attachment",
        targetObjectType: "attachment",
        sourceChildId: attachment.id,
        targetTaskId,
        sourcePayloadHash: attachment.payloadHash || payloadHash,
        errorMessage: error,
        errorDetail: err?.stack || err,
        retryable: true,
      });
      failures.push({
        stage: "attachment",
        sourceId: attachment.fileName || attachment.id,
        sourceAttachmentId: attachment.id,
        targetTaskId,
        error,
      });
    }
  }
  return failures;
}

function buildCustomFields(item, cfg, context = {}) {
  const out = [];
  const seen = new Set();
  const pushCustomField = (targetId, value, extra = {}) => {
    if (!targetId || !hasValue(value)) return;
    const key = String(targetId);
    const normalized = cleanObject({
      customfieldId: key,
      customFieldId: key,
      id: key,
      value: teambitionCustomFieldValueForWrite(cfg, key, value),
      ...extra,
    });
    if (!hasValue(normalized.value)) return;
    if (seen.has(key)) {
      const idx = out.findIndex((f) => String(f.customfieldId || f.customFieldId || f.id) === key);
      if (idx >= 0) out[idx] = { ...out[idx], ...normalized };
      return;
    }
    seen.add(key);
    out.push(normalized);
  };

  const fieldMappings = {
    ...(cfg.mappings.fields || {}),
    ...(cfg.mappings.customFields || {}),
  };
  const byKey = buildFieldLookup(item.fields || []);
  for (const [sourceKey, rawMapping] of Object.entries(fieldMappings)) {
    const mapping = normalizeFieldMapping(rawMapping);
    const field = byKey.get(normKey(sourceKey));
    if (!field || !mapping.targetId) continue;
    pushCustomField(mapping.targetId, mapFieldValue(field, mapping, cfg), mapping.extra);
  }

  const tb = cfg.teambition || {};
  pushCustomField(tb.sourceIdCustomFieldId, `${item.sourceProjectKey}/${item.sourceWorkItemTypeKey}/${item.sourceWorkItemId}`);
  pushCustomField(tb.sourceUrlCustomFieldId, item.sourceWorkItemUrl);
  pushCustomField(tb.statusCustomFieldId, hasValue(context.mappedStatus) ? context.mappedStatus : item.status);
  pushCustomField(tb.priorityCustomFieldId, hasValue(context.mappedPriority) ? context.mappedPriority : item.priority);
  pushCustomField(tb.severityCustomFieldId, hasValue(context.mappedSeverity) ? context.mappedSeverity : item.severity);
  pushCustomField(tb.commentsSummaryCustomFieldId, summarizeComments(item.comments || []));
  pushCustomField(tb.attachmentsSummaryCustomFieldId, summarizeAttachments(item.attachments || []));
  pushCustomField(tb.childItemsSummaryCustomFieldId, summarizeLinkedItems(item.childItems || []));
  pushCustomField(tb.relatedItemsSummaryCustomFieldId, summarizeLinkedItems(item.relatedItems || []));
  pushCustomField(tb.applicationCategoryCustomFieldId, context.applicationCategory || teambitionApplicationCategoryValue(cfg));
  pushCustomField(tb.defectCategoryCustomFieldId, context.defectCategory || teambitionDefectCategoryValue(cfg));
  pushCustomField(tb.versionCustomFieldId, context.version);
  pushCustomField(tb.reproductionProbabilityCustomFieldId, context.reproductionProbability);

  return out;
}

function teambitionCustomFieldValueForWrite(cfg = {}, customfieldId = "", value = null) {
  const entries = cfg.teambition?._runtimeCustomFieldChoiceEntries?.[String(customfieldId)] || [];
  if (!entries.length) return value;
  const resolveOne = (entry) => {
    if (entry && typeof entry === "object") return entry;
    const title = stringValue(entry);
    if (!title) return entry;
    const hit = entries.find((choice) => normKey(choice?.name) === normKey(title));
    const id = stringValue(hit?.id);
    return id ? { id, title: stringValue(hit?.name) || title } : entry;
  };
  return Array.isArray(value) ? value.map(resolveOne) : resolveOne(value);
}

function sourceFieldDisplayValue(item = {}, keys = []) {
  const byKey = buildFieldLookup(item.fields || []);
  for (const key of keys) {
    const field = byKey.get(normKey(key));
    if (!field) continue;
    const value = stringValue(field.displayValue || displayValue(field.value));
    if (value) return value;
  }
  return "";
}

function defaultTeambitionSeverityValue(value) {
  const normalized = normKey(displayValue(value));
  return ({
    a: "致命",
    b: "严重",
    c: "一般",
    d: "轻微",
    fatal: "致命",
    critical: "致命",
    severe: "严重",
    major: "严重",
    normal: "一般",
    minor: "轻微",
    致命: "致命",
    严重: "严重",
    一般: "一般",
    轻微: "轻微",
  })[normalized] || "";
}

function teambitionApplicationCategoryValue(cfg = {}, keywordMatch = {}) {
  return stringValue(cfg.teambition?.applicationCategoryValue) || DEFAULT_TB_APPLICATION_CATEGORY_VALUE;
}

function teambitionDefectCategoryValue(cfg = {}) {
  return stringValue(cfg.teambition?.defectCategoryValue) || DEFAULT_TB_DEFECT_CATEGORY_VALUE;
}

function applyKeywordRules(item, cfg) {
  const configuredRules = Array.isArray(cfg.mappings?.keywordRules) ? cfg.mappings.keywordRules : [];
  const rules = configuredRules;
  const matched = [];
  const target = {};
  let customfields = [];

  for (const rawRule of rules) {
    const rule = normalizeKeywordRule(rawRule);
    if (!rule.enabled || !rule.keywords.length) continue;
    const haystack = keywordSearchText(item, rule);
    if (!haystack && !rule.regex) continue;
    const hit = keywordRuleMatches(haystack, rule);
    if (!hit) continue;
    matched.push({
      id: rule.id,
      name: rule.name,
      keywords: rule.keywords,
      scope: rule.scope,
      match: rule.match,
      fieldKeys: rule.fieldKeys,
      fieldNames: rule.fieldNames,
    });
    Object.assign(target, cleanObject(rule.target));
    customfields = mergeCustomFields(customfields, keywordRuleCustomFields(rule.target));
  }

  return { matched, target, customfields };
}

function normalizeKeywordRule(rawRule) {
  const rule = rawRule && typeof rawRule === "object" ? rawRule : {};
  const target = rule.target && typeof rule.target === "object" ? rule.target : {};
  return {
    id: stringValue(rule.id) || stringValue(rule.name),
    name: stringValue(rule.name || rule.id) || "keyword rule",
    enabled: rule.enabled !== false,
    scope: stringValue(rule.scope || "all").toLowerCase(),
    match: stringValue(rule.match || rule.matchMode || "any").toLowerCase() === "all" ? "all" : "any",
    regex: rule.regex === true,
    caseSensitive: rule.caseSensitive === true,
    keywords: normalizeStringList(rule.keywords || rule.keyword),
    fieldKeys: normalizeStringList(rule.fieldKeys || rule.fieldKey || target.fieldKeys || target.fieldKey),
    fieldNames: normalizeStringList(rule.fieldNames || rule.fieldName || target.fieldNames || target.fieldName),
    target: {
      projectId: target.projectId ?? rule.projectId,
      projectPathName: target.projectPathName ?? target.pathName ?? rule.projectPathName ?? rule.pathName,
      projectName: target.projectName ?? rule.projectName,
      tasklistId: target.tasklistId ?? rule.tasklistId,
      tasklistName: target.tasklistName ?? target.tasklistPathName ?? rule.tasklistName ?? rule.tasklistPathName,
      stageId: target.stageId ?? rule.stageId,
      stageName: target.stageName ?? rule.stageName,
      sprintId: target.sprintId ?? target.sprintSectionId ?? target.sectionId ?? rule.sprintId ?? rule.sprintSectionId ?? rule.sectionId,
      sprintName: target.sprintName ?? rule.sprintName,
      sprintUrl: target.sprintUrl ?? rule.sprintUrl,
      taskflowstatusId: target.taskflowstatusId ?? target.statusId ?? rule.taskflowstatusId ?? rule.statusId,
      taskflowstatusName: target.taskflowstatusName ?? target.statusName ?? rule.taskflowstatusName ?? rule.statusName,
      scenariofieldconfigId: target.scenariofieldconfigId ?? rule.scenariofieldconfigId,
      executorId: target.executorId ?? rule.executorId,
      executorName: target.executorName ?? rule.executorName,
      involveMembers: target.involveMembers ?? rule.involveMembers,
      involveMemberNames: target.involveMemberNames ?? rule.involveMemberNames,
      replaceInvolveMembers: target.replaceInvolveMembers ?? rule.replaceInvolveMembers,
      priority: target.priority ?? rule.priority,
      tagIds: target.tagIds ?? target.defaultTagIds ?? rule.tagIds ?? rule.defaultTagIds,
      tagNames: target.tagNames ?? target.defaultTagNames ?? rule.tagNames ?? rule.defaultTagNames,
      customFields: target.customFields ?? target.customfields ?? rule.customFields ?? rule.customfields,
    },
  };
}

function keywordSearchText(item, rule) {
  const fields = filterKeywordRuleFields(item.fields || [], rule);
  const fieldText = fields
    .map((f) => [f.key, f.name, f.displayValue || displayValue(f.value)].filter(Boolean).join(": "))
    .filter(Boolean)
    .join("\n");
  const standardText = [
    item.title,
    item.description,
    item.status,
    item.priority,
    item.severity,
    item.sourceWorkItemId,
    item.sourceProjectKey,
    item.sourceWorkItemTypeKey,
  ].filter(Boolean).join("\n");
  switch (rule.scope) {
    case "title":
      return item.title || "";
    case "description":
    case "desc":
      return item.description || "";
    case "fields":
    case "field":
      return fieldText;
    case "standard":
      return standardText;
    default:
      return [standardText, fieldText].filter(Boolean).join("\n");
  }
}

function filterKeywordRuleFields(fields = [], rule = {}) {
  const keys = (rule.fieldKeys || []).map(normKey).filter(Boolean);
  const names = (rule.fieldNames || []).map(normKey).filter(Boolean);
  if (!keys.length && !names.length) return fields;
  return fields.filter((field) => {
    const fieldKeys = [field.key, field.field_key, field.metadata?.key].map(normKey).filter(Boolean);
    const fieldNames = [field.name, field.field_name, field.metadata?.name].map(normKey).filter(Boolean);
    return keys.some((key) => fieldKeys.includes(key)) || names.some((name) => fieldNames.includes(name));
  });
}

function keywordRuleMatches(haystack, rule) {
  const text = rule.caseSensitive ? String(haystack || "") : String(haystack || "").toLowerCase();
  const checks = rule.keywords.map((keyword) => {
    const needle = rule.caseSensitive ? keyword : keyword.toLowerCase();
    if (!needle) return false;
    if (!rule.regex) return text.includes(needle);
    try {
      return new RegExp(keyword, rule.caseSensitive ? "" : "i").test(String(haystack || ""));
    } catch {
      return false;
    }
  });
  return rule.match === "all" ? checks.every(Boolean) : checks.some(Boolean);
}

function keywordRuleCustomFields(target = {}) {
  const input = target.customFields || target.customfields;
  if (!input) return [];
  if (Array.isArray(input)) {
    return input.map((entry) => {
      if (!entry || typeof entry !== "object") return null;
      const id = entry.customfieldId || entry.customFieldId || entry.id || entry.fieldId || entry.customField;
      return cleanObject({
        customfieldId: id,
        customFieldId: id,
        id,
        value: entry.value ?? entry.defaultValue,
        type: entry.type,
        name: entry.name,
      });
    }).filter((entry) => entry?.customfieldId && hasValue(entry.value));
  }
  if (typeof input === "object") {
    return Object.entries(input).map(([id, value]) => cleanObject({
      customfieldId: id,
      customFieldId: id,
      id,
      value,
    })).filter((entry) => entry.customfieldId && hasValue(entry.value));
  }
  return [];
}

function mergeCustomFields(...groups) {
  const out = [];
  const index = new Map();
  for (const fields of groups) {
    for (const field of fields || []) {
      const id = field?.customfieldId || field?.customFieldId || field?.id;
      if (!id || !hasValue(field.value)) continue;
      const normalized = { ...field, customfieldId: String(id), customFieldId: String(id), id: String(id) };
      const key = String(id);
      if (index.has(key)) out[index.get(key)] = { ...out[index.get(key)], ...normalized };
      else {
        index.set(key, out.length);
        out.push(normalized);
      }
    }
  }
  return out;
}

function buildTaskNote(item, cfg, context = {}) {
  const configuredNoteMax = Number(cfg.sync.noteMaxLength || 10000);
  const noteMaxLength = Math.min(Number.isFinite(configuredNoteMax) && configuredNoteMax > 0 ? configuredNoteMax : 10000, 10000);
  const description = stringValue(item.description);
  return description ? clip(`\u7f3a\u9677\u63cf\u8ff0:\n${description}`, noteMaxLength) : "";
}

function normalizeFields(raw, fieldMetadata = null) {
  const candidates = getFirst(raw, ["fields", "field_values", "fieldValues", "custom_fields", "customFields"]);
  const fields = [];
  const metadataByKey = new Map((normalizeFeishuFieldMetadata(fieldMetadata).fields || []).map((f) => [normKey(f.key), f]));
  if (Array.isArray(candidates)) {
    for (const f of candidates) {
      const key = stringValue(getFirst(f, ["field_key", "fieldKey", "key", "id", "name"]));
      if (!key) continue;
      const metadata = metadataByKey.get(normKey(key)) || {};
      const value = getFirst(f, ["value", "field_value", "fieldValue", "values", "text", "content"]) ?? f;
      fields.push({
        key,
        name: stringValue(getFirst(f, ["field_name", "fieldName", "name", "label"])) || metadata.name || key,
        type: stringValue(getFirst(f, ["field_type", "fieldType", "type"])) || metadata.type || "",
        value,
        displayValue: displayValue(getFirst(f, ["display_value", "displayValue", "text", "label"]) ?? value),
        metadata,
      });
    }
  } else if (candidates && typeof candidates === "object") {
    for (const [key, value] of Object.entries(candidates)) {
      const metadata = metadataByKey.get(normKey(key)) || {};
      fields.push({ key, name: metadata.name || key, type: metadata.type || "", value, displayValue: displayValue(value), metadata });
    }
  }
  for (const [key, value] of Object.entries(raw || {})) {
    if (typeof value === "object" && value !== null) continue;
    if (!fields.some((f) => f.key === key)) {
      const metadata = metadataByKey.get(normKey(key)) || {};
      fields.push({ key, name: metadata.name || key, type: metadata.type || "", value, displayValue: displayValue(value), metadata });
    }
  }
  return fields;
}

function buildFieldLookup(fields = []) {
  const map = new Map();
  for (const field of fields || []) {
    for (const key of [field.key, field.name, field.metadata?.key, field.metadata?.name].filter(Boolean)) {
      map.set(normKey(key), field);
    }
  }
  return map;
}

function readStandardField(raw, fields, fieldMap, keys) {
  for (const key of keys) {
    const top = getCaseInsensitive(raw, key);
    if (top != null) return top;
    const field = fieldMap.get(normKey(key)) || fields.find((f) => normKey(f.name) === normKey(key));
    if (field) return field.value;
  }
  return null;
}

function readDescriptionField(raw, fields, fieldMap) {
  for (const key of DEFECT_DESCRIPTION_FIELD_KEYS) {
    const top = getCaseInsensitive(raw, key);
    const topText = richTextValue(top);
    if (topText) return topText;
    const field = fieldMap.get(normKey(key)) || fields.find((f) => normKey(f.name) === normKey(key));
    const fieldText = richTextValue(field?.value ?? field?.displayValue);
    if (fieldText) return fieldText;
  }
  return "";
}

function getUnmappedFields(item, cfg) {
  const fieldMappings = {
    ...(cfg.mappings.fields || {}),
    ...(cfg.mappings.customFields || {}),
  };
  const mappedKeys = new Set(Object.keys(fieldMappings).map(normKey));
  const limit = Math.max(0, Number(cfg.sync.unmappedFieldsMax || 80));
  return (item.fields || []).filter((field) => {
    const keys = [field.key, field.name, field.metadata?.key, field.metadata?.name].map(normKey).filter(Boolean);
    if (keys.some((key) => mappedKeys.has(key) || STANDARD_FIELD_NORMS.has(key) || INTERNAL_FIELD_KEYS.has(key))) return false;
    return hasValue(field.displayValue) || hasValue(field.value);
  }).slice(0, limit);
}

function normalizeFieldMapping(mapping) {
  if (typeof mapping === "string") return { targetId: mapping, values: {}, extra: {} };
  if (!mapping || typeof mapping !== "object") return { targetId: "", values: {}, extra: {} };
  const targetId = mapping.customFieldId
    || mapping.customfieldId
    || mapping.targetFieldId
    || mapping.targetCustomFieldId
    || mapping.fieldId
    || mapping.id
    || "";
  return {
    targetId,
    values: mapping.values || mapping.options || {},
    type: mapping.type || mapping.valueType || "",
    value: mapping.value,
    defaultValue: mapping.defaultValue ?? mapping.default,
    useRawValue: mapping.useRawValue === true || mapping.rawValue === true,
    extra: cleanObject({
      name: mapping.name,
      type: mapping.targetType,
    }),
  };
}

function mapFieldValue(field, mapping, cfg) {
  if (hasValue(mapping.value)) return mapping.value;
  const mapped = mapByValue(field.value, mapping.values) || mapByValue(field.displayValue, mapping.values);
  if (hasValue(mapped)) return mapped;
  if (hasValue(mapping.defaultValue)) return mapping.defaultValue;
  const type = normKey(mapping.type || field.type || field.metadata?.type);
  if (type.includes("user") || type.includes("member") || type.includes("people")) {
    const people = normalizePeople(field.value);
    const mappedPeople = people.map((p) => mapPerson(p, cfg.mappings.people)).filter(Boolean);
    return mappedPeople.length ? uniq(mappedPeople) : formatPeople(people);
  }
  if (type.includes("date") || type.includes("time")) return dateValue(field.value) || field.displayValue;
  if (mapping.useRawValue) return field.value;
  if (Array.isArray(field.value)) return field.value.map(displayValue).filter(Boolean);
  if (field.value && typeof field.value === "object") return field.displayValue || JSON.stringify(field.value);
  return hasValue(field.value) ? field.value : field.displayValue;
}

function shouldIncludeRawJson(cfg, unmapped) {
  const mode = cfg.sync.includeRawJsonInNote;
  if (mode === true || mode === "always") return true;
  if (mode === false || mode === "never") return false;
  return (unmapped || []).length > 0;
}

function stableRaw(raw) {
  return stable(stripVolatileDownloadFields(raw));
}

function stripVolatileDownloadFields(value) {
  if (Array.isArray(value)) return value.map(stripVolatileDownloadFields);
  if (!value || typeof value !== "object") return value;
  const sourceUrl = value.sourceUrl || value.source_url || value.originalUrl || value.original_url;
  const out = {};
  for (const [key, child] of Object.entries(value)) {
    const nk = normKey(key);
    if (["downloadheaders", "downloadexpiresat", "downloadexpires", "sign", "signexpiretime", "ismultipart"].includes(nk)) continue;
    if (sourceUrl && ["url", "downloadurl", "fileurl", "previewurl"].includes(nk)) {
      out[key] = sourceUrl;
      continue;
    }
    out[key] = stripVolatileDownloadFields(child);
  }
  return out;
}

function normalizeComments(rawComments) {
  const arr = arrayValue(rawComments, ["comments", "items", "list", "records", "comment_list", "commentList", "comment_records", "commentRecords"]);
  return arr.map((c, idx) => {
    const source = c && typeof c === "object" ? c : { content: c };
    const id = stringValue(getFirst(source, ["id", "comment_id", "commentId", "uuid", "comment_uuid", "commentUuid"])) || `comment-${idx}`;
    const author = normalizePeople(getFirst(source, ["author", "creator", "user", "member", "created_by", "createdBy", "operator"]))[0] || null;
    const contentValue = getFirstIncludingEmpty(source, ["content", "text", "body", "comment", "message", "rich_text", "richText", "reply_content", "replyContent"]);
    const content = contentValue.found ? (displayValue(contentValue.value) || "") : (displayValue(c) || "");
    const createdAt = dateValue(getFirst(source, ["created_at", "createdAt", "created", "time", "create_time", "createTime"]));
    const attachments = normalizeAttachments(
      getFirst(source, ["attachments", "attachment_list", "attachmentList", "files", "file_list", "fileList"]) || [],
      { sourceCommentId: id },
    );
    const normalized = cleanObject({ id, author, content, createdAt, attachments, raw: source });
    return { ...normalized, payloadHash: hashStable(normalized) };
  });
}

function normalizeAttachments(rawAttachments, defaults = {}) {
  const arr = arrayValue(rawAttachments, ["attachments", "items", "list", "records", "files", "file_list", "fileList", "attachment_list", "attachmentList"]);
  return arr.map((a, idx) => {
    const source = a && typeof a === "object" ? { ...defaults, ...a } : { ...defaults, name: a };
    const id = stringValue(getFirst(source, ["id", "file_id", "fileId", "uid", "uuid", "file_token", "fileToken", "token", "attachment_id", "attachmentId"])) || `attachment-${idx}`;
    const downloadHeaders = getFirst(source, ["downloadHeaders", "download_headers", "headers"]);
    const multipart = getFirstIncludingEmpty(source, ["isMultipart", "is_multipart", "multipart"]);
    const normalized = cleanObject({
      id,
      fileName: stringValue(getFirst(source, ["fileName", "file_name", "filename", "name", "title"])) || id,
      fileSize: Number(getFirst(source, ["fileSize", "file_size", "size", "size_bytes", "sizeBytes"]) || 0),
      mimeType: stringValue(getFirst(source, ["mimeType", "mime_type", "contentType", "content_type", "type"])),
      url: stringValue(getFirst(source, ["url", "downloadUrl", "download_url", "sourceUrl", "source_url", "fileUrl", "file_url", "previewUrl", "preview_url"])),
      sourceUrl: stringValue(getFirst(source, ["sourceUrl", "source_url", "originalUrl", "original_url", "fileUrl", "file_url"])),
      sourceWorkItemId: stringValue(getFirst(source, ["sourceWorkItemId", "source_work_item_id", "workItemId", "work_item_id"])),
      sourceProjectKey: stringValue(getFirst(source, ["sourceProjectKey", "source_project_key", "projectKey", "project_key", "spaceKey", "space_key"])),
      sourceCommentId: stringValue(getFirst(source, ["sourceCommentId", "source_comment_id", "commentId", "comment_id"])),
      marker: stringValue(getFirst(source, ["marker", "uid", "uuid", "imageId", "image_id", "fileToken", "file_token"])),
      downloadHeaders: downloadHeaders && typeof downloadHeaders === "object" && !Array.isArray(downloadHeaders) ? downloadHeaders : null,
      downloadExpiresAt: getFirst(source, ["downloadExpiresAt", "download_expires_at", "signExpireTime", "sign_expire_time"]),
      isMultipart: multipart.found ? parseBooleanOption(multipart.value, false) : undefined,
      multipart: source.multipart && typeof source.multipart === "object" ? source.multipart : undefined,
      checksum: stringValue(getFirst(source, ["hash", "sha256", "checksum", "md5"])),
      raw: source,
    });
    const hashPayload = cleanObject({
      id: normalized.id,
      fileName: normalized.fileName,
      fileSize: normalized.fileSize,
      mimeType: normalized.mimeType,
      url: normalized.sourceUrl || normalized.url,
      sourceWorkItemId: normalized.sourceWorkItemId,
      sourceProjectKey: normalized.sourceProjectKey,
      sourceCommentId: normalized.sourceCommentId,
      marker: normalized.marker,
      checksum: normalized.checksum,
    });
    return { ...normalized, payloadHash: hashStable(hashPayload) };
  });
}

function normalizeAttachmentFields(fields = []) {
  const out = [];
  for (const field of fields || []) {
    if (!isAttachmentField(field)) continue;
    out.push(...normalizeAttachments(field.value));
  }
  return out;
}

function isAttachmentField(field = {}) {
  const keys = [field.key, field.name, field.type].map(normKey).filter(Boolean);
  return keys.some((key) => [
    "field2cb6f7",
    "attachment",
    "attachments",
    "attachmentlist",
    "file",
    "files",
    "filelist",
    "附件",
  ].includes(key));
}

function mergeNormalizedAttachments(...groups) {
  const out = [];
  const byId = new Map();
  for (const attachment of groups.flat()) {
    if (!attachment?.id) continue;
    const existingIndex = byId.get(attachment.id);
    if (existingIndex === undefined) {
      byId.set(attachment.id, out.length);
      out.push(attachment);
      continue;
    }
    const existing = out[existingIndex];
    if (!existing.sourceCommentId && attachment.sourceCommentId) {
      out[existingIndex] = attachment;
    }
  }
  return out;
}

function normalizeLinkedItems(rawItems, relationType = "") {
  const arr = arrayValue(rawItems, ["items", "list", "records", "children", "relations", "linkedItems", "relatedItems"]);
  return arr.map((x, idx) => {
    const source = x && typeof x === "object" ? x : { id: x };
    const node = linkedItemNode(source);
    const sourceProjectKey = stringValue(getFirst(node, ["space_key", "spaceKey", "project_key", "projectKey"]));
    const sourceWorkItemTypeKey = stringValue(getFirst(node, ["work_item_type_key", "workItemTypeKey", "type_key", "typeKey", "work_item_type", "workItemType", "type"]));
    const id = stringValue(getFirst(node, ["id", "work_item_id", "workItemId", "issue_id", "workObjectId", "target_id", "targetId"])) || `${relationType || "item"}-${idx}`;
    const title = displayValue(getFirst(node, ["title", "name", "summary", "work_item_name", "workItemName", "content"])) || id;
    const status = displayValue(getFirst(node, ["status", "state", "workflow_status", "workflowStatus", "flow_state", "flowState"]));
    const url = stringValue(getFirst(node, ["url", "source_url", "sourceUrl", "web_url", "webUrl", "work_item_url", "workItemUrl"]));
    const rel = stringValue(getFirst(source, ["relation_type", "relationType", "type", "link_type", "linkType", "relation"])) || relationType;
    return cleanObject({
      id,
      title,
      status,
      relationType: rel,
      sourceProjectKey,
      sourceWorkItemTypeKey,
      url,
      raw: source,
    });
  });
}

function linkedItemNode(source) {
  const nested = getFirst(source, [
    "work_item",
    "workItem",
    "target_work_item",
    "targetWorkItem",
    "target",
    "item",
    "node",
  ]);
  return nested && typeof nested === "object" ? nested : source;
}

function normalizePeople(value) {
  const arr = arrayValue(value, PERSON_ARRAY_KEYS);
  return arr.flatMap(normalizePersonEntry).filter((p) => Object.keys(p).length);
}

function normalizePersonEntry(v) {
  if (v == null || v === "") return [];
  if (Array.isArray(v)) return normalizePeople(v);
  if (typeof v !== "object") return [{ id: String(v), name: String(v) }];

  const nestedArray = firstArray(v, PERSON_ARRAY_KEYS);
  if (nestedArray) return normalizePeople(nestedArray);

  for (const key of PERSON_OBJECT_KEYS) {
    const nested = getCaseInsensitive(v, key);
    if (nested && nested !== v && typeof nested === "object") return normalizePeople(nested);
  }

  const primitiveValue = getFirst(v, ["value", "field_value", "fieldValue"]);
  const rawId = getFirst(v, [
    "id",
    "user_id",
    "userId",
    "open_id",
    "openId",
    "union_id",
    "unionId",
    "employee_id",
    "employeeId",
    "job_number",
    "jobNumber",
  ]) ?? (isPrimitiveValue(primitiveValue) ? primitiveValue : "");

  const person = cleanObject({
    id: stringValue(rawId),
    userKey: stringValue(getFirst(v, ["user_key", "userKey", "key", "username", "user_name", "userName"])),
    email: stringValue(getFirst(v, ["email", "mail", "email_address", "emailAddress"])),
    phone: stringValue(getFirst(v, ["phone", "mobile", "mobile_phone", "mobilePhone"])),
    employeeId: stringValue(getFirst(v, ["employee_id", "employeeId", "job_number", "jobNumber", "employee_no", "employeeNo"])),
    name: displayValue(getFirst(v, ["name", "displayName", "display_name", "nickname", "en_name", "enName", "zh_name", "zhName", "display_value", "displayValue"])) || stringValue(rawId),
  });
  return Object.keys(person).length ? [person] : [];
}

function mapPerson(person, peopleMap = {}) {
  if (!person) return "";
  const keys = [person.userKey, person.email, person.employeeId, person.phone, person.id, person.name].filter(Boolean);
  for (const key of keys) {
    const mapped = lookupMapping(peopleMap, key);
    if (hasValue(mapped)) return extractMappedValue(mapped);
  }
  return "";
}

function resolveRequiredInvolveMembers(cfg = {}) {
  const tb = cfg.teambition || {};
  const peopleMap = cfg.mappings?.people || {};
  const explicit = uniq([
    ...normalizeStringList(tb.requiredInvolveMembers),
    ...normalizeStringList(tb.alwaysInvolveMembers),
    ...normalizeStringList(tb.requiredParticipantIds),
    ...normalizeStringList(tb.alwaysParticipantIds),
  ]);
  const requiredPeople = uniq([
    ...normalizeStringList(tb.requiredInvolveMemberKeywords),
    ...normalizeStringList(tb.requiredParticipantKeywords),
    ...normalizeStringList(cfg.sync?.requiredParticipantKeywords),
    ...normalizeStringList(cfg.sync?.requiredAssigneeKeywords),
  ]);
  const mapped = requiredPeople
    .map((keyword) => mapPerson({
      id: keyword,
      userKey: keyword,
      email: keyword,
      employeeId: keyword,
      phone: keyword,
      name: keyword,
    }, peopleMap))
    .filter(Boolean);
  return uniq([...explicit, ...mapped]);
}

function mapByValue(value, mapping = {}) {
  for (const key of mappingKeysFor(value)) {
    const mapped = lookupMapping(mapping, key);
    if (hasValue(mapped)) return extractMappedValue(mapped);
  }
  const fallback = mapping.defaultValue ?? mapping.default;
  return hasValue(fallback) ? extractMappedValue(fallback) : "";
}

function mappingKeysFor(value) {
  const keys = [];
  const visit = (v) => {
    if (v == null || v === "") return;
    if (isPrimitiveValue(v)) {
      keys.push(String(v));
      return;
    }
    if (Array.isArray(v)) {
      for (const item of v) visit(item);
      return;
    }
    const shown = displayValue(v);
    if (shown) keys.push(shown);
    for (const key of MAPPING_VALUE_KEYS) {
      const candidate = getCaseInsensitive(v, key);
      if (candidate !== null && candidate !== undefined && candidate !== v) visit(candidate);
    }
  };
  visit(value);
  return uniq(keys.map((x) => String(x).trim()).filter(Boolean));
}

function lookupMapping(mapping = {}, key = "") {
  if (!mapping || typeof mapping !== "object") return undefined;
  if (Object.prototype.hasOwnProperty.call(mapping, key)) return mapping[key];
  const nk = normKey(key);
  if (Object.prototype.hasOwnProperty.call(mapping, nk)) return mapping[nk];
  const hit = Object.keys(mapping).find((k) => normKey(k) === nk);
  return hit ? mapping[hit] : undefined;
}

function extractMappedValue(mapped) {
  if (mapped && typeof mapped === "object" && !Array.isArray(mapped)) {
    return mapped.value
      ?? mapped.targetValue
      ?? mapped.target
      ?? mapped.teambitionUserId
      ?? mapped.tbUserId
      ?? mapped.userId
      ?? mapped.id
      ?? "";
  }
  return mapped;
}

function normalizeTeambitionPriority(value) {
  if (!hasValue(value)) return undefined;
  if (typeof value === "number") return Number.isInteger(value) ? value : undefined;
  if (typeof value === "string") {
    const text = value.trim();
    return /^-?\d+$/.test(text) ? Number(text) : undefined;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const normalized = normalizeTeambitionPriority(item);
      if (normalized !== undefined) return normalized;
    }
    return undefined;
  }
  if (value && typeof value === "object") {
    for (const key of ["value", "targetValue", "target", "priority", "id"]) {
      const nested = getCaseInsensitive(value, key);
      if (nested === null || nested === undefined || nested === value) continue;
      const normalized = normalizeTeambitionPriority(nested);
      if (normalized !== undefined) return normalized;
    }
  }
  return undefined;
}

function teambitionPriorityDisplay(value) {
  const normalized = normalizeTeambitionPriority(value);
  if (normalized === undefined) return "";
  return TEAMBITION_PRIORITY_DISPLAY_NAMES[normalized] || String(normalized);
}

function unresolvedPeople(item, peopleMap = {}) {
  const people = [...(item.assignees || []), ...(item.reporter ? [item.reporter] : [])];
  return people.filter((person) => !mapPerson(person, peopleMap));
}

function formatPerson(person) {
  if (!person) return "";
  return person.name || person.email || person.userKey || person.employeeId || person.phone || person.id || "";
}

function formatPeople(people = []) {
  return (people || []).map(formatPerson).filter(Boolean).join(", ");
}

function summarizeComments(comments = [], limit = 20) {
  return (comments || []).slice(0, limit).map((c) => {
    const author = formatPerson(c.author) || "unknown";
    const at = c.createdAt ? ` @ ${c.createdAt}` : "";
    return `- ${author}${at}: ${clip(c.content, 500)}`;
  }).join("\n");
}

function summarizeAttachments(attachments = [], limit = 50) {
  return (attachments || []).slice(0, limit).map((a) => {
    const parts = [`- ${a.fileName || a.id}`];
    if (a.fileSize) parts.push(`(${a.fileSize} bytes)`);
    const shownUrl = a.sourceUrl || a.originalUrl || a.url;
    if (shownUrl) parts.push(shownUrl);
    return parts.join(" ");
  }).join("\n");
}

function summarizeLinkedItems(items = [], limit = 50) {
  return (items || []).slice(0, limit).map((x) => {
    const id = [x.sourceProjectKey, x.sourceWorkItemTypeKey, x.id].filter(Boolean).join("/") || x.id;
    const rel = x.relationType ? `[${x.relationType}] ` : "";
    const status = x.status ? ` (${x.status})` : "";
    const url = x.url ? ` ${x.url}` : "";
    return `- ${rel}${id}: ${x.title || x.id}${status}${url}`;
  }).join("\n");
}

function formatComment(comment, item) {
  const author = comment.author?.name || comment.author?.email || comment.author?.userKey || "unknown";
  return [
    `Feishu comment from ${author}`,
    comment.createdAt ? `Original time: ${comment.createdAt}` : "",
    `Source comment ID: ${comment.id}`,
    item.sourceWorkItemUrl ? `Source URL: ${item.sourceWorkItemUrl}` : "",
    "",
    comment.content,
  ].filter((x) => x !== "").join("\n");
}

function formatAttachmentComment(attachment, item = null) {
  return [
    "Feishu attachment",
    `Source attachment ID: ${attachment.id}`,
    item?.sourceWorkItemUrl ? `Work item URL: ${item.sourceWorkItemUrl}` : "",
    `File: ${attachment.fileName || attachment.id}`,
    attachment.fileSize ? `Size: ${attachment.fileSize}` : "",
    attachment.url ? `Source URL: ${attachment.url}` : "Source URL unavailable; check Feishu Project permissions.",
  ].filter(Boolean).join("\n");
}

function sanitizePathPart(value) {
  return String(value || "unknown").replace(/[<>:"/\\|?*\x00-\x1f]+/g, "_").slice(0, 80) || "unknown";
}

function sanitizeFileName(value, contentType = "") {
  const raw = sanitizePathPart(value);
  const currentExt = extname(raw);
  const inferredExt = extensionFromContentType(contentType);
  const withExt = currentExt || !inferredExt ? raw : `${raw}${inferredExt}`;
  return withExt.slice(0, 180) || `attachment${inferredExt || ".bin"}`;
}

function fileNameFromUrl(url) {
  try {
    const pathname = new URL(String(url || "")).pathname;
    const name = decodeURIComponent(pathname.split("/").filter(Boolean).pop() || "");
    return name || "";
  } catch {
    return "";
  }
}

function extensionFromContentType(contentType = "") {
  const type = String(contentType || "").toLowerCase().split(";")[0].trim();
  return ({
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/gif": ".gif",
    "image/webp": ".webp",
    "video/mp4": ".mp4",
    "application/pdf": ".pdf",
    "text/plain": ".txt",
    "application/zip": ".zip",
  })[type] || "";
}

function summarizeResults(results, meta = {}) {
  const summary = {
    ok: results.every((r) => r.ok),
    total: results.length,
    requested: Number(meta.requested || results.length),
    created: results.filter((r) => r.action === "create" && r.ok && !r.dryRun).length,
    updated: results.filter((r) => r.action === "update" && r.ok && !r.dryRun).length,
    childSynced: results.filter((r) => r.action === "sync-children" && r.ok && !r.dryRun).length,
    skipped: results.filter((r) => r.action === "skip" && r.ok).length,
    failed: results.filter((r) => !r.ok).length,
    dryRun: results.some((r) => r.dryRun),
    stoppedOnFirstError: !!meta.stoppedOnFirstError,
    firstError: results.find((r) => !r.ok)?.error || "",
    results,
  };
  if (meta.selection) {
    summary.selection = cleanObject({
      requested: meta.selection.requested,
      workItemIds: meta.selection.workItemIds?.length ? meta.selection.workItemIds : undefined,
      workItemNos: meta.selection.workItemNos?.length ? meta.selection.workItemNos : undefined,
      missingWorkItemNos: meta.selection.missingWorkItemNos?.length ? meta.selection.missingWorkItemNos : undefined,
      sourceResults: meta.selection.sourceResults?.length ? meta.selection.sourceResults : undefined,
    });
    if (meta.selection.sourceResults?.length) summary.sourceResults = meta.selection.sourceResults;
  }
  return summary;
}

async function summarizeSyncPayload(payload = {}, loader = null, cfg = {}, payloadDisplay = {}) {
  const display = await summarizeSyncPayloadDisplay(payload, loader, cfg);
  return cleanObject({
    content: clip(payload.content || "", 300),
    executorId: payload.executorId,
    executorIdDisplay: display.executorIdDisplay,
    involveMembers: payload.involveMembers,
    startDate: payload.startDate,
    dueDate: payload.dueDate,
    note: clip(payload.note || "", 4000),
    priority: payload.priority,
    priorityDisplay: display.priorityDisplay,
    projectId: payload.projectId,
    projectIdDisplay: display.projectIdDisplay,
    tasklistId: payload.tasklistId,
    tasklistIdDisplay: display.tasklistIdDisplay,
    stageId: payload.stageId,
    sprintId: payload.sprintId,
    sprintIdDisplay: payloadDisplay.sprintIdDisplay || display.sprintIdDisplay,
    taskflowstatusId: payload.taskflowstatusId,
    scenariofieldconfigId: payload.scenariofieldconfigId,
    applicationCategory: payloadDisplay.applicationCategory,
    applicationCategoryCustomFieldId: payloadDisplay.applicationCategoryCustomFieldId,
    defectCategory: payloadDisplay.defectCategory,
    defectCategoryCustomFieldId: payloadDisplay.defectCategoryCustomFieldId,
    severity: payloadDisplay.severity,
    severityCustomFieldId: payloadDisplay.severityCustomFieldId,
    version: payloadDisplay.version,
    versionCustomFieldId: payloadDisplay.versionCustomFieldId,
    reproductionProbability: payloadDisplay.reproductionProbability,
    reproductionProbabilityCustomFieldId: payloadDisplay.reproductionProbabilityCustomFieldId,
    tagIds: payload.tagIds,
    customfields: Array.isArray(payload.customfields)
      ? payload.customfields.map((field) => cleanObject({
        customfieldId: field.customfieldId || field.customFieldId || field.id,
        value: field.value ?? field.values ?? field.text,
      })).slice(0, 20)
      : undefined,
  });
}

function attachTargetNotePreviousToPayloadSummary(payloadSummary = {}, targetFieldVerification = {}) {
  if (!payloadSummary || typeof payloadSummary !== "object" || !targetFieldVerification || typeof targetFieldVerification !== "object") {
    return payloadSummary;
  }
  if (Object.prototype.hasOwnProperty.call(targetFieldVerification, "notePrevious")) {
    payloadSummary.notePrevious = targetFieldVerification.notePrevious;
  } else if (targetFieldVerification.noteRead?.empty) {
    payloadSummary.notePrevious = "\u7a7a";
  }
  return payloadSummary;
}

async function summarizeSyncPayloadDisplay(payload = {}, loader = null, cfg = {}) {
  const out = {};
  for (const field of ["executorId", "projectId", "tasklistId", "sprintId", "priority"]) {
    const value = payload[field];
    if (!hasValue(value)) continue;
    const display = await readPayloadFieldDisplay(field, value, payload, loader, cfg);
    const raw = stringValue(value);
    if (display && display !== raw) out[`${field}Display`] = display;
  }
  return out;
}

async function buildSyncComparisonSnapshot({
  item = {},
  key = {},
  payload = {},
  payloadSummary = {},
  targetFieldVerification = {},
  targetVerification = {},
  existing = null,
  remoteExisting = null,
  action = "",
  loader = null,
  cfg = {},
  policyDecision = null,
} = {}) {
  const targetTask = targetFieldVerification?.task
    || targetVerification?.task
    || remoteExisting?.task
    || existing?.task
    || null;
  const targetTaskId = stringValue(
    targetFieldVerification?.targetTaskId
      || targetVerification?.targetTaskId
      || remoteExisting?.targetTaskId
      || existing?.targetTaskId
      || existing?.target_task_id,
  );
  const targetUniqueId = stringValue(
    targetFieldVerification?.targetUniqueId
      || targetVerification?.targetUniqueId
      || targetTask?.uniqueId
      || targetTask?.unique_id
      || remoteExisting?.targetUniqueId
      || existing?.targetUniqueId
      || existing?.target_unique_id,
  );
  const fields = [];
  for (const fieldKey of TARGET_COMPARISON_FIELD_KEYS) {
    const targetNext = await payloadSnapshotForField(fieldKey, payload, payloadSummary, loader, cfg);
    if (!targetNext.present) continue;
    const targetCurrent = targetSnapshotForField(fieldKey, targetFieldVerification, targetTask, payloadSummary);
    const fieldAction = comparisonActionForField(fieldKey, targetCurrent, targetNext, action, targetTaskId);
    fields.push(cleanObject({
      fieldKey,
      sourceFields: sourceFieldRefsForTargetField(item, fieldKey),
      targetCurrent,
      targetNext,
      action: fieldAction,
      compare: cleanObject({
        equal: fieldAction === "same",
        reason: comparisonReasonForField(fieldKey, targetCurrent, targetNext, fieldAction, action, targetTaskId),
      }),
      mapping: mappingSnapshotForField(fieldKey, item, payloadSummary, policyDecision),
    }));
  }
  return cleanObject({
    version: 1,
    source: cleanObject({
      system: SOURCE_SYSTEM,
      identity: cleanObject({
        sourceProjectKey: item.sourceProjectKey || key.sourceProjectKey,
        sourceWorkItemTypeKey: item.sourceWorkItemTypeKey || key.sourceWorkItemTypeKey,
        sourceWorkItemId: item.sourceWorkItemId || key.sourceWorkItemId,
        sourceWorkItemNo: getSourceWorkItemNo(item),
        sourceProblemNo: getSourceProblemNo(item),
        sourceWorkItemUrl: item.sourceWorkItemUrl,
      }),
      fields: sourceFieldSnapshot(item),
    }),
    target: cleanObject({
      system: TARGET_SYSTEM,
      identity: cleanObject({
        targetTaskId,
        targetUniqueId,
        targetDisplayId: targetUniqueId ? (/^\d+$/.test(targetUniqueId) ? `CARB-${targetUniqueId}` : targetUniqueId) : "",
      }),
      fields: Object.fromEntries(fields.map((field) => [field.fieldKey, field.targetCurrent]).filter(([, value]) => value)),
    }),
    relation: cleanObject({
      type: targetTaskId ? "one-to-one" : "new-target",
      origin: remoteExisting?.targetTaskId ? "remote-existing" : existing?.targetTaskId ? "local-state" : action === "create" ? "new-target" : "",
      sourceKey: sourceIdFromSyncKey(key),
      targetTaskId,
      targetUniqueId,
    }),
    fieldComparisons: fields,
  });
}

function sourceFieldSnapshot(item = {}) {
  const out = {};
  for (const field of item.fields || []) {
    const key = stringValue(field?.key || field?.name);
    if (!key || out[key]) continue;
    out[key] = cleanObject({
      key,
      name: field.name,
      type: field.type,
      raw: snapshotValue(field.value),
      display: snapshotText(field.displayValue || displayValue(field.value), 1600),
    });
  }
  return out;
}

function sourceFieldRefsForTargetField(item = {}, fieldKey = "") {
  const wanted = new Set((SOURCE_FIELDS_BY_TARGET_FIELD[fieldKey] || []).map(normKey).filter(Boolean));
  if (!wanted.size) return [];
  return (item.fields || [])
    .filter((field) => {
      const candidates = [field.key, field.name, field.metadata?.key, field.metadata?.name].map(normKey).filter(Boolean);
      return candidates.some((candidate) => wanted.has(candidate));
    })
    .slice(0, 6)
    .map((field) => cleanObject({
      key: field.key,
      name: field.name,
      raw: snapshotValue(field.value),
      display: snapshotText(field.displayValue || displayValue(field.value), 1200),
    }));
}

async function payloadSnapshotForField(fieldKey = "", payload = {}, payloadSummary = {}, loader = null, cfg = {}) {
  const raw = payloadRawValueForField(fieldKey, payload, payloadSummary);
  const display = payloadDisplayValueForField(fieldKey, raw, payload, payloadSummary);
  let resolvedDisplay = display;
  if (!resolvedDisplay && hasValue(raw)) {
    try {
      resolvedDisplay = await readPayloadFieldDisplay(fieldKey, raw, payload, loader, cfg);
    } catch {
      resolvedDisplay = "";
    }
  }
  return cleanObject({
    raw: snapshotValue(raw),
    display: snapshotText(resolvedDisplay || displayValue(raw), fieldKey === "note" ? 4000 : 1600),
    present: hasValue(raw) || hasValue(resolvedDisplay),
  });
}

function payloadRawValueForField(fieldKey = "", payload = {}, payloadSummary = {}) {
  if (TARGET_NAMED_CUSTOM_FIELD_KEYS.includes(fieldKey)) {
    return payloadSummary[fieldKey]
      || payload[fieldKey]
      || payloadCustomFieldValue(payload.customfields, payloadSummary[`${fieldKey}CustomFieldId`] || payload[`${fieldKey}CustomFieldId`]);
  }
  return payload[fieldKey] ?? payloadSummary[fieldKey];
}

function payloadDisplayValueForField(fieldKey = "", raw, payload = {}, payloadSummary = {}) {
  if (fieldKey === "note") return payloadSummary.note || raw;
  return payloadSummary[`${fieldKey}Display`]
    || payloadSummary[`${fieldKey}Name`]
    || payloadSummary[`${fieldKey}Label`]
    || (TARGET_NAMED_CUSTOM_FIELD_KEYS.includes(fieldKey) ? payloadSummary[fieldKey] : "");
}

function payloadCustomFieldValue(customfields = [], fieldId = "") {
  const id = stringValue(fieldId);
  if (!id) return "";
  const hit = (Array.isArray(customfields) ? customfields : []).find((field) => {
    const candidate = stringValue(field?.customfieldId || field?.customFieldId || field?.id || field?._id);
    return candidate === id;
  });
  return hit ? (hit.value ?? hit.values ?? hit.text ?? hit.displayValue ?? "") : "";
}

function targetSnapshotForField(fieldKey = "", verification = {}, task = null, payloadSummary = {}) {
  const mismatch = Array.isArray(verification?.mismatches)
    ? verification.mismatches.find((item) => item?.field === fieldKey)
    : null;
  if (mismatch) {
    return cleanObject({
      raw: snapshotValue(mismatch.actual),
      display: snapshotText(mismatch.actualDisplay || mismatch.actualName || mismatch.actualLabel || displayValue(mismatch.actual), fieldKey === "note" ? 4000 : 1600),
      present: hasValue(mismatch.actual) || hasValue(mismatch.actualDisplay),
      source: "verification-mismatch",
    });
  }
  if (TARGET_NAMED_CUSTOM_FIELD_KEYS.includes(fieldKey)) {
    const fieldId = payloadSummary[`${fieldKey}CustomFieldId`];
    const category = targetCategoryCustomFieldSnapshot(task, fieldId, fieldKey);
    if (category.present) return category;
    const customfieldsMismatch = Array.isArray(verification?.mismatches)
      ? verification.mismatches.find((item) => item?.field === "customfields")
      : null;
    const fromCustomfields = categorySnapshotFromCustomfieldsMismatch(customfieldsMismatch, fieldId, fieldKey);
    if (fromCustomfields?.present) return fromCustomfields;
  }
  if (fieldKey === "note") {
    const note = verification?.notePrevious
      ?? task?.noteDisplay
      ?? task?.noteMarkdown
      ?? task?.note
      ?? "";
    return cleanObject({
      raw: snapshotValue(note),
      display: snapshotText(note, 4000),
      present: hasValue(note) || !!verification?.noteRead?.empty,
      source: "target-task",
    });
  }
  const raw = task ? (task[fieldKey] ?? readTargetFieldValue(task, TARGET_FIELD_KEY_MAP[fieldKey] || [])) : "";
  const display = task ? targetDisplayForSnapshotField(task, fieldKey, raw) : "";
  return cleanObject({
    raw: snapshotValue(raw),
    display: snapshotText(display || displayValue(raw), 1600),
    present: hasValue(raw) || hasValue(display),
    source: "target-task",
  });
}

function targetCategoryCustomFieldSnapshot(task = null, fieldId = "", fieldKey = "") {
  const entries = targetCustomFieldEntries(task ? readTargetFieldValue(task, TARGET_FIELD_KEY_MAP.customfields) : []);
  const id = stringValue(fieldId);
  const names = new Set((TARGET_NAMED_CUSTOM_FIELD_NAME_MAP[fieldKey] || []).map(normalizedCustomFieldName).filter(Boolean));
  const hit = (id ? entries.find((field) => readTargetCustomFieldId(field) === id) : null)
    || (names.size ? entries.find((field) => names.has(normalizedCustomFieldName(readTargetCustomFieldName(field)))) : null);
  if (!hit) return { present: false };
  const raw = readTargetCustomFieldPath(hit, TARGET_CUSTOM_FIELD_VALUE_PATHS);
  const display = targetCustomFieldDisplay(hit);
  return cleanObject({
    raw: snapshotValue(hasValue(raw) ? raw : display),
    display: snapshotText(display || displayValue(raw), 1600),
    customFieldId: readTargetCustomFieldId(hit),
    customFieldName: readTargetCustomFieldName(hit),
    present: hasValue(raw) || hasValue(display),
    source: "target-customfield",
  });
}

function readTargetCustomFieldName(field = {}) {
  return stringValue(readTargetCustomFieldPath(field, [
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
  ]));
}

function plannedCategoryCustomFieldValue(fieldKey = "", payload = {}, cfg = {}, fieldId = "") {
  const fromCustom = payloadCustomFieldValue(payload.customfields, fieldId);
  if (hasValue(fromCustom)) return stringValue(displayValue(fromCustom) || fromCustom);
  if (fieldKey === "applicationCategory") return teambitionApplicationCategoryValue(cfg);
  if (fieldKey === "defectCategory") return teambitionDefectCategoryValue(cfg);
  return "";
}

function enrichTargetCategoryCustomFields(task = {}, payload = {}, cfg = {}) {
  if (!task || typeof task !== "object") return task;
  for (const fieldKey of TARGET_NAMED_CUSTOM_FIELD_KEYS) {
    const fieldId = stringValue(cfg.teambition?.[`${fieldKey}CustomFieldId`]);
    const snapshot = targetCategoryCustomFieldSnapshot(task, fieldId, fieldKey);
    if (!snapshot.present) continue;
    task[fieldKey] = snapshot.raw ?? snapshot.display ?? "";
    if (snapshot.display) task[`${fieldKey}Display`] = snapshot.display;
  }
  return task;
}

function categorySnapshotFromCustomfieldsMismatch(mismatch = null, fieldId = "", fieldKey = "") {
  if (!mismatch || mismatch.field !== "customfields") return null;
  const actualEntries = parseNormalizedCustomFieldEntries(mismatch.actual);
  const hit = findCategoryCustomFieldEntry(actualEntries, fieldId, fieldKey);
  if (!hit) return null;
  const display = targetCustomFieldDisplay(hit);
  const raw = readTargetCustomFieldPath(hit, TARGET_CUSTOM_FIELD_VALUE_PATHS) ?? display;
  if (!hasValue(raw) && !hasValue(display)) return null;
  return cleanObject({
    raw: snapshotValue(hasValue(raw) ? raw : display),
    display: snapshotText(display || displayValue(raw), 1600),
    customFieldId: readTargetCustomFieldId(hit),
    customFieldName: readTargetCustomFieldName(hit),
    present: true,
    source: "verification-customfields-mismatch",
  });
}

function parseNormalizedCustomFieldEntries(value) {
  if (Array.isArray(value)) {
    return value.flatMap((item) => {
      if (Array.isArray(item) && item.length >= 2) return [{ customfieldId: item[0], value: item[1] }];
      return item && typeof item === "object" ? [item] : [];
    });
  }
  const text = stringValue(value);
  if (!text) return [];
  try {
    const parsed = JSON.parse(text);
    if (!Array.isArray(parsed)) return [];
    return parsed.map(([customfieldId, fieldValue]) => ({ customfieldId, value: fieldValue }));
  } catch {
    return [];
  }
}

function findCategoryCustomFieldEntry(entries = [], fieldId = "", fieldKey = "") {
  const id = stringValue(fieldId);
  const names = new Set((TARGET_NAMED_CUSTOM_FIELD_NAME_MAP[fieldKey] || []).map(normalizedCustomFieldName).filter(Boolean));
  return (id ? entries.find((field) => readTargetCustomFieldId(field) === id) : null)
    || (names.size ? entries.find((field) => names.has(normalizedCustomFieldName(readTargetCustomFieldName(field)))) : null)
    || null;
}

function targetCustomFieldDisplay(field = {}) {
  const raw = readTargetCustomFieldPath(field, TARGET_CUSTOM_FIELD_VALUE_PATHS);
  const parts = targetCustomFieldReadableParts(raw);
  if (parts.length) return parts.join(", ");
  const fallback = targetCustomFieldReadableParts(field);
  return fallback.join(", ");
}

function normalizedCustomFieldName(value = "") {
  return stringValue(value).replace(/\s+/g, "").toLowerCase();
}

function targetDisplayForSnapshotField(task = {}, fieldKey = "", raw = "") {
  const explicit = task?.[`${fieldKey}Display`] || readTargetFieldDisplayPath(task, TARGET_FIELD_DISPLAY_KEY_MAP[fieldKey] || []);
  if (explicit && String(explicit) !== String(raw ?? "")) return explicit;
  if (fieldKey === "priority") return teambitionPriorityDisplay(raw) || "";
  if (fieldKey === "tasklistId") return teambitionTasklistDisplay(raw) || "";
  if (fieldKey === "sprintId") return teambitionSprintDisplay(raw) || "";
  if (fieldKey === "executorId") return teambitionMemberDisplay(raw) || "";
  if (fieldKey === "involveMembers") {
    return normalizeTargetListValue(raw).map((memberId) => teambitionMemberDisplay(memberId) || memberId).filter(Boolean).join(", ");
  }
  if (fieldKey === "projectId") return teambitionProjectDisplayForPayload(task, {}) || "";
  return "";
}

function comparisonActionForField(fieldKey = "", current = {}, next = {}, action = "", targetTaskId = "") {
  if (action === "create" || !targetTaskId) return "write";
  if (!next?.present) return "skip";
  if (!current?.present) return "write";
  const currentRaw = current.raw ?? "";
  const nextRaw = next.raw ?? "";
  const currentDisplay = current.display ?? currentRaw;
  const nextDisplay = next.display ?? nextRaw;
  if (sameTargetCompareValue(fieldKey, normalizeTargetCompareValue(fieldKey, currentRaw), normalizeTargetCompareValue(fieldKey, nextRaw))) return "same";
  if (sameSnapshotDisplayValue(fieldKey, currentDisplay, nextDisplay)) return "same";
  return "update";
}

function sameSnapshotDisplayValue(fieldKey = "", current = "", next = "") {
  const normalize = (value) => {
    if (fieldKey === "priority") return comparableTeambitionPriority(value);
    if (fieldKey === "tasklistId") return comparableTeambitionTasklist(value);
    if (fieldKey === "involveMembers") return comparableTeambitionMemberList(value);
    if (fieldKey === "tagIds") return normalizeComparableTargetListValue(value).map((item) => normKey(item)).sort().join("\u001f");
    return normKey(value);
  };
  const a = normalize(current);
  const b = normalize(next);
  return !!a && !!b && a === b;
}

function comparisonReasonForField(fieldKey = "", current = {}, next = {}, fieldAction = "", rowAction = "", targetTaskId = "") {
  if (rowAction === "create" || !targetTaskId) return "target-not-created-yet";
  if (!current?.present) return "target-current-value-missing";
  if (fieldAction === "same") return "current-and-planned-values-are-equivalent";
  if (fieldAction === "update") return "current-and-planned-values-differ";
  return fieldKey ? "no-planned-change" : "";
}

function mappingSnapshotForField(fieldKey = "", item = {}, payloadSummary = {}, policyDecision = null) {
  const ruleIds = policyDecision?.matchedRule?.id ? [policyDecision.matchedRule.id] : [];
  return cleanObject({
    ruleIds,
    cardinality: "many-to-one",
    plannedDisplay: payloadSummary[`${fieldKey}Display`] || payloadSummary[fieldKey],
  });
}

function snapshotValue(value) {
  if (!hasValue(value)) return undefined;
  if (isPrimitiveValue(value)) return snapshotText(value, 1600);
  if (Array.isArray(value)) return value.slice(0, 20).map(snapshotValue).filter((item) => item !== undefined);
  try {
    return snapshotText(JSON.stringify(stable(value)), 1600);
  } catch {
    return snapshotText(displayValue(value), 1600);
  }
}

function snapshotText(value = "", max = 1600) {
  return clip(stringValue(value) || displayValue(value), max);
}

function shouldStopOnFirstError(options = {}, cfg = {}) {
  if (options.dryRun) return false;
  const explicit = options.stopOnFirstError ?? options.failFast ?? options.scope?.stopOnFirstError ?? options.scope?.failFast;
  if (explicit !== undefined) return parseBooleanOption(explicit, true);
  return cfg.sync?.stopOnFirstError !== false;
}

function parseBooleanOption(value, fallback = false) {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  return !["false", "0", "no", "off"].includes(String(value).trim().toLowerCase());
}

function duplicateIdentityForItem(item = {}, key = {}) {
  const sourceProblemNo = getSourceProblemNo(item);
  return duplicateIdentityFromParts({
    sourceId: sourceIdFromSyncKey(key),
    sourceProblemNo,
    sourceWorkItemNo: sourceProblemNo || getSourceWorkItemNo(item),
    sourceWorkItemId: item.sourceWorkItemId,
  });
}

function duplicateIdentityForState(row = {}, cfg = {}) {
  let item = null;
  const raw = readLatestRawPayload(row);
  if (raw) {
    try { item = normalizeFeishuWorkItem(raw, cfg); } catch {}
  }
  const sourceProblemNo = item ? getSourceProblemNo(item) : "";
  return duplicateIdentityFromParts({
    sourceId: sourceIdFromSyncKey(row),
    sourceProblemNo,
    sourceWorkItemNo: sourceProblemNo || (item ? getSourceWorkItemNo(item) : ""),
    sourceWorkItemId: row.sourceWorkItemId || row.source_work_item_id,
  });
}

function duplicateIdentityFromParts({ sourceId = "", sourceProblemNo = "", sourceWorkItemNo = "", sourceWorkItemId = "" } = {}) {
  const problemNo = stringValue(sourceProblemNo);
  const shownNo = problemNo || stringValue(sourceWorkItemNo) || stringValue(sourceWorkItemId);
  const values = uniq([
    problemNo,
    shownNo,
    sourceWorkItemId,
    sourceId,
  ].map(stringValue).filter(Boolean));
  const matchKeys = uniq(values.map(normalizeDuplicateIdentityKey).filter(Boolean));
  const textTokens = uniq(values.filter(shouldUseDuplicateTextToken));
  return {
    sourceId: stringValue(sourceId),
    sourceProblemNo: problemNo,
    problemNo,
    sourceWorkItemNo: shownNo,
    sourceWorkItemId: stringValue(sourceWorkItemId),
    primaryKey: normalizeDuplicateIdentityKey(problemNo || shownNo || sourceWorkItemId || sourceId),
    searchValues: values,
    matchKeys,
    textTokens,
  };
}

function normalizeDuplicateIdentityKey(value) {
  const text = stringValue(value);
  if (!text) return "";
  return normKey(text);
}

function shouldUseDuplicateTextToken(value) {
  const text = stringValue(value);
  if (!text) return false;
  if (/^[A-Z][A-Z0-9]+-\d+$/i.test(text)) return true;
  if (text.includes("/") && text.length >= 8) return true;
  return text.length >= 8 && /[a-z0-9]/i.test(text);
}

function buildDuplicateSyncStateIndex(cfg = {}, options = {}) {
  const rows = listFeishuProjectSyncStates({
    projectKey: options.projectKey || "",
    typeKey: options.typeKey || "",
    limit: options.limit || 1000,
  }).filter((row) => row?.targetTaskId);
  const byKey = new Map();
  for (const row of rows) {
    const identity = duplicateIdentityForState(row, cfg);
    const task = duplicateTaskFromSyncState(row, identity, cfg);
    for (const key of identity.matchKeys) {
      if (!byKey.has(key)) byKey.set(key, []);
      byKey.get(key).push(task);
    }
  }
  return { byKey, rows };
}

function duplicateStateTasksForIdentity(index = {}, identity = {}) {
  const tasks = [];
  for (const key of identity.matchKeys || []) {
    tasks.push(...(index.byKey?.get(key) || []));
  }
  return uniqueRows(tasks, (task) => task.id || task.targetTaskId);
}

function duplicateTaskFromSyncState(row = {}, identity = {}, cfg = {}) {
  const id = row.targetTaskId || row.target_task_id || "";
  const sourceNo = identity.sourceWorkItemNo || row.sourceWorkItemId || row.source_work_item_id || "";
  return {
    id,
    taskId: id,
    targetTaskId: id,
    uniqueId: row.targetUniqueId || row.target_unique_id || "",
    title: sourceNo ? `Feishu ${sourceNo}` : id,
    content: sourceNo ? `Feishu ${sourceNo}` : id,
    projectId: cfg.teambition?.projectId || "",
    matchedBy: "local-sync-state",
    matchedValue: sourceNo || identity.sourceId,
    sourceId: identity.sourceId,
    sourceProblemNo: identity.sourceProblemNo || "",
    problemNo: identity.sourceProblemNo || "",
    sourceWorkItemId: row.sourceWorkItemId || row.source_work_item_id || "",
    sourceWorkItemNo: sourceNo,
    updatedAt: row.targetUpdatedAt || row.target_updated_at || row.updatedAt || row.updated_at || "",
    createdAt: row.createdAt || row.created_at || "",
  };
}

async function loadDuplicateCheckWorkItems(options = {}, cfg = {}, limit = 50) {
  const selectors = workItemSelectorsFromOptions(options, cfg, { includePoc: true });
  if (Array.isArray(options.workItems)) {
    return {
      items: options.workItems.slice(0, limit),
      sourceResults: Array.isArray(options.sourceResults) ? options.sourceResults : [],
    };
  }
  return loadFeishuWorkItemsAcrossSourceViews(options, cfg, limit, {
    selectors,
    includeComments: false,
    includeAttachments: false,
  });
}

export function buildFeishuFetchOptions(cfg = {}, options = {}) {
  const sourceView = getFeishuSourceView(cfg);
  const sort = normalizeFeishuSortRules(options.sort || options.scope?.sort || cfg.sync?.sort);
  const configuredExtraBody = cfg.sync?.searchExtraBody && typeof cfg.sync.searchExtraBody === "object" ? cfg.sync.searchExtraBody : {};
  const scopedExtraBody = options.scope?.extraBody && typeof options.scope.extraBody === "object" ? options.scope.extraBody : {};
  const sourceViewBody = sourceView.viewId ? {
    view_id: sourceView.viewId,
    viewId: sourceView.viewId,
    work_object_view_id: sourceView.viewId,
    workObjectViewId: sourceView.viewId,
    view_scope: sourceView.scope,
    node: sourceView.node,
  } : {};
  return cleanObject({
    projectKey: sourceView.sourceProjectKey || cfg.feishu?.spaceKey,
    typeKey: sourceView.sourceWorkItemTypeKey || cfg.feishu?.workItemTypeKey,
    sourceView,
    sourceViewId: sourceView.viewId,
    sourceViewUrl: sourceView.url,
    filter: options.scope?.filter || cfg.sync?.searchFilter,
    query: options.query || options.scope?.query || cfg.sync?.query,
    orderBy: sort.length ? sort.map((rule) => ({
      field_key: rule.fieldKey || rule.fieldName,
      fieldKey: rule.fieldKey || rule.fieldName,
      field_name: rule.fieldName || rule.fieldKey,
      fieldName: rule.fieldName || rule.fieldKey,
      direction: rule.direction,
      order: rule.direction,
    })) : undefined,
    extraBody: cleanObject({
      ...configuredExtraBody,
      ...scopedExtraBody,
      // 来源身份必须拥有最高优先级；旧版单来源配置里残留的 view_id
      // 不能把后续 sourceViews 请求重新指回默认视图。
      ...sourceViewBody,
    }),
  });
}

function normalizeDuplicateTask(task = {}) {
  const id = String(
    task.id || task.taskId || task.targetTaskId || task.target_task_id || extractTargetTaskId(task) || "",
  ).trim();
  const uniqueId = task.uniqueId || task.unique_id || task.targetUniqueId || task.target_unique_id || extractTargetUniqueId(task) || "";
  const title = stringValue(task.title || task.content || task.name || task.raw?.content || task.raw?.title || "");
  return {
    id,
    taskId: id,
    targetTaskId: id,
    uniqueId,
    title,
    content: title,
    projectId: task.projectId || task._projectId || task.raw?._projectId || task.raw?.projectId || "",
    projectName: task.projectName || task.raw?.projectName || task.raw?.project?.name || "",
    tasklistId: task.tasklistId || task._tasklistId || task.raw?._tasklistId || task.raw?.tasklistId || "",
    tasklistName: task.tasklistName || task.raw?.tasklistName || task.raw?.tasklist?.title || task.raw?.tasklist?.name || "",
    stageId: task.stageId || task._stageId || task.raw?._stageId || task.raw?.stageId || "",
    stageName: task.stageName || task.raw?.stageName || task.raw?.stage?.name || "",
    executorId: task.executorId || task._executorId || task.raw?._executorId || task.raw?.executorId || "",
    executorName: task.executorName || task.raw?.executorName || task.raw?.executor?.name || "",
    statusId: task.statusId || task._taskflowstatusId || task.raw?._taskflowstatusId || "",
    statusName: task.statusName || task.status || task.raw?.statusName || task.raw?.taskflowstatus?.name || "",
    isDone: task.isDone ?? task.done ?? task.raw?.isDone ?? false,
    createdAt: task.createdAt || task.created || task.raw?.createdAt || task.raw?.created || task.raw?._createdAt || "",
    updatedAt: task.updatedAt || task.updated || task.raw?.updatedAt || task.raw?.updated || task.raw?._updatedAt || "",
    matchedBy: task.matchedBy || task.matchBy || "",
    matchedValue: task.matchedValue || task.matchValue || "",
    sourceId: task.sourceId || task.raw?.sourceId || "",
    sourceWorkItemId: task.sourceWorkItemId || task.raw?.sourceWorkItemId || "",
    sourceWorkItemNo: task.sourceWorkItemNo || task.raw?.sourceWorkItemNo || "",
    url: task.url || (id ? `https://www.teambition.com/task/${encodeURIComponent(id)}` : ""),
  };
}

function duplicateMergeSourceKey(options = {}, cfg = {}) {
  const sourceKey = options.sourceKey || options.key || {};
  const sourceId = String(options.sourceId || sourceKey.sourceId || "").trim();
  const parts = sourceId ? sourceId.split("/") : [];
  return {
    sourceSystem: sourceKey.sourceSystem || options.sourceSystem || SOURCE_SYSTEM,
    sourceProjectKey: sourceKey.sourceProjectKey || sourceKey.source_project_key || options.sourceProjectKey || options.projectKey || parts[0] || cfg.feishu?.spaceKey || "",
    sourceWorkItemTypeKey: sourceKey.sourceWorkItemTypeKey || sourceKey.source_work_item_type_key || options.sourceWorkItemTypeKey || options.typeKey || parts[1] || cfg.feishu?.workItemTypeKey || "",
    sourceWorkItemId: sourceKey.sourceWorkItemId || sourceKey.source_work_item_id || options.sourceWorkItemId || options.workItemId || parts.slice(2).join("/") || "",
    targetSystem: sourceKey.targetSystem || sourceKey.target_system || options.targetSystem || TARGET_SYSTEM,
  };
}

function formatDuplicateMergeComment({ sourceId, targetTaskId, duplicateTaskIds = [], deleteDuplicateTasks = false } = {}) {
  return [
    "Feishu sync duplicate merge",
    `Source ID: ${sourceId || "-"}`,
    `Canonical TB task: ${targetTaskId || "-"}`,
    duplicateTaskIds.length ? `Merged duplicate TB tasks: ${duplicateTaskIds.join(", ")}` : "Merged duplicate TB tasks: none",
    `Delete duplicates: ${deleteDuplicateTasks ? "yes" : "no"}`,
    `Merged at: ${new Date().toISOString()}`,
  ].join("\n");
}

function readLatestRawPayload(key) {
  const row = getLatestFeishuProjectRawPayload(key);
  if (!row?.payloadJson) return null;
  try {
    return JSON.parse(row.payloadJson);
  } catch {
    return null;
  }
}

function clampLimit(value, fallback = 100, max = 1000) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(Math.floor(n), max);
}

function countBy(rows, keyFn) {
  return (rows || []).reduce((acc, row) => {
    const key = keyFn(row);
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});
}

function uniqueRows(rows, keyFn) {
  const seen = new Set();
  const out = [];
  for (const row of rows || []) {
    const key = keyFn(row);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(row);
  }
  return out;
}

function syncKey(item) {
  return {
    sourceSystem: SOURCE_SYSTEM,
    sourceProjectKey: item.sourceProjectKey,
    sourceWorkItemTypeKey: item.sourceWorkItemTypeKey,
    sourceWorkItemId: item.sourceWorkItemId,
    targetSystem: TARGET_SYSTEM,
  };
}

function sourceIdFromSyncKey(key = {}) {
  return [key.sourceProjectKey, key.sourceWorkItemTypeKey, key.sourceWorkItemId]
    .map((part) => String(part || "").trim())
    .filter(Boolean)
    .join("/");
}

async function recoverCreatedTargetTask(payload, loader, cfg, options = {}) {
  if (!loader?.findTaskByContent || !payload?.content) return null;
  const logMiss = options.logMiss !== false;
  const findCfg = payload.projectId
    ? { ...cfg, teambition: { ...(cfg.teambition || {}), projectId: payload.projectId } }
    : cfg;
  try {
    const recovered = await loader.findTaskByContent(payload.content, findCfg);
    if (!recovered && logMiss) {
      log("system", "warn", "feishu-project-sync", `unable to recover created TB task by title: no matching task for "${clip(payload.content, 160)}"`);
    }
    return recovered;
  } catch (err) {
    log("system", "warn", "feishu-project-sync", `unable to recover created TB task by title: ${err?.message || String(err)}`);
    return null;
  }
}

async function recoverTargetTaskBySourceId(sourceId, payload, loader, cfg, options = {}) {
  if (!loader?.findTaskBySourceId || !sourceId) return null;
  const logMiss = options.logMiss !== false;
  const findCfg = payload.projectId
    ? { ...cfg, teambition: { ...(cfg.teambition || {}), projectId: payload.projectId } }
    : cfg;
  try {
    const recovered = await loader.findTaskBySourceId(sourceId, findCfg);
    if (!recovered && logMiss) {
      log("system", "warn", "feishu-project-sync", `unable to recover TB task by Source ID: no matching task for "${clip(sourceId, 160)}"`);
    }
    return recovered;
  } catch (err) {
    log("system", "warn", "feishu-project-sync", `unable to recover TB task by Source ID: ${err?.message || String(err)}`);
    return null;
  }
}

async function recoverTargetTaskBySystemNo(systemNo, payload, loader, cfg, options = {}) {
  const token = stringValue(systemNo);
  if (!loader?.findTasksByTextToken || !/^[A-Z][A-Z0-9]+-\d+$/i.test(token)) return null;
  const logMiss = options.logMiss !== false;
  const findCfg = payload.projectId
    ? { ...cfg, teambition: { ...(cfg.teambition || {}), projectId: payload.projectId } }
    : cfg;
  try {
    const matches = await loader.findTasksByTextToken(token, findCfg);
    const recovered = (matches || []).find((task) => extractTargetTaskId(task)) || null;
    if (!recovered && logMiss) {
      log("system", "warn", "feishu-project-sync", `unable to recover TB task by system no: no matching task for "${clip(token, 160)}"`);
    }
    return recovered;
  } catch (err) {
    log("system", "warn", "feishu-project-sync", `unable to recover TB task by system no: ${err?.message || String(err)}`);
    return null;
  }
}

function shouldRecoverCreatedTaskBeforeCreate(existing) {
  if (!existing || existing.targetTaskId || existing.target_task_id) return false;
  const status = syncRowStatus(existing);
  const error = String(existing.lastError || existing.last_error || "");
  return status === "failed" && /task id missing from loader result/i.test(error);
}

function shouldCheckRemoteExistingBeforeCreate(options = {}, cfg = {}) {
  if (options.checkRemoteExisting === false || options.remoteDedupBeforeCreate === false) return false;
  if (cfg.sync?.checkRemoteExisting === false || cfg.sync?.remoteDedupBeforeCreate === false) return false;
  return true;
}

async function findRemoteExistingBeforeCreate(payload, loader, cfg, sourceId = "", systemNo = "") {
  let source = "feishu-system-no";
  let recovered = await recoverTargetTaskBySystemNo(systemNo, payload, loader, cfg, { logMiss: false });
  if (extractTargetTaskId(recovered)) {
    return {
      targetTaskId: extractTargetTaskId(recovered),
      targetUniqueId: extractTargetUniqueId(recovered),
      source,
      task: recovered,
    };
  }
  source = "feishu-source-id";
  recovered = await recoverTargetTaskBySourceId(sourceId, payload, loader, cfg, { logMiss: false });
  if (!extractTargetTaskId(recovered)) {
    source = "teambition-title";
    recovered = await recoverCreatedTargetTask(payload, loader, cfg, { logMiss: false });
  }
  const targetTaskId = extractTargetTaskId(recovered);
  if (!targetTaskId) return null;
  return {
    targetTaskId,
    targetUniqueId: extractTargetUniqueId(recovered),
    source,
    task: recovered,
  };
}

function syncStateFromRemoteExisting(existing, remoteExisting) {
  return {
    ...(existing || {}),
    targetTaskId: remoteExisting.targetTaskId,
    targetUniqueId: remoteExisting.targetUniqueId || existing?.targetUniqueId || "",
    targetUpdatedAt: extractTargetUpdatedAt(remoteExisting.task) || existing?.targetUpdatedAt || "",
    syncStatus: existing?.syncStatus || "remote",
    lastError: existing?.lastError || "",
    remoteRecovered: true,
    remoteRecoveredBy: remoteExisting.source,
  };
}

const TARGET_TASK_ID_KEYS = [
  "_id", "id", "taskId", "task_id", "_taskId", "targetTaskId", "target_task_id", "objectId", "object_id",
  "ids", "_ids", "idList", "taskIds", "taskIdList", "task_id_list", "objectIds", "objectIdList",
];
const TARGET_TASK_UNIQUE_ID_KEYS = ["uniqueId", "unique_id", "uniqueID", "taskUniqueId", "targetUniqueId", "target_unique_id"];
const TARGET_TASK_UPDATED_AT_KEYS = ["updatedAt", "updated_at", "updated", "_updatedAt", "modified", "targetUpdatedAt", "target_updated_at"];
const TARGET_TASK_OBJECT_KEYS = [
  "task", "target", "object", "work", "workItem", "todo", "data", "result",
  "successfulList", "successList", "succeeded", "created", "createdTask",
  "tasks", "items", "list", "records", "rows", "raw",
];

function extractTargetTaskId(target) {
  return firstTargetValue(target, TARGET_TASK_ID_KEYS) || "";
}

function extractTargetUniqueId(target) {
  return firstTargetValue(target, TARGET_TASK_UNIQUE_ID_KEYS) || "";
}

function extractTargetUpdatedAt(target) {
  return dateValue(firstTargetValue(target, TARGET_TASK_UPDATED_AT_KEYS)) || "";
}

function describeTargetTaskResult(target) {
  const detail = firstTargetError(target);
  return detail ? `Teambition task create returned no task id: ${clip(detail, 500)}` : "";
}

function firstTargetError(value, depth = 0) {
  if (value == null || depth > 5) return "";
  if (typeof value === "string") return value.trim();
  if (typeof value !== "object") return "";
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = firstTargetError(item, depth + 1);
      if (found) return found;
    }
    return "";
  }
  for (const key of ["errorMessage", "error_message", "message", "error", "reason", "msg", "desc"]) {
    const direct = getCaseInsensitive(value, key);
    const text = stringValue(direct);
    if (text) return text;
  }
  for (const key of ["failedList", "failureList", "failures", "errors", "failed", "invalidList", "result", "data"]) {
    const child = getCaseInsensitive(value, key);
    if (child === null || child === undefined || child === value) continue;
    const found = firstTargetError(child, depth + 1);
    if (found) return found;
  }
  return "";
}

function firstTargetValue(target, valueKeys, depth = 0) {
  if (target == null || target === "") return "";
  if (typeof target === "string" && depth === 0 && /^[a-f0-9]{16,32}$/i.test(target.trim())) return target.trim();
  if (typeof target !== "object") return "";
  if (Array.isArray(target)) {
    for (const item of target) {
      const value = firstTargetValue(item, valueKeys, depth + 1);
      if (value) return value;
    }
    return "";
  }
  for (const key of valueKeys) {
    const value = getCaseInsensitive(target, key);
    if (value !== null && value !== undefined && value !== "") {
      const direct = firstKnownTargetValue(value, valueKeys, depth + 1);
      if (direct) return direct;
    }
  }
  if (depth >= 4) return "";
  for (const key of TARGET_TASK_OBJECT_KEYS) {
    const child = getCaseInsensitive(target, key);
    if (child === null || child === undefined || child === target) continue;
    const value = firstTargetValue(child, valueKeys, depth + 1);
    if (value) return value;
  }
  return "";
}

function firstKnownTargetValue(value, valueKeys, depth = 0) {
  if (value == null || value === "") return "";
  if (Array.isArray(value)) {
    for (const item of value) {
      const direct = stringValue(item);
      if (direct) return direct;
      const nested = firstTargetValue(item, valueKeys, depth + 1);
      if (nested) return nested;
    }
    return "";
  }
  const direct = stringValue(value);
  if (direct) return direct;
  return firstTargetValue(value, valueKeys, depth + 1);
}

function deepMerge(...objs) {
  const out = {};
  for (const obj of objs) {
    for (const [k, v] of Object.entries(obj || {})) {
      if (v && typeof v === "object" && !Array.isArray(v)) out[k] = deepMerge(out[k] || {}, v);
      else out[k] = v;
    }
  }
  return out;
}

function cleanObject(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj || {})) {
    if (v == null || v === "" || (Array.isArray(v) && !v.length)) continue;
    out[k] = v;
  }
  return out;
}

function hasValue(v) {
  return v !== undefined && v !== null && v !== "" && !(Array.isArray(v) && v.length === 0);
}

function isPrimitiveValue(v) {
  return typeof v === "string" || typeof v === "number" || typeof v === "boolean";
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") {
    return Object.keys(value).sort().reduce((acc, k) => {
      if (k === "raw") return acc;
      acc[k] = stable(value[k]);
      return acc;
    }, {});
  }
  return value;
}

function hashableSyncItem(item = {}) {
  return {
    ...item,
    attachments: (item.attachments || []).map((attachment) => cleanObject({
      ...attachment,
      url: attachment.sourceUrl || attachment.originalUrl || attachment.url,
      downloadHeaders: null,
      downloadExpiresAt: null,
      isMultipart: null,
      raw: null,
    })),
  };
}

function hashSyncPayloadForPolicy(item = {}, payload = {}, policyDecision = {}) {
  const fields = Object.values(policyDecision?.strategy?.fields || {});
  const selective = fields.some((field) => (
    field?.enabled === false || ["preserve", "skip"].includes(String(field?.mode || ""))
  ));
  return selective
    ? hashStable({ payload })
    : hashStable({ item: hashableSyncItem(item), payload });
}

function hashStable(value) {
  return createHash("sha256").update(JSON.stringify(stable(value))).digest("hex");
}

function renderTemplate(template, vars = {}) {
  return String(template || "").replace(/\{([^}]+)\}/g, (_, k) => String(vars[k] ?? ""));
}

function absUrl(base, path) {
  if (/^https?:\/\//i.test(path)) return path;
  return `${String(base || "").replace(/\/+$/, "")}/${String(path || "").replace(/^\/+/, "")}`;
}

async function safeJson(resp) {
  const text = await resp.text();
  try { return text ? JSON.parse(text) : {}; } catch { return { raw: text }; }
}

function getFirst(obj, keys) {
  for (const key of keys || []) {
    const v = getCaseInsensitive(obj, key);
    if (v != null && v !== "") return v;
  }
  return null;
}

function getFirstIncludingEmpty(obj, keys) {
  for (const key of keys || []) {
    const v = getCaseInsensitive(obj, key);
    if (v !== null && v !== undefined) return { found: true, value: v };
  }
  return { found: false, value: null };
}

function arrayValue(value, arrayKeys = []) {
  if (Array.isArray(value)) return value;
  if (value == null || value === "") return [];
  if (typeof value === "object") {
    const direct = firstArray(value, arrayKeys);
    if (direct) return direct;
    if (Array.isArray(value.value)) return value.value;
    if (Array.isArray(value.values)) return value.values;
    return [value];
  }
  return [value];
}

function normalizeStringList(value) {
  if (Array.isArray(value)) return value.map((x) => stringValue(x)).filter(Boolean);
  if (value == null || value === "") return [];
  return String(value)
    .split(/[\n,;]+/)
    .map((x) => x.trim())
    .filter(Boolean);
}

function firstArray(obj, keys) {
  for (const key of keys || []) {
    const value = getFirst(obj, [key]);
    if (Array.isArray(value)) return value;
  }
  return null;
}

function getCaseInsensitive(obj, key) {
  if (!obj || typeof obj !== "object") return null;
  if (Object.prototype.hasOwnProperty.call(obj, key)) return obj[key];
  const nk = normKey(key);
  const hit = Object.keys(obj).find((k) => normKey(k) === nk);
  return hit ? obj[hit] : null;
}

function normKey(v) {
  return String(v || "").trim().toLowerCase().replace(/[\s_-]+/g, "");
}

function stringValue(v) {
  if (v == null) return "";
  if (typeof v === "string") return v.trim();
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return "";
}

function displayValue(v) {
  if (v == null) return "";
  if (isPrimitiveValue(v)) return String(v);
  if (Array.isArray(v)) return v.map(displayValue).filter(Boolean).join(", ");
  if (typeof v === "object") {
    const candidate = getFirst(v, DISPLAY_VALUE_KEYS);
    if (candidate !== null && candidate !== undefined && candidate !== v) {
      const shown = displayValue(candidate);
      if (shown) return shown;
    }
    return JSON.stringify(v);
  }
  return String(v);
}

function richTextValue(v) {
  const parts = collectRichTextParts(v);
  const text = parts.join("\n").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  return text && !/^\{.*\}$/.test(text) ? text : "";
}

function collectRichTextParts(v) {
  if (v == null || v === "") return [];
  if (isPrimitiveValue(v)) return [String(v)];
  if (Array.isArray(v)) return v.flatMap(collectRichTextParts);
  if (typeof v !== "object") return [String(v)];

  const nodeType = stringValue(getCaseInsensitive(v, "type")).toLowerCase();
  if (["paragraph", "p", "heading", "blockquote", "listitem", "list_item"].includes(nodeType)) {
    const nested = getFirst(v, ["content", "contents", "children", "items", "elements", "text"]);
    const line = collectRichTextParts(nested).join("").trimEnd();
    return [line];
  }

  for (const key of ["plain_text", "plainText", "text", "display_value", "displayValue"]) {
    const direct = getCaseInsensitive(v, key);
    if (isPrimitiveValue(direct) && String(direct).trim()) return [String(direct)];
  }

  const nested = getFirst(v, [
    "content",
    "contents",
    "children",
    "items",
    "elements",
    "blocks",
    "paragraphs",
    "value",
    "field_value",
    "fieldValue",
    "body",
    "description",
    "desc",
  ]);
  if (nested != null && nested !== v) {
    const nestedParts = collectRichTextParts(nested);
    if (nestedParts.length) return nestedParts;
  }

  const out = [];
  for (const [key, value] of Object.entries(v)) {
    const normalized = normKey(key);
    if (["id", "key", "type", "uuid", "token", "fieldkey", "fieldname"].includes(normalized)) continue;
    if (value && typeof value === "object") out.push(...collectRichTextParts(value));
  }
  return out.filter(Boolean);
}

function dateValue(v) {
  if (!v) return "";
  if (typeof v === "number") return new Date(v > 10_000_000_000 ? v : v * 1000).toISOString();
  if (typeof v === "object") {
    const iso = getFirst(v, ["iso_time", "isoTime", "date_time", "dateTime", "datetime", "date", "time"]);
    if (iso && iso !== v) return dateValue(iso);
    const timestamp = getFirst(v, ["timestamp", "time_stamp", "timeStamp", "ts"]);
    if (typeof timestamp === "number" || (typeof timestamp === "string" && /^\d+$/.test(timestamp))) {
      return dateValue(Number(timestamp));
    }
  }
  const s = displayValue(v);
  if (!s) return "";
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? s : d.toISOString();
}

function uniq(arr) {
  return [...new Set(arr)];
}

function clip(s, n = 500) {
  s = String(s || "");
  if (s.length <= n) return s;
  if (n <= 3) return s.slice(0, Math.max(0, n));
  return `${s.slice(0, n - 3)}...`;
}
