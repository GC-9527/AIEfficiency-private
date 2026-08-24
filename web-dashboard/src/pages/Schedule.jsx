import React, { useState, useEffect } from "react";
import { getApiUrl } from "../services/gateway.js";
import { authenticatedFetch } from "../services/adminAuth.js";

const PRESETS = [
  { label: "每天 9:00", cron: "0 9 * * *" },
  { label: "每天 18:00", cron: "0 18 * * *" },
  { label: "每周一 9:00", cron: "0 9 * * 1" },
  { label: "每周五 17:00", cron: "0 17 * * 5" },
  { label: "每小时", cron: "0 * * * *" },
  { label: "每 30 分钟", cron: "*/30 * * * *" },
  { label: "自定义", cron: "" },
];

export default function Schedule() {
  const [tasks, setTasks] = useState([]);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ name: "", cronExpr: "0 9 * * *", prompt: "", engine: "", skill: "", outputTarget: "log", outputConfig: {} });
  const [preset, setPreset] = useState("0 9 * * *");
  const [toast, setToast] = useState(null);
  const [running, setRunning] = useState(null);

  const showToast = (msg, ok = true) => { setToast({ msg, ok }); setTimeout(() => setToast(null), 3000); };

  useEffect(() => { fetchTasks(); }, []);

  function fetchTasks() {
    authenticatedFetch(getApiUrl("/api/schedule"))
      .then(r => r.json())
      .then(d => { if (d.success) setTasks(d.data); })
      .catch(() => {});
  }

  async function createTask() {
    if (!form.name || !form.cronExpr || !form.prompt) {
      showToast("请填写名称、触发时间和任务内容", false);
      return;
    }
    try {
      const resp = await authenticatedFetch(getApiUrl("/api/schedule"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });
      const d = await resp.json();
      if (d.success) { showToast("定时任务已创建"); setShowForm(false); fetchTasks(); }
      else showToast(`创建失败: ${d.error}`, false);
    } catch (err) { showToast(`创建失败: ${err.message}`, false); }
  }

  async function toggleTask(id) {
    await authenticatedFetch(getApiUrl(`/api/schedule/${id}/toggle`), { method: "POST" });
    fetchTasks();
  }

  async function deleteTask(id) {
    await authenticatedFetch(getApiUrl(`/api/schedule/${id}`), { method: "DELETE" });
    fetchTasks();
  }

  async function runNow(id) {
    setRunning(id);
    await authenticatedFetch(getApiUrl(`/api/schedule/${id}/run`), { method: "POST" });
    showToast("已触发执行");
    setTimeout(() => { setRunning(null); fetchTasks(); }, 3000);
  }

  return (
    <div className="p-6 overflow-y-auto h-full space-y-6 relative">
      {toast && (
        <div className={`fixed top-4 right-4 z-50 px-4 py-2 rounded-lg text-sm shadow-lg ${
          toast.ok ? "bg-green-500/20 text-green-300 border border-green-500/30" : "bg-red-500/20 text-red-300 border border-red-500/30"
        }`}>{toast.msg}</div>
      )}

      <div className="flex items-center justify-between">
        <h2 className="text-sm font-medium text-zinc-300">定时任务</h2>
        <button onClick={() => { setShowForm(true); setForm({ name: "", cronExpr: "0 9 * * *", prompt: "", engine: "", skill: "", outputTarget: "log", outputConfig: {} }); setPreset("0 9 * * *"); }}
          className="px-3 py-1.5 text-xs rounded bg-blue-600 hover:bg-blue-500 text-white transition">
          新建任务
        </button>
      </div>

      {/* 任务列表 */}
      <div className="space-y-3">
        {tasks.length === 0 && <p className="text-xs text-zinc-600 text-center py-8">暂无定时任务</p>}
        {tasks.map(t => (
          <div key={t.id} className="bg-zinc-900 border border-zinc-800 rounded-xl p-4">
            <div className="flex items-center justify-between mb-2">
              <div className="flex items-center gap-3">
                <button onClick={() => toggleTask(t.id)}
                  className={`relative w-10 h-5 rounded-full transition shrink-0 ${t.enabled ? "bg-blue-600" : "bg-zinc-700"}`}>
                  <span className="absolute top-0.5 left-0.5 w-4 h-4 bg-white rounded-full transition-transform"
                    style={{ transform: t.enabled ? "translateX(20px)" : "translateX(0)" }} />
                </button>
                <span className="text-sm font-medium text-zinc-200">{t.name}</span>
                <code className="text-xs bg-zinc-800 text-zinc-500 px-2 py-0.5 rounded font-mono">{t.cron_expr}</code>
              </div>
              <div className="flex items-center gap-2">
                <button onClick={() => runNow(t.id)} disabled={running === t.id}
                  className="text-xs px-2 py-1 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-300 transition disabled:opacity-50">
                  {running === t.id ? "执行中..." : "立即执行"}
                </button>
                <button onClick={() => deleteTask(t.id)}
                  className="text-xs px-2 py-1 rounded text-red-400 hover:bg-red-500/10 transition">删除</button>
              </div>
            </div>
            <p className="text-xs text-zinc-500 line-clamp-2 mb-2">{t.prompt}</p>
            <div className="flex items-center gap-4 text-[10px] text-zinc-600">
              <span>引擎: {t.engine || "默认"}</span>
              <span>输出: {t.output_target || "log"}</span>
              {t.last_run_at && <span>上次: {t.last_run_at}</span>}
              {t.last_status && (
                <span className={t.last_status === "completed" ? "text-green-500" : t.last_status === "failed" ? "text-red-400" : "text-zinc-500"}>
                  {t.last_status}
                </span>
              )}
            </div>
            {t.last_output_excerpt && (
              <pre className="mt-2 bg-zinc-950 rounded px-2 py-1.5 text-[10px] text-zinc-500 max-h-20 overflow-y-auto whitespace-pre-wrap">{t.last_output_excerpt}</pre>
            )}
          </div>
        ))}
      </div>

      {/* 新建表单弹窗 */}
      {showForm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={() => setShowForm(false)}>
          <div className="bg-zinc-900 border border-zinc-700 rounded-xl w-[520px] max-h-[80vh] overflow-y-auto shadow-2xl" onClick={e => e.stopPropagation()}>
            <div className="px-5 py-4 border-b border-zinc-800">
              <h3 className="text-sm font-semibold text-zinc-200">新建定时任务</h3>
            </div>
            <div className="px-5 py-4 space-y-3">
              <div>
                <label className="text-[10px] text-zinc-500 mb-1 block">任务名称</label>
                <input value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
                  placeholder="如：每日资讯推送"
                  className="w-full bg-zinc-800 border border-zinc-700 rounded px-3 py-2 text-xs text-zinc-300 outline-none" />
              </div>
              <div>
                <label className="text-[10px] text-zinc-500 mb-1 block">触发时间</label>
                <div className="flex gap-2 flex-wrap mb-2">
                  {PRESETS.map(p => (
                    <button key={p.cron || "custom"} onClick={() => { setPreset(p.cron); if (p.cron) setForm(f => ({ ...f, cronExpr: p.cron })); }}
                      className={`text-xs px-2 py-1 rounded border transition ${preset === p.cron ? "border-blue-500 text-blue-400 bg-blue-500/10" : "border-zinc-700 text-zinc-500 hover:border-zinc-600"}`}>
                      {p.label}
                    </button>
                  ))}
                </div>
                <input value={form.cronExpr} onChange={e => { setForm(f => ({ ...f, cronExpr: e.target.value })); setPreset(""); }}
                  placeholder="cron 表达式，如 0 9 * * *"
                  className="w-full bg-zinc-800 border border-zinc-700 rounded px-3 py-2 text-xs text-zinc-300 outline-none font-mono" />
              </div>
              <div>
                <label className="text-[10px] text-zinc-500 mb-1 block">任务内容（AI Prompt）</label>
                <textarea value={form.prompt} onChange={e => setForm(f => ({ ...f, prompt: e.target.value }))}
                  rows={4} placeholder="如：搜索今天的 AI 领域新闻，整理成简报"
                  className="w-full bg-zinc-800 border border-zinc-700 rounded px-3 py-2 text-xs text-zinc-300 outline-none resize-none font-mono leading-relaxed" />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-[10px] text-zinc-500 mb-1 block">引擎（留空用默认）</label>
                  <select value={form.engine} onChange={e => setForm(f => ({ ...f, engine: e.target.value }))}
                    className="w-full bg-zinc-800 border border-zinc-700 rounded px-2 py-2 text-xs text-zinc-300">
                    <option value="">默认引擎</option>
                    <option value="claude">Claude</option>
                    <option value="gemini">Gemini</option>
                    <option value="codex">Codex</option>
                  </select>
                </div>
                <div>
                  <label className="text-[10px] text-zinc-500 mb-1 block">输出目标</label>
                  <select value={form.outputTarget} onChange={e => setForm(f => ({ ...f, outputTarget: e.target.value }))}
                    className="w-full bg-zinc-800 border border-zinc-700 rounded px-2 py-2 text-xs text-zinc-300">
                    <option value="log">仅日志</option>
                    <option value="dingtalk">钉钉机器人</option>
                    <option value="feishu">飞书</option>
                    <option value="save_file">保存文件</option>
                  </select>
                </div>
              </div>
            </div>
            <div className="px-5 py-3 border-t border-zinc-800 flex justify-end gap-2">
              <button onClick={() => setShowForm(false)} className="px-4 py-2 text-xs rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-400 transition">取消</button>
              <button onClick={createTask} className="px-4 py-2 text-xs rounded bg-blue-600 hover:bg-blue-500 text-white transition">创建</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
