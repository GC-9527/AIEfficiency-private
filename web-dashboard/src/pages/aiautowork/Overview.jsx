// AI 工作台 — 工作概览页（首屏）。
// 展示：7 个子视图（任务草稿/批次/人工介入/Review/Settings 快捷卡 + 队列状态）。
// 风格：紧凑表格、行级状态；当接口失败时回退到 Mock 数据。

import React, { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import api from "./api.js";

function StatCard({ label, value, tint = "text-zinc-200", sublabel, to }) {
  const inner = (
    <div className="bg-[#18181b] border border-zinc-800 rounded-lg p-4 hover:border-zinc-700 transition-colors">
      <div className="text-xs text-zinc-500">{label}</div>
      <div className={`mt-1 text-2xl font-mono ${tint}`}>{value}</div>
      {sublabel && <div className="mt-1 text-xs text-zinc-600">{sublabel}</div>}
    </div>
  );
  return to ? <Link to={to}>{inner}</Link> : inner;
}

function StatusBadge({ status }) {
  const map = {
    INPUT_PARSED: "bg-zinc-700/40 text-zinc-300",
    DRAFT_CREATED: "bg-blue-500/15 text-blue-300",
    INFERENCING: "bg-blue-500/20 text-blue-200",
    REVIEWING: "bg-violet-500/20 text-violet-200",
    REPAIRING: "bg-amber-500/20 text-amber-200",
    AUTO_READY: "bg-green-500/20 text-green-300",
    GROUP_CONFIRM_REQUIRED: "bg-blue-500/15 text-blue-300",
    MANUAL_INTERVENTION_REQUIRED: "bg-amber-500/30 text-amber-200",
    READY_TO_CREATE: "bg-green-500/15 text-green-300",
    CREATED: "bg-green-500/30 text-green-200",
    CANCELLED: "bg-zinc-700/40 text-zinc-500",
    CREATE_FAILED: "bg-red-500/20 text-red-300",
  };
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded text-[10px] font-medium ${map[status] || "bg-zinc-700/40 text-zinc-300"}`}>
      {status}
    </span>
  );
}

export default function Overview() {
  const [overview, setOverview] = useState(null);
  const [drafts, setDrafts] = useState([]);
  const [manualCases, setManualCases] = useState([]);
  const [queue, setQueue] = useState([]);
  const [reviews, setReviews] = useState([]);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancel = false;
    async function load() {
      try {
        const [ov, dr, mc, q, rv] = await Promise.all([
          api.overview().catch(() => null),
          api.listTaskDrafts({ limit: 20 }).catch(() => ({ items: [] })),
          api.listManualCases({ limit: 10 }).catch(() => ({ items: [] })),
          api.listExecutionQueue({ limit: 20 }).catch(() => ({ items: [] })),
          api.listReviewTargets({ limit: 10 }).catch(() => ({ items: [] })),
        ]);
        if (cancel) return;
        setOverview(ov);
        setDrafts(dr?.items || []);
        setManualCases(mc?.items || []);
        setQueue(q?.items || []);
        setReviews(rv?.items || []);
      } catch (e) {
        if (!cancel) setError(e.message);
      }
    }
    load();
    const t = setInterval(load, 10000);
    return () => { cancel = true; clearInterval(t); };
  }, []);

  const draftCounts = overview?.counts?.draftCounts || {};
  const manualCounts = overview?.counts?.manualCounts || {};
  const queueCounts = overview?.counts?.queueCounts || {};
  const featureFlags = overview?.featureFlags || {};

  return (
    <div className="p-6 space-y-6">
      {error && (
        <div className="bg-red-500/10 border border-red-500/30 rounded-lg px-4 py-3 text-sm text-red-300">
          {error}
        </div>
      )}

      {/* 顶栏统计 */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <StatCard
          label="任务草稿"
          value={Object.values(draftCounts).reduce((a, b) => a + b, 0)}
          sublabel={`AUTO_READY ${draftCounts.AUTO_READY || 0} · 待确认 ${draftCounts.GROUP_CONFIRM_REQUIRED || 0}`}
          to="/aiautowork"
        />
        <StatCard
          label="人工介入"
          value={Object.values(manualCounts).reduce((a, b) => a + b, 0)}
          tint="text-amber-300"
          sublabel={`open ${manualCounts.open || 0} · in_progress ${manualCounts.in_progress || 0}`}
          to="/aiautowork/confirmations"
        />
        <StatCard
          label="执行队列"
          value={Object.values(queueCounts).reduce((a, b) => a + b, 0)}
          tint="text-blue-300"
          sublabel={`推导 ${queueCounts.inference || 0} · 校验 ${queueCounts.validation || 0} · 复核 ${queueCounts.reviewer || 0} · 执行 ${queueCounts.execution || 0}`}
        />
        <StatCard
          label="Feature Flag"
          value={featureFlags.enabled ? "已启用" : "未启用"}
          tint={featureFlags.enabled ? "text-green-300" : "text-red-300"}
          sublabel={`批量 ${featureFlags.batch ? "开" : "关"} · 推导 ${featureFlags.configInference ? "开" : "关"} · 修复 ${featureFlags.autoRepair ? "开" : "关"}`}
          to="/aiautowork/settings"
        />
      </div>

      {/* 任务草稿表 */}
      <section>
        <div className="flex items-center justify-between mb-2">
          <h2 className="text-sm font-semibold text-zinc-200">任务草稿（最近 20）</h2>
          <Link to="/aiautowork/batches" className="text-xs text-blue-400 hover:text-blue-300">查看批量 →</Link>
        </div>
        <div className="bg-[#18181b] border border-zinc-800 rounded-lg overflow-hidden">
          <table className="w-full text-xs">
            <thead className="bg-zinc-900/60 text-zinc-500 uppercase">
              <tr>
                <th className="text-left px-3 py-2 font-medium">ID</th>
                <th className="text-left px-3 py-2 font-medium">来源</th>
                <th className="text-left px-3 py-2 font-medium">引用</th>
                <th className="text-left px-3 py-2 font-medium">状态</th>
                <th className="text-left px-3 py-2 font-medium">优先级</th>
                <th className="text-left px-3 py-2 font-medium">更新时间</th>
              </tr>
            </thead>
            <tbody>
              {drafts.length === 0 && (
                <tr><td colSpan={6} className="text-center py-6 text-zinc-600">暂无任务草稿</td></tr>
              )}
              {drafts.map((d) => (
                <tr key={d.id} className="border-t border-zinc-800/70 hover:bg-zinc-900/40">
                  <td className="px-3 py-2 font-mono text-zinc-300">{d.id}</td>
                  <td className="px-3 py-2 text-zinc-400">{d.sourceType}</td>
                  <td className="px-3 py-2 text-zinc-500">{d.sourceRef || "—"}</td>
                  <td className="px-3 py-2"><StatusBadge status={d.status} /></td>
                  <td className="px-3 py-2 text-zinc-400">{d.sourcePriority || "normal"}</td>
                  <td className="px-3 py-2 text-zinc-600">{d.updatedAt}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {/* 三栏：人工介入 / 队列 / Review */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
        <section className="bg-[#18181b] border border-zinc-800 rounded-lg p-3">
          <h3 className="text-xs font-semibold text-zinc-300 mb-2">人工介入（最近 10）</h3>
          <ul className="space-y-1.5">
            {manualCases.length === 0 && <li className="text-xs text-zinc-600">暂无</li>}
            {manualCases.map((m) => (
              <li key={m.id} className="text-xs flex items-center gap-2">
                <span className="font-mono text-zinc-500">{m.id.slice(0, 12)}</span>
                <span className="text-zinc-300">{m.reasonCode || "—"}</span>
                <span className="ml-auto text-zinc-600">{m.status}</span>
              </li>
            ))}
          </ul>
        </section>
        <section className="bg-[#18181b] border border-zinc-800 rounded-lg p-3">
          <h3 className="text-xs font-semibold text-zinc-300 mb-2">执行队列（活跃）</h3>
          <ul className="space-y-1.5">
            {queue.length === 0 && <li className="text-xs text-zinc-600">暂无</li>}
            {queue.map((q) => (
              <li key={q.id} className="text-xs flex items-center gap-2">
                <span className="px-1.5 py-0.5 rounded text-[10px] bg-blue-500/15 text-blue-300">{q.pool}</span>
                <span className="font-mono text-zinc-500 truncate">{q.taskDraftId?.slice(0, 12) || "—"}</span>
                <span className="ml-auto text-zinc-600">{q.status}</span>
              </li>
            ))}
          </ul>
        </section>
        <section className="bg-[#18181b] border border-zinc-800 rounded-lg p-3">
          <h3 className="text-xs font-semibold text-zinc-300 mb-2">Review 目标（最近 10）</h3>
          <ul className="space-y-1.5">
            {reviews.length === 0 && <li className="text-xs text-zinc-600">暂无</li>}
            {reviews.map((r) => (
              <li key={r.id} className="text-xs flex items-center gap-2">
                <span className="px-1.5 py-0.5 rounded text-[10px] bg-violet-500/15 text-violet-300">{r.sourceType}</span>
                <span className="text-zinc-300 truncate">{r.title || r.targetRef || "—"}</span>
                <span className="ml-auto text-zinc-600">{r.findingsCount || 0} findings</span>
              </li>
            ))}
          </ul>
        </section>
      </div>
    </div>
  );
}
