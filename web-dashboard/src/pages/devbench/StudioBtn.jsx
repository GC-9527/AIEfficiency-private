/**
 * StudioBtn —— 用 Android Studio 打开工程目录。
 * 支持多版本选择（▾ 下拉），记住上次所选版本（localStorage）。
 * 在故事点头部、关联工程列表、Git Update 冲突处置等处复用。
 */
import React, { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { devbenchApi } from "./api.js";

export default function StudioBtn({ path, onToast, compact = false }) {
  const [busy, setBusy] = useState(false);
  const [menu, setMenu] = useState(false);
  const [list, setList] = useState(null); // 已装 AS 列表（菜单打开时刷新）
  const [studioCount, setStudioCount] = useState(null);
  const [choice, setChoice] = useState(() => { try { return localStorage.getItem("devbench_studio_choice") || ""; } catch { return ""; } });
  const anchorRef = useRef(null);
  const [menuPosition, setMenuPosition] = useState(null);
  useEffect(() => {
    if (!menu) return undefined;
    const handleEscape = (event) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation?.();
      setMenu(false);
    };
    window.addEventListener("keydown", handleEscape, true);
    return () => window.removeEventListener("keydown", handleEscape, true);
  }, [menu]);
  if (!path) return null;

  function rememberChoice(next) {
    if (!next) return;
    setChoice(next);
    try { localStorage.setItem("devbench_studio_choice", next); } catch {}
  }

  async function ensureList(force = false) {
    if (list && !force) return list;
    const r = await devbenchApi.listAndroidStudios();
    const arr = r?.ok ? (r.data || []) : [];
    setList(arr);
    setStudioCount(Number.isFinite(Number(r?.count)) ? Number(r.count) : arr.length);
    return arr;
  }
  async function open(studioPath, forceStudioPath = false) {
    setBusy(true); setMenu(false);
    const r = await devbenchApi.openInStudio(path, studioPath || undefined, forceStudioPath);
    setBusy(false);
    if (r?.ok) {
      if (Array.isArray(r.data?.studios)) setList(r.data.studios);
      if (Number.isFinite(Number(r.data?.count))) setStudioCount(Number(r.data.count));
      rememberChoice(r.data?.studio || studioPath);
      onToast?.("正在用 Android Studio 打开工程…");
    } else onToast?.(r?.error || "启动 Android Studio 失败");
  }
  async function toggleMenu(e) {
    e.stopPropagation();
    const arr = await ensureList(true);
    if (arr.length === 1) { open(arr[0]?.exe, true); return; } // 仅一个版本：直接打开
    const rect = anchorRef.current?.getBoundingClientRect();
    if (rect && typeof window !== "undefined") {
      const width = Math.min(280, window.innerWidth - 16);
      setMenuPosition({
        width,
        left: Math.max(8, Math.min(rect.right - width, window.innerWidth - width - 8)),
        top: Math.min(rect.bottom + 4, window.innerHeight - 240),
      });
    }
    setMenu((v) => !v);
  }
  const chosen = (list || []).find((s) => s.exe === choice);
  // compact：在紧凑场景（如 Git Update 冲突条）里用更小的字号/内边距
  const mainCls = compact
    ? "text-[10px] pl-1.5 pr-1 py-0.5 rounded-l bg-green-700/30 hover:bg-green-600/40 text-green-200 border border-green-700/40 border-r-0 transition disabled:opacity-50"
    : "text-[11px] pl-1.5 pr-1 py-0.5 rounded-l bg-green-700/30 hover:bg-green-600/40 text-green-200 border border-green-700/40 border-r-0 transition disabled:opacity-50";
  const caretCls = compact
    ? "text-[10px] px-1 py-0.5 rounded-r bg-green-700/30 hover:bg-green-600/40 text-green-200 border border-green-700/40 transition disabled:opacity-50"
    : "text-[11px] px-1 py-0.5 rounded-r bg-green-700/30 hover:bg-green-600/40 text-green-200 border border-green-700/40 transition disabled:opacity-50";

  const menuLayer = menu && typeof document !== "undefined" ? createPortal(
    <>
      <div className="fixed inset-0 z-[190]" onClick={(e) => { e.stopPropagation(); setMenu(false); }} />
      <div
        className="fixed z-[200] max-w-[calc(100vw-16px)] rounded-lg border border-zinc-700 bg-zinc-900 py-1 shadow-2xl"
        style={menuPosition || { width: 280, right: 8, top: 8 }}
      >
        <div className="border-b border-zinc-800 px-3 py-1 text-[10px] text-zinc-500">选择 Android Studio 版本{studioCount != null ? ` (${studioCount})` : ""}</div>
        {(list || []).length === 0 ? (
          <div className="px-3 py-2 text-[11px] text-amber-400">未找到 Android Studio</div>
        ) : (
          (list || []).map((s) => (
            <button key={s.exe} onClick={(e) => { e.stopPropagation(); open(s.exe, true); }}
              title={s.exe}
              className="flex w-full flex-col px-3 py-1.5 text-left transition hover:bg-zinc-800">
              <span className="flex items-center gap-1 text-[11px] text-zinc-100">
                {s.exe === choice && <span className="text-emerald-400">✓</span>}
                {s.label}
              </span>
              <span className="truncate text-[10px] text-zinc-500">{s.dir}{s.build ? ` · ${s.build}` : ""}</span>
            </button>
          ))
        )}
      </div>
    </>,
    document.body,
  ) : null;

  return (
    <span ref={anchorRef} className="relative inline-flex shrink-0">
      <button
        disabled={busy}
        onClick={(e) => { e.stopPropagation(); open(choice || undefined, !!choice); }}
        title={`用 Android Studio 打开工程${chosen ? `（${chosen.label}）` : ""}：${path}`}
        className={mainCls}
      >{busy ? "启动中…" : compact ? "🤖 AS" : "🤖 Android Studio"}</button>
      <button
        disabled={busy}
        onClick={toggleMenu}
        title="选择用哪个版本的 Android Studio 打开"
        className={caretCls}
      >▾</button>
      {menuLayer}
    </span>
  );
}
