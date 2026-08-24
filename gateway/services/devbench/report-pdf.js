/**
 * devbench 验收报告 —— 通用 HTML/Markdown → PDF
 *
 * 与 deck-export.js 的区别：deck-export 是【幻灯片】专用（需 .slide 元素、逐页截图）；
 * 本模块面向【流式长文档】验收报告，用 puppeteer 的 page.pdf() 原生分页，支持表格/图片/长正文。
 * 复用 deck-export 的 findBrowser()（本机 Edge/Chrome）与 puppeteer-core。
 */
import puppeteer from "puppeteer-core";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import path from "path";
import { pathToFileURL } from "url";
import { findBrowser } from "../deck-export.js";

export async function configureNetworkIsolation(page, blockNetwork) {
  if (!blockNetwork) return;
  await page.setRequestInterception(true);
  page.on("request", (request) => {
    let protocol = "";
    try { protocol = new URL(request.url()).protocol; } catch {}
    if (["file:", "data:", "blob:", "about:"].includes(protocol)) request.continue();
    else request.abort("blockedbyclient");
  });
}

// 通用 HTML 文件 → PDF（A4，保留背景，自动分页）。htmlPath 用 file:// 加载，相对资源(图/视频首帧)可引用。
export async function htmlToPdf(htmlPath, outPdfPath, opts = {}) {
  if (!htmlPath || !existsSync(htmlPath)) throw new Error("HTML 不存在: " + htmlPath);
  const browser = findBrowser();
  if (!browser) throw new Error("未找到 Edge/Chrome，无法渲染 PDF（可设环境变量 DECK_EXPORT_BROWSER 指向 msedge.exe / chrome.exe）");
  mkdirSync(path.dirname(outPdfPath), { recursive: true });
  const br = await puppeteer.launch({
    executablePath: browser, headless: "new",
    args: ["--no-sandbox", "--disable-gpu", "--font-render-hinting=none"],
  });
  try {
    const page = await br.newPage();
    await configureNetworkIsolation(page, opts.blockNetwork === true);
    await page.goto(pathToFileURL(htmlPath).href, { waitUntil: "networkidle0", timeout: 60000 });
    try { await page.evaluate(() => document.fonts && document.fonts.ready); } catch {}
    await new Promise((r) => setTimeout(r, 500));
    await page.pdf({
      path: outPdfPath, format: opts.format || "A4", printBackground: true,
      margin: opts.margin || { top: "14mm", bottom: "14mm", left: "12mm", right: "12mm" },
      preferCSSPageSize: false,
    });
    return { ok: true, pdf: outPdfPath };
  } finally {
    try { await br.close(); } catch {}
  }
}

// 通用 HTML → PNG。默认截取完整页面；传 selector 时按元素真实高度生成长图，
// 不受浏览器当前一屏高度限制。
export async function htmlToPng(htmlPath, outPngPath, opts = {}) {
  if (!htmlPath || !existsSync(htmlPath)) throw new Error("HTML 不存在: " + htmlPath);
  const browser = findBrowser();
  if (!browser) throw new Error("未找到 Edge/Chrome，无法渲染 PNG（可设环境变量 DECK_EXPORT_BROWSER 指向 msedge.exe / chrome.exe）");
  mkdirSync(path.dirname(outPngPath), { recursive: true });
  const br = await puppeteer.launch({
    executablePath: browser, headless: "new",
    args: ["--no-sandbox", "--disable-gpu", "--font-render-hinting=none"],
  });
  try {
    const page = await br.newPage();
    await configureNetworkIsolation(page, opts.blockNetwork === true);
    await page.setViewport({
      width: Math.max(320, Number(opts.width) || 1280),
      height: Math.max(320, Number(opts.height) || 1706),
      deviceScaleFactor: Math.max(1, Math.min(2, Number(opts.deviceScaleFactor) || 1)),
    });
    await page.goto(pathToFileURL(htmlPath).href, { waitUntil: "networkidle0", timeout: 60000 });
    try { await page.evaluate(() => document.fonts && document.fonts.ready); } catch {}
    await new Promise((r) => setTimeout(r, 300));
    if (opts.selector) {
      const element = await page.$(String(opts.selector));
      if (!element) throw new Error(`PNG 截图元素不存在: ${opts.selector}`);
      await element.screenshot({ path: outPngPath, type: "png", captureBeyondViewport: true });
    } else {
      await page.screenshot({ path: outPngPath, type: "png", fullPage: opts.fullPage !== false });
    }
    return { ok: true, png: outPngPath };
  } finally {
    try { await br.close(); } catch {}
  }
}

// 极简 Markdown → HTML（兜底用：Agent 没产出 HTML 报告时，把详细报告 markdown 渲染成可读 PDF）
// 仅覆盖常见语法：标题/粗体/行内码/代码块/列表/图片/链接/分割线/段落；足够生成像样的 PDF。
export function markdownToHtml(md, title = "验收报告") {
  const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const lines = String(md || "").split(/\r?\n/);
  const out = [];
  let inCode = false, inList = false, inTable = false;
  const flushList = () => { if (inList) { out.push("</ul>"); inList = false; } };
  const flushTable = () => { if (inTable) { out.push("</tbody></table>"); inTable = false; } };
  const inline = (t) => esc(t)
    .replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '<img alt="$1" src="$2">')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>')
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  for (const raw of lines) {
    const line = raw.replace(/\s+$/, "");
    if (/^```/.test(line)) { if (inCode) { out.push("</pre>"); inCode = false; } else { flushList(); flushTable(); out.push("<pre>"); inCode = true; } continue; }
    if (inCode) { out.push(esc(raw)); continue; }
    if (!line.trim()) { flushList(); flushTable(); continue; }
    let m;
    const tableCells = line.trim().startsWith("|") && line.trim().endsWith("|")
      ? line.trim().slice(1, -1).split("|").map((cell) => cell.trim())
      : null;
    if (tableCells) {
      flushList();
      if (tableCells.every((cell) => /^:?-{2,}:?$/.test(cell))) continue;
      if (!inTable) {
        out.push(`<table><thead><tr>${tableCells.map((cell) => `<th>${inline(cell)}</th>`).join("")}</tr></thead><tbody>`);
        inTable = true;
      } else {
        out.push(`<tr>${tableCells.map((cell) => `<td>${inline(cell)}</td>`).join("")}</tr>`);
      }
      continue;
    }
    flushTable();
    if ((m = line.match(/^(#{1,6})\s+(.*)$/))) { flushList(); out.push(`<h${m[1].length}>${inline(m[2])}</h${m[1].length}>`); continue; }
    if (/^(\-{3,}|\*{3,}|_{3,})$/.test(line.trim())) { flushList(); out.push("<hr>"); continue; }
    if ((m = line.match(/^\s*[-*]\s+(.*)$/))) { if (!inList) { out.push("<ul>"); inList = true; } out.push(`<li>${inline(m[1])}</li>`); continue; }
    flushList();
    out.push(`<p>${inline(line)}</p>`);
  }
  if (inCode) out.push("</pre>");
  flushList();
  flushTable();
  const css = `body{font-family:-apple-system,"Segoe UI","Microsoft YaHei",sans-serif;color:#1f2328;line-height:1.6;max-width:920px;margin:0 auto;padding:8px 4px}
h1{font-size:24px;border-bottom:2px solid #e5e7eb;padding-bottom:6px}h2{font-size:19px;margin-top:22px;border-bottom:1px solid #eef0f2;padding-bottom:4px}h3{font-size:16px}
code{background:#f3f4f6;padding:1px 5px;border-radius:4px;font-family:Consolas,monospace;font-size:90%}
pre{background:#0f172a;color:#e2e8f0;padding:12px;border-radius:8px;overflow:auto;font-family:Consolas,monospace;font-size:12px;white-space:pre-wrap;word-break:break-word}
img{max-width:100%;border:1px solid #e5e7eb;border-radius:6px;margin:6px 0}
table{border-collapse:collapse;width:100%}th,td{border:1px solid #d0d7de;padding:6px 10px}th{background:#f6f8fa}
a{color:#0969da}hr{border:none;border-top:1px solid #e5e7eb;margin:18px 0}ul{padding-left:22px}`;
  return `<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>${esc(title)}</title><style>${css}</style></head><body>${out.join("\n")}</body></html>`;
}

// 兜底：把 markdown 写成临时 HTML 文件再转 PDF
export async function markdownToPdf(md, title, outPdfPath) {
  const html = markdownToHtml(md, title);
  const htmlPath = outPdfPath.replace(/\.pdf$/i, "") + ".html";
  writeFileSync(htmlPath, html, "utf-8");
  const r = await htmlToPdf(htmlPath, outPdfPath);
  return { ...r, htmlPath };
}

// 在故事点 reports/ 下找 Agent 产出的验收报告 HTML（优先 acceptance-report.html）。返回绝对路径或 null。
export function findAcceptanceHtml(reportsAbsDir) {
  if (!reportsAbsDir || !existsSync(reportsAbsDir)) return null;
  for (const name of ["acceptance-report.html", "report.html", "验收报告.html"]) {
    const p = path.join(reportsAbsDir, name);
    if (existsSync(p)) return p;
  }
  return null;
}
