import { Router } from "express";
import { getTaskLogs, getRecentLogs, getLogsByDate } from "../db/sqlite.js";

const router = Router();

// 获取日志：?date=YYYY-MM-DD 取某一日历日；?days=N 取最近 N 天；否则取最近 limit 条
router.get("/", (req, res) => {
  const { limit, days, date } = req.query;
  const lim = limit ? parseInt(limit) : (date || days ? 5000 : 100);
  const logs = date ? getLogsByDate(String(date), { limit: lim }) : getRecentLogs({ limit: lim, days: days ? parseInt(days) : undefined });
  res.json({ success: true, data: logs });
});

// 获取指定任务的日志
router.get("/task/:taskId", (req, res) => {
  const { limit, offset } = req.query;
  const logs = getTaskLogs(req.params.taskId, {
    limit: limit ? parseInt(limit) : 100,
    offset: offset ? parseInt(offset) : 0,
  });
  res.json({ success: true, data: logs });
});

export default router;
