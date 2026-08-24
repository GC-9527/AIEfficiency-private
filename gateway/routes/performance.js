import { Router } from "express";
import { randomUUID } from "crypto";
import { createReadStream } from "node:fs";
import {
  insertPerfSession,
  insertPerfMetrics,
  insertPerfEvents,
  listPerfSessions,
  listPerfResourceRuns,
  getPerfResourceRun,
  listPerfRounds,
  listPerfEvents,
  listPerfMetrics,
  getTopMetrics,
  getPerfStats,
  getPerfRoundDetail,
  getPerfRecentDetail,
  getPerfByVersion,
  getPerfVersionDetail,
  insertPerfReport,
  listPerfReports,
  getPerfReport,
  createTask,
} from "../db/sqlite.js";
import { runTask } from "../services/agent-runner.js";
import { startLogArchive, stopLogArchive, getLogArchiveStatus } from "../services/log-archiver.js";
import {
  startResourceRun,
  stopResourceRun,
  getResourceRunStatus,
} from "../services/performance-resource-runner.js";
import {
  getPerformanceResourceConfig,
  savePerformanceResourceConfig,
  resetPerformanceResourceConfig,
  parsePerformanceResourceConfigEvidence,
} from "../services/performance-resource-config.js";
import {
  listResourceArtifacts,
  readResourceArtifact,
  openResourceArtifactDownload,
} from "../services/performance-resource-artifacts.js";
import { isTrustedPerformanceResourceRequest } from "../services/performance-resource-local-access.js";
import { broadcastAll, emitPerformanceResourceWs, log } from "../services/logger.js";
import { requestPrincipal } from "../services/admin-auth.js";

const router = Router();

router.use((req, res, next) => {
  const environment = String(process.env.NODE_ENV || "").trim().toLowerCase();
  if (
    environment === "test"
    || (
      environment === "development"
      && String(process.env.AIEFFICIENCY_ALLOW_UNAUTHENTICATED_PERFORMANCE || "") === "1"
    )
  ) return next();
  const principal = requestPrincipal(req);
  if (!principal) {
    return res.status(401).json({
      success: false,
      code: "PERFORMANCE_API_AUTH_REQUIRED",
      error: "性能采集与分析接口要求已认证身份",
    });
  }
  req.principal = principal;
  return next();
});
const MAX_ARTIFACT_PREVIEW_BYTES = 256 * 1024;

function isTrustedLocalRequest(req) {
  return isTrustedPerformanceResourceRequest(req);
}

function requireLocalResourceAccess(req, res, next) {
  if (!isTrustedLocalRequest(req)) {
    return res.status(403).json({ success: false, error: "性能测试控制与原始数据仅允许本机访问" });
  }
  return next();
}

function artifactErrorStatus(error) {
  const status = Number(error?.statusCode || error?.status || 0);
  return [400, 403, 404, 415, 416].includes(status) ? status : 500;
}

function artifactErrorMessage(status) {
  if (status === 400 || status === 416) return "原始产物请求参数无效";
  if (status === 403) return "原始产物仅允许本机访问";
  if (status === 404) return "原始产物不存在或不可访问";
  if (status === 415) return "该原始产物不支持文本预览";
  return "读取原始产物失败";
}

function publicArtifactDir(value, artifacts) {
  if (!artifacts.length || typeof value !== "string") return null;
  const normalized = value.replace(/\\/g, "/").replace(/^\.\//, "");
  if (!/^docs\/tempFiles\/appmarket-performance\/[A-Za-z0-9._/-]+$/.test(normalized)) return null;
  if (normalized.split("/").some((part) => !part || part === "." || part === "..")) return null;
  return normalized;
}

function readResourceReport(detail, fallbackProfile, artifacts) {
  const report = {
    json: fallbackProfile,
    markdown: null,
    jsonSource: "database",
    markdownSource: "missing",
  };
  if (artifacts.some((item) => item.key === "report_json")) {
    try {
      const preview = readResourceArtifact(detail, "report_json", {
        offset: 0,
        limit: MAX_ARTIFACT_PREVIEW_BYTES,
      });
      if (!preview.truncated) {
        const parsed = JSON.parse(preview.content);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          report.json = { ...parsed, artifact_dir: fallbackProfile.artifact_dir };
          report.jsonSource = "artifact";
        }
      }
    } catch {}
  }
  if (artifacts.some((item) => item.key === "report_md")) {
    try {
      const preview = readResourceArtifact(detail, "report_md", {
        offset: 0,
        limit: MAX_ARTIFACT_PREVIEW_BYTES,
      });
      if (!preview.truncated) {
        report.markdown = preview.content;
        report.markdownSource = "artifact";
      }
    } catch {}
  }
  return report;
}

function readResourceFlowEvents(detail, artifacts) {
  if (!artifacts.some((item) => item.key === "flow_events")) return [];
  try {
    const preview = readResourceArtifact(detail, "flow_events", {
      offset: 0,
      limit: MAX_ARTIFACT_PREVIEW_BYTES,
    });
    const lines = preview.content.split(/\r?\n/);
    if (preview.truncated) lines.pop();
    const events = [];
    for (const line of lines) {
      if (!line.trim()) continue;
      let value;
      try { value = JSON.parse(line); } catch { continue; }
      if (!value || typeof value !== "object" || Array.isArray(value)) continue;
      const step = String(value.step || "").trim().slice(0, 160);
      const status = String(value.status || "").trim().slice(0, 80);
      if (!step || !status) continue;
      events.push({
        sequence: events.length + 1,
        at: String(value.at || "").trim().slice(0, 80),
        step,
        status,
        message: String(value.message || "").trim().slice(0, 2000),
      });
    }
    return events.slice(-240);
  } catch {
    return [];
  }
}

function readResourceConfigSnapshot(detail, artifacts) {
  if (!artifacts.some((item) => item.key === "effective_config")) return null;
  try {
    const preview = readResourceArtifact(detail, "effective_config", {
      offset: 0,
      limit: MAX_ARTIFACT_PREVIEW_BYTES,
    });
    if (preview.truncated) return null;
    return parsePerformanceResourceConfigEvidence(JSON.parse(preview.content));
  } catch {
    return null;
  }
}

/**
 * 车机上报入口（友盟/GA 风格）。
 * 接收 perf-tracker-api（com.car.dev.perf.PerfReporter）POST 的一次启动会话。
 * 兼容单条对象或 { sessions: [...] } 批量。
 */
router.post("/ingest", (req, res) => {
  try {
    const body = req.body || {};
    const items = Array.isArray(body.sessions) ? body.sessions : [body];
    const saved = [];
    for (const raw of items) {
      if (!raw || typeof raw !== "object") continue;
      const startup = raw.startup || {};
      const session = {
        id: raw.sessionId || randomUUID(),
        scenario: raw.scenario || "cold_start",
        flavor: raw.flavor || "",
        appVersion: raw.appVersion || "",
        appVersionCode: Number(raw.appVersionCode) || 0,
        deviceModel: raw.deviceModel || "",
        deviceBrand: raw.deviceBrand || "",
        channel: raw.channel || "",
        deviceId: raw.deviceId || "",
        round: raw.round || "",
        stage1Ms: Number(startup.stage1Ms) || 0,
        stage2Ms: Number(startup.stage2Ms) || 0,
        stage3Ms: Number(startup.stage3Ms) || 0,
        totalMs: Number(startup.totalMs) || 0,
        // 测试验收口径冷启动：进程启动(≈点击图标) → 模板页出现 loading
        coldLoadingMs: Number(startup.coldToLoadingMs) || 0,
        marksJson: raw.marks ? JSON.stringify(raw.marks) : null,
        rawJson: JSON.stringify(raw),
      };
      insertPerfSession(session);
      // 细分指标（method/page/network/db/memory）与稳定性事件（crash/anr）入独立表，
      // 便于面板「性能日志/事件」展示与后续聚合。
      insertPerfMetrics(session.id, session.flavor, raw.metrics);
      insertPerfEvents(session.id, session.flavor, session.deviceId, raw.events);
      saved.push(session.id);
      broadcastAll(JSON.stringify({ type: "performance_update", data: { id: session.id, flavor: session.flavor, scenario: session.scenario, totalMs: session.totalMs } }));
    }
    log(null, "info", "performance", `ingest ${saved.length} 条性能数据`);
    res.json({ success: true, count: saved.length, ids: saved });
  } catch (e) {
    log(null, "error", "performance", `ingest 失败: ${e.message}`);
    res.status(400).json({ success: false, error: e.message });
  }
});

// 会话列表（支持 flavor/deviceId/scenario/round/limit 过滤）
router.get("/sessions", (req, res) => {
  const { flavor, deviceId, scenario, round, limit } = req.query;
  const data = listPerfSessions({
    flavor,
    deviceId,
    scenario,
    round,
    limit: limit ? parseInt(limit) : 100,
  });
  res.json({ success: true, data });
});

// 应用市场 CPU/PSS 摸测配置：tracked JSON 只作为默认模板，用户配置持久化到
// gateway/config.json 的 appmarketPerformance 节点，避免页面保存污染源码目录。
router.get("/resource-config", requireLocalResourceAccess, (req, res) => {
  try {
    res.json({ success: true, data: getPerformanceResourceConfig() });
  } catch (e) {
    res.status(500).json({ success: false, error: `读取性能分析配置失败：${e.message}` });
  }
});

router.put("/resource-config", requireLocalResourceAccess, (req, res) => {
  try {
    res.json({ success: true, data: savePerformanceResourceConfig(req.body || {}) });
  } catch (e) {
    res.status(400).json({ success: false, error: e.message });
  }
});

router.delete("/resource-config", requireLocalResourceAccess, (req, res) => {
  try {
    res.json({ success: true, data: resetPerformanceResourceConfig() });
  } catch (e) {
    res.status(500).json({ success: false, error: `重置性能分析配置失败：${e.message}` });
  }
});

// 应用市场 3 分钟 CPU/PSS 摸测：平台可直接启动/停止本仓库的一键脚本，
// 脚本完成后仍通过统一 /ingest 入口写入小数精度指标与 resourceProfile。
router.get("/resource-run/status", requireLocalResourceAccess, (req, res) => {
  res.json({ success: true, data: getResourceRunStatus() });
});

router.post("/resource-run/start", requireLocalResourceAccess, (req, res) => {
  try {
    const data = startResourceRun(req.body || {});
    emitPerformanceResourceWs("performance_update", { kind: "resource-run", ...data });
    res.json({ success: true, data });
  } catch (e) {
    const status = e.code === "RUNNING" ? 409 : 400;
    res.status(status).json({ success: false, error: e.message });
  }
});

router.post("/resource-run/stop", requireLocalResourceAccess, (req, res) => {
  const data = stopResourceRun();
  emitPerformanceResourceWs("performance_update", { kind: "resource-run", ...data });
  res.json({ success: true, data });
});

router.get("/resource-runs", requireLocalResourceAccess, (req, res) => {
  const requested = Number.parseInt(req.query.limit, 10);
  const limit = Number.isFinite(requested) ? Math.max(1, Math.min(requested, 100)) : 30;
  const data = listPerfResourceRuns({ flavor: req.query.flavor || undefined, limit });
  res.json({ success: true, data });
});

router.get("/resource-runs/:id", requireLocalResourceAccess, (req, res) => {
  const detail = getPerfResourceRun(req.params.id);
  if (!detail) return res.status(404).json({ success: false, error: "性能采集记录不存在" });
  if (detail.corrupt) {
    return res.status(422).json({ success: false, error: "性能采集记录的原始 JSON 已损坏" });
  }

  let artifacts = [];
  try {
    artifacts = listResourceArtifacts(detail);
  } catch {}
  const artifactDir = publicArtifactDir(detail.profile.artifact_dir, artifacts);
  const profile = { ...detail.profile, artifact_dir: artifactDir };
  const run = {
    ...detail.run,
    artifactDir,
    artifactsAvailable: artifacts.length > 0,
  };
  const report = isTrustedLocalRequest(req)
    ? readResourceReport(detail, profile, artifacts)
    : { json: profile, markdown: null, jsonSource: "database", markdownSource: "missing" };
  const flowEvents = isTrustedLocalRequest(req)
    ? readResourceFlowEvents(detail, artifacts)
    : [];
  const artifactConfigSnapshot = isTrustedLocalRequest(req)
    ? readResourceConfigSnapshot(detail, artifacts)
    : null;
  const persistedScript = profile.script && typeof profile.script === "object"
    ? profile.script
    : null;
  const frozenScript = persistedScript && artifactConfigSnapshot?.script
    ? {
      ...artifactConfigSnapshot.script,
      ...persistedScript,
      workflow: persistedScript.workflow || artifactConfigSnapshot.script.workflow,
      ui: persistedScript.ui || artifactConfigSnapshot.script.ui,
    }
    : persistedScript || artifactConfigSnapshot?.script || null;
  const configSnapshot = frozenScript || artifactConfigSnapshot
    ? {
      run: artifactConfigSnapshot?.run || null,
      script: frozenScript,
      flow: artifactConfigSnapshot?.flow || null,
    }
    : null;
  if (configSnapshot?.script) run.script = configSnapshot.script;
  return res.json({
    success: true,
    data: { run, profile, samples: detail.samples, report, artifacts, flowEvents, configSnapshot },
  });
});

router.get("/resource-runs/:id/artifact", requireLocalResourceAccess, (req, res) => {
  if (!isTrustedLocalRequest(req)) {
    return res.status(403).json({ success: false, error: "原始产物仅允许本机访问" });
  }
  const detail = getPerfResourceRun(req.params.id);
  if (!detail) return res.status(404).json({ success: false, error: "性能采集记录不存在" });
  if (detail.corrupt) {
    return res.status(422).json({ success: false, error: "性能采集记录的原始 JSON 已损坏" });
  }

  const key = String(req.query.key || "").trim();
  if (!key) return res.status(400).json({ success: false, error: "缺少原始产物 key" });
  try {
    if (String(req.query.download || "") === "1") {
      const opened = openResourceArtifactDownload(detail, key);
      const filename = String(opened.meta.path || key).split(/[\\/]/).at(-1).replace(/["\r\n]/g, "_");
      res.setHeader("Content-Type", opened.meta.mime || "application/octet-stream");
      res.setHeader("Content-Length", String(opened.meta.size));
      res.setHeader("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`);
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.setHeader("Cache-Control", "no-store");
      const stream = createReadStream(opened.absolutePath);
      stream.on("error", () => {
        if (!res.headersSent) res.status(500).json({ success: false, error: "读取原始产物失败" });
        else res.destroy();
      });
      stream.pipe(res);
      return;
    }

    const offset = req.query.offset == null ? 0 : Number(req.query.offset);
    const requestedLimit = req.query.limit == null ? 64 * 1024 : Number(req.query.limit);
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(requestedLimit) || requestedLimit <= 0) {
      return res.status(400).json({ success: false, error: "offset/limit 必须是有效正整数" });
    }
    const preview = readResourceArtifact(detail, key, {
      offset,
      limit: Math.min(requestedLimit, MAX_ARTIFACT_PREVIEW_BYTES),
    });
    return res.json({
      success: true,
      data: {
        ...preview,
        totalBytes: preview.meta?.size ?? null,
      },
    });
  } catch (error) {
    const status = artifactErrorStatus(error);
    return res.status(status).json({ success: false, error: artifactErrorMessage(status) });
  }
});

// Monkey 轮次汇总（用于版本/轮次对比）
router.get("/rounds", (req, res) => {
  const data = listPerfRounds({ limit: req.query.limit ? parseInt(req.query.limit) : 50 });
  res.json({ success: true, data });
});

// 细分指标时间序列（内存/CPU/FPS 趋势：type=memory|cpu|ui）
router.get("/metrics", (req, res) => {
  const { type, name, flavor, limit } = req.query;
  const data = listPerfMetrics({ type, name, flavor, limit: limit ? parseInt(limit) : 300 });
  res.json({ success: true, data });
});

// 日志归档（网关托管 adb logcat 持续抓取 + 轮转压缩，手动跑 Monkey 也能自动回传）
router.post("/logcap/start", (req, res) => {
  try {
    const { serial, rotateMin, bufferMB } = req.body || {};
    const st = startLogArchive({
      serial: serial || "",
      rotateMin: rotateMin ? parseInt(rotateMin) : 30,
      bufferMB: bufferMB ? parseInt(bufferMB) : 16,
    });
    broadcastAll(JSON.stringify({ type: "performance_update", data: { kind: "logcap", running: st.running } }));
    res.json({ success: true, data: st });
  } catch (e) {
    log(null, "error", "log-archiver", `start 失败: ${e.message}`);
    res.status(500).json({ success: false, error: e.message });
  }
});

router.post("/logcap/stop", async (req, res) => {
  try {
    const st = await stopLogArchive();
    broadcastAll(JSON.stringify({ type: "performance_update", data: { kind: "logcap", running: st.running } }));
    res.json({ success: true, data: st });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

router.get("/logcap/status", (req, res) => {
  res.json({ success: true, data: getLogArchiveStatus() });
});

// 慢调用排行（method/network/io/page 按 name 聚合，取最慢 top-N）
router.get("/top", (req, res) => {
  const { types, flavor, days, limit } = req.query;
  const typeList = types ? String(types).split(",").map((s) => s.trim()).filter(Boolean) : undefined;
  const data = getTopMetrics({
    types: typeList,
    flavor,
    days: days ? parseInt(days) : 30,
    limit: limit ? parseInt(limit) : 20,
  });
  res.json({ success: true, data });
});

// 稳定性事件列表（crash/anr，支持 type/flavor/limit 过滤）
router.get("/events", (req, res) => {
  const { type, flavor, limit } = req.query;
  const data = listPerfEvents({ type, flavor, limit: limit ? parseInt(limit) : 100 });
  res.json({ success: true, data });
});

// 按 App 版本聚合（跟进优化效果：旧版本基线 vs 新版本）
router.get("/by-version", (req, res) => {
  const { flavor, days } = req.query;
  const data = getPerfByVersion({ flavor, days: days ? parseInt(days) : 90 });
  res.json({ success: true, data });
});

// 总览统计（整体 + 按 flavor）
router.get("/stats", (req, res) => {
  const days = req.query.days ? parseInt(req.query.days) : 30;
  const data = getPerfStats({ days });
  res.json({ success: true, data });
});

// 组装 AI 分析 prompt（对齐《应用市场启动耗时分析报告》口径 + 计划 §6 达标阈值）
function buildAnalyzePrompt(detail, prev) {
  const fmt = (n) => (n == null ? "—" : Math.round(n) + "ms");
  const a = detail.agg || {};
  const lines = [];
  lines.push(`你是 Android 车机应用市场（com.appmarket.automotive）的性能优化专家。请基于以下一轮 Monkey 压测采集的真实数据，给出可执行的优化建议。`);
  lines.push("");
  lines.push(`## 本轮 ${detail.round}（冷启动均值，${a.sessions || 0} 个会话）`);
  lines.push(`- ① 用户点击→MainActivity首帧: ${fmt(a.avg_stage1_ms)}`);
  lines.push(`- ② MainActivity首帧→HomeActivity启动(配置等待): ${fmt(a.avg_stage2_ms)}`);
  lines.push(`- ③ HomeActivity启动→首帧: ${fmt(a.avg_stage3_ms)}`);
  lines.push(`- 冷启动总时长(内部口径,→Home首帧): ${fmt(a.avg_total_ms)}（min ${fmt(a.min_total_ms)} / max ${fmt(a.max_total_ms)}）`);
  lines.push(`- 测试验收口径冷启动(点击图标→模板页loading): ${fmt(a.avg_cold_loading_ms)}（测试实测均值基线 2.51s）`);
  lines.push(`- 稳定性: Crash ${detail.events.crash} 次, ANR ${detail.events.anr} 次, OOM ${detail.events.oom || 0} 次`);
  if (detail.fg) {
    const f = detail.fg;
    const pct = (n) => (n == null ? "—" : Math.round(n) + "%");
    const mb = (n) => (n == null ? "—" : Math.round(n) + "MB");
    lines.push(`- 前台使用(测试验收口径): CPU 峰值 ${pct(f.cpu_peak)} / 均值 ${pct(f.cpu_avg)}，内存 峰值 ${mb(f.mem_peak)} / 均值 ${mb(f.mem_avg)}`);
  }
  if (detail.topMetrics && detail.topMetrics.length) {
    lines.push(`- 最慢细分项(method/network/db):`);
    for (const m of detail.topMetrics.slice(0, 10)) {
      lines.push(`  - [${m.type}] ${m.name}: 均值 ${Math.round(m.avg_value)}ms (${m.n} 次)`);
    }
  }
  if (prev && prev.agg && prev.agg.sessions) {
    const p = prev.agg;
    lines.push("");
    lines.push(`## 上一轮 ${prev.round}（用于对比）`);
    lines.push(`- ①/②/③/总: ${fmt(p.avg_stage1_ms)} / ${fmt(p.avg_stage2_ms)} / ${fmt(p.avg_stage3_ms)} / ${fmt(p.avg_total_ms)}`);
    lines.push(`- Crash ${prev.events.crash} / ANR ${prev.events.anr} / OOM ${prev.events.oom || 0}`);
  }
  lines.push("");
  lines.push(`## 达标阈值（目标）`);
  lines.push(`- 测试验收口径冷启动(点击图标→模板页loading): 目标优于实测基线 2.51s（2510ms），优化目标 < 2000ms`);
  lines.push(`- 冷启动总时长(内部口径): gwmx9 < 2500ms，其余 < 2000ms`);
  lines.push(`- ② 配置等待 < 800ms（缓存优先 + 预连接）`);
  lines.push(`- ③ 首页首帧 < 500ms`);
  lines.push(`- Crash = 0，ANR = 0`);
  lines.push("");
  lines.push(`## 请按以下结构输出 Markdown（简洁、可落地）`);
  lines.push(`1. **结论**：相比上一轮变好/变差/持平（无上一轮则与阈值对比）`);
  lines.push(`2. **恶化/未达标项**：列出超阈值或较上轮恶化的指标`);
  lines.push(`3. **根因推测**：结合 ②配置等待、最慢细分项、Crash/ANR、前台CPU/内存峰值（峰值高常来自图片解码/列表绑定/网络解密/动画）`);
  lines.push(`4. **优化建议**：每条给出大致代码位置/方向（如 refreshAppConfig 缓存优先、预连接、图片按控件尺寸加载/复用、列表 DiffUtil、网络解密异步、主线程卸载）与优先级`);
  lines.push(`5. **下一轮建议**：下轮 Monkey 重点验证哪些指标（含前台CPU/内存峰值是否下降）`);
  return lines.join("\n");
}

// 版本对比"性能优化报表"prompt（供工作报告）：优化版 vs 基线版，给改善幅度 + 是否达标 + 遗留
function buildVersionComparePrompt(target, base) {
  const fmt = (n) => (n == null ? "—" : Math.round(n) + "ms");
  const t = target.agg || {};
  const b = base && base.agg ? base.agg : null;
  const delta = (cur, prev) => {
    if (!b || cur == null || prev == null) return "";
    const d = Math.round(cur - prev);
    const pct = prev ? (((cur - prev) / prev) * 100).toFixed(0) : "—";
    return `（${d >= 0 ? "+" : ""}${d}ms, ${pct}%）`;
  };
  const L = [];
  L.push(`你是车机应用市场(com.appmarket.automotive)性能优化专家。基于真实采集数据，生成一份**性能优化报表（按版本对比）**，用于工作报告。`);
  L.push("");
  L.push(`## 优化版本 ${target.version}（${t.sessions || 0} 个冷启动样本）`);
  L.push(`- ① ${fmt(t.avg_stage1_ms)}　② ${fmt(t.avg_stage2_ms)}　③ ${fmt(t.avg_stage3_ms)}　总 ${fmt(t.avg_total_ms)}（min ${fmt(t.min_total_ms)}/max ${fmt(t.max_total_ms)}）`);
  L.push(`- 测试验收口径冷启动(点击图标→模板页loading): ${fmt(t.avg_cold_loading_ms)}（测试实测基线 2.51s）`);
  if (target.fg) {
    const f = target.fg;
    L.push(`- 前台使用: CPU 峰值 ${f.cpu_peak == null ? "—" : Math.round(f.cpu_peak) + "%"} / 均值 ${f.cpu_avg == null ? "—" : Math.round(f.cpu_avg) + "%"}，内存 峰值 ${f.mem_peak == null ? "—" : Math.round(f.mem_peak) + "MB"} / 均值 ${f.mem_avg == null ? "—" : Math.round(f.mem_avg) + "MB"}`);
  }
  L.push(`- 稳定性 Crash ${target.events.crash} / ANR ${target.events.anr} / OOM ${target.events.oom}`);
  if (target.topMetrics && target.topMetrics.length) {
    L.push(`- 最慢调用:`);
    target.topMetrics.slice(0, 8).forEach((m) => L.push(`  - [${m.type}] ${m.name}: ${Math.round(m.avg_value)}ms (${m.n}次)`));
  }
  if (b) {
    L.push("");
    L.push(`## 基线版本 ${base.version}（${b.sessions || 0} 样本）`);
    L.push(`- ① ${fmt(b.avg_stage1_ms)}　② ${fmt(b.avg_stage2_ms)}　③ ${fmt(b.avg_stage3_ms)}　总 ${fmt(b.avg_total_ms)}`);
    L.push(`- 测试验收口径冷启动: ${fmt(b.avg_cold_loading_ms)}`);
    if (base.fg) {
      const bf = base.fg;
      L.push(`- 前台使用: CPU 峰值 ${bf.cpu_peak == null ? "—" : Math.round(bf.cpu_peak) + "%"} / 均值 ${bf.cpu_avg == null ? "—" : Math.round(bf.cpu_avg) + "%"}，内存 峰值 ${bf.mem_peak == null ? "—" : Math.round(bf.mem_peak) + "MB"} / 均值 ${bf.mem_avg == null ? "—" : Math.round(bf.mem_avg) + "MB"}`);
    }
    L.push(`- Crash ${base.events.crash} / ANR ${base.events.anr} / OOM ${base.events.oom}`);
    L.push("");
    L.push(`## 改善幅度（优化版 − 基线）`);
    L.push(`- 测试验收口径冷启动(点击图标→模板页loading): ${delta(t.avg_cold_loading_ms, b.avg_cold_loading_ms)}`);
    if (target.fg && base.fg) {
      const deltaU = (cur, prev, unit) => {
        if (cur == null || prev == null) return "—";
        const d = Math.round(cur - prev);
        const pct = prev ? (((cur - prev) / prev) * 100).toFixed(0) : "—";
        return `（${d >= 0 ? "+" : ""}${d}${unit}, ${pct}%）`;
      };
      L.push(`- 前台CPU峰值: ${deltaU(target.fg.cpu_peak, base.fg.cpu_peak, "%")}　前台内存峰值: ${deltaU(target.fg.mem_peak, base.fg.mem_peak, "MB")}`);
    }
    L.push(`- ② 配置等待: ${delta(t.avg_stage2_ms, b.avg_stage2_ms)}`);
    L.push(`- 冷启动总时长(内部口径): ${delta(t.avg_total_ms, b.avg_total_ms)}`);
    L.push(`- ①: ${delta(t.avg_stage1_ms, b.avg_stage1_ms)}　③: ${delta(t.avg_stage3_ms, b.avg_stage3_ms)}`);
  } else {
    L.push("");
    L.push(`（无基线版本对比，仅与达标阈值对照）`);
  }
  L.push("");
  L.push(`## 达标阈值`);
  L.push(`- 冷启动 gwmx9<2500ms / 其余<2000ms；② 配置等待<800ms；③<500ms；Crash/ANR/OOM=0`);
  L.push("");
  L.push(`## 请按以下结构输出 Markdown（适合直接放进工作报告）`);
  L.push(`1. **结论**：本次优化整体效果（变好/幅度/是否达标）`);
  L.push(`2. **各项对比**：①②③/总时长/稳定性 优化版 vs 基线 + 改善幅度（用表格）`);
  L.push(`3. **已生效的优化点**：从数据看哪些改善明显（如 ②下降→缓存/图片优化生效）`);
  L.push(`4. **遗留/未达标**：仍超阈值的项 + 原因推测`);
  L.push(`5. **下一步**：还需做什么`);
  return L.join("\n");
}

// 触发对某一轮的 AI 分析
router.post("/analyze", async (req, res) => {
  try {
    const body = req.body || {};
    const round = body.round || "";
    const targetVersion = body.targetVersion || "";
    let detail, prev = null, scope, label, inputMeta, prompt;
    if (targetVersion) {
      // 版本对比"优化报表"（优化版 vs 基线版，供工作报告）
      const td = getPerfVersionDetail(targetVersion);
      if (!td || !td.agg || !td.agg.sessions) {
        return res.status(404).json({ success: false, error: `版本 ${targetVersion} 无冷启动数据` });
      }
      let bd = null;
      if (body.baseVersion) {
        bd = getPerfVersionDetail(body.baseVersion);
        if (!bd || !bd.agg || !bd.agg.sessions) bd = null;
      }
      scope = "version";
      label = body.baseVersion ? `${targetVersion} vs ${body.baseVersion}` : `版本 ${targetVersion}`;
      inputMeta = { targetVersion, baseVersion: body.baseVersion || null, target: td, base: bd };
      prompt = buildVersionComparePrompt(td, bd);
    } else if (round) {
      // 按轮次分析（run-perf-loop 跑出的 round_NNN）
      detail = getPerfRoundDetail(round);
      if (!detail || !detail.agg || !detail.agg.sessions) {
        return res.status(404).json({ success: false, error: `该轮无冷启动数据: ${round}` });
      }
      const rounds = listPerfRounds({ limit: 200 });
      const idx = rounds.findIndex((r) => r.round === round);
      const prevRound = idx >= 0 && idx + 1 < rounds.length ? rounds[idx + 1].round : null;
      prev = prevRound ? getPerfRoundDetail(prevRound) : null;
      scope = "round";
      label = round;
      inputMeta = { detail, prevRound };
      prompt = buildAnalyzePrompt(detail, prev);
    } else {
      // 分析最近数据（手动跑 Monkey，无 round 标记时用）
      const days = body.days ? parseInt(body.days) : 7;
      const flavor = body.flavor || undefined;
      detail = getPerfRecentDetail({ flavor, days });
      if (!detail || !detail.agg || !detail.agg.sessions) {
        return res.status(404).json({ success: false, error: `最近 ${days} 天无冷启动数据` });
      }
      scope = "recent";
      label = detail.round; // "最近N天"
      inputMeta = { detail, days, flavor: flavor || null };
      prompt = buildAnalyzePrompt(detail, prev);
    }
    const taskId = randomUUID();
    const aiTask = {
      id: taskId,
      title: `[性能分析] ${label}`,
      description: prompt,
      type: "analysis",
      status: "pending",
      priority: 2,
      source: "performance",
      sourceId: label,
    };
    createTask(aiTask);
    log(null, "info", "performance", `analyze ${label} (${scope}) -> 调引擎分析`);
    const result = await runTask(aiTask);
    const resultMd = result.output || result.report || "(引擎未返回内容)";

    const reportId = insertPerfReport({
      round: label,
      scope,
      engine: result.engine || result.engineUsed || null,
      inputJson: JSON.stringify(inputMeta),
      resultMd,
    });
    broadcastAll(JSON.stringify({ type: "performance_update", data: { kind: "report", round, reportId } }));
    res.json({ success: true, data: getPerfReport(reportId) });
  } catch (e) {
    log(null, "error", "performance", `analyze 失败: ${e.message}`);
    res.status(500).json({ success: false, error: e.message });
  }
});

// AI 分析报告列表（可按 round 过滤）
router.get("/reports", (req, res) => {
  const { round, limit } = req.query;
  const data = listPerfReports({ round, limit: limit ? parseInt(limit) : 50 });
  res.json({ success: true, data });
});

// 单份报告
router.get("/report/:id", (req, res) => {
  const data = getPerfReport(parseInt(req.params.id));
  if (!data) return res.status(404).json({ success: false, error: "报告不存在" });
  res.json({ success: true, data });
});

export default router;
