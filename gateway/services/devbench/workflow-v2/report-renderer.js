import { closeSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import path from "node:path";
import { canonicalSha256 } from "./envelope-store.js";
import { assertTrustedRepairReportFacts } from "./trusted-report-facts.js";

const RENDERER_GATE_SCHEMA_VERSION = "report-renderer-gate-v1";
const PDF_GATE_SCHEMA_VERSION = "report-pdf-gate-v1";
const MAX_SHORT_REPORT_CHARS = 100;
const SHORT_LINE_PATTERN = /^原因：[^\r\n]+。措施：[^\r\n]+。$/u;

export class WorkflowV2ReportGateError extends Error {
  constructor(message, code, details = {}) {
    super(message);
    this.name = "WorkflowV2ReportGateError";
    this.code = code;
    this.details = details;
  }
}

function fail(message, code, details = {}) {
  throw new WorkflowV2ReportGateError(message, code, details);
}

function deepFreeze(value, seen = new Set()) {
  if (!value || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
}

function unicodeSlice(value, max) {
  return Array.from(String(value || "")).slice(0, max).join("");
}

function resolveStoryDevPath(tab, storageApi, contentRef) {
  const ref = String(contentRef || "");
  if (!ref.startsWith("storydev:/")) return null;
  const relative = ref.slice("storydev:/".length).replace(/\\/g, "/");
  const storage = storageApi?.getStoryStoragePaths?.(tab, { create: true });
  if (!storage?.storyDirectory) return null;
  return {
    absolutePath: path.join(storage.storyDirectory, ...relative.split("/")),
    relative,
  };
}

function uniqueSorted(values) {
  return [...new Set(values.filter(Boolean))].sort();
}

/**
 * M7 程序化简短报告渲染：只接受当前进程的可信 REPAIR facts，生成唯一的
 * 单行「原因：...。措施：...。」文案；任何 legacy 文本或普通 JSON facts 都
 * 不能进入 v2 确定性路径。
 */
export function renderShortReport({ reportFacts, maxChars = MAX_SHORT_REPORT_CHARS } = {}) {
  const limit = Number.isSafeInteger(maxChars) ? Math.min(maxChars, MAX_SHORT_REPORT_CHARS) : 0;
  try {
    if (limit < 10) fail("REPORT_SHORT maxChars 必须在 10 至 100 之间", "WORKFLOW_V2_SHORT_REPORT_BUDGET_INVALID");
    const { cause, measure } = assertTrustedRepairReportFacts(reportFacts);
    // 「原因：」+「。」+「措施：」+「。」共 8 个 Unicode 字符；先均分，再把
    // 未使用的原因预算让给措施，保证所有截断决策稳定且始终保留两项事实。
    const available = limit - 8;
    let causeSize = Math.min(Array.from(cause).length, Math.max(1, Math.floor(available / 2)));
    let measureSize = Math.min(Array.from(measure).length, Math.max(1, available - causeSize));
    let remaining = available - causeSize - measureSize;
    if (remaining > 0) {
      const causeRemaining = Array.from(cause).length - causeSize;
      const addCause = Math.min(remaining, Math.max(0, causeRemaining));
      causeSize += addCause;
      remaining -= addCause;
      measureSize += Math.min(remaining, Math.max(0, Array.from(measure).length - measureSize));
    }
    const text = `原因：${unicodeSlice(cause, causeSize)}。措施：${unicodeSlice(measure, measureSize)}。`;
    if (!SHORT_LINE_PATTERN.test(text) || Array.from(text).length > MAX_SHORT_REPORT_CHARS || Array.from(text).length > limit) {
      fail("REPORT_SHORT 无法生成严格单行文本", "WORKFLOW_V2_SHORT_REPORT_RENDER_INVALID");
    }
    return Object.freeze({ ok: true, missing: Object.freeze([]), text, cause, measure, error: null });
  } catch (error) {
    const known = error instanceof WorkflowV2ReportGateError || error?.name === "WorkflowV2TrustedReportFactsError";
    return Object.freeze({
      ok: false,
      missing: Object.freeze([]),
      text: "",
      cause: "",
      measure: "",
      error: known ? error.message : "REPORT_SHORT 可信事实校验失败",
      code: known ? error.code : "WORKFLOW_V2_SHORT_REPORT_RENDER_INVALID",
    });
  }
}

function assertReportGateIdentity(gate, { label, dispatch, resultSha256, htmlRef }) {
  if (!gate || typeof gate !== "object" || Array.isArray(gate)) {
    fail(`${label} 必须是系统报告门禁对象`, "WORKFLOW_V2_REPORT_GATE_INVALID", { label });
  }
  if (!Object.isFrozen(gate)) fail(`${label} 必须是冻结门禁`, "WORKFLOW_V2_REPORT_GATE_INVALID", { label });
  if (!["PASS", "FAIL", "BLOCKED"].includes(gate.status)) {
    fail(`${label} status 无效`, "WORKFLOW_V2_REPORT_GATE_INVALID", { label });
  }
  const expected = {
    storyId: String(dispatch.context?.story?.storyId || ""),
    contextId: String(dispatch.contextId || ""),
    contextRevision: dispatch.contextRevision,
    resultSha256,
    htmlRef: htmlRef || null,
  };
  for (const [field, value] of Object.entries(expected)) {
    if (gate[field] !== value) {
      fail(`${label} 未绑定当前 structured result`, "WORKFLOW_V2_REPORT_GATE_IDENTITY_MISMATCH", { label, field });
    }
  }
  return gate.status;
}

const EXTERNAL_URL_PATTERN = /\b(?:href|src|action|poster|data-url)\s*=\s*["'](?:https?:)?\/\/|["'](?:https?|ftp|mailto):\/\//i;
const ABSOLUTE_PATH_PATTERN = /["'（(](?:[a-zA-Z]:[\\/]|\\\\[^\\/]+\\)[^"'）)]+["'）)]|file:\/\/\/[^"')\s]+/i;

function scanExpertHtml(html) {
  const issues = [];
  if (EXTERNAL_URL_PATTERN.test(html)) issues.push("外部链接");
  if (ABSOLUTE_PATH_PATTERN.test(html)) issues.push("绝对本地路径");
  return issues;
}

function missingManifestAssets(dispatch, html, reportDir) {
  const reportFacts = dispatch?.context?.data?.reportFacts;
  const assets = Array.isArray(reportFacts?.assetManifest) ? reportFacts.assetManifest : [];
  const missing = [];
  for (const asset of assets) {
    if (asset?.exists !== true || !asset?.localPath) continue;
    const abs = path.isAbsolute(String(asset.localPath))
      ? String(asset.localPath)
      : path.join(reportDir, String(asset.localPath));
    const referenced = html.includes(String(asset.localPath).replace(/\\/g, "/"));
    if (!referenced) continue;
    try {
      const stat = statSync(abs);
      if (!stat.isFile() || stat.size === 0) missing.push(String(asset.localPath));
    } catch {
      missing.push(String(asset.localPath));
    }
  }
  return missing;
}

/**
 * 专家报告渲染门禁：HTML 必须存在于冻结 outputPath、非空、无外链、无绝对
 * 路径泄露，且 assetManifest 标记 exists=true 的本地资产真实存在。
 * resultSha256 由门禁内部对 result 重新计算，调用方无法伪造绑定。
 */
export function buildReportRendererGate({
  tab,
  dispatch,
  result,
  storageApi,
} = {}) {
  const htmlRef = String(result?.htmlRef || dispatch?.context?.output?.outputPath || "");
  const resultSha256 = canonicalSha256(result);
  if (!htmlRef) fail("REPORT_EXPERT 缺少冻结 outputPath", "WORKFLOW_V2_REPORT_GATE_OUTPUT_MISSING");
  const resolved = resolveStoryDevPath(tab, storageApi, htmlRef);
  if (!resolved) fail("REPORT_EXPERT outputPath 超出 storydev 边界", "WORKFLOW_V2_REPORT_GATE_OUTPUT_INVALID");
  let html = "";
  let stat = null;
  try {
    stat = statSync(resolved.absolutePath);
    html = readFileSync(resolved.absolutePath, "utf8");
  } catch {
    return deepFreeze({
      schemaVersion: RENDERER_GATE_SCHEMA_VERSION,
      storyId: String(dispatch.context?.story?.storyId || ""),
      contextId: String(dispatch.contextId || ""),
      contextRevision: dispatch.contextRevision,
      resultSha256,
      htmlRef,
      status: "FAIL",
      reason: "专家 HTML 不存在或不可读",
    });
  }
  const reportDir = path.dirname(resolved.absolutePath);
  const contentIssues = [];
  if (!stat.isFile() || stat.size === 0) contentIssues.push("空文件");
  const scanned = scanExpertHtml(html);
  contentIssues.push(...scanned);
  const missingAssets = missingManifestAssets(dispatch, html, reportDir);
  if (missingAssets.length) contentIssues.push(`缺失资产: ${missingAssets.join(",")}`);
  return deepFreeze({
    schemaVersion: RENDERER_GATE_SCHEMA_VERSION,
    storyId: String(dispatch.context?.story?.storyId || ""),
    contextId: String(dispatch.contextId || ""),
    contextRevision: dispatch.contextRevision,
    resultSha256,
    htmlRef,
    status: contentIssues.length ? "FAIL" : "PASS",
    ...(contentIssues.length ? { reason: contentIssues.join("；") } : {}),
  });
}

function pdfCandidates(htmlPath, storageApi, tab) {
  const candidates = [];
  const htmlExt = path.extname(htmlPath);
  if (htmlExt) {
    candidates.push(htmlPath.slice(0, -htmlExt.length) + ".pdf");
    candidates.push(path.join(path.dirname(htmlPath), path.basename(htmlPath, htmlExt) + ".pdf"));
  }
  try {
    const slug = storageApi?.getStoryStoragePaths?.(tab)?.docSlug || "";
    if (slug) candidates.push(path.join(path.dirname(htmlPath), `验收报告_${slug}.pdf`));
  } catch {}
  return candidates;
}

function validatePdfFile(absPath) {
  let stat;
  try {
    stat = statSync(absPath);
  } catch {
    return { ok: false, reason: "PDF 不存在" };
  }
  if (!stat.isFile() || stat.size === 0) return { ok: false, reason: "PDF 为空文件" };
  const head = Buffer.alloc(1024);
  let fd = null;
  try {
    fd = openSync(absPath, "r");
    const read = readSync(fd, head, 0, head.length, 0);
    const prefix = head.subarray(0, Math.min(read, 8)).toString("latin1");
    if (!prefix.startsWith("%PDF-")) return { ok: false, reason: "PDF 头不合法" };
    const tail = Buffer.alloc(2048);
    const size = stat.size;
    const tailRead = readSync(fd, tail, 0, tail.length, Math.max(0, size - tail.length));
    const tailText = tail.subarray(0, tailRead).toString("latin1");
    if (!/\/Type\s*\/Pages|\/Count\s+\d/.test(tailText) && !tailText.includes("%%EOF")) {
      return { ok: false, reason: "PDF 结构不可解析" };
    }
    if (!tailText.includes("%%EOF")) return { ok: false, reason: "PDF 缺少 EOF 标记" };
  } catch {
    return { ok: false, reason: "PDF 读取失败" };
  } finally {
    try { closeSync(fd); } catch {}
  }
  return { ok: true };
}

/**
 * 专家报告 PDF 门禁：至少一个候选 PDF 非空、%PDF 头合法、含可解析结构与
 * EOF 标记；PDF 未通过前不得推进 TB 同步。
 */
export function buildReportPdfGate({
  tab,
  dispatch,
  result,
  storageApi,
} = {}) {
  const htmlRef = String(result?.htmlRef || dispatch?.context?.output?.outputPath || "");
  const resultSha256 = canonicalSha256(result);
  const resolved = resolveStoryDevPath(tab, storageApi, htmlRef);
  const candidates = resolved ? pdfCandidates(resolved.absolutePath, storageApi, tab) : [];
  const valid = candidates.map((absPath) => ({ absPath, ...validatePdfFile(absPath) }));
  const passed = valid.find((entry) => entry.ok);
  return deepFreeze({
    schemaVersion: PDF_GATE_SCHEMA_VERSION,
    storyId: String(dispatch.context?.story?.storyId || ""),
    contextId: String(dispatch.contextId || ""),
    contextRevision: dispatch.contextRevision,
    resultSha256,
    htmlRef: htmlRef || null,
    status: passed ? "PASS" : "FAIL",
    ...(passed ? {} : { reason: valid.map((entry) => `${path.basename(entry.absPath)}: ${entry.reason}`).join("；") || "PDF 不存在" }),
  });
}

export function assertReportRendererGate(gate, opts) {
  return assertReportGateIdentity(gate, { ...opts, label: "rendererGate" });
}

export function assertReportPdfGate(gate, opts) {
  return assertReportGateIdentity(gate, { ...opts, label: "pdfGate" });
}
