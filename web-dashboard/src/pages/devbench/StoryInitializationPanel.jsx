import React, { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import DeviceRuntimeStatusCard from "./DeviceRuntimeStatusCard.jsx";
import EditableCombobox from "./EditableCombobox.jsx";
import {
  applyStoryLocalFlavorMapping,
  applyStoryInitializationConflictResolution,
  applyStoryInitializationSharedConfiguration,
  filterStoryInitializationProjects,
  isStoryInitializationSharedConfigurationConflict,
  orderStoryInitializationProjects,
  storyInitializationProjectRuntimeStatus,
  storyInitializationPrimaryAction,
  storyInitializationStudioPath,
  storyInitializationTabsForMode,
  storyLocalFlavorMappingOptions,
  storyLocalFlavorMappingResolution,
  storyInitializationConflictResolutionMatchesDraft,
  storyInitializationInferenceSummaryText,
  storyInitializationConfirmAction,
  storyVehicleSourcePreview,
  validateStoryInitializationDraft,
} from "./storyInitializationModel.mjs";
import StudioBtn from "./StudioBtn.jsx";
import FolderPickerModal from "./FolderPickerModal.jsx";
import { copyToClipboard } from "../../utils/clipboard.js";
import { devbenchApi } from "./api.js";

const MODE_OPTIONS = [
  {
    id: "blank",
    icon: "◇",
    title: "空白故事点",
    detail: "暂不绑定工程，创建后仍可回来补充配置",
  },
  {
    id: "local",
    icon: "▣",
    title: "本机工程",
    detail: "从本机工程列表选择主工程与关联工程",
  },
  {
    id: "remote",
    icon: "↧",
    title: "远程工程",
    detail: "按仓库定义、车型和分支准备工程",
  },
];

const DIMENSION_LABELS = {
  application: "应用",
  applicationRepository: "主工程 / 应用仓库",
  repository: "工程仓库",
  repositoryId: "工程仓库",
  project: "工程范围",
  vehicle: "车型",
  branch: "分支",
  flavor: "Flavor",
};

const SOURCE_LABELS = {
  title: "标题",
  note: "备注",
  detail: "详情",
  project: "TB 项目",
  iteration: "迭代",
  tag: "标签",
  tags: "标签",
  attachment: "附件",
  attachments: "附件",
  comment: "评论",
  comments: "评论",
  sample: "历史复核",
};

const inputClass = "w-full min-w-0 rounded-lg border border-zinc-700 bg-zinc-950/80 px-3 py-2 text-xs text-zinc-100 outline-none transition placeholder:text-zinc-700 focus:border-cyan-500 focus:ring-2 focus:ring-cyan-500/10 disabled:cursor-not-allowed disabled:opacity-50";
const labelClass = "mb-1.5 block text-[10px] font-medium uppercase tracking-[0.12em] text-zinc-500";

function text(value) {
  return String(value ?? "").trim();
}

function list(value) {
  return Array.isArray(value) ? value : [];
}

function unique(values) {
  return [...new Set(list(values).map(text).filter(Boolean))];
}

function modeLabel(mode) {
  return MODE_OPTIONS.find((item) => item.id === mode)?.title || "空白故事点";
}

function projectLabel(project) {
  return text(project?.name || project?.id || project?.path) || "工程信息待确认";
}

function projectDefLabel(definition) {
  return text(definition?.name || definition?.id) || "远程工程信息待确认";
}

const RUNTIME_TAG_TONES = {
  branch: "border-cyan-700/70 bg-cyan-950/60 text-cyan-100 shadow-[0_0_14px_rgba(6,182,212,0.08)]",
  flavor: "border-violet-700/70 bg-violet-950/60 text-violet-100 shadow-[0_0_14px_rgba(139,92,246,0.08)]",
  path: "border-amber-700/60 bg-amber-950/45 text-amber-100 shadow-[0_0_14px_rgba(245,158,11,0.06)]",
};

function RuntimeTag({ label, value, tone, wide = false }) {
  return (
    <span
      className={`inline-flex min-w-0 max-w-full items-start gap-1.5 rounded-md border px-2 py-1 ${RUNTIME_TAG_TONES[tone] || RUNTIME_TAG_TONES.branch} ${wide ? "basis-full" : ""}`}
      data-runtime-tag={tone}
      title={`${label}：${value}`}
    >
      <span className="shrink-0 pt-px text-[8px] font-semibold uppercase tracking-[0.08em] opacity-65">{label}</span>
      <code className="min-w-0 break-all text-[9px] leading-relaxed text-current">{value}</code>
    </span>
  );
}

function LocalProjectRuntimeMeta({ project, flavorByProjectId = {}, showFlavor = true, className = "" }) {
  const status = storyInitializationProjectRuntimeStatus(project, flavorByProjectId);
  return (
    <span
      className={`flex min-w-0 flex-wrap items-center gap-1.5 ${className}`}
      data-testid={`story-initialization-project-runtime-${text(project?.id)}`}
    >
      <RuntimeTag label="Git 分支" value={status.branchLabel} tone="branch" />
      {showFlavor ? <RuntimeTag label="Flavor" value={status.flavorLabel} tone="flavor" /> : null}
      <RuntimeTag label="目录路径" value={status.pathLabel} tone="path" wide />
    </span>
  );
}

function ProjectBranchTag({ branch }) {
  return (
    <span className="max-w-[180px] shrink-0 truncate rounded border border-emerald-800/60 bg-emerald-950/45 px-1.5 py-0.5 font-mono text-[9px] text-emerald-300"
      title={text(branch) || "未识别当前分支"}>
      {text(branch) || "分支未知"}
    </span>
  );
}

const LOCAL_FLAVOR_STATUS = {
  ready: { label: "已匹配", className: "border-emerald-800/70 bg-emerald-950/55 text-emerald-300" },
  optional: { label: "可选", className: "border-cyan-800/70 bg-cyan-950/45 text-cyan-300" },
  selected: { label: "已加入", className: "border-emerald-800/70 bg-emerald-950/55 text-emerald-300" },
  ambiguous: { label: "请选择", className: "border-amber-800/70 bg-amber-950/55 text-amber-300" },
  branch_mismatch: { label: "分支待同步", className: "border-rose-900/70 bg-rose-950/45 text-rose-300" },
  unconfigured: { label: "未配置", className: "border-zinc-700 bg-zinc-900 text-zinc-500" },
};

function LocalFlavorTargetRow({ target, selectedProjectId, selectedFlavor, onSelect, onFlavorSelect, disabled, onToast }) {
  const fieldId = `story-local-flavor-project-${text(target.repositoryId)}-${text(target.branch)}`.replace(/[^a-zA-Z0-9_-]+/g, "-");
  const flavorFieldId = `${fieldId}-flavor`;
  const selectedProject = target.exactCandidates.find((project) => text(project?.id) === text(selectedProjectId))
    || (!target.optional && target.exactCandidates.length === 1 ? target.exactCandidates[0] : null);
  const statusKey = target.optional && target.exactCandidates.length
    ? (selectedProjectId ? "selected" : "optional")
    : target.status;
  const status = LOCAL_FLAVOR_STATUS[statusKey] || LOCAL_FLAVOR_STATUS.unconfigured;
  const flavorOptions = unique(selectedProject?.flavors);
  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-950/45 p-3" data-testid={`story-local-flavor-target-${target.repositoryId}`}>
      <div className="flex min-w-0 flex-wrap items-start gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <span className="truncate text-[11px] font-medium text-zinc-200">{target.repositoryName}</span>
            <span className={`rounded-full border px-2 py-0.5 text-[8px] ${status.className}`}>{status.label}</span>
          </div>
          <div className="mt-1 flex min-w-0 flex-wrap gap-1.5">
            <RuntimeTag label="目标分支" value={target.branch || "未配置"} tone="branch" />
            <RuntimeTag label="Flavor" value={target.independentFlavor ? (selectedFlavor || "独立 / 未指定") : (target.flavor || "未指定")} tone="flavor" />
          </div>
        </div>
      </div>

      {target.status === "ambiguous" || (target.optional && target.exactCandidates.length) ? (
        <div className="mt-3">
          <label className="mb-1 block text-[9px] text-amber-300" htmlFor={fieldId}>{target.optional ? "按需加入一份通用工程 checkout" : "同仓同分支有多份 checkout，请明确选择"}</label>
          <select
            id={fieldId}
            value={selectedProjectId || ""}
            onChange={(event) => onSelect?.(event.target.value)}
            disabled={disabled}
            className={`${inputClass} py-1.5`}
            data-testid={`story-local-flavor-project-${target.repositoryId}`}
          >
            <option value="">{target.optional ? "— 不加入此通用工程 —" : "— 选择本机工程 —"}</option>
            {target.exactCandidates.map((project) => (
              <option key={project.id} value={project.id}>{projectLabel(project)} · {project.path}</option>
            ))}
          </select>
        </div>
      ) : null}

      {selectedProject ? (
        <div className="mt-3 flex min-w-0 items-start gap-2 rounded-lg border border-zinc-800 bg-zinc-900/60 p-2.5">
          <div className="min-w-0 flex-1">
            <div className="truncate text-[10px] text-zinc-300">{projectLabel(selectedProject)}</div>
            <LocalProjectRuntimeMeta
              project={selectedProject}
              flavorByProjectId={selectedFlavor ? { [selectedProject.id]: selectedFlavor } : {}}
              className="mt-1.5"
            />
          </div>
          {storyInitializationStudioPath(selectedProject) ? <StudioBtn path={storyInitializationStudioPath(selectedProject)} onToast={onToast} compact /> : null}
        </div>
      ) : null}

      {selectedProject && target.independentFlavor && flavorOptions.length ? (
        <div className="mt-3">
          <label className="mb-1 block text-[9px] text-violet-300" htmlFor={flavorFieldId}>该工程 Flavor 独立于主工程</label>
          <select
            id={flavorFieldId}
            value={selectedFlavor || ""}
            onChange={(event) => onFlavorSelect?.(event.target.value)}
            disabled={disabled}
            className={`${inputClass} py-1.5`}
            data-testid={`story-local-flavor-value-${target.repositoryId}`}
          >
            <option value="">— 未指定独立 Flavor —</option>
            {flavorOptions.map((flavor) => <option key={flavor} value={flavor}>{flavor}</option>)}
          </select>
        </div>
      ) : null}

      {target.status === "branch_mismatch" ? (
        <div className="mt-3 rounded-lg border border-rose-900/50 bg-rose-950/20 px-2.5 py-2">
          <p className="text-[9px] leading-relaxed text-rose-300">已登记 {target.candidates.length} 份本机工程，但当前分支都不是 <code className="font-mono">{target.branch}</code>。请先在工程配置切换分支，再刷新映射。</p>
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {target.candidates.slice(0, 4).map((project) => <ProjectBranchTag key={project.id} branch={`${projectLabel(project)} · ${text(project.branch) || "分支未知"}`} />)}
          </div>
        </div>
      ) : null}

      {target.status === "unconfigured" ? (
        <p className="mt-3 rounded-lg border border-dashed border-zinc-700 px-2.5 py-2 text-[9px] leading-relaxed text-zinc-500">该仓库还没有绑定本机路径。请先在“应用工程配置”中为 {target.repositoryName} 添加本机工程。</p>
      ) : null}
    </div>
  );
}

function LocalPrimaryProjectSelect({ projects, value, onChange, disabled, error }) {
  const anchorRef = useRef(null);
  const popupRef = useRef(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [popupStyle, setPopupStyle] = useState({});
  const selected = projects.find((project) => text(project?.id) === text(value));
  const filteredProjects = filterStoryInitializationProjects(projects, query);

  useEffect(() => {
    if (!open) return undefined;
    const updatePosition = () => {
      const rect = anchorRef.current?.getBoundingClientRect();
      if (!rect) return;
      const availableBelow = window.innerHeight - rect.bottom - 12;
      const availableAbove = rect.top - 12;
      const placeAbove = availableBelow < 220 && availableAbove > availableBelow;
      const maxHeight = Math.max(140, Math.min(320, placeAbove ? availableAbove : availableBelow));
      setPopupStyle({
        position: "fixed",
        left: Math.max(8, rect.left),
        top: placeAbove ? Math.max(8, rect.top - maxHeight - 6) : rect.bottom + 6,
        width: Math.max(280, rect.width),
        maxHeight,
        zIndex: 180,
      });
    };
    const closeOutside = (event) => {
      if (!anchorRef.current?.contains(event.target) && !popupRef.current?.contains(event.target)) {
        setOpen(false);
        setQuery("");
      }
    };
    const closeOnEscape = (event) => {
      if (event.key === "Escape") {
        setOpen(false);
        setQuery("");
      }
    };
    updatePosition();
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);
    document.addEventListener("mousedown", closeOutside);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
      document.removeEventListener("mousedown", closeOutside);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);

  const choose = (projectId) => {
    onChange(projectId);
    setOpen(false);
    setQuery("");
  };

  return (
    <div ref={anchorRef} className="relative min-w-0 flex-1">
      <button
        id="story-initialization-primary-project"
        type="button"
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        data-testid="story-initialization-primary-project"
        onClick={() => {
          setOpen((current) => !current);
          if (open) setQuery("");
        }}
        className={`flex w-full min-w-0 items-center justify-between gap-2 rounded-lg border bg-zinc-950 px-3 py-2 text-left text-xs outline-none transition disabled:cursor-not-allowed disabled:opacity-55 ${error ? "border-red-500/70" : open ? "border-cyan-600" : "border-zinc-700 hover:border-zinc-600"}`}
      >
        <span className={`min-w-0 flex-1 truncate ${selected ? "text-zinc-200" : "text-zinc-600"}`}>
          {selected ? projectLabel(selected) : "— 选择本机主工程 —"}
        </span>
        {selected ? <ProjectBranchTag branch={selected.branch} /> : null}
        <span aria-hidden="true" className={`shrink-0 text-[10px] text-zinc-500 transition ${open ? "rotate-180" : ""}`}>▼</span>
      </button>
      {open && typeof document !== "undefined" ? createPortal(
        <div ref={popupRef} style={popupStyle}
          className="flex flex-col overflow-hidden rounded-lg border border-zinc-700 bg-zinc-950 shadow-2xl shadow-black/60">
          <div className="shrink-0 border-b border-zinc-800 p-1.5">
            <input
              type="search"
              autoFocus
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key !== "Escape") return;
                event.preventDefault();
                event.stopPropagation();
                setOpen(false);
                setQuery("");
              }}
              aria-label="搜索本机主工程"
              placeholder="搜索工程名、Git 分支或完整路径"
              className="w-full rounded-md border border-zinc-700 bg-zinc-900 px-2.5 py-2 text-[11px] text-zinc-200 outline-none placeholder:text-zinc-600 focus:border-cyan-600"
            />
          </div>
          <div className="min-h-0 overflow-y-auto p-1.5" role="listbox" aria-label="选择本机主工程">
            <button type="button" role="option" aria-selected={!value} onClick={() => choose("")}
              className="flex w-full items-center rounded-md px-2.5 py-2 text-left text-[11px] text-zinc-500 hover:bg-zinc-800">
              — 选择本机主工程 —
            </button>
            {filteredProjects.map((project) => (
              <button key={project.id} type="button" role="option" aria-selected={text(project.id) === text(value)}
                disabled={project.exists === false} onClick={() => choose(project.id)}
                className={`flex w-full items-start justify-between gap-3 rounded-md px-2.5 py-2 text-left transition disabled:cursor-not-allowed disabled:opacity-40 ${text(project.id) === text(value) ? "bg-cyan-950/45" : "hover:bg-zinc-800"}`}>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[11px] text-zinc-200">{projectLabel(project)}{project.exists === false ? "（路径不可用）" : ""}</span>
                  <span className="mt-0.5 block truncate font-mono text-[9px] text-zinc-600" title={project.path}>{project.path || "路径未知"}</span>
                </span>
                <ProjectBranchTag branch={project.branch} />
              </button>
            ))}
            {query && !filteredProjects.length ? (
              <div className="px-2 py-5 text-center text-[10px] text-zinc-600">没有匹配的本机工程</div>
            ) : null}
          </div>
        </div>,
        document.body,
      ) : null}
    </div>
  );
}

function deviceLabel(device) {
  const id = text(device?.id || device?.serial || device?.deviceSerial);
  const head = text(device?.deviceLabel) ? `${text(device.deviceLabel)} (${id})` : id;
  const version = text(device?.androidVersion) ? ` Android ${text(device.androidVersion)}` : "";
  const api = text(device?.apiLevel) ? `, API ${text(device.apiLevel)}` : "";
  const status = text(device?.status);
  const suffix = status && status !== "device" ? ` [${status.toUpperCase()}]` : "";
  return `${head}${version}${api}${suffix}`;
}

function conflictCandidates(item) {
  const candidates = list(item?.candidates).map((candidate, index) => {
    if (candidate && typeof candidate === "object") {
      return {
        id: text(candidate.id || candidate.value) || `candidate_${index}`,
        value: text(candidate.value ?? candidate.label ?? candidate.name),
        label: text(candidate.label ?? candidate.value ?? candidate.name),
        sourceGroups: unique(candidate.sourceGroups || candidate.sources),
        detail: text(candidate.detail || candidate.reason),
        recommended: candidate.recommended === true,
      };
    }
    return {
      id: text(candidate) || `candidate_${index}`,
      value: text(candidate),
      label: text(candidate),
      sourceGroups: [],
      detail: "",
      recommended: false,
    };
  }).filter((candidate) => candidate.value);
  const recommendedValue = text(item?.recommendedValue);
  return candidates.map((candidate) => ({
    ...candidate,
    recommended: candidate.recommended || (!!recommendedValue && candidate.value === recommendedValue),
  }));
}

function normalizeConflicts(conflictItems, inference) {
  const rows = Array.isArray(conflictItems)
    ? conflictItems
    : list(inference?.quality?.conflicts?.items).length
      ? inference.quality.conflicts.items
      : list(inference?.conflicts?.items);
  return rows.map((item, index) => {
    const dimension = text(item?.dimension || item?.field || item?.key) || `conflict_${index + 1}`;
    return {
      ...item,
      id: text(item?.id) || `source_conflict:${dimension}:${index}`,
      dimension,
      label: text(item?.label) || DIMENSION_LABELS[dimension] || dimension,
      detail: text(item?.detail || item?.message || item?.reason),
      candidates: conflictCandidates(item),
    };
  });
}

function conflictDecision(resolutions, conflictId) {
  const value = resolutions?.[conflictId];
  if (value && typeof value === "object") return value;
  return value ? { selection: String(value), value: String(value) } : null;
}

function SectionTitle({ eyebrow, title, detail }) {
  return (
    <div className="mb-5">
      <div className="text-[9px] font-semibold uppercase tracking-[0.22em] text-cyan-600">{eyebrow}</div>
      <h3 className="mt-1 text-base font-semibold text-zinc-100">{title}</h3>
      {detail ? <p className="mt-1 max-w-3xl text-[11px] leading-relaxed text-zinc-500">{detail}</p> : null}
    </div>
  );
}

function SummaryRow({ label, children, tone = "default" }) {
  const toneClass = tone === "warning" ? "text-amber-300" : tone === "success" ? "text-emerald-300" : "text-zinc-200";
  return (
    <div className="grid grid-cols-[104px_minmax(0,1fr)] gap-3 border-b border-zinc-800/70 py-2.5 last:border-b-0">
      <span className="text-[10px] text-zinc-600">{label}</span>
      <div className={`min-w-0 break-words text-[11px] ${toneClass}`}>{children || "—"}</div>
    </div>
  );
}

function InferenceCard({ enabled, summary, conflicts, resolvedCount, status = "ready", onRunInference, actionLabel = "" }) {
  const isRunning = status === "running";
  const isLoading = status === "loading" || isRunning;
  const isFailed = status === "failed";
  // 边框/背景三态：loading 灰脉冲 / enabled 青 / 关闭 默认深色 / failed 琥珀
  const containerTone = isLoading
    ? "border-zinc-700 bg-zinc-900/45 animate-pulse"
    : isFailed
      ? "border-amber-700/50 bg-amber-950/15"
      : enabled
        ? "border-cyan-800/60 bg-cyan-950/20"
        : "border-zinc-800 bg-zinc-900/45";
  const badgeTone = isLoading
    ? "border-zinc-700 bg-zinc-900 text-zinc-500"
    : isFailed
      ? "border-amber-700/60 bg-amber-950/50 text-amber-300"
      : enabled
        ? "border-cyan-700/60 bg-cyan-950/50 text-cyan-300"
        : "border-zinc-700 bg-zinc-900 text-zinc-500";
  const badgeLabel = isLoading
    ? isRunning ? "AI 推理 · 推理中" : "AI 推理 · 检查设置中"
    : isFailed
      ? "AI 推理 · 未能加载"
      : enabled
        ? "AI 推理 · 已开启"
        : "AI 推理 · 已关闭";
  const detail = isLoading
    ? isRunning
      ? "正在根据当前入口信息运行 AI 推理；完成并人工定夺前不会创建真实故事点。"
      : "正在读取服务端 AI 推理开关；状态确认前不会创建真实故事点。"
    : isFailed
      ? summary || "AI 推理设置或运行结果不可用；当前禁止确认创建，请重试或取消。"
      : enabled
        ? summary || "AI 推理已开启；如需触发新推理，可点下方按钮。"
        : "本次未运行 AI 推理，面板不会自动补全或改写配置。";
  return (
    <div className={`rounded-xl border px-3.5 py-3 ${containerTone}`}>
      <div className="flex flex-wrap items-center gap-2">
        <span className={`rounded-md border px-2 py-0.5 text-[9px] font-medium ${badgeTone}`}>
          {badgeLabel}
        </span>
        {conflicts.length ? (
          <span className={`text-[9px] ${resolvedCount === conflicts.length ? "text-emerald-400" : "text-amber-400"}`}>
            来源矛盾 {resolvedCount}/{conflicts.length} 已裁决
          </span>
        ) : (
          <span className="text-[9px] text-emerald-500">未发现来源矛盾</span>
        )}
        {onRunInference && !isLoading && (enabled || isFailed) ? (
          <button
            type="button"
            onClick={onRunInference}
            className="ml-auto rounded border border-cyan-700/50 bg-cyan-950/40 px-2 py-0.5 text-[9px] text-cyan-200 transition hover:bg-cyan-900/50"
          >{actionLabel || (isFailed ? "重试" : "重新运行 AI 推理")}</button>
        ) : null}
      </div>
      <p className="mt-2 text-[11px] leading-relaxed text-zinc-400">{detail}</p>
    </div>
  );
}

// ===== 「临时分析」附件输入 =====
// 新建故事点（尤其空白/无 TB 信号）时，允许拖入日志/截图/文档作为 AI 推理的分析信号。
// 文本类附件读取前 64KB 预览随推理信号发送（图片等二进制只保留文件名）；
// 确认创建后由父组件把文件原样转入故事点资料目录。
const INFERENCE_TEXT_EXT = /\.(txt|log|json|jsonl|md|markdown|xml|yaml|yml|ini|conf|cfg|properties|csv|tsv|gradle|kts|java|kt|js|ts|py|sh|bat|ps1|html|htm|pro|rc|env|version)$/i;
const INFERENCE_TEXT_READ_MAX = 256 * 1024;   // 超过此大小不再读内容，只保留文件名
const INFERENCE_TEXT_PREVIEW_MAX = 64 * 1024; // 送入推理信号的文本上限

function isInferenceTextFile(file) {
  const name = String(file?.name || "");
  if (INFERENCE_TEXT_EXT.test(name)) return true;
  const mime = String(file?.type || "").toLowerCase();
  return mime.startsWith("text/")
    || mime.includes("json")
    || mime.includes("xml")
    || mime.includes("yaml")
    || mime.includes("csv")
    || mime.includes("log");
}

async function readInferenceAttachmentPreview(file) {
  if (!file || !isInferenceTextFile(file) || file.size > INFERENCE_TEXT_READ_MAX) return "";
  try {
    const text = await file.text();
    return String(text || "").slice(0, INFERENCE_TEXT_PREVIEW_MAX);
  } catch {
    return "";
  }
}

function formatAttachmentBytes(value) {
  const bytes = Math.max(0, Number(value) || 0);
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function InferenceAttachmentZone({
  items = [],
  disabled = false,
  error = "",
  onAddFiles,
  onRemove,
}) {
  const inputRef = useRef(null);
  const [dragOver, setDragOver] = useState(false);

  async function handleFiles(files) {
    const list = Array.from(files || []);
    if (!list.length || disabled) return;
    setDragOver(false);
    const prepared = [];
    for (const file of list) {
      const text = await readInferenceAttachmentPreview(file);
      prepared.push({
        key: `${file.name}\u0000${file.size}\u0000${Date.now()}\u0000${Math.random().toString(16).slice(2)}`,
        name: file.name,
        size: file.size,
        kind: text ? "text" : "file",
        text,
        file,
      });
    }
    onAddFiles?.(prepared);
  }

  return (
    <div className={`mt-2 overflow-hidden rounded-xl border transition ${dragOver ? "border-cyan-400/70 bg-cyan-950/25" : "border-zinc-800 bg-zinc-900/45"} ${disabled ? "opacity-55" : ""}`}
      data-testid="story-initialization-inference-attachments">
      <div
        className="flex flex-wrap items-center gap-2 px-3.5 py-2.5"
        onDragOver={(event) => { if (!disabled) { event.preventDefault(); setDragOver(true); } }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(event) => {
          if (disabled) return;
          event.preventDefault();
          const files = event.dataTransfer?.files;
          if (files?.length) handleFiles(files);
          else setDragOver(false);
        }}
      >
        <input
          ref={inputRef}
          type="file"
          multiple
          disabled={disabled}
          className="hidden"
          onChange={(event) => {
            handleFiles(event.target.files);
            event.target.value = "";
          }}
        />
        <span className="shrink-0 rounded border border-violet-700/50 bg-violet-950/35 px-1.5 py-0.5 text-[9px] font-medium text-violet-300">📎 临时分析附件</span>
        <span className="min-w-0 flex-1 text-[10px] leading-relaxed text-zinc-500">
          拖入日志/截图/文档参与 AI 分析（空白故事点也能推理出配置）；确认创建后自动转入故事点资料目录。
        </span>
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          disabled={disabled}
          className="shrink-0 rounded border border-zinc-700 bg-zinc-800/80 px-2 py-1 text-[9px] text-zinc-300 transition hover:border-zinc-500 hover:text-white disabled:cursor-not-allowed disabled:opacity-50"
        >选择文件…</button>
      </div>
      {items.length ? (
        <div className="flex flex-wrap gap-1.5 border-t border-zinc-800/70 px-3.5 py-2">
          {items.map((item) => (
            <span key={item.key} className="inline-flex max-w-full items-center gap-1.5 rounded-md border border-zinc-700 bg-zinc-950/70 px-2 py-1 text-[10px] text-zinc-300" title={item.name}>
              <span className="truncate max-w-[220px]">{item.name}</span>
              <span className="shrink-0 text-[9px] text-zinc-600">{formatAttachmentBytes(item.size)}</span>
              {item.kind === "text" ? <span className="shrink-0 rounded bg-emerald-950/70 px-1 text-[8px] text-emerald-400">含文本预览</span> : null}
              {!disabled ? (
                <button
                  type="button"
                  onClick={() => onRemove?.(item.key)}
                  className="shrink-0 rounded px-1 text-[10px] text-zinc-500 transition hover:bg-rose-950/60 hover:text-rose-300"
                  aria-label={`移除附件 ${item.name}`}
                >✕</button>
              ) : null}
            </span>
          ))}
        </div>
      ) : null}
      {error ? <div role="alert" className="border-t border-rose-900/50 px-3.5 py-1.5 text-[9px] text-rose-300">⚠ {error}</div> : null}
    </div>
  );
}

export default function StoryInitializationPanel({
  mode = "create",
  initialDraft = {},
  projects = [],
  projectApplications = [],
  projectMappingError = "",
  projectDefs = [],
  vehicleSourceConfig = null,
  devices = [],
  existingTitles = [],
  currentTitle = "",
  deviceOwners = {},
  inferenceEnabled = false,
  inferencePhase = "disabled",
  inferenceStatus = "ready",
  inferenceActionLabel = "",
  inferenceSummary = "",
  inferenceResultAvailable = false,
  inferenceReviewOpen = false,
  conflictItems,
  sourceLabel = "",
  sharedConfigurationDraft = null,
  sharedConfigurationSource = "",
  partialRecovery = null,
  busy = false,
  controlsLocked = false,
  canConfirm = true,
  error = "",
  onClose,
  onConfirm,
  onOpenPartialRecovery,
  onOpenInferenceResult,
  onRunInference,
  onDraftChange,
  onInferenceAttachmentsChange,
  onRefreshDevices,
  onRefreshProjects,
  onToast,
}) {
  const isEdit = mode === "edit";
  const sharedConfigurationLocked = !isEdit && !!sharedConfigurationDraft;
  const recoveryLocked = !!partialRecovery;
  const [activeTab, setActiveTab] = useState("identity");
  const [draft, setDraft] = useState(() => applyStoryInitializationSharedConfiguration({
    ...initialDraft,
    conflictResolutions: { ...(initialDraft?.conflictResolutions || {}) },
  }, sharedConfigurationLocked ? sharedConfigurationDraft : null));
  const [errors, setErrors] = useState({});
  const [showArchiveDirPicker, setShowArchiveDirPicker] = useState(false);
  const [refreshingDevices, setRefreshingDevices] = useState(false);
  const [refreshingProjects, setRefreshingProjects] = useState(false);
  const [relatedProjectQuery, setRelatedProjectQuery] = useState("");
  const [localProjectPickerMode, setLocalProjectPickerMode] = useState("branch");
  const [localFlavorQuery, setLocalFlavorQuery] = useState("");
  const [selectedLocalVehicle, setSelectedLocalVehicle] = useState("");
  const [localFlavorProjectSelections, setLocalFlavorProjectSelections] = useState({});
  const [localFlavorSelections, setLocalFlavorSelections] = useState({});
  const [inferenceAttachments, setInferenceAttachments] = useState([]);
  const [inferenceAttachmentError, setInferenceAttachmentError] = useState("");
  const titleRef = useRef(null);
  const onDraftChangeRef = useRef(onDraftChange);
  const formDisabled = busy || controlsLocked || recoveryLocked;
  const configurationDisabled = formDisabled || sharedConfigurationLocked;
  const confirmAction = storyInitializationConfirmAction({
    canConfirm,
    partialRecovery: recoveryLocked,
  });
  const primaryAction = storyInitializationPrimaryAction(isEdit ? "edit" : "create", activeTab);

  // 仅在 initialDraft 引用变化时重置草稿；父组件 re-render 不应清空用户输入。
  const lastInitialDraftRef = useRef(null);
  useEffect(() => {
    const last = lastInitialDraftRef.current;
    if (last === initialDraft) return;
    lastInitialDraftRef.current = initialDraft;
    setDraft(applyStoryInitializationSharedConfiguration({
      ...initialDraft,
      conflictResolutions: { ...(initialDraft?.conflictResolutions || {}) },
    }, sharedConfigurationLocked ? sharedConfigurationDraft : null));
    setErrors({});
    setRelatedProjectQuery("");
    setLocalProjectPickerMode("branch");
    setLocalFlavorQuery("");
    setSelectedLocalVehicle("");
    setLocalFlavorProjectSelections({});
    setLocalFlavorSelections({});
    setActiveTab("identity");
  }, [initialDraft, sharedConfigurationDraft, sharedConfigurationLocked]);

  useEffect(() => {
    onDraftChangeRef.current = onDraftChange;
  }, [onDraftChange]);

  useEffect(() => {
    onDraftChangeRef.current?.(draft);
  }, [draft]);

  // 临时分析附件：去重合并 + 上抛给父组件（父组件在推理/创建时消费）。
  const onInferenceAttachmentsChangeRef = useRef(onInferenceAttachmentsChange);
  useEffect(() => {
    onInferenceAttachmentsChangeRef.current = onInferenceAttachmentsChange;
  }, [onInferenceAttachmentsChange]);
  useEffect(() => {
    onInferenceAttachmentsChangeRef.current?.(inferenceAttachments);
  }, [inferenceAttachments]);

  function addInferenceAttachmentFiles(prepared) {
    if (!prepared?.length || formDisabled) return;
    setInferenceAttachmentError("");
    setInferenceAttachments((current) => {
      const existing = new Set((current || []).map((item) => `${item.name}\u0000${item.size}`));
      const added = prepared.filter((item) => !existing.has(`${item.name}\u0000${item.size}`));
      return [...(current || []), ...added];
    });
  }

  function removeInferenceAttachment(key) {
    setInferenceAttachments((current) => (current || []).filter((item) => item.key !== key));
  }


  useEffect(() => {
    if (activeTab === "identity") titleRef.current?.focus();
  }, [activeTab]);

  useEffect(() => {
    const onKeyDown = (event) => {
      if (event.key !== "Escape") return;
      if (inferenceReviewOpen || showArchiveDirPicker) return;
      event.preventDefault();
      if (!busy) onClose?.();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [busy, inferenceReviewOpen, onClose, showArchiveDirPicker]);

  const inference = draft?.inference || initialDraft?.inference || null;
  const conflicts = useMemo(
    () => normalizeConflicts(conflictItems, inference),
    [conflictItems, inference],
  );
  const conflictResolutionIsCurrent = (item, resolution = conflictDecision(draft.conflictResolutions, item.id)) => (
    storyInitializationConflictResolutionMatchesDraft(
      draft,
      item,
      resolution,
      { projects, projectDefs },
    )
  );
  const resolvedCount = conflicts.filter((item) => conflictResolutionIsCurrent(item)).length;
  const unresolvedConflicts = conflicts.filter((item) => !conflictResolutionIsCurrent(item));
  const resolvedSourceLabel = text(sourceLabel || draft.sourceLabel) || (isEdit ? "当前故事点" : "手动创建");
  const resolvedInferenceSummary = storyInitializationInferenceSummaryText(inferenceSummary, inference);
  const selectedProjectIds = unique([draft.primaryProjectId, ...list(draft.extraProjectIds)]);
  const selectedLocalProjects = selectedProjectIds
    .map((id) => projects.find((project) => text(project?.id) === id))
    .filter(Boolean);
  const selectedPrimaryLocalProject = projects.find((project) => (
    text(project?.id) === text(draft.primaryProjectId)
  ));
  const orderedLocalProjects = orderStoryInitializationProjects(projects, selectedProjectIds);
  const relatedLocalProjects = filterStoryInitializationProjects(
    orderedLocalProjects.filter((project) => text(project.id) !== text(draft.primaryProjectId)),
    relatedProjectQuery,
  );
  const selectedRemoteIds = unique([draft.projectDefId, ...list(draft.remoteProjectDefIds)]);
  const selectedRemoteDefs = selectedRemoteIds
    .map((id) => projectDefs.find((definition) => text(definition?.id) === id))
    .filter(Boolean);
  const orderedRemoteDefs = orderStoryInitializationProjects(projectDefs, selectedRemoteIds);
  const vehicleMap = vehicleSourceConfig?.vehicleMap && typeof vehicleSourceConfig.vehicleMap === "object"
    ? vehicleSourceConfig.vehicleMap
    : {};
  const availableVehicleEntries = Object.entries(vehicleMap)
    .filter(([, mapping]) => list(mapping?.apps).length)
    .sort(([left], [right]) => left.localeCompare(right));
  const selectedVehicleRows = list(draft.vehicleSelections);
  const vehiclePreview = storyVehicleSourcePreview(selectedVehicleRows, vehicleMap, projectDefs);
  const localFlavorOptions = useMemo(() => storyLocalFlavorMappingOptions({
    vehicleMap,
    projectDefs,
    projects,
    projectApplications,
  }), [projectApplications, projectDefs, projects, vehicleMap]);
  const visibleLocalFlavorOptions = localFlavorOptions.filter((option) => {
    const query = text(localFlavorQuery).toLocaleLowerCase();
    if (!query) return true;
    return [option.vehicle, ...option.flavors, ...option.appNames]
      .map((value) => text(value).toLocaleLowerCase())
      .some((value) => value.includes(query));
  });
  const selectedLocalFlavorOption = localFlavorOptions.find((option) => option.vehicle === selectedLocalVehicle)
    || localFlavorOptions[0]
    || null;
  const localFlavorResolution = storyLocalFlavorMappingResolution(selectedLocalFlavorOption, localFlavorProjectSelections, localFlavorSelections);

  useEffect(() => {
    if (selectedLocalVehicle && localFlavorOptions.some((option) => option.vehicle === selectedLocalVehicle)) return;
    setSelectedLocalVehicle(localFlavorOptions[0]?.vehicle || "");
  }, [localFlavorOptions, selectedLocalVehicle]);

  function update(field, value) {
    setDraft((current) => ({ ...current, [field]: value }));
    if (errors[field]) setErrors((current) => ({ ...current, [field]: undefined }));
  }

  function selectMode(nextMode) {
    update("mode", nextMode);
  }

  function selectPrimaryProject(projectId) {
    const id = text(projectId);
    setDraft((current) => ({
      ...current,
      primaryProjectId: id,
      extraProjectIds: unique(current.extraProjectIds).filter((value) => value !== id),
    }));
    setErrors((current) => ({ ...current, primaryProjectId: undefined }));
  }

  function toggleExtraProject(projectId) {
    const id = text(projectId);
    setDraft((current) => {
      const selected = new Set(unique(current.extraProjectIds));
      if (selected.has(id)) selected.delete(id);
      else selected.add(id);
      selected.delete(text(current.primaryProjectId));
      return { ...current, extraProjectIds: [...selected] };
    });
  }

  function selectPrimaryRemote(projectDefId) {
    const id = text(projectDefId);
    const definition = projectDefs.find((item) => text(item?.id) === id);
    setDraft((current) => ({
      ...current,
      projectDefId: id,
      remoteProjectDefIds: unique(current.remoteProjectDefIds).filter((value) => value !== id),
      branch: text(current.branch) || text(definition?.defaultBranch),
      remoteFlavor: text(current.remoteFlavor) || text(definition?.defaultFlavor),
    }));
    setErrors((current) => ({ ...current, projectDefId: undefined }));
  }

  function toggleRemoteProject(projectDefId) {
    const id = text(projectDefId);
    setDraft((current) => {
      const selected = new Set(unique(current.remoteProjectDefIds));
      if (selected.has(id)) selected.delete(id);
      else selected.add(id);
      selected.delete(text(current.projectDefId));
      return { ...current, remoteProjectDefIds: [...selected] };
    });
  }

  function applyVehicleSelections(nextSelections) {
    const preview = storyVehicleSourcePreview(nextSelections, vehicleMap, projectDefs);
    setDraft((current) => ({
      ...current,
      vehicleSelections: preview.selections,
      vehicleSourceEntries: preview.entries,
      projectDefId: preview.projectDefId || current.projectDefId,
      remoteProjectDefIds: unique(preview.entries.map((entry) => entry.projectId))
        .filter((id) => id !== (preview.projectDefId || current.projectDefId)),
      vehicle: preview.selections[0]?.vehicle || "",
      branch: preview.entries[0]?.branch || "",
      remoteFlavor: preview.entries[0]?.flavor || "",
    }));
    setErrors((current) => ({
      ...current,
      vehicleSelections: preview.errors[0],
      projectDefId: undefined,
    }));
  }

  function toggleVehicle(vehicle) {
    const current = new Map(selectedVehicleRows.map((selection) => [text(selection?.vehicle), selection]));
    if (current.has(vehicle)) current.delete(vehicle);
    else {
      const appNames = list(vehicleMap?.[vehicle]?.apps).map((app) => text(app?.appName)).filter(Boolean);
      current.set(vehicle, { vehicle, appNames });
    }
    applyVehicleSelections([...current.values()]);
  }

  function toggleVehicleApplication(vehicle, appName) {
    const next = selectedVehicleRows.map((selection) => ({
      vehicle: text(selection?.vehicle),
      appNames: unique(selection?.appNames),
    }));
    const row = next.find((selection) => selection.vehicle === vehicle);
    if (!row) return;
    const selected = new Set(row.appNames);
    if (selected.has(appName)) selected.delete(appName);
    else selected.add(appName);
    row.appNames = [...selected];
    applyVehicleSelections(next);
  }

  function setFlavor(projectId, flavor) {
    setDraft((current) => ({
      ...current,
      flavorByProjectId: {
        ...(current.flavorByProjectId || {}),
        [projectId]: flavor,
      },
    }));
  }

  function selectLocalFlavorProject(selectionKey, projectId) {
    setLocalFlavorProjectSelections((current) => ({
      ...current,
      [selectionKey]: text(projectId),
    }));
  }

  function selectLocalFlavorValue(selectionKey, flavor) {
    setLocalFlavorSelections((current) => ({
      ...current,
      [selectionKey]: text(flavor),
    }));
  }

  function applyLocalFlavorMapping() {
    const result = applyStoryLocalFlavorMapping(draft, selectedLocalFlavorOption, localFlavorProjectSelections, localFlavorSelections);
    if (!result.ok) {
      setErrors((current) => ({ ...current, primaryProjectId: result.error || "车型 / Flavor 映射尚未就绪" }));
      return;
    }
    setDraft(result.draft);
    setErrors((current) => ({ ...current, primaryProjectId: undefined }));
    onToast?.(`已按 ${selectedLocalFlavorOption.vehicle} 映射 ${result.resolution.targets.filter((target) => target.selectedProject).length} 个本机工程`);
  }

  async function refreshLocalFlavorMappings() {
    if (!onRefreshProjects || refreshingProjects) return;
    setRefreshingProjects(true);
    try {
      const result = await onRefreshProjects();
      if (result?.ok === false) onToast?.(result.error || "刷新本机工程映射失败", "error");
      else onToast?.("已重新读取本机工程配置与实时 Git 分支");
    } finally {
      setRefreshingProjects(false);
    }
  }

  function resolveConflict(item, selection, value) {
    if (sharedConfigurationLocked
      && isStoryInitializationSharedConfigurationConflict(item)
      && selection !== "manual") return;
    const result = applyStoryInitializationConflictResolution(
      draft,
      item,
      { selection, value },
      { projects, projectDefs },
    );
    if (!result.ok) {
      setErrors((current) => ({
        ...current,
        conflicts: result.error,
        conflictMappings: {
          ...(current.conflictMappings || {}),
          [item.id]: result.error,
        },
      }));
      return;
    }
    setDraft(applyStoryInitializationSharedConfiguration({
      ...result.draft,
      conflictResolutions: {
        ...(result.draft.conflictResolutions || {}),
        [item.id]: result.resolution,
      },
    }, sharedConfigurationLocked ? sharedConfigurationDraft : null));
    setErrors((current) => {
      const conflictMappings = { ...(current.conflictMappings || {}) };
      delete conflictMappings[item.id];
      return {
        ...current,
        conflicts: undefined,
        conflictMappings,
      };
    });
  }

  function validate({ forTab = null } = {}) {
    const result = validateStoryInitializationDraft(draft, {
      existingTitles,
      currentTitle: currentTitle || (isEdit ? initialDraft?.title : ""),
      projects,
      projectDefs,
    });
    const nextErrors = { ...result.errors };
    if (!forTab || forTab === "review") {
      if (unresolvedConflicts.length) nextErrors.conflicts = `还有 ${unresolvedConflicts.length} 项来源矛盾未裁决`;
    }
    setErrors(nextErrors);
    return { ok: Object.keys(nextErrors).length === 0, errors: nextErrors };
  }

  function goNext() {
    const tabOrder = storyInitializationTabsForMode(isEdit ? "edit" : "create").map((item) => item.id);
    if (activeTab === "identity") {
      const result = validateStoryInitializationDraft(draft, {
        existingTitles,
        currentTitle: currentTitle || (isEdit ? initialDraft?.title : ""),
        projects,
        projectDefs,
      });
      if (result.errors.title) {
        setErrors({ title: result.errors.title });
        return;
      }
      setErrors({});
      setActiveTab("projects");
      return;
    }
    if (activeTab === "projects") {
      let nextDraft = draft;
      if (draft.mode === "local" && localProjectPickerMode === "flavor") {
        const mapping = applyStoryLocalFlavorMapping(
          draft,
          selectedLocalFlavorOption,
          localFlavorProjectSelections,
          localFlavorSelections,
        );
        if (!mapping.ok) {
          const currentValidation = validateStoryInitializationDraft(draft, {
            existingTitles,
            currentTitle: currentTitle || (isEdit ? initialDraft?.title : ""),
            projects,
            projectDefs,
          });
          setErrors({
            ...currentValidation.errors,
            primaryProjectId: mapping.error || "车型 / Flavor 映射尚未就绪",
          });
          return;
        }
        nextDraft = mapping.draft;
      }
      const result = validateStoryInitializationDraft(nextDraft, {
        existingTitles,
        currentTitle: currentTitle || (isEdit ? initialDraft?.title : ""),
        projects,
        projectDefs,
      });
      if (result.errors.primaryProjectId || result.errors.projectDefId || result.errors.vehicleSelections) {
        setErrors(result.errors);
        return;
      }
      if (nextDraft !== draft) setDraft(nextDraft);
      setErrors({});
      setActiveTab("build");
      return;
    }
    setErrors({});
    const currentIndex = tabOrder.indexOf(activeTab);
    setActiveTab(tabOrder[Math.min(tabOrder.length - 1, currentIndex + 1)] || "review");
  }

  async function copySettingPath(value, label) {
    const target = text(value);
    if (!target) return;
    await copyToClipboard(target);
    onToast?.(`已复制${label || "目录"}`);
  }

  async function openSettingDirectory(value) {
    const target = text(value);
    if (!target) return;
    const result = await devbenchApi.openDir(target);
    if (!result?.ok) onToast?.(result?.error || "打开目录失败，路径可能尚不存在");
  }

  async function refreshDeviceList() {
    if (refreshingDevices || typeof onRefreshDevices !== "function") return;
    setRefreshingDevices(true);
    try {
      const result = await onRefreshDevices();
      if (result?.ok === false) onToast?.(result.error || "刷新设备列表失败");
    } catch (error) {
      onToast?.(error?.message || "刷新设备列表失败");
    } finally {
      setRefreshingDevices(false);
    }
  }

  function goBack() {
    const order = storyInitializationTabsForMode(isEdit ? "edit" : "create").map((item) => item.id);
    const index = order.indexOf(activeTab);
    if (index > 0) setActiveTab(order[index - 1]);
  }

  function submit() {
    if (formDisabled || confirmAction !== "confirm") return;
    if (isEdit && draft.archiveMode === "custom" && !text(draft.archiveDir)) {
      setErrors((current) => ({ ...current, archiveDir: "请选择或填写自定义存档目录" }));
      setActiveTab("workflow_archive");
      return;
    }
    const result = validate({ forTab: "review" });
    if (!result.ok) {
      if (result.errors.title) setActiveTab("identity");
      else if (result.errors.primaryProjectId || result.errors.projectDefId || result.errors.vehicleSelections) setActiveTab("projects");
      else setActiveTab("review");
      return;
    }
    const confirmedDraft = applyStoryInitializationSharedConfiguration(
      draft,
      sharedConfigurationLocked ? sharedConfigurationDraft : null,
    );
    onConfirm?.({
      ...confirmedDraft,
      title: text(draft.title),
      ticketInput: text(draft.ticketInput),
      sourceLabel: resolvedSourceLabel,
      extraProjectIds: unique(confirmedDraft.extraProjectIds).filter((id) => id !== text(confirmedDraft.primaryProjectId)),
      remoteProjectDefIds: unique(confirmedDraft.remoteProjectDefIds).filter((id) => id !== text(confirmedDraft.projectDefId)),
    });
  }

  const tabs = storyInitializationTabsForMode(isEdit ? "edit" : "create").map((item) => ({
    ...item,
    label: item.id === "review" ? "确认" : item.label,
  }));

  const panel = (
    <div
      className="fixed inset-0 z-[145] flex items-center justify-center bg-black/75 p-4 backdrop-blur-md"
      role="dialog"
      aria-modal="true"
      aria-labelledby="story-initialization-title"
      data-testid={`story-initialization-panel-${isEdit ? "edit" : "create"}`}
      data-inference-phase={inferencePhase}
      onClick={(event) => {
        if (event.target === event.currentTarget && !busy) onClose?.();
      }}
    >
      <div
        className="relative flex max-h-[94vh] w-[1040px] max-w-[98vw] flex-col overflow-hidden rounded-2xl border border-zinc-700/80 bg-zinc-950 shadow-[0_40px_150px_rgba(0,0,0,0.88)]"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="pointer-events-none absolute -left-24 -top-28 h-64 w-64 rounded-full bg-violet-500/10 blur-[90px]" />
        <div className="pointer-events-none absolute -right-20 top-4 h-64 w-64 rounded-full bg-cyan-500/10 blur-[90px]" />

        <header className="relative shrink-0 border-b border-zinc-800 px-5 pt-5">
          <div className="mb-4 flex items-start gap-3">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-cyan-400/25 bg-gradient-to-br from-cyan-500/20 to-violet-500/15 text-sm font-semibold text-cyan-100">
              {isEdit ? "⚙" : "＋"}
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <h2 id="story-initialization-title" className="text-[15px] font-semibold text-zinc-50">
                  {isEdit ? "编辑故事点配置" : "故事点初始化配置"}
                </h2>
                <span className="rounded border border-zinc-700 bg-zinc-900 px-1.5 py-0.5 text-[9px] text-zinc-500">
                  来源：{resolvedSourceLabel}
                </span>
              </div>
              <p className="mt-1 text-[11px] leading-relaxed text-zinc-500">
                {partialRecovery
                  ? "服务端已产生故事点记录，但初始化未完整完成；当前面板已冻结，不会再次提交创建。"
                  : isEdit
                    ? "所有更改先保留在当前面板，点击“确认更新”后才会应用到故事点。"
                    : "当前还没有创建真实故事点；只有最后点击“确认创建”后才会创建 Tab 和工程工作区。"}
              </p>
              {sharedConfigurationLocked ? (
                <div
                  className="mt-2 rounded-lg border border-violet-700/45 bg-violet-950/25 px-3 py-2 text-[10px] leading-relaxed text-violet-200"
                  data-testid="story-initialization-shared-configuration-lock"
                >
                  组共享配置已锁定，来源：{text(sharedConfigurationSource) || "组锚故事点"}。工程与构建按此配置创建；设备仅只读展示，并在成功加入组后继承。本面板仅可确认标题和 TB 绑定。
                </div>
              ) : null}
            </div>
            <button
              type="button"
              onClick={() => { if (!busy) onClose?.(); }}
              disabled={busy}
              className="rounded-lg px-2 py-1 text-sm text-zinc-500 transition hover:bg-zinc-800 hover:text-zinc-100 disabled:cursor-not-allowed disabled:opacity-35"
              aria-label="关闭"
              data-testid="story-initialization-close"
            >✕</button>
          </div>

          <div className="flex gap-1 overflow-x-auto" role="tablist" aria-label="故事点初始化配置步骤">
            {tabs.map((item, index) => {
              const active = activeTab === item.id;
              const conflictBadge = item.id === "review" && unresolvedConflicts.length;
              return (
                <button
                  key={item.id}
                  type="button"
                  role="tab"
                  aria-selected={active}
                  onClick={() => { if (!formDisabled) setActiveTab(item.id); }}
                  disabled={formDisabled}
                  className={`shrink-0 border-b-2 px-4 py-2.5 text-[11px] transition ${active ? "border-cyan-500 text-zinc-50" : "border-transparent text-zinc-500 hover:text-zinc-300"} disabled:cursor-not-allowed disabled:opacity-45`}
                  data-testid={`story-initialization-tab-${item.id}`}
                >
                  <span className={`mr-1.5 inline-flex h-4 w-4 items-center justify-center rounded-full text-[8px] ${active ? "bg-cyan-600 text-white" : "bg-zinc-800 text-zinc-500"}`}>{index + 1}</span>
                  {item.label}
                  {conflictBadge ? <span className="ml-1.5 rounded-full bg-amber-900/60 px-1.5 py-0.5 text-[8px] text-amber-300">{unresolvedConflicts.length}</span> : null}
                </button>
              );
            })}
          </div>
        </header>

        {(["checking", "running", "applying"].includes(inferencePhase) || inferenceResultAvailable) ? (
          <button
            type="button"
            aria-label={inferencePhase === "applying" ? "正在应用 AI 建议到初始化配置" : (inferenceResultAvailable ? "查看并人工确认 AI 推理结果" : "AI 正在推理")}
            disabled={inferencePhase === "applying" || !inferenceResultAvailable || !onOpenInferenceResult}
            onClick={onOpenInferenceResult}
            className={`relative mx-5 mt-4 rounded-xl border px-4 py-3 text-left transition ${inferencePhase === "applying"
              ? "cursor-default devbench-status-surface devbench-status-surface--warning"
              : inferenceResultAvailable
                ? "devbench-status-surface devbench-status-surface--success hover:border-emerald-300"
                : "cursor-default devbench-status-surface devbench-status-surface--info"}`}
            data-testid={inferencePhase === "applying" ? "story-initialization-inference-applying" : (inferenceResultAvailable ? "story-initialization-inference-ready" : "story-initialization-inference-running")}
          >
            {inferencePhase !== "applying" && !inferenceResultAvailable ? (
              <span className="pointer-events-none absolute inset-y-0 left-0 w-1/3 animate-pulse bg-cyan-300/10" />
            ) : null}
            {inferencePhase === "applying" ? (
              <span className="pointer-events-none absolute inset-y-0 left-0 w-1/3 animate-pulse bg-amber-300/15" />
            ) : null}
            <span className="relative flex items-center gap-3">
              <span className={`h-3 w-3 shrink-0 rounded-full ${inferencePhase === "applying" ? "animate-pulse bg-amber-300" : inferenceResultAvailable ? "bg-emerald-400" : "animate-pulse bg-cyan-300"}`} />
              <span className="min-w-0 flex-1">
                <span className={`block text-sm font-semibold tracking-wide ${inferencePhase === "applying" ? "text-amber-50" : inferenceResultAvailable ? "text-emerald-100" : "text-cyan-50"}`}>
                  {inferencePhase === "applying" ? "正在应用 AI 建议到初始化配置…" : inferenceResultAvailable ? "AI 推理已完成" : "AI正在推理"}
                </span>
                <span className={`mt-0.5 block text-[10px] ${inferencePhase === "applying" ? "text-amber-200/80" : inferenceResultAvailable ? "text-emerald-300/80" : "text-cyan-200/75"}`}>
                  {inferencePhase === "applying"
                    ? (resolvedInferenceSummary || "正在回填工程、分支、Flavor 等配置，请稍候；完成后可继续编辑或创建。")
                    : inferenceResultAvailable
                      ? "点击可以进入查看 AI 推理；确认应用后会直接回填到当前初始化配置面板。"
                      : "你可以继续填写和调整初始化配置；推理完成后会在这里提醒，不会自动打断当前操作。"}
                </span>
              </span>
              {inferencePhase === "applying" ? (
                <span className="shrink-0 text-xs font-medium text-amber-200" data-testid="story-initialization-inference-applying-hint">
                  <span className="mr-1 inline-block h-3 w-3 animate-spin rounded-full border-2 border-amber-300 border-t-transparent align-middle" />
                  应用中
                </span>
              ) : inferenceResultAvailable ? <span className="shrink-0 text-xs font-medium text-emerald-200">查看 AI 建议 · 不影响创建 ›</span> : null}
            </span>
          </button>
        ) : null}

        <main className="relative min-h-0 flex-1 overflow-y-auto px-5 py-5">
          {partialRecovery ? (
            <section
              className="mx-auto mb-5 flex max-w-4xl flex-wrap items-center gap-3 rounded-xl border border-amber-700/60 bg-amber-950/25 px-4 py-3"
              data-testid="story-initialization-partial-recovery"
              role="alert"
            >
              <div className="min-w-0 flex-1">
                <h3 className="text-[11px] font-semibold text-amber-200">故事点仅部分创建，已停止自动流程</h3>
                <p className="mt-1 text-[10px] leading-relaxed text-amber-500">
                  记录 ID：{partialRecovery.tabId || "未返回"}。不能编辑草稿或再次确认创建，也不会自动启动工作流；请打开残留故事点核对配置、设备和工作区。
                </p>
              </div>
              <button
                type="button"
                onClick={onOpenPartialRecovery}
                disabled={busy || !partialRecovery.tabId || !onOpenPartialRecovery}
                className="rounded-lg border border-amber-600/60 bg-amber-900/40 px-3 py-2 text-[10px] font-medium text-amber-100 transition hover:bg-amber-800/55 disabled:cursor-not-allowed disabled:opacity-40"
                data-testid="story-initialization-open-partial-recovery"
              >打开残留故事点并人工核对</button>
            </section>
          ) : null}
          {activeTab === "identity" ? (
            <div role="tabpanel" className="mx-auto max-w-3xl" data-testid="story-initialization-identity">
              <SectionTitle
                eyebrow="Identity"
                title="先确认故事点身份"
                detail="标题用于 Tab、工作区与后续归档；TB 单可以填写单号或完整链接，也可以暂时留空。"
              />
              <div className="space-y-5">
                <div>
                  <label htmlFor="story-initialization-title-input" className={labelClass}>故事点标题 <span className="text-red-400">*</span></label>
                  <input
                    id="story-initialization-title-input"
                    ref={titleRef}
                    value={draft.title || ""}
                    onChange={(event) => update("title", event.target.value)}
                    disabled={formDisabled}
                    className={`${inputClass} ${errors.title ? "border-red-500/70 focus:border-red-500" : ""}`}
                    placeholder="例如：CARB-13542 优化应用市场启动流程"
                    autoComplete="off"
                    data-testid="story-initialization-title-input"
                  />
                  <div className="mt-1.5 min-h-4 text-[10px]">
                    {errors.title ? <span role="alert" className="text-red-300">⚠ {errors.title}</span> : <span className="text-zinc-700">确认前不会占用标题、工程或设备。</span>}
                  </div>
                </div>

                <div>
                  <label htmlFor="story-initialization-ticket-input" className={labelClass}>绑定 TB 单</label>
                  <div className="flex items-center rounded-lg border border-zinc-700 bg-zinc-950/80 px-3 focus-within:border-cyan-500 focus-within:ring-2 focus-within:ring-cyan-500/10">
                    <span className="shrink-0 text-[10px] font-semibold text-zinc-600">TB</span>
                    <input
                      id="story-initialization-ticket-input"
                      value={draft.ticketInput || ""}
                      onChange={(event) => update("ticketInput", event.target.value)}
                      disabled={formDisabled}
                      className="min-w-0 flex-1 bg-transparent px-2 py-2 text-xs text-zinc-100 outline-none placeholder:text-zinc-700 disabled:opacity-50"
                      placeholder="CARB-13542 或 Teambition 任务链接（可选）"
                      autoComplete="off"
                      spellCheck="false"
                      data-testid="story-initialization-ticket-input"
                    />
                  </div>
                  <p className="mt-1.5 text-[10px] leading-relaxed text-zinc-600">未绑定 TB 单不会阻止创建；后续可在相同配置面板中补充或更换。</p>
                </div>

                <InferenceCard
                  enabled={inferenceEnabled}
                  status={inferenceStatus}
                  summary={resolvedInferenceSummary}
                  conflicts={conflicts}
                  resolvedCount={resolvedCount}
                  onRunInference={formDisabled ? undefined : onRunInference}
                  actionLabel={inferenceActionLabel}
                />
                <InferenceAttachmentZone
                  items={inferenceAttachments}
                  disabled={formDisabled}
                  error={inferenceAttachmentError}
                  onAddFiles={addInferenceAttachmentFiles}
                  onRemove={removeInferenceAttachment}
                />
              </div>
            </div>
          ) : null}

          {activeTab === "projects" ? (
            <div role="tabpanel" className="mx-auto max-w-4xl" data-testid="story-initialization-projects">
              <SectionTitle
                eyebrow="Scope"
                title="选择工程准备方式"
                detail="空白、本机与远程三种方式互不混用。切换方式只修改当前草稿，取消面板不会触发创建、克隆或 worktree 操作。"
              />

              <div className="grid gap-2 md:grid-cols-3">
                {MODE_OPTIONS.map((item) => {
                  const selected = draft.mode === item.id;
                  return (
                    <button
                      key={item.id}
                      type="button"
                      onClick={() => selectMode(item.id)}
                      disabled={configurationDisabled}
                      aria-pressed={selected}
                      className={`rounded-xl border p-3 text-left transition disabled:opacity-45 ${selected ? "border-cyan-500/70 bg-cyan-950/30 ring-2 ring-cyan-500/10" : "border-zinc-800 bg-zinc-900/45 hover:border-zinc-700 hover:bg-zinc-900"}`}
                      data-testid={`story-initialization-mode-${item.id}`}
                    >
                      <div className="flex items-center gap-2">
                        <span className={`flex h-7 w-7 items-center justify-center rounded-lg ${selected ? "bg-cyan-600/25 text-cyan-300" : "bg-zinc-800 text-zinc-500"}`}>{item.icon}</span>
                        <span className={`text-xs font-medium ${selected ? "text-zinc-100" : "text-zinc-300"}`}>{item.title}</span>
                      </div>
                      <p className="mt-2 text-[10px] leading-relaxed text-zinc-600">{item.detail}</p>
                    </button>
                  );
                })}
              </div>

              {draft.mode === "blank" ? (
                <div className="mt-5 rounded-xl border border-dashed border-zinc-700 bg-zinc-900/25 px-4 py-5 text-center">
                  <div className="text-sm text-zinc-300">将创建空白故事点</div>
                  <p className="mt-1.5 text-[10px] text-zinc-600">不会自动挑选本机工程，也不会在确认前创建任何工作区。</p>
                </div>
              ) : null}

              {draft.mode === "local" ? (
                <div className="mt-5 space-y-4">
                  <div className="flex min-w-0 flex-wrap items-center gap-2 rounded-xl border border-zinc-800 bg-zinc-900/45 p-1.5" role="tablist" aria-label="本机工程选择方式">
                    {[
                      ["branch", "按当前分支", "自由选择主工程和关联工程"],
                      ["flavor", "按车型 / Flavor", "按仓库与实时分支自动映射"],
                    ].map(([id, label, detail]) => {
                      const selected = localProjectPickerMode === id;
                      return (
                        <button
                          key={id}
                          type="button"
                          role="tab"
                          aria-selected={selected}
                          onClick={() => setLocalProjectPickerMode(id)}
                          className={`min-w-[170px] flex-1 rounded-lg border px-3 py-2 text-left transition ${selected ? "border-cyan-600/70 bg-cyan-950/35 shadow-[0_8px_24px_rgba(8,145,178,0.08)]" : "border-transparent text-zinc-500 hover:border-zinc-700 hover:bg-zinc-800/70"}`}
                          data-testid={`story-initialization-local-mode-${id}`}
                        >
                          <span className={`block text-[11px] font-medium ${selected ? "text-cyan-200" : "text-zinc-300"}`}>{label}</span>
                          <span className="mt-0.5 block text-[8px] leading-relaxed text-zinc-600">{detail}</span>
                        </button>
                      );
                    })}
                    {localProjectPickerMode === "flavor" && onRefreshProjects ? (
                      <button
                        type="button"
                        onClick={refreshLocalFlavorMappings}
                        disabled={formDisabled || refreshingProjects}
                        className="rounded-lg border border-zinc-700 bg-zinc-950/70 px-3 py-2 text-[9px] text-zinc-300 transition hover:border-cyan-700 hover:text-cyan-200 disabled:opacity-40"
                        data-testid="story-local-flavor-refresh"
                      >{refreshingProjects ? "刷新中…" : "↻ 刷新工程与分支"}</button>
                    ) : null}
                  </div>

                  {localProjectPickerMode === "branch" ? (
                    <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_minmax(0,1.25fr)]" data-testid="story-initialization-local-branch-picker">
                      <div>
                        <label htmlFor="story-initialization-primary-project" className={labelClass}>主工程 <span className="text-red-400">*</span></label>
                        <div className="flex min-w-0 items-center gap-2">
                          <LocalPrimaryProjectSelect
                            projects={orderedLocalProjects}
                            value={draft.primaryProjectId || ""}
                            onChange={selectPrimaryProject}
                            disabled={configurationDisabled}
                            error={errors.primaryProjectId}
                          />
                          {(() => {
                            const primaryProject = projects.find((project) => text(project.id) === text(draft.primaryProjectId));
                            return primaryProject && primaryProject.exists !== false && storyInitializationStudioPath(primaryProject)
                              ? <StudioBtn path={storyInitializationStudioPath(primaryProject)} onToast={onToast} compact />
                              : null;
                          })()}
                        </div>
                        {errors.primaryProjectId ? <p role="alert" className="mt-1.5 text-[10px] text-red-300">⚠ {errors.primaryProjectId}</p> : null}
                        {selectedPrimaryLocalProject ? (
                          <div className="mt-1.5">
                            <LocalProjectRuntimeMeta
                              project={selectedPrimaryLocalProject}
                              flavorByProjectId={draft.flavorByProjectId}
                              showFlavor={false}
                            />
                          </div>
                        ) : null}
                      </div>

                      <div>
                        <div className={labelClass}>关联工程</div>
                        <input
                          id="story-initialization-related-project-search"
                          type="search"
                          value={relatedProjectQuery}
                          onChange={(event) => setRelatedProjectQuery(event.target.value)}
                          disabled={configurationDisabled}
                          aria-label="搜索关联工程"
                          placeholder="搜索工程名、Git 分支或完整路径"
                          className={`${inputClass} mb-2`}
                        />
                        <div className="max-h-56 overflow-y-auto rounded-lg border border-zinc-800 bg-zinc-900/35 p-1.5">
                          {relatedLocalProjects.length ? relatedLocalProjects.map((project) => {
                              const checked = list(draft.extraProjectIds).includes(project.id);
                              return (
                                <div key={project.id} className={`flex items-center gap-2 rounded-lg px-2.5 py-2 transition ${checked ? "bg-violet-950/30" : "hover:bg-zinc-800/70"} ${project.exists === false ? "opacity-45" : ""}`}>
                                  <label className={`flex min-w-0 flex-1 items-start gap-2 ${project.exists === false ? "cursor-not-allowed" : "cursor-pointer"}`}>
                                    <input
                                      type="checkbox"
                                      checked={checked}
                                      onChange={() => toggleExtraProject(project.id)}
                                      disabled={configurationDisabled || project.exists === false}
                                      className="mt-0.5 accent-violet-500"
                                    />
                                    <span className="min-w-0 flex-1">
                                      <span className="block truncate text-[11px] text-zinc-300">{projectLabel(project)}</span>
                                      <LocalProjectRuntimeMeta
                                        project={project}
                                        flavorByProjectId={draft.flavorByProjectId}
                                        showFlavor={false}
                                        className="mt-1"
                                      />
                                    </span>
                                  </label>
                                  {storyInitializationStudioPath(project) && project.exists !== false ? (
                                    <StudioBtn path={storyInitializationStudioPath(project)} onToast={onToast} compact />
                                  ) : null}
                                </div>
                              );
                            }) : (
                              <div className="px-2 py-5 text-center text-[10px] text-zinc-700">
                                {relatedProjectQuery ? "没有匹配的关联工程" : "暂无可关联的本机工程"}
                              </div>
                            )}
                        </div>
                      </div>
                    </div>
                  ) : (
                    <div className="grid min-w-0 gap-4 lg:grid-cols-[minmax(230px,0.72fr)_minmax(0,1.5fr)]" data-testid="story-initialization-local-flavor-picker">
                      <section className="min-w-0 rounded-xl border border-zinc-800 bg-zinc-900/35 p-3">
                        <div className="mb-2 flex items-center justify-between gap-2">
                          <div>
                            <div className={labelClass}>车型 / Flavor</div>
                            <p className="text-[8px] text-zinc-600">选择后在右侧核对实时本机映射</p>
                          </div>
                          <span className="rounded-full border border-zinc-700 px-2 py-0.5 text-[8px] text-zinc-500">{localFlavorOptions.length} 组</span>
                        </div>
                        <input
                          type="search"
                          value={localFlavorQuery}
                          onChange={(event) => setLocalFlavorQuery(event.target.value)}
                          aria-label="搜索车型或 Flavor"
                          placeholder="搜索车型、Flavor 或应用"
                          className={`${inputClass} mb-2 py-1.5`}
                        />
                        <div className="max-h-[360px] space-y-1.5 overflow-y-auto pr-1">
                          {visibleLocalFlavorOptions.length ? visibleLocalFlavorOptions.map((option) => {
                            const selected = selectedLocalFlavorOption?.vehicle === option.vehicle;
                            const resolution = storyLocalFlavorMappingResolution(option, localFlavorProjectSelections, localFlavorSelections);
                            const requiredTargets = resolution.targets.filter((target) => !target.optional);
                            const readyCount = requiredTargets.filter((target) => target.selectedProject).length;
                            return (
                              <button
                                key={option.vehicle}
                                type="button"
                                onClick={() => setSelectedLocalVehicle(option.vehicle)}
                                className={`w-full min-w-0 rounded-xl border px-3 py-2.5 text-left transition ${selected ? "border-cyan-600/70 bg-cyan-950/30 shadow-[0_8px_24px_rgba(8,145,178,0.08)]" : "border-zinc-800 bg-zinc-950/45 hover:border-zinc-700 hover:bg-zinc-900"}`}
                                data-testid={`story-local-flavor-option-${option.vehicle}`}
                              >
                                <span className="flex min-w-0 items-center gap-2">
                                  <span className={`min-w-0 flex-1 truncate text-[11px] font-medium ${selected ? "text-cyan-200" : "text-zinc-300"}`}>{option.vehicle}</span>
                                  <span className={`shrink-0 rounded-full px-2 py-0.5 text-[8px] ${resolution.ok ? "bg-emerald-950/70 text-emerald-300" : "bg-amber-950/70 text-amber-300"}`}>{readyCount}/{requiredTargets.length} 必需项已匹配</span>
                                </span>
                                <span className="mt-1 flex min-w-0 flex-wrap gap-1">
                                  {(option.flavors.length ? option.flavors : ["未指定 Flavor"]).map((flavor) => <code key={flavor} className="max-w-full truncate rounded bg-violet-950/60 px-1.5 py-0.5 text-[8px] text-violet-300">{flavor}</code>)}
                                </span>
                                <span className="mt-1 block truncate text-[8px] text-zinc-600">{option.appNames.join("、") || "未命名应用"}</span>
                              </button>
                            );
                          }) : <div className="rounded-lg border border-dashed border-zinc-700 px-3 py-8 text-center text-[9px] leading-relaxed text-zinc-600">{localFlavorQuery ? "没有匹配的车型 / Flavor" : "当前 TB 项目尚未配置车型源码映射"}</div>}
                        </div>
                      </section>

                      <section className="min-w-0 rounded-xl border border-zinc-800 bg-zinc-900/35 p-3">
                        {projectMappingError ? (
                          <div role="alert" className="mb-3 rounded-lg border border-rose-900/60 bg-rose-950/25 px-3 py-2 text-[9px] leading-relaxed text-rose-300">本机工程映射读取失败：{projectMappingError}。已保留上次页面状态，请刷新后再应用。</div>
                        ) : null}
                        {selectedLocalFlavorOption ? (
                          <>
                            <div className="flex min-w-0 flex-wrap items-start gap-3 border-b border-zinc-800 pb-3">
                              <div className="min-w-0 flex-1">
                                <div className="text-[12px] font-medium text-zinc-100">{selectedLocalFlavorOption.vehicle} · 本机工程映射</div>
                                <p className="mt-1 text-[9px] leading-relaxed text-zinc-600">只接受仓库定义和目标分支同时匹配的本机 checkout；WebApp、SDK、AIEfficiency 等通用工程独立展示，其 Flavor 不从主工程复制。</p>
                              </div>
                              <button
                                type="button"
                                onClick={applyLocalFlavorMapping}
                                disabled={configurationDisabled || !!projectMappingError || !localFlavorResolution.ok}
                                className="rounded-lg bg-cyan-600 px-3 py-2 text-[10px] font-medium text-white transition hover:bg-cyan-500 disabled:cursor-not-allowed disabled:bg-zinc-800 disabled:text-zinc-600"
                                data-testid="story-local-flavor-apply"
                              >应用此 Flavor 映射</button>
                            </div>

                            <div className="mt-3 space-y-4">
                              {[
                                ["primary", "主工程", "当前车型的核心业务工程"],
                                ["related", "关联工程", "其它随车型变化的业务依赖"],
                                ["common", "通用工程", "WebApp、SDK、AIEfficiency 等独立仓库；额外工程按需加入"],
                              ].map(([category, title, detail]) => {
                                const targets = selectedLocalFlavorOption.targets.filter((target) => target.category === category);
                                if (!targets.length) return null;
                                return (
                                  <div key={category} data-testid={`story-local-flavor-group-${category}`}>
                                    <div className="mb-2 flex items-end justify-between gap-2">
                                      <div>
                                        <div className="text-[10px] font-medium uppercase tracking-[0.1em] text-zinc-400">{title}</div>
                                        <div className="mt-0.5 text-[8px] text-zinc-600">{detail}</div>
                                      </div>
                                      <span className="text-[8px] text-zinc-600">{targets.length} 个仓库</span>
                                    </div>
                                    <div className="space-y-2">
                                      {targets.map((target) => (
                                        <LocalFlavorTargetRow
                                          key={target.selectionKey}
                                          target={target}
                                          selectedProjectId={localFlavorProjectSelections[target.selectionKey] || target.autoProjectId}
                                          selectedFlavor={localFlavorResolution.targets.find((item) => item.selectionKey === target.selectionKey)?.selectedFlavor || localFlavorSelections[target.selectionKey]}
                                          onSelect={(projectId) => selectLocalFlavorProject(target.selectionKey, projectId)}
                                          onFlavorSelect={(flavor) => selectLocalFlavorValue(target.selectionKey, flavor)}
                                          disabled={configurationDisabled}
                                          onToast={onToast}
                                        />
                                      ))}
                                    </div>
                                  </div>
                                );
                              })}
                            </div>

                            {!localFlavorResolution.ok ? (
                              <div role="alert" className="mt-3 rounded-lg border border-amber-900/60 bg-amber-950/20 px-3 py-2">
                                {localFlavorResolution.errors.slice(0, 3).map((message) => <p key={message} className="text-[9px] leading-relaxed text-amber-300">⚠ {message}</p>)}
                                <p className="mt-1 text-[8px] text-zinc-600">配置或切换本机分支后，点击“刷新工程与分支”即可更新映射。</p>
                              </div>
                            ) : (
                              <div className="mt-3 rounded-lg border border-emerald-900/60 bg-emerald-950/20 px-3 py-2 text-[9px] text-emerald-300">✓ 仓库、分支与本机路径均已唯一确认；可单独应用，也可直接点击下一步。</div>
                            )}
                          </>
                        ) : <div className="px-4 py-12 text-center text-[10px] text-zinc-600">请先在左侧选择车型 / Flavor</div>}
                      </section>
                    </div>
                  )}
                </div>
              ) : null}

              {draft.mode === "remote" && availableVehicleEntries.length ? (
                <div className="mt-5 grid gap-4 lg:grid-cols-[minmax(210px,0.72fr)_minmax(0,1.5fr)]" data-testid="story-initialization-vehicle-source-picker">
                  <section className="rounded-xl border border-zinc-800 bg-zinc-900/35 p-3">
                    <div className={labelClass}>车型（可多选）</div>
                    <div className="max-h-64 space-y-1 overflow-y-auto">
                      {availableVehicleEntries.map(([vehicle, mapping]) => {
                        const checked = selectedVehicleRows.some((selection) => text(selection?.vehicle) === vehicle);
                        return (
                          <label key={vehicle} className={`flex cursor-pointer items-center gap-2 rounded-lg px-2.5 py-2 transition ${checked ? "bg-cyan-950/35 text-cyan-200" : "text-zinc-400 hover:bg-zinc-800/70"}`}>
                            <input
                              type="checkbox"
                              checked={checked}
                              onChange={() => toggleVehicle(vehicle)}
                              disabled={configurationDisabled}
                              className="accent-cyan-500"
                              data-testid={`story-initialization-vehicle-${vehicle}`}
                            />
                            <span className="min-w-0 flex-1 truncate text-[11px]">{vehicle}</span>
                            <span className="text-[9px] text-zinc-600">{list(mapping?.apps).length} 应用</span>
                          </label>
                        );
                      })}
                    </div>
                    <p className="mt-2 text-[9px] leading-relaxed text-zinc-600">选择车型时默认勾选其全部应用，可在右侧精简。仓库与分支始终以服务端车型源码配置为准。</p>
                  </section>

                  <section className="rounded-xl border border-zinc-800 bg-zinc-900/35 p-3">
                    <div className={labelClass}>应用（每个车型可多选）</div>
                    {selectedVehicleRows.length ? (
                      <div className="max-h-64 space-y-3 overflow-y-auto pr-1">
                        {selectedVehicleRows.map((selection) => {
                          const vehicle = text(selection?.vehicle);
                          const apps = list(vehicleMap?.[vehicle]?.apps);
                          return (
                            <div key={vehicle} className="rounded-lg border border-zinc-800 bg-zinc-950/45 p-2.5">
                              <div className="mb-2 flex items-center justify-between gap-2">
                                <span className="text-[10px] font-medium text-cyan-300">{vehicle}</span>
                                <span className="text-[9px] text-zinc-600">已选 {unique(selection?.appNames).length}/{apps.length}</span>
                              </div>
                              <div className="grid gap-1 sm:grid-cols-2">
                                {apps.map((app, index) => {
                                  const appName = text(app?.appName) || `未命名应用 ${index + 1}`;
                                  const checked = unique(selection?.appNames).includes(appName);
                                  return (
                                    <label key={appName} className={`flex cursor-pointer items-start gap-2 rounded px-2 py-1.5 ${checked ? "bg-violet-950/30" : "hover:bg-zinc-800/60"}`}>
                                      <input
                                        type="checkbox"
                                        checked={checked}
                                        onChange={() => toggleVehicleApplication(vehicle, appName)}
                                        disabled={configurationDisabled}
                                        className="mt-0.5 accent-violet-500"
                                      />
                                      <span className="min-w-0">
                                        <span className="block truncate text-[10px] text-zinc-300">{appName}</span>
                                        <span className="block text-[8px] text-zinc-600">{list(app?.repos).length} 个仓库目标</span>
                                      </span>
                                    </label>
                                  );
                                })}
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    ) : <div className="py-8 text-center text-[10px] text-zinc-700">请先在左侧选择一个或多个车型</div>}
                    {errors.vehicleSelections || vehiclePreview.errors[0] ? (
                      <p role="alert" className="mt-2 text-[10px] text-red-300">⚠ {errors.vehicleSelections || vehiclePreview.errors[0]}</p>
                    ) : null}
                  </section>
                </div>
              ) : null}

              {draft.mode === "remote" && !availableVehicleEntries.length ? (
                <div className="mt-5 grid gap-4 md:grid-cols-[minmax(0,1fr)_minmax(0,1.25fr)]">
                  <div>
                    <label htmlFor="story-initialization-primary-remote" className={labelClass}>远程主工程 <span className="text-red-400">*</span></label>
                    <select
                      id="story-initialization-primary-remote"
                      value={draft.projectDefId || ""}
                      onChange={(event) => selectPrimaryRemote(event.target.value)}
                      disabled={configurationDisabled}
                      className={`${inputClass} ${errors.projectDefId ? "border-red-500/70" : ""}`}
                      data-testid="story-initialization-primary-remote"
                    >
                      <option value="">— 选择远程主工程 —</option>
                      {orderedRemoteDefs.map((definition) => <option key={definition.id} value={definition.id}>{projectDefLabel(definition)}</option>)}
                    </select>
                    {errors.projectDefId ? <p role="alert" className="mt-1.5 text-[10px] text-red-300">⚠ {errors.projectDefId}</p> : null}
                    {draft.projectDefId ? (
                      <p className="mt-1.5 break-all font-mono text-[9px] text-zinc-700">
                        {(() => {
                          const definition = projectDefs.find((item) => item.id === draft.projectDefId);
                          return definition?.ssh || definition?.https || "仓库地址由服务端配置提供";
                        })()}
                      </p>
                    ) : null}
                  </div>

                  <div>
                    <div className={labelClass}>远程关联工程</div>
                    <div className="max-h-56 overflow-y-auto rounded-lg border border-zinc-800 bg-zinc-900/35 p-1.5">
                      {orderedRemoteDefs.filter((definition) => text(definition.id) !== text(draft.projectDefId)).length ? orderedRemoteDefs
                        .filter((definition) => text(definition.id) !== text(draft.projectDefId))
                        .map((definition) => {
                          const checked = list(draft.remoteProjectDefIds).includes(definition.id);
                          return (
                            <label key={definition.id} className={`flex cursor-pointer items-start gap-2 rounded-lg px-2.5 py-2 transition ${checked ? "bg-violet-950/30" : "hover:bg-zinc-800/70"}`}>
                              <input
                                type="checkbox"
                                checked={checked}
                                onChange={() => toggleRemoteProject(definition.id)}
                                disabled={configurationDisabled}
                                className="mt-0.5 accent-violet-500"
                              />
                              <span className="min-w-0 flex-1">
                                <span className="block truncate text-[11px] text-zinc-300">{projectDefLabel(definition)}</span>
                                <span className="block truncate text-[9px] text-zinc-700">{definition.projectType || "repository"}</span>
                              </span>
                            </label>
                          );
                        }) : <div className="px-2 py-5 text-center text-[10px] text-zinc-700">暂无可关联的远程工程定义</div>}
                    </div>
                  </div>
                </div>
              ) : null}
            </div>
          ) : null}

          {activeTab === "build" ? (
            <div role="tabpanel" className="mx-auto max-w-4xl" data-testid="story-initialization-build">
              <SectionTitle
                eyebrow="Build & Device"
                title="补充构建和设备配置"
                detail="Flavor 与设备都可以留空。设备仅在最终确认成功后绑定，不会因为打开或取消面板而被占用。"
              />

              {draft.mode === "local" ? (
                <section>
                  <div className="mb-2 text-[10px] font-medium uppercase tracking-[0.12em] text-zinc-500">本机工程 Flavor</div>
                  <div className="overflow-hidden rounded-xl border border-zinc-800 bg-zinc-900/35">
                    {selectedLocalProjects.length ? selectedLocalProjects.map((project, index) => (
                      <div key={project.id} className="grid gap-2 border-b border-zinc-800/80 px-3 py-3 last:border-b-0 sm:grid-cols-[minmax(0,1fr)_minmax(180px,0.65fr)] sm:items-center">
                        <div className="min-w-0">
                          <div className="flex items-center gap-2">
                            <span className={`rounded px-1.5 py-0.5 text-[8px] ${index === 0 ? "bg-cyan-950 text-cyan-400" : "bg-violet-950 text-violet-400"}`}>{index === 0 ? "主工程" : "关联"}</span>
                            <span className="truncate text-[11px] text-zinc-300">{projectLabel(project)}</span>
                          </div>
                          <LocalProjectRuntimeMeta
                            project={project}
                            flavorByProjectId={draft.flavorByProjectId}
                            className="mt-1"
                          />
                        </div>
                        <EditableCombobox
                          testId={`story-initialization-local-flavor-${project.id}`}
                          value={draft.flavorByProjectId?.[project.id] || ""}
                          options={unique([project.defaultFlavor, ...list(project.flavorOptions), ...list(project.flavors)])}
                          onChange={(value) => setFlavor(project.id, value)}
                          disabled={configurationDisabled}
                          className={inputClass}
                          placeholder="Flavor（可选）"
                          aria-label={`${projectLabel(project)} Flavor`}
                          popupClassName="z-[175]"
                          footerText="支持搜索已有 Flavor，也可以直接输入新值"
                        />
                      </div>
                    )) : (
                      <div className="px-4 py-6 text-center text-[10px] text-zinc-700">尚未选择本机工程，可返回“工程范围”补充。</div>
                    )}
                  </div>
                </section>
              ) : null}

              {draft.mode === "remote" && availableVehicleEntries.length ? (
                <section data-testid="story-initialization-source-plan">
                  <div className="mb-2 flex items-center justify-between gap-3">
                    <div className="text-[10px] font-medium uppercase tracking-[0.12em] text-zinc-500">源码准备计划</div>
                    <span className={`rounded px-2 py-0.5 text-[9px] ${vehiclePreview.ok ? "bg-emerald-950/60 text-emerald-400" : "bg-amber-950/60 text-amber-400"}`}>
                      {vehiclePreview.ok ? `${vehiclePreview.entries.length} 个分支目标` : "等待车型与应用选择"}
                    </span>
                  </div>
                  <div className="overflow-hidden rounded-xl border border-zinc-800 bg-zinc-900/35">
                    {vehiclePreview.entries.length ? vehiclePreview.entries.map((entry) => (
                      <div key={entry.targetKey || `${entry.projectId}:${entry.branch}`} className="grid gap-2 border-b border-zinc-800/80 px-3 py-3 last:border-b-0 sm:grid-cols-[minmax(0,0.8fr)_minmax(0,1fr)_auto] sm:items-center">
                        <div className="min-w-0">
                          <div className="flex items-center gap-2">
                            <span className={`rounded px-1.5 py-0.5 text-[8px] ${entry.targetRole === "primary" ? "bg-cyan-950 text-cyan-400" : "bg-violet-950 text-violet-400"}`}>{entry.targetRole === "primary" ? "主工程" : "关联"}</span>
                            <span className="truncate text-[11px] text-zinc-300">{projectDefLabel(projectDefs.find((definition) => definition.id === entry.projectId))}</span>
                          </div>
                          <div className="mt-1 truncate text-[9px] text-zinc-600">{entry.consumers.map((item) => `${item.vehicle}/${item.appName}`).join("、")}</div>
                        </div>
                        <div className="flex min-w-0 flex-wrap items-center gap-1.5 sm:col-span-2">
                          <RuntimeTag label="Git 分支" value={entry.branch} tone="branch" />
                          <RuntimeTag label="Flavor" value={entry.flavor || "未指定"} tone="flavor" />
                        </div>
                      </div>
                    )) : <div className="px-4 py-6 text-center text-[10px] text-zinc-700">返回“工程范围”选择车型与应用后生成计划</div>}
                  </div>
                  <p className="mt-2 text-[9px] leading-relaxed text-zinc-600">同仓同分支复用已校验基仓；同仓不同分支使用不同目录；每个故事点仍创建独立 worktree。</p>
                </section>
              ) : null}

              {draft.mode === "remote" && !availableVehicleEntries.length ? (
                <section>
                  <div className="mb-2 text-[10px] font-medium uppercase tracking-[0.12em] text-zinc-500">远程拉取参数</div>
                  <div className="grid gap-3 rounded-xl border border-zinc-800 bg-zinc-900/35 p-4 md:grid-cols-3">
                    <div>
                      <label htmlFor="story-initialization-vehicle" className={labelClass}>车型</label>
                      <input
                        id="story-initialization-vehicle"
                        value={draft.vehicle || ""}
                        onChange={(event) => update("vehicle", event.target.value)}
                        disabled={configurationDisabled}
                        className={inputClass}
                        placeholder="例如 avatr8678"
                        data-testid="story-initialization-vehicle"
                      />
                    </div>
                    <div>
                      <label htmlFor="story-initialization-branch" className={labelClass}>分支</label>
                      <input
                        id="story-initialization-branch"
                        value={draft.branch || ""}
                        onChange={(event) => update("branch", event.target.value)}
                        disabled={configurationDisabled}
                        className={inputClass}
                        placeholder="例如 release/202606"
                        list="story-initialization-branch-options"
                        data-testid="story-initialization-branch"
                      />
                      <datalist id="story-initialization-branch-options">
                        {unique(selectedRemoteDefs.flatMap((definition) => [definition.defaultBranch, ...list(definition.branchOptions)])).map((branch) => <option key={branch} value={branch} />)}
                      </datalist>
                    </div>
                    <div>
                      <label htmlFor="story-initialization-remote-flavor" className={labelClass}>Flavor</label>
                      <EditableCombobox
                        testId="story-initialization-remote-flavor"
                        value={draft.remoteFlavor || ""}
                        options={unique(selectedRemoteDefs.flatMap((definition) => [definition.defaultFlavor, ...list(definition.flavorOptions)]))}
                        onChange={(value) => update("remoteFlavor", value)}
                        disabled={configurationDisabled}
                        className={inputClass}
                        placeholder="例如 avatr8678Prod"
                        ariaLabel="远程工程 Flavor"
                        popupClassName="z-[175]"
                        footerText="支持搜索已有 Flavor，也可以直接输入新值"
                      />
                    </div>
                  </div>
                </section>
              ) : null}

              {draft.mode === "blank" ? (
                <div className="rounded-xl border border-zinc-800 bg-zinc-900/35 px-4 py-4 text-[11px] text-zinc-500">
                  空白模式没有工程级构建配置；创建后切换到本机或远程工程时可再填写 Flavor。
                </div>
              ) : null}

              <section className="mt-5">
                <div className="mb-2 flex items-center justify-between gap-3">
                  <label htmlFor="story-initialization-device" className="text-[10px] font-medium uppercase tracking-[0.12em] text-zinc-500">目标设备</label>
                  <button
                    type="button"
                    onClick={refreshDeviceList}
                    disabled={refreshingDevices || typeof onRefreshDevices !== "function"}
                    className="inline-flex items-center gap-1 rounded-lg border border-zinc-700 bg-zinc-900 px-2.5 py-1 text-[10px] text-zinc-300 transition hover:border-cyan-700/70 hover:bg-zinc-800 hover:text-cyan-200 disabled:cursor-wait disabled:opacity-45"
                    data-testid="story-initialization-device-refresh"
                    aria-label="刷新目标设备列表"
                  >
                    <span aria-hidden="true" className={refreshingDevices ? "animate-spin" : ""}>↻</span>
                    {refreshingDevices ? "刷新中…" : "刷新设备"}
                  </button>
                </div>
                <select
                  id="story-initialization-device"
                  value={draft.deviceSerial || ""}
                  onChange={(event) => update("deviceSerial", event.target.value)}
                  disabled={configurationDisabled}
                  className={inputClass}
                  data-testid="story-initialization-device"
                >
                  <option value="">— 不绑定设备 —</option>
                  {draft.deviceSerial && !devices.some((device) => text(device?.id || device?.serial) === text(draft.deviceSerial)) ? (
                    <option value={draft.deviceSerial}>{draft.deviceSerial}（当前离线或未返回）</option>
                  ) : null}
                  {devices.map((device) => {
                    const id = text(device?.id || device?.serial || device?.deviceSerial);
                    const offline = text(device?.status) && text(device.status) !== "device";
                    const bindings = list(device?.bindings);
                    const currentUse = device?.runtime?.lease || device?.currentUse || null;
                    const currentUseTitle = text(bindings.find((binding) => binding.storyId === currentUse?.storyId)?.title || currentUse?.storyId);
                    return (
                      <option key={id} value={id} disabled={offline}>
                        {deviceLabel(device)}{bindings.length ? ` — ${bindings.length} 个故事点已绑定` : ""}{currentUseTitle ? `，当前「${currentUseTitle}」使用中` : ""}
                      </option>
                    );
                  })}
                </select>
                <p className="mt-1.5 text-[10px] text-zinc-600">允许多个故事点绑定同一设备；ADB、安装、脚本与验收开始时会按 FIFO 队列取得独占运行时租约。</p>
                <div className="mt-3">
                  <DeviceRuntimeStatusCard
                    device={devices.find((device) => text(device?.id || device?.serial || device?.deviceSerial) === text(draft.deviceSerial))
                      || (draft.deviceSerial ? { id: draft.deviceSerial, connectivity: "offline" } : null)}
                  />
                </div>
              </section>
            </div>
          ) : null}

          {isEdit && activeTab === "workflow_archive" ? (
            <div role="tabpanel" className="mx-auto max-w-4xl space-y-6" data-testid="story-initialization-workflow-archive">
              <SectionTitle
                eyebrow="Workflow & Archive"
                title="配置报告模式与故事点存档"
                detail="这些设置只属于当前故事点，不会随工程配置复制，也不会被故事点组共享覆盖。"
              />

              <section>
                <div className="mb-2 text-[10px] font-medium uppercase tracking-[0.12em] text-zinc-500">报告模式</div>
                <div className="grid gap-3 md:grid-cols-2">
                  {[
                    {
                      id: "short",
                      title: "简短模式",
                      badge: "默认",
                      detail: "向 TB 回写通俗的“原因 + 措施”短评，不生成或上传报告附件。",
                      tone: "emerald",
                    },
                    {
                      id: "expert",
                      title: "专家报告模式",
                      badge: "HTML → PDF",
                      detail: "生成包含原因、方案、改动范围、测试建议与真实证据的 HTML，并转换 PDF 回传 TB；生成失败时不会推进 TB。",
                      tone: "fuchsia",
                    },
                  ].map((option) => {
                    const selected = draft.reportMode === option.id;
                    return (
                      <button
                        key={option.id}
                        type="button"
                        onClick={() => update("reportMode", option.id)}
                        disabled={formDisabled}
                        aria-pressed={selected}
                        className={`rounded-xl border p-4 text-left transition disabled:opacity-45 ${selected
                          ? option.tone === "fuchsia"
                            ? "border-fuchsia-400/60 bg-fuchsia-950/30 ring-2 ring-fuchsia-500/10"
                            : "border-emerald-400/60 bg-emerald-950/30 ring-2 ring-emerald-500/10"
                          : "border-zinc-800 bg-zinc-900/40 hover:border-zinc-600"}`}
                        data-testid={`story-initialization-report-mode-${option.id}`}
                      >
                        <span className="flex items-center justify-between gap-2">
                          <span className="text-xs font-semibold text-zinc-100">{option.title}</span>
                          <span className={`rounded px-2 py-0.5 text-[8px] ${option.tone === "fuchsia" ? "bg-fuchsia-900/50 text-fuchsia-300" : "bg-emerald-900/50 text-emerald-300"}`}>{option.badge}</span>
                        </span>
                        <span className="mt-2 block text-[10px] leading-relaxed text-zinc-500">{option.detail}</span>
                      </button>
                    );
                  })}
                </div>
              </section>

              <section>
                <div className="mb-2 flex items-center justify-between gap-3">
                  <div className="text-[10px] font-medium uppercase tracking-[0.12em] text-zinc-500">存档目录</div>
                  <span className="text-[9px] text-zinc-600">仅允许当前故事点的 ask 目录或其子目录</span>
                </div>
                {draft.rejectedArchiveDir ? (
                  <div role="alert" className="mb-3 rounded-xl border border-amber-600/50 bg-amber-950/25 px-3 py-2 text-[10px] leading-relaxed text-amber-200">
                    旧存档路径不在安全范围内，已自动回退默认目录：<span className="font-mono">{draft.rejectedArchiveDir}</span>
                  </div>
                ) : null}
                <div className="rounded-xl border border-zinc-800 bg-zinc-900/35 p-4">
                  <div className="grid gap-2 sm:grid-cols-2">
                    <button
                      type="button"
                      onClick={() => update("archiveMode", "default")}
                      disabled={formDisabled}
                      aria-pressed={draft.archiveMode !== "custom"}
                      className={`rounded-lg border px-3 py-2.5 text-left transition ${draft.archiveMode !== "custom" ? "border-cyan-500/55 bg-cyan-950/25" : "border-zinc-700 bg-zinc-950/40 hover:border-zinc-600"}`}
                    >
                      <span className="block text-[11px] font-medium text-zinc-200">使用默认目录</span>
                      <span className="mt-1 block truncate font-mono text-[9px] text-zinc-600" title={draft.defaultArchiveDir}>{draft.defaultArchiveDir || "由故事点存储规则自动生成"}</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => update("archiveMode", "custom")}
                      disabled={formDisabled}
                      aria-pressed={draft.archiveMode === "custom"}
                      className={`rounded-lg border px-3 py-2.5 text-left transition ${draft.archiveMode === "custom" ? "border-violet-500/55 bg-violet-950/25" : "border-zinc-700 bg-zinc-950/40 hover:border-zinc-600"}`}
                    >
                      <span className="block text-[11px] font-medium text-zinc-200">使用自定义子目录</span>
                      <span className="mt-1 block text-[9px] text-zinc-600">适合为当前故事点单独整理多轮 ask 存档</span>
                    </button>
                  </div>
                  {draft.archiveMode === "custom" ? (
                    <div className="mt-3 flex flex-wrap items-center gap-2">
                      <input
                        value={draft.archiveDir || ""}
                        onChange={(event) => update("archiveDir", event.target.value)}
                        disabled={formDisabled}
                        className={`${inputClass} min-w-[260px] flex-1 font-mono`}
                        placeholder={draft.defaultArchiveDir || "当前故事点 ask 下的绝对路径"}
                        data-testid="story-initialization-archive-dir"
                      />
                      <button
                        type="button"
                        onClick={() => setShowArchiveDirPicker(true)}
                        disabled={formDisabled}
                        className="rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2 text-[10px] text-zinc-200 transition hover:bg-zinc-700 disabled:opacity-40"
                      >选择目录</button>
                      {errors.archiveDir ? <span role="alert" className="w-full text-[9px] text-red-300">⚠ {errors.archiveDir}</span> : null}
                    </div>
                  ) : null}
                  <div className="mt-3 flex flex-wrap items-center gap-2 rounded-lg border border-zinc-800 bg-zinc-950/45 px-3 py-2">
                    <span className="min-w-0 flex-1 truncate font-mono text-[9px] text-zinc-400" title={draft.archiveMode === "custom" ? draft.archiveDir : draft.defaultArchiveDir}>
                      当前将使用：{draft.archiveMode === "custom" ? (draft.archiveDir || "尚未选择") : (draft.defaultArchiveDir || draft.effectiveArchiveDir || "默认目录")}
                    </span>
                    <button type="button" onClick={() => copySettingPath(draft.archiveMode === "custom" ? draft.archiveDir : draft.defaultArchiveDir, "存档目录")} className="text-[9px] text-cyan-300 hover:text-cyan-200">复制</button>
                    <button type="button" onClick={() => openSettingDirectory(draft.archiveMode === "custom" ? draft.archiveDir : draft.defaultArchiveDir)} className="text-[9px] text-emerald-300 hover:text-emerald-200">打开目录</button>
                  </div>
                </div>

                <details className="group mt-3 overflow-hidden rounded-xl border border-zinc-800 bg-zinc-900/25">
                  <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2.5 text-[10px] text-zinc-400 marker:content-none hover:bg-zinc-800/45">
                    <span>目录用途与快捷操作</span>
                    <span className="ml-auto text-zinc-600 group-open:hidden">展开</span>
                    <span className="ml-auto hidden text-zinc-600 group-open:inline">收起</span>
                  </summary>
                  <div className="divide-y divide-zinc-800 border-t border-zinc-800">
                    {[
                      ["TXT 存档", draft.archiveFile, "每轮问答的文本存档文件"],
                      ["附件", draft.attachmentDir, "备注图片、视频及其它工单附件"],
                      ["报告", draft.reportsDir, "专家 HTML / PDF 与验收报告"],
                      ["临时文件", draft.tempDir, "运行期临时证据，不进入产品代码"],
                      ["脚本", draft.scriptsDir, "故事点临时执行脚本"],
                    ].map(([label, value, detail]) => (
                      <div key={label} className="flex items-center gap-3 px-3 py-2">
                        <span className="w-16 shrink-0 text-[9px] text-zinc-500">{label}</span>
                        <span className="min-w-0 flex-1 truncate font-mono text-[9px] text-zinc-400" title={value}>{value || "尚未生成"}</span>
                        <span className="hidden text-[8px] text-zinc-700 lg:inline">{detail}</span>
                        <button type="button" disabled={!value} onClick={() => copySettingPath(value, label)} className="text-[9px] text-cyan-400 disabled:opacity-30">复制</button>
                        {label !== "TXT 存档" ? <button type="button" disabled={!value} onClick={() => openSettingDirectory(value)} className="text-[9px] text-emerald-400 disabled:opacity-30">打开</button> : null}
                      </div>
                    ))}
                  </div>
                </details>
              </section>
            </div>
          ) : null}

          {activeTab === "review" ? (
            <div role="tabpanel" className="mx-auto max-w-4xl" data-testid="story-initialization-review">
              <SectionTitle
                eyebrow="Review"
                title={isEdit ? "确认配置变更" : "确认后才创建真实故事点"}
                detail={isEdit ? "请核对更改范围。点击确认前不会写回现有故事点。" : "请核对标题、工程和设备。点击确认后才会创建故事点 Tab，并按配置准备工程。"}
              />

              <div className="grid gap-4 lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)]">
                <div className="rounded-xl border border-zinc-800 bg-zinc-900/35 px-4 py-1">
                  <SummaryRow label="来源">{resolvedSourceLabel}</SummaryRow>
                  <SummaryRow label="标题">{draft.title}</SummaryRow>
                  <SummaryRow label="TB 单">{draft.ticketInput || "未绑定"}</SummaryRow>
                  <SummaryRow label="工程方式">{modeLabel(draft.mode)}</SummaryRow>
                  {draft.mode === "local" ? (
                    <>
                      <SummaryRow label="主工程">
                        {selectedPrimaryLocalProject ? (
                          <div className="space-y-1.5">
                            <div>{projectLabel(selectedPrimaryLocalProject)}</div>
                            <LocalProjectRuntimeMeta
                              project={selectedPrimaryLocalProject}
                              flavorByProjectId={draft.flavorByProjectId}
                            />
                          </div>
                        ) : "未选择"}
                      </SummaryRow>
                      <SummaryRow label="关联工程">
                        {selectedLocalProjects.length > 1 ? (
                          <div className="space-y-2.5">
                            {selectedLocalProjects.slice(1).map((project) => (
                              <div key={project.id} className="space-y-1.5">
                                <div>{projectLabel(project)}</div>
                                <LocalProjectRuntimeMeta
                                  project={project}
                                  flavorByProjectId={draft.flavorByProjectId}
                                />
                              </div>
                            ))}
                          </div>
                        ) : "无"}
                      </SummaryRow>
                      <SummaryRow label="Flavor">
                        {selectedLocalProjects.map((project) => {
                          const flavor = text(draft.flavorByProjectId?.[project.id]);
                          return flavor ? `${projectLabel(project)}：${flavor}` : "";
                        }).filter(Boolean).join("；") || "未指定"}
                      </SummaryRow>
                    </>
                  ) : null}
                  {draft.mode === "remote" ? (
                    <>
                      {selectedVehicleRows.length ? (
                        <>
                          <SummaryRow label="车型 / 应用">
                            {selectedVehicleRows.map((selection) => `${selection.vehicle}：${unique(selection.appNames).join("、") || "未选应用"}`).join("；")}
                          </SummaryRow>
                          <SummaryRow label="源码目标">{vehiclePreview.entries.map((entry) => `${entry.projectId}@${entry.branch}`).join("；") || "尚未生成"}</SummaryRow>
                          <SummaryRow label="分支隔离">同仓同分支复用基仓；不同分支独立目录</SummaryRow>
                        </>
                      ) : (
                        <>
                          <SummaryRow label="远程主工程">{projectDefLabel(projectDefs.find((definition) => definition.id === draft.projectDefId))}</SummaryRow>
                          <SummaryRow label="关联工程">{selectedRemoteDefs.slice(1).map(projectDefLabel).join("、") || "无"}</SummaryRow>
                          <SummaryRow label="车型 / 分支">{[draft.vehicle, draft.branch].map(text).filter(Boolean).join(" / ") || "未指定"}</SummaryRow>
                          <SummaryRow label="Flavor">{draft.remoteFlavor || "未指定"}</SummaryRow>
                        </>
                      )}
                    </>
                  ) : null}
                  <SummaryRow label="设备">{draft.deviceSerial || "未绑定"}</SummaryRow>
                  {isEdit ? (
                    <>
                      <SummaryRow label="报告模式" tone={draft.reportMode === "expert" ? "warning" : "success"}>
                        {draft.reportMode === "expert" ? "专家报告（HTML → PDF）" : "简短报告（原因 + 措施）"}
                      </SummaryRow>
                      <SummaryRow label="存档目录">
                        {draft.archiveMode === "custom"
                          ? (draft.archiveDir || "自定义目录尚未填写")
                          : (draft.defaultArchiveDir || draft.effectiveArchiveDir || "默认目录")}
                      </SummaryRow>
                    </>
                  ) : null}
                </div>

                <div className="space-y-3">
                  <InferenceCard
                    enabled={inferenceEnabled}
                    status={inferenceStatus}
                    summary={resolvedInferenceSummary}
                    conflicts={conflicts}
                    resolvedCount={resolvedCount}
                    onRunInference={formDisabled ? undefined : onRunInference}
                    actionLabel={inferenceActionLabel}
                  />
                  <InferenceAttachmentZone
                    items={inferenceAttachments}
                    disabled={formDisabled}
                    error={inferenceAttachmentError}
                    onAddFiles={addInferenceAttachmentFiles}
                    onRemove={removeInferenceAttachment}
                  />

                  {conflicts.length ? (
                    <section className="rounded-xl border border-amber-800/60 bg-amber-950/15 p-3.5" data-testid="story-initialization-conflicts">
                      <div className="flex items-center justify-between gap-2">
                        <div>
                          <h4 className="text-[11px] font-medium text-amber-200">不同来源存在矛盾，请逐项人工裁决</h4>
                          <p className="mt-1 text-[9px] leading-relaxed text-amber-700">来源优先级只提供推荐。选择候选会同步到对应配置字段；无法可靠映射时，请先人工填写配置，再选择“以当前面板配置为准”。</p>
                        </div>
                        <span className={`shrink-0 rounded px-2 py-1 text-[9px] ${unresolvedConflicts.length ? "bg-amber-900/50 text-amber-300" : "bg-emerald-950/60 text-emerald-400"}`}>
                          {resolvedCount}/{conflicts.length}
                        </span>
                      </div>

                      <div className="mt-3 space-y-3">
                        {conflicts.map((item) => {
                          const storedDecision = conflictDecision(draft.conflictResolutions, item.id);
                          const decisionIsCurrent = conflictResolutionIsCurrent(item, storedDecision);
                          const decision = decisionIsCurrent ? storedDecision : null;
                          const sharedConflictLocked = sharedConfigurationLocked
                            && isStoryInitializationSharedConfigurationConflict(item);
                          return (
                            <fieldset key={item.id} className="rounded-lg border border-amber-900/40 bg-zinc-950/45 p-3">
                              <legend className="px-1 text-[10px] font-medium text-zinc-300">{item.label}</legend>
                              {item.detail ? <p className="mb-2 text-[9px] leading-relaxed text-zinc-600">{item.detail}</p> : null}
                              {sharedConflictLocked ? (
                                <p className="mb-2 text-[9px] leading-relaxed text-violet-400">
                                  该维度由组共享配置锁定；请使用“以当前面板配置为准”完成裁决。
                                </p>
                              ) : null}
                              <div className="space-y-1.5">
                                {item.candidates.map((candidate) => (
                                  <label key={candidate.id} className={`flex cursor-pointer items-start gap-2 rounded-lg border px-2.5 py-2 transition ${decision?.selection === `candidate:${candidate.value}` ? "border-cyan-700/70 bg-cyan-950/25" : "border-zinc-800 bg-zinc-900/35 hover:border-zinc-700"}`}>
                                    <input
                                      type="radio"
                                      name={`conflict-${item.id}`}
                                      checked={decision?.selection === `candidate:${candidate.value}`}
                                      onChange={() => resolveConflict(item, `candidate:${candidate.value}`, candidate.value)}
                                      disabled={formDisabled || sharedConflictLocked}
                                      className="mt-0.5 accent-cyan-500"
                                    />
                                    <span className="min-w-0 flex-1">
                                      <span className="flex flex-wrap items-center gap-1.5 text-[10px] text-zinc-300">
                                        <span className="break-all font-mono">{candidate.label}</span>
                                        {candidate.recommended ? <span className="rounded bg-cyan-950 px-1.5 py-0.5 text-[8px] text-cyan-400">推理推荐</span> : null}
                                      </span>
                                      {candidate.sourceGroups.length ? (
                                        <span className="mt-1 block text-[8px] text-zinc-600">
                                          来源：{candidate.sourceGroups.map((source) => SOURCE_LABELS[source] || source).join("、")}
                                        </span>
                                      ) : null}
                                      {candidate.detail ? <span className="mt-1 block text-[8px] text-zinc-600">{candidate.detail}</span> : null}
                                    </span>
                                  </label>
                                ))}
                                <label className={`flex cursor-pointer items-start gap-2 rounded-lg border px-2.5 py-2 transition ${decision?.selection === "manual" ? "border-violet-700/70 bg-violet-950/25" : "border-zinc-800 bg-zinc-900/35 hover:border-zinc-700"}`}>
                                  <input
                                    type="radio"
                                    name={`conflict-${item.id}`}
                                    checked={decision?.selection === "manual"}
                                    onChange={() => resolveConflict(item, "manual")}
                                    disabled={formDisabled}
                                    className="mt-0.5 accent-violet-500"
                                  />
                                  <span className="text-[10px] text-zinc-300">以当前面板中人工填写的配置为准</span>
                                </label>
                                {errors.conflictMappings?.[item.id] ? (
                                  <p role="alert" className="px-1 pt-1 text-[9px] leading-relaxed text-red-300">⚠ {errors.conflictMappings[item.id]}</p>
                                ) : null}
                                {storedDecision && !decisionIsCurrent ? (
                                  <p role="alert" className="px-1 pt-1 text-[9px] leading-relaxed text-amber-300">⚠ 当前配置已与先前候选不一致，请重新选择候选，或以当前面板配置为准。</p>
                                ) : null}
                              </div>
                            </fieldset>
                          );
                        })}
                      </div>
                      {errors.conflicts ? <p role="alert" className="mt-2 text-[10px] text-red-300">⚠ {errors.conflicts}</p> : null}
                    </section>
                  ) : null}
                </div>
              </div>

              {!conflicts.length ? (
                <div className="mt-4 rounded-xl border border-emerald-900/50 bg-emerald-950/15 px-3 py-2 text-[10px] text-emerald-400">
                  ✓ 当前没有待裁决的来源矛盾{canConfirm
                    ? `，可以确认${isEdit ? "更新" : "创建"}`
                    : "；请先完成当前配置的必填项与来源检查"}。
                  {!isEdit && inferenceEnabled ? " AI 推理仅提供异步建议，不参与创建门禁。" : ""}
                </div>
              ) : null}
              {error ? <div role="alert" className="mt-3 rounded-xl border border-red-900/60 bg-red-950/25 px-3 py-2 text-[10px] text-red-300">⚠ {error}</div> : null}
            </div>
          ) : null}
        </main>

        <footer className="relative flex shrink-0 items-center gap-2 border-t border-zinc-800 bg-zinc-900/45 px-5 py-3.5">
          <span className="min-w-0 flex-1 truncate text-[9px] text-zinc-600">
            {busy
              ? (isEdit ? "正在应用故事点配置…" : "正在创建故事点并准备工作区…")
              : partialRecovery
                ? "部分创建结果需人工核对；关闭面板会保留该失败结果，不会再次创建"
              : controlsLocked
                ? "正在检查或运行 AI 推理；你可以取消整个创建流程"
              : (isEdit ? "取消将放弃本面板中的未保存更改" : "取消不会创建 Tab、工程 worktree 或设备绑定")}
          </span>
          {!isEdit && activeTab !== "identity" ? (
            <button
              type="button"
              onClick={goBack}
              disabled={formDisabled}
              className="rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-xs text-zinc-400 transition hover:bg-zinc-800 hover:text-zinc-100 disabled:opacity-40"
            >上一步</button>
          ) : null}
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="rounded-lg px-3 py-2 text-xs text-zinc-400 transition hover:bg-zinc-800 hover:text-zinc-100 disabled:opacity-40"
          >{partialRecovery ? "关闭面板" : "取消"}</button>
          {primaryAction === "confirm" ? (
            <button
              type="button"
              onClick={submit}
              disabled={formDisabled || confirmAction === "blocked" || unresolvedConflicts.length > 0}
              className="min-w-28 rounded-lg border border-cyan-400/30 bg-gradient-to-r from-cyan-600 to-blue-600 px-4 py-2 text-xs font-medium text-white shadow-lg shadow-cyan-950/30 transition hover:from-cyan-500 hover:to-blue-500 disabled:cursor-not-allowed disabled:border-zinc-700 disabled:from-zinc-800 disabled:to-zinc-800 disabled:text-zinc-500 disabled:shadow-none"
              data-testid="story-initialization-confirm"
              data-confirm-action={confirmAction}
            >{busy ? (isEdit ? "更新中…" : "创建中…") : (isEdit ? "确认更新" : "确认创建")}</button>
          ) : (
            <button
              type="button"
              onClick={goNext}
              disabled={formDisabled}
              className="rounded-lg border border-cyan-700/50 bg-cyan-950/40 px-4 py-2 text-xs font-medium text-cyan-200 transition hover:bg-cyan-900/50 disabled:opacity-40"
              data-testid="story-initialization-next"
            >下一步</button>
          )}
        </footer>
      </div>
      {showArchiveDirPicker ? (
        <FolderPickerModal
          initialPath={draft.archiveDir || draft.defaultArchiveDir || ""}
          title="选择故事点存档目录"
          zClassName="z-[180]"
          onPick={(selectedPath) => {
            update("archiveMode", "custom");
            update("archiveDir", selectedPath);
          }}
          onClose={() => setShowArchiveDirPicker(false)}
        />
      ) : null}
    </div>
  );

  return createPortal(panel, document.body);
}
