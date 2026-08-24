import { after, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agent-telemetry-"));
process.env.GATEWAY_DB_PATH = path.join(tmp, "gateway.db");

const fixture = JSON.parse(fs.readFileSync(
  new URL("./fixtures/devbench-phase2/turn-observability.fixture.json", import.meta.url),
  "utf8",
));
const telemetryModule = await import("../services/agent-telemetry.js");
const sqlite = await import(`../db/sqlite.js?agent-telemetry=${Date.now()}`);

after(() => {
  sqlite.default.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("Unicode Prompt 字符按 code point 计数并生成稳定哈希", () => {
  const telemetry = telemetryModule.createAgentTurnTelemetry({
    provider: "fixture",
    prompt: fixture.prompt,
  });
  assert.equal(telemetry.promptChars, fixture.expected.promptChars);
  assert.equal(telemetry.promptSha256.length, 64);
  assert.equal(telemetryModule.unicodeCharCount("A😀B"), 3);
  assert.equal(telemetry.schemaVersion, "agent-turn-telemetry-v2");
});

test("v1 succeeded 字段归一化为 v2 执行结果语义", () => {
  const legacy = telemetryModule.createAgentTurnTelemetry({ prompt: "legacy" });
  legacy.schemaVersion = "agent-turn-telemetry-v1";
  legacy.succeeded = true;
  delete legacy.executionSucceeded;
  const normalized = telemetryModule.completeAgentTurnTelemetry(legacy);
  assert.equal(normalized.executionSucceeded, true);
});

test("无 Provider 请求证据时保持零计数，CLI 可显式保留单次不透明执行", () => {
  const apiPreflightFailure = telemetryModule.completeAgentTurnTelemetry(null, {
    provider: "deepseek",
    prompt: "preflight",
    assumeSingleRequest: false,
  });
  assert.equal(apiPreflightFailure.requestAttempts, 0);
  assert.equal(apiPreflightFailure.requestCount, 0);
  assert.deepEqual(apiPreflightFailure.requests, []);

  const opaqueCli = telemetryModule.completeAgentTurnTelemetry(null, {
    provider: "codex",
    prompt: "opaque-cli",
  });
  assert.equal(opaqueCli.requestAttempts, 1);
  assert.equal(opaqueCli.requestCount, 1);
});

test("token_usage 持久化真实来源、Prompt、请求、重试与工具指标", () => {
  sqlite.createTask({
    id: "telemetry-task",
    title: "telemetry",
    description: "fixture",
    type: "general",
    status: "completed",
    priority: 3,
    source: "test",
    sourceId: null,
  });
  const telemetry = telemetryModule.createAgentTurnTelemetry({
    provider: "deepseek",
    model: "fixture-model",
    prompt: fixture.prompt,
    storyId: "story-1",
    attemptId: "attempt-1",
    workflowKind: "verify",
    stage: "VERIFY",
  });
  Object.assign(telemetry, {
    requestAttempts: fixture.expected.requestAttempts,
    requestCount: fixture.expected.requestCount,
    retryCount: fixture.expected.retryCount,
    transportRetryCount: fixture.expected.transportRetryCount,
    workflowRetryCount: fixture.expected.workflowRetryCount,
    toolRounds: fixture.expected.toolRounds,
    toolCalls: fixture.expected.toolCalls,
    executionSucceeded: true,
    usage: {
      source: "provider",
      inputTokens: fixture.expected.inputTokens,
      outputTokens: fixture.expected.outputTokens,
      cacheReadTokens: fixture.expected.cacheReadTokens,
      cacheCreationTokens: fixture.expected.cacheCreationTokens,
      costUsd: null
    },
  });

  sqlite.addTokenUsage(
    "telemetry-task",
    "deepseek",
    fixture.expected.inputTokens,
    fixture.expected.outputTokens,
    telemetry,
  );

  const [row] = sqlite.getTokenUsage({ days: 1 });
  assert.equal(row.provider_input, fixture.expected.inputTokens);
  assert.equal(row.provider_output, fixture.expected.outputTokens);
  assert.equal(row.estimated_input, 0);
  assert.equal(row.prompt_chars, fixture.expected.promptChars);
  assert.equal(row.request_attempts, fixture.expected.requestAttempts);
  assert.equal(row.retry_count, fixture.expected.retryCount);
  assert.equal(row.transport_retry_count, fixture.expected.transportRetryCount);
  assert.equal(row.workflow_retry_count, fixture.expected.workflowRetryCount);
  assert.equal(row.tool_rounds, fixture.expected.toolRounds);
  assert.equal(row.tool_calls, fixture.expected.toolCalls);
  assert.equal(row.execution_succeeded_calls, 1);
  assert.equal(sqlite.getTokenUsage({ days: -1 }).length, 1);
  assert.equal(sqlite.getTokenUsage({ days: Number.POSITIVE_INFINITY }).length, 1);
});
