import React, { useEffect, useState, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { createGatewayWebSocket, getApiUrl } from "../../services/gateway.js";
import { getAdminToken, useAdminSession } from "../../services/adminAuth.js";

const STATUS = {
  open: { t: "待处理", c: "bg-amber-900/30 text-amber-300" },
  in_progress: { t: "处理中", c: "bg-blue-900/30 text-blue-300" },
  resolved: { t: "已解决", c: "bg-emerald-900/30 text-emerald-300" },
  closed: { t: "已关闭", c: "bg-zinc-700 text-zinc-400" },
  wontfix: { t: "不修复", c: "bg-zinc-700 text-zinc-500" },
};
const PRIO = { low: "低", normal: "普通", high: "高" };
const authHeaders = () => { const t = getAdminToken(); return t ? { Authorization: `Bearer ${t}` } : {}; };

export default function Feedback() {
  const navigate = useNavigate();
  const adminSession = useAdminSession();
  const me = adminSession.principal;
  const isAdmin = adminSession.isAdmin && adminSession.canMutate;
  const myName = (typeof localStorage !== "undefined" && localStorage.getItem("feedback_reporter_name")) || "";

  const [list, setList] = useState([]);
  const [filter, setFilter] = useState({ status: "", mine: false, reporter: "" });
  const [sel, setSel] = useState(null);     // 选中的反馈单
  const [solveFor, setSolveFor] = useState(null);
  const [showDevCfg, setShowDevCfg] = useState(false);

  const load = useCallback(() => {
    const qs = new URLSearchParams();
    if (filter.status) qs.set("status", filter.status);
    if (filter.mine && myName) { qs.set("mine", "1"); qs.set("reporterId", myName); }
    else if (filter.reporter) qs.set("reporter", filter.reporter);
    fetch(getApiUrl(`/api/feedback?${qs}`)).then((r) => r.json()).then((d) => { if (d.ok) setList(d.data || []); }).catch(() => {});
  }, [filter, myName]);

  useEffect(() => { load(); }, [load]);

  // 监听服务端推送（状态变更/新评论/新反馈）→ 刷新
  useEffect(() => {
    let ws; try { ws = createGatewayWebSocket(); } catch { return; }
    ws.onmessage = (e) => { try { const m = JSON.parse(e.data); if (m.type === "feedback_update") { load(); if (sel && m.data?.id === sel.id) refreshOne(sel.id); } } catch {} };
    return () => { try { ws.close(); } catch {} };
  }, [load, sel]); // eslint-disable-line

  const refreshOne = (id) => fetch(getApiUrl(`/api/feedback/${id}`)).then((r) => r.json()).then((d) => { if (d.ok) setSel(d.data); });

  return (
    <div className="flex h-full">
      {/* 列表 */}
      <div className="w-[380px] shrink-0 border-r border-zinc-800 flex flex-col">
        <div className="p-3 border-b border-zinc-800 space-y-2">
          <div className="flex items-center gap-2">
            <button onClick={() => navigate("/feedback/new")} className="px-3 py-1.5 text-xs rounded bg-rose-600 hover:bg-rose-500 text-white">＋ 新建反馈</button>
            <button onClick={load} className="ml-auto text-[11px] px-2 py-1 rounded bg-zinc-800 border border-zinc-700 text-zinc-400 hover:text-zinc-200">↻ 刷新</button>
          </div>
          <div className="flex items-center gap-1.5 flex-wrap">
            <select value={filter.status} onChange={(e) => setFilter((f) => ({ ...f, status: e.target.value }))} className="bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-[11px] text-zinc-300">
              <option value="">全部状态</option>
              {Object.entries(STATUS).map(([k, v]) => <option key={k} value={k}>{v.t}</option>)}
            </select>
            <label className="flex items-center gap-1 text-[11px] text-zinc-400">
              <input type="checkbox" checked={filter.mine} onChange={(e) => setFilter((f) => ({ ...f, mine: e.target.checked }))} className="accent-rose-500" />只看我的
            </label>
            <input value={filter.reporter} onChange={(e) => setFilter((f) => ({ ...f, reporter: e.target.value, mine: false }))} placeholder="按提交人筛选"
              className="flex-1 min-w-[100px] bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-[11px] text-zinc-200 placeholder-zinc-600 outline-none" />
          </div>
        </div>
        <div className="flex-1 overflow-y-auto">
          {list.map((f) => (
            <button key={f.id} onClick={() => { setSel(f); refreshOne(f.id); }}
              className={`block w-full text-left px-3 py-2.5 border-b border-zinc-800/60 transition ${sel?.id === f.id ? "bg-zinc-800" : "hover:bg-zinc-800/50"}`}>
              <div className="flex items-center gap-2">
                <span className={`text-[10px] px-1.5 py-0.5 rounded ${STATUS[f.status]?.c || ""}`}>{STATUS[f.status]?.t || f.status}</span>
                {f.priority === "high" && <span className="text-[10px] text-red-400">●高</span>}
                <span className="flex-1 truncate text-[13px] text-zinc-200">{f.title}</span>
              </div>
              <div className="flex items-center gap-2 mt-1 text-[10px] text-zinc-600">
                <span>{f.reporter_name}</span><span>·</span><span>{new Date(f.ts).toLocaleString()}</span>
                {f.attachments?.length > 0 && <span>· 📎{f.attachments.length}</span>}
              </div>
            </button>
          ))}
          {!list.length && <div className="text-[11px] text-zinc-600 p-4 text-center">暂无反馈单</div>}
        </div>
      </div>

      {/* 详情 */}
      <div className="flex-1 overflow-y-auto">
        {/* 管理员设置入口行 */}
        {isAdmin && (
          <div className="flex items-center gap-2 px-5 py-2 border-b border-zinc-800 bg-zinc-900/60">
            <span className="text-[11px] text-emerald-400">🔓 管理员：{me.name}</span>
            <button onClick={() => setShowDevCfg(true)} className="ml-auto text-[11px] px-2.5 py-1 rounded bg-zinc-800 border border-zinc-700 text-zinc-300 hover:text-white">⚙ AI提效工程配置</button>
          </div>
        )}
        {sel ? (
          <FeedbackDetail fb={sel} isAdmin={isAdmin} me={me} onChanged={() => { refreshOne(sel.id); load(); }} onSolve={() => setSolveFor(sel)} />
        ) : (
          <div className="h-full flex items-center justify-center text-zinc-600 text-sm">选择左侧反馈单查看详情</div>
        )}
      </div>

      {solveFor && <SolvePanel fb={solveFor} onClose={() => { setSolveFor(null); refreshOne(sel?.id); }} />}
      {showDevCfg && <AIDevConfigModal onClose={() => setShowDevCfg(false)} />}
    </div>
  );
}

export function FeedbackDetail({ fb, isAdmin, me, onChanged, onSolve }) {
  const [comment, setComment] = useState("");
  const [busy, setBusy] = useState(false);

  const patch = async (body) => {
    setBusy(true);
    await fetch(getApiUrl(`/api/feedback/${fb.id}`), { method: "PUT", headers: { "Content-Type": "application/json", ...authHeaders() }, body: JSON.stringify(body) }).then((r) => r.json()).catch(() => {});
    setBusy(false); onChanged();
  };
  const sendComment = async () => {
    if (!comment.trim()) return;
    await fetch(getApiUrl(`/api/feedback/${fb.id}/comments`), { method: "POST", headers: { "Content-Type": "application/json", ...authHeaders() }, body: JSON.stringify({ text: comment.trim(), author: me?.name || localStorage.getItem("feedback_reporter_name") || "匿名" }) });
    setComment(""); onChanged();
  };

  return (
    <div className="p-5 space-y-4 max-w-3xl">
      <div>
        <div className="flex items-center gap-2 mb-1">
          <span className={`text-[10px] px-1.5 py-0.5 rounded ${STATUS[fb.status]?.c || ""}`}>{STATUS[fb.status]?.t || fb.status}</span>
          <span className="text-[10px] text-zinc-500">优先级 {PRIO[fb.priority] || fb.priority}</span>
          {fb.assignee && <span className="text-[10px] text-zinc-500">· 处理人 {fb.assignee}</span>}
        </div>
        <h2 className="text-base font-semibold text-zinc-100">{fb.title}</h2>
        <div className="text-[11px] text-zinc-600 mt-0.5">{fb.reporter_name} · {new Date(fb.ts).toLocaleString()} · 来自 {fb.page || "-"}</div>
      </div>
      {fb.body && <div className="text-sm text-zinc-300 whitespace-pre-wrap bg-zinc-800/40 rounded-lg p-3 border border-zinc-800">{fb.body}</div>}

      {/* 附件 */}
      {fb.attachments?.length > 0 && (
        <div>
          <div className="text-[11px] text-zinc-500 mb-1">附件</div>
          <div className="flex flex-wrap gap-2">
            {fb.attachments.map((a, i) => (
              <a key={i} href={getApiUrl(`/api/feedback/${fb.id}/attachments/${encodeURIComponent(a.name)}`)} target="_blank" rel="noreferrer"
                className="text-[12px] px-2 py-1 rounded bg-zinc-800 border border-zinc-700 text-blue-300 hover:bg-zinc-700">
                {a.kind === "image" ? "🖼" : a.kind === "zip" ? "🗜" : "📄"} {a.name} <span className="text-zinc-600">({(a.size / 1024).toFixed(0)}KB)</span>
              </a>
            ))}
          </div>
        </div>
      )}

      {/* 管理员操作 */}
      {isAdmin && (
        <div className="flex items-center gap-2 flex-wrap p-3 rounded-lg bg-zinc-800/40 border border-zinc-800">
          <select value={fb.status} onChange={(e) => patch({ status: e.target.value })} disabled={busy} className="bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-[11px] text-zinc-300">
            {Object.entries(STATUS).map(([k, v]) => <option key={k} value={k}>{v.t}</option>)}
          </select>
          <select value={fb.priority} onChange={(e) => patch({ priority: e.target.value })} disabled={busy} className="bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-[11px] text-zinc-300">
            {Object.entries(PRIO).map(([k, v]) => <option key={k} value={k}>优先级 {v}</option>)}
          </select>
          <button onClick={() => patch({ assignee: me?.name || "" })} disabled={busy} className="text-[11px] px-2 py-1 rounded bg-zinc-800 border border-zinc-700 text-zinc-300 hover:text-white">指派给我</button>
          <button onClick={onSolve} className="ml-auto text-[11px] px-3 py-1 rounded bg-violet-600 hover:bg-violet-500 text-white">🔧 去解决</button>
        </div>
      )}

      {/* 评论 */}
      <div>
        <div className="text-[11px] text-zinc-500 mb-1.5">处理记录 / 评论</div>
        <div className="space-y-2 mb-2">
          {(fb.comments || []).map((c, i) => (
            <div key={i} className="text-[12px] bg-zinc-800/40 rounded px-3 py-1.5 border border-zinc-800/60">
              <span className={`font-medium ${c.role === "admin" ? "text-violet-300" : "text-zinc-300"}`}>{c.author}</span>
              <span className="text-[10px] text-zinc-600 ml-2">{new Date(c.ts).toLocaleString()}</span>
              <div className="text-zinc-300 whitespace-pre-wrap mt-0.5">{c.text}</div>
            </div>
          ))}
          {!(fb.comments || []).length && <div className="text-[11px] text-zinc-600">暂无</div>}
        </div>
        <div className="flex gap-2">
          <input value={comment} onChange={(e) => setComment(e.target.value)} onKeyDown={(e) => e.key === "Enter" && sendComment()} placeholder="补充信息 / 回复…"
            className="flex-1 bg-zinc-800 border border-zinc-700 rounded px-3 py-1.5 text-[12px] text-zinc-200 placeholder-zinc-600 outline-none" />
          <button onClick={sendComment} className="px-3 py-1.5 text-[12px] rounded bg-zinc-700 hover:bg-zinc-600 text-zinc-100">发送</button>
        </div>
      </div>
    </div>
  );
}

// 管理员「去解决」：一键发 Claude 分析并修复，流式显示步骤
export function SolvePanel({ fb, onClose }) {
  const [project, setProject] = useState(fb.project || "default");
  const [steps, setSteps] = useState([]);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState(null);

  const start = () => {
    setRunning(true); setSteps([]); setResult(null);
    let ws; try { ws = createGatewayWebSocket(); } catch {}
    let myRun = null;
    if (ws) ws.onmessage = (e) => {
      try {
        const m = JSON.parse(e.data);
        if (m.type !== "feedback_solve_step" || m.data?.id !== fb.id) return;
        if (myRun && m.data.runId !== myRun) return;
        if (m.data.phase === "end") { setRunning(false); setResult(m.data.result); try { ws.close(); } catch {} }
        else setSteps((p) => [...p, m.data]);
      } catch {}
    };
    fetch(getApiUrl(`/api/feedback/${fb.id}/solve`), { method: "POST", headers: { "Content-Type": "application/json", ...authHeaders() }, body: JSON.stringify({ project }) })
      .then((r) => r.json()).then((d) => { if (d.ok) myRun = d.data.runId; else { setRunning(false); setResult({ ok: false, error: d.error }); } })
      .catch((e) => { setRunning(false); setResult({ ok: false, error: e.message }); });
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={onClose}>
      <div className="bg-zinc-900 border border-zinc-700 rounded-xl w-[640px] max-h-[88vh] overflow-y-auto shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="px-5 py-3.5 border-b border-zinc-800 flex items-center justify-between">
          <h3 className="text-sm font-semibold text-zinc-100">🔧 问题反馈解决 · 一键发 Claude 分析并修复</h3>
          <button onClick={onClose} className="text-zinc-500 hover:text-zinc-300 text-lg leading-none">×</button>
        </div>
        <div className="px-5 py-4 space-y-3">
          <div className="text-sm text-zinc-300"><b>{fb.title}</b></div>
          {fb.body && <div className="text-[12px] text-zinc-400 whitespace-pre-wrap bg-zinc-800/40 rounded p-2 border border-zinc-800 max-h-28 overflow-y-auto">{fb.body}</div>}
          <div className="flex items-center gap-2">
            <span className="text-[11px] text-zinc-500">关联工程(取「AI提效工程配置」里的 git 远程/分支/本地路径)：</span>
            <input value={project} onChange={(e) => setProject(e.target.value)} placeholder="default 或工程键"
              className="flex-1 bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-[12px] text-zinc-200 outline-none" />
            <button onClick={start} disabled={running} className="px-3 py-1.5 text-[12px] rounded bg-violet-600 hover:bg-violet-500 disabled:bg-zinc-700 text-white">{running ? "修复中…" : "🚀 发给 Claude"}</button>
          </div>
          <div className="bg-zinc-950 border border-zinc-800 rounded-lg p-2 max-h-72 overflow-y-auto space-y-1 font-mono text-[11px]">
            {steps.map((s, i) => (
              <div key={i} className="text-zinc-400">
                {s.phase === "think" && <span className="text-amber-400">🧠 {s.text}</span>}
                {s.phase === "exec" && <span className={s.ok ? "text-emerald-400" : "text-red-400"}>{s.ok ? "✓" : "✗"} {s.tool} {s.text || ""}</span>}
                {s.phase === "clone" && <span className="text-blue-400">⤓ {s.text}</span>}
                {!["think", "exec", "clone"].includes(s.phase) && <span>{s.text || JSON.stringify(s)}</span>}
              </div>
            ))}
            {!steps.length && !result && <div className="text-zinc-600">点击「发给 Claude」开始；进度实时显示。</div>}
            {result && <div className={`mt-2 ${result.ok ? "text-emerald-400" : "text-red-400"}`}>{result.ok ? `完成（${result.steps}步）：${result.summary || ""}` : `失败：${result.error}`}</div>}
          </div>
          <p className="text-[10px] text-zinc-600">需先在「AI提效工程配置」为该工程配好 git 远程+分支或本地路径。修复在服务端的工作副本内进行，结果写入反馈单评论。</p>
        </div>
      </div>
    </div>
  );
}

// AI提效工程配置：每个工程的 git 远程/分支/本地路径
function AIDevConfigModal({ onClose }) {
  const [cfg, setCfg] = useState({ projects: {} });
  const [msg, setMsg] = useState("");
  const [newKey, setNewKey] = useState("");
  useEffect(() => { fetch(getApiUrl("/api/feedback/dev-config")).then((r) => r.json()).then((d) => { if (d.ok) setCfg(d.data || { projects: {} }); }); }, []);
  const projs = Object.entries(cfg.projects || {});
  const setProj = (key, field, val) => setCfg((c) => ({ projects: { ...c.projects, [key]: { ...(c.projects[key] || {}), [field]: val } } }));
  const addProj = () => {
    const k = (newKey || "").trim() || "default";
    if (cfg.projects && cfg.projects[k]) { setMsg(`工程键「${k}」已存在`); setTimeout(() => setMsg(""), 2000); return; }
    setCfg((c) => ({ projects: { ...c.projects, [k]: { gitRemote: "", branch: "", localPath: "" } } }));
    setNewKey("");
  };
  const removeProj = (key) => setCfg((c) => { const p = { ...c.projects }; delete p[key]; return { projects: p }; });
  const save = async () => {
    const r = await fetch(getApiUrl("/api/feedback/dev-config"), { method: "PUT", headers: { "Content-Type": "application/json", ...authHeaders() }, body: JSON.stringify(cfg) }).then((x) => x.json()).catch(() => ({}));
    setMsg(r.ok ? "已保存" : (r.error || "保存失败")); setTimeout(() => setMsg(""), 2000);
  };
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={onClose}>
      <div className="bg-zinc-900 border border-zinc-700 rounded-xl w-[600px] max-h-[88vh] overflow-y-auto shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="px-5 py-3.5 border-b border-zinc-800 flex items-center justify-between">
          <h3 className="text-sm font-semibold text-zinc-100">⚙ AI提效工程配置</h3>
          <button onClick={onClose} className="text-zinc-500 hover:text-zinc-300 text-lg leading-none">×</button>
        </div>
        <div className="px-5 py-4 space-y-3">
          <p className="text-[11px] text-zinc-500">为每个工程配 git 远程 + 分支（或已克隆的本地路径），「去解决」一键发 Claude 时在该工程内分析修复。键名与反馈单的「关联工程」对应，留默认用 <code className="text-zinc-400">default</code>。</p>
          {projs.map(([key, p]) => (
            <div key={key} className="p-3 rounded-lg bg-zinc-800/40 border border-zinc-800 space-y-2">
              <div className="flex items-center">
                <div className="text-[12px] font-medium text-zinc-200">工程键：{key}</div>
                <button onClick={() => removeProj(key)} className="ml-auto text-[11px] text-zinc-600 hover:text-red-400">删除</button>
              </div>
              <input value={p.gitRemote || ""} onChange={(e) => setProj(key, "gitRemote", e.target.value)} placeholder="git 远程地址 git@... 或 https://..." className="w-full bg-zinc-800 border border-zinc-700 rounded px-2 py-1.5 text-[12px] text-zinc-200 placeholder-zinc-600 outline-none font-mono" />
              <div className="flex gap-2">
                <input value={p.branch || ""} onChange={(e) => setProj(key, "branch", e.target.value)} placeholder="分支（如 main）" className="w-40 bg-zinc-800 border border-zinc-700 rounded px-2 py-1.5 text-[12px] text-zinc-200 placeholder-zinc-600 outline-none font-mono" />
                <input value={p.localPath || ""} onChange={(e) => setProj(key, "localPath", e.target.value)} placeholder="本地路径（已克隆则优先用，留空则按远程克隆）" className="flex-1 bg-zinc-800 border border-zinc-700 rounded px-2 py-1.5 text-[12px] text-zinc-200 placeholder-zinc-600 outline-none font-mono" />
              </div>
            </div>
          ))}
          {!projs.length && <div className="text-[11px] text-zinc-600">还没有工程配置</div>}
          {/* 内联添加（替代原生 prompt：在 Electron 桌面版里 window.prompt 不可用） */}
          <div className="flex items-center gap-2 pt-1">
            <input value={newKey} onChange={(e) => setNewKey(e.target.value)} onKeyDown={(e) => e.key === "Enter" && addProj()}
              placeholder="新工程键（与反馈单「关联工程」对应，留空=default）"
              className="flex-1 bg-zinc-800 border border-zinc-700 rounded px-2 py-1.5 text-[12px] text-zinc-200 placeholder-zinc-600 outline-none font-mono" />
            <button onClick={addProj} className="text-[12px] px-3 py-1.5 rounded bg-zinc-700 hover:bg-zinc-600 text-zinc-100 shrink-0">＋ 添加工程</button>
          </div>
        </div>
        <div className="px-5 py-3 border-t border-zinc-800 flex items-center justify-end gap-2">
          {msg && <span className={`text-[11px] mr-auto ${msg === "已保存" ? "text-green-400" : "text-amber-400"}`}>{msg}</span>}
          <button onClick={onClose} className="px-3 py-1.5 text-xs rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-400">关闭</button>
          <button onClick={save} className="px-4 py-1.5 text-xs rounded bg-blue-600 hover:bg-blue-500 text-white">保存</button>
        </div>
      </div>
    </div>
  );
}
