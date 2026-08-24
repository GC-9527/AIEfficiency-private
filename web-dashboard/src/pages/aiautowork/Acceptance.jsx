import React, { useEffect, useState } from "react";
import api from "./api.js";
import {
  ACCEPTANCE_STATUS_CARDS,
  normalizeAcceptanceRuns,
  statusTone,
} from "./acceptanceModel.mjs";

const TONE_CLASS = {
  success: "border-emerald-500/35 bg-emerald-500/10 text-emerald-200",
  warning: "border-amber-500/35 bg-amber-500/10 text-amber-200",
  danger: "border-red-500/35 bg-red-500/10 text-red-200",
  unknown: "border-zinc-700 bg-zinc-800/70 text-zinc-300",
};

function StatusCard({ card, value }) {
  return (
    <div className={`rounded-lg border px-3 py-2 ${TONE_CLASS[statusTone(value)]}`}>
      <div className="text-[10px] font-medium uppercase tracking-wide opacity-70">{card.label}</div>
      <div className="mt-1 font-mono text-sm font-semibold">{value}</div>
      <div className="mt-1 text-[10px] opacity-70">{card.description}</div>
    </div>
  );
}

function Value({ label, value }) {
  return (
    <div className="min-w-0">
      <div className="text-[10px] uppercase tracking-wide text-zinc-600">{label}</div>
      <div className="truncate font-mono text-xs text-zinc-300" title={String(value)}>{value}</div>
    </div>
  );
}

function CandidateList({ label, candidates, state }) {
  return (
    <div className="rounded border border-zinc-800 bg-zinc-950/30 p-3">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-medium text-zinc-300">{label}</span>
        <span className={`rounded px-1.5 py-0.5 text-[10px] ${TONE_CLASS[statusTone(state)]}`}>{state}</span>
      </div>
      {candidates.length === 0 ? (
        <div className="mt-2 text-xs text-zinc-600">未返回候选身份</div>
      ) : candidates.map((candidate, index) => (
        <div key={`${candidate.repository || "candidate"}-${index}`} className="mt-2 border-t border-zinc-800 pt-2 text-[11px] text-zinc-500">
          <div className="font-mono text-zinc-300">{candidate.repository || "未返回 repository"}</div>
          <div>base: {candidate.base_ref || candidate.baseRef || "—"}</div>
          <div>head: {candidate.head_ref || candidate.headRef || "—"}</div>
          <div>diff: {candidate.diff_hash || candidate.diffHash || "—"}</div>
        </div>
      ))}
    </div>
  );
}

function TrackDiagnostics({ label, diagnostics }) {
  const coverage = diagnostics.gateTotal
    ? `${diagnostics.gatesWithEvidence}/${diagnostics.gateTotal}`
    : "0/0";
  return (
    <div className="rounded border border-zinc-800 bg-zinc-950/30 p-3 text-xs text-zinc-400">
      <div className="font-medium text-zinc-300">{label}</div>
      <div className="mt-2 grid grid-cols-3 gap-2">
        <Value label="Repair rounds" value={`${diagnostics.repairRounds}/2`} />
        <Value label="Gate evidence" value={coverage} />
        <Value label="Evidence refs" value={diagnostics.evidenceIds.length} />
      </div>
      <div className="mt-2 text-[11px] text-zinc-500">
        失效门禁：{diagnostics.invalidatedGates.length ? diagnostics.invalidatedGates.join(", ") : "无"}
      </div>
    </div>
  );
}

function AcceptanceRun({ run }) {
  const [expanded, setExpanded] = useState(false);
  const { route } = run;
  const hasEvidenceConcern = run.unknowns.length > 0 || run.blockingFindings.length > 0 || run.consistency.overall !== "CONSISTENT";
  return (
    <article className="rounded-lg border border-zinc-800 bg-[#18181b] p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-zinc-100">{run.title}</h2>
          <div className="mt-1 font-mono text-xs text-zinc-500">{run.id}</div>
        </div>
        <div className={`rounded px-2 py-1 text-[10px] font-medium ${run.isDualScope ? "bg-violet-500/15 text-violet-200" : "bg-zinc-800 text-zinc-400"}`}>
          {run.isDualScope ? "DUAL_SCOPE · 双轨独立" : route.scopeKind}
        </div>
      </div>

      <div className="mt-4 grid gap-2 md:grid-cols-2 xl:grid-cols-4">
        {ACCEPTANCE_STATUS_CARDS.map((card) => <StatusCard key={card.key} card={card} value={run.statuses[card.key]} />)}
      </div>

      {run.isDualScope && (
        <div className="mt-3 grid gap-2 rounded border border-violet-500/20 bg-violet-500/5 p-3 text-xs md:grid-cols-2">
          <div><span className="text-violet-300">Platform/Project Track</span> <span className="font-mono text-zinc-300">{run.statuses.projectChange} / {run.statuses.productionReadiness}</span></div>
          <div><span className="text-violet-300">Story Delivery Track</span> <span className="font-mono text-zinc-300">{run.statuses.storyPoint} / sync {run.statuses.sourceSync}</span></div>
        </div>
      )}

      <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Value label="Task origin" value={route.taskOrigin} />
        <Value label="Change / risk" value={`${route.changeType} / ${route.riskTier}`} />
        <Value label="Project task" value={route.projectTaskId} />
        <Value label="Story point" value={route.storyPointId} />
      </div>
      <div className="mt-3 text-xs text-zinc-500">协议：{route.protocols.length ? route.protocols.join(" + ") : "UNKNOWN"}　来源：{route.sources.length ? route.sources.map((source) => `${source.system}:${source.issueId}`).join(", ") : "未返回"}</div>

      <div className={`mt-4 rounded border px-3 py-2 text-xs ${hasEvidenceConcern ? "border-amber-500/25 bg-amber-500/5 text-amber-100" : "border-emerald-500/20 bg-emerald-500/5 text-emerald-100"}`}>
        Candidate and Evidence Consistency：<span className="font-mono font-medium">{run.consistency.overall}</span>
        {run.consistency.reasons.length > 0 && <span className="text-zinc-400"> · {run.consistency.reasons.join("；")}</span>}
        {run.unknowns.length > 0 && <span className="text-zinc-400"> · UNKNOWN {run.unknowns.length} 项</span>}
        {run.blockingFindings.length > 0 && <span className="text-zinc-400"> · 阻断 Finding {run.blockingFindings.length} 项</span>}
      </div>

      <div className="mt-3 grid gap-2 lg:grid-cols-2">
        <TrackDiagnostics label="Project 执行与证据覆盖" diagnostics={run.diagnostics.project} />
        <TrackDiagnostics label="Story 执行与证据覆盖" diagnostics={run.diagnostics.story} />
      </div>

      <button type="button" onClick={() => setExpanded((value) => !value)} className="mt-3 text-xs text-blue-300 hover:text-blue-200">
        {expanded ? "收起验收证据摘要" : "展开验收证据摘要"}
      </button>
      {expanded && (
        <div className="mt-3 grid gap-3 lg:grid-cols-2">
          <CandidateList label="工程候选" candidates={run.candidates.project} state={run.consistency.project} />
          <CandidateList label="故事点候选" candidates={run.candidates.story} state={run.consistency.story} />
          <div className="rounded border border-zinc-800 bg-zinc-950/30 p-3 text-xs text-zinc-400">
            <div className="font-medium text-zinc-300">UNKNOWN</div>
            {run.unknowns.length ? <ul className="mt-2 list-disc space-y-1 pl-4">{run.unknowns.map((item) => <li key={item}>{item}</li>)}</ul> : <div className="mt-2 text-zinc-600">未返回 UNKNOWN 项</div>}
          </div>
          <div className="rounded border border-zinc-800 bg-zinc-950/30 p-3 text-xs text-zinc-400">
            <div className="font-medium text-zinc-300">Findings</div>
            {run.findings.length ? <ul className="mt-2 space-y-2">{run.findings.map((finding, index) => <li key={`${finding.id}-${index}`}><span className="font-mono text-zinc-300">{finding.id}</span> · {finding.ownership} · {finding.severity}<br />{finding.behavior}</li>)}</ul> : <div className="mt-2 text-zinc-600">未返回 Finding</div>}
          </div>
        </div>
      )}
    </article>
  );
}

export default function Acceptance() {
  const [runs, setRuns] = useState([]);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const response = await api.listAcceptanceRuns({ limit: 100 });
        if (!cancelled) {
          setRuns(normalizeAcceptanceRuns(response));
          setError(null);
        }
      } catch (cause) {
        if (!cancelled) setError(cause.message || "验收运行加载失败");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    const timer = setInterval(load, 10000);
    return () => { cancelled = true; clearInterval(timer); };
  }, []);

  return (
    <div className="p-6 space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold text-zinc-100">验收中心</h1>
          <p className="mt-1 text-xs text-zinc-500">工程交付、发布就绪、故事点可信度和来源同步彼此独立，禁止聚合成单一“通过”。</p>
        </div>
        <div className="text-xs text-zinc-600">每 10 秒刷新 · {runs.length} 个运行</div>
      </div>
      {error && <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-300">{error}</div>}
      {loading && <div className="py-8 text-center text-sm text-zinc-600">正在加载验收运行…</div>}
      {!loading && !error && runs.length === 0 && <div className="rounded-lg border border-zinc-800 bg-[#18181b] py-10 text-center text-sm text-zinc-600">暂无验收运行</div>}
      {runs.map((run, index) => <AcceptanceRun key={`${run.id}-${index}`} run={run} />)}
    </div>
  );
}
