/**
 * 单个故事点 tab —— 工程配置 + 与 AI 对话（流式思考/回答/token）
 * 纯展示组件：数据与回调由 index.jsx 注入。
 */
import React, { useState, useRef, useEffect, useCallback, useMemo } from "react";
import { createPortal } from "react-dom";
import DeviceRuntimeStatusCard from "./DeviceRuntimeStatusCard.jsx";
import StopAiButton from "./StopAiButton.jsx";
import Markdown from "../../components/Markdown.jsx";
import { DEVBENCH_TASKS_CHANGED_EVENT, devbenchApi } from "./api.js";
import { copyToClipboard } from "../../utils/clipboard.js";
import { formatChineseDateTime, formatHistoryAwareTime } from "../../utils/devbenchTime.js";
import ResourcePanel from "./ResourcePanel.jsx";
import RemoteBranchSelect from "./RemoteBranchSelect.jsx";
import ToolsPanel from "./ToolsPanel.jsx";
import LocalChangesPanel from "./LocalChangesPanel.jsx";
import PushPanel from "./PushPanel.jsx";
import PullRequestPanel from "./PullRequestPanel.jsx";
import BuildPanel from "./BuildPanel.jsx";
import GitUpdateBar from "./GitUpdateBar.jsx";
import GitUpdateScopeModal from "./GitUpdateScopeModal.jsx";
import StudioBtn from "./StudioBtn.jsx";
import GitAmendPanel from "./GitAmendPanel.jsx";
import GitCommitReworkPanel from "./GitCommitReworkPanel.jsx";
import ArchiveManagerModal from "./ArchiveManagerModal.jsx";
import ConversationBackupModal from "./ConversationBackupModal.jsx";
import FolderPickerModal from "./FolderPickerModal.jsx";
import WorktreeCleanupModal from "./WorktreeCleanupModal.jsx";
import WorktreeRebuildConfirmModal from "./WorktreeRebuildConfirmModal.jsx";
import WorktreeBranchMismatchBanner from "./WorktreeBranchMismatchBanner.jsx";
import WorkspaceBundleSummary from "./WorkspaceBundleSummary.jsx";
import ArtifactPathLinks from "./ArtifactPathLinks.jsx";
import StoryAttachmentList from "./StoryAttachmentList.jsx";
import useStoryArtifactUrls from "./useStoryArtifactUrls.js";
import useTabAttachments from "./useTabAttachments.js";
import {
  readAttachProgress,
  subscribeAttachProgress,
} from "./tbAttachmentDownloadState.js";
import { isWorktreeRebuildConfirmRequired } from "./worktreeRebuildModel.mjs";
import WorkflowMap from "./WorkflowMap.jsx";
import { getWorkflowPhase, workflowRepairTriggerContent, workflowStatusActions, workflowSyncPendingInfo } from "./workflowMapModel.js";
import { answerAiModelTier, engineModelTier, engineModelTierText, engineStatusLabel, readEngineStatusCache } from "./engineStatusCache.js";
import {
  BASE_DEVBENCH_ENGINES,
  buildEnginePickerGroups,
  compactEngineProductName,
  engineGroupId,
} from "./enginePickerModel.mjs";
import { openExternal } from "../cardev/electron.js";
import {
  createdPullRequestUrl,
  isEmbeddedElectron,
  openPullRequestPage,
  openPullRequestWindow,
} from "./pullRequestNavigation.js";
import { storyPageUpTarget, storyScrollKeyCommand, storyScrollStatus } from "./storyScrollModel.mjs";
import {
  classifyStoryMessageUrl,
  extractStoryArtifactRefs,
  extractBareStoryArtifactRefs,
  hasStoryExternalBridge,
  isSafeResolvedStoryMessageUrl,
  planStoryMessageRender,
  resolveStoryMessageUrl,
  storyMessageFileName,
  storyMessageArtifactRef,
} from "./storyMessageModel.mjs";
import {
  attachmentUploadRelativePath,
  buildStoryAttachmentPrompt,
  clipboardAttachmentFiles,
  createAttachmentBatchId,
  setTbAttachmentDownloadPending,
  tbAttachmentDownloadKey,
} from "./storyAttachmentModel.mjs";
import { storyWorktreeDisplayPath, worktreeMutationEntryDisabled } from "./worktreeCleanupModel.mjs";
import { canPromoteWorktreeExtra, selectedBaseProjectPaths } from "./worktreeProjectModel.mjs";
import {
  clampProjectControlsPosition,
  parseProjectControlsPosition,
  projectControlsPositionStorageKey,
  readProjectControlsExpanded,
  writeProjectControlsExpanded,
} from "./projectControlsFloatingModel.mjs";
import BranchNavigator from "./conversation/BranchNavigator.jsx";
import MessageShell from "./conversation/MessageShell.jsx";
import UserMessageEditor from "./conversation/UserMessageEditor.jsx";
import {
  conversationMessageStableId,
  conversationRevision,
  userRevisionNavigation,
} from "./conversation/conversationGraphModel.mjs";
import { storyComposerSubmitLabel, storyRunStatusView } from "./storyRunStatusModel.mjs";
import StoryChatInput from "./StoryChatInput.jsx";
import { mergeStoryDraftAttachments, storyInputDraftStorageKey } from "./storyInputDraftModel.mjs";
import { remoteSourceInitializationProgress } from "./storyInitializationModel.mjs";

const RECORDING_CONTEXT_KEY = "devtool_recording_context";

function useStoryLinkTools(tabId, onToast, artifactUrl) {
  const resolveUrl = useCallback(
    (rawUrl) => resolveStoryMessageUrl(rawUrl, { tabId, artifactUrl }),
    [artifactUrl, tabId],
  );
  const onOpenLink = useCallback((url, event) => {
    if (!isSafeResolvedStoryMessageUrl(url)) {
      event?.preventDefault?.();
      onToast?.("链接已被安全策略拦截");
      return true;
    }
    if (!hasStoryExternalBridge(globalThis.window)) return false;
    // Desktop preload 有显式 openExternal 时走受控 IPC；Service Control 只有 Electron UA，
    // 保留原生 target=_blank，让主进程的 setWindowOpenHandler 接管到系统浏览器。
    if (typeof window.electronAPI?.cardev?.openExternal !== "function") return false;
    event?.preventDefault?.();
    void openExternal(url).then((opened) => {
      if (!opened) onToast?.("无法调用系统默认应用打开该链接");
    });
    return true;
  }, [onToast]);
  return { resolveUrl, onOpenLink };
}

function StoryMessageMarkdown({ children, tabId, onToast, className = "" }) {
  const artifactRefs = useMemo(() => extractStoryArtifactRefs(children), [children]);
  const authorizedArtifactUrl = useStoryArtifactUrls(tabId, artifactRefs, onToast);
  const artifactUrl = useCallback(
    (_tabId, ref, options) => authorizedArtifactUrl(ref, options),
    [authorizedArtifactUrl],
  );
  const { resolveUrl, onOpenLink } = useStoryLinkTools(tabId, onToast, artifactUrl);
  const resolveDownloadUrl = useCallback((url) => {
    const reference = storyMessageArtifactRef(url);
    return reference ? authorizedArtifactUrl(reference, { download: true }) : url;
  }, [authorizedArtifactUrl]);
  return (
    <Markdown
      breaks
      richMedia
      className={className}
      resolveUrl={resolveUrl}
      onOpenLink={onOpenLink}
      classifyUrl={classifyStoryMessageUrl}
      fileName={storyMessageFileName}
      resolveDownloadUrl={resolveDownloadUrl}
    >
      {children}
    </Markdown>
  );
}

function StoryMessageContent({ children, tabId, onToast, className = "" }) {
  const [expanded, setExpanded] = useState(false);
  const plan = useMemo(
    () => planStoryMessageRender(children, { expanded }),
    [children, expanded],
  );
  if (plan.mode === "markdown") {
    return <StoryMessageMarkdown tabId={tabId} onToast={onToast} className={className}>{plan.content}</StoryMessageMarkdown>;
  }
  return (
    <div data-testid="devbench-oversized-message" data-render-mode={plan.mode} className={className}>
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2 rounded border border-amber-700/40 bg-amber-950/30 px-2.5 py-1.5 text-[11px] text-amber-200">
        <span>内容较大（{plan.totalChars.toLocaleString()} 字符），已跳过 Markdown 和附件扫描以保持页面流畅。</span>
        <button
          type="button"
          data-testid="devbench-oversized-message-toggle"
          onClick={() => setExpanded((value) => !value)}
          className="shrink-0 rounded border border-amber-600/50 px-2 py-0.5 text-amber-100 transition hover:bg-amber-900/50 focus:outline-none focus:ring-2 focus:ring-amber-400/60"
        >{expanded ? "收起完整文本" : "查看完整纯文本"}</button>
      </div>
      {plan.mode === "plain" ? (
        <textarea
          readOnly
          aria-label="超大消息完整纯文本"
          value={plan.content}
          className="h-[60vh] w-full resize-y rounded bg-zinc-950/60 p-2 font-mono text-xs leading-5 text-zinc-300 outline-none"
        />
      ) : (
        <pre className="max-h-[60vh] overflow-auto whitespace-pre-wrap break-words rounded bg-zinc-950/60 p-2 text-xs leading-5 text-zinc-300">{plan.content}</pre>
      )}
    </div>
  );
}

function StoryArtifactLink({ tabId, artifact, label, onToast, compact = false }) {
  const reference = artifact?.rel || artifact || "";
  const artifactRef = storyMessageArtifactRef(reference);
  const artifactRefs = useMemo(() => (artifactRef ? [artifactRef] : []), [artifactRef]);
  const authorizedArtifactUrl = useStoryArtifactUrls(tabId, artifactRefs, onToast);
  const artifactUrl = useCallback(
    (_tabId, ref, options) => authorizedArtifactUrl(ref, options),
    [authorizedArtifactUrl],
  );
  const { resolveUrl, onOpenLink } = useStoryLinkTools(tabId, onToast, artifactUrl);
  const href = resolveUrl(reference);
  if (!href) return null;
  const resolvedArtifactRef = artifactRef || storyMessageArtifactRef(href);
  const downloadHref = resolvedArtifactRef
    ? authorizedArtifactUrl(resolvedArtifactRef, { download: true })
    : href;
  const kind = classifyStoryMessageUrl(href);
  const icon = kind === "image" ? "🖼️" : kind === "pdf" ? "📕" : "📎";
  return (
    <span
      className={compact
        ? "inline-flex max-w-full items-center gap-1 rounded border border-violet-500/30 bg-violet-950/35 px-2 py-1 text-[10px] text-violet-200"
        : "inline-flex max-w-full items-center gap-1.5 rounded-lg border border-zinc-700 bg-zinc-900/80 px-2.5 py-1.5 text-[11px] text-zinc-200"}
      title={artifact?.name || storyMessageFileName(href)}
    >
      <span className="shrink-0" aria-hidden="true">{icon}</span>
      <span className="min-w-0 truncate">{label || artifact?.name || storyMessageFileName(href)}</span>
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        onClick={(event) => {
          if (onOpenLink(href, event) === true) event.preventDefault();
        }}
        className="shrink-0 rounded px-1 text-blue-300 transition hover:bg-blue-500/15 hover:text-blue-100"
      >预览 ↗</a>
      <a
        href={downloadHref}
        download={artifact?.name || storyMessageFileName(href)}
        className="shrink-0 rounded px-1 text-zinc-300 transition hover:bg-zinc-700 hover:text-white"
      >下载</a>
    </span>
  );
}

function norm(p) {
  return String(p || "").replace(/[\\/]+/g, "/").replace(/\/+$/, "").toLowerCase();
}
function extractCarbId(text) {
  return String(text || "").match(/#\s*(CARB-\d+)\s*#/i)?.[1]?.toUpperCase()
    || String(text || "").match(/\bCARB-\d+\b/i)?.[0]?.toUpperCase()
    || "";
}

// 客户端预览版本操作后的版本名/版本号（与后端 store.js 规则一致）。
// 末段=两位修订(00-99)，单个数字视为十位（尾0省略）：1.1.7→70。versionCode=主×10000+次×100+修订。
function splitVerC(name) {
  const p = String(name || "").trim().split(".");
  const a = parseInt(p[0], 10) || 0, b = parseInt(p[1], 10) || 0;
  const raw = p[2] != null ? String(p[2]).trim() : "0";
  const num = parseInt(raw, 10) || 0;
  const tail = raw.length <= 1 ? num * 10 : num;
  return { a, b, tail };
}
function codeForVersionName(name, width) {
  const { a, b, tail } = splitVerC(name);
  return width === 3 ? a * 100000 + b * 1000 + tail : a * 10000 + b * 100 + tail;
}
function codeWidthForVersionName(name, code) {
  const n = Number(code);
  if (!Number.isFinite(n)) return null;
  if (n === codeForVersionName(name, 3)) return 3;
  if (n === codeForVersionName(name, 2)) return 2;
  return String(Math.abs(Math.trunc(n))).length >= 6 ? 3 : 2;
}
function previewVersion(name, op, currentCode = null) {
  let { a, b, tail } = splitVerC(name);
  const old = { a, b, tail };
  let t;
  if (op === "deliver") t = Math.ceil(tail / 10) * 10;        // 提升为交付版本：向上取尾0
  else if (op === "test") { t = tail + 1; if (t % 10 === 0) t += 1; } // 更新测试版本号：+1 且尾号非0
  else t = tail + 10;                                          // 加10
  while (t >= 100) { t -= 100; b += 1; }
  while (b >= 100) { b -= 100; a += 1; }
  const nextName = `${a}.${b}.${t === 0 ? "0" : String(t).padStart(2, "0")}`;
  const crossedMinor = a !== old.a || b !== old.b;
  const width = crossedMinor && t === 0 ? 3 : (codeWidthForVersionName(name, currentCode) || 2);
  return { name: nextName, code: codeForVersionName(nextName, width) };
}
function previewBump(name) { return previewVersion(name, "bump10"); }

// 按分支类型着色（release 绿 / feature 蓝 / hotfix 红 / dev 橙 / main 灰 / 其它 紫）
export function branchStyle(branch) {
  const b = String(branch || "").toLowerCase();
  if (/^(release|rc)\b|\/(release|rc)/.test(b)) return "bg-emerald-900/40 border-emerald-700/50 text-emerald-300";
  if (/^(hotfix|fix|bugfix)\b|\/(hotfix|fix|bugfix)/.test(b)) return "bg-red-900/40 border-red-700/50 text-red-300";
  if (/^(feature|feat)\b|\/(feature|feat)/.test(b)) return "bg-sky-900/40 border-sky-700/50 text-sky-300";
  if (/^(dev|develop)\b|\/(dev|develop)/.test(b)) return "bg-amber-900/30 border-amber-700/50 text-amber-300";
  if (/^(main|master)$/.test(b)) return "bg-zinc-700 border-zinc-600 text-zinc-200";
  return "bg-violet-900/40 border-violet-700/50 text-violet-300";
}
// 分支徽标（无 git 时降级显示）
export function BranchTag({ branch, exists }) {
  if (branch) return <span className={`shrink-0 text-[10px] px-1.5 py-0.5 rounded border font-mono ${branchStyle(branch)}`} title={`当前分支：${branch}`}>⎇ {branch}</span>;
  return <span className="shrink-0 text-[10px] px-1.5 py-0.5 rounded border bg-zinc-800 border-zinc-700 text-zinc-600">{exists ? "非 git 仓库" : "路径无效"}</span>;
}

// 自定义主工程下拉：每项显示工程名 + 彩色分支标签（原生 select 无法放彩色徽标）
function ProjectSelect({ projects, value, otherOccupied, onChange, disabled = false }) {
  const [open, setOpen] = useState(false);
  const sel = projects.find((p) => p.id === value) || null;
  return (
    <div className="relative min-w-[320px]">
      <button
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center gap-2 bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-xs text-zinc-200 hover:border-zinc-500 disabled:opacity-50 disabled:cursor-not-allowed transition"
      >
        {sel ? (
          <>
            <span className="truncate text-left">{sel.name}{sel.webAppPath ? " (含WebApp)" : ""}</span>
            <BranchTag branch={sel.branch} exists={sel.exists} />
          </>
        ) : <span className="flex-1 text-left text-zinc-500">— 选择应用市场工程 —</span>}
        <span className={`ml-auto text-zinc-500 transition-transform ${open ? "rotate-180" : ""}`}>▾</span>
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-30" onClick={() => setOpen(false)} />
          <div className="absolute left-0 top-full mt-1 z-40 min-w-full w-max max-w-[680px] max-h-72 overflow-auto bg-zinc-900 border border-zinc-700 rounded-lg shadow-2xl py-1">
            <button onClick={() => { onChange(""); setOpen(false); }} className="w-full text-left px-3 py-1.5 text-xs text-zinc-500 hover:bg-zinc-800 whitespace-nowrap transition">— 选择应用市场工程 —</button>
            {projects.map((p) => {
              const occupied = false;
              const disabled = !p.exists;
              return (
                <button
                  key={p.id}
                  disabled={disabled}
                  onClick={() => { if (!disabled) { onChange(p.id); setOpen(false); } }}
                  className={`w-full flex items-center gap-2 px-3 py-1.5 text-xs transition ${disabled ? "opacity-50 cursor-not-allowed" : "hover:bg-zinc-800"} ${p.id === value ? "bg-blue-600/20" : ""}`}
                  title={p.path}
                >
                  <span className="text-zinc-200 whitespace-nowrap text-left">
                    {p.name}{p.webAppPath ? " (含WebApp)" : ""}{!p.exists ? " — 路径不存在" : " — 自动创建独立 worktree"}
                  </span>
                  <BranchTag branch={p.branch} exists={p.exists} />
                </button>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}

// 拖入文件夹时跳过的重目录（避免误拖整个工程导致海量上传）
const SKIP_DIRS = new Set([".git", "node_modules", ".gradle", "build", ".idea", "dist", ".cache"]);
const MAX_FOLDER_FILES = 800; // 单次拖入文件夹的文件数上限

// 反复调用 readEntries 直到返回空（DirectoryReader 每次最多给 100 条，必须循环取完）
function readAllEntries(reader) {
  return new Promise((resolve) => {
    const all = [];
    const pump = () => reader.readEntries(
      (batch) => { if (!batch.length) return resolve(all); all.push(...batch); pump(); },
      () => resolve(all),
    );
    pump();
  });
}

// 递归收集一个 FileSystemEntry 下的全部文件，relPath 以拖入的文件夹名为根保留层级
async function collectEntryFiles(entry, base, out) {
  if (out.length >= MAX_FOLDER_FILES) return;
  if (entry.isFile) {
    const file = await new Promise((res, rej) => entry.file(res, rej));
    out.push({ file, relPath: base + entry.name });
  } else if (entry.isDirectory) {
    if (SKIP_DIRS.has(entry.name)) return;
    const entries = await readAllEntries(entry.createReader());
    for (const e of entries) await collectEntryFiles(e, base + entry.name + "/", out);
  }
}

async function collectEntryFilesNoSkip(entry, base, out) {
  if (out.length >= MAX_FOLDER_FILES) return;
  if (entry.isFile) {
    const file = await new Promise((res, rej) => entry.file(res, rej));
    out.push({ file, relPath: base + entry.name });
  } else if (entry.isDirectory) {
    const entries = await readAllEntries(entry.createReader());
    for (const e of entries) await collectEntryFilesNoSkip(e, base + entry.name + "/", out);
  }
}

// 单行跑马灯：内容一行展示，超出容器宽度时横向滚动（鼠标悬停暂停），不超出则静态截断
function MarqueeLine({ children, className = "", title }) {
  const wrapRef = useRef(null);
  const measureRef = useRef(null);
  const [overflow, setOverflow] = useState(false);
  useEffect(() => {
    const check = () => {
      const w = wrapRef.current, m = measureRef.current;
      if (!w || !m) return;
      setOverflow(m.scrollWidth > w.clientWidth + 2);
    };
    check();
    const ro = new ResizeObserver(check);
    if (wrapRef.current) ro.observe(wrapRef.current);
    if (measureRef.current) ro.observe(measureRef.current);
    return () => ro.disconnect();
  }, [children]);
  return (
    <div ref={wrapRef} className={`overflow-hidden whitespace-nowrap ${className}`} title={title}>
      {overflow ? (
        <div className="inline-flex marquee-track">
          <span ref={measureRef} className="px-6">{children}</span>
          <span className="px-6" aria-hidden>{children}</span>
        </div>
      ) : (
        <span ref={measureRef} className="inline-block max-w-full truncate">{children}</span>
      )}
    </div>
  );
}

// 在资源管理器中打开工程路径
function OpenBtn({ path, className = "" }) {
  if (!path) return null;
  return (
    <button
      onClick={(e) => { e.stopPropagation(); devbenchApi.openDir(path); }}
      title={`在资源管理器中打开：${path}`}
      className={`shrink-0 text-zinc-500 hover:text-sky-300 transition ${className}`}
    >📂</button>
  );
}

// scrcpy 投屏：主按钮投主屏；▾ 下拉选择多屏（主/副/虚拟，带分辨率与备注）
function ScrcpyBtn({ tabId, onToast }) {
  const [busy, setBusy] = useState(false);
  const [menu, setMenu] = useState(false);
  const [list, setList] = useState(null);
  const [loading, setLoading] = useState(false);

  async function mirror(displayId) {
    setBusy(true); setMenu(false);
    const r = await devbenchApi.scrcpy(tabId, displayId);
    setBusy(false);
    if (r && r.ok === false) onToast?.(r.error || "投屏失败");
    else onToast?.(displayId != null && displayId !== 0 ? `正在投屏 显示屏 ${displayId}…` : "正在投屏 主屏…");
  }
  async function openMenu(e) {
    e.stopPropagation();
    if (!menu) { setLoading(true); const r = await devbenchApi.listDisplays(tabId); setLoading(false); setList(r?.ok ? (r.data || []) : []); if (!r?.ok) onToast?.(r?.error || "读取显示屏失败"); }
    setMenu((v) => !v);
  }
  const kindColor = (k) => k === "main" ? "text-cyan-300" : k === "virtual" ? "text-amber-300" : "text-emerald-300";

  return (
    <span className="relative inline-flex shrink-0">
      <button
        disabled={busy}
        onClick={(e) => { e.stopPropagation(); mirror(); }}
        className="text-[11px] pl-1.5 pr-1 py-0.5 rounded-l bg-cyan-700/40 hover:bg-cyan-600/50 text-cyan-200 border border-cyan-700/50 border-r-0 transition disabled:opacity-50"
        title="scrcpy 投屏主屏"
      >{busy ? "投屏中…" : "📺 投屏"}</button>
      <button
        disabled={busy}
        onClick={openMenu}
        title="选择要投的显示屏（多屏设备：主屏/副屏/虚拟屏）"
        className="text-[11px] px-1 py-0.5 rounded-r bg-cyan-700/40 hover:bg-cyan-600/50 text-cyan-200 border border-cyan-700/50 transition disabled:opacity-50"
      >▾</button>
      {menu && (
        <>
          <div className="fixed inset-0 z-40" onClick={(e) => { e.stopPropagation(); setMenu(false); }} />
          <div className="absolute z-50 top-full right-0 mt-1 w-[300px] max-w-[84vw] bg-zinc-900 border border-zinc-700 rounded-lg shadow-2xl py-1">
            <div className="px-3 py-1 text-[10px] text-zinc-500 border-b border-zinc-800">选择显示屏（默认主屏）</div>
            {loading ? (
              <div className="px-3 py-2 text-[11px] text-zinc-500">读取显示屏中…</div>
            ) : (list || []).length === 0 ? (
              <div className="px-3 py-2 text-[11px] text-amber-400">未读取到显示屏（设备离线？）</div>
            ) : (
              (list || []).map((d) => (
                <button key={d.id} onClick={(e) => { e.stopPropagation(); mirror(d.id); }}
                  title={`display-id ${d.id}${d.name ? ` · ${d.name}` : ""}${d.type ? ` · ${d.type}` : ""}`}
                  className="w-full text-left px-3 py-1.5 hover:bg-zinc-800 transition flex items-center gap-2">
                  <span className={`text-[11px] font-medium ${kindColor(d.kind)}`}>{d.label}</span>
                  <span className="text-[10px] text-zinc-500 font-mono">#{d.id}</span>
                  {d.resolution && <span className="text-[10px] text-zinc-500 font-mono">{d.resolution}</span>}
                  <span className="text-[10px] text-zinc-600 truncate flex-1 text-right">{d.note || d.name || d.type}</span>
                </button>
              ))
            )}
          </div>
        </>
      )}
    </span>
  );
}

// 仿 Android Studio Logcat 设备显示：「<厂商 车型> (<serial>) Android <版本>, API <级别> [OFFLINE]」
// 取不到车型/版本时退化为只显示 serial，离线/未授权追加状态标。
function fmtDeviceLabel(d) {
  const head = d.deviceLabel ? `${d.deviceLabel} (${d.id})` : d.id;
  const ver = d.androidVersion ? ` Android ${d.androidVersion}` : "";
  const api = d.apiLevel ? `, API ${d.apiLevel}` : "";
  const tag = d.status && d.status !== "device" ? ` [${String(d.status).toUpperCase()}]` : "";
  return `${head}${ver}${api}${tag}`;
}

// 本故事点的 AI 引擎切换（悬浮按钮）。每个故事点独立选 AI（claude/gemini/codex/hermes/API），非全局；
// AI 正在工作时置灰不可切换；未安装的引擎在菜单里置灰。
function shortEngine(id, name) {
  const s = String(id || name || "AI").replace(/[^a-z0-9]/gi, "");
  return (s.slice(0, 2) || "AI").toUpperCase();
}
function buildEngineOptions(status, cur) {
  const byId = new Map(BASE_DEVBENCH_ENGINES.map((e) => [e.id, e]));
  // 仅当火山方舟 API 引擎明确未配置时隐藏；官方 Claude「需登录」不得隐藏方舟选项
  // （方舟走 API Key，不依赖 anthropic 订阅登录）
  if (status && cur !== "claude-volcengine") {
    const volcApiReady = status.volcengine?.available === true;
    const arkStatus = status["claude-volcengine"]?.status;
    const arkKeyMissing = arkStatus === "missing_key" || arkStatus === "disabled";
    if (!volcApiReady && (arkKeyMissing || status.volcengine?.available === false)) {
      byId.delete("claude-volcengine");
    }
  }
  // Codex（MiniMax）依赖 MiniMax API Key；未配置时隐藏（与方舟同思路）
  if (status && cur !== "codex-minimax") {
    const mmApiReady = status.minimax?.available === true;
    const cmStatus = status["codex-minimax"]?.status;
    const cmKeyMissing = cmStatus === "missing_key" || cmStatus === "disabled";
    if (!mmApiReady && (cmKeyMissing || status.minimax?.available === false)) {
      byId.delete("codex-minimax");
    }
  }
  if (status) {
    Object.entries(status).forEach(([id, st]) => {
      if (byId.has(id)) return;
      if (st?.type === "api") byId.set(id, { id, name: st.name || id, short: shortEngine(id, st.name), api: true });
    });
  }
  if (cur && !byId.has(cur)) {
    const known = BASE_DEVBENCH_ENGINES.find((e) => e.id === cur);
    byId.set(cur, known || { id: cur, name: cur, short: shortEngine(cur), api: true });
  }
  return [...byId.values()];
}
function engineDisplayName(id, fallback) {
  const name = fallback || id || "AI";
  if (id === "center" || id === "distributed-center") return "中心机";
  if (id === "claude") return "Claude（官方）";
  if (id === "claude-volcengine") return "Claude（火山方舟）";
  if (id === "claude-minimax") return "Claude（MiniMax）";
  if (id === "claude-atlas") return "Claude Code（Atlas Coding Plan）";
  if (id === "codex") return "Codex（OpenAI 官方）";
  if (id === "codex-minimax") return "Codex（MiniMax）";
  if (id === "codex-atlas") return "Codex CLI（Atlas Coding Plan）";
  if (id === "gemini") return "Gemini（Google）";
  if (id === "hermes") return "Hermes Agent（本地）";
  if (id === "hermes-atlas") return "Hermes（Atlas Coding Plan）";
  return name;
}
function engineSupportsRealtimeAppend(id) {
  const engine = String(id || "").trim().toLowerCase();
  return engine === "codex"
    || engine === "codex-minimax"
    || engine === "codex-atlas"
    || engine === "claude"
    || engine === "claude-volcengine"
    || engine === "claude-minimax"
    || engine === "claude-atlas";
}
// MiniMax 系列引擎（Claude×MiniMax / Codex×MiniMax）会产生明显的「思考流」，
// 需要把思考流与最终回答在聊天框内分开显示，且思考流可展开/收起。
// 同时支持「引擎是 claude/codex 官方，但模型名是 MiniMax」的场景：
// 一键把默认 ~/.claude / ~/.codex 切到 MiniMax 端点后，引擎 ID 仍是 claude/codex，
// 但实际模型是 MiniMax-M3 等思考型模型，同样需要分开显示思考流。
function isMiniMaxEngine(id) {
  const engine = String(id || "").trim().toLowerCase();
  return engine === "claude-minimax" || engine === "codex-minimax";
}
function isMiniMaxModelName(model) {
  return /minimax/i.test(String(model || ""));
}
// 综合引擎 ID 与模型名判断是否为 MiniMax 回答。
// 入参可传 { engine, aiSnapshot, model } 任一组合：engine 命中 MiniMax 引擎，
// 或 aiSnapshot.model / model 命中 MiniMax 模型名（如 claude 官方引擎下配 MiniMax-M3）。
function isMiniMaxAnswer({ engine, aiSnapshot, model } = {}) {
  if (isMiniMaxEngine(engine)) return true;
  const snapshotModel = aiSnapshot && typeof aiSnapshot === "object" ? String(aiSnapshot.model || "") : "";
  if (isMiniMaxModelName(snapshotModel)) return true;
  if (isMiniMaxModelName(model)) return true;
  return false;
}
// 把 transcript 中所有 thinking 条目按时间顺序拼接成一段思考流文本。
function thinkingTextFromTranscript(transcript) {
  if (!Array.isArray(transcript) || transcript.length === 0) return "";
  return transcript
    .filter((t) => t && t.type === "thinking" && t.content)
    .map((t) => String(t.content))
    .join("\n")
    .trim();
}
// 思考流卡片：与 AI 回答视觉上分开，默认可展开/收起。
// streaming=true 时默认展开（让用户实时看到思考），结束后保留可收起能力；
// 最终消息（非流式）默认收起，避免长思考流淹没回答正文。
function ThinkingStream({ text, streaming = false, defaultOpen }) {
  const [open, setOpen] = useState(() => (typeof defaultOpen === "boolean" ? defaultOpen : !!streaming));
  const trimmed = String(text || "").trim();
  if (!trimmed) return null;
  return (
    <div className="mb-2 rounded-lg border border-amber-500/25 bg-amber-500/[0.04] overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        data-testid="devbench-thinking-stream-toggle"
        className="flex w-full items-center gap-2 px-2.5 py-1.5 text-[11px] text-amber-300/90 hover:bg-amber-500/5 transition-colors"
      >
        <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${streaming ? "bg-amber-400 animate-pulse" : "bg-amber-500/60"}`} />
        <span className="shrink-0 font-medium">💭 思考流</span>
        {streaming && <span className="text-[10px] text-amber-400/70">正在思考…</span>}
        <span className="ml-auto shrink-0 text-[10px] text-amber-400/70">{open ? "收起" : "展开"}</span>
      </button>
      {open && (
        <div
          data-testid="devbench-thinking-stream-body"
          className="border-t border-amber-500/15 bg-zinc-950/40 px-2.5 py-2 text-[11px] leading-relaxed text-zinc-400 whitespace-pre-wrap max-h-64 overflow-y-auto"
        >
          {trimmed}
        </div>
      )}
    </div>
  );
}
function EngineSwitchButton({
  tab, isRunning, onRefreshTab, onToast, variant = "circle",
  status, statusLoading, onRefreshStatus, metadata = {},
}) {
  const [open, setOpen] = useState(false);
  const [expandedEngineGroup, setExpandedEngineGroup] = useState("");
  const [prefsBusy, setPrefsBusy] = useState(false);
  const [customModel, setCustomModel] = useState("");
  const triggerRef = useRef(null);
  const cur = tab.engine || "claude";
  const engineOptions = buildEngineOptions(status, cur);
  const engineGroups = buildEnginePickerGroups(engineOptions, cur);
  const curMeta = engineOptions.find((e) => e.id === cur) || BASE_DEVBENCH_ENGINES[0];
  const curGroupId = engineGroupId(curMeta);
  const curGroup = engineGroups.find((group) => group.id === curGroupId);
  const curSelectionName = `${curGroup?.name || "AI"} · ${curMeta.productName || curMeta.name || cur}`;
  const curModelTier = engineModelTier(metadata, cur);
  const curItem = metadata?.[cur] || {};
  const curProductName = curItem.name || engineDisplayName(curMeta.id, curMeta.name);
  const curCompactProductName = compactEngineProductName(curMeta, curProductName);
  const catalog = curItem.catalog || { models: [], tiers: [] };
  const storyPrefs = (tab.aiPrefs && tab.aiPrefs[cur]) || {};
  const storyModel = String(storyPrefs.model || "").trim();
  const storyTier = String(storyPrefs.tier || "").trim();
  const modelChoices = [...new Set([
    ...(Array.isArray(catalog.models) ? catalog.models : []),
    ...(curModelTier.modelConfigured ? [String(curItem.model || "").trim()] : []),
    ...(storyModel ? [storyModel] : []),
  ].filter(Boolean))];
  const tierChoices = Array.isArray(catalog.tiers) ? catalog.tiers : [];
  const curLabel = `${curSelectionName} · ${curModelTier.model} · ${curModelTier.tier}`;
  const closePicker = useCallback(() => {
    setOpen(false);
    requestAnimationFrame(() => triggerRef.current?.focus());
  }, []);
  useEffect(() => {
    if (!open) return undefined;
    const focusTimer = requestAnimationFrame(() => {
      document.querySelector(`[data-testid="devbench-ai-cli-group-${curGroupId}"]`)?.focus();
    });
    const onKeyDown = (event) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      closePicker();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      cancelAnimationFrame(focusTimer);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [closePicker, curGroupId, open]);
  const onClickBtn = () => {
    if (isRunning) return;
    if (open) { closePicker(); return; }
    setCustomModel(storyModel || "");
    setExpandedEngineGroup(curGroupId);
    setOpen(true);
    // 先展示持久化的上次结果；每次打开都在后台复检，完成后由父组件同时更新两个入口。
    onRefreshStatus?.();
  };
  const pick = async (id) => {
    if (id === cur) return;
    const targetOption = engineOptions.find((option) => option.id === id);
    const targetGroup = engineGroups.find((group) => group.id === engineGroupId(targetOption));
    const r = await devbenchApi.setEngine(tab.id, id);
    if (!r.ok) { onToast?.(r.error || "切换 AI 失败"); return; }
    setExpandedEngineGroup(targetGroup?.id || "");
    onToast?.(`本故事点 AI 已切换为 ${targetGroup?.name || "AI"} · ${targetOption?.productName || targetOption?.name || id}`);
    onRefreshTab?.();
  };
  const savePrefs = async (patch) => {
    if (prefsBusy || isRunning) return;
    setPrefsBusy(true);
    try {
      const r = await devbenchApi.setEnginePrefs(tab.id, { engine: cur, ...patch });
      if (!r.ok) { onToast?.(r.error || "设置模型/档位失败"); return; }
      onToast?.("已保存本故事点的模型/档位（不影响全局配置）");
      onRefreshTab?.();
    } finally {
      setPrefsBusy(false);
    }
  };
  const isPill = variant === "pill";
  return (
    <div className="relative">
      <button ref={triggerRef} onClick={onClickBtn} disabled={isRunning}
        title={isRunning ? `AI 正在工作中，无法切换：${curLabel}` : `当前 AI：${curLabel}（点击切换引擎/模型/档位；每个故事点独立）`}
        aria-label={`当前 AI 产品：${curCompactProductName}，点击切换`}
        data-testid={isPill ? "devbench-current-ai" : "devbench-floating-ai"}
        data-engine={cur}
        data-model={curModelTier.model}
        data-tier={curModelTier.tier}
        className={`${isPill ? "h-9 max-w-28 px-2 rounded-lg gap-1 text-xs" : "w-9 h-9 rounded-full text-[11px]"} shadow-lg border transition flex items-center justify-center font-bold ${
          isRunning ? "opacity-40 cursor-not-allowed bg-zinc-800/90 border-zinc-700 text-zinc-500"
            : open ? "bg-blue-600 border-blue-500 text-white"
            : "bg-zinc-800/90 border-zinc-700 text-zinc-300 hover:text-white hover:bg-zinc-700"}`}
      >
        {isPill ? (
          <>
            <span data-testid="devbench-current-ai-product" className="max-w-[80px] truncate text-blue-200">{curCompactProductName}</span>
            <span className="text-[10px] opacity-70">▾</span>
          </>
        ) : curMeta.short}
      </button>
      {open && !isRunning && typeof document !== "undefined" && createPortal(
        <>
          <button
            type="button"
            tabIndex={-1}
            aria-label="关闭 AI 选择器"
            data-ui-layer="modal-backdrop" className="fixed inset-0 z-40 cursor-default"
            onClick={closePicker}
          />
          <div
            data-testid="devbench-ai-picker"
            role="dialog"
            aria-modal="true"
            aria-label="选择故事点 AI"
            data-ui-layer="modal" className="fixed inset-x-2 bottom-16 z-50 flex max-h-[calc(100vh-5rem)] flex-col overflow-hidden rounded-lg border border-zinc-700 bg-zinc-900 py-1 shadow-2xl sm:left-auto sm:right-16 sm:w-[22rem]"
          >
            <div className="shrink-0 px-3 py-1.5 text-[10px] text-zinc-500 border-b border-zinc-800">
              <div>先选择 CLI，再选择 AI 产品；模型 / 档位按故事点独立保存</div>
              {statusLoading && <div className="mt-0.5 text-blue-300">{status ? "正在复检，当前显示上次结果…" : "首次检测中…"}</div>}
              {curItem.overridden && <div className="mt-0.5 text-amber-400/90">已覆盖全局配置</div>}
            </div>
            <div className="max-h-64 shrink-0 overflow-y-auto py-1 border-b border-zinc-800" data-testid="devbench-ai-cli-groups">
              {engineGroups.map((group) => {
                const expanded = expandedEngineGroup === group.id;
                return (
                  <div key={group.id} className="border-b border-zinc-800/70 last:border-b-0">
                    <button
                      type="button"
                      data-testid={`devbench-ai-cli-group-${group.id}`}
                      aria-expanded={expanded}
                      aria-controls={`devbench-ai-products-${group.id}`}
                      onClick={() => setExpandedEngineGroup((current) => current === group.id ? "" : group.id)}
                      className={`w-full px-3 py-2 text-left flex items-center gap-2 transition hover:bg-zinc-800/80 ${group.selected ? "text-blue-200" : "text-zinc-200"}`}
                    >
                      <span className="w-3 shrink-0 text-[10px] text-zinc-500" aria-hidden="true">{expanded ? "▾" : "▸"}</span>
                      <span className="min-w-0 flex-1 text-xs font-medium">{group.name}</span>
                      {group.selected && (
                        <span className="max-w-[132px] truncate text-[10px] font-normal text-blue-300" title={group.selectedProductName}>
                          {group.selectedProductName}
                        </span>
                      )}
                      <span className="shrink-0 rounded-full bg-zinc-800 px-1.5 py-0.5 text-[9px] font-mono text-zinc-500">
                        {group.options.length}
                      </span>
                    </button>
                    {expanded && (
                      <div
                        id={`devbench-ai-products-${group.id}`}
                        role="radiogroup"
                        aria-label={`${group.name} AI 产品`}
                        className="bg-zinc-950/35 py-1 pl-4"
                      >
                        {group.options.map((e) => {
                const hasResult = !!status && Object.prototype.hasOwnProperty.call(status, e.id);
                const result = hasResult ? status[e.id] : null;
                const avail = !hasResult || result?.available !== false;
                const resultLabel = hasResult ? engineStatusLabel(result) : (statusLoading ? "待检测" : "未检测");
                const disabledHint = result?.error
                  || (e.id === "claude-volcengine"
                    ? "请先在设置启用火山方舟并安装 Claude CLI"
                    : (e.api ? "未启用或未配置 Key" : "未安装或未登录"));
                const modelTierText = engineModelTierText(metadata, e.id);
                return (
                  <button
                    key={e.id}
                    type="button"
                    role="radio"
                    aria-checked={e.id === cur}
                    data-testid={`devbench-ai-product-${e.id}`}
                    disabled={!avail}
                    onClick={() => pick(e.id)}
                    className={`w-full text-left px-3 py-1.5 text-xs flex items-center gap-2 transition ${!avail ? "opacity-40 cursor-not-allowed" : "hover:bg-zinc-800"} ${e.id === cur ? "text-blue-300" : "text-zinc-200"}`}
                  >
                    <span className="shrink-0">{e.id === cur ? "●" : "○"}</span>
                    <span className="min-w-0 flex-1">
                      <span className="block">{e.productName}</span>
                      <span className="block truncate font-mono text-[10px] font-normal text-zinc-500" title={modelTierText}>{modelTierText}</span>
                    </span>
                    <span className={`ml-auto text-[10px] ${hasResult ? (avail ? "text-emerald-400" : "text-amber-500") : "text-zinc-600"}`} title={!avail ? disabledHint : ""}>{resultLabel}</span>
                  </button>
                );
                        })}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
            <div className="min-h-0 overflow-y-auto px-3 py-2 space-y-2" data-testid="devbench-ai-prefs">
              <div>
                <div className="text-[10px] text-zinc-500 mb-1">模型（{curSelectionName}）</div>
                <select
                  disabled={prefsBusy}
                  value={storyModel && modelChoices.includes(storyModel) ? storyModel : ""}
                  onChange={(e) => {
                    const v = e.target.value;
                    setCustomModel(v);
                    savePrefs({ model: v });
                  }}
                  className="w-full bg-zinc-950 border border-zinc-700 rounded-md px-2 py-1.5 text-xs text-zinc-200 font-mono outline-none focus:border-blue-500"
                >
                  <option value="">使用全局默认</option>
                  {modelChoices.map((m) => <option key={m} value={m}>{m}</option>)}
                </select>
                <div className="mt-1.5 flex gap-1.5">
                  <input
                    value={customModel}
                    disabled={prefsBusy}
                    onChange={(e) => setCustomModel(e.target.value)}
                    placeholder="或自定义模型名"
                    className="min-w-0 flex-1 bg-zinc-950 border border-zinc-700 rounded-md px-2 py-1 text-xs text-zinc-200 font-mono outline-none focus:border-blue-500"
                  />
                  <button
                    type="button"
                    disabled={prefsBusy || !String(customModel || "").trim() || String(customModel || "").trim() === storyModel}
                    onClick={() => savePrefs({ model: String(customModel || "").trim() })}
                    className="shrink-0 px-2 py-1 text-[10px] rounded-md bg-zinc-800 border border-zinc-600 text-zinc-200 hover:bg-zinc-700 disabled:opacity-40"
                  >应用</button>
                </div>
              </div>
              {tierChoices.length > 0 && (
                <div>
                  <div className="text-[10px] text-zinc-500 mb-1">推理档位</div>
                  <div className="flex flex-wrap gap-1">
                    <button
                      type="button"
                      disabled={prefsBusy}
                      onClick={() => savePrefs({ tier: "" })}
                      className={`px-2 py-1 text-[10px] rounded-md border transition ${!storyTier ? "bg-blue-600/30 border-blue-500 text-blue-200" : "bg-zinc-950 border-zinc-700 text-zinc-400 hover:border-zinc-500"}`}
                    >全局默认</button>
                    {tierChoices.map((t) => (
                      <button
                        key={t}
                        type="button"
                        disabled={prefsBusy}
                        onClick={() => savePrefs({ tier: t })}
                        className={`px-2 py-1 text-[10px] rounded-md border font-mono transition ${storyTier === t ? "bg-amber-600/30 border-amber-500 text-amber-200" : "bg-zinc-950 border-zinc-700 text-zinc-300 hover:border-zinc-500"}`}
                      >{t}</button>
                    ))}
                  </div>
                </div>
              )}
              {!tierChoices.length && (
                <div className="text-[10px] text-zinc-600">当前引擎无档位选项（或使用全局默认）</div>
              )}
            </div>
          </div>
        </>,
        document.body,
      )}
    </div>
  );
}

function normalizeCenterHost(host) {
  return String(host || "").replace(/\/+$/, "");
}

function centerOptionLabel(server) {
  if (!server) return "";
  const host = normalizeCenterHost(server.host);
  const name = server.name || host;
  const free = server.capacity?.free != null ? ` · 空闲${server.capacity.free}` : "";
  const full = server.full ? " · 忙" : "";
  return `${name}${full}${free}`;
}

function CenterSwitchButton({ tab, isRunning, centerServers = [], centerConfig = {}, onSetCenter, onToast, variant = "circle" }) {
  const [open, setOpen] = useState(false);
  const activeHost = normalizeCenterHost(tab.centerHost || centerConfig?.selectedHost || "");
  const current = centerServers.find((s) => normalizeCenterHost(s.host) === activeHost) || null;
  const globalName = !tab.centerHost ? (centerConfig?.selectedName || "") : "";
  const globalLabel = centerConfig?.selectedName || centerConfig?.selectedHost || "";
  const label = current?.name || tab.centerName || globalName || activeHost || "未选AI服务器";
  const hasGlobal = !!centerConfig?.selectedHost;
  const isPill = variant === "pill";
  const canPick = !isRunning && !!onSetCenter;
  const pick = async (server) => {
    if (!canPick) return;
    setOpen(false);
    const r = await onSetCenter(server);
    if (r?.ok === false) onToast?.(r.error || "切换AI服务器失败");
  };
  return (
    <div className="relative">
      <button
        onClick={() => canPick && setOpen((v) => !v)}
        disabled={!canPick}
        title={isRunning ? "AI 正在工作中，无法切换AI服务器" : `当前 AI 服务器设备：${label}`}
        className={`${isPill ? "h-9 px-3 rounded-lg gap-1.5 text-xs" : "w-9 h-9 rounded-full text-[11px]"} shadow-lg border transition flex items-center justify-center font-bold ${
          !canPick ? "opacity-40 cursor-not-allowed bg-zinc-800/90 border-zinc-700 text-zinc-500"
            : open ? "bg-emerald-600 border-emerald-500 text-white"
            : activeHost ? "bg-emerald-900/80 border-emerald-700 text-emerald-200 hover:bg-emerald-800"
            : "bg-amber-900/80 border-amber-700 text-amber-200 hover:bg-amber-800"}`}
      >
        {isPill ? (
          <>
            <span className="text-[10px] text-zinc-400 font-normal">AI服务器</span>
            <span className="max-w-[150px] truncate">{label}</span>
            <span className="text-[10px] opacity-70">▾</span>
          </>
        ) : "中"}
      </button>
      {open && canPick && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className={`${isPill ? "absolute right-0 bottom-full mb-2" : "absolute right-full top-0 mr-2"} z-50 w-64 bg-zinc-900 border border-zinc-700 rounded-lg shadow-2xl py-1`}>
            <div className="px-3 py-1.5 text-[10px] text-zinc-500 border-b border-zinc-800">选择这个故事点使用的 AI 服务器</div>
            <button
              onClick={() => pick(null)}
              className={`w-full text-left px-3 py-1.5 text-xs flex items-center gap-2 transition hover:bg-zinc-800 ${!tab.centerHost ? "text-emerald-300" : "text-zinc-200"}`}
            >
              <span className="shrink-0">{!tab.centerHost ? "●" : "○"}</span>
              <span className="min-w-0 truncate">用设置页已选的AI服务器{hasGlobal ? ` · ${globalLabel}` : " · 还未选择"}</span>
            </button>
            {activeHost && !centerServers.some((s) => normalizeCenterHost(s.host) === activeHost) && (
              <button disabled className="w-full text-left px-3 py-1.5 text-xs flex items-center gap-2 text-amber-300/80 opacity-80">
                <span className="shrink-0">●</span>
                <span className="min-w-0 truncate">{tab.centerName || globalName || activeHost} · 未发现</span>
              </button>
            )}
            {centerServers.map((server) => {
              const host = normalizeCenterHost(server.host);
              const selected = !!host && host === activeHost && !!tab.centerHost;
              return (
                <button
                  key={`${server.id || ""}-${host}`}
                  disabled={!!server.full}
                  onClick={() => pick(server)}
                  className={`w-full text-left px-3 py-1.5 text-xs flex items-center gap-2 transition ${server.full ? "opacity-40 cursor-not-allowed" : "hover:bg-zinc-800"} ${selected ? "text-emerald-300" : "text-zinc-200"}`}
                  title={host}
                >
                  <span className="shrink-0">{selected ? "●" : "○"}</span>
                  <span className="min-w-0 truncate">{centerOptionLabel(server)}</span>
                </button>
              );
            })}
            {!centerServers.length && <div className="px-3 py-2 text-[11px] text-zinc-500">未发现可用 AI 服务器，请先到设置页选择，或等待局域网发现。</div>}
          </div>
        </>
      )}
    </div>
  );
}

// 复制故事点名字到剪贴板（编辑按钮旁）
function CopyNameBtn({ name, onToast, className = "" }) {
  const [copied, setCopied] = useState(false);
  if (!name) return null;
  return (
    <button
      onClick={async (e) => {
        e.stopPropagation();
        await copyToClipboard(name);
        setCopied(true);
        onToast?.("已复制故事点名字");
        setTimeout(() => setCopied(false), 1500);
      }}
      title={`复制故事点名字：${name}`}
      className={`shrink-0 transition ${copied ? "text-emerald-400" : "text-zinc-500 hover:text-sky-300"} ${className}`}
    >{copied ? "✓" : "📋"}</button>
  );
}

// 编辑菜单（类 Android Studio 的下拉）：紧邻 📋，收纳故事点的编辑类操作（重命名 / 在资源管理器打开主工程）
function EditMenuBtn({ onRename, primaryPath = "", className = "" }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="relative shrink-0">
      <button
        onClick={(e) => { e.stopPropagation(); setOpen((o) => !o); }}
        title="编辑菜单（重命名故事点 / 在资源管理器打开主工程等）"
        className={`shrink-0 transition ${open ? "text-sky-300" : "text-zinc-500 hover:text-sky-300"} ${className}`}
      >✎▾</button>
      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute left-0 top-full mt-1 z-50 w-52 bg-zinc-900 border border-zinc-700 rounded-lg shadow-2xl py-1">
            <div className="px-3 py-1.5 text-[10px] text-zinc-500 border-b border-zinc-800">编辑</div>
            <button
              onClick={() => { setOpen(false); onRename?.(); }}
              className="w-full text-left px-3 py-1.5 text-xs flex items-center gap-2 text-zinc-200 hover:bg-zinc-800 transition"
            ><span className="shrink-0">✎</span><span>重命名故事点名字</span></button>
            {primaryPath && (
              <button
                onClick={() => { setOpen(false); devbenchApi.openDir(primaryPath); }}
                title={`在资源管理器中打开：${primaryPath}`}
                className="w-full text-left px-3 py-1.5 text-xs flex items-center gap-2 text-zinc-200 hover:bg-zinc-800 transition"
              ><span className="shrink-0">📂</span><span>在资源管理器打开主工程</span></button>
            )}
          </div>
        </>
      )}
    </div>
  );
}

// 工程配置菜单：把「复制配置 / 应用配置」合并到一个按钮，点击出下拉框选择
function ConfigMenuBtn({ configClip, onCopyConfig, onApplyConfig }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="relative shrink-0">
      <button
        onClick={(e) => { e.stopPropagation(); setOpen((o) => !o); }}
        title="工程配置：复制本故事点配置 / 应用已复制的配置到本故事点"
        className="text-[11px] px-2 py-0.5 rounded bg-zinc-800 text-zinc-300 hover:text-white hover:bg-zinc-700 transition"
      >⚙ 配置 ▾</button>
      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute right-0 top-full mt-1 z-50 w-60 max-w-[calc(100vw-1rem)] bg-zinc-900 border border-zinc-700 rounded-lg shadow-2xl py-1">
            <div className="px-3 py-1.5 text-[10px] text-zinc-500 border-b border-zinc-800">工程配置</div>
            <button
              onClick={() => { setOpen(false); onCopyConfig?.(); }}
              title="复制本故事点的工程配置（主工程 / 本地或远程路径 / 分支 / flavor / 设备 / 关联工程；不含标题/任务/附件），可一键应用到其它故事点"
              className="w-full text-left px-3 py-1.5 text-xs flex items-center gap-2 text-zinc-200 hover:bg-zinc-800 transition"
            ><span className="shrink-0">📋</span><span>复制配置</span></button>
            {configClip && (
              <button
                onClick={() => { setOpen(false); onApplyConfig?.(); }}
                title={`应用已复制的工程配置（来自「${configClip.sourceTitle || "?"}」）到本故事点；工程创建独立 worktree，仅设备仍按需接管`}
                className="w-full text-left px-3 py-1.5 text-xs flex items-start gap-2 text-blue-300 hover:bg-zinc-800 transition"
              ><span className="shrink-0">📌</span><span>应用配置<span className="block text-[10px] text-zinc-500 truncate max-w-[180px]">来自「{configClip.sourceTitle || "?"}」</span></span></button>
            )}
          </div>
        </>
      )}
    </div>
  );
}

// 复制工程路径到剪贴板（便于后续在终端/资源管理器里用）
function CopyPathBtn({ path, onToast, className = "" }) {
  const [copied, setCopied] = useState(false);
  if (!path) return null;
  return (
    <button
      onClick={async (e) => {
        e.stopPropagation();
        await copyToClipboard(path);
        setCopied(true);
        onToast?.("已复制主工程路径到剪贴板");
        setTimeout(() => setCopied(false), 1500);
      }}
      title={`复制路径：${path}`}
      className={`shrink-0 transition ${copied ? "text-emerald-400" : "text-zinc-500 hover:text-sky-300"} ${className}`}
    >{copied ? "✓" : "📋"}</button>
  );
}

// 复制主工程 + 依赖 WebApp + 全部关联工程路径，每个路径换行
function CopyAllPathsBtn({ primary, extraProjects = [], onToast, className = "" }) {
  const [copied, setCopied] = useState(false);
  const paths = [];
  if (primary?.path) paths.push(primary.path);
  if (primary?.webAppPath) paths.push(primary.webAppPath);
  for (const ex of extraProjects) if (ex?.path) paths.push(ex.path);
  if (!paths.length) return null;
  return (
    <button
      onClick={async (e) => {
        e.stopPropagation();
        await copyToClipboard(paths.join("\n"));
        setCopied(true);
        onToast?.(`已复制全部 ${paths.length} 个工程路径到剪贴板`);
        setTimeout(() => setCopied(false), 1500);
      }}
      title={`复制全部工程路径（${paths.length} 个，逐行）：\n${paths.join("\n")}`}
      className={`shrink-0 transition ${copied ? "text-emerald-400" : "text-zinc-500 hover:text-sky-300"} ${className}`}
    >{copied ? "✓" : "📋全部"}</button>
  );
}

// 「设为APK产物来源」按钮：选中态高亮；点击把该工程路径设为 📦 按钮打开的来源
function ApkSourceBtn({ path, currentPath, onSet }) {
  if (!path) return null;
  const active = norm(path) === norm(currentPath);
  return (
    <button
      onClick={(e) => { e.stopPropagation(); onSet?.(path); }}
      title={active ? "当前 APK 产物来源（顶部 📦 按钮将打开此工程的产物目录）" : "设为 APK 产物来源"}
      className={`shrink-0 text-[10px] px-1.5 py-0.5 rounded border transition ${
        active
          ? "bg-amber-600/30 border-amber-500/50 text-amber-200"
          : "bg-zinc-800 border-zinc-700 text-zinc-500 hover:text-amber-200 hover:border-amber-700/50"
      }`}
    >{active ? "✓ APK产物" : "设为APK产物"}</button>
  );
}

// 关联工程下拉选择：同一基仓可跨故事点复用，选中后由后端创建本故事点专属 worktree。
function ExtraProjectSelect({ projects, selectedNorm, otherOccupied, onPick, disabled = false }) {
  const [open, setOpen] = useState(false);
  const options = projects.filter((p) => !selectedNorm.has(norm(p.path)));
  return (
    <div className="relative min-w-[280px]">
      <button
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center justify-between gap-2 bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-[11px] text-zinc-300 hover:border-zinc-500 disabled:opacity-50 disabled:cursor-not-allowed transition"
      >
        <span className="text-zinc-400">＋ 从工程列表选择关联工程</span>
        <span className={`text-zinc-500 transition-transform ${open ? "rotate-180" : ""}`}>▾</span>
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-30" onClick={() => setOpen(false)} />
          <div className="absolute left-0 top-full mt-1 z-40 min-w-full w-max max-w-[680px] max-h-72 overflow-auto bg-zinc-900 border border-zinc-700 rounded-lg shadow-2xl py-1">
            {options.length === 0 && <div className="px-3 py-2 text-[11px] text-zinc-600 whitespace-nowrap">没有可添加的工程（其余已被本故事点选用）</div>}
            {options.map((p) => {
              const disabled = !p.exists;
              return (
                <button
                  key={p.id}
                  disabled={disabled}
                  onClick={() => { if (!disabled) { onPick(p); setOpen(false); } }}
                  className={`w-full flex items-center gap-2 px-3 py-1.5 text-xs transition ${disabled ? "opacity-50 cursor-not-allowed" : "hover:bg-zinc-800"}`}
                  title={p.path}
                >
                  <span className="text-zinc-200 whitespace-nowrap text-left">
                    {p.name}{p.webAppPath ? " (含WebApp)" : ""}{!p.exists ? " — 路径不存在" : " — 独立 worktree"}
                  </span>
                  <BranchTag branch={p.branch} exists={p.exists} />
                </button>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}

// Teambition 任务 ID 标签（如 CARB-11650）
function CarbTag({ id }) {
  if (!id) return null;
  return <span className="shrink-0 text-[9px] leading-none px-1.5 py-0.5 rounded bg-indigo-600/25 text-indigo-200 border border-indigo-500/40 font-mono" title={`Teambition 任务 ${id}`}>{id}</span>;
}

// 关联任务是否为「URL/单号」形态（应进手动输入框）；纯标题(手敲任务)不算 —— 由下拉代表，避免重复显示。
function looksLikeTicketUrl(v) {
  const s = String(v || "").trim();
  if (!s) return false;
  return /^https?:\/\//i.test(s) || /teambition\.com\/task\//i.test(s) || /^(?:CARB-)?\d+$/i.test(s);
}

// 关联任务下拉：列出可选任务（带 CARB 编号），已被其他故事点关联的置灰。
// placeholder/emptyText 用于区分"从任务列表选择"与"从 TB 工单选择"。
function TicketSelect({ tasks, value, ticketOwners, onPick, placeholder = "＋ 从我的 TB 工单选择", emptyText = "没有可选任务" }) {
  const [open, setOpen] = useState(false);
  // 关联键：有工单 URL 用 URL，否则用标题（手敲任务也可关联）
  const keyOf = (t) => t.ticketUrl || t.title || "";
  const list = (tasks || []).filter((t) => keyOf(t));
  const cur = list.find((t) => keyOf(t) === value) || null;
  return (
    <div className="relative min-w-[280px]">
      <button
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center gap-2 bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-[11px] text-zinc-300 hover:border-zinc-500 transition"
      >
        {cur ? (
          <>
            <CarbTag id={cur.carbId} />
            <span className="truncate text-left text-zinc-200">{cur.title}</span>
          </>
        ) : <span className="text-zinc-400">{placeholder}</span>}
        <span className={`ml-auto text-zinc-500 transition-transform ${open ? "rotate-180" : ""}`}>▾</span>
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-30" onClick={() => setOpen(false)} />
          <div className="absolute left-0 top-full mt-1 z-40 min-w-full w-max max-w-[680px] max-h-72 overflow-auto bg-zinc-900 border border-zinc-700 rounded-lg shadow-2xl py-1">
            {list.length === 0 && <div className="px-3 py-2 text-[11px] text-zinc-600 whitespace-nowrap">{emptyText}</div>}
            {list.map((t) => {
              const ownedByOther = ticketOwners && ticketOwners[keyOf(t)];
              const disabled = !!ownedByOther;
              return (
                <button
                  key={t.id}
                  disabled={disabled}
                  onClick={() => { if (!disabled) { onPick(t); setOpen(false); } }}
                  className={`w-full flex items-center gap-2 px-3 py-1.5 text-xs transition ${disabled ? "opacity-50 cursor-not-allowed" : "hover:bg-zinc-800"} ${keyOf(t) === value ? "bg-blue-600/20" : ""}`}
                  title={t.ticketUrl || t.title}
                >
                  <CarbTag id={t.carbId} />
                  <span className="text-zinc-200 whitespace-nowrap text-left">{t.title}{ownedByOther ? ` — 已被「${ownedByOther}」关联` : ""}</span>
                </button>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}

function fmtSize(n) {
  if (!n) return "";
  if (n < 1024) return n + "B";
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + "KB";
  return (n / 1024 / 1024).toFixed(1) + "MB";
}

// 关联 TB 单的附件列表：自动加载，逐个下载到 cloneParent/AllDocs/StoryDev/<故事点>/archives/
// 数据由 useTabAttachments 共享缓存：弹窗（"TB 单附件"）打开、行内列表重渲染、
// reloadTabs 触发整页重建，都不会重复 GET /tabs/:id/tb-attachments。
// 只在用户主动点"刷新附件"或后端 WS 推送 phase=end/开始新一轮阈门判定时刷新。
//
// 单附件下载走流式 + 提前响应 + WS devbench_attach_progress 进度：
// - 进度缓存见 tbAttachmentDownloadState.js（模块级 Map，弹窗关闭/重挂载不丢）。
// - 关闭"TB 单附件"弹窗不取消后台下载；服务端继续推 WS 进度，再开弹窗时仍是正确百分比。
// - "停止"按钮调独立 /tb-attachments/stop 路由，触发服务端 AbortController.abort()。
function TbAttachments({ tabId, ticketUrl, compact = false }) {
  const [downloadPending, setDownloadPending] = useState({}); // attachment key → true，允许多个下载独立展示进度
  const [done, setDone] = useState({});       // name → relPath
  const [refreshing, setRefreshing] = useState(false);
  const [downloadErr, setDownloadErr] = useState("");
  const [openDirErr, setOpenDirErr] = useState(""); // 打开本地目录失败提示
  const [openingDir, setOpeningDir] = useState(false); // 打开本地目录进行中
  const [progressVersion, setProgressVersion] = useState(0); // 模块级进度变化触发重渲染
  const shared = useTabAttachments(tabId, ticketUrl);
  const { isTb, list, archiveDir, err: sharedErr, refresh, version } = shared;
  const err = openDirErr || downloadErr || (refreshing ? "" : sharedErr);

  // 订阅模块级单附件下载进度缓存（status/received/total/stopped/error）
  useEffect(() => {
    if (!isTb) return undefined;
    const off = subscribeAttachProgress(tabId, () => setProgressVersion((v) => v + 1));
    return off;
  }, [tabId, isTb]);

  // 用后端回报的"已下载"状态恢复 done，避免重新打开弹窗后丢失标记
  useEffect(() => {
    if (!isTb || !list.length) return;
    setDone((prev) => {
      const next = { ...prev };
      for (const a of list) if (a.downloaded && a.relPath && !next[a.name]) next[a.name] = a.relPath;
      return next;
    });
    // 仅在缓存层刷新时同步；不依赖 list 引用 identity
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version, isTb]);

  if (!isTb) return null;
  const body = (
    <div className={compact ? "space-y-1" : "flex-1 min-w-[280px] space-y-1"}>
      <div className="flex items-center gap-2">
        <button
          onClick={async () => {
            setRefreshing(true);
            try { await refresh(); } finally { setRefreshing(false); }
          }}
          disabled={refreshing}
          className="px-2 py-1 text-[11px] rounded bg-zinc-700 hover:bg-zinc-600 text-zinc-100 disabled:opacity-50"
        >
          {refreshing ? "加载中…" : "↻ 刷新附件"}
        </button>

        {archiveDir && (
          <button
            type="button"
            onClick={async () => {
              if (openingDir) return;
              setOpeningDir(true);
              setOpenDirErr("");
              try {
                const r = await devbenchApi.openDir(archiveDir);
                if (r && !r.ok) setOpenDirErr(r.error || "打开目录失败");
              } catch (e) {
                setOpenDirErr(e?.message || "打开目录失败");
              } finally {
                setOpeningDir(false);
              }
            }}
            disabled={openingDir}
            title={`在资源管理器中打开附件下载目录：${archiveDir}`}
            className="px-2 py-1 text-[11px] rounded bg-emerald-700/30 hover:bg-emerald-600/40 text-emerald-200 border border-emerald-700/40 disabled:opacity-50"
          >
            {openingDir ? "打开中…" : "📂 打开本地目录"}
          </button>
        )}

        {err && <span className="text-[11px] text-red-400">{err}</span>}
        {!refreshing && !err && !list.length && <span className="text-[11px] text-zinc-600">该 TB 单暂无附件</span>}
        {!refreshing && !err && list.length > 0 && (
          <span className="text-[11px] text-zinc-500">{list.length} 个附件</span>
        )}
      </div>
      {list.map((a, i) => {
        const downloadKey = tbAttachmentDownloadKey(a, i);
        const isDownloading = !!downloadPending[downloadKey];
        // 读模块级单附件下载进度（progressVersion 用于触发本组件重渲染）
        void progressVersion;
        const progress = readAttachProgress(tabId, downloadKey);
        const wsDownloading = progress?.status === "downloading";
        const total = Number(progress?.total) || 0;
        const received = Number(progress?.received) || 0;
        const pct = total > 0 ? Math.min(100, Math.round((received / total) * 100)) : null;
        const showProgress = isDownloading || wsDownloading;
        const stopped = progress?.status === "stopped";
        const failed = progress?.status === "error";
        const finishedDone = done[a.name] || progress?.status === "done";
        const uploadedAt = formatChineseDateTime(a.createdAt);
        return (
          <div
            key={downloadKey}
            data-testid="tb-attachment-download-row"
            data-attachment-name={a.name}
            className="bg-zinc-800/60 border border-zinc-700/60 rounded px-2 py-1"
          >
            <div className="flex items-center gap-2">
              <div className="min-w-0 flex-1">
                <div className="truncate text-[11px] text-zinc-200" title={a.name}>
                  📎 {a.name}{a.size ? <span className="text-zinc-500"> · {fmtSize(a.size)}</span> : null}
                </div>
                <div className="mt-0.5 truncate text-[10px] text-zinc-500" title={uploadedAt ? `上传时间：${uploadedAt}` : "上传时间未知"}>
                  上传时间：{uploadedAt || "未知"}
                </div>
              </div>
              {finishedDone ? (
                <span className="text-[11px] text-emerald-400" title={progress?.relPath || done[a.name] || ""}>✓ 已下载</span>
              ) : a.noDownload ? (
                <span className="text-[11px] text-zinc-500" title={a.reason || "无可用下载链接"}>不可下载</span>
              ) : (
                <div className="flex items-center gap-1">
                  <button
                    onClick={async () => {
                      setDownloadPending((state) => setTbAttachmentDownloadPending(state, downloadKey, true));
                      setDownloadErr("");
                      try {
                        const r = await devbenchApi.downloadTbAttachment(tabId, a, downloadKey);
                        // 服务端已 ack 启动；终态由 WS phase:"file" status:"done" 写入进度缓存。
                        // 仅在响应已带 relPath 时抢先回填一次（兼容旧服务端版本）。
                        if (r?.ok && r.data?.relPath) {
                          setDone((d) => ({ ...d, [a.name]: r.data.relPath }));
                        }
                        if (r && !r.ok) setDownloadErr(r.error || "下载失败");
                      } finally {
                        setDownloadPending((state) => setTbAttachmentDownloadPending(state, downloadKey, false));
                      }
                    }}
                    disabled={isDownloading || wsDownloading}
                    aria-busy={isDownloading || wsDownloading}
                    aria-label={`${isDownloading || wsDownloading ? "正在下载" : "下载"} ${a.name}`}
                    className="px-2 py-0.5 text-[11px] rounded bg-indigo-700/30 hover:bg-indigo-600/40 text-indigo-200 border border-indigo-700/40 disabled:opacity-50">
                    {(isDownloading || wsDownloading) ? "下载中…" : "⬇ 下载"}
                  </button>
                  {(isDownloading || wsDownloading) && (
                    <button
                      onClick={async () => {
                        const r = await devbenchApi.stopTbAttachment(tabId, downloadKey);
                        if (r && !r.ok) setDownloadErr(r.error || "停止失败");
                      }}
                      aria-label={`停止下载 ${a.name}`}
                      className="px-2 py-0.5 text-[11px] rounded bg-zinc-700 hover:bg-zinc-600 text-zinc-200 border border-zinc-600">
                      停止
                    </button>
                  )}
                </div>
              )}
            </div>
            {showProgress && (
              <div
                role="progressbar"
                aria-label={`正在下载 ${a.name}`}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={pct ?? undefined}
                className="mt-1.5 h-1 overflow-hidden rounded-full bg-zinc-700"
              >
                <div
                  className={pct === null
                    ? "h-full w-full animate-pulse rounded-full bg-indigo-400"
                    : "h-full rounded-full bg-indigo-400 transition-[width] duration-200"}
                  style={pct === null ? undefined : { width: `${pct}%` }}
                />
              </div>
            )}
            {stopped && (
              <div className="mt-1 text-[10px] text-amber-400">
                已停止 {fmtSize(received)}{total > 0 ? ` / ${fmtSize(total)}` : ""}
              </div>
            )}
            {failed && (
              <div className="mt-1 text-[10px] text-red-400">
                {progress?.error || "下载失败"}
              </div>
            )}
          </div>
        );
      })}
      {Object.keys(done).length > 0 && (
        <div className="text-[10px] text-zinc-500">已下载到克隆父路径 AllDocs/StoryDev/&lt;故事点&gt;/archives/ 目录</div>
      )}
    </div>
  );
  if (compact) return body;
  return (
    <div className="flex items-start gap-2 flex-wrap">
      <span className="text-[11px] text-zinc-500 w-16 pt-1.5">TB 附件</span>
      {body}
    </div>
  );
}

function fmtTs(ts) {
  if (!ts) return "";
  try { return new Date(ts).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }); } catch { return ""; }
}

// git stash 管理悬浮面板：列出某工程的 stash，可还原(pop)/仅应用(apply)/删除(drop)
function StashPanel({ tabId, repo, onClose, onToast }) {
  const [stashes, setStashes] = useState([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(-1);
  const load = async () => {
    setLoading(true);
    const r = await devbenchApi.gitStashes(tabId, repo.path);
    setLoading(false);
    if (r.ok) setStashes(r.data || []);
  };
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [repo.path]);
  async function apply(index, pop) {
    setBusy(index);
    const r = await devbenchApi.gitStashApply(tabId, repo.path, index, pop);
    setBusy(-1);
    if (!r.ok) { onToast?.(r.error || "操作失败"); return; }
    onToast?.(pop ? "已还原并移除暂存" : "已应用暂存（保留）");
    await load();
  }
  async function drop(index) {
    if (!confirm("删除该暂存？此操作不可恢复。")) return;
    setBusy(index);
    const r = await devbenchApi.gitStashDrop(tabId, repo.path, index);
    setBusy(-1);
    if (!r.ok) { onToast?.(r.error || "删除失败"); return; }
    await load();
  }
  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/50" onClick={onClose}>
      <div className="w-[620px] max-w-[94vw] max-h-[80vh] flex flex-col bg-zinc-900 border border-zinc-700 rounded-xl shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="px-4 py-3 border-b border-zinc-800 flex items-center gap-2">
          <span className="text-sm font-semibold text-zinc-100">⛁ Git 暂存管理</span>
          <span className="text-[11px] text-zinc-500 font-mono truncate" title={repo.path}>{repo.name} · 当前 {repo.branch}</span>
          <button onClick={onClose} className="ml-auto text-zinc-500 hover:text-zinc-200 text-sm px-1">✕</button>
        </div>
        <div className="px-4 py-3 overflow-auto">
          {loading && <div className="text-[12px] text-zinc-500 py-6 text-center">加载中…</div>}
          {!loading && !stashes.length && <div className="text-[12px] text-zinc-500 py-6 text-center">没有暂存</div>}
          <div className="space-y-1.5">
            {stashes.map((s) => (
              <div key={s.index} className={`flex items-center gap-2 px-2 py-1.5 rounded border ${s.branch === repo.branch ? "border-amber-700/50 bg-amber-900/10" : "border-zinc-800 bg-zinc-800/40"}`}>
                <span className="text-[10px] text-zinc-500 font-mono shrink-0">@{s.index}</span>
                <span className="text-[11px] text-emerald-300 font-mono shrink-0" title="暂存时所在分支">{s.branch}</span>
                <span className="flex-1 truncate text-[11px] text-zinc-300" title={s.message}>
                  {s.isDevbench ? (s.story || "(无任务名)") : <span className="text-zinc-500">{s.message}</span>}
                  {s.ts ? <span className="text-zinc-600"> · {fmtTs(s.ts)}</span> : null}
                </span>
                <button disabled={busy === s.index} onClick={() => apply(s.index, true)}
                  className="px-2 py-0.5 text-[11px] rounded bg-emerald-700/30 hover:bg-emerald-600/40 text-emerald-200 border border-emerald-700/40 disabled:opacity-50 shrink-0" title="还原并从暂存列表移除(pop)">还原</button>
                <button disabled={busy === s.index} onClick={() => apply(s.index, false)}
                  className="px-2 py-0.5 text-[11px] rounded bg-zinc-700 hover:bg-zinc-600 text-zinc-200 disabled:opacity-50 shrink-0" title="应用但保留暂存(apply)">仅应用</button>
                <button disabled={busy === s.index} onClick={() => drop(s.index)}
                  className="px-2 py-0.5 text-[11px] rounded bg-zinc-800 hover:bg-red-600/30 text-zinc-400 hover:text-red-300 disabled:opacity-50 shrink-0" title="删除该暂存">删除</button>
              </div>
            ))}
          </div>
          <p className="text-[10px] text-zinc-600 mt-3">提示：切换分支时若有改动会自动暂存（带任务名+分支+时间）。「还原」=pop（应用并移除），「仅应用」=apply（保留以便其他分支也用）。</p>
        </div>
      </div>
    </div>
  );
}

// Git 分支行 chips：每个工程名后跟 AS 按钮（用 Android Studio 打开）；
// 工程多时（超过 GIT_BRANCH_VISIBLE_MAX 个）收进「更多」下拉 —— 不横向滑动、不换行。
const GIT_BRANCH_VISIBLE_MAX = 4;

function GitBranchRoleBadge({ b }) {
  const roleCls = b.role === "primary"
    ? "bg-emerald-600/30 text-emerald-300"
    : b.role === "webapp"
      ? "bg-sky-600/30 text-sky-300"
      : "bg-zinc-700 text-zinc-300";
  return <span className={`px-1 rounded text-[9px] shrink-0 ${roleCls}`}>{b.name}</span>;
}

function GitBranchChip({ b, onToast }) {
  return (
    <span className="shrink-0 flex items-center gap-1 text-[10px] bg-zinc-900 border border-zinc-800 rounded px-2 py-0.5" title={b.path}>
      <GitBranchRoleBadge b={b} />
      <span className="font-mono text-zinc-500 truncate max-w-[220px] min-w-0" title={b.path}>{b.path}</span>
      {b.branch ? (
        <span className="font-mono text-amber-300 truncate max-w-[180px] min-w-0" title={b.branch}>⎇ {b.branch}</span>
      ) : (
        <span className="text-zinc-600">{b.exists ? "非 git 仓库" : "路径不存在"}</span>
      )}
      {b.exists && <StudioBtn path={b.path} onToast={onToast} compact />}
    </span>
  );
}

function GitBranchChips({ branches, loading, onRefresh, onToast }) {
  const [showMore, setShowMore] = useState(false);
  const [menuPos, setMenuPos] = useState(null);
  const moreRef = useRef(null);
  useEffect(() => {
    if (!showMore) return undefined;
    const onEscape = (event) => {
      if (event.key !== "Escape") return;
      event.preventDefault(); event.stopPropagation(); event.stopImmediatePropagation?.();
      setShowMore(false);
    };
    window.addEventListener("keydown", onEscape, true);
    return () => window.removeEventListener("keydown", onEscape, true);
  }, [showMore]);
  const visible = branches.slice(0, GIT_BRANCH_VISIBLE_MAX);
  const rest = branches.slice(GIT_BRANCH_VISIBLE_MAX);
  // 菜单只在确有未显示工程时展开：刷新后工程数回落到阈值以内时菜单自然收敛，不残留空浮层
  const effectiveShowMore = showMore && rest.length > 0;
  function toggleMore(e) {
    e.stopPropagation();
    if (effectiveShowMore) { setShowMore(false); return; }
    const rect = moreRef.current?.getBoundingClientRect();
    if (rect && typeof window !== "undefined") {
      const width = Math.min(340, window.innerWidth - 16);
      const menuEstHeight = 360; // 对齐 max-h-80(320) + 头部/内边距/边框
      setMenuPos({
        width,
        left: Math.max(8, Math.min(rect.left, window.innerWidth - width - 8)),
        top: Math.max(8, Math.min(rect.bottom + 4, window.innerHeight - menuEstHeight)),
      });
    }
    setShowMore(true);
  }
  const moreMenu = effectiveShowMore && typeof document !== "undefined" ? createPortal(
    <>
      <div className="fixed inset-0 z-[190]" onClick={(e) => { e.stopPropagation(); setShowMore(false); }} />
      <div className="fixed z-[200] max-w-[calc(100vw-16px)] rounded-lg border border-zinc-700 bg-zinc-900 py-1 shadow-2xl" style={menuPos || { width: 340, right: 8, top: 8 }}>
        <div className="border-b border-zinc-800 px-3 py-1 text-[10px] text-zinc-500">更多工程（{rest.length}）</div>
        <div className="max-h-80 overflow-auto py-1">
          {rest.map((b) => (
            <div key={b.path} className="flex items-center gap-1.5 px-2.5 py-1.5 transition hover:bg-zinc-800" title={b.path}>
              <GitBranchRoleBadge b={b} />
              {b.branch ? (
                <span className="font-mono text-[10px] text-amber-300 truncate min-w-0">{b.branch}</span>
              ) : (
                <span className="text-[10px] text-zinc-600">{b.exists ? "非 git 仓库" : "路径不存在"}</span>
              )}
              {b.exists && <StudioBtn path={b.path} onToast={onToast} compact />}
            </div>
          ))}
        </div>
      </div>
    </>,
    document.body,
  ) : null;
  return (
    <div className="border-t border-zinc-800 bg-zinc-950/40 px-4 py-1.5 flex items-center gap-2">
      <span className="text-[10px] text-zinc-500 shrink-0">Git 分支</span>
      {branches.length === 0 && !loading && (
        <span className="text-[10px] text-zinc-600">（未选择工程）</span>
      )}
      {visible.map((b) => (
        <GitBranchChip key={b.path} b={b} onToast={onToast} />
      ))}
      {rest.length > 0 && (
        <button ref={moreRef} onClick={toggleMore}
          className="shrink-0 text-[10px] text-zinc-300 bg-zinc-800 border border-zinc-700 rounded px-2 py-0.5 hover:bg-zinc-700 hover:text-zinc-100 transition"
          title={`还有 ${rest.length} 个工程未显示，点击查看`}>
          {effectiveShowMore ? "收起 ▴" : `更多 ${rest.length} ▾`}
        </button>
      )}
      <button onClick={onRefresh} disabled={loading}
        className="shrink-0 ml-auto text-[10px] text-zinc-500 hover:text-zinc-200 px-1.5 py-0.5 rounded hover:bg-zinc-800"
        title="刷新分支">{loading ? "…" : "↻"}</button>
      {moreMenu}
    </div>
  );
}

// Git 分支区：主工程 + 关联工程的当前分支 / 切换 / dirty 指示 / 未还原暂存(!) / stash 管理
// 可搜索的分支选择器：点开后顶部输入框实时过滤本地/远程分支（远程分支可能上百个）
function BranchPicker({ repo, disabled, onPick }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const inputRef = useRef(null);
  useEffect(() => { if (open) { const t = setTimeout(() => inputRef.current?.focus(), 10); return () => clearTimeout(t); } }, [open]);
  const ql = q.trim().toLowerCase();
  const matchLocal = (repo.branches || []).filter((b) => b.toLowerCase().includes(ql));
  const matchRemote = (repo.remoteBranches || []).filter((b) => b.toLowerCase().includes(ql));
  const close = () => { setOpen(false); setQ(""); };
  const pick = (b) => { close(); if (b && b !== repo.branch) onPick(b); else close(); };
  return (
    <div className="relative min-w-[180px] max-w-[280px]">
      <button onClick={() => !disabled && setOpen((v) => !v)} disabled={disabled}
        className="w-full flex items-center gap-1.5 bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-[11px] hover:border-zinc-500 disabled:opacity-50 transition">
        <span className="flex-1 text-left text-emerald-300 font-mono truncate" title={repo.branch}>{repo.branch || "—"}</span>
        <span className={`text-zinc-500 transition-transform ${open ? "rotate-180" : ""}`}>▾</span>
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-30" onClick={close} />
          <div className="absolute left-0 top-full mt-1 z-40 w-[300px] max-w-[80vw] bg-zinc-900 border border-zinc-700 rounded-lg shadow-2xl">
            <div className="p-1.5 border-b border-zinc-800">
              <input ref={inputRef} value={q} onChange={(e) => setQ(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Escape") { close(); }
                  if (e.key === "Enter") { e.preventDefault(); const first = matchLocal[0] || matchRemote[0]; if (first) pick(first); }
                }}
                placeholder="输入过滤分支（回车选第一个）"
                className="w-full bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-[11px] text-zinc-100 placeholder-zinc-600 outline-none focus:border-zinc-500 font-mono" />
            </div>
            <div className="max-h-72 overflow-auto py-1">
              {matchLocal.length > 0 && <div className="px-2 py-0.5 text-[10px] text-zinc-600">本地分支</div>}
              {matchLocal.map((b) => (
                <button key={"l-" + b} onClick={() => pick(b)}
                  className={`w-full text-left px-2.5 py-1 text-[11px] font-mono truncate hover:bg-zinc-800 transition ${b === repo.branch ? "text-emerald-300 bg-emerald-900/15" : "text-zinc-200"}`}
                  title={b}>{b === repo.branch ? "✓ " : ""}{b}</button>
              ))}
              {matchRemote.length > 0 && <div className="px-2 py-0.5 text-[10px] text-zinc-600 mt-1">远程分支（切换将建本地跟踪）</div>}
              {matchRemote.map((b) => (
                <button key={"r-" + b} onClick={() => pick(b)}
                  className="w-full text-left px-2.5 py-1 text-[11px] font-mono truncate text-indigo-300 hover:bg-zinc-800 transition" title={b}>{b}</button>
              ))}
              {!matchLocal.length && !matchRemote.length && <div className="px-2.5 py-2 text-[11px] text-zinc-600">无匹配分支</div>}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function GitBranchSection({ tabId, refreshKey, onChanged, onToast }) {
  const [repos, setRepos] = useState([]);
  const [switching, setSwitching] = useState("");
  const [fetching, setFetching] = useState(false);
  const [stashRepo, setStashRepo] = useState(null);
  const [restorePrompt, setRestorePrompt] = useState(null); // { repo, branch, restorable:[...] }
  const load = async () => {
    const r = await devbenchApi.gitRepos(tabId);
    if (r.ok) setRepos(r.data || []);
  };
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [tabId, refreshKey]);
  async function doFetch() {
    setFetching(true);
    const r = await devbenchApi.gitFetch(tabId);
    setFetching(false);
    onToast?.(r.ok ? "已拉取远程分支" : (r.error || "拉取失败"));
    await load();
  }
  async function doCheckout(repo, branch) {
    if (!branch || branch === repo.branch) return;
    setSwitching(repo.path);
    const r = await devbenchApi.gitCheckout(tabId, repo.path, branch);
    setSwitching("");
    if (!r.ok) { onToast?.(r.error || "切换分支失败"); await load(); return; }
    onToast?.(`${repo.name} 已切到 ${branch}${r.data.stashed ? "（原改动已自动暂存）" : ""}`);
    await load();
    await onChanged?.();
    if (r.data.restorable && r.data.restorable.length) {
      setRestorePrompt({ repo: { ...repo, branch }, branch, restorable: r.data.restorable });
    }
  }
  async function doRestore(yes) {
    const rp = restorePrompt; setRestorePrompt(null);
    if (!yes || !rp) return;
    const idx = rp.restorable[0].index; // 最近一条
    const r = await devbenchApi.gitStashApply(tabId, rp.repo.path, idx, true);
    if (!r.ok) onToast?.(r.error || "还原失败"); else onToast?.("已还原暂存");
    await load();
    await onChanged?.();
  }
  const list = repos.filter((x) => x.exists && x.isRepo);
  if (!list.length) return null;
  return (
    <div className="flex items-start gap-2 flex-wrap">
      <span className="text-[11px] text-zinc-500 w-16 pt-1.5">Git 分支</span>
      <div className="flex-1 min-w-[280px] space-y-1.5">
        <div className="flex items-center gap-2">
          <button onClick={doFetch} disabled={fetching}
            className="px-2 py-0.5 text-[11px] rounded bg-zinc-800 border border-zinc-700 text-zinc-300 hover:bg-zinc-700 disabled:opacity-50 transition"
            title="git fetch --all --prune：对基仓与 worktree（及关联工程）拉取最新远程分支引用">{fetching ? "拉取中…" : "↻ 拉取远程"}</button>
          <span className="text-[10px] text-zinc-600">切换有改动会自动暂存；可切到远程分支（自动建本地跟踪）</span>
        </div>
        {list.map((repo) => (
          <div key={repo.path} className="flex items-center gap-2 text-[11px] flex-wrap">
            <span className="text-zinc-400 truncate max-w-[150px] font-mono" title={repo.path}>{repo.name}</span>
            <BranchPicker repo={repo} disabled={switching === repo.path} onPick={(b) => doCheckout(repo, b)} />
            {switching === repo.path && <span className="text-zinc-500">切换中…</span>}
            {repo.dirty && <span className="text-amber-400" title={`${repo.dirtyCount} 处改动（切换会自动暂存，含未跟踪）`}>●{repo.dirtyCount}</span>}
            {repo.hasStashForBranch && (
              <button onClick={() => setStashRepo(repo)} title="该分支有未还原的暂存，点击管理"
                className="text-red-400 hover:text-red-300 font-bold px-1 text-sm leading-none">!</button>
            )}
            <button onClick={() => setStashRepo(repo)} title="Git 暂存管理"
              className="text-zinc-500 hover:text-zinc-300 px-1">⛁{repo.stashCount ? `(${repo.stashCount})` : ""}</button>
          </div>
        ))}
      </div>
      {stashRepo && <StashPanel tabId={tabId} repo={stashRepo} onClose={() => { setStashRepo(null); load(); }} onToast={onToast} />}
      {restorePrompt && (
        <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/50" onClick={() => doRestore(false)}>
          <div className="w-[440px] max-w-[92vw] bg-zinc-900 border border-zinc-700 rounded-xl shadow-2xl" onClick={(e) => e.stopPropagation()}>
            <div className="px-4 py-3 border-b border-zinc-800 text-sm font-semibold text-zinc-100">发现该分支的暂存</div>
            <div className="px-4 py-4 text-sm text-zinc-300 leading-relaxed space-y-2">
              <div className="text-[12px]"><span className="font-mono text-emerald-300">{restorePrompt.repo.name}</span> 切回 <span className="font-mono text-emerald-300">{restorePrompt.branch}</span>，发现之前在此分支自动暂存的改动：</div>
              <div className="text-[12px] text-zinc-400">
                {restorePrompt.restorable.map((s) => (
                  <div key={s.index} className="font-mono truncate">· {s.story || "(无任务名)"}{s.ts ? ` · ${fmtTs(s.ts)}` : ""}</div>
                ))}
              </div>
              <div className="text-[11px] text-zinc-500">是否还原最近一条？不还原可稍后点分支后的「!」进入暂存管理。</div>
            </div>
            <div className="px-4 py-3 border-t border-zinc-800 flex items-center justify-end gap-2">
              <button onClick={() => doRestore(false)} className="px-3 py-1.5 text-xs rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-300 transition">暂不还原</button>
              <button onClick={() => doRestore(true)} className="px-3 py-1.5 text-xs rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white transition">还原</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// 单个仓库的克隆进度条
function CloneBar({ label, p }) {
  const pct = p?.status === "done" ? 100 : (p?.percent || 0);
  const color = p?.status === "error" ? "bg-red-500" : p?.status === "done" ? "bg-emerald-500" : "bg-blue-500";
  return (
    <div className="space-y-0.5">
      <div className="flex items-center gap-2 text-[11px]">
        <span className="text-zinc-300 w-28 shrink-0 font-mono truncate">{label}</span>
        <span className="text-zinc-500 truncate flex-1">
          {p?.status === "error" ? <span className="text-red-400">失败：{p.error}</span>
            : p?.status === "done" ? <span className="text-emerald-400">完成 {p.branch ? `· ${p.branch}` : ""}</span>
            : p ? `${p.phase || "克隆中"} ${pct}%` : "等待…"}
        </span>
      </div>
      <div className="h-1.5 bg-zinc-800 rounded overflow-hidden">
        <div className={`h-full ${color} transition-all`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

// 远程拉取配置：选车型(带预置)→配分支→开始初始化(并发 clone+checkout)→进度
function RemotePullConfig({ tab, projectId, cloneProgress, onRefreshTab, onToast }) {
  const [vehicleMap, setVehicleMap] = useState({});
  const [defs, setDefs] = useState([]);
  const init = tab.remotePull || {};
  const [rp, setRp] = useState({
    vehicle: init.vehicle || "",
    tbId: init.tbId || extractCarbId(tab.title),
    entries: Array.isArray(init.entries) ? init.entries.map((e) => ({ ...e })) : [],
  });
  const [starting, setStarting] = useState(false);
  useEffect(() => {
    devbenchApi.getRemoteConfig(projectId).then((r) => { if (r.ok) setVehicleMap(r.data.vehicleMap || {}); });
    devbenchApi.getProjectDefs().then((r) => { if (r.ok) setDefs(r.data || []); });
  }, [projectId]);
  const set = (patch) => setRp((x) => ({ ...x, ...patch }));
  const defName = (id) => defs.find((d) => d.id === id)?.name || id;
  function pickVehicle(v) {
    const preset = vehicleMap[v];
    const entries = preset?.entries ? preset.entries.map((e) => ({ ...e, flavor: e.flavor || v })) : [];
    set({ vehicle: v, entries });
  }
  const setEntry = (i, patch) => setRp((x) => ({ ...x, entries: x.entries.map((e, idx) => (idx === i ? { ...e, ...patch } : e)) }));
  const addEntry = () => setRp((x) => {
    const used = new Set(x.entries.map((e) => e.projectId));
    const first = defs.find((d) => !used.has(d.id)) || defs[0];
    return { ...x, entries: [...x.entries, { projectId: first?.id || "", branch: "", flavor: x.vehicle }] };
  });
  const delEntry = (i) => setRp((x) => ({ ...x, entries: x.entries.filter((_, idx) => idx !== i) }));

  const cloning = tab.cloneStatus === "cloning";
  const done = tab.cloneStatus === "done" && Array.isArray(tab.remoteRepos);
  async function start() {
    const valid = rp.entries.filter((e) => e.projectId && e.branch);
    if (!valid.length) { onToast?.("请至少为一个工程选择远程分支"); return; }
    setStarting(true);
    const sm = await devbenchApi.setTabMode(tab.id, "remote", rp);
    if (!sm.ok) { setStarting(false); onToast?.(sm.error || "保存配置失败"); return; }
    const r = await devbenchApi.remoteInit(tab.id);
    setStarting(false);
    if (!r.ok) { onToast?.(r.error || "初始化失败"); return; }
    onToast?.("开始克隆，进度见下方");
    onRefreshTab?.();
  }
  const cp = cloneProgress?.repos || {};
  return (
    <div className="space-y-2.5">
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-[11px] text-zinc-500 w-16 shrink-0">车型</span>
        <select value={rp.vehicle} onChange={(e) => pickVehicle(e.target.value)} disabled={cloning}
          className="bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-[11px] text-fuchsia-300 outline-none min-w-[140px] disabled:opacity-50">
          <option value="">— 选择车型（带出工程预置）—</option>
          {Object.keys(vehicleMap).map((v) => <option key={v} value={v}>{v}（预置）</option>)}
          {rp.vehicle && !vehicleMap[rp.vehicle] && <option value={rp.vehicle}>{rp.vehicle}</option>}
        </select>
        <input value={rp.vehicle} onChange={(e) => set({ vehicle: e.target.value })} disabled={cloning}
          placeholder="或手动输入车型" className="bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-[11px] text-zinc-200 placeholder-zinc-600 outline-none font-mono w-32 disabled:opacity-50" />
        <span className="text-[11px] text-zinc-500 ml-2">TB单号</span>
        <input value={rp.tbId} onChange={(e) => set({ tbId: e.target.value })} disabled={cloning}
          placeholder="如 CARB-11650（空则用时分）" className="bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-[11px] text-zinc-200 placeholder-zinc-600 outline-none font-mono w-44 disabled:opacity-50" />
      </div>
      {/* 工程条目（车型带出，可手改/增删） */}
      {rp.entries.map((e, i) => (
        <div key={i} className="flex items-center gap-2">
          <select value={e.projectId} onChange={(ev) => setEntry(i, { projectId: ev.target.value })} disabled={cloning}
            className="w-28 shrink-0 bg-zinc-800 border border-zinc-700 rounded px-1.5 py-1 text-[11px] text-zinc-200 outline-none disabled:opacity-50">
            {!defs.length && <option value="">无工程</option>}
            {defs.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
          </select>
          <RemoteBranchSelect key={e.projectId} repo={e.projectId} value={e.branch} onChange={(b) => setEntry(i, { branch: b })} disabled={cloning} placeholder={`选择${defName(e.projectId)}远程分支`} />
          <input value={e.flavor ?? ""} onChange={(ev) => setEntry(i, { flavor: ev.target.value })} disabled={cloning}
            placeholder="flavor（默认=车型）" className="w-24 shrink-0 bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-[11px] text-zinc-200 placeholder-zinc-600 outline-none font-mono disabled:opacity-50" />
          {!cloning && <button onClick={() => delEntry(i)} className="px-1.5 py-1 text-[11px] rounded bg-zinc-800 hover:bg-red-600/30 text-zinc-500 hover:text-red-300 shrink-0">×</button>}
        </div>
      ))}
      {!cloning && <button onClick={addEntry} disabled={!defs.length} className="text-[11px] px-2 py-1 rounded bg-zinc-800 border border-zinc-700 text-zinc-300 hover:bg-zinc-700 disabled:opacity-50">＋ 添加工程</button>}
      <div className="flex items-center gap-2 pt-1">
        <button onClick={start} disabled={cloning || starting}
          className="px-3 py-1.5 text-xs rounded-lg bg-emerald-600 hover:bg-emerald-500 disabled:bg-zinc-700 disabled:text-zinc-500 text-white transition">
          {cloning ? "初始化中…" : starting ? "提交中…" : done ? "↻ 重新初始化" : "🚀 开始初始化工程"}
        </button>
        <span className="text-[10px] text-zinc-600">克隆到 父路径\{rp.vehicle || "车型"}\&lt;年月&gt;\&lt;工程名&gt;-{rp.tbId || "时分"}</span>
      </div>
      {/* 进度 */}
      {(cloning || cloneProgress) && (
        <div className="space-y-1.5 pt-1 border-t border-zinc-800">
          {rp.entries.filter((e) => e.projectId).map((e) => <CloneBar key={e.projectId} label={defName(e.projectId)} p={cp[e.projectId]} />)}
        </div>
      )}
      {/* 完成后的工程 */}
      {done && (
        <div className="pt-1 border-t border-zinc-800 space-y-0.5">
          <div className="text-[11px] text-emerald-400">✓ 已克隆，可直接对话</div>
          {tab.remoteRepos.map((r) => (
            <div key={r.key} className="text-[10px] text-zinc-500 font-mono truncate" title={r.path}>· {r.ok ? "" : "✗ "}{r.name} → {r.path} {r.branch ? `(${r.branch})` : ""}</div>
          ))}
        </div>
      )}
    </div>
  );
}

// 分布式执行面板：服务端 AI 生成动作 + 本机执行，实时显示每步
function AgentRunPanel({ agentRun, onAgentRun }) {
  const [task, setTask] = useState("");
  const running = agentRun?.status === "running";
  const steps = agentRun?.steps || [];
  const result = agentRun?.result || null;
  const endRef = useRef(null);
  useEffect(() => { endRef.current?.scrollIntoView({ block: "nearest" }); }, [steps.length, result]);
  return (
    <div className="pt-3 mt-1 border-t border-zinc-800 space-y-2">
      <div className="flex items-center gap-2">
        <span className="text-[11px] font-medium text-zinc-300">🤖 服务端执行（分布式）</span>
        <span className="text-[10px] text-zinc-600">服务端 AI 生成动作 → 本机执行 → 结果回灌（客户端不接触共享账号）</span>
      </div>
      <div className="flex items-center gap-2">
        <input value={task} onChange={(e) => setTask(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && task.trim() && !running) { onAgentRun?.(task.trim()); } }}
          placeholder="描述要让服务端跑的任务（如：修复编译错误并跑通 assembleDebug）" disabled={running}
          className="flex-1 bg-zinc-800 border border-zinc-700 rounded px-2 py-1.5 text-[11px] text-zinc-200 placeholder-zinc-600 outline-none disabled:opacity-50" />
        <button onClick={() => task.trim() && onAgentRun?.(task.trim())} disabled={running || !task.trim()}
          className="px-3 py-1.5 text-[11px] rounded bg-emerald-600 hover:bg-emerald-500 disabled:bg-zinc-700 disabled:text-zinc-500 text-white">{running ? "执行中…" : "🚀 让服务端执行"}</button>
      </div>
      {(steps.length > 0 || result) && (
        <div className="max-h-72 overflow-auto bg-zinc-950/50 border border-zinc-800 rounded p-2 space-y-1.5">
          {steps.map((s, i) => (
            s.phase === "think"
              ? <div key={i} className="text-[11px]">
                  <span className="text-indigo-300">🧠 第{s.round}步</span>
                  <span className="text-zinc-400 ml-1">{s.action?.thought || ""}</span>
                  {s.action?.tool && <span className="text-[10px] text-zinc-600 ml-1 font-mono">[{s.action.tool}{s.action.tool === "done" ? "" : `: ${(s.action.path || s.action.command || "").toString().slice(0, 60)}`}]</span>}
                </div>
              : <div key={i} className="text-[11px] pl-4">
                  <span className={s.step?.ok === false ? "text-red-400" : "text-emerald-400"}>{s.step?.ok === false ? "✗" : "✓"} {s.step?.tool}</span>
                  <pre className="text-[10px] text-zinc-500 whitespace-pre-wrap break-all mt-0.5 max-h-24 overflow-auto">{String(s.step?.result ?? "").slice(0, 1000)}</pre>
                </div>
          ))}
          {result && (
            <div className={`text-[11px] mt-1 pt-1 border-t border-zinc-800 ${result.ok === false ? "text-red-400" : "text-emerald-400"}`}>
              {result.ok === false ? `✗ 失败：${result.error || ""}` : result.done ? `✅ 完成：${result.summary || ""}（${result.steps} 步）` : `⏹ 达最大轮数（${result.steps} 步）`}
            </div>
          )}
          <div ref={endRef} />
        </div>
      )}
    </div>
  );
}

// 工作流状态条沿用完整工作流图的 phase 清单，只在这里补充徽标配色。
const WF_PHASE_CLASS = {
  claimed: "text-sky-300 border-sky-700/50 bg-sky-900/20",
  triaging: "text-sky-300 border-sky-700/50 bg-sky-900/20",
  fixing: "text-amber-300 border-amber-700/50 bg-amber-900/20",
  group_fixed: "text-emerald-300 border-emerald-700/50 bg-emerald-900/20",
  reject_pending: "text-amber-300 border-amber-700/50 bg-amber-900/20",
  verifying: "text-indigo-300 border-indigo-700/50 bg-indigo-900/20",
  verify_blocked: "text-amber-300 border-amber-700/50 bg-amber-900/20",
  reporting: "text-indigo-300 border-indigo-700/50 bg-indigo-900/20",
  sync_pending: "text-rose-200 border-rose-700/50 bg-rose-950/30",
  testable: "text-emerald-300 border-emerald-700/50 bg-emerald-900/20",
  rejected: "text-zinc-300 border-zinc-700 bg-zinc-800/40",
};

// TB 工作流常驻状态条：始终告诉用户当前阶段 + AI 是否在自动执行 + 半/全自动档位 + 手动触发入口。
// 仅 TB 单故事点显示；解决"点执行开发后网页无任何 AI 正在分析的提示"。
function WorkflowStatusBar({ tab, messages, isRunning, primary, onStartTriage, onStartFix, onSetAutoMode, onSetSkipTestAcceptance, onMarkFixed, onStartVerify, onStartReport, onRetryTbSync }) {
  const isTb = /task\/[0-9a-fA-F]{24}/.test(String(tab.ticketUrl || ""));
  if (!isTb) return null;
  const wf = tab.workflow || {};
  const mode = wf.autoMode === "full" ? "full" : "semi";
  const reportMode = tab.reportMode === "expert" ? "expert" : "short";
  const skipTestAcceptance = tab.skipTestAcceptance === true;
  const phase = wf.phase || "claimed";
  const ph = getWorkflowPhase(phase);
  const phCls = WF_PHASE_CLASS[phase] || WF_PHASE_CLASS.claimed;
  const pendingReject = wf.pendingReject;
  const syncPending = phase === "sync_pending" ? workflowSyncPendingInfo(wf) : null;
  const hasPendingRejectEvidence = !!pendingReject
    && typeof pendingReject === "object"
    && !Array.isArray(pendingReject)
    && [pendingReject.shortReport, pendingReject.reason, pendingReject.detailRel, pendingReject.detailAbsPath]
      .some((value) => String(value || "").trim());
  // 人工切到 reject_pending 时后端会清掉旧证据；此时仍应暴露“开始 AI 甄别”，
  // 只有带有效拒绝依据的 reject_pending 才算已经完成甄别。
  const triaged = ["fixing", "group_fixed", "verifying", "verify_blocked", "reporting", "sync_pending", "testable", "rejected"].includes(phase)
    || (phase === "reject_pending" && hasPendingRejectEvidence);
  const ready = !!primary;
  const hasDevice = !!(tab.deviceSerial && String(tab.deviceSerial).trim());
  const idleActions = workflowStatusActions(tab, messages, { ready });
  const actionById = new Map(idleActions.map((action) => [action.id, action]));
  const repairAction = actionById.get("start_fix") || actionById.get("continue_fix");
  const completionAction = actionById.get("mark_fixed");
  // 运行中：按阶段描述 AI 当前在做什么
  let runningText = "🤖 AI 正在执行…";
  if (isRunning) {
    runningText = phase === "fixing"
      ? "🛠 AI 正在按该 TB 单修复…"
      : phase === "verifying"
      ? "🔬 AI 正在自我验收（生成测试 / 打 debug+release 包 / 设备复现验证）…"
      : phase === "reporting"
      ? (reportMode === "expert" ? "📝 AI 正在生成专家 HTML/PDF 报告并提交 TB…" : "📝 AI 正在整理原因/措施短评并提交 TB…")
      : "🤖 AI 正在甄别该 TB 单是否属于客户端/应用市场问题…";
  }

  return (
    <div data-devbench-workflow-bar className={`shrink-0 relative z-40 px-4 py-2 border-b overflow-visible ${isRunning ? "bg-blue-950/40 border-blue-800/50" : "bg-zinc-900/60 border-zinc-800"}`}>
      <div className="flex items-start gap-2">
        <div className="flex min-w-0 flex-1 items-center gap-2 flex-wrap">
        <span className="text-[11px] text-zinc-500">🔄 TB 工作流</span>
        <span className={`text-[10px] px-1.5 py-0.5 rounded border ${phCls}`}>{ph.label}</span>
        <span className={`text-[10px] px-1.5 py-0.5 rounded border ${reportMode === "expert" ? "text-fuchsia-200 border-fuchsia-700/50 bg-fuchsia-900/20" : "text-emerald-200 border-emerald-700/50 bg-emerald-900/20"}`}>
          {reportMode === "expert" ? "专家报告" : "简短报告"}
        </span>
        <button
          type="button"
          data-testid="devbench-skip-test-acceptance"
          aria-pressed={skipTestAcceptance}
          disabled={isRunning}
          onClick={() => onSetSkipTestAcceptance?.(!skipTestAcceptance)}
          title={tab.groupId
            ? "故事点组只有一轮统一验收：开启后整组修复完成会跳过测试验收，直接进入报告"
            : "开启后修复完成将跳过测试与验收流程，直接进入报告；这不表示验收通过"}
          className={`shrink-0 rounded border px-1.5 py-0.5 text-[10px] transition disabled:cursor-not-allowed disabled:opacity-50 ${skipTestAcceptance
            ? "border-amber-500/70 bg-amber-600 text-white"
            : "border-zinc-700 bg-zinc-900 text-zinc-400 hover:border-amber-600/70 hover:text-amber-200"}`}
        >
          {skipTestAcceptance ? "✓ 跳过测试验收" : "跳过测试验收"}
        </button>
        {/* 半自动 / 全自动 档位（全自动为预留，待 TB 单能完全映射工程配置后启用） */}
        <span className="inline-flex rounded border border-zinc-700 overflow-hidden text-[10px] shrink-0">
          <button onClick={() => onSetAutoMode?.("semi")}
            className={`px-1.5 py-0.5 transition ${mode === "semi" ? "bg-blue-600 text-white" : "text-zinc-400 hover:text-zinc-200"}`}
            title="半自动：点「执行开发」不自动分析，由你点「开始 AI 甄别」或发消息触发">半自动</button>
          <button onClick={() => {
              if (mode === "full") return; // 已是全自动，无需重复
              if (window.confirm("切到「全自动」后，点「执行开发」一旦工程就绪就会自动甄别、并可能自动改 TB 状态/写评论。\n请确认本故事点的工程与分支已和 TB 单对齐，避免误对错误工程自动跑。\n\n确定切换到全自动？")) onSetAutoMode?.("full");
            }}
            className={`px-1.5 py-0.5 transition ${mode === "full" ? "bg-blue-600 text-white" : "text-zinc-400 hover:text-zinc-200"}`}
            title="全自动：工程就绪即自动甄别（预留，待 TB 单能完全映射工程配置后用）。切换前会二次确认">全自动</button>
        </span>

        {isRunning ? (
          <span
            className="flex min-w-0 max-w-full items-center gap-1.5 overflow-hidden text-[11px] text-blue-200"
            title={runningText}
          >
            <span className="w-2 h-2 shrink-0 rounded-full bg-blue-400 animate-pulse" />
            <span className="min-w-0 truncate">{runningText}</span>
          </span>
        ) : phase === "fixing" && repairAction ? (
          <span className="flex items-center gap-2 flex-wrap">
            <button onClick={() => onStartFix?.(repairAction.id)}
              data-testid="devbench-workflow-start-fix"
              title={repairAction.description}
              className="text-[11px] px-2.5 py-1 rounded bg-purple-600 hover:bg-purple-500 text-white transition">
              {repairAction.label}
            </button>
            {completionAction && (
              <button onClick={() => onMarkFixed?.()}
                data-testid="devbench-workflow-mark-fixed"
                title={completionAction.description}
                className="text-[11px] px-2.5 py-1 rounded border border-emerald-700/70 bg-emerald-900/30 text-emerald-200 hover:bg-emerald-800/50 transition">
                {completionAction.label}
              </button>
            )}
            <span className="text-[11px] text-zinc-500">{completionAction
              ? (skipTestAcceptance
                ? (tab.groupId ? "继续补修，或让 AI 核对完成；整组完成后跳过测试验收并直接报告" : "仍有遗漏就继续修复；核对修复完成后将跳过测试验收并直接报告")
                : (tab.groupId ? "继续补修，或让 AI 核对完成；组内最后一个完成后统一验收" : "仍有遗漏就继续修复；确认代码与自测已完成时再让 AI 核对并进入验收"))
              : "甄别已完成；点击后发送“开始修复”，完整上下文由后端自动注入"}</span>
          </span>
        ) : phase === "fixing" ? (
          <span className="text-[11px] text-zinc-500">请先配置主工程，再开始修复</span>
        ) : phase === "verifying" ? (
          <span className="flex items-center gap-2 flex-wrap">
            <button onClick={() => onStartVerify?.()}
              className="text-[11px] px-2.5 py-1 rounded bg-indigo-600 hover:bg-indigo-500 text-white transition">
              {actionById.get("start_verify")?.label || "🔬 开始自我验收"}
            </button>
            <span className="text-[11px] text-zinc-500">新开验收 Agent 出测试/打 debug+release 包，在绑定设备复现验证</span>
          </span>
        ) : phase === "verify_blocked" ? (
          <span className="flex items-center gap-2 flex-wrap">
            <button onClick={() => onStartVerify?.()} disabled={!hasDevice}
              className="text-[11px] px-2.5 py-1 rounded bg-amber-600 hover:bg-amber-500 disabled:opacity-50 disabled:cursor-not-allowed text-white transition">
              {actionById.get("execute_verify")?.label || "▶ 执行验收"}
            </button>
            <span className={`text-[11px] ${hasDevice ? "text-zinc-500" : "text-amber-300"}`}>
              {hasDevice ? "已检测到绑定设备，可执行验收" : "⚠ 未绑定目标设备：自我验收需在 TB 指定机型上打 debug/release 包复现，请先在「配置工程」绑定设备"}
            </span>
          </span>
        ) : phase === "reporting" ? (
          <span className="flex items-center gap-2 flex-wrap">
            <button onClick={() => onStartReport?.()}
              className="text-[11px] px-2.5 py-1 rounded bg-indigo-600 hover:bg-indigo-500 text-white transition">
              {actionById.get("start_report")?.label || "📝 生成报告并提交"}
            </button>
            <span className="text-[11px] text-zinc-500">{skipTestAcceptance
              ? (reportMode === "expert" ? "明确标注测试验收未执行，生成专家报告后提交 TB" : "明确标注测试验收未执行，只写原因/措施短评并提交 TB")
              : reportMode === "expert"
              ? "生成图文影音 HTML → 转 PDF 附件 + TB 摘要 + 流转“可提测”"
              : "只写原因/措施短评，不生成附件，并流转“可提测”"}</span>
          </span>
        ) : phase === "sync_pending" ? (
          <span className="flex items-center gap-2 flex-wrap" data-testid="devbench-tb-sync-pending">
            <button onClick={() => onRetryTbSync?.(syncPending?.retryAction)}
              className="text-[11px] px-2.5 py-1 rounded bg-rose-700 hover:bg-rose-600 text-white transition">
              {actionById.get("retry_sync")?.label || "↻ 重试 TB 同步"}
            </button>
            <span className="text-[11px] text-rose-200">
              {syncPending?.label || "TB 同步"}未完成确认；将复用已持久化的评论、附件哈希和幂等键。
            </span>
            <span className="text-[10px] text-zinc-400">
              步骤：{(syncPending?.steps || []).map((step) => `${step.label}${step.done ? "✓" : "待续跑"}`).join(" · ")}
            </span>
            {syncPending?.errors?.length > 0 && (
              <span className="max-w-full text-[10px] text-rose-300 break-all" title={syncPending.errors.join("\n")}>
                原因：{syncPending.errors.join("；")}
              </span>
            )}
          </span>
        ) : triaged ? (
          <span className="text-[11px] text-zinc-400">已甄别（{ph.label}）</span>
        ) : !ready ? (
          <span className="text-[11px] text-zinc-500">工程就绪后可开始分析（不会自动从远程拉取，请先确认工程/分支）</span>
        ) : (
          <span className="flex items-center gap-2 flex-wrap">
            <button onClick={() => onStartTriage?.()}
              className="text-[11px] px-2.5 py-1 rounded bg-emerald-600 hover:bg-emerald-500 text-white transition">
              {actionById.get("start_triage")?.label || "▶ 开始 AI 甄别"}
            </button>
            <span className="text-[11px] text-zinc-500">或直接在下方发消息，AI 会先自动甄别</span>
          </span>
        )}
        </div>
      </div>
    </div>
  );
}

// 故事点组面板：列出同组故事点（共用工程配置），高亮当前活动，可打开/设为当前/移出/重命名组。
const GROUP_MEMBER_PHASE = {
  claimed: { label: "待甄别", cls: "bg-sky-700/35 text-sky-200" },
  triaging: { label: "甄别中", cls: "bg-sky-700/35 text-sky-200" },
  fixing: { label: "修复中", cls: "bg-amber-700/40 text-amber-200" },
  group_fixed: { label: "组内已修复", cls: "bg-emerald-700/35 text-emerald-200" },
  verify_blocked: { label: "待统一验收", cls: "bg-amber-700/40 text-amber-200" },
  verifying: { label: "统一验收中", cls: "bg-indigo-700/35 text-indigo-200" },
  reporting: { label: "报告同步中", cls: "bg-indigo-700/35 text-indigo-200" },
  testable: { label: "已提测", cls: "bg-emerald-700/35 text-emerald-200" },
  rejected: { label: "已拒绝", cls: "bg-zinc-700 text-zinc-300" },
};

function groupMemberBadge(m) {
  if (m.phase === "testable" && m.syncOk === false) return { label: "同步告警", cls: "bg-red-700/40 text-red-200" };
  return GROUP_MEMBER_PHASE[m.phase] || (m.active
    ? { label: "进行中", cls: "bg-emerald-600 text-white" }
    : { label: "排队", cls: "bg-zinc-700 text-zinc-300" });
}

export function GroupPanel({ tabId, onClose, onOpenTab, onRefreshTab, onToast }) {
  const [data, setData] = useState(null);
  const [renaming, setRenaming] = useState(null); // null=不在改名；字符串=正在改
  const load = async () => { const r = await devbenchApi.getGroup(tabId); if (r.ok) setData(r.data); };
  useEffect(() => {
    load();
    const timer = setInterval(load, 3000);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabId]);
  if (!data) return null;
  const members = data.members || [];
  const devDone = members.filter((m) => m.developmentDone).length;
  const reported = members.filter((m) => m.reported).length;
  // 设为当前活动：既翻组内活动标记，也把主视图切到该故事点并关闭面板
  async function setActive(id) {
    const r = await devbenchApi.groupSetActive(id);
    if (!r.ok) { onToast?.(r.error || "切换失败"); return; }
    await onRefreshTab?.();   // 刷新 tabs（拿到最新 groupActive）
    onOpenTab?.(id);          // 切到该故事点页面（工程/标题/对话整体切换）
    onClose?.();              // 关闭组面板
    onToast?.("已切到该故事点并设为当前活动");
  }
  async function leave(id) { if (!window.confirm("把该故事点移出本组？（工程配置保留，不再排队）")) return; const r = await devbenchApi.groupLeave(id); if (r.ok) { await load(); onRefreshTab?.(); onToast?.("已移出组"); } else onToast?.(r.error); }
  async function closeMember(id, title) {
    if (!window.confirm(`关闭故事点「${title}」？配置与聊天会保留；如需永久删除，请之后到“新故事点 → 已关闭故事点”核对删除范围。`)) return;
    const r = await devbenchApi.deleteTab(id);
    if (!r.ok) { onToast?.(r.error || "关闭失败"); return; }
    await onRefreshTab?.();
    onClose?.();
    onToast?.("已关闭故事点；可在已关闭列表中选择是否永久删除聊天存档与附件");
  }
  async function doRename() { const nm = (renaming || "").trim(); if (!nm) { setRenaming(null); return; } const r = await devbenchApi.groupRename(tabId, nm); if (r.ok) { setRenaming(null); await load(); onRefreshTab?.(); } else onToast?.(r.error || "重命名失败"); }
  return (
    <div className="fixed inset-0 z-[70] flex items-start justify-center bg-black/50 pt-16" onClick={onClose}>
      <div className="w-[580px] max-w-[94vw] max-h-[74vh] flex flex-col bg-zinc-900 border border-zinc-700 rounded-xl shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="px-4 py-3 border-b border-zinc-800 flex items-center gap-2">
          <span className="text-sm font-semibold text-zinc-100 shrink-0">👥 故事点组</span>
          {renaming !== null ? (
            <input autoFocus value={renaming} onChange={(e) => setRenaming(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") doRename(); if (e.key === "Escape") setRenaming(null); }} onBlur={doRename}
              className="text-xs bg-zinc-800 border border-zinc-700 rounded px-2 py-0.5 text-zinc-100 outline-none w-52" />
          ) : (
            <button onClick={() => setRenaming(data.groupName || "故事点组")} title="点击重命名组"
              className="text-xs text-zinc-300 hover:text-white bg-zinc-800/60 border border-zinc-700 rounded px-2 py-0.5">{data.groupName || "故事点组"} ✎</button>
          )}
          <span className="text-[11px] text-zinc-500 truncate">{members.length} 个 · 开发 {devDone}/{members.length} · 提测 {reported}/{members.length}</span>
          <button onClick={onClose} className="ml-auto text-zinc-500 hover:text-zinc-200 text-sm px-1">✕</button>
        </div>
        <div className="px-3 py-2 overflow-auto space-y-1.5">
          {members.map((m) => (
            <div key={m.id} className={`flex items-center gap-2 px-2.5 py-2 rounded border ${m.active ? "border-emerald-600/60 bg-emerald-900/15" : "border-zinc-800 bg-zinc-800/40"}`}>
              {(() => { const b = groupMemberBadge(m); return <span className={`text-[10px] px-1.5 py-0.5 rounded shrink-0 ${b.cls}`}>{b.label}</span>; })()}
              {m.carbId && <span className="text-[10px] font-mono text-indigo-300 shrink-0">{m.carbId}</span>}
              <span className="flex-1 truncate text-[12px] text-zinc-200" title={m.title}>{m.title}</span>
              <button onClick={() => { onOpenTab?.(m.id); onClose?.(); }} className="text-[11px] px-2 py-0.5 rounded bg-zinc-700 hover:bg-zinc-600 text-zinc-200 shrink-0">打开</button>
              {!m.active && <button onClick={() => setActive(m.id)} className="text-[11px] px-2 py-0.5 rounded bg-emerald-700/40 hover:bg-emerald-600/50 text-emerald-200 border border-emerald-700/40 shrink-0">设为当前</button>}
              <button onClick={() => leave(m.id)} title="移出本组（保留故事点）" className="text-[11px] px-1.5 py-0.5 rounded bg-zinc-800 hover:bg-amber-600/30 text-zinc-500 hover:text-amber-300 shrink-0">移出</button>
              <button onClick={() => closeMember(m.id, m.title)} title="关闭该故事点（配置与聊天保留）" className="text-[11px] px-1.5 py-0.5 rounded bg-zinc-800 hover:bg-amber-600/30 text-zinc-500 hover:text-amber-300 shrink-0">关闭</button>
            </div>
          ))}
        </div>
        <div className="px-4 py-2 border-t border-zinc-800 text-[10px] text-zinc-500">排队中的故事点可下载附件，但不能与 AI 对话；点「设为当前」即可开始开发。开发完成后切下一个，已完成的留在组里供回看。</div>
      </div>
    </div>
  );
}

/** 钉钉消息确认弹窗 —— 发布生产产物就绪后弹出，用户可编辑消息再发送 */
function DingtalkConfirmModal({ draftMessage, atNames, onSend, onCancel }) {
  const [msg, setMsg] = useState(draftMessage);
  const [sending, setSending] = useState(false);
  useEffect(() => { setMsg(draftMessage); }, [draftMessage]);
  async function handleSend() {
    if (sending) return;
    setSending(true);
    try { await onSend(msg); } catch {}
  }
  const modal = (
    <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
      <div className="w-[560px] max-w-[92vw] max-h-[86vh] flex flex-col bg-zinc-900 border border-rose-700/50 rounded-xl shadow-2xl px-5 py-4">
        <div className="flex items-center gap-2 mb-3">
          <span className="text-sm font-semibold text-rose-300">📨 确认钉钉消息</span>
          <span className="text-[11px] text-zinc-500">可编辑后发送</span>
          <button onClick={onCancel} className="ml-auto text-zinc-500 hover:text-zinc-200 text-lg leading-none">×</button>
        </div>
        <div className="relative min-h-0 overflow-y-auto pr-1">
          <textarea
            value={msg}
            onChange={(e) => setMsg(e.target.value)}
            rows={Math.min(12, Math.max(7, msg.split("\n").length + 2))}
            className="w-full min-h-[160px] max-h-[54vh] overflow-auto bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-[13px] text-zinc-200 font-mono leading-relaxed resize-y focus:outline-none focus:border-rose-600/60 placeholder-zinc-600"
            placeholder="输入钉钉消息…"
          />
          {atNames.length > 0 && (
            <div className="mt-1 text-[10px] text-zinc-500 break-words">将 @：{atNames.join("、")}</div>
          )}
        </div>
        <div className="flex items-center gap-2 mt-3">
          <button
            onClick={onCancel}
            className="flex-1 text-[12px] px-3 py-1.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-300 border border-zinc-700 transition"
          >取消</button>
          <button
            onClick={handleSend}
            disabled={sending || !msg.trim()}
            className={`flex-1 text-[12px] px-3 py-1.5 rounded-lg border transition font-medium ${
              sending ? "bg-zinc-700 text-zinc-500 border-zinc-600 cursor-wait"
              : "bg-rose-700 hover:bg-rose-600 text-white border-rose-600"
            }`}
          >{sending ? "发送中…" : "发送到钉钉"}</button>
        </div>
      </div>
    </div>
  );
  return typeof document !== "undefined" ? createPortal(modal, document.body) : modal;
}

function PrNoticeModal({ notice, onClose }) {
  const [copied, setCopied] = useState(false);
  const success = notice.kind === "success";
  const warning = notice.kind === "warning";
  const borderClass = success ? "border-emerald-700/60" : warning ? "border-amber-700/60" : "border-red-700/60";
  const titleClass = success ? "text-emerald-300" : warning ? "text-amber-300" : "text-red-300";
  const closeClass = success
    ? "bg-emerald-700 hover:bg-emerald-600 border-emerald-600"
    : warning
      ? "bg-amber-700 hover:bg-amber-600 border-amber-600"
      : "bg-red-700 hover:bg-red-600 border-red-600";
  const icon = success ? "✓" : warning ? "⚠" : "✕";
  const results = Array.isArray(notice.results) ? notice.results : [];
  const summary = notice.summary || {};

  async function copyDetails() {
    let text = notice.fallbackText;
    if (!text) {
      const lines = [notice.title || "提 PR 结果"];
      if (results.length) {
        for (const r of results) {
          const status = r.mergeRequest?.created ? "MR已创建"
            : r.pushed ? "已推送"
            : r.skipped ? "跳过"
            : "失败";
          const url = r.mergeRequest?.webUrl ? ` ${r.mergeRequest.webUrl}` : "";
          const err = r.error || r.reason ? ` ${(r.error || r.reason)}` : "";
          lines.push(`[${r.name}·${r.role}] ${r.storyBranch || "?"} -> ${r.originalBranch || "?"} ${status}${url}${err}`);
        }
      } else {
        lines.push(String(notice.message || ""));
      }
      text = lines.join("\n");
    }
    try {
      await copyToClipboard(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {}
  }

  const modal = (
    <div
      className="fixed inset-0 z-[90] flex items-center justify-center bg-black/65 backdrop-blur-sm p-4"
      role="dialog"
      aria-modal="true"
      aria-label={notice.title || "提 PR 结果"}
      data-testid="devbench-pr-result"
    >
      <div className={`w-[680px] max-w-[94vw] max-h-[86vh] flex flex-col bg-zinc-900 border ${borderClass} rounded-xl shadow-2xl`}>
        <div className="flex items-center gap-2 px-5 py-3 border-b border-zinc-800">
          <span className={`text-sm font-semibold ${titleClass}`}>{icon} {notice.title || "提 PR 结果"}</span>
          <span className="text-[10px] text-zinc-500">此结果会保留到手动关闭</span>
          <button onClick={onClose} className="ml-auto text-zinc-500 hover:text-zinc-200 text-lg leading-none" aria-label="关闭">×</button>
        </div>
        <div className="min-h-0 overflow-y-auto px-5 py-4 space-y-3">
          {results.length ? (
            <>
              <div className="text-[12px] text-zinc-300 leading-relaxed">
                共 {summary.total ?? results.length} 个工程 ·
                <span className="text-emerald-400"> {summary.mrCreated ?? 0} 个 MR 已创建</span> ·
                <span className="text-cyan-400"> {summary.pushed ?? 0} 个已推送</span>
                {summary.failed ? <span className="text-red-400"> · {summary.failed} 个失败</span> : null}
                {summary.skipped ? <span className="text-amber-400"> · {summary.skipped} 个跳过</span> : null}
              </div>
              <div className="space-y-2">
                {results.map((r, i) => {
                  const mrCreated = !!r.mergeRequest?.created;
                  const pushed = !!r.pushed;
                  const skipped = !!r.skipped;
                  const ok = !!r.ok;
                  const badge = mrCreated
                    ? { t: "MR 已创建", c: "bg-emerald-700/40 text-emerald-200" }
                    : pushed
                      ? { t: "已推送", c: "bg-cyan-700/40 text-cyan-200" }
                      : skipped
                        ? { t: "跳过", c: "bg-amber-700/40 text-amber-200" }
                        : { t: "失败", c: "bg-red-700/40 text-red-200" };
                  const cardBorder = mrCreated
                    ? "border-emerald-800/50 bg-emerald-950/15"
                    : skipped
                      ? "border-amber-800/40 bg-amber-950/10"
                      : ok
                        ? "border-cyan-800/50 bg-cyan-950/10"
                        : "border-red-800/50 bg-red-950/15";
                  return (
                    <div key={i} className={`text-[12px] border rounded-lg p-2.5 ${cardBorder}`}>
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-medium text-zinc-100">{r.name}</span>
                        <span className="text-zinc-600">{r.role}</span>
                        <span className={`px-1.5 py-0.5 rounded text-[10px] ${badge.c}`}>{badge.t}</span>
                      </div>
                      <div className="mt-1.5 flex items-center gap-1.5 flex-wrap text-[11px]">
                        <span className="font-mono text-amber-300 bg-zinc-950/60 px-1.5 py-0.5 rounded" title="故事分支（来源）">{r.storyBranch || "?"}</span>
                        <span className="text-zinc-500">-&gt;</span>
                        <span className="font-mono text-cyan-300 bg-zinc-950/60 px-1.5 py-0.5 rounded" title="原始分支（目标）">{r.originalBranch || "?"}</span>
                      </div>
                      {r.mergeRequest?.webUrl ? (
                        <div className="mt-1.5">
                          <a href={r.mergeRequest.webUrl} target="_blank" rel="noopener noreferrer" className="text-[11px] text-sky-400 hover:text-sky-300 underline break-all">打开 PR 详情页</a>
                        </div>
                      ) : null}
                      {(r.error || r.reason) ? (
                        <div className="mt-1.5 text-[11px] leading-relaxed text-amber-200 break-all">{r.error || r.reason}</div>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            </>
          ) : (
            <pre className="whitespace-pre-wrap break-words rounded-lg border border-zinc-700 bg-zinc-950/70 px-3 py-2 text-[12px] leading-relaxed text-zinc-200">{notice.message}</pre>
          )}
          {notice.transferConflict && (
            <div className="text-[11px] leading-relaxed text-amber-200 bg-amber-950/30 border border-amber-800/40 rounded-lg px-3 py-2">
              Git 未丢弃任何内容。请在当前来源分支解决上面的冲突，再次点击“提 PR”即可继续。
            </div>
          )}
        </div>
        <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-zinc-800">
          <button onClick={copyDetails} className="text-[12px] px-3 py-1.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-300 border border-zinc-700">
            {copied ? "已复制" : "复制详情"}
          </button>
          {notice.fallbackUrl && !results.length && (
            <a href={notice.fallbackUrl} target="_blank" rel="noopener noreferrer" className="text-[12px] px-3 py-1.5 rounded-lg bg-amber-700/50 hover:bg-amber-600/60 text-amber-100 border border-amber-700/60">
              打开 Codeup
            </a>
          )}
          <button onClick={onClose} data-testid="devbench-pr-result-close" className={`text-[12px] px-4 py-1.5 rounded-lg text-white border ${closeClass}`}>
            我知道了
          </button>
        </div>
      </div>
    </div>
  );
  return typeof document !== "undefined" ? createPortal(modal, document.body) : modal;
}

function repositoryPathAlertIssues(alert) {
  if (!alert || typeof alert !== "object") return [];
  const collections = [
    alert.issues,
    alert.items,
    alert.repositories,
    alert.paths,
    alert.repositoryPaths,
    alert.unmappedRepositories,
    alert.ambiguousRepositories,
    alert.details,
  ];
  const rawIssues = collections.find((items) => Array.isArray(items) && items.length > 0) || [];
  const fallbackReason = alert.reason || alert.message || alert.error || "当前故事点没有可安全使用的 worktree 映射。";
  const normalized = rawIssues.map((issue) => {
    if (typeof issue === "string") return { path: issue, reason: fallbackReason };
    const item = issue && typeof issue === "object" ? issue : {};
    const candidates = item.candidates || item.worktrees || item.candidateWorktrees || [];
    const candidatePaths = Array.isArray(candidates)
      ? candidates.map((candidate) => (
          typeof candidate === "string"
            ? candidate
            : candidate?.worktreePath || candidate?.path || candidate?.branch || ""
        )).filter(Boolean)
      : [];
    const reason = item.reason || item.message || item.error || fallbackReason;
    return {
      path: item.repositoryPath || item.basePath || item.inputPath || item.path || item.repository || "基础仓库路径未返回",
      reason,
      candidatePaths,
    };
  });
  if (normalized.length > 0) return normalized;
  return [{
    path: alert.repositoryPath || alert.basePath || alert.inputPath || alert.path || "基础仓库路径未返回",
    reason: fallbackReason,
  }];
}

function RepositoryPathAlertCard({ alert, onOpenStoryConfig }) {
  if (!alert) return null;
  const ambiguous = alert.code === "STORY_BASE_WORKTREE_AMBIGUOUS"
    || alert.kind === "ambiguous"
    || /多个|歧义/.test(`${alert.title || ""} ${alert.reason || ""}`);
  const issues = repositoryPathAlertIssues(alert);
  return (
    <div
      role="alert"
      aria-live="assertive"
      data-testid="story-repository-path-alert"
      data-alert-code={alert.code || ""}
      className="mb-3 rounded-xl border devbench-status-surface devbench-status-surface--danger px-3 py-2.5"
    >
      <div className="flex items-start gap-2.5">
        <span aria-hidden="true" className="mt-0.5 text-lg leading-none text-red-300">⚠</span>
        <div className="min-w-0 flex-1">
          <div className="text-[12px] font-semibold text-red-100">
            AI 未执行：{ambiguous ? "基础仓库对应多个 worktree" : "基础仓库尚未映射到当前故事点 worktree"}
          </div>
          <p className="mt-1 text-[11px] leading-relaxed text-amber-100/85">
            {alert.message || (ambiguous
              ? "为保护基础项目，AI 无法判断应使用哪个隔离工作区，已停止本次消息。"
              : "为保护基础项目，AI 不会直接进入基础仓库，已停止本次消息。")}
          </p>
          <ul className="mt-2 space-y-1" data-testid="story-repository-path-alert-issues">
            {issues.map((issue, index) => (
              <li key={`${issue.path}-${index}`} className="rounded border border-red-900/60 bg-black/20 px-2 py-1 text-[10px] leading-relaxed">
                <span className="break-all font-mono text-red-200">{issue.path}</span>
                <span className="mx-1.5 text-red-500/80">—</span>
                <span className="text-zinc-300">{issue.reason}</span>
                {issue.candidatePaths?.length > 0 ? (
                  <div className="mt-1 text-amber-200/90">
                    候选 worktree：<span className="break-all font-mono">{issue.candidatePaths.join("、")}</span>
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
        <button
          type="button"
          data-testid="story-repository-path-alert-config"
          onClick={() => onOpenStoryConfig?.()}
          className="shrink-0 rounded-lg border border-amber-400/50 bg-amber-500/15 px-3 py-1.5 text-[11px] font-medium text-amber-100 transition hover:border-amber-300 hover:bg-amber-500/25 focus:outline-none focus:ring-2 focus:ring-amber-400/60"
        >
          配置对应工程
        </button>
      </div>
    </div>
  );
}

export default function StoryTab({
  tab, projects, otherOccupied, messages, conversation = null, live, cloneProgress, copyProgress = null, agentRun = null, centerServers = [], centerConfig = {}, onSetCenter, onAgentRun,
  onSend, onEditAndResend, onSelectConversationBranch, onSetPrimary, onSwapPrimary, onAddExtra, onRemoveExtra, onRename, onSetTicket, onRefreshTab, onOpenTab,
  onGitUpdate, gitUpdating = false, gitUpdate = null, onGitResolveAI, onGitUpdateClose,
  build = null, buildSelection = null, onBuildSelectionChange, onBuild, onBuildStop, onBuildClose,
  devices = [], deviceOwners = {}, ticketOwners = {}, onRefreshDevices, onBindDevice, onReleaseDevice, onOpenApk, onSetApkSource, onPublishProd, onOpenProdDir, onPublishShareLogin, onUploadResignedApk, publishProgress = null, onClosePublish, onRebaseToOriginal, rebaseProgress = null, onCloseRebase, onConfirmRebase, onToast, isRunning = false, onStop, onReject,
  onStartTriage, onSetAutoMode,onSetReportMode, onSetSkipTestAcceptance, onSetWorkflowPhase, onMarkFixed, onStartVerify, onStartReport, onStartCodeReview, configClip = null, repositoryPathAlert: responseRepositoryPathAlert = null, onOpenStoryConfig, onCopyConfig, onApplyConfig, onOpenGroup, onArchiveRestored,
  onRetryTbSync,
  dingtalkConfirm = null, onConfirmDingtalk, onCancelDingtalk,
}) {
  // 正在复制工程：本故事点锁定（不可对话/编辑/下载附件），顶部显示进度条
  const copying = !!(copyProgress || tab.copying);
  const workspaceInitialization = tab.workspaceInitialization && typeof tab.workspaceInitialization === "object"
    ? tab.workspaceInitialization
    : null;
  const workspaceInitializing = ["queued", "preparing"].includes(workspaceInitialization?.status);
  const workspaceInitializationFailed = workspaceInitialization?.status === "error";
  const remoteSourceInitialization = tab.remoteSourceInitialization && typeof tab.remoteSourceInitialization === "object"
    ? tab.remoteSourceInitialization
    : null;
  const remoteInitializing = ["queued", "cloning"].includes(tab.cloneStatus)
    || ["queued", "cloning"].includes(remoteSourceInitialization?.status);
  const remoteInitializationFailed = tab.cloneStatus === "error" || remoteSourceInitialization?.status === "error";
  const backgroundInitializing = workspaceInitializing || remoteInitializing;
  const backgroundInitializationFailed = workspaceInitializationFailed || remoteInitializationFailed;
  const remoteCloneRows = Object.values(cloneProgress?.repos || {}).filter(Boolean);
  const remoteProgress = remoteSourceInitializationProgress(tab, cloneProgress);
  const repositoryPathAlert = tab.repositoryPathAlert || responseRepositoryPathAlert;
  const [retryingWorkspaceInitialization, setRetryingWorkspaceInitialization] = useState(false);
  const [queueAction, setQueueAction] = useState("");
  const [aiPromptPanel, setAiPromptPanel] = useState(null);
  const [engineStatus, setEngineStatus] = useState(() => readEngineStatusCache()?.data || null);
  const [engineStatusLoading, setEngineStatusLoading] = useState(false);
  const engineStatusRequestRef = useRef(false);
  const [engineMetadata, setEngineMetadata] = useState({});
  const engineMetadataScope = [
    tab.id,
    tab.engine || "claude",
    JSON.stringify(tab.aiPrefs || {}),
    tab.primaryProjectId || "",
    ...(tab.remoteRepos || []).map((repo) => `${repo.role || ""}:${repo.path || ""}`),
  ].join("|");
  useEffect(() => {
    let active = true;
    if (centerConfig?.clientMode) {
      setEngineMetadata({});
      return () => { active = false; };
    }
    // 作用域变化后先清掉旧工程值；若新请求失败则显示“默认”，不能把旧 model/档位冒充为当前配置。
    setEngineMetadata({});
    devbenchApi.getEngineMetadata(tab.id)
      .then((result) => {
        if (active && result?.ok && result.data && typeof result.data === "object") setEngineMetadata(result.data);
      })
      .catch(() => {});
    return () => { active = false; };
  }, [engineMetadataScope, centerConfig?.clientMode, tab.id]);
  const refreshEngineStatus = useCallback(async () => {
    if (engineStatusRequestRef.current) return;
    engineStatusRequestRef.current = true;
    setEngineStatusLoading(true);
    try {
      const latest = await devbenchApi.getEngineStatus();
      if (latest) setEngineStatus(latest);
      else onToast?.(engineStatus ? "AI 模型状态复检失败，继续显示上次结果" : "AI 模型状态检测失败");
    } finally {
      engineStatusRequestRef.current = false;
      setEngineStatusLoading(false);
    }
  }, [engineStatus, onToast]);
  // 输入框草稿按故事点持久化（切 Tab 会 remount，本地 state 会丢；用 localStorage 保住、刷新也不丢）
  const draftKey = storyInputDraftStorageKey(tab.id);
  const storyInputRef = useRef(null);
  const [sending, setSending] = useState(false);
  const [reviewStarting, setReviewStarting] = useState(false);
  const reviewStartingRef = useRef(false);
  const draftContextRevisionRef = useRef(0);
  const [replyTo, setReplyToState] = useState(null); // 引用的消息 { role, content }
  const setReplyTo = useCallback((updater) => {
    draftContextRevisionRef.current += 1;
    setReplyToState(updater);
  }, []);
  const [messageMenu, setMessageMenu] = useState({ id: null, pinned: false });
  const [editingMessageId, setEditingMessageId] = useState(null);
  const [branchSwitchingId, setBranchSwitchingId] = useState(null);
  const [attachments, setAttachmentsState] = useState([]); // 已上传材料 [{ name, relPath }]
  const setAttachments = useCallback((updater) => {
    draftContextRevisionRef.current += 1;
    setAttachmentsState(updater);
  }, []);
  const [dragOver, setDragOver] = useState(false);
  const [uploading, setUploading] = useState(false);
  const resignInputRef = useRef(null);
  const [resignDragOver, setResignDragOver] = useState(false);
  const [resignUploading, setResignUploading] = useState(false);
  const [resignError, setResignError] = useState("");
  useEffect(() => { setResignError(""); setResignDragOver(false); }, [publishProgress?.resignId]);
  const [shareUsername, setShareUsername] = useState("");
  const [sharePassword, setSharePassword] = useState("");
  const [shareDomain, setShareDomain] = useState("");
  const [shareLoggingIn, setShareLoggingIn] = useState(false);
  const [shareLoginError, setShareLoginError] = useState("");
  useEffect(() => {
    setSharePassword("");
    setShareLoginError("");
  }, [publishProgress?.shareRoot, publishProgress?.retryId]);

  async function uploadResignedApkFromFiles(fileList) {
    const files = Array.from(fileList || []);
    const apks = files.filter((f) => /\.apk$/i.test(f.name || f.webkitRelativePath || ""));
    if (!apks.length) { setResignError("目录里没有找到 .apk 文件"); return; }
    apks.sort((a, b) => (b.lastModified || 0) - (a.lastModified || 0));
    const apk = apks[0];
    if (apks.length > 1) onToast?.(`检测到 ${apks.length} 个 APK，默认上传最新的：${apk.name}`);
    if (!publishProgress?.resignId) { setResignError("二签会话已失效，请重新点击发布生产"); return; }
    setResignError("");
    setResignUploading(true);
    try {
      const r = await onUploadResignedApk?.(publishProgress.resignId, apk);
      if (!r?.ok) setResignError(r?.error || "上传或签名校验失败");
    } finally {
      setResignUploading(false);
      if (resignInputRef.current) resignInputRef.current.value = "";
    }
  }

  async function handleResignDrop(e) {
    e.preventDefault();
    setResignDragOver(false);
    const items = e.dataTransfer.items ? Array.from(e.dataTransfer.items) : [];
    const entries = items.map((it) => (it.webkitGetAsEntry ? it.webkitGetAsEntry() : null)).filter(Boolean);
    if (entries.length) {
      const collected = [];
      for (const en of entries) await collectEntryFilesNoSkip(en, "", collected);
      await uploadResignedApkFromFiles(collected.map((x) => x.file));
    } else {
      await uploadResignedApkFromFiles(e.dataTransfer.files);
    }
  }

  async function submitShareLogin(e) {
    e?.preventDefault?.();
    const shareRoot = String(publishProgress?.shareRoot || "").trim();
    if (!shareRoot) { setShareLoginError("缺少共享目录地址，请重新点击发布生产"); return; }
    if (!shareUsername.trim() || !sharePassword) { setShareLoginError("请输入共享目录账号和密码"); return; }
    setShareLoginError("");
    setShareLoggingIn(true);
    try {
      const r = await onPublishShareLogin?.({
        shareRoot,
        retryId: publishProgress?.retryId || "",
        username: shareUsername.trim(),
        password: sharePassword,
        domain: shareDomain.trim(),
      });
      if (!r?.ok) setShareLoginError(r?.error || "共享目录登录失败");
      else setSharePassword("");
    } finally {
      setShareLoggingIn(false);
    }
  }

  function nextAttachmentBatchId() {
    return createAttachmentBatchId({
      now: Date.now(),
      random: globalThis.crypto?.randomUUID?.() || Math.random().toString(36).slice(2),
    });
  }

  function draftAttachment(file, uploaded, extra = {}) {
    const sourceFile = file?.file || file;
    const originalName = String(file?.name || sourceFile?.name || uploaded?.name || "附件");
    const mime = String(file?.type || sourceFile?.type || "");
    const isImg = mime.startsWith("image/") || /\.(?:png|jpe?g|gif|webp|bmp|avif)$/i.test(originalName);
    return {
      id: globalThis.crypto?.randomUUID?.() || `attachment-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      ...uploaded,
      name: originalName,
      originalName,
      kind: "file",
      fileCount: 0,
      size: Number(uploaded?.size ?? sourceFile?.size) || 0,
      mime,
      isImg,
      source: extra.source || "upload",
      scope: "message",
      preview: isImg && sourceFile ? URL.createObjectURL(sourceFile) : null,
      ...extra,
    };
  }

  async function handleDropFiles(fileList, { source = "paste" } = {}) {
    const files = Array.from(fileList || []);
    if (!files.length) return;
    if (!tab.primaryProjectId) { onOpenStoryConfig?.(); return; }
    const batchId = nextAttachmentBatchId();
    const added = [];
    setUploading(true);
    try {
      for (const file of files) {
        const uploadFile = file?.file || file;
        const displayName = String(file?.name || uploadFile?.name || "attachment.bin");
        const relative = attachmentUploadRelativePath(batchId, uploadFile?.webkitRelativePath || displayName);
        const r = await devbenchApi.uploadFile(tab.id, uploadFile, relative);
        if (r.ok) added.push(draftAttachment(file, r.data, { source }));
        else onToast?.(`上传「${displayName}」失败：${r.error}`);
      }
    } catch (error) {
      onToast?.(`附件上传中断：${error?.message || error}`);
    } finally {
      if (added.length) setAttachments((prev) => [...prev, ...added]);
      setUploading(false);
    }
  }

  // 拖放文件/文件夹默认属于本条消息；发送后从输入框移动到用户消息气泡。
  // “持续上下文材料”保留给旧数据/显式固定场景，普通拖放不再自动变成每轮注入。
  // 注意：必须在任何 await 之前同步取出 entries —— drop 事件结束后 dataTransfer.items 会失效。
  async function handleDrop(e) {
    e.preventDefault();
    setDragOver(false);
    if (!tab.primaryProjectId) { onOpenStoryConfig?.(); return; }
    const items = e.dataTransfer.items ? Array.from(e.dataTransfer.items) : [];
    const entries = items.map((it) => (it.webkitGetAsEntry ? it.webkitGetAsEntry() : null)).filter(Boolean);
    const fallbackFiles = entries.length ? [] : Array.from(e.dataTransfer.files || []);
    if (!entries.length && !fallbackFiles.length) return;

    setUploading(true);
    const batchId = nextAttachmentBatchId();
    const added = [];
    const addFile = async (file, relName) => {
      const uploadName = attachmentUploadRelativePath(batchId, relName || file.name);
      const r = await devbenchApi.uploadFile(tab.id, file, uploadName);
      if (r.ok) { added.push(draftAttachment(file, r.data, { source: "drop" })); onToast?.(`已添加本轮附件：${file.name}`); }
      else onToast?.(`上传「${file.name}」失败: ${r.error}`);
    };

    try {
      for (const en of entries) {
        if (en.isFile) {
          const f = await new Promise((res, rej) => en.file(res, rej));
          await addFile(f);
        } else if (en.isDirectory) {
          const collected = [];
          await collectEntryFiles(en, "", collected);
          if (!collected.length) { onToast?.(`文件夹「${en.name}」为空或仅含被跳过的目录`); continue; }
          if (collected.length >= MAX_FOLDER_FILES) onToast?.(`文件夹「${en.name}」过大，仅上传前 ${MAX_FOLDER_FILES} 个文件`);
          let okCount = 0, firstRel = "", totalBytes = 0;
          for (const { file, relPath } of collected) {
            const r = await devbenchApi.uploadFile(tab.id, file, attachmentUploadRelativePath(batchId, relPath));
            if (r.ok) { okCount++; totalBytes += Number(r.data?.size) || 0; if (!firstRel) firstRel = r.data.relPath; }
          }
          if (!okCount) { onToast?.(`文件夹「${en.name}」上传失败`); continue; }
          const firstSourceDepth = String(collected[0]?.relPath || "").split("/").filter(Boolean).length;
          const uploadedSegments = firstRel.split("/");
          const folderRel = uploadedSegments
            .slice(0, Math.max(1, uploadedSegments.length - firstSourceDepth + 1))
            .join("/");
          added.push({
            id: globalThis.crypto?.randomUUID?.() || `attachment-${Date.now()}-${Math.random().toString(36).slice(2)}`,
            name: en.name,
            originalName: en.name,
            relPath: folderRel,
            kind: "folder",
            fileCount: okCount,
            size: totalBytes,
            mime: "",
            isImg: false,
            source: "drop",
            scope: "message",
          });
          onToast?.(`已添加本轮文件夹附件「${en.name}」（${okCount} 个文件）`);
        }
      }
      // 少数浏览器无 webkitGetAsEntry：退回用 files（只能拿到文件，拿不到文件夹内容）
      for (const f of fallbackFiles) await addFile(f, f.webkitRelativePath || f.name);
    } catch (error) {
      onToast?.(`附件拖拽上传中断：${error?.message || error}`);
    } finally {
      setUploading(false);
      if (added.length) setAttachments((prev) => [...prev, ...added]);
    }
  }

  // 移除一个持久会话材料（仅取消上下文注入，磁盘文件保留）
  async function removeMaterial(relPath) {
    await devbenchApi.removeMaterial(tab.id, relPath);
    onRefreshTab?.();
  }

  // 粘贴文件（Ctrl+V）：优先保留 File.name；Windows 资源管理器未暴露 File 对象时，
  // 再由当前本机 Gateway 从系统 FileDropList 导入，最后才使用 paste_* 兜底。
  async function onPasteInput(e) {
    const files = clipboardAttachmentFiles(e.clipboardData, { now: Date.now() });
    if (files.length) {
      e.preventDefault();
      await handleDropFiles(files, { source: "clipboard" });
      return;
    }
    const text = String(e.clipboardData?.getData?.("text/plain") || "");
    if (!text) {
      e.preventDefault();
      setUploading(true);
      try {
        const result = await devbenchApi.importClipboardAttachments(tab.id);
        if (!result?.ok) {
          onToast?.(result?.error || "无法读取系统剪贴板文件");
          return;
        }
        const imported = Array.isArray(result.data) ? result.data.map((item) => ({
          ...item,
          mime: "",
          isImg: /\.(?:png|jpe?g|gif|webp|bmp|avif)$/i.test(item.name || ""),
        })) : [];
        if (imported.length) setAttachments((prev) => [...prev, ...imported]);
        if (result.skipped?.length) onToast?.(`已导入 ${imported.length} 个文件，另有 ${result.skipped.length} 项未导入`);
        else if (imported.length) onToast?.(`已从系统剪贴板导入 ${imported.length} 个附件`);
      } catch (error) {
        onToast?.(`无法读取系统剪贴板文件：${error?.message || error}`);
      } finally {
        setUploading(false);
      }
    }
  }
  // Legacy inline configuration stays mounted in source for compatibility, but
  // all current user entries are routed to the central multi-tab panel.
  const [showConfig] = useState(false);
  const [showProjectControls, setShowProjectControls] = useState(() => {
    // 记住上次展开/收起状态：用户展开过工程操作区（Git 分支行、worktree 分支都在区内）后，
    // 刷新/重新进入故事点仍保持展开，避免“Git 分支/worktree 分支消失”的观感。
    const stored = readProjectControlsExpanded(tab.id);
    if (stored != null) return stored;
    return !tab.primaryProjectId;
  });
  const storyRootRef = useRef(null);
  const projectControlsToggleRef = useRef(null);
  const projectControlsDragRef = useRef(null);
  const suppressProjectControlsClickRef = useRef(false);
  const projectControlsPositionKey = useMemo(
    () => projectControlsPositionStorageKey(tab.id),
    [tab.id],
  );
  const [projectControlsPosition, setProjectControlsPosition] = useState(() => {
    try {
      return parseProjectControlsPosition(localStorage.getItem(projectControlsPositionStorageKey(tab.id)));
    } catch {
      return null;
    }
  });
  useEffect(() => {
    if (!tab.primaryProjectId) {
      // 无主工程必须展开工程操作区（用户需选择工程）；仅在没有用户偏好记录时落盘展开，
      // 避免把用户显式收起的状态覆盖成展开（有记录时仍按 useState 读到的值 + 此处强制展开，与原设计一致）。
      setShowProjectControls(true);
      if (readProjectControlsExpanded(tab.id) == null) writeProjectControlsExpanded(tab.id, true);
    }
  }, [tab.primaryProjectId]);
  // 配置区配置项较多时会内部滚动；用此标记控制底部"下滑查看更多"提示，滚到底自动隐藏
  const cfgScrollRef = useRef(null);
  const cfgInnerRef = useRef(null);
  const [cfgMore, setCfgMore] = useState(false);
  const measureCfgScroll = useCallback(() => {
    const el = cfgScrollRef.current;
    if (!el) { setCfgMore(false); return; }
    // 距底部 >8px 视为下方还有未显示的配置
    setCfgMore(el.scrollHeight - el.scrollTop - el.clientHeight > 8);
  }, []);
  const [extraPath, setExtraPath] = useState("");
  const [extraName, setExtraName] = useState("");
  const [ticketDraft, setTicketDraft] = useState(looksLikeTicketUrl(tab.ticketUrl) ? (tab.ticketUrl || "") : ""); // 关联工单 URL 输入草稿（纯标题不镜像，避免与下拉重复）
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState(tab.title);
  const [branches, setBranches] = useState([]);
  const [loadingBranches, setLoadingBranches] = useState(false);
  const [branchPairs, setBranchPairs] = useState(null);
  const [loadingBranchPairs, setLoadingBranchPairs] = useState(false);
  const [flavors, setFlavors] = useState([]); // [{ path, name, role, isAndroid, flavors:[], selected }]
  const [apkStatus, setApkStatus] = useState(null); // { hasApk, dir, file, fallback, isProdRelease, project } | null(未知)
  const [tickets, setTickets] = useState([]); // 当前用户的 TB 工单（供关联工单下拉）
  const [showOutline, setShowOutline] = useState(false); // 提问大纲面板
  const [showResources, setShowResources] = useState(false); // 资源管理面板
  const [showTools, setShowTools] = useState(false); // 工具命令面板
  const [showLocalChanges, setShowLocalChanges] = useState(false); // Local Changes（Git）面板
  const [showGitAmend, setShowGitAmend] = useState(false); // Amend 本地改动（rule_1）面板
  const [showGitCommitRework, setShowGitCommitRework] = useState(false); // Git 提交整理（prompt_ask）面板
  const [showGitUpdateScope, setShowGitUpdateScope] = useState(false); // Git Update 更新范围选择
  const [showPush, setShowPush] = useState(false); // Git Push（AS 风格）面板
  const [showPrPreview, setShowPrPreview] = useState(false); // 提 PR 前先展示工程/分支/可提提交
  const [showWorktreeCleanup, setShowWorktreeCleanup] = useState(false);
  const [worktreeRebuild, setWorktreeRebuild] = useState(null);
  const [recreatingWorktree, setRecreatingWorktree] = useState(false);
  const [creatingPr, setCreatingPr] = useState(false);
  const [prNotice, setPrNotice] = useState(null); // 提 PR 的持久结果；错误不能只靠 3.5 秒 toast
  const [backingUpStory, setBackingUpStory] = useState(false); // 一键备份故事点进行中
  const [gitStatusVersion, setGitStatusVersion] = useState(0);
  const [showBuild, setShowBuild] = useState(false); // 编译产物（gradle assemble）面板
  const [marking, setMarking] = useState(false); // 标记当前版本进行中
  const [highlightIdx, setHighlightIdx] = useState(-1);
  const scrollRef = useRef(null);
  const followLatestRef = useRef(true);
  const forceFollowRef = useRef(false);
  const [showJumpToBottom, setShowJumpToBottom] = useState(false);
  const [floatingActionsCollapsed, setFloatingActionsCollapsed] = useState(() => {
    try { return localStorage.getItem("devbench_story_actions_collapsed") === "1"; } catch { return false; }
  });
  const msgRefs = useRef([]); // 每条消息的 DOM 节点，供大纲跳转

  const [diagCopied, setDiagCopied] = useState(false);
  const [showFixChat, setShowFixChat] = useState(false); // AI 修复聊天弹窗（每故事点独立，可隐藏）
  const [fixSending, setFixSending] = useState(false);
  const [archived, setArchived] = useState(false); // 存档成功的短暂反馈
  const [showArchiveManager, setShowArchiveManager] = useState(false);
  const [conversationBackupMode, setConversationBackupMode] = useState("");
  const [showArchiveDirPicker, setShowArchiveDirPicker] = useState(false);
  const archiveDirValue = tab.effectiveArchiveDir || tab.archiveDir || tab.defaultArchiveDir || "";
  const [archiveDirDraft, setArchiveDirDraft] = useState(archiveDirValue);
  const [archiveDirSaving, setArchiveDirSaving] = useState(false);
  const [archiveDirCopied, setArchiveDirCopied] = useState(false);
  const [archiveDirOpening, setArchiveDirOpening] = useState(false);
  useEffect(() => { setArchiveDirDraft(archiveDirValue); }, [tab.id, archiveDirValue]);

  async function saveArchiveDir(nextDir = archiveDirDraft) {
    setArchiveDirSaving(true);
    const r = await devbenchApi.setArchiveDir(tab.id, nextDir);
    setArchiveDirSaving(false);
    if (!r.ok) { onToast?.(r.error || "保存存档目录失败"); return false; }
    setArchiveDirDraft(r.data?.effectiveArchiveDir || nextDir || "");
    await onRefreshTab?.();
    onToast?.("存档目录已更新");
    return true;
  }

  // 用系统资源管理器打开当前生效的存档目录
  async function openArchiveDir() {
    if (!archiveDirValue) return;
    setArchiveDirOpening(true);
    const r = await devbenchApi.openDir(archiveDirValue);
    setArchiveDirOpening(false);
    if (!r?.ok) onToast?.(r?.error || "打开目录失败，路径可能尚不存在");
  }

  async function recreateWorktree() {
    if (recreatingWorktree) return;
    setRecreatingWorktree(true);
    try {
      const result = await devbenchApi.recreateWorktree(tab.id);
      if (!result?.ok) {
        onToast?.(result?.error || "重新创建 worktree 失败");
        return;
      }
      await onRefreshTab?.();
      onToast?.("worktree 已重新创建，可继续开发");
    } finally {
      setRecreatingWorktree(false);
    }
  }

  // 生成该故事点的诊断/上下文文本，供粘贴到外部 AI CLI 排查
  function buildDiagnostics() {
    const primaryP = projects.find((p) => p.id === tab.primaryProjectId) || null;
    const L = [];
    L.push(`# 故事点诊断 / 上下文（AIEfficiency · 工程开发 /devbench）`);
    L.push(`> 以下是网页端某个故事点的上下文，请据此继续排查/修复问题。`);
    L.push("");
    L.push(`## 故事点`);
    L.push(`- 标题: ${tab.title}`);
    L.push(`- tabId: ${tab.id}　sessionId: ${tab.sessionId}`);
    L.push(`- cliSessionId: ${tab.cliSessionId || "（无，尚未续接）"}　轮次: ${tab.turns || 0}　状态: ${isRunning ? "运行中" : "空闲"}`);
    L.push(`- 存档文件(含完整问答，可直接 Read): ${tab.archiveFile || "（尚未生成）"}`);
    L.push("");
    L.push(`## 工程`);
    if (primaryP) {
      L.push(`- 主工程: ${primaryP.name} → ${primaryP.path}`);
      if (primaryP.webAppPath) L.push(`- 依赖 WebApp: ${primaryP.webAppPath}`);
    } else L.push(`- 主工程: 未选择`);
    for (const ex of tab.extraProjects || []) L.push(`- 关联工程: ${ex.name || ex.path} → ${ex.path}`);
    for (const m of tab.materials || []) L.push(`- 附带材料: ${m.name}（${m.relPath}${m.fileCount ? `，${m.fileCount} 个文件` : ""}）`);
    for (const f of flavors) if (f.selected) L.push(`- 目标 Flavor: ${f.name} → ${f.selected}`);
    L.push(`- 目标设备: ${tab.deviceSerial || "未绑定"}`);
    if (tab.ticketUrl) L.push(`- 关联工单: ${tab.ticketUrl}`);
    if (branches.length) {
      L.push("");
      L.push(`## Git 分支`);
      for (const b of branches) L.push(`- ${b.name}: ${b.branch || (b.exists ? "非 git 仓库" : "路径不存在")}`);
    }
    const recent = messages.slice(-4);
    if (recent.length) {
      L.push("");
      L.push(`## 最近对话（最后 ${recent.length} 条，长内容已截断，完整见存档文件）`);
      for (const m of recent) {
        const who = m.role === "user" ? "我" : "AI";
        let c = (m.content || "").trim();
        if (c.length > 800) c = c.slice(0, 800) + " …(截断)";
        L.push(`【${who}】${m.stopped ? "（已停止，内容已保留）" : m.error ? "（执行失败）" : ""}`);
        L.push(c);
        L.push("");
      }
    }
    L.push(`---`);
    L.push(`需要完整历史时请 Read 上面的“存档文件”路径。`);
    return L.join("\n");
  }

  async function copyDiagnostics() {
    await copyToClipboard(buildDiagnostics());
    setDiagCopied(true);
    onToast?.("已复制诊断参数到剪贴板");
    setTimeout(() => setDiagCopied(false), 1500);
  }

  // 修复按钮只发送简短动作消息；工程、TB、设备、Flavor、材料和历史由后端 Prompt composer 注入。
  async function startFix(actionId = "start_fix") {
    if (fixSending) return;
    setFixSending(true);
    const prompt = workflowRepairTriggerContent(actionId);
    try {
      await onSend(prompt);
      onToast?.(`已发送“${prompt}”；完整上下文将由后端自动注入`);
      setShowFixChat(false);
    } finally {
      setFixSending(false);
    }
  }

  function jumpToMessage(i) {
    const stableId = conversationMessageStableId(conversation, messages[i], i);
    const el = msgRefs.current[stableId] || msgRefs.current[i];
    if (el) {
      el.scrollIntoView({ behavior: "smooth", block: "center" });
      setHighlightIdx(i);
      setTimeout(() => setHighlightIdx((cur) => (cur === i ? -1 : cur)), 1600);
    }
  }

  const pauseFollowingForInteraction = useCallback(() => {
    forceFollowRef.current = false;
    followLatestRef.current = false;
  }, []);

  const handleConversationScroll = useCallback((event) => {
    const status = storyScrollStatus(event.currentTarget, { forceFollowing: forceFollowRef.current });
    followLatestRef.current = status.following;
    setShowJumpToBottom(status.showJumpToBottom);
    if (status.atBottom) forceFollowRef.current = false;
  }, []);

  const scrollConversationToBottom = useCallback((behavior = "smooth") => {
    const el = scrollRef.current;
    if (!el) return;
    followLatestRef.current = true;
    forceFollowRef.current = behavior === "smooth";
    setShowJumpToBottom(false);
    el.scrollTo({ top: el.scrollHeight, behavior });
  }, []);

  const handleConversationKeyboard = useCallback((event) => {
    if (event.defaultPrevented) return;
    const target = event.target;
    if (target instanceof Element && target.closest("input, textarea, select, [contenteditable='true']")) return;
    const command = storyScrollKeyCommand(event.key);
    if (!command) return;
    const el = scrollRef.current;
    if (!el) return;
    event.preventDefault();
    if (command === "bottom") {
      scrollConversationToBottom("smooth");
      return;
    }
    pauseFollowingForInteraction();
    const nextTop = storyPageUpTarget(el);
    el.scrollTo({ top: nextTop, behavior: "auto" });
    setShowJumpToBottom(storyScrollStatus({
      scrollHeight: el.scrollHeight,
      clientHeight: el.clientHeight,
      scrollTop: nextTop,
    }).showJumpToBottom);
  }, [pauseFollowingForInteraction, scrollConversationToBottom]);

  useEffect(() => {
    window.addEventListener("keydown", handleConversationKeyboard);
    return () => window.removeEventListener("keydown", handleConversationKeyboard);
  }, [handleConversationKeyboard]);

  const toggleFloatingActions = useCallback(() => {
    setFloatingActionsCollapsed((collapsed) => {
      const next = !collapsed;
      try { localStorage.setItem("devbench_story_actions_collapsed", next ? "1" : "0"); } catch {}
      return next;
    });
  }, []);

  const projectControlsBounds = useCallback(() => {
    const root = storyRootRef.current;
    const toggle = projectControlsToggleRef.current;
    if (!root || !toggle) return null;
    return {
      containerWidth: root.clientWidth,
      containerHeight: root.clientHeight,
      itemWidth: toggle.offsetWidth,
      itemHeight: toggle.offsetHeight,
    };
  }, []);

  const saveProjectControlsPosition = useCallback((position) => {
    if (!position) return;
    try {
      localStorage.setItem(projectControlsPositionKey, JSON.stringify(position));
    } catch {}
  }, [projectControlsPositionKey]);

  useEffect(() => {
    const root = storyRootRef.current;
    if (!root || typeof ResizeObserver === "undefined") return undefined;
    const keepPositionVisible = () => {
      const bounds = projectControlsBounds();
      if (!bounds) return;
      setProjectControlsPosition((current) => {
        if (!current) return current;
        const next = clampProjectControlsPosition(current, bounds);
        if (!next || (next.x === current.x && next.y === current.y)) return current;
        saveProjectControlsPosition(next);
        return next;
      });
    };
    const observer = new ResizeObserver(keepPositionVisible);
    observer.observe(root);
    if (projectControlsToggleRef.current) observer.observe(projectControlsToggleRef.current);
    keepPositionVisible();
    return () => observer.disconnect();
  }, [projectControlsBounds, saveProjectControlsPosition]);

  const startProjectControlsDrag = useCallback((event) => {
    if (!event.isPrimary || event.button !== 0) return;
    const root = storyRootRef.current;
    const toggle = projectControlsToggleRef.current;
    if (!root || !toggle) return;
    const rootRect = root.getBoundingClientRect();
    const toggleRect = toggle.getBoundingClientRect();
    suppressProjectControlsClickRef.current = false;
    projectControlsDragRef.current = {
      pointerId: event.pointerId,
      startPointerX: event.clientX,
      startPointerY: event.clientY,
      startX: toggleRect.left - rootRect.left,
      startY: toggleRect.top - rootRect.top,
      moved: false,
      lastPosition: null,
    };
    event.currentTarget.setPointerCapture?.(event.pointerId);
  }, []);

  const moveProjectControls = useCallback((event) => {
    const drag = projectControlsDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const deltaX = event.clientX - drag.startPointerX;
    const deltaY = event.clientY - drag.startPointerY;
    if (!drag.moved && Math.hypot(deltaX, deltaY) < 4) return;
    drag.moved = true;
    const bounds = projectControlsBounds();
    if (!bounds) return;
    const next = clampProjectControlsPosition({
      x: drag.startX + deltaX,
      y: drag.startY + deltaY,
    }, bounds);
    if (!next) return;
    drag.lastPosition = next;
    setProjectControlsPosition(next);
    event.preventDefault();
  }, [projectControlsBounds]);

  const endProjectControlsDrag = useCallback((event, cancelled = false) => {
    const drag = projectControlsDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    if (drag.moved && drag.lastPosition) {
      suppressProjectControlsClickRef.current = !cancelled;
      saveProjectControlsPosition(drag.lastPosition);
    }
    projectControlsDragRef.current = null;
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }, [saveProjectControlsPosition]);

  const toggleProjectControls = useCallback((event) => {
    if (suppressProjectControlsClickRef.current) {
      suppressProjectControlsClickRef.current = false;
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    // updater 取反保证快速连续点击也能正确翻转；落盘写入幂等，StrictMode 双调用 updater 时重复写无害。
    // tab.id 显式进依赖（StoryTab 以 key={active.id} 重建，id 实际不变，声明化避免隐式依赖）。
    setShowProjectControls((value) => {
      writeProjectControlsExpanded(tab.id, !value);
      return !value;
    });
  }, [tab.id]);

  const projectRefs = Array.isArray(tab.refs) && tab.refs.length
    ? tab.refs
    : (tab.worktree?.entries || [])
      .filter((entry) => entry && entry.role !== "inactive" && entry.active !== false)
      .map((entry) => ({
        role: entry.role,
        name: entry.name,
        path: entry.path || entry.worktreePath,
        branch: entry.branch || "",
      }));
  const primaryRef = projectRefs.find((r) => r.role === "primary") || null;
  const webRef = projectRefs.find((r) => r.role === "webapp") || null;
  const primaryProject = projects.find((p) => p.id === tab.primaryProjectId) || null;
  const worktreeDisplay = storyWorktreeDisplayPath(tab);
  const liveWorktreeBranch = branches.find((b) => b.role === "primary")?.branch
    || worktreeDisplay.branch;
  const partialManagedWorktree = !!tab.worktree?.managed
    && tab.worktreeStatus === "cleanup_partial"
    && (tab.worktree?.entries || []).length > 0;
  const activeManagedWorktree = !!tab.worktree?.managed
    && !partialManagedWorktree
    && (tab.worktree?.entries || []).length > 0;
  const cleanedManagedWorktree = !!tab.worktree?.managed
    && tab.worktreeStatus === "cleaned"
    && (tab.worktree?.cleanedEntries || []).length > 0;
  const primary = tab.worktree?.managed
    ? (primaryRef ? {
        id: tab.primaryProjectId || "",
        name: primaryRef.name || "主工程",
        path: primaryRef.path,
        webAppPath: webRef?.path || "",
      } : null)
    : primaryProject;
  const managedGitUpdateRepos = (Array.isArray(tab.worktree?.entries) ? tab.worktree.entries : [])
    .filter((entry) => entry && entry.role !== "inactive" && entry.active !== false)
    .map((entry) => ({
      role: entry.role || "extra",
      name: entry.name,
      path: entry.worktreePath || entry.path,
      worktreePath: entry.worktreePath || entry.path,
      basePath: entry.baseRepositoryPath || entry.basePath,
      branch: entry.branch || "",
      originalBranch: entry.originalBranch || entry.baseRef || "",
    }));
  const gitUpdateRepos = managedGitUpdateRepos.length ? managedGitUpdateRepos : (projectRefs.length ? projectRefs : [
    primary?.path ? { name: primary.name || "主工程", path: primary.path, role: "primary" } : null,
    primary?.webAppPath ? { name: `${primary.name || "主工程"}/WebApp`, path: primary.webAppPath, role: "webapp" } : null,
    ...(tab.extraProjects || []).map((repo) => ({ ...repo, role: "extra" })),
  ].filter(Boolean));
  useEffect(() => {
    if (!primary?.path) return;
    try {
      localStorage.setItem(RECORDING_CONTEXT_KEY, JSON.stringify({
        tabId: tab.id,
        root: primary.path,
        title: tab.title || "",
        updatedAt: Date.now(),
      }));
    } catch {}
  }, [tab.id, tab.title, primary?.path]);
  const localProjectCount = projectRefs.length || [
    primary?.path,
    primary?.webAppPath,
    ...(tab.extraProjects || []).map((e) => e.path),
  ].filter(Boolean).length;
  const streaming = !!live?.streaming;
  const worktreeMutationDisabled = worktreeMutationEntryDisabled({
    liveRunning: isRunning,
    persistedRunningTaskId: tab.runningTaskId,
  });
  const [clockNow, setClockNow] = useState(() => Date.now());
  useEffect(() => {
    if (!isRunning && !live?.streaming) return undefined;
    setClockNow(Date.now());
    const timer = setInterval(() => setClockNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [isRunning, live?.streaming]);
  // 当前 APK 产物来源路径：已设定则用之，否则默认主工程（用于高亮"设为APK产物"按钮的选中态）
  const apkSource = tab.apkSourcePath || primary?.path || "";
  const apkSourceLabel = (() => {
    if (!apkSource) return "";
    if (primary && norm(apkSource) === norm(primary.path)) return primary.name;
    const ex = projectRefs.find((e) => norm(e.path) === norm(apkSource))
      || (tab.extraProjects || []).find((e) => norm(e.path) === norm(apkSource));
    return ex ? (ex.name || ex.path) : apkSource;
  })();
  // 已确认没有 APK 产物（apkStatus 已加载且 hasApk=false）→ 置灰 📦 按钮；未知(null)时不置灰避免闪烁
  const noApk = apkStatus != null && !apkStatus.hasApk;

  // 加载各工程 git 分支
  const loadBranches = useCallback(async () => {
    setLoadingBranches(true);
    const r = await devbenchApi.getBranches(tab.id);
    if (r.ok) setBranches(r.data || []);
    setLoadingBranches(false);
  }, [tab.id]);

  // 基仓 ↔ worktree 分支对应关系
  const loadBranchPairs = useCallback(async () => {
    if (!tab.worktree?.managed) {
      setBranchPairs(null);
      return;
    }
    setLoadingBranchPairs(true);
    try {
      const r = await devbenchApi.inspectWorktreeBranchPairs(tab.id);
      if (r.ok) setBranchPairs(r.data);
    } finally {
      setLoadingBranchPairs(false);
    }
  }, [tab.id, tab.worktree?.managed]);

  // 加载各工程的 Android flavor 列表 + 当前选定
  const loadFlavors = useCallback(async () => {
    const r = await devbenchApi.getFlavors(tab.id);
    if (r.ok) setFlavors(r.data || []);
  }, [tab.id]);
  // 查询本故事点是否有 APK 产物（决定 📦 按钮是否置灰；编译成功后刷新）
  const loadApkStatus = useCallback(async () => {
    const r = await devbenchApi.apkStatus(tab.id);
    if (r.ok) setApkStatus(r.data);
  }, [tab.id]);

  // 工程集合变化（主工程/关联工程/worktree 路径与分支）或 APK 来源变化时刷新分支/flavor/APK 状态
  const refsKey = `${tab.mode || ""}|${tab.primaryProjectId || ""}|${(tab.extraProjects || []).map((e) => e.path).join(",")}|${(tab.remoteRepos || []).map((r) => `${r.path}:${r.ok ? 1 : 0}`).join(",")}|${(tab.worktree?.entries || []).map((e) => `${e.path || e.worktreePath}:${e.branch || ""}`).join(",")}|${tab.worktreeStatus || ""}`;
  useEffect(() => {
    loadBranches();
    loadBranchPairs();
    loadFlavors();
    loadApkStatus();
  }, [loadBranches, loadBranchPairs, loadFlavors, loadApkStatus, refsKey, tab.apkSourcePath]);
  // worktree 路径/分支变化时，同步刷新配置区「Git 分支」选择器（不能只依赖 primaryProjectId）
  useEffect(() => {
    setGitStatusVersion((v) => v + 1);
  }, [refsKey]);
  // 编译产物成功后自动刷新 APK 状态（命中工程数变化即重查），让 📦 按钮从置灰变可点
  const buildOkCount = build ? Object.values(build.byProject || {}).filter((p) => p.status === "ok").length : 0;
  useEffect(() => { if (buildOkCount > 0) loadApkStatus(); }, [buildOkCount, loadApkStatus]);
  // 「设为APK产物来源」后立刻按新来源刷新 📦 状态（不依赖 tab prop 回流时序）
  const handleSetApkSource = useCallback(async (p) => {
    await onSetApkSource?.(p);
    await loadApkStatus();
  }, [onSetApkSource, loadApkStatus]);
  // 手动刷新整个故事点状态（版本号/分支/flavor + tab 数据），无需浏览器 F5
  const [refreshing, setRefreshing] = useState(false);
  const refreshStatus = useCallback(async () => {
    setRefreshing(true);
    try {
      await Promise.all([loadBranches(), loadBranchPairs(), loadFlavors(), loadApkStatus()]);
      await onRefreshTab?.();
    } finally { setRefreshing(false); }
  }, [loadBranches, loadBranchPairs, loadFlavors, loadApkStatus, onRefreshTab]);
  const handleGitStateChanged = useCallback(async () => {
    setGitStatusVersion((v) => v + 1);
    await Promise.all([loadBranches(), loadBranchPairs(), loadFlavors(), loadApkStatus()]);
    await onRefreshTab?.();
  }, [loadBranches, loadBranchPairs, loadFlavors, loadApkStatus, onRefreshTab]);

  // 加载当前用户的 TB 工单（供关联工单下拉）；展开配置时刷新一次拿最新
  const reloadTickets = useCallback(() => devbenchApi.listTasks().then((r) => { if (r.ok) setTickets(r.data || []); }), []);
  useEffect(() => { reloadTickets(); }, [showConfig, reloadTickets]);
  useEffect(() => {
    window.addEventListener(DEVBENCH_TASKS_CHANGED_EVENT, reloadTickets);
    return () => window.removeEventListener(DEVBENCH_TASKS_CHANGED_EVENT, reloadTickets);
  }, [reloadTickets]);

  // 配置区展开或内部内容高度变化时，重新判断是否还能下滑（驱动"下滑查看更多"提示）
  useEffect(() => {
    if (!showConfig) { setCfgMore(false); return; }
    const sc = cfgScrollRef.current;
    if (!sc) return;
    measureCfgScroll();
    const ro = new ResizeObserver(measureCfgScroll);
    ro.observe(sc);
    if (cfgInnerRef.current) ro.observe(cfgInnerRef.current);
    return () => ro.disconnect();
  }, [showConfig, measureCfgScroll]);

  // 关联任务：保存（支持 TB链接 / CARB单号）；若解析为 TB 单且不在任务列表 → 弹窗问是否加入
  const [addTaskPrompt, setAddTaskPrompt] = useState(null); // { tbTaskId, carbId, title, ... }
  const committingTicketRef = useRef(false);
  async function commitTicket(value) {
    if (committingTicketRef.current) return;
    committingTicketRef.current = true;
    try {
      const r = await onSetTicket(String(value || "").trim());
      if (r && r.ok && r.resolved && r.resolved.isTb && !r.resolved.inTaskList) {
        setAddTaskPrompt(r.resolved);
      }
    } finally { committingTicketRef.current = false; }
  }
  async function confirmAddTask(yes) {
    const resolved = addTaskPrompt;
    setAddTaskPrompt(null);
    if (!yes || !resolved) return;
    const r = await devbenchApi.addTicketToTasks(tab.id, { title: resolved.title, carbId: resolved.carbId });
    if (r.ok) { onToast?.(r.already ? "该 TB 单已在任务列表中" : "已添加到任务列表"); reloadTickets(); }
    else onToast?.(r.error || "添加到任务列表失败");
  }

  // 选择/清除某工程的目标 flavor
  async function onSelectFlavor(path, flavor) {
    const r = await devbenchApi.setFlavor(tab.id, path, flavor);
    if (isWorktreeRebuildConfirmRequired(r)) {
      setWorktreeRebuild({
        title: "更新 Flavor 需删除旧 worktree 并重建",
        error: r.error,
        preview: r.data.preview,
        inspection: r.data.inspection,
        body: { path, flavor },
        retry: (body) => devbenchApi.setFlavor(tab.id, body.path, body.flavor, body),
      });
      return;
    }
    if (!r.ok) { onToast?.(r.error || "设置 flavor 失败"); return; }
    setGitStatusVersion((v) => v + 1);
    await Promise.all([loadBranches(), loadBranchPairs(), loadFlavors()]);
    onRefreshTab?.();
    onToast?.(flavor ? `目标 flavor 已设为 ${flavor}` : "已清除目标 flavor");
  }
  // 版本 +10：写回 gradle 并刷新显示
  const [versionPopup, setVersionPopup] = useState(null); // { path, name, versionName, versionCode }
  const [bumping, setBumping] = useState(false);
  async function doBumpVersion(path, op = "bump10") {
    setBumping(true);
    const r = await devbenchApi.bumpVersion(tab.id, path, op);
    setBumping(false);
    if (!r.ok) { onToast?.(r.error || "版本更新失败"); return; }
    await loadFlavors();
    onRefreshTab?.();
    const msgSync = r.data.commitMessages?.rewritten
      ? `；已同步 ${r.data.commitMessages.rewritten} 个未推送提交信息`
      : (r.data.commitMessages && !r.data.commitMessages.ok ? `；提交信息同步失败：${r.data.commitMessages.error || "unknown"}` : "");
    onToast?.(`版本已更新为 ${r.data.versionName} / ${r.data.versionCode}（改：${(r.data.files || []).join("、")}）${msgSync}`);
    setVersionPopup((p) => (p && norm(p.path) === norm(path) ? { ...p, versionName: r.data.versionName, versionCode: r.data.versionCode } : p));
  }
  // 关联 TB 单备注：富文本图文预览悬浮窗
  const isTbTicket = /task\/[0-9a-fA-F]{24}/.test(String(tab.ticketUrl || ""));
  const [notePopup, setNotePopup] = useState(null); // { loading, data, error, downloading, downloaded }
  const [attachPopup, setAttachPopup] = useState(false); // TB 附件列表悬浮窗
  async function openNotePopup() {
    setNotePopup({ loading: true });
    const r = await devbenchApi.getTbNote(tab.id);
    if (!r.ok) { setNotePopup({ error: r.error || "获取备注失败" }); return; }
    setNotePopup({ data: r.data });
  }
  async function doDownloadNote() {
    setNotePopup((p) => ({ ...p, downloading: true }));
    const r = await devbenchApi.downloadTbNote(tab.id);
    setNotePopup((p) => ({ ...p, downloading: false, downloaded: r.ok ? r.data : null, error: r.ok ? undefined : (r.error || "下载失败") }));
    if (r.ok) onToast?.(`备注已下载到 ${r.data.relDir}/note.md（${r.data.downloaded}/${r.data.imageCount} 图）`);
  }
  // 是否有任一工程正在打包（头部按钮闪烁/标“打包中”）
  const buildBusy = !!build && Object.values(build.byProject || {}).some((p) => p.status === "running" || p.status === "starting");
  // 主工程当前选定的 flavor + 版本（展开面板操作用）
  const primaryFlavorInfo = flavors.find((f) => norm(f.path) === norm(primary?.path || "")) || {};
  const primaryFlavor = primaryFlavorInfo.selected || "";
  const primaryVersion = primaryFlavorInfo.version || null;
  // 是否有任一 Android 工程（决定是否显示 flavor 配置区）
  const anyAndroid = flavors.some((f) => f.isAndroid);
  const isClientNode = !!centerConfig?.clientMode;
  const activeCenterHost = normalizeCenterHost(tab.centerHost || centerConfig?.selectedHost || "");
  const currentCenter = centerServers.find((s) => normalizeCenterHost(s.host) === activeCenterHost) || null;
  const centerSelectValue = tab.centerHost ? activeCenterHost : "__global__";
  const selectedEngine = tab.engine || "claude";
  const selectedModelTier = engineModelTier(engineMetadata, selectedEngine);
  const activeAiServiceLabel = isClientNode
    ? (activeCenterHost ? `AI服务器 ${currentCenter?.name || tab.centerName || (!tab.centerHost ? centerConfig?.selectedName : "") || activeCenterHost}` : "未选择AI服务器")
    : `${engineDisplayName(selectedEngine)} · ${selectedModelTier.model} · ${selectedModelTier.tier}`;
  const liveBase = live && !live.center && !isClientNode
    ? { ...live, center: { mode: "local", label: "本机" }, engine: live.engine || tab.engine || "claude" }
    : live;
  const runningEngine = liveBase?.engine || live?.engine || tab.engine || "claude";
  const runningModelTier = engineModelTier(engineMetadata, runningEngine);
  const liveForDisplay = liveBase ? {
    ...liveBase,
    aiSnapshot: liveBase.aiSnapshot || {
      engine: runningEngine,
      model: runningModelTier.modelConfigured ? runningModelTier.model : "",
      tier: runningModelTier.tierConfigured ? runningModelTier.tier : "",
      capturedAt: liveBase.startedAt || Date.now(),
    },
  } : liveBase;
  const inputRunStatus = storyRunStatusView({
    isRunning,
    live: liveForDisplay || live,
    engineLabel: engineDisplayName(runningEngine, runningEngine),
    model: runningModelTier.model,
    tier: runningModelTier.tier,
    timing: liveTimingText(liveForDisplay || live, clockNow),
    usage: usageText(liveForDisplay?.usage || live?.usage, runningEngine),
  });
  const inputRunStatusTone = {
    running: "bg-green-600/15 border-green-500/40 text-green-200",
    starting: "bg-sky-600/15 border-sky-500/40 text-sky-200",
    finalizing: "bg-blue-600/15 border-blue-500/40 text-blue-200",
    warning: "bg-amber-600/20 border-amber-500/50 text-amber-100",
    cancelling: "bg-orange-600/20 border-orange-500/50 text-orange-100",
    paused: "bg-amber-600/15 border-amber-500/40 text-amber-200",
    termination_unconfirmed: "bg-red-600/20 border-red-500/50 text-red-100",
    stopped: "bg-amber-600/15 border-amber-500/40 text-amber-200",
    stalled: "bg-amber-600/20 border-amber-500/50 text-amber-200",
    idle: "bg-zinc-800/60 border-zinc-700 text-zinc-400",
  }[inputRunStatus.state];
  const inputRunStatusDot = {
    running: "bg-green-400",
    starting: "bg-sky-400",
    finalizing: "bg-blue-400",
    warning: "bg-amber-300",
    cancelling: "bg-orange-300",
    paused: "bg-amber-400",
    termination_unconfirmed: "bg-red-400",
    stopped: "bg-amber-400",
    stalled: "bg-amber-400",
    idle: "bg-zinc-500",
  }[inputRunStatus.state];

  // 配置模式：本地工程 / 远程拉取。无本地工程可选(全被占用/为空)且未选主工程时，「本地工程」切不过去。
  const configMode = tab.mode === "remote" ? "remote" : "local";
  // 选定工程(projectDef)的本机本地源码（含 admin localPath + 已克隆记录），供复用
  const [localCheckouts, setLocalCheckouts] = useState([]);
  useEffect(() => {
    if (tab.projectDefId) devbenchApi.getProjectLocal(tab.projectDefId).then((r) => { if (r.ok) setLocalCheckouts(r.data || []); });
    else setLocalCheckouts([]);
  }, [tab.projectDefId]);
  const availLocalCount = (projects || []).filter((p) => p.exists).length;
  // 选了工程：本地可用性看该工程的本地源码；否则沿用旧的(全部本地工程是否有空闲)
  const localTabDisabled = tab.projectDefId
    ? (!tab.primaryProjectId && localCheckouts.length === 0)
    : (!tab.primaryProjectId && availLocalCount === 0);
  async function useLocalSource(co) {
    const r = await devbenchApi.setTabLocalSource(tab.id, co.path, co.name);
    if (r.ok) onRefreshTab?.(); else onToast?.(r.error || "选用本地源码失败");
  }
  async function switchConfigMode(m) {
    if (m === configMode || (m === "local" && localTabDisabled)) return;
    const r = await devbenchApi.setTabMode(tab.id, m);
    if (r.ok) onRefreshTab?.(); else onToast?.(r.error || "切换模式失败");
  }

  // 输入历史只在消息变化时重建，交由轻量输入组件处理补全与上下键导航。
  const inputHistory = useMemo(
    () => messages.filter((message) => message.role === "user").map((message) => message.content),
    [messages],
  );

  // 只有仍在跟随最新消息时才自动滚到底；用户主动离开底部后保留阅读位置。
  useEffect(() => {
    if (followLatestRef.current) {
      scrollConversationToBottom("auto");
      return;
    }
    if (scrollRef.current) setShowJumpToBottom(storyScrollStatus(scrollRef.current).showJumpToBottom);
  }, [messages, live, scrollConversationToBottom]);

  // 切换故事点时从最新消息开始，不能沿用上一个故事点的暂停跟随状态。
  useEffect(() => {
    followLatestRef.current = true;
    forceFollowRef.current = false;
    setShowJumpToBottom(false);
    scrollConversationToBottom("auto");
  }, [tab.id, scrollConversationToBottom]);

  // 工单地址保存后回填规范化结果（不会打断输入：仅在 tab.ticketUrl 真正变化时同步）
  useEffect(() => { setTicketDraft(looksLikeTicketUrl(tab.ticketUrl) ? (tab.ticketUrl || "") : ""); }, [tab.ticketUrl]);

  // 清空输入框：正文 + 本轮附件引用 + 引用；不会删除已经上传到故事点目录的磁盘副本。
  function clearInput() {
    const currentDraft = storyInputRef.current?.snapshot()?.value || "";
    if (!currentDraft.trim() && attachments.length === 0 && !replyTo) return;
    if (!confirm("清空当前输入框内容？（包括本轮附件和引用；附件磁盘副本会保留，但不会随消息发送）")) return;
    storyInputRef.current?.clear();
    attachments.forEach((a) => a.preview && URL.revokeObjectURL(a.preview));
    setAttachments([]);
    setReplyTo(null);
  }

  // 故事点组：在组里且不是当前活动 → 排队中，仅可查看/下载附件，不能与 AI 对话
  const queued = !!(tab.groupId && tab.groupActive === false);
  const pendingAiMessages = Array.isArray(tab.queue) ? tab.queue : [];
  const realtimeAppend = engineSupportsRealtimeAppend(tab.engine || "claude");

  // 标记当前版本：主工程提交 flavorConfig.json（flag:<flavor>_<版本>）+ 打 tag，WebApp 也打同名 tag
  async function markVersion(force = false) {
    if (marking) return;
    setMarking(true);
    const r = await devbenchApi.gitMarkVersion(tab.id, force);
    setMarking(false);
    if (r?.ok) {
      const tagged = (r.data || []).filter((x) => x.tagged).map((x) => x.name).join("、");
      const committed = (r.data || []).some((x) => x.committed);
      onToast?.(`已标记版本 ${r.tag}${committed ? "（已提交 flavorConfig.json）" : "（无改动，仅打 tag）"}：${tagged}`);
    } else if (r?.tagExists && !force) {
      if (window.confirm(`标签「${r.tag}」已存在。\n是否覆盖（git tag -f）？\n\n${r.error || ""}`)) markVersion(true);
    } else {
      onToast?.(r?.error || "标记版本失败");
    }
  }

  async function doCreatePr(paths = []) {
    if (creatingPr) return false;
    let prWindow = null;
    const electronRenderer = isEmbeddedElectron(window);
    if (!electronRenderer) {
      try {
        prWindow = window.open("about:blank", "_blank");
        if (prWindow) {
          prWindow.opener = null;
          prWindow.document.title = "Codeup 提PR";
          prWindow.document.body.style.cssText = "margin:0;background:#111827;color:#e5e7eb;font:14px system-ui;padding:24px;";
          prWindow.document.body.textContent = "正在准备 Codeup 合并请求...";
        }
      } catch {}
    }
    const openPrUrl = (url) => openPullRequestPage(url, {
      popupWindow: prWindow,
      openExternal: electronRenderer ? openExternal : null,
      openWindow: (target) => openPullRequestWindow(target, window),
    });
    setCreatingPr(true);
    try {
      const r = await devbenchApi.gitCreatePullRequest(tab.id, { paths });
      if (!r?.ok) {
        try { if (prWindow && !prWindow.closed) prWindow.close(); } catch {}
        const message = r?.error || "提 PR 失败";
        setPrNotice({ kind: "error", title: "提 PR 失败", message, operationId: r?.operationId || "" });
        onToast?.(message);
        await handleGitStateChanged();
        return;
      }
      const data = r.data || {};
      const results = Array.isArray(data.results) ? data.results : [];
      const summary = data.summary || {};
      // 优先打开主工程 MR 详情页，其次任意已创建 MR
      const primaryMr = results.find((x) => (x.role === "primary" || x.role === "standalone") && x.mergeRequest?.created);
      const anyMr = results.find((x) => x.mergeRequest?.created);
      const openTarget = primaryMr || anyMr || null;
      let opened = false;
      if (openTarget) {
        const prUrl = createdPullRequestUrl({ mergeRequest: openTarget.mergeRequest });
        const navigation = await openPrUrl(prUrl);
        opened = !!navigation.opened;
        if (!opened) { try { if (prWindow && !prWindow.closed) prWindow.close(); } catch {} }
      } else {
        try { if (prWindow && !prWindow.closed) prWindow.close(); } catch {}
      }
      const mrCreated = summary.mrCreated || 0;
      const hasFailure = (summary.failed || 0) > 0 || (summary.skipped || 0) > 0;
      let kind, title;
      if (mrCreated > 0 && !hasFailure) { kind = "success"; title = "PR 已创建"; }
      else if (mrCreated > 0 && hasFailure) { kind = "warning"; title = "部分工程 PR 已创建"; }
      else if ((summary.pushed || 0) > 0) { kind = "warning"; title = "分支已推送，MR 未创建"; }
      else { kind = "error"; title = "提 PR 失败"; }
      setPrNotice({
        kind,
        title,
        results,
        summary,
        operationId: r?.operationId || "",
        message: results.length ? "" : "没有可处理的工程",
      });
      onToast?.(`${title}：MR ${mrCreated}/${summary.total || results.length}，推送 ${summary.pushed || 0}/${summary.total || results.length}${opened ? "；已打开主工程 PR 页" : ""}`);
      await handleGitStateChanged();
    } catch (err) {
      try { if (prWindow && !prWindow.closed) prWindow.close(); } catch {}
      const message = `请求提 PR 失败：${err?.message || err}`;
      setPrNotice({ kind: "error", title: "提 PR 请求失败", message });
      onToast?.(message);
    } finally {
      try { if (prWindow && !prWindow.closed && prWindow.location.href === "about:blank") prWindow.close(); } catch {}
      setCreatingPr(false);
    }
  }

  async function downloadStoryBackup() {
    if (backingUpStory) return;
    setBackingUpStory(true);
    try {
      const r = await devbenchApi.storyBackup(tab.id);
      if (!r?.ok) { onToast?.(r?.error || "一键备份失败"); return; }
      const blobUrl = URL.createObjectURL(r.blob);
      const a = document.createElement("a");
      a.href = blobUrl;
      a.download = r.fileName || "story-backup.devbench-story.zip";
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(blobUrl);
      onToast?.(`已备份故事点「${tab.title}」（含对话 ${r.blob?.size || 0} 字节），下载完成`);
    } catch (e) {
      onToast?.(`一键备份失败：${e?.message || e}`);
    } finally {
      setBackingUpStory(false);
    }
  }

  async function doSend() {
    const draftSnapshot = storyInputRef.current?.snapshot() || { value: "", revision: 0 };
    const raw = String(draftSnapshot.value || "").trim();
    if ((!raw && attachments.length === 0) || sending) return;
    if (queued) { onToast?.("本故事点排队中：请先在「故事点组」里把它设为当前活动，再与 AI 对话"); return; }
    if (copying) { onToast?.("工程正在复制中，复制完成后再与 AI 对话"); return; }
    if (!tab.primaryProjectId) { onOpenStoryConfig?.(); return; }
    if (isClientNode && !activeCenterHost) { onToast?.("纯客户端模式请先选择 AI 服务器设备，不能使用当前设备的本机 AI"); return; }
    const sentReplyTo = replyTo;
    const sentAttachments = [...attachments];
    // AI 正在工作时不再拦截：支持运行中输入的 CLI 会实时追加到当前回合；
    // 其它接入方式或追加失败时由后端落入持久 FIFO 队列。
    // 1) 基础正文（无正文但有附件时给个默认请求）
    let body = raw || "请先解压并了解这些材料的内容，等待我的进一步提问。";
    // 2) 引用：被引用内容作为 markdown 引用块拼到正文前
    if (sentReplyTo) {
      const who = sentReplyTo.role === "user" ? "我之前说" : "AI 之前说";
      const quoted = (sentReplyTo.content || "").slice(0, 1500).replace(/\n/g, "\n> ");
      body = `> 【引用·${who}】\n> ${quoted}\n\n${body}`;
    }
    // 3) 本轮附件：结构化元数据负责消息 UI，受控 storydev:/ 引用负责 AI 实际读取。
    const text = buildStoryAttachmentPrompt(body, sentAttachments);
    const submission = storyInputRef.current?.beginSubmission(draftSnapshot);
    if (!submission) return;
    setSending(true);
    setReplyTo(null);
    setAttachments([]);
    const clearedDraftContextRevision = draftContextRevisionRef.current;
    const settleFailedDraft = () => {
      const contextUnchanged = draftContextRevisionRef.current === clearedDraftContextRevision;
      const settledDraft = storyInputRef.current?.settleSubmission(
        submission,
        false,
        { restoreOnFailure: contextUnchanged },
      );
      if (settledDraft?.restored) {
        setAttachments((current) => mergeStoryDraftAttachments(sentAttachments, current));
        setReplyTo((current) => current || sentReplyTo);
      }
      return settledDraft;
    };
    try {
      const result = await onSend(text, {
        displayContent: raw || "请先解压并了解这些材料的内容，等待我的进一步提问。",
        input: {
          text: raw || "请先解压并了解这些材料的内容，等待我的进一步提问。",
          replyToMessageId: sentReplyTo?.id || null,
          attachments: sentAttachments.map(({
            id,
            originalName,
            name,
            storageName,
            relPath,
            kind,
            fileCount,
            size,
            mime,
            isImg,
            source,
            scope,
          }) => ({
            id,
            originalName: originalName || name,
            name,
            storageName,
            relPath,
            kind: kind || "file",
            fileCount: Number(fileCount) || 0,
            size: Number(size) || 0,
            mime: mime || "",
            isImg: !!isImg,
            source: source || "upload",
            scope: scope || "message",
          })),
        },
      });
      const ok = result?.ok === true;
      const settledDraft = ok
        ? storyInputRef.current?.settleSubmission(submission, true)
        : settleFailedDraft();
      if (ok && !settledDraft) {
        try { localStorage.removeItem(draftKey); } catch {}
      }
      if (ok) {
        sentAttachments.forEach((attachment) => attachment.preview && URL.revokeObjectURL(attachment.preview));
      }
      return result;
    } catch (error) {
      const settledDraft = settleFailedDraft();
      onToast?.(settledDraft?.restored
        ? `发送失败，原文字已恢复：${error?.message || error}`
        : `发送失败；新草稿已保留，原文字可在失败消息中找回：${error?.message || error}`);
      return { ok: false, code: "SEND_CALLBACK_ERROR", error: String(error?.message || error) };
    } finally {
      setSending(false);
    }
  }

  function queuedMessageText(message) {
    if (typeof message === "string") return message;
    return String(message?.displayContent || message?.messageInput?.text || message?.content || "待发送消息");
  }

  async function retryBlockedQueueHead(message) {
    const requestId = String(message?.deviceRuntimeRequestId || "").trim();
    if (!requestId || queueAction) return;
    setQueueAction("retry");
    try {
      const result = await devbenchApi.retryBlockedQueueHead(tab.id, requestId);
      onToast?.(result?.ok ? "已重新加入设备派发队列" : (result?.error || "重试失败"));
      await onRefreshTab?.();
    } finally {
      setQueueAction("");
    }
  }

  async function cancelBlockedQueueHead(message) {
    const requestId = String(message?.deviceRuntimeRequestId || "").trim();
    if (!requestId || queueAction) return;
    setQueueAction("cancel");
    try {
      const result = await devbenchApi.cancelBlockedQueueHead(tab.id, requestId);
      onToast?.(result?.ok ? "已取消阻断的待发送消息" : (result?.error || "取消失败"));
      await onRefreshTab?.();
    } finally {
      setQueueAction("");
    }
  }

  async function startGitCommitReview() {
    if (reviewStartingRef.current || isRunning || copying || queued || !primary) return;
    reviewStartingRef.current = true;
    setReviewStarting(true);
    try {
      if (!onStartCodeReview) {
        onToast?.("代码评审专用工作流尚未就绪");
        return;
      }
      await onStartCodeReview();
    } finally {
      reviewStartingRef.current = false;
      setReviewStarting(false);
    }
  }

  async function doAddExtra() {
    const p = extraPath.trim();
    if (!p) return;
    const r = await onAddExtra(p, extraName.trim());
    if (r?.ok) { setExtraPath(""); setExtraName(""); }
  }

  const conversationMutationDisabled = isRunning || !!liveForDisplay?.streaming || pendingAiMessages.length > 0 || queued || copying;
  const conversationMutationDisabledReason = pendingAiMessages.length > 0
    ? "仍有消息排队，处理完成后才能编辑历史消息"
    : (isRunning || liveForDisplay?.streaming)
      ? "AI 正在运行，停止或等待完成后才能编辑历史消息"
      : copying
        ? "工程复制完成后才能编辑历史消息"
        : queued
          ? "当前故事点正在排队，设为活动故事点后才能编辑"
          : "";

  function openMessageMenu(messageId, pinned) {
    setMessageMenu({ id: messageId, pinned: !!pinned });
  }

  function closeMessageMenu(messageId) {
    setMessageMenu((current) => current.id === messageId ? { id: null, pinned: false } : current);
  }

  async function editAndResendMessage(messageId, content) {
    if (conversationMutationDisabled || !onEditAndResend) return { ok: false, error: conversationMutationDisabledReason || "当前不能编辑消息" };
    const result = await onEditAndResend(messageId, content, conversationRevision(conversation));
    if (result?.ok) {
      setEditingMessageId(null);
      setMessageMenu({ id: null, pinned: false });
    } else if (result?.error) onToast?.(result.error);
    return result;
  }

  async function selectConversationBranch(messageId) {
    if (!messageId || branchSwitchingId || conversationMutationDisabled || !onSelectConversationBranch) return;
    setBranchSwitchingId(messageId);
    try {
      const result = await onSelectConversationBranch(messageId, conversationRevision(conversation));
      if (!result?.ok && result?.error) onToast?.(result.error);
      else setMessageMenu({ id: null, pinned: false });
    } finally {
      setBranchSwitchingId(null);
    }
  }

  return (
    <div ref={storyRootRef} className="h-full flex flex-col relative">
      {/* 页面根层悬浮：工程面板展开不会改变定位参照；位置按故事点独立保存。 */}
      <button
        ref={projectControlsToggleRef}
        type="button"
        onClick={toggleProjectControls}
        onPointerDown={startProjectControlsDrag}
        onPointerMove={moveProjectControls}
        onPointerUp={endProjectControlsDrag}
        onPointerCancel={(event) => endProjectControlsDrag(event, true)}
        aria-label={showProjectControls ? "收起工程操作和 Git 分支" : "展开工程操作和 Git 分支"}
        aria-expanded={showProjectControls}
        data-state={showProjectControls ? "expanded" : "collapsed"}
        data-testid="project-controls-floating-toggle"
        data-story-id={tab.id}
        className={`absolute z-[45] flex h-11 w-[76px] touch-none select-none items-center justify-center gap-1.5 rounded-2xl border px-2 shadow-2xl backdrop-blur transition-[border-color,background-color,color,box-shadow] cursor-grab active:cursor-grabbing focus:outline-none focus:ring-2 focus:ring-cyan-400/60 ${
          showProjectControls
            ? "border-cyan-400 bg-cyan-600 text-white ring-2 ring-cyan-400/15"
            : "border-zinc-600/80 bg-zinc-900/95 text-zinc-200 hover:border-cyan-400/70 hover:bg-zinc-800 hover:text-white"
        }`}
        style={projectControlsPosition
          ? { left: `${projectControlsPosition.x}px`, top: `${projectControlsPosition.y}px` }
          : { right: "12px", top: "12px" }}
        title={`${showProjectControls ? "收起" : "展开"}工程操作和 Git 分支；可拖动调整本故事点中的位置`}
      >
        <span className="text-lg leading-none" data-testid="project-controls-floating-icon" aria-hidden>
          {showProjectControls ? "⊟" : "⊞"}
        </span>
        <span className="whitespace-nowrap text-[10px] font-medium leading-none" data-testid="project-controls-floating-label">
          {showProjectControls ? "收起工程" : "展开工程"}
        </span>
        <span className={`absolute right-1 top-1 h-1.5 w-1.5 rounded-full ${showProjectControls ? "bg-white" : "bg-cyan-400"}`} />
      </button>
      {/* 提交到主工程：预检(从哪->到哪 + 是否有可 rebase 提交) -> 确认 -> rebase 结果 */}
      {rebaseProgress && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/55 px-4" onClick={() => { if (rebaseProgress.status !== "running") onCloseRebase?.(); }}>
          <div className="bg-zinc-900 border border-emerald-700/50 rounded-xl shadow-2xl max-w-2xl w-full max-h-[82vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
            <div className="shrink-0 flex items-center justify-between px-4 py-3 border-b border-zinc-800">
              <span className="text-sm font-semibold text-emerald-300">🔀 提交到主工程</span>
              {rebaseProgress.status !== "running" && (
                <button onClick={onCloseRebase} className="text-zinc-400 hover:text-zinc-200 text-sm px-1">✕</button>
              )}
            </div>

            <div className="overflow-y-auto px-4 py-3">
              {/* 预检中 */}
              {rebaseProgress.status === "previewing" && (
                <div className="flex items-center gap-2 text-[12px] text-zinc-400 py-8 justify-center">
                  <span className="w-4 h-4 rounded-full border-2 border-zinc-600 border-t-emerald-400 animate-spin" />
                  <span>{rebaseProgress.step || "分析各工程 rebase 情况…"}</span>
                </div>
              )}

              {/* 预检结果：从->到 + 可 rebase 提交数 */}
              {rebaseProgress.status === "preview" && (() => {
                const items = rebaseProgress.preview?.data || [];
                const canRebase = items.filter((d) => d.canRebase).length;
                const blocked = items.filter((d) => d.blocked).length;
                return (
                  <div className="space-y-3">
                    <div className="text-[11px] text-zinc-500 leading-relaxed">
                      把各工程故事分支提交 rebase 到「原始分支」并快进原始分支（仅更新本地，不推送远程）。未提交改动会先自动提交。
                    </div>
                    <div className="text-[12px] text-zinc-300">
                      共 {items.length} 个工程 · <span className="text-emerald-400">{canRebase} 个可 rebase</span>
                      {blocked > 0 && <span className="text-amber-400"> · {blocked} 个预检未通过</span>}
                      {canRebase === 0 && blocked === 0 && <span className="text-zinc-500">（没有需要 rebase 的提交，无需执行）</span>}
                    </div>
                    <div className="space-y-2">
                      {items.map((d, i) => {
                        const ok = d.canRebase;
                        const blocked = !!d.blocked;
                        return (
                          <div key={i} className={`text-[12px] border rounded-lg p-2.5 ${ok ? "border-emerald-800/50 bg-emerald-950/15" : blocked ? "border-amber-800/50 bg-amber-950/15" : "border-zinc-800 bg-zinc-800/20"}`}>
                            <div className="flex items-center gap-2 flex-wrap">
                              <span className="font-medium text-zinc-100">{d.name}</span>
                              <span className="text-zinc-600">{d.role}</span>
                              <span className={`px-1.5 py-0.5 rounded text-[10px] ${ok ? "bg-emerald-700/40 text-emerald-200" : blocked ? "bg-amber-700/40 text-amber-200" : "bg-zinc-700/50 text-zinc-400"}`}>{ok ? "可 rebase" : blocked ? "预检未通过" : "无提交"}</span>
                            </div>
                            <div className="mt-1.5 flex items-center gap-1.5 flex-wrap text-[11px]">
                              <span className="font-mono text-amber-300 bg-zinc-950/60 px-1.5 py-0.5 rounded" title="故事分支（来源）">{d.storyBranch || "?"}</span>
                              <span className="text-emerald-400">rebase →</span>
                              <span className="font-mono text-cyan-300 bg-zinc-950/60 px-1.5 py-0.5 rounded" title="原始分支（目标）">{d.originalBranch || "?"}</span>
                            </div>
                            <div className="mt-1.5 text-[11px]">
                              {blocked
                                ? <span className="text-amber-300">无法确认可 rebase 提交，请先处理下方原因</span>
                                : (d.ahead ?? 0) > 0
                                ? <span className="text-emerald-300">领先 {d.ahead} 个提交{d.dirtyCount ? ` · 另有 ${d.dirtyCount} 个未提交改动` : ""}</span>
                                : (d.dirtyCount ? <span className="text-amber-300">{d.dirtyCount} 个未提交改动（将先提交再 rebase）</span> : <span className="text-zinc-500">无领先提交</span>)}
                            </div>
                            {d.reason && <div className="mt-1 text-[11px] text-zinc-500 break-all">{d.reason}</div>}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                );
              })()}

              {/* rebase 中 */}
              {rebaseProgress.status === "running" && (
                <div className="flex items-center gap-2 text-[12px] text-zinc-400 py-8 justify-center">
                  <span className="w-4 h-4 rounded-full border-2 border-zinc-600 border-t-emerald-400 animate-spin" />
                  <span>{rebaseProgress.step || "rebase 中…"}</span>
                </div>
              )}

              {/* 结果 */}
              {(rebaseProgress.status === "done" || rebaseProgress.status === "error") && (
                <div className="space-y-3">
                  {rebaseProgress.result?.summary && (
                    <div className="text-[12px] text-zinc-300">
                      成功 {rebaseProgress.result.summary.succeeded ?? 0} · 跳过 {rebaseProgress.result.summary.skipped ?? 0} · 冲突 {rebaseProgress.result.summary.conflicts ?? 0} · 失败 {rebaseProgress.result.summary.failed ?? 0}
                    </div>
                  )}
                  <div className="space-y-2">
                    {(rebaseProgress.result?.data || []).map((r, i) => {
                      const tag = r.conflict ? { t: "冲突", c: "text-amber-400" }
                        : r.skipped ? { t: "跳过", c: "text-zinc-500" }
                          : r.ok ? { t: r.fastForwarded ? "已快进" : "已是最新", c: "text-emerald-400" }
                            : { t: "失败", c: "text-red-400" };
                      return (
                        <div key={i} className="text-[12px] border border-zinc-800 rounded-lg p-2.5">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="font-medium text-zinc-100">{r.name}</span>
                            <span className="text-zinc-600">{r.role}</span>
                            <span className={tag.c}>{tag.t}</span>
                            {r.dirtyCommitted && <span className="text-zinc-500">· 已自动提交改动</span>}
                          </div>
                          <div className="text-zinc-500 mt-1 break-all">原始分支：{r.originalBranch || "-"} · 故事分支：{r.storyBranch || "-"}</div>
                          {r.conflictFiles?.length > 0 && (
                            <div className="text-amber-300 mt-1 break-all">冲突文件：{r.conflictFiles.join("、")}</div>
                          )}
                          {r.reason && <div className="text-zinc-500 mt-1 break-all">{r.reason}</div>}
                          {r.error && <div className="text-red-300 mt-1 break-all">{r.error}</div>}
                          {r.warning && <div className="text-amber-300 mt-1 break-all">{r.warning}</div>}
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>

            {/* footer */}
            <div className="shrink-0 flex justify-end gap-2 px-4 py-3 border-t border-zinc-800">
              {rebaseProgress.status === "preview" && (
                <>
                  <button onClick={onCloseRebase} className="text-[12px] px-3 py-1.5 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-200 border border-zinc-700">取消</button>
                  <button
                    onClick={onConfirmRebase}
                    disabled={!(rebaseProgress.preview?.data || []).some((d) => d.canRebase)}
                    className="text-[12px] px-3 py-1.5 rounded bg-emerald-600 hover:bg-emerald-500 text-white border border-emerald-500 disabled:opacity-40 disabled:cursor-not-allowed"
                  >确认 rebase</button>
                </>
              )}
              {(rebaseProgress.status === "done" || rebaseProgress.status === "error") && (
                <button onClick={onCloseRebase} className="text-[12px] px-3 py-1.5 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-200 border border-zinc-700">关闭</button>
              )}
            </div>
          </div>
        </div>
      )}
      {/* 发布生产进度悬浮窗（居中本故事点，不全屏遮挡，按 tab 独立，不影响其它故事点） */}
      {publishProgress && (
        <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 z-40 w-[420px] max-w-[90%] bg-zinc-900/95 border border-indigo-700/60 rounded-xl shadow-2xl px-5 py-4 backdrop-blur">
          <div className="flex items-center gap-2 mb-2">
            <span className="text-sm font-semibold text-indigo-300">🚀 发布生产</span>
            {publishProgress.status === "running" && <span className="w-2 h-2 rounded-full bg-green-500 animate-pulse" />}
            {publishProgress.status === "await_resign" && <span className="text-amber-300 text-xs">等待二次签名</span>}
            {publishProgress.status === "need_share_login" && <span className="text-amber-300 text-xs">需要共享登录</span>}
            {publishProgress.status === "done" && <span className="text-emerald-400 text-xs">✓ 完成</span>}
            {publishProgress.status === "error" && <span className="text-red-400 text-xs">✗ 失败</span>}
            {(publishProgress.status === "done" || publishProgress.status === "error" || publishProgress.status === "await_resign" || publishProgress.status === "need_share_login") && (
              <button onClick={onClosePublish} className="ml-auto text-zinc-500 hover:text-zinc-200 text-lg leading-none">×</button>
            )}
          </div>
          <div className="text-[12px] text-zinc-300 break-all">{publishProgress.step || "处理中…"}</div>
          {publishProgress.status === "await_resign" && (
            <div className="mt-3 space-y-3">
              <div className="rounded-lg border border-amber-700/50 bg-amber-950/25 px-3 py-2 text-[12px] text-amber-100">
                当前车型包需要二次签名。请先对下面的 release APK 完成签名，再把签名后的 APK 所在目录拖入下方区域，或点击选择目录上传。
              </div>
              <div className="text-[11px] text-zinc-400 space-y-1">
                <div>未签名产物：<span className="text-zinc-200 break-all">{publishProgress.unsignedApk || "—"}</span></div>
                <div>产物目录：<span className="text-zinc-500 break-all">{publishProgress.apkDir || "—"}</span></div>
                <div>目标生产目录：<span className="text-zinc-500 break-all">{publishProgress.prodDir || "—"}</span></div>
                {publishProgress.expectedFingerprint && (
                  <div>期望 SHA256：<span className="font-mono text-[10px] text-emerald-300 break-all">{publishProgress.expectedFingerprint}</span></div>
                )}
              </div>
              <div className="flex gap-2">
                <button
                  onClick={() => onOpenApk?.()}
                  className="text-[12px] px-3 py-1.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-200 border border-zinc-700 transition"
                >📂 打开 APK 产物目录</button>
                <button
                  onClick={() => resignInputRef.current?.click()}
                  disabled={resignUploading}
                  className={`text-[12px] px-3 py-1.5 rounded-lg border transition ${resignUploading ? "bg-zinc-800 text-zinc-500 border-zinc-700 cursor-wait" : "bg-amber-700/40 hover:bg-amber-600/50 text-amber-100 border-amber-600/60"}`}
                >{resignUploading ? "上传校验中…" : "选择二签 APK 目录"}</button>
              </div>
              <div
                onDragOver={(e) => { e.preventDefault(); setResignDragOver(true); }}
                onDragLeave={() => setResignDragOver(false)}
                onDrop={handleResignDrop}
                onClick={() => resignInputRef.current?.click()}
                className={`rounded-xl border border-dashed px-4 py-6 text-center cursor-pointer transition ${
                  resignDragOver ? "border-amber-400 bg-amber-500/10" : "border-zinc-700 bg-zinc-950/40 hover:border-amber-600/70 hover:bg-amber-950/10"
                }`}
              >
                <div className="text-[13px] text-zinc-200">拖拽二次签名后的 APK 目录到这里</div>
                <div className="mt-1 text-[11px] text-zinc-500">也可以点击选择目录；系统会自动寻找目录中的 .apk，读取证书 SHA256 并校验</div>
              </div>
              <input
                ref={resignInputRef}
                type="file"
                multiple
                webkitdirectory=""
                directory=""
                className="hidden"
                onChange={(e) => uploadResignedApkFromFiles(e.target.files)}
              />
              {(resignError || publishProgress.uploadError) && (
                <div className="text-[11px] text-red-300 whitespace-pre-wrap break-all">{resignError || publishProgress.uploadError}</div>
              )}
            </div>
          )}
          {publishProgress.status === "need_share_login" && (
            <form onSubmit={submitShareLogin} className="mt-3 space-y-3">
              <div className="rounded-lg border border-amber-700/50 bg-amber-950/25 px-3 py-2 text-[12px] text-amber-100">
                当前 Windows 网关无法访问生产发布共享目录。请输入共享目录账号，登录成功后会继续本次发布。
              </div>
              <div className="text-[11px] text-zinc-400 space-y-1">
                <div>共享目录：<span className="font-mono text-zinc-200 break-all">{publishProgress.shareRoot || "—"}</span></div>
                <div>目标目录：<span className="text-zinc-500 break-all">{publishProgress.prodDir || "—"}</span></div>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                <input
                  value={shareDomain}
                  onChange={(e) => setShareDomain(e.target.value)}
                  disabled={shareLoggingIn}
                  placeholder="域（可选）"
                  className="bg-zinc-950 border border-zinc-700 rounded-lg px-3 py-2 text-[12px] text-zinc-100 outline-none focus:border-amber-500"
                />
                <input
                  value={shareUsername}
                  onChange={(e) => setShareUsername(e.target.value)}
                  disabled={shareLoggingIn}
                  placeholder="账号"
                  autoComplete="username"
                  className="bg-zinc-950 border border-zinc-700 rounded-lg px-3 py-2 text-[12px] text-zinc-100 outline-none focus:border-amber-500"
                />
                <input
                  value={sharePassword}
                  onChange={(e) => setSharePassword(e.target.value)}
                  disabled={shareLoggingIn}
                  placeholder="密码"
                  type="password"
                  autoComplete="current-password"
                  className="bg-zinc-950 border border-zinc-700 rounded-lg px-3 py-2 text-[12px] text-zinc-100 outline-none focus:border-amber-500"
                />
              </div>
              <div className="flex justify-end">
                <button
                  type="submit"
                  disabled={shareLoggingIn}
                  className={`text-[12px] px-3 py-1.5 rounded-lg border transition ${shareLoggingIn ? "bg-zinc-800 text-zinc-500 border-zinc-700 cursor-wait" : "bg-amber-700/40 hover:bg-amber-600/50 text-amber-100 border-amber-600/60"}`}
                >{shareLoggingIn ? "登录中…" : "登录并继续发布"}</button>
              </div>
              {(shareLoginError || publishProgress.shareError || publishProgress.error) && (
                <div className="text-[11px] text-red-300 whitespace-pre-wrap break-all">{shareLoginError || publishProgress.shareError || publishProgress.error}</div>
              )}
            </form>
          )}
          {publishProgress.phase === "copy" && publishProgress.pct != null && (
            <div className="mt-2">
              <div className="h-2 rounded bg-zinc-800 overflow-hidden">
                <div className="h-full bg-indigo-500 transition-all" style={{ width: `${publishProgress.pct}%` }} />
              </div>
              <div className="text-[10px] text-zinc-500 mt-1 text-right">{publishProgress.pct}%</div>
            </div>
          )}
          {publishProgress.status === "running" && publishProgress.phase !== "copy" && (
            <div className="mt-2 h-2 rounded bg-zinc-800 overflow-hidden"><div className="h-full bg-indigo-500/60 animate-pulse" style={{ width: "100%" }} /></div>
          )}
          {publishProgress.status === "done" && publishProgress.result && (
            <div className="mt-2 text-[11px] text-zinc-400 space-y-0.5">
              <div>{publishProgress.result.appName} <b className="text-zinc-200">{publishProgress.result.version}</b></div>
              <div className="break-all text-zinc-500">{publishProgress.result.prodDir}</div>
              <div className="text-emerald-300/90">钉钉：{publishProgress.result.dingtalk}</div>
            </div>
          )}
          {publishProgress.status === "error" && (
            <div className="mt-2 text-[11px] text-red-300/90 whitespace-pre-wrap break-all">{publishProgress.error}</div>
          )}
        </div>
      )}
      {/* 钉钉消息确认弹窗：发布生产产物就绪后弹出，用户可预览/编辑消息，确认后再发送 */}
      {dingtalkConfirm && (
        <DingtalkConfirmModal
          draftMessage={dingtalkConfirm.draftMessage}
          atNames={dingtalkConfirm.atNames}
          onSend={(msg) => onConfirmDingtalk(msg)}
          onCancel={onCancelDingtalk}
        />
      )}

      {/* 复制工程中：进度条 + 锁定提示（不可对话/编辑/下载附件） */}
      {copying && (
        <div className="shrink-0 px-4 py-2.5 border-b border-blue-800/50 bg-blue-950/30 space-y-1.5">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="w-2 h-2 rounded-full bg-blue-400 animate-pulse" />
            <span className="text-[11px] text-blue-200">
              {copyProgress?.phase === "counting" ? "正在统计工程文件数…" : "正在复制工程到指定目录…"}
              {copyProgress?.total ? `（${copyProgress.copied || 0}/${copyProgress.total}）` : ""}
            </span>
            <span className="text-[10px] text-zinc-500 truncate flex-1" title={copyProgress?.file || ""}>{copyProgress?.file || ""}</span>
            <span className="text-[10px] text-amber-300">复制期间不可对话 / 编辑 / 下载附件</span>
          </div>
          <div className="h-1.5 rounded bg-zinc-800 overflow-hidden">
            <div className="h-full bg-blue-500 transition-all" style={{ width: copyProgress?.total ? `${Math.min(100, Math.round((copyProgress.copied || 0) / copyProgress.total * 100))}%` : "8%" }} />
          </div>
        </div>
      )}

      {(backgroundInitializing || backgroundInitializationFailed) && (
        <div
          role={backgroundInitializationFailed ? "alert" : "status"}
          className={`shrink-0 space-y-2 border-b px-4 py-3 ${backgroundInitializationFailed
            ? "devbench-status-banner devbench-status-banner--danger"
            : "devbench-status-banner devbench-status-banner--info"}`}
          data-testid="story-workspace-initialization-progress"
          data-initialization-kind={remoteInitializing || remoteInitializationFailed ? "remote" : "local"}
        >
          <div className="flex flex-wrap items-center gap-2">
            <span className={`h-2.5 w-2.5 rounded-full ${backgroundInitializationFailed ? "bg-red-400" : "animate-pulse bg-cyan-300"}`} />
            <span className={`text-[11px] font-semibold ${backgroundInitializationFailed ? "text-red-100" : "text-cyan-100"}`}>
              {backgroundInitializationFailed
                ? (remoteInitializationFailed ? "远程源码后台初始化失败" : "后台初始化失败")
                : (remoteInitializing ? "正在后台初始化远程源码" : "正在后台初始化故事点工作区")}
            </span>
            <span className="min-w-0 flex-1 truncate text-[10px] text-zinc-400">
              {backgroundInitializationFailed
                ? remoteInitializationFailed
                  ? remoteSourceInitialization?.error || tab.cloneError || "远程源码初始化失败"
                  : workspaceInitialization?.error || tab.worktreeError || "未知错误"
                : remoteInitializing
                  ? tab.cloneStatus === "queued"
                    ? "任务已进入队列，即将克隆源码并创建独立 worktree…"
                    : `正在克隆和准备源码${remoteCloneRows.length ? `（${remoteCloneRows.length} 个仓库）` : ""}；完成前开发操作保持锁定。`
                : workspaceInitialization.stage === "binding_device"
                  ? "独立 worktree 已准备，正在绑定目标设备…"
                  : workspaceInitialization.status === "queued"
                    ? "任务已进入队列，即将创建独立 worktree…"
                    : "正在创建独立 worktree；你已经可以查看故事点页面，完成前开发操作保持锁定。"}
            </span>
            {backgroundInitializationFailed ? (
              <button
                type="button"
                disabled={retryingWorkspaceInitialization}
                onClick={async () => {
                  setRetryingWorkspaceInitialization(true);
                  try {
                    const result = remoteInitializationFailed
                      ? await devbenchApi.remoteInit(tab.id)
                      : await devbenchApi.retryStoryWorkspaceInitialization(tab.id);
                    if (!result?.ok) onToast?.(result?.error || "重试后台初始化失败");
                    else onToast?.(remoteInitializationFailed ? "已重新提交远程源码初始化" : "已重新提交工作区初始化");
                    await onRefreshTab?.();
                  } finally {
                    setRetryingWorkspaceInitialization(false);
                  }
                }}
                className="rounded-lg border border-red-500/45 bg-red-900/35 px-3 py-1.5 text-[10px] font-medium text-red-100 transition hover:bg-red-800/55 disabled:cursor-wait disabled:opacity-45"
                data-testid="story-workspace-initialization-retry"
              >{retryingWorkspaceInitialization ? "正在重试…" : "重试初始化"}</button>
            ) : null}
          </div>
          {!backgroundInitializationFailed ? (
            <div className="h-1.5 overflow-hidden rounded-full bg-zinc-900">
              <div
                className="h-full rounded-full bg-gradient-to-r from-cyan-400 via-blue-400 to-violet-400 transition-all duration-500"
                style={{ width: `${Math.max(5, Math.min(100, remoteInitializing ? remoteProgress : Number(workspaceInitialization?.progress) || 5))}%` }}
              />
            </div>
          ) : null}
        </div>
      )}

      {/* 故事点组：排队中横幅（仅可看/下附件，不能聊天） */}
      {queued && (
        <div className="shrink-0 px-4 py-2 border-b border-amber-800/50 bg-amber-950/30 flex items-center gap-2 flex-wrap">
          <span className="text-[11px] text-amber-200">🕒 排队中：本故事点与组内其它单共用工程，当前不是活动单 → 仅可查看 / 下载附件，<b>不能与 AI 对话</b>。</span>
          <button onClick={async () => { const r = await devbenchApi.groupSetActive(tab.id); if (r.ok) { onToast?.("已设为当前活动，可开始开发"); onRefreshTab?.(); } else onToast?.(r.error || "切换失败"); }}
            className="text-[11px] px-2.5 py-1 rounded bg-emerald-600 hover:bg-emerald-500 text-white transition">▶ 设为当前活动开始开发</button>
          <button onClick={() => onOpenGroup?.()} className="text-[11px] px-2 py-1 rounded bg-zinc-800 border border-zinc-700 text-zinc-300 hover:text-white">查看组</button>
        </div>
      )}

      {/* TB 工作流常驻状态条：阶段 + AI 是否在自动执行 + 半/全自动 + 手动甄别入口 */}
      <WorkflowStatusBar tab={tab} messages={messages} isRunning={isRunning} primary={primary}
        onStartFix={startFix}
        onStartTriage={onStartTriage} onSetAutoMode={onSetAutoMode} onSetSkipTestAcceptance={onSetSkipTestAcceptance} onMarkFixed={onMarkFixed}
        onStartVerify={onStartVerify} onStartReport={onStartReport} onRetryTbSync={onRetryTbSync} />

      {tab.reviewContext?.kind === "git_commit" && (() => {
        const review = tab.reviewContext;
        const inference = review.inference || {};
        const changedFileNames = (review.changedFiles || []).map((file) => file.path).filter(Boolean);
        const reviewWorkflow = tab.reviewWorkflow || {};
        const reviewPhase = reviewWorkflow.phase || "ready";
        const reviewBusy = reviewPhase === "reviewing" || reviewPhase === "rendering";
        const phaseMeta = {
          ready: { label: "待开始", cls: "border-zinc-600 bg-zinc-800/70 text-zinc-300" },
          reviewing: { label: "专家评审中", cls: "border-violet-500/50 bg-violet-500/15 text-violet-200" },
          rendering: { label: "生成 PDF/PNG", cls: "border-cyan-500/50 bg-cyan-500/15 text-cyan-200" },
          completed: { label: "报告已生成", cls: "border-emerald-500/50 bg-emerald-500/15 text-emerald-200" },
          blocked: { label: "报告生成受阻", cls: "border-amber-500/50 bg-amber-500/15 text-amber-200" },
        }[reviewPhase] || { label: reviewPhase, cls: "border-zinc-600 bg-zinc-800/70 text-zinc-300" };
        const artifactLabels = {
          original: "原始结论 TXT",
          html: "完整报告 HTML",
          pdf: "完整报告 PDF",
          image: "钉钉摘要 PNG",
          manifest: "产物清单",
        };
        const artifacts = Object.entries(reviewWorkflow.artifacts || {})
          .filter(([, artifact]) => artifact?.rel);
        return (
          <div
            className="shrink-0 border-b devbench-status-banner devbench-status-banner--info px-4 py-2.5"
            data-testid="git-commit-review-banner"
          >
            <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
              <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border border-violet-400/25 bg-violet-500/10 font-mono text-[9px] font-semibold text-violet-100">&lt;/&gt;</span>
              <span className="min-w-0 flex-1">
                <span className="flex flex-wrap items-center gap-2">
                  <span className="font-mono text-[11px] font-semibold text-violet-200">{review.shortRevision || String(review.revision || "").slice(0, 12)}</span>
                  <span className="max-w-[560px] truncate text-[11px] text-zinc-300" title={review.subject || ""}>{review.subject || "Git commit 评审"}</span>
                  <span className="rounded-full border border-emerald-500/20 bg-emerald-500/10 px-2 py-0.5 text-[9px] text-emerald-300">只读评审</span>
                  <span className={`rounded-full border px-2 py-0.5 text-[9px] ${phaseMeta.cls}`}>{phaseMeta.label}</span>
                </span>
                <span className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[10px] text-zinc-500">
                  <span>{review.repositoryName || review.repositoryId}</span>
                  {inference.branch && <span>分支 <b className="font-mono font-normal text-cyan-300">{inference.branch}</b></span>}
                  {inference.vehicle && <span>车型 <b className="font-normal text-fuchsia-300">{inference.vehicle}</b></span>}
                  {inference.flavor && <span>Flavor <b className="font-mono font-normal text-amber-300">{inference.flavor}</b></span>}
                  {review.stats?.files != null && (
                    <span title={changedFileNames.join("\n")}>
                      {review.stats.files} 文件 · +{review.stats.additions || 0} / -{review.stats.deletions || 0}
                    </span>
                  )}
                  {inference.dependencies?.length > 0 && <span>依赖 {inference.dependencies.map((item) => item.repositoryName || item.repositoryId).join("、")}</span>}
                </span>
              </span>
              <button
                type="button"
                onClick={startGitCommitReview}
                disabled={reviewStarting || isRunning || reviewBusy || copying || queued || !primary}
                title={!primary
                  ? "评审工程尚未就绪"
                  : (reviewPhase === "rendering"
                    ? "评审已完成，正在生成 PDF/PNG 交付物"
                    : (isRunning || reviewPhase === "reviewing"
                      ? "AI 正在执行只读代码评审"
                      : "读取真实 commit diff，并复核对应分支最新代码是否已修复"))}
                className="shrink-0 rounded-lg border border-violet-300/35 bg-gradient-to-r from-violet-600/80 to-fuchsia-600/75 px-3 py-1.5 text-[10px] font-medium text-white shadow-lg shadow-violet-950/35 transition hover:from-violet-500 hover:to-fuchsia-500 disabled:cursor-not-allowed disabled:border-zinc-700 disabled:from-zinc-800 disabled:to-zinc-800 disabled:text-zinc-500 disabled:shadow-none"
                data-testid="git-commit-review-start"
              >
                {reviewStarting || isRunning || reviewPhase === "reviewing"
                  ? "评审进行中…"
                  : reviewPhase === "rendering"
                    ? "报告生成中…"
                    : reviewPhase === "completed"
                      ? "重新评审并生成报告"
                      : reviewPhase === "blocked"
                        ? "重新评审"
                        : "开始评审代码"}
              </button>
              <span className="hidden items-center gap-1.5 text-[9px] text-zinc-500 lg:flex">
                <span className="rounded border border-zinc-700 bg-zinc-900/70 px-1.5 py-1">Code Review</span>
                <span className="rounded border border-zinc-700 bg-zinc-900/70 px-1.5 py-1">静态检查</span>
                <span className="rounded border border-zinc-700 bg-zinc-900/70 px-1.5 py-1">跨 Flavor</span>
                <span className="rounded border border-zinc-700 bg-zinc-900/70 px-1.5 py-1">合并风险</span>
                <span className="rounded border border-emerald-700/60 bg-emerald-950/30 px-1.5 py-1 text-emerald-300">最新分支复核</span>
              </span>
            </div>
            <div className="mt-2 flex flex-wrap items-center gap-1.5 border-t border-white/5 pt-2 text-[9px] text-zinc-500">
              {["冻结基线", "只读审查", "静态验证", "专家报告", "PDF / PNG"].map((step, index) => (
                <React.Fragment key={step}>
                  {index > 0 && <span className="text-zinc-700">→</span>}
                  <span className={index === 4 && reviewPhase === "completed" ? "text-emerald-300" : ""}>{step}</span>
                </React.Fragment>
              ))}
              {reviewWorkflow.verdict?.label && (
                <span className="ml-1 rounded border border-amber-500/30 bg-amber-950/30 px-2 py-0.5 text-amber-200">
                  合入建议：{reviewWorkflow.verdict.label}
                </span>
              )}
              {reviewWorkflow.reportError && (
                <span className="min-w-0 flex-1 truncate text-amber-300" title={reviewWorkflow.reportError}>
                  {reviewWorkflow.reportError}
                </span>
              )}
              {artifacts.length > 0 && (
                <span className="ml-auto flex min-w-0 flex-wrap items-center justify-end gap-1.5">
                  {artifacts.map(([key, artifact]) => (
                    <StoryArtifactLink
                      key={`${key}:${artifact.rel}`}
                      tabId={tab.id}
                      artifact={artifact}
                      label={artifactLabels[key] || artifact.name || key}
                      onToast={onToast}
                      compact
                    />
                  ))}
                </span>
              )}
            </div>
          </div>
        );
      })()}

      {/* ===== 工程 / Git 展开面板：工作流栏下方内联展开，撑开下方内容 ===== */}
      {showProjectControls && (
        <div className="shrink-0 overflow-visible border-b border-zinc-800 bg-zinc-900/95">
        <div className="px-4 py-2 flex flex-nowrap items-start justify-between gap-x-3 gap-y-2">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 min-w-0 flex-1">
            {/* 📋(复制故事点名字) + ✎▾(编辑菜单) 与绿色路径 chip 绑成一个不换行的子组：路径 chip 永远紧贴其右侧。重命名通过编辑菜单触发，打开独立悬浮窗编辑（名字较长不再拥挤） */}
            <span className="flex items-center gap-1.5 min-w-0">
              <CopyNameBtn name={tab.title} onToast={onToast} className="text-[11px]" />
              <EditMenuBtn onRename={() => { setTitleDraft(tab.title); setEditingTitle(true); }} primaryPath={primary?.path} className="text-[11px]" />
            {primary ? (
              <span className="flex flex-wrap items-center gap-1.5 min-w-0">
                <CopyPathBtn path={primary.path} onToast={onToast} />
                <CopyAllPathsBtn primary={primary} extraProjects={tab.extraProjects} onToast={onToast} />
                <button
                  onClick={() => { if (!noApk) onOpenApk(); }}
                  disabled={noApk}
                  className={`text-[11px] px-1.5 py-0.5 rounded border transition shrink-0 ${noApk ? "bg-zinc-800/40 text-zinc-600 border-zinc-700/60 cursor-not-allowed" : "bg-amber-700/30 hover:bg-amber-600/40 text-amber-200 border-amber-700/40"}`}
                  title={noApk
                    ? "暂无 APK 产物：先用「🔨 编译产物」打包（成功后此处会自动变可点）"
                    : `打开 APK 产物目录${apkSourceLabel ? `（来源：${apkSourceLabel}` : ""}${apkStatus?.project ? ` · 命中工程：${apkStatus.project}` : ""}${apkSourceLabel ? "）" : ""}`}
                >📦 APK产物</button>
                <button
                  onClick={() => setShowBuild(true)}
                  className={`text-[11px] px-1.5 py-0.5 rounded border transition shrink-0 ${buildBusy ? "bg-amber-600/40 text-amber-100 border-amber-500/60 animate-pulse" : "bg-amber-700/30 hover:bg-amber-600/40 text-amber-200 border-amber-700/40"}`}
                  title="编译产物：每个 Android 工程各自选 flavor + Debug/Release 后点该工程的「打包」，弹出类 Android Studio 的实时 gradle 日志（可分别停止）"
                >🔨 {buildBusy ? "打包中…" : "编译产物"}</button>
                <button
                  onClick={onRebaseToOriginal}
                  disabled={rebaseProgress?.status === "running" || rebaseProgress?.status === "previewing"}
                  className={`text-[11px] px-1.5 py-0.5 rounded border transition shrink-0 ${(rebaseProgress?.status === "running" || rebaseProgress?.status === "previewing") ? "bg-emerald-600/40 text-emerald-100 border-emerald-500/60 animate-pulse" : "bg-emerald-700/30 hover:bg-emerald-600/40 text-emerald-200 border-emerald-700/40"}`}
                  title="提交到主工程：先预检各工程从故事分支 rebase 到原始分支的情况，确认后再执行（仅更新本地，不推送远程）。"
                >{(rebaseProgress?.status === "running" || rebaseProgress?.status === "previewing") ? "rebase中…" : "🔀 提交到主工程"}</button>
                <button
                  onClick={onPublishProd}
                  className="text-[11px] px-1.5 py-0.5 rounded bg-rose-700/30 hover:bg-rose-600/40 text-rose-200 border border-rose-700/40 transition shrink-0"
                  title="发布生产：把 prod release 包 + mapping 压缩包复制到该车型「生产发布目录」，更新 ReadMe.txt 并钉钉通知（需先在「车型源码配置」设置该车型的生产发布目录）"
                >🚀 发布生产</button>
                <button
                  onClick={() => onOpenProdDir?.()}
                  className="text-[11px] px-1.5 py-0.5 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-200 border border-zinc-700 transition shrink-0"
                  title="打开该车型当前生产发布目录（与发布生产使用同一套日期目录规则）"
                >📂 发布目录</button>
                <StudioBtn path={primary.path} onToast={onToast} />
                {isTbTicket && (
                  <>
                    <button
                      onClick={openNotePopup}
                      className="text-[11px] px-1.5 py-0.5 rounded bg-sky-700/30 hover:bg-sky-600/40 text-sky-200 border border-sky-700/40 transition shrink-0"
                      title="查看关联 TB 单的备注（图文）"
                    >📝 查看备注</button>
                    <button
                      onClick={() => setAttachPopup(true)}
                      className="text-[11px] px-1.5 py-0.5 rounded bg-indigo-700/30 hover:bg-indigo-600/40 text-indigo-200 border border-indigo-700/40 transition shrink-0"
                      title="查看关联 TB 单的附件列表，可逐个下载到 archives"
                    >📎 查看附件</button>
                  </>
                )}
                {primaryFlavor && (
                  <span className="text-[11px] text-fuchsia-300 bg-zinc-950/70 border border-fuchsia-800/50 px-2 py-0.5 rounded font-mono shrink-0 flex items-center gap-1" title="目标 Flavor：AI 只对该 flavor 读/改代码">
                    🎯 {primaryFlavor}
                    {primaryFlavor && primaryVersion && (
                      <button
                        onClick={() => setVersionPopup({ path: primary.path, name: primary.name, versionName: primaryVersion.versionName, versionCode: primaryVersion.versionCode })}
                        className="text-emerald-300 hover:text-emerald-200"
                        title="当前版本（点击可 +10 写回 gradle）"
                      >· {primaryVersion.versionName} #{primaryVersion.versionCode}</button>
                    )}
                  </span>
                )}
              </span>
            ) : (
              <span className="text-[11px] text-amber-400">未选择工程</span>
            )}
            </span>
            {tab.deviceSerial ? (
              <span className="flex items-center gap-1 shrink-0">
                {(() => { const bd = devices.find((d) => d.id === tab.deviceSerial); const label = bd?.deviceLabel; return (
                <span className="text-[11px] text-cyan-300 bg-zinc-950/70 border border-cyan-800/50 px-2 py-0.5 rounded font-mono" title={`本故事点绑定的目标设备${label ? `（${label}）` : ""}`}>
                  📱 {tab.deviceSerial}{label ? ` · ${label}` : ""}
                </span>
                ); })()}
                <ScrcpyBtn tabId={tab.id} onToast={onToast} />
              </span>
            ) : (
              <span className="text-[11px] text-zinc-600 shrink-0">未绑定设备</span>
            )}
            {primary && (
              <button
                data-testid="devbench-git-update"
                onClick={() => { if (!gitUpdating && !worktreeMutationDisabled) setShowGitUpdateScope(true); }}
                disabled={gitUpdating || worktreeMutationDisabled}
                className="shrink-0 flex items-center gap-1 text-[11px] px-1.5 py-0.5 rounded bg-teal-700/30 hover:bg-teal-600/40 text-teal-200 border border-teal-700/40 disabled:opacity-60 transition"
                title={worktreeMutationDisabled ? "AI 或其它 worktree 操作正在运行，请稍后更新" : "更新主工程及关联工程的基础工程原始分支，并合并到各自 worktree"}
              >
                <span className={gitUpdating ? "inline-block animate-spin" : ""}>⟳</span>
                {gitUpdating ? "更新中…" : "Git Update"}
              </button>
            )}
            {primary && (
              <button
                onClick={() => setShowLocalChanges((v) => !v)}
                className={`shrink-0 flex items-center gap-1 text-[11px] px-1.5 py-0.5 rounded border transition ${showLocalChanges ? "bg-sky-600/40 text-sky-100 border-sky-500" : "bg-zinc-800/70 hover:bg-zinc-700 text-zinc-300 border-zinc-700"}`}
                title="Local Changes：查看本故事点各工程的待提交改动 + 未跟踪文件（类 Android Studio）"
              >📝 本地改动</button>
            )}
            {primary && (
              <button
                onClick={() => setShowGitAmend((v) => !v)}
                className={`shrink-0 flex items-center gap-1 text-[11px] px-1.5 py-0.5 rounded border transition ${showGitAmend ? "bg-indigo-600/40 text-indigo-100 border-indigo-500" : "bg-zinc-800/70 hover:bg-zinc-700 text-zinc-300 border-zinc-700"}`}
                title="Amend 本地改动（rule_1）：分支尾号+1 新建分支，把工作区改动 amend 到最后一次提交并 push 新分支；旧远程分支确认后删除、本地旧分支保留"
              >✏️ Amend本地改动</button>
            )}
            {primary && (
              <button
                onClick={() => setShowGitCommitRework((v) => !v)}
                className={`shrink-0 flex items-center gap-1 text-[11px] px-1.5 py-0.5 rounded border transition ${showGitCommitRework ? "bg-teal-600/40 text-teal-100 border-teal-500" : "bg-zinc-800/70 hover:bg-zinc-700 text-zinc-300 border-zinc-700"}`}
                title="Git 提交整理（prompt_ask）：把已推送分支重整为基于 MR target 的单 commit 新分支（临时 worktree squash → 校验 → push），并切换故事点到新分支；旧远程分支确认后删除"
              >🧹 Git提交整理</button>
            )}
            {primary && primaryFlavor && primaryVersion?.versionName && (
              <button
                onClick={() => { if (!marking) markVersion(false); }}
                disabled={marking}
                className="shrink-0 flex items-center gap-1 text-[11px] px-1.5 py-0.5 rounded bg-purple-700/30 hover:bg-purple-600/40 text-purple-200 border border-purple-700/40 disabled:opacity-60 transition"
                title={`标记当前版本：主工程提交 flavorConfig.json（信息 flag:${primaryFlavor}_${primaryVersion.versionName}）并打 tag「${primaryFlavor}_${primaryVersion.versionName}」，对应 WebApp 工程也打同名 tag`}
              >🏷 {marking ? "标记中…" : `标记版本 ${primaryFlavor}_${primaryVersion.versionName}`}</button>
            )}
            {primary && (
              <button
                onClick={() => setShowPush(true)}
                className="shrink-0 flex items-center gap-1 text-[11px] px-1.5 py-0.5 rounded bg-blue-700/30 hover:bg-blue-600/40 text-blue-200 border border-blue-700/40 transition"
                title="Git Push（类 Android Studio）：把主工程 + 关联 WebApp 的当前分支推送到远程，可勾选连同标签 Tags 一起推；打开后先预检防误点，远程冲突时引导先拉取或强制推送"
              >⬆ Push</button>
            )}
            {primary && (
              <button
                onClick={() => setShowPrPreview(true)}
                disabled={creatingPr}
                data-testid="devbench-create-pr"
                className="shrink-0 flex items-center gap-1 text-[11px] px-1.5 py-0.5 rounded bg-emerald-700/30 hover:bg-emerald-600/40 text-emerald-200 border border-emerald-700/40 disabled:opacity-60 transition"
                title="提 PR：先预检并展示全部工程、来源/目标分支和可提提交；确认后只处理有新增提交或本地改动的工程"
              >{creatingPr ? "提PR中…" : "提PR"}</button>
            )}
            <button
              onClick={downloadStoryBackup}
              disabled={backingUpStory}
              data-testid="devbench-story-backup"
              className="shrink-0 flex items-center gap-1 text-[11px] px-1.5 py-0.5 rounded bg-amber-700/30 hover:bg-amber-600/40 text-amber-200 border border-amber-700/40 disabled:opacity-60 transition"
              title="一键备份：把当前故事点（对话历史 + 资料文件 + TB/工程/设备配置）打包成 .devbench-story.zip 下载；在另一台电脑「新建故事点 → 从备份还原」会走初始化面板绑定本机工程/远程克隆，再还原对话与资料，相当于在原电脑继续完成任务"
            >{backingUpStory ? "备份中…" : "📦 一键备份"}</button>
            {tab.ticketUrl && (/^https?:\/\//i.test(tab.ticketUrl) ? (
              <a
                href={tab.ticketUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="shrink-0 flex items-center gap-1 text-[11px] text-indigo-300 bg-zinc-950/70 border border-indigo-800/50 px-2 py-0.5 rounded hover:bg-indigo-900/30 hover:text-indigo-200 transition max-w-[260px]"
                title={`在浏览器新标签打开关联任务：${tab.ticketUrl}`}
              >🔗 <span className="truncate">任务</span></a>
            ) : (
              <span
                className="shrink-0 flex items-center gap-1 text-[11px] text-indigo-300 bg-zinc-950/70 border border-indigo-800/50 px-2 py-0.5 rounded max-w-[260px]"
                title={`关联任务：${tab.ticketUrl}`}
              >📌 <span className="truncate">{tab.ticketUrl}</span></span>
            ))}
            {/* 故事点标题/重命名按钮已移除：重命名改由 📋 旁的「编辑菜单」(✎▾) 下拉触发 */}
          </div>
          <div className="flex flex-wrap items-center justify-end gap-1.5 ml-auto shrink-0 sm:pl-3 sm:border-l sm:border-zinc-800/80">
            {/* AI / 中心机运行状态 */}
            {isClientNode && (
              <label className="flex items-center gap-1 text-[11px] text-zinc-500">
                <span className="shrink-0">AI服务器</span>
                <select
                  value={centerSelectValue}
                  disabled={isRunning}
                  onChange={(e) => {
                    const v = e.target.value;
                    if (v === "__global__") onSetCenter?.(null);
                    else onSetCenter?.(centerServers.find((s) => normalizeCenterHost(s.host) === v) || { host: v });
                  }}
                  className="max-w-[220px] bg-zinc-900 border border-zinc-700 rounded px-2 py-0.5 text-[11px] text-emerald-200 outline-none disabled:opacity-50"
                  title={currentCenter?.host || activeCenterHost || "使用设置页已选择的AI服务器"}
                >
                  <option value="__global__">用设置页已选的AI服务器{centerConfig?.selectedHost ? ` · ${centerConfig.selectedName || centerConfig.selectedHost}` : ""}</option>
                  {activeCenterHost && !centerServers.some((s) => normalizeCenterHost(s.host) === activeCenterHost) && (
                    <option value={activeCenterHost}>{tab.centerName || (!tab.centerHost ? centerConfig?.selectedName : "") || activeCenterHost} · 未发现</option>
                  )}
                  {centerServers.map((s) => {
                    const host = normalizeCenterHost(s.host);
                    return (
                      <option key={`${s.id || ""}-${host}`} value={host} disabled={!!s.full}>
                        {s.name || host}{s.full ? " · 忙" : ""}{s.capacity?.free != null ? ` · 空闲${s.capacity.free}` : ""}
                      </option>
                    );
                  })}
                </select>
              </label>
            )}
            {tab.groupId && (
              <button onClick={() => onOpenGroup?.()}
                className={`text-[11px] px-2 py-0.5 rounded border transition ${queued ? "bg-amber-700/30 border-amber-700/50 text-amber-200" : "bg-emerald-700/25 border-emerald-700/50 text-emerald-200"} hover:brightness-110`}
                title="故事点组：共用同一套工程配置的多个 TB 单，串行开发。点击查看/切换">👥 故事点组{queued ? "（排队中）" : ""}</button>
            )}
            <ConfigMenuBtn configClip={configClip} onCopyConfig={onCopyConfig} onApplyConfig={onApplyConfig} />
            <button data-testid="story-config-toggle" onClick={() => { if (copying) { onToast?.("工程复制中，暂不可编辑配置"); return; } onOpenStoryConfig?.(); }}
              disabled={copying}
              className="text-[11px] text-zinc-400 hover:text-zinc-100 px-2 py-0.5 rounded border border-zinc-700/70 hover:bg-zinc-800 disabled:opacity-40 disabled:cursor-not-allowed transition">
              配置工程
            </button>
          </div>
        </div>

        {/* ===== Git 操作面板（本地改动 / Amend / 提交整理）：紧跟头部操作按钮展开，点击后立即可见 ===== */}
        {showLocalChanges && (
          <LocalChangesPanel tabId={tab.id} refreshKey={`${gitStatusVersion}:${gitUpdate?.status || ""}:${gitUpdate?.summary?.updated || 0}`} onClose={() => setShowLocalChanges(false)} onToast={onToast} />
        )}
        {showGitAmend && (
          <GitAmendPanel tabId={tab.id} primaryPath={primary?.path || ""} refreshKey={gitStatusVersion} onClose={() => setShowGitAmend(false)} onToast={onToast} onDone={handleGitStateChanged} />
        )}
        {showGitCommitRework && (
          <GitCommitReworkPanel tabId={tab.id} primaryPath={primary?.path || ""} refreshKey={gitStatusVersion} onClose={() => setShowGitCommitRework(false)} onToast={onToast} onDone={handleGitStateChanged} />
        )}

        {showConfig && (
          // relative 容器：滚动区在内，底部叠一个"下滑查看更多"提示
          <div className="relative">
          {/* 配置项多时限高 + 内部纵向滚动，避免撑高把对话区/底部输入框顶出可视区(尤其 desktop 矮窗) */}
          <div ref={cfgScrollRef} onScroll={measureCfgScroll}
            className="px-4 pb-3 max-h-[52vh] overflow-y-auto overflow-x-hidden">
          <div ref={cfgInnerRef} className="space-y-3">
            {/* 配置模式切换：本地工程 / 远程拉取。无本地源码时隐藏「本地工程」Tab，仅可远程拉取 */}
            <div className="flex items-center gap-1">
              {!localTabDisabled && (
                <button onClick={() => switchConfigMode("local")}
                  title="选择本地已有工程"
                  className={`px-2.5 py-1 text-[11px] rounded transition ${configMode === "local" ? "bg-blue-600 text-white" : "bg-zinc-800 text-zinc-400 hover:text-zinc-200"}`}>本地工程</button>
              )}
              <button onClick={() => switchConfigMode("remote")}
                title="从远程仓库 clone 工程到本机"
                className={`px-2.5 py-1 text-[11px] rounded transition ${configMode === "remote" ? "bg-blue-600 text-white" : "bg-zinc-800 text-zinc-400 hover:text-zinc-200"}`}>远程拉取</button>
              {localTabDisabled && <span className="text-[10px] text-zinc-600 ml-1">（本机无该工程本地源码，仅可远程拉取）</span>}
            </div>
            <div className="flex items-start gap-2 flex-wrap" data-testid="devbench-report-mode">
              <span className="text-[11px] text-zinc-500 w-16 pt-1.5">报告模式</span>
              <div className="flex-1 min-w-[280px] space-y-1.5">
                <div className="inline-flex rounded border border-zinc-700 overflow-hidden text-[11px]">
                  <button
                    onClick={() => onSetReportMode?.("short")}
                    disabled={isRunning}
                    className={`px-2.5 py-1 transition disabled:opacity-50 ${tab.reportMode !== "expert" ? "bg-emerald-600 text-white" : "bg-zinc-800 text-zinc-400 hover:text-zinc-200"}`}
                    title="默认。TB 只回写通俗的原因和措施，不生成 HTML/PDF 或上传报告附件"
                  >简短模式（默认）</button>
                  <button
                    onClick={() => onSetReportMode?.("expert")}
                    disabled={isRunning}
                    className={`px-2.5 py-1 transition disabled:opacity-50 ${tab.reportMode === "expert" ? "bg-fuchsia-600 text-white" : "bg-zinc-800 text-zinc-400 hover:text-zinc-200"}`}
                    title="生成包含原因、方案、改动范围、测试建议、自测和真实多媒体证据的 HTML，并转换为 PDF 回传 TB"
                  >专家报告模式</button>
                </div>
                <p className="text-[10px] text-zinc-600 leading-relaxed">
                  本设置只属于当前 TB 单，不会随“复制工程配置”或故事点组共享。{tab.reportMode === "expert"
                    ? "专家模式要求先生成图文影音 HTML，再由系统转换为 PDF；失败时不会推进 TB。"
                    : "简短模式只写“原因 + 措施”的通俗短评，不生成或上传报告附件。"}
                </p>
              </div>
            </div>
            <div className="flex items-start gap-2 flex-wrap">
              <span className="text-[11px] text-zinc-500 w-16 pt-1.5">存档目录</span>
              <div className="flex-1 min-w-[280px] space-y-1">
                <div className="flex items-center gap-1.5">
                  <input
                    value={archiveDirDraft}
                    onChange={(e) => setArchiveDirDraft(e.target.value)}
                    placeholder="当前故事点 AllDocs/StoryDev/.../ask 下的目录"
                    title={`${archiveDirDraft}\n仅允许当前故事点外置 ask 目录及其子目录`}
                    className="flex-1 min-w-0 bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-[11px] text-zinc-200 placeholder-zinc-600 outline-none font-mono"
                  />
                  <button onClick={() => setShowArchiveDirPicker(true)} className="px-2 py-1 text-[11px] rounded bg-zinc-700 hover:bg-zinc-600 text-zinc-100">选择</button>
                  <button onClick={() => saveArchiveDir("")} disabled={archiveDirSaving} className="px-2 py-1 text-[11px] rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-400 disabled:opacity-50">默认</button>
                  <button
                    onClick={() => saveArchiveDir(archiveDirDraft)}
                    disabled={archiveDirSaving || archiveDirDraft === archiveDirValue}
                    className="px-2 py-1 text-[11px] rounded bg-blue-600 hover:bg-blue-500 text-white disabled:bg-zinc-700 disabled:text-zinc-500"
                  >{archiveDirSaving ? "保存中…" : "保存"}</button>
                  <button
                    onClick={async () => {
                      if (!tab.archiveFile) return;
                      await copyToClipboard(tab.archiveFile);
                      setArchiveDirCopied(true);
                      onToast?.("已复制备份 TXT 文件路径");
                      setTimeout(() => setArchiveDirCopied(false), 1500);
                    }}
                    disabled={!tab.archiveFile}
                    title={tab.archiveFile ? `复制备份 TXT 文件路径：${tab.archiveFile}` : "尚无备份 TXT 文件"}
                    className="px-2 py-1 text-[11px] rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-400 disabled:opacity-50"
                  >{archiveDirCopied ? "✓ 已复制" : "复制Txt路径"}</button>
                  <button
                    onClick={openArchiveDir}
                    disabled={!archiveDirValue || archiveDirOpening}
                    title={archiveDirValue ? `在资源管理器中打开：${archiveDirValue}` : "尚无存档目录"}
                    className="px-2 py-1 text-[11px] rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-400 disabled:opacity-50"
                  >{archiveDirOpening ? "打开中…" : "打开目录"}</button>
                </div>
                <div className="text-[10px] text-zinc-600">仅允许当前故事点外置 ask 目录及其子目录，禁止写入源码 worktree。</div>
                {tab.archiveFile && <div className="text-[10px] text-zinc-600 truncate font-mono" title={tab.archiveFile}>文件：{tab.archiveFile}</div>}
              </div>
            </div>
            {(configMode === "remote" || localTabDisabled) ? (
              <RemotePullConfig tab={tab} projectId={projectId} cloneProgress={cloneProgress} onRefreshTab={onRefreshTab} onToast={onToast} />
            ) : (
            <>
            {/* 所选工程的本地源码（可复用，含已克隆记录） */}
            {tab.projectDefId && localCheckouts.length > 0 && (
              <div className="flex items-start gap-2 flex-wrap">
                <span className="text-[11px] text-zinc-500 w-16 pt-1">本地源码</span>
                <div className="flex-1 min-w-[280px] flex flex-wrap gap-1.5">
                  {localCheckouts.map((co) => {
                    const active = primary && norm(primary.path) === norm(co.path);
                    return (
                      <button key={co.path} disabled={isRunning || copying} onClick={() => useLocalSource(co)} title={co.path}
                        className={`px-2 py-1 text-[11px] rounded border max-w-[260px] truncate disabled:opacity-50 disabled:cursor-not-allowed ${active ? "bg-blue-600 border-blue-500 text-white" : "bg-zinc-800 border-zinc-700 text-zinc-300 hover:border-zinc-500"}`}>
                        {active ? "✓ " : ""}{co.name}{co.source === "clone" ? " · 已拉取" : ""}
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
            {/* 主工程下拉 */}
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-[11px] text-zinc-500 w-16">主工程</span>
              <ProjectSelect
                projects={projects}
                value={tab.primaryProjectId || ""}
                otherOccupied={otherOccupied}
                onChange={onSetPrimary}
                disabled={isRunning || copying}
              />
              {primary && <ApkSourceBtn path={primary.path} currentPath={apkSource} onSet={handleSetApkSource} />}
            </div>

            {/* 关联工程（依赖的 WebApp 自动带入，其余手动添加） */}
            <div className="flex items-start gap-2 flex-wrap">
              <span className="text-[11px] text-zinc-500 w-16 pt-1.5">关联工程</span>
              <div className="flex-1 min-w-[280px] space-y-1.5">
                {primary?.webAppPath && (
                  <div className="flex items-center gap-2 text-[11px] bg-sky-950/40 border border-sky-800/50 rounded px-2 py-1">
                    <span className="text-[10px] px-1 py-0.5 rounded bg-sky-600/30 text-sky-300 border border-sky-500/30 shrink-0">自动·WebApp</span>
                    <span className="text-sky-200/90 truncate flex-1 font-mono" title={primary.webAppPath}>{primary.webAppPath}</span>
                    <OpenBtn path={primary.webAppPath} />
                    <StudioBtn path={primary.webAppPath} onToast={onToast} />
                  </div>
                )}
                {(tab.extraProjects || []).map((ex) => (
                  <div key={ex.path} className="flex items-center gap-2 text-[11px] bg-zinc-950/60 border border-zinc-800 rounded px-2 py-1">
                    <span className="text-zinc-300 truncate flex-1 font-mono" title={ex.path}>
                      {ex.name && ex.name !== ex.path ? `${ex.name}：${ex.path}` : ex.path}
                    </span>
                    <ApkSourceBtn path={ex.path} currentPath={apkSource} onSet={handleSetApkSource} />
                    <OpenBtn path={ex.path} />
                    <StudioBtn path={ex.path} onToast={onToast} />
                    {(() => {
                      const canSwap = !!primary && canPromoteWorktreeExtra({
                        projects,
                        worktree: tab.worktree,
                        extraPath: ex.path,
                      });
                      return (
                        <button
                          onClick={() => { if (canSwap && !isRunning && !copying) onSwapPrimary?.(ex.path); }}
                          disabled={!canSwap || isRunning || copying}
                          title={canSwap
                            ? "与主工程对调：把此工程设为主工程，当前主工程降为关联工程"
                            : "此关联工程未登记为工程，无法设为主工程（请先在主工程下拉里登记）"}
                          className="text-[10px] px-1.5 py-0.5 rounded border border-zinc-700 text-zinc-400 hover:text-emerald-300 hover:border-emerald-600/50 disabled:opacity-40 disabled:cursor-not-allowed transition shrink-0"
                        >⇅ 设为主工程</button>
                      );
                    })()}
                    <button
                      disabled={isRunning || copying}
                      onClick={() => onRemoveExtra(ex.path)}
                      className="text-zinc-600 hover:text-red-400 disabled:opacity-40 disabled:cursor-not-allowed"
                    >移除</button>
                  </div>
                ))}
                {/* 下拉选择（与主工程一致），排除本故事点已选用的工程 */}
                <ExtraProjectSelect
                  projects={projects}
                  selectedNorm={selectedBaseProjectPaths(tab.worktree, [
                    primary?.path,
                    primary?.webAppPath,
                    ...(tab.extraProjects || []).map((e) => e.path),
                  ].filter(Boolean))}
                  otherOccupied={otherOccupied}
                  onPick={(p) => onAddExtra(p.path, p.name)}
                  disabled={isRunning || copying}
                />
                {/* 或手动输入绝对路径 */}
                <div className="flex items-center gap-1.5">
                  <input disabled={isRunning || copying} value={extraPath} onChange={(e) => setExtraPath(e.target.value)}
                    placeholder="或手动输入工程绝对路径"
                    className="flex-1 bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-[11px] text-zinc-200 placeholder-zinc-600 outline-none font-mono disabled:opacity-50" />
                  <input disabled={isRunning || copying} value={extraName} onChange={(e) => setExtraName(e.target.value)}
                    placeholder="备注名"
                    className="w-24 bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-[11px] text-zinc-200 placeholder-zinc-600 outline-none disabled:opacity-50" />
                  <button disabled={isRunning || copying} onClick={doAddExtra} className="px-2 py-1 text-[11px] rounded bg-zinc-700 hover:bg-zinc-600 text-zinc-100 disabled:opacity-50 disabled:cursor-not-allowed">添加</button>
                </div>
              </div>
            </div>
            {/* 目标 Flavor（仅 Android 工程显示）：每个 Android 工程一个下拉，选定后注入每轮上下文 */}
            {anyAndroid && (
              <div className="flex items-start gap-2 flex-wrap">
                <span className="text-[11px] text-zinc-500 w-16 pt-1.5">目标Flavor</span>
                <div className="flex-1 min-w-[280px] space-y-1.5">
                  {flavors.filter((f) => f.isAndroid).map((f) => (
                    <div key={f.path} className="flex items-center gap-2 text-[11px] flex-wrap">
                      <span className="text-zinc-400 truncate max-w-[200px] font-mono" title={f.path}>{f.name}</span>
                      {f.flavors.length > 0 ? (
                        <select
                          value={f.selected || ""}
                          onChange={(e) => onSelectFlavor(f.path, e.target.value)}
                          className="bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-[11px] text-zinc-200 outline-none min-w-[160px]"
                        >
                          <option value="">— 不指定（全部 flavor）—</option>
                          {f.flavors.map((fl) => <option key={fl} value={fl}>{fl}</option>)}
                        </select>
                      ) : (
                        <input
                          defaultValue={f.selected || ""}
                          onBlur={(e) => { const v = e.target.value.trim(); if (v !== (f.selected || "")) onSelectFlavor(f.path, v); }}
                          placeholder="未解析到 flavor，可手动填（回车/失焦生效）"
                          className="bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-[11px] text-zinc-200 placeholder-zinc-600 outline-none w-64"
                        />
                      )}
                      {f.selected && <span className="text-[10px] text-fuchsia-300 shrink-0">🎯 {f.selected}</span>}
                      {f.selected && f.version && (
                        <span className="flex items-center gap-1 text-[10px] shrink-0">
                          <span className="text-zinc-500">版本</span>
                          <span className="text-emerald-300 font-mono">{f.version.versionName}</span>
                          <button
                            onClick={() => setVersionPopup({ path: f.path, name: f.name, versionName: f.version.versionName, versionCode: f.version.versionCode })}
                            className="text-fuchsia-300 font-mono underline decoration-dotted hover:text-fuchsia-200"
                            title="点击：版本号管理（加10 / 提升为交付版本 / 更新测试版本号），写回该 flavor 的版本"
                          >#{f.version.versionCode}</button>
                        </span>
                      )}
                    </div>
                  ))}
                  <div className="flex items-center gap-2">
                    <p className="text-[10px] text-zinc-600 flex-1">选定后自动显示该工程的版本名/版本号（点版本号可做：加10 / 提升为交付版本 / 更新测试版本号，写回 gradle/flavorConfig）；AI 每轮都被强约束只对该 flavor 读/改代码，且知道当前版本。</p>
                    <button onClick={refreshStatus} disabled={refreshing} title="重新读取版本号/分支/flavor 等状态（等同浏览器刷新，但只刷本故事点）"
                      className="shrink-0 px-2 py-0.5 text-[10px] rounded border border-zinc-700 bg-zinc-800 hover:bg-zinc-700 text-zinc-300 disabled:text-zinc-600 transition">
                      {refreshing ? "刷新中…" : "↻ 刷新状态"}
                    </button>
                  </div>
                </div>
              </div>
            )}
            {/* Git 分支：主工程 + 关联工程 切换分支（自动暂存）/ 暂存管理 */}
            <GitBranchSection
              tabId={tab.id}
              refreshKey={`${refsKey}|${gitStatusVersion}`}
              onChanged={handleGitStateChanged}
              onToast={onToast}
            />
            {/* 关联任务：从任务列表选（置顶）/ 从 TB 工单选 / 手动输入（带 CARB 编号，互斥） */}
            <div className="flex items-start gap-2 flex-wrap">
              <span className="text-[11px] text-zinc-500 w-16 pt-1.5">关联任务</span>
              <div className="flex-1 min-w-[280px] space-y-1.5">
                {/* 从任务列表（待办，含手敲任务）下拉选择 —— 在上方 */}
                <TicketSelect
                  tasks={tickets.filter((t) => !t.done && !(t.tbTaskId && t.staged !== false))}
                  value={tab.ticketUrl || ""}
                  ticketOwners={ticketOwners}
                  onPick={(t) => onSetTicket(t.ticketUrl || t.title)}
                  placeholder="＋ 从任务列表选择"
                  emptyText="任务列表暂无可关联的任务"
                />
                {/* 从 TB 工单下拉选择：仅"未添加到任务"的候选 TB 工单(staged !== false)。
                    已「添加到任务」的 TB 单(staged===false)归属上方「任务列表」下拉，此处不再列出，
                    否则同一关联任务会被两个下拉同时命中、双双渲染成"已选"按钮造成重复显示。 */}
                <TicketSelect
                  tasks={tickets.filter((t) => t.tbTaskId && t.staged !== false)}
                  value={tab.ticketUrl || ""}
                  ticketOwners={ticketOwners}
                  onPick={(t) => onSetTicket(t.ticketUrl || t.title)}
                  placeholder="＋ 从 TB 工单选择"
                  emptyText="没有 TB 工单（先到「任务列表」同步）"
                />
                <div className="flex items-center gap-1.5 flex-wrap">
                  <input
                    value={ticketDraft}
                    onChange={(e) => setTicketDraft(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); e.currentTarget.blur(); } }}
                    onBlur={() => { const v = ticketDraft.trim(); const cur = looksLikeTicketUrl(tab.ticketUrl) ? (tab.ticketUrl || "") : ""; if (v && v !== cur) commitTicket(v); }}
                    placeholder="手动输入 TB 单号(如 CARB-11640) 或 TB 链接（失焦/保存生效）"
                    className="flex-1 min-w-[200px] bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-[11px] text-zinc-200 placeholder-zinc-600 outline-none font-mono"
                  />
                  <button
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => { const v = ticketDraft.trim(); if (v) commitTicket(v); }}
                    className="px-2 py-1 text-[11px] rounded bg-zinc-700 hover:bg-zinc-600 text-zinc-100"
                  >保存</button>
                  {tab.ticketUrl && (
                    <>
                      {looksLikeTicketUrl(tab.ticketUrl) && /^https?:\/\//i.test(tab.ticketUrl) && (
                      <a href={tab.ticketUrl} target="_blank" rel="noopener noreferrer"
                        className="px-2 py-1 text-[11px] rounded bg-indigo-700/30 hover:bg-indigo-600/40 text-indigo-200 border border-indigo-700/40 transition"
                        title={`在浏览器新标签打开：${tab.ticketUrl}`}>🔗 打开</a>
                      )}
                      <button
                        onClick={() => { setTicketDraft(""); onSetTicket(""); }}
                        className="px-2 py-1 text-[11px] rounded bg-zinc-800 hover:bg-red-600/30 text-zinc-400 hover:text-red-300"
                      >清除</button>
                    </>
                  )}
                </div>
              </div>
            </div>
            {/* 关联 TB 单的附件：显示 + 下载到 cloneParent/AllDocs/StoryDev/<故事点>/archives/ */}
            <TbAttachments tabId={tab.id} ticketUrl={tab.ticketUrl} />
            {/* 目标设备 */}
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-[11px] text-zinc-500 w-16">目标设备</span>
              <select
                value={tab.deviceSerial || ""}
                onChange={(e) => { const v = e.target.value; v ? onBindDevice(v) : onReleaseDevice(); }}
                className="bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-xs text-zinc-200 outline-none min-w-[240px]"
              >
                <option value="">— 不绑定设备 —</option>
                {/* 当前绑定的设备即使不在线也保留可见 */}
                {tab.deviceSerial && !devices.some((d) => d.id === tab.deviceSerial) && (
                  <option value={tab.deviceSerial}>{tab.deviceSerial}（离线）</option>
                )}
                {devices.map((d) => {
                  const offline = d.status && d.status !== "device";
                  const bindings = Array.isArray(d.bindings) ? d.bindings : [];
                  const currentUse = d.runtime?.lease || d.currentUse;
                  const usingTitle = bindings.find((binding) => binding.storyId === currentUse?.storyId)?.title || currentUse?.storyId || "";
                  return (
                    <option key={d.id} value={d.id} disabled={offline}>
                      {fmtDeviceLabel(d)}{bindings.length ? ` — ${bindings.length} 个故事点已绑定` : ""}{usingTitle ? `，当前「${usingTitle}」使用中` : ""}
                    </option>
                  );
                })}
              </select>
              <button onClick={onRefreshDevices} className="px-2 py-1 text-[11px] rounded bg-zinc-700 hover:bg-zinc-600 text-zinc-200" title="刷新设备列表">↻ 刷新</button>
              {tab.deviceSerial && (
                <button onClick={onReleaseDevice} className="px-2 py-1 text-[11px] rounded bg-zinc-800 hover:bg-red-600/30 text-zinc-400 hover:text-red-300">释放设备</button>
              )}
              <span className="text-[10px] text-zinc-600">绑定可共享；ADB、脚本、安装和验收按 FIFO 取得独占使用权</span>
            </div>
            {tab.deviceSerial ? (
              <DeviceRuntimeStatusCard
                device={devices.find((device) => String(device?.id || device?.serial || "") === String(tab.deviceSerial))
                  || { id: tab.deviceSerial, connectivity: "offline" }}
                compact
              />
            ) : null}

            <p className="text-[10px] text-zinc-600">本机工程列表在“工程配置”中维护并保存到 Git 忽略目录。工程使用故事点专属 Git worktree；设备绑定可共享，实际操作由运行时租约串行化。</p>
            </>
            )}
            <AgentRunPanel agentRun={agentRun} onAgentRun={onAgentRun} />
          </div>{/* /cfgInner */}
          </div>{/* /cfgScroll */}
          {/* 配置项较多、下方还有内容时的下滑提示；滚到底自动隐藏 */}
          {cfgMore && (
            <div className="pointer-events-none absolute inset-x-0 bottom-0 flex justify-center pt-6 pb-1
                            bg-gradient-to-t from-zinc-900 via-zinc-900/70 to-transparent">
              <span className="text-[10px] text-zinc-300 bg-zinc-800/90 border border-zinc-700 rounded-full px-2.5 py-0.5 shadow-sm animate-pulse">
                ▾ 下滑查看更多配置
              </span>
            </div>
          )}
          </div>
        )}

        {/* Git 分支：主工程 + 关联工程，和工程操作区一起展开/收起；工程多时收进「更多」下拉（不滑动不换行） */}
        <GitBranchChips
          branches={branches}
          loading={loadingBranches}
          onRefresh={loadBranches}
          onToast={onToast}
        />

        {/* worktree 状态紧跟 Git 分支，并随整个工程操作区一起展开/收起。 */}
        {activeManagedWorktree && (
          <div
            data-testid="story-worktree-banner"
            className="border-t devbench-status-banner devbench-status-banner--success px-4 py-2"
          >
            <div className="flex items-center gap-2">
              <span className="rounded-md border border-emerald-500/35 bg-emerald-500/10 px-1.5 py-0.5 text-[9px] font-semibold tracking-wide text-emerald-300">{tab.worktree?.bundle ? "WORKSPACE BUNDLE" : "GIT WORKTREE"}</span>
              <span className="min-w-0 flex-1 truncate text-[10px] text-zinc-300" title={worktreeDisplay.path || ""}>
                当前故事点使用独立工作区，原工程代码不会被修改
                {liveWorktreeBranch && (
                  <span className="ml-2 font-mono text-amber-300/90">⎇ {liveWorktreeBranch}</span>
                )}
                <span className="ml-2 font-mono text-emerald-200/80">{worktreeDisplay.path || ""}</span>
              </span>
              <span className="hidden shrink-0 text-[10px] text-emerald-400/80 sm:inline">可与其他故事点并行</span>
              <button
                type="button"
                onClick={() => setShowWorktreeCleanup(true)}
                disabled={worktreeMutationDisabled}
                title={worktreeMutationDisabled ? "当前页面的 AI 任务运行期间不能清理 worktree" : "先安全检查；确认放弃本地内容时也可强制删除"}
                className="shrink-0 rounded-lg border border-emerald-500/35 bg-emerald-500/10 px-2 py-1 text-[10px] text-emerald-100 transition hover:bg-emerald-500/25 disabled:cursor-not-allowed disabled:opacity-40"
                data-testid="worktree-cleanup-entry"
              >
                ◇ 清理 worktree
              </button>
            </div>
            <WorkspaceBundleSummary worktree={tab.worktree} />
          </div>
        )}
        {activeManagedWorktree && (
          <WorktreeBranchMismatchBanner
            report={branchPairs}
            refreshing={loadingBranchPairs}
            onRefresh={loadBranchPairs}
          />
        )}
        {partialManagedWorktree && (
          <div
            data-testid="story-worktree-partial-banner"
            className="border-t devbench-status-banner devbench-status-banner--warning px-4 py-2"
          >
            <div className="flex items-center gap-2">
              <span className="rounded-md border border-amber-500/40 bg-amber-500/15 px-1.5 py-0.5 text-[9px] font-semibold tracking-wide text-amber-200">
                部分已清理
              </span>
              <span className="min-w-0 flex-1 truncate text-[10px] text-zinc-300" title={tab.worktreeError || ""}>
                已保留先前清理仓库的恢复快照；仍有 {(tab.worktree.entries || []).filter((entry) => entry.role !== "webapp").length} 个 worktree 待处理
                {tab.worktreeError && <span className="ml-2 text-red-300/80">{tab.worktreeError}</span>}
              </span>
              <button
                type="button"
                onClick={() => setShowWorktreeCleanup(true)}
                disabled={worktreeMutationDisabled}
                className="shrink-0 rounded-lg border border-amber-500/40 bg-amber-500/15 px-2.5 py-1 text-[10px] font-medium text-amber-100 transition hover:bg-amber-500/25 disabled:cursor-not-allowed disabled:opacity-40"
                data-testid="worktree-cleanup-partial-entry"
              >
                处理剩余 worktree
              </button>
            </div>
          </div>
        )}
        {cleanedManagedWorktree && (
          <div
            data-testid="story-worktree-cleaned-banner"
            className="border-t devbench-status-banner devbench-status-banner--success px-4 py-2"
          >
            <div className="flex items-center gap-2">
              <span className="rounded-md border border-sky-500/35 bg-sky-500/10 px-1.5 py-0.5 text-[9px] font-semibold tracking-wide text-sky-300">WORKTREE 已清理</span>
              <span className="min-w-0 flex-1 truncate text-[10px] text-zinc-400" title={tab.worktreeError || ""}>
                {tab.worktreeError
                  ? <span className="text-amber-300">上次重建未完成：{tab.worktreeError}</span>
                  : "工作目录已释放，Git 分支和提交仍保留"}
                {tab.worktree.cleanedAt && <span className="ml-2 text-zinc-600">{new Date(tab.worktree.cleanedAt).toLocaleString()}</span>}
              </span>
              <button
                type="button"
                onClick={recreateWorktree}
                disabled={recreatingWorktree || worktreeMutationDisabled}
                className="shrink-0 rounded-lg border border-sky-500/35 bg-sky-500/10 px-2.5 py-1 text-[10px] font-medium text-sky-200 transition hover:border-sky-400/60 hover:bg-sky-500/20 disabled:cursor-wait disabled:opacity-45"
                data-testid="worktree-recreate-entry"
              >
                {recreatingWorktree ? "正在重新创建…" : "↻ 重新创建 worktree"}
              </button>
            </div>
          </div>
        )}
        {tab.worktreeStatus === "error" && (
          <div role="alert" className="border-t border-red-800/60 bg-red-950/40 px-4 py-2 text-[11px] text-red-200">
            worktree 创建失败：{tab.worktreeError || "未知错误"}。原工程未被改动，请检查 Git 仓库和 worktree 根目录权限后重试。
          </div>
        )}
        </div>
      )}

      {/* ===== 对话区 ===== */}
      <div className="flex-1 relative overflow-hidden">
        {isTbTicket && (
          <WorkflowMap
            currentPhase={tab.workflow?.phase || "claimed"}
            skipTestAcceptance={tab.skipTestAcceptance === true}
            isRunning={isRunning || streaming}
            onSetPhase={onSetWorkflowPhase}
            onToast={onToast}
          />
        )}
        <div
          ref={scrollRef}
          data-testid="devbench-conversation-scroll"
          data-message-viewport="true"
          tabIndex={0}
          aria-label="故事点对话消息，可用 PageUp 上翻、End 回到底部"
          onScroll={handleConversationScroll}
          onWheel={(event) => { if (event.deltaY < 0) pauseFollowingForInteraction(); }}
          onTouchMove={pauseFollowingForInteraction}
          className="h-full overflow-y-auto overflow-x-hidden px-4 py-4 space-y-4 outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-blue-500/30"
        >
          {messages.length === 0 && !live && (
            <div className="text-center text-zinc-600 text-xs mt-10">
              {primary ? `在「${primary.name}」工程目录下与 ${activeAiServiceLabel} 对话，对话将存档到该工程 docs 目录` : "请先在上方选择主工程"}
            </div>
          )}
          {messages.map((m, i) => {
            const messageId = conversationMessageStableId(conversation, m, i);
            const revisionNavigation = m.role === "user" ? userRevisionNavigation(conversation, { ...m, id: messageId }, i) : null;
            return (
              <div key={messageId} ref={(el) => { msgRefs.current[messageId] = el; msgRefs.current[i] = el; }}
                className={highlightIdx === i ? "ring-2 ring-blue-500/60 rounded-lg transition" : ""}>
                <MessageBubble
                  msg={{ ...m, id: messageId }}
                  messageId={messageId}
                  onQuote={setReplyTo}
                  onReject={onReject}
                  tabId={tab.id}
                  onToast={onToast}
                  onViewPrompt={setAiPromptPanel}
                  menuActive={messageMenu.id === messageId}
                  menuPinned={messageMenu.id === messageId && messageMenu.pinned}
                  onMenuOpen={openMessageMenu}
                  onMenuClose={closeMessageMenu}
                  editing={editingMessageId === messageId}
                  onEdit={() => setEditingMessageId(messageId)}
                  onEditCancel={() => setEditingMessageId(null)}
                  onEditSubmit={(content) => editAndResendMessage(messageId, content)}
                  editDisabled={conversationMutationDisabled}
                  editDisabledReason={conversationMutationDisabledReason}
                  revisionNavigation={revisionNavigation}
                  branchBusy={!!branchSwitchingId}
                  onSelectBranch={selectConversationBranch}
                />
              </div>
            );
          })}
          {/* 实时流式 */}
          {liveForDisplay && (streaming || liveForDisplay.text || liveForDisplay.thinking || liveForDisplay.toolOutput || liveForDisplay.tools?.length > 0) && (
            <LiveBubble
              live={liveForDisplay}
              now={clockNow}
              tabId={tab.id}
              onToast={onToast}
              messageId={`live:${tab.sessionId || tab.id}`}
              menuActive={messageMenu.id === `live:${tab.sessionId || tab.id}`}
              menuPinned={messageMenu.id === `live:${tab.sessionId || tab.id}` && messageMenu.pinned}
              onMenuOpen={openMessageMenu}
              onMenuClose={closeMessageMenu}
            />
          )}
        </div>

        {showJumpToBottom && (
          <button
            type="button"
            data-testid="devbench-scroll-to-bottom"
            onClick={() => scrollConversationToBottom("smooth")}
            className="absolute bottom-4 left-1/2 z-20 flex -translate-x-1/2 items-center gap-1.5 rounded-full border border-blue-400/40 bg-zinc-900/95 px-3.5 py-2 text-[11px] font-medium text-blue-100 shadow-[0_10px_30px_rgba(0,0,0,0.45)] backdrop-blur transition hover:-translate-y-0.5 hover:border-blue-300/70 hover:bg-blue-600 hover:text-white focus:outline-none focus:ring-2 focus:ring-blue-400/60"
            title="回到最新一条消息并继续跟随实时回答"
          >
            <span className="flex h-5 w-5 items-center justify-center rounded-full bg-blue-500/20 text-sm leading-none">↓</span>
            回到底部
          </button>
        )}

        {/* 悬浮按钮组：完全覆盖在对话层上，不通过对话区 padding 预留空间，展开/收起不会改变聊天布局 */}
        <div
          data-testid="devbench-floating-actions"
          data-collapsed={floatingActionsCollapsed ? "true" : "false"}
          className="pointer-events-none absolute bottom-3 right-3 top-3 z-30 flex min-h-0 flex-col items-end"
        >
          {floatingActionsCollapsed ? (
            <button
              type="button"
              onClick={toggleFloatingActions}
              aria-expanded="false"
              data-testid="floating-actions-toggle"
              className="pointer-events-auto flex h-11 w-11 flex-col items-center justify-center rounded-2xl border border-zinc-600/80 bg-zinc-900/95 text-zinc-200 shadow-2xl backdrop-blur transition hover:border-blue-400/70 hover:bg-zinc-800 hover:text-white focus:outline-none focus:ring-2 focus:ring-blue-400/60"
              title="展开故事点快捷操作"
            >
              <span className="text-base leading-none">☷</span>
              <span className="mt-0.5 text-[9px] leading-none">操作</span>
            </button>
          ) : (
            <div className="pointer-events-auto flex min-h-0 w-[52px] flex-1 flex-col items-center rounded-2xl border border-zinc-700/80 bg-zinc-900/90 p-1.5 shadow-2xl backdrop-blur">
              <button
                type="button"
                onClick={toggleFloatingActions}
                aria-expanded="true"
                data-testid="floating-actions-toggle"
                className="mb-1 flex h-7 w-full shrink-0 items-center justify-center gap-0.5 rounded-lg text-[9px] text-zinc-400 transition hover:bg-zinc-800 hover:text-zinc-100 focus:outline-none focus:ring-2 focus:ring-blue-400/60"
                title="收起故事点快捷操作"
              >
                <span>收起</span><span className="text-xs">›</span>
              </button>
              <div className="mb-1 shrink-0">
                {isClientNode ? (
                  <CenterSwitchButton tab={tab} isRunning={isRunning} centerServers={centerServers} centerConfig={centerConfig} onSetCenter={onSetCenter} onToast={onToast} />
                ) : (
                  <EngineSwitchButton tab={tab} isRunning={isRunning} onRefreshTab={onRefreshTab} onToast={onToast}
                    status={engineStatus} statusLoading={engineStatusLoading} onRefreshStatus={refreshEngineStatus} metadata={engineMetadata} />
                )}
              </div>
              <div
                data-testid="devbench-floating-actions-scroll"
                className="min-h-0 w-full flex-1 flex flex-col items-center gap-2 overflow-y-auto overscroll-contain px-0.5 pb-0.5 [&>*]:shrink-0"
              >
          <button
            onClick={() => { setShowOutline((v) => !v); setShowResources(false); }}
            className={`w-9 h-9 rounded-full shadow-lg border transition flex items-center justify-center ${
              showOutline ? "bg-blue-600 border-blue-500 text-white" : "bg-zinc-800/90 border-zinc-700 text-zinc-300 hover:text-white hover:bg-zinc-700"
            }`}
            title="提问大纲：快速跳转到某条提问"
          >☰</button>
          <button
            onClick={() => { setShowResources((v) => !v); setShowOutline(false); }}
            className={`w-9 h-9 rounded-full shadow-lg border transition flex items-center justify-center ${
              showResources ? "bg-blue-600 border-blue-500 text-white" : "bg-zinc-800/90 border-zinc-700 text-zinc-300 hover:text-white hover:bg-zinc-700"
            }`}
            title="资源管理：工程文件目录树"
          >🗂</button>
          <button
            onClick={() => { setShowFixChat((v) => !v); setShowOutline(false); setShowResources(false); }}
            className={`w-9 h-9 rounded-full shadow-lg border transition flex items-center justify-center ${
              showFixChat ? "bg-purple-600 border-purple-500 text-white" : "bg-zinc-800/90 border-zinc-700 text-zinc-300 hover:text-white hover:bg-zinc-700"
            }`}
            title="AI 修复：打开本故事点的 AI 修复对话（把资料/配置/聊天记录发给 AI 修复问题）"
          >🩺</button>
          <button
            onClick={() => setShowArchiveManager(true)}
            className={`w-9 h-9 rounded-full shadow-lg border transition flex items-center justify-center disabled:opacity-60 ${
              archived ? "bg-green-600 border-green-500 text-white" : "bg-zinc-800/90 border-zinc-700 text-zinc-300 hover:text-white hover:bg-zinc-700"
            }`}
            title="全量存档：按原有 TXT 格式写入完整会话历史，或从 TXT 存档还原页面会话"
          >{archived ? "✓" : "💾"}</button>
          <button
            onClick={() => setConversationBackupMode("backup")}
            className="w-9 h-9 rounded-full shadow-lg border transition flex items-center justify-center bg-zinc-800/90 border-zinc-700 text-zinc-300 hover:text-white hover:bg-emerald-700"
            title="备份用户和 AI 完整对话：保存为独立 JSON 备份，不改变 TXT 全量存档"
          >⤓</button>
          <button
            onClick={() => setConversationBackupMode("restore")}
            className="w-9 h-9 rounded-full shadow-lg border transition flex items-center justify-center bg-zinc-800/90 border-zinc-700 text-zinc-300 hover:text-white hover:bg-indigo-700"
            title="还原用户和 AI 完整对话：从独立 JSON 备份恢复全部消息和元数据"
          >⤒</button>
          <button
            onClick={() => { setShowTools(true); setShowOutline(false); setShowResources(false); }}
            className="w-9 h-9 rounded-full shadow-lg border transition flex items-center justify-center bg-zinc-800/90 border-zinc-700 text-zinc-300 hover:text-white hover:bg-zinc-700"
            title="工具命令：Git Local Changes 等常用命令"
          >🛠</button>
              </div>
            </div>
          )}
        </div>

        {/* 资源管理面板 */}
        {showResources && (
          <ResourcePanel tabId={tab.id} roots={tab.refs || []} onClose={() => setShowResources(false)} onToast={onToast} />
        )}

        {/* 工具命令面板 */}
        {showTools && (
          <ToolsPanel tabId={tab.id} onClose={() => setShowTools(false)} onToast={onToast} />
        )}

        {/* Local Changes（Git）面板 —— 已移至头部按钮下方展开 */}

        {showGitUpdateScope && (
          <GitUpdateScopeModal
            repos={gitUpdateRepos}
            primaryPath={primary?.path || ""}
            onClose={() => setShowGitUpdateScope(false)}
            onSelect={(selection) => {
              setShowGitUpdateScope(false);
              onGitUpdate?.(selection);
            }}
          />
        )}

        {/* Git Push（AS 风格）面板 —— 入口在头部「标记版本」旁 */}
        {showPush && (
          <PushPanel tabId={tab.id} refreshKey={gitStatusVersion} onClose={() => setShowPush(false)} onToast={onToast} />
        )}

        {showPrPreview && (
          <PullRequestPanel
            tabId={tab.id}
            refreshKey={gitStatusVersion}
            onClose={() => { if (!creatingPr) setShowPrPreview(false); }}
            onExecute={doCreatePr}
            onToast={onToast}
          />
        )}

        {showWorktreeCleanup && (
          <WorktreeCleanupModal
            tab={tab}
            onClose={() => setShowWorktreeCleanup(false)}
            onCleaned={onRefreshTab}
            onToast={onToast}
          />
        )}

        {worktreeRebuild && (
          <WorktreeRebuildConfirmModal
            pending={worktreeRebuild}
            onClose={() => setWorktreeRebuild(null)}
            onDone={async () => {
              setWorktreeRebuild(null);
              setGitStatusVersion((v) => v + 1);
              await Promise.all([loadBranches(), loadBranchPairs(), loadFlavors(), loadApkStatus()]);
              await onRefreshTab?.();
            }}
            onToast={onToast}
          />
        )}

        {prNotice && (
          <PrNoticeModal notice={prNotice} onClose={() => setPrNotice(null)} />
        )}

        {/* 编译产物（gradle assemble）面板 —— 入口在头部「APK产物」旁；关闭只隐藏，后台打包继续，可再打开看进度 */}
        {showBuild && (
          <BuildPanel
            projects={flavors}
            build={build}
            onBuild={onBuild}
            onStop={onBuildStop}
            onClose={() => setShowBuild(false)}
            onToast={onToast}
            onBumpVersion={doBumpVersion}
            bumping={bumping}
            previewVersion={previewVersion}
            selection={buildSelection}
            onSelectionChange={onBuildSelectionChange}
          />
        )}

        {showArchiveManager && (
          <ArchiveManagerModal
            tab={tab}
            live={live}
            onClose={() => setShowArchiveManager(false)}
            onToast={onToast}
            onRefreshTab={onRefreshTab}
            onMessagesRestored={onArchiveRestored}
            onArchived={() => { setArchived(true); setTimeout(() => setArchived(false), 1800); }}
          />
        )}

        {/* AI 接收到的最终 Prompt 查看面板（居中悬浮） */}
        {aiPromptPanel && (
          <AiPromptPanel text={aiPromptPanel} onClose={() => setAiPromptPanel(null)} />
        )}

        {conversationBackupMode && (
          <ConversationBackupModal
            tab={tab}
            live={live}
            mode={conversationBackupMode}
            isRunning={isRunning || streaming}
            onClose={() => setConversationBackupMode("")}
            onToast={onToast}
            onRefreshTab={onRefreshTab}
            onMessagesRestored={onArchiveRestored}
          />
        )}

        {/* 大纲面板 */}
        {showOutline && (
          <div className="absolute right-14 top-3 z-20 w-72 max-h-[75%] flex flex-col bg-zinc-900/95 border border-zinc-700 rounded-lg shadow-2xl backdrop-blur">
            <div className="px-3 py-2 border-b border-zinc-800 flex items-center justify-between shrink-0">
              <span className="text-[11px] text-zinc-300">提问大纲（点击跳转）</span>
              <button onClick={() => setShowOutline(false)} className="text-zinc-500 hover:text-zinc-200 text-xs">✕</button>
            </div>
            <div className="overflow-y-auto py-1">
              {messages.map((m, i) => (m.role === "user" ? (
                <button
                  key={i}
                  onClick={() => jumpToMessage(i)}
                  className="w-full text-left px-3 py-1.5 flex items-center gap-2 hover:bg-zinc-800 transition group"
                  title={m.content}
                >
                  <span className="text-[10px] text-zinc-600 shrink-0 w-5 text-right">{messages.slice(0, i + 1).filter((x) => x.role === "user").length}</span>
                  <span className="text-[11px] text-zinc-300 group-hover:text-white truncate whitespace-nowrap">{(m.content || "").replace(/\n/g, " ")}</span>
                </button>
              ) : null))}
              {messages.filter((m) => m.role === "user").length === 0 && (
                <div className="px-3 py-3 text-[11px] text-zinc-600 text-center">还没有提问</div>
              )}
            </div>
          </div>
        )}

        {/* AI 修复弹窗（每故事点独立，可隐藏）：聊天只发送动作文字，完整上下文由后端注入 */}
        {showFixChat && (
          <div className="absolute right-14 top-3 z-30 w-[380px] max-w-[88vw] max-h-[82%] flex flex-col bg-zinc-900/97 border border-purple-700/50 rounded-lg shadow-2xl backdrop-blur">
            <div className="shrink-0 px-3 py-2 border-b border-zinc-800 flex items-center gap-2">
              <span className="text-[12px] font-semibold text-purple-200">🩺 AI 修复</span>
              <span className="text-[10px] text-zinc-500 truncate flex-1" title={tab.title}>{tab.title}</span>
              <button onClick={() => setShowFixChat(false)} className="text-zinc-500 hover:text-zinc-200 text-xs px-0.5">✕</button>
            </div>
            <div className="flex-1 overflow-y-auto px-3 py-2.5 text-[11px] space-y-2">
              <p className="text-zinc-300 leading-relaxed">
                点「开始修复」后，聊天中只发送<strong className="text-purple-200">“开始修复”</strong>。完整上下文由后端在 AI Provider 层自动注入，对话在左侧<strong className="text-zinc-200">主区域</strong>流式显示。
              </p>
              <div className="rounded-lg border border-zinc-800 bg-zinc-950/50 p-2.5 space-y-1">
                <div className="text-[10px] text-zinc-500 mb-1">后端将自动注入的上下文</div>
                {[
                  ["故事点", tab.title],
                  ["主工程", primary ? primary.name : "未选择"],
                  ...(localProjectCount ? [["本地工程", `${localProjectCount} 个`]] : []),
                  ...(primary?.webAppPath ? [["WebApp", "已包含"]] : []),
                  ...((tab.extraProjects || []).length ? [["关联工程", `${tab.extraProjects.length} 个`]] : []),
                  ...(primaryFlavor ? [["Flavor", primaryFlavor]] : []),
                  ["设备", tab.deviceSerial || "未绑定"],
                  ["附带材料", `${(tab.materials || []).length} 项`],
                  ["对话轮次", `${tab.turns || 0} 轮（完整历史见存档文件）`],
                ].map(([k, v]) => (
                  <div key={k} className="flex gap-2">
                    <span className="text-zinc-500 w-16 shrink-0">{k}</span>
                    <span className="text-zinc-300 truncate" title={String(v)}>{v}</span>
                  </div>
                ))}
              </div>
              <p className="text-[10px] text-zinc-600 leading-relaxed">提示：诊断信息不再重复显示为聊天正文；完整聊天历史仍在存档文件里，AI 会按需 Read。</p>
            </div>
            <div className="shrink-0 px-3 py-2.5 border-t border-zinc-800 flex items-center gap-2">
              <button onClick={copyDiagnostics} className="text-[11px] px-2 py-1.5 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-300 border border-zinc-700" title="把诊断参数复制到剪贴板（粘到外部 AI CLI 排查）">{diagCopied ? "✓ 已复制" : "📋 复制诊断"}</button>
              <button
                onClick={startFix}
                disabled={fixSending || !primary}
                className="ml-auto text-[12px] px-3 py-1.5 rounded bg-purple-600 hover:bg-purple-500 disabled:opacity-50 text-white font-medium"
              >{fixSending ? "发送中…" : "🔧 开始修复"}</button>
            </div>
          </div>
        )}
      </div>

      {/* ===== 输入区 ===== */}
      <div
        className={`relative shrink-0 border-t bg-zinc-900/40 px-4 py-3 transition ${dragOver ? "border-blue-500 bg-blue-600/10" : "border-zinc-800"}`}
        onDragOver={(e) => { e.preventDefault(); if (!dragOver) setDragOver(true); }}
        onDragLeave={(e) => { e.preventDefault(); if (e.currentTarget === e.target) setDragOver(false); }}
        onDrop={handleDrop}
      >
        {/* Git Update 进度小窗：浮在输入区上方右侧，紧凑、不遮挡输入框 */}
        {gitUpdate && (
          <div data-testid="git-update-popup" className="fixed inset-x-2 bottom-2 z-[85] flex max-h-[calc(100dvh-1rem)] items-end sm:absolute sm:inset-x-auto sm:right-4 sm:bottom-full sm:mb-2 sm:block sm:w-[560px] sm:max-w-[92vw]">
            <GitUpdateBar
              state={gitUpdate}
              onRetry={() => setShowGitUpdateScope(true)}
              onResolveAI={(c) => onGitResolveAI?.(c)}
              onToast={onToast}
              onClose={() => onGitUpdateClose?.()}
            />
          </div>
        )}
        <RepositoryPathAlertCard
          alert={repositoryPathAlert}
          onOpenStoryConfig={onOpenStoryConfig}
        />
        {/* 拖拽提示 */}
        {dragOver && (
          <div className="mb-2 text-[11px] text-blue-300 text-center border border-dashed border-blue-500/50 rounded py-1.5">
            松开以上传到本条消息；文件夹会保留层级，发送后附件将显示在用户消息气泡中
          </div>
        )}
        {/* 兼容旧故事点的持久材料；与默认“本轮附件”明确分区，避免把取消置顶误解为删除/遗忘。 */}
        {(tab.materials || []).length > 0 && (
          <details className="mb-2 rounded-lg border border-emerald-800/40 bg-emerald-950/20 px-2 py-1.5">
            <summary className="cursor-pointer select-none text-[10px] text-emerald-300/90">
              持续上下文材料 · {(tab.materials || []).length}（每轮提醒 AI，移除不会删除文件或抹除历史）
            </summary>
            <StoryAttachmentList
              tabId={tab.id}
              attachments={(tab.materials || []).map((material) => ({
                ...material,
                kind: material.fileCount ? "folder" : "file",
                scope: "pinned",
              }))}
              variant="persistent"
              onRemove={(attachment) => removeMaterial(attachment.relPath)}
              onToast={onToast}
            />
          </details>
        )}
        {/* 引用条 */}
        {replyTo && (
          <div className="mb-2 flex items-start gap-2 text-[11px] bg-zinc-800/70 border-l-2 border-blue-500 rounded px-2 py-1.5">
            <span className="text-blue-300 shrink-0">引用 {replyTo.role === "user" ? "我" : "AI"}：</span>
            <span className="text-zinc-400 truncate flex-1">{(replyTo.content || "").replace(/\n/g, " ").slice(0, 120)}</span>
            <button onClick={() => setReplyTo(null)} className="text-zinc-500 hover:text-red-400 shrink-0">✕</button>
          </div>
        )}
        {/* TB 标题行：没有关联 TB 单时整行不渲染，避免把普通故事点标题误当作 TB 标题。 */}
        {isTbTicket && (
          <div data-testid="tb-title-line">
            <MarqueeLine
              className="mb-1.5 text-[11px] font-mono text-zinc-400"
              title={`${tab.title}${primary ? `　|　${primary.name}：${primary.path}` : ""}`}
            >
              <span className="text-zinc-300">{tab.title}</span>
              {primary && (
                <>
                  <span className="text-zinc-600 mx-2">|</span>
                  <span className="text-emerald-300">{primary.name}：{primary.path}</span>
                </>
              )}
            </MarqueeLine>
          </div>
        )}
        <div className="mb-2 flex min-w-0 items-start gap-2 sm:pr-4">
          <div
            role="status"
            aria-live="polite"
            data-testid="story-input-run-status"
            data-state={inputRunStatus.state}
            className={`flex min-w-0 max-w-full flex-1 flex-wrap items-center gap-x-1.5 gap-y-0.5 overflow-hidden rounded border px-2 py-1 text-[11px] ${inputRunStatusTone}`}
            title={inputRunStatus.text}
          >
            <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${inputRunStatusDot} ${inputRunStatus.animated ? "animate-pulse" : ""}`} />
            <span className="shrink-0 font-medium">{inputRunStatus.label}</span>
            {inputRunStatus.details.map((part, index) => (
              <React.Fragment key={`${index}:${part}`}>
                {index > 0 && <span className="shrink-0 opacity-45">·</span>}
                <span className="min-w-0 break-words font-mono text-current opacity-90">{part}</span>
              </React.Fragment>
            ))}
          </div>
          {inputRunStatus.canStop && onStop && (
            <StopAiButton onConfirm={onStop} />
          )}
        </div>
        {pendingAiMessages.length > 0 && (
          <div data-testid="devbench-pending-ai-queue" className="mb-2 rounded border border-amber-500/30 bg-amber-950/20 px-2.5 py-1.5 text-[11px] text-amber-100/90">
            <div className="font-medium">待发送给 AI · {pendingAiMessages.length} 条</div>
            <div className="mt-1 space-y-0.5 text-amber-200/70">
              {pendingAiMessages.slice(0, 3).map((message, index) => {
                const text = queuedMessageText(message).replace(/\s+/g, " ");
                const blocked = message?.deliveryState?.status === "blocked";
                return (
                  <div key={message?.deviceRuntimeTaskId || index} className={blocked ? "rounded border border-red-500/35 bg-red-950/20 p-1.5" : "truncate"} title={text}>
                    <div className="truncate">{index + 1}. {text}</div>
                    {blocked && index === 0 && (
                      <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[10px]">
                        <span className="min-w-0 flex-1 text-red-200" title={message.deliveryState.error}>
                          已阻断：{message.deliveryState.error}
                        </span>
                        <button
                          type="button"
                          disabled={!!queueAction}
                          onClick={() => retryBlockedQueueHead(message)}
                          className="rounded border border-amber-400/50 px-2 py-0.5 text-amber-100 hover:bg-amber-900/40 disabled:opacity-50"
                        >{queueAction === "retry" ? "重试中…" : "重试"}</button>
                        <button
                          type="button"
                          disabled={!!queueAction}
                          onClick={() => cancelBlockedQueueHead(message)}
                          className="rounded border border-red-400/50 px-2 py-0.5 text-red-100 hover:bg-red-900/40 disabled:opacity-50"
                        >{queueAction === "cancel" ? "取消中…" : "取消"}</button>
                      </div>
                    )}
                  </div>
                );
              })}
              {pendingAiMessages.length > 3 && <div>另有 {pendingAiMessages.length - 3} 条…</div>}
            </div>
          </div>
        )}
        <div className="flex flex-wrap items-end gap-2" data-testid="devbench-story-composer-row">
          <div className="min-w-[min(12rem,100%)] flex-1 overflow-visible rounded-lg border border-zinc-700 bg-zinc-800 focus-within:border-zinc-500" data-testid="devbench-story-composer-input">
            {(attachments.length > 0 || uploading) && (
              <div className="border-b border-zinc-700/70 pb-2">
                <StoryAttachmentList
                  tabId={tab.id}
                  attachments={attachments}
                  label="本轮附件 · 发送后将进入用户消息"
                  variant="composer"
                  onRemove={(_attachment, index) => setAttachments((prev) => {
                    const removed = prev[index];
                    if (removed?.preview) URL.revokeObjectURL(removed.preview);
                    return prev.filter((_, currentIndex) => currentIndex !== index);
                  })}
                  onToast={onToast}
                />
                {uploading && <div className="px-2 pt-1 text-[10px] text-blue-300">正在上传附件…</div>}
              </div>
            )}
            <StoryChatInput
              key={draftKey}
              ref={storyInputRef}
              draftKey={draftKey}
              history={inputHistory}
              nextSuggestion={tab.nextSuggestion || ""}
              primary={!!primary}
              disabled={!primary || queued || copying || backgroundInitializing || backgroundInitializationFailed}
              placeholder={backgroundInitializing
                ? (remoteInitializing ? "远程源码正在后台初始化，完成后即可对话" : "工作区正在后台初始化，完成后即可对话")
                : backgroundInitializationFailed
                  ? "后台初始化失败，请先点击上方“重试初始化”"
                  : copying ? "工程复制中：完成后才能对话/编辑/下载附件" : (queued ? "排队中：仅可查看/下载附件，设为当前活动后才能对话" : (!primary ? "请先选择主工程" : "描述要在该工程做的事…（Ctrl+Enter 发送，↑/↓ 历史，→ 补全，可粘贴文件/图片）"))}
              onSubmit={doSend}
              onPaste={onPasteInput}
            />
          </div>
          {isClientNode ? (
            <CenterSwitchButton tab={tab} isRunning={isRunning || streaming} centerServers={centerServers} centerConfig={centerConfig} onSetCenter={onSetCenter} onToast={onToast} variant="pill" />
          ) : (
            <EngineSwitchButton tab={tab} isRunning={isRunning || streaming} onRefreshTab={onRefreshTab} onToast={onToast} variant="pill"
              status={engineStatus} statusLoading={engineStatusLoading} onRefreshStatus={refreshEngineStatus} metadata={engineMetadata} />
          )}
          <button
            onClick={clearInput}
            className="shrink-0 px-3 py-2 text-sm rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-300 hover:text-white disabled:bg-zinc-800/50 disabled:text-zinc-600 border border-zinc-700 transition"
            title="清空输入框内容（含本轮附件引用/引用消息），会弹窗确认"
          >清空</button>
          <button
            onClick={doSend}
            disabled={sending || !primary || queued || copying || backgroundInitializing || backgroundInitializationFailed}
            className={`shrink-0 px-4 py-2 text-sm rounded-lg disabled:bg-zinc-700 disabled:text-zinc-500 text-white transition ${(isRunning || streaming) ? "bg-amber-600 hover:bg-amber-500" : "bg-blue-600 hover:bg-blue-500"}`}
            title={copying ? "工程复制中，完成后可对话" : (isRunning || streaming)
              ? (realtimeAppend ? "AI 正在工作——优先实时追加到当前回合，失败时自动进入持久队列" : "当前接入不支持回合内追加——消息会进入持久队列")
              : ""}
          >
            {storyComposerSubmitLabel({ copying, sending, isRunning, streaming, realtimeAppend })}
          </button>
        </div>
      </div>

      {/* 版本号操作 悬浮窗：加10 / 提升为交付版本 / 更新测试版本号 */}
      {versionPopup && (() => {
        const nxt = previewVersion(versionPopup.versionName, "bump10", versionPopup.versionCode);
        const dlv = previewVersion(versionPopup.versionName, "deliver", versionPopup.versionCode);
        const tst = previewVersion(versionPopup.versionName, "test", versionPopup.versionCode);
        return (
          <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50" onClick={() => setVersionPopup(null)}>
            <div className="w-[460px] max-w-[92vw] bg-zinc-900 border border-zinc-700 rounded-xl shadow-2xl" onClick={(e) => e.stopPropagation()}>
              <div className="px-4 py-3 border-b border-zinc-800 flex items-center gap-2">
                <span className="text-sm font-semibold text-zinc-100">版本号管理</span>
                <span className="text-[11px] text-zinc-500 truncate">{versionPopup.name}</span>
                <button onClick={() => setVersionPopup(null)} className="ml-auto text-zinc-500 hover:text-zinc-200 text-sm px-1">✕</button>
              </div>
              <div className="px-4 py-4 space-y-3 text-sm">
                <div className="flex items-center gap-2 font-mono">
                  <span className="text-[10px] text-zinc-500">当前</span>
                  <span className="text-zinc-200">{versionPopup.versionName}</span>
                  <span className="text-[11px] text-zinc-500">#{versionPopup.versionCode}</span>
                </div>
                <p className="text-[11px] text-zinc-500 leading-relaxed">
                  末段按两位修订号处理（尾 0 默认省略，如 1.1.7 即 1.1.70），versionCode 兼容末段 2 位或 3 位历史写法；
                  写回 <strong className="text-zinc-300">该 flavor 的版本（flavorConfig.json 或 project_flavor.gradle 对应块）</strong> 并刷新显示。
                </p>
                <div className="space-y-2 pt-1">
                  <button onClick={() => doBumpVersion(versionPopup.path, "bump10")} disabled={bumping}
                    className="w-full flex items-center justify-between px-3 py-2 text-xs rounded-lg bg-fuchsia-600 hover:bg-fuchsia-500 disabled:bg-zinc-700 disabled:text-zinc-500 text-white transition">
                    <span>应用加 10</span><span className="font-mono">{bumping ? "写入中…" : `→ ${nxt.name}  #${nxt.code}`}</span>
                  </button>
                  <button onClick={() => doBumpVersion(versionPopup.path, "deliver")} disabled={bumping}
                    className="w-full flex items-center justify-between px-3 py-2 text-xs rounded-lg bg-emerald-700 hover:bg-emerald-600 disabled:bg-zinc-700 disabled:text-zinc-500 text-white transition"
                    title="向上取到最近的尾号为 0 的版本，如 1.1.01/1.1.07 → 1.1.10">
                    <span>提升为交付版本</span><span className="font-mono">{bumping ? "写入中…" : `→ ${dlv.name}  #${dlv.code}`}</span>
                  </button>
                  <button onClick={() => doBumpVersion(versionPopup.path, "test")} disabled={bumping}
                    className="w-full flex items-center justify-between px-3 py-2 text-xs rounded-lg bg-sky-700 hover:bg-sky-600 disabled:bg-zinc-700 disabled:text-zinc-500 text-white transition"
                    title="加一且尾号不为 0，如 1.1.01 → 1.1.02、1.1.09 → 1.1.11">
                    <span>更新测试版本号</span><span className="font-mono">{bumping ? "写入中…" : `→ ${tst.name}  #${tst.code}`}</span>
                  </button>
                  <button onClick={() => setVersionPopup(null)} className="w-full px-3 py-1.5 text-xs rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-300 transition">取消</button>
                </div>
              </div>
            </div>
          </div>
        );
      })()}

      {showArchiveDirPicker && (
        <FolderPickerModal
          initialPath={archiveDirDraft || tab.defaultArchiveDir || ""}
          title="选择存档目录"
          onPick={(p) => saveArchiveDir(p)}
          onClose={() => setShowArchiveDirPicker(false)}
        />
      )}

      {/* 重命名故事点名字 悬浮窗（名字较长时展开编辑，不再在头部就地拥挤） */}
      {editingTitle && (
        <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/50" onClick={(e) => e.stopPropagation()}>
          <div className="w-[560px] max-w-[94vw] bg-zinc-900 border border-zinc-700 rounded-xl shadow-2xl" onClick={(e) => e.stopPropagation()}>
            <div className="px-4 py-3 border-b border-zinc-800 flex items-center gap-2">
              <span className="text-sm font-semibold text-zinc-100">重命名故事点</span>
              <button onClick={() => setEditingTitle(false)} className="ml-auto text-zinc-500 hover:text-zinc-200 text-sm px-1">✕</button>
            </div>
            <div className="px-4 py-4 space-y-3">
              <div className="text-[11px] text-zinc-500">当前名字</div>
              <div className="text-xs text-zinc-400 bg-zinc-950/60 border border-zinc-800 rounded px-2 py-1.5 font-mono break-all">{tab.title}</div>
              <div className="text-[11px] text-zinc-500">新名字</div>
              <textarea
                autoFocus
                rows={3}
                value={titleDraft}
                onChange={(e) => setTitleDraft(e.target.value)}
                className="w-full bg-zinc-800 border border-zinc-700 rounded px-3 py-2 text-sm text-zinc-100 outline-none focus:border-sky-600 resize-y break-all leading-relaxed"
                placeholder="输入新的故事点名字…"
              />
              <div className="flex items-center gap-2 pt-1">
                <button
                  onClick={() => { if (titleDraft.trim() && titleDraft.trim() !== tab.title) onRename(titleDraft.trim()); setEditingTitle(false); }}
                  disabled={!titleDraft.trim() || titleDraft.trim() === tab.title}
                  className="px-3 py-1.5 text-xs rounded-lg bg-sky-600 hover:bg-sky-500 disabled:bg-zinc-700 disabled:text-zinc-500 text-white transition"
                >保存</button>
                <button onClick={() => setEditingTitle(false)} className="px-3 py-1.5 text-xs rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-300 transition">取消</button>
                <span className="ml-auto text-[10px] text-zinc-600">仅点击关闭、保存或取消后退出</span>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* 关联 TB 单备注 图文预览悬浮窗 */}
      {notePopup && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50" onClick={() => setNotePopup(null)}>
          <div className="w-[760px] max-w-[94vw] max-h-[86vh] flex flex-col bg-zinc-900 border border-zinc-700 rounded-xl shadow-2xl" onClick={(e) => e.stopPropagation()}>
            <div className="px-4 py-3 border-b border-zinc-800 flex items-center gap-2 shrink-0">
              <span className="text-sm font-semibold text-zinc-100">📝 TB 单备注</span>
              {notePopup.data?.renderMode && <span className="text-[10px] text-zinc-600">{notePopup.data.renderMode === "rtf" ? "富文本" : "文本"}</span>}
              {tab.ticketUrl && (
                <a href={tab.ticketUrl} target="_blank" rel="noopener noreferrer" className="text-[11px] text-sky-400 hover:text-sky-300 underline">在 TB 打开</a>
              )}
              <button onClick={() => setNotePopup(null)} className="ml-auto text-zinc-500 hover:text-zinc-200 text-sm px-1">✕</button>
            </div>
            <div className="px-5 py-4 overflow-auto text-sm text-zinc-200 leading-relaxed">
              {notePopup.loading && <div className="text-zinc-500 py-8 text-center">加载备注中…</div>}
              {notePopup.error && <div className="text-red-400 py-8 text-center">{notePopup.error}</div>}
              {notePopup.data && !notePopup.data.hasNote && <div className="text-zinc-500 py-8 text-center">该 TB 单没有备注</div>}
              {notePopup.data?.hasNote && (
                <div className="tb-note-html" dangerouslySetInnerHTML={{ __html: notePopup.data.html || "" }} />
              )}
            </div>
            {notePopup.data?.hasNote && (
              <div className="px-4 py-3 border-t border-zinc-800 flex items-center gap-2 shrink-0">
                <span className="text-[11px] text-zinc-500">
                  {notePopup.data.imageCount ? `含 ${notePopup.data.imageCount} 张图` : "纯文字"}
                  {notePopup.data.links?.length ? ` · ${notePopup.data.links.length} 个链接` : ""}
                </span>
                {notePopup.downloaded ? (
                  <span className="text-[11px] text-emerald-400 ml-auto" title={`${notePopup.downloaded.relDir}/note.md`}>
                    ✓ 已下载到 {notePopup.downloaded.relDir}/（{notePopup.downloaded.downloaded}/{notePopup.downloaded.imageCount} 图）
                  </span>
                ) : (
                  <button onClick={doDownloadNote} disabled={notePopup.downloading}
                    className="ml-auto px-3 py-1.5 text-xs rounded-lg bg-sky-600 hover:bg-sky-500 disabled:bg-zinc-700 disabled:text-zinc-500 text-white transition"
                    title="把备注文字与图片下载到克隆父路径 AllDocs/StoryDev/<故事点>/archives/，并作为上下文提供给 AI">
                    {notePopup.downloading ? "下载中…" : "⬇ 下载到 archives"}
                  </button>
                )}
              </div>
            )}
          </div>
        </div>
      )}

      {/* 关联 TB 单附件列表悬浮窗（替代已关闭的旧配置区入口） */}
      {attachPopup && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50" onClick={() => setAttachPopup(false)}>
          <div className="w-[640px] max-w-[94vw] max-h-[86vh] flex flex-col bg-zinc-900 border border-zinc-700 rounded-xl shadow-2xl" onClick={(e) => e.stopPropagation()}>
            <div className="px-4 py-3 border-b border-zinc-800 flex items-center gap-2 shrink-0">
              <span className="text-sm font-semibold text-zinc-100">📎 TB 单附件</span>
              {tab.ticketUrl && (
                <a href={tab.ticketUrl} target="_blank" rel="noopener noreferrer" className="text-[11px] text-sky-400 hover:text-sky-300 underline">在 TB 打开</a>
              )}
              <button onClick={() => setAttachPopup(false)} className="ml-auto text-zinc-500 hover:text-zinc-200 text-sm px-1">✕</button>
            </div>
            <div className="px-4 py-3 overflow-auto">
              <TbAttachments tabId={tab.id} ticketUrl={tab.ticketUrl} compact />
            </div>
          </div>
        </div>
      )}

      {/* 关联的 TB 单不在任务列表 → 询问是否加入 */}
      {addTaskPrompt && (
        <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/50" onClick={() => confirmAddTask(false)}>
          <div className="w-[400px] max-w-[92vw] bg-zinc-900 border border-zinc-700 rounded-xl shadow-2xl" onClick={(e) => e.stopPropagation()}>
            <div className="px-4 py-3 border-b border-zinc-800 text-sm font-semibold text-zinc-100">添加到任务列表？</div>
            <div className="px-4 py-4 text-sm text-zinc-300 leading-relaxed">
              该 TB 单
              <span className="mx-1 px-1.5 py-0.5 rounded bg-zinc-800 text-amber-300 font-mono text-[11px]">{addTaskPrompt.carbId || addTaskPrompt.tbTaskId}</span>
              {addTaskPrompt.title ? <span className="text-zinc-400">「{addTaskPrompt.title}」</span> : null}
              还不在任务列表中，是否添加到待办任务列表？
            </div>
            <div className="px-4 py-3 border-t border-zinc-800 flex items-center justify-end gap-2">
              <button onClick={() => confirmAddTask(false)} className="px-3 py-1.5 text-xs rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-300 transition">否</button>
              <button onClick={() => confirmAddTask(true)} className="px-3 py-1.5 text-xs rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white transition">是，添加</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function firstPresent(obj, keys) {
  for (const key of keys) {
    if (obj && obj[key] != null && obj[key] !== "") return obj[key];
  }
  return null;
}

function firstUsageNumber(obj, keys) {
  const value = firstPresent(obj, keys);
  if (value == null) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function fmtToken(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return "0";
  const abs = Math.abs(v);
  return abs >= 1000000 ? `${(v / 1000000).toFixed(2)}M`
    : abs >= 1000 ? `${(v / 1000).toFixed(1)}K`
    : String(Math.round(v));
}

function fmtMoney(n, symbol = "$") {
  const v = Number(n);
  if (!Number.isFinite(v)) return "";
  const abs = Math.abs(v);
  const digits = abs === 0 ? 0 : abs < 0.01 ? 6 : abs < 1 ? 4 : 2;
  return `${symbol}${v.toFixed(digits).replace(/\.?0+$/, "")}`;
}

function usageText(u, engine = "") {
  if (!u) return "";
  const input = firstUsageNumber(u, ["inputTokens", "input_tokens", "promptTokens", "prompt_tokens"]);
  const output = firstUsageNumber(u, ["outputTokens", "output_tokens", "completionTokens", "completion_tokens"]);
  const cacheRead = firstUsageNumber(u, [
    "cacheReadTokens", "cache_read_input_tokens", "cache_read_tokens",
    "prompt_cache_hit_tokens", "cacheHitTokens", "cachedTokens", "cached_tokens",
  ]);
  const cacheCreate = firstUsageNumber(u, ["cacheCreationTokens", "cache_creation_input_tokens", "cacheWriteTokens", "cache_write_tokens"]);
  const totalRaw = firstUsageNumber(u, ["totalTokens", "total_tokens", "totalTokenCount", "total_token_count"]);
  const computedTotal = [input, output, cacheRead].reduce((sum, n) => sum + (Number.isFinite(n) ? n : 0), 0);
  const total = totalRaw != null ? totalRaw : (computedTotal > 0 ? computedTotal : null);
  const costUsd = firstUsageNumber(u, ["costUsd", "total_cost_usd", "cost_usd", "localCostUsd", "local_cost_usd"]);
  const costCny = firstUsageNumber(u, ["costCny", "cost_cny", "localCostCny", "local_cost_cny"]);
  const balanceUsd = firstUsageNumber(u, ["balanceUsd", "balance_usd", "deepseekBalanceUsd", "deepseek_balance_usd", "remainingBalanceUsd", "remaining_balance_usd"]);
  const balanceCny = firstUsageNumber(u, ["balanceCny", "balance_cny", "deepseekBalanceCny", "deepseek_balance_cny", "remainingBalanceCny", "remaining_balance_cny"]);
  const balance = firstUsageNumber(u, ["balance", "deepseekBalance", "deepseek_balance", "remainingBalance", "remaining_balance", "availableBalance", "available_balance"]);
  const isDeepSeek = /deepseek/i.test(String(engine || u.engine || u.model || ""));
  const parts = [];
  if (input != null) parts.push(`输入 ${fmtToken(input)}`);
  if (output != null) parts.push(`输出 ${fmtToken(output)}`);
  if (cacheRead != null) parts.push(`缓存命中 ${fmtToken(cacheRead)}`);
  if (cacheCreate != null) parts.push(`缓存写入 ${fmtToken(cacheCreate)}`);
  if (total != null) parts.push(`总消耗 ${fmtToken(total)}`);
  if (costUsd != null) parts.push(`本地花费 ${fmtMoney(costUsd, "$")}`);
  else if (costCny != null) parts.push(`本地花费 ${fmtMoney(costCny, "¥")}`);
  if (isDeepSeek || balanceUsd != null || balanceCny != null || balance != null) {
    if (balanceUsd != null) parts.push(`DeepSeek余额 ${fmtMoney(balanceUsd, "$")}`);
    else if (balanceCny != null) parts.push(`DeepSeek余额 ${fmtMoney(balanceCny, "¥")}`);
    else if (balance != null) parts.push(`DeepSeek余额 ${balance}`);
  }
  return parts.join(" · ");
}

function toTimeMs(value) {
  if (value == null || value === "") return null;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return null;
    return value > 0 && value < 1000000000000 ? value * 1000 : value;
  }
  const parsedNumber = Number(value);
  if (Number.isFinite(parsedNumber) && String(value).trim() !== "") {
    return parsedNumber > 0 && parsedNumber < 1000000000000 ? parsedNumber * 1000 : parsedNumber;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function toDurationMs(value) {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(0, n) : null;
}

function formatClock(ts) {
  const t = toTimeMs(ts);
  if (t == null) return "";
  try { return new Date(t).toLocaleTimeString("zh-CN", { hour12: false }); } catch { return ""; }
}

function formatMessageTime(ts) {
  return formatHistoryAwareTime(ts) || formatClock(ts);
}

function formatDuration(ms) {
  const n = toDurationMs(ms);
  if (n == null) return "";
  const total = Math.max(0, Math.round(n / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h) return `${h}时${String(m).padStart(2, "0")}分${String(s).padStart(2, "0")}秒`;
  if (m) return `${m}分${String(s).padStart(2, "0")}秒`;
  return `${s}秒`;
}

function messageTimingText(msg) {
  if (!msg) return "";
  const explicitStart = firstPresent(msg, ["startedAt", "started_at", "startTime", "start_time"]);
  const explicitEnd = firstPresent(msg, ["endedAt", "ended_at", "endTime", "end_time"]);
  const created = toTimeMs(firstPresent(msg, ["created_at", "createdAt", "ts"]));
  if (msg.role === "user") return created != null ? `发送 ${formatMessageTime(created)}` : "";

  const hasTurnTiming = explicitStart != null || explicitEnd != null || msg.durationMs != null;
  if (!hasTurnTiming) return created != null ? `时间 ${formatMessageTime(created)}` : "";

  const startedAt = toTimeMs(explicitStart) ?? created;
  const durationMs = toDurationMs(msg.durationMs);
  const endedAt = toTimeMs(explicitEnd) ?? (startedAt != null && durationMs != null ? startedAt + durationMs : created);
  const finalDuration = durationMs ?? (startedAt != null && endedAt != null ? Math.max(0, endedAt - startedAt) : null);
  const parts = [];
  if (startedAt != null) parts.push(`开始 ${formatMessageTime(startedAt)}`);
  if (endedAt != null) parts.push(`结束 ${formatMessageTime(endedAt)}`);
  if (finalDuration != null) parts.push(`耗时 ${formatDuration(finalDuration)}`);
  return parts.join(" · ");
}

function liveTimingText(live, now = Date.now()) {
  if (!live) return "";
  const startedAt = toTimeMs(firstPresent(live, ["startedAt", "started_at", "startTime", "start_time", "ts"]));
  if (startedAt == null) return "";
  const explicitEnd = toTimeMs(firstPresent(live, ["endedAt", "ended_at", "endTime", "end_time"]));
  const endedAt = live.streaming ? null : (explicitEnd ?? now);
  const durationMs = toDurationMs(live.durationMs) ?? Math.max(0, (endedAt ?? now) - startedAt);
  const parts = [`开始 ${formatClock(startedAt)}`];
  if (endedAt != null) parts.push(`结束 ${formatClock(endedAt)}`);
  parts.push(`${live.streaming ? "已运行" : "耗时"} ${formatDuration(durationMs)}`);
  const progressState = String(live.progressState || live.progress_state || "");
  const lastMeaningful = toTimeMs(firstPresent(live, ["lastMeaningfulProgressAt", "last_meaningful_progress_at"]));
  if (["warning", "cancelling", "termination_unconfirmed"].includes(progressState) && lastMeaningful != null) {
    parts.push(`最近业务推进 ${formatClock(lastMeaningful)}`);
    parts.push(`未推进 ${formatDuration(Math.max(0, now - lastMeaningful))}`);
  }
  return parts.join(" · ");
}

// 完成卡片上的经验导出按钮：加入工程 docs/wiki / 写入工程 CLAUDE.md 已知问题段
function WorkflowExportButtons({ tabId, onToast }) {
  const [busy, setBusy] = useState("");
  const [done, setDone] = useState({});
  const run = async (key, fn, okMsg) => {
    setBusy(key);
    const r = await fn();
    setBusy("");
    if (r?.ok) { setDone((d) => ({ ...d, [key]: true })); onToast?.(okMsg(r.data)); }
    else onToast?.(r?.error || "操作失败");
  };
  return (
    <div className="mt-2.5 flex items-center gap-2 flex-wrap">
      <button disabled={busy === "wiki"} onClick={() => run("wiki", () => devbenchApi.workflowWiki(tabId), (d) => `已加入 Wiki：${d?.rel || ""}`)}
        className="text-[12px] px-3 py-1.5 rounded bg-indigo-600/80 hover:bg-indigo-600 text-white border border-indigo-500/60 disabled:opacity-50 transition">
        {done.wiki ? "✓ 已加入 Wiki" : busy === "wiki" ? "生成中…" : "📚 加入 Wiki"}
      </button>
      <button disabled={busy === "cmd"} onClick={() => run("cmd", () => devbenchApi.workflowClaudeMd(tabId), () => "已写入工程 CLAUDE.md 已知问题段")}
        className="text-[12px] px-3 py-1.5 rounded bg-zinc-700 hover:bg-zinc-600 text-zinc-100 border border-zinc-600 disabled:opacity-50 transition">
        {done.cmd ? "✓ 已写入 CLAUDE.md" : busy === "cmd" ? "写入中…" : "📝 写入工程 CLAUDE.md"}
      </button>
      <span className="text-[10px] text-zinc-500">经验已自动入库并会在后续甄别/开发时参考；此处可额外导出</span>
    </div>
  );
}

// 全自动工作流系统卡片（醒目展示甄别结论/状态流转结果，必要时给"确认拒绝"/经验导出按钮）
function WorkflowCard({ msg, onReject, tabId, onToast }) {
  const wf = msg.workflow || {};
  const level = wf.level || "info";
  const cls = level === "warn"
    ? "bg-amber-500/10 border-amber-500/50"
    : level === "success"
    ? "bg-emerald-500/10 border-emerald-500/50"
    : "bg-blue-500/10 border-blue-500/40";
  const isRejectPending = wf.alert?.kind === "reject_pending";
  const [confirming, setConfirming] = useState(false);
  const [done, setDone] = useState(false);
  const artifactCandidates = [
    ["detailRel", wf.alert?.detailRel, "详细报告"],
    ["htmlRel", wf.alert?.htmlRel, "HTML 报告"],
    ["pdfRel", wf.alert?.pdfRel, "PDF 报告"],
    ...Object.entries(wf.alert?.artifacts || {}).map(([key, artifact]) => [
      key,
      artifact,
      ({
        original: "原始结论 TXT",
        html: "完整报告 HTML",
        pdf: "完整报告 PDF",
        image: "钉钉摘要 PNG",
        manifest: "产物清单",
      })[key] || artifact?.name || key,
    ]),
  ];
  const seenArtifacts = new Set();
  const artifactLinks = artifactCandidates.filter(([, artifact]) => {
    const rel = String(artifact?.rel || artifact || "");
    if (!rel || seenArtifacts.has(rel)) return false;
    seenArtifacts.add(rel);
    return true;
  });
  return (
    <div className="flex justify-start">
      <div className={`max-w-[88%] w-full rounded-lg px-3.5 py-2.5 border ${cls}`}>
        <div className="text-sm text-zinc-100">
          <StoryMessageMarkdown tabId={tabId} onToast={onToast}>{msg.content}</StoryMessageMarkdown>
        </div>
        <ArtifactPathLinks tabId={tabId} content={msg.content} onToast={onToast} />
        {artifactLinks.length > 0 && (
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            {artifactLinks.map(([key, artifact, label]) => (
              <StoryArtifactLink
                key={`${key}:${artifact?.rel || artifact}`}
                tabId={tabId}
                artifact={artifact}
                label={label}
                onToast={onToast}
              />
            ))}
          </div>
        )}
        {isRejectPending && !done && (
          <div className="mt-2.5 flex items-center gap-2">
            {!confirming ? (
              <button onClick={() => setConfirming(true)}
                className="text-[12px] px-3 py-1.5 rounded bg-red-600/80 hover:bg-red-600 text-white border border-red-500/60 transition">
                确认拒绝该 TB 单
              </button>
            ) : (
              <>
                <span className="text-[11px] text-amber-300">将切「已拒绝」并写入 TB 评论+附件，不可撤销：</span>
                <button onClick={async () => { setDone(true); await onReject?.(); }}
                  className="text-[12px] px-3 py-1.5 rounded bg-red-600 hover:bg-red-500 text-white transition">确定拒绝</button>
                <button onClick={() => setConfirming(false)}
                  className="text-[12px] px-3 py-1.5 rounded bg-zinc-700 hover:bg-zinc-600 text-zinc-200 transition">取消</button>
              </>
            )}
          </div>
        )}
        {isRejectPending && done && (
          <div className="mt-2 text-[11px] text-zinc-400">已提交拒绝处理，请查看下方结果。</div>
        )}
        {/* 修复完成/已拒绝卡片：经验已自动入库，额外提供导出到 Wiki / 工程 CLAUDE.md */}
        {wf.alert?.canExport && tabId && <WorkflowExportButtons tabId={tabId} onToast={onToast} />}
      </div>
    </div>
  );
}

function ToolCommandSection({ tools, live = false }) {
  const commands = (Array.isArray(tools) ? tools : [])
    .map((item) => {
      if (item && typeof item === "object") {
        const name = String(item.content || "").trim();
        const detail = String(item.input || name).trim();
        return { name: item.input && name !== detail ? name : "", detail };
      }
      return { name: "", detail: String(item || "").trim() };
    })
    .filter((item) => item.detail);
  if (!commands.length) return null;
  return (
    <details
      className="group mb-2 w-full min-w-0 overflow-hidden rounded border border-violet-500/30 bg-violet-600/10 font-mono text-[10px] text-violet-200"
      data-testid={live ? "live-tool-command-section" : "history-tool-command-section"}
      data-command-count={commands.length}
    >
      <summary
        className="flex min-w-0 cursor-pointer list-none items-center gap-1.5 px-2 py-1 marker:content-none hover:bg-violet-500/10"
        aria-label={`命令区域，共 ${commands.length} 条`}
      >
        <span className="shrink-0" aria-hidden="true">🔧</span>
        <span className="shrink-0">命令</span>
        <span className="shrink-0 rounded bg-violet-500/15 px-1 text-[9px] text-violet-300/80">{commands.length}</span>
        <span className="ml-auto shrink-0 text-[9px] text-violet-400/70 group-open:hidden">展开</span>
        <span className="ml-auto hidden shrink-0 text-[9px] text-violet-400/70 group-open:inline">收起</span>
      </summary>
      <div className="max-h-72 space-y-2 overflow-auto border-t border-violet-500/20 bg-zinc-950/75 px-2 py-2">
        {(() => {
          // 短命令（单行且不长）用紧凑矩形标签卡片内联排列，节省纵向空间；
          // 长命令（多行或超长）保留“命令 N + 完整参数”的块状展示。
          const SHORT_MAX_LEN = 40;
          const isShort = (c) => {
            const d = c.detail || "";
            return !d.includes("\n") && d.length <= SHORT_MAX_LEN;
          };
          const shortList = commands.filter(isShort);
          const longList = commands.map((command, index) => ({ command, index })).filter(({ command }) => !isShort(command));
          return (
            <>
              {shortList.length > 0 && (
                <div className="flex flex-wrap gap-1" data-testid="tool-command-chips">
                  {shortList.map((command, idx) => {
                    const label = command.name || command.detail;
                    return (
                      <span
                        key={`short-${idx}-${command.name}-${command.detail}`}
                        data-testid="tool-command-item"
                        className="inline-flex max-w-full items-center rounded border border-violet-500/30 bg-violet-600/15 px-1.5 py-0.5 font-mono text-[10px] text-violet-200"
                        title={command.detail}
                      >
                        <span className="min-w-0 truncate">{label}</span>
                      </span>
                    );
                  })}
                </div>
              )}
              {longList.map(({ command, index }) => (
                <div key={`${index}-${command.name}-${command.detail}`} data-testid="tool-command-item" className="min-w-0">
                  <div className="mb-1 flex min-w-0 items-center gap-1 text-[9px] text-violet-400/70">
                    <span className="shrink-0">命令 {index + 1}</span>
                    {command.name && <span className="min-w-0 truncate text-violet-300/60" title={command.name}>· {command.name}</span>}
                  </div>
                  <pre className="whitespace-pre-wrap break-all text-[10px] leading-relaxed text-zinc-300">{command.detail}</pre>
                </div>
              ))}
            </>
          );
        })()}
      </div>
    </details>
  );
}

function tailLogText(text, maxLines = 80, maxChars = 12000) {
  const value = String(text || "");
  const clipped = value.length > maxChars ? value.slice(-maxChars) : value;
  const lines = clipped.split("\n");
  return lines.length > maxLines ? lines.slice(-maxLines).join("\n") : clipped;
}

function centerServiceText(center, engine) {
  const engineId = String(engine || "");
  const engineText = engineId === "center" || engineId === "distributed-center" ? "" : (engine ? engineDisplayName(engine, engine) : "");
  if (!center) return engineText || "AI 服务";
  if (center.mode !== "center") {
    const localName = String(center.label || center.nodeName || center.nodeId || "").trim();
    const target = localName && localName !== "本机" ? localName : "";
    if (engineText && target) return `${target} · ${engineText}`;
    return engineText || target || "本机";
  }
  const target = `中心机 ${center.label || center.host || ""}`.trim();
  return engineText ? `${target} · ${engineText}` : target;
}

function CenterServiceBadge({ center, engine }) {
  if (!center && !engine) return null;
  const isCenter = center?.mode === "center";
  const title = isCenter ? (center?.host || center?.label || "") : "当前为本机模式，不显示局域网通信日志";
  return (
    <span className={`inline-flex min-w-0 max-w-full items-center gap-1 rounded border px-1.5 py-0.5 text-[10px] ${
      isCenter ? "border-emerald-600/40 bg-emerald-900/20 text-emerald-200" : "border-zinc-600 bg-zinc-800/70 text-zinc-300"
    }`} title={title}>
      <span className="shrink-0">{isCenter ? "中心机" : "本机模式"}</span>
      <span className="min-w-0 truncate">{centerServiceText(center, engine)}</span>
    </span>
  );
}

function formatCommTime(ts) {
  try { return new Date(ts || Date.now()).toLocaleTimeString("zh-CN", { hour12: false }); } catch { return ""; }
}

function CommLogPanel({ logs, live = false }) {
  const list = Array.isArray(logs) ? logs : [];
  if (!list.length) return null;
  return (
    <details className="mb-2 rounded border border-zinc-700/60 bg-zinc-950/40 px-2 py-1.5" open={live}>
      <summary className="cursor-pointer select-none text-[11px] text-zinc-400">通信日志 · {list.length}</summary>
      <div className="mt-1 max-h-40 overflow-y-auto space-y-1 font-mono text-[10px] text-zinc-500">
        {list.map((item, i) => (
          <div key={`${item.ts || i}-${i}`} className="flex gap-1.5">
            <span className="shrink-0 text-zinc-600">{formatCommTime(item.ts)}</span>
            {item.phase && <span className="shrink-0 text-zinc-500">[{item.phase}]</span>}
            <span className="min-w-0 break-words text-zinc-400">{item.message}</span>
          </div>
        ))}
      </div>
    </details>
  );
}

function AnswerAiBadge({ message, live = false }) {
  const info = answerAiModelTier(message);
  if (!info.engine && !info.recorded) return null;
  const fallbackEngineName = engineDisplayName(info.engine, info.engine || "AI");
  const engineName = info.name || `${fallbackEngineName}（历史服务商未记录）`;
  const identity = [info.provider, info.access, info.endpoint].filter(Boolean).join(" · ");
  const title = info.recorded
    ? `本回答生成时使用：${engineName} · ${info.model} · ${info.tier}${identity ? ` · ${identity}` : ""}`
    : `旧历史未保存模型信息：${engineName}`;
  return (
    <span
      data-testid={live ? "devbench-live-answer-ai" : "devbench-answer-ai"}
      data-engine={info.engine}
      data-model={info.model}
      data-tier={info.tier}
      data-provider={info.provider || ""}
      data-access={info.access || ""}
      data-snapshot-recorded={info.recorded ? "true" : "false"}
      className="inline-flex min-w-0 max-w-full items-center gap-1 rounded bg-zinc-700/50 px-1.5 py-0.5 text-[10px] text-zinc-300"
      title={title}
    >
      <span className="shrink-0">{engineName}</span>
      <span className="text-zinc-500">·</span>
      <span className="min-w-0 truncate">{info.model}</span>
      <span className="text-zinc-500">·</span>
      <span className="shrink-0 text-amber-300/80">{info.tier}</span>
    </span>
  );
}

function AiPromptPanel({ text, onClose }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!text) return undefined;
    const handleKey = (event) => {
      if (event.key === "Escape") onClose?.();
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [text, onClose]);
  if (!text) return null;
  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(String(text));
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {}
  };
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="AI接收到的Prompt"
      className="fixed inset-0 z-[150] flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm"
      onMouseDown={(event) => { if (event.target === event.currentTarget) onClose?.(); }}
    >
      <div className="flex max-h-[85vh] w-full max-w-3xl flex-col overflow-hidden rounded-2xl border border-zinc-700 bg-zinc-900 shadow-[0_20px_60px_rgba(0,0,0,0.55)]">
        <div className="flex shrink-0 items-center gap-2 border-b border-zinc-700/70 px-4 py-2.5">
          <span className="text-sm font-medium text-zinc-100">AI接收到的Prompt</span>
          <span className="truncate text-[10px] text-zinc-500">{String(text).length} 字符</span>
          <div className="ml-auto flex shrink-0 items-center gap-1.5">
            <button
              type="button"
              onClick={handleCopy}
              data-testid="devbench-ai-prompt-copy"
              className="rounded-lg border border-zinc-600 px-2.5 py-1 text-[11px] text-zinc-200 transition hover:border-blue-400/70 hover:bg-zinc-800 focus:outline-none focus:ring-2 focus:ring-blue-400/60"
            >{copied ? "已复制 ✓" : "复制"}</button>
            <button
              type="button"
              onClick={onClose}
              data-testid="devbench-ai-prompt-close"
              aria-label="关闭"
              className="flex h-7 w-7 items-center justify-center rounded-lg border border-zinc-600 text-zinc-300 transition hover:border-red-400/70 hover:bg-zinc-800 hover:text-red-300 focus:outline-none focus:ring-2 focus:ring-red-400/60"
            >✕</button>
          </div>
        </div>
        <pre className="flex-1 overflow-auto whitespace-pre-wrap break-words px-4 py-3 font-mono text-[12px] leading-relaxed text-zinc-300">{text}</pre>
      </div>
    </div>
  );
}

function MessageBubble({
  msg,
  messageId,
  onQuote,
  onReject,
  tabId,
  onToast,
  onViewPrompt,
  menuActive,
  menuPinned,
  onMenuOpen,
  onMenuClose,
  editing,
  onEdit,
  onEditCancel,
  onEditSubmit,
  editDisabled,
  editDisabledReason,
  revisionNavigation,
  branchBusy,
  onSelectBranch,
}) {
  const [analysisReportOpen, setAnalysisReportOpen] = useState(false);
  const triageAnalysisReport = String(msg.triageAnalysisReport || "").trim();
  const analysisReportId = `triage-analysis-${String(messageId || msg.id || "message").replace(/[^a-zA-Z0-9_-]/g, "-")}`;
  if (msg.workflow) return <WorkflowCard msg={msg} onReject={onReject} tabId={tabId} onToast={onToast} />;
  const timingText = messageTimingText(msg);
  if (msg.role === "user") {
    const displayContent = String(msg.displayContent || msg.input?.text || msg.content || "");
    const messageAttachments = Array.isArray(msg.input?.attachments)
      ? msg.input.attachments
      : (Array.isArray(msg.attachments) ? msg.attachments : []);
    return (
      <MessageShell
        messageId={messageId}
        role="user"
        content={displayContent}
        align="right"
        actionIds={["copy", "quote", "collapse", "edit"]}
        active={menuActive}
        pinned={menuPinned}
        onOpen={onMenuOpen}
        onClose={onMenuClose}
        onQuote={() => onQuote?.({ id: messageId, role: msg.role, content: displayContent })}
        onEdit={onEdit}
        editDisabled={editDisabled}
        editDisabledReason={editDisabledReason}
        bubbleClassName="max-w-[92%] sm:max-w-[80%] rounded-xl border border-blue-500/30 bg-blue-600/20 px-3 py-2 text-sm text-zinc-100 shadow-[0_8px_28px_rgba(30,64,175,0.08)]"
        footer={<BranchNavigator navigation={revisionNavigation} busy={branchBusy} disabled={editDisabled} onSelect={onSelectBranch} />}
      >
          <StoryAttachmentList
            tabId={tabId}
            attachments={messageAttachments}
            variant="message"
            onToast={onToast}
          />
          {editing ? (
            <UserMessageEditor initialValue={displayContent} disabled={editDisabled} onCancel={onEditCancel} onSubmit={onEditSubmit} />
          ) : (
            <StoryMessageContent tabId={tabId} onToast={onToast}>{displayContent}</StoryMessageContent>
          )}
          {msg.delivery === "pending" ? (
            <div className="mt-1.5 border-t border-blue-400/20 pt-1 text-[10px] text-blue-200/70">正在发送…</div>
          ) : null}
          {msg.delivery === "failed" ? (
            <div role="alert" className="mt-1.5 border-t border-red-400/25 pt-1 text-[10px] text-red-300">
              发送失败：{msg.sendError || "请编辑这条消息后重新发送"}
            </div>
          ) : null}
          {String(msg.aiPrompt || "").trim() && (
            <div className="mt-1.5 border-t border-blue-400/20 pt-1">
              <button
                type="button"
                data-testid="devbench-user-message-view-prompt"
                onClick={() => onViewPrompt?.(String(msg.aiPrompt))}
                className="text-[10px] text-blue-300 underline-offset-2 transition hover:text-blue-100 hover:underline focus:outline-none focus:ring-1 focus:ring-blue-400/60 rounded"
              >AI接收到的Prompt</button>
            </div>
          )}
          {timingText && (
            <div className="mt-1.5 border-t border-blue-400/20 pt-1 text-[10px] text-blue-100/70 font-mono whitespace-normal">
              {timingText}
            </div>
          )}
      </MessageShell>
    );
  }
  const tools = (msg.transcript || []).filter((t) => t.type === "tool_use");
  const thinkingText = isMiniMaxAnswer({ engine: msg.engine, aiSnapshot: msg.aiSnapshot })
    ? thinkingTextFromTranscript(msg.transcript)
    : "";
  const assistantContent = String(msg.content || "");
  const oversizedContent = planStoryMessageRender(assistantContent).oversized;
  const assistantAttachments = (oversizedContent ? [] : extractBareStoryArtifactRefs(assistantContent)).map((relPath) => ({
    relPath,
    name: storyMessageFileName(relPath),
    scope: "assistant",
  }));
  const usageInfo = usageText(msg.usage, msg.engine);
  const aiInfo = answerAiModelTier(msg);
  return (
    <MessageShell
      messageId={messageId}
      role="assistant"
      content={assistantContent}
      align="left"
      actionIds={["copy", "quote", "collapse"]}
      active={menuActive}
      pinned={menuPinned}
      onOpen={onMenuOpen}
      onClose={onMenuClose}
      onQuote={() => onQuote?.({ id: messageId, role: msg.role, content: msg.content })}
      bubbleClassName={`max-w-[96%] sm:max-w-[88%] rounded-xl px-3 py-2 border ${msg.error ? "bg-red-600/10 border-red-500/30" : msg.stopped ? "bg-amber-600/10 border-amber-500/30" : "bg-zinc-800/60 border-zinc-700"}`}
    >
        <ToolCommandSection tools={tools} />
        {(msg.center || msg.engine) && (
          <div className="mb-2 flex min-w-0">
            <CenterServiceBadge center={msg.center} engine={msg.engine} />
          </div>
        )}
        {msg.center?.mode === "center" && <CommLogPanel logs={msg.commLogs} />}
        {thinkingText && (
          <ThinkingStream text={thinkingText} streaming={false} defaultOpen={false} />
        )}
        {msg.transcriptTruncated ? (
          <div
            data-testid="devbench-transcript-truncated"
            className="mb-1.5 text-[10px] text-zinc-500"
            title={`完整运行轨迹共 ${msg.transcriptTotal || "?"} 条，仅保留首尾关键轨迹`}
          >
            ⚠️ 运行轨迹过长已截断（保留首尾，共 {msg.transcriptTotal || "?"} 条）
          </div>
        ) : null}
        <div className="text-sm text-zinc-200">
          <StoryMessageContent tabId={tabId} onToast={onToast} className={msg.error ? "text-red-400" : ""}>
            {assistantContent}
          </StoryMessageContent>
        </div>
        <StoryAttachmentList
          tabId={tabId}
          attachments={assistantAttachments}
          variant="assistant"
          onToast={onToast}
        />
        {!oversizedContent && !msg.error && <ArtifactPathLinks tabId={tabId} content={assistantContent} onToast={onToast} />}
        {triageAnalysisReport && !msg.error && !msg.stopped && (
          <div className="relative z-40 mt-2 border-t border-cyan-500/20 pt-2" data-testid="devbench-triage-analysis-report-entry">
            <button
              type="button"
              data-testid="devbench-view-triage-analysis-report"
              aria-expanded={analysisReportOpen}
              aria-controls={analysisReportId}
              onClick={() => setAnalysisReportOpen((open) => !open)}
              className="inline-flex max-w-full items-center gap-1.5 rounded-lg border border-cyan-500/35 bg-cyan-500/10 px-2.5 py-1.5 text-[11px] font-medium text-cyan-200 transition hover:border-cyan-400/70 hover:bg-cyan-500/15 focus:outline-none focus:ring-2 focus:ring-cyan-400/60"
            >
              <span aria-hidden="true">▣</span>
              <span>{analysisReportOpen ? "收起分析报告" : "查看分析报告"}</span>
            </button>
            {analysisReportOpen && (
              <div
                id={analysisReportId}
                role="region"
                aria-label="甄别阶段初步问题分析报告"
                data-testid="devbench-triage-analysis-report"
                className="mt-2 max-h-80 overflow-auto break-words rounded-lg border border-cyan-500/20 bg-zinc-950/55 px-3 py-2 text-sm text-zinc-200"
              >
                <StoryMessageMarkdown tabId={tabId} onToast={onToast}>
                  {triageAnalysisReport}
                </StoryMessageMarkdown>
              </div>
            )}
          </div>
        )}
        {msg.stopped && (
          <div data-testid="devbench-answer-stopped" className="mt-2 text-[11px] text-amber-300/90">
            ■ 已停止生成 · 停止前回答已保留
          </div>
        )}
        {(timingText || aiInfo.engine || aiInfo.recorded || usageInfo) && (
          <div className="mt-2 pt-1.5 border-t border-zinc-700/50 text-[10px] text-zinc-500 font-mono flex items-center gap-2 flex-wrap">
            <AnswerAiBadge message={msg} />
            {timingText && <span>{timingText}</span>}
            {usageInfo && <span>{usageInfo}</span>}
          </div>
        )}
    </MessageShell>
  );
}

function LiveBubble({ live, now, tabId, onToast, messageId, menuActive, menuPinned, onMenuOpen, onMenuClose }) {
  const timingText = liveTimingText(live, now);
  const usageInfo = usageText(live.usage, live.engine);
  const toolOutput = tailLogText(String(live.toolOutput || "").replace(/\r\n/g, "\n").replace(/\r/g, "\n").trimEnd());
  const visibleText = String(live.text || "").replace(/<!--[\s\S]*?-->/g, "").replace(/<!--[\s\S]*$/, "");
  return (
    <MessageShell
      messageId={messageId}
      role="live"
      content={visibleText}
      align="left"
      actionIds={["copy", "collapse"]}
      active={menuActive}
      pinned={menuPinned}
      onOpen={onMenuOpen}
      onClose={onMenuClose}
      bubbleClassName={`w-full max-w-[96%] sm:max-w-[88%] rounded-xl px-3 py-2 border ${live.stopped ? "bg-amber-600/10 border-amber-500/30" : "bg-zinc-800/40 border-zinc-700"}`}
    >
        {(live.center || live.engine) && (
          <div className="mb-2 flex min-w-0">
            <CenterServiceBadge center={live.center} engine={live.engine} />
          </div>
        )}
        {live.center?.mode === "center" && <CommLogPanel logs={live.commLogs} live />}
        {live.thinking && isMiniMaxAnswer({ engine: live.engine, aiSnapshot: live.aiSnapshot }) && (
          <ThinkingStream text={live.thinking} streaming={live.streaming} defaultOpen={true} />
        )}
        {live.thinking && !isMiniMaxAnswer({ engine: live.engine, aiSnapshot: live.aiSnapshot }) && (
          <details className="mb-2" open>
            <summary className="text-[11px] text-amber-400/80 cursor-pointer select-none">💭 思考过程</summary>
            <div className="mt-1 text-[11px] text-zinc-400 whitespace-pre-wrap max-h-48 overflow-y-auto bg-zinc-950/50 rounded p-2">
              {live.thinking}
            </div>
          </details>
        )}
        <ToolCommandSection tools={live.tools} live />
        {toolOutput && (
          <details className="group mb-2 overflow-hidden rounded border border-emerald-500/20 bg-zinc-950/70" data-testid="live-command-output-details">
            <summary className="flex cursor-pointer list-none items-center gap-2 px-2 py-1 text-[10px] text-emerald-300 marker:content-none hover:bg-emerald-500/5">
              <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-400 animate-pulse" />
              <span className="shrink-0">实时命令输出</span>
              <span className="min-w-0 truncate text-zinc-500">显示最近输出，完整内容以脚本日志为准</span>
              <span className="ml-auto shrink-0 text-[9px] text-emerald-400/70 group-open:hidden">展开</span>
              <span className="ml-auto hidden shrink-0 text-[9px] text-emerald-400/70 group-open:inline">收起</span>
            </summary>
            <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words border-t border-emerald-500/10 px-2 py-1.5 font-mono text-[11px] leading-relaxed text-zinc-300">
              {toolOutput}
            </pre>
          </details>
        )}
        {live.status && (
          <div className="mb-2 rounded border border-blue-500/20 bg-blue-500/5 px-2 py-1.5 text-[11px] text-blue-200/80">
            {live.status}
          </div>
        )}
        {visibleText && (
          <div className="text-sm text-zinc-200">
            <StoryMessageMarkdown tabId={tabId} onToast={onToast}>{visibleText}</StoryMessageMarkdown>
          </div>
        )}
        <ArtifactPathLinks tabId={tabId} content={visibleText} onToast={onToast} />
        {(live.streaming || timingText || usageInfo || live.engine || live.aiSnapshot) && (
          <div className="mt-1 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[11px] text-zinc-500">
            <span className={`w-1.5 h-1.5 rounded-full ${live.streaming ? "bg-blue-500 animate-pulse" : live.stopped ? "bg-amber-400" : "bg-zinc-500"}`} />
            <AnswerAiBadge message={live} live />
            <span className="shrink-0">{live.streaming ? "运行中…" : live.stopped ? "已停止，内容已保留" : "已结束"}</span>
            {timingText && <span className="font-mono">{timingText}</span>}
            {usageInfo && <span className="font-mono">{usageInfo}</span>}
          </div>
        )}
    </MessageShell>
  );
}
