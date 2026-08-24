import React, { useState, useEffect, useRef } from "react";
import { getApiUrl } from "../services/gateway.js";
import Markdown from "../components/Markdown.jsx";

// ---------- helpers ----------

const CATEGORY_COLORS = {
  "非问题":   "text-zinc-400 bg-zinc-700/40",
  "UI 问题":  "text-purple-300 bg-purple-500/20",
  "代码问题": "text-red-300 bg-red-500/20",
  "其他":     "text-amber-300 bg-amber-500/20",
};

const STATUS_COLORS = {
  pending:    "text-zinc-400 bg-zinc-700/40",
  running:    "text-blue-300 bg-blue-500/20",
  succeeded:  "text-green-300 bg-green-500/20",
  failed:     "text-red-300 bg-red-500/20",
};

function formatTime(s) {
  if (!s) return "-";
  try {
    const d = new Date(s);
    return d.toLocaleString("zh-CN", { hour12: false });
  } catch { return s; }
}

async function api(method, path, body) {
  const opts = { method };
  if (body) {
    opts.headers = { "Content-Type": "application/json" };
    opts.body = JSON.stringify(body);
  }
  const r = await fetch(getApiUrl(path), opts);
  if (!r.ok) {
    const txt = await r.text().catch(() => "");
    throw new Error(`${r.status} ${txt}`);
  }
  return r.json();
}

// ---------- main ----------

export default function BugAnalysis() {
  const [tab, setTab] = useState("submit"); // submit / cases / packages
  const [tasks, setTasks] = useState([]);
  const [packages, setPackages] = useState([]);
  const [cases, setCases] = useState({ items: [], total: 0 });
  const [filterPkg, setFilterPkg] = useState("");
  const [filterCategory, setFilterCategory] = useState("");
  const [selected, setSelected] = useState(null); // { report, case, evidences }
  const [toast, setToast] = useState(null);
  const pollRef = useRef(null);

  function showToast(msg, ok = true) {
    setToast({ msg, ok });
    setTimeout(() => setToast(null), 3000);
  }

  // ---- initial & polling ----
  useEffect(() => {
    refreshAll();
    const t = setInterval(refreshAll, 10000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    if (tab === "cases") refreshCases();
  }, [tab, filterPkg, filterCategory]);

  async function refreshAll() {
    try {
      const [ts, pkgs] = await Promise.all([
        api("GET", "/api/bug/tasks?limit=30"),
        api("GET", "/api/bug/packages"),
      ]);
      setTasks(Array.isArray(ts) ? ts : []);
      setPackages(Array.isArray(pkgs) ? pkgs : []);
    } catch { /* 忽略网关短暂不可达 */ }
  }

  async function refreshCases() {
    try {
      const qs = new URLSearchParams();
      if (filterPkg) qs.set("pkg", filterPkg);
      if (filterCategory) qs.set("category", filterCategory);
      qs.set("limit", "100");
      const r = await api("GET", `/api/bug/cases?${qs}`);
      setCases(r);
    } catch (e) { showToast(`加载失败: ${e.message}`, false); }
  }

  async function viewReport(task) {
    if (!task.result_ref || !task.result_ref.startsWith("report:")) {
      showToast("该任务暂无报告（可能正在运行或失败）", false);
      return;
    }
    const reportId = task.result_ref.slice("report:".length);
    await openReport({ report_id: reportId, package_name: task.package_name, tb_id: task.tb_id });
  }

  async function viewCaseReport(c) {
    try {
      const info = await api("GET", `/api/bug/case/${encodeURIComponent(c.tb_id)}`);
      // 根据 case 查 report：从 tasks 或直接扫最新 report（简化：重复用 task 路径，查 task_state）
      const allTasks = await api("GET", "/api/bug/tasks?limit=200");
      const t = allTasks.find((x) => x.tb_id === c.tb_id);
      if (!t || !t.result_ref) { showToast("该 case 暂无报告", false); return; }
      const reportId = t.result_ref.slice("report:".length);
      await openReport({ report_id: reportId, package_name: c.package_name, tb_id: c.tb_id, caseInfo: info });
    } catch (e) { showToast(`失败: ${e.message}`, false); }
  }

  async function openReport({ report_id, package_name, tb_id, caseInfo }) {
    try {
      const report = await api("GET", `/api/bug/report/${report_id}?pkg=${encodeURIComponent(package_name)}`);
      const info = caseInfo || await api("GET", `/api/bug/case/${encodeURIComponent(tb_id)}`);
      setSelected({ report, info, package_name });
    } catch (e) { showToast(`失败: ${e.message}`, false); }
  }

  async function submitRating(score) {
    if (!selected) return;
    try {
      await api("POST", "/api/bug/rate", {
        report_id: selected.report.id,
        pkg: selected.package_name,
        score,
        rater_id: "web-user",
        channel: "web",
      });
      showToast(`已评 ${score} 星，感谢反馈`);
    } catch (e) { showToast(`评分失败: ${e.message}`, false); }
  }

  return (
    <div className="h-full flex flex-col bg-[#0f0f10] text-zinc-200">
      {/* 顶部 Tab */}
      <div className="shrink-0 flex items-center justify-between border-b border-zinc-800 px-4">
        <div className="flex">
          {[
            { id: "submit", label: "提交分析" },
            { id: "cases", label: "案例库" },
            { id: "packages", label: "包统计" },
          ].map((t) => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={`px-4 py-3 text-sm border-b-2 transition ${
                tab === t.id ? "border-blue-500 text-white" : "border-transparent text-zinc-500 hover:text-zinc-300"
              }`}
            >{t.label}</button>
          ))}
        </div>
        <div className="text-xs text-zinc-500">
          当前 {tasks.length} 条近期任务 · {packages.length} 个应用
        </div>
      </div>

      {/* Tab 内容 */}
      <div className="flex-1 overflow-hidden flex">
        <div className="flex-1 overflow-auto p-4">
          {tab === "submit" && (
            <SubmitTab
              tasks={tasks}
              onSubmitted={() => { refreshAll(); showToast("分析任务已创建"); }}
              onShowToast={showToast}
              onViewReport={viewReport}
            />
          )}
          {tab === "cases" && (
            <CasesTab
              cases={cases}
              packages={packages}
              filterPkg={filterPkg}
              filterCategory={filterCategory}
              onFilterPkg={setFilterPkg}
              onFilterCategory={setFilterCategory}
              onView={viewCaseReport}
            />
          )}
          {tab === "packages" && (
            <PackagesTab packages={packages} onPick={(p) => { setFilterPkg(p); setTab("cases"); }} />
          )}
        </div>

        {/* 侧边报告详情 */}
        {selected && (
          <ReportDetail
            selected={selected}
            onClose={() => setSelected(null)}
            onRate={submitRating}
          />
        )}
      </div>

      {/* Toast */}
      {toast && (
        <div className={`fixed bottom-4 right-4 px-4 py-2 rounded-lg text-sm shadow-lg z-50 ${
          toast.ok ? "bg-green-600 text-white" : "bg-red-600 text-white"
        }`}>{toast.msg}</div>
      )}
    </div>
  );
}

// ========== SubmitTab ==========

function SubmitTab({ tasks, onSubmitted, onShowToast, onViewReport }) {
  const [form, setForm] = useState({
    tb_id: "",
    package_name: "",
    title: "",
    raw_content: "",
    log_attachment: "",
    reporter_id: "",
  });
  const [submitting, setSubmitting] = useState(false);
  const [showTbImport, setShowTbImport] = useState(false);

  function upd(k, v) { setForm((s) => ({ ...s, [k]: v })); }

  function handleTbPreviewSelected(preview) {
    setForm({
      tb_id: preview.tb_id || "",
      package_name: preview.package_name || "",
      title: preview.title || "",
      raw_content: preview.raw_content || "",
      log_attachment: preview.log_attachment || "",
      reporter_id: preview.reporter_id || "",
    });
    setShowTbImport(false);
    const warns = preview._meta?.warnings || [];
    if (warns.length > 0) {
      onShowToast(`已导入（${warns.length} 条提示）：${warns[0]}`, true);
    } else {
      onShowToast("已导入 TB 任务数据，请检查后提交", true);
    }
  }

  async function submit() {
    if (!form.tb_id || !form.package_name || !form.title || !form.raw_content) {
      onShowToast("tb_id / package_name / title / raw_content 均为必填", false);
      return;
    }
    setSubmitting(true);
    try {
      await api("POST", "/api/bug/analyze", form);
      setForm({ tb_id: "", package_name: "", title: "", raw_content: "", log_attachment: "", reporter_id: "" });
      onSubmitted();
    } catch (e) { onShowToast(`提交失败: ${e.message}`, false); }
    finally { setSubmitting(false); }
  }

  return (
    <div className="max-w-6xl mx-auto space-y-6">
      {/* 表单 */}
      <section className="bg-zinc-900 border border-zinc-800 rounded-xl p-5">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-base font-semibold">提交 Bug 分析</h2>
          <button
            onClick={() => setShowTbImport(true)}
            className="px-3 py-1.5 text-xs rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-200 border border-zinc-700 flex items-center gap-1.5"
            title="从 TB 任务读取问题描述与附件，自动填充表单"
          >
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4 16v2a2 2 0 002 2h12a2 2 0 002-2v-2M7 10l5 5 5-5M12 15V3" />
            </svg>
            从 TB 任务导入
          </button>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label="TB 单 ID *" value={form.tb_id} onChange={(v) => upd("tb_id", v)} placeholder="TB-12345" />
          <Field label="应用包名 *" value={form.package_name} onChange={(v) => upd("package_name", v)} placeholder="com.xxx.music" />
          <Field label="标题 *" value={form.title} onChange={(v) => upd("title", v)} placeholder="打开应用后闪退" span={2} />
          <Textarea label="Bug 正文 *" value={form.raw_content} onChange={(v) => upd("raw_content", v)} placeholder="复现步骤、期望行为、实际现象..." rows={5} span={2} />
          <Textarea label="日志附件（可选）" value={form.log_attachment} onChange={(v) => upd("log_attachment", v)} placeholder="粘贴 logcat / ANR trace / dumpsys 等" rows={6} span={2} mono />
          <Field label="提单人（可选）" value={form.reporter_id} onChange={(v) => upd("reporter_id", v)} placeholder="alice@example.com" span={2} />
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <button
            onClick={() => setForm({ tb_id: "", package_name: "", title: "", raw_content: "", log_attachment: "", reporter_id: "" })}
            className="px-4 py-2 text-xs rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-300"
          >清空</button>
          <button
            onClick={submit}
            disabled={submitting}
            className="px-4 py-2 text-xs rounded-lg bg-blue-600 hover:bg-blue-500 disabled:bg-blue-800 text-white"
          >{submitting ? "提交中..." : "开始分析"}</button>
        </div>
      </section>

      {/* 任务列表 */}
      <section className="bg-zinc-900 border border-zinc-800 rounded-xl p-5">
        <h2 className="text-base font-semibold mb-4">最近任务</h2>
        {tasks.length === 0 ? (
          <div className="text-xs text-zinc-500 text-center py-8">暂无任务</div>
        ) : (
          <div className="space-y-2">
            {tasks.map((t) => <TaskRow key={t.task_id} t={t} onClick={() => onViewReport(t)} />)}
          </div>
        )}
      </section>

      {showTbImport && (
        <TbImportModal
          onClose={() => setShowTbImport(false)}
          onPicked={handleTbPreviewSelected}
          onShowToast={onShowToast}
        />
      )}
    </div>
  );
}

// ========== TbImportModal ==========

function TbImportModal({ onClose, onPicked, onShowToast }) {
  const [list, setList] = useState([]);
  const [loading, setLoading] = useState(true);
  const [keyword, setKeyword] = useState("");
  const [previewing, setPreviewing] = useState(null); // tb id 正在拉取
  const [error, setError] = useState("");

  // 实时拉取（按单号从平台拉）
  const [fetchInput, setFetchInput] = useState("");
  const [fetching, setFetching] = useState(false);

  useEffect(() => {
    let cancel = false;
    setLoading(true); setError("");
    api("GET", "/api/bug/tb-import/list?limit=100")
      .then((r) => { if (!cancel) setList(Array.isArray(r) ? r : []); })
      .catch((e) => { if (!cancel) setError(e.message); })
      .finally(() => { if (!cancel) setLoading(false); });
    return () => { cancel = true; };
  }, []);

  async function handlePick(item) {
    setPreviewing(item.id);
    try {
      const tbId = encodeURIComponent(item.id || item.carb_id);
      const preview = await api("GET", `/api/bug/tb-import/${tbId}/preview`);
      onPicked(preview);
    } catch (e) {
      onShowToast(`拉取 TB 任务失败: ${e.message}`, false);
    } finally {
      setPreviewing(null);
    }
  }

  async function handleFetchById() {
    const tb_id = fetchInput.trim();
    if (!tb_id) return;
    setFetching(true);
    try {
      const preview = await api("POST", "/api/bug/tb-import/fetch", { tb_id });
      onPicked(preview);
    } catch (e) {
      const msg = e.message.includes("404") || /TB_NOT_FOUND/i.test(e.message)
        ? `未在 Teambition 找到该单：${tb_id}`
        : `拉取失败: ${e.message}`;
      onShowToast(msg, false);
    } finally {
      setFetching(false);
    }
  }

  const filtered = keyword.trim()
    ? list.filter((x) => {
        const k = keyword.trim().toLowerCase();
        return (x.title || "").toLowerCase().includes(k)
            || (x.carb_id || "").toLowerCase().includes(k)
            || (x.id || "").toLowerCase().includes(k)
            || (x.executor_name || "").toLowerCase().includes(k);
      })
    : list;

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/70" onClick={onClose}>
      <div
        className="bg-zinc-900 border border-zinc-700 rounded-xl w-[860px] max-h-[80vh] flex flex-col shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="shrink-0 px-5 py-3 border-b border-zinc-800 flex items-center justify-between">
          <div>
            <h3 className="text-sm font-semibold text-zinc-100">从 TB 任务导入</h3>
            <p className="text-xs text-zinc-500 mt-0.5">
              输入 TB 单号实时从平台拉取，或从下方已扫过的列表选择（不会修改 TB 任务状态）
            </p>
          </div>
          <button onClick={onClose} className="text-zinc-500 hover:text-zinc-300 text-lg leading-none">×</button>
        </div>

        {/* 实时按单号拉取（主入口） */}
        <div className="shrink-0 px-5 py-3 border-b border-zinc-800 bg-zinc-950/50">
          <div className="flex items-center gap-2">
            <span className="text-xs text-zinc-400 shrink-0">单号：</span>
            <input
              type="text"
              value={fetchInput}
              onChange={(e) => setFetchInput(e.target.value)}
              placeholder="CARB-12345 / 12345 / Teambition ObjectId"
              className="flex-1 bg-zinc-950 border border-zinc-700 rounded px-3 py-2 text-sm text-zinc-200 placeholder-zinc-600 outline-none focus:border-zinc-500 font-mono"
              onKeyDown={(e) => e.key === "Enter" && !fetching && handleFetchById()}
            />
            <button
              onClick={handleFetchById}
              disabled={!fetchInput.trim() || fetching}
              className="shrink-0 px-3 py-2 text-xs rounded bg-blue-600 hover:bg-blue-500 disabled:bg-blue-800 disabled:text-blue-400 text-white"
            >
              {fetching ? "拉取中..." : "从平台拉取"}
            </button>
          </div>
          <p className="text-[11px] text-zinc-600 mt-1.5">
            会调 Teambition API 拉单子内容 + 下载日志类附件（.log/.txt/.anr/.dump 等），最大 10 MB / 附件
          </p>
        </div>

        {/* 旧路径：本地已记录的列表（次要入口） */}
        <div className="shrink-0 px-5 py-2 border-b border-zinc-800">
          <input
            type="text"
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
            placeholder="或从已扫过的本地列表中过滤..."
            className="w-full bg-zinc-950 border border-zinc-700 rounded px-3 py-1.5 text-xs text-zinc-200 placeholder-zinc-600 outline-none focus:border-zinc-500"
          />
        </div>

        <div className="flex-1 overflow-auto">
          {loading && <div className="px-5 py-10 text-center text-xs text-zinc-500">加载中...</div>}
          {error && <div className="px-5 py-10 text-center text-xs text-red-400">{error}</div>}
          {!loading && !error && filtered.length === 0 && (
            <div className="px-5 py-10 text-center text-xs text-zinc-500">无匹配 TB 任务</div>
          )}
          {!loading && !error && filtered.length > 0 && (
            <table className="w-full text-sm">
              <thead className="bg-zinc-950 text-xs text-zinc-500 sticky top-0">
                <tr>
                  <th className="text-left px-3 py-2">CARB</th>
                  <th className="text-left px-3 py-2">标题</th>
                  <th className="text-left px-3 py-2">项目</th>
                  <th className="text-left px-3 py-2">执行人</th>
                  <th className="text-center px-3 py-2">附件</th>
                  <th className="text-right px-3 py-2">检测时间</th>
                  <th className="text-right px-3 py-2"></th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((item) => (
                  <tr key={item.id} className="border-t border-zinc-800 hover:bg-zinc-800/40">
                    <td className="px-3 py-2 font-mono text-xs text-zinc-400">{item.carb_id || "-"}</td>
                    <td className="px-3 py-2 text-zinc-300 truncate max-w-[260px]">{item.title}</td>
                    <td className="px-3 py-2 text-xs text-zinc-500">{item.project_name || "-"}</td>
                    <td className="px-3 py-2 text-xs text-zinc-500">{item.executor_name || "-"}</td>
                    <td className="px-3 py-2 text-center text-xs">
                      {item.has_attachments ? <span className="text-green-400">✓</span> : <span className="text-zinc-600">-</span>}
                    </td>
                    <td className="px-3 py-2 text-right text-xs text-zinc-500">{formatTime(item.detected_at)}</td>
                    <td className="px-3 py-2 text-right">
                      <button
                        onClick={() => handlePick(item)}
                        disabled={previewing === item.id}
                        className="px-2.5 py-1 text-xs rounded bg-blue-600 hover:bg-blue-500 disabled:bg-blue-800 text-white"
                      >
                        {previewing === item.id ? "导入中..." : "导入"}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        <div className="shrink-0 px-5 py-3 border-t border-zinc-800 flex items-center justify-between">
          <span className="text-xs text-zinc-500">共 {filtered.length} 条</span>
          <button onClick={onClose} className="px-3 py-1.5 text-xs rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-300">取消</button>
        </div>
      </div>
    </div>
  );
}

function Field({ label, value, onChange, placeholder, span = 1 }) {
  return (
    <div style={{ gridColumn: `span ${span} / span ${span}` }}>
      <label className="block text-xs text-zinc-400 mb-1">{label}</label>
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="w-full bg-zinc-950 border border-zinc-700 rounded px-3 py-2 text-sm text-zinc-200 placeholder-zinc-600 outline-none focus:border-zinc-500"
      />
    </div>
  );
}
function Textarea({ label, value, onChange, placeholder, rows = 3, span = 1, mono = false }) {
  return (
    <div style={{ gridColumn: `span ${span} / span ${span}` }}>
      <label className="block text-xs text-zinc-400 mb-1">{label}</label>
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        rows={rows}
        className={`w-full bg-zinc-950 border border-zinc-700 rounded px-3 py-2 text-sm text-zinc-200 placeholder-zinc-600 outline-none focus:border-zinc-500 resize-y ${mono ? "font-mono text-xs" : ""}`}
      />
    </div>
  );
}

function TaskRow({ t, onClick }) {
  return (
    <div
      onClick={onClick}
      className="flex items-center gap-3 px-3 py-2.5 bg-zinc-950 border border-zinc-800 rounded hover:border-zinc-600 cursor-pointer transition"
    >
      <span className={`shrink-0 text-xs px-2 py-0.5 rounded ${STATUS_COLORS[t.status] || "bg-zinc-700"}`}>
        {t.status}
      </span>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 text-sm">
          <span className="font-mono text-zinc-400">{t.tb_id}</span>
          {t.title && <span className="truncate text-zinc-300">· {t.title}</span>}
        </div>
        <div className="text-xs text-zinc-500 mt-0.5">
          {t.package_name || "-"}
          {t.category && <span className={`ml-2 px-1.5 py-0.5 rounded ${CATEGORY_COLORS[t.category] || ""}`}>{t.category}</span>}
          {t.degraded && <span className="ml-2 text-amber-400">⚠ 降级</span>}
          {t.error_code && <span className="ml-2 text-red-400">✗ {t.error_code}</span>}
          <span className="ml-3 text-zinc-600">{formatTime(t.updated_at)}</span>
        </div>
      </div>
      <span className="shrink-0 text-xs text-blue-400 hover:text-blue-300">查看 →</span>
    </div>
  );
}

// ========== CasesTab ==========

function CasesTab({ cases, packages, filterPkg, filterCategory, onFilterPkg, onFilterCategory, onView }) {
  return (
    <div className="max-w-6xl mx-auto space-y-4">
      <div className="flex items-center gap-3">
        <select
          value={filterPkg}
          onChange={(e) => onFilterPkg(e.target.value)}
          className="bg-zinc-900 border border-zinc-700 rounded px-3 py-2 text-sm text-zinc-200"
        >
          <option value="">全部应用</option>
          {packages.map((p) => (
            <option key={p.package_name} value={p.package_name}>{p.package_name} ({p.case_count})</option>
          ))}
        </select>
        <select
          value={filterCategory}
          onChange={(e) => onFilterCategory(e.target.value)}
          className="bg-zinc-900 border border-zinc-700 rounded px-3 py-2 text-sm text-zinc-200"
        >
          <option value="">全部类别</option>
          <option value="代码问题">代码问题</option>
          <option value="UI 问题">UI 问题</option>
          <option value="非问题">非问题</option>
          <option value="其他">其他</option>
        </select>
        <div className="ml-auto text-xs text-zinc-500">共 {cases.total} 条</div>
      </div>

      <div className="bg-zinc-900 border border-zinc-800 rounded-xl overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-zinc-950 text-xs text-zinc-500">
            <tr>
              <th className="text-left px-3 py-2">TB 单</th>
              <th className="text-left px-3 py-2">包名</th>
              <th className="text-left px-3 py-2">类别</th>
              <th className="text-right px-3 py-2">置信度</th>
              <th className="text-left px-3 py-2">标题</th>
              <th className="text-right px-3 py-2">时间</th>
            </tr>
          </thead>
          <tbody>
            {cases.items.length === 0 && (
              <tr><td colSpan={6} className="text-center py-6 text-xs text-zinc-500">无匹配 case</td></tr>
            )}
            {cases.items.map((c) => (
              <tr
                key={c.id}
                onClick={() => onView(c)}
                className="border-t border-zinc-800 hover:bg-zinc-800/40 cursor-pointer"
              >
                <td className="px-3 py-2 font-mono text-zinc-400">{c.tb_id}</td>
                <td className="px-3 py-2 text-zinc-400">{c.package_name}</td>
                <td className="px-3 py-2">
                  {c.category && <span className={`text-xs px-2 py-0.5 rounded ${CATEGORY_COLORS[c.category] || ""}`}>
                    {c.category}{c.sub_category && `/${c.sub_category}`}
                  </span>}
                  {c.suspicious_prompt_injection ? <span className="ml-2 text-xs text-amber-400">⚠</span> : null}
                </td>
                <td className="px-3 py-2 text-right text-zinc-300">
                  {c.confidence != null ? `${(c.confidence * 100).toFixed(0)}%` : "-"}
                </td>
                <td className="px-3 py-2 truncate max-w-[300px] text-zinc-300">{c.title}</td>
                <td className="px-3 py-2 text-right text-xs text-zinc-500">{formatTime(c.analyzed_at || c.created_at)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ========== PackagesTab ==========

function PackagesTab({ packages, onPick }) {
  return (
    <div className="max-w-4xl mx-auto">
      <div className="bg-zinc-900 border border-zinc-800 rounded-xl overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-zinc-950 text-xs text-zinc-500">
            <tr>
              <th className="text-left px-3 py-2">包名</th>
              <th className="text-right px-3 py-2">case 数</th>
              <th className="text-right px-3 py-2">最近提交</th>
            </tr>
          </thead>
          <tbody>
            {packages.length === 0 && (
              <tr><td colSpan={3} className="text-center py-6 text-xs text-zinc-500">暂无数据</td></tr>
            )}
            {packages.map((p) => (
              <tr
                key={p.package_name}
                onClick={() => onPick(p.package_name)}
                className="border-t border-zinc-800 hover:bg-zinc-800/40 cursor-pointer"
              >
                <td className="px-3 py-2 font-mono text-zinc-300">{p.package_name}</td>
                <td className="px-3 py-2 text-right text-zinc-300">{p.case_count}</td>
                <td className="px-3 py-2 text-right text-xs text-zinc-500">{formatTime(p.last_seen)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ========== ReportDetail ==========

function ReportDetail({ selected, onClose, onRate }) {
  const { report, info, package_name } = selected;
  const [myScore, setMyScore] = useState(0);
  const caseInfo = info.case;

  return (
    <aside className="w-[520px] shrink-0 border-l border-zinc-800 bg-[#141416] flex flex-col overflow-hidden">
      <div className="shrink-0 px-4 py-3 border-b border-zinc-800 flex items-start justify-between">
        <div className="min-w-0">
          <div className="text-xs text-zinc-500 font-mono">{caseInfo?.tb_id}</div>
          <div className="text-sm font-medium text-zinc-100 truncate">{caseInfo?.title || "(无标题)"}</div>
          <div className="mt-1 flex items-center gap-2">
            {caseInfo?.category && (
              <span className={`text-xs px-2 py-0.5 rounded ${CATEGORY_COLORS[caseInfo.category] || ""}`}>
                {caseInfo.category}{caseInfo.sub_category && ` / ${caseInfo.sub_category}`}
              </span>
            )}
            {caseInfo?.confidence != null && (
              <span className="text-xs text-zinc-400">置信度 {(caseInfo.confidence * 100).toFixed(0)}%</span>
            )}
            {report.is_degraded && <span className="text-xs text-amber-400">⚠ 降级</span>}
          </div>
        </div>
        <button onClick={onClose} className="text-zinc-500 hover:text-zinc-300 text-lg leading-none">×</button>
      </div>

      <div className="flex-1 overflow-auto p-4 space-y-4">
        {/* Markdown 报告 */}
        <div className="prose-sm prose-invert max-w-none">
          <Markdown>{report.content}</Markdown>
        </div>

        {/* 证据详情 —— 取代旧的"证据引用"折叠列表 */}
        {Array.isArray(info.evidences) && info.evidences.length > 0 && (
          <div className="space-y-2">
            <div className="text-xs text-zinc-400">
              证据详情（{info.evidences.length} 条 · 报告中的 [e:N] 即对应这里的 ID）
            </div>
            {info.evidences.map((ev) => <EvidenceCard key={ev.id} ev={ev} />)}
          </div>
        )}

        {report.matched_rules && report.matched_rules.length > 0 && (
          <details className="bg-zinc-950 border border-zinc-800 rounded p-3">
            <summary className="text-xs text-zinc-400 cursor-pointer">命中规则</summary>
            <div className="mt-2 space-y-1 text-xs font-mono text-zinc-500">
              {report.matched_rules.map((r, i) => <div key={i}>{String(r)}</div>)}
            </div>
          </details>
        )}
      </div>

      {/* 评分 */}
      <div className="shrink-0 border-t border-zinc-800 p-3 flex items-center justify-between">
        <div className="flex items-center gap-1">
          {[1, 2, 3, 4, 5].map((s) => (
            <button
              key={s}
              onClick={() => { setMyScore(s); onRate(s); }}
              onMouseEnter={() => setMyScore(s)}
              onMouseLeave={() => setMyScore(0)}
              className={`text-lg transition ${s <= myScore ? "text-amber-400" : "text-zinc-600 hover:text-amber-500"}`}
              title={`${s} 星`}
            >★</button>
          ))}
          <span className="ml-2 text-xs text-zinc-500">点击星评分</span>
        </div>
        <div className="text-xs text-zinc-600">report #{report.id} · {package_name}</div>
      </div>
    </aside>
  );
}

// ========== EvidenceCard ==========

const SOURCE_TYPE_COLORS = {
  tb_content:  "bg-blue-500/15 text-blue-300 border-blue-500/30",
  logcat:      "bg-amber-500/15 text-amber-300 border-amber-500/30",
  anr_trace:   "bg-red-500/15 text-red-300 border-red-500/30",
  dumpsys:     "bg-purple-500/15 text-purple-300 border-purple-500/30",
  systrace:    "bg-cyan-500/15 text-cyan-300 border-cyan-500/30",
  screenshot:  "bg-pink-500/15 text-pink-300 border-pink-500/30",
};

function formatBytes(n) {
  if (!n) return "0 B";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function EvidenceCard({ ev }) {
  const [open, setOpen] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const ownerOk = ev.owner_package && ev.owner_package !== "unknown";
  const colorCls = SOURCE_TYPE_COLORS[ev.source_type] || "bg-zinc-700/40 text-zinc-300 border-zinc-700";

  async function handleDownload() {
    setDownloading(true);
    try {
      // 第一步：换签名短链
      const r = await api("GET", `/api/bug/evidence/${ev.id}?uid=web-user`);
      const url = `${r.url}&pkg=${encodeURIComponent(ev.owner_package || "unknown")}`;
      // 在新窗口打开下载（gateway 会校验 token + 流式返回归档文件）
      window.open(getApiUrl(url), "_blank");
    } catch (e) {
      alert(`下载失败: ${e.message}`);
    } finally {
      setDownloading(false);
    }
  }

  return (
    <div className="bg-zinc-950 border border-zinc-800 rounded">
      <div
        className="px-3 py-2 flex items-center gap-2 cursor-pointer hover:bg-zinc-900"
        onClick={() => setOpen((s) => !s)}
      >
        <span className="text-xs font-mono text-zinc-300">[e:{ev.id}]</span>
        <span className={`text-[11px] px-1.5 py-0.5 rounded border ${colorCls}`}>
          {ev.source_type}
        </span>
        <span className="text-xs text-zinc-500">{formatBytes(ev.text_length)}</span>
        {ev.line_start && (
          <span className="text-xs text-zinc-600">L{ev.line_start}{ev.line_end ? `-${ev.line_end}` : ""}</span>
        )}
        <span className={`ml-auto text-xs ${ownerOk ? "text-zinc-500" : "text-amber-400"}`}>
          {ev.owner_package || "unknown"}
          {ev.ownership_confidence != null && (
            <span className="ml-1 text-zinc-600">{(ev.ownership_confidence * 100).toFixed(0)}%</span>
          )}
        </span>
        <span className="text-xs text-zinc-600">{open ? "▼" : "▶"}</span>
      </div>

      {open && (
        <div className="border-t border-zinc-800 px-3 py-2.5 space-y-2">
          <div className="flex items-center gap-3 text-xs">
            <span className="text-zinc-500">sha256:</span>
            <span className="font-mono text-zinc-600 truncate">{ev.source_sha256?.slice(0, 16)}...</span>
            <button
              onClick={handleDownload}
              disabled={downloading}
              className="ml-auto px-2 py-0.5 text-[11px] rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-300 disabled:opacity-50"
              title="生成签名短链下载完整原始素材"
            >
              {downloading ? "..." : "下载原文"}
            </button>
          </div>
          <pre className="text-[11px] font-mono text-zinc-400 bg-black/40 rounded p-2 overflow-x-auto max-h-[280px] whitespace-pre-wrap">
{ev.preview || "(无文本预览)"}
{ev.truncated && "\n\n... [已截断，下载原文查看完整内容]"}
          </pre>
        </div>
      )}
    </div>
  );
}
