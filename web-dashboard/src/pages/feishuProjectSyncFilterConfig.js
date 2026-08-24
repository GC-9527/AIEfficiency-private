export const FEISHU_FILTER_BACKUP_TYPE = "feishu-project-sync-filter-backup";
export const FEISHU_FILTER_BACKUP_VERSION = 1;

export function filterFeishuFieldChoices(fields = [], query = "") {
  const tokens = String(query || "")
    .trim()
    .toLocaleLowerCase()
    .split(/\s+/)
    .filter(Boolean);
  const list = Array.isArray(fields) ? fields : [];
  if (!tokens.length) return list;
  return list.filter((field) => {
    const kind = String(field?.kind || "field");
    const searchableText = [
      field?.name,
      field?.key,
      field?.type,
      kind,
      kind === "role" ? "角色" : "字段",
    ].map((value) => String(value || "").toLocaleLowerCase()).join(" ");
    return tokens.every((token) => searchableText.includes(token));
  });
}

export function nextFilterForSelectedField(filter = {}, field = {}, operatorLabels = {}) {
  const nextKind = String(field.kind || "field");
  const nextKey = String(field.key || field.fieldKey || "").trim();
  const currentKey = String(filter.fieldKey || filter.key || "").trim();
  const currentKind = String(filter.kind || "field");
  const sameField = currentKind === nextKind && currentKey === nextKey;
  const operator = String(filter.operator || "containsAny");
  return {
    kind: nextKind,
    fieldKey: nextKey,
    fieldName: String(field.name || field.fieldName || nextKey).trim(),
    operator,
    operatorLabel: operatorLabels[operator] || filter.operatorLabel || operator,
    values: sameField ? normalizeList(filter.values) : [],
  };
}

export function filterValueChoices(field = {}, filter = {}, { ownerValues = [], isOwnerFilter = false } = {}) {
  const fieldOptions = normalizeOptions(field.options);
  const optionLabels = new Set(fieldOptions.map((option) => option.label));
  const selectedValues = normalizeList(filter.values)
    .filter((label) => !fieldOptions.length || optionLabels.has(label))
    .map((label) => ({ label, value: label }));
  const defaults = isOwnerFilter
    ? normalizeList(ownerValues).map((label) => ({ label, value: label }))
    : [];
  const seen = new Set();
  return [...defaults, ...selectedValues, ...fieldOptions].filter((option) => {
    if (!option.label || seen.has(option.label)) return false;
    seen.add(option.label);
    return true;
  });
}

export function buildFeishuFilterBackup(config = {}, exportedAt = new Date().toISOString()) {
  const normalized = parseFeishuFilterBackup(config);
  return {
    type: FEISHU_FILTER_BACKUP_TYPE,
    version: FEISHU_FILTER_BACKUP_VERSION,
    exportedAt,
    ...normalized,
  };
}

export function parseFeishuFilterBackup(input = {}) {
  const source = input && typeof input === "object" ? input : {};
  const readScope = source.readScope
    || source.data?.readScope
    || source.sync?.readScope
    || source.config?.sync?.readScope
    || {};
  const filters = Array.isArray(readScope.filters)
    ? readScope.filters.map(normalizeFilter).filter(Boolean)
    : [];
  if (!filters.length) throw new Error("备份中没有有效筛选条件");
  const owner = filters.find(isProblemOwnerFilter);
  return {
    readScope: {
      enabled: readScope.enabled !== false,
      match: String(readScope.match || "all").toLowerCase() === "any" ? "any" : "all",
      filters,
    },
    requiredAssigneeKeywords: owner
      ? owner.values
      : normalizeList(source.requiredAssigneeKeywords || source.sync?.requiredAssigneeKeywords),
  };
}

function normalizeFilter(filter = {}, index = 0) {
  if (!filter || typeof filter !== "object" || Array.isArray(filter)) return null;
  const fieldKey = String(filter.fieldKey || filter.key || filter.roleId || "").trim();
  const fieldName = String(filter.fieldName || filter.name || filter.roleName || fieldKey).trim();
  if (!fieldKey && !fieldName) return null;
  const operator = ["containsAny", "notContainsAny", "exists", "empty"].includes(String(filter.operator))
    ? String(filter.operator)
    : "containsAny";
  return {
    id: String(filter.id || fieldKey || fieldName || `filter-${index}`).trim(),
    enabled: filter.enabled !== false,
    kind: String(filter.kind || (fieldKey.startsWith("role_") ? "role" : "field")),
    fieldKey,
    fieldName,
    operator,
    operatorLabel: String(filter.operatorLabel || operator),
    values: normalizeList(filter.values || filter.optionValues || filter.value),
  };
}

function normalizeOptions(options = []) {
  return (Array.isArray(options) ? options : []).map((option) => {
    if (option == null || option === "") return null;
    if (typeof option !== "object") {
      const label = String(option).trim();
      return label ? { label, value: label } : null;
    }
    const label = String(option.label || option.name || option.value || "").trim();
    const value = String(option.value || option.id || label).trim();
    return label ? { label, value } : null;
  }).filter(Boolean);
}

function normalizeList(value) {
  const list = Array.isArray(value) ? value : String(value || "").split(/[\n,，;；]+/);
  return Array.from(new Set(list.map((item) => String(item || "").trim()).filter(Boolean)));
}

function isProblemOwnerFilter(filter = {}) {
  return filter.fieldKey === "role_bd6222" || filter.fieldName === "问题责任人（角色）";
}
