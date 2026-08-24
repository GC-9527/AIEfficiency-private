import { log } from "./logger.js";
import { getConfig } from "./config.js";
import { listWorkflows } from "../db/sqlite.js";
import { readdirSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import {
  ATLAS_CLAUDE_ENGINE_ID,
  ATLAS_CODEX_ENGINE_ID,
  ATLAS_HERMES_ENGINE_ID,
  isAtlasReady,
} from "./atlas-client-config.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const SKILLS_DIR = join(__dirname, "..", "..", "skills");

// 任务类型 -> 推荐引擎
const ENGINE_PREFERENCE = {
  bug_analysis: "claude",
  smali_modify: "claude",
  complex_adaptation: "claude",
  multi_step: "claude",
  adb_operation: "claude",
  web_search: "claude",
  os_operation: "claude",
  mac_operation: "claude",
  general: "claude",

  log_filter: "gemini",
  config_generate: "gemini",
  info_query: "gemini",
  simple_adaptation: "gemini",
  batch_scan: "gemini",
};

// 任务类型 -> 对应Skill（没有映射的不绑定 skill，让引擎自由发挥）
const SKILL_MAP = {
  bug_analysis: "bug-report",
  smali_modify: "smali-analyze",
  complex_adaptation: "resolution-adapt",
  simple_adaptation: "resolution-adapt",
  adb_operation: "adb-helper",
  multi_step: "task-workflow",
  web_search: "web-search",
  os_operation: "os-helper",
  mac_operation: "mac-os-helper",
};

/**
 * 检查引擎是否可用
 */
function isEngineAvailable(engine, config) {
  if (engine === "claude") return true; // CLI 始终尝试
  if (engine === "claude-volcengine") {
    const v = config.apiEngines?.volcengine;
    return !!(v?.enabled && String(v?.apiKey || "").trim());
  }
  if (engine === "claude-minimax") {
    const m = config.apiEngines?.minimax;
    return !!(m?.enabled && String(m?.apiKey || "").trim());
  }
  if (engine === "codex-minimax") {
    const m = config.apiEngines?.minimax;
    return !!(m?.enabled && String(m?.apiKey || "").trim());
  }
  if (engine === ATLAS_CLAUDE_ENGINE_ID || engine === ATLAS_CODEX_ENGINE_ID || engine === ATLAS_HERMES_ENGINE_ID) {
    return isAtlasReady();
  }
  if (engine === "claude-proxy") return !!(config.claudeProxyClient?.enabled && config.claudeProxyClient?.host); // 中心 AI 代理（远端）
  if (engine === "gemini") return !!config.geminiEnabled;
  if (engine === "codex") return !!config.codexEnabled;
  if (engine === "hermes") return !!config.hermesEnabled;
  // API 引擎
  const apiEngines = config.apiEngines || {};
  return !!(apiEngines[engine]?.enabled && apiEngines[engine]?.apiKey);
}

/**
 * 分派任务
 * 优先级：explicitEngine > defaultEngine > ENGINE_PREFERENCE > "claude"
 */
export function dispatch(task) {
  const config = getConfig();
  const explicitSkill = task.explicitSkill || null;

  // 1. 显式指定引擎（最高优先级）
  let engine = task.explicitEngine || null;
  if (engine && !isEngineAvailable(engine, config)) {
    if (task.allowEngineFallback === false) {
      // 显式禁止回退的交互任务（如故事点）必须尊重用户选择。
      // CLI 是否真的可用交给执行阶段验证；不能因全局启用开关关闭就静默改跑 Claude。
      log(task.id, "warn", "dispatcher", `显式引擎 ${engine} 未在全局启用，按任务约束继续使用该引擎`);
    } else {
      log(task.id, "warn", "dispatcher", `显式引擎 ${engine} 不可用（未启用/未配置Key），回退到默认引擎`);
      engine = null;
    }
  }

  // 2. 用户配置的默认引擎（如果可用）
  if (!engine && config.defaultEngine && isEngineAvailable(config.defaultEngine, config)) {
    engine = config.defaultEngine;
  }

  // 3. 任务类型推荐引擎（仅 CLI 引擎可用时才使用）
  if (!engine) {
    const recommended = ENGINE_PREFERENCE[task.type];
    if (recommended && isEngineAvailable(recommended, config)) {
      engine = recommended;
    }
  }

  // 4. 最终兜底：找第一个可用的引擎
  if (!engine) {
    const fallbackOrder = [
      "claude",
      "claude-volcengine",
      "claude-minimax",
      ATLAS_CLAUDE_ENGINE_ID,
      "gemini",
      "codex",
      "codex-minimax",
      ATLAS_CODEX_ENGINE_ID,
      "hermes",
      ATLAS_HERMES_ENGINE_ID,
      ...Object.keys(config.apiEngines || {}),
    ];
    engine = fallbackOrder.find(e => isEngineAvailable(e, config)) || "claude";
  }

  // 关键词触发：任务标题/描述含特定标记时覆盖默认 skill 映射
  // 优先级：explicitSkill > keywordSkill > SKILL_MAP
  const keywordSkill = explicitSkill ? null : detectSkillFromKeywords(task);
  const skill = explicitSkill || keywordSkill || SKILL_MAP[task.type] || null;

  log(
    task.id,
    "info",
    "dispatcher",
    `任务分配: type=${task.type} -> engine=${engine}${skill ? `, skill=/${skill}` : ""}${explicitSkill ? " (显式)" : keywordSkill ? " (关键词)" : ""}`
  );

  return { engine, skill };
}

/**
 * 基于任务标题/描述中的关键词识别应走的 Skill
 * 支持的触发：
 *   - [SOP] 标签、/bug-sop 指令、"完整流程"/"bug-sop"等描述 → bug-sop
 * 返回匹配的 skill 名，无匹配返回 null
 */
function detectSkillFromKeywords(task) {
  const text = `${task.title || ""}\n${task.description || ""}`;
  if (/\[SOP\]|\/bug-sop\b|完整bug流程|bug.?sop/i.test(text)) {
    return "bug-sop";
  }
  return null;
}

/**
 * 获取备用引擎
 */
export function getFallbackEngine(failedEngine, config) {
  if (!config) config = getConfig();

  // 找一个不同于失败引擎的可用引擎
  const all = ["claude", ATLAS_CLAUDE_ENGINE_ID, "gemini", "codex", ATLAS_CODEX_ENGINE_ID, "hermes", ATLAS_HERMES_ENGINE_ID, ...Object.keys(config.apiEngines || {})];
  for (const e of all) {
    if (e !== failedEngine && isEngineAvailable(e, config)) return e;
  }
  return null;
}

/**
 * 解析显式 /skill-name 命令
 * 如果消息以 /xxx 开头且 xxx 对应一个存在的 skill 文件，返回 { skill, rest }
 * 否则返回 null
 */
export function parseExplicitSkill(text) {
  const match = text.match(/^\/([a-zA-Z0-9_\u4e00-\u9fff-]+)\s*([\s\S]*)/);
  if (!match) return null;

  const skillName = match[1];
  const rest = match[2].trim();

  // 检查对应的 skill 文件是否存在（支持子目录）
  try {
    const exists = [
      join(SKILLS_DIR, `${skillName}.md`),
      join(SKILLS_DIR, skillName, `${skillName}.md`),
    ].some((p) => existsSync(p));
    if (exists) {
      return { skill: skillName, rest };
    }
  } catch {}

  // Skill 没匹配到时，查 workflows 表
  try {
    const workflows = listWorkflows();
    const matched = workflows.find((w) => w.name === skillName);
    if (matched) {
      return { workflow: matched, rest };
    }
  } catch {}

  return null;
}

// 分类规则：优先级从高到低排列，支持权重评分
// 多个规则同时匹配时，取优先级最高的（靠前的）
const CLASSIFY_RULES = [
  // P1: 强推理任务（优先匹配，避免被简单类型抢走）
  {
    type: "smali_modify",
    pattern: /smali|反编译|修改代码|hook|dex|patch|字节码/,
  },
  {
    type: "bug_analysis",
    pattern: /bug|crash|anr|异常|崩溃|报错|闪退|error|exception|卡死|无响应|白屏|黑屏|超时|oom|内存泄漏|tombstone|watchdog|死锁|force.?close|空指针|npe/i,
  },
  // P2: 适配类（带修改动词 → complex，否则 simple）
  {
    type: "complex_adaptation",
    pattern: /(?=.*(?:分辨率|dpi|适配|布局|屏幕|显示))(?=.*(?:修改|创建|生成|调整|改|写|做))/,
  },
  {
    type: "simple_adaptation",
    pattern: /分辨率|dpi|适配|布局|屏幕/,
  },
  // P3: ADB 操作
  {
    type: "adb_operation",
    pattern: /\badb\b|设备连接|安装apk|卸载应用|push|pull|dumpsys|logcat.*抓|抓.*logcat|截图|录屏|screencap/i,
  },
  // P4: 简单任务（Gemini）
  {
    type: "log_filter",
    pattern: /日志|logcat|过滤|筛选/,
  },
  {
    type: "config_generate",
    pattern: /配置|模板/,
  },
  {
    type: "batch_scan",
    pattern: /批量|扫描|多个/,
  },
  // P4.5: Web搜索
  {
    type: "web_search",
    pattern: /搜索|搜一下|查一下|google|百度|网上|在线|检索|网页|url|链接|官网|文档站/,
  },
  // P4.6: 操作系统操作
  {
    type: "os_operation",
    pattern: /打开浏览器|打开文件|打开目录|打开终端|系统信息|磁盘|内存|进程|端口|tasklist|explorer|文件管理|运行程序/,
  },
  // P5: 信息查询
  {
    type: "info_query",
    pattern: /查询|查看|什么是|有哪些|列出|信息|怎么|如何|是什么|区别|对比|解释/,
  },
  // P6: 多步骤任务
  {
    type: "multi_step",
    pattern: /步骤|流程|先.{0,10}然后|依次|多步|第一步|工作流|完整流程|从.*到/,
  },
  {
    type: "mac_operation",
    pattern: /macos|mac os|macbook|imac|mac mini|mac studio|\bmac\b|苹果电脑|苹果系统|mac系统|访达|启动台|聚焦搜索|finder|launchctl|plist|homebrew|\bbrew\b|xcode-select|scutil|networksetup|diskutil|mdfind|spotlight|osascript|open -a|launchagent|launchdaemon/i,
  },
];

/**
 * 智能分类 - 根据任务描述自动判断类型
 * 按优先级顺序匹配，首个命中即返回
 */
export function classifyTask(description) {
  const desc = description.toLowerCase();

  if (/macos|mac os|macbook|imac|mac mini|mac studio|\bmac\b|苹果电脑|苹果系统|mac系统|访达|启动台|聚焦搜索|finder|launchctl|plist|homebrew|\bbrew\b|xcode-select|scutil|networksetup|diskutil|mdfind|spotlight|osascript|open -a|launchagent|launchdaemon/i.test(desc)) {
    return "mac_operation";
  }

  for (const rule of CLASSIFY_RULES) {
    if (rule.pattern.test(desc)) {
      return rule.type;
    }
  }

  // 默认：通用任务，不绑定任何 skill，让引擎直接处理
  return "general";
}

/**
 * 判断是否需要任务拆分（正则预筛）
 * 仅返回 true 时才调用 LLM 进行实际拆分
 */
export function needsDecomposition(description) {
  if (!description || description.length < 15) return false;

  const desc = description.toLowerCase();

  // 检测复合意图关键词
  const compoundPatterns = [
    /同时.{2,}(并且|和|以及)/,
    /先.{2,}再.{2,}/,
    /先.{2,}然后.{2,}最后/,
    /第一步.{2,}第二步/,
    /分别.{2,}(和|以及|还有)/,
    /一方面.{2,}另一方面/,
  ];

  for (const pattern of compoundPatterns) {
    if (pattern.test(desc)) return true;
  }

  // 检测多动词（任务动词 >= 3 个）
  const taskVerbs = desc.match(/分析|检查|检测|生成|创建|修改|修复|查看|抓取|扫描|对比|部署|安装|卸载|拉取|推送|适配|编译|打包|测试/g);
  if (taskVerbs && taskVerbs.length >= 3) return true;

  // 长文本 + 多动词（>= 2）
  if (desc.length > 200 && taskVerbs && taskVerbs.length >= 2) return true;

  return false;
}

import { getEnabledApiEngines } from "./api-engine.js";

export function getEngineInfo(engine) {
  const builtinEngines = {
    claude: { name: "Claude（官方）", type: "subscription", description: "Anthropic 官方订阅 Claude Code" },
    "claude-volcengine": { name: "Claude（火山方舟）", type: "cli", description: "Claude CLI + 方舟 Agent/Coding Plan" },
    "claude-minimax": { name: "Claude（MiniMax）", type: "cli", description: "Claude CLI + MiniMax Anthropic 兼容" },
    gemini: { name: "Gemini CLI", type: "free", description: "免费引擎（1000次/天）" },
    codex: { name: "OpenAI Codex", type: "cli", description: "代码专精引擎" },
    hermes: { name: "Hermes Agent", type: "cli", description: "本地工具调用智能体" },
    "codex-minimax": { name: "Codex（MiniMax）", type: "cli", description: "Codex CLI + MiniMax OpenAI 兼容" },
    [ATLAS_CLAUDE_ENGINE_ID]: { name: "Claude Code（Atlas Coding Plan）", type: "cli", description: "Claude Code CLI + Atlas Anthropic 兼容" },
    [ATLAS_CODEX_ENGINE_ID]: { name: "Codex CLI（Atlas Coding Plan）", type: "cli", description: "Codex CLI + Atlas OpenAI 兼容" },
    [ATLAS_HERMES_ENGINE_ID]: { name: "Hermes（Atlas Coding Plan）", type: "cli", description: "Hermes Agent + Atlas OpenAI 兼容" },
  };

  if (builtinEngines[engine]) return builtinEngines[engine];

  // 查找 API 引擎
  const apiEngines = getEnabledApiEngines();
  const found = apiEngines.find(e => e.id === engine);
  if (found) return { name: found.name, type: "api", description: `${found.name} (${found.model})` };

  return builtinEngines.claude;
}

/**
 * 获取所有可用引擎列表（内置 + API）
 */
export function getAllAvailableEngines() {
  const engines = [
    { id: "claude", name: "Claude（官方）", type: "subscription", enabled: true },
    { id: "claude-volcengine", name: "Claude（火山方舟）", type: "cli", enabled: isEngineAvailable("claude-volcengine", getConfig()) },
    { id: "claude-minimax", name: "Claude（MiniMax）", type: "cli", enabled: isEngineAvailable("claude-minimax", getConfig()) },
    { id: "gemini", name: "Gemini CLI", type: "free", enabled: false }, // config 控制
    { id: "codex", name: "OpenAI Codex", type: "cli", enabled: false },
    { id: "hermes", name: "Hermes Agent", type: "cli", enabled: isEngineAvailable("hermes", getConfig()) },
    { id: "codex-minimax", name: "Codex（MiniMax）", type: "cli", enabled: isEngineAvailable("codex-minimax", getConfig()) },
    { id: ATLAS_CLAUDE_ENGINE_ID, name: "Claude Code（Atlas Coding Plan）", type: "cli", enabled: isEngineAvailable(ATLAS_CLAUDE_ENGINE_ID, getConfig()) },
    { id: ATLAS_CODEX_ENGINE_ID, name: "Codex CLI（Atlas Coding Plan）", type: "cli", enabled: isEngineAvailable(ATLAS_CODEX_ENGINE_ID, getConfig()) },
    { id: ATLAS_HERMES_ENGINE_ID, name: "Hermes（Atlas Coding Plan）", type: "cli", enabled: isEngineAvailable(ATLAS_HERMES_ENGINE_ID, getConfig()) },
  ];
  for (const api of getEnabledApiEngines()) {
    engines.push({ id: api.id, name: api.name, type: "api", model: api.model, enabled: true });
  }
  return engines;
}
