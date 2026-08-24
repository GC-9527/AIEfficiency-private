// 单附件下载进度缓存（模块级）。
// 与 useTabAttachments.js 同模式（Map<tabId, ...>），但独立职责：进度由 WS
// devbench_attach_progress 推送，弹窗关闭/重挂载都不丢。
//
// 结构：
//   progressByTab: Map<tabId, Map<attachmentKey, ProgressEntry>>
//   listenersByTab: Map<tabId, Set<fn>>
//
// ProgressEntry 形态：
//   {
//     received: number,
//     total: number,
//     status: "idle" | "downloading" | "done" | "stopped" | "error",
//     name: string,
//     relPath?: string,
//     error?: string,
//     updatedAt: number,
//   }
//
// 进程入口：
//   applyAttachProgressEvent(payload)  — 处理一条 WS 事件
//   subscribeAttachProgress(tabId, fn) — 订阅（returns unsubscribe）
//   readAttachProgress(tabId, key)     — 读取一条记录
//   __resetAttachProgressForTests()    — 仅测试用

const progressByTab = new Map();
const listenersByTab = new Map();

function notify(tabId) {
  const set = listenersByTab.get(tabId);
  if (!set) return;
  for (const fn of set) {
    try { fn(); } catch {}
  }
}

function getInner(tabId) {
  let m = progressByTab.get(tabId);
  if (!m) {
    m = new Map();
    progressByTab.set(tabId, m);
  }
  return m;
}

export function applyAttachProgressEvent(payload) {
  if (!payload || !payload.tabId || !payload.attachmentKey) return;
  const inner = getInner(payload.tabId);
  const prev = inner.get(payload.attachmentKey) || {
    received: 0,
    total: 0,
    status: "idle",
    name: payload.name || "",
    updatedAt: Date.now(),
  };
  const next = {
    ...prev,
    name: payload.name || prev.name,
    updatedAt: Date.now(),
  };
  if (payload.phase === "file") {
    if (payload.status) next.status = payload.status;
    if (payload.received != null) next.received = payload.received;
    if (payload.total != null) next.total = payload.total;
    if (payload.relPath) next.relPath = payload.relPath;
    if (payload.error) next.error = payload.error;
  } else if (payload.phase === "progress") {
    if (payload.received != null) next.received = payload.received;
    if (payload.total != null) next.total = payload.total;
    if (next.status === "idle") next.status = "downloading";
  } else if (payload.phase === "end") {
    // end 仅做收尾触发刷新；终态已由 file 写过（done/stopped/error）。
    // 不强行覆写 status —— stop 后用户重新点"下载"会重新发 phase:"file" downloading。
  }
  inner.set(payload.attachmentKey, next);
  notify(payload.tabId);
}

export function subscribeAttachProgress(tabId, listener) {
  if (!tabId) return () => {};
  let set = listenersByTab.get(tabId);
  if (!set) {
    set = new Set();
    listenersByTab.set(tabId, set);
  }
  set.add(listener);
  return () => {
    set.delete(listener);
    if (!set.size) listenersByTab.delete(tabId);
  };
}

export function readAttachProgress(tabId, attachmentKey) {
  if (!tabId || !attachmentKey) return null;
  return progressByTab.get(tabId)?.get(attachmentKey) || null;
}

export function __resetAttachProgressForTests() {
  progressByTab.clear();
  listenersByTab.clear();
}