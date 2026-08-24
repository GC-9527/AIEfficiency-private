import React, { useEffect } from "react";
import { createPortal } from "react-dom";

const worktreePathOf = (repo) => repo?.worktreePath || repo?.path || "";
const basePathOf = (repo) => repo?.basePath || worktreePathOf(repo);

function uniqueRepos(repos) {
  const seen = new Set();
  return (repos || []).filter((repo) => {
    const key = String(worktreePathOf(repo) || basePathOf(repo)).replace(/[\\/]+/g, "/").toLowerCase();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function roleLabel(role) {
  if (role === "primary") return "主工程";
  if (role === "webapp") return "WebApp";
  return "关联工程";
}

function ProjectRoute({ repo, index }) {
  const basePath = basePathOf(repo);
  const worktreePath = worktreePathOf(repo);
  return (
    <div className="group relative overflow-hidden rounded-xl border border-zinc-800 bg-zinc-950/55 px-3 py-3 transition hover:border-teal-800/70">
      <div className="absolute inset-y-0 left-0 w-0.5 bg-gradient-to-b from-teal-400 via-cyan-500 to-transparent" />
      <div className="flex items-center gap-2">
        <span className="flex h-5 w-5 items-center justify-center rounded-md bg-teal-500/10 font-mono text-[10px] text-teal-300">{index + 1}</span>
        <span className="min-w-0 truncate text-[12px] font-semibold text-zinc-100">{repo.name || "未命名工程"}</span>
        <span className="rounded-full border border-zinc-700 bg-zinc-900 px-1.5 py-0.5 text-[9px] text-zinc-400">{roleLabel(repo.role)}</span>
      </div>
      <div className="mt-2 grid grid-cols-[72px_minmax(0,1fr)] gap-x-2 gap-y-1.5 pl-7 text-[10px]">
        <span className="text-zinc-500">基础工程</span><span className="truncate font-mono text-zinc-300" title={basePath}>{basePath || "未配置"}</span>
        <span className="text-zinc-500">原始分支</span><span className="truncate font-mono text-cyan-300/85">{repo.originalBranch || "未配置"}</span>
        <span className="text-zinc-500">合并到</span><span className="truncate font-mono text-teal-300/85" title={worktreePath}>{worktreePath || "未配置"}</span>
        <span className="text-zinc-500">故事分支</span><span className="truncate font-mono text-emerald-300/85">{repo.branch || "未配置"}</span>
      </div>
    </div>
  );
}

export default function GitUpdateScopeModal({ repos = [], primaryPath = "", onSelect, onClose }) {
  const configuredRepos = uniqueRepos(repos);
  const primary = configuredRepos.find((repo) => repo.role === "primary")
    || configuredRepos.find((repo) => String(worktreePathOf(repo)) === String(primaryPath || ""));
  useEffect(() => {
    const onKeyDown = (event) => { if (event.key === "Escape") onClose?.(); };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  const modal = (
    <div className="fixed inset-0 z-[85] flex items-center justify-center bg-black/70 px-4 backdrop-blur-sm" onClick={onClose}>
      <div role="dialog" aria-modal="true" aria-labelledby="git-update-scope-title" className="w-[720px] max-w-[96vw] overflow-hidden rounded-2xl border border-zinc-700/90 bg-zinc-900 shadow-[0_30px_100px_rgba(0,0,0,.65)]" onClick={(event) => event.stopPropagation()}>
        <div className="relative overflow-hidden border-b border-zinc-800 px-5 py-4">
          <div className="absolute -right-12 -top-16 h-40 w-40 rounded-full bg-teal-500/10 blur-3xl" />
          <div className="relative flex items-start gap-3">
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-teal-700/60 bg-teal-950/70 text-lg text-teal-300">↻</div>
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2"><h2 id="git-update-scope-title" className="text-[15px] font-semibold tracking-tight text-zinc-50">Git Update 更新计划</h2><span className="rounded-full bg-teal-500/10 px-2 py-0.5 text-[10px] text-teal-300">{configuredRepos.length} 个工程</span></div>
              <p className="mt-1.5 max-w-[580px] text-[11px] leading-relaxed text-zinc-400">先更新每个基础工程的原始分支，再将新增提交合并到对应故事 worktree。只有代码冲突会自动交给 AI，网络或分支错误会直接提示。</p>
            </div>
            <button type="button" onClick={onClose} className="ml-auto rounded-lg px-2 py-1 text-sm text-zinc-500 transition hover:bg-zinc-800 hover:text-zinc-200" aria-label="关闭">✕</button>
          </div>
        </div>
        <div className="max-h-[58vh] space-y-2 overflow-y-auto p-4">
          {configuredRepos.length ? configuredRepos.map((repo, index) => <ProjectRoute key={worktreePathOf(repo) || basePathOf(repo) || index} repo={repo} index={index} />) : <div className="rounded-xl border border-dashed border-amber-800/70 bg-amber-950/20 px-4 py-8 text-center text-[12px] text-amber-200">当前故事点没有可更新的本地工程</div>}
        </div>
        <div className="flex flex-wrap items-center gap-2 border-t border-zinc-800 bg-zinc-950/35 px-4 py-3">
          <div className="mr-auto flex items-center gap-1.5 text-[10px] text-zinc-500"><span className="h-1.5 w-1.5 rounded-full bg-amber-400" />冲突由 AI 解决并暂存，最终仍需人工审核</div>
          <button type="button" onClick={onClose} className="rounded-lg px-3 py-2 text-[11px] text-zinc-400 transition hover:bg-zinc-800 hover:text-zinc-200">取消</button>
          <button type="button" data-testid="git-update-primary" disabled={!primary} onClick={() => onSelect?.({ scope: "primary", path: worktreePathOf(primary) || primaryPath })} className="rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2 text-[11px] text-zinc-200 transition hover:border-zinc-600 hover:bg-zinc-700 disabled:cursor-not-allowed disabled:opacity-40">仅更新主工程</button>
          <button type="button" data-testid="git-update-all" disabled={!configuredRepos.length} onClick={() => onSelect?.({ scope: "all" })} className="rounded-lg border border-teal-500/70 bg-teal-600 px-4 py-2 text-[11px] font-semibold text-white shadow-lg shadow-teal-950/40 transition hover:bg-teal-500 disabled:cursor-not-allowed disabled:opacity-40">更新全部 {configuredRepos.length} 个工程</button>
        </div>
      </div>
    </div>
  );
  return typeof document !== "undefined" ? createPortal(modal, document.body) : modal;
}
