import { readFileSync } from "fs";

const DEFAULT_POLICY_PATH = new URL("./default-sync-policy.json", import.meta.url);

export const DEFAULT_SYNC_POLICY_CONFIG = deepFreeze(JSON.parse(readFileSync(DEFAULT_POLICY_PATH, "utf8")));
export const DEFAULT_SYNC_ROUTING = DEFAULT_SYNC_POLICY_CONFIG.routing;
export const LEGACY_TEAMBITION_DEFAULTS = DEFAULT_SYNC_POLICY_CONFIG.legacyTeambition;
export const DEFAULT_FEISHU_PRIORITY_MAPPING = DEFAULT_SYNC_POLICY_CONFIG.priorityMapping;

export const SYNC_POLICY_FIELD_DEFINITIONS = Object.freeze({
  title: { label: "标题", defaultMode: "overwrite", modes: ["overwrite", "preserve"] },
  description: { label: "描述", defaultMode: "overwrite", modes: ["overwrite", "preserve"] },
  attachments: { label: "附件", defaultMode: "upload", modes: ["upload", "comment_link", "skip"] },
  comments: { label: "评论", defaultMode: "append", modes: ["append", "skip"] },
  status: { label: "状态", defaultMode: "mapped", modes: ["mapped", "preserve"] },
  tags: { label: "标签", defaultMode: "merge", modes: ["merge", "replace", "preserve"] },
  priority: { label: "优先级", defaultMode: "mapped", modes: ["mapped", "preserve"] },
  assignee: { label: "负责人", defaultMode: "mapped", modes: ["mapped", "preserve"] },
  fieldMappings: { label: "字段映射", defaultMode: "mapped", modes: ["mapped", "preserve"] },
});

const CONDITION_OPERATORS = new Set([
  "equals",
  "notEquals",
  "contains",
  "notContains",
  "containsAny",
  "notContainsAny",
  "in",
  "notIn",
  "exists",
  "empty",
  "regex",
]);

export function normalizeSyncPolicyConfig(config = {}, defaults = DEFAULT_SYNC_ROUTING) {
  const configured = plainObject(config?.routing) ? config.routing : {};
  const legacyStrategy = legacyStrategyFromConfig(config);
  const targets = mergeEntriesById(defaults?.targets, configured.targets)
    .map((target, index) => normalizeTarget(target, index))
    .filter(Boolean);
  const strategies = mergeEntriesById(defaults?.strategies, configured.strategies)
    .map((strategy, index) => normalizeStrategy(strategy, index, legacyStrategy))
    .filter(Boolean);
  const rules = mergeEntriesById(defaults?.rules, configured.rules)
    .map((rule, index) => normalizeRule(rule, index))
    .filter(Boolean);

  ensureEntry(targets, normalizeTarget({
    id: "legacy-default",
    name: "当前默认目标",
    system: "teambition",
    enabled: true,
    inheritLegacy: true,
    config: {},
  }, targets.length));
  ensureEntry(strategies, normalizeStrategy(legacyStrategy, strategies.length, legacyStrategy));

  return {
    version: positiveInteger(configured.version || defaults?.version, 1),
    enabled: configured.enabled !== false,
    matchMode: configured.matchMode === "all" ? "all" : "first",
    defaultTargetId: text(configured.defaultTargetId || defaults?.defaultTargetId || "legacy-default"),
    defaultStrategyId: text(configured.defaultStrategyId || defaults?.defaultStrategyId || "legacy-default"),
    targets,
    strategies,
    rules,
  };
}

export function validateSyncPolicyConfig(config = {}) {
  const routing = normalizeSyncPolicyConfig(config);
  const errors = [];
  const warnings = [];
  validateUniqueIds(config?.routing?.targets, "target", errors);
  validateUniqueIds(config?.routing?.strategies, "strategy", errors);
  validateUniqueIds(config?.routing?.rules, "rule", errors);
  validateUniqueIds(routing.targets, "target", errors);
  validateUniqueIds(routing.strategies, "strategy", errors);
  validateUniqueIds(routing.rules, "rule", errors);
  const targets = new Map(routing.targets.map((entry) => [entry.id, entry]));
  const strategies = new Map(routing.strategies.map((entry) => [entry.id, entry]));
  if (!targets.has(routing.defaultTargetId)) errors.push(issue("routing.defaultTargetId", "默认目标不存在"));
  else if (targets.get(routing.defaultTargetId)?.enabled === false) errors.push(issue("routing.defaultTargetId", "默认目标已停用"));
  if (!strategies.has(routing.defaultStrategyId)) errors.push(issue("routing.defaultStrategyId", "默认策略不存在"));
  else if (strategies.get(routing.defaultStrategyId)?.enabled === false) errors.push(issue("routing.defaultStrategyId", "默认策略已停用"));

  for (const target of routing.targets) {
    if (!target.id) errors.push(issue("routing.targets", "目标档案 ID 不能为空"));
    if (!target.system) errors.push(issue(`routing.targets.${target.id || "unknown"}.system`, "目标系统不能为空"));
    if (target.enabled && target.system === "teambition") {
      const effective = target.inheritLegacy
        ? { ...(config.teambition || {}), ...(target.config || {}) }
        : target.config || {};
      for (const key of ["projectId", "tasklistId", "sprintId"]) {
        if (!text(effective[key])) {
          const problem = issue(`routing.targets.${target.id}.config.${key}`, `TB 目标缺少 ${key}`);
          if (target.id === "legacy-default") warnings.push(problem);
          else errors.push(problem);
        }
      }
    }
  }
  for (const strategy of routing.strategies) {
    if (!strategy.id) errors.push(issue("routing.strategies", "策略 ID 不能为空"));
    for (const [field, definition] of Object.entries(SYNC_POLICY_FIELD_DEFINITIONS)) {
      const policy = strategy.fields[field];
      if (!definition.modes.includes(policy.mode)) {
        errors.push(issue(`routing.strategies.${strategy.id}.fields.${field}.mode`, `${definition.label}同步方式无效`));
      }
    }
    if (strategy.fields.title.enabled === false) {
      warnings.push(issue(`routing.strategies.${strategy.id}.fields.title.enabled`, "TB 创建任务仍会保留必填标题；关闭标题仅影响更新"));
    }
  }
  for (const rule of routing.rules) {
    if (!rule.id) errors.push(issue("routing.rules", "规则 ID 不能为空"));
    if (rule.targetId && !targets.has(rule.targetId)) errors.push(issue(`routing.rules.${rule.id}.targetId`, "规则引用的目标不存在"));
    else if (rule.targetId && targets.get(rule.targetId)?.enabled === false) errors.push(issue(`routing.rules.${rule.id}.targetId`, "规则引用的目标已停用"));
    if (rule.strategyId && !strategies.has(rule.strategyId)) errors.push(issue(`routing.rules.${rule.id}.strategyId`, "规则引用的策略不存在"));
    else if (rule.strategyId && strategies.get(rule.strategyId)?.enabled === false) errors.push(issue(`routing.rules.${rule.id}.strategyId`, "规则引用的策略已停用"));
    if (!rule.conditions.length) warnings.push(issue(`routing.rules.${rule.id}.conditions`, "规则没有条件，将命中所有工单"));
    rule.conditions.forEach((condition, index) => {
      if (!condition.field) errors.push(issue(`routing.rules.${rule.id}.conditions.${index}.field`, "条件字段不能为空"));
      if (!CONDITION_OPERATORS.has(condition.operator)) errors.push(issue(`routing.rules.${rule.id}.conditions.${index}.operator`, "条件运算符无效"));
      if (condition.operator === "regex") {
        try {
          new RegExp(condition.values[0] || "", condition.caseSensitive ? "" : "i");
        } catch {
          errors.push(issue(`routing.rules.${rule.id}.conditions.${index}.values`, "正则表达式无效"));
        }
      }
    });
  }
  return { valid: errors.length === 0, errors, warnings, routing };
}

export function assertValidSyncPolicyConfig(config = {}) {
  const validation = validateSyncPolicyConfig(config);
  if (validation.valid) return validation.routing;
  const error = new Error(`同步路由策略无效：${validation.errors[0].message}`);
  error.statusCode = 400;
  error.policyValidation = {
    errors: validation.errors,
    warnings: validation.warnings,
  };
  throw error;
}

export function resolveSyncPolicy({ config = {}, source = {}, item = {}, raw = null } = {}) {
  const routing = normalizeSyncPolicyConfig(config);
  const targetById = new Map(routing.targets.map((entry) => [entry.id, entry]));
  const strategyById = new Map(routing.strategies.map((entry) => [entry.id, entry]));
  const context = {
    source: {
      system: text(source.system || item.sourceSystem || ""),
      projectKey: text(source.projectKey || item.sourceProjectKey || ""),
      typeKey: text(source.typeKey || item.sourceWorkItemTypeKey || ""),
      viewId: text(source.viewId || item.sourceViewId || item._feishuSourceView?.viewId || ""),
    },
    item,
    raw: raw || item.raw || {},
  };
  const orderedRules = routing.rules
    .map((rule, index) => ({ rule, index }))
    .filter(({ rule }) => routing.enabled && rule.enabled !== false)
    .sort((left, right) => right.rule.priority - left.rule.priority || left.index - right.index);
  const trace = [];
  let matchedRule = null;
  for (const { rule } of orderedRules) {
    const result = evaluateRule(rule, context);
    trace.push({
      ruleId: rule.id,
      ruleName: rule.name,
      priority: rule.priority,
      matched: result.matched,
      conditions: result.conditions,
    });
    if (result.matched && !matchedRule) {
      matchedRule = rule;
      if (routing.matchMode === "first") break;
    }
  }

  const targetId = text(matchedRule?.targetId || routing.defaultTargetId);
  const strategyId = text(matchedRule?.strategyId || routing.defaultStrategyId);
  const target = targetById.get(targetId) || targetById.get(routing.defaultTargetId) || routing.targets[0];
  const strategy = strategyById.get(strategyId) || strategyById.get(routing.defaultStrategyId) || routing.strategies[0];
  const legacyTarget = plainObject(config.teambition) ? config.teambition : {};
  const effectiveTargetConfig = target?.inheritLegacy === false
    ? clone(target?.config || {})
    : { ...clone(legacyTarget), ...clone(target?.config || {}) };

  return {
    version: routing.version,
    enabled: routing.enabled,
    matched: !!matchedRule,
    matchedRule: matchedRule ? publicRule(matchedRule) : null,
    target: target ? { ...clone(target), config: effectiveTargetConfig } : null,
    strategy: strategy ? clone(strategy) : null,
    trace,
    fallback: !matchedRule,
  };
}

export function applyResolvedSyncPolicy(config = {}, decision = {}) {
  const next = clone(config);
  const target = decision?.target;
  const strategy = decision?.strategy;
  if (target?.config) next.teambition = { ...(next.teambition || {}), ...clone(target.config) };
  next.sync = { ...(next.sync || {}) };
  const fields = strategy?.fields || {};
  if (fields.comments) next.sync.includeComments = fields.comments.enabled !== false && fields.comments.mode !== "skip";
  if (fields.attachments) {
    next.sync.includeAttachments = fields.attachments.enabled !== false && fields.attachments.mode !== "skip";
    if (["upload", "comment_link", "skip"].includes(fields.attachments.mode)) next.sync.attachmentMode = fields.attachments.mode;
  }
  if (text(strategy?.titleTemplate)) next.teambition.titleTemplate = text(strategy.titleTemplate);
  next._resolvedSyncPolicy = publicDecision(decision);
  return next;
}

export function applySyncPayloadStrategy(payload = {}, action = "create", decision = {}) {
  const result = { ...payload };
  const fields = decision?.strategy?.fields || {};
  const effects = [];
  const omit = (field, payloadKeys, { requiredOnCreate = false } = {}) => {
    const policy = fields[field] || {};
    const disabled = policy.enabled === false || ["skip", "preserve"].includes(policy.mode);
    if (!disabled) {
      effects.push({ field, enabled: true, mode: policy.mode || "sync", action: "sync" });
      return;
    }
    if (action === "create" && requiredOnCreate) {
      effects.push({ field, enabled: false, mode: policy.mode || "preserve", action: "required-on-create" });
      return;
    }
    for (const key of payloadKeys) delete result[key];
    effects.push({ field, enabled: false, mode: policy.mode || "preserve", action: "omit" });
  };
  omit("title", ["content"], { requiredOnCreate: true });
  omit("description", ["note"]);
  omit("status", ["taskflowstatusId"]);
  omit("tags", ["tagIds"]);
  omit("priority", ["priority"]);
  omit("assignee", ["executorId"]);
  omit("fieldMappings", ["customfields"]);
  return { payload: result, effects };
}

export function publicDecision(decision = {}) {
  return {
    version: decision.version || 1,
    matched: !!decision.matched,
    fallback: !!decision.fallback,
    matchedRule: decision.matchedRule ? publicRule(decision.matchedRule) : null,
    target: decision.target ? {
      id: decision.target.id,
      name: decision.target.name,
      system: decision.target.system,
      config: clone(decision.target.config || {}),
    } : null,
    strategy: decision.strategy ? {
      id: decision.strategy.id,
      name: decision.strategy.name,
      fields: clone(decision.strategy.fields || {}),
      titleTemplate: decision.strategy.titleTemplate || "",
    } : null,
    trace: clone(decision.trace || []),
  };
}

function evaluateRule(rule, context) {
  if (rule.sourceSystem && normalized(rule.sourceSystem) !== normalized(context.source.system)) {
    return {
      matched: false,
      conditions: [{ field: "source.system", operator: "equals", expected: [rule.sourceSystem], actual: [context.source.system], matched: false }],
    };
  }
  const conditions = rule.conditions.map((condition) => evaluateCondition(condition, context));
  const matched = !conditions.length
    ? true
    : rule.match === "any"
      ? conditions.some((condition) => condition.matched)
      : conditions.every((condition) => condition.matched);
  return { matched, conditions };
}

function evaluateCondition(condition, context) {
  const actual = selectorValues(context, condition);
  const expected = condition.values;
  const actualComparable = actual.map((value) => comparable(value, condition.caseSensitive));
  const expectedComparable = expected.map((value) => comparable(value, condition.caseSensitive));
  const has = actualComparable.some((value) => value !== "");
  let matched = false;
  switch (condition.operator) {
    case "exists": matched = has; break;
    case "empty": matched = !has; break;
    case "equals": matched = actualComparable.some((value) => expectedComparable.includes(value)); break;
    case "notEquals": matched = !actualComparable.some((value) => expectedComparable.includes(value)); break;
    case "contains": matched = actualComparable.some((value) => expectedComparable.some((needle) => value.includes(needle))); break;
    case "notContains": matched = !actualComparable.some((value) => expectedComparable.some((needle) => value.includes(needle))); break;
    case "containsAny": matched = expectedComparable.some((needle) => actualComparable.some((value) => value.includes(needle))); break;
    case "notContainsAny": matched = !expectedComparable.some((needle) => actualComparable.some((value) => value.includes(needle))); break;
    case "in": matched = actualComparable.some((value) => expectedComparable.includes(value)); break;
    case "notIn": matched = !actualComparable.some((value) => expectedComparable.includes(value)); break;
    case "regex": {
      try {
        const regex = new RegExp(condition.values[0] || "", condition.caseSensitive ? "" : "i");
        matched = actual.some((value) => regex.test(String(value ?? "")));
      } catch {
        matched = false;
      }
      break;
    }
    default: matched = false;
  }
  return {
    field: condition.field,
    operator: condition.operator,
    expected: clone(condition.values),
    fieldNames: clone(condition.fieldNames),
    fieldKeys: clone(condition.fieldKeys),
    caseSensitive: condition.caseSensitive === true,
    actual: actual.slice(0, 12),
    matched,
  };
}

function selectorValues(context, condition) {
  const selector = text(condition.field);
  if (selector === "fields" || selector.startsWith("fields.")) {
    const explicit = selector.startsWith("fields.") ? selector.slice("fields.".length) : "";
    const keys = new Set([explicit, ...condition.fieldKeys].map(normalized).filter(Boolean));
    const names = new Set(condition.fieldNames.map(normalized).filter(Boolean));
    const rows = Array.isArray(context.item?.fields) ? context.item.fields : [];
    return rows
      .filter((field) => {
        if (!keys.size && !names.size) return true;
        const fieldKeys = [field?.key, field?.field_key, field?.metadata?.key].map(normalized).filter(Boolean);
        const fieldNames = [field?.name, field?.field_name, field?.metadata?.name].map(normalized).filter(Boolean);
        return fieldKeys.some((key) => keys.has(key)) || fieldNames.some((name) => names.has(name));
      })
      .flatMap((field) => flattenValues(field?.displayValue ?? field?.value));
  }
  return flattenValues(readPath(context, selector));
}

function normalizeTarget(value = {}, index = 0) {
  if (!plainObject(value)) return null;
  const id = text(value.id || value.name || `target-${index + 1}`);
  return {
    id,
    name: text(value.name || id),
    system: text(value.system || value.targetSystem || "teambition"),
    enabled: value.enabled !== false,
    inheritLegacy: value.inheritLegacy !== false,
    builtin: value.builtin === true,
    config: clone(plainObject(value.config) ? value.config : value.target || {}),
  };
}

function normalizeStrategy(value = {}, index = 0, legacyStrategy = {}) {
  if (!plainObject(value)) return null;
  const id = text(value.id || value.name || `strategy-${index + 1}`);
  const inheritedFields = value.inheritLegacy === false ? {} : legacyStrategy.fields || {};
  const fields = {};
  for (const [key, definition] of Object.entries(SYNC_POLICY_FIELD_DEFINITIONS)) {
    const raw = value.fields?.[key];
    const inherited = inheritedFields[key] || {};
    const configured = plainObject(raw) ? raw : raw === false ? { enabled: false } : {};
    fields[key] = {
      enabled: configured.enabled ?? inherited.enabled ?? true,
      mode: text(configured.mode || inherited.mode || definition.defaultMode),
    };
  }
  return {
    id,
    name: text(value.name || id),
    enabled: value.enabled !== false,
    inheritLegacy: value.inheritLegacy !== false,
    builtin: value.builtin === true,
    titleTemplate: text(value.titleTemplate || ""),
    fields,
  };
}

function normalizeRule(value = {}, index = 0) {
  if (!plainObject(value)) return null;
  const id = text(value.id || value.name || `rule-${index + 1}`);
  const rawConditions = Array.isArray(value.conditions) ? value.conditions : [];
  return {
    id,
    name: text(value.name || id),
    enabled: value.enabled !== false,
    builtin: value.builtin === true,
    priority: finiteNumber(value.priority, 0),
    sourceSystem: text(value.sourceSystem || ""),
    match: value.match === "any" ? "any" : "all",
    conditions: rawConditions.map(normalizeCondition).filter(Boolean),
    targetId: text(value.targetId || ""),
    strategyId: text(value.strategyId || ""),
  };
}

function normalizeCondition(value = {}) {
  if (!plainObject(value)) return null;
  return {
    field: text(value.field || value.path || ""),
    operator: text(value.operator || "equals"),
    values: normalizeList(value.values ?? value.value),
    fieldKeys: normalizeList(value.fieldKeys || value.fieldKey),
    fieldNames: normalizeList(value.fieldNames || value.fieldName),
    caseSensitive: value.caseSensitive === true,
  };
}

function legacyStrategyFromConfig(config = {}) {
  const sync = config.sync || {};
  return {
    id: "legacy-default",
    name: "兼容旧版全量同步",
    enabled: true,
    inheritLegacy: false,
    fields: {
      title: { enabled: true, mode: "overwrite" },
      description: { enabled: true, mode: "overwrite" },
      attachments: { enabled: sync.includeAttachments !== false, mode: text(sync.attachmentMode || "upload") },
      comments: { enabled: sync.includeComments !== false, mode: "append" },
      status: { enabled: true, mode: "mapped" },
      // The pre-policy adapter replaced the task tag set; keep that behavior in
      // the compatibility strategy. New strategies may opt into true merging.
      tags: { enabled: true, mode: "replace" },
      priority: { enabled: true, mode: "mapped" },
      assignee: { enabled: true, mode: "mapped" },
      fieldMappings: { enabled: true, mode: "mapped" },
    },
  };
}

function mergeEntriesById(defaults = [], configured = []) {
  const out = [];
  const index = new Map();
  for (const raw of [...(Array.isArray(defaults) ? defaults : []), ...(Array.isArray(configured) ? configured : [])]) {
    if (!plainObject(raw)) continue;
    const id = text(raw.id || raw.name);
    if (!id || !index.has(id)) {
      index.set(id, out.length);
      out.push(clone(raw));
      continue;
    }
    const position = index.get(id);
    out[position] = mergePlain(out[position], raw);
  }
  return out;
}

function ensureEntry(entries, entry) {
  if (entry && !entries.some((candidate) => candidate.id === entry.id)) entries.unshift(entry);
}

function validateUniqueIds(entries, kind, errors) {
  if (!Array.isArray(entries)) return;
  const seen = new Set();
  for (const entry of entries) {
    if (!plainObject(entry)) continue;
    const id = text(entry.id || entry.name);
    if (!id) continue;
    if (seen.has(id)) errors.push(issue(`routing.${kind}s.${id}`, `${kind} ID 重复`));
    seen.add(id);
  }
}

function publicRule(rule = {}) {
  return {
    id: rule.id,
    name: rule.name,
    priority: rule.priority,
    sourceSystem: rule.sourceSystem,
    targetId: rule.targetId,
    strategyId: rule.strategyId,
  };
}

function issue(path, message) {
  return { path, message };
}

function readPath(root, path) {
  if (!path) return undefined;
  return path.split(".").reduce((value, key) => value == null ? undefined : value[key], root);
}

function flattenValues(value, depth = 0) {
  if (value === null || value === undefined || depth > 5) return [];
  if (Array.isArray(value)) return value.flatMap((entry) => flattenValues(entry, depth + 1));
  if (plainObject(value)) {
    for (const key of ["displayValue", "display_value", "label", "name", "title", "text", "value"]) {
      if (value[key] !== undefined && value[key] !== value) {
        const nested = flattenValues(value[key], depth + 1);
        if (nested.length) return nested;
      }
    }
    return Object.values(value).flatMap((entry) => flattenValues(entry, depth + 1));
  }
  return [String(value)];
}

function normalizeList(value) {
  if (Array.isArray(value)) return value.flatMap((entry) => normalizeList(entry));
  if (value === null || value === undefined || value === "") return [];
  return [String(value).trim()].filter(Boolean);
}

function mergePlain(base, override) {
  const out = clone(base);
  for (const [key, value] of Object.entries(override || {})) {
    out[key] = plainObject(value) && plainObject(out[key]) ? mergePlain(out[key], value) : clone(value);
  }
  return out;
}

function comparable(value, caseSensitive) {
  const raw = String(value ?? "").trim();
  return caseSensitive ? raw : raw.toLocaleLowerCase();
}

function normalized(value) {
  return String(value ?? "").trim().toLocaleLowerCase().replace(/[\s_\-./\\()[\]{}:：]+/g, "");
}

function positiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : fallback;
}

function finiteNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function text(value) {
  return String(value ?? "").trim();
}

function plainObject(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function clone(value) {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value));
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  Object.values(value).forEach(deepFreeze);
  return value;
}
