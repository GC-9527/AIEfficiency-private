import React, { useEffect, useMemo, useState } from "react";
import { devbenchApi } from "./api.js";
import FolderPickerModal from "./FolderPickerModal.jsx";

function fmtDate(ts) {
  const date = new Date(Number(ts));
  if (Number.isNaN(date.getTime())) return "-";
  const pad = (value) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function fmtSize(bytes) {
  const value = Number(bytes) || 0;
  if (value >= 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)} MB`;
  if (value >= 1024) return `${Math.round(value / 1024)} KB`;
  return `${value} B`;
}

export default function ConversationBackupModal({
  tab,
  live,
  mode = "backup",
  isRunning = false,
  onClose,
  onToast,
  onMessagesRestored,
  onRefreshTab,
}) {
  const initialDir = tab.effectiveArchiveDir || tab.archiveDir || tab.defaultArchiveDir || "";
  const [dir, setDir] = useState(initialDir);
  const [backups, setBackups] = useState([]);
  const [selectedPath, setSelectedPath] = useState("");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [showPicker, setShowPicker] = useState(false);
  const restoreMode = mode === "restore";
  const selected = useMemo(
    () => backups.find((backup) => backup.path === selectedPath) || backups.find((backup) => backup.restorable) || null,
    [backups, selectedPath],
  );

  async function loadBackups(nextDir = dir) {
    if (!nextDir) { setBackups([]); return; }
    setBusy("scan"); setError("");
    const result = await devbenchApi.listConversationBackups(tab.id, nextDir);
    setBusy("");
    if (!result?.ok) {
      setError(result?.error || "读取完整对话备份失败");
      setBackups([]);
      return;
    }
    const list = result.data?.backups || [];
    setBackups(list);
    setSelectedPath((current) => (
      current && list.some((item) => item.path === current && item.restorable)
        ? current
        : (list.find((item) => item.restorable)?.path || "")
    ));
  }

  async function createBackup() {
    setBusy("backup"); setError("");
    const result = await devbenchApi.createConversationBackup(tab.id, dir, live);
    setBusy("");
    if (!result?.ok) { setError(result?.error || "备份完整对话失败"); return; }
    onToast?.(`已备份 ${result.data.count} 条完整对话消息到「${result.data.name}」${result.data.liveIncluded ? "（含当前已显示回答）" : ""}`);
    setDir(result.data.directory || dir);
    await loadBackups(result.data.directory || dir);
  }

  async function restoreBackup() {
    if (isRunning) { setError("AI 正在工作，请等待结束或先停止当前任务后再还原"); return; }
    if (!selected?.restorable) return;
    if (!window.confirm(`从「${selected.name}」还原用户和 AI 完整对话？\n\n当前页面对话将被替换；系统会先自动备份当前对话，工程配置不会改变。`)) return;
    setBusy("restore"); setError("");
    const result = await devbenchApi.restoreConversationBackup(tab.id, selected.path, dir);
    setBusy("");
    if (!result?.ok) { setError(result?.error || "还原完整对话失败"); return; }
    const recoveryText = result.data.recoveryBackupFile ? "；还原前的当前对话已自动保护备份" : "";
    onToast?.(`已还原 ${result.data.imported} 条完整对话消息${recoveryText}${result.data.warning ? `；${result.data.warning}` : ""}`);
    await onMessagesRestored?.(tab.id);
    await onRefreshTab?.();
    onClose?.();
  }

  useEffect(() => {
    setDir(initialDir);
    if (initialDir) loadBackups(initialDir);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab.id, initialDir, mode]);

  return (
    <div className="fixed inset-0 z-[82] flex items-center justify-center bg-black/65" onClick={onClose}>
      <div className="flex max-h-[86vh] w-[860px] max-w-[94vw] flex-col rounded-xl border border-zinc-700 bg-zinc-900 shadow-2xl" onClick={(event) => event.stopPropagation()}>
        <div className="flex items-center gap-3 border-b border-zinc-800 px-5 py-4">
          <div>
            <h2 className="text-sm font-semibold text-zinc-100">{restoreMode ? "还原用户和 AI 完整对话" : "备份用户和 AI 完整对话"}</h2>
            <p className="mt-0.5 text-[11px] text-zinc-500">独立 JSON 备份（*.devbench-chat.json）；写入仅限当前故事点的 AllDocs/StoryDev/.../ask 目录。</p>
          </div>
          <button onClick={() => loadBackups()} disabled={busy === "scan" || !dir} className="ml-auto rounded bg-zinc-800 px-2.5 py-1 text-[11px] text-zinc-300 hover:bg-zinc-700 disabled:opacity-50">刷新</button>
          <button onClick={onClose} className="text-lg leading-none text-zinc-500 hover:text-zinc-200">×</button>
        </div>

        <div className="space-y-2 border-b border-zinc-800 px-5 py-4">
          <div className="flex items-center gap-2">
            <span className="shrink-0 text-[11px] text-zinc-500">备份目录</span>
            <input value={dir} onChange={(event) => setDir(event.target.value)} className="min-w-0 flex-1 rounded border border-zinc-700 bg-zinc-950 px-2 py-1.5 font-mono text-[11px] text-zinc-200 outline-none focus:border-blue-500" />
            <button onClick={() => setShowPicker(true)} className="rounded border border-zinc-700 bg-zinc-800 px-2.5 py-1.5 text-[11px] text-zinc-200 hover:bg-zinc-700">选择</button>
            <button onClick={() => loadBackups(dir)} disabled={!dir || !!busy} className="rounded bg-zinc-800 px-2.5 py-1.5 text-[11px] text-zinc-300 hover:bg-zinc-700 disabled:opacity-50">扫描</button>
          </div>
          <div className="flex items-center gap-2">
            {restoreMode ? (
              <button onClick={restoreBackup} disabled={isRunning || !selected?.restorable || !!busy} className="rounded bg-indigo-600 px-3 py-1.5 text-[12px] text-white hover:bg-indigo-500 disabled:bg-zinc-700 disabled:text-zinc-500">{busy === "restore" ? "还原中…" : "还原所选完整对话"}</button>
            ) : (
              <button onClick={createBackup} disabled={!dir || !!busy} className="rounded bg-emerald-600 px-3 py-1.5 text-[12px] text-white hover:bg-emerald-500 disabled:bg-zinc-700 disabled:text-zinc-500">{busy === "backup" ? "备份中…" : "立即备份完整对话"}</button>
            )}
            <span className={`text-[11px] ${isRunning && restoreMode ? "text-amber-300" : "text-zinc-500"}`}>
              {isRunning && restoreMode ? "AI 正在运行，当前禁止还原" : restoreMode ? "还原前会自动保护当前对话；不会改动工程配置" : "完整保留消息元数据、工具记录、Token 和 AI 模型快照"}
            </span>
            {error && <span className="truncate text-[11px] text-red-400">{error}</span>}
          </div>
        </div>

        <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-4">
          {busy === "scan" && <div className="py-8 text-center text-[12px] text-zinc-500">读取中...</div>}
          {busy !== "scan" && !backups.length && <div className="py-8 text-center text-[12px] text-zinc-500">当前目录下没有完整对话 JSON 备份</div>}
          {busy !== "scan" && backups.map((backup) => (
            <button key={backup.path} type="button" disabled={!backup.restorable} onClick={() => setSelectedPath(backup.path)} title={backup.path} className={`w-full rounded-lg border px-3 py-2 text-left transition ${selected?.path === backup.path ? "border-indigo-500 bg-indigo-950/30" : "border-zinc-800 bg-zinc-950/50 hover:bg-zinc-800/70"} ${backup.restorable ? "" : "cursor-not-allowed opacity-55"}`}>
              <div className="flex min-w-0 items-center gap-2">
                <span className="truncate text-[12px] text-zinc-100">{backup.title || backup.name}</span>
                {backup.kind === "pre_restore" && <span className="rounded bg-amber-900/40 px-1.5 py-0.5 text-[9px] text-amber-300">还原前保护</span>}
                <span className="ml-auto shrink-0 font-mono text-[10px] text-zinc-500">{fmtDate(backup.createdAt || backup.mtime)}</span>
              </div>
              <div className="mt-1 flex flex-wrap gap-2 text-[10px] text-zinc-500">
                <span>{backup.turnCount || 0} 轮</span><span>{backup.messageCount || 0} 条消息</span><span>{fmtSize(backup.size)}</span>
                {backup.liveIncluded && <span className="text-amber-300">含回答中快照</span>}
                {!backup.restorable && <span className="text-red-400">{backup.error || "文件不可还原"}</span>}
              </div>
              <div className="mt-1 truncate font-mono text-[10px] text-zinc-600">{backup.path}</div>
            </button>
          ))}
        </div>
      </div>
      {showPicker && <FolderPickerModal initialPath={dir || tab.defaultArchiveDir || ""} title="选择完整对话备份目录" onPick={(value) => { setDir(value); setShowPicker(false); loadBackups(value); }} onClose={() => setShowPicker(false)} />}
    </div>
  );
}
