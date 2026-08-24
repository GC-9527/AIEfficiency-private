import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { homedir } from "os";
import { dirname, join } from "path";

export const FEISHU_FILTER_PRESET_TYPE = "feishu-project-sync-filter-preset";
export const FEISHU_FILTER_PRESET_VERSION = 1;

export function feishuFilterPresetPath() {
  if (process.env.FEISHU_PROJECT_SYNC_FILTER_PRESET_PATH) return process.env.FEISHU_PROJECT_SYNC_FILTER_PRESET_PATH;
  if (!process.env.AIEFFICIENCY_DATA_DIR && process.env.GATEWAY_CONFIG_PATH) {
    return join(dirname(process.env.GATEWAY_CONFIG_PATH), "feishu-project-sync-filter-preset.json");
  }
  const persistentRoot = process.env.AIEFFICIENCY_DATA_DIR
    || process.env.APPDATA
    || process.env.XDG_CONFIG_HOME
    || join(homedir(), ".config");
  return join(persistentRoot, "aiefficiency", "feishu-project-sync-filter-preset.json");
}

export function normalizeFeishuFilterPreset(input = {}, { updatedAt = "" } = {}) {
  const source = input && typeof input === "object" ? input : {};
  const readScope = source.readScope
    || source.data?.readScope
    || source.sync?.readScope
    || source.config?.sync?.readScope
    || {};
  const rawFilters = Array.isArray(readScope.filters) ? readScope.filters : [];
  const filters = rawFilters.map(normalizeFilter).filter(Boolean);
  if (!filters.length) throw new Error("筛选条件不能为空，无法保存预置或还原备份");

  const ownerFilter = filters.find(isProblemOwnerFilter);
  const requiredAssigneeKeywords = ownerFilter
    ? ownerFilter.values
    : normalizeList(source.requiredAssigneeKeywords || source.sync?.requiredAssigneeKeywords);

  return {
    type: FEISHU_FILTER_PRESET_TYPE,
    version: FEISHU_FILTER_PRESET_VERSION,
    updatedAt: String(updatedAt || source.updatedAt || source.exportedAt || new Date().toISOString()),
    readScope: {
      enabled: readScope.enabled !== false,
      match: String(readScope.match || "all").toLowerCase() === "any" ? "any" : "all",
      filters,
    },
    requiredAssigneeKeywords,
  };
}

export function readFeishuFilterPreset(path = feishuFilterPresetPath()) {
  if (!existsSync(path)) return null;
  try {
    const stored = JSON.parse(readFileSync(path, "utf8"));
    return normalizeFeishuFilterPreset(stored, { updatedAt: stored?.updatedAt });
  } catch (err) {
    console.error(`[feishu-filter-preset] 读取失败：${err?.message || err}`);
    return null;
  }
}

export function saveFeishuFilterPreset(input = {}, path = feishuFilterPresetPath()) {
  const preset = normalizeFeishuFilterPreset(input, { updatedAt: new Date().toISOString() });
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(preset, null, 2)}\n`, "utf8");
  return preset;
}

export function feishuFilterPresetConfigPatch(preset = readFeishuFilterPreset()) {
  if (!preset) return {};
  return {
    sync: {
      readScope: structuredClone(preset.readScope),
      requiredAssigneeKeywords: [...preset.requiredAssigneeKeywords],
    },
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
    kind: String(filter.kind || (fieldKey.startsWith("role_") ? "role" : "field")).trim() || "field",
    fieldKey,
    fieldName,
    operator,
    operatorLabel: String(filter.operatorLabel || operatorLabel(operator)).trim(),
    values: normalizeList(filter.values || filter.optionValues || filter.value),
  };
}

function normalizeList(value) {
  const list = Array.isArray(value) ? value : String(value || "").split(/[\n,，;；]+/);
  return Array.from(new Set(list.map((item) => String(item || "").trim()).filter(Boolean)));
}

function isProblemOwnerFilter(filter = {}) {
  return filter.fieldKey === "role_bd6222" || filter.fieldName === "问题责任人（角色）";
}

function operatorLabel(operator) {
  return {
    containsAny: "存在选项属于",
    notContainsAny: "不存在选项属于",
    exists: "有值",
    empty: "为空",
  }[operator] || "存在选项属于";
}
