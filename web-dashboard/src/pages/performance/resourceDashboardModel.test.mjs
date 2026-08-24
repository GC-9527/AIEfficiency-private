import test from "node:test";
import assert from "node:assert/strict";

import {
  WORKBOOK_SHEET_CATALOG,
  WORKBOOK_PERFORMANCE_METRICS,
  buildWorkbookMetricRows,
  evaluateThreshold,
  finiteNumber,
  getResourceSamples,
  samplePoint,
} from "./resourceDashboardModel.mjs";

test("工作簿覆盖目录包含应用市场和 15 个生态应用 sheet", () => {
  assert.equal(WORKBOOK_SHEET_CATALOG.length, 16);
  assert.equal(new Set(WORKBOOK_SHEET_CATALOG.map((item) => item.sheet)).size, 16);
  assert.deepEqual(
    WORKBOOK_SHEET_CATALOG.map((item) => item.sheet),
    [
      "应用市场", "Audible", "Tidal", "Amazon Music", "Tunein", "Deezer", "Weather", "YouTube",
      "TikTok", "Apple Music", "Disney+", "Amazon Video", "Yandex Music", "VK Video", "VK Music", "Anghami",
    ],
  );
  assert.equal(WORKBOOK_SHEET_CATALOG.filter((item) => item.kind === "生态应用").length, 15);
});

test("生态应用均声明标准指标组和进程组，但不冒充本轮已采集", () => {
  const ecology = WORKBOOK_SHEET_CATALOG.filter((item) => item.kind === "生态应用");
  for (const sheet of ecology) {
    assert.ok(sheet.processGroups.length >= 1, `${sheet.sheet} 应声明进程组`);
    assert.deepEqual(sheet.metricGroups, ["CPU 峰值/均值", "内存峰值/均值", "冷启动/热启动"]);
    assert.deepEqual(sheet.collectedMetricKeys, []);
  }
  assert.ok(WORKBOOK_SHEET_CATALOG.find((item) => item.sheet === "YouTube").processGroups.some((item) => item.includes("com.android.webview")));
  assert.ok(WORKBOOK_SHEET_CATALOG.find((item) => item.sheet === "VK Video").processGroups.some((item) => item.includes("carvideoui")));
});

test("应用市场目录仅声明当前可映射的五项 CPU/PSS key", () => {
  const appmarket = WORKBOOK_SHEET_CATALOG[0];
  assert.equal(appmarket.kind, "应用市场");
  assert.deepEqual(appmarket.collectedMetricKeys, [
    "cpu_customer_single_peak_pct",
    "cpu_multi_core_peak_pct",
    "cpu_customer_mean_pct",
    "pss_peak_mb",
    "pss_mean_mb",
  ]);
  assert.ok(appmarket.metricGroups.some((item) => item.includes("GPU")));
  assert.ok(appmarket.metricGroups.includes("首次启动/热启动"));
  assert.ok(appmarket.metricGroups.includes("页面流畅度 FPS"));
  assert.ok(appmarket.metricGroups.includes("稳定性/系统可用性"));
});

test("工作簿指标注册表完整且只映射当前已采集的五项 CPU/PSS 指标", () => {
  assert.equal(WORKBOOK_PERFORMANCE_METRICS.length, 12);
  const limits = Object.fromEntries(WORKBOOK_PERFORMANCE_METRICS.map((item) => [item.key, [item.comparison, item.limit]]));
  assert.deepEqual(limits.cold_start_ms, ["<=", 850]);
  assert.deepEqual(limits.hot_start_ms, ["<=", 800]);
  assert.deepEqual(limits.category_response_ms, ["<=", 230]);
  assert.deepEqual(limits.detail_response_ms, ["<=", 700]);
  assert.deepEqual(limits.fps, [">=", 58]);
  assert.deepEqual(limits.cpu_customer_single_peak_pct, ["<=", 3.3]);
  assert.deepEqual(limits.cpu_multi_core_peak_pct, ["<=", 16.5]);
  assert.deepEqual(limits.cpu_customer_mean_pct, ["<=", 1.25]);
  assert.deepEqual(limits.pss_peak_mb, ["<=", 190]);
  assert.deepEqual(limits.pss_mean_mb, ["<=", 140]);
  assert.deepEqual(limits.availability_pct, [">=", 99.9]);
  assert.deepEqual(
    WORKBOOK_PERFORMANCE_METRICS.filter((item) => item.measurement).map((item) => item.key),
    [
      "cpu_customer_single_peak_pct",
      "cpu_multi_core_peak_pct",
      "cpu_customer_mean_pct",
      "pss_peak_mb",
      "pss_mean_mb",
    ],
  );
});

test("五项 CPU/PSS 从所选轮次映射并采用后端 check 状态", () => {
  const rows = buildWorkbookMetricRows({
    measurements: {
      cpu_device_normalized_pct: { peak: 3.3, mean: 0 },
      cpu_multi_core_pct: { peak: 16.6 },
      pss_mb: { peak: 189.5, mean: 140 },
    },
    checks: [
      { key: "cpu_customer_single_peak_pct", actual: 3.3, status: "pass" },
      { key: "cpu_multi_core_peak_pct", actual: 16.6, status: "fail" },
      { key: "cpu_customer_mean_pct", actual: 0, status: "pass" },
      { key: "pss_peak_mb", actual: 189.5, status: "pass" },
      { key: "pss_mean_mb", actual: 140, status: "pass" },
    ],
  });
  const values = Object.fromEntries(rows.map((row) => [row.key, row]));
  assert.equal(values.cpu_customer_single_peak_pct.actual, 3.3);
  assert.equal(values.cpu_multi_core_peak_pct.status, "fail");
  assert.equal(values.cpu_customer_mean_pct.actual, 0, "合法的 0 不能被当成空值");
  assert.equal(values.pss_peak_mb.status, "pass");
});

test("工作簿中尚未接入的指标明确标记为未采集", () => {
  const rows = buildWorkbookMetricRows({});
  for (const key of ["cold_start_ms", "hot_start_ms", "category_response_ms", "detail_response_ms", "fps", "stability", "availability_pct"]) {
    const row = rows.find((item) => item.key === key);
    assert.equal(row.actual, null);
    assert.equal(row.status, "not_collected");
    assert.equal(row.collected, false);
  }
});

test("null、空串和非数字不伪装为 0，阈值边界正确", () => {
  assert.equal(finiteNumber(null), null);
  assert.equal(finiteNumber(""), null);
  assert.equal(finiteNumber("bad"), null);
  assert.equal(finiteNumber(0), 0);
  assert.equal(evaluateThreshold(null, "<=", 3.3), "not_collected");
  assert.equal(evaluateThreshold(3.3, "<=", 3.3), "pass");
  assert.equal(evaluateThreshold(3.31, "<=", 3.3), "fail");
  assert.equal(evaluateThreshold(58, ">=", 58), "pass");
  assert.equal(evaluateThreshold(57.9, ">=", 58), "fail");
});

test("样本只读取所选详情并以目标秒数作为横轴", () => {
  const detail = { samples: [{ sample_index: 1, target_elapsed_s: 5, cpu_device_normalized_pct: 0 }] };
  assert.equal(getResourceSamples(detail).length, 1);
  assert.deepEqual(samplePoint(detail.samples[0], "cpu_device_normalized_pct"), { x: 5, y: 0 });
  assert.deepEqual(samplePoint({ sample_index: 2, actual_elapsed_s: 10.4, pss_mb: null }, "pss_mb"), { x: 10.4, y: null });
});
