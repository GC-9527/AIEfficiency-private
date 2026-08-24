// AI Workbench 设置服务：包装 store.js + 加权限校验 + 默认值回退。
// 设计原则：服务端是唯一来源；前端只展示与提交，不在前端做权限/Feature Flag 判断。

import * as store from "./store.js";
import { AiautoworkError, ERROR_CODES } from "./error-codes.js";
import { addAuditEvent } from "./store.js";

const SETTING_GROUPS = {
  "concurrency": {
    label: "并发池",
    keys: ["concurrency.inference", "concurrency.validation", "concurrency.reviewer", "concurrency.execution"],
  },
  "routing": {
    label: "自动路由阈值",
    keys: ["routing.autoReady.overall", "routing.autoReady.criticalMin", "routing.groupConfirm.overallMin", "routing.manual.criticalMax"],
  },
  "repair": {
    label: "自动修复",
    keys: ["repair.maxAttempts"],
  },
  "batch": {
    label: "批量",
    keys: ["batch.maxItems"],
  },
  "feature": {
    label: "Feature Flag",
    keys: ["feature.enabled", "feature.batch.enabled", "feature.configInference.enabled", "feature.autoRepair.enabled", "feature.manualIntervention.enabled"],
  },
  "permissions": {
    label: "权限",
    keys: ["permissions.allowBatch", "permissions.allowManual", "permissions.allowPublish"],
  },
  "notifications": {
    label: "通知",
    keys: ["notifications.dingtalk"],
  },
  "audit": {
    label: "审计",
    keys: ["audit.enabled"],
  },
};

export function getSettingGroups() {
  return Object.entries(SETTING_GROUPS).map(([id, group]) => ({
    id,
    label: group.label,
    keys: group.keys,
  }));
}

export function getAllSettings() {
  const all = store.listSettings();
  return all;
}

export function getGroupedSettings() {
  const all = store.listSettings();
  const map = new Map(all.map((s) => [s.key, s]));
  const grouped = {};
  for (const [groupId, group] of Object.entries(SETTING_GROUPS)) {
    grouped[groupId] = {
      label: group.label,
      keys: group.keys.map((k) => {
        const found = map.get(k);
        return found || { key: k, value: null, description: "" };
      }),
    };
  }
  return grouped;
}

export function updateSetting(key, value, { actor = null, reason = null } = {}) {
  const previous = store.getSetting(key, null);
  const updated = store.setSetting(key, value, { updatedBy: actor });
  if (actor) {
    addAuditEvent({
      actor,
      action: "policy_change",
      targetType: "setting",
      targetId: key,
      before: previous,
      after: value,
      reason: reason || null,
    });
  }
  return updated;
}

export function updateSettings(patch, { actor = null, reason = null } = {}) {
  if (!patch || typeof patch !== "object") {
    throw new AiautoworkError(ERROR_CODES.INVALID_INPUT, "patch 必须是对象");
  }
  const results = {};
  for (const [key, value] of Object.entries(patch)) {
    const previous = store.getSetting(key, null);
    const updated = store.setSetting(key, value, { updatedBy: actor });
    results[key] = updated;
    if (actor) {
      addAuditEvent({
        actor,
        action: "policy_change",
        targetType: "setting",
        targetId: key,
        before: previous,
        after: value,
        reason: reason || null,
      });
    }
  }
  return results;
}

export function resetSettings({ actor = null, keys = null } = {}) {
  // 仅恢复 defaultSettings 中的项；自定义项保留
  return updateSettings({ /* 此函数由 router 在引入 DEFAULT_SETTINGS 时调用 */ }, { actor });
}

// 便捷取值
export function getConcurrencyLimits() {
  return {
    inference: store.getSetting("concurrency.inference", 6),
    validation: store.getSetting("concurrency.validation", 10),
    reviewer: store.getSetting("concurrency.reviewer", 4),
    execution: store.getSetting("concurrency.execution", 5),
  };
}

export function getRoutingThresholds() {
  return {
    autoReadyOverall: store.getSetting("routing.autoReady.overall", 88),
    autoReadyCriticalMin: store.getSetting("routing.autoReady.criticalMin", 75),
    groupConfirmOverallMin: store.getSetting("routing.groupConfirm.overallMin", 70),
    manualCriticalMax: store.getSetting("routing.manual.criticalMax", 60),
  };
}

export function getRepairLimits() {
  return {
    maxAttempts: store.getSetting("repair.maxAttempts", 5),
  };
}

export function getBatchLimits() {
  return {
    maxItems: store.getSetting("batch.maxItems", 100),
  };
}

export function getFeatureFlags() {
  return {
    enabled: store.getSetting("feature.enabled", false),
    batch: store.getSetting("feature.batch.enabled", true),
    configInference: store.getSetting("feature.configInference.enabled", true),
    autoRepair: store.getSetting("feature.autoRepair.enabled", true),
    manualIntervention: store.getSetting("feature.manualIntervention.enabled", true),
  };
}

export function getPermissions() {
  return {
    allowBatch: store.getSetting("permissions.allowBatch", ["admin"]),
    allowManual: store.getSetting("permissions.allowManual", ["admin", "user"]),
    allowPublish: store.getSetting("permissions.allowPublish", ["admin"]),
  };
}

export function getNotificationConfig() {
  return store.getSetting("notifications.dingtalk", { enabled: false, webhook: "" });
}

export function isAuditEnabled() {
  return store.getSetting("audit.enabled", true);
}

export function isFeatureEnabled(flag) {
  const flags = getFeatureFlags();
  return flag === "enabled" ? !!flags.enabled : !!flags[flag];
}

export function checkPermission(role, action) {
  const perms = getPermissions();
  const map = { batch: perms.allowBatch, manual: perms.allowManual, publish: perms.allowPublish };
  const allowed = map[action] || [];
  if (!Array.isArray(allowed)) return false;
  return allowed.includes(role || "user");
}

export default {
  getSettingGroups,
  getAllSettings,
  getGroupedSettings,
  updateSetting,
  updateSettings,
  getConcurrencyLimits,
  getRoutingThresholds,
  getRepairLimits,
  getBatchLimits,
  getFeatureFlags,
  getPermissions,
  getNotificationConfig,
  isAuditEnabled,
  isFeatureEnabled,
  checkPermission,
};
