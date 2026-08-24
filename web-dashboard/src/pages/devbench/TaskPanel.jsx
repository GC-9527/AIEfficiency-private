/**
 * 待办任务面板（todoist 风格）—— 居中悬浮
 * - 顶部：快速新增输入 + 批量新增
 * - 列表只显示标题；勾选完成后置灰 + 删除线，完成项排到"已完成"分区
 * - 未完成 / 已完成两个分区均支持收起展开
 * - 点击标题弹出任务详情面板：工单地址（可点开/编辑）+ 任务完成时间
 */
import React, { useEffect, useRef, useState } from "react";
import { DEVBENCH_TASKS_CHANGED_EVENT, devbenchApi, emitDevbenchTasksChanged } from "./api.js";
import {
  TB_AUTO_SYNC_AT_KEY,
  reserveTbAutoSync,
  tbSyncCountSummary,
} from "./tbAutoSync.js";
import {
  TASK_PANEL_TABS,
  readTaskPanelActiveTab,
  saveTaskPanelActiveTab,
} from "./taskPanelTabsModel.mjs";
import TbTaskEntryModal from "./TbTaskEntryModal.jsx";
import {
  createGatewayWebSocket,
  getApiUrl,
  startTbTasksLogin,
} from "../../services/gateway.js";
import { authenticatedFetch } from "../../services/adminAuth.js";

function fmtTime(ms) {
  if (!ms) return "—";
  try { return new Date(ms).toLocaleString("zh-CN"); } catch { return "—"; }
}

const PRIO_ORDER = { P0: 0, P1: 1, P2: 2, P3: 3 };
const prioRank = (p) => (p && PRIO_ORDER[p] !== undefined ? PRIO_ORDER[p] : 99);
const PRIO_OPTIONS = ["P0", "P1", "P2", "P3"];
const TASK_TAB_ACTIVE_CLASS = Object.freeze({
  todo: "bg-blue-600/30 border border-blue-500/50 text-blue-100",
  tbpool: "bg-cyan-600/30 border border-cyan-500/50 text-cyan-100",
});

// 取标题里第一个【】中的内容作为分组名；无则归入"其他"
const UNGROUPED = "__ungrouped__";
const CUSTOM_TASK_GROUP = "__custom_task_group__";
function firstBracket(title) {
  const m = String(title || "").match(/【([^】]*)】/);
  const s = m ? m[1].trim() : "";
  return s || null;
}

function newTaskGroupId() {
  return `task_group_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function taskGroupKey(t) {
  const id = String(t?.taskGroupId || "").trim();
  const name = String(t?.taskGroupName || "").trim();
  if (id && name) return `task:${id}`;
  const b = firstBracket(t?.title);
  return b ? `bracket:${b}` : UNGROUPED;
}

function taskGroupLabel(t) {
  return String(t?.taskGroupName || "").trim() || firstBracket(t?.title) || "未分组";
}

function isExplicitTaskGroupKey(key) {
  return String(key || "").startsWith("task:");
}

function taskGroupOptionsFromTasks(list) {
  const map = new Map();
  for (const t of list || []) {
    const id = String(t?.taskGroupId || "").trim();
    const name = String(t?.taskGroupName || "").trim();
    if (id && name && !map.has(id)) map.set(id, { id, name });
  }
  return [...map.values()].sort((a, b) => a.name.localeCompare(b.name, "zh-CN"));
}

function mergeTaskGroupOptions(stored, fromTasks, draft) {
  const map = new Map();
  const add = (g) => {
    const id = String(g?.id || g?.taskGroupId || "").trim();
    const name = String(g?.name || g?.taskGroupName || "").trim();
    if (!id || !name) return;
    if (!map.has(id)) map.set(id, { id, name, createdAt: g.createdAt || 0 });
    else map.set(id, { ...map.get(id), name, createdAt: map.get(id).createdAt || g.createdAt || 0 });
  };
  (stored || []).forEach(add);
  (fromTasks || []).forEach(add);
  add(draft);
  return [...map.values()].sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0) || a.name.localeCompare(b.name, "zh-CN"));
}

function groupByTaskGroup(list, knownGroups = []) {
  const map = new Map();
  for (const g of knownGroups || []) {
    const id = String(g?.id || "").trim();
    const name = String(g?.name || "").trim();
    if (!id || !name) continue;
    const key = `task:${id}`;
    if (!map.has(key)) map.set(key, { key, id, label: name, explicit: true, bracket: false, tasks: [], createdAt: g.createdAt || 0 });
  }
  for (const t of list) {
    const key = taskGroupKey(t);
    const explicit = isExplicitTaskGroupKey(key);
    const bracket = key.startsWith("bracket:");
    const label = taskGroupLabel(t);
    if (!map.has(key)) map.set(key, { key, id: explicit ? String(t?.taskGroupId || "").trim() : "", label, explicit, bracket, tasks: [], createdAt: t.createdAt || 0 });
    const group = map.get(key);
    if (explicit && t?.taskGroupId) group.id = String(t.taskGroupId).trim();
    group.tasks.push(t);
  }
  const groups = [...map.values()];
  groups.sort((a, b) => {
    const ra = a.key === UNGROUPED ? 2 : (a.explicit ? 0 : 1);
    const rb = b.key === UNGROUPED ? 2 : (b.explicit ? 0 : 1);
    if (ra !== rb) return ra - rb;
    const fa = a.tasks.length ? Math.min(...a.tasks.map((t) => t.pinned ? 0 : (t.starred ? 1 : 2))) : 3;
    const fb = b.tasks.length ? Math.min(...b.tasks.map((t) => t.pinned ? 0 : (t.starred ? 1 : 2))) : 3;
    if (fa !== fb) return fa - fb;
    const pa = a.tasks.length ? Math.min(...a.tasks.map((t) => prioRank(t.priority))) : 99;
    const pb = b.tasks.length ? Math.min(...b.tasks.map((t) => prioRank(t.priority))) : 99;
    if (pa !== pb) return pa - pb;
    const ca = a.tasks.length ? Math.min(...a.tasks.map((t) => t.createdAt || 0)) : (a.createdAt || 0);
    const cb = b.tasks.length ? Math.min(...b.tasks.map((t) => t.createdAt || 0)) : (b.createdAt || 0);
    return ca - cb;
  });
  return groups;
}

function taskGroupPayload(group) {
  if (!group?.name) return {};
  return { taskGroupId: group.id || newTaskGroupId(), taskGroupName: group.name };
}

// 按标题第一个【】把列表分组；无【】归到"其他"恒置末尾。按组内最高优先级、再按最早创建时间排序。
function groupByBracket(list) {
  const map = new Map(); // key -> { key, label, tasks }
  for (const t of list) {
    const b = firstBracket(t.title);
    const key = b || UNGROUPED;
    if (!map.has(key)) map.set(key, { key, label: b || "其他", tasks: [] });
    map.get(key).tasks.push(t);
  }
  const groups = [...map.values()];
  groups.sort((a, b) => {
    if (a.key === UNGROUPED) return 1;
    if (b.key === UNGROUPED) return -1;
    const ra = Math.min(...a.tasks.map((t) => prioRank(t.priority)));
    const rb = Math.min(...b.tasks.map((t) => prioRank(t.priority)));
    if (ra !== rb) return ra - rb;
    return Math.min(...a.tasks.map((t) => t.createdAt)) - Math.min(...b.tasks.map((t) => t.createdAt));
  });
  return groups;
}

// 按到期日升序（临期靠前）；无到期日排末尾。YYYY-MM-DD 字符串可直接比较。
const NO_DEADLINE = "9999-12-31";
function byDeadlineAsc(a, b) {
  const da = a.deadline || NO_DEADLINE, db = b.deadline || NO_DEADLINE;
  if (da !== db) return da < db ? -1 : 1;
  return (a.createdAt || 0) - (b.createdAt || 0);
}

// 距今天的天数：>0 剩余、=0 今天、<0 逾期；无日期返回 null。按"日"比较，避免时区误差。
function daysFromToday(dateStr) {
  if (!dateStr) return null;
  const [y, m, d] = String(dateStr).split("-").map(Number);
  if (!y || !m || !d) return null;
  const due = new Date(y, m - 1, d);
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.round((due - today) / 86400000);
}

const WEEKDAY_CN = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
// 到期日人性化：今天/明天/后天/本周五/下周一/昨天/逾期N天/M月D日 周X。
// 返回 { text, overdue, urgent }；无法解析时回退原始字符串。以"日"为粒度，周起始按周一（中国习惯）。
function humanizeDeadline(dateStr) {
  const days = daysFromToday(dateStr);
  if (days === null) return { text: String(dateStr || ""), overdue: false, urgent: false };
  if (days < 0) {
    if (days === -1) return { text: "昨天", overdue: true, urgent: true };
    if (days === -2) return { text: "前天", overdue: true, urgent: true };
    return { text: `逾期${-days}天`, overdue: true, urgent: true };
  }
  if (days === 0) return { text: "今天", overdue: false, urgent: true };
  if (days === 1) return { text: "明天", overdue: false, urgent: true };
  if (days === 2) return { text: "后天", overdue: false, urgent: false };
  const [y, m, d] = String(dateStr).split("-").map(Number);
  const due = new Date(y, m - 1, d);
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const todayDow = (today.getDay() + 6) % 7; // 周一=0 … 周日=6
  const thisMonday = new Date(today); thisMonday.setDate(today.getDate() - todayDow);
  const nextMonday = new Date(thisMonday); nextMonday.setDate(thisMonday.getDate() + 7);
  const weekAfter = new Date(thisMonday); weekAfter.setDate(thisMonday.getDate() + 14);
  const wd = WEEKDAY_CN[due.getDay()];
  if (due < nextMonday) return { text: `本${wd}`, overdue: false, urgent: false };
  if (due < weekAfter) return { text: `下${wd}`, overdue: false, urgent: false };
  return { text: `${m}月${d}日 ${wd}`, overdue: false, urgent: false };
}

// 到期日徽标：人性化文案，逾期红、临期(今天/明天/逾期)琥珀加重，其余琥珀；title 保留精确日期。
function DeadlineBadge({ deadline }) {
  if (!deadline) return null;
  const { text, overdue, urgent } = humanizeDeadline(deadline);
  const cls = overdue
    ? "text-red-300 bg-red-900/30 border-red-800/50"
    : urgent
    ? "text-amber-200 bg-amber-900/30 border-amber-700/50"
    : "text-amber-300/90 bg-amber-900/20 border-amber-800/40";
  return (
    <span className={`shrink-0 text-[10px] rounded border px-1 py-0.5 ${cls}`} title={`期限：${deadline}`}>
      ⏰ {text}
    </span>
  );
}

function taskTags(task) {
  return Array.isArray(task?.customTags)
    ? task.customTags.map((x) => String(x || "").trim()).filter(Boolean)
    : [];
}

function normalizeTagList(input) {
  const raw = Array.isArray(input) ? input : String(input || "").split(/[,\n，、;；]+/);
  const out = [];
  const seen = new Set();
  for (const item of raw) {
    const tag = String(item || "").trim().replace(/\s+/g, " ").slice(0, 18);
    const key = tag.toLowerCase();
    if (!tag || seen.has(key)) continue;
    seen.add(key);
    out.push(tag);
    if (out.length >= 8) break;
  }
  return out;
}

function sameTags(a, b) {
  const aa = normalizeTagList(a), bb = normalizeTagList(b);
  return aa.length === bb.length && aa.every((x, i) => x === bb[i]);
}

function tagTone(tag) {
  const tones = [
    "bg-rose-600/20 text-rose-200 border-rose-500/35",
    "bg-cyan-600/20 text-cyan-200 border-cyan-500/35",
    "bg-emerald-600/20 text-emerald-200 border-emerald-500/35",
    "bg-amber-600/20 text-amber-100 border-amber-500/35",
    "bg-fuchsia-600/20 text-fuchsia-200 border-fuchsia-500/35",
    "bg-sky-600/20 text-sky-200 border-sky-500/35",
  ];
  let h = 0;
  for (const ch of String(tag || "")) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return tones[h % tones.length];
}

function TaskTags({ tags, limit = 3, removable = false, onRemove }) {
  const list = normalizeTagList(tags);
  if (!list.length) return null;
  const shown = list.slice(0, limit);
  return (
    <span className="shrink-0 inline-flex items-center gap-1 min-w-0">
      {shown.map((tag) => (
        <span key={tag} className={`inline-flex items-center gap-1 max-w-[96px] text-[9px] leading-none px-1.5 py-0.5 rounded-full border ${tagTone(tag)}`} title={tag}>
          <span className="truncate">{tag}</span>
          {removable && (
            <button
              onClick={(e) => { e.stopPropagation(); onRemove?.(tag); }}
              className="text-current/70 hover:text-white"
              title={`移除标签：${tag}`}
            >×</button>
          )}
        </span>
      ))}
      {list.length > shown.length && (
        <span className="text-[9px] text-zinc-500">+{list.length - shown.length}</span>
      )}
    </span>
  );
}

function StarButton({ starred, onClick, className = "" }) {
  return (
    <button
      onClick={(e) => { e.stopPropagation(); onClick?.(); }}
      className={`shrink-0 w-5 h-5 rounded-md flex items-center justify-center text-sm transition ${
        starred ? "text-amber-300 bg-amber-500/15 hover:bg-amber-500/25" : "text-zinc-600 hover:text-amber-300 hover:bg-zinc-800"
      } ${className}`}
      title={starred ? "取消星标" : "标为星标"}
    >★</button>
  );
}

function PinButton({ pinned, onClick, className = "" }) {
  return (
    <button
      onClick={(e) => { e.stopPropagation(); onClick?.(); }}
      className={`shrink-0 w-5 h-5 rounded-md flex items-center justify-center text-[12px] transition ${
        pinned ? "text-sky-200 bg-sky-500/20 hover:bg-sky-500/30" : "text-zinc-600 hover:text-sky-300 hover:bg-zinc-800"
      } ${className}`}
      title={pinned ? "取消置顶" : "置顶任务"}
    >↑</button>
  );
}

function matchesTbSearch(task, query) {
  const q = String(query || "").trim().toLowerCase();
  if (!q) return true;
  const fields = [
    task.title,
    task.carbId,
    task.tbTaskId,
    task.tbStatus,
    task.sprintName,
    task.deadline,
    task.ticketUrl,
  ];
  return fields.some((x) => String(x || "").toLowerCase().includes(q));
}

const NO_SPRINT = "__nosprint__";
// 按 TB 迭代(sprint)分组；组内按到期日升序；组按"组内最早到期"升序，无迭代组置末尾。
// 过滤掉"未开始(future)"的迭代 section（其任务在迭代模式下不显示）；"未排期"组保留。
function groupBySprint(list) {
  const map = new Map();
  for (const t of list) {
    const key = t.sprintName || t.sprintId || NO_SPRINT;
    const label = t.sprintName || (t.sprintId ? "迭代(未命名)" : "未排期");
    if (!map.has(key)) map.set(key, { key, label, tasks: [], sprintDue: t.sprintDueDate || null, sprintStatus: t.sprintStatus || null });
    map.get(key).tasks.push(t);
  }
  const groups = [...map.values()].filter((g) => g.key === NO_SPRINT || g.sprintStatus !== "future");
  for (const g of groups) g.tasks.sort(byDeadlineAsc);
  groups.sort((a, b) => {
    if (a.key === NO_SPRINT) return 1;
    if (b.key === NO_SPRINT) return -1;
    const da = a.sprintDue || a.tasks[0]?.deadline || NO_DEADLINE;
    const db = b.sprintDue || b.tasks[0]?.deadline || NO_DEADLINE;
    return da < db ? -1 : da > db ? 1 : 0;
  });
  return groups;
}

// 优先级徽标（P0 红 / P1 橙 / P2 黄 / P3 灰）
function PrioBadge({ p, className = "" }) {
  if (!p) return null;
  const color = p === "P0" ? "bg-red-600/30 text-red-300 border-red-500/40"
    : p === "P1" ? "bg-orange-600/30 text-orange-300 border-orange-500/40"
    : p === "P2" ? "bg-amber-600/25 text-amber-200 border-amber-500/40"
    : "bg-zinc-700 text-zinc-300 border-zinc-600";
  return <span className={`shrink-0 text-[9px] leading-none px-1 py-0.5 rounded border ${color} ${className}`}>{p}</span>;
}

// 圆形勾选框（todoist 风格）
function Check({ done, onClick, className = "" }) {
  return (
    <button
      onClick={(e) => { e.stopPropagation(); onClick(); }}
      title={done ? "标记为未完成" : "标记为已完成"}
      className={`shrink-0 w-4 h-4 rounded-full border flex items-center justify-center transition ${
        done ? "bg-emerald-600 border-emerald-500 text-white" : "border-zinc-500 hover:border-emerald-400 text-transparent hover:text-emerald-400"
      } ${className}`}
    >
      <span className="text-[9px] leading-none">✓</span>
    </button>
  );
}

// === 任务列表数据缓存：模块级内存 + localStorage，重开面板不闪"加载中…" ===
const TASKS_CACHE_KEY = "devbench_task_panel_tasks_cache_v1";
let tasksMemory = null;     // { tasks: [], taskGroups: [], ts: 0 }
let tasksMemoryLoaded = false;
function loadTasksMemory() {
  if (tasksMemoryLoaded) return;
  tasksMemoryLoaded = true;
  try {
    const raw = localStorage.getItem(TASKS_CACHE_KEY);
    if (raw) tasksMemory = JSON.parse(raw) || null;
  } catch { tasksMemory = null; }
}
function saveTasksMemory(tasks, taskGroups) {
  tasksMemory = { tasks: tasks || [], taskGroups: taskGroups || [], ts: Date.now() };
  try { localStorage.setItem(TASKS_CACHE_KEY, JSON.stringify(tasksMemory)); } catch {}
}
function readTasksMemory() {
  loadTasksMemory();
  return tasksMemory;
}

export default function TaskPanel({ onClose, onToast, onStartDev, onStartGroupDev, onTeamDev, onCancelTeam, openTabs = [] }) {
  const [groupMenuTask, setGroupMenuTask] = useState(null); // 已组队任务的「切换/取消」菜单
  // 初始化时优先用缓存：有缓存则不显示"加载中…"，后台再刷新
  const cachedOnMount = readTasksMemory();
  const hasCache = !!(cachedOnMount && Array.isArray(cachedOnMount.tasks));
  const [tasks, setTasks] = useState(hasCache ? cachedOnMount.tasks : []);
  const [taskGroups, setTaskGroups] = useState(hasCache ? (cachedOnMount.taskGroups || []) : []);
  const [loading, setLoading] = useState(!hasCache);
  const [quick, setQuick] = useState("");
  const quickRef = useRef(null);
  const [selectedGroupId, setSelectedGroupId] = useState("");
  const [draftGroup, setDraftGroup] = useState(null); // { id, name } before first task is saved
  const [groupEditor, setGroupEditor] = useState(null); // { mode: "new"|"rename", group? }
  const [batchOpen, setBatchOpen] = useState(false);
  const [batchText, setBatchText] = useState("");
  const [showActive, setShowActive] = useState(true);
  const [showDone, setShowDone] = useState(true);
  const [activeTab, setActiveTab] = useState(readTaskPanelActiveTab); // "todo" | "tbpool"，从缓存恢复
  const [detailId, setDetailId] = useState(null);
  const [syncing, setSyncing] = useState(false);
  const tbSyncInFlightRef = useRef(false);
  const taskPanelEventOriginRef = useRef(`task-panel-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  const [syncGuide, setSyncGuide] = useState(null); // 同步失败时的引导弹窗 { error, hint, needSetup }
  const [showTbTaskEntry, setShowTbTaskEntry] = useState(false);
  const [tbSearch, setTbSearch] = useState("");
  const [groupCollapsed, setGroupCollapsed] = useState({}); // 待办分组收起状态（默认展开）
  const isGroupOpen = (k) => !groupCollapsed[k];
  const toggleGroup = (k) => setGroupCollapsed((p) => ({ ...p, [k]: !p[k] }));
  const [candCollapsed, setCandCollapsed] = useState({}); // TB候选分组收起状态（默认展开）
  const isCandGroupOpen = (k) => !candCollapsed[k];
  const toggleCandGroup = (k) => setCandCollapsed((p) => ({ ...p, [k]: !p[k] }));
  const [candGroupMode, setCandGroupMode] = useState("sprint"); // TB候选分组方式：默认按迭代；bracket=按【】

  async function reload() {
    const [r, gr] = await Promise.all([
      devbenchApi.listTasks(),
      devbenchApi.listTaskGroups?.(),
    ]);
    if (r.ok) {
      setTasks(r.data || []);
      saveTasksMemory(r.data || [], gr?.ok ? (gr.data || []) : (taskGroups || []));
    }
    if (gr?.ok) setTaskGroups(gr.data || []);
    setLoading(false);
  }

  async function reloadAndNotify(detail = {}) {
    await reload();
    emitDevbenchTasksChanged({ ...detail, taskPanelOrigin: taskPanelEventOriginRef.current });
  }
  // 同步中关闭再重开时，旧实例完成后会发出变更事件；新实例据此刷新共享任务列表。
  // 忽略自己发出的事件，避免 reloadAndNotify 后重复加载。
  useEffect(() => {
    const onTasksChanged = (event) => {
      if (event?.detail?.taskPanelOrigin === taskPanelEventOriginRef.current) return;
      if (tbSyncInFlightRef.current) return;
      void reload();
    };
    window.addEventListener(DEVBENCH_TASKS_CHANGED_EVENT, onTasksChanged);
    return () => window.removeEventListener(DEVBENCH_TASKS_CHANGED_EVENT, onTasksChanged);
  }, []);
  // 持久化当前活跃 Tab，重开面板回到同一个 Tab
  useEffect(() => { saveTaskPanelActiveTab(activeTab); }, [activeTab]);
  // 打开面板时：先加载本地任务，再后台自动同步一次 TB（含迭代信息）。
  // 节流：距上次自动同步 < 2 分钟则跳过；未登录/失败静默（手动「同步TB单」才弹引导）。
  async function autoSyncTb() {
    if (tbSyncInFlightRef.current) return;
    // 必须在 await 前占位：开发态 StrictMode 会重跑 mount effect，若成功后才写时间戳，
    // 第二个请求会把首个请求刚新增的任务统计成“新增 0、更新 N”。
    const reservation = reserveTbAutoSync(localStorage);
    if (!reservation.acquired) return;
    tbSyncInFlightRef.current = true;
    setSyncing(true);
    try {
      const r = await devbenchApi.syncTbTasks();
      if (r.ok) {
        reservation.commit();
        await reloadAndNotify({ source: "auto-sync-tb", added: r.added || 0, updated: r.updated || 0, fetched: r.fetched || 0 });
        if ((r.added || 0) + (r.updated || 0) > 0) {
          onToast?.(`已自动同步 TB（${tbSyncCountSummary(r)}）`);
        }
      } else {
        // 未登录、未配置或网络失败不消耗节流时间，下一次打开仍可重试。
        reservation.rollback();
      }
    } catch {
      reservation.rollback();
    } finally {
      tbSyncInFlightRef.current = false;
      setSyncing(false);
    }
  }
  useEffect(() => { reload(); autoSyncTb(); }, []);

  // ===== 导入/导出（工程配置 + 任务列表，跨机/跨端同步）=====
  const fileRef = useRef(null);
  const [porting, setPorting] = useState(false);
  const [importPrompt, setImportPrompt] = useState(null); // { fileName, data }
  async function doExport() {
    setPorting(true);
    const r = await devbenchApi.exportSync();
    setPorting(false);
    if (!r.ok) { onToast?.(r.error || "导出失败"); return; }
    const blob = new Blob([JSON.stringify(r.data, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, "");
    a.href = url; a.download = `devbench-sync-${stamp}.json`;
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(url);
    onToast?.(`已导出 ${r.data.projects?.length || 0} 工程 · ${r.data.taskGroups?.length || 0} 任务组 · ${r.data.tasks?.length || 0} 任务`);
  }
  async function onPickImport(e) {
    const file = e.target.files?.[0];
    e.target.value = ""; // 允许重复选同一文件
    if (!file) return;
    let data;
    try { data = JSON.parse(await file.text()); } catch { onToast?.("文件不是有效的 JSON"); return; }
    if (!data || typeof data !== "object" || (!Array.isArray(data.projects) && !Array.isArray(data.tasks) && !Array.isArray(data.taskGroups))) {
      onToast?.("文件里没有工程/任务组/任务数据"); return;
    }
    setImportPrompt({ fileName: file.name, data });
  }
  async function runImport(mode) {
    const data = importPrompt?.data;
    setImportPrompt(null);
    if (!data) return;
    setPorting(true);
    const r = await devbenchApi.importSync(data, mode);
    setPorting(false);
    if (!r.ok) { onToast?.(r.error || "导入失败"); return; }
    await reloadAndNotify({ source: "import" });
    onToast?.(`导入完成（${mode === "replace" ? "替换" : "合并"}）：工程 +${r.projects.added}/改${r.projects.updated} · 任务组 +${r.taskGroups?.added || 0}/改${r.taskGroups?.updated || 0} · 任务 +${r.tasks.added}/改${r.tasks.updated}`);
  }

  // TB 单是"候选"（candidate），不是任务：有 tbTaskId 且未被"添加到任务"(staged 未显式置 false)即为候选。
  // 点「添加到任务」→ staged=false → 变成真正的待办任务。手敲的任务无 tbTaskId，天然是任务。
  const isCandidate = (t) => !!t.tbTaskId && t.staged !== false;
  const active = tasks.filter((t) => !t.done && !isCandidate(t))
    .sort((a, b) =>
      (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0)
      || (b.starred ? 1 : 0) - (a.starred ? 1 : 0)
      || prioRank(a.priority) - prioRank(b.priority)
      || (a.createdAt || 0) - (b.createdAt || 0));
  const done = tasks.filter((t) => t.done && !isCandidate(t)).sort((a, b) => (b.completedAt || 0) - (a.completedAt || 0));
  const candidateAll = tasks.filter((t) => !t.done && isCandidate(t));
  const candidates = candidateAll.filter((t) => matchesTbSearch(t, tbSearch))
    .sort((a, b) => prioRank(a.priority) - prioRank(b.priority) || byDeadlineAsc(a, b));
  const detail = tasks.find((t) => t.id === detailId) || null;

  const persistedGroupOptions = taskGroupOptionsFromTasks(tasks.filter((t) => !isCandidate(t)));
  const groupOptions = mergeTaskGroupOptions(taskGroups, persistedGroupOptions, draftGroup);
  const selectedGroup = groupOptions.find((g) => g.id === selectedGroupId) || null;

  // 待办任务按显式任务组优先分组；TB候选可切换"按【】 / 按迭代(到期排序)"
  const activeGroups = groupByTaskGroup(active, groupOptions);
  const candGroups = candGroupMode === "sprint" ? groupBySprint(candidates) : groupByBracket(candidates);
  // 仅当存在任务组/【】分组时才分组展示，否则保持平铺
  const useGrouping = activeGroups.some((g) => g.key !== UNGROUPED);
  // 迭代模式始终分组展示（已过滤未开始迭代）；【】模式仅当有带【】的分组时才分组
  const candUseGrouping = candGroupMode === "sprint" ? true : candGroups.some((g) => g.key !== UNGROUPED);
  // 当前分组方式下实际可见的候选数（迭代模式会过滤掉未开始迭代里的）
  const candShownCount = candGroups.reduce((n, g) => n + g.tasks.length, 0);
  // 一键收起/展开全部待办分组
  const allGroupsCollapsed = activeGroups.length > 0 && activeGroups.every((g) => groupCollapsed[g.key]);
  function toggleAllGroups() {
    if (allGroupsCollapsed) { setGroupCollapsed({}); return; } // 全部展开
    const next = {};
    for (const g of activeGroups) next[g.key] = true; // 全部收起
    setGroupCollapsed(next);
  }
  // 一键收起/展开全部 TB候选 分组（独立状态，避免与待办分组的同名【】键冲突）
  const allCandCollapsed = candGroups.length > 0 && candGroups.every((g) => candCollapsed[g.key]);
  function toggleAllCand() {
    if (allCandCollapsed) { setCandCollapsed({}); return; }
    const next = {};
    for (const g of candGroups) next[g.key] = true;
    setCandCollapsed(next);
  }

  function selectGroupForInput(group) {
    if (!group?.explicit) {
      setSelectedGroupId("");
      return;
    }
    const first = group.tasks?.[0] || {};
    const next = { id: group.id || first.taskGroupId, name: group.label };
    if (next.id && next.name) {
      setDraftGroup(next);
      setSelectedGroupId(next.id);
      setTimeout(() => quickRef.current?.focus?.(), 0);
    }
  }

  async function startNewGroup(name) {
    const nm = String(name || "").trim();
    if (!nm) return;
    const draft = { id: newTaskGroupId(), name: nm.slice(0, 60) };
    const r = await devbenchApi.createTaskGroup(draft);
    if (!r.ok) { onToast?.(r.error || "新建任务组失败"); return; }
    const group = r.group || draft;
    setTaskGroups((prev) => mergeTaskGroupOptions([group, ...prev], [], null));
    setDraftGroup(group);
    setSelectedGroupId(group.id);
    setGroupEditor(null);
    emitDevbenchTasksChanged({ source: "create-task-group", groupId: group.id });
    setTimeout(() => quickRef.current?.focus?.(), 0);
  }

  async function renameGroup(group, name) {
    const nm = String(name || "").trim().slice(0, 60);
    if (!group?.explicit || !nm) return;
    const groupId = group.id || group.tasks?.[0]?.taskGroupId;
    if (!groupId) return;
    const r = await devbenchApi.updateTaskGroup(groupId, { name: nm });
    if (!r.ok) { onToast?.(r.error || "重命名任务组失败"); return; }
    if (selectedGroupId === groupId) setDraftGroup({ id: groupId, name: nm });
    await reloadAndNotify({ source: "rename-task-group", groupId });
    setGroupEditor(null);
  }

  async function ungroup(group) {
    if (!group?.explicit) return;
    if (!confirm(`解散任务组「${group.label}」？组内任务会保留，只是移到未分组。`)) return;
    const groupId = group.id || group.tasks?.[0]?.taskGroupId;
    if (!groupId) return;
    const r = await devbenchApi.deleteTaskGroup(groupId, true);
    if (!r.ok) { onToast?.(r.error || "解散任务组失败"); return; }
    if (selectedGroupId === groupId) setSelectedGroupId("");
    if (draftGroup?.id === groupId) setDraftGroup(null);
    await reloadAndNotify({ source: "ungroup-task-group", groupId });
  }

  async function addQuick() {
    const t = quick.trim();
    if (!t) return;
    const r = await devbenchApi.createTask({ title: t, ...taskGroupPayload(selectedGroup) });
    if (r.ok) { setQuick(""); await reloadAndNotify({ source: "create-task" }); } else onToast?.(r.error || "新增失败");
  }
  async function addBatch() {
    if (!batchText.trim()) { onToast?.("请输入任务内容"); return; }
    const r = await devbenchApi.createTasksBatch(batchText, taskGroupPayload(selectedGroup)); // 原始文本，后端智能解析优先级/序号/期限
    if (r.ok) { setBatchText(""); setBatchOpen(false); await reloadAndNotify({ source: "create-tasks-batch" }); onToast?.(`已新增 ${r.tasks?.length || 0} 个任务`); }
    else onToast?.(r.error || "批量新增失败");
  }
  async function addTbTodo(input) {
    const r = await devbenchApi.importTbTask(input, taskGroupPayload(selectedGroup));
    if (!r.ok) return r;
    await reloadAndNotify({ source: "import-tb-task", taskId: r.task?.id, tbTaskId: r.task?.tbTaskId });
    const action = r.reactivated
      ? "已重新打开为待办"
      : r.promoted
        ? "已从 TB 候选移入待办"
        : r.already
          ? "已在待办列表中"
          : "已新增到待办";
    onToast?.(`${r.task?.carbId ? `${r.task.carbId} · ` : ""}${action}：${r.task?.title || "TB 工单"}`);
    return { ok: true };
  }
  async function syncTb() {
    if (syncing || tbSyncInFlightRef.current) return;
    tbSyncInFlightRef.current = true;
    setSyncing(true);
    try {
      const r = await devbenchApi.syncTbTasks();
      if (r.ok) {
        localStorage.setItem(TB_AUTO_SYNC_AT_KEY, String(Date.now()));
        await reloadAndNotify({ source: "sync-tb", added: r.added || 0, updated: r.updated || 0, fetched: r.fetched || 0 });
        setSyncGuide(null);
        onToast?.(`已同步 TB 工单：${tbSyncCountSummary(r)}` + (r.statusResolved ? "" : "（按未完成任务同步）"));
      } else {
        // 失败不再用一闪而过的 toast（且会被遮罩挡住）：弹出可操作的引导，区分"未配置/未登录"
        setSyncGuide({ error: r.error || "同步失败", hint: r.hint || "", needSetup: !!r.needSetup });
      }
    } catch (error) {
      setSyncGuide({ error: error?.message || "同步失败", hint: "", needSetup: false });
    } finally {
      tbSyncInFlightRef.current = false;
      setSyncing(false);
    }
  }
  async function toggleDone(task) {
    const target = !task.done;
    // 乐观更新，失败回滚
    setTasks((prev) => prev.map((t) => t.id === task.id
      ? { ...t, done: target, completedAt: target ? Date.now() : null } : t));
    const r = await devbenchApi.updateTask(task.id, { done: target });
    if (!r.ok) {
      reload(); // 回滚乐观更新（TB 工单状态校验未通过等）
      // TB 工单状态仍在「待处理/开发中/进行中」→ 弹窗提醒用户
      if (r.blocked) alert(r.error || "该 TB 工单当前状态不允许标记完成。");
      else if (r.error) onToast?.(r.error);
    } else {
      emitDevbenchTasksChanged({ source: "update-task", taskId: task.id });
    }
  }
  async function toggleStar(task) {
    if (!task || isCandidate(task)) return;
    const target = !task.starred;
    setTasks((prev) => prev.map((t) => t.id === task.id ? { ...t, starred: target || undefined } : t));
    const r = await devbenchApi.updateTask(task.id, { starred: target });
    if (!r.ok) {
      reload();
      if (r.error) onToast?.(r.error);
    } else {
      emitDevbenchTasksChanged({ source: "update-task", taskId: task.id, starred: target });
    }
  }
  async function togglePin(task) {
    if (!task || isCandidate(task)) return;
    const target = !task.pinned;
    setTasks((prev) => prev.map((t) => t.id === task.id ? { ...t, pinned: target || undefined } : t));
    const r = await devbenchApi.updateTask(task.id, { pinned: target });
    if (!r.ok) {
      reload();
      if (r.error) onToast?.(r.error);
    } else {
      emitDevbenchTasksChanged({ source: "update-task", taskId: task.id, pinned: target });
    }
  }
  async function saveDetail(id, updates) {
    const r = await devbenchApi.updateTask(id, updates);
    if (r.ok) await reloadAndNotify({ source: "update-task", taskId: id }); else onToast?.(r.error || "保存失败");
    return r;
  }
  async function removeTask(id) {
    await devbenchApi.deleteTask(id);
    if (detailId === id) setDetailId(null);
    await reloadAndNotify({ source: "delete-task", taskId: id });
  }
  // 把「TB工单」区的某条加入待办清单（staged=false）
  async function promote(task) {
    const r = await devbenchApi.updateTask(task.id, { staged: false });
    if (r.ok) { await reloadAndNotify({ source: "promote-tb-task", taskId: task.id }); onToast?.(`已加入任务列表：${task.title}`); }
    else onToast?.(r.error || "加入失败");
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={onClose}>
      <div
        className="w-[920px] max-w-[94vw] max-h-[82vh] flex flex-col bg-zinc-900 border border-zinc-700 rounded-xl shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* 顶部栏：标题 + Tab 切换 + 关闭 */}
        <div className="shrink-0 px-4 py-2.5 border-b border-zinc-800 flex items-center gap-3">
          <span className="text-sm font-semibold text-zinc-100">任务列表</span>
          <div className="flex items-center gap-1 bg-zinc-800/60 rounded-lg p-0.5 border border-zinc-700/60">
            {TASK_PANEL_TABS.map((tab) => (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className={`text-[11px] px-2.5 py-1 rounded-md transition ${activeTab === tab.id ? TASK_TAB_ACTIVE_CLASS[tab.id] : "border border-transparent text-zinc-400 hover:text-zinc-100"}`}
                title={tab.title}
              >
                {tab.label} <span className="text-[10px] opacity-80">({tab.id === "todo" ? active.length : candidateAll.length})</span>
              </button>
            ))}
          </div>
          <div className="ml-auto flex items-center gap-2">
            <span className="text-[11px] text-zinc-500">{active.length} 待办 · {done.length} 已完成 · {candidateAll.length} TB候选</span>
            <button onClick={onClose} className="text-zinc-500 hover:text-zinc-200 text-sm px-1">✕</button>
          </div>
        </div>

        {/* === 待办列表 Tab：操作按钮 + 快速新增 / 批量新增 === */}
        {activeTab === "todo" && (
        <div className="shrink-0 px-4 py-2 border-b border-zinc-800 space-y-2">
          {/* 操作按钮行（仅属于待办列表 Tab） */}
          <div className="flex items-center gap-2 flex-wrap">
            <button
              onClick={syncTb}
              disabled={syncing}
              className="text-[11px] px-2 py-1 rounded border bg-cyan-700/30 border-cyan-700/50 text-cyan-200 hover:bg-cyan-600/40 disabled:opacity-60 transition"
              title="从 Teambition 同步「待处理/开发中/进行中」的工单到任务列表"
            >{syncing ? "同步中…" : "⤵ 同步TB单"}</button>
            <button
              onClick={() => setShowTbTaskEntry(true)}
              className="text-[11px] px-2 py-1 rounded border bg-violet-700/25 border-violet-600/45 text-violet-200 hover:bg-violet-600/40 hover:border-violet-500/60 transition"
              title="输入 TB 单号或任务链接，直接新增为待办任务"
              data-testid="task-panel-add-from-tb"
            >＋ 从TB新增</button>
            <button
              onClick={doExport}
              disabled={porting}
              className="text-[11px] px-2 py-1 rounded border bg-zinc-800 border-zinc-700 text-zinc-300 hover:text-white hover:bg-zinc-700 disabled:opacity-60 transition"
              title="导出工程配置 + 任务列表为文件（用于跨机/跨项目/desktop↔web 同步）"
            >⤓ 导出</button>
            <button
              onClick={() => fileRef.current?.click()}
              disabled={porting}
              className="text-[11px] px-2 py-1 rounded border bg-zinc-800 border-zinc-700 text-zinc-300 hover:text-white hover:bg-zinc-700 disabled:opacity-60 transition"
              title="从文件导入工程配置 + 任务列表"
            >⤒ 导入</button>
            <input ref={fileRef} type="file" accept="application/json,.json" className="hidden" onChange={onPickImport} />
            <button
              onClick={() => { setBatchOpen((v) => !v); }}
              className={`text-[11px] px-2 py-1 rounded border transition ${
                batchOpen ? "bg-blue-600 border-blue-500 text-white" : "bg-zinc-800 border-zinc-700 text-zinc-300 hover:text-white hover:bg-zinc-700"
              }`}
            >批量新增</button>
            {candidateAll.length > 0 && (
              <button
                onClick={() => setActiveTab("tbpool")}
                className="text-[11px] px-2 py-1 rounded border bg-zinc-800 border-zinc-700 text-zinc-400 hover:text-cyan-200 hover:border-cyan-700/50 transition"
                title={`查看 ${candidateAll.length} 条 TB 单候选`}
              >📋 TB单候选 ({candidateAll.length}) ›</button>
            )}
          </div>
          <div className="flex items-center gap-2 overflow-x-auto pb-0.5">
            <span className="shrink-0 text-[11px] text-zinc-500">新增到</span>
            <button
              onClick={() => setSelectedGroupId("")}
              className={`shrink-0 text-[11px] px-2 py-1 rounded-full border transition ${!selectedGroup ? "bg-blue-600/25 border-blue-500/50 text-blue-100" : "bg-zinc-800 border-zinc-700 text-zinc-400 hover:text-zinc-100"}`}
            >未分组</button>
            {groupOptions.map((g) => (
              <button
                key={g.id}
                onClick={() => setSelectedGroupId(g.id)}
                className={`shrink-0 text-[11px] px-2 py-1 rounded-full border transition ${selectedGroupId === g.id ? "bg-violet-600/30 border-violet-500/60 text-violet-100" : "bg-zinc-800 border-zinc-700 text-zinc-400 hover:text-zinc-100"}`}
                title={`后续新增任务会进入「${g.name}」`}
              >{g.name}</button>
            ))}
            <button
              onClick={() => setGroupEditor({ mode: "new" })}
              className="shrink-0 text-[11px] px-2 py-1 rounded-full border border-dashed border-zinc-600 text-zinc-400 hover:border-violet-500/70 hover:text-violet-200 transition"
            >＋ 新建任务组</button>
          </div>
          {batchOpen ? (
            <div className="space-y-2">
              <textarea
                value={batchText}
                onChange={(e) => setBatchText(e.target.value)}
                placeholder={"粘贴任务清单，自动识别优先级 / 序号 / 期限，例如：\nP0：\n1、阿维塔性能优化\n2、F515R 的 license 提测包（今天给）\nP1：\n3、走行接口 SDK 调整（下周一完成）"}
                rows={6}
                className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-zinc-100 placeholder-zinc-600 outline-none focus:border-zinc-500 resize-none whitespace-pre"
              />
              <div className="flex items-center gap-2">
                <button onClick={addBatch} className="px-3 py-1.5 text-xs rounded-lg bg-blue-600 hover:bg-blue-500 text-white transition">添加全部</button>
                <button onClick={() => { setBatchOpen(false); setBatchText(""); }} className="px-3 py-1.5 text-xs rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-300 transition">取消</button>
                <span className="text-[10px] text-zinc-600">支持 P0/P1/P2 分组头、行首序号、行尾（期限）自动解析</span>
              </div>
            </div>
          ) : (
            <div className="flex items-center gap-2">
              <span className="text-zinc-500 text-lg leading-none">＋</span>
              <input
                ref={quickRef}
                value={quick}
                onChange={(e) => setQuick(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addQuick(); } }}
                placeholder={selectedGroup ? `添加到「${selectedGroup.name}」，回车新增…` : "添加任务，回车新增…"}
                className="flex-1 bg-transparent text-sm text-zinc-100 placeholder-zinc-600 outline-none py-1"
              />
              {quick.trim() && (
                <button onClick={addQuick} className="px-2 py-1 text-[11px] rounded bg-blue-600 hover:bg-blue-500 text-white transition">新增</button>
              )}
            </div>
          )}
        </div>
        )}

        {/* === TB单列表 Tab：搜索 + 分组方式切换 === */}
        {activeTab === "tbpool" && (
        <div className="shrink-0 px-4 py-2 border-b border-zinc-800">
          <div className="flex items-center gap-2 flex-wrap">
            <div className="flex items-center gap-1 bg-zinc-900 border border-zinc-800 rounded-lg px-2 py-1">
              <span className="text-[10px] text-zinc-600">⌕</span>
              <input
                value={tbSearch}
                onChange={(e) => setTbSearch(e.target.value)}
                placeholder="搜索 TB 单"
                className="w-[180px] bg-transparent text-[11px] text-zinc-200 placeholder-zinc-600 outline-none"
              />
              {tbSearch && (
                <button
                  onClick={() => setTbSearch("")}
                  className="text-[10px] text-zinc-600 hover:text-zinc-200"
                  title="清空搜索"
                >✕</button>
              )}
            </div>
            <div className="flex items-center gap-0.5" title="切换分组方式">
              <button
                onClick={() => setCandGroupMode("sprint")}
                className={`text-[10px] px-1.5 py-0.5 rounded transition ${candGroupMode === "sprint" ? "bg-zinc-700 text-zinc-100" : "text-zinc-500 hover:text-zinc-200 hover:bg-zinc-800"}`}
                title="按 TB 迭代版本分组，组内按剩余天数（到期日）排序，越临近到期越靠前；未开始的迭代不显示"
              >迭代分组</button>
              <button
                onClick={() => setCandGroupMode("bracket")}
                className={`text-[10px] px-1.5 py-0.5 rounded transition ${candGroupMode === "bracket" ? "bg-zinc-700 text-zinc-100" : "text-zinc-500 hover:text-zinc-200 hover:bg-zinc-800"}`}
              >【】分组</button>
            </div>
            {candUseGrouping && candGroups.length > 1 && (
              <button
                onClick={toggleAllCand}
                className="text-[10px] text-zinc-500 hover:text-zinc-200 px-1.5 py-0.5 rounded hover:bg-zinc-800 transition"
                title={allCandCollapsed ? "展开全部分组" : "收起全部分组"}
              >{allCandCollapsed ? "▸ 展开全部" : "▾ 收起全部"}</button>
            )}
            <span className="ml-auto text-[11px] text-zinc-500">
              {tbSearch.trim() ? `${candShownCount}/${candidateAll.length} 匹配` : `${candidateAll.length} 条候选`}
            </span>
          </div>
        </div>
        )}

        {/* 列表 */}
        <div className="flex-1 overflow-y-auto px-2 py-2">
          {loading ? (
            <div className="text-center text-zinc-600 text-xs py-8">加载中…</div>
          ) : activeTab === "todo" ? (
            (tasks.length === 0 && groupOptions.length === 0) ? (
              <div className="text-center text-zinc-600 text-xs py-8">还没有任务，在上方添加一条吧</div>
            ) : (
              <>
                {/* 未完成（按标题第一个【】分组，每组可展开收起） */}
                <div className="flex items-center">
                  <SectionHeader label="待办" count={active.length} open={showActive} onToggle={() => setShowActive((v) => !v)} className="flex-1" />
                  {showActive && useGrouping && activeGroups.length > 1 && (
                    <button
                      onClick={toggleAllGroups}
                      className="shrink-0 mr-2 text-[10px] text-zinc-500 hover:text-zinc-200 px-1.5 py-0.5 rounded hover:bg-zinc-800 transition"
                      title={allGroupsCollapsed ? "展开全部分组" : "收起全部分组"}
                    >{allGroupsCollapsed ? "▸ 展开全部" : "▾ 收起全部"}</button>
                  )}
                </div>
                {showActive && (useGrouping
                  ? activeGroups.map((g) => (
                      <div key={g.key} className={g.explicit ? "my-2 rounded-xl border border-violet-900/45 bg-violet-950/10 overflow-hidden" : ""}>
                        <TaskGroupHeader
                          group={g}
                          open={isGroupOpen(g.key)}
                          onToggle={() => toggleGroup(g.key)}
                          onAdd={() => selectGroupForInput(g)}
                          onRename={() => setGroupEditor({ mode: "rename", group: g })}
                          onUngroup={() => ungroup(g)}
                          onStartGroupDev={onStartGroupDev}
                        />
                        {isGroupOpen(g.key) && g.tasks.map((t) => (
                          <TaskRow key={t.id} task={t} indent onToggle={() => toggleDone(t)} onTogglePin={() => togglePin(t)} onToggleStar={() => toggleStar(t)} onOpen={() => setDetailId(t.id)} onStartDev={onStartDev} onTeamDev={onTeamDev} openTabs={openTabs} onGroupMenu={setGroupMenuTask} />
                        ))}
                        {isGroupOpen(g.key) && g.explicit && g.tasks.length === 0 && (
                          <button
                            onClick={() => selectGroupForInput(g)}
                            className="w-full text-left px-10 py-3 text-[11px] text-zinc-500 hover:text-violet-200 hover:bg-violet-950/20 transition"
                          >
                            空任务组，点击后在上方输入框添加任务
                          </button>
                        )}
                      </div>
                    ))
                  : active.map((t) => (
                      <TaskRow key={t.id} task={t} onToggle={() => toggleDone(t)} onTogglePin={() => togglePin(t)} onToggleStar={() => toggleStar(t)} onOpen={() => setDetailId(t.id)} onStartDev={onStartDev} onTeamDev={onTeamDev} openTabs={openTabs} onGroupMenu={setGroupMenuTask} />
                    ))
                )}
                {showActive && active.length === 0 && groupOptions.length === 0 && (
                  <div className="px-3 py-2 text-[11px] text-zinc-600">没有待办任务 🎉</div>
                )}

                {/* 已完成 */}
                {done.length > 0 && (
                  <>
                    <SectionHeader label="已完成" count={done.length} open={showDone} onToggle={() => setShowDone((v) => !v)} className="mt-2" />
                    {showDone && done.map((t) => (
                      <TaskRow key={t.id} task={t} onToggle={() => toggleDone(t)} onTogglePin={() => togglePin(t)} onToggleStar={() => toggleStar(t)} onOpen={() => setDetailId(t.id)} />
                    ))}
                  </>
                )}
              </>
            )
          ) : (
            /* === TB单列表 Tab：TB 单候选区 === */
            <>
              {candidateAll.length === 0 ? (
                <div className="text-center text-zinc-600 text-xs py-10 leading-relaxed">
                  <div className="text-zinc-500 mb-2">还没有 TB 单候选</div>
                  <div className="text-[11px]">切到「待办列表」点「⤵ 同步TB单」从 Teambition 拉取工单，或点「＋ 从TB新增」按单号添加。</div>
                </div>
              ) : candUseGrouping ? (
                candGroups.map((g) => (
                  <div key={g.key}>
                    <GroupHeader label={g.label} count={g.tasks.length} open={isCandGroupOpen(g.key)} onToggle={() => toggleCandGroup(g.key)} isOther={g.key === UNGROUPED || g.key === NO_SPRINT} bracket={candGroupMode === "bracket"}
                      suffix={candGroupMode === "sprint" && g.key !== NO_SPRINT ? <SprintDueBadge due={g.sprintDue} /> : null} />
                    {isCandGroupOpen(g.key) && g.tasks.map((t) => (
                      <TbPoolRow key={t.id} task={t} indent onAdd={() => promote(t)} onOpen={() => setDetailId(t.id)} />
                    ))}
                  </div>
                ))
              ) : (
                candidates.map((t) => (
                  <TbPoolRow key={t.id} task={t} onAdd={() => promote(t)} onOpen={() => setDetailId(t.id)} />
                ))
              )}
              {candGroupMode === "sprint" && candGroups.length === 0 && candidateAll.length > 0 && (
                <div className="px-3 py-2 text-[11px] text-zinc-600">{tbSearch.trim() ? "没有匹配的 TB 单候选" : "候选 TB 单都在未开始的迭代里（已隐藏），可切到「【】分组」查看"}</div>
              )}
            </>
          )}
        </div>
      </div>

      {/* 任务详情 */}
      {showTbTaskEntry && (
        <TbTaskEntryModal
          mode="task"
          onClose={() => setShowTbTaskEntry(false)}
          onSubmit={addTbTodo}
        />
      )}

      {detail && (
        <TaskDetail
          key={detail.id}
          task={detail}
          groupOptions={groupOptions}
          onClose={() => setDetailId(null)}
          onToggle={() => toggleDone(detail)}
          onSave={(updates) => saveDetail(detail.id, updates)}
          onDelete={() => removeTask(detail.id)}
          onPromote={() => { promote(detail); setDetailId(null); }}
        />
      )}

      {/* TB 同步失败引导（未配置 / 未扫码登录 → 引导完成后重新获取） */}
      {syncGuide && (
        <TbSyncGuide
          guide={syncGuide}
          syncing={syncing}
          onClose={() => setSyncGuide(null)}
          onRetry={syncTb}
          onToast={onToast}
        />
      )}

      {/* 导入模式选择：合并 / 替换 */}
      {importPrompt && (
        <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/50" onClick={() => setImportPrompt(null)}>
          <div className="w-[440px] max-w-[92vw] bg-zinc-900 border border-zinc-700 rounded-xl shadow-2xl" onClick={(e) => e.stopPropagation()}>
            <div className="px-4 py-3 border-b border-zinc-800 text-sm font-semibold text-zinc-100">导入同步包</div>
            <div className="px-4 py-4 text-sm text-zinc-300 leading-relaxed space-y-2">
              <div className="text-[12px] text-zinc-400 font-mono truncate" title={importPrompt.fileName}>📄 {importPrompt.fileName}</div>
              <div className="text-[12px]">
                工程 <span className="text-zinc-100 font-medium">{importPrompt.data.projects?.length || 0}</span> 个 ·
                任务组 <span className="text-zinc-100 font-medium">{importPrompt.data.taskGroups?.length || 0}</span> 个 ·
                任务 <span className="text-zinc-100 font-medium">{importPrompt.data.tasks?.length || 0}</span> 条
                {importPrompt.data.exportedAt ? <span className="text-zinc-600"> · 导出于 {String(importPrompt.data.exportedAt).slice(0, 10)}</span> : null}
              </div>
              <div className="text-[11px] text-zinc-500 leading-relaxed pt-1">
                <strong className="text-zinc-300">合并</strong>：保留本地，按工程路径/任务单号增量补充与更新（推荐）。<br />
                <strong className="text-zinc-300">替换</strong>：用文件内容整表覆盖本地工程与任务。
              </div>
            </div>
            <div className="px-4 py-3 border-t border-zinc-800 flex items-center justify-end gap-2">
              <button onClick={() => setImportPrompt(null)} className="px-3 py-1.5 text-xs rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-300 transition">取消</button>
              <button onClick={() => runImport("replace")} className="px-3 py-1.5 text-xs rounded-lg bg-red-600/80 hover:bg-red-500 text-white transition">整表替换</button>
              <button onClick={() => runImport("merge")} className="px-3 py-1.5 text-xs rounded-lg bg-blue-600 hover:bg-blue-500 text-white transition">合并导入</button>
            </div>
          </div>
        </div>
      )}

      {groupEditor && (
        <TaskGroupEditor
          mode={groupEditor.mode}
          initialName={groupEditor.group?.label || ""}
          onClose={() => setGroupEditor(null)}
          onSubmit={(name) => {
            if (groupEditor.mode === "rename") renameGroup(groupEditor.group, name);
            else startNewGroup(name);
          }}
        />
      )}

      {/* 已组队任务的「切换组队 / 取消组队」菜单 */}
      {groupMenuTask && (
        <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/50" onClick={() => setGroupMenuTask(null)}>
          <div className="w-[360px] max-w-[92vw] bg-zinc-900 border border-zinc-700 rounded-xl shadow-2xl" onClick={(e) => e.stopPropagation()}>
            <div className="px-4 py-3 border-b border-zinc-800 text-sm font-semibold text-zinc-100 truncate">👥 已组队 · {groupMenuTask.title}</div>
            <div className="px-4 py-3 space-y-2">
              <button onClick={() => { const t = groupMenuTask; setGroupMenuTask(null); onTeamDev?.(t); }}
                className="w-full text-left px-3 py-2 text-[12px] rounded-lg bg-violet-600/20 border border-violet-600/40 text-violet-200 hover:bg-violet-600/30 transition">
                🔁 切换组队<span className="text-[10px] text-zinc-400 ml-1">（移出当前组，改与另一个故事点共用配置）</span>
              </button>
              <button onClick={() => { const t = groupMenuTask; setGroupMenuTask(null); onCancelTeam?.(t); }}
                className="w-full text-left px-3 py-2 text-[12px] rounded-lg bg-zinc-800 border border-zinc-700 text-zinc-300 hover:bg-red-600/20 hover:text-red-300 transition">
                ✕ 取消组队<span className="text-[10px] text-zinc-500 ml-1">（退出组，工程配置保留，恢复独立开发）</span>
              </button>
            </div>
            <div className="px-4 py-2.5 border-t border-zinc-800 flex justify-end">
              <button onClick={() => setGroupMenuTask(null)} className="px-3 py-1.5 text-xs rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-300">关闭</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// TB 工单同步引导弹窗：识别未配置/未登录，内置一键扫码登录（WS 驱动），成功后自动重新获取
function TbSyncGuide({ guide, syncing, onClose, onRetry, onToast }) {
  const [loginState, setLoginState] = useState(null); // { status, message, user }
  const loginChallengeRef = useRef("");
  const onRetryRef = useRef(onRetry);
  const onToastRef = useRef(onToast);
  const retriedAfterLoginRef = useRef(false);
  onRetryRef.current = onRetry;
  onToastRef.current = onToast;

  // 监听扫码登录状态；成功后后端已回填 operatorId/executorId，自动触发一次重新获取
  useEffect(() => {
    const ws = createGatewayWebSocket();
    function onMsg(e) {
      try {
        const msg = JSON.parse(e.data);
        if (msg.type === "tb_login_status") {
          setLoginState(msg.data);
          if (msg.data.status === "success") {
            if (retriedAfterLoginRef.current) return;
            retriedAfterLoginRef.current = true;
            onToastRef.current?.("登录成功，正在重新获取 TB 工单…");
            onRetryRef.current?.();
          }
        }
      } catch {}
    }
    ws.addEventListener("message", onMsg);
    return () => { try { ws.removeEventListener("message", onMsg); ws.close(); } catch {} };
  }, []);

  async function handleLogin() {
    retriedAfterLoginRef.current = false;
    setLoginState({ status: "launching", message: "正在启动浏览器，请在弹出的窗口中扫码登录 Teambition…" });
    try {
      const result = await startTbTasksLogin();
      if (!result.success) {
        setLoginState({ status: "failed", message: result.error || "启动登录失败" });
        return;
      }
      loginChallengeRef.current = result.loginChallenge || "";
      if (result.mode === "remote") {
        setLoginState({ status: "waiting", message: result.message || "已打开远程扫码页面，请在弹出窗口中完成登录" });
      }
    } catch (err) {
      setLoginState({ status: "failed", message: err.message });
    }
  }
  async function handleCancel() {
    const loginChallenge = loginChallengeRef.current;
    loginChallengeRef.current = "";
    try {
      await fetch(getApiUrl("/api/tb-tasks/login/cancel"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ loginChallenge }),
      });
    } catch {}
    setLoginState(null);
  }

  const isLogging = loginState && ["launching", "waiting"].includes(loginState.status);

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60" onClick={(e) => { e.stopPropagation(); onClose(); }}>
      <div className="w-[460px] max-w-[92vw] bg-zinc-900 border border-zinc-700 rounded-xl shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="px-4 py-3 border-b border-zinc-800 flex items-center gap-2">
          <span className="text-sm font-semibold text-amber-300">⚠ 暂时无法同步 TB 工单</span>
          <button onClick={onClose} className="ml-auto text-zinc-500 hover:text-zinc-200 text-sm px-1">✕</button>
        </div>
        <div className="px-4 py-4 space-y-3 text-sm">
          <p className="text-zinc-200">{guide.error}</p>
          {guide.hint && <p className="text-[12px] text-zinc-400 leading-relaxed">{guide.hint}</p>}

          {guide.needSetup && (
            <ol className="list-decimal list-inside text-[12px] text-zinc-400 space-y-1 bg-zinc-950/50 border border-zinc-800 rounded-lg px-3 py-2">
              <li>点「一键扫码登录」，会弹出浏览器窗口</li>
              <li>用钉钉/手机扫码授权登录 Teambition</li>
              <li>登录成功后会<strong className="text-zinc-300">自动重新获取</strong>；如未触发可手动点「重新获取」</li>
            </ol>
          )}

          <div className="flex items-center gap-2 flex-wrap pt-1">
            {guide.needSetup && (
              <>
                <button onClick={handleLogin} disabled={isLogging || syncing}
                  className="px-3 py-1.5 text-xs rounded-lg bg-blue-600 hover:bg-blue-500 disabled:bg-zinc-700 disabled:text-zinc-500 text-white transition">
                  {isLogging ? "等待扫码登录…" : "🔑 一键扫码登录"}
                </button>
                {isLogging && (
                  <button onClick={handleCancel}
                    className="px-2 py-1.5 text-xs rounded-lg text-zinc-400 hover:text-red-400 transition">取消登录</button>
                )}
              </>
            )}
            <button onClick={onRetry} disabled={syncing || isLogging}
              className="px-3 py-1.5 text-xs rounded-lg bg-cyan-700/30 border border-cyan-700/50 text-cyan-200 hover:bg-cyan-600/40 disabled:opacity-60 transition">
              {syncing ? "重新获取中…" : (guide.needSetup ? "↻ 我已完成，重新获取" : "↻ 重试")}
            </button>
            <button onClick={onClose} className="px-3 py-1.5 text-xs rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-300 transition">关闭</button>
          </div>

          {loginState && (
            <p className={`text-[12px] ${
              loginState.status === "success" ? "text-green-400"
                : (loginState.status === "failed" || loginState.status === "timeout") ? "text-red-400"
                : "text-amber-400"
            }`}>{loginState.message}</p>
          )}
        </div>
      </div>
    </div>
  );
}

function SectionHeader({ label, count, open, onToggle, className = "" }) {
  return (
    <button
      onClick={onToggle}
      className={`w-full flex items-center gap-1.5 px-2 py-1 text-[11px] text-zinc-500 hover:text-zinc-300 transition ${className}`}
    >
      <span className={`transition-transform ${open ? "rotate-90" : ""}`}>▸</span>
      <span className="font-medium">{label}</span>
      <span className="text-zinc-600">{count}</span>
    </button>
  );
}

function TaskGroupHeader({ group, open, onToggle, onAdd, onRename, onUngroup, onStartGroupDev }) {
  if (!group?.explicit) {
    return (
      <GroupHeader
        label={group?.label || "未分组"}
        count={group?.tasks?.length || 0}
        open={open}
        onToggle={onToggle}
        isOther={group?.key === UNGROUPED}
        bracket={group?.bracket}
      />
    );
  }
  const tasks = group.tasks || [];
  const linkedCount = tasks.filter((t) => t.tabId).length;
  const label = linkedCount > 0 ? "再次开发" : "执行开发";
  return (
    <div className="px-3 py-2 bg-gradient-to-r from-violet-950/45 via-zinc-900/60 to-zinc-900/20 border-b border-violet-900/35">
      <div className="flex items-center gap-2 min-w-0">
        <button
          onClick={onToggle}
          className="shrink-0 w-6 h-6 rounded-md border border-violet-800/50 bg-violet-950/40 text-violet-200 hover:bg-violet-900/50 transition"
          title={open ? "收起任务组" : "展开任务组"}
        >
          <span className={`inline-block text-[11px] transition-transform ${open ? "rotate-90" : ""}`}>▸</span>
        </button>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 min-w-0">
            <span className="text-[13px] font-semibold text-zinc-100 truncate">{group.label}</span>
            <span className="shrink-0 text-[10px] px-1.5 py-0.5 rounded-full bg-violet-600/25 text-violet-200 border border-violet-600/35">{tasks.length} 项</span>
            {linkedCount > 0 && <span className="shrink-0 text-[10px] px-1.5 py-0.5 rounded-full bg-emerald-600/20 text-emerald-200 border border-emerald-600/35">{linkedCount} 个故事点</span>}
          </div>
          <div className="text-[10px] text-zinc-500 mt-0.5 truncate">组内任务会创建或重新打开为同一个故事点组，按队列串行开发</div>
        </div>
        {onStartGroupDev && (
          <button
            onClick={(e) => { e.stopPropagation(); onStartGroupDev(group); }}
            disabled={tasks.length === 0}
            className="shrink-0 text-[11px] px-2.5 py-1.5 rounded-lg bg-blue-600/25 border border-blue-500/45 text-blue-100 hover:bg-blue-600/35 disabled:opacity-45 disabled:hover:bg-blue-600/25 disabled:cursor-not-allowed transition"
            title="创建或重新打开组内任务对应的故事点组"
          >▶ {label}</button>
        )}
        <button
          onClick={(e) => { e.stopPropagation(); onAdd?.(); }}
          className="shrink-0 text-[11px] px-2 py-1.5 rounded-lg bg-zinc-800/80 border border-zinc-700 text-zinc-300 hover:text-white hover:bg-zinc-700 transition"
          title="在该任务组内继续添加待办"
        >＋</button>
        <button
          onClick={(e) => { e.stopPropagation(); onRename?.(); }}
          className="shrink-0 text-[11px] px-2 py-1.5 rounded-lg bg-zinc-800/80 border border-zinc-700 text-zinc-400 hover:text-zinc-100 transition"
          title="重命名任务组"
        >改名</button>
        <button
          onClick={(e) => { e.stopPropagation(); onUngroup?.(); }}
          className="shrink-0 text-[11px] px-2 py-1.5 rounded-lg text-zinc-500 hover:text-red-300 hover:bg-red-950/25 transition"
          title="解散任务组，任务保留"
        >解散</button>
      </div>
    </div>
  );
}

function TaskGroupEditor({ mode, initialName = "", onClose, onSubmit }) {
  const [name, setName] = useState(initialName);
  const nm = name.trim();
  const isRename = mode === "rename";
  function submit() {
    if (!nm) return;
    onSubmit?.(nm);
  }
  return (
    <div className="fixed inset-0 z-[85] flex items-center justify-center bg-black/55" onClick={onClose}>
      <div
        className="w-[420px] max-w-[92vw] bg-zinc-900 border border-zinc-700 rounded-xl shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-4 py-3 border-b border-zinc-800 flex items-center gap-2">
          <span className="text-sm font-semibold text-zinc-100">{isRename ? "重命名任务组" : "新建任务组"}</span>
          <button onClick={onClose} className="ml-auto text-zinc-500 hover:text-zinc-200 text-sm px-1">✕</button>
        </div>
        <div className="px-4 py-4 space-y-3">
          <input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); submit(); } }}
            maxLength={60}
            placeholder="例如：应用市场登录链路修复"
            className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-zinc-100 placeholder-zinc-600 outline-none focus:border-violet-500/70"
          />
          <div className="text-[11px] text-zinc-500 leading-relaxed">
            任务组会把组内待办创建或恢复为同一个故事点组；首次执行时使用组锚的工程、设备、flavor 等配置，组内故事点共享这套配置。
          </div>
        </div>
        <div className="px-4 py-3 border-t border-zinc-800 flex items-center justify-end gap-2">
          <button onClick={onClose} className="px-3 py-1.5 text-xs rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-300 transition">取消</button>
          <button
            onClick={submit}
            disabled={!nm}
            className="px-3 py-1.5 text-xs rounded-lg bg-violet-600 hover:bg-violet-500 disabled:bg-zinc-700 disabled:text-zinc-500 text-white transition"
          >{isRename ? "保存名称" : "创建任务组"}</button>
        </div>
      </div>
    </div>
  );
}

// 分组头（可展开收起）。bracket=true 时把组名包成【】（按标题分组用）；迭代分组传 bracket=false 显示原名。
// suffix：组名/条数后面的附加节点（迭代分组用于显示逾期/剩余天数）。
function GroupHeader({ label, count, open, onToggle, isOther, bracket = true, suffix = null }) {
  return (
    <button
      onClick={onToggle}
      className="w-full flex items-center gap-1.5 px-3 py-1 mt-0.5 hover:bg-zinc-800/40 rounded transition"
    >
      <span className={`text-zinc-500 text-[11px] transition-transform ${open ? "rotate-90" : ""}`}>▸</span>
      <span className={`text-[10px] px-1.5 py-0.5 rounded border ${
        isOther ? "bg-zinc-800 border-zinc-700 text-zinc-400" : "bg-indigo-900/30 border-indigo-700/50 text-indigo-200"
      }`}>{(isOther || !bracket) ? label : `【${label}】`}</span>
      <span className="text-[11px] text-zinc-600">{count}</span>
      {suffix}
    </button>
  );
}

// 迭代到期徽标：根据迭代结束日期显示"逾期 N 天 / 今天到期 / 剩余 N 天"
function SprintDueBadge({ due }) {
  const days = daysFromToday(due);
  if (days === null) return null;
  const overdue = days < 0;
  const text = overdue ? `逾期 ${-days} 天` : days === 0 ? "今天到期" : `剩余 ${days} 天`;
  const cls = overdue ? "text-red-300 bg-red-900/30 border-red-800/50"
    : days <= 2 ? "text-amber-300 bg-amber-900/20 border-amber-800/40"
    : "text-zinc-400 bg-zinc-800 border-zinc-700";
  return <span className={`text-[10px] px-1.5 py-0.5 rounded border ${cls}`} title={`迭代结束日期：${due}`}>{text}</span>;
}

// Teambition 任务 ID 标签（如 CARB-11650），放在任务行最前
function CarbTag({ id }) {
  if (!id) return null;
  return (
    <span className="shrink-0 text-[9px] leading-none px-1.5 py-0.5 rounded bg-indigo-600/25 text-indigo-200 border border-indigo-500/40 font-mono" title={`Teambition 任务 ${id}`}>{id}</span>
  );
}

function TaskRow({ task, onToggle, onTogglePin, onToggleStar, onOpen, indent = false, onStartDev, onTeamDev, openTabs = [], onGroupMenu }) {
  const grouped = !!(task.tabId && (openTabs.find((t) => t.id === task.tabId) || {}).groupId);
  const tags = taskTags(task);
  return (
    <div
      onClick={onOpen}
      className={`group flex items-center gap-2.5 ${indent ? "pl-7 pr-3" : "px-3"} py-1.5 rounded-lg hover:bg-zinc-800/60 cursor-pointer transition`}
    >
      <Check done={task.done} onClick={onToggle} />
      {onTogglePin && <PinButton pinned={!!task.pinned} onClick={onTogglePin} />}
      {onToggleStar && <StarButton starred={!!task.starred} onClick={onToggleStar} />}
      <CarbTag id={task.carbId} />
      {!task.done && <PrioBadge p={task.priority} />}
      {!indent && task.taskGroupName && (
        <span className="shrink-0 text-[9px] leading-none px-1.5 py-0.5 rounded-full bg-violet-600/20 text-violet-200 border border-violet-600/35" title={`任务组：${task.taskGroupName}`}>{task.taskGroupName}</span>
      )}
      <span className={`flex-1 text-sm truncate ${task.done ? "text-zinc-500 line-through" : "text-zinc-200"}`}>
        {task.title}
      </span>
      <TaskTags tags={tags} />
      {task.tbStatus && !task.done && (
        <span className="shrink-0 text-[9px] text-cyan-200 bg-cyan-900/30 border border-cyan-800/50 rounded px-1 py-0.5" title="Teambition 状态">{task.tbStatus}</span>
      )}
      {!task.done && <DeadlineBadge deadline={task.deadline} />}
      {task.ticketUrl && <span className="shrink-0 text-[10px] text-indigo-400" title={task.tbTaskId ? "Teambition 工单" : "含工单地址"}>🔗</span>}
      {onStartDev && !task.done && (
        <button
          onClick={(e) => { e.stopPropagation(); onStartDev(task); }}
          className={`shrink-0 text-[10px] px-2 py-1 rounded border transition ${task.tabId ? "bg-emerald-600/20 border-emerald-600/40 text-emerald-300 hover:bg-emerald-600/30" : "bg-blue-600/20 border-blue-600/40 text-blue-300 hover:bg-blue-600/30"}`}
          title={task.tabId ? "打开该任务已绑定的故事点（关着则恢复，开着则切过去）" : "新建故事点并开始开发（与本任务一对一绑定）"}
        >{task.tabId ? "▶ 再次开发" : "▶ 执行开发"}</button>
      )}
      {onTeamDev && !task.done && (grouped ? (
        <button
          onClick={(e) => { e.stopPropagation(); onGroupMenu?.(task); }}
          className="shrink-0 text-[10px] px-2 py-1 rounded border border-zinc-700 bg-zinc-800/60 text-zinc-400 hover:text-zinc-200 transition"
          title="已组队：点击可切换组队或取消组队"
        >👥 已组队 ▾</button>
      ) : (
        <button
          onClick={(e) => { e.stopPropagation(); onTeamDev(task); }}
          className="shrink-0 text-[10px] px-2 py-1 rounded border border-violet-600/40 bg-violet-600/20 text-violet-300 hover:bg-violet-600/30 transition"
          title="组队开发：与另一个故事点共用同一套工程配置（同一工程串行解不同 TB 单），加入后排队，轮到时设为当前活动再开发"
        >👥 组队开发</button>
      ))}
      <span className="shrink-0 text-zinc-600 opacity-0 group-hover:opacity-100 text-[10px]">详情 ›</span>
    </div>
  );
}

// TB 候选区的一行：点行看详情；点右侧「添加到任务」把这条 TB 单（候选）挑进待办任务
function TbPoolRow({ task, onAdd, onOpen, indent = false }) {
  return (
    <div
      onClick={onOpen}
      className={`group flex items-center gap-2.5 ${indent ? "pl-7 pr-3" : "px-3"} py-1.5 rounded-lg hover:bg-zinc-800/60 cursor-pointer transition`}
    >
      <CarbTag id={task.carbId} />
      <PrioBadge p={task.priority} />
      {task.tbStatus && (
        <span className="shrink-0 text-[9px] text-cyan-200 bg-cyan-900/30 border border-cyan-800/50 rounded px-1 py-0.5" title="Teambition 状态">{task.tbStatus}</span>
      )}
      <span className="flex-1 text-sm text-zinc-300 truncate" title={task.title}>{task.title}</span>
      <DeadlineBadge deadline={task.deadline} />
      {task.ticketUrl && (
        <a href={task.ticketUrl} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()}
          className="shrink-0 text-[10px] text-indigo-400 hover:text-indigo-300" title="打开 Teambition 工单">🔗</a>
      )}
      <button
        onClick={(e) => { e.stopPropagation(); onAdd(); }}
        className="shrink-0 text-[10px] px-2 py-1 rounded border bg-emerald-600/20 border-emerald-600/40 text-emerald-300 hover:bg-emerald-600/30 transition"
        title="把这条 TB 单（候选）添加为今天的待办任务"
      >+ 添加到任务</button>
    </div>
  );
}

function TaskDetail({ task, groupOptions = [], onClose, onToggle, onSave, onDelete, onPromote }) {
  // TB 单候选（有 tbTaskId 且未被"添加到任务"）：详情页显示"添加到任务"，而非完成勾选
  const isCand = !!task.tbTaskId && task.staged !== false;
  const [title, setTitle] = useState(task.title);
  const [ticket, setTicket] = useState(task.ticketUrl || "");
  const [priority, setPriority] = useState(task.priority || "");
  const [deadline, setDeadline] = useState(task.deadline || "");
  const [pinned, setPinned] = useState(!!task.pinned);
  const [starred, setStarred] = useState(!!task.starred);
  const initialTags = taskTags(task);
  const [customTags, setCustomTags] = useState(initialTags);
  const [tagInput, setTagInput] = useState("");
  const taskGroupId = String(task.taskGroupId || "").trim();
  const taskGroupName = String(task.taskGroupName || "").trim();
  const taskGroupKnown = taskGroupId && groupOptions.some((g) => g.id === taskGroupId);
  const [groupMode, setGroupMode] = useState(taskGroupId ? (taskGroupKnown ? taskGroupId : CUSTOM_TASK_GROUP) : "");
  const [customGroupName, setCustomGroupName] = useState(taskGroupName);
  const selectedExistingGroup = groupOptions.find((g) => g.id === groupMode) || null;
  const nextGroupName = groupMode === CUSTOM_TASK_GROUP ? customGroupName.trim().slice(0, 60) : (selectedExistingGroup?.name || "");
  const nextGroupId = groupMode === CUSTOM_TASK_GROUP
    ? (nextGroupName ? (taskGroupId || newTaskGroupId()) : "")
    : (selectedExistingGroup?.id || "");
  const groupDirty = !isCand && (
    (nextGroupName || "") !== taskGroupName
    || (nextGroupName ? nextGroupId !== taskGroupId : !!taskGroupName)
  );
  const dirty = title.trim() !== task.title
    || (ticket.trim() || "") !== (task.ticketUrl || "")
    || (priority || "") !== (task.priority || "")
    || (deadline.trim() || "") !== (task.deadline || "")
    || (!isCand && pinned !== !!task.pinned)
    || (!isCand && starred !== !!task.starred)
    || (!isCand && !sameTags(customTags, initialTags))
    || groupDirty;

  function addCustomTag(raw) {
    const next = normalizeTagList([...customTags, ...normalizeTagList(raw)]);
    setCustomTags(next);
    setTagInput("");
  }

  async function save() {
    if (!title.trim()) return;
    await onSave({
      title: title.trim(),
      ticketUrl: ticket.trim(),
      priority: priority || "",
      deadline: deadline.trim(),
      ...(!isCand ? {
        taskGroupId: nextGroupName ? nextGroupId : "",
        taskGroupName: nextGroupName || "",
        pinned,
        starred,
        customTags,
      } : {}),
    });
  }

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50" onClick={onClose}>
      <div
        className="w-[460px] max-w-[92vw] bg-zinc-900 border border-zinc-700 rounded-xl shadow-2xl flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-4 py-3 border-b border-zinc-800 flex items-center gap-2">
          {!isCand && <Check done={task.done} onClick={onToggle} />}
          {!isCand && <PinButton pinned={pinned} onClick={() => setPinned((v) => !v)} />}
          {!isCand && <StarButton starred={starred} onClick={() => setStarred((v) => !v)} />}
          <span className="text-sm font-semibold text-zinc-100">{isCand ? "TB 单详情" : "任务详情"}</span>
          {isCand && <span className="text-[9px] text-cyan-200 bg-cyan-900/30 border border-cyan-800/50 rounded px-1 py-0.5">候选</span>}
          <button onClick={onClose} className="ml-auto text-zinc-500 hover:text-zinc-200 text-sm px-1">✕</button>
        </div>

        <div className="px-4 py-3 space-y-3">
          {/* 标题 */}
          <div>
            <div className="text-[11px] text-zinc-500 mb-1">标题</div>
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              className={`w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm outline-none focus:border-zinc-500 ${task.done ? "text-zinc-400 line-through" : "text-zinc-100"}`}
            />
          </div>

          {/* 优先级标签 + 期限 */}
          <div className="flex items-center gap-4 flex-wrap">
            <div className="flex items-center gap-1.5">
              <span className="text-[11px] text-zinc-500">优先级标签</span>
              <button
                onClick={() => setPriority("")}
                className={`text-[10px] px-1.5 py-0.5 rounded border transition ${!priority ? "bg-zinc-700 border-zinc-500 text-zinc-100" : "bg-zinc-800 border-zinc-700 text-zinc-500 hover:text-zinc-300"}`}
              >无</button>
              {PRIO_OPTIONS.map((p) => (
                <button
                  key={p}
                  onClick={() => setPriority(p)}
                  className={`text-[10px] px-1.5 py-0.5 rounded border transition ${
                    priority === p
                      ? (p === "P0" ? "bg-red-600/40 border-red-500 text-red-200"
                        : p === "P1" ? "bg-orange-600/40 border-orange-500 text-orange-200"
                        : p === "P2" ? "bg-amber-600/35 border-amber-500 text-amber-100"
                        : "bg-zinc-600 border-zinc-400 text-zinc-100")
                      : "bg-zinc-800 border-zinc-700 text-zinc-500 hover:text-zinc-300"
                  }`}
                >{p}</button>
              ))}
            </div>
            <div className="flex items-center gap-1.5 flex-1 min-w-[160px]">
              <span className="text-[11px] text-zinc-500 shrink-0">期限</span>
              <input
                value={deadline}
                onChange={(e) => setDeadline(e.target.value)}
                placeholder="如 今天给 / 下周一完成"
                className="flex-1 bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-[11px] text-zinc-200 placeholder-zinc-600 outline-none focus:border-zinc-500"
              />
            </div>
          </div>

          {!isCand && (
            <div>
              <div className="text-[11px] text-zinc-500 mb-1">任务组</div>
              <div className="flex items-center gap-2">
                <select
                  value={groupMode}
                  onChange={(e) => {
                    const v = e.target.value;
                    setGroupMode(v);
                    if (v === CUSTOM_TASK_GROUP && !customGroupName) setCustomGroupName(taskGroupName || "");
                  }}
                  className="min-w-[150px] bg-zinc-800 border border-zinc-700 rounded-lg px-2 py-1.5 text-xs text-zinc-200 outline-none focus:border-violet-500/70"
                >
                  <option value="">未分组</option>
                  {groupOptions.map((g) => (
                    <option key={g.id} value={g.id}>{g.name}</option>
                  ))}
                  <option value={CUSTOM_TASK_GROUP}>新建 / 自定义</option>
                </select>
                {groupMode === CUSTOM_TASK_GROUP && (
                  <input
                    value={customGroupName}
                    onChange={(e) => setCustomGroupName(e.target.value)}
                    maxLength={60}
                    placeholder="任务组名称"
                    className="flex-1 bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-1.5 text-xs text-zinc-100 placeholder-zinc-600 outline-none focus:border-violet-500/70"
                  />
                )}
              </div>
            </div>
          )}

          {!isCand && (
            <div>
              <div className="text-[11px] text-zinc-500 mb-1">自定义标签</div>
              <div className="flex items-center gap-2 flex-wrap">
                <TaskTags
                  tags={customTags}
                  limit={8}
                  removable
                  onRemove={(tag) => setCustomTags((prev) => prev.filter((x) => x !== tag))}
                />
                <input
                  value={tagInput}
                  onChange={(e) => setTagInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === "," || e.key === "，") {
                      e.preventDefault();
                      addCustomTag(tagInput);
                    }
                  }}
                  onBlur={() => { if (tagInput.trim()) addCustomTag(tagInput); }}
                  placeholder="输入标签后回车"
                  className="min-w-[150px] flex-1 bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-1.5 text-xs text-zinc-100 placeholder-zinc-600 outline-none focus:border-cyan-500/70"
                />
              </div>
            </div>
          )}

          {/* 工单地址 */}
          <div>
            <div className="text-[11px] text-zinc-500 mb-1 flex items-center gap-2">
              工单地址
              {task.ticketUrl && (
                <a href={task.ticketUrl} target="_blank" rel="noopener noreferrer"
                  className="text-indigo-400 hover:text-indigo-300" title={`在浏览器新标签打开：${task.ticketUrl}`}>🔗 打开</a>
              )}
            </div>
            <input
              value={ticket}
              onChange={(e) => setTicket(e.target.value)}
              placeholder="工单 URL（如 https://...）"
              className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-xs text-zinc-200 placeholder-zinc-600 outline-none focus:border-zinc-500 font-mono"
            />
          </div>

          {/* 完成时间 */}
          <div className="flex items-center gap-2 text-[11px]">
            <span className="text-zinc-500">任务完成时间</span>
            <span className={task.done ? "text-emerald-300" : "text-zinc-600"}>
              {task.done ? fmtTime(task.completedAt) : "未完成"}
            </span>
          </div>
        </div>

        <div className="px-4 py-3 border-t border-zinc-800 flex items-center gap-2">
          {isCand ? (
            <button
              onClick={onPromote}
              className="px-3 py-1.5 text-xs rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white transition"
              title="把这条 TB 单（候选）添加为今天的待办任务"
            >+ 添加到任务</button>
          ) : (
            <button
              onClick={onToggle}
              className={`px-3 py-1.5 text-xs rounded-lg transition ${task.done ? "bg-zinc-800 hover:bg-zinc-700 text-zinc-300" : "bg-emerald-600 hover:bg-emerald-500 text-white"}`}
            >{task.done ? "标记未完成" : "标记完成"}</button>
          )}
          <button
            onClick={save}
            disabled={!dirty || !title.trim()}
            className="px-3 py-1.5 text-xs rounded-lg bg-blue-600 hover:bg-blue-500 disabled:bg-zinc-700 disabled:text-zinc-500 text-white transition"
          >保存</button>
          <button
            onClick={() => { if (confirm("删除该任务？")) onDelete(); }}
            className="ml-auto px-3 py-1.5 text-xs rounded-lg bg-zinc-800 hover:bg-red-600/30 text-zinc-400 hover:text-red-300 transition"
          >删除</button>
        </div>
      </div>
    </div>
  );
}
