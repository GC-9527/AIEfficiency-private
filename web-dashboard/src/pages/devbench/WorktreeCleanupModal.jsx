import React, { useCallback, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { devbenchApi } from "./api.js";
import {
  WORKTREE_FORCE_CONFIRMATION,
  WORKTREE_FORCE_UNLOCK_MS,
  worktreeCleanupBlockerHelp,
  worktreeCleanupCanConfirm,
  worktreeCleanupCanForce,
  worktreeCleanupCards,
  worktreeCleanupForceStatus,
} from "./worktreeCleanupModel.mjs";

function CheckCard({ card }) {
  return (
    <div className={`rounded-xl border px-3 py-3 ${
      card.safe
        ? "border-emerald-500/25 bg-emerald-500/[0.07]"
        : "border-red-500/30 bg-red-500/[0.08]"
    }`}>
      <div className="flex items-start gap-2.5">
        <span className={`mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[11px] font-bold ${
          card.safe ? "bg-emerald-500/15 text-emerald-300" : "bg-red-500/15 text-red-300"
        }`}>
          {card.safe ? "✓" : "!"}
        </span>
        <span className="min-w-0">
          <span className="block text-[11px] font-medium text-zinc-200">{card.label}</span>
          <span className={`mt-0.5 block text-[10px] ${card.safe ? "text-emerald-400/80" : "text-red-300"}`}>
            {card.statusText}
          </span>
        </span>
      </div>
      {!card.safe && <p className="mt-2 text-[10px] leading-relaxed text-zinc-500">{card.help}</p>}
    </div>
  );
}

function RepositoryCard({ repository }) {
  const shortHead = String(repository.head || "").slice(0, 12);
  return (
    <div className={`rounded-xl border px-3.5 py-3 ${
      repository.safe
        ? "border-zinc-800 bg-zinc-900/55"
        : "border-red-500/20 bg-red-950/15"
    }`}>
      <div className="flex items-start gap-3">
        <span className={`mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border text-xs ${
          repository.safe
            ? "border-emerald-500/25 bg-emerald-500/10 text-emerald-300"
            : "border-red-500/25 bg-red-500/10 text-red-300"
        }`}>
          {repository.safe ? "✓" : "!"}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="text-[12px] font-medium text-zinc-200">{repository.name || "Git 仓库"}</span>
            <span className={`rounded-full border px-1.5 py-0.5 text-[9px] ${
              repository.exists
                ? "border-zinc-700 bg-zinc-800 text-zinc-400"
                : "border-amber-500/30 bg-amber-500/10 text-amber-300"
            }`}>
              {repository.exists ? "worktree 存在" : "目录已缺失"}
            </span>
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[10px] text-zinc-500">
            <span className="max-w-[360px] truncate" title={repository.branch || "detached HEAD"}>
              {repository.branch || "detached HEAD"}
            </span>
            {shortHead && <span>{shortHead}</span>}
          </div>
          <div className="mt-1 truncate font-mono text-[9px] text-zinc-700" title={repository.path}>
            {repository.path}
          </div>
        </div>
      </div>

      {repository.blockers?.length > 0 && (
        <div className="mt-3 space-y-2 border-t border-red-500/10 pt-2.5">
          {repository.blockers.map((blocker, index) => (
            <div key={`${blocker.type}-${index}`} className="rounded-lg bg-black/20 px-2.5 py-2">
              <div className="text-[10px] font-medium text-red-200">{blocker.message}</div>
              <div className="mt-0.5 text-[9px] text-zinc-500">{worktreeCleanupBlockerHelp(blocker)}</div>
            </div>
          ))}
        </div>
      )}

      {repository.dirtyFiles?.length > 0 && (
        <details className="mt-2 rounded-lg border border-zinc-800/80 bg-black/15 px-2.5 py-1.5">
          <summary className="cursor-pointer text-[10px] text-zinc-500 hover:text-zinc-300">
            查看未提交文件（{repository.dirtyCount}）
          </summary>
          <pre className="mt-2 max-h-28 overflow-auto whitespace-pre-wrap font-mono text-[9px] leading-relaxed text-zinc-500">
            {repository.dirtyFiles.join("\n")}
          </pre>
        </details>
      )}
      {repository.unpushedCommits?.length > 0 && (
        <details className="mt-2 rounded-lg border border-zinc-800/80 bg-black/15 px-2.5 py-1.5">
          <summary className="cursor-pointer text-[10px] text-zinc-500 hover:text-zinc-300">
            查看未推送提交（{repository.unpushedCount}）
          </summary>
          <div className="mt-2 space-y-1">
            {repository.unpushedCommits.map((commit) => (
              <div key={commit.shortRevision} className="flex gap-2 text-[9px] text-zinc-500">
                <span className="font-mono text-amber-300/80">{commit.shortRevision}</span>
                <span className="truncate">{commit.subject || "无提交说明"}</span>
              </div>
            ))}
          </div>
        </details>
      )}
      {repository.stashes?.length > 0 && (
        <details className="mt-2 rounded-lg border border-zinc-800/80 bg-black/15 px-2.5 py-1.5">
          <summary className="cursor-pointer text-[10px] text-zinc-500 hover:text-zinc-300">
            查看未恢复 stash（{repository.stashCount}）
          </summary>
          <div className="mt-2 space-y-1">
            {repository.stashes.map((stash) => (
              <div key={`${stash.ref}-${stash.oid}`} className="text-[9px] text-zinc-500">
                <span className="mr-2 font-mono text-cyan-300/80">{stash.ref}</span>
                <span>{stash.subject}</span>
              </div>
            ))}
          </div>
        </details>
      )}
    </div>
  );
}

export default function WorktreeCleanupModal({
  tab,
  onClose,
  onCleaned,
  onToast,
}) {
  const [inspection, setInspection] = useState(null);
  const [loading, setLoading] = useState(true);
  const [cleaning, setCleaning] = useState(false);
  const [acknowledged, setAcknowledged] = useState(false);
  const [forceMode, setForceMode] = useState(false);
  const [forceAcknowledged, setForceAcknowledged] = useState(false);
  const [forceUnlocked, setForceUnlocked] = useState(false);
  const [forceCountdown, setForceCountdown] = useState(0);
  const [error, setError] = useState("");
  const [done, setDone] = useState(null);
  const cards = useMemo(() => worktreeCleanupCards(inspection), [inspection]);
  const canConfirm = worktreeCleanupCanConfirm(inspection, acknowledged) && !cleaning;
  const canForce = worktreeCleanupCanForce(
    inspection,
    forceAcknowledged,
    forceUnlocked,
  ) && !cleaning;
  const forceStatus = useMemo(() => worktreeCleanupForceStatus(inspection), [inspection]);

  const refresh = useCallback(async () => {
    setLoading(true);
    setInspection(null);
    setError("");
    setAcknowledged(false);
    setForceMode(false);
    setForceAcknowledged(false);
    setForceUnlocked(false);
    setForceCountdown(0);
    try {
      const result = await devbenchApi.inspectWorktreeCleanup(tab.id);
      if (!result?.ok) {
        setError(result?.error || "安全检查失败");
        return;
      }
      setInspection(result.data);
    } finally {
      setLoading(false);
    }
  }, [tab.id]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  useEffect(() => {
    if (!forceMode || cleaning) {
      setForceUnlocked(false);
      setForceCountdown(0);
      return undefined;
    }
    const totalMs = WORKTREE_FORCE_UNLOCK_MS;
    const startedAt = Date.now();
    setForceUnlocked(false);
    setForceCountdown(Math.ceil(totalMs / 1000));
    const timer = setInterval(() => {
      const leftMs = Math.max(0, totalMs - (Date.now() - startedAt));
      setForceCountdown(Math.ceil(leftMs / 1000));
      if (leftMs <= 0) {
        setForceUnlocked(true);
        clearInterval(timer);
      }
    }, 200);
    return () => clearInterval(timer);
  }, [forceMode, cleaning, inspection?.token]);

  useEffect(() => {
    const onKeyDown = (event) => {
      if (event.key === "Escape" && !cleaning) onClose?.();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [cleaning, onClose]);

  async function cleanup({ force = false } = {}) {
    if (force ? !canForce : !canConfirm) return;
    setCleaning(true);
    setError("");
    try {
      const result = await devbenchApi.cleanupWorktree(tab.id, {
        token: inspection.token,
        force,
        confirmation: force ? WORKTREE_FORCE_CONFIRMATION : "",
      });
      if (!result?.ok) {
        if (result?.data?.repositories) setInspection(result.data);
        setAcknowledged(false);
        setForceAcknowledged(false);
        setForceUnlocked(false);
        if (!force) setForceMode(true);
        setError(result?.error || "清理被阻止，请处理风险后重新检查");
        if (result?.partial) await onCleaned?.();
        return;
      }
      setDone(result.data);
      await onCleaned?.();
      onToast?.(force
        ? "worktree 已强制删除，未提交内容已丢弃，Git 分支仍然保留"
        : "worktree 已安全清理，开发分支仍然保留");
    } finally {
      setCleaning(false);
    }
  }

  const modal = (
    <div
      className="fixed inset-0 z-[146] flex items-center justify-center bg-black/75 p-4 backdrop-blur-md"
      role="dialog"
      aria-modal="true"
      aria-labelledby="worktree-cleanup-title"
      data-testid="worktree-cleanup-modal"
      onClick={(event) => {
        event.stopPropagation();
        if (event.target === event.currentTarget && !cleaning) onClose?.();
      }}
    >
      <div
        className="relative flex max-h-[90vh] w-[700px] max-w-[96vw] flex-col overflow-hidden rounded-2xl border border-amber-400/20 bg-zinc-950 shadow-[0_36px_120px_rgba(0,0,0,0.82)]"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="pointer-events-none absolute -left-20 -top-24 h-60 w-60 rounded-full bg-amber-500/10 blur-[80px]" />
        <div className="pointer-events-none absolute -right-20 top-16 h-52 w-52 rounded-full bg-red-500/[0.07] blur-[80px]" />

        <div className="relative shrink-0 border-b border-zinc-800 px-6 py-5">
          <div className="flex items-start gap-4">
            <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-amber-400/25 bg-gradient-to-br from-amber-500/20 to-red-500/10 text-lg text-amber-200">
              ◇
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <h2 id="worktree-cleanup-title" className="text-base font-semibold text-zinc-50">
                  安全清理 worktree
                </h2>
                <span className="rounded-full border border-amber-400/25 bg-amber-500/10 px-2 py-0.5 text-[9px] uppercase tracking-[0.12em] text-amber-200">
                  Safety Gate
                </span>
              </div>
              <p className="mt-1 text-[11px] leading-relaxed text-zinc-400">
                默认先安全检查再清理；确需放弃本地内容时，可在明确确认风险后强制删除。Git 分支不会被删除。
              </p>
            </div>
            <button
              type="button"
              onClick={onClose}
              disabled={cleaning}
              className="rounded-lg px-2 py-1 text-sm text-zinc-500 transition hover:bg-zinc-800 hover:text-zinc-100 disabled:opacity-40"
              aria-label="关闭"
            >
              ✕
            </button>
          </div>
        </div>

        <div className="relative flex-1 overflow-y-auto px-6 py-5">
          {done ? (
            <div className="flex min-h-[330px] flex-col items-center justify-center text-center" data-testid="worktree-cleanup-success">
              <div className="flex h-16 w-16 items-center justify-center rounded-full border border-emerald-400/30 bg-emerald-500/10 text-2xl text-emerald-300">✓</div>
              <h3 className="mt-4 text-lg font-semibold text-zinc-100">
                {done.forced ? "worktree 已强制删除" : "worktree 已安全清理"}
              </h3>
              <p className="mt-2 max-w-[460px] text-[11px] leading-relaxed text-zinc-400">
                已释放 {done.removed?.length || 0} 个工作目录；
                {done.forced ? "未提交文件已被丢弃，" : ""}
                开发分支和提交仍保留在 Git 仓库中。需要继续开发时可在工程操作区一键重新创建。
              </p>
              <button
                type="button"
                onClick={onClose}
                className="mt-6 rounded-xl bg-emerald-600 px-5 py-2 text-[12px] font-medium text-white transition hover:bg-emerald-500"
              >
                完成
              </button>
            </div>
          ) : loading ? (
            <div className="flex min-h-[360px] flex-col items-center justify-center" data-testid="worktree-cleanup-loading">
              <div className="h-9 w-9 animate-spin rounded-full border-2 border-zinc-700 border-t-amber-300" />
              <div className="mt-4 text-[12px] text-zinc-300">正在核对 Git 安全状态…</div>
              <div className="mt-1 text-[10px] text-zinc-600">dirty · 未推送提交 · 未恢复 stash</div>
            </div>
          ) : (
            <div className="space-y-4">
              <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-3">
                {cards.map((card) => <CheckCard key={card.key} card={card} />)}
              </div>

              {inspection?.totals?.inspectionErrors > 0 && (
                <div className="rounded-xl border border-red-500/30 bg-red-500/[0.08] px-3.5 py-3 text-[11px] text-red-200">
                  Git 状态未能完整核对。为避免误删，系统已按风险状态阻止清理。
                </div>
              )}

              <div className="space-y-2">
                {(inspection?.repositories || []).map((repository) => (
                  <RepositoryCard key={repository.path} repository={repository} />
                ))}
              </div>

              {inspection?.safe ? (
                <label className="flex cursor-pointer items-start gap-3 rounded-xl border border-amber-400/25 bg-amber-500/[0.07] px-3.5 py-3">
                  <input
                    type="checkbox"
                    checked={acknowledged}
                    onChange={(event) => setAcknowledged(event.target.checked)}
                    className="mt-0.5 h-4 w-4 accent-amber-500"
                    data-testid="worktree-cleanup-ack"
                  />
                  <span>
                    <span className="block text-[11px] font-medium text-amber-100">
                      我已确认清理当前故事点的 worktree 工作目录
                    </span>
                    <span className="mt-0.5 block text-[10px] leading-relaxed text-zinc-500">
                      分支和提交不会删除；清理完成后当前故事点将暂停本地开发，直到重新创建 worktree。
                    </span>
                  </span>
                </label>
              ) : (
                <div className="rounded-xl border border-zinc-800 bg-zinc-900/55 px-3.5 py-3">
                  <div className="text-[11px] font-medium text-zinc-200">安全清理暂不可用</div>
                  <div className="mt-1 text-[10px] leading-relaxed text-zinc-500">
                    建议先逐项处理上方风险，再点击“重新检查”。如果这些内容确认不再需要，可进入强制删除。
                  </div>
                </div>
              )}

              {forceStatus.kind === "gateway_capability_missing" ? (
                <div
                  className="rounded-xl border border-amber-500/30 bg-amber-500/[0.07] px-3.5 py-3"
                  data-testid="worktree-force-gateway-restart"
                >
                  <div className="text-[11px] font-medium text-amber-200">Gateway 尚未加载强制删除能力</div>
                  <div className="mt-1 text-[10px] leading-relaxed text-zinc-500">
                    当前页面已支持强制删除，但运行中的 Gateway 仍未返回该能力标记。请重启 Gateway、刷新页面后重新检查。
                    在此之前系统会安全禁用强制删除；这不表示当前存在 AI 任务或 Git 归属错误。
                  </div>
                </div>
              ) : forceStatus.kind === "blocked" ? (
                <div className="rounded-xl border border-red-500/25 bg-red-500/[0.06] px-3.5 py-3" data-testid="worktree-force-blocked">
                  <div className="text-[11px] font-medium text-red-200">强制删除也不可用</div>
                  {forceStatus.blockers.length > 0 ? (
                    <div className="mt-2 space-y-2">
                      {forceStatus.blockers.map((blocker, index) => (
                        <div key={`${blocker?.type || "blocker"}-${index}`} className="rounded-lg bg-black/20 px-2.5 py-2">
                          <div className="text-[10px] font-medium text-red-200">
                            {blocker?.message || "后端拒绝强制删除"}
                          </div>
                          <div className="mt-0.5 text-[9px] text-zinc-500">{worktreeCleanupBlockerHelp(blocker)}</div>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="mt-1 text-[10px] leading-relaxed text-zinc-500">
                      后端已明确禁止强制删除，但未返回具体原因。请刷新检查；若仍未恢复，请查看 Gateway 日志。
                    </div>
                  )}
                </div>
              ) : forceMode ? (
                <div className="overflow-hidden rounded-2xl border devbench-status-surface devbench-status-surface--danger" data-testid="worktree-force-panel">
                  <div className="border-b border-red-500/20 px-4 py-3.5">
                    <div className="flex items-center gap-2">
                      <span className="flex h-7 w-7 items-center justify-center rounded-lg border border-red-400/30 bg-red-500/15 text-sm text-red-200">!</span>
                      <span>
                        <span className="block text-[12px] font-semibold text-red-100">强制删除会永久丢弃未提交内容</span>
                        <span className="mt-0.5 block text-[10px] leading-relaxed text-zinc-400">
                          将对 {inspection?.totals?.repositories || 0} 个受管 worktree 执行 Git 强制删除；未提交文件无法恢复，未推送提交和 stash 仍保留在 Git 仓库中。
                        </span>
                      </span>
                    </div>
                  </div>
                  <div className="space-y-3 px-4 py-3.5">
                    <label className="flex cursor-pointer items-start gap-3 rounded-xl border border-red-500/20 bg-black/20 px-3 py-2.5">
                      <input
                        type="checkbox"
                        checked={forceAcknowledged}
                        onChange={(event) => setForceAcknowledged(event.target.checked)}
                        className="mt-0.5 h-4 w-4 accent-red-500"
                        data-testid="worktree-force-ack"
                      />
                      <span className="text-[10px] leading-relaxed text-zinc-300">
                        我已确认不再需要这些 worktree 中的未提交文件，并理解强制删除不可撤销。
                      </span>
                    </label>
                    <div
                      className="rounded-xl border border-red-500/15 bg-black/15 px-3 py-2.5 text-[10px] leading-relaxed text-zinc-400"
                      data-testid="worktree-force-delay-hint"
                    >
                      {forceUnlocked
                        ? "已等待完成，可点击下方「强制删除」按钮。"
                        : `为避免误点，确认按钮将在 ${forceCountdown || Math.ceil(WORKTREE_FORCE_UNLOCK_MS / 1000)} 秒后可用。`}
                    </div>
                  </div>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => {
                    setForceMode(true);
                    setAcknowledged(false);
                    setError("");
                  }}
                  className="flex w-full items-center justify-between rounded-xl border border-red-500/20 bg-red-500/[0.04] px-3.5 py-2.5 text-left transition hover:border-red-500/35 hover:bg-red-500/[0.08]"
                  data-testid="worktree-force-open"
                >
                  <span>
                    <span className="block text-[11px] font-medium text-red-200">确实不需要本地内容？</span>
                    <span className="mt-0.5 block text-[9px] text-zinc-600">进入高风险强制删除，需要二次确认</span>
                  </span>
                  <span className="text-sm text-red-300">›</span>
                </button>
              )}

              {error && (
                <div role="alert" className="rounded-xl border border-red-500/35 bg-red-500/10 px-3.5 py-2.5 text-[11px] text-red-200">
                  {error}
                </div>
              )}
            </div>
          )}
        </div>

        {!done && !loading && (
          <div className="relative flex shrink-0 items-center justify-between gap-3 border-t border-zinc-800 px-6 py-4">
            <span className="text-[10px] text-zinc-600">
              检查时间 {inspection?.inspectedAt ? new Date(inspection.inspectedAt).toLocaleTimeString() : "—"}
            </span>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={refresh}
                disabled={cleaning}
                className="rounded-xl border border-zinc-700 bg-zinc-900 px-3.5 py-2 text-[11px] text-zinc-300 transition hover:border-zinc-500 hover:text-white disabled:opacity-40"
              >
                重新检查
              </button>
              {forceMode ? (
                <>
                  <button
                    type="button"
                    onClick={() => {
                      setForceMode(false);
                      setForceAcknowledged(false);
                      setForceUnlocked(false);
                      setForceCountdown(0);
                    }}
                    disabled={cleaning}
                    className="rounded-xl border border-zinc-700 px-3.5 py-2 text-[11px] text-zinc-400 transition hover:bg-zinc-800 hover:text-zinc-100 disabled:opacity-40"
                  >
                    返回安全清理
                  </button>
                  <button
                    type="button"
                    onClick={() => cleanup({ force: true })}
                    disabled={!canForce}
                    className="rounded-xl bg-gradient-to-r from-red-600 to-rose-600 px-4 py-2 text-[11px] font-semibold text-white shadow-lg shadow-red-950/35 transition hover:from-red-500 hover:to-rose-500 disabled:cursor-not-allowed disabled:from-zinc-800 disabled:to-zinc-800 disabled:text-zinc-600 disabled:shadow-none"
                    data-testid="worktree-force-confirm"
                  >
                    {cleaning
                      ? "正在强制删除…"
                      : forceUnlocked
                        ? `强制删除 ${inspection?.totals?.repositories || 0} 个 worktree`
                        : `请等待 ${forceCountdown || Math.ceil(WORKTREE_FORCE_UNLOCK_MS / 1000)} 秒…`}
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  onClick={() => cleanup()}
                  disabled={!canConfirm}
                  className="rounded-xl bg-gradient-to-r from-amber-500 to-red-500 px-4 py-2 text-[11px] font-semibold text-zinc-950 shadow-lg shadow-red-950/30 transition hover:from-amber-400 hover:to-red-400 disabled:cursor-not-allowed disabled:from-zinc-800 disabled:to-zinc-800 disabled:text-zinc-600 disabled:shadow-none"
                  data-testid="worktree-cleanup-confirm"
                >
                  {cleaning ? "正在安全清理…" : `安全清理 ${inspection?.totals?.repositories || 0} 个 worktree`}
                </button>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );

  return typeof document !== "undefined" ? createPortal(modal, document.body) : modal;
}
