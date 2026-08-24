/**
 * 新建故事点居中面板：用 Tab 承载原先下拉菜单里的各类创建入口。
 */
import React, { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { flushSync } from "react-dom";
import { envMissingRequired } from "./diaglogic.js";
import GitCommitStoryModal from "./GitCommitStoryModal.jsx";
import GitCommitBatchStoryModal from "./GitCommitBatchStoryModal.jsx";
import TbTaskEntryModal from "./TbTaskEntryModal.jsx";
import { DEFAULT_NEW_STORY_TAB, NEW_STORY_TABS } from "./newStoryPanelModel.mjs";

function CopySourceItem({ s, onCopy, onReopen, onPurge, disabled = false }) {
  const meta = [];
  if (s.groupId) meta.push(`👥${s.groupName || "故事点组"}`);
  if (s.projectName) meta.push(s.projectName);
  if (s.extraCount) meta.push(`关联${s.extraCount}`);
  if (s.deviceSerial) meta.push(`📱${s.deviceSerial}`);
  return (
    <div className="flex items-center gap-2 rounded-lg px-3 py-2 transition hover:bg-zinc-800/80">
      <div className="min-w-0 flex-1">
        <div className="truncate text-xs text-zinc-200">{s.title}</div>
        <div className="truncate text-[10px] text-zinc-500">{meta.length ? meta.join(" · ") : "无工程/设备配置"}</div>
      </div>
      <button
        type="button"
        onClick={onReopen}
        disabled={disabled}
        data-testid={`new-story-history-${s.id}-open`}
        title={s.groupId ? "打开此已关闭故事点组（整组恢复工程/设备配置；被占用则提示）" : "打开此已关闭故事点（恢复其工程/设备配置；被占用则提示）"}
        className="shrink-0 rounded border border-emerald-700/50 bg-emerald-700/40 px-2 py-0.5 text-[11px] text-emerald-300 hover:text-white"
      >打开</button>
      <button
        type="button"
        onClick={onCopy}
        disabled={disabled}
        data-testid={`new-story-history-${s.id}-copy`}
        title={`复制「${s.title}」的工程与设备配置（新标题，不带会话）`}
        className="shrink-0 rounded border border-zinc-700 bg-zinc-800 px-2 py-0.5 text-[11px] text-zinc-300 hover:text-white"
      >复制</button>
      {onPurge && (
        <button
          type="button"
          onClick={onPurge}
          title={`永久删除已关闭故事点「${s.title}」，并选择是否删除本地存档和附件`}
          className="shrink-0 rounded border border-red-900/70 bg-red-950/50 px-2 py-0.5 text-[11px] text-red-300 hover:bg-red-900/60 hover:text-white"
        >删除</button>
      )}
    </div>
  );
}

function BackupRestorePanel({ disabled = false, onBusyChange, onSubmit, onClose }) {
  const [file, setFile] = useState(null);
  const [titleOverride, setTitleOverride] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const inputRef = useRef(null);

  function pickFile(e) {
    const f = e.target.files?.[0];
    e.target.value = "";
    if (!f) return;
    setError("");
    const nameOk = /\.devbench-story\.zip$/i.test(f.name);
    if (!nameOk) {
      setError("请选择 .devbench-story.zip 备份文件");
      return;
    }
    setFile(f);
  }

  async function submit() {
    if (!file || busy || disabled) return;
    setBusy(true);
    onBusyChange?.(true);
    setError("");
    try {
      const result = await onSubmit?.(file, titleOverride.trim() || "");
      if (!result?.ok) {
        if (!result?.cancelled) setError(result?.error || "还原备份失败");
        setBusy(false);
        onBusyChange?.(false);
      }
    } catch (e) {
      setError(e?.message || "还原备份失败");
      setBusy(false);
      onBusyChange?.(false);
    }
  }

  return (
    <div role="tabpanel" className="mx-auto max-w-2xl px-6 py-8" data-testid="new-story-backup-panel">
      <div className="rounded-2xl border border-amber-500/20 bg-gradient-to-br from-amber-500/[0.07] via-zinc-900/60 to-emerald-500/[0.06] p-6">
        <div className="text-[10px] font-semibold uppercase tracking-[0.18em] text-amber-500">Restore from backup</div>
        <h3 className="mt-2 text-base font-semibold text-zinc-100">从备份还原故事点</h3>
        <p className="mt-1 text-[11px] leading-relaxed text-zinc-500">
          选择另一台电脑用「一键备份」导出的 <code className="text-amber-300">.devbench-story.zip</code> 文件。
          点击「一键还原」后会先解析备份，再进入<strong className="text-zinc-300">初始化面板</strong>——
          你需要像新建故事点一样<strong className="text-zinc-300">绑定本机工程</strong>或<strong className="text-zinc-300">配置远程克隆</strong>；
          确认后会把备份里的对话历史、资料文件、TB/设备配置还原到新故事点，相当于在原电脑继续完成任务。
        </p>

        <label className="mt-5 block text-[10px] font-medium text-zinc-400">备份文件</label>
        <div className="mt-2 flex items-center gap-2">
          <input
            ref={inputRef}
            type="file"
            accept=".devbench-story.zip,application/zip"
            onChange={pickFile}
            disabled={busy || disabled}
            className="hidden"
            data-testid="new-story-backup-file-input"
          />
          <button
            type="button"
            onClick={() => inputRef.current?.click()}
            disabled={busy || disabled}
            className="rounded-lg border border-zinc-700 bg-zinc-800 px-4 py-2 text-xs text-zinc-200 hover:bg-zinc-700 disabled:opacity-50"
          >选择备份文件…</button>
          <span className="min-w-0 flex-1 truncate text-[11px] text-zinc-400">
            {file ? file.name : "未选择文件"}
          </span>
        </div>

        <label className="mt-4 block text-[10px] font-medium text-zinc-400">还原后的标题（可选，留空用备份里的标题）</label>
        <input
          value={titleOverride}
          onChange={(e) => setTitleOverride(e.target.value)}
          disabled={busy || disabled}
          placeholder="留空则沿用备份中的故事点标题"
          className="mt-2 w-full rounded-xl border border-zinc-700 bg-zinc-950/80 px-4 py-3 text-sm text-zinc-100 outline-none transition placeholder:text-zinc-700 focus:border-amber-500 disabled:opacity-50"
          data-testid="new-story-backup-title"
        />
        {error ? <p role="alert" className="mt-2 text-[10px] text-red-300">⚠ {error}</p> : null}
        <div className="mt-5 flex items-center justify-between gap-3">
          <span className="text-[9px] text-zinc-600">点击后会先解析备份，再进入初始化面板绑定本机工程或远程克隆</span>
          <button
            type="button"
            disabled={!file || busy || disabled}
            onClick={submit}
            className="rounded-lg border border-amber-400/30 bg-gradient-to-r from-amber-600 to-emerald-600 px-5 py-2 text-xs font-medium text-white transition hover:from-amber-500 hover:to-emerald-500 disabled:cursor-not-allowed disabled:border-zinc-700 disabled:from-zinc-800 disabled:to-zinc-800 disabled:text-zinc-500"
            data-testid="new-story-backup-restore"
          >{busy ? "解析中…" : "一键还原"}</button>
        </div>
      </div>
    </div>
  );
}

export default function NewStoryPanel({
  projectDefs = [],
  localProjects = [],
  projectId = "",
  copySources = { open: [], closed: [] },
  envStatus = null,
  onClose,
  onOpenEnvCheck,
  onCreateBlank,
  onAskTitle,
  onReopenClosed,
  onPurgeClosed,
  onPreviewGitCommit,
  onCreateFromGitCommit,
  onResolveGitCommitBatch,
  onCreateFromGitCommitBatch,
  onCreateFromTb,
  onCreateFromBackup,
  initialTab = DEFAULT_NEW_STORY_TAB,
}) {
  const [tab, setTab] = useState(initialTab);
  const [childBusy, setChildBusy] = useState(false);
  const [blankTitle, setBlankTitle] = useState("");
  const [blankError, setBlankError] = useState("");
  const [panelError, setPanelError] = useState("");

  useEffect(() => {
    setChildBusy(false);
  }, [tab]);

  useEffect(() => {
    const onKeyDown = (event) => {
      if (event.key !== "Escape") return;
      if (childBusy) {
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      onClose?.();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [childBusy, onClose]);

  const busyHandler = (next) => setChildBusy(Boolean(next));
  const submitBlank = async () => {
    const title = blankTitle.trim();
    if (!title || childBusy) return;
    // 同步提交按钮变 loading：flushSync 把 setChildBusy(true) + setBlankError("")
    // 强制在同一帧渲染，避免主线程在网络等待期间让按钮"看起来卡住"。
    flushSync(() => {
      setChildBusy(true);
      setBlankError("");
    });
    // 父层会同步显示初始化面板；这里仍等待完整入口 Promise，确保锁冲突和异步失败可恢复。
    try {
      const result = await onCreateBlank?.({ title });
      if (!result?.ok) {
        if (!result?.cancelled) setBlankError(result?.error || "无法进入初始化配置");
        setChildBusy(false);
      }
    } catch (error) {
      setBlankError(error?.message || "无法进入初始化配置");
      setChildBusy(false);
    }
  };

  const runPanelAction = async (action) => {
    if (childBusy) return;
    setChildBusy(true);
    setPanelError("");
    try {
      const result = await action?.();
      if (!result?.ok) {
        if (!result?.cancelled) setPanelError(result?.error || "故事点入口处理失败");
        setChildBusy(false);
      }
    } catch (error) {
      setPanelError(error?.message || "故事点入口处理失败");
      setChildBusy(false);
    }
  };

  const panel = (
    <div
      className="fixed inset-0 z-[130] flex items-center justify-center bg-black/75 p-4 backdrop-blur-md"
      role="dialog"
      aria-modal="true"
      aria-labelledby="new-story-panel-title"
      data-testid="new-story-panel"
      onClick={(event) => {
        if (event.target === event.currentTarget && !childBusy) onClose?.();
      }}
    >
      <div
        className="relative flex max-h-[92vh] w-[960px] max-w-[97vw] flex-col overflow-hidden rounded-2xl border border-zinc-700/80 bg-zinc-950 shadow-[0_40px_140px_rgba(0,0,0,0.85)]"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="pointer-events-none absolute -left-24 -top-28 h-64 w-64 rounded-full bg-violet-500/12 blur-[90px]" />
        <div className="pointer-events-none absolute -right-20 top-10 h-56 w-56 rounded-full bg-cyan-500/10 blur-[80px]" />

        <header className="relative shrink-0 border-b border-zinc-800 px-5 pb-0 pt-5">
          <div className="mb-4 flex items-start gap-3 px-1">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-blue-400/25 bg-gradient-to-br from-blue-500/20 to-violet-500/15 text-sm font-semibold text-blue-100">
              ＋
            </div>
            <div className="min-w-0 flex-1">
              <h2 id="new-story-panel-title" className="text-[15px] font-semibold text-zinc-50">新建故事点</h2>
              <p className="mt-1 text-[11px] leading-relaxed text-zinc-500">
                先选择来源并进入初始化配置；AI 会在面板中并发推理，确认前不会创建真实故事点。
              </p>
            </div>
            <button
              type="button"
              onClick={() => { if (!childBusy) onClose?.(); }}
              disabled={childBusy}
              className="rounded-lg px-2 py-1 text-sm text-zinc-500 transition hover:bg-zinc-800 hover:text-zinc-100 disabled:cursor-not-allowed disabled:opacity-35"
              aria-label="关闭"
              data-testid="new-story-panel-close"
            >✕</button>
          </div>

          <div className="flex gap-1 overflow-x-auto" role="tablist" aria-label="新建故事点方式">
            {NEW_STORY_TABS.map((item) => {
              const active = tab === item.id;
              return (
                <button
                  key={item.id}
                  type="button"
                  role="tab"
                  aria-selected={active}
                  data-testid={`new-story-tab-${item.id}`}
                  disabled={childBusy && !active}
                  onClick={() => { if (!childBusy || active) setTab(item.id); }}
                  className={`shrink-0 border-b-2 px-3.5 py-2.5 text-[11px] transition ${
                    active
                      ? "border-blue-500 text-zinc-50"
                      : childBusy
                        ? "cursor-not-allowed border-transparent text-zinc-700"
                        : "border-transparent text-zinc-500 hover:text-zinc-300"
                  }`}
                >
                  {item.label}
                </button>
              );
            })}
          </div>
        </header>

        <div className={`relative min-h-0 flex-1 ${tab === "git-commit-batch" ? "flex flex-col overflow-hidden" : "overflow-y-auto"}`}>
          {panelError ? <div role="alert" className="mx-5 mt-4 rounded-lg border border-red-900/60 bg-red-950/25 px-3 py-2 text-[10px] text-red-300">⚠ {panelError}</div> : null}
          {tab === "blank" && (
            <div role="tabpanel" className="mx-auto max-w-2xl px-6 py-8" data-testid="new-story-blank-panel">
              <div className="rounded-2xl border border-cyan-500/20 bg-gradient-to-br from-cyan-500/[0.07] via-zinc-900/60 to-violet-500/[0.06] p-6">
                <div className="text-[10px] font-semibold uppercase tracking-[0.18em] text-cyan-500">Blank story</div>
                <h3 className="mt-2 text-base font-semibold text-zinc-100">新建空白故事点</h3>
                <p className="mt-1 text-[11px] leading-relaxed text-zinc-500">
                  在这里直接输入标题。下一步只打开初始化配置面板，你可以再绑定 TB、主工程、关联工程、Flavor 与设备。
                </p>
                <label htmlFor="new-story-blank-title" className="mt-5 block text-[10px] font-medium text-zinc-400">故事点标题</label>
                <input
                  id="new-story-blank-title"
                  autoFocus
                  value={blankTitle}
                  onChange={(event) => { setBlankTitle(event.target.value); setBlankError(""); }}
                  onKeyDown={(event) => {
                    if (event.key !== "Enter" || !blankTitle.trim() || childBusy) return;
                    event.preventDefault();
                    submitBlank();
                  }}
                  disabled={childBusy}
                  placeholder="请输入唯一的故事点标题"
                  className="mt-2 w-full rounded-xl border border-zinc-700 bg-zinc-950/80 px-4 py-3 text-sm text-zinc-100 outline-none transition placeholder:text-zinc-700 focus:border-cyan-500 disabled:opacity-50"
                  data-testid="new-story-blank-title"
                />
                {blankError ? <p role="alert" className="mt-2 text-[10px] text-red-300">⚠ {blankError}</p> : null}
                <div className="mt-5 flex items-center justify-between gap-3">
                  <span className="text-[9px] text-zinc-600">此操作不会自动选择工程或创建 worktree</span>
                  <button
                    type="button"
                    disabled={!blankTitle.trim() || childBusy}
                    onClick={submitBlank}
                    className="rounded-lg border border-cyan-400/30 bg-gradient-to-r from-cyan-600 to-blue-600 px-5 py-2 text-xs font-medium text-white transition hover:from-cyan-500 hover:to-blue-500 disabled:cursor-not-allowed disabled:border-zinc-700 disabled:from-zinc-800 disabled:to-zinc-800 disabled:text-zinc-500"
                    data-testid="new-story-blank-next"
                  >{childBusy ? "正在准备创建流程…" : "进入初始化配置"}</button>
                </div>
              </div>
            </div>
          )}
          {tab === "git-commit" && (
            <div role="tabpanel">
              <GitCommitStoryModal
                embedded
                projectDefs={projectDefs}
                localProjects={localProjects}
                projectId={projectId}
                onClose={onClose}
                onPreview={onPreviewGitCommit}
                onSubmit={onCreateFromGitCommit}
                onBusyChange={busyHandler}
              />
            </div>
          )}
          {tab === "git-commit-batch" && (
            <div role="tabpanel" className="flex min-h-0 flex-1 flex-col overflow-hidden">
              <GitCommitBatchStoryModal
                embedded
                projectDefs={projectDefs}
                projectId={projectId}
                onClose={onClose}
                onResolve={onResolveGitCommitBatch}
                onSubmit={onCreateFromGitCommitBatch}
                onBusyChange={busyHandler}
              />
            </div>
          )}
          {tab === "tb" && (
            <div role="tabpanel">
              <TbTaskEntryModal
                embedded
                mode="story"
                onClose={onClose}
                onSubmit={onCreateFromTb}
                onBusyChange={busyHandler}
              />
            </div>
          )}
          {tab === "backup" && (
            <BackupRestorePanel
              disabled={childBusy}
              onBusyChange={busyHandler}
              onSubmit={onCreateFromBackup}
              onClose={onClose}
            />
          )}
          {tab === "history" && (
            <div role="tabpanel" data-testid="new-story-history-panel">
            <div className="space-y-4 px-5 py-5">
              {envStatus && !envStatus.okToCompile && (
                <button
                  type="button"
                  onClick={() => { onClose?.(); onOpenEnvCheck?.(); }}
                  className="flex w-full items-center gap-2 rounded-xl border border-amber-700/40 bg-amber-900/20 px-3 py-2.5 text-left text-[11px] text-amber-300 transition hover:bg-amber-900/30"
                >
                  ⚠ 本机缺少编译环境（{envMissingRequired(envStatus).join("、")}），点此诊断并修复
                </button>
              )}

              <section>
                <div className="mb-2 text-[10px] font-medium uppercase tracking-[0.12em] text-zinc-500">
                  已关闭的故事点（打开=恢复 · 复制=新建 · 删除=物理删除）
                </div>
                <div className="max-h-[42vh] overflow-y-auto rounded-xl border border-zinc-800 bg-zinc-900/40 py-1">
                  {copySources.closed?.length > 0 ? (
                    copySources.closed.map((s) => (
                      <CopySourceItem
                        key={`closed_${s.id}`}
                        s={s}
                        disabled={childBusy}
                        onReopen={() => runPanelAction(() => onReopenClosed?.(s.id))}
                        onCopy={() => runPanelAction(() => onAskTitle?.(`${s.title} 副本`, { copyFromId: s.id, copyFromKind: "closed", copySource: s }))}
                        onPurge={() => onPurgeClosed?.(s)}
                      />
                    ))
                  ) : (
                    <div className="px-3 py-4 text-center text-[10px] text-zinc-600">
                      暂无已关闭的故事点（之后关闭的会保存在这里供复制）
                    </div>
                  )}
                </div>
              </section>
            </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );

  return typeof document !== "undefined" ? createPortal(panel, document.body) : panel;
}
