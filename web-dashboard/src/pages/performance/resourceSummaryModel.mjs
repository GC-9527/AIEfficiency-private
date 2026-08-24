function finite(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function average(values) {
  const valid = values.map(finite).filter((value) => value !== null);
  return valid.length ? valid.reduce((sum, value) => sum + value, 0) / valid.length : null;
}

function acceptanceOf(run) {
  return String(run?.acceptance || "INCONCLUSIVE").trim().toUpperCase();
}

function measurement(run, group, stat) {
  return finite(run?.measurements?.[group]?.[stat]);
}

function summarizeGroup(key, label, rows) {
  const pass = rows.filter((run) => acceptanceOf(run) === "PASS").length;
  const fail = rows.filter((run) => acceptanceOf(run) === "FAIL").length;
  return {
    key,
    label,
    total: rows.length,
    pass,
    fail,
    other: rows.length - pass - fail,
    passRate: rows.length ? pass / rows.length : null,
    cpuSinglePeakAverage: average(rows.map((run) => measurement(run, "cpu_device_normalized_pct", "peak"))),
    cpuMultiPeakAverage: average(rows.map((run) => measurement(run, "cpu_multi_core_pct", "peak"))),
    pssPeakAverage: average(rows.map((run) => measurement(run, "pss_mb", "peak"))),
  };
}
export function summarizeResourceRuns(runs = []) {
  const rows = (Array.isArray(runs) ? runs : [])
    .filter((run) => run && typeof run === "object" && !Array.isArray(run))
    .slice(0, 100)
    .sort((left, right) => String(right.createdAt || "").localeCompare(String(left.createdAt || "")));
  const overall = summarizeGroup("all", "全部", rows);
  const groups = new Map();
  for (const run of rows) {
    const flavor = String(run.flavor || "未标车型").trim() || "未标车型";
    const version = String(run.appVersion || "未知版本").trim() || "未知版本";
    const key = `${flavor}\u0000${version}`;
    if (!groups.has(key)) groups.set(key, { label: `${flavor} · ${version}`, rows: [] });
    groups.get(key).rows.push(run);
  }
  return {
    ...overall,
    latest: rows[0] || null,
    averageValidSampleRatio: average(rows.map((run) => run?.sampling?.valid_sample_ratio)),
    cpuSingleMeanAverage: average(rows.map((run) => measurement(run, "cpu_device_normalized_pct", "mean"))),
    pssMeanAverage: average(rows.map((run) => measurement(run, "pss_mb", "mean"))),
    groups: [...groups.entries()].map(([key, group]) => summarizeGroup(key, group.label, group.rows)),
    recent: rows.slice(0, 12).map((run) => ({
      id: String(run.id || ""),
      createdAt: String(run.createdAt || ""),
      acceptance: acceptanceOf(run),
      flavor: String(run.flavor || ""),
      appVersion: String(run.appVersion || ""),
      device: [run.deviceBrand, run.deviceModel].filter(Boolean).join(" "),
      validSampleRatio: finite(run?.sampling?.valid_sample_ratio),
      cpuSinglePeak: measurement(run, "cpu_device_normalized_pct", "peak"),
      cpuMultiPeak: measurement(run, "cpu_multi_core_pct", "peak"),
      cpuSingleMean: measurement(run, "cpu_device_normalized_pct", "mean"),
      pssPeak: measurement(run, "pss_mb", "peak"),
      pssMean: measurement(run, "pss_mb", "mean"),
    })),
  };
}
