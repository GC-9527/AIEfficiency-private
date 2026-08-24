/**
 * Git commit 只读评审交付物。
 *
 * 评审正文仍保留用户已有的纯文本/Markdown格式；本模块只基于同一份正文确定性地
 * 生成 HTML、PDF 和钉钉摘要 PNG，避免让 AI 另外创作一份可能漂移的视觉报告。
 */
import fs from "fs";
import path from "path";
import { htmlToPdf, htmlToPng } from "./report-pdf.js";
import * as store from "./store.js";

export const CODE_REVIEW_DONE_MARKER_RE = /<!--\s*CODE_REVIEW_DONE\s*-->/i;
const CODE_REVIEW_DONE_AT_END_RE = /<!--\s*CODE_REVIEW_DONE\s*-->\s*$/i;
const CODE_REVIEW_DONE_MARKER_GLOBAL_RE = /<!--\s*CODE_REVIEW_DONE\s*-->/gi;

const REQUIRED_REPORT_SECTIONS = Object.freeze([
  ["当前问题", /(?:^|\n)\s*#{0,3}\s*当前问题\s*(?:\n|$)/i],
  ["Findings", /(?:^|\n)\s*#{0,3}\s*Findings\s*(?:\n|$)/i],
  ["已读取材料", /(?:^|\n)\s*#{0,3}\s*已读取材料\s*(?:\n|$)/i],
  ["未读取材料", /(?:^|\n)\s*#{0,3}\s*未读取材料\s*(?:\n|$)/i],
  ["执行动作", /(?:^|\n)\s*#{0,3}\s*执行动作\s*(?:\n|$)/i],
  ["产出与改动", /(?:^|\n)\s*#{0,3}\s*产出与改动\s*(?:\n|$)/i],
  ["影响与风险", /(?:^|\n)\s*#{0,3}\s*影响与风险\s*(?:\n|$)/i],
  ["验证结果", /(?:^|\n)\s*#{0,3}\s*验证结果\s*(?:\n|$)/i],
  ["测试建议", /(?:^|\n)\s*#{0,3}\s*测试建议\s*(?:\n|$)/i],
]);

const ACTIVE_FINDING_STATUS_RE = /仍存在|部分修复|无法验证(?:最新分支)?|changes?\s+requested|open|unresolved/i;
const RESOLVED_FINDING_STATUS_RE = /已在.+修复|已修复|resolved|fixed/i;
const EXPLICIT_NO_FINDINGS_RE = /^(?:\s*[-*]\s*)?(?:(?:结论|评审结论|经检查)\s*[:：，,]?\s*)?(?:(?:本次评审|本次|当前)\s*)?(?:(?:未发现|没有发现|不存在)(?:任何|有效)?\s*(?:问题|缺陷|findings?)|(?:问题|缺陷|findings?)\s*[:：]\s*(?:无|没有|未发现)|(?:无|没有)\s*(?:任何)?\s*(?:问题|缺陷|findings?))(?:[。；;，,\s]|$)|^\s*(?:[-*]\s*)?(?:无|没有|none)\s*[。.]?\s*$/im;

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function safeInlineHref(value) {
  const href = String(value || "").trim();
  if (!href || /[\u0000-\u001f\u007f\\]/.test(href)) return "";
  // 只放行规范 http/https；mailto 一律拒绝，避免评审报告里邮箱被渲染成可点击链接唤起本机邮件客户端
  if (!/^https?:\/\//i.test(href)) return "";
  try {
    const parsed = new URL(href);
    if (!parsed.hostname) return "";
    return parsed.href;
  } catch {
    return "";
  }
}

function decorateEscapedInline(value) {
  return String(value || "")
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
}

function inlineMarkdown(value) {
  const source = String(value || "");
  const linkPattern = /(!?)\[([^\]]*)\]\(([^)]+)\)/g;
  const output = [];
  let cursor = 0;
  let match;
  while ((match = linkPattern.exec(source))) {
    output.push(decorateEscapedInline(escapeHtml(source.slice(cursor, match.index))));
    const [, image, label, href] = match;
    const safe = safeInlineHref(href);
    if (!safe) {
      output.push(decorateEscapedInline(escapeHtml(label)));
    } else if (image) {
      output.push(`<span class="external-image-omitted">外部图片未自动加载：<a href="${escapeHtml(safe)}" target="_blank" rel="noopener noreferrer">${decorateEscapedInline(escapeHtml(label || safe))}</a></span>`);
    } else {
      output.push(`<a href="${escapeHtml(safe)}" target="_blank" rel="noopener noreferrer">${decorateEscapedInline(escapeHtml(label))}</a>`);
    }
    cursor = linkPattern.lastIndex;
  }
  output.push(decorateEscapedInline(escapeHtml(source.slice(cursor))));
  return output.join("");
}

function recognizedSectionTitle(line) {
  const value = String(line || "").replace(/^#{1,3}\s*/, "").trim();
  return REQUIRED_REPORT_SECTIONS.some(([title]) => title.toLowerCase() === value.toLowerCase())
    ? value
    : "";
}

function reportSections(text) {
  const source = String(text || "").replace(/\r\n?/g, "\n");
  const titles = REQUIRED_REPORT_SECTIONS.map(([title]) => title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  const pattern = new RegExp(`(?:^|\\n)[\\t ]*#{0,3}[\\t ]*(${titles})[\\t ]*(?=\\n|$)`, "gi");
  const matches = [...source.matchAll(pattern)];
  const sections = new Map();
  for (let index = 0; index < matches.length; index += 1) {
    const match = matches[index];
    const label = match[1].toLowerCase();
    const bodyStart = match.index + match[0].length;
    const bodyEnd = matches[index + 1]?.index ?? source.length;
    if (!sections.has(label)) sections.set(label, source.slice(bodyStart, bodyEnd));
  }
  return sections;
}

function reportSectionBody(text, label) {
  return reportSections(text).get(String(label || "").toLowerCase()) || "";
}

function substantiveSectionText(value) {
  return String(value || "")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>\n]{0,240}>/g, " ")
    .replace(/[`#*_|[\]()-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function findingStatusFromLine(value) {
  const line = String(value || "")
    .replace(/^\s*(?:[-*+]\s+|\d+[.)、]\s+)/, "")
    .replace(/^\*\*(当前状态)\*\*\s*([:：])/, "$1$2")
    .replace(/^\*\*(当前状态\s*[:：])\*\*/, "$1")
    .trim();
  const match = line.match(/^当前状态\s*[:：]\s*(.+)$/i);
  return match ? match[1].trim().replace(/^\*\*([\s\S]*?)\*\*$/, "$1").trim() : "";
}

export function markdownToSafeReviewBody(markdown) {
  const lines = String(markdown || "").replace(/\r\n?/g, "\n").split("\n");
  const out = [];
  let inCode = false;
  let inList = false;
  let inTable = false;
  const closeList = () => {
    if (!inList) return;
    out.push("</ul>");
    inList = false;
  };
  const closeTable = () => {
    if (!inTable) return;
    out.push("</tbody></table></div>");
    inTable = false;
  };
  for (const raw of lines) {
    const line = raw.replace(/\s+$/, "");
    if (/^```/.test(line.trim())) {
      closeList();
      closeTable();
      out.push(inCode ? "</code></pre>" : "<pre><code>");
      inCode = !inCode;
      continue;
    }
    if (inCode) {
      out.push(`${escapeHtml(raw)}\n`);
      continue;
    }
    if (!line.trim()) {
      closeList();
      closeTable();
      continue;
    }
    const tableCells = line.trim().startsWith("|") && line.trim().endsWith("|")
      ? line.trim().slice(1, -1).split("|").map((cell) => cell.trim())
      : null;
    if (tableCells) {
      closeList();
      if (tableCells.every((cell) => /^:?-{2,}:?$/.test(cell))) continue;
      if (!inTable) {
        out.push(`<div class="table-wrap"><table><thead><tr>${tableCells.map((cell) => `<th>${inlineMarkdown(cell)}</th>`).join("")}</tr></thead><tbody>`);
        inTable = true;
      } else {
        out.push(`<tr>${tableCells.map((cell) => `<td>${inlineMarkdown(cell)}</td>`).join("")}</tr>`);
      }
      continue;
    }
    closeTable();
    const heading = line.match(/^(#{1,4})\s+(.*)$/);
    const sectionTitle = recognizedSectionTitle(line);
    const findingSeverity = severityFromTitle(heading ? heading[2] : line);
    if (heading || sectionTitle || findingSeverity !== "unknown") {
      closeList();
      const level = heading ? Math.min(4, heading[1].length) : (sectionTitle ? 2 : 3);
      const title = heading ? heading[2] : (sectionTitle || line);
      const severity = findingSeverity === "high"
        ? " severity-high"
        : (findingSeverity === "medium" ? " severity-medium" : (findingSeverity === "low" ? " severity-low" : ""));
      out.push(`<h${level} class="${severity.trim()}">${inlineMarkdown(title)}</h${level}>`);
      continue;
    }
    const status = findingStatusFromLine(line);
    if (status) {
      closeList();
      const active = ACTIVE_FINDING_STATUS_RE.test(status) && !RESOLVED_FINDING_STATUS_RE.test(status);
      out.push(`<p class="finding-status ${active ? "is-active" : "is-resolved"}"><span>当前状态</span>${inlineMarkdown(status)}</p>`);
      continue;
    }
    const bullet = line.match(/^\s*[-*]\s+(.*)$/);
    if (bullet) {
      if (!inList) {
        out.push("<ul>");
        inList = true;
      }
      out.push(`<li>${inlineMarkdown(bullet[1])}</li>`);
      continue;
    }
    closeList();
    out.push(`<p>${inlineMarkdown(line)}</p>`);
  }
  if (inCode) out.push("</code></pre>");
  closeList();
  closeTable();
  return out.join("\n");
}

export function validateCodeReviewReport(text) {
  const original = String(text || "");
  const source = original.replace(CODE_REVIEW_DONE_MARKER_GLOBAL_RE, "");
  const inspectionSource = source.trim();
  const firstContentLine = inspectionSource.split(/\r?\n/).map((line) => line.trim()).find(Boolean) || "";
  const missing = [];
  if (!/^任务状态[:：]\s*已完成\s*$/i.test(firstContentLine.replace(/\*\*/g, ""))) {
    missing.push("首行“任务状态：已完成”");
  }
  const sections = reportSections(inspectionSource);
  for (const [label, pattern] of REQUIRED_REPORT_SECTIONS) {
    if (!pattern.test(inspectionSource)) {
      missing.push(label);
      continue;
    }
    const minimum = label === "当前问题" ? 12 : 4;
    if (substantiveSectionText(sections.get(label.toLowerCase()) || "").length < minimum) {
      missing.push(`${label}（内容为空或过短）`);
    }
  }
  const findingAssessment = assessCodeReviewFindings(inspectionSource);
  if (!findingAssessment.noFindingsDeclared && findingAssessment.findings.length === 0) {
    missing.push("Findings（需明确列出 finding 或声明未发现问题）");
  }
  if (findingAssessment.findings.some((finding) => finding.severity === "unknown")) {
    missing.push("Findings（存在无法判定严重度的问题）");
  }
  if (findingAssessment.findings.some((finding) => !finding.status)) {
    missing.push("Findings（每条必须包含当前状态）");
  }
  if (inspectionSource.length < 300) missing.push("足够具体的评审证据");
  return { ok: missing.length === 0, missing, cleaned: source };
}

export function parseCodeReviewCompletion(text) {
  const source = String(text || "");
  const marker = CODE_REVIEW_DONE_AT_END_RE.test(source);
  const validation = validateCodeReviewReport(source);
  return {
    marker,
    completed: marker && validation.ok,
    cleaned: validation.cleaned,
    missing: validation.missing,
  };
}

function severityFromTitle(value) {
  const title = String(value || "")
    .replace(/^\s*(?:\d+[.)、]\s*)?/, "")
    .trim();
  if (/^(?:严重度|风险等级|风险级别)\s*[:：]\s*(?:高|严重|致命|阻断|critical|blocker|p0)(?:\s|$|[，,;；])/i.test(title)) return "high";
  if (/^(?:严重度|风险等级|风险级别)\s*[:：]\s*(?:中|一般|major|p1)(?:\s|$|[，,;；])/i.test(title)) return "medium";
  if (/^(?:严重度|风险等级|风险级别)\s*[:：]\s*(?:低|轻微|minor|p2)(?:\s|$|[，,;；])/i.test(title)) return "low";
  if (/^\[?(?:高严重度|高风险|高危|严重问题|重大问题|致命问题|阻断问题|critical|blocker|p0)\]?(?:\s*[:：-]|\s|$)/i.test(title)) return "high";
  if (/^\[?(?:中严重度|中风险|中等风险|一般问题|major|p1)\]?(?:\s*[:：-]|\s|$)/i.test(title)) return "medium";
  if (/^\[?(?:低严重度|低风险|轻微问题|minor|p2)\]?(?:\s*[:：-]|\s|$)/i.test(title)) return "low";
  return "unknown";
}

export function parseCodeReviewFindings(text) {
  const findingsBody = reportSectionBody(text, "Findings");
  const lines = String(findingsBody || text || "").replace(/\r\n?/g, "\n").split("\n");
  const findings = [];
  let current = null;
  for (const raw of lines) {
    const line = raw.replace(/^#{1,4}\s*/, "").trim();
    if (!line || EXPLICIT_NO_FINDINGS_RE.test(line)) continue;
    const severity = severityFromTitle(line);
    if (severity !== "unknown") {
      const severityOnly = /^(?:严重度|风险等级|风险级别)\s*[:：]/i.test(line);
      if (severityOnly && current) {
        current.severity = severity;
      } else {
        current = { severity, title: line.slice(0, 260), status: "" };
        findings.push(current);
      }
      continue;
    }
    if (/^(?:\d+[.)、]\s*)?(?:问题|缺陷|finding)\s*(?:#?\d+)?\s*[:：.-]\s*\S+/i.test(line)) {
      current = { severity: "unknown", title: line.slice(0, 260), status: "" };
      findings.push(current);
      continue;
    }
    if (!current) continue;
    const status = findingStatusFromLine(line);
    if (status) current.status = status.slice(0, 120);
  }
  return findings.map((finding) => {
    const active = finding.status
      ? ACTIVE_FINDING_STATUS_RE.test(finding.status) && !RESOLVED_FINDING_STATUS_RE.test(finding.status)
      : true;
    return { ...finding, active };
  });
}

export function assessCodeReviewFindings(text) {
  const body = reportSectionBody(text, "Findings");
  const findings = parseCodeReviewFindings(text);
  const noFindingsDeclared = EXPLICIT_NO_FINDINGS_RE.test(body);
  const ambiguous = (!noFindingsDeclared && findings.length === 0)
    || findings.some((finding) => finding.severity === "unknown" || !finding.status);
  return { findings, noFindingsDeclared, ambiguous };
}

export function codeReviewVerdict(findings = [], assessment = {}) {
  const rows = Array.isArray(findings) ? findings : [];
  if (assessment.ambiguous || rows.some((finding) => finding.severity === "unknown")) {
    return { key: "inconclusive", label: "证据不足", tone: "warning", reason: "Findings 结构或严重度无法可靠判定" };
  }
  const active = rows.filter((finding) => finding.active !== false);
  const unverifiable = active.filter((finding) => /无法验证/i.test(String(finding.status || "")));
  if (active.some((finding) => finding.severity === "high" && !unverifiable.includes(finding))) {
    return { key: "changes_requested", label: "阻断合入", tone: "danger", reason: "存在仍未解决的高严重度问题" };
  }
  if (unverifiable.length) {
    return { key: "inconclusive", label: "证据不足", tone: "warning", reason: "关键 finding 的最新分支状态无法验证" };
  }
  if (active.some((finding) => finding.severity === "medium")) {
    return { key: "approved_with_notes", label: "有条件合入", tone: "warning", reason: "仍有中严重度问题需要确认或修复" };
  }
  if (active.length) {
    return { key: "approved_with_notes", label: "有条件合入", tone: "info", reason: "仍有低严重度或未分级问题" };
  }
  if (!rows.length && assessment.noFindingsDeclared !== true) {
    return { key: "inconclusive", label: "证据不足", tone: "warning", reason: "未提供可判定的 finding 或明确的无问题结论" };
  }
  return { key: "approved", label: "可合入", tone: "success", reason: rows.length ? "已记录 finding 均已修复" : "明确未发现阻断性 finding" };
}

function compact(value, limit = 160) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

function conciseFindingTitle(value) {
  return String(value || "")
    .replace(/^\s*(?:\d+[.)、]\s*)?/, "")
    .replace(/^\[?(?:高严重度|高风险|高危|严重问题|重大问题|致命问题|阻断问题|critical|blocker|p0|中严重度|中风险|中等风险|一般问题|major|p1|低严重度|低风险|轻微问题|minor|p2)\]?\s*[:：-]?\s*/i, "")
    .trim();
}

function summaryFindingBlocks(reportText, findings) {
  const lines = reportSectionBody(reportText, "Findings").replace(/\r\n?/g, "\n").split("\n");
  const blocks = [];
  let current = null;
  for (const raw of lines) {
    const line = raw
      .replace(/^#{1,4}\s*/, "")
      .replace(/^\s*[-*]\s+/, "")
      .trim();
    if (!line || /^```/.test(line) || (line.startsWith("|") && line.endsWith("|"))) continue;
    const severity = severityFromTitle(line);
    const severityOnly = /^(?:严重度|风险等级|风险级别)\s*[:：]/i.test(line);
    if (severity !== "unknown" && !severityOnly) {
      current = { severity, title: line, status: "", details: [] };
      blocks.push(current);
      continue;
    }
    if (!current) continue;
    const status = findingStatusFromLine(line);
    if (status) {
      current.status = status;
      continue;
    }
    current.details.push(line);
  }
  return findings.map((finding, index) => {
    const block = blocks[index] || {};
    return {
      ...finding,
      title: conciseFindingTitle(block.title || finding.title),
      status: block.status || finding.status,
      details: (block.details || []).slice(0, 4).map((line) => compact(line, 300)),
    };
  });
}

function summaryCountText(counts) {
  const parts = [
    counts.high ? `${counts.high} 个高风险` : "",
    counts.medium ? `${counts.medium} 个中风险` : "",
    counts.low ? `${counts.low} 个低风险` : "",
  ].filter(Boolean);
  return parts.length ? `发现 ${parts.join("、")}` : "未发现结构化问题";
}

function buildMeta(tab) {
  const review = tab?.reviewContext || {};
  const inference = review.inference || {};
  const latest = review.latestBranchComparison || {};
  return {
    title: tab?.title || review.subject || "Git commit 代码评审",
    repository: review.repositoryName || review.repositoryId || "未记录",
    revision: review.revision || "",
    shortRevision: review.shortRevision || String(review.revision || "").slice(0, 12) || "unknown",
    subject: review.subject || "",
    branch: latest.branch || inference.branch || "未确认",
    latestTip: latest.remoteTip || latest.comparisonTip || "",
    vehicle: inference.vehicle || "",
    flavor: inference.flavor || "",
  };
}

export function buildCodeReviewReportHtml(tab, reportText, generatedAt = new Date()) {
  const meta = buildMeta(tab);
  const assessment = assessCodeReviewFindings(reportText);
  const findings = assessment.findings;
  const verdict = codeReviewVerdict(findings, assessment);
  const counts = {
    high: findings.filter((finding) => finding.severity === "high").length,
    medium: findings.filter((finding) => finding.severity === "medium").length,
    low: findings.filter((finding) => finding.severity === "low").length,
    active: findings.filter((finding) => finding.active).length,
  };
  const summaryFindings = summaryFindingBlocks(reportText, findings);
  const visibleFindings = summaryFindings.slice(0, 3);
  const omittedFindingCount = Math.max(0, summaryFindings.length - visibleFindings.length);
  const body = markdownToSafeReviewBody(reportText);
  const timeText = generatedAt.toLocaleString("zh-CN", { hour12: false });
  const severityLabel = { high: "高风险", medium: "中风险", low: "低风险" };
  const findingRows = visibleFindings.length
    ? visibleFindings.map((finding) => `
      <section class="summary-finding finding-${finding.severity}">
        <h2><span class="severity-tag">[${escapeHtml(severityLabel[finding.severity] || "风险")}]</span>${inlineMarkdown(compact(finding.title, 180))}</h2>
        <p class="summary-status"><strong>当前状态：</strong>${inlineMarkdown(finding.status || "状态未单独标注")}</p>
        ${finding.details.length ? `<ul>${finding.details.map((detail) => `<li>${inlineMarkdown(detail)}</li>`).join("")}</ul>` : ""}
      </section>`).join("")
    : assessment.noFindingsDeclared
      ? `<p class="summary-empty">本次评审明确未发现阻断性 finding；仍需结合 PDF 中的未验证项决定最终发布范围。</p>`
      : `<p class="summary-empty">Findings 证据不足，当前报告未形成可供合入决策的结构化结论。</p>`;
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${escapeHtml(`代码评审报告 ${meta.shortRevision}`)}</title>
  <style>
    :root{--ink:#172033;--muted:#64748b;--line:#dbe4ee;--paper:#fff;--danger:#ff7b72;--warning:#e3b341;--info:#79c0ff;--success:#56d364}
    *{box-sizing:border-box}html,body{margin:0;background:#eef2f7;color:var(--ink);font-family:"Segoe UI","Microsoft YaHei",Arial,sans-serif}
    body{padding:24px}.share-card{width:1440px;height:auto;margin:0 auto 40px;padding:16px 28px 20px;overflow:visible;color:#f0f2f4;border:1px solid #42454a;border-radius:0;background:#1f2023;font-size:17px;line-height:1.62;box-shadow:none}
    .summary-commit-title{margin:0 0 10px;padding:0 0 9px;border-bottom:1px solid #3a3d42;color:#f6f8fa;font-size:19px;line-height:1.5;font-weight:700}.summary-commit-title code{font-size:16px}
    .summary-lead{margin:0 0 10px;font-size:18px;line-height:1.55;font-weight:650}.summary-lead .verdict-label{color:#fff}.summary-lead[data-tone="danger"] .verdict-label{color:var(--danger)}.summary-lead[data-tone="warning"] .verdict-label{color:var(--warning)}.summary-lead[data-tone="success"] .verdict-label{color:var(--success)}
    .summary-finding{margin:0;padding:0 0 14px}.summary-finding+.summary-finding{padding-top:2px}.summary-finding h2{margin:0 0 4px;font-size:18px;line-height:1.55;color:#f6f8fa}.severity-tag{margin-right:5px}.finding-high .severity-tag{color:var(--danger)}.finding-medium .severity-tag{color:var(--warning)}.finding-low .severity-tag{color:var(--info)}
    .summary-status{margin:0 0 4px;padding-left:30px;color:#d6d8db}.summary-finding ul{margin:0;padding-left:48px}.summary-finding li{margin:2px 0}.summary-commit-title code,.summary-finding code,.summary-meta code{padding:1px 5px;border-radius:4px;background:#2d2f33;color:#fff;font-family:Consolas,"Cascadia Mono",monospace;font-size:.92em}.summary-finding a{color:#58a6ff;text-decoration:underline;text-underline-offset:2px}.summary-empty{margin:8px 0 14px}.summary-more{margin:0 0 12px;color:#aeb2b7}.summary-meta{margin:2px 0 0;padding-top:10px;border-top:1px solid #3a3d42;color:#9da2a8;font-size:14px;line-height:1.55}
    .report{max-width:980px;margin:0 auto;background:var(--paper);padding:64px 72px;border-radius:18px;box-shadow:0 18px 50px rgba(15,23,42,.1)}
    .report-cover{border-bottom:2px solid var(--ink);padding-bottom:26px;margin-bottom:34px}.report-cover h1{font-size:34px;margin:0 0 14px}.report-cover p{margin:6px 0;color:var(--muted)}
    .report h1{font-size:30px}.report h2{font-size:23px;margin:34px 0 14px;padding-bottom:8px;border-bottom:1px solid var(--line)}.report h3{font-size:19px;margin:24px 0 10px}.report p,.report li{font-size:15px;line-height:1.75}.report ul{padding-left:24px}
    .report code{font-family:Consolas,monospace;background:#f1f5f9;border-radius:5px;padding:2px 5px}.report pre{background:#0f172a;color:#e2e8f0;border-radius:10px;padding:16px;overflow:auto;white-space:pre-wrap;word-break:break-word}
    .table-wrap{overflow:auto;margin:14px 0}.report table{border-collapse:collapse;width:100%}.report th,.report td{border:1px solid var(--line);padding:9px 12px;text-align:left}.report th{background:#f8fafc}
    .finding-status{display:inline-flex;align-items:center;gap:10px;border-radius:999px;padding:6px 12px!important;font-weight:700}.finding-status span{font-size:12px;font-weight:500;color:var(--muted)}.finding-status.is-active{background:#fff1f2;color:#be123c}.finding-status.is-resolved{background:#ecfdf5;color:#047857}
    .severity-high{color:#be123c}.severity-medium{color:#b45309}.severity-low{color:#0369a1}.report a{color:#0369a1}.report img{max-width:100%;border:1px solid var(--line);border-radius:8px}
    .report-footer{margin-top:48px;padding-top:18px;border-top:1px solid var(--line);color:var(--muted);font-size:12px}
    @page{size:A4;margin:13mm 12mm}@media print{body{padding:0;background:#fff}.share-card{display:none!important}.report{max-width:none;padding:0;border-radius:0;box-shadow:none}.report h2,.report h3{break-after:avoid}.table-wrap,pre{break-inside:avoid}}
  </style>
</head>
<body>
  <section class="share-card" data-review-share-card data-review-summary>
    <h1 class="summary-commit-title">Git Commit <code>${escapeHtml(meta.shortRevision)}</code> · ${escapeHtml(compact(meta.subject || meta.title || "代码评审", 220))}</h1>
    <p class="summary-lead" data-tone="${escapeHtml(verdict.tone)}"><strong>评审结论：</strong><span class="verdict-label">${escapeHtml(verdict.label)}</span>。${escapeHtml(summaryCountText(counts))}，当前待处理 ${counts.active} 个。代码评审已完成；完整证据与验证边界见 PDF。</p>
    ${findingRows}
    ${omittedFindingCount ? `<p class="summary-more">另有 ${omittedFindingCount} 条 finding 未在摘要图展开，请查看 PDF 完整报告。</p>` : ""}
    <p class="summary-meta">仓库：${escapeHtml(compact(meta.repository, 80))}　·　分支：${escapeHtml(compact(meta.branch, 80))}　·　Revision：<code>${escapeHtml(meta.shortRevision)}</code>　·　${escapeHtml(timeText)}</p>
  </section>
  <main class="report">
    <header class="report-cover">
      <h1>代码评审报告</h1>
      <p><strong>评审执行状态：</strong>已完成　<strong>合入建议：</strong>${escapeHtml(verdict.label)}</p>
      <p><strong>仓库：</strong>${escapeHtml(meta.repository)}　<strong>Revision：</strong><code>${escapeHtml(meta.revision || meta.shortRevision)}</code></p>
      <p><strong>对应分支：</strong>${escapeHtml(meta.branch)}${meta.latestTip ? `　<strong>冻结 Tip：</strong><code>${escapeHtml(meta.latestTip)}</code>` : ""}</p>
      <p><strong>车型 / Flavor：</strong>${escapeHtml(meta.vehicle || "未指定")} / ${escapeHtml(meta.flavor || "未指定")}</p>
    </header>
    ${body}
    <footer class="report-footer">本 PDF、摘要图与原始文本由同一份评审结论确定性生成；摘要图不替代完整 finding 与验证边界。</footer>
  </main>
</body>
</html>`;
}

function safeShortRevision(tab) {
  const value = String(tab?.reviewContext?.shortRevision || tab?.reviewContext?.revision || "review")
    .replace(/[^0-9a-z_-]+/gi, "")
    .slice(0, 12);
  return value || "review";
}

function artifact(rel, absPath, name, mimeType, kind) {
  return { rel, absPath, name, mimeType, kind };
}

export function codeReviewArtifactMessage(artifacts, verdict) {
  const original = artifacts?.original?.rel || "";
  const html = artifacts?.html?.rel || "";
  const pdf = artifacts?.pdf?.rel || "";
  const image = artifacts?.image?.rel || "";
  return [
    `评审执行已完成；合入建议：**${verdict?.label || "请查看完整报告"}**。`,
    "",
    image ? `![代码评审摘要图](${image})` : "",
    "",
    [
      original ? `[原始评审结论](${original})` : "",
      html ? `[HTML 完整报告](${html})` : "",
      pdf ? `[PDF 完整报告](${pdf})` : "",
      image ? `[打开摘要 PNG](${image})` : "",
    ].filter(Boolean).join(" · "),
    "",
    "原始文字结构已保留；PNG 适合钉钉群预览，PDF 用于查看完整 findings、证据和验证边界。",
  ].filter((line, index, rows) => line || (index > 0 && rows[index - 1])).join("\n").trim();
}

export async function generateCodeReviewArtifacts(tab, reportText, opts = {}) {
  const validation = validateCodeReviewReport(reportText);
  if (!validation.ok) {
    return { ok: false, code: "CODE_REVIEW_REPORT_INVALID", error: `评审结论格式不完整，缺少：${validation.missing.join("、")}`, missing: validation.missing };
  }
  const storage = store.getStoryStoragePaths(tab, { create: true });
  const reportsDir = storage.reportsDirectory;
  const shortRevision = safeShortRevision(tab);
  const base = `代码评审_${shortRevision}`;
  const names = {
    original: `${base}_原始结论.txt`,
    html: `${base}_完整报告.html`,
    pdf: `${base}_完整报告.pdf`,
    image: `${base}_钉钉摘要.png`,
    manifest: `${base}_产物清单.json`,
  };
  const paths = Object.fromEntries(Object.entries(names).map(([key, name]) => [key, path.join(reportsDir, name)]));
  for (const target of Object.values(paths)) {
    store.validateStoryStorageTarget(tab, target, { baseDirectory: reportsDir, mustExist: false });
  }

  const generatedAt = opts.generatedAt instanceof Date ? opts.generatedAt : new Date();
  const assessment = assessCodeReviewFindings(validation.cleaned);
  const findings = assessment.findings;
  const verdict = codeReviewVerdict(findings, assessment);
  const html = buildCodeReviewReportHtml(tab, validation.cleaned, generatedAt);
  fs.writeFileSync(paths.original, validation.cleaned, "utf-8");
  fs.writeFileSync(paths.html, html, "utf-8");
  store.validateStoryStorageTarget(tab, paths.original, { baseDirectory: reportsDir, mustExist: true, expectedType: "file" });
  store.validateStoryStorageTarget(tab, paths.html, { baseDirectory: reportsDir, mustExist: true, expectedType: "file" });

  const rel = (name) => `storydev:/reports/${name}`;
  const artifacts = {
    original: artifact(rel(names.original), paths.original, names.original, "text/plain; charset=utf-8", "source"),
    html: artifact(rel(names.html), paths.html, names.html, "text/html; charset=utf-8", "report"),
  };
  const renderPdf = opts.renderPdf || htmlToPdf;
  const renderPng = opts.renderPng || htmlToPng;
  const renderErrors = [];
  try {
    await renderPdf(paths.html, paths.pdf, { blockNetwork: true });
    store.validateStoryStorageTarget(tab, paths.pdf, { baseDirectory: reportsDir, mustExist: true, expectedType: "file" });
    artifacts.pdf = artifact(rel(names.pdf), paths.pdf, names.pdf, "application/pdf", "report");
  } catch (error) {
    renderErrors.push(`PDF：${error?.message || error}`);
  }
  try {
    await renderPng(paths.html, paths.image, {
      selector: "[data-review-share-card]",
      width: 1440,
      height: 900,
      deviceScaleFactor: 1,
      blockNetwork: true,
    });
    store.validateStoryStorageTarget(tab, paths.image, { baseDirectory: reportsDir, mustExist: true, expectedType: "file" });
    artifacts.image = artifact(rel(names.image), paths.image, names.image, "image/png", "image");
  } catch (error) {
    renderErrors.push(`PNG：${error?.message || error}`);
  }
  const manifest = {
    schemaVersion: 1,
    kind: "git_commit_code_review",
    generatedAt: generatedAt.toISOString(),
    reviewExecutionStatus: renderErrors.length ? "artifact_partial" : "completed",
    verdict,
    revision: tab?.reviewContext?.revision || "",
    renderErrors,
    artifacts: Object.fromEntries(Object.entries(artifacts).map(([key, value]) => [key, {
      rel: value.rel,
      name: value.name,
      mimeType: value.mimeType,
      kind: value.kind,
    }])),
  };
  fs.writeFileSync(paths.manifest, `${JSON.stringify(manifest, null, 2)}\n`, "utf-8");
  store.validateStoryStorageTarget(tab, paths.manifest, { baseDirectory: reportsDir, mustExist: true, expectedType: "file" });
  artifacts.manifest = artifact(rel(names.manifest), paths.manifest, names.manifest, "application/json; charset=utf-8", "manifest");
  if (renderErrors.length) {
    return {
      ok: false,
      partial: true,
      code: "CODE_REVIEW_ARTIFACT_RENDER_FAILED",
      error: renderErrors.join("；"),
      artifacts,
      verdict,
      findings,
      generatedAt: generatedAt.toISOString(),
    };
  }
  return { ok: true, artifacts, verdict, findings, generatedAt: generatedAt.toISOString() };
}
