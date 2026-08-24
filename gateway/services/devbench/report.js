/**
 * devbench 工作/绩效总结报告：
 *  - 数据源：我与各 AI 引擎(Claude Code CLI / Codex CLI / devbench 故事点对话等)的对话记录 + Git 提交记录(当前 git 用户)
 *  - 周期：week/month/quarter/year，或 custom(自定义起止日期)
 *  - 快速路径：AI 只生成一份 Markdown，纯文本由本地转换；Word/PDF 为可选慢导出
 *  - 输出：<主工程>/docs/<word>/<git用户名>/<fileBase>.txt + <fileBase>_pro.md
 *  word: weekly|monthly|quarterly|annual|custom
 */
import { execSync, execFile, execFileSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";
import { randomUUID } from "crypto";
import JSZip from "jszip";
import { runTask } from "../agent-runner.js";
import { createTask, getChatMessagesInRange, updateTask, addTokenUsage } from "../../db/sqlite.js";
import { getConfig } from "../config.js";
import {
  log,
  broadcastChatStream,
  broadcastChatStreamEnd,
  broadcastTaskDispatched,
  broadcastTaskUpdate,
} from "../logger.js";
import { dispatch } from "../dispatcher.js";
import { getAiModelSnapshot } from "../ai-model-metadata.js";
import { callApiEngineText, isApiEngine } from "../api-engine.js";
import * as store from "./store.js";
import { markdownToPdf } from "./report-pdf.js";
import { collectAiSessions } from "./work-summary-evidence.js";
import { collectGitDataAsync, getAuthoritativeWorkReportRepositories } from "../work-report-repositories.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Claude Code CLI 会话目录（源）+ 备份目录。备份目录里保留历史会话（源被清理也能用于总结）。
const CLAUDE_PROJECTS = path.join(os.homedir(), ".claude", "projects");
export const CLAUDE_BACKUP_DIR = "D:\\backup\\claude";
const CLAUDE_BACKUP_PROJECTS = path.join(CLAUDE_BACKUP_DIR, "projects");

const pad = (n) => String(n).padStart(2, "0");
const ymd = (d) => `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
const iso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const REPORT_PERIODS = new Set(["week", "month", "quarter", "year", "custom"]);
const SUMMARY_OUTPUT_MODES = new Set(["concise", "report"]);
const TEXT_TEMPLATE_EXTENSIONS = new Set([
  ".txt", ".md", ".markdown", ".csv", ".json", ".yaml", ".yml", ".xml", ".html", ".htm", ".log",
]);
const IMAGE_TEMPLATE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif"]);
const OFFICE_TEMPLATE_EXTENSIONS = new Set([".docx", ".pptx", ".xlsx"]);
const IMAGE_TEMPLATE_ANALYSIS_MODEL = "claude-haiku-4-5";

export const DEFAULT_WEEKLY_TEMPLATE = [
  "本周完成工作",
  "下周工作计划",
  "本周工作总结",
  "需协调与帮助",
  "图片",
  "附件",
].join("\n");

export function normalizeSummaryOutputModes(value) {
  const raw = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const hasExplicitMode = Object.keys(raw).some((key) => SUMMARY_OUTPUT_MODES.has(key));
  return {
    concise: hasExplicitMode ? raw.concise === true : true,
    report: hasExplicitMode ? raw.report === true : false,
  };
}

function decodeXmlEntities(value) {
  return String(value || "")
    .replace(/<w:tab\/>/g, "\t")
    .replace(/<a:br\/>|<w:br\/>/g, "\n")
    .replace(/<\/w:p>|<\/a:p>|<\/si>|<\/row>/g, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, "\"")
    .replace(/&apos;/g, "'")
    .replace(/\s+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

async function extractOfficeTemplateText(buffer, extension) {
  const zip = await JSZip.loadAsync(buffer);
  const names = Object.keys(zip.files).filter((name) => {
    if (extension === ".docx") return /^word\/(?:document|header\d+|footer\d+)\.xml$/i.test(name);
    if (extension === ".pptx") return /^ppt\/slides\/slide\d+\.xml$/i.test(name);
    if (extension === ".xlsx") return /^xl\/(?:sharedStrings|worksheets\/sheet\d+)\.xml$/i.test(name);
    return false;
  }).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  const chunks = [];
  for (const name of names.slice(0, 120)) {
    const xml = await zip.file(name)?.async("string");
    const text = decodeXmlEntities(xml);
    if (text) chunks.push(text);
  }
  return chunks.join("\n\n").slice(0, 30000);
}

function extractPdfTemplateText(buffer) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aieff-summary-template-pdf-"));
  const filePath = path.join(dir, "template.pdf");
  fs.writeFileSync(filePath, buffer);
  try {
    try {
      return String(execFileSync("pdftotext", [filePath, "-"], {
        encoding: "utf8",
        timeout: 30000,
        windowsHide: true,
        maxBuffer: 4 * 1024 * 1024,
      }) || "").slice(0, 30000);
    } catch {
      const script = [
        "import sys",
        "p=sys.argv[1]",
        "text=''",
        "try:",
        " from pypdf import PdfReader",
        " text='\\n'.join((page.extract_text() or '') for page in PdfReader(p).pages)",
        "except Exception:",
        " import fitz",
        " doc=fitz.open(p)",
        " text='\\n'.join(page.get_text() for page in doc)",
        "print(text[:30000])",
      ].join("\n");
      return String(execFileSync("python", ["-c", script, filePath], {
        encoding: "utf8",
        timeout: 30000,
        windowsHide: true,
        maxBuffer: 4 * 1024 * 1024,
      }) || "").slice(0, 30000);
    }
  } catch {
    throw new Error("当前环境无法提取 PDF 文本；请上传 DOCX、PPTX、图片、Markdown 或纯文本文件");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

export async function extractSummaryTemplateSource({ buffer, fileName = "", mimeType = "" } = {}) {
  const data = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || "");
  if (!data.length) throw new Error("上传文件为空");
  const extension = path.extname(String(fileName || "")).toLowerCase();
  const normalizedMime = String(mimeType || "").toLowerCase();
  if (IMAGE_TEMPLATE_EXTENSIONS.has(extension) || normalizedMime.startsWith("image/")) {
    return { kind: "image", extension, mimeType: normalizedMime || "image/png", text: "" };
  }
  if (TEXT_TEMPLATE_EXTENSIONS.has(extension) || normalizedMime.startsWith("text/")) {
    const text = data.toString("utf8").replace(/\0/g, "").trim().slice(0, 30000);
    if (!text) throw new Error("上传文件未提取到可分析文本");
    return { kind: "text", extension, mimeType: normalizedMime || "text/plain", text };
  }
  if (OFFICE_TEMPLATE_EXTENSIONS.has(extension)) {
    const text = await extractOfficeTemplateText(data, extension);
    if (!text) throw new Error("Office 文件未提取到可分析文本");
    return { kind: "text", extension, mimeType: normalizedMime, text };
  }
  if (extension === ".pdf" || normalizedMime === "application/pdf") {
    const text = extractPdfTemplateText(data).trim();
    if (!text) throw new Error("PDF 未提取到可分析文本");
    return { kind: "text", extension: ".pdf", mimeType: "application/pdf", text };
  }
  throw new Error("暂不支持该文件格式；支持图片、PDF、DOCX、PPTX、XLSX、Markdown 和纯文本");
}

export function sanitizeAnalyzedSummaryTemplate(value) {
  return String(value || "")
    .replace(/^```(?:markdown|md|text)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .replace(/^(?:模板内容|工作总结模板)\s*[:：]\s*/i, "")
    .trim()
    .slice(0, 8000);
}

function analyzeImageTemplateWithClaude(imagePath, prompt, model = IMAGE_TEMPLATE_ANALYSIS_MODEL) {
  return new Promise((resolve, reject) => {
    const claudeArgs = [
      "-p",
      "--model",
      model,
      "--output-format",
      "text",
      "--allowedTools=Read",
      "--",
      prompt,
    ];
    const windowsBinary = process.platform === "win32"
      ? path.join(String(process.env.APPDATA || ""), "npm", "node_modules", "@anthropic-ai", "claude-code", "bin", "claude.exe")
      : "";
    // npm 的 claude.ps1 在 execFile 的开放 stdin 管道下会把调用误判成管道输入并永久等待；
    // Windows 直接执行 Claude 二进制，避免模板图片分析卡满超时时间。
    const command = windowsBinary && fs.existsSync(windowsBinary) ? windowsBinary : "claude";
    const args = claudeArgs;
    execFile(command, args, {
      cwd: path.dirname(imagePath),
      timeout: 180000,
      windowsHide: true,
      maxBuffer: 4 * 1024 * 1024,
    }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(`Claude 图片模板分析失败：${String(stderr || error.message).trim().slice(0, 500)}`));
        return;
      }
      const text = String(stdout || "").trim();
      if (!text) {
        reject(new Error("Claude 图片模板分析未返回内容"));
        return;
      }
      resolve(text);
    });
  });
}

export function normalizeReportPeriod(value) {
  const period = String(value || "").trim().toLowerCase();
  return REPORT_PERIODS.has(period) ? period : "";
}

// 报告元信息：周期 → 时间范围 + 英文目录词 + 文件名前缀 + 是否绩效
// custom 周期由调用方传入 since/until（ISO 日期 yyyy-MM-dd），用于自定义起止日期的工作总结。
export function reportMeta(period, since, until) {
  const ref = new Date();
  if (period === "week") {
    const day = ref.getDay() || 7;
    const mon = new Date(ref); mon.setDate(ref.getDate() - day + 1); mon.setHours(0, 0, 0, 0);
    const fri = new Date(mon); fri.setDate(mon.getDate() + 4);
    const sun = new Date(mon); sun.setDate(mon.getDate() + 6);
    return { word: "weekly", since: iso(mon), until: iso(sun), label: "工作周报", fileBase: `${ymd(mon)}-${ymd(fri)}工作周报`, isPerf: false };
  }
  if (period === "month") {
    const first = new Date(ref.getFullYear(), ref.getMonth(), 1);
    const last = new Date(ref.getFullYear(), ref.getMonth() + 1, 0);
    return { word: "monthly", since: iso(first), until: iso(last), label: "工作月报", fileBase: `${ymd(first)}-${ymd(last)}工作月报`, isPerf: false };
  }
  if (period === "quarter") {
    const q = Math.floor(ref.getMonth() / 3);
    const first = new Date(ref.getFullYear(), q * 3, 1);
    const last = new Date(ref.getFullYear(), q * 3 + 3, 0);
    return { word: "quarterly", since: iso(first), until: iso(last), label: `${ref.getFullYear()}年Q${q + 1}季度绩效总结`, fileBase: `${ymd(first)}-${ymd(last)}季度绩效总结`, isPerf: true };
  }
  if (period === "year") {
    const first = new Date(ref.getFullYear(), 0, 1);
    const last = new Date(ref.getFullYear(), 11, 31);
    return { word: "annual", since: iso(first), until: iso(last), label: `${ref.getFullYear()}年度绩效总结`, fileBase: `${ymd(first)}-${ymd(last)}年度绩效总结`, isPerf: true };
  }
  if (period === "custom") {
    const s = String(since || "").trim();
    const u = String(until || "").trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || !/^\d{4}-\d{2}-\d{2}$/.test(u)) {
      throw new Error("自定义周期需要有效的起止日期(yyyy-MM-dd)");
    }
    const sd = new Date(`${s}T00:00:00`), ud = new Date(`${u}T00:00:00`);
    if (isNaN(sd.getTime()) || isNaN(ud.getTime()) || sd > ud) {
      throw new Error("自定义周期起止日期无效或起大于止");
    }
    return { word: "custom", since: s, until: u, label: `${s}~${u}工作总结`, fileBase: `${s.replace(/-/g, "")}-${u.replace(/-/g, "")}工作总结`, isPerf: false };
  }
  throw new Error("不支持的周期: " + period);
}

export function gitUser() {
  const get = (k) => { try { return execSync(`git config ${k}`, { encoding: "utf8", timeout: 5000, windowsHide: true }).trim(); } catch { return ""; } };
  return { name: get("user.name") || "user", email: get("user.email") || "" };
}

// 采集 devbench 对话（各故事点 ts 在范围内的消息）
function collectChat(since, until) {
  const s = new Date(`${since}T00:00:00`).getTime();
  const u = new Date(`${until}T23:59:59`).getTime();
  const out = [];
  for (const tab of store.listTabs()) {
    const msgs = (store.getMessages(tab.id) || []).filter((m) => m.ts >= s && m.ts <= u);
    if (msgs.length) out.push({ title: tab.title, ticketUrl: tab.ticketUrl || "", messages: msgs });
  }
  return out;
}

// 采集平台 Chat 页中的全引擎会话。与 devbench 故事点消息一起进入同一全局预算，
// 从而覆盖通过网关使用的 Gemini/DeepSeek/Qwen/Kimi 等引擎，而不只看本地 CLI。
function collectPlatformChat(since, until) {
  try {
    const messages = getChatMessagesInRange(since, until).map((message) => ({
      role: message.role,
      content: message.content,
      engine: message.engine || "",
      ts: new Date(message.created_at).getTime(),
    }));
    return messages.length ? [{ title: "平台 Chat 全引擎会话", messages }] : [];
  } catch (error) {
    log("system", "warn", "devbench-report", `平台 Chat 会话采集失败：${error.message}`);
    return [];
  }
}

/**
 * 备份 Claude Code CLI 会话到 D:\backup\claude\projects（增量、只增不删：源里被清理的历史在备份中保留）。
 * 返回 { ok, dir, copied, skipped, total }。
 */
export function backupClaudeSessions() {
  if (!fs.existsSync(CLAUDE_PROJECTS)) return { ok: false, error: "未找到 Claude 会话目录: " + CLAUDE_PROJECTS };
  let copied = 0, skipped = 0, total = 0;
  fs.mkdirSync(CLAUDE_BACKUP_PROJECTS, { recursive: true });
  let projDirs = [];
  try { projDirs = fs.readdirSync(CLAUDE_PROJECTS); } catch (e) { return { ok: false, error: e.message }; }
  for (const proj of projDirs) {
    const srcDir = path.join(CLAUDE_PROJECTS, proj);
    let files = [];
    try { files = fs.readdirSync(srcDir).filter((f) => f.endsWith(".jsonl")); } catch { continue; }
    if (!files.length) continue;
    const dstDir = path.join(CLAUDE_BACKUP_PROJECTS, proj);
    fs.mkdirSync(dstDir, { recursive: true });
    for (const f of files) {
      total++;
      const src = path.join(srcDir, f);
      const dst = path.join(dstDir, f);
      try {
        let need = true;
        if (fs.existsSync(dst)) {
          const ss = fs.statSync(src), ds = fs.statSync(dst);
          need = ss.mtimeMs > ds.mtimeMs || ss.size !== ds.size; // 源更新或大小不同才覆盖
        }
        if (need) { fs.copyFileSync(src, dst); copied++; } else skipped++;
      } catch { /* 单文件失败跳过 */ }
    }
  }
  return { ok: true, dir: CLAUDE_BACKUP_DIR, copied, skipped, total };
}

// 中文证据的真实 token/字符比明显高于英文。18k 字符仍覆盖各仓库/引擎的
// 代表性证据，同时把单轮输入稳定控制在适合快速总结的范围。
const DATA_CONTEXT_BUDGET = 18000;

function engineLabel(engine) {
  return ({
    claude: "Claude Code CLI",
    codex: "Codex CLI",
    gemini: "Gemini CLI",
    cursor: "Cursor",
  }[engine] || engine || "AI");
}

function sampleAcrossTimeline(items, limit) {
  const list = Array.isArray(items) ? items : [];
  if (list.length <= limit) return list;
  const selected = [];
  for (let index = 0; index < limit; index += 1) {
    selected.push(list[Math.round(index * (list.length - 1) / Math.max(1, limit - 1))]);
  }
  return selected;
}

function uniqueConversationItems(items) {
  const seen = new Set();
  return (Array.isArray(items) ? items : []).filter((item) => {
    const text = String(item?.text ?? item ?? "").replace(/\s+/g, " ").trim();
    if (!text || seen.has(text)) return false;
    seen.add(text);
    return true;
  });
}

// 构建传给 AI 的紧凑证据。总预算覆盖 Git、CLI 和 devbench，避免只限制其中一段后整体仍失控。
export function buildDataContext(gitData, chatData, cliData, maxChars = DATA_CONTEXT_BUDGET) {
  const lines = [];
  let used = 0;
  let gitTruncated = false;
  let aiTruncated = false;
  let chatTruncated = false;
  const gitCeiling = Math.floor(maxChars * 0.35);
  const aiCeiling = Math.floor(maxChars * 0.85);
  const append = (value, ceiling = maxChars) => {
    const line = String(value || "");
    const extra = line.length + (lines.length ? 1 : 0);
    if (used + extra > ceiling) return false;
    lines.push(line);
    used += extra;
    return true;
  };

  const gitCommitCount = gitData.reduce((sum, repo) => sum + (repo.commits?.length || 0), 0);
  const gitFileCount = gitData.reduce((sum, repo) => sum + (repo.total?.files || 0), 0);
  const cliSessionCount = (cliData || []).reduce((sum, group) => sum + (group.sessionCount || 0), 0);
  const cliMessageCount = (cliData || []).reduce(
    (sum, group) => sum + (group.prompts?.length || 0) + (group.assistants?.length || 0),
    0,
  );
  append("## 精确汇总指标");
  append(`- Git：${gitData.length} 个有提交的仓库，${gitCommitCount} 次提交，${gitFileCount} 个文件变更记录`);
  append(`- AI CLI：${cliData?.length || 0} 个引擎/工程组，${cliSessionCount} 个会话，${cliMessageCount} 条用户/助手消息`);
  append(`- devbench/平台会话：${chatData?.length || 0} 个故事点或全引擎会话组`);
  append("（以上数字为程序计算结果，报告中如引用必须原样使用，不得自行重新估算。）");

  append("\n## Git 提交证据", gitCeiling);
  if (!gitData.length) append("（选定时间段无 Git 提交）", gitCeiling);
  for (const repo of gitData) {
    if (!append(`- 工程 ${repo.name}：${repo.commits.length} 次提交，${repo.total?.files || 0} 个文件，+${repo.total?.insertions || 0} -${repo.total?.deletions || 0}`, gitCeiling)) {
      gitTruncated = true;
      break;
    }
  }
  // 各仓库轮询加入提交，避免第一个大仓库吞掉全部上下文。
  const gitSamples = gitData.map((repo) => sampleAcrossTimeline(repo.commits, 20));
  for (let commitIndex = 0; commitIndex < 20; commitIndex += 1) {
    for (let repoIndex = 0; repoIndex < gitData.length; repoIndex += 1) {
      const commit = gitSamples[repoIndex]?.[commitIndex];
      if (!commit) continue;
      if (!append(`  · [${gitData[repoIndex].name}] ${commit.date} ${commit.hash} ${String(commit.message || "").slice(0, 180)}`, gitCeiling)) {
        gitTruncated = true;
        break;
      }
    }
    if (gitTruncated) break;
  }

  append("\n## AI CLI 会话证据", aiCeiling);
  if (!cliData?.length) append("（选定时间段无 Claude/Codex CLI 会话）", aiCeiling);
  const conversationGroups = (cliData || []).map((group) => ({
    ...group,
    totalPrompts: group.prompts?.length || 0,
    prompts: sampleAcrossTimeline(uniqueConversationItems(group.prompts), 12),
    assistants: sampleAcrossTimeline(uniqueConversationItems(group.assistants), 2),
  }));
  for (const group of conversationGroups) {
    const project = String(group.project || "").split(/[\\/]/).filter(Boolean).pop() || group.project || "unknown";
    if (!append(`- ${engineLabel(group.engine)} / ${project}：${group.sessionCount || 0} 个会话，抽样 ${group.prompts?.length || 0}/${group.totalPrompts} 条指令`, aiCeiling)) {
      aiTruncated = true;
      break;
    }
  }
  // 先给每个引擎/工程一条，再按轮次补充，保证广度。
  for (let promptIndex = 0; promptIndex < 12; promptIndex += 1) {
    for (const group of conversationGroups) {
      const prompt = group.prompts?.[promptIndex];
      if (!prompt) continue;
      const project = String(group.project || "").split(/[\\/]/).filter(Boolean).pop() || group.project || "unknown";
      const text = String(prompt?.text ?? prompt).replace(/\s+/g, " ").slice(0, 360);
      if (!append(`  · 【${engineLabel(group.engine)} / ${project} / 我的指令】${text}`, aiCeiling)) {
        aiTruncated = true;
        break;
      }
    }
    if (aiTruncated) break;
  }
  if (!aiTruncated) {
    for (const group of conversationGroups) {
      const project = String(group.project || "").split(/[\\/]/).filter(Boolean).pop() || group.project || "unknown";
      for (const answer of group.assistants || []) {
        const text = String(answer?.text ?? answer).replace(/\s+/g, " ").slice(0, 220);
        if (!append(`  · 【${engineLabel(group.engine)} / ${project} / AI结果】${text}`, aiCeiling)) {
          aiTruncated = true;
          break;
        }
      }
      if (aiTruncated) break;
    }
  }

  append("\n## devbench 故事点会话证据");
  if (!chatData?.length) append("（选定时间段无 devbench 故事点会话）");
  const stories = (chatData || []).map((story) => ({
    ...story,
    samples: sampleAcrossTimeline(story.messages || [], 8),
  }));
  for (const story of stories) {
    if (!append(`- 故事点 ${story.title}：${story.messages?.length || 0} 条消息`)) {
      chatTruncated = true;
      break;
    }
  }
  for (let messageIndex = 0; messageIndex < 8; messageIndex += 1) {
    for (const story of stories) {
      const message = story.samples?.[messageIndex];
      if (!message) continue;
      const who = message.role === "user" ? "我" : `AI(${message.engine || "?"})`;
      const text = String(message.content || "").replace(/\s+/g, " ").slice(0, 260);
      if (text && !append(`  · 【${story.title} / ${who}】${text}`)) {
        chatTruncated = true;
        break;
      }
    }
    if (chatTruncated) break;
  }
  const truncated = gitTruncated || aiTruncated || chatTruncated;
  if (truncated && used + 70 <= maxChars) {
    append("（证据已按工程、引擎和时间均匀抽样；完整原始会话仍保留在本机索引源中。）");
  }
  return {
    text: lines.join("\n"),
    stats: {
      chars: used,
      maxChars,
      truncated,
      gitRepositories: gitData.length,
      aiGroups: cliData?.length || 0,
      devbenchStories: chatData?.length || 0,
    },
  };
}

export function buildPrompt(meta, dataCtx, template, { mode = "concise", templateName = "周报" } = {}) {
  const outputMode = mode === "report" ? "report" : "concise";
  const selectedTemplate = String(template || "").trim() || DEFAULT_WEEKLY_TEMPLATE;
  const base = `## 任务：生成${meta.label}

时间范围：${meta.since} ~ ${meta.until}

请严格根据以下 Git 提交和 AI 会话证据，总结这段时间我的实际工作。不得编造未出现的内容。

${dataCtx}
`;
  const templatePart = `\n## 选定模板：${String(templateName || "周报").trim() || "周报"}\n请严格按以下字段及顺序组织；允许增加三级标题，不得遗漏已有字段：\n${selectedTemplate}\n`;
  if (outputMode === "report") {
    return `${base}${templatePart}
## 输出要求
- 这是“报告版”，允许更长时间推理；只输出一份完整 Markdown 报告。
- 正文控制在 1800~4200 个中文字符，优先完整、可核验和适合汇报，不为追求篇幅重复内容。
- 使用清晰标题、状态图标（✅ 📊 🧩 ⚠️ 📅）、表格和重点标记，形成图文并茂的视觉层次。
- “图片”仅嵌入证据中真实存在且可引用的图片 Markdown 链接；没有则写“本期未发现可引用图片”，不得虚构。
- “附件”按 📎附件、🎬视频、🎧音频分类列出证据中的真实路径或链接；没有则明确写“本期未发现可引用附件”。
- Git 工程数据必须使用表格；工作成果按主题归类并给出证据线索、结果和影响。
- 具体写出证据中出现的模块名、机型/flavor、参数、版本、问题和修复；合并重复会话，不按聊天流水账罗列。
- Git 统计只能来自 Git 证据；会话中的计划或建议不能写成已完成成果。
- 计划、协调事项只能来自证据；无明确内容时如实写“无明确记录”。
- 中文、专业、完整，不得编造。只输出报告正文。`;
  }
  return `${base}${templatePart}
## 输出要求
- 这是“简洁版”，目标是快速生成；只输出一份精炼 Markdown，系统会在本地派生纯文本。
- 正文控制在 450~900 个中文字符，每个模板字段最多 4 条，合并重复内容。
- 优先写可核验成果、明确计划和阻塞；不展开背景，不写聊天流水账。
- “图片”和“附件”只列证据中真实存在的路径或链接；没有就写“无”。
- Git 统计只能来自 Git 证据；会话中的计划或建议不能写成已完成成果。
- 中文、专业、直接，不得编造。只输出报告正文。`;
}

export function markdownToPlainText(markdown) {
  return String(markdown || "")
    .replace(/```[\w-]*\r?\n?/g, "")
    .replace(/```/g, "")
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^\s*[-*+]\s+/gm, "- ")
    .replace(/^\s*>\s?/gm, "")
    .replace(/[*_~`]/g, "")
    .replace(/^\s*\|?(.*?)\|?\s*$/gm, (line) => line.includes("|")
      ? line.split("|").map((cell) => cell.trim()).filter(Boolean).join("  ")
      : line)
    .replace(/^\s*:?-{3,}:?(?:\s{2,}:?-{3,}:?)*\s*$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// 解析工作总结将使用的 AI 引擎 + 回答级快照（模型/档位）。供「生成前预览」与实际生成共用，
// 保证预览展示的和真正跑的 AI 一致。返回 { engine, aiSnapshot, useProxy }。
export function selectSummaryTextEngine(engine, config = {}) {
  if (["claude-atlas", "codex-atlas", "hermes-atlas"].includes(engine)) {
    const atlas = config.apiEngines?.atlas;
    if (atlas?.enabled && String(atlas.apiKey || "").trim()) return "atlas";
  }
  if (engine === "claude-volcengine") {
    const volcengine = config.apiEngines?.volcengine;
    if (volcengine?.enabled && String(volcengine.apiKey || "").trim()) return "volcengine";
  }
  return engine;
}

export function resolveSummaryAi({ engine: engineOverride = "", model = "", tier = "" } = {}) {
  const config = getConfig();
  const useProxy = !!(config.claudeProxyClient?.enabled && config.claudeProxyClient?.host);
  if (useProxy && !String(engineOverride || "").trim()) {
    const engine = "claude-proxy";
    return {
      engine,
      useProxy: true,
      overridesSupported: false,
      aiSnapshot: { engine, model: "", tier: "", capturedAt: Date.now() },
    };
  }
  // 与 runTask 内 dispatch 同口径：explicitEngine > defaultEngine > 任务类型推荐 > 兜底
  const probe = { type: "general", title: "工作总结", description: "" };
  const dispatchedEngine = String(engineOverride || "").trim() || dispatch(probe).engine;
  // claude-volcengine 与 API 引擎 volcengine 使用同一套方舟配置。纯文本总结直接走
  // chat/completions，避免启动具备工具能力的 Claude Agent CLI。
  const engine = selectSummaryTextEngine(dispatchedEngine, config);
  return {
    engine,
    sourceEngine: dispatchedEngine,
    useProxy: false,
    overridesSupported: true,
    transport: isApiEngine(engine) ? "text-api" : "agent",
    aiSnapshot: getAiModelSnapshot({
      engine,
      config,
      modelOverride: String(model || "").trim(),
      tierOverride: String(tier || "").trim(),
      capturedAt: Date.now(),
    }),
  };
}

// 调 AI 生成一份 Markdown；简洁版、报告版和上传文件模板分析共用同一套模型/档位覆盖。
// sessionId 用作 task.sourceId，让流式片段能按工作总结会话推回前端。
async function aiGenerate(meta, prompt, sessionId, {
  mode = "concise",
  engine: engineOverride = "",
  model = "",
  tier = "",
  imagePath = "",
  userContent = null,
} = {}) {
  const taskId = randomUUID();
  const modeLabel = mode === "report" ? "报告版" : mode === "template" ? "模板" : "简洁版";
  const task = {
    id: taskId, title: mode === "template" ? "分析工作总结模板" : `生成${meta.label}${modeLabel}`,
    description: prompt,
    type: "general", status: "pending", priority: 2,
    source: mode === "template" ? "devbench-report-template" : "devbench-report",
    sourceId: sessionId || null,
  };
  // 解析将使用的引擎 + 回答级快照（模型/档位），随流式片段下发，供前端在生成过程中展示。
  const { engine, aiSnapshot } = resolveSummaryAi({ engine: engineOverride, model, tier });
  task.explicitEngine = engine; // 锁定同一引擎，避免 runTask 内再次分派产生分歧
  task.allowEngineFallback = false;
  task.aiSnapshot = aiSnapshot;
  task.aiModel = aiSnapshot.model || "";
  task.aiTier = aiSnapshot.tier || "";
  task.firstOutputTimeoutMs = mode === "report" ? 75000 : 45000;
  task.idleTimeoutMs = mode === "report" ? 180000 : mode === "template" ? 120000 : 60000;
  task.maxTimeoutMs = mode === "report" ? 300000 : mode === "template" ? 180000 : 90000;
  if (imagePath) {
    task.imagePaths = [imagePath];
    task.cwd = path.dirname(imagePath);
  }
  createTask(task);

  if (isApiEngine(engine)) {
    broadcastTaskDispatched({
      taskId,
      type: task.type,
      engine,
      skill: null,
      sessionId: task.sourceId,
      aiSnapshot,
    });
    updateTask(taskId, { status: "running", assignedEngine: engine });
    broadcastTaskUpdate({ ...task, status: "running", assignedEngine: engine });
    let telemetryPersisted = false;
    try {
      const system = mode === "template"
        ? "你是工作总结模板分析助手。只提取模板结构与字段，输出可直接复用的中文纯文本模板；不要填写实际工作内容，不要调用工具。"
        : mode === "report"
          ? "你是工作总结报告助手。只依据用户证据，生成完整、可核验、视觉层次清晰的中文 Markdown 报告；不得编造，不要调用工具。"
          : "你是高效工作总结助手。只依据用户证据，快速生成简洁、可核验的中文 Markdown；不得编造，不要调用工具。";
      const result = await callApiEngineText(engine, prompt, {
        system,
        model: aiSnapshot.model,
        tier: aiSnapshot.tier,
        userContent,
        maxOutputTokens: mode === "report" ? 10000 : mode === "template" ? 2400 : 2200,
        firstChunkTimeoutMs: mode === "report" ? 75000 : 45000,
        totalTimeoutMs: mode === "report" ? 300000 : mode === "template" ? 180000 : 90000,
        telemetryContext: {
          attemptId: taskId,
          workflowKind: mode === "template" ? "report_template" : "report",
          stage: mode === "report" ? "REPORT_EXPERT" : mode === "template" ? "REPORT_TEMPLATE" : "REPORT_SHORT",
        },
        onChunk: (chunk, deltaType) => broadcastChatStream({
          taskId,
          sessionId: task.sourceId,
          chunk,
          deltaType,
          engine,
          aiSnapshot,
        }),
      });
      const rich = String(result.text || "").trim();
      const usage = result.usage || null;
      const telemetry = result.telemetry || null;
      try {
        addTokenUsage(
          taskId,
          engine,
          telemetry?.usage?.source === "provider" ? telemetry.usage.inputTokens : 0,
          telemetry?.usage?.source === "provider" ? telemetry.usage.outputTokens : 0,
          telemetry || { usage: { source: "unavailable" }, executionSucceeded: true },
        );
        telemetryPersisted = true;
      } catch (telemetryError) {
        log(taskId, "warn", "agent-telemetry", `工作总结遥测落库失败: ${telemetryError.message}`);
      }
      updateTask(taskId, {
        status: "completed",
        result: JSON.stringify({ output: rich, report: rich, usage, telemetry }),
        report: rich,
      });
      broadcastTaskUpdate({ ...task, status: "completed", assignedEngine: engine });
      broadcastChatStreamEnd({
        taskId,
        sessionId: task.sourceId,
        engine,
        success: true,
        usage,
        aiSnapshot,
      });
      return { text: markdownToPlainText(rich), rich, engine, usage, telemetry, aiSnapshot };
    } catch (error) {
      if (!telemetryPersisted && error?.telemetry) {
        try {
          const observed = error.telemetry.usage?.source === "provider" ? error.telemetry.usage : null;
          addTokenUsage(
            taskId,
            engine,
            observed?.inputTokens || 0,
            observed?.outputTokens || 0,
            error.telemetry,
          );
          telemetryPersisted = true;
        } catch (telemetryError) {
          log(taskId, "warn", "agent-telemetry", `失败工作总结遥测落库失败: ${telemetryError.message}`);
        }
      }
      updateTask(taskId, {
        status: "failed",
        result: JSON.stringify({ error: error.message, usage: error?.usage || null, telemetry: error?.telemetry || null }),
      });
      broadcastTaskUpdate({ ...task, status: "failed", assignedEngine: engine });
      broadcastChatStreamEnd({
        taskId,
        sessionId: task.sourceId,
        engine,
        success: false,
        usage: error?.usage || null,
        aiSnapshot,
      });
      throw error;
    }
  }

  const result = await runTask(task);
  const rich = String(result.output || result.report || "").trim();
  return { text: markdownToPlainText(rich), rich, engine, usage: result.usage || null, aiSnapshot };
}

export async function analyzeSummaryTemplateFile({
  buffer,
  fileName = "template",
  mimeType = "",
  model = "",
  tier = "",
} = {}) {
  const data = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || "");
  const source = await extractSummaryTemplateSource({ buffer: data, fileName, mimeType });
  const baseName = path.basename(String(fileName || "template"), path.extname(String(fileName || "")))
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_")
    .trim()
    .slice(0, 60) || "自定义";
  const instructions = [
    "分析上传文件中的工作总结/汇报结构，生成一份可复用模板。",
    "要求：",
    "1. 只保留字段名、章节名、填写提示和必要顺序，不填写任何具体工作内容。",
    "2. 输出纯文本，每个一级字段单独一行；必要时可用缩进或 Markdown 二级标题。",
    "3. 保留文件中体现的图片、视频、音频、附件等媒体字段。",
    "4. 不解释分析过程，不使用代码围栏，模板总长度不超过 3000 个中文字符。",
  ].join("\n");
  const selectedAi = resolveSummaryAi({ model, tier });

  let tempDir = "";
  try {
    let imagePath = "";
    let userContent = null;
    let prompt = instructions;
    if (source.kind === "image") {
      tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "aieff-summary-template-image-"));
      const extension = IMAGE_TEMPLATE_EXTENSIONS.has(source.extension) ? source.extension : ".png";
      imagePath = path.join(tempDir, `template${extension}`);
      fs.writeFileSync(imagePath, data);
      prompt = `${instructions}\n\n请使用 Read 工具查看图片文件 ${imagePath} 并直接输出模板结构。`;
    } else {
      prompt = `${instructions}\n\n## 文件内容\n${source.text}`;
    }
    let generated;
    if (source.kind === "image") {
      // Coding Plan 文本模型通常拒绝 image_url；图片走已登录 Claude 的 Read 图像能力。
      // 固定轻量视觉模型，避免默认大模型拖慢结构识别；正式总结仍使用用户所选模型与档位。
      // 使用专用只读调用并把短提示词作为命令参数，避开 Windows CLI supervisor 的 stdin 转发。
      const ai = resolveSummaryAi({ engine: "claude", model: IMAGE_TEMPLATE_ANALYSIS_MODEL });
      const rich = await analyzeImageTemplateWithClaude(imagePath, prompt, IMAGE_TEMPLATE_ANALYSIS_MODEL);
      generated = {
        rich,
        text: markdownToPlainText(rich),
        engine: "claude",
        aiSnapshot: ai.aiSnapshot,
        usage: null,
      };
    } else {
      generated = await aiGenerate(null, prompt, "", {
        mode: "template",
        model,
        tier,
        imagePath,
        userContent,
      });
    }
    const template = sanitizeAnalyzedSummaryTemplate(generated.rich || generated.text);
    if (!template) throw new Error("AI 未返回可用模板");
    return {
      ok: true,
      name: `${baseName}模板`,
      template,
      sourceFile: path.basename(String(fileName || "template")),
      sourceKind: source.kind,
      engine: generated.engine,
      aiSnapshot: generated.aiSnapshot || null,
      fallbackFromEngine: source.kind === "image" && selectedAi.engine !== "claude" ? selectedAi.engine : "",
    };
  } finally {
    if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

// Markdown → docx（python-docx）。Markdown 已由快速路径落盘，这里只做可选导出。
function richToDocx(richMd, docxPath, mdPath) {
  const py = path.join(__dirname, "md_to_docx.py");
  if (!fs.existsSync(mdPath)) fs.writeFileSync(mdPath, richMd, "utf-8");
  try {
    execFileSync("python", [py, mdPath, docxPath], { timeout: 60000, windowsHide: true });
    return { ok: true, path: docxPath };
  } catch (e) {
    log("system", "warn", "devbench-report", `docx 生成失败，已保留 Markdown：${e.message}`);
    return { ok: false, path: null, error: e.message };
  }
}

/**
 * 生成总结报告。Git/会话证据只采集一次，随后按 outputModes 生成：
 * - concise：快速、短上下文、短输出；
 * - report：更长上下文、更多输出预算、富媒体 Markdown，可选 Word/PDF。
 */
export async function generateSummary({
  period,
  tabId,
  template,
  templateName,
  projectPath,
  since,
  until,
  sessionId,
  outputModes,
  model,
  tier,
  includeRichExports = false,
} = {}) {
  const startedAt = Date.now();
  const meta = reportMeta(period, since, until);
  const modes = normalizeSummaryOutputModes(outputModes);
  if (!modes.concise && !modes.report) {
    return { ok: false, error: "请至少选择简洁版或报告版" };
  }
  const selectedTemplate = String(template || "").trim().slice(0, 8000) || DEFAULT_WEEKLY_TEMPLATE;
  const selectedTemplateName = String(templateName || "").trim().slice(0, 80) || "周报";
  // 输出工程路径：优先用显式传入的路径（前端取自「在此开发」悬浮窗配置 / 用户在工作总结面板里填的路径），
  // 不再隐式绑定当前打开故事点的主工程；仅当未显式提供时，才回退到故事点主工程作兜底。
  const overridePath = String(projectPath || "").trim().replace(/[\\/]+$/, "");
  let projPath, projName;
  if (overridePath) {
    if (!fs.existsSync(overridePath)) {
      return { ok: false, error: `配置的工程路径不存在：${overridePath}` };
    }
    projPath = overridePath;
    projName = path.basename(overridePath) || overridePath;
  } else {
    const tab = tabId ? store.getTab(tabId) : null;
    const project = tab ? store.getPrimaryProject(tab) : null;
    if (!project || !project.path || !fs.existsSync(project.path)) {
      return { ok: false, error: "请在工作总结面板填写「输出工程路径」（默认取「在此开发」悬浮窗配置的工程路径），或打开一个已配置主工程的故事点" };
    }
    projPath = project.path;
    projName = project.name;
  }
  const user = gitUser();

  // 数据源并行启动：AI 会话走增量索引，Git 仓库定义解析与会话采集不互相等待。
  const collectionStartedAt = Date.now();
  const cliPromise = collectAiSessions({ since: meta.since, until: meta.until });
  const repositoriesPromise = getAuthoritativeWorkReportRepositories(store, getConfig());
  const chatData = [...collectChat(meta.since, meta.until), ...collectPlatformChat(meta.since, meta.until)];
  const [cli, repos] = await Promise.all([cliPromise, repositoriesPromise]);
  const gitData = (await collectGitDataAsync(repos, meta.since, meta.until, { author: user.name, concurrency: 4 }))
    .filter((repo) => repo.commits.length > 0);
  const collectionMs = Date.now() - collectionStartedAt;

  const aiStartedAt = Date.now();
  const generated = {};
  const prompts = {};
  const contexts = {};
  const aiTimings = {};
  const warnings = [];
  for (const mode of ["concise", "report"]) {
    if (!modes[mode]) continue;
    const variantStartedAt = Date.now();
    const maxChars = mode === "report" ? 30000 : 9000;
    const context = buildDataContext(gitData, chatData, cli.byProject, maxChars);
    const prompt = buildPrompt(meta, context.text, selectedTemplate, {
      mode,
      templateName: selectedTemplateName,
    });
    contexts[mode] = context;
    prompts[mode] = prompt;
    try {
      const gen = await aiGenerate(meta, prompt, sessionId, { mode, model, tier });
      if (!gen.text && !gen.rich) throw new Error("AI 未返回报告内容");
      generated[mode] = gen;
    } catch (error) {
      warnings.push(`${mode === "report" ? "报告版" : "简洁版"}生成失败：${error.message}`);
    }
    aiTimings[mode] = Date.now() - variantStartedAt;
  }
  if (!generated.concise && !generated.report) {
    return { ok: false, error: warnings.join("；") || "AI 未返回报告内容" };
  }
  const aiMs = Date.now() - aiStartedAt;

  // 输出目录：<工程路径>/docs/<word>/<git用户名>/
  const relDir = `docs/${meta.word}/${user.name}`;
  const dir = path.join(projPath, relDir);
  fs.mkdirSync(dir, { recursive: true });
  const outputs = [];
  let conciseTxtPath = null;
  let conciseMdPath = null;
  let reportMdPath = null;
  if (generated.concise) {
    conciseTxtPath = path.join(dir, `${meta.fileBase}_简洁版.txt`);
    conciseMdPath = path.join(dir, `${meta.fileBase}_简洁版.md`);
    fs.writeFileSync(conciseTxtPath, generated.concise.text || generated.concise.rich, "utf-8");
    fs.writeFileSync(conciseMdPath, generated.concise.rich || generated.concise.text, "utf-8");
    outputs.push(
      { key: "concise-txt", label: "简洁版", file: path.basename(conciseTxtPath), note: "纯文本" },
      { key: "concise-md", label: "简洁版", file: path.basename(conciseMdPath), note: "Markdown" },
    );
  }
  if (generated.report) {
    reportMdPath = path.join(dir, `${meta.fileBase}_报告版.md`);
    fs.writeFileSync(reportMdPath, generated.report.rich || generated.report.text, "utf-8");
    outputs.push({ key: "report-md", label: "报告版", file: path.basename(reportMdPath), note: "富媒体 Markdown" });
  }

  // Word/PDF 只从报告版派生；简洁版路径完全不等待本机渲染。
  const exportStartedAt = Date.now();
  let docxRes = { ok: false, path: null, error: null, skipped: true };
  const docxPath = path.join(dir, `${meta.fileBase}_报告版.docx`);
  const pdfPath = path.join(dir, `${meta.fileBase}_报告版.pdf`);
  let pdfRes = { ok: false, htmlPath: null, error: null, skipped: true };
  if (includeRichExports && generated.report) {
    docxRes = richToDocx(generated.report.rich || generated.report.text, docxPath, reportMdPath);
    if (docxRes.ok) {
      outputs.push({ key: "report-docx", label: "报告版", file: path.basename(docxRes.path), note: "Word" });
    } else if (docxRes.error) {
      warnings.push(`报告版 Word 导出失败：${docxRes.error}`);
    }
    try {
      const result = await markdownToPdf(generated.report.rich || generated.report.text, `${meta.label} · 报告版`, pdfPath);
      pdfRes = { ok: !!result.ok, htmlPath: result.htmlPath || null, error: null, skipped: false };
      if (pdfRes.ok) {
        outputs.push({ key: "report-pdf", label: "报告版", file: path.basename(pdfPath), note: "PDF" });
      }
    } catch (e) {
      pdfRes = { ok: false, htmlPath: null, error: e.message, skipped: false };
      warnings.push(`报告版 PDF 导出失败：${e.message}`);
      log("system", "warn", "devbench-report", `详细版 PDF 生成失败（已保留 txt/Markdown）：${e.message}`);
    }
  } else if (includeRichExports && !generated.report) {
    warnings.push("未生成报告版，已跳过 Word/PDF 导出");
  }
  const exportMs = Date.now() - exportStartedAt;
  const generatedModes = ["concise", "report"].filter((mode) => !!generated[mode]);
  const promptCharsByMode = Object.fromEntries(
    Object.entries(prompts).map(([mode, prompt]) => [mode, prompt.length]),
  );
  const primaryGen = generated.report || generated.concise;

  return {
    ok: true,
    complete: warnings.length === 0 && generatedModes.length === Object.values(modes).filter(Boolean).length,
    warnings,
    label: meta.label,
    dir: relDir,
    dirAbs: dir,
    project: projName,
    outputs,
    outputModes: modes,
    generatedModes,
    templateName: selectedTemplateName,
    txtFile: conciseTxtPath ? path.basename(conciseTxtPath) : null,
    mdFile: reportMdPath ? path.basename(reportMdPath) : (conciseMdPath ? path.basename(conciseMdPath) : null),
    conciseMdFile: conciseMdPath ? path.basename(conciseMdPath) : null,
    reportFile: reportMdPath ? path.basename(reportMdPath) : null,
    docxFile: docxRes.ok ? path.basename(docxRes.path) : null,
    docxOk: docxRes.ok,
    docxError: docxRes.error,
    pdfFile: pdfRes.ok ? path.basename(pdfPath) : null,
    pdfPath: pdfRes.ok ? pdfPath : null,
    pdfOk: pdfRes.ok,
    pdfError: pdfRes.error,
    htmlFile: pdfRes.htmlPath ? path.basename(pdfRes.htmlPath) : null,
    gitCommits: gitData.reduce((a, g) => a + g.commits.length, 0),
    cliProjects: cli.byProject.length,
    cliSessions: cli.stats.sessionCount,
    cliPrompts: cli.byProject.reduce((a, p) => a + p.prompts.length, 0),
    cliMessages: cli.stats.messageCount,
    aiEngineCounts: cli.stats.engineCounts,
    chatStories: chatData.length,
    promptChars: Object.values(promptCharsByMode).reduce((sum, value) => sum + value, 0),
    promptCharsByMode,
    promptEstimatedTokens: Math.ceil(Object.values(promptCharsByMode).reduce((sum, value) => sum + value, 0) / 4),
    summaryEngine: primaryGen?.engine || "",
    summaryUsage: primaryGen?.usage || null,
    summaryAi: generatedModes.map((mode) => ({
      mode,
      engine: generated[mode].engine || "",
      aiSnapshot: generated[mode].aiSnapshot || null,
      usage: generated[mode].usage || null,
    })),
    context: (contexts.report || contexts.concise)?.stats || null,
    contexts: Object.fromEntries(Object.entries(contexts).map(([mode, value]) => [mode, value.stats])),
    collection: cli.stats,
    timings: {
      collectionMs,
      aiMs,
      aiByMode: aiTimings,
      exportMs,
      totalMs: Date.now() - startedAt,
    },
    includeRichExports: !!(includeRichExports && generated.report),
    autoStaged: false,
    textPreview: (generated.concise?.text || generated.report?.text || "").slice(0, 600),
  };
}
