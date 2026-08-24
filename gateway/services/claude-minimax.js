/**
 * Claude Code × MiniMax（Anthropic 兼容协议）
 *
 * 配置落点（一键配置后）：
 * - 默认 ~/.claude/settings.json：写入 minimax ANTHROPIC_* -> 终端直接 `claude` 走 minimax（对齐官方文档）
 * - ~/.claude-minimax：故事点引擎 `claude-minimax` 专用（CLAUDE_CONFIG_DIR）
 * - ~/.claude-official：故事点引擎 `claude`（官方）专用，复用方舟模块的备份，避免默认目录被污染后无法区分
 *
 * 与火山方舟的关键区别：
 * - minimax 用 ANTHROPIC_API_KEY（方舟用 ANTHROPIC_AUTH_TOKEN），凭证字段不同
 * - 写默认 ~/.claude 前先剥离所有 ANTHROPIC_* 键（含方舟 AUTH_TOKEN 与残留 API_KEY），
 *   再写 minimax 的 API_KEY，避免 AUTH_TOKEN/API_KEY 并存导致 Claude Code 读错凭证
 *
 * Anthropic 端点：https://api.minimaxi.com/anthropic（MiniMax-M3 支持 1M 上下文）
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { getConfig } from "./config.js";
import {
  CLAUDE_OFFICIAL_ENGINE_ID,
  detectDefaultClaudeSource,
  ensureClaudeOfficialProfile,
  getDefaultClaudeSettingsPath,
  getClaudeOfficialConfigDir,
} from "./claude-volcengine.js";

export const CLAUDE_MINIMAX_ENGINE_ID = "claude-minimax";

/** minimax Anthropic 兼容端点 */
export const MINIMAX_ANTHROPIC_BASE_URL = "https://api.minimaxi.com/anthropic";

/**
 * 写入/剥离时识别的 Anthropic 相关 env 键并集（与方舟一致）。
 * minimax 写默认 ~/.claude 前用 stripAnthropicEnvKeys 清掉这些键，确保与方舟切换互不残留。
 */
const CLAUDE_ANTHROPIC_ENV_KEYS = [
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_MODEL",
  "ANTHROPIC_DEFAULT_SONNET_MODEL",
  "ANTHROPIC_DEFAULT_OPUS_MODEL",
  "CLAUDE_CODE_AUTO_COMPACT_WINDOW",
  "API_TIMEOUT_MS",
];

export function getClaudeMinimaxConfigDir(home = homedir()) {
  return join(String(home || ""), ".claude-minimax");
}

export function getClaudeMinimaxSettingsPath(home = homedir()) {
  return join(getClaudeMinimaxConfigDir(home), "settings.json");
}

export function getClaudeMinimaxJsonPath(home = homedir()) {
  return join(getClaudeMinimaxConfigDir(home), ".claude.json");
}

function readJsonObject(p) {
  if (!existsSync(p)) return {};
  try {
    const data = JSON.parse(readFileSync(p, "utf8"));
    return data && typeof data === "object" && !Array.isArray(data) ? data : {};
  } catch {
    return {};
  }
}

function stripAnthropicEnvKeys(env = {}) {
  const next = { ...(env && typeof env === "object" ? env : {}) };
  for (const key of CLAUDE_ANTHROPIC_ENV_KEYS) delete next[key];
  return next;
}

export function isClaudeMinimaxEngine(engine) {
  return String(engine || "").trim().toLowerCase() === CLAUDE_MINIMAX_ENGINE_ID;
}

export function resolveMinimaxClaudeCreds(overrides = {}) {
  const cfg = getConfig()?.apiEngines?.minimax || {};
  const apiKey = String(overrides.apiKey || cfg.apiKey || "").trim();
  const rawBase = String(overrides.anthropicBaseUrl || cfg.baseUrl || MINIMAX_ANTHROPIC_BASE_URL)
    .trim()
    .replace(/\/+$/, "");
  // OpenAI 兼容端点(/v1) -> Anthropic 兼容端点(/anthropic)，与方舟 toAnthropicBaseUrl 同理
  const anthropicBaseUrl = rawBase ? rawBase.replace(/\/v1$/i, "/anthropic") : MINIMAX_ANTHROPIC_BASE_URL;
  const model = String(overrides.model || cfg.model || "MiniMax-M3").trim() || "MiniMax-M3";
  return {
    apiKey,
    anthropicBaseUrl,
    model,
    enabled: !!cfg.enabled,
    hasKey: !!(apiKey && !/\*{3,}/.test(apiKey)),
  };
}

export function isClaudeMinimaxReady(overrides = {}) {
  const creds = resolveMinimaxClaudeCreds(overrides);
  return !!(creds.enabled && creds.hasKey);
}

/**
 * 为 claude-minimax 子进程注入 env（不改默认 ~/.claude）。
 */
export function buildClaudeMinimaxSpawnEnv(baseEnv = process.env, overrides = {}) {
  const creds = resolveMinimaxClaudeCreds(overrides);
  if (!creds.hasKey) {
    throw new Error("Claude（MiniMax）未配置：请先在设置页启用 MiniMax 并填写 API Key");
  }
  const home = overrides.home || homedir();
  const configDir = getClaudeMinimaxConfigDir(home);
  const env = { ...baseEnv };
  env.CLAUDE_CONFIG_DIR = configDir;
  env.ANTHROPIC_BASE_URL = creds.anthropicBaseUrl;
  env.ANTHROPIC_API_KEY = creds.apiKey;
  env.ANTHROPIC_MODEL = creds.model;
  // MiniMax-M3 支持 1M 上下文，抬高 compact 窗口避免长会话过早压缩
  env.CLAUDE_CODE_AUTO_COMPACT_WINDOW = "1000000";
  env.API_TIMEOUT_MS = env.API_TIMEOUT_MS || "3000000";
  // 避免与方舟 AUTH_TOKEN 冲突
  delete env.ANTHROPIC_AUTH_TOKEN;
  return { env, creds, configDir, model: creds.model };
}

/**
 * 在隔离配置目录 ~/.claude-minimax/.claude.json 里把工作目录标记为「已信任」。
 * 与方舟 ensureClaudeVolcengineTrust 同理：非交互(-p)运行需预先接受工作区信任弹窗，否则报
 * "this workspace has not been trusted" 退出 1。
 */
export function ensureClaudeMinimaxTrust(dirs = [], home = homedir()) {
  const list = (Array.isArray(dirs) ? dirs : [dirs])
    .map((d) => String(d || "").trim())
    .filter(Boolean);
  if (!list.length) return { ok: true, changed: false, trusted: [] };
  const configDir = getClaudeMinimaxConfigDir(home);
  const jsonPath = getClaudeMinimaxJsonPath(home);
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

/**
 * 把 minimax env 合并到 Claude settings.json：先剥离所有 ANTHROPIC_* 键（含方舟 AUTH_TOKEN
 * 与残留 API_KEY），再写 minimax 的 API_KEY，避免凭证冲突。保留 theme / 权限等其它字段。
 */
function mergeMinimaxClaudeSettingsEnv(settingsPath, envPatch = {}, { model } = {}) {
  const data = readJsonObject(settingsPath);
  const prevEnv = data.env && typeof data.env === "object" ? data.env : {};
  const cleaned = stripAnthropicEnvKeys(prevEnv);
  const patch = envPatch && typeof envPatch === "object" ? envPatch : {};
  data.env = { ...cleaned, ...patch };
  // minimax 用 API_KEY；避免与方舟 AUTH_TOKEN 并存
  delete data.env.ANTHROPIC_AUTH_TOKEN;
  const modelId = String(model || patch.ANTHROPIC_MODEL || data.env.ANTHROPIC_MODEL || "").trim();
  if (modelId) data.model = modelId;
  mkdirSync(join(settingsPath, ".."), { recursive: true });
  writeFileSync(settingsPath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  return { ok: true, path: settingsPath, env: data.env, model: data.model };
}

/**
 * 一键配置 Claude × MiniMax：
 * 1) 备份官方配置到 ~/.claude-official（故事点「Claude（官方）」，复用方舟模块）
 * 2) 写入 ~/.claude-minimax（故事点「Claude（MiniMax）」）
 * 3) 合并写入默认 ~/.claude/settings.json（终端 `claude` 立即走 minimax，对齐 minimax 文档）
 */
export function applyMinimaxToClaude(opts = {}) {
  const creds = resolveMinimaxClaudeCreds(opts);
  if (!creds.hasKey) {
    return { ok: false, error: "请先在设置页「MiniMax」填入有效 API Key 并保存" };
  }
  const home = opts.home || homedir();
  const configDir = getClaudeMinimaxConfigDir(home);
  const settingsPath = getClaudeMinimaxSettingsPath(home);
  const defaultSettingsPath = getDefaultClaudeSettingsPath(home);
  const writeDefault = opts.writeDefaultClaude !== false;
  const env = {
    ANTHROPIC_BASE_URL: creds.anthropicBaseUrl,
    ANTHROPIC_API_KEY: creds.apiKey,
    ANTHROPIC_MODEL: creds.model,
    CLAUDE_CODE_AUTO_COMPACT_WINDOW: "1000000",
  };
  const settings = { env, model: creds.model };
  let officialProfile;
  try {
    // 必须先备份官方目录，再改默认 ~/.claude
    officialProfile = ensureClaudeOfficialProfile(home);
    mkdirSync(configDir, { recursive: true });
    writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
    if (writeDefault) {
      mergeMinimaxClaudeSettingsEnv(defaultSettingsPath, env, { model: creds.model });
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
    engineId: CLAUDE_MINIMAX_ENGINE_ID,
    model: creds.model,
    anthropicBaseUrl: creds.anthropicBaseUrl,
    displayName: "Claude（MiniMax）",
    officialEngineId: CLAUDE_OFFICIAL_ENGINE_ID,
    officialDisplayName: "Claude（官方）",
    defaultClaudeSource: detectDefaultClaudeSource(home),
    hint: writeDefault
      ? `默认模型已设为 ${creds.model}；终端 claude / 故事点「Claude（MiniMax）」均使用该默认（故事点可再单独覆盖）。`
      : `已写入隔离目录，默认模型 ${creds.model}；故事点请选「Claude（MiniMax）」。`,
  };
}

export function readClaudeMinimaxStatus(opts = {}) {
  const home = opts.home || homedir();
  const settingsPath = getClaudeMinimaxSettingsPath(home);
  const configDir = getClaudeMinimaxConfigDir(home);
  const defaultSettingsPath = getDefaultClaudeSettingsPath(home);
  const creds = resolveMinimaxClaudeCreds(opts);
  let settingsOk = false;
  let configuredModel = "";
  let configuredBase = "";
  if (existsSync(settingsPath)) {
    try {
      const data = JSON.parse(readFileSync(settingsPath, "utf8"));
      const env = data?.env && typeof data.env === "object" ? data.env : {};
      configuredModel = String(env.ANTHROPIC_MODEL || "").trim();
      configuredBase = String(env.ANTHROPIC_BASE_URL || "").trim();
      settingsOk = !!(configuredBase && env.ANTHROPIC_API_KEY);
    } catch {
      settingsOk = false;
    }
  }
  const defaultEnv = readJsonObject(defaultSettingsPath).env || {};
  const defaultReady = !!(
    String(defaultEnv.ANTHROPIC_BASE_URL || "").trim()
    && String(defaultEnv.ANTHROPIC_API_KEY || "").trim()
  );
  return {
    ok: true,
    engineId: CLAUDE_MINIMAX_ENGINE_ID,
    displayName: "Claude（MiniMax）",
    officialEngineId: CLAUDE_OFFICIAL_ENGINE_ID,
    officialDisplayName: "Claude（官方）",
    configDir,
    settingsPath,
    defaultSettingsPath,
    defaultClaudeReady: defaultReady,
    defaultClaudeSource: detectDefaultClaudeSource(home),
    officialConfigDir: getClaudeOfficialConfigDir(home),
    settingsReady: settingsOk,
    apiReady: isClaudeMinimaxReady(opts),
    model: configuredModel || creds.model,
    anthropicBaseUrl: configuredBase || creds.anthropicBaseUrl,
  };
}