/**
 * Amend 本地改动（rule_1）：
 * 分支尾号+1 新建分支 → 把工作区所有改动 amend 到最后一次提交 → push 新分支 →（用户确认后）删除旧远程分支。
 * 入口在故事点头部「本地改动」按钮旁；点击按钮后紧贴展开（卡片样式）。
 * 交互安全：push 只推新分支、不覆盖任何远程分支；删除旧远程分支需二次确认弹窗（确认按钮 2 秒后才可点）；本地旧分支始终保留。
 */
import React, { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { devbenchApi } from "./api.js";
import { branchPreview } from "./branchNamingPreview.mjs";

export default function GitAmendPanel({ tabId, primaryPath, refreshKey = 0, onClose, onToast, onDone }) {
  const [repos, setRepos] = useState([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState(primaryPath || "");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [countdown, setCountdown] = useState(0);
  const [deleting, setDeleting] = useState(false);

  // 删除远程分支确认弹窗：打开后 2 秒内确认按钮不可点，避免误触
  useEffect(() => {
    if (!confirmOpen) return;
    setCountdown(2);
    const timer = setInterval(() => {
      setCountdown((n) => {
        if (n <= 1) { clearInterval(timer); return 0; }
        return n - 1;
      });
    }, 1000);
    return () => clearInterval(timer);
  }, [confirmOpen]);

  async function load() {
    setLoading(true);
    const r = await devbenchApi.gitRepos(tabId);
    if (r.ok) {
      const list = (r.data || []).filter((x) => x.exists && x.isRepo);
      setRepos(list);
      if (!list.some((x) => x.path === selected)) setSelected(list[0]?.path || "");
    } else {
      onToast?.(r.error || "获取工程列表失败");
    }
    setLoading(false);
  }
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [tabId, refreshKey]);
  const onCloseRef = React.useRef(onClose);
  onCloseRef.current = onClose;
  useEffect(() => {
    const onKeyDown = (event) => { if (event.key === "Escape") onCloseRef.current?.(); };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const repo = repos.find((x) => x.path === selected) || repos[0];

  async function doAmend() {
    if (!repo || busy) return;
    setBusy(true); setResult(null);
    const r = await devbenchApi.gitAmendNewBranch(tabId, repo.path);
    setBusy(false);
    if (r.ok) {
      setResult(r.data);
      onDone?.(); // 分支已变化，通知故事点刷新 Git 分支/flavor 等状态
      onToast?.(`Amend 完成：${r.data.oldBranch} → ${r.data.newBranch}${r.data.pushed ? "，已 push" : "，push 失败"}`);
    } else {
      setResult({ error: r.error || "Amend 失败" });
      onDone?.(); // 分支可能已切换（switch -c 成功但后续步骤失败），同样刷新状态
      onToast?.(r.error || "Amend 失败");
    }
  }

  async function doDeleteRemote() {
    if (!repo || !result || deleting) return;
    setDeleting(true);
    const r = await devbenchApi.gitDeleteRemoteBranch(tabId, repo.path, result.oldBranch, result.newBranch, {
      expectedOldRemoteSha: result.oldRemoteSha || "",
      expectedNewRemoteSha: result.newSha || "",
    });
    setDeleting(false);
    setConfirmOpen(false);
    if (r.ok) {
      onToast?.(`已删除远程分支 origin/${result.oldBranch}`);
      setResult((prev) => ({ ...prev, oldRemoteDeleted: true, oldRemoteExists: false }));
    } else {
      onToast?.(r.error || "删除远程分支失败");
    }
  }

  const short = (sha) => (sha || "").slice(0, 7);

  return createPortal(
    <div className="fixed inset-0 z-[85] flex items-center justify-center bg-black/70 px-4 backdrop-blur-sm" onClick={onClose}>
      <div role="dialog" aria-modal="true" aria-labelledby="git-amend-title"
        className="max-h-[88vh] w-[680px] max-w-[96vw] overflow-hidden rounded-2xl border border-zinc-700/90 bg-zinc-900 shadow-[0_30px_100px_rgba(0,0,0,.65)]"
        onClick={(event) => event.stopPropagation()}>
      {/* 标题栏 */}
      <div className="flex items-center gap-2 border-b border-zinc-800 bg-zinc-900/90 px-5 py-3">
        <span id="git-amend-title" className="text-[13px] font-semibold text-indigo-300">✏️ Amend 本地改动</span>
        <span className="hidden text-[10px] text-zinc-500 sm:inline">rule_1：把未提交改动并入分支尾号+1 的新分支</span>
        <button onClick={onClose} className="ml-auto shrink-0 rounded px-1.5 py-0.5 text-[10px] text-zinc-400 transition hover:bg-zinc-700 hover:text-zinc-100" title="关闭（Esc）">✕</button>
      </div>
      {/* 流程指示 */}
      <div className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 border-b border-zinc-800/70 bg-zinc-950/40 px-4 py-1.5 text-[10px] text-zinc-500">
        <span className="text-zinc-400">① 分支尾号+1</span><span>→</span>
        <span className="text-zinc-400">② amend 全部改动</span><span>→</span>
        <span className="text-zinc-400">③ push 新分支</span><span>→</span>
        <span className="text-zinc-400">④ 确认删除旧远程</span>
        <span className="ml-auto text-zinc-600">本地旧分支永久保留</span>
      </div>

      <div className="space-y-2.5 px-4 py-3">
        {loading ? (
          <div className="text-[11px] text-zinc-500">加载工程列表…</div>
        ) : repos.length === 0 ? (
          <div className="rounded-lg border border-amber-700/40 bg-amber-950/20 px-3 py-2 text-[11px] text-amber-300">没有可操作的 git 工程（需先在工程配置中配置且路径存在）</div>
        ) : (
          <>
            {/* 工程选择：多个 git 工程时可切换，默认主工程 */}
            {repos.length > 1 && (
              <div className="flex items-center gap-2 text-[11px]">
                <span className="shrink-0 text-zinc-500">工程</span>
                <select
                  value={repo?.path || ""}
                  onChange={(e) => { setSelected(e.target.value); setResult(null); setConfirmOpen(false); }}
                  className="max-w-[460px] rounded border border-zinc-700 bg-zinc-800 px-2 py-1 text-[11px] text-zinc-200 outline-none focus:border-indigo-500"
                >
                  {repos.map((x) => <option key={x.path} value={x.path}>{x.name} · {x.branch || "无分支"}</option>)}
                </select>
              </div>
            )}
            {repo && (
              <div className="text-[10px] text-zinc-500">
                当前分支：<span className="font-mono text-amber-300">{result ? result.newBranch : (repo.branch || "—")}</span>
                <span className="text-zinc-700"> · </span>{repo.path}
              </div>
            )}

            {/* 执行 */}
            <div className="flex items-center gap-2">
              <button
                onClick={doAmend}
                disabled={busy || !repo}
                className="rounded-md bg-indigo-600 px-3 py-1.5 text-[11px] font-medium text-white shadow-sm transition hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {busy ? "⏳ 执行中…" : "▶ 执行 Amend + Push"}
              </button>
              {!busy && result == null && (
                <span className="text-[10px] text-zinc-600">
                  将新建 <span className="rounded bg-zinc-800 px-1 py-0.5 font-mono text-zinc-300">{branchPreview(repo?.branch)}</span>（已占用会自动继续 +1），工作区改动 amend 到最后一次提交后 push 到远程
                </span>
              )}
            </div>

            {/* 结果 */}
            {result && result.error ? (
              <div className="rounded-lg border border-red-700/40 bg-red-950/30 px-3 py-2 text-[11px] text-red-300">{result.error}</div>
            ) : result ? (
              <div className="space-y-1.5 rounded-lg border border-zinc-700/70 bg-zinc-950/60 p-3 text-[11px]">
                <div className="flex items-center gap-2">
                  <span className="font-mono text-zinc-300">{result.oldBranch}</span>
                  <span className="text-zinc-600">→</span>
                  <span className="font-mono font-semibold text-emerald-300">{result.newBranch}</span>
                </div>
                <div className="font-mono text-[10px] text-zinc-400">{short(result.oldSha)} → {short(result.newSha)} · {result.commitCount} 个提交</div>
                <div className="text-zinc-400">Commit：<span className="text-zinc-200">{result.commitMessage}</span></div>
                <div className={result.clean ? "text-emerald-300" : "text-red-300"}>工作区：{result.clean ? "已 clean（diff HEAD 为空）" : "未干净，请检查"}</div>
                {result.pushed ? (
                  <div className="text-emerald-300">Push：✓ origin/{result.newBranch}（未强制）</div>
                ) : (
                  <div className="text-red-300">Push：✗ 失败：{result.pushError || "未知原因"}（新分支已本地创建并 amend，未推到远程）</div>
                )}
                <div className="text-zinc-500">MR 建议：source = {result.newBranch}，target 请在远端选择（如 develop/master）；仅 1 个提交，无需 squash。</div>

                {/* 故事点 worktree 分支记录同步结果 */}
                {result.branchRecord && result.branchRecord.ok && result.branchRecord.updated && (
                  <div className="text-[10px] text-emerald-300/90">✓ 故事点 Git worktree 分支记录已更新：{result.branchRecord.updated.from} → {result.branchRecord.updated.to}</div>
                )}
                {result.branchRecord && !result.branchRecord.ok && (
                  <div className="text-[10px] text-amber-300" title={result.branchRecord.code || ""}>
                    ⚠ 故事点 worktree 分支记录未能同步：{result.branchRecord.error || "未知原因"}（分支实际已切换，刷新页面后显示新分支；如持续失败请在「工程配置」中核对分支记录）
                  </div>
                )}

                {/* 删除旧远程分支：新分支 push 成功且旧远程存在时提供，需二次确认弹窗 */}
                {result.pushed && result.oldRemoteExists && (
                  <div className="mt-1 rounded-lg border border-amber-500/30 bg-amber-950/20 p-2.5">
                    <div className="text-[10px] text-amber-200">
                      检测到旧远程分支 <span className="font-mono">origin/{result.oldBranch}</span>。新分支已推送成功，是否删除旧远程分支？（本地旧分支 <span className="font-mono">{result.oldBranch}</span> 永久保留，仅删除远程）
                    </div>
                    <div className="mt-1.5 flex items-center gap-2">
                      <button
                        onClick={() => setConfirmOpen(true)}
                        disabled={deleting || result.oldRemoteDeleted}
                        className="rounded-md border border-red-700/40 bg-red-700/30 px-2.5 py-1 text-[11px] text-red-200 transition hover:bg-red-600/40 disabled:cursor-not-allowed disabled:opacity-40"
                      >
                        {deleting ? "删除中…" : result.oldRemoteDeleted ? "已删除" : "🗑 删除远程分支"}
                      </button>
                    </div>
                    {result.oldRemoteDeleted && (
                      <div className="mt-1 text-[10px] text-emerald-300">✓ 已删除远程分支 origin/{result.oldBranch}</div>
                    )}
                  </div>
                )}
              </div>
            ) : null}
          </>
        )}
      </div>{/* /内容区 */}
      </div>

      {/* 删除远程分支二次确认弹窗：确认按钮 2 秒倒计时后才可点 */}
      {confirmOpen && result && (
        <div className="fixed inset-0 z-[90] flex items-center justify-center bg-black/70 px-4" onClick={(e) => { e.stopPropagation(); setConfirmOpen(false); }}>
          <div role="alertdialog" aria-modal="true"
            className="w-[420px] max-w-[94vw] rounded-2xl border border-red-700/50 bg-zinc-900 p-4 shadow-[0_20px_60px_rgba(0,0,0,.7)]"
            onClick={(e) => e.stopPropagation()}>
            <div className="text-[13px] font-semibold text-red-300">确认删除远程分支？</div>
            <div className="mt-2 text-[11px] leading-relaxed text-zinc-300">
              即将删除远程分支 <span className="font-mono text-red-200">origin/{result.oldBranch}</span>，该操作不可撤销。
              <br />本地分支 <span className="font-mono text-zinc-200">{result.oldBranch}</span> 会永久保留，仅删除远程。
            </div>
            <div className="mt-3.5 flex justify-end gap-2">
              <button onClick={() => setConfirmOpen(false)}
                className="rounded-md border border-zinc-700 bg-zinc-800 px-3 py-1 text-[11px] text-zinc-200 transition hover:bg-zinc-700">取消</button>
              <button onClick={doDeleteRemote} disabled={countdown > 0 || deleting}
                className="rounded-md border border-red-700/60 bg-red-700/40 px-3 py-1 text-[11px] text-red-100 transition hover:bg-red-600/50 disabled:cursor-not-allowed disabled:opacity-40">
                {deleting ? "删除中…" : countdown > 0 ? `确认删除（${countdown}s）` : "确认删除"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>,
    document.body,
  );
}
