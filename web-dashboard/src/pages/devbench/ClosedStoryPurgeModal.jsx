import React, { useEffect, useState } from "react";
import { devbenchApi, getClosedStoryPurgePartialResult } from "./api.js";

function formatBytes(bytes) {
  const value = Number(bytes) || 0;
  if (value >= 1024 * 1024 * 1024) return `${(value / 1024 / 1024 / 1024).toFixed(1)} GB`;
  if (value >= 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)} MB`;
  if (value >= 1024) return `${Math.round(value / 1024)} KB`;
  return `${value} B`;
}

function PathLine({ children }) {
  if (!children) return <div className="mt-1 text-[10px] text-zinc-600">未找到对应目录</div>;
  return <div className="mt-1 break-all font-mono text-[10px] text-zinc-500">{children}</div>;
}

function OptionCard({ checked, disabled, onChange, title, summary, paths = [], warning = "" }) {
  return (
    <label className={`block rounded-lg border px-3 py-2.5 ${disabled ? "cursor-not-allowed border-zinc-800 bg-zinc-950/30 opacity-65" : "cursor-pointer border-zinc-700 bg-zinc-950/55 hover:border-zinc-600"}`}>
      <div className="flex items-start gap-2.5">
        <input type="checkbox" className="mt-0.5" checked={checked} disabled={disabled} onChange={(event) => onChange(event.target.checked)} />
        <div className="min-w-0 flex-1">
          <div className="text-[12px] font-medium text-zinc-200">{title}</div>
          <div className="mt-0.5 text-[11px] text-zinc-500">{summary}</div>
          {paths.map((value) => <PathLine key={value}>{value}</PathLine>)}
          {warning && <div className="mt-1 text-[10px] leading-4 text-amber-300">⚠ {warning}</div>}
        </div>
      </div>
    </label>
  );
}

function statusText(value) {
  const map = {
    deleted: "已删除",
    missing: "原本不存在",
    preserved: "已保留",
    covered_by_archive_directory: "随 TXT 目录一并删除",
    covered_by_attachment_directory: "随附件目录一并删除",
    failed: "删除失败",
  };
  return map[value] || value || "尚未处理";
}

function legacySnapshotStatus(items) {
  if (!Array.isArray(items)) return "尚未处理";
  if (items.some((item) => item?.status === "failed")) return "存在失败项";
  if (items.some((item) => item?.status === "deleted")) return "已删除";
  if (items.length && items.every((item) => item?.status === "missing")) return "原本不存在";
  return items.length ? "已处理" : "尚未处理";
}

export default function ClosedStoryPurgeModal({ story, onClose, onDeleted }) {
  const [preview, setPreview] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [options, setOptions] = useState({
    deleteConversationBackups: false,
    deleteArchiveDirectory: false,
    deleteAttachments: false,
  });
  const [result, setResult] = useState(null);
  const [partialResult, setPartialResult] = useState(null);

  useEffect(() => {
    let disposed = false;
    setPreview(null);
    setResult(null);
    setPartialResult(null);
    setConfirmed(false);
    setOptions({ deleteConversationBackups: false, deleteArchiveDirectory: false, deleteAttachments: false });
    setLoading(true);
    setError("");
    (async () => {
      try {
        const response = await devbenchApi.previewClosedStoryPurge(story.id);
        if (disposed) return;
        if (!response?.ok) setError(response?.error || "读取永久删除范围失败");
        else setPreview(response.data);
      } catch (requestError) {
        if (!disposed) setError(`读取永久删除范围失败：${requestError?.message || "网络异常"}`);
      } finally {
        if (!disposed) setLoading(false);
      }
    })();
    return () => { disposed = true; };
  }, [story.id]);

  async function submit() {
    if (!preview || !confirmed || busy) return;
    setBusy(true);
    setError("");
    let response;
    try {
      response = await devbenchApi.purgeClosedStory(story.id, {
        confirmId: story.id,
        expectedClosedAt: preview.story.closedAt,
        ...options,
      });
    } catch (requestError) {
      setError(`永久删除请求失败：${requestError?.message || "网络异常"}。请重新预览确认故事点是否仍在关闭列表。`);
    } finally {
      setBusy(false);
    }
    if (!response?.ok) {
      const executionResult = getClosedStoryPurgePartialResult(response);
      setPartialResult(executionResult);
      if (executionResult) {
        setError(`${response?.error || "永久删除未完整完成"}。仅下列明细中标为“已删除”的项目不可恢复，范围已重新核对。`);
      } else if (response) {
        setError(response?.error || "永久删除失败，故事点记录仍保留");
      }
      if (response?.data) {
        try {
          const refreshed = await devbenchApi.previewClosedStoryPurge(story.id);
          if (refreshed?.ok) setPreview(refreshed.data);
        } catch {}
      }
      return;
    }
    setResult(response.data);
    try { await onDeleted?.(story.id, response.data); } catch {}
  }

  const backups = preview?.conversationBackups;
  const archive = preview?.archiveDirectory;
  const attachments = preview?.attachments;
  const coveredBackups = Number(backups?.coveredByArchiveDirectoryCount) || 0;
  const attachmentBackups = Number(backups?.coveredByAttachmentDirectoryCount) || 0;
  const coreSafe = preview?.core?.executionHistory?.safeToDelete !== false;
  const sharedSessionNames = (preview?.core?.executionHistory?.sharedBy || []).map((item) => item.title || item.id).filter(Boolean);
  const selectionError = options.deleteAttachments && attachmentBackups > 0 && !options.deleteConversationBackups
    ? `附件目录内含 ${attachmentBackups} 个 JSON 对话备份；必须同时勾选“删除独立 JSON 完整对话备份”，否则附件目录不会删除。`
    : "";
  const canSubmit = !!preview && confirmed && !busy && !result && !selectionError && coreSafe;

  return (
    <div className="fixed inset-0 z-[96] flex items-center justify-center bg-black/70 p-3" role="dialog" aria-modal="true" aria-label="永久删除已关闭故事点" onClick={busy ? undefined : onClose}>
      <div className="flex max-h-[90vh] w-[720px] max-w-[96vw] flex-col rounded-xl border border-red-900/70 bg-zinc-900 shadow-2xl" onClick={(event) => event.stopPropagation()}>
        <div className="flex items-start gap-3 border-b border-zinc-800 px-5 py-4">
          <div className="min-w-0">
            <h2 className="text-sm font-semibold text-red-300">永久删除已关闭故事点</h2>
            <div className="mt-1 truncate text-[12px] text-zinc-200" title={story.title}>「{story.title}」</div>
            <p className="mt-1 text-[11px] leading-4 text-zinc-500">只删除当前这一条关闭故事点；同组其它故事点、工程源码、Git 仓库和 TB 云端附件不会删除。</p>
          </div>
          <button onClick={onClose} disabled={busy} className="ml-auto text-lg leading-none text-zinc-500 hover:text-zinc-200 disabled:opacity-40">×</button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          {loading && <div className="py-10 text-center text-[12px] text-zinc-500">正在核对磁盘资料和共享引用…</div>}
          {!loading && error && !preview && <div className="rounded border border-red-900/70 bg-red-950/25 px-3 py-2 text-[11px] text-red-300">{error}</div>}

          {preview && !result && (
            <div className="space-y-3">
              <div className="rounded-lg border border-red-900/60 bg-red-950/20 px-3 py-2.5">
                <div className="flex items-center gap-2 text-[12px] font-medium text-red-200"><input type="checkbox" checked readOnly disabled /> 固定物理删除故事点记录</div>
                <div className="mt-1 text-[11px] leading-4 text-zinc-500">包括关闭快照、页面聊天、流式草稿，以及该故事点本机 AI 执行任务中的提问/回答、日志和 Token 记录。此操作不可恢复。</div>
                {!coreSafe && <div className="mt-1 text-[10px] leading-4 text-amber-300">⚠ AI 执行会话还被其它故事点引用：{sharedSessionNames.join("、") || "未知故事点"}。为避免误删其它故事点历史，服务端禁止永久删除。</div>}
              </div>

              <div className="text-[11px] text-zinc-400">按需选择额外删除的本地资料：</div>
              <OptionCard
                checked={options.deleteConversationBackups}
                onChange={(checked) => setOptions((current) => ({ ...current, deleteConversationBackups: checked }))}
                title="删除独立 JSON 完整对话备份"
                summary={`已定位 ${backups?.count || 0} 个，${formatBytes(backups?.bytes)}；只删除校验后属于本故事点的 *.devbench-chat.json`}
                paths={backups?.directories || []}
                warning={`${backups?.discoveryNote || ""}${backups?.scanIncomplete ? " 扫描未完整读取，服务端会拒绝执行。" : ""}`}
              />
              <OptionCard
                checked={options.deleteArchiveDirectory}
                disabled={!archive?.safeToDelete}
                onChange={(checked) => setOptions((current) => ({ ...current, deleteArchiveDirectory: checked }))}
                title="删除 TXT 全量存档所在的整个文件夹"
                summary={archive?.exists ? `${archive.fileCount} 个文件，${formatBytes(archive.bytes)}；删除整个 ask 目录` : "目录当前不存在；仍会删除故事点记录"}
                paths={archive?.path ? [archive.path] : []}
                warning={archive?.safeToDelete
                  ? (coveredBackups ? `该目录内有 ${coveredBackups} 个 JSON 对话备份，会随整个目录一并删除；目录外备份仍由上一项控制。` : "")
                  : (archive?.unsafeReason || "没有可安全递归删除的默认 TXT 目录，请保留后手动处理。")}
              />
              <OptionCard
                checked={options.deleteAttachments}
                disabled={!attachments?.safeToDelete}
                onChange={(checked) => setOptions((current) => ({ ...current, deleteAttachments: checked }))}
                title="删除对应的本地附件与材料"
                summary={`${attachments?.fileCount || 0} 个文件，${formatBytes(attachments?.bytes)}；包括新旧 archives 目录中的下载附件、备注图片和拖入材料`}
                paths={(attachments?.paths || []).map((item) => item.path).filter(Boolean)}
                warning={attachments?.safeToDelete
                  ? `${attachments?.note || ""}${attachmentBackups ? ` 当前目录内含 ${attachmentBackups} 个 JSON 对话备份。` : ""}`
                  : (attachments?.unsafeReason || "没有可安全删除的附件目录")}
              />

              {selectionError && <div className="rounded border border-amber-800/70 bg-amber-950/25 px-3 py-2 text-[11px] text-amber-200">{selectionError}</div>}

              {partialResult && (
                <div className="rounded border border-amber-800/70 bg-amber-950/20 px-3 py-2 text-[11px] leading-5 text-amber-200">
                  <div className="font-medium">上次删除执行未完整完成，请按实际状态再次确认：</div>
                  <div>页面聊天：{statusText(partialResult.core?.messageFile?.status)}；流式草稿：{statusText(partialResult.core?.liveDraftFile?.status)}；AI 执行历史：{statusText(partialResult.core?.executionHistory?.status)}</div>
                  <div>旧格式故事点快照：{legacySnapshotStatus(partialResult.core?.legacyStorySnapshots)}</div>
                  <div>JSON 对话备份：{statusText(partialResult.conversationBackups?.status)}；TXT 目录：{statusText(partialResult.archiveDirectory?.status)}；附件目录：{statusText(partialResult.attachments?.status)}</div>
                </div>
              )}

              <label className="flex items-start gap-2 rounded border border-red-900/40 bg-red-950/15 px-3 py-2 text-[11px] leading-4 text-red-200">
                <input type="checkbox" className="mt-0.5" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} />
                <span>我已核对以上路径和选择，确认永久删除故事点；未勾选且未被整个 TXT 目录覆盖的外部资料将保留。</span>
              </label>
              {error && <div className="rounded border border-red-900/70 bg-red-950/25 px-3 py-2 text-[11px] text-red-300">{error}</div>}
            </div>
          )}

          {result && (
            <div className="space-y-3">
              <div className="rounded-lg border border-emerald-800/60 bg-emerald-950/20 px-3 py-2.5 text-[12px] text-emerald-300">故事点记录已永久删除。</div>
              <div className="divide-y divide-zinc-800 rounded-lg border border-zinc-800 bg-zinc-950/40 text-[11px]">
                <div className="flex justify-between px-3 py-2"><span className="text-zinc-400">页面聊天与执行历史</span><span className="text-zinc-200">已删除</span></div>
                <div className="flex justify-between px-3 py-2"><span className="text-zinc-400">独立 JSON 对话备份</span><span className="text-zinc-200">{statusText(result.conversationBackups?.status)}</span></div>
                <div className="flex justify-between px-3 py-2"><span className="text-zinc-400">TXT 存档目录</span><span className="text-zinc-200">{statusText(result.archiveDirectory?.status)}</span></div>
                <div className="flex justify-between px-3 py-2"><span className="text-zinc-400">本地附件目录</span><span className="text-zinc-200">{statusText(result.attachments?.status)}</span></div>
              </div>
            </div>
          )}
        </div>

        <div className="flex justify-end gap-2 border-t border-zinc-800 px-5 py-3">
          {result ? (
            <button onClick={onClose} className="rounded bg-emerald-600 px-4 py-1.5 text-xs text-white hover:bg-emerald-500">完成</button>
          ) : (
            <>
              <button onClick={onClose} disabled={busy} className="rounded bg-zinc-800 px-3 py-1.5 text-xs text-zinc-300 hover:bg-zinc-700 disabled:opacity-40">取消</button>
              <button onClick={submit} disabled={!canSubmit} className="rounded bg-red-600 px-4 py-1.5 text-xs text-white hover:bg-red-500 disabled:bg-zinc-700 disabled:text-zinc-500">{busy ? "永久删除中…" : "永久删除"}</button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
