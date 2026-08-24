import React, { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  buildGitCommitBatchCreateRequests,
  gitCommitBatchCandidateKey,
  gitRepositoryDisplayUrl,
  gitRepositoryLabel,
  selectedGitCommitBatchCandidate,
} from "./gitCommitStoryModel.mjs";

const RESOLUTION_META = {
  resolved: {
    label: "已唯一匹配",
    badge: "border-emerald-500/30 bg-emerald-500/10 text-emerald-300",
    card: "border-emerald-500/20 bg-emerald-500/[0.045]",
  },
  ambiguous: {
    label: "需要选择提交",
    badge: "border-amber-500/30 bg-amber-500/10 text-amber-300",
    card: "border-amber-500/25 bg-amber-500/[0.045]",
  },
  not_found: {
    label: "未找到提交",
    badge: "border-red-500/30 bg-red-500/10 text-red-300",
    card: "border-red-500/25 bg-red-500/[0.045]",
  },
  duplicate: {
    label: "重复项（跳过）",
    badge: "border-zinc-600 bg-zinc-800 text-zinc-400",
    card: "border-zinc-800 bg-zinc-900/45",
  },
};

const CREATE_META = {
  pending: {
    label: "等待创建",
    style: "border-violet-500/25 bg-violet-500/10 text-violet-300",
  },
  creating: {
    label: "正在创建",
    style: "border-cyan-500/30 bg-cyan-500/10 text-cyan-300",
  },
  created: {
    label: "创建成功",
    style: "border-emerald-500/30 bg-emerald-500/10 text-emerald-300",
  },
  existing: {
    label: "已存在，已打开",
    style: "border-sky-500/30 bg-sky-500/10 text-sky-300",
  },
  failed: {
    label: "创建失败",
    style: "border-red-500/30 bg-red-500/10 text-red-300",
  },
};

const MATCH_KIND_LABELS = {
  revision: "SHA 精确命中",
  remote_revision: "远端 SHA 命中",
  revision_fragment: "SHA 片段命中",
  branch: "分支命中",
  remote_branch: "远端分支命中",
  ticket: "工单号命中",
  remote_ticket: "远端工单分支命中",
  message: "标题/描述命中",
  message_terms: "标题/描述词组命中",
  ticket_terms: "工单词组命中",
};

function candidateKey(candidate) {
  return gitCommitBatchCandidateKey(candidate);
}

function candidateName(candidate = {}) {
  return candidate.repositoryName
    || candidate.sourceProjectName
    || candidate.repositoryId
    || "未命名仓库";
}

function normalizeCreateStatus(value, fallback = "") {
  const status = String(value || "").trim().toLowerCase();
  if (["created", "existing", "failed", "creating", "pending"].includes(status)) return status;
  if (status === "success" || status === "done") return "created";
  if (status === "error") return "failed";
  return fallback;
}

function normalizeProgressUpdate(first, second) {
  const request = first?.request || first || {};
  const result = second || first?.result || first || {};
  const key = String(
    first?.key
      || request?.key
      || result?.key
      || result?.requestKey
      || "",
  ).trim();
  const existing = result?.existing === true || result?.data?.existing === true;
  const explicitStatus = result?.status || first?.status;
  const failed = result?.ok === false || first?.ok === false;
  return {
    key,
    inputIndex: first?.inputIndex ?? request?.inputIndex ?? result?.inputIndex,
    status: normalizeCreateStatus(
      explicitStatus,
      failed ? "failed" : existing ? "existing" : result?.ok === true ? "created" : "",
    ),
    error: String(result?.error || first?.error || "").trim(),
  };
}

function CandidateSummary({ candidate, compact = false }) {
  if (!candidate) return null;
  const branches = Array.isArray(candidate.branches) ? candidate.branches : [];
  const stats = candidate.stats || {};
  return (
    <div className="min-w-0 flex-1">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="text-[11px] font-medium text-zinc-200">{candidateName(candidate)}</span>
        <span className="font-mono text-[10px] text-violet-300">
          {String(candidate.shortRevision || candidate.revision || "").slice(0, 12)}
        </span>
      </div>
      <p className={`mt-1 text-[11px] leading-relaxed text-zinc-400 ${compact ? "line-clamp-1" : "line-clamp-2"}`}>
        {candidate.subject || "该提交没有标题"}
      </p>
      <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1 text-[9px] text-zinc-600">
        {(candidate.matchKinds || [candidate.matchKind]).filter(Boolean).slice(0, 3).map((kind) => (
          <span
            key={kind}
            className="rounded-full border border-violet-500/20 bg-violet-500/[0.06] px-1.5 py-0.5 text-violet-300/80"
          >
            {MATCH_KIND_LABELS[kind] || kind}
          </span>
        ))}
        {candidate.author && <span>{candidate.author}</span>}
        {branches[0] && <span className="max-w-[260px] truncate font-mono">{branches[0]}</span>}
        {Number.isFinite(Number(stats.files)) && <span>{Number(stats.files)} 个文件</span>}
        {Number(stats.additions ?? stats.insertions) > 0 && (
          <span className="text-emerald-500/80">+{stats.additions ?? stats.insertions}</span>
        )}
        {Number(stats.deletions) > 0 && <span className="text-red-400/80">-{stats.deletions}</span>}
      </div>
      {candidate.repositoryUrl && !compact && (
        <div
          className="mt-1.5 truncate font-mono text-[9px] text-zinc-700"
          title={candidate.repositoryUrl}
        >
          {candidate.repositoryUrl}
        </div>
      )}
    </div>
  );
}

function ResultBadge({ result }) {
  if (!result?.status) return null;
  const meta = CREATE_META[result.status] || CREATE_META.pending;
  return (
    <span className={`rounded-full border px-2 py-0.5 text-[9px] ${meta.style}`}>
      {meta.label}
    </span>
  );
}

function CommitItem({
  item,
  selectedKey,
  onSelect,
  disabled,
  createResult,
}) {
  const meta = RESOLUTION_META[item.status] || RESOLUTION_META.not_found;
  const resolution = selectedGitCommitBatchCandidate(item, selectedKey);
  const displayStatus = createResult?.status || item.status;
  const queryLabel = item.queryType === "message"
    ? `“${item.reference}”`
    : `[${item.reference}]`;

  return (
    <article
      className={`rounded-xl border px-4 py-3.5 ${meta.card}`}
      data-testid={`git-commit-batch-item-${item.inputIndex}`}
      data-status={displayStatus}
    >
      <div className="flex items-start gap-3">
        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border border-zinc-700/80 bg-zinc-950 font-mono text-[10px] text-zinc-400">
          {Number(item.inputIndex) + 1}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-mono text-[12px] font-semibold text-zinc-100">
              {queryLabel}
            </span>
            <span
              className={`rounded-full border px-2 py-0.5 text-[9px] ${meta.badge}`}
              data-testid="git-commit-batch-item-status"
              data-item-index={item.inputIndex}
            >
              {meta.label}
            </span>
            <ResultBadge result={createResult} />
          </div>

          {item.status === "resolved" && (
            <div className="mt-3 rounded-lg border border-zinc-800/80 bg-black/20 px-3 py-2.5">
              <CandidateSummary candidate={item.resolution} />
            </div>
          )}

          {item.status === "ambiguous" && (
            <div className="mt-3 space-y-2" role="radiogroup" aria-label={`为 ${item.reference} 选择提交`}>
              {(item.candidates || []).map((candidate) => {
                const key = candidateKey(candidate);
                const selected = key === selectedKey;
                return (
                  <label
                    key={key}
                    className={`flex cursor-pointer items-start gap-3 rounded-lg border px-3 py-2.5 transition ${
                      selected
                        ? "border-amber-400/40 bg-amber-500/10"
                        : "border-zinc-800 bg-black/20 hover:border-zinc-600"
                    } ${disabled ? "cursor-not-allowed opacity-60" : ""}`}
                  >
                    <input
                      type="radio"
                      name={`git-commit-batch-candidate-${item.inputIndex}`}
                      value={key}
                      checked={selected}
                      onChange={() => onSelect(item.inputIndex, key)}
                      disabled={disabled}
                      className="mt-1 h-3.5 w-3.5 accent-amber-500"
                      data-testid={`git-commit-batch-candidate-${item.inputIndex}`}
                    />
                    <CandidateSummary candidate={candidate} compact />
                  </label>
                );
              })}
              <p className="text-[10px] text-amber-300/80">
                SHA、工单号、分支或标题描述命中多个提交，必须明确选择后才能创建。
              </p>
            </div>
          )}

          {item.status === "not_found" && (
            <div className="mt-2 rounded-lg border border-red-500/15 bg-black/15 px-3 py-2 text-[10px] leading-relaxed text-red-200/90">
              {item.error || "没有在已配置的本地或远程 Git 历史中找到匹配提交。"}
            </div>
          )}

          {item.status === "duplicate" && (
            <p className="mt-2 text-[10px] text-zinc-500">
              与第 {Number(item.duplicateOf) + 1} 条查询或提交重复，本次批量创建将自动跳过。
            </p>
          )}

          {item.excerpt && (
            <details className="mt-2 rounded-lg border border-zinc-800/70 bg-black/10 px-3 py-1.5">
              <summary className="cursor-pointer text-[9px] text-zinc-600 hover:text-zinc-400">
                查看输入中的风险描述
              </summary>
              <p className="mt-2 whitespace-pre-wrap text-[10px] leading-relaxed text-zinc-500">
                {item.excerpt}
              </p>
            </details>
          )}

          {resolution && item.status === "ambiguous" && (
            <div className="mt-2 text-[9px] text-emerald-400/80">
              已选择 {candidateName(resolution)} · {String(resolution.revision || "").slice(0, 12)}
            </div>
          )}

          {createResult?.status === "failed" && (
            <div role="alert" className="mt-2 text-[10px] leading-relaxed text-red-300">
              {createResult.error || "创建失败，可在处理问题后重试失败项。"}
            </div>
          )}
        </div>
      </div>
    </article>
  );
}

export default function GitCommitBatchStoryModal({
  projectDefs = [],
  projectId = "",
  onClose,
  onResolve,
  onSubmit,
  embedded = false,
  onBusyChange,
}) {
  const [input, setInput] = useState("");
  const [repositoryId, setRepositoryId] = useState("");
  const [resolution, setResolution] = useState(null);
  const [selections, setSelections] = useState({});
  const [sourceMode, setSourceMode] = useState("");
  const [createResults, setCreateResults] = useState({});
  const [resolving, setResolving] = useState(false);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState("");
  const inputRef = useRef(null);
  const busy = resolving || creating;
  const items = Array.isArray(resolution?.items) ? resolution.items : [];

  useEffect(() => {
    onBusyChange?.(busy);
    return () => onBusyChange?.(false);
  }, [busy, onBusyChange]);

  const selectedCandidates = useMemo(() => items
    .filter((item) => item.status !== "duplicate")
    .map((item) => selectedGitCommitBatchCandidate(item, selections[item.inputIndex]))
    .filter(Boolean), [items, selections]);

  const completedKeys = useMemo(() => Object.entries(createResults)
    .filter(([, result]) => result?.status === "created" || result?.status === "existing")
    .map(([key]) => key), [createResults]);

  const createPlan = useMemo(() => buildGitCommitBatchCreateRequests({
    items,
    selections,
    projectId,
    completedKeys,
    sourceMode,
  }), [completedKeys, items, projectId, selections, sourceMode]);

  const allSucceeded = useMemo(() => {
    if (!items.length || selectedCandidates.length === 0) return false;
    const requiredKeys = new Set(selectedCandidates.map(candidateKey).filter(Boolean));
    const unresolvedCount = items.filter((item) => (
      item.status !== "duplicate"
      && !selectedGitCommitBatchCandidate(item, selections[item.inputIndex])
    )).length;
    return unresolvedCount === 0
      && requiredKeys.size > 0
      && [...requiredKeys].every((key) => completedKeys.includes(key));
  }, [completedKeys, items, selectedCandidates, selections]);

  useEffect(() => {
    inputRef.current?.focus();
    if (embedded) return undefined;
    const suppressEscape = (event) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
    };
    window.addEventListener("keydown", suppressEscape, true);
    return () => window.removeEventListener("keydown", suppressEscape, true);
  }, [embedded]);

  function resetPreview() {
    setResolution(null);
    setSelections({});
    setSourceMode("");
    setCreateResults({});
    setError("");
  }

  function changeInput(value) {
    setInput(value);
    if (resolution) resetPreview();
    else setError("");
  }

  function changeRepository(value) {
    setRepositoryId(value);
    if (resolution) resetPreview();
    else setError("");
  }

  async function resolveInput() {
    const value = input.trim();
    if (!value) {
      setError("请粘贴 revision、commit message 关键词或评审文档内容。");
      inputRef.current?.focus();
      return;
    }
    setResolving(true);
    setError("");
    setResolution(null);
    setSelections({});
    setSourceMode("");
    setCreateResults({});
    try {
      const result = await onResolve?.({
        input: value,
        ...(repositoryId ? { repositoryId } : {}),
        ...(projectId ? { projectId } : {}),
      });
      const data = result?.data?.items ? result.data : result;
      if (!result?.ok || !Array.isArray(data?.items)) {
        setError(result?.error || "批量解析失败，请检查本地仓库配置后重试。");
        return;
      }
      setResolution(data);
    } catch (resolveError) {
      setError(resolveError?.message || "批量解析失败，请稍后重试。");
    } finally {
      setResolving(false);
    }
  }

  function applyProgress(first, second) {
    const update = normalizeProgressUpdate(first, second);
    if (!update.key || !update.status) return;
    setCreateResults((current) => ({
      ...current,
      [update.key]: {
        ...(current[update.key] || {}),
        status: update.status,
        error: update.error,
        inputIndex: update.inputIndex,
      },
    }));
  }

  function mergeReturnedResults(result, requests) {
    const returned = Array.isArray(result?.results) ? result.results : [];
    returned.forEach((row) => applyProgress(row));
    setCreateResults((current) => {
      const next = { ...current };
      requests.forEach((request) => {
        const existing = next[request.key];
        if (existing?.status && existing.status !== "creating") return;
        const row = returned.find((candidate) => (
          candidate?.key === request.key || candidate?.inputIndex === request.inputIndex
        ));
        const status = normalizeCreateStatus(
          row?.status,
          row?.existing === true
            ? "existing"
            : row?.ok === false || result?.ok === false
              ? "failed"
              : "created",
        );
        next[request.key] = {
          status,
          inputIndex: request.inputIndex,
          error: String(row?.error || result?.error || "").trim(),
        };
      });
      return next;
    });
  }

  async function createStories() {
    if (!createPlan.ok || !createPlan.requests.length) {
      setError(createPlan.error || "请先完成所有歧义仓库选择。");
      return;
    }
    if (typeof onSubmit !== "function") {
      setError("批量创建入口尚未就绪，请刷新页面后重试。");
      return;
    }
    const requests = createPlan.requests;
    setCreating(true);
    setError("");
    setCreateResults((current) => {
      const next = { ...current };
      requests.forEach((request) => {
        next[request.key] = {
          status: "creating",
          inputIndex: request.inputIndex,
          error: "",
        };
      });
      return next;
    });
    try {
      const result = await onSubmit(requests, applyProgress);
      mergeReturnedResults(result || {}, requests);
      if (result?.ok === false) {
        setError(result?.error || "部分故事点创建失败，成功项已保留，可直接重试失败项。");
      }
    } catch (submitError) {
      const message = submitError?.message || "批量创建失败，可直接重试未完成项。";
      setCreateResults((current) => {
        const next = { ...current };
        requests.forEach((request) => {
          if (next[request.key]?.status === "creating") {
            next[request.key] = {
              status: "failed",
              inputIndex: request.inputIndex,
              error: message,
            };
          }
        });
        return next;
      });
      setError(message);
    } finally {
      setCreating(false);
    }
  }

  const summary = resolution?.summary || {};
  const failedCount = Object.values(createResults).filter((result) => result?.status === "failed").length;
  const completedCount = completedKeys.length;
  const canCreate = Boolean(items.length && createPlan.ok && createPlan.requests.length && !busy && !allSucceeded);

  const body = (
      <div
        className={embedded
          ? "relative flex h-full min-h-0 flex-1 flex-col overflow-hidden"
          : "relative flex max-h-[92vh] w-[900px] max-w-[97vw] flex-col overflow-hidden rounded-2xl border border-violet-400/25 bg-zinc-950 shadow-[0_40px_140px_rgba(0,0,0,0.86)]"}
        onClick={(event) => event.stopPropagation()}
        data-testid={embedded ? "git-commit-batch-embedded" : undefined}
      >
        {!embedded && (
          <>
            <div className="pointer-events-none absolute -left-28 -top-32 h-72 w-72 rounded-full bg-violet-500/15 blur-[90px]" />
            <div className="pointer-events-none absolute -right-24 top-8 h-64 w-64 rounded-full bg-cyan-500/10 blur-[90px]" />
          </>
        )}

        <header className="relative shrink-0 border-b border-zinc-800 px-6 py-5">
          <div className="flex items-start gap-4">
            <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-violet-300/30 bg-gradient-to-br from-violet-500/25 to-cyan-500/10 font-mono text-sm font-semibold text-violet-100">
              [#]
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <h2 id="git-commit-batch-title" className="text-base font-semibold text-zinc-50">
                  从 Git commit 批量创建评审故事点
                </h2>
                <span className="rounded-full border border-violet-400/25 bg-violet-500/10 px-2 py-0.5 text-[9px] uppercase tracking-[0.13em] text-violet-200">
                  Batch Review
                </span>
              </div>
              <p className="mt-1 max-w-[680px] text-[11px] leading-relaxed text-zinc-400">
                粘贴评审文档或查询词，系统会联合短 SHA、工单号、分支和标题描述检索已配置的本地历史与远端分支，并逐条复用单 commit 评审故事点创建流程。
              </p>
            </div>
            {!embedded && (
              <button
                type="button"
                onClick={() => {
                  if (!busy) onClose?.();
                }}
                disabled={busy}
                className="rounded-lg px-2 py-1 text-sm text-zinc-500 transition hover:bg-zinc-800 hover:text-zinc-100 disabled:cursor-not-allowed disabled:opacity-35"
                aria-label="关闭"
                title={busy ? "处理中不能关闭" : "关闭"}
                data-testid="git-commit-batch-close"
              >
                ✕
              </button>
            )}
          </div>
        </header>

        <div className="relative flex-1 overflow-y-auto px-6 py-5">
          <section className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_250px]">
            <div>
              <div className="mb-2 flex items-center justify-between gap-3">
                <label htmlFor="git-commit-batch-input" className="text-[11px] font-medium text-zinc-300">
                  评审文档 / SHA / 工单号 / 标题描述
                </label>
                <span className="text-[9px] text-zinc-600">最多解析 30 个查询</span>
              </div>
              <textarea
                id="git-commit-batch-input"
                ref={inputRef}
                value={input}
                onChange={(event) => changeInput(event.target.value)}
                disabled={busy}
                rows={7}
                spellCheck="false"
                placeholder={"例如：\n单号：CARB-13851 · 【转载】【P166-G】进入 youtube 后...\n提交：zlangit · 82f08ca\n分支：story/geely_p155_CARB_13851\n标题：#CARB-13851# 状态面板展开时补偿悬浮球位置\n\n也可每行输入 SHA、CARB 工单号或标题描述"}
                className="min-h-[174px] w-full resize-y rounded-xl border border-zinc-700 bg-zinc-900/75 px-3.5 py-3 font-mono text-[11px] leading-relaxed text-zinc-200 outline-none transition placeholder:font-sans placeholder:text-zinc-600 focus:border-violet-400/65 focus:ring-2 focus:ring-violet-500/10 disabled:opacity-60"
                data-testid="git-commit-batch-input"
              />
            </div>

            <div className="flex flex-col">
              <label htmlFor="git-commit-batch-repository" className="mb-2 text-[11px] font-medium text-zinc-300">
                仓库检索范围（可选）
              </label>
              <select
                id="git-commit-batch-repository"
                value={repositoryId}
                onChange={(event) => changeRepository(event.target.value)}
                disabled={busy}
                className="w-full rounded-xl border border-zinc-700 bg-zinc-900 px-3 py-2.5 text-[11px] text-zinc-200 outline-none transition focus:border-cyan-400/60 disabled:opacity-60"
              >
                <option value="">全部已配置仓库</option>
                {projectDefs.map((repository) => (
                  <option key={repository.id} value={repository.id}>
                    {gitRepositoryLabel(repository)}
                  </option>
                ))}
              </select>
              <div className="mt-3 flex-1 rounded-xl border border-cyan-500/15 bg-cyan-500/[0.045] px-3.5 py-3">
                <div className="text-[10px] font-medium text-cyan-200">只读解析</div>
                <p className="mt-1.5 text-[10px] leading-relaxed text-zinc-500">
                  同时读取已登记工程的主仓与 WebApp 子仓，不切换分支、不修改原工程；本地未同步或发生 rebase 时会补查远端工单分支，命中多个提交必须人工选择。
                </p>
                {repositoryId && (
                  <div className="mt-2 truncate font-mono text-[9px] text-zinc-600">
                    {gitRepositoryDisplayUrl(projectDefs.find((row) => row.id === repositoryId) || {}) || repositoryId}
                  </div>
                )}
              </div>
              <button
                type="button"
                onClick={resolveInput}
                disabled={busy || !input.trim()}
                className="mt-3 w-full rounded-xl border border-violet-300/25 bg-gradient-to-r from-violet-600 to-fuchsia-600 px-4 py-2.5 text-[11px] font-medium text-white shadow-lg shadow-violet-950/30 transition hover:from-violet-500 hover:to-fuchsia-500 disabled:cursor-not-allowed disabled:border-zinc-700 disabled:from-zinc-800 disabled:to-zinc-800 disabled:text-zinc-500 disabled:shadow-none"
                data-testid="git-commit-batch-resolve"
              >
                {resolving ? "正在联合检索本地历史与远端分支…" : resolution ? "重新解析" : "解析并预览"}
              </button>
            </div>
          </section>

          {resolution && (
            <section className="mt-5" aria-label="批量解析结果">
              <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
                <div>
                  <h3 className="text-[12px] font-medium text-zinc-200">解析预览</h3>
                  <p className="mt-0.5 text-[9px] text-zinc-600">
                    已搜索 {summary.repositoriesSearched ?? "—"} 个已配置仓库；创建前可逐项核对匹配依据。
                  </p>
                </div>
                <div className="flex flex-wrap gap-1.5" data-testid="git-commit-batch-summary">
                  <span className="rounded-full border border-zinc-700 bg-zinc-900 px-2 py-1 text-[9px] text-zinc-400">
                    共 {summary.total ?? items.length}
                  </span>
                  <span className="rounded-full border border-emerald-500/25 bg-emerald-500/10 px-2 py-1 text-[9px] text-emerald-300">
                    唯一匹配 {summary.resolved ?? 0}
                  </span>
                  <span className="rounded-full border border-amber-500/25 bg-amber-500/10 px-2 py-1 text-[9px] text-amber-300">
                    待选择 {summary.ambiguous ?? 0}
                  </span>
                  <span className="rounded-full border border-red-500/25 bg-red-500/10 px-2 py-1 text-[9px] text-red-300">
                    未找到 {summary.notFound ?? 0}
                  </span>
                  <span className="rounded-full border border-zinc-700 bg-zinc-900 px-2 py-1 text-[9px] text-zinc-500">
                    重复 {summary.duplicate ?? 0}
                  </span>
                </div>
              </div>

              <div className="space-y-2.5">
                {items.map((item) => {
                  const candidate = selectedGitCommitBatchCandidate(item, selections[item.inputIndex]);
                  return (
                    <CommitItem
                      key={`${item.inputIndex}-${item.reference}`}
                      item={item}
                      selectedKey={selections[item.inputIndex] || ""}
                      onSelect={(inputIndex, key) => {
                        setSelections((current) => ({ ...current, [inputIndex]: key }));
                        setCreateResults((current) => Object.fromEntries(
                          Object.entries(current).filter(([, result]) => (
                            result?.inputIndex !== inputIndex
                            || result?.status === "created"
                            || result?.status === "existing"
                          )),
                        ));
                        setError("");
                      }}
                      disabled={busy || Boolean(candidate && completedKeys.includes(candidateKey(candidate)))}
                      createResult={candidate ? createResults[candidateKey(candidate)] : null}
                    />
                  );
                })}
              </div>

              <div className="mt-4 rounded-xl border border-zinc-800 bg-zinc-900/45 p-3.5" data-testid="git-commit-batch-source-preset">
                <div className="text-[11px] font-medium text-zinc-200">创建前预设工程来源</div>
                <p className="mt-1 text-[9px] leading-relaxed text-zinc-600">
                  解析结果只用于预览。确认来源后将逐条进入 AI 配置推理复核；每条都由用户确认后才创建故事点。
                </p>
                <div className="mt-3 grid gap-2 sm:grid-cols-2">
                  <button
                    type="button"
                    aria-pressed={sourceMode === "local"}
                    disabled={busy}
                    onClick={() => {
                      setSourceMode("local");
                      setError("");
                    }}
                    className={`rounded-lg border px-3 py-2.5 text-left transition disabled:opacity-50 ${
                      sourceMode === "local"
                        ? "border-cyan-500/60 bg-cyan-500/10"
                        : "border-zinc-700 bg-zinc-950/45 hover:border-zinc-600"
                    }`}
                    data-testid="git-commit-batch-source-local"
                  >
                    <span className="block text-[10px] font-medium text-cyan-200">使用匹配到的本地工程</span>
                    <span className="mt-1 block text-[9px] text-zinc-600">逐条校验本机 Git 对象，不会静默回退远程。</span>
                  </button>
                  <button
                    type="button"
                    aria-pressed={sourceMode === "remote"}
                    disabled={busy}
                    onClick={() => {
                      setSourceMode("remote");
                      setError("");
                    }}
                    className={`rounded-lg border px-3 py-2.5 text-left transition disabled:opacity-50 ${
                      sourceMode === "remote"
                        ? "border-violet-500/60 bg-violet-500/10"
                        : "border-zinc-700 bg-zinc-950/45 hover:border-zinc-600"
                    }`}
                    data-testid="git-commit-batch-source-remote"
                  >
                    <span className="block text-[10px] font-medium text-violet-200">远程拉取</span>
                    <span className="mt-1 block text-[9px] text-zinc-600">按每条提交的逻辑仓库和精确 revision 创建远程配置。</span>
                  </button>
                </div>
              </div>
            </section>
          )}

          {allSucceeded && (
            <div className="mt-5 rounded-xl border border-emerald-400/25 bg-emerald-500/[0.08] px-4 py-3.5" data-testid="git-commit-batch-success">
              <div className="flex items-start gap-3">
                <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-emerald-500/15 text-sm text-emerald-300">✓</span>
                <div>
                  <div className="text-[11px] font-medium text-emerald-100">全部评审故事点已处理完成</div>
                  <p className="mt-1 text-[10px] leading-relaxed text-zinc-500">
                    已完成 {completedCount} 个唯一提交；重复输入已自动跳过。点击“完成”关闭面板。
                  </p>
                </div>
              </div>
            </div>
          )}

          {error && (
            <div role="alert" className="mt-4 rounded-xl border border-red-500/30 bg-red-500/[0.08] px-3.5 py-2.5 text-[10px] leading-relaxed text-red-200">
              {error}
            </div>
          )}
        </div>

        <footer className="relative flex shrink-0 items-center justify-between gap-4 border-t border-zinc-800 bg-zinc-900/45 px-6 py-4">
          <div className="min-w-0 text-[10px] text-zinc-600">
            {creating
              ? "正在逐条创建，请勿关闭面板…"
              : failedCount
                ? `${failedCount} 项失败；成功项不会重复创建`
                : resolution
                  ? createPlan.ok
                    ? `准备逐条复核 ${createPlan.requests.length} 个 commit`
                    : createPlan.error
                  : embedded
                    ? "解析后可逐条创建评审故事点"
                    : "点击遮罩或按 Esc 均不会关闭此面板"}
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {allSucceeded ? (
              <button
                type="button"
                onClick={() => onClose?.()}
                disabled={busy}
                className="rounded-xl bg-emerald-600 px-5 py-2.5 text-[11px] font-semibold text-white shadow-lg shadow-emerald-950/30 transition hover:bg-emerald-500 disabled:opacity-40"
                data-testid="git-commit-batch-finish"
              >
                完成
              </button>
            ) : (
              <button
                type="button"
                onClick={createStories}
                disabled={!canCreate}
                className="min-w-44 rounded-xl border border-violet-300/25 bg-gradient-to-r from-violet-600 to-fuchsia-600 px-4 py-2.5 text-[11px] font-semibold text-white shadow-lg shadow-violet-950/35 transition hover:from-violet-500 hover:to-fuchsia-500 disabled:cursor-not-allowed disabled:border-zinc-700 disabled:from-zinc-800 disabled:to-zinc-800 disabled:text-zinc-600 disabled:shadow-none"
                data-testid="git-commit-batch-create"
              >
                {creating
                  ? "正在逐条创建…"
                  : failedCount
                    ? `重试失败项（${createPlan.requests.length || failedCount}）`
                    : `逐条进入 AI 推理（${createPlan.requests.length || 0}）`}
              </button>
            )}
          </div>
        </footer>
      </div>
  );

  if (embedded) return body;

  const modal = (
    <div
      className="fixed inset-0 z-[146] flex items-center justify-center bg-black/80 p-4 backdrop-blur-md"
      role="dialog"
      aria-modal="true"
      aria-labelledby="git-commit-batch-title"
      data-testid="git-commit-batch-modal"
      onClick={(event) => event.stopPropagation()}
      onKeyDownCapture={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
        }
      }}
    >
      {body}
    </div>
  );

  return typeof document !== "undefined" ? createPortal(modal, document.body) : modal;
}
