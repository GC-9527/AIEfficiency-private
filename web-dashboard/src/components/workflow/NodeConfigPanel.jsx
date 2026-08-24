import React from "react";
import { getStatusDisplayLabel } from "../../utils/statusDisplay.js";

const ENGINES = [
  { value: "auto", label: "自动" },
  { value: "claude", label: "Claude" },
  { value: "gemini", label: "Gemini" },
];

export default function NodeConfigPanel({ node, skills, mode, onChange, onClose }) {
  const data = node.data;
  const isEdit = mode === "edit";

  function update(field, value) {
    onChange?.({ ...node, data: { ...data, [field]: value } });
  }

  return (
    <div className="absolute right-0 top-0 h-full w-80 bg-zinc-900 border-l border-zinc-800 z-50 flex flex-col shadow-2xl">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-zinc-800">
        <h4 className="text-sm font-medium text-zinc-200">
          {isEdit ? "编辑步骤" : "步骤详情"}
        </h4>
        <button
          onClick={onClose}
          className="text-zinc-500 hover:text-zinc-300 text-lg leading-none"
        >
          &times;
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {isEdit ? (
          <>
            {/* Title */}
            <div>
              <label className="text-xs text-zinc-500 block mb-1">步骤标题</label>
              <input
                value={data.title || ""}
                onChange={(e) => update("title", e.target.value)}
                className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-zinc-200 outline-none focus:border-zinc-500"
              />
            </div>

            {/* Prompt */}
            <div>
              <label className="text-xs text-zinc-500 block mb-1">Prompt</label>
              <textarea
                value={data.prompt || ""}
                onChange={(e) => update("prompt", e.target.value)}
                rows={6}
                placeholder="使用 {{varName}} 引用变量"
                className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-zinc-200 outline-none focus:border-zinc-500 resize-none font-mono"
              />
            </div>

            {/* Engine */}
            <div>
              <label className="text-xs text-zinc-500 block mb-1">引擎</label>
              <select
                value={data.engine || "auto"}
                onChange={(e) => update("engine", e.target.value)}
                className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-zinc-300 outline-none"
              >
                {ENGINES.map((e) => (
                  <option key={e.value} value={e.value}>{e.label}</option>
                ))}
              </select>
            </div>

            {/* Skill */}
            <div>
              <label className="text-xs text-zinc-500 block mb-1">Skill</label>
              <select
                value={data.skill || ""}
                onChange={(e) => update("skill", e.target.value)}
                className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-zinc-300 outline-none"
              >
                <option value="">无</option>
                {(skills || []).map((s) => (
                  <option key={s.id} value={s.id}>{s.id}</option>
                ))}
              </select>
            </div>

            {/* Inspect toggle */}
            <div>
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={data.inspect || false}
                  onChange={(e) => update("inspect", e.target.checked)}
                  className="rounded border-zinc-600"
                />
                <span className="text-xs text-zinc-300">启用审查</span>
              </label>
              <p className="text-[10px] text-zinc-600 mt-1 ml-5">
                开启后，步骤完成时 AI 自动审查输出质量，不合格将重试
              </p>
            </div>

            {/* Output Variable */}
            <div>
              <label className="text-xs text-zinc-500 block mb-1">输出变量</label>
              <input
                value={data.outputVar || ""}
                onChange={(e) => update("outputVar", e.target.value)}
                placeholder="varName"
                className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-zinc-200 outline-none focus:border-zinc-500"
              />
            </div>

            {/* Timeout */}
            <div>
              <label className="text-xs text-zinc-500 block mb-1">超时 (秒)</label>
              <input
                type="number"
                value={data.timeout || 300}
                onChange={(e) => update("timeout", parseInt(e.target.value) || 300)}
                className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-zinc-200 outline-none focus:border-zinc-500"
              />
            </div>
          </>
        ) : (
          <>
            {/* Monitor mode: read-only */}
            <div>
              <label className="text-xs text-zinc-500 block mb-1">标题</label>
              <p className="text-sm text-zinc-200">{data.title || "未命名"}</p>
            </div>

            <div>
              <label className="text-xs text-zinc-500 block mb-1">状态</label>
              <StatusBadge status={data.status} />
            </div>

            {data.startedAt && data.completedAt && (
              <div>
                <label className="text-xs text-zinc-500 block mb-1">耗时</label>
                <p className="text-sm text-zinc-300">
                  {Math.round((new Date(data.completedAt) - new Date(data.startedAt)) / 1000)}s
                </p>
              </div>
            )}

            <div>
              <label className="text-xs text-zinc-500 block mb-1">引擎</label>
              <p className="text-sm text-zinc-300">{data.engine || "auto"}</p>
            </div>

            {data.skill && (
              <div>
                <label className="text-xs text-zinc-500 block mb-1">Skill</label>
                <p className="text-sm text-zinc-300">{data.skill}</p>
              </div>
            )}

            <div>
              <label className="text-xs text-zinc-500 block mb-1">Prompt</label>
              <pre className="text-xs text-zinc-400 whitespace-pre-wrap bg-zinc-800 rounded-lg p-3 max-h-40 overflow-y-auto font-mono">
                {data.prompt || "无"}
              </pre>
            </div>

            {data.output && (
              <div>
                <label className="text-xs text-zinc-500 block mb-1">输出</label>
                <pre className="text-xs text-zinc-400 whitespace-pre-wrap bg-zinc-800 rounded-lg p-3 max-h-60 overflow-y-auto leading-relaxed">
                  {data.output}
                </pre>
              </div>
            )}

            {data.inspect && (
              <div>
                <label className="text-xs text-zinc-500 block mb-1">审查</label>
                <span className="text-xs px-2 py-0.5 rounded bg-amber-500/10 text-amber-400">已启用</span>
              </div>
            )}

            {data.inspections && data.inspections.length > 0 && (
              <div>
                <label className="text-xs text-zinc-500 block mb-1">审查记录</label>
                <div className="space-y-2">
                  {data.inspections.map((ins, i) => (
                    <div key={i} className={`text-xs p-2 rounded-lg border ${
                      ins.verdict === "pass"
                        ? "border-green-500/30 bg-green-500/5"
                        : "border-red-500/30 bg-red-500/5"
                    }`}>
                      <div className="flex items-center gap-2">
                        <span>{ins.verdict === "pass" ? "\u2705" : "\u274C"}</span>
                        <span className="text-zinc-400">第 {ins.attempt} 次审查</span>
                      </div>
                      <p className="text-zinc-400 mt-1">{ins.reason}</p>
                      {ins.suggestions && (
                        <p className="text-zinc-500 mt-0.5">建议: {ins.suggestions}</p>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </>
        )}
      </div>

      {/* Node ID footer */}
      <div className="px-4 py-2 border-t border-zinc-800">
        <span className="text-[10px] text-zinc-600 font-mono">{node.id}</span>
      </div>
    </div>
  );
}

function StatusBadge({ status }) {
  const styles = {
    idle: "bg-zinc-800 text-zinc-500",
    pending: "bg-zinc-800 text-zinc-500",
    running: "bg-blue-500/10 text-blue-400",
    completed: "bg-green-500/10 text-green-400",
    failed: "bg-red-500/10 text-red-400",
    aborted: "bg-amber-500/10 text-amber-400",
    inspecting: "bg-amber-500/10 text-amber-400",
    retrying: "bg-orange-500/10 text-orange-400",
  };
  const labels = {
    idle: "空闲", pending: "等待中", running: "运行中",
    completed: "已完成", failed: "失败", aborted: "已终止",
    inspecting: "审查中", retrying: "重试中",
  };
  return (
    <span className={`text-xs px-2 py-0.5 rounded ${styles[status] || styles.idle}`}>
      {getStatusDisplayLabel(status, `workflow-node:${status || "idle"}`)}
    </span>
  );
}
