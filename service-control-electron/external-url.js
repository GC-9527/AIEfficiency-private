"use strict";

const ALLOWED_EXTERNAL_PROTOCOLS = new Set(["http:", "https:"]);

function normalizeExternalUrl(value) {
  const raw = String(value || "").trim();
  if (!raw || /[\u0000-\u001f\u007f\\]/.test(raw)) return "";
  // 只放行规范 http/https。mailto 一律拒绝：内部工具禁止唤起系统邮箱客户端（“一直打开邮箱”），
  // 即使点击显式 mailto 链接也不得打开本机邮件应用。
  if (!/^https?:\/\//i.test(raw)) return "";
  try {
    const parsed = new URL(raw);
    if (!ALLOWED_EXTERNAL_PROTOCOLS.has(parsed.protocol)) return "";
    if (!parsed.hostname) return "";
    return parsed.href;
  } catch {
    return "";
  }
}

module.exports = { normalizeExternalUrl };
