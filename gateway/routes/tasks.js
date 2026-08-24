import { Router } from "express";
import { randomUUID } from "crypto";
import {
  createTask,
  getTask,
  listTasks,
  updateTask,
  deleteTask,
} from "../db/sqlite.js";
import { classifyTask } from "../services/dispatcher.js";
import { runTask, stopTaskAgent } from "../services/agent-runner.js";
import { log, broadcastTaskUpdate } from "../services/logger.js";
import { activeSchedulers } from "./chat.js";
import { requestPrincipal } from "../services/admin-auth.js";

const router = Router();

router.use((req, res, next) => {
  const environment = String(process.env.NODE_ENV || "").trim().toLowerCase();
  if (
    environment === "test"
    || (
      environment === "development"
      && String(process.env.AIEFFICIENCY_ALLOW_UNAUTHENTICATED_TASK_API || "") === "1"
    )
  ) return next();
  const principal = requestPrincipal(req);
  if (!principal) {
    return res.status(401).json({
      success: false,
      code: "TASK_API_AUTH_REQUIRED",
      error: "任务执行接口要求已认证身份",
    });
  }
  req.principal = principal;
  return next();
});

// 获取任务列表
router.get("/", (req, res) => {
  const { status, source, sourceId, parentTaskId, topLevel, limit, offset } = req.query;
  const tasks = listTasks({
    status,
    source,
    sourceId,
    parentTaskId,
    topLevel: topLevel === "true",
    limit: limit ? parseInt(limit) : 50,
    offset: offset ? parseInt(offset) : 0,
  });
  res.json({ success: true, data: tasks });
});

// 获取单个任务详情
router.get("/:id", (req, res) => {
  const task = getTask(req.params.id);
  if (!task) {
    return res.status(404).json({ success: false, error: "任务不存在" });
  }
  res.json({ success: true, data: task });
});

// 创建新任务
router.post("/", async (req, res) => {
  const { title, description, type, priority, source } = req.body;

  if (!title) {
    return res.status(400).json({ success: false, error: "缺少任务标题" });
  }

  const taskId = randomUUID();
  const taskType = type || classifyTask(description || title);

  const task = {
    id: taskId,
    title,
    description: description || "",
    type: taskType,
    status: "pending",
    priority: priority || 3,
    source: source || "web",
    sourceId: null,
  };

  createTask(task);
  log(taskId, "info", "api", `新任务创建: ${title} (type=${taskType})`);

  res.json({ success: true, data: { ...task, id: taskId } });
});

// 创建并立即执行任务
router.post("/run", async (req, res) => {
  const { title, description, type, priority, source } = req.body;

  if (!title) {
    return res.status(400).json({ success: false, error: "缺少任务标题" });
  }

  const taskId = randomUUID();
  const taskType = type || classifyTask(description || title);

  const task = {
    id: taskId,
    title,
    description: description || "",
    type: taskType,
    status: "pending",
    priority: priority || 3,
    source: source || "web",
    sourceId: null,
  };

  createTask(task);
  log(taskId, "info", "api", `新任务创建并执行: ${title} (type=${taskType})`);

  // 异步执行，立即返回任务ID
  runTask(task).catch((err) => {
    log(taskId, "error", "api", `任务执行异常: ${err.message}`);
  });

  res.json({
    success: true,
    data: { ...task, id: taskId },
    message: "任务已提交执行",
  });
});

// 停止任务
router.post("/:id/stop", (req, res) => {
  const task = getTask(req.params.id);
  if (!task) return res.status(404).json({ success: false, error: "任务不存在" });

  const id = req.params.id;

  // 终止 DAG 调度器（阻止启动新子任务）
  const scheduler = activeSchedulers.get(id);
  if (scheduler) {
    scheduler.abort();
    activeSchedulers.delete(id);
  }

  // 终止所有匹配的进程（包括子任务进程）
  const stopped = stopTaskAgent(id);

  // 无论是否找到进程，都强制把任务状态标记为 failed
  // 解决：API 引擎无进程、等待 CLI 槽位、进程已退出等情况下的僵尸任务
  if (task.status === "running" || task.status === "pending") {
    updateTask(id, { status: "failed", result: JSON.stringify({ error: "用户手动终止" }) });
    broadcastTaskUpdate({ id, status: "failed" });
    log(id, "warn", "agent-runner", "任务被用户手动终止");
  }

  // 同时清理所有处于 running 状态的子任务
  const subtasks = listTasks({ parentTaskId: id });
  for (const sub of subtasks) {
    if (sub.status === "running" || sub.status === "pending") {
      updateTask(sub.id, { status: "failed", result: JSON.stringify({ error: "父任务被终止" }) });
      broadcastTaskUpdate({ id: sub.id, status: "failed" });
    }
  }

  res.json({ success: true });
});

// 更新任务
router.put("/:id", (req, res) => {
  const task = getTask(req.params.id);
  if (!task) {
    return res.status(404).json({ success: false, error: "任务不存在" });
  }

  updateTask(req.params.id, req.body);
  res.json({ success: true, data: getTask(req.params.id) });
});

// 删除任务
router.delete("/:id", (req, res) => {
  const task = getTask(req.params.id);
  if (!task) {
    return res.status(404).json({ success: false, error: "任务不存在" });
  }

  deleteTask(req.params.id);
  res.json({ success: true, message: "任务已删除" });
});

export default router;
