import React from "react";
import { workspaceBundleSummary } from "./workspaceBundleSummaryModel.mjs";

export default function WorkspaceBundleSummary({ worktree }) {
  const summary = workspaceBundleSummary(worktree);
  if (!summary) return null;
  return (
    <details data-testid="story-workspace-bundle-summary" className="mt-2 rounded-lg border border-sky-800/40 bg-black/20 px-2.5 py-1.5">
      <summary className="cursor-pointer select-none text-[10px] text-sky-200">
        Bundle 工作区
        <span className="ml-2 font-mono text-zinc-400">{summary.workspaceId}</span>
        <span className={`ml-2 ${summary.status === "PASS" ? "text-emerald-400" : "text-amber-300"}`}>预检 {summary.status}</span>
      </summary>
      <div className="mt-2 min-w-0 space-y-2">
        <div className="grid grid-cols-1 gap-1 text-[9px] text-zinc-500 sm:grid-cols-[auto_minmax(0,1fr)]">
          <span>工作区</span><span className="break-all font-mono text-zinc-300">{summary.root}</span>
          <span>逻辑分支</span><span className="break-all font-mono text-amber-300/90">{summary.logicalBranch || "—"}</span>
          <span>构建门禁</span><span className={`font-mono ${summary.buildValidation.status === "PASS" ? "text-emerald-300" : "text-amber-300"}`}>{summary.buildValidation.task} · {summary.buildValidation.status}</span>
        </div>
        <div className="grid grid-cols-1 gap-1.5 lg:grid-cols-2">
          {summary.members.map((member) => (
            <div key={member.repositoryId} data-testid="story-workspace-bundle-member" className="min-w-0 rounded border border-zinc-800 bg-zinc-950/70 p-2 text-[9px]">
              <div className="flex items-center gap-2">
                <span className="min-w-0 flex-1 truncate font-medium text-zinc-200" title={member.name}>{member.name}</span>
                <span className={member.readOnly ? "text-sky-300" : "text-emerald-300"}>{member.mode}</span>
              </div>
              <div className="mt-1 grid grid-cols-[auto_minmax(0,1fr)] gap-x-2 gap-y-0.5 text-zinc-600">
                <span>目录</span><span className="truncate font-mono text-zinc-300" title={member.directoryName}>{member.directoryName}</span>
                <span>{member.branchLabel}</span><span className="truncate font-mono text-amber-300/80" title={member.branch}>{member.branch || "—"}</span>
                <span>提交</span><span className="font-mono text-zinc-400">{member.commit || "—"}</span>
              </div>
            </div>
          ))}
        </div>
      </div>
    </details>
  );
}
