import { Router } from "express";
import { randomUUID } from "crypto";
import { listTbTaskRecords, getTbTaskRecord, updateTbTaskRecord, upsertTbTaskRecord, deleteTbTaskRecord } from "../db/sqlite.js";
import { syncAndAnalyze, analyzeSpecificTask } from "../services/tb-task-watcher.js";
import { analyzeTbTask } from "../services/tb-task-analyzer.js";
import { postTaskComment, getUserInfo, checkTbCookie, getTaskComments, getTaskStatusName, getTaskAttachments, getTaskDetail } from "../services/teambition.js";
import { extractTbCookie, cancelTbLogin, getTbLoginStatus } from "../services/tb-cookie-extractor.js";
import { canUseLocalGuiBrowser, verifyAndSaveTbCookie } from "../services/tb-browser-shared.js";
import { readFileSync, existsSync, rmSync } from "fs";
import { join } from "path";
import { exec } from "child_process";
import { log, broadcastAll } from "../services/logger.js";
import { requireAdmin } from "../services/admin-auth.js";
import {
  beginTbLoginChallenge,
  cancelTbLoginChallenge,
  completeTbLoginChallenge,
  discardTbLoginChallenge,
} from "../services/tb-login-challenge.js";
import { tbTasksWriteRequiresAdmin } from "../services/tb-user-access-policy.js";

// 广播 TB 任务状态变更
function broadcastTbTaskUpdate(record) {
  broadcastAll(JSON.stringify({ type: "tb_task_update", data: record }));
}

const router = Router();

// TB 扫码是普通用户登录能力，不是管理员登录。其它写操作（包括手工
// Cookie 覆盖）继续要求管理员身份；取消操作由一次性登录 challenge 授权。
router.use((req, res, next) => {
  if (!tbTasksWriteRequiresAdmin(req.method, req.path)) return next();
  return requireAdmin(req, res, next);
});

// 任务记录列表
router.get("/", (req, res) => {
  const { status, limit } = req.query;
  const records = listTbTaskRecords({ status, limit: limit ? parseInt(limit) : 50 }).map(r => {
    if (r.attachments_json) {
      try { r.attachments = JSON.parse(r.attachments_json); } catch {}
    }
    delete r.attachments_json;
    return r;
  });
  res.json({ success: true, data: records });
});

// 手动触发全量同步扫描
router.post("/sync", async (req, res) => {
  broadcastTbTaskUpdate({ status: "syncing", message: "正在扫描 TB 任务..." });
  res.json({ success: true, data: { message: "扫描已触发" } });
  syncAndAnalyze()
    .then(result => broadcastTbTaskUpdate({ status: "sync_done", ...result }))
    .catch(err => {
      broadcastTbTaskUpdate({ status: "sync_failed", error: err.message });
      log("system", "error", "tb-tasks", `同步失败: ${err.message}`);
    });
});

// 指定任务 ID 分析（立即创建记录 → 异步执行 → WS 推送状态）
router.post("/analyze", async (req, res) => {
  const { taskId } = req.body;
  if (!taskId) return res.status(400).json({ success: false, error: "缺少 taskId" });

  // 立即创建本地记录，让前端能马上看到
  const recordId = taskId.startsWith("CARB-") ? `pending_${randomUUID().slice(0, 8)}` : taskId;
  const record = {
    id: recordId,
    carbId: taskId.startsWith("CARB-") ? taskId : null,
    title: taskId,
    status: "pending",
    detectedAt: new Date().toISOString(),
  };
  upsertTbTaskRecord(record);
  broadcastTbTaskUpdate({ ...record, status: "pending" });

  res.json({ success: true, data: { id: recordId, message: `任务已创建: ${taskId}` } });

  // 异步执行，每个阶段广播状态
  (async () => {
    try {
      broadcastTbTaskUpdate({ id: recordId, status: "searching", message: "正在从 TB 搜索任务..." });
      const result = await analyzeSpecificTask(taskId);
      // 通知前端删除临时 pending 记录（已被 analyzeSpecificTask 替换为真实记录）
      if (recordId.startsWith("pending_") && result?.id && result.id !== recordId) {
        broadcastTbTaskUpdate({ id: recordId, status: "deleted" });
      }
      // 分析完成后用真实 ID 更新
      const finalRecord = getTbTaskRecord(result?.id || recordId);
      if (finalRecord) broadcastTbTaskUpdate(finalRecord);
    } catch (err) {
      updateTbTaskRecord(recordId, { status: "failed", errorMessage: err.message });
      broadcastTbTaskUpdate({ id: recordId, status: "failed", error_message: err.message });
      log("system", "error", "tb-tasks", `分析失败 ${taskId}: ${err.message}`);
    }
  })();
});

// 重新分析
router.post("/:id/reanalyze", async (req, res) => {
  const record = getTbTaskRecord(req.params.id);
  if (!record) return res.status(404).json({ success: false, error: "记录不存在" });

  updateTbTaskRecord(record.id, { status: "pending", errorMessage: "" });
  broadcastTbTaskUpdate({ id: record.id, status: "pending" });
  res.json({ success: true, data: { message: "重新分析已触发" } });
  analyzeTbTask(record.id)
    .then(() => {
      const updated = getTbTaskRecord(record.id);
      if (updated) broadcastTbTaskUpdate(updated);
    })
    .catch(err => {
      broadcastTbTaskUpdate({ id: record.id, status: "failed", error_message: err.message });
      log("system", "error", "tb-tasks", `重新分析失败: ${err.message}`);
    });
});

// 手动确认发送评论
router.post("/:id/confirm", async (req, res) => {
  const record = getTbTaskRecord(req.params.id);
  if (!record) return res.status(404).json({ success: false, error: "记录不存在" });
  if (record.comment_posted) return res.json({ success: true, data: { message: "评论已发送过" } });
  if (!record.analysis_summary) return res.status(400).json({ success: false, error: "尚未分析完成" });

  try {
    const [creator, executor] = await Promise.all([
      getUserInfo(record.creator_id),
      getUserInfo(record.executor_id),
    ]);
    const mentions = [];
    if (creator?.name) mentions.push(`@${creator.name}`);
    if (executor?.name && executor.name !== creator?.name) mentions.push(`@${executor.name}`);

    // 清理本地路径
    const clean = record.analysis_summary
      .replace(/[A-Z]:[\\\/][\w\\\/.\-~]+/gi, "")
      .replace(/\/(?:home|tmp|Users)\/[\w\/.\-~]+/g, "")
      .replace(/本地目录[：:]\s*\S+/g, "");
    const comment = `📊 AI 分析结论\n\n${clean}\n\n---\n🤖 此分析由 AI 自动整理`;
    await postTaskComment(record.id, comment);
    updateTbTaskRecord(record.id, { commentPosted: 1 });
    res.json({ success: true, data: { message: "评论已发送" } });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 删除任务记录（含本地文件清理）
router.delete("/:id", (req, res) => {
  const record = getTbTaskRecord(req.params.id);
  if (!record) return res.status(404).json({ success: false, error: "记录不存在" });
  // 清理本地分析目录
  if (record.local_dir) {
    try { rmSync(record.local_dir, { recursive: true, force: true }); } catch {}
  }
  deleteTbTaskRecord(req.params.id);
  broadcastTbTaskUpdate({ id: record.id, status: "deleted" });
  res.json({ success: true, data: { message: "已删除" } });
});

// 导出问题单数据：记录 + TB 状态（已开始/未开始）+ 评论列表 + 附件 URL
router.get("/:id/export-data", async (req, res) => {
  const record = getTbTaskRecord(req.params.id);
  if (!record) return res.status(404).json({ success: false, error: "记录不存在" });
  const tbTaskId = String(record.id || "").trim();
  let statusName = null;
  let comments = [];
  let attachmentUrls = [];
  let uniqueId = null;
  let dueDate = null;
  try {
    if (tbTaskId) {
      const st = await getTaskStatusName(tbTaskId);
      if (st?.ok) statusName = st.statusName || null;
      // TB 单唯一数字 ID + 到期日期
      try {
        const detail = await getTaskDetail(tbTaskId);
        if (detail?.uniqueId) uniqueId = String(detail.uniqueId);
        if (detail?.dueDate) dueDate = String(detail.dueDate);
      } catch (e) {
        log("system", "debug", "tb-tasks", `uniqueId 获取失败 ${record.carb_id || record.id}: ${e.message}`);
      }
      const cm = await getTaskComments(tbTaskId);
      // getTaskComments 返回评论数组（result.items），非 {items} 包装
      comments = Array.isArray(cm) ? cm : [];
      // 附件 URL：TB 下载直链（awos/download/file/{fileId}?token=...）
      try {
        const atts = await getTaskAttachments(tbTaskId);
        attachmentUrls = (Array.isArray(atts) ? atts : []).map(a => ({
          name: a.fileName || a.name || "",
          size: a.fileSize || a.size || 0,
          url: a.downloadUrl || a.url || "",
          previewUrl: a.previewUrl || "",
        }));
      } catch (e) {
        log("system", "debug", "tb-tasks", `附件 URL 获取失败 ${record.carb_id || record.id}: ${e.message}`);
      }
    }
  } catch (e) {
    log("system", "warn", "tb-tasks", `导出数据获取失败 ${record.carb_id || record.id}: ${e.message}`);
  }
  res.json({ success: true, data: { record, statusName, comments, attachmentUrls, uniqueId, dueDate } });
});

// 获取分析报告
router.get("/:id/report", (req, res) => {
  const record = getTbTaskRecord(req.params.id);
  if (!record) return res.status(404).json({ success: false, error: "记录不存在" });
  if (!record.local_dir) return res.status(404).json({ success: false, error: "无本地目录" });

  const reportPath = join(record.local_dir, "analysis-report.md");
  if (!existsSync(reportPath)) return res.status(404).json({ success: false, error: "报告文件不存在" });

  const content = readFileSync(reportPath, "utf-8");
  res.json({ success: true, data: { content, path: reportPath } });
});

// 打开附件目录（本机资源管理器）
router.post("/:id/open-dir", (req, res) => {
  const record = getTbTaskRecord(req.params.id);
  if (!record) return res.status(404).json({ success: false, error: "记录不存在" });
  if (!record.local_dir) return res.status(400).json({ success: false, error: "无本地目录" });

  const dir = join(record.local_dir, "attachments");
  const target = existsSync(dir) ? dir : record.local_dir;

  const cmd = process.platform === "win32"
    ? `explorer "${target.replace(/\//g, "\\")}"`
    : process.platform === "darwin"
      ? `open "${target}"`
      : `xdg-open "${target}"`;

  exec(cmd, { windowsHide: true }, (err) => {
    if (err) return res.status(500).json({ success: false, error: err.message });
    res.json({ success: true, data: { dir: target } });
  });
});

// 验证 TB Cookie 是否有效
router.get("/cookie-check", async (req, res) => {
  res.set("Cache-Control", "no-store");
  const result = await checkTbCookie();
  res.json({ success: true, data: result });
});

// 高级手工录入：候选 Cookie 验证成功后才原子替换已保存值。
router.post("/cookie-verify-save", async (req, res) => {
  const candidate = String(req.body?.cookie || "").trim();
  if (!candidate) return res.status(400).json({ success: false, error: "请提供完整 Cookie" });

  try {
    const health = await verifyAndSaveTbCookie(candidate);
    const data = {
      valid: Boolean(health?.valid),
      status: health?.status,
      code: health?.code,
      reason: health?.reason,
      checkedAt: health?.checkedAt,
      hasCookie: Boolean(health?.valid),
      httpStatus: health?.httpStatus,
      user: health?.user,
      id: health?.id,
    };
    if (!health?.valid) {
      const status = health?.status === "unavailable" ? 503 : 400;
      return res.status(status).json({ success: false, error: health?.reason || "Cookie 验证失败，未保存", data });
    }
    return res.json({ success: true, data });
  } catch (error) {
    log("system", "error", "tb-tasks", `手工 Cookie 验证保存失败: ${error.message}`);
    return res.status(500).json({ success: false, error: "Cookie 验证或保存失败，原值未修改" });
  }
});

// 一键登录提取 Cookie（本机 GUI 弹窗 / 无桌面则远程 /tb-browser）
router.post("/login", async (req, res) => {
  let loginChallenge = "";
  try {
    const preferRemote = req.body?.mode === "remote" || req.query?.mode === "remote";
    const useLocal = !preferRemote && canUseLocalGuiBrowser();
    const current = getTbLoginStatus();
    if (current?.busy) {
      return res.status(409).json({
        success: false,
        error: current.message || "已有登录窗口打开中，请完成或取消后重试",
        data: current,
      });
    }

    if (useLocal) {
      loginChallenge = beginTbLoginChallenge();
      // 本机 headed：先回包再异步跑，避免阻塞到扫码结束
      res.json({
        success: true,
        data: {
          mode: "local",
          loginChallenge,
          message: "浏览器已启动，请在本机弹出的窗口中登录 Teambition",
        },
      });
      extractTbCookie({
        onVerified: (userInfo) => completeTbLoginChallenge(loginChallenge, userInfo),
      })
        .then((result) => {
          if (!result?.success) {
            discardTbLoginChallenge(loginChallenge);
            if (result?.error !== "登录已取消") {
              log("system", "warn", "tb-tasks", `登录提取未完成: ${result?.error || "未知原因"}`);
            }
          }
        })
        .catch((err) => {
          discardTbLoginChallenge(loginChallenge);
          log("system", "error", "tb-tasks", `登录提取失败: ${err.message}`);
        });
      return;
    }

    loginChallenge = beginTbLoginChallenge();
    const onVerified = (userInfo) => completeTbLoginChallenge(loginChallenge, userInfo);
    const onFailed = () => discardTbLoginChallenge(loginChallenge);
    const result = await (preferRemote
      ? (await import("../services/tb-remote-browser.js")).startRemoteLoginSession({ onVerified, onFailed })
      : extractTbCookie({ onVerified }));
    if (!result?.success) {
      discardTbLoginChallenge(loginChallenge);
      return res.status(500).json({
        success: false,
        error: result?.error || "启动远程登录失败",
        data: {
          mode: result?.mode || "remote",
          viewerUrl: result?.viewerUrl,
          phase: result?.phase,
          message: result?.error || result?.message,
        },
      });
    }
    return res.json({
      success: true,
      data: {
        mode: result.mode || "remote",
        viewerUrl: result.viewerUrl || "/tb-browser",
        loginChallenge,
        phase: result.phase,
        message: result.message || "远程浏览器已启动，请在弹出的页面中扫码",
      },
    });
  } catch (err) {
    discardTbLoginChallenge(loginChallenge);
    log("system", "error", "tb-tasks", `登录启动失败: ${err.message}`);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// 当前登录会话状态（含远程 phase）
router.get("/login/status", (req, res) => {
  res.set("Cache-Control", "no-store");
  res.json({ success: true, data: getTbLoginStatus() });
});

// 取消登录
router.post("/login/cancel", async (req, res) => {
  if (!cancelTbLoginChallenge(req.body?.loginChallenge)) {
    return res.status(403).json({
      success: false,
      code: "TB_LOGIN_CHALLENGE_REQUIRED",
      error: "只能取消由当前页面发起的 TB 登录",
    });
  }
  const ok = await cancelTbLogin();
  return res.json({ success: true, data: { cancelled: ok } });
});

export default router;
