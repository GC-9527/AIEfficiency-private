const DIRECT_PROTOCOLS = new Set(["http:", "https:"]);
const ARTIFACT_PROTOCOLS = new Set(["http:", "https:"]);

const EXTENSION_KINDS = new Map([
  [".png", "image"],
  [".jpg", "image"],
  [".jpeg", "image"],
  [".gif", "image"],
  [".webp", "image"],
  [".bmp", "image"],
  [".avif", "image"],
  [".mp4", "video"],
  [".webm", "video"],
  [".mov", "video"],
  [".m4v", "video"],
  [".mp3", "audio"],
  [".wav", "audio"],
  [".m4a", "audio"],
  [".ogg", "audio"],
  [".oga", "audio"],
  [".flac", "audio"],
  [".aac", "audio"],
  [".pdf", "pdf"],
  [".txt", "text"],
  [".md", "text"],
  [".json", "text"],
  [".xml", "text"],
  [".csv", "text"],
  [".log", "text"],
]);
const FILE_EXTENSIONS = new Set([
  ".html", ".htm",
  ".zip", ".rar", ".7z", ".tar", ".gz",
  ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx",
  ".apk", ".aar", ".jar",
]);

function containsControlCharacter(value) {
  return /[\u0000-\u001f\u007f]/.test(value);
}

function parseUrl(value, baseUrl = "http://story-message.invalid") {
  try {
    return new URL(value, baseUrl);
  } catch {
    return null;
  }
}

function normalizeDirectUrl(value) {
  const raw = String(value || "").trim();
  if (!raw || containsControlCharacter(raw) || raw.includes("\\")) return "";
  // 只放行规范 http/https 直达链接。mailto 一律拒绝：内部工具禁止唤起系统邮箱
  // 客户端（remark-gfm autolink 与显式 mailto 链接此前都会触发“一直打开邮箱”）。
  if (!/^https?:\/\//i.test(raw)) return "";
  const parsed = parseUrl(raw);
  if (!parsed || !DIRECT_PROTOCOLS.has(parsed.protocol)) return "";
  if ((parsed.protocol === "http:" || parsed.protocol === "https:") && !parsed.hostname) return "";
  return parsed.href;
}

export function isStoryArtifactRef(value) {
  const ref = String(value || "").trim();
  if (!/^storydev:\/(?!\/)/i.test(ref) || containsControlCharacter(ref) || ref.includes("\\")) return false;
  const path = ref.slice(ref.indexOf("/") + 1);
  if (!path) return false;
  const segments = path.split("/");
  return segments.every((segment) => {
    if (!segment) return true;
    let decoded = segment;
    try { decoded = decodeURIComponent(segment); } catch {}
    return decoded !== "." && decoded !== ".." && !decoded.includes("\\") && !containsControlCharacter(decoded);
  });
}

export function isSafeResolvedStoryMessageUrl(value, { allowRelativeArtifact = true } = {}) {
  const url = String(value || "").trim();
  if (!url || containsControlCharacter(url)) return false;
  if (allowRelativeArtifact && /^\/api\/devbench\/tabs\/[^/?#]+\/artifact(?:[?#]|$)/.test(url)) return true;
  return !!normalizeDirectUrl(url);
}

export function hasStoryExternalBridge(windowObject = globalThis.window) {
  return typeof windowObject?.electronAPI?.cardev?.openExternal === "function";
}

function isSafeArtifactUrl(value) {
  const url = String(value || "").trim();
  if (!url || containsControlCharacter(url) || url.includes("\\")) return false;
  if (/^\/api\/devbench\/tabs\/[^/?#]+\/artifact(?:[?#]|$)/.test(url)) return true;
  if (!/^https?:\/\//i.test(url)) return false;
  const parsed = parseUrl(url);
  if (!parsed || !ARTIFACT_PROTOCOLS.has(parsed.protocol) || !parsed.hostname) return false;
  return /^\/api\/devbench\/tabs\/[^/?#]+\/artifact$/.test(parsed.pathname);
}

export function resolveStoryMessageUrl(rawUrl, { tabId, artifactUrl } = {}) {
  const raw = String(rawUrl || "").trim();
  if (!raw || containsControlCharacter(raw)) return "";

  if (/^storydev:/i.test(raw)) {
    if (!tabId || typeof artifactUrl !== "function" || !isStoryArtifactRef(raw)) return "";
    const normalizedRef = `storydev:${raw.slice(raw.indexOf(":") + 1)}`;
    let resolved = "";
    try { resolved = String(artifactUrl(tabId, normalizedRef) || "").trim(); } catch { return ""; }
    return isSafeArtifactUrl(resolved) ? resolved : "";
  }

  return normalizeDirectUrl(raw);
}

function artifactRefFromUrl(value) {
  const raw = String(value || "").trim();
  if (isStoryArtifactRef(raw)) return raw;
  const parsed = parseUrl(raw);
  if (!parsed) return "";
  const ref = parsed.searchParams.get("ref") || "";
  return isStoryArtifactRef(ref) ? ref : "";
}

export function storyMessageArtifactRef(value) {
  return artifactRefFromUrl(value);
}

function extensionOf(value) {
  const ref = artifactRefFromUrl(value);
  const source = ref || String(value || "");
  const withoutSuffix = source.split(/[?#]/, 1)[0];
  const name = withoutSuffix.slice(withoutSuffix.lastIndexOf("/") + 1);
  const index = name.lastIndexOf(".");
  return index >= 0 ? name.slice(index).toLowerCase() : "";
}

export function classifyStoryMessageUrl(value) {
  const extension = extensionOf(value);
  const mediaKind = EXTENSION_KINDS.get(extension);
  if (mediaKind) return mediaKind;
  if (artifactRefFromUrl(value) || FILE_EXTENSIONS.has(extension)) return "file";
  return "link";
}

export function storyMessageFileName(value) {
  const ref = artifactRefFromUrl(value);
  const source = ref || String(value || "");
  const withoutSuffix = source.split(/[?#]/, 1)[0];
  const encoded = withoutSuffix.slice(withoutSuffix.lastIndexOf("/") + 1);
  if (!encoded) return "文件";
  try { return decodeURIComponent(encoded); } catch { return encoded; }
}

const STORY_ARTIFACT_PATTERN = /storydev:\/(?!\/)[^\s<>"'`\])}]+/giu;

export const STORY_MESSAGE_MARKDOWN_MAX_CHARS = 64 * 1024;
export const STORY_MESSAGE_PREVIEW_CHARS = 4_000;

export function planStoryMessageRender(content, { expanded = false } = {}) {
  const value = String(content || "");
  const oversized = value.length > STORY_MESSAGE_MARKDOWN_MAX_CHARS;
  if (!oversized) {
    return { mode: "markdown", oversized: false, content: value, totalChars: value.length };
  }
  if (expanded) {
    return { mode: "plain", oversized: true, content: value, totalChars: value.length };
  }
  const preview = value.slice(0, STORY_MESSAGE_PREVIEW_CHARS);
  return {
    mode: "preview",
    oversized: true,
    content: `${preview}${value.length > preview.length ? "\n…（超大内容已延迟加载）" : ""}`,
    totalChars: value.length,
  };
}

export function extractStoryArtifactRefs(content, limit = 20) {
  const result = [];
  const seen = new Set();
  for (const match of String(content || "").matchAll(STORY_ARTIFACT_PATTERN)) {
    const value = String(match[0] || "").replace(/[.,;:!?，。；：！？]+$/u, "");
    if (!isStoryArtifactRef(value) || seen.has(value)) continue;
    seen.add(value);
    result.push(value);
    if (result.length >= limit) break;
  }
  return result;
}

// Markdown 链接会直接由富媒体渲染器处理；这里只补抓 AI 正文中的裸 storydev:/ 引用，
// 避免模型偶尔漏写 [名称](引用) 时，用户失去预览和下载入口。
export function extractBareStoryArtifactRefs(content, limit = 20) {
  const text = String(content || "");
  const result = [];
  const seen = new Set();
  for (const match of text.matchAll(STORY_ARTIFACT_PATTERN)) {
    const before = text.slice(Math.max(0, match.index - 2), match.index);
    if (before === "](" || before.endsWith("`")) continue;
    const value = String(match[0] || "").replace(/[.,;:!?，。；：！？]+$/u, "");
    const key = value.toLowerCase();
    if (!isStoryArtifactRef(value) || seen.has(key)) continue;
    seen.add(key);
    result.push(value);
    if (result.length >= limit) break;
  }
  return result;
}
