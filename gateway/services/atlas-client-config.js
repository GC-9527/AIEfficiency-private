/**
 * Atlas Cloud Coding Plan 一键写入本机 AI 工具的全局配置。
 *
 * 安全约束：
 * - 只写固定的用户级配置路径或 Hermes CLI 自己报告的配置路径；
 * - 写前备份，使用临时文件替换；多文件操作失败时恢复原内容；
 * - API Key 不进入日志、错误文本或返回体；
 * - 合并保留其它 provider、模型、MCP 与用户自定义字段。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { getConfig } from "./config.js";
import { hermesExecutable, hermesInstallGuide } from "./hermes-cli.js";

const execFileAsync = promisify(execFile);

export const ATLAS_ENGINE_ID = "atlas";
export const ATLAS_OPENAI_BASE_URL = "https://api.atlascloud.ai/v1";
export const ATLAS_ANTHROPIC_BASE_URL = "https://api.atlascloud.ai";
export const ATLAS_DEFAULT_MODEL = "zai-org/glm-5.1";
export const ATLAS_CODEX_PROVIDER_ID = "atlas_coding_plan";
export const ATLAS_OPENCODE_PROVIDER_ID = "atlascloud";
export const ATLAS_CLIENT_TOOLS = new Set(["codex", "claude", "opencode", "hermes"]);
export const ATLAS_CLAUDE_ENGINE_ID = "claude-atlas";
export const ATLAS_CODEX_ENGINE_ID = "codex-atlas";
export const ATLAS_HERMES_ENGINE_ID = "hermes-atlas";
export const ATLAS_STORY_ENGINE_IDS = new Set([
  ATLAS_CLAUDE_ENGINE_ID,
  ATLAS_CODEX_ENGINE_ID,
  ATLAS_HERMES_ENGINE_ID,
]);

function clean(value) {
  return String(value || "").trim();
}

function trimSlash(value) {
  return clean(value).replace(/\/+$/, "");
}

function isMasked(value) {
  return /\*{3,}/.test(String(value || ""));
}

export function isClaudeAtlasEngine(engine) {
  return clean(engine).toLowerCase() === ATLAS_CLAUDE_ENGINE_ID;
}

export function isCodexAtlasEngine(engine) {
  return clean(engine).toLowerCase() === ATLAS_CODEX_ENGINE_ID;
}

export function isHermesAtlasEngine(engine) {
  return clean(engine).toLowerCase() === ATLAS_HERMES_ENGINE_ID;
}

export function isAtlasStoryEngine(engine) {
  return ATLAS_STORY_ENGINE_IDS.has(clean(engine).toLowerCase());
}

export function isAtlasReady(overrides = {}) {
  const stored = getConfig()?.apiEngines?.[ATLAS_ENGINE_ID] || {};
  const apiKey = clean(overrides.apiKey || stored.apiKey);
  const baseUrl = trimSlash(overrides.baseUrl || stored.baseUrl || ATLAS_OPENAI_BASE_URL);
  const enabled = overrides.enabled == null ? !!stored.enabled : !!overrides.enabled;
  return !!(enabled && apiKey && !isMasked(apiKey) && baseUrl === ATLAS_OPENAI_BASE_URL);
}

function asObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function tomlString(value) {
  return JSON.stringify(String(value ?? ""));
}

function timestampPart(now = Date.now()) {
  const date = now instanceof Date ? now : new Date(typeof now === "function" ? now() : now);
  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

function parseJsonObject(raw, label) {
  if (!clean(raw)) return {};
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`${label}解析失败：${error?.message || error}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${label}必须是 JSON 对象`);
  }
  return parsed;
}

export function resolveAtlasCredentials(overrides = {}) {
  const stored = getConfig()?.apiEngines?.[ATLAS_ENGINE_ID] || {};
  const explicitKey = clean(overrides.apiKey);
  const apiKey = explicitKey && !isMasked(explicitKey) ? explicitKey : clean(stored.apiKey);
  const baseUrl = trimSlash(overrides.baseUrl || stored.baseUrl || ATLAS_OPENAI_BASE_URL);
  const model = clean(overrides.model || stored.model || ATLAS_DEFAULT_MODEL) || ATLAS_DEFAULT_MODEL;

  if (!apiKey || isMasked(apiKey)) {
    throw new Error("请先在设置页为 Atlas Coding Plan 填入有效 API Key 并保存");
  }
  if (baseUrl !== ATLAS_OPENAI_BASE_URL) {
    throw new Error(`Atlas Base URL 必须使用官方地址 ${ATLAS_OPENAI_BASE_URL}`);
  }
  if (!model || /[\r\n]/.test(model)) {
    throw new Error("Atlas 模型 ID 无效");
  }
  return {
    apiKey,
    baseUrl,
    anthropicBaseUrl: ATLAS_ANTHROPIC_BASE_URL,
    model,
  };
}

export function getAtlasClientPaths(home = os.homedir()) {
  const root = String(home || os.homedir());
  return {
    codexConfig: path.join(root, ".codex", "config.toml"),
    codexAuth: path.join(root, ".codex", "auth.json"),
    claudeSettings: path.join(root, ".claude", "settings.json"),
    openCodeConfig: path.join(root, ".config", "opencode", "opencode.json"),
    hermesConfig: path.join(root, ".hermes", "config.yaml"),
    hermesEnv: path.join(root, ".hermes", ".env"),
    claudeStoryDir: path.join(root, ".claude-atlas"),
    codexStoryDir: path.join(root, ".codex-atlas"),
    hermesStoryDir: path.join(root, ".hermes-atlas"),
  };
}

export function mergeAtlasIntoCodexToml(existingText = "", engine = {}) {
  const lines = String(existingText || "").replace(/\r\n/g, "\n").split("\n");
  const rootLines = [];
  const tableLines = [];
  let inTable = false;
  let skippingAtlas = false;

  for (const line of lines) {
    const table = line.match(/^\s*\[([^\]]+)\]\s*(?:#.*)?$/);
    if (table) {
      inTable = true;
      skippingAtlas = clean(table[1]) === `model_providers.${ATLAS_CODEX_PROVIDER_ID}`;
      if (!skippingAtlas) tableLines.push(line);
      continue;
    }
    if (skippingAtlas) continue;
    if (!inTable && /^\s*(?:model|model_provider)\s*=/.test(line)) continue;
    (inTable ? tableLines : rootLines).push(line);
  }

  const root = rootLines.join("\n").trimEnd();
  const tables = tableLines.join("\n").trim();
  const top = [
    `model_provider = ${tomlString(ATLAS_CODEX_PROVIDER_ID)}`,
    `model = ${tomlString(engine.model || ATLAS_DEFAULT_MODEL)}`,
  ].join("\n");
  const provider = [
    `[model_providers.${ATLAS_CODEX_PROVIDER_ID}]`,
    `name = ${tomlString("atlascloud")}`,
    `base_url = ${tomlString(engine.baseUrl || ATLAS_OPENAI_BASE_URL)}`,
    `wire_api = ${tomlString("responses")}`,
    "requires_openai_auth = true",
  ].join("\n");

  return [root, top, tables, provider].filter(Boolean).join("\n\n") + "\n";
}

export function mergeAtlasIntoClaudeSettings(existing = {}, engine = {}) {
  const next = { ...asObject(existing) };
  next.env = {
    ...asObject(next.env),
    ANTHROPIC_AUTH_TOKEN: engine.apiKey,
    ANTHROPIC_BASE_URL: engine.anthropicBaseUrl || ATLAS_ANTHROPIC_BASE_URL,
    ANTHROPIC_MODEL: engine.model || ATLAS_DEFAULT_MODEL,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: engine.model || ATLAS_DEFAULT_MODEL,
    ANTHROPIC_DEFAULT_SONNET_MODEL: engine.model || ATLAS_DEFAULT_MODEL,
    CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: "1",
  };
  // Atlas 使用 Bearer Token；避免保留其它 provider 的 API Key，导致 Claude Code
  // 同时检测到两套认证变量并在每次启动时发出冲突警告。
  delete next.env.ANTHROPIC_API_KEY;
  return next;
}

export function mergeAtlasIntoOpenCodeConfig(existing = {}, engine = {}) {
  const next = { ...asObject(existing) };
  const model = engine.model || ATLAS_DEFAULT_MODEL;
  const providers = { ...asObject(next.provider) };
  const previous = asObject(providers[ATLAS_OPENCODE_PROVIDER_ID]);
  providers[ATLAS_OPENCODE_PROVIDER_ID] = {
    ...previous,
    npm: "@ai-sdk/openai-compatible",
    name: "Atlas Cloud",
    options: {
      ...asObject(previous.options),
      baseURL: engine.baseUrl || ATLAS_OPENAI_BASE_URL,
      apiKey: engine.apiKey,
    },
    models: {
      ...asObject(previous.models),
      [model]: {
        ...asObject(previous.models?.[model]),
        name: model,
      },
    },
  };
  next.$schema = next.$schema || "https://opencode.ai/config.json";
  next.provider = providers;
  next.model = `${ATLAS_OPENCODE_PROVIDER_ID}/${model}`;
  if (Array.isArray(next.enabled_providers)) {
    next.enabled_providers = [...new Set([...next.enabled_providers, ATLAS_OPENCODE_PROVIDER_ID])];
  }
  return next;
}

export function mergeDotEnv(existingText = "", key, value) {
  const name = clean(key);
  if (!/^[A-Z][A-Z0-9_]*$/.test(name)) throw new Error("环境变量名无效");
  const lines = String(existingText || "").replace(/\r\n/g, "\n").split("\n");
  const replacement = `${name}=${String(value ?? "").replace(/\r|\n/g, "")}`;
  let replaced = false;
  const next = lines.map((line) => {
    if (new RegExp(`^\\s*(?:export\\s+)?${name}\\s*=`).test(line)) {
      if (replaced) return null;
      replaced = true;
      return replacement;
    }
    return line;
  }).filter((line) => line != null);
  if (!replaced) {
    while (next.length && !next[next.length - 1]) next.pop();
    next.push(replacement);
  }
  return `${next.join("\n").replace(/\n+$/, "")}\n`;
}

function readSnapshot(filePath, io = fs) {
  if (!io.existsSync(filePath)) return { path: filePath, existed: false, text: "" };
  return { path: filePath, existed: true, text: io.readFileSync(filePath, "utf8") };
}

function uniqueBackupPath(filePath, stamp, io = fs) {
  const base = `${filePath}.aiefficiency-atlas-${stamp}.bak`;
  if (!io.existsSync(base)) return base;
  for (let index = 1; index < 1000; index += 1) {
    const candidate = `${base}.${index}`;
    if (!io.existsSync(candidate)) return candidate;
  }
  throw new Error(`无法为 ${filePath} 创建唯一备份名`);
}

function createBackup(snapshot, stamp, io = fs) {
  if (!snapshot.existed) return null;
  const backupPath = uniqueBackupPath(snapshot.path, stamp, io);
  io.copyFileSync(snapshot.path, backupPath);
  if (typeof io.chmodSync === "function") {
    try { io.chmodSync(backupPath, 0o600); } catch {}
  }
  return backupPath;
}

function atomicWriteText(filePath, text, { io = fs, secret = false } = {}) {
  io.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = path.join(path.dirname(filePath), `.${path.basename(filePath)}.aiefficiency-atlas-${process.pid}-${Math.random().toString(36).slice(2)}.tmp`);
  try {
    io.writeFileSync(tempPath, text, "utf8");
    if (secret && typeof io.chmodSync === "function") {
      try { io.chmodSync(tempPath, 0o600); } catch {}
    }
    io.renameSync(tempPath, filePath);
  } catch (error) {
    try { if (io.existsSync(tempPath)) io.unlinkSync(tempPath); } catch {}
    throw error;
  }
}

/** 为故事点 Claude Code × Atlas 注入隔离配置与凭据，不改默认 ~/.claude。 */
export function buildClaudeAtlasSpawnEnv(baseEnv = process.env, overrides = {}) {
  const creds = resolveAtlasCredentials(overrides);
  const configDir = getAtlasClientPaths(overrides.home).claudeStoryDir;
  const env = { ...baseEnv };
  env.CLAUDE_CONFIG_DIR = configDir;
  env.ANTHROPIC_AUTH_TOKEN = creds.apiKey;
  env.ANTHROPIC_BASE_URL = creds.anthropicBaseUrl;
  env.ANTHROPIC_MODEL = creds.model;
  env.ANTHROPIC_DEFAULT_HAIKU_MODEL = creds.model;
  env.ANTHROPIC_DEFAULT_SONNET_MODEL = creds.model;
  env.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS = "1";
  delete env.ANTHROPIC_API_KEY;
  return { env, creds, configDir, model: creds.model };
}

/** 隔离 Claude profile 的非交互工作区信任，避免首次启动卡在确认弹窗。 */
export function ensureClaudeAtlasTrust(dirs = [], home = os.homedir(), io = fs) {
  const trusted = (Array.isArray(dirs) ? dirs : [dirs])
    .map((value) => clean(value))
    .filter(Boolean);
  if (!trusted.length) return { ok: true, changed: false, trusted: [] };
  const configDir = getAtlasClientPaths(home).claudeStoryDir;
  const target = path.join(configDir, ".claude.json");
  let data = {};
  try {
    if (io.existsSync(target)) data = parseJsonObject(io.readFileSync(target, "utf8"), "Claude Atlas .claude.json");
  } catch {
    data = {};
  }
  const projects = asObject(data.projects);
  let changed = false;
  for (const dir of trusted) {
    const current = asObject(projects[dir]);
    if (current.hasTrustDialogAccepted !== true) changed = true;
    projects[dir] = { ...current, hasTrustDialogAccepted: true };
  }
  if (changed || !io.existsSync(target)) {
    atomicWriteText(target, `${JSON.stringify({ ...data, projects }, null, 2)}\n`, { io, secret: false });
  }
  return { ok: true, changed, trusted };
}

/** 为故事点 Codex CLI × Atlas 维护独立 CODEX_HOME，避免覆盖官方/其它 provider。 */
export function buildCodexAtlasSpawnEnv(baseEnv = process.env, overrides = {}) {
  const creds = resolveAtlasCredentials(overrides);
  const configDir = getAtlasClientPaths(overrides.home).codexStoryDir;
  const configPath = path.join(configDir, "config.toml");
  const authPath = path.join(configDir, "auth.json");
  let auth = {};
  try {
    if ((overrides.io || fs).existsSync(authPath)) {
      auth = parseJsonObject((overrides.io || fs).readFileSync(authPath, "utf8"), "Codex Atlas auth.json");
    }
  } catch {
    auth = {};
  }
  auth.OPENAI_API_KEY = creds.apiKey;
  atomicWriteText(configPath, mergeAtlasIntoCodexToml("", creds), { io: overrides.io || fs, secret: false });
  atomicWriteText(authPath, `${JSON.stringify(auth, null, 2)}\n`, { io: overrides.io || fs, secret: true });
  const env = { ...baseEnv, CODEX_HOME: configDir };
  return { env, creds, configDir, model: creds.model, modelProvider: ATLAS_CODEX_PROVIDER_ID };
}

/** 为故事点 Hermes × Atlas 使用独立 HERMES_HOME；真实 OS HOME 仍供 Git/SSH/CLI 使用。 */
export function buildHermesAtlasSpawnEnv(baseEnv = process.env, overrides = {}) {
  const creds = resolveAtlasCredentials(overrides);
  const configDir = getAtlasClientPaths(overrides.home).hermesStoryDir;
  const configPath = path.join(configDir, "config.yaml");
  const config = [
    "terminal:",
    "  home_mode: real",
    "model:",
    "  provider: custom",
    `  base_url: ${JSON.stringify(creds.baseUrl)}`,
    `  default: ${JSON.stringify(creds.model)}`,
    "  api_mode: chat_completions",
    "",
  ].join("\n");
  atomicWriteText(configPath, config, { io: overrides.io || fs, secret: false });
  const env = {
    ...baseEnv,
    HERMES_HOME: configDir,
    HERMES_MODEL: creds.model,
    OPENAI_API_KEY: creds.apiKey,
  };
  return { env, creds, configDir, model: creds.model };
}

function restoreSnapshots(snapshots, io = fs) {
  for (const snapshot of snapshots) {
    try {
      if (snapshot.existed) {
        atomicWriteText(snapshot.path, snapshot.text, { io, secret: true });
      } else if (io.existsSync(snapshot.path)) {
        io.unlinkSync(snapshot.path);
      }
    } catch {}
  }
}

function transactionalWrite(entries, { io = fs, now = Date.now } = {}) {
  const snapshots = entries.map((entry) => readSnapshot(entry.path, io));
  const stamp = timestampPart(now);
  const backups = snapshots.map((snapshot) => createBackup(snapshot, stamp, io));
  try {
    for (const entry of entries) {
      atomicWriteText(entry.path, entry.text, { io, secret: entry.secret !== false });
    }
  } catch (error) {
    restoreSnapshots(snapshots, io);
    throw error;
  }
  return {
    paths: entries.map((entry) => entry.path),
    backups: backups.filter(Boolean),
  };
}

function applyAtlasToCodex(engine, opts = {}) {
  const paths = getAtlasClientPaths(opts.home);
  const configSnapshot = readSnapshot(paths.codexConfig, opts.io || fs);
  const authSnapshot = readSnapshot(paths.codexAuth, opts.io || fs);
  const auth = parseJsonObject(authSnapshot.text, "Codex auth.json");
  auth.OPENAI_API_KEY = engine.apiKey;
  const written = transactionalWrite([
    { path: paths.codexConfig, text: mergeAtlasIntoCodexToml(configSnapshot.text, engine), secret: false },
    { path: paths.codexAuth, text: `${JSON.stringify(auth, null, 2)}\n`, secret: true },
  ], opts);
  return {
    ok: true,
    tool: "codex",
    model: engine.model,
    provider: ATLAS_CODEX_PROVIDER_ID,
    ...written,
    hint: "Atlas 已设为 Codex 全局默认模型；请重新打开 Codex 会话。",
  };
}

function applyAtlasToClaude(engine, opts = {}) {
  const target = getAtlasClientPaths(opts.home).claudeSettings;
  const snapshot = readSnapshot(target, opts.io || fs);
  const settings = mergeAtlasIntoClaudeSettings(parseJsonObject(snapshot.text, "Claude settings.json"), engine);
  const written = transactionalWrite([
    { path: target, text: `${JSON.stringify(settings, null, 2)}\n`, secret: true },
  ], opts);
  return {
    ok: true,
    tool: "claude",
    model: engine.model,
    provider: "atlascloud",
    ...written,
    hint: "Atlas 已设为 Claude Code 全局默认模型；请重新打开 Claude Code 会话。",
  };
}

function applyAtlasToOpenCode(engine, opts = {}) {
  const target = getAtlasClientPaths(opts.home).openCodeConfig;
  const snapshot = readSnapshot(target, opts.io || fs);
  const config = mergeAtlasIntoOpenCodeConfig(parseJsonObject(snapshot.text, "OpenCode opencode.json"), engine);
  const written = transactionalWrite([
    { path: target, text: `${JSON.stringify(config, null, 2)}\n`, secret: true },
  ], opts);
  return {
    ok: true,
    tool: "opencode",
    model: config.model,
    provider: ATLAS_OPENCODE_PROVIDER_ID,
    ...written,
    hint: "Atlas 已设为 OpenCode 全局默认模型；请重新打开 OpenCode 后用 /models 确认。",
  };
}

async function defaultRun(command, args) {
  const result = await execFileAsync(command, args, {
    windowsHide: true,
    timeout: 20000,
    maxBuffer: 1024 * 1024,
  });
  return { stdout: String(result.stdout || ""), stderr: String(result.stderr || "") };
}

function commandPath(output, fallback) {
  const lines = String(output || "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const value = lines[lines.length - 1]?.replace(/^['"]|['"]$/g, "");
  return value ? path.resolve(value) : fallback;
}

async function applyAtlasToHermes(engine, opts = {}) {
  const io = opts.io || fs;
  const run = opts.run || defaultRun;
  const executable = opts.hermesCommand || hermesExecutable(opts.platform, opts.env);
  try {
    await run(executable, ["--version"]);
  } catch (error) {
    const guide = hermesInstallGuide(opts.platform);
    return {
      ok: false,
      tool: "hermes",
      code: "HERMES_NOT_INSTALLED",
      error: "未检测到 Hermes Agent。请先按官方方式安装，再重试一键设置。",
      installGuide: guide,
    };
  }

  const defaults = getAtlasClientPaths(opts.home);
  let configPath = defaults.hermesConfig;
  let envPath = defaults.hermesEnv;
  try {
    const result = await run(executable, ["config", "path"]);
    configPath = commandPath(result.stdout, configPath);
  } catch {}
  try {
    const result = await run(executable, ["config", "env-path"]);
    envPath = commandPath(result.stdout, envPath);
  } catch {}

  const snapshots = [readSnapshot(configPath, io), readSnapshot(envPath, io)];
  const stamp = timestampPart(opts.now || Date.now);
  const backups = snapshots.map((snapshot) => createBackup(snapshot, stamp, io)).filter(Boolean);
  try {
    const settings = [
      ["model.provider", "custom"],
      ["model.base_url", engine.baseUrl],
      ["model.default", engine.model],
      ["model.api_mode", "chat_completions"],
    ];
    for (const [key, value] of settings) {
      await run(executable, ["config", "set", key, value]);
    }
    const currentEnv = io.existsSync(envPath) ? io.readFileSync(envPath, "utf8") : "";
    atomicWriteText(envPath, mergeDotEnv(currentEnv, "OPENAI_API_KEY", engine.apiKey), { io, secret: true });
  } catch (error) {
    restoreSnapshots(snapshots, io);
    return {
      ok: false,
      tool: "hermes",
      code: "HERMES_CONFIG_FAILED",
      error: `Hermes 全局配置失败，已恢复原配置：${error?.message || error}`,
      paths: [configPath, envPath],
      backups,
    };
  }

  return {
    ok: true,
    tool: "hermes",
    model: engine.model,
    provider: "custom",
    paths: [configPath, envPath],
    backups,
    hint: "Atlas 已设为 Hermes 全局默认模型；请重新打开 Hermes 会话。",
  };
}

export async function applyAtlasToClient(tool, overrides = {}, opts = {}) {
  const target = clean(tool).toLowerCase();
  if (!ATLAS_CLIENT_TOOLS.has(target)) {
    return { ok: false, code: "UNSUPPORTED_TOOL", error: `不支持设置到 ${target || "未知工具"}` };
  }
  let engine;
  try {
    engine = resolveAtlasCredentials(overrides);
    if (target === "codex") return applyAtlasToCodex(engine, opts);
    if (target === "claude") return applyAtlasToClaude(engine, opts);
    if (target === "opencode") return applyAtlasToOpenCode(engine, opts);
    return await applyAtlasToHermes(engine, opts);
  } catch (error) {
    return {
      ok: false,
      tool: target,
      code: "ATLAS_CONFIG_FAILED",
      error: error?.message || String(error),
    };
  }
}
