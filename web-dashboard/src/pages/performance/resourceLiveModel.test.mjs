import test from "node:test";
import assert from "node:assert/strict";

import {
  applyResourceLiveEvent,
  buildLiveResourceDetail,
  matchingResourceDetail,
  mergeDiagnosticSamples,
  mergeChannelEvents,
  mergeLiveSamples,
  mergeLiveSteps,
  mergeResourceRunSnapshot,
  pendingResourceRunId,
  resourceDetailRunId,
  shouldUseLiveResourceDetail,
} from "./resourceLiveModel.mjs";

test("persisted details are rendered only for the selected run", () => {
  const detail = { run: { id: "run-a" }, samples: [{ sample_index: 1 }] };
  assert.equal(resourceDetailRunId(detail), "run-a");
  assert.strictEqual(matchingResourceDetail(detail, "run-a"), detail);
  assert.equal(matchingResourceDetail(detail, "run-b"), null);
  assert.equal(matchingResourceDetail(null, "run-a"), null);
});

test("new run clears samples from the previous run", () => {
  const previous = {
    runId: "old",
    running: false,
    live: {
      samples: [{ sample_index: 1, pss_mb: 100 }],
      diagnosticSamples: [{ diagnostic_index: 1, rss_mb: 150 }],
      diagnosticTotalCount: 1,
      channelEvents: [{ channel: "old", sequence: 1, values: { value: 1 } }],
    },
  };
  const next = mergeResourceRunSnapshot(previous, {
    runId: "new",
    running: true,
    live: { samples: [], diagnosticSamples: [], diagnosticTotalCount: 0, channelEvents: [] },
  }, { forceNew: true });
  assert.equal(next.runId, "new");
  assert.deepEqual(next.live.samples, []);
  assert.deepEqual(next.live.diagnosticSamples, []);
  assert.equal(next.live.diagnosticTotalCount, 0);
  assert.deepEqual(next.live.channelEvents, []);
});

test("generic channel events merge websocket deltas with polling snapshots", () => {
  const rows = mergeChannelEvents(
    [{ channel: "startup", sequence: 2, values: { elapsed_ms: 800 } }],
    [
      { channel: "startup", sequence: 1, values: { elapsed_ms: 900 } },
      { channel: "startup", sequence: 2, values: { elapsed_ms: 780, stable: true } },
      { channel: "fps", sequence: 3, values: { fps: 59.8 } },
    ],
    3,
  );
  assert.deepEqual(rows.map((event) => `${event.channel}:${event.sequence}`), ["startup:1", "startup:2", "fps:3"]);
  assert.deepEqual(rows[1].values, { elapsed_ms: 780, stable: true });

  const state = applyResourceLiveEvent({ runId: "run-ui", live: {} }, {
    kind: "event",
    runId: "run-ui",
    channelEvent: { channel: "startup", sequence: 4, values: { elapsed_ms: 750 } },
  });
  assert.equal(state.live.channelEvents[0].values.elapsed_ms, 750);
});

test("same-run snapshots append and replace samples without filling null gaps", () => {
  const samples = mergeLiveSamples(
    [{ sample_index: 1, target_elapsed_s: 5, pss_mb: null }],
    [{ sample_index: 2, target_elapsed_s: 10, pss_mb: 120 }, { sample_index: 1, note: "missing" }],
  );
  assert.deepEqual(samples.map((sample) => sample.sample_index), [1, 2]);
  assert.equal(samples[0].pss_mb, null);
  assert.equal(samples[0].note, "missing");
});

test("diagnostic samples merge independently, deduplicate, and keep a bounded tail", () => {
  const samples = mergeDiagnosticSamples(
    [
      { diagnostic_index: 1, cpu_device_normalized_pct: null },
      { diagnostic_index: 2, cpu_device_normalized_pct: 1 },
    ],
    [
      { diagnostic_index: 2, rss_mb: 150, rss_fresh: true },
      { diagnostic_index: 3, cpu_device_normalized_pct: 2 },
    ],
    2,
  );
  assert.deepEqual(samples.map((sample) => sample.diagnostic_index), [2, 3]);
  assert.equal(samples[0].cpu_device_normalized_pct, 1);
  assert.equal(samples[0].rss_mb, 150);
});

test("websocket diagnostic deltas and polling snapshots retain total count without entering formal samples", () => {
  const current = {
    runId: "current",
    running: true,
    live: {
      samples: [{ sample_index: 1, pss_mb: 100 }],
      diagnosticSamples: [{ diagnostic_index: 1, cpu_device_normalized_pct: null }],
      diagnosticTotalCount: 1,
    },
  };
  const afterEvent = applyResourceLiveEvent(current, {
    kind: "diagnostic",
    runId: "current",
    diagnosticSample: { diagnostic_index: 2, cpu_device_normalized_pct: 1.5, rss_mb: 151 },
    diagnosticTotalCount: 2,
  });
  const afterSnapshot = mergeResourceRunSnapshot(afterEvent, {
    runId: "current",
    running: true,
    live: {
      diagnosticSamples: [
        { diagnostic_index: 2, cpu_device_normalized_pct: 1.5, rss_mb: 151 },
        { diagnostic_index: 3, cpu_device_normalized_pct: 2 },
      ],
      diagnosticTotalCount: 3,
    },
  });
  assert.deepEqual(afterSnapshot.live.samples.map((sample) => sample.sample_index), [1]);
  assert.deepEqual(afterSnapshot.live.diagnosticSamples.map((sample) => sample.diagnostic_index), [1, 2, 3]);
  assert.equal(afterSnapshot.live.diagnosticTotalCount, 3);
});

test("step history merges websocket events with polling snapshots without duplicates", () => {
  const history = mergeLiveSteps(
    [{ sequence: 1, step: "launch", status: "started" }],
    [
      { sequence: 1, step: "launch", status: "started", message: "应用市场" },
      { sequence: 2, step: "launch", status: "passed" },
    ],
  );
  assert.deepEqual(history.map((step) => step.sequence), [1, 2]);
  assert.equal(history[0].message, "应用市场");
});

test("live step events remain isolated to the active run", () => {
  const current = { runId: "current", running: true, live: { stepHistory: [] } };
  const updated = applyResourceLiveEvent(current, {
    kind: "step",
    runId: "current",
    currentStep: { sequence: 1, step: "launch", status: "started" },
    stepEvent: { sequence: 1, step: "launch", status: "started" },
  });
  assert.equal(updated.live.stepHistory.length, 1);
  const stale = applyResourceLiveEvent(updated, {
    kind: "step",
    runId: "other",
    stepEvent: { sequence: 2, step: "open_detail", status: "clicked" },
  });
  assert.strictEqual(stale, updated);
});

test("events from a different run cannot contaminate the active run", () => {
  const current = { runId: "current", running: true, live: { samples: [{ sample_index: 1 }] } };
  const result = applyResourceLiveEvent(current, { kind: "sample", runId: "stale", sample: { sample_index: 2 } });
  assert.strictEqual(result, current);
});

test("pending run resolves to the gateway run id", () => {
  const pending = { runId: pendingResourceRunId(), running: true, live: { samples: [] } };
  const resolved = mergeResourceRunSnapshot(pending, { runId: "real-id", running: true, live: { meta: { runId: "real-id" } } });
  assert.equal(resolved.runId, "real-id");
});

test("a stale terminal status cannot replace an optimistic pending run", () => {
  const pending = { runId: pendingResourceRunId(), running: true, status: "starting", live: { samples: [] } };
  const result = mergeResourceRunSnapshot(pending, { runId: "old-id", running: false, status: "completed" });
  assert.strictEqual(result, pending);
});

test("live detail computes provisional CPU and PSS aggregates", () => {
  const detail = buildLiveResourceDetail({
    runId: "run-1",
    options: { duration: 20, interval: 5, samplingMode: "standard" },
    live: {
      meta: { serial: "device-1", sampling_mode: "realtime" },
      samples: [
        { sample_index: 1, cpu_device_normalized_pct: 1, cpu_one_core_equiv_pct: 8, pss_mb: 100 },
        { sample_index: 2, cpu_device_normalized_pct: 3, cpu_one_core_equiv_pct: 12, pss_mb: 140 },
      ],
      diagnosticSamples: [
        { diagnostic_index: 1, cpu_device_normalized_pct: 99, rss_mb: 999 },
      ],
      diagnosticTotalCount: 1,
    },
  });
  assert.equal(detail.profile.sampling.actual_rows, 2);
  assert.equal(detail.profile.sampling.expected_rows, 4);
  assert.equal(detail.profile.measurements.cpu_device_normalized_pct.mean, 2);
  assert.equal(detail.profile.measurements.pss_mb.peak, 140);
  assert.equal(detail.profile.sampling.sampling_mode, "realtime");
  assert.equal(detail.profile.diagnostic.sampling_mode, "realtime");
  assert.equal(detail.profile.diagnostic.actual_rows, 1);
  assert.deepEqual(detail.diagnosticSamples, [
    { diagnostic_index: 1, cpu_device_normalized_pct: 99, rss_mb: 999 },
  ]);
  assert.equal(detail.diagnosticTotalCount, 1);
  assert.equal(detail.acceptance, "INCONCLUSIVE");
});

test("only a successfully completed run may switch from live data to matching persisted detail", () => {
  const detail = { run: { id: "run-1" } };
  assert.equal(shouldUseLiveResourceDetail({ runId: "run-1", status: "running" }, "run-1", true, detail), true);
  assert.equal(shouldUseLiveResourceDetail({ runId: "run-1", status: "completed_with_upload_error" }, "run-1", false, detail), true);
  assert.equal(shouldUseLiveResourceDetail({ runId: "run-1", status: "completed" }, "run-1", false, detail), false);
  assert.equal(shouldUseLiveResourceDetail({ runId: "run-1", status: "completed" }, "other", false, detail), false);
});
