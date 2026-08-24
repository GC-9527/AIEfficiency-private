/**
 * AI 模型 / CLI 版本诊断：探测本机已装 Claude/Codex/Gemini，对比 npm latest，
 * 并汇总各引擎可见模型清单（故事点可选 catalog + API 引擎 availableModels）。
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { getConfig } from "../config.js";
import { getAiModelMetadata } from "../ai-model-metadata.js";
import { ENGINE_MODEL_CATALOGS } from "./ai-engine-prefs.js";
import { hermesExecutable } from "../hermes-cli.js";

const execFileAsync = promisify(execFile);

export const AI_CLI_ENGINES = [
  {
    id: "claude",
    name: "Claude Code",
    cmd: "claude",
    versionArgs: ["--version"],
    pkg: "@anthropic-ai/claude-code",
    upgradeCmd: "npm install -g @anthropic-ai/claude-code@latest",
    docsUrl: "https://docs.anthropic.com/en/docs/claude-code/overview",
  },
  {
    id: "codex",
    name: "Codex CLI",
    cmd: "codex",
    versionArgs: ["--version"],
    pkg: "@openai/codex",
    upgradeCmd: "npm install -g @openai/codex@latest",
    docsUrl: "https://github.com/openai/codex",
  },
  {
    id: "gemini",
    name: "Gemini CLI",
    cmd: "gemini",
    versionArgs: ["--version"],
    pkg: "@google/gemini-cli",
    upgradeCmd: "npm install -g @google/gemini-cli@latest",
    docsUrl: "https://github.com/google-gemini/gemini-cli",
  },
  {
    id: "hermes",
    name: "Hermes Agent",
    cmd: hermesExecutable(),
    versionArgs: ["--version"],
    pkg: "",
    autoUpgradeable: false,
    upgradeCmd: "hermes update",
    docsUrl: "https://hermes-agent.nousresearch.com/docs/getting-started/quickstart",
  },
  {
    id: "opencode",
    name: "OpenCode",
    cmd: "opencode",
    versionArgs: ["--version"],
    pkg: "opencode-ai",
    upgradeCmd: "npm install -g opencode-ai@latest",
    docsUrl: "https://opencode.ai/docs",
  },
  {
    id: "arkcli",
    name: "Ark CLI（火山方舟）",
    cmd: "arkcli",
    versionArgs: ["--version"],
    pkg: "@volcengine/ark-cli",
    upgradeCmd: "npm install -g @volcengine/ark-cli@latest",
    docsUrl: "https://www.npmjs.com/package/@volcengine/ark-cli",
  },
];

/** 从 CLI 输出中提取首个 x.y.z（可含预发布后缀）。 */
export function extractVersion(text) {
  const m = String(text || "").match(/(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)/);
  return m ? m[1] : "";
}

/** 简易 semver 比较：a>b→1，a<b→-1，相等→0；无法解析返回 null。 */
export function compareSemver(a, b) {
  const pa = parseSemverParts(a);
  const pb = parseSemverParts(b);
  if (!pa || !pb) return null;
  for (let i = 0; i < 3; i += 1) {
    if (pa.nums[i] > pb.nums[i]) return 1;
    if (pa.nums[i] < pb.nums[i]) return -1;
  }
  if (pa.pre === pb.pre) return 0;
  if (!pa.pre && pb.pre) return 1;
  if (pa.pre && !pb.pre) return -1;
  return pa.pre > pb.pre ? 1 : -1;
}

function parseSemverParts(raw) {
  const v = extractVersion(raw) || String(raw || "").trim();
  const m = v.match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/);
  if (!m) return null;
  return {
    nums: [Number(m[1]), Number(m[2]), Number(m[3])],
    pre: m[4] || "",
  };
}

export function versionStatus(localVersion, latestVersion, installed) {
  if (!installed) return "not_installed";
  if (!localVersion || !latestVersion) return "unknown";
  const cmp = compareSemver(localVersion, latestVersion);
  if (cmp == null) return "unknown";
  if (cmp >= 0) return "up_to_date";
  return "outdated";
}

export function summarizeEngines(engines = []) {
  const installed = engines.filter((e) => e.installed).length;
  const upToDate = engines.filter((e) => e.status === "up_to_date").length;
  const outdated = engines.filter((e) => e.status === "outdated").length;
  const missing = engines.filter((e) => e.status === "not_installed").length;
  const unknown = engines.filter((e) => e.status === "unknown").length;
  return {
    total: engines.length,
    installed,
    upToDate,
    outdated,
    missing,
    unknown,
    allLatest: installed > 0 && outdated === 0 && missing === 0 && unknown === 0,
    anyOutdated: outdated > 0,
  };
}

function probeCmd(cmd, args, { timeout = 10000 } = {}) {
  return execFileAsync(cmd, args, {
    windowsHide: true,
    timeout,
    shell: process.platform === "win32",
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
  }).then(
    ({ stdout, stderr }) => ({ ok: true, out: String(stdout || "") + String(stderr || "") }),
    (err) => ({ ok: false, out: String(err?.stdout || "") + String(err?.stderr || "") + String(err?.message || "") }),
  );
}

export async function fetchNpmLatestVersion(pkg, { probe = probeCmd } = {}) {
  const r = await probe("npm", ["view", pkg, "version"], { timeout: 20000 });
  if (!r.ok) return { version: "", error: "无法查询 npm latest（网络或 npm 不可用）" };
  const version = extractVersion(r.out) || String(r.out || "").trim().split(/\r?\n/)[0].trim();
  if (!/^\d+\.\d+/.test(version)) return { version: "", error: "npm 返回版本无法解析" };
  return { version, error: "" };
}

function catalogFor(engineId) {
  const cat = ENGINE_MODEL_CATALOGS[engineId] || { models: [], tiers: [] };
  const models = Array.isArray(cat.models) ? cat.models.map((m) => String(m).trim()).filter(Boolean) : [];
  const tiers = Array.isArray(cat.tiers) ? cat.tiers.map((t) => String(t).trim()).filter(Boolean) : [];
  return {
    models,
    tiers,
    /** 清单前列视为当前推荐/最新可见模型 */
    latestModels: models.slice(0, Math.min(3, models.length)),
  };
}

function buildApiEngineRows(config = getConfig()) {
  const apiEngines = config?.apiEngines && typeof config.apiEngines === "object" ? config.apiEngines : {};
  return Object.entries(apiEngines).map(([id, cfg]) => {
    const availableModels = Array.isArray(cfg?.availableModels)
      ? cfg.availableModels.map((m) => String(m).trim()).filter(Boolean)
      : [];
    const model = String(cfg?.model || "").trim();
    return {
      id,
      name: String(cfg?.name || id).trim() || id,
      type: "api",
      enabled: !!cfg?.enabled,
      hasKey: !!cfg?.apiKey,
      model,
      availableModels,
      latestModels: availableModels.slice(0, Math.min(3, availableModels.length)),
      status: !cfg?.enabled ? "disabled" : (cfg?.apiKey ? "configured" : "missing_key"),
    };
  });
}

/**
 * 诊断本机 CLI 引擎版本 + 可见模型清单 + API 引擎模型。
 * @param {{ probe?: Function, fetchLatest?: Function, getMetadata?: Function, getCfg?: Function }} [deps]
 */
export async function diagnoseAiModels(deps = {}) {
  const probe = deps.probe || probeCmd;
  const fetchLatest = deps.fetchLatest || ((pkg) => fetchNpmLatestVersion(pkg, { probe }));
  const config = typeof deps.getCfg === "function" ? deps.getCfg() : getConfig();
  const metadata = typeof deps.getMetadata === "function"
    ? deps.getMetadata()
    : getAiModelMetadata({ config });

  const engines = [];
  for (const def of AI_CLI_ENGINES) {
    const local = await probe(def.cmd, def.versionArgs);
    const localVersion = local.ok ? extractVersion(local.out) : "";
    const installed = !!(local.ok && localVersion);
    const latest = def.pkg
      ? await fetchLatest(def.pkg)
      : { version: "", error: "Hermes 版本由 hermes update 管理" };
    const status = def.pkg ? versionStatus(localVersion, latest.version, installed) : (installed ? "unknown" : "not_installed");
    const meta = metadata?.[def.id] || {};
    const catalog = catalogFor(def.id);
    engines.push({
      id: def.id,
      name: def.name,
      type: "cli",
      pkg: def.pkg,
      autoUpgradeable: def.autoUpgradeable !== false,
      upgradeCmd: def.upgradeCmd,
      docsUrl: def.docsUrl,
      installed,
      localVersion: localVersion || "",
      latestVersion: latest.version || "",
      latestError: latest.error || "",
      upToDate: status === "up_to_date",
      status,
      currentModel: String(meta.model || "").trim(),
      currentTier: String(meta.tier || "").trim(),
      modelSource: String(meta.source || "").trim(),
      models: catalog.models,
      tiers: catalog.tiers,
      latestModels: catalog.latestModels,
    });
  }

  const apiEngines = buildApiEngineRows(config);
  const summary = summarizeEngines(engines);
  return {
    checkedAt: new Date().toISOString(),
    platform: process.platform,
    summary,
    engines,
    apiEngines,
  };
}
