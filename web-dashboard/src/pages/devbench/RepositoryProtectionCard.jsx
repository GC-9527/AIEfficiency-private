import React, { useCallback, useEffect, useMemo, useState } from "react";
import { devbenchApi } from "./api.js";
import {
  buildRemoteRewriteConfirmation,
  isRemoteHistoryRewritePreview,
  remoteRewriteImpactView,
} from "./repositoryProtectionModel.mjs";

const STATUS_COLORS = {
  STRONG: "text-emerald-300 border-emerald-700/50 bg-emerald-950/20",
  ACTIVE: "text-emerald-300 border-emerald-700/50 bg-emerald-950/20",
  UP_TO_DATE: "text-emerald-300 border-emerald-700/50 bg-emerald-950/20",
  LATEST: "text-emerald-300 border-emerald-700/50 bg-emerald-950/20",
  ADVISORY: "text-amber-300 border-amber-700/50 bg-amber-950/20",
  DEGRADED: "text-red-300 border-red-700/50 bg-red-950/20",
  DRIFTED: "text-red-300 border-red-700/50 bg-red-950/20",
  RECOVERY_REQUIRED: "text-red-300 border-red-700/50 bg-red-950/20",
  NOT_INSTALLED: "text-zinc-400 border-zinc-700 bg-zinc-900/60",
};

function payload(response) {
  return response?.data && typeof response.data === "object" ? response.data : response;
}

function badge(value, fallback = "UNKNOWN") {
  const label = String(value || fallback);
  const style = STATUS_COLORS[label]
    || (label.startsWith("BLOCKED") ? STATUS_COLORS.ADVISORY : "text-zinc-300 border-zinc-700 bg-zinc-900/60");
  return <span className={`rounded border px-1.5 py-0.5 font-mono text-[9px] ${style}`}>{label}</span>;
}

function shortSha(value) {
  const sha = String(value || "").trim();
  return sha ? sha.slice(0, 12) : "—";
}

function branchFromEntry(entry = {}) {
  return String(entry.sourceRef || "").replace(/^refs\/heads\//, "")
    || String(entry.originalBranch || "").replace(/^refs\/heads\//, "")
    || String(entry.baseRef || "").replace(/^refs\/heads\//, "");
}

function controllerOperationKey() {
  const random = globalThis.crypto?.randomUUID?.()
    || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  return `git-controller-${random}`;
}

export default function RepositoryProtectionCard({ tab, onToast, onRefreshTab }) {
  const entry = useMemo(
    () => (tab?.worktree?.entries || []).find((item) => item?.role === "primary")
      || (tab?.worktree?.entries || [])[0]
      || null,
    [tab?.worktree?.entries],
  );
  const repositoryId = String(entry?.controllerRepositoryId || entry?.repositoryId || "").trim();
  const repositoryMode = String(
    entry?.repositoryMode || tab?.worktree?.repositoryMode || "LEGACY_LINKED_WORKTREE",
  );
  const branch = branchFromEntry(entry);
  const [protection, setProtection] = useState(null);
  const [sync, setSync] = useState(null);
  const [pending, setPending] = useState(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");

  const reload = useCallback(async () => {
    if (!repositoryId) return;
    const [protectionResponse, syncResponse] = await Promise.all([
      devbenchApi.repositoryProtection(repositoryId, tab?.id),
      devbenchApi.repositorySyncStatus(repositoryId),
    ]);
    setProtection(protectionResponse?.ok === false ? null : payload(protectionResponse));
    setSync(syncResponse?.ok === false ? null : payload(syncResponse));
    setError(
      protectionResponse?.ok === false && syncResponse?.ok === false
        ? (protectionResponse.error || syncResponse.error || "Controller 状态不可用")
        : "",
    );
  }, [repositoryId, tab?.id]);

  useEffect(() => {
    let active = true;
    if (!repositoryId) return undefined;
    Promise.all([
      devbenchApi.repositoryProtection(repositoryId, tab?.id),
      devbenchApi.repositorySyncStatus(repositoryId),
    ]).then(([p, s]) => {
      if (!active) return;
      setProtection(p?.ok === false ? null : payload(p));
      setSync(s?.ok === false ? null : payload(s));
      if (p?.ok === false && s?.ok === false) setError(p.error || s.error || "Controller 状态不可用");
    });
    return () => { active = false; };
  }, [repositoryId, tab?.id]);

  async function preview(kind) {
    setBusy(kind);
    setError("");
    let response;
    if (kind === "remote") response = await devbenchApi.previewRemoteRefresh(repositoryId, branch);
    else if (kind === "base") response = await devbenchApi.previewBaseSync(repositoryId, branch);
    else if (kind === "baseline") response = await devbenchApi.previewStoryBaselineRefresh(tab.id, repositoryId);
    else if (kind === "hooks-install") response = await devbenchApi.previewHooksInstall(repositoryId);
    else if (kind === "hooks-uninstall") response = await devbenchApi.previewHooksUninstall(repositoryId);
    if (response?.ok === false) {
      setError(response.error || "预览失败");
      onToast?.(response.error || "预览失败");
    } else {
      setPending({
        kind,
        value: payload(response),
        idempotencyKey: controllerOperationKey(),
      });
    }
    setBusy("");
  }

  async function executePending({ approveRemoteHistory = false } = {}) {
    if (!pending) return;
    setBusy(pending.kind);
    let response;
    if (pending.kind === "remote") {
      let administrativeApproval = null;
      if (approveRemoteHistory) {
        const relationship = String(pending.value?.relationship || "");
        if (!isRemoteHistoryRewritePreview(pending.value)) {
          setBusy("");
          setError("当前预览不是可管理员审批的远端历史改写");
          return;
        }
        const impact = remoteRewriteImpactView(pending.value);
        if (!impact.approvalAllowed) {
          const message = impact.approvalBlockers.join("；") || "本次远端历史改写不可批准";
          setBusy("");
          setError(message);
          onToast?.(message);
          return;
        }
        const confirmed = globalThis.confirm?.(buildRemoteRewriteConfirmation(pending.value));
        if (!confirmed) {
          setBusy("");
          return;
        }
        const approvedAt = Date.now();
        administrativeApproval = {
          approvalId: controllerOperationKey(),
          approvedAt,
          expiresAt: Math.min(
            Number(pending.value?.expiresAt || approvedAt + 5 * 60_000),
            approvedAt + 5 * 60_000,
          ),
          relationship,
          previewId: pending.value?.previewId,
          previewVersion: pending.value?.previewVersion,
          previousSha: impact.previousSha,
          candidateSha: impact.candidateSha,
          impactDigest: impact.digest,
        };
      }
      response = await devbenchApi.executeRemoteRefresh(
        repositoryId,
        pending.value,
        pending.idempotencyKey,
        administrativeApproval,
      );
    } else if (pending.kind === "base") {
      response = await devbenchApi.executeBaseSync(
        repositoryId,
        pending.value,
        pending.idempotencyKey,
      );
    } else if (pending.kind === "baseline") {
      response = await devbenchApi.refreshStoryBaseline(
        tab.id,
        pending.value,
        pending.idempotencyKey,
      );
    } else if (pending.kind === "hooks-install") {
      response = await devbenchApi.installHooks(
        repositoryId,
        pending.value,
        pending.idempotencyKey,
      );
    } else if (pending.kind === "hooks-uninstall") {
      response = await devbenchApi.uninstallHooks(
        repositoryId,
        pending.value,
        pending.idempotencyKey,
      );
    }
    setBusy("");
    if (response?.ok === false) {
      setError(response.error || "执行失败");
      onToast?.(response.error || "执行失败");
      return;
    }
    setPending(null);
    onToast?.("Controller 操作已完成并通过执行后验证");
    await reload();
    onRefreshTab?.();
  }

  async function diagnoseHooks() {
    setBusy("diagnose");
    const response = await devbenchApi.diagnoseHooks(repositoryId);
    setBusy("");
    if (response?.ok === false) {
      setError(response.error || "Hooks 诊断失败");
      return;
    }
    const value = payload(response);
    setProtection((current) => ({ ...(current || {}), hooks: value }));
    onToast?.(`Hooks：${value?.status || "诊断完成"}`);
  }

  if (!entry) return null;
  if (!repositoryId) {
    return (
      <div className="rounded-md border border-amber-800/50 bg-amber-950/20 px-3 py-2 text-[10px] text-amber-200">
        Legacy 故事点未绑定 Controller repositoryId；仅允许只读检查，不能执行受管 Git 写操作。
      </div>
    );
  }

  const isolation = protection?.isolationLevel || protection?.aiIsolation || protection?.isolation?.level
    || (repositoryMode === "INDEPENDENT_REPOSITORY" ? "DEGRADED" : "ADVISORY");
  const mirror = sync?.mirrorStatus || sync?.mirror?.status || protection?.mirrorStatus || "UNKNOWN";
  const baseStatus = sync?.status || sync?.baseStatus || "UNKNOWN";
  const hooksStatus = protection?.hooks?.status || protection?.hooksStatus || "NOT_INSTALLED";
  const acceptedSha = sync?.acceptedSha || sync?.candidateSha || entry?.baseRevision;
  const baseSha = sync?.baseHead || sync?.head || "";
  const pendingIsRemoteRewrite = pending?.kind === "remote"
    && isRemoteHistoryRewritePreview(pending.value);
  const pendingRewriteImpact = pendingIsRemoteRewrite
    ? remoteRewriteImpactView(pending.value)
    : null;
  const pendingCurrentSha = pending?.value?.expectedHead
    || pending?.value?.lastAcceptedSha
    || pending?.value?.expectedBaseRevision;
  const pendingCandidateSha = pending?.value?.candidateSha;
  const pendingExecutionDisabled = (
    pending?.value?.eligible === false
    && !(pendingIsRemoteRewrite && pendingRewriteImpact?.approvalAllowed)
  )
    || pending?.value?.canUninstall === false
    || (pendingIsRemoteRewrite && !pendingRewriteImpact?.approvalAllowed)
    || !!busy;

  return (
    <div className="rounded-md border border-zinc-700/80 bg-zinc-950/65 px-3 py-2.5" data-testid="repository-protection-card">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[11px] font-medium text-zinc-200">{entry.name || repositoryId}</span>
        <span className="font-mono text-[9px] text-zinc-600" title={repositoryId}>{repositoryId}</span>
        <span className="ml-auto font-mono text-[9px] text-zinc-500">{repositoryMode}</span>
      </div>
      <div className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1.5 text-[10px] lg:grid-cols-5">
        <div className="flex items-center gap-1.5"><span className="text-zinc-500">AI 隔离</span>{badge(isolation)}</div>
        <div className="flex items-center gap-1.5"><span className="text-zinc-500">Mirror</span>{badge(mirror)}</div>
        <div className="truncate text-zinc-400" title={acceptedSha}>远端 {branch || "—"} · <span className="font-mono">{shortSha(acceptedSha)}</span></div>
        <div className="truncate text-zinc-400" title={baseSha}>基础仓库 · <span className="font-mono">{shortSha(baseSha)}</span> {badge(baseStatus)}</div>
        <div className="flex items-center gap-1.5"><span className="text-zinc-500">Hooks</span>{badge(hooksStatus)}</div>
      </div>
      <div className="mt-2 flex flex-wrap gap-1.5">
        <button disabled={!!busy || !branch} onClick={() => preview("remote")} className="rounded bg-blue-700/70 px-2 py-1 text-[10px] text-blue-50 disabled:opacity-40">刷新远端</button>
        <button disabled={!!busy || !branch} onClick={() => preview("base")} className="rounded bg-teal-700/70 px-2 py-1 text-[10px] text-teal-50 disabled:opacity-40">同步基础仓库</button>
        <button disabled={!!busy || repositoryMode !== "INDEPENDENT_REPOSITORY"} onClick={() => preview("baseline")} className="rounded bg-violet-700/70 px-2 py-1 text-[10px] text-violet-50 disabled:opacity-40">刷新故事点基线</button>
        <button disabled={!!busy} onClick={diagnoseHooks} className="rounded bg-zinc-700 px-2 py-1 text-[10px] text-zinc-200 disabled:opacity-40">诊断 Hooks</button>
        {hooksStatus === "NOT_INSTALLED"
          ? <button disabled={!!busy} onClick={() => preview("hooks-install")} className="rounded bg-zinc-700 px-2 py-1 text-[10px] text-zinc-200 disabled:opacity-40">安装 Hooks</button>
          : <button disabled={!!busy} onClick={() => preview("hooks-uninstall")} className="rounded bg-zinc-800 px-2 py-1 text-[10px] text-amber-200 disabled:opacity-40">卸载 Hooks</button>}
      </div>
      {pending && (
        <div className="mt-2 rounded border border-amber-700/40 bg-amber-950/20 p-2 text-[10px] text-zinc-300">
          <div className="break-words">
            预览版本 <span className="font-mono">{pending.value?.previewVersion ?? "—"}</span>
            {" · "}当前 <span className="break-all font-mono">{pendingIsRemoteRewrite ? (pendingCurrentSha || "—") : shortSha(pendingCurrentSha)}</span>
            {" → "}目标 <span className="break-all font-mono text-amber-200">{pendingIsRemoteRewrite ? (pendingCandidateSha || "—") : shortSha(pendingCandidateSha)}</span>
          </div>
          {(pending.value?.blockerCode || pending.value?.reasonCode) && (
            <div className="mt-1 text-amber-300">{pending.value.blockerCode || pending.value.reasonCode}</div>
          )}
          {pendingIsRemoteRewrite && pendingRewriteImpact && (
            <div
              className="mt-2 space-y-2 rounded border border-red-800/60 bg-red-950/25 p-2"
              data-testid="remote-rewrite-impact"
            >
              <div className="font-medium text-red-200">
                远端历史已回退或分叉；批准将严格绑定本次完整 SHA、影响摘要、预览版本和短时有效期。
              </div>
              <dl className="space-y-1 text-zinc-300">
                <div>
                  <dt className="inline text-zinc-500">旧 SHA（完整） </dt>
                  <dd className="inline break-all font-mono text-red-200">{pendingRewriteImpact.previousSha || "未返回"}</dd>
                </div>
                <div>
                  <dt className="inline text-zinc-500">新 SHA（完整） </dt>
                  <dd className="inline break-all font-mono text-red-200">{pendingRewriteImpact.candidateSha || "未返回"}</dd>
                </div>
                <div>
                  <dt className="inline text-zinc-500">影响摘要 digest </dt>
                  <dd className="inline break-all font-mono">{pendingRewriteImpact.digest || "未返回"}</dd>
                </div>
              </dl>
              <div>
                <div className="text-zinc-400">
                  丢失提交总数：
                  <span className="font-mono text-red-200">
                    {Number.isSafeInteger(pendingRewriteImpact.droppedCommitCount)
                      ? pendingRewriteImpact.droppedCommitCount
                      : "未返回"}
                  </span>
                  {" · "}返回 {pendingRewriteImpact.droppedCommits.length} 项
                  {" · "}{pendingRewriteImpact.droppedCommitsTruncated ? "列表已截断" : "列表未截断"}
                </div>
                {pendingRewriteImpact.droppedCommits.length > 0 ? (
                  <ul className="mt-1 space-y-0.5">
                    {pendingRewriteImpact.droppedCommits.map((commit, index) => (
                      <li key={`${commit}-${index}`} className="break-all font-mono text-red-200">
                        {commit}
                      </li>
                    ))}
                  </ul>
                ) : <div className="mt-1 text-zinc-500">无返回项</div>}
              </div>
              <div>
                <div className="text-zinc-400">
                  受影响故事：返回 {pendingRewriteImpact.affectedStories.length} 项
                  {" · "}{pendingRewriteImpact.affectedStoriesTruncated ? "列表已截断" : "列表未截断"}
                </div>
                {pendingRewriteImpact.affectedStories.length > 0 ? (
                  <ul className="mt-1 space-y-0.5">
                    {pendingRewriteImpact.affectedStories.map((story, index) => (
                      <li key={`${story.storyId}-${index}`} className="break-all">
                        <span className="text-amber-200">{story.storyId || "未返回 storyId"}</span>
                        {" · baseRevision "}
                        <span className="font-mono">{story.baseRevision || "未返回"}</span>
                      </li>
                    ))}
                  </ul>
                ) : <div className="mt-1 text-zinc-500">无返回项</div>}
              </div>
              <div>
                <div className="text-zinc-400">
                  发布提交状态：
                  <span className={`font-mono ${
                    pendingRewriteImpact.publishedCommitStatus === "UNKNOWN"
                      ? "text-red-300"
                      : "text-amber-200"
                  }`}>
                    {pendingRewriteImpact.publishedCommitStatus}
                  </span>
                  {" · "}返回 {pendingRewriteImpact.publishedCommits.length} 项
                  {" · "}{pendingRewriteImpact.publishedCommitsTruncated ? "列表已截断" : "列表未截断"}
                </div>
                {pendingRewriteImpact.publishedCommits.length > 0 ? (
                  <ul className="mt-1 space-y-0.5">
                    {pendingRewriteImpact.publishedCommits.map((commit, index) => (
                      <li key={`${commit}-${index}`} className="break-all font-mono text-amber-200">
                        {commit}
                      </li>
                    ))}
                  </ul>
                ) : <div className="mt-1 text-zinc-500">无返回项</div>}
              </div>
              {pendingRewriteImpact.publishedCommitStatus === "UNKNOWN" && (
                <div className="font-medium text-red-300">
                  发布提交状态为 UNKNOWN；安全策略已阻断批准，请先完成发布状态核验并重新预览。
                </div>
              )}
              {!pendingRewriteImpact.approvalAllowed && (
                <div className="text-red-300">
                  {pendingRewriteImpact.approvalBlockers.join("；") || "本次影响不可批准"}
                </div>
              )}
            </div>
          )}
          <div className="mt-2 flex gap-1.5">
            <button
              disabled={pendingExecutionDisabled}
              onClick={() => executePending({
                approveRemoteHistory: pendingIsRemoteRewrite,
              })}
              className={`rounded px-2 py-1 text-[10px] text-white disabled:opacity-40 ${
                pendingIsRemoteRewrite
                  ? "bg-red-700"
                  : "bg-amber-600"
              }`}
            >
              {pendingIsRemoteRewrite ? "确认管理员批准并执行" : "确认执行"}
            </button>
            <button disabled={!!busy} onClick={() => setPending(null)} className="rounded bg-zinc-700 px-2 py-1 text-[10px] text-zinc-200">取消</button>
          </div>
        </div>
      )}
      {error && <div className="mt-2 text-[10px] text-red-300">{error}</div>}
    </div>
  );
}
