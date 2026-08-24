import React, { memo } from "react";
import { Handle, Position } from "@xyflow/react";

const ENGINE_COLORS = {
  claude: "bg-violet-500",
  gemini: "bg-cyan-500",
  auto: "bg-zinc-600",
};

const STATUS_INDICATOR = {
  idle: "",
  pending: "bg-zinc-500",
  running: "bg-blue-400 animate-pulse",
  completed: "bg-green-400",
  failed: "bg-red-400",
  aborted: "bg-amber-400",
  inspecting: "bg-amber-400 animate-pulse",
  retrying: "bg-orange-400 animate-pulse",
  decomposing: "bg-purple-400 animate-pulse",
};


function StepNode({ data, selected }) {
  const status = data.status || "idle";
  const engine = data.engine || "auto";
  const prompt = data.prompt || "";
  const truncated = prompt.length > 80 ? prompt.slice(0, 80) + "..." : prompt;

  const borderClass =
    status === "running" ? "border-blue-500/50" :
    status === "completed" ? "border-green-500/30" :
    status === "failed" ? "border-red-500/30" :
    selected ? "border-blue-500" :
    "border-zinc-700";

  const shadowClass =
    selected ? "shadow-lg shadow-blue-500/10" :
    status === "running" ? "shadow-lg" : "";

  const pulseClass = status === "running" ? "step-node-running" : "";

  return (
    <div
      className={`bg-zinc-900 border ${borderClass} rounded-xl min-w-[240px] max-w-[300px] ${shadowClass} ${pulseClass} transition-colors`}
    >
      <Handle
        type="target"
        position={Position.Top}
        className="!bg-zinc-600 hover:!bg-blue-400 !w-2 !h-2 !border-zinc-800 !border-2"
      />

      {/* Header */}
      <div className="flex items-center gap-2 px-3 pt-3 pb-2">
        <div className={`w-2.5 h-2.5 rounded-sm ${ENGINE_COLORS[engine] || ENGINE_COLORS.auto}`} />
        <span className="text-sm font-medium text-zinc-200 flex-1 truncate">
          {data.title || "未命名步骤"}
        </span>
        {data.inspect && (
          <span className="text-[9px] px-1 py-0.5 rounded font-medium bg-amber-500/20 text-amber-400">
            审查
          </span>
        )}
        {data.retryCount > 0 && (
          <span className="text-[9px] px-1 py-0.5 rounded bg-orange-500/20 text-orange-400">
            重试x{data.retryCount}
          </span>
        )}
        {STATUS_INDICATOR[status] && (
          <span className={`w-2 h-2 rounded-full ${STATUS_INDICATOR[status]}`} />
        )}
      </div>

      {/* Divider */}
      <div className="border-t border-zinc-800 mx-3" />

      {/* Body */}
      <div className="px-3 py-2">
        {truncated ? (
          <p className="text-xs text-zinc-500 leading-relaxed line-clamp-2 font-mono">
            {truncated}
          </p>
        ) : (
          <p className="text-xs text-zinc-600 italic">未设置 prompt</p>
        )}
      </div>

      {/* Footer badges */}
      {data.skill && (
        <div className="px-3 pb-2">
          <span className="text-[10px] px-1.5 py-0.5 rounded bg-zinc-800 text-zinc-400">
            {data.skill}
          </span>
        </div>
      )}

      <Handle
        type="source"
        position={Position.Bottom}
        className="!bg-zinc-600 hover:!bg-blue-400 !w-2 !h-2 !border-zinc-800 !border-2"
      />
    </div>
  );
}

export default memo(StepNode);
