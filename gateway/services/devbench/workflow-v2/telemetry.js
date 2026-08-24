import { createHash, randomUUID } from "node:crypto";
import { canonicalJson, workflowV2EnvelopeStore } from "./envelope-store.js";

const TELEMETRY_SCHEMA_VERSION = "telemetry-request-v2";
const MAX_TELEMETRY_EVENTS_PER_SESSION = 10000;

/**
 * @typedef {Object} TelemetryMetrics
 * @property {string}  contextId
 * @property {number}  contextRevision
 * @property {string}  stageId
 * @property {number}  attempt
 * @property {string}  providerName
 * @property {string}  modelName
 * @property {number}  contextChars        — Unicode length of the assembled user message (StageContext JSON)。
 * @property {number}  systemChars         — Unicode length of the system prompt sent。
 * @property {number}  stageChars          — Unicode length of the stage prompt template。
 * @property {number}  toolSchemaChars     — Unicode length of the serialized tool definitions。
 * @property {number}  toolResultChars     — total Unicode length of all tool results in this request。
 * @property {number}  inputTokens         — provider-reported prompt tokens (undefined if unavailable)。
 * @property {number}  outputTokens        — provider-reported completion tokens。
 * @property {number}  cachedTokens        — provider-reported cache hit tokens (undefined if unavailable)。
 * @property {number}  requestAttempt      — 1-based attempt index for this contextId。
 * @property {number}  toolRound           — number of tool-call round-trips in this request。
 * @property {string}  idempotencyKey
 * @property {string}  [errorCode]         — error code if the request failed。
 */

export class WorkflowV2TelemetryError extends Error {
  constructor(message, code, details = {}) {
    super(message);
    this.name = "WorkflowV2TelemetryError";
    this.code = code;
    this.details = details;
  }
}

function fail(message, code, details = {}) {
  throw new WorkflowV2TelemetryError(message, code, details);
}

function sha256Hex(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function assertInteger(value, name) {
  if (!Number.isInteger(value) || value < 0) {
    fail(`${name} must be a non-negative integer`, "WORKFLOW_V2_TELEMETRY_INVALID", { name, value });
  }
}

function assertString(value, name, maxLen = 256) {
  if (typeof value !== "string" || value.length === 0 || value.length > maxLen) {
    fail(`${name} must be a non-empty string ≤${maxLen} chars`, "WORKFLOW_V2_TELEMETRY_INVALID", {
      name,
      actual: typeof value,
    });
  }
}

export class WorkflowV2Telemetry {
  constructor({ envelopeStore = workflowV2EnvelopeStore } = {}) {
    this._envelopeStore = envelopeStore;
    this._events = [];
    this._maxEvents = MAX_TELEMETRY_EVENTS_PER_SESSION;
  }

  /**
   * Record one provider request telemetry event in-memory。
   * Resets when process restarts; the primary durability target is the provider-usage
   * summary persisted to DB after every turn (see agent-runner tryRunWithEngine)。
   */
  recordRequest(metrics) {
    if (this._events.length >= this._maxEvents) {
      this._events.splice(0, this._events.length - this._maxEvents + 1);
    }

    assertString(metrics.contextId || "", "contextId");
    assertInteger(metrics.contextRevision ?? 0, "contextRevision");
    assertString(metrics.stageId || "", "stageId");
    assertInteger(metrics.attempt ?? 0, "attempt");
    assertString(metrics.providerName || "", "providerName");
    assertString(metrics.modelName || "", "modelName", 128);
    assertInteger(metrics.contextChars ?? 0, "contextChars");
    assertInteger(metrics.systemChars ?? 0, "systemChars");
    assertInteger(metrics.stageChars ?? 0, "stageChars");
    assertInteger(metrics.toolSchemaChars ?? 0, "toolSchemaChars");
    assertInteger(metrics.toolResultChars ?? 0, "toolResultChars");
    assertInteger(metrics.requestAttempt ?? 1, "requestAttempt");
    assertInteger(metrics.toolRound ?? 0, "toolRound");

    if (metrics.inputTokens !== undefined) assertInteger(metrics.inputTokens, "inputTokens");
    if (metrics.outputTokens !== undefined) assertInteger(metrics.outputTokens, "outputTokens");
    if (metrics.cachedTokens !== undefined) assertInteger(metrics.cachedTokens, "cachedTokens");

    const event = {
      schemaVersion: TELEMETRY_SCHEMA_VERSION,
      eventId: randomUUID(),
      recordedAt: new Date().toISOString(),
      contextId: metrics.contextId,
      contextRevision: metrics.contextRevision,
      stageId: metrics.stageId,
      attempt: metrics.attempt,
      providerName: metrics.providerName,
      modelName: metrics.modelName ?? "",
      contextChars: metrics.contextChars,
      systemChars: metrics.systemChars,
      stageChars: metrics.stageChars,
      toolSchemaChars: metrics.toolSchemaChars,
      toolResultChars: metrics.toolResultChars,
      inputTokens: metrics.inputTokens ?? null,
      outputTokens: metrics.outputTokens ?? null,
      cachedTokens: metrics.cachedTokens ?? null,
      requestAttempt: metrics.requestAttempt,
      toolRound: metrics.toolRound,
      idempotencyKey: metrics.idempotencyKey ?? "",
      errorCode: metrics.errorCode ?? null,
      _canonicalHash: sha256Hex(canonicalJson({
        contextId: metrics.contextId,
        contextRevision: metrics.contextRevision,
        stageId: metrics.stageId,
        attempt: metrics.attempt,
        providerName: metrics.providerName,
        modelName: metrics.modelName ?? "",
        requestAttempt: metrics.requestAttempt,
        toolRound: metrics.toolRound,
      })),
    };

    this._events.push(event);
    return event;
  }

  /**
   * Aggregate all in-memory events grouped by (storyId, stageId)。
   * Returns { storyId, stageId, totalRequests, totalInputTokens, totalOutputTokens,
   *          totalToolRounds, avgContextChars, p50InputTokens, p90InputTokens, events[] }。
   */
  aggregateByStage(storyId) {
    const stageGroups = new Map();
    for (const event of this._events) {
      // Filter by storyId via contextId prefix convention <storyId>:...
      if (storyId && !event.contextId.startsWith(storyId)) continue;
      const key = event.stageId;
      if (!stageGroups.has(key)) {
        stageGroups.set(key, {
          storyId,
          stageId: event.stageId,
          contextId: event.contextId,
          totalRequests: 0,
          totalInputTokens: 0,
          totalOutputTokens: 0,
          totalToolRounds: 0,
          totalContextChars: 0,
          events: [],
        });
      }
      const group = stageGroups.get(key);
      group.totalRequests += 1;
      if (event.inputTokens !== null) group.totalInputTokens += event.inputTokens;
      if (event.outputTokens !== null) group.totalOutputTokens += event.outputTokens;
      group.totalToolRounds += event.toolRound;
      group.totalContextChars += event.contextChars;
      group.events.push(event);
    }

    const result = [];
    for (const group of stageGroups.values()) {
      const inputTokens = group.events
        .map((e) => e.inputTokens)
        .filter((v) => v !== null)
        .sort((a, b) => a - b);
      result.push({
        ...group,
        avgContextChars: group.totalRequests > 0
          ? Math.round(group.totalContextChars / group.totalRequests)
          : 0,
        p50InputTokens: percentile(inputTokens, 50),
        p90InputTokens: percentile(inputTokens, 90),
        events: undefined, // omit raw events from summary
      });
    }
    return result;
  }

  /**
   * Returns a compact baseline snapshot suitable for comparison across milestones。
   */
  baselineSnapshot(storyId) {
    const stages = this.aggregateByStage(storyId);
    return {
      schemaVersion: "telemetry-baseline-v2",
      generatedAt: new Date().toISOString(),
      storyId,
      stageCount: stages.length,
      totalRequests: stages.reduce((s, g) => s + g.totalRequests, 0),
      totalInputTokens: stages.reduce((s, g) => s + g.totalInputTokens, 0),
      totalOutputTokens: stages.reduce((s, g) => s + g.totalOutputTokens, 0),
      totalToolRounds: stages.reduce((s, g) => s + g.totalToolRounds, 0),
      stages,
    };
  }

  /**
   * Clears all in-memory telemetry events (for testing)。
   */
  _resetForTest() {
    this._events.length = 0;
  }

  get eventCount() {
    return this._events.length;
  }
}

function percentile(sorted, pct) {
  if (sorted.length === 0) return null;
  const idx = Math.ceil((pct / 100) * sorted.length) - 1;
  return sorted[Math.max(0, Math.min(idx, sorted.length - 1))];
}

/** Singleton shared by agent-runner and api-engine */
export const workflowV2Telemetry = new WorkflowV2Telemetry();
