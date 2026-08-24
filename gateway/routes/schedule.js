import { Router } from "express";
import { randomUUID } from "crypto";
import {
  createScheduledTask,
  listScheduledTasks,
  getScheduledTask,
  updateScheduledTask,
  deleteScheduledTask,
} from "../db/sqlite.js";
import { registerCron, unregisterCron, runScheduledTaskNow } from "../services/scheduler.js";
import { requestPrincipal } from "../services/admin-auth.js";

const router = Router();

router.use((req, res, next) => {
  const environment = String(process.env.NODE_ENV || "").trim().toLowerCase();
  if (environment === "test") return next();
  const principal = requestPrincipal(req);
  if (!principal) {
    return res.status(401).json({
      success: false,
      code: "SCHEDULE_API_AUTH_REQUIRED",
      error: "定时任务接口要求已认证身份",
    });
  }
  req.principal = principal;
  return next();
});

// 列出所有定时任务
router.get("/", (req, res) => {
  const tasks = listScheduledTasks();
  res.json({ success: true, data: tasks });
});

// 创建定时任务
router.post("/", (req, res) => {
  const { name, cronExpr, prompt, engine, skill, outputTarget, outputConfig, enabled } = req.body;
  if (!name || !cronExpr || !prompt) {
    return res.status(400).json({ success: false, error: "缺少 name / cronExpr / prompt" });
  }

  const id = randomUUID();
  // outputConfig 可能是 object 也可能已经是 string，统一序列化防止 JSON 错误
  let cfgStr = "{}";
  try {
    if (typeof outputConfig === "string") {
      // 验证是合法 JSON 再存
      JSON.parse(outputConfig);
      cfgStr = outputConfig;
    } else if (outputConfig && typeof outputConfig === "object") {
      cfgStr = JSON.stringify(outputConfig);
    }
  } catch (err) {
    return res.status(400).json({ success: false, error: `outputConfig 格式错误: ${err.message}` });
  }

  const task = { id, name, cronExpr, prompt, engine, skill, outputTarget, outputConfig: cfgStr, enabled: enabled ?? 1 };

  try {
    createScheduledTask(task);
    const saved = getScheduledTask(id);
    if (saved?.enabled) registerCron(saved);
    res.json({ success: true, data: saved });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 更新定时任务
router.put("/:id", (req, res) => {
  const id = req.params.id;
  const existing = getScheduledTask(id);
  if (!existing) return res.status(404).json({ success: false, error: "任务不存在" });

  const updates = {};
  for (const key of ["name", "cronExpr", "prompt", "engine", "skill", "outputTarget", "enabled"]) {
    if (req.body[key] !== undefined) updates[key] = req.body[key];
  }
  if (req.body.outputConfig !== undefined) {
    try {
      const oc = req.body.outputConfig;
      if (typeof oc === "string") {
        JSON.parse(oc);
        updates.outputConfig = oc;
      } else {
        updates.outputConfig = JSON.stringify(oc || {});
      }
    } catch (err) {
      return res.status(400).json({ success: false, error: `outputConfig 格式错误: ${err.message}` });
    }
  }

  try {
    updateScheduledTask(id, updates);
    const updated = getScheduledTask(id);

    // 重新注册或取消 cron
    if (updated.enabled) {
      registerCron(updated);
    } else {
      unregisterCron(id);
    }

    res.json({ success: true, data: updated });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 删除定时任务
router.delete("/:id", (req, res) => {
  const id = req.params.id;
  unregisterCron(id);
  deleteScheduledTask(id);
  res.json({ success: true });
});

// 启用/禁用
router.post("/:id/toggle", (req, res) => {
  const id = req.params.id;
  const task = getScheduledTask(id);
  if (!task) return res.status(404).json({ success: false, error: "任务不存在" });

  const newEnabled = task.enabled ? 0 : 1;
  updateScheduledTask(id, { enabled: newEnabled });

  if (newEnabled) {
    registerCron(getScheduledTask(id));
  } else {
    unregisterCron(id);
  }

  res.json({ success: true, data: { enabled: newEnabled } });
});

// 立即执行
router.post("/:id/run", async (req, res) => {
  const task = getScheduledTask(req.params.id);
  if (!task) return res.status(404).json({ success: false, error: "任务不存在" });

  res.json({ success: true, data: { message: `正在执行: ${task.name}` } });
  runScheduledTaskNow(task).catch(() => {});
});

export default router;
