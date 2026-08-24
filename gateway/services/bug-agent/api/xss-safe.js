/**
 * 服务端 XSS 辅助（方案 §10.6.1）
 *
 * 说明：最终 HTML/Markdown 渲染在前端（Chat.jsx）用 DOMPurify + markdown-it
 *       完成。服务端的职责是：
 *   1. 对报告正文做 "纯文本化" 规范（去除所有 HTML 标签字面量，保留 Markdown 记号）
 *   2. 校验 <a href="..."> 类用户提交 URL 的 scheme 白名单
 *   3. 提供 `escapeHtml` 给日志、告警、邮件等非富文本通道使用
 */

const HTML_ESCAPE_MAP = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

export function escapeHtml(s) {
  if (s == null) return "";
  return String(s).replace(/[&<>"']/g, (c) => HTML_ESCAPE_MAP[c]);
}

/**
 * 允许的 URL scheme（安全）。
 * 方案 §10.6.1：`a[href]` 限制 `http/https/feishu`，禁用 `javascript:`。
 * mailto 不在此列：内部工具禁止渲染出可点击邮箱链接，避免唤起本机邮件客户端（“一直打开邮箱”）。
 */
const SAFE_SCHEMES = new Set(["http:", "https:", "feishu:", "lark:"]);

/**
 * 校验单个 URL 是否安全。
 *
 * @param {string} url
 * @returns {{ safe: boolean, reason?: string, normalized?: string }}
 */
export function isSafeUrl(url) {
  if (typeof url !== "string" || !url) return { safe: false, reason: "EMPTY" };
  const trimmed = url.trim();
  // 拦截 data: / javascript: / vbscript: / file: 等
  if (/^(javascript|data|vbscript|file):/i.test(trimmed)) {
    return { safe: false, reason: "UNSAFE_SCHEME" };
  }
  try {
    // 支持相对路径
    if (trimmed.startsWith("/") || trimmed.startsWith("./") || trimmed.startsWith("../")) {
      return { safe: true, normalized: trimmed };
    }
    const parsed = new URL(trimmed);
    if (!SAFE_SCHEMES.has(parsed.protocol)) return { safe: false, reason: "UNSAFE_SCHEME" };
    return { safe: true, normalized: parsed.toString() };
  } catch {
    return { safe: false, reason: "INVALID_URL" };
  }
}

/**
 * 把证据 text_snapshot 等用户/日志原文做"纯文本化"：
 *  - HTML 实体转义（防止 `<script>` 字面量被前端意外渲染为真实标签）
 *  - 不处理 Markdown 记号（前端 markdown-it 渲染）
 *  - 保留换行
 *
 * 这是给 `reports.content` 嵌入 `text_snapshot` 片段时使用的规范化。
 */
export function textifyForReport(raw) {
  if (raw == null) return "";
  return escapeHtml(String(raw));
}

/**
 * CSP 响应头（默认值，供服务器挂载到报告/下载路由）。
 * 方案 §10.6.1: `default-src 'self'; script-src 'self' 'nonce-<random>'`
 */
export function defaultCSPHeader(nonce) {
  const parts = [
    "default-src 'self'",
    `script-src 'self'${nonce ? " 'nonce-" + nonce + "'" : ""}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "frame-ancestors 'none'",
  ];
  return parts.join("; ");
}
