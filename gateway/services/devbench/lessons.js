/**
 * devbench 经验沉淀的"导出目标"：
 *   - 工程根 CLAUDE.md「已知问题与预防」托管块（Claude CLI 每次在该工程目录自动加载 → 等价永久记忆）
 *   - 工程 docs/wiki/<slug>.md（纳入 git，团队可见）
 *   - Bug Agent 记忆（best-effort；session_memory 为 7 天近期记忆，永久库以 devbench 经验库 + CLAUDE.md 为准）
 *
 * devbench 自有"经验库"在 store.js（addLesson/getLessons），并由 index.js 每轮自动注入 prompt。
 */
import fs from "fs";
import path from "path";
import { log } from "../logger.js";
import { appendSessionMemory } from "../bug-agent/memory/session-memory.js";

const CLAUDE_BLOCK_START = "<!-- DEVBENCH_LESSONS_START -->";
const CLAUDE_BLOCK_END = "<!-- DEVBENCH_LESSONS_END -->";

function ts() { return new Date().toLocaleString("zh-CN"); }

// 把一组经验渲染成 markdown 列表
function renderLessonsMd(lessons) {
  const L = [];
  for (const x of lessons || []) {
    const head = [x.carbId || x.tbId, x.title].filter(Boolean).join(" ");
    L.push(`- **${head || "问题"}**（${x.kind === "reject" ? "非本侧问题" : "已修复"}）`);
    if (x.cause) L.push(`  - 原因：${x.cause}`);
    if (x.prevention) L.push(`  - 预防：${x.prevention}`);
  }
  return L.join("\n");
}

/**
 * 把该工程相关经验写入工程根 CLAUDE.md 的「已知问题与预防」托管块（幂等：整块重写，不动用户其它内容）。
 * lessons = 要写入的全量列表（调用方决定，通常是该 TB 项目的全部经验）。
 */
export function writeLessonsToClaudeMd(projectPath, lessons) {
  if (!projectPath) return { ok: false, error: "无工程路径" };
  const file = path.join(projectPath, "CLAUDE.md");
  const block = `${CLAUDE_BLOCK_START}\n## 已知问题与预防（AI 维护，请勿手改本块）\n> 由 devbench 工作流在 TB 单完成后自动维护，供后续开发避免同类问题。最近更新：${ts()}\n\n${renderLessonsMd(lessons) || "(暂无)"}\n${CLAUDE_BLOCK_END}`;
  let cur = "";
  try { if (fs.existsSync(file)) cur = fs.readFileSync(file, "utf-8"); } catch {}
  const re = new RegExp(`${CLAUDE_BLOCK_START}[\\s\\S]*?${CLAUDE_BLOCK_END}`);
  const next = re.test(cur)
    ? cur.replace(re, block)
    : (cur.trimEnd() + (cur.trim() ? "\n\n" : "") + block + "\n");
  try { fs.writeFileSync(file, next, "utf-8"); return { ok: true, file, count: (lessons || []).length }; }
  catch (e) { return { ok: false, error: e.message }; }
}

/**
 * 生成/更新工程 docs/wiki/<slug>.md（纳入 git），返回 { ok, rel, fileName }。
 * info: { title, ticketUrl, tbId, kind, detailReport, lesson:{cause,prevention} }
 */
export function writeWiki(projectPath, slug, info = {}) {
  if (!projectPath) return { ok: false, error: "无工程路径" };
  const relDir = "docs/wiki";
  const absDir = path.join(projectPath, relDir);
  const fileName = `${slug}.md`;
  const L = [];
  L.push(`# ${info.title || slug}`);
  L.push("");
  L.push(`> TB 单：${info.ticketUrl || info.tbId || "-"}　结论：${info.kind === "reject" ? "非本侧问题" : "已修复"}　生成于 ${ts()}`);
  L.push("");
  if (info.lesson?.cause) { L.push(`## 原因`, info.lesson.cause, ""); }
  if (info.lesson?.prevention) { L.push(`## 预防（避免同类问题）`, info.lesson.prevention, ""); }
  if (info.detailReport) { L.push(`## 详细报告`, String(info.detailReport), ""); }
  try {
    fs.mkdirSync(absDir, { recursive: true });
    fs.writeFileSync(path.join(absDir, fileName), L.join("\n"), "utf-8");
    return { ok: true, rel: `${relDir}/${fileName}`, fileName };
  } catch (e) { return { ok: false, error: e.message }; }
}

// ---- Bug Agent 记忆（best-effort）----
let _bugStorage = null;
// 由 server.js 在创建 BugAgentStorage 后注入，避免二次开库/重复 seed
export function setBugAgentStorage(s) { _bugStorage = s; }
export function recordLessonToBugAgent(lesson) {
  if (!_bugStorage) return { ok: false, skipped: true, reason: "Bug Agent 存储未就绪" };
  try {
    const content = `[devbench/${lesson.carbId || lesson.tbId || "TB"}] ${lesson.title || ""}\n原因：${lesson.cause || ""}\n预防：${lesson.prevention || ""}`;
    appendSessionMemory(_bugStorage, { session_id: "devbench-lessons", case_id: null, content });
    return { ok: true };
  } catch (e) {
    log("system", "warn", "devbench", `写 Bug Agent 记忆失败: ${e.message}`);
    return { ok: false, error: e.message };
  }
}
