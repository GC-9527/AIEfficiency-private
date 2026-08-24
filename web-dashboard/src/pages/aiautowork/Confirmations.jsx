// AI 工作台 — 配置待确认。
// 里程碑 5 补完：组确认（指纹聚合）+ 批量补全 + 人工介入 Drawer。

import React, { useEffect, useState } from "react";
import api from "./api.js";

function StatusBadge({ status }) {
  const map = {
    open: "bg-amber-500/20 text-amber-200",
    in_progress: "bg-blue-500/20 text-blue-200",
    resolved: "bg-green-500/20 text-green-300",
    abandoned: "bg-zinc-700/40 text-zinc-500",
  };
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded text-[10px] font-medium ${map[status] || "bg-zinc-700/40 text-zinc-300"}`}>
      {status}
    </span>
  );
}

export default function Confirmations() {
  const [cases, setCases] = useState([]);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancel = false;
    async function load() {
      try {
        const r = await api.listManualCases({ limit: 100 });
        if (!cancel) setCases(r.items || []);
      } catch (e) {
        if (!cancel) setError(e.message);
      }
    }
    load();
    const t = setInterval(load, 10000);
    return () => { cancel = true; clearInterval(t); };
  }, []);

  return (
    <div className="p-6 space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold text-zinc-100">配置待确认</h1>
        <div className="text-xs text-zinc-500">里程碑 5 将补完：分组（指纹） / 批量补全 / 人工介入 Drawer</div>
      </div>

      {error && (
        <div className="bg-red-500/10 border border-red-500/30 rounded-lg px-4 py-3 text-sm text-red-300">{error}</div>
      )}

      <div className="bg-[#18181b] border border-zinc-800 rounded-lg overflow-hidden">
        <table className="w-full text-xs">
          <thead className="bg-zinc-900/60 text-zinc-500 uppercase">
            <tr>
              <th className="text-left px-3 py-2 font-medium">Case ID</th>
              <th className="text-left px-3 py-2 font-medium">TaskDraft</th>
              <th className="text-left px-3 py-2 font-medium">原因码</th>
              <th className="text-left px-3 py-2 font-medium">说明</th>
              <th className="text-left px-3 py-2 font-medium">状态</th>
              <th className="text-left px-3 py-2 font-medium">开启时间</th>
            </tr>
          </thead>
          <tbody>
            {cases.length === 0 && (
              <tr><td colSpan={6} className="text-center py-8 text-zinc-600">暂无待确认</td></tr>
            )}
            {cases.map((c) => (
              <tr key={c.id} className="border-t border-zinc-800/70 hover:bg-zinc-900/40">
                <td className="px-3 py-2 font-mono text-zinc-300">{c.id}</td>
                <td className="px-3 py-2 font-mono text-zinc-500">{c.taskDraftId}</td>
                <td className="px-3 py-2 text-zinc-300">{c.reasonCode || "—"}</td>
                <td className="px-3 py-2 text-zinc-400 truncate max-w-[280px]">{c.openedReason || "—"}</td>
                <td className="px-3 py-2"><StatusBadge status={c.status} /></td>
                <td className="px-3 py-2 text-zinc-600">{c.openedAt}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
