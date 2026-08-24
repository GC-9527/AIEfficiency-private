import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function stripTomlComment(line) {
  let quote = "";
  let escaped = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (quote === '"' && ch === "\\") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (ch === quote) quote = "";
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === "#") return line.slice(0, i);
  }
  return line;
}

function findTomlEquals(line) {
  let quote = "";
  let escaped = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (quote === '"' && ch === "\\") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (ch === quote) quote = "";
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === "=") return i;
  }
  return -1;
}

function parseTomlScalar(raw) {
  const value = String(raw || "").trim();
  if (!value) return "";
  if (value.startsWith('"') && value.endsWith('"')) {
    try { return JSON.parse(value); } catch { return value.slice(1, -1); }
  }
  if (value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1).replace(/''/g, "'");
  if (value === "true") return true;
  if (value === "false") return false;
  if (/^-?\d+(?:\.\d+)?$/.test(value)) return Number(value);
  return value;
}

/**
 * Parse the root keys and simple table keys needed for AI model metadata.
 * This intentionally is not a general TOML parser; unsupported values remain
 * strings and secret-bearing tables are never returned to an API response.
 */
export function parseTomlMetadata(text) {
  const root = {};
  const sections = {};
  let section = "";
  for (const rawLine of String(text || "").split(/\r?\n/)) {
    const line = stripTomlComment(rawLine).trim();
    if (!line) continue;
    const table = line.match(/^\[([^\]]+)]$/);
    if (table) {
      section = table[1].trim();
      if (!sections[section]) sections[section] = {};
      continue;
    }
    const eq = findTomlEquals(line);
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim().replace(/^['"]|['"]$/g, "");
    if (!/^[A-Za-z0-9_.-]+$/.test(key)) continue;
    const target = section ? sections[section] : root;
    target[key] = parseTomlScalar(line.slice(eq + 1));
  }
  return { root, sections };
}

function readText(filePath, io = fs) {
  try { return io.readFileSync(filePath, "utf8"); } catch { return ""; }
}

function readJson(filePath, io = fs) {
  const text = readText(filePath, io);
  if (!text) return null;
  try { return JSON.parse(text); } catch { return null; }
}

function clean(value) {
  if (value == null || typeof value === "object") return "";
  return String(value).trim();
}

function safeEndpoint(value) {
  const raw = clean(value);
  if (!raw) return "";
  try {
    const url = new URL(raw);
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return `${url.origin}${url.pathname}`.replace(/\/+$/, "");
  } catch {
    return "自定义端点（地址格式未识别）";
  }
}

function knownProvider(id, endpoint = "", configuredName = "") {
  const key = clean(id).toLowerCase();
  const url = clean(endpoint).toLowerCase();
  // An explicit endpoint is stronger evidence than the compatibility protocol
  // or config key. `id=openai` with a rewritten URL is not proof that OpenAI
  // serves the request; it only says that the wire format is compatible.
  if (/ark\..*volces\.com/.test(url)) return "火山方舟";
  if (/api\.atlascloud\.ai/.test(url)) return "Atlas Coding Plan";
  if (/api\.minimaxi\.com/.test(url)) return "MiniMax";
  if (/api\.deepseek\.com/.test(url)) return "DeepSeek";
  if (/api\.anthropic\.com/.test(url)) return "Anthropic";
  if (/api\.openai\.com/.test(url)) return "OpenAI";
  if (/generativelanguage\.googleapis\.com/.test(url)) return "Google";
  if (url) {
    const named = clean(configuredName);
    return named && named.toLowerCase() !== key ? named : "自定义服务商";
  }
  if (key.includes("volc")) return "火山方舟";
  if (key.includes("minimax")) return "MiniMax";
  if (key.includes("deepseek")) return "DeepSeek";
  if (key === "anthropic") return "Anthropic";
  if (key === "openai") return "OpenAI";
  if (key === "gemini" || key === "google") return "Google";
  return clean(configuredName) || clean(id) || "自定义服务商";
}

function metadata(name, model, tier, source = "", identity = {}) {
  return {
    name,
    model: clean(model),
    tier: clean(tier),
    ...(source ? { source } : {}),
    ...(identity.provider ? { provider: clean(identity.provider) } : {}),
    ...(identity.access ? { access: clean(identity.access) } : {}),
    ...(identity.endpoint ? { endpoint: safeEndpoint(identity.endpoint) } : {}),
    ...(identity.official != null ? { official: !!identity.official } : {}),
    ...(Array.isArray(identity.availableModels)
      ? { availableModels: identity.availableModels.map((item) => clean(item)).filter(Boolean) }
      : {}),
  };
}

function projectConfigDirs(cwd, io = fs) {
  if (!cwd) return [];
  const resolved = path.resolve(cwd);
  const chain = [];
  let current = resolved;
  let gitRoot = "";
  while (true) {
    chain.push(current);
    try {
      if (io.existsSync(path.join(current, ".git"))) {
        gitRoot = current;
        break;
      }
    } catch {}
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  if (!gitRoot) return [resolved];
  return chain.slice(0, chain.indexOf(gitRoot) + 1).reverse();
}

function applyCodexLayer(state, parsed, source) {
  for (const key of ["model", "model_reasoning_effort", "model_provider"]) {
    const value = clean(parsed?.[key]);
    if (value) {
      state[key] = value;
      state.source = source;
    }
  }
}

export function readCodexModelMetadata({
  cwd = "",
  env = process.env,
  home = os.homedir(),
  io = fs,
  configDir = "",
  name = "Codex CLI",
} = {}) {
  const codexHome = clean(configDir) || clean(env.CODEX_HOME) || path.join(home, ".codex");
  const base = parseTomlMetadata(readText(path.join(codexHome, "config.toml"), io));
  const state = { providers: { ...base.sections } };
  applyCodexLayer(state, base.root, "用户配置");

  // 兼容旧版 [profiles.<name>]，同时支持当前 $CODEX_HOME/<name>.config.toml。
  const profile = clean(base.root.profile);
  if (profile) {
    applyCodexLayer(state, base.sections[`profiles.${profile}`], `profile:${profile}`);
    const profileFile = parseTomlMetadata(readText(path.join(codexHome, `${profile}.config.toml`), io));
    applyCodexLayer(state, profileFile.root, `profile:${profile}`);
  }

  for (const dir of projectConfigDirs(cwd, io)) {
    const project = parseTomlMetadata(readText(path.join(dir, ".codex", "config.toml"), io));
    applyCodexLayer(state, project.root, "工程配置");
    Object.assign(state.providers, project.sections || {});
  }
  const providerId = clean(state.model_provider) || "openai";
  const providerConfig = state.providers[`model_providers.${providerId}`] || {};
  const endpoint = clean(providerConfig.base_url || providerConfig.baseUrl);
  const provider = knownProvider(providerId, endpoint, providerConfig.name);
  const official = (
    (providerId === "openai" && (!endpoint || /api\.openai\.com/i.test(endpoint)))
    || (providerConfig.requires_openai_auth === true && !endpoint)
  );
  const displayName = official ? `${name}（OpenAI 官方）` : `${name}（${provider || "自定义端点"}）`;
  return metadata(displayName, state.model, state.model_reasoning_effort, state.source, {
    provider,
    access: "Codex CLI · app-server",
    endpoint,
    official,
  });
}

function modelFromJson(config) {
  if (!config || typeof config !== "object") return "";
  if (typeof config.model === "string") return config.model;
  if (config.model && typeof config.model === "object") return config.model.name || config.model.id || "";
  return config.selectedModel || "";
}

function tierFromJson(config) {
  if (!config || typeof config !== "object") return "";
  return config.effortLevel
    || config.effort
    || config.model?.effort
    || config.model?.reasoningEffort
    || config.thinkingConfig?.thinkingBudget
    || config.model?.thinkingBudget
    || "";
}

function applyJsonLayer(state, config, source) {
  const model = clean(modelFromJson(config));
  const tier = clean(tierFromJson(config));
  const envModel = clean(config?.env?.ANTHROPIC_MODEL || config?.env?.GEMINI_MODEL);
  const envTier = clean(config?.env?.CLAUDE_CODE_EFFORT_LEVEL);
  if (model || envModel) {
    state.model = envModel || model;
    state.source = source;
  }
  if (tier || envTier) {
    state.tier = envTier || tier;
    state.source = source;
  }
  const baseUrl = clean(config?.env?.ANTHROPIC_BASE_URL);
  if (baseUrl) {
    state.baseUrl = baseUrl;
    state.source = source;
  }
}

export function readClaudeModelMetadata({
  cwd = "",
  env = process.env,
  home = os.homedir(),
  io = fs,
  configDir = "",
  name = "Claude Code",
} = {}) {
  const claudeHome = clean(configDir) || path.join(home, ".claude");
  const state = {};
  applyJsonLayer(state, readJson(path.join(claudeHome, "settings.json"), io), "用户配置");
  for (const dir of projectConfigDirs(cwd, io)) {
    applyJsonLayer(state, readJson(path.join(dir, ".claude", "settings.json"), io), "工程配置");
    applyJsonLayer(state, readJson(path.join(dir, ".claude", "settings.local.json"), io), "工程本地配置");
  }
  if (clean(env.ANTHROPIC_MODEL)) {
    state.model = clean(env.ANTHROPIC_MODEL);
    state.source = "环境变量";
  }
  if (clean(env.CLAUDE_CODE_EFFORT_LEVEL)) {
    state.tier = clean(env.CLAUDE_CODE_EFFORT_LEVEL);
    state.source = "环境变量";
  }
  if (clean(env.ANTHROPIC_BASE_URL)) {
    state.baseUrl = clean(env.ANTHROPIC_BASE_URL);
    state.source = "环境变量";
  }
  const provider = knownProvider("", state.baseUrl, state.baseUrl ? "自定义服务商" : "Anthropic");
  const official = !state.baseUrl || /api\.anthropic\.com/i.test(state.baseUrl);
  const displayName = official ? `${name}（Anthropic 官方）` : `${name}（${provider}）`;
  return metadata(displayName, state.model, state.tier, state.source, {
    provider,
    access: official ? "Claude Code CLI" : "Claude Code CLI · Anthropic 兼容端点",
    endpoint: state.baseUrl,
    official,
  });
}

export function readGeminiModelMetadata({ cwd = "", env = process.env, home = os.homedir(), io = fs } = {}) {
  const state = {};
  applyJsonLayer(state, readJson(path.join(home, ".gemini", "settings.json"), io), "用户配置");
  for (const dir of projectConfigDirs(cwd, io)) {
    applyJsonLayer(state, readJson(path.join(dir, ".gemini", "settings.json"), io), "工程配置");
  }
  if (clean(env.GEMINI_MODEL)) {
    state.model = clean(env.GEMINI_MODEL);
    state.source = "环境变量";
  }
  return metadata("Gemini CLI（Google）", state.model, state.tier, state.source, {
    provider: "Google",
    access: "Gemini CLI",
    official: true,
  });
}

function yamlScalar(raw) {
  const value = String(raw || "").replace(/\s+#.*$/, "").trim();
  if (!value) return "";
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1).trim();
  }
  return value;
}

/** 只解析 Hermes config.yaml 的 model 段，绝不读取或返回凭据字段。 */
export function parseHermesModelConfig(text) {
  const result = { model: "", provider: "" };
  let modelIndent = -1;
  for (const rawLine of String(text || "").split(/\r?\n/)) {
    if (!rawLine.trim() || /^\s*#/.test(rawLine)) continue;
    const indent = rawLine.match(/^\s*/)?.[0]?.length || 0;
    const line = rawLine.trim();
    if (modelIndent >= 0 && indent <= modelIndent) modelIndent = -1;
    const rootModel = line.match(/^model\s*:\s*(.*)$/);
    if (indent === 0 && rootModel) {
      const scalar = yamlScalar(rootModel[1]);
      if (scalar) result.model = scalar;
      else modelIndent = indent;
      continue;
    }
    if (modelIndent >= 0 && indent > modelIndent) {
      const item = line.match(/^(default|model|provider)\s*:\s*(.*)$/);
      if (!item) continue;
      const value = yamlScalar(item[2]);
      if (item[1] === "provider") result.provider = value;
      else if (value && !result.model) result.model = value;
    }
  }
  return result;
}

export function readHermesModelMetadata({ env = process.env, home = os.homedir(), io = fs } = {}) {
  const candidates = [
    clean(env.HERMES_HOME) ? path.join(clean(env.HERMES_HOME), "config.yaml") : "",
    clean(env.LOCALAPPDATA) ? path.join(clean(env.LOCALAPPDATA), "hermes", "config.yaml") : "",
    path.join(home, ".hermes", "config.yaml"),
  ].filter(Boolean);
  const configPath = candidates.find((candidate) => {
    try { return io.existsSync?.(candidate); } catch { return false; }
  }) || candidates[candidates.length - 1];
  const state = parseHermesModelConfig(readText(configPath, io));
  if (clean(env.HERMES_INFERENCE_MODEL)) state.model = clean(env.HERMES_INFERENCE_MODEL);
  if (clean(env.HERMES_INFERENCE_PROVIDER)) state.provider = clean(env.HERMES_INFERENCE_PROVIDER);
  const source = clean(env.HERMES_INFERENCE_MODEL || env.HERMES_INFERENCE_PROVIDER)
    ? "环境变量"
    : (state.model || state.provider ? "用户配置" : "");
  return metadata("Hermes Agent（本地）", state.model, "", source, {
    provider: state.provider || "Hermes 自动选择",
    access: "Hermes Agent CLI · oneshot",
  });
}

function apiEngineTier(id, config = {}) {
  if (id === "deepseek") {
    if (config.thinkingEnabled === false) return "off";
    return clean(config.reasoningEffort) || "high";
  }
  return clean(config.reasoningEffort || config.effortLevel || config.effort);
}

export function getAiModelMetadata({
  cwd = "",
  config = {},
  env = process.env,
  home = os.homedir(),
  io = fs,
} = {}) {
  const codexOfficialDir = path.join(home, ".codex-official");
  const claudeOfficialDir = path.join(home, ".claude-official");
  const defaultCodexDir = path.join(home, ".codex");
  const defaultCodexConfigExists = !!io.existsSync?.(path.join(defaultCodexDir, "config.toml"));
  const defaultCodex = readCodexModelMetadata({ cwd, env, home, io, configDir: defaultCodexDir });
  // Match the runtime selector: when the default profile is already an
  // authenticated official OpenAI profile, app-server seeds from it. Only a
  // rewritten/custom default needs the isolated official backup.
  const codexConfigDir = defaultCodexConfigExists && defaultCodex.official
    ? defaultCodexDir
    : (io.existsSync?.(path.join(codexOfficialDir, "config.toml")) ? codexOfficialDir : defaultCodexDir);
  const claudeConfigDir = io.existsSync?.(path.join(claudeOfficialDir, "settings.json"))
    ? claudeOfficialDir
    : path.join(home, ".claude");
  // 官方 Claude spawn 会主动剥离所有 ANTHROPIC_* 覆盖。元数据必须按
  // 实际子进程环境读取，不能把默认 ~/.claude 已改写的方舟/MiniMax 端点
  // 错报成“Claude（官方）”本轮会使用的服务商。
  const claudeOfficialEnv = { ...env };
  for (const key of [
    "ANTHROPIC_BASE_URL",
    "ANTHROPIC_AUTH_TOKEN",
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_MODEL",
    "ANTHROPIC_DEFAULT_SONNET_MODEL",
    "ANTHROPIC_DEFAULT_OPUS_MODEL",
  ]) delete claudeOfficialEnv[key];
  const result = {
    claude: readClaudeModelMetadata({ cwd, env: claudeOfficialEnv, home, io, configDir: claudeConfigDir }),
    codex: readCodexModelMetadata({ cwd, env, home, io, configDir: codexConfigDir }),
    gemini: readGeminiModelMetadata({ cwd, env, home, io }),
    hermes: readHermesModelMetadata({ env, home, io }),
  };
  for (const [id, engine] of Object.entries(config.apiEngines || {})) {
    const endpoint = clean(engine?.baseUrl);
    const provider = knownProvider(engine?.provider || id, endpoint, engine?.providerName || engine?.name);
    const official = (
      (provider === "OpenAI" && /api\.openai\.com/i.test(endpoint))
      || (provider === "Anthropic" && /api\.anthropic\.com/i.test(endpoint))
      || (provider === "Google" && /googleapis\.com/i.test(endpoint))
    );
    result[id] = metadata(engine?.name || id, engine?.model, apiEngineTier(id, engine), "网关配置", {
      provider,
      access: "网关直连 · OpenAI 兼容 API",
      endpoint,
      official,
      ...(Array.isArray(engine?.availableModels) ? { availableModels: engine.availableModels } : {}),
    });
  }
  const atlas = config.apiEngines?.atlas;
  if (atlas && (atlas.enabled || atlas.apiKey || atlas.model)) {
    const atlasModels = Array.isArray(atlas.availableModels) ? atlas.availableModels : [];
    const common = {
      provider: "Atlas Coding Plan",
      official: false,
      availableModels: atlasModels,
    };
    const openAiEndpoint = clean(atlas.baseUrl) || "https://api.atlascloud.ai/v1";
    const anthropicEndpoint = clean(atlas.anthropicBaseUrl)
      || openAiEndpoint.replace(/\/v1\/?$/i, "")
      || "https://api.atlascloud.ai";
    result["claude-atlas"] = metadata(
      "Claude Code（Atlas Coding Plan）",
      atlas.model,
      apiEngineTier("atlas", atlas),
      "网关配置·Atlas Coding Plan",
      { ...common, access: "Claude Code CLI · Anthropic 兼容端点", endpoint: anthropicEndpoint },
    );
    result["codex-atlas"] = metadata(
      "Codex CLI（Atlas Coding Plan）",
      atlas.model,
      apiEngineTier("atlas", atlas),
      "网关配置·Atlas Coding Plan",
      { ...common, access: "Codex CLI · OpenAI 兼容端点", endpoint: openAiEndpoint },
    );
    result["hermes-atlas"] = metadata(
      "Hermes（Atlas Coding Plan）",
      atlas.model,
      apiEngineTier("atlas", atlas),
      "网关配置·Atlas Coding Plan",
      { ...common, access: "Hermes Agent CLI · OpenAI 兼容端点", endpoint: openAiEndpoint },
    );
  }
  // 故事点引擎 claude-volcengine 的全局默认模型 = 设置页「火山方舟」model
  const volc = config.apiEngines?.volcengine;
  if (volc && (volc.enabled || volc.apiKey || volc.model)) {
    result["claude-volcengine"] = {
      ...metadata(
        "Claude Code（火山方舟）",
        volc.model || "ark-code-latest",
        apiEngineTier("volcengine", volc),
        "网关配置·火山方舟",
        {
          provider: "火山方舟",
          access: "Claude Code CLI · Anthropic 兼容端点",
          endpoint: volc.anthropicBaseUrl || volc.baseUrl,
          official: false,
        },
      ),
      availableModels: Array.isArray(volc.availableModels) ? volc.availableModels : [],
    };
  }
  const minimax = config.apiEngines?.minimax;
  if (minimax && (minimax.enabled || minimax.apiKey || minimax.model)) {
    const minimaxModel = minimax.model || "MiniMax-M3";
    const minimaxEndpoint = minimax.baseUrl || "https://api.minimaxi.com/v1";
    result["claude-minimax"] = metadata(
      "Claude Code（MiniMax）",
      minimaxModel,
      apiEngineTier("minimax", minimax),
      "网关配置·MiniMax",
      {
        provider: "MiniMax",
        access: "Claude Code CLI · Anthropic 兼容端点",
        endpoint: String(minimaxEndpoint).replace(/\/v1\/?$/i, "/anthropic"),
        official: false,
      },
    );
    result["codex-minimax"] = metadata(
      "Codex CLI（MiniMax）",
      minimaxModel,
      apiEngineTier("minimax", minimax),
      "网关配置·MiniMax",
      {
        provider: "MiniMax",
        access: "Codex CLI · OpenAI 兼容端点",
        endpoint: String(minimaxEndpoint).replace(/\/anthropic\/?$/i, "/v1"),
        official: false,
      },
    );
  }
  return result;
}

/**
 * Describe the backend that the center-node text proxy will actually invoke.
 * This is deliberately derived from the proxy's effective fallback rules,
 * rather than from the engine requested by a remote story tab: Agent V2's
 * reasoning process currently uses runClaudeText and the center owns that
 * backend choice.
 */
export function getClaudeProxyAiSnapshot({
  cwd = "",
  config = {},
  env = process.env,
  home = os.homedir(),
  io = fs,
  capturedAt = Date.now(),
} = {}) {
  const proxy = config.claudeProxy || {};
  const configuredBackend = clean(proxy.backend) || "cli";
  const apiEngineId = clean(proxy.apiEngineId) || "openai";
  const apiEngine = config.apiEngines?.[apiEngineId] || null;
  const backend = configuredBackend === "codex"
    ? "codex"
    : configuredBackend === "api" && clean(proxy.anthropicApiKey)
      ? "api"
      : configuredBackend === "api-engine" && apiEngine?.enabled && clean(apiEngine.apiKey)
        ? "api-engine"
        : "cli";

  let actual;
  if (backend === "codex") {
    actual = {
      ...readCodexModelMetadata({ cwd, env, home, io }),
      access: "Codex CLI · exec",
    };
  } else if (backend === "api") {
    const endpoint = clean(proxy.anthropicBaseUrl) || "https://api.anthropic.com";
    const provider = knownProvider("anthropic", endpoint, "Anthropic 兼容服务商");
    const official = /api\.anthropic\.com/i.test(endpoint);
    actual = metadata(
      official ? "Anthropic Messages API（官方）" : `Anthropic 兼容 API（${provider}）`,
      clean(proxy.anthropicModel) || "claude-sonnet-4-6",
      "",
      "中心机代理配置",
      { provider, access: "Anthropic Messages API", endpoint, official },
    );
  } else if (backend === "api-engine") {
    actual = getAiModelMetadata({ cwd, config, env, home, io })[apiEngineId] || metadata(
      apiEngine?.name || apiEngineId,
      apiEngine?.model,
      apiEngineTier(apiEngineId, apiEngine || {}),
      "中心机代理配置",
      {
        provider: knownProvider(apiEngineId, apiEngine?.baseUrl, apiEngine?.name),
        access: "网关直连 · OpenAI 兼容 API",
        endpoint: apiEngine?.baseUrl,
        official: false,
      },
    );
  } else {
    // runViaClaudeCli inherits the center process environment and default
    // ~/.claude directory, so do not apply the isolated "official" env rules
    // used by the story runner's dedicated official-Claude engine.
    actual = readClaudeModelMetadata({ cwd, env, home, io });
  }

  const snapshot = {
    engine: "center",
    model: clean(actual.model),
    tier: clean(actual.tier),
    capturedAt: Number(capturedAt) || Date.now(),
    name: `中心机 · ${clean(actual.name) || "AI 后端"}`,
    provider: clean(actual.provider) || "未识别服务商",
    access: `Agent V2 → ${clean(actual.access) || backend}`,
    proxyBackend: backend,
  };
  if (clean(actual.endpoint)) snapshot.endpoint = safeEndpoint(actual.endpoint);
  if (actual.official != null) snapshot.official = !!actual.official;
  return snapshot;
}

/**
 * Capture the immutable model configuration used when a conversation turn is
 * dispatched. The presence of this snapshot is significant: empty model/tier
 * values mean the engine used its configured default, while old messages with
 * no snapshot mean that information was never recorded.
 */
export function getAiModelSnapshot({
  engine,
  modelOverride = "",
  tierOverride = "",
  capturedAt = Date.now(),
  ...options
} = {}) {
  const engineId = clean(engine);
  const item = getAiModelMetadata(options)[engineId] || {};
  const snapshot = {
    engine: engineId,
    model: clean(modelOverride) || clean(item.model),
    tier: clean(tierOverride) || clean(item.tier),
    capturedAt: Number(capturedAt) || Date.now(),
  };
  for (const key of ["name", "provider", "access", "endpoint"]) {
    const value = clean(item[key]);
    if (value) snapshot[key] = value;
  }
  if (item.official != null) snapshot.official = !!item.official;
  return snapshot;
}
