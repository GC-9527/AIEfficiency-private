// AI 工作台 — 批量处理。
// 列表 + 状态计数 + 批次详情（100 条虚拟滚动）。
// 里程碑 3 补完批量创建/暂停/恢复/取消/进度推送。

import React, { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import api from "./api.js";

function StatusBadge({ status }) {
  const map = {
    pending: "bg-zinc-700/40 text-zinc-300",
    queued: "bg-blue-500/15 text-blue-300",
    running: "bg-blue-500/25 text-blue-200",
    paused: "bg-amber-500/20 text-amber-200",
    completed: "bg-green-500/20 text-green-300",
    failed: "bg-red-500/20 text-red-300",
    cancelled: "bg-zinc-700/40 text-zinc-500",
  };
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded text-[10px] font-medium ${map[status] || "bg-zinc-700/40 text-zinc-300"}`}>
      {status}
    </span>
  );
}

export default function Batches() {
  const [batches, setBatches] = useState([]);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancel = false;
    async function load() {
      try {
        const r = await api.listBatches({ limit: 50 });
        if (!cancel) setBatches(r.items || []);
      } catch (e) {
        if (!cancel) setError(e.message);
      }
    }
    load();
    const t = setInterval(load, 8000);
    return () => { cancel = true; clearInterval(t); };
  }, []);

  return (
    <div className="p-6 space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold text-zinc-100">批量处理</h1>
        <div className="text-xs text-zinc-500">里程碑 3 将补完：创建 / 暂停 / 恢复 / 取消 / 100 条虚拟滚动</div>
      </div>

      {error && (
        <div className="bg-red-500/10 border border-red-500/30 rounded-lg px-4 py-3 text-sm text-red-300">
          {error}
        </div>
      )}

      <div className="bg-[#18181b] border border-zinc-800 rounded-lg overflow-hidden">
        <table className="w-full text-xs">
          <thead className="bg-zinc-900/60 text-zinc-500 uppercase">
            <tr>
              <th className="text-left px-3 py-2 font-medium">ID</th>
              <th className="text-left px-3 py-2 font-medium">名称</th>
              <th className="text-right px-3 py-2 font-medium">总数</th>
              <th className="text-right px-3 py-2 font-medium">完成</th>
              <th className="text-right px-3 py-2 font-medium">失败</th>
              <th className="text-left px-3 py-2 font-medium">状态</th>
              <th className="text-left px-3 py-2 font-medium">创建时间</th>
            </tr>
          </thead>
          <tbody>
            {batches.length === 0 && (
              <tr><td colSpan={7} className="text-center py-8 text-zinc-600">暂无批次</td></tr>
            )}
            {batches.map((b) => (
              <tr key={b.id} className="border-t border-zinc-800/70 hover:bg-zinc-900/40">
                <td className="px-3 py-2 font-mono text-zinc-300">
                  <Link to={`/aiautowork/batches/${b.id}`} className="hover:text-blue-300">{b.id}</Link>
                </td>
                <td className="px-3 py-2 text-zinc-200">{b.name}</td>
                <td className="px-3 py-2 text-right text-zinc-300 font-mono">{b.total}</td>
                <td className="px-3 py-2 text-right text-green-300 font-mono">{b.completed}</td>
                <td className="px-3 py-2 text-right text-red-300 font-mono">{b.failed}</td>
                <td className="px-3 py-2"><StatusBadge status={b.status} /></td>
                <td className="px-3 py-2 text-zinc-600">{b.createdAt}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
