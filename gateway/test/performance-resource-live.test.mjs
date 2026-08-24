import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "performance-resource-live-"));
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const fixture = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "fake-appmarket-resource-runner.mjs");
const isolatedConfig = path.join(testRoot, "gateway.json");
fs.writeFileSync(isolatedConfig, JSON.stringify({ role: "standalone" }));
process.env.GATEWAY_DB_PATH = ":memory:";
process.env.GATEWAY_CONFIG_PATH = isolatedConfig;
process.env.NODE_ENV = "test";
process.env.APPMARKET_PERF_TEST_OVERRIDES = "1";
process.env.APPMARKET_PERF_PYTHON = process.execPath;
process.env.APPMARKET_PERF_RUNNER = fixture;

const {
  buildResourceRunnerArgs,
  getResourceRunStatus,
  mergeResourceChannelEvent,
  mergeResourceDiagnosticSample,
  mergeResourceLiveSample,
  parseResourceLiveLine,
  resolvePerformanceResourcePython,
  startResourceRun,
  stopResourceRun,
  validateResourceRunOptions,
} = await import("../services/performance-resource-runner.js");

const createdControlFiles = new Set();

after(async () => {
  if (getResourceRunStatus().running) {
    stopResourceRun();
    for (let index = 0; index < 100 && getResourceRunStatus().running; index += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  for (const file of createdControlFiles) {
    try { fs.rmSync(file, { force: true }); } catch {}
  }
  try { fs.rmSync(testRoot, { recursive: true, force: true }); } catch {}
});

test("structured live output parses only complete valid JSON lines", () => {
  assert.deepEqual(
    parseResourceLiveLine('LIVE_META_JSON={"runId":"run-1","serial":"device-1","phase":"collecting"}'),
    { kind: "meta", value: { runId: "run-1", serial: "device-1", phase: "collecting" } },
  );
  assert.deepEqual(
    parseResourceLiveLine('[sample] LIVE_SAMPLE_JSON={"sample_index":1,"pss_mb":123.4567}'),
    { kind: "sample", value: { sample_index: 1, pss_mb: 123.4567 } },
  );
  assert.deepEqual(
    parseResourceLiveLine('[sample] LIVE_DIAGNOSTIC_JSON={"diagnostic_index":1,"rss_mb":151.25,"rss_fresh":true}'),
    { kind: "diagnostic", value: { diagnostic_index: 1, rss_mb: 151.25, rss_fresh: true } },
  );
  assert.deepEqual(
    parseResourceLiveLine('LIVE_EVENT_JSON={"channel":"startup.timing","sequence":1,"values":{"first_frame_ms":321.5}}'),
    {
      kind: "event",
      value: { channel: "startup.timing", sequence: 1, values: { first_frame_ms: 321.5 } },
    },
  );
  assert.deepEqual(parseResourceLiveLine("LIVE_SAMPLE_JSON={\"sample_index\":"), { kind: "invalid" });
  assert.deepEqual(parseResourceLiveLine("LIVE_EVENT_JSON={\"channel\":\"startup.timing\""), { kind: "invalid" });
  assert.equal(parseResourceLiveLine("ordinary runner output"), null);
});

test("sampling mode defaults to standard and realtime forces Perfetto", () => {
  const standard = validateResourceRunOptions({ duration: 10, interval: 5 });
  assert.equal(standard.samplingMode, "standard");
  assert.equal(standard.capturePerfetto, false);
  const realtime = validateResourceRunOptions({
    duration: 10,
    interval: 5,
    samplingMode: "realtime",
    capturePerfetto: false,
  });
  assert.equal(realtime.samplingMode, "realtime");
  assert.equal(realtime.capturePerfetto, true);
  assert.throws(
    () => validateResourceRunOptions({ duration: 10, interval: 5, samplingMode: "burst" }),
    /standard 或 realtime/,
  );
  assert.throws(
    () => validateResourceRunOptions({ duration: 20, interval: 10, samplingMode: "realtime" }),
    /必须为 5 秒/,
  );
});

test("flow output exposes the current script step", () => {
  assert.deepEqual(
    parseResourceLiveLine("[flow] download_install: clicked - 应用 A"),
    {
      kind: "step",
      value: { step: "download_install", status: "clicked", message: "应用 A" },
    },
  );
});

test("runner arguments use the selected script unless the trusted test override is set", () => {
  const saved = Object.fromEntries([
    "NODE_ENV",
    "APPMARKET_PERF_TEST_OVERRIDES",
    "APPMARKET_PERF_RUNNER",
    "APPMARKET_PERF_PYTHON",
  ].map((key) => [key, process.env[key]]));
  try {
    const selectedRunner = path.join(testRoot, "selected-runner.py");
    const configuredRunner = path.join(testRoot, "untrusted-runner.py");
    const configuredPython = path.join(testRoot, "untrusted-python.exe");
    process.env.NODE_ENV = "production";
    process.env.APPMARKET_PERF_TEST_OVERRIDES = "1";
    process.env.APPMARKET_PERF_RUNNER = configuredRunner;
    process.env.APPMARKET_PERF_PYTHON = configuredPython;
    const productionArgs = buildResourceRunnerArgs(
      { package: "com.appmarket.automotive", duration: 10, interval: 5, executeFlow: false },
      "run-selected",
      path.join(testRoot, "stop"),
      "http://127.0.0.1:3001",
      path.join(testRoot, "config.json"),
      selectedRunner,
    );
    assert.equal(productionArgs[0], selectedRunner);
    assert.equal(productionArgs.includes("--sampling-mode"), false);
    assert.notEqual(resolvePerformanceResourcePython().executable, configuredPython);

    process.env.NODE_ENV = "test";
    process.env.APPMARKET_PERF_TEST_OVERRIDES = "1";
    const testArgs = buildResourceRunnerArgs(
      { package: "com.appmarket.automotive", duration: 10, interval: 5, executeFlow: false },
      "run-test-override",
      path.join(testRoot, "stop"),
      "http://127.0.0.1:3001",
      path.join(testRoot, "config.json"),
      selectedRunner,
    );
    assert.equal(testArgs[0], path.resolve(configuredRunner));
    assert.equal(resolvePerformanceResourcePython().executable, configuredPython);
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("realtime runner arguments add only the supported mode flag and force Perfetto", () => {
  const args = buildResourceRunnerArgs(
    {
      package: "com.appmarket.automotive",
      duration: 10,
      interval: 5,
      executeFlow: false,
      samplingMode: "realtime",
      capturePerfetto: false,
    },
    "run-realtime",
    path.join(testRoot, "stop-realtime"),
    "http://127.0.0.1:3001",
    path.join(testRoot, "config-realtime.json"),
    path.join(testRoot, "runner-realtime.py"),
  );
  assert.deepEqual(args.slice(args.indexOf("--sampling-mode"), args.indexOf("--sampling-mode") + 2), [
    "--sampling-mode",
    "realtime",
  ]);
  assert.equal(args.filter((value) => value === "--capture-perfetto").length, 1);
});

test("live samples are sanitized, deduplicated, sorted, null-safe, and bounded", () => {
  let current = [];
  current = mergeResourceLiveSample(current, {
    sample_index: 2,
    target_elapsed_s: 10,
    cpu_device_normalized_pct: null,
    pss_mb: 130.1234,
    ignored: "not public",
  }, 2).samples;
  current = mergeResourceLiveSample(current, {
    sample_index: 1,
    target_elapsed_s: 5,
    cpu_device_normalized_pct: 1.2345,
    pss_mb: 120.5678,
  }, 2).samples;
  current = mergeResourceLiveSample(current, {
    sample_index: 2,
    target_elapsed_s: 10,
    cpu_device_normalized_pct: 2.3456,
    pss_mb: 131.4321,
  }, 2).samples;

  assert.deepEqual(current.map((sample) => sample.sample_index), [1, 2]);
  assert.equal(current[1].cpu_device_normalized_pct, 2.3456);
  assert.equal(current[1].pss_mb, 131.4321);
  assert.equal(Object.hasOwn(current[1], "ignored"), false);

  current = mergeResourceLiveSample(current, { sample_index: 3, pss_mb: 140 }, 2).samples;
  assert.deepEqual(current.map((sample) => sample.sample_index), [2, 3]);
  assert.equal(mergeResourceLiveSample(current, { sample_index: 0 }, 2).sample, null);
});

test("diagnostic samples stay separate, sanitize fields, bound the ring, and retain total count", () => {
  let current = [];
  let totalCount = 0;
  for (let index = 1; index <= 4; index += 1) {
    const merged = mergeResourceDiagnosticSample(current, {
      diagnostic_index: index,
      source_timestamp_s: index / 2,
      cpu_window_duration_s: 0.5,
      cpu_device_normalized_pct: index,
      rss_mb: index % 2 === 0 ? 150 + index : null,
      rss_source_timestamp_s: index % 2 === 0 ? index / 2 : null,
      metric_source: "procfs_stream",
      rss_fresh: index % 2 === 0,
      ignored: "not public",
    }, totalCount, 2);
    current = merged.samples;
    totalCount = merged.totalCount;
  }
  assert.deepEqual(current.map((sample) => sample.diagnostic_index), [3, 4]);
  assert.equal(totalCount, 4);
  assert.equal(current[1].rss_fresh, true);
  assert.equal(current[1].metric_source, "procfs_stream");
  assert.equal(Object.hasOwn(current[1], "ignored"), false);

  const duplicate = mergeResourceDiagnosticSample(current, {
    diagnostic_index: 3,
    cpu_device_normalized_pct: 9,
  }, totalCount, 2);
  assert.equal(duplicate.totalCount, 4);
  assert.equal(duplicate.samples[0].cpu_device_normalized_pct, 9);
  assert.equal(mergeResourceDiagnosticSample(current, { diagnostic_index: 0 }, totalCount).sample, null);
});

test("generic channel events are sanitized, deduplicated, sorted, and bounded", () => {
  let current = [];
  current = mergeResourceChannelEvent(current, {
    channel: "startup.timing",
    sequence: 2,
    run_id: "run-1",
    elapsed_s: 1.25,
    time: "2026-07-16T12:00:00.000Z",
    message: "second event",
    values: {
      first_frame_ms: 321.5,
      ready: true,
      label: "x".repeat(600),
      not_finite: Number.NaN,
      nested: { ignored: true },
      "invalid key": "ignored",
    },
    ignored: "not public",
  }, 2).events;
  current = mergeResourceChannelEvent(current, {
    channel: "startup.timing",
    seq: 1,
    payload: { first_frame_ms: 300 },
  }, 2).events;

  assert.deepEqual(current.map((event) => `${event.channel}:${event.sequence}`), [
    "startup.timing:1",
    "startup.timing:2",
  ]);
  assert.equal(current[1].schema_version, 1);
  assert.equal(current[1].runId, "run-1");
  assert.equal(current[1].elapsed_s, 1.25);
  assert.equal(current[1].values.label.length, 500);
  assert.equal(current[1].values.not_finite, null);
  assert.equal(Object.hasOwn(current[1].values, "nested"), false);
  assert.equal(Object.hasOwn(current[1].values, "invalid key"), false);
  assert.equal(Object.hasOwn(current[1], "ignored"), false);

  current = mergeResourceChannelEvent(current, {
    channel: "startup.timing",
    sequence: 2,
    record: { first_frame_ms: 299, updated: true },
  }, 2).events;
  assert.equal(current.length, 2);
  assert.deepEqual(current[1].values, { first_frame_ms: 299, updated: true });

  current = mergeResourceChannelEvent(current, {
    channel: "workflow.progress",
    sequence: 3,
    values: { percent: 100 },
  }, 2).events;
  assert.deepEqual(current.map((event) => `${event.channel}:${event.sequence}`), [
    "startup.timing:2",
    "workflow.progress:3",
  ]);

  const invalid = mergeResourceChannelEvent(current, {
    channel: "invalid channel",
    sequence: 4,
    values: { percent: 100 },
  }, 2);
  assert.equal(invalid.event, null);
  assert.deepEqual(invalid.events, current);
});

test("runner status keeps the resolved serial and all live samples until completion", async () => {
  assert.throws(
    () => startResourceRun({ scriptId: "appmarket-launch-only", executeFlow: true }),
    /executeFlow 由测试任务脚本 appmarket-launch-only 锁定为 false/,
  );
  assert.equal(getResourceRunStatus().running, false);
  const started = startResourceRun({
    scriptId: "appmarket-launch-only",
    serial: "mock-live-device",
    duration: 10,
    interval: 5,
    captureScreenrecord: false,
  });
  if (started.configPath) createdControlFiles.add(path.resolve(repoRoot, started.configPath));
  if (started.runnerLog) createdControlFiles.add(path.resolve(repoRoot, started.runnerLog));
  assert.equal(started.live.samples.length, 0);
  assert.deepEqual(started.live.channelEvents, []);
  assert.equal(started.live.progress.expectedSamples, 2);
  assert.equal(started.options.scriptId, "appmarket-launch-only");
  assert.equal(started.options.executeFlow, false);
  assert.equal(started.live.meta.script_id, "appmarket-launch-only");
  assert.equal(started.configSnapshot.script.id, "appmarket-launch-only");
  assert.equal(started.configSnapshot.script.workflow.steps[0].key, "launch");
  assert.equal(started.configSnapshot.script.ui.schemaVersion, 1);
  assert.equal(started.configSnapshot.script.ui.defaultView, "launch-dashboard");
  const preservedConfig = JSON.parse(fs.readFileSync(path.resolve(repoRoot, started.configPath), "utf8"));
  assert.equal(preservedConfig._performance_script.id, "appmarket-launch-only");
  assert.equal(preservedConfig._performance_script.workflow.steps.at(-1).key, "flow");

  let status = started;
  let observedWhileRunning = false;
  for (let index = 0; index < 100; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 20));
    status = getResourceRunStatus();
    if (status.running && status.live.samples.length > 0) observedWhileRunning = true;
    if (!status.running) break;
  }

  assert.equal(observedWhileRunning, true);
  assert.equal(status.status, "completed");
  assert.equal(status.live.meta.serial, "mock-live-device");
  assert.equal(status.live.samples.length, 2);
  assert.deepEqual(status.live.samples.map((sample) => sample.sample_index), [1, 2]);
  assert.equal(status.live.progress.sampleCount, 2);
  assert.equal(status.live.progress.percent, 100);
  assert.equal(status.live.samples[1].cpu_device_normalized_pct, 1.0625);
  assert.equal(status.live.channelEvents.length, 1);
  assert.deepEqual(status.live.channelEvents[0], {
    schema_version: 1,
    channel: "fixture.progress",
    sequence: 1,
    runId: started.runId,
    elapsed_s: 0.125,
    message: "fixture sample stream started",
    values: {
      sample_target: 2,
      ready: true,
    },
  });
  status.live.channelEvents[0].values.sample_target = 999;
  assert.equal(getResourceRunStatus().live.channelEvents[0].values.sample_target, 2);
  assert.deepEqual(status.live.stepHistory.map((step) => step.status), ["started", "passed"]);
  assert.equal(status.live.stepHistory[0].sequence, 1);
  assert.equal(status.live.stepHistory[1].sequence, 2);
  assert.equal(status.live.currentStep.message, "应用市场首页已完全加载并稳定");
  assert.ok(status.runnerLog);
  const runnerLog = fs.readFileSync(path.resolve(repoRoot, status.runnerLog), "utf8");
  assert.match(runnerLog, /LIVE_SAMPLE_JSON=/);
  assert.match(runnerLog, /process closed: status=completed code=0 signal=none/);

  const next = startResourceRun({
    scriptId: "appmarket-launch-only",
    serial: "mock-next-device",
    duration: 5,
    interval: 5,
    captureScreenrecord: false,
  });
  if (next.configPath) createdControlFiles.add(path.resolve(repoRoot, next.configPath));
  if (next.runnerLog) createdControlFiles.add(path.resolve(repoRoot, next.runnerLog));
  assert.notEqual(next.runId, started.runId);
  assert.deepEqual(next.live.samples, []);
  assert.deepEqual(next.live.channelEvents, []);
  assert.deepEqual(next.live.stepHistory, []);
  assert.equal(next.live.progress.sampleCount, 0);
  stopResourceRun();
  for (let index = 0; index < 100 && getResourceRunStatus().running; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(getResourceRunStatus().status, "cancelled");
});

test("realtime run keeps diagnostic samples separate from formal samples", async () => {
  const started = startResourceRun({
    scriptId: "appmarket-launch-only",
    serial: "mock-realtime-device",
    duration: 10,
    interval: 5,
    samplingMode: "realtime",
    captureScreenrecord: false,
    capturePerfetto: false,
  });
  if (started.configPath) createdControlFiles.add(path.resolve(repoRoot, started.configPath));
  if (started.runnerLog) createdControlFiles.add(path.resolve(repoRoot, started.runnerLog));
  assert.equal(started.options.samplingMode, "realtime");
  assert.equal(started.options.capturePerfetto, true);
  assert.deepEqual(started.live.diagnosticSamples, []);
  assert.equal(started.live.diagnosticTotalCount, 0);

  let status = started;
  for (let index = 0; index < 100; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 20));
    status = getResourceRunStatus();
    if (!status.running) break;
  }
  assert.equal(status.status, "completed");
  assert.equal(status.live.meta.sampling_mode, "realtime");
  assert.equal(status.live.meta.cpu_interval_ms, 500);
  assert.equal(status.live.meta.rss_interval_ms, 1000);
  assert.equal(status.live.meta.pss_interval_ms, 5000);
  assert.equal(status.live.samples.length, 2);
  assert.equal(status.live.diagnosticSamples.length, 4);
  assert.equal(status.live.diagnosticTotalCount, 4);
  assert.equal(status.live.diagnosticSamples[0].cpu_device_normalized_pct, null);
  assert.equal(status.live.diagnosticSamples[1].rss_mb, 152);
  assert.equal(status.live.samples[1].pss_mb, 122);
});
