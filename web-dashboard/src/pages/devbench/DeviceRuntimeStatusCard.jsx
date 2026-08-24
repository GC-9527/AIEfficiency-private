import React from "react";

import { deviceRuntimeStatusView } from "./deviceRuntimeStatusModel.mjs";

export default function DeviceRuntimeStatusCard({ device, compact = false }) {
  if (!device) return null;
  const view = deviceRuntimeStatusView(device);
  const empty = !view.bindings.length && !view.currentUse && !view.queue.length;

  return (
    <section
      className={`rounded-xl border border-zinc-800 bg-zinc-950/45 ${compact ? "p-2.5" : "p-3.5"}`}
      data-testid="device-runtime-status-card"
      data-device-serial={view.serial}
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className={`h-2 w-2 rounded-full ${view.online ? "bg-emerald-400" : "bg-zinc-600"}`} aria-hidden />
        <span className="text-[10px] font-medium text-zinc-300">{view.online ? "设备在线" : "设备离线"}</span>
        <span className="rounded bg-zinc-900 px-1.5 py-0.5 font-mono text-[9px] text-zinc-500">{view.serial}</span>
        <div className="ml-auto flex gap-1.5 text-[9px]">
          <span className="rounded bg-cyan-950/45 px-1.5 py-0.5 text-cyan-300">绑定 {view.bindings.length}</span>
          <span className={`rounded px-1.5 py-0.5 ${view.currentUse ? "bg-amber-950/55 text-amber-300" : "bg-emerald-950/45 text-emerald-300"}`}>
            {view.currentUse ? "使用中" : "空闲"}
          </span>
          <span className="rounded bg-violet-950/45 px-1.5 py-0.5 text-violet-300">排队 {view.queue.length}</span>
        </div>
      </div>

      {empty ? <p className="mt-2 text-[9px] text-zinc-600">尚无故事点绑定，当前也没有运行或排队任务。</p> : null}

      {view.bindings.length ? (
        <div className="mt-2.5" data-testid="device-runtime-bindings">
          <div className="mb-1 text-[9px] uppercase tracking-[0.12em] text-zinc-600">已绑定故事点</div>
          <div className="flex flex-wrap gap-1.5">
            {view.bindings.map((binding) => (
              <span key={binding.storyId || binding.title} className="max-w-full truncate rounded border border-cyan-900/45 bg-cyan-950/20 px-2 py-1 text-[9px] text-cyan-200" title={binding.title}>
                {binding.title}
              </span>
            ))}
          </div>
        </div>
      ) : null}

      <div className={`mt-2.5 grid gap-2 ${compact ? "" : "md:grid-cols-2"}`}>
        <div data-testid="device-runtime-current-use">
          <div className="mb-1 text-[9px] uppercase tracking-[0.12em] text-zinc-600">当前使用</div>
          {view.currentUse ? (
            <div className="rounded-lg border border-amber-800/45 bg-amber-950/15 px-2.5 py-2">
              <div className="truncate text-[10px] font-medium text-amber-200" title={view.currentUse.storyTitle}>{view.currentUse.storyTitle}</div>
              <div className="mt-0.5 text-[9px] text-amber-500/80">{view.currentUse.operationLabel}{view.currentUse.fencingToken ? ` · fencing #${view.currentUse.fencingToken}` : ""}</div>
            </div>
          ) : <div className="rounded-lg border border-zinc-800 px-2.5 py-2 text-[9px] text-zinc-600">当前空闲</div>}
        </div>

        <div data-testid="device-runtime-queue">
          <div className="mb-1 text-[9px] uppercase tracking-[0.12em] text-zinc-600">后续 FIFO 队列</div>
          {view.queue.length ? (
            <ol className="space-y-1">
              {view.queue.map((entry, index) => (
                <li key={entry.requestId || `${entry.storyId}-${index}`} className="flex items-center gap-2 rounded-lg border border-violet-900/35 bg-violet-950/15 px-2.5 py-1.5">
                  <span className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-violet-800/45 text-[8px] text-violet-200">{entry.position || index + 1}</span>
                  <span className="min-w-0 flex-1 truncate text-[9px] text-zinc-300" title={entry.storyTitle}>{entry.storyTitle}</span>
                  <span className="shrink-0 text-[8px] text-violet-400/80">{entry.operationLabel}</span>
                </li>
              ))}
            </ol>
          ) : <div className="rounded-lg border border-zinc-800 px-2.5 py-2 text-[9px] text-zinc-600">暂无等待任务</div>}
        </div>
      </div>
    </section>
  );
}
