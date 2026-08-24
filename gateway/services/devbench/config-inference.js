import {
  calibrateConfigInferenceScore,
  evaluateConfigInferencePolicy,
} from "./machine-learn/calibration.js";
import {
  extractStructuredConfigEvidence,
  structuredEvidenceSummary,
} from "./machine-learn/evidence-extractor.js";
import { evaluateSourceCoverage } from "./machine-learn/source-snapshot.js";

const MAX_TEXT_LENGTH = 100000;

export const CONFIG_INFERENCE_GROUPS = Object.freeze([
  "title",
  "project",
  "iteration",
  "tag",
  "attachment",
  "comment",
]);

// 关键词映射仍固定为上面的六组；TB 备注没有独立映射面板，但要作为历史样本
// 相似度的一手上下文参与学习，不能在工单归一化时被丢弃。
export const CONFIG_INFERENCE_SOURCE_GROUPS = Object.freeze([
  ...CONFIG_INFERENCE_GROUPS,
  "note",
]);

export const CONFIG_INFERENCE_DIMENSIONS = Object.freeze([
  "appName",
  "vehicle",
  "repositoryId",
  "branch",
  "flavor",
]);

export const CONFIG_INFERENCE_SYMBOLIC_FIELDS = Object.freeze([
  "appName",
  "vehicle",
  "repositoryId",
  "branch",
  "flavor",
]);

// 五个工程配置维度支持“稳定逻辑值 + 可替换实际值”。排序仍由整组目标原子
// 归一化，避免单独替换一个 order 后产生重复序号或悄悄交换主/依赖工程；但会
// 在 fieldBindings 中返回只读逻辑对，供 UI 完整展示。
export const CONFIG_INFERENCE_BINDABLE_FIELDS = Object.freeze([
  ...CONFIG_INFERENCE_DIMENSIONS,
  "order",
]);
export const CONFIG_INFERENCE_REPLACEABLE_FIELDS = Object.freeze([
  ...CONFIG_INFERENCE_DIMENSIONS,
]);

export const CONFIG_INFERENCE_VERSION = "config-inference-rules-v4";
export const CONFIG_INFERENCE_RAG_VERSION = "config-inference-rag-v1";
export const CONFIG_INFERENCE_QUALITY_VERSION = "config-inference-quality-v2";

const CONFIDENCE_METHOD = "heuristic-score-quality-margin-v1";
const MIN_EXECUTION_ANCHOR_MARGIN = 0.15;
const SERVING_SAMPLE_STATES = new Set(["approved", "active", "verified"]);
const NON_SERVING_SAMPLE_STATES = new Set([
  "draft",
  "pending",
  "reviewing",
  "rejected",
  "revoked",
  "superseded",
  "quarantined",
  "inactive",
  "disabled",
]);

const GROUP_WEIGHTS = Object.freeze({
  title: 26,
  project: 28,
  iteration: 18,
  tag: 22,
  attachment: 24,
  comment: 20,
});

// 当前 TB 单明确解析出的应用、车型、Flavor、分支都是本次推理的上下文约束。
// 历史样本只能在同一上下文内补充排序或依赖，不能把另一车型/应用的完整配置
// 当成“更热门的默认值”覆盖当前证据。
const CURRENT_VARIANT_DIMENSIONS = Object.freeze(["vehicle", "flavor", "branch"]);
const CURRENT_TARGET_CONTEXT_DIMENSIONS = Object.freeze(["appName", ...CURRENT_VARIANT_DIMENSIONS]);
const CURRENT_SIGNAL_GROUP_PRIORITY = Object.freeze({
  title: 60,
  tag: 50,
  project: 40,
  iteration: 35,
  attachment: 20,
  comment: 10,
});
const STRONG_HISTORY_SIMILARITY = 0.72;
// 历史样本只用于同一当前上下文内的排序与补全。无论积累多少条相似工单，历史总分
// 都不能无限线性增长并压过本单标题/标签等直接证据。
const HISTORICAL_TARGET_SCORE_CAP = 96;

// 空白关键词映射只能在注册表中唯一命中时自动补全；车型优先，因为车型源码配置
// 本身就是完整 app/repository/branch/flavor 目标的聚合入口。
const REGISTRY_BRIDGE_DIMENSIONS = Object.freeze([
  "vehicle",
  "repositoryId",
  "appName",
  "flavor",
  "branch",
]);

function stringValue(value, max = MAX_TEXT_LENGTH) {
  const text = String(value == null ? "" : value).trim();
  return text.length > max ? text.slice(0, max) : text;
}

function uniqueStrings(value, maxItems = 200) {
  const list = Array.isArray(value)
    ? value
    : value == null || value === ""
      ? []
      : String(value).split(/[\n,，;；]+/);
  const out = [];
  const seen = new Set();
  for (const item of list) {
    const text = item && typeof item === "object"
      ? stringValue(item.name || item.title || item.label || item.value || item.content, 4000)
      : stringValue(item, 4000);
    if (!text) continue;
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(text);
    if (out.length >= maxItems) break;
  }
  return out;
}

function normalizeTargetFieldStates(value) {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const states = {};
  for (const field of CONFIG_INFERENCE_SYMBOLIC_FIELDS) {
    const raw = source[field];
    const row = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
    const kind = stringValue(row.kind || row.type || raw, 40).toLowerCase();
    if (!["symbolic", "placeholder", "intermediate"].includes(kind)) continue;
    states[field] = {
      kind: "symbolic",
      feature: stringValue(row.feature || row.description || row.meaning, 2000),
    };
  }
  return states;
}

function bindingScalar(value, field) {
  if (field === "order") {
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? Math.trunc(number) : 0;
  }
  return stringValue(value, field === "branch" ? 1000 : 3000);
}

function normalizeTargetFieldBindings(value) {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const bindings = {};
  for (const field of CONFIG_INFERENCE_BINDABLE_FIELDS) {
    const raw = source[field];
    const row = raw && typeof raw === "object" && !Array.isArray(raw)
      ? raw
      : typeof raw === "string"
        ? { logicalKey: raw }
        : {};
    const logicalKey = stringValue(row.logicalKey || row.key || row.id, 240);
    if (!logicalKey) continue;
    const revision = Math.max(0, Math.trunc(Number(row.revision) || 0));
    const actualValue = bindingScalar(row.actualValue ?? row.value, field);
    bindings[field] = {
      logicalKey,
      actualValue,
      defaultValue: bindingScalar(row.defaultValue, field),
      sourceValue: bindingScalar(row.sourceValue, field),
      scopeKey: stringValue(row.scopeKey, 1000),
      label: stringValue(row.label || row.name, 500),
      revision,
      resolved: row.resolved !== false && (field === "order" ? actualValue > 0 : !!actualValue),
      ...(row.replaceable === false || field === "order" ? { replaceable: false } : {}),
    };
  }
  return bindings;
}

function logicalKeySlug(value) {
  const slug = stringValue(value, 300)
    .toLowerCase()
    .replace(/[^a-z0-9\u3400-\u9fff]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 36);
  return slug || "value";
}

function logicalKeyHash(value) {
  // FNV-1a 足够用于稳定的兼容 key；这里不是安全摘要，冲突仍由完整上下文隔离。
  let hash = 0x811c9dc5;
  for (const character of String(value || "")) {
    hash ^= character.codePointAt(0);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(36).padStart(7, "0");
}

function bindingContext(target, field) {
  const value = field === "order" ? Number(target.order || 0) : stringValue(target[field], 3000);
  if (field === "appName") return `${field}|${compact(value)}`;
  if (field === "vehicle") return `${field}|${compact(value)}`;
  if (field === "repositoryId") return `${field}|${normalizedText(value)}`;
  return [
    field,
    normalizedText(target.repositoryId),
    compact(target.vehicle),
    compact(target.appName),
    field === "order" ? stringValue(target.targetRole, 40) : "",
    normalizedText(value),
  ].join("|");
}

function bindingScopeKey(target, field) {
  const values = {
    appName: [target.repositoryId, target.vehicle, target.targetRole],
    vehicle: [target.repositoryId, target.appName, target.targetRole],
    repositoryId: [target.appName, target.vehicle, target.targetRole],
    branch: [target.repositoryId, target.vehicle, target.appName, target.targetRole],
    flavor: [target.repositoryId, target.vehicle, target.appName, target.targetRole],
    order: [target.repositoryId, target.vehicle, target.appName, target.targetRole],
  };
  return `${field}|${(values[field] || []).map((value) => compact(value)).join("|")}`;
}

function derivedLogicalKey(projectId, target, field) {
  const state = target?.fieldStates?.[field];
  const seed = bindingScalar(target?.[field], field)
    || stringValue(state?.feature, 500)
    || field;
  const context = `${stringValue(projectId, 500)}|${bindingContext(target || {}, field)}`;
  return `ci.${field}.${logicalKeySlug(seed)}.${logicalKeyHash(context)}`;
}

function normalizeValueBindingRows(value) {
  const rows = Array.isArray(value)
    ? value
    : Object.entries(value && typeof value === "object" ? value : {}).map(([logicalKey, row]) => ({
      ...(row && typeof row === "object" ? row : {}),
      logicalKey: row?.logicalKey || logicalKey,
    }));
  const map = new Map();
  for (const raw of rows) {
    if (!raw || typeof raw !== "object") continue;
    const logicalKey = stringValue(raw.logicalKey || raw.key || raw.id, 240);
    const dimension = stringValue(raw.dimension || raw.field, 40);
    if (!logicalKey || !CONFIG_INFERENCE_REPLACEABLE_FIELDS.includes(dimension)) continue;
    map.set(logicalKey, {
      ...raw,
      logicalKey,
      dimension,
      actualValue: bindingScalar(raw.actualValue ?? raw.value, dimension),
      defaultValue: bindingScalar(raw.defaultValue, dimension),
      scopeKey: stringValue(raw.scopeKey, 1000),
      label: stringValue(raw.label || raw.name, 500),
      revision: Math.max(0, Math.trunc(Number(raw.revision) || 0)),
    });
  }
  return map;
}

export function bindConfigInferenceTargets(targets = [], {
  projectId = "",
  valueBindings = {},
  deriveMissing = true,
} = {}) {
  const central = normalizeValueBindingRows(valueBindings);
  return normalizeConfigInferenceTargets(targets).map((source) => {
    const target = { ...source };
    const fieldStates = normalizeTargetFieldStates(source.fieldStates);
    const existing = normalizeTargetFieldBindings(source.fieldBindings);
    const fieldBindings = {};
    for (const field of CONFIG_INFERENCE_BINDABLE_FIELDS) {
      const state = source.fieldStates?.[field];
      const rawValue = bindingScalar(source[field], field);
      if (!existing[field] && !deriveMissing) continue;
      if (!existing[field] && !rawValue && !state?.feature) continue;
      const scopeKey = existing[field]?.scopeKey || bindingScopeKey(source, field);
      const scopeMatches = !existing[field] && field !== "order"
        ? [...central.values()].filter((row) => row.dimension === field
          && row.scopeKey
          && row.scopeKey === scopeKey
          && compact(row.actualValue) === compact(rawValue))
        : [];
      const logicalKey = existing[field]?.logicalKey
        || (scopeMatches.length === 1 ? scopeMatches[0].logicalKey : "")
        || derivedLogicalKey(projectId, source, field);
      const current = central.get(logicalKey);
      const centralValue = current ? bindingScalar(current.actualValue, field) : "";
      const actualValue = centralValue
        || (state?.kind === "symbolic" ? "" : bindingScalar(existing[field]?.actualValue, field) || rawValue);
      const resolved = field === "order"
        ? actualValue > 0
        : !!actualValue && state?.kind !== "symbolic";
      fieldBindings[field] = {
        logicalKey,
        actualValue,
        defaultValue: current?.defaultValue || existing[field]?.defaultValue || (state?.kind === "symbolic" ? "" : rawValue),
        sourceValue: existing[field]?.sourceValue || rawValue || stringValue(state?.feature, 500),
        scopeKey,
        label: current?.label || existing[field]?.label || stringValue(state?.feature, 500) || `${field} · ${source.repositoryName || source.repositoryId || source.appName || "配置"}`,
        revision: Math.max(0, Math.trunc(Number(current?.revision ?? existing[field]?.revision) || 0)),
        resolved: centralValue ? true : resolved,
        ...(field === "order" ? { replaceable: false } : {}),
      };
      if (field !== "order" && centralValue) {
        target[field] = actualValue;
        delete fieldStates[field];
      }
    }
    if (Object.keys(fieldStates).length) {
      target.fieldStates = fieldStates;
      target.resolutionStatus = "partial";
    } else {
      delete target.fieldStates;
      if (target.resolutionStatus === "partial") target.resolutionStatus = "resolved";
    }
    if (Object.keys(fieldBindings).length) target.fieldBindings = fieldBindings;
    return target;
  });
}

export function configInferenceSymbolicFields(target = {}) {
  const states = normalizeTargetFieldStates(target.fieldStates);
  return CONFIG_INFERENCE_SYMBOLIC_FIELDS.filter((field) => states[field]?.kind === "symbolic");
}

export function hasConfigInferenceSymbolicFields(target = {}) {
  return configInferenceSymbolicFields(target).length > 0;
}

function compact(value) {
  return stringValue(value).toLowerCase().replace(/[^a-z0-9\u3400-\u9fff]+/g, "");
}

function normalizedText(value) {
  return stringValue(value).toLowerCase();
}

function normalizedTimestamp(value) {
  if (value == null || value === "") return "";
  if (typeof value === "number" && Number.isFinite(value)) return value;
  return stringValue(value, 160);
}

function isNegatedOccurrence(text, index) {
  const prefix = String(text || "").slice(Math.max(0, index - 24), index);
  return /(?:不是|并不是|并非|不属于|不应为|不要用|不要选|排除|无关(?:于)?|not|isn['’]?t|is\s+not|instead\s+of|rather\s+than)\s*[:：,，、\-—]*\s*$/i.test(prefix);
}

function containsAffirmedText(sourceValue, keyword) {
  const source = normalizedText(sourceValue);
  const needle = normalizedText(keyword);
  if (!source || !needle) return false;
  let offset = 0;
  while (offset <= source.length - needle.length) {
    const index = source.indexOf(needle, offset);
    if (index < 0) break;
    if (!isNegatedOccurrence(source, index)) return true;
    offset = index + Math.max(1, needle.length);
  }
  return false;
}

function sourceContains(sourceValues, keyword) {
  const needle = normalizedText(keyword);
  const compactNeedle = compact(keyword);
  if (!needle) return false;
  return sourceValues.some((source) => {
    if (containsAffirmedText(source, needle)) return true;
    return compactNeedle.length > 1 && containsAffirmedText(compact(source), compactNeedle);
  });
}

function normalizeCategory(category) {
  const value = stringValue(category, 80).toLowerCase();
  if (value === "app" || value === "application" || value === "appname") return "appName";
  if (value === "vehicle" || value === "car" || value === "carmodel") return "vehicle";
  if (value === "repository" || value === "repo" || value === "repositoryid") return "repositoryId";
  if (value === "branch") return "branch";
  if (value === "flavor" || value === "variant") return "flavor";
  return "";
}

function normalizeAttachment(item) {
  if (item && typeof item === "object" && !Array.isArray(item)) {
    return {
      id: stringValue(item.id || item._id, 160),
      name: stringValue(item.name || item.fileName || item.filename || item.title, 1000),
      text: stringValue(item.textSummary || item.summary || item.text || item.content || item.ocrText, 30000),
      size: Number(item.size || item.fileSize || 0) || 0,
      source: stringValue(item.source || item._source, 160),
      mimeType: stringValue(item.mimeType || item.contentType || item.type, 240),
      contentHash: stringValue(item.contentHash || item.hash || item.sha256, 240),
      createdAt: normalizedTimestamp(item.createdAt || item.created || item.uploadedAt),
      updatedAt: normalizedTimestamp(item.updatedAt || item.modifiedAt),
      availableAt: normalizedTimestamp(item.availableAt || item.fetchedAt || item.capturedAt),
    };
  }
  return {
    id: "",
    name: stringValue(item, 1000),
    text: "",
    size: 0,
    source: "",
    mimeType: "",
    contentHash: "",
    createdAt: "",
    updatedAt: "",
    availableAt: "",
  };
}

function normalizeComment(item) {
  if (item && typeof item === "object" && !Array.isArray(item)) {
    const author = item.author && typeof item.author === "object" ? item.author : {};
    return {
      id: stringValue(item.id || item._id, 160),
      text: stringValue(item.text || item.content || item.comment || item.markdown, 10000),
      authorId: stringValue(item.authorId || item.creatorId || author.id || author._id, 200),
      authorName: stringValue(item.authorName || item.creatorName || author.name || author.displayName, 500),
      source: stringValue(item.source || item._source, 160),
      createdAt: normalizedTimestamp(item.createdAt || item.created),
      updatedAt: normalizedTimestamp(item.updatedAt || item.modifiedAt),
      availableAt: normalizedTimestamp(item.availableAt || item.fetchedAt || item.capturedAt),
    };
  }
  return {
    id: "",
    text: stringValue(item, 10000),
    authorId: "",
    authorName: "",
    source: "",
    createdAt: "",
    updatedAt: "",
    availableAt: "",
  };
}

function normalizeSourceCoverageRow(value) {
  const row = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const normalized = {
    available: row.available === true,
  };
  if (row.complete != null) normalized.complete = row.complete === true;
  if (row.required != null) normalized.required = row.required === true;
  const count = Number(row.count);
  if (Number.isFinite(count) && count >= 0) normalized.count = Math.trunc(count);
  const images = Number(row.images);
  if (Number.isFinite(images) && images >= 0) normalized.images = Math.trunc(images);
  const source = stringValue(row.source, 240);
  const error = stringValue(row.error, 2000);
  if (source) normalized.source = source;
  if (error) normalized.error = error;
  for (const field of ["checkedAt", "capturedAt", "availableAt", "updatedAt"]) {
    const timestamp = normalizedTimestamp(row[field]);
    if (timestamp !== "") normalized[field] = timestamp;
  }
  return normalized;
}

function normalizeSourceCoverage(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const normalized = {};
  for (const [key, row] of Object.entries(value)) {
    if (key === "requiredSources") {
      normalized.requiredSources = uniqueStrings(row, 20);
      continue;
    }
    if (["snapshotAt", "capturedAt", "updatedAt"].includes(key)) {
      const timestamp = normalizedTimestamp(row);
      if (timestamp !== "") normalized[key] = timestamp;
      continue;
    }
    if (!row || typeof row !== "object" || Array.isArray(row)) continue;
    normalized[key] = normalizeSourceCoverageRow(row);
  }
  return Object.keys(normalized).length ? normalized : null;
}

export function normalizeConfigInferenceTicket(input = {}) {
  const projectName = stringValue(
    input.projectName || input.project?.name || input.tbProjectName,
    1000,
  );
  const tasklistName = stringValue(
    input.tasklistName || input.taskListName || input.tasklist?.name || input.tasklist?.title,
    1000,
  );
  const explicitProjectKey = stringValue(input.projectKey, 2200);
  const projectKey = explicitProjectKey || [projectName, tasklistName].filter(Boolean).join(">");
  const rawComments = Array.isArray(input.comments)
    ? input.comments
    : input.comments == null || input.comments === ""
      ? [input.commentText || input.comment].filter(Boolean)
      : [input.comments];
  const commentItems = rawComments
    .map(normalizeComment)
    .filter((item) => item.text)
    .slice(0, 1000);
  const comments = stringValue(commentItems.map((item) => item.text).join("\n"), 60000);
  const attachments = (Array.isArray(input.attachments)
    ? input.attachments
    : input.attachments == null || input.attachments === ""
      ? []
      : [input.attachments])
    .map(normalizeAttachment)
    .filter((item) => item.name || item.text)
    .slice(0, 200);
  const sourceCoverage = normalizeSourceCoverage(input.sourceCoverage);

  return {
    ticketId: stringValue(input.ticketId || input.carbId || input.tbTaskId, 200),
    tbTaskId: stringValue(input.tbTaskId, 200),
    projectId: stringValue(input.projectId || input.tbProjectId, 500),
    ticketUrl: stringValue(input.ticketUrl || input.url, 2000),
    title: stringValue(input.title || input.content, 2000),
    description: stringValue(input.description || input.note || input.text, 60000),
    projectName,
    tasklistName,
    tasklistId: stringValue(input.tasklistId || input.taskListId, 500),
    projectKey,
    iterationName: stringValue(input.iterationName || input.sprintName || input.sprint?.name, 1000),
    tags: uniqueStrings(input.tags || input.labels || input.tagNames),
    attachments,
    comments,
    commentItems,
    ...(sourceCoverage ? { sourceCoverage } : {}),
    createdAt: normalizedTimestamp(input.createdAt || input.created),
    updatedAt: normalizedTimestamp(input.updatedAt || input.modifiedAt),
    availableAt: normalizedTimestamp(input.availableAt || input.capturedAt),
    snapshotAt: stringValue(input.snapshotAt, 100) || new Date().toISOString(),
  };
}

function ticketSourceValues(ticket) {
  return {
    title: ticket.title ? [ticket.title] : [],
    project: ticket.projectKey ? [ticket.projectKey] : [],
    iteration: ticket.iterationName ? [ticket.iterationName] : [],
    tag: [...ticket.tags],
    attachment: ticket.attachments.flatMap((item) => [item.name, item.text].filter(Boolean)),
    comment: ticket.commentItems?.length
      ? ticket.commentItems.map((item) => item.text).filter(Boolean)
      : ticket.comments ? [ticket.comments] : [],
    note: ticket.description ? [ticket.description] : [],
  };
}

const SOURCE_COVERAGE_WEIGHTS = Object.freeze({
  detail: 0.3,
  note: 0.15,
  comments: 0.2,
  attachments: 0.2,
  tags: 0.15,
});

function sourceCoverageQuality(ticket = {}) {
  const coverage = ticket.sourceCoverage;
  if (!coverage || typeof coverage !== "object") {
    return {
      known: false,
      score: 1,
      requiredSources: [],
      missingRequired: [],
      unavailable: [],
      partial: [],
      errors: [],
    };
  }
  // 非 TB 手工录入没有远程 detail/comments 等概念，不能因为补全器留下的
  // available=false 默认行而把完整的手工输入误判成缺源。
  if (!ticket.tbTaskId) {
    return {
      known: true,
      score: coverage.manual?.available === false ? 0.7 : 1,
      requiredSources: [],
      missingRequired: [],
      unavailable: [],
      partial: [],
      errors: [],
    };
  }

  const explicitlyRequired = new Set(uniqueStrings(coverage.requiredSources, 20));
  for (const [key, row] of Object.entries(coverage)) {
    if (row && typeof row === "object" && !Array.isArray(row) && row.required === true) {
      explicitlyRequired.add(key);
    }
  }
  // 来源完整度只影响置信度和审计提示，不再作为能否推理的前置条件。只要任一来源
  // 提供了有效信号，就应允许生成候选；显式 required 仅保留为采集质量告警。
  const optionalSources = Object.keys(SOURCE_COVERAGE_WEIGHTS);
  const sharedCoverageEvaluation = evaluateSourceCoverage(coverage, {
    required: [],
    optional: optionalSources,
  });
  const declaredCoverageEvaluation = evaluateSourceCoverage(coverage, {
    required: [...explicitlyRequired],
    optional: optionalSources.filter((key) => !explicitlyRequired.has(key)),
  });

  let earned = 0;
  let possible = 0;
  const unavailable = [];
  const partial = [];
  const errors = [];
  for (const [key, weight] of Object.entries(SOURCE_COVERAGE_WEIGHTS)) {
    const row = coverage[key];
    if (!row || typeof row !== "object") continue;
    possible += weight;
    if (row.available !== true) {
      unavailable.push(key);
      if (row.error) errors.push({ source: key, error: stringValue(row.error, 2000) });
      continue;
    }
    let quality = row.complete === false ? 0.55 : 1;
    if (row.complete === false) partial.push(key);
    if (row.error) {
      quality *= 0.8;
      errors.push({ source: key, error: stringValue(row.error, 2000) });
    }
    earned += weight * quality;
  }
  const weightedCompleteness = possible > 0 ? earned / possible : 1;
  return {
    known: true,
    score: Number((
      weightedCompleteness * 0.7
      + Number(sharedCoverageEvaluation.completeness || 0) * 0.3
    ).toFixed(3)),
    requiredSources: [],
    missingRequired: [],
    declaredRequiredSources: [...explicitlyRequired],
    declaredMissing: [...declaredCoverageEvaluation.missingRequired],
    unavailable,
    partial,
    errors,
    gateStatus: sharedCoverageEvaluation.status,
    incompleteOptional: sharedCoverageEvaluation.incompleteOptional,
  };
}

export function extractConfigInferenceSignals(ticketInput, keywordMappings = {}) {
  const ticket = normalizeConfigInferenceTicket(ticketInput || {});
  const sources = ticketSourceValues(ticket);
  const byGroup = Object.fromEntries(CONFIG_INFERENCE_GROUPS.map((group) => [group, []]));
  const matches = [];
  const dimensions = Object.fromEntries(CONFIG_INFERENCE_DIMENSIONS.map((dimension) => [dimension, []]));

  for (const group of CONFIG_INFERENCE_GROUPS) {
    const mappings = keywordMappings?.[group];
    if (!mappings || typeof mappings !== "object" || Array.isArray(mappings)) continue;
    for (const [keyword, rawMapping] of Object.entries(mappings)) {
      const mapping = rawMapping && typeof rawMapping === "object" ? rawMapping : {};
      const category = normalizeCategory(mapping.category);
      const value = stringValue(mapping.value, 2000);
      if (!category || !value || !sourceContains(sources[group], keyword)) continue;
      const match = {
        id: `S${matches.length + 1}`,
        group,
        keyword: stringValue(keyword, 2000),
        category,
        value,
      };
      matches.push(match);
      byGroup[group].push(match);
      if (!dimensions[category].some((item) => compact(item) === compact(value))) {
        dimensions[category].push(value);
      }
    }
  }

  return {
    sources,
    byGroup,
    matches,
    dimensions,
    sourceCoverage: ticket.sourceCoverage || null,
    sourceQuality: sourceCoverageQuality(ticket),
    snapshotAt: ticket.snapshotAt,
  };
}

const REPOSITORY_ONLY_PROJECT_TYPES = new Set(["sdk", "tooling", "tool", "service", "repository"]);

function normalizeProjectType(value) {
  const type = stringValue(value, 80).toLowerCase();
  if (type === "tool") return "tooling";
  return ["application", "sdk", "tooling", "service", "repository"].includes(type) ? type : "application";
}

function normalizeProjectDef(def = {}) {
  const id = stringValue(def.id || def.repositoryId || def.repoId, 200);
  const inferenceOrder = Math.max(0, Math.trunc(Number(def.inferenceOrder || def.targetOrder) || 0));
  const rawInferenceRole = stringValue(def.inferenceRole || def.targetRole, 40).toLowerCase();
  return {
    id,
    name: stringValue(def.name || def.repositoryName || id, 1000),
    gitUrl: stringValue(def.gitUrl || def.ssh || def.https || def.url, 3000),
    projectType: normalizeProjectType(def.projectType || def.type),
    inferenceEnabled: def.inferenceEnabled === true,
    inferenceKeywords: uniqueStrings(def.inferenceKeywords || def.keywords || def.aliases, 100),
    requiresRepositories: uniqueStrings(def.requiresRepositories || def.dependsOn, 50),
    inheritVariant: uniqueStrings(def.inheritVariant, 10)
      .filter((field) => ["vehicle", "branch", "flavor"].includes(field)),
    defaultBranch: stringValue(def.defaultBranch || def.branch, 1000),
    defaultFlavor: stringValue(def.defaultFlavor || def.flavor, 500),
    branchOptions: uniqueStrings(def.branchOptions || def.branches, 200),
    flavorOptions: uniqueStrings(def.flavorOptions || def.flavors, 200),
    inferenceOrder,
    inferenceRole: ["primary", "dependency", "standalone"].includes(rawInferenceRole) ? rawInferenceRole : "",
  };
}

function targetIdentity(target) {
  const symbolicFields = configInferenceSymbolicFields(target);
  const fieldBindings = normalizeTargetFieldBindings(target.fieldBindings);
  const boundFields = Object.keys(fieldBindings);
  if (symbolicFields.length || boundFields.length) {
    // A placeholder is only one dimension of a target. Two repositories may both use
    // TARGET_BRANCH, so identity must keep every concrete dimension as well as every
    // symbolic feature; otherwise normalization silently drops one of the projects.
    const symbolicSet = new Set(symbolicFields);
    const dimensions = CONFIG_INFERENCE_DIMENSIONS.map((field) => {
      const value = field === "repositoryId" || field === "branch"
        ? normalizedText(target[field])
        : compact(target[field]);
      const logicalKey = normalizedText(fieldBindings[field]?.logicalKey);
      if (logicalKey) return `${field}=binding:${logicalKey}`;
      return symbolicSet.has(field)
        ? `${field}=symbolic:${value}:${compact(target.fieldStates?.[field]?.feature)}`
        : `${field}=literal:${value}`;
    });
    return [
      symbolicFields.length ? "symbolic" : "bound",
      ...dimensions,
      `repositoryName=${compact(target.repositoryName)}`,
      `gitUrl=${normalizedText(target.gitUrl)}`,
      `projectType=${normalizedText(target.projectType)}`,
      `repositoryOnly=${target.repositoryOnly === true ? "1" : "0"}`,
      // targetId is the only stable discriminator when a user intentionally creates
      // two fully-placeholder targets with identical feature text.
      ...(symbolicFields.length ? [`targetId=${normalizedText(target.targetId)}`] : []),
    ].join("|");
  }
  if (target.repositoryOnly) return `repository|${normalizedText(target.repositoryId)}`;
  return [
    compact(target.appName),
    compact(target.vehicle),
    normalizedText(target.repositoryId),
    normalizedText(target.branch),
    compact(target.flavor),
  ].join("|");
}

export function normalizeConfigInferenceTargets(targets = []) {
  const rows = Array.isArray(targets) ? targets : [];
  const byIdentity = new Map();
  for (const raw of rows) {
    if (!raw || typeof raw !== "object") continue;
    const variant = raw.variant && typeof raw.variant === "object" ? raw.variant : {};
    const confidenceNumber = Number(raw.confidence);
    const orderNumber = Number(raw.order ?? raw.sortOrder);
    const fieldStates = normalizeTargetFieldStates(raw.fieldStates);
    const symbolicFields = Object.keys(fieldStates);
    const fieldBindings = normalizeTargetFieldBindings(raw.fieldBindings || raw.valueRefs || raw.logicalValues);
    const targetId = stringValue(raw.targetId || raw.targetKey || raw.id, 200);
    const target = {
      ...(targetId ? { targetId } : {}),
      appName: stringValue(raw.appName || raw.applicationName || raw.app, 1000),
      vehicle: stringValue(raw.vehicle || raw.carModel || variant.vehicle, 500),
      repositoryId: stringValue(raw.repositoryId || raw.repoId || raw.projectId, 200),
      repositoryName: stringValue(raw.repositoryName || raw.repoName || raw.projectName, 1000),
      gitUrl: stringValue(raw.gitUrl || raw.repositoryUrl || raw.ssh || raw.https, 3000),
      branch: stringValue(raw.branch || raw.baseBranch, 1000),
      flavor: stringValue(raw.flavor || variant.flavor, 500),
      projectType: normalizeProjectType(raw.projectType || raw.targetType),
      targetRole: ["primary", "dependency", "standalone"].includes(stringValue(raw.targetRole || raw.role, 40).toLowerCase())
        ? stringValue(raw.targetRole || raw.role, 40).toLowerCase()
        : "primary",
      repositoryOnly: raw.repositoryOnly === true || raw.targetScope === "repository",
      order: Number.isFinite(orderNumber) && orderNumber > 0 ? Math.trunc(orderNumber) : 0,
      ...(symbolicFields.length ? { fieldStates, resolutionStatus: "partial" } : {}),
      ...(Object.keys(fieldBindings).length ? { fieldBindings } : {}),
      confidence: Number.isFinite(confidenceNumber)
        ? Number(Math.min(1, Math.max(0, confidenceNumber)).toFixed(3))
        : 0,
      evidenceIds: uniqueStrings(raw.evidenceIds, 500),
    };
    const identity = targetIdentity(target);
    const existing = byIdentity.get(identity);
    if (!existing) {
      byIdentity.set(identity, target);
      continue;
    }
    existing.confidence = Math.max(existing.confidence, target.confidence);
    existing.evidenceIds = uniqueStrings([...existing.evidenceIds, ...target.evidenceIds], 500);
    if (!existing.repositoryName) existing.repositoryName = target.repositoryName;
    if (!existing.targetId) existing.targetId = target.targetId;
    if (!existing.gitUrl) existing.gitUrl = target.gitUrl;
    if (!existing.vehicle) existing.vehicle = target.vehicle;
    if (!existing.branch) existing.branch = target.branch;
    if (!existing.flavor) existing.flavor = target.flavor;
    if (target.order && (!existing.order || target.order < existing.order)) existing.order = target.order;
    if (existing.targetRole === "standalone" && target.targetRole === "dependency") existing.targetRole = "dependency";
    if (target.fieldStates) {
      existing.fieldStates = { ...(existing.fieldStates || {}), ...target.fieldStates };
      existing.resolutionStatus = "partial";
    }
    if (target.fieldBindings) {
      existing.fieldBindings = { ...(existing.fieldBindings || {}), ...target.fieldBindings };
    }
  }
  return [...byIdentity.values()];
}

export function buildConfigInferenceRegistry(projectDefs = [], vehicleMap = {}) {
  const repositories = (Array.isArray(projectDefs) ? projectDefs : [])
    .map(normalizeProjectDef)
    .filter((def) => def.id);
  const byId = new Map(repositories.map((def) => [def.id, def]));
  const targets = [];

  for (const [vehicleName, mapping] of Object.entries(
    vehicleMap && typeof vehicleMap === "object" && !Array.isArray(vehicleMap) ? vehicleMap : {},
  )) {
    const vehicle = stringValue(vehicleName, 500);
    const apps = Array.isArray(mapping?.apps)
      ? mapping.apps
      : Array.isArray(mapping?.entries)
        ? [{ appName: mapping.appName || "", repos: mapping.entries }]
        : [];
    for (const app of apps) {
      const appName = stringValue(app?.appName || app?.name, 1000);
      const repos = Array.isArray(app?.repos) ? app.repos : [];
      const hasExplicitPrimary = repos.some((repo) => (
        stringValue(repo?.targetRole || repo?.role, 40).toLowerCase() === "primary"
      ));
      let mappingOrder = 0;
      for (const repo of repos) {
        mappingOrder += 1;
        const repositoryId = stringValue(repo?.repoId || repo?.repositoryId || repo?.projectId, 200);
        const def = byId.get(repositoryId);
        if (!def) continue;
        // 旧车型映射只有 entries，没有应用层；仍需为推断目标补齐独立的应用维度。
        // 工程注册表名称是这类数据唯一可靠、可复现的回退值。
        const registeredAppName = appName || def.name || repositoryId;
        const explicitRole = stringValue(repo?.targetRole || repo?.role, 40).toLowerCase();
        const targetRole = ["primary", "dependency", "standalone"].includes(explicitRole)
          ? explicitRole
          : (!hasExplicitPrimary && mappingOrder === 1 ? "primary" : "dependency");
        const explicitOrder = Number(repo?.order ?? repo?.sortOrder);
        targets.push({
          appName: registeredAppName,
          vehicle,
          repositoryId,
          repositoryName: def.name,
          gitUrl: stringValue(repo?.gitUrl || def.gitUrl, 3000),
          branch: stringValue(repo?.branch || repo?.baseBranch, 1000),
          flavor: stringValue(repo?.flavor, 500),
          projectType: def.projectType,
          targetRole,
          repositoryOnly: false,
          order: Number.isFinite(explicitOrder) && explicitOrder > 0 ? Math.trunc(explicitOrder) : mappingOrder,
          confidence: 0,
          evidenceIds: [],
        });
      }
    }
  }

  for (const def of repositories) {
    const repositoryOnly = REPOSITORY_ONLY_PROJECT_TYPES.has(def.projectType) || def.inferenceEnabled;
    if (!repositoryOnly) continue;
    targets.push({
      appName: "",
      vehicle: "",
      repositoryId: def.id,
      repositoryName: def.name,
      gitUrl: def.gitUrl,
      branch: def.defaultBranch,
      flavor: def.defaultFlavor,
      projectType: def.projectType,
      targetRole: def.inferenceRole || (def.requiresRepositories.length ? "dependency" : "standalone"),
      repositoryOnly: true,
      order: def.inferenceOrder,
      confidence: 0,
      evidenceIds: [],
    });
  }

  const normalizedTargets = normalizeConfigInferenceTargets(targets);
  return {
    version: CONFIG_INFERENCE_VERSION,
    repositories,
    targets: normalizedTargets,
    dimensions: Object.fromEntries(CONFIG_INFERENCE_DIMENSIONS.map((dimension) => [
      dimension,
      uniqueStrings(normalizedTargets.map((target) => target[dimension])),
    ])),
  };
}

function addRegistryAlias(index, dimension, value, alias) {
  const canonicalValue = stringValue(value, 2000);
  const aliasKey = compact(alias);
  if (!canonicalValue || !aliasKey || !index[dimension]) return;
  if (!index[dimension].has(aliasKey)) index[dimension].set(aliasKey, new Set());
  index[dimension].get(aliasKey).add(canonicalValue);
}

function vehicleRegistryAliases(vehicle, mapping = {}) {
  const releaseDir = stringValue(mapping?.prodReleaseDir, 4000);
  const releaseSegments = releaseDir.split(/[\\/]+/).map((item) => item.trim()).filter(Boolean);
  return uniqueStrings([
    vehicle,
    mapping?.name,
    mapping?.label,
    mapping?.title,
    mapping?.displayName,
    mapping?.vehicleName,
    mapping?.modelName,
    ...uniqueStrings(mapping?.aliases || mapping?.alias, 100),
    releaseSegments.at(-1) || "",
  ], 200);
}

function buildRegistryAliasIndex(registry, vehicleMap = {}) {
  const index = Object.fromEntries(REGISTRY_BRIDGE_DIMENSIONS.map((dimension) => [dimension, new Map()]));
  for (const target of registry.targets || []) {
    const vehicleMapping = vehicleMap?.[target.vehicle] || {};
    for (const alias of vehicleRegistryAliases(target.vehicle, vehicleMapping)) {
      addRegistryAlias(index, "vehicle", target.vehicle, alias);
    }
    addRegistryAlias(index, "repositoryId", target.repositoryId, target.repositoryId);
    addRegistryAlias(index, "repositoryId", target.repositoryId, target.repositoryName);
    addRegistryAlias(index, "appName", target.appName, target.appName);
    addRegistryAlias(index, "flavor", target.flavor, target.flavor);
    addRegistryAlias(index, "branch", target.branch, target.branch);
    for (const dimension of REGISTRY_BRIDGE_DIMENSIONS) {
      const binding = target.fieldBindings?.[dimension];
      if (binding?.defaultValue) addRegistryAlias(index, dimension, target[dimension], binding.defaultValue);
      if (binding?.sourceValue) addRegistryAlias(index, dimension, target[dimension], binding.sourceValue);
    }
  }
  return index;
}

function uniqueRegistryAliasValue(aliasIndex, dimension, lookupValue) {
  const key = compact(lookupValue);
  if (!key) return "";
  const values = aliasIndex?.[dimension]?.get(key);
  return values?.size === 1 ? [...values][0] : "";
}

function resolveRegistryBridgeMapping(keyword, rawMapping, aliasIndex) {
  const mapping = rawMapping && typeof rawMapping === "object" ? rawMapping : {};
  const rawCategory = stringValue(mapping.category, 80);
  const category = normalizeCategory(rawCategory);
  const value = stringValue(mapping.value, 2000);
  // 已完整配置的映射继续由显式规则处理；无效的非空类别也不静默猜测。
  if ((category && value) || (rawCategory && !category)) return null;
  const lookupValue = value || keyword;
  const dimensions = category ? [category] : REGISTRY_BRIDGE_DIMENSIONS;
  for (const dimension of dimensions) {
    const canonicalValue = uniqueRegistryAliasValue(aliasIndex, dimension, lookupValue);
    if (canonicalValue) return { category: dimension, value: canonicalValue };
  }
  return null;
}

function addSignalMatch(signals, input) {
  const duplicate = signals.matches.some((match) => (
    match.group === input.group
    && match.category === input.category
    && compact(match.value) === compact(input.value)
  ));
  if (duplicate) return false;
  const match = { id: `S${signals.matches.length + 1}`, ...input };
  signals.matches.push(match);
  signals.byGroup[match.group] = signals.byGroup[match.group] || [];
  signals.byGroup[match.group].push(match);
  return true;
}

function canonicalizeExplicitSignalMatches(signals, aliasIndex) {
  for (const match of signals.matches) {
    const canonicalValue = uniqueRegistryAliasValue(aliasIndex, match.category, match.value);
    if (!canonicalValue || compact(canonicalValue) === compact(match.value)) continue;
    match.configuredValue = match.value;
    match.value = canonicalValue;
    match.canonicalizedBy = "registry_alias";
  }
}

function directAliasMatchesSource(dimension, aliasKey, sourceValue) {
  const sourceKey = compact(sourceValue);
  if (!sourceKey || !aliasKey) return false;
  if (sourceKey === aliasKey) return true;
  // 只有车型显示别名允许在较长 TB 文本中做包含匹配；短词（如 9x）和仓库/分支
  // 等通用值不得模糊命中，避免“web”“main”之类信号造成大面积误推理。
  // sourceContains 同时排除“不是 P162”等否定语境。
  return dimension === "vehicle"
    && aliasKey.length >= 4
    && sourceContains([sourceValue], aliasKey);
}

function addDirectRegistrySourceSignals(signals, aliasIndex) {
  for (const group of CONFIG_INFERENCE_SOURCE_GROUPS) {
    const sourceValues = signals.sources[group] || [];
    if (!sourceValues.length) continue;
    for (const dimension of REGISTRY_BRIDGE_DIMENSIONS) {
      // 同一来源维度存在显式规则时，显式配置优先，自动别名不得覆盖。
      if (signals.matches.some((match) => match.group === group && match.category === dimension && !match.inferred)) continue;
      const resolved = new Map();
      for (const [aliasKey, values] of aliasIndex[dimension] || []) {
        if (values.size !== 1) continue;
        const sourceValue = sourceValues.find((value) => directAliasMatchesSource(dimension, aliasKey, value));
        if (!sourceValue) continue;
        resolved.set([...values][0], sourceValue);
      }
      // 同一来源同时指向多个 canonical 值时属于冲突，不自动选择其中一个。
      if (resolved.size !== 1) continue;
      const [value, sourceValue] = [...resolved.entries()][0];
      addSignalMatch(signals, {
        group,
        keyword: stringValue(sourceValue, 2000),
        category: dimension,
        value,
        inferred: true,
        inferenceSource: "registry_source_alias",
      });
    }
  }
}

function rebuildSignalDimensions(signals) {
  signals.dimensions = Object.fromEntries(CONFIG_INFERENCE_DIMENSIONS.map((dimension) => [
    dimension,
    uniqueStrings(signals.matches.filter((match) => match.category === dimension).map((match) => match.value)),
  ]));
}

function addRegistryBridgeSignals(signals, keywordMappings, registry, vehicleMap) {
  const aliasIndex = buildRegistryAliasIndex(registry, vehicleMap);
  canonicalizeExplicitSignalMatches(signals, aliasIndex);
  for (const group of CONFIG_INFERENCE_GROUPS) {
    const mappings = keywordMappings?.[group];
    if (!mappings || typeof mappings !== "object" || Array.isArray(mappings)) continue;
    for (const [keyword, rawMapping] of Object.entries(mappings)) {
      if (!sourceContains(signals.sources[group], keyword)) continue;
      const resolved = resolveRegistryBridgeMapping(keyword, rawMapping, aliasIndex);
      if (!resolved) continue;
      addSignalMatch(signals, {
        group,
        keyword: stringValue(keyword, 2000),
        category: resolved.category,
        value: resolved.value,
        inferred: true,
        inferenceSource: "registry_alias",
      });
    }
  }
  addDirectRegistrySourceSignals(signals, aliasIndex);
  rebuildSignalDimensions(signals);
  return signals;
}

function repositoryInferenceKeywordMatch(signals, keywords = []) {
  for (const group of CONFIG_INFERENCE_SOURCE_GROUPS) {
    const sourceValues = signals?.sources?.[group] || [];
    for (const keyword of keywords) {
      if (sourceContains(sourceValues, keyword)) return { group, keyword: stringValue(keyword, 500) };
    }
  }
  return null;
}

function dependencyRejectedByReviewedSample(samples, signals, repositoryId) {
  for (const sample of Array.isArray(samples) ? samples : []) {
    if (sampleDecision(sample) !== "corrected") continue;
    const removed = rejectedSampleTargets(sample);
    if (!removed.some((target) => normalizedText(target.repositoryId) === normalizedText(repositoryId))) continue;
    const similarity = signalsSimilarity(signals, sample.signals || {});
    if (!contextualHistoricalCorrectionAllowed(signals, sample.signals || {}, similarity)) continue;
    return { sample, similarity };
  }
  return null;
}

function requiredTargetFields(target) {
  const dimensions = target.repositoryOnly
    ? ["repositoryId"]
    : target.projectType === "application"
      ? CONFIG_INFERENCE_DIMENSIONS
      : CONFIG_INFERENCE_DIMENSIONS.filter((dimension) => dimension !== "appName");
  return dimensions.filter((dimension) => (
    !target[dimension]
    && !(target.fieldStates?.[dimension]?.kind === "symbolic" && target.fieldStates[dimension]?.feature)
  ));
}

function findRegisteredTarget(target, registeredTargets) {
  const exact = registeredTargets.find((candidate) => targetIdentity(candidate) === targetIdentity(target));
  if (exact) return exact;
  // binding 的实际值更新后，注册表写回可能暂时生成一条按新字面值派生 key 的目标。
  // 此时仍应按物化后的五维组合找到注册目标，随后由历史目标自己的 fieldBindings
  // 保留永久 logicalKey，不能因为注册表 key 变化丢掉已经学习的记忆。
  const materializedLiteral = registeredTargets.find((candidate) => (
    candidate.repositoryOnly === target.repositoryOnly
    && CONFIG_INFERENCE_DIMENSIONS.every((field) => {
      const left = field === "repositoryId" || field === "branch"
        ? normalizedText(candidate[field])
        : compact(candidate[field]);
      const right = field === "repositoryId" || field === "branch"
        ? normalizedText(target[field])
        : compact(target[field]);
      return left === right;
    })
  ));
  if (materializedLiteral) return materializedLiteral;
  const repositoryProfile = registeredTargets.find((candidate) => (
    candidate.repositoryOnly
    && normalizedText(candidate.repositoryId) === normalizedText(target.repositoryId)
  ));
  // 工程类型由注册表认定。旧客户端/通用模型可能只传 repositoryId/branch/vehicle，
  // 不应要求它们先知道 repositoryOnly 新字段才允许 SDK/工具目标通过。
  if (repositoryProfile) {
    return repositoryProfile;
  }
  if (target.appName) return null;
  const compatible = registeredTargets.filter((candidate) => (
    compact(candidate.vehicle) === compact(target.vehicle)
    && normalizedText(candidate.repositoryId) === normalizedText(target.repositoryId)
    && normalizedText(candidate.branch) === normalizedText(target.branch)
    && compact(candidate.flavor) === compact(target.flavor)
  ));
  return compatible.length === 1 ? compatible[0] : null;
}

function currentTargetsFromOption(value) {
  if (Array.isArray(value)) return normalizeConfigInferenceTargets(value);
  if (value && typeof value === "object" && Array.isArray(value.targets)) {
    return normalizeConfigInferenceTargets(value.targets);
  }
  return [];
}

export function validateConfigInferenceTargets(targets, {
  projectDefs = [],
  vehicleMap = {},
  allowCurrentTargets = false,
} = {}) {
  const normalized = normalizeConfigInferenceTargets(targets);
  if (!normalized.length) return { ok: false, error: "至少需要一个配置推理目标", targets: [] };
  const registry = buildConfigInferenceRegistry(projectDefs, vehicleMap);
  const currentTargets = currentTargetsFromOption(allowCurrentTargets);
  const repositoryIds = new Set(registry.repositories.map((def) => def.id));
  const validated = [];

  for (const target of normalized) {
    // 先让共享工程定义/车型注册表决定目标类型，再回退到当前实际配置。否则一个缺少
    // repositoryOnly 标记的真实 SDK 目标会被 currentTargets 的自匹配抢先认成 application。
    let registered = findRegisteredTarget(target, registry.targets);
    if (!registered && currentTargets.length) registered = findRegisteredTarget(target, currentTargets);
    if (!registered && allowCurrentTargets === true && repositoryIds.has(target.repositoryId)) registered = target;
    const effectiveTarget = registered?.repositoryOnly
      ? { ...registered, ...target, repositoryOnly: true, projectType: registered.projectType }
      : target;
    const missing = requiredTargetFields(effectiveTarget);
    if (missing.length) {
      return { ok: false, error: `配置推理目标缺少字段：${missing.join("、")}`, targets: normalized };
    }
    if (!registered) {
      return {
        ok: false,
        error: `${target.repositoryId}/${target.branch}/${target.vehicle}/${target.flavor} 未在车型源码注册表中登记`,
        targets: normalized,
      };
    }
    validated.push(registered.repositoryOnly ? {
      ...registered,
      ...target,
      appName: target.appName || "",
      repositoryName: registered.repositoryName || target.repositoryName,
      gitUrl: registered.gitUrl || target.gitUrl,
      projectType: registered.projectType,
      repositoryOnly: true,
    } : {
      ...target,
      appName: registered.appName || target.appName,
      repositoryName: registered.repositoryName || target.repositoryName,
      gitUrl: registered.gitUrl || target.gitUrl,
      projectType: registered.projectType || target.projectType,
      targetRole: target.targetRole || registered.targetRole,
      repositoryOnly: false,
    });
  }
  return { ok: true, targets: validated, registry };
}

function dimensionMatches(target, dimension, expected) {
  if (dimension === "repositoryId") {
    return normalizedText(target.repositoryId) === normalizedText(expected)
      || normalizedText(target.repositoryName) === normalizedText(expected);
  }
  if (dimension === "branch") return normalizedText(target.branch) === normalizedText(expected);
  return compact(target[dimension]) === compact(expected);
}

function signalMatchKey(match) {
  // registry_source_alias 的 keyword 是整段当前来源文本；两张轻微改写的工单会得到
  // 不同 raw keyword，但它们解析出的 canonical 维度和值相同，应视为同一规则信号。
  return [
    match.group,
    match.inferred ? `inferred:${stringValue(match.inferenceSource, 80)}` : compact(match.keyword),
    match.category,
    compact(match.value),
  ].join("|");
}

function signalSourceValues(signals, group) {
  const legacyKeys = {
    title: ["titleKeywords", "title"],
    project: ["projectKey", "projectName", "project"],
    iteration: ["iterationName", "sprintName", "iteration"],
    tag: ["tags", "tagNames", "tag"],
    attachment: ["attachmentNames", "attachments", "attachment"],
    comment: ["comments", "commentText", "comment"],
    note: ["description", "note", "noteText"],
  };
  let legacy;
  for (const key of legacyKeys[group] || [group]) {
    if (signals?.[key] != null) {
      legacy = signals[key];
      break;
    }
  }
  const direct = signals?.sources?.[group] ?? legacy ?? signals?.byGroup?.[group]?.source;
  if (Array.isArray(direct)) return uniqueStrings(direct);
  return direct == null || direct === "" ? [] : [stringValue(direct)];
}

function signalMatches(signals) {
  if (Array.isArray(signals?.matches)) return signals.matches;
  const out = [];
  for (const group of CONFIG_INFERENCE_GROUPS) {
    const rows = signals?.byGroup?.[group];
    if (Array.isArray(rows)) out.push(...rows);
  }
  return out;
}

function addTextFeature(features, token, amount = 1) {
  if (!token) return;
  features.set(token, Number(features.get(token) || 0) + amount);
}

function textFeatureFrequencies(value) {
  const text = normalizedText(value);
  const features = new Map();
  for (const token of text.match(/[a-z0-9][a-z0-9._/-]*/g) || []) {
    if (token.length > 1) addTextFeature(features, `term:${token}`, 1.25);
  }
  for (const sequence of text.match(/[\u3400-\u9fff]+/g) || []) {
    if (sequence.length === 1) {
      addTextFeature(features, `zh1:${sequence}`, 0.35);
      continue;
    }
    // 连续中文不能作为一个“全等 token”。二/三字 n-gram 对“详情页/详情页面”、
    // “无法/不能”之类局部改写仍有召回，同时三字特征降低常见双字碰撞。
    for (let index = 0; index <= sequence.length - 2; index++) {
      addTextFeature(features, `zh2:${sequence.slice(index, index + 2)}`, 1);
    }
    for (let index = 0; index <= sequence.length - 3; index++) {
      addTextFeature(features, `zh3:${sequence.slice(index, index + 3)}`, 1.15);
    }
  }
  return features;
}

function sparseVectorLength(features) {
  let total = 0;
  for (const value of features.values()) total += value;
  return total;
}

function bm25DirectionalCoverage(query, document) {
  if (!query.size || !document.size) return 0;
  const queryLength = sparseVectorLength(query);
  const documentLength = sparseVectorLength(document);
  const averageLength = Math.max(1, (queryLength + documentLength) / 2);
  const k1 = 1.2;
  const b = 0.75;
  let matched = 0;
  let possible = 0;
  for (const [term, queryFrequency] of query) {
    const importance = 1 + Math.log1p(queryFrequency);
    possible += importance;
    const documentFrequency = Number(document.get(term) || 0);
    if (!documentFrequency) continue;
    const saturated = (documentFrequency * (k1 + 1))
      / (documentFrequency + k1 * (1 - b + b * documentLength / averageLength));
    matched += importance * Math.min(1, saturated);
  }
  return possible ? matched / possible : 0;
}

function sparseCosineSimilarity(left, right) {
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (const [term, value] of left) {
    dot += value * Number(right.get(term) || 0);
    leftNorm += value * value;
  }
  for (const value of right.values()) rightNorm += value * value;
  return leftNorm && rightNorm ? dot / Math.sqrt(leftNorm * rightNorm) : 0;
}

function modelTokenPolarity(value) {
  const text = normalizedText(value);
  const affirmed = new Set();
  const negated = new Set();
  const expression = /[a-z]{1,12}[-_ ]?\d{2,5}[a-z0-9-]*|\b\d{1,4}[a-z]{1,4}\b|\b\d{3,4}\b/gi;
  for (const match of text.matchAll(expression)) {
    const token = compact(match[0]);
    if (!token || /^(?:19|20)\d{2}$/.test(token)) continue;
    (isNegatedOccurrence(text, match.index || 0) ? negated : affirmed).add(token);
  }
  return { affirmed, negated };
}

function polarityConflict(leftValue, rightValue) {
  const left = modelTokenPolarity(leftValue);
  const right = modelTokenPolarity(rightValue);
  return [...left.negated].some((token) => right.affirmed.has(token))
    || [...right.negated].some((token) => left.affirmed.has(token));
}

function textSimilarity(leftValue, rightValue) {
  if (compact(leftValue) && compact(leftValue) === compact(rightValue)) return 1;
  const left = textFeatureFrequencies(leftValue);
  const right = textFeatureFrequencies(rightValue);
  if (!left.size || !right.size) return 0;
  const bm25Style = (
    bm25DirectionalCoverage(left, right)
    + bm25DirectionalCoverage(right, left)
  ) / 2;
  const cosine = sparseCosineSimilarity(left, right);
  const similarity = bm25Style * 0.58 + cosine * 0.42;
  return Math.max(0, Math.min(1, similarity * (polarityConflict(leftValue, rightValue) ? 0.2 : 1)));
}

function signalsSimilarity(current, historical) {
  const currentRows = signalMatches(current);
  const historicalRows = signalMatches(historical);
  let points = 0;
  let possible = 0;

  const scoreMatchLayer = (currentLayer, historicalLayer, weight, penalizeMissing = true) => {
    const currentMatches = new Set(currentLayer.map(signalMatchKey));
    const historicalMatches = new Set(historicalLayer.map(signalMatchKey));
    if (!currentMatches.size && !historicalMatches.size) return;
    // 当前推理会实时补 registry_source_alias，而旧样本可能只保存显式规则。单边新增
    // inferred 层不是历史缺源，不能反向稀释同一显式规则的相似度。
    if (!penalizeMissing && (!currentMatches.size || !historicalMatches.size)) return;
    possible += weight;
    if (currentMatches.size && historicalMatches.size) {
      let overlap = 0;
      for (const key of currentMatches) if (historicalMatches.has(key)) overlap++;
      points += weight * overlap / Math.max(currentMatches.size, historicalMatches.size);
    }
  };
  scoreMatchLayer(
    currentRows.filter((match) => !match.inferred),
    historicalRows.filter((match) => !match.inferred),
    2,
  );
  scoreMatchLayer(
    currentRows.filter((match) => match.inferred),
    historicalRows.filter((match) => match.inferred),
    1,
    false,
  );

  const groupWeights = {
    title: 1.35,
    project: 0.75,
    iteration: 0.65,
    tag: 1,
    attachment: 1.05,
    comment: 1.1,
    note: 1.25,
  };
  for (const group of CONFIG_INFERENCE_SOURCE_GROUPS) {
    const currentValues = signalSourceValues(current, group);
    const historicalValues = signalSourceValues(historical, group);
    if (!currentValues.length && !historicalValues.length) continue;
    const groupWeight = groupWeights[group] || 1;
    possible += groupWeight;
    if (!currentValues.length || !historicalValues.length) continue;
    let best = 0;
    for (const left of currentValues) {
      for (const right of historicalValues) {
        if (compact(left) && compact(left) === compact(right)) best = 1;
        else best = Math.max(best, textSimilarity(left, right));
      }
    }
    points += best * groupWeight;
  }
  const currentCompleteness = current?.sourceQuality?.known
    ? 0.65 + 0.35 * Math.max(0, Math.min(1, Number(current.sourceQuality.score) || 0))
    : 1;
  const historicalCompleteness = historical?.sourceQuality?.known
    ? 0.75 + 0.25 * Math.max(0, Math.min(1, Number(historical.sourceQuality.score) || 0))
    : 1;
  return possible
    ? Math.max(0, Math.min(1, (points / possible) * Math.sqrt(currentCompleteness * historicalCompleteness)))
    : 0;
}

function resolvedSignalValues(signals, dimension) {
  const matches = signalMatches(signals).filter((match) => match.category === dimension);
  if (!matches.length) return [];
  // 标题/标签/项目描述当前工单主语；附件和评论经常只是对比机型或复现上下文。
  // 同一维度只采用最高优先级来源，避免“标题 P155、评论 P162 已验证”被当成
  // 两个同等合法的当前车型。
  const priority = Math.max(...matches.map((match) => CURRENT_SIGNAL_GROUP_PRIORITY[match.group] || 0));
  return uniqueStrings(matches
    .filter((match) => (CURRENT_SIGNAL_GROUP_PRIORITY[match.group] || 0) === priority)
    .map((match) => match.value));
}

function hasResolvedVariantSignals(signals) {
  return CURRENT_VARIANT_DIMENSIONS.some((dimension) => resolvedSignalValues(signals, dimension).length > 0);
}

function targetMatchesResolvedVariant(target, signals) {
  for (const dimension of CURRENT_TARGET_CONTEXT_DIMENSIONS) {
    const expectedValues = resolvedSignalValues(signals, dimension);
    if (!expectedValues.length) continue;
    const actual = stringValue(target?.[dimension], 1000);
    // SDK/脚本等仓库允许没有自身 Flavor；它们会在主工程确定后按 inheritVariant
    // 原子追加。应用工程则必须与当前已经解析出的变体一致。
    if (!actual && target?.repositoryOnly) continue;
    if (!actual || !expectedValues.some((expected) => dimensionMatches(target, dimension, expected))) return false;
  }
  return true;
}

function applicationRepositoryContext(signals, registry) {
  const repositories = new Set(resolvedSignalValues(signals, "repositoryId").map(normalizedText).filter(Boolean));
  const explicitApplications = new Set(resolvedSignalValues(signals, "appName").map(compact).filter(Boolean));
  const applicationSubjectSources = ["title", "tag", "project", "note"]
    .flatMap((group) => signalSourceValues(signals, group));
  for (const target of registry.targets || []) {
    const appName = stringValue(target.appName, 1000);
    const appKey = compact(appName);
    if (!appKey || appKey.length < 4) continue;
    if (sourceContains(applicationSubjectSources, appName)) explicitApplications.add(appKey);
  }
  const repositoryApplications = new Set((registry.targets || [])
    .filter((target) => !target.repositoryOnly && repositories.has(normalizedText(target.repositoryId)))
    .map((target) => compact(target.appName))
    .filter(Boolean));
  const applications = new Set([...explicitApplications, ...repositoryApplications]);
  const compatibleApplications = new Set((registry.targets || [])
    .filter((target) => !target.repositoryOnly && targetMatchesResolvedVariant(target, signals))
    .map((target) => compact(target.appName))
    .filter(Boolean));
  const conflictingApplicationRepository = explicitApplications.size > 0
    && repositoryApplications.size > 0
    && ![...explicitApplications].some((value) => repositoryApplications.has(value));
  return {
    repositories,
    applications,
    explicitApplications,
    repositoryApplications,
    compatibleApplications,
    hasExplicitContext: repositories.size > 0 || applications.size > 0,
    uniqueCompatibleApplication: compatibleApplications.size === 1
      ? [...compatibleApplications][0]
      : "",
    conflictingApplicationRepository,
  };
}

function targetMatchesApplicationRepositoryContext(target, context, {
  allowUniqueVariantApplication = true,
  allowUnknown = false,
} = {}) {
  if (context.conflictingApplicationRepository) return false;
  const fieldStates = normalizeTargetFieldStates(target?.fieldStates);
  const applicationIsSymbolic = fieldStates.appName?.kind === "symbolic";
  const repositoryIsSymbolic = fieldStates.repositoryId?.kind === "symbolic";
  const repositoryId = normalizedText(target?.repositoryId);
  const application = compact(target?.appName);
  if (context.repositories.size) {
    if (target?.repositoryOnly) {
      return context.repositories.has(repositoryId)
        || (repositoryIsSymbolic && context.repositories.size === 1);
    }
    return context.repositories.has(repositoryId)
      || (repositoryIsSymbolic && context.repositories.size === 1)
      || (!!application && context.applications.has(application))
      || (applicationIsSymbolic && context.applications.size === 1);
  }
  if (context.applications.size) {
    return !target?.repositoryOnly && (
      (!!application && context.applications.has(application))
      || (applicationIsSymbolic && context.applications.size === 1)
    );
  }
  if (
    allowUniqueVariantApplication
    && context.uniqueCompatibleApplication
    && !target?.repositoryOnly
  ) {
    return application === context.uniqueCompatibleApplication || applicationIsSymbolic;
  }
  return allowUnknown;
}

function historicalTargetMatchesCurrentContext(target, context, signals, registry) {
  if (targetMatchesApplicationRepositoryContext(target, context, {
    allowUniqueVariantApplication: true,
    allowUnknown: false,
  })) return true;
  if (!target?.repositoryOnly) return false;
  const repository = (registry.repositories || []).find((item) => (
    normalizedText(item.id) === normalizedText(target.repositoryId)
  ));
  return !!repository?.inferenceKeywords?.length
    && !!repositoryInferenceKeywordMatch(signals, repository.inferenceKeywords);
}

function informativeSourceValues(signals) {
  return ["title", "tag", "attachment", "comment", "note"]
    .flatMap((group) => signalSourceValues(signals, group))
    .map((value) => stringValue(value, 100000))
    .filter(Boolean);
}

function modelLikeTokens(value) {
  const text = normalizedText(value);
  const matches = text.match(/[a-z]{1,12}[-_ ]?\d{2,5}[a-z0-9-]*|\b\d{1,4}[a-z]{1,4}\b|\b\d{3,4}\b/g) || [];
  return new Set(matches.map(compact).filter((token) => token && !/^(?:19|20)\d{2}$/.test(token)));
}

function sourceModelHints(signals) {
  const hints = new Set();
  // 评论经常在说明“已在其他车型验证”，不能把这种上下文提及当作当前车型提示；
  // 未解析车型的兜底保护只看标题、标签和项目名这些主语来源。
  for (const group of ["title", "tag", "project"]) {
    for (const value of signalSourceValues(signals, group)) {
      for (const token of modelLikeTokens(value)) hints.add(token);
    }
  }
  return hints;
}

function hasStrongHistoricalSourceOverlap(current, historical) {
  const currentValues = informativeSourceValues(current);
  const historicalValues = informativeSourceValues(historical);
  // 单个通用 tag（例如 AppMarket）或常见附件名不能授权历史样本迁移整套车型。
  // 完整标题/备注必须足够具体；短值只有含车型特征时才算强同源。
  for (const group of ["title", "note"]) {
    const historicalExact = new Set(signalSourceValues(historical, group).map(compact).filter(Boolean));
    if (signalSourceValues(current, group).some((value) => {
      const normalized = compact(value);
      return historicalExact.has(normalized)
        && (normalized.length >= 12 || modelLikeTokens(value).size > 0);
    })) return true;
  }

  // 兼容旧 configMemory 只保存 titleKeywords 的数据：P155/8678/SS21 这类
  // 车型特征可跨 title/tag 识别，但“应用市场”这样的通用词不能单独迁移变体。
  const currentModels = new Set(currentValues.flatMap((value) => [...modelLikeTokens(value)]));
  if (!currentModels.size) return false;
  return historicalValues.some((value) => [...modelLikeTokens(value)].some((token) => currentModels.has(token)));
}

function historicalSampleContext(currentSignals, sampleSignals, similarity) {
  const strongSourceOverlap = hasStrongHistoricalSourceOverlap(currentSignals, sampleSignals);
  if (hasResolvedVariantSignals(currentSignals)) {
    return { allowed: similarity >= 0.18 || strongSourceOverlap, strongSourceOverlap };
  }
  // 没有车型/Flavor 证据时，不允许仅凭相同项目、迭代或通用 AppMarket 规则
  // 复制一整套车型、分支和 Flavor。只有强原始来源重合或非常高的整体相似度可用。
  return {
    allowed: strongSourceOverlap || similarity >= STRONG_HISTORY_SIMILARITY,
    strongSourceOverlap,
  };
}

function targetVariantSignature(target) {
  // 同一车型的一组主/依赖工程允许各自拥有不同 Flavor（例如主 APK 与 WebApp）。
  // 这里判断的是“是否跨车型猜默认配置”，不能把同车型的两个依赖 Flavor 当成
  // 两套互斥车型；只有无车型的独立目标才退回 Flavor 作为变体标识。
  return compact(target?.vehicle) || `flavor:${compact(target?.flavor)}`;
}

function targetApplicationGroupSignature(target) {
  return `${compact(target?.vehicle)}|${compact(target?.appName)}`;
}

function sampleTargets(sample) {
  const source = sample?.groundTruth?.targets
    || sample?.actual?.targets
    || sample?.actual?.changeTargets
    || sample?.feedback?.correctedPrediction?.targets
    || sample?.feedback?.correctedPrediction?.changeTargets
    || [];
  return normalizeConfigInferenceTargets(source);
}

/**
 * 历史评分只能复用一个自洽的工程拓扑，不能把旧 UI 按数组位置伪造出的
 * “跨车型依赖”再次当成事实。仓库型可选依赖也不从历史样本直接注入：
 * 它们必须在当前工单再次命中 requiresRepositories + inferenceKeywords 后，
 * 由最终依赖阶段原子追加。用户明确把某个依赖提升为主工程时仍允许复用。
 */
function historicalTargetsForReuse(sample, registry, currentSignals = null) {
  let targets = sampleTargets(sample);
  const initialApplicationRows = targets.map((target) => {
    const registered = hasConfigInferenceSymbolicFields(target)
      ? null
      : findRegisteredTarget(target, registry.targets);
    return { target, registered };
  }).filter(({ target, registered }) => (
    target.repositoryOnly !== true && registered?.repositoryOnly !== true
  ));
  const registeredPrimaryGroups = new Set(initialApplicationRows
    .filter(({ registered }) => registered?.targetRole === "primary")
    .map(({ registered }) => targetApplicationGroupSignature(registered))
    .filter((value) => value !== "|"));

  // 旧版反馈把同一应用下所有仓库都保存成 primary。只要样本里仍包含注册表认定的
  // 主工程，就必须按当前注册表恢复主/依赖拓扑；否则第二个陈旧 primary 会被当成
  // 另一个执行入口，并触发歧义保护把整组有效推理结果清空。若用户确实删除了父工程、
  // 只保留一个依赖工程，则样本里不存在注册主工程，后续仍允许它保持/提升为 primary。
  targets = targets.map((target) => {
    if (hasConfigInferenceSymbolicFields(target)) return target;
    const registered = findRegisteredTarget(target, registry.targets);
    if (!registered || target.repositoryOnly === true || registered.repositoryOnly === true) return target;
    const group = targetApplicationGroupSignature(registered);
    if (registered.targetRole === "primary" || registeredPrimaryGroups.has(group)) {
      return {
        ...target,
        targetRole: registered.targetRole,
        order: registered.order || target.order,
      };
    }
    return target;
  });
  const initialApplicationTargets = targets.filter((target) => {
    const registered = hasConfigInferenceSymbolicFields(target)
      ? null
      : findRegisteredTarget(target, registry.targets);
    return target.repositoryOnly !== true && registered?.repositoryOnly !== true;
  });
  // 兼容旧反馈：用户删除原主工程后，注册表中的 dependency 可能成为样本里唯一
  // 的应用目标。此时它表达的是“已提升为主工程”，不能因旧角色字段缺失而丢弃。
  if (initialApplicationTargets.length
    && !initialApplicationTargets.some((target) => target.targetRole === "primary")) {
    const promoted = [...initialApplicationTargets].sort((left, right) => (
      (Number(left.order) || Number.POSITIVE_INFINITY) - (Number(right.order) || Number.POSITIVE_INFINITY)
    ))[0];
    targets = targets.map((target) => target === promoted ? { ...target, targetRole: "primary" } : target);
  }
  const rows = targets.map((target) => {
    const registered = hasConfigInferenceSymbolicFields(target)
      ? null
      : findRegisteredTarget(target, registry.targets);
    return {
      target,
      registered,
      repositoryOnly: target.repositoryOnly === true || registered?.repositoryOnly === true,
    };
  });
  const applicationPrimaries = rows.filter((row) => (
    !row.repositoryOnly && row.target.targetRole === "primary"
  ));
  const primaryGroups = new Set(applicationPrimaries
    .map((row) => targetApplicationGroupSignature(row.target))
    .filter((value) => value !== "|"));

  // 当前交互契约只有一个主工程。多车型/多应用 primary 是旧预测污染或冲突候选，
  // 不能作为正向 RAG 事实；保留原 run 供审计，但隔离其正向学习影响。
  if (primaryGroups.size > 1) return [];
  const primary = applicationPrimaries[0]?.target || null;
  const promotion = repositoryDependencyPromotionContext(sample, registry, currentSignals);

  return rows.flatMap((row) => {
    const { target, registered, repositoryOnly } = row;
    // 以当前注册表角色为准修复旧数据：历史样本缺 targetRole 会被旧 normalize
    // 默认成 primary，旧 UI 也可能把 SDK 错存成 primary。只要当前注册表仍将它
    // 定义为 repository-only dependency，就不能从历史注入执行候选；仅放行“用户明确
    // 删除父仓库并把它提升为唯一主工程”且当前关键词仍匹配的审计完整纠正样本。
    if (repositoryOnly
      && registered?.targetRole === "dependency"
      && !(promotion.currentAllowed
        && normalizedText(promotion.target?.repositoryId) === normalizedText(target.repositoryId))) return [];
    if (target.targetRole !== "dependency") return [target];
    // SDK/脚本等依赖只能由当前工单的依赖关键词准入，历史依赖不得偷渡。
    if (repositoryOnly) return [];
    // 应用依赖必须锚定同车型、同应用的主工程，并且注册表本身把它定义为依赖。
    if (!primary || targetApplicationGroupSignature(target) !== targetApplicationGroupSignature(primary)) return [];
    if (!hasConfigInferenceSymbolicFields(target) && registered?.targetRole !== "dependency") return [];
    return [target];
  });
}

function sampleDecision(sample) {
  return stringValue(sample?.feedback?.decision || sample?.decision, 80).toLowerCase();
}

function timestampMillis(value) {
  if (value == null || value === "") return null;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : null;
}

function sampleAvailableAt(sample) {
  return sample?.availableAt
    || sample?.approvedAt
    || sample?.serving?.activatedAt
    || sample?.activatedAt
    || sample?.activeAt
    || sample?.verifiedAt
    || sample?.updatedAt
    || sample?.createdAt
    || "";
}

function sampleServingEligibility(sample, inferenceAt = "") {
  if (!sample || typeof sample !== "object") {
    return { allowed: false, mode: "invalid", state: "" };
  }
  if (sample.supersededBy) {
    return { allowed: false, mode: "lifecycle", state: "superseded" };
  }
  const availableAt = timestampMillis(sampleAvailableAt(sample));
  const cutoff = timestampMillis(inferenceAt);
  if (availableAt != null && cutoff != null && availableAt > cutoff) {
    return { allowed: false, mode: "time_slice", state: "future" };
  }

  const executionOutcome = stringValue(
    sample.execution?.outcome || sample.outcome || sample.feedback?.outcome,
    80,
  ).toLowerCase();
  if (stringValue(sample.source, 120).toLowerCase() === "actual_execution" && executionOutcome) {
    if (["success", "accepted", "verified"].includes(executionOutcome)) {
      return { allowed: true, mode: "verified_execution", state: executionOutcome };
    }
    // started/building/failed/abandoned/reverted 都只是观察或反证，不能作为正向
    // serving 样本；旧 actual_execution 没有 outcome 时仍走下方兼容路径。
    return { allowed: false, mode: "execution", state: executionOutcome };
  }

  const stateValues = [
    sample.servingState,
    sample.lifecycleState,
    sample.approvalStatus,
    sample.releaseState,
    sample.lifecycle?.state,
    sample.serving?.state,
    sample.approval?.status,
    ...(SERVING_SAMPLE_STATES.has(stringValue(sample.state, 80).toLowerCase())
      || NON_SERVING_SAMPLE_STATES.has(stringValue(sample.state, 80).toLowerCase())
      ? [sample.state]
      : []),
    ...(SERVING_SAMPLE_STATES.has(stringValue(sample.status, 80).toLowerCase())
      || NON_SERVING_SAMPLE_STATES.has(stringValue(sample.status, 80).toLowerCase())
      ? [sample.status]
      : []),
  ]
    .map((value) => stringValue(value, 80).toLowerCase())
    .filter(Boolean);
  const recognizedStates = stateValues.filter((state) => (
    SERVING_SAMPLE_STATES.has(state) || NON_SERVING_SAMPLE_STATES.has(state)
  ));
  if (recognizedStates.some((state) => NON_SERVING_SAMPLE_STATES.has(state))) {
    return {
      allowed: false,
      mode: "lifecycle",
      state: recognizedStates.find((state) => NON_SERVING_SAMPLE_STATES.has(state)) || "",
    };
  }

  const explicitFlags = [
    ["approved", sample.approved],
    ["active", sample.active],
    ["verified", sample.verified],
    ["serving", typeof sample.serving === "boolean" ? sample.serving : undefined],
  ].filter(([, value]) => typeof value === "boolean");
  if (explicitFlags.some(([name, value]) => name === "active" && value === false)) {
    return { allowed: false, mode: "lifecycle", state: "inactive" };
  }
  const positiveMarkers = [
    ...recognizedStates.filter((state) => SERVING_SAMPLE_STATES.has(state)),
    ...explicitFlags.filter(([, value]) => value === true).map(([name]) => name),
    ...(sample.approvedAt ? ["approved"] : []),
    ...(sample.verifiedAt ? ["verified"] : []),
    ...(sample.activatedAt || sample.activeAt ? ["active"] : []),
  ];
  const hasLifecycleMetadata = stateValues.length > 0
    || explicitFlags.length > 0
    || !!(sample.approvedAt || sample.verifiedAt || sample.activatedAt || sample.activeAt);
  if (hasLifecycleMetadata) {
    return positiveMarkers.length
      ? { allowed: true, mode: "lifecycle", state: positiveMarkers[0] }
      : { allowed: false, mode: "lifecycle", state: stateValues[0] || "unapproved" };
  }

  // v3 及更早数据没有 lifecycle 字段。保留兼容读取，后续一旦迁移出状态字段，
  // 就严格服从 approved/active/verified 准入，不再把 draft 当作旧样本。
  return { allowed: true, mode: "legacy_compatible", state: "legacy" };
}

function servingSamplesWithStats(samples, options, inferenceAt = "") {
  const stats = {
    provided: 0,
    eligible: 0,
    filtered: 0,
    legacyCompatible: 0,
    filteredByState: {},
  };
  const eligible = [];
  for (const raw of Array.isArray(samples) ? samples : []) {
    stats.provided += 1;
    const sample = bindSampleTargetContainers(raw, options);
    const eligibility = sampleServingEligibility(sample, inferenceAt);
    if (!eligibility.allowed) {
      stats.filtered += 1;
      const state = eligibility.state || "ineligible";
      stats.filteredByState[state] = Number(stats.filteredByState[state] || 0) + 1;
      continue;
    }
    stats.eligible += 1;
    if (eligibility.mode === "legacy_compatible") stats.legacyCompatible += 1;
    eligible.push(sample);
  }
  return { samples: eligible, stats };
}

function rejectedSampleTargets(sample) {
  const source = sample?.negative?.rejectedTargets
    || sample?.feedback?.rejectedPrediction?.targets
    || sample?.rejectedPrediction?.targets
    || [];
  return normalizeConfigInferenceTargets(source);
}

function repositoryDependencyPromotionContext(sample, registry, currentSignals = null) {
  const targets = sampleTargets(sample);
  if (sampleDecision(sample) !== "corrected" || targets.length !== 1 || targets[0].targetRole !== "primary") {
    return { promotion: false, currentAllowed: true, target: null, repository: null };
  }
  const target = targets[0];
  if (hasConfigInferenceSymbolicFields(target)) {
    return { promotion: false, currentAllowed: true, target: null, repository: null };
  }
  const registered = findRegisteredTarget(target, registry.targets);
  if (!registered?.repositoryOnly || registered.targetRole !== "dependency") {
    return { promotion: false, currentAllowed: true, target: null, repository: null };
  }
  const repository = registry.repositories.find((item) => (
    normalizedText(item.id) === normalizedText(target.repositoryId || registered.repositoryId)
  ));
  const rejectedRepositoryIds = new Set(rejectedSampleTargets(sample)
    .map((item) => normalizedText(item.repositoryId))
    .filter(Boolean));
  if (!repository?.requiresRepositories?.some((id) => rejectedRepositoryIds.has(normalizedText(id)))) {
    return { promotion: false, currentAllowed: true, target: null, repository: null };
  }
  return {
    promotion: true,
    target,
    repository,
    // 整条纠正样本（包括“删除父仓库”的负反馈）都受当前特征约束。否则历史语音
    // promotion 会在当前无语音或其它车型工单中删掉 appMarket，留下空推理结果。
    currentAllowed: (!currentSignals || contextualHistoricalCorrectionAllowed(
      currentSignals,
      sample.signals || {},
      signalsSimilarity(currentSignals, sample.signals || {}),
    )) && (!repository.inferenceKeywords.length
      || !!repositoryInferenceKeywordMatch(currentSignals, repository.inferenceKeywords)),
  };
}

function bindSampleTargetContainers(sample, options) {
  if (!sample || typeof sample !== "object") return sample;
  const bindPrediction = (prediction) => prediction && typeof prediction === "object"
    ? {
      ...prediction,
      ...(Array.isArray(prediction.targets)
        ? { targets: bindConfigInferenceTargets(prediction.targets, options) }
        : {}),
      ...(Array.isArray(prediction.changeTargets)
        ? { changeTargets: bindConfigInferenceTargets(prediction.changeTargets, options) }
        : {}),
    }
    : prediction;
  return {
    ...sample,
    groundTruth: bindPrediction(sample.groundTruth),
    actual: bindPrediction(sample.actual),
    feedback: sample.feedback && typeof sample.feedback === "object" ? {
      ...sample.feedback,
      correctedPrediction: bindPrediction(sample.feedback.correctedPrediction),
      rejectedPrediction: bindPrediction(sample.feedback.rejectedPrediction),
    } : sample.feedback,
    rejectedPrediction: bindPrediction(sample.rejectedPrediction),
    negative: sample.negative && typeof sample.negative === "object" ? {
      ...sample.negative,
      rejectedTargets: Array.isArray(sample.negative.rejectedTargets)
        ? bindConfigInferenceTargets(sample.negative.rejectedTargets, options)
        : sample.negative.rejectedTargets,
    } : sample.negative,
  };
}

function sampleWeight(sample, similarity) {
  const decision = sampleDecision(sample);
  if (decision === "insufficient" || decision === "ticket_wrong" || decision === "incorrect") return 0;
  // 新配置复核使用 rating，旧训练样本可能使用 score；两者都按 1~5 分处理。
  const score = Number(sample?.feedback?.score
    ?? sample?.feedback?.rating
    ?? sample?.score
    ?? sample?.rating);
  const scoreFactor = Number.isFinite(score) ? Math.min(1.5, Math.max(0.5, score / 4)) : 1;
  const countFactor = Math.min(1.4, 1 + Math.max(0, Number(sample?.count || 1) - 1) * 0.05);
  return (18 + similarity * 42) * scoreFactor * countFactor;
}

function matchedRuleOverlap(current, historical) {
  const currentRows = signalMatches(current);
  const historicalRows = signalMatches(historical);
  const currentExplicit = currentRows.filter((match) => !match.inferred);
  const historicalExplicit = historicalRows.filter((match) => !match.inferred);
  const currentMatches = new Set((
    currentExplicit.length && historicalExplicit.length ? currentExplicit : currentRows
  ).map(signalMatchKey));
  const historicalMatches = new Set((
    currentExplicit.length && historicalExplicit.length ? historicalExplicit : historicalRows
  ).map(signalMatchKey));
  if (!currentMatches.size || !historicalMatches.size) return 0;
  let overlap = 0;
  for (const key of currentMatches) if (historicalMatches.has(key)) overlap++;
  return overlap / Math.max(currentMatches.size, historicalMatches.size);
}

function hasExactSourceOverlap(current, historical) {
  return CONFIG_INFERENCE_SOURCE_GROUPS.some((group) => {
    const left = new Set(signalSourceValues(current, group).map(compact).filter(Boolean));
    if (!left.size) return false;
    return signalSourceValues(historical, group).some((value) => left.has(compact(value)));
  });
}

function hasExactHistoricalSubjectOverlap(current, historical) {
  return ["title", "note"].some((group) => {
    const historicalValues = new Set(signalSourceValues(historical, group).map(compact).filter(Boolean));
    return historicalValues.size > 0
      && signalSourceValues(current, group).some((value) => historicalValues.has(compact(value)));
  });
}

function resolvedSignalContextsCompatible(current, historical) {
  for (const dimension of CONFIG_INFERENCE_DIMENSIONS) {
    const currentValues = resolvedSignalValues(current, dimension).map(compact).filter(Boolean);
    const historicalValues = resolvedSignalValues(historical, dimension).map(compact).filter(Boolean);
    if (!currentValues.length || !historicalValues.length) continue;
    if (!currentValues.some((value) => historicalValues.includes(value))) return false;
  }
  return true;
}

/**
 * “删除旧候选”描述的是某张历史工单主语下的纠正，而不是对该候选车型/仓库的
 * 全局黑名单。只有当前与历史已解析上下文不冲突，并且是同一标题/备注，或达到
 * 强相似度且复用了一手来源和规则时，负反馈才允许迁移到当前工单。
 */
function contextualHistoricalCorrectionAllowed(current, historical, similarity) {
  if (!resolvedSignalContextsCompatible(current, historical)) return false;
  if (hasExactHistoricalSubjectOverlap(current, historical)) return true;
  return similarity >= STRONG_HISTORY_SIMILARITY
    && matchedRuleOverlap(current, historical) >= 0.5
    && hasExactSourceOverlap(current, historical);
}

function insufficientSamplePenalty(sample, currentSignals, similarity) {
  if (sampleDecision(sample) !== "insufficient" || similarity < 0.65) return 0;
  const ruleOverlap = matchedRuleOverlap(currentSignals, sample.signals);
  if (ruleOverlap < 0.5 || !hasExactSourceOverlap(currentSignals, sample.signals)) return 0;
  const rating = Number(sample?.feedback?.score
    ?? sample?.feedback?.rating
    ?? sample?.score
    ?? sample?.rating);
  // “信息不足”下评分越低，负反馈越强；最高仍限制为 48，避免一次反馈永久压过多源强规则。
  const strength = Number.isFinite(rating) ? Math.min(1.2, Math.max(0.75, (7 - rating) / 5)) : 1;
  return Math.min(48, (12 + 22 * similarity + 14 * ruleOverlap) * strength);
}

function resultDimensions(targets) {
  return Object.fromEntries(CONFIG_INFERENCE_DIMENSIONS.map((dimension) => [
    dimension,
    uniqueStrings(targets.map((target) => target[dimension])),
  ]));
}

function stableConfigValue(value) {
  if (Array.isArray(value)) return value.map(stableConfigValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value)
    .sort()
    .map((key) => [key, stableConfigValue(value[key])]));
}

function registryFingerprint(registry) {
  const content = JSON.stringify(stableConfigValue({
    repositories: registry.repositories || [],
    targets: registry.targets || [],
  }));
  return `registry-v1-${logicalKeyHash(content)}${logicalKeyHash([...content].reverse().join(""))}`;
}

function inferenceVersionMetadata({
  registry,
  registryVersion = "",
  expectedRegistryVersion = "",
  expectedRuleVersion = "",
}) {
  const fingerprint = registryFingerprint(registry);
  const effectiveRegistryVersion = stringValue(registryVersion, 500) || fingerprint;
  const expectedRegistry = stringValue(expectedRegistryVersion, 500);
  const expectedRules = stringValue(expectedRuleVersion, 500);
  const staleReasons = [];
  if (expectedRules && expectedRules !== CONFIG_INFERENCE_VERSION) staleReasons.push("rule_version_mismatch");
  if (
    expectedRegistry
    && expectedRegistry !== effectiveRegistryVersion
    && expectedRegistry !== fingerprint
  ) {
    staleReasons.push("registry_version_mismatch");
  }
  return {
    rulesVersion: CONFIG_INFERENCE_VERSION,
    ragVersion: CONFIG_INFERENCE_RAG_VERSION,
    qualityVersion: CONFIG_INFERENCE_QUALITY_VERSION,
    registryVersion: effectiveRegistryVersion,
    registryFingerprint: fingerprint,
    registryVersionSource: registryVersion ? "provided" : "content_fingerprint",
    ...(expectedRules ? { expectedRuleVersion: expectedRules } : {}),
    ...(expectedRegistry ? { expectedRegistryVersion: expectedRegistry } : {}),
    stale: staleReasons.length > 0,
    staleReasons,
  };
}

function signalConflictMetadata(signals, context) {
  const hardDimensions = CONFIG_INFERENCE_DIMENSIONS
    .filter((dimension) => resolvedSignalValues(signals, dimension).length > 1);
  const softDimensions = CONFIG_INFERENCE_DIMENSIONS.filter((dimension) => {
    if (hardDimensions.includes(dimension)) return false;
    return uniqueStrings(signalMatches(signals)
      .filter((match) => match.category === dimension)
      .map((match) => match.value)).length > 1;
  });
  if (context.conflictingApplicationRepository && !hardDimensions.includes("applicationRepository")) {
    hardDimensions.push("applicationRepository");
  }
  const reviewDimensions = [...new Set([...hardDimensions, ...softDimensions])];
  const items = reviewDimensions.map((dimension) => {
    const matches = signalMatches(signals).filter((match) => match.category === dimension);
    const candidatesByValue = new Map();
    for (const match of matches) {
      const value = stringValue(match.value, 2000);
      const key = compact(value);
      if (!key) continue;
      const current = candidatesByValue.get(key) || {
        value,
        sourceGroups: [],
        signalIds: [],
        keywords: [],
        highestPriority: 0,
      };
      current.sourceGroups = uniqueStrings([...current.sourceGroups, match.group]);
      current.signalIds = uniqueStrings([...current.signalIds, match.id]);
      current.keywords = uniqueStrings([...current.keywords, match.keyword]);
      current.highestPriority = Math.max(
        current.highestPriority,
        CURRENT_SIGNAL_GROUP_PRIORITY[match.group] || 0,
      );
      candidatesByValue.set(key, current);
    }
    const candidates = [...candidatesByValue.values()]
      .sort((left, right) => right.highestPriority - left.highestPriority
        || left.value.localeCompare(right.value));
    const resolved = resolvedSignalValues(signals, dimension);
    return {
      id: `source_conflict:${dimension}`,
      dimension,
      severity: "blocking",
      resolutionRequired: true,
      recommendedValue: resolved.length === 1 ? resolved[0] : "",
      candidates,
    };
  });
  return {
    hardDimensions,
    softDimensions,
    reviewDimensions,
    items,
    count: hardDimensions.length,
    totalCount: hardDimensions.length + softDimensions.length,
    unresolvedCount: items.length,
  };
}

function executionAnchorMargin(ranked = []) {
  const executionAnchors = ranked
    .filter((candidate) => candidate.targetRole === "primary" || candidate.targetRole === "standalone")
    .sort((left, right) => Number(right.score || 0) - Number(left.score || 0));
  // 兼容旧注册表中同一仓库的第二条分支被标成 dependency 的情况：当过滤后没有
  // execution anchor，但仍只有一个合法候选时，它不是 top1/top2 并列，margin 应为 1。
  const anchors = executionAnchors.length
    ? executionAnchors
    : [...ranked].sort((left, right) => Number(right.score || 0) - Number(left.score || 0));
  if (!anchors.length) return { value: 0, topScore: 0, secondScore: 0, candidateCount: 0 };
  if (anchors.length === 1) {
    return {
      value: 1,
      topScore: Number(anchors[0].score || 0),
      secondScore: 0,
      candidateCount: 1,
    };
  }
  const topScore = Number(anchors[0].score || 0);
  const secondScore = Number(anchors[1].score || 0);
  return {
    value: Number(Math.max(0, Math.min(1, (topScore - secondScore) / Math.max(1, Math.abs(topScore)))).toFixed(3)),
    topScore: Number(topScore.toFixed(3)),
    secondScore: Number(secondScore.toFixed(3)),
    candidateCount: anchors.length,
  };
}

function heuristicCandidateConfidence(candidate, {
  sourceQuality,
  margin,
  conflicts,
} = {}) {
  const score = Number(candidate?.score || 0);
  const base = Math.min(0.98, 0.24 + (score / (score + 58)) * 0.74);
  const completenessFactor = sourceQuality?.known
    ? 0.55 + 0.45 * Math.max(0, Math.min(1, Number(sourceQuality.score) || 0))
    : 1;
  const marginFactor = margin?.candidateCount > 1
    ? 0.7 + 0.3 * Math.max(0, Math.min(1, Number(margin.value) || 0))
    : 1;
  const conflictFactor = Math.max(
    0.35,
    1 - Number(conflicts?.count || 0) * 0.22 - Number(conflicts?.softDimensions?.length || 0) * 0.06,
  );
  return Number(Math.max(0, Math.min(0.98, base * completenessFactor * marginFactor * conflictFactor)).toFixed(3));
}

export function inferConfigFromTicket({
  projectId = "",
  ticket: ticketInput = {},
  projectDefs = [],
  vehicleMap = {},
  keywordMappings = {},
  samples = [],
  valueBindings = {},
  calibrator = null,
  registryVersion = "",
  expectedRegistryVersion = "",
  expectedRuleVersion = "",
} = {}) {
  const ticket = normalizeConfigInferenceTicket(ticketInput);
  const structuredEvidence = extractStructuredConfigEvidence(ticket, { inferenceAt: ticket.snapshotAt });
  const structuredEvidenceMeta = structuredEvidenceSummary(structuredEvidence);
  const baseRegistry = buildConfigInferenceRegistry(projectDefs, vehicleMap);
  const registryTargets = bindConfigInferenceTargets(baseRegistry.targets, { projectId, valueBindings });
  const registry = {
    ...baseRegistry,
    targets: registryTargets,
    dimensions: Object.fromEntries(CONFIG_INFERENCE_DIMENSIONS.map((dimension) => [
      dimension,
      uniqueStrings(registryTargets.map((target) => target[dimension])),
    ])),
  };
  const serving = servingSamplesWithStats(samples, { projectId, valueBindings }, ticket.snapshotAt);
  samples = serving.samples;
  const signals = addRegistryBridgeSignals(
    extractConfigInferenceSignals(ticket, keywordMappings),
    keywordMappings,
    registry,
    vehicleMap,
  );
  const currentTargetContext = applicationRepositoryContext(signals, registry);
  const versions = inferenceVersionMetadata({
    registry,
    registryVersion,
    expectedRegistryVersion,
    expectedRuleVersion,
  });
  const candidates = new Map(registry.targets
    .filter((target) => !(target.repositoryOnly && target.targetRole === "dependency"))
    .map((target) => [targetIdentity(target), {
    ...target,
    score: 0,
    directScore: 0,
    directRepositoryScore: 0,
    directVariantScore: 0,
    historicalScore: 0,
    strongHistoricalScore: 0,
    positiveScore: 0,
    negativeScore: 0,
    evidenceIds: [],
  }]));
  const evidence = [];

  const addEvidence = (item) => {
    const id = `E${evidence.length + 1}`;
    evidence.push({ id, ...item, weight: Number(Number(item.weight || 0).toFixed(2)) });
    return id;
  };

  // Seed every trusted historical positive before applying either positive or negative
  // scores. This makes removal learning independent of sample sort order and lets a
  // dependency promoted by a human to primary become a candidate even though registry
  // dependency rows are intentionally excluded from the default candidate pool.
  for (const sample of Array.isArray(samples) ? samples : []) {
    if (!sample || typeof sample !== "object" || !sample.signals || sample.supersededBy) continue;
    const similarity = signalsSimilarity(signals, sample.signals);
    const historyContext = historicalSampleContext(signals, sample.signals, similarity);
    if (!historyContext.allowed || sampleWeight(sample, similarity) <= 0) continue;
    for (const historicalTarget of historicalTargetsForReuse(sample, registry, signals)) {
      if (!targetMatchesResolvedVariant(historicalTarget, signals)) continue;
      if (!historicalTargetMatchesCurrentContext(
        historicalTarget,
        currentTargetContext,
        signals,
        registry,
      )) continue;
      const registered = hasConfigInferenceSymbolicFields(historicalTarget)
        ? historicalTarget
        : findRegisteredTarget(historicalTarget, registry.targets);
      if (!registered || !targetMatchesResolvedVariant(registered, signals)) continue;
      const remembered = hasConfigInferenceSymbolicFields(historicalTarget)
        ? historicalTarget
        : {
          ...registered,
          targetRole: historicalTarget.targetRole || registered.targetRole,
          order: historicalTarget.order || registered.order,
          ...(historicalTarget.fieldBindings ? { fieldBindings: historicalTarget.fieldBindings } : {}),
        };
      // 非代号历史目标以当前注册表身份合并。旧进程/其它客户端派生的 logicalKey
      // 不能让同一个五维工程在 RAG 推理里复制成两条。
      const identity = hasConfigInferenceSymbolicFields(remembered)
        ? targetIdentity(remembered)
        : targetIdentity(registered);
      if (!candidates.has(identity)) {
        candidates.set(identity, {
          ...remembered,
          score: 0,
          directScore: 0,
          directRepositoryScore: 0,
          directVariantScore: 0,
          historicalScore: 0,
          strongHistoricalScore: 0,
          positiveScore: 0,
          negativeScore: 0,
          evidenceIds: [],
        });
      }
    }
  }

  for (const match of signals.matches) {
    const baseWeight = GROUP_WEIGHTS[match.group] || 20;
    const weight = match.inferred ? baseWeight * 0.85 : baseWeight;
    const evidenceId = addEvidence({
      kind: match.inferred ? "registry_keyword_bridge" : "keyword_mapping",
      group: match.group,
      keyword: match.keyword,
      category: match.category,
      value: match.value,
      weight,
      detail: match.inferred
        ? `${match.group} 来源关键词通过车型源码/仓库注册表唯一关联到 ${match.category}`
        : `${match.group} 来源规则命中 ${match.category}`,
    });
    for (const candidate of candidates.values()) {
      if (!dimensionMatches(candidate, match.category, match.value)) continue;
      candidate.score += weight;
      candidate.directScore += weight;
      if (match.category === "repositoryId") candidate.directRepositoryScore += weight;
      if (CURRENT_VARIANT_DIMENSIONS.includes(match.category)) candidate.directVariantScore += weight;
      candidate.positiveScore += weight;
      if (!candidate.evidenceIds.includes(evidenceId)) candidate.evidenceIds.push(evidenceId);
    }
  }

  for (const [index, sample] of (Array.isArray(samples) ? samples : []).entries()) {
    if (!sample || typeof sample !== "object" || !sample.signals || sample.supersededBy) continue;
    const promotion = repositoryDependencyPromotionContext(sample, registry, signals);
    if (promotion.promotion && !promotion.currentAllowed) continue;
    const similarity = signalsSimilarity(signals, sample.signals);
    const historyContext = historicalSampleContext(signals, sample.signals, similarity);
    if (!historyContext.allowed) continue;
    if (sampleDecision(sample) === "insufficient") {
      const penalty = insufficientSamplePenalty(sample, signals, similarity);
      if (penalty <= 0) continue;
      const rejectedIdentities = new Set();
      for (const rejectedTarget of rejectedSampleTargets(sample)) {
        if (!targetMatchesResolvedVariant(rejectedTarget, signals)) continue;
        if (!historicalTargetMatchesCurrentContext(
          rejectedTarget,
          currentTargetContext,
          signals,
          registry,
        )) continue;
        const registered = findRegisteredTarget(rejectedTarget, registry.targets);
        if (!registered || !targetMatchesResolvedVariant(registered, signals)) continue;
        const identity = targetIdentity(registered);
        rejectedIdentities.add(identity);
        const candidate = candidates.get(identity);
        if (!candidate) continue;
        const evidenceId = addEvidence({
          kind: "historical_insufficient",
          group: "sample",
          keyword: stringValue(sample.id || sample.ticketId || `sample-${index + 1}`, 500),
          category: "target",
          value: `${registered.repositoryId}/${registered.branch}/${registered.flavor}`,
          weight: -penalty,
          similarity: Number(similarity.toFixed(3)),
          detail: "相同来源、规则和候选曾被人工判定为信息不足",
        });
        candidate.negativeScore += penalty;
        candidate.score -= penalty;
        if (!candidate.evidenceIds.includes(evidenceId)) candidate.evidenceIds.push(evidenceId);
      }
      // “信息不足”否定的是当前信号能否支撑结论，而不只是 UI 当时展示的第一候选。
      // 对相同规则仍能命中的其他候选施加较小上下文惩罚，避免下一轮机械地换一个候选继续猜；
      // 后续明确的正确/纠正样本仍可用更高正权重覆盖该惩罚。
      const contextCandidates = [...candidates.entries()]
        .filter(([identity, candidate]) => !rejectedIdentities.has(identity)
          && targetMatchesResolvedVariant(candidate, signals)
          && targetMatchesApplicationRepositoryContext(candidate, currentTargetContext, {
            allowUniqueVariantApplication: true,
            allowUnknown: true,
          })
          && signals.matches.some((match) => dimensionMatches(candidate, match.category, match.value)))
        .map(([, candidate]) => candidate);
      if (contextCandidates.length) {
        const contextPenalty = penalty * 0.35;
        const evidenceId = addEvidence({
          kind: "historical_insufficient",
          group: "sample",
          keyword: stringValue(sample.id || sample.ticketId || `sample-${index + 1}`, 500),
          category: "signal_context",
          value: `${contextCandidates.length} 个同规则候选`,
          weight: -contextPenalty,
          similarity: Number(similarity.toFixed(3)),
          detail: "相同来源和规则曾被人工判定为信息不足，降低未展示候选的猜测权重",
        });
        for (const candidate of contextCandidates) {
          candidate.negativeScore += contextPenalty;
          candidate.score -= contextPenalty;
          if (!candidate.evidenceIds.includes(evidenceId)) candidate.evidenceIds.push(evidenceId);
        }
      }
      continue;
    }
    const weight = sampleWeight(sample, similarity);
    if (weight <= 0) continue;
    const correctionAllowed = contextualHistoricalCorrectionAllowed(signals, sample.signals, similarity);
    for (const removedTarget of correctionAllowed ? rejectedSampleTargets(sample) : []) {
      if (!targetMatchesResolvedVariant(removedTarget, signals)) continue;
      if (!historicalTargetMatchesCurrentContext(
        removedTarget,
        currentTargetContext,
        signals,
        registry,
      )) continue;
      const registered = hasConfigInferenceSymbolicFields(removedTarget)
        ? removedTarget
        : findRegisteredTarget(removedTarget, registry.targets);
      if (!registered || !targetMatchesResolvedVariant(registered, signals)) continue;
      const candidate = candidates.get(targetIdentity(registered));
      if (!candidate) continue;
      // A corrected review commonly carries the default 3-star score even though the
      // deletion itself is explicit. It must override one older 5-star positive memory
      // for the same signals; otherwise the removed project immediately comes back.
      const penalty = Math.min(120, Math.max(weight * 1.5, 48 + similarity * 72));
      const evidenceId = addEvidence({
        kind: "historical_target_removal",
        group: "sample",
        keyword: stringValue(sample.id || sample.ticketId || `sample-${index + 1}`, 500),
        category: "target",
        value: `${registered.repositoryId}/${registered.branch}/${registered.flavor}`,
        weight: -penalty,
        similarity: Number(similarity.toFixed(3)),
        detail: "相似工单中该工程目标曾被人工删除",
      });
      candidate.negativeScore += penalty;
      candidate.score -= penalty;
      if (!candidate.evidenceIds.includes(evidenceId)) candidate.evidenceIds.push(evidenceId);
    }
    const historicalTargets = historicalTargetsForReuse(sample, registry, signals);
    for (const historicalTarget of historicalTargets) {
      if (!targetMatchesResolvedVariant(historicalTarget, signals)) continue;
      if (!historicalTargetMatchesCurrentContext(
        historicalTarget,
        currentTargetContext,
        signals,
        registry,
      )) continue;
      const registered = hasConfigInferenceSymbolicFields(historicalTarget)
        ? historicalTarget
        : findRegisteredTarget(historicalTarget, registry.targets);
      if (!registered || !targetMatchesResolvedVariant(registered, signals)) continue;
      const remembered = hasConfigInferenceSymbolicFields(historicalTarget)
        ? historicalTarget
        : {
          ...registered,
          targetRole: historicalTarget.targetRole || registered.targetRole,
          order: historicalTarget.order || registered.order,
          ...(historicalTarget.fieldBindings ? { fieldBindings: historicalTarget.fieldBindings } : {}),
        };
      const identity = hasConfigInferenceSymbolicFields(remembered)
        ? targetIdentity(remembered)
        : targetIdentity(registered);
      if (!candidates.has(identity)) {
        candidates.set(identity, {
          ...remembered,
          score: 0,
          directScore: 0,
          directRepositoryScore: 0,
          directVariantScore: 0,
          historicalScore: 0,
          strongHistoricalScore: 0,
          positiveScore: 0,
          negativeScore: 0,
          evidenceIds: [],
        });
      }
      const candidate = candidates.get(identity);
      if (!candidate) continue;
      if (weight >= Number(candidate.historicalStructureWeight || 0)) {
        candidate.targetRole = remembered.targetRole;
        candidate.order = remembered.order;
        candidate.historicalStructureWeight = weight;
      }
      // 历史是排序辅助，不是多数投票。无论累积多少相似旧单，单个候选的历史
      // 正向得分都不能无限增长并压过当前标题/标签/评论等明确证据。
      const appliedWeight = Math.min(
        weight,
        Math.max(0, HISTORICAL_TARGET_SCORE_CAP - Number(candidate.historicalScore || 0)),
      );
      if (appliedWeight <= 0) continue;
      const evidenceId = addEvidence({
        kind: "historical_feedback",
        group: "sample",
        keyword: stringValue(sample.id || sample.ticketId || `sample-${index + 1}`, 500),
        category: "target",
        value: `${registered.repositoryId}/${registered.branch}/${registered.flavor}`,
        weight: appliedWeight,
        similarity: Number(similarity.toFixed(3)),
        detail: hasConfigInferenceSymbolicFields(remembered)
          ? "历史反馈保留了待替换的代号/中间值"
          : "历史反馈样本与当前六源信号相似",
      });
      candidate.score += appliedWeight;
      candidate.historicalScore += appliedWeight;
      if (historyContext.strongSourceOverlap) candidate.strongHistoricalScore += appliedWeight;
      candidate.positiveScore += appliedWeight;
      if (!candidate.evidenceIds.includes(evidenceId)) candidate.evidenceIds.push(evidenceId);
    }
  }

  // 独立 SDK/脚本/工具仓库可以没有应用、车型和 Flavor；只有显式开启仓库推理且
  // 命中仓库自己的关键词时才参与普通候选，避免遗留 projectDef 污染应用候选。
  for (const repository of registry.repositories) {
    if (!repository.inferenceEnabled || repository.requiresRepositories.length) continue;
    const match = repositoryInferenceKeywordMatch(signals, repository.inferenceKeywords);
    if (!match) continue;
    const candidate = [...candidates.values()].find((row) => (
      row.repositoryOnly && normalizedText(row.repositoryId) === normalizedText(repository.id)
    ));
    if (!candidate) continue;
    const weight = (GROUP_WEIGHTS[match.group] || 20) * 0.9;
    const evidenceId = addEvidence({
      kind: "repository_keyword",
      group: match.group,
      keyword: match.keyword,
      category: "repositoryId",
      value: repository.id,
      weight,
      detail: `${repository.name} 是无独立应用的工程，仓库推理关键词命中`,
    });
    candidate.score += weight;
    candidate.directScore += weight;
    candidate.positiveScore += weight;
    candidate.evidenceIds.push(evidenceId);
  }

  const variantSignalsResolved = hasResolvedVariantSignals(signals);
  const resolvedVehicleSignals = resolvedSignalValues(signals, "vehicle");
  const ambiguousCurrentVariantDimensions = CURRENT_VARIANT_DIMENSIONS
    .filter((dimension) => resolvedSignalValues(signals, dimension).length > 1);
  const contextCompatibleCandidates = ambiguousCurrentVariantDimensions.length
    ? []
    : [...candidates.values()].filter((candidate) => (
      targetMatchesResolvedVariant(candidate, signals)
      && targetMatchesApplicationRepositoryContext(candidate, currentTargetContext, {
        allowUniqueVariantApplication: true,
        allowUnknown: true,
      })
    ));
  const directlyMatchedRepositoryGroups = new Set(contextCompatibleCandidates
    .filter((candidate) => !candidate.repositoryOnly && Number(candidate.directRepositoryScore || 0) > 0)
    .map(targetApplicationGroupSignature));
  const directlyMatchedRepositoryAppNames = new Set(contextCompatibleCandidates
    .filter((candidate) => !candidate.repositoryOnly && Number(candidate.directRepositoryScore || 0) > 0)
    .map((candidate) => compact(candidate.appName))
    .filter(Boolean));
  // 仓库命中只限定其所属应用组；同一应用组中的 Web/模块依赖继续保留，同车型下
  // 其他应用（例如 Settings）不能仅凭车型分数被顺带选中。
  const compatibleCandidates = directlyMatchedRepositoryGroups.size
    ? contextCompatibleCandidates.filter((candidate) => candidate.repositoryOnly
      || (hasConfigInferenceSymbolicFields(candidate)
        && directlyMatchedRepositoryAppNames.has(compact(candidate.appName)))
      || directlyMatchedRepositoryGroups.has(targetApplicationGroupSignature(candidate)))
    : contextCompatibleCandidates;
  const maxDirectVariantScore = Math.max(0, ...compatibleCandidates
    .filter((candidate) => !candidate.repositoryOnly)
    .map((candidate) => Number(candidate.directVariantScore || 0)));
  const directlyMatchedApplicationVariants = new Set(compatibleCandidates
    .filter((candidate) => !candidate.repositoryOnly && Number(candidate.directScore || 0) >= 12)
    .map(targetVariantSignature)
    .filter((signature) => signature && signature !== "flavor:"));
  const unresolvedModelHints = resolvedVehicleSignals.length ? new Set() : sourceModelHints(signals);
  const ambiguousVariantFallback = !resolvedVehicleSignals.length && directlyMatchedApplicationVariants.size > 1;

  const ranked = compatibleCandidates
    .filter((candidate) => {
      if (candidate.repositoryOnly) return true;
      // 只识别出应用、仓库或一个跨车型共用的 Flavor/分支时，不能生成任意车型。
      // 只有完整标题/备注或车型特征构成的强同源人工记忆可以补足该维度。
      if (unresolvedModelHints.size || ambiguousVariantFallback) {
        return Number(candidate.strongHistoricalScore || 0) > 0;
      }
      return true;
    })
    .filter((candidate) => candidate.score >= 12)
    .filter((candidate) => (
      candidate.repositoryOnly
      || !variantSignalsResolved
      || maxDirectVariantScore <= 0
      || Number(candidate.directVariantScore || 0) >= maxDirectVariantScore * 0.58
    ))
    .sort((left, right) => (variantSignalsResolved
      ? Number(right.directVariantScore || 0) - Number(left.directVariantScore || 0)
        || Number(right.directScore || 0) - Number(left.directScore || 0)
      : 0)
      || right.score - left.score
      || left.repositoryId.localeCompare(right.repositoryId)
      || left.branch.localeCompare(right.branch));
  const conflicts = signalConflictMetadata(signals, currentTargetContext);
  const margin = executionAnchorMargin(ranked);
  const confidenceFactors = {
    sourceQuality: signals.sourceQuality,
    margin,
    conflicts,
  };
  const topScore = variantSignalsResolved
    ? Math.max(0, ...ranked.filter((candidate) => !candidate.repositoryOnly).map((candidate) => Number(candidate.directVariantScore || 0)))
    : ranked[0]?.score || 0;
  const selected = ranked
    .filter((candidate, index) => (
      candidate.repositoryOnly
        ? candidate.score >= 12
        : index === 0
          || (candidate.score >= 12 && (variantSignalsResolved
            ? Number(candidate.directVariantScore || 0) >= topScore * 0.58
            : candidate.score >= topScore * 0.58))
    ))
    .slice(0, 12)
    .sort((left, right) => {
      const rank = (target) => target.targetRole === "primary" ? 0 : target.targetRole === "standalone" ? 1 : 2;
      const rankDiff = rank(left) - rank(right);
      if (rankDiff) return rankDiff;
      const leftOrder = Number(left.order) > 0 ? Number(left.order) : Number.POSITIVE_INFINITY;
      const rightOrder = Number(right.order) > 0 ? Number(right.order) : Number.POSITIVE_INFINITY;
      if (compact(left.vehicle) === compact(right.vehicle) && leftOrder !== rightOrder) return leftOrder < rightOrder ? -1 : 1;
      return right.score - left.score;
    })
    .map((candidate) => {
      const confidence = heuristicCandidateConfidence(candidate, confidenceFactors);
      const symbolic = hasConfigInferenceSymbolicFields(candidate);
      return {
        ...(candidate.targetId ? { targetId: candidate.targetId } : {}),
        appName: candidate.appName,
        vehicle: candidate.vehicle,
        repositoryId: candidate.repositoryId,
        repositoryName: candidate.repositoryName,
        gitUrl: candidate.gitUrl,
        branch: candidate.branch,
        flavor: candidate.flavor,
        projectType: candidate.projectType,
        targetRole: candidate.targetRole,
        repositoryOnly: candidate.repositoryOnly,
        order: candidate.order,
        ...(symbolic ? { fieldStates: candidate.fieldStates, resolutionStatus: "partial" } : {}),
        ...(candidate.fieldBindings ? { fieldBindings: candidate.fieldBindings } : {}),
        confidence,
        evidenceIds: [...candidate.evidenceIds],
      };
    });

  // 一次执行图只能有一个入口：应用主工程或独立仓库。仅凭同一车型等共享信号
  // 同时命中多个应用，或同时命中应用与独立工具时，没有证据可以安全决定入口；
  // 不能把多个锚点交给后续克隆/执行流程，也不能按排序擅自选一个默认值。
  const executionAnchors = selected.filter((target) => (
    target.targetRole === "primary" || target.targetRole === "standalone"
  ));
  const ambiguousExecutionAnchors = executionAnchors.length > 1;

  // 依赖工程只能在主工程已经进入最终基础结果后原子追加，不参加 topScore 比例竞争。
  // 这确保“应用市场 + 语音”能得到 appMarket → appMarketSdk，同时单独“语音”不会误推 SDK。
  if (!ambiguousExecutionAnchors) {
    for (const parent of [...selected]) {
      for (const dependency of registry.repositories.filter((repository) => (
        repository.requiresRepositories.some((id) => normalizedText(id) === normalizedText(parent.repositoryId))
      ))) {
        const match = repositoryInferenceKeywordMatch(signals, dependency.inferenceKeywords);
        if (!match || selected.some((target) => normalizedText(target.repositoryId) === normalizedText(dependency.id))) continue;
        const rejected = dependencyRejectedByReviewedSample(samples, signals, dependency.id);
        if (rejected) {
          addEvidence({
            kind: "historical_dependency_rejection",
            group: "sample",
            keyword: stringValue(rejected.sample?.id || rejected.sample?.sourceRunId || "review", 500),
            category: "repositoryId",
            value: dependency.id,
            weight: -32,
            similarity: Number(rejected.similarity.toFixed(3)),
            detail: "相似工单中该依赖工程曾被人工纠正删除，本次不再自动追加",
          });
          continue;
        }
        const profile = registry.targets.find((target) => (
          target.repositoryOnly && normalizedText(target.repositoryId) === normalizedText(dependency.id)
        ));
        if (!profile) continue;
        const evidenceId = addEvidence({
          kind: "repository_dependency",
          group: match.group,
          keyword: match.keyword,
          category: "repositoryId",
          value: dependency.id,
          weight: GROUP_WEIGHTS[match.group] || 20,
          detail: `${parent.repositoryName || parent.repositoryId} 命中依赖关键词，追加 ${dependency.name}`,
        });
        const inherited = Object.fromEntries(dependency.inheritVariant.map((field) => [field, parent[field] || ""]));
        selected.push({
          ...profile,
          ...inherited,
          appName: "",
          branch: dependency.defaultBranch || inherited.branch || profile.branch || "",
          flavor: dependency.defaultFlavor || inherited.flavor || profile.flavor || "",
          targetRole: "dependency",
          repositoryOnly: true,
          confidence: Number(Math.max(0.35, Number(parent.confidence || 0) * 0.92).toFixed(3)),
          evidenceIds: [evidenceId],
        });
      }
    }
  }

  const candidateTargets = ambiguousExecutionAnchors ? [] : selected;
  const heuristicConfidence = Number(candidateTargets[0]?.confidence || 0);
  const calibratedProbability = calibrateConfigInferenceScore(calibrator, margin.topScore);
  const outOfDistribution = unresolvedModelHints.size > 0;
  const policyEvaluation = evaluateConfigInferencePolicy({
    targets: candidateTargets,
    calibratedProbability,
    heuristicConfidence,
    margin: margin.value,
    sourceCoverage: ticket.sourceCoverage || {},
    requiredSources: signals.sourceQuality?.requiredSources || [],
    // 高低优先级只用于给出推荐值；任何跨来源矛盾都必须由人工显式裁决。
    conflictCount: conflicts.totalCount,
    outOfDistribution,
    registryValid: !versions.stale,
    remoteRefsValid: false,
    hasSymbolic: candidateTargets.some(hasConfigInferenceSymbolicFields),
    localBindingComplete: false,
    humanConfirmationRequired: true,
    marginThreshold: MIN_EXECUTION_ANCHOR_MARGIN,
  });
  // 统一 policy 的 abstain 还包括 symbolic_value_unresolved：它禁止自动采用，但
  // symbolic 候选必须继续展示给人工替换。这里只隐藏会让“候选本身不可信”的结果。
  const recommendationBlockingReasons = new Set([
    "out_of_distribution",
    "registry_invalid",
    "margin_below_threshold",
  ]);
  const recommendationAbstained = policyEvaluation.reasons
    .some((reason) => recommendationBlockingReasons.has(reason));
  const resultTargets = recommendationAbstained ? [] : candidateTargets;
  const confidenceMetadata = {
    kind: "heuristic",
    method: CONFIDENCE_METHOD,
    calibrated: calibratedProbability != null,
    calibratedProbability,
    calibrator: {
      method: stringValue(calibrator?.method, 80) || null,
      status: stringValue(calibrator?.status, 80) || "not_configured",
      schemaVersion: stringValue(calibrator?.schemaVersion, 160) || null,
      sampleCount: Number(calibrator?.sampleCount || 0),
    },
    heuristicConfidence,
    rawTopScore: margin.topScore,
    factors: {
      sourceCompleteness: Number(signals.sourceQuality?.score ?? 1),
      sourceCompletenessKnown: signals.sourceQuality?.known === true,
      top1Top2Margin: margin.value,
      topScore: margin.topScore,
      secondScore: margin.secondScore,
      competingAnchors: margin.candidateCount,
      hardConflictCount: conflicts.count,
      softConflictCount: conflicts.softDimensions.length,
      registryStale: versions.stale,
    },
  };

  const missingInformation = [];
  if (ambiguousExecutionAnchors) {
    missingInformation.push("当前证据同时命中多个主工程或独立工程，无法唯一确定执行锚点，请补充应用或工程范围");
  }
  if (!signals.matches.length && !resultTargets.length) missingInformation.push("六类关键词规则均未命中，且没有可复用的历史反馈样本");
  if (!resultTargets.length && unresolvedModelHints.size) {
    missingInformation.push(`检测到未能映射到车型源码配置的车型特征：${[...unresolvedModelHints].slice(0, 6).join("、")}`);
  }
  if (!resultTargets.length && ambiguousVariantFallback) {
    missingInformation.push("当前证据只识别到应用或仓库，不能唯一确定车型、分支和 Flavor");
  }
  if (!resultTargets.length && ambiguousCurrentVariantDimensions.length) {
    missingInformation.push(`当前主语来源对以下维度给出多个冲突值：${ambiguousCurrentVariantDimensions.join("、")}`);
  }
  if (!resultTargets.length) missingInformation.push("未推理出受工程定义、车型源码注册表或已复核代号记忆支持的工程配置");
  if (!resultTargets.length && evidence.some((item) => item.kind === "historical_insufficient")) {
    missingInformation.push("相同来源、规则和候选曾被判定为信息不足，请补充信号或人工纠正配置");
  }
  if (policyEvaluation.missingSources.length) {
    missingInformation.push(`以下声明来源不可用或不完整；仍会基于现有来源推理：${policyEvaluation.missingSources.join("、")}`);
  }
  if (conflicts.items.length) {
    missingInformation.push(`不同来源对以下配置给出了矛盾结论，需人工裁决：${conflicts.reviewDimensions.join("、")}`);
  }
  if (policyEvaluation.reasons.includes("margin_below_threshold")) {
    missingInformation.push(`Top1/Top2 候选间隔 ${margin.value.toFixed(3)} 低于安全阈值 ${MIN_EXECUTION_ANCHOR_MARGIN.toFixed(2)}`);
  }
  if (versions.stale) {
    missingInformation.push(`推理版本已过期：${versions.staleReasons.join("、")}`);
  }
  const missingRequired = [...new Set(resultTargets.flatMap(requiredTargetFields))];
  for (const dimension of missingRequired) {
    missingInformation.push(`缺少${dimension}维度`);
  }

  return {
    status: resultTargets.length ? "NEED_HUMAN_CONFIRMATION" : "NEED_MORE_INFO",
    ticket,
    signals,
    dimensions: resultDimensions(resultTargets),
    targets: resultTargets,
    evidence,
    structuredEvidence,
    structuredEvidenceSummary: structuredEvidenceMeta,
    missingInformation,
    confidenceScore: resultTargets[0]?.confidence || 0,
    heuristicConfidence: resultTargets.length ? heuristicConfidence : 0,
    calibratedProbability: resultTargets.length ? calibratedProbability : null,
    confidenceMetadata,
    quality: {
      source: signals.sourceQuality,
      conflicts,
      margin,
      outOfDistribution,
      servingSamples: serving.stats,
      structuredEvidence: structuredEvidenceMeta,
    },
    versions,
    stale: versions.stale,
    policy: {
      version: CONFIG_INFERENCE_VERSION,
      candidateConstrained: !resultTargets.some(hasConfigInferenceSymbolicFields),
      allowsSymbolicTargets: true,
      currentVariantConstrained: true,
      currentEvidenceHardGate: true,
      boundedHistoricalScoring: true,
      dependencyKeywordGated: true,
      noDefaultVariantFallback: true,
      conflictingHistoryExcluded: true,
      requiresHumanConfirmation: true,
      canExecute: false,
      confidenceKind: "heuristic",
      calibrated: calibratedProbability != null,
      calibratedProbability,
      heuristicConfidence,
      abstain: policyEvaluation.abstain,
      recommendationAbstained,
      abstainReasons: policyEvaluation.reasons,
      canAutoApply: policyEvaluation.canAutoApply,
      thresholds: policyEvaluation.thresholds,
      requiredSources: signals.sourceQuality?.requiredSources || [],
      missingSources: policyEvaluation.missingSources,
      registryValid: !versions.stale,
      servingSamplesApprovedActiveOrVerified: true,
      legacySampleCompatibility: true,
    },
  };
}

function ragTarget(target = {}) {
  const fieldStates = normalizeTargetFieldStates(target.fieldStates);
  const fieldBindings = normalizeTargetFieldBindings(target.fieldBindings);
  const targetId = stringValue(target.targetId || target.targetKey || target.id, 200);
  return {
    ...(targetId ? { targetId } : {}),
    appName: stringValue(target.appName, 160),
    vehicle: stringValue(target.vehicle, 120),
    repositoryId: stringValue(target.repositoryId, 120),
    repositoryName: stringValue(target.repositoryName, 160),
    branch: stringValue(target.branch, 240),
    flavor: stringValue(target.flavor, 160),
    projectType: normalizeProjectType(target.projectType || target.targetType),
    targetRole: stringValue(target.targetRole || target.role, 40),
    repositoryOnly: target.repositoryOnly === true,
    order: Math.max(0, Math.trunc(Number(target.order || target.sortOrder) || 0)),
    ...(Object.keys(fieldStates).length ? { fieldStates, resolutionStatus: "partial" } : {}),
    ...(Object.keys(fieldBindings).length ? { fieldBindings } : {}),
  };
}

function ragSampleSourceGroups(currentSignals, historicalSignals) {
  const groups = [];
  for (const group of CONFIG_INFERENCE_SOURCE_GROUPS) {
    const currentValues = signalSourceValues(currentSignals, group);
    const historicalValues = signalSourceValues(historicalSignals, group);
    if (!currentValues.length || !historicalValues.length) continue;
    let best = 0;
    for (const left of currentValues) {
      for (const right of historicalValues) {
        if (compact(left) && compact(left) === compact(right)) best = 1;
        else best = Math.max(best, textSimilarity(left, right));
      }
    }
    if (best > 0) groups.push(group);
  }
  return groups;
}

function registeredRagTargets(targets, registry) {
  const rows = [];
  for (const target of targets) {
    if (hasConfigInferenceSymbolicFields(target)) {
      const row = ragTarget(target);
      if (!rows.some((item) => targetIdentity(item) === targetIdentity(row))) rows.push(row);
      continue;
    }
    const registered = findRegisteredTarget(target, registry.targets);
    if (!registered) continue;
    const row = ragTarget(registered.repositoryOnly ? {
      ...registered,
      ...target,
      appName: target.appName || "",
      repositoryName: registered.repositoryName || target.repositoryName,
      projectType: registered.projectType,
      repositoryOnly: true,
    } : {
      ...registered,
      ...target,
      repositoryName: registered.repositoryName || target.repositoryName,
      gitUrl: registered.gitUrl || target.gitUrl,
      projectType: registered.projectType,
      repositoryOnly: false,
      targetRole: target.targetRole || registered.targetRole,
      order: target.order || registered.order,
      ...(target.fieldBindings ? { fieldBindings: target.fieldBindings } : {}),
    });
    if (!rows.some((item) => targetIdentity(item) === targetIdentity(row))) rows.push(row);
  }
  return rows;
}

/**
 * 通用 RAG 检索层：只返回结构化、受注册表约束的配置事实，不携带任何模型/供应商字段。
 * Codex、Claude、DeepSeek 以及自定义 API 引擎都可消费同一份结果；本函数只读，不创建 run、
 * 不采集关键词，也不会修改模型权重。人工复核和真实执行样本由 store 持久化后在这里统一召回。
 */
export function retrieveConfigInferenceMemories({
  projectId = "",
  ticket: ticketInput = {},
  projectDefs = [],
  vehicleMap = {},
  keywordMappings = {},
  samples = [],
  valueBindings = {},
  limit = 6,
  calibrator = null,
  registryVersion = "",
  expectedRegistryVersion = "",
  expectedRuleVersion = "",
} = {}) {
  const ticket = normalizeConfigInferenceTicket(ticketInput);
  const baseRegistry = buildConfigInferenceRegistry(projectDefs, vehicleMap);
  const registryTargets = bindConfigInferenceTargets(baseRegistry.targets, { projectId, valueBindings });
  const registry = { ...baseRegistry, targets: registryTargets };
  const rawSamples = Array.isArray(samples) ? samples : [];
  const serving = servingSamplesWithStats(rawSamples, { projectId, valueBindings }, ticket.snapshotAt);
  samples = serving.samples;
  const inference = inferConfigFromTicket({
    projectId,
    ticket,
    projectDefs,
    vehicleMap,
    keywordMappings,
    samples: rawSamples,
    valueBindings,
    calibrator,
    registryVersion,
    expectedRegistryVersion,
    expectedRuleVersion,
  });
  const maxItems = Math.max(1, Math.min(12, Number(limit) || 6));
  const memories = [];
  const currentInferenceTargetIdentities = new Set((inference.targets || []).map(targetIdentity));
  const currentTargetContext = applicationRepositoryContext(inference.signals, registry);
  const contextCompatibleVariants = new Set(registry.targets
    .filter((target) => !target.repositoryOnly)
    .filter((target) => targetMatchesResolvedVariant(target, inference.signals))
    .filter((target) => targetMatchesApplicationRepositoryContext(target, currentTargetContext, {
      allowUniqueVariantApplication: true,
      allowUnknown: false,
    }))
    .map(targetVariantSignature)
    .filter(Boolean));
  const currentVariantResolved = hasResolvedVariantSignals(inference.signals);
  const registryContextHasUniqueVariant = contextCompatibleVariants.size === 1;
  const repositoryMemoryMatchesCurrentSignals = (target) => {
    const registered = hasConfigInferenceSymbolicFields(target)
      ? null
      : findRegisteredTarget(target, registry.targets);
    const repositoryOnly = target?.repositoryOnly === true || registered?.repositoryOnly === true;
    if (!repositoryOnly) return true;
    const repository = registry.repositories.find((item) => (
      normalizedText(item.id) === normalizedText(target?.repositoryId || registered?.repositoryId)
    ));
    // SDK、脚本和工具仓库即使来自“同标题”五星记忆，也必须由当前工单再次命中
    // 该仓库自己的关键词。memories.targets 会直接提供给各模型，不能降级成审计旁路。
    if (!repository) return false;
    // 用户手工登记且没有自动推理关键词的仓库，只能依靠精确同工单人工记忆展示；
    // 一旦配置了关键词，就必须由当前工单重新命中，历史内容不能代替当前证据。
    if (!repository.inferenceKeywords.length) return true;
    return !!repositoryInferenceKeywordMatch(inference.signals, repository.inferenceKeywords);
  };

  for (const [index, sample] of (Array.isArray(samples) ? samples : []).entries()) {
    if (!sample || typeof sample !== "object" || !sample.signals || sample.supersededBy) continue;
    const promotion = repositoryDependencyPromotionContext(sample, registry, inference.signals);
    if (promotion.promotion && !promotion.currentAllowed) continue;
    const similarity = signalsSimilarity(inference.signals, sample.signals);
    const historyContext = historicalSampleContext(inference.signals, sample.signals, similarity);
    if (!historyContext.allowed) continue;
    const decision = sampleDecision(sample);
    const negative = ["insufficient", "ticket_wrong", "incorrect"].includes(decision);
    // ticket_wrong 说明工单本身不适合沉淀工程配置，不能作为任何模型的配置事实召回。
    if (decision === "ticket_wrong" || decision === "incorrect") continue;
    if (decision === "insufficient" && insufficientSamplePenalty(sample, inference.signals, similarity) <= 0) continue;
    const source = stringValue(sample.source || "feedback", 120);
    const trustedPositive = ["correct", "corrected"].includes(decision)
      || source === "actual_execution"
      || source === "legacy_config_memory";
    // 未复核、来源未知但恰好带 groundTruth 的脏数据不得冒充所有模型的正向记忆。
    if (!negative && !trustedPositive) continue;
    const exactHistoricalSubject = hasExactHistoricalSubjectOverlap(inference.signals, sample.signals);
    const memoryTargetAllowed = (target) => {
      const registeredRepository = target.repositoryOnly
        ? registry.repositories.find((item) => (
          normalizedText(item.id) === normalizedText(target.repositoryId)
        ))
        : null;
      const exactManualRepositoryMemory = target.repositoryOnly
        && exactHistoricalSubject
        && !registeredRepository?.inferenceKeywords?.length;
      return repositoryMemoryMatchesCurrentSignals(target)
        && targetMatchesResolvedVariant(target, inference.signals)
        && (
          historicalTargetMatchesCurrentContext(
            target,
            currentTargetContext,
            inference.signals,
            registry,
          )
          || currentInferenceTargetIdentities.has(targetIdentity(target))
          || exactManualRepositoryMemory
        )
        && (
          target.repositoryOnly
          || currentVariantResolved
          || registryContextHasUniqueVariant
          || historyContext.strongSourceOverlap
          || currentInferenceTargetIdentities.has(targetIdentity(target))
        );
    };
    const reusablePositiveTargets = historicalTargetsForReuse(sample, registry, inference.signals);
    if (!negative && exactHistoricalSubject) {
      // 仅保留精确工单人工登记、且没有自动准入关键词的仓库依赖作为审计记忆。
      // 配置过 inferenceKeywords 的依赖（如语音 SDK）必须由当前工单再次命中。
      for (const target of sampleTargets(sample)) {
        const registered = findRegisteredTarget(target, registry.targets);
        if (!registered?.repositoryOnly || target.targetRole !== "dependency") continue;
        if (!repositoryMemoryMatchesCurrentSignals(registered)) continue;
        if (!reusablePositiveTargets.some((item) => targetIdentity(item) === targetIdentity(target))) {
          reusablePositiveTargets.push(target);
        }
      }
    }
    const targets = registeredRagTargets(
      negative ? rejectedSampleTargets(sample) : reusablePositiveTargets,
      registry,
    ).filter(memoryTargetAllowed);
    const correctionAllowed = decision === "insufficient"
      || contextualHistoricalCorrectionAllowed(inference.signals, sample.signals, similarity);
    const removedTargets = registeredRagTargets(
      correctionAllowed ? rejectedSampleTargets(sample) : [],
      registry,
    )
      .filter(memoryTargetAllowed);
    if (!targets.length && !removedTargets.length) continue;
    const qualityNumber = Number(sample?.feedback?.score
      ?? sample?.feedback?.rating
      ?? sample?.score
      ?? sample?.rating);
    const removalOnly = decision === "corrected" && !targets.length && removedTargets.length > 0;
    memories.push({
      id: stringValue(sample.id || sample.sourceRunId || `sample-${index + 1}`, 500),
      source,
      kind: negative || removalOnly ? "negative" : "positive",
      decision: decision || (sample.source === "actual_execution" ? "actual_execution" : "learned"),
      trust: negative || removalOnly
        ? "reviewed_negative"
        : source === "actual_execution"
          ? "observed"
          : source === "legacy_config_memory"
            ? "legacy"
            : "reviewed",
      similarity: Number(similarity.toFixed(3)),
      quality: Number.isFinite(qualityNumber) ? Math.max(1, Math.min(5, qualityNumber)) : null,
      sourceGroups: ragSampleSourceGroups(inference.signals, sample.signals),
      targets: targets.slice(0, 4),
      removedTargets: removedTargets.slice(0, 4),
      updatedAt: Number(sample.updatedAt || sample.createdAt || 0) || 0,
    });
  }

  // A reviewed correction that removes one target must also prevent an older positive
  // memory from presenting that same target as current RAG truth. A later explicit
  // positive (when both sides have timestamps) may reintroduce it.
  const removalsByIdentity = new Map();
  for (const memory of memories) {
    for (const target of memory.removedTargets || []) {
      const identity = targetIdentity(target);
      const rows = removalsByIdentity.get(identity) || [];
      rows.push({ memoryId: memory.id, updatedAt: memory.updatedAt });
      removalsByIdentity.set(identity, rows);
    }
  }
  for (const memory of memories) {
    memory.targets = (memory.targets || []).filter((target) => {
      const removals = removalsByIdentity.get(targetIdentity(target)) || [];
      return !removals.some((removal) => (
        !memory.updatedAt || !removal.updatedAt || removal.updatedAt >= memory.updatedAt
      ));
    });
  }
  for (let index = memories.length - 1; index >= 0; index--) {
    if (!(memories[index].targets || []).length && !(memories[index].removedTargets || []).length) memories.splice(index, 1);
  }

  memories.sort((left, right) => right.similarity - left.similarity
    || Number(right.quality || 0) - Number(left.quality || 0)
    || right.updatedAt - left.updatedAt
    || left.id.localeCompare(right.id));

  const matchedDimensions = {};
  for (const dimension of CONFIG_INFERENCE_DIMENSIONS) {
    const values = uniqueStrings((inference.signals?.matches || [])
      .filter((match) => match.category === dimension)
      .map((match) => match.value));
    if (values.length) matchedDimensions[dimension] = values;
  }

  return {
    schemaVersion: CONFIG_INFERENCE_RAG_VERSION,
    projectId: stringValue(projectId, 500),
    query: {
      ticketId: ticket.tbTaskId || ticket.ticketId,
      sourceGroups: CONFIG_INFERENCE_SOURCE_GROUPS.filter((group) => (inference.signals?.sources?.[group] || []).length),
      matchedDimensions,
      sourceCoverage: ticket.sourceCoverage || null,
      sourceQuality: inference.quality?.source || null,
    },
    inference: {
      status: inference.status,
      confidenceScore: inference.confidenceScore,
      heuristicConfidence: inference.heuristicConfidence,
      calibratedProbability: inference.calibratedProbability,
      confidenceMetadata: inference.confidenceMetadata,
      targets: (inference.targets || []).map(ragTarget),
      missingInformation: [...(inference.missingInformation || [])],
      policy: {
        abstain: inference.policy?.abstain === true,
        abstainReasons: [...(inference.policy?.abstainReasons || [])],
      },
    },
    memories: memories.slice(0, maxItems),
    quality: {
      ...(inference.quality || {}),
      servingSamples: serving.stats,
    },
    versions: inference.versions,
    stale: inference.stale === true,
    structuredEvidenceSummary: inference.structuredEvidenceSummary,
    policy: {
      providerNeutral: true,
      projectScoped: true,
      registryConstrained: true,
      reviewedOrObservedMemory: true,
      reviewedOrVerifiedMemory: true,
      approvedActiveOrVerifiedMemory: true,
      legacyMemoryCompatibility: true,
      readOnlyRetrieval: true,
      rawHistoricalPromptExcluded: true,
      repositoryOnlyTargets: true,
      dependencyAware: true,
      currentVariantConstrained: true,
      noDefaultVariantFallback: true,
      conflictingHistoryExcluded: true,
      reviewedRemovalPrecedence: true,
      applicationRepositoryContextSharedWithInference: true,
      staleRegistryReported: true,
    },
  };
}
