/**
 * 平台能力文档生成器
 *
 * 从 skills/ 目录自动生成能力摘要，供：
 * 1. AI 对话时注入 prompt（让 AI 知道平台能做什么）
 * 2. 前端展示（用户查看系统能力）
 * 3. AI 规划器分配 Skill
 */

import { readdirSync, readFileSync, statSync } from "fs";
import { join, dirname, relative } from "path";
import { fileURLToPath } from "url";
import { getConfigValue } from "./config.js";
import { isClaudeVolcengineReady } from "./claude-volcengine.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const SKILLS_DIR = join(__dirname, "..", "..", "skills");

// 内部 Skill（不对外展示）
const INTERNAL_SKILLS = new Set(["workflow-inspector"]);

let cachedDoc = null;
let cacheVersion = null;

// 从 Skill ID 和描述推断触发关键词
function inferTriggers(skillId, description) {
  const text = `${skillId} ${description}`.toLowerCase();
  const keywords = [];
  const patterns = {
    "bug|crash|anr|异常|崩溃|报错": ["bug", "crash", "ANR", "异常"],
    "smali|反编译|hook|dex": ["smali", "反编译", "hook", "dex"],
    "分辨率|dpi|适配|布局": ["分辨率", "DPI", "适配"],
    "adb|logcat|dumpsys|apk": ["adb", "logcat", "安装"],
    "搜索|网页|url|查找": ["搜索", "查找", "网页"],
    "文件|进程|系统|目录": ["文件", "系统", "进程"],
    "media|媒体|播放|音乐": ["媒体", "播放"],
    "elog|解密|加密": ["ELOG", "解密"],
    "voice|语音|热词": ["语音", "热词"],
    "工作流|任务|钉钉": ["工作流", "任务"],
  };
  for (const [pattern, tags] of Object.entries(patterns)) {
    if (new RegExp(pattern, "i").test(text)) keywords.push(...tags);
  }
  return keywords.length > 0 ? keywords : [skillId];
}

// 明确标记为涉及代码/文件修改的 Skill（手动维护，更准确）
const KNOWN_MODIFICATION_SKILLS = new Set(["smali-analyze", "resolution-adapt"]);
// 明确不涉及修改的 Skill
const KNOWN_READONLY_SKILLS = new Set([
  "bug-report", "adb-helper", "web-search", "os-helper", "task-workflow",
  "summarize", "healthcheck", "github", "skill-creator", "coding-agent",
  "media-debug", "decrypt-elog", "analyze-voice-see-logs", "mac-os-helper",
]);

function inferModification(skillId, description, content) {
  if (KNOWN_MODIFICATION_SKILLS.has(skillId)) return true;
  if (KNOWN_READONLY_SKILLS.has(skillId)) return false;
  // 未知 Skill：从描述推断
  return /修改|patch|hook|替换|覆盖/.test(description);
}

/**
 * 解析 Skill frontmatter
 */
function parseFrontmatter(content) {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return {};
  const meta = {};
  for (const line of match[1].split("\n")) {
    const idx = line.indexOf(":");
    if (idx > 0) {
      meta[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
    }
  }
  return meta;
}

/**
 * 递归扫描 .md 文件
 */
function scanMarkdownFiles(dir, baseDir = dir) {
  const results = [];
  try {
    for (const entry of readdirSync(dir)) {
      const fullPath = join(dir, entry);
      try {
        const stat = statSync(fullPath);
        if (stat.isDirectory()) {
          results.push(...scanMarkdownFiles(fullPath, baseDir));
        } else if (entry.endsWith(".md")) {
          results.push({ relPath: relative(baseDir, fullPath).replace(/\\/g, "/"), fullPath });
        }
      } catch {}
    }
  } catch {}
  return results;
}

/**
 * 生成能力文档
 */
export function generateCapabilityDoc() {
  const files = scanMarkdownFiles(SKILLS_DIR);
  const capabilities = [];

  for (const { relPath, fullPath } of files) {
    const content = readFileSync(fullPath, "utf-8");
    const meta = parseFrontmatter(content);
    const id = relPath.replace(/\.md$/, "");
    const skillId = id.includes("/") ? id.split("/").pop() : id;

    // 跳过内部 Skill
    if (INTERNAL_SKILLS.has(skillId)) continue;

    const triggers = meta.triggers
      ? meta.triggers.split(",").map(t => t.trim()).filter(Boolean)
      : inferTriggers(skillId, meta.description || "");

    // 自动推断是否涉及修改（frontmatter > 关键词推断）
    const isModification = meta.modification !== undefined
      ? meta.modification === "true"
      : inferModification(skillId, meta.description || "", content);

    capabilities.push({
      skill: skillId,
      name: meta.name || skillId,
      description: meta.description || "",
      triggers,
      isModification,
      engine: meta.engine || "auto",
    });
  }

  // 可用引擎列表（CLI + API）
  const engines = ["claude"];
  if (isClaudeVolcengineReady()) engines.push("claude-volcengine");
  if (getConfigValue("geminiEnabled")) engines.push("gemini");
  if (getConfigValue("codexEnabled")) engines.push("codex");
  if (getConfigValue("hermesEnabled")) engines.push("hermes");
  const apiEngines = getConfigValue("apiEngines") || {};
  for (const [id, cfg] of Object.entries(apiEngines)) {
    if (cfg.enabled && cfg.apiKey) engines.push(id);
  }

  // 生成纯文本摘要（注入 AI prompt 用）
  const lines = ["你可以使用以下 Skill 来完成任务："];
  for (const cap of capabilities) {
    const modTag = cap.isModification ? " [涉及修改]" : "";
    lines.push(`- /${cap.skill}: ${cap.description}${modTag}`);
  }
  lines.push("");
  const engineLabels = {
    claude: "Claude官方(订阅制)",
    "claude-volcengine": "Claude火山方舟(Agent Plan)",
    gemini: "Gemini(免费轻量)",
    codex: "Codex(代码专精)",
    hermes: "Hermes(本地智能体)",
    qwen: "通义千问(API)",
    kimi: "Kimi(API)",
    deepseek: "DeepSeek(API)",
    openai: "OpenAI GPT(API)",
    bigmodel: "智谱BigModel(API)",
    volcengine: "火山方舟Agent/Coding Plan(API)",
  };
  lines.push(`可用引擎: ${engines.map(e => engineLabels[e] || `${e}(API)`).join(", ")}`);
  lines.push("");
  lines.push("规则：涉及修改的任务必须设置 inspect: true（强制审查）。");

  const summary = lines.join("\n");

  const doc = {
    version: new Date().toISOString(),
    capabilities,
    engines,
    summary,
  };

  cachedDoc = doc;
  cacheVersion = doc.version;
  return doc;
}

/**
 * 获取能力文档（带缓存）
 */
export function getCapabilityDoc() {
  if (!cachedDoc) generateCapabilityDoc();
  return cachedDoc;
}

/**
 * 获取纯文本摘要（注入 prompt 用）
 */
export function getCapabilitySummary() {
  return getCapabilityDoc().summary;
}

/**
 * 获取修改类 Skill 集合
 */
export function getModificationSkills() {
  const doc = getCapabilityDoc();
  return new Set(doc.capabilities.filter(c => c.isModification).map(c => c.skill));
}

/**
 * 清除缓存（Skills 变更时调用）
 */
export function invalidateCapabilityCache() {
  cachedDoc = null;
  cacheVersion = null;
}
