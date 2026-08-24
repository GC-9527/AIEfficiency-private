import { createHash } from "node:crypto";

export const AGENT_TURN_TELEMETRY_VERSION = "agent-turn-telemetry-v2";

const USAGE_FIELDS = [
  "inputTokens",
  "outputTokens",
  "cacheReadTokens",
  "cacheCreationTokens",
];

function nonNegativeInteger(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.floor(number) : 0;
}

function compactStrings(values = []) {
  return [...new Set((Array.isArray(values) ? values : []).map((value) => String(value || "").trim()).filter(Boolean))];
}

export function unicodeCharCount(value) {
  return Array.from(String(value ?? "")).length;
}

export function jsonCharCount(value) {
  if (value == null) return 0;
  try {
    return unicodeCharCount(JSON.stringify(value));
  } catch {
    return 0;
  }
}

export function normalizeProviderUsage(value) {
  if (!value || typeof value !== "object") return null;
  if (value.source && value.source !== "provider") return null;
  const normalized = {};
  let observed = false;
  for (const field of USAGE_FIELDS) {
    const aliases = field === "inputTokens"
      ? ["inputTokens", "prompt_tokens", "input_tokens"]
      : field === "outputTokens"
        ? ["outputTokens", "completion_tokens", "output_tokens"]
        : field === "cacheReadTokens"
          ? ["cacheReadTokens", "prompt_cache_hit_tokens", "cache_read_input_tokens"]
          : ["cacheCreationTokens", "cache_creation_input_tokens"];
    const alias = aliases.find((key) => value[key] != null && Number.isFinite(Number(value[key])));
    normalized[field] = alias ? nonNegativeInteger(value[alias]) : 0;
    if (alias) observed = true;
  }
  normalized.costUsd = value.costUsd != null && Number.isFinite(Number(value.costUsd))
    ? Number(value.costUsd)
    : null;
  return observed ? normalized : null;
}

function emptyUsage() {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    costUsd: null,
    source: "unavailable",
  };
}

export function createAgentTurnTelemetry({
  provider = "",
  model = "",
  prompt = "",
  systemPrompt = null,
  toolDefinitions = null,
  storyId = null,
  attemptId = null,
  workflowKind = "",
  stage = null,
  contextId = null,
  contextRevision = null,
  turnAttempt = 1,
  retryReasons = [],
  visibility = "provider_summary",
} = {}) {
  const promptText = String(prompt || "");
  const normalizedRetryReasons = compactStrings(retryReasons);
  return {
    schemaVersion: AGENT_TURN_TELEMETRY_VERSION,
    provider: String(provider || ""),
    model: String(model || ""),
    storyId: storyId == null ? null : String(storyId),
    attemptId: attemptId == null ? null : String(attemptId),
    workflowKind: String(workflowKind || "") || null,
    stage: stage == null ? null : String(stage),
    contextId: contextId == null ? null : String(contextId),
    contextRevision: contextRevision == null ? null : nonNegativeInteger(contextRevision),
    turnAttempt: Math.max(1, nonNegativeInteger(turnAttempt) || 1),
    retryReasons: normalizedRetryReasons,
    visibility,
    promptChars: unicodeCharCount(promptText),
    promptSha256: createHash("sha256").update(promptText, "utf8").digest("hex"),
    systemChars: systemPrompt == null ? null : unicodeCharCount(systemPrompt),
    stageChars: null,
    contextChars: null,
    toolSchemaChars: toolDefinitions == null ? null : jsonCharCount(toolDefinitions),
    toolResultChars: 0,
    requestAttempts: 0,
    requestCount: 0,
    retryCount: normalizedRetryReasons.length,
    transportRetryCount: 0,
    workflowRetryCount: normalizedRetryReasons.length,
    toolRounds: visibility === "openai_compatible_requests" ? 0 : null,
    toolCalls: 0,
    providerUsageRequests: 0,
    executionSucceeded: null,
    usage: emptyUsage(),
    requests: [],
  };
}

export function recordRequestAttempt(telemetry, {
  requestIndex,
  transportAttempt,
  body,
  finalizationOnly = false,
} = {}) {
  if (!telemetry) return null;
  const entry = {
    requestIndex: Math.max(1, nonNegativeInteger(requestIndex) || 1),
    transportAttempt: Math.max(1, nonNegativeInteger(transportAttempt) || 1),
    finalizationOnly: !!finalizationOnly,
    messageChars: jsonCharCount(body?.messages || []),
    toolSchemaChars: jsonCharCount(body?.tools || []),
    outcome: "pending",
    usage: null,
  };
  telemetry.requests.push(entry);
  telemetry.requestAttempts += 1;
  if (entry.transportAttempt > 1) {
    telemetry.transportRetryCount = (telemetry.transportRetryCount || 0) + 1;
    telemetry.retryCount = (telemetry.retryCount || 0) + 1;
  }
  return entry;
}

export function recordRequestFailure(entry, outcome = "error") {
  if (entry) entry.outcome = String(outcome || "error");
}

export function recordProviderResponse(telemetry, entry, { usage, toolCalls = [] } = {}) {
  if (!telemetry) return;
  const normalized = normalizeProviderUsage(usage);
  telemetry.requestCount += 1;
  if (entry) {
    entry.outcome = "response";
    entry.usage = normalized;
  }
  if (normalized) {
    telemetry.providerUsageRequests += 1;
    for (const field of USAGE_FIELDS) telemetry.usage[field] += normalized[field];
    if (normalized.costUsd != null) {
      telemetry.usage.costUsd = (telemetry.usage.costUsd || 0) + normalized.costUsd;
    }
    telemetry.usage.source = "provider";
  }
  const count = Array.isArray(toolCalls) ? toolCalls.length : 0;
  if (count > 0) {
    telemetry.toolRounds = (telemetry.toolRounds || 0) + 1;
    telemetry.toolCalls += count;
  }
}

export function recordToolResultChars(telemetry, value) {
  if (telemetry) telemetry.toolResultChars += unicodeCharCount(value);
}

export function completeAgentTurnTelemetry(existing, {
  provider = "",
  model = "",
  prompt = "",
  storyId = null,
  attemptId = null,
  workflowKind = "",
  stage = null,
  contextId = null,
  contextRevision = null,
  turnAttempt = 1,
  retryReasons = [],
  usage = null,
  estimatedUsage = null,
  transcript = [],
  assumeSingleRequest = true,
} = {}) {
  const telemetry = existing || createAgentTurnTelemetry({
    provider,
    model,
    prompt,
    storyId,
    attemptId,
    workflowKind,
    stage,
    contextId,
    contextRevision,
    turnAttempt,
    retryReasons,
  });
  if (telemetry.executionSucceeded == null && typeof telemetry.succeeded === "boolean") {
    telemetry.executionSucceeded = telemetry.succeeded;
  }
  telemetry.provider ||= String(provider || "");
  telemetry.model ||= String(model || "");
  telemetry.storyId ??= storyId == null ? null : String(storyId);
  telemetry.attemptId ??= attemptId == null ? null : String(attemptId);
  telemetry.workflowKind ||= String(workflowKind || "") || null;
  telemetry.stage ??= stage == null ? null : String(stage);
  telemetry.contextId ??= contextId == null ? null : String(contextId);
  telemetry.contextRevision ??= contextRevision == null ? null : nonNegativeInteger(contextRevision);
  telemetry.turnAttempt = Math.max(telemetry.turnAttempt || 1, nonNegativeInteger(turnAttempt) || 1);
  telemetry.retryReasons = compactStrings([...(telemetry.retryReasons || []), ...compactStrings(retryReasons)]);
  telemetry.workflowRetryCount = telemetry.retryReasons.length;
  telemetry.transportRetryCount = nonNegativeInteger(telemetry.transportRetryCount);
  telemetry.retryCount = telemetry.workflowRetryCount + telemetry.transportRetryCount;

  if (!existing && assumeSingleRequest) {
    telemetry.requestAttempts = 1;
    telemetry.requestCount = 1;
    telemetry.toolCalls = (Array.isArray(transcript) ? transcript : [])
      .filter((item) => item?.type === "tool_use").length;
  }

  if (telemetry.usage?.source !== "provider") {
    const reported = normalizeProviderUsage(usage);
    const estimated = normalizeProviderUsage(estimatedUsage);
    const selected = reported || estimated;
    telemetry.usage = selected
      ? { ...selected, source: reported ? "provider" : "estimated" }
      : emptyUsage();
    if (reported) telemetry.providerUsageRequests = Math.max(1, telemetry.providerUsageRequests || 0);
  }
  return telemetry;
}
