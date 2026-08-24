import React from "react";
import { getStatusDisplayLabel } from "../../utils/statusDisplay.js";

export default function CanvasToolbar({
  mode,
  name, setName,
  description, setDescription,
  status,
  saving,
  onAddStep,
  onAutoLayout,
  onSave,
  onCancel,
  onAbort,
  onFitView,
}) {
  if (mode === "monitor") {
    return (
      <div className="flex items-center justify-between px-4 py-2.5 bg-zinc-900/80 backdrop-blur border-b border-zinc-800">
        <div className="flex items-center gap-3">
          <button
            onClick={onCancel}
            className="text-xs text-zinc-500 hover:text-zinc-300"
          >
            &larr; 返回
          </button>
          <span className="text-sm font-medium text-zinc-200">{name || "工作流运行"}</span>
          <MonitorStatusBadge status={status} />
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={onFitView}
            className="text-xs px-2 py-1 rounded text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800"
            title="适应画布"
          >
            <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7" />
            </svg>
          </button>
          {status === "running" && (
            <button
              onClick={onAbort}
              className="text-xs px-3 py-1.5 rounded bg-red-600/20 text-red-400 hover:bg-red-600/30 transition"
            >
              终止
            </button>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="flex items-center justify-between px-4 py-2.5 bg-zinc-900/80 backdrop-blur border-b border-zinc-800">
      <div className="flex items-center gap-3 flex-1 min-w-0">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="工作流名称"
          className="bg-transparent border-b border-zinc-700 text-sm text-zinc-200 placeholder-zinc-600 outline-none px-1 py-0.5 w-40 focus:border-zinc-500"
        />
        <input
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="描述 (可选)"
          className="bg-transparent border-b border-zinc-700 text-xs text-zinc-400 placeholder-zinc-600 outline-none px-1 py-0.5 w-48 focus:border-zinc-500"
        />
      </div>

      <div className="flex items-center gap-2">
        <button
          onClick={onAddStep}
          className="text-xs px-3 py-1.5 rounded bg-zinc-800 text-zinc-300 hover:bg-zinc-700 transition"
        >
          + 添加步骤
        </button>
        <button
          onClick={onAutoLayout}
          className="text-xs px-2 py-1.5 rounded text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800 transition"
          title="自动布局"
        >
          <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <rect x="3" y="3" width="7" height="7" rx="1" />
            <rect x="14" y="3" width="7" height="7" rx="1" />
            <rect x="8" y="14" width="7" height="7" rx="1" />
            <line x1="6.5" y1="10" x2="6.5" y2="14" />
            <line x1="17.5" y1="10" x2="17.5" y2="14" />
          </svg>
        </button>
        <button
          onClick={onFitView}
          className="text-xs px-2 py-1.5 rounded text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800 transition"
          title="适应画布"
        >
          <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7" />
          </svg>
        </button>
        <div className="w-px h-5 bg-zinc-800 mx-1" />
        <button
          onClick={onCancel}
          className="text-xs px-3 py-1.5 rounded text-zinc-400 hover:text-zinc-200 transition"
        >
          取消
        </button>
        <button
          onClick={onSave}
          disabled={saving}
          className="text-xs px-4 py-1.5 rounded bg-blue-600 hover:bg-blue-500 text-white disabled:opacity-50 transition"
        >
          {saving ? "保存中..." : "保存"}
        </button>
      </div>
    </div>
  );
}

function MonitorStatusBadge({ status }) {
  const styles = {
    pending: "bg-zinc-800 text-zinc-500",
    running: "bg-blue-500/10 text-blue-400",
    completed: "bg-green-500/10 text-green-400",
    failed: "bg-red-500/10 text-red-400",
    aborted: "bg-amber-500/10 text-amber-400",
  };
  const labels = {
    pending: "等待中", running: "运行中", completed: "已完成",
    failed: "失败", aborted: "已终止",
  };
  return (
    <span className={`text-xs px-2 py-0.5 rounded ${styles[status] || styles.pending}`}>
      {getStatusDisplayLabel(status, `workflow-monitor:${status || "pending"}`)}
    </span>
  );
}
