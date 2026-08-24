/** 开发前五维配置推断复核弹窗。 */
import React, { useEffect } from "react";
import ConfigInferenceReview from "./ConfigInferenceReview.jsx";

export default function ConfigSuggestModal({
  session,
  busy = false,
  onSubmit,
  onSkip,
  onClose,
  canPersistConfig = false,
  stacked = false,
  submitLabel = "",
  onContinueMainFlow,
  continueMainFlowDisabled = false,
}) {
  useEffect(() => {
    if (!onClose) return undefined;
    const handleEscape = (event) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation?.();
      onClose();
    };
    window.addEventListener("keydown", handleEscape, true);
    return () => window.removeEventListener("keydown", handleEscape, true);
  }, [busy, onClose]);
  if (!session) return null;
  return (
    <div className={stacked
      ? "pointer-events-none fixed inset-0 z-[160] flex items-stretch justify-end p-3 sm:p-4"
      : "fixed inset-0 z-[80] flex items-start justify-center overflow-y-auto bg-black/65 p-3 backdrop-blur-sm sm:p-6"}>
      <div
        className={stacked
          ? "pointer-events-auto relative h-full w-[min(1180px,calc(100vw-1.5rem))] overflow-y-auto rounded-2xl border border-cyan-500/25 bg-zinc-950/95 pt-12 shadow-[0_28px_100px_rgba(0,0,0,0.82)]"
          : "relative my-auto w-full max-w-[1480px]"}
        onClick={(event) => event.stopPropagation()}
        data-testid={stacked ? "config-inference-nonblocking-panel" : "config-inference-modal"}
      >
        {onClose ? (
          <div className="absolute inset-x-3 top-2 z-10 flex items-center justify-end gap-2">
            {onContinueMainFlow ? (
              <button
                type="button"
                onClick={onContinueMainFlow}
                disabled={continueMainFlowDisabled}
                className="rounded-lg border border-cyan-500/50 bg-cyan-700/90 px-3 py-1.5 text-xs font-medium text-white shadow-lg transition hover:bg-cyan-600 disabled:cursor-not-allowed disabled:border-zinc-700 disabled:bg-zinc-800 disabled:text-zinc-500"
                data-testid="config-inference-continue-main-flow"
              >使用当前配置继续创建</button>
            ) : null}
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg border border-zinc-700 bg-zinc-950/90 px-2.5 py-1.5 text-xs text-zinc-400 shadow-lg transition hover:border-zinc-500 hover:text-white"
              aria-label="返回故事点初始化配置"
              data-testid="config-inference-return-to-initialization"
            >返回初始化配置</button>
          </div>
        ) : null}
        <ConfigInferenceReview
          session={session}
          busy={busy}
          training={false}
          canPersistConfig={canPersistConfig}
          onSubmit={onSubmit}
          onSkip={onSkip}
          submitLabel={submitLabel}
        />
      </div>
    </div>
  );
}
