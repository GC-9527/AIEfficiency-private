import React, { useState } from "react";
import { getApiUrl } from "../services/gateway.js";
import Markdown from "./Markdown.jsx";
import { authenticatedFetch } from "../services/adminAuth.js";

const STATUS_ICONS = {
  pending: { icon: "\u23F8", label: "等待中", color: "text-zinc-500", bg: "bg-zinc-700" },
  running: { icon: "\u23F3", label: "执行中", color: "text-blue-400", bg: "bg-blue-500/20" },
  completed: { icon: "\u2705", label: "完成", color: "text-green-400", bg: "bg-green-500/20" },
  failed: { icon: "\u274C", label: "失败", color: "text-red-400", bg: "bg-red-500/20" },
  paused: { icon: "\u23F8", label: "等待补充", color: "text-orange-400", bg: "bg-orange-500/20" },
  inspecting: { icon: "\uD83D\uDD0D", label: "审查中", color: "text-amber-400", bg: "bg-amber-500/20" },
  retrying: { icon: "\uD83D\uDD04", label: "重试中", color: "text-orange-400", bg: "bg-orange-500/20" },
  decomposing: { icon: "\uD83E\uDDE9", label: "规划中", color: "text-purple-400", bg: "bg-purple-500/20" },
};

export default function SubtaskPanel({ decomposition, subtaskStates, sessionId }) {
  const [expandedId, setExpandedId] = useState(null);
  const [supplementOpen, setSupplementOpen] = useState(null); // subtaskId
  const [supplementText, setSupplementText] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [toast, setToast] = useState(null);

  if (!decomposition || !decomposition.subtasks || decomposition.subtasks.length === 0) {
    return null;
  }

  const { subtasks } = decomposition;
  const terminalStatuses = new Set(["completed", "failed"]);
  const completedCount = subtasks.filter(
    (s) => {
      const state = subtaskStates[s.id];
      return state && terminalStatuses.has(state.status);
    }
  ).length;

  const progress = Math.round((completedCount / subtasks.length) * 100);
  const hasPaused = subtasks.some(s => subtaskStates[s.id]?.status === "paused");

  const showToast = (msg, ok = true) => {
    setToast({ msg, ok });
    setTimeout(() => setToast(null), 3000);
  };

  async function submitSupplement(subtaskId, asRetry) {
    if (!supplementText.trim() && !asRetry) {
      showToast("请输入补充内容", false);
      return;
    }
    setSubmitting(true);
    try {
      const url = asRetry
        ? getApiUrl(`/api/chat/sessions/${sessionId}/subtask/${subtaskId}/retry`)
        : getApiUrl(`/api/chat/sessions/${sessionId}/subtask/${subtaskId}/supplement`);
      const body = asRetry
        ? { supplement: supplementText.trim() || null }
        : { content: supplementText.trim() };
      const resp = await authenticatedFetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const d = await resp.json();
      if (d.success) {
        showToast(asRetry ? "已触发重试" : "补充内容已保存", true);
        setSupplementOpen(null);
        setSupplementText("");
      } else {
        showToast(`失败: ${d.error}`, false);
      }
    } catch (err) {
      showToast(`失败: ${err.message}`, false);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="flex justify-start">
      <div className="max-w-[75%] w-full rounded-2xl bg-zinc-800/80 border border-zinc-700 overflow-hidden relative">
        {toast && (
          <div className={`absolute top-2 right-2 z-10 px-3 py-1.5 rounded text-xs ${
            toast.ok ? "bg-green-500/20 text-green-300" : "bg-red-500/20 text-red-300"
          }`}>{toast.msg}</div>
        )}

        {/* Header */}
        <div className="px-4 py-3 border-b border-zinc-700/50 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="text-sm">&#x1F500;</span>
            <span className="text-sm text-zinc-300 font-medium">
              任务拆分为 {subtasks.length} 个子任务
            </span>
            {hasPaused && (
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-orange-500/15 text-orange-400">
                已暂停，等待用户介入
              </span>
            )}
          </div>
          <span className="text-xs text-zinc-500">{completedCount}/{subtasks.length}</span>
        </div>

        {/* Subtask List */}
        <div className="divide-y divide-zinc-700/30">
          {subtasks.map((sub) => {
            const state = subtaskStates[sub.id] || { status: "pending" };
            const statusInfo = STATUS_ICONS[state.status] || STATUS_ICONS.pending;
            const isExpanded = expandedId === sub.id;
            const isSupplementOpen = supplementOpen === sub.id;
            const hasContent = state.streamingContent && state.streamingContent.length > 0;
            const isPaused = state.status === "paused";
            const isFailed = state.status === "failed";
            const canSupplement = state.status === "pending" || state.status === "running" || isPaused || isFailed;

            return (
              <div key={sub.id}>
                <div
                  onClick={() => hasContent && setExpandedId(isExpanded ? null : sub.id)}
                  className={`flex items-center gap-3 px-4 py-2.5 transition ${
                    hasContent ? "cursor-pointer hover:bg-zinc-700/30" : ""
                  }`}
                >
                  <span className={`text-sm ${statusInfo.color}`}>{statusInfo.icon}</span>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-zinc-500 font-mono">{sub.id}</span>
                      <span className="text-sm text-zinc-300 truncate">{sub.title}</span>
                      {sub.inspect && (
                        <span className="text-[10px] px-1 py-0.5 rounded bg-amber-500/15 text-amber-400 shrink-0">
                          {state.status === "inspecting" ? "审查中..." :
                           state.inspectVerdict === "pass" ? "审查通过" :
                           state.inspectVerdict === "fail" ? "审查未通过" : "需审查"}
                        </span>
                      )}
                    </div>
                    {sub.dependsOn && sub.dependsOn.length > 0 && (
                      <p className="text-xs text-zinc-600 mt-0.5">
                        依赖: {sub.dependsOn.join(", ")}
                      </p>
                    )}
                    {(isPaused || isFailed) && state.failureReason && (
                      <p className="text-xs text-red-400 mt-1 line-clamp-2">
                        失败原因: {state.failureReason}
                      </p>
                    )}
                  </div>
                  <span className={`text-xs px-1.5 py-0.5 rounded ${statusInfo.bg} ${statusInfo.color}`}>
                    {statusInfo.label}
                  </span>
                  {canSupplement && sessionId && (
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        setSupplementOpen(isSupplementOpen ? null : sub.id);
                        setSupplementText("");
                      }}
                      className="text-[10px] px-2 py-1 rounded bg-zinc-700 hover:bg-zinc-600 text-zinc-300 transition shrink-0"
                      title={isPaused || isFailed ? "补充信息后重试" : "为此子任务追加上下文"}
                    >
                      {isPaused || isFailed ? "补充并重试" : "补充"}
                    </button>
                  )}
                  {hasContent && (
                    <svg
                      className={`w-3.5 h-3.5 text-zinc-500 transition-transform ${isExpanded ? "rotate-180" : ""}`}
                      fill="none" viewBox="0 0 24 24" stroke="currentColor"
                    >
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                    </svg>
                  )}
                </div>

                {/* 补充输入框 */}
                {isSupplementOpen && (
                  <div className="px-4 pb-3 space-y-2">
                    <textarea
                      value={supplementText}
                      onChange={(e) => setSupplementText(e.target.value)}
                      placeholder={isPaused || isFailed
                        ? "补充缺失的信息或决策（如选择 Python 还是 Java、提供路径等），然后点击重试..."
                        : "为该子任务追加上下文（在子任务执行时一并传给 AI）..."}
                      rows={3}
                      className="w-full bg-zinc-900 border border-zinc-700 rounded px-2.5 py-2 text-xs text-zinc-300 placeholder-zinc-600 outline-none focus:border-zinc-500 leading-relaxed resize-none font-mono"
                    />
                    <div className="flex justify-end gap-2">
                      <button
                        onClick={() => { setSupplementOpen(null); setSupplementText(""); }}
                        className="px-3 py-1 text-xs text-zinc-500 hover:text-zinc-300 transition"
                      >取消</button>
                      {(isPaused || isFailed) ? (
                        <button
                          onClick={() => submitSupplement(sub.id, true)}
                          disabled={submitting}
                          className="px-3 py-1 text-xs rounded bg-orange-600/30 hover:bg-orange-600/50 text-orange-200 transition disabled:opacity-50"
                        >
                          {submitting ? "重试中..." : "补充并重试"}
                        </button>
                      ) : (
                        <button
                          onClick={() => submitSupplement(sub.id, false)}
                          disabled={submitting || !supplementText.trim()}
                          className="px-3 py-1 text-xs rounded bg-blue-600/30 hover:bg-blue-600/50 text-blue-200 transition disabled:opacity-50"
                        >
                          {submitting ? "保存中..." : "保存"}
                        </button>
                      )}
                    </div>
                  </div>
                )}

                {/* 展开的流式输出 */}
                {isExpanded && hasContent && (
                  <div className="px-4 pb-3">
                    <div className="bg-zinc-900 border border-zinc-700 rounded-lg px-3 py-2 text-xs text-zinc-400 max-h-48 overflow-y-auto leading-relaxed">
                      <Markdown>{state.streamingContent}</Markdown>
                      {state.status === "running" && (
                        <span className="inline-block w-1.5 h-3 bg-blue-400 animate-pulse ml-0.5 align-text-bottom" />
                      )}
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {/* Progress Bar */}
        <div className="px-4 py-2.5 border-t border-zinc-700/50">
          <div className="flex items-center gap-3">
            <span className="text-xs text-zinc-500">进度</span>
            <div className="flex-1 bg-zinc-700 rounded-full h-1.5 overflow-hidden">
              <div
                className="h-full bg-blue-500 rounded-full transition-all duration-500"
                style={{ width: `${progress}%` }}
              />
            </div>
            <span className="text-xs text-zinc-500">{progress}%</span>
          </div>
        </div>
      </div>
    </div>
  );
}
