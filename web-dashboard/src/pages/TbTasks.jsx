import React, { useState, useEffect, useRef } from "react";
import { createGatewayWebSocket, getApiUrl } from "../services/gateway.js";
import { authenticatedFetch } from "../services/adminAuth.js";

function formatFileSize(bytes) {
  if (!bytes) return "0B";
  if (bytes < 1024) return bytes + "B";
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + "KB";
  return (bytes / 1024 / 1024).toFixed(1) + "MB";
}

const STATUS_MAP = {
  pending: { label: "待分析", color: "text-zinc-400", bg: "bg-zinc-700" },
  searching: { label: "搜索中", color: "text-cyan-400", bg: "bg-cyan-500/20" },
  downloading: { label: "下载附件", color: "text-blue-400", bg: "bg-blue-500/20" },
  analyzing: { label: "AI 分析中", color: "text-amber-400", bg: "bg-amber-500/20" },
  completed: { label: "已完成", color: "text-green-400", bg: "bg-green-500/20" },
  suspended: { label: "等待补充", color: "text-orange-400", bg: "bg-orange-500/20" },
  failed: { label: "失败", color: "text-red-400", bg: "bg-red-500/20" },
};

export default function TbTasks() {
  const [records, setRecords] = useState([]);
  const [expandedId, setExpandedId] = useState(null);
  const [report, setReport] = useState("");
  const [taskIdInput, setTaskIdInput] = useState("");
  const [syncing, setSyncing] = useState(false);
  const [toast, setToast] = useState(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [carFilter, setCarFilter] = useState("");      // 车型（从标题【xx】解析）
  const [priorityFilter, setPriorityFilter] = useState(""); // 优先级
  const [timeFilter, setTimeFilter] = useState("");    // 时间范围: 7d/30d/90d/''
  const [dueFilter, setDueFilter] = useState("");      // 到期范围: overdue/3d/7d/''
  const [dueDates, setDueDates] = useState({});        // id -> dueDate 缓存
  const [tbStatusFilter, setTbStatusFilter] = useState(""); // TB 单状态筛选（待处理/修复中等 taskflow 状态）
  const [tbStatuses, setTbStatuses] = useState({});    // id -> TB 状态名缓存
  const [selectedIds, setSelectedIds] = useState([]);  // 多选导出的问题单 id 集合

  const showToast = (msg, ok = true) => { setToast({ msg, ok }); setTimeout(() => setToast(null), 3000); };

  const wsRef = useRef(null);

  useEffect(() => { fetchRecords(); }, []);

  // WS 监听状态变更，自动刷新
  useEffect(() => {
    const ws = createGatewayWebSocket();
    wsRef.current = ws;
    ws.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data);
        if (msg.type === "tb_task_update") {
          fetchRecords();
          const d = msg.data;
          if (d.message) showToast(d.message, d.status !== "failed");
          if (d.status === "failed" && d.error_message) showToast(`失败: ${d.error_message}`, false);
        }
      } catch {}
    };
    return () => ws.close();
  }, []);

  function fetchRecords() {
    fetch(getApiUrl("/api/tb-tasks?limit=100"))
      .then(r => r.json())
      .then(d => { if (d.success) setRecords(d.data); })
      .catch(() => {});
  }

  async function handleSync() {
    setSyncing(true);
    try {
      await authenticatedFetch(getApiUrl("/api/tb-tasks/sync"), { method: "POST" });
      showToast("扫描已触发，请稍后刷新查看");
      setTimeout(fetchRecords, 5000);
    } catch (err) { showToast(`失败: ${err.message}`, false); }
    finally { setSyncing(false); }
  }

  async function handleAnalyze() {
    if (!taskIdInput.trim()) return;
    try {
      const resp = await authenticatedFetch(getApiUrl("/api/tb-tasks/analyze"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ taskId: taskIdInput.trim() }),
      });
      const d = await resp.json();
      if (d.success) { showToast(`分析已触发: ${taskIdInput}`); setTaskIdInput(""); setTimeout(fetchRecords, 3000); }
      else showToast(`失败: ${d.error}`, false);
    } catch (err) { showToast(`失败: ${err.message}`, false); }
  }

  async function handleReanalyze(id) {
    await authenticatedFetch(getApiUrl(`/api/tb-tasks/${id}/reanalyze`), { method: "POST" });
    showToast("重新分析已触发");
    setTimeout(fetchRecords, 3000);
  }

  async function handleOpenDir(id) {
    try {
      const resp = await authenticatedFetch(getApiUrl(`/api/tb-tasks/${id}/open-dir`), { method: "POST" });
      const d = await resp.json();
      if (d.success) showToast(`已打开: ${d.data.dir}`);
      else showToast(`打开失败: ${d.error}`, false);
    } catch (err) { showToast(`打开失败: ${err.message}`, false); }
  }

  async function handleDelete(id) {
    try {
      const resp = await authenticatedFetch(getApiUrl(`/api/tb-tasks/${id}`), { method: "DELETE" });
      const d = await resp.json();
      if (d.success) {
        showToast("已删除");
        setRecords(prev => prev.filter(r => r.id !== id));
        if (expandedId === id) setExpandedId(null);
      } else {
        showToast(`删除失败: ${d.error}`, false);
      }
    } catch (err) { showToast(`删除失败: ${err.message}`, false); }
  }

  async function handleConfirm(id) {
    const resp = await authenticatedFetch(getApiUrl(`/api/tb-tasks/${id}/confirm`), { method: "POST" });
    const d = await resp.json();
    if (d.success) { showToast("评论已发送"); fetchRecords(); }
    else showToast(`失败: ${d.error}`, false);
  }

  async function loadReport(id) {
    if (expandedId === id) { setExpandedId(null); return; }
    try {
      const resp = await fetch(getApiUrl(`/api/tb-tasks/${id}/report`));
      const d = await resp.json();
      setReport(d.success ? d.data.content : "报告不存在");
      setExpandedId(id);
    } catch { setReport("加载失败"); setExpandedId(id); }
  }

  const stats = {
    pending: records.filter(r => r.status === "pending").length,
    analyzing: records.filter(r => ["downloading", "analyzing", "searching"].includes(r.status)).length,
    completed: records.filter(r => r.status === "completed").length,
    suspended: records.filter(r => r.status === "suspended").length,
    failed: records.filter(r => r.status === "failed").length,
  };

  // 从标题推导车型（【Geely】【P162】等）：取括号内第一个词条作为车型
  const carOptions = [...new Set(records.map(r => {
    const m = String(r.title || "").match(/【([^】]+)】/);
    return m ? m[1].trim() : "";
  }).filter(Boolean))].sort();

  // 批量拉取缺失的到期日期 + TB 状态名（export-data 一次返回 both），分别缓存
  async function fetchDueDates(ids) {
    const missing = ids.filter(id => dueDates[id] === undefined || tbStatuses[id] === undefined);
    if (!missing.length) return;
    const nextDue = { ...dueDates };
    const nextStatus = { ...tbStatuses };
    await Promise.all(missing.map(async id => {
      try {
        const resp = await fetch(getApiUrl(`/api/tb-tasks/${id}/export-data`));
        const d = await resp.json();
        if (d.success) {
          if (d.data?.dueDate) nextDue[id] = d.data.dueDate;
          else nextDue[id] = null;
          if (d.data?.statusName) nextStatus[id] = d.data.statusName;
          else nextStatus[id] = null;
        } else {
          nextDue[id] = null;
          nextStatus[id] = null;
        }
      } catch {
        nextDue[id] = null;
        nextStatus[id] = null;
      }
    }));
    setDueDates(nextDue);
    setTbStatuses(nextStatus);
  }

  // 到期判断：返回 0=无日期, 1=已到期, 2=3天内, 3=7天内, 4=更晚
  function dueRank(dueDateStr) {
    if (!dueDateStr) return 0;
    const t = new Date(dueDateStr).getTime();
    if (!t) return 0;
    const now = Date.now();
    const day = 86400000;
    if (t < now) return 1;                          // 已到期
    if (t - now <= 3 * day) return 2;               // 3 天内
    if (t - now <= 7 * day) return 3;               // 7 天内
    return 4;
  }

  // 综合过滤：搜索词 + 车型 + 优先级 + 时间范围 + 到期范围
  const filteredRecords = records.filter(r => {
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      if (!(r.carb_id || "").toLowerCase().includes(q) &&
          !(r.title || "").toLowerCase().includes(q) &&
          !(r.id || "").toLowerCase().includes(q)) return false;
    }
    if (carFilter) {
      const m = String(r.title || "").match(/【([^】]+)】/);
      if (!m || m[1].trim() !== carFilter) return false;
    }
    if (priorityFilter && String(r.priority || "") !== priorityFilter) return false;
    if (timeFilter) {
      const days = { "7d": 7, "30d": 30, "90d": 90 }[timeFilter] || 0;
      if (days > 0) {
        const t = r.detected_at ? new Date(r.detected_at).getTime() : 0;
        if (!t || Date.now() - t > days * 86400000) return false;
      }
    }
    if (dueFilter) {
      const rank = dueRank(dueDates[r.id]);
      if (dueFilter === "overdue" && rank !== 1) return false;
      if (dueFilter === "3d" && !(rank === 1 || rank === 2)) return false;
      if (dueFilter === "7d" && !(rank === 1 || rank === 2 || rank === 3)) return false;
    }
    if (tbStatusFilter && tbStatuses[r.id] !== tbStatusFilter) return false;
    return true;
  });

  // TB 状态选项（从已拉取的 statusName 推导，去重排序）
  const tbStatusOptions = [...new Set(Object.values(tbStatuses).filter(Boolean))].sort();

  // 到期/TB状态筛选激活时，自动拉取缺失的 dueDate + statusName
  useEffect(() => {
    if (dueFilter || tbStatusFilter) fetchDueDates(records.map(r => r.id));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dueFilter, tbStatusFilter, records]);

  // 导出的记录：优先已选中的；未选任何时导出当前过滤结果
  const exportRecords = selectedIds.length > 0
    ? records.filter(r => selectedIds.includes(r.id))
    : filteredRecords;

  // 拉取所有导出记录的 TB 状态 + 评论 + 附件 URL
  async function buildExportData() {
    const result = [];
    for (let i = 0; i < exportRecords.length; i++) {
      const r = exportRecords[i];
      let statusName = null;
      let comments = [];
      let attachmentUrls = [];
      let uniqueId = null;
      try {
        const resp = await fetch(getApiUrl(`/api/tb-tasks/${r.id}/export-data`));
        const d = await resp.json();
        if (d.success) {
          statusName = d.data.statusName || null;
          comments = Array.isArray(d.data.comments) ? d.data.comments : [];
          attachmentUrls = Array.isArray(d.data.attachmentUrls) ? d.data.attachmentUrls : [];
          uniqueId = d.data.uniqueId || null;
        }
      } catch {}
      result.push({ r, index: i + 1, statusName, comments, attachmentUrls, uniqueId });
    }
    return result;
  }

  // 导出显示名：统一 CARB 单号（carb_id 或 CARB-{uniqueId}），最后兜底短 id
  function displayName(item) {
    const r = item.r;
    if (r.carb_id) return r.carb_id;
    if (item.uniqueId) return `CARB-${item.uniqueId}`;
    return String(r.id || "").slice(0, 8) || `task_${item.index}`;
  }

  // 渲染单条问题单为 markdown 文本
  function renderSingleMd(item) {
    const { r, index, statusName, comments, attachmentUrls } = item;
    const atts = Array.isArray(r.attachments) ? r.attachments : [];
    const lines = [];
    const started = statusName ? (String(statusName).includes("待") ? "未开始" : "已开始") : (r.status === "completed" ? "已完成" : "-");
    lines.push(`## ${displayName(item)}`);
    lines.push("");
    lines.push(`- TB 单号：${displayName(item)}`);
    lines.push("");
    lines.push(`- 问题描述：${r.title || "(无标题)"}`);
    lines.push(`- TB 状态：${statusName || "-"}`);
    lines.push(`- 是否开始：${started}`);
    lines.push(`- 优先级：${r.priority || "-"}`);
    lines.push(`- 平台状态：${(STATUS_MAP[r.status] || {}).label || r.status || "-"}`);
    lines.push(`- 项目：${r.project_name || "-"}`);
    lines.push(`- 分组：${r.group_name || "-"}`);
    lines.push(`- 建单人：${r.creator_name || r.creator_id || "-"}`);
    lines.push(`- 执行人：${r.executor_name || r.executor_id || "-"}`);
    lines.push(`- 本地目录：${r.local_dir || "-"}`);
    lines.push(`- 检测时间：${r.detected_at || "-"}`);
    lines.push(`- 分析时间：${r.analyzed_at || "-"}`);
    if (r.analysis_summary) {
      lines.push("");
      lines.push("### 分析摘要");
      lines.push("");
      lines.push(r.analysis_summary);
    }
    lines.push("");
    lines.push("### 附件文件");
    lines.push("");
    if (attachmentUrls.length) {
      attachmentUrls.forEach(a => {
        const sizeTxt = a.size ? `（${formatFileSize(a.size)}）` : "";
        if (a.url) {
          lines.push(`- [${a.name}]${sizeTxt} — URL：${a.url}`);
        } else {
          lines.push(`- ${a.name}${sizeTxt}（无下载链接）`);
        }
      });
    } else if (atts.length) {
      atts.forEach(a => {
        lines.push(`- ${a.name}${a.size ? `（${formatFileSize(a.size)}）` : ""}${a.downloaded && a.path ? ` — 本地路径：\`${a.path}\`` : a.downloaded ? "（已下载）" : "（未下载）"}`);
      });
    } else {
      lines.push("（无附件）");
    }
    lines.push("");
    lines.push("### 评论记录");
    lines.push("");
    if (comments.length) {
      comments.forEach(c => {
        const author = c.creator?.name || c.creatorName || c._creatorName || c.creator || "";
        const time = c.created || c.createTime || "";
        lines.push(`- ${renderCommentLine(c, author, time)}`);
      });
    } else {
      lines.push("（无评论）");
    }
    if (r.error_message) {
      lines.push("");
      lines.push(`- 错误信息：${r.error_message}`);
    }
    lines.push("");
    return lines.join("\n");
  }

  // 渲染单条评论为可读文本
  function renderCommentLine(c, author, time) {
    const commentText = c.content?.comment != null ? String(c.content.comment || "") : "";
    let body = commentText;
    if (!body && c.content && typeof c.content === "object") {
      const ct = c.content;
      const parts = [];
      if (ct.dueDate) parts.push(`截止日期改至 ${ct.dueDate}${ct.oldDueDate ? `（原 ${ct.oldDueDate}）` : ""}`);
      if (ct.sprintName) parts.push(`迭代：${ct.sprintName}${ct.oldSprintName ? `（原 ${ct.oldSprintName}）` : ""}`);
      if (ct.taskflowstatus) parts.push(`状态：${ct.taskflowstatus}${ct.oldTaskflowstatus ? `（原 ${ct.oldTaskflowstatus}）` : ""}`);
      if (ct.executor?.name) parts.push(`执行人：${ct.executor.name}${ct.oldExecutor?.name ? `（原 ${ct.oldExecutor.name}）` : ""}`);
      if (ct._executorId && !ct.executor?.name) parts.push("执行人已变更");
      if (ct.content && typeof ct.content === "string") parts.push(`内容：${ct.content.slice(0, 80)}${ct.content.length > 80 ? "…" : ""}`);
      if (ct.field) parts.push(`${ct.field}：${ct.value || ct.newValue || ""}`);
      if (ct.customfieldName) parts.push(`${ct.customfieldName}：${ct.valueString || ct.customfieldValueStr || ""}${ct.oldValueString ? `（原 ${ct.oldValueString}）` : ""}`);
      if (ct.note != null) parts.push(`备注：${String(ct.note).slice(0, 80)}${ct.oldNote ? `（原 ${String(ct.oldNote).slice(0, 40)}）` : ""}`);
      if (ct.priority != null) parts.push(`优先级：${ct.priority}${ct.oldPriority ? `（原 ${ct.oldPriority}）` : ""}`);
      if (ct.task?.content) parts.push(`建单：${String(ct.task.content).slice(0, 80)}`);
      if (ct.tagName || ct.tag) parts.push(`标签：${ct.tagName || ct.tag}`);
      if (ct.addNames) parts.push(`新增协作者：${ct.addNames}`);
      if (ct.delNames) parts.push(`移除协作者：${ct.delNames}`);
      body = parts.filter(Boolean).join("；");
      if (!body) {
        const collected = [];
        const walk = (v, depth) => {
          if (depth > 3 || collected.length >= 6) return;
          if (typeof v === "string" && v.trim()) collected.push(v.trim());
          else if (Array.isArray(v)) v.forEach(x => walk(x, depth + 1));
          else if (v && typeof v === "object") {
            for (const key of ["name", "title", "value", "content", "comment", "text"]) {
              if (typeof v[key] === "string" && v[key].trim()) { collected.push(v[key].trim()); break; }
            }
            Object.values(v).forEach(x => walk(x, depth + 1));
          }
        };
        walk(ct, 0);
        body = [...new Set(collected)].join("；").slice(0, 120);
      }
    }
    if (!body && typeof c.content === "string") body = c.content;
    if (!body) {
      const action = c.action || c.actionType || c.rawAction || "";
      body = `（动态：${action}）`;
    }
    return `${time ? `[${time}] ` : ""}${author ? `${author}：` : ""}${body}`;
  }

  // 生成合并 markdown 并下载
  async function exportMarkdown() {
    if (!exportRecords.length) { showToast("没有可导出的问题单", false); return; }
    showToast(`正在获取 ${exportRecords.length} 条问题单的评论与状态...`);
    const data = await buildExportData();
    const lines = [];
    lines.push("# 问题单导出");
    lines.push("");
    lines.push(`- 导出时间：${new Date().toLocaleString("zh-CN", { hour12: false })}`);
    lines.push(`- 数量：${data.length} 条`);
    lines.push("");
    for (const item of data) {
      lines.push(renderSingleMd(item));
    }
    const blob = new Blob([lines.join("\n")], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `问题单导出_${new Date().toISOString().slice(0, 10)}.md`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    showToast(`已导出 ${data.length} 条问题单`);
  }

  // 生成拆分 markdown 压缩包并下载（每个问题单一个 md）
  async function exportZip() {
    if (!exportRecords.length) { showToast("没有可导出的问题单", false); return; }
    showToast(`正在生成 ${exportRecords.length} 条问题单的压缩包...`);
    try {
      const JSZip = (await import("jszip")).default;
      const data = await buildExportData();
      const zip = new JSZip();
      const dateStr = new Date().toISOString().slice(0, 10);
      for (const item of data) {
        zip.file(`${displayName(item)}.md`, renderSingleMd(item));
      }
      const blob = await zip.generateAsync({ type: "blob" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `问题单导出_${dateStr}.zip`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      showToast(`已导出 ${data.length} 条问题单压缩包`);
    } catch (e) {
      showToast(`导出压缩包失败: ${e.message}`, false);
    }
  }

  function toggleSelect(id) {
    setSelectedIds(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]);
  }

  function toggleSelectAll() {
    if (selectedIds.length === filteredRecords.length && filteredRecords.length > 0) setSelectedIds([]);
    else setSelectedIds(filteredRecords.map(r => r.id));
  }

  return (
    <div className="p-6 overflow-y-auto h-full space-y-4 relative">
      {toast && (
        <div className={`fixed top-4 right-4 z-50 px-4 py-2 rounded-lg text-sm shadow-lg ${
          toast.ok ? "bg-green-500/20 text-green-300 border border-green-500/30" : "bg-red-500/20 text-red-300 border border-red-500/30"
        }`}>{toast.msg}</div>
      )}

      {/* 顶栏 */}
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-medium text-zinc-300">TB 任务分析</h2>
        <div className="flex items-center gap-2">
          <input value={taskIdInput} onChange={e => setTaskIdInput(e.target.value)}
            onKeyDown={e => e.key === "Enter" && handleAnalyze()}
            placeholder="输入 CARB-xxxx 分析指定任务"
            className="bg-zinc-800 border border-zinc-700 rounded px-3 py-1.5 text-xs text-zinc-300 outline-none w-64 font-mono" />
          <button onClick={handleAnalyze} disabled={!taskIdInput.trim()}
            className="px-3 py-1.5 text-xs rounded bg-blue-600 hover:bg-blue-500 disabled:bg-zinc-700 text-white transition">分析</button>
          <button onClick={handleSync} disabled={syncing}
            className="px-3 py-1.5 text-xs rounded bg-zinc-700 hover:bg-zinc-600 text-zinc-300 transition disabled:opacity-50">
            {syncing ? "扫描中..." : "手动同步"}
          </button>
          <button onClick={fetchRecords}
            className="px-3 py-1.5 text-xs rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-400 transition">刷新</button>
          <button onClick={exportMarkdown} disabled={!exportRecords.length}
            className="px-3 py-1.5 text-xs rounded bg-emerald-600 hover:bg-emerald-500 disabled:bg-zinc-700 text-white transition"
            title="导出勾选的问题单；未勾选时导出当前过滤结果">
            ⬇ 导出问题单{selectedIds.length ? `（${selectedIds.length}）` : ""}
          </button>
          <button onClick={exportZip} disabled={!exportRecords.length}
            className="px-3 py-1.5 text-xs rounded bg-teal-600 hover:bg-teal-500 disabled:bg-zinc-700 text-white transition"
            title="每个问题单一个 md，打包为 zip 下载">
            📦 导出 ZIP{selectedIds.length ? `（${selectedIds.length}）` : ""}
          </button>
        </div>
      </div>

      {/* 搜索 */}
      <input
        value={searchQuery}
        onChange={e => setSearchQuery(e.target.value)}
        placeholder="搜索任务 ID 或标题..."
        className="bg-zinc-800 border border-zinc-700 rounded px-3 py-2 text-xs text-zinc-300 outline-none w-full focus:border-zinc-500"
      />

      {/* 过滤条：车型 / 优先级 / 时间 */}
      <div className="flex items-center gap-2 flex-wrap text-xs">
        <select value={carFilter} onChange={e => setCarFilter(e.target.value)}
          className="bg-zinc-800 border border-zinc-700 rounded px-2 py-1.5 text-zinc-300 outline-none">
          <option value="">全部车型</option>
          {carOptions.map(c => <option key={c} value={c}>{c}</option>)}
        </select>
        <select value={priorityFilter} onChange={e => setPriorityFilter(e.target.value)}
          className="bg-zinc-800 border border-zinc-700 rounded px-2 py-1.5 text-zinc-300 outline-none">
          <option value="">全部优先级</option>
          {["紧急", "普通", "较低"].map(p => <option key={p} value={p}>{p}</option>)}
        </select>
        <select value={timeFilter} onChange={e => setTimeFilter(e.target.value)}
          className="bg-zinc-800 border border-zinc-700 rounded px-2 py-1.5 text-zinc-300 outline-none">
          <option value="">全部时间</option>
          <option value="7d">最近 7 天</option>
          <option value="30d">最近 30 天</option>
          <option value="90d">最近 90 天</option>
        </select>
        <select value={dueFilter} onChange={e => setDueFilter(e.target.value)}
          className="bg-zinc-800 border border-zinc-700 rounded px-2 py-1.5 text-zinc-300 outline-none">
          <option value="">全部到期</option>
          <option value="overdue">已到期</option>
          <option value="3d">3 天内到期</option>
          <option value="7d">7 天内到期</option>
        </select>
        <select value={tbStatusFilter} onChange={e => setTbStatusFilter(e.target.value)}
          className="bg-zinc-800 border border-zinc-700 rounded px-2 py-1.5 text-zinc-300 outline-none">
          <option value="">全部TB状态</option>
          {tbStatusOptions.map(s => <option key={s} value={s}>{s}</option>)}
        </select>
        <span className="text-zinc-600">共 {filteredRecords.length} 条</span>
        <button onClick={toggleSelectAll}
          className="px-2 py-1 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-400 transition"
          title="全选/取消全选当前过滤结果">
          {selectedIds.length === filteredRecords.length && filteredRecords.length > 0 ? "取消全选" : "全选"}
        </button>
      </div>

      {/* 统计条 */}
      <div className="flex items-center gap-4 text-xs text-zinc-500">
        <span>待分析 <span className="text-zinc-300">{stats.pending}</span></span>
        <span>分析中 <span className="text-amber-400">{stats.analyzing}</span></span>
        <span>已完成 <span className="text-green-400">{stats.completed}</span></span>
        <span>等待补充 <span className="text-orange-400">{stats.suspended}</span></span>
        <span>失败 <span className="text-red-400">{stats.failed}</span></span>
      </div>

      {/* 任务列表 */}
      <div className="space-y-3">
        {records.length === 0 && <p className="text-xs text-zinc-600 text-center py-8">暂无记录，点击「手动同步」扫描 Teambition 任务</p>}
        {filteredRecords.map(r => {
          const s = STATUS_MAP[r.status] || STATUS_MAP.pending;
          const isExpanded = expandedId === r.id;
          return (
            <div key={r.id} className="bg-zinc-900 border border-zinc-800 rounded-xl overflow-hidden">
              <div className="p-4">
                <div className="flex items-center justify-between mb-2">
                  <div className="flex items-center gap-2 min-w-0 flex-1">
                    <input type="checkbox"
                      checked={selectedIds.includes(r.id)}
                      onChange={() => toggleSelect(r.id)}
                      onClick={e => e.stopPropagation()}
                      className="accent-emerald-500 shrink-0"
                      title="勾选以导出" />
                    <span className={`text-xs px-1.5 py-0.5 rounded ${s.bg} ${s.color}`}>{s.label}</span>
                    <span className="text-xs font-mono text-zinc-500">{r.carb_id || r.id.slice(0, 8)}</span>
                    <span className="text-sm text-zinc-200 truncate">{r.title}</span>
                  </div>
                  <div className="flex items-center gap-2 shrink-0 ml-2">
                    {r.status === "completed" && (
                      <>
                        <button onClick={() => loadReport(r.id)}
                          className="text-xs px-2 py-1 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-300 transition">
                          {isExpanded ? "收起报告" : "查看报告"}
                        </button>
                        {r.analysis_summary && !r.comment_posted && (
                          <button onClick={() => handleConfirm(r.id)}
                            className="text-xs px-2 py-1 rounded bg-blue-600/20 text-blue-400 hover:bg-blue-600/30 transition">
                            发送评论
                          </button>
                        )}
                        {r.comment_posted === 1 && (
                          <span className="text-xs px-2 py-1 text-green-500">已发送</span>
                        )}
                      </>
                    )}
                    {(r.status === "failed" || r.status === "completed" || r.status === "suspended") && (
                      <button onClick={() => handleReanalyze(r.id)}
                        className="text-xs px-2 py-1 rounded text-zinc-500 hover:text-zinc-300 transition">重新分析</button>
                    )}
                    <button onClick={() => handleDelete(r.id)}
                      className="text-xs px-2 py-1 rounded text-zinc-600 hover:text-red-400 transition">删除</button>
                  </div>
                </div>
                <div className="flex items-center gap-3 text-[10px] text-zinc-600">
                  {r.priority && <span>优先级: {r.priority}</span>}
                  {r.group_name && <span>分组: {r.group_name}</span>}
                  {r.creator_name && <span>建单: {r.creator_name}</span>}
                  {r.executor_name && <span>执行: {r.executor_name}</span>}
                  {dueDates[r.id] && (() => {
                    const rank = dueRank(dueDates[r.id]);
                    const color = rank === 1 ? "text-red-400" : rank === 2 ? "text-amber-400" : "text-zinc-500";
                    const label = rank === 1 ? "已到期" : rank === 2 ? "3天内" : rank === 3 ? "7天内" : "";
                    const d = new Date(dueDates[r.id]);
                    const ds = isNaN(d) ? dueDates[r.id] : `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
                    return <span className={color}>到期: {ds}{label ? ` (${label})` : ""}</span>;
                  })()}
                  {tbStatuses[r.id] && <span className="text-zinc-400">TB状态: {tbStatuses[r.id]}</span>}
                  {r.analyzed_at && <span>分析时间: {r.analyzed_at}</span>}
                </div>
                {/* 附件信息 */}
                {r.attachments && r.attachments.length > 0 && (
                  <div className="mt-2">
                    <div className="flex items-center gap-2 mb-1">
                      <span className="text-[10px] text-zinc-500">附件 ({r.attachments.length})</span>
                      {r.attachments.some(a => a.downloaded) && r.local_dir && (
                        <button onClick={() => handleOpenDir(r.id)}
                          className="text-[10px] px-1.5 py-0.5 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-400 hover:text-zinc-200 transition">
                          打开目录
                        </button>
                      )}
                    </div>
                    <div className="flex flex-wrap gap-1.5">
                      {r.attachments.map((att, i) => (
                        <span key={i} className={`text-[10px] px-1.5 py-0.5 rounded ${
                          att.downloaded
                            ? "bg-green-500/10 text-green-400 border border-green-500/20"
                            : "bg-red-500/10 text-red-400 border border-red-500/20"
                        }`} title={!att.downloaded ? att.reason : ""}>
                          {att.downloaded ? "\u2705" : "\u274C"} {att.name}
                          {att.downloaded && att.size ? ` (${formatFileSize(att.size)})` : ""}
                        </span>
                      ))}
                    </div>
                    {r.attachments.some(a => !a.downloaded) && (
                      <p className="text-[10px] text-red-400/70 mt-1">
                        {r.attachments.find(a => !a.downloaded)?.reason || "部分附件无法下载"}
                      </p>
                    )}
                  </div>
                )}
                {r.status === "completed" && (!r.attachments || r.attachments.length === 0) && (
                  <p className="text-[10px] text-zinc-600 mt-1">无附件</p>
                )}
                {r.status === "suspended" && r.error_message && (
                  <div className="mt-2 p-2 bg-orange-500/5 border border-orange-500/20 rounded text-xs text-orange-300">
                    <span className="font-medium">⏸ 等待补充:</span> {r.error_message.replace(/^待补充:\s*/, "")}
                  </div>
                )}
                {r.status === "failed" && r.error_message && (
                  <p className="text-xs text-red-400 mt-2">{r.error_message}</p>
                )}
                {r.analysis_summary && !isExpanded && (
                  <p className="text-xs text-zinc-400 mt-2 line-clamp-2">{r.analysis_summary}</p>
                )}
              </div>
              {isExpanded && (
                <div className="border-t border-zinc-800 p-4">
                  <pre className="text-xs text-zinc-400 whitespace-pre-wrap leading-relaxed max-h-96 overflow-y-auto">{report}</pre>
                  {r.local_dir && (
                    <p className="text-[10px] text-zinc-600 mt-3">本地目录: <code className="text-zinc-500">{r.local_dir}</code></p>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
