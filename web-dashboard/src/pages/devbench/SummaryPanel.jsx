/**
 * 总结面板：根据 我与 AI 的对话记录 + Git 提交记录 生成 周报/月报/季度绩效/年度绩效。
 * 快速路径默认输出 txt + Markdown；Word/PDF 由用户按需启用，不自动 git add。
 * 输出工程路径默认取「在此开发」悬浮窗(DevMode)配置的工程路径，可在面板内修改并记忆，不再隐式绑定当前故事点主工程。
 */
import React, { useState, useRef, useEffect } from "react";
import { devbenchApi } from "./api.js";
import { createGatewayWebSocket } from "../../services/gateway.js";
import {
  defaultCustomSummaryRange,
  summaryRequestErrorMessage,
} from "./summaryRangeModel.js";
import {
  DEFAULT_WEEKLY_TEMPLATE,
  addCustomSummaryTemplate,
  hasSummaryOutputMode,
  normalizeCustomSummaryTemplates,
  summaryResultFiles,
} from "./summaryOptionsModel.js";

const REPORTS = [
  { key: "week", label: "周报总结报告", desc: "本周（周一~周日）工作", perf: false, icon: "🗓" },
  { key: "month", label: "月度总结报告", desc: "本月工作", perf: false, icon: "📅" },
  { key: "quarter", label: "季度绩效总结报告", desc: "本季度绩效（可填模板）", perf: true, icon: "📈" },
  { key: "year", label: "年度绩效总结报告", desc: "本年度绩效（可填模板）", perf: true, icon: "🏆" },
  { key: "custom", label: "自定义日期总结", desc: "指定起止日期的工作总结", perf: false, icon: "🎯" },
];

const SUMMARY_PROJ_KEY = "devbench_summary_project";
const SUMMARY_TEMPLATES_KEY = "devbench_summary_templates";

const ENGINE_LABEL = {
  claude: "Claude", "claude-volcengine": "Claude(方舟)", "claude-proxy": "Claude(中心代理)",
  "claude-atlas": "Claude Code(Atlas)", codex: "Codex", "codex-atlas": "Codex CLI(Atlas)",
  gemini: "Gemini", hermes: "Hermes", "hermes-atlas": "Hermes(Atlas)", volcengine: "火山方舟", deepseek: "DeepSeek", qwen: "通义千问", kimi: "Kimi",
};
const engineLabel = (eng) => ENGINE_LABEL[eng] || eng || "AI";
const snapshotLabel = (s) => {
  if (!s) return "";
  const m = s.model ? `模型:${s.model}` : "";
  const t = s.tier ? `档位:${s.tier}` : "";
  return [m, t].filter(Boolean).join(" · ");
};
const formatDuration = (ms) => ms == null ? "—" : ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
const formatBytes = (bytes) => bytes >= 1024 * 1024
  ? `${(bytes / 1024 / 1024).toFixed(1)}MB`
  : `${Math.round((bytes || 0) / 1024)}KB`;
// 工作总结输出工程路径：优先用户上次在本面板填的；否则取「在此开发」悬浮窗(DevMode, localStorage devmode_session)配置的工程路径。
function initSummaryProject() {
  try { const saved = localStorage.getItem(SUMMARY_PROJ_KEY); if (saved && saved.trim()) return saved.trim(); } catch {}
  try { const dm = JSON.parse(localStorage.getItem("devmode_session") || "null"); if (dm && dm.localPath) return String(dm.localPath).trim(); } catch {}
  return "";
}

function initSummaryTemplates() {
  try {
    const saved = JSON.parse(localStorage.getItem(SUMMARY_TEMPLATES_KEY) || "[]");
    return [DEFAULT_WEEKLY_TEMPLATE, ...normalizeCustomSummaryTemplates(saved)];
  } catch {
    return [DEFAULT_WEEKLY_TEMPLATE];
  }
}

export default function SummaryPanel({ tabId, onClose, onToast }) {
  const [busy, setBusy] = useState("");
  const [templates, setTemplates] = useState(initSummaryTemplates);
  const [templateId, setTemplateId] = useState(DEFAULT_WEEKLY_TEMPLATE.id);
  const [template, setTemplate] = useState(DEFAULT_WEEKLY_TEMPLATE.content);
  const [uploadingTemplate, setUploadingTemplate] = useState(false);
  const [result, setResult] = useState(null);
  const [err, setErr] = useState("");
  const [backing, setBacking] = useState(false);
  const [projectPath, setProjectPath] = useState(initSummaryProject);
  const [outputModes, setOutputModes] = useState({ concise: true, report: false });
  const [includeRichExports, setIncludeRichExports] = useState(false);
  const [selectedModel, setSelectedModel] = useState("");
  const [selectedTier, setSelectedTier] = useState("");
  // 自定义日期范围（period=custom 时使用）
  const initialCustomRange = useRef(defaultCustomSummaryRange()).current;
  const [customSince, setCustomSince] = useState(initialCustomRange.since);
  const [customUntil, setCustomUntil] = useState(initialCustomRange.until);
  // 右侧实时对话面板：流式显示 AI 的思考/回答与「当前用什么 AI 模型档位」
  const [live, setLive] = useState(null); // { engine, aiSnapshot, thinking, text, tools, toolOutput, streaming, startedAt, endedAt, error }
  // 生成前预览：将用来处理工作总结的 AI 引擎/模型/档位
  const [aiPreview, setAiPreview] = useState(null); // { engine, aiSnapshot, useProxy } | null
  const sessionIdRef = useRef("");
  const wsRef = useRef(null);
  const templateFileRef = useRef(null);

  // 打开面板时拉取一次「将使用的 AI」，让用户在点击生成前就知道会用哪个引擎/模型/档位
  useEffect(() => {
    let cancelled = false;
    devbenchApi.previewSummaryAi().then((r) => {
      if (cancelled || !r?.ok) return;
      setAiPreview({
        engine: r.engine,
        aiSnapshot: r.aiSnapshot,
        useProxy: r.useProxy,
        overridesSupported: r.overridesSupported !== false,
        catalog: r.catalog || { models: [], tiers: [] },
      });
      setSelectedModel((value) => value || r.aiSnapshot?.model || "");
      setSelectedTier((value) => value || r.aiSnapshot?.tier || "");
    }).catch(() => {});
    return () => { cancelled = true; };
  }, []);

  // 维护一条到网关的 WebSocket，订阅当前工作总结会话的流式事件（chat_stream / chat_stream_end / task_dispatched）
  useEffect(() => {
    let disposed = false;
    function connect() {
      if (disposed) return;
      let ws;
      try { ws = createGatewayWebSocket(); } catch { return; }
      wsRef.current = ws;
      ws.onopen = () => {
        if (disposed) return;
        const sid = sessionIdRef.current;
        if (sid) { try { ws.send(JSON.stringify({ type: "subscribe_session", sessionId: sid })); } catch {} }
      };
      ws.onmessage = (e) => {
        let msg; try { msg = JSON.parse(e.data); } catch { return; }
        const d = msg.data || {};
        const sid = sessionIdRef.current;
        if (!sid || d.sessionId !== sid) return; // 只处理当前工作总结会话的事件
        if (msg.type === "task_dispatched") {
          setLive((prev) => ({ ...(prev || freshLive()), engine: d.engine || (prev && prev.engine), streaming: true, startedAt: (prev && prev.startedAt) || Date.now() }));
        } else if (msg.type === "chat_stream") {
          const dt = d.deltaType || "text";
          const chunk = d.chunk == null ? "" : String(d.chunk);
          setLive((prev) => {
            const cur = prev || freshLive();
            const next = {
              ...cur,
              streaming: true,
              engine: d.engine || cur.engine,
              aiSnapshot: d.aiSnapshot || cur.aiSnapshot || null,
              startedAt: cur.startedAt || Date.now(),
              updatedAt: Date.now(),
            };
            if (dt === "status") next.status = chunk.trim();
            else if (dt === "thinking") { next.status = ""; next.thinking = cur.thinking + chunk; }
            else if (dt === "tool_use") { next.status = ""; next.tools = [...cur.tools, chunk]; }
            else if (dt === "tool_output") { next.status = ""; next.toolOutput = cur.toolOutput + chunk; }
            else if (dt !== "usage") { next.status = ""; next.text = cur.text + chunk; }
            return next;
          });
        } else if (msg.type === "chat_stream_end") {
          setLive((prev) => prev ? { ...prev, streaming: false, engine: d.engine || prev.engine, aiSnapshot: d.aiSnapshot || prev.aiSnapshot || null, endedAt: Date.now(), success: !!d.success } : prev);
        }
      };
      ws.onclose = () => { if (!disposed) setTimeout(connect, 2000); };
      ws.onerror = () => { try { ws.close(); } catch {} };
    }
    connect();
    return () => { disposed = true; try { wsRef.current && wsRef.current.close(); } catch {} wsRef.current = null; };
  }, []);

  function freshLive() {
    return { engine: "", aiSnapshot: null, status: "", thinking: "", text: "", tools: [], toolOutput: "", streaming: false, startedAt: null, endedAt: null, error: "" };
  }

  async function backupClaude() {
    setBacking(true); setErr("");
    const r = await devbenchApi.backupClaude();
    setBacking(false);
    if (r.ok) onToast?.(`Claude 会话已备份到 ${r.dir}（新增/更新 ${r.copied}，跳过 ${r.skipped}，共 ${r.total}）`);
    else setErr(r.error || "备份失败");
  }

  function chooseTemplate(id) {
    const selected = templates.find((item) => item.id === id) || DEFAULT_WEEKLY_TEMPLATE;
    setTemplateId(selected.id);
    setTemplate(selected.content);
  }

  async function uploadTemplateFile(file) {
    if (!file || uploadingTemplate) return;
    setUploadingTemplate(true);
    setErr("");
    const response = await devbenchApi.analyzeSummaryTemplate(file, {
      model: selectedModel,
      tier: selectedTier,
    });
    setUploadingTemplate(false);
    if (!response?.ok) {
      setErr(response?.error || "模板分析失败");
      return;
    }
    const item = {
      id: `uploaded-${Date.now()}`,
      name: response.name || `${file.name}模板`,
      content: response.template,
      source: `AI 分析：${response.sourceFile || file.name} · ${engineLabel(response.engine)}${response.aiSnapshot?.model ? `/${response.aiSnapshot.model}` : ""}`,
    };
    const custom = addCustomSummaryTemplate(templates.filter((entry) => entry.id !== DEFAULT_WEEKLY_TEMPLATE.id), item);
    const next = [DEFAULT_WEEKLY_TEMPLATE, ...custom];
    setTemplates(next);
    setTemplateId(item.id);
    setTemplate(item.content);
    try { localStorage.setItem(SUMMARY_TEMPLATES_KEY, JSON.stringify(custom)); } catch {}
    onToast?.(`已从 ${file.name} 生成模板${response.fallbackFromEngine ? `（图片由 ${engineLabel(response.engine)} 视觉分析）` : ""}`);
  }

  async function run(rep) {
    if (busy) return;
    const proj = projectPath.trim();
    if (!proj && !tabId) { setErr("请填写「输出工程路径」（默认取「在此开发」悬浮窗配置），或打开一个已配置主工程的故事点"); return; }
    if (!hasSummaryOutputMode(outputModes)) { setErr("请至少勾选简洁版或报告版"); return; }
    // 自定义周期校验起止日期
    let since = "", until = "";
    if (rep.key === "custom") {
      since = String(customSince || "").trim();
      until = String(customUntil || "").trim();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(since) || !/^\d{4}-\d{2}-\d{2}$/.test(until)) {
        setErr("自定义周期请填写有效的起止日期（yyyy-MM-dd）"); return;
      }
      if (new Date(since) > new Date(until)) { setErr("起始日期不能晚于结束日期"); return; }
    }
    if (proj) { try { localStorage.setItem(SUMMARY_PROJ_KEY, proj); } catch {} }
    // 生成会话标识并订阅流，让右侧面板能实时显示 AI 回答与模型档位
    const sid = "summary-" + (crypto.randomUUID ? crypto.randomUUID() : Date.now() + Math.random().toString(16).slice(2));
    sessionIdRef.current = sid;
    setLive({ ...freshLive(), streaming: true, startedAt: Date.now() });
    setBusy(rep.key); setErr(""); setResult(null);
    try { if (wsRef.current && wsRef.current.readyState === 1) wsRef.current.send(JSON.stringify({ type: "subscribe_session", sessionId: sid })); } catch {}
    const r = await devbenchApi.generateSummary(
      rep.key,
      tabId,
      template,
      proj,
      since,
      until,
      sid,
      includeRichExports && outputModes.report,
      {
        templateName: templates.find((item) => item.id === templateId)?.name || "周报",
        outputModes,
        model: selectedModel,
        tier: selectedTier,
      },
    );
    setBusy("");
    if (!r.ok) {
      const error = summaryRequestErrorMessage(r.error);
      setErr(error);
      setLive((prev) => prev ? { ...prev, streaming: false, error, endedAt: Date.now() } : prev);
      return;
    }
    setResult({ ...r.data, repLabel: rep.label });
    setLive((prev) => prev ? { ...prev, streaming: false, endedAt: prev.endedAt || Date.now() } : prev);
    onToast?.(`${rep.label} 已生成`);
  }

  // 打开生成的工作总结目录：优先后端返回的绝对路径 dirAbs（重启网关后才有）；
  // 否则用「输出工程路径 + 相对目录」自行拼绝对路径作兜底；失败给 toast，避免"点了没反应"。
  async function openSummaryDir() {
    if (!result) return;
    const base = projectPath.trim().replace(/[\\/]+$/, "");
    const target = result.dirAbs || (base ? `${base}/${result.dir}` : result.dir);
    const r = await devbenchApi.openDir(target);
    if (r && r.ok === false) onToast?.(`打开目录失败：${r.error || "路径不存在"}（${target}）`);
  }

  const modelChoices = [...new Set([
    selectedModel,
    ...(Array.isArray(aiPreview?.catalog?.models) ? aiPreview.catalog.models : []),
  ].filter(Boolean))];
  const tierChoices = [...new Set([
    selectedTier,
    ...(Array.isArray(aiPreview?.catalog?.tiers) ? aiPreview.catalog.tiers : []),
  ].filter(Boolean))];
  const selectedTemplateMeta = templates.find((item) => item.id === templateId) || DEFAULT_WEEKLY_TEMPLATE;

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/70" onClick={() => !busy && onClose()}>
      <div className="bg-zinc-900 border border-zinc-700 rounded-xl w-[960px] max-w-[96vw] max-h-[88vh] flex flex-col shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="px-5 py-4 border-b border-zinc-800 flex items-center justify-between">
          <div>
            <h2 className="text-sm font-semibold text-zinc-100">📝 工作总结</h2>
            <p className="text-[11px] text-zinc-500 mt-0.5">按选定时间段汇总已配置 Git 仓库与全部 AI 会话；简洁版优先速度，报告版提供更完整的图文影音结构。</p>
          </div>
          <div className="flex items-center gap-2">
            <button onClick={backupClaude} disabled={backing}
              className="px-2.5 py-1 text-[11px] rounded border border-zinc-700 bg-zinc-800 hover:bg-zinc-700 text-zinc-300 disabled:opacity-60 transition"
              title="备份 Claude Code CLI 会话到 D:\backup\claude，防止历史会话丢失，供后续总结">{backing ? "备份中…" : "💾 备份Claude会话"}</button>
            <button onClick={() => !busy && onClose()} className="text-zinc-500 hover:text-zinc-200 text-lg leading-none">✕</button>
          </div>
        </div>

        <div className="flex-1 overflow-hidden flex">
          {/* 左栏：配置 + 结果 */}
          <div className="w-[460px] flex flex-col border-r border-zinc-800 overflow-y-auto px-4 py-4 space-y-3">
          {/* 输出工程路径：默认取「在此开发」悬浮窗配置，可改并记忆；不再绑定当前故事点主工程 */}
          <div className="space-y-1">
            <div className="text-[11px] text-zinc-400">输出工程路径 <span className="text-[10px] text-zinc-600">报告存到此工程 docs/&lt;类型&gt;/&lt;git用户&gt;/；默认取「在此开发」悬浮窗配置，留空则用当前故事点主工程</span></div>
            <input value={projectPath} onChange={(e) => setProjectPath(e.target.value)}
              placeholder="选择输出工程路径（留空使用主工程）"
              className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-[12px] text-zinc-100 placeholder-zinc-600 outline-none focus:border-zinc-500 font-mono" />
          </div>

          {/* 单次工作总结模型/档位覆盖，不修改设置页或用户全局配置。 */}
          <div className="space-y-2 px-3 py-2 rounded-lg border border-zinc-800 bg-zinc-900/60">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-[11px] text-zinc-500">工作总结 AI：</span>
              {aiPreview ? (
                <>
                  <span className="px-2 py-0.5 rounded-full bg-zinc-800 border border-zinc-700 text-zinc-200 text-[11px]">引擎：{engineLabel(aiPreview.engine)}</span>
                  {aiPreview.useProxy ? <span className="text-[10px] text-amber-500/80">中心代理按服务端配置执行，不能单次覆盖</span> : null}
                </>
              ) : <span className="text-[11px] text-zinc-600">加载中…</span>}
            </div>
            <div className="grid grid-cols-2 gap-2">
              <label className="space-y-1">
                <span className="text-[10px] text-zinc-500">模型</span>
                <select value={selectedModel} onChange={(event) => setSelectedModel(event.target.value)}
                  disabled={!aiPreview || aiPreview.overridesSupported === false}
                  className="w-full bg-zinc-800 border border-zinc-700 rounded px-2 py-1.5 text-[11px] text-zinc-200 disabled:opacity-50">
                  {!modelChoices.length && <option value="">使用引擎默认模型</option>}
                  {modelChoices.map((value) => <option key={value} value={value}>{value}</option>)}
                </select>
              </label>
              <label className="space-y-1">
                <span className="text-[10px] text-zinc-500">档位</span>
                <select value={selectedTier} onChange={(event) => setSelectedTier(event.target.value)}
                  disabled={!aiPreview || aiPreview.overridesSupported === false || !tierChoices.length}
                  className="w-full bg-zinc-800 border border-zinc-700 rounded px-2 py-1.5 text-[11px] text-zinc-200 disabled:opacity-50">
                  {!!tierChoices.length && <option value="">使用模型默认档位</option>}
                  {!tierChoices.length && <option value="">当前引擎无可选档位</option>}
                  {tierChoices.map((value) => <option key={value} value={value}>{value}</option>)}
                </select>
              </label>
            </div>
            <div className="text-[10px] text-zinc-600">仅覆盖本次工作总结，不修改全局 AI 配置。</div>
          </div>

          <div className="grid grid-cols-2 gap-2">
            {REPORTS.filter((rep) => rep.key !== "custom").map((rep) => (
              <button key={rep.key} onClick={() => run(rep)} disabled={!!busy}
                className="flex flex-col items-start gap-0.5 p-3 rounded-lg border border-zinc-700 bg-zinc-800/50 hover:bg-zinc-800 hover:border-zinc-600 text-left disabled:opacity-50 transition">
                <span className="text-[13px] text-zinc-100 font-medium">{rep.icon} {rep.label}</span>
                <span className="text-[10px] text-zinc-500">{busy === rep.key ? "生成中…（AI 总结，请稍候）" : rep.desc}</span>
              </button>
            ))}
          </div>

          <div className="rounded-lg border border-zinc-800 bg-zinc-900/60 px-3 py-2 space-y-2">
            <div className="text-[11px] text-zinc-400">生成版本（可同时勾选）</div>
            <label className="flex items-start gap-2 cursor-pointer">
              <input type="checkbox" checked={outputModes.concise}
                onChange={(e) => setOutputModes((value) => ({ ...value, concise: e.target.checked }))}
                className="mt-0.5 accent-emerald-500" />
              <span>
                <span className="block text-[11px] text-zinc-200">简洁版 · 高效</span>
                <span className="block text-[10px] text-zinc-600">短上下文、短输出，生成 TXT + Markdown，默认选中。</span>
              </span>
            </label>
            <label className="flex items-start gap-2 cursor-pointer">
              <input type="checkbox" checked={outputModes.report}
                onChange={(e) => setOutputModes((value) => ({ ...value, report: e.target.checked }))}
                className="mt-0.5 accent-amber-500" />
              <span>
                <span className="block text-[11px] text-zinc-200">报告版 · 完整</span>
                <span className="block text-[10px] text-zinc-600">允许 AI 使用更长时间与更多证据，包含表格、状态及图片/视频/音频/附件图标。</span>
              </span>
            </label>
            <label className={`flex items-start gap-2 pl-5 ${outputModes.report ? "cursor-pointer" : "opacity-45"}`}>
              <input type="checkbox" checked={includeRichExports}
                disabled={!outputModes.report}
                onChange={(e) => setIncludeRichExports(e.target.checked)}
                className="mt-0.5 accent-amber-500" />
              <span>
                <span className="block text-[11px] text-zinc-300">报告版同时导出 Word / PDF</span>
                <span className="block text-[10px] text-zinc-600">需要本机 Word/PDF 渲染，会增加等待时间。</span>
              </span>
            </label>
          </div>

          {/* 自定义日期范围（点击「自定义日期总结」时使用） */}
          <div className="space-y-1">
            <div className="text-[11px] text-zinc-400">自定义起止日期 <span className="text-[10px] text-zinc-600">选择范围后点击右侧按钮；格式 yyyy-MM-dd</span></div>
            <div className="flex items-center gap-2">
              <input type="date" value={customSince} onChange={(e) => setCustomSince(e.target.value)}
                className="bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-[12px] text-zinc-100 outline-none focus:border-zinc-500" />
              <span className="text-zinc-500 text-xs">至</span>
              <input type="date" value={customUntil} onChange={(e) => setCustomUntil(e.target.value)}
                className="bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-[12px] text-zinc-100 outline-none focus:border-zinc-500" />
              <button onClick={() => run(REPORTS.find((r) => r.key === "custom"))} disabled={!!busy}
                className="ml-auto px-3 py-2 text-[12px] rounded-lg border border-amber-700/50 bg-amber-900/20 hover:bg-amber-900/35 text-amber-300 disabled:opacity-50 transition">
                {busy === "custom" ? "生成中…" : "生成自定义总结"}
              </button>
            </div>
          </div>

          {/* 模板对所有周期生效；上传文件后由选定 AI 分析并保存在本机浏览器。 */}
          <div className="space-y-2 rounded-lg border border-zinc-800 bg-zinc-900/50 px-3 py-2">
            <div className="flex items-center justify-between gap-2">
              <div>
                <div className="text-[11px] text-zinc-300">工作总结模板</div>
                <div className="text-[10px] text-zinc-600">默认“周报”来自提供的设计图；上传文件可由 AI 提取模板字段。</div>
              </div>
              <button type="button" disabled={uploadingTemplate || !!busy}
                onClick={() => templateFileRef.current?.click()}
                className="shrink-0 px-2.5 py-1 text-[11px] rounded border border-zinc-700 bg-zinc-800 hover:bg-zinc-700 text-zinc-300 disabled:opacity-50">
                {uploadingTemplate ? "AI 分析中…" : "上传文件生成模板"}
              </button>
              <input ref={templateFileRef} type="file" className="hidden"
                accept=".txt,.md,.markdown,.csv,.json,.yaml,.yml,.xml,.html,.pdf,.docx,.pptx,.xlsx,.png,.jpg,.jpeg,.webp,.gif"
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  event.target.value = "";
                  if (file) uploadTemplateFile(file);
                }} />
            </div>
            <select value={templateId} onChange={(event) => chooseTemplate(event.target.value)}
              className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-[12px] text-zinc-100">
              {templates.map((item) => (
                <option key={item.id} value={item.id}>{item.name}{item.id === DEFAULT_WEEKLY_TEMPLATE.id ? "（默认）" : ""}</option>
              ))}
            </select>
            <textarea value={template} onChange={(e) => setTemplate(e.target.value)} rows={7}
              placeholder="模板字段，每行一个章节。AI 将按当前顺序生成。"
              className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-[12px] text-zinc-100 placeholder-zinc-600 outline-none focus:border-zinc-500 resize-y" />
            <div className="text-[10px] text-zinc-600">
              当前：{selectedTemplateMeta.name} · {selectedTemplateMeta.source || "用户模板"}；上传文件最大 20MB，支持图片、PDF、Office、Markdown 和文本。
            </div>
          </div>

          {err && <div className="text-[12px] text-red-400">{err}</div>}

          {result && (
            <div className={`border rounded-lg p-3 space-y-1.5 ${result.complete === false ? "border-amber-800/50 bg-amber-900/10" : "border-emerald-800/40 bg-emerald-900/10"}`}>
              <div className={`text-[12px] ${result.complete === false ? "text-amber-300" : "text-emerald-300"}`}>
                {result.complete === false ? "⚠" : "✓"} {result.repLabel} {result.complete === false ? "部分生成" : "已生成"}（{result.project}）
              </div>
              <div className="text-[11px] text-zinc-400 font-mono">
                {summaryResultFiles(result).map((item) => (
                  <div key={`${item.key}-${item.file}`}>· {result.dir}/{item.file} <span className="text-zinc-600">（{item.label} · {item.note}）</span></div>
                ))}
              </div>
              {(result.warnings || []).map((warning) => (
                <div key={warning} className="text-[10px] text-amber-500/80">{warning}</div>
              ))}
              <div className="text-[10px] text-zinc-500">
                数据源：{result.gitCommits} 条 Git 提交 · {result.cliSessions || 0} 个 AI CLI 会话（{result.cliPrompts || 0} 次指令） · {result.chatStories} 个故事点
              </div>
              <div className="text-[10px] text-zinc-600">
                耗时：采集 {formatDuration(result.timings?.collectionMs)} · AI {formatDuration(result.timings?.aiMs)} · 导出 {formatDuration(result.timings?.exportMs)} · 总计 {formatDuration(result.timings?.totalMs)}
                <br />版本：{(result.generatedModes || []).map((mode) => mode === "report" ? "报告版" : "简洁版").join(" + ")} · 模板：{result.templateName || "周报"} · 提示词约 {result.promptEstimatedTokens || 0} tokens
                <br />会话索引命中 {result.collection?.cacheHits || 0}，本次读取 {formatBytes(result.collection?.bytesRead || 0)} · 未自动暂存
              </div>
              <button onClick={openSummaryDir}
                className="text-[11px] px-2.5 py-1 rounded border border-amber-700/50 bg-amber-900/20 hover:bg-amber-900/35 text-amber-300 transition"
                title={`在系统资源管理器中打开：${result.dirAbs || result.dir}`}>📂 打开工作总结目录</button>
              {result.textPreview && (
                <details className="text-[11px] text-zinc-400">
                  <summary className="cursor-pointer text-zinc-300">文本报告预览</summary>
                  <pre className="whitespace-pre-wrap mt-1 max-h-48 overflow-auto">{result.textPreview}…</pre>
                </details>
              )}
            </div>
          )}
          </div>

          {/* 右栏：与 AI 的实时对话面板（类似故事点聊天） */}
          <div className="flex-1 flex flex-col bg-zinc-950/40">
            <LivePane live={live} busy={busy} />
          </div>
        </div>

        <div className="px-5 py-3 border-t border-zinc-800 flex justify-end">
          <button onClick={() => !busy && onClose()} disabled={!!busy} className="px-4 py-1.5 text-xs rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-300 disabled:opacity-50">{busy ? "生成中…" : "完成"}</button>
        </div>
      </div>
    </div>
  );
}

// 右侧实时对话面板：展示当前 AI 模型/档位、处理中状态、流式思考与回答
function LivePane({ live, busy }) {
  if (!live && !busy) {
    return (
      <div className="flex-1 flex items-center justify-center text-center px-6">
        <div className="text-zinc-600 text-[12px] leading-relaxed">
          <div className="text-2xl mb-2">💬</div>
          点击左侧任一总结类型开始生成后，<br />这里会实时显示 AI 的思考与回答，<br />以及当前使用的 AI 模型与档位。
        </div>
      </div>
    );
  }
  const snap = live && live.aiSnapshot;
  const eng = (live && live.engine) || "";
  const streaming = !!(live && live.streaming);
  const elapsed = live && live.startedAt ? Math.max(0, Math.round(((live.endedAt || Date.now()) - live.startedAt) / 1000)) : 0;
  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      {/* 顶部状态条：模型/档位 + 处理中 */}
      <div className="px-4 py-3 border-b border-zinc-800 space-y-1.5">
        <div className="flex items-center gap-2 flex-wrap">
          {streaming ? (
            <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-amber-900/30 border border-amber-700/50 text-amber-300 text-[11px]">
              <span className="w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse" /> 处理中…
            </span>
          ) : (live && live.error) ? (
            <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-red-900/30 border border-red-700/50 text-red-300 text-[11px]">✕ 失败</span>
          ) : live ? (
            <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-emerald-900/30 border border-emerald-700/50 text-emerald-300 text-[11px]">✓ 完成</span>
          ) : null}
          {eng && <span className="px-2 py-0.5 rounded-full bg-zinc-800 border border-zinc-700 text-zinc-200 text-[11px]">引擎：{engineLabel(eng)}</span>}
          {snap && <span className="px-2 py-0.5 rounded-full bg-zinc-800 border border-zinc-700 text-zinc-300 text-[11px]">{snapshotLabel(snap)}</span>}
          {elapsed > 0 && <span className="text-[10px] text-zinc-500">· {elapsed}s</span>}
        </div>
        <div className="text-[11px] text-zinc-500">
          {streaming ? (live?.status || `正在用 ${engineLabel(eng)}${snap ? `（${snapshotLabel(snap)}）` : ""} 生成工作总结，请稍候…`)
            : (live && live.error) ? live.error
            : live ? "AI 已完成生成，详见左侧结果。" : ""}
        </div>
      </div>

      {/* 内容区：思考（折叠）+ 回答流 */}
      <div className="flex-1 overflow-y-auto px-4 py-3 space-y-3">
        {live && live.thinking ? (
          <details className="border border-zinc-800 rounded-lg bg-zinc-900/60" open={streaming && !live.text}>
            <summary className="cursor-pointer text-[11px] text-zinc-400 px-3 py-2 select-none">🧠 思考过程（{live.thinking.length} 字）</summary>
            <pre className="whitespace-pre-wrap text-[11px] text-zinc-500 px-3 pb-3 max-h-64 overflow-auto">{live.thinking}</pre>
          </details>
        ) : null}
        {live && live.tools && live.tools.length > 0 && (
          <div className="border border-zinc-800 rounded-lg bg-zinc-900/60 px-3 py-2">
            <div className="text-[11px] text-zinc-400 mb-1">🔧 工具调用（{live.tools.length}）</div>
            <pre className="whitespace-pre-wrap text-[11px] text-zinc-500 max-h-40 overflow-auto">{live.tools.join("\n")}</pre>
          </div>
        )}
        {live && live.text ? (
          <div className="border border-zinc-800 rounded-lg bg-zinc-900/60 px-3 py-2">
            <div className="text-[11px] text-zinc-400 mb-1">📝 AI 回答</div>
            <pre className="whitespace-pre-wrap text-[12px] text-zinc-200 leading-relaxed">{live.text}{streaming ? <span className="inline-block w-1.5 h-3 bg-zinc-400 animate-pulse align-middle ml-0.5" /> : null}</pre>
          </div>
        ) : streaming ? (
          <div className="text-[11px] text-zinc-600 italic">等待 AI 返回内容…</div>
        ) : null}
        {live && live.error && !live.text && (
          <div className="text-[12px] text-red-400 border border-red-900/50 bg-red-900/10 rounded-lg px-3 py-2">{live.error}</div>
        )}
      </div>
    </div>
  );
}
