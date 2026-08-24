import React from "react";
import { ATLAS_CLIENT_TARGETS, atlasActionDisabled } from "./atlasSetupModel.mjs";

const BUTTON_TONES = {
  codex: "border-emerald-700/60 bg-emerald-950/40 text-emerald-200 hover:border-emerald-500/70 hover:bg-emerald-900/40",
  claude: "border-sky-700/60 bg-sky-950/40 text-sky-200 hover:border-sky-500/70 hover:bg-sky-900/40",
  opencode: "border-amber-700/60 bg-amber-950/40 text-amber-200 hover:border-amber-500/70 hover:bg-amber-900/40",
  hermes: "border-violet-700/60 bg-violet-950/40 text-violet-200 hover:border-violet-500/70 hover:bg-violet-900/40",
};

export default function AtlasClientSetupPanel({
  engineConfig = {},
  isAdmin = false,
  adminLoading = false,
  actionState = {},
  onApply,
}) {
  return (
    <div className="col-span-1 mt-1 min-w-0 rounded-xl border border-indigo-800/40 bg-zinc-950/50 p-2 shadow-inner shadow-indigo-950/20 sm:col-span-2 sm:p-3">
      <div className="flex flex-col items-start justify-between gap-2 sm:flex-row sm:flex-wrap">
        <div className="min-w-0 w-full sm:w-auto">
          <div className="text-xs font-medium text-zinc-200"><span className="sm:hidden">一键配置</span><span className="hidden sm:inline">一键设置到 AI 工具</span></div>
          <p className="mt-0.5 hidden text-[10px] leading-relaxed text-zinc-500 sm:block">
            每个工具独立执行，写入前会确认并备份原配置；某个工具失败不会影响其它工具。Hermes 未安装时会显示官方安装指引。
          </p>
        </div>
        <span className={`rounded-full px-2 py-0.5 text-[10px] ${isAdmin ? "bg-emerald-500/15 text-emerald-300" : "bg-amber-500/15 text-amber-300"}`}>
          <span className="sm:hidden">{isAdmin ? "管理员" : adminLoading ? "验证中" : "需权限"}</span>
          <span className="hidden sm:inline">{isAdmin ? "管理员已验证" : adminLoading ? "正在验证管理员" : "需管理员权限"}</span>
        </span>
      </div>
      <div className="mt-3 grid min-w-0 grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-4">
        {ATLAS_CLIENT_TARGETS.map((target) => {
          const state = actionState[target.id] || {};
          const disabled = atlasActionDisabled({
            isAdmin,
            loading: state.loading,
            apiKey: engineConfig.apiKey,
            baseUrl: engineConfig.baseUrl,
            model: engineConfig.model,
          });
          return (
            <div key={target.id} className="min-w-0 rounded-lg border border-zinc-800/80 bg-zinc-900/40 p-1 sm:p-2">
              <button
                type="button"
                disabled={disabled}
                aria-busy={state.loading || undefined}
                aria-label={`一键设置到 ${target.label}`}
                onClick={() => onApply?.(target.id, engineConfig)}
                className={`w-full rounded-md border px-1 py-1.5 text-[10px] font-medium leading-tight transition-colors disabled:cursor-not-allowed disabled:opacity-40 sm:px-2.5 sm:text-[11px] ${BUTTON_TONES[target.id]}`}
              >
                {state.loading ? "设置中…" : <><span className="sm:hidden">{target.label}</span><span className="hidden sm:inline">一键设置到 {target.label}</span></>}
              </button>
              {state.text && (
                <p role="status" className={`mt-1.5 break-words text-[10px] leading-relaxed ${state.ok ? "text-emerald-400" : "text-rose-400"}`}>
                  {state.text}
                </p>
              )}
              {state.installGuide && (
                <div className="mt-1.5 min-w-0 space-y-1 text-[10px] text-zinc-500">
                  {state.installGuide.url && (
                    <a href={state.installGuide.url} target="_blank" rel="noreferrer" className="text-violet-300 underline decoration-violet-700 underline-offset-2 hover:text-violet-200">
                      打开 Hermes 安装说明
                    </a>
                  )}
                  {state.installGuide.command && (
                    <code className="block break-all rounded bg-zinc-950 px-1.5 py-1 text-zinc-400">{state.installGuide.command}</code>
                  )}
                </div>
              )}
              {(state.paths?.length > 0 || state.backups?.length > 0) && (
                <details className="mt-1.5 min-w-0 text-[10px] text-zinc-500">
                  <summary className="cursor-pointer select-none text-indigo-300 hover:text-indigo-200">查看写入与备份位置</summary>
                  <div className="mt-1 space-y-1">
                    {state.paths?.map((filePath) => (
                      <code key={`path-${filePath}`} className="block break-all rounded bg-zinc-950 px-1.5 py-1 text-zinc-400">写入：{filePath}</code>
                    ))}
                    {state.backups?.map((filePath) => (
                      <code key={`backup-${filePath}`} className="block break-all rounded bg-zinc-950 px-1.5 py-1 text-zinc-400">备份：{filePath}</code>
                    ))}
                  </div>
                </details>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
