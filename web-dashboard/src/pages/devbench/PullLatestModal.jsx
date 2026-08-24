/**
 * 甄别前「拉取远程最新代码」弹窗（工作流第一步开始前）。
 * - 询问是否拉取：会保护已跟踪改动 → 拉取远程跟踪分支 → 还原原暂存状态；未跟踪文件留在原地。
 * - 冲突：逐工程列出冲突文件，可「让 AI 解决冲突」（仅解决+git add 不提交，交人工审核）或在 IDE 手动解决。
 * - 跳过 / 拉取完成 → 继续甄别。
 */
import React, { useState } from "react";
import { devbenchApi } from "./api.js";

export default function PullLatestModal({ tabId, onClose, onProceed, onToast, onRefreshTab, setRunningTabs }) {
  const [phase, setPhase] = useState("ask"); // ask | pulling | result
  const [results, setResults] = useState([]);
  const [summary, setSummary] = useState(null);
  const [resolving, setResolving] = useState(""); // 正在让 AI 解决冲突的 repo path

  async function doPull() {
    setPhase("pulling");
    const r = await devbenchApi.gitPullLatest(tabId);
    if (!r.ok && !Array.isArray(r.data)) {
      onToast?.(r.error || "拉取失败");
      setPhase("ask");
      return;
    }
    setResults(r.data || []);
    setSummary(r.summary || null);
    setPhase("result");
    onRefreshTab?.();
  }

  async function aiResolve(repoPath) {
    setResolving(repoPath);
    const r = await devbenchApi.gitResolveConflicts(tabId, repoPath);
    setResolving("");
    if (!r.ok) { onToast?.(r.error || "无法启动 AI 解决冲突"); return; }
    setRunningTabs?.((s) => new Set(s).add(tabId));
    onToast?.("AI 正在解决合并冲突（仅解决+git add，不提交，请稍后人工审核）…");
    onRefreshTab?.();
    onClose?.();
  }

  const hasConflict = results.some((x) => x.conflict);
  const hasFail = results.some((x) => !x.ok && !x.conflict);

  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/50" onClick={onClose}>
      <div className="w-[560px] max-w-[94vw] max-h-[84vh] flex flex-col bg-zinc-900 border border-zinc-700 rounded-xl shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="shrink-0 px-4 py-3 border-b border-zinc-800 flex items-center gap-2">
          <span className="text-sm font-semibold text-zinc-100">⬇ 拉取远程最新代码</span>
          <span className="text-[11px] text-zinc-500">工作流第一步前 · 保留本地改动</span>
          <button onClick={onClose} className="ml-auto text-zinc-500 hover:text-zinc-200 text-sm px-1">✕</button>
        </div>

        {phase === "ask" && (
          <div className="px-4 py-4 space-y-3">
            <div className="text-[13px] text-zinc-300 leading-relaxed">
              开始 AI 甄别前，是否先把本故事点工程（含关联工程）拉取到远程最新？
            </div>
            <div className="text-[11px] text-zinc-500 leading-relaxed bg-zinc-800/50 rounded p-2.5">
              受管 worktree：先更新各工程<b>基仓的原始分支</b>，再把更新<b>合并到 worktree 故事分支</b>（暂存已跟踪改动 → 合并 → 还原）。
              未跟踪文件会留在原地；若出现同名覆盖或合并冲突会安全停止，让你选择「我来解决」或「让 AI 解决」。
            </div>
            <div className="flex items-center gap-2 pt-1">
              <button onClick={doPull} className="text-[12px] px-3 py-1.5 rounded bg-blue-600 hover:bg-blue-500 text-white transition">⬇ 拉取最新并甄别</button>
              <button onClick={onProceed} className="text-[12px] px-3 py-1.5 rounded bg-zinc-700 hover:bg-zinc-600 text-zinc-200 transition">跳过，直接甄别</button>
              <button onClick={onClose} className="text-[12px] px-3 py-1.5 rounded text-zinc-400 hover:text-zinc-200 transition ml-auto">取消</button>
            </div>
          </div>
        )}

        {phase === "pulling" && (
          <div className="px-4 py-10 flex flex-col items-center gap-3 text-zinc-400">
            <span className="w-6 h-6 rounded-full border-2 border-zinc-600 border-t-blue-400 animate-spin" />
            <span className="text-[12px]">正在拉取并还原本地改动…</span>
          </div>
        )}

        {phase === "result" && (
          <>
            <div className="flex-1 overflow-y-auto px-3 py-3 space-y-2">
              {summary && (
                <div className="text-[11px] text-zinc-500 px-1">
                  共 {summary.total} 项（基仓 {summary.bases ?? "—"} / worktree {summary.worktrees ?? "—"}）
                  · 已更新 {summary.updated} · 冲突 {summary.conflicts} · 失败 {summary.failed}
                </div>
              )}
              {results.map((r) => (
                <div key={r.path} className="border border-zinc-800 rounded-lg px-3 py-2 bg-zinc-800/40">
                  <div className="flex items-center gap-2">
                    <span className="text-[12px] font-medium text-zinc-200 truncate">{r.name}</span>
                    {r.branch && <span className="text-[10px] font-mono text-amber-300 shrink-0">⎇ {r.branch}</span>}
                    <span className="ml-auto text-[11px] shrink-0">
                      {r.conflict ? <span className="text-red-300">⚠ 冲突（{r.conflict.type === "pop" ? "还原本地改动时" : "合并远程时"}）</span>
                        : !r.ok ? <span className="text-red-300">✗ {r.error || "失败"}</span>
                        : r.updated ? <span className="text-emerald-300">✓ 已更新到最新</span>
                        : <span className="text-zinc-400">✓ 已是最新{r.stashed ? "（本地改动已还原）" : ""}</span>}
                    </span>
                  </div>
                  {r.conflict && (
                    <div className="mt-2 space-y-1.5">
                      <div className="text-[10px] text-zinc-500">冲突文件（{r.conflict.files.length}）：</div>
                      <div className="font-mono text-[11px] text-amber-200/90 space-y-0.5 max-h-28 overflow-y-auto">
                        {r.conflict.files.map((f) => <div key={f} className="truncate" title={f}>· {f}</div>)}
                      </div>
                      <div className="flex items-center gap-2 pt-1">
                        <button onClick={() => aiResolve(r.path)} disabled={!!resolving}
                          className="text-[11px] px-2.5 py-1 rounded bg-violet-600 hover:bg-violet-500 disabled:opacity-50 text-white transition">
                          {resolving === r.path ? "AI 解决中…" : "🤖 让 AI 解决冲突"}
                        </button>
                        <button onClick={() => devbenchApi.openDir(r.path)}
                          className="text-[11px] px-2.5 py-1 rounded bg-zinc-700 hover:bg-zinc-600 text-zinc-200 transition">📁 我来解决（打开目录）</button>
                      </div>
                    </div>
                  )}
                </div>
              ))}
              {hasConflict && (
                <div className="text-[11px] text-amber-300/90 px-1 pt-1 leading-relaxed">
                  存在冲突：可让 AI 解决（仅解决冲突标记并 git add，<b>不会自动提交</b>，请人工审核后再确认），或在 IDE 手动解决。解决后可点「重试拉取」或直接「继续甄别」。
                </div>
              )}
            </div>
            <div className="shrink-0 px-4 py-3 border-t border-zinc-800 flex items-center gap-2">
              <button onClick={doPull} className="text-[12px] px-3 py-1.5 rounded bg-zinc-700 hover:bg-zinc-600 text-zinc-200 transition">↻ 重试拉取</button>
              <button onClick={onProceed}
                className={`text-[12px] px-3 py-1.5 rounded text-white transition ml-auto ${hasConflict || hasFail ? "bg-amber-600 hover:bg-amber-500" : "bg-emerald-600 hover:bg-emerald-500"}`}>
                {hasConflict || hasFail ? "仍继续甄别" : "继续甄别 →"}
              </button>
              <button onClick={onClose} className="text-[12px] px-3 py-1.5 rounded text-zinc-400 hover:text-zinc-200 transition">关闭</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
