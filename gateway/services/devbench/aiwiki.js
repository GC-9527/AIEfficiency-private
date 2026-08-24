/**
 * AIWiki 一键同步：把内网 AIWiki（MediaWiki）里"应用市场"相关词条同步到指定工程的 docs/wiki/。
 *
 * - 数据源：MediaWiki 自带 api.php（action=query&list=search 搜索、action=parse&prop=wikitext 取源码）。
 *   AIWiki 自带的 Query API（端口 4806）只 bind 在 wiki 服务器本机、跨机不可达，故走 api.php。
 * - 转换：wikitext → markdown（infobox 走键值表、普通表用真实表头；去掉指向内网源文件的 <ref> 脚注）。
 * - 写入：docs/wiki/<slug>.md + docs/wiki/README.md（索引）。先读后写，幂等覆盖同名词条。
 *
 * 地址可在 config.aiwiki.baseUrl 覆盖（默认 http://192.168.10.46）。
 * 这是"手动同步、非实时"——用户在 devbench 点按钮触发。
 */
import fs from "fs";
import path from "path";
import { getConfig } from "../config.js";
import { log } from "../logger.js";

const DEFAULT_BASE = "http://192.168.10.46";
const DEFAULT_QUERY = "应用市场";

function apiBase() {
  const cfg = getConfig();
  const b = String(cfg?.aiwiki?.baseUrl || DEFAULT_BASE).replace(/\/+$/, "");
  return `${b}/api.php`;
}

function slugify(t) {
  return String(t).trim().replace(/\s+/g, "_").replace(/[\\/:*?"<>|]/g, "");
}

// ---- 行内 wikitext → markdown ----
function stripInline(s) {
  return String(s)
    .replace(/<ref[^>]*\/>/g, "")
    .replace(/<ref[^>]*>[\s\S]*?<\/ref>/g, "")
    .replace(/'''''([^']+?)'''''/g, "***$1***")
    .replace(/'''([^']+?)'''/g, "**$1**")
    .replace(/''([^']+?)''/g, "*$1*")
    .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, "$2")
    .replace(/\[\[([^\]]+)\]\]/g, "$1")
    .replace(/\[(https?:\/\/\S+?) ([^\]]+)\]/g, "[$2]($1)")
    .replace(/<code>([\s\S]*?)<\/code>/g, "`$1`")
    .replace(/<span[^>]*>/g, "")
    .replace(/<\/span>/g, "")
    .replace(/<br\s*\/?>/g, "  \n")
    .replace(/&mdash;/g, "—")
    .replace(/&ndash;/g, "–")
    .trim();
}

function cellContent(raw) {
  let c = String(raw).trim();
  // 去掉单元格属性前缀（scope/style/class/colspan/rowspan=... |）
  const m = c.match(/^([^|]*\b(?:scope|style|class|colspan|rowspan)=[^|]*)\|(.*)$/s);
  if (m) c = m[2];
  return stripInline(c.trim());
}

// ---- 表格：infobox（键值表）vs 普通表（真实表头）----
function convTable(block) {
  const lines = block.split(/\r?\n/);
  let caption = null;
  const rows = [];
  let cur = null;
  const nr = () => ({ h: [], d: [] });
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (l.startsWith("{|")) continue;
    if (l.startsWith("|}")) break;
    if (l.startsWith("|+")) { caption = stripInline(l.slice(2).trim()); continue; }
    if (l.startsWith("|-")) { if (cur) rows.push(cur); cur = nr(); continue; }
    if (!cur) cur = nr();
    if (l.startsWith("!")) { for (const p of l.slice(1).split("!!")) cur.h.push(cellContent(p)); }
    else if (l.startsWith("|")) { for (const p of l.slice(1).split("||")) cur.d.push(cellContent(p)); }
    else { const a = cur.d.length ? cur.d : cur.h; if (a.length) a[a.length - 1] += "  \n" + stripInline(l); }
  }
  if (cur) rows.push(cur);
  const out = [];
  if (caption) out.push(`**${caption}**`, "");
  const kv = rows.filter((r) => r.h.length === 1 && r.d.length === 1);
  const isKV = rows.length >= 2 && kv.length >= Math.ceil(rows.length * 0.6) && rows.every((r) => r.h.length + r.d.length <= 2);
  if (isKV) {
    out.push("| 字段 | 值 |", "|---|---|");
    for (const r of rows) {
      const k = r.h[0] ?? r.d[0] ?? "";
      const v = r.h.length && r.d.length ? r.d[0] : (r.d[1] ?? "");
      out.push(`| ${k} | ${v} |`);
    }
    return out.join("\n");
  }
  let hi = rows.findIndex((r) => r.h.length > 0 && r.d.length === 0);
  if (hi < 0) hi = 0;
  const hc = rows[hi].h.length ? rows[hi].h : rows[hi].d;
  const body = rows.filter((r, i) => i !== hi);
  const nc = Math.max(hc.length, ...body.map((r) => r.h.concat(r.d).length), 1);
  const pad = (a) => { const x = [...a]; while (x.length < nc) x.push(""); return x; };
  out.push("| " + pad(hc).join(" | ") + " |", "|" + Array(nc).fill("---").join("|") + "|");
  for (const r of body) out.push("| " + pad(r.h.concat(r.d)).join(" | ") + " |");
  return out.join("\n");
}

// ---- 整篇 wikitext → markdown ----
export function wiki2md(w) {
  const out = [];
  const lines = String(w).split(/\r?\n/);
  let i = 0;
  while (i < lines.length) {
    if (lines[i].trimStart().startsWith("{|")) {
      const b = [];
      while (i < lines.length) { b.push(lines[i]); if (lines[i].trimStart().startsWith("|}")) { i++; break; } i++; }
      out.push("", convTable(b.join("\n")), "");
      continue;
    }
    const sh = lines[i].match(/^<syntaxhighlight lang="(\w+)">/);
    if (sh) {
      const c = []; i++;
      while (i < lines.length && !/<\/syntaxhighlight>/.test(lines[i])) { c.push(lines[i]); i++; }
      i++;
      out.push("```" + sh[1], ...c, "```");
      continue;
    }
    const l = lines[i]; i++;
    const h = l.match(/^(={2,6})\s*(.+?)\s*\1\s*$/);
    if (h) { out.push("", "#".repeat(h[1].length) + " " + stripInline(h[2])); continue; }
    if (/^[*#]+\s/.test(l)) { const m = l.match(/^([*#]+)\s*(.*)$/); out.push("  ".repeat(m[1].length - 1) + "- " + stripInline(m[2])); continue; }
    if (!l.trim()) { out.push(""); continue; }
    out.push(stripInline(l));
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

async function wikiGet(params) {
  const url = `${apiBase()}?${new URLSearchParams({ format: "json", ...params })}`;
  const r = await fetch(url, { signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw new Error(`AIWiki HTTP ${r.status}`);
  return r.json();
}

/** 搜索词条标题列表。返回 [{ title, snippet }]。 */
export async function searchPages(query = DEFAULT_QUERY, limit = 20) {
  const j = await wikiGet({ action: "query", list: "search", srsearch: query, srlimit: String(limit) });
  return (j?.query?.search || []).map((x) => ({
    title: x.title,
    snippet: String(x.snippet || "").replace(/<[^>]+>/g, ""),
  }));
}

/** 取单篇词条 wikitext。 */
export async function fetchWikitext(title) {
  const j = await wikiGet({ action: "parse", page: title, prop: "wikitext" });
  return j?.parse?.wikitext?.["*"] || null;
}

/**
 * 把匹配词条同步到 projectPath/docs/wiki/。
 * opts: { query=应用市场, titles?:string[]（显式指定则跳过搜索）, limit=20 }
 * 返回 { ok, dir, files:[{title,fileName,bytes}], skipped:[{title,reason}] }
 */
export async function syncWiki(projectPath, opts = {}) {
  if (!projectPath) return { ok: false, error: "无工程路径" };
  if (!fs.existsSync(projectPath)) return { ok: false, error: `工程路径不存在：${projectPath}` };
  const query = opts.query || DEFAULT_QUERY;
  const limit = opts.limit || 20;

  let titles = Array.isArray(opts.titles) && opts.titles.length ? opts.titles : null;
  if (!titles) {
    const found = await searchPages(query, limit);
    titles = found.map((x) => x.title);
  }
  if (!titles.length) return { ok: false, error: `AIWiki 未搜到与「${query}」相关的词条` };

  const relDir = "docs/wiki";
  const absDir = path.join(projectPath, relDir);
  fs.mkdirSync(absDir, { recursive: true });

  const files = [];
  const skipped = [];
  for (const title of titles) {
    try {
      const w = await fetchWikitext(title);
      if (!w) { skipped.push({ title, reason: "无内容" }); continue; }
      const fileName = `${slugify(title)}.md`;
      const md = `---\ntitle: ${title}\nsource: AIWiki (${String(getConfig()?.aiwiki?.baseUrl || DEFAULT_BASE)}) · ${title}\n---\n\n# ${title}\n\n${wiki2md(w)}\n`;
      fs.writeFileSync(path.join(absDir, fileName), md, "utf-8");
      files.push({ title, fileName, bytes: Buffer.byteLength(md) });
    } catch (e) {
      skipped.push({ title, reason: e.message });
    }
  }

  // 索引 README（仅列出本次成功写入的词条 + 已存在的同目录 md）
  const base = String(getConfig()?.aiwiki?.baseUrl || DEFAULT_BASE);
  const idx = [
    `# 应用市场 Wiki（接入自 AIWiki）`,
    "",
    `> 来源：内网 AIWiki(${base})，关键词「${query}」相关词条。手动同步，非实时。最近同步：${new Date().toLocaleString("zh-CN")}`,
    "",
    ...files.map((f) => `- [${f.title}](${f.fileName})`),
  ];
  fs.writeFileSync(path.join(absDir, "README.md"), idx.join("\n") + "\n", "utf-8");

  log("system", "info", "devbench", `AIWiki 同步 ${files.length} 篇 → ${relDir}（跳过 ${skipped.length}）`);
  return { ok: true, dir: relDir, files, skipped };
}
