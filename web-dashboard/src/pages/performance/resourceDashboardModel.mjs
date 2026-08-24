export const WORKBOOK_PERFORMANCE_METRICS = Object.freeze([
  { key: "cold_start_ms", label: "首次启动", unit: "ms", comparison: "<=", limit: 850 },
  { key: "hot_start_ms", label: "热启动", unit: "ms", comparison: "<=", limit: 800 },
  { key: "category_response_ms", label: "分类响应", unit: "ms", comparison: "<=", limit: 230 },
  { key: "detail_response_ms", label: "详情响应", unit: "ms", comparison: "<=", limit: 700 },
  { key: "fps", label: "页面流畅度", unit: "fps", comparison: ">=", limit: 58 },
  {
    key: "cpu_customer_single_peak_pct",
    label: "CPU 单核峰值",
    unit: "%",
    comparison: "<=",
    limit: 3.3,
    measurement: ["cpu_device_normalized_pct", "peak"],
  },
  {
    key: "cpu_multi_core_peak_pct",
    label: "CPU 多核峰值",
    unit: "%",
    comparison: "<=",
    limit: 16.5,
    measurement: ["cpu_multi_core_pct", "peak"],
  },
  {
    key: "cpu_customer_mean_pct",
    label: "CPU 均值",
    unit: "%",
    comparison: "<=",
    limit: 1.25,
    measurement: ["cpu_device_normalized_pct", "mean"],
  },
  {
    key: "pss_peak_mb",
    label: "内存 PSS 峰值",
    unit: "MiB",
    comparison: "<=",
    limit: 190,
    measurement: ["pss_mb", "peak"],
  },
  {
    key: "pss_mean_mb",
    label: "内存 PSS 均值",
    unit: "MiB",
    comparison: "<=",
    limit: 140,
    measurement: ["pss_mb", "mean"],
  },
  { key: "stability", label: "稳定性", unit: "", comparison: "==", limit: "无崩溃、闪退、重启" },
  { key: "availability_pct", label: "系统可用性", unit: "%", comparison: ">=", limit: 99.9 },
]);

const APPMARKET_COLLECTED_METRIC_KEYS = Object.freeze([
  "cpu_customer_single_peak_pct",
  "cpu_multi_core_peak_pct",
  "cpu_customer_mean_pct",
  "pss_peak_mb",
  "pss_mean_mb",
]);

const ECOLOGY_METRIC_GROUPS = Object.freeze([
  "CPU 峰值/均值",
  "内存峰值/均值",
  "冷启动/热启动",
]);

function workbookSheet(sheet, processGroups, metricGroups = ECOLOGY_METRIC_GROUPS, extra = {}) {
  return Object.freeze({
    sheet,
    kind: "生态应用",
    processGroups: Object.freeze([...processGroups]),
    metricGroups: Object.freeze([...metricGroups]),
    collectedMetricKeys: Object.freeze([]),
    ...extra,
  });
}

// 这里只描述工作簿要求覆盖的 sheet、进程组和指标组，不包含工作簿中的旧实测值。
// 当前资源采集轮次只会为“应用市场”下列五个 key 提供实际数据。
export const WORKBOOK_SHEET_CATALOG = Object.freeze([
  workbookSheet(
    "应用市场",
    ["应用市场主进程及子进程（com.appmarket.automotive*）"],
    ["首次启动/热启动", "分类响应/详情响应", "页面流畅度 FPS", "CPU 峰值/均值", "内存峰值/均值", "生态应用 GPU（待客户确认）", "稳定性/系统可用性"],
    { kind: "应用市场", collectedMetricKeys: APPMARKET_COLLECTED_METRIC_KEYS },
  ),
  workbookSheet("Audible", ["Audible 应用进程", "音乐模板（com.minical.car.media）"]),
  workbookSheet("Tidal", ["Tidal 应用进程", "音乐模板（com.minical.car.media）"]),
  workbookSheet("Amazon Music", ["Amazon Music 应用进程", "音乐模板（com.minical.car.media）"]),
  workbookSheet("Tunein", ["Tunein 应用进程", "音乐模板（com.minical.car.media）"]),
  workbookSheet("Deezer", ["Deezer 应用进程", "音乐模板（com.minical.car.media）"]),
  workbookSheet("Weather", ["Weather 应用进程"]),
  workbookSheet("YouTube", ["YouTube 应用进程", "WebView（com.android.webview）"]),
  workbookSheet("TikTok", ["TikTok 应用进程", "WebView（com.android.webview）"]),
  workbookSheet("Apple Music", ["Apple Music 应用进程", "WebView（com.android.webview）"]),
  workbookSheet("Disney+", ["Disney+ 应用进程", "WebView（com.android.webview）"]),
  workbookSheet("Amazon Video", ["Amazon Video 应用进程", "WebView（com.android.webview）"]),
  workbookSheet("Yandex Music", ["Yandex Music 应用进程", "WebView（com.android.webview）"]),
  workbookSheet("VK Video", ["VK Video（com.vk.vkvideo）", "视频模板（com.huawei.hmsforcar.carvideoui）"]),
  workbookSheet("VK Music", ["VK Music（com.uma.musicvk）", "音乐模板（com.minical.car.media）"]),
  workbookSheet("Anghami", ["Anghami 应用进程", "音乐模板（com.minical.car.media）"]),
]);

export function finiteNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

export function getResourceSamples(detail) {
  const candidates = [
    detail?.samples,
    detail?.resourceSamples,
    detail?.raw?.resourceSamples,
    detail?.payload?.resourceSamples,
  ];
  return candidates.find(Array.isArray) || [];
}

function valueAtPath(value, path) {
  if (!path) return null;
  let current = value;
  for (const key of path) {
    if (!current || typeof current !== "object") return null;
    current = current[key];
  }
  return finiteNumber(current);
}

export function evaluateThreshold(actual, comparison, limit) {
  const number = finiteNumber(actual);
  const threshold = finiteNumber(limit);
  if (number === null || threshold === null) return "not_collected";
  if (comparison === "<=") return number <= threshold ? "pass" : "fail";
  if (comparison === ">=") return number >= threshold ? "pass" : "fail";
  if (comparison === "==") return number === threshold ? "pass" : "fail";
  return "inconclusive";
}

function normalizeCheckStatus(value) {
  const status = String(value || "").toLowerCase();
  if (status === "pass" || status === "fail" || status === "inconclusive") return status;
  return "";
}

export function buildWorkbookMetricRows(detail) {
  const checks = Array.isArray(detail?.checks)
    ? detail.checks
    : Array.isArray(detail?.profile?.checks)
      ? detail.profile.checks
    : Array.isArray(detail?.resourceProfile?.checks)
      ? detail.resourceProfile.checks
      : [];
  const checkByKey = new Map(checks.map((check) => [check?.key, check]));
  const measurements = detail?.measurements || detail?.profile?.measurements || detail?.resourceProfile?.measurements || {};

  return WORKBOOK_PERFORMANCE_METRICS.map((definition) => {
    if (!definition.measurement) {
      return { ...definition, actual: null, status: "not_collected", collected: false };
    }
    const check = checkByKey.get(definition.key);
    const checkedActual = check && Object.prototype.hasOwnProperty.call(check, "actual")
      ? finiteNumber(check.actual)
      : null;
    const measuredActual = valueAtPath(measurements, definition.measurement);
    const actual = checkedActual ?? measuredActual;
    const checkStatus = normalizeCheckStatus(check?.status);
    const status = actual === null
      ? "not_collected"
      : checkStatus || evaluateThreshold(actual, definition.comparison, definition.limit);
    return {
      ...definition,
      actual,
      status,
      collected: actual !== null,
    };
  });
}

export function samplePoint(sample, valueKey, index = 0) {
  const x = finiteNumber(sample?.target_elapsed_s)
    ?? finiteNumber(sample?.actual_elapsed_s)
    ?? finiteNumber(sample?.sample_index)
    ?? index + 1;
  return { x, y: finiteNumber(sample?.[valueKey]) };
}
