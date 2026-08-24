import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "..", "..");
const ARTIFACT_DIR_PREFIX = "docs/tempFiles/appmarket-performance/";
const TRUSTED_ROOT = path.resolve(
  process.env.APPMARKET_PERF_ARTIFACT_ROOT
    || path.join(REPO_ROOT, "docs", "tempFiles", "appmarket-performance"),
);
const MAX_PREVIEW_BYTES = 256 * 1024;
const MAX_MANIFEST_BYTES = 1024 * 1024;
const MAX_DYNAMIC_ARTIFACTS = 200;
const DYNAMIC_KEY_PREFIX = "run_file.";

const ARTIFACTS = Object.freeze({
  metrics_csv: { relative: "raw/metrics.csv", label: "逐点指标 CSV", mime: "text/csv; charset=utf-8", previewable: true },
  sampler_raw_commands: { relative: "raw/sampler_raw_commands.jsonl", label: "原始采样命令", mime: "application/x-ndjson; charset=utf-8", previewable: true },
  sampler_summary: { relative: "raw/sampler_summary.json", label: "采样汇总", mime: "application/json; charset=utf-8", previewable: true },
  diagnostic_metrics: { relative: "raw/diagnostic_metrics.csv", label: "实时诊断 CPU/RSS CSV", mime: "text/csv; charset=utf-8", previewable: true },
  realtime_stream: { relative: "raw/realtime_stream.jsonl", label: "实时采集原始流", mime: "application/x-ndjson; charset=utf-8", previewable: true },
  realtime_collector_device: { relative: "raw/realtime_collector_device.sh", label: "设备端实时采集脚本", mime: "text/plain; charset=utf-8", previewable: true },
  device_info: { relative: "raw/device_info.json", label: "设备信息", mime: "application/json; charset=utf-8", previewable: true },
  effective_config: { relative: "raw/effective_flow_config.json", label: "本轮有效配置", mime: "application/json; charset=utf-8", previewable: true },
  dumpsys_package: { relative: "raw/dumpsys_package.txt", label: "应用包信息", mime: "text/plain; charset=utf-8", previewable: true },
  logcat: { relative: "raw/logcat.txt", label: "Logcat 原始日志", mime: "text/plain; charset=utf-8", previewable: true },
  manifest: { relative: "run_manifest.json", label: "运行清单", mime: "application/json; charset=utf-8", previewable: true },
  flow_events: { relative: "flow/flow_events.jsonl", label: "流程事件", mime: "application/x-ndjson; charset=utf-8", previewable: true },
  flow_result: { relative: "flow/flow_result.json", label: "流程结果", mime: "application/json; charset=utf-8", previewable: true },
  report_json: { relative: "analysis/report.json", label: "分析报告 JSON", mime: "application/json; charset=utf-8", previewable: true },
  report_md: { relative: "analysis/report.md", label: "分析报告 Markdown", mime: "text/markdown; charset=utf-8", previewable: true },
  report_pdf_summary: { relative: "analysis/report_summary.pdf", label: "简短版性能报告 PDF", mime: "application/pdf", previewable: false },
  report_pdf_detailed: { relative: "analysis/report_detailed.pdf", label: "详细版性能报告 PDF", mime: "application/pdf", previewable: false },
  optimization_advice: { relative: "analysis/optimization_advice.md", label: "性能优化建议", mime: "text/markdown; charset=utf-8", previewable: true },
  perfetto_cpu_validation: { relative: "analysis/perfetto_cpu_validation.json", label: "Perfetto CPU 校验", mime: "application/json; charset=utf-8", previewable: true },
  perfetto_cpu_validator_log: { relative: "analysis/perfetto_cpu_validator.log", label: "Perfetto CPU 校验日志", mime: "text/plain; charset=utf-8", previewable: true },
  platform_payload: { relative: "analysis/platform_payload.json", label: "平台上报原文", mime: "application/json; charset=utf-8", previewable: true },
});

const DYNAMIC_ARTIFACT_RULES = Object.freeze([
  { pattern: /^raw\/(?:logcat\.stderr\.txt|sampler\.log|appmarket_perfetto_effective\.pbtxt|perfetto\.log)$/, label: "采集诊断文件" },
  { pattern: /^analysis\/analyzer\.log$/, label: "分析器日志" },
  { pattern: /^flow\/ui\/[A-Za-z0-9._-]+\.xml$/, label: "流程 UI XML" },
  { pattern: /^flow\/ui\/[A-Za-z0-9._-]+\.png$/, label: "流程 UI 截图" },
  { pattern: /^flow\/video\/segment_\d{3}\.mp4$/, label: "原始录屏分段" },
  { pattern: /^flow\/video\/segment_\d{3}\.screenrecord\.log$/, label: "录屏分段日志" },
  { pattern: /^trace\/appmarket\.pftrace$/, label: "Perfetto 原始 Trace" },
]);

function dynamicArtifactShape(relative) {
  const rule = DYNAMIC_ARTIFACT_RULES.find((candidate) => candidate.pattern.test(relative));
  if (!rule) return null;
  const extension = path.extname(relative).toLowerCase();
  const mime = extension === ".png"
    ? "image/png"
    : extension === ".mp4"
      ? "video/mp4"
      : extension === ".xml"
        ? "application/xml; charset=utf-8"
        : extension === ".pftrace"
          ? "application/octet-stream"
          : "text/plain; charset=utf-8";
  return {
    relative,
    label: `${rule.label} · ${path.basename(relative)}`,
    mime,
    previewable: /^(?:text\/|application\/xml)/.test(mime),
  };
}

function dynamicArtifactKey(relative) {
  return `${DYNAMIC_KEY_PREFIX}${Buffer.from(relative, "utf8").toString("base64url")}`;
}

function dynamicDefinitionForKey(key) {
  const raw = String(key || "");
  if (!raw.startsWith(DYNAMIC_KEY_PREFIX)) return null;
  const encoded = raw.slice(DYNAMIC_KEY_PREFIX.length);
  if (!/^[A-Za-z0-9_-]{1,500}$/.test(encoded)) return null;
  const relative = Buffer.from(encoded, "base64url").toString("utf8");
  if (dynamicArtifactKey(relative) !== raw) return null;
  return dynamicArtifactShape(relative);
}

function makeError(message, code, status) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  error.statusCode = status;
  return error;
}

function isContained(parent, child) {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function assertSafeRelativePath(value) {
  if (typeof value !== "string" || !value.trim() || /\0/.test(value)) {
    throw makeError("artifact_dir 无效", "INVALID_ARTIFACT", 400);
  }
  const raw = value.trim();
  if (path.isAbsolute(raw) || path.win32.isAbsolute(raw) || path.posix.isAbsolute(raw) || raw.includes(":")) {
    throw makeError("artifact_dir 必须是仓库相对路径", "FORBIDDEN", 403);
  }
  const normalized = raw.replace(/\\/g, "/").replace(/^\.\//, "");
  const parts = normalized.split("/");
  if (
    !normalized.startsWith(ARTIFACT_DIR_PREFIX)
    || parts.some((part) => !part || part === "." || part === ".." || /[. ]$/.test(part))
  ) {
    throw makeError("artifact_dir 不在允许的产物目录", "FORBIDDEN", 403);
  }
  return normalized;
}

function lstatRegularFile(filePath) {
  let stat;
  try {
    stat = fs.lstatSync(filePath);
  } catch (error) {
    if (error?.code === "ENOENT") throw makeError("原始产物不存在", "NOT_FOUND", 404);
    throw error;
  }
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw makeError("原始产物不是允许的普通文件", "FORBIDDEN", 403);
  }
  return stat;
}

function prepareRun(detail) {
  const normalized = assertSafeRelativePath(detail?.profile?.artifact_dir);
  const runSuffix = normalized.slice(ARTIFACT_DIR_PREFIX.length);
  let trustedReal;
  let runReal;
  try {
    trustedReal = fs.realpathSync.native(TRUSTED_ROOT);
    const resolved = path.resolve(TRUSTED_ROOT, ...runSuffix.split("/"));
    if (!isContained(TRUSTED_ROOT, resolved) || resolved === TRUSTED_ROOT) {
      throw makeError("产物目录越界", "FORBIDDEN", 403);
    }
    const runStat = fs.lstatSync(resolved);
    if (runStat.isSymbolicLink() || !runStat.isDirectory()) {
      throw makeError("产物目录不是允许的普通目录", "FORBIDDEN", 403);
    }
    runReal = fs.realpathSync.native(resolved);
  } catch (error) {
    if (error?.status) throw error;
    if (error?.code === "ENOENT") throw makeError("产物目录不存在", "NOT_FOUND", 404);
    throw error;
  }
  if (!isContained(trustedReal, runReal) || runReal === trustedReal) {
    throw makeError("产物目录不在可信根目录", "FORBIDDEN", 403);
  }

  const manifestPath = path.join(runReal, "run_manifest.json");
  const manifestStat = lstatRegularFile(manifestPath);
  if (manifestStat.size > MAX_MANIFEST_BYTES) {
    throw makeError("运行清单大小异常", "FORBIDDEN", 403);
  }
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  } catch {
    throw makeError("运行清单无法解析", "FORBIDDEN", 403);
  }
  if (!detail?.id || manifest?.session_id !== detail.id) {
    throw makeError("运行清单与采集记录不匹配", "FORBIDDEN", 403);
  }
  return { runReal, logicalRunDir: normalized };
}

function definitionFor(key) {
  const definition = ARTIFACTS[String(key || "")] || dynamicDefinitionForKey(key);
  if (!definition) throw makeError("未知原始产物 key", "NOT_FOUND", 404);
  return definition;
}

function resolveArtifact(context, key) {
  const definition = definitionFor(key);
  const candidate = path.resolve(context.runReal, ...definition.relative.split("/"));
  if (!isContained(context.runReal, candidate) || candidate === context.runReal) {
    throw makeError("原始产物路径越界", "FORBIDDEN", 403);
  }
  const stat = lstatRegularFile(candidate);
  const real = fs.realpathSync.native(candidate);
  if (!isContained(context.runReal, real) || real === context.runReal) {
    throw makeError("原始产物不在本轮目录", "FORBIDDEN", 403);
  }
  return {
    absolutePath: real,
    meta: {
      key: String(key),
      label: definition.label,
      path: `${context.logicalRunDir}/${definition.relative}`,
      size: stat.size,
      mime: definition.mime,
      previewable: definition.previewable === true,
      downloadable: true,
      modifiedAt: stat.mtime.toISOString(),
    },
  };
}

function completeUtf8Length(buffer) {
  if (!buffer.length) return 0;
  let lead = buffer.length - 1;
  while (lead >= 0 && (buffer[lead] & 0xc0) === 0x80) lead -= 1;
  if (lead < 0) return buffer.length;
  const byte = buffer[lead];
  const expected = byte < 0x80 ? 1 : byte >= 0xc2 && byte <= 0xdf ? 2 : byte >= 0xe0 && byte <= 0xef ? 3 : byte >= 0xf0 && byte <= 0xf4 ? 4 : 1;
  return buffer.length - lead < expected ? lead : buffer.length;
}

export function listResourceArtifacts(detail) {
  const context = prepareRun(detail);
  const artifacts = [];
  for (const key of Object.keys(ARTIFACTS)) {
    try {
      artifacts.push(resolveArtifact(context, key).meta);
    } catch (error) {
      if (error?.status !== 404) continue;
    }
  }
  const discovered = [];
  let visited = 0;
  const visit = (directory, relativeDirectory = "") => {
    if (discovered.length >= MAX_DYNAMIC_ARTIFACTS || visited >= MAX_DYNAMIC_ARTIFACTS * 10) return;
    let entries;
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (discovered.length >= MAX_DYNAMIC_ARTIFACTS || visited >= MAX_DYNAMIC_ARTIFACTS * 10) break;
      visited += 1;
      if (entry.isSymbolicLink()) continue;
      const relative = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(absolute, relative);
        continue;
      }
      if (!entry.isFile() || !dynamicArtifactShape(relative)) continue;
      discovered.push(relative);
    }
  };
  visit(context.runReal);
  for (const relative of discovered) {
    try {
      artifacts.push(resolveArtifact(context, dynamicArtifactKey(relative)).meta);
    } catch {}
  }
  return artifacts;
}

export function readResourceArtifact(detail, key, { offset = 0, limit = 64 * 1024 } = {}) {
  const context = prepareRun(detail);
  const opened = resolveArtifact(context, key);
  if (!opened.meta.previewable) {
    throw makeError("该原始产物不支持文本预览", "UNSUPPORTED", 415);
  }
  const start = Number(offset);
  const requested = Number(limit);
  if (!Number.isSafeInteger(start) || start < 0 || !Number.isSafeInteger(requested) || requested <= 0) {
    throw makeError("offset/limit 无效", "INVALID_ARTIFACT", 400);
  }
  if (start > opened.meta.size) {
    throw makeError("offset 超出文件大小", "RANGE_NOT_SATISFIABLE", 416);
  }
  const length = Math.min(requested, MAX_PREVIEW_BYTES, opened.meta.size - start);
  const buffer = Buffer.alloc(length);
  let bytesRead = 0;
  const fd = fs.openSync(opened.absolutePath, "r");
  try {
    bytesRead = fs.readSync(fd, buffer, 0, length, start);
  } finally {
    fs.closeSync(fd);
  }
  let consumed = bytesRead;
  if (start + bytesRead < opened.meta.size) {
    const complete = completeUtf8Length(buffer.subarray(0, bytesRead));
    if (complete > 0) consumed = complete;
  }
  const content = buffer.subarray(0, consumed).toString("utf8");
  const nextOffset = start + consumed;
  const truncated = nextOffset < opened.meta.size;
  return {
    meta: opened.meta,
    content,
    offset: start,
    bytesRead: consumed,
    nextOffset,
    truncated,
    eof: !truncated,
  };
}

export function openResourceArtifactDownload(detail, key) {
  const context = prepareRun(detail);
  return resolveArtifact(context, key);
}
