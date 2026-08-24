/**
 * Claude Code × 火山方舟（Anthropic 兼容协议）
 *
 * 配置落点（一键配置后）：
 * - 默认 ~/.claude/settings.json：写入方舟 ANTHROPIC_* → 终端直接 `claude` 走方舟（对齐官方文档）
 * - ~/.claude-volcengine：故事点引擎 `claude-volcengine` 专用（CLAUDE_CONFIG_DIR）
 * - ~/.claude-official：故事点引擎 `claude`（官方）专用，避免默认目录被方舟污染后无法区分
 *
 * Anthropic 端点（无 /v3）：
 * - Agent Plan:  https://ark.cn-beijing.volces.com/api/plan
 * - Coding Plan: https://ark.cn-beijing.volces.com/api/coding
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { getConfig } from "./config.js";

export const CLAUDE_VOLCENGINE_ENGINE_ID = "claude-volcengine";
export const CLAUDE_OFFICIAL_ENGINE_ID = "claude";

/** 写入/剥离时识别的方舟相关 env 键 */
const VOLCENGINE_CLAUDE_ENV_KEYS = [
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_MODEL",
  "ANTHROPIC_DEFAULT_SONNET_MODEL",
  "ANTHROPIC_DEFAULT_OPUS_MODEL",
  "CLAUDE_CODE_AUTO_COMPACT_WINDOW",
  "API_TIMEOUT_MS",
];

export const VOLCENGINE_ANTHROPIC_ENDPOINTS = {
  agent: "https://ark.cn-beijing.volces.com/api/plan",
  coding: "https://ark.cn-beijing.volces.com/api/coding",
};

/** 方舟文档：支持 1M 上下文、适合大型代码库长会话的模型（Claude Code 需 [1m] 后缀） */
export const EXTENDED_CONTEXT_1M_MODELS = [
  "glm-5.2",
  "deepseek-v4-flash",
  "deepseek-v4-pro",
];

const EXTENDED_CONTEXT_1M_SET = new Set(EXTENDED_CONTEXT_1M_MODELS.map((m) => m.toLowerCase()));

export function isClaudeCliEngine(engine) {
  const id = String(engine || "").trim().toLowerCase();
  // provider 变体定义在各自模块，此处用字符串避免循环依赖
  return id === CLAUDE_OFFICIAL_ENGINE_ID
    || id === CLAUDE_VOLCENGINE_ENGINE_ID
    || id === "claude-minimax"
    || id === "claude-atlas";
}

export function isClaudeVolcengineEngine(engine) {
  return String(engine || "").trim().toLowerCase() === CLAUDE_VOLCENGINE_ENGINE_ID;
}

/**
 * 按默认 ~/.claude/settings.json 的 ANTHROPIC_BASE_URL 判定当前终端 claude 走哪个来源。
 * 供方舟/minimax 卡片共用展示，明确区分多个 Claude 来源（方舟 / minimax / 官方 / 自定义）。
 * @returns {"minimax"|"volcengine"|"custom"|"official"}
 */
export function detectDefaultClaudeSource(home = homedir()) {
  const env = readJsonObject(getDefaultClaudeSettingsPath(home)).env || {};
  const base = String(env.ANTHROPIC_BASE_URL || "").trim().toLowerCase();
  if (/api\.minimaxi\.com/.test(base)) return "minimax";
  if (/ark\.cn-beijing\.volces\.com/.test(base)) return "volcengine";
  if (base) return "custom";
  return "official";
}

/** 默认来源 -> 中文展示名 */
export function describeDefaultClaudeSource(source) {
  switch (source) {
    case "minimax": return "MiniMax";
    case "volcengine": return "火山方舟";
    case "custom": return "自定义端点";
    default: return "Anthropic 官方";
  }
}

export function getClaudeVolcengineConfigDir(home = homedir()) {
  return join(String(home || ""), ".claude-volcengine");
}

export function getClaudeVolcengineSettingsPath(home = homedir()) {
  return join(getClaudeVolcengineConfigDir(home), "settings.json");
}

export function getClaudeVolcengineJsonPath(home = homedir()) {
  return join(getClaudeVolcengineConfigDir(home), ".claude.json");
}

/** Claude Code 默认配置目录（终端直接运行 `claude` 时使用） */
export function getDefaultClaudeConfigDir(home = homedir()) {
  return join(String(home || ""), ".claude");
}

export function getDefaultClaudeSettingsPath(home = homedir()) {
  return join(getDefaultClaudeConfigDir(home), "settings.json");
}

/** 官方 Claude 引擎隔离目录（默认 ~/.claude 写入方舟后，故事点「官方」走这里） */
export function getClaudeOfficialConfigDir(home = homedir()) {
  return join(String(home || ""), ".claude-official");
}

export function getClaudeOfficialSettingsPath(home = homedir()) {
  return join(getClaudeOfficialConfigDir(home), "settings.json");
}

function readJsonObject(path) {
  if (!existsSync(path)) return {};
  try {
    const data = JSON.parse(readFileSync(path, "utf8"));
    return data && typeof data === "object" && !Array.isArray(data) ? data : {};
  } catch {
    return {};
  }
}

function stripVolcengineEnvKeys(env = {}) {
  const next = { ...(env && typeof env === "object" ? env : {}) };
  for (const key of VOLCENGINE_CLAUDE_ENV_KEYS) delete next[key];
  return next;
}

/**
 * 合并 env 到 Claude settings.json，保留 theme / 权限等其它字段。
 * 同步写入顶层 model（Claude Code 与 /model 默认值会读此字段）。
 */
export function mergeClaudeSettingsEnv(settingsPath, envPatch = {}, { model } = {}) {
  const data = readJsonObject(settingsPath);
  const prevEnv = data.env && typeof data.env === "object" ? data.env : {};
  const patch = envPatch && typeof envPatch === "object" ? envPatch : {};
  data.env = { ...prevEnv, ...patch };
  // 方舟用 AUTH_TOKEN；避免与 API_KEY 并存导致官方优先读错
  if (data.env.ANTHROPIC_AUTH_TOKEN) delete data.env.ANTHROPIC_API_KEY;
  const modelId = String(model || patch.ANTHROPIC_MODEL || data.env.ANTHROPIC_MODEL || "").trim();
  if (modelId) data.model = modelId;
  mkdirSync(join(settingsPath, ".."), { recursive: true });
  writeFileSync(settingsPath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  return { ok: true, path: settingsPath, env: data.env, model: data.model };
}

/**
 * 在写入默认 ~/.claude 方舟配置之前，把当前官方登录态备份到 ~/.claude-official，
 * 供故事点「Claude（官方）」使用（CLAUDE_CONFIG_DIR）。
 */
export function ensureClaudeOfficialProfile(home = homedir()) {
  const officialDir = getClaudeOfficialConfigDir(home);
  const officialSettings = getClaudeOfficialSettingsPath(home);
  const officialJson = join(officialDir, ".claude.json");
  const defaultDir = getDefaultClaudeConfigDir(home);
  const defaultSettings = getDefaultClaudeSettingsPath(home);
  const defaultJson = join(defaultDir, ".claude.json");
  mkdirSync(officialDir, { recursive: true });
  let created = false;
  if (!existsSync(officialSettings)) {
    const src = readJsonObject(defaultSettings);
    const env = stripVolcengineEnvKeys(src.env);
    const next = { ...src, env };
    writeFileSync(officialSettings, `${JSON.stringify(next, null, 2)}\n`, "utf8");
    created = true;
  } else {
    // 已存在时仍剥离误写入的方舟键，避免官方引擎串到方舟
    const cur = readJsonObject(officialSettings);
    const cleaned = stripVolcengineEnvKeys(cur.env);
    if (JSON.stringify(cleaned) !== JSON.stringify(cur.env || {})) {
      cur.env = cleaned;
      writeFileSync(officialSettings, `${JSON.stringify(cur, null, 2)}\n`, "utf8");
    }
  }
  if (!existsSync(officialJson) && existsSync(defaultJson)) {
    try {
      copyFileSync(defaultJson, officialJson);
      created = true;
    } catch {
      /* best-effort：无登录态文件时仍可用交互 login */
    }
  }
  return { ok: true, configDir: officialDir, settingsPath: officialSettings, created };
}

/** 故事点「Claude（官方）」spawn：指向 ~/.claude-official，并清掉进程里残留的方舟 env */
export function buildClaudeOfficialSpawnEnv(baseEnv = process.env, overrides = {}) {
  const home = overrides.home || homedir();
  ensureClaudeOfficialProfile(home);
  const env = { ...baseEnv };
  env.CLAUDE_CONFIG_DIR = getClaudeOfficialConfigDir(home);
  for (const key of VOLCENGINE_CLAUDE_ENV_KEYS) delete env[key];
  return { env, configDir: env.CLAUDE_CONFIG_DIR };
}

/**
 * 在隔离配置目录 ~/.claude-volcengine/.claude.json 里把工作目录标记为「已信任」。
 *
 * 方舟 Claude 用独立 CLAUDE_CONFIG_DIR，从未交互式接受过工作区信任弹窗，非交互
 * (-p) 运行时会报「this workspace has not been trusted」并退出 1。这里预先把 cwd
 * 及附加目录写入 projects[dir].hasTrustDialogAccepted=true，等效于接受信任弹窗。
 */
export function ensureClaudeVolcengineTrust(dirs = [], home = homedir()) {
  const list = (Array.isArray(dirs) ? dirs : [dirs])
    .map((d) => String(d || "").trim())
    .filter(Boolean);
  if (!list.length) return { ok: true, changed: false, trusted: [] };
  const configDir = getClaudeVolcengineConfigDir(home);
  const jsonPath = getClaudeVolcengineJsonPath(home);
  let data = {};
  if (existsSync(jsonPath)) {
    try {
      data = JSON.parse(readFileSync(jsonPath, "utf8")) || {};
    } catch {
      data = {};
    }
  }
  if (!data.projects || typeof data.projects !== "object") data.projects = {};
  const keys = new Set();
  for (const d of list) {
    keys.add(d);
    keys.add(d.replace(/\\/g, "/"));
  }
  const trusted = [];
  let changed = false;
  for (const key of keys) {
    const proj = data.projects[key] && typeof data.projects[key] === "object"
      ? data.projects[key]
      : {};
    if (proj.hasTrustDialogAccepted !== true) {
      proj.hasTrustDialogAccepted = true;
      changed = true;
    }
    if (proj.hasCompletedProjectOnboarding !== true) {
      proj.hasCompletedProjectOnboarding = true;
      changed = true;
    }
    data.projects[key] = proj;
    trusted.push(key);
  }
  if (changed) {
    try {
      mkdirSync(configDir, { recursive: true });
      writeFileSync(jsonPath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
    } catch (err) {
      return { ok: false, error: `写入信任标记失败：${err?.message || err}`, path: jsonPath, trusted };
    }
  }
  return { ok: true, changed, trusted, path: jsonPath };
}

function trimSlash(url) {
  return String(url || "").trim().replace(/\/+$/, "");
}

function baseModelId(model) {
  return String(model || "").trim().replace(/\[1m\]$/i, "");
}

/** 是否为方舟 1M 扩展上下文能力模型（含已带 [1m] 后缀） */
export function isExtendedContext1MModel(model) {
  const raw = String(model || "").trim();
  if (!raw) return false;
  if (/\[1m\]$/i.test(raw)) return true;
  return EXTENDED_CONTEXT_1M_SET.has(baseModelId(raw).toLowerCase());
}

/**
 * Claude Code 识别 1M 窗口的惯例：模型名加 [1m]，并配 CLAUDE_CODE_AUTO_COMPACT_WINDOW=1000000。
 * 仅对 glm-5.2 / deepseek-v4-flash / deepseek-v4-pro 生效；ark-code-latest 等保持原样。
 */
export function normalizeClaudeVolcengineModelId(model, { extendedContext = true } = {}) {
  const raw = String(model || "").trim() || "ark-code-latest";
  if (/\[1m\]$/i.test(raw)) return raw;
  const base = baseModelId(raw);
  if (!extendedContext) return base;
  const known = EXTENDED_CONTEXT_1M_MODELS.find((m) => m.toLowerCase() === base.toLowerCase());
  return known ? `${known}[1m]` : base;
}

/** 注入 Claude Code 扩展上下文相关 env（1M 窗口 + 长超时） */
export function applyExtendedContextEnv(env, model, { extendedContext = true } = {}) {
  const next = env && typeof env === "object" ? env : {};
  if (!extendedContext) return next;
  const modelId = normalizeClaudeVolcengineModelId(model, { extendedContext: true });
  // 始终抬高 compact 窗口，便于路由到 1M 模型时不在 200K 过早压缩
  next.CLAUDE_CODE_AUTO_COMPACT_WINDOW = "1000000";
  next.API_TIMEOUT_MS = next.API_TIMEOUT_MS || "3000000";
  if (isExtendedContext1MModel(modelId)) {
    next.ANTHROPIC_MODEL = modelId;
    next.ANTHROPIC_DEFAULT_SONNET_MODEL = modelId;
    next.ANTHROPIC_DEFAULT_OPUS_MODEL = modelId;
  }
  return next;
}

/** OpenAI 兼容 URL（…/v3）→ Anthropic 兼容 URL（去掉 /v3） */
export function toAnthropicBaseUrl(baseUrl) {
  let url = trimSlash(baseUrl);
  if (!url) return VOLCENGINE_ANTHROPIC_ENDPOINTS.agent;
  url = url.replace(/\/v3$/i, "");
  if (/\/api\/plan$/i.test(url)) return url;
  if (/\/api\/coding$/i.test(url)) return url;
  if (/ark\.cn-beijing\.volces\.com/i.test(url) && /\/api\/coding/i.test(url)) {
    return VOLCENGINE_ANTHROPIC_ENDPOINTS.coding;
  }
  if (/ark\.cn-beijing\.volces\.com/i.test(url)) {
    return VOLCENGINE_ANTHROPIC_ENDPOINTS.agent;
  }
  return url;
}

export function resolveVolcengineClaudeCreds(overrides = {}) {
  const cfg = getConfig()?.apiEngines?.volcengine || {};
  const apiKey = String(overrides.apiKey || cfg.apiKey || "").trim();
  const openaiBase = trimSlash(overrides.baseUrl || cfg.baseUrl || "https://ark.cn-beijing.volces.com/api/plan/v3");
  const anthropicBaseUrl = toAnthropicBaseUrl(overrides.anthropicBaseUrl || openaiBase);
  const extendedContext = overrides.extendedContext != null
    ? !!overrides.extendedContext
    : cfg.claudeExtendedContext !== false;
  const rawModel = String(overrides.model || cfg.model || "ark-code-latest").trim() || "ark-code-latest";
  const model = normalizeClaudeVolcengineModelId(rawModel, { extendedContext });
  const availableModels = Array.isArray(overrides.availableModels)
    ? overrides.availableModels
    : (Array.isArray(cfg.availableModels) ? cfg.availableModels : []);
  return {
    apiKey,
    openaiBaseUrl: openaiBase,
    anthropicBaseUrl,
    model,
    rawModel,
    extendedContext,
    availableModels,
    enabled: !!cfg.enabled,
    hasKey: !!(apiKey && !/\*{3,}/.test(apiKey)),
  };
}

export function isClaudeVolcengineReady(overrides = {}) {
  const creds = resolveVolcengineClaudeCreds(overrides);
  return !!(creds.enabled && creds.hasKey);
}

/**
 * 为 claude-volcengine 子进程注入 env（不改官方 ~/.claude）。
 */
export function buildClaudeVolcengineSpawnEnv(baseEnv = process.env, overrides = {}) {
  const creds = resolveVolcengineClaudeCreds(overrides);
  if (!creds.hasKey) {
    throw new Error("Claude（火山方舟）未配置：请先在设置页启用火山方舟并填写 Agent Plan API Key");
  }
  const home = overrides.home || homedir();
  const configDir = getClaudeVolcengineConfigDir(home);
  const env = { ...baseEnv };
  env.CLAUDE_CONFIG_DIR = configDir;
  env.ANTHROPIC_BASE_URL = creds.anthropicBaseUrl;
  env.ANTHROPIC_AUTH_TOKEN = creds.apiKey;
  env.ANTHROPIC_MODEL = creds.model;
  applyExtendedContextEnv(env, creds.model, { extendedContext: creds.extendedContext });
  // 避免与官方 API Key 环境变量冲突
  delete env.ANTHROPIC_API_KEY;
  return { env, creds, configDir, model: creds.model };
}

/**
 * 一键配置 Claude × 方舟：
 * 1) 备份官方配置到 ~/.claude-official（故事点「Claude（官方）」）
 * 2) 写入 ~/.claude-volcengine（故事点「Claude（火山方舟）」）
 * 3) 合并写入默认 ~/.claude/settings.json（终端 `claude` 立即走方舟，对齐方舟文档）
 */
export function applyVolcengineToClaude(opts = {}) {
  const creds = resolveVolcengineClaudeCreds(opts);
  if (!creds.hasKey) {
    return { ok: false, error: "请先在设置页「火山方舟」填入有效 API Key 并保存" };
  }
  const home = opts.home || homedir();
  const configDir = getClaudeVolcengineConfigDir(home);
  const settingsPath = getClaudeVolcengineSettingsPath(home);
  const defaultSettingsPath = getDefaultClaudeSettingsPath(home);
  const writeDefault = opts.writeDefaultClaude !== false;
  const env = {
    ANTHROPIC_BASE_URL: creds.anthropicBaseUrl,
    ANTHROPIC_AUTH_TOKEN: creds.apiKey,
    ANTHROPIC_MODEL: creds.model,
  };
  applyExtendedContextEnv(env, creds.model, { extendedContext: creds.extendedContext });
  const settings = { env, model: creds.model };
  let officialProfile;
  try {
    // 必须先备份官方目录，再改默认 ~/.claude
    officialProfile = ensureClaudeOfficialProfile(home);
    mkdirSync(configDir, { recursive: true });
    writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
    if (writeDefault) {
      mergeClaudeSettingsEnv(defaultSettingsPath, env, { model: creds.model });
    }
  } catch (err) {
    return { ok: false, error: `写入失败：${err?.message || err}`, path: settingsPath };
  }
  return {
    ok: true,
    path: settingsPath,
    configDir,
    defaultSettingsPath: writeDefault ? defaultSettingsPath : null,
    officialConfigDir: officialProfile?.configDir || getClaudeOfficialConfigDir(home),
    engineId: CLAUDE_VOLCENGINE_ENGINE_ID,
    model: creds.model,
    extendedContext: creds.extendedContext,
    extendedContext1M: isExtendedContext1MModel(creds.model),
    anthropicBaseUrl: creds.anthropicBaseUrl,
    displayName: "Claude（火山方舟）",
    officialEngineId: CLAUDE_OFFICIAL_ENGINE_ID,
    officialDisplayName: "Claude（官方）",
    hint: writeDefault
      ? `默认模型已设为 ${creds.model}；终端 claude / 故事点「Claude（火山方舟）」均使用该默认（故事点可再单独覆盖）。`
      : `已写入隔离目录，默认模型 ${creds.model}；故事点请选「Claude（火山方舟）」。`,
  };
}

export function readClaudeVolcengineStatus(opts = {}) {
  const home = opts.home || homedir();
  const settingsPath = getClaudeVolcengineSettingsPath(home);
  const configDir = getClaudeVolcengineConfigDir(home);
  const defaultSettingsPath = getDefaultClaudeSettingsPath(home);
  const creds = resolveVolcengineClaudeCreds(opts);
  let settingsOk = false;
  let configuredModel = "";
  let configuredBase = "";
  if (existsSync(settingsPath)) {
    try {
      const data = JSON.parse(readFileSync(settingsPath, "utf8"));
      const env = data?.env && typeof data.env === "object" ? data.env : {};
      configuredModel = String(env.ANTHROPIC_MODEL || "").trim();
      configuredBase = String(env.ANTHROPIC_BASE_URL || "").trim();
      settingsOk = !!(configuredBase && env.ANTHROPIC_AUTH_TOKEN);
    } catch {
      settingsOk = false;
    }
  }
  const defaultEnv = readJsonObject(defaultSettingsPath).env || {};
  const defaultReady = !!(
    String(defaultEnv.ANTHROPIC_BASE_URL || "").trim()
    && String(defaultEnv.ANTHROPIC_AUTH_TOKEN || "").trim()
  );
  return {
    ok: true,
    engineId: CLAUDE_VOLCENGINE_ENGINE_ID,
    displayName: "Claude（火山方舟）",
    officialEngineId: CLAUDE_OFFICIAL_ENGINE_ID,
    officialDisplayName: "Claude（官方）",
    configDir,
    settingsPath,
    defaultSettingsPath,
    defaultClaudeReady: defaultReady,
    defaultClaudeSource: detectDefaultClaudeSource(home),
    officialConfigDir: getClaudeOfficialConfigDir(home),
    settingsReady: settingsOk,
    apiReady: isClaudeVolcengineReady(opts),
    model: configuredModel || creds.model,
    anthropicBaseUrl: configuredBase || creds.anthropicBaseUrl,
  };
}
