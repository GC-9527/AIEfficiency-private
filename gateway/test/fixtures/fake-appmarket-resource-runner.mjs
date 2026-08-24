import fs from "node:fs";

const args = process.argv.slice(2);
const value = (name) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : "";
};
const stopFile = value("--stop-file");
const runId = value("--run-id") || "fixture";
const testAppTitle = value("--test-app-title");
const uploadStatus = testAppTitle === "__upload_fail__" ? "failed" : "uploaded";
const omitUploadStatus = testAppTitle === "__upload_missing__";
const serial = value("--serial") || "mock-auto-device";
const duration = Number(value("--duration") || 10);
const interval = Number(value("--interval") || 5);
const samplingMode = value("--sampling-mode") || "standard";
const expectedSamples = Math.max(1, Math.round(duration / interval));
const artifactDir = `docs/tempFiles/appmarket-performance/${runId}`;

console.log(`fixture start ${runId}`);
console.log(`ARGS_JSON=${JSON.stringify(args)}`);
console.log(`PYTHON_ENCODING_JSON=${JSON.stringify({
  pythonUtf8: process.env.PYTHONUTF8 || "",
  pythonIoEncoding: process.env.PYTHONIOENCODING || "",
})}`);
console.log(`ARTIFACT_DIR=${artifactDir}`);
console.log(`LIVE_META_JSON=${JSON.stringify({
  runId,
  serial,
  duration_s: duration,
  interval_s: interval,
  sampling_mode: samplingMode,
  ...(samplingMode === "realtime" ? {
    cpu_interval_ms: 500,
    rss_interval_ms: 1000,
    pss_interval_ms: 5000,
  } : {}),
  expected_samples: expectedSamples,
  artifact_dir: artifactDir,
  phase: "collecting",
})}`);
console.log("[flow] launch: started - com.appmarket.automotive");
console.log("[flow] launch: passed - 应用市场首页已完全加载并稳定");
console.log(`LIVE_EVENT_JSON=${JSON.stringify({
  channel: "fixture.progress",
  sequence: 1,
  runId,
  elapsed_s: 0.125,
  message: "fixture sample stream started",
  values: {
    sample_target: expectedSamples,
    ready: true,
    nested_value: { ignored: true },
  },
  private_value: "ignored",
})}`);
const started = Date.now();
let emittedSamples = 0;
let emittedDiagnosticSamples = 0;
const timer = setInterval(() => {
  if (stopFile && fs.existsSync(stopFile)) {
    console.log("fixture cancelled");
    clearInterval(timer);
    process.exitCode = 130;
    return;
  }
  const nextDue = 35 + emittedSamples * 55;
  if (samplingMode === "realtime" && emittedDiagnosticSamples < 4) {
    emittedDiagnosticSamples += 1;
    console.log(`LIVE_DIAGNOSTIC_JSON=${JSON.stringify({
      diagnostic_index: emittedDiagnosticSamples,
      source_timestamp_s: emittedDiagnosticSamples * 0.5,
      cpu_window_duration_s: 0.5,
      rss_source_timestamp_s: emittedDiagnosticSamples % 2 === 0 ? emittedDiagnosticSamples * 0.5 : null,
      wall_time_local: "2026-07-15 12:00:00",
      pids: "100;101",
      process_names: "com.appmarket.automotive;com.appmarket.automotive:worker",
      logical_cpus: 8,
      cpu_one_core_equiv_pct: emittedDiagnosticSamples === 1 ? null : emittedDiagnosticSamples * 2,
      cpu_device_normalized_pct: emittedDiagnosticSamples === 1 ? null : emittedDiagnosticSamples * 0.25,
      rss_mb: emittedDiagnosticSamples % 2 === 0 ? 150 + emittedDiagnosticSamples : null,
      metric_source: "procfs_stream",
      rss_fresh: emittedDiagnosticSamples % 2 === 0,
      note: emittedDiagnosticSamples === 1 ? "cpu_baseline" : "",
    })}`);
  }
  if (emittedSamples < expectedSamples && Date.now() - started >= nextDue) {
    emittedSamples += 1;
    console.log(`LIVE_SAMPLE_JSON=${JSON.stringify({
      sample_index: emittedSamples,
      target_elapsed_s: emittedSamples * interval,
      actual_elapsed_s: emittedSamples * interval + 0.125,
      wall_time_local: "2026-07-15 12:00:00",
      pids: "100;101",
      process_names: "com.appmarket.automotive;com.appmarket.automotive:worker",
      logical_cpus: 8,
      cpu_one_core_equiv_pct: emittedSamples * 4.25,
      cpu_device_normalized_pct: emittedSamples * 0.53125,
      pss_mb: 120 + emittedSamples,
      rss_mb: 150 + emittedSamples,
      process_set_changed: emittedSamples === 1 ? 1 : 0,
      collection_latency_s: 0.25,
      note: emittedSamples === 1 ? "process_set_changed_cpu_interval_invalid" : "",
    })}`);
  }
  if (Date.now() - started >= 250) {
    if (!omitUploadStatus) console.log(`UPLOAD=${uploadStatus}`);
    console.log(`RESULT_JSON=${artifactDir}/analysis/report.json`);
    console.log(`ARTIFACT_DIR=${artifactDir}`);
    clearInterval(timer);
  }
}, 25);
