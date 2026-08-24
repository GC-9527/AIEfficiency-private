import React, { useEffect, useMemo, useState } from "react";
import { devbenchApi } from "./api.js";
import EditableCombobox from "./EditableCombobox.jsx";
import {
  GOVERNANCE_STATUS_META,
  KNOWLEDGE_SCOPES,
  knowledgeScopeMeta,
  normalizeKnowledgeBinding,
  validateKnowledgeDraft,
} from "./aiTrainingGovernanceModel.mjs";

const FIELD_META = {
  appName: { label: "应用名字", tone: "text-violet-300" },
  vehicle: { label: "车型", tone: "text-cyan-300" },
  repositoryId: { label: "Git 仓库", tone: "text-sky-300" },
  branch: { label: "分支", tone: "text-emerald-300" },
  flavor: { label: "Flavor", tone: "text-amber-300" },
  order: { label: "排序", tone: "text-zinc-300" },
};

function text(value) {
  return String(value ?? "").trim();
}

function formatTime(value) {
  if (!value) return "-";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "-" : date.toLocaleString();
}

function uniqueOptions(values) {
  const rows = [];
  const seen = new Set();
  for (const item of Array.isArray(values) ? values : []) {
    const row = item && typeof item === "object"
      ? {
        value: text(item.value ?? item.id ?? item.name),
        label: text(item.label ?? item.name ?? item.value ?? item.id),
        description: text(item.description ?? item.detail ?? item.gitUrl),
      }
      : { value: text(item), label: text(item), description: "" };
    if (!row.value || seen.has(row.value.toLowerCase())) continue;
    seen.add(row.value.toLowerCase());
    rows.push({ ...row, label: row.label || row.value });
  }
  return rows;
}

function optionsForBinding(binding, options = {}) {
  const field = binding?.field;
  if (field === "appName") return uniqueOptions(options.apps || []);
  if (field === "vehicle") return uniqueOptions(options.vehicles || []);
  if (field === "repositoryId") {
    return uniqueOptions((options.repositories || []).map((row) => row && typeof row === "object" ? {
      value: row.id || row.repositoryId,
      label: row.name || row.repositoryName || row.id || row.repositoryId,
      description: row.gitUrl || row.repositoryUrl || row.url,
    } : row));
  }
  if (field === "branch") {
    return uniqueOptions((options.branches || []).map((row) => row && typeof row === "object" ? {
      value: row.branch || row.value || row.name,
      label: row.branch || row.label || row.value || row.name,
      description: row.repositoryName || row.repositoryId,
    } : row));
  }
  if (field === "flavor") {
    return uniqueOptions((options.flavors || []).map((row) => row && typeof row === "object" ? {
      value: row.flavor || row.value || row.name,
      label: row.flavor || row.label || row.value || row.name,
      description: row.repositoryName || row.repositoryId,
    } : row));
  }
  return [];
}

function historyValues(row = {}) {
  return {
    from: text(row.previousActualValue ?? row.previousValue ?? row.oldValue ?? row.from),
    to: text(row.actualValue ?? row.value ?? row.newValue ?? row.to),
    at: row.updatedAt || row.createdAt || row.changedAt || row.resolvedAt,
    by: text(row.updatedBy || row.reviewer || row.resolver || row.operator),
  };
}

function sampleTargets(sample = {}) {
  return sample.groundTruth?.targets
    || sample.feedback?.correctedPrediction?.targets
    || sample.feedback?.rejectedPrediction?.targets
    || [];
}

function sampleDecision(sample = {}) {
  const decision = text(sample.feedback?.decision || sample.decision);
  return {
    correct: ["正确", "border-emerald-900/60 bg-emerald-950/30 text-emerald-300"],
    corrected: ["人工纠正", "border-cyan-900/60 bg-cyan-950/30 text-cyan-300"],
    insufficient: ["信息不足", "border-amber-900/60 bg-amber-950/30 text-amber-300"],
    ticket_wrong: ["工单有误", "border-rose-900/60 bg-rose-950/30 text-rose-300"],
  }[decision] || [decision || "已学习", "border-zinc-700 bg-zinc-900 text-zinc-400"];
}

function BindingKey({ logicalKey }) {
  return (
    <div className="flex min-w-0 items-center gap-1.5 rounded-md border border-cyan-900/50 bg-cyan-950/20 px-2 py-1.5">
      <span aria-hidden="true" className="shrink-0 text-[10px] text-cyan-400">▣</span>
      <span className="shrink-0 text-[9px] font-medium text-cyan-500">永久 Key</span>
      <code className="min-w-0 flex-1 truncate text-[10px] text-cyan-200" title={logicalKey}>{logicalKey}</code>
      <button
        type="button"
        onClick={() => navigator.clipboard?.writeText(logicalKey).catch(() => {})}
        className="shrink-0 rounded px-1 py-0.5 text-[9px] text-zinc-600 hover:bg-zinc-800 hover:text-zinc-300"
        title="复制永久 Key"
        aria-label={`复制永久 Key ${logicalKey}`}
      >复制</button>
    </div>
  );
}

function impactText(value) {
  const data = value?.data || value;
  if (!data || typeof data !== "object") return "";
  const counts = [
    ["样本", data.samples ?? data.sampleCount],
    ["推理记录", data.runs ?? data.runCount],
    ["工程定义", data.projectDefs ?? data.projectDefCount],
    ["车型配置", data.vehicles ?? data.vehicleCount],
    ["活跃故事点", data.activeStories ?? data.activeStoryCount],
  ].filter(([, count]) => Number.isFinite(Number(count)));
  return counts.length
    ? counts.map(([label, count]) => `${label} ${Number(count)}`).join(" · ")
    : text(data.summary || data.message || "影响范围已返回，请在发布前再次复核");
}

function initialDraft(binding, projectId, previous = null) {
  const normalized = normalizeKnowledgeBinding(binding, projectId);
  const currentRevision = normalized.current?.revision ?? normalized.revision;
  if (previous?.dirty && Number(previous.baseRevision) === Number(currentRevision)) return previous;
  return {
    actualValue: text(normalized.current?.actualValue ?? normalized.actualValue),
    scope: normalized.scope.value,
    scopeId: normalized.scopeId,
    reason: "",
    baseRevision: Number(currentRevision || 0),
    rollbackRevisionId: "",
    dirty: false,
  };
}

export default function RagMemoryPanel({
  projectId,
  valueBindings = [],
  samples = [],
  options = {},
  isAdmin = false,
  readOnly = false,
  readOnlyReason = "",
  latestLearned = null,
  onUpdated,
  onToast,
}) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("all");
  const [drafts, setDrafts] = useState({});
  const [savingKey, setSavingKey] = useState("");
  const [errors, setErrors] = useState({});
  const [impacts, setImpacts] = useState({});

  useEffect(() => {
    setDrafts((previous) => {
      const next = {};
      for (const binding of Array.isArray(valueBindings) ? valueBindings : []) {
        const normalized = normalizeKnowledgeBinding(binding, projectId);
        const logicalKey = normalized.logicalKey;
        if (!logicalKey) continue;
        next[logicalKey] = initialDraft(normalized, projectId, previous[logicalKey]);
      }
      return next;
    });
  }, [projectId, valueBindings]);

  const bindings = useMemo(() => (Array.isArray(valueBindings) ? valueBindings : [])
    .map((binding) => normalizeKnowledgeBinding(binding, projectId))
    .filter((binding) => binding.logicalKey), [projectId, valueBindings]);
  const stats = useMemo(() => ({
    total: bindings.length,
    resolved: bindings.filter((row) => row.resolved !== false && text(row.current?.actualValue ?? row.actualValue)).length,
    unresolved: bindings.filter((row) => row.resolved === false || !text(row.current?.actualValue ?? row.actualValue)).length,
    references: bindings.reduce((sum, row) => sum + Number(row.referenceCount || 0), 0),
    local: bindings.filter((row) => row.scope.value === "node").length,
  }), [bindings]);
  const visibleBindings = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return bindings.filter((binding) => {
      const resolved = binding.resolved !== false && !!text(binding.current?.actualValue ?? binding.actualValue);
      if (filter === "resolved" && !resolved) return false;
      if (filter === "unresolved" && resolved) return false;
      if (!needle) return true;
      return [
        binding.logicalKey,
        binding.field,
        binding.label,
        binding.current?.actualValue,
        binding.sourceValue,
        ...(binding.repositories || []),
        ...(binding.targetRoles || []),
      ].some((value) => text(value).toLowerCase().includes(needle));
    });
  }, [bindings, filter, query]);

  function updateDraft(binding, patch) {
    const logicalKey = binding.logicalKey;
    const current = drafts[logicalKey] || initialDraft(binding, projectId);
    const nextPatch = patch && typeof patch === "object" ? patch : { actualValue: patch };
    setDrafts((rows) => ({
      ...rows,
      [logicalKey]: {
        ...current,
        ...nextPatch,
        dirty: true,
      },
    }));
    setErrors((rows) => ({ ...rows, [logicalKey]: "" }));
  }

  function actionValueRevision(binding, action, draft = null) {
    const requestedScope = draft ? knowledgeScopeMeta(draft.scope).value : "";
    const requestedScopeId = draft ? text(draft.scopeId) : "";
    const inRequestedScope = (row) => !draft || (
      knowledgeScopeMeta(row?.scope).value === requestedScope
      && text(row?.scopeId) === requestedScopeId
    );
    if (action === "approve") {
      return binding.revisions.find((row) => row.status === "annotation" && inRequestedScope(row))
        || (binding.current?.status === "annotation" && inRequestedScope(binding.current) ? binding.current : null);
    }
    if (action === "activate") {
      return binding.revisions.find((row) => row.status === "approved" && inRequestedScope(row))
        || (binding.current?.status === "approved" && inRequestedScope(binding.current) ? binding.current : null);
    }
    if (draft) {
      return (binding.current?.id && inRequestedScope(binding.current) ? binding.current : null)
        || binding.revisions.find((row) => row.status === "active" && inRequestedScope(row))
        || null;
    }
    return binding.current || null;
  }

  function latestScopeRevision(binding, scope, scopeId) {
    const scopeValue = knowledgeScopeMeta(scope).value;
    const revisions = [
      ...(Array.isArray(binding.revisions) ? binding.revisions : []),
      ...(binding.current?.id ? [binding.current] : []),
    ].filter((row) => (
      knowledgeScopeMeta(row.scope).value === scopeValue
      && text(row.scopeId) === text(scopeId)
    ));
    return Math.max(0, ...revisions.map((row) => Number(row.revision) || 0));
  }

  async function runGovernanceAction(binding, action) {
    const logicalKey = binding.logicalKey;
    const draft = drafts[logicalKey] || initialDraft(binding, projectId);
    if (!isAdmin || readOnly || savingKey || !logicalKey) return;
    let validation = null;
    if (action === "draft") {
      validation = validateKnowledgeDraft(draft);
      if (!validation.ok) {
        setErrors((rows) => ({ ...rows, [logicalKey]: validation.error }));
        return;
      }
    } else if (action !== "impact" && !text(draft.reason)) {
      setErrors((rows) => ({ ...rows, [logicalKey]: "审批、激活和回滚都必须填写原因" }));
      return;
    }

    const valueRevision = actionValueRevision(binding, action, draft);
    const valueId = text(valueRevision?.id);
    const selectedScopeRevision = latestScopeRevision(binding, draft.scope, draft.scopeId);
    if (["approve", "activate", "rollback", "impact"].includes(action) && !valueId) {
      setErrors((rows) => ({ ...rows, [logicalKey]: "当前记录尚无 v2 value revision ID；请先保存治理草稿并等待 Gateway 返回新 revision" }));
      return;
    }
    if (action === "rollback" && !text(draft.rollbackRevisionId)) {
      setErrors((rows) => ({ ...rows, [logicalKey]: "请选择要回滚到的历史 revision" }));
      return;
    }

    setSavingKey(logicalKey);
    setErrors((rows) => ({ ...rows, [logicalKey]: "" }));
    try {
      let result;
      if (action === "draft" && validation.machineBinding) {
        result = await devbenchApi.upsertAiTrainingMachineBinding(projectId, binding.keyId || logicalKey, {
          actualValue: validation.actualValue,
          reason: validation.reason,
          expectedRevision: selectedScopeRevision,
        });
      } else if (action === "draft") {
        result = await devbenchApi.createAiTrainingKnowledgeValueDraft(projectId, binding.keyId || logicalKey, {
          actualValue: validation.actualValue,
          scope: validation.scope,
          scopeId: validation.scopeId,
          reason: validation.reason,
          expectedRevision: selectedScopeRevision,
        });
      } else if (action === "approve") {
        result = await devbenchApi.approveAiTrainingKnowledgeValue(projectId, valueId, {
          reason: text(draft.reason),
          expectedRevision: Number(valueRevision?.revision ?? draft.baseRevision),
        });
      } else if (action === "activate") {
        result = await devbenchApi.activateAiTrainingKnowledgeValue(projectId, valueId, {
          reason: text(draft.reason),
          expectedRevision: Number(valueRevision?.revision ?? draft.baseRevision),
        });
      } else if (action === "rollback") {
        result = await devbenchApi.rollbackAiTrainingKnowledgeValue(projectId, valueId, {
          targetRevisionId: text(draft.rollbackRevisionId),
          reason: text(draft.reason),
          expectedRevision: Number(valueRevision?.revision ?? selectedScopeRevision),
        });
      } else {
        result = await devbenchApi.getAiTrainingKnowledgeValueImpact(projectId, valueId);
      }

      if (!result?.ok) {
        const message = result?.error || "知识值治理操作失败";
        setErrors((rows) => ({ ...rows, [logicalKey]: message }));
        onToast?.(message);
        return;
      }
      if (action === "impact") {
        setImpacts((rows) => ({ ...rows, [logicalKey]: impactText(result) || "影响范围为空" }));
        onToast?.("影响范围已刷新");
        return;
      }
      const messages = {
        draft: validation?.machineBinding
          ? "本机绑定已保存，仅当前电脑生效"
          : validation?.localOnly
            ? "用户私有 Value 草稿已保存，仅当前 Gateway 可见"
            : "共享 Value 草稿已保存，尚未进入 serving",
        approve: "Value revision 已审批，尚未激活",
        activate: "Value revision 已激活",
        rollback: "已创建回滚版本并切换 active 指针",
      };
      onToast?.(messages[action] || "治理状态已更新");
      setDrafts((rows) => ({
        ...rows,
        [logicalKey]: { ...(rows[logicalKey] || draft), dirty: false, reason: "" },
      }));
      await onUpdated?.(result);
    } catch (error) {
      const message = error.message || "知识值治理操作失败";
      setErrors((rows) => ({ ...rows, [logicalKey]: message }));
      onToast?.(message);
    } finally {
      setSavingKey("");
    }
  }

  const latestSample = latestLearned?._learnedSample || latestLearned?.sample || null;
  const recentSamples = useMemo(() => (Array.isArray(samples) ? samples : []).slice(0, 12), [samples]);

  return (
    <div data-testid="rag-memory-panel" className="space-y-4">
      <section className="overflow-hidden rounded-xl border border-cyan-900/45 bg-gradient-to-br from-cyan-950/25 via-zinc-900/35 to-zinc-950/45 shadow-lg shadow-black/10">
        <div className="flex flex-wrap items-start gap-3 border-b border-zinc-800/90 px-3 py-3 sm:px-4">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-[13px] font-semibold text-zinc-100">RAG Key / Value 治理</h2>
              <span className="rounded-full border border-cyan-900/60 bg-cyan-950/35 px-2 py-0.5 text-[9px] text-cyan-300">模型无关 · 多作用域 · 可回滚</span>
            </div>
            <p className="mt-1 max-w-4xl text-[10px] leading-relaxed text-zinc-500">稳定 Key 与实际 Value 分离。共享作用域按“草稿 → 审批 → 激活”发布，回滚会生成新 revision；盘符、UNC 和 checkout 路径只能保存为本机绑定，不进入局域网共享数据。</p>
          </div>
          {!isAdmin ? <span className="rounded border border-zinc-700 bg-zinc-900 px-2 py-1 text-[9px] text-zinc-500">只读 · 管理员可替换</span> : readOnly ? <span className="rounded border border-amber-900/60 bg-amber-950/25 px-2 py-1 text-[9px] text-amber-300" title={readOnlyReason}>当前只读</span> : <span className="rounded border border-emerald-900/60 bg-emerald-950/25 px-2 py-1 text-[9px] text-emerald-300">可管理实际值</span>}
        </div>
        <div className="grid grid-cols-2 gap-px bg-zinc-800/70 sm:grid-cols-4">
          {[
            ["永久 Key", stats.total, "text-cyan-200"],
            ["已解析", stats.resolved, "text-emerald-300"],
            ["待补实际值", stats.unresolved, stats.unresolved ? "text-amber-300" : "text-zinc-400"],
            ["RAG 引用", stats.references, "text-violet-300"],
          ].map(([label, value, tone]) => <div key={label} className="bg-zinc-950/75 px-3 py-2.5"><div className="text-[9px] text-zinc-600">{label}</div><div className={`mt-0.5 text-lg font-semibold ${tone}`}>{value}</div></div>)}
        </div>
        <div className="border-t border-zinc-800 bg-zinc-950/55 px-3 py-2 text-[9px] text-zinc-600 sm:px-4">
          当前本机作用域 {stats.local} 项；project/environment/global/task 为共享值，node 为本机私有值。用户私有值也不得承载机器路径。
        </div>
      </section>

      {latestSample ? (
        <section data-testid="rag-latest-learned" className="rounded-xl border border-emerald-900/50 bg-emerald-950/15 px-3 py-2.5 sm:px-4">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[11px] font-medium text-cyan-300">最新人工标注已保存</span>
            <span className="text-[9px] text-zinc-600">{latestSample.ticket?.ticketId || latestSample.ticket?.tbTaskId || latestSample.sourceRunId}</span>
            <span className="ml-auto text-[9px] text-zinc-600">{formatTime(latestSample.updatedAt || latestSample.createdAt)}</span>
          </div>
          <div className="mt-1 truncate text-[10px] text-zinc-300" title={latestSample.ticket?.title}>{latestSample.ticket?.title || "已保存人工复核结果"} · 是否进入 serving 以 Approved/Active 状态为准</div>
        </section>
      ) : null}

      <section className="overflow-hidden rounded-xl border border-zinc-800 bg-zinc-900/25">
        <div className="flex flex-col gap-2 border-b border-zinc-800 px-3 py-3 sm:flex-row sm:items-center sm:px-4">
          <div className="min-w-0 flex-1">
            <h3 className="text-[12px] font-medium text-zinc-200">逻辑 Key → 实际值</h3>
            <div className="mt-0.5 text-[9px] text-zinc-600">显示 {visibleBindings.length} / {bindings.length} 项；写操作携带 expected revision，离线分叉仍须由 Gateway 冲突队列裁决。</div>
          </div>
          <div className="flex min-w-0 flex-col gap-2 sm:flex-row">
            <input
              data-testid="rag-binding-search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="搜索 Key、实际值、仓库…"
              className="min-w-0 rounded-md border border-zinc-700 bg-zinc-950 px-2.5 py-1.5 text-[11px] text-zinc-200 outline-none placeholder:text-zinc-700 focus:border-cyan-700 sm:w-64"
            />
            <div className="flex overflow-hidden rounded-md border border-zinc-700" role="group" aria-label="映射状态筛选">
              {[["all", "全部"], ["resolved", "已解析"], ["unresolved", "待解析"]].map(([value, label]) => <button key={value} type="button" onClick={() => setFilter(value)} className={`border-r border-zinc-700 px-2.5 py-1.5 text-[9px] last:border-r-0 ${filter === value ? "bg-cyan-900/55 text-cyan-100" : "bg-zinc-900 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-300"}`}>{label}</button>)}
            </div>
          </div>
        </div>

        {visibleBindings.length ? (
          <div className="grid gap-3 p-3 lg:grid-cols-2 2xl:grid-cols-3 sm:p-4">
            {visibleBindings.map((binding, index) => {
              const logicalKey = binding.logicalKey;
              const draft = drafts[logicalKey] || initialDraft(binding, projectId);
              const resolved = binding.resolved !== false && !!text(binding.current?.actualValue ?? binding.actualValue);
              const fieldMeta = FIELD_META[binding.field] || { label: binding.field || "配置值", tone: "text-zinc-300" };
              const history = binding.revisions.length
                ? binding.revisions
                : (Array.isArray(binding.history) ? [...binding.history].reverse() : []);
              const replaceable = binding.replaceable !== false && binding.field !== "order";
              const disabled = !isAdmin || readOnly || !replaceable || savingKey === logicalKey;
              const scope = knowledgeScopeMeta(draft.scope);
              const currentStatus = binding.current?.status || "active";
              const statusMeta = GOVERNANCE_STATUS_META[currentStatus] || GOVERNANCE_STATUS_META.annotation;
              const rollbackOptions = binding.revisions.filter((row) => (
                row.id
                && row.id !== binding.current?.id
                && knowledgeScopeMeta(row.scope).value === scope.value
                && text(row.scopeId) === text(draft.scopeId)
                && ["approved", "active", "revoked"].includes(row.status)
              ));
              const approvalRevision = actionValueRevision(binding, "approve", draft);
              const activationRevision = actionValueRevision(binding, "activate", draft);
              const currentScopeRevision = actionValueRevision(binding, "impact", draft);
              return (
                <article key={logicalKey} data-testid={`rag-binding-card-${index}`} className="min-w-0 rounded-lg border border-zinc-800 bg-zinc-950/50 p-3 transition hover:border-zinc-700 hover:bg-zinc-950/70">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className={`text-[11px] font-medium ${fieldMeta.tone}`}>{binding.label || fieldMeta.label}</span>
                    <span className={`rounded-full border px-1.5 py-0.5 text-[8px] ${resolved ? "border-emerald-900/60 bg-emerald-950/25 text-emerald-400" : "border-amber-900/60 bg-amber-950/25 text-amber-400"}`}>{resolved ? "已解析" : "待解析"}</span>
                    <span className={`rounded border px-1.5 py-0.5 text-[8px] ${statusMeta.border} ${statusMeta.tone}`}>{statusMeta.label}</span>
                    {approvalRevision?.id && approvalRevision.id !== binding.current?.id ? <span className="rounded border border-cyan-900/55 bg-cyan-950/20 px-1.5 py-0.5 text-[8px] text-cyan-300">待审批 rev {approvalRevision.revision}</span> : null}
                    {activationRevision?.id && activationRevision.id !== binding.current?.id ? <span className="rounded border border-emerald-900/55 bg-emerald-950/20 px-1.5 py-0.5 text-[8px] text-emerald-300">待激活 rev {activationRevision.revision}</span> : null}
                    <span className="ml-auto font-mono text-[8px] text-zinc-700">rev {Number(binding.current?.revision ?? binding.revision ?? 0)}</span>
                  </div>
                  <div className="mt-2"><BindingKey logicalKey={logicalKey} /></div>
                  <div className="mt-2 space-y-2">
                    <div className="grid gap-1.5 sm:grid-cols-[130px_minmax(0,1fr)]">
                      <label className="min-w-0">
                        <span className="mb-1 block text-[9px] font-medium text-zinc-400">作用域</span>
                        <select
                          data-testid={`rag-binding-scope-${index}`}
                          value={draft.scope}
                          onChange={(event) => {
                            const nextScope = knowledgeScopeMeta(event.target.value);
                            updateDraft(binding, {
                              scope: nextScope.value,
                              scopeId: nextScope.value === "project" ? projectId : "",
                            });
                          }}
                          disabled={disabled}
                          className="w-full rounded-md border border-zinc-700 bg-zinc-950 px-2 py-1.5 text-[10px] text-zinc-200 outline-none disabled:opacity-55"
                        >
                          {KNOWLEDGE_SCOPES.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
                        </select>
                      </label>
                      <label className="min-w-0">
                        <span className="mb-1 block text-[9px] font-medium text-zinc-400">{scope.needsId ? "作用域 ID" : "边界说明"}</span>
                        {scope.needsId ? (
                          <input
                            value={draft.scopeId}
                            onChange={(event) => updateDraft(binding, { scopeId: event.target.value })}
                            disabled={disabled || scope.value === "project"}
                            placeholder={scope.value === "environment" ? "例如 prod / staging" : scope.value === "task" ? "TB taskId" : scope.value === "user" ? "用户 ID" : "项目 ID"}
                            className="w-full rounded-md border border-zinc-700 bg-zinc-950 px-2 py-1.5 text-[10px] text-zinc-200 outline-none placeholder:text-zinc-700 disabled:opacity-55"
                          />
                        ) : (
                          <div className={`rounded-md border px-2 py-1.5 text-[9px] ${scope.value === "node" ? "border-amber-900/55 bg-amber-950/20 text-amber-300" : "border-zinc-800 bg-zinc-950/40 text-zinc-600"}`}>
                            {scope.value === "node" ? "仅当前电脑；不会 gossip 或导出" : "团队全局共享；禁止机器路径"}
                          </div>
                        )}
                      </label>
                    </div>
                    <div>
                      <div className="mb-1 flex items-center justify-between gap-2"><label className="text-[9px] font-medium text-zinc-400">Value 草稿</label>{binding.sourceValue && text(binding.sourceValue) !== text(binding.current?.actualValue) ? <span className="truncate text-[8px] text-zinc-700" title={binding.sourceValue}>训练源值 {binding.sourceValue}</span> : null}</div>
                      <EditableCombobox
                        testId={`rag-binding-value-${index}`}
                        value={draft.actualValue}
                        options={optionsForBinding(binding, options)}
                        onChange={(value) => updateDraft(binding, { actualValue: value })}
                        disabled={disabled}
                        className="w-full min-w-0 rounded-md border border-zinc-700 bg-zinc-950 px-2 py-1.5 text-[11px] text-zinc-100 outline-none placeholder:text-zinc-700 focus:border-emerald-700 disabled:cursor-not-allowed disabled:opacity-60"
                        placeholder="选择或输入实际值"
                        ariaLabel={`${binding.label || fieldMeta.label}的实际值`}
                        footerText={scope.value === "node" ? "本机作用域允许 checkout/发布目录；只保存在当前 Gateway" : "共享作用域禁止盘符、UNC、用户目录；保存后先进入 draft"}
                      />
                    </div>
                    <label className="block">
                      <span className="mb-1 block text-[9px] font-medium text-zinc-400">变更原因（必填）</span>
                      <input
                        data-testid={`rag-binding-reason-${index}`}
                        value={draft.reason}
                        onChange={(event) => updateDraft(binding, { reason: event.target.value })}
                        disabled={disabled}
                        placeholder="说明证据、工单或配置变更原因"
                        className="w-full rounded-md border border-zinc-700 bg-zinc-950 px-2 py-1.5 text-[10px] text-zinc-200 outline-none placeholder:text-zinc-700 disabled:opacity-55"
                      />
                    </label>
                    {rollbackOptions.length ? (
                      <label className="block">
                        <span className="mb-1 block text-[9px] font-medium text-zinc-400">回滚目标 revision</span>
                        <select
                          value={draft.rollbackRevisionId}
                          onChange={(event) => updateDraft(binding, { rollbackRevisionId: event.target.value })}
                          disabled={disabled}
                          className="w-full rounded-md border border-zinc-700 bg-zinc-950 px-2 py-1.5 text-[10px] text-zinc-200 outline-none disabled:opacity-55"
                        >
                          <option value="">请选择历史版本…</option>
                          {rollbackOptions.map((row) => <option key={row.id} value={row.id}>rev {row.revision} · {row.actualValue || "空值"} · {row.status}</option>)}
                        </select>
                      </label>
                    ) : null}
                    {errors[logicalKey] ? <div role="alert" className="rounded border border-rose-900/50 bg-rose-950/20 px-2 py-1 text-[9px] text-rose-300">{errors[logicalKey]}</div> : null}
                    {impacts[logicalKey] ? <div data-testid={`rag-binding-impact-${index}`} className="rounded border border-violet-900/50 bg-violet-950/20 px-2 py-1.5 text-[9px] text-violet-300">影响预览：{impacts[logicalKey]}</div> : null}
                    <div className="flex flex-wrap gap-1.5">
                      <button type="button" data-testid={`rag-binding-draft-${index}`} onClick={() => runGovernanceAction(binding, "draft")} disabled={disabled || !draft.dirty || !text(draft.actualValue) || !text(draft.reason)} className="rounded border border-cyan-800 bg-cyan-950/30 px-2.5 py-1.5 text-[9px] font-medium text-cyan-300 hover:bg-cyan-900/35 disabled:border-zinc-800 disabled:bg-zinc-900 disabled:text-zinc-700">
                        {savingKey === logicalKey ? "处理中…" : scope.value === "node" ? "保存本机绑定" : "保存草稿"}
                      </button>
                      <button type="button" onClick={() => runGovernanceAction(binding, "approve")} disabled={disabled || !approvalRevision?.id || !text(draft.reason)} className="rounded border border-emerald-900/70 px-2 py-1.5 text-[9px] text-emerald-400 hover:bg-emerald-950/30 disabled:opacity-35">审批{approvalRevision?.revision ? ` rev ${approvalRevision.revision}` : ""}</button>
                      <button type="button" onClick={() => runGovernanceAction(binding, "activate")} disabled={disabled || !activationRevision?.id || !text(draft.reason)} className="rounded border border-violet-900/70 px-2 py-1.5 text-[9px] text-violet-400 hover:bg-violet-950/30 disabled:opacity-35">激活{activationRevision?.revision ? ` rev ${activationRevision.revision}` : ""}</button>
                      <button type="button" onClick={() => runGovernanceAction(binding, "rollback")} disabled={disabled || !currentScopeRevision?.id || !draft.rollbackRevisionId || !text(draft.reason)} className="rounded border border-amber-900/70 px-2 py-1.5 text-[9px] text-amber-400 hover:bg-amber-950/30 disabled:opacity-35">回滚</button>
                      <button type="button" onClick={() => runGovernanceAction(binding, "impact")} disabled={disabled || !currentScopeRevision?.id} className="rounded border border-zinc-700 px-2 py-1.5 text-[9px] text-zinc-400 hover:bg-zinc-800 disabled:opacity-35">影响</button>
                    </div>
                    {!replaceable ? <div className="text-[8px] text-zinc-700">排序 Key 永久保留，实际顺序通过目标上移、下移或设为主工程自动更新。</div> : !isAdmin ? <div className="text-[8px] text-zinc-700">管理员账号可提交、审批和激活 Value revision</div> : readOnly ? <div className="text-[8px] text-amber-700">{readOnlyReason || "当前流程中暂不可治理"}</div> : !binding.governanceV2 ? <div className="rounded border border-amber-950/60 bg-amber-950/10 px-2 py-1 text-[8px] text-amber-500">兼容记录尚无 v2 revision ID。“保存草稿”会按 logicalKey alias 请求迁移；旧版直接写回已停用。</div> : null}
                  </div>
                  <div className="mt-2 flex flex-wrap gap-1.5 text-[8px] text-zinc-600">
                    <span className="rounded bg-zinc-900 px-1.5 py-0.5">引用 {Number(binding.referenceCount || 0)}</span>
                    <span className="rounded bg-zinc-900 px-1.5 py-0.5">样本 {Number(binding.sampleCount || 0)}</span>
                    <span className="rounded bg-zinc-900 px-1.5 py-0.5">目标 {Number(binding.targetCount || 0)}</span>
                    {(binding.targetRoles || []).map((role) => <span key={role} className="rounded bg-zinc-900 px-1.5 py-0.5">{role === "primary" ? "主工程" : role === "dependency" ? "依赖工程" : role}</span>)}
                  </div>
                  {(binding.repositories || []).length ? <div className="mt-1.5 truncate font-mono text-[8px] text-zinc-700" title={(binding.repositories || []).join(" · ")}>{(binding.repositories || []).join(" · ")}</div> : null}
                  <div className="mt-2 flex items-center justify-between border-t border-zinc-800/70 pt-2 text-[8px] text-zinc-700">
                    <span>{scope.label} · 更新 {formatTime(binding.current?.updatedAt || binding.updatedAt)}</span>
                    {history.length ? <details className="relative"><summary className="cursor-pointer list-none rounded px-1.5 py-0.5 text-zinc-600 hover:bg-zinc-800 hover:text-zinc-300">Revision 历史 {history.length} ▾</summary><div className="absolute bottom-6 right-0 z-20 w-80 max-w-[86vw] rounded-md border border-zinc-700 bg-zinc-950 p-2 shadow-2xl shadow-black/60">{history.map((item, historyIndex) => { const values = historyValues(item); const itemScope = knowledgeScopeMeta(item.scope || binding.scope); return <div key={item.id || `${item.revision}_${historyIndex}`} className="border-b border-zinc-800 py-1.5 last:border-b-0"><div className="flex min-w-0 items-center gap-1 text-[9px]"><span className="shrink-0 text-zinc-600">rev {item.revision || "-"}</span><span className="rounded border border-zinc-800 px-1 text-[7px] text-zinc-600">{item.status || "history"}</span><span className="truncate text-emerald-400" title={values.to}>{values.to || "未设置"}</span></div><div className="mt-0.5 truncate text-[8px] text-zinc-700" title={item.reason || ""}>{itemScope.label}{item.scopeId ? `:${item.scopeId}` : ""} · {formatTime(values.at)}{values.by ? ` · ${values.by}` : ""}{item.reason ? ` · ${item.reason}` : ""}</div></div>; })}</div></details> : <span>暂无 revision 历史</span>}
                  </div>
                </article>
              );
            })}
          </div>
        ) : <div className="px-4 py-10 text-center"><div className="text-[11px] text-zinc-500">{bindings.length ? "没有匹配的逻辑 Key" : "还没有可管理的 RAG 值映射"}</div><div className="mt-1 text-[9px] text-zinc-700">完成一次有效训练评分后，逻辑 Key 和实际值会在这里沉淀。</div></div>}
      </section>

      <section className="overflow-hidden rounded-xl border border-zinc-800 bg-zinc-900/25">
        <div className="flex flex-wrap items-center gap-2 border-b border-zinc-800 px-3 py-2.5 sm:px-4">
          <h3 className="text-[12px] font-medium text-zinc-200">最近 RAG 学习记忆</h3>
          <span className="text-[9px] text-zinc-600">保留训练时证据；实际值通过上方永久 Key 动态解析</span>
          <span className="ml-auto text-[9px] text-zinc-600">{samples.length || 0} 条</span>
        </div>
        <div className="divide-y divide-zinc-800/80">
          {recentSamples.map((sample) => {
            const decision = sampleDecision(sample);
            const targets = sampleTargets(sample);
            return (
              <div key={sample.id || sample.sourceRunId} className="grid gap-2 px-3 py-2.5 text-[10px] hover:bg-zinc-800/20 sm:px-4 lg:grid-cols-[165px_minmax(220px,1fr)_minmax(280px,1.2fr)_120px]">
                <div><div className="truncate text-zinc-300">{sample.ticket?.ticketId || sample.ticket?.tbTaskId || sample.id}</div><div className="mt-0.5 text-[8px] text-zinc-700">{formatTime(sample.updatedAt || sample.createdAt)}</div></div>
                <div className="min-w-0"><div className="truncate text-zinc-300" title={sample.ticket?.title}>{sample.ticket?.title || "真实执行配置"}</div><div className="mt-0.5 text-[8px] text-zinc-700">{sample.source === "actual_execution" ? "真实执行学习" : sample.source === "training_random" ? "随机训练" : "人工反馈"}</div></div>
                <div className="min-w-0 space-y-1">{targets.slice(0, 3).map((target, index) => { const keys = Object.values(target.fieldBindings || {}).map((binding) => binding?.logicalKey).filter(Boolean); return <div key={target.targetId || index} className="truncate text-[9px] text-zinc-500" title={keys.join(" · ")}><span className={index === 0 ? "text-cyan-500" : "text-violet-500"}>{index === 0 ? "主" : "依赖"}</span> · {target.repositoryName || target.repositoryId || target.appName || "无工程"}{keys.length ? <span className="ml-1 text-cyan-800">· {keys.length} Keys</span> : null}</div>; })}{!targets.length ? <span className="text-zinc-700">负向/信息不足记忆</span> : null}</div>
                <div className="flex items-center justify-between gap-2 lg:justify-end"><span className={`rounded border px-1.5 py-0.5 text-[8px] ${decision[1]}`}>{decision[0]}</span><span className="text-[9px] text-amber-500">{sample.rating || sample.score || "-"}★</span></div>
              </div>
            );
          })}
          {!recentSamples.length ? <div className="py-8 text-center text-[10px] text-zinc-600">暂无 RAG 学习记忆</div> : null}
        </div>
      </section>
    </div>
  );
}
