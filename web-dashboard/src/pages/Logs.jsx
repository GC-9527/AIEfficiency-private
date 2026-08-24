import React, { useState, useEffect, useRef, useCallback } from "react";
import { createGatewayWebSocket, getApiUrl } from "../services/gateway.js";
import { useNavigate } from "react-router-dom";
import { authenticatedFetch } from "../services/adminAuth.js";

export default function Logs() {
  const [logs, setLogs] = useState([]);
  const [tasks, setTasks] = useState([]);
  const [expandedTasks, setExpandedTasks] = useState({});
  const [filter, setFilter] = useState({ taskId: "", keyword: "", level: "" });
  const [selectedTask, setSelectedTask] = useState(null);
  const [subtaskFilter, setSubtaskFilter] = useState(null);
  const [realtime, setRealtime] = useState(true);
  const logEndRef = useRef(null);
  const navigate = useNavigate();

  // 跳转到对话
  const goToChat = (sessionId) => {
    if (!sessionId) return;
    navigate(`/chat?session=${sessionId}`);
  };

  // 获取顶级任务列表
  useEffect(() => {
    authenticatedFetch(getApiUrl("/api/tasks?topLevel=true&limit=30"))
      .then((r) => r.json())
      .then((d) => { if (d.success) setTasks(d.data); })
      .catch(() => {});
  }, []);

  // 解析 decomposition 获取子任务数量
  const getSubtaskCount = (task) => {
    if (!task.decomposition) return 0;
    try {
      const d = JSON.parse(task.decomposition);
      return d.subtasks?.length || 0;
    } catch { return 0; }
  };

  // 展开/收起子任务
  const toggleExpand = useCallback((parentId) => {
    if (expandedTasks[parentId]) {
      setExpandedTasks((prev) => { const n = { ...prev }; delete n[parentId]; return n; });
      return;
    }
    authenticatedFetch(getApiUrl(`/api/tasks?parentTaskId=${parentId}`))
      .then((r) => r.json())
      .then((d) => {
        if (d.success) setExpandedTasks((prev) => ({ ...prev, [parentId]: d.data }));
      })
      .catch(() => {});
  }, [expandedTasks]);

  // 计算当前需要监听日志的所有 taskId 集合
  const getRelatedTaskIds = useCallback(() => {
    if (!selectedTask) return null;
    const ids = new Set([selectedTask.id]);
    // 如果选中的是父任务，加入所有子任务 ID
    const subs = expandedTasks[selectedTask.id];
    if (subs) subs.forEach((s) => ids.add(s.id));
    return ids;
  }, [selectedTask, expandedTasks]);

  // 搜索/筛选日志
  useEffect(() => {
    const params = new URLSearchParams();
    if (subtaskFilter) {
      // 点击了概览条中的子任务 -> 只看该子任务日志
      params.set("taskId", subtaskFilter);
    } else if (selectedTask) {
      const related = getRelatedTaskIds();
      if (related && related.size > 1) {
        params.set("taskIds", [...related].join(","));
      } else {
        params.set("taskId", selectedTask.id);
      }
    }
    if (filter.keyword) params.set("keyword", filter.keyword);
    if (filter.level) params.set("level", filter.level);
    params.set("limit", "300");

    authenticatedFetch(getApiUrl(`/api/logs/search?${params}`))
      .then((r) => r.json())
      .then((d) => { if (d.success) setLogs(d.data.reverse()); })
      .catch(() => {});
  }, [filter, selectedTask, subtaskFilter, expandedTasks]);

  // 实时日志
  useEffect(() => {
    if (!realtime) return;
    const ws = createGatewayWebSocket();
    ws.onmessage = (e) => {
      const msg = JSON.parse(e.data);
      if (msg.type === "log") {
        const l = msg.data;
        if (subtaskFilter && l.taskId !== subtaskFilter) return;
        if (!subtaskFilter && selectedTask) {
          const related = getRelatedTaskIds();
          if (related && !related.has(l.taskId)) return;
        }
        if (filter.level && l.level !== filter.level) return;
        if (filter.keyword && !l.message?.includes(filter.keyword)) return;
        setLogs((prev) => [...prev.slice(-500), l]);
      }
    };
    return () => ws.close();
  }, [realtime, selectedTask, subtaskFilter, filter, getRelatedTaskIds]);

  useEffect(() => {
    if (realtime && logEndRef.current) {
      logEndRef.current.scrollIntoView({ behavior: "smooth" });
    }
  }, [logs, realtime]);

  // 选中任务处理
  const handleSelectTask = (task, isSubtask = false) => {
    setSubtaskFilter(null);
    setSelectedTask(task);
    if (!isSubtask && getSubtaskCount(task) > 0 && !expandedTasks[task.id]) {
      toggleExpand(task.id);
    }
  };

  const STATUS_DOT = {
    completed: "bg-green-500",
    running: "bg-blue-500 animate-pulse",
    failed: "bg-red-500",
    pending: "bg-zinc-600",
  };

  // 子任务概览条中显示的子任务列表
  const overviewSubtasks = selectedTask ? expandedTasks[selectedTask.id] : null;

  return (
    <div className="flex h-full">
      {/* 左侧 - 按任务分组 */}
      <div className="w-64 border-r border-zinc-800 flex flex-col shrink-0">
        <div className="h-12 border-b border-zinc-800 flex items-center px-3">
          <span className="text-sm font-medium text-zinc-300">任务列表</span>
        </div>

        <div className="p-2">
          <button
            onClick={() => { setSelectedTask(null); setSubtaskFilter(null); setFilter((f) => ({ ...f, taskId: "" })); }}
            className={`w-full text-left px-3 py-2 rounded-lg text-xs transition ${
              !selectedTask ? "bg-zinc-800 text-zinc-200" : "text-zinc-500 hover:bg-zinc-800/50"
            }`}
          >
            全部日志
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-2 space-y-0.5">
          {tasks.map((t) => {
            const subCount = getSubtaskCount(t);
            const isExpanded = !!expandedTasks[t.id];
            const subs = expandedTasks[t.id] || [];

            return (
              <div key={t.id}>
                {/* 父任务按钮 */}
                <button
                  onClick={() => handleSelectTask(t)}
                  className={`w-full text-left px-3 py-2 rounded-lg transition ${
                    selectedTask?.id === t.id && !subtaskFilter ? "bg-zinc-800 ring-1 ring-zinc-700" : "hover:bg-zinc-800/50"
                  }`}
                >
                  <div className="flex items-center space-x-2">
                    {subCount > 0 && (
                      <span
                        onClick={(e) => { e.stopPropagation(); toggleExpand(t.id); }}
                        className="text-zinc-600 hover:text-zinc-400 text-xs w-3 shrink-0 cursor-pointer select-none"
                      >
                        {isExpanded ? "▾" : "▸"}
                      </span>
                    )}
                    <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${STATUS_DOT[t.status] || "bg-zinc-600"}`} />
                    <span className="text-xs text-zinc-300 truncate flex-1">{t.title}</span>
                    {subCount > 0 && (
                      <span className="text-[10px] bg-zinc-700/60 text-zinc-400 px-1.5 py-0.5 rounded-full shrink-0">
                        {subCount}
                      </span>
                    )}
                  </div>
                  <div className="flex items-center space-x-2 mt-0.5" style={{ paddingLeft: subCount > 0 ? "1.25rem" : "0.875rem" }}>
                    <span className="text-xs text-zinc-600">{t.type}</span>
                    {t.assigned_engine && (
                      <span className="text-xs text-zinc-700">{t.assigned_engine}</span>
                    )}
                  </div>
                </button>

                {/* 展开的子任务列表 */}
                {isExpanded && subs.map((sub) => (
                  <button
                    key={sub.id}
                    onClick={() => { setSelectedTask(t); setSubtaskFilter(sub.id); }}
                    className={`w-full text-left py-1.5 rounded-lg transition ml-4 ${
                      subtaskFilter === sub.id ? "bg-zinc-800 ring-1 ring-zinc-700" : "hover:bg-zinc-800/50"
                    }`}
                    style={{ width: "calc(100% - 1rem)", paddingLeft: "0.75rem", paddingRight: "0.75rem" }}
                  >
                    <div className="flex items-center space-x-1.5">
                      <span className="text-zinc-700 text-[10px]">└</span>
                      <span className={`w-1 h-1 rounded-full shrink-0 ${STATUS_DOT[sub.status] || "bg-zinc-600"}`} />
                      <span className="text-[11px] text-zinc-500 truncate">{sub.subtask_id || sub.title}</span>
                    </div>
                  </button>
                ))}
              </div>
            );
          })}
        </div>
      </div>

      {/* 右侧 - 日志详情 */}
      <div className="flex-1 flex flex-col">
        {/* 搜索/筛选栏 */}
        <div className="h-12 border-b border-zinc-800 flex items-center px-3 space-x-2 shrink-0">
          <input
            type="text"
            value={filter.keyword}
            onChange={(e) => setFilter((f) => ({ ...f, keyword: e.target.value }))}
            placeholder="搜索日志内容..."
            className="flex-1 bg-zinc-800/50 border border-zinc-700 rounded px-3 py-1.5 text-xs text-zinc-300 placeholder-zinc-600 outline-none focus:border-zinc-500"
          />
          <select
            value={filter.level}
            onChange={(e) => setFilter((f) => ({ ...f, level: e.target.value }))}
            className="bg-zinc-800 border border-zinc-700 rounded px-2 py-1.5 text-xs text-zinc-300"
          >
            <option value="">全部级别</option>
            <option value="debug">DEBUG</option>
            <option value="info">INFO</option>
            <option value="warn">WARN</option>
            <option value="error">ERROR</option>
          </select>
          <button
            onClick={() => setRealtime(!realtime)}
            className={`text-xs px-2.5 py-1.5 rounded border ${
              realtime
                ? "border-green-500/30 bg-green-500/10 text-green-400"
                : "border-zinc-700 text-zinc-500"
            }`}
          >
            {realtime ? "实时" : "暂停"}
          </button>
        </div>

        {/* 选中任务信息 */}
        {selectedTask && (
          <div className="px-4 py-2 border-b border-zinc-800/50 bg-zinc-900/50 flex items-center space-x-4">
            <span className={`w-2 h-2 rounded-full ${STATUS_DOT[selectedTask.status]}`} />
            <span className="text-xs text-zinc-300">{selectedTask.title}</span>
            <span className="text-xs text-zinc-600 font-mono">{selectedTask.id.slice(0, 8)}</span>
            <span className="text-xs text-zinc-600">{selectedTask.assigned_engine || ""}</span>
            {subtaskFilter && (
              <button
                onClick={() => setSubtaskFilter(null)}
                className="text-[10px] text-zinc-500 hover:text-zinc-300 border border-zinc-700 rounded px-1.5 py-0.5"
              >
                查看全部子任务
              </button>
            )}
            {selectedTask.source_id && (
              <button
                onClick={() => goToChat(selectedTask.source_id)}
                className="text-[10px] text-blue-400 hover:text-blue-300 border border-blue-500/30 rounded px-1.5 py-0.5 transition"
              >
                跳转对话
              </button>
            )}
          </div>
        )}

        {/* 子任务概览条 */}
        {selectedTask && overviewSubtasks && overviewSubtasks.length > 0 && (
          <div className="px-4 py-1.5 border-b border-zinc-800/50 bg-zinc-900/30 flex items-center space-x-1 overflow-x-auto shrink-0">
            <span className="text-[10px] text-zinc-600 mr-1 shrink-0">子任务:</span>
            {overviewSubtasks.map((sub, i) => (
              <React.Fragment key={sub.id}>
                {i > 0 && <span className="text-zinc-800 text-[10px]">|</span>}
                <button
                  onClick={() => setSubtaskFilter(subtaskFilter === sub.id ? null : sub.id)}
                  className={`flex items-center space-x-1 px-1.5 py-0.5 rounded text-[11px] transition shrink-0 ${
                    subtaskFilter === sub.id
                      ? "bg-zinc-700/50 text-zinc-200"
                      : "text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800/50"
                  }`}
                >
                  <span className={`w-1.5 h-1.5 rounded-full ${STATUS_DOT[sub.status] || "bg-zinc-600"}`} />
                  <span className="font-mono">{sub.subtask_id || sub.id.slice(0, 6)}</span>
                  <span className="truncate max-w-[100px]">{sub.title}</span>
                </button>
              </React.Fragment>
            ))}
          </div>
        )}

        {/* 日志流 */}
        <div className="flex-1 overflow-y-auto bg-[#0a0a0b] p-3 font-mono text-xs">
          {logs.length === 0 ? (
            <div className="flex items-center justify-center h-full text-zinc-700">
              {filter.keyword ? "没有匹配的日志" : "暂无日志"}
            </div>
          ) : (
            logs.map((l, i) => (
              <div key={i} className="py-0.5 hover:bg-zinc-800/30 px-1 rounded leading-relaxed group flex items-start">
                <div className="flex-1">
                  <span className="text-zinc-700">{(l.timestamp || l.created_at || "").replace(/^\d{4}-\d{2}-\d{2}\s?/, "")} </span>
                  {l.task_title && <span className="text-zinc-600">[{l.task_title.slice(0, 15)}] </span>}
                  <span className={l.module === "thinking" ? "text-purple-400/70" : l.module === "tool_use" ? "text-cyan-400/70" : "text-zinc-600"}>[{l.module}] </span>
                  <span className={
                    l.level === "error" ? "text-red-400" :
                    l.level === "warn" ? "text-amber-400" :
                    l.level === "debug" ? "text-zinc-700" : "text-blue-400"
                  }>[{(l.level || "").toUpperCase()}] </span>
                  <span className="text-zinc-400">{l.message}</span>
                </div>
                {l.session_id && (
                  <button
                    onClick={() => goToChat(l.session_id)}
                    className="opacity-0 group-hover:opacity-100 shrink-0 ml-2 text-[10px] text-blue-400/60 hover:text-blue-300 transition"
                    title="跳转到对应对话"
                  >
                    &#x2197;
                  </button>
                )}
              </div>
            ))
          )}
          <div ref={logEndRef} />
        </div>
      </div>
    </div>
  );
}
