/**
 * Git 提交整理（prompt_ask_git_edit 升级）：
 * 把开发分支重整为「基于 MR target 的单 commit」新分支。
 * 三大特殊场景可处理（不硬报错）：
 *  ① 工作区未提交改动 → 决策卡片：纳入新分支（推荐）/ 仅保存到 Stash / 取消（敏感文件禁止纳入）
 *  ② 原分支未推送或本地≠远程 → 决策卡片：直接重整只推新分支（推荐）/ 取消
 *  ③ 历史含 Merge Commit → squash 自然消除，结果区提示不会复制
 * 命名：默认完整分支名 +1（不递增时间戳/业务编号），已整理过的分支按持久化重整序号继续 +1；支持 override。
 * 旧远程分支：仅当本地=远程 SHA 一致（deleteRemoteOldAllowed）且用户输入 YES 后删除。
 */
import React, { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { devbenchApi } from "./api.js";
import { branchPreview } from "./branchNamingPreview.mjs";
import StudioBtn from "./StudioBtn.jsx";

export default function GitCommitReworkPanel({ tabId, primaryPath, refreshKey = 0, onClose, onToast, onDone }) {
  const [repos, setRepos] = useState([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState(primaryPath || "");
  const [mrTarget, setMrTarget] = useState("");
  const [mrDirty, setMrDirty] = useState(false); // 用户是否手动改过 MR 目标（防止自动填充覆盖）
  const [override, setOverride] = useState("");
  const [commitMessage, setCommitMessage] = useState("");
  const [validationCommand, setValidationCommand] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const [decision, setDecision] = useState(null); // needDecision：工作区改动 / 未推送等需用户确认
  const [failDetail, setFailDetail] = useState(null); // { error, tmpDir?, stashOid? }
  const [confirmText, setConfirmText] = useState("");
  const [deleting, setDeleting] = useState(false);

  // MR 目标分支默认 = 该工程的「原始分支」（与提 PR 面板的目标分支一致）；仅当用户未手动改过时自动填充
  const applyDefaultTarget = useCallback((repo, force = false) => {
    if (repo?.originalBranch && (force || !mrDirty)) setMrTarget(repo.originalBranch);
  }, [mrDirty]);

  async function load() {
    setLoading(true);
    const r = await devbenchApi.gitRepos(tabId);
    if (r.ok) {
      const list = (r.data || []).filter((x) => x.exists && x.isRepo);
      setRepos(list);
      const next = list.find((x) => x.path === selected) || list[0];
      if (next) setSelected(next.path);
      applyDefaultTarget(next);
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

  function pickRepo(path) {
    setSelected(path);
    const next = repos.find((x) => x.path === path);
    setMrDirty(false);
    applyDefaultTarget(next, true); // 切换工程后强制跟随该工程（与提 PR 面板一致）
    setResult(null); setDecision(null); setFailDetail(null); setConfirmText("");
  }

  async function doRework(dirtyMode = "", confirmRemoteMissing = false) {
    if (!repo || busy) return;
    if (!mrTarget.trim()) { onToast?.("请填写 MR 目标分支（如 develop / release/xxx / master）"); return; }
    setBusy(true); setResult(null); setDecision(null); setFailDetail(null);
    const r = await devbenchApi.gitCommitReorganize(tabId, {
      path: repo.path,
      mrTargetBranch: mrTarget.trim(),
      newBranchOverride: override.trim(),
      commitMessage: commitMessage.trim(),
      validationCommand: validationCommand.trim(),
      dirtyMode,
      confirmRemoteMissing,
    });
    setBusy(false);
    if (r.ok) {
      setResult(r.data);
      onDone?.(); // 故事点 worktree 已切到新分支，通知刷新
      onToast?.(`提交整理完成：${r.data.oldBranch} → ${r.data.newBranch}（单 commit 已 push）`);
    } else if (r.needDecision) {
      setDecision(r.needDecision); // 展示处理卡片，用户选择后带参数重试
    } else {
      setFailDetail({ error: r.error || "提交整理失败", tmpDir: r.detail?.tmpDir, stashOid: r.detail?.stashOid });
      onDone?.(); // 半程失败也可能切换了状态，刷新一次
      onToast?.(r.error || "提交整理失败");
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
    if (r.ok) {
      onToast?.(`已删除远程分支 origin/${result.oldBranch}`);
      setResult((prev) => ({ ...prev, oldRemoteDeleted: true, oldRemoteExists: false }));
    } else {
      onToast?.(r.error || "删除远程分支失败");
    }
  }

  // 冲突解决后恢复流程
  async function doResume() {
    if (!decision || decision.type !== "conflict" || busy) return;
    const tmpDir = decision.tmpDir;
    if (!tmpDir) { onToast?.("缺少临时 worktree 路径"); return; }
    setBusy(true);
    const r = await devbenchApi.gitCommitReorganizeResume(tabId, {
      path: repo.path,
      tmpDir,
      commitMessage: commitMessage.trim(),
      validationCommand: validationCommand.trim(),
    });
    setBusy(false);
    if (r.ok) {
      setResult(r.data);
      setDecision(null);
      onDone?.();
      onToast?.(`提交整理完成（冲突已解决）：${r.data.oldBranch} -> ${r.data.newBranch}（单 commit 已 push）`);
    } else if (r.needDecision) {
      setDecision(r.needDecision); // 仍有冲突，更新文件列表
      onToast?.(r.needDecision.error || "仍有未解决的冲突");
    } else {
      setFailDetail({ error: r.error || "恢复流程失败", tmpDir: r.detail?.tmpDir, stashOid: r.detail?.stashOid });
      setDecision(null);
      onDone?.();
      onToast?.(r.error || "恢复流程失败");
    }
  }

  // 放弃重整：清理临时 worktree + 恢复 stash
  async function doAbort() {
    if (!decision || decision.type !== "conflict" || busy) return;
    const tmpDir = decision.tmpDir;
    const stashOid = decision.stashOid || "";
    if (!tmpDir) { setDecision(null); return; }
    setBusy(true);
    const r = await devbenchApi.gitCommitReorganizeAbort(tabId, { path: repo.path, tmpDir, stashOid });
    setBusy(false);
    if (r.ok) {
      setDecision(null);
      onDone?.();
      const parts = ["已放弃重整，临时 worktree 已清理"];
      if (stashOid) parts.push(r.data?.stashRestored ? "stash 已恢复到工作区" : `stash 未恢复（${r.data?.stashError || "未知原因"}）`);
      onToast?.(parts.join("，"));
    } else {
      onToast?.(r.error || "放弃失败");
    }
  }

  const short = (sha) => (sha || "").slice(0, 7);

  // ===== 决策卡片（场景一/二） =====
  const decisionCard = decision ? (
    <div className={`rounded-xl border p-3 text-[11px] ${decision.type === "conflict" ? "border-red-500/40 bg-red-950/15" : "border-amber-500/40 bg-amber-950/15"}`}>
      <div className={`flex items-center gap-1.5 ${decision.type === "conflict" ? "text-red-200" : "text-amber-200"}`}>
        <span>{decision.type === "conflict" ? "⚠" : "⚠"}</span>
        <span className="font-medium">
          {decision.type === "dirty" ? "检测到未提交改动" :
            decision.type === "dirty_sensitive" ? "检测到敏感文件" :
            decision.type === "remote_missing" ? "原分支尚未推送到远程" :
            decision.type === "remote_diverged" ? "本地与远程不一致" :
            decision.type === "conflict" ? "squash merge 冲突" : "需要确认"}
        </span>
      </div>

      {(decision.type === "dirty" || decision.type === "dirty_sensitive") && (
        <>
          <div className="mt-1.5 text-zinc-400">
            工作区有 <span className="font-mono text-amber-300">{decision.count}</span> 项未提交改动
            {Array.isArray(decision.files) && decision.files.length > 0 && (
              <span className="block max-h-24 overflow-auto font-mono text-[10px] text-zinc-500">
                {decision.files.slice(0, 12).map((f) => <div key={f}>· {f}</div>)}
                {decision.files.length > 12 ? <div>… 共 {decision.files.length} 个</div> : null}
              </span>
            )}
          </div>
          {Array.isArray(decision.sensitiveFiles) && decision.sensitiveFiles.length > 0 && (
            <div className="mt-1.5 rounded-lg border border-red-700/50 bg-red-950/30 px-2.5 py-1.5 text-[10px] text-red-300">
              🔒 敏感文件（禁止自动纳入新分支）：{decision.sensitiveFiles.join("、")}
            </div>
          )}
          {decision.error && <div className="mt-1.5 text-[10px] text-red-300">{decision.error}</div>}
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            {decision.type === "dirty" && (!Array.isArray(decision.sensitiveFiles) || decision.sensitiveFiles.length === 0) && (
              <button onClick={() => doRework("include")} disabled={busy}
                className="rounded-md bg-amber-600 px-2.5 py-1 text-[11px] font-medium text-zinc-950 transition hover:bg-amber-500 disabled:opacity-50">
                纳入新分支（推荐）
              </button>
            )}
            <button onClick={() => doRework("stash")} disabled={busy}
              className="rounded-md border border-amber-700/50 bg-amber-950/40 px-2.5 py-1 text-[11px] text-amber-200 transition hover:bg-amber-900/50 disabled:opacity-50">
              仅保存到 Stash（不纳入）
            </button>
            <button onClick={() => setDecision(null)} disabled={busy}
              className="rounded-md px-2.5 py-1 text-[11px] text-zinc-400 transition hover:bg-zinc-800 disabled:opacity-50">
              取消
            </button>
          </div>
        </>
      )}

      {(decision.type === "remote_missing" || decision.type === "remote_diverged") && (
        <>
          <div className="mt-1.5 text-zinc-400">{decision.note}</div>
          {decision.oldRemoteSha && (
            <div className="mt-1 font-mono text-[10px] text-zinc-500">本地 {decision.oldLocalSha} / 远程 origin/{repo?.branch}@{decision.oldRemoteSha}</div>
          )}
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            <button onClick={() => doRework("", true)} disabled={busy}
              className="rounded-md bg-amber-600 px-2.5 py-1 text-[11px] font-medium text-zinc-950 transition hover:bg-amber-500 disabled:opacity-50">
              直接重整，只推新分支（推荐）
            </button>
            <button onClick={() => setDecision(null)} disabled={busy}
              className="rounded-md px-2.5 py-1 text-[11px] text-zinc-400 transition hover:bg-zinc-800 disabled:opacity-50">
              取消
            </button>
          </div>
        </>
      )}

      {decision.type === "conflict" && (
        <>
          <div className="mt-1.5 text-zinc-400">{decision.note || decision.error || "squash merge 产生冲突"}</div>
          <div className="mt-1.5 rounded-lg border border-red-700/40 bg-red-950/20 px-2.5 py-1.5">
            <div className="text-[10px] text-red-300 font-medium">冲突文件（{decision.files?.length || 0} 个，禁止自动选择 ours/theirs）：</div>
            <div className="mt-1 max-h-32 overflow-auto font-mono text-[10px] text-zinc-400">
              {(decision.files || []).map((cf) => (
                <details key={cf.path} className="border-b border-zinc-800/50 py-0.5">
                  <summary className="cursor-pointer text-zinc-300 hover:text-amber-300">
                    · {cf.path} <span className="text-zinc-600">({cf.markerCount} 处冲突)</span>
                  </summary>
                  {cf.preview && (
                    <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap rounded bg-zinc-950/60 p-1.5 text-[9px] text-zinc-500">{cf.preview}</pre>
                  )}
                </details>
              ))}
            </div>
          </div>
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-[10px] text-amber-300">
            <span>临时 worktree：</span>
            <span className="font-mono break-all">{decision.tmpDir}</span>
            <StudioBtn path={decision.tmpDir} onToast={onToast} compact />
          </div>
          <div className="mt-1 text-[10px] text-amber-300/90">
            请用 Android Studio（或任意 IDE）打开上述路径，人工解决所有冲突标记（&lt;&lt;&lt;&lt;&lt;&lt;&lt; / ======= / &gt;&gt;&gt;&gt;&gt;&gt;&gt;），保存后点击「已解决，继续」。
          </div>
          {decision.stashOid && (
            <div className="text-[10px] text-amber-300/80">未提交改动已保存为 stash <span className="font-mono">{decision.stashOid.slice(0, 7)}</span>（重整成功后会自动恢复）</div>
          )}
          <div className="mt-2 space-y-1.5">
            <label className="flex flex-col gap-0.5">
              <span className="text-[10px] text-zinc-500">Commit message（可修改，留空自动用旧分支最近提交信息）</span>
              <input value={commitMessage} onChange={(e) => setCommitMessage(e.target.value)} placeholder="留空自动"
                className="rounded border border-zinc-700 bg-zinc-800 px-2 py-1 text-[11px] text-zinc-200 outline-none placeholder-zinc-600 focus:border-teal-500" />
            </label>
            <label className="flex flex-col gap-0.5">
              <span className="text-[10px] text-zinc-500">校验命令（可修改，留空跳过）</span>
              <input value={validationCommand} onChange={(e) => setValidationCommand(e.target.value)} placeholder="如 gradlew.bat :app:compileDebugSources"
                className="rounded border border-zinc-700 bg-zinc-800 px-2 py-1 font-mono text-[11px] text-zinc-200 outline-none placeholder-zinc-600 focus:border-teal-500" />
            </label>
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            <button onClick={() => doResume()} disabled={busy}
              className="rounded-md bg-teal-600 px-2.5 py-1 text-[11px] font-medium text-white transition hover:bg-teal-500 disabled:opacity-50">
              {busy ? "⏳ 验证中…" : "✓ 已解决，继续"}
            </button>
            <button onClick={() => doAbort()} disabled={busy}
              className="rounded-md border border-red-700/40 bg-red-700/20 px-2.5 py-1 text-[11px] text-red-200 transition hover:bg-red-600/30 disabled:opacity-50">
              放弃重整
            </button>
          </div>
        </>
      )}
    </div>
  ) : null;

  return createPortal(
    <div className="fixed inset-0 z-[85] flex items-center justify-center bg-black/70 px-4 backdrop-blur-sm" onClick={onClose}>
      <div role="dialog" aria-modal="true" aria-labelledby="git-rework-title"
        className="flex max-h-[88vh] w-[720px] max-w-[96vw] flex-col overflow-hidden rounded-2xl border border-zinc-700/90 bg-zinc-900 shadow-[0_30px_100px_rgba(0,0,0,.65)]"
        onClick={(event) => event.stopPropagation()}>
        {/* 标题栏 */}
        <div className="flex items-center gap-2 border-b border-zinc-800 bg-zinc-900/90 px-5 py-3">
          <span id="git-rework-title" className="text-[13px] font-semibold text-teal-300">🧹 Git 提交整理</span>
          <span className="hidden text-[10px] text-zinc-500 sm:inline">把开发分支重整为「基于 MR target 的单 commit」新分支</span>
          <button onClick={onClose} className="ml-auto shrink-0 rounded px-1.5 py-0.5 text-[10px] text-zinc-400 transition hover:bg-zinc-700 hover:text-zinc-100" title="关闭（Esc）">✕</button>
        </div>
        {/* 流程指示 */}
        <div className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 border-b border-zinc-800/70 bg-zinc-950/40 px-5 py-1.5 text-[10px] text-zinc-500">
          <span className="text-zinc-400">① 未提交改动（可纳入/保存）</span><span>→</span>
          <span className="text-zinc-400">② 临时 worktree squash</span><span>→</span>
          <span className={decision?.type === "conflict" ? "text-red-400" : "text-zinc-400"}>冲突处理（如有）</span><span>-></span>
          <span className="text-zinc-400">③ 校验（可选）</span><span>→</span>
          <span className="text-zinc-400">④ push 新分支</span><span>→</span>
          <span className="text-zinc-400">⑤ 确认删除旧远程</span>
          <span className="ml-auto text-zinc-600">任一步失败立即停止</span>
        </div>

        <div className="flex-1 space-y-2.5 overflow-y-auto px-5 py-4">
          {loading ? (
            <div className="text-[11px] text-zinc-500">加载工程列表…</div>
          ) : repos.length === 0 ? (
            <div className="rounded-lg border border-amber-700/40 bg-amber-950/20 px-3 py-2 text-[11px] text-amber-300">没有可操作的 git 工程（需先在工程配置中配置且路径存在）</div>
          ) : (
            <>
              {/* 工程选择 */}
              {repos.length > 1 && (
                <div className="flex items-center gap-2 text-[11px]">
                  <span className="shrink-0 text-zinc-500">工程</span>
                  <select
                    value={repo?.path || ""}
                    onChange={(e) => pickRepo(e.target.value)}
                    className="max-w-[460px] rounded border border-zinc-700 bg-zinc-800 px-2 py-1 text-[11px] text-zinc-200 outline-none focus:border-teal-500"
                  >
                    {repos.map((x) => <option key={x.path} value={x.path}>{x.name} · {x.branch || "无分支"}</option>)}
                  </select>
                </div>
              )}
              {repo && (
                <div className="text-[10px] text-zinc-500">
                  当前分支：<span className="font-mono text-amber-300">{result ? result.newBranch : (repo.branch || "—")}</span>
                  {repo.originalBranch ? <span className="text-zinc-600"> · 提 PR 目标：<span className="font-mono text-cyan-300">{repo.originalBranch}</span></span> : null}
                  <span className="text-zinc-700"> · </span>{repo.path}
                </div>
              )}

              {/* 参数区 */}
              {!result && !decision && (
                <div className="grid grid-cols-1 gap-2 text-[11px] sm:grid-cols-2">
                  <label className="flex flex-col gap-1">
                    <span className="text-zinc-500">MR 目标分支 <b className="text-red-400">*</b>（默认=提 PR 目标分支，如 develop / release/xxx / master）</span>
                    <input value={mrTarget} onChange={(e) => { setMrTarget(e.target.value); setMrDirty(true); }} placeholder={repo?.originalBranch || "develop"}
                      className="rounded border border-zinc-700 bg-zinc-800 px-2 py-1 font-mono text-[11px] text-zinc-200 outline-none placeholder-zinc-600 focus:border-teal-500" />
                  </label>
                  <label className="flex flex-col gap-1">
                    <span className="text-zinc-500">新分支名（可空 = 自动推导）</span>
                    <input value={override} onChange={(e) => setOverride(e.target.value)} placeholder={branchPreview(repo?.branch) || `${repo?.branch || "旧分支"}+1`}
                      className="rounded border border-zinc-700 bg-zinc-800 px-2 py-1 font-mono text-[11px] text-zinc-200 outline-none placeholder-zinc-600 focus:border-teal-500" />
                    <span className="text-[9px] text-zinc-600">默认：完整分支名后追加 1（不递增时间戳/业务编号尾号）；业务单号分支保持单号整体、追加修正序号（…_CARB_14189 → …_CARB_14189_1）；已整理过的分支自动按重整序号 +1</span>
                  </label>
                  <label className="flex flex-col gap-1">
                    <span className="text-zinc-500">Commit message（可空 = 自动用旧分支最近提交信息）</span>
                    <input value={commitMessage} onChange={(e) => setCommitMessage(e.target.value)} placeholder="留空自动"
                      className="rounded border border-zinc-700 bg-zinc-800 px-2 py-1 text-[11px] text-zinc-200 outline-none placeholder-zinc-600 focus:border-teal-500" />
                  </label>
                  <label className="flex flex-col gap-1">
                    <span className="text-zinc-500">校验命令（可空 = 跳过；将以 shell 命令在临时 worktree 目录执行，git 子命令会绕过基仓保护钩子）</span>
                    <input value={validationCommand} onChange={(e) => setValidationCommand(e.target.value)} placeholder="如 gradlew.bat :app:compileDebugSources"
                      className="rounded border border-zinc-700 bg-zinc-800 px-2 py-1 font-mono text-[11px] text-zinc-200 outline-none placeholder-zinc-600 focus:border-teal-500" />
                  </label>
                </div>
              )}

              {/* 决策卡片（工作区改动 / 未推送 / 不一致） */}
              {!result && decisionCard}

              {/* 执行 */}
              {!result && !decision && (
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => doRework()}
                    disabled={busy || !repo}
                    className="rounded-md bg-teal-600 px-3 py-1.5 text-[11px] font-medium text-white shadow-sm transition hover:bg-teal-500 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {busy ? "⏳ 整理中（fetch/squash/push 可能需要较长时间）…" : "▶ 整理并 Push"}
                  </button>
                  <span className="text-[10px] text-zinc-600">未提交改动 / 未推送分支会自动弹出处理选择，不会直接报错中断</span>
                </div>
              )}
              {busy && !result && !decision && (
                <div className="text-[10px] text-zinc-500">正在执行预检（分支状态 / 目标分支 / 命名推导）…</div>
              )}

              {/* 失败详情（含保留的临时 worktree / stash） */}
              {failDetail && (
                <div className="space-y-1 rounded-lg border border-red-700/40 bg-red-950/30 px-3 py-2 text-[11px] text-red-300">
                  <div>{failDetail.error}</div>
                  {failDetail.tmpDir && (
                    <div className="flex flex-wrap items-center gap-1.5 text-[10px] text-amber-300">
                      <span>临时 worktree 已保留用于排查：</span>
                      <span className="font-mono break-all">{failDetail.tmpDir}</span>
                      <StudioBtn path={failDetail.tmpDir} onToast={onToast} compact />
                      <span>（处理后可手动 <span className="font-mono">git worktree remove</span> 删除）</span>
                    </div>
                  )}
                  {failDetail.stashOid && (
                    <div className="text-[10px] text-amber-300">未提交改动已保存为 stash <span className="font-mono">{failDetail.stashOid.slice(0, 7)}</span>，可执行 <span className="font-mono">git stash apply {failDetail.stashOid}</span> 恢复</div>
                  )}
                </div>
              )}

              {/* 成功结果 */}
              {result && (
                <div className="space-y-1.5 rounded-lg border border-zinc-700/70 bg-zinc-950/60 p-3 text-[11px]">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-mono text-zinc-300">{result.oldBranch}</span>
                    <span className="text-zinc-600">→</span>
                    <span className="font-mono font-semibold text-emerald-300">{result.newBranch}</span>
                    <span className="text-zinc-600">基于</span>
                    <span className="font-mono text-sky-300">{result.targetBranch}</span>
                  </div>
                  <div className="font-mono text-[10px] text-zinc-400">
                    old local {short(result.oldLocalSha)} {result.oldRemoteSha ? `= old remote ${short(result.oldRemoteSha)}` : "(未推送)"} · target {short(result.targetSha)} · new {short(result.newSha)}
                  </div>
                  <div className="text-zinc-400">Commit：<span className="text-zinc-200">{result.commitMessage}</span></div>
                  <div className="text-zinc-400">改动文件：<span className="text-zinc-200">{result.diffFiles?.length || 0}</span> 个{result.diffFiles?.length ? <span className="text-zinc-600">（{result.diffFiles.slice(0, 5).join("、")}{result.diffFiles.length > 5 ? " …" : ""}）</span> : null}</div>
                  <div className={result.pushed ? "text-emerald-300" : "text-red-300"}>Push：{result.pushed ? `✓ origin/${result.newBranch}（未强制，远程 SHA 已验证）` : "✗ 失败"}</div>
                  <div className="text-zinc-500">MR 建议：source = {result.newBranch} → target = {result.targetBranch}；仅 1 个提交，无需 squash。</div>

                  {/* 场景三：Merge Commit 提示（squash 自然消除） */}
                  {Number(result.mergeCount || 0) > 0 && (
                    <div className="text-[10px] text-indigo-300/90">历史含 {result.mergeCount} 个 Merge Commit：squash 已自然消除，不会复制到新分支。</div>
                  )}

                  {/* 未提交改动处理结果 */}
                  {result.dirtyHandled === "include" && (
                    <div className="text-[10px] text-emerald-300/90">✓ 未提交改动已纳入新分支（{result.stashOid ? `stash ${result.stashOid.slice(0, 7)} 已清理` : ""}）</div>
                  )}
                  {result.dirtyHandled === "stash" && (
                    <div className="text-[10px] text-emerald-300/90">✓ 未提交改动已保存并恢复到当前工作区（未纳入新分支）</div>
                  )}
                  {result.restoreWarning && (
                    <div className="text-[10px] text-amber-300">⚠ {result.restoreWarning}</div>
                  )}

                  {/* 校验命令结果 */}
                  {result.validation && !result.validation.skipped && (
                    <div className={result.validation.ok ? "text-emerald-300" : "text-red-300"}>
                      校验：{result.validation.ok ? "✓ 通过" : `✗ 失败（${result.validation.code}）`}{result.validation.error ? `：${result.validation.error}` : ""}
                    </div>
                  )}
                  {result.validation?.skipped && (
                    <div className="text-[10px] text-amber-300/80">⚠ 已跳过编译校验（未填校验命令）；生产提 MR 前建议在 Android Studio 验证</div>
                  )}

                  {/* 故事点 worktree 分支记录同步 */}
                  {result.switched && result.branchRecord && result.branchRecord.ok && result.branchRecord.updated && (
                    <div className="text-[10px] text-emerald-300/90">✓ 故事点 Git worktree 分支记录已更新：{result.branchRecord.updated.from} → {result.branchRecord.updated.to}（已切换）</div>
                  )}
                  {result.switched && result.branchRecord && !result.branchRecord.ok && (
                    <div className="text-[10px] text-amber-300" title={result.branchRecord.code || ""}>
                      ⚠ 故事点 worktree 分支记录未能同步：{result.branchRecord.error || "未知原因"}（分支已切换，刷新页面后显示新分支；如持续失败请在「工程配置」中核对）
                    </div>
                  )}
                  {result.switched === false && (
                    <div className="text-[10px] text-amber-300">
                      ⚠ 故事点 worktree 未切到新分支：{result.branchRecord?.error || "未知原因"}（新分支已 push 成功；可手动切到 <span className="font-mono">{result.newBranch}</span> 后刷新，再删除旧远程）
                    </div>
                  )}
                  {result.cleanupWarning && (
                    <div className="text-[10px] text-amber-300/90">⚠ {result.cleanupWarning}</div>
                  )}

                  {/* 删除旧远程分支（仅本地=远程一致时允许，需输入 YES，带新分支授权） */}
                  {result.pushed && result.oldRemoteExists && result.deleteRemoteOldAllowed !== false && (
                    <div className="mt-1 rounded-lg border border-amber-500/30 bg-amber-950/20 p-2.5">
                      <div className="text-[10px] text-amber-200">
                        检测到旧远程分支 <span className="font-mono">origin/{result.oldBranch}</span>。新分支已推送成功，是否删除旧远程分支？（本地旧分支 <span className="font-mono">{result.oldBranch}</span> 永久保留，仅删除远程）
                      </div>
                      <div className="mt-1.5 flex items-center gap-2">
                        <input
                          value={confirmText}
                          onChange={(e) => setConfirmText(e.target.value)}
                          placeholder={`输入 YES 确认删除 origin/${result.oldBranch}`}
                          className="min-w-[200px] flex-1 rounded border border-zinc-700 bg-zinc-800 px-2 py-1 font-mono text-[11px] text-zinc-200 outline-none placeholder-zinc-600 focus:border-red-500"
                        />
                        <button
                          onClick={doDeleteRemote}
                          disabled={confirmText !== "YES" || deleting || result.oldRemoteDeleted}
                          className="rounded-md border border-red-700/40 bg-red-700/30 px-2.5 py-1 text-[11px] text-red-200 transition hover:bg-red-600/40 disabled:cursor-not-allowed disabled:opacity-40"
                        >
                          {deleting ? "删除中…" : result.oldRemoteDeleted ? "已删除" : "🗑 删除远程分支"}
                        </button>
                      </div>
                      {result.oldRemoteDeleted && <div className="mt-1 text-[10px] text-emerald-300">✓ 已删除远程分支 origin/{result.oldBranch}</div>}
                    </div>
                  )}
                  {result.pushed && result.oldRemoteExists && result.deleteRemoteOldAllowed === false && (
                    <div className="text-[10px] text-zinc-500">旧远程分支 origin/{result.oldBranch} 保留：本地与远程不一致，出于安全不删除（如需删除请先同步）。</div>
                  )}
                  {result.pushed && !result.oldRemoteExists && (
                    <div className="text-[10px] text-zinc-500">无旧远程分支（原分支从未推送），仅推送了新的 MR 分支。</div>
                  )}
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
