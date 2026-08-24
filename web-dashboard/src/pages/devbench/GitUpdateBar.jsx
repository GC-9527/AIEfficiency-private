import React, { useState } from "react";
import StudioBtn from "./StudioBtn.jsx";

const STAGE_LABEL = {
  fetch: "更新基础工程原始分支", analyze: "分析提交差异", stash: "保护本地改动", merge: "合并到故事 worktree",
  pop: "恢复本地改动", uptodate: "已是最新", done: "更新完成", conflict: "检测到代码冲突", preflight: "检查工程配置",
  base_update: "更新基础工程失败", worktree_preflight: "检查 worktree 分支", worktree_compare: "比较分支差异",
  worktree_stash: "保护 worktree 改动", worktree_merge: "合并到 worktree", restore_local: "恢复本地改动", complete: "完成",
};
const roleLabel = (role) => role === "primary" ? "主工程" : role === "webapp" ? "WebApp" : "关联工程";
const toneClass = {
  amber: "border-amber-800/60 bg-amber-950/25 text-amber-200", red: "border-red-900/70 bg-red-950/25 text-red-200",
  emerald: "border-emerald-900/70 bg-emerald-950/20 text-emerald-200", cyan: "border-cyan-900/70 bg-cyan-950/20 text-cyan-200",
  zinc: "border-zinc-800 bg-zinc-950/45 text-zinc-300",
};

function resultMeta(item, aiStarted) {
  if (item.conflict) return { label: aiStarted ? "AI 已接管" : "存在冲突", tone: "amber", icon: aiStarted ? "AI" : "!" };
  if (!item.ok) return { label: "更新失败", tone: "red", icon: "×" };
  if (item.worktreeUpdated) return { label: "已合并更新", tone: "emerald", icon: "✓" };
  if (item.updated) return { label: "基础工程已更新", tone: "cyan", icon: "✓" };
  return { label: "已是最新", tone: "zinc", icon: "✓" };
}

export default function GitUpdateBar({ state, onRetry, onResolveAI, onToast, onClose }) {
  const [expanded, setExpanded] = useState(true);
  if (!state) return null;
  const { status, repoCount = 1, repoIndex = 0, name, stage, detail, pct = 0, summary = {}, aiResolution = null } = state;
  const results = (Array.isArray(state.results) ? state.results : []).filter(Boolean);
  const conflicts = results.filter((item) => item.conflict);
  const failures = results.filter((item) => !item.ok && !item.conflict);
  const running = status === "running";
  const aiStarted = !!aiResolution?.started;
  const aiFailed = aiResolution?.status === "failed";
  const overall = Math.min(100, Math.round(((repoIndex + (pct || 0) / 100) / Math.max(1, repoCount)) * 100));
  const headline = running
    ? `正在更新 ${Math.min(repoIndex + 1, repoCount)}/${repoCount}${name ? ` · ${name}` : ""}`
    : conflicts.length ? `${conflicts.length} 个工程存在冲突${aiStarted ? "，AI 已接管" : ""}`
      : failures.length ? `${failures.length} 个工程更新失败`
        : summary.updated ? `Git Update 完成，${summary.updated}/${summary.total || results.length} 个工程有更新`
          : `${summary.total || results.length} 个工程均已是最新`;
  return (
    <section
      data-testid="git-update-result-panel"
      className="flex max-h-[calc(100dvh-1rem)] min-h-0 w-full flex-col overflow-hidden rounded-2xl border border-zinc-700/90 bg-zinc-900/95 text-left shadow-[0_22px_70px_rgba(0,0,0,.58)] backdrop-blur-xl sm:max-h-[min(520px,calc(100dvh-10rem))]"
    >
      <div className="h-0.5 bg-gradient-to-r from-teal-400 via-cyan-400 to-transparent" />
      <header className="flex shrink-0 items-center gap-2.5 px-3 py-2.5">
        <span className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border text-[10px] font-bold ${running ? "animate-pulse border-teal-700 bg-teal-950 text-teal-300" : conflicts.length ? "border-amber-800 bg-amber-950 text-amber-300" : failures.length ? "border-red-900 bg-red-950 text-red-300" : "border-emerald-900 bg-emerald-950 text-emerald-300"}`}>{running ? "↻" : conflicts.length ? (aiStarted ? "AI" : "!") : failures.length ? "×" : "✓"}</span>
        <div className="min-w-0 flex-1"><div className="truncate text-[12px] font-semibold text-zinc-100">{headline}</div><div className="mt-0.5 truncate text-[10px] text-zinc-500">{running ? (detail || STAGE_LABEL[stage] || "准备 Git Update") : "基础工程原始分支 → 故事 worktree"}</div></div>
        {!!results.length && <button type="button" onClick={() => setExpanded((value) => !value)} className="rounded-md px-1.5 py-1 text-[10px] text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200">{expanded ? "收起" : "详情"}</button>}
        {!running && <button type="button" onClick={onClose} className="rounded-md px-1.5 py-1 text-xs text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200" aria-label="关闭">✕</button>}
      </header>
      {running && <div className="shrink-0 px-3 pb-2.5"><div className="h-1 overflow-hidden rounded-full bg-zinc-800"><div className="h-full rounded-full bg-gradient-to-r from-teal-500 to-cyan-400 transition-all duration-300" style={{ width: `${overall}%` }} /></div></div>}
      <div data-testid="git-update-scroll-region" className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        {aiStarted && <div className="mx-3 mb-2.5 rounded-xl border border-amber-800/60 bg-amber-950/25 px-3 py-2"><div className="flex items-center gap-2 text-[11px] font-medium text-amber-100"><span className="rounded bg-amber-400/15 px-1.5 py-0.5 text-[9px] text-amber-300">AI</span>基础工程与 worktree 冲突已自动交给故事点 AI</div><p className="mt-1 text-[10px] leading-relaxed text-amber-200/65">AI 只处理列出的冲突文件，不会提交或推送。运行时可使用输入区“停止”按钮中断，确认按钮将在 2 秒后启用。</p></div>}
        {aiFailed && <div className="mx-3 mb-2.5 rounded-lg border border-red-900/70 bg-red-950/30 px-3 py-2 text-[10px] leading-relaxed text-red-200">AI 启动失败：{aiResolution.error || "未知错误"}。冲突现场已保留，可稍后重试或手动处理。</div>}
        {expanded && !!results.length && (
          <div className="space-y-2 border-t border-zinc-800/80 px-3 py-2.5">
          {results.map((item, index) => {
            const meta = resultMeta(item, aiStarted);
            const basePath = item.basePath || (item.kind === "base" ? item.path : "");
            const worktreePath = item.worktreePath || (item.kind === "worktree" ? item.path : "");
            const conflictPath = item.kind === "base" ? (item.path || basePath) : (worktreePath || item.path);
            return (
              <article key={`${item.role || "repo"}:${worktreePath || basePath || item.name}:${index}`} className={`rounded-xl border px-2.5 py-2 ${toneClass[meta.tone]}`}>
                <div className="flex items-center gap-2"><span className="flex h-4 w-4 shrink-0 items-center justify-center rounded bg-black/20 text-[9px] font-bold">{meta.icon}</span><span className="min-w-0 truncate text-[11px] font-semibold">{item.name || "未命名工程"}</span><span className="rounded-full border border-current/20 px-1.5 py-0.5 text-[8px] opacity-70">{roleLabel(item.role)} · {item.kind === "base" ? "基础工程" : "Worktree"}</span><span className="ml-auto shrink-0 text-[9px] opacity-75">{meta.label}</span></div>
                <div className="mt-1.5 grid grid-cols-[62px_minmax(0,1fr)] gap-x-2 gap-y-1 pl-6 font-mono text-[9px] opacity-70"><span>基础工程</span><span className="truncate" title={basePath}>{item.originalBranch || "原始分支"} · {basePath || "未返回"}</span><span>Worktree</span><span className="truncate" title={worktreePath}>{item.storyBranch || item.branch || "故事分支"} · {worktreePath || "未返回"}</span></div>
                {item.error && <div className="mt-1.5 rounded-md bg-black/20 px-2 py-1.5 text-[10px] leading-relaxed">{item.error}</div>}
                {!!item.conflict?.files?.length && <div className="mt-1.5 flex flex-wrap gap-1 pl-6">{item.conflict.files.map((file) => <span key={file} className="max-w-full truncate rounded bg-black/20 px-1.5 py-0.5 font-mono text-[9px]" title={file}>{file}</span>)}</div>}
                {item.stashPreserved && <div className="mt-1.5 pl-6 text-[9px] text-amber-300/80">本地改动已保存在临时 stash；完成冲突审核后需恢复。</div>}
                {item.conflict && <div className="mt-2 flex justify-end gap-1.5">{(!aiStarted || aiFailed) && <button type="button" onClick={() => onResolveAI?.({ ...item, path: conflictPath })} className="rounded-md bg-amber-500 px-2 py-1 text-[9px] font-semibold text-zinc-950 hover:bg-amber-400">再次交给 AI</button>}<StudioBtn path={conflictPath} onToast={onToast} compact /></div>}
                {!item.conflict && !item.ok && <div className="mt-1.5 pl-6 text-[9px] opacity-65">失败阶段：{STAGE_LABEL[item.phase] || item.phase || "Git 操作"}</div>}
              </article>
            );
          })}
          </div>
        )}
      </div>
      {!running && <footer className="flex shrink-0 flex-wrap items-center gap-2 border-t border-zinc-800 bg-zinc-950/35 px-3 py-2"><span className="min-w-[160px] flex-1 text-[9px] text-zinc-600">结果会保留到你关闭，普通 Git 失败不会交给 AI</span><div className="ml-auto flex shrink-0 items-center gap-1.5"><button data-testid="git-update-close-footer" type="button" onClick={onClose} className="rounded-lg border border-zinc-700 bg-zinc-800 px-2.5 py-1.5 text-[10px] text-zinc-300 transition hover:border-zinc-500 hover:bg-zinc-700">关闭</button><button type="button" onClick={onRetry} className="rounded-lg border border-teal-800/70 bg-teal-950/50 px-2.5 py-1.5 text-[10px] text-teal-200 transition hover:border-teal-600 hover:bg-teal-900/60">重新更新</button></div></footer>}
    </section>
  );
}
