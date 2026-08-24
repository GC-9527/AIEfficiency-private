import test from "node:test";
import assert from "node:assert/strict";

import { summarizeResourceRuns } from "./resourceSummaryModel.mjs";

function run(overrides = {}) {
  return {
    id: "run-1",
    createdAt: "2026-07-15 12:00:00",
    acceptance: "PASS",
    flavor: "avatr8678",
    appVersion: "1.2.60",
    sampling: { valid_sample_ratio: 1 },
    measurements: {
      cpu_device_normalized_pct: { mean: 1, peak: 3 },
      cpu_multi_core_pct: { peak: 15 },
      pss_mb: { mean: 130, peak: 180 },
    },
    ...overrides,
  };
}

test("overall summary aggregates recent runs without merging their raw samples", () => {
  const summary = summarizeResourceRuns([
    run(),
    run({
      id: "run-2",
      createdAt: "2026-07-16 12:00:00",
      acceptance: "FAIL",
      sampling: { valid_sample_ratio: 0.5 },
      measurements: {
        cpu_device_normalized_pct: { mean: 3, peak: 5 },
        cpu_multi_core_pct: { peak: 25 },
        pss_mb: { mean: 150, peak: 200 },
      },
    }),
  ]);
  assert.equal(summary.total, 2);
  assert.equal(summary.pass, 1);
  assert.equal(summary.fail, 1);
  assert.equal(summary.passRate, 0.5);
  assert.equal(summary.averageValidSampleRatio, 0.75);
  assert.equal(summary.cpuSinglePeakAverage, 4);
  assert.equal(summary.cpuSingleMeanAverage, 2);
  assert.equal(summary.pssMeanAverage, 140);
  assert.equal(summary.latest.id, "run-2");
});

test("missing metrics stay null instead of pretending to be zero", () => {
  const summary = summarizeResourceRuns([run({ measurements: {}, sampling: {} })]);
  assert.equal(summary.cpuSinglePeakAverage, null);
  assert.equal(summary.cpuSingleMeanAverage, null);
  assert.equal(summary.pssPeakAverage, null);
  assert.equal(summary.averageValidSampleRatio, null);
});

test("summary groups by flavor and version and bounds the visible scope", () => {
  const input = Array.from({ length: 105 }, (_, index) => run({
    id: `run-${index}`,
    flavor: index % 2 ? "avatr8678" : "avatr8155",
    appVersion: index % 3 ? "1.2.60" : "1.2.59",
    createdAt: `2026-07-${String((index % 28) + 1).padStart(2, "0")} 12:00:00`,
  }));
  const summary = summarizeResourceRuns(input);
  assert.equal(summary.total, 100);
  assert.ok(summary.groups.length >= 4);
  assert.equal(summary.recent.length, 12);
});
