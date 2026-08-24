import React, { useEffect, useState } from "react";
import { devbenchApi } from "./api.js";
import {
  pullRequestChangeSummary,
  pullRequestPreviewView,
} from "./pullRequestPreviewModel.mjs";

const ROLE_LABELS = {
  primary: "主工程",
  standalone: "主工程",
  dependency: "依赖工程",
  extra: "关联工程",
  webapp: "WebApp",
};

function statusPresentation(entry) {
  if (entry.status === "ready") {
    return {
      label: "可提 PR",
      badge: "border-emerald-500/30 bg-emerald-500/15 text-emerald-200",
      card: "border-emerald-500/25 bg-emerald-950/20",
      dot: "bg-emerald-400 shadow-[0_0_10px_rgba(52,211,153,.65)]",
    };
  }
  if (entry.status === "no_changes") {
    return {
      label: "无新提交",
      badge: "border-zinc-600 bg-zinc-800/80 text-zinc-300",
      card: "border-zinc-700/70 bg-zinc-950/35",
      dot: "bg-zinc-500",
    };
  }
  return {
    label: "需先处理",
    badge: "border-amber-500/30 bg-amber-500/15 text-amber-200",
    card: "border-amber-500/25 bg-amber-950/15",
    dot: "bg-amber-400",
  };
}

export default function PullRequestPanel({
  tabId,
  refreshKey = 0,
  onClose,
  onExecute,
  onToast,
}) {
  const [loading, setLoading] = useState(true);
  const [executing, setExecuting] = useState(false);
  const [payload, setPayload] = useState(null);
  const [error, setError] = useState("");

  async function loadPreview() {
    if (executing) return;
    setLoading(true);
    setError("");
    try {
      const response = await devbenchApi.gitPullRequestPreview(tabId);
      if (!response?.ok) {
        setPayload(null);
        setError(response?.error || "提 PR 预检失败");
      } else {
        setPayload(response.data || {});
      }
    } catch (previewError) {
      setPayload(null);
      setError(previewError?.message || String(previewError));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadPreview();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabId, refreshKey]);

  useEffect(() => {
    const handleKeyDown = (event) => {
      if (event.key === "Escape" && !executing) onClose?.();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [executing, onClose]);

  const view = pullRequestPreviewView(payload || {});
  const codeup = payload?.codeup || {};

  async function confirmPullRequest() {
    if (!view.canExecute || executing) return;
    setExecuting(true);
    try {
      const handled = await onExecute?.(view.executionPaths);
      if (handled !== false) onClose?.();
    } catch (executeError) {
      onToast?.(`提 PR 失败：${executeError?.message || executeError}`);
    } finally {
      setExecuting(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-[80] flex items-center justify-center bg-black/70 p-4 backdrop-blur-md"
      onClick={() => { if (!executing) onClose?.(); }}
      role="dialog"
      aria-modal="true"
      aria-label="提 PR 预检"
      data-testid="devbench-pr-preview"
    >
      <div
        className="flex max-h-[90vh] w-[780px] max-w-[96vw] flex-col overflow-hidden rounded-2xl border border-emerald-500/25 bg-zinc-900 shadow-[0_28px_90px_rgba(0,0,0,.65)]"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="relative overflow-hidden border-b border-zinc-800 px-5 py-4">
          <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top_left,rgba(16,185,129,.18),transparent_42%),radial-gradient(circle_at_top_right,rgba(6,182,212,.12),transparent_36%)]" />
          <div className="relative flex items-start gap-3">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-emerald-400/30 bg-emerald-400/10 text-xl text-emerald-200 shadow-inner">
              ↗
            </div>
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="text-[15px] font-semibold tracking-wide text-zinc-50">提 PR 前确认</h2>
                {payload?.carbId ? (
                  <span className="rounded-full border border-cyan-500/25 bg-cyan-500/10 px-2 py-0.5 font-mono text-[10px] text-cyan-200">
                    {payload.carbId}
                  </span>
                ) : payload?.storyDevTag ? (
                  <span className="rounded-full border border-violet-500/25 bg-violet-500/10 px-2 py-0.5 font-mono text-[10px] text-violet-200">
                    {payload.storyDevTag}
                  </span>
                ) : null}
              </div>
              <p className="mt-1 text-[11px] leading-relaxed text-zinc-400">
                先核对工程范围、来源分支、目标分支和可提内容；没有新增内容的工程不会执行。
              </p>
            </div>
            <div className="ml-auto flex shrink-0 items-center gap-1.5">
              <button
                onClick={loadPreview}
                disabled={loading || executing}
                className="rounded-lg border border-zinc-700 bg-zinc-800/80 px-2.5 py-1 text-[11px] text-zinc-300 transition hover:border-zinc-600 hover:bg-zinc-700 disabled:opacity-50"
              >
                {loading ? "检查中…" : "↻ 重新检查"}
              </button>
              <button
                onClick={onClose}
                disabled={executing}
                className="flex h-7 w-7 items-center justify-center rounded-lg text-zinc-500 transition hover:bg-zinc-800 hover:text-zinc-200 disabled:opacity-40"
                aria-label="关闭"
              >
                ×
              </button>
            </div>
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          {loading ? (
            <div className="flex flex-col items-center justify-center py-16 text-zinc-500">
              <div className="h-8 w-8 animate-spin rounded-full border-2 border-zinc-700 border-t-emerald-400" />
              <div className="mt-3 text-xs">正在读取各工程 Git 状态…</div>
            </div>
          ) : error ? (
            <div className="rounded-xl border border-red-500/30 bg-red-950/25 px-4 py-4 text-center">
              <div className="text-sm font-medium text-red-200">预检没有完成</div>
              <div className="mt-1 break-all text-[11px] leading-relaxed text-red-300/80">{error}</div>
              <button
                onClick={loadPreview}
                className="mt-3 rounded-lg border border-red-500/30 bg-red-500/15 px-3 py-1.5 text-[11px] text-red-100 hover:bg-red-500/25"
              >
                重新检查
              </button>
            </div>
          ) : (
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                {[
                  ["工程总数", view.total, "text-zinc-100", "border-zinc-700/70 bg-zinc-950/40"],
                  ["可提 PR", view.eligible, "text-emerald-300", "border-emerald-500/20 bg-emerald-950/20"],
                  ["无新提交", view.noChanges, "text-zinc-300", "border-zinc-700/70 bg-zinc-950/40"],
                  ["需先处理", view.blocked, "text-amber-300", "border-amber-500/20 bg-amber-950/15"],
                ].map(([label, value, valueClass, cardClass]) => (
                  <div key={label} className={`rounded-xl border px-3 py-2.5 ${cardClass}`}>
                    <div className="text-[10px] uppercase tracking-wider text-zinc-500">{label}</div>
                    <div className={`mt-0.5 text-xl font-semibold tabular-nums ${valueClass}`}>{value}</div>
                  </div>
                ))}
              </div>

              {view.globalBlocker ? (
                <div className="rounded-xl border border-red-500/30 bg-red-950/25 px-3.5 py-2.5 text-[11px] leading-relaxed text-red-200">
                  <span className="mr-1.5">✕</span>{view.globalBlocker}，当前不能执行提 PR。
                </div>
              ) : null}

              {view.globalWarning ? (
                <div className="rounded-xl border border-violet-500/25 bg-violet-950/20 px-3.5 py-2.5 text-[11px] leading-relaxed text-violet-100">
                  <span className="mr-1.5">◇</span>{view.globalWarning}。
                </div>
              ) : null}

              {payload?.title ? (
                <div className="rounded-xl border border-zinc-700/70 bg-zinc-950/40 px-3.5 py-2.5">
                  <div className="text-[9px] uppercase tracking-wider text-zinc-600">最终 PR / 自动提交标题</div>
                  <div className="mt-1 break-words font-mono text-[11px] leading-relaxed text-zinc-200">{payload.title}</div>
                  {payload.identityType === "storydev" && payload.storyDevId ? (
                    <div className="mt-1.5 break-all text-[9px] text-zinc-600">StoryDev ID：{payload.storyDevId}</div>
                  ) : null}
                </div>
              ) : null}

              {codeup.autoCreateReady === false ? (
                <div className="rounded-xl border border-amber-500/25 bg-amber-950/20 px-3.5 py-2.5 text-[11px] leading-relaxed text-amber-100">
                  <span className="font-medium">Codeup 自动创建配置不完整。</span>
                  执行后可以推送分支，但部分 MR 可能需要手动补建。
                </div>
              ) : null}

              <div className="space-y-2.5" data-testid="devbench-pr-preview-projects">
                {view.entries.map((entry, index) => {
                  const presentation = statusPresentation(entry);
                  const changeSummary = pullRequestChangeSummary(entry);
                  const commits = Array.isArray(entry.commits) ? entry.commits : [];
                  return (
                    <div
                      key={entry.path || `${entry.name}-${index}`}
                      className={`rounded-xl border px-3.5 py-3 transition ${presentation.card}`}
                      data-testid="devbench-pr-preview-project"
                    >
                      <div className="flex flex-wrap items-center gap-2">
                        <span className={`h-2 w-2 rounded-full ${presentation.dot}`} />
                        <span className="min-w-0 truncate text-[13px] font-medium text-zinc-100">{entry.name || "未命名工程"}</span>
                        <span className="rounded border border-zinc-700 bg-zinc-800/80 px-1.5 py-0.5 text-[9px] text-zinc-400">
                          {ROLE_LABELS[entry.role] || entry.role || "关联工程"}
                        </span>
                        <span className={`ml-auto rounded-full border px-2 py-0.5 text-[10px] font-medium ${presentation.badge}`}>
                          {presentation.label}
                        </span>
                      </div>

                      <div className="mt-2.5 flex items-center gap-2 rounded-lg border border-zinc-800/80 bg-black/20 px-2.5 py-2">
                        <div className="min-w-0 flex-1">
                          <div className="text-[9px] uppercase tracking-wider text-zinc-600">来源分支</div>
                          <div className="truncate font-mono text-[11px] text-amber-200" title={entry.storyBranch || ""}>
                            {entry.storyBranch || "未识别"}
                          </div>
                        </div>
                        <div className="shrink-0 text-base text-emerald-400/80">→</div>
                        <div className="min-w-0 flex-1 text-right">
                          <div className="text-[9px] uppercase tracking-wider text-zinc-600">目标分支</div>
                          <div className="truncate font-mono text-[11px] text-cyan-200" title={entry.originalBranch || ""}>
                            {entry.originalBranch || "未识别"}
                          </div>
                        </div>
                      </div>

                      {entry.status === "ready" ? (
                        <div className="mt-2">
                          <div className="text-[11px] font-medium text-emerald-200">✓ {changeSummary}</div>
                          {entry.behindCount > 0 ? (
                            <div className="mt-1 text-[10px] text-amber-300/90">
                              目标分支另有 {entry.behindCount} 个提交，创建 PR 后请留意冲突。
                            </div>
                          ) : null}
                          {commits.length ? (
                            <div className="mt-2 space-y-1 border-l border-zinc-700/80 pl-2.5">
                              {commits.map((commit) => (
                                <div key={`${commit.sha}-${commit.subject}`} className="flex min-w-0 items-baseline gap-2 text-[10px]">
                                  <span className="shrink-0 font-mono text-violet-300">{commit.sha}</span>
                                  <span className="truncate text-zinc-400" title={commit.subject}>{commit.subject}</span>
                                </div>
                              ))}
                            </div>
                          ) : null}
                        </div>
                      ) : (
                        <div className={`mt-2 text-[10px] leading-relaxed ${entry.status === "blocked" ? "text-amber-200" : "text-zinc-500"}`}>
                          {entry.error || entry.reason || "没有可提 PR 的提交"}
                        </div>
                      )}
                      {entry.fetchWarning && entry.status !== "blocked" ? (
                        <div className="mt-1.5 text-[10px] leading-relaxed text-amber-300/90">
                          ⚠ {entry.fetchWarning}
                        </div>
                      ) : null}
                    </div>
                  );
                })}
              </div>

              {!view.entries.length ? (
                <div className="py-10 text-center text-xs text-zinc-600">没有发现可检查的工程。</div>
              ) : null}
            </div>
          )}
        </div>

        <div className="border-t border-zinc-800 bg-zinc-950/35 px-5 py-3.5">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
            <div className="min-w-0 flex-1 text-[10px] leading-relaxed text-zinc-500">
              {view.canExecute
                ? `将只处理上方 ${view.eligible} 个“可提 PR”工程；执行前后端会再次复检。`
                : (!loading && !error
                    ? (view.globalBlocker
                        ? "请先处理上方故事点关联问题；当前不会执行任何提交、推送或 MR 创建。"
                        : "没有可提 PR 的提交，本次不会执行任何提交、推送或 MR 创建。")
                    : "预检完成后才能执行。")}
            </div>
            <div className="flex shrink-0 items-center justify-end gap-2">
              <button
                onClick={onClose}
                disabled={executing}
                className="rounded-lg border border-zinc-700 bg-zinc-800 px-3.5 py-1.5 text-[12px] text-zinc-300 transition hover:bg-zinc-700 disabled:opacity-50"
              >
                取消
              </button>
              <button
                onClick={confirmPullRequest}
                disabled={loading || !!error || !view.canExecute || executing}
                data-testid="devbench-pr-preview-confirm"
                className="min-w-[150px] rounded-lg border border-emerald-400/30 bg-emerald-500/20 px-4 py-1.5 text-[12px] font-medium text-emerald-100 shadow-[0_0_24px_rgba(16,185,129,.08)] transition hover:bg-emerald-500/30 disabled:cursor-not-allowed disabled:border-zinc-700 disabled:bg-zinc-800 disabled:text-zinc-500 disabled:shadow-none"
              >
                {executing
                  ? "正在提 PR…"
                  : view.canExecute
                    ? `确认提 PR（${view.eligible} 个工程）`
                    : (view.globalBlocker ? "关联信息需先处理" : "没有可提 PR 的提交")}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
