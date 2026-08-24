import React, { useEffect, useState } from "react";
import { createPortal } from "react-dom";

const STOP_UNLOCK_MS = 2000;

export default function StopAiButton({ onConfirm }) {
  const [open, setOpen] = useState(false);
  const [remainingMs, setRemainingMs] = useState(STOP_UNLOCK_MS);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!open) return undefined;
    const deadline = Date.now() + STOP_UNLOCK_MS;
    const tick = () => setRemainingMs(Math.max(0, deadline - Date.now()));
    tick();
    const timer = window.setInterval(tick, 50);
    return () => window.clearInterval(timer);
  }, [open]);

  useEffect(() => {
    if (!open) return undefined;
    const onKeyDown = (event) => {
      if (event.key === "Escape" && !submitting) setOpen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, submitting]);

  const secondsLeft = Math.ceil(remainingMs / 1000);
  const unlocked = remainingMs <= 0;
  const progress = Math.min(100, Math.max(0, 100 - (remainingMs / STOP_UNLOCK_MS) * 100));

  function openConfirm() {
    setRemainingMs(STOP_UNLOCK_MS);
    setOpen(true);
  }

  async function confirmStop() {
    if (!unlocked || submitting) return;
    setSubmitting(true);
    try {
      await onConfirm?.();
    } finally {
      setSubmitting(false);
      setOpen(false);
    }
  }

  const modal = open ? (
    <div className="fixed inset-0 z-[120] flex items-center justify-center bg-black/75 px-4 backdrop-blur-sm" onMouseDown={(event) => { if (event.target === event.currentTarget && !submitting) setOpen(false); }}>
      <div role="alertdialog" aria-modal="true" aria-labelledby="stop-ai-title" aria-describedby="stop-ai-description" className="relative w-full max-w-md overflow-hidden rounded-2xl border border-red-500/30 bg-zinc-950 shadow-[0_24px_80px_rgba(0,0,0,.68)]">
        <div className="absolute inset-x-0 top-0 h-24 bg-gradient-to-b from-red-500/15 to-transparent" />
        <div className="relative p-5">
          <div className="flex items-start gap-3">
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-red-400/30 bg-red-500/15 font-semibold text-red-300">!</div>
            <div>
              <h3 id="stop-ai-title" className="text-sm font-semibold text-zinc-100">确认中断 AI 自动修复？</h3>
              <p id="stop-ai-description" className="mt-1 text-xs leading-5 text-zinc-400">本次任务可能正在同时处理基础工程和 worktree。确认后会停止整批 AI 任务，但不会回滚已经写入的文件或清理 Git 合并现场。</p>
            </div>
          </div>
          <div className="mt-4 rounded-xl border border-amber-500/20 bg-amber-500/10 px-3 py-2.5 text-[11px] leading-5 text-amber-100/80">停止前已经显示的回答会保留；工程可能继续处于待审核或未解决的冲突状态，可稍后重新交给 AI 或手动处理。</div>
          <div className="mt-4 overflow-hidden rounded-full bg-zinc-800"><div className="h-1 bg-gradient-to-r from-red-500 to-amber-400 transition-[width] duration-75" style={{ width: `${progress}%` }} /></div>
          <div className="mt-5 flex justify-end gap-2">
            <button type="button" autoFocus disabled={submitting} onClick={() => setOpen(false)} className="rounded-lg border border-zinc-700 px-3 py-2 text-xs text-zinc-300 transition hover:bg-zinc-800 disabled:opacity-50">取消</button>
            <button type="button" disabled={!unlocked || submitting} onClick={confirmStop} aria-live="polite" className="min-w-[124px] rounded-lg border border-red-400/40 bg-red-600 px-3 py-2 text-xs font-medium text-white transition hover:bg-red-500 disabled:cursor-not-allowed disabled:border-zinc-700 disabled:bg-zinc-800 disabled:text-zinc-500">
              {submitting ? "正在中断…" : unlocked ? "确认中断" : `${secondsLeft} 秒后可确认`}
            </button>
          </div>
        </div>
      </div>
    </div>
  ) : null;

  return (
    <>
      <button type="button" onClick={openConfirm} className="shrink-0 rounded border border-red-500/40 bg-red-600/20 px-2.5 py-1 text-[11px] text-red-300 transition hover:bg-red-600/40" title="中断当前正在运行的 AI 任务">■ 停止</button>
      {typeof document !== "undefined" && modal ? createPortal(modal, document.body) : modal}
    </>
  );
}
