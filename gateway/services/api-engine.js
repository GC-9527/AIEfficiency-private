/**
 * OpenAI-compatible API Agent runner.
 *
 * Claude Code and Codex keep using their native CLIs. DeepSeek and other API
 * engines use this tool-calling loop with workspace-scoped developer tools.
 */
import path from "node:path";

import { getConfigValue } from "./config.js";
import { log, broadcastChatStream, broadcastChatStreamEnd } from "./logger.js";
import { executeTool, getToolDefinitions } from "./api-tools.js";
import { runRemoteTool } from "./remote-tools.js";
import { ensureExternalTempDirectory } from "./external-temp.js";
import {
  getAppMarketMcpOpenAiTools,
  isAppMarketMcpTool,
} from "./appmarket-admin-mcp.js";
import {
  completeAgentTurnTelemetry,
  createAgentTurnTelemetry,
  recordProviderResponse,
  recordRequestAttempt,
  recordRequestFailure,
  recordToolResultChars,
} from "./agent-telemetry.js";
import {
  authorizeWorkflowV2StageToolCall,
  sanitizeWorkflowV2StageToolResult,
  WorkflowV2StageToolPolicyError,
} from "./devbench/workflow-v2/stage-tool-policy.js";
import { normalizeApiMaxToolIterations } from "./agent-progress.js";

const API_AGENT_FIRST_CHUNK_TIMEOUT_MS = 90_000;
const API_AGENT_STREAM_IDLE_TIMEOUT_MS = 120_000;
const API_AGENT_TRANSPORT_RETRY_DELAY_MS = 50;
const API_AGENT_TRANSIENT_TRANSPORT_CODES = new Set([
  "EAI_AGAIN",
  "ECONNABORTED",
  "ECONNREFUSED",
  "ECONNRESET",
  "EHOSTUNREACH",
  "ENETRESET",
  "ENETUNREACH",
  "ENOTFOUND",
  "EPIPE",
  "ETIMEDOUT",
  "FETCH_FAILED",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_SOCKET",
]);

function positiveTimeoutMs(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function providerTimeoutError(code, timeoutMs) {
  const seconds = Math.max(1, Math.ceil(timeoutMs / 1000));
  const message = code === "API_PROVIDER_FIRST_CHUNK_TIMEOUT"
    ? `AI Provider 首包超时（${seconds} 秒），已终止该调用`
    : `AI Provider 响应流超过 ${seconds} 秒无新数据，已终止该调用`;
  return Object.assign(new Error(message), { code, terminalFailure: true });
}

function providerTransportCode(error) {
  let current = error;
  const visited = new Set();
  for (let depth = 0; current && depth < 6 && !visited.has(current); depth++) {
    visited.add(current);
    const code = String(current.code || "").trim().toUpperCase();
    if (code) return code;
    current = current.cause;
  }
  if (error instanceof TypeError && /^fetch failed$/i.test(String(error.message || "").trim())) {
    return "FETCH_FAILED";
  }
  return "UNKNOWN";
}

function isRetryableProviderTransportError(error) {
  const code = providerTransportCode(error);
  return code === "API_PROVIDER_FIRST_CHUNK_TIMEOUT"
    || API_AGENT_TRANSIENT_TRANSPORT_CODES.has(code);
}

function providerTransportRetryReason(error) {
  const code = providerTransportCode(error);
  if (code === "API_PROVIDER_FIRST_CHUNK_TIMEOUT") return "provider_first_chunk_timeout";
  return `provider_transport_${code.toLowerCase().replace(/[^a-z0-9]+/g, "_")}`;
}

function providerTransportFailure(error, providerName) {
  if (String(error?.code || "").startsWith("API_PROVIDER_")) return error;
  const transportCode = providerTransportCode(error);
  const failure = new Error(`${providerName || "AI Provider"} 连接失败（${transportCode}），请稍后重试`);
  failure.code = "API_PROVIDER_TRANSPORT_ERROR";
  failure.transportCode = transportCode;
  failure.terminalFailure = true;
  failure.cause = error;
  return failure;
}

async function waitForProviderTransportRetry(signal) {
  if (signal?.aborted) {
    throw signal.reason instanceof Error ? signal.reason : new Error("用户手动终止");
  }
  await new Promise((resolve, reject) => {
    let timer = null;
    const onAbort = () => {
      if (timer) clearTimeout(timer);
      reject(signal?.reason instanceof Error ? signal.reason : new Error("用户手动终止"));
    };
    timer = setTimeout(() => {
      signal?.removeEventListener?.("abort", onAbort);
      resolve();
    }, API_AGENT_TRANSPORT_RETRY_DELAY_MS);
    signal?.addEventListener?.("abort", onAbort, { once: true });
  });
}

function createProviderStreamWatchdog(externalSignal, { firstChunkTimeoutMs, streamIdleTimeoutMs }) {
  const controller = new AbortController();
  let timer = null;
  let timeoutError = null;
  const abort = (reason) => {
    if (!controller.signal.aborted) controller.abort(reason);
  };
  const schedule = (code, timeoutMs) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timeoutError = providerTimeoutError(code, timeoutMs);
      abort(timeoutError);
    }, timeoutMs);
  };
  const onExternalAbort = () => {
    const reason = externalSignal?.reason instanceof Error
      ? externalSignal.reason
      : new Error("用户手动终止");
    abort(reason);
  };

  if (externalSignal?.aborted) onExternalAbort();
  else externalSignal?.addEventListener?.("abort", onExternalAbort, { once: true });
  if (!controller.signal.aborted) {
    schedule("API_PROVIDER_FIRST_CHUNK_TIMEOUT", firstChunkTimeoutMs);
  }

  return {
    signal: controller.signal,
    markActivity() {
      if (!controller.signal.aborted) {
        schedule("API_PROVIDER_STREAM_IDLE_TIMEOUT", streamIdleTimeoutMs);
      }
    },
    timeoutError() {
      return timeoutError;
    },
    dispose() {
      if (timer) clearTimeout(timer);
      timer = null;
      externalSignal?.removeEventListener?.("abort", onExternalAbort);
    },
  };
}

const FINISH_TOOL = {
  type: "function",
  function: {
    name: "finish_task",
    description: "结束本轮任务并向用户提交明确的完成状态、变更和验证结果。完成前必须调用。",
    parameters: {
      type: "object",
      properties: {
        status: { type: "string", enum: ["completed", "partial", "failed"], description: "任务终态" },
        summary: { type: "string", description: "本轮结果摘要" },
        changes: { type: "array", items: { type: "string" }, description: "实际完成的代码或配置变更" },
        verification: { type: "array", items: { type: "string" }, description: "已执行的测试、构建或检查及结果" },
        remaining: { type: "array", items: { type: "string" }, description: "未完成、失败或需要用户处理的事项" },
        final_response: {
          type: "string",
          description: "面向用户的完整最终答复。必须遵守用户要求的标题、结构和结论标记；例如报告轮需原样包含“## 简短报告”、原因、措施和 REPORT_DONE。",
        },
      },
      required: ["status", "summary", "changes", "verification", "remaining", "final_response"],
    },
  },
};

const STRUCTURED_DESCRIPTOR_KEYS = Object.freeze([
  "contextId",
  "contextRevision",
  "idempotencyKey",
  "mode",
  "schema",
  "schemaId",
  "strategy",
]);

const WORKFLOW_V2_MATERIAL_TOOLS = new Set([
  "read_binary_metadata",
  "inspect_image",
  "inspect_pdf",
  "inspect_video",
  "list_archive",
  "extract_archive_entry",
]);

function materialReceiptFailure(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function parseSuccessfulMaterialResult(toolName, result) {
  let parsed = result;
  if (typeof parsed === "string") {
    try { parsed = JSON.parse(parsed); } catch { return null; }
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || parsed.error) return null;
  if (["read_binary_metadata", "inspect_image"].includes(toolName)) {
    return Number.isFinite(parsed.size) && /^[a-f0-9]{64}$/i.test(String(parsed.sha256 || "")) ? parsed : null;
  }
  if (toolName === "inspect_pdf") {
    return parsed.pdf && typeof parsed.pdf === "object" && Array.isArray(parsed.renderedPages) ? parsed : null;
  }
  if (toolName === "inspect_video") {
    return parsed.metadata && typeof parsed.metadata === "object" && Array.isArray(parsed.frames) ? parsed : null;
  }
  if (toolName === "list_archive") {
    return parsed.archive && typeof parsed.archive === "object" && Array.isArray(parsed.archive.entries) ? parsed : null;
  }
  if (toolName === "extract_archive_entry") {
    return typeof parsed.entryPath === "string" && /^[a-f0-9]{64}$/i.test(String(parsed.sha256 || "")) ? parsed : null;
  }
  return null;
}

function captureFailureStatus(message) {
  return /(?:not available|unavailable|ENOENT|not found|missing executable)/i.test(String(message || ""))
    ? "BLOCKED"
    : "FAIL";
}

/**
 * Converts only successful, system-produced material tool observations into
 * READ/CAPTURE receipts. Model text cannot claim success or provide hashes.
 */
export async function recordWorkflowV2MaterialToolEvidence({
  toolName,
  result,
  authorizedArgs,
  executedArgs,
  recorder,
  cwd,
  generatedRoot,
} = {}) {
  if (!WORKFLOW_V2_MATERIAL_TOOLS.has(toolName)) return Object.freeze({ handled: false });
  const parsed = parseSuccessfulMaterialResult(toolName, result);
  if (!parsed) return Object.freeze({ handled: true, successful: false, receiptIds: [] });
  if (!recorder || typeof recorder.recordRead !== "function") {
    throw materialReceiptFailure(
      "WORKFLOW_V2_MATERIAL_READ_RECEIPT_UNAVAILABLE",
      "Gateway material inspection succeeded but the READ receipt recorder is unavailable",
    );
  }
  const sourceAbsolutePath = String(executedArgs?.path || "");
  const read = await recorder.recordRead({
    absolutePath: sourceAbsolutePath,
    toolName,
    rootId: authorizedArgs?.rootId || null,
    operationArgs: authorizedArgs || {},
  });
  const readReceiptId = read?.envelope?.payload?.receiptId;
  if (!readReceiptId) {
    throw materialReceiptFailure(
      "WORKFLOW_V2_MATERIAL_READ_RECEIPT_MISSING",
      "Material tool input is not the verified frozen manifest bytes",
    );
  }
  const receiptIds = [readReceiptId];
  const captureRequests = [];
  if (toolName === "inspect_video") {
    const observed = Array.isArray(parsed.frames) ? [...parsed.frames] : [];
    for (const requested of Array.isArray(authorizedArgs?.timestamps) ? authorizedArgs.timestamps.slice(0, 10) : []) {
      const timestamp = Math.max(0, Number(requested));
      const index = observed.findIndex((entry) => Number(entry?.timestamp) === timestamp);
      const frame = index >= 0 ? observed.splice(index, 1)[0] : null;
      captureRequests.push({
        captureKind: "video-frame",
        timestamp,
        observation: frame,
      });
    }
  } else if (toolName === "inspect_pdf") {
    const observed = Array.isArray(parsed.renderedPages) ? [...parsed.renderedPages] : [];
    const pages = [...new Set((Array.isArray(authorizedArgs?.render_pages) ? authorizedArgs.render_pages : [])
      .map((value) => Math.floor(Number(value))).filter((value) => value > 0))].slice(0, 10);
    for (const page of pages) {
      const index = observed.findIndex((entry) => Number(entry?.page) === page);
      const rendered = index >= 0 ? observed.splice(index, 1)[0] : null;
      captureRequests.push({ captureKind: "pdf-page", page, observation: rendered });
    }
  }
  if (captureRequests.length && typeof recorder.recordCapture !== "function") {
    throw materialReceiptFailure(
      "WORKFLOW_V2_MATERIAL_CAPTURE_RECEIPT_UNAVAILABLE",
      "Gateway media inspection produced frame/page observations but the CAPTURE recorder is unavailable",
    );
  }
  for (const request of captureRequests) {
    const observation = request.observation;
    const observationError = String(observation?.error || (observation ? "capture output is missing" : "capture observation is missing"));
    const observedStatus = observation?.ok === true
      ? "PASS"
      : captureFailureStatus(observationError);
    const generatedAbsolutePath = observation?.path
      ? path.resolve(String(cwd || ""), String(observation.path))
      : null;
    const captured = await recorder.recordCapture({
      sourceAbsolutePath,
      generatedAbsolutePath,
      generatedRoot,
      expectedSha256: observation?.sha256 || null,
      toolName,
      rootId: authorizedArgs?.rootId || null,
      operationArgs: authorizedArgs || {},
      captureKind: request.captureKind,
      ...(request.captureKind === "video-frame" ? { timestamp: request.timestamp } : { page: request.page }),
      observedStatus,
      error: observationError,
    });
    const captureReceiptId = captured?.envelope?.payload?.receiptId;
    if (!captureReceiptId) {
      throw materialReceiptFailure(
        "WORKFLOW_V2_MATERIAL_CAPTURE_RECEIPT_MISSING",
        "Gateway media capture observation could not be persisted as a receipt",
      );
    }
    receiptIds.push(captureReceiptId);
  }
  return Object.freeze({ handled: true, successful: true, receiptIds: Object.freeze(receiptIds), parsed });
}

function workflowV2StructuredError(code, message, transcript = []) {
  const error = new Error(message);
  error.code = code;
  error.terminalFailure = true;
  error.transcript = Array.isArray(transcript) ? transcript : [];
  return error;
}

function isJsonValue(value, seen = new Set()) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object" || seen.has(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) return false;
  seen.add(value);
  const valid = Object.values(value).every((child) => isJsonValue(child, seen));
  seen.delete(value);
  return valid;
}

function deepFreezeJson(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreezeJson(child);
  return Object.freeze(value);
}

function snapshotStructuredOutput(value, telemetryContext = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value) || !isJsonValue(value)) {
    throw workflowV2StructuredError(
      "WORKFLOW_V2_STRUCTURED_DESCRIPTOR_INVALID",
      "structuredOutput 必须是可冻结的 JSON object",
    );
  }
  const keys = Object.keys(value).sort();
  if (keys.length !== STRUCTURED_DESCRIPTOR_KEYS.length
    || keys.some((key, index) => key !== STRUCTURED_DESCRIPTOR_KEYS[index])
    || value.mode !== "structured"
    || value.strategy !== "finish_stage"
    || typeof value.schemaId !== "string"
    || !value.schemaId.trim()
    || value.schemaId !== value.schemaId.trim()
    || typeof value.contextId !== "string"
    || !value.contextId.trim()
    || value.contextId !== value.contextId.trim()
    || typeof value.idempotencyKey !== "string"
    || !value.idempotencyKey.trim()
    || value.idempotencyKey !== value.idempotencyKey.trim()
    || !Number.isSafeInteger(value.contextRevision)
    || value.contextRevision < 1
    || !value.schema
    || typeof value.schema !== "object"
    || Array.isArray(value.schema)) {
    throw workflowV2StructuredError(
      "WORKFLOW_V2_STRUCTURED_DESCRIPTOR_INVALID",
      "structuredOutput 不符合 finish_stage 冻结合同",
    );
  }
  const identityMatches = telemetryContext?.promptMode === "structured"
    && telemetryContext.contextId === value.contextId
    && telemetryContext.contextRevision === value.contextRevision
    && telemetryContext.schemaId === value.schemaId
    && telemetryContext.idempotencyKey === value.idempotencyKey;
  if (!identityMatches) {
    throw workflowV2StructuredError(
      "WORKFLOW_V2_STRUCTURED_IDENTITY_MISMATCH",
      "structuredOutput 与 telemetry context 身份不一致",
    );
  }
  return deepFreezeJson(JSON.parse(JSON.stringify(value)));
}

function finishStageTool(structuredOutput) {
  return deepFreezeJson({
    type: "function",
    function: {
      name: "finish_stage",
      description: "单独调用且仅调用一次，提交当前阶段的结构化结果。",
      parameters: structuredOutput.schema,
    },
  });
}

// 非流式简单调用（规划/审查/汇总）的兜底超时：这些调用没有外部 abort signal 可挂载，
// 不加超时的话上游引擎卡死时 fetch 永久挂起，任务既无法停止也无法失败收敛。
const SIMPLE_CALL_TIMEOUT_MS = 180_000;

export function shouldExecuteApiToolLocally(name, remoteTarget = null) {
  return !remoteTarget || isAppMarketMcpTool(name);
}

const STATUS_LABELS = { completed: "已完成", partial: "部分完成", failed: "未完成" };
const MUTATING_TOOL_NAMES = new Set(["write_file", "edit_file", "apply_patch"]);
const TEXT_FINALIZATION_SYSTEM_PROMPT = [
  "兼容性收口轮：本轮不提供任何工具。",
  "忽略此前“必须调用 finish_task”的调用形式要求；只依据对话中已经执行的操作和结果收口，禁止继续调查、规划、调用或描述未来工具动作。",
  "只输出一个合法 JSON 对象，不要 Markdown 代码围栏、前缀或后缀文字。",
  'JSON 字段必须完整：{"status":"completed|partial|failed","summary":"结果摘要","changes":["实际变更"],"verification":["实际验证"],"remaining":["遗留事项"],"final_response":"面向用户的完整最终答复"}。',
  "status 必须忠实反映已有证据；存在未解决失败或必要验证缺失时不得填 completed。",
  "final_response 必须保留用户要求的 Markdown 标题、字段和结论标记，并给出可直接展示给用户的最终结果，不能写计划或请求确认。",
].join("\n");

function genericArtifactScope(taskId, avoidRoots = []) {
  const id = String(taskId || "api-task").replace(/[^A-Za-z0-9_.-]+/g, "_").slice(0, 100) || "api-task";
  return {
    scope: { kind: "generic", id },
    tempRoot: ensureExternalTempDirectory(["aiefficiency", "api-artifacts", id], { avoidRoots }),
  };
}

export function isApiEngine(engine) {
  const apiEngines = getConfigValue("apiEngines") || {};
  const cfg = apiEngines[engine];
  return !!(cfg && cfg.enabled && cfg.apiKey);
}

export function getEnabledApiEngines() {
  const apiEngines = getConfigValue("apiEngines") || {};
  return Object.entries(apiEngines)
    .map(([id, cfg]) => ({ id, ...cfg, apiKey: String(cfg.apiKey || "").trim(), baseUrl: String(cfg.baseUrl || "").trim(), model: String(cfg.model || "").trim() }))
    .filter((cfg) => cfg.enabled && cfg.apiKey);
}

function normalizedEngineConfig(cfg = {}) {
  return {
    ...cfg,
    baseUrl: String(cfg.baseUrl || "").trim(),
    apiKey: String(cfg.apiKey || "").trim(),
    model: String(cfg.model || "").trim(),
  };
}

function reasoningRequest(engine, cfg) {
  let result = {};
  if (engine === "deepseek") {
    if (cfg.thinkingEnabled === false || String(cfg.reasoningEffort || "").trim().toLowerCase() === "off") {
      result = { thinking: { type: "disabled" } };
    } else {
      const effort = String(cfg.reasoningEffort || "").trim() || "high";
      result = {
        thinking: { type: "enabled" },
        reasoning_effort: effort,
      };
    }
  } else if (cfg.thinkingEnabled === true) {
    const effort = String(cfg.reasoningEffort || "").trim().toLowerCase();
    result = {
      thinking: { type: "enabled" },
      ...(["low", "medium", "high"].includes(effort) ? { reasoning_effort: effort } : {}),
    };
  }
  // MiniMax-M3 默认把思考内联在 content 的 <think>...</think> 标签里，会混进正文显示。
  // 开启 reasoning_split 后思考拆到 reasoning_content 字段，流式解析器才能路由到思考流视图。
  if (engine === "minimax" || /minimax/i.test(String(cfg.model || ""))) {
    result = { ...result, reasoning_split: true };
  }
  return result;
}

/**
 * 探测 API 引擎连通性（最小 chat/completions 请求）。
 * @param {string} engineId
 * @param {object} [overrides] 探测前可覆盖 apiKey/baseUrl/model（用于保存前试连）
 */
export async function probeApiEngine(engineId, overrides = {}) {
  const apiEngines = getConfigValue("apiEngines") || {};
  const raw = apiEngines[engineId];
  if (!raw && !overrides.baseUrl && !overrides.apiKey) {
    throw new Error(`未知 API 引擎: ${engineId}`);
  }
  const cfg = normalizedEngineConfig({ ...(raw || {}), ...overrides });
  if (!cfg.apiKey) throw new Error("未配置 API Key");
  if (!cfg.baseUrl) throw new Error("未配置 Base URL");
  if (!cfg.model) throw new Error("未配置模型");

  const url = `${cfg.baseUrl.replace(/\/$/, "")}/chat/completions`;
  const started = Date.now();
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${cfg.apiKey}`,
    },
    body: JSON.stringify({
      model: cfg.model,
      messages: [{ role: "user", content: "ping" }],
      max_tokens: 8,
      stream: false,
    }),
    signal: AbortSignal.timeout(20000),
  });
  const latencyMs = Date.now() - started;
  const text = await response.text().catch(() => "");
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* ignore */ }
  if (!response.ok) {
    const detail = (json?.error?.message || json?.msg || text || "").toString().slice(0, 300);
    return {
      ok: false,
      available: false,
      status: "error",
      engineId,
      name: cfg.name || engineId,
      model: cfg.model,
      baseUrl: cfg.baseUrl,
      latencyMs,
      httpStatus: response.status,
      error: detail || `HTTP ${response.status}`,
    };
  }
  const reply = json?.choices?.[0]?.message?.content;
  return {
    ok: true,
    available: true,
    status: "available",
    engineId,
    name: cfg.name || engineId,
    model: cfg.model,
    baseUrl: cfg.baseUrl,
    latencyMs,
    httpStatus: response.status,
    preview: typeof reply === "string" ? reply.slice(0, 80) : "",
  };
}

function toStrings(value) {
  return Array.isArray(value) ? value.map((item) => String(item || "").trim()).filter(Boolean) : [];
}

function operationFallbacks(operations) {
  const changes = [];
  const verification = [];
  for (const operation of operations) {
    const path = operation.args?.path || operation.args?.file || "";
    if (MUTATING_TOOL_NAMES.has(operation.name)) changes.push(`${operation.name}${path ? `：${path}` : ""}`);
    if (operation.name === "run_tests") {
      const match = String(operation.result || "").match(/test_summary:\s*(\{[^\n]+\})/);
      verification.push(match ? `${operation.args?.command || "测试"}：${match[1]}` : `${operation.args?.command || "测试"}：已执行`);
    }
    if (operation.name === "git_status" || operation.name === "git_diff") verification.push(`${operation.name}：已检查`);
  }
  return { changes: [...new Set(changes)], verification: [...new Set(verification)] };
}

export function formatCompletionReport(args = {}, operations = []) {
  const requestedStatus = STATUS_LABELS[args.status] ? args.status : "partial";
  let status = requestedStatus;
  const fallback = operationFallbacks(operations);
  const changes = toStrings(args.changes).length ? toStrings(args.changes) : fallback.changes;
  const verification = toStrings(args.verification).length ? toStrings(args.verification) : fallback.verification;
  const remaining = toStrings(args.remaining);
  const hasMutations = operations.some((operation) => MUTATING_TOOL_NAMES.has(operation.name));
  const hasVerification = operations.some((operation) => ["run_tests", "git_status", "git_diff"].includes(operation.name));
  const failedOperation = operations.find((operation) => {
    const result = String(operation.result || "");
    return /^(?:错误|工具执行异常):/.test(result)
      || /exit_code:\s*(?!0\b)\S+/i.test(result)
      || /test_summary:\s*\{[^\n]*"status":"(?:failed|timeout)"/i.test(result);
  });
  if (status === "completed" && hasMutations && !hasVerification) {
    status = "partial";
    remaining.push("检测到文件修改，但未执行 git diff/status 或测试验证");
  }
  if (status === "completed" && failedOperation) {
    status = "partial";
    remaining.push(`工具 ${failedOperation.name} 执行失败，需要处理后重新验证`);
  }
  const finalResponse = String(args.final_response || args.finalResponse || "").trim();
  // API Agent 的 finish_task 是结构化收口工具，不应吞掉上层工作流要求的 Markdown
  // 正文或结论标记。仅当安全检查没有把 completed 降级时才原样透传，避免绕过
  // “有修改但未验证 / 工具失败”的完成门禁。
  if (finalResponse && !(requestedStatus === "completed" && status !== "completed")) {
    return finalResponse;
  }
  const sections = [
    `任务状态：${STATUS_LABELS[status]}`,
    "",
    String(args.summary || (status === "completed" ? "任务已完成。" : "任务未完全完成。")).trim(),
    "",
    "变更摘要：",
    ...(changes.length ? changes.map((item) => `- ${item}`) : ["- 无文件变更"]),
    "",
    "验证结果：",
    ...(verification.length ? verification.map((item) => `- ${item}`) : ["- 未执行验证"]),
  ];
  if (remaining.length || status !== "completed") {
    sections.push("", "遗留事项：", ...(remaining.length ? remaining.map((item) => `- ${item}`) : ["- 未提供明确遗留项"]));
  }
  return sections.join("\n");
}

export function parseTextCompletionPayload(value) {
  const text = String(value || "").trim();
  if (!text) return null;
  const candidates = [];
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) candidates.push(fenced[1].trim());
  candidates.push(text);
  const firstBrace = text.indexOf("{");
  const lastBrace = text.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) candidates.push(text.slice(firstBrace, lastBrace + 1));

  for (const candidate of [...new Set(candidates)]) {
    let parsed;
    try { parsed = JSON.parse(candidate); } catch { continue; }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
    const status = String(parsed.status || "").trim().toLowerCase();
    if (!STATUS_LABELS[status]) continue;
    if (typeof parsed.summary !== "string"
      || !Array.isArray(parsed.changes)
      || !Array.isArray(parsed.verification)
      || !Array.isArray(parsed.remaining)
      || typeof parsed.final_response !== "string") continue;
    return { ...parsed, status };
  }
  return null;
}

function makeSystemPrompt({ cfg, remote, localTarget, toolContext, structuredOutput = null }) {
  const localDirs = [localTarget.cwd, ...(localTarget.addDirs || [])].filter(Boolean);
  const readOnly = toolContext.commandPolicy === "read_only";
  const location = remote
    ? `你在远端工程 ${remote.root} 内工作；所有工具都在远端执行，路径不得越出工程根。`
    : localTarget.cwd
      ? `主工作区：${localTarget.cwd}。允许的关联工作区：${localDirs.slice(1).join("；") || "无"}。`
      : "所有文件操作必须限制在当前工作区。";
  return [
    readOnly
      ? `你是 ${cfg.name || "API"} 代码评审 Agent，负责以只读方式检查代码并给出专家结论。`
      : `你是 ${cfg.name || "API"} 编程 Agent，负责直接检查、修改并验证代码。`,
    location,
    `命令授权级别：${toolContext.commandPolicy}；文件工具始终受工作区路径隔离。`,
    "上述工具已按当前权限策略自动批准；无需询问用户是否允许，直接调用工具。若工具返回权限拒绝，改用安全工具或在最终报告中说明。",
    "工作规则：",
    "1. 先用 search_files、list_dir、分段 read_file 理解现状，避免猜测。",
    readOnly
      ? "2. 当前为只读评审：不得修改文件或执行自由 Shell；用 git_status、git_diff、git_inspect 检查状态、提交、历史和指定版本文件。"
      : "2. 优先用 apply_patch/edit_file 做最小改动；不要覆盖用户已有的无关修改。",
    readOnly
      ? "3. 只报告实际读取到的证据；需要运行构建或测试但工具不可用时，明确列为未验证项。"
      : "3. 用 git_status/git_diff 检查实际变更，并运行与风险匹配的测试。",
    readOnly
      ? "4. 评审结论必须区分阻断合入、需修改和证据不足，不得把静态检查冒充运行时验证。"
      : "4. 短命令用 run_command；长构建/测试用 start_process，然后持续 poll_process 直至终态，必要时 stop_process。",
    "5. 工具失败时分析原因并修正，不得把调用工具的计划冒充完成结果。",
    "6. 只有实现与必要验证均完成才能报告 completed；有失败或未验证项必须报告 partial/failed。",
    structuredOutput
      ? "7. 本轮最终只能单独调用一次 finish_stage；禁止用普通文本、Markdown 或其他工具作为终态，不得在同一轮混合其他工具。"
      : "7. 本轮最后必须调用 finish_task，禁止以普通文本直接结束。summary 只写结果摘要；final_response 必须放入面向用户的完整最终答复，并原样保留用户要求的 Markdown 标题、字段和 HTML 结论标记（例如 REPORT_DONE），不能用通用“任务状态/变更摘要”代替。",
  ].join("\n");
}

function emitStream({ taskId, sessionId, engine, chunk, deltaType, aiSnapshot }) {
  if (!sessionId || !chunk) return;
  broadcastChatStream({ taskId, chunk, deltaType, engine, sessionId, aiSnapshot: aiSnapshot || null });
}

function successResult(report, transcript, telemetry) {
  const completedTelemetry = completeAgentTurnTelemetry(telemetry);
  completedTelemetry.executionSucceeded = true;
  const usage = completedTelemetry.usage?.source === "provider"
    ? {
      inputTokens: completedTelemetry.usage.inputTokens,
      outputTokens: completedTelemetry.usage.outputTokens,
      cacheReadTokens: completedTelemetry.usage.cacheReadTokens,
      cacheCreationTokens: completedTelemetry.usage.cacheCreationTokens,
      costUsd: completedTelemetry.usage.costUsd,
    }
    : null;
  return {
    output: report,
    report,
    stderr: "",
    cliSessionId: null,
    transcript,
    usage,
    telemetry: completedTelemetry,
  };
}

function structuredSuccessResult(structuredResult, structuredSchemaId, transcript, telemetry) {
  const completedTelemetry = completeAgentTurnTelemetry(telemetry);
  completedTelemetry.executionSucceeded = true;
  const usage = completedTelemetry.usage?.source === "provider"
    ? {
      inputTokens: completedTelemetry.usage.inputTokens,
      outputTokens: completedTelemetry.usage.outputTokens,
      cacheReadTokens: completedTelemetry.usage.cacheReadTokens,
      cacheCreationTokens: completedTelemetry.usage.cacheCreationTokens,
      costUsd: completedTelemetry.usage.costUsd,
    }
    : null;
  return {
    output: "",
    report: "",
    stderr: "",
    cliSessionId: null,
    transcript,
    usage,
    telemetry: completedTelemetry,
    structuredResult: deepFreezeJson(JSON.parse(JSON.stringify(structuredResult))),
    structuredSchemaId,
  };
}

/** Execute an API-backed coding task with a multi-turn tool loop. */
export async function executeApiEngine(engine, prompt, taskId, sessionId, remoteTarget, localTarget = {}, runtimePrefs = {}) {
  const rawTelemetryContext = runtimePrefs.telemetryContext || {};
  const structuredRequested = rawTelemetryContext.promptMode === "structured"
    || runtimePrefs.structuredOutput != null;
  if (structuredRequested && runtimePrefs.structuredOutput == null) {
    throw workflowV2StructuredError(
      "WORKFLOW_V2_STRUCTURED_DESCRIPTOR_INVALID",
      "structured 模式缺少冻结 structuredOutput",
    );
  }
  if (structuredRequested && (!rawTelemetryContext || typeof rawTelemetryContext !== "object"
    || Array.isArray(rawTelemetryContext) || !isJsonValue(rawTelemetryContext))) {
    throw workflowV2StructuredError(
      "WORKFLOW_V2_STRUCTURED_IDENTITY_MISMATCH",
      "structured telemetryContext 必须是可冻结的 JSON object",
    );
  }
  const telemetryContext = structuredRequested
    ? deepFreezeJson(JSON.parse(JSON.stringify(rawTelemetryContext)))
    : rawTelemetryContext;
  const structuredOutput = structuredRequested
    ? snapshotStructuredOutput(runtimePrefs.structuredOutput, telemetryContext)
    : null;
  const structuredMode = structuredOutput !== null;
  const apiEngines = getConfigValue("apiEngines") || {};
  const rawCfg = apiEngines[engine];
  if (!rawCfg) throw new Error(`未知 API 引擎: ${engine}`);
  const cfg = normalizedEngineConfig(rawCfg);
  // 故事点级覆盖：不改全局 apiEngines 配置
  const modelOverride = String(runtimePrefs.model || localTarget.aiModel || "").trim();
  const tierOverride = String(runtimePrefs.tier || runtimePrefs.reasoningEffort || localTarget.aiTier || "").trim();
  if (modelOverride) cfg.model = modelOverride;
  if (tierOverride) {
    cfg.reasoningEffort = tierOverride;
    // 与 callApiEngineText 口径一致：档位非 off 即视为开启思考；否则 reasoning_effort 会被静默丢弃，
    // 前端展示「档位 high」实际并未下发 reasoning_effort，方舟/智谱等也就没有深度思考流量。
    cfg.thinkingEnabled = cfg.reasoningEffort.toLowerCase() !== "off";
  }
  // 回答级不可变快照（模型/档位），随流式片段下发，让前端在生成过程中就能展示「当前用什么 AI 模型档位」
  const aiSnapshot = runtimePrefs.aiSnapshot || null;
  // 流式观察者：devbench 把它挂到 task.onStream → appendLiveStream → liveDraft，用于刷新/路由切换后恢复实时内容。
  // CLI 路径已在 executeCli 的 emitStream 里同步调用 task.onStream，API 引擎路径原本漏了，导致
  // 故事点对话刷新后看到的草稿与服务端 live draft 不一致、UI 显示空白。这里补齐。
  const streamObserver = typeof runtimePrefs.onStream === "function" ? runtimePrefs.onStream : null;
  const meaningfulProgressObserver = typeof runtimePrefs.onMeaningfulProgress === "function"
    ? runtimePrefs.onMeaningfulProgress
    : null;
  const emit = (args) => {
    emitStream({ ...args, aiSnapshot });
    if (streamObserver) {
      try { streamObserver({ chunk: args.chunk, deltaType: args.deltaType, engine: args.engine, usage: args.usage }); } catch {}
    }
  };
  if (!cfg.enabled) throw new Error(`API 引擎 ${engine} 未启用`);
  if (!cfg.apiKey) throw new Error(`API 引擎 ${engine} 未配置 API Key`);
  if (!cfg.baseUrl) throw new Error(`API 引擎 ${engine} 未配置 Base URL`);
  if (!cfg.model) throw new Error(`API 引擎 ${engine} 未配置模型`);

  const url = `${cfg.baseUrl.replace(/\/$/, "")}/chat/completions`;
  let maxIter = normalizeApiMaxToolIterations(getConfigValue("apiMaxToolIterations"));
  const apiAgent = getConfigValue("apiAgent") || {};
  const firstChunkTimeoutMs = positiveTimeoutMs(
    runtimePrefs.firstChunkTimeoutMs ?? apiAgent.providerFirstChunkTimeoutMs,
    API_AGENT_FIRST_CHUNK_TIMEOUT_MS,
  );
  const streamIdleTimeoutMs = positiveTimeoutMs(
    runtimePrefs.streamIdleTimeoutMs ?? apiAgent.providerStreamIdleTimeoutMs,
    API_AGENT_STREAM_IDLE_TIMEOUT_MS,
  );
  const remote = remoteTarget?.host ? remoteTarget : null;
  const stageToolPolicy = localTarget?.stageToolPolicy || null;
  if (structuredMode && remote) {
    throw workflowV2StructuredError(
      "WORKFLOW_V2_STRUCTURED_REMOTE_EXECUTION_UNSUPPORTED",
      "structured Workflow v2 tasks require the local Gateway controlled-execution and receipt boundary",
    );
  }
  if (localTarget.storyScoped && !localTarget.tempRoot) {
    throw new Error("故事点 API Agent 缺少外置 tempFiles 目录，已拒绝回退到源码 worktree");
  }
  const genericArtifacts = localTarget.storyScoped
    ? null
    : genericArtifactScope(taskId, [localTarget.cwd]);
  const artifactScope = localTarget.storyScoped
    ? {
      kind: "story",
      id: String(localTarget.artifactScope?.id || ""),
      title: String(localTarget.artifactScope?.title || ""),
      docSlug: String(localTarget.artifactScope?.docSlug || ""),
    }
    : genericArtifacts.scope;
  if (localTarget.storyScoped && (!artifactScope.id || !artifactScope.docSlug)) {
    throw new Error("故事点 API Agent 缺少可验证的故事点产物范围");
  }
  const tempRoot = localTarget.storyScoped ? localTarget.tempRoot : genericArtifacts.tempRoot;
  const toolContext = {
    cwd: localTarget.cwd,
    allowedRoots: [...new Set([...(localTarget.addDirs || []), tempRoot].filter(Boolean))],
    tempRoot,
    artifactScope,
    storyTaskId: localTarget.storyScoped ? taskId : "",
    workspaceIsolation: apiAgent.workspaceIsolation !== false,
    commandPolicy: localTarget.commandPolicy === "read_only"
      ? "read_only"
      : (apiAgent.commandPolicy || "workspace"),
    workflowV2ControlledExecution: !!(
      localTarget.stageToolPolicy
      && localTarget.stageReceiptRecorder
    ),
    signal: localTarget.signal || null,
    taskId,
  };
  const appMarketTools = localTarget.storyScoped
    ? await getAppMarketMcpOpenAiTools()
    : [];
  let toolDefinitions = [
    ...getToolDefinitions(toolContext),
    ...appMarketTools,
    structuredMode ? finishStageTool(structuredOutput) : FINISH_TOOL,
  ];
  // M5: stage-tool-policy 是唯一工具权限源。策略存在时把发送给 Provider 的工具定义
  // 过滤到 allowedToolNames（终态工具始终保留），并把迭代上限压到 maxToolIterations。
  // 文件类工具 Schema 注入 rootId 必填参数，模型必须使用 StageContext scope.roots
  // 中的 rootId + 相对路径；AppMarket MCP 工具与终态工具保持原 Schema。
  if (stageToolPolicy) {
    const policyAllowed = new Set(stageToolPolicy.allowedToolNames);
    policyAllowed.add("finish_task");
    policyAllowed.add("finish_stage");
    toolDefinitions = toolDefinitions
      .map((definition) => {
        const name = String(definition?.function?.name || definition?.name || "");
        if (!policyAllowed.has(name)) return null;
        if (name === "finish_task" || name === "finish_stage" || isAppMarketMcpTool(name)) return definition;
        const parameters = definition?.function?.parameters || {};
        return {
          ...definition,
          function: {
            ...definition.function,
            parameters: {
              ...parameters,
              properties: {
                ...(parameters.properties || {}),
                rootId: {
                  type: "string",
                  description: "目标必须属于 StageContext scope.roots 中的 rootId；与 path 一起使用",
                },
              },
              required: [...new Set([...(parameters.required || []), "rootId"])],
            },
          },
        };
      })
      .filter(Boolean);
    const policyIterCap = Number.isSafeInteger(stageToolPolicy.maxToolIterations)
      ? stageToolPolicy.maxToolIterations + 1
      : null;
    if (policyIterCap !== null) {
      maxIter = Math.min(maxIter, policyIterCap);
    }
  }
  const systemPrompt = makeSystemPrompt({ cfg, remote, localTarget, toolContext, structuredOutput });
  const telemetry = createAgentTurnTelemetry({
    provider: engine,
    model: cfg.model,
    prompt,
    systemPrompt,
    toolDefinitions,
    storyId: telemetryContext.storyId,
    attemptId: telemetryContext.attemptId,
    workflowKind: telemetryContext.workflowKind,
    stage: telemetryContext.stage,
    contextId: telemetryContext.contextId,
    contextRevision: telemetryContext.contextRevision,
    turnAttempt: telemetryContext.turnAttempt,
    retryReasons: telemetryContext.retryReasons,
    visibility: "openai_compatible_requests",
  });
  const execOneRaw = async (fnName, fnArgs) => {
    // M5: 执行层再次校验阶段工具策略（rootId/相对路径/写权限/参数白名单），
    // 策略拒绝直接作为工具结果返回，模型无法绕过。AppMarket MCP 工具按策略放行。
    let authorized = null;
    if (stageToolPolicy) {
      try {
        authorized = authorizeWorkflowV2StageToolCall(stageToolPolicy, fnName, fnArgs || {});
      } catch (error) {
        if (error instanceof WorkflowV2StageToolPolicyError) {
          log(taskId, "warn", "api-engine", `阶段工具策略拒绝 ${fnName}: ${error.code}`);
          return `工具被阶段策略拒绝: ${error.code}${error.message ? `: ${error.message}` : ""}`;
        }
        throw error;
      }
      // 策略返回规范化后的参数与已校验的绝对路径引用；apply_patch 的 patch 文本
      // 保持原样（executor 按 base path 解析目标），其余 path/file/output_* 字段
      // 替换为策略解析出的绝对路径，executor 只负责在已授权边界内执行。
      fnArgs = { ...authorized.args };
      if (["inspect_pdf", "inspect_video"].includes(fnName) && typeof fnArgs.output_dir === "string") {
        fnArgs.output_dir = path.join(toolContext.tempRoot, ...fnArgs.output_dir.split("/").filter(Boolean));
      }
      for (const ref of authorized.pathRefs) {
        if (ref.field === "patch" || ref.field === "controlledRoot") continue;
        fnArgs[ref.field] = ref.absolutePath;
      }
    }
    if (stageToolPolicy && ["run_local_check", "run_verification_case"].includes(fnName)) {
      const recorder = localTarget.stageReceiptRecorder;
      const absoluteRoot = authorized?.pathRefs?.find((ref) => ref.field === "controlledRoot")?.absolutePath || "";
      const runner = fnName === "run_local_check" ? recorder?.runLocalCheck : recorder?.runVerificationCase;
      if (typeof runner !== "function") {
        return JSON.stringify({
          status: "BLOCKED",
          code: "WORKFLOW_V2_RECEIPT_EXECUTION_PROFILE_MISSING",
          message: "Gateway controlled execution profile/recorder is unavailable",
        });
      }
      try {
        const recorded = await runner.call(recorder, {
          rootId: authorized.args.rootId,
          ...(fnName === "run_local_check"
            ? { checkId: authorized.args.checkId }
            : { caseId: authorized.args.caseId }),
          absoluteRoot,
          signal: localTarget.signal || null,
        });
        const serialized = JSON.stringify({
          status: recorded.status,
          action: recorded.action,
          receiptId: recorded.receiptId,
          evidenceId: recorded.evidenceId || null,
          replayed: recorded.replayed === true,
          output: recorded.output || "",
        });
        return sanitizeWorkflowV2StageToolResult(stageToolPolicy, serialized);
      } catch (error) {
        log(taskId, "warn", "api-engine", `controlled execution rejected ${fnName}: ${error?.code || error?.message || error}`);
        return JSON.stringify({
          status: "BLOCKED",
          code: String(error?.code || "WORKFLOW_V2_RECEIPT_EXECUTION_FAILED"),
          message: String(error?.message || "Gateway controlled execution failed"),
        });
      }
    }
    // AppMarket credentials and the read-only MCP process belong to the
    // Gateway environment. Do not forward these calls to a project executor,
    // which may neither have the registration nor be allowed to receive the
    // backend credentials.
    if (!shouldExecuteApiToolLocally(fnName, remote)) {
      return runRemoteTool(remote, fnName, fnArgs, localTarget.signal, {
        taskId,
        sessionId,
        clientId: engine,
        artifactScope,
        commandPolicy: toolContext.commandPolicy,
      });
    }
    let editRecord = null;
    let result;
    if (stageToolPolicy
      && ["edit_file", "apply_patch"].includes(fnName)
      && typeof localTarget.stageReceiptRecorder?.recordEditExecution === "function") {
      try {
        editRecord = await localTarget.stageReceiptRecorder.recordEditExecution({
          toolName: fnName,
          rootId: authorized.args.rootId,
          pathRefs: authorized.pathRefs,
          operationArgs: authorized.args,
          execute: () => executeTool(fnName, fnArgs, toolContext),
        });
        result = editRecord.result;
      } catch (error) {
        log(taskId, "warn", "api-engine", `EDIT receipt execution rejected ${fnName}: ${error?.code || error?.message || error}`);
        return JSON.stringify({
          status: "BLOCKED",
          code: String(error?.code || "WORKFLOW_V2_RECEIPT_EDIT_FAILED"),
          message: String(error?.message || "Gateway EDIT receipt failed"),
        });
      }
    } else {
      result = await executeTool(fnName, fnArgs, toolContext);
    }
    const serialized = typeof result === "string" ? result : JSON.stringify(result);
    // M6: 系统侧材料读取回执——read_file 命中冻结 evidence blob 且哈希一致时，
    // 由 Gateway 追加 READ/PASS receipt（模型无法自行声称已读）。回执 ID 附加
    // 到工具结果，让模型能在 structured result 中引用真实回执。失败不影响本轮。
    let receiptAnnotation = "";
    if (stageToolPolicy && WORKFLOW_V2_MATERIAL_TOOLS.has(fnName)) {
      try {
        const materialRecord = await recordWorkflowV2MaterialToolEvidence({
          toolName: fnName,
          result,
          authorizedArgs: authorized?.args || {},
          executedArgs: fnArgs || {},
          recorder: localTarget.stageReceiptRecorder,
          cwd: toolContext.cwd,
          generatedRoot: toolContext.tempRoot,
        });
        if (materialRecord.successful && materialRecord.receiptIds.length) {
          receiptAnnotation = `\n[evidence-receipts: ${materialRecord.receiptIds.join(", ")}]`;
        }
      } catch (receiptError) {
        log(taskId, "warn", "api-engine", `material receipt production failed ${fnName}: ${receiptError?.code || receiptError?.message || receiptError}`);
        return JSON.stringify({
          status: "BLOCKED",
          code: String(receiptError?.code || "WORKFLOW_V2_MATERIAL_RECEIPT_FAILED"),
          message: String(receiptError?.message || "Gateway material receipt production failed"),
        });
      }
    }
    if (editRecord?.receipts?.length) {
      const receiptIds = editRecord.receipts
        .map((envelope) => envelope?.payload?.receiptId)
        .filter(Boolean);
      if (receiptIds.length) receiptAnnotation = `\n[evidence-receipts: ${receiptIds.join(", ")}]`;
    }
    if (stageToolPolicy && fnName === "read_file" && localTarget.stageReceiptRecorder?.recordRead) {
      try {
        const receiptPath = typeof fnArgs?.path === "string" ? fnArgs.path : "";
        if (receiptPath) {
          const recorded = await localTarget.stageReceiptRecorder.recordRead({ absolutePath: receiptPath, toolName: fnName });
          const receiptId = recorded?.envelope?.payload?.receiptId;
          if (receiptId) receiptAnnotation = `\n[evidence-receipt: ${receiptId}]`;
        }
      } catch (receiptError) {
        log(taskId, "warn", "api-engine", `证据读取回执追加失败: ${receiptError?.message || receiptError}`);
      }
    }
    const output = stageToolPolicy ? sanitizeWorkflowV2StageToolResult(stageToolPolicy, serialized) : serialized;
    return receiptAnnotation ? `${output}${receiptAnnotation}` : output;
  };

  const execOne = async (fnName, fnArgs) => {
    const result = await execOneRaw(fnName, fnArgs);
    if (meaningfulProgressObserver) {
      try {
        meaningfulProgressObserver({
          source: "api_tool_result",
          fingerprint: `${fnName}:${JSON.stringify(fnArgs || {}).slice(0, 900)}:${String(result).slice(0, 900)}`,
          tool: fnName,
        });
      } catch {}
    }
    return result;
  };

  if (remote) log(taskId, "info", "api-engine", `分布式：工具在远端 ${remote.host} 的工程 ${remote.root} 内执行`);
  log(taskId, "info", "api-engine", `调用 ${cfg.name} (${cfg.model})${cfg.thinkingEnabled ? " · 思考模式" : ""} · 迭代上限 ${maxIter}`);

  // 用 finally 在每个终止点（成功/异常/用户中止）补一条 chat_stream_end，让前端 LiveBubble 提前进入收尾态。
  // 与 CLI 路径在 terminalAfterClose 中广播 chat_stream_end 对齐；否则 UI 必须等 devbench 后续的 chat_message
  // 才会清掉 liveMap，期间会显示一个"无流"气泡。
  let streamEnded = false;
  const signalStreamEnd = (success, usage) => {
    if (streamEnded || !sessionId) return;
    streamEnded = true;
    try {
      broadcastChatStreamEnd({
        taskId,
        sessionId,
        engine,
        success: success !== false,
        usage: usage || null,
        aiSnapshot,
      });
    } catch {}
  };

  try {

  // API 引擎（如方舟 glm-5.2[1m]）在工具轮可能只产出 tool_calls 增量而无 content/reasoning，
  // readApiTextStream 不会把 tool_calls 增量推给 UI，导致前端 liveMap[sessionId] 一直为空、
  // LiveBubble 不显示。这里先发一个 status 片段，让对话框立即出现并标记“运行中”。
  emit({ taskId, sessionId, engine, chunk: `${cfg.name || engine} 正在生成…`, deltaType: "status" });

  const messages = [
    { role: "system", content: systemPrompt },
    { role: "user", content: prompt },
  ];
  const transcript = [];
  const operations = [];
  const TRANSCRIPT_BLOCK_MAX = 4096;
  const pushTranscript = (type, content, extra = {}) => {
    if (!content) return;
    const value = String(content);
    transcript.push({ type, content: value.length > TRANSCRIPT_BLOCK_MAX ? `${value.slice(0, TRANSCRIPT_BLOCK_MAX)}...(已截断)` : value, ts: Date.now(), ...extra });
  };
  // 流式路径下 reasoning_content 通过 readApiTextStream 的 onChunk("thinking") 实时 emit，
  // 主循环在每轮结束时把累积值 pushTranscript + assistantMessage.reasoning_content 带回 messages。

  let lastPlainText = "";
  let requestedTextFinalization = false;
  let toolCallCount = 0;
  let budgetWarningSent = false;

  for (let iter = 0; iter < maxIter; iter++) {
    if (localTarget.signal?.aborted) {
      const reason = localTarget.signal.reason;
      const error = reason instanceof Error ? reason : new Error(String(reason || "用户手动终止"));
      if (!(reason instanceof Error)) error.userStopped = true;
      error.terminalFailure = true;
      error.transcript = transcript;
      throw error;
    }
    if (maxIter != null && !budgetWarningSent && iter >= Math.max(1, maxIter - 8)) {
      const changed = operations.some((operation) => MUTATING_TOOL_NAMES.has(operation.name));
      messages.push({
        role: "system",
        content: structuredMode
          ? "Agent 轮次即将用完。立即停止扩展调查，依据已有证据单独调用 finish_stage 提交结构化结果。"
          : changed
            ? "Agent 轮次即将用完。立即停止扩展调查，检查 git diff，完成必要验证并调用 finish_task。"
            : "Agent 轮次即将用完。你尚未修改文件：停止重复搜索，依据现有证据立即实施最小变更，然后验证并调用 finish_task。",
      });
      budgetWarningSent = true;
    }
    const finalizationOnly = requestedTextFinalization;
    // 每轮与 AI 通信前补一个 status：thinking/text/tool_use 流入后会自动清空 status，
    // 但纯 tool_calls 轮（无 content/reasoning）能让用户看到“还在工作”的反馈，
    // 避免 LiveBubble 在多轮工具调用期间长时间空白。
    emit({ taskId, sessionId, engine, chunk: finalizationOnly ? "正在整理最终答复…" : "正在思考…", deltaType: "status" });
    const body = {
      model: cfg.model,
      messages,
      ...(!finalizationOnly ? {
        tools: toolDefinitions,
        tool_choice: "auto",
      } : {}),
      // 真流式：让上游逐 chunk 推送 reasoning_content/content/tool_calls，
      // 前端 LiveBubble 才能实时渲染思考/文本/工具调用进度。
      // 与 callApiEngineText 行为一致；极少数上游不识别 stream_options,
      // 下方 fetch 阶段会去字段重试一次。
      stream: true,
      stream_options: { include_usage: true },
      ...reasoningRequest(engine, cfg),
    };
    let response;
    let attemptBody = body;
    let requestEntry = null;
    let providerWatchdog = null;
    let transportRetries = 0;
    let compatibilityRetried = false;
    try {
      // 最多允许一次“响应前传输失败”重试和一次 stream_options 兼容重试。
      // 一旦 fetch 已返回响应并进入流读取，绝不自动重放，避免重复工具副作用。
      for (let attempt = 0; attempt < 3; attempt++) {
        providerWatchdog?.dispose();
        providerWatchdog = createProviderStreamWatchdog(localTarget.signal, {
          firstChunkTimeoutMs,
          streamIdleTimeoutMs,
        });
        requestEntry = recordRequestAttempt(telemetry, {
          requestIndex: iter + 1,
          transportAttempt: attempt + 1,
          body: attemptBody,
          finalizationOnly,
        });
        response = null;
        try {
          response = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${cfg.apiKey}` },
            body: JSON.stringify(attemptBody),
            signal: providerWatchdog.signal,
          });
        } catch (error) {
          const failure = providerWatchdog.timeoutError() || error;
          const mayRetryTransport = !localTarget.signal?.aborted
            && transportRetries < 1
            && isRetryableProviderTransportError(failure);
          if (!mayRetryTransport) throw providerTransportFailure(failure, cfg.name);

          const transportCode = providerTransportCode(failure);
          const retryReason = providerTransportRetryReason(failure);
          recordRequestFailure(requestEntry, "retryable_transport_error");
          telemetry.transportRetryReasons ||= [];
          if (!telemetry.transportRetryReasons.includes(retryReason)) {
            telemetry.transportRetryReasons.push(retryReason);
          }
          transportRetries += 1;
          log(taskId, "warn", "api-engine", `${cfg.name} Provider 连接中断（${transportCode}），正在执行 1/1 次安全重试`);
          emit({
            taskId,
            sessionId,
            engine,
            chunk: `${cfg.name} 连接中断，正在重试（1/1）…`,
            deltaType: "status",
          });
          providerWatchdog.dispose();
          providerWatchdog = null;
          await waitForProviderTransportRetry(localTarget.signal);
          continue;
        }
        if (response.ok && response.body) break;
        const errorText = await response.text().catch(() => "");
        const mayRetry = !compatibilityRetried
          && /stream_options|include_usage|unsupported|unknown parameter|extra fields/i.test(errorText);
        if (!mayRetry) {
          recordRequestFailure(requestEntry, `http_${response.status || 0}`);
          const error = new Error(`${cfg.name} API 错误 ${response.status}: ${errorText.slice(0, 500)}`);
          error.transcript = transcript;
          throw error;
        }
        recordRequestFailure(requestEntry, "retryable_http_error");
        telemetry.transportRetryReasons ||= [];
        if (!telemetry.transportRetryReasons.includes("unsupported_stream_options")) {
          telemetry.transportRetryReasons.push("unsupported_stream_options");
        }
        compatibilityRetried = true;
        // 第二次去掉 stream_options 字段再试
        const next = { ...attemptBody };
        delete next.stream_options;
        attemptBody = next;
      }
    } catch (error) {
      const failure = providerWatchdog?.timeoutError() || error;
      providerWatchdog?.dispose();
      if (requestEntry?.outcome === "pending") recordRequestFailure(requestEntry, "transport_error");
      failure.transcript = transcript;
      if (localTarget.signal?.aborted) {
        failure.userStopped = true;
        failure.terminalFailure = true;
      }
      throw failure;
    }
    if (!response?.ok || !response.body) {
      providerWatchdog?.dispose();
      if (requestEntry?.outcome === "pending") recordRequestFailure(requestEntry, "unreadable_response");
      const error = new Error(`${cfg.name} API 错误 ${response?.status || 0}: 响应不可读`);
      error.transcript = transcript;
      throw error;
    }

    // 流式读取：thinking/text 实时 emit；usage 实时 emit；tool_calls 累积结束后由返回结果带回。
    // 与原 recordReasoning(message) 等价：onChunk 累积出完整 reasoning_content 后
    // 通过 pushTranscript + assistantMessage.reasoning_content 带回 messages。
    let accumulatedReasoning = "";
    let streamResult;
    let streamedUsage = null;
    try {
      streamResult = await readApiTextStream(response, {
        signal: providerWatchdog.signal,
        onActivity: () => providerWatchdog.markActivity(),
        onChunk: (chunk, deltaType) => {
          if (deltaType === "thinking" && !structuredMode) accumulatedReasoning += chunk;
          // 文本兼容收口输出的是内部 JSON，解析完成前不能把它当成最终正文推给 UI。
          if (!finalizationOnly && !(structuredMode && ["text", "thinking"].includes(deltaType))) {
            emit({ taskId, sessionId, engine, chunk, deltaType });
          }
        },
        onUsage: (usage) => {
          streamedUsage = usage;
          emit({ taskId, sessionId, engine, deltaType: "usage", usage });
        },
      });
    } catch (error) {
      const failure = providerWatchdog?.timeoutError() || error;
      // 流阶段中止 / 网络断开：保留 transcript 与已发出的增量，把异常标为终态失败
      if (streamedUsage) {
        recordProviderResponse(telemetry, requestEntry, { usage: streamedUsage });
        recordRequestFailure(requestEntry, "stream_error_after_usage");
      } else {
        recordRequestFailure(requestEntry, "stream_error");
      }
      failure.transcript = transcript;
      if (localTarget.signal?.aborted) {
        failure.userStopped = true;
        failure.terminalFailure = true;
      } else {
        failure.terminalFailure = true;
      }
      throw failure;
    } finally {
      providerWatchdog?.dispose();
    }
    if (!streamResult || (typeof streamResult.text !== "string" && !(streamResult.toolCalls || []).length)) {
      recordRequestFailure(requestEntry, "empty_response");
      const error = new Error(`${cfg.name} API 返回为空`);
      error.transcript = transcript;
      throw error;
    }

    const completeToolCalls = Array.isArray(streamResult.toolCalls) ? streamResult.toolCalls : [];
    const rawStructuredToolCalls = structuredMode
      && ["tool_calls", "stop"].includes(streamResult.finishReason)
      && Array.isArray(streamResult.rawToolCalls)
      ? streamResult.rawToolCalls
      : completeToolCalls;
    const toolCalls = structuredMode ? rawStructuredToolCalls : completeToolCalls;
    recordProviderResponse(telemetry, requestEntry, { usage: streamResult.usage, toolCalls });
    if (accumulatedReasoning) pushTranscript("thinking", accumulatedReasoning);

    if (structuredMode) {
      const text = String(streamResult.text || "").trim();
      // Provider 适配：deepseek 等工具调用轮会伴随说明文本。只要本轮存在
      // 工具调用，文本即视为思考说明（不回传为结果）；只有“纯文本且无
      // finish_stage/工具调用”才拒绝（防把自由文本冒充阶段结果）。
      if (text && (toolCalls?.length ?? 0) === 0) {
        throw workflowV2StructuredError(
          "WORKFLOW_V2_STRUCTURED_TEXT_NOT_ALLOWED",
          "structured Provider 返回了普通文本，已拒绝当作阶段结果",
          transcript,
        );
      }
      const terminalCalls = toolCalls.filter((call) => call.function?.name === "finish_stage");
      if (terminalCalls.length > 1) {
        throw workflowV2StructuredError(
          "WORKFLOW_V2_STRUCTURED_TERMINAL_DUPLICATE",
          "finish_stage 在同一 Provider 响应中重复调用",
          transcript,
        );
      }
      if (toolCalls.length === 0) {
        throw workflowV2StructuredError(
          "WORKFLOW_V2_STRUCTURED_TERMINAL_MISSING",
          "structured Provider 未调用 finish_stage",
          transcript,
        );
      }

      if (terminalCalls.length === 1) {
        // Provider 适配：deepseek 等会在同一响应里把 finish_stage 与非终态工具
        // 一起返回。终态已提交，其余调用不再执行、也不进入消息序列（避免
        // 未配对 tool_call_id 破坏下一轮消息），只记录到 transcript 与日志。
        const call = terminalCalls[0];
        if (toolCalls.length > 1) {
          const dropped = toolCalls
            .filter((candidate) => candidate !== call)
            .map((candidate) => String(candidate.function?.name || "unknown"))
            .filter(Boolean);
          pushTranscript("tool_use", `finish_stage 已忽略同轮非终态调用: ${dropped.join(", ")}`);
          log(taskId, "warn", "api-engine", `finish_stage 与 ${dropped.join(", ")} 同轮返回，已忽略非终态调用`);
        }
        if (!String(call.id || "").trim() || !String(call.function?.name || "").trim()) {
          throw workflowV2StructuredError(
            "WORKFLOW_V2_STRUCTURED_TOOL_CALL_INVALID",
            "structured Provider 返回了不完整的工具调用 envelope",
            transcript,
          );
        }
        toolCallCount++;
        log(taskId, "info", "tool_use", `调用工具: finish_stage`);
        emit({ taskId, sessionId, engine, chunk: "finish_stage", deltaType: "tool_use" });
        // 终态参数只在本地严格解析：不进 transcript、messages 或 UI stream。
        let resultObject;
        try {
          resultObject = JSON.parse(String(call.function?.arguments || ""));
        } catch {
          throw workflowV2StructuredError(
            "WORKFLOW_V2_STRUCTURED_ARGUMENTS_INVALID",
            "finish_stage arguments 不是合法 JSON object",
            transcript,
          );
        }
        if (!resultObject || typeof resultObject !== "object" || Array.isArray(resultObject)) {
          throw workflowV2StructuredError(
            "WORKFLOW_V2_STRUCTURED_ARGUMENTS_INVALID",
            "finish_stage arguments 必须是 JSON object",
            transcript,
          );
        }
        pushTranscript("tool_use", "finish_stage");
        try { meaningfulProgressObserver?.({ source: "finish_stage", fingerprint: `finish_stage:${call.id}` }); } catch {}
        log(taskId, "info", "api-engine", `${cfg.name} 已接收结构化阶段结果 (${toolCallCount} 次工具调用)`);
        return structuredSuccessResult(
          resultObject,
          structuredOutput.schemaId,
          transcript,
          telemetry,
        );
      }

      // 无终态调用：允许同一轮多个非终态工具按序执行（与 legacy 多工具循环
      // 一致）；finish_stage 必须单独成轮，出现时由上面的分支接管。
      // 伴随文本回传为 assistant content（deepseek 工具轮会输出说明）。
      toolCallCount += toolCalls.length;
      const assistantMessage = { role: "assistant", content: text, tool_calls: toolCalls };
      if (accumulatedReasoning) assistantMessage.reasoning_content = accumulatedReasoning;
      messages.push(assistantMessage);
      for (const call of toolCalls) {
        const fnName = call.function?.name || "unknown";
        if (!String(call.id || "").trim() || !String(call.function?.name || "").trim()) {
          throw workflowV2StructuredError(
            "WORKFLOW_V2_STRUCTURED_TOOL_CALL_INVALID",
            "structured Provider 返回了不完整的工具调用 envelope",
            transcript,
          );
        }
        if (fnName === "finish_task") {
          throw workflowV2StructuredError(
            "WORKFLOW_V2_STRUCTURED_TERMINAL_INVALID",
            "structured Provider 不得调用 finish_task",
            transcript,
          );
        }
        if (fnName === "finish_stage") {
          throw workflowV2StructuredError(
            "WORKFLOW_V2_STRUCTURED_TERMINAL_DUPLICATE",
            "finish_stage 必须单独成轮",
            transcript,
          );
        }
        log(taskId, "info", "tool_use", `调用工具: ${fnName}`);
        emit({ taskId, sessionId, engine, chunk: fnName, deltaType: "tool_use" });
        let fnArgs = {};
        try { fnArgs = JSON.parse(call.function?.arguments || "{}"); } catch {}
        pushTranscript("tool_use", fnName, { input: JSON.stringify(fnArgs).slice(0, 512) });
        const toolResult = await execOne(fnName, fnArgs);
        recordToolResultChars(telemetry, toolResult);
        operations.push({ name: fnName, args: fnArgs, result: toolResult });
        const failed = /^(?:错误|工具执行异常|搜索失败):/.test(String(toolResult))
          || /exit_code:\s*(?!0\b)\S+/i.test(String(toolResult));
        if (failed) {
          pushTranscript("tool_result", String(toolResult), { tool: fnName });
          log(taskId, "warn", "tool_result", `${fnName} 失败: ${String(toolResult).slice(0, 500)}`);
        }
        messages.push({ role: "tool", tool_call_id: call.id, content: String(toolResult) });
      }
      continue;
    }

    if (toolCalls.length && !finalizationOnly) {
      const assistantMessage = { role: "assistant", content: streamResult.text || "", tool_calls: toolCalls };
      // DeepSeek thinking-mode tool calls require reasoning_content to be sent
      // back unchanged on the next request.
      if (accumulatedReasoning) assistantMessage.reasoning_content = accumulatedReasoning;
      messages.push(assistantMessage);

      const finishCall = toolCalls.find((call) => call.function?.name === "finish_task");
      if (finishCall && toolCalls.length === 1) {
        let finishArgs = {};
        try { finishArgs = JSON.parse(finishCall.function?.arguments || "{}"); } catch {}
        toolCallCount++;
        pushTranscript("tool_use", "finish_task", { input: JSON.stringify(finishArgs).slice(0, 512) });
        const report = formatCompletionReport(finishArgs, operations);
        pushTranscript("text", report);
        try { meaningfulProgressObserver?.({ source: "finish_task", fingerprint: `finish_task:${finishCall.id}` }); } catch {}
        for (let offset = 0; offset < report.length; offset += 60) {
          emit({ taskId, sessionId, engine, chunk: report.slice(offset, offset + 60), deltaType: "text" });
        }
        log(taskId, "info", "api-engine", `${cfg.name} 完成 (${toolCallCount} 次工具调用)`);
        return successResult(report, transcript, telemetry);
      }

      for (const call of toolCalls) {
        const fnName = call.function?.name || "unknown";
        let fnArgs = {};
        try { fnArgs = JSON.parse(call.function?.arguments || "{}"); } catch {}
        toolCallCount++;
        log(taskId, "info", "tool_use", `调用工具: ${fnName}`);
        emit({ taskId, sessionId, engine, chunk: fnName, deltaType: "tool_use" });
        pushTranscript("tool_use", fnName, { input: JSON.stringify(fnArgs).slice(0, 512) });
        let toolResult;
        if (fnName === "finish_task") {
          toolResult = "finish_task 必须在其他工具全部完成后单独调用";
          recordToolResultChars(telemetry, toolResult);
        } else {
          toolResult = await execOne(fnName, fnArgs);
          recordToolResultChars(telemetry, toolResult);
          operations.push({ name: fnName, args: fnArgs, result: toolResult });
          const failed = /^(?:错误|工具执行异常|搜索失败):/.test(String(toolResult))
            || /exit_code:\s*(?!0\b)\S+/i.test(String(toolResult));
          if (failed) {
            pushTranscript("tool_result", String(toolResult), { tool: fnName });
            log(taskId, "warn", "tool_result", `${fnName} 失败: ${String(toolResult).slice(0, 500)}`);
          }
        }
        messages.push({ role: "tool", tool_call_id: call.id, content: String(toolResult) });
      }
      continue;
    }

    const text = String(streamResult.text || "").trim();
    lastPlainText = text || lastPlainText;
    if (finalizationOnly) {
      const completion = parseTextCompletionPayload(text);
      if (completion) {
        const report = formatCompletionReport(completion, operations);
        pushTranscript("text", report);
        for (let offset = 0; offset < report.length; offset += 60) {
          emit({ taskId, sessionId, engine, chunk: report.slice(offset, offset + 60), deltaType: "text" });
        }
        log(taskId, "info", "api-engine", `${cfg.name} 通过文本兼容收口完成 (${toolCallCount} 次工具调用)`);
        return successResult(report, transcript, telemetry);
      }
      // 收口轮兜底：glm-5.2[1m] 等模型在收口轮仍返回 Markdown/纯文本而非 JSON。
      // 把模型文本作为最终答复，从已执行操作推断变更与验证，避免工作成果丢失。
      if (text) {
        const report = formatCompletionReport({
          status: "partial",
          summary: "模型以文本答复结束，未提交结构化完成状态",
          changes: [],
          verification: [],
          remaining: [],
          final_response: text,
        }, operations);
        pushTranscript("text", report);
        for (let offset = 0; offset < report.length; offset += 60) {
          emit({ taskId, sessionId, engine, chunk: report.slice(offset, offset + 60), deltaType: "text" });
        }
        log(taskId, "warn", "api-engine", `${cfg.name} 收口轮返回非 JSON 文本，已作为最终答复兜底 (${toolCallCount} 次工具调用)`);
        return successResult(report, transcript, telemetry);
      }
    }
    // glm-5.2[1m] 等模型在多轮工具调用后常以纯文本结束，不调用 finish_task。
    // 直接把文本作为最终答复，从已执行操作推断变更/验证，不强制 JSON 收口 ——
    // 否则模型在收口轮仍返回 Markdown 而非 JSON，导致工作成果丢失、显示"部分完成"模板。
    // 文本已在工具轮流式推给 UI，这里不重复 emit，仅 return 让 onTurnSuccess 发 chat_message。
    if (!finalizationOnly && text && operations.length > 0) {
      const report = formatCompletionReport({
        status: "partial",
        summary: "模型以文本答复结束本轮任务",
        changes: [],
        verification: [],
        remaining: [],
        final_response: text,
      }, operations);
      pushTranscript("text", report);
      log(taskId, "info", "api-engine", `${cfg.name} 以纯文本结束 (${toolCallCount} 次工具调用)`);
      return successResult(report, transcript, telemetry);
    }
    // 部分 OpenAI 兼容模型（例如方舟 glm-5.2[1m]）会在工具轮完成后忽略
    // finish_task/tool_choice，以 reasoning 或普通文本结束。再发一个不带 tools 的
    // 结构化收口轮，避免把协议差异误报成“需要人工确认”。
    if (!requestedTextFinalization && iter < maxIter - 1) {
      const assistantMessage = { role: "assistant", content: streamResult.text || "" };
      if (accumulatedReasoning) assistantMessage.reasoning_content = accumulatedReasoning;
      messages.push(assistantMessage, {
        role: "system",
        content: TEXT_FINALIZATION_SYSTEM_PROMPT,
      }, {
        role: "user",
        content: "现在执行兼容性收口，只提交上述 JSON 终态。",
      });
      requestedTextFinalization = true;
      continue;
    }

    // 最终兜底：把模型最近的纯文本作为最终答复，避免显示"无文件变更"通用模板。
    const fallbackText = text || lastPlainText || "";
    const report = formatCompletionReport({
      status: "partial",
      summary: fallbackText ? "模型以文本答复结束，未提交结构化完成状态" : "模型结束了响应，但没有提交结构化完成状态。",
      changes: [],
      verification: [],
      remaining: fallbackText ? [] : ["模型既未调用 finish_task，也未返回可解析的文本终态，需要检查模型响应协议"],
      final_response: fallbackText,
    }, operations);
    pushTranscript("text", report);
    emit({ taskId, sessionId, engine, chunk: report, deltaType: "text" });
    return successResult(report, transcript, telemetry);
  }

  // 单次执行片段到达有限上限后生成可恢复的 partial 检查点；故事点本身不失效。
  if (structuredMode) {
    throw workflowV2StructuredError(
      "WORKFLOW_V2_STRUCTURED_TERMINAL_MISSING",
      `structured Provider 达到最大 Agent 迭代次数 (${maxIter}) 仍未调用 finish_stage`,
      transcript,
    );
  }
  const report = formatCompletionReport({
    status: "partial",
    summary: lastPlainText || `本执行片段达到最大 Agent 迭代次数 (${maxIter})，已保存当前结果。`,
    changes: [],
    verification: [],
    remaining: [`故事点本身没有过期；请检查已保存结果，并从检查点开启下一执行片段继续`],
  }, operations);
  pushTranscript("text", report);
  try { meaningfulProgressObserver?.({ source: "iteration_checkpoint", fingerprint: `iteration_checkpoint:${maxIter}` }); } catch {}
  emit({ taskId, sessionId, engine, chunk: report, deltaType: "text" });
  log(taskId, "warn", "api-engine", `${cfg.name} 达到最大 Agent 迭代次数 (${maxIter})`);
  return successResult(report, transcript, telemetry);
  } catch (error) {
    error.telemetry = completeAgentTurnTelemetry(telemetry);
    error.telemetry.executionSucceeded = false;
    if (!error.usage && error.telemetry.usage?.source === "provider") {
      error.usage = { ...error.telemetry.usage };
    }
    signalStreamEnd(false, error.telemetry.usage?.source === "provider" ? error.telemetry.usage : null);
    throw error;
  } finally {
    // 无论成功、抛错还是用户中止，都补一条 chat_stream_end，让前端 streaming:false 早于 chat_message 翻转。
    // 抛出/正常返回都被外层 try/finally 捕获。
    const observed = completeAgentTurnTelemetry(telemetry);
    signalStreamEnd(true, observed.usage?.source === "provider" ? observed.usage : null);
  }
}

/** Simple non-agent call used by planning/review features. */
export async function callApiEngine(engine, prompt) {
  const apiEngines = getConfigValue("apiEngines") || {};
  const cfg = normalizedEngineConfig(apiEngines[engine]);
  if (!cfg?.enabled || !cfg?.apiKey) throw new Error(`API 引擎 ${engine} 不可用`);

  let response;
  try {
    response = await fetch(`${cfg.baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${cfg.apiKey}` },
      body: JSON.stringify({
        model: cfg.model,
        messages: [{ role: "user", content: prompt }],
        stream: false,
        ...reasoningRequest(engine, cfg),
      }),
      signal: AbortSignal.timeout(SIMPLE_CALL_TIMEOUT_MS),
    });
    if (!response.ok) {
      const errorText = await response.text().catch(() => "");
      throw new Error(`${cfg.name || engine} API ${response.status}: ${errorText.slice(0, 300)}`);
    }
    const result = await response.json();
    return result.choices?.[0]?.message?.content || "";
  } catch (err) {
    if (err?.name === "TimeoutError" || err?.name === "AbortError") {
      throw new Error(`${cfg.name || engine} API 响应超时（${Math.floor(SIMPLE_CALL_TIMEOUT_MS / 1000)} 秒），已终止该调用`);
    }
    throw err;
  }
}

function textFromDelta(value) {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value.map((item) => {
    if (typeof item === "string") return item;
    return typeof item?.text === "string" ? item.text : "";
  }).join("");
}

function isCompleteStreamToolCall(call) {
  if (!String(call?.id || "").trim() || !String(call?.function?.name || "").trim()) return false;
  const rawArguments = call?.function?.arguments;
  if (typeof rawArguments !== "string" || !rawArguments.trim()) return false;
  try {
    const parsed = JSON.parse(rawArguments);
    return !!parsed && typeof parsed === "object" && !Array.isArray(parsed);
  } catch {
    return false;
  }
}

/**
 * 读取 OpenAI 兼容的 SSE 文本流。content 计入最终正文，reasoning_content
 * 只通过 onChunk(..., "thinking") 下发，避免把思考过程混进报告。
 *
 * 可选回调：
 * - onToolCalls(completeToolCallsArray): 流内累积到完整 tool_calls，以 tool_calls 或
 *   stop 安全收尾，且每个调用参数都是完整 JSON 时触发。参数按 index 排序，包含 id/name，
 *   function.arguments 是拼接后的完整 JSON 字符串，供调用方 JSON.parse。
 * - onUsage(usage): 在收到 usage 块时触发，便于调用方做实时 token 统计。
 *
 * 返回值兼容标准 tool_calls 与方舟 stop 两种收尾；截断、过滤、未知结束原因均不执行。
 */
export async function readApiTextStream(response, { onChunk, onToolCalls, onUsage, onActivity, signal } = {}) {
  if (!response?.body) throw new Error("AI API 未返回响应流");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let text = "";
  let usage = null;
  let finishReason = "";
  // 按 index 累积的 tool_calls 增量（OpenAI 标准流式协议：每条 delta 只携带单字段增量，
  // 同 index 的 arguments 用字符串 += 拼接，结束时上游会发出闭合 "}" 形成合法 JSON）
  const toolCallsAccumulator = new Map();

  const abortError = () => (signal?.reason instanceof Error
    ? signal.reason
    : new Error("AI API 响应流已中止"));
  const readNext = async () => {
    if (!signal) return reader.read();
    if (signal.aborted) throw abortError();
    let onAbort = null;
    try {
      return await Promise.race([
        reader.read(),
        new Promise((_, reject) => {
          onAbort = () => {
            try { Promise.resolve(reader.cancel(signal.reason)).catch(() => {}); } catch {}
            reject(abortError());
          };
          signal.addEventListener("abort", onAbort, { once: true });
        }),
      ]);
    } finally {
      if (onAbort) signal.removeEventListener("abort", onAbort);
    }
  };

  // 兜底：部分思考型模型（如 MiniMax-M3 在 reasoning_split 未生效、或经代理剥离
  // extra_body 时）会把思考内联在 content 的 <think>...</think> 标签里，导致思考流
  // 混进正文。用状态机跨 chunk 解析：标签内文本改路由到 thinking，标签外才是正文。
  // 仅当本流从未收到 reasoning_content 字段时启用（reasoning_split 生效则 content 无标签，解析器是 no-op）。
  const THINK_OPEN = "<think>";
  const THINK_CLOSE = "</think>";
  let gotReasoningField = false;
  let inThink = false;
  let thinkLeftover = "";
  const overlappingPrefix = (s, tag) => {
    const max = Math.min(s.length, tag.length - 1);
    for (let n = max; n > 0; n--) if (s.slice(s.length - n) === tag.slice(0, n)) return n;
    return 0;
  };
  const emitText = (t) => { if (t) { text += t; try { onChunk?.(t, "text"); } catch {} } };
  const emitThink = (t) => { if (t) try { onChunk?.(t, "thinking"); } catch {} };
  const processContent = (raw) => {
    // reasoning_split 生效（已收到 reasoning_content 字段）时 content 不含 ilda 标签，
    // 且正文里若出现 ilda 字面量会被误判，故此时直接走 emitText，不进标签解析器。
    if (gotReasoningField) { emitText(raw); return; }
    let buf = thinkLeftover + raw;
    thinkLeftover = "";
    while (buf) {
      if (!inThink) {
        const idx = buf.indexOf(THINK_OPEN);
        if (idx === -1) {
          const pl = overlappingPrefix(buf, THINK_OPEN);
          if (pl > 0) { emitText(buf.slice(0, buf.length - pl)); thinkLeftover = buf.slice(buf.length - pl); }
          else emitText(buf);
          break;
        }
        emitText(buf.slice(0, idx));
        buf = buf.slice(idx + THINK_OPEN.length);
        inThink = true;
      } else {
        const idx = buf.indexOf(THINK_CLOSE);
        if (idx === -1) {
          const pl = overlappingPrefix(buf, THINK_CLOSE);
          if (pl > 0) { emitThink(buf.slice(0, buf.length - pl)); thinkLeftover = buf.slice(buf.length - pl); }
          else emitThink(buf);
          break;
        }
        emitThink(buf.slice(0, idx));
        buf = buf.slice(idx + THINK_CLOSE.length);
        inThink = false;
      }
    }
  };

  const consumeLine = (line) => {
    const value = String(line || "").trim();
    if (!value.startsWith("data:")) return;
    const payload = value.slice(5).trim();
    if (!payload || payload === "[DONE]") return;
    let event;
    try { event = JSON.parse(payload); } catch { return; }
    const delta = event.choices?.[0]?.delta || {};
    if (event.choices?.[0]?.finish_reason) finishReason = String(event.choices[0].finish_reason);
    const reasoning = textFromDelta(delta.reasoning_content);
    const content = textFromDelta(delta.content);
    if (reasoning) {
      gotReasoningField = true;
      try { onChunk?.(reasoning, "thinking"); } catch {}
    }
    if (content) {
      // reasoning_split 生效时 content 不含 <think> 标签，processContent 直接走 emitText 分支（no-op 解析）。
      processContent(content);
    }
    // 工具调用增量累积（仅在工具调用流式协议下出现；空数组时跳过）
    const partialCalls = Array.isArray(delta.tool_calls) ? delta.tool_calls : [];
    for (const partial of partialCalls) {
      if (!partial || typeof partial !== "object") continue;
      const idx = partial.index;
      if (idx == null) continue;
      const cur = toolCallsAccumulator.get(idx) || {
        id: "",
        type: "function",
        function: { name: "", arguments: "" },
      };
      if (partial.id) cur.id = partial.id;
      if (partial.type) cur.type = partial.type;
      if (partial.function?.name) cur.function.name = partial.function.name;
      if (typeof partial.function?.arguments === "string") {
        cur.function.arguments += partial.function.arguments;
      }
      toolCallsAccumulator.set(idx, cur);
    }
    if (event.usage) {
      usage = {
        inputTokens: event.usage.prompt_tokens || event.usage.input_tokens || 0,
        outputTokens: event.usage.completion_tokens || event.usage.output_tokens || 0,
        cacheReadTokens: event.usage.prompt_cache_hit_tokens || event.usage.cache_read_input_tokens || 0,
        cacheCreationTokens: event.usage.cache_creation_input_tokens || 0,
        costUsd: null,
      };
      try { onUsage?.(usage); } catch {}
    }
  };

  for (;;) {
    const { value, done } = await readNext();
    if (done) break;
    try { onActivity?.(); } catch {}
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() || "";
    for (const line of lines) consumeLine(line);
  }
  buffer += decoder.decode();
  if (buffer.trim()) consumeLine(buffer);
  // 流结束：冲刷标签解析器残留（未闭合 ilda 的尾部，或末尾的标签前缀）。
  if (thinkLeftover) {
    if (inThink) emitThink(thinkLeftover);
    else emitText(thinkLeftover);
    thinkLeftover = "";
  }

  // 方舟 glm-5.2[1m] 等 OpenAI 兼容模型可能已经流出完整 tool_calls，却用
  // finish_reason:"stop" 收尾。兼容 stop，但仍要求明确的安全收尾原因和完整 JSON；
  // length/content_filter/空值/未知原因或任一畸形调用都不执行，避免部分副作用。
  let toolCalls = [];
  const accumulatedToolCalls = [...toolCallsAccumulator.entries()]
    .sort(([left], [right]) => Number(left) - Number(right))
    .map(([, call]) => call);
  if (["tool_calls", "stop"].includes(finishReason)
    && accumulatedToolCalls.length
    && accumulatedToolCalls.every(isCompleteStreamToolCall)) {
    toolCalls = accumulatedToolCalls;
    try { onToolCalls?.(toolCalls); } catch {}
  }

  return { text, usage, finishReason, toolCalls, rawToolCalls: accumulatedToolCalls };
}

/**
 * 工作总结、规划、评审等纯文本场景使用的单轮流式调用。
 * 不进入 Agent 工具循环；带首字与总时长超时，避免 CLI 无输出长期占用。
 */
export async function callApiEngineText(engine, prompt, {
  system = "",
  onChunk,
  signal,
  firstChunkTimeoutMs = 45000,
  totalTimeoutMs = 120000,
  maxOutputTokens = 0,
  model = "",
  tier = "",
  userContent = null,
  telemetryContext = {},
} = {}) {
  const apiEngines = getConfigValue("apiEngines") || {};
  const cfg = normalizedEngineConfig(apiEngines[engine]);
  if (!cfg?.enabled || !cfg?.apiKey) throw new Error(`API 引擎 ${engine} 不可用`);
  if (String(model || "").trim()) cfg.model = String(model).trim();
  if (String(tier || "").trim()) {
    cfg.reasoningEffort = String(tier).trim();
    cfg.thinkingEnabled = cfg.reasoningEffort.toLowerCase() !== "off";
  }
  if (!cfg.baseUrl || !cfg.model) throw new Error(`API 引擎 ${engine} 缺少 Base URL 或模型`);

  const controller = new AbortController();
  let abortReason = "";
  let firstChunkSeen = false;
  const abort = (reason) => {
    if (controller.signal.aborted) return;
    abortReason = reason;
    controller.abort(new Error(reason));
  };
  const onExternalAbort = () => abort("AI 生成已取消");
  if (signal?.aborted) abort("AI 生成已取消");
  else signal?.addEventListener("abort", onExternalAbort, { once: true });
  const firstTimer = setTimeout(() => abort(`AI 首字超时（${Math.ceil(firstChunkTimeoutMs / 1000)} 秒）`), firstChunkTimeoutMs);
  const totalTimer = setTimeout(() => abort(`AI 生成超时（${Math.ceil(totalTimeoutMs / 1000)} 秒）`), totalTimeoutMs);
  const markChunk = (chunk, deltaType) => {
    if (!firstChunkSeen) {
      firstChunkSeen = true;
      clearTimeout(firstTimer);
    }
    try { onChunk?.(chunk, deltaType); } catch {}
  };
  const url = `${cfg.baseUrl.replace(/\/$/, "")}/chat/completions`;
  const applicationContent = Array.isArray(userContent) && userContent.length
    ? userContent
    : String(prompt);
  let telemetryPrompt;
  if (typeof applicationContent === "string") telemetryPrompt = applicationContent;
  else {
    try { telemetryPrompt = JSON.stringify(applicationContent); }
    catch { telemetryPrompt = String(applicationContent ?? ""); }
  }
  const makeBody = (includeUsage) => ({
    model: cfg.model,
    messages: [
      ...(String(system || "").trim() ? [{ role: "system", content: String(system) }] : []),
      {
        role: "user",
        content: applicationContent,
      },
    ],
    stream: true,
    ...(includeUsage ? { stream_options: { include_usage: true } } : {}),
    ...(Number(maxOutputTokens) > 0 ? { max_tokens: Math.floor(Number(maxOutputTokens)) } : {}),
    ...reasoningRequest(engine, cfg),
  });
  const telemetry = createAgentTurnTelemetry({
    provider: engine,
    model: cfg.model,
    prompt: telemetryPrompt,
    systemPrompt: system,
    storyId: telemetryContext.storyId,
    attemptId: telemetryContext.attemptId,
    workflowKind: telemetryContext.workflowKind,
    stage: telemetryContext.stage,
    contextId: telemetryContext.contextId,
    contextRevision: telemetryContext.contextRevision,
    turnAttempt: telemetryContext.turnAttempt,
    retryReasons: telemetryContext.retryReasons,
    visibility: "openai_compatible_requests",
  });
  let requestEntry = null;

  try {
    let response;
    let transportAttempt = 0;
    for (const includeUsage of [true, false]) {
      transportAttempt += 1;
      const requestBody = makeBody(includeUsage);
      requestEntry = recordRequestAttempt(telemetry, {
        requestIndex: 1,
        transportAttempt,
        body: requestBody,
        finalizationOnly: true,
      });
      response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${cfg.apiKey}` },
        body: JSON.stringify(requestBody),
        signal: controller.signal,
      });
      if (response.ok && response.body) break;
      const errorText = await response.text().catch(() => "");
      const mayRetry = includeUsage && /stream_options|include_usage|unsupported|unknown parameter|extra fields/i.test(errorText);
      if (!mayRetry) {
        recordRequestFailure(requestEntry, `http_${response.status || 0}`);
        throw new Error(`${cfg.name || engine} API ${response.status}: ${errorText.slice(0, 300)}`);
      }
      recordRequestFailure(requestEntry, "retryable_http_error");
      telemetry.transportRetryReasons ||= [];
      if (!telemetry.transportRetryReasons.includes("unsupported_stream_options")) {
        telemetry.transportRetryReasons.push("unsupported_stream_options");
      }
    }
    if (!response?.ok || !response.body) {
      if (requestEntry?.outcome === "pending") recordRequestFailure(requestEntry, "unreadable_response");
      throw new Error(`${cfg.name || engine} API 未返回可读响应`);
    }
    let streamedUsage = null;
    let result;
    try {
      result = await readApiTextStream(response, {
        signal: controller.signal,
        onChunk: markChunk,
        onUsage: (usage) => { streamedUsage = usage; },
      });
    } catch (error) {
      if (streamedUsage) {
        recordProviderResponse(telemetry, requestEntry, { usage: streamedUsage });
        recordRequestFailure(requestEntry, "stream_error_after_usage");
      } else {
        recordRequestFailure(requestEntry, "stream_error");
      }
      throw error;
    }
    recordProviderResponse(telemetry, requestEntry, { usage: result.usage });
    if (!firstChunkSeen && result.text) clearTimeout(firstTimer);
    const completedTelemetry = completeAgentTurnTelemetry(telemetry);
    completedTelemetry.executionSucceeded = true;
    return { ...result, telemetry: completedTelemetry };
  } catch (error) {
    if (requestEntry?.outcome === "pending") recordRequestFailure(requestEntry, "transport_error");
    const completedTelemetry = completeAgentTurnTelemetry(telemetry);
    completedTelemetry.executionSucceeded = false;
    const failure = controller.signal.aborted
      ? new Error(abortReason || "AI 生成已取消")
      : error;
    failure.telemetry = completedTelemetry;
    if (completedTelemetry.usage?.source === "provider") failure.usage = { ...completedTelemetry.usage };
    throw failure;
  } finally {
    clearTimeout(firstTimer);
    clearTimeout(totalTimer);
    signal?.removeEventListener?.("abort", onExternalAbort);
  }
}
