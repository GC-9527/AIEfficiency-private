// AI 工作台 — 布局（顶栏 + 二级 Tab + 内容区 children）。
// children 由 index.jsx 用子路由注入（本组件不接 Outlet，路由分发集中在 index.jsx）。

import React, { useEffect, useState } from "react";
import { NavLink, useLocation } from "react-router-dom";
import api from "./api.js";

const NAV = [
  { path: "", label: "工作概览", end: true },
  { path: "batches", label: "批量处理" },
  { path: "confirmations", label: "配置待确认" },
  { path: "acceptance", label: "验收中心" },
  { path: "settings", label: "工作台设置" },
];

function StatusDot({ state }) {
  const color = state === "ok" ? "bg-green-500" : state === "warn" ? "bg-amber-500" : "bg-red-500";
  return <span className={`inline-block w-2 h-2 rounded-full ${color}`} />;
}

export default function Layout({ children }) {
  const location = useLocation();
  const [health, setHealth] = useState(null);
  const [overview, setOverview] = useState(null);

  useEffect(() => {
    let cancel = false;
    async function load() {
      try {
        const h = await api.health();
        if (!cancel) setHealth(h);
      } catch (e) {
        if (!cancel) setHealth({ status: "fail", error: e.message });
      }
      try {
        const o = await api.overview();
        if (!cancel) setOverview(o);
      } catch {}
    }
    load();
    const t = setInterval(load, 15000);
    return () => { cancel = true; clearInterval(t); };
  }, [location.pathname]);

  const counts = overview?.counts || {};
  const totalDrafts = Object.values(counts.draftCounts || {}).reduce((a, b) => a + b, 0);
  const totalManual = Object.values(counts.manualCounts || {}).reduce((a, b) => a + b, 0);
  const totalQueued = Object.values(counts.queueCounts || {}).reduce((a, b) => a + b, 0);

  return (
    <div className="flex h-full flex-col bg-[#0f0f10] text-zinc-200">
      <header className="shrink-0 border-b border-zinc-800 bg-[#18181b]">
        <div className="flex items-center gap-3 px-4 py-2.5">
          <div className="flex items-center gap-2">
            <span className="w-7 h-7 rounded-md bg-gradient-to-br from-blue-500 to-violet-600 flex items-center justify-center text-white font-bold text-xs">AI</span>
            <span className="text-sm font-semibold text-zinc-100">AI 工作台</span>
            <span className="text-xs text-zinc-500">/aiautowork</span>
          </div>
          <div className="ml-4 flex items-center gap-2 text-xs text-zinc-500">
            <StatusDot state={health?.status} />
            <span>{health?.status === "ok" ? "已连接" : health?.status === "fail" ? "网关异常" : "..."}</span>
            {health?.error && <span className="text-red-400/80 truncate max-w-[280px]">{health.error}</span>}
          </div>
          <div className="ml-auto flex items-center gap-3 text-xs text-zinc-500">
            <span>任务草稿 <span className="text-zinc-300 font-mono">{totalDrafts}</span></span>
            <span>人工介入 <span className="text-amber-400 font-mono">{totalManual}</span></span>
            <span>队列 <span className="text-blue-400 font-mono">{totalQueued}</span></span>
          </div>
        </div>
        <nav className="flex items-center gap-1 px-3 pb-0">
          {NAV.map((item) => (
            <NavLink
              key={item.path || "index"}
              to={item.path ? `/aiautowork/${item.path}` : "/aiautowork"}
              end={item.end}
              className={({ isActive }) =>
                `px-3 py-2 text-xs font-medium rounded-t-md border-b-2 transition-colors ${
                  isActive
                    ? "text-zinc-100 border-blue-500 bg-zinc-800/40"
                    : "text-zinc-500 border-transparent hover:text-zinc-300 hover:bg-zinc-800/30"
                }`
              }
            >
              {item.label}
            </NavLink>
          ))}
        </nav>
      </header>
      <main className="flex-1 overflow-auto">{children}</main>
    </div>
  );
}
