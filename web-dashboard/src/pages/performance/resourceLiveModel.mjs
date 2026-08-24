const PENDING_RUN_ID = "__resource_run_starting__";
const MAX_DIAGNOSTIC_SAMPLES = 1200;
const MAX_CHANNEL_EVENTS = 600;

function asObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function finite(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function runIdOf(value) {
  return String(value?.runId || value?.live?.meta?.runId || "").trim();
}

function sampleKey(sample, fallbackIndex = 0) {
  const index = finite(sample?.sample_index ?? sample?.sampleIndex);
  if (index !== null) return `index:${index}`;
  const target = finite(sample?.target_elapsed_s ?? sample?.targetElapsedS);
  if (target !== null) return `target:${target}`;
  return `fallback:${fallbackIndex}`;
}

export function mergeLiveSamples(previous = [], incoming = []) {
  const rows = new Map();
  (Array.isArray(previous) ? previous : []).forEach((sample, index) => {
    rows.set(sampleKey(sample, index), sample);
  });
  (Array.isArray(incoming) ? incoming : []).forEach((sample, index) => {
    const key = sampleKey(sample, rows.size + index);
    rows.set(key, { ...asObject(rows.get(key)), ...asObject(sample) });
  });
  return [...rows.values()].sort((left, right) => {
    const leftIndex = finite(left?.sample_index ?? left?.sampleIndex);
    const rightIndex = finite(right?.sample_index ?? right?.sampleIndex);
    if (leftIndex !== null && rightIndex !== null) return leftIndex - rightIndex;
    const leftTarget = finite(left?.target_elapsed_s ?? left?.targetElapsedS) ?? Number.MAX_SAFE_INTEGER;
    const rightTarget = finite(right?.target_elapsed_s ?? right?.targetElapsedS) ?? Number.MAX_SAFE_INTEGER;
    return leftTarget - rightTarget;
  });
}

function diagnosticKey(sample, fallbackIndex = 0) {
  const index = finite(sample?.diagnostic_index ?? sample?.diagnosticIndex);
  return index !== null ? `diagnostic:${index}` : `fallback:${fallbackIndex}`;
}

export function mergeDiagnosticSamples(previous = [], incoming = [], limit = MAX_DIAGNOSTIC_SAMPLES) {
  const rows = new Map();
  (Array.isArray(previous) ? previous : []).forEach((sample, index) => {
    rows.set(diagnosticKey(sample, index), sample);
  });
  (Array.isArray(incoming) ? incoming : []).forEach((sample, index) => {
    const key = diagnosticKey(sample, rows.size + index);
    rows.set(key, { ...asObject(rows.get(key)), ...asObject(sample) });
  });
  const bounded = Math.max(1, Math.min(MAX_DIAGNOSTIC_SAMPLES, Math.trunc(Number(limit) || MAX_DIAGNOSTIC_SAMPLES)));
  return [...rows.values()]
    .sort((left, right) => {
      const leftIndex = finite(left?.diagnostic_index ?? left?.diagnosticIndex) ?? Number.MAX_SAFE_INTEGER;
      const rightIndex = finite(right?.diagnostic_index ?? right?.diagnosticIndex) ?? Number.MAX_SAFE_INTEGER;
      return leftIndex - rightIndex;
    })
    .slice(-bounded);
}

function channelEventKey(event, fallbackIndex = 0) {
  const channel = String(event?.channel || "").trim();
  const sequence = finite(event?.sequence ?? event?.seq);
  return channel && sequence !== null ? `${channel}:${sequence}` : `fallback:${fallbackIndex}`;
}

export function mergeChannelEvents(previous = [], incoming = [], limit = MAX_CHANNEL_EVENTS) {
  const rows = new Map();
  (Array.isArray(previous) ? previous : []).forEach((event, index) => {
    rows.set(channelEventKey(event, index), { ...asObject(event), values: { ...asObject(event?.values) } });
  });
  (Array.isArray(incoming) ? incoming : []).forEach((event, index) => {
    const key = channelEventKey(event, rows.size + index);
    const prior = asObject(rows.get(key));
    rows.set(key, {
      ...prior,
      ...asObject(event),
      values: { ...asObject(prior.values), ...asObject(event?.values) },
    });
  });
  const bounded = Math.max(1, Math.min(MAX_CHANNEL_EVENTS, Math.trunc(Number(limit) || MAX_CHANNEL_EVENTS)));
  return [...rows.values()]
    .sort((left, right) => {
      const leftSequence = finite(left?.sequence ?? left?.seq) ?? Number.MAX_SAFE_INTEGER;
      const rightSequence = finite(right?.sequence ?? right?.seq) ?? Number.MAX_SAFE_INTEGER;
      return leftSequence - rightSequence || String(left?.channel || "").localeCompare(String(right?.channel || ""));
    })
    .slice(-bounded);
}

function stepKey(step, fallbackIndex = 0) {
  const sequence = finite(step?.sequence);
  if (sequence !== null) return `sequence:${sequence}`;
  const parts = [step?.at, step?.step, step?.status, step?.message]
    .map((value) => String(value ?? "").trim());
  return parts.some(Boolean) ? parts.join("\u0000") : `fallback:${fallbackIndex}`;
}

export function mergeLiveSteps(previous = [], incoming = [], limit = 240) {
  const events = new Map();
  (Array.isArray(previous) ? previous : []).forEach((step, index) => {
    events.set(stepKey(step, index), { ...asObject(step) });
  });
  (Array.isArray(incoming) ? incoming : []).forEach((step, index) => {
    const key = stepKey(step, events.size + index);
    events.set(key, { ...asObject(events.get(key)), ...asObject(step) });
  });
  const bounded = Math.max(1, Math.min(1000, Math.trunc(Number(limit) || 240)));
  return [...events.values()]
    .sort((left, right) => {
      const leftSequence = finite(left?.sequence);
      const rightSequence = finite(right?.sequence);
      if (leftSequence !== null && rightSequence !== null) return leftSequence - rightSequence;
      return String(left?.at || "").localeCompare(String(right?.at || ""));
    })
    .slice(-bounded);
}

export function mergeResourceRunSnapshot(previous = {}, incoming = {}, { forceNew = false } = {}) {
  const prev = asObject(previous);
  const next = asObject(incoming);
  const previousId = runIdOf(prev);
  const incomingId = runIdOf(next);
  const pendingCanResolve = previousId === PENDING_RUN_ID
    && incomingId
    && incomingId !== PENDING_RUN_ID
    && (next.running || ["starting", "running", "stopping"].includes(next.status));

  if (!forceNew && previousId && incomingId && previousId !== incomingId && !pendingCanResolve) {
    return prev;
  }
  if (!forceNew && previousId && !incomingId && prev.running && next.status === "idle") {
    return prev;
  }

  const sameRun = !forceNew && previousId && incomingId && previousId === incomingId;
  const previousLive = sameRun ? asObject(prev.live) : {};
  const incomingLive = asObject(next.live);
  const samples = mergeLiveSamples(
    previousLive.samples,
    Array.isArray(incomingLive.samples) ? incomingLive.samples : [],
  );
  const diagnosticSamples = mergeDiagnosticSamples(
    previousLive.diagnosticSamples,
    Array.isArray(incomingLive.diagnosticSamples) ? incomingLive.diagnosticSamples : [],
  );
  const latestDiagnosticIndex = diagnosticSamples.reduce((maximum, sample) => (
    Math.max(maximum, finite(sample?.diagnostic_index ?? sample?.diagnosticIndex) ?? 0)
  ), 0);
  const diagnosticTotalCount = Math.max(
    finite(previousLive.diagnosticTotalCount) ?? 0,
    finite(incomingLive.diagnosticTotalCount) ?? 0,
    latestDiagnosticIndex,
  );
  const stepHistory = mergeLiveSteps(
    previousLive.stepHistory,
    Array.isArray(incomingLive.stepHistory) ? incomingLive.stepHistory : [],
  );
  const channelEvents = mergeChannelEvents(
    previousLive.channelEvents,
    Array.isArray(incomingLive.channelEvents) ? incomingLive.channelEvents : [],
  );
  const live = {
    ...previousLive,
    ...incomingLive,
    meta: { ...asObject(previousLive.meta), ...asObject(incomingLive.meta) },
    progress: { ...asObject(previousLive.progress), ...asObject(incomingLive.progress) },
    samples,
    diagnosticSamples,
    diagnosticTotalCount,
    channelEvents,
    stepHistory,
  };

  return {
    ...(sameRun ? prev : {}),
    ...next,
    live,
    logs: Array.isArray(next.logs) ? next.logs : (sameRun && Array.isArray(prev.logs) ? prev.logs : []),
  };
}

export function applyResourceLiveEvent(previous = {}, event = {}) {
  const prev = asObject(previous);
  const data = asObject(event);
  const previousId = runIdOf(prev);
  const eventId = String(data.runId || data.meta?.runId || data.live?.meta?.runId || "").trim();
  if (previousId && previousId !== PENDING_RUN_ID && eventId && previousId !== eventId) return prev;

  if (data.kind === "state") {
    return mergeResourceRunSnapshot(prev, {
      ...data,
      runId: eventId || previousId,
      live: data.live,
    });
  }

  const livePatch = {
    phase: data.phase,
    ...(data.kind === "meta" ? { meta: data.meta } : {}),
    ...(data.kind === "sample" ? { samples: data.sample ? [data.sample] : [], progress: data.progress } : {}),
    ...(data.kind === "diagnostic" ? {
      diagnosticSamples: data.diagnosticSample ? [data.diagnosticSample] : [],
      diagnosticTotalCount: data.diagnosticTotalCount,
    } : {}),
    ...(data.kind === "step" ? {
      currentStep: data.currentStep,
      stepHistory: data.stepEvent ? [data.stepEvent] : [],
    } : {}),
    ...(data.kind === "event" ? {
      channelEvents: data.channelEvent ? [data.channelEvent] : [],
    } : {}),
  };
  return mergeResourceRunSnapshot(prev, {
    runId: eventId || previousId,
    live: livePatch,
  });
}

function metricStats(samples, key) {
  const values = samples.map((sample) => finite(sample?.[key])).filter((value) => value !== null);
  if (!values.length) return { count: 0, mean: null, peak: null, min: null };
  return {
    count: values.length,
    mean: values.reduce((sum, value) => sum + value, 0) / values.length,
    peak: Math.max(...values),
    min: Math.min(...values),
  };
}

export function buildLiveResourceDetail(run = {}) {
  const value = asObject(run);
  const live = asObject(value.live);
  const meta = asObject(live.meta);
  const progress = asObject(live.progress);
  const options = asObject(value.options);
  const samples = Array.isArray(live.samples) ? live.samples : [];
  const diagnosticSamples = Array.isArray(live.diagnosticSamples) ? live.diagnosticSamples : [];
  const samplingMode = meta.sampling_mode === "realtime" || options.samplingMode === "realtime"
    ? "realtime"
    : "standard";
  const duration = finite(progress.durationS ?? meta.duration_s ?? options.duration);
  const interval = finite(progress.intervalS ?? meta.interval_s ?? options.interval);
  const expected = finite(progress.expectedSamples ?? meta.expected_samples)
    ?? (duration !== null && interval ? Math.round(duration / interval) : null);
  const validRows = samples.filter((sample) => (
    finite(sample?.cpu_device_normalized_pct) !== null
    || finite(sample?.cpu_one_core_equiv_pct) !== null
    || finite(sample?.pss_mb) !== null
  )).length;
  const logicalCpus = [...new Set(samples
    .map((sample) => finite(sample?.logical_cpus))
    .filter((number) => number !== null))];
  const id = runIdOf(value) || PENDING_RUN_ID;
  const device = asObject(meta.device);

  return {
    isLive: true,
    run: {
      id,
      createdAt: value.startedAt || "",
      deviceBrand: device.brand || meta.brand || "",
      deviceModel: device.model || meta.model || "",
      deviceId: meta.serial || options.serial || "",
      flavor: options.flavor || "",
      acceptance: "INCONCLUSIVE",
      round: id,
      options: { ...options, samplingMode },
    },
    profile: {
      acceptance: "INCONCLUSIVE",
      sampling: {
        actual_rows: samples.length,
        expected_rows: expected,
        valid_sample_ratio: samples.length ? validRows / samples.length : null,
        interval_s: interval,
        duration_s: duration,
        sampling_mode: samplingMode,
      },
      measurements: {
        cpu_device_normalized_pct: metricStats(samples, "cpu_device_normalized_pct"),
        cpu_multi_core_pct: metricStats(samples, "cpu_one_core_equiv_pct"),
        pss_mb: metricStats(samples, "pss_mb"),
        rss_mb: metricStats(samples, "rss_mb"),
        logical_cpu_values: logicalCpus,
      },
      flow: {
        status: live.phase || "running",
        current_step: live.currentStep || null,
      },
      diagnostic: {
        enabled: samplingMode === "realtime",
        sampling_mode: samplingMode,
        actual_rows: finite(live.diagnosticTotalCount) ?? diagnosticSamples.length,
        collector: {
          cpu_interval_ms: finite(meta.cpu_interval_ms) ?? 500,
          rss_interval_ms: finite(meta.rss_interval_ms) ?? 1000,
          pss_interval_ms: finite(meta.pss_interval_ms) ?? ((interval ?? 5) * 1000),
        },
        measurements: {
          cpu_device_normalized_pct: metricStats(diagnosticSamples, "cpu_device_normalized_pct"),
          rss_mb: metricStats(diagnosticSamples, "rss_mb"),
        },
      },
    },
    flowEvents: Array.isArray(live.stepHistory) ? live.stepHistory : [],
    samples,
    diagnosticSamples,
    diagnosticTotalCount: finite(live.diagnosticTotalCount) ?? diagnosticSamples.length,
    channelEvents: Array.isArray(live.channelEvents) ? live.channelEvents : [],
    acceptance: "INCONCLUSIVE",
  };
}

export function resourceLiveRunId(run = {}) {
  return runIdOf(run);
}

export function resourceDetailRunId(detail) {
  return String(
    detail?.run?.id
    || detail?.id
    || detail?.sessionId
    || detail?.session_id
    || "",
  ).trim();
}

export function matchingResourceDetail(detail, selectedId) {
  const expected = String(selectedId || "").trim();
  return expected && resourceDetailRunId(detail) === expected ? detail : null;
}

export function shouldUseLiveResourceDetail(liveRun, selectedId, active, persistedDetail) {
  const liveId = runIdOf(liveRun);
  if (!liveId || selectedId !== liveId) return false;
  const persistedId = resourceDetailRunId(persistedDetail);
  return !!active || liveRun?.status !== "completed" || !persistedId || persistedId !== liveId;
}

export function pendingResourceRunId() {
  return PENDING_RUN_ID;
}
