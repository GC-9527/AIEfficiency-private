export function preserveStoppedLive(liveMap, sessionId, endedAt = Date.now()) {
  if (!sessionId || !liveMap || typeof liveMap !== "object") return liveMap;
  const current = liveMap[sessionId];
  if (!current) return liveMap;
  const startedAt = Number(current.startedAt || endedAt);
  return {
    ...liveMap,
    [sessionId]: {
      ...current,
      streaming: false,
      stopped: true,
      endedAt,
      durationMs: Math.max(0, endedAt - startedAt),
      updatedAt: endedAt,
    },
  };
}

/**
 * 故事点是否处于「运行中」状态，决定 EngineSwitchButton / 发送按钮是否 disabled。
 *
 * 双重豁免（CARB-14755 修复）：
 *
 * 1. `live.stopped === true` — 「已停止」强信号。
 *    来源：`preserveStoppedLive` 仅由 `onStop` 路径调用，且 `onStop` 同步清理
 *    `runningTabs`，所以**正常路径下**该强信号与 `runningTabs 残留` 不会同时为真。
 *    本豁免的真实价值是作为「stopped 标记与 runningTabs 写入顺序错乱」时的安全网
 *    （例如未来重构新增 `stopped: true` 写入而忘了清 `runningTabs`），属于防御性兜底。
 *
 * 2. `live.streaming === false && now - endedAt > ENDED_GRACE_MS` — 兜底窗口。
 *    真实触发场景：服务端 `chat_stream_end` WS 事件丢失，但 `live.endedAt` 已被
 *    前序事件或服务端 GET /conversation 写入。该兜底是 EngineSwitchButton 真正
 *    依赖的「主动态收敛」机制，禁止删除。
 *
 * 不得原地修改入参（React state 不可变）。
 *
 * @param {object} args
 * @param {Set}    args.runningTabs     故事点运行态集合（tabId 维度）
 * @param {object} args.liveMap         浏览器流式草稿（sessionId 维度）
 * @param {string} args.tabId           当前 tab id
 * @param {string} args.sessionId       当前会话 id
 * @param {number} [args.now=Date.now()] 当前时间戳，用于 endedAt 兜底比较
 * @param {number} [args.ENDED_GRACE_MS=3000] endedAt 兜底窗口（毫秒）
 * @returns {boolean}
 */
export function isTabRunning({
  runningTabs,
  liveMap,
  tabId,
  sessionId,
  now = Date.now(),
  ENDED_GRACE_MS = 3000,
} = {}) {
  const tabs = runningTabs instanceof Set ? runningTabs : new Set();
  const lives = liveMap && typeof liveMap === "object" ? liveMap : {};
  const live = sessionId ? lives[sessionId] : null;
  if (live) {
    if (live.stopped === true) return false;
    if (live.streaming === false && live.endedAt && now - Number(live.endedAt) > ENDED_GRACE_MS) return false;
  }
  if (tabId && tabs.has(tabId)) return true;
  return !!(live && live.streaming === true);
}

/**
 * 用 GET /conversation 的权威快照收敛浏览器 liveMap。服务端明确已空闲时删除
 * 丢失终态 WS 事件留下的流式草稿；旧 Gateway 没有 runtime 字段时保持现状。
 */
export function reconcileConversationLiveMap(liveMap, sessionId, serverLive, runtimeActive) {
  if (!liveMap || typeof liveMap !== "object" || !sessionId) return liveMap;
  if (!serverLive) {
    if (runtimeActive !== false || !Object.prototype.hasOwnProperty.call(liveMap, sessionId)) return liveMap;
    const next = { ...liveMap };
    delete next[sessionId];
    return next;
  }

  const current = liveMap[sessionId];
  if (current && (current.updatedAt || 0) > (serverLive.updatedAt || 0)) return liveMap;
  return {
    ...liveMap,
    [sessionId]: {
      ...serverLive,
      status: serverLive.status || "",
      thinking: serverLive.thinking || "",
      text: serverLive.text || "",
      tools: Array.isArray(serverLive.tools) ? serverLive.tools : [],
      commLogs: Array.isArray(serverLive.commLogs) ? serverLive.commLogs : [],
      center: serverLive.center || null,
    },
  };
}

/** 兼容尚未返回 runtime 的旧 Gateway：存在 streaming 草稿时仍可确认运行中，但不能据空值判停。 */
export function conversationRuntimeActive(runtimeActive, serverLive) {
  if (typeof runtimeActive === "boolean") return runtimeActive;
  return serverLive?.streaming === true ? true : null;
}

/**
 * 用服务端运行态收敛 React 本地集合。WebSocket 最终事件可能丢失，不能让一次
 * 乐观的 running 标记永久把发送按钮留在“实时追加”。null 表示服务端未给结论。
 */
export function reconcileRunningTabIds(runningTabIds, tabId, runtimeActive) {
  if (!(runningTabIds instanceof Set) || !tabId || typeof runtimeActive !== "boolean") return runningTabIds;
  const alreadyMatches = runtimeActive ? runningTabIds.has(tabId) : !runningTabIds.has(tabId);
  if (alreadyMatches) return runningTabIds;
  const next = new Set(runningTabIds);
  if (runtimeActive) next.add(tabId);
  else next.delete(tabId);
  return next;
}
