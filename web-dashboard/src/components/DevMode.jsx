import React, { useEffect, useRef, useState, useCallback } from "react";
import { createPortal } from "react-dom";
import { createGatewayWebSocket, getApiUrl } from "../services/gateway.js";
import { getAdminToken, useIsAdmin } from "../services/adminAuth.js";
import { useDockSlot } from "./FloatingDock.jsx";

// 管理员「在此开发」模式：所有页面悬浮按钮 → 选中页面元素 → 覆盖式编辑悬浮窗与 AI 多轮对话改本地源码。
// 会话(对话/选中元素/本地路径/分支/开合)持久化到 localStorage，AI 改码触发整页刷新/重新部署后自动恢复，不丢。
const LS_KEY = "devmode_session";
const LS_LIST = "devmode_sessions"; // 已归档的历史会话列表（新开会话时把旧对话存这里，可切回）
const authHeaders = () => { const t = getAdminToken(); return t ? { Authorization: `Bearer ${t}` } : {}; };
const genId = () => `s_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
const loadList = () => { try { return JSON.parse(localStorage.getItem(LS_LIST)) || []; } catch { return []; } };
const saveList = (l) => { try { localStorage.setItem(LS_LIST, JSON.stringify(l)); } catch {} };
const BASE_ENGINES = [
  { id: "claude", name: "Claude", short: "Cl" },
  { id: "codex", name: "Codex", short: "Cx" },
  { id: "gemini", name: "Gemini", short: "Gm" },
  { id: "hermes", name: "Hermes", short: "Hm" },
];
function shortEngine(id, name) {
  const s = String(id || name || "AI").replace(/[^a-z0-9]/gi, "");
  return (s.slice(0, 2) || "AI").toUpperCase();
}
function engineDisplayName(id, fallback) {
  if (id === "claude") return "Claude";
  if (id === "codex") return "Codex";
  if (id === "gemini") return "Gemini";
  if (id === "hermes") return "Hermes";
  return fallback || id || "AI";
}
function buildEngineOptions(status, cur) {
  const byId = new Map(BASE_ENGINES.map((e) => [e.id, e]));
  if (status) {
    Object.entries(status).forEach(([id, st]) => {
      if (byId.has(id)) return;
      if (st?.type === "api") byId.set(id, { id, name: st.name || id, short: shortEngine(id, st.name), api: true });
    });
  }
  if (cur && !byId.has(cur)) byId.set(cur, { id: cur, name: cur, short: shortEngine(cur), api: true });
  return [...byId.values()];
}
// 会话标题：取首条用户消息，否则用选区/路由兜底
const sessTitle = (s) => {
  const firstUser = (s?.messages || []).find((m) => m.role === "user");
  if (firstUser?.text) return firstUser.text.trim().slice(0, 40);
  const els = s?.elements?.length || (s?.element ? 1 : 0);
  return els ? `${els} 个选区的会话` : "空会话";
};

// 生成元素的稳定 CSS 选择器（够定位即可）
function cssSelector(el) {
  if (!el || el.nodeType !== 1) return "";
  if (el.id) return `#${el.id}`;
  const parts = [];
  let node = el;
  for (let depth = 0; node && node.nodeType === 1 && depth < 5; depth++) {
    let part = node.tagName.toLowerCase();
    const cls = (node.getAttribute && node.getAttribute("class") || "").trim().split(/\s+/).filter(Boolean).slice(0, 2);
    if (cls.length) part += "." + cls.map((c) => CSS.escape(c)).join(".");
    const parent = node.parentElement;
    if (parent) {
      const sameTag = [...parent.children].filter((c) => c.tagName === node.tagName);
      if (sameTag.length > 1) part += `:nth-of-type(${sameTag.indexOf(node) + 1})`;
    }
    parts.unshift(part);
    if (node.id) { parts[0] = `#${node.id}`; break; }
    node = node.parentElement;
  }
  return parts.join(" > ");
}

// 元素默认简称：以"用户网页上看到的"为优先 —— 可见文本 → 无障碍名(aria-label/title/placeholder/alt/value/name) → 标签名
function defaultAlias(el) {
  if (!el || el.nodeType !== 1) return "";
  const norm = (s) => String(s || "").replace(/\s+/g, " ").trim();
  const text = norm(el.innerText || el.textContent);
  if (text) return text.slice(0, 16);
  for (const a of ["aria-label", "title", "placeholder", "alt", "value", "name"]) {
    const v = el.getAttribute && norm(el.getAttribute(a));
    if (v) return v.slice(0, 16);
  }
  if (el.value && norm(el.value)) return norm(el.value).slice(0, 16);
  return el.tagName ? el.tagName.toLowerCase() : "";
}

export default function DevMode() {
  const slot = useDockSlot(); // 触发按钮挂到常驻悬浮坞
  const { isAdmin } = useIsAdmin();
  const [inspecting, setInspecting] = useState(false);
  const [hoverRect, setHoverRect] = useState(null);
  const [picked, setPicked] = useState([]);   // 选取模式下已选的元素/区域：[{el, kind, selector, tag, text, outerHTML, rect?}]
  const [dragRect, setDragRect] = useState(null); // 拖拽框选时的实时矩形（视口坐标）
  const [running, setRunning] = useState(false);
  const [input, setInput] = useState("");
  const [gitInfo, setGitInfo] = useState(null);
  const [finishing, setFinishing] = useState(false); // 「开发完成」部署面板
  const [deployMsg, setDeployMsg] = useState("");
  const [procInfo, setProcInfo] = useState(null); // 当前进程启动方式 + 手动重启命令
  const [copied, setCopied] = useState(false);
  const [repoOpen, setRepoOpen] = useState(false); // 工程配置/目标分支 展开收起（默认收起）
  const [archived, setArchived] = useState(loadList); // 历史会话列表
  const [showHistory, setShowHistory] = useState(false); // 历史会话下拉
  const [queue, setQueue] = useState([]); // AI 工作中时排队待发的消息（本回合结束自动发，像故事点）
  const [showEngineMenu, setShowEngineMenu] = useState(false);
  const [engineStatus, setEngineStatus] = useState(null);
  const [engineStatusLoading, setEngineStatusLoading] = useState(false);
  const [panelBox, setPanelBox] = useState(() => { try { return JSON.parse(localStorage.getItem("devmode_panel_box")) || null; } catch { return null; } }); // 悬浮窗位置+尺寸（持久化）
  const dragRef = useRef(null); // 拖动/缩放手势状态
  const rootRef = useRef(null);
  const hoverElRef = useRef(null);
  const wsRef = useRef(null);
  const shotRef = useRef(null); // 点「在此开发」时即截图(每次生成)；是否发给 AI 由勾选控制
  const pickedRef = useRef([]); // 选区最新值（事件回调里读，避免闭包陈旧）
  const downRef = useRef(null); // 鼠标按下起点（区分点击 vs 拖拽框选）
  const draggingRef = useRef(false);
  const coordsRef = useRef(null); // 最近一次点击坐标
  const pollRef = useRef(null);   // run-result 轮询兜底（防 WS 漏收 end 导致卡在运行中）
  const doneRef = useRef(false);  // 本轮是否已收尾（WS end 与轮询二选一，幂等）
  useEffect(() => { pickedRef.current = picked; }, [picked]);
  useEffect(() => () => { if (pollRef.current) clearInterval(pollRef.current); }, []);
  const MAX_PICK = 12;
  // 当前会话的选区数组（兼容旧版单选 sess.element）
  const sessElements = (s) => (s?.elements && s.elements.length ? s.elements : (s?.element ? [s.element] : []));
  const liveRect = (el) => { if (!el) return null; const r = el.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }; };

  // 截当前页(排除开发悬浮窗自身)。elements 非空时在图上叠加编号框，让 AI 把「选区①②③」与界面位置对应。
  async function capture(elements) {
    try {
      const html2canvas = (await import("html2canvas")).default;
      const scale = Math.min(1, 1400 / Math.max(window.innerWidth, 1));
      const canvas = await html2canvas(document.body, {
        logging: false, useCORS: true, scale,
        ignoreElements: (el) => (rootRef.current && rootRef.current.contains(el)) || !!(el.closest && el.closest("#floating-dock")),
      });
      if (elements && elements.length) {
        const ctx = canvas.getContext("2d");
        ctx.lineWidth = Math.max(2, Math.round(2 * scale * 2));
        ctx.font = `bold ${Math.max(12, Math.round(13))}px sans-serif`;
        ctx.textBaseline = "top";
        elements.forEach((e, i) => {
          const r = e.rect; if (!r) return;
          const x = (r.x + window.scrollX) * scale, y = (r.y + window.scrollY) * scale, w = r.w * scale, h = r.h * scale;
          ctx.strokeStyle = "#6366f1"; ctx.strokeRect(x, y, w, h);
          const label = `${i + 1}${e.alias ? " " + String(e.alias).slice(0, 12) : ""}`, bh = 16;
          const bw = ctx.measureText(label).width + 8;
          ctx.fillStyle = "#6366f1"; ctx.fillRect(x, Math.max(0, y - bh), bw, bh);
          ctx.fillStyle = "#fff"; ctx.fillText(label, x + 4, Math.max(0, y - bh) + 2);
        });
      }
      return canvas.toDataURL("image/jpeg", elements && elements.length ? 0.78 : 0.7);
    } catch { return null; }
  }
  // 进入选取模式：先截一张干净页面图；把已有选区(若有)解析回 DOM 节点作为初始选区，便于继续增减
  async function startInspect() {
    shotRef.current = await capture(); // 点击在此开发即截图(干净页面)
    const seed = sessElements(sess).map((e) => {
      if (e.kind === "region") return { ...e, el: null };
      let node = null; try { node = e.selector ? document.querySelector(e.selector) : null; } catch {}
      // 保留 alias/选择器/rect 等（即使当前页面定位不到该元素，也不丢弃，避免追加时备注/旧选区消失）
      return { el: node, kind: "element", selector: e.selector, tag: e.tag, text: e.text, outerHTML: e.outerHTML, alias: e.alias, rect: e.rect };
    });
    setPicked(seed);
    setInspecting(true);
  }

  // 会话状态（持久化）
  const [sess, setSess] = useState(() => {
    try { return JSON.parse(localStorage.getItem(LS_KEY)) || null; } catch { return null; }
  });
  const persist = useCallback((next) => { setSess(next); try { next ? localStorage.setItem(LS_KEY, JSON.stringify(next)) : localStorage.removeItem(LS_KEY); } catch {} }, []);
  const currentEngine = sess?.engine || "claude";
  const engineOptions = buildEngineOptions(engineStatus, currentEngine);
  const currentEngineMeta = engineOptions.find((e) => e.id === currentEngine) || BASE_ENGINES[0];
  const currentEngineName = engineDisplayName(currentEngineMeta.id, currentEngineMeta.name);
  const loadEngineStatus = useCallback(() => {
    if (engineStatusLoading) return;
    setEngineStatusLoading(true);
    fetch(getApiUrl("/api/config/engine-status"), { headers: authHeaders() })
      .then((r) => r.json())
      .then((d) => { if (d.success) setEngineStatus(d.data || {}); })
      .catch(() => {})
      .finally(() => setEngineStatusLoading(false));
  }, [engineStatusLoading]);
  function openEngineMenu() {
    if (running) return;
    setShowEngineMenu((v) => !v);
    if (!engineStatus) loadEngineStatus();
  }
  function switchEngine(engine) {
    if (!sess || running || engine === currentEngine) return;
    persist({ ...sess, engine });
    setShowEngineMenu(false);
  }

  // 面板打开且尚未配置本地路径时，自动展开「代码仓库」配置区引导填写
  useEffect(() => { if (sess?.open && !sess?.minimized && !sess?.localPath) setRepoOpen(true); }, [sess?.open, sess?.minimized, sess?.localPath]);
  // 队列驱动：AI 一空闲且有排队消息，自动发下一条（像故事点本回合结束自动接着发）
  useEffect(() => {
    if (running || !queue.length) return;
    const [next, ...rest] = queue;
    setQueue(rest);
    runTurn(next);
  }, [running, queue]); // eslint-disable-line

  // 恢复：若上次有进行中的 run（整页刷新打断），拉回最终结果补全
  useEffect(() => {
    if (!sess?.runId || !isAdmin) return;
    fetch(getApiUrl(`/api/devbench/devmode/run-result?runId=${sess.runId}`), { headers: authHeaders() })
      .then((r) => r.json()).then((d) => {
        if (d.ok && d.data && !d.data.pending) finalizeRun(d.data);
      }).catch(() => {});
  }, [isAdmin]); // eslint-disable-line

  // 读取本地工程 git 信息
  const loadGit = useCallback((root) => {
    if (!root) { setGitInfo(null); return; }
    fetch(getApiUrl(`/api/devbench/devmode/git-info?root=${encodeURIComponent(root)}`), { headers: authHeaders() })
      .then((r) => r.json()).then((d) => { if (d.ok) setGitInfo(d.data); }).catch(() => {});
  }, []);
  useEffect(() => { if (sess?.open && sess.localPath) loadGit(sess.localPath); }, [sess?.open, sess?.localPath, loadGit]);

  // ===== 选取模式：高亮 + 多选（点击元素加/减；拖拽框选区域） =====
  useEffect(() => {
    if (!inspecting) { setHoverRect(null); setDragRect(null); downRef.current = null; draggingRef.current = false; return; }
    const isSelf = (el) => !!(el && ((rootRef.current && rootRef.current.contains(el)) || (el.closest && el.closest("#floating-dock"))));
    const onDown = (e) => {
      if (e.button !== 0) return;
      if (isSelf(document.elementFromPoint(e.clientX, e.clientY))) return; // 点工具条/面板时放行
      downRef.current = { x: e.clientX, y: e.clientY };
      draggingRef.current = false;
      e.preventDefault(); e.stopPropagation();
    };
    const onMove = (e) => {
      if (downRef.current) {
        const dx = e.clientX - downRef.current.x, dy = e.clientY - downRef.current.y;
        if (draggingRef.current || Math.hypot(dx, dy) > 6) {
          draggingRef.current = true; setHoverRect(null);
          setDragRect({ x: Math.min(e.clientX, downRef.current.x), y: Math.min(e.clientY, downRef.current.y), w: Math.abs(dx), h: Math.abs(dy) });
          return;
        }
      }
      const el = document.elementFromPoint(e.clientX, e.clientY);
      if (!el || isSelf(el)) { setHoverRect(null); hoverElRef.current = null; return; }
      hoverElRef.current = el;
      const r = el.getBoundingClientRect();
      setHoverRect({ x: r.x, y: r.y, w: r.width, h: r.height });
    };
    const onUp = (e) => {
      const start = downRef.current; downRef.current = null;
      if (!start) return;
      if (draggingRef.current) {
        draggingRef.current = false;
        const x = Math.min(e.clientX, start.x), y = Math.min(e.clientY, start.y), w = Math.abs(e.clientX - start.x), h = Math.abs(e.clientY - start.y);
        setDragRect(null);
        if (w > 8 && h > 8) addRegion({ x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h) }, e.clientX, e.clientY);
        return;
      }
      const el = document.elementFromPoint(e.clientX, e.clientY);
      if (!el || isSelf(el)) return;
      coordsRef.current = { x: e.clientX, y: e.clientY };
      toggleElement(el);
    };
    const onClick = (e) => { // 选取期间吞掉底层元素的真实点击
      if (isSelf(document.elementFromPoint(e.clientX, e.clientY))) return;
      e.preventDefault(); e.stopPropagation();
    };
    const onKey = (e) => {
      if (e.key === "Escape") { setPicked([]); setInspecting(false); }
      else if (e.key === "Enter") { e.preventDefault(); commitPicks(); }
    };
    const onScroll = () => setPicked((p) => [...p]); // 滚动后刷新选区高亮框位置
    document.addEventListener("mousedown", onDown, true);
    document.addEventListener("mousemove", onMove, true);
    document.addEventListener("mouseup", onUp, true);
    document.addEventListener("click", onClick, true);
    document.addEventListener("keydown", onKey, true);
    window.addEventListener("scroll", onScroll, true);
    return () => {
      document.removeEventListener("mousedown", onDown, true);
      document.removeEventListener("mousemove", onMove, true);
      document.removeEventListener("mouseup", onUp, true);
      document.removeEventListener("click", onClick, true);
      document.removeEventListener("keydown", onKey, true);
      window.removeEventListener("scroll", onScroll, true);
    };
  }, [inspecting]); // eslint-disable-line

  // 点击元素：已选则移除，否则加入（上限 MAX_PICK）
  function toggleElement(el) {
    setPicked((list) => {
      const idx = list.findIndex((p) => p.el === el);
      if (idx >= 0) return list.filter((_, i) => i !== idx);
      if (list.length >= MAX_PICK) return list;
      return [...list, {
        el, kind: "element", selector: cssSelector(el), tag: el.tagName.toLowerCase(),
        text: (el.textContent || "").trim().slice(0, 200), outerHTML: (el.outerHTML || "").slice(0, 2000),
        alias: defaultAlias(el), // 默认简称：用户看到的文本/名字优先，可在 chip 里改
      }];
    });
  }
  // 拖拽框选的矩形区域（无对应单一 DOM 元素，靠截图编号框传达给 AI）
  function addRegion(rect, cx, cy) {
    coordsRef.current = { x: cx, y: cy };
    setPicked((list) => (list.length >= MAX_PICK ? list : [...list, { el: null, kind: "region", selector: "", tag: "(区域)", text: "", outerHTML: "", rect }]));
  }
  // 完成选取：序列化选区到会话并打开面板（即使未选任何元素，也直接打开聊天面板）
  function commitPicks() {
    const list = pickedRef.current;
    const elements = list.map((p) => ({
      selector: p.selector, tag: p.tag, text: p.text, outerHTML: p.outerHTML, kind: p.kind || "element", alias: p.alias || "",
      rect: p.kind === "region" ? p.rect : (liveRect(p.el) || p.rect || null),
    }));
    const prev = sess || {};
    persist({
      open: true, minimized: false, id: prev.id || genId(), elements,
      route: location.hash || location.pathname, page: document.title,
      coords: coordsRef.current || prev.coords || null, hasShot: !!shotRef.current,
      localPath: prev.localPath || "", branch: prev.branch || "", useShot: prev.useShot ?? (elements.length > 0),
      engine: prev.engine || currentEngine, messages: prev.messages || [], runId: prev.runId || null,
    });
    setInspecting(false); setPicked([]);
  }
  // 面板里删除某个选区
  function removeElement(i) {
    if (!sess) return;
    const next = sessElements(sess).filter((_, k) => k !== i);
    persist({ ...sess, element: undefined, elements: next });
  }
  // 给某个选区设置别名（聊天时可直接用别名指代）
  function setAlias(i, val) {
    if (!sess) return;
    const next = sessElements(sess).map((e, k) => (k === i ? { ...e, alias: val } : e));
    persist({ ...sess, element: undefined, elements: next });
  }
  // 清空所有已添加的选区（元素 + 区域）
  function clearElements() {
    if (!sess) return;
    setPicked([]);
    persist({ ...sess, element: undefined, elements: [] });
  }

  // 不选元素也能直接打开聊天面板（无会话则建一个空会话）；同时取消最小化
  function openPanel() {
    if (sess) { persist({ ...sess, open: true, minimized: false }); return; }
    persist({
      open: true, minimized: false, id: genId(), elements: [], route: location.hash || location.pathname, page: document.title,
      coords: null, hasShot: false, localPath: "", branch: "", useShot: false, engine: currentEngine, messages: [], runId: null,
    });
  }

  // 把当前会话（若有内容）归档到历史列表，返回新列表
  function archiveCurrent() {
    const cur = sess;
    let list = loadList();
    if (cur && ((cur.messages || []).length || sessElements(cur).length)) {
      const id = cur.id || genId();
      list = [{ ...cur, id, open: false, minimized: false, runId: null, savedAt: Date.now() }, ...list.filter((s) => s.id !== id)].slice(0, 30);
      saveList(list); setArchived(list);
    }
    return list;
  }
  // 新开会话：归档当前对话，开一段干净对话（保留仓库配置：本地路径/分支）
  function newConversation() {
    if (running) { alert("AI 正在工作，请等当前回合结束或先停止再新开会话"); return; }
    archiveCurrent();
    setInput(""); setShowHistory(false); setQueue([]); doneRef.current = true;
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
    persist({
      open: true, minimized: false, id: genId(), elements: [], route: location.hash || location.pathname, page: document.title,
      coords: null, hasShot: false, localPath: sess?.localPath || "", branch: sess?.branch || "", useShot: sess?.useShot ?? false,
      engine: sess?.engine || currentEngine, messages: [], runId: null,
    });
  }
  // 切回某条历史会话：先归档当前，再把所选恢复为活动会话（从历史移除）
  function restoreSession(id) {
    if (running) { alert("AI 正在工作，请等当前回合结束或先停止再切换会话"); return; }
    const afterArchive = archiveCurrent();
    const target = afterArchive.find((s) => s.id === id);
    if (!target) { setShowHistory(false); return; }
    const rest = afterArchive.filter((s) => s.id !== id);
    saveList(rest); setArchived(rest);
    setInput(""); setShowHistory(false); setQueue([]); doneRef.current = true;
    persist({ ...target, open: true, minimized: false, runId: null });
  }
  function deleteArchived(id) {
    const list = loadList().filter((s) => s.id !== id);
    saveList(list); setArchived(list);
  }

  // ===== 悬浮窗：拖动 + 任意边/角缩放（位置尺寸持久化） =====
  const baseName = (p) => String(p || "").split(/[\\/]+/).filter(Boolean).pop() || "";
  const persistBox = (b) => { setPanelBox(b); try { localStorage.setItem("devmode_panel_box", JSON.stringify(b)); } catch {} };
  function boxOrDefault() {
    if (panelBox) return panelBox;
    const width = 420, height = Math.min(560, window.innerHeight - 40);
    return { width, height, left: Math.max(8, window.innerWidth - width - 20), top: Math.max(8, window.innerHeight - height - 16) };
  }
  function onDragMove(e) {
    const d = dragRef.current; if (!d) return;
    const dx = e.clientX - d.sx, dy = e.clientY - d.sy, MINW = 320, MINH = 240;
    let { left, top, width, height } = d.box;
    if (d.mode === "move") { left = d.box.left + dx; top = d.box.top + dy; }
    else {
      const dir = d.dir;
      if (dir.includes("e")) width = d.box.width + dx;
      if (dir.includes("s")) height = d.box.height + dy;
      if (dir.includes("w")) { width = d.box.width - dx; left = d.box.left + dx; }
      if (dir.includes("n")) { height = d.box.height - dy; top = d.box.top + dy; }
      if (width < MINW) { if (dir.includes("w")) left -= MINW - width; width = MINW; }
      if (height < MINH) { if (dir.includes("n")) top -= MINH - height; height = MINH; }
    }
    width = Math.min(width, window.innerWidth - 8);
    height = Math.min(height, window.innerHeight - 8);
    left = Math.max(60 - width, Math.min(left, window.innerWidth - 60)); // 至少留 60px 可见，避免拖出屏幕
    top = Math.max(0, Math.min(top, window.innerHeight - 32));
    persistBox({ left, top, width, height });
  }
  function onDragUp() {
    dragRef.current = null;
    window.removeEventListener("mousemove", onDragMove, true);
    window.removeEventListener("mouseup", onDragUp, true);
  }
  function startMove(e) {
    if (e.target.closest("button,input,textarea,a,select,label")) return; // 点按钮/输入时不拖动
    e.preventDefault();
    dragRef.current = { mode: "move", sx: e.clientX, sy: e.clientY, box: boxOrDefault() };
    window.addEventListener("mousemove", onDragMove, true);
    window.addEventListener("mouseup", onDragUp, true);
  }
  function startResize(dir, e) {
    e.preventDefault(); e.stopPropagation();
    dragRef.current = { mode: "resize", dir, sx: e.clientX, sy: e.clientY, box: boxOrDefault() };
    window.addEventListener("mousemove", onDragMove, true);
    window.addEventListener("mouseup", onDragUp, true);
  }

  // ===== 发送：组上下文 → 跑 agent-loop 改源码，流式回显 =====
  function finalizeRun(result) {
    if (doneRef.current) return; // 幂等：WS end 与轮询兜底只收尾一次
    doneRef.current = true;
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
    setRunning(false);
    setSess((s) => {
      if (!s) return s;
      const msgs = [...(s.messages || [])];
      const last = msgs[msgs.length - 1];
      let txt = result.error ? `❌ ${result.error}` : `✅ ${result.done ? "完成" : result.reachedMax ? "(达轮次上限)" : "结束"}（${result.steps || 0}步）：${result.summary || ""}`;
      // 明确告诉用户改动如何生效（前端需重建刷新 / 后端网关需重启）
      const c = result.changed;
      if (c && (c.frontend || c.backend)) {
        const hints = [];
        if (c.frontend) hints.push("前端改动 → 点「开发完成 → 重新构建前端并刷新」后生效");
        if (c.backend) hints.push("后端/网关改动 → 点「开发完成 → 重启网关」后生效");
        txt += `\n\n⚠ 改动已写入源码但【尚未生效】：\n· ${hints.join("\n· ")}`;
      }
      if (last && last.role === "claude" && last.pending) { last.pending = false; last.engine = last.engine || result.engine || s.engine || "claude"; last.text = (last.text ? last.text + "\n\n" : "") + txt; }
      else msgs.push({ role: "claude", engine: result.engine || s.engine || "claude", text: txt });
      const next = { ...s, messages: msgs, runId: null };
      try { localStorage.setItem(LS_KEY, JSON.stringify(next)); } catch {}
      return next;
    });
  }

  // 发送：AI 工作中则排队（本回合结束自动发，像故事点），否则立即发起一个回合
  function send() {
    const msg = input.trim();
    if (!msg || !sess) return;
    if (!sess.localPath) { setRepoOpen(true); alert("请先点「⚙ 仓库」设置本工程的本地路径"); return; }
    setInput("");
    if (running || queue.length) { setQueue((q) => [...q, msg]); return; }
    runTurn(msg);
  }

  // 实际发起一个回合：组上下文 → 跑 agent-loop 改源码，流式回显
  async function runTurn(msg) {
    setRunning(true);
    doneRef.current = false;
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
    // 采集最近日志
    let logs = "";
    try {
      const r = await fetch(getApiUrl("/api/logs?limit=200")).then((x) => x.json());
      logs = ((r && r.data) || []).map((l) => `[${l.level || ""}] ${l.module || ""} ${l.message || ""}`).join("\n");
    } catch {}
    // 截图视觉输入：仅勾选「发送截图」时带上。多选区时现截一张并叠加编号框(①②③)，与选区列表一一对应
    let screenshot = "";
    if (sess.useShot) {
      const els = sessElements(sess);
      screenshot = (els.length ? await capture(els) : (shotRef.current || await capture())) || "";
    }
    const engine = sess.engine || currentEngine;
    const messages = [...(sess.messages || []), { role: "user", text: msg }, { role: "claude", engine, text: "", pending: true }];
    persist({ ...sess, engine, messages });

    // 订阅 WS 流
    try { wsRef.current?.close(); } catch {}
    let runId = null;
    const ws = createGatewayWebSocket(); wsRef.current = ws;
    ws.onmessage = (e) => {
      try {
        const m = JSON.parse(e.data);
        if (m.type !== "devmode_step" || (runId && m.data.runId !== runId)) return;
        if (m.data.phase === "end") { finalizeRun(m.data.result); try { ws.close(); } catch {} return; }
        const line = m.data.phase === "think" ? `🧠 ${m.data.text || ""}` : m.data.phase === "exec" ? `${m.data.ok ? "✓" : "✗"} ${m.data.tool || ""} ${m.data.text || ""}` : (m.data.text || "");
        if (!line.trim()) return;
        setSess((s) => {
          if (!s) return s;
          const msgs = [...(s.messages || [])]; const last = msgs[msgs.length - 1];
          if (last && last.role === "claude" && last.pending) last.text = (last.text ? last.text + "\n" : "") + line;
          const next = { ...s, messages: msgs };
          try { localStorage.setItem(LS_KEY, JSON.stringify(next)); } catch {}
          return next;
        });
      } catch {}
    };

    try {
      const r = await fetch(getApiUrl("/api/devbench/devmode/run"), {
        method: "POST", headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify({
          root: sess.localPath, branch: sess.branch, engine, message: msg,
          history: (sess.messages || []).filter((m) => !m.pending).map((m) => ({ role: m.role, text: m.text })),
          elements: sessElements(sess), element: sessElements(sess)[0] || null,
          route: sess.route, page: sess.page, coords: sess.coords, logs,
          screenshot, screenshotType: "image/jpeg",
        }),
      }).then((x) => x.json());
      if (r.ok) {
        runId = r.data.runId; persist({ ...sess, engine, messages, runId });
        // 轮询兜底：即便 WS 漏收 end，也能据 run-result 收尾 → running 复位 → 可继续发送
        pollRef.current = setInterval(async () => {
          try {
            const rr = await fetch(getApiUrl(`/api/devbench/devmode/run-result?runId=${runId}`), { headers: authHeaders() }).then((x) => x.json());
            if (rr.ok && rr.data && !rr.data.pending) finalizeRun(rr.data);
          } catch {}
        }, 3000);
      } else finalizeRun({ error: r.error || "启动失败" });
    } catch (e) { finalizeRun({ error: e.message }); }
  }

  // 打开部署面板时取进程启动方式（供展示 + 失败兜底手动命令）
  useEffect(() => {
    if (!finishing || procInfo) return;
    fetch(getApiUrl("/api/devbench/devmode/proc-info"), { headers: authHeaders() })
      .then((r) => r.json()).then((d) => { if (d.ok) setProcInfo(d.data); }).catch(() => {});
  }, [finishing]); // eslint-disable-line

  // ===== 「开发完成」部署动作（对话中不做，此处显式触发；重启需确认） =====
  async function rebuildWeb() {
    setDeployMsg("正在重新构建前端…(约几十秒)");
    try {
      const r = await fetch(getApiUrl("/api/devbench/devmode/rebuild-web"), { method: "POST", headers: authHeaders() }).then((x) => x.json());
      if (r.ok) { setDeployMsg("构建完成，正在刷新…"); setTimeout(() => location.reload(), 800); }
      else setDeployMsg("构建失败：" + (r.error || ""));
    } catch (e) { setDeployMsg("构建失败：" + e.message); }
  }
  const manualHint = () => (procInfo?.manualRestart ? `自动重启未成功，请手动重启：${procInfo.manualRestart}` : "自动重启未成功，请手动重启网关后刷新页面");
  async function restartGateway() {
    if (!window.confirm("重启网关会让后端改动生效，期间服务短暂中断。开发会话已保存，恢复后可继续。确定重启？")) return;
    // 桌面版：重启整个 app（含内置网关）
    if (window.electronAPI?.restartApp) { setDeployMsg("正在重启应用…"); window.electronAPI.restartApp(); return; }
    setDeployMsg("网关重启中…（约 3-5 秒）");
    try { await fetch(getApiUrl("/api/devbench/devmode/restart-gateway"), { method: "POST", headers: authHeaders() }); }
    catch { /* 进程退出会让请求中断，属正常 */ }
    // 轮询健康，恢复后刷新；超时给手动兜底命令
    let tries = 0;
    const t = setInterval(async () => {
      tries++;
      try { const h = await fetch(getApiUrl("/api/health"), { cache: "no-store" }); if (h.ok) { clearInterval(t); setDeployMsg("网关已恢复，刷新…"); setTimeout(() => location.reload(), 600); return; } } catch {}
      if (tries > 20) { clearInterval(t); setDeployMsg(manualHint()); }
    }, 1000);
  }
  async function repackageDesktop() {
    if (!window.confirm("重新打包桌面版耗时数分钟，在后台进行；完成后到 desktop/dist 取安装包重新安装。确定开始？")) return;
    try {
      const r = await fetch(getApiUrl("/api/devbench/devmode/repackage-desktop"), { method: "POST", headers: authHeaders() }).then((x) => x.json());
      setDeployMsg(r.ok ? (r.data?.hint || "已在后台打包") : ("失败：" + (r.error || "")));
    } catch (e) { setDeployMsg("失败：" + e.message); }
  }

  // 复制整段会话(含上下文)，便于到其它终端发给 AI 分析/确认
  function copyConversation() {
    if (!sess) return;
    const L = ["【在此开发 · 会话记录】"];
    if (sess.route) L.push(`页面路由：${sess.route}`);
    sessElements(sess).forEach((e, i) => L.push(`选区${i + 1}${e.alias ? `（${e.alias}）` : ""}：${e.kind === "region" ? "(框选区域)" : `<${e.tag}>`}  选择器：${e.selector || "-"}${e.text ? "  文本：" + e.text : ""}`));
    if (sess.localPath) L.push(`工程本地路径：${sess.localPath}${sess.branch ? "  分支：" + sess.branch : ""}`);
    L.push("");
    for (const m of sess.messages || []) {
      const who = m.role === "user" ? "【我】" : `【${engineDisplayName(m.engine || sess.engine || "claude")}】`;
      L.push(`${who}\n${m.text || ""}\n`);
    }
    const text = L.join("\n").trim();
    const done = () => { setCopied(true); setTimeout(() => setCopied(false), 1500); };
    if (navigator.clipboard?.writeText) navigator.clipboard.writeText(text).then(done).catch(() => fallbackCopy(text, done));
    else fallbackCopy(text, done);
  }
  function fallbackCopy(text, done) {
    try { const ta = document.createElement("textarea"); ta.value = text; ta.style.position = "fixed"; ta.style.opacity = "0"; document.body.appendChild(ta); ta.select(); document.execCommand("copy"); document.body.removeChild(ta); done(); } catch {}
  }

  if (!isAdmin) return null;
  const panelOpen = sess?.open;
  const minimized = !!sess?.minimized;
  const box = panelOpen ? boxOrDefault() : null;

  return (
    <div ref={rootRef}>
      {/* 选取模式：悬停高亮框 */}
      {inspecting && hoverRect && (
        <div className="fixed z-[60] pointer-events-none border-2 border-rose-500 bg-rose-500/10"
          style={{ left: hoverRect.x, top: hoverRect.y, width: hoverRect.w, height: hoverRect.h }} />
      )}
      {/* 选取模式：已选元素/区域的编号高亮框 */}
      {inspecting && picked.map((p, i) => {
        const r = p.kind === "region" ? p.rect : (p.el && p.el.getBoundingClientRect());
        if (!r) return null;
        const x = r.x, y = r.y, w = r.w ?? r.width, h = r.h ?? r.height;
        return (
          <div key={i} className={`fixed z-[60] pointer-events-none border-2 bg-indigo-500/15 ${p.kind === "region" ? "border-dashed border-violet-400" : "border-indigo-500"}`}
            style={{ left: x, top: y, width: w, height: h }}>
            <span className="absolute -top-[1px] -left-[1px] text-[10px] leading-none px-1 py-0.5 bg-indigo-500 text-white rounded-br">{i + 1}</span>
          </div>
        );
      })}
      {/* 选取模式：拖拽框选实时矩形 */}
      {inspecting && dragRect && (
        <div className="fixed z-[60] pointer-events-none border-2 border-dashed border-violet-400 bg-violet-400/10"
          style={{ left: dragRect.x, top: dragRect.y, width: dragRect.w, height: dragRect.h }} />
      )}
      {/* 选取模式：顶部工具条（可点击，不受吞击影响——在 rootRef 内被视作自身） */}
      {inspecting && (
        <div className="fixed top-3 left-1/2 -translate-x-1/2 z-[61] flex items-center gap-2 px-3 py-1.5 rounded-full bg-rose-600 text-white text-xs shadow-lg">
          <span>点击元素 加/减　·　拖拽 框选区域　·　已选 <b>{picked.length}</b>{picked.length >= MAX_PICK ? "(已达上限)" : ""}</span>
          <button onClick={commitPicks}
            className="px-2 py-0.5 rounded bg-white/20 hover:bg-white/30">{picked.length ? "完成 (Enter)" : "不选·直接聊天 (Enter)"}</button>
          <button onClick={() => { setPicked([]); setInspecting(false); }}
            className="px-2 py-0.5 rounded bg-black/20 hover:bg-black/30">取消 (Esc)</button>
        </div>
      )}

      {/* 「在此开发」触发按钮：渲染到常驻悬浮坞内（坞收起时随之隐藏） */}
      {slot && createPortal(
        <button onClick={() => (inspecting ? (setPicked([]), setInspecting(false)) : minimized ? persist({ ...sess, minimized: false }) : startInspect())}
          title={`在此开发（管理员）：进入选择页面元素模式；选完(或直接点完成不选)打开 AI 聊天面板让当前 AI 改本地源码（当前 ${currentEngineName}）`}
          className={`flex items-center justify-center gap-1.5 px-3 h-9 rounded-lg shadow text-white text-xs font-medium transition ${inspecting ? "bg-rose-700" : "bg-indigo-600 hover:bg-indigo-500"}`}>
          <svg className="w-4 h-4 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="M11 4a2 2 0 114 0v1m-4 0a2 2 0 104 0m-4 0H7m4 0h2M5 12h14M7 16h10M9 20h6" /></svg>
          {inspecting ? "选元素中…" : "在此开发"}
        </button>,
        slot
      )}

      {/* 收起态：右侧边缘小图标，点击还原 */}
      {panelOpen && minimized && (
        <button onClick={() => persist({ ...sess, minimized: false })} title={`展开「在此开发」AI 聊天面板 · 当前 ${currentEngineName}`}
          className="fixed right-0 top-1/2 -translate-y-1/2 z-[55] flex flex-col items-center gap-1 px-1.5 py-2.5 rounded-l-lg shadow-lg bg-indigo-600 hover:bg-indigo-500 text-white">
          <span className={`w-1.5 h-1.5 rounded-full ${running ? "bg-green-300 animate-pulse" : "bg-white/60"}`} />
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="M11 4a2 2 0 114 0v1m-4 0a2 2 0 104 0m-4 0H7m4 0h2M5 12h14M7 16h10M9 20h6" /></svg>
          <span className="text-[10px] [writing-mode:vertical-rl]">在此开发 · {shortEngine(currentEngine)}</span>
        </button>
      )}

      {/* 覆盖式编辑悬浮窗（可拖动、可缩放） */}
      {panelOpen && !minimized && (
        <div className="fixed z-[55] flex flex-col bg-zinc-900 border border-indigo-700/60 rounded-xl shadow-2xl overflow-hidden"
          style={{ left: box.left, top: box.top, width: box.width, height: box.height }}>
          {/* 8 方向缩放手柄 */}
          <div onMouseDown={(e) => startResize("n", e)} className="absolute top-0 left-2 right-2 h-1.5 cursor-ns-resize" />
          <div onMouseDown={(e) => startResize("s", e)} className="absolute bottom-0 left-2 right-2 h-1.5 cursor-ns-resize" />
          <div onMouseDown={(e) => startResize("w", e)} className="absolute left-0 top-2 bottom-2 w-1.5 cursor-ew-resize" />
          <div onMouseDown={(e) => startResize("e", e)} className="absolute right-0 top-2 bottom-2 w-1.5 cursor-ew-resize" />
          <div onMouseDown={(e) => startResize("nw", e)} className="absolute top-0 left-0 w-3 h-3 cursor-nwse-resize z-10" />
          <div onMouseDown={(e) => startResize("ne", e)} className="absolute top-0 right-0 w-3 h-3 cursor-nesw-resize z-10" />
          <div onMouseDown={(e) => startResize("sw", e)} className="absolute bottom-0 left-0 w-3 h-3 cursor-nesw-resize z-10" />
          <div onMouseDown={(e) => startResize("se", e)} className="absolute bottom-0 right-0 w-3 h-3 cursor-nwse-resize z-10" />

          <div onMouseDown={startMove} className="flex flex-wrap items-center gap-x-2 gap-y-1 px-3.5 py-2.5 border-b border-zinc-800 cursor-move select-none">
            <span className="text-sm font-semibold text-indigo-300">🛠 在此开发</span>
            <div className="relative">
              <button
                onClick={openEngineMenu}
                disabled={running}
                title={running ? `当前 ${currentEngineName} 正在开发，运行中不能切换 AI` : `当前 AI：${currentEngineName}，点击切换`}
                className={`text-[11px] px-2 py-0.5 rounded border inline-flex items-center gap-1.5 ${
                  running
                    ? "bg-zinc-800 border-zinc-700 text-zinc-500 cursor-not-allowed"
                    : showEngineMenu
                      ? "bg-indigo-600 border-indigo-500 text-white"
                      : "bg-zinc-800 border-zinc-700 text-indigo-200 hover:text-white"
                }`}
              >
                <span className={`w-1.5 h-1.5 rounded-full ${running ? "bg-green-400 animate-pulse" : "bg-indigo-300"}`} />
                <span className="text-zinc-400">AI</span>
                <span className="font-semibold">{currentEngineName}</span>
                <span className="text-[9px] opacity-70">▼</span>
              </button>
              {showEngineMenu && !running && (
                <>
                  <div className="fixed inset-0 z-[54]" onMouseDown={(e) => { e.stopPropagation(); setShowEngineMenu(false); }} />
                  <div className="absolute left-0 top-full mt-1 z-[56] w-52 bg-zinc-900 border border-zinc-700 rounded-lg shadow-2xl py-1" onMouseDown={(e) => e.stopPropagation()}>
                    <div className="px-3 py-1.5 text-[10px] text-zinc-500 border-b border-zinc-800 flex items-center gap-1.5">
                      <span>选择在此开发使用的 AI</span>
                      {engineStatusLoading && <span className="ml-auto text-blue-300">检测中...</span>}
                    </div>
                    {engineOptions.map((e) => {
                      const avail = engineStatus ? engineStatus[e.id]?.available !== false : true;
                      const disabledHint = engineStatus?.[e.id]?.error || (e.api ? "未启用或未配置 Key" : "未安装或未登录");
                      return (
                        <button
                          key={e.id}
                          disabled={!avail}
                          onClick={() => switchEngine(e.id)}
                          title={!avail ? disabledHint : e.name}
                          className={`w-full text-left px-3 py-1.5 text-xs flex items-center gap-2 transition ${!avail ? "opacity-40 cursor-not-allowed" : "hover:bg-zinc-800"} ${e.id === currentEngine ? "text-indigo-300" : "text-zinc-200"}`}
                        >
                          <span className="shrink-0">{e.id === currentEngine ? "●" : "○"}</span>
                          <span className="flex-1 truncate">{e.name}</span>
                          {!avail && <span className="text-[10px] text-zinc-600">{e.api ? "未启用" : "不可用"}</span>}
                        </button>
                      );
                    })}
                  </div>
                </>
              )}
            </div>
            <button onClick={newConversation} title="新开一段与 AI 的会话（当前对话会存入历史，可切回）" className="text-[11px] px-2 py-0.5 rounded bg-indigo-700/40 border border-indigo-700/50 text-indigo-200 hover:text-white">🆕 新会话</button>
            <button onClick={startInspect} title="进入选择页面元素模式，在已有选区基础上追加元素/区域" className="text-[11px] px-2 py-0.5 rounded bg-zinc-800 border border-zinc-700 text-zinc-300 hover:text-white">＋ 添加元素</button>
            <div className="relative">
              <button onClick={() => { setArchived(loadList()); setShowHistory((v) => !v); }} title="历史会话，点击切回"
                className="text-[11px] px-2 py-0.5 rounded bg-zinc-800 border border-zinc-700 text-zinc-300 hover:text-white">🕘 历史{archived.length ? `(${archived.length})` : ""}</button>
              {showHistory && (
                <>
                  <div className="fixed inset-0 z-[54]" onMouseDown={(e) => { e.stopPropagation(); setShowHistory(false); }} />
                  <div className="absolute left-0 top-full mt-1 z-[56] w-72 max-h-72 overflow-y-auto bg-zinc-900 border border-zinc-700 rounded-lg shadow-2xl py-1" onMouseDown={(e) => e.stopPropagation()}>
                    {archived.length === 0 ? (
                      <div className="px-3 py-2 text-[11px] text-zinc-600">暂无历史会话。点「新会话」后，旧对话会存到这里。</div>
                    ) : archived.map((s) => (
                      <div key={s.id} className="flex items-center gap-1 px-2 py-1.5 hover:bg-zinc-800">
                        <button onClick={() => restoreSession(s.id)} className="flex-1 min-w-0 text-left">
                          <div className="text-[12px] text-zinc-200 truncate">{sessTitle(s)}</div>
                          <div className="text-[10px] text-zinc-500 truncate">{(s.messages || []).length} 条 · {s.localPath ? baseName(s.localPath) : "未设仓库"}</div>
                        </button>
                        <button onClick={() => deleteArchived(s.id)} title="删除该历史会话" className="shrink-0 text-zinc-600 hover:text-rose-400 text-xs px-1">✕</button>
                      </div>
                    ))}
                  </div>
                </>
              )}
            </div>
            <button onClick={() => setRepoOpen((v) => !v)} title="设置代码仓库（本地路径/目标分支），可展开收起"
              className={`text-[11px] px-2 py-0.5 rounded border ${sess.localPath ? "bg-zinc-800 border-zinc-700 text-zinc-300" : "bg-amber-900/20 border-amber-700/50 text-amber-300"} hover:text-white`}>⚙ 仓库</button>
            <button onClick={copyConversation} title="复制本会话(含元素/路由/工程上下文 + 全部对话)，便于到其它终端发给 AI 分析"
              className="text-[11px] px-2 py-0.5 rounded bg-zinc-800 border border-zinc-700 text-zinc-300 hover:text-white">{copied ? "已复制 ✓" : "复制对话"}</button>
            <button onClick={() => { setFinishing(true); setDeployMsg(""); }} className="text-[11px] px-2 py-0.5 rounded bg-emerald-700/40 border border-emerald-700/50 text-emerald-300 hover:text-white">开发完成</button>
            <button onClick={() => persist({ ...sess, minimized: true })} title="收起到右侧小图标" className="ml-auto text-zinc-500 hover:text-zinc-300 text-base leading-none">—</button>
            <button onClick={() => persist({ ...sess, open: false })} title="关闭（会话保留，可从悬浮坞「在此开发」重开）" className="text-zinc-500 hover:text-zinc-300 text-lg leading-none">×</button>
          </div>

          {/* 开发完成 → 部署面板（对话中不部署，此处显式触发；重启需确认） */}
          {finishing && (
            <div className="px-3.5 py-3 border-b border-zinc-800 bg-zinc-950/60 space-y-2">
              <div className="text-[12px] text-zinc-300 font-medium">开发完成 · 应用改动</div>
              <p className="text-[10px] text-zinc-600">对话过程中只改了源码、未部署。现在选择如何让改动生效：</p>
              <div className="grid grid-cols-1 gap-1.5">
                <button onClick={rebuildWeb} className="text-left text-[12px] px-2.5 py-1.5 rounded bg-zinc-800 border border-zinc-700 text-zinc-200 hover:border-indigo-600">🔁 重新构建前端并刷新<span className="text-[10px] text-zinc-500 ml-1">（前端改动）</span></button>
                <button onClick={restartGateway} className="text-left text-[12px] px-2.5 py-1.5 rounded bg-zinc-800 border border-zinc-700 text-zinc-200 hover:border-amber-600">♻ 重启网关<span className="text-[10px] text-amber-500/80 ml-1">（后端改动 · 会弹窗确认）</span></button>
                {procInfo && (
                  <div className="text-[10px] text-zinc-600 px-1 leading-relaxed">
                    当前启动方式：<b className="text-zinc-400">{procInfo.mode === "electron" ? "桌面版(内置网关)" : "Web 模式 node server.js"}</b> · 端口 {procInfo.port}
                    <div className="flex items-center gap-1 mt-0.5">
                      <span className="text-zinc-600">自动重启失败时手动跑：</span>
                      <code className="font-mono text-zinc-400 truncate flex-1">{procInfo.manualRestart}</code>
                      <button onClick={() => navigator.clipboard?.writeText(procInfo.manualRestart)} title="复制" className="text-zinc-600 hover:text-zinc-300 shrink-0">⧉</button>
                    </div>
                  </div>
                )}
                <button onClick={repackageDesktop} className="text-left text-[12px] px-2.5 py-1.5 rounded bg-zinc-800 border border-zinc-700 text-zinc-200 hover:border-violet-600">📦 重新打包桌面版<span className="text-[10px] text-zinc-500 ml-1">（耗时 · 后台 · 需重装）</span></button>
                <div className="flex items-center gap-2 pt-0.5">
                  <button onClick={() => { persist({ ...sess, messages: [], runId: null, open: false }); setFinishing(false); }} className="text-[11px] px-2 py-1 rounded bg-zinc-800 border border-zinc-700 text-zinc-400 hover:text-white">结束并清空会话</button>
                  <button onClick={() => setFinishing(false)} className="text-[11px] px-2 py-1 text-zinc-500 hover:text-zinc-300">返回</button>
                  {deployMsg && <span className="text-[10px] text-zinc-400 ml-auto">{deployMsg}</span>}
                </div>
              </div>
            </div>
          )}

          <div className="px-3.5 py-2 border-b border-zinc-800 space-y-1.5">
            {sessElements(sess).length > 0 && (
              <div className="flex flex-wrap items-center gap-1">
                {sessElements(sess).map((e, i) => (
                  <span key={i} title={`${e.kind === "region" ? "区域" : `<${e.tag}>`}${e.text ? " · " + e.text : ""}${e.selector ? "\n" + e.selector : ""}`}
                    className="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded bg-indigo-600/20 border border-indigo-700/50 text-indigo-200">
                    <span className="text-indigo-400 font-semibold">{i + 1}</span>
                    <input value={e.alias || ""} onChange={(ev) => setAlias(i, ev.target.value)}
                      placeholder={e.kind === "region" ? "区域别名" : "元素别名"} title="给该选区起个别名，聊天时直接说别名 AI 即知道指哪个"
                      className="w-20 bg-transparent border-b border-indigo-700/40 focus:border-indigo-400 text-indigo-100 placeholder-indigo-300/40 outline-none" />
                    {!e.alias && e.text ? <span className="text-zinc-400 max-w-[90px] truncate">{e.text}</span> : null}
                    <button onClick={() => removeElement(i)} title="移除该选区" className="text-indigo-400/70 hover:text-white">✕</button>
                  </span>
                ))}
                <button onClick={clearElements} title="清空所有已添加的选区"
                  className="ml-auto shrink-0 text-[10px] px-1.5 py-0.5 rounded bg-zinc-800 border border-zinc-700 text-zinc-400 hover:text-rose-300 hover:border-rose-700/60">清空选区</button>
              </div>
            )}
            <div className="text-[10px] text-zinc-600">路由 {sess.route} · 坐标 {sess.coords ? `${sess.coords.x},${sess.coords.y}` : "-"}</div>
            {repoOpen ? (
              <>
                <input value={sess.localPath || ""} onChange={(e) => persist({ ...sess, localPath: e.target.value })} onBlur={(e) => loadGit(e.target.value)}
                  placeholder="本工程本地路径（如 D:\\...\\web-dashboard 或仓库根）"
                  className="w-full bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-[11px] text-zinc-200 placeholder-zinc-600 outline-none font-mono" />
                <div className="flex items-center gap-2">
                  <input value={sess.branch || ""} onChange={(e) => persist({ ...sess, branch: e.target.value })}
                    placeholder="目标 git 分支（可留空）"
                    className="flex-1 bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-[11px] text-zinc-200 placeholder-zinc-600 outline-none font-mono" />
                  {gitInfo && (gitInfo.exists
                    ? <span className="text-[10px] text-zinc-500 whitespace-nowrap">当前 <b className="text-emerald-400">{gitInfo.branch || "?"}</b>{gitInfo.dirty ? ` ·改动${gitInfo.dirtyCount}` : " ·干净"}</span>
                    : <span className="text-[10px] text-amber-500">路径不存在</span>)}
                </div>
              </>
            ) : (
              <button onClick={() => setRepoOpen(true)} title="点开设置代码仓库"
                className="w-full flex items-center gap-1.5 text-[10px] text-left text-zinc-500 hover:text-zinc-300">
                <span className="text-zinc-600">⚙</span>
                {sess.localPath
                  ? <span className="truncate">仓库 <b className="text-zinc-400">{baseName(sess.localPath)}</b>{sess.branch ? <> · 分支 <b className="text-zinc-400">{sess.branch}</b></> : null}</span>
                  : <span className="text-amber-400">未设置代码仓库，点此设置</span>}
              </button>
            )}
            <label className="flex items-center gap-1.5 text-[10px] text-zinc-400 cursor-pointer">
              <input type="checkbox" checked={!!sess.useShot} onChange={(e) => persist({ ...sess, useShot: e.target.checked })} className="accent-indigo-500" />
              发送截图给当前 AI（用于理解页面）
              <span className="text-zinc-600">{sess.hasShot || shotRef.current ? "· 📷 已截图" : "· 发送时现截"}</span>
            </label>
          </div>

          <div className="flex-1 overflow-y-auto px-3.5 py-2 space-y-2 min-h-0">
            {(sess.messages || []).map((m, i) => (
              <div key={i} className={`text-[12px] ${m.role === "user" ? "text-right" : ""}`}>
                <span className={`inline-block max-w-[92%] text-left px-2.5 py-1.5 rounded-lg whitespace-pre-wrap ${m.role === "user" ? "bg-indigo-600/25 text-indigo-100" : "bg-zinc-800 text-zinc-200"}`}>
                  {m.role !== "user" && (
                    <span className="block text-[10px] text-indigo-300/80 mb-1">
                      {engineDisplayName(m.engine || sess.engine || "claude")}
                    </span>
                  )}
                  {m.text || (m.pending ? "…" : "")}
                </span>
              </div>
            ))}
            {/* 排队中的消息（AI 工作中发的，本回合结束后自动发） */}
            {queue.map((q, i) => (
              <div key={`q${i}`} className="text-[12px] text-right">
                <span className="inline-flex items-center gap-1 max-w-[92%] text-left px-2.5 py-1.5 rounded-lg whitespace-pre-wrap bg-indigo-600/15 text-indigo-200/80 border border-indigo-700/40">
                  <span className="text-[10px] text-indigo-400 shrink-0">⏳排队{queue.length > 1 ? ` ${i + 1}/${queue.length}` : ""}</span>{q}
                </span>
              </div>
            ))}
            {!(sess.messages || []).length && !queue.length && <div className="text-[11px] text-zinc-600">描述要对所选元素/区域做的修改，发送给 {currentEngineName}，它会在本地源码里改。可点「＋选区」继续多选(点击元素加/减、拖拽框选)。AI 工作时也能继续发，会排队，本回合结束自动发。会话已自动保存，改码导致页面刷新也不会丢。</div>}
          </div>

          <div className="px-3 py-2.5 border-t border-zinc-800 flex items-end gap-2">
            <textarea value={input} onChange={(e) => setInput(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } }}
              rows={2} placeholder={running ? "AI 工作中…仍可输入，发送后排队，本回合结束自动发（Enter 发送）" : `要 ${currentEngineName} 做的修改…（Enter 发送，Shift+Enter 换行）`}
              className="flex-1 bg-zinc-800 border border-zinc-700 rounded px-2.5 py-1.5 text-[12px] text-zinc-200 placeholder-zinc-600 outline-none resize-none" />
            <button onClick={send} disabled={!input.trim()} title={running ? "AI 工作中：发送将排队，本回合结束自动发" : "发送"}
              className="px-3 py-2 text-xs rounded bg-indigo-600 hover:bg-indigo-500 disabled:bg-zinc-700 disabled:text-zinc-500 text-white shrink-0">{running ? "排队" : "发送"}</button>
          </div>
        </div>
      )}
    </div>
  );
}
