import React, { useState, useEffect, useRef, useCallback } from "react";
import { useLocation } from "react-router-dom";
import { createGatewayWebSocket, getApiUrl } from "../services/gateway.js";
import SubtaskPanel from "../components/SubtaskPanel.jsx";
import Markdown from "../components/Markdown.jsx";
import Transcript from "../components/Transcript.jsx";
import { authenticatedFetch } from "../services/adminAuth.js";

export default function Chat() {
  const location = useLocation();
  const [sessions, setSessions] = useState([]);
  const [activeSessionId, setActiveSessionId] = useState(null);
  const [messages, setMessages] = useState([]);
  const [msgTotal, setMsgTotal] = useState(0);    // 该会话消息总数
  const [msgOffset, setMsgOffset] = useState(0);  // 已加载的偏移量
  const [loadingMore, setLoadingMore] = useState(false);
  const PAGE_SIZE = 5;
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [activeTaskId, setActiveTaskId] = useState(null);
  const [taskLogs, setTaskLogs] = useState([]);
  const [loginPrompt, setLoginPrompt] = useState(null);
  const [showLogs, setShowLogs] = useState(false);
  const [dispatchInfo, setDispatchInfo] = useState(null);
  const [streamingContent, setStreamingContent] = useState("");
  const [isStreaming, setIsStreaming] = useState(false);
  const [thinkingContent, setThinkingContent] = useState("");
  const [thinkingExpanded, setThinkingExpanded] = useState(true);
  const [toolUses, setToolUses] = useState([]); // 当前流式中的工具调用列表
  const [skills, setSkills] = useState([]);
  const [showSkillMenu, setShowSkillMenu] = useState(false);
  const [skillFilter, setSkillFilter] = useState("");
  const [skillMenuIndex, setSkillMenuIndex] = useState(0);
  const [attachments, setAttachments] = useState([]);
  const [decomposition, setDecomposition] = useState(null);
  const [subtaskStates, setSubtaskStates] = useState({});
  const [isSummarizing, setIsSummarizing] = useState(false);
  const [summaryStreaming, setSummaryStreaming] = useState("");
  const activeSessionIdRef = useRef(null);
  const activeTaskIdRef = useRef(null);
  const streamingRef = useRef(false);
  const streamingContentRef = useRef("");
  const endRef = useRef(null);
  const inputRef = useRef(null);
  const wsRef = useRef(null);
  const reconnectTimerRef = useRef(null);
  const reconnectDelayRef = useRef(1000);
  const skillMenuRef = useRef(null);
  // 保存每个会话的运行中任务状态，切换会话/tab时可恢复
  const sessionRunStateRef = useRef(new Map());

  // 同步 ref（activeSessionIdRef 在会话切换 effect 内手动更新，避免时序问题）
  useEffect(() => { activeTaskIdRef.current = activeTaskId; }, [activeTaskId]);
  useEffect(() => { streamingRef.current = isStreaming; }, [isStreaming]);
  useEffect(() => { streamingContentRef.current = streamingContent; }, [streamingContent]);

  // 发送 WebSocket 订阅消息
  function wsSubscribe(ws, sessionId) {
    if (ws && ws.readyState === 1 && sessionId) {
      ws.send(JSON.stringify({ type: "subscribe_session", sessionId }));
    }
  }

  function wsUnsubscribe(ws, sessionId) {
    if (ws && ws.readyState === 1 && sessionId) {
      ws.send(JSON.stringify({ type: "unsubscribe_session", sessionId }));
    }
  }

  // 持久 WebSocket 连接（mount 时创建，unmount 时关闭）
  useEffect(() => {
    let disposed = false; // 防止 StrictMode cleanup 后重连导致双连接

    function connect() {
      if (disposed) return; // cleanup 后不再连接
      const ws = createGatewayWebSocket();
      wsRef.current = ws;

      ws.onopen = () => {
        reconnectDelayRef.current = 1000; // 重置退避
        // 重连后重新订阅当前会话
        if (activeSessionIdRef.current) {
          wsSubscribe(ws, activeSessionIdRef.current);
        }
      };

      ws.onmessage = (e) => {
        const msg = JSON.parse(e.data);

        if (msg.type === "task_decomposition") {
          const data = msg.data;
          if (data.sessionId === activeSessionIdRef.current) {
            setDecomposition(data.decomposition);
            const states = {};
            for (const sub of (data.decomposition.subtasks || [])) {
              states[sub.id] = { status: "pending", streamingContent: "" };
            }
            setSubtaskStates(states);
          } else {
            // 非当前会话：缓存 decomposition
            const saved = sessionRunStateRef.current.get(data.sessionId);
            if (saved) {
              saved.decomposition = data.decomposition;
              const states = {};
              for (const sub of (data.decomposition.subtasks || [])) {
                states[sub.id] = { status: "pending", streamingContent: "" };
              }
              saved.subtaskStates = states;
            }
          }
        }

        if (msg.type === "subtask_update") {
          const data = msg.data;
          if (data.sessionId === activeSessionIdRef.current) {
            setSubtaskStates((prev) => ({
              ...prev,
              [data.subtaskId]: {
                ...prev[data.subtaskId],
                status: data.status,
                childTaskId: data.childTaskId,
                inspectVerdict: data.inspectVerdict || prev[data.subtaskId]?.inspectVerdict,
                inspectReason: data.inspectReason || prev[data.subtaskId]?.inspectReason,
                failureReason: data.failureReason || prev[data.subtaskId]?.failureReason,
              },
            }));
          } else {
            // 非当前会话：缓存子任务状态
            const saved = sessionRunStateRef.current.get(data.sessionId);
            if (saved?.subtaskStates) {
              saved.subtaskStates[data.subtaskId] = {
                ...saved.subtaskStates[data.subtaskId],
                status: data.status,
                failureReason: data.failureReason || saved.subtaskStates[data.subtaskId]?.failureReason,
              };
            }
          }
        }

        if (msg.type === "workflow_update") {
          const data = msg.data;
          if (data.sessionId !== activeSessionIdRef.current) return;

          // 首次收到 running + steps：初始化 decomposition 供 SubtaskPanel 渲染
          if (data.status === "running" && data.steps) {
            setDecomposition({ subtasks: data.steps });
            const states = {};
            for (const step of data.steps) {
              states[step.id] = { status: data.stepStates?.[step.id]?.status || "pending", streamingContent: "" };
            }
            setSubtaskStates(states);
          }

          // 步骤状态更新
          if (data.stepId) {
            setSubtaskStates((prev) => ({
              ...prev,
              [data.stepId]: {
                ...prev[data.stepId],
                status: data.stepStatus || prev[data.stepId]?.status,
                streamingContent: data.output
                  ? (prev[data.stepId]?.streamingContent || "") + data.output
                  : prev[data.stepId]?.streamingContent || "",
              },
            }));
          }

          // 工作流完成/失败：清理面板（chat_message 到达时也会清理）
          if (data.status === "completed" || data.status === "failed" || data.status === "aborted") {
            // 保留面板几秒让用户看到最终状态，chat_message 到达后会清除
          }
        }

        if (msg.type === "chat_stream") {
          const data = msg.data;
          const deltaType = data.deltaType || "text";

          // 汇总流式输出
          if (deltaType === "summary" && data.sessionId === activeSessionIdRef.current) {
            setIsSummarizing(true);
            setSummaryStreaming((prev) => prev + data.chunk);
          }

          // 子任务流式输出：分流到对应子任务
          if (data.subtaskId && data.sessionId === activeSessionIdRef.current) {
            if (deltaType === "text" || !deltaType) {
              setSubtaskStates((prev) => ({
                ...prev,
                [data.subtaskId]: {
                  ...prev[data.subtaskId],
                  streamingContent: (prev[data.subtaskId]?.streamingContent || "") + data.chunk,
                },
              }));
            }
          }

          // 当前会话的流式输出：实时渲染（非子任务/非汇总）
          if (!data.subtaskId && deltaType !== "summary" &&
              data.taskId === activeTaskIdRef.current &&
              (data.sessionId === activeSessionIdRef.current || !data.sessionId)) {

            if (deltaType === "thinking") {
              // CLI 一次性发送完整思考内容（非流式）
              setThinkingContent((prev) => prev + data.chunk);
              setThinkingExpanded(true);
            } else if (deltaType === "tool_use") {
              setToolUses((prev) => [...prev, data.chunk]); // chunk = toolName
            } else if (deltaType !== "status" && deltaType !== "usage") {
              // text delta
              if (!streamingRef.current) {
                setIsStreaming(true);
                setStreamingContent(data.chunk);
              } else {
                setStreamingContent((prev) => prev + data.chunk);
              }
            }
          } else if (data.sessionId) {
            // 非当前会话的流式输出：完整缓存（切回时恢复）
            const saved = sessionRunStateRef.current.get(data.sessionId);
            if (saved && saved.taskId === data.taskId) {
              if (deltaType === "thinking") {
                saved.thinkingContent = (saved.thinkingContent || "") + data.chunk;
              } else if (deltaType === "tool_use") {
                saved.toolUses = [...(saved.toolUses || []), data.chunk];
              } else if (deltaType === "text" || !deltaType) {
                saved.streamingContent = (saved.streamingContent || "") + data.chunk;
                saved.isStreaming = true;
              }
            }
          }
        }

        if (msg.type === "chat_stream_end") {
          const data = msg.data;
          if (data.taskId === activeTaskIdRef.current) {
            setIsStreaming(false);
          } else if (data.sessionId) {
            // 非当前会话：标记流结束
            const saved = sessionRunStateRef.current.get(data.sessionId);
            if (saved && saved.taskId === data.taskId) {
              saved.isStreaming = false;
            }
          }
        }

        if (msg.type === "chat_message") {
          const data = msg.data;
          // 清理该会话的缓存运行状态 + 取消 WS 订阅（任务已结束）
          if (data.session_id) {
            sessionRunStateRef.current.delete(data.session_id);
            // 非当前会话任务完成，取消多余的 WS 订阅
            if (data.session_id !== activeSessionIdRef.current && wsRef.current?.readyState === 1) {
              wsUnsubscribe(wsRef.current, data.session_id);
            }
          }
          // 匹配当前会话
          if (data.session_id === activeSessionIdRef.current) {
            const content = String(data.content || "");
            const liveContent = String(streamingContentRef.current || "").trim();
            const messageData = data.role === "assistant" && /^执行失败[:：]/.test(content.trim()) && liveContent
              ? { ...data, content: `${liveContent}\n\n---\n${content.trim()}` }
              : data;
            // 流式输出结束，替换为完整消息
            setStreamingContent("");
            setIsStreaming(false);
            setThinkingContent("");
            setToolUses([]);
            setDecomposition(null);
            setSubtaskStates({});
            setIsSummarizing(false);
            setSummaryStreaming("");
            setMessages((prev) => {
              // 去重：检查是否已有相同 task_id 的 assistant 消息
              if (data.task_id && prev.some(m => m.task_id === data.task_id && m.role === "assistant")) {
                return prev;
              }
              return [...prev, messageData];
            });
            setSending(false);
            setActiveTaskId(null);
          }
        }

        if (msg.type === "login_required") {
          const data = msg.data;
          setLoginPrompt({
            engine: data.engine === "claude" ? "Claude Code" : "Gemini CLI",
            cmd: data.loginCmd,
          });
        }

        if (msg.type === "task_dispatched") {
          const data = msg.data;
          if (data.taskId === activeTaskIdRef.current) {
            setDispatchInfo(data);
          }
        }

        if (msg.type === "log" && msg.data.taskId === activeTaskIdRef.current) {
          setTaskLogs((prev) => [...prev, msg.data]);
        }

        if (msg.type === "task_update") {
          // 任务结束时清理缓存的运行状态
          if (msg.data.status === "failed" || msg.data.status === "completed") {
            for (const [sid, state] of sessionRunStateRef.current) {
              if (state.taskId === msg.data.id) {
                sessionRunStateRef.current.delete(sid);
                break;
              }
            }
          }
          // 仅用于状态指示（备用，主要靠 chat_message）
          if (msg.data.id === activeTaskIdRef.current) {
            if (msg.data.status === "failed") {
              setIsStreaming(false);

              setSending(false);
            }
          }
        }
      };

      ws.onerror = () => {};

      ws.onclose = () => {
        wsRef.current = null;
        if (disposed) return; // cleanup 后不重连
        // 指数退避重连
        const delay = reconnectDelayRef.current;
        reconnectTimerRef.current = setTimeout(() => {
          reconnectDelayRef.current = Math.min(delay * 2, 30000);
          connect();
        }, delay);
      };
    }

    connect();

    return () => {
      disposed = true; // 标记已销毁，阻止 onclose 重连
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
      if (wsRef.current) wsRef.current.close();
    };
  }, []);

  // 加载 Skill 列表 + 工作流列表
  // 团队模式（http 加载）：从云端获取共享 skills；独立模式（file 加载）：从本地网关获取
  useEffect(() => {
    const skillsUrl = window.location.protocol.startsWith("http")
      ? `${window.location.origin}/api/skills`
      : getApiUrl("/api/skills");
    authenticatedFetch(skillsUrl)
      .then((r) => r.json())
      .then((d) => {
        if (d.success) setSkills((prev) => [...prev.filter((s) => s._isWorkflow), ...d.data]);
      })
      .catch(() => {});
    authenticatedFetch(getApiUrl("/api/workflows"))
      .then((r) => r.json())
      .then((d) => {
        if (d.success) {
          // 将工作流合并到 skills 列表，加 _isWorkflow 标记
          setSkills((prev) => {
            const wfItems = d.data.map((w) => ({
              id: w.name,
              name: w.name,
              description: w.description || "工作流",
              _isWorkflow: true,
            }));
            // 保留非工作流项，追加工作流项
            return [...prev.filter((s) => !s._isWorkflow), ...wfItems];
          });
        }
      })
      .catch(() => {});
  }, []);

  // 点击菜单外关闭 Skill 菜单
  useEffect(() => {
    if (!showSkillMenu) return;
    function handleClickOutside(e) {
      if (skillMenuRef.current && !skillMenuRef.current.contains(e.target) && e.target !== inputRef.current) {
        setShowSkillMenu(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [showSkillMenu]);

  // 加载会话列表
  useEffect(() => {
    authenticatedFetch(getApiUrl("/api/chat/sessions?limit=50"))
      .then((r) => r.json())
      .then((d) => {
        if (d.success && d.data.length > 0) {
          setSessions(d.data);
          if (!activeSessionIdRef.current) {
            setActiveSessionId(d.data[0].id);
          }
        }
      })
      .catch(() => {});
  }, []);

  // 监听 URL ?session=xxx 跳转（从日志等其他页面导航过来）
  useEffect(() => {
    const params = new URLSearchParams(location.search);
    const targetSession = params.get("session");
    if (targetSession && targetSession !== activeSessionIdRef.current) {
      setActiveSessionId(targetSession);
      // 清除 URL 参数
      window.history.replaceState({}, "", location.pathname);
    }
  }, [location]);

  // 切换会话时：保存旧会话完整运行状态 → 加载消息 → 恢复新会话运行状态 → 切换WS订阅
  useEffect(() => {
    const prevId = activeSessionIdRef.current;

    // 保存上一个会话的完整运行状态
    if (prevId && prevId !== activeSessionId && activeTaskIdRef.current) {
      sessionRunStateRef.current.set(prevId, {
        taskId: activeTaskIdRef.current,
        dispatchInfo,
        streamingContent,
        isStreaming,
        thinkingContent,
        toolUses,
        decomposition,
        subtaskStates,
        isSummarizing,
        summaryStreaming,
      });
    }

    activeSessionIdRef.current = activeSessionId;

    // WS 订阅：新 session 加订阅，旧 session 有 running task 时保留订阅（不取消）
    if (wsRef.current && wsRef.current.readyState === 1) {
      // 旧 session 如果无 running task，才取消订阅
      if (prevId && !sessionRunStateRef.current.has(prevId)) {
        wsUnsubscribe(wsRef.current, prevId);
      }
      if (activeSessionId) wsSubscribe(wsRef.current, activeSessionId);
    }

    if (!activeSessionId) {
      setMessages([]);
      setSending(false);
      setActiveTaskId(null);
      return;
    }

    authenticatedFetch(getApiUrl(`/api/chat/sessions/${activeSessionId}/messages?limit=${PAGE_SIZE}&offset=0`))
      .then((r) => r.json())
      .then((d) => {
        if (d.success) {
          setMessages(d.data);
          setMsgTotal(d.total || 0);
          setMsgOffset(PAGE_SIZE);
        }
      })
      .catch(() => {});
    setTaskLogs([]);
    setLoginPrompt(null);

    // 恢复目标会话的完整运行状态
    const saved = sessionRunStateRef.current.get(activeSessionId);
    if (saved) {
      setSending(true);
      setActiveTaskId(saved.taskId);
      setDispatchInfo(saved.dispatchInfo);
      setStreamingContent(saved.streamingContent || "");
      setIsStreaming(saved.isStreaming || false);
      setThinkingContent(saved.thinkingContent || "");
      setToolUses(saved.toolUses || []);
      setDecomposition(saved.decomposition || null);
      setSubtaskStates(saved.subtaskStates || {});
      setIsSummarizing(saved.isSummarizing || false);
      setSummaryStreaming(saved.summaryStreaming || "");
    } else {
      // 无缓存状态时，重置并查询后端（同时覆盖 running 与 pending：
      // 复合任务处于 AI 规划阶段时任务 status 仍是 pending，只查 running 会漏掉，
      // 导致刷新页面后看不到停止入口）
      setSending(false);
      setActiveTaskId(null);
      setDispatchInfo(null);
      setStreamingContent("");
      setIsStreaming(false);
      setThinkingContent("");
      setToolUses([]);
      setDecomposition(null);
      setSubtaskStates({});
      setIsSummarizing(false);
      setSummaryStreaming("");
      Promise.all([
        // 只查顶层任务（parent_task_id IS NULL）：同一会话下存在 priority 更高的审查/
        // DAG 子任务，若不排除会恢复出子任务，点停止停不掉真正运行的父任务
        authenticatedFetch(getApiUrl(`/api/tasks?status=running&topLevel=true&sourceId=${encodeURIComponent(activeSessionId)}&limit=5`))
          .then((r) => r.json()).catch(() => ({ success: false })),
        authenticatedFetch(getApiUrl(`/api/tasks?status=pending&topLevel=true&sourceId=${encodeURIComponent(activeSessionId)}&limit=5`))
          .then((r) => r.json()).catch(() => ({ success: false })),
      ])
        .then(([runningRes, pendingRes]) => {
          const candidates = [
            ...(runningRes.success ? runningRes.data : []),
            ...(pendingRes.success ? pendingRes.data : []),
          ];
          if (candidates.length === 0) return;
          // listTasks 按 priority ASC, created_at DESC 排序；顶层任务 priority 一致时取最新
          const activeTask = candidates[0];
          setSending(true);
          setActiveTaskId(activeTask.id);
          setDispatchInfo({
            taskId: activeTask.id,
            type: activeTask.type,
            engine: activeTask.assigned_engine || "claude",
          });
        })
        .catch(() => {});
    }
  }, [activeSessionId]);

  // 自动滚动
  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, taskLogs, streamingContent, thinkingContent, summaryStreaming, subtaskStates]);

  // 创建新会话
  const createSession = useCallback(async () => {
    try {
      const resp = await authenticatedFetch(getApiUrl("/api/chat/sessions"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "新对话" }),
      });
      const d = await resp.json();
      if (d.success) {
        setSessions((prev) => [d.data, ...prev]);
        setActiveSessionId(d.data.id);
      }
    } catch {}
  }, []);

  // 删除会话
  const deleteSession = useCallback(async (id, e) => {
    e.stopPropagation();
    try {
      await authenticatedFetch(getApiUrl(`/api/chat/sessions/${id}`), { method: "DELETE" });
      setSessions((prev) => prev.filter((s) => s.id !== id));
      if (activeSessionId === id) {
        setActiveSessionId(null);
        setMessages([]);
      }
    } catch {}
  }, [activeSessionId]);

  const togglePin = useCallback(async (id, pin, e) => {
    e.stopPropagation();
    try {
      const resp = await authenticatedFetch(getApiUrl(`/api/chat/sessions/${id}`), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pinned: pin ? 1 : 0 }),
      });
      const data = await resp.json();
      if (!data.success) return;
      setSessions((prev) => {
        const updated = prev.map((s) => (s.id === id ? { ...s, pinned: pin ? 1 : 0 } : s));
        return [...updated].sort((a, b) => {
          const pa = a.pinned ? 1 : 0;
          const pb = b.pinned ? 1 : 0;
          if (pa !== pb) return pb - pa;
          return new Date(b.updated_at) - new Date(a.updated_at);
        });
      });
    } catch {}
  }, []);

  // Skill 菜单过滤结果
  const filteredSkills = skills.filter(
    (s) => s.id.includes(skillFilter) || s.name.includes(skillFilter)
  );

  function selectSkill(skill) {
    if (!skill) return;
    setInput((prev) => prev.replace(/\/[\w\u4e00-\u9fff-]*$/, `/${skill.id} `));
    setShowSkillMenu(false);
    setSkillFilter("");
    setSkillMenuIndex(0);
    inputRef.current?.focus();
  }

  function handleInputChange(e) {
    const val = e.target.value;
    setInput(val);
    // 检测末尾 /xxx 模式
    const match = val.match(/(?:^|\s)\/([\w\u4e00-\u9fff-]*)$/);
    if (match) {
      setShowSkillMenu(true);
      setSkillFilter(match[1]);
      setSkillMenuIndex(0);
    } else {
      setShowSkillMenu(false);
    }
  }

  async function handlePaste(e) {
    const text = e.clipboardData.getData("text/plain");
    const hasFiles = e.clipboardData.files.length > 0 ||
      Array.from(e.clipboardData.items || []).some(item => item.kind === "file");

    // Windows 资源管理器复制文件时，textarea 中 paste 事件既无 text 也无 files
    // 检测条件：无文本内容 或 有文件对象 → 尝试调用后端读取剪贴板文件路径
    if (hasFiles || !text) {
      e.preventDefault();
      try {
        const resp = await authenticatedFetch(getApiUrl(`/api/clipboard/files?_t=${Date.now()}`));
        const data = await resp.json();
        if (data.success && data.data.length > 0) {
          const newAttachments = data.data.map(p => ({
            id: Math.random().toString(36).slice(2) + Date.now().toString(36),
            path: p,
            name: p.split(/[/\\]/).pop(),
            isDir: !p.split(/[/\\]/).pop().includes("."),
            isImage: /\.(png|jpg|jpeg|gif|bmp|webp)$/i.test(p),
          }));
          setAttachments(prev => [...prev, ...newAttachments]);
        }
      } catch {
        // 网关不可用时静默失败
      }
      return;
    }

    // 兼容：纯文本路径粘贴（手动复制路径字符串）
    const pathPattern = /^([A-Z]:\\[^\n]+|\/[^\n]+\.[a-zA-Z0-9]+)$/;
    const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
    const paths = lines.filter((l) => pathPattern.test(l));
    if (paths.length > 0 && paths.length === lines.length) {
      e.preventDefault();
      const newAttachments = paths.map((p) => ({
        id: Math.random().toString(36).slice(2) + Date.now().toString(36),
        path: p,
        name: p.split(/[/\\]/).pop(),
        isDir: !p.split(/[/\\]/).pop().includes("."),
        isImage: /\.(png|jpg|jpeg|gif|bmp|webp)$/i.test(p),
      }));
      setAttachments((prev) => [...prev, ...newAttachments]);
    }
  }

  function removeAttachment(id) {
    setAttachments((prev) => prev.filter((a) => a.id !== id));
  }

  // 加载更多历史消息
  async function loadMoreMessages() {
    if (!activeSessionId || loadingMore || msgOffset >= msgTotal) return;
    setLoadingMore(true);
    try {
      const resp = await authenticatedFetch(getApiUrl(`/api/chat/sessions/${activeSessionId}/messages?limit=${PAGE_SIZE}&offset=${msgOffset}`));
      const d = await resp.json();
      if (d.success && d.data.length > 0) {
        setMessages((prev) => [...d.data, ...prev]);
        setMsgOffset((prev) => prev + d.data.length);
      }
    } catch {}
    setLoadingMore(false);
  }

  // 发送消息
  async function send() {
    let text = input.trim();
    if ((!text && attachments.length === 0) || sending) return;
    if (attachments.length > 0) {
      const filePaths = attachments.map((a) => a.path).join("\n");
      text = text ? `${text}\n\n[附件文件]\n${filePaths}` : `[附件文件]\n${filePaths}`;
    }

    // 无会话时自动创建
    let sessionId = activeSessionId;
    if (!sessionId) {
      try {
        const resp = await authenticatedFetch(getApiUrl("/api/chat/sessions"), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ title: text.slice(0, 40) }),
        });
        const d = await resp.json();
        if (d.success) {
          setSessions((prev) => [d.data, ...prev]);
          sessionId = d.data.id;
          setActiveSessionId(sessionId);
        }
      } catch (err) {
        setMessages((prev) => [...prev, { role: "system", content: `创建会话失败: ${err.message}` }]);
        return;
      }
    }

    setSending(true);
    setInput("");
    setAttachments([]);
    setTaskLogs([]);
    setLoginPrompt(null);
    setDispatchInfo(null);
    setStreamingContent("");
    setIsStreaming(false);
    setThinkingContent("");
    setToolUses([]);
    setShowLogs(true);
    setDecomposition(null);
    setSubtaskStates({});
    setIsSummarizing(false);
    setSummaryStreaming("");

    // 乐观添加用户消息
    setMessages((prev) => [...prev, { role: "user", content: text, created_at: new Date().toISOString() }]);

    try {
      const resp = await authenticatedFetch(getApiUrl(`/api/chat/sessions/${sessionId}/send`), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: text }),
      });
      const data = await resp.json();
      if (data.success) {
        setActiveTaskId(data.data.taskId);
        // 立即显示分类结果（不等 WS）
        if (data.data.type) {
          setDispatchInfo({
            taskId: data.data.taskId,
            type: data.data.type,
            engine: data.data.engine,
            skill: data.data.skill ? `/${data.data.skill}` : null,
          });
        }
        // 更新侧栏标题（仅未锁定时自动更新）
        setSessions((prev) =>
          prev.map((s) => {
            if (s.id !== sessionId) return s;
            if (s.title_locked) return { ...s, updated_at: new Date().toISOString() };
            return { ...s, title: text.slice(0, 40), updated_at: new Date().toISOString() };
          })
        );
      }
    } catch (err) {
      setMessages((prev) => [...prev, { role: "system", content: `网关未连接: ${err.message}` }]);
      setSending(false);
    }

    inputRef.current?.focus();
  }

  // 清理当前会话的本地运行态（乐观重置，避免依赖 WS 收尾事件导致界面卡死）
  function resetRunState() {
    setSending(false);
    setActiveTaskId(null);
    setIsStreaming(false);
    setStreamingContent("");
    setThinkingContent("");
    setToolUses([]);
    setDecomposition(null);
    setSubtaskStates({});
    setIsSummarizing(false);
    setSummaryStreaming("");
    if (activeSessionIdRef.current) {
      sessionRunStateRef.current.delete(activeSessionIdRef.current);
    }
  }

  // 停止任务：无论后端/WS 是否正常收尾，本地 UI 都必须退出"处理中"，
  // 否则 WS 断线或后端异常时界面永久卡死、无法再发送消息。
  async function stopTask() {
    const taskId = activeTaskId;
    if (!taskId) return;
    try {
      const resp = await authenticatedFetch(getApiUrl(`/api/tasks/${taskId}/stop`), { method: "POST" });
      if (!resp.ok) {
        const body = await resp.json().catch(() => ({}));
        setMessages((prev) => [...prev, {
          role: "system",
          content: `停止任务失败（HTTP ${resp.status}）：${body?.error || resp.statusText || "未知错误"}。已本地重置，若任务仍在运行请刷新页面重试。`,
        }]);
      }
    } catch (err) {
      setMessages((prev) => [...prev, {
        role: "system",
        content: `停止请求失败：${err.message}。已本地重置，若任务仍在运行请刷新页面重试。`,
      }]);
    } finally {
      resetRunState();
    }
  }

  function handleKey(e) {
    if (showSkillMenu) {
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setSkillMenuIndex((i) => Math.max(0, i - 1));
        return;
      }
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSkillMenuIndex((i) => Math.min(filteredSkills.length - 1, i + 1));
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        selectSkill(filteredSkills[skillMenuIndex]);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setShowSkillMenu(false);
        return;
      }
    }
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); }
  }

  return (
    <div className="flex h-full">
      {/* 会话侧栏 */}
      <div className="w-64 border-r border-zinc-800 flex flex-col shrink-0">
        <div className="h-12 border-b border-zinc-800 flex items-center px-3">
          <button
            onClick={createSession}
            className="w-full text-xs px-3 py-2 rounded-lg bg-blue-600 hover:bg-blue-500 text-white transition flex items-center justify-center gap-1.5"
          >
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" /></svg>
            新对话
          </button>
        </div>
        <div className="flex-1 overflow-y-auto">
          {sessions.map((s, idx) => (
            <div
              key={s.id}
              draggable
              onDragStart={(e) => { e.dataTransfer.setData("text/plain", String(idx)); e.dataTransfer.effectAllowed = "move"; e.currentTarget.classList.add("opacity-40"); }}
              onDragEnd={(e) => { e.currentTarget.classList.remove("opacity-40"); }}
              onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = "move"; e.currentTarget.classList.add("border-t-blue-500"); }}
              onDragLeave={(e) => { e.currentTarget.classList.remove("border-t-blue-500"); }}
              onDrop={(e) => {
                e.preventDefault();
                e.currentTarget.classList.remove("border-t-blue-500");
                const fromIdx = parseInt(e.dataTransfer.getData("text/plain"));
                if (isNaN(fromIdx) || fromIdx === idx) return;
                setSessions((prev) => {
                  const arr = [...prev];
                  const [moved] = arr.splice(fromIdx, 1);
                  arr.splice(idx, 0, moved);
                  return arr;
                });
              }}
              onClick={() => setActiveSessionId(s.id)}
              className={`group flex items-center justify-between px-3 py-2.5 cursor-pointer border-b border-zinc-800/50 border-t-2 border-t-transparent transition ${
                s.id === activeSessionId ? "bg-zinc-800" : "hover:bg-zinc-800/50"
              }`}
            >
              <div className="min-w-0 flex-1">
                <p className="text-sm text-zinc-300 truncate">{s.title}</p>
                <p className="text-xs text-zinc-600 mt-0.5">{formatTime(s.updated_at)}</p>
              </div>
              <div className="flex items-center gap-1 ml-2 shrink-0">
                <button
                  onClick={(e) => togglePin(s.id, !s.pinned, e)}
                  title={s.pinned ? "取消置顶" : "置顶"}
                  className={`transition ${s.pinned ? "text-amber-400 hover:text-amber-300" : "opacity-0 group-hover:opacity-100 text-zinc-600 hover:text-amber-400"}`}
                >
                  <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="currentColor"><path d="M16 4l4 4-5 1-4 4-1 5-3-3-5 5v-2l5-5-3-3 5-1 4-4 1-5 2 4z"/></svg>
                </button>
                <button
                  onClick={(e) => deleteSession(s.id, e)}
                  className="opacity-0 group-hover:opacity-100 text-zinc-600 hover:text-red-400 transition"
                >
                  <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
                </button>
              </div>
            </div>
          ))}
          {sessions.length === 0 && (
            <p className="text-xs text-zinc-600 text-center mt-8 px-4">暂无对话，点击上方按钮开始</p>
          )}
        </div>
      </div>

      {/* 主聊天区 */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* 顶栏 */}
        <div className="h-12 border-b border-zinc-800 flex items-center justify-between px-4 shrink-0">
          <EditableTitle
            sessionId={activeSessionId}
            title={activeSessionId ? sessions.find((s) => s.id === activeSessionId)?.title || "对话" : "AI 对话"}
            onSaved={(newTitle) => {
              setSessions((prev) =>
                prev.map((s) => s.id === activeSessionId ? { ...s, title: newTitle, title_locked: 1 } : s)
              );
            }}
          />
          <div className="flex items-center space-x-3">
            {sending && activeTaskId && (
              <button
                onClick={stopTask}
                className="text-xs px-2 py-1 rounded bg-red-600/20 text-red-400 hover:bg-red-600/30 transition"
              >
                停止
              </button>
            )}
            {sending && dispatchInfo && (
              <span className="text-xs px-2 py-0.5 rounded bg-zinc-700/80 text-zinc-300">
                {dispatchInfo.type} · {dispatchInfo.engine === "claude" ? "Claude" : "Gemini"}
                {dispatchInfo.skill && <span className="text-zinc-500 ml-1">{dispatchInfo.skill}</span>}
              </span>
            )}
            {sending && (
              <span className="flex items-center text-xs text-blue-400">
                <span className="w-1.5 h-1.5 bg-blue-400 rounded-full animate-pulse mr-1.5" />
                处理中...
              </span>
            )}
            <button
              onClick={() => setShowLogs(!showLogs)}
              className={`text-xs px-2 py-1 rounded ${showLogs ? "bg-zinc-700 text-zinc-200" : "text-zinc-500 hover:text-zinc-300"}`}
            >
              {showLogs ? "隐藏日志" : "显示日志"}
            </button>
          </div>
        </div>

        {/* 消息列表 */}
        <div className="flex-1 overflow-y-auto px-4 py-4 space-y-4">
          {messages.length === 0 && !sending && (
            <div className="flex items-center justify-center h-full">
              <div className="text-center max-w-md">
                <div className="w-14 h-14 mx-auto mb-4 rounded-2xl bg-gradient-to-br from-blue-500/20 to-violet-600/20 flex items-center justify-center">
                  <svg className="w-7 h-7 text-blue-400" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" /></svg>
                </div>
                <p className="text-zinc-400 text-sm">输入任务描述，系统自动识别类型并选择最佳引擎</p>
                <div className="flex flex-wrap justify-center gap-2 mt-4">
                  {["分析这个crash日志", "修改smali绕过检查", "适配1920x720分辨率", "抓取logcat日志"].map((s) => (
                    <button key={s} onClick={() => setInput(s)} className="text-xs px-3 py-1.5 rounded-full border border-zinc-700 text-zinc-400 hover:border-zinc-500 hover:text-zinc-200 transition">
                      {s}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          )}

          {/* 查看更多历史消息 */}
          {msgTotal > PAGE_SIZE && msgOffset < msgTotal && (
            <div className="flex justify-center py-2">
              <button
                onClick={loadMoreMessages}
                disabled={loadingMore}
                className="text-xs px-4 py-1.5 rounded-full bg-zinc-800 hover:bg-zinc-700 text-zinc-400 transition disabled:opacity-50"
              >
                {loadingMore ? "加载中..." : `查看更早的消息 (${msgTotal - msgOffset} 条)`}
              </button>
            </div>
          )}

          {messages.map((msg, i) => (
            <MessageBubble key={msg.id || i} msg={msg} />
          ))}

          {/* 子任务面板 */}
          {decomposition && sending && (
            <SubtaskPanel
              decomposition={decomposition}
              subtaskStates={subtaskStates}
              sessionId={activeSessionId}
            />
          )}

          {/* 汇总流式输出 */}
          {isSummarizing && summaryStreaming && sending && (
            <div className="flex justify-start">
              <div className="max-w-[75%] rounded-2xl px-4 py-3 text-sm bg-zinc-800 text-zinc-200 rounded-bl-md">
                <div className="flex items-center gap-1.5 text-xs text-zinc-500 mb-2">
                  <span>&#x1F4CB;</span> 汇总中...
                </div>
                <Markdown className="leading-relaxed">{summaryStreaming}</Markdown>
                <span className="inline-block w-1.5 h-4 bg-green-400 animate-pulse ml-0.5 align-text-bottom" />
              </div>
            </div>
          )}

          {/* AI 思考中加载指示器 */}
          {sending && !streamingContent && !isStreaming && (
            <div className="flex justify-start">
              <div className="max-w-[75%] rounded-2xl px-4 py-3 text-sm bg-zinc-800 text-zinc-200 rounded-bl-md">
                <div className="flex items-center space-x-1">
                  <span className="w-1.5 h-1.5 bg-zinc-400 rounded-full animate-bounce" style={{ animationDelay: "0ms" }} />
                  <span className="w-1.5 h-1.5 bg-zinc-400 rounded-full animate-bounce" style={{ animationDelay: "150ms" }} />
                  <span className="w-1.5 h-1.5 bg-zinc-400 rounded-full animate-bounce" style={{ animationDelay: "300ms" }} />
                </div>
                {dispatchInfo && (
                  <span className="block text-xs opacity-50 mt-1">
                    {dispatchInfo.engine === "claude" ? "Claude" : "Gemini"} 思考中...
                  </span>
                )}
              </div>
            </div>
          )}

          {/* 思考过程（可折叠） */}
          {thinkingContent && sending && (
            <div className="flex justify-start">
              <div className="max-w-[75%] w-full">
                <button
                  onClick={() => setThinkingExpanded((v) => !v)}
                  className="flex items-center gap-1.5 text-xs text-zinc-500 hover:text-zinc-400 mb-1 transition"
                >
                  <span>💭 思考过程</span>
                  <svg className={`w-3 h-3 transition-transform ${thinkingExpanded ? "rotate-180" : ""}`} fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" /></svg>
                </button>
                {thinkingExpanded && (
                  <div className="bg-zinc-900 border border-zinc-700 rounded-lg px-3 py-2 mb-2">
                    <pre className="whitespace-pre-wrap text-xs text-zinc-500 italic leading-relaxed max-h-60 overflow-y-auto">
                      {thinkingContent}
                    </pre>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* 工具调用标签 */}
          {toolUses.length > 0 && sending && (
            <div className="flex justify-start">
              <div className="flex flex-wrap gap-1.5 mb-1">
                {toolUses.map((name, i) => (
                  <span key={i} className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded bg-zinc-800 border border-zinc-700 text-zinc-400">
                    🔧 {name}
                  </span>
                ))}
              </div>
            </div>
          )}

          {/* 流式输出气泡 */}
          {(isStreaming || streamingContent) && sending && (
            <div className="flex justify-start">
              <div className="max-w-[75%] rounded-2xl px-4 py-3 text-sm bg-zinc-800 text-zinc-200 rounded-bl-md">
                <Markdown className="leading-relaxed">{streamingContent}</Markdown>
                {isStreaming && <span className="inline-block w-1.5 h-4 bg-blue-400 animate-pulse ml-0.5 align-text-bottom" />}
                {dispatchInfo && (
                  <span className="block text-xs opacity-50 mt-1">
                    {dispatchInfo.engine === "claude" ? "Claude" : "Gemini"}
                  </span>
                )}
              </div>
            </div>
          )}

          {/* 登录提示 */}
          {loginPrompt && (
            <div className="mx-auto max-w-lg p-4 bg-amber-500/10 border border-amber-500/30 rounded-lg">
              <p className="text-sm font-medium text-amber-400">{loginPrompt.engine} 需要登录</p>
              <p className="text-xs text-amber-400/70 mt-1">
                请在终端运行 <code className="bg-amber-500/20 px-1.5 py-0.5 rounded">{loginPrompt.cmd}</code> 完成认证后重试
              </p>
              <button onClick={() => setLoginPrompt(null)} className="text-xs text-amber-500/50 mt-2 hover:text-amber-400">关闭</button>
            </div>
          )}

          <div ref={endRef} />
        </div>

        {/* 输入栏 */}
        <div className="p-4 border-t border-zinc-800">
          <div className="relative">
            {/* Skill 选择菜单 */}
            {showSkillMenu && filteredSkills.length > 0 && (
              <div
                ref={skillMenuRef}
                className="absolute bottom-full left-0 right-0 mb-2 bg-zinc-800 border border-zinc-700 rounded-lg shadow-xl overflow-hidden z-10 max-h-60 overflow-y-auto"
              >
                {filteredSkills.map((skill, i) => (
                  <div
                    key={(skill._isWorkflow ? "wf:" : "") + skill.id}
                    onClick={() => selectSkill(skill)}
                    className={`flex items-center justify-between px-3 py-2 cursor-pointer transition ${
                      i === skillMenuIndex ? "bg-zinc-700" : "hover:bg-zinc-700/50"
                    }`}
                  >
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-mono text-zinc-300">/{skill.id}</span>
                      {skill._isWorkflow && (
                        <span className="text-xs px-1 py-0 rounded bg-violet-500/15 text-violet-400">工作流</span>
                      )}
                    </div>
                    <span className="text-xs text-zinc-500 ml-3 truncate">{skill.description || skill.name}</span>
                  </div>
                ))}
              </div>
            )}

            <div className="bg-zinc-800/50 rounded-xl border border-zinc-700 focus-within:border-zinc-500 transition">
              {/* 附件栏 */}
              {attachments.length > 0 && (
                <div className="flex flex-wrap gap-2 px-3 pt-3">
                  {attachments.map((att) => (
                    <div
                      key={att.id}
                      className="flex items-center gap-1.5 bg-zinc-700/50 rounded-lg px-2.5 py-1.5 text-xs group"
                    >
                      <span>{att.isDir ? "📁" : att.isImage ? "🖼" : "📄"}</span>
                      <span className="text-zinc-300 max-w-[120px] truncate" title={att.path}>
                        {att.name}
                      </span>
                      <button
                        onClick={() => removeAttachment(att.id)}
                        className="text-zinc-500 hover:text-red-400 transition ml-0.5"
                      >
                        <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
                      </button>
                    </div>
                  ))}
                </div>
              )}

              <div className="flex items-end">
                <textarea
                  ref={inputRef}
                  value={input}
                  onChange={handleInputChange}
                  onKeyDown={handleKey}
                  onPaste={handlePaste}
                  placeholder="输入消息... (/ 选择Skill, Ctrl+V 粘贴文件路径)"
                  rows={2}
                  className="flex-1 bg-transparent px-4 py-3 text-sm text-zinc-200 placeholder-zinc-500 resize-none outline-none"
                  disabled={sending}
                />
                {sending && activeTaskId ? (
                  <button
                    onClick={stopTask}
                    title="停止当前任务"
                    className="px-4 py-3 text-red-400 hover:text-red-300 hover:bg-red-500/10 transition flex items-center gap-1.5"
                  >
                    <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24"><rect x="6" y="6" width="12" height="12" rx="2" /></svg>
                    <span className="text-xs">停止</span>
                  </button>
                ) : (
                  <button
                    onClick={send}
                    disabled={sending || (!input.trim() && attachments.length === 0)}
                    className="px-4 py-3 text-zinc-400 hover:text-white disabled:opacity-30 transition"
                  >
                    <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24"><path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z" /></svg>
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* 右侧日志面板 */}
      {showLogs && (
        <div className="w-80 border-l border-zinc-800 flex flex-col shrink-0">
          <div className="h-12 border-b border-zinc-800 flex items-center justify-between px-3">
            <span className="text-xs text-zinc-400">任务日志</span>
            {activeTaskId && <span className="text-xs text-zinc-600 font-mono">{activeTaskId.slice(0, 8)}</span>}
          </div>
          <div className="flex-1 overflow-y-auto p-3 font-mono text-xs space-y-0.5">
            {taskLogs.length === 0 ? (
              <p className="text-zinc-600">等待任务...</p>
            ) : (
              taskLogs.map((l, i) => (
                <div key={i} className="leading-relaxed">
                  <span className="text-zinc-600">{l.timestamp?.split(" ")[1] || ""} </span>
                  <span className={
                    l.level === "error" ? "text-red-400" :
                    l.level === "warn" ? "text-amber-400" :
                    l.level === "debug" ? "text-zinc-600" : "text-blue-400"
                  }>[{l.level}] </span>
                  <span className="text-zinc-400">{l.message}</span>
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function parseInspectTag(content) {
  const match = content.match(/<!-- INSPECT:(.*?) -->/);
  if (!match) return { text: content, inspect: null };
  try {
    const inspect = JSON.parse(match[1]);
    const text = content.replace(/\n*<!-- INSPECT:.*? -->/, "").trimEnd();
    return { text, inspect };
  } catch {
    return { text: content, inspect: null };
  }
}

function InspectCard({ inspect }) {
  const [expanded, setExpanded] = React.useState(false);
  const passed = inspect.verdict === "pass";

  return (
    <div
      className={`mt-3 rounded-lg border px-3 py-2 cursor-pointer transition ${
        passed
          ? "bg-green-500/10 border-green-500/30"
          : "bg-red-500/10 border-red-500/30"
      }`}
      onClick={() => setExpanded(!expanded)}
    >
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="text-sm">{passed ? "\u2705" : "\u274C"}</span>
          <span className={`text-xs font-medium ${passed ? "text-green-400" : "text-red-400"}`}>
            监察审查: {passed ? "通过" : "未通过"}
            {inspect.retried && <span className="text-zinc-500 ml-1">(经重试{passed ? "修正" : "仍未通过"})</span>}
          </span>
        </div>
        <svg className={`w-3 h-3 text-zinc-500 transition-transform ${expanded ? "rotate-180" : ""}`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </div>
      {expanded && (
        <div className="mt-2 text-xs space-y-1">
          {inspect.reason && <p className="text-zinc-400"><span className="text-zinc-500">原因:</span> {inspect.reason}</p>}
          {inspect.suggestions && <p className="text-zinc-400"><span className="text-zinc-500">建议:</span> {inspect.suggestions}</p>}
        </div>
      )}
    </div>
  );
}

function MessageBubble({ msg }) {
  const isUser = msg.role === "user";
  const isSystem = msg.role === "system";

  if (isSystem) {
    return <div className="text-center text-xs text-zinc-500 py-1">{msg.content}</div>;
  }

  const { text, inspect } = isUser ? { text: msg.content, inspect: null } : parseInspectTag(msg.content || "");

  return (
    <div className={`flex ${isUser ? "justify-end" : "justify-start"}`}>
      <div className={`max-w-[75%] rounded-2xl px-4 py-3 text-sm ${
        isUser
          ? "bg-blue-600 text-white rounded-br-md"
          : "bg-zinc-800 text-zinc-200 rounded-bl-md"
      }`}>
        {isUser ? (
          <p className="whitespace-pre-wrap">{text}</p>
        ) : (
          <Markdown className="leading-relaxed">{text}</Markdown>
        )}
        {inspect && <InspectCard inspect={inspect} />}
        {!isUser && msg.transcript && <Transcript transcript={msg.transcript} />}
        {(msg.engine || msg.duration) && (
          <span className="flex items-center gap-2 text-xs opacity-50 mt-1 flex-wrap">
            {msg.engine && <span>{msg.engine}</span>}
            {msg.subtaskCount > 1 && <span>{msg.subtaskCount} 个子任务</span>}
            {msg.duration > 0 && <span>{formatDuration(msg.duration)}</span>}
          </span>
        )}
      </div>
    </div>
  );
}

function EditableTitle({ sessionId, title, onSaved }) {
  const [editing, setEditing] = React.useState(false);
  const [draft, setDraft] = React.useState(title);
  const inputRef = React.useRef(null);

  React.useEffect(() => {
    if (!editing) setDraft(title);
  }, [title, editing]);

  React.useEffect(() => {
    if (editing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [editing]);

  if (!sessionId) {
    return <span className="text-sm font-medium text-zinc-300">{title}</span>;
  }

  async function save() {
    const newTitle = draft.trim();
    if (!newTitle || newTitle === title) {
      setEditing(false);
      setDraft(title);
      return;
    }
    try {
      const resp = await authenticatedFetch(getApiUrl(`/api/chat/sessions/${sessionId}`), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: newTitle }),
      });
      const d = await resp.json();
      if (d.success) {
        onSaved?.(d.data.title);
      }
    } catch {}
    setEditing(false);
  }

  if (editing) {
    return (
      <input
        ref={inputRef}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={save}
        onKeyDown={(e) => {
          if (e.key === "Enter") save();
          else if (e.key === "Escape") { setEditing(false); setDraft(title); }
        }}
        className="text-sm font-medium text-zinc-100 bg-zinc-800 border border-zinc-700 rounded px-2 py-0.5 outline-none focus:border-zinc-500 min-w-[200px]"
      />
    );
  }

  return (
    <button
      onClick={() => setEditing(true)}
      title="点击编辑标题"
      className="text-sm font-medium text-zinc-300 hover:text-zinc-100 transition cursor-text px-2 py-0.5 rounded hover:bg-zinc-800"
    >
      {title}
    </button>
  );
}

function formatDuration(ms) {
  if (!ms || ms <= 0) return "";
  const sec = Math.round(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  const remainSec = sec % 60;
  if (min < 60) return remainSec > 0 ? `${min}m${remainSec}s` : `${min}m`;
  const hr = Math.floor(min / 60);
  const remainMin = min % 60;
  return `${hr}h${remainMin}m`;
}

function formatTime(dateStr) {
  if (!dateStr) return "";
  try {
    const d = new Date(dateStr);
    const now = new Date();
    const isToday = d.toDateString() === now.toDateString();
    if (isToday) {
      return d.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
    }
    return d.toLocaleDateString("zh-CN", { month: "numeric", day: "numeric" });
  } catch {
    return dateStr;
  }
}
