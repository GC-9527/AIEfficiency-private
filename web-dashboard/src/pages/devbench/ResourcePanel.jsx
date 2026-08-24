/**
 * 资源管理面板 —— 故事点各工程的文件目录树（类似 VS Code / Android Studio）
 * 支持：展开/收起、选中、复制绝对路径、复制文件/文件夹、粘贴到选中目录、在资源管理器打开目录。
 */
import React, { useState, useCallback } from "react";
import { devbenchApi } from "./api.js";
import { copyToClipboard } from "../../utils/clipboard.js";

export default function ResourcePanel({ tabId, roots, onClose, onToast }) {
  const [expanded, setExpanded] = useState(new Set());
  const [children, setChildren] = useState({}); // path -> entries[]
  const [loading, setLoading] = useState(new Set());
  const [selected, setSelected] = useState(null); // { path, name, isDir }
  const [clip, setClip] = useState(null); // 复制的源 { path, name }
  const [copiedPath, setCopiedPath] = useState("");

  const toast = (m) => onToast?.(m);

  const loadChildren = useCallback(async (p) => {
    setLoading((s) => new Set(s).add(p));
    const r = await devbenchApi.fsList(tabId, p);
    setLoading((s) => { const n = new Set(s); n.delete(p); return n; });
    if (r.ok) setChildren((m) => ({ ...m, [p]: r.data }));
    else toast(r.error || "读取目录失败");
  }, [tabId]);

  function toggle(p) {
    setExpanded((s) => {
      const n = new Set(s);
      if (n.has(p)) n.delete(p);
      else { n.add(p); if (!children[p]) loadChildren(p); }
      return n;
    });
  }

  async function refresh(p) {
    await loadChildren(p);
  }

  async function doCopyPath(p) {
    await copyToClipboard(p);
    setCopiedPath(p);
    setTimeout(() => setCopiedPath((c) => (c === p ? "" : c)), 1200);
  }

  async function doPaste() {
    if (!clip || !selected?.isDir) return;
    const r = await devbenchApi.fsCopy(tabId, clip.path, selected.path);
    if (!r.ok) { toast(r.error || "粘贴失败"); return; }
    // 刷新目标目录并展开
    setExpanded((s) => new Set(s).add(selected.path));
    await loadChildren(selected.path);
    toast(`已复制到 ${r.data.name}`);
  }

  // 递归节点
  function Node({ entry, depth }) {
    const isExp = expanded.has(entry.path);
    const isSel = selected?.path === entry.path;
    const kids = children[entry.path];
    return (
      <div>
        <div
          onClick={() => setSelected(entry)}
          className={`group flex items-center gap-1 pr-1 py-0.5 cursor-pointer text-[12px] rounded ${isSel ? "bg-blue-600/30 text-white" : "text-zinc-300 hover:bg-zinc-800"}`}
          style={{ paddingLeft: depth * 12 + 4 }}
          title={entry.path}
        >
          {entry.isDir ? (
            <span onClick={(e) => { e.stopPropagation(); toggle(entry.path); }} className="w-3 shrink-0 text-zinc-500 hover:text-zinc-200 text-center">
              {isExp ? "▾" : "▸"}
            </span>
          ) : <span className="w-3 shrink-0" />}
          <span className="shrink-0">{entry.isDir ? (isExp ? "📂" : "📁") : "📄"}</span>
          <span className="truncate flex-1">{entry.name}</span>
          {/* 行内快捷操作 */}
          <span className="opacity-0 group-hover:opacity-100 flex items-center gap-1 shrink-0">
            <button onClick={(e) => { e.stopPropagation(); doCopyPath(entry.path); }} title="复制绝对路径"
              className="text-[10px] text-zinc-400 hover:text-zinc-100 px-0.5">{copiedPath === entry.path ? "✓" : "⧉"}</button>
            <button onClick={(e) => { e.stopPropagation(); setClip({ path: entry.path, name: entry.name }); toast(`已复制：${entry.name}`); }} title="复制（用于粘贴）"
              className="text-[10px] text-zinc-400 hover:text-blue-300 px-0.5">复制</button>
            {entry.isDir && (
              <button onClick={(e) => { e.stopPropagation(); devbenchApi.openDir(entry.path); }} title="在资源管理器中打开"
                className="text-[10px] text-zinc-400 hover:text-amber-300 px-0.5">📂</button>
            )}
          </span>
        </div>
        {entry.isDir && isExp && (
          <div>
            {loading.has(entry.path) && <div style={{ paddingLeft: (depth + 1) * 12 + 16 }} className="text-[11px] text-zinc-600 py-0.5">加载中…</div>}
            {kids && kids.length === 0 && <div style={{ paddingLeft: (depth + 1) * 12 + 16 }} className="text-[11px] text-zinc-600 py-0.5">（空）</div>}
            {kids && kids.map((c) => <Node key={c.path} entry={c} depth={depth + 1} />)}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="absolute top-3 right-14 bottom-3 z-20 w-[24rem] flex flex-col bg-zinc-900/97 border border-zinc-700 rounded-lg shadow-2xl backdrop-blur">
      {/* 头部 */}
      <div className="px-3 py-2 border-b border-zinc-800 flex items-center justify-between shrink-0">
        <span className="text-[11px] text-zinc-300">资源管理（{roots.length} 个工程）</span>
        <button onClick={onClose} className="text-zinc-500 hover:text-zinc-200 text-xs">✕</button>
      </div>

      {/* 操作条 */}
      <div className="px-2 py-1.5 border-b border-zinc-800 flex items-center gap-1 shrink-0 flex-wrap">
        <button disabled={!selected} onClick={() => selected && doCopyPath(selected.path)}
          className="text-[10px] px-1.5 py-0.5 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-300 disabled:opacity-40">复制路径</button>
        <button disabled={!selected} onClick={() => selected && (setClip({ path: selected.path, name: selected.name }), toast(`已复制：${selected.name}`))}
          className="text-[10px] px-1.5 py-0.5 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-300 disabled:opacity-40">复制</button>
        <button disabled={!clip || !selected?.isDir} onClick={doPaste}
          className="text-[10px] px-1.5 py-0.5 rounded bg-blue-700/60 hover:bg-blue-600 text-white disabled:opacity-40"
          title={clip ? `粘贴「${clip.name}」到选中目录` : "先复制一个文件/文件夹"}>粘贴</button>
        <button disabled={!selected?.isDir} onClick={() => selected && devbenchApi.openDir(selected.path)}
          className="text-[10px] px-1.5 py-0.5 rounded bg-zinc-800 hover:bg-zinc-700 text-amber-300 disabled:opacity-40">在资源管理器打开</button>
        {clip && <span className="text-[10px] text-zinc-500 ml-auto truncate max-w-[120px]" title={clip.path}>剪贴板：{clip.name}</span>}
      </div>

      {/* 树 */}
      <div className="flex-1 overflow-auto py-1">
        {roots.map((r) => (
          <div key={r.path} className="mb-1">
            <div className="px-2 py-0.5 flex items-center gap-1">
              <span className={`text-[9px] px-1 rounded ${r.role === "primary" ? "bg-emerald-600/30 text-emerald-300" : r.role === "webapp" ? "bg-sky-600/30 text-sky-300" : "bg-zinc-700 text-zinc-300"}`}>{r.name}</span>
              <button onClick={() => refresh(r.path)} className="text-[10px] text-zinc-600 hover:text-zinc-300" title="刷新">↻</button>
            </div>
            <Node entry={{ name: r.name, path: r.path, isDir: true }} depth={0} />
          </div>
        ))}
        {roots.length === 0 && <div className="text-center text-[11px] text-zinc-600 mt-6">未选择工程</div>}
      </div>
    </div>
  );
}
