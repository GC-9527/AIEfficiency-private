import React, { useState, useEffect, useRef } from "react";
import { Link } from "react-router-dom";
import {
  createGatewayWebSocket,
  getApiUrl,
  getGatewayUrl,
  setGatewayUrl,
  startTbTasksLogin,
} from "../services/gateway.js";
import {
  adminRequest,
  authenticatedFetch,
  getAdminToken,
  loginAdmin,
  logoutAdmin,
  useAdminSession,
} from "../services/adminAuth.js";
import { copyToClipboard } from "../utils/clipboard.js";
import { isStoryPointAiInferenceEnabled } from "./devbench/storyEntryInferenceModel.mjs";
import {
  formatTbCheckedAt,
  isTbLoginActive,
  normalizeTbCookieHealth,
  normalizeTbLoginState,
  tbCookiePresentation,
} from "./settings/tbCookieLoginModel.mjs";
import {
  atlasApplyConfirmation,
  atlasApplyPresentation,
  atlasDetailsVisible,
  atlasTogglePlan,
} from "./settings/atlasSetupModel.mjs";
import AtlasClientSetupPanel from "./settings/AtlasClientSetupPanel.jsx";

const DEPLOYMENT_ROLE_OPTIONS = [
  { value: "standalone", label: "全功能（本机开发 + 可提供中心服务，推荐）" },
  { value: "server", label: "仅服务端（可提供中心服务，无本机开发页面）" },
  { value: "node", label: "仅客户端（本机开发，不提供中心服务）" },
];

const RESERVED_API_ENGINE_IDS = new Set(["claude", "claude-volcengine", "claude-minimax", "gemini", "codex", "codex-minimax", "hermes", "qwen", "kimi", "deepseek", "openai", "atlas", "bigmodel", "volcengine", "minimax"]);

const API_ENGINE_TEMPLATES = [
  { key: "blank", name: "空白自定义", idSuggest: "", baseUrl: "https://api.example.com/v1", model: "", availableModels: [] },
  { key: "openrouter", name: "OpenRouter", idSuggest: "openrouter", baseUrl: "https://openrouter.ai/api/v1", model: "openai/gpt-4o-mini", availableModels: ["openai/gpt-4o-mini", "openai/gpt-4o", "anthropic/claude-sonnet-4"] },
  { key: "siliconflow", name: "硅基流动", idSuggest: "siliconflow", baseUrl: "https://api.siliconflow.cn/v1", model: "deepseek-ai/DeepSeek-V3", availableModels: ["deepseek-ai/DeepSeek-V3", "Qwen/Qwen2.5-72B-Instruct"] },
  { key: "volcengine", name: "火山方舟 Agent Plan", idSuggest: "volcengine", baseUrl: "https://ark.cn-beijing.volces.com/api/plan/v3", model: "ark-code-latest", availableModels: ["ark-code-latest", "glm-5.2[1m]", "deepseek-v4-pro[1m]", "deepseek-v4-flash[1m]", "glm-5.2", "kimi-k2.6"] },
  { key: "ollama", name: "Ollama 本地", idSuggest: "ollama", baseUrl: "http://127.0.0.1:11434/v1", model: "qwen2.5-coder", availableModels: ["qwen2.5-coder", "llama3.2"] },
];

export default function Settings() {
  const adminSession = useAdminSession();
  const me = adminSession.principal;
  const isAdmin = adminSession.isAdmin && adminSession.canMutate;
  const adminLoading = adminSession.loading;
  const [config, setConfig] = useState({
    dingtalkAppKey: "", dingtalkAppSecret: "", dingtalkRobotWebhook: "",
    dingtalkRobotToken: "", dingtalkRobotSecret: "",
    defaultEngine: "claude", geminiEnabled: false, codexEnabled: false, hermesEnabled: false, autoFallback: true,
    enableDecomposition: true, decompositionEngine: "gemini", summaryEngine: "gemini", maxSubtasks: 5,
    storyPointAiInferenceEnabled: false,
  });
  const [tbProjectSelection, setTbProjectSelection] = useState([]);
  const [msg, setMsg] = useState(null);
  const [engineStatus, setEngineStatus] = useState({});
  const [guideModal, setGuideModal] = useState(null); // { engine, status, data }
  const [installOutput, setInstallOutput] = useState("");
  const [installing, setInstalling] = useState(false);
  const [adminLoginOpen, setAdminLoginOpen] = useState(false);
  const [selfHost, setSelfHost] = useState(""); // 本机网关局域网地址（http://ip:port），用于自分发安装入口提示
  const [customModel, setCustomModel] = useState({}); // AI 模型服务自定义输入状态（key=engineId）
  const [showAddApiEngine, setShowAddApiEngine] = useState(false);
  const [apiEngineDraft, setApiEngineDraft] = useState({
    template: "blank", id: "", name: "", baseUrl: "", apiKey: "", model: "", availableModels: "",
  });
  const [apiEngineTest, setApiEngineTest] = useState({}); // id -> { loading, ok, text }
  const [opencodeSync, setOpencodeSync] = useState({ loading: false, ok: false, text: "" });
  const [claudeArkSync, setClaudeArkSync] = useState({ loading: false, ok: false, text: "" });
  const [claudeMinimaxSync, setClaudeMinimaxSync] = useState({ loading: false, ok: false, text: "" });
  const [codexMinimaxSync, setCodexMinimaxSync] = useState({ loading: false, ok: false, text: "" });
  const [arkcliSync, setArkcliSync] = useState({ loading: false, ok: false, text: "" });
  const [atlasToolSync, setAtlasToolSync] = useState({});
  const [atlasLocallyExpanded, setAtlasLocallyExpanded] = useState(false);
  const [executorRootInput, setExecutorRootInput] = useState("");
  const [suggestedExecutorRoot, setSuggestedExecutorRoot] = useState("");
  const [reportRepositories, setReportRepositories] = useState([]);
  const [reportRepositoriesLoading, setReportRepositoriesLoading] = useState(false);
  const [reportRepositoriesError, setReportRepositoriesError] = useState("");
  const [roleChanging, setRoleChanging] = useState(false);
  const wsRef = useRef(null);
  const initialLoadStartedRef = useRef(false);
  const adminToken = getAdminToken();
  const isDesktop = typeof window !== "undefined" && !!window.electronAPI?.isElectron;

  const role = config.role || "standalone";
  const isPureClientRole = role === "node";
  const canSwitchClientToStandalone = isDesktop
    && isPureClientRole
    && !isAdmin
    && typeof window.electronAPI?.switchClientToStandalone === "function";
  const canChangeDeploymentRole = isAdmin || canSwitchClientToStandalone;
  const canEditLocalNode = isAdmin || isPureClientRole;
  const executorRoots = Array.isArray((config.executor || {}).allowedRoots) ? (config.executor || {}).allowedRoots : [];
  const nodeNameOwner = String((isAdmin && me?.name) || (config.servers || {}).nodeOwnerName || "").trim();
  const storedNodeName = String((config.servers || {}).nodeName || "");
  const nodeNameSuffix = nodeNameOwner && storedNodeName.startsWith(`${nodeNameOwner}-`)
    ? storedNodeName.slice(nodeNameOwner.length + 1)
    : storedNodeName;
  const nodeNamePreview = nodeNameOwner ? `${nodeNameOwner}-${nodeNameSuffix || "主机名"}` : (nodeNameSuffix || "主机名");

  const reloadConfig = React.useCallback(() => {
    fetch(getApiUrl("/api/config")).then((r) => r.json()).then((d) => {
      if (d.success) setConfig((p) => ({ ...p, ...d.data }));
    }).catch(() => {});
  }, []);

  const reloadReportRepositories = React.useCallback(() => {
    setReportRepositoriesLoading(true);
    setReportRepositoriesError("");
    fetch(getApiUrl("/api/report/repositories"))
      .then((r) => r.json())
      .then((d) => {
        if (!d.success) throw new Error(d.error || "仓库列表读取失败");
        setReportRepositories(d.data?.repositories || []);
      })
      .catch((error) => setReportRepositoriesError(error.message || "仓库列表读取失败"))
      .finally(() => setReportRepositoriesLoading(false));
  }, []);

  function authHeaders(json = false) {
    const headers = json ? { "Content-Type": "application/json" } : {};
    const token = getAdminToken();
    if (token) headers.Authorization = `Bearer ${token}`;
    return headers;
  }

  function reloadTbProjectSelection() {
    fetch(getApiUrl("/api/devbench/tb-projects/selection"), { headers: authHeaders() })
      .then((r) => r.json())
      .then((d) => { if (d.ok) setTbProjectSelection(d.data || []); })
      .catch(() => {});
  }

  function saveTbProjectSelection(projects) {
    setTbProjectSelection(projects || []);
    fetch(getApiUrl("/api/devbench/tb-projects/selection"), {
      method: "PUT",
      headers: authHeaders(true),
      body: JSON.stringify({ projects: projects || [] }),
    }).then(async (r) => {
      const d = await r.json().catch(() => ({}));
      if (!r.ok || !d.ok) {
        setMsg(d.error || "TB 项目保存失败");
        reloadTbProjectSelection();
        setTimeout(() => setMsg(null), 3500);
        return;
      }
      setTbProjectSelection(d.data || []);
      setMsg("已保存当前账号的 TB 项目");
      setTimeout(() => setMsg(null), 1500);
    }).catch(() => {
      setMsg("TB 项目保存失败");
      reloadTbProjectSelection();
      setTimeout(() => setMsg(null), 3500);
    });
  }

  function applyExecutorSuggestion(data = {}) {
    const root = String(data.root || "").trim();
    if (!root) return;
    setSuggestedExecutorRoot(root);
  }

  function loadDeploymentHints() {
    // 这些信息只服务于页面中部的局域网/执行器配置，不与首屏配置争抢资源。
    fetch(getApiUrl("/api/discovery/info")).then((r) => r.json())
      .then((d) => { if (d?.data) setSelfHost(d.data.host || ""); }).catch(() => {});
    fetch(getApiUrl("/api/executor/suggested-root")).then((r) => r.json())
      .then((d) => { if (d?.ok && d.data?.root) applyExecutorSuggestion(d.data); }).catch(() => {});
  }

  useEffect(() => {
    // React StrictMode 会在开发态重复执行 mount effect。这里只允许启动一次首屏只读加载，
    // 避免打开设置页时成倍占用 Gateway、Git 和本机进程资源。
    if (initialLoadStartedRef.current) return;
    initialLoadStartedRef.current = true;
    reloadConfig();
  }, [reloadConfig]);

  // WebSocket 监听安装进度
  useEffect(() => {
    if (!installing) return;
    const ws = createGatewayWebSocket();
    wsRef.current = ws;
    ws.onmessage = (e) => {
      const msg = JSON.parse(e.data);
      if (msg.type === "install_progress") {
        setInstallOutput((prev) => prev + msg.data.output);
        if (msg.data.done) {
          setInstalling(false);
          if (msg.data.success) {
            // 安装成功，重新检测
            setTimeout(() => checkEngine(msg.data.engine), 1000);
          }
        }
      }
    };
    return () => ws.close();
  }, [installing]);

  function updateMany(patch, options = {}) {
    // 乐观更新本地完整配置；请求体只提交 patch，避免把脱敏后的密钥/整包配置带回服务端，
    // 误触管理员字段或 Codeup 校验导致 403 回滚（表现为 AI 模型勾选展开后闪一下消失）。
    setConfig((prev) => ({ ...prev, ...patch }));
    const headers = { "Content-Type": "application/json" };
    if (adminToken) headers.Authorization = `Bearer ${adminToken}`; // 管理员字段后端需校验
    const body = options.nodeNameEdit ? { ...patch, _nodeNameEdit: true } : { ...patch };
    return fetch(getApiUrl("/api/config"), { method: "PUT", headers, body: JSON.stringify(body) })
      .then(async (r) => {
        const d = await r.json().catch(() => ({}));
        if (!r.ok || d.success === false || d.ok === false) {
          setMsg(d.error || (r.status === 403 ? "仅管理员可修改，请先登录管理后台" : "保存失败"));
          reloadConfig(); // 回滚本地乐观更新
          setTimeout(() => setMsg(null), 4000);
          return { ok: false, error: d.error || "保存失败" };
        }
        if (d.data) setConfig((p) => ({ ...p, ...d.data }));
        setMsg(options.successMessage || "已保存");
        setTimeout(() => setMsg(null), 1500);
        return { ok: true, data: d.data };
      }).catch((error) => {
        setMsg("保存失败");
        reloadConfig();
        return { ok: false, error: error?.message || "保存失败" };
      });
  }
  function update(field, value) { updateMany({ [field]: value }); }

  function patchApiEngine(engineId, patch) {
    const engines = { ...(config.apiEngines || {}) };
    engines[engineId] = { ...(engines[engineId] || {}), ...patch };
    updateMany({ apiEngines: engines }).then((r) => {
      // 火山方舟切换默认模型/端点后，自动同步到 Claude（终端 + 故事点全局默认）
      if (!r?.ok || engineId !== "volcengine") return;
      if (patch.model == null && patch.baseUrl == null && patch.claudeExtendedContext == null) return;
      if (!engines.volcengine?.apiKey || !engines.volcengine?.enabled) return;
      applyVolcengineToClaude(engines.volcengine);
    });
  }

  function toggleApiEngine(engineId, checked) {
    if (engineId === "atlas") {
      const plan = atlasTogglePlan({ checked, isAdmin });
      setAtlasLocallyExpanded(plan.locallyExpanded);
      if (!plan.shouldPersist) {
        if (plan.shouldRequestAdminLogin) setAdminLoginOpen(true);
        setMsg(`Atlas 配置已${checked ? "展开" : "保留"}；请先登录管理员，再${checked ? "启用并保存" : "停用"}。`);
        setTimeout(() => setMsg(null), 4000);
        return;
      }
    }
    patchApiEngine(engineId, { enabled: checked });
  }

  async function applyAtlasToClient(tool, engineCfg = {}) {
    if (!isAdmin) {
      setAtlasToolSync((prev) => ({
        ...prev,
        [tool]: { loading: false, ok: false, text: "请先登录管理员账号，再修改本机 AI 工具的全局配置。" },
      }));
      return;
    }
    const confirmed = typeof window === "undefined"
      || window.confirm(atlasApplyConfirmation(tool, engineCfg.model));
    if (!confirmed) return;

    setAtlasToolSync((prev) => ({
      ...prev,
      [tool]: { loading: true, ok: false, text: "正在备份并写入全局配置…", installGuide: null },
    }));
    try {
      const body = {};
      if (engineCfg.baseUrl) body.baseUrl = engineCfg.baseUrl;
      if (engineCfg.model) body.model = engineCfg.model;
      if (engineCfg.apiKey && !String(engineCfg.apiKey).includes("****")) body.apiKey = engineCfg.apiKey;
      const response = await authenticatedFetch(getApiUrl(`/api/config/atlas/apply/${encodeURIComponent(tool)}`), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const payload = await response.json().catch(() => ({}));
      const presentation = atlasApplyPresentation(tool, payload);
      setAtlasToolSync((prev) => ({ ...prev, [tool]: { loading: false, ...presentation } }));
    } catch (error) {
      setAtlasToolSync((prev) => ({
        ...prev,
        [tool]: { loading: false, ok: false, text: error?.message || "全局配置写入失败", installGuide: null },
      }));
    }
  }

  async function copyVolcengineOpenCodeConfig(engineCfg = {}) {
    const baseURL = String(engineCfg.baseUrl || "https://ark.cn-beijing.volces.com/api/plan/v3").replace(/\/+$/, "");
    const apiKey = String(engineCfg.apiKey || "").includes("****")
      ? "<你的 Agent Plan API Key>"
      : (String(engineCfg.apiKey || "").trim() || "<你的 Agent Plan API Key>");
    const model = String(engineCfg.model || "ark-code-latest").trim() || "ark-code-latest";
    const models = {};
    for (const m of (engineCfg.availableModels || [model])) {
      const id = String(m || "").trim();
      if (id) models[id] = { name: id };
    }
    if (!models[model]) models[model] = { name: model };
    const snippet = JSON.stringify({
      $schema: "https://opencode.ai/config.json",
      model: `volcengine/${model}`,
      provider: {
        volcengine: {
          npm: "@ai-sdk/openai-compatible",
          name: "火山方舟",
          options: { baseURL, apiKey },
          models,
        },
      },
    }, null, 2);
    const ok = await copyToClipboard(snippet);
    setMsg(ok
      ? "已复制 OpenCode 配置。推荐直接点「一键写入 OpenCode」；或手动写入 %USERPROFILE%\\.config\\opencode\\opencode.json"
      : "复制失败，请手动选择文本");
    setTimeout(() => setMsg(null), 4500);
  }

  async function applyVolcengineToOpenCode(engineCfg = {}) {
    setOpencodeSync({ loading: true, ok: false, text: "正在写入 OpenCode…" });
    try {
      const body = {};
      if (engineCfg.baseUrl) body.baseUrl = engineCfg.baseUrl;
      if (engineCfg.model) body.model = engineCfg.model;
      if (engineCfg.apiKey && !String(engineCfg.apiKey).includes("****")) body.apiKey = engineCfg.apiKey;
      const r = await fetch(getApiUrl("/api/config/opencode/apply-volcengine"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const d = await r.json().catch(() => ({}));
      const data = d.data || {};
      if (d.success && data.ok) {
        const text = `已设默认模型 ${data.model || ""} · 请重新打开 opencode`;
        setOpencodeSync({ loading: false, ok: true, text });
        setMsg(text);
        setTimeout(() => setMsg(null), 5000);
      } else {
        const err = data.error || d.error || "写入 OpenCode 失败";
        setOpencodeSync({ loading: false, ok: false, text: err });
        setMsg(err);
        setTimeout(() => setMsg(null), 4500);
      }
    } catch (err) {
      const errText = err?.message || "写入 OpenCode 失败";
      setOpencodeSync({ loading: false, ok: false, text: errText });
      setMsg(errText);
      setTimeout(() => setMsg(null), 4500);
    }
  }

  async function applyVolcengineToClaude(engineCfg = {}) {
    setClaudeArkSync({ loading: true, ok: false, text: "正在配置 Claude（火山方舟）并检查 arkcli…" });
    try {
      const body = { installArkCli: true };
      if (engineCfg.baseUrl) body.baseUrl = engineCfg.baseUrl;
      if (engineCfg.model) body.model = engineCfg.model;
      if (engineCfg.apiKey && !String(engineCfg.apiKey).includes("****")) body.apiKey = engineCfg.apiKey;
      const r = await fetch(getApiUrl("/api/config/claude/apply-volcengine"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const d = await r.json().catch(() => ({}));
      const data = d.data || {};
      if (d.success && data.ok) {
        const text = data.hint
          || `已配置默认模型 ${data.model || engineCfg.model || ""}；终端 claude / 故事点可用`;
        setClaudeArkSync({ loading: false, ok: true, text });
        setMsg(text);
        setTimeout(() => setMsg(null), 6000);
      } else {
        const err = data.error || d.error || "配置 Claude 方舟失败";
        setClaudeArkSync({ loading: false, ok: false, text: err });
        setMsg(err);
        setTimeout(() => setMsg(null), 4500);
      }
    } catch (err) {
      const errText = err?.message || "配置 Claude 方舟失败";
      setClaudeArkSync({ loading: false, ok: false, text: errText });
      setMsg(errText);
      setTimeout(() => setMsg(null), 4500);
    }
  }

  async function applyMinimaxToClaude(engineCfg = {}) {
    setClaudeMinimaxSync({ loading: true, ok: false, text: "正在配置 Claude（MiniMax）…" });
    try {
      const body = {};
      if (engineCfg.baseUrl) body.baseUrl = engineCfg.baseUrl;
      if (engineCfg.model) body.model = engineCfg.model;
      if (engineCfg.apiKey && !String(engineCfg.apiKey).includes("****")) body.apiKey = engineCfg.apiKey;
      const r = await fetch(getApiUrl("/api/config/claude/apply-minimax"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const d = await r.json().catch(() => ({}));
      const data = d.data || {};
      if (d.success && data.ok) {
        const text = data.hint
          || `已配置默认模型 ${data.model || engineCfg.model || ""}；终端 claude 现走 MiniMax`;
        setClaudeMinimaxSync({ loading: false, ok: true, text });
        setMsg(text);
        setTimeout(() => setMsg(null), 6000);
      } else {
        const err = data.error || d.error || "配置 Claude MiniMax 失败";
        setClaudeMinimaxSync({ loading: false, ok: false, text: err });
        setMsg(err);
        setTimeout(() => setMsg(null), 4500);
      }
    } catch (err) {
      const errText = err?.message || "配置 Claude MiniMax 失败";
      setClaudeMinimaxSync({ loading: false, ok: false, text: errText });
      setMsg(errText);
      setTimeout(() => setMsg(null), 4500);
    }
  }

  async function applyMinimaxToCodex(engineCfg = {}) {
    setCodexMinimaxSync({ loading: true, ok: false, text: "正在配置 Codex（MiniMax）…" });
    try {
      const body = {};
      if (engineCfg.baseUrl) body.baseUrl = engineCfg.baseUrl;
      if (engineCfg.model) body.model = engineCfg.model;
      if (engineCfg.apiKey && !String(engineCfg.apiKey).includes("****")) body.apiKey = engineCfg.apiKey;
      const r = await fetch(getApiUrl("/api/config/codex/apply-minimax"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const d = await r.json().catch(() => ({}));
      const data = d.data || {};
      if (d.success && data.ok) {
        const text = data.hint
          || `已配置默认模型 ${data.model || engineCfg.model || ""}；终端 codex 现走 MiniMax`;
        setCodexMinimaxSync({ loading: false, ok: true, text });
        setMsg(text);
        setTimeout(() => setMsg(null), 6000);
      } else {
        const err = data.error || d.error || "配置 Codex MiniMax 失败";
        setCodexMinimaxSync({ loading: false, ok: false, text: err });
        setMsg(err);
        setTimeout(() => setMsg(null), 4500);
      }
    } catch (err) {
      const errText = err?.message || "配置 Codex MiniMax 失败";
      setCodexMinimaxSync({ loading: false, ok: false, text: errText });
      setMsg(errText);
      setTimeout(() => setMsg(null), 4500);
    }
  }

  async function installArkCli() {
    setArkcliSync({ loading: true, ok: false, text: "正在安装 @volcengine/ark-cli…" });
    try {
      const r = await fetch(getApiUrl("/api/config/arkcli/install"), { method: "POST" });
      const d = await r.json().catch(() => ({}));
      const data = d.data || {};
      if (d.success && data.ok) {
        const text = `已安装 arkcli${data.version ? ` ${data.version}` : ""}，可执行 arkcli helper`;
        setArkcliSync({ loading: false, ok: true, text });
        setMsg(text);
        setTimeout(() => setMsg(null), 5000);
      } else {
        const err = data.error || d.error || "安装 arkcli 失败";
        setArkcliSync({ loading: false, ok: false, text: err });
        setMsg(err);
        setTimeout(() => setMsg(null), 6000);
      }
    } catch (err) {
      const errText = err?.message || "安装 arkcli 失败";
      setArkcliSync({ loading: false, ok: false, text: errText });
      setMsg(errText);
      setTimeout(() => setMsg(null), 4500);
    }
  }

  async function testApiEngine(engineId, engineCfg = {}) {
    setApiEngineTest((p) => ({ ...p, [engineId]: { loading: true, ok: false, text: "探测中…" } }));
    try {
      const body = {};
      if (engineCfg.apiKey && !String(engineCfg.apiKey).includes("****")) body.apiKey = engineCfg.apiKey;
      if (engineCfg.baseUrl) body.baseUrl = engineCfg.baseUrl;
      if (engineCfg.model) body.model = engineCfg.model;
      const r = await fetch(getApiUrl(`/api/config/api-engines/${encodeURIComponent(engineId)}/test`), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const d = await r.json().catch(() => ({}));
      const data = d.data || {};
      if (d.success && data.ok) {
        setApiEngineTest((p) => ({
          ...p,
          [engineId]: { loading: false, ok: true, text: `连通正常 · ${data.latencyMs ?? "?"}ms · ${data.model || ""}` },
        }));
      } else {
        setApiEngineTest((p) => ({
          ...p,
          [engineId]: { loading: false, ok: false, text: data.error || d.error || "探测失败" },
        }));
      }
    } catch (err) {
      setApiEngineTest((p) => ({
        ...p,
        [engineId]: { loading: false, ok: false, text: err.message || "探测失败" },
      }));
    }
  }

  function removeCustomApiEngine(engineId) {
    const cfg = config.apiEngines?.[engineId];
    if (!cfg || cfg.builtin) return;
    if (!window.confirm(`确定删除自定义模型服务「${cfg.name || engineId}」？`)) return;
    const engines = { ...(config.apiEngines || {}), [engineId]: { _delete: true } };
    const optimistic = { ...(config.apiEngines || {}) };
    delete optimistic[engineId];
    setConfig((p) => ({ ...p, apiEngines: optimistic }));
    const headers = { "Content-Type": "application/json" };
    if (adminToken) headers.Authorization = `Bearer ${adminToken}`;
    fetch(getApiUrl("/api/config"), {
      method: "PUT",
      headers,
      body: JSON.stringify({ apiEngines: engines }),
    })
      .then(async (r) => {
        const d = await r.json().catch(() => ({}));
        if (!r.ok || d.success === false) {
          setMsg(d.error || "删除失败");
          reloadConfig();
          return;
        }
        if (d.data) setConfig((p) => ({ ...p, ...d.data }));
        setMsg("已删除自定义模型服务");
        setTimeout(() => setMsg(null), 1500);
      })
      .catch(() => {
        setMsg("删除失败");
        reloadConfig();
      });
  }

  function applyApiEngineTemplate(templateKey) {
    const t = API_ENGINE_TEMPLATES.find((x) => x.key === templateKey) || API_ENGINE_TEMPLATES[0];
    setApiEngineDraft({
      template: t.key,
      id: t.idSuggest || "",
      name: t.name || "",
      baseUrl: t.baseUrl || "",
      apiKey: "",
      model: t.model || "",
      availableModels: (t.availableModels || []).join(", "),
    });
  }

  function submitCustomApiEngine() {
    const id = String(apiEngineDraft.id || "").trim().toLowerCase();
    const name = String(apiEngineDraft.name || "").trim() || id;
    const baseUrl = String(apiEngineDraft.baseUrl || "").trim();
    const model = String(apiEngineDraft.model || "").trim();
    const apiKey = String(apiEngineDraft.apiKey || "").trim();
    if (!/^[a-z][a-z0-9_-]{1,31}$/.test(id)) {
      setMsg("模型服务 ID 须为小写字母开头、2-32 位 [a-z0-9_-]");
      setTimeout(() => setMsg(null), 3000);
      return;
    }
    if (config.apiEngines?.[id] || RESERVED_API_ENGINE_IDS.has(id)) {
      setMsg(`模型服务 ID「${id}」已存在或为保留名`);
      setTimeout(() => setMsg(null), 3000);
      return;
    }
    if (!baseUrl || !model) {
      setMsg("请填写 Base URL 与默认模型");
      setTimeout(() => setMsg(null), 3000);
      return;
    }
    const availableModels = String(apiEngineDraft.availableModels || "")
      .split(/[,，\s]+/)
      .map((s) => s.trim())
      .filter(Boolean);
    const engines = {
      ...(config.apiEngines || {}),
      [id]: {
        enabled: true,
        name,
        baseUrl,
        apiKey,
        model,
        availableModels: availableModels.length ? availableModels : [model],
        custom: true,
      },
    };
    updateMany({ apiEngines: engines }, { successMessage: `已添加模型服务 ${name}` }).then((r) => {
      if (r?.ok) {
        setShowAddApiEngine(false);
        setApiEngineDraft({ template: "blank", id: "", name: "", baseUrl: "", apiKey: "", model: "", availableModels: "" });
      }
    });
  }

  async function changeRole(nextRole) {
    if (nextRole === role || roleChanging) return;
    const isLocalStandaloneUpgrade = canSwitchClientToStandalone && nextRole === "standalone";
    if (!isAdmin && !isLocalStandaloneUpgrade) {
      setMsg("非管理员仅可在 Desktop 本机从“仅客户端”切换到“全功能”");
      setTimeout(() => setMsg(null), 3500);
      return;
    }

    const nextRoleLabel = DEPLOYMENT_ROLE_OPTIONS.find((option) => option.value === nextRole)?.label || nextRole;
    if (
      isDesktop
      && typeof window.confirm === "function"
      && !window.confirm(
        isLocalStandaloneUpgrade
          ? `确认切换为“${nextRoleLabel}”？\n\n无需管理员。Desktop 将启用本机 AI、关闭远端 AI 客户端并自动重启；不会开启对外 AI 代理。`
          : `确认切换为“${nextRoleLabel}”？\n\n保存后 Desktop 将自动重启，使新角色真正生效。`,
      )
    ) {
      return;
    }

    setRoleChanging(true);
    if (isLocalStandaloneUpgrade) {
      const result = await window.electronAPI.switchClientToStandalone();
      if (!result?.success) {
        setMsg(result?.error || "切换失败");
        setRoleChanging(false);
        reloadConfig();
        setTimeout(() => setMsg(null), 4500);
        return;
      }
      setMsg("已切换为全功能，Desktop 正在重启…");
      return;
    }

    const patch = { role: nextRole };
    if (nextRole === "node") {
      patch.claudeProxy = { ...(config.claudeProxy || {}), enabled: false };
      patch.claudeProxyClient = { ...(config.claudeProxyClient || {}), enabled: true };
    } else if (nextRole === "server") {
      patch.claudeProxyClient = { ...(config.claudeProxyClient || {}), enabled: false };
    } else {
      // standalone：离开 node 时清理其强制打开的远端客户端标记，默认切回本机 AI，
      // 否则遗留的 claudeProxyClient.enabled=true 会让 devbench 仍判为客户端模式（缺“切换 AI 模型”按钮）。
      // 用户仍可在下方「本机任务的 AI 来源」再选「借用其它服务端」。
      patch.claudeProxyClient = { ...(config.claudeProxyClient || {}), enabled: false };
    }
    const result = await updateMany(patch, {
      successMessage: isDesktop ? "部署角色已保存，Desktop 正在重启…" : "部署角色已保存，请重启网关",
    });
    if (!result?.ok) {
      setRoleChanging(false);
      return;
    }
    if (isDesktop && window.electronAPI?.restartForDeploymentRole) {
      window.electronAPI.restartForDeploymentRole(nextRole);
      return;
    }
    setRoleChanging(false);
  }
  function updateNodeNameSuffix(value) {
    updateMany({ servers: { ...(config.servers || {}), nodeName: value } }, { nodeNameEdit: true });
  }

  function normalizeExecutorRoot(root) {
    return String(root || "").trim().replace(/^["']|["']$/g, "");
  }

  function addExecutorRoot(root = executorRootInput, enable = false) {
    const value = normalizeExecutorRoot(root);
    if (!value) {
      setMsg("请先输入执行目录");
      setTimeout(() => setMsg(null), 1800);
      return;
    }
    const exists = executorRoots.some((r) => String(r).toLowerCase() === value.toLowerCase());
    const nextRoots = exists ? executorRoots : [...executorRoots, value];
    setExecutorRootInput("");
    update("executor", { ...(config.executor || {}), ...(enable ? { enabled: true } : {}), allowedRoots: nextRoots });
  }

  function removeExecutorRoot(root) {
    update("executor", {
      ...(config.executor || {}),
      allowedRoots: executorRoots.filter((r) => r !== root),
    });
  }

  function resetNodeId() {
    const ok = typeof window === "undefined" || window.confirm("确认清空本机节点 ID？保存后需要重启网关，系统会自动生成新的唯一 ID。");
    if (!ok) return;
    update("servers", { ...(config.servers || {}), nodeId: "" });
  }

  async function prepareExecutorRoot(root = executorRootInput || suggestedExecutorRoot) {
    const value = normalizeExecutorRoot(root);
    const headers = { "Content-Type": "application/json" };
    if (adminToken) headers.Authorization = `Bearer ${adminToken}`;
    try {
      const res = await fetch(getApiUrl("/api/executor/prepare-root"), {
        method: "POST",
        headers,
        body: JSON.stringify(value ? { root: value } : {}),
      });
      const d = await res.json().catch(() => ({}));
      if (!res.ok || d.ok === false) throw new Error(d.error || `HTTP ${res.status}`);
      setConfig((p) => ({ ...p, executor: d.data?.executor || p.executor }));
      setExecutorRootInput("");
      setMsg(`已创建并启用：${d.data?.root || value}`);
      setTimeout(() => setMsg(null), 3000);
    } catch (e) {
      setMsg(`准备执行目录失败：${e.message || e}`);
      setTimeout(() => setMsg(null), 4000);
    }
  }

  function checkEngine(engine) {
    setEngineStatus((p) => ({ ...p, [engine]: "checking" }));
    fetch(getApiUrl(`/api/config/check-engine/${engine}`)).then((r) => r.json()).then((d) => {
      setEngineStatus((p) => ({ ...p, [engine]: d.data }));
      // 如果不是可用状态，自动弹出引导弹窗
      if (d.data && !d.data.available) {
        setGuideModal({ engine, status: d.data.status, data: d.data });
      }
    }).catch(() => {});
  }

  function startInstall(engine) {
    setInstallOutput("");
    setInstalling(true);
    fetch(getApiUrl(`/api/config/install-engine/${engine}`), { method: "POST" }).catch(() => {
      setInstalling(false);
    });
  }

  function onAdminLoggedIn(principal) {
    setAdminLoginOpen(false);
    setMsg(`已登录管理员：${principal?.name || principal?.role || ""}`);
    setTimeout(() => setMsg(null), 2200);
    reloadConfig();
  }

  async function handleAdminLogout() {
    await logoutAdmin();
    setAdminLoginOpen(false);
    setMsg("已退出管理员登录");
    setTimeout(() => setMsg(null), 1800);
  }

  return (
    <div className="p-6 overflow-y-auto h-full space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-medium text-zinc-300">设置</h2>
        {msg && <span className="text-xs text-green-400">{msg}</span>}
      </div>

      {/* 网关连接 */}
      <GatewayConnectionSection onSaved={() => {
        setMsg("网关地址已保存");
        setTimeout(() => setMsg(null), 1500);
      }} />

      {/* AI 人设 */}
      <Section title="AI 人设 (Persona)">
        <p className="text-xs text-zinc-600 -mt-2">定义 AI 助手的角色、工作场景和行为准则。每次 AI 对话时自动注入。</p>
        <textarea
          value={config.persona || ""}
          onChange={(e) => update("persona", e.target.value)}
          rows={5}
          placeholder="你是 AAOS 三方应用集成 AI 助手..."
          className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-zinc-200 outline-none focus:border-zinc-500 resize-none font-mono leading-relaxed"
        />
      </Section>

      {/* 上下文管理 */}
      <Section title="上下文管理">
        <ToggleRow label="自动对话摘要" sub="超过10条未摘要消息时自动用 AI 压缩历史为背景摘要" value={config.contextEnableSummary ?? true} onChange={(v) => update("contextEnableSummary", v)} />
        <div>
          <Row label="历史消息条数">
            <input type="number" min={5} max={100} value={config.contextMaxHistory || 30}
              onChange={(e) => update("contextMaxHistory", parseInt(e.target.value) || 30)}
              className="w-20 bg-zinc-800 border border-zinc-700 rounded px-3 py-1.5 text-sm text-zinc-300 text-center outline-none" />
          </Row>
          <p className="text-[10px] text-zinc-600 mt-1">每次 AI 调用时注入的最近消息数。上下文预算根据引擎自动适配，无需手动设置。</p>
        </div>
        <div className="bg-zinc-800/50 rounded-lg p-3">
          <p className="text-[10px] text-zinc-500 mb-2">各引擎上下文预算（自动，基于官方上下文窗口）</p>
          <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-[10px]">
            <span className="text-zinc-500">Claude (200K)</span><span className="text-zinc-400">20,000 字</span>
            <span className="text-zinc-500">Gemini (1M)</span><span className="text-zinc-400">15,000 字</span>
            <span className="text-zinc-500">Codex (200K)</span><span className="text-zinc-400">16,000 字</span>
            <span className="text-zinc-500">Qwen (128K)</span><span className="text-zinc-400">12,000 字</span>
            <span className="text-zinc-500">Kimi (128K)</span><span className="text-zinc-400">12,000 字</span>
            <span className="text-zinc-500">DeepSeek (64K)</span><span className="text-zinc-400">8,000 字</span>
            <span className="text-zinc-500">OpenAI GPT (128K)</span><span className="text-zinc-400">12,000 字</span>
          </div>
          <p className="text-[10px] text-zinc-600 mt-2">预算 = 上下文窗口的 ~5%，留出空间给人设、Skill 指南、任务描述和模型输出。</p>
        </div>
      </Section>

      {/* 故事点开发 */}
      <Section title="故事点开发">
        <ToggleRow
          label="故事点 AI 推理"
          sub="默认关闭。开启后，创建或重新打开故事点会先基于当前可用来源推理工程配置；确认或暂不采用后才继续创建/打开流程。"
          value={isStoryPointAiInferenceEnabled(config)}
          onChange={(v) => update("storyPointAiInferenceEnabled", v)}
          testId="settings-story-ai-inference-toggle"
        />
      </Section>

      {/* 引擎 */}
      <Section title="引擎配置">
        <div>
          <label className="block text-xs text-zinc-500 mb-1">CLI 工作目录</label>
          <input
            type="text"
            value={config.workDir || ""}
            onChange={(e) => update("workDir", e.target.value)}
            placeholder="留空则使用用户主目录（~）"
            className="w-full bg-zinc-800 border border-zinc-700 rounded px-3 py-2 text-sm text-zinc-300 placeholder-zinc-600 outline-none focus:border-zinc-500 font-mono"
          />
          <p className="text-[10px] text-zinc-600 mt-1">CLI 引擎（Claude/Gemini/Codex/Hermes）执行任务时的工作目录。影响文件创建、读取等操作的相对路径。</p>
        </div>
        <Row label="默认引擎">
          <select value={config.defaultEngine} onChange={(e) => update("defaultEngine", e.target.value)}
            className="bg-zinc-800 border border-zinc-700 rounded px-3 py-1.5 text-sm text-zinc-300">
            <option value="claude">Claude（官方）</option>
            {(config.apiEngines?.volcengine?.enabled && config.apiEngines?.volcengine?.apiKey) && (
              <option value="claude-volcengine">Claude（火山方舟）</option>
            )}
            {(config.apiEngines?.minimax?.enabled && config.apiEngines?.minimax?.apiKey) && (
              <option value="claude-minimax">Claude（MiniMax）</option>
            )}
            {(config.apiEngines?.minimax?.enabled && config.apiEngines?.minimax?.apiKey) && (
              <option value="codex-minimax">Codex（MiniMax）</option>
            )}
            <option value="gemini">Gemini CLI</option>
            <option value="codex">OpenAI Codex</option>
            <option value="hermes">Hermes Agent（本地）</option>
            {(config.claudeProxyClient || {}).enabled && (config.claudeProxyClient || {}).host && (
              <option value="claude-proxy">中心 AI 代理</option>
            )}
            {Object.entries(config.apiEngines || {}).filter(([,v]) => v.enabled).map(([id, v]) => (
              <option key={id} value={id}>{v.name}</option>
            ))}
          </select>
        </Row>
        <ToggleRow label="启用 Gemini CLI" sub="免费辅助引擎, 1000次/天" value={config.geminiEnabled} onChange={(v) => update("geminiEnabled", v)} />
        <ToggleRow label="启用 Codex CLI" sub="代码专精引擎，擅长代码生成和修改" value={config.codexEnabled} onChange={(v) => update("codexEnabled", v)} />
        <ToggleRow label="启用 Hermes Agent" sub="使用本机已配置的 Hermes 智能体及其工具、记忆和模型" value={config.hermesEnabled} onChange={(v) => update("hermesEnabled", v)} />
        <ToggleRow label="失败自动切换" sub="默认引擎失败时自动切换到备用引擎" value={config.autoFallback} onChange={(v) => update("autoFallback", v)} />
        <Row label="最大 CLI 并发">
          <select value={config.maxCliConcurrency || 2} onChange={(e) => update("maxCliConcurrency", parseInt(e.target.value))}
            className="bg-zinc-800 border border-zinc-700 rounded px-3 py-1.5 text-sm text-zinc-300">
            {[1, 2, 3, 4].map(n => <option key={n} value={n}>{n} 个进程</option>)}
          </select>
        </Row>

        <div className="flex flex-wrap gap-3 pt-2">
          {["claude", "gemini", "codex", "hermes"].map((eng) => {
            const s = engineStatus[eng];
            const names = { claude: "Claude（官方）", gemini: "Gemini CLI", codex: "OpenAI Codex", hermes: "Hermes Agent" };
            return (
              <button key={eng} onClick={() => checkEngine(eng)}
                className="flex-1 min-w-[140px] flex items-center justify-between p-3 bg-zinc-800/50 border border-zinc-700 rounded-lg hover:border-zinc-600 transition">
                <div>
                  <p className="text-xs font-medium text-zinc-300">{names[eng]}</p>
                  <p className="text-xs text-zinc-600 mt-0.5">
                    {!s ? "点击检测" : s === "checking" ? "检测中..." : s.available ? "可用" :
                      s.status === "not_installed" ? "未安装" : s.status === "need_login" ? "需登录" : "不可用"}
                  </p>
                </div>
                <span className={`w-2 h-2 rounded-full ${!s ? "bg-zinc-700" : s === "checking" ? "bg-zinc-600 animate-pulse" : s.available ? "bg-green-500" : "bg-red-500"}`} />
              </button>
            );
          })}
        </div>
      </Section>

      {/* 监察审查 */}
      <Section title="监察审查">
        <ToggleRow label="启用监察审查" sub="涉及代码/文件修改的任务自动审查输出质量" value={config.enableInspection ?? true} onChange={(v) => update("enableInspection", v)} />
        <Row label="审查引擎">
          <select value={config.inspectionEngine || "gemini"} onChange={(e) => update("inspectionEngine", e.target.value)}
            className="bg-zinc-800 border border-zinc-700 rounded px-3 py-1.5 text-sm text-zinc-300">
            <option value="gemini">Gemini CLI (免费)</option>
            <option value="claude">Claude（官方）</option>
            {(config.apiEngines?.volcengine?.enabled && config.apiEngines?.volcengine?.apiKey) && (
              <option value="claude-volcengine">Claude（火山方舟）</option>
            )}
            {(config.apiEngines?.minimax?.enabled && config.apiEngines?.minimax?.apiKey) && (
              <option value="claude-minimax">Claude（MiniMax）</option>
            )}
            {(config.apiEngines?.minimax?.enabled && config.apiEngines?.minimax?.apiKey) && (
              <option value="codex-minimax">Codex（MiniMax）</option>
            )}
            <option value="codex">OpenAI Codex</option>
            {Object.entries(config.apiEngines || {}).filter(([,v]) => v.enabled).map(([id, v]) => (
              <option key={id} value={id}>{v.name}</option>
            ))}
          </select>
        </Row>
        <Row label="审查失败重试">
          <select value={config.maxInspectionRetries ?? 1} onChange={(e) => update("maxInspectionRetries", parseInt(e.target.value))}
            className="bg-zinc-800 border border-zinc-700 rounded px-3 py-1.5 text-sm text-zinc-300">
            <option value={0}>不重试</option>
            <option value={1}>重试 1 次</option>
            <option value={2}>重试 2 次</option>
          </select>
        </Row>
        <div className="bg-zinc-800/50 rounded-lg p-3">
          <p className="text-[10px] text-zinc-500 mb-1.5">审查范围</p>
          <p className="text-xs text-zinc-400">涉及修改的 Skill（smali-analyze、resolution-adapt、apk-repack、coding-agent 等）执行完成后自动触发监察审查。</p>
          <p className="text-xs text-zinc-500 mt-1">多任务拆分：由 AI 规划器标记 inspect: true 的子任务</p>
          <p className="text-xs text-zinc-500">单任务执行：匹配修改类 Skill 时自动触发</p>
        </div>
      </Section>

      {/* 任务拆分 */}
      <Section title="任务拆分">
        <ToggleRow label="启用任务拆分" sub="复合任务自动拆分为多个子任务并行执行" value={config.enableDecomposition ?? true} onChange={(v) => update("enableDecomposition", v)} />
        <Row label="拆分引擎">
          <select value={config.decompositionEngine || "gemini"} onChange={(e) => update("decompositionEngine", e.target.value)}
            className="bg-zinc-800 border border-zinc-700 rounded px-3 py-1.5 text-sm text-zinc-300">
            <option value="gemini">Gemini CLI (免费)</option>
            <option value="claude">Claude Code</option>
            {config.hermesEnabled && <option value="hermes">Hermes Agent（本地）</option>}
          </select>
        </Row>
        <Row label="汇总引擎">
          <select value={config.summaryEngine || "gemini"} onChange={(e) => update("summaryEngine", e.target.value)}
            className="bg-zinc-800 border border-zinc-700 rounded px-3 py-1.5 text-sm text-zinc-300">
            <option value="gemini">Gemini CLI (免费)</option>
            <option value="claude">Claude（官方）</option>
            {config.hermesEnabled && <option value="hermes">Hermes Agent（本地）</option>}
            {(config.apiEngines?.volcengine?.enabled && config.apiEngines?.volcengine?.apiKey) && (
              <option value="claude-volcengine">Claude（火山方舟）</option>
            )}
            {(config.apiEngines?.minimax?.enabled && config.apiEngines?.minimax?.apiKey) && (
              <option value="claude-minimax">Claude（MiniMax）</option>
            )}
            {(config.apiEngines?.minimax?.enabled && config.apiEngines?.minimax?.apiKey) && (
              <option value="codex-minimax">Codex（MiniMax）</option>
            )}
          </select>
        </Row>
        <Row label="最大子任务数">
          <select value={config.maxSubtasks || 5} onChange={(e) => update("maxSubtasks", parseInt(e.target.value))}
            className="bg-zinc-800 border border-zinc-700 rounded px-3 py-1.5 text-sm text-zinc-300">
            {[3, 5, 7, 10].map((n) => (
              <option key={n} value={n}>{n}</option>
            ))}
          </select>
        </Row>
      </Section>

      {/* AI 模式配置（局域网共享，阶段0） */}
      <Section title="AI 模式配置（局域网共享）" defer onVisible={loadDeploymentHints}>
        <div className="flex items-start justify-between -mt-2 gap-2">
          <p className="text-xs text-zinc-600">让一台中心机统一承载 AI 模型调用与编排能力，局域网其它机器可借用它处理<strong className="text-zinc-400">文本任务、报告生成和协同开发</strong>；涉及本机路径、Gradle、Git、ADB 等重操作仍在各自机器本地执行。</p>
          <div className="shrink-0 flex items-center gap-1.5">
            <span className={`text-[10px] whitespace-nowrap px-1.5 py-0.5 rounded ${isAdmin ? "bg-emerald-900/30 text-emerald-300" : adminLoading ? "bg-blue-900/30 text-blue-300" : isPureClientRole ? "bg-zinc-800 text-zinc-400" : "bg-amber-900/30 text-amber-300"}`}>
              {isAdmin ? `🔓 管理员：${me.name}` : adminLoading ? "⏳ 正在确认管理员身份" : isPureClientRole ? (isDesktop ? "💻 仅客户端（可切单机）" : "💻 仅客户端") : "🔒 部署设置需管理员"}
            </span>
            {adminLoading ? null : isAdmin ? (
              <button onClick={handleAdminLogout} className="text-[10px] px-2 py-0.5 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-300 border border-zinc-700 transition">
                退出
              </button>
            ) : (
              <button onClick={() => setAdminLoginOpen((v) => !v)} className="text-[10px] px-2 py-0.5 rounded bg-blue-600/20 hover:bg-blue-600/30 text-blue-300 border border-blue-600/40 transition">
                管理员登录
              </button>
            )}
          </div>
        </div>
        {adminLoginOpen && !isAdmin && !adminLoading && <AdminInlineLogin onLoggedIn={onAdminLoggedIn} onCancel={() => setAdminLoginOpen(false)} />}
        {!isAdmin && !adminLoading && !isPureClientRole && <p className="text-[10px] text-amber-500/70 -mt-1">部署角色 / 对外提供 AI 代理 / 执行器 / 分布式执行 等设置已锁定，请先在本页或「管理后台」登录后再改。普通用户仍可选择本机任务使用哪个 AI 来源。</p>}
        {isPureClientRole && (
          <p className="text-[10px] text-zinc-500 -mt-1">
            当前部署角色只保留本机开发能力，AI 固定从其它服务端获取。
            {isAdmin
              ? (isDesktop ? "要改用本机 AI，请选择「全功能」，Desktop 将自动重启。" : "要改用本机 AI，请选择「全功能」，然后重启网关。")
              : (canSwitchClientToStandalone
                ? "如果本机已有 AI 模型，可直接选择「全功能（单机模式）」，无需管理员，Desktop 会自动重启。"
                : "要改用本机 AI，请先登录管理员，再选择「全功能」。")}
          </p>
        )}

        <Row label="本机用途（部署角色）">
          <select disabled={!canChangeDeploymentRole || roleChanging} value={role} onChange={(e) => changeRole(e.target.value)}
            className="bg-zinc-800 border border-zinc-700 rounded px-3 py-1.5 text-sm text-zinc-300 disabled:opacity-50 disabled:cursor-not-allowed">
            {DEPLOYMENT_ROLE_OPTIONS.map((option) => (
              <option
                key={option.value}
                value={option.value}
                disabled={!isAdmin && option.value !== "standalone" && option.value !== role}
              >
                {option.label}
              </option>
            ))}
          </select>
        </Row>
        <div className="text-[10px] text-zinc-500 -mt-1 rounded border border-zinc-800 bg-zinc-950/30 px-2.5 py-2">
          {role === "standalone" && <>当前为<strong className="text-zinc-300">全功能</strong>：保留本机开发页面，也可开启对外 AI 代理；本机任务的 AI 来源可在下方选择。</>}
          {role === "server" && <>当前为<strong className="text-zinc-300">仅服务端</strong>：用于提供 AI 代理和编排服务，不挂载工程开发、聊天、TB 任务等本机页面。</>}
          {role === "node" && <>当前为<strong className="text-zinc-300">仅客户端</strong>：保留本机开发页面，不对外提供中心服务，AI 固定借用其它服务端。</>}
          <span className="ml-1">
            {isDesktop
              ? <>角色变更保存后 Desktop 会<strong className="text-amber-400">自动重启</strong>并应用新角色。</>
              : <>角色变更保存后需<strong className="text-amber-400">重启网关</strong>。</>}
            环境变量 ROLE 的优先级更高。
          </span>
        </div>

        <Row label="本机节点 ID">
          <div className="flex flex-col items-end gap-1.5">
            <div className="flex flex-wrap items-center justify-end gap-2">
              <input readOnly value={(config.servers || {}).nodeId || "重启后自动生成"}
                className="w-64 bg-zinc-800 border border-zinc-700 rounded px-3 py-1.5 text-sm text-zinc-400 outline-none font-mono" />
              <button onClick={resetNodeId} disabled={!canEditLocalNode}
                className="px-3 py-1.5 text-xs bg-zinc-700 hover:bg-zinc-600 disabled:opacity-50 disabled:cursor-not-allowed text-zinc-200 rounded transition whitespace-nowrap">
                重置 ID
              </button>
            </div>
            <span className="text-[10px] text-zinc-600">复制整份配置到其它机器后请重置；保存后重启网关才会生成新 ID。</span>
          </div>
        </Row>

        <Row label="本机节点名称">
          <div className="flex flex-col items-end gap-1.5">
            <div className="flex flex-wrap items-center justify-end gap-0">
              {nodeNameOwner && (
                <span className="max-w-[180px] truncate bg-zinc-900 border border-zinc-700 rounded-l px-3 py-1.5 text-sm text-zinc-400 select-none">
                  {nodeNameOwner}-
                </span>
              )}
              <input type="text" disabled={!isAdmin} value={nodeNameSuffix} onChange={(e) => updateNodeNameSuffix(e.target.value)}
                placeholder="留空用主机名" className={`${nodeNameOwner ? "rounded-l-none border-l-0" : "rounded"} w-60 bg-zinc-800 border border-zinc-700 px-3 py-1.5 text-sm text-zinc-300 placeholder-zinc-600 outline-none disabled:opacity-50`} />
            </div>
            <span className="text-[10px] text-zinc-600">最终显示：{nodeNamePreview}</span>
          </div>
        </Row>

        {/* ① 仅"服务端/单机"角色显示：对外提供 AI 代理（仅此角色挂 /api/claude-proxy） */}
        {role !== "node" && (
          <>
            <h3 className="text-xs font-semibold text-zinc-400 pt-2">① 本机对外提供 AI 代理（中心机）</h3>
            {(config.claudeProxy || {}).enabled && selfHost && (
              <div className="text-[10px] text-emerald-500/80 bg-emerald-900/10 border border-emerald-800/30 rounded px-2.5 py-1.5 -mt-1">
                📦 局域网自分发已就绪：让其它设备浏览器打开 <span className="font-mono text-emerald-300">{selfHost}/install</span> 一键装客户端（自动配成"客户端+已连本机"）。桌面 EXE 入口需管理员把安装包放到服务端。
              </div>
            )}
            <ToggleRow label="对外提供 AI 文本代理" sub="开启后本机暴露 /api/claude-proxy 供局域网远端调用；本机自身将使用本机 AI 代理能力（不再借用其它服务端）" disabled={!isAdmin}
              value={(config.claudeProxy || {}).enabled || false}
              onChange={(v) => updateMany({ claudeProxy: { ...(config.claudeProxy || {}), enabled: v }, ...(v ? { claudeProxyClient: { ...(config.claudeProxyClient || {}), enabled: false } } : {}) })} />
            {(config.claudeProxy || {}).enabled && (
              <>
                <Row label="最大并发">
                  <select disabled={!isAdmin} value={(config.claudeProxy || {}).maxConcurrent || 3} onChange={(e) => update("claudeProxy", { ...(config.claudeProxy || {}), maxConcurrent: parseInt(e.target.value) })}
                    className="bg-zinc-800 border border-zinc-700 rounded px-3 py-1.5 text-sm text-zinc-300 disabled:opacity-50">
                    {[1, 2, 3, 4, 5].map((n) => <option key={n} value={n}>{n}</option>)}
                  </select>
                  <span className="text-[10px] text-zinc-600 ml-2">= 最多同时开几个故事点（算力之一）</span>
                </Row>
                <Row label="每日 token 额度">
                  <input type="number" min="0" disabled={!isAdmin} value={(config.claudeProxy || {}).dailyTokenBudget || 0} onChange={(e) => update("claudeProxy", { ...(config.claudeProxy || {}), dailyTokenBudget: parseInt(e.target.value) || 0 })}
                    className="w-32 bg-zinc-800 border border-zinc-700 rounded px-3 py-1.5 text-sm text-zinc-300 outline-none disabled:opacity-50" />
                  <span className="text-[10px] text-zinc-600 ml-2">0=不限；用尽则算力不足，客户端不可连（AI 代理剩余用量）</span>
                </Row>
                <Row label="代理后端">
                  <select disabled={!isAdmin} value={(config.claudeProxy || {}).backend || "cli"} onChange={(e) => update("claudeProxy", { ...(config.claudeProxy || {}), backend: e.target.value })}
                    className="bg-zinc-800 border border-zinc-700 rounded px-3 py-1.5 text-sm text-zinc-300 disabled:opacity-50">
                    <option value="cli">Claude CLI 订阅</option>
                    <option value="codex">Codex CLI 订阅</option>
                    <option value="api">Anthropic API Key</option>
                    <option value="api-engine">OpenAI 兼容 API Key</option>
                  </select>
                </Row>
                {((config.claudeProxy || {}).backend || "cli") === "cli" ? (
                  <p className="text-[10px] text-amber-500/80 -mt-1">⚠ 使用中心机已登录的 Claude CLI 订阅账号；多人共享同一账号有政策/风控风险。</p>
                ) : ((config.claudeProxy || {}).backend || "cli") === "codex" ? (
                  <p className="text-[10px] text-amber-500/80 -mt-1">⚠ 使用中心机已登录的 Codex CLI 订阅账号；需先在服务端运行 codex login。该模式只用于文本代理，不在远端直接改文件。</p>
                ) : ((config.claudeProxy || {}).backend || "cli") === "api" ? (
                  <p className="text-[10px] text-emerald-500/80 -mt-1">✓ 使用 Anthropic 官方 API Key 按量调用；未填 Key 时会回落到 Claude CLI。</p>
                ) : (
                  <p className="text-[10px] text-emerald-500/80 -mt-1">✓ 使用下方已配置的 OpenAI 兼容 AI 模型服务（OpenAI / DeepSeek / Kimi / 千问等）；未配 Key 时会回落到 Claude CLI。</p>
                )}
                {((config.claudeProxy || {}).backend || "cli") === "api" && (
                  <>
                    <Row label="Anthropic API Key">
                      <input type="password" disabled={!isAdmin} value={(config.claudeProxy || {}).anthropicApiKey || ""} onChange={(e) => update("claudeProxy", { ...(config.claudeProxy || {}), anthropicApiKey: e.target.value })}
                        placeholder="sk-ant-..." className="w-60 bg-zinc-800 border border-zinc-700 rounded px-3 py-1.5 text-sm text-zinc-300 placeholder-zinc-600 outline-none font-mono disabled:opacity-50" />
                    </Row>
                    <Row label="模型">
                      <input type="text" disabled={!isAdmin} value={(config.claudeProxy || {}).anthropicModel || "claude-sonnet-4-6"} onChange={(e) => update("claudeProxy", { ...(config.claudeProxy || {}), anthropicModel: e.target.value })}
                        placeholder="claude-sonnet-4-6" className="w-60 bg-zinc-800 border border-zinc-700 rounded px-3 py-1.5 text-sm text-zinc-300 placeholder-zinc-600 outline-none font-mono disabled:opacity-50" />
                    </Row>
                  </>
                )}
                {((config.claudeProxy || {}).backend || "cli") === "api-engine" && (
                  <Row label="AI 模型">
                    <select disabled={!isAdmin} value={(config.claudeProxy || {}).apiEngineId || "openai"} onChange={(e) => update("claudeProxy", { ...(config.claudeProxy || {}), apiEngineId: e.target.value })}
                      className="bg-zinc-800 border border-zinc-700 rounded px-3 py-1.5 text-sm text-zinc-300 disabled:opacity-50">
                      {Object.entries(config.apiEngines || {}).map(([id, v]) => (
                        <option key={id} value={id}>{v.name || id}{v.enabled ? "" : "（未启用）"}</option>
                      ))}
                    </select>
                    <span className="text-[10px] text-zinc-600 ml-2">在下方「AI 模型」里启用并填写 Key 后生效</span>
                  </Row>
                )}
              </>
            )}
          </>
        )}

        {/* ② 中心 AI 推理 + 客户端本地执行：只传上下文和动作，不让中心机直接操作远端路径 */}
        <div className="pt-3 mt-1 border-t border-zinc-800">
          <h3 className="text-xs font-semibold text-zinc-400">② 分布式执行模式</h3>
          <ToggleRow label="启用中心推理 + 本机执行" sub="开启后故事点可把上下文发送给中心 AI，由中心生成结构化动作，再由客户端在本机工程内执行并回传结果" disabled={!canEditLocalNode}
            value={(config.distributedExecution || {}).enabled !== false}
            onChange={(v) => update("distributedExecution", { ...(config.distributedExecution || {}), enabled: v })} />
          <Row label="最大回合数">
            <input type="number" min="1" max="30" disabled={!canEditLocalNode || (config.distributedExecution || {}).enabled === false}
              value={(config.distributedExecution || {}).maxRounds || 12}
              onChange={(e) => update("distributedExecution", { ...(config.distributedExecution || {}), maxRounds: Math.max(1, Math.min(30, parseInt(e.target.value) || 12)) })}
              className="w-24 bg-zinc-800 border border-zinc-700 rounded px-3 py-1.5 text-sm text-zinc-300 outline-none disabled:opacity-50" />
            <span className="text-[10px] text-zinc-600 ml-2">每回合只允许一个动作；路径默认必须相对工程根；动作与结果写入审计</span>
          </Row>
          <Row label="命令权限">
            <select disabled={!canEditLocalNode || (config.distributedExecution || {}).enabled === false}
              value={(config.distributedExecution || {}).commandPolicy || "trusted"}
              onChange={(e) => update("distributedExecution", { ...(config.distributedExecution || {}), commandPolicy: e.target.value })}
              className="bg-zinc-800 border border-zinc-700 rounded px-3 py-1.5 text-sm text-zinc-300 disabled:opacity-50">
              <option value="trusted">完全信任（可信局域网）</option>
              <option value="workspace">受控工作区</option>
              <option value="read_only">只读</option>
            </select>
            <span className="text-[10px] text-zinc-600 ml-2">文件仍限制在故事点工程根目录；完全信任允许中心机驱动构建、测试等命令</span>
          </Row>
        </div>

        {/* ③ 仅"客户端/单机"角色显示：远端执行器（仅此角色挂 /api/executor） */}
        {role !== "server" && (
          <>
            <h3 className="text-xs font-semibold text-zinc-400 pt-3">③ 本机作为「远端执行器」（被中心大脑驱动改本机工程）</h3>
            <ToggleRow label="启用远端执行器" sub="开启后本机暴露 /api/executor，中心可在本机工程内执行 读/写/编辑/列目录/bash（沙箱+白名单）" disabled={!canEditLocalNode}
              value={(config.executor || {}).enabled || false} onChange={(v) => update("executor", { ...(config.executor || {}), enabled: v })} />
            <div className="space-y-2">
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs text-zinc-500">执行目录白名单</span>
                <button onClick={() => prepareExecutorRoot(suggestedExecutorRoot)} disabled={!canEditLocalNode}
                  className="px-2.5 py-1 text-[11px] bg-blue-600/20 text-blue-300 hover:bg-blue-600/30 disabled:opacity-50 disabled:cursor-not-allowed rounded transition whitespace-nowrap">
                  使用默认目录并启用
                </button>
              </div>
              <div className="flex flex-wrap gap-2">
                <input type="text" value={executorRootInput} disabled={!canEditLocalNode}
                  onChange={(e) => setExecutorRootInput(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") addExecutorRoot(); }}
                  placeholder={suggestedExecutorRoot || "默认取车型源码配置里的克隆父路径"}
                  className="flex-1 min-w-[260px] bg-zinc-800 border border-zinc-700 rounded px-3 py-1.5 text-sm text-zinc-300 placeholder-zinc-600 outline-none font-mono disabled:opacity-50" />
                <button onClick={() => addExecutorRoot()} disabled={!canEditLocalNode}
                  className="px-3 py-1.5 text-xs bg-zinc-700 hover:bg-zinc-600 disabled:opacity-50 disabled:cursor-not-allowed text-zinc-200 rounded transition">
                  加入白名单
                </button>
                <button onClick={() => prepareExecutorRoot(executorRootInput || suggestedExecutorRoot)} disabled={!canEditLocalNode}
                  className="px-3 py-1.5 text-xs bg-zinc-700 hover:bg-zinc-600 disabled:opacity-50 disabled:cursor-not-allowed text-zinc-200 rounded transition">
                  创建并加入
                </button>
              </div>
              {executorRoots.length > 0 ? (
                <div className="space-y-1">
                  {executorRoots.map((root) => (
                    <div key={root} className="flex items-center gap-2 text-[11px]">
                      <code className="flex-1 min-w-0 truncate bg-zinc-950 border border-zinc-800 rounded px-2 py-1 text-zinc-400">{root}</code>
                      <button onClick={() => removeExecutorRoot(root)} disabled={!canEditLocalNode}
                        className="px-2 py-1 text-[10px] bg-zinc-800 hover:bg-zinc-700 disabled:opacity-50 disabled:cursor-not-allowed text-zinc-300 rounded transition">
                        删除
                      </button>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-[10px] text-zinc-600">未额外配置白名单；默认仍允许应用市场工程和克隆目录。跨端自测建议先创建专用测试目录。</p>
              )}
              <p className="text-[10px] text-zinc-600">默认目录实时取本机「车型源码配置」里的克隆父路径；该路径不参与局域网同步，可随本机工程配置备份/还原。</p>
            </div>
            <p className="text-[10px] text-zinc-600 -mt-1">仅允许操作本机「应用市场工程配置」里的工程及克隆目录；文件路径不得越出工程根。run_bash 为本机命令执行，请只在可信局域网开启。</p>
          </>
        )}

        {/* AI 来源只描述本机任务发往哪里；部署角色决定能力范围，二者不再表现为两个可冲突的“模式”。 */}
        <div className="pt-3 mt-1 border-t border-zinc-800">
          <h3 className="text-xs font-semibold text-zinc-400">本机任务的 AI 来源 <span className="text-[10px] font-normal text-zinc-600">（不改变部署角色）</span></h3>
          {role === "server" ? (
            <div className="text-[11px] text-zinc-500 mt-2 rounded border border-zinc-800 bg-zinc-950/30 px-3 py-2">
              <strong className="text-zinc-300">不适用</strong>：仅服务端不运行本机开发任务；它只按上方配置向其它客户端提供 AI 服务。
            </div>
          ) : role === "node" ? (
            <div className="text-[11px] text-blue-300/80 mt-2 rounded border border-blue-900/40 bg-blue-950/20 px-3 py-2">
              <strong className="text-blue-200">固定为：借用其它服务端</strong>。这是「仅客户端」角色的规则，请在下方选择要连接的服务端。
            </div>
          ) : (config.claudeProxy || {}).enabled ? (
            <div className="text-[11px] text-emerald-300/80 mt-2 rounded border border-emerald-900/40 bg-emerald-950/20 px-3 py-2">
              <strong className="text-emerald-200">固定为：本机 AI</strong>。本机正在对外提供 AI 代理，不能同时借用另一台服务端；如需借用，请由管理员先关闭上方「对外提供 AI 文本代理」。
            </div>
          ) : (
            <Row label="AI 来源">
              <select value={(config.claudeProxyClient || {}).enabled ? "server" : "local"} onChange={(e) => update("claudeProxyClient", { ...(config.claudeProxyClient || {}), enabled: e.target.value === "server" })}
                className="bg-zinc-800 border border-zinc-700 rounded px-3 py-1.5 text-sm text-zinc-300">
                <option value="local">使用本机 AI（CLI 或已配置的 API）</option>
                <option value="server">借用其它服务端的 AI</option>
              </select>
            </Row>
          )}

          {role !== "server" && (role === "node" || (config.claudeProxyClient || {}).enabled) && (
            <>
              <Row label="连接口令">
                <input type="text" value={(config.claudeProxyClient || {}).token || ""} onChange={(e) => update("claudeProxyClient", { ...(config.claudeProxyClient || {}), token: e.target.value })}
                  placeholder={`与目标服务端的「对外服务口令」一致`} className="w-72 bg-zinc-800 border border-zinc-700 rounded px-3 py-1.5 text-sm text-zinc-300 placeholder-zinc-600 outline-none font-mono" />
              </Row>
              {/* 选服务端：局域网发现 + 算力 + 满载禁选 + 跨子网手动加 IP（连接即写入 host） */}
              <ServerSelect config={config} onSelected={reloadConfig} />
            </>
          )}
        </div>
      </Section>

      <Section title="局域网车型配置同步">
        <p className="text-xs leading-relaxed text-zinc-500 -mt-2">
          无需开关、建组、加入码或逐台确认。管理员第一次在“车型源码配置”里明确发布变更时，系统自动建立局域网同步；其它 Gateway 自动加入并接收。打开页面、刷新、启动服务和 UDP 发现都不会上传本机旧配置。
        </p>
        <div className="rounded-lg border border-zinc-800 bg-zinc-950/30 px-3 py-2 text-[11px] text-zinc-400">
          <span data-testid="lan-sync-status" className={(config.lanSync || {}).syncMode === "peer" ? "text-emerald-400" : "text-zinc-500"}>
            {(config.lanSync || {}).syncMode === "peer" ? "局域网自动同步已运行" : "等待第一次管理员车型配置发布"}
          </span>
          <span className="mx-2 text-zinc-700">·</span>
          <span className="font-mono">team/vehicle-source</span>
          <span className="mx-2 text-zinc-700">·</span>
          <span>应用层加密 X25519 + AES-256-GCM</span>
        </div>
        <div className="rounded-lg border border-emerald-950/80 bg-emerald-950/20 p-3">
          <div className="text-xs font-medium text-emerald-300">全自动工作方式</div>
          <p className="mt-1 text-[10px] leading-relaxed text-zinc-500">
            管理员正常编辑并发布车型配置即可。在线节点通过 WebSocket 增量接收；断线节点按指数退避重连；UDP socket 只在启动、IP/拓扑变化时通知，并以 90 秒低频兜底。
          </p>
        </div>
        <p className="text-[10px] leading-relaxed text-zinc-600">
          无需购买或填写 mTLS 证书。同步数据仍使用设备签名与 X25519 + AES-256-GCM 会话加密；全自动发现以可访问该 UDP 广播域的公司局域网作为自动加入边界。
        </p>
      </Section>

      {/* 日志与维护 */}
      <Section title="日志与维护">
        <Row label="日志保留天数">
          <input type="number" min="0" value={config.logRetentionDays ?? 14} onChange={(e) => update("logRetentionDays", parseInt(e.target.value) || 0)}
            className="w-24 bg-zinc-800 border border-zinc-700 rounded px-3 py-1.5 text-sm text-zinc-300 outline-none" />
          <span className="text-[10px] text-zinc-600 ml-2">本机操作日志超过该天数自动清理；0=不按时间清。另有 20 万条总量兜底。启动时清一次 + 每 12h 清。</span>
        </Row>
        <p className="text-[10px] text-zinc-600 -mt-1">反馈「诊断包」默认装当天日志；新建反馈页可「补某天日志」。日志会随反馈发给 Claude 用于还原现场修复，请保证保留窗口覆盖你反馈的问题时段。</p>
      </Section>

      {/* AI 配置备份与迁移 */}
      <Section title="AI 配置备份与迁移">
        <DeferredSettingsPanel placeholder="滚动到此区域时加载运行环境与备份清单…">
          <BackupMigratePanel />
        </DeferredSettingsPanel>
      </Section>

      {/* AI 模型服务 */}
      <Section title="AI 模型（OpenAI 兼容）" defer>
        <p className="text-xs text-zinc-600 -mt-2">
          配置模型服务后，可在故事点中与 Claude / Codex 一键切换。内置含 Atlas Coding Plan、通义、Kimi、DeepSeek、OpenAI、智谱 BigModel；也可添加任意 OpenAI 兼容端点。
        </p>
        <div className="border border-zinc-800 rounded-lg p-3 space-y-2 bg-zinc-950/30">
          <div className="text-xs font-medium text-zinc-300">模型调用工具权限</div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-[10px] text-zinc-500">命令授权</label>
              <select
                value={(config.apiAgent || {}).commandPolicy || "workspace"}
                onChange={(e) => update("apiAgent", { ...(config.apiAgent || {}), commandPolicy: e.target.value })}
                className="w-full bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-xs text-zinc-300 outline-none"
              >
                <option value="read_only">只读审查</option>
                <option value="workspace">工作区开发（安全命令自动批准）</option>
                <option value="trusted">完全信任（允许高风险命令）</option>
              </select>
            </div>
            <div className="flex items-end pb-1">
              <label className="flex items-center gap-2 text-xs text-zinc-400">
                <input
                  type="checkbox"
                  checked={(config.apiAgent || {}).workspaceIsolation !== false}
                  onChange={(e) => update("apiAgent", { ...(config.apiAgent || {}), workspaceIsolation: e.target.checked })}
                  className="rounded border-zinc-600"
                />
                文件路径限制在故事点工作区
              </label>
            </div>
            <div>
              <label className="text-[10px] text-zinc-500">单片段最大 Agent 轮次</label>
              <input
                type="number"
                min="1"
                max="1000"
                value={config.apiMaxToolIterations ?? 80}
                onChange={(e) => update("apiMaxToolIterations", Math.min(1000, Math.max(1, parseInt(e.target.value) || 80)))}
                className="w-full bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-xs text-zinc-300 outline-none"
              />
              <p className="text-[10px] text-zinc-600 mt-1">达到上限后保存 partial，可在下一片段继续</p>
            </div>
            <div>
              <label className="text-[10px] text-zinc-500">API 单片段总时限（分钟）</label>
              <input
                type="number"
                min="5"
                max="10080"
                value={(config.apiAgent || {}).activeTurnMaxMinutes ?? 480}
                onChange={(e) => update("apiAgent", { ...(config.apiAgent || {}), activeTurnMaxMinutes: Math.min(10080, Math.max(5, parseInt(e.target.value) || 480)) })}
                className="w-full bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-xs text-zinc-300 outline-none"
              />
            </div>
            <div>
              <label className="text-[10px] text-zinc-500">无业务推进警告（分钟）</label>
              <input
                type="number"
                min="1"
                max="10080"
                value={(config.apiAgent || {}).meaningfulProgressWarningMinutes ?? 10}
                onChange={(e) => update("apiAgent", { ...(config.apiAgent || {}), meaningfulProgressWarningMinutes: Math.min(10080, Math.max(1, parseInt(e.target.value) || 10)) })}
                className="w-full bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-xs text-zinc-300 outline-none"
              />
            </div>
            <div>
              <label className="text-[10px] text-zinc-500">无业务推进取消（分钟）</label>
              <input
                type="number"
                min="2"
                max="43200"
                value={(config.apiAgent || {}).meaningfulProgressCancelMinutes ?? 60}
                onChange={(e) => update("apiAgent", { ...(config.apiAgent || {}), meaningfulProgressCancelMinutes: Math.min(43200, Math.max(2, parseInt(e.target.value) || 60)) })}
                className="w-full bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-xs text-zinc-300 outline-none"
              />
            </div>
            <div>
              <label className="text-[10px] text-zinc-500">取消后退出验证（秒）</label>
              <input
                type="number"
                min="1"
                max="120"
                value={(config.apiAgent || {}).terminationVerifySeconds ?? 15}
                onChange={(e) => update("apiAgent", { ...(config.apiAgent || {}), terminationVerifySeconds: Math.min(120, Math.max(1, parseInt(e.target.value) || 15)) })}
                className="w-full bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-xs text-zinc-300 outline-none"
              />
            </div>
          </div>
          <p className="text-[10px] text-sky-400/75">心跳、状态和思考流只证明进程存活；正文、工具完成和检查点才刷新业务推进时间。限制只作用于一次可恢复执行片段，故事点及其检查点可保存数月或数年并继续执行。</p>
          <p className="text-[10px] text-amber-500/70">工作区隔离适用于文件/Git工具；Shell 不是操作系统沙箱。“完全信任”仅应在可信工程中临时启用。</p>
        </div>

        <div className="flex items-center justify-between gap-3 pt-1">
          <div className="text-[11px] text-zinc-500">
            已配置 {Object.keys(config.apiEngines || {}).length} 个 · 已启用 {Object.values(config.apiEngines || {}).filter((v) => v?.enabled).length} 个
          </div>
          <button
            type="button"
            onClick={() => {
              setShowAddApiEngine((v) => !v);
              if (!showAddApiEngine) applyApiEngineTemplate("blank");
            }}
            className="text-xs px-3 py-1.5 rounded-md bg-sky-500/15 text-sky-300 border border-sky-500/30 hover:bg-sky-500/25 transition-colors"
          >
            {showAddApiEngine ? "收起添加面板" : "+ 添加自定义模型服务"}
          </button>
        </div>

        {showAddApiEngine && (
          <div className="rounded-xl border border-sky-900/50 bg-gradient-to-br from-sky-950/40 via-zinc-950/60 to-zinc-950 p-4 space-y-3 shadow-lg shadow-sky-950/20">
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="text-sm font-medium text-sky-100">接入任意 OpenAI 兼容模型</div>
                <p className="text-[11px] text-zinc-500 mt-0.5">填写 Base URL + API Key + 模型名即可初始化；可先选模板再改。</p>
              </div>
            </div>
            <div className="flex flex-wrap gap-2">
              {API_ENGINE_TEMPLATES.map((t) => (
                <button
                  key={t.key}
                  type="button"
                  onClick={() => applyApiEngineTemplate(t.key)}
                  className={`text-[11px] px-2.5 py-1 rounded-full border transition-colors ${
                    apiEngineDraft.template === t.key
                      ? "border-sky-400/60 bg-sky-500/20 text-sky-200"
                      : "border-zinc-700 text-zinc-400 hover:border-zinc-500 hover:text-zinc-200"
                  }`}
                >
                  {t.name}
                </button>
              ))}
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="text-[10px] text-zinc-500">模型服务 ID（唯一）</label>
                <input
                  value={apiEngineDraft.id}
                  onChange={(e) => setApiEngineDraft((p) => ({ ...p, id: e.target.value.toLowerCase().replace(/[^a-z0-9_-]/g, "") }))}
                  placeholder="my-llm"
                  className="w-full bg-zinc-900 border border-zinc-700 rounded-md px-2 py-1.5 text-xs text-zinc-200 outline-none focus:border-sky-500/50 font-mono"
                />
              </div>
              <div>
                <label className="text-[10px] text-zinc-500">显示名称</label>
                <input
                  value={apiEngineDraft.name}
                  onChange={(e) => setApiEngineDraft((p) => ({ ...p, name: e.target.value }))}
                  placeholder="我的模型"
                  className="w-full bg-zinc-900 border border-zinc-700 rounded-md px-2 py-1.5 text-xs text-zinc-200 outline-none focus:border-sky-500/50"
                />
              </div>
              <div className="col-span-2">
                <label className="text-[10px] text-zinc-500">Base URL</label>
                <input
                  value={apiEngineDraft.baseUrl}
                  onChange={(e) => setApiEngineDraft((p) => ({ ...p, baseUrl: e.target.value }))}
                  placeholder="https://.../v1"
                  className="w-full bg-zinc-900 border border-zinc-700 rounded-md px-2 py-1.5 text-xs text-zinc-200 outline-none focus:border-sky-500/50 font-mono"
                />
              </div>
              <div className="col-span-2">
                <label className="text-[10px] text-zinc-500">API Key</label>
                <input
                  type="password"
                  value={apiEngineDraft.apiKey}
                  onChange={(e) => setApiEngineDraft((p) => ({ ...p, apiKey: e.target.value }))}
                  placeholder="可选，稍后也可再填"
                  className="w-full bg-zinc-900 border border-zinc-700 rounded-md px-2 py-1.5 text-xs text-zinc-200 outline-none focus:border-sky-500/50"
                />
              </div>
              <div>
                <label className="text-[10px] text-zinc-500">默认模型</label>
                <input
                  value={apiEngineDraft.model}
                  onChange={(e) => setApiEngineDraft((p) => ({ ...p, model: e.target.value }))}
                  placeholder="model-id"
                  className="w-full bg-zinc-900 border border-zinc-700 rounded-md px-2 py-1.5 text-xs text-zinc-200 outline-none focus:border-sky-500/50 font-mono"
                />
              </div>
              <div>
                <label className="text-[10px] text-zinc-500">可选模型列表（逗号分隔）</label>
                <input
                  value={apiEngineDraft.availableModels}
                  onChange={(e) => setApiEngineDraft((p) => ({ ...p, availableModels: e.target.value }))}
                  placeholder="model-a, model-b"
                  className="w-full bg-zinc-900 border border-zinc-700 rounded-md px-2 py-1.5 text-xs text-zinc-200 outline-none focus:border-sky-500/50 font-mono"
                />
              </div>
            </div>
            <div className="flex items-center justify-end gap-2 pt-1">
              <button
                type="button"
                onClick={() => setShowAddApiEngine(false)}
                className="text-xs px-3 py-1.5 rounded-md text-zinc-400 hover:text-zinc-200"
              >
                取消
              </button>
              <button
                type="button"
                onClick={submitCustomApiEngine}
                className="text-xs px-3 py-1.5 rounded-md bg-sky-600 text-white hover:bg-sky-500 transition-colors"
              >
                保存并启用
              </button>
            </div>
          </div>
        )}

        {Object.entries(config.apiEngines || {}).map(([engineId, engineCfg]) => {
          const testState = apiEngineTest[engineId];
          const endpoints = Array.isArray(engineCfg.availableEndpoints) ? engineCfg.availableEndpoints : [];
          const isCustom = !!engineCfg.custom && !engineCfg.builtin;
          const detailsVisible = engineId === "atlas"
            ? atlasDetailsVisible({ enabled: engineCfg.enabled, locallyExpanded: atlasLocallyExpanded })
            : Boolean(engineCfg.enabled);
          const accent = engineId === "bigmodel"
            ? "from-violet-950/50 border-violet-800/40"
            : engineId === "atlas"
              ? "from-indigo-950/50 border-indigo-700/50"
            : engineId === "volcengine"
              ? "from-orange-950/40 border-orange-800/40"
            : engineId === "minimax"
              ? "from-cyan-950/40 border-cyan-800/40"
            : isCustom
              ? "from-sky-950/30 border-sky-900/40"
              : "from-zinc-950/40 border-zinc-800";
          return (
            <div key={engineId} className={`rounded-xl border bg-gradient-to-br ${accent} to-zinc-950/80 p-3.5 space-y-2.5`}>
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2 min-w-0">
                  <input
                    type="checkbox"
                    checked={engineCfg.enabled || false}
                    aria-expanded={detailsVisible}
                    onChange={(e) => toggleApiEngine(engineId, e.target.checked)}
                    className="rounded border-zinc-600"
                  />
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-sm text-zinc-200 font-medium">{engineCfg.name || engineId}</span>
                      <span className="text-[10px] font-mono text-zinc-600">{engineId}</span>
                      {engineId === "bigmodel" && (
                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-violet-500/15 text-violet-300">智谱</span>
                      )}
                      {engineId === "volcengine" && (
                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-orange-500/15 text-orange-300">方舟</span>
                      )}
                      {engineId === "atlas" && (
                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-indigo-500/15 text-indigo-300">Coding Plan</span>
                      )}
                      {engineId === "minimax" && (
                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-cyan-500/15 text-cyan-300">MiniMax</span>
                      )}
                      {isCustom && (
                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-sky-500/15 text-sky-300">自定义</span>
                      )}
                    </div>
                  </div>
                </div>
                <div className="flex items-center gap-1.5 shrink-0">
                  {engineCfg.enabled && engineCfg.apiKey && (
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-500/15 text-emerald-400">就绪</span>
                  )}
                  {engineCfg.docsUrl && (
                    <a
                      href={engineCfg.docsUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="text-[10px] text-zinc-500 hover:text-sky-300"
                    >
                      文档
                    </a>
                  )}
                  {isCustom && (
                    <button
                      type="button"
                      onClick={() => removeCustomApiEngine(engineId)}
                      className="text-[10px] text-rose-400/80 hover:text-rose-300 px-1.5"
                    >
                      删除
                    </button>
                  )}
                </div>
              </div>
              {detailsVisible && (
                <div className={`grid gap-2 ml-1 sm:grid-cols-2 sm:ml-5 ${engineId === "atlas" ? "grid-cols-1" : "grid-cols-2"}`}>
                  <div className={engineId === "atlas" ? "sm:col-span-2" : "col-span-2"}>
                    <label className="text-[10px] text-zinc-500">API Key</label>
                    <input
                      type="password"
                      disabled={engineId === "atlas" && !isAdmin}
                      value={engineCfg.apiKey || ""}
                      onFocus={(e) => { if (String(engineCfg.apiKey || "").includes("****")) e.target.select(); }}
                      onChange={(e) => patchApiEngine(engineId, { apiKey: e.target.value })}
                      placeholder={
                        engineId === "bigmodel"
                          ? "在 open.bigmodel.cn 创建 API Key"
                          : engineId === "atlas"
                            ? "Atlas 套餐管理 → 获取 Coding Plan API Key"
                          : engineId === "volcengine"
                            ? "方舟控制台 → Agent Plan 专用 API Key"
                          : engineId === "minimax"
                            ? "在 platform.minimaxi.com 创建 API Key"
                            : "sk-..."
                      }
                      className="w-full bg-zinc-900/80 border border-zinc-700 rounded-md px-2 py-1.5 text-xs text-zinc-300 outline-none focus:border-zinc-500"
                    />
                  </div>
                  {endpoints.length > 0 && (
                    <div className="col-span-2">
                      <label className="text-[10px] text-zinc-500">接入端点</label>
                      <div className="flex flex-wrap gap-1.5 mt-1">
                        {endpoints.map((ep) => {
                          const url = typeof ep === "string" ? ep : ep.url;
                          const label = typeof ep === "string" ? ep : (ep.label || ep.url);
                          const active = String(engineCfg.baseUrl || "").replace(/\/+$/, "") === String(url || "").replace(/\/+$/, "");
                          return (
                            <button
                              key={url}
                              type="button"
                              onClick={() => patchApiEngine(engineId, { baseUrl: url })}
                              className={`text-[10px] px-2 py-1 rounded-md border transition-colors ${
                                active
                                  ? "border-violet-400/50 bg-violet-500/20 text-violet-200"
                                  : "border-zinc-700 text-zinc-400 hover:border-zinc-500"
                              }`}
                            >
                              {label}
                            </button>
                          );
                        })}
                      </div>
                      {engineId === "bigmodel" && (
                        <p className="text-[10px] text-zinc-600 mt-1">
                          通用开放平台用「开放平台」；GLM Coding Plan 套餐 Key 请选 Coding Plan 端点。
                        </p>
                      )}
                      {engineId === "volcengine" && (
                        <p className="text-[10px] text-zinc-600 mt-1">
                          已购 Agent Plan 请选「Agent Plan」端点。下方「模型」为全局默认：切换后自动同步到 Claude（终端 + 故事点「Claude（火山方舟）」全局默认；故事点仍可单独覆盖）。「一键配置 Claude」还会安装 arkcli（文档里的 arkcli helper）。「一键写入 OpenCode」设 OpenAI 兼容默认模型。
                        </p>
                      )}
                    </div>
                  )}
                  {engineId === "minimax" && (
                    <div className="col-span-2">
                      <p className="text-[10px] text-zinc-600 leading-relaxed">
                        Anthropic / OpenAI 兼容端点，可直接接入 Claude Code 与 Codex CLI。点「一键配置 Claude」后终端 <code className="text-zinc-400">claude</code> 走 MiniMax；点「一键配置 Codex」后终端 <code className="text-zinc-400">codex</code> 走 MiniMax（与火山方舟互斥切换：配置谁，终端默认就走谁）。
                      </p>
                    </div>
                  )}
                  {engineId === "atlas" && (
                    <div className="rounded-lg border border-indigo-800/40 bg-indigo-950/20 px-2 py-2 sm:col-span-2 sm:px-3 sm:py-2.5">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-xs font-medium text-indigo-200">Atlas Cloud Coding Plan</span>
                        <span className="rounded-full border border-emerald-700/40 bg-emerald-950/40 px-2 py-0.5 text-[10px] text-emerald-300">云服务 · 无需安装</span>
                      </div>
                      <p className="mt-1 hidden text-[10px] leading-relaxed text-zinc-500 sm:block">
                        故事点直接使用 OpenAI 兼容接口；一键设置 Claude Code 时会自动改用 Atlas 的 Anthropic 地址。官方 Base URL 已锁定，避免误把 Coding Plan Key 发送到其它站点。
                      </p>
                      {!isAdmin && !engineCfg.enabled && (
                        <p role="status" className="mt-1 text-[10px] leading-relaxed text-amber-300">
                          配置面板已展开；请先完成管理员登录，再启用并保存 Atlas。
                        </p>
                      )}
                    </div>
                  )}
                  <div>
                    <label className="text-[10px] text-zinc-500">Base URL</label>
                    <input
                      value={engineCfg.baseUrl || ""}
                      readOnly={engineId === "atlas"}
                      onChange={(e) => patchApiEngine(engineId, { baseUrl: e.target.value })}
                      className="w-full bg-zinc-900/80 border border-zinc-700 rounded-md px-2 py-1.5 text-xs text-zinc-300 outline-none focus:border-zinc-500 font-mono read-only:cursor-not-allowed read-only:text-zinc-500"
                    />
                  </div>
                  <div>
                    <label className="text-[10px] text-zinc-500">模型</label>
                    {(engineCfg.availableModels && engineCfg.availableModels.length > 0) ? (
                      <>
                        <select
                          disabled={engineId === "atlas" && !isAdmin}
                          value={customModel[engineId] ? "__custom__" : (engineCfg.model || "")}
                          onChange={(e) => {
                            const v = e.target.value;
                            if (v === "__custom__") {
                              setCustomModel((p) => ({ ...p, [engineId]: true }));
                            } else {
                              setCustomModel((p) => ({ ...p, [engineId]: false }));
                              patchApiEngine(engineId, { model: v });
                            }
                          }}
                          className="w-full bg-zinc-900/80 border border-zinc-700 rounded-md px-2 py-1.5 text-xs text-zinc-300 outline-none focus:border-zinc-500"
                        >
                          {engineCfg.availableModels.map((m) => (
                            <option key={m} value={m}>{m}</option>
                          ))}
                          <option value="__custom__">自定义...</option>
                        </select>
                        {customModel[engineId] && (
                          <input
                            disabled={engineId === "atlas" && !isAdmin}
                            value={engineCfg.model || ""}
                            onChange={(e) => patchApiEngine(engineId, { model: e.target.value })}
                            onBlur={() => { if (!engineCfg.model) setCustomModel((p) => ({ ...p, [engineId]: false })); }}
                            placeholder="输入模型名..."
                            className="w-full bg-zinc-900/80 border border-zinc-700 rounded-md px-2 py-1.5 text-xs text-zinc-300 outline-none mt-1 font-mono"
                          />
                        )}
                      </>
                    ) : (
                      <input
                        disabled={engineId === "atlas" && !isAdmin}
                        value={engineCfg.model || ""}
                        onChange={(e) => patchApiEngine(engineId, { model: e.target.value })}
                        className="w-full bg-zinc-900/80 border border-zinc-700 rounded-md px-2 py-1.5 text-xs text-zinc-300 outline-none font-mono"
                      />
                    )}
                  </div>
                  {engineId === "atlas" && (
                    <AtlasClientSetupPanel
                      engineConfig={engineCfg}
                      isAdmin={isAdmin}
                      adminLoading={adminLoading}
                      actionState={atlasToolSync}
                      onApply={applyAtlasToClient}
                    />
                  )}
                  {engineId === "deepseek" && (
                    <>
                      <div className="col-span-2 flex items-center justify-between border-t border-zinc-800 pt-2">
                        <label className="flex items-center gap-2 text-xs text-zinc-400">
                          <input
                            type="checkbox"
                            checked={engineCfg.thinkingEnabled !== false}
                            onChange={(e) => patchApiEngine(engineId, { thinkingEnabled: e.target.checked })}
                            className="rounded border-zinc-600"
                          />
                          DeepSeek V4 思考模式
                        </label>
                        {engineCfg.thinkingEnabled !== false && (
                          <select
                            value={engineCfg.reasoningEffort || "high"}
                            onChange={(e) => patchApiEngine(engineId, { reasoningEffort: e.target.value })}
                            className="bg-zinc-900 border border-zinc-700 rounded px-2 py-1 text-xs text-zinc-300 outline-none"
                          >
                            <option value="high">High</option>
                            <option value="max">Max</option>
                          </select>
                        )}
                      </div>
                      {/^deepseek-(?:chat|reasoner)$/i.test(engineCfg.model || "") && (
                        <p className="col-span-2 text-[10px] text-amber-500/80">旧模型名即将停用，建议改为 deepseek-v4-pro 或 deepseek-v4-flash。</p>
                      )}
                    </>
                  )}
                  {(engineId === "bigmodel" || engineId === "volcengine" || isCustom) && (
                    <div className="col-span-2 flex items-center gap-2 border-t border-zinc-800 pt-2">
                      <label className="flex items-center gap-2 text-xs text-zinc-400">
                        <input
                          type="checkbox"
                          checked={engineCfg.thinkingEnabled === true}
                          onChange={(e) => patchApiEngine(engineId, { thinkingEnabled: e.target.checked })}
                          className="rounded border-zinc-600"
                        />
                        思考模式（thinking）
                      </label>
                      <span className="text-[10px] text-zinc-600">
                        {engineId === "volcengine" ? "部分方舟模型支持" : "部分 GLM / 兼容端点支持"}
                      </span>
                    </div>
                  )}
                  {engineId === "volcengine" && (
                    <div className="col-span-2 space-y-1.5 border-t border-zinc-800 pt-2">
                      <label className="flex items-center gap-2 text-xs text-zinc-400">
                        <input
                          type="checkbox"
                          checked={engineCfg.claudeExtendedContext !== false}
                          onChange={(e) => patchApiEngine(engineId, { claudeExtendedContext: e.target.checked })}
                          className="rounded border-zinc-600"
                        />
                        Claude 扩展上下文（1M）
                      </label>
                      <p className="text-[10px] text-zinc-600 leading-relaxed">
                        开启后：glm-5.2 / deepseek-v4-flash / deepseek-v4-pro 自动使用 <code className="text-zinc-400">[1m]</code> 模型名，并设置
                        {" "}CLAUDE_CODE_AUTO_COMPACT_WINDOW=1000000，适合大型代码库长会话。请再点「一键配置 Claude」使终端配置生效。
                      </p>
                    </div>
                  )}
                  <div className={`min-w-0 flex items-center gap-2 pt-1 flex-wrap ${engineId === "atlas" ? "sm:col-span-2" : "col-span-2"}`}>
                    <button
                      type="button"
                      disabled={!!testState?.loading || !engineCfg.apiKey || !engineCfg.baseUrl || !engineCfg.model}
                      onClick={() => testApiEngine(engineId, engineCfg)}
                      className={`text-[11px] px-2.5 py-1 rounded-md border border-zinc-700 text-zinc-300 hover:border-emerald-500/40 hover:text-emerald-300 disabled:opacity-40 disabled:cursor-not-allowed transition-colors ${engineId === "atlas" ? "w-full sm:w-auto" : ""}`}
                    >
                      {testState?.loading ? "探测中…" : "测试连接"}
                    </button>
                    {engineId === "volcengine" && (
                      <>
                        <button
                          type="button"
                          disabled={!!claudeArkSync.loading || !engineCfg.apiKey || !engineCfg.baseUrl || !engineCfg.model}
                          onClick={() => applyVolcengineToClaude(engineCfg)}
                          className="text-[11px] px-2.5 py-1 rounded-md bg-gradient-to-r from-sky-600 to-cyan-600 text-white hover:from-sky-500 hover:to-cyan-500 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                        >
                          {claudeArkSync.loading ? "配置中…" : "一键配置 Claude"}
                        </button>
                        <button
                          type="button"
                          disabled={!!arkcliSync.loading}
                          onClick={() => installArkCli()}
                          className="text-[11px] px-2.5 py-1 rounded-md border border-sky-800/60 text-sky-300/90 hover:border-sky-500/50 hover:text-sky-200 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                          title="安装 @volcengine/ark-cli，修复「arkcli helper 找不到命令」"
                        >
                          {arkcliSync.loading ? "安装中…" : "安装 Ark CLI"}
                        </button>
                        <button
                          type="button"
                          disabled={!!opencodeSync.loading || !engineCfg.apiKey || !engineCfg.baseUrl || !engineCfg.model}
                          onClick={() => applyVolcengineToOpenCode(engineCfg)}
                          className="text-[11px] px-2.5 py-1 rounded-md bg-gradient-to-r from-orange-600 to-amber-600 text-white hover:from-orange-500 hover:to-amber-500 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                        >
                          {opencodeSync.loading ? "写入中…" : "一键写入 OpenCode"}
                        </button>
                        <button
                          type="button"
                          onClick={() => copyVolcengineOpenCodeConfig(engineCfg)}
                          className="text-[11px] px-2.5 py-1 rounded-md border border-orange-800/50 text-orange-300/90 hover:border-orange-500/50 hover:text-orange-200 transition-colors"
                        >
                          复制配置
                        </button>
                      </>
                    )}
                    {engineId === "minimax" && (
                      <button
                        type="button"
                        disabled={!!claudeMinimaxSync.loading || !engineCfg.apiKey || !engineCfg.baseUrl || !engineCfg.model}
                        onClick={() => applyMinimaxToClaude(engineCfg)}
                        className="text-[11px] px-2.5 py-1 rounded-md bg-gradient-to-r from-cyan-600 to-blue-600 text-white hover:from-cyan-500 hover:to-blue-500 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                      >
                        {claudeMinimaxSync.loading ? "配置中…" : "一键配置 Claude"}
                      </button>
                    )}
                    {engineId === "minimax" && (
                      <button
                        type="button"
                        disabled={!!codexMinimaxSync.loading || !engineCfg.apiKey || !engineCfg.baseUrl || !engineCfg.model}
                        onClick={() => applyMinimaxToCodex(engineCfg)}
                        className="text-[11px] px-2.5 py-1 rounded-md bg-gradient-to-r from-emerald-600 to-teal-600 text-white hover:from-emerald-500 hover:to-teal-500 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                      >
                        {codexMinimaxSync.loading ? "配置中…" : "一键配置 Codex"}
                      </button>
                    )}
                    {engineId === "volcengine" && claudeArkSync.text && (
                      <span className={`text-[11px] truncate ${claudeArkSync.ok ? "text-emerald-400" : "text-rose-400"}`} title={claudeArkSync.text}>
                        {claudeArkSync.text}
                      </span>
                    )}
                    {engineId === "minimax" && claudeMinimaxSync.text && (
                      <span className={`text-[11px] truncate ${claudeMinimaxSync.ok ? "text-emerald-400" : "text-rose-400"}`} title={claudeMinimaxSync.text}>
                        {claudeMinimaxSync.text}
                      </span>
                    )}
                    {engineId === "minimax" && codexMinimaxSync.text && (
                      <span className={`text-[11px] truncate ${codexMinimaxSync.ok ? "text-emerald-400" : "text-rose-400"}`} title={codexMinimaxSync.text}>
                        {codexMinimaxSync.text}
                      </span>
                    )}
                    {engineId === "volcengine" && arkcliSync.text && (
                      <span className={`text-[11px] truncate ${arkcliSync.ok ? "text-emerald-400" : "text-rose-400"}`} title={arkcliSync.text}>
                        {arkcliSync.text}
                      </span>
                    )}
                    {engineId === "volcengine" && opencodeSync.text && (
                      <span className={`text-[11px] truncate ${opencodeSync.ok ? "text-emerald-400" : "text-rose-400"}`}>
                        {opencodeSync.text}
                      </span>
                    )}
                    {testState?.text && (
                      <span className={`text-[11px] truncate ${testState.ok ? "text-emerald-400" : "text-rose-400"}`}>
                        {testState.text}
                      </span>
                    )}
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </Section>

      {/* 工作报告 */}
      <Section title="工作报告" defer onVisible={() => {
        reloadReportRepositories();
        reloadTbProjectSelection();
      }}>
        <p className="text-xs text-zinc-600 -mt-2">配置数据源，支持通过 <code className="text-zinc-400">/work-report</code> 生成周报/季报/年报。</p>

        {/* Git 仓库列表：仓库定义是唯一来源，本页只展示本机可采集状态。 */}
        <div>
          <div className="flex items-center justify-between mb-2">
            <label className="block text-xs text-zinc-500">Git 仓库（用于采集提交记录）</label>
            <button onClick={reloadReportRepositories} disabled={reportRepositoriesLoading}
              className="text-[11px] text-blue-400 hover:text-blue-300 disabled:opacity-50">
              {reportRepositoriesLoading ? "刷新中…" : "刷新"}
            </button>
          </div>
          <p className="text-[10px] text-zinc-600 mb-2">
            自动使用「工程开发 → 工程配置 → 仓库定义」中的列表；本机已登记且 Git 远程匹配的源码会参与采集。同一远程的多个逻辑定义或本地副本会合并去重。
          </p>
          {reportRepositoriesError ? (
            <div className="text-xs text-red-400">{reportRepositoriesError}</div>
          ) : reportRepositories.length ? (
            <div className="space-y-2">
              {reportRepositories.map((repo) => (
                <div key={(repo.definitionIds || [repo.id]).join("|")} className="rounded border border-zinc-800 bg-zinc-900/40 px-3 py-2">
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-xs text-zinc-300">{repo.name}</span>
                    <span className={`text-[10px] ${repo.hasLocal ? "text-emerald-400" : "text-amber-400"}`}>
                      {repo.hasLocal ? `${repo.paths.length} 个本机源码` : "本机暂无匹配源码"}
                    </span>
                  </div>
                  {repo.remote && <div className="mt-1 text-[10px] text-zinc-600 font-mono break-all">{repo.remote}</div>}
                  {(repo.paths || []).length > 0 && (
                    <details className="mt-1.5 text-[10px] text-zinc-500">
                      <summary className="cursor-pointer hover:text-zinc-400">查看匹配的本机源码路径</summary>
                      <div className="mt-1 max-h-36 overflow-y-auto space-y-1 pl-2 border-l border-zinc-800">
                        {repo.paths.map((source) => (
                          <div key={source.path} className="font-mono break-all">{source.path}</div>
                        ))}
                      </div>
                    </details>
                  )}
                </div>
              ))}
            </div>
          ) : (
            <div className="text-xs text-zinc-600">{reportRepositoriesLoading ? "正在读取仓库定义…" : "暂无仓库定义，请先到工程配置中维护。"}</div>
          )}
        </div>

        {/* 报告输出目录 */}
        <div>
          <label className="block text-xs text-zinc-500 mb-1">报告输出目录</label>
          <input
            type="text"
            value={config.reportOutputDir || ""}
            onChange={(e) => update("reportOutputDir", e.target.value)}
            placeholder="留空则使用 ~/ai-reports"
            className="w-full bg-zinc-800 border border-zinc-700 rounded px-3 py-2 text-sm text-zinc-300 placeholder-zinc-600 outline-none focus:border-zinc-500 font-mono"
          />
        </div>

        {/* Teambition 配置 */}
        <div>
          <label className="block text-xs text-zinc-500 mb-2">Teambition（采集任务数据）</label>
          <div className="grid grid-cols-2 gap-2">
            <Input label="App ID" value={(config.teambition || {}).appId || ""} onChange={(v) => update("teambition", { ...(config.teambition || {}), appId: v })} />
            <Input label="App Secret" type="password" value={(config.teambition || {}).appSecret || ""} onChange={(v) => update("teambition", { ...(config.teambition || {}), appSecret: v })} />
            <Input label="Org ID" value={(config.teambition || {}).orgId || ""} onChange={(v) => update("teambition", { ...(config.teambition || {}), orgId: v })} />
            <Input label="Operator ID" value={(config.teambition || {}).operatorId || ""} onChange={(v) => update("teambition", { ...(config.teambition || {}), operatorId: v })} />
          </div>
          <div className="mt-3">
            <TbCookieCheck
              canManage={isAdmin}
              cookieConfigured={Boolean((config.teambition || {}).userCookieConfigured || (config.teambition || {}).userCookie)}
              onRequireAdmin={() => setAdminLoginOpen(true)}
              onLoginSuccess={() => { reloadConfig(); reloadTbProjectSelection(); }}
            />
          </div>
          {/* TB 项目列表（多项目通用化）*/}
          <TbProjectList
            value={tbProjectSelection}
            onChange={saveTbProjectSelection}
          />
        </div>
      </Section>

      <DeferredSettingsPanel>
        <CodeupSettingsPanel
          config={config}
          onConfigUpdated={(next) => setConfig((prev) => ({ ...prev, ...(next || {}) }))}
          onMessage={(text) => {
            setMsg(text);
            setTimeout(() => setMsg(null), 2200);
          }}
        />
      </DeferredSettingsPanel>

      {/* 钉钉 */}
      <Section title="钉钉配置">
        <div className="grid grid-cols-2 gap-3">
          <Input label="App Key" value={config.dingtalkAppKey} onChange={(v) => update("dingtalkAppKey", v)} />
          <Input label="App Secret" type="password" value={config.dingtalkAppSecret} onChange={(v) => update("dingtalkAppSecret", v)} />
        </div>
        <Input label="机器人 Webhook" value={config.dingtalkRobotWebhook} onChange={(v) => update("dingtalkRobotWebhook", v)} />
        <div className="grid grid-cols-2 gap-3">
          <Input label="回调 Token" value={config.dingtalkRobotToken} onChange={(v) => update("dingtalkRobotToken", v)} />
          <Input label="回调 Secret" type="password" value={config.dingtalkRobotSecret} onChange={(v) => update("dingtalkRobotSecret", v)} />
        </div>
      </Section>

      {/* 管理后台 RBAC */}
      <Section title="管理后台">
        <div className="text-[11px] text-zinc-400 bg-zinc-800/50 rounded-lg p-3 leading-relaxed mb-2">
          <p className="text-zinc-300 mb-1">超级管理员登录已改为 <b>Google Authenticator 动态验证码（TOTP）</b>。</p>
          <p>到「<b>管理后台</b>」页登录框点「查看验证器绑定信息」，可用 Authenticator 扫码（或手动输入现有密钥）绑定，之后用 App 的 6 位码登录。</p>
          <p className="mt-1">密钥保存在本机文件 <span className="font-mono text-zinc-500">gateway/.secrets/admin-totp.json</span>（不进 git）；查看绑定信息不会更换 key，只有超级管理员明确点击“重新生成密钥”才会使旧验证码失效。</p>
        </div>
        <Input label="钉钉扫码登录回调地址（可选）" value={(config.adminAuth || {}).dingRedirectUri || ""} onChange={(v) => update("adminAuth", { ...(config.adminAuth || {}), dingRedirectUri: v })} placeholder="仅用钉钉扫码时需要；须与钉钉后台白名单一致" />
      </Section>

      {/* TB 任务监控 */}
      <Section title="TB 任务监控">
        <ToggleRow label="启用自动监控" sub="每天 9:00 / 18:00 自动扫描 Teambition 分配给我的新任务" value={(config.tbTaskWatcher || {}).enabled || false} onChange={(v) => update("tbTaskWatcher", { ...(config.tbTaskWatcher || {}), enabled: v })} />
        <ToggleRow label="自动发送评论" sub="分析完成后自动在 TB 任务中发表 AI 分析结论" value={(config.tbTaskWatcher || {}).autoComment !== false} onChange={(v) => update("tbTaskWatcher", { ...(config.tbTaskWatcher || {}), autoComment: v })} />
        <Input label="我的用户 ID (Operator ID)" value={(config.tbTaskWatcher || {}).executorId || ""} onChange={(v) => update("tbTaskWatcher", { ...(config.tbTaskWatcher || {}), executorId: v })} placeholder="从 Teambition 设置中获取" />
        <Input label="附件保存目录" value={(config.tbTaskWatcher || {}).localDir || ""} onChange={(v) => update("tbTaskWatcher", { ...(config.tbTaskWatcher || {}), localDir: v })} placeholder="留空则使用 工作目录/tb-tasks/" />
      </Section>

      {/* 飞书集成 */}
      <Section title="飞书集成">
        <ToggleRow label="启用飞书机器人" sub="通过飞书长连接双向通信，在飞书中直接与 AI 对话" value={(config.feishu || {}).enabled || false} onChange={(v) => update("feishu", { ...(config.feishu || {}), enabled: v })} />
        <div className="grid grid-cols-2 gap-3">
          <Input label="App ID" value={(config.feishu || {}).appId || ""} onChange={(v) => update("feishu", { ...(config.feishu || {}), appId: v })} placeholder="cli_xxxxx" />
          <Input label="App Secret" type="password" value={(config.feishu || {}).appSecret || ""} onChange={(v) => update("feishu", { ...(config.feishu || {}), appSecret: v })} />
        </div>
        <div className="bg-zinc-800/50 rounded-lg p-3">
          <p className="text-[10px] text-zinc-500 mb-1.5">配置步骤</p>
          <ol className="text-xs text-zinc-400 space-y-1 list-decimal pl-4">
            <li>登录 <a href="https://open.feishu.cn/" target="_blank" className="text-blue-400 hover:underline">飞书开放平台</a> 创建企业自建应用</li>
            <li>添加「机器人」应用能力</li>
            <li>权限管理申请 <code className="text-zinc-300 bg-zinc-700 px-1 rounded">im:message</code> 和 <code className="text-zinc-300 bg-zinc-700 px-1 rounded">im:message:send_as_bot</code></li>
            <li>事件与回调 → 选择「使用长连接接收事件」→ 添加 <code className="text-zinc-300 bg-zinc-700 px-1 rounded">im.message.receive_v1</code></li>
            <li>发布应用版本，填入 App ID 和 Secret，启用开关</li>
            <li>重启网关生效，之后可在飞书中与机器人对话</li>
          </ol>
          <p className="text-[10px] text-zinc-600 mt-2">无需公网 IP / 域名 / 内网穿透，网关通过 WebSocket 长连接主动连接飞书云端。</p>
        </div>
      </Section>

      {/* 引擎引导弹窗 */}
      {guideModal && (
        <EngineGuideModal
          engine={guideModal.engine}
          status={guideModal.status}
          data={guideModal.data}
          installOutput={installOutput}
          installing={installing}
          onInstall={() => startInstall(guideModal.engine)}
          onRecheck={() => { setGuideModal(null); checkEngine(guideModal.engine); }}
          onClose={() => setGuideModal(null)}
        />
      )}
    </div>
  );
}

function AdminInlineLogin({ onLoggedIn, onCancel }) {
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  async function loginTotp() {
    if (busy || code.length !== 6) return;
    setBusy(true); setErr("");
    const r = await loginAdmin({ method: "totp", code: code.replace(/\s+/g, "") });
    setBusy(false);
    if (r.ok && r.principal) onLoggedIn?.(r.principal);
    else setErr(r.error || "管理员登录失败");
  }

  return (
    <div className="rounded-lg border border-blue-700/40 bg-blue-950/10 px-3 py-2.5 space-y-2">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[11px] text-zinc-300">管理员动态验证码</span>
        <button onClick={onCancel} className="text-[11px] text-zinc-500 hover:text-zinc-200">收起</button>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <input
          value={code}
          onChange={(e) => setCode(e.target.value.replace(/[^\d]/g, "").slice(0, 6))}
          onKeyDown={(e) => e.key === "Enter" && loginTotp()}
          inputMode="numeric"
          placeholder="6 位验证码"
          className="w-32 bg-zinc-900 border border-zinc-700 rounded px-2 py-1.5 text-sm text-zinc-100 text-center tracking-[0.25em] outline-none focus:border-blue-500"
        />
        <button onClick={loginTotp} disabled={busy || code.length !== 6} className="px-3 py-1.5 text-xs rounded bg-blue-600 hover:bg-blue-500 disabled:bg-zinc-700 disabled:text-zinc-500 text-white transition">
          {busy ? "登录中..." : "登录"}
        </button>
        <Link to="/admin" className="text-[11px] text-zinc-500 hover:text-blue-300">首次绑定/管理名单</Link>
      </div>
      {err && <div className="text-[11px] text-red-300">{err}</div>}
    </div>
  );
}

function EngineGuideModal({ engine, status, data, installOutput, installing, onInstall, onRecheck, onClose }) {
  const engineName = { claude: "Claude Code", codex: "OpenAI Codex", gemini: "Gemini CLI", hermes: "Hermes Agent" }[engine] || engine;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={onClose}>
      <div className="bg-zinc-900 border border-zinc-700 rounded-xl w-[480px] max-h-[80vh] overflow-y-auto shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="px-5 py-4 border-b border-zinc-800">
          <h3 className="text-sm font-semibold text-zinc-200">
            {status === "not_installed" ? `安装 ${engineName}` : `${engineName} 需要登录`}
          </h3>
        </div>

        <div className="px-5 py-4 space-y-4">
          {status === "not_installed" && (
            <>
              <p className="text-xs text-zinc-400">该引擎尚未安装，请通过以下命令安装：</p>
              <CopyBlock text={data.installGuide?.command || ""} />
              {data.installGuide?.url && (
                <p className="text-xs text-zinc-500">
                  官方文档：<a href={data.installGuide.url} target="_blank" rel="noreferrer" className="text-blue-400 hover:underline">{data.installGuide.url}</a>
                </p>
              )}
              {!data.installGuide?.manualOnly && (
                <button
                  onClick={onInstall}
                  disabled={installing}
                  className="w-full py-2 text-xs rounded-lg bg-blue-600 hover:bg-blue-500 disabled:bg-zinc-700 text-white transition"
                >
                  {installing ? "安装中..." : "自动安装"}
                </button>
              )}
              {installOutput && (
                <pre className="bg-zinc-950 border border-zinc-800 rounded-lg p-3 text-xs text-zinc-400 max-h-40 overflow-y-auto whitespace-pre-wrap font-mono">
                  {installOutput}
                </pre>
              )}
            </>
          )}

          {status === "need_login" && (
            <>
              <p className="text-xs text-zinc-400">引擎已安装但需要登录认证，请按以下步骤操作：</p>
              <ol className="space-y-2">
                {(data.loginGuide?.steps || []).map((step, i) => (
                  <li key={i} className="flex items-start gap-2">
                    <span className="w-5 h-5 rounded-full bg-zinc-800 text-zinc-400 text-xs flex items-center justify-center shrink-0 mt-0.5">{i + 1}</span>
                    <span className="text-xs text-zinc-300">{step}</span>
                  </li>
                ))}
              </ol>
              {data.loginGuide?.command && <CopyBlock text={data.loginGuide.command} />}
            </>
          )}

          {status === "error" && (
            <p className="text-xs text-red-400">{data.error}</p>
          )}
        </div>

        <div className="px-5 py-3 border-t border-zinc-800 flex justify-end space-x-2">
          <button onClick={onRecheck} className="px-4 py-1.5 text-xs rounded bg-zinc-700 hover:bg-zinc-600 text-zinc-300 transition">
            重新检测
          </button>
          <button onClick={onClose} className="px-4 py-1.5 text-xs rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-400 transition">
            关闭
          </button>
        </div>
      </div>
    </div>
  );
}

function CopyBlock({ text }) {
  const [copied, setCopied] = useState(false);

  function copy() {
    copyToClipboard(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  return (
    <div className="flex items-center bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2">
      <code className="flex-1 text-xs text-green-400 font-mono">{text}</code>
      <button onClick={copy} className="text-xs text-zinc-500 hover:text-zinc-300 ml-2 shrink-0">
        {copied ? "已复制" : "复制"}
      </button>
    </div>
  );
}

// 选服务端（局域网发现 + 算力 + 满载禁选）
function ServerSelect({ config, onSelected }) {
  const [servers, setServers] = React.useState([]);
  const [trustedPeers, setTrustedPeers] = React.useState([]);
  const [peer, setPeer] = React.useState("");
  const [msg, setMsg] = React.useState("");
  const selectedHost = (config.claudeProxyClient || {}).host || "";
  const norm = (h) => String(h || "").replace(/\/+$/, "");
  async function load() {
    try {
      const [r, peersResult] = await Promise.all([
        fetch(getApiUrl("/api/discovery/servers")).then((x) => x.json()),
        authenticatedFetch(getApiUrl("/api/discovery/peers"))
          .then((x) => x.json())
          .catch(() => ({ ok: false })),
      ]);
      if (r.ok) setServers(r.data || []);
      if (peersResult.ok) setTrustedPeers(peersResult.data || []);
    } catch {}
  }
  React.useEffect(() => {
    let disposed = false;
    let ws = null;
    let reconnectTimer = null;
    let openedOnce = false;
    const onDiscoveryMessage = (event) => {
      try {
        const message = JSON.parse(event.data);
        if (message.type === "discovery_servers_changed") setServers(message.data?.servers || []);
      } catch {}
    };
    const connectObserver = () => {
      if (disposed) return;
      try {
        ws = createGatewayWebSocket();
        ws.onopen = () => {
          // 重连说明网关/网络刚恢复；首次连接已有初始 load，无需重复请求。
          if (openedOnce) load();
          openedOnce = true;
        };
        ws.onmessage = onDiscoveryMessage;
        ws.onclose = () => { if (!disposed) reconnectTimer = setTimeout(connectObserver, 2000); };
        ws.onerror = () => { try { ws.close(); } catch {} };
      } catch {
        if (!disposed) reconnectTimer = setTimeout(connectObserver, 2000);
      }
    };
    const refreshWhenVisible = () => { if (document.visibilityState === "visible") load(); };

    load();
    connectObserver();
    const t = setInterval(load, 60_000); // WS 观察为主，每分钟仅作丢事件兜底
    window.addEventListener("focus", load);
    window.addEventListener("online", load);
    document.addEventListener("visibilitychange", refreshWhenVisible);
    return () => {
      disposed = true;
      clearInterval(t);
      clearTimeout(reconnectTimer);
      window.removeEventListener("focus", load);
      window.removeEventListener("online", load);
      document.removeEventListener("visibilitychange", refreshWhenVisible);
      try { ws?.close(); } catch {}
    };
  }, []);
  async function pick(s) {
    if (s.full) { setMsg(`「${s.name}」算力已满，不能连`); return; }
    if (s.via !== "self" && !trustedPeers.some((host) => norm(host) === norm(s.host))) {
      setMsg("UDP 发现结果仅供展示；请先由管理员将该 origin 加入可信 peers");
      return;
    }
    setMsg("");
    const r = await authenticatedFetch(getApiUrl("/api/discovery/select"), {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ host: s.host }),
    }).then((x) => x.json());
    if (r.ok) { setMsg(`已连接「${s.name}」`); onSelected?.(); } else setMsg(r.error || "选择失败");
  }
  async function trustPeer(host) {
    const h = String(host || "").trim();
    if (!h) return;
    try {
      const response = await authenticatedFetch(getApiUrl("/api/discovery/peers"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ host: h }),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok || !result.ok) throw new Error(result.error || "加入可信 peers 失败");
      setMsg(`已信任 ${result.data || h}；现在可单独点击连接`);
      setPeer("");
      await load();
    } catch (error) {
      setMsg(error.message || "加入可信 peers 失败");
    }
  }
  async function addPeer() {
    await trustPeer(peer);
  }
  return (
    <div className="my-2 p-2.5 rounded-lg bg-zinc-800/40 border border-zinc-700/60">
      <div className="flex items-center gap-2 mb-1.5">
        <span className="text-xs font-medium text-zinc-300">🖥 选择服务端（局域网发现 · 按算力）</span>
        <button onClick={load} className="ml-auto text-[11px] px-2 py-0.5 rounded bg-zinc-800 border border-zinc-700 text-zinc-400 hover:text-zinc-200">↻ 刷新</button>
      </div>
      {!servers.filter((s) => s.claudeEnabled).length && <div className="text-[11px] text-zinc-500 py-1">未发现可连接的 AI 代理服务端（需对方开启"对外提供 AI 文本代理"；同子网自动出现，跨子网手动加 IP）。</div>}
      <div className="space-y-1">
        {servers.filter((s) => s.claudeEnabled).map((s) => {
          const sel = norm(s.host) === norm(selectedHost);
          const trusted = s.via === "self" || trustedPeers.some((host) => norm(host) === norm(s.host));
          return (
            <div key={s.id} className={`flex items-center gap-2 px-2 py-1.5 rounded border text-[12px] ${sel ? "border-blue-600/60 bg-blue-600/10" : "border-zinc-700 bg-zinc-900/40"}`}>
              <span className="text-zinc-200">{s.name}</span>
              <span className="text-[10px] text-zinc-600 font-mono">{s.host.replace(/^https?:\/\//, "")}</span>
              <span className={`text-[10px] px-1.5 py-0.5 rounded ${s.capacity.free <= 0 ? "bg-red-900/30 text-red-300" : "bg-emerald-900/30 text-emerald-300"}`}>
                故事点 空闲 {s.capacity.free}/{s.capacity.maxConcurrent}
              </span>
              <span className={`text-[10px] px-1.5 py-0.5 rounded ${s.capacity.quotaExhausted ? "bg-red-900/30 text-red-300" : "bg-zinc-800 text-zinc-400"}`}
                title={`今日已用 ${s.capacity.tokensUsedToday || 0} tokens`}>
                {s.capacity.tokenBudget > 0 ? `AI 剩余 ${s.capacity.tokensRemaining}` : "用量不限"}
              </span>
              <span className="text-[10px] text-zinc-600">{s.backend === "api" || s.backend === "api-engine" ? "API Key" : s.backend === "codex" ? "Codex订阅" : "Claude订阅"}{s.via === "manual" ? " · 手动" : s.via === "self" ? " · 本机" : ""}</span>
              <div className="ml-auto">
                {sel ? <span className="text-[11px] text-blue-300">✓ 已连接</span>
                  : trusted
                    ? <button onClick={() => pick(s)} disabled={s.full} className="text-[11px] px-2 py-0.5 rounded bg-blue-600 hover:bg-blue-500 disabled:bg-zinc-700 disabled:text-zinc-500 text-white">连接</button>
                    : <button onClick={() => trustPeer(s.host)} className="text-[11px] px-2 py-0.5 rounded bg-amber-700 hover:bg-amber-600 text-white">信任</button>}
              </div>
            </div>
          );
        })}
      </div>
      <div className="flex items-center gap-2 mt-2">
        <input value={peer} onChange={(e) => setPeer(e.target.value)} onKeyDown={(e) => e.key === "Enter" && addPeer()}
          placeholder="跨子网手动加服务端：http://192.168.x.x:3001" className="flex-1 bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-[11px] text-zinc-200 placeholder-zinc-600 outline-none font-mono" />
        <button onClick={addPeer} className="text-[11px] px-2 py-1 rounded bg-zinc-700 hover:bg-zinc-600 text-zinc-100">＋ 添加</button>
      </div>
      {msg && <div className="text-[11px] text-zinc-400 mt-1">{msg}</div>}
    </div>
  );
}

// TB 项目列表编辑（多项目通用化）：从可见项目里勾选要操作的项目
function TbProjectList({ value, onChange }) {
  const [avail, setAvail] = React.useState(null);
  const [loading, setLoading] = React.useState(false);
  const [err, setErr] = React.useState("");
  async function loadAvail() {
    setLoading(true); setErr("");
    try {
      const r = await fetch(
        getApiUrl("/api/devbench/tb-projects/available"),
        { cache: "no-store" },
      ).then((x) => x.json());
      if (r.ok) setAvail(r.data || []); else setErr(r.error || "拉取失败");
    } catch (e) { setErr(e.message); }
    setLoading(false);
  }
  const has = (id) => (value || []).some((p) => p.id === id);
  const toggle = (p) => {
    if (has(p.id)) onChange((value || []).filter((x) => x.id !== p.id));
    else onChange([...(value || []), { id: p.id, name: p.name }]);
  };
  return (
    <div className="mt-4 pt-3 border-t border-zinc-800">
      <div className="flex items-center gap-2 mb-1.5">
        <label className="text-xs font-medium text-zinc-300">📂 当前账号操作的 TB 项目</label>
        <button onClick={loadAvail} disabled={loading} className="ml-auto text-[11px] px-2 py-1 rounded bg-blue-600/20 text-blue-300 border border-blue-700/40 hover:bg-blue-600/30 disabled:opacity-50">{loading ? "拉取中…" : "＋ 拉取可选项目"}</button>
      </div>
      <p className="text-[10px] text-zinc-500 mb-1.5">按当前登录账号保存，不再写入共享配置。留空 = 默认只用"平台组件"。配 ≥2 个后，devbench 顶部可切换项目，应用分类/车型/关键词映射按项目隔离。</p>
      {(value || []).length > 0 && (
        <div className="flex flex-wrap gap-1.5 mb-1.5">
          {value.map((p) => (
            <span key={p.id} className="text-[11px] px-2 py-0.5 rounded bg-blue-600/20 text-blue-300 border border-blue-700/40 flex items-center gap-1">
              {p.name}<button onClick={() => onChange(value.filter((x) => x.id !== p.id))} className="text-blue-400 hover:text-red-300">✕</button>
            </span>
          ))}
        </div>
      )}
      {err && <div className="text-[11px] text-red-400">{err}（需 TB 登录）</div>}
      {avail && (
        <div className="max-h-40 overflow-auto border border-zinc-800 rounded p-1.5 space-y-0.5">
          {avail.map((p) => (
            <label key={p.id} className="flex items-center gap-2 text-[11px] text-zinc-300 px-1 py-0.5 hover:bg-zinc-800/50 rounded cursor-pointer">
              <input type="checkbox" checked={has(p.id)} onChange={() => toggle(p)} className="accent-blue-500" />
              <span className="flex-1 truncate">{p.name}</span>
              <span className="text-[10px] text-zinc-600 font-mono">{p.id.slice(-6)}</span>
            </label>
          ))}
          {!avail.length && <div className="text-[11px] text-zinc-600 px-1">无可选项目</div>}
        </div>
      )}
    </div>
  );
}

function TbCookieCheck({ canManage, cookieConfigured, onRequireAdmin, onLoginSuccess }) {
  const [status, setStatus] = React.useState(null);
  const [checking, setChecking] = React.useState(false);
  const [loginState, setLoginState] = React.useState(null);
  const [manualOpen, setManualOpen] = React.useState(false);
  const [manualCookie, setManualCookie] = React.useState("");
  const [manualSaving, setManualSaving] = React.useState(false);
  const [manualError, setManualError] = React.useState("");
  const successCallbackRef = React.useRef(onLoginSuccess);
  const completedLoginRef = React.useRef("");
  const loginChallengeRef = React.useRef("");
  const initialCheckStartedRef = React.useRef(false);

  React.useEffect(() => { successCallbackRef.current = onLoginSuccess; }, [onLoginSuccess]);

  const check = React.useCallback(async () => {
    setChecking(true);
    try {
      const resp = await fetch(getApiUrl("/api/tb-tasks/cookie-check"), { cache: "no-store" });
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok || data.success === false) throw new Error(data.error || `验证失败（HTTP ${resp.status}）`);
      setStatus(normalizeTbCookieHealth(data.data));
    } catch (error) {
      setStatus(normalizeTbCookieHealth({
        valid: false,
        status: "unavailable",
        code: "TB_UNAVAILABLE",
        reason: error?.message || "暂时无法验证 Cookie",
        hasCookie: cookieConfigured,
        checkedAt: new Date().toISOString(),
      }));
    } finally {
      setChecking(false);
    }
  }, [cookieConfigured]);

  const applyLoginState = React.useCallback((value) => {
    const next = normalizeTbLoginState(value);
    if (next.status === "idle") return;
    setLoginState(next);
    if (next.status !== "success") return;

    setStatus(normalizeTbCookieHealth({
      valid: true,
      status: "valid",
      code: "COOKIE_VALID",
      reason: "Cookie 有效",
      checkedAt: new Date().toISOString(),
      hasCookie: true,
      user: next.user,
      id: next.userId,
    }));
    const fingerprint = `${next.userId}|${next.message}`;
    if (completedLoginRef.current !== fingerprint) {
      completedLoginRef.current = fingerprint;
      successCallbackRef.current?.();
      window.setTimeout(() => { check(); }, 250);
    }
  }, [check]);

  React.useEffect(() => {
    if (initialCheckStartedRef.current) return;
    initialCheckStartedRef.current = true;
    check();
  }, [check]);

  // WebSocket 提供即时反馈；依赖稳定回调，避免父组件重渲染时反复断开连接。
  React.useEffect(() => {
    let ws = null;
    function onMsg(event) {
      try {
        const message = JSON.parse(event.data);
        if (message.type === "tb_login_status") applyLoginState(message.data);
      } catch {}
    }
    try {
      ws = createGatewayWebSocket();
      ws.addEventListener("message", onMsg);
    } catch {}
    return () => {
      ws?.removeEventListener("message", onMsg);
      try { ws?.close(); } catch {}
    };
  }, [applyLoginState]);

  // HTTP 状态轮询是 WebSocket 丢消息、页面切后台或本机弹窗启动较慢时的兜底。
  React.useEffect(() => {
    if (!isTbLoginActive(loginState)) return undefined;
    let stopped = false;
    const poll = async () => {
      try {
        const resp = await fetch(getApiUrl("/api/tb-tasks/login/status"), { cache: "no-store" });
        const data = await resp.json().catch(() => ({}));
        if (!stopped && resp.ok && data.success !== false && data.data?.status !== "idle") {
          applyLoginState(data.data);
        }
      } catch {}
    };
    poll();
    const timer = window.setInterval(poll, 1500);
    return () => { stopped = true; window.clearInterval(timer); };
  }, [applyLoginState, loginState?.status]);

  async function handleLogin() {
    completedLoginRef.current = "";
    loginChallengeRef.current = "";
    setLoginState(normalizeTbLoginState({ status: "launching", message: "正在启动安全登录窗口…", busy: true }));
    try {
      const result = await startTbTasksLogin();
      if (!result.success) {
        setLoginState(normalizeTbLoginState({ status: "failed", message: result.error || "启动登录失败" }));
        return;
      }
      loginChallengeRef.current = result.loginChallenge || "";
      setLoginState(normalizeTbLoginState({
        status: "waiting",
        mode: result.mode,
        busy: true,
        message: result.message || (result.mode === "remote"
          ? "请在新窗口中扫码登录，完成后本页会自动更新"
          : "请在弹出的浏览器中完成登录，完成后本页会自动更新"),
      }));
    } catch (error) {
      setLoginState(normalizeTbLoginState({
        status: "failed",
        message: error?.message || "启动登录失败",
      }));
    }
  }

  async function handleCancel() {
    setLoginState(normalizeTbLoginState({ status: "cancelled", message: "已取消本次登录" }));
    try {
      const loginChallenge = loginChallengeRef.current;
      loginChallengeRef.current = "";
      await fetch(getApiUrl("/api/tb-tasks/login/cancel"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ loginChallenge }),
      });
      // 取消请求等待浏览器关闭期间，轮询可能短暂回写 waiting；响应后再次固定友好终态。
      setLoginState(normalizeTbLoginState({ status: "cancelled", message: "已取消本次登录" }));
    } catch (error) {
      setLoginState(normalizeTbLoginState({ status: "failed", message: error?.message || "取消失败，请关闭登录窗口" }));
    }
  }

  async function saveManualCookie() {
    if (!canManage) {
      onRequireAdmin?.();
      return;
    }
    const value = manualCookie.trim();
    if (!value) {
      setManualError("请粘贴完整 Cookie 后再保存");
      return;
    }
    setManualSaving(true);
    setManualError("");
    try {
      const response = await authenticatedFetch(getApiUrl("/api/tb-tasks/cookie-verify-save"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cookie: value }),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok || result.success === false || !result.data?.valid) {
        throw new Error(result.error || result.data?.reason || "Cookie 验证失败，原值未修改");
      }
      setStatus(normalizeTbCookieHealth(result.data));
      setManualCookie("");
      setManualOpen(false);
      successCallbackRef.current?.();
      await check();
    } catch (error) {
      setManualError(error?.message || "保存失败");
    } finally {
      setManualSaving(false);
    }
  }

  const health = status || normalizeTbCookieHealth({
    valid: false,
    status: cookieConfigured ? "unavailable" : "missing",
    code: cookieConfigured ? "TB_UNAVAILABLE" : "COOKIE_MISSING",
    reason: checking ? "正在验证登录状态…" : "等待检测",
    hasCookie: cookieConfigured,
  });
  const presentation = tbCookiePresentation(health);
  const isLogging = isTbLoginActive(loginState);
  const toneClasses = {
    success: "border-emerald-500/30 bg-emerald-500/10 text-emerald-300",
    danger: "border-rose-500/30 bg-rose-500/10 text-rose-300",
    warning: "border-amber-500/30 bg-amber-500/10 text-amber-300",
    neutral: "border-zinc-700 bg-zinc-800/70 text-zinc-400",
  };
  const loginTone = loginState?.status === "success"
    ? "border-emerald-500/25 bg-emerald-500/10 text-emerald-300"
    : ["failed", "timeout"].includes(loginState?.status)
      ? "border-rose-500/25 bg-rose-500/10 text-rose-300"
      : "border-blue-500/25 bg-blue-500/10 text-blue-200";

  return (
    <div className="overflow-hidden rounded-xl border border-zinc-700/80 bg-gradient-to-br from-zinc-900 via-zinc-900 to-blue-950/25 shadow-lg shadow-black/10">
      <div className="flex flex-col gap-4 p-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex min-w-0 gap-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-blue-400/20 bg-blue-500/10 text-blue-300">
            <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
              <path d="M8.5 11.5 11 14l4.8-5" strokeLinecap="round" strokeLinejoin="round" />
              <path d="M6.5 4.5h11a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2h-11a2 2 0 0 1-2-2v-11a2 2 0 0 1 2-2Z" />
            </svg>
          </div>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h4 className="text-sm font-medium text-zinc-100">普通 Teambition 用户登录</h4>
              <span className={`rounded-full border px-2 py-0.5 text-[10px] font-medium ${toneClasses[presentation.tone]}`}>
                {checking ? "检测中" : presentation.label}
              </span>
            </div>
            <p className="mt-1 text-xs leading-5 text-zinc-400">{checking ? "正在确认 Cookie 是否仍然有效…" : presentation.hint}</p>
            <p className="mt-1 text-[11px] text-zinc-600">任何用户都可扫码；这里只建立 TB 用户登录态，不会授予管理员或超级管理员权限。</p>
            {health.reason && health.status !== "valid" && !checking && (
              <p className="mt-1 text-[11px] text-zinc-500">{health.reason}</p>
            )}
            <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[10px] text-zinc-600">
              <span>登录 → 自动验证 → 安全保存</span>
              {formatTbCheckedAt(health.checkedAt) && <span>最近检测 {formatTbCheckedAt(health.checkedAt)}</span>}
            </div>
          </div>
        </div>

        <div className="flex shrink-0 flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={handleLogin}
            disabled={isLogging}
            className="inline-flex items-center gap-1.5 rounded-lg bg-blue-500 px-3.5 py-2 text-xs font-medium text-white shadow-md shadow-blue-950/30 transition hover:bg-blue-400 disabled:cursor-wait disabled:opacity-60"
          >
            {isLogging && <span className="h-3 w-3 animate-spin rounded-full border-2 border-white/40 border-t-white" />}
            {isLogging ? "等待登录完成" : health.valid ? "重新登录" : "一键登录"}
          </button>
          <button
            type="button"
            onClick={check}
            disabled={checking || isLogging}
            className="rounded-lg border border-zinc-700 bg-zinc-800/80 px-3 py-2 text-xs text-zinc-300 transition hover:border-zinc-600 hover:bg-zinc-700 disabled:opacity-50"
          >
            {checking ? "验证中…" : "立即验证"}
          </button>
        </div>
      </div>

      {loginState && loginState.status !== "idle" && (
        <div className={`mx-4 mb-4 flex items-center justify-between gap-3 rounded-lg border px-3 py-2.5 text-xs ${loginTone}`}>
          <div className="flex min-w-0 items-center gap-2">
            {isLogging && <span className="h-2 w-2 shrink-0 animate-pulse rounded-full bg-current" />}
            <span className="leading-5">{loginState.message || "正在处理登录…"}</span>
          </div>
          {isLogging && (
            <button type="button" onClick={handleCancel} className="shrink-0 text-[11px] text-zinc-400 transition hover:text-rose-300">取消</button>
          )}
        </div>
      )}

      <div className="border-t border-zinc-800/90 bg-black/10 px-4 py-3">
        <button
          type="button"
          onClick={() => { setManualOpen((value) => !value); setManualError(""); }}
          className="flex items-center gap-1.5 text-[11px] text-zinc-500 transition hover:text-zinc-300"
        >
          <span className={`transition ${manualOpen ? "rotate-90" : ""}`}>›</span>
          高级：管理员手工录入 Cookie
        </button>
        {manualOpen && (
          <div className="mt-3 rounded-lg border border-zinc-800 bg-zinc-950/60 p-3">
            <p className="mb-2 text-[10px] leading-4 text-zinc-600">仅在自动登录不可用时使用。已保存的 Cookie 不会回显；留空不会覆盖原值。</p>
            <textarea
              value={manualCookie}
              onChange={(event) => { setManualCookie(event.target.value); setManualError(""); }}
              rows={3}
              autoComplete="off"
              spellCheck={false}
              placeholder={cookieConfigured ? "已安全保存。粘贴新 Cookie 可替换现有值" : "粘贴完整的 Teambition Cookie"}
              className="w-full resize-none rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 font-mono text-xs text-zinc-300 outline-none transition placeholder:text-zinc-700 focus:border-blue-500/60"
            />
            <div className="mt-2 flex items-center justify-between gap-3">
              <span className="text-[10px] text-rose-400">{manualError}</span>
              <button
                type="button"
                onClick={saveManualCookie}
                disabled={manualSaving}
                className="rounded-md bg-zinc-100 px-3 py-1.5 text-[11px] font-medium text-zinc-900 transition hover:bg-white disabled:opacity-50"
              >
                {manualSaving ? "验证中…" : "验证并安全保存"}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function GatewayConnectionSection({ onSaved }) {
  const suggestedGateway = "http://localhost:3001";
  const [gatewayUrl, setGatewayUrlState] = useState(getGatewayUrl());
  const [connTest, setConnTest] = useState(null);

  function saveGatewayUrl() {
    setGatewayUrl(gatewayUrl);
    onSaved?.();
  }

  function testConnection() {
    setConnTest("testing");
    const url = gatewayUrl || "";
    // quality-gate-ignore STATE-RAW-FETCH: 用户主动测试可配置 Gateway 的只读健康接口，不能附带当前服务的管理员凭据。
    fetch(`${url}/api/health`).then((r) => r.json()).then((d) => {
      setConnTest(d.status === "ok" ? "ok" : "fail");
    }).catch(() => setConnTest("fail"));
    setTimeout(() => setConnTest(null), 3000);
  }

  return (
    <Section title="网关连接">
      <div>
        <label className="block text-xs text-zinc-500 mb-1">本地网关地址（你自己电脑上运行的网关）</label>
        <div className="flex space-x-2">
          <input
            type="text"
            value={gatewayUrl}
            onChange={(e) => setGatewayUrlState(e.target.value)}
            placeholder={suggestedGateway || "http://服务器IP:3001"}
            className="flex-1 bg-zinc-800 border border-zinc-700 rounded px-3 py-2 text-sm text-zinc-300 placeholder-zinc-600 outline-none focus:border-zinc-500"
          />
          {suggestedGateway && !gatewayUrl && (
            <button onClick={() => { setGatewayUrlState(suggestedGateway); }} className="px-3 py-2 text-xs bg-blue-600/20 text-blue-400 hover:bg-blue-600/30 rounded transition whitespace-nowrap">
              使用推荐
            </button>
          )}
          <button onClick={saveGatewayUrl} className="px-3 py-2 text-xs bg-zinc-700 hover:bg-zinc-600 text-zinc-300 rounded transition">
            保存
          </button>
          <button onClick={testConnection} className={`px-3 py-2 text-xs rounded transition ${
            connTest === "ok" ? "bg-green-600/20 text-green-400" :
            connTest === "fail" ? "bg-red-600/20 text-red-400" :
            "bg-zinc-700 hover:bg-zinc-600 text-zinc-300"
          }`}>
            {connTest === "testing" ? "测试中..." : connTest === "ok" ? "连接成功" : connTest === "fail" ? "连接失败" : "测试连接"}
          </button>
        </div>
        <p className="text-xs text-zinc-600 mt-1.5">
          AI 引擎和设备扫描在你本地执行。请先在本机启动网关（<code className="text-zinc-400">bash start.sh</code>），然后填入 <code className="text-zinc-400">http://localhost:3001</code> 或本机 IP。
        </p>
      </div>
    </Section>
  );
}

function Section({ title, children, defer = false, onVisible }) {
  return (
    <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-5 space-y-4">
      <h3 className="text-xs font-semibold text-zinc-400 uppercase tracking-wider">{title}</h3>
      {defer ? <DeferredSettingsPanel onVisible={onVisible}>{children}</DeferredSettingsPanel> : children}
    </div>
  );
}

function DeferredSettingsPanel({ children, onVisible, placeholder = "滚动到此区域时加载详细设置…" }) {
  const hostRef = useRef(null);
  const [ready, setReady] = useState(() => typeof IntersectionObserver === "undefined");
  const visibleNotifiedRef = useRef(false);

  useEffect(() => {
    if (ready) return undefined;
    const host = hostRef.current;
    if (!host || typeof IntersectionObserver !== "function") {
      setReady(true);
      return undefined;
    }
    const observer = new IntersectionObserver((entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return;
      setReady(true);
      observer.disconnect();
    }, { rootMargin: "600px 0px" });
    observer.observe(host);
    return () => observer.disconnect();
  }, [ready]);

  useEffect(() => {
    if (!ready || visibleNotifiedRef.current) return;
    visibleNotifiedRef.current = true;
    onVisible?.();
  }, [ready, onVisible]);

  return (
    <div ref={hostRef} data-testid="settings-deferred-panel" className={ready ? "" : "min-h-20"}>
      {ready ? children : <p className="text-xs text-zinc-600">{placeholder}</p>}
    </div>
  );
}

function Row({ label, children }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-sm text-zinc-300">{label}</span>
      {children}
    </div>
  );
}

function ToggleRow({ label, sub, value, onChange, disabled, testId }) {
  return (
    <div className="flex items-center justify-between">
      <div>
        <p className="text-sm text-zinc-300">{label}</p>
        {sub && <p className="text-xs text-zinc-600">{sub}</p>}
      </div>
      <button onClick={() => !disabled && onChange(!value)} disabled={disabled} data-testid={testId}
        className={`relative w-11 h-6 rounded-full transition-colors shrink-0 ${value ? "bg-blue-600" : "bg-zinc-700"} ${disabled ? "opacity-50 cursor-not-allowed" : ""}`}>
        <span
          className="absolute top-1 left-1 w-4 h-4 bg-white rounded-full transition-transform"
          style={{ transform: value ? "translateX(20px)" : "translateX(0)" }}
        />
      </button>
    </div>
  );
}

function Input({ label, value, onChange, type = "text", placeholder }) {
  return (
    <div>
      <label className="block text-xs text-zinc-500 mb-1">{label}</label>
      <input type={type} value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder}
        className="w-full bg-zinc-800 border border-zinc-700 rounded px-3 py-2 text-sm text-zinc-300 placeholder-zinc-600 outline-none focus:border-zinc-500" />
    </div>
  );
}

function safeCodeupUiText(value) {
  return String(value || "Codeup 请求失败")
    .replace(/pt-[A-Za-z0-9_-]+/g, "pt-***")
    .slice(0, 500);
}

function codeupFormFromConfig(codeup = {}) {
  const edition = String(codeup.edition || "central").toLowerCase() === "region" ? "region" : "central";
  return {
    edition,
    apiBaseUrl: edition === "central"
      ? "https://openapi-rdc.aliyuncs.com"
      : String(codeup.apiBaseUrl || ""),
    organizationId: String(codeup.organizationId || ""),
    reviewerName: String(codeup.reviewerName || "阳荣峰"),
  };
}

function CodeupSettingsPanel({ config, onConfigUpdated, onMessage }) {
  const codeup = config.codeup || {};
  const [form, setForm] = useState(() => codeupFormFromConfig(codeup));
  const [tokenDraft, setTokenDraft] = useState("");
  const [organizations, setOrganizations] = useState([]);
  const [busy, setBusy] = useState("");
  const [result, setResult] = useState(null);
  const tokenConfigured = codeup.accessTokenConfigured === true || /\*{3,}/.test(String(codeup.accessToken || ""));
  const tokenManagedByEnvironment = codeup.accessTokenManagedByEnvironment === true;
  const organizationManagedByEnvironment = codeup.organizationIdManagedByEnvironment === true;
  const editionManagedByEnvironment = codeup.editionManagedByEnvironment === true;
  const apiBaseUrlManagedByEnvironment = codeup.apiBaseUrlManagedByEnvironment === true;

  useEffect(() => {
    setForm(codeupFormFromConfig(codeup));
  }, [codeup.apiBaseUrl, codeup.edition, codeup.organizationId, codeup.reviewerName]); // eslint-disable-line react-hooks/exhaustive-deps

  function patchForm(patch) {
    setForm((prev) => ({ ...prev, ...patch }));
    setResult(null);
  }

  function requestPayload(includeDraft = true) {
    const payload = {
      edition: form.edition,
      apiBaseUrl: form.edition === "central" ? "https://openapi-rdc.aliyuncs.com" : form.apiBaseUrl.trim(),
      organizationId: form.edition === "central" ? form.organizationId.trim() : "",
    };
    if (includeDraft && tokenDraft.trim()) payload.accessToken = tokenDraft.trim();
    return payload;
  }

  async function readJsonResponse(response) {
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data.success === false) {
      throw new Error(safeCodeupUiText(data.error || `HTTP ${response.status}`));
    }
    return data;
  }

  async function discoverOrganizations() {
    if (form.edition === "region") {
      setResult({ kind: "info", text: "Region 版不需要组织 ID，请直接保存并检测连接。" });
      return;
    }
    if (!tokenDraft.trim() && !tokenConfigured) {
      setResult({ kind: "error", text: "请先填写个人访问令牌。" });
      return;
    }
    setBusy("discover");
    setResult(null);
    try {
      const response = await fetch(getApiUrl("/api/config/codeup/organizations"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        cache: "no-store",
        body: JSON.stringify(requestPayload(true)),
      });
      const data = await readJsonResponse(response);
      const rows = Array.isArray(data.data?.organizations) ? data.data.organizations : [];
      setOrganizations(rows);
      if (rows.length === 1) patchForm({ organizationId: rows[0].id });
      setResult({
        kind: rows.length ? "success" : "info",
        text: rows.length === 1
          ? `已识别组织：${rows[0].name || rows[0].id}`
          : (rows.length > 1 ? `读取到 ${rows.length} 个组织，请选择。` : "令牌有效，但没有返回可选组织；可手工填写组织 ID。"),
      });
    } catch (error) {
      setOrganizations([]);
      setResult({ kind: "error", text: `${safeCodeupUiText(error.message)}。若令牌没有“组织只读”权限，可手工填写组织 ID。` });
    } finally {
      setBusy("");
    }
  }

  async function checkConnection(includeDraft = true) {
    const response = await fetch(getApiUrl("/api/config/codeup/check"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      cache: "no-store",
      body: JSON.stringify(requestPayload(includeDraft)),
    });
    const data = await readJsonResponse(response);
    const repository = data.data?.repository;
    return {
      kind: "success",
      text: repository
        ? `连接成功，可读取仓库：${repository.path || repository.name || repository.id}`
        : "连接成功；当前令牌暂未返回可见仓库。",
    };
  }

  function persistedCodeup(accessToken) {
    const {
      accessTokenConfigured: _configured,
      accessTokenManagedByEnvironment: _tokenFromEnv,
      organizationIdManagedByEnvironment: _orgFromEnv,
      editionManagedByEnvironment: _editionFromEnv,
      apiBaseUrlManagedByEnvironment: _apiBaseFromEnv,
      ...base
    } = codeup;
    return {
      ...base,
      apiBaseUrl: form.edition === "central" ? "https://openapi-rdc.aliyuncs.com" : form.apiBaseUrl.trim(),
      edition: form.edition,
      organizationId: form.edition === "central" ? form.organizationId.trim() : "",
      reviewerName: form.reviewerName.trim(),
      accessToken,
    };
  }

  async function putCodeup(accessToken) {
    const response = await fetch(getApiUrl("/api/config/codeup"), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      cache: "no-store",
      body: JSON.stringify(persistedCodeup(accessToken)),
    });
    const data = await readJsonResponse(response);
    if (data.data?.codeup) onConfigUpdated?.({ codeup: data.data.codeup });
    return data;
  }

  async function saveAndCheck() {
    if (!tokenDraft.trim() && !tokenConfigured) {
      setResult({ kind: "error", text: "请先填写个人访问令牌。" });
      return;
    }
    if (form.edition === "central" && !form.organizationId.trim()) {
      setResult({ kind: "error", text: "请先自动读取或手工填写组织 ID。" });
      return;
    }
    if (form.edition === "region" && !form.apiBaseUrl.trim()) {
      setResult({ kind: "error", text: "请填写 Region 实例 API 接入点。" });
      return;
    }
    if (form.edition === "region") {
      try {
        const url = new URL(form.apiBaseUrl.trim());
        if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) throw new Error();
      } catch {
        setResult({ kind: "error", text: "Region API 接入点必须是 HTTPS URL，且不能包含账号、查询参数或片段。" });
        return;
      }
    }

    setBusy("save");
    setResult(null);
    try {
      const tokenForSave = tokenDraft.trim() || (tokenConfigured ? "***" : "");
      await putCodeup(tokenForSave);
      setTokenDraft("");
      const checked = await checkConnection(false);
      setResult(checked);
      onMessage?.("Codeup 配置已安全保存");
    } catch (error) {
      setResult({ kind: "error", text: safeCodeupUiText(error.message) });
    } finally {
      setBusy("");
    }
  }

  async function clearSavedToken() {
    if (tokenManagedByEnvironment) return;
    if (typeof window !== "undefined" && !window.confirm("确认清除本机 Gateway 中保存的 Codeup 个人令牌？")) return;
    setBusy("clear");
    setResult(null);
    try {
      await putCodeup("");
      setTokenDraft("");
      setResult({ kind: "info", text: "已清除本机保存的 Codeup 个人令牌。" });
      onMessage?.("Codeup 令牌已清除");
    } catch (error) {
      setResult({ kind: "error", text: safeCodeupUiText(error.message) });
    } finally {
      setBusy("");
    }
  }

  const resultClass = result?.kind === "success"
    ? "border-emerald-800/50 bg-emerald-950/20 text-emerald-300"
    : result?.kind === "error"
      ? "border-red-800/50 bg-red-950/20 text-red-300"
      : "border-blue-800/40 bg-blue-950/20 text-blue-300";

  return (
    <Section title="Codeup 提 PR">
      <div data-testid="codeup-settings" className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-zinc-800 bg-zinc-950/30 px-3 py-2">
          <div>
            <div className="text-xs font-medium text-zinc-300">个人令牌与组织配置</div>
            <div className="mt-0.5 text-[10px] text-zinc-600">仅用于本机 Gateway 调用 Codeup OAPI；浏览器不会读取或回显已保存令牌。</div>
          </div>
          <span data-testid="codeup-token-state" className={`rounded-full px-2 py-1 text-[10px] ${tokenConfigured ? "bg-emerald-950/50 text-emerald-300" : "bg-amber-950/40 text-amber-300"}`}>
            {tokenConfigured ? (tokenManagedByEnvironment ? "令牌由环境变量托管" : "令牌已保存（不可查看）") : "令牌未配置"}
          </span>
        </div>

        <div className="rounded-lg border border-amber-800/40 bg-amber-950/15 px-3 py-2 text-[11px] leading-relaxed text-amber-200/90">
          隐私保护：令牌只通过 HTTPS/本机请求体发送，不放入 URL、不写 localStorage、不提供显示或复制按钮；保存后输入框立即清空。共享 Gateway 会共享该令牌，请只在可信设备上配置。
        </div>

        <div className="grid gap-3 md:grid-cols-2">
          <div>
            <label className="mb-1 block text-xs text-zinc-500">云效版本</label>
            <select
              value={form.edition}
              disabled={editionManagedByEnvironment}
              onChange={(event) => {
                const edition = event.target.value === "region" ? "region" : "central";
                patchForm({
                  edition,
                  apiBaseUrl: edition === "central" ? "https://openapi-rdc.aliyuncs.com" : (form.apiBaseUrl === "https://openapi-rdc.aliyuncs.com" ? "" : form.apiBaseUrl),
                  organizationId: edition === "region" ? "" : form.organizationId,
                });
                setOrganizations([]);
              }}
              className="w-full rounded border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm text-zinc-300 outline-none focus:border-zinc-500 disabled:cursor-not-allowed disabled:opacity-60"
            >
              <option value="central">中心版（codeup.aliyun.com）</option>
              <option value="region">Region 版（专属实例）</option>
            </select>
          </div>
          <div>
            <label className="mb-1 block text-xs text-zinc-500">个人访问令牌</label>
            <div className="flex gap-2">
              <input
                data-testid="codeup-token-input"
                type="password"
                name="codeup-personal-access-token"
                autoComplete="new-password"
                spellCheck={false}
                disabled={tokenManagedByEnvironment}
                value={tokenDraft}
                onChange={(event) => { setTokenDraft(event.target.value); setResult(null); }}
                placeholder={tokenConfigured ? "已保存；留空表示不修改" : "粘贴 pt- 开头的个人令牌"}
                className="min-w-0 flex-1 rounded border border-zinc-700 bg-zinc-800 px-3 py-2 font-mono text-sm text-zinc-300 outline-none placeholder:text-zinc-600 focus:border-zinc-500 disabled:cursor-not-allowed disabled:opacity-60"
              />
              {tokenConfigured && !tokenManagedByEnvironment && (
                <button
                  data-testid="codeup-clear-token"
                  type="button"
                  onClick={clearSavedToken}
                  disabled={!!busy}
                  className="shrink-0 rounded border border-red-900/60 bg-red-950/20 px-3 py-2 text-xs text-red-300 hover:bg-red-950/40 disabled:opacity-50"
                >清除</button>
              )}
            </div>
          </div>
        </div>

        {form.edition === "central" ? (
          <div className="grid gap-3 md:grid-cols-[1fr_auto]">
            <div>
              <label className="mb-1 block text-xs text-zinc-500">组织 ID</label>
              <input
                data-testid="codeup-organization-input"
                value={form.organizationId}
                disabled={organizationManagedByEnvironment}
                onChange={(event) => patchForm({ organizationId: event.target.value })}
                placeholder="可自动读取，也可手工填写"
                className="w-full rounded border border-zinc-700 bg-zinc-800 px-3 py-2 font-mono text-sm text-zinc-300 outline-none placeholder:text-zinc-600 focus:border-zinc-500 disabled:cursor-not-allowed disabled:opacity-60"
              />
            </div>
            <div className="flex items-end">
              <button
                data-testid="codeup-discover-organizations"
                type="button"
                onClick={discoverOrganizations}
                disabled={!!busy}
                className="w-full rounded bg-blue-600 px-4 py-2 text-xs text-white hover:bg-blue-500 disabled:bg-zinc-700 disabled:text-zinc-500 md:w-auto"
              >{busy === "discover" ? "读取中..." : "用令牌读取组织"}</button>
            </div>
          </div>
        ) : (
          <div>
            <label className="mb-1 block text-xs text-zinc-500">Region API 接入点</label>
            <input
              data-testid="codeup-region-api-input"
              value={form.apiBaseUrl}
              disabled={apiBaseUrlManagedByEnvironment}
              onChange={(event) => patchForm({ apiBaseUrl: event.target.value })}
              placeholder="https://你的云效实例访问域名"
              className="w-full rounded border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm text-zinc-300 outline-none placeholder:text-zinc-600 focus:border-zinc-500 disabled:cursor-not-allowed disabled:opacity-60"
            />
          </div>
        )}

        {(editionManagedByEnvironment || apiBaseUrlManagedByEnvironment) && (
          <div className="text-[10px] text-zinc-600">云效版本或 Region 接入点由本机环境变量托管，页面仅展示有效值且不会覆盖。</div>
        )}

        {organizations.length > 1 && (
          <div>
            <label className="mb-1 block text-xs text-zinc-500">选择组织</label>
            <select
              data-testid="codeup-organization-select"
              value={form.organizationId}
              onChange={(event) => patchForm({ organizationId: event.target.value })}
              className="w-full rounded border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm text-zinc-300 outline-none"
            >
              <option value="">请选择组织</option>
              {organizations.map((organization) => (
                <option key={organization.id} value={organization.id}>{organization.name || organization.id}</option>
              ))}
            </select>
          </div>
        )}

        <Input
          label="默认评审人姓名（查询失败不会阻断 MR）"
          value={form.reviewerName}
          onChange={(value) => patchForm({ reviewerName: value })}
          placeholder="例如：阳荣峰"
        />

        <div className="flex flex-wrap items-center gap-2">
          <button
            data-testid="codeup-save-and-check"
            type="button"
            onClick={saveAndCheck}
            disabled={!!busy}
            className="rounded bg-emerald-600 px-4 py-2 text-xs font-medium text-white hover:bg-emerald-500 disabled:bg-zinc-700 disabled:text-zinc-500"
          >{busy === "save" ? "保存并检测中..." : "安全保存并检测"}</button>
          <a href="https://codeup.aliyun.com/" target="_blank" rel="noreferrer" className="text-xs text-blue-400 hover:text-blue-300">打开 Codeup 创建个人令牌</a>
          <span className="text-[10px] text-zinc-600">检测仅执行只读仓库查询，不会创建 MR。</span>
        </div>

        {result && (
          <div data-testid="codeup-config-result" className={`rounded-lg border px-3 py-2 text-xs ${resultClass}`}>
            {result.text}
          </div>
        )}
      </div>
    </Section>
  );
}

function fmtBytes(n) {
  if (!n) return "0 B";
  const u = ["B", "KB", "MB", "GB"];
  let i = 0, v = n;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v >= 10 || i === 0 ? 0 : 1)} ${u[i]}`;
}

async function readBackupJson(res) {
  const text = await res.text();
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      const brief = text.replace(/\s+/g, " ").trim().slice(0, 160);
      throw new Error(`HTTP ${res.status}${res.statusText ? ` ${res.statusText}` : ""}${brief ? `：${brief}` : ""}`);
    }
  }
  if (!res.ok || data?.success === false) {
    throw new Error(data?.error || `HTTP ${res.status}${res.statusText ? ` ${res.statusText}` : ""}`);
  }
  return data || {};
}

async function readBackupError(res) {
  const text = await res.text().catch(() => "");
  if (text) {
    try {
      const data = JSON.parse(text);
      if (data?.error) return data.error;
    } catch { /* fall through */ }
  }
  const brief = text.replace(/\s+/g, " ").trim().slice(0, 160);
  return `HTTP ${res.status}${res.statusText ? ` ${res.statusText}` : ""}${brief ? `：${brief}` : ""}`;
}

function isMissingBackupRoute(res, text) {
  return res.status === 404 && /Cannot\s+(GET|POST)\s+\/api\/backup\//i.test(text || "");
}

function makeBackupUrl(base, path) {
  return `${base || ""}${path}`;
}

// AI 配置 / 记忆 / Skills 一键备份·迁移·还原面板
function BackupMigratePanel() {
  const [manifest, setManifest] = useState(null);
  const [manifestError, setManifestError] = useState("");
  const [checked, setChecked] = useState({}); // id -> bool
  const [includeSessions, setIncludeSessions] = useState(false);
  const [includeSecrets, setIncludeSecrets] = useState(false);
  const [busy, setBusy] = useState("");      // "backup" | "restore" | "preview" | ""
  const [note, setNote] = useState(null);     // { kind:"ok"|"err", text }
  const [env, setEnv] = useState({ loading: true, data: null, error: "" });
  // 还原态
  const [restoreFile, setRestoreFile] = useState(null);
  const [preview, setPreview] = useState(null);
  const [targetWs, setTargetWs] = useState("");
  const [overwrite, setOverwrite] = useState(false);
  const [report, setReport] = useState(null);
  const initialBackupBase = getGatewayUrl();
  const [backupBase, setBackupBase] = useState(initialBackupBase);
  const backupBaseRef = useRef(initialBackupBase);
  const fileRef = useRef(null);
  const initialProbeStartedRef = useRef(false);

  function backupBaseCandidates() {
    const list = [backupBaseRef.current, getGatewayUrl(), ""];
    const hosts = ["localhost", "127.0.0.1"];
    for (let port = 3001; port <= 3005; port += 1) {
      for (const host of hosts) list.push(`http://${host}:${port}`);
    }
    return Array.from(new Set(list.map((v) => (v || "").replace(/\/+$/, ""))));
  }

  function setActiveBackupBase(base) {
    const normalized = (base || "").replace(/\/+$/, "");
    if (backupBaseRef.current === normalized) return;
    backupBaseRef.current = normalized;
    setBackupBase(normalized);
  }

  async function fetchBackup(path, options) {
    let lastError = null;
    const method = String(options?.method || "GET").toUpperCase();
    const request = ["POST", "PUT", "PATCH", "DELETE"].includes(method)
      ? authenticatedFetch
      : fetch;
    for (const base of backupBaseCandidates()) {
      try {
        const res = await request(makeBackupUrl(base, path), options);
        if (res.status === 404) {
          const text = await res.clone().text().catch(() => "");
          if (isMissingBackupRoute(res, text)) {
            lastError = new Error(`HTTP 404：${base || "当前页面代理"} 未挂载 /api/backup`);
            continue;
          }
        }
        if (res.ok) setActiveBackupBase(base);
        return res;
      } catch (e) {
        lastError = e;
      }
    }
    throw lastError || new Error("没有找到可用的本机备份网关");
  }

  async function loadManifest() {
    setManifestError("");
    try {
      const d = await fetchBackup("/api/backup/manifest").then(readBackupJson);
      setManifest(d.data);
      const init = {};
      for (const it of d.data.items) init[it.id] = it.defaultChecked;
      setChecked(init);
      setTargetWs(d.data.sourceWorkspaceRoot || "");
    } catch (e) {
      setManifest(null);
      setManifestError(e.message || "备份清单加载失败");
    }
  }

  useEffect(() => {
    if (initialProbeStartedRef.current) return;
    initialProbeStartedRef.current = true;
    loadManifest();
    refreshEnv();
  }, []);

  async function refreshEnv() {
    setEnv({ loading: true, data: env.data, error: "" });
    try {
      const d = await fetchBackup("/api/backup/env-check").then(readBackupJson);
      setEnv({ loading: false, data: d.data, error: "" });
    } catch (e) {
      setEnv({ loading: false, data: null, error: e.message || "运行环境检测失败" });
    }
  }

  function toast(kind, text, ms = 4000) {
    setNote({ kind, text });
    if (ms) setTimeout(() => setNote(null), ms);
  }

  async function doBackup() {
    setBusy("backup");
    try {
      if (!manifest) throw new Error("备份清单尚未加载完成");
      const items = manifest.items.filter((it) => checked[it.id]).map((it) => it.id);
      const res = await fetchBackup("/api/backup/create", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ items, includeSessions, includeSecrets }),
      });
      if (!res.ok) throw new Error(await readBackupError(res));
      const filename = res.headers.get("X-Backup-Filename") || "ai-backup.aibak.zip";
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url; a.download = filename; document.body.appendChild(a); a.click();
      a.remove(); URL.revokeObjectURL(url);
      toast("ok", `已生成备份包 ${filename}（${fmtBytes(blob.size)}），开始下载`);
    } catch (e) {
      toast("err", `备份失败：${e.message}`, 6000);
    } finally { setBusy(""); }
  }

  async function onPickRestore(file) {
    setRestoreFile(file); setPreview(null); setReport(null);
    if (!file) return;
    setBusy("preview");
    try {
      const buf = await file.arrayBuffer();
      const res = await fetchBackup("/api/backup/restore/preview", {
        method: "POST", headers: { "Content-Type": "application/octet-stream" }, body: buf,
      });
      const d = await readBackupJson(res);
      setPreview(d.data);
      toast("ok", `已读取备份包（来源主机 ${d.data.host}）`);
    } catch (e) {
      toast("err", `读取备份包失败：${e.message}`, 6000);
      setRestoreFile(null);
    } finally { setBusy(""); }
  }

  async function doRestore() {
    if (!restoreFile) return;
    if (!confirm("确认还原？将把备份中的配置/记忆/Skills 写入本机。已存在的文件会先备份再覆盖（除非勾选直接覆盖）。")) return;
    setBusy("restore");
    try {
      const buf = await restoreFile.arrayBuffer();
      const qs = new URLSearchParams();
      if (targetWs) qs.set("targetWorkspaceRoot", targetWs);
      if (overwrite) qs.set("overwrite", "true");
      const res = await fetchBackup(`/api/backup/restore?${qs.toString()}`, {
        method: "POST", headers: { "Content-Type": "application/octet-stream" }, body: buf,
      });
      const d = await readBackupJson(res);
      setReport(d.data);
      toast("ok", `还原完成：写入 ${d.data.written.length} 个文件`);
    } catch (e) {
      toast("err", `还原失败：${e.message}`, 6000);
    } finally { setBusy(""); }
  }

  const selectedBytes = manifest ? manifest.items.filter((it) => checked[it.id]).reduce((s, it) => s + (it.bytes || 0), 0) : 0;

  return (
    <div className="space-y-5">
      <p className="text-xs text-zinc-600 -mt-2">
        把本机 + 本工程的所有 AI 配置 / 记忆 / Skills（Claude 全局记忆与配置、本项目记忆、工程规范、网关配置、Codex 配置与 Skills 等）打成一个
        <code className="text-zinc-400 mx-1">.aibak.zip</code> 备份包，换设备后一键还原。
        <span className="text-amber-400/80"> 不含登录凭证，还原后需重新登录 Claude / Codex。</span>
      </p>
      {note && (
        <div className={`text-xs px-3 py-2 rounded ${note.kind === "ok" ? "bg-green-600/15 text-green-400" : "bg-red-600/15 text-red-400"}`}>{note.text}</div>
      )}

      {/* ① 备份 */}
      <div className="border border-zinc-800 rounded-lg p-4 space-y-3 bg-zinc-950/30">
        <div className="text-xs font-semibold text-zinc-300">① 备份当前设备 / 工程</div>
        {!manifest && !manifestError && <div className="text-xs text-zinc-600">加载中…（请确认已连接本机网关）</div>}
        {manifestError && (
          <div className="flex items-center justify-between gap-3 text-xs px-3 py-2 rounded bg-red-600/15 text-red-400">
            <span>备份清单加载失败：{manifestError}</span>
            <button onClick={loadManifest} className="shrink-0 px-2 py-1 text-[11px] bg-zinc-800 hover:bg-zinc-700 text-zinc-200 rounded transition">重试</button>
          </div>
        )}
        {manifest && (
          <>
            <div className="text-[11px] text-zinc-600">
              源工程：<code className="text-zinc-400">{manifest.sourceWorkspaceRoot}</code>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5">
              {manifest.items.map((it) => (
                <label key={it.id} className={`flex items-center gap-2 text-xs px-2 py-1.5 rounded border ${it.exists ? "border-zinc-800 bg-zinc-900/40" : "border-zinc-900 bg-zinc-900/10 opacity-50"}`}>
                  <input type="checkbox" disabled={!it.exists} checked={!!checked[it.id]}
                    onChange={(e) => setChecked((p) => ({ ...p, [it.id]: e.target.checked }))} />
                  <span className="flex-1 text-zinc-300">{it.label}</span>
                  <span className="text-[10px] text-zinc-600">{it.exists ? `${it.files} 个 · ${fmtBytes(it.bytes)}` : "不存在"}</span>
                </label>
              ))}
            </div>
            <div className="flex flex-wrap items-center gap-4 pt-1">
              <label className="flex items-center gap-2 text-xs text-zinc-400">
                <input type="checkbox" checked={includeSessions} onChange={(e) => { setIncludeSessions(e.target.checked); setChecked((p) => ({ ...p, "claude-sessions": e.target.checked })); }} />
                含会话历史（*.jsonl，体积大）
              </label>
              <label className="flex items-center gap-2 text-xs text-zinc-400">
                <input type="checkbox" checked={includeSecrets} onChange={(e) => setIncludeSecrets(e.target.checked)} />
                含明文敏感配置（API Key / Cookie / 密钥）
              </label>
              {!includeSecrets && <span className="text-[10px] text-amber-400/70">默认抹除密钥，还原后需重填</span>}
            </div>
            <div className="flex items-center justify-between pt-1">
              <span className="text-[11px] text-zinc-600">已选约 {fmtBytes(selectedBytes)}</span>
              <button onClick={doBackup} disabled={busy === "backup"}
                className="px-4 py-2 text-xs bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white rounded transition">
                {busy === "backup" ? "打包中…" : "一键备份并下载"}
              </button>
            </div>
          </>
        )}
      </div>

      {/* ② 还原 */}
      <div className="border border-zinc-800 rounded-lg p-4 space-y-3 bg-zinc-950/30">
        <div className="text-xs font-semibold text-zinc-300">② 在本设备还原（搬迁）</div>
        <p className="text-[11px] text-zinc-600">选择从其它设备生成的 <code className="text-zinc-400">.aibak.zip</code>（局域网网页端 / desktop / U 盘皆可），还原后即与原电脑一致。</p>
        <input ref={fileRef} type="file" accept=".zip,.aibak.zip" className="hidden"
          onChange={(e) => onPickRestore(e.target.files?.[0] || null)} />
        <div className="flex items-center gap-2">
          <button onClick={() => fileRef.current?.click()} disabled={busy === "preview"}
            className="px-3 py-2 text-xs bg-zinc-700 hover:bg-zinc-600 text-zinc-300 rounded transition">
            {busy === "preview" ? "读取中…" : "选择备份包"}
          </button>
          {restoreFile && <span className="text-[11px] text-zinc-400">{restoreFile.name}</span>}
        </div>

        {preview && (
          <div className="space-y-2 border-t border-zinc-800 pt-3">
            <div className="text-[11px] text-zinc-500">
              来源主机 <span className="text-zinc-300">{preview.host}</span> · 生成于 {new Date(preview.createdAt).toLocaleString()} ·
              {preview.includeSecrets ? " 含明文密钥" : " 已脱敏"}{preview.includeSessions ? " · 含会话历史" : ""}
            </div>
            <div className="text-[11px] text-zinc-600">原工程：<code className="text-zinc-400">{preview.sourceWorkspaceRoot}</code></div>
            <div className="flex flex-wrap gap-1.5">
              {preview.items.map((it) => (
                <span key={it.id} className="text-[10px] px-2 py-0.5 rounded bg-zinc-800 text-zinc-400">{it.label}（{it.files}）</span>
              ))}
            </div>
            <div>
              <label className="block text-[11px] text-zinc-500 mb-1">还原到本机工程根目录（路径会自动改写为此目录）</label>
              <input type="text" value={targetWs} onChange={(e) => setTargetWs(e.target.value)}
                placeholder="如 D:\\workspace\\...\\AIEfficiencyTrack"
                className="w-full bg-zinc-800 border border-zinc-700 rounded px-3 py-1.5 text-xs text-zinc-300 placeholder-zinc-600 outline-none focus:border-zinc-500" />
            </div>
            <label className="flex items-center gap-2 text-xs text-zinc-400">
              <input type="checkbox" checked={overwrite} onChange={(e) => setOverwrite(e.target.checked)} />
              直接覆盖已存在文件（不勾则先把旧文件备份到 ~/.ai-backup-restore-bak/）
            </label>
            <button onClick={doRestore} disabled={busy === "restore"}
              className="px-4 py-2 text-xs bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white rounded transition">
              {busy === "restore" ? "还原中…" : "一键还原"}
            </button>
          </div>
        )}

        {report && (
          <div className="space-y-1.5 border-t border-zinc-800 pt-3 text-[11px]">
            <div className="text-green-400">✓ 已写入 {report.written.length} 个文件{report.rewritten.length ? `，改写路径 ${report.rewritten.length} 处` : ""}{report.backedUp.length ? `，旧文件备份 ${report.backedUp.length} 个` : ""}</div>
            <div className="text-zinc-500">还原工程根：<code className="text-zinc-400">{report.targetWorkspaceRoot}</code></div>
            {report.needRelogin?.length > 0 && (
              <div className="text-amber-400/90">⚠ 还原后需重新登录：{report.needRelogin.join("；")}</div>
            )}
            {report.needRefill?.length > 0 && (
              <div className="text-amber-400/90">⚠ 需重填：{report.needRefill.join("；")}</div>
            )}
          </div>
        )}
      </div>

      {/* ③ 环境检测 */}
      <div className="border border-zinc-800 rounded-lg p-4 space-y-3 bg-zinc-950/30">
        <div className="flex items-center justify-between">
          <div className="text-xs font-semibold text-zinc-300">③ 运行环境检测</div>
          <button onClick={refreshEnv} disabled={env.loading} className="px-2 py-1 text-[11px] bg-zinc-700 hover:bg-zinc-600 disabled:opacity-50 text-zinc-300 rounded transition">重新检测</button>
        </div>
        {backupBase && <div className="text-[10px] text-zinc-600">当前备份网关：<code className="text-zinc-400">{backupBase}</code></div>}
        {env.loading && <div className="text-xs text-zinc-600">检测中…</div>}
        {env.error && (
          <div className="text-xs px-3 py-2 rounded bg-red-600/15 text-red-400">
            检测失败：{env.error}。请确认当前页面连接的是本机网关，且后端已挂载 /api/backup。
          </div>
        )}
        {env.data && env.data.tools.map((t) => (
          <div key={t.name} className="flex items-start justify-between gap-3 text-xs border-b border-zinc-800/60 pb-2 last:border-0 last:pb-0">
            <div className="flex-1">
              <div className="flex items-center gap-2">
                <span className={`w-2 h-2 rounded-full ${t.found ? "bg-green-500" : "bg-red-500"}`} />
                <span className="text-zinc-300">{t.name}</span>
                {t.found && <span className="text-[10px] text-zinc-600">{t.version}</span>}
              </div>
              {!t.found && (
                <div className="mt-1 ml-4 flex items-center gap-2">
                  <code className="text-[10px] text-amber-400/90 bg-zinc-900 px-2 py-0.5 rounded">{t.installHint}</code>
                  <button onClick={() => copyToClipboard(t.installHint)} className="text-[10px] text-blue-400 hover:text-blue-300">复制</button>
                </div>
              )}
            </div>
            <span className={`text-[10px] ${t.found ? "text-green-400" : "text-red-400"}`}>{t.found ? "已就绪" : "未安装"}</span>
          </div>
        ))}
        <p className="text-[10px] text-zinc-600">未安装项请用上方命令自行安装（不自动执行）。Node 装好后即可运行本工具；Claude / Codex 装好后需各自登录。</p>
      </div>
    </div>
  );
}
