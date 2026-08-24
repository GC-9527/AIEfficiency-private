import React, { useEffect, useMemo, useState } from "react";
import { devbenchApi } from "./api.js";
import { useIsAdmin } from "../../services/adminAuth.js";

function fmtDate(ts) {
  if (!ts) return "-";
  const d = new Date(Number(ts));
  if (Number.isNaN(d.getTime())) return "-";
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function formatBytes(value) {
  const bytes = Math.max(0, Number(value) || 0);
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let n = bytes;
  let unit = "B";
  for (const candidate of units) {
    n /= 1024;
    unit = candidate;
    if (n < 1024) break;
  }
  return `${n.toFixed(n >= 100 ? 0 : n >= 10 ? 1 : 2)} ${unit}`;
}

function sourceLabel(source) {
  if (source === "auto") return "自动";
  if (source === "pre-restore") return "恢复前";
  return "手动";
}

function SourceBadge({ source }) {
  const cls = source === "auto"
    ? "border-sky-700/60 text-sky-200 bg-sky-950/30"
    : source === "pre-restore"
      ? "border-amber-700/60 text-amber-200 bg-amber-950/30"
      : "border-emerald-700/60 text-emerald-200 bg-emerald-950/30";
  return <span className={`px-1.5 py-0.5 rounded border text-[10px] shrink-0 ${cls}`}>{sourceLabel(source)}</span>;
}

function SummaryItem({ label, value }) {
  return (
    <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-zinc-800/80 border border-zinc-700/70 text-[10px] text-zinc-400">
      <span>{label}</span>
      <span className="text-zinc-100 font-mono">{value || 0}</span>
    </span>
  );
}

function BackupRow({ backup, selected, onSelect }) {
  const s = backup.summary || {};
  return (
    <button
      type="button"
      onClick={() => onSelect(backup.id)}
      className={`w-full text-left px-3 py-2 border rounded-lg transition ${selected ? "border-blue-500 bg-blue-950/30" : "border-zinc-800 bg-zinc-900/60 hover:bg-zinc-800/70"}`}
    >
      <div className="flex items-center gap-2 min-w-0">
        <SourceBadge source={backup.source} />
        <span className="text-[12px] text-zinc-100 truncate">{backup.label || backup.id}</span>
        <span className="ml-auto text-[11px] text-zinc-500 font-mono shrink-0">{fmtDate(backup.createdAt)}</span>
      </div>
      <div className="mt-1 flex flex-wrap gap-1.5">
        <SummaryItem label="项目桶" value={s.projectBucketCount} />
        <SummaryItem label="车型" value={s.vehicleCount} />
        <SummaryItem label="关键字" value={s.keywordCount} />
        <SummaryItem label="状态" value={s.statusCount} />
        <SummaryItem label="经验" value={s.lessonCount} />
        <SummaryItem label="记忆" value={s.configMemoryCount} />
        <SummaryItem label="任务" value={s.taskCount} />
        <SummaryItem label="用户行" value={s.userDataRowCount} />
      </div>
      {backup.note && <div className="mt-1 text-[10px] text-zinc-500 truncate">{backup.note}</div>}
    </button>
  );
}

export default function SharedBackupModal({ onClose, onToast }) {
  const { isAdmin } = useIsAdmin();
  const [backups, setBackups] = useState([]);
  const [settings, setSettings] = useState({
    enabled: true,
    intervalMinutes: 60,
    maxAutoBackups: 48,
    lastAutoBackupAt: 0,
  });
  const [storage, setStorage] = useState({});
  const [selectedId, setSelectedId] = useState("");
  const [label, setLabel] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState("");
  const [loading, setLoading] = useState(true);

  const selected = useMemo(() => backups.find((b) => b.id === selectedId) || backups[0] || null, [backups, selectedId]);

  async function load() {
    setLoading(true);
    const r = await devbenchApi.listSyncBackups();
    setLoading(false);
    if (!r.ok) { onToast?.(r.error || "读取备份失败"); return; }
    setBackups(r.data?.backups || []);
    setSettings(r.data?.settings || {
      enabled: true,
      intervalMinutes: 60,
      maxAutoBackups: 48,
      lastAutoBackupAt: 0,
    });
    setStorage(r.data?.storage || {});
    setSelectedId((id) => id || r.data?.backups?.[0]?.id || "");
  }

  useEffect(() => { load(); }, []); // eslint-disable-line

  async function saveSettings(patch) {
    if (!isAdmin) return;
    const next = { ...settings, ...patch };
    setSettings(next);
    const r = await devbenchApi.updateSyncBackupSettings(next);
    if (!r.ok) { onToast?.(r.error || "保存自动备份设置失败"); load(); return; }
    setSettings(r.data);
  }

  async function createManual() {
    if (!isAdmin) return;
    setBusy("manual");
    const r = await devbenchApi.createSyncBackup({ label, note });
    setBusy("");
    if (!r.ok) { onToast?.(r.error || "创建备份失败"); return; }
    setLabel("");
    setNote("");
    onToast?.("备份已创建");
    await load();
    setSelectedId(r.data?.id || "");
  }

  async function runAutoNow() {
    if (!isAdmin) return;
    setBusy("auto");
    const r = await devbenchApi.runSyncAutoBackupNow({});
    setBusy("");
    if (!r.ok) { onToast?.(r.error || "立即备份失败"); return; }
    onToast?.(r.data?.unchanged ? "共享数据未变化，已跳过重复备份" : "自动备份已创建");
    await load();
    setSelectedId(r.data?.backup?.id || r.data?.duplicateOf || "");
  }

  async function maintainStorage() {
    if (!isAdmin) return;
    setBusy("maintenance");
    const r = await devbenchApi.maintainSyncBackups({ maxAutoBackups: settings.maxAutoBackups });
    setBusy("");
    if (!r.ok) { onToast?.(r.error || "备份存储维护失败"); return; }
    const deleted = Number(r.data?.maintenance?.deleted) || 0;
    onToast?.(deleted ? `已清理 ${deleted} 条超限自动备份` : "备份保留数量已符合设置");
    await load();
  }

  async function restoreSelected() {
    if (!isAdmin || !selected) return;
    const ok = confirm(`恢复到「${selected.label || selected.id}」？\n当前共享配置和可同步用户数据会先生成一条恢复前备份。`);
    if (!ok) return;
    setBusy("restore");
    const r = await devbenchApi.restoreSyncBackup(selected.id);
    setBusy("");
    if (!r.ok) { onToast?.(r.error || "恢复失败"); return; }
    onToast?.("已从备份恢复");
    await load();
  }

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/70" onClick={onClose}>
      <div className="bg-zinc-900 border border-zinc-700 rounded-xl w-[900px] max-w-[94vw] max-h-[88vh] flex flex-col shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="px-5 py-4 border-b border-zinc-800 flex items-center gap-3">
          <div className="min-w-0">
            <h2 className="text-sm font-semibold text-zinc-100">共享配置备份</h2>
            <div className="text-[11px] text-zinc-500 mt-0.5">本机私有 · 不参与局域网同步 · 可恢复任意备份点</div>
          </div>
          <button onClick={load} disabled={loading} className="ml-auto px-2.5 py-1 text-[11px] rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-300 disabled:opacity-60">刷新</button>
          <button onClick={onClose} className="text-zinc-500 hover:text-zinc-200 text-lg leading-none">x</button>
        </div>

        <div className="grid grid-cols-[280px_minmax(0,1fr)] min-h-0 flex-1">
          <div className="border-r border-zinc-800 p-4 space-y-4 overflow-y-auto">
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-[12px] font-medium text-zinc-200">自动备份</span>
                <label className={`relative inline-flex items-center ${isAdmin ? "cursor-pointer" : "opacity-60"}`}>
                  <input type="checkbox" checked={!!settings.enabled} disabled={!isAdmin} onChange={(e) => saveSettings({ enabled: e.target.checked })} className="sr-only peer" />
                  <span className="w-9 h-5 rounded-full bg-zinc-700 peer-checked:bg-blue-600 transition" />
                  <span className="absolute left-0.5 top-0.5 h-4 w-4 rounded-full bg-white transition peer-checked:translate-x-4" />
                </label>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-[11px] text-zinc-500 shrink-0">间隔</span>
                <input
                  type="number"
                  min="5"
                  max="10080"
                  value={settings.intervalMinutes || 60}
                  disabled={!isAdmin}
                  onChange={(e) => setSettings((s) => ({ ...s, intervalMinutes: e.target.value }))}
                  onBlur={(e) => saveSettings({ intervalMinutes: e.target.value })}
                  className="w-24 bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-[11px] text-zinc-200 outline-none disabled:opacity-60"
                />
                <span className="text-[11px] text-zinc-500">分钟</span>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-[11px] text-zinc-500 shrink-0">保留最近</span>
                <input
                  type="number"
                  min="1"
                  max="720"
                  value={settings.maxAutoBackups || 48}
                  disabled={!isAdmin}
                  onChange={(e) => setSettings((s) => ({ ...s, maxAutoBackups: e.target.value }))}
                  onBlur={(e) => saveSettings({ maxAutoBackups: e.target.value })}
                  className="w-24 bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-[11px] text-zinc-200 outline-none disabled:opacity-60"
                />
                <span className="text-[11px] text-zinc-500">份自动备份</span>
              </div>
              <div className="text-[10px] text-zinc-600">上次自动备份：{fmtDate(settings.lastAutoBackupAt)}</div>
              {isAdmin && <button onClick={runAutoNow} disabled={busy === "auto"} className="w-full px-3 py-1.5 text-[12px] rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-200 disabled:opacity-60">立即自动备份</button>}
            </div>

            <div className="space-y-2 pt-3 border-t border-zinc-800">
              <div className="text-[12px] font-medium text-zinc-200">存储占用</div>
              <div className="text-[10px] text-zinc-500 leading-5">
                <div>备份：{storage.backupCount || 0} 条 / {storage.uniqueBlobCount || 0} 个数据块</div>
                <div>实际：{formatBytes(storage.backupBytes)}，原始：{formatBytes(storage.backupRawBytes)}</div>
                <div>主库：{formatBytes(storage.databaseBytes)}，可回收：{formatBytes(storage.reclaimableBytes)}</div>
                {!!storage.legacyBackupCount && <div className="text-amber-400">旧格式备份：{storage.legacyBackupCount} 条（离线维护后压缩）</div>}
              </div>
              {isAdmin && (
                <button
                  onClick={maintainStorage}
                  disabled={busy === "maintenance"}
                  className="w-full px-3 py-1.5 text-[12px] rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-200 disabled:opacity-60"
                >
                  按保留数量清理
                </button>
              )}
            </div>

            {isAdmin && (
              <div className="space-y-2 pt-3 border-t border-zinc-800">
                <div className="text-[12px] font-medium text-zinc-200">手动备份</div>
                <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="备份名称" className="w-full bg-zinc-800 border border-zinc-700 rounded px-2 py-1.5 text-[12px] text-zinc-200 placeholder-zinc-600 outline-none" />
                <textarea value={note} onChange={(e) => setNote(e.target.value)} placeholder="备注" rows={3} className="w-full resize-none bg-zinc-800 border border-zinc-700 rounded px-2 py-1.5 text-[12px] text-zinc-200 placeholder-zinc-600 outline-none" />
                <button onClick={createManual} disabled={busy === "manual"} className="w-full px-3 py-1.5 text-[12px] rounded bg-emerald-600 hover:bg-emerald-500 text-white disabled:opacity-60">创建备份</button>
              </div>
            )}
          </div>

          <div className="min-w-0 flex flex-col">
            <div className="px-4 py-3 border-b border-zinc-800 flex items-center gap-2">
              <span className="text-[12px] font-medium text-zinc-200">备份列表</span>
              <span className="text-[11px] text-zinc-500">共 {backups.length} 条</span>
              <button onClick={restoreSelected} disabled={!isAdmin || !selected || busy === "restore"} className="ml-auto px-3 py-1.5 text-[12px] rounded bg-blue-600 hover:bg-blue-500 text-white disabled:bg-zinc-700 disabled:text-zinc-500">恢复所选</button>
            </div>
            <div className="flex-1 overflow-y-auto p-4 space-y-2">
              {loading && <div className="text-[12px] text-zinc-500 py-8 text-center">读取中...</div>}
              {!loading && !backups.length && <div className="text-[12px] text-zinc-500 py-8 text-center">暂无备份</div>}
              {!loading && backups.map((b) => (
                <BackupRow key={b.id} backup={b} selected={(selected?.id || selectedId) === b.id} onSelect={setSelectedId} />
              ))}
            </div>
          </div>
        </div>

        <div className="px-5 py-3 border-t border-zinc-800 flex items-center gap-2">
          <span className="text-[10px] text-zinc-600 truncate">恢复会覆盖当前共享配置和可同步用户数据；恢复前会自动创建保护备份。</span>
          <button onClick={onClose} className="ml-auto px-4 py-1.5 text-xs rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-300">关闭</button>
        </div>
      </div>
    </div>
  );
}
