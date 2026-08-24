/**
 * MilestoneLane —— 里程碑泳道。
 * 显示每个里程碑的状态、attempts、turns、成本、最后失败摘要、验收检查勾叉。
 * 数据来源：spec.milestones（静态定义）+ runtime（由 WS/事件聚合的运行态，按 milestoneId 索引）。
 */
import React, { useState } from "react";

const STATUS_STYLE = {
  pending: { label: "待执行", cls: "bg-zinc-700/40 text-zinc-400 border-zinc-600/40", dot: "bg-zinc-500" },
  running: { label: "执行中", cls: "bg-blue-500/15 text-blue-300 border-blue-500/30", dot: "bg-blue-400 animate-pulse" },
  awaiting: { label: "待审批", cls: "bg-amber-500/15 text-amber-300 border-amber-500/30", dot: "bg-amber-400 animate-pulse" },
  needs_human: { label: "需人工", cls: "bg-rose-500/15 text-rose-300 border-rose-500/30", dot: "bg-rose-400 animate-pulse" },
  done: { label: "已完成", cls: "bg-emerald-500/15 text-emerald-300 border-emerald-500/30", dot: "bg-emerald-400" },
  failed: { label: "失败", cls: "bg-red-500/15 text-red-300 border-red-500/30", dot: "bg-red-400" },
};

export default function MilestoneLane({ milestones, runtime, activeId, onApprove }) {
  return (
    <div className="space-y-2">
      {(milestones || []).map((m) => {
        const rt = (runtime && runtime[m.id]) || {};
        const st = STATUS_STYLE[rt.status] || STATUS_STYLE.pending;
        const isActive = activeId === m.id;
        return (
          <Lane key={m.id} m={m} rt={rt} st={st} isActive={isActive} onApprove={onApprove} />
        );
      })}
      {(!milestones || milestones.length === 0) && (
        <div className="text-xs text-zinc-600 px-2 py-4 text-center">spec 暂无里程碑</div>
      )}
    </div>
  );
}

function Lane({ m, rt, st, isActive, onApprove }) {
  const [open, setOpen] = useState(false);
  const results = rt.results || [];
  return (
    <div className={`border rounded-lg p-2.5 transition-colors ${isActive ? "border-blue-500/40 bg-blue-500/5" : "border-zinc-800 bg-zinc-900/40"}`}>
      <div className="flex items-center gap-2">
        <span className={`w-2 h-2 rounded-full shrink-0 ${st.dot}`} />
        <span className="text-sm text-zinc-200 truncate flex-1">{m.title || m.id}</span>
        <span className={`text-[10px] px-1.5 py-0.5 rounded border shrink-0 ${st.cls}`}>{st.label}</span>
      </div>

      <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 mt-1.5 text-[10px] text-zinc-500">
        <span>id: <span className="text-zinc-400 font-mono">{m.id}</span></span>
        <span>kind: <span className="text-zinc-400">{m.kind || "claude"}</span></span>
        {rt.attempt != null && <span>尝试: <span className="text-zinc-300">{rt.attempt}</span></span>}
        {rt.turns != null && <span>轮次: <span className="text-zinc-300">{rt.turns}</span>{m.maxTurns ? `/${m.maxTurns}` : ""}</span>}
        {rt.costUsd != null && <span>成本: <span className="text-amber-300">${(rt.costUsd || 0).toFixed(4)}</span></span>}
      </div>

      {rt.lastFailure && (
        <div className="mt-1.5 text-[11px] text-rose-300/90 bg-rose-500/10 border border-rose-500/20 rounded px-2 py-1">
          最后失败：{rt.lastFailure}
        </div>
      )}

      {/* 验收检查勾叉 */}
      {results.length > 0 && (
        <div className="mt-1.5">
          <button onClick={() => setOpen((o) => !o)} className="text-[11px] text-zinc-500 hover:text-zinc-300 flex items-center gap-1">
            <span>{open ? "▾" : "▸"}</span>
            验收检查 {results.filter((r) => r.ok).length}/{results.length} 通过
          </button>
          {open && (
            <div className="mt-1 space-y-1">
              {results.map((r, i) => (
                <div key={i} className="bg-zinc-950/60 border border-zinc-800 rounded px-2 py-1">
                  <div className="flex items-center gap-1.5 text-[11px]">
                    <span className={r.ok ? "text-emerald-400" : "text-red-400"}>{r.ok ? "✓" : "✗"}</span>
                    <span className="text-zinc-400 truncate">{r.label || r.type || `检查 ${i + 1}`}</span>
                  </div>
                  {r.output && (
                    <pre className="mt-1 text-[10px] text-zinc-500 whitespace-pre-wrap break-all max-h-24 overflow-y-auto font-mono">{String(r.output)}</pre>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* 逐里程碑审批入口 */}
      {rt.status === "awaiting" && (
        <button onClick={() => onApprove && onApprove(m.id)}
          className="mt-2 px-2.5 py-1 text-[11px] rounded bg-amber-600 hover:bg-amber-500 text-white">
          批准并继续
        </button>
      )}
    </div>
  );
}
