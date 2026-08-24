/**
 * 工程开发工作台 — /devbench
 *
 * 按"故事点"分子 tab，每个 tab 选定一个应用市场工程，直接与 AI 在该工程目录下
 * 对话；实时显示思考/回答/token；对话存档到工程 docs。统一一个 WebSocket，把流式事件
 * 按 sessionId 路由到对应 tab，后台 tab 也能持续接收。
 */
import React, { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { getApiUrl, createGatewayWebSocket } from "../../services/gateway.js";
import { devbenchApi } from "./api.js";
import { isLiveStalled } from "./storyRunStatusModel.mjs";
import StoryTab, { GroupPanel } from "./StoryTab.jsx";
import ProjectConfigModal from "./ProjectConfigModal.jsx";
import SharedBackupModal from "./SharedBackupModal.jsx";
import DingtalkMsgConfigModal from "./DingtalkMsgConfigModal.jsx";
import { useIsAdmin } from "../../services/adminAuth.js";
import KeywordMappingModal from "./KeywordMappingModal.jsx";
import StatusMappingModal from "./StatusMappingModal.jsx";
import EnvCheckModal from "./EnvCheckModal.jsx";
import { applyAttachProgressEvent } from "./tbAttachmentDownloadState.js";
import { recoText, isRemoteAiMode, shouldWarnNoAiServer } from "./diaglogic.js";
import SummaryPanel from "./SummaryPanel.jsx";
import TaskPanel from "./TaskPanel.jsx";
import PullLatestModal from "./PullLatestModal.jsx";
import ProjectConflictModal from "./ProjectConflictModal.jsx";
import ConfigSuggestModal from "./ConfigSuggestModal.jsx";
import { replaceConfigSuggestWithRefreshedSession } from "./configInferenceReviewModel.mjs";
import {
  buildGitCommitInferenceTicket,
  nextGitCommitBatchRequest,
  resolveGitCommitInferenceProjectId,
  seedGitCommitInferenceSession,
} from "./gitCommitStoryModel.mjs";
import {
  confirmedConfigInferenceSnapshot,
  configInferenceReopenReviewProof,
  configInferenceSnapshotForReviewResult,
  configInferenceReviewFailurePolicy,
  configInferenceStoryEntryScope,
  createConfigInferencePresentationGuard,
  createConfigInferenceSubmissionGuard,
  createStoryEntryInFlightGuard,
  isDeferredGitCommitStoryEntry,
  isDeferredStoryInitializationEntry,
  isDeferredStoryInitializationPanelEntry,
  isDeferredStoryReopenEntry,
  isDeferredTeamDevStoryEntry,
  isDeferredTaskGroupStoryEntry,
  isDeferredTaskStoryEntry,
  isStoryPointAiInferenceEnabled,
  resolveClosedStoryIdForTask,
  resolveInferenceProjectId,
  reopenReviewedConfigPartialResult,
  resolveStoryInferenceProjectId,
  resolveTaskStoryInferenceTask,
  requiresSavedStoryCreationReview,
  requiresSavedStoryReopenReview,
  shouldDeferStoryEntry,
  shouldContinueDeferredStoryEntry,
  shouldDismissConfigInferenceBeforeReview,
  shouldDismissStoryInitializationSkipBeforeReview,
  shouldSkipReviewedSnapshotForConflict,
  taskStoryCreateEntry,
} from "./storyEntryInferenceModel.mjs";
import {
  repairStoryTitleCarbId,
  taskStoryTitle,
} from "./storyTitleModel.mjs";
import {
  conversationRuntimeActive,
  preserveStoppedLive,
  reconcileConversationLiveMap,
  reconcileRunningTabIds,
  isTabRunning as isTabRunningModel,
} from "./chatStopModel.mjs";
import AiTrainingPanel from "./AiTrainingPanel.jsx";
import ClosedStoryPurgeModal from "./ClosedStoryPurgeModal.jsx";
import NewStoryPanel from "./NewStoryPanel.jsx";
import StoryInitializationPanel from "./StoryInitializationPanel.jsx";
import {
  applyStoryInitializationSharedConfiguration,
  canReuseStoryInitializationIntent,
  createStoryInitializationDraft,
  storyConfigurationSnapshotForEditing,
  storyConfigurationSnapshot,
  storyInitializationConfig,
  storyInitializationInferenceRequest,
  storyInitializationIntentRequestFingerprint,
  storyInitializationRequiresInferenceRefresh,
  mergeRemoteCloneProgress,
  storyWorkspaceInitializationPendingIds,
  storyVehicleSourceConfigForProject,
  shouldDiscardStoryInitializationIntent,
} from "./storyInitializationModel.mjs";
import {
  discoverVehicleSourceProjectRecommendation,
  resolveInitialTbProjectSelection,
} from "./tbProjectSelectionModel.mjs";
import WorktreeRebuildConfirmModal from "./WorktreeRebuildConfirmModal.jsx";
import { isWorktreeRebuildConfirmRequired } from "./worktreeRebuildModel.mjs";
import { buildStoryAttachmentPrompt } from "./storyAttachmentModel.mjs";
import {
  createOptimisticStoryMessage,
  isRetryableFailedStoryMessage,
  settleOptimisticStoryMessage,
} from "./storyMessageSendModel.mjs";

// 路径规范化为比较键（与 otherOccupied 一致）
const normPathKey = (p) => String(p || "").replace(/[\\/]+/g, "/").replace(/\/+$/, "").toLowerCase();
// 从 reopen 冲突里解析"被占用的工程"列表（[{name, owner}]）
function parseOccupiedProjects(conflicts, error) {
  const text = Array.isArray(conflicts) && conflicts.length ? conflicts.join("；") : String(error || "");
  const out = []; const re = /工程「([^」]+)」被故事点「([^」]+)」占用/g; let m;
  while ((m = re.exec(text))) out.push({ name: m[1], owner: m[2] });
  return out;
}
// 从 reopen 冲突里解析"被占用的设备"列表（[{serial, owner}]）
function parseOccupiedDevices(conflicts, error) {
  const text = Array.isArray(conflicts) && conflicts.length ? conflicts.join("；") : String(error || "");
  const out = []; const re = /设备「([^」]+)」被故事点「([^」]+)」占用/g; let m;
  while ((m = re.exec(text))) out.push({ serial: m[1], owner: m[2] });
  return out;
}

function inferenceTaskFromTab(tab) {
  const context = tab?.tbContext || {};
  const tbTaskId = String(tab?.ticketUrl || "").match(/task\/([0-9a-fA-F]{24})/)?.[1] || context.tbTaskId || "";
  return {
    tbTaskId,
    ticketId: context.ticketId || context.carbId || "",
    ticketUrl: tab?.ticketUrl || context.ticketUrl || "",
    title: context.title || tab?.title || "",
    description: context.description || "",
    projectId: context.projectId || "",
    projectName: context.projectName || "",
    tasklistId: context.tasklistId || "",
    tasklistName: context.tasklistName || "",
    iterationName: context.iterationName || context.sprintName || "",
    tags: context.tags || [],
    comments: context.comments || [],
    attachments: context.attachments || [],
    sourceCoverage: context.sourceCoverage || {},
  };
}

const ACTIVE_KEY = "devbench_active_tab";
const TB_PROJECT_KEY = "devbench_current_tb_project";
const TB_PROJECT_EXPLICIT_KEY = "devbench_current_tb_project_explicit";
const WORKSPACE_VIEW_KEY = "devbench_workspace_view";
const AI_SERVER_FALLBACK_INTERVAL_MS = 60_000;
const LIVE_TOOL_OUTPUT_TAIL_MAX = 24000;
const REPOSITORY_PATH_ALERT_CODES = new Set([
  "STORY_BASE_WORKTREE_MISSING",
  "STORY_BASE_WORKTREE_AMBIGUOUS",
  "STORY_WORKTREE_INTEGRITY_INVALID",
  "STORY_BASE_REPOSITORY_PROTECTED",
]);

function appendLiveTail(current, chunk, limit = LIVE_TOOL_OUTPUT_TAIL_MAX) {
  const next = `${current || ""}${chunk || ""}`;
  return next.length > limit ? next.slice(-limit) : next;
}

function storyInitializationDraftIdentity(draft = {}) {
  return `${String(draft.title || "").trim()}\n${String(draft.ticketInput || "").trim()}`;
}

function repositoryPathAlertFromResponse(response) {
  const nested = response?.data && typeof response.data === "object" ? response.data : {};
  const rawAlert = response?.repositoryPathAlert ?? nested.repositoryPathAlert ?? null;
  const code = response?.code || nested.code || (rawAlert && typeof rawAlert === "object" ? rawAlert.code : "");
  if (!REPOSITORY_PATH_ALERT_CODES.has(code)) return null;
  if (rawAlert && typeof rawAlert === "object") return { ...rawAlert, code };
  return {
    code,
    message: typeof rawAlert === "string" ? rawAlert : (response?.error || nested.error || "基础仓库没有安全映射到当前故事点 worktree。"),
  };
}

export default function DevBench() {
  const [tabs, setTabs] = useState([]);
  const [activeId, setActiveId] = useState(() => localStorage.getItem(ACTIVE_KEY) || null);
  const [projects, setProjects] = useState([]);
  const [projectApplications, setProjectApplications] = useState([]);
  const [projectMappingError, setProjectMappingError] = useState("");
  const [msgMap, setMsgMap] = useState({}); // tabId -> messages[]
  const [conversationMap, setConversationMap] = useState({}); // tabId -> { schemaVersion, revision, headId, nodes }
  const [liveMap, setLiveMap] = useState({}); // sessionId -> { thinking, text, tools, toolOutput, streaming, usage }
  const liveMapRef = useRef(liveMap); // 自愈定时器读最新快照，避免 useEffect([]) 闭包陈旧
  liveMapRef.current = liveMap;
  const [toast, setToast] = useState("");
  const [showConfig, setShowConfig] = useState(false);
  const [configInitialTab, setConfigInitialTab] = useState("projects");
  const [showSharedBackup, setShowSharedBackup] = useState(false);
  const [showDingMsg, setShowDingMsg] = useState(false);
  const [showCfgMenu, setShowCfgMenu] = useState(false); // 「配置」合并下拉（车型源码/钉钉消息/关键词映射）
  const cfgMenuButtonRef = useRef(null);
  const [cfgMenuPosition, setCfgMenuPosition] = useState({ top: 0, left: 0 });
  const { isAdmin } = useIsAdmin();
  const [showKeyword, setShowKeyword] = useState(false);
  const [showStatusMap, setShowStatusMap] = useState(false);
  const [showEnvCheck, setShowEnvCheck] = useState(false);
  const [envStatus, setEnvStatus] = useState(null);          // 环境诊断结果(轻量)
  const [tbProjects, setTbProjects] = useState([]);          // 多项目通用化
  const [currentProjectId, setCurrentProjectId] = useState(() => {
    try { return localStorage.getItem(TB_PROJECT_KEY) || ""; } catch { return ""; }
  });
  const currentProjectExplicitRef = useRef(null);
  if (currentProjectExplicitRef.current === null) {
    try { currentProjectExplicitRef.current = localStorage.getItem(TB_PROJECT_EXPLICIT_KEY) === "1"; }
    catch { currentProjectExplicitRef.current = false; }
  }
  const [workspaceView, setWorkspaceView] = useState(() => {
    try { return localStorage.getItem(WORKSPACE_VIEW_KEY) === "ai-training" ? "ai-training" : "stories"; } catch { return "stories"; }
  });
  const [showSummary, setShowSummary] = useState(false);
  const [showTasks, setShowTasks] = useState(false); // 任务列表面板
  const [devices, setDevices] = useState([]);
  const [runningTabs, setRunningTabs] = useState(new Set()); // 正在跑 AI 的故事点（发送→最终回复）
  const [configClip, setConfigClip] = useState(() => { try { return JSON.parse(localStorage.getItem("devbench_config_clip") || "null"); } catch { return null; } }); // 工程配置剪贴板
  const [teamPick, setTeamPick] = useState(null); // 组队开发选择：{ task, sources:{open,closed} }
  const [groupPanelTab, setGroupPanelTab] = useState(null); // 打开故事点组面板（传该组任一成员 tabId）
  const [pullModal, setPullModal] = useState(null); // 甄别前"拉取远程最新"弹窗 { tabId }
  const [projConflict, setProjConflict] = useState(null); // 工程占用冲突弹窗 { task, error, occupied:[{name,owner}], available:[] }
  const [configSuggest, setConfigSuggest] = useState(null); // 开发前配置推断复核 { tabId, session, task, kickAfter }
  const [configSuggestBusy, setConfigSuggestBusy] = useState(false);
  const [configInferenceReviewWarning, setConfigInferenceReviewWarning] = useState(null);
  const [attachConfirm, setAttachConfirm] = useState(null);  // 附件超阈值待确认：{ tabId, items, reasons, count, totalSize }
  const [attachProgress, setAttachProgress] = useState(null); // 批量下载进度：{ tabId, total, files:{name:status}, finished }
  const [copyMap, setCopyMap] = useState({}); // 复制工程进度：{ [tabId]: { phase, copied, total, file } }
  const copyApplyRef = useRef({}); // { [tabId]: { occName, isPrimary, exPath } } —— 复制完成后如何把新路径落到该故事点
  const [showNewMenu, setShowNewMenu] = useState(false); // 新建故事点居中面板
  const [worktreeRebuild, setWorktreeRebuild] = useState(null); // 配置变更需确认删除旧 worktree
  const [copySources, setCopySources] = useState({ open: [], closed: [] }); // 可复制配置的来源
  const [closedStoryPurge, setClosedStoryPurge] = useState(null); // 已关闭故事点永久删除
  const [storyInitialization, setStoryInitialization] = useState(null);
  const [projectDefs, setProjectDefs] = useState([]); // 工程定义（先选工程新建用）
  const [vehicleSourceConfig, setVehicleSourceConfig] = useState(null); // 当前 TB 项目的车型/应用源码映射
  const [vehicleSourceConfigProjectId, setVehicleSourceConfigProjectId] = useState("");
  const [cloneMap, setCloneMap] = useState({}); // 远程拉取克隆进度（按 tabId）{ repos:{key:{percent,status,...}}, status, done }
  const [centerServers, setCenterServers] = useState([]);
  const [centerConfig, setCenterConfig] = useState({ role: "standalone", selectedHost: "", selectedName: "", clientMode: false });
  const [agentMap, setAgentMap] = useState({}); // 分布式执行 agent 进度（按 tabId）{ runId, steps:[], status, result }
  const [gitUpdateMap, setGitUpdateMap] = useState({}); // Git Update 进度（按 tabId）{ status, repoCount, repoIndex, name, stage, detail, pct, summary, conflicts, results }
  const [publishMap, setPublishMap] = useState({}); // 发布生产进度（按 tabId）{ status, step, pct, result, error }
  const [rebaseMap, setRebaseMap] = useState({}); // 提交到主工程进度（按 tabId）{ status, step, result, error }
  const [dingtalkConfirm, setDingtalkConfirm] = useState(null); // 钉钉确认弹窗 { tabId, confirmId, draftMessage, atNames }
  const [buildMap, setBuildMap] = useState({}); // 编译产物进度（按 tabId）{ buildId, status, jobs:[], byProject:{name:{status,lines:[],code,apks}}, results }
  const [buildPanelSelMap, setBuildPanelSelMap] = useState({}); // 编译产物面板选择态（按 tabId 持久化）
  // 服务端 tab 字段是持久事实；此 map 只补齐错误响应到 reloadTabs 完成前/旧服务端未投影字段时的即时反馈。
  const [repositoryPathAlertMap, setRepositoryPathAlertMap] = useState({});
  // OneTab 风格收起：隐藏列表面板开关。隐藏态本身存服务端 tabs.json 的 hidden 字段。
  const [showHiddenList, setShowHiddenList] = useState(false);
  // tab 栏横向滚动容器 + 活动 tab 自动滚入可视区，避免多 tab 时活动 tab 被滚出视口。
  const tabBarScrollRef = useRef(null);

  const wsRef = useRef(null);
  const tabsRef = useRef([]);
  const reloadTabsRequestSeqRef = useRef(0);
  const reloadTabsAppliedSeqRef = useRef(0);
  const workspaceInitializationPollTimerRef = useRef(null);
  const activeIdRef = useRef(activeId);
  const serverRefreshRef = useRef(null);
  const pendingInferenceLoadRef = useRef("");
  const storyPointAiInferenceRef = useRef({ loaded: false, enabled: false });
  const storyInitializationRef = useRef(null);
  const storyInitializationFlowSeqRef = useRef(0);
  const storyEntryGuardRef = useRef(null);
  const configInferencePresentationGuardRef = useRef(null);
  const configInferenceSubmissionGuardRef = useRef(null);
  const storyEntryTokenSeqRef = useRef(0);
  const physicallyDeletedStoryIdsRef = useRef(new Set());
  if (!storyEntryGuardRef.current) storyEntryGuardRef.current = createStoryEntryInFlightGuard();
  if (!configInferencePresentationGuardRef.current) {
    configInferencePresentationGuardRef.current = createConfigInferencePresentationGuard();
  }
  if (!configInferenceSubmissionGuardRef.current) {
    configInferenceSubmissionGuardRef.current = createConfigInferenceSubmissionGuard();
  }
  useEffect(() => { tabsRef.current = tabs; }, [tabs]);
  useEffect(() => { activeIdRef.current = activeId; }, [activeId]);

  // 算力提示：客户端模式下，若没有"有算力"的服务端可连，在故事点上方显示非阻塞横幅
  const [noServer, setNoServer] = useState(null); // null=无需提示 / {servers}

  const updateCfgMenuPosition = useCallback(() => {
    const rect = cfgMenuButtonRef.current?.getBoundingClientRect();
    if (!rect) return;
    const width = 192;
    setCfgMenuPosition({
      top: Math.min(rect.bottom + 6, window.innerHeight - 8),
      left: Math.max(8, Math.min(rect.left, window.innerWidth - width - 8)),
    });
  }, []);

  useEffect(() => {
    if (!showCfgMenu) return undefined;
    updateCfgMenuPosition();
    window.addEventListener("resize", updateCfgMenuPosition);
    window.addEventListener("scroll", updateCfgMenuPosition, true);
    return () => {
      window.removeEventListener("resize", updateCfgMenuPosition);
      window.removeEventListener("scroll", updateCfgMenuPosition, true);
    };
  }, [showCfgMenu, updateCfgMenuPosition]);
  const refreshAiServers = useCallback(() => {
    // focus/online/WS/聊天可能同时触发，合并为同一个在途请求，避免重复查询。
    if (serverRefreshRef.current) return serverRefreshRef.current;
    const request = (async () => {
      try {
        const [cfgR, srvR, infoR] = await Promise.all([
          fetch(getApiUrl("/api/config")).then((r) => r.json()),
          fetch(getApiUrl("/api/discovery/servers")).then((r) => r.json()),
          fetch(getApiUrl("/api/discovery/info")).then((r) => r.json()),
        ]);
        const role = infoR?.data?.role || cfgR?.data?.role || "standalone";
        const effectiveConfig = { ...(cfgR?.data || {}), role };
        const inferenceEnabled = isStoryPointAiInferenceEnabled(cfgR?.data || {});
        storyPointAiInferenceRef.current = { loaded: true, enabled: inferenceEnabled };
        const clientMode = isRemoteAiMode(effectiveConfig);
        const servers = srvR?.data || [];
        const selectedHost = cfgR?.data?.claudeProxyClient?.host || cfgR?.data?.servers?.selectedHost || "";
        const normalizeHost = (h) => String(h || "").replace(/\/+$/, "");
        const selectedServer = servers.find((s) => normalizeHost(s.host) === normalizeHost(selectedHost));
        setCenterServers(servers.filter((s) => s.isServer && s.claudeEnabled));
        setCenterConfig({
          role,
          selectedHost,
          selectedName: selectedServer?.name || "",
          clientMode,
        });
        // 客户端模式 + 没有任何"有算力"的服务端 → 提示
        setNoServer(shouldWarnNoAiServer(effectiveConfig, servers) ? { servers } : null);
        return servers;
      } catch {
        return null;
      } finally {
        if (serverRefreshRef.current === request) serverRefreshRef.current = null;
      }
    })();
    serverRefreshRef.current = request;
    return request;
  }, []);

  const STORY_POINT_AI_INFERENCE_TIMEOUT_MS = 5000;

  function applyAiInferenceEnabled(enabled) {
    storyPointAiInferenceRef.current = { loaded: true, enabled: !!enabled };
  }

  async function resolveStoryPointAiInferenceEnabled() {
    const controller = typeof AbortController !== "undefined" ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), STORY_POINT_AI_INFERENCE_TIMEOUT_MS) : null;
    try {
      const response = await fetch(getApiUrl("/api/config"), {
        cache: "no-store",
        ...(controller ? { signal: controller.signal } : {}),
      });
      if (!response?.ok) throw new Error(`HTTP ${response?.status || "?"}`);
      const result = await response.json();
      if (!result || typeof result !== "object") throw new Error("配置响应格式无效");
      const enabled = isStoryPointAiInferenceEnabled(result?.data || {});
      applyAiInferenceEnabled(enabled);
      return { ok: true, enabled };
    } catch (error) {
      return {
        ok: false,
        enabled: false,
        error: error?.name === "AbortError"
          ? "读取 AI 推理设置超时，请检查 Gateway 后重试"
          : `无法读取 AI 推理设置：${error?.message || "Gateway 不可用"}`,
      };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  useEffect(() => {
    refreshAiServers();
    const t = setInterval(refreshAiServers, AI_SERVER_FALLBACK_INTERVAL_MS);
    // 运行态自愈：WS 未断但任务结束/异常时事件可能丢失，liveMap 残留 streaming=true
    // 会让故事点一直显示「启动中 / AI minimax」。超过阈值无新流事件即视为残留，清理运行标记。
    const liveStallTimer = setInterval(() => {
      const now = Date.now();
      const STALL_MS = 120_000; // 2 分钟无任何 chat_stream 更新视为残留（正常任务持续有思考/文本流）
      setLiveMap((prev) => {
        let changed = false;
        const next = {};
        for (const [sid, live] of Object.entries(prev)) {
          if (isLiveStalled(live, now, STALL_MS)) {
            next[sid] = { ...live, streaming: false, status: "" };
            changed = true;
          } else {
            next[sid] = live;
          }
        }
        return changed ? next : prev;
      });
      // 同步清理 runningTabs 中对应已停滞 tab（isTabRunning = runningTabs.has || liveMap.streaming）
      setRunningTabs((prev) => {
        if (prev.size === 0) return prev;
        const stalled = new Set();
        for (const t of tabsRef.current) {
          const live = liveMapRef.current[t.sessionId];
          if (isLiveStalled(live, now, STALL_MS)) stalled.add(t.id);
        }
        if (stalled.size === 0) return prev;
        const next = new Set(prev);
        for (const id of stalled) next.delete(id);
        return next;
      });
    }, 30_000);
    const refreshWhenVisible = () => {
      if (document.visibilityState === "visible") refreshAiServers();
    };
    window.addEventListener("focus", refreshAiServers);
    window.addEventListener("online", refreshAiServers);
    document.addEventListener("visibilitychange", refreshWhenVisible);
    return () => {
      clearInterval(t);
      clearInterval(liveStallTimer);
      window.removeEventListener("focus", refreshAiServers);
      window.removeEventListener("online", refreshAiServers);
      document.removeEventListener("visibilitychange", refreshWhenVisible);
    };
  }, [refreshAiServers]);

  // 多项目：加载 TB 项目列表，默认选第一个；同时加载仓库定义(环境诊断的仓库权限用)
  useEffect(() => {
    let cancelled = false;
    devbenchApi.getTbProjects().then(async (r) => {
      if (r.ok) {
        const list = r.data || [];
        let recommendedVehicleSourceProjectId = r.meta?.recommendedVehicleSourceProjectId || "";
        if (r.meta?.vehicleSourceRecommendationStatus !== "available") {
          recommendedVehicleSourceProjectId = await discoverVehicleSourceProjectRecommendation(
            list,
            (projectId) => devbenchApi.getRemoteConfig(projectId),
          );
        }
        if (cancelled) return;
        setTbProjects(list);
        setCurrentProjectId((prev) => {
          const resolved = resolveInitialTbProjectSelection({
            projects: list,
            previousProjectId: prev,
            recommendedVehicleSourceProjectId,
            explicitlySelected: currentProjectExplicitRef.current === true,
          });
          const next = resolved.projectId;
          currentProjectExplicitRef.current = resolved.explicitlySelected;
          try {
            if (next) localStorage.setItem(TB_PROJECT_KEY, next);
            else localStorage.removeItem(TB_PROJECT_KEY);
            if (resolved.explicitlySelected) localStorage.setItem(TB_PROJECT_EXPLICIT_KEY, "1");
            else localStorage.removeItem(TB_PROJECT_EXPLICIT_KEY);
          } catch {}
          return next;
        });
      }
    });
    devbenchApi.getProjectDefs().then((d) => { if (d.ok) setProjectDefs(d.data || []); });
    return () => { cancelled = true; };
  }, []);

  function selectTbProject(id) {
    // 新项目请求返回前先让旧车型配置失效，禁止初始化面板把 A 项目的 state 当作 B 项目缓存。
    setVehicleSourceConfig(null);
    setVehicleSourceConfigProjectId("");
    setCurrentProjectId(id);
    currentProjectExplicitRef.current = !!id;
    try {
      if (id) {
        localStorage.setItem(TB_PROJECT_KEY, id);
        localStorage.setItem(TB_PROJECT_EXPLICIT_KEY, "1");
      } else {
        localStorage.removeItem(TB_PROJECT_KEY);
        localStorage.removeItem(TB_PROJECT_EXPLICIT_KEY);
      }
    } catch {}
  }

  useEffect(() => {
    let cancelled = false;
    setVehicleSourceConfig(null);
    setVehicleSourceConfigProjectId("");
    if (!currentProjectId) {
      return undefined;
    }
    devbenchApi.getRemoteConfig(currentProjectId).then((result) => {
      if (cancelled) return;
      setVehicleSourceConfig(result.ok ? (result.data || null) : null);
      setVehicleSourceConfigProjectId(result.ok ? currentProjectId : "");
    });
    return () => { cancelled = true; };
  }, [currentProjectId]);

  function selectWorkspaceView(view) {
    setWorkspaceView(view);
    try { localStorage.setItem(WORKSPACE_VIEW_KEY, view); } catch {}
  }

  function showToast(msg) {
    setToast(msg);
    setTimeout(() => setToast(""), 3500);
  }

  function beginStoryEntry(kind) {
    const token = `${kind}:${Date.now()}:${storyEntryTokenSeqRef.current += 1}`;
    if (!storyEntryGuardRef.current.acquire(token)) {
      showToast("故事点入口正在处理中，请勿重复点击");
      return "";
    }
    return token;
  }

  function finishStoryEntry(token) {
    if (token) storyEntryGuardRef.current.release(token);
  }

  // sessionId -> tabId
  const sidToTab = useCallback((sid) => {
    const t = tabsRef.current.find((x) => x.sessionId === sid);
    return t ? t.id : null;
  }, []);

  // ---------- 初始加载 ----------
  async function reloadTabs() {
    const requestId = ++reloadTabsRequestSeqRef.current;
    const r = await devbenchApi.listTabs();
    if (r.ok) {
      const list = r.data || [];
      if (requestId < reloadTabsAppliedSeqRef.current) return list;
      reloadTabsAppliedSeqRef.current = requestId;
      tabsRef.current = list;
      setTabs(list);
      return list;
    }
    return [];
  }

  async function waitForStoryWorkspaceReady(tabId, { timeoutMs = 10 * 60_000 } = {}) {
    const deadline = Date.now() + timeoutMs;
    let latest = null;
    while (Date.now() <= deadline) {
      const rows = await reloadTabs();
      latest = rows.find((item) => item.id === tabId) || null;
      if (!latest) {
        return { ok: false, error: "故事点已创建，但刷新后未找到对应工作区" };
      }
      const initialization = latest.workspaceInitialization;
      const failed = initialization?.status === "error" || latest.cloneStatus === "error" || latest.worktreeStatus === "error";
      if (failed) {
        return {
          ok: false,
          error: initialization?.error || latest.cloneError || latest.worktreeError || "故事点工作区后台初始化失败",
        };
      }
      const pending = storyWorkspaceInitializationPendingIds([latest]).length > 0;
      if (!pending) return { ok: true, tab: latest };
      await new Promise((resolve) => setTimeout(resolve, 900));
    }
    return { ok: false, error: "故事点工作区仍在后台初始化，请稍后从页面继续操作" };
  }
  async function reloadProjects() {
    const [projectResult, applicationResult] = await Promise.all([
      devbenchApi.listProjects(),
      devbenchApi.getProjectApplications(),
    ]);
    if (projectResult.ok) {
      setProjects(projectResult.data || []);
      if (applicationResult.ok) {
        setProjectApplications(applicationResult.data || []);
        setProjectMappingError("");
        return { ok: true, data: projectResult.data || [] };
      }
      setProjectMappingError(applicationResult.error || "应用与仓库关系读取失败");
      return { ok: false, error: applicationResult.error || "应用与仓库关系读取失败" };
    }
    setProjectMappingError(projectResult.error || "本机工程列表读取失败");
    return { ok: false, error: projectResult.error || "本机工程列表读取失败" };
  }

  useEffect(() => {
    (async () => {
      const [, list] = await Promise.all([reloadProjects(), reloadTabs()]);
      if (list.length && !list.find((t) => t.id === activeId)) {
        setActive(list[0].id);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---------- WebSocket（单连接，订阅所有 tab）----------
  useEffect(() => {
    let disposed = false;
    function connect() {
      if (disposed) return;
      // 必须通过 createGatewayWebSocket 连接：服务端 handleProtocols 要求
      // aiefficiency.v1 子协议，且鉴权闸门要求 aiefficiency.auth.<token>。
      // 直接 new WebSocket(getWsUrl()) 不带子协议会被握手阶段拒绝，导致
      // chat_stream 等流式事件无法到达前端，故事点对话框不显示实时回答。
      const ws = createGatewayWebSocket();
      wsRef.current = ws;
      ws.onopen = () => {
        if (disposed) { try { ws.close(); } catch {} return; }
        // WS 重连通常意味着网关或网络刚恢复，立即校准一次服务端状态。
        refreshAiServers();
        for (const t of tabsRef.current) {
          ws.send(JSON.stringify({ type: "subscribe_session", sessionId: t.sessionId }));
        }
        // WS 断线/重连自愈：断线期间任务结束或事件丢失（chat_stream_end/chat_message 未送达）
        // 会让 runningTabs / liveMap 残留，故事点一直显示「启动中 / AI minimax」且不刷新。
        // 清空运行标记后，仍活跃的任务会由后续 chat_stream 事件重建（onmessage 中 streaming=true 时重新加入 runningTabs）。
        setRunningTabs(new Set());
        setLiveMap((prev) => {
          const next = {};
          for (const [sid, live] of Object.entries(prev)) {
            next[sid] = { ...live, streaming: false, status: "" };
          }
          return next;
        });
      };
      ws.onmessage = (e) => {
        let msg;
        try { msg = JSON.parse(e.data); } catch { return; }
        const d = msg.data || {};

        if (msg.type === "discovery_servers_changed") {
          // 网关已监听局域网 UDP 广播；仅在服务列表/算力变化时推送本事件。
          refreshAiServers();
        } else if (msg.type === "chat_stream") {
          const sid = d.sessionId;
          if (!sid) return;
          const dt = d.deltaType || "text";
          setLiveMap((prev) => {
            const now = Date.now();
            const cur = prev[sid] || { status: "", thinking: "", text: "", tools: [], toolOutput: "", streaming: true, startedAt: d.startedAt || d.started_at || now };
            const chunk = d.chunk == null ? "" : String(d.chunk);
            const next = {
              ...cur,
              streaming: true,
              engine: d.engine || cur.engine,
              aiSnapshot: d.aiSnapshot || cur.aiSnapshot || null,
              usage: d.usage || cur.usage || null,
              startedAt: cur.startedAt || d.startedAt || d.started_at || now,
              updatedAt: now,
              heartbeatAt: now,
            };
            if (dt === "status") next.status = chunk.trim();
            else if (dt === "thinking") { next.status = ""; next.thinking = cur.thinking + chunk; }
            else if (dt === "tool_use") { next.status = ""; next.tools = [...cur.tools, chunk]; }
            else if (dt === "tool_output") { next.status = ""; next.toolOutput = appendLiveTail(cur.toolOutput, chunk); }
            else if (dt !== "usage") { next.status = ""; next.text = cur.text + chunk; }
            return { ...prev, [sid]: next };
          });
        } else if (msg.type === "devbench_ai_progress_state") {
          const sid = d.sessionId;
          if (!sid) return;
          const progressState = String(d.state || "active");
          const terminal = progressState === "terminated" || progressState === "termination_unconfirmed";
          setLiveMap((prev) => {
            const now = Date.now();
            const cur = prev[sid] || { status: "", thinking: "", text: "", tools: [], toolOutput: "", startedAt: d.executionStartedAt || now };
            return {
              ...prev,
              [sid]: {
                ...cur,
                progressState,
                progressSequence: d.progressSequence ?? cur.progressSequence ?? 0,
                lastMeaningfulProgressAt: d.lastMeaningfulProgressAt || cur.lastMeaningfulProgressAt || cur.startedAt || now,
                executionStartedAt: d.executionStartedAt || cur.executionStartedAt || cur.startedAt || now,
                warningAt: d.warningAt || cur.warningAt || null,
                timeoutKind: d.timeoutKind || cur.timeoutKind || null,
                terminationVerified: d.terminationVerified ?? cur.terminationVerified,
                terminationVerifiedAt: d.terminationVerifiedAt || cur.terminationVerifiedAt || null,
                streaming: !terminal,
                updatedAt: now,
                heartbeatAt: now,
              },
            };
          });
          const tabId = sidToTab(sid);
          if (tabId) {
            setRunningTabs((current) => {
              const next = new Set(current);
              if (terminal) next.delete(tabId);
              else next.add(tabId);
              return next;
            });
          }
        } else if (msg.type === "chat_stream_end") {
          const sid = d.sessionId;
          if (!sid) return;
          setLiveMap((prev) => {
            const now = Date.now();
            const cur = prev[sid] || { thinking: "", text: "", tools: [], toolOutput: "" };
            const startedAt = cur.startedAt || d.startedAt || d.started_at || now;
            const endedAt = d.endedAt || d.ended_at || now;
            const durationMs = d.durationMs != null ? d.durationMs : Math.max(0, endedAt - startedAt);
            return { ...prev, [sid]: { ...cur, streaming: false, engine: d.engine || cur.engine, aiSnapshot: d.aiSnapshot || cur.aiSnapshot || null, usage: d.usage || cur.usage || null, startedAt, endedAt, durationMs, updatedAt: now, heartbeatAt: now } };
          });
          // 最终 chat_message 偶尔会在 WS 切换时丢失；流结束后再向服务端核对一次，
          // 让已落盘但漏事件的任务退出“实时追加”，同时保留短暂的“收尾中”。
          // 同步清理 runningTabs：流结束即代表该 tab 退出运行态，避免「已停止但按钮仍 disabled」残留。
          const tabId = sidToTab(sid);
          if (tabId) {
            setRunningTabs((s) => { const n = new Set(s); n.delete(tabId); return n; });
            window.setTimeout(() => { if (!disposed) void loadMessages(tabId); }, 500);
          }
        } else if (msg.type === "devbench_comm_log") {
          const sid = d.sessionId;
          if (!sid || !d.entry) return;
          setLiveMap((prev) => {
            const cur = prev[sid] || { thinking: "", text: "", tools: [], toolOutput: "", streaming: true };
            const logs = Array.isArray(cur.commLogs) ? cur.commLogs : [];
            const keyOf = (x) => `${x?.ts || ""}|${x?.phase || ""}|${x?.message || ""}`;
            const nextLogs = logs.some((x) => keyOf(x) === keyOf(d.entry)) ? logs : [...logs, d.entry].slice(-80);
            const now = Date.now();
            return { ...prev, [sid]: { ...cur, center: d.center || cur.center || null, commLogs: nextLogs, updatedAt: now, heartbeatAt: now } };
          });
        } else if (msg.type === "chat_message") {
          const sid = d.session_id;
          const tabId = sidToTab(sid);
          if (!tabId || d.role !== "assistant") return;
          // 最终回复到达 → 该故事点不再运行
          setRunningTabs((s) => { const n = new Set(s); n.delete(tabId); return n; });
          // 追加最终消息，清空 live 缓冲
          setMsgMap((prev) => {
            const list = prev[tabId] || [];
            return { ...prev, [tabId]: [...list, {
              id: d.id || d.messageId || d.nodeId || undefined,
              parentId: d.parentId || d.parent_id || null,
              branchGroupId: d.branchGroupId || d.branch_group_id || null,
              role: "assistant", content: d.content, transcript: d.transcript || [],
              usage: d.usage || null, error: d.error || false, stopped: d.stopped || false, turn: d.turn,
              startedAt: d.startedAt || d.started_at || null,
              endedAt: d.endedAt || d.ended_at || null,
              durationMs: d.durationMs ?? null,
              created_at: d.created_at || null,
              workflow: d.workflow || null, engine: d.engine || null,
              aiSnapshot: d.aiSnapshot || null,
              center: d.center || null, commLogs: d.commLogs || [],
            }] };
          });
          setLiveMap((prev) => {
            const n = { ...prev };
            delete n[sid];
            return n;
          });
          // 图会话由服务端持久化；最终回答到达后重新取活动路径，避免把回答挂到已切换的旧分支。
          void loadMessages(tabId);
          // 刷新 tab（标题可能自动更新、cliSession 落定）
          reloadTabs();
        } else if (msg.type === "devbench_code_review_updated") {
          // 代码评审正文结束后还会异步生成 PDF/PNG；状态和产物以该事件为准。
          reloadTabs();
        } else if (msg.type === "devbench_queue_updated") {
          // 排队消息是服务端持久状态；多窗口/网关恢复出队时都以服务端为准。
          reloadTabs();
        } else if (msg.type === "devbench_repository_path_alert") {
          // 排队消息真正出队时会按最新 worktree 再解析；若配置已变化导致映射失效，
          // 通过持久 tab 告警立即刷新聊天输入区，不能只留在 Gateway 日志里。
          reloadTabs();
        } else if (msg.type === "devbench_device_state_changed") {
          // 设备占用、排队和租约切换以服务端协调器为准，所有窗口都立即刷新投影。
          void refreshDevices();
          void reloadTabs();
        } else if (msg.type === "devbench_group_advance") {
          reloadTabs().then(() => {
            if (d.toTabId && (!d.fromTabId || activeIdRef.current === d.fromTabId)) {
              setActive(d.toTabId);
              if (!d.complete) showToast("已切换到组内下一个故事点");
            }
          });
        } else if (msg.type === "devbench_config_inference_required") {
          if (!d.tabId || !d.session) return;
          const runId = String(d.session?.id || "");
          if (!configInferencePresentationGuardRef.current.shouldPresent({
            storyEntryInFlight: !!storyEntryGuardRef.current.current(),
            runId,
          })) return;
          reloadTabs().then(() => {
            if (!configInferencePresentationGuardRef.current.shouldPresent({
              storyEntryInFlight: !!storyEntryGuardRef.current.current(),
              runId,
            })) return;
            setActive(d.tabId);
            setConfigSuggest((current) => (
              configInferencePresentationGuardRef.current.shouldPresent({
                currentSuggest: current,
                storyEntryInFlight: !!storyEntryGuardRef.current.current(),
                runId,
              }) ? {
                  tabId: d.tabId,
                  session: d.session,
                  task: d.task || null,
                  projectId: d.projectId || d.task?.projectId || "",
                  continueAction: "group_auto",
                } : current
            ));
            showToast("组内下一个故事点需先确认工程配置");
          });
        } else if (msg.type === "devbench_group_sync") {
          reloadTabs();
          showToast(d.failed ? `故事点组 TB 同步完成：${d.total - d.failed}/${d.total}` : "故事点组 TB 已全部同步");
        } else if (msg.type === "devbench_clone_progress") {
          const { tabId } = d;
          if (!tabId) return;
          setCloneMap((prev) => {
            const next = mergeRemoteCloneProgress(prev[tabId], d);
            return { ...prev, [tabId]: next };
          });
          if (d.repo === "__all__" && d.done) {
            Promise.all([reloadTabs(), reloadProjects()]);
            setCloneMap((prev) => {
              const next = { ...prev };
              if (next[tabId]?.status === "done") delete next[tabId];
              return next;
            });
          }
        } else if (msg.type === "devbench_story_initialization_progress") {
          if (!d.tabId) return;
          void reloadTabs();
          if (d.done && d.status === "ready") {
            showToast("故事点工作区后台初始化完成，可以开始开发");
          } else if (d.done && d.status === "error") {
            showToast(d.error || "故事点工作区后台初始化失败，可在故事点页面重试");
          }
        } else if (msg.type === "devbench_agent_step") {
          const { tabId, runId, phase } = d;
          if (!tabId) return;
          setAgentMap((prev) => {
            const cur = prev[tabId] || { runId, steps: [], status: "running" };
            const next = { ...cur, runId: runId || cur.runId };
            if (phase === "end") { next.status = "done"; next.result = d.result || null; }
            else next.steps = [...cur.steps, { phase, round: d.round, action: d.action, step: d.step }];
            return { ...prev, [tabId]: next };
          });
        } else if (msg.type === "devbench_attach_progress") {
          // 单附件下载（流式）：把带 attachmentKey 的事件落到模块级进度缓存，
          // 让"TB 单附件"弹窗关闭/重挂载都能拿到真实百分比。
          // 批量路径不携带 attachmentKey，这里 no-op，不影响既有 UI。
          if (d.attachmentKey) applyAttachProgressEvent(d);
          // 附件下载：need_confirm 为旧版事件，后端现为附件较多/较大不阻塞（不再 emit）。
          // 防御性兼容：收到时仅做非阻塞提示，不弹确认窗，避免把流程卡住。
          if (d.phase === "need_confirm") {
            showToast("附件较多/较大未自动下载，需要阅读时可在 TB 附件清单里逐一下载");
          } else if (d.phase === "file") {
            setAttachProgress((p) => {
              const base = p && p.tabId === d.tabId ? p : { tabId: d.tabId, total: d.total, files: {} };
              return { ...base, total: d.total, finished: false, files: { ...base.files, [d.name]: d.status } };
            });
          } else if (d.phase === "end") {
            setAttachProgress((p) => (p && p.tabId === d.tabId ? { ...p, done: d.done, finished: true } : p));
            // 静默刷新当前 tab 的 TB 附件共享缓存，让 "TB 单附件" / 行内列表同步显示已下载，
            // 避免用户看到上一份清单而误以为没下载完。失败也不抛错 toast。
            if (d.tabId && typeof window !== "undefined") {
              const ev = new CustomEvent("devbench:tb-attachments-invalidated", { detail: { tabId: d.tabId } });
              window.dispatchEvent(ev);
            }
            reloadTabs();
          }
        } else if (msg.type === "devbench_copy_progress") {
          // 复制工程进度：counting/copying 更新进度条；done 把新路径落到故事点 + 解锁；error 提示 + 解锁
          const tabId = d.tabId; if (!tabId) return;
          if (d.phase === "done") {
            setCopyMap((m) => { const n = { ...m }; delete n[tabId]; return n; });
            applyCopiedProject(tabId, d.path, d.name);
          } else if (d.phase === "error") {
            setCopyMap((m) => { const n = { ...m }; delete n[tabId]; return n; });
            delete copyApplyRef.current[tabId];
            showToast(d.error || "复制工程失败");
            reloadTabs();
          } else {
            setCopyMap((m) => ({ ...m, [tabId]: { phase: d.phase, copied: d.copied || 0, total: d.total || 0, file: d.file || "" } }));
          }
        } else if (msg.type === "devbench_git_update") {
          // Android Studio 风格 Git Update：按阶段实时更新底部进度条；end 时定状态、冲突保留、完成自动消失
          const tabId = d.tabId; if (!tabId) return;
          if (d.phase === "start") {
            setGitUpdateMap((m) => ({ ...m, [tabId]: { status: "running", repoCount: d.repoCount || 1, repoIndex: 0, pct: 0, results: [] } }));
          } else if (d.phase === "repo_start") {
            setGitUpdateMap((m) => ({ ...m, [tabId]: { ...(m[tabId] || {}), status: "running", repoCount: d.repoCount, repoIndex: d.repoIndex, name: d.name, role: d.role, stage: null, detail: null, pct: 0 } }));
          } else if (d.phase === "progress") {
            setGitUpdateMap((m) => ({ ...m, [tabId]: { ...(m[tabId] || {}), status: "running", repoCount: d.repoCount, repoIndex: d.repoIndex, name: d.name, role: d.role, stage: d.stage, detail: d.detail, pct: d.pct || 0 } }));
          } else if (d.phase === "repo_done") {
            setGitUpdateMap((m) => {
              const current = m[tabId] || {};
              const results = [...(current.results || [])];
              results[d.repoIndex] = d.result;
              return { ...m, [tabId]: { ...current, status: "running", results } };
            });
          } else if (d.phase === "end") {
            const results = Array.isArray(d.results) ? d.results : [];
            const conflicts = results.filter((x) => x.conflict).map((x) => ({ ...x, path: x.worktreePath || x.path }));
            const status = d.hasConflict ? "conflict" : (d.summary && d.summary.failed ? "failed" : "done");
            setGitUpdateMap((m) => ({ ...m, [tabId]: { ...(m[tabId] || {}), status, summary: d.summary, conflicts, results, aiResolution: d.aiResolution || null } }));
            reloadTabs();
          }
        } else if (msg.type === "devbench_publish") {
          // 发布生产进度（按 tabId）：start/step/copy(带pct)/end，居中悬浮进度窗
          // awaitingDingtalk: 产物已就绪，等待用户确认钉钉消息再发送
          const tabId = d.tabId; if (!tabId) return;
          if (d.phase === "end") {
            if (d.awaitingDingtalk) {
              // 产物已就绪 → 弹出钉钉消息确认窗，等用户编辑/确认后真正发送
              setPublishMap((m) => ({ ...m, [tabId]: { status: "done", step: "产物已就绪，等待确认钉钉消息…", result: d.result || null } }));
              setDingtalkConfirm({ tabId, confirmId: d.confirmId, draftMessage: d.draftMessage || "", atNames: d.atNames || [] });
            } else if (d.needShareLogin) {
              setPublishMap((m) => ({
                ...m,
                [tabId]: {
                  ...(m[tabId] || {}),
                  status: "need_share_login",
                  phase: "share_login",
                  step: "需要登录生产发布共享目录",
                  shareRoot: d.shareRoot || m[tabId]?.shareRoot || "",
                  prodDir: d.prodDir || m[tabId]?.prodDir || "",
                  retryId: d.retryId || m[tabId]?.retryId || "",
                  error: d.error || null,
                  shareError: null,
                  pct: null,
                },
              }));
              showToast("需要登录生产发布共享目录");
            } else {
              setPublishMap((m) => ({ ...m, [tabId]: { status: d.ok ? "done" : "error", step: d.ok ? "完成" : (d.error || "出错"), result: d.result || null, error: d.error || null } }));
              if (d.ok) showToast(`已发布生产：${d.result?.appName || ""} ${d.result?.version || ""}（${d.result?.dingtalk || ""}）`);
              else showToast(d.error || "发布生产失败");
              // 成功 6s 后自动收起；失败保留让用户看
              if (d.ok) setTimeout(() => setPublishMap((m) => { if (m[tabId]?.status !== "done") return m; const n = { ...m }; delete n[tabId]; return n; }), 6000);
            }
          } else if (d.phase === "await_resign") {
            setPublishMap((m) => ({
              ...m,
              [tabId]: {
                ...(m[tabId] || {}),
                status: "await_resign",
                phase: d.phase,
                step: d.step || "等待上传二次签名后的 APK…",
                resignId: d.resignId,
                apkDir: d.apkDir,
                unsignedApk: d.unsignedApk,
                expectedFingerprint: d.expectedFingerprint,
                uploadError: d.uploadError || null,
                prodDir: d.prodDir,
                result: d.result || m[tabId]?.result || null,
              },
            }));
          } else if (d.phase === "dingtalk_result") {
            // 钉钉发送结果（确认弹窗后的终态）
            setDingtalkConfirm(null);
            setPublishMap((m) => {
              const cur = m[tabId] || {};
              const prevResult = cur.result || {};
              return { ...m, [tabId]: { status: d.ok ? "done" : "error", step: d.ok ? "钉钉已通知" : `钉钉通知失败: ${d.dingErr || ""}`, result: { ...prevResult, dingtalk: d.dingNote || (d.ok ? "已通知" : "通知失败") }, error: d.ok ? null : (d.dingErr || null) } };
            });
            if (d.ok) showToast(`钉钉已通知：${d.dingNote || ""}`);
            else showToast(`钉钉通知失败: ${d.dingErr || ""}`);
            setTimeout(() => setPublishMap((m) => { if (m[tabId]?.status !== "done" && m[tabId]?.status !== "error") return m; const n = { ...m }; delete n[tabId]; return n; }), 8000);
          } else {
            setPublishMap((m) => ({ ...m, [tabId]: { ...(m[tabId] || {}), status: "running", phase: d.phase, step: d.step || "", pct: d.phase === "copy" ? (d.pct || 0) : (m[tabId]?.pct ?? null), prodDir: d.prodDir || m[tabId]?.prodDir } }));
          }
        } else if (msg.type === "devbench_build") {
          // 编译产物：每个工程独立一份打包状态（按工程名 key），支持不同工程并发打包，互不覆盖
          const tabId = d.tabId; if (!tabId) return;
          setBuildMap((m) => {
            const cur = m[tabId] || { byProject: {} };
            const bp = { ...cur.byProject };
            if (d.phase === "start") {
              // 本次 build 涉及的工程：置 running 并（新 buildId）清空旧日志
              for (const j of (d.jobs || [])) {
                const old = bp[j.name];
                bp[j.name] = { ...(old || {}), buildId: d.buildId, status: "running", tasks: j.tasks, path: j.path, code: null, apks: [], lines: old?.buildId === d.buildId ? (old.lines || []) : [] };
              }
            } else if (d.phase === "project_start") {
              const old = bp[d.project];
              bp[d.project] = { ...(old || {}), buildId: d.buildId, status: "running", tasks: d.tasks || [], path: d.path, code: null, apks: [], lines: old?.buildId === d.buildId ? (old.lines || []) : [] };
            } else if (d.phase === "log") {
              const p = bp[d.project] || { buildId: d.buildId, status: "running", lines: [], code: null, apks: [] };
              bp[d.project] = { ...p, lines: [...(p.lines || []), { stream: d.stream, line: d.line }].slice(-4000) };
            } else if (d.phase === "project_end") {
              const p = bp[d.project] || { lines: [] };
              bp[d.project] = { ...p, buildId: d.buildId, status: d.ok ? "ok" : (d.canceled ? "canceled" : "failed"), code: d.code, apks: d.apks || [] };
            } else if (d.phase === "end") {
              // 兜底：本次 build 里没收到 project_end 的工程（如未找到 gradlew）按 results 定状态
              for (const r of (d.results || [])) {
                const p = bp[r.name];
                if (!p || p.buildId !== d.buildId) continue;
                if (p.status === "running" || p.status === "starting") bp[r.name] = { ...p, status: r.ok ? "ok" : (r.canceled ? "canceled" : "failed"), code: r.code, apks: r.apks || p.apks };
              }
            }
            return { ...m, [tabId]: { ...cur, byProject: bp } };
          });
        }
      };
      ws.onclose = () => { if (!disposed) setTimeout(connect, 2000); };
      ws.onerror = () => { try { ws.close(); } catch {} };
    }
    connect();
    return () => { disposed = true; try { wsRef.current?.close(); } catch {} };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // tabs 变化时，补订阅新 tab；activeId 切换时也强制订阅当前故事点，
  // 避免 WS 就绪时序与 tabs 刷新竞态导致当前故事点漏订阅（漏订阅会被服务端
  // 会话过滤，chat_stream/chat_message 均收不到 → 实时信息不显示）。
  useEffect(() => {
    const ws = wsRef.current;
    if (ws && ws.readyState === 1) {
      const targets = new Set(tabs.map((t) => t.sessionId));
      if (activeId) {
        const activeTab = tabs.find((t) => t.id === activeId) || tabsRef.current.find((t) => t.id === activeId);
        if (activeTab?.sessionId) targets.add(activeTab.sessionId);
      }
      for (const sessionId of targets) {
        if (sessionId) ws.send(JSON.stringify({ type: "subscribe_session", sessionId }));
      }
    }
  }, [tabs, activeId]);

  const pendingWorkspaceInitializationIds = storyWorkspaceInitializationPendingIds(tabs);
  const pendingWorkspaceInitializationKey = pendingWorkspaceInitializationIds.join("|");
  useEffect(() => {
    if (!pendingWorkspaceInitializationIds.length) return undefined;
    let disposed = false;
    const poll = async () => {
      try {
        await reloadTabs();
      } finally {
        if (!disposed) {
          workspaceInitializationPollTimerRef.current = setTimeout(poll, 1000);
        }
      }
    };
    workspaceInitializationPollTimerRef.current = setTimeout(poll, 1000);
    return () => {
      disposed = true;
      if (workspaceInitializationPollTimerRef.current) {
        clearTimeout(workspaceInitializationPollTimerRef.current);
        workspaceInitializationPollTimerRef.current = null;
      }
    };
    // WebSocket 是实时优化路径；轮询以持久化 Tab 为准，确保断线或漏事件后也能从 preparing 收敛到 ready/error。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingWorkspaceInitializationKey]);

  // WS 断线或页面刷新后，从 tab 上持久化的 pending run 恢复组内配置复核，不能因漏掉事件绕过门禁。
  useEffect(() => {
    const tab = tabs.find((item) => item.id === activeId);
    const runId = String(tab?.workflow?.configInferencePendingRunId || "");
    if (!tab || pendingInferenceLoadRef.current === runId) return undefined;
    if (!configInferencePresentationGuardRef.current.shouldPresent({
      currentSuggest: configSuggest,
      storyEntryInFlight: !!storyEntryGuardRef.current.current(),
      runId,
    })) return undefined;
    pendingInferenceLoadRef.current = runId;
    const projectId = tab.tbContext?.projectId || currentProjectId || "";
    devbenchApi.getConfigInference(projectId).then((result) => {
      // currentProjectId 等依赖在请求期间变化时，React 会重跑 effect。不能把仍然有效的
      // 同一请求标为 cancelled 后又用 pending ref 阻止新 effect，否则该 run 永远无法恢复。
      // 响应到达时改用最新 tab/active 状态核对，只有仍是当前 pending 才消费结果。
      const latestTab = tabsRef.current.find((item) => item.id === tab.id);
      if (activeIdRef.current !== tab.id
        || String(latestTab?.workflow?.configInferencePendingRunId || "") !== runId
        || !result?.ok) return;
      const run = (result.data?.runs || []).find((item) => item.id === runId && !item.review);
      if (!run) return;
      setConfigSuggest((current) => (
        configInferencePresentationGuardRef.current.shouldPresent({
          currentSuggest: current,
          storyEntryInFlight: !!storyEntryGuardRef.current.current(),
          runId,
        }) ? {
            tabId: tab.id,
            session: { ...run, options: result.data?.options || result.data?.registry?.options || {} },
            task: inferenceTaskFromTab(tab),
            projectId,
            continueAction: "group_auto",
          } : current
      ));
    }).finally(() => {
      if (pendingInferenceLoadRef.current === runId) pendingInferenceLoadRef.current = "";
    });
    return undefined;
  }, [activeId, tabs, configSuggest, currentProjectId]);

  // ---------- tab 操作 ----------
  function setActive(id) {
    setActiveId(id);
    if (id) localStorage.setItem(ACTIVE_KEY, id);
    if (id && msgMap[id] === undefined) loadMessages(id);
  }

  async function loadMessages(tabId) {
    // 备份还原补充：worktree 已 provision（entries 有实际路径）且仍有待替换的旧分支/目录引用时，
    // 先把聊天记录中的旧分支名/旧 worktree 目录更新为目标故事点当前值，再读取展示。
    const currentTab = (tabsRef.current || []).find((item) => String(item?.id) === String(tabId));
    const pendingRefRemap = currentTab?.backupLegacyRefs;
    const worktreeReady = Array.isArray(currentTab?.worktree?.entries)
      && currentTab.worktree.entries.some((entry) => entry && (entry.worktreePath || entry.path));
    if (pendingRefRemap && worktreeReady) {
      try {
        await devbenchApi.applyBackupRefRemap(tabId);
      } catch { /* 替换失败不阻塞读取 */ }
    }
    let r = await devbenchApi.getConversation(tabId);
    // 前后端滚动重启期间兼容尚未提供 conversation 接口的旧网关，至少保证历史消息仍可见。
    if (!r.ok) {
      const legacy = await devbenchApi.getMessages(tabId);
      if (!legacy.ok) return;
      r = { ok: true, data: { messages: legacy.data || [], live: null } };
    }
    const messages = r.data?.messages || [];
    const live = r.data?.live || null;
    const runtimeActive = typeof r.data?.runtime?.active === "boolean"
      ? r.data.runtime.active
      : null;
    setMsgMap((prev) => ({ ...prev, [tabId]: messages }));
    setConversationMap((prev) => ({ ...prev, [tabId]: r.data?.conversation || null }));

    // AI 的流式内容由服务端草稿恢复；若刷新期间已收到更新的 WS chunk，保留较新的内存版本。
    const tab = tabsRef.current.find((t) => t.id === tabId);
    const sessionId = live?.sessionId || tab?.sessionId;
    if (sessionId) {
      setLiveMap((prev) => reconcileConversationLiveMap(prev, sessionId, live, runtimeActive));
    }
    const runtimeSignal = conversationRuntimeActive(runtimeActive, live);
    setRunningTabs((prev) => reconcileRunningTabIds(prev, tabId, runtimeSignal));
  }

  useEffect(() => {
    if (activeId && msgMap[activeId] === undefined) loadMessages(activeId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId]);

  // 已存在标题集合（进行中 + 已关闭），用于唯一校验
  const existingTitles = () => new Set([...tabs.map((t) => (t.title || "").trim()), ...((copySources.closed || []).map((c) => (c.title || "").trim()))].filter(Boolean));
  function uniqueTitleAgainst(base, occupied = existingTitles()) {
    const stableBase = String(base || "故事点").trim() || "故事点";
    let title = stableBase;
    let suffix = 2;
    while (occupied.has(title)) title = `${stableBase}(${suffix++})`;
    return title;
  }
  function uniqueTitle(base) { return uniqueTitleAgainst(base); }
  function planTaskStory(task, occupied = existingTitles()) {
    if (task?.storyTitle) {
      occupied.add(String(task.storyTitle).trim());
      return task;
    }
    const title = uniqueTitleAgainst(taskStoryTitle(task), occupied);
    occupied.add(title);
    return { ...(task || {}), storyTitle: title };
  }
  function planTaskStories(items = []) {
    const occupied = existingTitles();
    return (Array.isArray(items) ? items : []).map((task) => planTaskStory(task, occupied));
  }

  function replaceStoryInitialization(next) {
    storyInitializationRef.current = next;
    setStoryInitialization(next);
  }

  function patchStoryInitialization(flowId, patch) {
    const current = storyInitializationRef.current;
    if (!current || current.flowId !== flowId) return null;
    const changes = typeof patch === "function" ? patch(current) : patch;
    if (!changes) return current;
    const next = { ...current, ...changes };
    storyInitializationRef.current = next;
    setStoryInitialization((rendered) => rendered?.flowId === flowId ? next : rendered);
    return next;
  }

  // 当 AI 建议应用过程中触发了车型源码配置后台加载，加载完成后把 inferencePhase 从
  // "applying" 收尾到目标阶段（reviewed/skipped），并清掉 applying 标记。
  // 若用户在加载期间已主动改做其他操作（如重新推理、关闭面板等），仅清掉标记，不覆盖新阶段。
  function finishInferenceApplyingIfNeeded(latest) {
    if (!latest?.inferenceApplyingSourceConfig) return {};
    if (latest.inferencePhase !== "applying") {
      return { inferenceApplyingSourceConfig: false, inferencePendingPhase: null };
    }
    return {
      inferenceApplyingSourceConfig: false,
      inferencePendingPhase: null,
      inferencePhase: latest.inferencePendingPhase || "reviewed",
    };
  }

  function loadStoryInitializationSourceConfig(flowId, projectId, cachedConfig = null) {
    const current = storyInitializationRef.current;
    if (!current || current.flowId !== flowId) return;
    const sourceConfigProjectId = String(projectId || "").trim();
    const generation = (Number(current.sourceConfigGeneration) || 0) + 1;
    patchStoryInitialization(flowId, {
      sourceConfigProjectId,
      sourceConfigGeneration: generation,
      vehicleSourceConfig: cachedConfig,
      sourceConfigLoading: !!sourceConfigProjectId,
      sourceConfigReady: !sourceConfigProjectId || !!cachedConfig,
      sourceConfigError: "",
    });
    if (!sourceConfigProjectId) return;
    void devbenchApi.getRemoteConfig(sourceConfigProjectId).then((result) => {
      patchStoryInitialization(flowId, (latest) => {
        if (latest.sourceConfigGeneration !== generation
          || latest.sourceConfigProjectId !== sourceConfigProjectId) return null;
        return {
          vehicleSourceConfig: result.ok ? (result.data || null) : latest.vehicleSourceConfig,
          sourceConfigLoading: false,
          sourceConfigReady: result.ok || !!latest.vehicleSourceConfig,
          sourceConfigError: result.ok ? "" : (result.error || "车型源码配置加载失败，请重试"),
          ...finishInferenceApplyingIfNeeded(latest),
        };
      });
    }).catch((error) => {
      patchStoryInitialization(flowId, (latest) => {
        if (latest.sourceConfigGeneration !== generation
          || latest.sourceConfigProjectId !== sourceConfigProjectId) return null;
        return {
          sourceConfigLoading: false,
          sourceConfigReady: !!latest.vehicleSourceConfig,
          sourceConfigError: error?.message || "车型源码配置加载失败，请重试",
          ...finishInferenceApplyingIfNeeded(latest),
        };
      });
    });
  }

  function requestStoryInitialization({
    mode = "create",
    body = {},
    task = null,
    snapshot = null,
    tab = null,
    sourceLabel = "手动创建",
    inferenceEnabled = false,
    inferenceSession = null,
    localProjectBindings = [],
    initialOverrides = {},
    sharedConfiguration = null,
    entry = { kind: "manual" },
    create = null,
    apply = null,
    inferenceProofSession = inferenceSession,
    inferenceDecision = inferenceSession ? "reviewed" : "",
  } = {}) {
    if (storyInitializationRef.current) {
      showToast("已有故事点配置面板打开，请先完成或取消当前配置");
      return Promise.resolve({ ok: false, error: "已有初始化配置正在处理" });
    }
    const baseDraft = createStoryInitializationDraft({
      body,
      task,
      snapshot,
      tab,
      projects,
      projectDefs,
      sourceLabel,
    });
    const seededDraft = {
      ...baseDraft,
      tbProjectId: baseDraft.tbProjectId || currentProjectId,
      ...initialOverrides,
      sourceLabel,
      inference: inferenceSession?.prediction || initialOverrides.inference || null,
    };
    const sharedConfigurationDraft = sharedConfiguration?.snapshot
      ? createStoryInitializationDraft({
        body,
        task,
        snapshot: sharedConfiguration.snapshot,
        projects,
        projectDefs,
        sourceLabel,
      })
      : null;
    const initialDraft = applyStoryInitializationSharedConfiguration(seededDraft, sharedConfigurationDraft);
    const sourceConfigProjectId = initialDraft.tbProjectId || currentProjectId;
    const cachedVehicleSourceConfig = storyVehicleSourceConfigForProject(
      sourceConfigProjectId,
      vehicleSourceConfigProjectId,
      vehicleSourceConfig,
    );
    const configInference = storyInitializationInferenceRequest({
      snapshot,
      session: inferenceProofSession,
      projectId: sourceConfigProjectId,
      localProjectBindings,
    });
    const flowId = `story-init-${Date.now()}-${++storyInitializationFlowSeqRef.current}`;
    const autoInference = mode === "create" && !configInference;
    const initialPhase = mode === "edit"
      ? "disabled"
      : configInference
        ? (inferenceDecision === "skipped" ? "skipped" : "reviewed")
        : "checking";
    return new Promise((resolve) => {
      replaceStoryInitialization({
        flowId,
        mode,
        body,
        task,
        snapshot,
        tab,
        projectsAtOpen: projects,
        projectDefsAtOpen: projectDefs,
        initialOverrides,
        sharedConfigurationDraft,
        sharedConfigurationSource: sharedConfiguration?.sourceLabel || "",
        initialDraft,
        currentDraft: initialDraft,
        sourceConfigProjectId,
        sourceConfigGeneration: 0,
        vehicleSourceConfig: cachedVehicleSourceConfig,
        sourceConfigLoading: !!sourceConfigProjectId && !cachedVehicleSourceConfig,
        sourceConfigReady: !sourceConfigProjectId || !!cachedVehicleSourceConfig,
        sourceConfigError: "",
        sourceLabel,
        inferenceEnabled: !!configInference || inferenceEnabled,
        inferencePhase: initialPhase,
        inferenceStatus: initialPhase === "checking" ? "loading" : "ready",
        inferenceReviewOpen: false,
        inferenceRequestIdentity: "",
        inferenceSummary: inferenceDecision === "skipped"
          ? "本次 AI 推理已由用户明确暂不采用；最终配置由初始化面板人工确认。"
          : inferenceSession?.summary || "",
        conflictItems: inferenceDecision === "skipped"
          ? []
          : inferenceSession?.prediction?.quality?.conflicts?.items || [],
        configInference,
        entry,
        create,
        apply,
        currentTitle: tab?.title || "",
        reviewedIdentity: configInference
          ? `${String(initialDraft.title || "").trim()}\n${String(initialDraft.ticketInput || "").trim()}`
          : "",
        resolve,
        preparedIntent: null,
        partialRecovery: null,
        pendingSkipReview: null,
        busy: false,
        error: "",
      });
      setShowNewMenu(false);
      loadStoryInitializationSourceConfig(flowId, sourceConfigProjectId, cachedVehicleSourceConfig);
      if (autoInference) {
        Promise.resolve().then(() => prepareStoryInitializationInference(flowId));
      }
    });
  }

  function closeStoryInitialization() {
    const pending = storyInitializationRef.current;
    if (!pending || pending.busy) return;
    setConfigSuggest((current) => {
      if (!isDeferredStoryInitializationPanelEntry(current)
        || current.deferredEntry?.flowId !== pending.flowId) return current;
      configInferencePresentationGuardRef.current.suppress(current.session?.id);
      return null;
    });
    replaceStoryInitialization(null);
    if (pending.partialRecovery) {
      pending.resolve?.({
        ok: false,
        partial: true,
        recovery: true,
        tabId: pending.partialRecovery.tabId,
        error: pending.error || pending.partialRecovery.error || "故事点仅部分创建，请人工核对残留记录",
      });
      return;
    }
    pending.resolve?.({ ok: false, cancelled: true });
  }

  async function openStoryInitializationPartialRecovery() {
    const pending = storyInitializationRef.current;
    const recovery = pending?.partialRecovery;
    if (!pending || pending.busy || !recovery?.tabId) return;
    patchStoryInitialization(pending.flowId, { busy: true });
    try {
      const latestTabs = await reloadTabs();
      const current = storyInitializationRef.current;
      if (!current || current.flowId !== pending.flowId) return;
      const recoveredTab = (latestTabs || []).find((item) => item.id === recovery.tabId) || null;
      if (!recoveredTab) {
        patchStoryInitialization(pending.flowId, {
          busy: false,
          partialRecovery: { ...recovery, found: false },
          error: `故事点 ${recovery.tabId} 仍未出现在活动列表中；不会重新创建。请稍后重试刷新，或关闭面板后人工排查服务端残留。`,
        });
        return;
      }
      replaceStoryInitialization(null);
      pending.resolve?.({
        ok: false,
        partial: true,
        recovery: true,
        tabId: recovery.tabId,
        error: pending.error || recovery.error || "故事点仅部分创建，已打开供人工核对",
      });
      setActive(recovery.tabId);
      loadMessages(recovery.tabId);
      setShowNewMenu(false);
      showToast(`已打开部分创建的故事点「${recoveredTab.title || recovery.tabId}」，请人工核对配置、设备与工作区；不会自动启动工作流`);
    } catch (error) {
      patchStoryInitialization(pending.flowId, {
        busy: false,
        error: `刷新部分创建结果失败：${error?.message || "未知错误"}；不会重新创建，请重试刷新或关闭后人工排查。`,
      });
    }
  }

  function syncStoryInitializationDraft(draft) {
    const pending = storyInitializationRef.current;
    if (!pending || !draft || pending.partialRecovery) return;
    const synchronizedDraft = applyStoryInitializationSharedConfiguration(
      draft,
      pending.sharedConfigurationDraft,
    );
    const nextSourceConfigProjectId = String(synchronizedDraft.tbProjectId || currentProjectId || "").trim();
    const sourceConfigProjectChanged = nextSourceConfigProjectId !== pending.sourceConfigProjectId;
    const identity = storyInitializationDraftIdentity(synchronizedDraft);
    const inferenceIdentity = pending.inferenceRequestIdentity || pending.reviewedIdentity;
    const identityChanged = (["checking", "running", "review_ready", "reviewing", "saving_skip", "reviewed", "skipped"].includes(pending.inferencePhase)
      || !!pending.pendingSkipReview)
      && inferenceIdentity
      && identity !== inferenceIdentity;
    if (identityChanged) {
      setConfigSuggest((current) => {
        if (!isDeferredStoryInitializationPanelEntry(current)
          || current.deferredEntry?.flowId !== pending.flowId) return current;
        configInferencePresentationGuardRef.current.suppress(current.session?.id);
        return null;
      });
    }
    patchStoryInitialization(pending.flowId, {
      currentDraft: synchronizedDraft,
      preparedIntent: null,
      partialRecovery: null,
      ...(identityChanged ? {
        inferencePhase: "stale",
        inferenceStatus: "failed",
        inferenceReviewOpen: false,
        inferenceRequestIdentity: "",
        pendingSkipReview: null,
        reviewedIdentity: "",
        configInference: null,
        conflictItems: [],
        error: "标题或 TB 绑定已变化，旧 AI 建议已失效；可按当前配置直接创建，也可重新推理。",
      } : {}),
    });
    if (sourceConfigProjectChanged) {
      const cachedConfig = storyVehicleSourceConfigForProject(
        nextSourceConfigProjectId,
        vehicleSourceConfigProjectId,
        vehicleSourceConfig,
      );
      loadStoryInitializationSourceConfig(pending.flowId, nextSourceConfigProjectId, cachedConfig);
    }
  }

  function markStoryInitializationInferenceStale(pending, result) {
    if (!storyInitializationRequiresInferenceRefresh(result)) return false;
    patchStoryInitialization(pending.flowId, {
      busy: false,
      preparedIntent: null,
      inferenceEnabled: true,
      inferencePhase: "stale",
      inferenceStatus: "failed",
      pendingSkipReview: null,
      configInference: null,
      conflictItems: [],
      error: result?.error || "AI 推理建议已失效；可按当前配置直接创建，也可重新推理。",
    });
    return true;
  }

  async function prepareStoryInitializationInference(flowId) {
    const setting = await resolveStoryPointAiInferenceEnabled();
    const pending = storyInitializationRef.current;
    if (!pending || pending.flowId !== flowId) return false;
    if (!setting.ok) {
      patchStoryInitialization(flowId, {
        inferencePhase: "error",
        inferenceStatus: "failed",
        inferenceEnabled: false,
        error: setting.error,
      });
      return false;
    }
    if (!setting.enabled) {
      const manualDraft = {
        ...(pending.currentDraft || pending.initialDraft || {}),
        inference: null,
      };
      patchStoryInitialization(flowId, {
        initialDraft: manualDraft,
        currentDraft: manualDraft,
        inferencePhase: "disabled",
        inferenceStatus: "ready",
        inferenceReviewOpen: false,
        inferenceRequestIdentity: "",
        inferenceEnabled: false,
        inferenceSummary: "AI 推理已在设置中关闭，本次由你直接确认初始化配置。",
        conflictItems: [],
        configInference: null,
        reviewedIdentity: "",
        pendingSkipReview: null,
        error: "",
      });
      return true;
    }
    return runStoryPanelInference(flowId);
  }

  async function runStoryPanelInference(flowId = storyInitializationRef.current?.flowId) {
    const pending = storyInitializationRef.current;
    if (!pending || pending.flowId !== flowId || pending.busy) return false;
    const draft = pending.currentDraft || pending.initialDraft || {};
    const requestIdentity = storyInitializationDraftIdentity(draft);
    patchStoryInitialization(flowId, {
      inferencePhase: "running",
      inferenceStatus: "running",
      inferenceEnabled: true,
      inferenceReviewOpen: false,
      inferenceRequestIdentity: requestIdentity,
      pendingSkipReview: null,
      error: "",
    });
    const body = {
      ...(pending.body || {}),
      title: String(draft.title || "").trim(),
      ticketInput: String(draft.ticketInput || "").trim(),
      ...(pending.entry?.copyFromId ? {
        copyFromId: pending.entry.copyFromId,
        copyFromKind: pending.entry.copyFromKind || "",
      } : {}),
    };
    const gitEntry = pending.entry?.kind === "git_commit" ? pending.entry : null;
    let task;
    if (gitEntry?.preview) {
      const inferenceProjectId = resolveGitCommitInferenceProjectId(
        currentProjectId,
        gitEntry.repositoryId || pending.body?.repositoryId,
      );
      task = buildGitCommitInferenceTicket(
        gitEntry.preview,
        inferenceProjectId,
        pending.body?.reviewHint,
      );
    } else if (pending.task) {
      const taskResolution = await resolveTaskStoryInferenceTask(pending.task, {
        currentTicket: body.ticketInput,
        storyTitle: body.title,
        resolveTbTask: devbenchApi.resolveTbTask,
      });
      if (!storyInitializationRef.current || storyInitializationRef.current.flowId !== flowId) return false;
      if (!taskResolution.ok) {
        patchStoryInitialization(flowId, {
          inferencePhase: "error",
          inferenceStatus: "failed",
        error: taskResolution.error || "当前 TB 单解析失败；AI 建议不可用，但仍可按当前配置继续。",
        });
        return false;
      }
      task = taskResolution.task;
    } else {
      task = {
        id: `panel:${pending.entry?.kind || "manual"}:${flowId}`,
        title: body.title,
        ticketUrl: body.ticketInput,
        ticketId: gitEntry?.revision ? `git:${gitEntry.revision}` : body.ticketInput,
        ...(gitEntry?.revision ? { description: `Revision：${gitEntry.revision}` } : {}),
        projectId: currentProjectId,
      };
    }
    // 「临时分析」面板拖入的附件：文本预览随推理信号发送（附件名命中关键词映射，
    // 文本内容进入 note/attachment 信号），让空白/无 TB 信号的故事点也能推理出配置。
    const panelInferenceAttachments = (pending.inferenceAttachments || [])
      .filter((item) => item && item.name)
      .map((item) => ({
        name: String(item.name || "").trim(),
        text: String(item.text || ""),
        size: Number(item.size) || 0,
        source: "story_initialization_panel",
      }));
    if (panelInferenceAttachments.length) {
      task = {
        ...task,
        attachments: [
          ...(Array.isArray(task.attachments) ? task.attachments : []),
          ...panelInferenceAttachments,
        ],
      };
    }
    const requested = await requestConfigInference({
      task,
      trigger: gitEntry
        ? "git_commit_story_entry"
        : pending.entry?.kind === "story_copy" ? "story_copied" : "story_created",
      title: body.title,
      deferredEntry: {
        kind: "story_initialization_panel",
        flowId,
        body,
        task: pending.task ? task : null,
        entry: pending.entry,
        requestIdentity,
      },
    });
    const latest = storyInitializationRef.current;
    if (!latest || latest.flowId !== flowId) return false;
    if (!requested) {
      if (latest.inferencePhase === "stale") return false;
      patchStoryInitialization(flowId, {
        inferencePhase: "error",
        inferenceStatus: "failed",
        error: "AI 推理未能启动；可按当前配置直接创建，或稍后重试 AI 建议。",
      });
      return false;
    }
    patchStoryInitialization(flowId, {
      inferencePhase: "review_ready",
      inferenceStatus: "ready",
      inferenceReviewOpen: false,
      inferenceRequestIdentity: requestIdentity,
      inferenceSummary: requested?.session?.summary || "AI 推理已完成，点击提示查看并人工确认推理结果。",
    });
    return true;
  }

  async function confirmStoryInitialization(draft) {
    const pending = storyInitializationRef.current;
    if (!pending || pending.busy) return;
    if (pending.partialRecovery) {
      patchStoryInitialization(pending.flowId, {
        error: pending.error || "故事点仅部分创建，请先打开残留故事点人工核对，不能再次确认创建。",
      });
      return;
    }
    // AI 复核页只是可选的异步辅助层。即使它仍处于打开状态，主面板的最终确认也必须
    // 立即按当前可见草稿推进；先终结该展示，避免创建完成后留下失去 flow 归属的侧栏。
    setConfigSuggest((current) => {
      if (!isDeferredStoryInitializationPanelEntry(current)
        || current.deferredEntry?.flowId !== pending.flowId) return current;
      configInferencePresentationGuardRef.current.suppress(current.session?.id);
      return null;
    });
    patchStoryInitialization(pending.flowId, { busy: true, error: "" });
    try {
      let result;
      if (pending.mode === "edit") {
        result = await pending.apply?.(draft);
      } else {
        const confirmedDraft = applyStoryInitializationSharedConfiguration(
          draft,
          pending.sharedConfigurationDraft,
        );
        // 组锚设备当前已被锚点占用；新成员先不独立绑定，成功 join 后再由组共享逻辑继承。
        const creationDraft = pending.sharedConfigurationDraft
          ? { ...confirmedDraft, deviceSerial: "" }
          : confirmedDraft;
        const configuration = storyInitializationConfig(creationDraft);
        let confirmedEntry = pending.entry;
        if (pending.entry?.kind === "task_story" && pending.task) {
          const taskResolution = await resolveTaskStoryInferenceTask(pending.task, {
            currentTicket: confirmedDraft.ticketInput,
            storyTitle: confirmedDraft.title,
            resolveTbTask: devbenchApi.resolveTbTask,
          });
          if (!taskResolution.ok) {
            throw new Error(taskResolution.error || "当前 TB 单解析失败，无法确认创建故事点。");
          }
          confirmedEntry = taskStoryCreateEntry(taskResolution.task) || pending.entry;
        }
        const prepareRequest = {
          title: confirmedDraft.title,
          ticketInput: confirmedDraft.ticketInput,
          sourceLabel: confirmedDraft.sourceLabel || pending.sourceLabel,
          configuration,
          // AI 推理只负责更新当前草稿，不能成为初始化确认的授权门禁。
          // 最终创建始终冻结用户此刻看到的配置；AI feedback/run 独立异步保存。
          conflicts: [],
          conflictResolutions: confirmedDraft.conflictResolutions || {},
          entry: confirmedEntry,
        };
        const requestFingerprint = storyInitializationIntentRequestFingerprint(prepareRequest);
        let preparedIntent = pending.preparedIntent;
        if (!canReuseStoryInitializationIntent(preparedIntent, requestFingerprint)) {
          const prepared = await devbenchApi.prepareStoryInitialization(prepareRequest);
          if (!prepared?.ok || !prepared.data?.id) {
            if (markStoryInitializationInferenceStale(pending, prepared)) return;
            throw new Error(prepared?.error || "初始化配置确认失败");
          }
          preparedIntent = {
            id: prepared.data.id,
            fingerprint: prepared.data.fingerprint || "",
            requestFingerprint,
          };
          patchStoryInitialization(pending.flowId, { preparedIntent });
        }
        result = pending.create
          ? await pending.create(preparedIntent.id, creationDraft)
          : await devbenchApi.createTab({ initializationIntentId: preparedIntent.id });
        if (markStoryInitializationInferenceStale(pending, result)) return;
        if (shouldDiscardStoryInitializationIntent(result)) {
          // 服务端已明确证明该 intent 不可再消费；只有网络/超时等未知结果才保留同一 intent 重放。
          patchStoryInitialization(pending.flowId, { preparedIntent: null });
        }
        if (!result?.ok && result?.partial === true && result?.tabId) {
          const latestTabs = await reloadTabs();
          const reconciledTab = (Array.isArray(latestTabs) ? latestTabs : tabsRef.current || [])
            .find((item) => item.id === result.tabId) || null;
          const recoveryError = reconciledTab
            ? `故事点记录「${reconciledTab.title || result.tabId}」已生成，但初始化未完整完成：${result.error || "请人工核对工程、设备与工作区残留"}。已刷新列表；本面板不会按成功关闭，也不会启动工作流。`
            : `服务端报告故事点 ${result.tabId} 部分创建，但刷新后尚未找到记录：${result.error || "请稍后使用同一确认凭证重试"}`;
          patchStoryInitialization(pending.flowId, {
            busy: false,
            partialRecovery: {
              tabId: result.tabId,
              found: !!reconciledTab,
              error: result.error || "",
            },
            error: recoveryError,
          });
          return;
        }
      }
      if (!result?.ok) throw new Error(result?.error || (pending.mode === "edit" ? "更新故事点配置失败" : "创建故事点失败"));
      // 「临时分析」拖入的附件：创建成功后原样转入新故事点资料目录（archives），
      // 供后续 AI 开发读取；失败仅提示，不阻断创建流程。
      const createdTabId = String(result?.data?.id || result?.tabId || result?.id || "").trim();
      if (createdTabId && Array.isArray(pending.inferenceAttachments) && pending.inferenceAttachments.length) {
        const attachmentFiles = pending.inferenceAttachments.filter((item) => item?.file && item.name);
        if (attachmentFiles.length) {
          const uploaded = [];
          const failed = [];
          for (const item of attachmentFiles) {
            try {
              const uploadedResult = await devbenchApi.uploadFile(createdTabId, item.file, String(item.name || ""));
              if (uploadedResult?.ok) uploaded.push(item.name);
              else failed.push(item.name);
            } catch {
              failed.push(item.name);
            }
          }
          if (uploaded.length) {
            showToast(`已把 ${uploaded.length} 个临时分析附件转入故事点资料目录${failed.length ? `（${failed.length} 个失败：${failed.join("、")}）` : ""}`);
          } else if (failed.length) {
            showToast(`临时分析附件转入故事点资料目录失败：${failed.join("、")}（不影响故事点创建）`);
          }
        }
      }
      replaceStoryInitialization(null);
      pending.resolve?.(result);
    } catch (error) {
      patchStoryInitialization(pending.flowId, {
        busy: false,
        error: error?.message || "故事点配置处理失败",
      });
    }
  }

  function askTitle(defaultTitle, body) {
    return newTab({ ...(body || {}), title: defaultTitle || "" });
  }
  // 打开已关闭的故事点（恢复配置；工程/设备被占用则提示无法打开）
  async function reopenClosedNow(id, reviewedSnapshot = null, reopenReview = null) {
    const r = await devbenchApi.reopenClosed(id, false, reopenReview);
    if (r.ok) {
      if (reviewedSnapshot) {
        const applied = await applyReviewedInferenceSnapshot(r.data.id, reviewedSnapshot);
        if (!applied) {
          const recoveryTabId = r.data?.id || id;
          const latestTabs = await reloadTabs();
          const recoveredTab = (latestTabs || []).find((item) => item.id === recoveryTabId) || null;
          const partialResult = reopenReviewedConfigPartialResult(r, {
            tabId: recoveryTabId,
            recoveredTab,
          });
          showToast(partialResult.error);
          return partialResult;
        }
      }
      await reloadTabs();
      setActive(r.data.id);
      setShowNewMenu(false);
      loadMessages(r.data.id);
      showToast(r.restored > 1 ? `已打开该故事点组（${r.restored} 个故事点，聊天记录已恢复）` : "已打开该故事点（聊天记录已恢复）");
    } else if (r?.partial === true) {
      const recoveryTabId = r.tabId || r.data?.id || id;
      const latestTabs = await reloadTabs();
      const recoveredTab = (latestTabs || []).find((item) => item.id === recoveryTabId) || null;
      showToast(recoveredTab
        ? `故事点记录「${recoveredTab.title || recoveryTabId}」已恢复到活动列表，但工作区恢复失败：${r.error || "请打开该故事点的配置并人工核对"}`
        : `故事点记录可能已恢复（${recoveryTabId}），但工作区恢复失败且活动列表暂未定位：${r.error || "请刷新后人工核对"}`);
      return { ...r, tabId: recoveryTabId, recoveryTabFound: !!recoveredTab };
    } else {
      showToast(r.error || "无法打开");
    }
    return r;
  }

  // 重新打开已关闭的故事点：直接用已存配置恢复，不再触发/弹「AI 推理」复核窗口
  // （体验优化：重开只是恢复历史现场，配置是之前已确认过的，无需重新推理）。
  async function reopenClosed(id) {
    const entryToken = beginStoryEntry("story_reopen");
    if (!entryToken) return { ok: false, error: "另一个故事点入口正在处理" };
    try {
      return await reopenClosedNow(id);
    } finally {
      finishStoryEntry(entryToken);
    }
  }

  async function createInitializedStory(body = {}, reviewedSnapshot = null, inferenceSession = null, reviewContext = {}) {
    const copySnapshot = body?.copySource?.configuration || null;
    const sourceLabel = body?.copyFromId ? "复制历史故事点配置" : "新建空白故事点";
    const r = await requestStoryInitialization({
      body,
      snapshot: reviewedSnapshot || copySnapshot,
      sourceLabel,
      inferenceEnabled: !!inferenceSession,
      inferenceSession,
      inferenceProofSession: reviewContext.inferenceProofSession || inferenceSession,
      inferenceDecision: reviewContext.inferenceDecision || (inferenceSession ? "reviewed" : ""),
      localProjectBindings: reviewContext.localProjectBindings,
      entry: {
        kind: body?.copyFromId ? "story_copy" : "blank_story",
        copyFromId: body?.copyFromId || "",
        copyFromKind: body?.copyFromKind || "",
      },
    });
    if (r?.ok && r.data?.id) {
      await reloadTabs();
      setActive(r.data.id);
      setMsgMap((prev) => ({ ...prev, [r.data.id]: [] }));
      showToast(body?.copyFromId ? "已按确认配置复制故事点" : "已创建故事点并应用初始化配置");
    } else if (!r?.cancelled) {
      showToast(r?.error || "新建失败");
    }
    setShowNewMenu(false);
    return r;
  }

  // 空白/复制入口先同步显示初始化面板；面板内部 fresh 读取设置并在开启时自动完成 AI 复核。
  // 同一个 entry token 覆盖检查、推理、复核、初始化确认和真实创建，只在整个事务结束后释放。
  async function newTab(body = {}) {
    const entryToken = beginStoryEntry(body?.copyFromId ? "story_copy" : "blank_story");
    if (!entryToken) return { ok: false, error: "另一个故事点入口正在处理" };
    try {
      return await createInitializedStory(body);
    } finally {
      finishStoryEntry(entryToken);
    }
  }

  async function createStoryPointFromTb(input) {
    const resolved = await devbenchApi.resolveTbTask(input);
    if (!resolved.ok) return resolved;
    if (resolved.existingTab?.id) {
      if (resolved.existingTab.closed === true) {
        return await reopenClosed(resolved.existingTab.id);
      }
      await reloadTabs();
      setActive(resolved.existingTab.id);
      loadMessages(resolved.existingTab.id);
      showToast(`该 TB 单已关联故事点「${resolved.existingTab.title}」，已为你切换`);
      return { ok: true, existing: true };
    }
    const task = resolved.data;
    const entryToken = beginStoryEntry("tb_story");
    if (!entryToken) return { ok: false, error: "另一个故事点入口正在处理" };
    try {
      const body = { title: uniqueTitle(taskStoryTitle(task)) };
      const scopedTask = { ...task, storyTitle: body.title };
      const created = await createConfiguredTaskStoryPoint(scopedTask, {
        activate: true,
        closeTasks: false,
        kick: false,
        announce: true,
      });
      return created
        ? { ok: true, data: created }
        : { ok: false, cancelled: true, error: "已取消故事点初始化" };
    } finally {
      finishStoryEntry(entryToken);
    }
  }

  async function createStoryPointFromBackup(file, titleOverride = "") {
    if (!file) return { ok: false, error: "请选择备份文件" };
    const entryToken = beginStoryEntry("story_backup");
    if (!entryToken) return { ok: false, error: "另一个故事点入口正在处理" };
    try {
      // 第一步：解析备份，拿到初始化配置快照（不创建 tab）。
      const parsed = await devbenchApi.parseStoryBackup(file);
      if (!parsed?.ok) {
        showToast(parsed?.error || "解析备份失败");
        return parsed;
      }
      const snapshot = parsed.data?.snapshot || {};
      const manifest = parsed.data?.manifest || {};
      const backupTab = parsed.data?.backupTab || {};
      const backupTitle = String(titleOverride || backupTab.title || manifest.tabTitle || "还原的故事点").trim() || "还原的故事点";
      const backupSummary = `（备份含 ${parsed.data?.messageCount || 0} 条对话 · ${parsed.data?.fileCount || 0} 个资料文件）`;

      showToast(`已解析备份，请在初始化面板确认本机工程映射或配置远程克隆`);

      // 第二步：用快照打开「新建故事点初始化面板」，让用户绑定本机工程或配置远程克隆。
      // 跳过 AI 推理：备份里已有完整配置，用户只需确认/调整本机工程映射。
      const initResult = await requestStoryInitialization({
        mode: "create",
        body: { title: backupTitle },
        snapshot,
        sourceLabel: `从备份还原${backupSummary}`,
        inferenceEnabled: false,
        inferenceSession: { id: `backup-restore:${manifest.tabId || ""}`, projectId: snapshot.projectDefId || "" },
        inferenceDecision: "skipped",
        entry: { kind: "story_backup" },
      });
      if (!initResult?.ok || !initResult.data?.id) {
        // 用户取消或初始化失败
        if (initResult?.cancelled) return { ok: false, cancelled: true };
        if (initResult?.error) showToast(initResult.error);
        return initResult || { ok: false, error: "初始化失败" };
      }
      const newTabId = initResult.data.id;

      // 第三步：把备份内容（对话/消息/资料文件）应用到新建的 tab。
      showToast(`正在还原备份内容到新故事点…`);
      const applied = await devbenchApi.applyStoryBackup(newTabId, file);
      if (!applied?.ok) {
        showToast(`故事点已创建，但还原备份内容失败：${applied?.error || "未知错误"}`);
      } else {
        const fileCount = Number(applied.data?.restoredFiles) || 0;
        const msgCount = Number(applied.data?.messageCount) || 0;
        showToast(`已从备份还原（${msgCount} 条对话 · ${fileCount} 个资料文件），可继续完成任务`);
        if (applied.data?.warning) showToast(applied.data.warning);
      }
      await reloadTabs();
      setActive(newTabId);
      await loadMessages(newTabId);
      setShowNewMenu(false);
      return { ok: true, data: { id: newTabId, ...(applied?.data || {}) } };
    } finally {
      finishStoryEntry(entryToken);
    }
  }

  async function beginGitCommitConfigInference(body, deferredEntry = {}) {
    const previewed = await devbenchApi.previewGitCommitStory({
      ...(body || {}),
      ...(currentProjectId ? { projectId: currentProjectId } : {}),
    });
    if (!previewed.ok) return previewed;
    if (previewed.existing && previewed.data?.id) {
      await reloadTabs();
      setActive(previewed.data.id);
      loadMessages(previewed.data.id);
      showToast(`该 commit 已有关联评审故事点，已切换到「${previewed.data.title}」`);
      setShowNewMenu(false);
      return previewed;
    }
    const inferenceSetting = await resolveStoryPointAiInferenceEnabled();
    if (!inferenceSetting.ok) return { ok: false, error: inferenceSetting.error };
    if (!inferenceSetting.enabled) {
      return {
        ...previewed,
        inferenceSkipped: true,
      };
    }
    const projectId = resolveGitCommitInferenceProjectId(currentProjectId, body?.repositoryId);
    if (!projectId) return { ok: false, error: "Git commit 推理缺少逻辑仓库，无法建立隔离上下文" };
    const ticket = buildGitCommitInferenceTicket(
      previewed.data,
      projectId,
      body?.reviewHint,
    );
    const gitDeferredEntry = {
      kind: "git_commit",
      body: {
        ...(body || {}),
        projectId,
      },
      preview: previewed.data,
      initialLocalProjectBindings: [],
      ...deferredEntry,
    };
    const storyEntry = configInferenceStoryEntryScope(gitDeferredEntry, {
      openStoryIds: (tabsRef.current || []).map((item) => item.id),
      closedStories: copySources.closed || [],
    });
    const inferred = await devbenchApi.runConfigInference({
      projectId,
      trigger: "git_commit_story_entry",
      ticket,
      ...(storyEntry ? { storyEntry } : {}),
    });
    if (!inferred?.ok || !inferred.data?.id) {
      return {
        ok: false,
        error: inferred?.error || "Git commit 已解析，但 AI 配置推理启动失败",
      };
    }
    const seeded = seedGitCommitInferenceSession(
      inferred.data,
      body?.configuration,
      body?.repositoryId,
    );
    setConfigInferenceReviewWarning(null);
    setConfigSuggest({
      tabId: null,
      session: seeded.session,
      task: null,
      kickAfter: false,
      projectId,
      deferredEntry: {
        ...gitDeferredEntry,
        initialLocalProjectBindings: seeded.bindings,
      },
      dismissOnConfirm: false,
    });
    setShowNewMenu(false);
    return {
      ok: true,
      inferenceStarted: true,
      data: previewed.data,
      runId: inferred.data.id,
    };
  }

  async function previewStoryPointFromGitCommit(body) {
    const entryToken = beginStoryEntry("git_commit");
    if (!entryToken) return { ok: false, error: "另一个故事点入口正在处理" };
    try {
      const previewed = await devbenchApi.previewGitCommitStory({
        ...(body || {}),
        ...(currentProjectId ? { projectId: currentProjectId } : {}),
      });
      if (!previewed?.ok) return previewed;
      if (previewed.existing && previewed.data?.id) {
        await reloadTabs();
        setActive(previewed.data.id);
        loadMessages(previewed.data.id);
        setShowNewMenu(false);
        showToast(`该 commit 已有关联评审故事点，已切换到「${previewed.data.title}」`);
        return previewed;
      }
      return await createStoryPointFromGitCommit(body, {
        preview: previewed.data,
        entryToken,
      });
    } finally {
      finishStoryEntry(entryToken);
    }
  }

  async function startNextGitCommitBatchInference(requests = [], entryToken = "") {
    let queue = Array.isArray(requests) ? requests.filter((request) => request?.body) : [];
    while (queue.length) {
      const { current, remaining } = nextGitCommitBatchRequest(queue);
      queue = remaining;
      const started = await beginGitCommitConfigInference(current.body, {
        batchQueue: remaining,
        entryToken,
      });
      if (!started?.ok) return started;
      if (started.inferenceStarted) return started;
      if (started.inferenceSkipped && started.data?.commit) {
        const created = await createStoryPointFromGitCommit(current.body, {
          preview: started.data,
          entryToken,
        });
        if (!created?.ok) return created;
      }
    }
    showToast("批量 Git commit 已全部复核完成");
    return { ok: true, completed: true };
  }

  async function createStoryPointFromGitCommit(body, {
    preview = null,
    reviewedSnapshot = null,
    inferenceSession = null,
    inferenceProofSession = inferenceSession,
    inferenceDecision = inferenceSession ? "reviewed" : "",
    localProjectBindings = [],
    entryToken = "",
  } = {}) {
    if (entryToken && storyEntryGuardRef.current.current() !== entryToken) {
      return { ok: false, error: "Git commit 故事点创建流程已失效，请从入口重新开始" };
    }
    const activeEntryToken = entryToken || beginStoryEntry("git_commit_create");
    if (!activeEntryToken) return { ok: false, error: "另一个故事点入口正在处理" };
    const ownsEntryToken = !entryToken;
    try {
    let resolvedPreview = preview;
    if (!resolvedPreview?.commit) {
      const previewed = await devbenchApi.previewGitCommitStory({
        ...(body || {}),
        ...(currentProjectId ? { projectId: currentProjectId } : {}),
      });
      if (!previewed?.ok || previewed.existing) {
        if (previewed?.existing && previewed.data?.id) {
          await reloadTabs();
          setActive(previewed.data.id);
          loadMessages(previewed.data.id);
          setShowNewMenu(false);
        }
        return previewed;
      }
      resolvedPreview = previewed.data;
    }
    const commit = resolvedPreview.commit || {};
    const inferred = resolvedPreview.inference || {};
    const configuredMode = body?.configuration?.mode === "local" ? "local" : "remote";
    const initialOverrides = configuredMode === "local" ? {
      mode: "local",
      primaryProjectId: body?.configuration?.localProjectId || "",
      flavorByProjectId: body?.configuration?.localProjectId && inferred.flavor
        ? { [body.configuration.localProjectId]: inferred.flavor }
        : {},
    } : {
      mode: "remote",
      projectDefId: body?.repositoryId || "",
      remoteProjectDefIds: (inferred.dependencies || []).map((item) => item.repositoryId).filter(Boolean),
      vehicle: inferred.vehicle || "",
      branch: inferred.branch || "",
      remoteFlavor: inferred.flavor || "",
    };
    const title = uniqueTitle(`Review ${commit.shortRevision || String(commit.revision || "").slice(0, 12)}${commit.subject ? ` · ${commit.subject}` : ""}`.slice(0, 60));
    const created = await requestStoryInitialization({
      body: { title },
      snapshot: reviewedSnapshot,
      sourceLabel: `Git commit ${commit.shortRevision || "评审"}`,
      inferenceEnabled: !!inferenceSession,
      inferenceSession,
      inferenceProofSession,
      inferenceDecision,
      localProjectBindings,
      ...(!reviewedSnapshot ? { initialOverrides } : {}),
      entry: {
        kind: "git_commit",
        repositoryId: body?.repositoryId || "",
        revision: commit.revision || body?.revision || "",
        preview: resolvedPreview,
      },
      create: (intentId, draft) => devbenchApi.createGitCommitStory({
        ...(body || {}),
        ...(currentProjectId ? { projectId: currentProjectId } : {}),
        configurationConfirmed: true,
        configuration: draft.mode === "local"
          ? {
            mode: "local",
            localProjectId: draft.primaryProjectId,
            localRole: body?.configuration?.localRole || "primary",
          }
          : { mode: "remote" },
        storyInitializationIntentId: intentId,
        configInferenceLocalProjectBindings: localProjectBindings,
      }),
    });
    if (!created.ok || !created.data?.id) return created;
    await reloadTabs();
    setActive(created.data.id);
    if (created.existing) {
      loadMessages(created.data.id);
      showToast(`该 commit 已有关联评审故事点，已切换到「${created.data.title}」`);
    } else {
      setMsgMap((prev) => ({ ...prev, [created.data.id]: [] }));
      const inference = created.inference || {};
      const inferred = [
        inference.vehicle,
        inference.flavor,
        inference.branch,
      ].filter(Boolean).join(" · ");
      showToast(`已创建 commit 评审故事点${inferred ? `：${inferred}` : ""}`);
    }
    setShowNewMenu(false);
    return created;
    } finally {
      if (ownsEntryToken) finishStoryEntry(activeEntryToken);
    }
  }

  async function resolveGitCommitStoryBatch(body) {
    return devbenchApi.resolveGitCommitStoryBatch(body || {});
  }

  async function createStoryPointsFromGitCommits(requests, onProgress) {
    const queue = Array.isArray(requests) ? requests : [];
    if (!queue.length) return { ok: false, error: "没有可进入初始化配置的 Git commit" };
    const entryToken = beginStoryEntry("git_commit_batch");
    if (!entryToken) return { ok: false, error: "另一个故事点入口正在处理" };
    const results = [];
    try {
      for (const request of queue) {
        onProgress?.(request, { status: "creating" });
        const previewed = await devbenchApi.previewGitCommitStory({
          ...(request.body || {}),
          ...(currentProjectId ? { projectId: currentProjectId } : {}),
        });
        if (!previewed?.ok) {
          const failed = { ...request, ok: false, status: "failed", error: previewed?.error || "Git commit 解析失败" };
          results.push(failed);
          onProgress?.(request, failed);
          continue;
        }
        if (previewed.existing && previewed.data?.id) {
          const existing = { ...request, ok: true, existing: true, status: "existing", data: previewed.data };
          results.push(existing);
          onProgress?.(request, existing);
          continue;
        }
        const created = await createStoryPointFromGitCommit(request.body, {
          preview: previewed.data,
          entryToken,
        });
        const row = created?.ok
          ? { ...request, ...created, status: created.existing ? "existing" : "created" }
          : { ...request, ...created, ok: false, status: "failed", error: created?.error || "已取消该 commit 的故事点初始化" };
        results.push(row);
        onProgress?.(request, row);
        if (created?.cancelled) break;
      }
      const failed = results.filter((row) => row.ok === false);
      return { ok: failed.length === 0 && results.length === queue.length, results, ...(failed.length ? { error: `${failed.length} 个 commit 未完成初始化` } : {}) };
    } finally {
      finishStoryEntry(entryToken);
    }
  }

  // 从任务列表「执行开发/再次开发」：代办任务↔故事点一对一绑定。
  // 已绑定：故事点开着→切过去；已关闭→打开(恢复)；已彻底删除→重建。未绑定：首次新建并绑定。
  // 全自动工作流：TB 类任务点「执行开发」→ 触发 待处理→待确认 + 后台甄别（非 TB 任务跳过）
  async function kickTbWorkflow(task, tabId) {
    const isTb = !!(task.tbTaskId || /task\/[0-9a-fA-F]{24}/.test(task.ticketUrl || ""));
    if (!isTb || !tabId) return;
    try {
      const r = await devbenchApi.workflowStartDev(tabId);
      if (r?.flow?.ok && !r.flow.skipped && r.flow.to) showToast(`TB 状态已切为「${r.flow.to}」`);
      if (r?.triage?.started) {
        // 全自动：已后台开跑甄别 → 立即点亮"运行中"，等 WS 流式接管
        setRunningTabs((s) => new Set(s).add(tabId));
        showToast("正在自动甄别该 TB 单是否属于客户端/应用市场问题…");
      } else if (r?.triage?.mode === "semi") {
        showToast("已关联工单（半自动）。工程就绪后点「开始 AI 甄别」或直接发消息即可开始分析");
      }
    } catch {}
  }

  // 创建与重新打开共用这道门：开启时先基于当前已有来源推理并人工复核。
  async function requestConfigInference({
    tabId = null,
    task = null,
    trigger = "story_entry",
    title = "",
    kickAfter = false,
    deferredEntry = null,
    dismissOnConfirm = false,
  } = {}) {
    if (!tabId && !deferredEntry) return false;
    const projectId = resolveStoryInferenceProjectId({
      projectId: task?.projectId || task?._projectId || currentProjectId,
      deferredKind: deferredEntry?.kind || trigger,
      tabId,
    });
    const project = (tbProjects || []).find((item) => String(item.id || item.projectId) === String(projectId));
    const ticket = task ? {
      ticketId: task.tbTaskId || task.ticketId || "",
      tbTaskId: task.tbTaskId || "",
      ticketUrl: task.ticketUrl || "",
      title: task.title || title || "",
      description: task.description || task.note || "",
      projectId,
      projectName: task.projectName || project?.name || "",
      tasklistId: task.tasklistId || "",
      tasklistName: task.tasklistName || "",
      iterationName: task.iterationName || task.sprintName || "",
      tags: task.tags || [],
      comments: task.comments || [],
      attachments: task.attachments || [],
      sourceCoverage: task.sourceCoverage || {},
    } : {
      title,
      projectId,
      projectName: project?.name || "",
    };
    let closedStories = copySources.closed || [];
    if (["task", "task_group", "team_dev"].includes(deferredEntry?.kind)) {
      const latestSources = await devbenchApi.getCopySources().catch(() => null);
      if (latestSources?.ok) closedStories = latestSources.data?.closed || [];
    }
    const storyEntry = configInferenceStoryEntryScope(deferredEntry, {
      openStoryIds: (tabsRef.current || []).map((item) => item.id),
      closedStories,
    });
    try {
      const result = await devbenchApi.runConfigInference({
        projectId,
        ...(tabId ? { tabId } : {}),
        trigger,
        ticket,
        ...(storyEntry ? { storyEntry } : {}),
      });
      if (!result?.ok || !result.data) {
        showToast(result?.error || "配置推断失败，尚未启动开发工作流");
        return false;
      }
      if (deferredEntry?.kind === "story_initialization_panel"
        && storyInitializationRef.current?.flowId !== deferredEntry.flowId) {
        return false;
      }
      if (deferredEntry?.kind === "story_initialization_panel") {
        const currentInitialization = storyInitializationRef.current;
        const currentIdentity = storyInitializationDraftIdentity(
          currentInitialization?.currentDraft || currentInitialization?.initialDraft || {},
        );
        if (currentInitialization?.inferencePhase === "stale"
          || (deferredEntry.requestIdentity && currentIdentity !== deferredEntry.requestIdentity)) {
          configInferencePresentationGuardRef.current.suppress(result.data?.id);
          return false;
        }
      }
      setConfigInferenceReviewWarning(null);
      setConfigSuggest({
        tabId,
        session: result.data,
        task,
        kickAfter,
        projectId,
        deferredEntry,
        dismissOnConfirm,
      });
      return { ok: true, session: result.data };
    } catch (error) {
      showToast(error?.message || "配置推断失败，尚未启动开发工作流");
      return false;
    }
  }

  function resumeStoryInitializationAfterInference(pending, reviewedSnapshot, reviewContext = {}) {
    const flowId = pending?.deferredEntry?.flowId || "";
    const current = storyInitializationRef.current;
    if (!current || current.flowId !== flowId) {
      return { ok: true, detached: true };
    }
    const reviewedTask = pending?.deferredEntry?.task || current.task;
    const reviewedEntry = current.entry?.kind === "task_story" && reviewedTask
      ? taskStoryCreateEntry(reviewedTask) || current.entry
      : current.entry;
    const accepted = reviewContext.apply === true;
    const appliedSnapshot = accepted && !!reviewedSnapshot;
    const currentDraft = current.currentDraft || current.initialDraft || {};
    let nextDraft;
    if (appliedSnapshot) {
      nextDraft = {
        ...createStoryInitializationDraft({
          body: {
            ...(current.body || {}),
            title: currentDraft.title,
            ticketInput: currentDraft.ticketInput,
          },
          task: reviewedTask,
          snapshot: reviewedSnapshot,
          tab: current.tab,
          projects: current.projectsAtOpen || projects,
          projectDefs: current.projectDefsAtOpen || projectDefs,
          sourceLabel: current.sourceLabel,
        }),
        sourceLabel: current.sourceLabel,
        inference: pending.session?.prediction || null,
      };
    } else {
      nextDraft = {
        ...currentDraft,
        inference: accepted ? pending.session?.prediction || null : null,
      };
    }
    nextDraft = applyStoryInitializationSharedConfiguration(
      nextDraft,
      current.sharedConfigurationDraft,
    );
    const nextSourceConfigProjectId = String(
      reviewedTask?.projectId || reviewedTask?._projectId || nextDraft.tbProjectId || currentProjectId || "",
    ).trim();
    if (nextSourceConfigProjectId && nextDraft.tbProjectId !== nextSourceConfigProjectId) {
      nextDraft = { ...nextDraft, tbProjectId: nextSourceConfigProjectId };
    }
    const configInference = storyInitializationInferenceRequest({
      snapshot: reviewedSnapshot,
      session: pending.session,
      projectId: nextSourceConfigProjectId,
      localProjectBindings: reviewContext.localProjectBindings,
    });
    const identity = storyInitializationDraftIdentity(nextDraft);
    patchStoryInitialization(flowId, {
      initialDraft: nextDraft,
      currentDraft: nextDraft,
      inferenceEnabled: true,
      inferencePhase: accepted ? "reviewed" : "skipped",
      inferenceStatus: "ready",
      inferenceReviewOpen: false,
      inferenceRequestIdentity: identity,
      inferenceSummary: accepted
        ? appliedSnapshot
          ? pending.session?.summary || "AI 建议已应用到当前草稿；反馈正在后台保存，不影响创建。"
          : "AI 建议没有可安全应用的快照；已保留当前配置，反馈正在后台保存。"
        : "本次 AI 建议已暂不采用；反馈正在后台保存，不影响创建。",
      conflictItems: accepted ? pending.session?.prediction?.quality?.conflicts?.items || [] : [],
      configInference: configInference || null,
      task: reviewedTask,
      entry: reviewedEntry,
      preparedIntent: null,
      partialRecovery: null,
      pendingSkipReview: null,
      reviewedIdentity: identity,
      error: "",
    });
    if (nextSourceConfigProjectId !== current.sourceConfigProjectId) {
      loadStoryInitializationSourceConfig(
        flowId,
        nextSourceConfigProjectId,
        storyVehicleSourceConfigForProject(
          nextSourceConfigProjectId,
          vehicleSourceConfigProjectId,
          vehicleSourceConfig,
        ),
      );
    }
    return { ok: true, resumedInitialization: true };
  }

  async function continueDeferredStoryEntry(pending, reviewedSnapshot, reviewContext = {}) {
    const deferred = pending?.deferredEntry;
    const entryToken = deferred?.entryToken || "";
    let keepEntryLock = false;
    try {
      let result = null;
      if (isDeferredStoryInitializationPanelEntry(pending)) {
        result = resumeStoryInitializationAfterInference(pending, reviewedSnapshot, reviewContext);
        if (!result?.ok) throw new Error(result?.error || "恢复初始化配置面板失败");
      } else if (isDeferredGitCommitStoryEntry(pending)) {
        const originalConfiguration = deferred.body?.configuration || {};
        const configuration = reviewedSnapshot?.mode
          ? reviewedSnapshot.mode === "local"
            ? {
              mode: "local",
              localProjectId: reviewedSnapshot.primaryProjectId,
              localRole: originalConfiguration.localRole || "primary",
            }
            : { mode: "remote" }
          : originalConfiguration;
        const localProjectBindings = Array.isArray(reviewContext.localProjectBindings)
          ? reviewContext.localProjectBindings
          : deferred.initialLocalProjectBindings || [];
        result = await createStoryPointFromGitCommit({
          ...deferred.body,
          configurationConfirmed: true,
          configuration,
          configInferenceRunId: pending.session.id,
        }, {
          preview: deferred.preview,
          reviewedSnapshot,
          inferenceSession: reviewContext.apply === true ? pending.session : null,
          inferenceProofSession: pending.session,
          inferenceDecision: reviewContext.apply === true ? "reviewed" : "skipped",
          localProjectBindings,
          entryToken,
        });
        if (result?.cancelled) return result;
        if (!result?.ok) throw new Error(result?.error || "AI 推理已确认，但创建 Git commit 评审故事点失败");
        const nextBatch = Array.isArray(deferred.batchQueue) ? deferred.batchQueue : [];
        if (nextBatch.length) {
          const next = await startNextGitCommitBatchInference(nextBatch, entryToken);
          if (!next?.ok) {
            throw new Error(next?.error || "当前评审故事点已创建，但下一条 Git commit 的 AI 推理启动失败");
          }
          keepEntryLock = next.inferenceStarted === true;
          result = {
            ...result,
            nextInferenceStarted: next.inferenceStarted === true,
          };
        }
      } else if (isDeferredTaskStoryEntry(pending)) {
        result = await continueTaskDevFromTask(deferred.task, {
          reviewedSnapshot,
          inferenceSession: reviewContext.apply === true ? pending.session : null,
          inferenceProofSession: pending.session,
          inferenceDecision: reviewContext.apply === true ? "reviewed" : "skipped",
          localProjectBindings: reviewContext.localProjectBindings,
          reopenReview: reviewContext.reopenReview,
          entryToken,
        });
      } else if (isDeferredTaskGroupStoryEntry(pending)) {
        result = await continueGroupDevFromTasks(deferred.group, deferred.items, {
          reviewedSnapshot,
          inferenceSession: reviewContext.apply === true ? pending.session : null,
          inferenceProofSession: pending.session,
          inferenceDecision: reviewContext.apply === true ? "reviewed" : "skipped",
          localProjectBindings: reviewContext.localProjectBindings,
          reopenReview: reviewContext.reopenReview,
        });
      } else if (isDeferredTeamDevStoryEntry(pending)) {
        result = await continueTeamDev(deferred.source, deferred.task, {
          reviewedSnapshot,
          inferenceSession: reviewContext.apply === true ? pending.session : null,
          inferenceProofSession: pending.session,
          inferenceDecision: reviewContext.apply === true ? "reviewed" : "skipped",
          localProjectBindings: reviewContext.localProjectBindings,
          reopenReview: reviewContext.reopenReview,
        });
      } else if (isDeferredStoryReopenEntry(pending)) {
        result = await reopenClosedNow(deferred.storyId, reviewedSnapshot, reviewContext.reopenReview);
      } else if (isDeferredStoryInitializationEntry(pending)) {
        result = deferred.task
          ? await createConfiguredTaskStoryPoint(deferred.task, {
            ...(deferred.taskCreateOptions || {}),
            reviewedSnapshot,
            inferenceSession: reviewContext.apply === true ? pending.session : null,
            inferenceProofSession: pending.session,
            inferenceDecision: reviewContext.apply === true ? "reviewed" : "skipped",
            localProjectBindings: reviewContext.localProjectBindings,
          })
          : await createInitializedStory(
            deferred.body,
            reviewedSnapshot,
            reviewContext.apply === true ? pending.session : null,
            {
              ...reviewContext,
              inferenceProofSession: pending.session,
              inferenceDecision: reviewContext.apply === true ? "reviewed" : "skipped",
            },
          );
      }
      keepEntryLock = keepEntryLock || result?.keepEntryLock === true;
      return result;
    } finally {
      if (!keepEntryLock) finishStoryEntry(entryToken);
    }
  }

  async function continueDeferredStoryEntryAfterReviewFailure(pending, confirmedSnapshot = null, reason = "") {
    const detail = String(reason || "").trim();
    setConfigInferenceReviewWarning({
      runId: String(pending?.session?.id || ""),
      message: confirmedSnapshot
        ? `AI 推理复核记录未保存${detail ? `：${detail}` : ""}。本次推理页已关闭且不会重复弹出；你已确认的 AI 工程配置仍会应用到故事点。`
        : `AI 推理复核未保存${detail ? `：${detail}` : ""}。本次推理页已关闭且不会重复弹出；本次确认没有可安全应用的工程配置，系统将按现有配置继续故事点流程。`,
    });
    try {
      await continueDeferredStoryEntry(pending, confirmedSnapshot);
    } catch (error) {
      showToast(`AI 推理复核未保存，故事点流程也执行失败：${error?.message || "未知错误"}`);
    }
  }

  function markStoryInitializationSkipReviewPending(pending, payload) {
    const flowId = pending?.deferredEntry?.flowId || "";
    const current = storyInitializationRef.current;
    if (!current || current.flowId !== flowId) return false;
    const draft = current.currentDraft || current.initialDraft || {};
    const identity = storyInitializationDraftIdentity(draft);
    patchStoryInitialization(flowId, {
      inferenceEnabled: true,
      inferencePhase: "saving_skip",
      inferenceStatus: "ready",
      inferenceReviewOpen: false,
      inferenceRequestIdentity: identity,
      inferenceSummary: "已暂不采用本次 AI 配置推理，正在后台保存反馈；不影响编辑或创建。",
      conflictItems: [],
      configInference: null,
      pendingSkipReview: { pending, payload },
      reviewedIdentity: identity,
      error: "",
    });
    return true;
  }

  function markStoryInitializationSkipReviewFailed(pending, payload, reason = "") {
    const flowId = pending?.deferredEntry?.flowId || "";
    const current = storyInitializationRef.current;
    if (!current || current.flowId !== flowId) return false;
    patchStoryInitialization(flowId, {
      inferenceEnabled: true,
      inferencePhase: "error",
      inferenceStatus: "failed",
      inferenceSummary: "",
      configInference: null,
      pendingSkipReview: { pending, payload },
      error: `“暂不采用”的反馈保存失败：${reason || "网络请求失败"}。可重试保存；当前草稿与创建流程不受影响。`,
    });
    return true;
  }

  function retryStoryInitializationSkipReview(flowId) {
    const current = storyInitializationRef.current;
    const retry = current?.pendingSkipReview;
    if (!current || current.flowId !== flowId || current.busy || !retry?.pending || !retry?.payload) return false;
    void submitConfigInferenceReview(retry.payload, retry.pending);
    return true;
  }

  function openStoryInitializationInferenceResult(flowId) {
    const current = storyInitializationRef.current;
    if (!current || current.flowId !== flowId || current.inferencePhase !== "review_ready") return false;
    patchStoryInitialization(flowId, {
      inferenceReviewOpen: true,
      inferencePhase: "reviewing",
    });
    return true;
  }

  function closeStoryInitializationInferenceResult(flowId) {
    const current = storyInitializationRef.current;
    if (!current || current.flowId !== flowId || current.busy) return false;
    patchStoryInitialization(flowId, {
      inferenceReviewOpen: false,
      inferencePhase: "review_ready",
    });
    return true;
  }

  async function submitConfigInferenceReview(payload, pendingOverride = null) {
    const pending = pendingOverride || configSuggest;
    if (!pending) return;
    // React state 只能在本轮事件结束后把按钮置为 disabled；同步事务锁必须先占位，
    // 防止同一帧重复 click 发出两次 review，并由迟到失败把成功页面重新弹回。
    const submissionToken = configInferenceSubmissionGuardRef.current.acquire(pending.session?.id);
    if (!submissionToken) return;
    const reviewProjectId = resolveInferenceProjectId(pending.session, pending.projectId, currentProjectId);
    const skipRequested = payload?.decision === "insufficient" && payload?.apply === false;
    const strictGroupGate = pending.continueAction === "group_auto";
    const reopenReviewRequired = requiresSavedStoryReopenReview(pending);
    const dismissBeforeReview = shouldDismissConfigInferenceBeforeReview(pending);
    const dismissStoryInitializationSkip = shouldDismissStoryInitializationSkipBeforeReview(pending, payload);
    const reviewFailurePolicy = configInferenceReviewFailurePolicy(pending);
    // 在发出反馈保存请求前冻结用户本次确认的服务端快照。这样即使 review
    // 返回业务错误或网络异常，后续创建故事点也不会退回空配置。
    const confirmedSnapshot = confirmedConfigInferenceSnapshot(pending.session, payload);
    let reviewSaved = false;
    setConfigSuggestBusy(true);
    if (isDeferredStoryInitializationPanelEntry(pending)) {
      try {
        const continuationContext = {
          localProjectBindings: payload?.localProjectBindings,
          reviewDecision: payload?.decision || "",
          apply: payload?.apply === true,
        };
        configInferencePresentationGuardRef.current.suppress(pending.session?.id);
        setConfigSuggest(null);
        // 先切到 "applying" 阶段并让出一帧，让"正在应用 AI 建议"横幅先绘制，
        // 避免用户在弹窗关闭后面对一个静止的初始化面板，误以为没有响应。
        patchStoryInitialization(pending.deferredEntry?.flowId, {
          inferencePhase: "applying",
          inferenceSummary: payload?.apply === true
            ? "正在将 AI 建议应用到初始化配置，请稍候…"
            : "正在记录本次反馈，请稍候…",
          inferenceReviewOpen: false,
        });
        await Promise.resolve();
        const resumed = resumeStoryInitializationAfterInference(
          pending,
          confirmedSnapshot,
          continuationContext,
        );
        if (!resumed?.ok) {
          showToast(resumed?.error || "AI 建议未能应用到当前草稿；不影响继续创建");
          // resume 失败时退出 applying，避免面板卡在"应用中"状态。
          patchStoryInitialization(pending.deferredEntry?.flowId, {
            inferencePhase: payload?.apply === true ? "reviewed" : "skipped",
            inferenceApplyingSourceConfig: false,
            inferencePendingPhase: null,
          });
        } else {
          // resume 已把阶段切到 reviewed/skipped；若此时车型源码配置仍在后台加载，
          // 继续保留 applying 横幅直到加载完成，再由 loadStoryInitializationSourceConfig 收尾。
          const afterResume = storyInitializationRef.current;
          if (afterResume?.flowId === pending.deferredEntry?.flowId && afterResume.sourceConfigLoading) {
            patchStoryInitialization(pending.deferredEntry?.flowId, {
              inferencePhase: "applying",
              inferenceApplyingSourceConfig: true,
              inferencePendingPhase: payload?.apply === true ? "reviewed" : "skipped",
            });
          }
        }
        // 浏览器拿不到本机工程绝对路径：confirmedConfigInferenceSnapshot 在用户选择了
        // 本机匹配（localProjectBindings 带 projectId）或纠正后（corrected）时返回 null，
        // 此时必须等服务端按本机绑定解析的 snapshot（review 成功返回 result.snapshot；
        // 失败时返回 rememberConfigInferenceReviewLocalBindings 的 confirmedSnapshot）再补应用。
        const needsServerApply = payload?.apply === true && !confirmedSnapshot;
        Promise.resolve().then(() => devbenchApi.reviewConfigInference(
          reviewProjectId,
          pending.session.id,
          payload,
        )).then((result) => {
          const current = storyInitializationRef.current;
          const flowAlive = current?.flowId === pending.deferredEntry?.flowId;
          const serverSnapshot = configInferenceSnapshotForReviewResult(result, payload, confirmedSnapshot);
          // 用户确认后尚未编辑/提交草稿（draft identity 与上次 resume 一致）时才补应用，
          // 避免服务端响应到达时覆盖用户已在初始化面板上的手动修改。
          // applying 阶段表示 AI 建议正在回填/源码配置仍在加载，仍属于"未人工编辑"，可继续补应用。
          const expectedPhase = payload?.apply === true ? "reviewed" : "skipped";
          const untouched = flowAlive
            && !current.busy
            && !current.partialRecovery
            && (current.inferencePhase === expectedPhase || current.inferencePhase === "applying")
            && String(storyInitializationDraftIdentity(current.currentDraft || current.initialDraft))
              === String(current.reviewedIdentity || "");
          if (needsServerApply && serverSnapshot && untouched) {
            resumeStoryInitializationAfterInference(
              pending,
              serverSnapshot,
              continuationContext,
            );
            // 服务端补应用后若触发车型源码配置重新加载，继续保留 applying 横幅直到加载完成。
            const afterServerResume = storyInitializationRef.current;
            if (afterServerResume?.flowId === pending.deferredEntry?.flowId
              && afterServerResume.sourceConfigLoading) {
              patchStoryInitialization(pending.deferredEntry?.flowId, {
                inferencePhase: "applying",
                inferenceApplyingSourceConfig: true,
                inferencePendingPhase: "reviewed",
              });
            }
          }
          // 本机匹配确实已应用到草稿时才能声称"已应用"；否则只承诺反馈已保存。
          const applied = payload?.apply === true && (!needsServerApply || (serverSnapshot && untouched));
          if (flowAlive) {
            patchStoryInitialization(current.flowId, {
              inferenceSummary: result?.ok
                ? (applied
                  ? "AI 建议已应用到当前草稿，反馈已在后台保存；可继续编辑或创建。"
                  : payload?.apply === true
                    ? "AI 建议反馈已保存；确认的配置将在本机可用后应用，可先继续编辑或创建。"
                    : "本次 AI 建议已暂不采用，反馈已在后台保存；可继续编辑或创建。")
                : "AI 建议反馈保存失败；当前草稿与创建流程不受影响。",
            });
          }
          if (!result?.ok) showToast("AI 建议反馈保存失败；当前草稿与创建流程不受影响");
        }).catch(() => {
          const current = storyInitializationRef.current;
          if (current?.flowId === pending.deferredEntry?.flowId) {
            patchStoryInitialization(current.flowId, {
              inferenceSummary: "AI 建议反馈保存失败；当前草稿与创建流程不受影响。",
            });
          }
          showToast("AI 建议反馈保存失败；当前草稿与创建流程不受影响");
        });
      } finally {
        if (configInferenceSubmissionGuardRef.current.release(submissionToken)) {
          setConfigSuggestBusy(false);
        }
      }
      return;
    }
    if (dismissStoryInitializationSkip) {
      configInferencePresentationGuardRef.current.suppress(pending.session?.id);
      setConfigSuggest(null);
      markStoryInitializationSkipReviewPending(pending, payload);
    }
    try {
      // 普通故事点的“暂不采用”不能被反馈接口反向卡住：先关弹窗并继续原入口，反馈降为 best-effort。
      // 组内自动续跑仍保留服务端强制复核门禁，必须成功写 review 才能 continue-group。
      if (skipRequested
        && !strictGroupGate
        && !reopenReviewRequired
        && !requiresSavedStoryCreationReview(pending)) {
        configInferencePresentationGuardRef.current.suppress(pending.session?.id);
        setConfigSuggest(null);
        Promise.resolve().then(() => devbenchApi.reviewConfigInference(
          reviewProjectId,
          pending.session.id,
          payload,
        )).then((result) => {
          if (!result?.ok) showToast("已暂不采用并继续开发；本次推理反馈记录失败");
        }).catch(() => showToast("已暂不采用并继续开发；本次推理反馈记录失败"));

        if (isDeferredGitCommitStoryEntry(pending)) {
          showToast("已暂不采用本次 AI 配置推理，评审故事点未创建");
          const nextBatch = Array.isArray(pending.deferredEntry?.batchQueue)
            ? pending.deferredEntry.batchQueue
            : [];
          if (nextBatch.length) {
            const next = await startNextGitCommitBatchInference(nextBatch);
            if (!next?.ok) showToast(next?.error || "下一条 Git commit 的 AI 推理启动失败");
          }
        } else if (shouldContinueDeferredStoryEntry(pending)) {
          await continueDeferredStoryEntry(pending, null);
        } else if (pending.kickAfter && pending.task) {
          await kickTbWorkflow(pending.task, pending.tabId);
        }
        return;
      }

      // 任务列表入口后续还要写复核、创建故事点、绑定 TB、载入工作流，这些都不应占住复核弹窗。
      // 用户确认后该 run 的推理页进入终态；反馈失败只做非模态提示，已确认的服务端快照照常应用。
      // 服务端保存成功后，即使建故事点失败也不重复要求复核。
      if (dismissBeforeReview) {
        configInferencePresentationGuardRef.current.suppress(pending.session?.id);
        setConfigSuggest(null);
        showToast("已确认，正在后台保存推理结果并继续故事点流程…");
      }

      const reviewed = await devbenchApi.reviewConfigInference(
        reviewProjectId,
        pending.session.id,
        payload,
      );
      if (!reviewed?.ok) {
        if (dismissStoryInitializationSkip) {
          const retryPending = reviewed?.stale && reviewed?.refreshed && reviewed?.data
            ? replaceConfigSuggestWithRefreshedSession(pending, pending.session?.id, reviewed)
            : pending;
          const reason = reviewed?.error || "保存配置推断复核失败";
          if (markStoryInitializationSkipReviewFailed(retryPending, payload, reason)) {
            showToast("暂不采用决定保存失败，请在初始化面板重试");
          }
          return;
        }
        if (reviewFailurePolicy === "continue_without_reopen") {
          await continueDeferredStoryEntryAfterReviewFailure(
            pending,
            configInferenceSnapshotForReviewResult(reviewed, payload, confirmedSnapshot),
            reviewed?.error || "保存配置推断复核失败",
          );
          return;
        }
        if (reviewed?.stale && reviewed?.refreshed && reviewed?.data) {
          if (!dismissBeforeReview) {
            setConfigSuggest((current) => replaceConfigSuggestWithRefreshedSession(
              current,
              pending.session?.id,
              reviewed,
            ));
          }
          showToast(reviewed?.error || "推理规则已升级，旧结果已按当前配置和 RAG 重算，请确认新结果后重新提交");
          return;
        }
        showToast(reviewed?.error || "保存配置推断复核失败");
        return;
      }
      reviewSaved = true;
      setConfigInferenceReviewWarning(null);
      const reopenReview = configInferenceReopenReviewProof(pending, reviewProjectId);
      const configUpdateText = reviewed.configurationUpdates?.changed ? "；自定义值已同步到仓库定义和车型源码配置" : "";
      const unresolvedCount = (reviewed.configurationUpdates?.unresolved || []).reduce((sum, row) => sum + (row.fields?.length || 0), 0);
      const symbolicUpdateText = unresolvedCount ? `；${unresolvedCount} 个代号字段已记忆，待替换实际值后再写入工程配置` : "";
      const applicableSnapshot = configInferenceSnapshotForReviewResult(reviewed, payload, confirmedSnapshot);
      const continuationContext = {
        localProjectBindings: payload?.localProjectBindings,
        reopenReview,
        reviewDecision: payload?.decision || "",
        apply: payload?.apply === true,
      };

      // 任务列表入口在 review 成功前没有故事点。此处才创建/打开，随后应用快照，最后启动原工作流。
      if (isDeferredGitCommitStoryEntry(pending)) {
        configInferencePresentationGuardRef.current.suppress(pending.session?.id);
        setConfigSuggest(null);
        const continued = await continueDeferredStoryEntry(
          pending,
          applicableSnapshot,
          continuationContext,
        );
        return;
      }
      if (isDeferredStoryInitializationPanelEntry(pending)) {
        const continued = await continueDeferredStoryEntry(
          pending,
          applicableSnapshot,
          continuationContext,
        );
        if (!continued?.ok) throw new Error(continued?.error || "恢复初始化配置面板失败");
        setConfigSuggest(null);
        return;
      }
      if (shouldContinueDeferredStoryEntry(pending)) {
        setConfigSuggest(null);
        await continueDeferredStoryEntry(
          pending,
          applicableSnapshot,
          continuationContext,
        );
        return;
      }

      if (applicableSnapshot) {
        const applied = await devbenchApi.applyConfig(pending.tabId, applicableSnapshot);
        if (!applied?.ok) {
          showToast(applied?.error || "应用复核后的工程配置失败");
          return;
        }
        await Promise.all([reloadTabs(), reloadProjects()]);
        const names = (applied.data?.applied || []).join("、") || "完成";
        showToast(`已保存反馈并应用工程配置：${names}${configUpdateText}${symbolicUpdateText}`);
      } else {
        await reloadTabs();
        const snapshotUnavailableText = reviewed.snapshotUnavailable?.error ? `；${reviewed.snapshotUnavailable.error}` : "";
        showToast(payload?.decision === "insufficient" ? "已记录信息不足，本次保留当前配置" : `已保存配置推断反馈${configUpdateText}${symbolicUpdateText}${snapshotUnavailableText}`);
      }
      if (pending.continueAction === "group_auto") {
        const continued = await devbenchApi.workflowContinueGroup(pending.tabId, pending.session.id);
        if (!continued?.ok) {
          showToast(continued?.error || "组内配置已复核，但继续开发失败");
          return;
        }
        // 服务端门禁已确认通过后，本次 run 也进入终态。抑制此前已排队的 WS/reload
        // 回调，避免它们在弹窗关闭后用旧 payload 再次展示同一条推理。
        configInferencePresentationGuardRef.current.suppress(pending.session?.id);
        if (continued.data?.started) setRunningTabs((current) => new Set(current).add(pending.tabId));
        await reloadTabs();
      } else if (pending.kickAfter && pending.task) {
        await kickTbWorkflow(pending.task, pending.tabId);
      }
      setConfigSuggest(null);
    } catch (error) {
      if (dismissStoryInitializationSkip && !reviewSaved) {
        if (markStoryInitializationSkipReviewFailed(pending, payload, error?.message || "网络请求失败")) {
          showToast("暂不采用决定保存失败，请在初始化面板重试");
        }
        return;
      }
      if (dismissBeforeReview
        && !skipRequested
        && !reviewSaved) {
        await continueDeferredStoryEntryAfterReviewFailure(
          pending,
          confirmedSnapshot,
          error?.message || "网络请求失败",
        );
        return;
      }
      showToast(reviewSaved || skipRequested
        ? `${reviewSaved ? "推理复核已保存" : "已暂不采用"}，但创建故事点失败：${error?.message || "未知错误"}`
        : (error?.message || "保存配置推断复核失败"));
    } finally {
      if (configInferenceSubmissionGuardRef.current.release(submissionToken)) {
        setConfigSuggestBusy(false);
      }
    }
  }

  // 半自动：手动点「开始 AI 甄别」
  // 点「开始 AI 甄别」：若后端 remoteSyncStatus.upToDate 已标记为最新（初始化 / Git Update / 上次拉取写回），
  // 则跳过拉取确认窗；否则先弹窗问是否拉取远程最新。
  function onStartTriage(tabId) {
    const tab = tabs.find((t) => t.id === tabId);
    if (tab?.remoteSyncStatus?.upToDate === true) {
      runTriage(tabId);
      return;
    }
    setPullModal({ tabId });
  }

  // 真正发起甄别（「开始 AI 甄别」）。附件较多/较大不阻塞：超阈值时后端跳过自动下载，
  // 仅返回 attachSkipNote 做非阻塞提示（可在 TB 附件清单里逐一下载供 AI 阅读）。
  async function runTriage(tabId, _opts = {}) {
    setRunningTabs((s) => new Set(s).add(tabId)); // 立即反映"运行中"，等 WS 流式接管
    const r = await devbenchApi.workflowTriage(tabId, {});
    // 后端不再用需要下载的硬闸门阻断甄别；仅作防御性兼容：若仍收到 needConfirm 旧响应，
    // 不弹确认窗，而是退化为"跳过下载直接甄别"，避免弹窗流程卡住用户。
    const effective = (r?.needConfirm || r?.data?.needConfirm)
      ? { ...r, ok: true, data: r && r.data ? r.data : r }
      : r;
    let attachNote = "";
    const payload = effective.data || effective;
    const skipNote = payload?.attachSkipNote;
    if (skipNote) attachNote = `；附件${skipNote.count || ""}${skipNote.reason ? `（${skipNote.reason}）` : ""}未自动下载，需要阅读时可在 TB 附件清单里逐一下载`;
    if (!effective.ok) {
      setRunningTabs((s) => { const n = new Set(s); n.delete(tabId); return n; });
      showToast((effective.error || "无法开始甄别") + (attachNote || ""));
      return;
    }
    const flow = payload?.flow;
    if (flow?.ok && !flow.skipped && flow.to) showToast(`TB 状态已切为「${flow.to}」，开始 AI 甄别…${attachNote}`);
    else if (flow && !flow.ok) showToast(`已开始 AI 甄别；但 TB 状态流转失败（${flow.error || "需联调"}）${attachNote}`);
    else showToast(`已开始 AI 甄别…${attachNote}`);
    await reloadTabs();
  }

  // 手动「核对修复完成」：跑一轮让 AI 核对；只有输出 FIX_DONE 才进入自我验收。
  async function onMarkFixed(tabId) {
    setRunningTabs((s) => new Set(s).add(tabId));
    const r = await devbenchApi.workflowMarkFixed(tabId);
    if (!r.ok) {
      setRunningTabs((s) => { const n = new Set(s); n.delete(tabId); return n; });
      showToast(r.error || "无法启动修复完成核对");
    } else showToast("正在核对修复并收尾（完成后进入【自我验收】）…");
  }

  // 第三步「开始自我验收 / 执行验收」：需绑定设备，否则后端返回 blocked 并醒目提示
  async function onStartVerify(tabId) {
    const r = await devbenchApi.workflowVerify(tabId);
    if (!r.ok) {
      showToast(r.error || (r.blocked ? "请先绑定目标设备再执行验收" : "无法开始验收"));
      await reloadTabs();
      return;
    }
    setRunningTabs((s) => new Set(s).add(tabId));
    showToast("已开始自我验收（生成测试 / 打 debug+release 包 / 设备复现验证）…");
    await reloadTabs();
  }

  // 第三步收尾「生成报告并提交」：整理全量支撑文档 + 简短报告 → 评论/附件/流转可提测
  async function onStartReport(tabId) {
    const r = await devbenchApi.workflowReport(tabId);
    if (!r.ok) { showToast(r.error || "无法生成报告"); return; }
    if (r.deterministic || r.resumed || r.data?.deterministic || r.data?.resumed) {
      showToast(r.pending || r.data?.pending
        ? "确定性报告已生成，TB 同步仍有未确认步骤"
        : "报告与 TB 同步已完成");
      await reloadTabs();
      return;
    }
    setRunningTabs((s) => new Set(s).add(tabId));
    showToast(r.data?.reportMode === "expert"
      ? "正在生成专家 HTML/PDF 报告并提交 TB…"
      : "正在生成原因/措施短评并提交 TB（不生成附件）…");
    await reloadTabs();
  }

  // sync_pending 只重试后端已经冻结的 TB 同步 payload：报告/组走 report，拒绝走 reject。
  // 前端不重建评论、附件或幂等键，刷新后仍以服务端持久状态为准。
  async function onRetryTbSync(tabId, action) {
    const isReject = action === "reject";
    const r = isReject
      ? await devbenchApi.workflowReject(tabId)
      : await devbenchApi.workflowReport(tabId);
    if (!r?.ok) {
      showToast(r?.error || "TB 同步重试未启动");
      await reloadTabs();
      return r;
    }
    const settledInline = r.resumed || r.deterministic || r.data?.resumed || r.data?.deterministic;
    if (!isReject && !settledInline) setRunningTabs((current) => new Set(current).add(tabId));
    showToast(settledInline
      ? "TB 同步重试已完成"
      : (isReject ? "正在重试已冻结的 TB 拒绝同步…" : "正在重试已冻结的 TB 报告同步…"));
    await reloadTabs();
    return r;
  }

  async function onStartCodeReview(tabId) {
    setRunningTabs((current) => new Set(current).add(tabId));
    const result = await devbenchApi.startGitCommitReview(tabId);
    const payload = result?.data && typeof result.data === "object" ? result.data : result;
    if (!result?.ok || payload?.started === false) {
      setRunningTabs((current) => {
        const next = new Set(current);
        next.delete(tabId);
        return next;
      });
      showToast(result?.error || payload?.error || payload?.reason || "无法开始代码评审");
      await reloadTabs();
      return result;
    }
    showToast("已冻结最新分支基线，代码评审专家正在执行只读审查与静态验证…");
    await reloadTabs();
    return result;
  }

  // 切换工作流自动化档位（semi 半自动 / full 全自动）
  async function onSetAutoMode(tabId, mode) {
    const r = await devbenchApi.workflowAutoMode(tabId, mode);
    if (r.ok) {
      await reloadTabs();
      showToast(mode === "full" ? "已切到全自动（工程就绪即自动甄别）" : "已切到半自动（手动 / 发消息触发甄别）");
    } else showToast(r.error || "切换失败");
  }

  async function onSetWorkflowPhase(tabId, phase) {
    const r = await devbenchApi.workflowSetPhase(tabId, phase);
    if (!r?.ok) {
      showToast(r?.error || "切换工作流步骤失败");
      return r;
    }
    await reloadTabs();
    showToast(`已切换工作流步骤：${r.data?.label || phase}`);
    return r;
  }

  // 报告模式按故事点/TB 单独立保存，不跟随工程配置复制，也不在组队成员间共享。
  async function onSetReportMode(tabId, mode) {
    const r = await devbenchApi.workflowReportMode(tabId, mode);
    if (r.ok) {
      await reloadTabs();
      showToast(mode === "expert"
        ? "已切到专家报告模式：生成图文影音 HTML，并转换为 PDF 回传 TB"
        : "已切到简短模式：TB 只回写原因和措施，不生成报告附件");
    } else showToast(r.error || "报告模式保存失败");
  }

  async function onSetSkipTestAcceptance(tabId, skipped) {
    const r = await devbenchApi.workflowSkipTestAcceptance(tabId, skipped);
    if (r.ok) {
      await reloadTabs();
      showToast(skipped
        ? (r.scope === "group" ? "已为整个故事点组跳过测试验收；整组修复完成后直接进入报告" : "已跳过测试验收；修复完成后直接进入报告")
        : (r.scope === "group" ? "已为整个故事点组恢复测试验收流程" : "已恢复测试验收流程"));
    } else showToast(r.error || "测试验收选项保存失败");
    return r;
  }

  // 复制本故事点工程配置到剪贴板（localStorage，跨故事点/刷新可用）
  async function onCopyConfig(tabId) {
    const r = await devbenchApi.getConfigSnapshot(tabId);
    if (!r.ok) { showToast(r.error || "复制失败"); return; }
    setConfigClip(r.data);
    try { localStorage.setItem("devbench_config_clip", JSON.stringify(r.data)); } catch {}
    showToast(`已复制「${r.data.sourceTitle || "故事点"}」的工程配置，可到其它故事点点「应用配置」`);
  }
  // 一键应用剪贴板里的工程配置到指定故事点
  async function onApplyConfig(tabId) {
    if (!configClip) { showToast("还没有复制任何工程配置"); return; }
    const r = await devbenchApi.applyConfig(tabId, configClip);
    if (!r.ok) { showToast(r.error || "应用失败"); return; }
    await Promise.all([reloadTabs(), reloadProjects()]);
    const d = r.data || {};
    let msg = `已应用工程配置：${(d.applied || []).join("、") || "无"}`;
    if (d.tookOver?.length) msg += `；已接管${d.tookOver.join("、")}`;
    if (d.warnings?.length) msg += `；注意：${d.warnings.join("；")}`;
    showToast(msg);
  }

  async function openStoryConfiguration(tabId) {
    const current = (tabsRef.current || []).find((item) => item.id === tabId);
    if (!current) { showToast("故事点不存在或已关闭"); return; }
    const snapshotResult = await devbenchApi.getConfigSnapshot(tabId);
    if (!snapshotResult?.ok) { showToast(snapshotResult?.error || "读取故事点配置失败"); return; }
    const editableSnapshot = storyConfigurationSnapshotForEditing(snapshotResult.data);
    const result = await requestStoryInitialization({
      mode: "edit",
      body: { title: current.title, ticketInput: current.ticketUrl || "" },
      snapshot: editableSnapshot,
      tab: current,
      sourceLabel: "当前故事点配置",
      apply: async (draft) => {
        const applied = await devbenchApi.applyConfig(
          tabId,
          storyConfigurationSnapshot(draft, projects),
        );
        if (!applied?.ok) return applied;
        const appliedParts = ["工程配置"];
        if ((draft.ticketInput || "").trim() !== (current.ticketUrl || "").trim()) {
          const ticket = await devbenchApi.setTicket(tabId, draft.ticketInput || "");
          if (!ticket?.ok) {
            return { ok: false, error: `${appliedParts.join("、")}已应用，但 TB 绑定更新失败：${ticket?.error || "未知错误"}` };
          }
          appliedParts.push("TB 绑定");
        }
        if ((draft.title || "").trim() !== (current.title || "").trim()) {
          const renamed = await devbenchApi.renameTab(tabId, draft.title);
          if (!renamed?.ok) {
            return { ok: false, error: `${appliedParts.join("、")}已应用，但标题更新失败：${renamed?.error || "未知错误"}` };
          }
          appliedParts.push("标题");
        }
        const nextReportMode = draft.reportMode === "expert" ? "expert" : "short";
        const currentReportMode = current.reportMode === "expert" ? "expert" : "short";
        if (nextReportMode !== currentReportMode) {
          const reportModeResult = await devbenchApi.workflowReportMode(tabId, nextReportMode);
          if (!reportModeResult?.ok) {
            return { ok: false, error: `${appliedParts.join("、")}已应用，但报告模式更新失败：${reportModeResult?.error || "未知错误"}` };
          }
          appliedParts.push("报告模式");
        }
        const nextArchiveDir = draft.archiveMode === "custom" ? String(draft.archiveDir || "").trim() : "";
        const currentArchiveDir = String(current.archiveDir || "").trim();
        if (nextArchiveDir !== currentArchiveDir) {
          const archiveResult = await devbenchApi.setArchiveDir(tabId, nextArchiveDir);
          if (!archiveResult?.ok) {
            return { ok: false, error: `${appliedParts.join("、")}已应用，但存档目录更新失败：${archiveResult?.error || "未知错误"}` };
          }
          appliedParts.push("存档目录");
        }
        await Promise.all([reloadTabs(), reloadProjects()]);
        showToast(`已更新：${appliedParts.join("、")}`);
        return { ok: true, data: applied.data };
      },
    });
    return result;
  }

  // 附件超阈值：用户在弹窗勾选后批量下载（进度走 WS devbench_attach_progress）
  async function onConfirmDownloadAttachments(items) {
    const tabId = attachConfirm?.tabId; if (!tabId) return;
    const pendingTriage = !!attachConfirm?.pendingTriage;
    setAttachProgress({ tabId, total: items.length, files: {}, finished: false });
    const r = await devbenchApi.downloadTbAttachmentsBatch(tabId, items);
    if (!r.ok) {
      showToast(r.error || "批量下载失败");
      return;
    }
    if (pendingTriage) {
      // 下载完成后继续甄别；已下载的不再触发阈值闸门
      setAttachConfirm(null);
      setAttachProgress(null);
      await runTriage(tabId, { skipAttachConfirm: true });
    }
  }

  function onSkipAttachConfirm() {
    const tabId = attachConfirm?.tabId;
    const pendingTriage = !!attachConfirm?.pendingTriage;
    setAttachConfirm(null);
    setAttachProgress(null);
    if (pendingTriage && tabId) runTriage(tabId, { skipAttachConfirm: true });
  }

  // 自愈：故事点标题的 #CARB-xxx# 前缀若与任务 carbId 不符（早期同步串号留下的），改回正确单号
  async function fixStoryTitle(tabId, currentTitle, carbId) {
    if (!tabId || !carbId || !currentTitle) return;
    const m = currentTitle.match(/^#(CARB-\d+)#/i);
    if (m && m[1].toUpperCase() !== String(carbId).toUpperCase()) {
      const fixed = repairStoryTitleCarbId(currentTitle, carbId);
      try { await devbenchApi.renameTab(tabId, fixed); } catch {}
    }
  }

  async function applyReviewedInferenceSnapshot(tabId, snapshot) {
    if (!snapshot) return true;
    const applied = await devbenchApi.applyConfig(tabId, snapshot);
    if (!applied?.ok) {
      showToast(applied?.error || "应用复核后的工程配置失败，尚未启动开发工作流");
      return false;
    }
    await Promise.all([reloadTabs(), reloadProjects()]);
    const names = (applied.data?.applied || []).join("、") || "完成";
    showToast(`已应用 AI 推理工程配置：${names}`);
    return true;
  }

  // 恢复已关闭故事点后的统一收尾：重绑任务、补关联工单、自愈标题、激活并载入历史、配置复核后触发工作流。
  // skipKick=true：先打开但不触发工作流（如正在复制工程，工程就绪后再说）。
  async function finishReopen(rr, task, msg, {
    skipKick = false,
    deferInference = false,
    inferenceResolved = false,
    reviewedSnapshot = null,
  } = {}) {
    try { if (rr.data.id !== task.tabId) await devbenchApi.updateTask(task.id, { tabId: rr.data.id }); } catch {}
    const ticketVal = task.ticketUrl || task.title;
    if (ticketVal && !(rr.data.ticketUrl || "").trim()) { try { await devbenchApi.setTicket(rr.data.id, ticketVal); } catch {} }
    await fixStoryTitle(rr.data.id, rr.data.title, task.carbId);
    await reloadTabs(); setActive(rr.data.id); loadMessages(rr.data.id); setShowTasks(false);
    if (msg) showToast(msg);
    if (deferInference) return rr.data.id;
    if (inferenceResolved) {
      const applied = await applyReviewedInferenceSnapshot(rr.data.id, reviewedSnapshot);
      if (applied && !skipKick) await kickTbWorkflow(task, rr.data.id);
    } else {
      await requestConfigInference({
        tabId: rr.data.id,
        task,
        trigger: "task_reopened",
        title: rr.data.title || task.title || "",
        kickAfter: !skipKick,
      });
    }
    return rr.data.id;
  }

  // 复制工程完成（WS done）后：把复制出的新路径落到该故事点，并解锁
  async function applyCopiedProject(tabId, newPath, newName) {
    const intent = copyApplyRef.current[tabId];
    delete copyApplyRef.current[tabId];
    try {
      if (!intent || intent.isPrimary) {
        await devbenchApi.setTabLocalSource(tabId, newPath, newName);
      } else {
        if (intent.exPath) await devbenchApi.removeExtra(tabId, intent.exPath);
        await devbenchApi.addExtra(tabId, newPath, newName);
      }
    } catch {}
    await reloadTabs();
    showToast(`工程副本已就绪并设为本故事点工程：${newName}`);
    if (intent?.inferenceResolved) {
      const applied = await applyReviewedInferenceSnapshot(tabId, intent.reviewedSnapshot || null);
      if (applied && intent.kickAfter) await kickTbWorkflow(intent.task, tabId);
    } else {
      await requestConfigInference({
        tabId,
        task: intent?.task || null,
        trigger: "task_reopened_after_copy",
        kickAfter: false,
      });
    }
  }

  // 历史工程冲突弹窗「应用」：设备动作继续兼容旧载荷，但共享绑定模式绝不解绑其它故事点。
  // remaps: { [被占用工程名]: { projectId } | { path } | { copy:{...} } }
  // deviceActions: { [serial]: "take"(为本故事点共享绑定) | "release"(本故事点不绑定该设备) }
  function cancelProjConflict() {
    const entryToken = projConflict?.entryToken || "";
    setProjConflict(null);
    finishStoryEntry(entryToken);
  }

  async function applyProjConflict(remaps, deviceActions = {}) {
    const c = projConflict; if (!c) return;
    const entryToken = c.entryToken || "";
    try {
      const rr = await devbenchApi.reopenClosed(c.task.tabId, true, c.reopenReview); // force 打开
      if (!rr.ok) { showToast(rr.error || "打开失败"); setProjConflict(null); return; }
      const tabId = rr.data.id;
      // 快照可能重新绑定冲突资源，不能在用户处理 remap/copy/device 之前或之后自动套用。
      const skippedInferenceSnapshot = shouldSkipReviewedSnapshotForConflict(c.reviewedSnapshot);
      const primName = (projects || []).find((p) => p.id === rr.data.primaryProjectId)?.name;
      const baseName = (s) => String(s || "").split(/[\\/]+/).pop();
      let copyStarted = false;
      let copyFailed = false;
      // 兼容旧弹窗动作：take 只绑定当前故事点，不再释放其它故事点。
      for (const [serial, act] of Object.entries(deviceActions || {})) {
        try {
          if (act === "release") { await devbenchApi.releaseDevice(tabId); }
          else if (act === "take") await devbenchApi.bindDevice(tabId, serial);
        } catch {}
      }
      for (const [occName, repl] of Object.entries(remaps || {})) {
        if (!repl) continue;
        // 复制一份：先打开故事点（见下），这里只【启动】后台异步复制（带进度、复制期间锁定），完成后由 WS 落地
        if (repl.copy) {
          const isPrimary = occName === primName;
          const ex = !isPrimary ? (rr.data.extraProjects || []).find((e) => e.name === occName || baseName(e.path) === occName) : null;
          copyApplyRef.current[tabId] = {
            occName,
            isPrimary,
            exPath: ex?.path || null,
            task: c.task,
            inferenceResolved: c.inferenceResolved === true,
            reviewedSnapshot: null,
            kickAfter: c.kickAfter !== false,
          };
          const cr = await devbenchApi.copyProject(tabId, repl.copy);
          if (!cr.ok) { copyFailed = true; showToast(cr.error || "启动复制失败"); delete copyApplyRef.current[tabId]; }
          else { copyStarted = true; setCopyMap((m) => ({ ...m, [tabId]: { phase: "copying", copied: 0, total: 0 } })); }
          continue;
        }
        // 非复制：立即应用
        const projectId = repl.projectId || null, path = repl.path || null;
        if (!projectId && !path) continue;
        try {
          if (occName === primName) {
            if (projectId) await devbenchApi.setPrimary(tabId, projectId);
            else if (path) await devbenchApi.setTabLocalSource(tabId, path, baseName(path));
          } else {
            const ex = (rr.data.extraProjects || []).find((e) => e.name === occName || baseName(e.path) === occName);
            if (ex) await devbenchApi.removeExtra(tabId, ex.path);
            if (projectId) { const p = (projects || []).find((x) => x.id === projectId); if (p) await devbenchApi.addExtra(tabId, p.path, p.name); }
            else if (path) await devbenchApi.addExtra(tabId, path, baseName(path));
          }
        } catch {}
      }
      setProjConflict(null);
      const inferenceNote = skippedInferenceSnapshot
        ? "；因资源占用，已保留你在冲突窗口选择的工程/设备，未自动应用 AI 工程快照"
        : "";
      // 先打开/激活故事点（满足"先打开故事点后才复制工程"）；复制中不触发工作流，工程就绪后再由用户继续
      await finishReopen(rr, c.task,
        `${copyStarted ? "已打开故事点，正在复制工程…（复制期间不可对话/编辑/下载附件）"
          : copyFailed ? "故事点已打开，但工程复制启动失败，尚未启动工作流"
          : (Object.keys(remaps || {}).length ? "已更改工程并打开故事点" : "已强制打开故事点")}${inferenceNote}`,
        {
          skipKick: copyStarted || copyFailed,
          deferInference: copyStarted,
          inferenceResolved: c.inferenceResolved === true,
          reviewedSnapshot: null,
        });
    } finally {
      finishStoryEntry(entryToken);
    }
  }

  async function createConfiguredTaskStoryPoint(task, {
    activate = false,
    closeTasks = false,
    kick = false,
    announce = false,
    reviewedSnapshot = null,
    inferenceSession = null,
    inferenceProofSession = inferenceSession,
    inferenceDecision = inferenceSession ? "reviewed" : "",
    localProjectBindings = [],
    sharedConfigurationSnapshot = null,
    sharedConfigurationSource = "",
  } = {}) {
    const scopedTask = task?.storyTitle ? task : planTaskStory(task);
    const title = scopedTask.storyTitle;
    const projId = task.projectId || task._projectId || currentProjectId;
    let recognized = { app: "", vehicle: "" };
    try {
      const cap = await devbenchApi.captureTitle(task.title || "", projId);
      if (cap.ok) recognized = cap.data.recognized || recognized;
    } catch {}
    const isTb = !!(task.tbTaskId || /task\/[0-9a-fA-F]{24}/.test(task.ticketUrl || ""));
    const availLocal = (projects || []).filter((project) => project.exists);
    const useRemoteFallback = !reviewedSnapshot && isTb && availLocal.length === 0;
    const r = await requestStoryInitialization({
      body: { title, tbProjectId: projId },
      task: scopedTask,
      snapshot: reviewedSnapshot,
      sourceLabel: isTb ? "TB 单创建" : "任务列表创建",
      inferenceEnabled: !!inferenceSession,
      inferenceSession,
      inferenceProofSession,
      inferenceDecision,
      localProjectBindings,
      sharedConfiguration: sharedConfigurationSnapshot ? {
        snapshot: sharedConfigurationSnapshot,
        sourceLabel: sharedConfigurationSource,
      } : null,
      initialOverrides: {
        tbProjectId: projId,
        ...(useRemoteFallback ? {
          mode: "remote",
          vehicle: recognized.vehicle || "",
          projectDefId: projectDefs[0]?.id || "",
        } : {}),
      },
      entry: taskStoryCreateEntry(scopedTask) || { kind: "task_story", title },
    });
    if (!r.ok) {
      if (!r.cancelled) showToast(r.error || "新建故事点失败");
      return null;
    }
    const tabId = r.data.id;
    if (task.id) {
      try { await devbenchApi.updateTask(task.id, { tabId }); } catch {}
    }
    const createdTitle = r.data?.title || title;
    const recoMsg = recoText(recognized);
    if (announce) showToast(`已按初始化配置创建故事点：${createdTitle}${recoMsg}`);
    if (activate) {
      await reloadTabs();
      setActive(tabId);
      if (closeTasks) setShowTasks(false);
    }
    setMsgMap((prev) => (prev[tabId] === undefined ? { ...prev, [tabId]: [] } : prev));
    if (kick) {
      const initializationPending = ["queued", "preparing"].includes(r.data?.workspaceInitialization?.status)
        || ["queued", "cloning"].includes(r.data?.cloneStatus)
        || ["queued", "preparing"].includes(r.data?.worktreeStatus);
      if (initializationPending) {
        showToast("故事点已创建，工作区正在后台初始化；完成后将自动启动开发流程");
        void waitForStoryWorkspaceReady(tabId).then(async (ready) => {
          if (!ready.ok) {
            showToast(`${ready.error}；尚未自动启动开发流程`);
            return;
          }
          await kickTbWorkflow(task, tabId);
        });
      } else {
        await kickTbWorkflow(task, tabId);
      }
    }
    return { tabId, title: createdTitle, recognized };
  }

  async function startDevFromTask(task) {
    const entryToken = beginStoryEntry("task");
    if (!entryToken) return;
    const scopedTask = planTaskStory(task);
    let keepEntryLock = false;
    try {
      if (!task.tabId) {
        const result = await continueTaskDevFromTask(scopedTask, { reviewedSnapshot: null, entryToken });
        keepEntryLock = result?.keepEntryLock === true;
        return;
      }
      const inferenceSetting = await resolveStoryPointAiInferenceEnabled();
      if (!inferenceSetting.ok) { showToast(inferenceSetting.error); return; }
      if (shouldDeferStoryEntry({ enabled: inferenceSetting.enabled, kind: "task", task })) {
        const requested = await requestConfigInference({
          task,
          trigger: task.tabId ? "task_execute_again" : "task_execute",
          title: task.title || "",
          kickAfter: true,
          deferredEntry: { kind: "task", task: scopedTask, entryToken },
        });
        if (requested) {
          keepEntryLock = true;
          setShowTasks(false);
        }
        return;
      }
      const result = await continueTaskDevFromTask(scopedTask, { reviewedSnapshot: null, entryToken });
      keepEntryLock = result?.keepEntryLock === true;
    } finally {
      if (!keepEntryLock) finishStoryEntry(entryToken);
    }
  }

  // 已完成推理复核（或开关关闭）后才进入这里；本函数不会再次触发配置推理。
  async function continueTaskDevFromTask(task, {
    reviewedSnapshot = null,
    inferenceSession = null,
    inferenceProofSession = inferenceSession,
    inferenceDecision = inferenceSession ? "reviewed" : "",
    localProjectBindings = [],
    reopenReview = null,
    entryToken = "",
  } = {}) {
    // 已绑定的故事点优先复用，避免重复新建
    if (task.tabId) {
      let opened = (tabsRef.current || []).find((t) => t.id === task.tabId);
      if (!opened) {
        const latestTabs = await reloadTabs();
        opened = latestTabs.find((t) => t.id === task.tabId);
      }
      if (opened) {
        await fixStoryTitle(task.tabId, opened.title, task.carbId);
        const applied = await applyReviewedInferenceSnapshot(task.tabId, reviewedSnapshot);
        await reloadTabs();
        setActive(task.tabId);
        setShowTasks(false);
        if (!applied) return;
        showToast("已切到该任务的故事点，正在启动开发工作流");
        await kickTbWorkflow(task, task.tabId);
        return;
      }
      const rr = await devbenchApi.reopenClosed(task.tabId, false, reopenReview);
      // 关键：恢复出的是新 id，必须把任务重绑到新 id，否则下次又会再恢复一份 → 重复故事点
      if (rr.ok) {
        await finishReopen(rr, task, "已重新打开该任务的故事点（聊天记录已恢复）", {
          inferenceResolved: true,
          reviewedSnapshot,
        });
        return;
      }
      // 409=工程/设备被占用 → 弹冲突窗，列出被占用的工程与设备，让用户处理后重试（不重建）
      if (/占用/.test(rr.error || "")) {
        showToast(rr.error);
        const occupied = parseOccupiedProjects(rr.conflicts, rr.error);
        const occupiedDevices = parseOccupiedDevices(rr.conflicts, rr.error);
        // 传全部工程 + 已占用路径集合：下拉里被占用的置灰不可选，并显示分支/是否含 WebApp
        setProjConflict({
          task,
          error: rr.error,
          occupied,
          occupiedDevices,
          projects: projects || [],
          occupiedPaths: otherOccupied,
          inferenceResolved: true,
          reviewedSnapshot,
          reopenReview,
          kickAfter: true,
          entryToken,
        });
        return { keepEntryLock: true };
      }
      // 故事点已彻底不存在(存档也没了) → 落到下面重建并重新绑定
      showToast("原故事点已不存在，正在重建…");
    }
    const created = await createConfiguredTaskStoryPoint(task, {
      activate: true,
      closeTasks: true,
      kick: true,
      announce: true,
      reviewedSnapshot,
      inferenceSession,
      inferenceProofSession,
      inferenceDecision,
      localProjectBindings,
    });
    return created || undefined;
  }

  // 组队开发：选一个已有故事点作为"组锚"，本任务的故事点加入其组（共用工程配置，排队）
  async function teamDevFromTask(task) {
    const r = await devbenchApi.getCopySources(); // { open:[], closed:[] }
    setTeamPick({ task, sources: r.ok ? (r.data || { open: [], closed: [] }) : { open: [], closed: [] } });
  }
  // 确保任务有一个"开着的"故事点 id，并保证 task.tabId 绑定到它（避免重复创建/孤儿）。
  // forGroup=true：组队场景——恢复已关闭故事点时跳过"工程/设备被占用"检查（组本就共用同一套配置）。
  async function ensureTaskStoryPoint(task, forGroup = false, opts = {}) {
    const openTabs = tabsRef.current || tabs || [];
    const ensured = (tabId, disposition) => opts.returnDetails
      ? { tabId, disposition }
      : tabId;
    // 1) 已绑定且开着 → 复用
    if (task.tabId && openTabs.some((t) => t.id === task.tabId)) return ensured(task.tabId, "reused");
    // 2) 已绑定但关闭 → 恢复并【重绑】到新 id（关键：reopen 出的是新 id，不重绑下次会再恢复一份）
    if (task.tabId) {
      const rr = await devbenchApi.reopenClosed(task.tabId, forGroup, opts.reopenReview);
      if (rr.ok) {
        try { if (rr.data.id !== task.tabId) await devbenchApi.updateTask(task.id, { tabId: rr.data.id }); } catch {}
        // 兜底：旧的已关闭快照可能没存 TB 单绑定，恢复后若仍无 ticket → 用任务工单重新关联
        const ticketVal = task.ticketUrl || task.title;
        if (ticketVal && !(rr.data.ticketUrl || "").trim()) { try { await devbenchApi.setTicket(rr.data.id, ticketVal); } catch {} }
        await reloadTabs();
        return ensured(rr.data.id, "reopened");
      }
      if (!forGroup && /占用/.test(rr.error || "")) { showToast(rr.error); return null; }
    }
    // 3) 兜底：已有开着的、关联同一 TB 单的孤儿故事点 → 复用并重绑（防重复创建）
    const key = (task.ticketUrl || "").trim();
    const orphan = key ? (tabsRef.current || tabs || []).find((t) => (t.ticketUrl || "").trim() === key) : null;
    if (orphan) { try { await devbenchApi.updateTask(task.id, { tabId: orphan.id }); } catch {} return ensured(orphan.id, "reused"); }
    // 3.5) 已关闭的【同单号/同名】故事点 → 直接恢复并绑定到本任务（避免与它重名导致新建失败 → 无法组队/重复）
    {
      const cs = await devbenchApi.getCopySources().catch(() => null);
      const closed = cs?.ok ? (cs.data?.closed || []) : [];
      const matchedStoryId = resolveClosedStoryIdForTask(task, closed);
      const match = closed.find((item) => item.id === matchedStoryId);
      if (match) {
        const rr = await devbenchApi.reopenClosed(match.id, true, opts.reopenReview); // 强制恢复（撞名后端会自动改唯一名；否则新建会因与它重名而失败）
        if (rr.ok) {
          try { await devbenchApi.updateTask(task.id, { tabId: rr.data.id }); } catch {}
          const ticketVal = task.ticketUrl || task.title;
          if (ticketVal && !(rr.data.ticketUrl || "").trim()) { try { await devbenchApi.setTicket(rr.data.id, ticketVal); } catch {} }
          return ensured(rr.data.id, "reopened");
        }
      }
    }
    // 4) 真正新建必须由统一初始化面板确认，组队/整组入口也不得走服务端直签绕过。
    const created = await createConfiguredTaskStoryPoint(task, {
      activate: true,
      closeTasks: true,
      kick: false,
      announce: false,
      reviewedSnapshot: opts.reviewedSnapshot || null,
      inferenceSession: opts.inferenceSession || null,
      inferenceProofSession: opts.inferenceProofSession || opts.inferenceSession || null,
      inferenceDecision: opts.inferenceDecision || (opts.inferenceSession ? "reviewed" : ""),
      localProjectBindings: opts.localProjectBindings || [],
      sharedConfigurationSnapshot: opts.sharedConfigurationSnapshot || null,
      sharedConfigurationSource: opts.sharedConfigurationSource || "",
    });
    return created?.tabId ? ensured(created.tabId, "created") : null;
  }

  async function continueTeamDev(source, task, {
    reviewedSnapshot = null,
    inferenceSession = null,
    inferenceProofSession = inferenceSession,
    inferenceDecision = inferenceSession ? "reviewed" : "",
    localProjectBindings = [],
    reopenReview = null,
  } = {}) {
    if (!task || !source?.id) return { ok: false, error: "组队上下文已失效" };
    // 0. 组锚：已关闭的故事点先恢复成活动 tab 才能作锚（组队场景强制恢复，跳过占用检查）
    let anchorTabId = source.id;
    if (source.closed) {
      const rr = await devbenchApi.reopenClosed(source.id, true, reopenReview);
      if (rr.ok) anchorTabId = rr.data.id;
      else { showToast(rr.error || "恢复组锚故事点失败"); return rr; }
    }
    const anchorWorkspaceReady = await waitForStoryWorkspaceReady(anchorTabId);
    if (!anchorWorkspaceReady.ok) {
      showToast(`${anchorWorkspaceReady.error}；组锚工作区就绪前不能读取共享配置`);
      return { ok: false, error: anchorWorkspaceReady.error };
    }
    const anchorConfigResult = await devbenchApi.getConfigSnapshot(anchorTabId).catch(() => null);
    const anchorSnapshot = anchorConfigResult?.ok
      ? anchorConfigResult.data
      : source.configuration || null;
    if (!anchorSnapshot) {
      const error = "无法读取组锚的实际共享配置，尚未创建或加入新的故事点";
      showToast(error);
      return { ok: false, error };
    }
    const initializationSnapshot = {
      ...anchorSnapshot,
      ...(reviewedSnapshot?.configInference
        ? { configInference: reviewedSnapshot.configInference }
        : {}),
    };
    // 1. 确保本任务有（开着的）故事点，并已绑定；真正新建时必须展示初始化面板。
    const tabId = await ensureTaskStoryPoint(task, true, {
      configuredCreate: true,
      reviewedSnapshot: initializationSnapshot,
      inferenceSession,
      inferenceProofSession,
      inferenceDecision,
      localProjectBindings,
      reopenReview,
      sharedConfigurationSnapshot: anchorSnapshot,
      sharedConfigurationSource: `组锚「${anchorSnapshot.sourceTitle || source.title || anchorTabId}」`,
    });
    if (!tabId) return { ok: false, error: "任务故事点尚未创建或打开" };
    if (tabId === anchorTabId) { showToast("不能和自己组队，请选另一个故事点"); return { ok: false, error: "不能和自己组队" }; }
    await reloadTabs();
    setActive(tabId);
    loadMessages(tabId);
    setTeamPick(null);
    setShowTasks(false);
    showToast("故事点已创建，正在后台初始化工作区；完成后将自动继续组队");
    const workspaceReady = await waitForStoryWorkspaceReady(tabId);
    if (!workspaceReady.ok) {
      showToast(`${workspaceReady.error}；工作区就绪前不会加入故事点组`);
      return { ok: false, error: workspaceReady.error };
    }
    // 2. 原子加入组锚的组；后端在成功前保留旧组归属，迁组失败不会留下游离故事点。
    const jr = await devbenchApi.groupJoin(tabId, anchorTabId);
    if (!jr.ok) { showToast(jr.error || "组队失败"); return jr; }
    await reloadTabs();
    setActive(tabId);
    loadMessages(tabId); // 复用/恢复的故事点：加载其历史聊天，便于继续
    setTeamPick(null); setShowTasks(false);
    showToast("已加入故事点组（排队中），共用工程配置；轮到它时点「设为当前活动」即可开发");
    return { ok: true, data: { tabId, anchorTabId } };
  }

  async function confirmTeamDev(source) {
    const task = teamPick?.task; if (!task) return;
    const entryToken = beginStoryEntry("team_dev");
    if (!entryToken) return;
    const scopedTask = planTaskStory(task);
    let keepEntryLock = false;
    try {
      if (!task.tabId && !source.closed) {
        return await continueTeamDev(source, scopedTask);
      }
      const inferenceSetting = await resolveStoryPointAiInferenceEnabled();
      if (!inferenceSetting.ok) { showToast(inferenceSetting.error); return; }
      if (inferenceSetting.enabled) {
        const requested = await requestConfigInference({
          task,
          trigger: "task_team_execute",
          title: task.title || "组队开发",
          deferredEntry: { kind: "team_dev", task: scopedTask, source, entryToken },
        });
        if (requested) {
          keepEntryLock = true;
          setTeamPick(null);
          return;
        }
        return;
      }
      return await continueTeamDev(source, scopedTask);
    } finally {
      if (!keepEntryLock) finishStoryEntry(entryToken);
    }
  }

  async function startGroupDevFromTasks(group) {
    const items = (group?.tasks || []).filter((t) => !t.done && !(t.tbTaskId && t.staged !== false));
    if (!items.length) { showToast("该任务组没有可执行的待办任务"); return; }
    if (items.length === 1) { await startDevFromTask(items[0]); return; }
    const scopedItems = planTaskStories(items);
    const entryToken = beginStoryEntry("task_group");
    if (!entryToken) return;
    let keepEntryLock = false;
    try {
      if (scopedItems.some((item) => !item.tabId)) {
        await continueGroupDevFromTasks(group, scopedItems, { reviewedSnapshot: null });
        return;
      }
      const inferenceSetting = await resolveStoryPointAiInferenceEnabled();
      if (!inferenceSetting.ok) { showToast(inferenceSetting.error); return; }
      if (shouldDeferStoryEntry({ enabled: inferenceSetting.enabled, kind: "task_group", items: scopedItems })) {
        const requested = await requestConfigInference({
          task: scopedItems[0],
          trigger: "task_group_execute",
          title: scopedItems[0].title || group?.label || "",
          kickAfter: true,
          deferredEntry: { kind: "task_group", group, items: scopedItems, entryToken },
        });
        if (requested) {
          keepEntryLock = true;
          setShowTasks(false);
        }
        return;
      }
      await continueGroupDevFromTasks(group, scopedItems, { reviewedSnapshot: null });
    } finally {
      if (!keepEntryLock) finishStoryEntry(entryToken);
    }
  }

  // 整组入口已完成前置推理（或开关关闭）后才允许创建、恢复、组队和激活。
  async function continueGroupDevFromTasks(group, items, {
    reviewedSnapshot = null,
    inferenceSession = null,
    inferenceProofSession = inferenceSession,
    inferenceDecision = inferenceSession ? "reviewed" : "",
    localProjectBindings = [],
    reopenReview = null,
  } = {}) {
    const created = [];
    const partialResult = (reason, residualTitle = "") => {
      const completedTitles = created.map((item) => item.task.storyTitle || item.task.title || item.tabId);
      const progress = completedTitles.length
        ? `已完成 ${completedTitles.length}/${items.length}：${completedTitles.join("、")}`
        : `已完成 0/${items.length}`;
      const residual = residualTitle ? `；「${residualTitle}」故事点可能已创建或打开，但尚未入组` : "";
      const error = `${reason}；${progress}${residual}。已完成项保持可用，不自动回滚工作区`;
      showToast(error);
      return {
        ok: false,
        partial: completedTitles.length > 0,
        completed: completedTitles,
        error,
      };
    };
    let anchorTabId = "";
    let sharedConfigurationSnapshot = null;
    for (let i = 0; i < items.length; i += 1) {
      const task = items[i];
      const ensured = await ensureTaskStoryPoint(task, true, {
        configuredCreate: true,
        returnDetails: true,
        reviewedSnapshot: i === 0 ? reviewedSnapshot : sharedConfigurationSnapshot,
        inferenceSession,
        inferenceProofSession,
        inferenceDecision,
        localProjectBindings,
        reopenReview,
        sharedConfigurationSnapshot: i === 0 ? null : sharedConfigurationSnapshot,
        sharedConfigurationSource: i === 0
          ? ""
          : `任务组首项「${created[0]?.task.storyTitle || created[0]?.task.title || anchorTabId}」`,
      });
      const tabId = ensured?.tabId || "";
      if (!tabId) {
        return partialResult(`任务「${task.title || "未命名"}」取消或无法创建/打开，已停止后续组执行`);
      }
      await reloadTabs();
      setActive(tabId);
      loadMessages(tabId);
      setShowTasks(false);
      showToast(`「${task.storyTitle || task.title || tabId}」正在后台初始化；完成后将自动继续任务组`);
      const workspaceReady = await waitForStoryWorkspaceReady(tabId);
      if (!workspaceReady.ok) {
        return partialResult(
          `${workspaceReady.error}；工作区就绪前不会继续组执行`,
          task.storyTitle || task.title || tabId,
        );
      }
      if (i === 0) {
        anchorTabId = tabId;
        created.push({ task, tabId, disposition: ensured.disposition });
        if (ensured.disposition !== "created") {
          const applied = await applyReviewedInferenceSnapshot(anchorTabId, reviewedSnapshot);
          if (!applied) return partialResult("首项故事点未能应用已复核配置，已停止后续组执行");
        }
        const actualConfig = await devbenchApi.getConfigSnapshot(anchorTabId).catch(() => null);
        if (!actualConfig?.ok || !actualConfig.data) {
          return partialResult("无法读取首项故事点的实际共享配置，已停止后续组执行");
        }
        sharedConfigurationSnapshot = actualConfig.data;
        continue;
      }
      if (tabId === anchorTabId) {
        return partialResult(`任务「${task.title || "未命名"}」解析到了组锚本身，无法重复入组`);
      }
      const joined = await devbenchApi.groupJoin(tabId, anchorTabId);
      if (!joined.ok) {
        return partialResult(
          joined.error || `任务「${task.title || ""}」加入故事点组失败`,
          task.storyTitle || task.title || tabId,
        );
      }
      created.push({ task, tabId, disposition: ensured.disposition });
    }
    if (group?.label) {
      try { await devbenchApi.groupRename(anchorTabId, group.label); } catch {}
    }
    await reloadTabs();
    setActive(anchorTabId);
    loadMessages(anchorTabId);
    setShowTasks(false);
    showToast(`已打开故事点组「${group?.label || "任务组"}」：${items.length} 个任务将共用工程配置串行开发`);
    await kickTbWorkflow(created[0].task, anchorTabId);
    return { ok: true, data: { anchorTabId, completed: created.map((item) => item.tabId) } };
  }

  // 取消组队：把该任务的故事点退出组（工程配置保留）
  async function cancelTeamFromTask(task) {
    if (!task.tabId) { showToast("该任务还没有故事点"); return; }
    const r = await devbenchApi.groupLeave(task.tabId);
    if (r.ok) { await reloadTabs(); showToast("已取消组队，恢复独立开发"); } else showToast(r.error || "取消失败");
  }

  // 分布式执行：让服务端 AI 跑这个故事点的任务（本机执行）
  async function onAgentRun(tabId, task) {
    setAgentMap((prev) => ({ ...prev, [tabId]: { steps: [], status: "running", result: null } }));
    const r = await devbenchApi.agentRun(tabId, task);
    if (!r.ok) { setAgentMap((prev) => ({ ...prev, [tabId]: { steps: [], status: "done", result: { ok: false, error: r.error } } })); showToast(r.error || "启动失败"); }
  }

  // 打开新建故事点居中面板：拉取可复制来源 + 工程定义 + 环境诊断
  async function openNewMenu() {
    if (showNewMenu) {
      setShowNewMenu(false);
      return;
    }
    setShowNewMenu(true);
    const r = await devbenchApi.getCopySources();
    if (r.ok) {
      const next = r.data || { open: [], closed: [] };
      setCopySources({
        ...next,
        closed: (next.closed || []).filter((item) => !physicallyDeletedStoryIdsRef.current.has(item.id)),
      });
    }
    devbenchApi.getProjectDefs().then((d) => { if (d.ok) setProjectDefs(d.data || []); });
    devbenchApi.envCheck().then((d) => { if (d.ok) setEnvStatus(d.data); }); // 新建前先诊断本机环境
  }

  function openClosedStoryPurge(story) {
    setShowNewMenu(false);
    setClosedStoryPurge(story);
  }

  async function closedStoryPurged(id) {
    physicallyDeletedStoryIdsRef.current.add(id);
    setCopySources((current) => ({
      ...current,
      closed: (current.closed || []).filter((item) => item.id !== id),
    }));
    // 回源刷新是 best-effort；即使请求失败或读到旧快照，也不能把刚物理删除的项重新加回 UI。
    try {
      const response = await devbenchApi.getCopySources();
      if (response.ok) {
        const next = response.data || { open: [], closed: [] };
        setCopySources({
          ...next,
          closed: (next.closed || []).filter((item) => !physicallyDeletedStoryIdsRef.current.has(item.id)),
        });
      }
    } catch {}
    showToast("已永久删除故事点，并按确认项处理本地聊天存档与附件");
  }

  async function closeTab(id) {
    if (!confirm("关闭该故事点？(配置与聊天记录都会保留，之后从任务列表「再次开发」可原样恢复继续)")) return;
    await devbenchApi.deleteTab(id); // 软关闭(可恢复)；永久删除统一从已关闭故事点列表进入
    const list = await reloadTabs();
    if (activeId === id) setActive(list[0]?.id || null);
  }

  // 关闭整组：一次性软关闭该组全部故事点；有 AI 正在工作的先二次确认并中断
  async function closeGroup(groupId) {
    const members = tabs.filter((t) => t.groupId === groupId);
    if (!members.length) return;
    const running = members.filter((m) => isTabRunning(m));
    const name = members[0]?.groupName || "故事点组";
    const msg = running.length
      ? `「${name}」中有 ${running.length} 个故事点的 AI 正在工作。\n关闭会一并关闭该组全部 ${members.length} 个故事点，并【中断】正在进行的 AI 任务（配置与聊天记录都保留，可从任务列表恢复）。\n\n确定要关闭整组吗？`
      : `关闭「${name}」整组共 ${members.length} 个故事点？(配置与聊天记录都保留，之后从任务列表「再次开发」可原样恢复)`;
    if (!confirm(msg)) return;
    for (const m of running) { try { await devbenchApi.stop(m.id); } catch {} } // 先中断运行中的，避免遗留进程
    const r = await devbenchApi.deleteGroup(groupId);
    if (!r.ok) { showToast(r.error || "关闭整组失败"); return; }
    const list = await reloadTabs();
    if (members.some((m) => m.id === activeId)) setActive(list[0]?.id || null);
  }

  // ---------- OneTab 风格收起 ----------
  // 单 tab 收起：hidden=true，AI/会话/工程占用保留，仅从 tab 栏移出。
  // 乐观收起：先把本地 tabs 标记为 hidden，让 tab 栏立即移除，避免等待 PUT + 全量 GET /tabs
  // 两次网络往返造成的明显卡顿；服务端返回的权威 tab 再合并回本地。
  // 每次收起操作生成一个隐藏批次（makeHideBatch），同一次操作内所有故事点共享，
  // 隐藏面板按批次分组显示、支持整组还原。
  async function onCollapseTab(id) {
    const prevTab = tabs.find((t) => t.id === id);
    if (!prevTab || prevTab.hidden) return;
    const collapsedActive = activeId === id;
    const nextActive = tabs.filter((t) => !t.hidden && t.id !== id)[0]?.id || null;
    const batch = makeHideBatch();
    setTabs((prev) => prev.map((t) => t.id === id ? { ...t, hidden: true, hideBatchId: batch.id, hideBatchAt: batch.at, updatedAt: Date.now() } : t));
    if (collapsedActive) setActive(nextActive);
    const r = await devbenchApi.setTabHidden(id, true, batch);
    if (!r.ok) {
      setTabs((prev) => prev.map((t) => t.id === id ? { ...t, hidden: false, hideBatchId: undefined, hideBatchAt: undefined } : t));
      if (collapsedActive) setActive(id);
      showToast(r.error || "收起失败，请重试");
      return;
    }
    // 用服务端返回的权威 tab 合并（拿到 updatedAt 等字段），不再全量 reloadTabs。
    if (r.tab) setTabs((prev) => prev.map((t) => t.id === id ? { ...t, ...r.tab } : t));
  }
  // 整组收起：把该组所有未隐藏成员一并置 hidden=true。
  // 乐观收起 + 并行 PUT（原实现串行 N 次往返，大组时明显卡顿）。
  async function onCollapseGroup(groupId) {
    const members = visibleTabs.filter((t) => t.groupId === groupId);
    if (!members.length) return;
    const memberIds = new Set(members.map((m) => m.id));
    const collapsedActive = members.some((m) => m.id === activeId);
    const nextActive = tabs.filter((t) => !t.hidden && !memberIds.has(t.id))[0]?.id || null;
    const batch = makeHideBatch();
    setTabs((prev) => prev.map((t) => memberIds.has(t.id) ? { ...t, hidden: true, hideBatchId: batch.id, hideBatchAt: batch.at, updatedAt: Date.now() } : t));
    if (collapsedActive) setActive(nextActive);
    const results = await Promise.all(
      members.map((m) => devbenchApi.setTabHidden(m.id, true, batch).catch(() => ({ ok: false })))
    );
    const failedMembers = members.filter((_, i) => !results[i].ok);
    if (failedMembers.length) {
      const failedIds = new Set(failedMembers.map((m) => m.id));
      setTabs((prev) => prev.map((t) => failedIds.has(t.id) ? { ...t, hidden: false, hideBatchId: undefined, hideBatchAt: undefined } : t));
      if (collapsedActive && failedIds.has(activeId)) setActive(activeId);
      showToast(`${failedMembers.length} 个故事点收起失败，请重试`);
      return;
    }
    // 合并服务端权威 tab 字段。
    setTabs((prev) => {
      let next = prev;
      results.forEach((r, i) => {
        const m = members[i];
        if (r.ok && r.tab) next = next.map((t) => t.id === m.id ? { ...t, ...r.tab } : t);
      });
      return next;
    });
  }
  // 还原：hidden=false 并切过去。同样走乐观更新，点击即生效；同时清除该 tab 的隐藏批次字段。
  async function onRestoreTab(id) {
    const prevTab = tabs.find((t) => t.id === id);
    if (!prevTab || !prevTab.hidden) return;
    setTabs((prev) => prev.map((t) => t.id === id ? { ...t, hidden: false, hideBatchId: undefined, hideBatchAt: undefined, updatedAt: Date.now() } : t));
    setActive(id);
    setShowHiddenList(false);
    const r = await devbenchApi.setTabHidden(id, false);
    if (!r.ok) {
      setTabs((prev) => prev.map((t) => t.id === id ? { ...t, hidden: true, hideBatchId: prevTab.hideBatchId, hideBatchAt: prevTab.hideBatchAt } : t));
      showToast(r.error || "还原失败，请重试");
      return;
    }
    if (r.tab) setTabs((prev) => prev.map((t) => t.id === id ? { ...t, ...r.tab } : t));
  }
  // 一键收起：当前所有未隐藏的故事点全部置 hidden=true，归入同一个隐藏批次。
  // 乐观收起：本地立即全部标记隐藏，单次 POST 确认即可。
  async function onHideAll() {
    if (!visibleTabs.length) return;
    const prevVisibleIds = new Set(visibleTabs.map((t) => t.id));
    const collapsedActive = prevVisibleIds.has(activeId);
    const nextActive = tabs.filter((t) => !t.hidden && !prevVisibleIds.has(t.id))[0]?.id || null;
    const batch = makeHideBatch();
    setTabs((prev) => prev.map((t) => (!t.hidden && prevVisibleIds.has(t.id)) ? { ...t, hidden: true, hideBatchId: batch.id, hideBatchAt: batch.at, updatedAt: Date.now() } : t));
    if (collapsedActive) setActive(nextActive);
    const r = await devbenchApi.hideAllTabs(batch);
    if (!r.ok) {
      setTabs((prev) => prev.map((t) => prevVisibleIds.has(t.id) ? { ...t, hidden: false, hideBatchId: undefined, hideBatchAt: undefined } : t));
      if (collapsedActive) setActive(activeId);
      showToast(r.error || "一键收起失败，请重试");
      return;
    }
  }
  // 整组还原：把同一隐藏批次的所有故事点一起还原为 tab，并切到组内第一个。同样走乐观更新。
  async function onRestoreBatch(batchMembers) {
    const members = (batchMembers || []).filter((t) => t && t.hidden);
    if (!members.length) return;
    const restoreIds = new Set(members.map((t) => t.id));
    const origById = new Map(members.map((t) => [t.id, t]));
    setTabs((prev) => prev.map((t) => restoreIds.has(t.id) ? { ...t, hidden: false, hideBatchId: undefined, hideBatchAt: undefined, updatedAt: Date.now() } : t));
    setShowHiddenList(false);
    if (members[0]) setActive(members[0].id);
    const results = await Promise.all(
      members.map((t) => devbenchApi.setTabHidden(t.id, false).catch(() => ({ ok: false })))
    );
    const failedIds = new Set(members.filter((_, i) => !results[i].ok).map((t) => t.id));
    if (failedIds.size) {
      setTabs((prev) => prev.map((t) => failedIds.has(t.id)
        ? { ...t, hidden: true, hideBatchId: origById.get(t.id)?.hideBatchId, hideBatchAt: origById.get(t.id)?.hideBatchAt }
        : t));
      showToast(`${failedIds.size} 个故事点还原失败，请重试`);
    }
  }
  // 隐藏列表删除：软关闭故事点（先中断 AI，聊天/配置保留，可从已关闭列表恢复）。
  async function onDeleteHiddenTab(id) {
    const t = tabs.find((x) => x.id === id);
    if (!t) return;
    const running = isTabRunning(t);
    const msg = running
      ? `「${t.title || "(未命名)"}」的 AI 正在运行。\n删除会中断 AI 任务并关闭该故事点；聊天记录与配置保留，可从已关闭列表恢复。\n\n确定删除吗？`
      : `删除「${t.title || "(未命名)"}」？\n（关闭故事点：聊天记录与配置保留，可从已关闭列表恢复）`;
    if (!confirm(msg)) return;
    if (running) {
      // 先中断 AI；stop 失败（如任务在另一个 Gateway 执行返回 409）必须中止删除，
      // 否则会留下孤儿 AI 任务继续占用工程，与提示文案「删除会中断 AI 任务」相悖。
      const stopped = await devbenchApi.stop(id);
      if (!stopped.ok) {
        showToast(stopped.error || "无法中断 AI 任务，已取消删除");
        return;
      }
    }
    const r = await devbenchApi.deleteTab(id);
    if (!r.ok) { showToast(r.error || "删除失败，请重试"); return; }
    const list = await reloadTabs();
    if (id === activeId) setActive(list[0]?.id || null);
    showToast("故事点已删除（可在已关闭列表恢复）");
  }

  // ---------- 子组件回调 ----------
  function rememberRepositoryPathAlert(tabId, alert) {
    if (!tabId || !alert) return;
    setRepositoryPathAlertMap((current) => ({ ...current, [tabId]: alert }));
  }

  function clearTransientRepositoryPathAlert(tabId) {
    setRepositoryPathAlertMap((current) => {
      if (!Object.prototype.hasOwnProperty.call(current, tabId)) return current;
      const next = { ...current };
      delete next[tabId];
      return next;
    });
  }

  async function onSend(tabId, content, messageInput = null, {
    clientMessageId: requestedClientMessageId = "",
    replaceMessageId = "",
  } = {}) {
    // 聊天是强相关场景：发送不等待查询，但会立即校准 AI 服务端/算力状态。
    refreshAiServers();
    // 乐观插入用户消息 + 标记该故事点为"运行中"
    const clientMessageId = requestedClientMessageId
      || globalThis.crypto?.randomUUID?.()
      || `pending-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const optimisticMessage = createOptimisticStoryMessage({ clientMessageId, content, messageInput });
    setMsgMap((prev) => {
      const current = prev[tabId] || [];
      const next = replaceMessageId
        ? current.map((message) => String(message?.id || "") === String(replaceMessageId) ? {
          ...optimisticMessage,
          ts: message.ts || optimisticMessage.ts,
        } : message)
        : [...current, optimisticMessage];
      return { ...prev, [tabId]: next };
    });
    setRunningTabs((s) => new Set(s).add(tabId));
    const r = await devbenchApi.send(tabId, content, { ...(messageInput || {}), clientMessageId });
    setMsgMap((prev) => ({
      ...prev,
      [tabId]: settleOptimisticStoryMessage(prev[tabId] || [], clientMessageId, r),
    }));
    // 附件较多/较大不阻塞：后端已跳过自动下载并正常发送/甄别，仅在数据里带 attachSkipNote。
    // 若仍收到旧版 needConfirm 旧响应，也视为非阻塞——不弹确认窗、不报"发送失败"。
    const needConfirmLegacy = r?.needConfirm || r?.data?.needConfirm;
    const skippedPrompt = (() => {
      const note = (r && r.data && r.data.attachSkipNote) || (r && r.attachSkipNote);
      if (!note) return "";
      return `；附件${note.count || ""}${note.reason ? `（${note.reason}）` : ""}未自动下载，需要阅读时可在 TB 附件清单里逐一下载`;
    })();
    const effectiveOk = needConfirmLegacy ? true : r.ok;
    if (!effectiveOk) {
      const repositoryPathAlert = repositoryPathAlertFromResponse(r);
      if (repositoryPathAlert) {
        rememberRepositoryPathAlert(tabId, repositoryPathAlert);
        await reloadTabs();
      }
      showToast((r.error || "发送失败") + (skippedPrompt || ""));
      setRunningTabs((s) => { const n = new Set(s); n.delete(tabId); return n; });
    } else {
      clearTransientRepositoryPathAlert(tabId);
    }
    if (effectiveOk && r.injected) {
      // AI 正在工作 → 已注入当前会话，它会在下一思考循环读取并接着处理，运行态保持
      showToast("已发送给正在工作的 AI，它会接着处理" + (skippedPrompt || ""));
    } else if (effectiveOk && r.queued) {
      // 注入不可用 → 本条已排队，本轮结束后自动发送（运行态保持，不取消）
      showToast((r.deviceQueued
        ? `目标设备正在被其它故事点使用，已进入设备队列（第 ${r.queueLen} 位）`
        : `已加入队列（第 ${r.queueLen} 条），AI 当前轮结束后自动发送`) + (skippedPrompt || ""));
      reloadTabs();
    } else if (effectiveOk) {
      reloadTabs();
    }
    return r;
  }

  async function onSetPrimary(tabId, projectId) {
    const r = await devbenchApi.setPrimary(tabId, projectId);
    if (isWorktreeRebuildConfirmRequired(r)) {
      setWorktreeRebuild({
        title: "更换主工程需删除旧 worktree 并重建",
        error: r.error,
        preview: r.data.preview,
        inspection: r.data.inspection,
        body: { projectId },
        retry: (body) => devbenchApi.setPrimary(tabId, body.projectId, body),
      });
      return r;
    }
    if (!r.ok) showToast(r.error || "选择失败");
    await reloadTabs();
    return r;
  }

  async function onSetTicket(tabId, url) {
    const r = await devbenchApi.setTicket(tabId, url);
    if (isWorktreeRebuildConfirmRequired(r)) {
      setWorktreeRebuild({
        title: "更新关联任务需删除旧 worktree 并重建",
        error: r.error,
        preview: r.data.preview,
        inspection: r.data.inspection,
        body: { url },
        retry: (body) => devbenchApi.setTicket(tabId, body.url, body),
      });
      return r;
    }
    if (!r.ok) showToast(r.error || "保存工单地址失败");
    await reloadTabs();
    return r;
  }

  async function onAddExtra(tabId, path, name) {
    const r = await devbenchApi.addExtra(tabId, path, name);
    if (!r.ok) showToast(r.error || "添加失败");
    await reloadTabs();
    return r;
  }

  async function onRemoveExtra(tabId, path) {
    await devbenchApi.removeExtra(tabId, path);
    await reloadTabs();
  }

  // 主工程 ↔ 关联工程 对调：把该关联工程提升为主工程，原主工程降为关联工程
  async function onSwapPrimary(tabId, extraPath) {
    const r = await devbenchApi.swapPrimary(tabId, extraPath);
    if (isWorktreeRebuildConfirmRequired(r)) {
      setWorktreeRebuild({
        title: "对调主工程需删除旧 worktree 并重建",
        error: r.error,
        preview: r.data.preview,
        inspection: r.data.inspection,
        body: { extraPath },
        retry: (body) => devbenchApi.swapPrimary(tabId, body.extraPath, body),
      });
      return r;
    }
    if (!r.ok) showToast(r.error || "对调失败");
    else showToast("已对调主工程");
    await reloadTabs();
    return r;
  }

  // Android Studio「Update Project」：拉取远程最新，进度/冲突走 WS 在底部条显示
  async function onGitUpdate(tabId, selection = {}) {
    if (gitUpdateMap[tabId]?.status === "running") return; // 防重复触发
    setGitUpdateMap((m) => ({ ...m, [tabId]: { status: "running", repoCount: 1, repoIndex: 0, pct: 0 } }));
    const r = await devbenchApi.gitUpdate(tabId, selection);
    // 兜底：WS 漏了 end（极少）时用返回值定状态
    if (r) {
    setGitUpdateMap((m) => {
      const cur = m[tabId];
      if (cur && cur.status !== "running") return { ...m, [tabId]: { ...cur, aiResolution: r.aiResolution || cur.aiResolution || null } };
      const results = Array.isArray(r.data) ? r.data : [];
      const conflicts = results.filter((x) => x.conflict).map((x) => ({ ...x, path: x.worktreePath || x.path }));
      const status = r.hasConflict ? "conflict" : (r.ok ? "done" : "failed");
      return { ...m, [tabId]: { ...(cur || {}), status, summary: r.summary, conflicts, results, aiResolution: r.aiResolution || null } };
      });
    }
  }
  // 让 AI 解决合并冲突/诊断失败。引擎使用故事点当前选中的 AI，不可用时自动 fallback。
  // c=null → Git Update 整体失败，发送诊断提示到聊天区；c={path,name} → 解决特定冲突文件。
async function onGitResolveAI(tabId, c) {
  if (!c) {
    showToast("该失败不是代码冲突，请根据工程卡片中的 Git 错误处理后重试");
    return;
    }
    const r = await devbenchApi.gitResolveConflicts(tabId, c.path);
  if (!r.ok) { showToast(r.error || "启动 AI 解决冲突失败"); return; }
  showToast(`已让 AI 解决「${c.name}」的冲突（解决后会 git add，不自动提交，请人工审核）`);
  setGitUpdateMap((m) => ({
    ...m,
    [tabId]: { ...(m[tabId] || {}), status: "conflict", aiResolution: { status: "started", started: true, ...(r.data || {}) } },
  }));
}
  function closeGitUpdate(tabId) {
    setGitUpdateMap((m) => { const n = { ...m }; delete n[tabId]; return n; });
  }

  // ---------- 编译产物（gradle assemble，每工程独立、实时日志走 WS devbench_build） ----------
  // jobs 通常是单个工程（来自该工程卡片的「打包」按钮），但也兼容多工程。只动 jobs 涉及的工程，不碰其它工程的状态。
  async function onBuild(tabId, jobs) {
    setBuildMap((m) => {
      const cur = m[tabId] || { byProject: {} };
      const bp = { ...cur.byProject };
      for (const j of jobs) bp[j.name] = { buildId: null, status: "starting", lines: [], code: null, apks: [], path: j.path, tasks: [] };
      return { ...m, [tabId]: { ...cur, byProject: bp } };
    });
    const r = await devbenchApi.buildProjects(tabId, jobs);
    setBuildMap((m) => {
      const cur = m[tabId]; if (!cur) return m;
      const bp = { ...cur.byProject };
      for (const j of jobs) {
        if (!bp[j.name]) continue;
        if (!r.ok) { if (bp[j.name].status === "starting") delete bp[j.name]; }
        else bp[j.name] = { ...bp[j.name], buildId: r.buildId, status: bp[j.name].status === "starting" ? "running" : bp[j.name].status };
      }
      return { ...m, [tabId]: { ...cur, byProject: bp } };
    });
    if (!r.ok) showToast(r.error || "打包启动失败");
    return r;
  }
  async function onBuildStop(tabId, projName) {
    const buildId = buildMap[tabId]?.byProject?.[projName]?.buildId;
    const r = await devbenchApi.buildStop(tabId, buildId);
    if (!r.ok) showToast(r.error || "停止打包失败");
    return r;
  }
  function closeBuild(tabId) {
    setBuildMap((m) => { const n = { ...m }; delete n[tabId]; return n; });
  }

  async function onRename(tabId, title) {
    const r = await devbenchApi.renameTab(tabId, title);
    if (!r.ok) showToast(r.error || "改名失败");
    await reloadTabs();
    return r;
  }

  // ---------- 设备 ----------
  async function onSetCenter(tabId, server) {
    const body = server
      ? { centerHost: server.host, centerName: server.name || server.host }
      : { centerHost: "", centerName: "" };
    const r = await devbenchApi.setCenter(tabId, body);
    if (!r.ok) showToast(r.error || "切换AI服务器失败");
    else showToast(server ? `本故事点 AI 服务器已切换为 ${server.name || server.host}` : "本故事点已改为跟随设置页选择的 AI 服务器");
    await reloadTabs();
    return r;
  }

  async function refreshDevices() {
    const r = await devbenchApi.listDevices();
    if (r.ok) setDevices(r.data || []);
    else showToast(r.error || "获取设备失败");
    return r;
  }

  useEffect(() => { refreshDevices(); /* eslint-disable-next-line */ }, []);

  async function onBindDevice(tabId, serial) {
    const r = await devbenchApi.bindDevice(tabId, serial);
    if (!r.ok) showToast(r.error || "绑定失败");
    await reloadTabs();
    await refreshDevices();
    return r;
  }

  async function onReleaseDevice(tabId) {
    await devbenchApi.releaseDevice(tabId);
    await reloadTabs();
    await refreshDevices();
  }

  async function onOpenApk(tabId) {
    const r = await devbenchApi.openApk(tabId);
    if (!r.ok) { showToast(r.error || "没有 APK 产物"); return; }
    const d = r.data || {};
    if (d.fallback) showToast(`未找到 prod release 包，已打开最新 APK 目录：${d.path || ""}`);
    else if (d.file) showToast(`已定位 prod release：${d.file}`);
    else if (d.path) showToast(`已打开 APK 产物目录：${d.path}`);
  }

  // 发布生产：拷 prod release 包+mapping 到该车型生产发布目录、更新 ReadMe、钉钉通知。
  // 进度由 WS devbench_publish 驱动该故事点中央的悬浮进度窗（不阻塞其它故事点）。
  async function startPublishProd(tabId, { confirmFirst = true } = {}) {
    if (confirmFirst && !confirm("发布生产？将把 prod release 包 + mapping 压缩包复制到该车型的「生产发布目录」，更新 ReadMe.txt，并通过「应用市场出包机器人」钉钉通知。")) return;
    setPublishMap((m) => ({ ...m, [tabId]: { status: "running", step: "提交发布请求…", pct: null } }));
    const r = await devbenchApi.publishProd(tabId, currentProjectId);
    // 同步校验失败（未配目录/无 apk/同名已存在等）→ 直接在进度窗显示错误；成功(started)则交给 WS 推进度
    if (!(r.ok && r.started)) {
      setPublishMap((m) => ({ ...m, [tabId]: { status: "error", step: r.error || "发布失败", error: r.error || "发布失败" } }));
      showToast(r.error || "发布生产失败");
    }
  }
  async function onPublishProd(tabId) {
    return startPublishProd(tabId, { confirmFirst: true });
  }
  // 提交到主工程：先预检（显示从故事分支 rebase 到原始分支的情况 + 是否有可 rebase 提交），确认后再执行。
  async function onRebaseToOriginal(tabId) {
    setRebaseMap((m) => ({ ...m, [tabId]: { status: "previewing", step: "分析各工程 rebase 情况…" } }));
    let p;
    try {
      p = await devbenchApi.rebasePreview(tabId);
    } catch (e) {
      p = { ok: false, error: e?.message || "请求失败" };
    }
    if (!p.ok) {
      setRebaseMap((m) => ({ ...m, [tabId]: { status: "error", step: p.error || "预检失败", result: p } }));
      showToast(p.error || "提交到主工程预检失败");
      return;
    }
    setRebaseMap((m) => ({ ...m, [tabId]: { status: "preview", preview: p } }));
  }
  async function confirmRebaseToOriginal(tabId) {
    setRebaseMap((m) => ({ ...m, [tabId]: { ...(m[tabId] || {}), status: "running", step: "rebase 中…" } }));
    let r;
    try {
      r = await devbenchApi.rebaseToOriginal(tabId);
    } catch (e) {
      r = { ok: false, error: e?.message || "请求失败" };
    }
    const s = r.summary || {};
    setRebaseMap((m) => ({
      ...m,
      [tabId]: {
        status: r.ok ? "done" : "error",
        step: r.ok
          ? `完成：成功 ${s.succeeded ?? 0} · 跳过 ${s.skipped ?? 0}${s.conflicts ? ` · 冲突 ${s.conflicts}` : ""}`
          : (r.error || "失败"),
        result: r,
      },
    }));
    if (r.ok) {
      showToast(`已 rebase：成功 ${s.succeeded ?? 0} / 跳过 ${s.skipped ?? 0}${s.conflicts ? ` / 冲突 ${s.conflicts}` : ""}`);
    } else {
      showToast(r.error || "提交到主工程失败");
    }
  }
  function closeRebase(tabId) {
    setRebaseMap((m) => { const n = { ...m }; delete n[tabId]; return n; });
  }
  async function onOpenProdDir(tabId) {
    const r = await devbenchApi.openProdDir(tabId, currentProjectId);
    if (!r.ok) {
      showToast(r.error || "打开生产发布目录失败");
      return r;
    }
    const p = r.data?.path || "";
    const prefix = r.data?.warning ? "已请求系统打开生产发布目录（共享目录需在 Windows 中确认/登录）" : "已请求系统打开生产发布目录";
    showToast(p ? `${prefix}：${p}` : prefix);
    return r;
  }
  async function onPublishShareLogin(tabId, credentials) {
    const cur = publishMap[tabId] || {};
    const shareRoot = String(credentials?.shareRoot || cur.shareRoot || "").trim();
    const retryId = String(credentials?.retryId || cur.retryId || "").trim();
    setPublishMap((m) => ({
      ...m,
      [tabId]: {
        ...(m[tabId] || {}),
        status: "running",
        phase: "share_login",
        step: "正在登录生产发布共享目录…",
        shareError: null,
      },
    }));
    const r = await devbenchApi.publishShareLogin(tabId, { ...(credentials || {}), shareRoot, retryId });
    if (!r.ok) {
      setPublishMap((m) => ({
        ...m,
        [tabId]: {
          ...(m[tabId] || {}),
          status: "need_share_login",
          phase: "share_login",
          step: "共享目录登录失败，请重新登录",
          shareRoot,
          retryId,
          shareError: r.error || "共享目录登录失败",
          error: r.error || "共享目录登录失败",
        },
      }));
      showToast(r.error || "共享目录登录失败");
      return r;
    }
    setPublishMap((m) => ({ ...m, [tabId]: { ...(m[tabId] || {}), status: "running", phase: "share_login", step: "共享目录登录成功，继续发布生产…", shareError: null } }));
    showToast("共享目录登录成功，继续发布生产");
    if (!r.retryStarted) await startPublishProd(tabId, { confirmFirst: false });
    return r;
  }
  async function onUploadResignedApk(tabId, resignId, file) {
    if (!resignId || !file) return { ok: false, error: "缺少二签会话或 APK 文件" };
    setPublishMap((m) => ({ ...m, [tabId]: { ...(m[tabId] || {}), status: "running", step: `上传并校验二签 APK：${file.name || ""}`, uploadError: null } }));
    const r = await devbenchApi.uploadResignedApk(tabId, resignId, file);
    if (!r.ok) {
      setPublishMap((m) => ({ ...m, [tabId]: { ...(m[tabId] || {}), status: "await_resign", uploadError: r.error || "签名校验失败", step: "签名校验失败，请重新上传正确 APK" } }));
      showToast(r.error || "签名校验失败");
    } else {
      showToast(`签名校验通过：${r.data?.fingerprint || ""}`);
    }
    return r;
  }
  // 关闭某故事点的发布进度窗
  function closePublish(tabId) {
    setPublishMap((m) => { const n = { ...m }; delete n[tabId]; return n; });
  }
  // 钉钉消息确认：用户编辑后点"发送"
  async function handleConfirmDingtalk(tabId, confirmId, message) {
    setDingtalkConfirm(null);
    const r = await devbenchApi.confirmDingtalk(tabId, confirmId, message);
    if (!r.ok) {
      showToast(r.error || "钉钉发送失败");
      setPublishMap((m) => ({ ...m, [tabId]: { status: "error", step: r.error || "钉钉发送失败", error: r.error || "钉钉发送失败" } }));
    }
  }
  // 钉钉消息确认：用户点"取消"，跳过钉钉通知
  function handleCancelDingtalk() {
    setDingtalkConfirm(null);
  }

  async function onSetApkSource(tabId, path) {
    const r = await devbenchApi.setApkSource(tabId, path);
    if (!r.ok) showToast(r.error || "设置 APK 产物来源失败");
    await reloadTabs();
    return r;
  }

  function applyConversationResponse(tabId, response) {
    const nested = response?.data && typeof response.data === "object" ? response.data : {};
    const messages = Array.isArray(response?.messages) ? response.messages : nested.messages;
    const conversation = response?.conversation || nested.conversation || null;
    if (Array.isArray(messages)) setMsgMap((prev) => ({ ...prev, [tabId]: messages }));
    if (conversation) setConversationMap((prev) => ({ ...prev, [tabId]: conversation }));
    return { ...nested, messages, conversation };
  }

  async function onEditAndResend(tabId, messageId, content, expectedRevision) {
    const currentMessages = msgMap[tabId] || [];
    const localFailed = currentMessages.find((message) => isRetryableFailedStoryMessage(message, messageId));
    const persistedTarget = (conversationMap[tabId]?.nodes || []).some((node) => String(node?.id || "") === String(messageId));
    const legacyTargetIndex = currentMessages.findIndex((message) => (
      String(message?.id || "") === String(messageId) && message?.role === "user"
    ));
    const legacyFailureNotice = legacyTargetIndex >= 0 ? currentMessages[legacyTargetIndex + 1] : null;
    const legacyLocalFailed = !persistedTarget
      && legacyTargetIndex >= 0
      && legacyFailureNotice?.error === true
      && /^发送失败[:：]/.test(String(legacyFailureNotice.content || ""))
      ? currentMessages[legacyTargetIndex]
      : null;
    const retryTarget = localFailed || legacyLocalFailed;
    if (retryTarget) {
      const retryInput = {
        displayContent: content,
        input: {
          ...(retryTarget.input && typeof retryTarget.input === "object" ? retryTarget.input : {}),
          text: content,
        },
      };
      const providerContent = buildStoryAttachmentPrompt(content, retryInput.input.attachments || []);
      return onSend(tabId, providerContent, retryInput, {
        clientMessageId: retryTarget.clientMessageId || messageId,
        replaceMessageId: messageId,
      });
    }
    refreshAiServers();
    const r = await devbenchApi.editAndResendConversation(tabId, messageId, content, expectedRevision);
    if (!r.ok) {
      const repositoryPathAlert = repositoryPathAlertFromResponse(r);
      if (repositoryPathAlert) {
        rememberRepositoryPathAlert(tabId, repositoryPathAlert);
        await reloadTabs();
      }
      showToast(r.error || "编辑并重新发送失败");
      if (r.status === 409 || r.code === "CONVERSATION_REVISION_CONFLICT") void loadMessages(tabId);
      return r;
    }
    clearTransientRepositoryPathAlert(tabId);
    applyConversationResponse(tabId, r);
    const tab = tabsRef.current.find((item) => item.id === tabId);
    if (tab?.sessionId) {
      setLiveMap((prev) => { const next = { ...prev }; delete next[tab.sessionId]; return next; });
    }
    setRunningTabs((current) => new Set(current).add(tabId));
    reloadTabs();
    return r;
  }

  async function onSelectConversationBranch(tabId, messageId, expectedRevision) {
    const r = await devbenchApi.selectConversationHead(tabId, messageId, expectedRevision);
    if (!r.ok) {
      showToast(r.error || "切换消息版本失败");
      if (r.status === 409 || r.code === "CONVERSATION_REVISION_CONFLICT") void loadMessages(tabId);
      return r;
    }
    applyConversationResponse(tabId, r);
    return r;
  }

  async function onStop(tabId, sessionId) {
    // try/finally：无论后端返回 ok / 失败 / 抛异常，都要退出"运行中"状态，
    // 否则「已停止 AI」toast 出现后 EngineSwitchButton 仍 disabled，用户无法切换 AI。
    let r = null;
    let stopError = "";
    try {
      r = await devbenchApi.stop(tabId);
      if (!r.ok) stopError = r.error || "停止失败";
    } catch (err) {
      stopError = err?.message || "停止请求出错";
    }
    // 停止后保留当前流式正文；后端会把它晋升为正式历史消息并通过 WS 替换。
    // 强同步清理：先退出运行态，再写 stopped 标记，避免 isTabRunning 短暂回弹。
    setRunningTabs((s) => { const n = new Set(s); n.delete(tabId); return n; });
    if (sessionId) setLiveMap((prev) => preserveStoppedLive(prev, sessionId));
    if (stopError) showToast(`已停止（${stopError}）`);
    else showToast("已停止当前任务，停止前回答已保留");
  }

  // 某故事点是否正在跑 AI（发送→最终回复，或正在流式输出）
  // 强信号豁免逻辑放在 chatStopModel.mjs#isTabRunning，便于单测。
  const isTabRunning = (t) => isTabRunningModel({
    runningTabs,
    liveMap,
    tabId: t.id,
    sessionId: t.sessionId,
  });

  // OneTab 风格收起：服务端 tabs 含 hidden 字段，前端按此分两组渲染。
  // 用 useMemo 缓存，避免每次 render 都产生新数组引用导致依赖它的 useEffect/子组件重跑
  // （尤其一键收起/还原后 tabs 整体变化，未缓存会让 scrollIntoView 等 effect 反复触发）。
  const visibleTabs = useMemo(() => tabs.filter((t) => !t.hidden), [tabs]);
  const hiddenTabs = useMemo(() => tabs.filter((t) => t.hidden), [tabs]);
  // 隐藏态的 tab 不在内容区渲染（active 只在未隐藏的 tab 里找）。
  const active = useMemo(() => visibleTabs.find((t) => t.id === activeId) || null, [visibleTabs, activeId]);
  const activeGroup = active?.groupId || null; // 同组故事点共用工程/设备，互不算占用

  // 活动 tab 切换或 tab 列表变化时，把它滚到 tab 栏可视区内（避免多 tab 时被横向滚出视口）。
  useEffect(() => {
    const root = tabBarScrollRef.current;
    if (!root || !activeId) return;
    const el = root.querySelector(`[data-active-tab="true"]`);
    if (!el) return;
    // block/inline 都用 nearest，避免抢占页面纵向滚动；只在该方向上调整最小距离。
    el.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [activeId, visibleTabs]);
  const sameGroupAsActive = useCallback((t) => t.id === activeId || (activeGroup && t.groupId === activeGroup), [activeId, activeGroup]);
  // 其他 tab 占用的工程路径集合（用于下拉禁用）——同组豁免
  const otherOccupied = useMemo(() => {
    const set = new Set();
    for (const t of tabs) {
      if (sameGroupAsActive(t)) continue;
      for (const r of t.refs || []) set.add(String(r.path).replace(/[\\/]+/g, "/").replace(/\/+$/, "").toLowerCase());
    }
    return set;
  }, [tabs, sameGroupAsActive]);
  // 兼容旧子组件的运行时占用投影；普通共享绑定不再视为占用。
  const deviceOwners = useMemo(() => {
    const owners = {};
    for (const device of devices) {
      const lease = device.runtime?.lease || device.currentUse;
      if (!lease?.storyId || lease.storyId === activeId) continue;
      const owner = tabs.find((tab) => tab.id === lease.storyId);
      owners[device.id] = owner?.title || lease.storyId;
    }
    return owners;
  }, [devices, tabs, activeId]);
  // 工单占用：ticketUrl -> 其他故事点标题（同一工单只能被一个故事点关联）
  const ticketOwners = useMemo(() => {
    const owners = {};
    for (const t of tabs) {
      if (t.id === activeId) continue;
      if (t.ticketUrl) owners[t.ticketUrl] = t.title;
    }
    return owners;
  }, [tabs, activeId]);

  return (
    <div className="h-full min-w-0 flex flex-col overflow-x-hidden bg-[#0f0f10] text-zinc-200">
      {/* 顶部 tab 栏 */}
      <div className="shrink-0 border-b border-zinc-800 bg-zinc-900/40">
        <div className="flex items-center gap-2 overflow-x-auto px-2 py-2 sm:gap-3 sm:px-4">
          <h1 className="shrink-0 whitespace-nowrap text-sm font-semibold">工程开发</h1>
          <div className="flex shrink-0 rounded border border-zinc-700 bg-zinc-950 p-0.5" role="tablist" aria-label="工程开发工作区">
            <button onClick={() => selectWorkspaceView("stories")} role="tab" aria-selected={workspaceView === "stories"}
              className={`rounded-sm px-2 py-0.5 text-[10px] transition ${workspaceView === "stories" ? "bg-zinc-700 text-white" : "text-zinc-500 hover:text-zinc-300"}`}>故事点</button>
            <button onClick={() => selectWorkspaceView("ai-training")} role="tab" aria-selected={workspaceView === "ai-training"}
              className={`rounded-sm px-2 py-0.5 text-[10px] transition ${workspaceView === "ai-training" ? "bg-cyan-800 text-white" : "text-zinc-500 hover:text-zinc-300"}`}>AI训练</button>
          </div>
          <span className="hidden text-[11px] text-zinc-500 2xl:inline">
            {workspaceView === "stories" ? "每个故事点独占一个工程，直接在工程目录下与 AI 对话" : "用 TB 证据训练工程、分支与 variant 路由"}
          </span>
          <span className="ml-auto" />
          {workspaceView === "stories" && (
            <button
              onClick={() => setShowTasks(true)}
              className="shrink-0 px-2.5 py-1 text-[11px] rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-300 hover:text-white transition flex items-center gap-1"
              title="任务列表（待办/已完成）"
              data-testid="task-panel-trigger"
            >📋 任务列表</button>
          )}
          <button
            data-testid="project-config-trigger"
            onClick={() => { setConfigInitialTab("projects"); setShowConfig(true); }}
            className="shrink-0 px-2.5 py-1 text-[11px] rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-300 hover:text-white transition flex items-center gap-1"
            title="配置应用市场工程列表"
          >⚙ 工程配置</button>
          <div className="relative shrink-0">
            <button
              ref={cfgMenuButtonRef}
              onClick={() => {
                if (!showCfgMenu) updateCfgMenuPosition();
                setShowCfgMenu((v) => !v);
              }}
              className="px-2.5 py-1 text-[11px] rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-300 hover:text-white transition flex items-center gap-1"
              title="车型源码配置 / 钉钉消息配置 / 关键词映射设置"
            >🗂 配置 ▾</button>
            {showCfgMenu && (
              <>
                <div className="fixed inset-0 z-[90]" onClick={() => setShowCfgMenu(false)} />
                <div
                  className="fixed z-[100] w-48 max-h-[calc(100vh-4rem)] overflow-y-auto bg-zinc-900 border border-zinc-700 rounded-lg shadow-2xl py-1"
                  style={{ top: cfgMenuPosition.top, left: cfgMenuPosition.left }}
                >
                  <button onClick={() => { setShowCfgMenu(false); setConfigInitialTab("vehicle"); setShowConfig(true); }}
                    className="w-full text-left px-3 py-1.5 text-[12px] text-zinc-200 hover:bg-zinc-800 transition flex items-center gap-2"
                    title="在工程配置中打开车型→远程分支映射 + 生产发布目录/重签">🚗 车型源码配置</button>
                  <button onClick={() => { setShowCfgMenu(false); setShowSharedBackup(true); }}
                    className="w-full text-left px-3 py-1.5 text-[12px] text-zinc-200 hover:bg-zinc-800 transition flex items-center gap-2"
                    title="本机备份和恢复可局域网同步的数据">共享配置备份</button>
                  {isAdmin && (
                    <button onClick={() => { setShowCfgMenu(false); setShowDingMsg(true); }}
                      className="w-full text-left px-3 py-1.5 text-[12px] text-zinc-200 hover:bg-zinc-800 transition flex items-center gap-2"
                      title="配置各场景钉钉消息（如发布生产要 @ 的人），局域网同步（仅管理员）">📨 钉钉消息配置</button>
                  )}
                  <button onClick={() => { setShowCfgMenu(false); setShowKeyword(true); }}
                    className="w-full text-left px-3 py-1.5 text-[12px] text-zinc-200 hover:bg-zinc-800 transition flex items-center gap-2"
                    title="配置 TB 单关键词→应用/车型 映射（新建故事点自动识别用）">🔑 关键词映射设置</button>
                  <button onClick={() => { setShowCfgMenu(false); setShowStatusMap(true); }}
                    className="w-full text-left px-3 py-1.5 text-[12px] text-zinc-200 hover:bg-zinc-800 transition flex items-center gap-2"
                    title="配置工作流逻辑状态→该 TB 项目 taskflow 真实状态名（状态流转匹配不上时来这里配）">🔀 状态映射</button>
                </div>
              </>
            )}
          </div>
          {workspaceView === "stories" && (
            <button
              onClick={() => setShowEnvCheck(true)}
              className="shrink-0 px-2.5 py-1 text-[11px] rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-300 hover:text-white transition flex items-center gap-1"
              title="诊断本机编译环境(git/java) + 仓库拉取权限"
              data-testid="env-check-trigger"
            >🩺 环境诊断</button>
          )}
          {/* 项目维度：始终显示当前 TB 项目（多项目可下拉切换，单项目显示名+去设置提示）*/}
          {tbProjects.length > 1 ? (
            <select value={currentProjectId} onChange={(e) => selectTbProject(e.target.value)}
              title="当前 TB 项目（应用分类/车型/关键词映射按项目隔离）"
              className="shrink-0 bg-zinc-800 border border-fuchsia-700/50 rounded px-2 py-1 text-[11px] text-fuchsia-300 outline-none max-w-[180px]">
              {tbProjects.map((p) => <option key={p.id} value={p.id}>📂 {p.name}</option>)}
            </select>
          ) : (
            <span title="当前 TB 项目。到「设置 → Teambition → 操作的 TB 项目」勾选多个即可在此切换（应用分类/车型/关键词映射按项目隔离）"
              className="shrink-0 px-2 py-1 text-[11px] rounded bg-zinc-800 border border-zinc-700 text-fuchsia-300/90 max-w-[200px] truncate">
              📂 {tbProjects[0]?.name || "（未配置项目）"}<span className="text-zinc-600"> · 设置里加项目可切换</span>
            </span>
          )}
          {workspaceView === "stories" && (
            <button
              onClick={() => setShowSummary(true)}
              className="shrink-0 px-2.5 py-1 text-[11px] rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-300 hover:text-white transition flex items-center gap-1"
              title="根据对话+Git 生成 周报/月报/季度·年度绩效总结"
            >📝 总结</button>
          )}
        </div>
        {workspaceView === "stories" && <div className="px-3 flex items-center gap-1">
          <div ref={tabBarScrollRef} className="flex gap-1 overflow-x-auto items-center min-w-0 flex-1">
          {(() => {
            // 同组折叠成一个"组 tab"，只显示组名+总数+组标记；非组的照常
            // OneTab 收起：只渲染未隐藏的 tab（hidden:true 的进左侧图标托盘）
            const seen = new Set(); const entries = [];
            for (const t of visibleTabs) {
              if (t.groupId) {
                if (seen.has(t.groupId)) continue;
                seen.add(t.groupId);
                const members = visibleTabs.filter((x) => x.groupId === t.groupId);
                entries.push({ type: "group", groupId: t.groupId, groupName: t.groupName || "故事点组", members });
              } else entries.push({ type: "tab", tab: t });
            }
            return entries.map((e) => {
              if (e.type === "tab") {
                const t = e.tab;
                const isActive = activeId === t.id;
                return (
                  <button key={t.id} onClick={() => setActive(t.id)}
                    data-testid="devbench-story-tab" data-tab-id={t.id}
                    data-active-tab={isActive ? "true" : undefined}
                    className={`group px-3 py-2 text-xs whitespace-nowrap border-b-2 transition flex items-center gap-2 ${isActive ? "border-blue-500 text-zinc-100" : "border-transparent text-zinc-500 hover:text-zinc-300"}`}>
                    <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${isTabRunning(t) ? "bg-green-500 animate-pulse" : "bg-zinc-600"}`} title={isTabRunning(t) ? "AI 运行中" : "空闲"} />
                    <span className="max-w-[160px] truncate">{t.title}</span>
                    <span onClick={(ev) => { ev.stopPropagation(); onCollapseTab(t.id); }} className="opacity-0 group-hover:opacity-100 text-zinc-600 hover:text-amber-400 transition" title="收起到隐藏列表（AI 继续运行，点击左侧图标还原）">—</span>
                    <span onClick={(ev) => { ev.stopPropagation(); closeTab(t.id); }} className="opacity-0 group-hover:opacity-100 text-zinc-600 hover:text-red-400 transition" title="关闭故事点（可恢复，保留聊天）">✕</span>
                  </button>
                );
              }
              // 组 tab：从其它故事点点击时只切到组内活动成员；已在本组时再点击才展开组面板。
              const inThisGroup = e.members.some((m) => m.id === activeId);
              const activeMember = e.members.find((m) => m.groupActive) || e.members[0];
              const anyRunning = e.members.some((m) => isTabRunning(m));
              const donePhases = ["group_fixed", "verifying", "verify_blocked", "reporting", "testable", "rejected"];
              const devDone = e.members.filter((m) => donePhases.includes(m.workflow?.phase || "")).length;
              const reported = e.members.filter((m) => (m.workflow?.phase || "") === "testable").length;
              return (
                <button key={e.groupId}
                  onClick={() => {
                    if (!inThisGroup) setActive(activeMember.id);
                    else setGroupPanelTab(activeMember.id);
                  }}
                  data-active-tab={inThisGroup ? "true" : undefined}
                  className={`group px-3 py-2 text-xs whitespace-nowrap border-b-2 transition flex items-center gap-2 ${inThisGroup ? "border-violet-500 text-zinc-100" : "border-transparent text-zinc-500 hover:text-zinc-300"}`}
                  title={`故事点组「${e.groupName}」：${e.members.length} 个共用工程配置的 TB 单，${inThisGroup ? "点击展开" : "点击切换到该组"}`}>
                  <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${anyRunning ? "bg-green-500 animate-pulse" : "bg-violet-500/70"}`} />
                  <span>👥</span>
                  <span className="max-w-[160px] truncate">{e.groupName}</span>
                  <span className="text-[10px] px-1 rounded bg-violet-600/30 text-violet-200">{reported ? `${reported}/${e.members.length} 提测` : `${devDone}/${e.members.length}`}</span>
                  <span onClick={(ev) => { ev.stopPropagation(); onCollapseGroup(e.groupId); }}
                    className="opacity-0 group-hover:opacity-100 text-zinc-600 hover:text-amber-400 transition"
                    title={`收起整组到隐藏列表（${e.members.length} 个故事点，AI 继续运行，可逐个还原）`}>—</span>
                  <span onClick={(ev) => { ev.stopPropagation(); closeGroup(e.groupId); }}
                    className="opacity-0 group-hover:opacity-100 text-zinc-600 hover:text-red-400 transition"
                    title={`关闭整组（${e.members.length} 个故事点一并关闭，可恢复，保留聊天）`}>✕</span>
                </button>
              );
            });
          })()}
          </div>
          {/* OneTab 收起：隐藏的故事点只保留一个入口（📜 N），不在 tab 栏逐个显示圆点；点击打开隐藏面板 */}
          {hiddenTabs.length > 0 && (
            <div className="flex items-center px-1 ml-1 border-l border-zinc-800" data-testid="devbench-hidden-tray">
              <button onClick={() => setShowHiddenList(true)}
                className="flex items-center gap-1 h-6 px-1.5 rounded hover:bg-zinc-800 text-zinc-400 text-[10px] transition"
                title={`查看隐藏的故事点（${hiddenTabs.length} 个，按收起批次分组，可分组/逐个还原或删除）`}
                data-testid="devbench-hidden-list-trigger">
                📜<span className="text-amber-300">{hiddenTabs.length}</span>
              </button>
            </div>
          )}
          {/* 一键收起：把当前所有未隐藏的故事点全部收起到隐藏列表 */}
          {visibleTabs.length > 0 && (
            <button onClick={onHideAll}
              className="shrink-0 px-2.5 py-1.5 text-xs text-zinc-400 hover:text-amber-300 hover:bg-zinc-800 rounded transition"
              title="一键收起所有故事点到隐藏列表（AI 继续运行，可逐个还原）"
              data-testid="hide-all-tabs">— 一键收起</button>
          )}
          <div className="relative shrink-0">
            <button
              onClick={openNewMenu}
              className="px-2.5 py-1.5 text-xs text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800 rounded transition"
              title="新建故事点（本地工程自动创建独立 Git worktree，可并行复用）"
              data-testid="new-story-menu-trigger"
            >＋ 新故事点</button>
          </div>
        </div>}
      </div>

      {/* 客户端没有可用算力时显示页内横幅；局域网观察事件或分钟级兜底检测恢复后自动移除 */}
      {workspaceView === "stories" && noServer && (
        <div role="status" aria-live="polite" className="shrink-0 border-b border-amber-800/50 bg-amber-950/35 px-4 py-2">
          <div className="flex items-center gap-2.5 text-[11px]">
            <span className="shrink-0 text-amber-300" aria-hidden="true">⚠</span>
            <span className="shrink-0 font-medium text-amber-200">未连接到有算力的服务端</span>
            <span className="min-w-0 flex-1 truncate text-zinc-400" title="故事点的 AI 文本任务暂时无法运行；局域网服务变化会实时通知，另有每分钟兜底检测，服务恢复后本提示会自动消失。">
              {noServer.servers.some((s) => s.isServer && s.claudeEnabled)
                ? "已发现 AI 服务端，但当前算力已用满；故事点 AI 任务暂不可用，系统会自动重试。"
                : "暂未发现可用的 AI 服务端；故事点 AI 任务暂不可用，系统会自动重试。"}
            </span>
            <button
              onClick={() => { window.location.hash = "#/settings"; }}
              className="shrink-0 rounded border border-amber-700/60 bg-amber-900/30 px-2 py-1 text-[11px] text-amber-200 transition hover:bg-amber-900/55"
            >设置服务端</button>
          </div>
        </div>
      )}

      {workspaceView === "stories" && configInferenceReviewWarning && (
        <div
          role="alert"
          data-testid="config-inference-review-warning"
          data-run-id={configInferenceReviewWarning.runId}
          className="shrink-0 border-b border-amber-700/60 bg-amber-950/45 px-4 py-2"
        >
          <div className="flex items-start gap-2 text-[11px] text-amber-100">
            <span aria-hidden="true" className="mt-0.5 shrink-0">⚠</span>
            <span className="min-w-0 flex-1 leading-relaxed">{configInferenceReviewWarning.message}</span>
            <button
              type="button"
              onClick={() => setConfigInferenceReviewWarning(null)}
              className="shrink-0 rounded px-1.5 py-0.5 text-amber-300 transition hover:bg-amber-900/50 hover:text-amber-100"
              aria-label="关闭 AI 推理复核失败提示"
            >关闭</button>
          </div>
        </div>
      )}

      {/* 内容 */}
      <div className="flex-1 overflow-hidden">
        {workspaceView === "ai-training" ? (
          <AiTrainingPanel
            projectId={currentProjectId}
            projectName={tbProjects.find((project) => project.id === currentProjectId)?.name || tbProjects[0]?.name || ""}
            isAdmin={isAdmin}
            onToast={showToast}
          />
        ) : active ? (
          <StoryTab
            key={active.id}
            tab={active}
            projects={projects}
            otherOccupied={otherOccupied}
            messages={msgMap[active.id] || []}
            conversation={conversationMap[active.id] || null}
            live={liveMap[active.sessionId] || null}
            cloneProgress={cloneMap[active.id] || null}
            copyProgress={copyMap[active.id] || (active.copying ? { phase: "copying", copied: 0, total: 0 } : null)}
            agentRun={agentMap[active.id] || null}
            centerServers={centerServers}
            centerConfig={centerConfig}
            onSetCenter={(server) => onSetCenter(active.id, server)}
            onAgentRun={(task) => onAgentRun(active.id, task)}
            onSend={(content, messageInput) => onSend(active.id, content, messageInput)}
            onEditAndResend={(messageId, content, expectedRevision) => onEditAndResend(active.id, messageId, content, expectedRevision)}
            onSelectConversationBranch={(messageId, expectedRevision) => onSelectConversationBranch(active.id, messageId, expectedRevision)}
            onSetPrimary={(pid) => onSetPrimary(active.id, pid)}
            onSwapPrimary={(p) => onSwapPrimary(active.id, p)}
            onGitUpdate={(selection) => onGitUpdate(active.id, selection)}
            gitUpdating={gitUpdateMap[active.id]?.status === "running"}
            gitUpdate={gitUpdateMap[active.id] || null}
            onGitResolveAI={(c) => onGitResolveAI(active.id, c)}
            onGitUpdateClose={() => closeGitUpdate(active.id)}
            build={buildMap[active.id] || null}
            buildSelection={buildPanelSelMap[active.id] || null}
            onBuildSelectionChange={(updater) => setBuildPanelSelMap((m) => {
              const cur = m[active.id] || {};
              const next = typeof updater === "function" ? updater(cur) : updater;
              return { ...m, [active.id]: next };
            })}
            onBuild={(jobs) => onBuild(active.id, jobs)}
            onBuildStop={(projName) => onBuildStop(active.id, projName)}
            onBuildClose={() => closeBuild(active.id)}
            onSetTicket={(url) => onSetTicket(active.id, url)}
            onAddExtra={(p, n) => onAddExtra(active.id, p, n)}
            onRemoveExtra={(p) => onRemoveExtra(active.id, p)}
            onRename={(t) => onRename(active.id, t)}
            onRefreshTab={() => Promise.all([reloadTabs(), reloadProjects()])}
            onOpenTab={(tid) => setActive(tid)}
            onOpenGroup={() => setGroupPanelTab(active.id)}
            devices={devices}
            deviceOwners={deviceOwners}
            ticketOwners={ticketOwners}
            onRefreshDevices={refreshDevices}
            onBindDevice={(serial) => onBindDevice(active.id, serial)}
            onReleaseDevice={() => onReleaseDevice(active.id)}
            onOpenApk={() => onOpenApk(active.id)}
            onSetApkSource={(p) => onSetApkSource(active.id, p)}
            onPublishProd={() => onPublishProd(active.id)}
            onOpenProdDir={() => onOpenProdDir(active.id)}
            onPublishShareLogin={(credentials) => onPublishShareLogin(active.id, credentials)}
            onUploadResignedApk={(resignId, file) => onUploadResignedApk(active.id, resignId, file)}
            publishProgress={publishMap[active.id] || null}
            onClosePublish={() => closePublish(active.id)}
            onRebaseToOriginal={() => onRebaseToOriginal(active.id)}
            rebaseProgress={rebaseMap[active.id] || null}
            onCloseRebase={() => closeRebase(active.id)}
            onConfirmRebase={() => confirmRebaseToOriginal(active.id)}
            dingtalkConfirm={dingtalkConfirm?.tabId === active.id ? dingtalkConfirm : null}
            onConfirmDingtalk={(msg) => handleConfirmDingtalk(active.id, dingtalkConfirm?.confirmId, msg)}
            onCancelDingtalk={() => handleCancelDingtalk()}
            onToast={showToast}
            isRunning={isTabRunning(active)}
            onStartTriage={() => onStartTriage(active.id)}
            onMarkFixed={() => onMarkFixed(active.id)}
            onStartVerify={() => onStartVerify(active.id)}
            onStartReport={() => onStartReport(active.id)}
            onRetryTbSync={(action) => onRetryTbSync(active.id, action)}
            onStartCodeReview={() => onStartCodeReview(active.id)}
            onSetAutoMode={(m) => onSetAutoMode(active.id, m)}
            onSetWorkflowPhase={(phase) => onSetWorkflowPhase(active.id, phase)}
            onSetReportMode={(m) => onSetReportMode(active.id, m)}
            onSetSkipTestAcceptance={(skipped) => onSetSkipTestAcceptance(active.id, skipped)}
            configClip={configClip}
            repositoryPathAlert={repositoryPathAlertMap[active.id] || null}
            onOpenStoryConfig={() => openStoryConfiguration(active.id)}
            onCopyConfig={() => onCopyConfig(active.id)}
            onApplyConfig={() => onApplyConfig(active.id)}
            onArchiveRestored={(tabId) => loadMessages(tabId)}
            onStop={() => onStop(active.id, active.sessionId)}
            onReject={async () => {
              const r = await devbenchApi.workflowReject(active.id);
              if (r?.ok) showToast("已确认拒绝该 TB 单"); else showToast(r?.error || "拒绝失败");
              await reloadTabs();
            }}
          />
        ) : (
          <div className="h-full flex flex-col items-center justify-center text-zinc-500 gap-3">
            {hiddenTabs.length > 0 ? (
              <>
                <p className="text-sm">所有故事点已收起到隐藏列表（{hiddenTabs.length} 个，AI 继续运行）</p>
                <div className="flex gap-2">
                  <button onClick={() => setShowHiddenList(true)} className="px-4 py-2 text-xs rounded-lg bg-amber-600 hover:bg-amber-500 text-white transition">
                    📜 查看隐藏列表
                  </button>
                  {hiddenTabs[0] && (
                    <button onClick={() => onRestoreTab(hiddenTabs[0].id)} className="px-4 py-2 text-xs rounded-lg bg-blue-600 hover:bg-blue-500 text-white transition">
                      还原上一个（{hiddenTabs[0].title || "未命名"}）
                    </button>
                  )}
                  <button onClick={openNewMenu} className="px-4 py-2 text-xs rounded-lg bg-zinc-700 hover:bg-zinc-600 text-zinc-200 transition">
                    ＋ 新建一个故事点
                  </button>
                </div>
              </>
            ) : (
              <>
                <p className="text-sm">还没有故事点</p>
                <button onClick={openNewMenu} className="px-4 py-2 text-xs rounded-lg bg-blue-600 hover:bg-blue-500 text-white transition">
                  ＋ 新建一个故事点
                </button>
              </>
            )}
          </div>
        )}
      </div>

      {/* 任务列表面板 */}
      {showTasks && (
        <TaskPanel onClose={() => setShowTasks(false)} onToast={showToast} onStartDev={startDevFromTask} onStartGroupDev={startGroupDevFromTasks} onTeamDev={teamDevFromTask} onCancelTeam={cancelTeamFromTask} openTabs={tabs} />
      )}

      {/* 故事点组面板（顶层，可从组 tab / 故事点内打开） */}
      {groupPanelTab && (
        <GroupPanel tabId={groupPanelTab} onClose={() => setGroupPanelTab(null)}
          onOpenTab={(tid) => setActive(tid)} onRefreshTab={() => reloadTabs()} onToast={showToast} />
      )}

      {/* 甄别前：拉取远程最新代码（保留本地改动）弹窗 */}
      {pullModal && (
        <PullLatestModal
          tabId={pullModal.tabId}
          onClose={() => setPullModal(null)}
          onProceed={() => { const id = pullModal.tabId; setPullModal(null); runTriage(id); }}
          onToast={showToast}
          onRefreshTab={() => reloadTabs()}
          setRunningTabs={setRunningTabs}
        />
      )}

      {/* 新建故事点：居中面板（Git / TB / 历史） */}
      {showNewMenu && (
        <NewStoryPanel
          projectDefs={projectDefs}
          localProjects={projects}
          projectId={currentProjectId}
          copySources={copySources}
          envStatus={envStatus}
          onClose={() => setShowNewMenu(false)}
          onOpenEnvCheck={() => setShowEnvCheck(true)}
          onCreateBlank={newTab}
          onAskTitle={askTitle}
          onReopenClosed={reopenClosed}
          onPurgeClosed={openClosedStoryPurge}
          onPreviewGitCommit={previewStoryPointFromGitCommit}
          onCreateFromGitCommit={createStoryPointFromGitCommit}
          onResolveGitCommitBatch={resolveGitCommitStoryBatch}
          onCreateFromGitCommitBatch={createStoryPointsFromGitCommits}
          onCreateFromTb={createStoryPointFromTb}
          onCreateFromBackup={createStoryPointFromBackup}
        />
      )}

      {/* OneTab 风格：隐藏列表面板（按收起批次分组显示，支持分组/逐个还原、删除、全部还原） */}
      {showHiddenList && (
        <HiddenTabsDropdown
          tabs={hiddenTabs}
          isTabRunning={isTabRunning}
          onRestore={onRestoreTab}
          onRestoreBatch={onRestoreBatch}
          onDelete={onDeleteHiddenTab}
          onRestoreAll={async () => {
            const toRestore = hiddenTabs;
            if (!toRestore.length) { setShowHiddenList(false); return; }
            const restoreIds = new Set(toRestore.map((t) => t.id));
            const origById = new Map(toRestore.map((t) => [t.id, t]));
            // 乐观还原：本地立即取消隐藏（含清除批次字段），并切到第一个还原的 tab。
            setTabs((prev) => prev.map((t) => restoreIds.has(t.id) ? { ...t, hidden: false, hideBatchId: undefined, hideBatchAt: undefined, updatedAt: Date.now() } : t));
            setShowHiddenList(false);
            if (toRestore[0]) setActive(toRestore[0].id);
            // 并行 PUT（原实现串行 N 次往返，隐藏列表多时明显卡顿）。
            const results = await Promise.all(
              toRestore.map((t) => devbenchApi.setTabHidden(t.id, false).catch(() => ({ ok: false })))
            );
            const failedIds = new Set(toRestore.filter((_, i) => !results[i].ok).map((t) => t.id));
            if (failedIds.size) {
              setTabs((prev) => prev.map((t) => failedIds.has(t.id)
                ? { ...t, hidden: true, hideBatchId: origById.get(t.id)?.hideBatchId, hideBatchAt: origById.get(t.id)?.hideBatchAt }
                : t));
              showToast(`${failedIds.size} 个故事点还原失败，请重试`);
            }
          }}
          onClose={() => setShowHiddenList(false)}
        />
      )}

      {worktreeRebuild && (
        <WorktreeRebuildConfirmModal
          pending={worktreeRebuild}
          onClose={() => setWorktreeRebuild(null)}
          onDone={async () => {
            setWorktreeRebuild(null);
            await reloadTabs();
          }}
          onToast={showToast}
        />
      )}

      {configSuggest && (!isDeferredStoryInitializationPanelEntry(configSuggest)
        || storyInitialization?.inferenceReviewOpen) && (
        <ConfigSuggestModal
          key={`${configSuggest.session?.id || "run"}:${configSuggest.session?.version || ""}:${configSuggest.session?.predictionRevision ?? ""}:${configSuggest.session?.updatedAt || ""}`}
          session={configSuggest.session}
          busy={configSuggestBusy}
          canPersistConfig={isAdmin}
          stacked={isDeferredStoryInitializationPanelEntry(configSuggest)}
          submitLabel={isDeferredStoryInitializationPanelEntry(configSuggest) ? "确认应用到初始化配置" : ""}
          onClose={isDeferredStoryInitializationPanelEntry(configSuggest)
            ? () => closeStoryInitializationInferenceResult(configSuggest.deferredEntry?.flowId)
            : undefined}
          onContinueMainFlow={isDeferredStoryInitializationPanelEntry(configSuggest)
            ? () => {
              const current = storyInitializationRef.current;
              if (!current || current.flowId !== configSuggest.deferredEntry?.flowId) return;
              configInferencePresentationGuardRef.current.suppress(configSuggest.session?.id);
              setConfigSuggest(null);
              patchStoryInitialization(current.flowId, {
                inferenceReviewOpen: false,
                inferencePhase: "review_ready",
              });
              void confirmStoryInitialization(current.currentDraft || current.initialDraft);
            }
            : undefined}
          continueMainFlowDisabled={!!storyInitialization?.busy
            || !!storyInitialization?.partialRecovery
            || storyInitialization?.sourceConfigReady === false}
          onSubmit={submitConfigInferenceReview}
          onSkip={() => submitConfigInferenceReview({
            decision: "insufficient",
            rating: 1,
            correctedPrediction: { targets: [] },
            apply: false,
          })}
        />
      )}

      {closedStoryPurge && (
        <ClosedStoryPurgeModal
          story={closedStoryPurge}
          onClose={() => setClosedStoryPurge(null)}
          onDeleted={closedStoryPurged}
        />
      )}

      {/* 工程/设备被占用：列出被占用项，支持改工程/复制；设备可接管或不绑定 */}
      {projConflict && (
        <ProjectConflictModal
          error={projConflict.error}
          occupied={projConflict.occupied || []}
          occupiedDevices={projConflict.occupiedDevices || []}
          projects={projConflict.projects || []}
          occupiedPaths={projConflict.occupiedPaths || new Set()}
          onCancel={cancelProjConflict}
          onApply={applyProjConflict}
        />
      )}

      {/* 组队开发：选一个已有故事点作为"组锚"，共用其工程配置 */}
      {teamPick && (
        <div className="fixed inset-0 z-[70] flex items-start justify-center bg-black/55 pt-16" onClick={() => setTeamPick(null)}>
          <div className="w-[560px] max-w-[94vw] max-h-[74vh] flex flex-col bg-zinc-900 border border-zinc-700 rounded-xl shadow-2xl" onClick={(e) => e.stopPropagation()}>
            <div className="px-4 py-3 border-b border-zinc-800">
              <div className="text-sm font-semibold text-zinc-100">👥 组队开发 · 选择共用工程配置的故事点</div>
              <div className="text-[11px] text-zinc-500 mt-0.5">「{teamPick.task?.title}」将加入所选故事点的组（同一工程串行解不同 TB 单）；新成员会继承并锁定组锚的工程、构建与设备配置，标题和 TB 绑定仍独立确认。</div>
            </div>
            <div className="px-3 py-2 overflow-auto space-y-2">
              {(teamPick.sources.open || []).filter((s) => s.id !== teamPick.task?.tabId).length > 0 && (
                <div className="text-[10px] text-zinc-500 px-1 pt-1">当前打开的故事点</div>
              )}
              {(teamPick.sources.open || []).filter((s) => s.id !== teamPick.task?.tabId).map((s) => (
                <button key={s.id} onClick={() => confirmTeamDev({ id: s.id, closed: false })}
                  className="w-full flex items-center gap-2 px-2.5 py-2 rounded border border-zinc-800 bg-zinc-800/40 hover:bg-zinc-800 text-left transition">
                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-700/40 text-emerald-200 shrink-0">打开中</span>
                  <span className="flex-1 truncate text-[12px] text-zinc-200">{s.title}{s.projectName ? <span className="text-zinc-500"> · {s.projectName}</span> : null}</span>
                  {s.groupId && <span className="text-[10px] text-violet-300 shrink-0" title={s.groupName || ""}>已有组</span>}
                  <span className="text-[11px] text-blue-300 shrink-0">选它组队 ›</span>
                </button>
              ))}
              {(teamPick.sources.closed || []).length > 0 && <div className="text-[10px] text-zinc-500 px-1 pt-1">已关闭的故事点（选用会先恢复）</div>}
              {(teamPick.sources.closed || []).map((s) => (
                <button key={s.id} onClick={() => confirmTeamDev({ id: s.id, closed: true })}
                  className="w-full flex items-center gap-2 px-2.5 py-2 rounded border border-zinc-800 bg-zinc-800/20 hover:bg-zinc-800 text-left transition">
                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-zinc-700 text-zinc-400 shrink-0">已关闭</span>
                  <span className="flex-1 truncate text-[12px] text-zinc-300">{s.title}</span>
                  <span className="text-[11px] text-blue-300 shrink-0">恢复并组队 ›</span>
                </button>
              ))}
              {!(teamPick.sources.open || []).filter((s) => s.id !== teamPick.task?.tabId).length && !(teamPick.sources.closed || []).length && (
                <div className="text-[12px] text-zinc-500 py-6 text-center">还没有其它故事点可组队。先用「执行开发」建一个配好工程的故事点，再来组队。</div>
              )}
            </div>
            <div className="px-4 py-3 border-t border-zinc-800 flex justify-end">
              <button onClick={() => setTeamPick(null)} className="px-4 py-1.5 text-xs rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-300">取消</button>
            </div>
          </div>
        </div>
      )}

      {/* 附件超阈值确认弹窗（甄别自动下载时若 >10个/单个>20MB/合计>50MB 触发） */}
      {attachConfirm && (
        <AttachmentConfirmModal
          data={attachConfirm}
          progress={attachProgress && attachProgress.tabId === attachConfirm.tabId ? attachProgress : null}
          onClose={onSkipAttachConfirm}
          onConfirm={onConfirmDownloadAttachments}
          pendingTriage={!!attachConfirm.pendingTriage}
        />
      )}

      {storyInitialization && (
        <StoryInitializationPanel
          mode={storyInitialization.mode}
          initialDraft={storyInitialization.initialDraft}
          projects={projects}
          projectApplications={projectApplications}
          projectMappingError={projectMappingError}
          projectDefs={projectDefs}
          vehicleSourceConfig={storyInitialization.vehicleSourceConfig}
          devices={devices}
          onRefreshDevices={refreshDevices}
          existingTitles={[...existingTitles()]}
          currentTitle={storyInitialization.currentTitle}
          deviceOwners={deviceOwners}
          inferenceEnabled={storyInitialization.inferenceEnabled}
          inferencePhase={storyInitialization.inferencePhase || "disabled"}
          inferenceStatus={storyInitialization.inferenceStatus || "ready"}
          inferenceActionLabel={storyInitialization.pendingSkipReview
            ? "重试保存暂不采用决定"
            : storyInitialization.inferencePhase === "stale" ? "按当前信息重新推理" : "重试检查与推理"}
          inferenceSummary={
            ["error", "stale"].includes(storyInitialization.inferencePhase)
              ? storyInitialization.error
              : storyInitialization.inferenceSummary
          }
          inferenceResultAvailable={["review_ready", "reviewing"].includes(storyInitialization.inferencePhase)
            && isDeferredStoryInitializationPanelEntry(configSuggest)
            && configSuggest.deferredEntry?.flowId === storyInitialization.flowId}
          inferenceReviewOpen={storyInitialization.inferenceReviewOpen === true}
          conflictItems={storyInitialization.conflictItems}
          sourceLabel={storyInitialization.sourceLabel}
          sharedConfigurationDraft={storyInitialization.sharedConfigurationDraft}
          sharedConfigurationSource={storyInitialization.sharedConfigurationSource}
          busy={storyInitialization.busy}
          controlsLocked={false}
          partialRecovery={storyInitialization.partialRecovery}
          canConfirm={!storyInitialization.partialRecovery && storyInitialization.sourceConfigReady !== false
            }
          error={storyInitialization.error || storyInitialization.sourceConfigError}
          onClose={closeStoryInitialization}
          onOpenPartialRecovery={openStoryInitializationPartialRecovery}
          onOpenInferenceResult={() => openStoryInitializationInferenceResult(storyInitialization.flowId)}
          onConfirm={confirmStoryInitialization}
          onRunInference={["error", "stale"].includes(storyInitialization.inferencePhase)
            ? storyInitialization.pendingSkipReview
              ? () => retryStoryInitializationSkipReview(storyInitialization.flowId)
              : () => prepareStoryInitializationInference(storyInitialization.flowId)
            : undefined}
          onDraftChange={syncStoryInitializationDraft}
          onInferenceAttachmentsChange={(list) => {
            const flowId = storyInitializationRef.current?.flowId;
            if (!flowId) return;
            patchStoryInitialization(flowId, { inferenceAttachments: Array.isArray(list) ? list : [] });
          }}
          onRefreshProjects={reloadProjects}
          onToast={showToast}
        />
      )}

      {/* 工程配置弹窗 */}
      {showConfig && (
        <ProjectConfigModal
          projects={projects}
          projectId={currentProjectId}
          initialTab={configInitialTab}
          onClose={() => setShowConfig(false)}
          onChanged={() => { void reloadProjects(); }}
          isAdmin={isAdmin}
        />
      )}
      {showSharedBackup && (
        <SharedBackupModal onClose={() => setShowSharedBackup(false)} onToast={showToast} />
      )}
      {showDingMsg && (
        <DingtalkMsgConfigModal onClose={() => setShowDingMsg(false)} onToast={showToast} />
      )}
      {showKeyword && (
        <KeywordMappingModal projectId={currentProjectId} onClose={() => setShowKeyword(false)} onToast={showToast} />
      )}
      {showStatusMap && (
        <StatusMappingModal projectId={currentProjectId} onClose={() => setShowStatusMap(false)} onToast={showToast} />
      )}
      {showEnvCheck && (
        <EnvCheckModal repos={projectDefs} onClose={() => setShowEnvCheck(false)} onToast={showToast} />
      )}

      {/* 总结面板 */}
      {showSummary && (
        <SummaryPanel tabId={activeId} onClose={() => setShowSummary(false)} onToast={showToast} />
      )}

      {/* toast */}
      {toast && (
        <div className="absolute bottom-4 left-1/2 -translate-x-1/2 z-50 px-4 py-2 rounded-lg bg-red-600/90 text-white text-xs shadow-lg">
          {toast}
        </div>
      )}

    </div>
  );
}

// 新建菜单里的一个"可复制来源"条目：展示标题 + 主工程 + 设备 + 关联工程数
// 附件超阈值确认弹窗：列出待下载附件可勾选，显示合计大小与逐个下载进度
function AttachmentConfirmModal({ data, progress, onClose, onConfirm, pendingTriage = false }) {
  const items = data.items || [];
  const [checked, setChecked] = useState(() => new Set(items.map((_, i) => i)));
  const toggle = (i) => setChecked((s) => { const n = new Set(s); n.has(i) ? n.delete(i) : n.add(i); return n; });
  const fmt = (n) => !n ? "" : n < 1024 * 1024 ? (n / 1024).toFixed(0) + "KB" : (n / 1024 / 1024).toFixed(1) + "MB";
  const selected = items.filter((_, i) => checked.has(i));
  const totalMB = (selected.reduce((s, a) => s + (a.size || 0), 0) / 1024 / 1024).toFixed(1);
  const running = !!progress && !progress.finished;
  const finished = !!progress && progress.finished;
  const statusOf = (name) => progress?.files?.[name];
  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/55" onClick={running ? undefined : onClose}>
      <div className="w-[560px] max-w-[94vw] max-h-[82vh] flex flex-col bg-zinc-900 border border-zinc-700 rounded-xl shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="px-4 py-3 border-b border-zinc-800">
          <div className="text-sm font-semibold text-zinc-100">⬇ 附件较多/较大，请确认下载</div>
          <div className="text-[11px] text-amber-300 mt-1">触发原因：{(data.reasons || []).join("、")}　共 {data.count} 个、合计约 {(data.totalSize / 1024 / 1024).toFixed(1)}MB。下载到克隆父路径/AllDocs/StoryDev/&lt;故事点&gt;/archives/，供 AI 读取。</div>
          {pendingTriage && (
            <div className="text-[11px] text-sky-300 mt-1">确认下载或跳过后将继续 AI 甄别。</div>
          )}
        </div>
        <div className="px-4 py-2 overflow-auto flex-1 space-y-1">
          {items.map((a, i) => {
            const st = statusOf(a.name);
            return (
              <label key={i} className="flex items-center gap-2 px-2 py-1.5 rounded border border-zinc-800 bg-zinc-800/40 cursor-pointer">
                <input type="checkbox" checked={checked.has(i)} disabled={running || finished} onChange={() => toggle(i)} />
                <span className="flex-1 truncate text-[12px] text-zinc-200" title={a.name}>📎 {a.name}</span>
                <span className="text-[11px] text-zinc-500">{fmt(a.size)}</span>
                {st === "downloading" && <span className="text-[11px] text-blue-300 animate-pulse">下载中…</span>}
                {st === "done" && <span className="text-[11px] text-emerald-400">✓ 已下载</span>}
                {st === "error" && <span className="text-[11px] text-red-400">✗ 失败</span>}
              </label>
            );
          })}
        </div>
        <div className="px-4 py-3 border-t border-zinc-800 flex items-center gap-2">
          <span className="text-[11px] text-zinc-500">已选 {selected.length} 个 · {totalMB}MB</span>
          <div className="ml-auto flex gap-2">
            {finished ? (
              <button onClick={onClose} className="px-4 py-1.5 text-xs rounded bg-emerald-600 hover:bg-emerald-500 text-white">
                {pendingTriage ? "继续甄别 →" : "完成"}
              </button>
            ) : (
              <>
                <button onClick={onClose} disabled={running} className="px-3 py-1.5 text-xs rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-300 disabled:opacity-50">
                  {running ? "下载中…" : (pendingTriage ? "跳过，直接甄别" : "稍后")}
                </button>
                <button onClick={() => onConfirm?.(selected)} disabled={running || !selected.length}
                  className="px-4 py-1.5 text-xs rounded bg-blue-600 hover:bg-blue-500 text-white disabled:bg-zinc-700 disabled:text-zinc-500">
                  {pendingTriage ? `下载所选并甄别 (${selected.length})` : `下载所选 ${selected.length} 个`}
                </button>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// OneTab 风格：生成一次收起操作的隐藏批次（同一次操作内所有故事点共享 hideBatchId，
// 隐藏面板按批次分组显示、支持整组还原；还原后清除批次字段，下次收起再归新批次）。
function makeHideBatch() {
  const at = Date.now();
  return { id: `h-${at}-${Math.random().toString(36).slice(2, 8)}`, at };
}

// 隐藏批次组头时间（本地时间 yyyy-MM-dd HH:mm）。
function formatHideBatchTime(ts) {
  if (!ts) return "";
  const d = new Date(ts);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// OneTab 风格：隐藏列表面板。按收起批次分组显示（同一次收起操作归为一组，OneTab 风格），
// 支持整组还原 / 逐个还原 / 删除 / 一键全部还原。
function HiddenTabsDropdown({ tabs, isTabRunning, onRestore, onRestoreBatch, onRestoreAll, onDelete, onClose }) {
  // 按 hideBatchId 分组；旧数据没有批次字段的隐藏故事点归入 "legacy" 组（较早收起）。
  const groups = useMemo(() => {
    const map = new Map();
    for (const t of tabs) {
      const key = t.hideBatchId || "legacy";
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(t);
    }
    return [...map.entries()]
      .map(([key, members]) => ({
        key,
        at: members[0]?.hideBatchAt || members[0]?.updatedAt || members[0]?.createdAt || 0,
        members,
      }))
      .sort((a, b) => (b.at || 0) - (a.at || 0));
  }, [tabs]);

  if (!tabs || !tabs.length) {
    return (
      <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/55" onClick={onClose}>
        <div className="w-[420px] max-w-[94vw] flex flex-col bg-zinc-900 border border-zinc-700 rounded-xl shadow-2xl" onClick={(e) => e.stopPropagation()}>
          <div className="px-4 py-3 border-b border-zinc-800 text-sm text-zinc-300">没有已收起的故事点</div>
          <div className="px-4 py-3 flex justify-end"><button onClick={onClose} className="px-3 py-1.5 text-xs rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-300">关闭</button></div>
        </div>
      </div>
    );
  }
  const runningCount = tabs.filter((t) => isTabRunning(t)).length;
  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/55" onClick={onClose}>
      <div className="w-[640px] max-w-[94vw] max-h-[82vh] flex flex-col bg-zinc-900 border border-zinc-700 rounded-xl shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="px-4 py-3 border-b border-zinc-800">
          <div className="text-sm font-semibold text-zinc-100">📜 隐藏的故事点（{tabs.length}）</div>
          <div className="text-[11px] text-zinc-500 mt-1">
            收起 ≠ 关闭：AI 任务与聊天会话继续运行，工程仍被占用。同一次收起的归为一组，可整组还原。
            {runningCount > 0 && <span className="text-emerald-400"> · {runningCount} 个 AI 运行中</span>}
          </div>
        </div>
        <div className="px-4 py-2 overflow-auto flex-1 space-y-2">
          {groups.map((g) => (
            <div key={g.key} className="rounded-lg border border-zinc-800 bg-zinc-900/40">
              <div className="flex items-center gap-2 px-3 py-1.5 border-b border-zinc-800/80 bg-zinc-800/40 rounded-t-lg">
                <span className="text-[11px] text-zinc-400">🕐 {g.key === "legacy" ? "较早收起" : formatHideBatchTime(g.at)}</span>
                <span className="text-[10px] px-1.5 py-px rounded bg-zinc-700/60 text-zinc-300">{g.members.length} 个</span>
                <button onClick={() => onRestoreBatch(g.members)} className="ml-auto px-2.5 py-0.5 text-[11px] rounded bg-blue-600/80 hover:bg-blue-500 text-white transition">还原整组</button>
              </div>
              <div className="p-1 space-y-1">
                {g.members.map((t) => (
                  <div key={t.id} className="flex items-center gap-2 px-2 py-1.5 rounded border border-zinc-800/70 bg-zinc-800/30">
                    <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${isTabRunning(t) ? "bg-green-500 animate-pulse" : "bg-amber-500"}`} title={isTabRunning(t) ? "AI 运行中" : "空闲"} />
                    <span className="flex-1 truncate text-[12px] text-zinc-200" title={t.title}>{t.groupId ? "👥 " : ""}{t.title || "(未命名)"}</span>
                    <button onClick={() => onRestore(t.id)} className="px-2.5 py-1 text-[11px] rounded bg-blue-600 hover:bg-blue-500 text-white transition">还原</button>
                    <button onClick={() => onDelete(t.id)} className="px-2 py-1 text-[11px] rounded bg-zinc-800 hover:bg-red-600/80 hover:text-white text-zinc-400 transition"
                      title="删除（关闭并移入已关闭列表，聊天/配置保留，可恢复）">🗑</button>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
        <div className="px-4 py-3 border-t border-zinc-800 flex items-center gap-2">
          <span className="text-[11px] text-zinc-500">共 {tabs.length} 个已收起</span>
          <div className="ml-auto flex gap-2">
            <button onClick={onClose} className="px-3 py-1.5 text-xs rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-300">关闭</button>
            <button onClick={onRestoreAll} className="px-4 py-1.5 text-xs rounded bg-emerald-600 hover:bg-emerald-500 text-white">全部还原</button>
          </div>
        </div>
      </div>
    </div>
  );
}
