import React, { useState, useEffect, useRef, useCallback } from "react";
import { createGatewayWebSocket, getApiUrl } from "../services/gateway.js";
import { authenticatedFetch } from "../services/adminAuth.js";
import ResourcePerformanceTab, { ResourceScriptLibrary } from "./performance/ResourcePerformanceTab.jsx";
import ResourcePerformanceTestTab from "./performance/ResourcePerformanceTestTab.jsx";
import {
  applyResourceLiveEvent,
  mergeResourceRunSnapshot,
  pendingResourceRunId,
  resourceLiveRunId,
} from "./performance/resourceLiveModel.mjs";
import {
  chooseResourceScriptId,
  effectiveResourceRunForm,
  findResourceScript,
  groupResourceScripts,
  normalizeResourceScripts,
  parseResourceScriptsJson,
  resourceScriptAvailability,
} from "./performance/resourceScriptModel.mjs";
import { applySamplingModeChange } from "./performance/resourceSamplingModeModel.mjs";

// 冷启动达标阈值（与 docs/performance 计划 §6 对齐）
const TARGET_OK = 2000;   // < 2.0s 良好
const TARGET_WARN = 2500; // 2.0~2.5s 一般；> 2.5s 偏慢

const DEFAULT_RESOURCE_FORM = {
  serial: "",
  flavor: "",
  package: "com.appmarket.automotive",
  duration: 180,
  interval: 5,
  samplingMode: "standard",
  executeFlow: true,
  captureScreenrecord: true,
  capturePerfetto: false,
  testAppTitle: "",
};

const RESOURCE_STATUS_NAMES = {
  idle: "未运行",
  starting: "准备中",
  running: "采集中",
  stopping: "停止中",
  completed: "已完成",
  completed_with_upload_error: "采集完成，上报失败",
  cancelled: "已取消",
  failed: "失败",
};

function normalizeResourceForm(raw = {}) {
  const samplingMode = raw?.samplingMode === "realtime" ? "realtime" : "standard";
  return {
    ...DEFAULT_RESOURCE_FORM,
    ...(raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {}),
    serial: String(raw?.serial ?? DEFAULT_RESOURCE_FORM.serial),
    flavor: String(raw?.flavor ?? DEFAULT_RESOURCE_FORM.flavor),
    package: String(raw?.package ?? DEFAULT_RESOURCE_FORM.package),
    duration: Number.isFinite(Number(raw?.duration)) ? Number(raw.duration) : DEFAULT_RESOURCE_FORM.duration,
    interval: Number.isFinite(Number(raw?.interval)) ? Number(raw.interval) : DEFAULT_RESOURCE_FORM.interval,
    samplingMode,
    executeFlow: raw?.executeFlow !== false,
    captureScreenrecord: raw?.captureScreenrecord !== false,
    capturePerfetto: samplingMode === "realtime" || raw?.capturePerfetto === true,
    testAppTitle: String(raw?.testAppTitle ?? DEFAULT_RESOURCE_FORM.testAppTitle),
  };
}

async function readPerformanceResponse(response) {
  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new Error(`服务返回了非 JSON 响应（HTTP ${response.status}）`);
  }
  if (!response.ok || payload?.success === false) {
    throw new Error(payload?.error || `HTTP ${response.status}`);
  }
  return payload?.data ?? payload;
}

export default function Performance() {
  const [tab, setTab] = useState("overview");
  const [days, setDays] = useState(30);
  const [stats, setStats] = useState({ overall: {}, byFlavor: [], events: { crash: 0, anr: 0 } });
  const [sessions, setSessions] = useState([]);
  const [events, setEvents] = useState([]);
  const [rounds, setRounds] = useState([]);
  const [reports, setReports] = useState([]);
  const [versions, setVersions] = useState([]);
  const [baseVer, setBaseVer] = useState("");
  const [targetVer, setTargetVer] = useState("");
  const [resMetrics, setResMetrics] = useState({ memory: [], cpu: [], ui: [] });
  const [top, setTop] = useState([]);
  const [logcap, setLogcap] = useState({ running: false });
  const [resourceRun, setResourceRun] = useState({ status: "idle", running: false, logs: [] });
  const [resourceRuns, setResourceRuns] = useState([]);
  const [resourceTestRuns, setResourceTestRuns] = useState([]);
  const [selectedResourceRunId, setSelectedResourceRunId] = useState("");
  const [selectedResourceTestRunId, setSelectedResourceTestRunId] = useState("");
  const [resourceDetail, setResourceDetail] = useState(null);
  const [resourceDetailLoading, setResourceDetailLoading] = useState(false);
  const [resourceDetailError, setResourceDetailError] = useState("");
  const [resourceBusy, setResourceBusy] = useState(false);
  const [resourceForm, setResourceForm] = useState(DEFAULT_RESOURCE_FORM);
  const [resourceConfigRun, setResourceConfigRun] = useState(DEFAULT_RESOURCE_FORM);
  const [resourceFlowJson, setResourceFlowJson] = useState("{}");
  const [resourceScripts, setResourceScripts] = useState([]);
  const [resourceScriptLibrary, setResourceScriptLibrary] = useState(null);
  const [resourceScriptsJson, setResourceScriptsJson] = useState("[]");
  const [resourceDefaultScriptId, setResourceDefaultScriptId] = useState("");
  const [selectedResourceScriptId, setSelectedResourceScriptId] = useState("");
  const [resourceConfigLoading, setResourceConfigLoading] = useState(true);
  const [resourceConfigSaving, setResourceConfigSaving] = useState(false);
  const [resourceConfigError, setResourceConfigError] = useState("");
  const [resourceConfigLoadError, setResourceConfigLoadError] = useState("");
  const [resourceConfigNotice, setResourceConfigNotice] = useState("");
  const [capSerial, setCapSerial] = useState("");
  const [selectedRound, setSelectedRound] = useState("");
  const [analyzing, setAnalyzing] = useState(false);
  const [flavor, setFlavor] = useState("");
  const wsRef = useRef(null);
  const resourceDetailAbortRef = useRef(null);
  const resourceConfigLoadRef = useRef(null);
  const resourceRunActive = !!resourceRun.running || resourceRun.status === "stopping";
  const liveResourceRunId = resourceLiveRunId(resourceRun);
  const selectedResourceDetailId = tab === "performance-test"
    ? selectedResourceTestRunId
    : selectedResourceRunId;
  const selectedResourceIsLive = !!liveResourceRunId && selectedResourceDetailId === liveResourceRunId;

  const loadResourceRunHistory = useCallback(() => {
    const query = new URLSearchParams({ limit: "100" });
    if (flavor) query.set("flavor", flavor);
    return authenticatedFetch(getApiUrl(`/api/performance/resource-runs?${query.toString()}`))
      .then((response) => response.json())
      .then((payload) => {
        if (payload.success) setResourceRuns(payload.data);
        return payload;
      })
      .catch(() => null);
  }, [flavor]);

  const loadResourceTestRunHistory = useCallback(() => {
    const query = new URLSearchParams({ limit: "100" });
    return authenticatedFetch(getApiUrl(`/api/performance/resource-runs?${query.toString()}`))
      .then((response) => response.json())
      .then((payload) => {
        if (payload.success) setResourceTestRuns(payload.data);
        return payload;
      })
      .catch(() => null);
  }, []);

  const reloadResourceRunHistories = useCallback(() => Promise.all([
    loadResourceRunHistory(),
    loadResourceTestRunHistory(),
  ]), [loadResourceRunHistory, loadResourceTestRunHistory]);

  const load = useCallback(() => {
    authenticatedFetch(getApiUrl(`/api/performance/stats?days=${days}`))
      .then((r) => r.json())
      .then((d) => { if (d.success) setStats(d.data); })
      .catch(() => {});
    const q = new URLSearchParams({ limit: "100", scenario: "cold_start" });
    if (flavor) q.set("flavor", flavor);
    authenticatedFetch(getApiUrl(`/api/performance/sessions?${q.toString()}`))
      .then((r) => r.json())
      .then((d) => { if (d.success) setSessions(d.data); })
      .catch(() => {});
    const eq = new URLSearchParams({ limit: "100" });
    if (flavor) eq.set("flavor", flavor);
    authenticatedFetch(getApiUrl(`/api/performance/events?${eq.toString()}`))
      .then((r) => r.json())
      .then((d) => { if (d.success) setEvents(d.data); })
      .catch(() => {});
    authenticatedFetch(getApiUrl(`/api/performance/rounds?limit=100`))
      .then((r) => r.json())
      .then((d) => { if (d.success) setRounds(d.data); })
      .catch(() => {});
    authenticatedFetch(getApiUrl(`/api/performance/reports?limit=50`))
      .then((r) => r.json())
      .then((d) => { if (d.success) setReports(d.data); })
      .catch(() => {});
    const vq = new URLSearchParams({ days: "90" });
    if (flavor) vq.set("flavor", flavor);
    authenticatedFetch(getApiUrl(`/api/performance/by-version?${vq.toString()}`))
      .then((r) => r.json())
      .then((d) => { if (d.success) setVersions(d.data); })
      .catch(() => {});
    ["memory", "cpu", "ui"].forEach((t) => {
      const mq = new URLSearchParams({ type: t, limit: "300" });
      if (flavor) mq.set("flavor", flavor);
      authenticatedFetch(getApiUrl(`/api/performance/metrics?${mq.toString()}`))
        .then((r) => r.json())
        .then((d) => { if (d.success) setResMetrics((prev) => ({ ...prev, [t]: d.data })); })
        .catch(() => {});
    });
    const tq = new URLSearchParams({ days: String(days), limit: "30" });
    if (flavor) tq.set("flavor", flavor);
    authenticatedFetch(getApiUrl(`/api/performance/top?${tq.toString()}`))
      .then((r) => r.json())
      .then((d) => { if (d.success) setTop(d.data); })
      .catch(() => {});
    authenticatedFetch(getApiUrl(`/api/performance/logcap/status`))
      .then((r) => r.json())
      .then((d) => { if (d.success) setLogcap(d.data); })
      .catch(() => {});
    authenticatedFetch(getApiUrl(`/api/performance/resource-run/status`))
      .then((r) => r.json())
      .then((d) => { if (d.success) setResourceRun((previous) => mergeResourceRunSnapshot(previous, d.data)); })
      .catch(() => {});
    reloadResourceRunHistories();
  }, [days, flavor, reloadResourceRunHistories]);

  useEffect(() => {
    const available = Array.isArray(resourceRuns) ? resourceRuns.slice(0, 100) : [];
    if (!available.length) {
      setSelectedResourceRunId("");
      return;
    }
    if (!available.some((run) => run.id === selectedResourceRunId)) {
      setSelectedResourceRunId(available[0].id);
    }
  }, [resourceRuns, selectedResourceRunId]);

  useEffect(() => {
    const available = Array.isArray(resourceTestRuns) ? resourceTestRuns.slice(0, 100) : [];
    const liveRunId = resourceLiveRunId(resourceRun);
    if (liveRunId && selectedResourceTestRunId === liveRunId) return;
    if (liveRunId && selectedResourceTestRunId === pendingResourceRunId()) {
      setSelectedResourceTestRunId(liveRunId);
      return;
    }
    if (!selectedResourceTestRunId && liveRunId) {
      setSelectedResourceTestRunId(liveRunId);
      return;
    }
    if (!available.length) {
      setSelectedResourceTestRunId("");
      return;
    }
    if (!available.some((run) => run.id === selectedResourceTestRunId)) {
      setSelectedResourceTestRunId(available[0].id);
    }
  }, [resourceRun, resourceTestRuns, selectedResourceTestRunId]);

  const loadResourceDetail = useCallback(() => {
    resourceDetailAbortRef.current?.abort();
    if (!selectedResourceDetailId || selectedResourceDetailId === pendingResourceRunId()) {
      setResourceDetail(null);
      setResourceDetailError("");
      setResourceDetailLoading(false);
      return Promise.resolve(false);
    }
    const preserveLive = !!liveResourceRunId && selectedResourceDetailId === liveResourceRunId;
    if (preserveLive && resourceRunActive) {
      setResourceDetailError("");
      setResourceDetailLoading(false);
      return Promise.resolve(false);
    }
    const controller = new AbortController();
    resourceDetailAbortRef.current = controller;
    if (!preserveLive) setResourceDetail(null);
    setResourceDetailError("");
    setResourceDetailLoading(!preserveLive);
    return authenticatedFetch(getApiUrl(`/api/performance/resource-runs/${encodeURIComponent(selectedResourceDetailId)}`), { signal: controller.signal })
      .then(readPerformanceResponse)
      .then((detail) => {
        if (!controller.signal.aborted) setResourceDetail(detail);
        return !controller.signal.aborted;
      })
      .catch((error) => {
        if (!preserveLive && error?.name !== "AbortError" && !controller.signal.aborted) {
          setResourceDetailError(error.message || "未知错误");
        }
        return false;
      })
      .finally(() => {
        if (resourceDetailAbortRef.current === controller) {
          resourceDetailAbortRef.current = null;
          setResourceDetailLoading(false);
        }
      });
  }, [liveResourceRunId, resourceRunActive, selectedResourceDetailId]);

  useEffect(() => {
    if ((tab !== "performance" && tab !== "performance-test") || !selectedResourceDetailId) {
      if (tab === "performance" || tab === "performance-test") {
        setResourceDetail(null);
        setResourceDetailError("");
        setResourceDetailLoading(false);
      }
      return undefined;
    }
    if (selectedResourceIsLive && resourceRunActive) {
      resourceDetailAbortRef.current?.abort();
      setResourceDetailLoading(false);
      setResourceDetailError("");
      return undefined;
    }
    let disposed = false;
    let retryTimer = null;
    let attempts = 0;
    const loadPersistedDetail = async () => {
      const loaded = await loadResourceDetail();
      if (
        !disposed
        && !loaded
        && selectedResourceIsLive
        && resourceRun.status === "completed"
        && attempts < 20
      ) {
        attempts += 1;
        retryTimer = setTimeout(loadPersistedDetail, 750);
      }
    };
    loadPersistedDetail();
    return () => {
      disposed = true;
      if (retryTimer) clearTimeout(retryTimer);
      resourceDetailAbortRef.current?.abort();
    };
  }, [
    loadResourceDetail,
    resourceRun.status,
    resourceRunActive,
    selectedResourceIsLive,
    selectedResourceDetailId,
    tab,
  ]);

  const loadResourceConfig = useCallback(() => {
    if (resourceConfigLoadRef.current) return resourceConfigLoadRef.current;
    setResourceConfigLoading(true);
    setResourceConfigError("");
    setResourceConfigLoadError("");
    setResourceConfigNotice("");
    const request = authenticatedFetch(getApiUrl(`/api/performance/resource-config`))
      .then(readPerformanceResponse)
      .then((config) => {
        const nextRun = normalizeResourceForm(config?.run);
        const nextFlow = config?.flow && typeof config.flow === "object" && !Array.isArray(config.flow)
          ? config.flow
          : {};
        const nextScripts = normalizeResourceScripts(config?.scripts);
        const nextDefaultScriptId = chooseResourceScriptId(
          nextScripts,
          config?.defaultScriptId,
          config?.defaultScriptId,
        );
        const nextScript = findResourceScript(nextScripts, nextDefaultScriptId);
        setResourceForm(normalizeResourceForm(effectiveResourceRunForm(nextRun, nextScript)));
        setResourceConfigRun(nextRun);
        setResourceFlowJson(JSON.stringify(nextFlow, null, 2));
        setResourceScripts(nextScripts);
        setResourceScriptLibrary(config?.scriptLibrary && typeof config.scriptLibrary === "object" ? config.scriptLibrary : null);
        setResourceScriptsJson(JSON.stringify(Array.isArray(config?.scripts) ? config.scripts : [], null, 2));
        setResourceDefaultScriptId(nextDefaultScriptId);
        setSelectedResourceScriptId(nextDefaultScriptId);
      })
      .catch((error) => {
        const message = `加载配置失败：${error.message}`;
        setResourceConfigError(message);
        setResourceConfigLoadError(message);
      })
      .finally(() => {
        if (resourceConfigLoadRef.current === request) resourceConfigLoadRef.current = null;
        setResourceConfigLoading(false);
      });
    resourceConfigLoadRef.current = request;
    return request;
  }, []);

  const saveResourceConfig = useCallback(() => {
    if (resourceRunActive || resourceConfigSaving) return;
    setResourceConfigError("");
    setResourceConfigNotice("");
    let flow;
    let scriptsPayload;
    try {
      flow = JSON.parse(resourceFlowJson);
      if (!flow || typeof flow !== "object" || Array.isArray(flow)) {
        throw new Error("高级流程配置必须是 JSON 对象");
      }
      scriptsPayload = parseResourceScriptsJson(resourceScriptsJson);
    } catch (error) {
      setResourceConfigError(`配置 JSON 无效：${error.message}`);
      return;
    }

    const defaultScript = scriptsPayload.scripts.find((script) => (
      script.id === resourceDefaultScriptId.trim()
      && resourceScriptAvailability(script).selectable
    ));
    if (!defaultScript) {
      setResourceConfigError("defaultScriptId 必须指向 scripts 中一个入口及工作流均可用的脚本");
      return;
    }

    const run = normalizeResourceForm(resourceConfigRun);
    if (!run.package.trim()) {
      setResourceConfigError("包名不能为空");
      return;
    }
    if (!Number.isFinite(run.duration) || run.duration < 5 || run.duration > 3600) {
      setResourceConfigError("采样时长必须在 5~3600 秒之间");
      return;
    }
    if (!Number.isFinite(run.interval) || run.interval < 1 || run.interval > 60) {
      setResourceConfigError("采样间隔必须在 1~60 秒之间");
      return;
    }
    if (Math.abs(run.duration / run.interval - Math.round(run.duration / run.interval)) > 1e-9) {
      setResourceConfigError("采样时长必须是采样间隔的整数倍");
      return;
    }

    setResourceConfigSaving(true);
    authenticatedFetch(getApiUrl(`/api/performance/resource-config`), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        run,
        flow,
        scripts: scriptsPayload.raw,
        defaultScriptId: defaultScript.id,
      }),
    })
      .then(readPerformanceResponse)
      .then((saved) => {
        const nextRun = normalizeResourceForm(saved?.run ?? run);
        const nextFlow = saved?.flow && typeof saved.flow === "object" && !Array.isArray(saved.flow)
          ? saved.flow
          : flow;
        const nextScriptsRaw = Array.isArray(saved?.scripts) ? saved.scripts : scriptsPayload.raw;
        const nextScripts = normalizeResourceScripts(nextScriptsRaw);
        const nextDefaultScriptId = chooseResourceScriptId(
          nextScripts,
          saved?.defaultScriptId,
          defaultScript.id,
        );
        const nextScript = findResourceScript(nextScripts, nextDefaultScriptId);
        setResourceForm(normalizeResourceForm(effectiveResourceRunForm(nextRun, nextScript)));
        setResourceConfigRun(nextRun);
        setResourceFlowJson(JSON.stringify(nextFlow, null, 2));
        setResourceScripts(nextScripts);
        setResourceScriptLibrary(saved?.scriptLibrary && typeof saved.scriptLibrary === "object" ? saved.scriptLibrary : null);
        setResourceScriptsJson(JSON.stringify(nextScriptsRaw, null, 2));
        setResourceDefaultScriptId(nextDefaultScriptId);
        setSelectedResourceScriptId(nextDefaultScriptId);
        setResourceConfigNotice("配置已保存；性能测试会按所选 scriptId 冻结脚本及工作流快照。");
      })
      .catch((error) => setResourceConfigError(`保存配置失败：${error.message}`))
      .finally(() => setResourceConfigSaving(false));
  }, [
    resourceConfigRun,
    resourceConfigSaving,
    resourceDefaultScriptId,
    resourceFlowJson,
    resourceRunActive,
    resourceScriptsJson,
  ]);

  const toggleLogcap = useCallback((start) => {
    const url = getApiUrl(`/api/performance/logcap/${start ? "start" : "stop"}`);
    authenticatedFetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(start ? { serial: capSerial || undefined } : {}),
    })
      .then((r) => r.json())
      .then((d) => { if (d.success) setLogcap(d.data); else alert((start ? "开始" : "停止") + "归档失败：" + (d.error || "")); })
      .catch((e) => alert("操作失败：" + e.message));
  }, [capSerial]);

  const openResourcePerformanceTest = useCallback((preferredRunId = "") => {
    const nextId = preferredRunId
      || (resourceRunActive ? liveResourceRunId : "")
      || selectedResourceTestRunId
      || resourceTestRuns[0]?.id
      || "";
    if (nextId) setSelectedResourceTestRunId(nextId);
    setTab("performance-test");
  }, [liveResourceRunId, resourceRunActive, resourceTestRuns, selectedResourceTestRunId]);

  const selectResourceScript = useCallback((scriptId) => {
    if (resourceRunActive) return;
    const nextId = chooseResourceScriptId(resourceScripts, scriptId, resourceDefaultScriptId);
    if (!nextId) return;
    const script = findResourceScript(resourceScripts, nextId);
    setSelectedResourceScriptId(nextId);
    setResourceForm((previous) => normalizeResourceForm(applySamplingModeChange(
      effectiveResourceRunForm(resourceConfigRun, script),
      previous.samplingMode,
    )));
  }, [resourceConfigRun, resourceDefaultScriptId, resourceRunActive, resourceScripts]);

  const selectResourceSamplingMode = useCallback((samplingMode) => {
    if (resourceRunActive) return;
    setResourceForm((previous) => normalizeResourceForm(applySamplingModeChange(previous, samplingMode)));
  }, [resourceRunActive]);

  const startResourceRun = useCallback(() => {
    if (resourceBusy || resourceRunActive) return;
    const taskScript = findResourceScript(resourceScripts, selectedResourceScriptId);
    const availability = resourceScriptAvailability(taskScript);
    if (!availability.selectable) {
      alert(`请选择一个可运行的测试任务脚本：${availability.reason}`);
      setTab("performance-test");
      return;
    }
    const pendingId = pendingResourceRunId();
    const startedAt = new Date().toISOString();
    const normalizedForm = normalizeResourceForm(resourceForm);
    const options = {
      ...normalizedForm,
      duration: Number(normalizedForm.duration),
      interval: Number(normalizedForm.interval),
      capturePerfetto: normalizedForm.samplingMode === "realtime" || normalizedForm.capturePerfetto,
      scriptId: taskScript.id,
    };
    resourceDetailAbortRef.current?.abort();
    setTab("performance-test");
    setSelectedResourceTestRunId(pendingId);
    setResourceDetail(null);
    setResourceDetailError("");
    setResourceDetailLoading(false);
    setResourceRun({
      status: "starting",
      running: true,
      runId: pendingId,
      startedAt,
      options,
      configSnapshot: {
        run: options,
        script: {
          id: taskScript.id,
          name: taskScript.name,
          description: taskScript.description,
          category: taskScript.category,
          tags: taskScript.tags,
          version: taskScript.version,
          runner: taskScript.runner,
          workflow: taskScript.workflow,
          ui: taskScript.ui,
        },
        flow: taskScript.flow,
      },
      logs: [],
      live: {
        phase: "starting",
        meta: {
          runId: pendingId,
          duration_s: options.duration,
          interval_s: options.interval,
          sampling_mode: options.samplingMode,
          ...(options.samplingMode === "realtime" ? {
            cpu_interval_ms: 500,
            rss_interval_ms: 1000,
            pss_interval_ms: 5000,
          } : {}),
          expected_samples: options.interval ? Math.round(options.duration / options.interval) : null,
        },
        samples: [],
        diagnosticSamples: [],
        diagnosticTotalCount: 0,
        channelEvents: [],
        progress: {
          sampleCount: 0,
          expectedSamples: options.interval ? Math.round(options.duration / options.interval) : null,
          percent: 0,
          durationS: options.duration,
          intervalS: options.interval,
        },
        currentStep: "正在创建性能采集轮次",
        stepHistory: [],
      },
    });
    setResourceBusy(true);
    const { executeFlow: _lockedWorkflowMode, ...requestOptions } = options;
    authenticatedFetch(getApiUrl(`/api/performance/resource-run/start`), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // Workflow mode belongs to task.json. Runtime requests may select a
      // script and tune device/sampling options, but cannot turn a two-node
      // launch task into the full install/menu workflow (or vice versa).
      body: JSON.stringify(requestOptions),
    })
      .then(async (r) => {
        const data = await r.json();
        if (!r.ok || !data.success) throw new Error(data.error || `HTTP ${r.status}`);
        setResourceRun((previous) => mergeResourceRunSnapshot(previous, data.data, { forceNew: true }));
        if (data.data?.runId) setSelectedResourceTestRunId(data.data.runId);
      })
      .catch((e) => {
        setResourceRun((previous) => ({
          ...previous,
          status: "failed",
          running: false,
          completedAt: new Date().toISOString(),
          error: e.message,
          live: { ...previous.live, phase: "failed", currentStep: "启动失败" },
        }));
        alert("启动资源摸测失败：" + e.message);
      })
      .finally(() => setResourceBusy(false));
  }, [resourceBusy, resourceForm, resourceRunActive, resourceScripts, selectedResourceScriptId]);

  const stopResourceRun = useCallback(() => {
    if (resourceBusy || !resourceRun.running) return;
    setResourceBusy(true);
    authenticatedFetch(getApiUrl(`/api/performance/resource-run/stop`), { method: "POST" })
      .then((r) => r.json())
      .then((d) => {
        if (!d.success) throw new Error(d.error || "未知错误");
        setResourceRun(d.data);
      })
      .catch((e) => alert("停止资源摸测失败：" + e.message))
      .finally(() => setResourceBusy(false));
  }, [resourceBusy, resourceRun.running]);

  const analyzeRound = useCallback((round) => {
    if (!round || analyzing) return;
    setAnalyzing(true);
    authenticatedFetch(getApiUrl(`/api/performance/analyze`), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ round }),
    })
      .then((r) => r.json())
      .then((d) => {
        if (d.success && d.data) setReports((prev) => [d.data, ...prev]);
        else alert("分析失败：" + (d.error || "未知错误"));
      })
      .catch((e) => alert("分析失败：" + e.message))
      .finally(() => setAnalyzing(false));
  }, [analyzing]);

  // 分析"最近数据"（手动跑 Monkey、无 round 标记时用）：按当前天数窗口 + 车型
  const analyzeRecent = useCallback(() => {
    if (analyzing) return;
    setAnalyzing(true);
    authenticatedFetch(getApiUrl(`/api/performance/analyze`), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ days, flavor: flavor || undefined }),
    })
      .then((r) => r.json())
      .then((d) => {
        if (d.success && d.data) setReports((prev) => [d.data, ...prev]);
        else alert("分析失败：" + (d.error || "未知错误"));
      })
      .catch((e) => alert("分析失败：" + e.message))
      .finally(() => setAnalyzing(false));
  }, [analyzing, days, flavor]);

  // 生成"版本对比优化报表"（优化版 vs 基线版，供工作报告）
  const analyzeVersionCompare = useCallback(() => {
    if (!targetVer || analyzing) return;
    setAnalyzing(true);
    authenticatedFetch(getApiUrl(`/api/performance/analyze`), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ targetVersion: targetVer, baseVersion: baseVer || undefined }),
    })
      .then((r) => r.json())
      .then((d) => {
        if (d.success && d.data) { setReports((prev) => [d.data, ...prev]); setTab("ai"); }
        else alert("生成报表失败：" + (d.error || "未知错误"));
      })
      .catch((e) => alert("生成报表失败：" + e.message))
      .finally(() => setAnalyzing(false));
  }, [targetVer, baseVer, analyzing]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => { loadResourceConfig(); }, [loadResourceConfig]);

  // 运行期每秒取一次轻量快照；快照内的 live.samples 由网关按本轮 runId 隔离。
  useEffect(() => {
    if (!resourceRun.running && resourceRun.status !== "stopping") return undefined;
    const timer = setInterval(() => {
      authenticatedFetch(getApiUrl(`/api/performance/resource-run/status`))
        .then((r) => r.json())
        .then((d) => {
          if (!d.success) return;
          const wasRunning = resourceRun.running || resourceRun.status === "stopping";
          setResourceRun((previous) => mergeResourceRunSnapshot(previous, d.data));
          if (wasRunning && !d.data.running) reloadResourceRunHistories();
        })
        .catch(() => {});
    }, 1000);
    return () => clearInterval(timer);
  }, [reloadResourceRunHistories, resourceRun.running, resourceRun.status]);

  // 实时刷新：车机上报后网关广播 performance_update
  useEffect(() => {
    let closed = false;
    try {
      const ws = createGatewayWebSocket();
      wsRef.current = ws;
      ws.onmessage = (e) => {
        try {
          const msg = JSON.parse(e.data);
          if (msg.type === "performance_resource_live") {
            setResourceRun((previous) => applyResourceLiveEvent(previous, msg.data));
            if (msg.data?.kind === "state" && !msg.data?.running) reloadResourceRunHistories();
            return;
          }
          if (msg.type === "performance_update" && msg.data?.kind === "resource-run") {
            setResourceRun((previous) => mergeResourceRunSnapshot(previous, msg.data));
            if (!msg.data?.running) reloadResourceRunHistories();
            return;
          }
          if (msg.type === "performance_update") load();
        } catch {}
      };
      ws.onerror = () => {};
      return () => { closed = true; try { ws.close(); } catch {} };
    } catch {
      return () => {};
    }
  }, [load, reloadResourceRunHistories]);

  const o = stats.overall || {};
  const flavors = stats.byFlavor || [];
  const ev = stats.events || {};
  const fg = stats.fg || {};
  // 启动分析只看"完成的冷启动"（有 ①②③ 数据）；runtime/未完成会话 total_ms=0 会画出无意义的灰条，过滤掉
  const startupSessions = (sessions || []).filter((s) => (s.total_ms || 0) > 0);
  // 按「版本(versionCode/versionName)」分组：同版本会话归一组，组内仍按时间倒序（sessions 已按 created_at DESC）。
  const startupGroups = Object.values(
    startupSessions.reduce((acc, s) => {
      const key = `${s.app_version_code || 0}|${s.app_version || ""}`;
      if (!acc[key]) acc[key] = { key, version: s.app_version, versionCode: s.app_version_code, flavor: s.flavor, items: [] };
      acc[key].items.push(s);
      return acc;
    }, {})
  ).sort((a, b) => (b.versionCode || 0) - (a.versionCode || 0));

  return (
    <div className="p-6 overflow-y-auto h-full space-y-6">
      {/* 头部 */}
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-medium text-zinc-300">应用市场性能</h2>
        <div className="flex items-center gap-2">
          {resourceRunActive && (
            <span className="text-xs rounded bg-blue-500/15 px-2 py-1 text-blue-400">
              CPU / 内存：{RESOURCE_STATUS_NAMES[resourceRun.status] || resourceRun.status || "运行中"}
            </span>
          )}
          <select
            value={flavor}
            onChange={(e) => setFlavor(e.target.value)}
            className="text-xs bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-zinc-300"
          >
            <option value="">全部车型</option>
            {flavors.map((f) => (
              <option key={f.flavor || "?"} value={f.flavor || ""}>{f.flavor || "(未知)"}</option>
            ))}
          </select>
          <select
            value={days}
            onChange={(e) => setDays(parseInt(e.target.value))}
            className="text-xs bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-zinc-300"
          >
            <option value={7}>近 7 天</option>
            <option value={14}>近 14 天</option>
            <option value={30}>近 30 天</option>
          </select>
          <button onClick={load} className="text-xs bg-zinc-800 border border-zinc-700 rounded px-3 py-1 text-zinc-300 hover:bg-zinc-700 transition">刷新</button>
        </div>
      </div>

      {/* Tab 切换 */}
      <div className="flex gap-1 border-b border-zinc-800 overflow-x-auto whitespace-nowrap">
        <TabBtn active={tab === "overview"} onClick={() => setTab("overview")}>总览</TabBtn>
        <TabBtn active={tab === "performance-test"} onClick={() => openResourcePerformanceTest()}>性能测试</TabBtn>
        <TabBtn active={tab === "startup"} onClick={() => setTab("startup")}>启动分析</TabBtn>
        <TabBtn active={tab === "events"} onClick={() => setTab("events")}>性能日志</TabBtn>
        <TabBtn active={tab === "resources"} onClick={() => setTab("resources")}>资源趋势</TabBtn>
        <TabBtn active={tab === "performance"} onClick={() => setTab("performance")}>性能</TabBtn>
        <TabBtn active={tab === "resource-config"} onClick={() => setTab("resource-config")}>分析配置</TabBtn>
        <TabBtn active={tab === "slow"} onClick={() => setTab("slow")}>慢调用</TabBtn>
        <TabBtn active={tab === "rounds"} onClick={() => setTab("rounds")}>轮次对比</TabBtn>
        <TabBtn active={tab === "versions"} onClick={() => setTab("versions")}>版本对比</TabBtn>
        <TabBtn active={tab === "ai"} onClick={() => setTab("ai")}>AI 分析</TabBtn>
      </div>

      {tab === "overview" && (
        <>
          {/* 汇总卡片 */}
          <div className="grid grid-cols-4 gap-4">
            <SummaryCard label="启动会话数" value={(o.sessions || 0).toLocaleString()} color="blue" />
            <SummaryCard label="平均冷启动" value={fmtMs(o.avg_total_ms)} sub={verdictText(o.avg_total_ms)} color={verdictColor(o.avg_total_ms)} />
            <SummaryCard label="测试口径冷启动" value={fmtMs(o.avg_cold_loading_ms)} sub="点击图标→模板页loading（基线2.51s）" color="cyan" />
            <SummaryCard label="平均②配置等待" value={fmtMs(o.avg_stage2_ms)} sub="MainActivity首帧→Home启动" color="amber" />
            <SummaryCard label="覆盖车型" value={String(flavors.length)} color="violet" />
            <SummaryCard label="Crash" value={String(ev.crash || 0)} sub={`近 ${days} 天`} color={ev.crash ? "red" : "green"} />
            <SummaryCard label="ANR" value={String(ev.anr || 0)} sub={`近 ${days} 天`} color={ev.anr ? "red" : "green"} />
            <SummaryCard label="OOM" value={String(ev.oom || 0)} sub="内存溢出崩溃" color={ev.oom ? "red" : "green"} />
            {/* 前台使用 CPU/内存 峰值/均值（测试验收口径，来自 type=fg 前台采样聚合） */}
            <SummaryCard label="前台CPU峰值" value={fmtPct(fg.cpu_peak)} sub="前台使用期间单核占比" color="amber" />
            <SummaryCard label="前台CPU均值" value={fmtPct(fg.cpu_avg)} sub="前台使用平均" color="cyan" />
            <SummaryCard label="前台内存峰值" value={fmtMb(fg.mem_peak)} sub="PSS 峰值" color="amber" />
            <SummaryCard label="前台内存均值" value={fmtMb(fg.mem_avg)} sub="PSS 平均" color="cyan" />
          </div>

          {/* 按车型 + 版本（versionName/versionCode）分组 */}
          <div>
            <h3 className="text-sm font-medium text-zinc-300 mb-3">按车型 · 版本（平均启动分段）</h3>
            <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-4">
              {flavors.length === 0 ? (
                <Empty />
              ) : (
                <div className="space-y-3">
                  {flavors.map((f) => (
                    <div key={`${f.flavor || "?"}@${f.app_version_code || 0}@${f.app_version || ""}`} className="flex items-center gap-3">
                      <span className="text-xs text-zinc-400 w-40 shrink-0 truncate" title={`${f.flavor || "(未知)"}　${f.app_version || "(无版本)"}（code ${f.app_version_code || 0}）`}>
                        <span className="text-zinc-300">{f.flavor || "(未知)"}</span>
                        <span className="text-zinc-500"> · {f.app_version || "(无版本名)"}</span>
                        <span className="text-zinc-600"> ({f.app_version_code || 0})</span>
                      </span>
                      <StackedBar s1={f.avg_stage1_ms} s2={f.avg_stage2_ms} s3={f.avg_stage3_ms} />
                      <span className={`text-xs w-16 text-right shrink-0 font-mono ${totalColor(f.avg_total_ms)}`}>{fmtMs(f.avg_total_ms)}</span>
                      <span className="text-xs text-zinc-700 w-12 text-right shrink-0">{f.sessions}次</span>
                    </div>
                  ))}
                </div>
              )}
              <Legend />
            </div>
          </div>
        </>
      )}

      {tab === "startup" && (
        <div>
          <h3 className="text-sm font-medium text-zinc-300 mb-3">最近启动会话（①②③ 分段）</h3>
          <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-4">
            {startupSessions.length === 0 ? (
              <div className="text-center text-sm text-zinc-600 py-8">
                暂无"完成的冷启动"数据。<br />
                <span className="text-xs">需 App 真正进入首页（HomeActivity 首帧）才会产生 ①②③；裸启动/未进首页只有 runtime 采样（不计入此处）。</span>
              </div>
            ) : (
              <div className="space-y-4">
                {startupGroups.map((g) => {
                  const avgTotal = g.items.reduce((a, s) => a + (s.total_ms || 0), 0) / g.items.length;
                  const avgLoading = g.items.reduce((a, s) => a + (s.cold_loading_ms || 0), 0) / g.items.length;
                  return (
                    <div key={g.key}>
                      {/* 版本分组头：车型 · 版本名 (versionCode) + 该版本会话数/均值 */}
                      <div className="flex items-center gap-2 mb-2 pb-1 border-b border-zinc-800">
                        <span className="text-xs font-medium text-zinc-300">{g.flavor || "(未知车型)"}</span>
                        <span className="text-xs text-zinc-500">· {g.version || "(无版本名)"}</span>
                        <span className="text-xs text-zinc-600">({g.versionCode || 0})</span>
                        <span className="text-xs text-zinc-600 ml-auto">{g.items.length} 次 · 均值 {fmtMs(avgTotal)}{avgLoading > 0 ? ` · 测试口径 ${fmtMs(avgLoading)}` : ""}</span>
                      </div>
                      <div className="space-y-2">
                        {g.items.map((s) => (
                          <div key={s.id} className="flex items-center gap-3">
                            <span className="text-xs text-zinc-500 w-28 shrink-0 truncate" title={`${s.flavor || ""} ${s.device_model || ""} ${s.app_version || ""}(${s.app_version_code || 0})`}>
                              {s.device_model || s.flavor || "(未知)"}
                            </span>
                            <StackedBar s1={s.stage1_ms} s2={s.stage2_ms} s3={s.stage3_ms} />
                            <span className={`text-xs w-16 text-right shrink-0 font-mono ${totalColor(s.total_ms)}`}>{fmtMs(s.total_ms)}</span>
                            <span className="text-xs w-16 text-right shrink-0 font-mono text-cyan-400/80" title="测试口径冷启动(点击图标→模板页loading)">{fmtMs(s.cold_loading_ms)}</span>
                            <span className="text-xs text-zinc-700 w-24 text-right shrink-0 truncate" title={s.created_at}>{(s.created_at || "").slice(5, 16)}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
            <Legend />
          </div>
          <p className="text-xs text-zinc-600 mt-2">
            ① 用户点击→MainActivity首帧　② MainActivity首帧→HomeActivity启动（配置等待）　③ HomeActivity启动→首帧　｜ 青色列=测试口径冷启动(→模板页loading)
          </p>
        </div>
      )}

      {tab === "events" && (
        <div>
          {/* 日志归档：网关托管 adb logcat 持续抓取 + 轮转压缩，手动跑 Monkey 也自动回传 */}
          <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-4 mb-4">
            <div className="flex items-center gap-3 flex-wrap">
              <span className={`text-xs px-2 py-0.5 rounded ${logcap.running ? "bg-green-500/15 text-green-400" : "bg-zinc-700/40 text-zinc-400"}`}>
                {logcap.running ? "● 归档中" : "○ 未开启"}
              </span>
              <span className="text-sm text-zinc-300">原始日志归档</span>
              {!logcap.running && (
                <input
                  value={capSerial}
                  onChange={(e) => setCapSerial(e.target.value)}
                  placeholder="adb 序列号（单设备可空）"
                  className="text-xs bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-zinc-300 w-48"
                />
              )}
              {logcap.running ? (
                <button onClick={() => toggleLogcap(false)} className="text-xs bg-red-600/80 rounded px-3 py-1 text-white hover:bg-red-600 transition">停止归档</button>
              ) : (
                <button onClick={() => toggleLogcap(true)} className="text-xs bg-green-600/80 rounded px-3 py-1 text-white hover:bg-green-600 transition">开始归档</button>
              )}
              <button onClick={load} className="text-xs bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-zinc-400 hover:bg-zinc-700 transition">刷新状态</button>
            </div>
            {logcap.running && (
              <div className="text-xs text-zinc-500 mt-2">
                设备 <span className="text-zinc-300">{logcap.model} / {logcap.serial} / {logcap.ip}</span>
                每 {logcap.rotateMin}min 轮转　已归档 {logcap.archivedCount} 包 / {logcap.archivedMB}MB　当前 {logcap.currentMB}MB　→ <span className="font-mono">{logcap.outDir}/</span>
              </div>
            )}
            {logcap.error && <div className="text-xs text-red-400 mt-1">{logcap.error}</div>}
            <p className="text-xs text-zinc-600 mt-2">
              点「开始归档」后网关持续抓 logcat(-b all) 并每 {logcap.rotateMin || 30}min gzip 归档到 perf-logs/&lt;设备&gt;/，同时把 Monkey 报告扫进去。你只管手动跑 Monkey，无需跑脚本。
            </p>
          </div>

          <h3 className="text-sm font-medium text-zinc-300 mb-3">稳定性事件（Crash / ANR / OOM）</h3>
          <div className="bg-zinc-900 border border-zinc-800 rounded-xl divide-y divide-zinc-800">
            {events.length === 0 ? (
              <Empty />
            ) : (
              events.map((e) => (
                <div key={e.id} className="p-3">
                  <div className="flex items-center gap-2 mb-1">
                    <span className={`text-xs font-medium px-1.5 py-0.5 rounded ${e.type === "crash" ? "bg-red-500/15 text-red-400" : "bg-amber-500/15 text-amber-400"}`}>
                      {(e.type || "").toUpperCase()}
                    </span>
                    <span className="text-xs text-zinc-500 truncate">{e.flavor || "(未知车型)"}</span>
                    <span className="text-xs text-zinc-700 ml-auto shrink-0">{(e.created_at || "").slice(5, 16)}</span>
                  </div>
                  <pre className="text-xs text-zinc-400 whitespace-pre-wrap break-all max-h-40 overflow-y-auto font-mono leading-relaxed">{e.detail}</pre>
                </div>
              ))
            )}
          </div>
          <p className="text-xs text-zinc-600 mt-2">
            车机端由 PerfMonitors 采集：Crash（全局异常处理器）、ANR（主线程看门狗 &gt;5s）。仅在 mock app 开启性能分析时上报。
          </p>
        </div>
      )}

      {tab === "resources" && (
        <div className="space-y-4">
          <ResourceRunPanel
            run={resourceRun}
            runs={resourceRuns}
            form={resourceForm}
            setForm={setResourceForm}
            busy={resourceBusy}
            onStart={startResourceRun}
            onStop={stopResourceRun}
            onRefresh={load}
            onViewPerformance={(id) => { setSelectedResourceRunId(id); setTab("performance"); }}
          />
          <LeakBadge memory={resMetrics.memory} />
          <LineChart title="内存 (MB)" unit="MB" series={seriesFrom(resMetrics.memory, [
            { name: "mem:pssMb", label: "PSS", color: "#60a5fa" },
            { name: "mem:javaHeapMb", label: "Java Heap", color: "#34d399" },
            { name: "mem:nativeHeapMb", label: "Native Heap", color: "#fbbf24" },
          ])} />
          <LineChart title="CPU（%）" unit="%" series={seriesFrom(resMetrics.cpu, [
            { name: "cpu:appPercent", label: "整机归一化 / 客户单核", color: "#f472b6" },
            { name: "cpu:multiCorePercent", label: "多核累计 / 单核等效", color: "#22d3ee" },
          ])} />
          <LineChart title="UI 流畅度" unit="" series={seriesFrom(resMetrics.ui, [
            { name: "ui:fps", label: "FPS", color: "#22d3ee" },
            { name: "ui:jank", label: "卡顿帧", color: "#f87171" },
          ])} />
          <LineChart title="GC 累计次数" unit="" series={seriesFrom(resMetrics.memory, [
            { name: "mem:gcCount", label: "GC 次数", color: "#a78bfa" },
          ])} />
          <p className="text-xs text-zinc-600">一键摸测数据来自 adb /proc + dumpsys meminfo（默认每 5 秒）；原有车机 PerfMonitors 数据仍会合并显示。</p>
        </div>
      )}

      {tab === "performance" && (
        <ResourcePerformanceTab
          runs={resourceRuns}
          selectedId={selectedResourceRunId}
          onSelect={setSelectedResourceRunId}
          liveRun={resourceRun}
          active={resourceRunActive}
          detail={resourceDetail}
          loading={resourceDetailLoading}
          error={resourceDetailError}
          onRetry={loadResourceDetail}
          onOpenTest={() => openResourcePerformanceTest()}
        />
      )}

      {tab === "performance-test" && (
        <ResourcePerformanceTestTab
          runs={resourceTestRuns}
          selectedId={selectedResourceTestRunId}
          onSelect={setSelectedResourceTestRunId}
          liveRun={resourceRun}
          active={resourceRunActive}
          detail={resourceDetail}
          loading={resourceDetailLoading}
          error={resourceDetailError}
          onRetry={loadResourceDetail}
          scripts={resourceScripts}
          selectedScriptId={selectedResourceScriptId}
          onScriptChange={selectResourceScript}
          samplingMode={resourceForm.samplingMode}
          onSamplingModeChange={selectResourceSamplingMode}
          onStart={startResourceRun}
          busy={resourceBusy}
          configLoading={resourceConfigLoading}
          configError={resourceConfigLoadError}
          onReloadScripts={loadResourceConfig}
        />
      )}

      {tab === "resource-config" && (
        <ResourceConfigPanel
          form={resourceConfigRun}
          setForm={setResourceConfigRun}
          flowJson={resourceFlowJson}
          setFlowJson={setResourceFlowJson}
          scriptsJson={resourceScriptsJson}
          setScriptsJson={setResourceScriptsJson}
          defaultScriptId={resourceDefaultScriptId}
          setDefaultScriptId={setResourceDefaultScriptId}
          scriptLibrary={resourceScriptLibrary}
          active={resourceRunActive}
          loading={resourceConfigLoading}
          saving={resourceConfigSaving}
          error={resourceConfigError}
          notice={resourceConfigNotice}
          onReload={loadResourceConfig}
          onSave={saveResourceConfig}
          clearMessage={() => { setResourceConfigError(""); setResourceConfigNotice(""); }}
        />
      )}

      {tab === "slow" && (
        <div>
          <h3 className="text-sm font-medium text-zinc-300 mb-3">慢调用排行（method / network / I/O / page，按均值降序）</h3>
          <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-4">
            {top.length === 0 ? (
              <Empty />
            ) : (
              <div className="space-y-1.5">
                {top.map((m, i) => (
                  <div key={m.name + i} className="flex items-center gap-3">
                    <span className="text-xs text-zinc-600 w-5 text-right shrink-0">{i + 1}</span>
                    <span className={`text-xs px-1.5 py-0.5 rounded shrink-0 w-16 text-center ${metricTypeColor(m.type)}`}>{m.type}</span>
                    <span className="text-xs text-zinc-300 flex-1 truncate font-mono" title={m.name}>{m.name}</span>
                    <span className="text-xs text-amber-400 w-20 text-right shrink-0 font-mono">{Math.round(m.avg_value)}ms</span>
                    <span className="text-xs text-zinc-600 w-20 text-right shrink-0">max {Math.round(m.max_value)}</span>
                    <span className="text-xs text-zinc-700 w-12 text-right shrink-0">{m.n}次</span>
                  </div>
                ))}
              </div>
            )}
          </div>
          <p className="text-xs text-zinc-600 mt-2">含 @TracePerf 标注方法、Room DAO、网络、SP I/O、页面加载；开启「全量方法插桩」(performanceTrace enableFullMethodTrace) 后还会含 &gt;3ms 的任意慢方法。</p>
        </div>
      )}

      {tab === "rounds" && (
        <div>
          <h3 className="text-sm font-medium text-zinc-300 mb-3">Monkey 轮次对比（冷启动均值）</h3>
          <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-4">
            {rounds.length === 0 ? (
              <Empty />
            ) : (
              <div className="space-y-2">
                {rounds.map((r) => (
                  <div key={r.round} className="flex items-center gap-3">
                    <span className="text-xs text-zinc-400 w-24 shrink-0 truncate font-mono" title={r.round}>{r.round}</span>
                    <div className="flex-1 flex items-center h-5 rounded overflow-hidden bg-zinc-800">
                      <div className="h-full bg-blue-500/70" style={{ width: `${Math.min(100, (r.avg_total_ms / Math.max(3000, ...rounds.map((x) => x.avg_total_ms || 0))) * 100)}%` }} title={`均值 ${Math.round(r.avg_total_ms)}ms`} />
                    </div>
                    <span className={`text-xs w-16 text-right shrink-0 font-mono ${totalColor(r.avg_total_ms)}`}>{fmtMs(r.avg_total_ms)}</span>
                    <span className="text-xs text-zinc-600 w-28 text-right shrink-0">min {fmtMs(r.min_total_ms)}/max {fmtMs(r.max_total_ms)}</span>
                    <span className="text-xs text-zinc-700 w-12 text-right shrink-0">{r.sessions}次</span>
                    <button
                      onClick={() => { setSelectedRound(r.round); setTab("ai"); analyzeRound(r.round); }}
                      className="text-xs bg-zinc-800 border border-zinc-700 rounded px-2 py-0.5 text-blue-400 hover:bg-zinc-700 transition shrink-0"
                    >AI 分析</button>
                  </div>
                ))}
              </div>
            )}
          </div>
          <p className="text-xs text-zinc-600 mt-2">由 tools/perf-loop/run-perf-loop.ps1 每轮压测后自动上报（带 round_NNN）。</p>
        </div>
      )}

      {tab === "versions" && (
        <div className="space-y-4">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-xs text-zinc-500">优化报表：</span>
            <select value={baseVer} onChange={(e) => setBaseVer(e.target.value)} className="text-xs bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-zinc-300">
              <option value="">基线版本（可空）</option>
              {versions.map((v) => (<option key={"b" + (v.app_version || "?")} value={v.app_version}>{v.app_version || "(空)"}（{fmtMs(v.avg_total_ms)}）</option>))}
            </select>
            <span className="text-xs text-zinc-600">→</span>
            <select value={targetVer} onChange={(e) => setTargetVer(e.target.value)} className="text-xs bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-zinc-300">
              <option value="">优化版本</option>
              {versions.map((v) => (<option key={"t" + (v.app_version || "?")} value={v.app_version}>{v.app_version || "(空)"}（{fmtMs(v.avg_total_ms)}）</option>))}
            </select>
            <button onClick={analyzeVersionCompare} disabled={!targetVer || analyzing} className="text-xs bg-blue-600/80 disabled:opacity-40 rounded px-3 py-1 text-white hover:bg-blue-600 transition">{analyzing ? "生成中…" : "生成优化报表"}</button>
            <span className="text-xs text-zinc-600">→ 报表在「AI 分析」Tab，可复制进工作报告</span>
          </div>
          <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-4 overflow-x-auto">
            {versions.length === 0 ? (
              <Empty />
            ) : (
              <table className="w-full text-xs">
                <thead><tr className="text-zinc-500 text-left">
                  <th className="py-1 pr-3">版本</th><th className="pr-3">样本</th><th className="pr-3">①</th><th className="pr-3">②配置等待</th><th className="pr-3">③</th><th className="pr-3">总(均值)</th><th className="pr-3">min/max</th><th>Crash/ANR/OOM</th>
                </tr></thead>
                <tbody>
                  {versions.map((v) => (
                    <tr key={v.app_version || "?"} className="border-t border-zinc-800">
                      <td className="py-1 pr-3 font-mono text-zinc-300">{v.app_version || "(空)"}{v.app_version_code ? ` (${v.app_version_code})` : ""}</td>
                      <td className="pr-3 text-zinc-500">{v.sessions}</td>
                      <td className="pr-3">{fmtMs(v.avg_stage1_ms)}</td>
                      <td className={`pr-3 ${v.avg_stage2_ms > 800 ? "text-amber-400" : "text-green-400"}`}>{fmtMs(v.avg_stage2_ms)}</td>
                      <td className="pr-3">{fmtMs(v.avg_stage3_ms)}</td>
                      <td className={`pr-3 font-mono ${totalColor(v.avg_total_ms)}`}>{fmtMs(v.avg_total_ms)}</td>
                      <td className="pr-3 text-zinc-600">{fmtMs(v.min_total_ms)}/{fmtMs(v.max_total_ms)}</td>
                      <td className={(v.crash || v.anr || v.oom) ? "text-red-400" : "text-zinc-600"}>{v.crash}/{v.anr}/{v.oom}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
          <p className="text-xs text-zinc-600">按版本跟进优化效果：选「基线(旧版)→优化版(新版)」生成对比报表。版本来自上报的 versionName/versionCode（仅统计完成的冷启动）。</p>
        </div>
      )}

      {tab === "ai" && (
        <div className="space-y-4">
          <div className="flex items-center gap-2">
            <select
              value={selectedRound}
              onChange={(e) => setSelectedRound(e.target.value)}
              className="text-xs bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-zinc-300"
            >
              <option value="">选择轮次…</option>
              {rounds.map((r) => (
                <option key={r.round} value={r.round}>{r.round}（{fmtMs(r.avg_total_ms)}）</option>
              ))}
            </select>
            <button
              onClick={() => analyzeRound(selectedRound)}
              disabled={!selectedRound || analyzing}
              className="text-xs bg-blue-600/80 disabled:opacity-40 rounded px-3 py-1 text-white hover:bg-blue-600 transition"
            >{analyzing ? "分析中…" : "AI 分析本轮"}</button>
            <span className="text-xs text-zinc-600">或</span>
            <button
              onClick={analyzeRecent}
              disabled={analyzing}
              className="text-xs bg-violet-600/80 disabled:opacity-40 rounded px-3 py-1 text-white hover:bg-violet-600 transition"
            >{analyzing ? "分析中…" : `AI 分析最近 ${days} 天`}</button>
            <span className="text-xs text-zinc-600">手动跑 Monkey（无轮次）用这个</span>
          </div>

          {reports.length === 0 ? (
            <Empty />
          ) : (
            <div className="space-y-3">
              {reports.map((rep) => (
                <div key={rep.id} className="bg-zinc-900 border border-zinc-800 rounded-xl p-4">
                  <div className="flex items-center gap-2 mb-2">
                    <span className="text-xs font-mono text-blue-400">{rep.round}</span>
                    {rep.engine && <span className="text-xs text-zinc-500">引擎: {rep.engine}</span>}
                    <span className="text-xs text-zinc-700 ml-auto">{(rep.created_at || "").slice(5, 16)}</span>
                  </div>
                  <pre className="text-xs text-zinc-300 whitespace-pre-wrap break-words font-sans leading-relaxed max-h-[28rem] overflow-y-auto">{rep.result_md}</pre>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function StackedBar({ s1, s2, s3 }) {
  const a = Math.max(0, Math.round(s1 || 0));
  const b = Math.max(0, Math.round(s2 || 0));
  const c = Math.max(0, Math.round(s3 || 0));
  const total = a + b + c;
  // 以 3 秒为满刻度（更直观对比阈值），不足/超出按比例
  const scale = Math.max(total, 3000);
  const pct = (v) => (scale > 0 ? (v / scale) * 100 : 0);
  return (
    <div className="flex-1 flex items-center h-5 rounded overflow-hidden bg-zinc-800">
      <div className="h-full bg-blue-500/70" style={{ width: `${pct(a)}%` }} title={`① ${a}ms`} />
      <div className="h-full bg-amber-500/70" style={{ width: `${pct(b)}%` }} title={`② ${b}ms`} />
      <div className="h-full bg-cyan-500/70" style={{ width: `${pct(c)}%` }} title={`③ ${c}ms`} />
    </div>
  );
}

function Legend() {
  return (
    <div className="flex items-center gap-4 mt-3 pt-3 border-t border-zinc-800">
      <span className="flex items-center text-xs text-zinc-500"><span className="w-3 h-2 bg-blue-500/70 rounded mr-1" /> ① 首帧</span>
      <span className="flex items-center text-xs text-zinc-500"><span className="w-3 h-2 bg-amber-500/70 rounded mr-1" /> ② 配置等待</span>
      <span className="flex items-center text-xs text-zinc-500"><span className="w-3 h-2 bg-cyan-500/70 rounded mr-1" /> ③ 首页首帧</span>
      <span className="text-xs text-zinc-600 ml-auto">满刻度 3s　目标冷启动 &lt; 2s</span>
    </div>
  );
}

function ResourceConfigPanel({
  form,
  setForm,
  flowJson,
  setFlowJson,
  scriptsJson,
  setScriptsJson,
  defaultScriptId,
  setDefaultScriptId,
  scriptLibrary,
  active,
  loading,
  saving,
  error,
  notice,
  onReload,
  onSave,
  clearMessage,
}) {
  const disabled = active || loading || saving;
  const scriptPreview = React.useMemo(() => {
    try {
      return { scripts: parseResourceScriptsJson(scriptsJson).scripts, error: "" };
    } catch (previewError) {
      return { scripts: [], error: previewError.message };
    }
  }, [scriptsJson]);
  const scriptChoices = scriptPreview.scripts;
  const scriptGroups = React.useMemo(() => groupResourceScripts(scriptChoices), [scriptChoices]);
  const runnableScripts = scriptChoices.filter((script) => resourceScriptAvailability(script).selectable);
  const update = (key, value) => {
    clearMessage();
    setForm((prev) => ({
      ...prev,
      [key]: value,
      ...(key === "samplingMode" && value === "realtime"
        ? { capturePerfetto: true, interval: 5 }
        : {}),
    }));
  };
  return (
    <div className="space-y-4">
      <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-4 space-y-4">
        <div className="flex items-center gap-3 flex-wrap">
          <div>
            <h3 className="text-sm font-medium text-zinc-300">CPU / 内存分析配置</h3>
            <p className="text-xs text-zinc-600 mt-1">保存后，顶部快捷按钮和“资源趋势”中的启动按钮都会使用这组配置。</p>
          </div>
          <button
            disabled={disabled}
            onClick={onReload}
            className="ml-auto text-xs bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-zinc-400 hover:bg-zinc-700 disabled:opacity-40"
          >{loading ? "加载中…" : "重新加载"}</button>
        </div>

        {active && (
          <div className="text-xs text-blue-400 bg-blue-500/10 border border-blue-500/25 rounded px-3 py-2">
            CPU / 内存分析正在运行。为保证本轮配置快照不变，结束或停止后才能编辑并保存。
          </div>
        )}

        <div>
          <h4 className="text-xs font-medium text-zinc-400 mb-2">基础运行参数</h4>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            <label className="text-xs text-zinc-500">adb 序列号（单设备可空）
              <input disabled={disabled} value={form.serial} onChange={(e) => update("serial", e.target.value)} placeholder="192.168.x.x:5555"
                className="mt-1 w-full bg-zinc-800 border border-zinc-700 rounded px-2 py-1.5 text-zinc-300 disabled:opacity-50" />
            </label>
            <label className="text-xs text-zinc-500">车型 / flavor
              <input disabled={disabled} value={form.flavor} onChange={(e) => update("flavor", e.target.value)} placeholder="avatr8678"
                className="mt-1 w-full bg-zinc-800 border border-zinc-700 rounded px-2 py-1.5 text-zinc-300 disabled:opacity-50" />
            </label>
            <label className="text-xs text-zinc-500">目标包名
              <input disabled={disabled} value={form.package} onChange={(e) => update("package", e.target.value)} placeholder="com.appmarket.automotive"
                className="mt-1 w-full bg-zinc-800 border border-zinc-700 rounded px-2 py-1.5 text-zinc-300 font-mono disabled:opacity-50" />
            </label>
            <label className="text-xs text-zinc-500">采样时长（秒）
              <input disabled={disabled} type="number" min="5" max="3600" value={form.duration} onChange={(e) => update("duration", e.target.value)}
                className="mt-1 w-full bg-zinc-800 border border-zinc-700 rounded px-2 py-1.5 text-zinc-300 disabled:opacity-50" />
            </label>
            <label className="text-xs text-zinc-500">采样间隔（秒）
              <input disabled={disabled || form.samplingMode === "realtime"} type="number" min="1" max="60" value={form.interval} onChange={(e) => update("interval", e.target.value)}
                className="mt-1 w-full bg-zinc-800 border border-zinc-700 rounded px-2 py-1.5 text-zinc-300 disabled:opacity-50" />
            </label>
            <label className="text-xs text-zinc-500">采样模式
              <select disabled={disabled} value={form.samplingMode || "standard"} onChange={(e) => update("samplingMode", e.target.value)}
                className="mt-1 w-full bg-zinc-800 border border-zinc-700 rounded px-2 py-1.5 text-zinc-300 disabled:opacity-50">
                <option value="standard">标准验收（正式 5 秒点）</option>
                <option value="realtime">实时诊断（CPU 500ms / RSS 1s）</option>
              </select>
            </label>
            <label className="text-xs text-zinc-500">固定测试应用名（可空）
              <input disabled={disabled || !form.executeFlow} value={form.testAppTitle} onChange={(e) => update("testAppTitle", e.target.value)} placeholder="留空则按安全规则选择"
                className="mt-1 w-full bg-zinc-800 border border-zinc-700 rounded px-2 py-1.5 text-zinc-300 disabled:opacity-50" />
            </label>
          </div>
          <div className="flex items-center gap-5 flex-wrap mt-3">
            <label className="flex items-center gap-1.5 text-xs text-zinc-400">
              <input disabled={disabled} type="checkbox" checked={!!form.executeFlow} onChange={(e) => update("executeFlow", e.target.checked)} />
              执行详情→下载安装→“我的”二级菜单
            </label>
            <label className="flex items-center gap-1.5 text-xs text-zinc-400">
              <input disabled={disabled} type="checkbox" checked={!!form.captureScreenrecord} onChange={(e) => update("captureScreenrecord", e.target.checked)} />
              全程录屏并保留原始视频
            </label>
            <label className="flex items-center gap-1.5 text-xs text-zinc-400">
              <input disabled={disabled || form.samplingMode === "realtime"} type="checkbox" checked={form.samplingMode === "realtime" || !!form.capturePerfetto} onChange={(e) => update("capturePerfetto", e.target.checked)} />
              同时采集 Perfetto{form.samplingMode === "realtime" ? "（实时诊断强制）" : ""}
            </label>
          </div>
        </div>

        <div className="rounded-xl border border-cyan-500/20 bg-cyan-500/5 p-3 space-y-3">
          <div className="flex items-start justify-between gap-3 flex-wrap">
            <div>
              <h4 className="text-xs font-medium text-zinc-300">测试任务脚本库（目录自动发现）</h4>
              <p className="text-xs text-zinc-600 mt-1">
                开发脚本按“平台 / 任务包 / profiles / profile / task.json”管理；页面会自动发现并按分类展示。下方 JSON 仅用于运行覆盖和兼容自定义脚本。
              </p>
              <p className="mt-1 font-mono text-[10px] text-cyan-500/80">
                {scriptLibrary?.root || "features/PerformanceFeature/performance-test-scripts/tasks"}
              </p>
            </div>
            <label className="text-xs text-zinc-500 min-w-[18rem]">默认测试脚本
              <select
                disabled={disabled}
                value={defaultScriptId}
                onChange={(event) => { clearMessage(); setDefaultScriptId(event.target.value); }}
                className="mt-1 w-full rounded border border-zinc-700 bg-zinc-900 px-2 py-1.5 text-zinc-300 disabled:opacity-50"
              >
                {runnableScripts.length === 0 && <option value="">请先填写可运行的脚本任务</option>}
                {scriptGroups.map((group) => {
                  const choices = group.scripts.filter((script) => resourceScriptAvailability(script).selectable);
                  return choices.length > 0 ? (
                    <optgroup key={group.category} label={group.category}>
                      {choices.map((script) => <option key={script.id} value={script.id}>{script.name} · {script.id}</option>)}
                    </optgroup>
                  ) : null;
                })}
              </select>
            </label>
          </div>
          {Array.isArray(scriptLibrary?.issues) && scriptLibrary.issues.length > 0 && (
            <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-300">
              <div className="font-medium">脚本库有 {scriptLibrary.issues.length} 个清单问题</div>
              {scriptLibrary.issues.slice(0, 5).map((issue, index) => (
                <div key={`${issue?.manifestPath || "issue"}-${index}`} className="mt-1 font-mono text-[10px] break-all">
                  {issue?.manifestPath || "task.json"}：{issue?.message || "未知错误"}
                </div>
              ))}
            </div>
          )}
          <div>
            <div className="mb-2 flex items-center gap-2 text-xs text-zinc-500">
              <span>脚本库预览</span>
              <span className="rounded bg-zinc-800 px-2 py-0.5 text-[10px]">{scriptChoices.length} 项 · {scriptGroups.length} 个分类</span>
            </div>
            {scriptPreview.error ? (
              <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-300">脚本 JSON 无法生成目录预览：{scriptPreview.error}</div>
            ) : (
              <ResourceScriptLibrary scripts={scriptChoices} selectedScriptId={defaultScriptId} />
            )}
          </div>
          <textarea
            disabled={disabled}
            value={scriptsJson}
            onChange={(event) => { clearMessage(); setScriptsJson(event.target.value); }}
            spellCheck={false}
            rows={18}
            className="w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 font-mono text-xs leading-relaxed text-zinc-300 disabled:opacity-50"
          />
          <p className="text-[10px] text-zinc-600">
            受管任务的名称、入口和工作流以 task.json 为准，此处修改这些字段不会覆盖文件清单；自定义任务仍可完整配置。启动时前端只提交所选 scriptId，服务端会冻结本轮脚本与工作流快照。
          </p>
        </div>

        <div>
          <div className="flex items-center justify-between gap-3 mb-2">
            <div>
              <h4 className="text-xs font-medium text-zinc-400">高级流程配置（JSON）</h4>
              <p className="text-xs text-zinc-600 mt-1">维护公共基础 flow，包括页面超时、选择器、二级菜单白名单和性能阈值；脚本自身 flow 可按任务覆盖。</p>
            </div>
            <span className="text-[10px] text-zinc-700 shrink-0">保存时校验 JSON 对象</span>
          </div>
          <textarea
            disabled={disabled}
            value={flowJson}
            onChange={(e) => { clearMessage(); setFlowJson(e.target.value); }}
            spellCheck={false}
            rows={20}
            className="w-full bg-zinc-950 border border-zinc-700 rounded-lg px-3 py-2 text-xs leading-relaxed text-zinc-300 font-mono disabled:opacity-50"
          />
        </div>

        {error && <div className="text-xs text-red-400 bg-red-500/10 border border-red-500/25 rounded px-3 py-2">{error}</div>}
        {notice && <div className="text-xs text-green-400 bg-green-500/10 border border-green-500/25 rounded px-3 py-2">{notice}</div>}

        <div className="flex items-center justify-end">
          <button
            disabled={disabled}
            onClick={onSave}
            className="text-xs bg-blue-600/80 disabled:opacity-40 rounded px-4 py-1.5 text-white hover:bg-blue-600"
          >{saving ? "保存中…" : "保存分析配置"}</button>
        </div>
      </div>
    </div>
  );
}

function ResourceRunPanel({ run, runs, form, setForm, busy, onStart, onStop, onRefresh, onViewPerformance }) {
  const active = !!run.running || run.status === "stopping";
  const update = (key, value) => setForm((prev) => ({
    ...prev,
    [key]: value,
    ...(key === "samplingMode" && value === "realtime"
      ? { capturePerfetto: true, interval: 5 }
      : {}),
  }));
  const statusColor = run.status === "completed"
    ? "bg-green-500/15 text-green-400"
    : run.status === "completed_with_upload_error"
      ? "bg-amber-500/15 text-amber-400"
    : run.status === "failed"
      ? "bg-red-500/15 text-red-400"
      : active
        ? "bg-blue-500/15 text-blue-400"
        : "bg-zinc-700/40 text-zinc-400";
  const recentLogs = Array.isArray(run.logs) ? run.logs.slice(-8) : [];
  return (
    <>
      <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-4 space-y-3">
        <div className="flex items-center gap-3 flex-wrap">
          <span className={`text-xs px-2 py-0.5 rounded ${statusColor}`}>● {RESOURCE_STATUS_NAMES[run.status] || run.status || "未知"}</span>
          <h3 className="text-sm font-medium text-zinc-300">应用市场 CPU / 内存一键摸测</h3>
          <span className="text-xs text-zinc-600">{form.duration || 180} 秒 · 正式每 {form.interval || 5} 秒 · {form.samplingMode === "realtime" ? "实时诊断" : "标准验收"} · {form.package || "com.appmarket.automotive"} 全部子进程</span>
          {run.options?.captureScreenrecord && (
            <span className="text-xs text-violet-400 bg-violet-500/10 rounded px-2 py-0.5">{active ? "● 正在录屏" : "本轮已启用录屏"}</span>
          )}
          <button onClick={onRefresh} className="ml-auto text-xs bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-zinc-400 hover:bg-zinc-700">刷新</button>
        </div>
        <div className="grid grid-cols-2 md:grid-cols-6 gap-2">
          <label className="text-xs text-zinc-500">adb 序列号（单设备可空）
            <input disabled={active} value={form.serial} onChange={(e) => update("serial", e.target.value)} placeholder="192.168.x.x:5555"
              className="mt-1 w-full bg-zinc-800 border border-zinc-700 rounded px-2 py-1.5 text-zinc-300 disabled:opacity-50" />
          </label>
          <label className="text-xs text-zinc-500">车型 / flavor
            <input disabled={active} value={form.flavor} onChange={(e) => update("flavor", e.target.value)} placeholder="avatr8678"
              className="mt-1 w-full bg-zinc-800 border border-zinc-700 rounded px-2 py-1.5 text-zinc-300 disabled:opacity-50" />
          </label>
          <label className="text-xs text-zinc-500">目标包名
            <input disabled={active} value={form.package} onChange={(e) => update("package", e.target.value)} placeholder="com.appmarket.automotive"
              className="mt-1 w-full bg-zinc-800 border border-zinc-700 rounded px-2 py-1.5 text-zinc-300 font-mono disabled:opacity-50" />
          </label>
          <label className="text-xs text-zinc-500">采样时长（秒）
            <input disabled={active} type="number" min="5" max="3600" value={form.duration} onChange={(e) => update("duration", e.target.value)}
              className="mt-1 w-full bg-zinc-800 border border-zinc-700 rounded px-2 py-1.5 text-zinc-300 disabled:opacity-50" />
          </label>
          <label className="text-xs text-zinc-500">采样间隔（秒）
            <input disabled={active || form.samplingMode === "realtime"} type="number" min="1" max="60" value={form.interval} onChange={(e) => update("interval", e.target.value)}
              className="mt-1 w-full bg-zinc-800 border border-zinc-700 rounded px-2 py-1.5 text-zinc-300 disabled:opacity-50" />
          </label>
          <label className="text-xs text-zinc-500">采样模式
            <select disabled={active} value={form.samplingMode || "standard"} onChange={(e) => update("samplingMode", e.target.value)}
              className="mt-1 w-full bg-zinc-800 border border-zinc-700 rounded px-2 py-1.5 text-zinc-300 disabled:opacity-50">
              <option value="standard">标准验收</option>
              <option value="realtime">实时诊断</option>
            </select>
          </label>
        </div>
        <div className="flex items-center gap-4 flex-wrap">
          <label className="flex items-center gap-1.5 text-xs text-zinc-400" title="请在“性能测试”Tab 切换任务脚本">
            <input disabled type="checkbox" checked={form.executeFlow} readOnly />
            {form.executeFlow ? "当前脚本：完整详情/安装/菜单流程" : "当前脚本：仅启动与首页流程"}（由任务锁定）
          </label>
          <label className="flex items-center gap-1.5 text-xs text-zinc-400">
            <input disabled={active} type="checkbox" checked={!!form.captureScreenrecord} onChange={(e) => update("captureScreenrecord", e.target.checked)} />
            同时录屏（保留原始视频）
          </label>
          <label className="flex items-center gap-1.5 text-xs text-zinc-400">
            <input disabled={active || form.samplingMode === "realtime"} type="checkbox" checked={form.samplingMode === "realtime" || form.capturePerfetto} onChange={(e) => update("capturePerfetto", e.target.checked)} />
            同时采集 Perfetto{form.samplingMode === "realtime" ? "（实时诊断强制）" : "（诊断运行）"}
          </label>
          {form.executeFlow && (
            <input disabled={active} value={form.testAppTitle} onChange={(e) => update("testAppTitle", e.target.value)} placeholder="固定测试应用名（可空）"
              className="text-xs bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-zinc-300 w-52 disabled:opacity-50" />
          )}
          {active ? (
            <button disabled={busy} onClick={onStop} className="ml-auto text-xs bg-red-600/80 disabled:opacity-40 rounded px-3 py-1.5 text-white hover:bg-red-600">{run.status === "stopping" ? "正在停止…" : "停止并保留已采样数据"}</button>
          ) : (
            <button disabled={busy} onClick={onStart} className="ml-auto text-xs bg-blue-600/80 disabled:opacity-40 rounded px-3 py-1.5 text-white hover:bg-blue-600">{busy ? "启动中…" : "开始一键摸测"}</button>
          )}
        </div>
        <p className="text-xs text-zinc-600">阈值来自客户工作簿：CPU 单核峰值 ≤3.30%、多核累计峰值 ≤16.5%、均值 ≤1.25%；PSS 峰值 ≤190MiB、均值 ≤140MiB。原始命令、CSV、logcat、UI 截图/XML、可选录屏和 trace 保存到 docs/tempFiles。</p>
        {(recentLogs.length > 0 || run.error) && (
          <pre className="text-[11px] leading-relaxed text-zinc-400 bg-zinc-950/70 border border-zinc-800 rounded p-2 max-h-40 overflow-auto whitespace-pre-wrap break-all">
            {recentLogs.map((item) => item.line).join("\n")}{run.error ? `\nERROR: ${run.error}` : ""}
          </pre>
        )}
        {(run.artifactDir || run.resultJson) && (
          <div className="text-xs text-zinc-500 font-mono">产物：{run.artifactDir || run.resultJson}</div>
        )}
      </div>

      <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-4">
        <h3 className="text-sm font-medium text-zinc-300 mb-3">最近资源摸测</h3>
        {!Array.isArray(runs) || runs.length === 0 ? (
          <div className="text-center text-sm text-zinc-600 py-6">暂无一键摸测结果</div>
        ) : (
          <div className="space-y-3">
            {runs.map((item) => {
              const cpuSingle = item.measurements?.cpu_device_normalized_pct || {};
              const cpuMulti = item.measurements?.cpu_multi_core_pct || {};
              const pss = item.measurements?.pss_mb || {};
              const pass = item.acceptance === "PASS";
              const failed = item.acceptance === "FAIL";
              return (
                <div key={item.id} className="border border-zinc-800 rounded-lg p-3">
                  <div className="flex items-center gap-2 mb-2">
                    <span className={`text-xs px-2 py-0.5 rounded ${pass ? "bg-green-500/15 text-green-400" : failed ? "bg-red-500/15 text-red-400" : "bg-amber-500/15 text-amber-400"}`}>{item.acceptance}</span>
                    <span className="text-xs text-zinc-300">{item.deviceBrand} {item.deviceModel}</span>
                    <span className="text-xs text-zinc-600">{item.flavor || "(未标车型)"} · {item.appVersion || "(未知版本)"}</span>
                    <span className="text-xs text-zinc-700 ml-auto">{item.createdAt}</span>
                    <button type="button" onClick={() => onViewPerformance?.(item.id)} className="text-xs bg-zinc-800 border border-zinc-700 rounded px-2 py-0.5 text-blue-400 hover:bg-zinc-700">查看性能详情</button>
                  </div>
                  <div className="grid grid-cols-2 md:grid-cols-5 gap-2">
                    <ResourceMetric label="CPU 单核峰值" value={fmtPct(cpuSingle.peak)} limit="≤3.30%" />
                    <ResourceMetric label="CPU 多核峰值" value={fmtPct(cpuMulti.peak)} limit="≤16.5%" />
                    <ResourceMetric label="CPU 单核均值" value={fmtPct(cpuSingle.mean)} limit="≤1.25%" />
                    <ResourceMetric label="PSS 峰值" value={fmtMiB(pss.peak)} limit="≤190MiB" />
                    <ResourceMetric label="PSS 均值" value={fmtMiB(pss.mean)} limit="≤140MiB" />
                  </div>
                  <div className="text-xs text-zinc-600 mt-2">
                    采样 {item.sampling?.actual_rows || 0}/{item.sampling?.expected_rows || 0} · 流程 {item.flow?.status || "未知"}
                    {item.artifactDir ? <span className="font-mono"> · {item.artifactDir}</span> : null}
                  </div>
                  {item.warnings?.length ? <div className="text-xs text-amber-500/80 mt-1">{item.warnings.join("；")}</div> : null}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </>
  );
}

function ResourceMetric({ label, value, limit }) {
  return (
    <div className="bg-zinc-950/60 rounded p-2">
      <div className="text-xs text-zinc-600">{label}</div>
      <div className="text-sm text-zinc-300 font-mono mt-0.5">{value}</div>
      <div className="text-[10px] text-zinc-700">{limit}</div>
    </div>
  );
}

// 把 perf_metric 行（{name,value}）按 name 映射成多序列折线数据
function seriesFrom(rows, mapping) {
  const safe = Array.isArray(rows) ? rows : [];
  return mapping.map((m) => ({
    name: m.label,
    color: m.color,
    values: safe.filter((r) => r.name === m.name).map((r) => Number(Number(r.value).toFixed(4))),
  }));
}

// 零依赖多序列 SVG 折线图（x = 采样序，y 自适应）
function LineChart({ title, unit, series }) {
  const all = series.flatMap((s) => s.values);
  const max = Math.max(1, ...all);
  const min = Math.min(0, ...all);
  const W = 600, H = 120, pad = 4;
  const n = Math.max(1, ...series.map((s) => s.values.length));
  const px = (i) => (n <= 1 ? pad : (i / (n - 1)) * (W - 2 * pad) + pad);
  const py = (v) => H - pad - ((v - min) / (max - min || 1)) * (H - 2 * pad);
  return (
    <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-4">
      <div className="flex items-center justify-between mb-2">
        <h4 className="text-xs font-medium text-zinc-300">{title}</h4>
        <div className="flex gap-3">
          {series.map((s) => (
            <span key={s.name} className="flex items-center text-xs text-zinc-500">
              <span className="w-3 h-2 rounded mr-1" style={{ background: s.color }} />
              {s.name}{s.values.length ? ` ${s.values[s.values.length - 1]}${unit}` : ""}
            </span>
          ))}
        </div>
      </div>
      {all.length === 0 ? (
        <Empty />
      ) : (
        <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="w-full" style={{ height: 120 }}>
          {series.map((s) => (
            s.values.length > 1 ? (
              <polyline key={s.name} fill="none" stroke={s.color} strokeWidth="1.5"
                points={s.values.map((v, i) => `${px(i).toFixed(1)},${py(v).toFixed(1)}`).join(" ")} />
            ) : null
          ))}
        </svg>
      )}
      <div className="text-xs text-zinc-700 mt-1">峰值 {max}{unit} · {n} 个采样点</div>
    </div>
  );
}

// PSS 持续上涨的疑似泄漏提示（启发式：样本足够 + 末值较起始上涨超阈值）
function LeakBadge({ memory }) {
  const pss = (Array.isArray(memory) ? memory : []).filter((r) => r.name === "mem:pssMb").map((r) => Math.round(r.value));
  if (pss.length < 5) return null;
  const delta = pss[pss.length - 1] - pss[0];
  if (delta < 30) return null;
  return (
    <div className="bg-amber-500/10 border border-amber-500/30 rounded-lg px-3 py-2 text-xs text-amber-400">
      ⚠️ 疑似内存泄漏：PSS 由 {pss[0]}MB 上涨到 {pss[pss.length - 1]}MB（+{delta}MB，{pss.length} 个采样点持续走高），建议排查泄漏/缓存未释放。
    </div>
  );
}

function metricTypeColor(type) {
  const m = {
    method: "bg-blue-500/15 text-blue-400",
    network: "bg-cyan-500/15 text-cyan-400",
    io: "bg-amber-500/15 text-amber-400",
    page: "bg-violet-500/15 text-violet-400",
  };
  return m[type] || "bg-zinc-700/40 text-zinc-400";
}

function TabBtn({ active, onClick, children }) {
  return (
    <button
      onClick={onClick}
      className={`px-4 py-2 text-sm -mb-px border-b-2 transition shrink-0 ${
        active ? "border-blue-500 text-zinc-100" : "border-transparent text-zinc-500 hover:text-zinc-300"
      }`}
    >
      {children}
    </button>
  );
}

function SummaryCard({ label, value, sub, color }) {
  const colors = {
    blue: "from-blue-500/10 to-blue-600/5 text-blue-400",
    violet: "from-violet-500/10 to-violet-600/5 text-violet-400",
    cyan: "from-cyan-500/10 to-cyan-600/5 text-cyan-400",
    amber: "from-amber-500/10 to-amber-600/5 text-amber-400",
    green: "from-green-500/10 to-green-600/5 text-green-400",
    red: "from-red-500/10 to-red-600/5 text-red-400",
  };
  return (
    <div className={`bg-gradient-to-br ${colors[color] || colors.blue} rounded-xl p-4 border border-zinc-800`}>
      <p className="text-xs opacity-60">{label}</p>
      <p className="text-xl font-bold mt-1">{value}</p>
      {sub && <p className="text-xs opacity-40 mt-0.5">{sub}</p>}
    </div>
  );
}

function Empty() {
  return <div className="text-center text-sm text-zinc-600 py-8">暂无性能数据——在 mock app 开启「性能分析」并设置上报地址后冷启动一次</div>;
}

function fmtMs(ms) {
  const n = Math.round(ms || 0);
  if (n <= 0) return "—";
  return n >= 1000 ? (n / 1000).toFixed(2) + "s" : n + "ms";
}

// 前台 CPU 占比（%）/ 内存（MB）格式化：null/0 显示 —
function fmtPct(v) {
  if (v == null) return "—";
  const n = Number(v);
  if (!Number.isFinite(n)) return "—";
  return `${n.toFixed(Math.abs(n) < 10 ? 2 : 1)}%`;
}

function fmtMb(v) {
  if (v == null) return "—";
  const n = Number(v);
  if (!Number.isFinite(n)) return "—";
  return `${n.toFixed(1)}MB`;
}

function fmtMiB(v) {
  if (v == null) return "—";
  const n = Number(v);
  if (!Number.isFinite(n)) return "—";
  return `${n.toFixed(2)}MiB`;
}

function totalColor(ms) {
  const n = Math.round(ms || 0);
  if (n <= 0) return "text-zinc-600";
  if (n < TARGET_OK) return "text-green-400";
  if (n < TARGET_WARN) return "text-amber-400";
  return "text-red-400";
}

function verdictColor(ms) {
  const n = Math.round(ms || 0);
  if (n <= 0) return "blue";
  if (n < TARGET_OK) return "green";
  if (n < TARGET_WARN) return "amber";
  return "red";
}

function verdictText(ms) {
  const n = Math.round(ms || 0);
  if (n <= 0) return "暂无";
  if (n < TARGET_OK) return "达标 (<2s)";
  if (n < TARGET_WARN) return "一般 (2~2.5s)";
  return "偏慢 (>2.5s)";
}
