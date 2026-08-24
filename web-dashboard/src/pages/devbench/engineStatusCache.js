export const ENGINE_STATUS_CACHE_KEY = "devbench_engine_status_cache_v1";

function resolveStorage(storage) {
  if (storage !== undefined) return storage;
  try {
    return typeof localStorage !== "undefined" ? localStorage : null;
  } catch {
    return null;
  }
}

function isStatusMap(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

// 模型检测可能需要数十秒。持久化最后一次完整结果，悬浮窗下次打开时可立即回显。
export function readEngineStatusCache(storage) {
  const target = resolveStorage(storage);
  if (!target?.getItem) return null;
  try {
    const parsed = JSON.parse(target.getItem(ENGINE_STATUS_CACHE_KEY) || "null");
    if (!parsed || parsed.version !== 1 || !isStatusMap(parsed.data)) return null;
    return {
      data: parsed.data,
      checkedAt: Number(parsed.checkedAt) || 0,
    };
  } catch {
    return null;
  }
}

export function writeEngineStatusCache(data, storage) {
  if (!isStatusMap(data)) return false;
  const target = resolveStorage(storage);
  if (!target?.setItem) return false;
  try {
    target.setItem(ENGINE_STATUS_CACHE_KEY, JSON.stringify({
      version: 1,
      checkedAt: Date.now(),
      data,
    }));
    return true;
  } catch {
    return false;
  }
}

export function engineStatusLabel(result) {
  if (!result || typeof result !== "object") return "待检测";
  if (result.available === true) return "可用";
  if (result.available !== false) return "待检测";
  if (result.status === "not_installed") return "未安装";
  if (result.status === "need_login") return "未登录";
  if (result.status === "disabled") return "未启用";
  if (result.status === "missing_key") return "缺少 Key";
  return "不可用";
}

// 聊天框始终保留 model/档位两个信息位。未显式配置时显示“默认”，
// 避免把 AI 名称（例如 Codex）误当成模型名。
export function engineModelTier(metadata, engine) {
  const item = metadata && typeof metadata === "object" ? metadata[engine] : null;
  const model = String(item?.model || "").trim();
  const tier = String(item?.tier || "").trim();
  return {
    model: model || "默认模型",
    tier: tier || "默认档位",
    modelConfigured: !!model,
    tierConfigured: !!tier,
  };
}

export function engineModelTierText(metadata, engine) {
  const info = engineModelTier(metadata, engine);
  return `${info.model} · ${info.tier}`;
}

// 回答使用不可变快照，不回看“当前配置”。快照存在但值为空表示当时使用
// 引擎默认值；旧消息完全没有快照时明确标记为未记录，避免伪造历史。
export function answerAiModelTier(message = {}) {
  const snapshot = message?.aiSnapshot && typeof message.aiSnapshot === "object"
    ? message.aiSnapshot
    : null;
  const hasLegacySnapshot = Object.prototype.hasOwnProperty.call(message || {}, "model")
    || Object.prototype.hasOwnProperty.call(message || {}, "tier");
  const recorded = !!snapshot || hasLegacySnapshot;
  const engine = String(snapshot?.engine || message?.engine || "").trim();
  if (!recorded) {
    return { engine, model: "模型未记录", tier: "档位未记录", recorded: false };
  }
  const model = String(snapshot ? snapshot.model || "" : message.model || "").trim();
  const tier = String(snapshot ? snapshot.tier || "" : message.tier || "").trim();
  const name = String(snapshot?.name || "").trim();
  const provider = String(snapshot?.provider || "").trim();
  const access = String(snapshot?.access || "").trim();
  const endpoint = String(snapshot?.endpoint || "").trim();
  return {
    engine,
    model: model || "默认模型",
    tier: tier || "默认档位",
    recorded: true,
    ...(name ? { name } : {}),
    ...(provider ? { provider } : {}),
    ...(access ? { access } : {}),
    ...(endpoint ? { endpoint } : {}),
    ...(snapshot?.official != null ? { official: !!snapshot.official } : {}),
  };
}

export function answerAiModelTierText(message = {}) {
  const info = answerAiModelTier(message);
  return `${info.model} · ${info.tier}`;
}
