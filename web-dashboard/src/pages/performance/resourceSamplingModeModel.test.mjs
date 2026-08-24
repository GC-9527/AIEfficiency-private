import test from "node:test";
import assert from "node:assert/strict";

import {
  applySamplingModeChange,
  normalizeSamplingMode,
  parseDiagnosticCsv,
  resolveDisplayedSamplingMode,
  resolveSamplingMode,
  samplingModeDescriptor,
} from "./resourceSamplingModeModel.mjs";

test("sampling mode normalization defaults unknown values to standard", () => {
  assert.equal(normalizeSamplingMode("standard"), "standard");
  assert.equal(normalizeSamplingMode("realtime"), "realtime");
  assert.equal(normalizeSamplingMode("REALTIME"), "standard");
  assert.equal(normalizeSamplingMode(""), "standard");
  assert.equal(normalizeSamplingMode(null), "standard");
});

test("historical mode never falls back to the editable next-run form", () => {
  assert.equal(resolveDisplayedSamplingMode({
    isLive: false,
    form: { samplingMode: "realtime" },
    run: { id: "legacy-run" },
    detail: { profile: { sampling: { interval_s: 5 } } },
  }), "standard");

  assert.equal(resolveDisplayedSamplingMode({
    isLive: true,
    form: { samplingMode: "realtime" },
    run: { id: "pending-run" },
  }), "realtime");
});

test("actual run mode takes priority over an editable form mode", () => {
  assert.equal(resolveSamplingMode({
    form: { samplingMode: "standard" },
    run: {
      options: { samplingMode: "standard" },
      live: { meta: { sampling_mode: "realtime" } },
    },
  }), "realtime");

  assert.equal(resolveSamplingMode({
    form: { samplingMode: "standard" },
    detail: {
      configSnapshot: { run: { samplingMode: "standard" } },
      profile: { diagnostic: { sampling_mode: "realtime" } },
    },
  }), "realtime");
});

test("switching to realtime enforces the formal interval and Perfetto capture", () => {
  assert.deepEqual(applySamplingModeChange({
    interval: 2,
    capturePerfetto: false,
    duration: 60,
  }, "realtime"), {
    interval: 5,
    capturePerfetto: true,
    duration: 60,
    samplingMode: "realtime",
  });

  assert.deepEqual(applySamplingModeChange({
    interval: 10,
    capturePerfetto: true,
  }, "standard"), {
    interval: 10,
    capturePerfetto: true,
    samplingMode: "standard",
  });
});

test("standard and realtime descriptors state their distinct trend semantics", () => {
  const standard = samplingModeDescriptor("standard", { formalIntervalS: 5 });
  assert.equal(standard.label, "标准验收");
  assert.equal(standard.formalCpuTitle, "标准验收 CPU 趋势（每 5 秒）");
  assert.equal(standard.formalMemoryTitle, "标准验收内存趋势（PSS 每 5 秒，RSS 辅助）");
  assert.equal(standard.isRealtime, false);

  const realtime = samplingModeDescriptor("realtime", {
    formalIntervalS: 5,
    diagnostic: {
      collector: { cpu_interval_ms: 500, rss_interval_ms: 1000, pss_interval_ms: 5000 },
    },
  });
  assert.equal(realtime.label, "实时诊断");
  assert.equal(realtime.formalCpuTitle, "正式验收 CPU 趋势（每 5 秒）");
  assert.equal(realtime.formalMemoryTitle, "正式验收内存趋势（PSS 每 5 秒，RSS 辅助）");
  assert.equal(realtime.diagnosticCpuTitle, "实时诊断 CPU 趋势（500ms）");
  assert.equal(realtime.diagnosticRssTitle, "实时诊断 RSS 趋势（1 秒）");
  assert.match(realtime.description, /Perfetto/);
  assert.equal(realtime.isRealtime, true);
});

test("diagnostic CSV parsing handles typed and quoted values and keeps the requested tail", () => {
  const csv = [
    "diagnostic_index,target_elapsed_s,cpu_device_normalized_pct,rss_mb,rss_fresh,note",
    "1,0.5,1.25,120.5,true,first",
    "2,1,2.5,121,0,\"contains, comma\"",
    "3,1.5,,122,yes,\"quoted \"\"value\"\"\"",
  ].join("\r\n");

  const samples = parseDiagnosticCsv(csv, 2);
  assert.deepEqual(samples.map((sample) => sample.diagnostic_index), [2, 3]);
  assert.equal(samples[0].target_elapsed_s, 1);
  assert.equal(samples[0].cpu_device_normalized_pct, 2.5);
  assert.equal(samples[0].rss_fresh, false);
  assert.equal(samples[0].note, "contains, comma");
  assert.equal(samples[1].cpu_device_normalized_pct, null);
  assert.equal(samples[1].rss_fresh, true);
  assert.equal(samples[1].note, 'quoted "value"');
});
