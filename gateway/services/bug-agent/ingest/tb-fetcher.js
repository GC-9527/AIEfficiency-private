/**
 * 实时按 TB 单号 / ObjectId 从 Teambition 平台拉取（不依赖本地 tb_task_records）
 *
 * 流程：
 *   1. searchTask(query) → 拿 task object（接受 CARB-12345 / 纯数字 / ObjectId）
 *   2. 并行拉 detail / comments / attachments 元信息
 *   3. 下载附件（仅日志类）到 knowledge/tmp/tb-import/<carbId>/attachments/
 *   4. 合成 record-like 对象 → 复用 transformTbRecordToInput
 *
 * 不写入 tb_task_records 表（那是 watcher 的领域）。
 * 临时目录由 cron 清理（24h 未分析则删除）。
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  searchTask, getTaskDetail, getTaskComments,
  getTaskAttachments, downloadAttachment,
} from "../../teambition.js";

import { transformTbRecordToInput } from "./tb-adapter.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const GATEWAY_ROOT = path.resolve(__dirname, "../../..");

const TMP_TTL_MS = 24 * 60 * 60 * 1000;       // 24 小时
const ALLOWED_LOG_EXT = /\.(log|txt|anr|dump|logcat|trace|json|xml|csv|prop|conf|bugreport)$/i;
// 单附件下载上限（默认 100 MB，覆盖 logcat/bugreport/systrace 常见尺寸）
// 可通过 BUG_AGENT_TB_MAX_ATTACHMENT_MB 调整；设为 0 表示不限大小（慎用）
function maxDownloadBytes() {
  const mb = Number(process.env.BUG_AGENT_TB_MAX_ATTACHMENT_MB);
  if (Number.isFinite(mb) && mb >= 0) return mb === 0 ? Infinity : mb * 1024 * 1024;
  return 100 * 1024 * 1024;
}

function tmpRoot() {
  return process.env.BUG_AGENT_DB_ROOT
    ? path.join(process.env.BUG_AGENT_DB_ROOT, "tmp", "tb-import")
    : path.join(GATEWAY_ROOT, "knowledge", "tmp", "tb-import");
}

function safeFilename(name) {
  return String(name || "att").replace(/[\\/:*?"<>|]/g, "_").slice(0, 200);
}

function buildCarbId(task) {
  if (task.uniqueId) return `CARB-${task.uniqueId}`;
  const m = (task.content || task.title || "").match(/CARB-\d+/);
  return m ? m[0] : null;
}

function commentsToText(comments) {
  if (!Array.isArray(comments)) return "";
  return comments
    .map((c, i) => {
      const author = c.creator?.name || c.creatorName || c.creatorId || "anon";
      const time = c.created || c.createdAt || "";
      const text = String(c.content || "").replace(/<[^>]+>/g, "").trim();
      return text ? `[${i + 1}] ${author} ${time}\n${text}` : "";
    })
    .filter(Boolean)
    .join("\n\n");
}

/**
 * 主入口：按 TB 单号实时拉取并转换为 bug-agent 输入格式。
 *
 * @param {string} query - "CARB-12345" / "12345" / 24-hex ObjectId
 * @param {Object} [opts]
 * @param {Object} [opts._deps] - 测试注入 { searchTask, getTaskDetail, getTaskComments,
 *                                            getTaskAttachments, downloadAttachment }
 * @param {boolean} [opts.skipDownload=false] - 跳过附件下载（仅取 metadata）
 * @returns {Promise<Object>} —— transformTbRecordToInput 的输出
 */
export async function fetchTbTaskById(query, opts = {}) {
  if (!query || typeof query !== "string" || !query.trim()) {
    const e = new Error("query required"); e.code = "BAD_QUERY"; throw e;
  }

  const d = opts._deps || {};
  const _searchTask = d.searchTask || searchTask;
  const _getDetail = d.getTaskDetail || getTaskDetail;
  const _getComments = d.getTaskComments || getTaskComments;
  const _getAttachments = d.getTaskAttachments || getTaskAttachments;
  const _download = d.downloadAttachment || downloadAttachment;

  // 1. 找 task
  const task = await _searchTask(query.trim());
  if (!task) {
    const e = new Error(`TB task not found: ${query}`);
    e.code = "TB_NOT_FOUND";
    throw e;
  }

  const taskId = task._id || task.id;
  const carbId = buildCarbId(task) || taskId;

  // 2. 并行拉 detail / comments / attachments
  let detail = task, comments = [], attachments = [];
  await Promise.allSettled([
    _getDetail(taskId).then((d) => { detail = d || task; }).catch(() => {}),
    _getComments(taskId).then((c) => { comments = c || []; }).catch(() => {}),
    _getAttachments(taskId).then((a) => { attachments = a || []; }).catch(() => {}),
  ]);

  // 3. 下载附件
  const tmpDir = path.join(tmpRoot(), safeFilename(carbId));
  const attachmentsDir = path.join(tmpDir, "attachments");
  if (!opts.skipDownload) {
    fs.mkdirSync(attachmentsDir, { recursive: true });
  }

  const attachmentsMeta = [];
  if (!opts.skipDownload) {
    for (const att of attachments) {
      const filename = safeFilename(att.fileName || att.filename || att.name);
      const url = att.downloadUrl || att.url;
      const size = Number(att.fileSize || att.size || 0);
      if (!url) {
        attachmentsMeta.push({ filename, size, downloadFailed: true, reason: "no_url" });
        continue;
      }
      // 仅下载日志类（避免下视频/zip 浪费带宽）
      if (!ALLOWED_LOG_EXT.test(filename)) {
        attachmentsMeta.push({ filename, size, skipped: true, reason: "non_log_ext" });
        continue;
      }
      const limit = maxDownloadBytes();
      if (size > limit) {
        attachmentsMeta.push({
          filename, size, skipped: true, reason: "too_large",
          limit_mb: Math.round(limit / 1024 / 1024),
        });
        continue;
      }
      const dest = path.join(attachmentsDir, filename);
      try {
        const downloaded = await _download(url, dest);
        attachmentsMeta.push({ filename, size: downloaded || size, downloadFailed: false });
      } catch (e) {
        attachmentsMeta.push({ filename, size, downloadFailed: true, error: e.message });
      }
    }
  }

  // 4. 合成 record-like 对象
  const noteOrContent = detail.note || detail.description || "";
  const commentsText = commentsToText(comments);
  const description = [
    noteOrContent,
    commentsText && `\n【任务评论】\n${commentsText}`,
  ].filter(Boolean).join("\n\n").trim();

  const recordLike = {
    id: taskId,
    carb_id: carbId,
    title: detail.content || detail.title || `(TB ${carbId})`,
    description,
    local_dir: tmpDir,                              // transformTbRecordToInput 会去 ${local_dir}/attachments 读
    executor_id: detail.executorId || detail.executor_id || task.executorId,
    attachments_json: JSON.stringify(attachmentsMeta),
  };

  const result = transformTbRecordToInput(recordLike);
  result._meta.fetched_at = new Date().toISOString();
  result._meta.tb_task_id = taskId;
  result._meta.tmp_dir = tmpDir;
  result._meta.attachments_total = attachments.length;
  result._meta.attachments_downloaded = attachmentsMeta.filter((a) => !a.skipped && !a.downloadFailed).length;
  return result;
}

/**
 * 清理过期临时目录（cron 调用）
 */
export function cleanupTbImportTmp({ now = Date.now() } = {}) {
  const root = tmpRoot();
  if (!fs.existsSync(root)) return { deleted: 0 };
  let deleted = 0;
  for (const entry of fs.readdirSync(root)) {
    const dir = path.join(root, entry);
    let stat;
    try { stat = fs.statSync(dir); } catch { continue; }
    if (!stat.isDirectory()) continue;
    if (now - stat.mtimeMs > TMP_TTL_MS) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
        deleted++;
      } catch { /* skip */ }
    }
  }
  return { deleted };
}
