/**
 * Codex CLI × MiniMax（OpenAI 兼容协议 / responses API）
 *
 * 配置落点（一键配置后）：
 * - 默认 ~/.codex/config.toml：写入 minimax [model_providers.minimax] + 顶层 model/model_provider
 *   -> 终端直接 `codex` 走 minimax（对齐官方文档）
 * - ~/.codex-minimax/config.toml：故事点引擎 `codex-minimax` 专用（CODEX_HOME）
 * - ~/.codex-official：故事点引擎 `codex`（官方）专用，备份官方 config.toml + auth.json，
 *   避免默认目录被 minimax 写入后官方 codex 串到 minimax
 *
 * 与 Claude×MiniMax 的关键区别：
 * - codex 配置是 TOML（~/.codex/config.toml），不是 JSON；本仓库无 TOML 写入器，这里手写序列化
 * - codex 用 CODEX_HOME 隔离目录（类比 CLAUDE_CONFIG_DIR）
 * - 凭证落在 config.toml 的 experimental_bearer_token（官方文档方式），不靠环境变量注入
 * - codex 走 OpenAI 兼容端点 https://api.minimaxi.com/v1（Claude 版走 /anthropic）
 * - codex 无「工作区信任弹窗」机制，不需要 ensureTrust
 *
 * 官方配置（https://platform.minimaxi.com/docs/token-plan/codex.md）：
 *   model = "MiniMax-M3"
 *   model_provider = "minimax"
 *   model_context_window = 1000000
 *   [model_providers.minimax]
 *   name = "MiniMax"
 *   base_url = "https://api.minimaxi.com/v1"
 *   experimental_bearer_token = "<MINIMAX_API_KEY>"
 *   wire_api = "responses"
 */
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { getConfig } from "./config.js";
import { writeAppMarketMcpToCodexConfig } from "./appmarket-admin-mcp.js";
import {
  ATLAS_CODEX_PROVIDER_ID,
  buildCodexAtlasSpawnEnv,
  isCodexAtlasEngine,
} from "./atlas-client-config.js";

export const CODEX_MINIMAX_ENGINE_ID = "codex-minimax";
/** 官方 codex 引擎 ID（与 dispatcher / agent-runner 既有字符串一致） */
export const CODEX_OFFICIAL_ENGINE_ID = "codex";

/** minimax OpenAI 兼容端点（codex 走 /v1，不是 Claude 版的 /anthropic） */
export const MINIMAX_OPENAI_BASE_URL = "https://api.minimaxi.com/v1";

/** 默认 model_context_window（MiniMax-M3 支持 1M） */
const MINIMAX_CODEX_CONTEXT_WINDOW = 1000000;

/** 顶层需要剥离/覆盖的键（切换 provider 时清理） */
const CODEX_TOPLEVEL_PROVIDER_KEYS = ["model", "model_provider", "model_context_window"];

// ───────────────────────── 路径 ─────────────────────────

/** 故事点「Codex（MiniMax）」隔离配置目录 */
export function getCodexMinimaxConfigDir(home = homedir()) {
  return join(String(home || ""), ".codex-minimax");
}
export function getCodexMinimaxConfigPath(home = homedir()) {
  return join(getCodexMinimaxConfigDir(home), "config.toml");
}

/** codex 默认配置目录（终端直接运行 `codex` 时使用） */
export function getDefaultCodexConfigDir(home = homedir()) {
  return join(String(home || ""), ".codex");
}
export function getDefaultCodexConfigPath(home = homedir()) {
  return join(getDefaultCodexConfigDir(home), "config.toml");
}

/** 官方 codex 隔离目录（默认 ~/.codex 写入 minimax 后，故事点「官方」走这里） */
export function getCodexOfficialConfigDir(home = homedir()) {
  return join(String(home || ""), ".codex-official");
}
export function getCodexOfficialConfigPath(home = homedir()) {
  return join(getCodexOfficialConfigDir(home), "config.toml");
}

// ───────────────────────── TOML 读写 ─────────────────────────

/** TOML 基本字符串转义（双引号） */
function tomlString(value) {
  const s = String(value ?? "");
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function parseTomlScalar(raw) {
  const v = String(raw || "").trim();
  if (!v) return "";
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    return v.slice(1, -1);
  }
  if (v === "true") return true;
  if (v === "false") return false;
  return v;
}

/**
 * 解析 codex config.toml 中切换/判定来源所需的字段。
 * 非通用 TOML 解析器：只提取顶层 model/model_provider/model_context_window
 * 与 [model_providers.<id>] 的 name/base_url/experimental_bearer_token。
 */
export function parseCodexConfigToml(text) {
  const result = {
    model: "",
    modelProvider: "",
    modelContextWindow: "",
    providers: {},
  };
  let section = "";
  for (const rawLine of String(text || "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const table = line.match(/^\[([^\]]+)\]$/);
    if (table) {
      section = table[1].trim();
      continue;
    }
    const eq = line.indexOf("=");
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    const value = parseTomlScalar(line.slice(eq + 1));
    if (section === "") {
      if (key === "model") result.model = String(value || "");
      else if (key === "model_provider") result.modelProvider = String(value || "");
      else if (key === "model_context_window") result.modelContextWindow = String(value || "");
    } else if (section.startsWith("model_providers.")) {
      const providerId = section.slice("model_providers.".length).trim();
      if (!result.providers[providerId]) result.providers[providerId] = {};
      const p = result.providers[providerId];
      if (key === "base_url") p.baseUrl = String(value || "");
      else if (key === "name") p.name = String(value || "");
      else if (key === "experimental_bearer_token") p.hasToken = !!value;
      else if (key === "wire_api") p.wireApi = String(value || "");
      else if (key === "requires_openai_auth") p.requiresOpenAiAuth = value === true;
    }
  }
  return result;
}

/** 生成完整的 minimax codex config.toml 内容（顶层 + [model_providers.minimax]） */
export function serializeMinimaxCodexToml(creds) {
  return [
    `model = ${tomlString(creds.model || "MiniMax-M3")}`,
    `model_provider = ${tomlString("minimax")}`,
    `model_context_window = ${MINIMAX_CODEX_CONTEXT_WINDOW}`,
    "",
    "[model_providers.minimax]",
    `name = ${tomlString("MiniMax")}`,
    `base_url = ${tomlString(creds.baseUrl || MINIMAX_OPENAI_BASE_URL)}`,
    `experimental_bearer_token = ${tomlString(creds.apiKey || "")}`,
    `wire_api = ${tomlString("responses")}`,
  ].join("\n");
}

/**
 * 在已有 config.toml 文本上合并写入 minimax 配置：
 * - 剥离顶层 model / model_provider / model_context_window（root section 内）
 * - 剥离旧的 [model_providers.minimax] 段
 * - 保留其余字段（profiles / model_reasoning_effort / 其他 provider 等）
 * - 追加最新 minimax 段
 */
export function mergeMinimaxIntoCodexToml(existingText, creds) {
  const lines = String(existingText || "").split(/\r?\n/);
  const rootLines = [];  // root section 保留行（剥离顶层 provider 键）
  const tableLines = []; // table section 保留行（剥离 [model_providers.minimax] 段）
  let section = "";
  let skippingMinimax = false;
  for (const raw of lines) {
    const line = raw.trim();
    const table = line.match(/^\[([^\]]+)\]$/);
    if (table) {
      section = table[1].trim();
      skippingMinimax = section === "model_providers.minimax";
      if (skippingMinimax) continue; // 丢弃 [model_providers.minimax] 行
      tableLines.push(raw);
      continue;
    }
    if (skippingMinimax) continue; // 丢弃 minimax 段内行
    if (section === "") {
      const kv = line.match(/^([A-Za-z0-9_-]+)\s*=/);
      if (kv && CODEX_TOPLEVEL_PROVIDER_KEYS.includes(kv[1])) continue; // 丢弃顶层 provider 键
      rootLines.push(raw);
    } else {
      tableLines.push(raw);
    }
  }
  // 重组：顶层键必须在所有 [table] 之前（TOML 规则），否则会被归入上一个 table 段。
  // 顺序：保留的 root 行 -> 新 minimax 顶层键 -> 保留的 table 段 -> 新 [model_providers.minimax] 段
  const rootBody = rootLines.join("\n").replace(/\n+$/, "");
  const tableBody = tableLines.join("\n").replace(/\n+$/, "");
  const minimaxTop = [
    `model = ${tomlString(creds.model || "MiniMax-M3")}`,
    `model_provider = ${tomlString("minimax")}`,
    `model_context_window = ${MINIMAX_CODEX_CONTEXT_WINDOW}`,
  ].join("\n");
  const minimaxTable = [
    "[model_providers.minimax]",
    `name = ${tomlString("MiniMax")}`,
    `base_url = ${tomlString(creds.baseUrl || MINIMAX_OPENAI_BASE_URL)}`,
    `experimental_bearer_token = ${tomlString(creds.apiKey || "")}`,
    `wire_api = ${tomlString("responses")}`,
  ].join("\n");
  const parts = [];
  if (rootBody) parts.push(rootBody);
  parts.push(minimaxTop);
  if (tableBody) parts.push(tableBody);
  parts.push(minimaxTable);
  return `${parts.join("\n\n")}\n`;
}

/**
 * 剥离 minimax 相关配置（顶层 model/model_provider/model_context_window + [model_providers.minimax] 段），
 * 供备份官方目录时清理可能的 minimax 污染，确保官方 codex 目录干净。
 */
function stripMinimaxFromCodexToml(existingText) {
  const lines = String(existingText || "").split(/\r?\n/);
  const kept = [];
  let section = "";
  let skippingMinimax = false;
  for (const raw of lines) {
    const line = raw.trim();
    const table = line.match(/^\[([^\]]+)\]$/);
    if (table) {
      section = table[1].trim();
      skippingMinimax = section === "model_providers.minimax";
      if (skippingMinimax) continue;
      kept.push(raw);
      continue;
    }
    if (skippingMinimax) continue;
    if (section === "") {
      const kv = line.match(/^([A-Za-z0-9_-]+)\s*=/);
      if (kv && CODEX_TOPLEVEL_PROVIDER_KEYS.includes(kv[1])) continue;
    }
    kept.push(raw);
  }
  return kept.join("\n").replace(/\n+$/, "\n");
}

// ───────────────────────── 凭证 ─────────────────────────

export function isCodexMinimaxEngine(engine) {
  return String(engine || "").trim().toLowerCase() === CODEX_MINIMAX_ENGINE_ID;
}

/**
 * 从 apiEngines.minimax 解析 codex 凭证。
 * codex 走 OpenAI 兼容端点 /v1（与 Claude 版 resolveMinimaxClaudeCreds 把 /v1 转 /anthropic 不同）。
 * 若用户把 baseUrl 误填成 /anthropic，这里转回 /v1。
 */
export function resolveMinimaxCodexCreds(overrides = {}) {
  const cfg = getConfig()?.apiEngines?.minimax || {};
  const apiKey = String(overrides.apiKey || cfg.apiKey || "").trim();
  let baseUrl = String(overrides.baseUrl || cfg.baseUrl || MINIMAX_OPENAI_BASE_URL)
    .trim()
    .replace(/\/+$/, "");
  if (/\/anthropic$/i.test(baseUrl)) baseUrl = baseUrl.replace(/\/anthropic$/i, "/v1");
  if (!baseUrl) baseUrl = MINIMAX_OPENAI_BASE_URL;
  const model = String(overrides.model || cfg.model || "MiniMax-M3").trim() || "MiniMax-M3";
  return {
    apiKey,
    baseUrl,
    model,
    enabled: !!cfg.enabled,
    hasKey: !!(apiKey && !/\*{3,}/.test(apiKey)),
  };
}

export function isCodexMinimaxReady(overrides = {}) {
  const creds = resolveMinimaxCodexCreds(overrides);
  return !!(creds.enabled && creds.hasKey);
}

// ───────────────────────── 来源判定 ─────────────────────────

/**
 * 按默认 ~/.codex/config.toml 判定当前终端 codex 走哪个来源。
 * 供设置页/故事点展示，明确区分多个 Codex 来源（minimax / 官方 / 自定义）。
 * @returns {"minimax"|"custom"|"official"}
 */
export function detectDefaultCodexSource(home = homedir()) {
  const path = getDefaultCodexConfigPath(home);
  if (!existsSync(path)) return "official";
  let parsed;
  try {
    parsed = parseCodexConfigToml(readFileSync(path, "utf8"));
  } catch {
    return "official";
  }
  if (parsed.modelProvider === "minimax") return "minimax";
  const mm = parsed.providers.minimax;
  if (mm && /api\.minimaxi\.com/.test(mm.baseUrl || "")) return "minimax";
  const selected = parsed.providers[parsed.modelProvider];
  if (selected?.requiresOpenAiAuth && !selected.baseUrl) return "official";
  if (parsed.modelProvider && parsed.modelProvider !== "openai") return "custom";
  const providerIds = Object.keys(parsed.providers || {});
  if (providerIds.length > 0 && parsed.modelProvider) return "custom";
  return "official";
}

/** 默认来源 -> 中文展示名 */
export function describeDefaultCodexSource(source) {
  switch (source) {
    case "minimax": return "MiniMax";
    case "custom": return "自定义端点";
    default: return "OpenAI 官方";
  }
}

// ───────────────────────── 官方备份 ─────────────────────────

/**
 * 在写入默认 ~/.codex 的 minimax 配置之前，把当前官方 config.toml + auth.json 备份到 ~/.codex-official，
 * 供故事点「Codex（官方）」使用（CODEX_HOME）。首次复制；已存在则保留，避免覆盖用户在官方目录的调整。
 * 复制 config.toml 时剥离可能的 minimax 污染，确保官方目录干净。
 */
export function ensureCodexOfficialProfile(home = homedir()) {
  const officialDir = getCodexOfficialConfigDir(home);
  const officialConfig = getCodexOfficialConfigPath(home);
  const officialAuth = join(officialDir, "auth.json");
  const defaultConfig = getDefaultCodexConfigPath(home);
  const defaultAuth = join(getDefaultCodexConfigDir(home), "auth.json");
  mkdirSync(officialDir, { recursive: true });
  let created = false;
  if (!existsSync(officialConfig)) {
    if (existsSync(defaultConfig)) {
      const cleaned = stripMinimaxFromCodexToml(readFileSync(defaultConfig, "utf8"));
      writeFileSync(officialConfig, `${cleaned}\n`, "utf8");
    } else {
      writeFileSync(officialConfig, "\n", "utf8");
    }
    created = true;
  }
  // auth.json 含官方登录态（codex login），首次复制；codex 凭证刷新后用户可手动覆盖
  if (!existsSync(officialAuth) && existsSync(defaultAuth)) {
    try {
      copyFileSync(defaultAuth, officialAuth);
      created = true;
    } catch {
      /* best-effort：无登录态文件时仍可用交互 login */
    }
  }
  return { ok: true, configDir: officialDir, configPath: officialConfig, created };
}

/** 故事点「Codex（官方）」spawn：指向 ~/.codex-official（CODEX_HOME），备份官方配置 */
export function buildCodexOfficialSpawnEnv(baseEnv = process.env, overrides = {}) {
  const home = overrides.home || homedir();
  ensureCodexOfficialProfile(home);
  const env = { ...baseEnv };
  // When the user's default profile is already official, keep exec and
  // app-server on that live credential store. The backup profile is only for
  // installations whose default profile was switched to another provider.
  env.CODEX_HOME = detectDefaultCodexSource(home) === "official"
    ? getDefaultCodexConfigDir(home)
    : getCodexOfficialConfigDir(home);
  return { env, configDir: env.CODEX_HOME };
}

// ───────────────────────── 隔离目录写入 ─────────────────────────

/**
 * 确保 ~/.codex-minimax/config.toml 存在且为最新 minimax 配置。
 * codex 凭证落在 config.toml 的 experimental_bearer_token（不像 Claude 版走 env），
 * 故 spawn 前要保证隔离目录文件已写好。凭证变化时重写。
 */
function ensureCodexMinimaxConfig(home, creds) {
  const configDir = getCodexMinimaxConfigDir(home);
  const configPath = getCodexMinimaxConfigPath(home);
  mkdirSync(configDir, { recursive: true });
  const desired = `${serializeMinimaxCodexToml(creds)}\n`;
  if (existsSync(configPath)) {
    try {
      if (readFileSync(configPath, "utf8") === desired) return; // 已是最新，免写
    } catch {
      /* 写入兜底 */
    }
  }
  writeFileSync(configPath, desired, "utf8");
}

/**
 * 为 codex-minimax 子进程注入 env：设 CODEX_HOME=~/.codex-minimax，并确保隔离目录 config.toml 已写好。
 * 不向 env 注入 API key（凭证在 config.toml 的 bearer_token）。
 */
export function buildCodexMinimaxSpawnEnv(baseEnv = process.env, overrides = {}) {
  const creds = resolveMinimaxCodexCreds(overrides);
  if (!creds.hasKey) {
    throw new Error("Codex（MiniMax）未配置：请先在设置页启用 MiniMax 并填写 API Key");
  }
  const home = overrides.home || homedir();
  const configDir = getCodexMinimaxConfigDir(home);
  ensureCodexMinimaxConfig(home, creds);
  const env = { ...baseEnv };
  env.CODEX_HOME = configDir;
  return { env, creds, configDir, model: creds.model };
}

function readCodexAuthSnapshot(filePath) {
  if (!filePath || !existsSync(filePath)) return null;
  try {
    const raw = readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return {
      raw,
      digest: createHash("sha256").update(raw, "utf8").digest("hex"),
    };
  } catch {
    // Codex may be between an atomic replace and a reader observing the new
    // file. A later poll/cleanup pass will retry; never persist partial JSON.
    return null;
  }
}

function replaceCodexAuthAtomically(targetPath, raw) {
  mkdirSync(dirname(targetPath), { recursive: true });
  const temporaryPath = `${targetPath}.aiefficiency-${process.pid}-${randomUUID()}.tmp`;
  let mode = 0o600;
  try {
    mode = statSync(targetPath).mode & 0o777;
  } catch {}
  try {
    writeFileSync(temporaryPath, raw, { encoding: "utf8", mode });
    renameSync(temporaryPath, targetPath);
  } finally {
    try { rmSync(temporaryPath, { force: true }); } catch {}
  }
}

/**
 * A private app-server CODEX_HOME must not discard a rotated OAuth token.
 * Copy only complete JSON back to the authoritative profile, and use a
 * compare-and-swap guard so a stale concurrent runtime cannot overwrite a
 * newer credential written by another Codex process.
 */
function createCodexAuthBridge(sourceAuthPath, runtimeAuthPath, intervalMs = 100) {
  const initialSource = readCodexAuthSnapshot(sourceAuthPath);
  const initialRuntime = readCodexAuthSnapshot(runtimeAuthPath);
  let sourceDigest = initialSource?.digest || "";
  let runtimeDigest = initialRuntime?.digest || "";
  let stopped = false;

  const syncCredentials = () => {
    if (stopped) return { status: "stopped" };
    const runtime = readCodexAuthSnapshot(runtimeAuthPath);
    if (!runtime || runtime.digest === runtimeDigest) return { status: "unchanged" };

    const source = readCodexAuthSnapshot(sourceAuthPath);
    if (source && source.digest !== sourceDigest && source.digest !== runtime.digest) {
      return { status: "conflict" };
    }
    if (!source || source.digest !== runtime.digest) {
      replaceCodexAuthAtomically(sourceAuthPath, runtime.raw);
    }
    sourceDigest = runtime.digest;
    runtimeDigest = runtime.digest;
    return { status: "synced" };
  };

  const timer = initialRuntime
    ? setInterval(() => {
      try { syncCredentials(); } catch {}
    }, Math.max(25, Number(intervalMs) || 100))
    : null;
  timer?.unref?.();

  return {
    syncCredentials,
    stop() {
      if (timer) clearInterval(timer);
      let result = { status: "unchanged" };
      try { result = syncCredentials(); } catch { result = { status: "failed" }; }
      stopped = true;
      return result;
    },
  };
}

/**
 * app-server keeps writable runtime databases under CODEX_HOME. Reusing a
 * long-lived official/MiniMax profile across simultaneous CLI tasks can block
 * the initialize handshake, so each process gets a private runtime home seeded
 * only with the selected profile's config and authentication files.
 */
export function buildCodexAppServerSpawnEnv(baseEnv = process.env, overrides = {}) {
  const engine = String(overrides.engine || CODEX_OFFICIAL_ENGINE_ID).trim().toLowerCase();
  const home = overrides.home || homedir();
  const minimax = isCodexMinimaxEngine(engine);
  const atlas = isCodexAtlasEngine(engine);
  const isolatedProvider = minimax || atlas;
  const source = atlas
    ? buildCodexAtlasSpawnEnv(baseEnv, { ...overrides, home })
    : minimax
    ? buildCodexMinimaxSpawnEnv(baseEnv, { ...overrides, home })
    : buildCodexOfficialSpawnEnv(baseEnv, { ...overrides, home });
  const runtimeConfigDir = mkdtempSync(join(tmpdir(), "aiefficiency-codex-appserver-"));
  let runtimeSourceDir = source.configDir;
  let sourceAuthPath = "";
  let runtimeAuthPath = "";
  try {
    const sourceConfigFile = join(source.configDir, "config.toml");
    let runtimeConfigFile = sourceConfigFile;
    if (!isolatedProvider) {
      const defaultConfigFile = getDefaultCodexConfigPath(home);
      // When the user's current default is already official, preserve that
      // proven app-server configuration byte-for-byte. The backup profile is
      // still required when the default was rewritten to another provider.
      if (detectDefaultCodexSource(home) === "official") {
        runtimeSourceDir = getDefaultCodexConfigDir(home);
        runtimeConfigFile = defaultConfigFile;
      }
    }
    if (existsSync(runtimeConfigFile)) {
      copyFileSync(runtimeConfigFile, join(runtimeConfigDir, "config.toml"));
    } else {
      writeFileSync(join(runtimeConfigDir, "config.toml"), "", "utf8");
    }
    writeAppMarketMcpToCodexConfig(join(runtimeConfigDir, "config.toml"), overrides);
    sourceAuthPath = join(runtimeSourceDir, "auth.json");
    runtimeAuthPath = join(runtimeConfigDir, "auth.json");
    if (existsSync(sourceAuthPath)) copyFileSync(sourceAuthPath, runtimeAuthPath);
  } catch (error) {
    try { rmSync(runtimeConfigDir, { recursive: true, force: true }); } catch {}
    throw error;
  }
  const authBridge = !isolatedProvider && existsSync(runtimeAuthPath)
    ? createCodexAuthBridge(sourceAuthPath, runtimeAuthPath, overrides.credentialSyncIntervalMs)
    : null;
  let cleaned = false;
  return {
    ...source,
    env: { ...source.env, CODEX_HOME: runtimeConfigDir },
    sourceConfigDir: runtimeSourceDir,
    configDir: runtimeConfigDir,
    modelProvider: atlas ? ATLAS_CODEX_PROVIDER_ID : (minimax ? "minimax" : ""),
    syncCredentials() {
      return authBridge?.syncCredentials() || { status: "not-applicable" };
    },
    cleanup() {
      if (cleaned) return;
      cleaned = true;
      authBridge?.stop();
      try { rmSync(runtimeConfigDir, { recursive: true, force: true }); } catch {}
    },
  };
}

// ───────────────────────── 一键配置 ─────────────────────────

/**
 * 一键配置 Codex×MiniMax：
 * 1) 备份官方 config.toml + auth.json 到 ~/.codex-official（故事点「Codex（官方）」，复用本模块）
 * 2) 写入 ~/.codex-minimax/config.toml（故事点「Codex（MiniMax）」）
 * 3) 合并写入默认 ~/.codex/config.toml（终端 `codex` 立即走 minimax，对齐 minimax 文档）
 */
export function applyMinimaxToCodex(opts = {}) {
  const creds = resolveMinimaxCodexCreds(opts);
  if (!creds.hasKey) {
    return { ok: false, error: "请先在设置页「MiniMax」填入有效 API Key 并保存" };
  }
  const home = opts.home || homedir();
  const configDir = getCodexMinimaxConfigDir(home);
  const configPath = getCodexMinimaxConfigPath(home);
  const defaultConfigPath = getDefaultCodexConfigPath(home);
  const writeDefault = opts.writeDefaultCodex !== false;
  let officialProfile;
  try {
    // 必须先备份官方目录，再改默认 ~/.codex
    officialProfile = ensureCodexOfficialProfile(home);
    mkdirSync(configDir, { recursive: true });
    writeFileSync(configPath, `${serializeMinimaxCodexToml(creds)}\n`, "utf8");
    if (writeDefault) {
      const existing = existsSync(defaultConfigPath) ? readFileSync(defaultConfigPath, "utf8") : "";
      mkdirSync(join(defaultConfigPath, ".."), { recursive: true });
      writeFileSync(defaultConfigPath, mergeMinimaxIntoCodexToml(existing, creds), "utf8");
    }
  } catch (err) {
    return { ok: false, error: `写入失败：${err?.message || err}`, path: configPath };
  }
  return {
    ok: true,
    path: configPath,
    configDir,
    defaultConfigPath: writeDefault ? defaultConfigPath : null,
    officialConfigDir: officialProfile?.configDir || getCodexOfficialConfigDir(home),
    engineId: CODEX_MINIMAX_ENGINE_ID,
    model: creds.model,
    baseUrl: creds.baseUrl,
    displayName: "Codex（MiniMax）",
    officialEngineId: CODEX_OFFICIAL_ENGINE_ID,
    officialDisplayName: "Codex（官方）",
    defaultCodexSource: detectDefaultCodexSource(home),
    hint: writeDefault
      ? `默认模型已设为 ${creds.model}；终端 codex / 故事点「Codex（MiniMax）」均使用该默认（故事点可再单独覆盖）。`
      : `已写入隔离目录，默认模型 ${creds.model}；故事点请选「Codex（MiniMax）」。`,
  };
}

export function readCodexMinimaxStatus(opts = {}) {
  const home = opts.home || homedir();
  const configPath = getCodexMinimaxConfigPath(home);
  const configDir = getCodexMinimaxConfigDir(home);
  const defaultConfigPath = getDefaultCodexConfigPath(home);
  const creds = resolveMinimaxCodexCreds(opts);
  let settingsOk = false;
  let configuredModel = "";
  let configuredBase = "";
  if (existsSync(configPath)) {
    try {
      const parsed = parseCodexConfigToml(readFileSync(configPath, "utf8"));
      configuredModel = parsed.model || "";
      const mm = parsed.providers.minimax || {};
      configuredBase = mm.baseUrl || "";
      settingsOk = !!(parsed.modelProvider === "minimax" && configuredBase && mm.hasToken);
    } catch {
      settingsOk = false;
    }
  }
  let defaultReady = false;
  if (existsSync(defaultConfigPath)) {
    try {
      const parsed = parseCodexConfigToml(readFileSync(defaultConfigPath, "utf8"));
      const mm = parsed.providers.minimax || {};
      defaultReady = !!(parsed.modelProvider === "minimax" && mm.baseUrl && mm.hasToken);
    } catch {
      defaultReady = false;
    }
  }
  return {
    ok: true,
    engineId: CODEX_MINIMAX_ENGINE_ID,
    displayName: "Codex（MiniMax）",
    officialEngineId: CODEX_OFFICIAL_ENGINE_ID,
    officialDisplayName: "Codex（官方）",
    configDir,
    configPath,
    defaultConfigPath,
    defaultCodexReady: defaultReady,
    defaultCodexSource: detectDefaultCodexSource(home),
    officialConfigDir: getCodexOfficialConfigDir(home),
    settingsReady: settingsOk,
    apiReady: isCodexMinimaxReady(opts),
    model: configuredModel || creds.model,
    baseUrl: configuredBase || creds.baseUrl,
  };
}
