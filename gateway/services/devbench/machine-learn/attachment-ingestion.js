import { createHash } from "node:crypto";
import path from "node:path";

const TEXT_EXTENSIONS = new Set([
  ".txt", ".log", ".md", ".markdown", ".json", ".jsonl", ".xml", ".csv",
  ".html", ".htm", ".yaml", ".yml", ".properties", ".gradle", ".kt", ".java",
  ".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx", ".py", ".sh", ".ps1", ".bat",
]);
const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp"]);
const DOCUMENT_EXTENSIONS = new Set([".pdf", ".doc", ".docx", ".ppt", ".pptx", ".xls", ".xlsx"]);
const ARCHIVE_EXTENSIONS = new Set([".zip", ".7z", ".rar", ".tar", ".gz", ".tgz"]);

function text(value, limit = 2000) {
  return String(value ?? "").trim().slice(0, limit);
}

function attachmentName(item = {}) {
  return text(item.name || item.fileName || item.filename || item.title, 500) || "attachment";
}

function attachmentUrl(item = {}) {
  return text(item.downloadUrl || item.url, 4000);
}

function extension(name) {
  return path.extname(String(name || "")).toLowerCase();
}

function sanitizeText(buffer, maxChars) {
  // UTF-8 is the authoritative portable representation. Replacement characters are retained
  // as evidence-quality signals instead of guessing a machine-specific code page.
  return buffer.toString("utf8")
    .replace(/\u0000/g, "")
    .replace(/[\u0001-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
    .slice(0, maxChars)
    .trim();
}

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

function safeAttachmentError(error, fallback) {
  const message = String(error?.message || error || "").toLowerCase();
  if (/timeout|timed out|aborted|超时/.test(message)) return "附件读取超时";
  if (/too large|size limit|超过.*上限|content-length/.test(message)) return "附件超过推理读取大小上限";
  if (/\b(?:401|403)\b|unauthorized|forbidden|鉴权|无权限/.test(message)) return "附件读取鉴权失败";
  return fallback;
}

function baseRow(item, index) {
  const name = attachmentName(item);
  return {
    id: text(item?.id || item?._id, 200) || `attachment_${index + 1}`,
    name,
    size: Math.max(0, Number(item?.size || item?.fileSize || 0) || 0),
    extension: extension(name),
    source: text(item?.source || item?._source, 80) || "teambition",
    untrusted: true,
  };
}

/**
 * Convert bounded attachment content into untrusted inference evidence.
 * Binary documents/images are explicit about needing a parser/vision provider; they are never
 * silently treated as complete merely because metadata was available.
 */
export async function ingestConfigInferenceAttachments(items = [], {
  readBuffer,
  inspectImage,
  inspectDocument,
  maxAttachments = 20,
  maxBytesPerAttachment = 2 * 1024 * 1024,
  maxTotalBytes = 5 * 1024 * 1024,
  maxCharsPerAttachment = 30_000,
} = {}) {
  const rows = (Array.isArray(items) ? items : []).slice(0, Math.max(0, maxAttachments));
  const evidence = [];
  let totalBytes = 0;

  for (const [index, item] of rows.entries()) {
    const row = baseRow(item, index);
    const inline = text(item?.text || item?.content || item?.summary || item?.ocrText, maxCharsPerAttachment);
    if (inline) {
      evidence.push({
        ...row,
        status: "parsed",
        parser: "inline",
        text: inline,
        contentHash: text(item?.contentHash, 100),
      });
      continue;
    }
    const url = attachmentUrl(item);
    if (!url) {
      evidence.push({ ...row, status: "unavailable", error: "附件无可用下载地址" });
      continue;
    }
    if (row.size > maxBytesPerAttachment || totalBytes + row.size > maxTotalBytes) {
      evidence.push({ ...row, status: "skipped", error: "附件超过推理读取大小上限" });
      continue;
    }
    if (typeof readBuffer !== "function") {
      evidence.push({ ...row, status: "metadata_only", error: "未配置安全附件读取器" });
      continue;
    }

    let downloaded;
    const remainingBytes = Math.min(maxBytesPerAttachment, maxTotalBytes - totalBytes);
    try {
      downloaded = await readBuffer(url, { maxBytes: remainingBytes });
    } catch (error) {
      evidence.push({ ...row, status: "failed", error: safeAttachmentError(error, "附件读取失败") });
      continue;
    }
    const buffer = Buffer.isBuffer(downloaded) ? downloaded : downloaded?.buffer;
    if (!Buffer.isBuffer(buffer)) {
      evidence.push({ ...row, status: "failed", error: "附件读取器未返回 Buffer" });
      continue;
    }
    if (buffer.length > remainingBytes) {
      evidence.push({ ...row, status: "skipped", error: "附件超过推理读取大小上限" });
      continue;
    }
    totalBytes += buffer.length;
    const common = {
      ...row,
      size: buffer.length,
      contentType: text(downloaded?.contentType || item?.mimeType, 200),
      contentHash: sha256(buffer),
    };
    try {
      if (TEXT_EXTENSIONS.has(row.extension) || common.contentType.startsWith("text/")) {
        evidence.push({
          ...common,
          status: "parsed",
          parser: "utf8-text",
          text: sanitizeText(buffer, maxCharsPerAttachment),
        });
      } else if (IMAGE_EXTENSIONS.has(row.extension)) {
        if (typeof inspectImage !== "function") {
          evidence.push({ ...common, status: "needs_vision", error: "图片需要 OCR/视觉解析器" });
        } else {
          const result = await inspectImage(buffer, common);
          evidence.push({
            ...common,
            status: result?.text ? "parsed" : "failed",
            parser: text(result?.parser, 100) || "vision",
            text: text(result?.text, maxCharsPerAttachment),
            ...(result?.error ? { error: text(result.error, 1000) } : {}),
          });
        }
      } else if (DOCUMENT_EXTENSIONS.has(row.extension)) {
        if (typeof inspectDocument !== "function") {
          evidence.push({ ...common, status: "needs_document_parser", error: "文档需要受控解析器" });
        } else {
          const result = await inspectDocument(buffer, common);
          evidence.push({
            ...common,
            status: result?.text ? "parsed" : "failed",
            parser: text(result?.parser, 100) || "document",
            text: text(result?.text, maxCharsPerAttachment),
            ...(result?.error ? { error: text(result.error, 1000) } : {}),
          });
        }
      } else if (ARCHIVE_EXTENSIONS.has(row.extension)) {
        evidence.push({ ...common, status: "needs_archive_review", error: "压缩包默认不自动解压，需受控审查" });
      } else {
        evidence.push({ ...common, status: "unsupported", error: "附件类型未列入推理解析白名单" });
      }
    } catch (error) {
      evidence.push({ ...common, status: "failed", error: safeAttachmentError(error, "附件解析失败") });
    }
  }

  const parsed = evidence.filter((row) => row.status === "parsed");
  const incomplete = evidence.filter((row) => row.status !== "parsed");
  return {
    evidence,
    sourceCoverage: {
      available: rows.length === 0 || evidence.length > 0,
      complete: rows.length === evidence.length && incomplete.length === 0,
      metadataCount: rows.length,
      parsedCount: parsed.length,
      incompleteCount: incomplete.length,
      totalBytes,
      untrusted: true,
    },
  };
}
