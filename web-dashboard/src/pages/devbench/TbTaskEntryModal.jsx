import React, { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { parseTbTaskInput } from "./tbTaskEntryModel.mjs";

export default function TbTaskEntryModal({ mode = "story", onClose, onSubmit, embedded = false, onBusyChange }) {
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const inputRef = useRef(null);
  const isStory = mode === "story";
  const parsed = parseTbTaskInput(value);

  useEffect(() => {
    onBusyChange?.(busy);
    return () => onBusyChange?.(false);
  }, [busy, onBusyChange]);

  useEffect(() => {
    inputRef.current?.focus();
    if (embedded) return undefined;
    const onKeyDown = (event) => {
      if (event.key === "Escape" && !busy) onClose?.();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [busy, onClose, embedded]);

  async function submit(event) {
    event?.preventDefault?.();
    const current = parseTbTaskInput(value);
    if (!current.ok) {
      setError(current.error);
      return;
    }
    setBusy(true);
    setError("");
    try {
      const result = await onSubmit?.(current.normalized);
      if (result === false || result?.ok === false) {
        setError(result?.error || "读取 TB 单失败，请检查单号、登录状态或网络后重试");
        return;
      }
      onClose?.();
    } catch (submitError) {
      setError(submitError?.message || "读取 TB 单失败，请稍后重试");
    } finally {
      setBusy(false);
    }
  }

  const form = (
      <form
        onSubmit={submit}
        className={embedded
          ? "overflow-hidden"
          : "w-[520px] max-w-[94vw] overflow-hidden rounded-2xl border border-cyan-500/25 bg-zinc-950 shadow-[0_30px_90px_rgba(0,0,0,0.65)]"}
        onClick={(event) => event.stopPropagation()}
        data-testid={embedded ? `tb-task-entry-embedded-${mode}` : undefined}
      >
        <div className="relative overflow-hidden border-b border-zinc-800 px-5 pb-4 pt-5">
          {!embedded && (
            <>
              <div className="pointer-events-none absolute -right-16 -top-20 h-44 w-44 rounded-full bg-cyan-500/15 blur-3xl" />
              <div className="pointer-events-none absolute -left-12 top-8 h-32 w-32 rounded-full bg-violet-500/10 blur-3xl" />
            </>
          )}
          <div className="relative flex items-start gap-3">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-cyan-400/30 bg-gradient-to-br from-cyan-500/20 to-blue-600/20 text-lg text-cyan-200 shadow-inner">
              ↗
            </div>
            <div className="min-w-0 flex-1">
              <h2 id="tb-task-entry-title" className="text-[15px] font-semibold text-zinc-50">
                {isStory ? "从 TB 单新建故事点" : "从 TB 单新增待办"}
              </h2>
              <p className="mt-1 text-[12px] leading-relaxed text-zinc-400">
                {isStory
                  ? "读取工单标题与项目上下文，创建并关联故事点；不会自动启动开发。"
                  : "读取工单标题与迭代信息，直接加入当前待办列表。"}
              </p>
            </div>
            {!embedded && (
              <button
                type="button"
                onClick={onClose}
                disabled={busy}
                className="rounded-lg px-2 py-1 text-sm text-zinc-500 transition hover:bg-zinc-800 hover:text-zinc-200 disabled:opacity-40"
                aria-label="关闭"
              >
                ✕
              </button>
            )}
          </div>
        </div>

        <div className="space-y-4 px-5 py-5">
          <div>
            <label htmlFor={`tb-task-entry-input-${mode}${embedded ? "-embedded" : ""}`} className="mb-2 block text-[11px] font-medium uppercase tracking-[0.12em] text-zinc-500">
              TB 单号或任务链接
            </label>
            <div className={`flex items-center gap-2 rounded-xl border bg-zinc-900/80 px-3 transition ${
              error ? "border-red-500/60 ring-2 ring-red-500/10" : "border-zinc-700 focus-within:border-cyan-500/70 focus-within:ring-2 focus-within:ring-cyan-500/10"
            }`}>
              <span className="shrink-0 text-sm text-zinc-500">TB</span>
              <input
                id={`tb-task-entry-input-${mode}${embedded ? "-embedded" : ""}`}
                ref={inputRef}
                value={value}
                onChange={(event) => {
                  setValue(event.target.value);
                  if (error) setError("");
                }}
                disabled={busy}
                autoComplete="off"
                spellCheck="false"
                placeholder="例如 CARB-13542，或粘贴 Teambition 任务链接"
                className="min-w-0 flex-1 bg-transparent py-3 text-sm text-zinc-100 outline-none focus-visible:outline-none placeholder:text-zinc-600 disabled:opacity-60"
                data-testid="tb-task-entry-input"
              />
              {value && (
                <button
                  type="button"
                  onClick={() => {
                    setValue("");
                    setError("");
                    inputRef.current?.focus();
                  }}
                  disabled={busy}
                  className="shrink-0 rounded px-1.5 py-0.5 text-[11px] text-zinc-600 transition hover:bg-zinc-800 hover:text-zinc-300"
                >
                  清空
                </button>
              )}
            </div>
            <div className="mt-2 min-h-5 text-[11px]">
              {error ? (
                <span className="text-red-300" role="alert">⚠ {error}</span>
              ) : value && parsed.ok ? (
                <span className="text-emerald-400">✓ 已识别：{parsed.preview}</span>
              ) : (
                <span className="text-zinc-600">支持 CARB-12345、12345、https://www.teambition.com/task/…</span>
              )}
            </div>
          </div>

          <div className="grid grid-cols-2 gap-2 text-[11px] text-zinc-500">
            <div className="rounded-lg border border-zinc-800 bg-zinc-900/45 px-3 py-2">
              <span className="text-zinc-300">自动读取</span><br />标题、项目、任务列表
            </div>
            <div className="rounded-lg border border-zinc-800 bg-zinc-900/45 px-3 py-2">
              <span className="text-zinc-300">{isStory ? "自动关联" : "直接加入"}</span><br />
              {isStory ? "TB 链接与推理上下文" : "当前待办与所选任务组"}
            </div>
          </div>
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-zinc-800 bg-zinc-900/40 px-5 py-3.5">
          {!embedded && (
            <button
              type="button"
              onClick={onClose}
              disabled={busy}
              className="rounded-lg px-3 py-2 text-xs text-zinc-400 transition hover:bg-zinc-800 hover:text-zinc-100 disabled:opacity-40"
            >
              取消
            </button>
          )}
          <button
            type="submit"
            disabled={busy || !parsed.ok}
            className="min-w-28 rounded-lg border border-cyan-400/30 bg-gradient-to-r from-cyan-600 to-blue-600 px-4 py-2 text-xs font-medium text-white shadow-lg shadow-cyan-950/30 transition hover:from-cyan-500 hover:to-blue-500 disabled:cursor-not-allowed disabled:border-zinc-700 disabled:from-zinc-800 disabled:to-zinc-800 disabled:text-zinc-500 disabled:shadow-none"
            data-testid="tb-task-entry-submit"
          >
            {busy ? "正在读取 TB 单…" : (isStory ? "创建故事点" : "加入待办")}
          </button>
        </div>
      </form>
  );

  if (embedded) return form;

  return createPortal((
    <div
      className="fixed inset-0 z-[140] flex items-center justify-center bg-black/70 backdrop-blur-sm p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="tb-task-entry-title"
      data-testid={`tb-task-entry-modal-${mode}`}
      onClick={(event) => {
        event.stopPropagation();
        if (event.target === event.currentTarget && !busy) onClose?.();
      }}
    >
      {form}
    </div>
  ), document.body);
}
