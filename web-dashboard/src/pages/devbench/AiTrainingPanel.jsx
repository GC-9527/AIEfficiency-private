import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { devbenchApi } from "./api.js";
import ConfigInferenceReview from "./ConfigInferenceReview.jsx";
import RagMemoryPanel from "./RagMemoryPanel.jsx";
import {
  configInferenceReviewRecovery,
  configInferenceRunProjectId,
  recoveredReviewSession,
} from "./configInferenceReviewModel.mjs";
import {
  annotationGovernance,
  confidencePresentation,
  evaluationSummary,
  governanceSummary,
  trainingMetricSummary,
} from "./aiTrainingGovernanceModel.mjs";

const POOLS = [
  { value: "staged", label: "TB 候选", detail: "尚未加入待办的候选单" },
  { value: "pending", label: "待开发", detail: "已加入任务且未完成" },
  { value: "completed", label: "已完成", detail: "历史完成任务" },
  { value: "all", label: "全部 TB 单", detail: "全部已同步工单" },
];

const SIGNAL_GROUPS = [
  ["title", "标题"],
  ["project", "项目"],
  ["iteration", "迭代"],
  ["tag", "标签"],
  ["attachment", "附件"],
  ["comment", "评论"],
];

const DIMENSIONS = [
  ["appName", "应用名"],
  ["vehicle", "车型"],
  ["repositoryId", "Git 仓库"],
  ["branch", "分支"],
  ["flavor", "Flavor"],
];

const REPOSITORY_ONLY_TYPES = new Set(["sdk", "tooling", "service", "repository"]);

function isRepositoryOnlyTarget(target) {
  return target?.repositoryOnly === true || REPOSITORY_ONLY_TYPES.has(String(target?.projectType || "").trim().toLowerCase());
}

function targetRole(target, index = 0) {
  const role = String(target?.targetRole || "").trim().toLowerCase();
  return ["primary", "dependency", "standalone"].includes(role) ? role : index === 0 ? "primary" : "dependency";
}

function targetRoleLabel(role, compact = false) {
  if (role === "primary") return compact ? "主" : "主工程";
  if (role === "standalone") return compact ? "独立" : "独立工程";
  return compact ? "依赖" : "依赖工程";
}

function symbolicFields(target) {
  const states = target?.fieldStates && typeof target.fieldStates === "object" ? target.fieldStates : {};
  return Object.entries(states).filter(([, state]) => state?.kind === "symbolic").map(([field]) => field);
}

function symbolicFieldCount(targets) {
  return (targets || []).reduce((sum, target) => sum + symbolicFields(target).length, 0);
}

function targetBindingKeys(target) {
  const bindings = target?.fieldBindings && typeof target.fieldBindings === "object" ? target.fieldBindings : {};
  return Object.values(bindings).map((binding) => String(binding?.logicalKey || "").trim()).filter(Boolean);
}

function formatTime(value) {
  if (!value) return "-";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "-" : date.toLocaleString();
}

function percent(value) {
  if (value === null || value === undefined || value === "") return "-";
  const number = Number(value);
  if (!Number.isFinite(number)) return "-";
  return `${Math.round((number <= 1 ? number * 100 : number))}%`;
}

function decisionMeta(decision) {
  return {
    correct: { label: "推理正确", cls: "text-emerald-300" },
    corrected: { label: "已人工纠正", cls: "text-cyan-300" },
    insufficient: { label: "信息不足", cls: "text-amber-300" },
    ticket_wrong: { label: "工单内容有误", cls: "text-rose-300" },
  }[decision] || { label: "待复核", cls: "text-amber-400" };
}

function triggerLabel(trigger) {
  return {
    training_random: "随机训练",
    task_execute: "执行开发",
    task_execute_again: "再次执行",
    task_reopen: "再次开发",
    task_reopened: "任务故事点重开",
    task_reopened_after_copy: "复制后复核",
    task_created: "任务故事点新建",
    task_group_execute: "任务组执行",
    tab_create: "新建故事点",
    story_created: "新建故事点",
    story_copied: "复制新建",
    tab_reopen: "重新打开",
    story_reopened: "重新打开",
    manual: "手工推断",
  }[trigger] || trigger || "配置推断";
}

function Metric({ label, value, detail, tone = "text-zinc-100" }) {
  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900/45 px-3 py-2.5">
      <div className="text-[10px] text-zinc-500">{label}</div>
      <div className="mt-1 flex min-w-0 items-baseline gap-2">
        <span className={`text-xl font-semibold ${tone}`}>{value}</span>
        {detail ? <span className="min-w-0 truncate text-[9px] text-zinc-600" title={detail}>{detail}</span> : null}
      </div>
    </div>
  );
}

function GovernanceEvaluationSummary({ governance, evaluation, metricSummary }) {
  return (
    <div className="grid gap-3 xl:grid-cols-2">
      <section data-testid="ai-training-governance-summary" className="rounded-xl border border-cyan-900/45 bg-gradient-to-r from-cyan-950/20 via-zinc-900/30 to-zinc-950/30 p-3 sm:p-4">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-[12px] font-medium text-zinc-200">标注与 Serving 治理</h2>
          {governance.release ? <span className="rounded border border-violet-900/60 bg-violet-950/25 px-2 py-0.5 text-[8px] text-violet-300">Active release · {governance.release}</span> : <span className="rounded border border-amber-900/60 bg-amber-950/20 px-2 py-0.5 text-[8px] text-amber-300">尚无版本化 Serving release</span>}
        </div>
        <div className="mt-3 grid grid-cols-2 gap-1.5 sm:grid-cols-5">
          {[
            ["待标注", governance.unreviewed, "text-amber-300"],
            ["Annotation", governance.annotation, "text-cyan-300"],
            ["Approved", governance.approved, "text-emerald-300"],
            ["Active", governance.active, "text-violet-300"],
            ["Revoked", governance.revoked, "text-rose-300"],
          ].map(([label, value, tone]) => <div key={label} className="rounded border border-zinc-800 bg-zinc-950/45 px-2 py-1.5"><div className="text-[8px] text-zinc-600">{label}</div><div className={`mt-0.5 text-sm font-semibold ${tone}`}>{value}</div></div>)}
        </div>
        <p className="mt-2 text-[9px] leading-relaxed text-zinc-600">人工复核先形成 annotation；只有 Approved/Active 数据可进入治理版 serving。撤销保留审计历史，不等同于删除 run。</p>
      </section>

      <section data-testid="ai-training-evaluation-summary" className="rounded-xl border border-violet-900/45 bg-gradient-to-r from-violet-950/20 via-zinc-900/30 to-zinc-950/30 p-3 sm:p-4">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-[12px] font-medium text-zinc-200">冻结数据集评测</h2>
          {evaluation.available ? <span className="rounded border border-emerald-900/60 bg-emerald-950/25 px-2 py-0.5 text-[8px] text-emerald-300">{evaluation.datasetVersion || evaluation.id || "已评测"} · {evaluation.cases} cases</span> : <span className="rounded border border-amber-900/60 bg-amber-950/20 px-2 py-0.5 text-[8px] text-amber-300">未建立独立 Golden Set 结果</span>}
        </div>
        <div className="mt-3 grid grid-cols-2 gap-1.5 sm:grid-cols-4">
          {[
            ["完整目标图", evaluation.available ? percent(evaluation.targetGraphExactRate) : "-", "targetId/角色/顺序/五维整体"],
            ["Repo Top-3", evaluation.available ? percent(evaluation.repositoryTop3Recall) : "-", "候选召回"],
            ["Coverage", evaluation.available ? percent(evaluation.coverage) : percent(metricSummary.coverage), "系统愿意给出结果的比例"],
            ["ECE", evaluation.available && evaluation.ece !== null ? evaluation.ece.toFixed(3) : metricSummary.ece !== null ? metricSummary.ece.toFixed(3) : "-", "概率校准误差"],
          ].map(([label, value, detail]) => <div key={label} className="rounded border border-zinc-800 bg-zinc-950/45 px-2 py-1.5" title={detail}><div className="text-[8px] text-zinc-600">{label}</div><div className="mt-0.5 text-sm font-semibold text-zinc-300">{value}</div></div>)}
        </div>
        <p className="mt-2 text-[9px] leading-relaxed text-zinc-600">没有冻结、时间切分的数据集时，不展示“完整目标图准确率”；在线人工同意率不能替代泛化评测。</p>
      </section>
    </div>
  );
}

function ReviewedRun({ run, onNext, onResolveSymbols, onGovernance, governanceBusy = false, isAdmin = false, running, nextLabel = "返回" }) {
  const [governanceReason, setGovernanceReason] = useState("");
  const review = run.review || {};
  const decision = decisionMeta(review.decision);
  const governance = annotationGovernance(run);
  const targets = review.correctedPrediction?.targets || run.prediction?.targets || [];
  const configurationUpdates = review.configurationUpdates || run.configurationUpdates || {};
  const unresolvedCount = symbolicFieldCount(targets);
  const updateCount = ["repositories", "applications", "vehicles", "branches", "flavors"]
    .reduce((sum, key) => sum + (Array.isArray(configurationUpdates[key]) ? configurationUpdates[key].length : 0), 0);
  return (
    <div className="overflow-hidden rounded-xl border border-emerald-900/60 bg-emerald-950/10">
      <div className="flex flex-wrap items-center gap-2 border-b border-zinc-800 px-4 py-3">
        <span className="text-sm text-emerald-300">✓ 本条训练已复核</span>
        <span className={`text-[10px] ${decision.cls}`}>{decision.label}</span>
        <span className={`rounded border px-1.5 py-0.5 text-[8px] ${governance.meta.border} ${governance.meta.tone}`}>{governance.meta.label}</span>
        <span className="rounded border border-amber-800/60 bg-amber-950/30 px-1.5 py-0.5 text-[9px] text-amber-300">{review.rating || "-"}★</span>
        <span className="ml-auto text-[9px] text-zinc-600">{formatTime(review.reviewedAt || run.updatedAt)}</span>
      </div>
      <div className="space-y-3 p-4">
        {configurationUpdates.changed ? (
          <div data-testid="config-update-summary" className="rounded-md border border-cyan-900/60 bg-cyan-950/25 px-3 py-2 text-[10px] text-cyan-300">
            自定义值已写入仓库定义和车型源码配置{updateCount ? `（${updateCount} 项候选更新）` : ""}{configurationUpdates.orderUpdated ? "，工程顺序已同步" : ""}
          </div>
        ) : null}
        {unresolvedCount ? (
          <div data-testid="config-symbolic-summary" className="rounded-md border border-amber-800/60 bg-amber-950/25 px-3 py-2 text-[10px] text-amber-300">
            当前还有 {unresolvedCount} 个代号/中间值待替换。AI 已学习这些特征，但整组工程尚未写入真实仓库定义和车型源码配置。
          </div>
        ) : null}
        <div data-testid="config-annotation-governance" className="rounded-md border border-zinc-800 bg-zinc-950/35 p-2.5">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[10px] font-medium text-zinc-300">Annotation 治理</span>
            {governance.legacy ? <span className="rounded border border-amber-900/50 px-1.5 py-0.5 text-[8px] text-amber-400">旧版记录待迁移</span> : null}
            <span className="text-[8px] text-zinc-600">审批、撤销、恢复都生成审计事件，不物理删除历史。</span>
          </div>
          <div className="mt-2 flex flex-col gap-1.5 sm:flex-row">
            <input value={governanceReason} onChange={(event) => setGovernanceReason(event.target.value)} disabled={!isAdmin || governanceBusy} placeholder="操作原因（必填）" className="min-w-0 flex-1 rounded border border-zinc-700 bg-zinc-950 px-2 py-1.5 text-[9px] text-zinc-200 outline-none placeholder:text-zinc-700 disabled:opacity-50" />
            {governance.canApprove ? <button type="button" onClick={() => onGovernance?.(run, "approve", governanceReason)} disabled={!isAdmin || governanceBusy || !governance.id || !governanceReason.trim()} className="rounded border border-emerald-900/70 px-2.5 py-1.5 text-[9px] text-emerald-300 hover:bg-emerald-950/30 disabled:opacity-35">审批</button> : null}
            {governance.canRevoke ? <button type="button" onClick={() => onGovernance?.(run, "revoke", governanceReason)} disabled={!isAdmin || governanceBusy || !governance.id || !governanceReason.trim()} className="rounded border border-rose-900/70 px-2.5 py-1.5 text-[9px] text-rose-300 hover:bg-rose-950/30 disabled:opacity-35">撤销</button> : null}
            {governance.canRestore ? <button type="button" onClick={() => onGovernance?.(run, "restore", governanceReason)} disabled={!isAdmin || governanceBusy || !governance.id || !governanceReason.trim()} className="rounded border border-cyan-900/70 px-2.5 py-1.5 text-[9px] text-cyan-300 hover:bg-cyan-950/30 disabled:opacity-35">恢复为新标注</button> : null}
          </div>
          {!governance.id ? <div className="mt-1.5 text-[8px] text-amber-600">当前记录没有 annotationId；需由 v2 迁移生成 ID 后才能执行审批、撤销或恢复。</div> : null}
        </div>
        <div>
          <div className="text-[10px] text-zinc-500">{run.ticket?.ticketId || run.ticket?.tbTaskId || "TB 单"}</div>
          <div className="mt-0.5 text-[12px] text-zinc-200">{run.ticket?.title || "无标题"}</div>
          {run.trainingSource?.url ? <div className="mt-1 truncate text-[9px] text-cyan-500" title={run.trainingSource.url}>训练来源：{run.trainingSource.name || run.trainingSource.sectionId || run.trainingSource.type}</div> : null}
        </div>
        {targets.length ? (
          <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-3">
            {targets.map((target, index) => {
              const role = targetRole(target, index);
              return (
                <div key={`${target.repositoryId || "target"}_${target.branch || ""}_${index}`} className="rounded-md border border-zinc-800 bg-zinc-950/45 px-3 py-2 text-[10px]">
                  <div className="flex items-center gap-1.5">
                    <span className={`shrink-0 rounded border px-1 py-0.5 text-[8px] ${role === "primary" ? "border-cyan-900/70 text-cyan-400" : role === "standalone" ? "border-emerald-900/70 text-emerald-400" : "border-violet-900/70 text-violet-400"}`}>{targetRoleLabel(role)}</span>
                    <div className="truncate text-zinc-200" title={target.repositoryName || target.repositoryId}>{target.repositoryName || target.repositoryId || "未指定仓库"}</div>
                  </div>
                  <div className="mt-1 truncate font-mono text-zinc-500">{target.branch || "分支未定"} · {target.flavor || (isRepositoryOnlyTarget(target) ? "Flavor 可选" : "Flavor 未定")}</div>
                  <div className="mt-1 text-zinc-600">{isRepositoryOnlyTarget(target) ? "无独立应用 · 车型不适用" : `${target.appName || "应用未定"} · ${target.vehicle || "车型未定"}`}</div>
                  {targetBindingKeys(target).length ? <div className="mt-1 truncate font-mono text-[8px] text-cyan-700" title={targetBindingKeys(target).join(" · ")}>▣ {targetBindingKeys(target).length} 个永久 Key · 实际值可替换</div> : null}
                  {symbolicFields(target).length ? <div className="mt-1 text-[9px] text-amber-400">待替换：{symbolicFields(target).join("、")}</div> : null}
                </div>
              );
            })}
          </div>
        ) : <div className="rounded border border-zinc-800 bg-zinc-950/30 p-3 text-[10px] text-zinc-600">本次结论未产生可学习的工程配置目标。</div>}
        <div className="flex justify-end">
          {unresolvedCount && onResolveSymbols ? <button type="button" data-testid="config-symbols-resolve" onClick={onResolveSymbols} disabled={running} className="mr-2 rounded border border-amber-700 bg-amber-950/25 px-3 py-1.5 text-[11px] text-amber-300 hover:bg-amber-950/45 disabled:opacity-45">替换代号</button> : null}
          <button type="button" onClick={onNext} disabled={running} className="rounded bg-cyan-700 px-4 py-1.5 text-[11px] text-white hover:bg-cyan-600 disabled:cursor-not-allowed disabled:bg-zinc-700 disabled:text-zinc-500">
            {running ? "抽取中…" : nextLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

function LatestLearnedResult({ run, onOpenMemory }) {
  if (!run) return null;
  const targets = run.review?.correctedPrediction?.targets || run.prediction?.targets || [];
  const sample = run._learnedSample || null;
  const governance = annotationGovernance(run);
  const keyCount = targets.reduce((sum, target) => sum + targetBindingKeys(target).length, 0);
  return (
    <section data-testid="ai-training-latest-learned" className="overflow-hidden rounded-xl border devbench-status-surface devbench-status-surface--success">
      <div className="flex flex-wrap items-center gap-2 border-b border-zinc-800/80 px-3 py-2.5 sm:px-4">
        <span className="text-[11px] font-medium text-cyan-300">最新人工标注已保存</span>
        <span className={`rounded border px-1.5 py-0.5 text-[8px] ${governance.meta.border} ${governance.meta.tone}`}>{governance.meta.label}</span>
        <span className="rounded border border-zinc-800 bg-zinc-950/30 px-1.5 py-0.5 text-[8px] text-zinc-500">样本 {sample?.id ? "已生成" : "待治理"}</span>
        <span className="text-[9px] text-zinc-600">{keyCount} 个永久 Key</span>
        <button type="button" onClick={onOpenMemory} className="ml-auto rounded border border-cyan-800 bg-cyan-950/25 px-2.5 py-1 text-[9px] text-cyan-300 hover:bg-cyan-900/35">查看 RAG 记忆与映射</button>
      </div>
      <div className="grid gap-2 px-3 py-2.5 sm:grid-cols-[minmax(180px,0.7fr)_minmax(0,1.3fr)] sm:px-4">
        <div className="min-w-0"><div className="text-[9px] text-zinc-600">{run.ticket?.ticketId || run.ticket?.tbTaskId || run.id}</div><div className="mt-0.5 truncate text-[10px] text-zinc-300" title={run.ticket?.title}>{run.ticket?.title || "已保存训练结果"}</div></div>
        <div className="flex min-w-0 flex-wrap gap-1.5">{targets.map((target, index) => {
          const role = targetRole(target, index);
          return <span key={target.targetId || `${target.repositoryId}_${index}`} className="max-w-full truncate rounded border border-zinc-800 bg-zinc-950/55 px-2 py-1 text-[9px] text-zinc-400" title={`${target.repositoryName || target.repositoryId} · ${target.branch} · ${target.flavor}`}><span className={role === "primary" ? "text-cyan-400" : role === "standalone" ? "text-emerald-400" : "text-violet-400"}>{targetRoleLabel(role, true)}</span> · {target.repositoryName || target.repositoryId || target.appName || "无工程"} · {target.branch || "分支未定"}</span>;
        })}</div>
      </div>
    </section>
  );
}

export default function AiTrainingPanel({ projectId, projectName, isAdmin, onToast }) {
  const toastRef = useRef(onToast);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [running, setRunning] = useState(false);
  const [reviewing, setReviewing] = useState(false);
  const [refreshingId, setRefreshingId] = useState("");
  const [deletingId, setDeletingId] = useState("");
  const [governingId, setGoverningId] = useState("");
  const [pool, setPool] = useState("staged");
  const [activeRun, setActiveRun] = useState(null);
  const [sourceUrl, setSourceUrl] = useState("");
  const [sourcePreview, setSourcePreview] = useState(null);
  // null 表示全部 taskflow 状态；数组表示用户明确选择的状态 key（空数组即筛掉全部）。
  const [sourceStatusKeys, setSourceStatusKeys] = useState(null);
  const [sourceLoading, setSourceLoading] = useState(false);
  const [sourceDirty, setSourceDirty] = useState(false);
  const [trainingSession, setTrainingSession] = useState(null);
  const [workspaceTab, setWorkspaceTab] = useState("training");
  const [lastLearnedRun, setLastLearnedRun] = useState(null);
  const trainingSessionRef = useRef(null);
  const randomRequestRef = useRef("");
  const reviewRequestRef = useRef("");
  const refreshRequestRef = useRef("");
  const trainingRetryTimerRef = useRef(null);
  const projectIdRef = useRef(projectId);
  const sourceDirtyRef = useRef(false);
  const autoPreviewSourceRef = useRef("");

  function replaceTrainingSession(next) {
    trainingSessionRef.current = next;
    setTrainingSession(next);
  }

  function clearTrainingRetryTimer() {
    if (trainingRetryTimerRef.current) window.clearTimeout(trainingRetryTimerRef.current);
    trainingRetryTimerRef.current = null;
  }

  useEffect(() => { toastRef.current = onToast; }, [onToast]);

  useEffect(() => {
    const hideDock = () => window.dispatchEvent(new Event("floating-dock:hide"));
    hideDock();
    const timer = window.setTimeout(hideDock, 0);
    return () => {
      const current = trainingSessionRef.current;
      if (current?.id) devbenchApi.exitConfigTrainingSession(current.projectId || projectIdRef.current, current.id).catch(() => {});
      clearTrainingRetryTimer();
      trainingSessionRef.current = null;
      window.clearTimeout(timer);
      window.dispatchEvent(new Event("floating-dock:show"));
    };
  }, []);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const result = await devbenchApi.getConfigInference(projectId);
      if (!result.ok) {
        toastRef.current?.(result.error || "配置推断训练数据加载失败");
        return null;
      }
      setData(result.data);
      return result.data;
    } catch (error) {
      toastRef.current?.(error.message || "配置推断训练数据加载失败");
      return null;
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    const previousSession = trainingSessionRef.current;
    const previousProjectId = projectIdRef.current;
    if (previousSession?.id) devbenchApi.exitConfigTrainingSession(previousProjectId, previousSession.id).catch(() => {});
    projectIdRef.current = projectId;
    clearTrainingRetryTimer();
    replaceTrainingSession(null);
    randomRequestRef.current = "";
    reviewRequestRef.current = "";
    refreshRequestRef.current = "";
    setRunning(false);
    setReviewing(false);
    setRefreshingId("");
    setActiveRun(null);
    setSourceUrl("");
    setSourcePreview(null);
    setSourceStatusKeys(null);
    setSourceDirty(false);
    setWorkspaceTab("training");
    setLastLearnedRun(null);
    sourceDirtyRef.current = false;
    autoPreviewSourceRef.current = "";
    setPool("staged");
    reload();
  }, [reload]);

  useEffect(() => {
    const saved = data?.settings?.taskSource;
    if (sourceDirty || !saved?.url) return;
    setSourceUrl(saved.url);
    setSourcePreview(saved.counts ? {
      source: saved,
      counts: saved.counts,
      statusCounts: saved.statusCounts || [],
      acquisition: saved.acquisition || null,
      cached: true,
    } : null);
    const savedCompletion = String(saved.filter?.completion || "").trim().toLowerCase();
    setPool(["pending", "completed", "all"].includes(savedCompletion) ? savedCompletion : "all");
    setSourceStatusKeys(Array.isArray(saved.filter?.statusKeys) ? saved.filter.statusKeys : null);
    const autoPreviewKey = `${projectId}|${saved.url}`;
    if (autoPreviewSourceRef.current === autoPreviewKey) return;
    autoPreviewSourceRef.current = autoPreviewKey;
    setSourceLoading(true);
    devbenchApi.previewConfigTrainingSource(projectId, saved.url).then((result) => {
      if (projectIdRef.current !== projectId || sourceDirtyRef.current) return;
      if (!result.ok) {
        toastRef.current?.(result.error || "共享 TB 列表自动刷新失败，请检查登录后手动预览");
        return;
      }
      setSourcePreview(result.data);
    }).catch((error) => {
      if (projectIdRef.current === projectId && !sourceDirtyRef.current) {
        toastRef.current?.(error.message || "共享 TB 列表自动刷新失败，请手动预览");
      }
    }).finally(() => {
      if (projectIdRef.current === projectId) setSourceLoading(false);
    });
  }, [data?.settings?.taskSource, sourceDirty]);

  const taskPool = data?.taskPool || {};
  const metrics = data?.metrics || {};
  const metricSummary = trainingMetricSummary(metrics);
  const governance = governanceSummary(data || {});
  const evaluation = evaluationSummary(data || {});
  const hasExplicitSource = !!sourceUrl.trim();
  const sourceCounts = sourcePreview?.counts || {};
  const sourceStatusCounts = Array.isArray(sourcePreview?.statusCounts) ? sourcePreview.statusCounts : [];
  const sourceAcquisition = sourcePreview?.acquisition || sourcePreview?.source?.acquisition || null;
  const sourceReportedTotalRaw = sourceAcquisition?.cookieReportedTotal;
  const sourceReportedTotal = Number(sourceReportedTotalRaw);
  const sourceAcquisitionComplete = sourceAcquisition?.cookieComplete === true
    && sourceReportedTotalRaw !== null
    && sourceReportedTotalRaw !== undefined
    && sourceReportedTotalRaw !== ""
    && Number.isFinite(sourceReportedTotal)
    && sourceReportedTotal === Number(sourceCounts.all || 0);
  const allSourceStatusesSelected = sourceStatusKeys === null;
  const selectedSourceStatusKeys = sourceStatusKeys === null ? null : new Set(sourceStatusKeys);
  const visibleSourceStatusCounts = selectedSourceStatusKeys === null
    ? sourceStatusCounts
    : sourceStatusCounts.filter((row) => selectedSourceStatusKeys.has(row.key));
  const sourceCountForCompletion = (completion) => {
    if (!sourceStatusCounts.length) {
      return Number(completion === "pending" ? sourceCounts.pending : completion === "completed" ? sourceCounts.completed : sourceCounts.all) || 0;
    }
    return visibleSourceStatusCounts.reduce((total, row) => total + Number(completion === "pending" ? row.pending : completion === "completed" ? row.completed : row.count), 0);
  };
  const selectedPool = POOLS.find((item) => item.value === pool) || POOLS[0];
  const currentPoolCount = hasExplicitSource
    ? sourceCountForCompletion(pool)
    : Number(taskPool[pool] || 0);
  const recentRuns = useMemo(() => (data?.runs || []).slice(0, 80), [data?.runs]);
  const trainingActive = trainingSession?.active === true;
  const memorySwitchLocked = trainingActive && !!activeRun && !activeRun.review;

  function openMemoryWorkspace() {
    if (memorySwitchLocked) {
      toastRef.current?.("请先提交当前评分或退出训练，再管理 RAG 实际值；当前填写内容已保留在训练页。");
      return;
    }
    setWorkspaceTab("memory");
  }

  function runWithOptions(run, fallbackData = data) {
    if (!run) return null;
    return { ...run, options: run.options || fallbackData?.options || {} };
  }

  async function requestNextTraining(session, opts = {}) {
    if (!session?.active || randomRequestRef.current) return;
    const requestId = session.id;
    randomRequestRef.current = requestId;
    setRunning(true);
    try {
      const result = await devbenchApi.runRandomConfigTraining(
        session.projectId || projectId,
        session.pool,
        session.sourceUrl,
        session.seenTaskIds,
        session.id,
        session.statusKeys,
      );
      if (projectIdRef.current !== projectId) return;
      const current = trainingSessionRef.current;
      if (!current?.active || current.id !== requestId) return;
      if (!result.ok) {
        replaceTrainingSession({ ...current, active: false, phase: "error" });
        setActiveRun(null);
        toastRef.current?.(result.error || "随机抽取 TB 单失败");
        return;
      }
      const progress = result.data?.random || {};
      if (result.pending || progress.busy) {
        const waitingSession = {
          ...current,
          ...progress,
          active: true,
          complete: false,
          phase: "waiting",
        };
        replaceTrainingSession(waitingSession);
        setActiveRun(null);
        if (current.phase !== "waiting") toastRef.current?.("剩余 TB 单正在其它训练会话中，释放后会自动继续");
        clearTrainingRetryTimer();
        trainingRetryTimerRef.current = window.setTimeout(() => {
          trainingRetryTimerRef.current = null;
          const latest = trainingSessionRef.current;
          if (latest?.active && latest.id === requestId) requestNextTraining(latest);
        }, Math.max(500, Math.min(5000, Number(progress.retryAfterMs) || 1200)));
        return;
      }
      if (result.complete || progress.exhausted) {
        clearTrainingRetryTimer();
        replaceTrainingSession({
          ...current,
          ...progress,
          active: false,
          complete: true,
          remaining: 0,
          phase: "complete",
        });
        setActiveRun(null);
        await reload();
        toastRef.current?.(opts.completeToast || "当前 TB 单列表已全部训练完成，没有重复抽取工单");
        return;
      }
      const taskId = String(progress.currentTaskId || result.data?.ticket?.tbTaskId || result.data?.ticket?.ticketId || "").trim();
      if (!taskId || current.seenTaskIds.includes(taskId)) {
        replaceTrainingSession({ ...current, active: false, phase: "error" });
        setActiveRun(null);
        toastRef.current?.("检测到重复 TB 单，连续训练已停止，请刷新列表后重试");
        return;
      }
      replaceTrainingSession({
        ...current,
        ...progress,
        active: true,
        complete: false,
        phase: "reviewing",
        seenTaskIds: [...current.seenTaskIds, taskId],
      });
      setActiveRun(runWithOptions(result.data));
      reload();
    } catch (error) {
      if (trainingSessionRef.current?.id === requestId) {
        replaceTrainingSession({ ...trainingSessionRef.current, active: false, phase: "error" });
        toastRef.current?.(error.message || "随机抽取 TB 单失败");
      }
    } finally {
      if (randomRequestRef.current === requestId) {
        randomRequestRef.current = "";
        setRunning(false);
      }
    }
  }

  function startRandomTraining() {
    if (running || reviewing || trainingSessionRef.current?.active) return;
    clearTrainingRetryTimer();
    const session = {
      id: `training_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      projectId,
      active: true,
      complete: false,
      phase: "drawing",
      pool,
      sourceUrl: sourceUrl.trim(),
      seenTaskIds: [],
      statusKeys: sourceStatusKeys === null ? null : [...sourceStatusKeys],
      listTotal: hasExplicitSource ? Number(sourceCounts.all || 0) : Number(taskPool.all || 0),
      total: currentPoolCount,
      trained: 0,
      remaining: currentPoolCount,
    };
    replaceTrainingSession(session);
    setActiveRun(null);
    requestNextTraining(session);
  }

  function exitTraining() {
    const current = trainingSessionRef.current;
    clearTrainingRetryTimer();
    replaceTrainingSession(null);
    setActiveRun(null);
    if (current?.id) {
      devbenchApi.exitConfigTrainingSession(current.projectId || projectId, current.id).then((result) => {
        if (!result.ok) toastRef.current?.(result.error || "训练已在本机退出，但服务端占用释放失败");
      }).catch((error) => toastRef.current?.(error.message || "训练已在本机退出，但服务端占用释放失败"));
    }
    if (current?.active) toastRef.current?.("已退出连续训练；已提交的 Annotation 与治理记录已保留");
  }

  async function loadTrainingSource(save = false) {
    const url = sourceUrl.trim();
    if (!url || sourceLoading) return null;
    setSourceLoading(true);
    try {
      const result = save
        ? await devbenchApi.saveConfigTrainingSource(projectId, url, { completion: pool, statusKeys: sourceStatusKeys })
        : await devbenchApi.previewConfigTrainingSource(projectId, url);
      if (!result.ok) {
        toastRef.current?.(result.error || "TB 列表读取失败");
        return null;
      }
      setSourcePreview(result.data);
      if (!save) {
        // 预览任何显式 URL 时都从完整列表开始；只有用户自己操作才会缩小范围。
        setPool("all");
        setSourceStatusKeys(null);
      }
      if (save) {
        setSourceDirty(false);
        sourceDirtyRef.current = false;
        await reload();
        toastRef.current?.("TB 列表已设为项目共享训练来源，可在其它目录和局域网设备继续使用");
      }
      return result.data;
    } catch (error) {
      toastRef.current?.(error.message || "TB 列表读取失败");
      return null;
    } finally {
      setSourceLoading(false);
    }
  }

  async function clearTrainingSource() {
    if (sourceLoading) return;
    setSourceLoading(true);
    try {
      const result = await devbenchApi.clearConfigTrainingSource(projectId);
      if (!result.ok) {
        toastRef.current?.(result.error || "共享训练来源清除失败");
        return;
      }
      setSourceUrl("");
      setSourcePreview(null);
      setSourceStatusKeys(null);
      setSourceDirty(false);
      sourceDirtyRef.current = false;
      setPool("staged");
      await reload();
      toastRef.current?.("已清除项目共享训练来源");
    } catch (error) {
      toastRef.current?.(error.message || "共享训练来源清除失败");
    } finally {
      setSourceLoading(false);
    }
  }

  function updateSourceUrl(value) {
    const hadSource = !!sourceUrl.trim();
    setSourceUrl(value);
    setSourcePreview(null);
    setSourceDirty(true);
    sourceDirtyRef.current = true;
    replaceTrainingSession(null);
    setActiveRun(null);
    if (!hadSource && value.trim()) setPool("all");
    if (value.trim()) {
      setPool("all");
      setSourceStatusKeys(null);
    }
  }

  function toggleSourceStatus(statusKey) {
    if (running || trainingActive) return;
    const allKeys = sourceStatusCounts.map((row) => row.key);
    const available = new Set(allKeys);
    const next = new Set((sourceStatusKeys === null ? allKeys : sourceStatusKeys).filter((key) => available.has(key)));
    if (next.has(statusKey)) next.delete(statusKey);
    else next.add(statusKey);
    setSourceStatusKeys(allKeys.length > 0 && allKeys.every((key) => next.has(key)) ? null : [...next]);
    replaceTrainingSession(null);
    setActiveRun(null);
  }

  function resetSourceFilters() {
    if (running || trainingActive) return;
    setPool("all");
    setSourceStatusKeys(null);
    replaceTrainingSession(null);
    setActiveRun(null);
  }

  async function submitReview(payload) {
    if (!activeRun?.id || reviewing || reviewRequestRef.current) return;
    const reviewRunId = activeRun.id;
    const reviewProjectId = configInferenceRunProjectId(activeRun, projectId);
    const resolvingSymbols = activeRun?._resolutionMode === true;
    reviewRequestRef.current = reviewRunId;
    const sessionAtSubmit = trainingSessionRef.current;
    setReviewing(true);
    try {
      const result = resolvingSymbols
        ? await devbenchApi.resolveConfigInferenceSymbols(reviewProjectId, activeRun.id, payload)
        : await devbenchApi.reviewConfigInference(
          reviewProjectId,
          activeRun.id,
          payload,
          configInferenceReviewRecovery(activeRun),
        );
      if (projectIdRef.current !== projectId) return;
      if (!result.ok) {
        if (result.stale && result.refreshed && result.data) {
          setActiveRun(runWithOptions(result.recovered
            ? recoveredReviewSession(result, payload)
            : result.data));
          await reload();
          toastRef.current?.(result.error || "推理规则已升级，旧结果已重算，请确认后重新评分");
          return;
        }
        toastRef.current?.(result.error || "训练复核保存失败");
        return;
      }
      const reviewedRun = runWithOptions({
        ...result.data,
        learned: result.learned,
        _learnedSample: result.sample || null,
        snapshot: result.snapshot || null,
        summary: result.summary || null,
        configurationUpdates: result.configurationUpdates || { changed: false },
      });
      setLastLearnedRun(reviewedRun);
      const configUpdateText = result.configurationUpdates?.changed ? "，自定义值已同步到仓库定义和车型源码配置" : "";
      const recoveryText = result.recovered ? "，丢失记录已由服务端审计自动恢复" : "";
      const unresolvedCount = (result.configurationUpdates?.unresolved || []).reduce((sum, row) => sum + (row.fields?.length || 0), 0);
      const symbolicUpdateText = unresolvedCount ? `，仍有 ${unresolvedCount} 个代号字段待替换，真实配置写回已延期` : "";
      const savedText = result.learned
        ? `Annotation 已保存；当前 Gateway 同时生成了兼容学习样本，治理版仍需审批/激活${recoveryText}${configUpdateText}${symbolicUpdateText}`
        : `Annotation 已保存，尚未声明进入 serving${recoveryText}${configUpdateText}${symbolicUpdateText}`;
      if (resolvingSymbols) {
        setActiveRun(reviewedRun);
        await reload();
        toastRef.current?.(unresolvedCount
          ? `代号替换已保存${symbolicUpdateText}`
          : `代号已全部替换并保存${configUpdateText}`);
        return;
      }
      const current = trainingSessionRef.current;
      const continueSession = !!sessionAtSubmit?.active && current?.active && current.id === sessionAtSubmit.id;
      if (continueSession) {
        const learnedSession = {
          ...current,
          phase: "drawing",
          trained: Math.min(Number(current.total || 0), Number(current.trained || 0) + 1),
          remaining: Math.max(0, Number(current.remaining || 0) - 1),
        };
        replaceTrainingSession(learnedSession);
        setActiveRun(reviewedRun);
        toastRef.current?.(`${savedText}，正在自动进入下一题`);
        await requestNextTraining(learnedSession, {
          completeToast: `${savedText}；当前 TB 单列表已全部训练完成，没有重复抽取工单`,
        });
      } else {
        if (!sessionAtSubmit) setActiveRun(reviewedRun);
        await reload();
        toastRef.current?.(savedText);
      }
    } catch (error) {
      toastRef.current?.(error.message || "训练复核保存失败");
    } finally {
      if (reviewRequestRef.current === reviewRunId) {
        reviewRequestRef.current = "";
        setReviewing(false);
      }
    }
  }

  async function governAnnotation(run, action, reason) {
    const governanceState = annotationGovernance(run);
    if (!isAdmin || governingId || !governanceState.id || !reason?.trim()) return;
    setGoverningId(run.id);
    try {
      let result;
      if (action === "approve") {
        result = await devbenchApi.approveAiTrainingAnnotation(
          configInferenceRunProjectId(run, projectId),
          governanceState.id,
          { reason: reason.trim(), expectedRevision: run.annotation?.revision ?? run.review?.annotationRevision },
        );
      } else if (action === "revoke") {
        result = await devbenchApi.revokeAiTrainingAnnotation(
          configInferenceRunProjectId(run, projectId),
          governanceState.id,
          { reason: reason.trim(), expectedRevision: run.annotation?.revision ?? run.review?.annotationRevision },
        );
      } else {
        result = await devbenchApi.restoreAiTrainingAnnotation(
          configInferenceRunProjectId(run, projectId),
          governanceState.caseId || run.id,
          governanceState.id,
          { reason: reason.trim() },
        );
      }
      if (!result?.ok) {
        toastRef.current?.(result?.error || "Annotation 治理操作失败");
        return;
      }
      if (result.data) setActiveRun(runWithOptions(result.data));
      await reload();
      toastRef.current?.({
        approve: "Annotation 已审批；是否进入 serving 仍以 Active release 为准",
        revoke: "Annotation 已撤销，不再作为治理版 serving 样本",
        restore: "已基于撤销记录创建新的待审批 Annotation",
      }[action]);
    } catch (error) {
      toastRef.current?.(error.message || "Annotation 治理操作失败");
    } finally {
      setGoverningId("");
    }
  }

  async function deleteRun(id) {
    if (!isAdmin || !id || deletingId) return;
    if (!window.confirm("这里只删除/隐藏推理 run，不会撤销已生成的 sample、trained ticket、Value revision 或配置写回。若要撤销学习效果，请先使用 Annotation“撤销”。仍要继续吗？")) return;
    setDeletingId(id);
    try {
      const run = (data?.runs || []).find((item) => item.id === id) || (activeRun?.id === id ? activeRun : null);
      const result = await devbenchApi.deleteConfigInferenceRun(configInferenceRunProjectId(run, projectId), id);
      if (!result.ok) {
        toastRef.current?.(result.error || "删除失败");
        return;
      }
      if (activeRun?.id === id) setActiveRun(null);
      await reload();
      toastRef.current?.("推理 run 已删除；关联学习效果未撤销");
    } catch (error) {
      toastRef.current?.(error.message || "删除失败");
    } finally {
      setDeletingId("");
    }
  }

  async function openHistoryRun(run) {
    if (trainingSessionRef.current?.active) return;
    const stale = !run?.review && (run?.stalePrediction === true
      || (!!data?.version && String(run?.version || "") !== String(data.version)));
    if (!stale) {
      setActiveRun(runWithOptions(run));
      return;
    }
    if (refreshRequestRef.current) return;
    refreshRequestRef.current = run.id;
    setRefreshingId(run.id);
    try {
      const result = await devbenchApi.refreshConfigInference(configInferenceRunProjectId(run, projectId), run.id, { reason: "history_open" });
      if (projectIdRef.current !== projectId) return;
      if (!result.ok) {
        toastRef.current?.(result.error || "旧推理结果升级失败");
        return;
      }
      setActiveRun(runWithOptions(result.data));
      await reload();
      toastRef.current?.("旧推理结果已按当前车型配置和 RAG 规则重新计算，请确认后评分");
    } catch (error) {
      toastRef.current?.(error.message || "旧推理结果升级失败");
    } finally {
      if (refreshRequestRef.current === run.id) {
        refreshRequestRef.current = "";
        setRefreshingId("");
      }
    }
  }

  function beginSymbolResolution(run) {
    const source = runWithOptions(run);
    const targets = source?.review?.correctedPrediction?.targets || source?.prediction?.targets || [];
    if (!symbolicFieldCount(targets)) return;
    setActiveRun({
      ...source,
      _resolutionMode: true,
      _reviewedSource: source,
      review: null,
      prediction: {
        ...(source.prediction || {}),
        ...(source.review?.correctedPrediction || {}),
        targets,
      },
    });
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-[#101112]">
      <div className="shrink-0 border-b border-zinc-800 bg-zinc-900/35 px-4 py-2.5">
        <div className="flex flex-wrap items-center gap-2">
          <div className="min-w-0 flex-1">
            <h1 className="text-[13px] font-semibold text-zinc-100">配置推断训练</h1>
            <p className="mt-0.5 text-[10px] text-zinc-600">以标题、项目、迭代、标签、附件、评论六类证据和真实开发配置生成 Annotation；只有经审批、激活的知识版本才进入 Codex、Claude、DeepSeek 等已接入 AI 共用的项目 RAG serving。</p>
            <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[9px] text-zinc-500">
              <span className="rounded border border-zinc-800 bg-zinc-950/40 px-1.5 py-0.5">按 TB 项目隔离</span>
              <span className="rounded border border-zinc-800 bg-zinc-950/40 px-1.5 py-0.5">源码路径无关</span>
              <span className="rounded border border-zinc-800 bg-zinc-950/40 px-1.5 py-0.5">支持局域网训练快照 + 增量同步</span>
            </div>
          </div>
          <span className="max-w-[260px] truncate rounded border border-cyan-900/60 bg-cyan-950/25 px-2 py-0.5 text-[10px] text-cyan-400" title={projectName || projectId}>{projectName || projectId || "默认 TB 项目"}</span>
          <button type="button" onClick={reload} disabled={loading} title="刷新训练数据" className="rounded p-1.5 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200 disabled:opacity-50">↻</button>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-[1680px] space-y-4 p-3 sm:p-4">
          <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
            <Metric label="有效关键词规则" value={metrics.rules ?? 0} detail="六类来源规则" />
            <Metric label="已保存标注/样本" value={metrics.learnedSamples ?? 0} detail={`真实执行观测 ${metrics.actualExecutionSamples ?? 0} · 不等于 Approved`} tone="text-cyan-200" />
            <Metric label="待人工复核" value={metrics.pendingReviews ?? 0} detail={`累计推断 ${metrics.runs ?? 0}`} tone={(metrics.pendingReviews || 0) > 0 ? "text-amber-300" : "text-zinc-100"} />
            <Metric label="已复核记录人工同意率" value={percent(metricSummary.humanAgreementRate)} detail={`非独立准确率 · 有效复核 ${metrics.exactEligibleReviews ?? 0} / ${metrics.reviewed ?? 0}`} tone="text-emerald-300" />
          </div>

          <GovernanceEvaluationSummary governance={governance} evaluation={evaluation} metricSummary={metricSummary} />

          <div className="flex flex-wrap items-center gap-1 rounded-lg border border-zinc-800 bg-zinc-900/35 p-1" role="tablist" aria-label="AI 训练工作区">
            <button
              type="button"
              data-testid="ai-training-tab-training"
              role="tab"
              aria-selected={workspaceTab === "training"}
              onClick={() => setWorkspaceTab("training")}
              className={`rounded-md px-3 py-1.5 text-[10px] font-medium transition ${workspaceTab === "training" ? "bg-cyan-800 text-white shadow-sm" : "text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200"}`}
            >训练工作台</button>
            <button
              type="button"
              data-testid="ai-training-tab-memory"
              role="tab"
              aria-selected={workspaceTab === "memory"}
              onClick={openMemoryWorkspace}
              disabled={memorySwitchLocked}
              title={memorySwitchLocked ? "请先提交当前评分或退出训练" : "查看和替换模型共用的 RAG 实际值"}
              className={`flex items-center gap-1.5 rounded-md px-3 py-1.5 text-[10px] font-medium transition disabled:cursor-not-allowed disabled:opacity-40 ${workspaceTab === "memory" ? "bg-violet-800 text-white shadow-sm" : "text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200"}`}
            >RAG 记忆与映射 <span className={`rounded-full px-1.5 py-0.5 text-[8px] ${workspaceTab === "memory" ? "bg-violet-950/60 text-violet-100" : "bg-zinc-800 text-zinc-500"}`}>{data?.valueBindings?.length || 0}</span></button>
            <span className="ml-auto px-2 text-[9px] text-zinc-700">作用域隔离 · 草稿/审批/激活 · revision 回滚</span>
          </div>

          {workspaceTab === "memory" ? (
            <RagMemoryPanel
              projectId={projectId}
              valueBindings={data?.valueBindings || []}
              samples={data?.samples || []}
              options={data?.options || {}}
              isAdmin={isAdmin}
              readOnly={trainingActive}
              readOnlyReason={trainingActive ? "连续训练进行中；退出训练后可替换实际值" : ""}
              latestLearned={lastLearnedRun}
              onUpdated={reload}
              onToast={(message) => toastRef.current?.(message)}
            />
          ) : <>
          <div className="grid gap-3 xl:grid-cols-[1.15fr_0.85fr]">
            <section className="rounded-xl border border-zinc-800 bg-zinc-900/30 p-3 sm:p-4">
              <div className="flex flex-wrap items-start gap-3">
                <div className="min-w-0 flex-1">
                  <h2 className="text-[12px] font-medium text-zinc-200">从 TB 单列表随机训练</h2>
                  <p className="mt-1 text-[10px] leading-relaxed text-zinc-600">可使用本地已同步任务池，也可粘贴 Teambition 迭代/任务列表 URL。系统优先抽取尚未标注的 TB 单；提交纠正只生成 Annotation，需经审批/激活后才可进入正式训练集或 serving。</p>
                </div>
                <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
                  {trainingSession ? (
                    <div data-testid="ai-training-session-summary" className={`flex flex-wrap items-center gap-2 rounded border px-2.5 py-1.5 text-[10px] ${trainingSession.complete ? "border-emerald-900/60 bg-emerald-950/20" : "border-cyan-900/60 bg-cyan-950/20"}`}>
                      <span data-testid="ai-training-total" className="text-zinc-300">列表总数 <strong className="font-semibold text-zinc-100">{Number(trainingSession.listTotal ?? trainingSession.total ?? 0)}</strong></span>
                      {Number(trainingSession.listTotal) !== Number(trainingSession.total) ? <span className="text-zinc-500">当前范围 {Number(trainingSession.total || 0)}</span> : null}
                      <span data-testid="ai-training-remaining" className={trainingSession.complete ? "text-emerald-300" : "text-amber-300"}>剩余要训练 <strong className="font-semibold">{Number(trainingSession.remaining || 0)}</strong></span>
                      <span className="text-zinc-600">{trainingSession.complete ? "已全部完成" : trainingSession.phase === "waiting" ? "等待其它会话释放" : trainingSession.phase === "drawing" ? "AI 学习并抽取中" : "等待评分"}</span>
                    </div>
                  ) : null}
                  {trainingActive ? (
                    <button type="button" data-testid="ai-training-exit" onClick={exitTraining} className="rounded border border-rose-900/70 bg-rose-950/20 px-4 py-1.5 text-[11px] font-medium text-rose-300 hover:bg-rose-950/40">退出训练</button>
                  ) : (
                    <button type="button" data-testid="ai-training-start" onClick={startRandomTraining} disabled={running || loading || sourceLoading || (!hasExplicitSource && currentPoolCount === 0) || (hasExplicitSource && !!sourcePreview && currentPoolCount === 0)} className="rounded bg-cyan-700 px-4 py-1.5 text-[11px] font-medium text-white hover:bg-cyan-600 disabled:cursor-not-allowed disabled:bg-zinc-700 disabled:text-zinc-500">
                      {running ? "随机抽取中…" : trainingSession?.complete ? "检查新增 TB 单" : "开始训练"}
                    </button>
                  )}
                </div>
              </div>
              <div className="mt-3 rounded-lg border border-zinc-800 bg-zinc-950/35 p-2.5">
                <div className="flex flex-col gap-2 lg:flex-row lg:items-center">
                  <div className="min-w-0 flex-1">
                    <label htmlFor="ai-training-tb-source-url" className="text-[10px] text-zinc-400">指定 TB 迭代/任务列表 URL（可选）</label>
                    <input
                      id="ai-training-tb-source-url"
                      data-testid="ai-training-source-url"
                      value={sourceUrl}
                      onChange={(event) => updateSourceUrl(event.target.value)}
                      disabled={trainingActive}
                      placeholder="https://www.teambition.com/project/.../sprint/section/..."
                      className="mt-1 w-full rounded border border-zinc-700 bg-zinc-950 px-2.5 py-1.5 font-mono text-[10px] text-zinc-200 outline-none focus:border-cyan-700"
                    />
                  </div>
                  <div className="flex shrink-0 flex-wrap gap-1.5 lg:pt-4">
                    <button type="button" data-testid="ai-training-source-preview" onClick={() => loadTrainingSource(false)} disabled={!sourceUrl.trim() || sourceLoading || running || trainingActive} className="rounded border border-zinc-700 px-2.5 py-1.5 text-[10px] text-zinc-300 hover:border-zinc-600 hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-40">{sourceLoading ? "读取中…" : "预览列表"}</button>
                    <button type="button" data-testid="ai-training-source-save" onClick={() => loadTrainingSource(true)} disabled={!sourceUrl.trim() || sourceLoading || running || trainingActive} className="rounded border border-cyan-800 bg-cyan-950/25 px-2.5 py-1.5 text-[10px] text-cyan-300 hover:bg-cyan-950/45 disabled:cursor-not-allowed disabled:opacity-40">读取并共享</button>
                    {data?.settings?.taskSource?.url ? <button type="button" onClick={clearTrainingSource} disabled={sourceLoading || running || trainingActive} className="rounded border border-zinc-800 px-2 py-1.5 text-[10px] text-zinc-500 hover:border-rose-900 hover:text-rose-300 disabled:opacity-40">清除共享</button> : null}
                  </div>
                </div>
                <p className="mt-1.5 text-[9px] leading-relaxed text-zinc-600">迭代 URL 形如 <span className="font-mono text-zinc-500">/project/项目ID/sprint/section/迭代ID</span>；服务端会重新读取权威任务，包含已完成和未完成，不上传浏览器缓存。共享来源只保存规范 ID，不保存本机路径。</p>
                {sourcePreview?.source ? (
                  <div data-testid="ai-training-source-summary" className="mt-2 space-y-1.5 rounded border border-emerald-900/50 bg-emerald-950/15 px-2.5 py-2 text-[10px]">
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                      <span className="text-emerald-300">{sourcePreview.source.type === "sprint" ? "迭代" : sourcePreview.source.type === "tasklist" ? "任务列表" : "项目"}：{sourcePreview.source.name || sourcePreview.source.sectionId || "已解析"}</span>
                      <span className="font-mono text-zinc-500">project {sourcePreview.source.projectId}</span>
                      <span data-testid="ai-training-source-all-count" className="text-zinc-300">原始完整列表 <strong className="font-semibold text-emerald-200">{Number(sourceCounts.all || 0)}</strong></span>
                      <span className="text-zinc-500">未完成 {Number(sourceCounts.pending || 0)}</span>
                      <span className="text-zinc-500">已完成 {Number(sourceCounts.completed || 0)}</span>
                      <span data-testid="ai-training-source-filtered-count" className="text-cyan-300">当前筛选 {currentPoolCount}</span>
                      {sourcePreview.cached ? <span className="text-amber-500">上次读取，开始训练时会刷新</span> : null}
                    </div>
                    {sourceAcquisition ? (
                      <div data-testid="ai-training-source-acquisition" className="flex flex-wrap gap-x-3 gap-y-1 text-[9px] text-zinc-500">
                        <span>获取渠道 {sourceAcquisition.fetchSource || sourcePreview.source.fetchSource || "-"}</span>
                        <span>OpenAPI 命中 {Number(sourceAcquisition.openApiMatched || 0)}</span>
                        <span>Cookie 命中 {Number(sourceAcquisition.cookieMatched || 0)}</span>
                        <span>合并去重 {Number(sourceAcquisition.mergedMatched ?? sourceCounts.all ?? 0)}</span>
                        {sourceAcquisitionComplete ? <span className="text-emerald-500">来源总数 {sourceReportedTotal} · {Number(sourceAcquisition.cookiePages || 0)} 页 · 已完整</span> : null}
                        {sourceAcquisition.cookieComplete && !sourceAcquisitionComplete ? <span className="text-amber-500">来源总数未校验，等待重新读取</span> : null}
                        <span className="text-emerald-500">来源阶段未按任务流状态过滤</span>
                      </div>
                    ) : null}
                  </div>
                ) : null}
              </div>
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <span className="text-[10px] font-medium text-zinc-300">完成状态过滤</span>
                {hasExplicitSource ? <span className="text-[9px] text-zinc-600">默认“全部 TB 单”，不会自动忽略关闭、可提测或其它已完成状态</span> : null}
                {hasExplicitSource ? <button type="button" data-testid="ai-training-filter-reset" onClick={resetSourceFilters} disabled={running || trainingActive} className="ml-auto rounded border border-zinc-700 px-2 py-1 text-[9px] text-zinc-400 hover:border-cyan-800 hover:text-cyan-300 disabled:opacity-40">恢复全部</button> : null}
              </div>
              <div className={`mt-2 grid gap-2 sm:grid-cols-2 ${hasExplicitSource ? "lg:grid-cols-3" : "lg:grid-cols-4"}`}>
                {(hasExplicitSource ? POOLS.filter((item) => item.value !== "staged") : POOLS).map((item) => {
                  const sourceUnsupported = hasExplicitSource && item.value === "staged";
                  const count = hasExplicitSource
                    ? sourceCountForCompletion(item.value)
                    : Number(taskPool[item.value] || 0);
                  const label = hasExplicitSource && item.value === "pending" ? "未完成" : item.label;
                  const detail = hasExplicitSource
                    ? item.value === "pending" ? "指定列表中的未完成工单" : item.value === "completed" ? "指定列表中的已完成工单" : item.value === "all" ? "指定列表中的全部工单" : "指定列表不使用 TB 候选状态"
                    : item.detail;
                  return (
                    <button key={item.value} type="button" onClick={() => { replaceTrainingSession(null); setPool(item.value); }} disabled={running || trainingActive || sourceUnsupported} className={`rounded-md border px-2.5 py-2 text-left transition disabled:cursor-not-allowed disabled:opacity-35 ${pool === item.value ? "border-cyan-700 bg-cyan-950/35" : "border-zinc-800 bg-zinc-950/35 hover:border-zinc-700"}`}>
                      <div className="flex items-center justify-between gap-2"><span className={pool === item.value ? "text-[10px] font-medium text-cyan-200" : "text-[10px] text-zinc-400"}>{label}</span><span className="text-[10px] text-zinc-500">{sourcePreview || !hasExplicitSource ? count : "-"}</span></div>
                      <div className="mt-0.5 truncate text-[9px] text-zinc-600" title={detail}>{detail}</div>
                    </button>
                  );
                })}
              </div>
              {hasExplicitSource && sourcePreview ? (
                <div className="mt-3 space-y-2 rounded-lg border border-zinc-800 bg-zinc-950/30 p-2.5">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-[10px] font-medium text-zinc-300">任务流状态过滤</span>
                    <button type="button" data-testid="ai-training-status-all" onClick={() => { setSourceStatusKeys(null); replaceTrainingSession(null); setActiveRun(null); }} disabled={running || trainingActive} className={`rounded border px-2 py-1 text-[9px] disabled:opacity-40 ${allSourceStatusesSelected ? "border-cyan-700 bg-cyan-950/35 text-cyan-200" : "border-zinc-700 text-zinc-500 hover:text-zinc-300"}`}>全部状态（默认）</button>
                    <span className="text-[9px] text-zinc-600">包含关闭、可提测、已拒绝、处理中及其它状态</span>
                  </div>
                  <div data-testid="ai-training-status-filters" className="flex flex-wrap gap-1.5">
                    {sourceStatusCounts.map((row) => {
                      const checked = allSourceStatusesSelected || selectedSourceStatusKeys.has(row.key);
                      return (
                        <label key={row.key} className={`flex cursor-pointer items-center gap-1 rounded border px-2 py-1 text-[9px] ${checked ? "border-cyan-900/70 bg-cyan-950/25 text-cyan-200" : "border-zinc-800 text-zinc-600"}`}>
                          <input type="checkbox" checked={checked} onChange={() => toggleSourceStatus(row.key)} disabled={running || trainingActive} className="h-3 w-3 accent-cyan-600" />
                          <span>{row.name}</span>
                          <span className="text-zinc-500">{Number(row.count || 0)}</span>
                        </label>
                      );
                    })}
                    {!sourceStatusCounts.length ? <span className="text-[9px] text-zinc-600">TB 未返回可分组的任务流状态；仍保留全部工单。</span> : null}
                  </div>
                  <div data-testid="ai-training-fixed-filters" className="grid gap-1.5 text-[9px] text-zinc-500 lg:grid-cols-2">
                    <div className="rounded border border-zinc-800/80 bg-zinc-950/40 px-2 py-1.5"><span className="text-zinc-400">固定来源边界（不可关闭）：</span>合法 TB URL、项目 ID 精确匹配、迭代/任务列表 ID 精确匹配、必须有 TB 单 ID、按 TB 单 ID 去重。</div>
                    <div className="rounded border border-zinc-800/80 bg-zinc-950/40 px-2 py-1.5"><span className="text-zinc-400">训练排除（不可关闭）：</span>已评分并记忆的 TB 单、当前会话已出现的 TB 单、其它会话正在占用的 TB 单；用于保证不重复训练。</div>
                  </div>
                </div>
              ) : null}
              {currentPoolCount === 0 && (!hasExplicitSource || sourcePreview) ? <div className="mt-2 rounded border border-amber-900/50 bg-amber-950/20 px-2.5 py-1.5 text-[10px] text-amber-400">{hasExplicitSource ? `指定列表的“${pool === "pending" ? "未完成" : pool === "completed" ? "已完成" : "全部"}”范围暂无工单，请切换范围。` : `“${selectedPool.label}”暂无工单，请先在任务面板同步 TB 单，或切换样本池。`}</div> : null}
            </section>

            <section className="rounded-xl border border-zinc-800 bg-zinc-900/30 p-3 sm:p-4">
              <h2 className="text-[12px] font-medium text-zinc-200">推理数据覆盖</h2>
              <div className="mt-2 grid grid-cols-3 gap-1.5">
                {SIGNAL_GROUPS.map(([key, label]) => <div key={key} className="rounded border border-zinc-800 bg-zinc-950/40 px-2 py-1.5"><div className="text-[9px] text-zinc-600">{label}规则</div><div className="mt-0.5 text-sm text-zinc-300">{metrics.ruleCountByGroup?.[key] || 0}</div></div>)}
              </div>
              <div className="mt-3 border-t border-zinc-800 pt-2">
                <div className="mb-1.5 text-[9px] text-zinc-600">各维度人工一致率（在线复核口径）</div>
                <div className="grid grid-cols-5 gap-1">
                  {DIMENSIONS.map(([key, label]) => <div key={key} className="min-w-0 text-center"><div className="truncate text-[9px] text-zinc-600" title={label}>{label}</div><div className="mt-0.5 text-[10px] text-zinc-300">{percent(metrics.fieldAccuracy?.[key])}</div></div>)}
                </div>
                <div className="mt-1.5 text-[8px] text-zinc-700">独立准确性以冻结数据集上的完整目标图严格匹配为准；字段人工一致率不能替代该指标。</div>
              </div>
            </section>
          </div>

          {lastLearnedRun && activeRun?.id !== lastLearnedRun.id ? <LatestLearnedResult run={lastLearnedRun} onOpenMemory={openMemoryWorkspace} /> : null}

          {activeRun ? (
            activeRun.review ? (
              <ReviewedRun
                run={activeRun}
                onResolveSymbols={() => beginSymbolResolution(activeRun)}
                onGovernance={governAnnotation}
                governanceBusy={governingId === activeRun.id}
                isAdmin={isAdmin}
                onNext={() => trainingSessionRef.current?.active ? requestNextTraining(trainingSessionRef.current) : setActiveRun(null)}
                running={running}
                nextLabel={trainingActive ? "重试下一题" : "返回"}
              />
            ) : (
              <ConfigInferenceReview
                key={`${activeRun.id || "run"}:${activeRun.version || ""}:${activeRun.predictionRevision ?? ""}:${activeRun.updatedAt || ""}`}
                session={runWithOptions(activeRun)}
                busy={reviewing}
                training
                canPersistConfig={isAdmin}
                resolutionMode={activeRun._resolutionMode === true}
                onSubmit={submitReview}
                onSkip={activeRun._resolutionMode ? () => setActiveRun(activeRun._reviewedSource || null) : exitTraining}
              />
            )
          ) : (
            <div className="rounded-xl border border-dashed border-zinc-800 bg-zinc-900/20 px-4 py-10 text-center">
              <div className="text-[12px] text-zinc-400">{trainingSession?.complete ? "当前列表已全部训练完成" : trainingSession?.phase === "waiting" ? "剩余 TB 单正在其它训练会话中" : trainingActive && running ? "正在随机抽取下一条 TB 单" : "尚未抽取训练工单"}</div>
              <div className="mt-1 text-[10px] text-zinc-600">{trainingSession?.complete ? "已标注工单不会重复抽取；列表新增工单后可点击“检查新增 TB 单”。Annotation 是否进入训练集或 serving 仍由治理状态决定。" : trainingSession?.phase === "waiting" ? "系统会在占用释放后自动继续；你也可以随时退出当前训练。" : "点击“开始训练”后，Annotation 保存成功会进入下一条；审批、激活不会被自动跳过。"}</div>
            </div>
          )}

          <section className="overflow-hidden rounded-xl border border-zinc-800 bg-zinc-900/25">
            <div className="flex items-center gap-2 border-b border-zinc-800 px-3 py-2.5 sm:px-4">
              <h2 className="text-[12px] font-medium text-zinc-200">统一配置推断历史</h2>
              <span className="text-[9px] text-zinc-600">随机训练与开发前复核共用</span>
              <span className="ml-auto text-[9px] text-zinc-600">{data?.runs?.length || 0} 条</span>
            </div>
            <div className="max-h-[420px] overflow-auto">
              <div className="min-w-[920px] divide-y divide-zinc-800/80">
                {recentRuns.map((run) => {
                  const review = decisionMeta(run.review?.decision);
                  const confidence = confidencePresentation(run.prediction || {});
                  const governanceState = annotationGovernance(run);
                  return (
                    <div key={run.id} className={`grid grid-cols-[155px_minmax(260px,1fr)_120px_110px_120px_44px] items-center gap-2 px-3 py-2 text-[10px] hover:bg-zinc-800/25 ${activeRun?.id === run.id ? "bg-cyan-950/15" : ""}`}>
                      <button type="button" onClick={() => openHistoryRun(run)} disabled={trainingActive || refreshingId === run.id} className="text-left disabled:cursor-not-allowed"><div className="truncate text-zinc-300">{run.ticket?.ticketId || run.ticket?.tbTaskId || run.id}</div><div className="text-[9px] text-zinc-600">{refreshingId === run.id ? "正在按新规则重算…" : run.stalePrediction ? "旧规则结果 · 打开时自动重算" : formatTime(run.createdAt)}</div></button>
                      <button type="button" onClick={() => openHistoryRun(run)} disabled={trainingActive} className="min-w-0 text-left disabled:cursor-not-allowed"><div className="truncate text-zinc-300" title={run.ticket?.title}>{run.ticket?.title || "无标题"}</div><div className="truncate text-[9px] text-zinc-600">{(run.review?.correctedPrediction?.targets || run.prediction?.targets || []).map((target) => target.repositoryName || target.repositoryId).join(" · ") || "未推理出候选"}</div></button>
                      <button type="button" onClick={() => openHistoryRun(run)} disabled={trainingActive} className="min-w-0 text-left text-zinc-500 disabled:cursor-not-allowed"><div>{triggerLabel(run.trigger)}</div>{run.trainingSource?.name ? <div className="truncate text-[9px] text-cyan-700" title={run.trainingSource.url}>{run.trainingSource.name}</div> : null}</button>
                      <button type="button" onClick={() => openHistoryRun(run)} disabled={trainingActive} className="text-left text-zinc-500 disabled:cursor-not-allowed"><div>{confidence.label}</div><div className="text-[9px] text-zinc-600">{percent(confidence.value)}{confidence.calibrated ? "" : " · 未校准"}</div></button>
                      <button type="button" onClick={() => openHistoryRun(run)} disabled={trainingActive} className={`text-left disabled:cursor-not-allowed ${review.cls}`}><div>{review.label}{run.review?.rating ? ` · ${run.review.rating}★` : ""}</div><div className={`mt-0.5 text-[8px] ${governanceState.meta.tone}`}>{governanceState.meta.label}</div></button>
                      <div className="text-right">{isAdmin ? <button type="button" onClick={() => deleteRun(run.id)} disabled={deletingId === run.id} title="仅删除本次推断运行记录，不撤销标注或知识版本" className="rounded px-2 py-1 text-zinc-600 hover:bg-rose-950/40 hover:text-rose-300 disabled:opacity-40">{deletingId === run.id ? "…" : "×"}</button> : null}</div>
                    </div>
                  );
                })}
                {!recentRuns.length ? <div className="py-8 text-center text-[10px] text-zinc-600">暂无配置推断历史</div> : null}
              </div>
            </div>
          </section>
          </>}
        </div>
      </div>
    </div>
  );
}
