const MIME_EXTENSION = new Map([
  ["image/jpeg", "jpg"],
  ["image/png", "png"],
  ["image/gif", "gif"],
  ["image/webp", "webp"],
  ["image/bmp", "bmp"],
  ["image/avif", "avif"],
  ["application/pdf", "pdf"],
  ["text/plain", "txt"],
]);

function fallbackClipboardName(file, index, now) {
  const extension = MIME_EXTENSION.get(String(file?.type || "").toLowerCase()) || "bin";
  return `paste_${now}_${index + 1}.${extension}`;
}

function withFallbackFileName(file, index, now, FileCtor) {
  if (String(file?.name || "").trim()) return file;
  const name = fallbackClipboardName(file, index, now);
  if (typeof FileCtor === "function") {
    return new FileCtor([file], name, {
      type: file?.type || "application/octet-stream",
      lastModified: Number(file?.lastModified) || now,
    });
  }
  return { file, name, type: file?.type || "", size: Number(file?.size) || 0 };
}

/**
 * 优先使用 ClipboardEvent.files，因为从资源管理器复制时这里最可能保留真实 File.name；
 * items 仅作为浏览器未填 files 时的兼容回退，最后才生成 paste_* 名称。
 */
export function clipboardAttachmentFiles(clipboardData, {
  now = Date.now(),
  FileCtor = globalThis.File,
} = {}) {
  const direct = Array.from(clipboardData?.files || []).filter(Boolean);
  const fromItems = Array.from(clipboardData?.items || [])
    .filter((item) => item?.kind === "file" || String(item?.type || "").startsWith("image/"))
    .map((item) => item?.getAsFile?.())
    .filter(Boolean);
  const candidates = direct.length ? direct : fromItems;
  const seen = new Set();
  const files = [];
  for (const file of candidates) {
    if (seen.has(file)) continue;
    seen.add(file);
    files.push(withFallbackFileName(file, files.length, now, FileCtor));
  }
  return files;
}

export function createAttachmentBatchId({ now = Date.now(), random = "" } = {}) {
  const suffix = String(random || "").replace(/[^a-zA-Z0-9]/g, "").slice(0, 20) || Math.random().toString(36).slice(2, 12);
  return `${now}-${suffix}`;
}

export function attachmentUploadRelativePath(batchId, sourcePath) {
  const batch = String(batchId || "").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 80) || "upload";
  const segments = String(sourcePath || "attachment.bin")
    .split(/[\\/]+/)
    .map((segment) => segment.trim())
    .filter((segment) => segment && segment !== "." && segment !== "..");
  return ["chat-attachments", batch, ...(segments.length ? segments : ["attachment.bin"])].join("/");
}

export function formatAttachmentSize(bytes) {
  const value = Number(bytes);
  if (!Number.isFinite(value) || value < 0) return "";
  if (value < 1024) return `${value} B`;
  if (value < 1024 ** 2) return `${(value / 1024).toFixed(value < 10 * 1024 ? 1 : 0)} KB`;
  if (value < 1024 ** 3) return `${(value / 1024 ** 2).toFixed(value < 10 * 1024 ** 2 ? 1 : 0)} MB`;
  return `${(value / 1024 ** 3).toFixed(1)} GB`;
}

export function normalizeStoryAttachment(value, index = 0) {
  const attachment = value && typeof value === "object" ? value : {};
  const relPath = String(attachment.relPath || attachment.reference || "").trim();
  const name = String(attachment.originalName || attachment.name || relPath.split("/").pop() || `附件 ${index + 1}`).trim();
  const fileCount = Math.max(0, Number(attachment.fileCount) || 0);
  return {
    ...attachment,
    id: String(attachment.id || `${relPath || name}:${index}`),
    name,
    originalName: String(attachment.originalName || name),
    relPath,
    kind: attachment.kind === "folder" || fileCount > 0 ? "folder" : "file",
    fileCount,
    size: Number.isFinite(Number(attachment.size)) ? Math.max(0, Number(attachment.size)) : null,
    mime: String(attachment.mime || attachment.type || ""),
    scope: String(attachment.scope || "message"),
  };
}

export function tbAttachmentDownloadKey(value, index = 0) {
  const attachment = value && typeof value === "object" ? value : {};
  return String(
    attachment.id
      || attachment.url
      || attachment.relPath
      || attachment.name
      || `tb-attachment-${index}`,
  );
}

export function setTbAttachmentDownloadPending(state, key, pending) {
  const current = state && typeof state === "object" ? state : {};
  const normalizedKey = String(key || "");
  if (!normalizedKey) return current;
  if (pending) {
    return current[normalizedKey] ? current : { ...current, [normalizedKey]: true };
  }
  if (!Object.hasOwn(current, normalizedKey)) return current;
  const next = { ...current };
  delete next[normalizedKey];
  return next;
}

export function buildStoryAttachmentPrompt(body, attachments) {
  const normalized = Array.from(attachments || []).map(normalizeStoryAttachment).filter((item) => item.relPath);
  if (!normalized.length) return String(body || "");
  const lines = normalized.map((attachment) => {
    const locations = [
      `远程：${attachment.relPath}${attachment.kind === "folder" ? "/" : ""}`,
      attachment.path ? `本地：${attachment.path}` : "",
    ].filter(Boolean).join("；");
    return attachment.kind === "folder"
      ? `- ${locations}（文件夹，含 ${attachment.fileCount} 个文件，请把整个目录作为本轮上下文）`
      : `- ${locations}（${attachment.name}${attachment.mime.startsWith("image/") || attachment.isImg ? "，图片" : ""}）`;
  });
  return [
    "## 本轮用户附件（已保存到当前故事点目录）",
    "以下附件属于本条用户消息。请按任务需要真实打开、读取或查看；不要仅凭文件名推测内容。",
    ...lines,
    "压缩包请先解压后分析；无法读取的附件必须在回复中逐项说明原因。",
    "",
    String(body || ""),
  ].join("\n");
}
