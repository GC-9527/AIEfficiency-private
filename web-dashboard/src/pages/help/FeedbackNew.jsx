import React, { useState } from "react";
import { useNavigate } from "react-router-dom";
import { getApiUrl } from "../../services/gateway.js";
import { getAdminToken } from "../../services/adminAuth.js";
import { takeFeedbackDraft } from "./feedbackDraft.js";

const PRIORITY = [{ v: "low", t: "低" }, { v: "normal", t: "普通" }, { v: "high", t: "高" }];

// 独立「新建反馈」详情页（悬浮按钮跳转至此；也可由反馈列表「＋新建」进入）
export default function FeedbackNew() {
  const navigate = useNavigate();
  const [draft] = useState(() => takeFeedbackDraft() || { screenshot: null, attachments: [], fromPage: "" });
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [priority, setPriority] = useState("normal");
  const [name, setName] = useState(() => localStorage.getItem("feedback_reporter_name") || "");
  const [atts, setAtts] = useState(draft.attachments || []);
  const [extraNote, setExtraNote] = useState("");
  const [sending, setSending] = useState(false);
  const [msg, setMsg] = useState("");

  async function addFiles(files) {
    const list = [];
    for (const f of files) {
      const b64 = await new Promise((res) => { const fr = new FileReader(); fr.onload = () => res(String(fr.result).split(",")[1] || ""); fr.readAsDataURL(f); });
      list.push({ name: f.name, dataBase64: b64, kind: f.name.endsWith(".zip") ? "zip" : "file", size: f.size });
    }
    setAtts((p) => [...p, ...list]);
  }
  const removeAtt = (i) => setAtts((p) => p.filter((_, idx) => idx !== i));

  const [dayPick, setDayPick] = useState(() => { const d = new Date(); d.setDate(d.getDate() - 1); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; }); // 默认昨天(本地日期)
  async function addDayLogs() {
    if (!dayPick) return;
    const r = await fetch(getApiUrl(`/api/logs?date=${dayPick}`)).then((x) => x.json()).catch(() => null);
    const logs = (r && (r.data || r.logs)) || [];
    const text = logs.map((l) => `[${new Date(l.created_at || l.ts || Date.now()).toLocaleString()}] ${l.level || ""} ${l.module || ""} ${l.message || ""}`).join("\n") || `(${dayPick} 无日志)`;
    const b64 = btoa(unescape(encodeURIComponent(text)));
    setAtts((p) => [...p.filter((a) => a.name !== `logs-${dayPick}.txt`), { name: `logs-${dayPick}.txt`, dataBase64: b64, kind: "log", size: text.length }]);
  }

  async function submit() {
    if (!title.trim()) { setMsg("请填标题"); return; }
    setSending(true); setMsg("");
    localStorage.setItem("feedback_reporter_name", name.trim());
    const attachments = [...atts];
    if (extraNote.trim()) attachments.push({ name: "补充说明.txt", dataBase64: btoa(unescape(encodeURIComponent(extraNote))), kind: "file", size: extraNote.length });
    const token = getAdminToken();
    try {
      const r = await fetch(getApiUrl("/api/feedback"), {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify({ title: title.trim(), body, priority, page: draft.fromPage || "", reporterName: name.trim() || "匿名", reporterId: name.trim() || "匿名", attachments }),
      }).then((x) => x.json());
      if (r.ok) { setMsg("已提交！"); setTimeout(() => navigate(`/feedback/${encodeURIComponent(r.data.id)}`), 500); }
      else { setMsg(r.error || "提交失败"); setSending(false); }
    } catch (e) { setMsg("提交失败：" + e.message); setSending(false); }
  }

  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-2xl mx-auto px-6 py-6 space-y-4">
        <div className="flex items-center gap-2">
          <button onClick={() => navigate("/help?tab=feedback")} className="text-[12px] text-zinc-500 hover:text-zinc-300">← 返回反馈列表</button>
          <h2 className="text-base font-semibold text-zinc-100 ml-1">🐞 新建反馈</h2>
        </div>

        <div className="grid grid-cols-3 gap-2">
          <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="标题（必填，一句话描述问题）"
            className="col-span-2 bg-zinc-800 border border-zinc-700 rounded px-3 py-2 text-sm text-zinc-200 placeholder-zinc-600 outline-none" />
          <select value={priority} onChange={(e) => setPriority(e.target.value)} className="bg-zinc-800 border border-zinc-700 rounded px-2 py-2 text-sm text-zinc-300">
            {PRIORITY.map((p) => <option key={p.v} value={p.v}>优先级：{p.t}</option>)}
          </select>
        </div>
        <textarea value={body} onChange={(e) => setBody(e.target.value)} rows={5} placeholder="详细描述：复现步骤 / 期望 / 实际现象"
          className="w-full bg-zinc-800 border border-zinc-700 rounded px-3 py-2 text-sm text-zinc-200 placeholder-zinc-600 outline-none resize-none" />
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="你的称呼（用于筛选；可填钉钉/TB 名）"
          className="w-full bg-zinc-800 border border-zinc-700 rounded px-3 py-2 text-sm text-zinc-200 placeholder-zinc-600 outline-none" />

        {draft.screenshot && (
          <div>
            <div className="text-[11px] text-zinc-500 mb-1">截图预览（来自 {draft.fromPage || "当前页"}）</div>
            <img src={draft.screenshot} alt="screenshot" className="max-h-56 rounded border border-zinc-700" />
          </div>
        )}

        <div>
          <div className="flex items-center justify-between mb-1">
            <span className="text-[11px] text-zinc-400">附件（已自动附当天操作日志诊断包，可删除/补充昨天日志等）</span>
            <div className="flex items-center gap-1.5">
              <input type="date" value={dayPick} onChange={(e) => setDayPick(e.target.value)} className="bg-zinc-800 border border-zinc-700 rounded px-1.5 py-0.5 text-[11px] text-zinc-300 outline-none" />
              <button onClick={addDayLogs} className="text-[11px] px-2 py-0.5 rounded bg-zinc-800 border border-zinc-700 text-zinc-300 hover:text-white">＋ 补该天日志</button>
              <label className="text-[11px] px-2 py-0.5 rounded bg-zinc-800 border border-zinc-700 text-zinc-300 hover:text-white cursor-pointer">
                ＋ 文件<input type="file" multiple className="hidden" onChange={(e) => addFiles([...e.target.files])} />
              </label>
            </div>
          </div>
          <div className="space-y-1">
            {atts.map((a, i) => (
              <div key={i} className="flex items-center gap-2 text-[12px] bg-zinc-800/60 border border-zinc-700/60 rounded px-2 py-1">
                <span className="text-zinc-300">{a.kind === "image" ? "🖼" : a.kind === "zip" ? "🗜" : "📄"}</span>
                <span className="flex-1 truncate text-zinc-300">{a.name}</span>
                <span className="text-[10px] text-zinc-600">{(a.size / 1024).toFixed(0)}KB</span>
                <button onClick={() => removeAtt(i)} className="text-zinc-500 hover:text-red-400">✕</button>
              </div>
            ))}
            {!atts.length && <div className="text-[11px] text-zinc-600">无附件</div>}
          </div>
          <textarea value={extraNote} onChange={(e) => setExtraNote(e.target.value)} rows={2} placeholder="额外日志/补充说明（会作为 补充说明.txt 附上）"
            className="w-full mt-1.5 bg-zinc-800 border border-zinc-700 rounded px-3 py-1.5 text-[12px] text-zinc-200 placeholder-zinc-600 outline-none resize-none" />
        </div>

        <div className="flex items-center justify-end gap-2 pt-1">
          {msg && <span className={`text-[12px] mr-auto ${msg.includes("已提交") ? "text-green-400" : "text-amber-400"}`}>{msg}</span>}
          <button onClick={() => navigate("/help?tab=feedback")} className="px-3 py-1.5 text-xs rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-400">取消</button>
          <button onClick={submit} disabled={sending} className="px-4 py-1.5 text-xs rounded bg-rose-600 hover:bg-rose-500 disabled:bg-zinc-700 text-white">{sending ? "提交中…" : "提交反馈"}</button>
        </div>
      </div>
    </div>
  );
}
