import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createHash } from "node:crypto";

const runnerSource = fs.readFileSync(
  new URL("../services/agent-runner.js", import.meta.url),
  "utf8",
);

function extractStructuredRunnerHelpers() {
  const start = runnerSource.indexOf("const STRUCTURED_DESCRIPTOR_KEYS");
  const end = runnerSource.indexOf("function buildPrompt", start);
  assert.ok(start >= 0 && end > start, "structured runner guard must exist");
  const implementation = runnerSource
    .slice(start, end)
    .replaceAll("export function ", "function ");
  return Function(
    "createHash",
    `"use strict"; ${implementation}; return { prepareStructuredTask, finalizeStructuredCliResult, taskResultForPersistence };`,
  )(createHash);
}

function sha256(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function structuredTask(strategy = "finish_stage") {
  const prompt = "STRUCTURED\n<CONTEXT_JSON>{}</CONTEXT_JSON>";
  const structuredOutput = {
    mode: "structured",
    strategy,
    schemaId: "urn:aiefficiency:workflow-v2:runner-test",
    schema: {
      type: "object",
      properties: { conclusion: { type: "string", enum: ["PASS", "FAIL"] } },
      required: ["conclusion"],
    },
    contextId: "ctx-runner-1",
    contextRevision: 6,
    idempotencyKey: "story-runner:VERIFY:6",
  };
  return {
    promptMode: "structured",
    promptOverride: prompt,
    promptSha256: sha256(prompt),
    cliSessionId: null,
    streamingInput: false,
    imagePaths: [],
    structuredOutput,
    telemetryContext: {
      promptMode: "structured",
      contextId: structuredOutput.contextId,
      contextRevision: structuredOutput.contextRevision,
      contextHash: "a".repeat(64),
      schemaId: structuredOutput.schemaId,
      idempotencyKey: structuredOutput.idempotencyKey,
    },
  };
}

test("agent-runner 冻结 structured descriptor/schema，同时支持 API finish_stage 和 CLI json_text", () => {
  const { prepareStructuredTask } = extractStructuredRunnerHelpers();
  for (const strategy of ["finish_stage", "json_text"]) {
    const task = structuredTask(strategy);
    const prepared = prepareStructuredTask(task);
    task.structuredOutput.schema.properties.conclusion.enum.push("MUTATED");
    task.structuredOutput.schemaId = "mutated";
    task.telemetryContext.contextId = "mutated";
    assert.equal(prepared.structuredOutput.strategy, strategy);
    assert.equal(prepared.structuredOutput.schemaId, "urn:aiefficiency:workflow-v2:runner-test");
    assert.deepEqual(prepared.structuredOutput.schema.properties.conclusion.enum, ["PASS", "FAIL"]);
    assert.equal(Object.isFrozen(prepared.structuredOutput), true);
    assert.equal(Object.isFrozen(prepared.structuredOutput.schema.properties.conclusion.enum), true);
    assert.equal(prepared.telemetryContext.contextId, "ctx-runner-1");
    assert.equal(Object.isFrozen(prepared.telemetryContext), true);
  }
});

test("agent-runner structured guard 对 prompt/session/image/telemetry/descriptor 任一漂移 fail closed", () => {
  const { prepareStructuredTask } = extractStructuredRunnerHelpers();
  const valid = structuredTask();
  const mutations = [
    { promptSha256: "b".repeat(64) },
    { cliSessionId: "resume-forbidden" },
    { streamingInput: true },
    { imagePaths: ["hidden.png"] },
    { telemetryContext: { ...valid.telemetryContext, contextId: "other" } },
    { telemetryContext: { ...valid.telemetryContext, contextRevision: 7 } },
    { telemetryContext: { ...valid.telemetryContext, contextHash: "bad" } },
    { telemetryContext: { ...valid.telemetryContext, schemaId: "other" } },
    { telemetryContext: { ...valid.telemetryContext, idempotencyKey: "other" } },
    { structuredOutput: { ...valid.structuredOutput, strategy: "text_fallback" } },
    { structuredOutput: { ...valid.structuredOutput, unexpected: true } },
  ];
  for (const mutation of mutations) {
    assert.throws(
      () => prepareStructuredTask({ ...valid, ...mutation }),
      (error) => error.code === "WORKFLOW_V2_STRUCTURED_TASK_INVALID",
    );
  }
});

test("CLI json_text 只接受单一 JSON object，结果不泄漏原始 JSON 且不可变", () => {
  const { prepareStructuredTask, finalizeStructuredCliResult } = extractStructuredRunnerHelpers();
  const task = prepareStructuredTask(structuredTask("json_text"));
  const result = finalizeStructuredCliResult(task, {
    output: '{"conclusion":"PASS"}',
    report: '{"conclusion":"PASS"}',
    cliSessionId: "must-not-resume",
    transcript: [
      { type: "thinking", content: "checked" },
      { type: "text", content: '{"conclusion":"PASS"}' },
    ],
    usage: { inputTokens: 9, outputTokens: 2 },
  });
  assert.deepEqual(result.structuredResult, { conclusion: "PASS" });
  assert.equal(result.structuredSchemaId, "urn:aiefficiency:workflow-v2:runner-test");
  assert.equal(result.output, "");
  assert.equal(result.report, "");
  assert.equal(result.cliSessionId, null);
  assert.deepEqual(result.transcript, [{ type: "thinking", content: "checked" }]);
  assert.equal(Object.isFrozen(result.structuredResult), true);

  for (const raw of [
    "",
    "[]",
    '```json\n{"conclusion":"PASS"}\n```',
    'prefix {"conclusion":"PASS"}',
    '{"conclusion":"PASS"} suffix',
  ]) {
    assert.throws(
      () => finalizeStructuredCliResult(task, { output: raw, report: raw, transcript: [] }),
      (error) => error.code === "WORKFLOW_V2_STRUCTURED_JSON_TEXT_INVALID",
    );
  }
  assert.throws(
    () => finalizeStructuredCliResult(task, { output: "{}", report: '{"different":true}' }),
    (error) => error.code === "WORKFLOW_V2_STRUCTURED_JSON_TEXT_INVALID",
  );
  assert.throws(
    () => finalizeStructuredCliResult(task, {
      output: "not-json",
      report: "not-json",
      transcript: [{ type: "text", content: "not-json" }],
      usage: { inputTokens: 5, outputTokens: 1 },
    }),
    (error) => error.code === "WORKFLOW_V2_STRUCTURED_JSON_TEXT_INVALID"
      && error.usage.inputTokens === 5
      && error.transcript.length === 0,
  );
});

test("structured runTask 保留内存结果，但 tasks.result 只允许安全身份元数据", () => {
  const { prepareStructuredTask, taskResultForPersistence } = extractStructuredRunnerHelpers();
  const task = prepareStructuredTask(structuredTask("finish_stage"));
  const inMemoryResult = {
    structuredResult: { conclusion: "PASS", secret: "raw-model-payload" },
    structuredSchemaId: task.structuredOutput.schemaId,
    receiptIds: ["model-must-not-persist"],
    transcript: [{ type: "thinking", content: "private" }],
    usage: { inputTokens: 11, outputTokens: 3 },
    telemetry: { schemaVersion: "agent-turn-telemetry-v2", requestCount: 1 },
  };
  const persisted = taskResultForPersistence(task, inMemoryResult);
  assert.deepEqual(persisted, {
    schemaId: task.structuredOutput.schemaId,
    contextId: task.structuredOutput.contextId,
    contextRevision: task.structuredOutput.contextRevision,
    usage: { inputTokens: 11, outputTokens: 3 },
    telemetry: { schemaVersion: "agent-turn-telemetry-v2", requestCount: 1 },
  });
  assert.deepEqual(inMemoryResult.structuredResult, {
    conclusion: "PASS",
    secret: "raw-model-payload",
  }, "主链内存对象必须保持完整");
  assert.doesNotMatch(JSON.stringify(persisted), /PASS|raw-model-payload|receiptIds|transcript/);

  const descriptorMissingFailure = taskResultForPersistence(
    { promptMode: "structured" },
    {
      code: "WORKFLOW_V2_STRUCTURED_JSON_TEXT_INVALID",
      error: "CLI structured report 必须是单一 JSON object",
      partialOutput: "raw structured payload",
      transcript: [{ content: "raw structured payload" }],
    },
  );
  assert.deepEqual(descriptorMissingFailure, {
    code: "WORKFLOW_V2_STRUCTURED_JSON_TEXT_INVALID",
    error: "CLI structured report 必须是单一 JSON object",
  });

  const legacyResult = { output: "legacy remains compatible" };
  assert.equal(taskResultForPersistence({ promptMode: "compatibility" }, legacyResult), legacyResult);
});

test("agent-runner 按 transport 强制 strategy，structured 文本流不透传 UI/liveDraft", () => {
  assert.match(runnerSource, /structuredMode && task\.structuredOutput\.strategy !== "finish_stage"/);
  assert.match(runnerSource, /structuredMode && task\.structuredOutput\.strategy !== "json_text"/);
  assert.match(runnerSource, /structuredOutput: task\.promptMode === "structured" \? task\.structuredOutput : null/);
  assert.match(runnerSource, /task\.promptMode === "structured" && deltaType === "text"/);
  assert.match(runnerSource, /task\.promptMode === "structured" && type === "text"/);
  assert.match(runnerSource, /structured task 不允许中心文本代理 transport/);
  assert.match(runnerSource, /task\.promptMode === "structured"[\s\S]*error\.terminalFailure = true/);
  assert.match(
    runnerSource,
    /const measuredOutput = task\.promptMode === "structured" && result\.structuredResult[\s\S]*JSON\.stringify\(result\.structuredResult\)/,
    "CLI structured usage must estimate output from the preserved structured result, not cleared report/output fields",
  );
  assert.match(runnerSource, /const outputLen = unicodeCharCount\(measuredOutput\)/);
  assert.match(runnerSource, /const estOutput = Math\.ceil\(outputLen \* 0\.6\)/);
  assert.match(
    runnerSource,
    /result: JSON\.stringify\(taskResultForPersistence\(task, result\)\)/,
    "SQLite tasks.result must not receive the raw structured provider result",
  );
});
