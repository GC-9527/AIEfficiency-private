/**
 * 故事点级 AI 模型 / 档位偏好。
 * 每个故事点可独立覆盖引擎内的 model 与 reasoning tier，不改全局 ~/.codex 等配置。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function clean(value) {
  return String(value || "").trim();
}

/**
 * Codex CLI 的登录/计费模式：
 * - "chatgpt"：ChatGPT 账号订阅（auth.json auth_mode=chatgpt）。模型必须用账号档位
 *   提供的名字（如 gpt-5.6-sol），`gpt-5.x-codex` 这类 API-only 模型会被服务端
 *   400 拒绝（"not supported when using Codex with a ChatGPT account"）。
 * - "api" / 其他：API key 或兼容端点，可用 `gpt-5.x-codex` 系列。
 * 探测失败时按 "api" 处理（保留完整清单，不误伤）。
 */
export function detectCodexAuthMode({ home = os.homedir(), env = process.env, io = fs } = {}) {
  try {
    const codexHome = clean(env.CODEX_HOME) || path.join(home, ".codex");
    const auth = JSON.parse(io.readFileSync(path.join(codexHome, "auth.json"), "utf8"));
    if (auth?.auth_mode === "chatgpt") return "chatgpt";
    if (auth?.OPENAI_API_KEY || auth?.api_key) return "api";
    return "chatgpt"; // 有 auth.json 但无 key → 账号登录
  } catch {
    return "api"; // 无 auth.json 或读不了 → 按 API 模式给全清单
  }
}

/** API-only 的 Codex 模型（ChatGPT 账号订阅不可用）：`gpt-5.x-codex` 系列。 */
const CODEX_API_ONLY_MODELS = [
  "gpt-5.3-codex",
  "gpt-5.2-codex",
  "gpt-5.1-codex",
];

/** 按登录模式过滤 codex 模型清单：账号订阅模式剔除 API-only 模型。 */
function filterCodexModels(models, authMode) {
  if (authMode !== "chatgpt") return models;
  return models.filter((m) => !CODEX_API_ONLY_MODELS.includes(m));
}

/** 内置可选清单（允许 UI 自由输入不在清单内的值；前列视为当前推荐/最新）。 */
export const ENGINE_MODEL_CATALOGS = {
  codex: {
    models: [
      "gpt-5.5",
      "gpt-5.4",
      "gpt-5.3-codex",
      "gpt-5.2-codex",
      "gpt-5.1-codex",
      "gpt-5.6-sol",
      "o3",
      "o4-mini",
    ],
    tiers: ["minimal", "low", "medium", "high", "xhigh", "max"],
  },
  claude: {
    models: [
      "claude-opus-4-8",
      "claude-sonnet-4-6",
      "claude-haiku-4-5",
      "claude-opus-4-20250514",
      "claude-sonnet-4-20250514",
      "claude-haiku-4-5-20251001",
      "claude-opus-4",
      "claude-sonnet-4",
    ],
    tiers: ["low", "medium", "high", "max"],
  },
  "claude-volcengine": {
    models: [
      "glm-5.2[1m]",
      "deepseek-v4-pro[1m]",
      "deepseek-v4-flash[1m]",
      "ark-code-latest",
      "glm-5.2",
      "deepseek-v4-pro",
      "deepseek-v4-flash",
      "doubao-seed-2.0-code",
      "doubao-seed-code",
      "glm-4.7",
      "kimi-k2.6",
      "kimi-k2.5",
      "deepseek-v3.2",
    ],
    tiers: ["low", "medium", "high", "max"],
  },
  "claude-minimax": {
    models: ["MiniMax-M3"],
    tiers: ["low", "medium", "high", "max"],
  },
  "codex-minimax": {
    models: ["MiniMax-M3"],
    tiers: ["minimal", "low", "medium", "high", "xhigh", "max"],
  },
  "claude-atlas": {
    models: [],
    tiers: ["low", "medium", "high", "max"],
  },
  "codex-atlas": {
    models: [],
    tiers: ["minimal", "low", "medium", "high", "xhigh", "max"],
  },
  "hermes-atlas": {
    models: [],
    tiers: [],
  },
  gemini: {
    models: [
      "gemini-3.1-pro-preview",
      "gemini-3.5-flash",
      "gemini-2.5-pro",
      "gemini-2.5-flash",
      "gemini-2.0-flash",
    ],
    tiers: [],
  },
  hermes: {
    // Hermes 支持任意已配置 provider 的模型；UI 保留自由输入，不维护易过期的静态清单。
    models: [],
    tiers: [],
  },
  deepseek: {
    models: [
      "deepseek-v4-pro",
      "deepseek-v4-flash",
      "deepseek-reasoner",
      "deepseek-chat",
    ],
    tiers: ["off", "low", "medium", "high", "max"],
  },
  volcengine: {
    models: [
      "ark-code-latest",
      "glm-5.2[1m]",
      "deepseek-v4-pro[1m]",
      "deepseek-v4-flash[1m]",
      "glm-5.2",
      "deepseek-v4-pro",
      "deepseek-v4-flash",
      "doubao-seed-2.0-code",
      "doubao-seed-code",
    ],
    tiers: ["low", "medium", "high"],
  },
};

export function normalizeAiPrefs(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out = {};
  for (const [engine, prefs] of Object.entries(raw)) {
    const id = clean(engine).toLowerCase();
    if (!id || !prefs || typeof prefs !== "object") continue;
    const model = clean(prefs.model);
    const tier = clean(prefs.tier);
    if (!model && !tier) continue;
    out[id] = {
      ...(model ? { model } : {}),
      ...(tier ? { tier } : {}),
    };
  }
  return out;
}

/** 合并内置清单与设置页 availableModels（方舟等）；当前默认模型置顶 */
export function buildEngineModelCatalog(engine, metadataItem = {}, opts = {}) {
  const id = clean(engine).toLowerCase();
  const base = ENGINE_MODEL_CATALOGS[id] || { models: [], tiers: [] };
  const extra = Array.isArray(metadataItem.availableModels) ? metadataItem.availableModels : [];
  const current = clean(metadataItem.model);
  // codex：按登录模式过滤 API-only 模型（ChatGPT 账号订阅不可用 gpt-5.x-codex）
  let catalogModels = Array.isArray(base.models) ? base.models : [];
  if (id === "codex") {
    const authMode = opts.authMode || detectCodexAuthMode();
    catalogModels = filterCodexModels(catalogModels, authMode);
  }
  const models = [...new Set([
    ...(current ? [current] : []),
    ...extra.map((m) => clean(m)).filter(Boolean),
    ...catalogModels,
  ])];
  return { models, tiers: Array.isArray(base.tiers) ? base.tiers : [] };
}

export function resolveEngineAiPrefs(tab, engine, metadataItem = {}) {
  const id = clean(engine).toLowerCase();
  const prefs = normalizeAiPrefs(tab?.aiPrefs)[id] || {};
  const model = clean(prefs.model) || clean(metadataItem.model);
  const tier = clean(prefs.tier) || clean(metadataItem.tier);
  const overridden = !!(prefs.model || prefs.tier);
  return {
    engine: id,
    model,
    tier,
    overridden,
    source: overridden ? "故事点配置" : (metadataItem.source || ""),
    catalog: buildEngineModelCatalog(id, metadataItem),
  };
}

/**
 * 合并元数据：把故事点覆盖写进展示字段，并附带可选清单。
 */
export function applyTabAiPrefsToMetadata(metadata, tab) {
  const base = metadata && typeof metadata === "object" ? metadata : {};
  const out = {};
  const engines = new Set([
    ...Object.keys(base),
    ...Object.keys(normalizeAiPrefs(tab?.aiPrefs)),
    ...Object.keys(ENGINE_MODEL_CATALOGS),
  ]);
  for (const engine of engines) {
    const item = base[engine] || { name: engine, model: "", tier: "", source: "" };
    const resolved = resolveEngineAiPrefs(tab, engine, item);
    out[engine] = {
      ...item,
      model: resolved.model,
      tier: resolved.tier,
      source: resolved.source || item.source || "",
      overridden: resolved.overridden,
      catalog: resolved.catalog,
    };
  }
  return out;
}

export function mergeAiPrefsUpdate(existing, engine, { model, tier, clearModel = false, clearTier = false } = {}) {
  const id = clean(engine).toLowerCase();
  if (!id) return normalizeAiPrefs(existing);
  const next = { ...normalizeAiPrefs(existing) };
  const cur = { ...(next[id] || {}) };
  if (clearModel) delete cur.model;
  else if (model !== undefined) {
    const value = clean(model);
    if (value) cur.model = value;
    else delete cur.model;
  }
  if (clearTier) delete cur.tier;
  else if (tier !== undefined) {
    const value = clean(tier);
    if (value) cur.tier = value;
    else delete cur.tier;
  }
  if (!cur.model && !cur.tier) delete next[id];
  else next[id] = cur;
  return next;
}
