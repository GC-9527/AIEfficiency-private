/**
 * 远程分支可搜索下拉 —— 按仓库类型(appMarket|appMarketSdk|webApp) ls-remote 拉取，输入实时过滤。
 * 车型源码配置 与 故事点「远程拉取」配置 共用。
 */
import React, { useEffect, useRef, useState } from "react";
import { devbenchApi } from "./api.js";

export default function RemoteBranchSelect({ repo, value, onChange, disabled, placeholder = "选择远程分支" }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [branches, setBranches] = useState([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState("");
  const [hi, setHi] = useState(0); // 键盘高亮项下标
  const inputRef = useRef(null);
  const listRef = useRef(null);
  const load = async (force) => {
    setLoading(true); setErr("");
    const r = await devbenchApi.remoteBranches(repo, force);
    setLoading(false);
    if (r.ok) setBranches(r.data || []); else setErr(r.error || "获取远程分支失败");
  };
  useEffect(() => {
    if (open) {
      if (!branches.length && !err) load(false);
      const t = setTimeout(() => inputRef.current?.focus(), 10);
      return () => clearTimeout(t);
    }
  }, [open]); // eslint-disable-line
  const ql = q.trim().toLowerCase();
  const list = branches.filter((b) => b.toLowerCase().includes(ql));
  const close = () => { setOpen(false); setQ(""); setHi(0); };
  const pick = (b) => { close(); onChange(b); };
  useEffect(() => { setHi(0); }, [q, open]); // 过滤变化时高亮回到首项
  useEffect(() => { // 高亮项滚动到可视区
    const el = listRef.current?.querySelector(`[data-idx="${hi}"]`);
    if (el) el.scrollIntoView({ block: "nearest" });
  }, [hi]);
  function onKey(e) {
    if (e.key === "Escape") { close(); return; }
    if (e.key === "ArrowDown") { e.preventDefault(); setHi((h) => Math.min(h + 1, Math.max(0, list.length - 1))); return; }
    if (e.key === "ArrowUp") { e.preventDefault(); setHi((h) => Math.max(0, h - 1)); return; }
    if (e.key === "Enter") { e.preventDefault(); const b = list[hi] || list[0]; if (b !== undefined) pick(b); return; }
  }
  return (
    <div className="relative flex-1 min-w-[150px]">
      <button type="button" onClick={() => !disabled && setOpen((v) => !v)} disabled={disabled}
        className="w-full flex items-center gap-1.5 bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-[11px] hover:border-zinc-500 disabled:opacity-50 transition">
        <span className={`flex-1 text-left font-mono truncate ${value ? "text-indigo-300" : "text-zinc-500"}`} title={value}>{value || placeholder}</span>
        <span className={`text-zinc-500 transition-transform ${open ? "rotate-180" : ""}`}>▾</span>
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-[80]" onClick={close} />
          <div className="absolute left-0 top-full mt-1 z-[90] w-[300px] max-w-[80vw] bg-zinc-900 border border-zinc-700 rounded-lg shadow-2xl">
            <div className="p-1.5 border-b border-zinc-800 flex items-center gap-1">
              <input ref={inputRef} value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={onKey}
                placeholder="过滤；↑↓ 选择，回车确认"
                className="flex-1 bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-[11px] text-zinc-100 placeholder-zinc-600 outline-none font-mono" />
              <button type="button" onClick={() => load(true)} title="重新拉取(ls-remote)"
                className="px-1.5 py-1 text-[11px] rounded bg-zinc-800 border border-zinc-700 text-zinc-400 hover:text-zinc-200">↻</button>
            </div>
            <div ref={listRef} className="max-h-64 overflow-auto py-1">
              {loading && <div className="px-2.5 py-2 text-[11px] text-zinc-500">拉取远程分支中…</div>}
              {err && <div className="px-2.5 py-2 text-[11px] text-red-400">{err}</div>}
              {value && <button type="button" onClick={() => pick("")} className="w-full text-left px-2.5 py-1 text-[11px] text-zinc-500 hover:bg-zinc-800">— 清空 —</button>}
              {!loading && !err && list.map((b, i) => (
                <button type="button" key={b} data-idx={i} onClick={() => pick(b)} onMouseEnter={() => setHi(i)}
                  className={`w-full text-left px-2.5 py-1 text-[11px] font-mono truncate ${i === hi ? "bg-zinc-700/70" : "hover:bg-zinc-800"} ${b === value ? "text-indigo-300" : "text-zinc-200"}`}
                  title={b}>{b === value ? "✓ " : ""}{b}</button>
              ))}
              {!loading && !err && !list.length && <div className="px-2.5 py-2 text-[11px] text-zinc-600">无匹配分支</div>}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
