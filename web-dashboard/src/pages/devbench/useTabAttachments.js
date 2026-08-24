import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { devbenchApi } from "./api.js";

// 防止每次打开/关闭"附件较多/较大"或"TB 单附件"弹窗就重新拉一次。
// 用 module 级 Map 做去重缓存：同一 tab 的附件只向后端拉一次，
// 后续打开弹窗复用上次结果；主动调 refresh 才重拉。
// 切换故事点不丢缓存（按 tabId 各自持有）。
const tabAttachmentsCache = new Map(); // tabId → { list, err, loadedAt }
const tabAttachmentsInflight = new Map(); // tabId → Promise
const tabAttachmentsListeners = new Map(); // tabId → Set<fn>

function notify(tabId) {
  const set = tabAttachmentsListeners.get(tabId);
  if (!set) return;
  for (const fn of set) {
    try { fn(); } catch {}
  }
}

function subscribe(tabId, listener) {
  if (!tabId) return () => {};
  let set = tabAttachmentsListeners.get(tabId);
  if (!set) {
    set = new Set();
    tabAttachmentsListeners.set(tabId, set);
  }
  set.add(listener);
  return () => {
    set.delete(listener);
    if (!set.size) tabAttachmentsListeners.delete(tabId);
  };
}

function readCache(tabId) {
  return tabAttachmentsCache.get(tabId) || null;
}

function writeCache(tabId, value) {
  tabAttachmentsCache.set(tabId, value);
  notify(tabId);
}

async function loadTabAttachmentsOnce(tabId) {
  const existing = tabAttachmentsInflight.get(tabId);
  if (existing) return existing;
  const promise = (async () => {
    try {
      const r = await devbenchApi.listTbAttachments(tabId);
      const list = r?.ok && Array.isArray(r.data?.attachments) ? r.data.attachments : [];
      const archiveDir = r?.ok && r.data?.archiveDir ? r.data.archiveDir : "";
      const err = r?.ok ? "" : (r?.error || "获取附件失败");
      writeCache(tabId, { list, archiveDir, err, loadedAt: Date.now() });
      return { list, archiveDir, err };
    } finally {
      tabAttachmentsInflight.delete(tabId);
    }
  })();
  tabAttachmentsInflight.set(tabId, promise);
  return promise;
}

// 仅读取"TB 单附件"弹窗 / 行内列表所需的最小共享状态。
// 返回的 refresh 永远强制重新拉取一次（用于"刷新附件"按钮）。
// 该 hook 在同一 tabId 上多次挂载（popup 打开/关闭、reloadTabs 后）共用同一份缓存，
// 不再触发额外请求。
export default function useTabAttachments(tabId, ticketUrl) {
  const isTb = useMemo(
    () => /task\/[0-9a-fA-F]{24}/.test(String(ticketUrl || "")),
    [ticketUrl],
  );
  const lastSeenTabIdRef = useRef("");
  const [version, setVersion] = useState(0);
  const refresh = useCallback(() => {
    if (!tabId || !isTb) return Promise.resolve({ list: [], err: "" });
    return loadTabAttachmentsOnce(tabId);
  }, [tabId, isTb]);
  useEffect(() => {
    if (!tabId || !isTb) {
      lastSeenTabIdRef.current = "";
      return undefined;
    }
    lastSeenTabIdRef.current = tabId;
    const unsubscribe = subscribe(tabId, () => setVersion((v) => v + 1));
    if (!readCache(tabId)) {
      // 首次进入该故事点 / 首次打开弹窗时拉一次；多次挂载共享同一 in-flight 承诺。
      loadTabAttachmentsOnce(tabId);
    } else {
      // 已有缓存，强制一次 re-render 让本实例读到最新值
      setVersion((v) => v + 1);
    }
    const onInvalidated = (event) => {
      const target = event?.detail?.tabId;
      if (target && target === tabId) {
        loadTabAttachmentsOnce(tabId);
      }
    };
    if (typeof window !== "undefined") {
      window.addEventListener("devbench:tb-attachments-invalidated", onInvalidated);
    }
    return () => {
      unsubscribe();
      if (typeof window !== "undefined") {
        window.removeEventListener("devbench:tb-attachments-invalidated", onInvalidated);
      }
    };
  }, [tabId, isTb]);
  const cached = tabId ? readCache(tabId) : null;
  return {
    isTb,
    list: cached?.list || [],
    archiveDir: (cached && cached.archiveDir) || "",
    err: cached?.err || "",
    loaded: !!cached,
    refresh,
    version,
  };
}

// 在测试或脚本里也能清缓存（不在 UI 暴露）
export function __resetTabAttachmentsCacheForTests() {
  tabAttachmentsCache.clear();
  tabAttachmentsInflight.clear();
  tabAttachmentsListeners.clear();
}
