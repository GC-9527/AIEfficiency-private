/**
 * 项目开发路由 - /api/project-dev/*
 *
 * 「项目开发」：管理一份编排 spec（项目愿景 + 里程碑 + 外部验收），无人值守驱动 claude 从零把项目建出来。
 * 编排内核在 services/projectdev/kernel/（可移植），本路由只做 REST + 鉴权，运行由 services/projectdev/runner.js 接。
 *
 * 在 server.js 通过单行 app.use("/api/project-dev", router) 挂载。
 * 写操作仅管理员（照搬 devbench 的 isAdminReq）。统一返回 {ok:true,data} / {ok:false,error}。
 */
import { Router } from "express";
import { randomUUID } from "node:crypto";
import { validateSpec } from "../services/projectdev/kernel/index.js";
import {
  startRun, pauseRun, resumeRun, stopRun, approve, getRunStatus,
} from "../services/projectdev/runner.js";
import {
  listProjectDevProjects, getProjectDevProject, upsertProjectDevProject, deleteProjectDevProject,
  getLatestRun, listProjectDevEvents,
} from "../db/sqlite.js";
import { isAdminPrincipal, requestPrincipal } from "../services/admin-auth.js";

const router = Router();

// 是否为管理员（super/admin）—— 据请求 Authorization Bearer 校验
function isAdminReq(req) {
  return isAdminPrincipal(requestPrincipal(req));
}
function principalKey(req) {
  const p = requestPrincipal(req);
  return p?.subject?.id || p?.dingUserid || p?.name || "";
}
const adminOnly = (res) => res.status(403).json({ ok: false, error: "项目开发仅管理员可操作" });

// 把 DB 行的 spec(JSON 字符串) 解析后返回
function shapeProject(row) {
  if (!row) return null;
  let spec = null;
  try { spec = typeof row.spec === "string" ? JSON.parse(row.spec) : row.spec; } catch {}
  return { ...row, spec };
}

// ===== 项目 CRUD =====

// 列表
router.get("/projects", (req, res) => {
  res.json({ ok: true, data: listProjectDevProjects().map(shapeProject) });
});

// 新建项目（校验 spec，不过返回 400）
router.post("/projects", (req, res) => {
  if (!isAdminReq(req)) return adminOnly(res);
  const { name, spec } = req.body || {};
  if (!spec || typeof spec !== "object") return res.status(400).json({ ok: false, error: "缺少 spec（对象）" });
  const errs = validateSpec(spec);
  if (errs.length) return res.status(400).json({ ok: false, error: "spec 校验失败：" + errs.join("；") });
  const id = randomUUID();
  const row = upsertProjectDevProject({ id, name: name || spec.vision?.slice(0, 40) || "未命名项目", spec, status: "idle", userKey: principalKey(req) });
  res.json({ ok: true, data: shapeProject(row) });
});

// 详情（含最新 run 的 state）
router.get("/projects/:id", (req, res) => {
  const row = getProjectDevProject(req.params.id);
  if (!row) return res.status(404).json({ ok: false, error: "项目不存在" });
  const data = shapeProject(row);
  data.latestRun = getLatestRun(req.params.id) || null;
  data.live = getRunStatus(req.params.id);
  res.json({ ok: true, data });
});

// 更新（name / spec；改 spec 时校验）
router.put("/projects/:id", (req, res) => {
  if (!isAdminReq(req)) return adminOnly(res);
  const row = getProjectDevProject(req.params.id);
  if (!row) return res.status(404).json({ ok: false, error: "项目不存在" });
  const { name, spec, status } = req.body || {};
  if (spec !== undefined) {
    if (!spec || typeof spec !== "object") return res.status(400).json({ ok: false, error: "spec 必须是对象" });
    const errs = validateSpec(spec);
    if (errs.length) return res.status(400).json({ ok: false, error: "spec 校验失败：" + errs.join("；") });
  }
  const cur = shapeProject(row);
  const updated = upsertProjectDevProject({
    id: req.params.id,
    name: name !== undefined ? name : cur.name,
    spec: spec !== undefined ? spec : cur.spec,
    status: status !== undefined ? status : cur.status,
    userKey: cur.userKey,
  });
  res.json({ ok: true, data: shapeProject(updated) });
});

// 删除（连带 runs/events）
router.delete("/projects/:id", (req, res) => {
  if (!isAdminReq(req)) return adminOnly(res);
  const row = getProjectDevProject(req.params.id);
  if (!row) return res.status(404).json({ ok: false, error: "项目不存在" });
  const live = getRunStatus(req.params.id);
  if (live.running) stopRun(req.params.id);
  deleteProjectDevProject(req.params.id);
  res.json({ ok: true, data: { id: req.params.id } });
});

// ===== 运行控制 =====

router.post("/projects/:id/start", (req, res) => {
  if (!isAdminReq(req)) return adminOnly(res);
  const row = getProjectDevProject(req.params.id);
  if (!row) return res.status(404).json({ ok: false, error: "项目不存在" });
  const r = startRun(shapeProject(row));
  if (!r.ok) return res.status(400).json(r);
  res.json({ ok: true, data: { runId: r.runId } });
});

router.post("/projects/:id/pause", (req, res) => {
  if (!isAdminReq(req)) return adminOnly(res);
  const r = pauseRun(req.params.id);
  if (!r.ok) return res.status(400).json(r);
  res.json({ ok: true, data: { runId: r.runId } });
});

router.post("/projects/:id/resume", (req, res) => {
  if (!isAdminReq(req)) return adminOnly(res);
  const row = getProjectDevProject(req.params.id);
  if (!row) return res.status(404).json({ ok: false, error: "项目不存在" });
  const r = resumeRun(req.params.id, shapeProject(row));
  if (!r.ok) return res.status(400).json(r);
  res.json({ ok: true, data: { runId: r.runId, resumed: r.resumed || "restart" } });
});

router.post("/projects/:id/stop", (req, res) => {
  if (!isAdminReq(req)) return adminOnly(res);
  const r = stopRun(req.params.id);
  if (!r.ok) return res.status(400).json(r);
  res.json({ ok: true, data: { runId: r.runId } });
});

router.post("/projects/:id/approve", (req, res) => {
  if (!isAdminReq(req)) return adminOnly(res);
  const milestoneId = req.body?.milestoneId;
  if (!milestoneId) return res.status(400).json({ ok: false, error: "缺少 milestoneId" });
  const r = approve(req.params.id, milestoneId);
  if (!r.ok) return res.status(400).json(r);
  res.json({ ok: true, data: { runId: r.runId } });
});

// ===== 事件 / 状态查询（只读，不限管理员）=====

// 事件流（增量拉取：sinceId 之后的事件）
router.get("/projects/:id/events", (req, res) => {
  const sinceId = parseInt(req.query.sinceId) || 0;
  const limit = Math.min(parseInt(req.query.limit) || 500, 2000);
  res.json({ ok: true, data: listProjectDevEvents(req.params.id, sinceId, limit) });
});

// 最新 run-state + 内存运行态
router.get("/projects/:id/state", (req, res) => {
  const row = getProjectDevProject(req.params.id);
  if (!row) return res.status(404).json({ ok: false, error: "项目不存在" });
  res.json({ ok: true, data: { latestRun: getLatestRun(req.params.id) || null, live: getRunStatus(req.params.id) } });
});

export default router;
