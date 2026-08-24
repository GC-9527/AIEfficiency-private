/**
 * 将设置页「火山方舟」API 引擎同步到本机 OpenCode 全局配置。
 * 路径：~/.config/opencode/opencode.json（Windows 同理）
 * 格式遵循 OpenCode 官方 OpenAI 兼容 provider（provider + npm + options）。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { getConfig } from "./config.js";

export const OPENCODE_PROVIDER_ID = "volcengine";

export function getOpenCodeConfigPath(home = homedir()) {
  return join(String(home || ""), ".config", "opencode", "opencode.json");
}

function trimSlash(url) {
  return String(url || "").trim().replace(/\/+$/, "");
}

function readJsonFile(filePath) {
  if (!existsSync(filePath)) return { ok: true, data: {}, existed: false };
  try {
    const raw = readFileSync(filePath, "utf8");
    if (!String(raw || "").trim()) return { ok: true, data: {}, existed: true };
    const data = JSON.parse(raw);
    if (!data || typeof data !== "object" || Array.isArray(data)) {
      return { ok: false, error: "OpenCode 配置不是 JSON 对象", data: null, existed: true };
    }
    return { ok: true, data, existed: true };
  } catch (err) {
    return { ok: false, error: `OpenCode 配置解析失败：${err?.message || err}`, data: null, existed: true };
  }
}

function resolveVolcengineEngine(overrides = {}) {
  const cfg = getConfig()?.apiEngines?.volcengine || {};
  const apiKey = String(overrides.apiKey || cfg.apiKey || "").trim();
  const baseUrl = trimSlash(overrides.baseUrl || cfg.baseUrl || "https://ark.cn-beijing.volces.com/api/plan/v3");
  const model = String(overrides.model || cfg.model || "ark-code-latest").trim() || "ark-code-latest";
  const availableModels = Array.isArray(overrides.availableModels)
    ? overrides.availableModels
    : (Array.isArray(cfg.availableModels) ? cfg.availableModels : []);
  const models = {};
  for (const m of [...availableModels, model]) {
    const id = String(m || "").trim();
    if (!id) continue;
    models[id] = { name: id };
  }
  if (!models[model]) models[model] = { name: model };
  return { apiKey, baseUrl, model, models, enabled: !!cfg.enabled };
}

/**
 * 合并方舟 provider，并把默认 model 设为 volcengine/<model>。
 */
export function mergeVolcengineIntoOpenCodeConfig(existing = {}, engine = {}) {
  const providerId = OPENCODE_PROVIDER_ID;
  const modelId = String(engine.model || "ark-code-latest").trim() || "ark-code-latest";
  const next = { ...(existing && typeof existing === "object" ? existing : {}) };
  next.$schema = next.$schema || "https://opencode.ai/config.json";
  next.model = `${providerId}/${modelId}`;

  const providerRoot = next.provider && typeof next.provider === "object" && !Array.isArray(next.provider)
    ? { ...next.provider }
    : {};
  const prev = providerRoot[providerId] && typeof providerRoot[providerId] === "object"
    ? providerRoot[providerId]
    : {};
  const prevOptions = prev.options && typeof prev.options === "object" ? { ...prev.options } : {};
  const prevModels = prev.models && typeof prev.models === "object" ? { ...prev.models } : {};

  providerRoot[providerId] = {
    ...prev,
    npm: "@ai-sdk/openai-compatible",
    name: String(prev.name || "火山方舟").trim() || "火山方舟",
    options: {
      ...prevOptions,
      baseURL: engine.baseUrl,
      apiKey: engine.apiKey,
    },
    models: {
      ...prevModels,
      ...(engine.models || {}),
    },
  };
  next.provider = providerRoot;

  if (Array.isArray(next.enabled_providers)) {
    const set = new Set(next.enabled_providers.map((x) => String(x || "").trim()).filter(Boolean));
    set.add(providerId);
    next.enabled_providers = [...set];
  }

  return {
    config: next,
    model: next.model,
    providerId,
    modelId,
  };
}

/**
 * 一键把设置页方舟写入本机 OpenCode 配置，并设为默认 model。
 * @param {{ apiKey?: string, baseUrl?: string, model?: string, availableModels?: string[], home?: string }} [opts]
 */
export function applyVolcengineToOpenCode(opts = {}) {
  const engine = resolveVolcengineEngine(opts);
  if (!engine.apiKey || /\*{3,}/.test(engine.apiKey)) {
    return {
      ok: false,
      error: "请先在设置页「火山方舟」填入有效 API Key 并保存",
    };
  }
  if (!engine.baseUrl) {
    return { ok: false, error: "方舟 Base URL 为空" };
  }

  const filePath = getOpenCodeConfigPath(opts.home);
  const loaded = readJsonFile(filePath);
  if (!loaded.ok) return { ok: false, error: loaded.error, path: filePath };

  const merged = mergeVolcengineIntoOpenCodeConfig(loaded.data, engine);
  try {
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, `${JSON.stringify(merged.config, null, 2)}\n`, "utf8");
  } catch (err) {
    return { ok: false, error: `写入失败：${err?.message || err}`, path: filePath };
  }

  return {
    ok: true,
    path: filePath,
    existed: loaded.existed,
    model: merged.model,
    providerId: merged.providerId,
    modelId: merged.modelId,
    baseUrl: engine.baseUrl,
    hint: "已写入 OpenCode 并设为默认模型。请重新打开 opencode（或新开终端）后用 /models 确认。",
  };
}

/** 只读：当前 OpenCode 默认 model / 是否已配方舟 */
export function readOpenCodeVolcengineStatus(opts = {}) {
  const filePath = getOpenCodeConfigPath(opts.home);
  const loaded = readJsonFile(filePath);
  if (!loaded.ok) return { ok: false, error: loaded.error, path: filePath, exists: loaded.existed };
  const data = loaded.data || {};
  const provider = data.provider?.[OPENCODE_PROVIDER_ID];
  const hasProvider = !!(provider && typeof provider === "object");
  const model = String(data.model || "").trim();
  return {
    ok: true,
    path: filePath,
    exists: loaded.existed,
    model,
    isVolcengineDefault: model.startsWith(`${OPENCODE_PROVIDER_ID}/`),
    hasProvider,
    baseURL: String(provider?.options?.baseURL || "").trim(),
  };
}
