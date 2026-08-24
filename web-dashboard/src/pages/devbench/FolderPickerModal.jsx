/**
 * 文件夹选择器（网页版）：浏览本机目录树、选一个文件夹。
 * Electron 桌面端优先用原生对话框（见调用方），此弹窗是通用 / Web 回退方案。
 */
import React, { useState, useEffect } from "react";
import { devbenchApi } from "./api.js";

export default function FolderPickerModal({ initialPath = "", title = "选择文件夹", onPick, onClose, zClassName = "z-[90]" }) {
  const [cur, setCur] = useState(initialPath || "");
  const [parent, setParent] = useState(null);
  const [dirs, setDirs] = useState([]);
  const [err, setErr] = useState("");
  const [loading, setLoading] = useState(false);

  async function browse(p) {
    setLoading(true); setErr("");
    const r = await devbenchApi.fsBrowse(p);
    setLoading(false);
    if (!r.ok) { setErr(r.error || "无法读取目录"); return; }
    setCur(r.data.path || "");
    setParent(r.data.parent);
    setDirs(r.data.dirs || []);
  }
  useEffect(() => { browse(initialPath || ""); /* eslint-disable-next-line */ }, []);
  useEffect(() => {
    const handleEscape = (event) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation?.();
      onClose?.();
    };
    window.addEventListener("keydown", handleEscape, true);
    return () => window.removeEventListener("keydown", handleEscape, true);
  }, [onClose]);

  return (
    <div className={`fixed inset-0 ${zClassName} flex items-center justify-center bg-black/50`} onClick={onClose}>
      <div className="w-[560px] max-w-[94vw] h-[60vh] flex flex-col bg-zinc-900 border border-zinc-700 rounded-xl shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="shrink-0 px-4 py-3 border-b border-zinc-800 flex items-center gap-2">
          <span className="text-sm font-semibold text-zinc-100">📁 {title}</span>
          <button onClick={onClose} className="ml-auto text-zinc-500 hover:text-zinc-200 text-sm px-1">✕</button>
        </div>
        <div className="shrink-0 px-4 py-2 border-b border-zinc-800 flex items-center gap-2">
          <button onClick={() => browse(parent ?? "")} disabled={parent === null}
            className="text-[11px] px-2 py-1 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-300 disabled:opacity-40 border border-zinc-700">⬆ 上级</button>
          <input value={cur} onChange={(e) => setCur(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") browse(cur); }}
            placeholder="可直接输入路径后回车跳转"
            className="flex-1 bg-zinc-950 border border-zinc-700 rounded px-2 py-1 text-xs text-zinc-200 font-mono outline-none focus:border-blue-500" />
          <button onClick={() => browse(cur)} className="text-[11px] px-2 py-1 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-300 border border-zinc-700">前往</button>
        </div>
        <div className="flex-1 overflow-y-auto px-2 py-2">
          {loading ? <div className="text-center text-zinc-600 text-xs py-8">读取中…</div>
            : err ? <div className="text-center text-amber-400 text-xs py-8">{err}</div>
            : dirs.length === 0 ? <div className="text-center text-zinc-600 text-xs py-8">（此目录下没有子文件夹）</div>
            : dirs.map((d) => (
              <button key={d.path} onClick={() => browse(d.path)} title={d.path}
                className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-zinc-200 hover:bg-zinc-800 rounded text-left transition">
                <span className="text-amber-300/80">📁</span>
                <span className="truncate">{d.name}</span>
              </button>
            ))}
        </div>
        <div className="shrink-0 px-4 py-3 border-t border-zinc-800 flex items-center gap-2">
          <span className="text-[10px] text-zinc-500 truncate flex-1" title={cur}>选中：{cur || "（请进入一个目录）"}</span>
          <button onClick={onClose} className="text-[12px] px-3 py-1.5 rounded text-zinc-400 hover:text-zinc-200">取消</button>
          <button onClick={() => { if (cur) { onPick?.(cur); onClose?.(); } }} disabled={!cur}
            className="text-[12px] px-3 py-1.5 rounded bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white">✓ 选此文件夹</button>
        </div>
      </div>
    </div>
  );
}
