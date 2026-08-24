import React, { useEffect, useMemo, useRef, useState } from "react";
import EditableCombobox from "./EditableCombobox.jsx";
import {
  configInferenceDisplayText,
  configInferenceSessionKey,
  defaultConfigInferenceReviewDecision,
  defaultConfigInferenceReviewRating,
} from "./configInferenceReviewModel.mjs";
import {
  annotationGovernance,
  confidencePresentation,
  configInferenceConflictGate,
  configInferenceSourceGate,
} from "./aiTrainingGovernanceModel.mjs";

const SIGNAL_GROUPS = [
  { key: "title", aliases: ["title"], label: "标题关键词" },
  { key: "project", aliases: ["project", "projects", "taskList"], label: "项目关键词" },
  { key: "iteration", aliases: ["iteration", "sprint", "sprintName"], label: "迭代关键词" },
  { key: "tag", aliases: ["tag", "tags"], label: "标签关键词" },
  { key: "attachment", aliases: ["attachment", "attachments"], label: "附件关键词" },
  { key: "comment", aliases: ["comment", "comments"], label: "评论关键词" },
  { key: "note", aliases: ["note", "description"], label: "TB 单备注" },
];

const DECISIONS = [
  { value: "correct", label: "推理正确", detail: "主工程与依赖工程配置可以直接使用" },
  { value: "corrected", label: "纠正后正确", detail: "已在下方修正推理结果" },
  { value: "insufficient", label: "信息不足", detail: "现有信号不足以判断配置" },
];

const REPOSITORY_ONLY_TYPES = new Set(["sdk", "tooling", "service", "repository"]);
const SYMBOLIC_FIELDS = new Set(["appName", "vehicle", "repositoryId", "branch", "flavor"]);
const VALUE_BINDING_FIELDS = [...SYMBOLIC_FIELDS, "order"];
const PROJECT_TYPE_LABELS = {
  application: "应用工程",
  sdk: "SDK 工程",
  tooling: "工具工程",
  service: "服务工程",
  repository: "仓库工程",
};

const TARGET_ROLE_META = {
  primary: {
    label: "主工程",
    deleteLabel: "主工程",
    className: "border-cyan-800 bg-cyan-950/35 text-cyan-300",
  },
  dependency: {
    label: "依赖工程",
    deleteLabel: "依赖",
    className: "border-violet-900/70 bg-violet-950/30 text-violet-300",
  },
  standalone: {
    label: "独立工程",
    deleteLabel: "独立工程",
    className: "border-emerald-900/70 bg-emerald-950/30 text-emerald-300",
  },
};

const inputClass = "w-full min-w-0 rounded border border-zinc-700 bg-zinc-950 px-2 py-1.5 text-[11px] text-zinc-200 outline-none transition placeholder:text-zinc-700 focus:border-cyan-600 disabled:cursor-not-allowed disabled:opacity-55";

const text = configInferenceDisplayText;

function unique(values) {
  return [...new Set((values || []).map(text).filter(Boolean))];
}

function normalizeTargetRole(value, fallback = "dependency") {
  const role = text(value).toLowerCase();
  return ["primary", "dependency", "standalone"].includes(role) ? role : fallback;
}

function targetRoleMeta(target, index = 0) {
  const role = normalizeTargetRole(target?.targetRole, index === 0 ? "primary" : "dependency");
  return { role, ...TARGET_ROLE_META[role] };
}

function normalizeFieldStates(value) {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  return Object.fromEntries([...SYMBOLIC_FIELDS].flatMap((field) => {
    const row = source[field];
    if (!row || typeof row !== "object" || row.kind !== "symbolic") return [];
    return [[field, { kind: "symbolic", feature: text(row.feature) }]];
  }));
}

function normalizeFieldBindings(value, target = {}) {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  return Object.fromEntries(VALUE_BINDING_FIELDS.flatMap((field) => {
    const row = source[field];
    if (!row || typeof row !== "object" || !text(row.logicalKey)) return [];
    const fallbackValue = field === "order" ? target.order : target[field];
    return [[field, {
      logicalKey: text(row.logicalKey),
      actualValue: text(row.actualValue ?? fallbackValue),
      defaultValue: text(row.defaultValue),
      sourceValue: text(row.sourceValue),
      scopeKey: text(row.scopeKey),
      label: text(row.label),
      revision: Math.max(0, Math.trunc(Number(row.revision) || 0)),
      resolved: row.resolved !== false && !!text(row.actualValue ?? fallbackValue),
      replaceable: row.replaceable !== false && field !== "order",
    }]];
  }));
}

function syncBindingActualValues(fieldBindings, patch = {}, fieldStates = {}) {
  const next = { ...(fieldBindings || {}) };
  const symbolicStates = normalizeFieldStates(fieldStates);
  for (const field of VALUE_BINDING_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(patch, field) || !next[field]?.logicalKey) continue;
    const actualValue = symbolicStates[field]?.kind === "symbolic" ? "" : text(patch[field]);
    next[field] = { ...next[field], actualValue, resolved: !!actualValue };
  }
  return next;
}

function isSymbolicField(target, field) {
  return target?.fieldStates?.[field]?.kind === "symbolic";
}

function SymbolicFieldControl({ target, field, label, disabled, onToggle, onFeatureChange, testId }) {
  const symbolic = isSymbolicField(target, field);
  return (
    <div className="mt-1 space-y-1">
      <button
        type="button"
        data-testid={`${testId}-mode`}
        aria-pressed={symbolic}
        disabled={disabled}
        onClick={onToggle}
        className={`rounded border px-1.5 py-0.5 text-[8px] transition disabled:cursor-not-allowed disabled:opacity-45 ${symbolic ? "border-amber-700/70 bg-amber-950/35 text-amber-300" : "border-zinc-800 text-zinc-600 hover:border-zinc-700 hover:text-zinc-400"}`}
        title={symbolic ? `${label}当前是待替换代号，点击改为实际值` : `${label}尚未确定时可标记为代号/中间值`}
      >
        {symbolic ? "代号值 · 待替换" : "实际值"}
      </button>
      {symbolic ? (
        <input
          data-testid={`${testId}-feature`}
          value={target.fieldStates?.[field]?.feature || ""}
          onChange={(event) => onFeatureChange(event.target.value)}
          disabled={disabled}
          className="w-full rounded border border-amber-900/50 bg-amber-950/15 px-1.5 py-1 text-[8px] text-amber-200 outline-none placeholder:text-amber-900 focus:border-amber-700"
          placeholder={`${label}的特征说明（可选）`}
          aria-label={`${label}代号的特征说明`}
        />
      ) : null}
    </div>
  );
}

function FieldBindingMeta({ target, field, label, testId }) {
  const binding = target?.fieldBindings?.[field];
  if (!binding?.logicalKey) {
    return (
      <div data-testid={`${testId}-binding`} className="mt-1 flex min-w-0 items-center gap-1 text-[8px] text-zinc-700">
        <span className="shrink-0">实际值可替换</span>
        <span aria-hidden="true">·</span>
        <span className="truncate">Annotation 保存后生成候选永久 Key，审批/激活后进入 serving</span>
      </div>
    );
  }
  return (
    <div data-testid={`${testId}-binding`} className="mt-1 rounded border border-cyan-900/45 bg-cyan-950/15 px-1.5 py-1">
      <div className="flex min-w-0 items-center gap-1">
        <span aria-hidden="true" className="shrink-0 text-[8px] text-cyan-500">▣</span>
        <span className="shrink-0 text-[8px] font-medium text-cyan-600">永久 Key</span>
        <code className="min-w-0 flex-1 truncate text-[8px] text-cyan-300" title={binding.logicalKey}>{binding.logicalKey}</code>
        <span className={`shrink-0 rounded px-1 py-0.5 text-[7px] ${binding.resolved ? "bg-emerald-950/50 text-emerald-500" : "bg-amber-950/50 text-amber-500"}`}>{binding.resolved ? "值可替换" : "待填实际值"}</span>
      </div>
      <span className="sr-only">{label}的逻辑 Key 永久不变，输入框内容是可以替换的实际值。</span>
    </div>
  );
}

function firstValue(source, aliases) {
  for (const key of aliases) {
    if (source?.[key] !== undefined && source[key] !== null && source[key] !== "") return source[key];
  }
  return null;
}

function displayValue(value) {
  if (value === null || value === undefined) return "";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return text(value);
  if (Array.isArray(value)) return value.map(displayValue).filter(Boolean).join("、");
  if (typeof value === "object") {
    for (const key of ["keyword", "value", "name", "title", "fileName", "filename", "label", "text", "content", "path"]) {
      if (value[key] !== undefined && value[key] !== null && value[key] !== "") {
        const displayed = text(value[key]);
        if (displayed) return displayed;
      }
    }
    try { return JSON.stringify(value); } catch { return ""; }
  }
  return text(value);
}

function displayItems(value) {
  const rows = Array.isArray(value) ? value : value === null || value === undefined || value === "" ? [] : [value];
  return unique(rows.map(displayValue));
}

function normalizeTarget(raw = {}, key = "") {
  const repository = raw.repository && typeof raw.repository === "object" ? raw.repository : {};
  const variant = raw.variant && typeof raw.variant === "object" ? raw.variant : {};
  const projectType = text(raw.projectType || raw.targetType || repository.projectType).toLowerCase() || "application";
  const configuredOrder = Number(raw.order ?? raw.sortOrder);
  const fieldStates = normalizeFieldStates(raw.fieldStates);
  const target = {
    _key: key,
    targetId: text(raw.targetId || raw.targetKey || key),
    appName: text(raw.appName || raw.applicationName || raw.application || raw.app),
    vehicle: text(raw.vehicle || raw.carModel || raw.model || variant.vehicle),
    repositoryId: text(raw.repositoryId || raw.repoId || repository.id),
    repositoryName: text(raw.repositoryName || raw.repoName || repository.name),
    gitUrl: text(raw.gitUrl || raw.repositoryUrl || repository.gitUrl || repository.url),
    branch: text(raw.branch || raw.baseBranch || raw.targetBranch),
    flavor: text(raw.flavor || variant.flavor),
    projectType,
    targetRole: text(raw.targetRole || raw.role).toLowerCase(),
    repositoryOnly: raw.repositoryOnly === true || raw.targetScope === "repository" || REPOSITORY_ONLY_TYPES.has(projectType),
    order: Number.isFinite(configuredOrder) && configuredOrder > 0 ? Math.trunc(configuredOrder) : 0,
    fieldStates,
    resolutionStatus: Object.keys(fieldStates).length ? "partial" : "resolved",
  };
  target.fieldBindings = normalizeFieldBindings(raw.fieldBindings, target);
  return target;
}

function cleanTarget(target, index) {
  const cleaned = {
    targetId: text(target.targetId || target._key || `target_${index + 1}`),
    appName: text(target.appName),
    vehicle: text(target.vehicle),
    repositoryId: text(target.repositoryId),
    repositoryName: text(target.repositoryName),
    gitUrl: text(target.gitUrl),
    branch: text(target.branch),
    flavor: text(target.flavor),
    projectType: text(target.projectType).toLowerCase() || (target.repositoryOnly ? "repository" : "application"),
    targetRole: normalizeTargetRole(target.targetRole, index === 0 ? "primary" : "dependency"),
    repositoryOnly: target.repositoryOnly === true,
    order: index + 1,
    fieldStates: normalizeFieldStates(target.fieldStates),
    resolutionStatus: Object.keys(normalizeFieldStates(target.fieldStates)).length ? "partial" : "resolved",
  };
  const syncedBindings = syncBindingActualValues(target.fieldBindings, cleaned, cleaned.fieldStates);
  for (const field of Object.keys(cleaned.fieldStates)) {
    if (!syncedBindings[field]?.logicalKey) continue;
    syncedBindings[field] = { ...syncedBindings[field], actualValue: "", resolved: false };
  }
  cleaned.fieldBindings = normalizeFieldBindings(syncedBindings, cleaned);
  return cleaned;
}

function orderTargets(rows) {
  return (rows || []).map((row, index) => {
    const { _orderDraft, ...target } = row;
    const ordered = {
      ...target,
      order: index + 1,
      // Role and display order are independent. Only legacy rows without a role
      // use the first-row fallback; later reordering must preserve the role.
      targetRole: normalizeTargetRole(target.targetRole, index === 0 ? "primary" : "dependency"),
    };
    ordered.fieldBindings = normalizeFieldBindings(
      syncBindingActualValues(target.fieldBindings, { order: ordered.order }),
      ordered,
    );
    return ordered;
  });
}

function initialTargetOrder(rows) {
  return (rows || [])
    .map((row, index) => ({ row, index }))
    .sort((left, right) => {
      const leftOrder = left.row.order > 0 ? left.row.order : Number.POSITIVE_INFINITY;
      const rightOrder = right.row.order > 0 ? right.row.order : Number.POSITIVE_INFINITY;
      if (leftOrder !== rightOrder) return leftOrder < rightOrder ? -1 : 1;
      return left.index - right.index;
    })
    .map(({ row }) => row);
}

function isRepositoryOnlyTarget(target) {
  return target?.repositoryOnly === true || REPOSITORY_ONLY_TYPES.has(text(target?.projectType).toLowerCase());
}

function optionValues(source, repositoryId, field) {
  if (!source) return [];
  if (Array.isArray(source)) {
    return source
      .filter((item) => {
        if (!item || typeof item !== "object") return true;
        const rid = text(item.repositoryId || item.repoId || item.projectId);
        return !repositoryId || !rid || rid === repositoryId;
      })
      .map((item) => typeof item === "object" ? item[field] || item.value || item.name : item);
  }
  if (typeof source === "object") {
    const direct = source[repositoryId] ?? source.default ?? source.all ?? [];
    return (Array.isArray(direct) ? direct : [direct]).map((item) => (
      item && typeof item === "object" ? item[field] || item.value || item.name : item
    ));
  }
  return [source];
}

function allOptionValues(source, field) {
  if (!source) return [];
  const values = Array.isArray(source)
    ? source
    : typeof source === "object"
      ? Object.values(source).flatMap((item) => Array.isArray(item) ? item : [item])
      : [source];
  return values.map((item) => item && typeof item === "object" ? item[field] || item.value || item.name : item);
}

function confidenceText(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "-";
  const pct = n <= 1 ? n * 100 : n;
  return `${Math.round(pct)}%`;
}

function statusMeta(status) {
  const key = text(status).toUpperCase();
  if (["READY", "CONFIDENT", "MATCHED", "OK"].includes(key)) return { label: "可确认", cls: "border-emerald-800/70 bg-emerald-950/40 text-emerald-300" };
  if (["NEED_MORE_INFO", "INSUFFICIENT"].includes(key)) return { label: "信息不足", cls: "border-rose-800/70 bg-rose-950/40 text-rose-300" };
  if (["NEED_HUMAN_CONFIRMATION", "REVIEW_REQUIRED"].includes(key)) return { label: "待人工确认", cls: "border-amber-800/70 bg-amber-950/40 text-amber-300" };
  return { label: status || "待复核", cls: "border-zinc-700 bg-zinc-900 text-zinc-400" };
}

function repositoryOptions(options, registryTargets, targets) {
  const rows = [];
  const add = (item) => {
    if (!item) return;
    const normalized = typeof item === "string"
      ? { id: item, name: item, gitUrl: "" }
      : {
        id: text(item.id || item.repositoryId || item.repoId || item.projectId),
        name: text(item.name || item.repositoryName || item.repoName),
        gitUrl: text(item.gitUrl || item.repositoryUrl || item.url),
        projectType: text(item.projectType || item.targetType).toLowerCase(),
        targetRole: text(item.targetRole || item.role).toLowerCase(),
        repositoryOnly: item.repositoryOnly === true || item.targetScope === "repository",
        defaultBranch: text(item.defaultBranch || item.branch || item.baseBranch),
        defaultFlavor: text(item.defaultFlavor || item.flavor),
        branchOptions: unique(item.branchOptions || item.branches || []),
        flavorOptions: unique(item.flavorOptions || item.flavors || []),
      };
    if (!normalized.id && normalized.gitUrl) normalized.id = normalized.gitUrl;
    if (!normalized.id) return;
    const existing = rows.find((row) => row.id === normalized.id);
    if (existing) {
      if (!existing.name && normalized.name) existing.name = normalized.name;
      if (!existing.gitUrl && normalized.gitUrl) existing.gitUrl = normalized.gitUrl;
      if (!existing.projectType && normalized.projectType) existing.projectType = normalized.projectType;
      if (!existing.targetRole && normalized.targetRole) existing.targetRole = normalized.targetRole;
      if (!existing.defaultBranch && normalized.defaultBranch) existing.defaultBranch = normalized.defaultBranch;
      if (!existing.defaultFlavor && normalized.defaultFlavor) existing.defaultFlavor = normalized.defaultFlavor;
      existing.branchOptions = unique([...(existing.branchOptions || []), ...(normalized.branchOptions || [])]);
      existing.flavorOptions = unique([...(existing.flavorOptions || []), ...(normalized.flavorOptions || [])]);
      if (normalized.repositoryOnly) existing.repositoryOnly = true;
    } else rows.push({ ...normalized, name: normalized.name || normalized.id });
  };
  (options?.repositories || []).forEach(add);
  (registryTargets || []).forEach((item) => add(normalizeTarget(item)));
  (targets || []).forEach(add);
  return rows;
}

function looksLikeGitAddress(value) {
  const raw = text(value);
  return /^git@/i.test(raw) || /^[a-z][a-z0-9+.-]*:\/\//i.test(raw);
}

function repositoryNameFromInput(value) {
  const raw = text(value);
  if (!looksLikeGitAddress(raw)) return raw;
  const pathPart = /^git@/i.test(raw) ? raw.slice(raw.indexOf(":") + 1) : (() => {
    try { return new URL(raw).pathname; } catch { return raw; }
  })();
  const segment = pathPart.split("/").filter(Boolean).pop() || raw;
  try { return decodeURIComponent(segment).replace(/\.git$/i, ""); } catch { return segment.replace(/\.git$/i, ""); }
}

function EvidenceList({ evidence }) {
  const rows = Array.isArray(evidence) ? evidence : evidence ? [evidence] : [];
  if (!rows.length) return <div className="py-3 text-center text-[10px] text-zinc-600">暂无证据明细</div>;
  return (
    <div className="divide-y divide-zinc-800/80">
      {rows.map((item, index) => {
        const row = typeof item === "string" ? { detail: item } : (item || {});
        const source = text(row.source || row.group || row.type);
        const value = displayValue(row.value || row.keyword || row.match);
        const detail = text(row.detail || row.reason || row.description);
        return (
          <div key={row.id || `${source}_${value}_${index}`} className="flex min-w-0 gap-2 px-3 py-2 text-[10px]">
            <span className="h-fit shrink-0 rounded border border-zinc-700 bg-zinc-950 px-1.5 py-0.5 uppercase text-zinc-500">{source || "evidence"}</span>
            <div className="min-w-0 flex-1">
              {value ? <div className="truncate text-zinc-300" title={value}>{value}</div> : null}
              <div className="break-words text-zinc-600">{detail || (!value ? displayValue(row) : "命中推理规则")}</div>
            </div>
            {row.weight !== undefined ? (
              <span className={`shrink-0 ${Number(row.weight) < 0 ? "text-rose-400" : "text-cyan-500"}`}>
                {Number(row.weight) > 0 ? "+" : ""}{row.weight}
              </span>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

const SOURCE_STATE_META = {
  complete: { label: "完整", cls: "border-emerald-900/60 bg-emerald-950/25 text-emerald-300", dot: "bg-emerald-500" },
  partial: { label: "部分", cls: "border-amber-900/60 bg-amber-950/25 text-amber-300", dot: "bg-amber-500" },
  failed: { label: "失败", cls: "border-rose-900/60 bg-rose-950/25 text-rose-300", dot: "bg-rose-500" },
  missing: { label: "未上报", cls: "border-zinc-800 bg-zinc-950/35 text-zinc-600", dot: "bg-zinc-700" },
};

function SourceCoveragePanel({ gate }) {
  return (
    <section data-testid="config-source-coverage" className="border-b border-zinc-800 bg-zinc-950/20 p-3 sm:p-4">
      <div className="mb-2 flex flex-wrap items-start justify-between gap-2">
        <div>
          <h3 className="text-[11px] font-medium text-zinc-300">输入来源完整度</h3>
          <p className="mt-0.5 text-[9px] text-zinc-600">每个来源都可独立参与推理；未提供或读取不完整只降低置信度，不阻止人工确认。</p>
        </div>
        <span className={`rounded border px-2 py-0.5 text-[9px] ${gate.status === "complete" ? "border-emerald-900/60 bg-emerald-950/25 text-emerald-300" : "border-amber-900/60 bg-amber-950/20 text-amber-300"}`}>
          {!gate.hasSnapshot ? "旧记录 · 无 coverage 快照" : gate.status === "warning" ? "可提交 · 来源缺失告警" : "已读取现有来源"}
        </span>
      </div>
      <div className="grid gap-1.5 sm:grid-cols-2 xl:grid-cols-3">
        {gate.rows.map((row) => {
          const meta = SOURCE_STATE_META[row.state] || SOURCE_STATE_META.missing;
          const details = [
            row.count !== null ? `${row.count} 项` : "",
            row.source ? `渠道 ${row.source}` : "",
            row.message,
          ].filter(Boolean).join(" · ");
          return (
            <div key={row.key} data-testid={`config-source-${row.key}`} className="min-w-0 rounded-md border border-zinc-800 bg-zinc-950/45 px-2.5 py-2">
              <div className="flex min-w-0 items-center gap-1.5">
                <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${meta.dot}`} />
                <span className="truncate text-[9px] font-medium text-zinc-400">{row.label}</span>
                <span className="text-[7px] text-zinc-700">独立来源</span>
                <span className={`ml-auto shrink-0 rounded border px-1.5 py-0.5 text-[8px] ${meta.cls}`}>{meta.label}</span>
              </div>
              <div className="mt-1 min-h-3 truncate text-[8px] text-zinc-600" title={details}>{details || (row.state === "complete" ? "读取成功" : "没有可验证的来源状态")}</div>
            </div>
          );
        })}
      </div>
      {!gate.hasSnapshot ? (
        <div className="mt-2 rounded border border-amber-900/45 bg-amber-950/15 px-2.5 py-1.5 text-[9px] text-amber-300">
          这是旧版兼容记录，无法证明来源完整。允许保存人工标注，但不得把本页匹配分解释为正确概率或独立评测结果。
        </div>
      ) : gate.warnings.length ? (
        <div role="status" className="mt-2 rounded border border-amber-900/55 bg-amber-950/20 px-2.5 py-1.5 text-[9px] text-amber-300">
          部分来源未提供或未完整读取；系统已基于现有信息继续推理，请结合证据和工程配置人工确认。
        </div>
      ) : null}
    </section>
  );
}

function ConflictResolutionPanel({ gate, onResolve, disabled = false }) {
  if (!gate.rows.length) return null;
  return (
    <section data-testid="config-inference-conflicts" className="border-b border-rose-900/45 bg-rose-950/10 p-3 sm:p-4">
      <div className="mb-2 flex flex-wrap items-start justify-between gap-2">
        <div>
          <h3 className="text-[11px] font-medium text-rose-200">跨来源结论冲突</h3>
          <p className="mt-0.5 text-[9px] text-zinc-500">不同来源给出了矛盾值。请先在下方工程配置中调整为最终结论，再逐项确认采用当前配置。</p>
        </div>
        <span className={`rounded border px-2 py-0.5 text-[9px] ${gate.allowed ? "border-emerald-900/60 bg-emerald-950/25 text-emerald-300" : "border-rose-900/60 bg-rose-950/25 text-rose-300"}`}>
          {!gate.positiveDecision ? "当前结论不应用" : gate.allowed ? "冲突已裁决" : `待裁决 ${gate.unresolved.length} 项`}
        </span>
      </div>
      <div className="grid gap-2 lg:grid-cols-2">
        {gate.rows.map((row) => (
          <div key={row.id || row.dimension} data-testid={`config-conflict-${row.dimension}`} className={`rounded-md border px-2.5 py-2 ${row.resolved ? "border-emerald-900/55 bg-emerald-950/15" : "border-rose-900/55 bg-zinc-950/45"}`}>
            <div className="flex items-center justify-between gap-2">
              <span className="text-[10px] font-medium text-zinc-200">{row.label}</span>
              <span className={`text-[8px] ${row.resolved ? "text-emerald-400" : "text-rose-400"}`}>{row.resolved ? "已裁决" : "必须人工裁决"}</span>
            </div>
            <div className="mt-1.5 flex flex-wrap gap-1">
              {row.candidates.map((candidate) => (
                <span key={`${row.dimension}:${candidate.value}`} className="rounded border border-zinc-800 bg-zinc-900 px-1.5 py-0.5 text-[8px] text-zinc-400" title={candidate.keywords.join("、")}>
                  {(candidate.sourceGroups.length ? candidate.sourceGroups.join("+") : "来源")} → {candidate.value}
                </span>
              ))}
              {!row.candidates.length ? <span className="text-[8px] text-zinc-600">来源组合不一致，请人工检查完整目标图</span> : null}
            </div>
            <div className="mt-2 flex items-center justify-between gap-2">
              <span className="min-w-0 truncate text-[9px] text-zinc-500" title={row.currentValue || "空值"}>当前配置：{row.currentValue || "空值/无工程目标"}</span>
              <button
                type="button"
                data-testid={`config-conflict-resolve-${row.dimension}`}
                onClick={() => onResolve(row)}
                disabled={disabled}
                className={`shrink-0 rounded border px-2 py-1 text-[9px] transition disabled:cursor-not-allowed disabled:opacity-45 ${row.resolved ? "border-emerald-900/60 text-emerald-400 hover:bg-emerald-950/30" : "border-rose-900/60 text-rose-300 hover:bg-rose-950/30"}`}
              >{row.resolved ? "重新确认当前配置" : "采用当前配置并裁决"}</button>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

export default function ConfigInferenceReview({ session, onSubmit, onSkip, busy = false, training = false, canPersistConfig = false, resolutionMode = false, submitLabel = "" }) {
  const rowSeq = useRef(0);
  const makeRows = (items) => orderTargets(initialTargetOrder((Array.isArray(items) ? items : []).map((item) => normalizeTarget(item, `target_${rowSeq.current++}`))));
  const reviewDraft = session?._reviewDraft && typeof session._reviewDraft === "object" ? session._reviewDraft : null;
  const draftDecision = defaultConfigInferenceReviewDecision(session, reviewDraft, resolutionMode);
  const draftTargets = draftDecision === "corrected" && Array.isArray(reviewDraft?.correctedPrediction?.targets)
    ? reviewDraft.correctedPrediction.targets
    : session?.prediction?.targets;
  const [decision, setDecision] = useState(draftDecision);
  const [rating, setRating] = useState(defaultConfigInferenceReviewRating(draftDecision, reviewDraft));
  const [targets, setTargets] = useState(() => makeRows(draftTargets));
  const [conflictResolutions, setConflictResolutions] = useState(() => reviewDraft?.conflictResolutions || session?.review?.conflictResolutions || {});
  const [deleteNotice, setDeleteNotice] = useState("");
  const [gateNotice, setGateNotice] = useState("");
  const localRepositoryKey = (row) => `repo:${text(row?.repositoryId)}\u0000${text(row?.branch)}`;
  const initialLocalSelections = (value) => Object.fromEntries(
    (Array.isArray(value?.localResolution?.targets) ? value.localResolution.targets : []).flatMap((row) => {
      const selection = row.selectedProjectId ? text(row.selectedProjectId) : row.matchKind === "remote_selected" ? "__remote__" : "";
      return [[text(row.targetId), selection], [localRepositoryKey(row), selection]];
    }).filter(([key]) => key),
  );
  const [localSelections, setLocalSelections] = useState(() => initialLocalSelections(session));

  const sessionKey = configInferenceSessionKey(session);
  useEffect(() => {
    const nextDraft = session?._reviewDraft && typeof session._reviewDraft === "object" ? session._reviewDraft : null;
    const nextDecision = defaultConfigInferenceReviewDecision(session, nextDraft, resolutionMode);
    const nextTargets = nextDecision === "corrected" && Array.isArray(nextDraft?.correctedPrediction?.targets)
      ? nextDraft.correctedPrediction.targets
      : session?.prediction?.targets;
    setDecision(nextDecision);
    setRating(defaultConfigInferenceReviewRating(nextDecision, nextDraft));
    setTargets(makeRows(nextTargets));
    setConflictResolutions(nextDraft?.conflictResolutions || session?.review?.conflictResolutions || {});
    setDeleteNotice("");
    setGateNotice("");
    setLocalSelections(initialLocalSelections(session));
    // `sessionKey` 同时标记后端原位重算。旧 run 刷新后必须丢弃旧表格草稿，
    // 强制展示新预测供用户再次确认；普通父组件重渲染仍不会重置编辑。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionKey, resolutionMode]);

  const prediction = session?.prediction || {};
  const sourceGate = configInferenceSourceGate(session, decision);
  const conflictReviewGate = configInferenceConflictGate(session, decision, conflictResolutions, targets);
  const conflictGate = resolutionMode
    ? { ...conflictReviewGate, allowed: true, unresolved: [], requiresCorrection: false, positiveDecision: false }
    : conflictReviewGate;
  const confidence = confidencePresentation(prediction);
  const governance = annotationGovernance(session);
  const signals = prediction.signals || {};
  const signalSources = signals.sources && typeof signals.sources === "object" ? signals.sources : signals;
  const options = session?.options || {};
  const registryTargets = useMemo(
    () => (Array.isArray(options.registryTargets) ? options.registryTargets.map((item, index) => normalizeTarget(item, `registry_${index}`)) : []),
    [options.registryTargets],
  );
  const repositories = useMemo(
    () => repositoryOptions(options, registryTargets, targets),
    [options, registryTargets, targets],
  );
  const apps = useMemo(() => unique([
    ...(options.apps || []),
    ...registryTargets.map((item) => item.appName),
    ...targets.map((item) => item.appName),
  ]), [options.apps, registryTargets, targets]);
  const vehicles = useMemo(() => unique([
    ...(options.vehicles || []),
    ...registryTargets.map((item) => item.vehicle),
    ...targets.map((item) => item.vehicle),
  ]), [options.vehicles, registryTargets, targets]);
  const localResolution = !training && !resolutionMode && session?.localResolution
    ? session.localResolution
    : null;
  const localResolutionTargets = Array.isArray(localResolution?.targets) ? localResolution.targets : [];
  const allLocalProjects = Array.isArray(localResolution?.projects) ? localResolution.projects : [];
  const localResolutionForTarget = (target) => {
    const targetId = text(target?.targetId || target?._key);
    return localResolutionTargets.find((row) => targetId && text(row.targetId) === targetId)
      || localResolutionTargets.find((row) => text(row.repositoryId) === text(target?.repositoryId) && text(row.branch) === text(target?.branch));
  };
  const localSelectionForTarget = (target) => text(
    localSelections[text(target?.targetId || target?._key)] || localSelections[localRepositoryKey(target)],
  );

  if (!session) {
    return <div className="rounded-lg border border-zinc-800 bg-zinc-900/30 p-6 text-center text-[11px] text-zinc-600">暂无待复核的配置推理</div>;
  }

  const ticket = session.ticket || {};
  const status = statusMeta(prediction.status);
  const symbolicFieldCount = targets.reduce((sum, target) => sum + Object.keys(normalizeFieldStates(target.fieldStates)).length, 0);
  const symbolicEditorDisabled = (target, field) => busy || (resolutionMode && !isSymbolicField(target, field));
  const unresolvedLocalTargets = localResolution
    ? targets.filter((target) => localResolutionForTarget(target)?.selectionRequired !== false && !localSelectionForTarget(target))
    : [];

  function branchOptions(target) {
    const repository = repositories.find((row) => row.id === target.repositoryId);
    return unique([
      ...optionValues(options.branches, target.repositoryId, "branch"),
      ...(repository?.branchOptions || []),
      repository?.defaultBranch,
      ...allOptionValues(options.branches, "branch"),
      ...repositories.flatMap((row) => [row.defaultBranch, ...(row.branchOptions || [])]),
      ...registryTargets.map((row) => row.branch),
      ...registryTargets.filter((row) => !target.repositoryId || row.repositoryId === target.repositoryId).map((row) => row.branch),
      target.branch,
    ]);
  }

  function flavorOptions(target) {
    // Flavor intentionally does not depend on vehicle. It only follows the selected repository registry.
    const repository = repositories.find((row) => row.id === target.repositoryId);
    return unique([
      ...optionValues(options.flavors, target.repositoryId, "flavor"),
      ...(repository?.flavorOptions || []),
      repository?.defaultFlavor,
      ...allOptionValues(options.flavors, "flavor"),
      ...repositories.flatMap((row) => [row.defaultFlavor, ...(row.flavorOptions || [])]),
      ...registryTargets.map((row) => row.flavor),
      ...registryTargets.filter((row) => !target.repositoryId || row.repositoryId === target.repositoryId).map((row) => row.flavor),
      target.flavor,
    ]);
  }

  function updateTarget(index, patch) {
    setTargets((rows) => orderTargets(rows.map((row, rowIndex) => rowIndex === index ? {
      ...row,
      ...patch,
      fieldBindings: syncBindingActualValues(row.fieldBindings, patch, row.fieldStates),
    } : row)));
    setDecision("corrected");
  }

  function resolveConflict(row) {
    setConflictResolutions((current) => ({
      ...current,
      [row.dimension]: {
        acknowledged: true,
        selectedValue: row.currentValue,
        targetFingerprint: conflictGate.targetFingerprint,
      },
    }));
    setDecision("corrected");
    setGateNotice("");
  }

  function setFieldSymbolic(index, field, symbolic) {
    if (!SYMBOLIC_FIELDS.has(field)) return;
    setTargets((rows) => orderTargets(rows.map((row, rowIndex) => {
      if (rowIndex !== index) return row;
      const fieldStates = { ...normalizeFieldStates(row.fieldStates) };
      if (symbolic) fieldStates[field] = { kind: "symbolic", feature: fieldStates[field]?.feature || "" };
      else delete fieldStates[field];
      const fieldBindings = { ...(row.fieldBindings || {}) };
      if (fieldBindings[field]?.logicalKey) {
        const actualValue = symbolic ? "" : text(row[field]);
        fieldBindings[field] = { ...fieldBindings[field], actualValue, resolved: !!actualValue };
      }
      return {
        ...row,
        fieldStates,
        fieldBindings,
        resolutionStatus: Object.keys(fieldStates).length ? "partial" : "resolved",
      };
    })));
    setDecision("corrected");
  }

  function updateFieldFeature(index, field, feature) {
    setTargets((rows) => rows.map((row, rowIndex) => rowIndex === index ? {
      ...row,
      fieldStates: {
        ...normalizeFieldStates(row.fieldStates),
        [field]: { kind: "symbolic", feature },
      },
      resolutionStatus: "partial",
    } : row));
    setDecision("corrected");
  }

  function removeTarget(index) {
    const removed = targets[index];
    if (!removed) return;
    const removedRole = targetRoleMeta(removed, index);
    const remaining = targets.filter((_, rowIndex) => rowIndex !== index);
    const needsPromotion = removedRole.role === "primary"
      && remaining.length > 0
      && !remaining.some((target, rowIndex) => targetRoleMeta(target, rowIndex).role === "primary");
    if (needsPromotion) remaining[0] = { ...remaining[0], targetRole: "primary" };
    const next = orderTargets(remaining);
    setTargets(next);
    setDecision("corrected");
    const removedName = removed.repositoryName || removed.repositoryId || removed.appName || `第 ${index + 1} 个工程`;
    setDeleteNotice(needsPromotion
      ? `已删除主工程「${removedName}」，「${next[0].repositoryName || next[0].repositoryId || next[0].appName || "下一项"}」已成为新的主工程。`
      : `已删除${removedRole.label}「${removedName}」。${next.length ? removedRole.role === "primary" ? "其他主工程保持不变，工程顺序已重新编号。" : "工程顺序已重新编号。" : "当前已无工程目标，可提交纠正让 AI 记住本单无需这些工程。"}`);
  }

  function selectRepository(index, repository, inputValue = "") {
    const repositoryId = repository?.id || "";
    const projectType = text(repository?.projectType).toLowerCase() || "application";
    const repositoryOnly = repository?.repositoryOnly === true || REPOSITORY_ONLY_TYPES.has(projectType);
    const current = targets[index] || {};
    const allowedBranches = unique([repository?.defaultBranch, ...(repository?.branchOptions || [])]);
    const allowedFlavors = unique([repository?.defaultFlavor, ...(repository?.flavorOptions || [])]);
    updateTarget(index, {
      _repositoryInput: inputValue || repositoryId,
      repositoryId,
      repositoryName: repository?.name || repositoryId,
      gitUrl: repository?.gitUrl || "",
      appName: repositoryOnly ? "" : current.appName || "",
      vehicle: repositoryOnly ? "" : current.vehicle || "",
      branch: isSymbolicField(current, "branch") ? current.branch : allowedBranches.includes(current.branch) ? current.branch : repository?.defaultBranch || "",
      flavor: isSymbolicField(current, "flavor") ? current.flavor : allowedFlavors.includes(current.flavor) ? current.flavor : repository?.defaultFlavor || "",
      projectType,
      repositoryOnly,
    });
  }

  function updateRepositoryInput(index, value) {
    const raw = text(value);
    const key = raw.toLowerCase();
    const exactId = repositories.find((row) => text(row.id).toLowerCase() === key);
    const gitMatches = repositories.filter((row) => text(row.gitUrl).toLowerCase() === key);
    const nameMatches = repositories.filter((row) => text(row.name).toLowerCase() === key);
    // 下拉项以唯一 ID 为 value；手输重名仓库时不静默取第一项，交给后端明确报歧义。
    const repository = exactId
      || (gitMatches.length === 1 ? gitMatches[0] : null)
      || (nameMatches.length === 1 ? nameMatches[0] : null);
    if (repository) {
      selectRepository(index, repository, raw);
      return;
    }
    const current = targets[index] || {};
    updateTarget(index, {
      _repositoryInput: value,
      repositoryId: raw,
      repositoryName: repositoryNameFromInput(raw),
      gitUrl: looksLikeGitAddress(raw) ? raw : "",
      projectType: current.projectType || "application",
      repositoryOnly: current.repositoryOnly === true,
    });
  }

  function repositoryInputValue(target) {
    if (target._repositoryInput !== undefined) return target._repositoryInput;
    return target.repositoryId;
  }

  function moveTarget(index, direction) {
    const nextIndex = index + direction;
    if (nextIndex < 0 || nextIndex >= targets.length) return;
    setTargets((rows) => {
      const next = [...rows];
      [next[index], next[nextIndex]] = [next[nextIndex], next[index]];
      return orderTargets(next);
    });
    setDecision("corrected");
  }

  function makePrimary(index) {
    if (index < 0 || index >= targets.length) return;
    setTargets((rows) => {
      const selected = rows[index];
      if (!selected) return orderTargets(rows);
      return orderTargets([
        { ...selected, targetRole: "primary" },
        ...rows
          .filter((_, rowIndex) => rowIndex !== index)
          .map((target) => ({ ...target, targetRole: "dependency" })),
      ]);
    });
    setDecision("corrected");
  }

  function updateOrderDraft(index, value) {
    setTargets((rows) => rows.map((row, rowIndex) => rowIndex === index ? { ...row, _orderDraft: value } : row));
    setDecision("corrected");
  }

  function commitOrder(index, value) {
    setTargets((rows) => {
      if (index < 0 || index >= rows.length) return orderTargets(rows);
      const requested = Math.trunc(Number(value));
      if (!Number.isFinite(requested) || requested <= 0) return orderTargets(rows);
      const next = [...rows];
      const [row] = next.splice(index, 1);
      const destination = Math.max(0, Math.min(next.length, requested - 1));
      next.splice(destination, 0, row);
      return orderTargets(next);
    });
    setDecision("corrected");
  }

  function chooseDecision(next) {
    if (resolutionMode) return;
    setDecision(next);
    setGateNotice("");
    if (next === "correct") {
      setTargets(makeRows(prediction.targets));
      setRating(5);
    } else if (next === "corrected" && rating === 5) {
      setRating(3);
    } else if (next === "insufficient" && rating > 2) {
      setRating(2);
    }
  }

  function submit() {
    if (busy || !onSubmit) return;
    if (!conflictGate.allowed) {
      setGateNotice(`不同来源的推理结论存在矛盾，请先按当前工程配置逐项裁决：${conflictGate.unresolved.map((row) => row.label).join("、")}`);
      return;
    }
    if (["correct", "corrected"].includes(decision) && unresolvedLocalTargets.length) return;
    if (decision === "corrected" && targets.length === 0) {
      const confirmed = window.confirm("确认提交“无工程目标”吗？系统只会记住本单不需要原来的主工程/依赖工程，不会删除共享仓库定义或车型配置。");
      if (!confirmed) return;
    }
    onSubmit({
      decision,
      rating,
      correctedPrediction: {
        targets: targets.map((target, index) => cleanTarget(target, index)),
        noTargets: decision === "corrected" && targets.length === 0,
      },
      // 训练工作台只保存 annotation；共享值需在 RAG 治理页单独 draft/approve/activate。
      persistConfig: decision === "corrected" && canPersistConfig && !training && !resolutionMode,
      apply: !training && !resolutionMode,
      annotationStatus: "annotation",
      conflictResolutions,
      sourceGate: {
        status: sourceGate.status,
        requiredSources: sourceGate.rows.filter((row) => row.required).map((row) => row.key),
        incompleteSources: sourceGate.rows.filter((row) => row.state !== "complete").map((row) => ({
          source: row.key,
          state: row.state,
        })),
      },
      ...(!training && !resolutionMode && localResolution ? {
        localProjectBindings: targets.flatMap((target, index) => {
          const targetId = text(target.targetId || target._key || `target_${index + 1}`);
          if (localResolutionForTarget(target)?.selectionRequired === false) return [];
          const selection = localSelectionForTarget(target);
          return [{
            targetId,
            repositoryId: text(target.repositoryId),
            branch: text(target.branch),
            ...(selection === "__remote__" ? { useRemote: true } : { projectId: selection }),
          }];
        }),
      } : {}),
    });
  }

  return (
    <div className="overflow-hidden rounded-xl border border-zinc-800 bg-zinc-900/35 shadow-sm">
      <div className="flex flex-wrap items-center gap-2 border-b border-zinc-800 px-3 py-2.5 sm:px-4">
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2">
            <h2 className="truncate text-[12px] font-semibold text-zinc-100" title={ticket.title || "配置推理复核"}>{ticket.title || "配置推理复核"}</h2>
            <span className={`shrink-0 rounded border px-1.5 py-0.5 text-[9px] ${status.cls}`}>{status.label}</span>
          </div>
          <div className="mt-0.5 flex flex-wrap gap-x-2 text-[10px] text-zinc-600">
            <span>{ticket.ticketId || ticket.tbTaskId || ticket.carbId || "未关联 TB 单"}</span>
            <span title={confidence.note}>{confidence.label} {confidence.value === null ? "-" : confidenceText(confidence.value)}</span>
            {!confidence.calibrated ? <span className="text-amber-600">未校准</span> : null}
            {session.trainingSource?.name ? <span className="text-cyan-600" title={session.trainingSource.url}>来源：{session.trainingSource.name}</span> : null}
            {session.recovery ? <span className="text-amber-500">记录已由服务端审计恢复</span> : null}
          </div>
        </div>
        <span data-testid="config-annotation-status" className={`rounded border px-2 py-0.5 text-[9px] ${governance.meta.border} ${governance.meta.tone}`} title={governance.legacy ? "旧版复核按 annotation 展示，需迁移并审批后才能作为治理版 serving label" : ""}>
          {governance.meta.label}{governance.legacy ? " · 兼容记录" : ""}
        </span>
        <span className={`rounded border px-2 py-0.5 text-[9px] ${training ? "border-cyan-900/70 bg-cyan-950/35 text-cyan-300" : "border-violet-900/70 bg-violet-950/35 text-violet-300"}`}>
          {resolutionMode ? "替换代号" : training ? "训练评分" : "开发前复核"}
        </span>
      </div>

      <section className="border-b border-zinc-800 p-3 sm:p-4">
        <div className="mb-2 flex items-center justify-between">
          <h3 className="text-[11px] font-medium text-zinc-300">原始推理信号（六类规则 + TB 单备注）</h3>
          <span className="text-[9px] text-zinc-600">规则命中只作为证据，最终配置由人工确认</span>
        </div>
        <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
          {SIGNAL_GROUPS.map((group) => {
            const signalValue = firstValue(signalSources, group.aliases) ?? firstValue(ticket, group.aliases);
            const items = displayItems(signalValue);
            return (
              <div key={group.key} className="min-w-0 rounded-md border border-zinc-800 bg-zinc-950/45 px-2.5 py-2">
                <div className="mb-1 text-[9px] font-medium text-zinc-500">{group.label}</div>
                {items.length ? (
                  <div className="flex max-h-16 flex-wrap gap-1 overflow-y-auto">
                    {items.map((item) => <span key={item} className="max-w-full truncate rounded bg-zinc-800 px-1.5 py-0.5 text-[9px] text-zinc-300" title={item}>{item}</span>)}
                  </div>
                ) : <span className="text-[9px] text-zinc-700">未提供</span>}
              </div>
            );
          })}
        </div>
      </section>

      <SourceCoveragePanel gate={sourceGate} />

      {!resolutionMode ? <ConflictResolutionPanel gate={conflictGate} onResolve={resolveConflict} disabled={busy} /> : null}

      <section className="border-b border-zinc-800">
        <div className="flex items-center justify-between px-3 py-2 sm:px-4">
          <div>
            <h3 className="text-[11px] font-medium text-zinc-300">工程配置目标（主工程 + 依赖工程）</h3>
            <p className="mt-0.5 text-[9px] leading-relaxed text-zinc-600">每个字段同时包含一个锁定的永久 Key 和一个可替换实际值：AI 使用 Key 学习逻辑含义，运行时解析为当前实际值。值尚未确定时，仍可用原有“代号值”延期写回；调整排序不会改变工程角色，只有删除唯一主工程时才会自动提升下一项。</p>
          </div>
          <button
            type="button"
            data-testid="config-target-add"
            onClick={() => { setTargets((rows) => orderTargets([...rows, normalizeTarget({}, `target_${rowSeq.current++}`)])); setDecision("corrected"); }}
            disabled={busy || resolutionMode}
            className="shrink-0 rounded border border-cyan-900/70 bg-cyan-950/30 px-2 py-1 text-[10px] text-cyan-300 transition hover:bg-cyan-900/35 disabled:cursor-not-allowed disabled:opacity-50"
          >＋ 添加目标</button>
        </div>
        <div aria-live="polite" data-testid="config-target-delete-notice" className={`mx-3 mb-2 rounded border px-2.5 py-1.5 text-[9px] sm:mx-4 ${deleteNotice ? "border-rose-900/50 bg-rose-950/20 text-rose-300" : "sr-only"}`}>{deleteNotice}</div>

        <div className="overflow-x-auto">
          <table className="w-full min-w-[1160px] table-fixed text-left text-[10px]">
            <thead className="border-y border-zinc-800 bg-zinc-950/55 text-zinc-600">
              <tr>
                <th className="w-[11%] px-2 py-1.5 font-medium">工程角色</th>
                <th className="w-[15%] px-2 py-1.5 font-medium">应用名字</th>
                <th className="w-[12%] px-2 py-1.5 font-medium">车型</th>
                <th className="w-[23%] px-2 py-1.5 font-medium">Git 仓库</th>
                <th className="w-[17%] px-2 py-1.5 font-medium">分支</th>
                <th className="w-[12%] px-2 py-1.5 font-medium">Flavor</th>
                <th className="w-[10%] px-2 py-1.5 font-medium">排序</th>
              </tr>
            </thead>
            <tbody>
              {targets.map((target, index) => {
                const branches = branchOptions(target);
                const flavors = flavorOptions(target);
                const repositoryOnly = isRepositoryOnlyTarget(target);
                const role = targetRoleMeta(target, index);
                return (
                  <tr key={target._key} className="border-b border-zinc-800/80 align-top">
                    <td className="p-2">
                      <span className={`inline-flex rounded border px-1.5 py-0.5 text-[9px] ${role.className}`}>{role.label}</span>
                      <div className="mt-1 truncate text-[9px] text-zinc-600" title={PROJECT_TYPE_LABELS[target.projectType] || target.projectType}>{PROJECT_TYPE_LABELS[target.projectType] || target.projectType || "应用工程"}</div>
                      <button
                        type="button"
                        data-testid={`config-target-delete-${index}`}
                        onClick={() => removeTarget(index)}
                        disabled={busy || resolutionMode}
                        aria-label={`删除${role.label} ${target.repositoryName || target.repositoryId || target.appName || index + 1}`}
                        className="mt-2 rounded border border-rose-900/55 bg-rose-950/15 px-1.5 py-1 text-[9px] text-rose-400 transition hover:bg-rose-950/40 disabled:cursor-not-allowed disabled:opacity-45"
                      >删除{role.deleteLabel}</button>
                    </td>
                    <td className="p-2">
                      {repositoryOnly ? <div className="rounded border border-dashed border-zinc-800 bg-zinc-950/40 px-2 py-1.5 text-zinc-500">无独立应用</div> : <>
                        <EditableCombobox testId={`config-target-app-${index}`} value={target.appName} options={apps} onChange={(value) => updateTarget(index, { appName: value })} onSelect={() => setFieldSymbolic(index, "appName", false)} disabled={symbolicEditorDisabled(target, "appName")} className={inputClass} placeholder="应用名字或代号" ariaLabel="应用名字" />
                        <FieldBindingMeta target={target} field="appName" label="应用名字" testId={`config-target-app-${index}`} />
                        <SymbolicFieldControl target={target} field="appName" label="应用名字" disabled={symbolicEditorDisabled(target, "appName")} testId={`config-target-app-${index}`} onToggle={() => setFieldSymbolic(index, "appName", !isSymbolicField(target, "appName"))} onFeatureChange={(value) => updateFieldFeature(index, "appName", value)} />
                      </>}
                    </td>
                    <td className="p-2">
                      {repositoryOnly ? <div className="rounded border border-dashed border-zinc-800 bg-zinc-950/40 px-2 py-1.5 text-zinc-600">不适用</div> : <>
                        <EditableCombobox testId={`config-target-vehicle-${index}`} value={target.vehicle} options={vehicles} onChange={(value) => updateTarget(index, { vehicle: value })} onSelect={() => setFieldSymbolic(index, "vehicle", false)} disabled={symbolicEditorDisabled(target, "vehicle")} className={inputClass} placeholder="车型或代号" ariaLabel="车型" />
                        <FieldBindingMeta target={target} field="vehicle" label="车型" testId={`config-target-vehicle-${index}`} />
                        <SymbolicFieldControl target={target} field="vehicle" label="车型" disabled={symbolicEditorDisabled(target, "vehicle")} testId={`config-target-vehicle-${index}`} onToggle={() => setFieldSymbolic(index, "vehicle", !isSymbolicField(target, "vehicle"))} onFeatureChange={(value) => updateFieldFeature(index, "vehicle", value)} />
                      </>}
                    </td>
                    <td className="p-2">
                      <EditableCombobox
                        testId={`config-target-repository-${index}`}
                        value={repositoryInputValue(target)}
                        options={repositories.map((repository) => ({ value: repository.id, label: repository.name || repository.id, description: repository.gitUrl }))}
                        onChange={(value) => updateRepositoryInput(index, value)}
                        onSelect={() => setFieldSymbolic(index, "repositoryId", false)}
                        disabled={symbolicEditorDisabled(target, "repositoryId")}
                        className={inputClass}
                        placeholder="仓库名、ID、HTTPS 或 SSH 地址"
                        ariaLabel="Git 仓库"
                      />
                      {target.gitUrl ? <div className="mt-1 truncate font-mono text-[9px] text-zinc-700" title={target.gitUrl}>{target.gitUrl}</div> : null}
                      <FieldBindingMeta target={target} field="repositoryId" label="Git 仓库" testId={`config-target-repository-${index}`} />
                      <SymbolicFieldControl target={target} field="repositoryId" label="Git 仓库" disabled={symbolicEditorDisabled(target, "repositoryId")} testId={`config-target-repository-${index}`} onToggle={() => setFieldSymbolic(index, "repositoryId", !isSymbolicField(target, "repositoryId"))} onFeatureChange={(value) => updateFieldFeature(index, "repositoryId", value)} />
                    </td>
                    <td className="p-2">
                      <EditableCombobox testId={`config-target-branch-${index}`} value={target.branch} options={branches} onChange={(value) => updateTarget(index, { branch: value })} onSelect={() => setFieldSymbolic(index, "branch", false)} disabled={symbolicEditorDisabled(target, "branch")} className={inputClass} placeholder="目标分支或代号" ariaLabel="分支" />
                      <FieldBindingMeta target={target} field="branch" label="分支" testId={`config-target-branch-${index}`} />
                      <SymbolicFieldControl target={target} field="branch" label="分支" disabled={symbolicEditorDisabled(target, "branch")} testId={`config-target-branch-${index}`} onToggle={() => setFieldSymbolic(index, "branch", !isSymbolicField(target, "branch"))} onFeatureChange={(value) => updateFieldFeature(index, "branch", value)} />
                    </td>
                    <td className="p-2">
                      <EditableCombobox testId={`config-target-flavor-${index}`} value={target.flavor} options={flavors} onChange={(value) => updateTarget(index, { flavor: value })} onSelect={() => setFieldSymbolic(index, "flavor", false)} disabled={symbolicEditorDisabled(target, "flavor")} className={inputClass} placeholder={repositoryOnly ? "可选 Flavor 或代号" : "Flavor 或代号"} ariaLabel="Flavor" />
                      <FieldBindingMeta target={target} field="flavor" label="Flavor" testId={`config-target-flavor-${index}`} />
                      <SymbolicFieldControl target={target} field="flavor" label="Flavor" disabled={symbolicEditorDisabled(target, "flavor")} testId={`config-target-flavor-${index}`} onToggle={() => setFieldSymbolic(index, "flavor", !isSymbolicField(target, "flavor"))} onFeatureChange={(value) => updateFieldFeature(index, "flavor", value)} />
                    </td>
                    <td className="p-2">
                      <EditableCombobox
                        testId={`config-target-order-${index}`}
                        value={target._orderDraft ?? target.order ?? index + 1}
                        options={targets.map((_, position) => String(position + 1))}
                        onChange={(value) => updateOrderDraft(index, value)}
                        onSelect={(value) => commitOrder(index, value)}
                        onBlur={(event) => commitOrder(index, event.target.value)}
                        onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }}
                        disabled={busy || resolutionMode}
                        className={`${inputClass} mb-1`}
                        ariaLabel={`第 ${index + 1} 个工程的排序`}
                        inputMode="numeric"
                        footerText="可选择已有顺序，也可直接输入排序编号"
                      />
                      <FieldBindingMeta target={target} field="order" label="排序" testId={`config-target-order-${index}`} />
                      <div className="flex flex-wrap gap-1">
                        {role.role !== "primary" ? <button type="button" onClick={() => makePrimary(index)} disabled={busy || resolutionMode} title="将此工程设为唯一主工程并移到第一项" className="rounded border border-cyan-900/60 px-1.5 py-1 text-[9px] text-cyan-400 hover:bg-cyan-950/35 disabled:opacity-50">设为主工程</button> : null}
                        <button type="button" onClick={() => moveTarget(index, -1)} disabled={busy || resolutionMode || index === 0} title="上移" className="rounded px-1.5 py-1 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200 disabled:opacity-25">↑</button>
                        <button type="button" onClick={() => moveTarget(index, 1)} disabled={busy || resolutionMode || index === targets.length - 1} title="下移" className="rounded px-1.5 py-1 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200 disabled:opacity-25">↓</button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {!targets.length ? <div data-testid="config-target-empty" className="py-5 text-center text-[10px] text-zinc-500">所有推理目标已删除。可以直接提交“纠正后正确”，让 AI 记住本单不需要原来的主工程或依赖工程；不会删除共享仓库定义和车型配置。</div> : null}
        </div>
      </section>

      {localResolution && targets.length ? (
        <section data-testid="config-local-project-resolution" className="border-b devbench-status-banner devbench-status-banner--info p-3 sm:p-4">
          <div className="mb-3 flex flex-wrap items-start justify-between gap-2">
            <div>
              <div className="flex items-center gap-2">
                <span className="flex h-6 w-6 items-center justify-center rounded-full border border-cyan-800/70 bg-cyan-950/55 text-[12px] text-cyan-300">⌂</span>
                <h3 className="text-[11px] font-medium text-zinc-200">本机工程匹配</h3>
                {!unresolvedLocalTargets.length
                  ? <span className="rounded-full border border-emerald-800/60 bg-emerald-950/35 px-2 py-0.5 text-[9px] text-emerald-300">已就绪</span>
                  : <span className="rounded-full border border-amber-800/60 bg-amber-950/35 px-2 py-0.5 text-[9px] text-amber-300">还需选择 {unresolvedLocalTargets.length} 项</span>}
              </div>
              <p className="mt-1 pl-8 text-[9px] leading-relaxed text-zinc-500">系统优先按 Git 远程和当前分支匹配。若本机有多份同仓库源码，请选择这张 TB 单要使用的工程；选择会只保存在本机，并在下次自动匹配。</p>
            </div>
          </div>
          <div className="grid gap-2 lg:grid-cols-2">
            {targets.map((target, index) => {
              const targetId = text(target.targetId || target._key || `target_${index + 1}`);
              const resolution = localResolutionForTarget(target);
              const selected = localSelectionForTarget(target);
              const recommendedIds = new Set((resolution?.candidates || []).filter((row) => row.remoteMatch).map((row) => text(row.id)));
              const projects = [...allLocalProjects].sort((left, right) => Number(recommendedIds.has(text(right.id))) - Number(recommendedIds.has(text(left.id)))
                || text(left.name).localeCompare(text(right.name), "zh-CN"));
              const selectedProject = projects.find((project) => text(project.id) === selected);
              const automatic = !!selected && selected !== "__remote__" && selected === text(resolution?.selectedProjectId);
              const ready = !!selected;
              return (
                <div key={`local_${targetId}`} className={`rounded-lg border p-3 transition ${ready ? "border-zinc-700 bg-zinc-900/70" : "border-amber-800/55 bg-amber-950/15 shadow-[0_0_0_1px_rgba(146,64,14,0.08)]"}`}>
                  <div className="mb-2 flex min-w-0 items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="truncate text-[10px] font-medium text-zinc-200" title={target.repositoryName || target.repositoryId}>{target.repositoryName || target.repositoryId || `工程 ${index + 1}`}</div>
                      <div className="mt-0.5 flex flex-wrap gap-x-2 text-[9px] text-zinc-600"><span>目标分支：{target.branch || "未指定"}</span>{target.flavor ? <span>Flavor：{target.flavor}</span> : null}</div>
                    </div>
                    <span className={`shrink-0 rounded px-1.5 py-0.5 text-[8px] ${selected === "__remote__" ? "bg-violet-950/60 text-violet-300" : automatic ? "bg-emerald-950/60 text-emerald-300" : selected ? "bg-cyan-950/60 text-cyan-300" : "bg-amber-950/60 text-amber-300"}`}>
                      {selected === "__remote__" ? "远程拉取" : automatic ? "自动命中" : selected ? "人工选择" : "待选择"}
                    </span>
                  </div>
                  <select
                    data-testid={`config-local-project-${index}`}
                    aria-label={`${target.repositoryName || target.repositoryId}的本机工程`}
                    value={selected}
                    disabled={busy}
                    onChange={(event) => setLocalSelections((current) => ({ ...current, [targetId]: event.target.value }))}
                    className={`w-full rounded-md border bg-zinc-950 px-2.5 py-2 text-[10px] outline-none transition disabled:cursor-not-allowed disabled:opacity-55 ${selected ? "border-zinc-700 text-zinc-200 focus:border-cyan-600" : "border-amber-700/70 text-amber-200 focus:border-amber-500"}`}
                  >
                    <option value="">请选择本机工程…</option>
                    {projects.map((project) => (
                      <option key={project.id} value={project.id}>
                        {recommendedIds.has(text(project.id)) ? "推荐 · " : ""}{project.name || project.id}{project.currentBranch ? `（当前 ${project.currentBranch}）` : ""}
                      </option>
                    ))}
                    <option value="__remote__">本机没有合适工程，改用远程拉取</option>
                  </select>
                  <div className="mt-1.5 min-h-4 text-[9px] text-zinc-600">
                    {!selected ? "请选择后才能确认继续，避免把已有源码误判成远程工程。" : selected === "__remote__" ? "将按推理出的仓库和分支从远程拉取。" : `将使用「${selectedProject?.name || selected}」${selectedProject?.currentBranch && selectedProject.currentBranch !== target.branch ? `，继续后自动切换到 ${target.branch || "目标分支"}` : ""}。`}
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      ) : null}

      <section className="grid gap-0 border-b border-zinc-800 lg:grid-cols-[1fr_0.9fr]">
        <div className="border-b border-zinc-800 p-3 sm:p-4 lg:border-b-0 lg:border-r">
          <h3 className="mb-2 text-[11px] font-medium text-zinc-300">人工结论</h3>
          <div className="grid gap-1.5 sm:grid-cols-3">
            {DECISIONS.map((item) => (
              <button key={item.value} type="button" onClick={() => chooseDecision(item.value)} disabled={busy || resolutionMode} className={`rounded-md border px-2.5 py-2 text-left transition disabled:cursor-not-allowed disabled:opacity-55 ${decision === item.value ? "border-cyan-700 bg-cyan-950/35" : "border-zinc-800 bg-zinc-950/35 hover:border-zinc-700"}`}>
                <span className={decision === item.value ? "text-[10px] font-medium text-cyan-200" : "text-[10px] font-medium text-zinc-400"}>{item.label}</span>
                <span className="mt-0.5 block text-[9px] leading-relaxed text-zinc-600">{item.detail}</span>
              </button>
            ))}
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <span className="text-[10px] text-zinc-500">人工结论评分</span>
            <div className="flex overflow-hidden rounded border border-zinc-700" role="radiogroup" aria-label="人工结论评分">
              {[1, 2, 3, 4, 5].map((value) => (
                <button key={value} type="button" role="radio" aria-checked={rating === value} onClick={() => setRating(value)} disabled={busy || resolutionMode} className={`min-w-8 border-r border-zinc-700 px-2 py-1 text-[10px] last:border-r-0 ${rating === value ? "bg-amber-700 text-white" : "bg-zinc-900 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-300"} disabled:cursor-not-allowed disabled:opacity-55`} title={`${value} 分`}>
                  {value}★
                </button>
              ))}
            </div>
            <span className="text-[9px] text-zinc-600">只描述本次人工同意程度，不代表模型概率或离线准确率</span>
          </div>
        </div>

        <div>
          <div className="border-b border-zinc-800 px-3 py-2 sm:px-4"><h3 className="text-[11px] font-medium text-zinc-300">推理证据</h3></div>
          <div className="max-h-40 overflow-y-auto"><EvidenceList evidence={prediction.evidence} /></div>
        </div>
      </section>

      <div className="flex flex-wrap items-center gap-2 px-3 py-2.5 sm:px-4">
        {gateNotice ? <div role="alert" data-testid="config-source-gate-error" className="w-full rounded border border-rose-900/55 bg-rose-950/20 px-2.5 py-1.5 text-[9px] text-rose-300">{gateNotice}</div> : null}
        <span data-testid="config-target-symbolic-summary" className="min-w-0 flex-1 text-[9px] text-zinc-600">
          {resolutionMode
            ? (symbolicFieldCount ? `仍有 ${symbolicFieldCount} 个代号字段待替换；本次只更新 Annotation，不写入真实配置。` : "全部代号已替换为实际值；本次只更新 Annotation，后续请在 RAG 治理页创建、审批并激活 Value revision。")
            : symbolicFieldCount
              ? `当前有 ${symbolicFieldCount} 个代号字段：只保存待审批 Annotation，不写入真实 Git、分支、Flavor 或车型配置；可稍后从训练历史进入“替换代号”。`
              : training ? "提交后只保存 Annotation；共享配置值必须在 RAG 治理页经过草稿、审批和激活，不会从训练页直接写回。" : (canPersistConfig ? "开发前复核可保存反馈、自定义配置值，并由调用方应用确认后的工程配置。" : "提交后保存反馈；如需写入自定义配置值，请使用管理员账号。")}
        </span>
        {onSkip ? <button type="button" onClick={onSkip} disabled={!training && busy} data-testid="config-inference-skip" className="rounded px-3 py-1.5 text-[10px] text-zinc-500 transition hover:bg-zinc-800 hover:text-zinc-200 disabled:cursor-not-allowed disabled:opacity-50">{resolutionMode ? "取消替换" : training ? "退出训练" : "暂不采用"}</button> : null}
        <button type="button" data-testid="config-target-submit" onClick={submit} disabled={busy || !onSubmit || !conflictGate.allowed || (["correct", "corrected"].includes(decision) && unresolvedLocalTargets.length > 0)} title={!conflictGate.allowed ? "存在尚未人工裁决的跨来源冲突" : ""} className="rounded bg-emerald-700 px-4 py-1.5 text-[11px] font-medium text-white transition hover:bg-emerald-600 disabled:cursor-not-allowed disabled:bg-zinc-700 disabled:text-zinc-500">
          {busy ? "提交中…" : submitLabel || (resolutionMode ? "保存代号替换" : training ? "保存 Annotation" : decision === "corrected" ? "保存纠正并继续" : "确认并继续")}
        </button>
      </div>
    </div>
  );
}
