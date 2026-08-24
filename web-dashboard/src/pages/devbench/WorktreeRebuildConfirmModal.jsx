import React, { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import {
  WORKTREE_FORCE_CONFIRMATION,
  WORKTREE_FORCE_UNLOCK_MS,
  buildWorktreeRebuildConfirmBody,
  worktreeRebuildCanForceConfirm,
  worktreeRebuildCanSafeConfirm,
  worktreeRebuildDeleteRows,
  worktreeRebuildForceStatus,
  worktreeRebuildInspectionCards,
  worktreeRebuildReasonLabels,
} from "./worktreeRebuildModel.mjs";
import { worktreeCleanupBlockerHelp } from "./worktreeCleanupModel.mjs";

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

/**
 * 配置变更（主工程 / Flavor / TB）导致需删除旧 worktree 并重建时的确认面板。
 * pending: { title?, error?, preview, inspection, retry(body) }
 */
export default function WorktreeRebuildConfirmModal({
  pending,
  onClose,
  onDone,
  onToast,
}) {
  const preview = pending?.preview || null;
  const inspection = pending?.inspection || null;
  const [acknowledged, setAcknowledged] = useState(false);
  const [forceMode, setForceMode] = useState(false);
  const [forceAcknowledged, setForceAcknowledged] = useState(false);
  const [forceUnlocked, setForceUnlocked] = useState(false);
  const [forceCountdown, setForceCountdown] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(pending?.error || "");

  const reasons = useMemo(() => worktreeRebuildReasonLabels(preview), [preview]);
  const deleteRows = useMemo(() => worktreeRebuildDeleteRows(preview), [preview]);
  const cards = useMemo(() => worktreeRebuildInspectionCards(inspection), [inspection]);
  const forceStatus = useMemo(() => worktreeRebuildForceStatus(inspection), [inspection]);
  const canSafe = worktreeRebuildCanSafeConfirm(inspection, acknowledged) && !busy;
  const canForce = worktreeRebuildCanForceConfirm(inspection, forceAcknowledged, forceUnlocked) && !busy;

  useEffect(() => {
    setAcknowledged(false);
    setForceMode(false);
    setForceAcknowledged(false);
    setForceUnlocked(false);
    setForceCountdown(0);
    setError(pending?.error || "");
  }, [pending]);

  useEffect(() => {
    if (!forceMode || busy) {
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
  }, [forceMode, busy, inspection?.token]);

  async function submit(force) {
    if (!pending?.retry) return;
    setBusy(true);
    setError("");
    try {
      const body = buildWorktreeRebuildConfirmBody(pending.body || {}, {
        token: inspection?.token,
        force,
        confirmation: WORKTREE_FORCE_CONFIRMATION,
      });
      const result = await pending.retry(body);
      if (!result?.ok) {
        setError(result?.error || "重建失败");
        if (result?.data?.inspection) {
          // 调用方若刷新了 inspection，优先展示错误
        }
        return;
      }
      onToast?.(result.rebuilt ? "已删除旧 worktree 与 story/ 分支，并按新配置重建" : "配置已更新");
      onDone?.(result);
      onClose?.();
    } catch (submitError) {
      setError(submitError?.message || "重建失败");
    } finally {
      setBusy(false);
    }
  }

  if (!pending || !preview) return null;

  return createPortal((
    <div
      className="fixed inset-0 z-[150] flex items-center justify-center bg-black/75 p-4 backdrop-blur-md"
      role="dialog"
      aria-modal="true"
      aria-labelledby="worktree-rebuild-title"
      data-testid="worktree-rebuild-confirm-modal"
      onClick={(event) => {
        if (event.target === event.currentTarget && !busy) onClose?.();
      }}
    >
      <div
        className="relative flex max-h-[92vh] w-[720px] max-w-[96vw] flex-col overflow-hidden rounded-2xl border border-amber-500/25 bg-zinc-950 shadow-[0_36px_120px_rgba(0,0,0,0.8)]"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="shrink-0 border-b border-zinc-800 px-5 py-4">
          <div className="flex items-start gap-3">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-amber-400/30 bg-amber-500/15 text-amber-200">
              ⚠
            </div>
            <div className="min-w-0 flex-1">
              <h2 id="worktree-rebuild-title" className="text-[15px] font-semibold text-zinc-50">
                {pending.title || "确认删除旧 worktree 并重建"}
              </h2>
              <p className="mt-1 text-[11px] leading-relaxed text-zinc-500">
                更新主工程 / Flavor / TB 单号后，需删除当前故事点下的旧 worktree 与对应 story/ 分支，再按新规则生成目录与分支名。
                若有未提交改动或未推送提交，需先处理或强制确认。
              </p>
            </div>
            <button
              type="button"
              disabled={busy}
              onClick={onClose}
              className="rounded-lg px-2 py-1 text-sm text-zinc-500 transition hover:bg-zinc-800 hover:text-zinc-100 disabled:opacity-40"
              aria-label="关闭"
            >✕</button>
          </div>
        </header>

        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-5 py-4">
          {reasons.length > 0 && (
            <section>
              <div className="mb-2 text-[10px] font-medium uppercase tracking-[0.12em] text-zinc-500">变更原因</div>
              <ul className="space-y-1.5">
                {reasons.map((label) => (
                  <li key={label} className="rounded-lg border border-amber-500/20 bg-amber-500/[0.06] px-3 py-2 text-[11px] text-amber-100">
                    {label}
                  </li>
                ))}
              </ul>
            </section>
          )}

          <section className="grid gap-3 sm:grid-cols-2">
            <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 px-3.5 py-3">
              <div className="text-[10px] uppercase tracking-[0.1em] text-zinc-500">即将删除（目录 + story/ 分支）</div>
              <div className="mt-2 max-h-40 space-y-2 overflow-y-auto">
                {deleteRows.length ? deleteRows.map((row) => (
                  <div key={row.path} className="rounded-lg border border-zinc-800/80 bg-black/20 px-2.5 py-2">
                    <div className="truncate text-[11px] text-zinc-200">{row.title}</div>
                    <div className="mt-0.5 truncate font-mono text-[9px] text-zinc-500">{row.branch || "detached"}</div>
                    <div className="mt-0.5 truncate font-mono text-[9px] text-zinc-700" title={row.path}>{row.path}</div>
                  </div>
                )) : (
                  <div className="text-[10px] text-zinc-600">没有可删除的 worktree</div>
                )}
              </div>
            </div>
            <div className="rounded-xl border border-cyan-500/20 bg-cyan-500/[0.05] px-3.5 py-3">
              <div className="text-[10px] uppercase tracking-[0.1em] text-cyan-300/80">重建后预估</div>
              <div className="mt-3 space-y-2 text-[11px]">
                <div>
                  <div className="text-zinc-500">目录名</div>
                  <div className="mt-0.5 break-all font-mono text-cyan-100">{preview.expectedDirectoryName || "—"}</div>
                </div>
                <div>
                  <div className="text-zinc-500">分支名</div>
                  <div className="mt-0.5 break-all font-mono text-cyan-100">{preview.expectedBranchName || "—"}</div>
                </div>
              </div>
            </div>
          </section>

          <section>
            <div className="mb-2 text-[10px] font-medium uppercase tracking-[0.12em] text-zinc-500">删除前安全检查</div>
            <div className="grid gap-2 sm:grid-cols-3">
              {cards.map((card) => <CheckCard key={card.key} card={card} />)}
            </div>
            {(inspection?.blockers || []).length > 0 && (
              <div className="mt-3 space-y-2">
                {inspection.blockers.map((blocker, index) => (
                  <div key={`${blocker.type}-${index}`} className="rounded-lg border border-red-500/20 bg-red-950/20 px-3 py-2">
                    <div className="text-[10px] font-medium text-red-200">{blocker.message}</div>
                    <div className="mt-0.5 text-[9px] text-zinc-500">{worktreeCleanupBlockerHelp(blocker)}</div>
                  </div>
                ))}
              </div>
            )}
          </section>

          {inspection?.safe ? (
            <label className="flex items-start gap-2 rounded-xl border border-zinc-800 bg-zinc-900/40 px-3 py-2.5 text-[11px] text-zinc-300">
              <input
                type="checkbox"
                className="mt-0.5"
                checked={acknowledged}
                disabled={busy}
                onChange={(event) => setAcknowledged(event.target.checked)}
              />
              <span>我已确认将删除以上旧 worktree 与 story/ 分支，并按新配置重建（本地未推送内容请事先处理好）。</span>
            </label>
          ) : (
            <div className="space-y-3 rounded-xl border border-red-500/25 bg-red-950/20 px-3 py-3">
              <p className="text-[11px] leading-relaxed text-red-200">
                当前 worktree 无法安全删除。可先处理本地改动 / 未推送提交 / stash，或启用强制删除（会丢失未保存内容，并删除对应 story/ 分支）。
              </p>
              {!forceMode ? (
                <button
                  type="button"
                  disabled={busy || forceStatus.blocked}
                  onClick={() => setForceMode(true)}
                  className="rounded-lg border border-red-500/40 px-3 py-1.5 text-[11px] text-red-200 transition hover:bg-red-900/40 disabled:opacity-40"
                >
                  启用强制删除
                </button>
              ) : (
                <div className="space-y-2">
                  <label className="flex items-start gap-2 text-[11px] text-zinc-300">
                    <input
                      type="checkbox"
                      className="mt-0.5"
                      checked={forceAcknowledged}
                      disabled={busy}
                      onChange={(event) => setForceAcknowledged(event.target.checked)}
                      data-testid="worktree-rebuild-force-ack"
                    />
                    <span>我理解强制删除可能丢失未提交改动与未推送提交。</span>
                  </label>
                  <div
                    className="rounded-lg border border-red-500/20 bg-black/20 px-3 py-2 text-[10px] text-zinc-400"
                    data-testid="worktree-rebuild-force-delay-hint"
                  >
                    {forceUnlocked
                      ? "已等待完成，可点击「强制删除并重建」。"
                      : `为避免误点，确认按钮将在 ${forceCountdown || Math.ceil(WORKTREE_FORCE_UNLOCK_MS / 1000)} 秒后可用。`}
                  </div>
                </div>
              )}
            </div>
          )}

          {error && (
            <div role="alert" className="rounded-xl border border-red-500/30 bg-red-500/[0.08] px-3 py-2 text-[11px] text-red-200">
              {error}
            </div>
          )}
        </div>

        <footer className="flex shrink-0 items-center justify-end gap-2 border-t border-zinc-800 bg-zinc-900/40 px-5 py-3.5">
          <button
            type="button"
            disabled={busy}
            onClick={onClose}
            className="rounded-lg px-3 py-2 text-xs text-zinc-400 transition hover:bg-zinc-800 hover:text-zinc-100 disabled:opacity-40"
          >
            取消
          </button>
          {inspection?.safe ? (
            <button
              type="button"
              disabled={!canSafe}
              onClick={() => submit(false)}
              className="rounded-lg border border-amber-400/30 bg-gradient-to-r from-amber-600 to-orange-600 px-4 py-2 text-xs font-medium text-white transition hover:from-amber-500 hover:to-orange-500 disabled:cursor-not-allowed disabled:border-zinc-700 disabled:from-zinc-800 disabled:to-zinc-800 disabled:text-zinc-500"
              data-testid="worktree-rebuild-confirm"
            >
              {busy ? "正在删除并重建…" : "确认删除并重建"}
            </button>
          ) : (
            <button
              type="button"
              disabled={!canForce}
              onClick={() => submit(true)}
              className="rounded-lg border border-red-400/40 bg-red-700 px-4 py-2 text-xs font-medium text-white transition hover:bg-red-600 disabled:cursor-not-allowed disabled:border-zinc-700 disabled:bg-zinc-800 disabled:text-zinc-500"
              data-testid="worktree-rebuild-force-confirm"
            >
              {busy
                ? "正在强制删除并重建…"
                : !forceMode
                  ? "请先启用强制删除"
                  : !forceAcknowledged
                    ? "请先勾选风险确认"
                    : forceUnlocked
                      ? "强制删除并重建"
                      : `请等待 ${forceCountdown || Math.ceil(WORKTREE_FORCE_UNLOCK_MS / 1000)} 秒…`}
            </button>
          )}
        </footer>
      </div>
    </div>
  ), document.body);
}
