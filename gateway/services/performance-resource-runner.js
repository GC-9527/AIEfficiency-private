import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { fileURLToPath } from "node:url";
import { emitPerformanceResourceWs, log } from "./logger.js";
import {
  getPerformanceResourceConfig,
  selectPerformanceResourceScript,
  summarizePerformanceResourceFlow,
} from "./performance-resource-config.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "..", "..");
const DEFAULT_RUNNER = path.join(
  REPO_ROOT,
  "features",
  "PerformanceFeature",
  "performance-test-scripts",
  "tasks",
  "android",
  "appmarket-cpu-memory",
  "runner.py",
);
const TEMP_ROOT = path.join(REPO_ROOT, "docs", "tempFiles", "appmarket-performance");
const CONTROL_ROOT = path.join(TEMP_ROOT, "control");
const MAX_LIVE_SAMPLES = 3600;
const MAX_DIAGNOSTIC_SAMPLES = 1200;
const MAX_CHANNEL_EVENTS = 600;
const MAX_LIVE_STEPS = 240;
const MAX_LIVE_JSON_BYTES = 64 * 1024;
const MAX_PENDING_LINE_BYTES = 256 * 1024;
const MAX_RUNNER_LOG_BYTES = 16 * 1024 * 1024;
const WINDOWS_FORCED_EXIT_CODE = 0xFFFFFFFF;

const LIVE_SAMPLE_KEYS = [
  "sample_index", "target_elapsed_s", "actual_elapsed_s", "wall_time_local",
  "pids", "process_names", "logical_cpus", "cpu_one_core_equiv_pct",
  "cpu_device_normalized_pct", "pss_mb", "rss_mb", "process_set_changed",
  "collection_latency_s", "note",
];
const LIVE_SAMPLE_STRING_KEYS = new Set(["wall_time_local", "pids", "process_names", "note"]);
const DIAGNOSTIC_SAMPLE_KEYS = [
  "diagnostic_index", "target_elapsed_s", "actual_elapsed_s", "source_timestamp_s",
  "cpu_window_duration_s", "rss_source_timestamp_s", "wall_time_local", "pids",
  "process_names", "logical_cpus", "cpu_one_core_equiv_pct",
  "cpu_device_normalized_pct", "rss_mb", "pss_mb", "collection_latency_s",
  "metric_source", "rss_fresh", "note",
];
const DIAGNOSTIC_SAMPLE_STRING_KEYS = new Set([
  "wall_time_local", "pids", "process_names", "metric_source", "note",
]);
const DIAGNOSTIC_SAMPLE_BOOLEAN_KEYS = new Set(["rss_fresh"]);
const SAMPLING_MODES = new Set(["standard", "realtime"]);

function createLiveState(runId = null, options = {}) {
  const duration = Number(options.duration);
  const interval = Number(options.interval);
  const expectedSamples = Number.isFinite(duration) && Number.isFinite(interval) && interval > 0
    ? Math.min(MAX_LIVE_SAMPLES, Math.max(0, Math.round(duration / interval)))
    : 0;
  const samplingMode = SAMPLING_MODES.has(options.samplingMode) ? options.samplingMode : "standard";
  return {
    phase: runId ? "starting" : "idle",
    meta: runId ? {
      runId,
      script_id: String(options.scriptId || ""),
      requested_serial: String(options.serial || ""),
      duration_s: Number.isFinite(duration) ? duration : null,
      interval_s: Number.isFinite(interval) ? interval : null,
      sampling_mode: samplingMode,
      expected_samples: expectedSamples,
      phase: "starting",
    } : {},
    samples: [],
    diagnosticSamples: [],
    diagnosticTotalCount: 0,
    channelEvents: [],
    progress: {
      sampleCount: 0,
      expectedSamples,
      percent: 0,
      lastTargetElapsedS: null,
      durationS: Number.isFinite(duration) ? duration : null,
      intervalS: Number.isFinite(interval) ? interval : null,
    },
    currentStep: null,
    stepSequence: 0,
    stepHistory: [],
  };
}

const state = {
  status: "idle",
  running: false,
  runId: null,
  startedAt: null,
  completedAt: null,
  options: null,
  exitCode: null,
  exitSignal: null,
  error: null,
  resultJson: null,
  artifactDir: null,
  uploadStatus: null,
  configPath: null,
  runnerLog: null,
  configSnapshot: null,
  logs: [],
  stopRequested: false,
  live: createLiveState(),
};

let child = null;
let stopFile = null;
let killTimer = null;
let lineBuffers = { stdout: "", stderr: "" };
let streamDecoders = { stdout: new StringDecoder("utf8"), stderr: new StringDecoder("utf8") };
let runnerLogPath = null;
let runnerLogBytes = 0;
let runnerLogTruncated = false;

function safeText(value, maxLength = 120) {
  return String(value ?? "").trim().slice(0, maxLength);
}

function safeArgumentText(value, maxLength = 120) {
  const text = String(value ?? "");
  if (/\0|[\r\n]/.test(text)) throw new Error("文本参数不能包含换行或 NUL 字符");
  return safeText(text, maxLength);
}

export function validateResourceRunOptions(raw = {}) {
  const serial = safeArgumentText(raw.serial, 128);
  const flavor = safeArgumentText(raw.flavor, 80);
  const packageName = safeArgumentText(raw.package ?? "com.appmarket.automotive", 160);
  const duration = Number(raw.duration ?? 180);
  const interval = Number(raw.interval ?? 5);
  const samplingMode = safeArgumentText(raw.samplingMode ?? "standard", 20);
  if (serial && !/^[A-Za-z0-9._:-]+$/.test(serial)) throw new Error("adb 序列号包含不支持的字符");
  if (flavor && !/^[A-Za-z0-9_.-]+$/.test(flavor)) throw new Error("车型/flavor 包含不支持的字符");
  if (!/^[A-Za-z0-9_.]+$/.test(packageName)) throw new Error("包名格式无效");
  if (!Number.isFinite(duration) || duration < 5 || duration > 3600) throw new Error("采样时长必须在 5~3600 秒之间");
  if (!Number.isFinite(interval) || interval < 1 || interval > 60) throw new Error("采样间隔必须在 1~60 秒之间");
  if (!SAMPLING_MODES.has(samplingMode)) throw new Error("采样模式必须是 standard 或 realtime");
  if (samplingMode === "realtime" && Math.abs(interval - 5) > 1e-9) {
    throw new Error("实时诊断的正式 CPU/PSS 采样间隔必须为 5 秒");
  }
  if (Math.abs(duration / interval - Math.round(duration / interval)) > 1e-9) {
    throw new Error("采样时长必须是采样间隔的整数倍");
  }
  return {
    serial,
    flavor,
    package: packageName,
    duration,
    interval,
    samplingMode,
    executeFlow: raw.executeFlow !== false,
    captureScreenrecord: raw.captureScreenrecord !== false,
    capturePerfetto: samplingMode === "realtime" || raw.capturePerfetto === true,
    testAppTitle: safeArgumentText(raw.testAppTitle, 120),
  };
}

export function buildResourceRunnerArgs(options, runId, stopPath, gatewayUrl, configPath = "", selectedRunner = "") {
  const runner = performanceResourceTestOverridesEnabled() && process.env.APPMARKET_PERF_RUNNER
    ? path.resolve(process.env.APPMARKET_PERF_RUNNER)
    : (selectedRunner || DEFAULT_RUNNER);
  const args = [
    runner,
    "--non-interactive",
    "--run-id", runId,
    "--stop-file", stopPath,
    "--package", options.package,
    "--duration", String(options.duration),
    "--interval", String(options.interval),
    "--flow-mode", options.executeFlow ? "full" : "launch-only",
    "--gateway", gatewayUrl,
  ];
  if (options.serial) args.push("--serial", options.serial);
  if (options.flavor) args.push("--flavor", options.flavor);
  if (options.testAppTitle) args.push("--test-app-title", options.testAppTitle);
  if (configPath) args.push("--config", configPath);
  if (options.captureScreenrecord) args.push("--capture-screenrecord");
  if (options.samplingMode === "realtime") args.push("--sampling-mode", "realtime");
  if (options.capturePerfetto || options.samplingMode === "realtime") args.push("--capture-perfetto");
  return args;
}

function finiteLiveNumber(value) {
  if (value === null) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function sanitizeLiveSample(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const sampleIndex = Number(raw.sample_index);
  if (!Number.isSafeInteger(sampleIndex) || sampleIndex < 1 || sampleIndex > 1_000_000) return null;
  const sample = { sample_index: sampleIndex };
  for (const key of LIVE_SAMPLE_KEYS) {
    if (key === "sample_index" || !Object.hasOwn(raw, key)) continue;
    if (LIVE_SAMPLE_STRING_KEYS.has(key)) {
      sample[key] = String(raw[key] ?? "").slice(0, 2000);
      continue;
    }
    const number = finiteLiveNumber(raw[key]);
    sample[key] = number;
  }
  if (sample.logical_cpus !== null && sample.logical_cpus !== undefined) {
    sample.logical_cpus = Math.trunc(sample.logical_cpus);
  }
  if (sample.process_set_changed !== null && sample.process_set_changed !== undefined) {
    sample.process_set_changed = Math.trunc(sample.process_set_changed);
  }
  return sample;
}

export function mergeResourceLiveSample(samples, raw, limit = MAX_LIVE_SAMPLES) {
  const sample = sanitizeLiveSample(raw);
  const safeLimit = Math.max(1, Math.min(MAX_LIVE_SAMPLES, Math.trunc(Number(limit) || MAX_LIVE_SAMPLES)));
  if (!sample) return { samples: Array.isArray(samples) ? [...samples] : [], sample: null };
  const byIndex = new Map();
  for (const existing of Array.isArray(samples) ? samples : []) {
    const normalized = sanitizeLiveSample(existing);
    if (normalized) byIndex.set(normalized.sample_index, normalized);
  }
  byIndex.set(sample.sample_index, sample);
  const merged = [...byIndex.values()]
    .sort((left, right) => left.sample_index - right.sample_index)
    .slice(-safeLimit);
  return { samples: merged, sample };
}

function sanitizeDiagnosticSample(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const diagnosticIndex = Number(raw.diagnostic_index);
  if (!Number.isSafeInteger(diagnosticIndex) || diagnosticIndex < 1 || diagnosticIndex > 1_000_000) {
    return null;
  }
  const sample = { diagnostic_index: diagnosticIndex };
  for (const key of DIAGNOSTIC_SAMPLE_KEYS) {
    if (key === "diagnostic_index" || !Object.hasOwn(raw, key)) continue;
    if (DIAGNOSTIC_SAMPLE_STRING_KEYS.has(key)) {
      sample[key] = String(raw[key] ?? "").slice(0, 2000);
    } else if (DIAGNOSTIC_SAMPLE_BOOLEAN_KEYS.has(key)) {
      sample[key] = raw[key] === true;
    } else {
      sample[key] = finiteLiveNumber(raw[key]);
    }
  }
  if (sample.logical_cpus !== null && sample.logical_cpus !== undefined) {
    sample.logical_cpus = Math.trunc(sample.logical_cpus);
  }
  return sample;
}

export function mergeResourceDiagnosticSample(
  samples,
  raw,
  totalCount = 0,
  limit = MAX_DIAGNOSTIC_SAMPLES,
) {
  const sample = sanitizeDiagnosticSample(raw);
  const safeTotalCount = Math.max(0, Math.trunc(Number(totalCount) || 0));
  const safeLimit = Math.max(
    1,
    Math.min(MAX_DIAGNOSTIC_SAMPLES, Math.trunc(Number(limit) || MAX_DIAGNOSTIC_SAMPLES)),
  );
  if (!sample) {
    return {
      samples: Array.isArray(samples) ? [...samples] : [],
      sample: null,
      totalCount: safeTotalCount,
      inserted: false,
    };
  }
  const byIndex = new Map();
  for (const existing of Array.isArray(samples) ? samples : []) {
    const normalized = sanitizeDiagnosticSample(existing);
    if (normalized) byIndex.set(normalized.diagnostic_index, normalized);
  }
  const inserted = sample.diagnostic_index > safeTotalCount;
  byIndex.set(sample.diagnostic_index, sample);
  const merged = [...byIndex.values()]
    .sort((left, right) => left.diagnostic_index - right.diagnostic_index)
    .slice(-safeLimit);
  return {
    samples: merged,
    sample,
    totalCount: Math.max(safeTotalCount, sample.diagnostic_index),
    inserted,
  };
}

function sanitizeChannelEvent(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const channel = safeText(raw.channel, 80);
  const sequence = Number(raw.sequence ?? raw.seq);
  if (!/^[A-Za-z][A-Za-z0-9_.-]{0,79}$/.test(channel)) return null;
  if (!Number.isSafeInteger(sequence) || sequence < 1 || sequence > 10_000_000) return null;
  const sourceValues = raw.values ?? raw.payload ?? raw.record;
  if (!sourceValues || typeof sourceValues !== "object" || Array.isArray(sourceValues)) return null;
  const values = {};
  for (const [key, value] of Object.entries(sourceValues).slice(0, 40)) {
    if (!/^[A-Za-z][A-Za-z0-9_.-]{0,79}$/.test(key)) continue;
    if (typeof value === "number") values[key] = Number.isFinite(value) ? value : null;
    else if (typeof value === "string") values[key] = value.slice(0, 500);
    else if (typeof value === "boolean" || value === null) values[key] = value;
  }
  if (!Object.keys(values).length) return null;
  const runId = safeText(raw.runId ?? raw.run_id, 128);
  const elapsed = finiteLiveNumber(raw.elapsed_s ?? raw.elapsedS);
  return {
    schema_version: 1,
    channel,
    sequence,
    ...(runId ? { runId } : {}),
    ...(elapsed !== null && elapsed >= 0 && elapsed <= 86_400 ? { elapsed_s: elapsed } : {}),
    ...(raw.at || raw.time ? { at: safeText(raw.at ?? raw.time, 80) } : {}),
    ...(raw.message ? { message: safeText(raw.message, 500) } : {}),
    values,
  };
}

export function mergeResourceChannelEvent(events, raw, limit = MAX_CHANNEL_EVENTS) {
  const event = sanitizeChannelEvent(raw);
  const bounded = Math.max(1, Math.min(MAX_CHANNEL_EVENTS, Math.trunc(Number(limit) || MAX_CHANNEL_EVENTS)));
  if (!event) return { events: Array.isArray(events) ? [...events] : [], event: null };
  const byKey = new Map();
  for (const existing of Array.isArray(events) ? events : []) {
    const normalized = sanitizeChannelEvent(existing);
    if (normalized) byKey.set(`${normalized.channel}:${normalized.sequence}`, normalized);
  }
  byKey.set(`${event.channel}:${event.sequence}`, event);
  return {
    events: [...byKey.values()]
      .sort((left, right) => left.sequence - right.sequence || left.channel.localeCompare(right.channel))
      .slice(-bounded),
    event,
  };
}

function parseLiveJson(line, marker, kind) {
  const normalized = line.startsWith("[sample] ") ? line.slice("[sample] ".length) : line;
  if (!normalized.startsWith(marker)) return null;
  const source = normalized.slice(marker.length);
  if (!source || Buffer.byteLength(source, "utf8") > MAX_LIVE_JSON_BYTES) return { kind: "invalid" };
  try {
    const value = JSON.parse(source);
    return value && typeof value === "object" && !Array.isArray(value)
      ? { kind, value }
      : { kind: "invalid" };
  } catch {
    return { kind: "invalid" };
  }
}

export function parseResourceLiveLine(line) {
  const text = String(line || "").replace(/\r$/, "");
  const sample = parseLiveJson(text, "LIVE_SAMPLE_JSON=", "sample");
  if (sample) return sample;
  const diagnostic = parseLiveJson(text, "LIVE_DIAGNOSTIC_JSON=", "diagnostic");
  if (diagnostic) return diagnostic;
  const channelEvent = parseLiveJson(text, "LIVE_EVENT_JSON=", "event");
  if (channelEvent) return channelEvent;
  const meta = parseLiveJson(text, "LIVE_META_JSON=", "meta");
  if (meta) return meta;
  const flow = text.match(/^\[flow\]\s+([^:]{1,160}):\s+([^\s]{1,80})\s+-\s+(.*)$/);
  if (flow) {
    return {
      kind: "step",
      value: {
        step: flow[1].trim(),
        status: flow[2].trim(),
        message: flow[3].slice(0, 2000),
      },
    };
  }
  return null;
}

function sanitizeRecord(raw, allowedKeys) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const result = {};
  for (const key of allowedKeys) {
    if (!Object.hasOwn(raw, key)) continue;
    const value = raw[key];
    if (["string", "number", "boolean"].includes(typeof value) || value === null) {
      result[key] = typeof value === "string" ? value.slice(0, 500) : value;
    }
  }
  return result;
}

function sanitizeLiveMeta(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const meta = {};
  const runId = safeText(raw.runId ?? raw.run_id, 128);
  if (runId) meta.runId = runId;
  const serial = safeText(raw.serial, 128);
  if (serial && /^[A-Za-z0-9._:-]+$/.test(serial)) meta.serial = serial;
  for (const [source, target, maximum] of [
    ["duration_s", "duration_s", 3600],
    ["interval_s", "interval_s", 60],
    ["expected_samples", "expected_samples", MAX_LIVE_SAMPLES],
    ["schema_version", "schema_version", 100],
    ["cpu_interval_ms", "cpu_interval_ms", 60_000],
    ["rss_interval_ms", "rss_interval_ms", 60_000],
    ["pss_interval_ms", "pss_interval_ms", 60_000],
  ]) {
    if (!Object.hasOwn(raw, source)) continue;
    const number = finiteLiveNumber(raw[source]);
    if (number !== null && number >= 0 && number <= maximum) meta[target] = number;
  }
  for (const key of ["package", "flavor", "phase", "acceptance", "upload_status", "error"]) {
    if (Object.hasOwn(raw, key)) meta[key] = safeText(raw[key], key === "error" ? 2000 : 160);
  }
  if (Object.hasOwn(raw, "sampling_mode")) {
    const samplingMode = safeText(raw.sampling_mode, 20);
    if (SAMPLING_MODES.has(samplingMode)) meta.sampling_mode = samplingMode;
  }
  if (raw.artifact_dir) meta.artifact_dir = normalizeRepoRelative(raw.artifact_dir);
  const device = sanitizeRecord(raw.device, ["serial", "model", "brand", "product", "android_version", "sdk", "logical_cpus"]);
  const app = sanitizeRecord(raw.app, ["package", "version_name", "version_code", "first_install_time", "last_update_time"]);
  if (device) meta.device = device;
  if (app) meta.app = app;
  return meta;
}

function updateLiveProgress() {
  const samples = state.live.samples;
  const meta = state.live.meta;
  const expectedSamples = Math.min(
    MAX_LIVE_SAMPLES,
    Math.max(0, Math.round(Number(meta.expected_samples ?? state.live.progress.expectedSamples) || 0)),
  );
  const lastSample = samples.at(-1) || null;
  const sampleCount = samples.length;
  state.live.progress = {
    sampleCount,
    expectedSamples,
    percent: expectedSamples ? Math.min(100, Math.round((sampleCount / expectedSamples) * 1000) / 10) : 0,
    lastTargetElapsedS: lastSample ? finiteLiveNumber(lastSample.target_elapsed_s) : null,
    durationS: finiteLiveNumber(meta.duration_s ?? state.live.progress.durationS),
    intervalS: finiteLiveNumber(meta.interval_s ?? state.live.progress.intervalS),
  };
}

function publicLiveState() {
  const meta = {
    ...state.live.meta,
    ...(state.live.meta.device ? { device: { ...state.live.meta.device } } : {}),
    ...(state.live.meta.app ? { app: { ...state.live.meta.app } } : {}),
  };
  return {
    phase: state.live.phase,
    meta,
    samples: state.live.samples.map((sample) => ({ ...sample })),
    diagnosticSamples: state.live.diagnosticSamples.map((sample) => ({ ...sample })),
    diagnosticTotalCount: state.live.diagnosticTotalCount,
    channelEvents: state.live.channelEvents.map((event) => ({ ...event, values: { ...event.values } })),
    progress: { ...state.live.progress },
    currentStep: state.live.currentStep ? { ...state.live.currentStep } : null,
    stepHistory: state.live.stepHistory.map((step) => ({ ...step })),
  };
}

function emitLive(kind, data = {}) {
  emitPerformanceResourceWs("performance_resource_live", {
    kind,
    runId: state.runId,
    phase: state.live.phase,
    ...data,
  });
}

function appendPublicLog(line, stream) {
  state.logs.push({ at: new Date().toISOString(), stream, line: line.slice(0, 1000) });
  if (state.logs.length > 200) state.logs.splice(0, state.logs.length - 200);
}

function appendRunnerLog(line, stream = "runner") {
  if (!runnerLogPath || runnerLogTruncated) return;
  const record = `[${new Date().toISOString()}] [${stream}] ${String(line || "").replace(/[\r\n]+$/g, "")}\n`;
  const bytes = Buffer.byteLength(record, "utf8");
  try {
    if (runnerLogBytes + bytes > MAX_RUNNER_LOG_BYTES) {
      const marker = `[${new Date().toISOString()}] [gateway] runner log truncated at ${MAX_RUNNER_LOG_BYTES} bytes\n`;
      fs.appendFileSync(runnerLogPath, marker, "utf8");
      runnerLogBytes += Buffer.byteLength(marker, "utf8");
      runnerLogTruncated = true;
      return;
    }
    fs.appendFileSync(runnerLogPath, record, "utf8");
    runnerLogBytes += bytes;
  } catch {
    // Logging must not crash a device run. The public state still retains the
    // bounded in-memory tail and the gateway service log records final status.
  }
}

function handleOutputLine(rawLine, stream) {
  const line = String(rawLine || "").replace(/\r$/, "");
  if (!line) return;
  appendRunnerLog(line, stream);
  const parsed = parseResourceLiveLine(line);
  if (parsed?.kind === "sample") {
    const merged = mergeResourceLiveSample(state.live.samples, parsed.value);
    if (merged.sample) {
      state.live.samples = merged.samples;
      if (state.status !== "stopping") state.live.phase = "collecting";
      updateLiveProgress();
      emitLive("sample", {
        sample: { ...merged.sample },
        progress: { ...state.live.progress },
      });
    }
    return;
  }
  if (parsed?.kind === "diagnostic") {
    const merged = mergeResourceDiagnosticSample(
      state.live.diagnosticSamples,
      parsed.value,
      state.live.diagnosticTotalCount,
    );
    if (merged.sample) {
      state.live.diagnosticSamples = merged.samples;
      state.live.diagnosticTotalCount = merged.totalCount;
      if (state.status !== "stopping") state.live.phase = "collecting";
      emitLive("diagnostic", {
        diagnosticSample: { ...merged.sample },
        diagnosticTotalCount: merged.totalCount,
      });
    }
    return;
  }
  if (parsed?.kind === "event") {
    const merged = mergeResourceChannelEvent(state.live.channelEvents, parsed.value);
    if (merged.event && (!merged.event.runId || merged.event.runId === state.runId)) {
      state.live.channelEvents = merged.events;
      if (state.status !== "stopping") state.live.phase = "collecting";
      emitLive("event", { channelEvent: { ...merged.event, values: { ...merged.event.values } } });
    }
    return;
  }
  if (parsed?.kind === "meta") {
    const meta = sanitizeLiveMeta(parsed.value);
    if (!meta || (meta.runId && meta.runId !== state.runId)) return;
    const frozenSerial = state.live.meta.serial;
    if (frozenSerial && meta.serial && frozenSerial !== meta.serial) delete meta.serial;
    state.live.meta = { ...state.live.meta, ...meta, runId: state.runId };
    if (meta.artifact_dir) state.artifactDir = meta.artifact_dir;
    if (meta.phase && state.status !== "stopping") state.live.phase = meta.phase;
    state.live.meta.phase = state.live.phase;
    updateLiveProgress();
    emitLive("meta", {
      meta: { ...state.live.meta },
      progress: { ...state.live.progress },
    });
    return;
  }
  if (parsed?.kind === "step") {
    state.live.stepSequence += 1;
    state.live.currentStep = {
      ...parsed.value,
      sequence: state.live.stepSequence,
      at: new Date().toISOString(),
    };
    state.live.stepHistory.push(state.live.currentStep);
    if (state.live.stepHistory.length > MAX_LIVE_STEPS) {
      state.live.stepHistory.splice(0, state.live.stepHistory.length - MAX_LIVE_STEPS);
    }
    emitLive("step", {
      currentStep: { ...state.live.currentStep },
      stepEvent: { ...state.live.currentStep },
    });
  }

  appendPublicLog(line, stream);
  if (stream !== "stdout") return;
  if (line.startsWith("RESULT_JSON=")) state.resultJson = normalizeRepoRelative(line.slice("RESULT_JSON=".length));
  else if (line.startsWith("ARTIFACT_DIR=")) state.artifactDir = normalizeRepoRelative(line.slice("ARTIFACT_DIR=".length));
  else if (line.startsWith("UPLOAD=")) {
    state.uploadStatus = safeText(line.slice("UPLOAD=".length), 40).toLowerCase();
    if (state.status !== "stopping") state.live.phase = "finalizing";
  }
}

function appendLogs(chunk, stream) {
  lineBuffers[stream] += streamDecoders[stream].write(chunk);
  let newline = lineBuffers[stream].indexOf("\n");
  while (newline >= 0) {
    handleOutputLine(lineBuffers[stream].slice(0, newline), stream);
    lineBuffers[stream] = lineBuffers[stream].slice(newline + 1);
    newline = lineBuffers[stream].indexOf("\n");
  }
  if (Buffer.byteLength(lineBuffers[stream], "utf8") > MAX_PENDING_LINE_BYTES) {
    appendPublicLog(`${lineBuffers[stream].slice(0, 1000)}…[line truncated]`, stream);
    lineBuffers[stream] = "";
  }
}

function flushLogs() {
  for (const stream of ["stdout", "stderr"]) {
    lineBuffers[stream] += streamDecoders[stream].end();
    if (lineBuffers[stream]) handleOutputLine(lineBuffers[stream], stream);
    lineBuffers[stream] = "";
  }
}

function normalizeRepoRelative(value) {
  const raw = String(value || "").trim();
  const resolved = path.resolve(REPO_ROOT, raw);
  const relative = path.relative(REPO_ROOT, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) return null;
  return relative.split(path.sep).join("/");
}

function publicConfigSnapshot() {
  if (!state.configSnapshot) return null;
  return {
    run: { ...(state.configSnapshot.run || {}) },
    script: state.configSnapshot.script ? {
      ...state.configSnapshot.script,
      workflow: {
        steps: Array.isArray(state.configSnapshot.script.workflow?.steps)
          ? state.configSnapshot.script.workflow.steps.map((step) => ({
            ...step,
            eventSteps: [...(step.eventSteps || [])],
            modes: [...(step.modes || [])],
          }))
          : [],
      },
      ui: state.configSnapshot.script.ui
        ? JSON.parse(JSON.stringify(state.configSnapshot.script.ui))
        : undefined,
    } : null,
    flow: summarizePerformanceResourceFlow(state.configSnapshot.flow || {}),
  };
}

function publicState() {
  return {
    status: state.status,
    running: state.running,
    runId: state.runId,
    startedAt: state.startedAt,
    completedAt: state.completedAt,
    options: state.options,
    exitCode: state.exitCode,
    exitSignal: state.exitSignal,
    error: state.error,
    resultJson: state.resultJson,
    artifactDir: state.artifactDir,
    uploadStatus: state.uploadStatus,
    configPath: state.configPath,
    runnerLog: state.runnerLog,
    // 完整快照保存在 configPath；状态轮询只返回轻量摘要，避免每秒传输 selectors 大对象。
    configSnapshot: publicConfigSnapshot(),
    logs: state.logs.slice(-40),
    stopRequested: state.stopRequested,
    live: publicLiveState(),
  };
}

function clearKillTimer() {
  if (killTimer) clearTimeout(killTimer);
  killTimer = null;
}

function performanceResourceTestOverridesEnabled() {
  return process.env.NODE_ENV === "test" && process.env.APPMARKET_PERF_TEST_OVERRIDES === "1";
}

export function resolvePerformanceResourcePython() {
  if (performanceResourceTestOverridesEnabled() && process.env.APPMARKET_PERF_PYTHON) {
    return { executable: process.env.APPMARKET_PERF_PYTHON, prefix: [] };
  }
  if (process.platform !== "win32") return { executable: "python3", prefix: [] };
  const launcher = spawnSync("py", ["-3", "--version"], { windowsHide: true, timeout: 3000 });
  if (!launcher.error && launcher.status === 0) return { executable: "py", prefix: ["-3"] };
  return { executable: "python", prefix: [] };
}

export function startResourceRun(rawOptions = {}) {
  if (state.running || child) {
    const error = new Error("已有应用市场资源摸测正在运行");
    error.code = "RUNNING";
    throw error;
  }
  const savedConfig = getPerformanceResourceConfig();
  const selected = selectPerformanceResourceScript(savedConfig, rawOptions?.scriptId);
  if (
    Object.prototype.hasOwnProperty.call(rawOptions || {}, "executeFlow")
    && rawOptions.executeFlow !== selected.run.executeFlow
  ) {
    const error = new Error(
      `executeFlow 由测试任务脚本 ${selected.script.id} 锁定为 ${selected.run.executeFlow}; 请切换脚本而不是覆盖工作流模式`,
    );
    error.code = "LOCKED_SCRIPT_WORKFLOW";
    throw error;
  }
  const overrides = Object.fromEntries(
    Object.entries(rawOptions || {}).filter(([key, value]) => (
      key !== "scriptId" && key !== "executeFlow" && value !== undefined
    )),
  );
  const options = {
    ...validateResourceRunOptions({ ...selected.run, ...overrides, executeFlow: selected.run.executeFlow }),
    scriptId: selected.script.id,
  };
  const flowConfig = JSON.parse(JSON.stringify({ ...selected.flow, package: options.package }));
  const effectiveFlowConfig = {
    ...flowConfig,
    _performance_script: JSON.parse(JSON.stringify(selected.script)),
  };
  const runId = randomUUID();
  fs.mkdirSync(CONTROL_ROOT, { recursive: true });
  stopFile = path.join(CONTROL_ROOT, `${runId}.stop`);
  const configFile = path.join(CONTROL_ROOT, `${runId}.config.json`);
  runnerLogPath = path.join(CONTROL_ROOT, `${runId}.runner.log`);
  const configTempFile = `${configFile}.tmp`;
  try { fs.unlinkSync(stopFile); } catch {}
  try {
    fs.writeFileSync(configTempFile, JSON.stringify(effectiveFlowConfig, null, 2), "utf8");
    fs.renameSync(configTempFile, configFile);
    fs.writeFileSync(
      runnerLogPath,
      `[${new Date().toISOString()}] [gateway] resource runner ${runId} starting\n`,
      "utf8",
    );
    runnerLogBytes = fs.statSync(runnerLogPath).size;
    runnerLogTruncated = false;
  } catch (error) {
    try { fs.rmSync(configTempFile, { force: true }); } catch {}
    throw error;
  }
  // configFile 是本轮实际执行口径的原始证据，随 docs/tempFiles 产物保留，不在结束时删除。
  const gatewayUrl = `http://127.0.0.1:${process.env.PORT || 3001}`;
  const args = buildResourceRunnerArgs(options, runId, stopFile, gatewayUrl, configFile, selected.runnerPath);
  const python = resolvePerformanceResourcePython();
  const childEnv = {
    ...process.env,
    // Windows 默认代码页可能把 Python 的中文状态行破坏为乱码；固定管道为 UTF-8。
    PYTHONUTF8: "1",
    PYTHONIOENCODING: "utf-8",
  };
  if (!performanceResourceTestOverridesEnabled()) {
    delete childEnv.APPMARKET_PERF_RUNNER;
    delete childEnv.APPMARKET_PERF_PYTHON;
    delete childEnv.APPMARKET_PERF_TEST_OVERRIDES;
  }

  Object.assign(state, {
    status: "starting",
    running: true,
    runId,
    startedAt: new Date().toISOString(),
    completedAt: null,
    options,
    exitCode: null,
    exitSignal: null,
    error: null,
    resultJson: null,
    artifactDir: null,
    uploadStatus: null,
    configPath: normalizeRepoRelative(configFile),
    runnerLog: normalizeRepoRelative(runnerLogPath),
    configSnapshot: { run: { ...options }, script: selected.script, flow: flowConfig },
    logs: [],
    stopRequested: false,
    live: createLiveState(runId, options),
  });
  lineBuffers = { stdout: "", stderr: "" };
  streamDecoders = { stdout: new StringDecoder("utf8"), stderr: new StringDecoder("utf8") };
  try {
    child = spawn(python.executable, [...python.prefix, ...args], {
      cwd: REPO_ROOT,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: childEnv,
    });
  } catch (error) {
    child = null;
    clearKillTimer();
    Object.assign(state, {
      status: "failed",
      running: false,
      completedAt: new Date().toISOString(),
      error: error instanceof Error ? error.message : String(error),
    });
    appendRunnerLog(`spawn failed: ${state.error}`, "gateway");
    state.live.phase = "failed";
    state.live.meta.phase = "failed";
    emitLive("state", { status: state.status, running: state.running, live: publicLiveState() });
    try { if (stopFile) fs.unlinkSync(stopFile); } catch {}
    log(null, "error", "performance-resource", `启动失败: ${state.error}`);
    throw error;
  }
  state.status = "running";
  state.live.phase = "starting";
  state.live.meta.phase = "starting";
  emitLive("state", { status: state.status, running: state.running, live: publicLiveState() });
  child.stdout.on("data", (chunk) => appendLogs(chunk, "stdout"));
  child.stderr.on("data", (chunk) => appendLogs(chunk, "stderr"));
  child.on("error", (error) => {
    state.status = "failed";
    state.running = false;
    state.error = error.message;
    state.exitSignal = null;
    state.completedAt = new Date().toISOString();
    state.live.phase = "failed";
    state.live.meta.phase = "failed";
    clearKillTimer();
    appendRunnerLog(`process error: ${error.message}`, "gateway");
    emitLive("state", { status: state.status, running: state.running, live: publicLiveState() });
    log(null, "error", "performance-resource", `启动失败: ${error.message}`);
  });
  child.on("close", (code, signal) => {
    flushLogs();
    clearKillTimer();
    state.exitCode = code;
    state.exitSignal = signal || null;
    state.running = false;
    state.completedAt = new Date().toISOString();
    if (state.stopRequested || code === 130) state.status = "cancelled";
    else if (code === 0 && state.uploadStatus !== "uploaded") {
      state.status = "completed_with_upload_error";
      state.error = state.uploadStatus === "failed"
        ? "采集与分析已完成，但上报后台失败；原始数据和 platform_payload.json 已保留"
        : "采集与分析已完成，但未收到后台上报成功确认；原始数据和 platform_payload.json 已保留";
    } else if (code === 0) state.status = "completed";
    else if (signal) {
      state.status = "failed";
      if (!state.error) state.error = `采集脚本被信号 ${signal} 终止`;
    } else if (code === WINDOWS_FORCED_EXIT_CODE) {
      state.status = "failed";
      if (!state.error) {
        state.error = "采集脚本被强制终止（Windows exit -1 / 0xFFFFFFFF）；请查看本轮 runner 日志";
      }
    } else {
      state.status = "failed";
      if (!state.error) state.error = `采集脚本退出码 ${code}`;
    }
    state.live.phase = state.status;
    state.live.meta.phase = state.status;
    updateLiveProgress();
    appendRunnerLog(
      `process closed: status=${state.status} code=${code ?? "null"} signal=${signal || "none"}`
      + (state.error ? ` error=${state.error}` : ""),
      "gateway",
    );
    child = null;
    try { if (stopFile) fs.unlinkSync(stopFile); } catch {}
    emitLive("state", { status: state.status, running: state.running, live: publicLiveState() });
    log(null, state.status === "completed" ? "info" : "warn", "performance-resource", `运行 ${runId} 结束: ${state.status}`);
  });
  log(null, "info", "performance-resource", `启动资源摸测 ${runId}`);
  return publicState();
}

export function stopResourceRun() {
  if (!state.running) return publicState();
  state.stopRequested = true;
  state.status = "stopping";
  state.live.phase = "stopping";
  state.live.meta.phase = "stopping";
  try {
    fs.mkdirSync(path.dirname(stopFile), { recursive: true });
    fs.writeFileSync(stopFile, new Date().toISOString(), "utf8");
  } catch (error) {
    state.error = `无法写入停止信号: ${error.message}`;
  }
  clearKillTimer();
  const recordingSegments = Math.max(1, Math.ceil(Number(state.options?.duration || 180) / 170));
  const killGraceMs = state.options?.captureScreenrecord
    ? Math.min(10 * 60_000, 60_000 + recordingSegments * 60_000)
    : 20_000;
  killTimer = setTimeout(() => {
    if (child && child.exitCode == null) {
      try { child.kill(); } catch {}
    }
  }, killGraceMs);
  killTimer.unref?.();
  emitLive("state", { status: state.status, running: state.running, live: publicLiveState() });
  return publicState();
}

export function getResourceRunStatus() {
  return publicState();
}
