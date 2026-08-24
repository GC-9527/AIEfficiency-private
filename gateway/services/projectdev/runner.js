/**
 * 项目开发编排 runner —— 把可移植的 kernel(runOrchestrator) 接进 gateway。
 *
 * 职责：
 *  - 维护「每个项目至多一个在跑的 run」（模块级 Map<projectId, ...>）。
 *  - 起后台 runOrchestrator，把 hooks.onEvent 落 SQLite + 推 WS。
 *  - 暴露 start/pause/resume/stop/approve/getRunStatus 给路由。
 *
 * 状态落 <gateway根>/data/projectdev/<projectId>/run-state.json（绝不污染目标工程目录），
 * kernel 续跑就靠这个 run-state.json。
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { runOrchestrator, validateSpec } from "./kernel/index.js";
import {
  insertProjectDevRun, updateProjectDevRun, insertProjectDevEvent,
  upsertProjectDevProject, getProjectDevProject,
} from "../../db/sqlite.js";
import { broadcastProjectDev, log } from "../logger.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
// runner.js 在 gateway/services/projectdev/ → 上溯两级到 gateway 根
const GATEWAY_ROOT = path.resolve(__dirname, "..", "..");

// projectId -> { runId, abort:AbortController, control }
const RUNNING = new Map();

function stateDirFor(projectId) {
  return path.join(GATEWAY_ROOT, "data", "projectdev", projectId);
}

// 哪些事件值得把 run-state 快照写库（其余高频流式事件只入 events 表，省写放大）
const SNAPSHOT_TYPES = new Set([
  "run_start", "milestone_start", "milestone_done", "acceptance",
  "await_approval", "needs_human", "run_done", "run_exit", "paused",
]);

/**
 * 启动（或续跑）一个项目的编排。
 * @param {{id:string, name?:string, spec:object|string}} project
 * @returns {{ok:true, runId}|{ok:false, error}}
 */
export function startRun(project) {
  if (!project || !project.id) return { ok: false, error: "缺少 project.id" };
  if (RUNNING.has(project.id)) {
    const cur = RUNNING.get(project.id);
    return { ok: false, error: "该项目已有正在运行的编排", runId: cur.runId };
  }

  const spec = typeof project.spec === "string" ? safeParse(project.spec) : project.spec;
  if (!spec) return { ok: false, error: "spec 解析失败" };
  const errs = validateSpec(spec);
  if (errs.length) return { ok: false, error: "spec 校验失败：" + errs.join("；") };

  const runId = randomUUID();
  const stateDir = stateDirFor(project.id);
  const abort = new AbortController();
  const control = { stop: false, pause: false, approval: new Map() };

  insertProjectDevRun({ runId, projectId: project.id, status: "running", state: null });
  upsertProjectDevProject({ ...getProjectDevProject(project.id), id: project.id, name: project.name, spec, status: "running" });
  RUNNING.set(project.id, { runId, abort, control });

  const hooks = {
    onEvent: (evt) => {
      try { insertProjectDevEvent({ projectId: project.id, runId, ts: evt.ts, type: evt.type, data: evt }); } catch {}
      if (SNAPSHOT_TYPES.has(evt.type)) {
        try { updateProjectDevRun(runId, { status: runStatusFromEvt(evt), state: evt.state || undefined }); } catch {}
      }
      try { broadcastProjectDev({ projectId: project.id, runId, evt }); } catch {}
    },
    isStopRequested: () => control.stop,
    isPauseRequested: () => control.pause,
    waitApproval: (id) => new Promise((res) => control.approval.set(id, res)),
  };

  // 后台跑，不阻塞调用方
  (async () => {
    let final = { status: "error", state: null };
    try {
      final = await runOrchestrator({ spec, stateDir, signal: abort.signal, hooks });
    } catch (e) {
      log("system", "error", "projectdev", `编排异常 project=${project.id}: ${e?.message || e}`);
      final = { status: "error", state: { error: String(e?.message || e) } };
    } finally {
      const finishedAt = new Date().toISOString();
      try { updateProjectDevRun(runId, { status: final.status, state: final.state || undefined, finishedAt }); } catch {}
      try { upsertProjectDevProject({ ...getProjectDevProject(project.id), id: project.id, status: final.status }); } catch {}
      RUNNING.delete(project.id);
    }
  })();

  return { ok: true, runId };
}

function runStatusFromEvt(evt) {
  if (evt.type === "run_done" || evt.type === "run_exit") return evt.status || "completed";
  if (evt.type === "needs_human") return "needs_human";
  if (evt.type === "await_approval" || evt.type === "paused") return "paused";
  return "running";
}

export function pauseRun(projectId) {
  const r = RUNNING.get(projectId);
  if (!r) return { ok: false, error: "该项目没有正在运行的编排" };
  r.control.pause = true;
  return { ok: true, runId: r.runId };
}

export function resumeRun(projectId, project) {
  const r = RUNNING.get(projectId);
  if (r) { // 在跑且仅是 pause 标志 → 清标志即可
    if (r.control.pause) { r.control.pause = false; return { ok: true, runId: r.runId, resumed: "live" }; }
    return { ok: false, error: "该项目已在运行中" };
  }
  // 不在内存 → 重新 startRun，kernel 读 run-state.json 自动续跑（断点续跑）
  const proj = project || getProjectDevProject(projectId);
  if (!proj) return { ok: false, error: "项目不存在" };
  return startRun(proj);
}

export function stopRun(projectId) {
  const r = RUNNING.get(projectId);
  if (!r) return { ok: false, error: "该项目没有正在运行的编排" };
  r.control.stop = true;
  // 释放可能在等审批的 Promise，避免悬挂
  for (const res of r.control.approval.values()) { try { res(false); } catch {} }
  try { r.abort.abort(); } catch {}
  return { ok: true, runId: r.runId };
}

export function approve(projectId, milestoneId) {
  const r = RUNNING.get(projectId);
  if (!r) return { ok: false, error: "该项目没有正在运行的编排" };
  const res = r.control.approval.get(milestoneId);
  if (!res) return { ok: false, error: "没有待审批的里程碑 " + milestoneId };
  res(true);
  r.control.approval.delete(milestoneId);
  return { ok: true, runId: r.runId };
}

export function getRunStatus(projectId) {
  const r = RUNNING.get(projectId);
  if (!r) return { running: false };
  return { running: true, runId: r.runId, paused: r.control.pause, stopping: r.control.stop, awaiting: [...r.control.approval.keys()] };
}

function safeParse(s) { try { return JSON.parse(s); } catch { return null; } }
