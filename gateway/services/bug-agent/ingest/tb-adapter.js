/**
 * TB 任务 → Bug Agent 输入格式 适配器（单向只读）
 *
 * 设计原则：
 *   - 纯函数 + 依赖注入：便于单元测试，不直接依赖 gateway db/fs
 *   - 只读：绝不修改 tb_task_records 或 TB 任务状态
 *   - 失败降级：附件读取失败 → 返回空字段 + 警告，不阻塞
 */

import fs from "node:fs";
import path from "node:path";

// ---------- package_name 抽取 ----------

// Android 包名：至少 3 段，全小写字母/数字/下划线
const PKG_REGEX = /\b([a-z][a-z0-9_]{1,}(?:\.[a-z][a-z0-9_]{1,}){2,})\b/g;

// 这些是常见的误匹配（Java 标准库 / Android Framework / 通用域名）—— 排除
// 现实数据：CARB-11451 把 com.android.server.wm 误识为应用包名 → 加 framework 系列
const PKG_BLACKLIST = new Set([
  // Java 标准库
  "java.lang", "java.util", "java.io", "java.net", "java.nio", "java.text",
  // Kotlin
  "kotlin.jvm", "kotlin.coroutines", "kotlinx.coroutines",
  // Android Framework / SystemService（不是应用包）
  "android.util", "android.os", "android.app", "android.content", "android.view",
  "android.widget", "android.media", "android.graphics", "android.hardware",
  "android.net", "android.provider", "android.support", "androidx.",
  "com.android.server", "com.android.systemui", "com.android.internal",
  "com.android.framework",
  // 第三方常见库
  "com.google.common", "com.google.protobuf", "com.google.gson",
  "org.apache.http", "org.json", "io.reactivex", "okhttp3", "retrofit2",
]);

// Android system property key 前缀（getprop / setprop 的 key，不是 Android 包名）
// 现实数据：CARB-10070 把 persist.sys.hw_mc.carsecurity.devexist 误识为应用包名
const SYS_PROPERTY_PREFIX = /^(persist|ro|sys|setprop|debug|net|service|init|vendor|dalvik|hw|product|build)\./i;

function isBlacklisted(pkg) {
  if (SYS_PROPERTY_PREFIX.test(pkg)) return true;
  for (const b of PKG_BLACKLIST) if (pkg.startsWith(b)) return true;
  return false;
}

/**
 * 从任意文本中抽取最可能的 Android package_name。
 * 优先级：
 *   1. 频次最高且非黑名单
 *   2. 长度最长（更具辨识度）
 *   3. 首次出现
 *
 * @param {string} text
 * @returns {string|null}
 */
export function extractPackageName(text) {
  if (!text || typeof text !== "string") return null;
  const counts = new Map();
  const firstPos = new Map();
  let m;
  PKG_REGEX.lastIndex = 0;
  while ((m = PKG_REGEX.exec(text)) !== null) {
    const pkg = m[1];
    if (isBlacklisted(pkg)) continue;
    counts.set(pkg, (counts.get(pkg) || 0) + 1);
    if (!firstPos.has(pkg)) firstPos.set(pkg, m.index);
  }
  if (counts.size === 0) return null;

  const candidates = [...counts.entries()]
    .sort((a, b) => {
      if (b[1] !== a[1]) return b[1] - a[1];              // 频次
      if (b[0].length !== a[0].length) return b[0].length - a[0].length; // 长度
      return firstPos.get(a[0]) - firstPos.get(b[0]);      // 首次位置
    });
  return candidates[0][0];
}

// ---------- 附件读取 ----------

const LOG_EXT = /\.(log|txt|anr|dump|logcat|trace|json|xml|csv|prop|conf|bugreport)$/i;
// 单附件 / 总合并的"读入 text_snapshot"上限。
// 注意：这是给 LLM Prompt 用的截断阈值，不是下载上限（tb-fetcher 控制下载）。
// 原始大文件**完整**保存在 tmp/ 与 archive/ 中，用户可通过证据下载短链拿原文。
function singleAttachmentBytes() {
  const kb = Number(process.env.BUG_AGENT_LLM_PER_ATTACHMENT_KB);
  return Number.isFinite(kb) && kb > 0 ? kb * 1024 : 1024 * 1024; // 默认 1 MB
}
function totalAttachmentBytes() {
  const kb = Number(process.env.BUG_AGENT_LLM_TOTAL_LOG_KB);
  return Number.isFinite(kb) && kb > 0 ? kb * 1024 : 4 * 1024 * 1024; // 默认 4 MB
}

/**
 * 在指定目录下找日志附件并读取内容。
 * 仅提供给 transformTbRecord 使用，可通过 _deps 替换。
 *
 * @param {string} dir - 附件目录（通常是 ${local_dir}/attachments）
 * @returns {{ files: Array<{name,size,excerpt}>, combined: string }}
 */
export function readLogAttachmentsFromDir(dir) {
  if (!dir || !fs.existsSync(dir)) return { files: [], combined: "" };

  const entries = [];
  try {
    const items = fs.readdirSync(dir);
    for (const name of items) {
      if (!LOG_EXT.test(name)) continue;
      const full = path.join(dir, name);
      let stat;
      try { stat = fs.statSync(full); } catch { continue; }
      if (!stat.isFile() || stat.size === 0) continue;
      entries.push({ name, full, size: stat.size });
    }
  } catch { return { files: [], combined: "" }; }

  // 按大小排序，小的优先（便于摘要）
  entries.sort((a, b) => a.size - b.size);

  const SINGLE_LIMIT = singleAttachmentBytes();
  const TOTAL_LIMIT = totalAttachmentBytes();
  let totalBytes = 0;
  const files = [];
  const parts = [];
  for (const e of entries) {
    if (totalBytes >= TOTAL_LIMIT) break;
    const readBytes = Math.min(e.size, SINGLE_LIMIT, TOTAL_LIMIT - totalBytes);
    let content = "";
    try {
      const buf = fs.readFileSync(e.full);
      content = buf.slice(0, readBytes).toString("utf-8");
    } catch { continue; }
    files.push({ name: e.name, size: e.size, truncated: e.size > readBytes });
    parts.push(`========== ${e.name} (${e.size} bytes${e.size > readBytes ? ", truncated" : ""}) ==========\n${content}`);
    totalBytes += readBytes;
  }
  return { files, combined: parts.join("\n\n") };
}

// ---------- 主转换 ----------

/**
 * 把 tb_task_records 的一行 + 附件目录 → Bug Agent analyze 的 body。
 *
 * @param {Object} record - tb_task_records 行（字段见 db/sqlite.js schema）
 * @param {Object} [opts]
 * @param {Function} [opts.readAttachments] - 测试注入点，默认用 readLogAttachmentsFromDir
 * @returns {{
 *   tb_id: string,
 *   package_name: string|null,
 *   title: string,
 *   raw_content: string,
 *   log_attachment: string,
 *   reporter_id: string|null,
 *   _meta: { attachments: Array, warnings: Array }
 * }}
 */
export function transformTbRecordToInput(record, opts = {}) {
  if (!record || typeof record !== "object") {
    throw new Error("invalid tb_task_record");
  }
  const readAttachments = opts.readAttachments || readLogAttachmentsFromDir;
  const warnings = [];

  const tb_id = String(record.carb_id || record.id || "").trim();
  const title = String(record.title || "").trim() || `(TB ${tb_id})`;

  // raw_content：拼接 TB 描述 + 分析摘要 + 附件元信息（来自 attachments_json）
  const parts = [];
  if (record.description || record.note || record.content) {
    parts.push(String(record.description || record.note || record.content));
  }
  if (record.analysis_summary) {
    parts.push(`\n【历史 AI 摘要】\n${record.analysis_summary}`);
  }
  try {
    if (record.attachments_json) {
      const atts = JSON.parse(record.attachments_json);
      if (Array.isArray(atts) && atts.length > 0) {
        const lines = atts.map((a) => `- ${a.filename || a.name || "?"} (${a.size || "?"}B)${a.downloadFailed ? " [下载失败]" : ""}`);
        parts.push(`\n【附件清单】\n${lines.join("\n")}`);
      }
    }
  } catch { warnings.push("attachments_json parse failed"); }
  const raw_content = parts.filter(Boolean).join("\n\n").trim() || "(TB 任务无文本描述)";

  // log_attachment：从 local_dir/attachments/ 读日志文本文件
  let log_attachment = "";
  let attachmentsMeta = [];
  if (record.local_dir) {
    const dir = path.join(record.local_dir, "attachments");
    try {
      const r = readAttachments(dir);
      log_attachment = r.combined;
      attachmentsMeta = r.files;
      if (r.files.length === 0) warnings.push(`no log attachments found under ${dir}`);
    } catch (e) {
      warnings.push(`read attachments failed: ${e.message}`);
    }
  } else {
    warnings.push("record.local_dir missing");
  }

  // package_name：在 title / raw_content / 附件内容里找
  const hay = [title, raw_content, log_attachment].filter(Boolean).join("\n");
  const package_name = extractPackageName(hay);
  if (!package_name) warnings.push("package_name not detected; user must fill manually");

  return {
    tb_id,
    package_name,
    title,
    raw_content,
    log_attachment,
    reporter_id: record.executor_id || null,
    _meta: { attachments: attachmentsMeta, warnings },
  };
}
