export const TB_PRIORITY_DISPLAY_NAMES = Object.freeze({
  "-10": "较低",
  0: "普通",
  1: "紧急",
  2: "非常紧急",
});

export function priorityMappingForUi(config = {}) {
  const mapping = config?.mappings?.priority && typeof config.mappings.priority === "object"
    ? config.mappings.priority
    : {};
  return ["P0", "P1", "P2", "P3"].map((source) => {
    const raw = mapping[source];
    const target = raw === "" || raw === null || raw === undefined ? null : Number(raw);
    return {
      source,
      target: Number.isFinite(target) ? target : null,
      label: Number.isFinite(target) ? TB_PRIORITY_DISPLAY_NAMES[String(target)] || String(target) : "未配置",
    };
  });
}

export const POLICY_FIELD_DEFINITIONS = Object.freeze([
  { key: "title", label: "标题", modes: [["overwrite", "覆盖更新"], ["preserve", "保留已有"]] },
  { key: "description", label: "描述", modes: [["overwrite", "覆盖更新"], ["preserve", "保留已有"]] },
  { key: "attachments", label: "附件", modes: [["upload", "上传附件"], ["comment_link", "评论链接"], ["skip", "不同步"]] },
  { key: "comments", label: "评论", modes: [["append", "追加同步"], ["skip", "不同步"]] },
  { key: "status", label: "状态", modes: [["mapped", "按映射同步"], ["preserve", "保留已有"]] },
  { key: "tags", label: "标签", modes: [["merge", "合并标签"], ["replace", "覆盖标签"], ["preserve", "保留已有"]] },
  { key: "priority", label: "优先级", modes: [["mapped", "按映射同步"], ["preserve", "保留已有"]] },
  { key: "assignee", label: "负责人", modes: [["mapped", "按映射同步"], ["preserve", "保留已有"]] },
  { key: "fieldMappings", label: "字段映射", modes: [["mapped", "按映射同步"], ["preserve", "保留已有"]] },
]);

export const POLICY_CONDITION_FIELDS = Object.freeze([
  ["source.projectKey", "来源 Project"],
  ["source.typeKey", "工单类型"],
  ["source.viewId", "来源视图"],
  ["item.title", "标题"],
  ["item.description", "描述"],
  ["item.status", "状态"],
  ["item.priority", "优先级"],
  ["item.assignees", "负责人"],
  ["fields", "自定义字段"],
]);

export const POLICY_OPERATORS = Object.freeze([
  ["equals", "等于"],
  ["notEquals", "不等于"],
  ["containsAny", "包含任一"],
  ["notContainsAny", "不包含任一"],
  ["contains", "包含"],
  ["notContains", "不包含"],
  ["in", "属于集合"],
  ["notIn", "不属于集合"],
  ["exists", "有值"],
  ["empty", "为空"],
  ["regex", "正则匹配"],
]);

const POLICY_CONDITION_FIELD_LABELS = Object.freeze(Object.fromEntries(POLICY_CONDITION_FIELDS));
const POLICY_OPERATOR_LABELS = Object.freeze(Object.fromEntries(POLICY_OPERATORS));

export function policyEntityDisplayName(entry = null, fallback = "未命名") {
  const name = String(entry?.name || "").trim();
  const id = String(entry?.id || "").trim();
  return name && name !== id ? name : fallback;
}

export function policyConditionSummary(condition = {}) {
  const field = String(condition.field || "").trim();
  const customNames = Array.isArray(condition.fieldNames)
    ? condition.fieldNames.map((value) => String(value || "").trim()).filter(Boolean)
    : [];
  const fieldLabel = field === "fields"
    ? customNames.join(" / ") || "自定义字段"
    : POLICY_CONDITION_FIELD_LABELS[field] || field || "未指定字段";
  const operator = String(condition.operator || "equals");
  const values = (Array.isArray(condition.values) ? condition.values : [condition.value])
    .map((value) => String(value ?? "").trim())
    .filter(Boolean);
  const quoted = values.map((value) => `“${value}”`).join("、") || "指定值";
  let predicate = `${POLICY_OPERATOR_LABELS[operator] || operator} ${quoted}`;
  if (operator === "regex" && values.length === 1) {
    const prefix = values[0].match(/^\^([A-Za-z0-9._-]+)$/)?.[1];
    if (prefix) predicate = `以“${prefix}”开头`;
  }
  if (operator === "exists" || operator === "empty") {
    predicate = POLICY_OPERATOR_LABELS[operator] || operator;
  }
  const caseNote = condition.caseSensitive === true ? "区分大小写" : "不区分大小写";
  return `${fieldLabel}${predicate}（${caseNote}）`;
}

export function policyRuleSummary(rule = {}, routing = {}) {
  const target = (routing.targets || []).find((entry) => entry.id === rule.targetId) || null;
  const strategy = (routing.strategies || []).find((entry) => entry.id === rule.strategyId) || null;
  const joiner = rule.match === "any" ? " 或 " : " 且 ";
  const conditions = (Array.isArray(rule.conditions) ? rule.conditions : []).map(policyConditionSummary);
  return {
    name: policyEntityDisplayName(rule, "未命名规则"),
    conditionText: conditions.join(joiner) || "无条件（匹配所有工单）",
    targetName: policyEntityDisplayName(target, "未命名目标档案"),
    strategyName: policyEntityDisplayName(strategy, "未命名同步策略"),
  };
}

export function policyTargetSummary(target = {}, legacyTeambition = {}) {
  const effective = target.inheritLegacy === false
    ? (target.config || {})
    : { ...(legacyTeambition || {}), ...(target.config || {}) };
  return {
    projectName: String(effective.projectPathName || effective.projectName || "").trim() || "项目名称未解析",
    tasklistName: String(effective.tasklistName || "").trim() || "任务列表名称未解析",
    sprintName: String(effective.sprintName || "").trim() || "迭代名称未解析",
    executorName: String(effective.defaultExecutorName || effective.executorName || "").trim() || "负责人姓名未解析",
  };
}

export function policyRoutingForUi(config = {}) {
  const routing = config?.routing && typeof config.routing === "object" && !Array.isArray(config.routing)
    ? config.routing
    : {};
  return {
    version: Number(routing.version) || 1,
    enabled: routing.enabled !== false,
    matchMode: routing.matchMode === "all" ? "all" : "first",
    defaultTargetId: String(routing.defaultTargetId || "legacy-default"),
    defaultStrategyId: String(routing.defaultStrategyId || "legacy-default"),
    targets: Array.isArray(routing.targets) ? routing.targets : [],
    strategies: Array.isArray(routing.strategies) ? routing.strategies : [],
    rules: Array.isArray(routing.rules) ? routing.rules : [],
  };
}

export function policyRulesByPriority(rules = []) {
  return (Array.isArray(rules) ? rules : [])
    .map((rule, index) => ({ rule, index }))
    .sort((left, right) => Number(right.rule?.priority || 0) - Number(left.rule?.priority || 0) || left.index - right.index);
}

export function createPolicyTarget(now = Date.now()) {
  return {
    id: `target-${now}`,
    name: "新 TB 目标",
    system: "teambition",
    enabled: true,
    inheritLegacy: true,
    config: {},
  };
}

export function createPolicyStrategy(now = Date.now()) {
  return {
    id: `strategy-${now}`,
    name: "新同步策略",
    enabled: true,
    inheritLegacy: true,
    titleTemplate: "",
    fields: Object.fromEntries(POLICY_FIELD_DEFINITIONS.map((field) => [field.key, {
      enabled: true,
      mode: field.modes[0][0],
    }])),
  };
}

export function createPolicyCondition() {
  return {
    field: "source.projectKey",
    operator: "equals",
    values: [],
    fieldKeys: [],
    fieldNames: [],
    caseSensitive: false,
  };
}

export function createPolicyRule(routing = {}, now = Date.now()) {
  return {
    id: `rule-${now}`,
    name: "新路由规则",
    enabled: true,
    priority: 10,
    sourceSystem: "feishu_project",
    match: "all",
    conditions: [createPolicyCondition()],
    targetId: routing.defaultTargetId || routing.targets?.[0]?.id || "legacy-default",
    strategyId: routing.defaultStrategyId || routing.strategies?.[0]?.id || "legacy-default",
  };
}

export function updatePolicyEntry(entries = [], index, patch = {}) {
  return (Array.isArray(entries) ? entries : []).map((entry, current) => (
    current === index ? { ...entry, ...patch } : entry
  ));
}

export function updatePolicyEntryConfig(entries = [], index, patch = {}) {
  return updatePolicyEntry(entries, index, {
    config: { ...(entries[index]?.config || {}), ...patch },
  });
}

export function policyPreviewSample(rule = null) {
  const sample = {
    id: rule?.id ? `preview-${rule.id}` : "preview-default",
    space_key: "intelligentspace",
    work_item_type_key: "bug",
    title: rule ? `规则预览：${rule.name || rule.id || "自定义规则"}` : "默认路由预览工单",
    description: "用于预览规则命中，不会创建或更新 TB 任务。",
    priority: "P1",
    fields: [],
  };
  if (!rule || typeof rule !== "object") return sample;
  for (const condition of Array.isArray(rule.conditions) ? rule.conditions : []) {
    applyConditionToPreviewSample(sample, condition);
  }
  return sample;
}

function applyConditionToPreviewSample(sample, condition = {}) {
  const operator = String(condition.operator || "equals");
  const expected = Array.isArray(condition.values) ? condition.values : [condition.value];
  const positiveValue = expected.find((value) => value !== undefined && value !== null && String(value).trim()) ?? "预览值";
  const value = operator === "empty"
    ? ""
    : operator === "regex"
      ? regexPreviewValue(positiveValue)
      : ["notEquals", "notContains", "notContainsAny", "notIn"].includes(operator)
        ? negativePreviewValue(expected)
        : positiveValue;
  switch (String(condition.field || "")) {
    case "source.projectKey":
      sample.space_key = value;
      break;
    case "source.typeKey":
      sample.work_item_type_key = value;
      break;
    case "source.viewId":
      sample._feishuSourceView = { ...(sample._feishuSourceView || {}), viewId: value };
      break;
    case "item.title":
      sample.title = value;
      break;
    case "item.description":
      sample.description = value;
      break;
    case "item.status":
      sample.status = value;
      break;
    case "item.priority":
      sample.priority = value;
      break;
    case "item.assignees":
      sample.assignees = [{ name: value }];
      break;
    default:
      if (String(condition.field || "") === "fields" || String(condition.field || "").startsWith("fields.")) {
        sample.fields.push({
          field_key: condition.fieldKeys?.[0] || String(condition.field || "").slice("fields.".length) || "preview_field",
          field_name: condition.fieldNames?.[0] || "预览字段",
          field_value: value,
        });
      }
  }
}

function negativePreviewValue(expected = []) {
  const normalized = new Set(expected.map((value) => String(value ?? "").trim().toLocaleLowerCase()).filter(Boolean));
  let candidate = "其他值";
  while ([...normalized].some((value) => candidate.toLocaleLowerCase().includes(value) || value.includes(candidate.toLocaleLowerCase()))) {
    candidate = `非匹配-${candidate}`;
  }
  return candidate;
}

function regexPreviewValue(pattern = "") {
  const prefix = String(pattern || "").match(/^\^([A-Za-z0-9._-]+)/)?.[1] || "";
  return prefix ? `${prefix}${prefix.endsWith("-") ? "1001 " : ""}预览值` : "预览值";
}

export function policySummary(config = {}) {
  const routing = policyRoutingForUi(config);
  return {
    enabledRules: routing.rules.filter((rule) => rule.enabled !== false).length,
    targets: routing.targets.filter((target) => target.enabled !== false).length,
    strategies: routing.strategies.filter((strategy) => strategy.enabled !== false).length,
    defaultTarget: routing.targets.find((target) => target.id === routing.defaultTargetId) || null,
    defaultStrategy: routing.strategies.find((strategy) => strategy.id === routing.defaultStrategyId) || null,
  };
}

export function parsePolicyLines(value = "") {
  return String(value || "").split(/\r?\n|,/).map((entry) => entry.trim()).filter(Boolean);
}

export function stringifyPolicyLines(value = []) {
  return (Array.isArray(value) ? value : []).join("\n");
}
