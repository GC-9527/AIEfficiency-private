import React, { useEffect, useState } from "react";
import {
  branchPairHeadline,
  hasBranchPairMismatches,
  roleLabel,
} from "./worktreeBranchPairModel.mjs";

function BranchChip({ label, value, tone = "neutral" }) {
  const tones = {
    neutral: "border-zinc-700 bg-zinc-900/80 text-zinc-300",
    expected: "border-sky-500/30 bg-sky-500/10 text-sky-200",
    actual: "border-amber-500/35 bg-amber-500/10 text-amber-100",
    ok: "border-emerald-500/30 bg-emerald-500/10 text-emerald-200",
  };
  return (
    <span className={`inline-flex max-w-full items-center gap-1.5 rounded-lg border px-2 py-1 ${tones[tone] || tones.neutral}`}>
      <span className="shrink-0 text-[9px] uppercase tracking-[0.08em] opacity-70">{label}</span>
      <span className="truncate font-mono text-[11px]" title={value || "—"}>{value || "—"}</span>
    </span>
  );
}

function PairCard({ pair }) {
  return (
    <div
      className="rounded-xl border devbench-status-surface devbench-status-surface--warning px-3.5 py-3"
      data-testid="worktree-branch-pair-card"
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className={`rounded-md border px-1.5 py-0.5 text-[9px] font-semibold tracking-wide ${
          pair.role === "primary"
            ? "border-emerald-500/35 bg-emerald-500/10 text-emerald-300"
            : pair.role === "webapp"
              ? "border-sky-500/35 bg-sky-500/10 text-sky-300"
              : "border-violet-500/35 bg-violet-500/10 text-violet-300"
        }`}>
          {roleLabel(pair.role)}
        </span>
        <span className="text-[12px] font-medium text-zinc-100">{pair.name}</span>
      </div>

      <div className="mt-3 grid gap-2 sm:grid-cols-2">
        <div className="space-y-1.5 rounded-lg border border-zinc-800/80 bg-black/20 px-2.5 py-2">
          <div className="text-[10px] text-zinc-500">基仓检出</div>
          <BranchChip label="当前" value={pair.baseBranch} tone="actual" />
          <BranchChip label="创建来源" value={pair.originalBranch} tone="expected" />
        </div>
        <div className="space-y-1.5 rounded-lg border border-zinc-800/80 bg-black/20 px-2.5 py-2">
          <div className="text-[10px] text-zinc-500">worktree 检出</div>
          <BranchChip label="当前" value={pair.worktreeBranch} tone="actual" />
          <BranchChip label="故事点登记" value={pair.expectedWorktreeBranch} tone="expected" />
        </div>
      </div>

      <ul className="mt-3 space-y-2">
        {(pair.issues || []).map((issue) => (
          <li key={`${issue.code}-${issue.title}`} className="rounded-lg border border-amber-500/15 bg-amber-500/[0.06] px-2.5 py-2">
            <div className="text-[11px] font-medium text-amber-100">{issue.title}</div>
            <div className="mt-0.5 text-[10px] leading-relaxed text-zinc-400">{issue.detail}</div>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * 基仓 / worktree 分支不对应时的友好提示条。
 * report: GET /tabs/:id/worktree/branch-pairs 的 data
 */
export default function WorktreeBranchMismatchBanner({
  report,
  onRefresh,
  refreshing = false,
  collapsedDefault = false,
}) {
  const [collapsed, setCollapsed] = useState(collapsedDefault);
  const visible = hasBranchPairMismatches(report);

  useEffect(() => {
    if (visible) setCollapsed(collapsedDefault);
  }, [report?.inspectedAt, visible, collapsedDefault]);

  if (!visible) return null;

  const mismatches = report.mismatches || [];

  return (
    <div
      className="border-t devbench-status-banner devbench-status-banner--warning"
      data-testid="worktree-branch-mismatch-banner"
      role="status"
    >
      <div className="flex items-start gap-3 px-4 py-2.5">
        <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-xl border border-amber-400/35 bg-amber-500/15 text-sm text-amber-200">
          ⎇
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="rounded-md border border-amber-400/35 bg-amber-500/10 px-1.5 py-0.5 text-[9px] font-semibold tracking-[0.12em] text-amber-200">
              BRANCH PAIR
            </span>
            <span className="text-[12px] font-medium text-amber-50">{branchPairHeadline(report)}</span>
          </div>
          <p className="mt-1 text-[10px] leading-relaxed text-zinc-400">
            基仓与 worktree 本来就不会在同一分支；这里检查的是「创建来源分支」和「故事点登记分支」是否仍与当前检出一致。
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <button
            type="button"
            onClick={() => onRefresh?.()}
            disabled={refreshing}
            className="rounded-lg border border-zinc-700 bg-zinc-900/70 px-2 py-1 text-[10px] text-zinc-300 transition hover:border-zinc-500 hover:text-white disabled:opacity-40"
            title="重新检查分支对应关系"
          >
            {refreshing ? "检查中…" : "↻ 复查"}
          </button>
          <button
            type="button"
            onClick={() => setCollapsed((v) => !v)}
            className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-2 py-1 text-[10px] text-amber-100 transition hover:bg-amber-500/20"
            aria-expanded={!collapsed}
            data-testid="worktree-branch-mismatch-toggle"
          >
            {collapsed ? "展开详情" : "收起"}
          </button>
        </div>
      </div>

      {!collapsed && (
        <div className="space-y-2.5 border-t border-amber-500/15 px-4 py-3">
          {mismatches.map((pair) => (
            <PairCard key={`${pair.role}-${pair.worktreePath || pair.basePath || pair.name}`} pair={pair} />
          ))}
          <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 px-3 py-2 text-[10px] leading-relaxed text-zinc-500">
            建议：若基仓已切到新分支且要继续基于它开发，可更新 Flavor/配置以重建 worktree；
            若只是误切了 worktree 分支，请切回故事点登记的 <span className="font-mono text-zinc-300">story/…</span> 分支。
          </div>
        </div>
      )}
    </div>
  );
}
