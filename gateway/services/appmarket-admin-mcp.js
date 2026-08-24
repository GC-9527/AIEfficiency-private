/**
 * DevBench AppMarket admin MCP integration.
 *
 * The server is repository-owned and strictly read-only. Native CLI engines
 * receive a stdio registration before their process starts; API-backed agents
 * use the same server through an MCP client bridge. Credentials are never
 * serialized here: the child inherits APPMARKET_ADMIN_* environment values.
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

export const APPMARKET_MCP_REGISTRATION_ID = "appmarket_admin_backend";
export const APPMARKET_MCP_PACKAGE_NAME = "appmarket-admin-readonly-mcp-server";

export const APPMARKET_MCP_ENV_NAMES = Object.freeze([
  "APPMARKET_ADMIN_TOKEN",
  "APPMARKET_ADMIN_USERNAME",
  "APPMARKET_ADMIN_PASSWORD",
  "APPMARKET_ADMIN_LOGIN_CURL_FILE",
  "APPMARKET_ADMIN_BASE_URL",
  "APPMARKET_ADMIN_ALLOWED_ORIGINS",
  "APPMARKET_ADMIN_ENVIRONMENT",
  "APPMARKET_ADMIN_TIMEOUT_MS",
  "APPMARKET_ADMIN_MAX_RESPONSE_BYTES",
  "APPMARKET_ADMIN_TOKEN_TTL_MS",
]);

export const APPMARKET_MCP_TOOL_NAMES = Object.freeze([
  "appmarket_admin_capabilities",
  "appmarket_admin_auth_check",
  "appmarket_admin_list_routes",
  "appmarket_admin_list_metadata",
  "appmarket_admin_list_countries",
  "appmarket_admin_list_car_models",
  "appmarket_admin_get_car_model_country_map",
  "appmarket_admin_list_departments",
  "appmarket_admin_list_apps",
  "appmarket_admin_list_app_options",
  "appmarket_admin_list_banners",
  "appmarket_admin_list_webapp_configs",
  "appmarket_admin_list_channels",
  "appmarket_admin_query_dashboard",
  "appmarket_admin_get_voice_open_keys",
  "appmarket_admin_verify_banner",
  "appmarket_admin_verify_voice_key",
  "appmarket_admin_verify_distribution",
  "appmarket_admin_verify_model_region",
  "appmarket_admin_self_check",
]);

const APPMARKET_MCP_TOOL_SET = new Set(APPMARKET_MCP_TOOL_NAMES);
const CLAUDE_ENGINES = new Set(["claude", "claude-volcengine", "claude-minimax", "claude-atlas"]);
const CODEX_ENGINES = new Set(["codex", "codex-minimax", "codex-atlas"]);
const GATEWAY_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function firstExistingDirectory(candidates) {
  return candidates.find((candidate) => existsSync(path.join(candidate, "package.json"))) || candidates[0];
}

function enabledToolNames(options = {}) {
  if (!Object.prototype.hasOwnProperty.call(options, "enabledTools")) {
    return [...APPMARKET_MCP_TOOL_NAMES];
  }
  return [...new Set((Array.isArray(options.enabledTools) ? options.enabledTools : [])
    .map((name) => String(name || "").trim())
    .filter((name) => APPMARKET_MCP_TOOL_SET.has(name)))];
}

export function resolveAppMarketMcpRegistration(options = {}) {
  const serverDir = path.resolve(options.serverDir || firstExistingDirectory([
    path.resolve(GATEWAY_DIR, "..", "mcp-servers", "devServer"),
    path.resolve(GATEWAY_DIR, "mcp-servers", "devServer"),
  ]));
  return Object.freeze({
    id: APPMARKET_MCP_REGISTRATION_ID,
    packageName: APPMARKET_MCP_PACKAGE_NAME,
    command: path.resolve(options.nodePath || process.execPath),
    args: [path.join(serverDir, "src", "index.js")],
    cwd: serverDir,
    envVars: [...APPMARKET_MCP_ENV_NAMES],
    enabledTools: enabledToolNames(options),
    startupTimeoutSec: 20,
    toolTimeoutSec: 180,
  });
}

export function inspectAppMarketMcpRuntime(options = {}) {
  const registration = resolveAppMarketMcpRegistration(options);
  const problems = [];
  const packageFile = path.join(registration.cwd, "package.json");
  if (!existsSync(packageFile)) {
    problems.push("MCP package.json 不存在");
  } else {
    try {
      const pkg = JSON.parse(readFileSync(packageFile, "utf8"));
      if (pkg.name !== APPMARKET_MCP_PACKAGE_NAME) problems.push("MCP 包名不匹配");
    } catch {
      problems.push("MCP package.json 无法解析");
    }
  }
  if (!existsSync(registration.args[0])) problems.push("MCP 入口文件不存在");
  if (!problems.length) {
    try {
      createRequire(packageFile).resolve("@modelcontextprotocol/sdk/server/stdio.js");
      createRequire(packageFile).resolve("zod");
    } catch {
      problems.push("MCP 依赖未安装，请重新运行 AIEfficiency 启动脚本");
    }
  }
  return {
    ok: problems.length === 0,
    registration,
    problems,
  };
}

function tomlString(value) {
  return JSON.stringify(String(value ?? ""));
}

function tomlStringArray(values) {
  return `[${values.map((value) => tomlString(value)).join(", ")}]`;
}

function stripTomlTable(text, tableName) {
  const kept = [];
  let skip = false;
  for (const rawLine of String(text || "").split(/\r?\n/)) {
    const table = rawLine.trim().match(/^\[([^\]]+)\]$/);
    if (table) {
      const current = table[1].trim();
      skip = current === tableName || current.startsWith(`${tableName}.`);
    }
    if (!skip) kept.push(rawLine);
  }
  return kept.join("\n").replace(/\s+$/, "");
}

export function codexAppMarketMcpToml(options = {}) {
  const registration = resolveAppMarketMcpRegistration(options);
  return [
    `[mcp_servers.${registration.id}]`,
    `command = ${tomlString(registration.command)}`,
    `args = ${tomlStringArray(registration.args)}`,
    `cwd = ${tomlString(registration.cwd)}`,
    `env_vars = ${tomlStringArray(registration.envVars)}`,
    `enabled_tools = ${tomlStringArray(registration.enabledTools)}`,
    'default_tools_approval_mode = "writes"',
    "required = false",
    `startup_timeout_sec = ${registration.startupTimeoutSec}`,
    `tool_timeout_sec = ${registration.toolTimeoutSec}`,
  ].join("\n");
}

export function mergeAppMarketMcpIntoCodexToml(existingText, options = {}) {
  const tableName = `mcp_servers.${APPMARKET_MCP_REGISTRATION_ID}`;
  const base = stripTomlTable(existingText, tableName);
  return `${base ? `${base}\n\n` : ""}${codexAppMarketMcpToml(options)}\n`;
}

export function writeAppMarketMcpToCodexConfig(configPath, options = {}) {
  const existing = existsSync(configPath) ? readFileSync(configPath, "utf8") : "";
  const merged = mergeAppMarketMcpIntoCodexToml(existing, options);
  mkdirSync(path.dirname(configPath), { recursive: true });
  if (existing !== merged) writeFileSync(configPath, merged, { encoding: "utf8", mode: 0o600 });
  return { changed: existing !== merged, configPath, registration: resolveAppMarketMcpRegistration(options) };
}

export function codexAppMarketMcpOverrideArgs(options = {}) {
  const registration = resolveAppMarketMcpRegistration(options);
  const prefix = `mcp_servers.${registration.id}`;
  const values = [
    [`${prefix}.command`, tomlString(registration.command)],
    [`${prefix}.args`, tomlStringArray(registration.args)],
    [`${prefix}.cwd`, tomlString(registration.cwd)],
    [`${prefix}.env_vars`, tomlStringArray(registration.envVars)],
    [`${prefix}.enabled_tools`, tomlStringArray(registration.enabledTools)],
    [`${prefix}.default_tools_approval_mode`, '"writes"'],
    [`${prefix}.required`, "false"],
    [`${prefix}.startup_timeout_sec`, String(registration.startupTimeoutSec)],
    [`${prefix}.tool_timeout_sec`, String(registration.toolTimeoutSec)],
  ];
  return values.flatMap(([key, value]) => ["-c", `${key}=${value}`]);
}

function nativeStdioRegistration(options = {}) {
  const registration = resolveAppMarketMcpRegistration(options);
  return {
    type: "stdio",
    command: registration.command,
    args: registration.args,
  };
}

export function createClaudeAppMarketMcpRuntime(options = {}) {
  const directory = mkdtempSync(path.join(options.tempDir || tmpdir(), "aiefficiency-claude-mcp-"));
  const configPath = path.join(directory, "mcp.json");
  writeFileSync(configPath, `${JSON.stringify({
    mcpServers: {
      [APPMARKET_MCP_REGISTRATION_ID]: nativeStdioRegistration(options),
    },
  }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  let cleaned = false;
  return {
    configPath,
    cleanup() {
      if (cleaned) return;
      cleaned = true;
      try { rmSync(directory, { recursive: true, force: true }); } catch {}
    },
  };
}

export function ensureGeminiAppMarketMcpRegistration(options = {}) {
  const home = path.resolve(options.home || homedir());
  const settingsPath = path.join(home, ".gemini", "settings.json");
  let settings = {};
  if (existsSync(settingsPath)) {
    try {
      settings = JSON.parse(readFileSync(settingsPath, "utf8").replace(/^\uFEFF/, ""));
    } catch (error) {
      throw new Error(`Gemini settings.json 无法解析，未写入 MCP 注册: ${error.message}`);
    }
  }
  const registration = resolveAppMarketMcpRegistration(options);
  const desired = {
    ...nativeStdioRegistration(options),
    trust: true,
    timeout: registration.startupTimeoutSec * 1000,
    includeTools: [...registration.enabledTools],
  };
  const next = {
    ...settings,
    mcpServers: {
      ...(settings.mcpServers && typeof settings.mcpServers === "object" ? settings.mcpServers : {}),
      [registration.id]: desired,
    },
  };
  const existingText = existsSync(settingsPath) ? readFileSync(settingsPath, "utf8") : "";
  const nextText = `${JSON.stringify(next, null, 2)}\n`;
  mkdirSync(path.dirname(settingsPath), { recursive: true });
  if (existingText !== nextText) writeFileSync(settingsPath, nextText, { encoding: "utf8", mode: 0o600 });
  return { changed: existingText !== nextText, settingsPath, registration };
}

export function prepareStoryAppMarketMcpForCli(engine, options = {}) {
  const normalized = String(engine || "").trim().toLowerCase();
  const args = [...(options.args || [])];
  const env = { ...(options.env || process.env) };
  let cleanup = () => {};
  let persisted = false;
  if (CLAUDE_ENGINES.has(normalized)) {
    const runtime = createClaudeAppMarketMcpRuntime(options);
    args.push("--mcp-config", runtime.configPath);
    cleanup = runtime.cleanup;
  } else if (normalized === "gemini") {
    ensureGeminiAppMarketMcpRegistration(options);
    if (!args.includes("--skip-trust")) args.push("--skip-trust");
    args.push("--allowed-mcp-server-names", APPMARKET_MCP_REGISTRATION_ID);
    persisted = true;
  } else if (CODEX_ENGINES.has(normalized)) {
    const overrides = codexAppMarketMcpOverrideArgs(options);
    const stdinPromptIndex = args.lastIndexOf("-");
    if (stdinPromptIndex >= 0) args.splice(stdinPromptIndex, 0, ...overrides);
    else args.push(...overrides);
  } else {
    return { supported: false, args, env, cleanup, persisted, runtime: inspectAppMarketMcpRuntime(options) };
  }
  return {
    supported: true,
    args,
    env,
    cleanup,
    persisted,
    registrationId: APPMARKET_MCP_REGISTRATION_ID,
    runtime: inspectAppMarketMcpRuntime(options),
  };
}

export function isAppMarketMcpTool(name) {
  return APPMARKET_MCP_TOOL_SET.has(String(name || ""));
}

function filteredChildEnvironment(env = process.env) {
  return Object.fromEntries(Object.entries(env).filter(([, value]) => typeof value === "string"));
}

let bridgeState = null;
let bridgePromise = null;

async function closeBridgeState() {
  const current = bridgeState;
  bridgeState = null;
  bridgePromise = null;
  if (!current) return;
  try { await current.client.close(); } catch {}
  try { await current.transport.close(); } catch {}
}

async function connectBridge(options = {}) {
  if (bridgeState) return bridgeState;
  if (bridgePromise) return bridgePromise;
  bridgePromise = (async () => {
    const inspected = inspectAppMarketMcpRuntime(options);
    if (!inspected.ok) {
      const error = new Error(inspected.problems.join("；"));
      error.code = "APPMARKET_MCP_NOT_READY";
      throw error;
    }
    const registration = inspected.registration;
    const transport = new StdioClientTransport({
      command: registration.command,
      args: registration.args,
      cwd: registration.cwd,
      stderr: "pipe",
      env: filteredChildEnvironment(options.env || process.env),
    });
    const client = new Client({
      name: "aiefficiency-devbench-appmarket-bridge",
      version: "1.0.0",
    }, { capabilities: {} });
    try {
      await client.connect(transport);
      const listed = await client.listTools();
      const tools = (listed.tools || []).filter((tool) => APPMARKET_MCP_TOOL_SET.has(tool.name));
      const missing = APPMARKET_MCP_TOOL_NAMES.filter((name) => !tools.some((tool) => tool.name === name));
      if (missing.length) throw new Error(`MCP 工具清单不完整: ${missing.join(", ")}`);
      bridgeState = { client, transport, tools, registration };
      return bridgeState;
    } catch (error) {
      try { await client.close(); } catch {}
      try { await transport.close(); } catch {}
      throw error;
    }
  })();
  try {
    return await bridgePromise;
  } catch (error) {
    bridgePromise = null;
    throw error;
  }
}

function fallbackOpenAiTools() {
  return APPMARKET_MCP_TOOL_NAMES.map((name) => ({
    type: "function",
    function: {
      name,
      description: "只读查询应用市场开发环境后台。参数由 MCP 服务校验；认证信息仅从本机环境变量读取。",
      parameters: { type: "object", properties: {}, additionalProperties: true },
    },
  }));
}

export function mcpToolsToOpenAiTools(tools = []) {
  return tools
    .filter((tool) => APPMARKET_MCP_TOOL_SET.has(tool?.name))
    .map((tool) => ({
      type: "function",
      function: {
        name: tool.name,
        description: `只读访问应用市场开发环境后台。${String(tool.description || "")}`.trim(),
        parameters: tool.inputSchema || { type: "object", properties: {} },
      },
    }));
}

export async function getAppMarketMcpOpenAiTools(options = {}) {
  try {
    const state = await connectBridge(options);
    return mcpToolsToOpenAiTools(state.tools);
  } catch {
    // Keep the tools discoverable. A later call retries the connection and
    // returns an actionable error without disabling unrelated story work.
    return fallbackOpenAiTools();
  }
}

export async function callAppMarketMcpTool(name, args = {}, options = {}) {
  if (!isAppMarketMcpTool(name)) throw new Error(`未允许的 AppMarket MCP 工具: ${name}`);
  try {
    const state = await connectBridge(options);
    const result = await state.client.callTool(
      { name, arguments: args || {} },
      undefined,
      {
        signal: options.signal || undefined,
        timeout: state.registration.toolTimeoutSec * 1000,
        maxTotalTimeout: state.registration.toolTimeoutSec * 1000,
      },
    );
    const payload = result.structuredContent ?? result.content ?? result;
    return `${result.isError ? "错误: " : ""}${JSON.stringify(payload)}`;
  } catch (error) {
    await closeBridgeState();
    throw new Error(`应用市场开发环境后台 MCP 调用失败: ${error.message}`);
  }
}

export async function closeAppMarketMcpBridge() {
  await closeBridgeState();
}
