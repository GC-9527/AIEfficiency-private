import React, { useEffect, useMemo, useState } from "react";

import Markdown from "../../components/Markdown.jsx";
import { authenticatedFetch } from "../../services/adminAuth.js";
import { getApiUrl } from "../../services/gateway.js";
import {
  WORKBOOK_SHEET_CATALOG,
  buildWorkbookMetricRows,
  finiteNumber,
  getResourceSamples,
  samplePoint,
} from "./resourceDashboardModel.mjs";
import {
  buildLiveResourceDetail,
  matchingResourceDetail,
  pendingResourceRunId,
  resourceLiveRunId,
  shouldUseLiveResourceDetail,
} from "./resourceLiveModel.mjs";
import { summarizeResourceRuns } from "./resourceSummaryModel.mjs";
import {
  chooseResourceScriptId,
  groupResourceScripts,
  normalizeResourceScripts,
  resourceScriptAvailability,
  resolveResourceScript,
} from "./resourceScriptModel.mjs";
import {
  parseDiagnosticCsv,
  resolveDisplayedSamplingMode,
  resolveSamplingMode,
  samplingModeDescriptor,
} from "./resourceSamplingModeModel.mjs";
import { buildResourceWorkflow } from "./resourceWorkflowModel.mjs";
import {
  chooseTaskUiView,
  normalizeTaskUi,
  taskUiSourceLabel,
  taskUiSourceRows,
} from "./resourceTaskUiModel.mjs";
import ResourceVideoScreen from "./ResourceVideoScreen.jsx";

const TEXT_CHUNK_BYTES = 64 * 1024;

function apiUrl(path) {
  if (!path) return "";
  if (/^https?:\/\//i.test(path)) return path;
  return getApiUrl(path.startsWith("/") ? path : `/${path}`);
}

function runLabel(run) {
  const device = [run?.deviceBrand, run?.deviceModel].filter(Boolean).join(" ") || "未知设备";
  const version = run?.appVersion ? `v${run.appVersion}` : "未知版本";
  return `${run?.createdAt || "未知时间"} · ${device} · ${version} · ${run?.acceptance || "INCONCLUSIVE"}`;
}

function statusStyle(status) {
  if (status === "pass") return "border-green-500/30 bg-green-500/10 text-green-400";
  if (status === "fail") return "border-red-500/30 bg-red-500/10 text-red-400";
  if (status === "inconclusive") return "border-amber-500/30 bg-amber-500/10 text-amber-400";
  return "border-zinc-800 bg-zinc-950/50 text-zinc-500";
}

function statusText(status) {
  if (status === "pass") return "PASS";
  if (status === "fail") return "FAIL";
  if (status === "inconclusive") return "待确认";
  return "未采集";
}

function acceptanceStyle(value) {
  const status = String(value || "").toUpperCase();
  if (status === "PASS") return "bg-green-500/15 text-green-400";
  if (status === "FAIL") return "bg-red-500/15 text-red-400";
  return "bg-amber-500/15 text-amber-400";
}

function formatNumber(value, digits = 2) {
  const number = finiteNumber(value);
  if (number === null) return "—";
  return number.toFixed(digits).replace(/\.00$/, "").replace(/(\.\d)0$/, "$1");
}

function formatMetricValue(metric) {
  if (!metric.collected) return "未采集";
  return `${formatNumber(metric.actual)}${metric.unit}`;
}

function formatLimit(metric) {
  return `${metric.comparison} ${metric.limit}${metric.unit}`;
}

function MetricCard({ metric, provisional = false }) {
  return (
    <div className={`rounded-xl border p-3 ${provisional ? "border-blue-500/30 bg-blue-500/5 text-blue-300" : statusStyle(metric.status)}`}>
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs opacity-70">{metric.label}</span>
        <span className="text-[10px] rounded bg-black/15 px-1.5 py-0.5">{provisional && metric.collected ? "采集中" : statusText(metric.status)}</span>
      </div>
      <div className="text-lg font-semibold font-mono mt-2">{formatMetricValue(metric)}</div>
      <div className="text-[11px] opacity-55 mt-1">工作簿目标 {formatLimit(metric)}</div>
    </div>
  );
}

function WorkbookCoverage({ metrics }) {
  const collectedKeys = new Set(metrics.filter((item) => item.collected).map((item) => item.key));
  const appmarket = WORKBOOK_SHEET_CATALOG.find((sheet) => sheet.kind === "应用市场");
  const appmarketCollected = appmarket.collectedMetricKeys.filter((key) => collectedKeys.has(key)).length;
  return (
    <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-4">
      <div className="flex items-start justify-between gap-3 flex-wrap mb-3">
        <div>
          <h4 className="text-sm text-zinc-300">工作簿覆盖范围</h4>
          <p className="text-xs text-zinc-600 mt-1">共 16 个 sheet：应用市场当前仅 CPU/PSS 5 项可由本轮映射，15 个生态应用及启动、响应、FPS、GPU、稳定性等尚未采集。</p>
        </div>
        <span className="text-[11px] rounded bg-amber-500/10 text-amber-400 border border-amber-500/25 px-2 py-1">当前轮次：应用市场 {appmarketCollected}/5 · 生态应用 0/15</span>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-2">
        {WORKBOOK_SHEET_CATALOG.map((sheet) => {
          const isAppmarket = sheet.kind === "应用市场";
          const collected = sheet.collectedMetricKeys.filter((key) => collectedKeys.has(key)).length;
          return (
            <div key={sheet.sheet} className={`rounded-lg border p-2.5 ${isAppmarket ? "border-blue-500/30 bg-blue-500/5" : "border-zinc-800 bg-zinc-950/35"}`}>
              <div className="flex items-center gap-2">
                <span className="text-xs font-medium text-zinc-300">{sheet.sheet}</span>
                <span className="text-[10px] text-zinc-600">{sheet.kind}</span>
                <span className={`ml-auto text-[10px] rounded px-1.5 py-0.5 ${collected ? "bg-blue-500/15 text-blue-400" : "bg-zinc-800 text-zinc-500"}`}>
                  {collected ? `本轮 ${collected}/5 项有数据` : "本轮未采集"}
                </span>
              </div>
              <div className="text-[10px] text-zinc-500 mt-1.5 leading-relaxed" title={sheet.processGroups.join("；")}>进程组：{sheet.processGroups.join("；")}</div>
              <div className="text-[10px] text-zinc-600 mt-1 leading-relaxed" title={sheet.metricGroups.join("；")}>指标组：{sheet.metricGroups.join("；")}</div>
            </div>
          );
        })}
      </div>
      <p className="text-[11px] text-zinc-600 mt-3">此处只展示工作簿要求的覆盖目录，不把工作簿中的历史实测值当作当前所选轮次数据。</p>
    </div>
  );
}

function splitPointSegments(points) {
  const segments = [];
  let current = [];
  for (const point of points) {
    if (point.y === null) {
      if (current.length) segments.push(current);
      current = [];
    } else {
      current.push(point);
    }
  }
  if (current.length) segments.push(current);
  return segments;
}

function ResourceSampleChart({ title, unit, samples, series, thresholds = [] }) {
  const resolved = series.map((definition) => ({
    ...definition,
    points: samples.map((sample, index) => samplePoint(sample, definition.key, index)),
  }));
  const xValues = resolved.flatMap((item) => item.points.map((point) => point.x));
  const yValues = resolved.flatMap((item) => item.points.map((point) => point.y).filter((value) => value !== null));
  const thresholdValues = thresholds.map((item) => finiteNumber(item.value)).filter((value) => value !== null);
  if (!xValues.length || !yValues.length) {
    return (
      <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-4">
        <h4 className="text-sm text-zinc-300">{title}</h4>
        <div className="text-center text-sm text-zinc-600 py-12">本轮没有可绘制的原始样本</div>
      </div>
    );
  }

  const width = 720;
  const height = 230;
  const pad = { left: 48, right: 16, top: 18, bottom: 28 };
  const xMin = Math.min(...xValues);
  const xMax = Math.max(...xValues);
  const yMaxRaw = Math.max(...yValues, ...thresholdValues, 1);
  const yMax = yMaxRaw * 1.12;
  const px = (value) => pad.left + ((value - xMin) / (xMax - xMin || 1)) * (width - pad.left - pad.right);
  const py = (value) => height - pad.bottom - (value / yMax) * (height - pad.top - pad.bottom);
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((ratio) => ({ ratio, value: yMax * ratio }));

  return (
    <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-4 overflow-hidden">
      <div className="flex items-center justify-between gap-3 flex-wrap mb-2">
        <h4 className="text-sm text-zinc-300">{title}</h4>
        <div className="flex items-center gap-3 flex-wrap">
          {resolved.map((item) => (
            <span key={item.key} className="text-xs text-zinc-500 flex items-center gap-1">
              <span className="w-3 h-0.5" style={{ backgroundColor: item.color }} />{item.label}
            </span>
          ))}
          {thresholds.map((item) => (
            <span key={item.label} className="text-[10px] text-zinc-600">虚线：{item.label} {formatNumber(item.value)}{unit}</span>
          ))}
        </div>
      </div>
      <svg viewBox={`0 0 ${width} ${height}`} className="w-full h-56" role="img" aria-label={title}>
        {ticks.map((tick) => (
          <g key={tick.ratio}>
            <line x1={pad.left} x2={width - pad.right} y1={py(tick.value)} y2={py(tick.value)} stroke="#27272a" strokeWidth="1" />
            <text x={pad.left - 6} y={py(tick.value) + 3} fill="#71717a" fontSize="10" textAnchor="end">{formatNumber(tick.value, 1)}</text>
          </g>
        ))}
        {thresholds.map((threshold) => {
          const value = finiteNumber(threshold.value);
          if (value === null) return null;
          return <line key={threshold.label} x1={pad.left} x2={width - pad.right} y1={py(value)} y2={py(value)} stroke={threshold.color || "#f59e0b"} strokeDasharray="5 4" strokeWidth="1" />;
        })}
        {resolved.flatMap((item) => splitPointSegments(item.points).map((segment, index) => (
          <polyline
            key={`${item.key}-${index}`}
            fill="none"
            stroke={item.color}
            strokeWidth="2"
            vectorEffect="non-scaling-stroke"
            points={segment.map((point) => `${px(point.x).toFixed(2)},${py(point.y).toFixed(2)}`).join(" ")}
          />
        )))}
        {resolved.flatMap((item) => item.points
          .filter((point) => point.y !== null)
          .map((point, index) => (
            <circle
              key={`${item.key}-point-${index}`}
              cx={px(point.x)}
              cy={py(point.y)}
              r={index === item.points.length - 1 ? 3.5 : 2.25}
              fill={item.color}
            />
          )))}
        <text x={pad.left} y={height - 7} fill="#71717a" fontSize="10">{formatNumber(xMin, 1)}s</text>
        <text x={width - pad.right} y={height - 7} fill="#71717a" fontSize="10" textAnchor="end">{formatNumber(xMax, 1)}s</text>
      </svg>
      <div className="text-xs text-zinc-600">横轴使用本轮 target_elapsed_s；空样本保留缺口，不与其他采集轮次拼接。</div>
    </div>
  );
}

function diagnosticPoints(samples, key, maximum = 300) {
  const points = (Array.isArray(samples) ? samples : []).flatMap((sample, index) => {
    const value = finiteNumber(sample?.[key]);
    if (value === null) return [];
    const x = finiteNumber(
      sample?.source_timestamp_s
      ?? sample?.actual_elapsed_s
      ?? sample?.target_elapsed_s,
    ) ?? index * 0.5;
    return [{ x, y: value }];
  });
  if (points.length <= maximum) return points;
  const stride = Math.ceil(points.length / maximum);
  const reduced = points.filter((_point, index) => index % stride === 0);
  const last = points.at(-1);
  if (last && reduced.at(-1) !== last) reduced.push(last);
  return reduced;
}

function DiagnosticLineChart({ title, unit, samples, metricKey, color }) {
  const points = diagnosticPoints(samples, metricKey);
  if (!points.length) {
    return <div className="rounded-lg border border-zinc-800 bg-zinc-950/50 p-3 text-xs text-zinc-600">{title}：等待有效点</div>;
  }
  const width = 520;
  const height = 120;
  const pad = { left: 38, right: 10, top: 10, bottom: 22 };
  const xMin = points[0].x;
  const xMax = points.at(-1).x;
  const values = points.map((point) => point.y);
  const yMin = Math.min(...values);
  const yMax = Math.max(...values);
  const ySpan = yMax - yMin || Math.max(Math.abs(yMax), 1);
  const low = Math.max(0, yMin - ySpan * 0.08);
  const high = yMax + ySpan * 0.08;
  const px = (value) => pad.left + ((value - xMin) / (xMax - xMin || 1)) * (width - pad.left - pad.right);
  const py = (value) => height - pad.bottom - ((value - low) / (high - low || 1)) * (height - pad.top - pad.bottom);
  const path = points.map((point) => `${px(point.x).toFixed(2)},${py(point.y).toFixed(2)}`).join(" ");
  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-950/50 p-3">
      <div className="flex items-center justify-between text-xs"><span className="text-zinc-400">{title}</span><span className="font-mono" style={{ color }}>{formatNumber(points.at(-1).y)}{unit}</span></div>
      <svg viewBox={`0 0 ${width} ${height}`} className="mt-1 h-28 w-full" role="img" aria-label={title}>
        <line x1={pad.left} x2={width - pad.right} y1={height - pad.bottom} y2={height - pad.bottom} stroke="#27272a" />
        <polyline points={path} fill="none" stroke={color} strokeWidth="2" vectorEffect="non-scaling-stroke" />
        <text x={pad.left - 4} y={py(high) + 4} fill="#71717a" fontSize="9" textAnchor="end">{formatNumber(high, 1)}</text>
        <text x={pad.left - 4} y={py(low) + 4} fill="#71717a" fontSize="9" textAnchor="end">{formatNumber(low, 1)}</text>
        <text x={pad.left} y={height - 6} fill="#71717a" fontSize="9">{formatNumber(xMin, 1)}s</text>
        <text x={width - pad.right} y={height - 6} fill="#71717a" fontSize="9" textAnchor="end">{formatNumber(xMax, 1)}s</text>
      </svg>
      <div className="text-[10px] text-zinc-700">最多绘制 300 个折线点，不生成逐点 DOM 圆点。</div>
    </div>
  );
}

function latestMetricSample(samples, key) {
  for (let index = (Array.isArray(samples) ? samples.length : 0) - 1; index >= 0; index -= 1) {
    if (finiteNumber(samples[index]?.[key]) !== null) return samples[index];
  }
  return null;
}

function RealtimeDiagnosticPanel({ run, detail }) {
  const live = run?.live && typeof run.live === "object" ? run.live : {};
  const meta = live.meta && typeof live.meta === "object" ? live.meta : {};
  const profile = detail?.profile || detail?.resourceProfile || {};
  const diagnostic = profile?.diagnostic && typeof profile.diagnostic === "object" ? profile.diagnostic : {};
  const directSamples = Array.isArray(live.diagnosticSamples)
    ? live.diagnosticSamples
    : Array.isArray(detail?.diagnosticSamples) ? detail.diagnosticSamples : [];
  const formalSamples = Array.isArray(live.samples) ? live.samples : getResourceSamples(detail);
  const samplingMode = resolveSamplingMode({ run, detail });
  const formalInterval = finiteNumber(meta.interval_s ?? profile?.sampling?.interval_s) ?? 5;
  const descriptor = samplingModeDescriptor(samplingMode, {
    formalIntervalS: formalInterval,
    diagnostic: Object.keys(meta).length ? meta : diagnostic,
  });
  const runId = resourceLiveRunId(run) || String(detail?.run?.id || detail?.id || "").trim();
  const diagnosticArtifact = (Array.isArray(detail?.artifacts) ? detail.artifacts : []).find((artifact) => (
    artifact?.key === "diagnostic_metrics" || /diagnostic_metrics\.csv$/i.test(artifactPath(artifact))
  ));
  const artifactIdentity = diagnosticArtifact ? `${diagnosticArtifact.key || ""}:${artifactPath(diagnosticArtifact)}` : "";
  const [historical, setHistorical] = useState({ runId: "", samples: [], loading: false, error: "" });

  useEffect(() => {
    if (!descriptor.isRealtime || directSamples.length || !runId || !diagnosticArtifact) {
      setHistorical((previous) => (
        previous.runId || previous.samples.length || previous.loading || previous.error
          ? { runId: "", samples: [], loading: false, error: "" }
          : previous
      ));
      return undefined;
    }
    const controller = new AbortController();
    let disposed = false;
    setHistorical({ runId, samples: [], loading: true, error: "" });
    (async () => {
      let offset = 0;
      let text = "";
      let eof = false;
      let chunks = 0;
      while (!eof && chunks < 64 && text.length < 4 * 1024 * 1024) {
        const response = await authenticatedFetch(artifactPreviewEndpoint(runId, diagnosticArtifact, offset), { signal: controller.signal });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const contentType = response.headers.get("content-type") || "";
        let content = "";
        let nextOffset = offset;
        if (contentType.includes("application/json")) {
          const envelope = await response.json();
          const data = envelope?.data ?? envelope;
          content = String(data?.content ?? data?.text ?? "");
          nextOffset = finiteNumber(data?.nextOffset) ?? offset + (finiteNumber(data?.bytesRead) ?? new TextEncoder().encode(content).length);
          eof = data?.truncated !== true && data?.eof !== false;
        } else {
          content = await response.text();
          const received = new TextEncoder().encode(content).length;
          nextOffset = offset + received;
          eof = received < TEXT_CHUNK_BYTES;
        }
        text += content;
        chunks += 1;
        if (nextOffset <= offset && !eof) throw new Error("诊断文件分段偏移未前进");
        offset = nextOffset;
      }
      if (!disposed) setHistorical({ runId, samples: parseDiagnosticCsv(text), loading: false, error: "" });
    })().catch((error) => {
      if (!disposed && error?.name !== "AbortError") {
        setHistorical({ runId, samples: [], loading: false, error: error.message || "诊断数据加载失败" });
      }
    });
    return () => {
      disposed = true;
      controller.abort();
    };
  }, [artifactIdentity, descriptor.isRealtime, directSamples.length, runId]);

  const samples = directSamples.length ? directSamples : (historical.runId === runId ? historical.samples : []);
  if (!descriptor.isRealtime && !samples.length) return null;
  const latestCpu = latestMetricSample(samples, "cpu_device_normalized_pct");
  const latestRss = latestMetricSample(samples, "rss_mb");
  const latestPss = latestMetricSample(formalSamples, "pss_mb");
  const diagnosticMeasurements = diagnostic?.measurements || {};
  const cpuSummary = diagnosticMeasurements?.cpu_device_normalized_pct || {};
  const rssSummary = diagnosticMeasurements?.rss_mb || {};
  const totalCount = finiteNumber(live.diagnosticTotalCount ?? diagnostic.actual_rows) ?? samples.length;
  return (
    <div className="rounded-xl border border-cyan-500/25 bg-cyan-500/5 p-4 space-y-3">
      <div className="flex items-center gap-3 flex-wrap">
        <div>
          <h4 className="text-sm text-cyan-300">实时诊断轨道</h4>
          <p className="mt-1 text-[11px] text-zinc-600">{descriptor.description}</p>
        </div>
        <span className="ml-auto rounded bg-cyan-500/10 px-2 py-1 text-[10px] font-mono text-cyan-400">累计 {totalCount} · 保留 {samples.length}</span>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
        <InfoCard label={samples.length ? "最新实时 CPU" : "实时 CPU 均值"} value={latestCpu ? `${formatNumber(latestCpu.cpu_device_normalized_pct)}%` : finiteNumber(cpuSummary.mean) === null ? "建立基线中" : `${formatNumber(cpuSummary.mean)}%`} sub={latestCpu ? `窗口 ${formatNumber(latestCpu.cpu_window_duration_s ?? 0.5)}s` : finiteNumber(cpuSummary.peak) === null ? "首点允许为空" : `峰值 ${formatNumber(cpuSummary.peak)}%`} />
        <InfoCard label={samples.length ? "最新 RSS" : "RSS 均值"} value={latestRss ? `${formatNumber(latestRss.rss_mb)}MiB` : finiteNumber(rssSummary.mean) === null ? "等待 1s 点" : `${formatNumber(rssSummary.mean)}MiB`} sub={latestRss ? `t=${formatNumber(latestRss.rss_source_timestamp_s ?? latestRss.source_timestamp_s)}s` : finiteNumber(rssSummary.peak) === null ? "只显示 fresh RSS" : `峰值 ${formatNumber(rssSummary.peak)}MiB`} />
        <InfoCard label="最新正式 PSS" value={latestPss ? `${formatNumber(latestPss.pss_mb)}MiB` : "等待 5s 点"} sub="来自正式 live.samples" />
      </div>
      {historical.loading && <div className="text-xs text-cyan-400/80">正在读取本轮 diagnostic_metrics.csv…</div>}
      {historical.error && <div className="text-xs text-amber-300">诊断原始点加载失败：{historical.error}；上方仍显示报表汇总值。</div>}
      {samples.length ? (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
          <DiagnosticLineChart title={descriptor.diagnosticCpuTitle} unit="%" samples={samples} metricKey="cpu_device_normalized_pct" color="#22d3ee" />
          <DiagnosticLineChart title={descriptor.diagnosticRssTitle} unit="MiB" samples={samples} metricKey="rss_mb" color="#a78bfa" />
        </div>
      ) : !historical.loading && <div className="rounded border border-zinc-800 bg-zinc-950/40 px-3 py-2 text-xs text-zinc-600">本轮已标记为实时诊断；诊断逐点文件不可在线访问时仅展示持久化汇总。</div>}
    </div>
  );
}

function formatCurrentStep(value) {
  if (!value) return "等待脚本上报当前步骤";
  if (typeof value === "string") return value;
  const step = value.step || value.name || value.id || "脚本步骤";
  const status = value.status ? ` · ${value.status}` : "";
  const message = value.message ? ` · ${value.message}` : "";
  return `${step}${status}${message}`;
}

function phaseText(value) {
  const phases = {
    starting: "准备设备与采集环境",
    preflight: "设备预检",
    collecting: "执行脚本并采集",
    sampling: "CPU / 内存采样",
    flow: "执行自动化脚本",
    analyzing: "生成分析结果",
    uploading: "上报后台",
    finalizing: "上报并保留原始数据",
    completed: "采集完成",
    completed_with_upload_error: "采集完成，上报失败",
    stopping: "正在停止",
    cancelled: "已取消",
    failed: "运行失败",
  };
  return phases[value] || value || "等待运行阶段";
}

const WORKFLOW_STYLES = {
  pending: { dot: "bg-zinc-700", card: "border-zinc-800 bg-zinc-950/30", text: "text-zinc-600", label: "等待" },
  running: { dot: "bg-blue-400 animate-pulse", card: "border-blue-500/40 bg-blue-500/10", text: "text-blue-300", label: "执行中" },
  success: { dot: "bg-green-400", card: "border-green-500/30 bg-green-500/5", text: "text-green-400", label: "完成" },
  warning: { dot: "bg-amber-400", card: "border-amber-500/30 bg-amber-500/5", text: "text-amber-400", label: "部分/跳过" },
  failed: { dot: "bg-red-400", card: "border-red-500/35 bg-red-500/10", text: "text-red-400", label: "失败" },
  cancelled: { dot: "bg-violet-400", card: "border-violet-500/35 bg-violet-500/10", text: "text-violet-400", label: "已停止" },
  skipped: { dot: "bg-zinc-600", card: "border-zinc-800 bg-zinc-900/30", text: "text-zinc-500", label: "不适用" },
};

function WorkflowNode({ step, index, isLast }) {
  const style = WORKFLOW_STYLES[step.state] || WORKFLOW_STYLES.pending;
  return (
    <div className="flex min-w-0 flex-1 items-stretch">
      <div className={`min-w-[7.5rem] flex-1 rounded-lg border px-3 py-2 ${style.card}`}>
        <div className="flex items-center gap-2">
          <span className={`h-2 w-2 shrink-0 rounded-full ${style.dot}`} />
          <span className="text-[10px] text-zinc-600">{String(index + 1).padStart(2, "0")}</span>
          <span className={`ml-auto text-[10px] ${style.text}`}>{style.label}</span>
        </div>
        <div className="mt-1.5 text-xs text-zinc-300 leading-snug">{step.label}</div>
        {step.event?.message && <div className="mt-1 truncate text-[10px] text-zinc-600" title={step.event.message}>{step.event.message}</div>}
        {step.event?.at && <div className="mt-1 text-[9px] font-mono text-zinc-700">{step.event.at.replace("T", " ").slice(11, 19) || step.event.at}</div>}
      </div>
      {!isLast && <div className="flex w-5 shrink-0 items-center justify-center text-zinc-800">→</div>}
    </div>
  );
}

function WorkflowLane({ label, hint, steps }) {
  return (
    <div className="grid grid-cols-[7.5rem_minmax(0,1fr)] gap-3 items-start">
      <div className="pt-2">
        <div className="text-xs text-zinc-300">{label}</div>
        <div className="mt-1 text-[10px] leading-relaxed text-zinc-600">{hint}</div>
      </div>
      <div className="overflow-x-auto pb-1">
        <div className="flex min-w-[62rem] items-stretch">{steps.map((step, index) => <WorkflowNode key={step.key} step={step} index={index} isLast={index === steps.length - 1} />)}</div>
      </div>
    </div>
  );
}

function WorkflowTimeline({ run, detail, active, scripts, fallbackScriptId, section = null }) {
  const workflow = useMemo(
    () => buildResourceWorkflow({ run, detail, active, scripts, fallbackScriptId }),
    [active, detail, fallbackScriptId, run, scripts],
  );
  const childGroups = workflow.script.filter((step) => Array.isArray(step.children) && step.children.length > 0);
  const progress = workflow.applicable ? Math.round(workflow.finished / workflow.applicable * 100) : 0;
  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-900 p-4 space-y-4" data-testid="performance-test-workflow">
      <div className="flex items-start gap-4 flex-wrap">
        <div>
          <h3 className="text-sm font-medium text-zinc-300">{section?.title || section?.label || "测试任务工作流"}</h3>
          <p className="mt-1 text-xs text-zinc-500">当前脚本：<span className="text-zinc-300">{workflow.scriptMeta.name}</span> <span className="font-mono text-zinc-600">({workflow.scriptMeta.id})</span></p>
          <p className="mt-1 text-xs text-zinc-600">{section?.description || workflow.scriptMeta.description || "采集主线与脚本任务并行；脚本事件严格按本轮冻结的 eventSteps 映射。"}</p>
        </div>
        <div className="ml-auto min-w-[18rem] rounded-lg border border-blue-500/25 bg-blue-500/5 px-3 py-2">
          <div className="flex items-center gap-2 text-[10px] text-zinc-600">
            <span>{active ? "当前正在执行" : "本轮最后步骤"}</span>
            {workflow.currentOrdinal && <span className="ml-auto font-mono text-blue-400">{workflow.currentOrdinal}/{workflow.totalSteps}</span>}
          </div>
          <div className="mt-1 text-xs text-zinc-200">{workflow.currentLabel}</div>
          <div className="mt-1 text-[10px] text-zinc-500 break-words">{workflow.currentEvent?.message || (active ? "等待脚本事件" : "可从流程结果和原始事件查看本轮执行情况")}</div>
        </div>
      </div>
      {workflow.scriptMeta.legacy && (
        <div className="rounded-lg border border-amber-500/25 bg-amber-500/5 px-3 py-2 text-[11px] text-amber-400">
          该旧轮次未保存脚本快照，当前仅按旧版应用市场流程兼容还原；新轮次不会使用此固定流程。
        </div>
      )}
      {workflow.unmappedEvents.length > 0 && (
        <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-[11px] text-red-300" data-testid="performance-test-unmapped-events">
          本轮有 {workflow.unmappedEvents.length} 个脚本事件未在所选脚本 workflow.eventSteps 中声明：
          <span className="ml-1 font-mono">{[...new Set(workflow.unmappedEvents.map((event) => event.step))].join("、")}</span>。请检查脚本与工作流配置是否一一对应。
        </div>
      )}
      <div className="h-1.5 overflow-hidden rounded bg-zinc-800"><div className="h-full rounded bg-blue-500 transition-[width] duration-500" style={{ width: `${progress}%` }} /></div>
      <WorkflowLane label="采集主线" hint="设备、采样、分析与上报" steps={workflow.system} />
      {workflow.script.length > 0
        ? <WorkflowLane label="任务脚本" hint={`${workflow.mode} · ${workflow.scriptMeta.runner || "脚本执行器"}`} steps={workflow.script} />
        : <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-3 text-xs text-red-300">当前脚本没有可展示的 workflow.steps，请先修正脚本配置。</div>}
      {childGroups.map((group) => (
        <div key={group.key} className="grid grid-cols-[7.5rem_minmax(0,1fr)] gap-3">
          <div className="text-[10px] text-zinc-600 pt-1">{group.label}明细</div>
          <div className="flex flex-wrap gap-2">
            {group.children.map((child) => {
              const style = WORKFLOW_STYLES[child.state] || WORKFLOW_STYLES.pending;
              return <span key={child.key} className={`inline-flex items-center gap-1.5 rounded border px-2 py-1 text-[10px] ${style.card} ${style.text}`}><span className={`h-1.5 w-1.5 rounded-full ${style.dot}`} />{child.label}</span>;
            })}
          </div>
        </div>
      ))}
    </div>
  );
}

function ScriptLiveSection({ section, run, detail }) {
  const rows = useMemo(() => taskUiSourceRows(section, { run, detail }), [detail, run, section]);
  const latest = rows.at(-1) || null;
  const groups = useMemo(() => {
    const result = new Map();
    for (const metric of section.metrics || []) {
      const unit = metric.unit || "数值";
      if (!result.has(unit)) result.set(unit, []);
      result.get(unit).push(metric);
    }
    return [...result.entries()];
  }, [section.metrics]);
  return (
    <div className="rounded-xl border border-cyan-500/20 bg-zinc-900 p-4 space-y-4" data-testid={`script-ui-section-${section.id}`}>
      <div className="flex items-start gap-3 flex-wrap">
        <div>
          <h3 className="text-sm font-medium text-zinc-300">{section.title || section.label}</h3>
          {section.description && <p className="mt-1 text-xs text-zinc-600">{section.description}</p>}
        </div>
        <span className="ml-auto rounded bg-cyan-500/10 px-2 py-1 text-[10px] font-mono text-cyan-400">{taskUiSourceLabel(section.source)} · {rows.length} 点</span>
      </div>
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-2">
        {(section.metrics || []).map((metric) => {
          const value = finiteNumber(latest?.[metric.key]);
          return <InfoCard key={metric.key} label={metric.label} value={value === null ? "等待数据" : `${formatNumber(value, metric.decimals)}${metric.unit || ""}`} sub={latest ? `最新序号 ${latest.sample_index ?? latest.diagnostic_index ?? latest.sequence ?? rows.length}` : section.emptyText || "等待脚本实时输出"} />;
        })}
      </div>
      {!rows.length ? (
        <div className="rounded-lg border border-zinc-800 bg-zinc-950/50 px-4 py-10 text-center text-xs text-zinc-600">{section.emptyText || `等待 ${taskUiSourceLabel(section.source)} 数据`}</div>
      ) : groups.map(([unit, metrics]) => (
        <ResourceSampleChart
          key={unit}
          title={`${section.title || section.label} · ${unit}`}
          unit={unit === "数值" ? "" : unit}
          samples={rows}
          series={metrics.map((metric) => ({ key: metric.key, label: metric.label, color: metric.color || "#60a5fa" }))}
        />
      ))}
    </div>
  );
}

function ScriptRunSections({ script, run, detail, active, scripts, fallbackScriptId }) {
  const ui = useMemo(() => normalizeTaskUi(script), [script]);
  const samplingMode = resolveSamplingMode({ run, detail });
  const sections = ui.runSections.filter((section) => (
    (active || section.showInHistory)
    && (!section.samplingModes?.length || section.samplingModes.includes(samplingMode))
  ));
  if (!sections.length) return null;
  return sections.map((section) => {
    if (section.kind === "workflow") {
      return <WorkflowTimeline key={section.id} run={run} detail={detail} active={active} scripts={scripts} fallbackScriptId={fallbackScriptId} section={section} />;
    }
    if (section.kind === "live") return <ScriptLiveSection key={section.id} section={section} run={run} detail={detail} />;
    return null;
  });
}

function VideoUnavailable({ title = "实时投屏未连接", message = "实时投屏只在当前测试进行中提供；历史轮次不会建立 scrcpy 视频连接。" }) {
  return (
    <div className="min-h-72 rounded-xl border border-zinc-800 bg-zinc-950 flex flex-col" data-testid="performance-test-video-inactive">
      <div className="border-b border-zinc-800 px-3 py-2 text-xs text-zinc-500">当前连接设备实时投屏</div>
      <div className="flex flex-1 flex-col items-center justify-center px-6 text-center">
        <div className="text-sm text-zinc-500">{title}</div>
        <div className="mt-2 max-w-lg text-xs leading-relaxed text-zinc-700">{message}</div>
      </div>
    </div>
  );
}

function scriptStepCount(script) {
  const workflow = Array.isArray(script?.workflow) ? script.workflow : script?.workflow?.steps;
  return Array.isArray(workflow) ? workflow.length : 0;
}

function scriptAvailabilityStyle(code) {
  if (code === "ready") return "border-green-500/25 bg-green-500/10 text-green-400";
  if (code === "disabled") return "border-zinc-700 bg-zinc-800 text-zinc-500";
  return "border-amber-500/25 bg-amber-500/10 text-amber-300";
}

export function ResourceScriptLibrary({
  scripts,
  selectedScriptId = "",
  onSelect,
  locked = false,
  loading = false,
  error = "",
}) {
  const catalog = useMemo(() => normalizeResourceScripts(scripts), [scripts]);
  const groups = useMemo(() => groupResourceScripts(catalog), [catalog]);

  if (loading) {
    return <div className="rounded-lg border border-zinc-800 bg-zinc-950/50 px-3 py-4 text-xs text-zinc-500">正在扫描性能测试脚本目录…</div>;
  }
  if (error && catalog.length === 0) {
    return (
      <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-3 text-xs text-red-300">
        脚本目录加载失败：{error}
      </div>
    );
  }
  if (catalog.length === 0) {
    return (
      <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-3 text-xs text-amber-300">
        脚本目录已加载，但没有发现测试任务。请检查专用脚本目录和任务清单。
      </div>
    );
  }

  return (
    <div className="space-y-3" data-testid="performance-script-library">
      {error && (
        <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-300">
          脚本目录刷新失败，当前展示上次成功加载的目录：{error}
        </div>
      )}
      {groups.map((group) => {
        const readyCount = group.scripts.filter((script) => resourceScriptAvailability(script).selectable).length;
        return (
          <section key={group.category} className="rounded-lg border border-zinc-800 bg-zinc-950/35 p-3">
            <div className="mb-2 flex items-center gap-2 text-xs">
              <span className="font-medium text-zinc-300">{group.category}</span>
              <span className="rounded bg-zinc-800 px-2 py-0.5 text-[10px] text-zinc-500">{group.scripts.length} 项 · {readyCount} 项可运行</span>
            </div>
            <div className="grid grid-cols-1 gap-2 xl:grid-cols-2">
              {group.scripts.map((script) => {
                const availability = resourceScriptAvailability(script);
                const selected = script.id === selectedScriptId;
                return (
                  <button
                    key={script.id}
                    type="button"
                    disabled={!onSelect || locked || !availability.selectable}
                    onClick={() => onSelect?.(script.id)}
                    className={`min-w-0 rounded-lg border px-3 py-3 text-left transition ${selected ? "border-cyan-500/60 bg-cyan-500/10" : "border-zinc-800 bg-zinc-950/70"} ${onSelect && !locked && availability.selectable ? "hover:border-cyan-500/40" : "cursor-default"}`}
                    title={availability.selectable ? `选择 ${script.name}` : availability.reason}
                  >
                    <div className="flex min-w-0 items-start gap-2">
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-xs font-medium text-zinc-200">{script.name}</div>
                        <div className="mt-1 truncate font-mono text-[10px] text-zinc-600" title={script.id}>{script.id}</div>
                      </div>
                      {selected && <span className="shrink-0 rounded bg-cyan-500/15 px-2 py-0.5 text-[10px] text-cyan-300">{locked ? "本轮使用" : "已选择"}</span>}
                      <span className={`shrink-0 rounded border px-2 py-0.5 text-[10px] ${scriptAvailabilityStyle(availability.code)}`}>{availability.label}</span>
                    </div>
                    <p className="mt-2 line-clamp-2 min-h-8 text-[11px] leading-4 text-zinc-500">{script.description || "未填写任务说明"}</p>
                    <div className="mt-2 flex min-w-0 flex-wrap items-center gap-1.5 text-[10px] text-zinc-500">
                      <span className="rounded bg-zinc-800 px-2 py-1">{scriptStepCount(script)} 个工作流节点</span>
                      {script.version && <span className="rounded bg-zinc-800 px-2 py-1">v{script.version}</span>}
                      {Array.isArray(script.sourceFiles) && script.sourceFiles.length > 0 && (
                        <span className="rounded bg-zinc-800 px-2 py-1">{script.sourceFiles.length} 个关联组件</span>
                      )}
                      <span className="min-w-0 max-w-full truncate rounded bg-zinc-800 px-2 py-1 font-mono" title={script.runner || "未配置 runner"}>{script.runner || "未配置 runner"}</span>
                    </div>
                    {Array.isArray(script.tags) && script.tags.length > 0 && (
                      <div className="mt-2 flex flex-wrap gap-1 text-[10px] text-cyan-500/80">
                        {script.tags.map((tag) => <span key={tag} className="rounded border border-cyan-500/20 px-1.5 py-0.5">{tag}</span>)}
                      </div>
                    )}
                    {script.manifestPath && (
                      <div className="mt-2 truncate font-mono text-[10px] text-zinc-700" title={script.manifestPath}>清单：{script.manifestPath}</div>
                    )}
                    {!availability.selectable && <div className="mt-2 text-[10px] text-amber-300/90">不可用原因：{availability.reason}</div>}
                  </button>
                );
              })}
            </div>
          </section>
        );
      })}
    </div>
  );
}

function ResourceScriptPicker({
  scripts,
  selectedScriptId,
  onScriptChange,
  onStart,
  active,
  busy,
  loading,
  error,
  onReload,
  liveRun,
  samplingMode,
  onSamplingModeChange,
}) {
  const catalog = useMemo(() => normalizeResourceScripts(scripts), [scripts]);
  const enabledScripts = catalog.filter((script) => resourceScriptAvailability(script).selectable);
  const runningScript = active ? resolveResourceScript({ run: liveRun, scripts: catalog }) : null;
  const nextScriptId = chooseResourceScriptId(catalog, selectedScriptId, selectedScriptId);
  const selectedScript = active
    ? runningScript
    : catalog.find((script) => script.id === nextScriptId) || null;
  const pickerOptions = runningScript && !enabledScripts.some((script) => script.id === runningScript.id)
    ? [runningScript, ...enabledScripts]
    : enabledScripts;
  const pickerGroups = groupResourceScripts(pickerOptions);
  const effectiveId = active ? (runningScript?.id || liveRun?.options?.scriptId || "") : nextScriptId;
  const disabled = active || busy || loading || enabledScripts.length === 0;
  const actualSamplingMode = resolveSamplingMode({
    form: { samplingMode },
    run: active ? liveRun : null,
  });
  const samplingDescriptor = samplingModeDescriptor(actualSamplingMode, {
    formalIntervalS: finiteNumber(liveRun?.live?.meta?.interval_s ?? liveRun?.options?.interval) ?? 5,
    diagnostic: liveRun?.live?.meta,
  });
  const selectedUi = useMemo(() => normalizeTaskUi(selectedScript), [selectedScript]);
  const emptyLabel = loading
    ? "正在加载脚本目录…"
    : error && catalog.length === 0
      ? "脚本目录加载失败"
      : catalog.length === 0
        ? "脚本目录暂无任务"
        : "暂无可运行脚本";

  return (
    <div className="rounded-xl border border-cyan-500/25 bg-cyan-500/5 p-4 space-y-3" data-testid="performance-test-script-picker">
      <div className="flex items-start gap-3 flex-wrap">
        <div>
          <h3 className="text-sm font-medium text-zinc-200">性能测试任务脚本</h3>
          <p className="mt-1 text-xs text-zinc-500">{active ? "本轮脚本及工作流快照已经锁定，结束或停止后才能更换。" : "选择下一轮测试任务；启动时会把 scriptId 发送给采集服务。"}</p>
        </div>
        {active && <span className="rounded bg-blue-500/15 px-2 py-1 text-[10px] text-blue-400">运行中已锁定</span>}
        <select
          value={effectiveId}
          disabled={disabled}
          onChange={(event) => onScriptChange?.(event.target.value)}
          className="ml-auto min-w-0 w-full lg:w-[28rem] rounded border border-zinc-700 bg-zinc-900 px-3 py-2 text-xs text-zinc-200 disabled:opacity-60"
          aria-label="性能测试任务脚本"
        >
          {pickerOptions.length === 0 && <option value="">{emptyLabel}</option>}
          {pickerGroups.map((group) => (
            <optgroup key={group.category} label={group.category}>
              {group.scripts.map((script) => <option key={script.id} value={script.id}>{script.name} · {script.id}</option>)}
            </optgroup>
          ))}
        </select>
        <button
          type="button"
          disabled={active || busy || loading || !onReload}
          onClick={() => onReload?.()}
          className="rounded border border-zinc-700 bg-zinc-800 px-3 py-2 text-xs text-zinc-400 hover:bg-zinc-700 disabled:opacity-40"
        >{loading ? "扫描中…" : "重新加载脚本"}</button>
        <button
          type="button"
          disabled={disabled}
          onClick={onStart}
          className="rounded bg-cyan-600/80 px-4 py-2 text-xs text-white hover:bg-cyan-600 disabled:opacity-40"
        >{active ? "本轮测试进行中" : busy ? "正在启动…" : "使用此脚本开始测试"}</button>
      </div>
      <div
        className="rounded-lg border border-cyan-500/25 bg-zinc-950/60 px-3 py-3"
        data-testid="performance-test-sampling-mode"
      >
        <div className="flex items-center gap-3 flex-wrap">
          <div>
            <div className="text-xs font-medium text-zinc-300">{active ? "本轮采样模式" : "下一轮采样模式"}</div>
            <div className="mt-1 text-[11px] text-zinc-600">{active ? "模式与采样频率已随本轮运行快照锁定。" : "在开始测试前选择；切换任务脚本时会保留此选择。"}</div>
          </div>
          <span className={`rounded px-2 py-1 text-[10px] ${samplingDescriptor.isRealtime ? "bg-cyan-500/15 text-cyan-300" : "bg-blue-500/15 text-blue-300"}`}>{samplingDescriptor.label}</span>
          {active && <span className="rounded bg-zinc-800 px-2 py-1 text-[10px] text-zinc-500">运行中已锁定</span>}
          <select
            value={actualSamplingMode}
            disabled={active || busy || loading || !onSamplingModeChange}
            onChange={(event) => onSamplingModeChange?.(event.target.value)}
            className="ml-auto min-w-0 w-full lg:w-72 rounded border border-zinc-700 bg-zinc-900 px-3 py-2 text-xs text-zinc-200 disabled:opacity-60"
            aria-label="性能测试采样模式"
          >
            <option value="standard">标准验收（CPU/PSS 5 秒）</option>
            <option value="realtime">实时诊断（CPU 500ms / RSS 1 秒）</option>
          </select>
        </div>
        <div className="mt-2 text-xs leading-relaxed text-zinc-500">{samplingDescriptor.description}</div>
        <div className="mt-2 inline-flex rounded border border-zinc-800 bg-zinc-900 px-2 py-1 text-[10px] font-mono text-zinc-500">{samplingDescriptor.cadence}</div>
      </div>
      {selectedScript ? (
        <div className="grid grid-cols-1 md:grid-cols-[minmax(0,1fr)_auto] gap-3 rounded-lg border border-zinc-800 bg-zinc-950/60 px-3 py-2">
          <div>
            <div className="text-xs text-zinc-300">{active ? "当前性能测试使用" : "下一轮将使用"}：{selectedScript.name}</div>
            <div className="mt-1 text-[11px] leading-relaxed text-zinc-600">{selectedScript.description || "未填写脚本说明"}</div>
            <div className="mt-2 flex items-center gap-1.5 flex-wrap text-[10px] text-cyan-400/80" data-testid="performance-test-script-ui-preview">
              <span className="text-zinc-600">脚本页面：</span>
              {selectedUi.runSections.map((section) => <span key={section.id} className="rounded border border-cyan-500/20 bg-cyan-500/5 px-1.5 py-0.5">{section.label}</span>)}
              {selectedUi.views.map((item) => <span key={item.id} className="rounded border border-blue-500/20 bg-blue-500/5 px-1.5 py-0.5">{item.label}</span>)}
            </div>
          </div>
          <div className="flex items-center gap-2 text-[10px] text-zinc-500">
            <span className="rounded bg-zinc-800 px-2 py-1 font-mono">{selectedScript.id}</span>
            <span className="rounded bg-zinc-800 px-2 py-1">{scriptStepCount(selectedScript)} 个工作流节点</span>
            {selectedScript.runner && <span className="rounded bg-zinc-800 px-2 py-1 font-mono">{selectedScript.runner}</span>}
          </div>
        </div>
      ) : (
        <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-300">
          {emptyLabel}。请检查“分析配置”中的脚本目录状态；已禁用、入口失效或缺少工作流的任务不会用于启动。
        </div>
      )}
      <details open className="rounded-lg border border-zinc-800 bg-zinc-950/30 p-3">
        <summary className="cursor-pointer text-xs font-medium text-zinc-300">脚本库 · 按分类查看与选择</summary>
        <div className="mt-3">
          <ResourceScriptLibrary
            scripts={catalog}
            selectedScriptId={effectiveId}
            onSelect={active ? undefined : onScriptChange}
            locked={active || busy}
            loading={loading}
            error={error}
          />
        </div>
      </details>
    </div>
  );
}

function LiveRunPanel({ run, active, detail, scripts, fallbackScriptId }) {
  const live = run?.live && typeof run.live === "object" ? run.live : {};
  const meta = live.meta && typeof live.meta === "object" ? live.meta : {};
  const progress = live.progress && typeof live.progress === "object" ? live.progress : {};
  const samples = Array.isArray(live.samples) ? live.samples : [];
  const sampleCount = finiteNumber(progress.sampleCount) ?? samples.length;
  const expectedSamples = finiteNumber(progress.expectedSamples)
    ?? finiteNumber(meta.expected_samples)
    ?? ((finiteNumber(meta.duration_s ?? run?.options?.duration) && finiteNumber(meta.interval_s ?? run?.options?.interval))
      ? Math.round(Number(meta.duration_s ?? run.options.duration) / Number(meta.interval_s ?? run.options.interval))
      : null);
  const percent = expectedSamples
    ? Math.min(100, Math.max(0, sampleCount / expectedSamples * 100))
    : Math.min(100, Math.max(0, finiteNumber(progress.percent) ?? 0));
  const currentStep = formatCurrentStep(live.currentStep);
  const device = meta.device && typeof meta.device === "object" ? meta.device : {};
  const serial = meta.serial || device.serial || run?.options?.serial || "";
  const deviceLabel = [device.brand || meta.brand, device.model || meta.model, serial].filter(Boolean).join(" ");
  const latest = samples.length ? samples[samples.length - 1] : null;
  const logs = Array.isArray(run?.logs) ? run.logs.slice(-12) : [];
  const interval = finiteNumber(progress.intervalS ?? meta.interval_s ?? run?.options?.interval) ?? 5;
  const samplingMode = resolveSamplingMode({ run, detail });
  const samplingDescriptor = samplingModeDescriptor(samplingMode, {
    formalIntervalS: interval,
    diagnostic: meta,
  });
  const runId = resourceLiveRunId(run);
  const taskScript = resolveResourceScript({ run, detail, scripts, fallbackScriptId });

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 xl:grid-cols-[minmax(320px,0.95fr)_minmax(480px,1.05fr)] gap-4">
        {active
          ? <ResourceVideoScreen runId={runId} enabled deviceLabel={deviceLabel} />
          : <VideoUnavailable title="本轮测试已经结束" />}
        <div className="bg-zinc-900 border border-blue-500/25 rounded-xl p-4 space-y-4">
          <div className="flex items-center gap-3 flex-wrap">
            <span className={`text-xs rounded px-2 py-1 ${active ? "bg-blue-500/15 text-blue-400" : run?.status === "failed" ? "bg-red-500/15 text-red-400" : "bg-zinc-800 text-zinc-400"}`}>
              {active ? "● 正在测试" : phaseText(run?.status)}
            </span>
            <span className={`rounded px-2 py-1 text-[10px] ${samplingDescriptor.isRealtime ? "bg-cyan-500/15 text-cyan-300" : "bg-indigo-500/15 text-indigo-300"}`}>{samplingDescriptor.label}</span>
            <span className="text-xs text-zinc-500">{phaseText(live.phase || run?.status)}</span>
            <span className="ml-auto text-[10px] text-zinc-700 font-mono">{runId}</span>
          </div>

          <div>
            <div className="flex items-center justify-between text-xs mb-1.5">
              <span className="text-zinc-400">脚本采样进度</span>
              <span className="text-blue-400 font-mono">{sampleCount}/{expectedSamples ?? "—"} · {formatNumber(percent, 1)}%</span>
            </div>
            <div className="h-2 rounded bg-zinc-800 overflow-hidden"><div className="h-full bg-blue-500 transition-[width] duration-500" style={{ width: `${percent}%` }} /></div>
            <div className="text-[11px] text-zinc-600 mt-1">{samplingDescriptor.description} 实时数据只追加到当前 runId，并按本轮脚本 UI 快照渲染。</div>
          </div>

          <div className="rounded-lg border border-zinc-800 bg-zinc-950/60 px-3 py-2">
            <div className="flex items-center gap-2 text-[10px] text-zinc-600 mb-1">
              <span>当前性能测试脚本</span>
              <span className="ml-auto font-mono text-cyan-500">{taskScript?.id || run?.options?.scriptId || "确认中"}</span>
            </div>
            <div className="text-xs text-zinc-200">{taskScript?.name || "正在冻结脚本快照"}</div>
            <div className="mt-1 text-[10px] text-zinc-600">当前步骤</div>
            <div className="text-xs text-zinc-300 break-words">{currentStep}</div>
          </div>

          <div className="grid grid-cols-2 lg:grid-cols-4 gap-2">
            <InfoCard label="当前设备" value={serial || "确认中"} sub={[device.brand || meta.brand, device.model || meta.model].filter(Boolean).join(" ") || "以脚本预检冻结设备为准"} />
            <InfoCard label="已接收样本" value={`${sampleCount}/${expectedSamples ?? "—"}`} sub={latest ? `最近数据 t=${formatNumber(latest.target_elapsed_s)}s` : "等待脚本输出"} />
            <InfoCard label="正式采样间隔" value={`${formatNumber(interval)}s`} sub={samplingDescriptor.label} />
            <InfoCard label="当前阶段" value={phaseText(live.phase || run?.status)} sub="指标卡和图表由脚本清单声明" />
          </div>

          {(logs.length > 0 || run?.error) && (
            <div>
              <div className="text-[10px] text-zinc-600 mb-1">实时脚本日志</div>
              <pre className="max-h-36 overflow-auto rounded bg-zinc-950 border border-zinc-800 p-2 text-[10px] leading-relaxed text-zinc-500 whitespace-pre-wrap break-all">{logs.map((item) => item?.line || String(item)).join("\n")}{run?.error ? `\nERROR: ${run.error}` : ""}</pre>
            </div>
          )}
        </div>
      </div>
      <ScriptRunSections script={taskScript} run={run} detail={detail} active={active} scripts={scripts} fallbackScriptId={fallbackScriptId} />
    </div>
  );
}

function HistoricalRunPanel({ run, detail, scripts, fallbackScriptId }) {
  const profile = detail?.profile || detail?.resourceProfile || detail || {};
  const sampling = profile?.sampling || {};
  const flow = profile?.flow || {};
  const samplingMode = resolveSamplingMode({ run, detail });
  const samplingDescriptor = samplingModeDescriptor(samplingMode, {
    formalIntervalS: finiteNumber(sampling.interval_s) ?? 5,
    diagnostic: profile?.diagnostic,
  });
  const taskScript = resolveResourceScript({ run, detail, scripts, fallbackScriptId });
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 xl:grid-cols-[minmax(320px,0.95fr)_minmax(480px,1.05fr)] gap-4">
        <VideoUnavailable title="正在查看历史测试" />
        <div className="rounded-xl border border-zinc-800 bg-zinc-900 p-4 space-y-4">
          <div className="flex items-center gap-2 flex-wrap">
            <span className={`rounded px-2 py-1 text-xs ${acceptanceStyle(run?.acceptance || profile?.acceptance)}`}>{run?.acceptance || profile?.acceptance || "INCONCLUSIVE"}</span>
            <span className={`rounded px-2 py-1 text-[10px] ${samplingDescriptor.isRealtime ? "bg-cyan-500/15 text-cyan-300" : "bg-indigo-500/15 text-indigo-300"}`}>{samplingDescriptor.label}</span>
            <span className="text-xs text-zinc-500">上次/历史测试</span>
            <span className="ml-auto text-[10px] font-mono text-zinc-700">{run?.id || detail?.run?.id}</span>
          </div>
          <div className="grid grid-cols-2 lg:grid-cols-5 gap-2">
            <InfoCard label="测试设备" value={[run?.deviceBrand, run?.deviceModel].filter(Boolean).join(" ") || "未知设备"} sub={run?.deviceId || "未知序列号"} />
            <InfoCard label="本轮采样模式" value={samplingDescriptor.label} sub={samplingDescriptor.cadence} />
            <InfoCard label="采样行" value={`${sampling.actual_rows ?? getResourceSamples(detail).length}/${sampling.expected_rows ?? "—"}`} sub={`有效率 ${finiteNumber(sampling.valid_sample_ratio) === null ? "—" : `${formatNumber(Number(sampling.valid_sample_ratio) * 100)}%`}`} />
            <InfoCard label="脚本结果" value={flow.status || "未记录"} sub={flow.mode ? `流程模式 ${flow.mode}` : "以本轮冻结脚本为准"} />
            <InfoCard label="测试时间" value={run?.createdAt || "未知时间"} sub={`${run?.flavor || "未标车型"} · ${run?.appVersion || "未知版本"}`} />
          </div>
          <div className="rounded-lg border border-cyan-500/20 bg-cyan-500/5 px-3 py-2">
            <div className="text-[10px] text-zinc-600">本轮实际使用的脚本</div>
            <div className="mt-1 flex items-center gap-2 text-xs text-zinc-300"><span>{taskScript?.name || "旧轮次未记录脚本"}</span><span className="ml-auto font-mono text-[10px] text-zinc-600">{taskScript?.id || "legacy"}</span></div>
          </div>
          <div className="rounded-lg border border-zinc-800 bg-zinc-950/60 px-3 py-2 text-xs text-zinc-500">实时视频连接已经关闭；原始数据、流程事件和正式报表继续在下方保留。</div>
        </div>
      </div>
      <ScriptRunSections
        script={taskScript}
        run={{
          ...run,
          status: flow.status === "cancelled" ? "cancelled" : flow.status === "failed" ? "failed" : "completed",
          options: { ...(run?.options || {}), executeFlow: flow.mode !== "launch-only" },
          live: {},
        }}
        detail={detail}
        active={false}
        scripts={scripts}
        fallbackScriptId={fallbackScriptId}
      />
    </div>
  );
}

function DashboardView({ detail, section = null }) {
  const metrics = useMemo(() => buildWorkbookMetricRows(detail), [detail]);
  const samples = getResourceSamples(detail);
  const provisional = detail?.isLive === true;
  const collected = metrics.filter((item) => item.collected).length;
  const profile = detail?.profile || detail?.resourceProfile || detail || {};
  const sampling = detail?.sampling || profile.sampling || {};
  const flow = detail?.flow || profile.flow || {};
  const measurements = detail?.measurements || profile.measurements || {};
  const cpuCount = Array.isArray(measurements.logical_cpu_values) ? measurements.logical_cpu_values.join("/") : "—";
  const interval = finiteNumber(sampling.interval_s) ?? 5;
  const samplingMode = resolveSamplingMode({ detail });
  const samplingDescriptor = samplingModeDescriptor(samplingMode, {
    formalIntervalS: interval,
    diagnostic: profile?.diagnostic,
  });
  return (
    <div className="space-y-4">
      {provisional && (
        <div className="rounded-xl border border-blue-500/30 bg-blue-500/10 px-4 py-3 text-xs text-blue-300">
          当前轮次正在采集。图表、峰值和均值会随新样本实时更新；所有阈值状态均为暂态，最终结论以采集完成后的正式报表为准。
        </div>
      )}
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h3 className="text-sm font-medium text-zinc-300">{section?.title || "工作簿指标仪表盘"}</h3>
          <p className="text-xs text-zinc-600 mt-1">本轮已采集 {collected}/12 项；未接入采集的工作簿指标明确显示“未采集”。</p>
        </div>
        <span className={`rounded px-2 py-1 text-xs ${samplingDescriptor.isRealtime ? "bg-cyan-500/15 text-cyan-300" : "bg-indigo-500/15 text-indigo-300"}`}>本轮模式：{samplingDescriptor.label}</span>
        <div className="text-xs text-zinc-500">
          采样 {sampling.actual_rows ?? samples.length}/{sampling.expected_rows ?? "—"} · 有效率 {finiteNumber(sampling.valid_sample_ratio) === null ? "—" : `${formatNumber(Number(sampling.valid_sample_ratio) * 100)}%`} · 逻辑核 {cpuCount}
        </div>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
        {metrics.map((metric) => <MetricCard key={metric.key} metric={metric} provisional={provisional} />)}
      </div>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        <InfoCard label="流程状态" value={flow.status || "未记录"} sub={flow.download_install_completed ? "下载安装完成" : "下载安装未确认"} />
        <InfoCard label="二级菜单" value={`${Array.isArray(flow.menus_visited) ? flow.menus_visited.length : 0}/${flow.menus_configured ?? "—"}`} sub={(flow.menus_missing || []).length ? `缺失：${flow.menus_missing.join("、")}` : "无缺失记录"} />
        <InfoCard label="总体结论" value={provisional ? "采集中" : (detail?.acceptance || profile.acceptance || "INCONCLUSIVE")} sub={provisional ? "当前仅显示实时暂态，不提前判定整轮结果" : "由采样协议、指标、核数和流程检查共同决定"} />
      </div>
      {!provisional && samplingDescriptor.isRealtime && <RealtimeDiagnosticPanel detail={detail} />}
      <ResourceSampleChart
        title={samplingDescriptor.formalCpuTitle}
        unit="%"
        samples={samples}
        series={[
          { key: "cpu_device_normalized_pct", label: "单核口径 / 整机归一", color: "#f472b6" },
          { key: "cpu_one_core_equiv_pct", label: "多核累计 / 单核等效", color: "#22d3ee" },
        ]}
        thresholds={[
          { label: "单核峰值", value: 3.3, color: "#f472b6" },
          { label: "多核峰值", value: 16.5, color: "#22d3ee" },
        ]}
      />
      <ResourceSampleChart
        title={samplingDescriptor.formalMemoryTitle}
        unit="MiB"
        samples={samples}
        series={[
          { key: "pss_mb", label: "Total PSS", color: "#60a5fa" },
          { key: "rss_mb", label: "RSS（辅助）", color: "#a78bfa" },
        ]}
        thresholds={[{ label: "PSS 峰值", value: 190, color: "#60a5fa" }]}
      />
      <p className="text-xs text-zinc-600">PSS 均值目标 140MiB 仅用于整轮均值判定，不作为单个 {formatNumber(interval)} 秒采样点的阈值线。</p>
      <WorkbookCoverage metrics={metrics} />
    </div>
  );
}

function InfoCard({ label, value, sub }) {
  return (
    <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-3">
      <div className="text-xs text-zinc-600">{label}</div>
      <div className="text-sm text-zinc-300 mt-1 font-mono">{value}</div>
      <div className="text-[11px] text-zinc-600 mt-1">{sub}</div>
    </div>
  );
}

function formatRawCell(value) {
  if (value === null || value === undefined || value === "") return "—";
  if (Array.isArray(value)) return value.join(", ") || "—";
  if (typeof value === "object") return JSON.stringify(value);
  if (typeof value === "number") return formatNumber(value, 4);
  return String(value);
}

const RAW_COLUMNS = [
  ["sample_index", "序号"],
  ["target_elapsed_s", "目标秒"],
  ["actual_elapsed_s", "实际秒"],
  ["wall_time_local", "本地时间"],
  ["pids", "PIDs"],
  ["process_names", "进程"],
  ["logical_cpus", "核数"],
  ["cpu_device_normalized_pct", "CPU单核%"],
  ["cpu_one_core_equiv_pct", "CPU多核%"],
  ["pss_mb", "PSS MiB"],
  ["rss_mb", "RSS MiB"],
  ["process_set_changed", "进程变化"],
  ["collection_latency_s", "采集耗时s"],
  ["note", "备注"],
];

function artifactPath(artifact) {
  return artifact?.path || artifact?.relativePath || artifact?.name || "";
}

function isTextArtifact(artifact) {
  if (artifact?.previewable === false) return false;
  const path = artifactPath(artifact).toLowerCase();
  return artifact?.previewable === true || /\.(?:txt|log|json|jsonl|csv|md|xml|stderr)$/i.test(path);
}

function formatBytes(value) {
  const bytes = finiteNumber(value);
  if (bytes === null) return "大小未知";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
}

function appendQuery(url, params) {
  const separator = url.includes("?") ? "&" : "?";
  return `${url}${separator}${new URLSearchParams(params).toString()}`;
}

function artifactPreviewEndpoint(runId, artifact, offset) {
  const supplied = artifact?.previewUrl || artifact?.contentUrl;
  if (supplied) return apiUrl(appendQuery(supplied, { offset: String(offset), limit: String(TEXT_CHUNK_BYTES) }));
  return getApiUrl(`/api/performance/resource-runs/${encodeURIComponent(runId)}/artifact?${new URLSearchParams({ key: artifact?.key || "", offset: String(offset), limit: String(TEXT_CHUNK_BYTES) }).toString()}`);
}

function artifactDownloadEndpoint(runId, artifact) {
  const supplied = artifact?.downloadUrl || artifact?.url;
  if (supplied) return apiUrl(supplied);
  return getApiUrl(`/api/performance/resource-runs/${encodeURIComponent(runId)}/artifact?${new URLSearchParams({ key: artifact?.key || "", download: "1" }).toString()}`);
}

function ArtifactList({ runId, artifacts }) {
  const [previews, setPreviews] = useState({});
  useEffect(() => setPreviews({}), [runId]);

  async function loadChunk(artifact) {
    const key = artifactPath(artifact);
    const current = previews[key] || { text: "", nextOffset: 0, eof: false };
    setPreviews((previous) => ({ ...previous, [key]: { ...current, loading: true, error: "" } }));
    try {
      const response = await authenticatedFetch(artifactPreviewEndpoint(runId, artifact, current.nextOffset));
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const contentType = response.headers.get("content-type") || "";
      let content = "";
      let nextOffset = current.nextOffset;
      let eof = true;
      if (contentType.includes("application/json")) {
        const envelope = await response.json();
        const data = envelope?.data ?? envelope;
        content = String(data?.content ?? data?.text ?? "");
        nextOffset = finiteNumber(data?.nextOffset) ?? current.nextOffset + (finiteNumber(data?.bytesRead) ?? new TextEncoder().encode(content).length);
        eof = data?.truncated !== true && data?.eof !== false;
      } else {
        content = await response.text();
        const received = new TextEncoder().encode(content).length;
        nextOffset = current.nextOffset + received;
        eof = received < TEXT_CHUNK_BYTES;
      }
      setPreviews((previous) => ({
        ...previous,
        [key]: { text: `${current.text}${content}`, nextOffset, eof, loading: false, error: "" },
      }));
    } catch (error) {
      setPreviews((previous) => ({ ...previous, [key]: { ...current, loading: false, error: error.message } }));
    }
  }

  if (!artifacts.length) {
    return <div className="text-xs text-zinc-600 py-3">本轮没有可在线访问的产物清单；逐点样本仍已保存在上方表格。</div>;
  }
  return (
    <div className="space-y-2">
      {artifacts.map((artifact, index) => {
        const path = artifactPath(artifact);
        const preview = previews[path];
        const logcat = /(^|[\\/])logcat(?:\.|$)/i.test(path);
        return (
          <div key={`${path}-${index}`} className="border border-zinc-800 rounded-lg p-3">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-xs text-zinc-300">{artifact?.label || `产物 ${index + 1}`}</span>
              <span className="text-[10px] text-zinc-600 font-mono break-all">{path || `artifact-${index + 1}`}</span>
              <span className="text-[10px] text-zinc-600">{formatBytes(artifact?.size ?? artifact?.bytes)}</span>
              {isTextArtifact(artifact) && (
                <button
                  type="button"
                  disabled={preview?.loading || preview?.eof}
                  onClick={() => loadChunk(artifact)}
                  className="ml-auto text-xs bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-blue-400 disabled:opacity-40"
                >{preview?.loading ? "加载中…" : preview?.text ? (preview.eof ? "已加载全部" : "加载下一段") : (logcat ? "按需预览首段" : "预览首段")}</button>
              )}
              {artifact?.downloadable !== false && (
                <a href={artifactDownloadEndpoint(runId, artifact)} className={`${isTextArtifact(artifact) ? "" : "ml-auto"} text-xs bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-zinc-400 hover:text-zinc-200`}>
                  下载原文件
                </a>
              )}
            </div>
            {logcat && !preview?.text && <div className="text-[11px] text-zinc-600 mt-2">logcat 可能很大，默认不读取；点击后仅按 64KiB 分块预览。</div>}
            {preview?.error && <div className="text-xs text-red-400 mt-2">预览失败：{preview.error}</div>}
            {preview?.text && (
              <pre className="mt-2 max-h-72 overflow-auto bg-zinc-950 border border-zinc-800 rounded p-2 text-[11px] text-zinc-400 whitespace-pre-wrap break-all">{preview.text}</pre>
            )}
          </div>
        );
      })}
    </div>
  );
}

function RawDataView({ detail, run = {}, section = null }) {
  const samples = section?.source ? taskUiSourceRows(section, { run, detail }) : getResourceSamples(detail);
  const allArtifacts = Array.isArray(detail?.artifacts) ? detail.artifacts : [];
  const artifacts = section?.artifactKeys?.length
    ? section.artifactKeys.map((key) => allArtifacts.find((artifact) => artifact?.key === key)).filter(Boolean)
    : allArtifacts;
  const columns = section?.columns?.length
    ? section.columns
    : RAW_COLUMNS.map(([key, label]) => ({ key, label, unit: "", decimals: 2 }));
  const runId = detail?.run?.id || detail?.id || detail?.sessionId || detail?.session_id || "";
  const live = detail?.isLive === true;
  return (
    <div className="space-y-4">
      <div className="bg-zinc-900 border border-zinc-800 rounded-xl overflow-hidden">
        <div className="px-4 py-3 border-b border-zinc-800 flex items-center justify-between gap-3">
          <div>
            <h3 className="text-sm text-zinc-300">{section?.title || "逐点原始数据"}</h3>
            <p className="text-xs text-zinc-600 mt-1">{section?.description || `所选轮次当前共 ${samples.length} 行，不与其他轮次合并。${live ? " 新样本会实时追加。" : ""}`}</p>
          </div>
        </div>
        <div className="overflow-x-auto max-h-[32rem] overflow-y-auto">
          <table className="min-w-[1500px] w-full text-xs">
            <thead className="sticky top-0 bg-zinc-900 z-10">
              <tr className="text-zinc-500 text-left border-b border-zinc-800">
                {columns.map((column) => <th key={column.key} className="px-2 py-2 font-medium whitespace-nowrap">{column.label}{column.unit ? ` (${column.unit})` : ""}</th>)}
              </tr>
            </thead>
            <tbody>
              {samples.map((sample, index) => (
                <tr key={`${sample?.sample_index ?? index}-${sample?.target_elapsed_s ?? "x"}`} className="border-b border-zinc-800/70 hover:bg-zinc-800/30">
                  {columns.map((column) => <td key={column.key} className="px-2 py-1.5 text-zinc-400 font-mono whitespace-nowrap max-w-64 overflow-hidden text-ellipsis" title={formatRawCell(sample?.[column.key])}>{formatRawCell(sample?.[column.key])}</td>)}
                </tr>
              ))}
            </tbody>
          </table>
          {!samples.length && <div className="text-center text-sm text-zinc-600 py-10">{section?.emptyText || "本轮未返回逐点样本"}</div>}
        </div>
      </div>
      <details className="bg-zinc-900 border border-zinc-800 rounded-xl p-4">
        <summary className="text-xs text-zinc-400 cursor-pointer">查看逐点样本 JSON</summary>
        <pre className="mt-3 max-h-96 overflow-auto text-[11px] text-zinc-400 bg-zinc-950 rounded p-3 whitespace-pre-wrap break-all">{JSON.stringify(samples, null, 2)}</pre>
      </details>
      <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-4">
        <h3 className="text-sm text-zinc-300 mb-1">{section?.artifactKeys?.length ? "脚本声明的关联产物" : "原始产物"}</h3>
        <p className="text-xs text-zinc-600 mb-3">{live ? "采集结束后生成并挂载完整原始产物；逐点样本已在上方实时保留。" : "文本按 64KiB 分块加载；logcat 默认不自动预览，视频、图片和二进制文件直接下载。"}</p>
        <ArtifactList runId={runId} artifacts={artifacts} />
      </div>
    </div>
  );
}

function ArtifactsView({ detail, section }) {
  const allArtifacts = Array.isArray(detail?.artifacts) ? detail.artifacts : [];
  const artifacts = section?.artifactKeys?.length
    ? section.artifactKeys.map((key) => allArtifacts.find((artifact) => artifact?.key === key)).filter(Boolean)
    : allArtifacts;
  const runId = detail?.run?.id || detail?.id || detail?.sessionId || detail?.session_id || "";
  return (
    <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-4">
      <h3 className="text-sm text-zinc-300">{section?.title || section?.label || "脚本产物"}</h3>
      {section?.description && <p className="mt-1 mb-3 text-xs text-zinc-600">{section.description}</p>}
      <div className="mt-3"><ArtifactList runId={runId} artifacts={artifacts} /></div>
      {!artifacts.length && <div className="rounded-lg border border-zinc-800 px-3 py-8 text-center text-xs text-zinc-600">{section?.emptyText || "本轮尚未生成脚本声明的产物"}</div>}
    </div>
  );
}

function reportResultEntries(flow) {
  const source = flow && typeof flow === "object" && !Array.isArray(flow) ? flow : {};
  const priority = ["status", "mode"];
  const keys = [...priority, ...Object.keys(source).filter((key) => !priority.includes(key))];
  return [...new Set(keys)]
    .filter((key) => Object.hasOwn(source, key))
    .map((key) => {
      const value = source[key];
      if (value === null || ["string", "number", "boolean"].includes(typeof value)) {
        return { key, value };
      }
      if (Array.isArray(value) && value.length <= 40 && value.every((item) => item === null || ["string", "number", "boolean"].includes(typeof item))) {
        return { key, value: value.length ? value.join("、") : "—" };
      }
      return null;
    })
    .filter(Boolean)
    .slice(0, 12);
}

function reportResultLabel(key) {
  if (key === "status") return "状态";
  if (key === "mode") return "流程模式";
  return key;
}

function reportResultValue(value) {
  if (typeof value === "boolean") return value ? "是" : "否";
  return formatRawCell(value);
}

function ReportView({ detail, section = null }) {
  const profile = detail?.profile || detail?.resourceProfile || detail || {};
  const report = detail?.report || {};
  const markdown = report?.markdown ?? detail?.reportMarkdown ?? "";
  const checks = Array.isArray(detail?.checks) ? detail.checks : Array.isArray(profile?.checks) ? profile.checks : [];
  const flow = detail?.flow || profile?.flow || {};
  const warnings = Array.isArray(detail?.warnings) ? detail.warnings : Array.isArray(profile?.warnings) ? profile.warnings : [];
  const runId = detail?.run?.id || detail?.id || detail?.sessionId || detail?.session_id || "";
  const allArtifacts = Array.isArray(detail?.artifacts) ? detail.artifacts : [];
  const reportArtifactKeys = section?.artifactKeys?.length
    ? section.artifactKeys
    : ["report_pdf_summary", "report_pdf_detailed", "optimization_advice"];
  const reportArtifacts = reportArtifactKeys.map((key) => allArtifacts.find((artifact) => artifact?.key === key)).filter(Boolean);
  const flowEntries = reportResultEntries(flow);
  return (
    <div className="space-y-4">
      <div className="rounded-xl border border-cyan-500/20 bg-cyan-500/5 px-4 py-3">
        <h3 className="text-sm text-zinc-300">{section?.title || "采集报告"}</h3>
        {section?.description && <p className="mt-1 text-xs text-zinc-600">{section.description}</p>}
      </div>
      {detail?.isLive === true && (
        <div className="rounded-xl border border-blue-500/30 bg-blue-500/10 px-4 py-3 text-xs text-blue-300">当前轮次仍在采集，正式阈值检查与报表将在分析、上报完成后自动替换此暂态视图。</div>
      )}
      <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-4">
        <div className="flex items-center gap-2 mb-3">
          <h3 className="text-sm text-zinc-300">阈值检查</h3>
          <span className={`text-xs rounded px-2 py-0.5 ${acceptanceStyle(profile.acceptance)}`}>{profile.acceptance || "INCONCLUSIVE"}</span>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[760px] text-xs">
            <thead><tr className="text-zinc-500 text-left border-b border-zinc-800"><th className="py-2 pr-3">检查项</th><th className="pr-3">实测</th><th className="pr-3">要求</th><th>结果</th></tr></thead>
            <tbody>
              {checks.map((check, index) => (
                <tr key={check?.key || index} className="border-b border-zinc-800/70">
                  <td className="py-2 pr-3 text-zinc-300">{check?.label || check?.key || "—"}</td>
                  <td className="pr-3 text-zinc-400 font-mono">{formatRawCell(check?.actual)}{check?.unit || ""}</td>
                  <td className="pr-3 text-zinc-500 font-mono">{check?.comparison || ""} {formatRawCell(check?.limit)}{check?.unit || ""}</td>
                  <td><span className={`text-xs rounded px-1.5 py-0.5 ${statusStyle(String(check?.status || "").toLowerCase())}`}>{String(check?.status || "INCONCLUSIVE").toUpperCase()}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
          {!checks.length && <div className="text-sm text-zinc-600 py-8 text-center">本轮没有检查项</div>}
        </div>
      </div>
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-4">
          <h3 className="text-sm text-zinc-300 mb-2">脚本结果</h3>
          {flowEntries.length ? (
            <dl className="grid grid-cols-[minmax(7rem,auto)_minmax(0,1fr)] gap-x-3 gap-y-2 text-xs">
              {flowEntries.map((entry) => (
                <React.Fragment key={entry.key}>
                  <dt className="truncate font-mono text-zinc-600" title={entry.key}>{reportResultLabel(entry.key)}</dt>
                  <dd className="break-words text-zinc-300">{reportResultValue(entry.value)}</dd>
                </React.Fragment>
              ))}
            </dl>
          ) : <div className="text-xs text-zinc-600">本轮未提供结构化脚本结果</div>}
        </div>
        <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-4">
          <h3 className="text-sm text-zinc-300 mb-2">注意事项</h3>
          {warnings.length ? <ul className="text-xs text-amber-400/85 space-y-1 list-disc pl-4">{warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul> : <div className="text-xs text-zinc-600">无警告</div>}
        </div>
      </div>
      <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-4">
        <h3 className="text-sm text-zinc-300 mb-3">报告正文</h3>
        {markdown ? (
          // Markdown 未启用 rehypeRaw，报告中的原始 HTML 不会作为可执行 DOM 注入。
          <Markdown className="text-xs text-zinc-300 leading-relaxed">{markdown}</Markdown>
        ) : (
          <div className="text-sm text-zinc-600 py-8 text-center">本轮没有 Markdown 报告；上方结构化检查仍可查看。</div>
        )}
      </div>
      <div className="bg-zinc-900 border border-cyan-500/20 rounded-xl p-4">
        <h3 className="text-sm text-zinc-300">报告与分析产物</h3>
        <p className="mt-1 mb-3 text-xs text-zinc-600">此处只展示当前脚本在 task.json.ui.artifactKeys 中声明、且本轮实际生成的安全产物。</p>
        {reportArtifacts.length > 0
          ? <ArtifactList runId={runId} artifacts={reportArtifacts} />
          : <div className="rounded-lg border border-amber-500/20 bg-amber-500/10 px-3 py-3 text-xs text-amber-300">{section?.emptyText || "本轮尚未生成 PDF/优化建议；正在运行的轮次会在分析完成后自动出现。"}</div>}
      </div>
      <details className="bg-zinc-900 border border-zinc-800 rounded-xl p-4">
        <summary className="text-xs text-zinc-400 cursor-pointer">查看报告 JSON</summary>
        <pre className="mt-3 max-h-96 overflow-auto text-[11px] text-zinc-400 bg-zinc-950 rounded p-3 whitespace-pre-wrap break-all">{JSON.stringify(report?.json || profile, null, 2)}</pre>
      </details>
    </div>
  );
}

function JsonView({ detail, section }) {
  return (
    <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-4">
      <h3 className="text-sm text-zinc-300">{section?.title || section?.label || "结构化结果"}</h3>
      {section?.description && <p className="mt-1 text-xs text-zinc-600">{section.description}</p>}
      <pre className="mt-3 max-h-[42rem] overflow-auto rounded bg-zinc-950 p-3 text-[11px] text-zinc-400 whitespace-pre-wrap break-all">{JSON.stringify(detail, null, 2)}</pre>
    </div>
  );
}

function ScriptViewRenderer({ view, run, detail }) {
  if (!view) return null;
  if (view.kind === "dashboard") return <DashboardView detail={detail} section={view} />;
  if (view.kind === "live") return <ScriptLiveSection section={view} run={run} detail={detail} />;
  if (view.kind === "table") return <RawDataView detail={detail} run={run} section={view} />;
  if (view.kind === "artifacts") return <ArtifactsView detail={detail} section={view} />;
  if (view.kind === "report") return <ReportView detail={detail} section={view} />;
  if (view.kind === "json") return <JsonView detail={detail} section={view} />;
  return <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-xs text-amber-300">当前页面版本不支持区块类型：{view.kind}</div>;
}

function SummaryMetric({ label, value, sub, tone = "text-zinc-200" }) {
  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-900 p-4">
      <div className="text-xs text-zinc-600">{label}</div>
      <div className={`mt-2 text-2xl font-light font-mono ${tone}`}>{value}</div>
      <div className="mt-1 text-[11px] text-zinc-600">{sub}</div>
    </div>
  );
}

function ResourceRunOverview({ runs, active, onOpenTest, onSelect }) {
  const summary = useMemo(() => summarizeResourceRuns(runs), [runs]);
  const pct = (value) => finiteNumber(value) === null ? "—" : `${formatNumber(Number(value) * 100, 1)}%`;
  const metric = (value, unit) => finiteNumber(value) === null ? "—" : `${formatNumber(value)}${unit}`;
  const passWidth = summary.total ? summary.pass / summary.total * 100 : 0;
  const failWidth = summary.total ? summary.fail / summary.total * 100 : 0;
  return (
    <div className="space-y-4" data-testid="performance-overview">
      {active && (
        <div className="flex items-center gap-3 rounded-xl border border-blue-500/30 bg-blue-500/10 px-4 py-3 text-xs text-blue-300">
          <span>当前另有一轮性能测试正在执行；整体汇总只统计已经持久化的轮次。</span>
          <button type="button" onClick={onOpenTest} className="ml-auto rounded border border-blue-500/40 px-3 py-1 text-blue-300">进入实时测试</button>
        </div>
      )}
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h3 className="text-sm font-medium text-zinc-300">CPU / PSS 性能测试总览</h3>
          <p className="mt-1 text-xs text-zinc-600">汇总当前筛选下最近 {summary.total} 次持久化测试（最多 100 次）；跨轮只聚合轮次结果，不拼接原始采样点。</p>
        </div>
        {summary.latest && <div className="text-xs text-zinc-600">最近测试：<span className="text-zinc-400">{summary.latest.createdAt}</span></div>}
      </div>
      <div className="grid grid-cols-2 lg:grid-cols-4 2xl:grid-cols-8 gap-3">
        <SummaryMetric label="测试轮次" value={summary.total} sub={`PASS ${summary.pass} · FAIL ${summary.fail} · 其他 ${summary.other}`} />
        <SummaryMetric label="通过率" value={pct(summary.passRate)} sub="按轮次最终结论" tone={summary.passRate === null ? "text-zinc-500" : summary.passRate >= 0.8 ? "text-green-400" : "text-amber-400"} />
        <SummaryMetric label="平均有效采样率" value={pct(summary.averageValidSampleRatio)} sub="各轮有效率的算术平均" />
        <SummaryMetric label="单核峰值均值" value={metric(summary.cpuSinglePeakAverage, "%")} sub="各轮单核峰值的平均" />
        <SummaryMetric label="多核峰值均值" value={metric(summary.cpuMultiPeakAverage, "%")} sub="各轮多核峰值的平均" />
        <SummaryMetric label="CPU 均值的均值" value={metric(summary.cpuSingleMeanAverage, "%")} sub="各轮客户单核口径均值的平均" />
        <SummaryMetric label="PSS 峰值均值" value={metric(summary.pssPeakAverage, "MiB")} sub="各轮 PSS 峰值的平均" />
        <SummaryMetric label="PSS 均值的均值" value={metric(summary.pssMeanAverage, "MiB")} sub="各轮 PSS 均值的平均" />
      </div>
      <div className="rounded-xl border border-zinc-800 bg-zinc-900 p-4">
        <div className="flex items-center justify-between text-xs"><span className="text-zinc-400">结果分布</span><span className="text-zinc-600">{summary.total || 0} 次</span></div>
        <div className="mt-2 flex h-2 overflow-hidden rounded bg-zinc-800">
          <div className="bg-green-500" style={{ width: `${passWidth}%` }} />
          <div className="bg-red-500" style={{ width: `${failWidth}%` }} />
          <div className="bg-amber-500" style={{ width: `${Math.max(0, 100 - passWidth - failWidth)}%` }} />
        </div>
        <div className="mt-2 flex gap-4 text-[10px] text-zinc-600"><span className="text-green-400">● PASS {summary.pass}</span><span className="text-red-400">● FAIL {summary.fail}</span><span className="text-amber-400">● 其他 {summary.other}</span></div>
      </div>
      {summary.groups.length > 0 && (
        <div className="rounded-xl border border-zinc-800 bg-zinc-900 overflow-hidden">
          <div className="border-b border-zinc-800 px-4 py-3"><h4 className="text-sm text-zinc-300">按车型 · 版本汇总</h4></div>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[760px] text-xs">
              <thead><tr className="border-b border-zinc-800 text-left text-zinc-600"><th className="px-4 py-2">车型 · 版本</th><th>轮次</th><th>通过率</th><th>单核峰值均值</th><th>多核峰值均值</th><th>PSS峰值均值</th></tr></thead>
              <tbody>{summary.groups.slice(0, 12).map((group) => (
                <tr key={group.key} className="border-b border-zinc-800/60 text-zinc-400"><td className="px-4 py-2 text-zinc-300">{group.label}</td><td>{group.total}</td><td>{pct(group.passRate)}</td><td>{metric(group.cpuSinglePeakAverage, "%")}</td><td>{metric(group.cpuMultiPeakAverage, "%")}</td><td>{metric(group.pssPeakAverage, "MiB")}</td></tr>
              ))}</tbody>
            </table>
          </div>
        </div>
      )}
      {summary.recent.length > 0 && (
        <div className="rounded-xl border border-zinc-800 bg-zinc-900 overflow-hidden">
          <div className="border-b border-zinc-800 px-4 py-3"><h4 className="text-sm text-zinc-300">最近轮次快照</h4><p className="mt-1 text-xs text-zinc-600">点击某轮可在下方查看该次仪表盘、原始数据和报表。</p></div>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[980px] text-xs">
              <thead><tr className="border-b border-zinc-800 text-left text-zinc-600"><th className="px-4 py-2">时间</th><th>结果</th><th>车型/版本</th><th>有效率</th><th>单核峰值</th><th>多核峰值</th><th>PSS峰值</th><th></th></tr></thead>
              <tbody>{summary.recent.map((run) => (
                <tr key={run.id} className="border-b border-zinc-800/60 text-zinc-400"><td className="px-4 py-2 font-mono">{run.createdAt}</td><td><span className={`rounded px-1.5 py-0.5 ${acceptanceStyle(run.acceptance)}`}>{run.acceptance}</span></td><td>{run.flavor || "未标车型"} · {run.appVersion || "未知版本"}</td><td>{pct(run.validSampleRatio)}</td><td>{metric(run.cpuSinglePeak, "%")}</td><td>{metric(run.cpuMultiPeak, "%")}</td><td>{metric(run.pssPeak, "MiB")}</td><td><button type="button" onClick={() => onSelect(run.id)} className="rounded border border-zinc-700 px-2 py-1 text-blue-400">查看本轮</button></td></tr>
              ))}</tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

export function ResourceRunWorkspace({
  runs,
  selectedId,
  onSelect,
  liveRun,
  active,
  detail,
  loading,
  error,
  onRetry,
  mode = "summary",
  onOpenTest,
  scripts = [],
  selectedScriptId = "",
  onScriptChange,
  samplingMode = "standard",
  onSamplingModeChange,
  onStart,
  busy = false,
  configLoading = false,
  configError = "",
  onReloadScripts,
}) {
  const [view, setView] = useState("dashboard");
  const persistedOptions = Array.isArray(runs) ? runs.slice(0, 100) : [];
  const liveId = resourceLiveRunId(liveRun);
  const liveMeta = liveRun?.live?.meta && typeof liveRun.live.meta === "object" ? liveRun.live.meta : {};
  const liveDevice = liveMeta.device && typeof liveMeta.device === "object" ? liveMeta.device : {};
  const hasLiveRun = !!liveId && liveRun?.status !== "idle";
  const liveSummary = hasLiveRun ? {
    id: liveId,
    createdAt: liveRun?.startedAt || "正在启动",
    deviceBrand: liveDevice.brand || liveMeta.brand || "",
    deviceModel: liveDevice.model || liveMeta.model || "当前设备",
    deviceId: liveMeta.serial || liveRun?.options?.serial || "等待设备确认",
    flavor: liveRun?.options?.flavor || "",
    appVersion: "",
    acceptance: active ? "采集中" : (liveRun?.status === "completed" ? "待加载报表" : phaseText(liveRun?.status)),
    round: liveId,
  } : null;
  const options = liveSummary && !persistedOptions.some((run) => run.id === liveId)
    ? [liveSummary, ...persistedOptions].slice(0, 101)
    : persistedOptions;
  const selectedRun = options.find((run) => run.id === selectedId) || null;
  const selectedIsLive = hasLiveRun && selectedId === liveId;
  const liveDetail = useMemo(() => buildLiveResourceDetail(liveRun), [liveRun]);
  const selectedPersistedDetail = matchingResourceDetail(detail, selectedId);
  const useLiveDetail = shouldUseLiveResourceDetail(liveRun, selectedId, active, selectedPersistedDetail);
  const displayDetail = selectedId ? (useLiveDetail ? liveDetail : selectedPersistedDetail) : null;
  const displayError = useLiveDetail ? "" : error;
  const waitingForSelectedDetail = !!selectedRun && !useLiveDetail && !selectedPersistedDetail && !displayError;
  const displayLoading = !useLiveDetail && (loading || waitingForSelectedDetail);
  const viewedScript = resolveResourceScript({
    run: selectedIsLive ? liveRun : selectedRun,
    detail: displayDetail,
    scripts,
    fallbackScriptId: selectedIsLive ? selectedScriptId : "",
  });
  const viewedUi = useMemo(() => normalizeTaskUi(viewedScript), [viewedScript]);
  const viewedUiKey = `${viewedScript?.id || "legacy"}:${viewedUi.schemaVersion}:${viewedUi.views.map((item) => item.id).join(",")}`;
  const activeView = viewedUi.views.find((item) => item.id === view) || viewedUi.views.find((item) => item.id === viewedUi.defaultView) || viewedUi.views[0] || null;
  const viewedSamplingMode = resolveDisplayedSamplingMode({
    isLive: selectedIsLive,
    form: { samplingMode },
    run: selectedIsLive ? liveRun : selectedRun,
    detail: displayDetail,
  });
  const viewedSamplingDescriptor = samplingModeDescriptor(viewedSamplingMode, {
    formalIntervalS: finiteNumber(displayDetail?.profile?.sampling?.interval_s ?? liveMeta.interval_s) ?? 5,
    diagnostic: displayDetail?.profile?.diagnostic || liveMeta,
  });
  const scriptPicker = mode === "test" ? (
    <ResourceScriptPicker
      scripts={scripts}
      selectedScriptId={selectedScriptId}
      onScriptChange={onScriptChange}
      onStart={onStart}
      active={active}
      busy={busy}
      loading={configLoading}
      error={configError}
      onReload={onReloadScripts}
      liveRun={liveRun}
      samplingMode={samplingMode}
      onSamplingModeChange={onSamplingModeChange}
    />
  ) : null;

  useEffect(() => {
    setView((current) => (active && selectedIsLive
      ? chooseTaskUiView(viewedUi, viewedUi.defaultView)
      : chooseTaskUiView(viewedUi, current)));
  }, [active, liveId, selectedIsLive, viewedUiKey]);

  if (!options.length) {
    return (
      <div className="space-y-4">
        {scriptPicker}
        <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-8 text-center">
          <div className="text-sm text-zinc-500">暂无性能测试记录</div>
          <div className="text-xs text-zinc-600 mt-2">选择测试任务脚本后，可直接在上方开始第一轮性能测试。</div>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {scriptPicker}
      {mode === "summary" && <ResourceRunOverview runs={persistedOptions} active={active} onOpenTest={onOpenTest} onSelect={onSelect} />}
      <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-4 space-y-3">
        <div className="flex items-center gap-3 flex-wrap">
          <div>
            <h3 className="text-sm font-medium text-zinc-300">{mode === "test" ? "当前 / 上次性能测试" : "下钻指定性能轮次"}</h3>
            <p className="text-xs text-zinc-600 mt-1">{mode === "test" ? "运行中优先显示当前轮次；无运行则显示上次，也可切换历史。" : "整体数据在上方汇总；下方所有图表只读取所选 runId。"}</p>
          </div>
          <select
            value={selectedId}
            onChange={(event) => onSelect(event.target.value)}
            aria-label="性能测试轮次"
            className="ml-auto min-w-0 w-full lg:w-[36rem] text-xs bg-zinc-800 border border-zinc-700 rounded px-2 py-1.5 text-zinc-300"
          >
            {options.map((run) => <option key={run.id} value={run.id}>{runLabel(run)}</option>)}
          </select>
          <button type="button" onClick={onRetry} disabled={displayLoading || (selectedIsLive && active)} className="text-xs bg-zinc-800 border border-zinc-700 rounded px-3 py-1.5 text-zinc-400 disabled:opacity-40">{selectedIsLive && active ? "自动刷新中" : "刷新本轮"}</button>
        </div>
        {selectedRun && (
          <div className="flex items-center gap-3 flex-wrap text-xs text-zinc-500">
            <span className={`rounded px-2 py-0.5 ${selectedRun.acceptance === "PASS" ? "bg-green-500/15 text-green-400" : selectedRun.acceptance === "FAIL" ? "bg-red-500/15 text-red-400" : selectedIsLive && active ? "bg-blue-500/15 text-blue-400" : "bg-amber-500/15 text-amber-400"}`}>{selectedRun.acceptance || "INCONCLUSIVE"}</span>
            <span>{selectedRun.deviceBrand} {selectedRun.deviceModel}</span>
            <span>{selectedRun.deviceId || "未知序列号"}</span>
            <span>{selectedRun.flavor || "未标车型"} · {selectedRun.appVersion || "未知版本"}</span>
            {(selectedIsLive || displayDetail) && <span className={`rounded px-2 py-0.5 ${viewedSamplingDescriptor.isRealtime ? "bg-cyan-500/15 text-cyan-300" : "bg-indigo-500/15 text-indigo-300"}`}>采样模式：{viewedSamplingDescriptor.label}</span>}
            <span className="text-cyan-500">脚本：{viewedScript?.name || (displayLoading ? "正在加载快照" : "旧轮次未记录")}</span>
            <span className="font-mono ml-auto">{selectedRun.round || selectedRun.id}</span>
          </div>
        )}
      </div>

      {mode === "test" && active && !selectedIsLive && (
        <div className="flex items-center gap-3 rounded-xl border border-blue-500/30 bg-blue-500/10 px-4 py-3 text-xs text-blue-300">当前还有一轮测试正在执行；你正在查看历史轮次。<button type="button" onClick={() => onSelect(liveId)} className="ml-auto rounded border border-blue-500/40 px-3 py-1">回到实时</button></div>
      )}

      {mode === "test" && selectedIsLive && <LiveRunPanel run={liveRun} active={active} detail={displayDetail} scripts={scripts} fallbackScriptId={selectedScriptId} />}
      {mode === "test" && !selectedIsLive && !displayLoading && !displayError && displayDetail && <HistoricalRunPanel run={selectedRun} detail={displayDetail} scripts={scripts} />}

      {viewedUi.warning && <div className="rounded-lg border border-amber-500/25 bg-amber-500/10 px-3 py-2 text-xs text-amber-300">{viewedUi.warning}</div>}
      <div className="flex gap-1 border-b border-zinc-800 overflow-x-auto">
        {viewedUi.views.map((item) => (
          <button key={item.id} type="button" onClick={() => setView(item.id)} data-testid={`script-ui-view-${item.id}`} className={`px-4 py-2 text-sm whitespace-nowrap border-b-2 -mb-px ${activeView?.id === item.id ? "border-blue-500 text-zinc-100" : "border-transparent text-zinc-500 hover:text-zinc-300"}`}>{item.label}</button>
        ))}
      </div>

      {displayLoading && <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-12 text-center text-sm text-zinc-500">正在加载所选轮次…</div>}
      {!displayLoading && displayError && (
        <div className="bg-red-500/10 border border-red-500/30 rounded-xl p-5 text-sm text-red-400 flex items-center gap-3">
          <span>加载失败：{displayError}</span>
          <button type="button" onClick={onRetry} className="ml-auto text-xs border border-red-500/40 rounded px-3 py-1">重试</button>
        </div>
      )}
      {!displayLoading && !displayError && !displayDetail && <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-12 text-center text-sm text-zinc-600">该轮没有详情数据</div>}
      {!displayLoading && !displayError && displayDetail && <ScriptViewRenderer view={activeView} run={selectedIsLive ? liveRun : selectedRun} detail={displayDetail} />}
    </div>
  );
}

export default function ResourcePerformanceTab(props) {
  return <ResourceRunWorkspace {...props} mode="summary" />;
}
