import { addLog } from "../db/sqlite.js";

// WebSocket客户端列表（由server.js注入）
let wsClients = new Set();
let wsAuthInvalidationHandler = null;
const backpressuredClients = new WeakSet();

// 单个连接的待发送数据超过此上限时主动断开，让前端重连并从持久化草稿恢复。
// ws 不会替应用限制 bufferedAmount；若消费者卡住，持续流式输出会让发送队列无限占堆。
export const WS_BACKPRESSURE_LIMIT_BYTES = 4 * 1024 * 1024;

export function setWsClients(clients) {
  wsClients = clients;
}

export function setWsAuthInvalidationHandler(handler) {
  wsAuthInvalidationHandler = typeof handler === "function" ? handler : null;
}

// 单客户端发送：任何异常【只跳过该客户端并记日志，不吞掉、不影响其它客户端、不向上抛】。
// 历史教训：曾把对象（未 stringify）传进来，client.send 同步抛 TypeError，被调用方的空 catch{} 吞掉 →
// WS 消息静默丢失、还会中断对后续客户端的广播。这里在最底层把错误“显形”出来。
function messageByteLength(wsMessage) {
  if (typeof wsMessage === "string") return Buffer.byteLength(wsMessage);
  if (Buffer.isBuffer(wsMessage)) return wsMessage.byteLength;
  return 0;
}

function terminateBackpressuredClient(client, bufferedBytes, nextBytes) {
  wsClients.delete(client);
  if (!backpressuredClients.has(client)) {
    backpressuredClients.add(client);
    console.warn(
      `[ws] 客户端发送积压 ${bufferedBytes}B，下一条 ${nextBytes}B，超过 ${WS_BACKPRESSURE_LIMIT_BYTES}B 上限，已断开等待重连`
    );
  }
  try {
    if (typeof client.terminate === "function") client.terminate();
    else if (typeof client.close === "function") client.close(1013, "backpressure");
  } catch (e) {
    console.error(`[ws] 断开积压客户端失败: ${e?.message || e}`);
  }
}

function sendSafe(client, wsMessage) {
  try {
    const rawBufferedAmount = Number(client?.bufferedAmount);
    const bufferedBytes = Number.isFinite(rawBufferedAmount) && rawBufferedAmount > 0 ? rawBufferedAmount : 0;
    const nextBytes = messageByteLength(wsMessage);
    if (bufferedBytes + nextBytes > WS_BACKPRESSURE_LIMIT_BYTES) {
      terminateBackpressuredClient(client, bufferedBytes, nextBytes);
      return;
    }
    client.send(wsMessage);
  } catch (e) {
    console.error(`[ws] 推送失败（已跳过该客户端，不影响其它）: ${e?.message || e}`);
  }
}

/**
 * 仅发送给订阅了指定 session 的客户端
 * 无订阅的客户端视为 legacy，全量接收
 */
function broadcastToSession(sessionId, wsMessage) {
  for (const client of wsClients) {
    if (client.readyState !== 1) continue;
    if (!sessionId || client.subscribedSessions.size === 0 || client.subscribedSessions.has(sessionId)) {
      sendSafe(client, wsMessage);
    }
  }
}

/**
 * 全局广播（所有客户端）
 */
export function broadcastAll(wsMessage) {
  for (const client of wsClients) {
    if (client.readyState === 1) sendSafe(client, wsMessage);
  }
}

/**
 * 性能资源控制/实时数据只发送给 server.js 已判定为本机可信的普通 WS。
 * 其它全局日志、任务与状态事件继续走 broadcastAll，不改变 LAN 面板行为。
 */
export function broadcastPerformanceResource(wsMessage) {
  for (const client of wsClients) {
    if (client.readyState === 1 && client.performanceResourceTrusted === true) {
      sendSafe(client, wsMessage);
    }
  }
}

/**
 * 统一 WS 事件出口（收口）：强制 JSON.stringify + { type, data } 信封。
 * 前端一律按 `const d = msg.data` 解析，故所有事件都必须包一层 data —— 这正是过去手搓 envelope
 * （传对象 / 漏 data 包裹）导致 WS 到不了前端的根因。一切新事件都走这个函数，别再手搓。
 * @param {string} type  事件类型
 * @param {object} data  负载（会被放进 envelope 的 data 字段）
 * @param {object} [opts] { sessionId } 给定则只发订阅该会话的客户端，否则全局广播
 */
export function emitWs(type, data = {}, opts = {}) {
  let wsMessage;
  try {
    wsMessage = JSON.stringify({ type, data });
  } catch (e) {
    // 序列化失败（如循环引用）：记日志而非静默吞掉
    console.error(`[ws] emitWs 序列化失败 type=${type}: ${e?.message || e}`);
    return;
  }
  if (opts.sessionId) broadcastToSession(opts.sessionId, wsMessage);
  else broadcastAll(wsMessage);
  if (type === "admin_authz_invalidated" && wsAuthInvalidationHandler) {
    try { wsAuthInvalidationHandler(data); }
    catch (e) { console.error(`[ws] 管理员撤权连接清理失败: ${e?.message || e}`); }
  }
}

export function emitPerformanceResourceWs(type, data = {}) {
  let wsMessage;
  try {
    wsMessage = JSON.stringify({ type, data });
  } catch (e) {
    console.error(`[ws] 性能资源事件序列化失败 type=${type}: ${e?.message || e}`);
    return;
  }
  broadcastPerformanceResource(wsMessage);
}

/**
 * 统一日志记录器
 * 同时写入数据库和通过WebSocket推送
 */
export function log(taskId, level, module, message) {
  const timestamp = new Date().toLocaleString("zh-CN");
  const logLine = `[${timestamp}] [${module}] [${level.toUpperCase()}] ${message}`;

  // 控制台输出
  if (level === "error") {
    console.error(logLine);
  } else {
    console.log(logLine);
  }

  // 写入数据库
  try {
    addLog(taskId, level, module, message);
  } catch {
    // 数据库写入失败不阻塞
  }

  // WebSocket推送（全局，日志页面需要看所有任务）
  broadcastAll(JSON.stringify({
    type: "log",
    data: { taskId, level, module, message, timestamp },
  }));
}

/**
 * 推送Agent状态更新（全局）
 */
export function broadcastAgentStatus(agent) {
  broadcastAll(JSON.stringify({ type: "agent_status", data: agent }));
}

/**
 * 推送任务状态更新（全局）
 */
export function broadcastTaskUpdate(task) {
  broadcastAll(JSON.stringify({ type: "task_update", data: task }));
}

/**
 * 推送聊天消息（会话过滤）
 */
export function broadcastChatMessage(msg) {
  const sessionId = msg.session_id || null;
  broadcastToSession(sessionId, JSON.stringify({ type: "chat_message", data: msg }));
}

/**
 * 推送登录要求事件（全局）
 */
export function broadcastLoginRequired(data) {
  broadcastAll(JSON.stringify({ type: "login_required", data }));
}

/**
 * 推送任务分类/调度结果（会话过滤）
 */
export function broadcastTaskDispatched(data) {
  const sessionId = data.sessionId || null;
  broadcastToSession(sessionId, JSON.stringify({ type: "task_dispatched", data }));
}

/**
 * 推送流式输出片段（会话过滤）
 */
export function broadcastChatStream(data) {
  const sessionId = data.sessionId || null;
  broadcastToSession(sessionId, JSON.stringify({ type: "chat_stream", data }));
}

/**
 * 推送流式输出结束信号（会话过滤）
 */
export function broadcastChatStreamEnd(data) {
  const sessionId = data.sessionId || null;
  broadcastToSession(sessionId, JSON.stringify({ type: "chat_stream_end", data }));
}

/**
 * 推送任务拆分结构（会话过滤）
 */
export function broadcastDecomposition(parentTaskId, sessionId, decomposition) {
  broadcastToSession(sessionId, JSON.stringify({
    type: "task_decomposition",
    data: { parentTaskId, sessionId, decomposition },
  }));
}

/**
 * 推送子任务状态更新（会话过滤）
 */
export function broadcastSubtaskUpdate(parentTaskId, sessionId, subtaskId, status, childTaskId, extra = {}) {
  broadcastToSession(sessionId, JSON.stringify({
    type: "subtask_update",
    data: { parentTaskId, sessionId, subtaskId, status, childTaskId, ...extra },
  }));
}

/**
 * 推送引擎安装进度（全局）
 */
export function broadcastInstallProgress(data) {
  broadcastAll(JSON.stringify({ type: "install_progress", data }));
}

/**
 * 推送 Skill 列表变更通知（全局）
 */
export function broadcastSkillsChanged() {
  broadcastAll(JSON.stringify({ type: "skills_changed" }));
}

/**
 * 推送工作流运行状态更新（会话过滤）
 */
export function broadcastWorkflowUpdate(runId, sessionId, data) {
  broadcastToSession(sessionId, JSON.stringify({ type: "workflow_update", data: { runId, sessionId, ...data } }));
}

/**
 * 推送项目开发编排事件（全局）
 * data 形如 { projectId, runId, evt }
 */
export function broadcastProjectDev(data) {
  broadcastAll(JSON.stringify({ type: "projectdev_event", data }));
}
