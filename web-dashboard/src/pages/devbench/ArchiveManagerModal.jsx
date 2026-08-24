import React, { useEffect, useMemo, useState } from "react";
import { devbenchApi } from "./api.js";
import FolderPickerModal from "./FolderPickerModal.jsx";

function fmtDate(ts) {
  if (!ts) return "-";
  const d = new Date(Number(ts));
  if (Number.isNaN(d.getTime())) return "-";
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function fmtSize(bytes) {
  const n = Number(bytes) || 0;
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  if (n >= 1024) return `${Math.round(n / 1024)} KB`;
  return `${n} B`;
}

export default function ArchiveManagerModal({ tab, live, onClose, onToast, onRefreshTab, onMessagesRestored, onArchived }) {
  const initialDir = tab.effectiveArchiveDir || tab.archiveDir || tab.defaultArchiveDir || "";
  const [dir, setDir] = useState(initialDir);
  const [savedDir, setSavedDir] = useState(initialDir);
  const [archives, setArchives] = useState([]);
  const [selectedPath, setSelectedPath] = useState("");
  const [busy, setBusy] = useState("");
  const [err, setErr] = useState("");
  const [showPicker, setShowPicker] = useState(false);

  const selected = useMemo(() => archives.find((a) => a.path === selectedPath) || archives[0] || null, [archives, selectedPath]);
  const dirty = String(dir || "") !== String(savedDir || "");

  async function loadArchives(nextDir = dir) {
    if (!nextDir) return;
    setBusy("scan"); setErr("");
    const r = await devbenchApi.listArchiveFiles(tab.id, nextDir);
    setBusy("");
    if (!r.ok) { setErr(r.error || "读取存档目录失败"); setArchives([]); return; }
    const list = r.data?.archives || [];
    setArchives(list);
    setSelectedPath((cur) => (cur && list.some((x) => x.path === cur)) ? cur : (list[0]?.path || ""));
  }

  async function saveDir(nextDir = dir) {
    setBusy("save"); setErr("");
    const r = await devbenchApi.setArchiveDir(tab.id, nextDir);
    setBusy("");
    if (!r.ok) { setErr(r.error || "保存存档目录失败"); return false; }
    const effective = r.data?.effectiveArchiveDir || nextDir;
    setDir(effective);
    setSavedDir(effective);
    onRefreshTab?.();
    return true;
  }

  async function runArchive() {
    if (dirty && !(await saveDir(dir))) return;
    setBusy("archive"); setErr("");
    const r = await devbenchApi.exportArchive(tab.id, live);
    setBusy("");
    if (!r.ok) { setErr(r.error || "存档失败"); return; }
    onToast?.(`已存档 ${r.data.count} 条会话历史到「${r.data.name}」${r.data.liveIncluded ? "（含当前回答中快照）" : ""}`);
    onArchived?.();
    onRefreshTab?.();
    await loadArchives(dir);
  }

  async function restoreSelected() {
    if (!selected || selected.tooLarge) return;
    const ok = window.confirm(`从「${selected.name}」还原会话？\n当前页面会话消息会被替换，工程配置保留。`);
    if (!ok) return;
    if (dirty && !(await saveDir(dir))) return;
    setBusy("restore"); setErr("");
    const r = await devbenchApi.restoreArchive(tab.id, selected.path, "replace");
    setBusy("");
    if (!r.ok) { setErr(r.error || "还原失败"); return; }
    onToast?.(`已还原 ${r.data.imported} 条消息`);
    onMessagesRestored?.(tab.id);
    onRefreshTab?.();
    onClose?.();
  }

  useEffect(() => {
    setDir(initialDir);
    setSavedDir(initialDir);
    if (initialDir) loadArchives(initialDir);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab.id, initialDir]);

  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/65" onClick={onClose}>
      <div className="w-[860px] max-w-[94vw] max-h-[86vh] flex flex-col bg-zinc-900 border border-zinc-700 rounded-xl shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="px-5 py-4 border-b border-zinc-800 flex items-center gap-3">
          <div className="min-w-0">
            <h2 className="text-sm font-semibold text-zinc-100">全量存档</h2>
            <div className="text-[11px] text-zinc-500 truncate font-mono" title={tab.archiveFile || ""}>{tab.archiveFile || "尚未生成存档文件"}</div>
          </div>
          <button onClick={() => loadArchives()} disabled={busy === "scan"} className="ml-auto px-2.5 py-1 text-[11px] rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-300 disabled:opacity-60">刷新</button>
          <button onClick={onClose} className="text-zinc-500 hover:text-zinc-200 text-lg leading-none">x</button>
        </div>

        <div className="px-5 py-4 border-b border-zinc-800 space-y-2">
          <div className="flex items-center gap-2">
            <span className="text-[11px] text-zinc-500 shrink-0">存档目录</span>
            <input
              value={dir}
              onChange={(e) => setDir(e.target.value)}
              className="flex-1 min-w-0 bg-zinc-950 border border-zinc-700 rounded px-2 py-1.5 text-[11px] text-zinc-200 font-mono outline-none focus:border-blue-500"
            />
            <button onClick={() => setShowPicker(true)} className="px-2.5 py-1.5 text-[11px] rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-200 border border-zinc-700">选择</button>
            <button onClick={() => saveDir("")} disabled={busy === "save"} className="px-2.5 py-1.5 text-[11px] rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-400 border border-zinc-700 disabled:opacity-60">默认</button>
            <button onClick={() => saveDir(dir)} disabled={!dirty || busy === "save"} className="px-2.5 py-1.5 text-[11px] rounded bg-blue-600 hover:bg-blue-500 text-white disabled:bg-zinc-700 disabled:text-zinc-500">保存</button>
          </div>
          <p className="text-[10px] text-zinc-600">写入目录仅允许位于当前故事点的 AllDocs/StoryDev/.../ask 目录内，避免污染源码 worktree。</p>
          <div className="flex items-center gap-2">
            <button onClick={runArchive} disabled={!!busy} className="px-3 py-1.5 text-[12px] rounded bg-emerald-600 hover:bg-emerald-500 text-white disabled:opacity-60">{busy === "archive" ? "存档中…" : "执行全量存档"}</button>
            <button onClick={restoreSelected} disabled={!selected || selected.tooLarge || !!busy} className="px-3 py-1.5 text-[12px] rounded bg-indigo-600 hover:bg-indigo-500 text-white disabled:bg-zinc-700 disabled:text-zinc-500">还原所选会话</button>
            {live?.streaming && live?.text && <span className="text-[11px] text-amber-300">将同时保存当前回答中已显示的内容</span>}
            {err && <span className="text-[11px] text-red-400 truncate">{err}</span>}
          </div>
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto p-4 space-y-2">
          {busy === "scan" && <div className="text-[12px] text-zinc-500 text-center py-8">读取中...</div>}
          {busy !== "scan" && !archives.length && <div className="text-[12px] text-zinc-500 text-center py-8">当前目录下没有可还原存档</div>}
          {busy !== "scan" && archives.map((a) => (
            <button
              key={a.path}
              type="button"
              onClick={() => setSelectedPath(a.path)}
              disabled={a.tooLarge}
              className={`w-full text-left px-3 py-2 border rounded-lg transition ${selected?.path === a.path ? "border-indigo-500 bg-indigo-950/30" : "border-zinc-800 bg-zinc-950/50 hover:bg-zinc-800/70"} ${a.tooLarge ? "opacity-55 cursor-not-allowed" : ""}`}
              title={a.path}
            >
              <div className="flex items-center gap-2 min-w-0">
                <span className="text-[12px] text-zinc-100 truncate">{a.title}</span>
                <span className="ml-auto shrink-0 text-[10px] text-zinc-500 font-mono">{fmtDate(a.mtime)}</span>
              </div>
              <div className="mt-1 flex flex-wrap gap-2 text-[10px] text-zinc-500">
                <span>{a.turnCount || 0} 轮</span>
                <span>{a.messageCount || 0} 条消息</span>
                <span>{fmtSize(a.size)}</span>
                {a.tooLarge && <span className="text-amber-300">文件过大</span>}
              </div>
              <div className="mt-1 text-[10px] text-zinc-600 truncate font-mono">{a.path}</div>
            </button>
          ))}
        </div>
      </div>
      {showPicker && (
        <FolderPickerModal
          initialPath={dir || tab.defaultArchiveDir || ""}
          title="选择存档目录"
          onPick={(p) => { setDir(p); saveDir(p).then((ok) => { if (ok) loadArchives(p); }); }}
          onClose={() => setShowPicker(false)}
        />
      )}
    </div>
  );
}
