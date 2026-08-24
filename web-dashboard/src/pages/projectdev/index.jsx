/**
 * 项目开发 —— /project-dev
 *
 * 无人值守 AI 编排「从零建大型项目」控制台。三栏：
 *  左栏：项目列表 + 新建
 *  中栏：运行视图（控制条 / needs_human 横幅 / 里程碑泳道 / AI 实时流 / 事件日志）
 *  右栏：Spec 编辑器（可视化 + JSON 源码）
 *
 * 统一一个 WebSocket，收 { type:"projectdev_event", data:{ projectId, runId, evt } }，
 * 按 projectId 把运行态/流/事件归到对应项目；打开项目时拉 GET /projects/:id + /events 初始化，
 * 再用 WS 增量。参照 devbench/index.jsx 的 setXxxMap 分发模式。
 */
import React, { useState, useEffect, useRef, useCallback } from "react";
import { createGatewayWebSocket } from "../../services/gateway.js";
import { projectDevApi, blankSpec } from "./api.js";
import { useIsAdmin } from "../../services/adminAuth.js";
import Markdown from "../../components/Markdown.jsx";
import SpecEditor from "./SpecEditor.jsx";
import MilestoneLane from "./MilestoneLane.jsx";

const ACTIVE_KEY = "projectdev_active";

// 项目顶层状态徽标
const PROJ_STATUS = {
  idle: { label: "未开始", cls: "bg-zinc-700/40 text-zinc-400 border-zinc-600/40", dot: "bg-zinc-500" },
  running: { label: "运行中", cls: "bg-blue-500/15 text-blue-300 border-blue-500/30", dot: "bg-blue-400 animate-pulse" },
  paused: { label: "已暂停", cls: "bg-amber-500/15 text-amber-300 border-amber-500/30", dot: "bg-amber-400" },
  needs_human: { label: "需人工", cls: "bg-rose-500/15 text-rose-300 border-rose-500/30", dot: "bg-rose-400 animate-pulse" },
  completed: { label: "已完成", cls: "bg-emerald-500/15 text-emerald-300 border-emerald-500/30", dot: "bg-emerald-400" },
  failed: { label: "失败", cls: "bg-red-500/15 text-red-300 border-red-500/30", dot: "bg-red-400" },
};

// 把单条 evt 聚合进某项目的 runState（纯函数，避免在 setState 里写副作用）
function reduceRunState(prev, evt) {
  const rs = {
    status: prev.status || "running",
    sessionCostUsd: prev.sessionCostUsd || 0,
    currentMilestoneId: prev.currentMilestoneId || null,
    milestones: { ...(prev.milestones || {}) }, // id -> runtime
    needsHuman: prev.needsHuman || null,        // { id, reason, options }
  };
  const id = evt.id; // 里程碑 id（多数事件带）
  const mk = (mid) => (rs.milestones[mid] = { ...(rs.milestones[mid] || {}) });

  switch (evt.type) {
    case "run_start":
      rs.status = "running"; rs.needsHuman = null; break;
    case "milestone_start": {
      const m = mk(id); m.status = "running"; m.title = evt.title || m.title;
      rs.currentMilestoneId = id; break;
    }
    case "turn": {
      const m = mk(id); m.status = "running"; m.attempt = evt.attempt ?? m.attempt;
      m.turns = (m.turns || 0) + 1; rs.currentMilestoneId = id; break;
    }
    case "cost": {
      const m = mk(id);
      if (evt.turnCostUsd != null) m.costUsd = (m.costUsd || 0) + evt.turnCostUsd;
      if (evt.sessionCostUsd != null) rs.sessionCostUsd = evt.sessionCostUsd;
      if (evt.writes != null) m.writes = evt.writes;
      break;
    }
    case "acceptance": {
      const m = mk(id); m.results = evt.results || [];
      if (evt.failures && evt.failures.length) m.lastFailure = summarizeFailures(evt.failures);
      if (!evt.pass) m.status = "running"; // 验收未过，仍在重试
      break;
    }
    case "milestone_done": {
      const m = mk(id); m.status = "done"; break;
    }
    case "await_approval": {
      const m = mk(id); m.status = "awaiting"; rs.status = "running"; rs.currentMilestoneId = id; break;
    }
    case "needs_human": {
      const m = mk(id); m.status = "needs_human";
      if (evt.failures && evt.failures.length) m.lastFailure = summarizeFailures(evt.failures);
      rs.status = "needs_human";
      rs.needsHuman = { id, reason: evt.reason || "需要人工介入", options: evt.options || [], failures: evt.failures || [] };
      break;
    }
    case "run_done":
    case "run_exit": {
      const s = evt.status;
      rs.status = s === "completed" || s === "done" ? "completed" : s === "needs_human" ? "needs_human" : s === "paused" ? "paused" : s === "failed" ? "failed" : (rs.status === "needs_human" ? "needs_human" : "completed");
      break;
    }
    default: break;
  }
  return rs;
}

function summarizeFailures(failures) {
  if (!failures || !failures.length) return "";
  return failures.map((f) => (typeof f === "string" ? f : (f.label || f.type || JSON.stringify(f)))).join("；");
}

export default function ProjectDev() {
  const { isAdmin } = useIsAdmin();
  const [projects, setProjects] = useState([]);
  const [activeId, setActiveId] = useState(() => localStorage.getItem(ACTIVE_KEY) || null);
  const [specMap, setSpecMap] = useState({});      // projectId -> spec（编辑器数据源，来自 GET /projects/:id）
  const [runMap, setRunMap] = useState({});        // projectId -> runState（聚合 evt）
  const [streamMap, setStreamMap] = useState({});  // projectId -> { milestoneId, thinking, text, tools[] }
  const [eventsMap, setEventsMap] = useState({});  // projectId -> events[]（GET /events + WS 增量）
  const [eventsOpen, setEventsOpen] = useState(false);
  const [toast, setToast] = useState("");
  const [saving, setSaving] = useState(false);
  const [busy, setBusy] = useState(false);
  const [showNew, setShowNew] = useState(false);

  const wsRef = useRef(null);
  const activeRef = useRef(activeId);
  useEffect(() => { activeRef.current = activeId; }, [activeId]);
  const streamScrollRef = useRef(null);

  function showToast(m) { setToast(m); setTimeout(() => setToast(""), 3500); }

  // ---------- 加载项目列表 ----------
  const reloadProjects = useCallback(async () => {
    const r = await projectDevApi.listProjects();
    if (r.ok) { setProjects(r.data || []); return r.data || []; }
    return [];
  }, []);

  useEffect(() => {
    (async () => {
      const list = await reloadProjects();
      if (list.length && !list.find((p) => p.id === activeId)) setActive(list[0].id);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---------- 打开项目：拉 spec + state + events ----------
  async function openProject(id) {
    const [pr, st, ev] = await Promise.all([
      projectDevApi.getProject(id),
      projectDevApi.getState(id),
      projectDevApi.getEvents(id, 0, 200),
    ]);
    if (pr.ok && pr.data) {
      setSpecMap((m) => ({ ...m, [id]: pr.data.spec || pr.data }));
    }
    if (st.ok && st.data) {
      // 后端 state 可能已是聚合形态；做一次容错归一
      setRunMap((m) => ({ ...m, [id]: normalizeState(st.data, m[id]) }));
    }
    if (ev.ok) {
      const events = ev.data || [];
      setEventsMap((m) => ({ ...m, [id]: events }));
      // 用历史事件重放出运行态（若 state 接口未提供聚合）
      setRunMap((m) => {
        const base = m[id] || { milestones: {} };
        let rs = base;
        for (const e of events) if (e.evt) rs = reduceRunState(rs, e.evt);
        return { ...m, [id]: rs };
      });
    }
  }

  function normalizeState(data, prev) {
    // 后端 state 形态未定，尽量兼容；缺失字段交给事件重放补齐
    return {
      status: data.status || prev?.status || "idle",
      sessionCostUsd: data.sessionCostUsd ?? prev?.sessionCostUsd ?? 0,
      currentMilestoneId: data.currentMilestoneId ?? prev?.currentMilestoneId ?? null,
      milestones: data.milestones || prev?.milestones || {},
      needsHuman: data.needsHuman ?? prev?.needsHuman ?? null,
    };
  }

  function setActive(id) {
    setActiveId(id);
    if (id) { localStorage.setItem(ACTIVE_KEY, id); openProject(id); }
  }

  useEffect(() => {
    if (activeId && specMap[activeId] === undefined) openProject(activeId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId]);

  // ---------- WebSocket（单连接，分发 projectdev_event）----------
  useEffect(() => {
    let disposed = false;
    function connect() {
      if (disposed) return;
      const ws = createGatewayWebSocket();
      wsRef.current = ws;
      ws.onmessage = (e) => {
        let msg;
        try { msg = JSON.parse(e.data); } catch { return; }
        if (msg.type !== "projectdev_event") return;
        const { projectId, evt } = msg.data || {};
        if (!projectId || !evt) return;

        // 1) 聚合运行态
        setRunMap((prev) => ({ ...prev, [projectId]: reduceRunState(prev[projectId] || { milestones: {} }, evt) }));

        // 2) 追加事件日志
        setEventsMap((prev) => {
          const list = prev[projectId] || [];
          return { ...prev, [projectId]: [...list, { evt, ts: Date.now() }] };
        });

        // 3) AI 实时流（stream 事件按当前里程碑滚动）
        // 契约：stream{id,type:'thinking'|'text'|'tool_use'|'usage'|'log',text?,name?}。
        // 字段名容错：外层包了 "stream" 时子类在 streamType/kind/subtype；也兼容子类直接当 evt.type 发。
        const STREAM_SUB = ["thinking", "text", "tool_use", "usage", "log"];
        const isStream = evt.type === "stream" || STREAM_SUB.includes(evt.type);
        if (isStream) {
          const stType = evt.type === "stream"
            ? (evt.streamType || evt.kind || evt.subtype || (evt.name ? "tool_use" : "text"))
            : evt.type;
          setStreamMap((prev) => {
            const cur = prev[projectId] || { milestoneId: evt.id, thinking: "", text: "", tools: [] };
            // 换里程碑则清空滚动缓冲
            const base = (evt.id && cur.milestoneId !== evt.id) ? { milestoneId: evt.id, thinking: "", text: "", tools: [] } : { ...cur };
            if (stType === "thinking") base.thinking = (base.thinking || "") + (evt.text || "");
            else if (stType === "tool_use") base.tools = [...(base.tools || []), { name: evt.name, text: evt.text }];
            else if (stType === "log" || stType === "usage") { /* 日志/用量归到事件日志，不入流缓冲 */ }
            else base.text = (base.text || "") + (evt.text || "");
            return { ...prev, [projectId]: base };
          });
        }
        // 里程碑切换/开始时清空上一段流缓冲
        if (evt.type === "milestone_start") {
          setStreamMap((prev) => ({ ...prev, [projectId]: { milestoneId: evt.id, thinking: "", text: "", tools: [] } }));
        }

        // 4) 项目列表状态徽标可能变化 → 轻量刷新
        if (["run_start", "run_done", "run_exit", "needs_human", "await_approval"].includes(evt.type)) {
          reloadProjects();
        }
      };
      ws.onclose = () => { if (!disposed) setTimeout(connect, 2000); };
      ws.onerror = () => { try { ws.close(); } catch {} };
    }
    connect();
    return () => { disposed = true; try { wsRef.current?.close(); } catch {} };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reloadProjects]);

  // 流更新时自动滚到底
  useEffect(() => {
    const el = streamScrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [streamMap, activeId]);

  // ---------- 运行控制 ----------
  async function ctrl(fn, okMsg) {
    if (!activeId) return;
    setBusy(true);
    const r = await fn(activeId);
    setBusy(false);
    if (r.ok) { okMsg && showToast(okMsg); reloadProjects(); }
    else showToast(r.error || "操作失败");
  }
  const onStart = () => ctrl(projectDevApi.start, "已开始运行");
  const onPause = () => ctrl(projectDevApi.pause, "已暂停");
  const onResume = () => ctrl(projectDevApi.resume, "已继续");
  const onStop = () => ctrl(projectDevApi.stop, "已停止");
  async function onApprove(milestoneId) {
    if (!activeId) return;
    const r = await projectDevApi.approve(activeId, milestoneId);
    if (r.ok) { showToast("已批准"); reloadProjects(); }
    else showToast(r.error || "批准失败");
  }

  // ---------- spec 保存 ----------
  async function saveSpec(spec) {
    if (!activeId) return;
    setSaving(true);
    const r = await projectDevApi.updateProject(activeId, { spec });
    setSaving(false);
    if (r.ok) { setSpecMap((m) => ({ ...m, [activeId]: spec })); showToast("已保存 spec"); reloadProjects(); }
    else showToast(r.error || "保存失败");
  }

  // ---------- 删除项目 ----------
  async function delProject(id) {
    if (!window.confirm("确认删除该项目？")) return;
    const r = await projectDevApi.deleteProject(id);
    if (r.ok) {
      const list = await reloadProjects();
      if (activeId === id) setActive(list[0]?.id || null);
      showToast("已删除");
    } else showToast(r.error || "删除失败");
  }

  const activeProject = projects.find((p) => p.id === activeId);
  const spec = specMap[activeId] || null;
  const runState = runMap[activeId] || { milestones: {}, status: "idle", sessionCostUsd: 0 };
  const stream = streamMap[activeId] || { thinking: "", text: "", tools: [] };
  const events = eventsMap[activeId] || [];
  const ps = PROJ_STATUS[runState.status] || PROJ_STATUS.idle;
  const editable = !["running"].includes(runState.status); // 运行中只读 spec
  const curMilestone = (spec?.milestones || []).find((m) => m.id === runState.currentMilestoneId);

  return (
    <div className="flex h-full bg-[#0f0f10] text-zinc-200">
      {/* ===== 左栏：项目列表 ===== */}
      <div className="w-60 shrink-0 border-r border-zinc-800 flex flex-col">
        <div className="px-3 py-2.5 border-b border-zinc-800 flex items-center justify-between">
          <span className="text-sm font-semibold text-zinc-200">项目开发</span>
          {isAdmin && (
            <button onClick={() => setShowNew(true)}
              className="px-2 py-1 text-[11px] rounded bg-blue-600 hover:bg-blue-500 text-white">＋新建</button>
          )}
        </div>
        <div className="flex-1 overflow-y-auto p-2 space-y-1">
          {projects.length === 0 && <div className="text-xs text-zinc-600 px-2 py-6 text-center">暂无项目</div>}
          {projects.map((p) => {
            const rs = runMap[p.id]?.status || p.status || "idle";
            const stt = PROJ_STATUS[rs] || PROJ_STATUS.idle;
            return (
              <div key={p.id}
                onClick={() => setActive(p.id)}
                className={`group px-2.5 py-2 rounded-lg cursor-pointer border transition-colors ${
                  activeId === p.id ? "border-zinc-600 bg-zinc-800" : "border-transparent hover:bg-zinc-800/50"}`}>
                <div className="flex items-center gap-2">
                  <span className={`w-2 h-2 rounded-full shrink-0 ${stt.dot}`} />
                  <span className="text-sm text-zinc-200 truncate flex-1">{p.name || "(未命名)"}</span>
                  {isAdmin && (
                    <button onClick={(e) => { e.stopPropagation(); delProject(p.id); }}
                      className="opacity-0 group-hover:opacity-100 text-[11px] text-zinc-500 hover:text-red-400">✕</button>
                  )}
                </div>
                <div className={`mt-1 inline-flex items-center px-1.5 py-0.5 rounded border text-[10px] ${stt.cls}`}>{stt.label}</div>
              </div>
            );
          })}
        </div>
      </div>

      {/* ===== 中栏：运行视图 ===== */}
      <div className="flex-1 min-w-0 flex flex-col">
        {!activeProject ? (
          <div className="flex-1 flex items-center justify-center text-zinc-600 text-sm">
            选择左侧项目，或点击「＋新建」创建无人值守编排项目
          </div>
        ) : (
          <>
            {/* 控制条 */}
            <div className="px-4 py-2.5 border-b border-zinc-800 flex items-center gap-2 flex-wrap shrink-0">
              <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded border text-[11px] ${ps.cls}`}>
                <span className={`w-1.5 h-1.5 rounded-full ${ps.dot}`} />{ps.label}
              </span>
              <span className="text-sm text-zinc-300 font-medium truncate max-w-[40%]">{activeProject.name}</span>
              <div className="flex-1" />
              {curMilestone && (
                <span className="text-[11px] text-zinc-500">当前里程碑：<span className="text-zinc-300">{curMilestone.title || curMilestone.id}</span></span>
              )}
              <span className="text-[11px] text-zinc-500">累计成本 <span className="text-amber-300 font-mono">${(runState.sessionCostUsd || 0).toFixed(4)}</span></span>
              {isAdmin && (
                <div className="flex items-center gap-1.5">
                  {(runState.status === "idle" || runState.status === "completed" || runState.status === "failed") && (
                    <button onClick={onStart} disabled={busy} className="px-2.5 py-1 text-[11px] rounded bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white">开始</button>
                  )}
                  {runState.status === "running" && (
                    <button onClick={onPause} disabled={busy} className="px-2.5 py-1 text-[11px] rounded bg-amber-600 hover:bg-amber-500 disabled:opacity-50 text-white">暂停</button>
                  )}
                  {(runState.status === "paused" || runState.status === "needs_human") && (
                    <button onClick={onResume} disabled={busy} className="px-2.5 py-1 text-[11px] rounded bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white">续跑</button>
                  )}
                  {(runState.status === "running" || runState.status === "paused" || runState.status === "needs_human") && (
                    <button onClick={onStop} disabled={busy} className="px-2.5 py-1 text-[11px] rounded bg-zinc-700 hover:bg-zinc-600 disabled:opacity-50 text-zinc-200">停止</button>
                  )}
                </div>
              )}
            </div>

            {/* needs_human 横幅 */}
            {runState.needsHuman && runState.status === "needs_human" && (
              <div className="mx-4 mt-3 rounded-lg border border-rose-500/40 bg-rose-500/10 px-3 py-2.5">
                <div className="flex items-center gap-2 text-rose-300 text-sm font-medium">
                  <span>⚠️ 需要人工介入</span>
                </div>
                <div className="mt-1 text-[12px] text-rose-200/90">{runState.needsHuman.reason}</div>
                {runState.needsHuman.failures?.length > 0 && (
                  <ul className="mt-1 text-[11px] text-rose-300/80 list-disc pl-4">
                    {runState.needsHuman.failures.map((f, i) => <li key={i}>{typeof f === "string" ? f : (f.label || f.type || JSON.stringify(f))}</li>)}
                  </ul>
                )}
                {runState.needsHuman.options?.length > 0 && (
                  <div className="mt-1.5 flex flex-wrap gap-1.5">
                    {runState.needsHuman.options.map((o, i) => (
                      <span key={i} className="text-[11px] px-1.5 py-0.5 rounded bg-rose-500/15 text-rose-200 border border-rose-500/30">{typeof o === "string" ? o : o.label}</span>
                    ))}
                  </div>
                )}
                {isAdmin && (
                  <div className="mt-2 flex items-center gap-2">
                    <button onClick={onResume} className="px-2.5 py-1 text-[11px] rounded bg-rose-600 hover:bg-rose-500 text-white">人工已处理，继续</button>
                    {spec?.gating === "per_milestone" && runState.currentMilestoneId && (
                      <button onClick={() => onApprove(runState.currentMilestoneId)} className="px-2.5 py-1 text-[11px] rounded bg-amber-600 hover:bg-amber-500 text-white">批准当前里程碑</button>
                    )}
                  </div>
                )}
              </div>
            )}

            <div className="flex-1 overflow-y-auto p-4 space-y-4">
              {/* 里程碑泳道 */}
              <div>
                <div className="text-xs font-medium text-zinc-400 mb-2">里程碑泳道</div>
                <MilestoneLane
                  milestones={spec?.milestones || []}
                  runtime={runState.milestones}
                  activeId={runState.currentMilestoneId}
                  onApprove={isAdmin ? onApprove : undefined}
                />
              </div>

              {/* AI 实时流 */}
              <div>
                <div className="text-xs font-medium text-zinc-400 mb-2 flex items-center gap-2">
                  AI 实时流
                  {curMilestone && <span className="text-[10px] text-zinc-600">· {curMilestone.title || curMilestone.id}</span>}
                </div>
                <div ref={streamScrollRef} className="border border-zinc-800 rounded-lg bg-zinc-950/50 p-3 max-h-[40vh] overflow-y-auto space-y-2">
                  {!stream.thinking && !stream.text && (!stream.tools || stream.tools.length === 0) && (
                    <div className="text-xs text-zinc-600 text-center py-4">暂无实时输出</div>
                  )}
                  {stream.thinking && (
                    <div className="text-[12px] text-zinc-500 italic whitespace-pre-wrap border-l-2 border-zinc-700 pl-2">{stream.thinking}</div>
                  )}
                  {stream.tools?.map((t, i) => (
                    <div key={i} className="text-[11px]">
                      <span className="px-1.5 py-0.5 rounded bg-violet-500/15 text-violet-300 border border-violet-500/30 font-mono">🔧 {t.name || "tool"}</span>
                      {t.text && <span className="ml-1.5 text-zinc-500 break-all">{String(t.text).slice(0, 200)}</span>}
                    </div>
                  ))}
                  {stream.text && (
                    <div className="text-[13px] text-zinc-200"><Markdown breaks>{stream.text}</Markdown></div>
                  )}
                </div>
              </div>

              {/* 事件日志 */}
              <div>
                <button onClick={() => setEventsOpen((o) => !o)} className="text-xs font-medium text-zinc-400 hover:text-zinc-200 flex items-center gap-1">
                  <span>{eventsOpen ? "▾" : "▸"}</span>事件日志（{events.length}）
                </button>
                {eventsOpen && (
                  <div className="mt-2 border border-zinc-800 rounded-lg bg-zinc-950/50 p-2 max-h-[30vh] overflow-y-auto space-y-0.5">
                    {events.length === 0 && <div className="text-xs text-zinc-600 text-center py-2">暂无事件</div>}
                    {events.map((e, i) => {
                      const ev = e.evt || e;
                      return (
                        <div key={i} className="text-[11px] font-mono text-zinc-500 flex gap-2">
                          <span className="text-zinc-700 shrink-0">{ev.type}</span>
                          <span className="text-zinc-600 truncate">{ev.id ? `#${ev.id}` : ""} {ev.title || ev.reason || ev.status || (ev.text ? String(ev.text).slice(0, 80) : "")}</span>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>
          </>
        )}
      </div>

      {/* ===== 右栏：Spec 编辑器 ===== */}
      <div className="w-[380px] shrink-0 border-l border-zinc-800 flex flex-col">
        {activeProject && spec ? (
          <SpecEditor spec={spec} onSave={saveSpec} saving={saving} readOnly={!editable || !isAdmin} />
        ) : (
          <div className="flex-1 flex items-center justify-center text-zinc-600 text-xs">选择项目以编辑 spec</div>
        )}
      </div>

      {/* 新建项目弹窗 */}
      {showNew && <NewProjectModal onClose={() => setShowNew(false)} onCreated={async (id) => { setShowNew(false); await reloadProjects(); setActive(id); }} showToast={showToast} />}

      {/* toast */}
      {toast && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 px-4 py-2 rounded-lg bg-zinc-800 border border-zinc-700 text-sm text-zinc-200 shadow-xl">
          {toast}
        </div>
      )}
    </div>
  );
}

// ---- 新建项目弹窗：名称 + 空白模板 / 粘贴 spec JSON ----
function NewProjectModal({ onClose, onCreated, showToast }) {
  const [name, setName] = useState("");
  const [tab, setTab] = useState("blank"); // blank | json
  const [jsonText, setJsonText] = useState(() => JSON.stringify(blankSpec(), null, 2));
  const [err, setErr] = useState("");
  const [creating, setCreating] = useState(false);

  async function create() {
    if (!name.trim()) { setErr("请填项目名称"); return; }
    let spec;
    if (tab === "blank") spec = blankSpec();
    else {
      try { spec = JSON.parse(jsonText); } catch (e) { setErr(`spec JSON 解析失败：${e.message}`); return; }
    }
    setErr(""); setCreating(true);
    const r = await projectDevApi.createProject({ name: name.trim(), spec });
    setCreating(false);
    if (r.ok && r.data) onCreated(r.data.id || r.data.projectId || r.data);
    else { setErr(r.error || "创建失败"); showToast && showToast(r.error || "创建失败"); }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70">
      <div className="bg-zinc-900 border border-zinc-700 rounded-xl w-[560px] max-h-[85vh] flex flex-col shadow-2xl">
        <div className="px-5 py-4 border-b border-zinc-800">
          <h2 className="text-base font-semibold text-zinc-100">新建项目</h2>
          <p className="text-xs text-zinc-500 mt-0.5">无人值守 AI 编排从零建项目</p>
        </div>
        <div className="px-5 py-4 space-y-3 overflow-y-auto">
          <div>
            <label className="block text-[11px] text-zinc-500 mb-1">项目名称</label>
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="例如：电商后台 v1"
              className="w-full bg-zinc-800 border border-zinc-700 rounded px-3 py-2 text-sm text-zinc-200 outline-none focus:border-zinc-500" />
          </div>
          <div className="flex gap-1">
            <button onClick={() => setTab("blank")} className={`px-3 py-1 text-xs rounded ${tab === "blank" ? "bg-zinc-700 text-white" : "bg-zinc-800 text-zinc-400"}`}>空白模板</button>
            <button onClick={() => setTab("json")} className={`px-3 py-1 text-xs rounded ${tab === "json" ? "bg-zinc-700 text-white" : "bg-zinc-800 text-zinc-400"}`}>粘贴 spec JSON</button>
          </div>
          {tab === "json" && (
            <textarea value={jsonText} onChange={(e) => setJsonText(e.target.value)} spellCheck={false} rows={12}
              className="w-full bg-zinc-950 border border-zinc-800 rounded p-2 text-[11px] font-mono text-zinc-200 outline-none focus:border-zinc-600 resize-y" />
          )}
          {tab === "blank" && <p className="text-xs text-zinc-600">将创建一个含 1 个里程碑的空白 spec，创建后在右栏编辑器继续完善。</p>}
          {err && <div className="text-[11px] text-red-400">{err}</div>}
        </div>
        <div className="px-5 py-3 border-t border-zinc-800 flex justify-end gap-2">
          <button onClick={onClose} className="px-3 py-1.5 text-xs rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-400">取消</button>
          <button onClick={create} disabled={creating} className="px-3 py-1.5 text-xs rounded bg-blue-600 hover:bg-blue-500 disabled:bg-zinc-700 disabled:text-zinc-500 text-white">{creating ? "创建中..." : "创建"}</button>
        </div>
      </div>
    </div>
  );
}
