const STANDARD = "standard";
const REALTIME = "realtime";
const MAX_DIAGNOSTIC_SAMPLES = 1200;

function finite(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function candidate(value) {
  return value === REALTIME ? REALTIME : value === STANDARD ? STANDARD : "";
}

export function normalizeSamplingMode(value) {
  return candidate(value) || STANDARD;
}

export function applySamplingModeChange(form = {}, value) {
  const samplingMode = normalizeSamplingMode(value);
  return {
    ...(form && typeof form === "object" && !Array.isArray(form) ? form : {}),
    samplingMode,
    ...(samplingMode === REALTIME ? { interval: 5, capturePerfetto: true } : {}),
  };
}

export function resolveSamplingMode({ form, run, detail } = {}) {
  const profile = detail?.profile || detail?.resourceProfile || {};
  const values = [
    run?.live?.meta?.sampling_mode,
    run?.options?.samplingMode,
    run?.options?.sampling_mode,
    detail?.live?.meta?.sampling_mode,
    detail?.run?.options?.samplingMode,
    profile?.diagnostic?.sampling_mode,
    profile?.sampling?.sampling_mode,
    profile?.sampling?.mode,
    detail?.diagnostic?.sampling_mode,
    detail?.run?.diagnostic?.sampling_mode,
    detail?.configSnapshot?.run?.samplingMode,
    form?.samplingMode,
  ];
  return values.map(candidate).find(Boolean) || STANDARD;
}

export function resolveDisplayedSamplingMode({ isLive = false, form, run, detail } = {}) {
  return resolveSamplingMode({
    form: isLive ? form : undefined,
    run,
    detail,
  });
}

export function samplingModeDescriptor(value, { formalIntervalS = 5, diagnostic = {} } = {}) {
  const mode = normalizeSamplingMode(value);
  const collector = diagnostic?.collector && typeof diagnostic.collector === "object"
    ? diagnostic.collector
    : diagnostic;
  const cpuIntervalMs = finite(collector?.cpu_interval_ms) ?? 500;
  const rssIntervalMs = finite(collector?.rss_interval_ms) ?? 1000;
  const pssIntervalMs = finite(collector?.pss_interval_ms) ?? formalIntervalS * 1000;
  const formalSeconds = finite(formalIntervalS) ?? 5;

  if (mode === REALTIME) {
    return {
      mode,
      label: "实时诊断",
      shortLabel: "实时诊断",
      description: `CPU ${cpuIntervalMs}ms、RSS ${rssIntervalMs / 1000} 秒实时诊断；正式 CPU/PSS 仍每 ${pssIntervalMs / 1000} 秒用于阈值验收，结束后自动执行 Perfetto 校验。`,
      cadence: `CPU ${cpuIntervalMs}ms · RSS ${rssIntervalMs / 1000}s · 正式 CPU/PSS ${pssIntervalMs / 1000}s · Perfetto`,
      formalCpuTitle: `正式验收 CPU 趋势（每 ${formalSeconds} 秒）`,
      formalMemoryTitle: `正式验收内存趋势（PSS 每 ${formalSeconds} 秒，RSS 辅助）`,
      diagnosticCpuTitle: `实时诊断 CPU 趋势（${cpuIntervalMs}ms）`,
      diagnosticRssTitle: `实时诊断 RSS 趋势（${rssIntervalMs / 1000} 秒）`,
      isRealtime: true,
    };
  }

  return {
    mode,
    label: "标准验收",
    shortLabel: "标准验收",
    description: `CPU/PSS 每 ${formalSeconds} 秒采集并直接参与现有阈值验收；不启用高频 CPU/RSS 诊断轨道。`,
    cadence: `正式 CPU/PSS 每 ${formalSeconds}s`,
    formalCpuTitle: `标准验收 CPU 趋势（每 ${formalSeconds} 秒）`,
    formalMemoryTitle: `标准验收内存趋势（PSS 每 ${formalSeconds} 秒，RSS 辅助）`,
    diagnosticCpuTitle: "",
    diagnosticRssTitle: "",
    isRealtime: false,
  };
}

function csvRows(text) {
  const rows = [];
  let row = [];
  let cell = "";
  let quoted = false;
  const source = String(text || "").replace(/^\uFEFF/, "");
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (quoted) {
      if (char === '"' && source[index + 1] === '"') {
        cell += '"';
        index += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        cell += char;
      }
    } else if (char === '"') {
      quoted = true;
    } else if (char === ",") {
      row.push(cell);
      cell = "";
    } else if (char === "\n") {
      row.push(cell.replace(/\r$/, ""));
      rows.push(row);
      row = [];
      cell = "";
    } else {
      cell += char;
    }
  }
  if (cell || row.length) {
    row.push(cell.replace(/\r$/, ""));
    rows.push(row);
  }
  return rows;
}

const NUMERIC_FIELDS = new Set([
  "diagnostic_index",
  "target_elapsed_s",
  "actual_elapsed_s",
  "source_timestamp_s",
  "logical_cpus",
  "cpu_one_core_equiv_pct",
  "cpu_device_normalized_pct",
  "rss_mb",
  "rss_source_timestamp_s",
  "process_set_changed",
  "cpu_window_duration_s",
  "collection_latency_s",
]);

export function parseDiagnosticCsv(text, limit = MAX_DIAGNOSTIC_SAMPLES) {
  const rows = csvRows(text);
  if (rows.length < 2) return [];
  const headers = rows[0].map((value) => value.trim());
  const samples = rows.slice(1).map((values) => {
    const sample = {};
    headers.forEach((header, index) => {
      if (!header) return;
      const raw = values[index] ?? "";
      if (header === "rss_fresh") sample[header] = /^(?:1|true|yes)$/i.test(raw.trim());
      else if (NUMERIC_FIELDS.has(header)) sample[header] = finite(raw);
      else sample[header] = raw;
    });
    return sample;
  }).filter((sample) => finite(sample.diagnostic_index) !== null);
  const bounded = Math.max(1, Math.min(MAX_DIAGNOSTIC_SAMPLES, Math.trunc(Number(limit) || MAX_DIAGNOSTIC_SAMPLES)));
  return samples.slice(-bounded);
}

export const SAMPLING_MODES = Object.freeze({ STANDARD, REALTIME });
