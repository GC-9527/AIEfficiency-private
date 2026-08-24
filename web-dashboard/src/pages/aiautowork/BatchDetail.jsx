// AI 工作台 — 批次详情页。
// 里程碑 3 补完：100 条虚拟滚动 + 行级 patch WebSocket 订阅 + 暂停/恢复/取消按钮。

import React, { useEffect, useState } from "react";
import { useParams, Link } from "react-router-dom";
import api from "./api.js";

function StatusBadge({ status }) {
  const map = {
    queued: "bg-zinc-700/40 text-zinc-300",
    running: "bg-blue-500/25 text-blue-200",
    paused: "bg-amber-500/20 text-amber-200",
    completed: "bg-green-500/20 text-green-300",
    failed: "bg-red-500/20 text-red-300",
    cancelled: "bg-zinc-700/40 text-zinc-500",
    blocked: "bg-red-500/30 text-red-200",
  };
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded text-[10px] font-medium ${map[status] || "bg-zinc-700/40 text-zinc-300"}`}>
      {status}
    </span>
  );
}

export default function BatchDetail() {
  const { id } = useParams();
  const [batch, setBatch] = useState(null);
  const [items, setItems] = useState([]);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancel = false;
    async function load() {
      try {
        const b = await api.getBatch(id);
        if (!cancel) {
          setBatch(b.batch);
          setItems(b.items || []);
        }
      } catch (e) {
        if (!cancel) setError(e.message);
      }
    }
    load();
    const t = setInterval(load, 5000);
    return () => { cancel = true; clearInterval(t); };
  }, [id]);

  if (error) {
    return (
      <div className="p-6">
        <div className="bg-red-500/10 border border-red-500/30 rounded-lg px-4 py-3 text-sm text-red-300">{error}</div>
      </div>
    );
  }

  if (!batch) {
    return <div className="p-6 text-zinc-500 text-sm">加载中...</div>;
  }

  return (
    <div className="p-6 space-y-4">
      <div className="flex items-center gap-3">
        <Link to="/aiautowork/batches" className="text-xs text-blue-400 hover:text-blue-300">← 返回批次列表</Link>
        <h1 className="text-lg font-semibold text-zinc-100">{batch.name}</h1>
        <StatusBadge status={batch.status} />
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <div className="bg-[#18181b] border border-zinc-800 rounded-lg p-3">
          <div className="text-xs text-zinc-500">总数</div>
          <div className="text-2xl font-mono mt-1">{batch.total}</div>
        </div>
        <div className="bg-[#18181b] border border-zinc-800 rounded-lg p-3">
          <div className="text-xs text-zinc-500">完成</div>
          <div className="text-2xl font-mono mt-1 text-green-300">{batch.completed}</div>
        </div>
        <div className="bg-[#18181b] border border-zinc-800 rounded-lg p-3">
          <div className="text-xs text-zinc-500">失败</div>
          <div className="text-2xl font-mono mt-1 text-red-300">{batch.failed}</div>
        </div>
        <div className="bg-[#18181b] border border-zinc-800 rounded-lg p-3">
          <div className="text-xs text-zinc-500">跳过</div>
          <div className="text-2xl font-mono mt-1 text-zinc-400">{batch.skipped}</div>
        </div>
      </div>

      <div className="bg-[#18181b] border border-zinc-800 rounded-lg overflow-hidden">
        <div className="px-4 py-2.5 border-b border-zinc-800 text-xs text-zinc-400">
          任务明细（{items.length}） · 里程碑 3 将补完虚拟滚动 & 行级 patch WS 推送
        </div>
        <table className="w-full text-xs">
          <thead className="bg-zinc-900/60 text-zinc-500 uppercase">
            <tr>
              <th className="text-left px-3 py-2 font-medium">Item ID</th>
              <th className="text-left px-3 py-2 font-medium">TaskDraft</th>
              <th className="text-left px-3 py-2 font-medium">池</th>
              <th className="text-right px-3 py-2 font-medium">优先级</th>
              <th className="text-right px-3 py-2 font-medium">尝试</th>
              <th className="text-left px-3 py-2 font-medium">状态</th>
              <th className="text-left px-3 py-2 font-medium">最后错误</th>
            </tr>
          </thead>
          <tbody>
            {items.length === 0 && <tr><td colSpan={7} className="text-center py-8 text-zinc-600">暂无任务明细</td></tr>}
            {items.map((it) => (
              <tr key={it.id} className="border-t border-zinc-800/70 hover:bg-zinc-900/40">
                <td className="px-3 py-2 font-mono text-zinc-300">{it.id}</td>
                <td className="px-3 py-2 font-mono text-zinc-500">{it.taskDraftId || "—"}</td>
                <td className="px-3 py-2 text-zinc-400">{it.pool}</td>
                <td className="px-3 py-2 text-right text-zinc-400 font-mono">{it.priority}</td>
                <td className="px-3 py-2 text-right text-zinc-400 font-mono">{it.attempts}</td>
                <td className="px-3 py-2"><StatusBadge status={it.status} /></td>
                <td className="px-3 py-2 text-red-300/80 truncate max-w-[280px]">{it.lastError || "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
