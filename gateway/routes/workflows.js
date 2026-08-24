import { Router } from "express";
import { randomUUID } from "crypto";
import {
  createWorkflow, getWorkflow, listWorkflows, updateWorkflow, deleteWorkflow,
  listWorkflowRuns, getWorkflowRun,
} from "../db/sqlite.js";
import { executeWorkflow, abortWorkflowRun } from "../services/workflow-executor.js";
import { requestPrincipal } from "../services/admin-auth.js";

const router = Router();

function requireWorkflowAuth(req, res, next) {
  const environment = String(process.env.NODE_ENV || "").trim().toLowerCase();
  if (environment === "test") return next();
  const principal = requestPrincipal(req);
  if (!principal) {
    return res.status(401).json({
      success: false,
      code: "WORKFLOW_API_AUTH_REQUIRED",
      error: "工作流接口要求已认证身份",
    });
  }
  req.principal = principal;
  return next();
}

router.use(requireWorkflowAuth);

// 列出所有工作流模板
router.get("/", (req, res) => {
  const workflows = listWorkflows();
  res.json({ success: true, data: workflows });
});

// 获取单个工作流
router.get("/:id", (req, res) => {
  const wf = getWorkflow(req.params.id);
  if (!wf) return res.status(404).json({ success: false, error: "工作流不存在" });
  res.json({ success: true, data: wf });
});

// 创建工作流
router.post("/", (req, res) => {
  const { name, description, steps, config } = req.body;
  if (!name?.trim()) return res.status(400).json({ success: false, error: "名称不能为空" });
  if (!steps || !Array.isArray(steps) || steps.length === 0) {
    return res.status(400).json({ success: false, error: "至少需要一个步骤" });
  }

  const validationError = validateSteps(steps);
  if (validationError) return res.status(400).json({ success: false, error: validationError });

  const id = randomUUID();
  createWorkflow({
    id, name: name.trim(), description: description || "",
    steps: JSON.stringify(steps), config: JSON.stringify(config || {}),
  });
  const wf = getWorkflow(id);
  res.json({ success: true, data: wf });
});

// 更新工作流
router.put("/:id", (req, res) => {
  const wf = getWorkflow(req.params.id);
  if (!wf) return res.status(404).json({ success: false, error: "工作流不存在" });

  const updates = {};
  if (req.body.name !== undefined) updates.name = req.body.name.trim();
  if (req.body.description !== undefined) updates.description = req.body.description;
  if (req.body.steps !== undefined) {
    if (!Array.isArray(req.body.steps) || req.body.steps.length === 0) {
      return res.status(400).json({ success: false, error: "至少需要一个步骤" });
    }
    const validationError = validateSteps(req.body.steps);
    if (validationError) return res.status(400).json({ success: false, error: validationError });
    updates.steps = JSON.stringify(req.body.steps);
  }
  if (req.body.config !== undefined) {
    updates.config = JSON.stringify(req.body.config);
  }

  updateWorkflow(req.params.id, updates);
  res.json({ success: true, data: getWorkflow(req.params.id) });
});

// 删除工作流
router.delete("/:id", (req, res) => {
  const wf = getWorkflow(req.params.id);
  if (!wf) return res.status(404).json({ success: false, error: "工作流不存在" });
  deleteWorkflow(req.params.id);
  res.json({ success: true });
});

// 触发执行
router.post("/:id/run", (req, res) => {
  const wf = getWorkflow(req.params.id);
  if (!wf) return res.status(404).json({ success: false, error: "工作流不存在" });

  const runId = randomUUID();
  const { variables = {}, sessionId = null } = req.body;

  res.json({ success: true, data: { runId, workflowId: wf.id, workflowName: wf.name } });

  executeWorkflow(wf, runId, variables, sessionId, "web").catch(() => {});
});

// 列出执行记录
router.get("/:id/runs", (req, res) => {
  const { status, limit } = req.query;
  const runs = listWorkflowRuns({
    workflowId: req.params.id,
    status,
    limit: limit ? parseInt(limit) : 20,
  });
  res.json({ success: true, data: runs });
});

export default router;

// ========== workflow-runs 路由（挂载到 /api/workflow-runs） ==========
export const workflowRunsRouter = Router();
workflowRunsRouter.use(requireWorkflowAuth);

workflowRunsRouter.get("/", (req, res) => {
  const { workflowId, status, limit } = req.query;
  const runs = listWorkflowRuns({
    workflowId,
    status,
    limit: limit ? parseInt(limit) : 20,
  });
  res.json({ success: true, data: runs });
});

workflowRunsRouter.get("/:runId", (req, res) => {
  const run = getWorkflowRun(req.params.runId);
  if (!run) return res.status(404).json({ success: false, error: "运行记录不存在" });
  res.json({ success: true, data: run });
});

workflowRunsRouter.post("/:runId/abort", (req, res) => {
  const run = getWorkflowRun(req.params.runId);
  if (!run) return res.status(404).json({ success: false, error: "运行记录不存在" });
  if (run.status !== "running") return res.status(400).json({ success: false, error: "工作流未在运行中" });

  const aborted = abortWorkflowRun(req.params.runId);
  if (!aborted) return res.status(400).json({ success: false, error: "未找到活跃的运行实例" });
  res.json({ success: true });
});

// ========== 工具函数 ==========

function validateSteps(steps) {
  const ids = new Set();
  for (const step of steps) {
    if (!step.id) return "每个步骤必须有 id";
    if (!step.title) return `步骤 ${step.id} 缺少 title`;
    if (ids.has(step.id)) return `步骤 id "${step.id}" 重复`;
    ids.add(step.id);
  }

  // 检查 dependsOn 引用有效性
  for (const step of steps) {
    for (const dep of (step.dependsOn || [])) {
      if (!ids.has(dep)) return `步骤 "${step.id}" 依赖了不存在的步骤 "${dep}"`;
    }
  }

  // 环检测（Kahn 算法）
  const inDegree = new Map();
  const adjacency = new Map();
  for (const step of steps) {
    inDegree.set(step.id, 0);
    adjacency.set(step.id, []);
  }
  for (const step of steps) {
    for (const dep of (step.dependsOn || [])) {
      adjacency.get(dep).push(step.id);
      inDegree.set(step.id, inDegree.get(step.id) + 1);
    }
  }
  const queue = [];
  for (const [id, deg] of inDegree) {
    if (deg === 0) queue.push(id);
  }
  let visited = 0;
  while (queue.length > 0) {
    const id = queue.shift();
    visited++;
    for (const next of adjacency.get(id)) {
      const newDeg = inDegree.get(next) - 1;
      inDegree.set(next, newDeg);
      if (newDeg === 0) queue.push(next);
    }
  }
  if (visited !== steps.length) return "步骤依赖存在循环";

  return null;
}
