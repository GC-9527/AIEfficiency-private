import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { bootGateway, waitHealth } from "./_helpers.mjs";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "perf-resource-"));
const port = 32100 + Math.floor(Math.random() * 500);
const cfg = path.join(tmp, "gateway.json");
const market = path.join(tmp, "market.json");
const store = path.join(tmp, "store");
const dbPath = path.join(tmp, "gateway.db");
const fixture = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "fake-appmarket-resource-runner.mjs");
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const artifactRoot = path.join(tmp, "artifacts");
const artifactTestPrefix = `integration_${process.pid}_${Date.now()}`;
const sourceTaskLibraryRoot = path.join(
  repoRoot,
  "features",
  "PerformanceFeature",
  "performance-test-scripts",
  "tasks",
);
const CURRENT_RUNNER_RELATIVE = "features/PerformanceFeature/performance-test-scripts/tasks/android/appmarket-cpu-memory/runner.py";
const taskLibraryRelative = [
  "features",
  "PerformanceFeature",
  "performance-test-scripts",
  ".test-temp",
  `gateway-task-library-${artifactTestPrefix}`,
].join("/");
const taskLibraryRoot = path.resolve(repoRoot, ...taskLibraryRelative.split("/"));
const createdControlFiles = new Set();
const createdArtifactDirs = new Set();
let gateway;

const DEFAULT_SCRIPT_EVIDENCE = {
  id: "appmarket-default",
  name: "应用市场完整性能测试",
  description: "历史详情测试脚本",
  runner: "features/PerformanceFeature/step20260714/docs/appmarket_perf_runner.py",
  workflow: {
    steps: [
      { key: "launch", label: "启动并等待首页", eventSteps: ["launch", "select_home"], modes: ["full", "launch-only"] },
      { key: "flow", label: "自动化脚本结束", eventSteps: ["flow"], modes: ["full", "launch-only"] },
    ],
  },
};

before(async () => {
  fs.mkdirSync(artifactRoot, { recursive: true });
  fs.mkdirSync(path.dirname(taskLibraryRoot), { recursive: true });
  fs.cpSync(sourceTaskLibraryRoot, taskLibraryRoot, { recursive: true });
  const ignoredTemplateDir = path.join(taskLibraryRoot, "_templates", "python");
  fs.mkdirSync(ignoredTemplateDir, { recursive: true });
  fs.writeFileSync(
    path.join(ignoredTemplateDir, "task.template.json"),
    JSON.stringify({
      id: "template-must-not-be-discovered",
      name: "仅供开发复制的任务模板",
      runner: CURRENT_RUNNER_RELATIVE,
      workflow: { steps: [{ key: "flow", label: "模板步骤", eventSteps: ["flow"], modes: ["full"] }] },
    }),
  );
  // Ordinary template/source assets must not exhaust the bounded manifest
  // discovery budget before the real task folders are visited.
  for (let index = 0; index < 250; index += 1) {
    fs.writeFileSync(path.join(ignoredTemplateDir, `example-${String(index).padStart(3, "0")}.txt`), "template");
  }
  fs.writeFileSync(cfg, JSON.stringify({ role: "standalone", servers: { nodeName: "test" } }));
  fs.writeFileSync(market, JSON.stringify({ projects: [] }));
  gateway = bootGateway({
    port,
    gwCfg: cfg,
    market,
    storeDir: store,
    dbPath,
    extraEnv: {
      NODE_ENV: "test",
      APPMARKET_PERF_TEST_OVERRIDES: "1",
      APPMARKET_PERF_PYTHON: process.execPath,
      APPMARKET_PERF_RUNNER: fixture,
      APPMARKET_PERF_ARTIFACT_ROOT: artifactRoot,
      APPMARKET_PERFORMANCE_TASK_LIBRARY_ROOT: taskLibraryRelative,
    },
  });
  await waitHealth(port, gateway);
});

after(async () => {
  if (gateway && gateway.exitCode == null) {
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 3000);
      gateway.once("exit", () => { clearTimeout(timer); resolve(); });
      try { gateway.kill(); } catch { clearTimeout(timer); resolve(); }
    });
  }
  for (const filePath of createdControlFiles) {
    try { fs.rmSync(filePath, { force: true }); } catch {}
  }
  for (const artifactDir of createdArtifactDirs) {
    try { fs.rmSync(artifactDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch {}
  }
  try { fs.rmSync(taskLibraryRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch {}
  try { fs.rmdirSync(path.dirname(taskLibraryRoot)); } catch {}
  fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

const api = (route, options) => fetch(`http://127.0.0.1:${port}/api/performance${route}`, options);

function writeResourceArtifacts({ dirName, sessionId, manifestSessionId = sessionId, profile = {} }) {
  const isolatedDirName = `${artifactTestPrefix}_${dirName}`;
  const runDir = path.join(artifactRoot, isolatedDirName);
  createdArtifactDirs.add(runDir);
  for (const relative of ["raw", "flow", "analysis"]) {
    fs.mkdirSync(path.join(runDir, relative), { recursive: true });
  }
  const write = (relative, content) => {
    const filePath = path.join(runDir, ...relative.split("/"));
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content);
  };
  write("run_manifest.json", JSON.stringify({ session_id: manifestSessionId, status: "completed" }));
  write("raw/metrics.csv", "sample_index,cpu_device_normalized_pct,pss_mb\n1,1.2345,130.1234\n");
  write("raw/sampler_raw_commands.jsonl", `${JSON.stringify({ command: ["adb", "shell"], stdout: "ok" })}\n`);
  write("raw/sampler_summary.json", JSON.stringify({ actual_rows: 36, expected_rows: 36 }));
  write("raw/device_info.json", JSON.stringify({ device: { serial: "mock-serial" } }));
  write("raw/effective_flow_config.json", JSON.stringify({
    schema_version: 1,
    package: "com.appmarket.automotive",
    _performance_script: DEFAULT_SCRIPT_EVIDENCE,
  }));
  write("raw/dumpsys_package.txt", "Package [com.appmarket.automotive]\n");
  write("raw/logcat.txt", "L".repeat(300 * 1024));
  write("flow/flow_events.jsonl", [
    { at: "2026-07-15 12:00:00", step: "launch", status: "started", message: "com.appmarket.automotive", internal: "not-public" },
    { at: "2026-07-15 12:00:02", step: "launch", status: "passed", message: "应用市场首页已完全加载并稳定" },
  ].map((event) => JSON.stringify(event)).join("\n") + "\n");
  write("flow/flow_result.json", JSON.stringify({ status: "completed" }));
  write("analysis/report.json", JSON.stringify({ ...profile, upload: { status: "uploaded" } }));
  write("analysis/report.md", "# 资源性能报告\n\n完整流程已执行。\n");
  write("analysis/report_summary.pdf", Buffer.from("%PDF-1.4\n% summary fixture\n"));
  write("analysis/report_detailed.pdf", Buffer.from("%PDF-1.4\n% detailed fixture\n"));
  write("analysis/optimization_advice.md", "# 性能优化建议\n\n- 优先检查内存峰值。\n");
  write("analysis/platform_payload.json", JSON.stringify({ sessionId, resourceProfile: profile }));
  return `docs/tempFiles/appmarket-performance/${isolatedDirName}`;
}

function rememberControlConfig(status) {
  const relative = status?.data?.configPath;
  const runnerLog = status?.data?.runnerLog;
  if (runnerLog) createdControlFiles.add(path.resolve(repoRoot, runnerLog));
  if (!relative) return null;
  const absolute = path.resolve(repoRoot, relative);
  createdControlFiles.add(absolute);
  return absolute;
}

function fixtureArgs(status) {
  const line = status?.data?.logs?.find((item) => item.line.startsWith("ARGS_JSON="))?.line;
  assert.ok(line, "fake runner should expose its argv in status logs");
  return JSON.parse(line.slice("ARGS_JSON=".length));
}

function fixturePythonEncoding(status) {
  const line = status?.data?.logs?.find((item) => item.line.startsWith("PYTHON_ENCODING_JSON="))?.line;
  assert.ok(line, "fake runner should expose its inherited Python encoding environment");
  return JSON.parse(line.slice("PYTHON_ENCODING_JSON=".length));
}

test("platform starts the bounded resource runner and exposes its result path", async () => {
  const mismatchedMode = await api("/resource-run/start", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      scriptId: "appmarket-default",
      serial: "mock-serial",
      duration: 10,
      interval: 5,
      executeFlow: false,
    }),
  });
  assert.equal(mismatchedMode.status, 400);
  assert.match((await mismatchedMode.json()).error, /executeFlow.*锁定为 true/);

  const response = await api("/resource-run/start", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      scriptId: "appmarket-launch-only",
      serial: "mock-serial",
      duration: 10,
      interval: 5,
      executeFlow: false,
    }),
  });
  assert.equal(response.status, 200);
  const started = await response.json();
  assert.equal(started.success, true);
  assert.equal(started.data.running, true);
  let status;
  let sawLiveSampleWhileRunning = false;
  for (let index = 0; index < 30; index++) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    status = await (await api("/resource-run/status")).json();
    if (status.data.running && status.data.live?.samples?.length) {
      sawLiveSampleWhileRunning = true;
    }
    if (!status.data.running) break;
  }
  assert.equal(status.data.status, "completed");
  assert.equal(sawLiveSampleWhileRunning, true);
  assert.equal(status.data.live.meta.serial, "mock-serial");
  assert.equal(status.data.live.progress.expectedSamples, 2);
  assert.deepEqual(status.data.live.samples.map((sample) => sample.sample_index), [1, 2]);
  assert.equal(status.data.live.samples[1].pss_mb, 122);
  assert.match(status.data.resultJson, /^docs\/tempFiles\/appmarket-performance\//);
  assert.equal(status.data.options.executeFlow, false);
  assert.equal(status.data.options.samplingMode, "standard");
  assert.equal(status.data.options.scriptId, "appmarket-launch-only");
  assert.equal(status.data.options.captureScreenrecord, false);
  assert.equal(status.data.configSnapshot.run.captureScreenrecord, false);
  assert.equal(status.data.configSnapshot.script.id, "appmarket-launch-only");
  assert.deepEqual(status.data.configSnapshot.script.workflow.steps[0].modes, ["launch-only"]);
  assert.equal(status.data.configSnapshot.script.ui.defaultView, "launch-dashboard");
  assert.deepEqual(status.data.configSnapshot.script.ui.views.map((view) => view.label), ["启动指标", "启动原始数据", "启动测试报表"]);
  assert.equal(status.data.configSnapshot.flow.timeouts.home_stable_samples, 3);
  assert.equal(fixtureArgs(status).includes("--sampling-mode"), false);
  const configPath = rememberControlConfig(status);
  assert.ok(configPath && fs.existsSync(configPath));
  const effectiveConfig = JSON.parse(fs.readFileSync(configPath, "utf8"));
  assert.equal(effectiveConfig._performance_script.id, "appmarket-launch-only");
  assert.equal(effectiveConfig._performance_script.ui.runSections.at(-1).title, "应用市场启动与首页性能测试工作流");
  assert.equal(
    effectiveConfig._performance_script.runner,
    CURRENT_RUNNER_RELATIVE,
  );
  const args = fixtureArgs(status);
  assert.deepEqual(fixturePythonEncoding(status), {
    pythonUtf8: "1",
    pythonIoEncoding: "utf-8",
  });
  assert.equal(args.includes("--capture-screenrecord"), false);
  assert.equal(args[args.indexOf("--flow-mode") + 1], "launch-only");
  assert.equal(path.resolve(args[args.indexOf("--config") + 1]), configPath);
});

test("resource profile ingest keeps decimal CPU values and appears in history", async () => {
  const sessionId = "resource-integration-test";
  const profile = {
    acceptance: "PASS",
    sampling: { actual_rows: 36, expected_rows: 36 },
    measurements: {
      cpu_device_normalized_pct: { mean: 1.2, peak: 3.3 },
      cpu_multi_core_pct: { mean: 6, peak: 16.5 },
      pss_mb: { mean: 130.1234, peak: 180.5678 },
    },
    flow: { status: "completed" },
    diagnostic: {
      enabled: true,
      actual_rows: 361,
      measurements: { cpu_device_normalized_pct: { mean: 1.1, peak: 4.2 } },
    },
    perfetto_validation: {
      analysis_status: "COMPLETED",
      threshold_status: "PASS",
      window: { coverage_ratio: 1 },
    },
    checks: [],
    warnings: [],
    optimization_advice: [{ id: "reduce-pss", priority: "P1", title: "降低内存峰值" }],
    artifacts: [{ key: "report_pdf_summary", path: "analysis/report_summary.pdf" }],
    pdf: {
      status: "completed",
      summary: "analysis/report_summary.pdf",
      detailed: "analysis/report_detailed.pdf",
      font: { name: "PerformanceReportCJK", source: "system-font:Deng.ttf", embedded: true },
    },
  };
  profile.artifact_dir = writeResourceArtifacts({
    dirName: "run_resource-integration-test",
    sessionId,
    profile,
  });
  const resourceSamples = Array.from({ length: 36 }, (_, index) => ({
    sample_index: index + 1,
    target_elapsed_s: (index + 1) * 5,
    actual_elapsed_s: (index + 1) * 5 + 0.1234,
    wall_time_local: "2026-07-15 05:00:00",
    pids: "10;11",
    process_names: "com.appmarket.automotive;com.appmarket.automotive:filedownloader",
    logical_cpus: 5,
    cpu_one_core_equiv_pct: index === 0 ? null : 6.1234,
    cpu_device_normalized_pct: index === 0 ? null : 1.2345,
    pss_mb: 130.1234 + index,
    rss_mb: 180.5678 + index,
    process_set_changed: index === 0 ? 1 : 0,
    collection_latency_s: 0.4567,
    note: index === 0 ? "process_set_changed_cpu_interval_invalid" : "",
  }));
  const payload = {
    sessionId,
    scenario: "resource_profile",
    flavor: "avatr8678",
    appVersion: "1.2.3",
    appVersionCode: 123,
    deviceModel: "MockCar",
    deviceBrand: "Test",
    deviceId: "mock-serial",
    round: "resource_test",
    metrics: [{ type: "fg", name: "cpu:fgPeak", value: 3.3 }],
    resourceSamples,
    resourceProfile: profile,
  };
  const ingested = await api("/ingest", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  assert.equal(ingested.status, 200);

  const metrics = await (await api("/metrics?type=fg&name=cpu:fgPeak&limit=10")).json();
  assert.equal(metrics.data.at(-1).value, 3.3);
  const history = await (await api("/resource-runs?flavor=avatr8678&limit=10")).json();
  assert.equal(history.data[0].acceptance, "PASS");
  assert.equal(history.data[0].measurements.cpu_device_normalized_pct.peak, 3.3);
  assert.equal(history.data[0].artifactDir, profile.artifact_dir);
});

test("resource run detail returns summary, 36 precise samples, reports, and fixed-key artifacts", async () => {
  const response = await api("/resource-runs/resource-integration-test");
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.success, true);
  assert.equal(body.data.run.id, "resource-integration-test");
  assert.equal(body.data.run.artifactsAvailable, true);
  assert.equal(body.data.profile.measurements.pss_mb.mean, 130.1234);
  assert.equal(body.data.profile.diagnostic.actual_rows, 361);
  assert.equal(body.data.profile.perfetto_validation.analysis_status, "COMPLETED");
  assert.equal(body.data.run.diagnostic.actual_rows, 361);
  assert.equal(body.data.run.perfettoValidation.threshold_status, "PASS");
  assert.equal(body.data.samples.length, 36);
  assert.equal(body.data.samples[0].cpu_device_normalized_pct, null);
  assert.equal(body.data.samples[1].cpu_device_normalized_pct, 1.2345);
  assert.equal(body.data.samples[35].pss_mb, 165.1234);
  assert.equal(body.data.report.json.upload.status, "uploaded");
  assert.equal(body.data.report.jsonSource, "artifact");
  assert.match(body.data.report.markdown, /资源性能报告/);
  assert.equal(body.data.report.markdownSource, "artifact");
  assert.equal(body.data.profile.optimization_advice[0].id, "reduce-pss");
  assert.equal(body.data.profile.pdf.status, "completed");
  assert.deepEqual(body.data.flowEvents, [
    {
      sequence: 1,
      at: "2026-07-15 12:00:00",
      step: "launch",
      status: "started",
      message: "com.appmarket.automotive",
    },
    {
      sequence: 2,
      at: "2026-07-15 12:00:02",
      step: "launch",
      status: "passed",
      message: "应用市场首页已完全加载并稳定",
    },
  ]);
  assert.equal(body.data.configSnapshot.script.id, "appmarket-default");
  assert.equal(body.data.configSnapshot.script.workflow.steps[0].eventSteps[0], "launch");
  assert.equal(body.data.configSnapshot.script.ui.defaultView, "dashboard", "旧历史轮次没有 UI 快照时必须安全降级");
  assert.equal(body.data.run.script.id, "appmarket-default");
  const keys = body.data.artifacts.map((item) => item.key).sort();
  assert.deepEqual(keys, [
    "device_info", "dumpsys_package", "effective_config", "flow_events", "flow_result",
    "logcat", "manifest", "metrics_csv", "optimization_advice", "platform_payload", "report_json", "report_md",
    "report_pdf_detailed", "report_pdf_summary",
    "sampler_raw_commands", "sampler_summary",
  ].sort());
  assert.equal(JSON.stringify(body).includes(tmp), false, "API must not expose absolute test paths");
});

test("resource artifact endpoint previews bounded text, downloads by key, and rejects unknown keys", async () => {
  const previewResponse = await api("/resource-runs/resource-integration-test/artifact?key=metrics_csv&offset=0&limit=128");
  assert.equal(previewResponse.status, 200);
  const preview = await previewResponse.json();
  assert.match(preview.data.content, /1\.2345,130\.1234/);
  assert.equal(preview.data.offset, 0);
  assert.equal(preview.data.truncated, false);
  assert.ok(preview.data.totalBytes > 0);
  assert.equal(JSON.stringify(preview).includes(tmp), false);

  const boundedResponse = await api("/resource-runs/resource-integration-test/artifact?key=logcat&limit=999999");
  assert.equal(boundedResponse.status, 200);
  const bounded = await boundedResponse.json();
  assert.equal(Buffer.byteLength(bounded.data.content), 256 * 1024);
  assert.equal(bounded.data.truncated, true);
  assert.equal(bounded.data.nextOffset, 256 * 1024);

  const downloadResponse = await api("/resource-runs/resource-integration-test/artifact?key=metrics_csv&download=1");
  assert.equal(downloadResponse.status, 200);
  assert.equal(downloadResponse.headers.get("x-content-type-options"), "nosniff");
  assert.match(downloadResponse.headers.get("content-disposition") || "", /attachment/);
  assert.match(await downloadResponse.text(), /sample_index,cpu_device_normalized_pct,pss_mb/);

  const pdfResponse = await api("/resource-runs/resource-integration-test/artifact?key=report_pdf_summary&download=1");
  assert.equal(pdfResponse.status, 200);
  assert.equal(pdfResponse.headers.get("content-type"), "application/pdf");
  assert.match(pdfResponse.headers.get("content-disposition") || "", /attachment/);
  assert.match(Buffer.from(await pdfResponse.arrayBuffer()).toString("utf8"), /^%PDF-/);

  const pdfPreview = await api("/resource-runs/resource-integration-test/artifact?key=report_pdf_detailed");
  assert.equal(pdfPreview.status, 415);

  const unknownResponse = await api("/resource-runs/resource-integration-test/artifact?key=..%2Flogcat");
  assert.equal(unknownResponse.status, 404);
});

test("resource detail returns 404 for missing records and 422 for corrupt raw JSON", async () => {
  const missing = await api("/resource-runs/not-found");
  assert.equal(missing.status, 404);

  const ingested = await api("/ingest", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      sessionId: "resource-corrupt-test",
      scenario: "resource_profile",
      resourceProfile: { acceptance: "PASS" },
    }),
  });
  assert.equal(ingested.status, 200);
  const isolatedDb = new Database(dbPath);
  try {
    isolatedDb.prepare("UPDATE perf_session SET raw_json = ? WHERE id = ?").run("{broken", "resource-corrupt-test");
  } finally {
    isolatedDb.close();
  }
  const corrupt = await api("/resource-runs/resource-corrupt-test");
  assert.equal(corrupt.status, 422);
  const body = await corrupt.json();
  assert.equal(body.success, false);
  assert.match(body.error, /原始 JSON 已损坏/);
});

test("resource detail keeps database evidence when artifact directory is forged or manifest id mismatches", async () => {
  const mismatchedArtifactDir = writeResourceArtifacts({
    dirName: "run_manifest-mismatch",
    sessionId: "resource-manifest-mismatch",
    manifestSessionId: "another-session",
    profile: { acceptance: "FAIL" },
  });
  const cases = [
    {
      sessionId: "resource-forged-dir",
      artifactDir: path.join(tmp, "outside-artifact-root"),
    },
    {
      sessionId: "resource-manifest-mismatch",
      artifactDir: mismatchedArtifactDir,
    },
  ];
  for (const item of cases) {
    const ingested = await api("/ingest", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId: item.sessionId,
        scenario: "resource_profile",
        resourceSamples: [{ sample_index: 1, pss_mb: 123.4567 }],
        resourceProfile: {
          acceptance: "FAIL",
          measurements: { pss_mb: { mean: 123.4567, peak: 123.4567 } },
          artifact_dir: item.artifactDir,
        },
      }),
    });
    assert.equal(ingested.status, 200);
    const response = await api(`/resource-runs/${item.sessionId}`);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.data.profile.measurements.pss_mb.mean, 123.4567);
    assert.equal(body.data.samples[0].pss_mb, 123.4567);
    assert.equal(body.data.profile.artifact_dir, null);
    assert.equal(body.data.run.artifactsAvailable, false);
    assert.deepEqual(body.data.artifacts, []);
    assert.equal(body.data.report.jsonSource, "database");
    assert.equal(JSON.stringify(body).includes(tmp), false);
  }
});

test("platform stop uses the cooperative stop file and reports cancelled", async () => {
  const started = await api("/resource-run/start", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ serial: "mock-serial", duration: 10, interval: 5 }),
  });
  assert.equal(started.status, 200);
  await new Promise((resolve) => setTimeout(resolve, 60));
  const stopping = await api("/resource-run/stop", { method: "POST" });
  assert.equal(stopping.status, 200);
  let status;
  for (let index = 0; index < 30; index++) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    status = await (await api("/resource-run/status")).json();
    if (!status.data.running) break;
  }
  assert.equal(status.data.status, "cancelled");
  assert.equal(status.data.stopRequested, true);
  rememberControlConfig(status);
});

test("platform distinguishes a preserved run whose backend upload failed", async () => {
  const started = await api("/resource-run/start", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      serial: "mock-serial",
      scriptId: "appmarket-launch-only",
      duration: 10,
      interval: 5,
      executeFlow: false,
      captureScreenrecord: false,
      testAppTitle: "__upload_fail__",
    }),
  });
  assert.equal(started.status, 200);
  let status;
  for (let index = 0; index < 30; index++) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    status = await (await api("/resource-run/status")).json();
    if (!status.data.running) break;
  }
  assert.equal(status.data.status, "completed_with_upload_error");
  assert.equal(status.data.uploadStatus, "failed");
  assert.match(status.data.error, /原始数据.*platform_payload\.json/);
  assert.match(status.data.resultJson, /^docs\/tempFiles\/appmarket-performance\//);
  rememberControlConfig(status);
});

test("platform does not report completed when the upload confirmation is missing", async () => {
  const started = await api("/resource-run/start", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      serial: "mock-serial",
      scriptId: "appmarket-launch-only",
      duration: 10,
      interval: 5,
      executeFlow: false,
      captureScreenrecord: false,
      testAppTitle: "__upload_missing__",
    }),
  });
  assert.equal(started.status, 200);
  let status;
  for (let index = 0; index < 30; index++) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    status = await (await api("/resource-run/status")).json();
    if (!status.data.running) break;
  }
  assert.equal(status.data.status, "completed_with_upload_error");
  assert.equal(status.data.uploadStatus, null);
  assert.match(status.data.error, /未收到后台上报成功确认.*原始数据/);
  assert.match(status.data.resultJson, /^docs\/tempFiles\/appmarket-performance\//);
  rememberControlConfig(status);
});

test("invalid intervals are rejected before a process is spawned", async () => {
  const response = await api("/resource-run/start", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ duration: 11, interval: 5 }),
  });
  assert.equal(response.status, 400);
  const body = await response.json();
  assert.match(body.error, /整数倍/);

  const invalidMode = await api("/resource-run/start", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ duration: 10, interval: 5, samplingMode: "burst" }),
  });
  assert.equal(invalidMode.status, 400);
  assert.match((await invalidMode.json()).error, /standard 或 realtime/);
});

test("control characters are rejected without leaving the resource runner busy", async () => {
  for (const testAppTitle of ["bad\0title", "bad\rtitle", "bad\ntitle"]) {
    const response = await api("/resource-run/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        scriptId: "appmarket-launch-only",
        duration: 10,
        interval: 5,
        executeFlow: false,
        captureScreenrecord: false,
        testAppTitle,
      }),
    });
    assert.equal(response.status, 400);
    const body = await response.json();
    assert.match(body.error, /换行或 NUL/);
    const status = await (await api("/resource-run/status")).json();
    assert.equal(status.data.running, false);
  }

  const validResponse = await api("/resource-run/start", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      scriptId: "appmarket-launch-only",
      duration: 10,
      interval: 5,
      executeFlow: false,
      captureScreenrecord: false,
      testAppTitle: "valid-title",
    }),
  });
  assert.equal(validResponse.status, 200);

  let status;
  for (let index = 0; index < 30; index++) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    status = await (await api("/resource-run/status")).json();
    if (!status.data.running) break;
  }
  assert.equal(status.data.status, "completed");
  assert.equal(status.data.options.testAppTitle, "valid-title");
  rememberControlConfig(status);
});

test("resource configuration is validated, persisted, and applied to runner arguments", async () => {
  const initialResponse = await api("/resource-config");
  assert.equal(initialResponse.status, 200);
  const initial = await initialResponse.json();
  assert.equal(initial.data.run.captureScreenrecord, true);
  assert.equal(initial.data.run.capturePerfetto, false);
  assert.equal(initial.data.run.samplingMode, "standard");
  assert.equal(initial.data.flow.package, "com.appmarket.automotive");
  assert.equal(initial.data.defaultScriptId, "appmarket-default");
  assert.equal(initial.data.scripts.length, 2);
  assert.equal(initial.data.scriptLibrary.managedScriptCount, 2);
  assert.deepEqual(initial.data.scriptLibrary.issues, []);
  const managedDefault = initial.data.scripts.find((script) => script.id === "appmarket-default");
  assert.equal(
    managedDefault.runner,
    CURRENT_RUNNER_RELATIVE,
  );
  assert.equal(initial.data.scripts.some((script) => script.id === "template-must-not-be-discovered"), false);
  assert.equal(managedDefault.category, "Android · 应用市场");
  assert.equal(managedDefault.managed, true);

  const run = {
    ...initial.data.run,
    serial: "saved-serial",
    flavor: "saved-flavor",
    duration: 15,
    interval: 5,
    samplingMode: "realtime",
    executeFlow: false,
    captureScreenrecord: false,
    capturePerfetto: false,
    testAppTitle: "配置测试应用",
  };
  const flow = structuredClone(initial.data.flow);
  flow.timeouts.page_ready_s = 45;
  flow.timeouts.home_stable_samples = 4;
  flow.thresholds.pss_peak_mb = 200;

  const savedResponse = await api("/resource-config", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ run, flow }),
  });
  assert.equal(savedResponse.status, 200);
  const saved = await savedResponse.json();
  const expectedRun = { ...run, capturePerfetto: true };
  assert.deepEqual(saved.data.run, expectedRun);
  assert.equal(saved.data.flow.timeouts.page_ready_s, 45);
  assert.equal(saved.data.flow.timeouts.home_stable_samples, 4);

  const stored = JSON.parse(fs.readFileSync(cfg, "utf8"));
  const { scriptLibrary: _library, ...savedPersistedConfig } = saved.data;
  assert.deepEqual(stored.appmarketPerformance, {
    ...savedPersistedConfig,
    scripts: savedPersistedConfig.scripts.filter((script) => script.managed !== true),
    managedScriptOverrides: {},
  });
  const reloaded = await (await api("/resource-config")).json();
  assert.deepEqual(reloaded.data, saved.data);

  const startedResponse = await api("/resource-run/start", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ serial: "override-serial" }),
  });
  assert.equal(startedResponse.status, 200);
  let status;
  for (let index = 0; index < 30; index++) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    status = await (await api("/resource-run/status")).json();
    if (!status.data.running) break;
  }
  assert.equal(status.data.status, "completed");
  assert.equal(status.data.options.serial, "override-serial");
  assert.equal(status.data.options.duration, 15);
  assert.equal(status.data.options.captureScreenrecord, false);
  assert.equal(status.data.options.capturePerfetto, true);
  assert.equal(status.data.options.samplingMode, "realtime");
  assert.equal(status.data.live.meta.sampling_mode, "realtime");
  assert.equal(status.data.live.diagnosticTotalCount, 4);
  assert.equal(status.data.live.diagnosticSamples.length, 4);
  assert.equal(status.data.live.samples.length, 3);
  assert.equal(status.data.configSnapshot.flow.timeouts.page_ready_s, 45);
  const configPath = rememberControlConfig(status);
  const effectiveFlow = JSON.parse(fs.readFileSync(configPath, "utf8"));
  assert.equal(effectiveFlow.timeouts.home_stable_samples, 4);
  const args = fixtureArgs(status);
  assert.equal(args[args.indexOf("--duration") + 1], "15");
  assert.equal(args[args.indexOf("--interval") + 1], "5");
  assert.equal(args[args.indexOf("--serial") + 1], "override-serial");
  assert.equal(args[args.indexOf("--sampling-mode") + 1], "realtime");
  assert.ok(args.includes("--capture-perfetto"));
  assert.equal(args.includes("--capture-screenrecord"), false);

  const resetResponse = await api("/resource-config", { method: "DELETE" });
  assert.equal(resetResponse.status, 200);
  const reset = await resetResponse.json();
  assert.equal(reset.data.run.captureScreenrecord, true);
  assert.equal(reset.data.run.duration, 180);
  assert.equal(reset.data.run.samplingMode, "standard");
});

test("managed task library recovers stale defaults, persists only overrides, caps overflow, and isolates Python regex failures", async () => {
  const launchManifestPath = path.join(
    taskLibraryRoot,
    "android",
    "appmarket-cpu-memory",
    "profiles",
    "launch-only",
    "task.json",
  );
  const originalLaunchManifest = fs.readFileSync(launchManifestPath, "utf8");
  const transientRoots = [];
  const writeTask = (relativeDir, manifest) => {
    const root = path.join(taskLibraryRoot, ...relativeDir.split("/"));
    transientRoots.push(root);
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(path.join(root, "task.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  };
  const removeTransientRoots = () => {
    for (const root of transientRoots.splice(0)) {
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 });
    }
  };
  const simpleManagedTask = (id, name, flow = {}) => ({
    id,
    name,
    description: "脚本库韧性集成测试任务",
    category: "韧性测试",
    tags: ["integration"],
    version: "1.0.0",
    enabled: true,
    runner: CURRENT_RUNNER_RELATIVE,
    sourceFiles: [],
    run: {},
    flow,
    workflow: {
      steps: [
        { key: "flow", label: "测试结束", eventSteps: ["flow"], modes: ["full", "launch-only"] },
      ],
    },
  });

  try {
    await api("/resource-config", { method: "DELETE" });
    const selectedLaunch = await api("/resource-config", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ defaultScriptId: "appmarket-launch-only" }),
    });
    assert.equal(selectedLaunch.status, 200);

    const disabledManifest = JSON.parse(originalLaunchManifest);
    disabledManifest.enabled = false;
    fs.writeFileSync(launchManifestPath, `${JSON.stringify(disabledManifest, null, 2)}\n`);
    const disabledFallback = await (await api("/resource-config")).json();
    assert.equal(disabledFallback.data.defaultScriptId, "appmarket-default");
    assert.match(
      disabledFallback.data.scriptLibrary.issues.map((issue) => issue.message).join("\n"),
      /持久化默认任务 appmarket-launch-only.*自动回退为 appmarket-default/,
    );
    const disabledExplicitPut = await api("/resource-config", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ defaultScriptId: "appmarket-launch-only" }),
    });
    assert.equal(disabledExplicitPut.status, 400);

    fs.writeFileSync(launchManifestPath, originalLaunchManifest);
    assert.equal((await (await api("/resource-config")).json()).data.defaultScriptId, "appmarket-launch-only");
    fs.rmSync(launchManifestPath, { force: true });
    const missingFallback = await (await api("/resource-config")).json();
    assert.equal(missingFallback.data.defaultScriptId, "appmarket-default");
    assert.match(
      missingFallback.data.scriptLibrary.issues.map((issue) => issue.message).join("\n"),
      /持久化默认任务 appmarket-launch-only.*自动回退为 appmarket-default/,
    );
    const missingExplicitPut = await api("/resource-config", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ defaultScriptId: "appmarket-launch-only" }),
    });
    assert.equal(missingExplicitPut.status, 400);
    fs.writeFileSync(launchManifestPath, originalLaunchManifest);

    const beforeOverride = await (await api("/resource-config")).json();
    const manifestFull = beforeOverride.data.scripts.find((script) => script.id === "appmarket-default");
    const manifestLaunch = beforeOverride.data.scripts.find((script) => script.id === "appmarket-launch-only");
    const staleFullCopy = structuredClone(manifestFull);
    staleFullCopy.name = "不应持久化的旧名称";
    staleFullCopy.runner = "features/PerformanceFeature/step20260714/docs/appmarket_perf_runner.py";
    staleFullCopy.workflow = {
      steps: [{ key: "stale", label: "不应采用", eventSteps: ["stale"], modes: ["full"] }],
    };
    staleFullCopy.run = { ...staleFullCopy.run, duration: 20 };
    staleFullCopy.flow = { timeouts: { page_ready_s: 77 } };
    const disabledLaunchCopy = { ...manifestLaunch, enabled: false };
    const overrideResponse = await api("/resource-config", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        defaultScriptId: "appmarket-default",
        scripts: [staleFullCopy, disabledLaunchCopy],
      }),
    });
    assert.equal(overrideResponse.status, 200);
    const overridden = await overrideResponse.json();
    const overriddenFull = overridden.data.scripts.find((script) => script.id === "appmarket-default");
    assert.equal(overriddenFull.name, manifestFull.name);
    assert.equal(overriddenFull.runner, manifestFull.runner);
    assert.deepEqual(overriddenFull.workflow, manifestFull.workflow);
    assert.equal(overriddenFull.run.duration, 20);
    assert.equal(overriddenFull.flow.timeouts.page_ready_s, 77);
    assert.equal(
      overridden.data.scripts.find((script) => script.id === "appmarket-launch-only").enabled,
      false,
    );

    const persisted = JSON.parse(fs.readFileSync(cfg, "utf8")).appmarketPerformance;
    assert.deepEqual(persisted.scripts, []);
    assert.deepEqual(persisted.managedScriptOverrides, {
      "appmarket-default": {
        run: { duration: 20 },
        flow: { timeouts: { page_ready_s: 77 } },
      },
      "appmarket-launch-only": { enabled: false },
    });
    const reloadedOverrides = await (await api("/resource-config")).json();
    assert.equal(
      reloadedOverrides.data.scripts.find((script) => script.id === "appmarket-default").run.duration,
      20,
    );
    assert.equal(
      reloadedOverrides.data.scripts.find((script) => script.id === "appmarket-launch-only").enabled,
      false,
    );

    await api("/resource-config", { method: "DELETE" });
    for (let index = 0; index < 100; index += 1) {
      const suffix = String(index).padStart(2, "0");
      writeTask(
        `android/appmarket-cpu-memory/profiles/zz-overflow-${suffix}`,
        simpleManagedTask(`resilience-overflow-${suffix}`, `溢出任务 ${suffix}`),
      );
    }
    const capped = await (await api("/resource-config")).json();
    assert.equal(capped.data.scriptLibrary.managedScriptCount, 100);
    assert.equal(capped.data.scripts.filter((script) => script.managed).length, 100);
    assert.equal(
      capped.data.scriptLibrary.issues.filter((issue) => /task.json 超过 100 个/.test(issue.message)).length,
      1,
    );
    removeTransientRoots();

    writeTask(
      "zz-invalid/bad-task",
      simpleManagedTask("resilience-invalid-layout", "目录不规范任务"),
    );
    const isolatedLayout = await (await api("/resource-config")).json();
    assert.equal(isolatedLayout.data.scriptLibrary.managedScriptCount, 2);
    assert.equal(isolatedLayout.data.scripts.some((script) => script.id === "resilience-invalid-layout"), false);
    assert.match(
      isolatedLayout.data.scriptLibrary.issues.map((issue) => issue.message).join("\n"),
      /tasks\/<platform>\/<task-package>\/profiles\/<profile-id>\/task\.json/,
    );
    removeTransientRoots();

    const regexBase = await (await api("/resource-config")).json();
    const badSelectors = structuredClone(regexBase.data.flow.selectors);
    badSelectors.home_ready[0].resource_id_regex = "(?<name>home)";
    writeTask(
      "android/appmarket-cpu-memory/profiles/zz-python-regex",
      simpleManagedTask("resilience-bad-python-regex", "Python 正则错误任务", { selectors: badSelectors }),
    );
    const isolatedRegex = await (await api("/resource-config")).json();
    assert.equal(isolatedRegex.data.scriptLibrary.managedScriptCount, 2);
    assert.equal(isolatedRegex.data.scripts.some((script) => script.id === "resilience-bad-python-regex"), false);
    assert.match(
      isolatedRegex.data.scriptLibrary.issues.map((issue) => issue.message).join("\n"),
      /Python re 正则语法无效/,
    );
  } finally {
    fs.mkdirSync(path.dirname(launchManifestPath), { recursive: true });
    fs.writeFileSync(launchManifestPath, originalLaunchManifest);
    removeTransientRoots();
    await api("/resource-config", { method: "DELETE" });
  }
});

test("resource run selects a configured script and keeps its workflow bound to the run", async () => {
  const initial = await (await api("/resource-config")).json();
  const defaultScript = initial.data.scripts.find((script) => script.id === initial.data.defaultScriptId);
  const alternateScript = {
    id: "launch-smoke",
    name: "首页启动性能冒烟",
    description: "只启动首页并执行短轮采样",
    enabled: true,
    runner: CURRENT_RUNNER_RELATIVE,
    workflow: {
      steps: [
        { key: "boot", label: "启动首页", eventSteps: ["launch"], modes: ["full", "launch-only"] },
        { key: "finish", label: "脚本完成", eventSteps: ["flow"], modes: ["full", "launch-only"] },
      ],
    },
    run: {
      duration: 10,
      interval: 5,
      executeFlow: false,
      captureScreenrecord: false,
    },
    flow: { timeouts: { page_ready_s: 42 } },
  };
  const savedResponse = await api("/resource-config", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ scripts: [defaultScript, alternateScript] }),
  });
  assert.equal(savedResponse.status, 200);
  const saved = await savedResponse.json();
  const savedAlternate = saved.data.scripts.find((script) => script.id === alternateScript.id);
  assert.deepEqual(savedAlternate.run, alternateScript.run);
  assert.deepEqual(savedAlternate.flow, alternateScript.flow);

  const startedResponse = await api("/resource-run/start", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ scriptId: "launch-smoke", serial: "script-device" }),
  });
  assert.equal(startedResponse.status, 200);
  let status;
  for (let index = 0; index < 30; index++) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    status = await (await api("/resource-run/status")).json();
    if (!status.data.running) break;
  }
  assert.equal(status.data.status, "completed");
  assert.equal(status.data.options.scriptId, "launch-smoke");
  assert.equal(status.data.options.duration, 10);
  assert.equal(status.data.options.executeFlow, false);
  assert.equal(status.data.configSnapshot.script.name, "首页启动性能冒烟");
  assert.equal(status.data.configSnapshot.script.workflow.steps[0].key, "boot");
  assert.equal(status.data.configSnapshot.flow.timeouts.page_ready_s, 42);
  const configPath = rememberControlConfig(status);
  const evidence = JSON.parse(fs.readFileSync(configPath, "utf8"));
  assert.deepEqual(evidence._performance_script.workflow, alternateScript.workflow);
  assert.equal(evidence._performance_script.id, "launch-smoke");

  for (const scriptId of ["missing-script", "", 123]) {
    const response = await api("/resource-run/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ scriptId }),
    });
    assert.equal(response.status, 400);
  }

  const disabledScript = { ...alternateScript, enabled: false };
  const disabledSaved = await api("/resource-config", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ scripts: [defaultScript, disabledScript] }),
  });
  assert.equal(disabledSaved.status, 200);
  const disabledStart = await api("/resource-run/start", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ scriptId: "launch-smoke" }),
  });
  assert.equal(disabledStart.status, 400);
  assert.match((await disabledStart.json()).error, /已禁用/);

  await api("/resource-config", { method: "DELETE" });
});

test("resource configuration rejects unsafe and internally inconsistent values", async () => {
  const before = await (await api("/resource-config")).json();
  const compatibleFlow = structuredClone(before.data.flow);
  compatibleFlow.selectors.home_ready[0].resource_id_regex = "(?i)^(?P<page>home)(?s:.*)$";
  compatibleFlow.selectors.catalog_empty[1].text_regex = "(?m:^no apps$)";
  compatibleFlow.selectors.app_card[0].desc_regex = "^(?P<label>(?i:app(?s:.*)))$";
  const compatibleResponse = await api("/resource-config", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ flow: compatibleFlow }),
  });
  assert.equal(compatibleResponse.status, 200);
  const compatible = await compatibleResponse.json();

  const jsOnlyRegexFlow = structuredClone(compatible.data.flow);
  jsOnlyRegexFlow.selectors.home_ready[0].resource_id_regex = "(?<name>home)";
  const jsOnlyResponse = await api("/resource-config", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ flow: jsOnlyRegexFlow }),
  });
  assert.equal(jsOnlyResponse.status, 400);
  const jsOnlyBody = await jsOnlyResponse.json();
  assert.match(jsOnlyBody.error, /Python re 正则语法无效/);
  const afterJsOnly = await (await api("/resource-config")).json();
  assert.deepEqual(afterJsOnly.data, compatible.data);

  const invalidRegexFlow = structuredClone(compatible.data.flow);
  invalidRegexFlow.selectors.home_ready[0].resource_id_regex = "(";
  const defaultScript = compatible.data.scripts[0];
  const customScript = {
    ...structuredClone(defaultScript),
    id: "unsafe-custom-script",
    name: "不安全配置校验脚本",
    managed: false,
    manifestPath: "",
    sourceFiles: [],
  };
  const duplicateEventScript = structuredClone(customScript);
  duplicateEventScript.workflow.steps[1].eventSteps = [duplicateEventScript.workflow.steps[0].eventSteps[0]];
  const invalidModeScript = structuredClone(customScript);
  invalidModeScript.workflow.steps[0].modes = ["full", "background"];
  const cases = [
    { run: { duration: 11, interval: 5 } },
    { run: { script: "powershell -Command calc" } },
    { flow: { selectors: { home_ready: [{ shell: "rm -rf" }] } } },
    { flow: { timeouts: { home_stable_samples: 0 } } },
    { flow: invalidRegexFlow },
    { scripts: [{ ...customScript, runner: "../../outside.py" }] },
    { scripts: [{ ...customScript, runner: "features/PerformanceFeature/missing.py" }] },
    { scripts: [defaultScript, { ...defaultScript, name: "重复脚本" }] },
    { scripts: [duplicateEventScript] },
    { scripts: [invalidModeScript] },
    { defaultScriptId: "missing-script" },
  ];
  for (const value of cases) {
    const response = await api("/resource-config", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(value),
    });
    assert.equal(response.status, 400);
    const body = await response.json();
    assert.equal(body.success, false);
    assert.ok(body.error);
  }
  const afterInvalid = await (await api("/resource-config")).json();
  assert.deepEqual(afterInvalid.data, compatible.data);
});
