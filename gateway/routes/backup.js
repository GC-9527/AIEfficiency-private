// AI 配置 / 记忆 / Skills 一键备份 · 迁移 · 还原 路由
// 挂载于 /api/backup（server.js 的 isNode 块，属本地执行能力）。
// 注意：上传走本路由内独立的大体积 raw 解析，不影响全局 express.json({limit:'10mb'})。
import { Router } from "express";
import express from "express";
import { buildManifest, createBackup, restoreBackup, readManifest, checkEnv } from "../services/ai-backup.js";
import { requireAdmin } from "../services/admin-auth.js";

const router = Router();

// manifest/env-check 是无副作用的能力探测；打包和还原会读取或覆盖本机
// 数据（并可能包含会话/密钥），必须使用当前有效的管理员会话。
router.use((req, res, next) => {
  if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return next();
  return requireAdmin(req, res, next);
});

// 备份/还原上传体可能很大（含会话历史）→ 单独 raw 解析，600MB 上限。
// 浏览器/系统可能把 zip 标成 application/zip 或 x-zip-compressed，不能只收 octet-stream。
const rawUpload = express.raw({ type: "*/*", limit: "600mb" });

// 可备份项清单（前端勾选用）
router.get("/manifest", (req, res) => {
  try {
    res.json({ success: true, data: buildManifest() });
  } catch (e) {
    res.status(500).json({ success: false, error: String(e?.message || e) });
  }
});

// 环境检测 + 安装指引（不安装）
router.get("/env-check", (req, res) => {
  try {
    res.json({ success: true, data: checkEnv() });
  } catch (e) {
    res.status(500).json({ success: false, error: String(e?.message || e) });
  }
});

// 创建备份 → 直接回 zip 流下载
router.post("/create", express.json({ limit: "1mb" }), async (req, res) => {
  try {
    const { items = null, includeSessions = false, includeSecrets = false } = req.body || {};
    const { buffer, filename } = await createBackup({ items, includeSessions, includeSecrets });
    res.setHeader("Content-Type", "application/octet-stream");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.setHeader("X-Backup-Filename", filename);
    res.send(buffer);
  } catch (e) {
    res.status(500).json({ success: false, error: String(e?.message || e) });
  }
});

// 还原预览：上传 zip，仅解析 manifest 不落盘
router.post("/restore/preview", rawUpload, async (req, res) => {
  try {
    if (!req.body || !req.body.length) return res.status(400).json({ success: false, error: "未收到备份包数据" });
    const { manifest } = await readManifest(req.body);
    res.json({ success: true, data: manifest });
  } catch (e) {
    res.status(400).json({ success: false, error: String(e?.message || e) });
  }
});

// 执行还原：query 传 targetWorkspaceRoot / overwrite / items(逗号分隔)
router.post("/restore", rawUpload, async (req, res) => {
  try {
    if (!req.body || !req.body.length) return res.status(400).json({ success: false, error: "未收到备份包数据" });
    const targetWorkspaceRoot = req.query.targetWorkspaceRoot ? String(req.query.targetWorkspaceRoot) : null;
    const overwrite = String(req.query.overwrite || "") === "true";
    const items = req.query.items ? String(req.query.items).split(",").map((s) => s.trim()).filter(Boolean) : null;
    const report = await restoreBackup({ zipBuffer: req.body, targetWorkspaceRoot, overwrite, items });
    res.json({ success: true, data: report });
  } catch (e) {
    res.status(500).json({ success: false, error: String(e?.message || e) });
  }
});

export default router;
