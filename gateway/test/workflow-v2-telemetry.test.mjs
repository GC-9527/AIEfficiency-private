import { describe, it, beforeEach, afterEach } from "node:test";
import { strict as assert } from "node:assert";
import { WorkflowV2Telemetry, workflowV2Telemetry } from "../services/devbench/workflow-v2/telemetry.js";

describe("WorkflowV2Telemetry", () => {
  let telemetry;

  beforeEach(() => {
    telemetry = new WorkflowV2Telemetry();
  });

  afterEach(() => {
    telemetry._resetForTest();
  });

  it("记录单次请求并生成 event", () => {
    const event = telemetry.recordRequest({
      contextId: "ctx-story-001-triage-1",
      contextRevision: 1,
      stageId: "TRIAGE",
      attempt: 1,
      providerName: "claude",
      modelName: "claude-sonnet-4-20250514",
      contextChars: 4200,
      systemChars: 800,
      stageChars: 700,
      toolSchemaChars: 3000,
      toolResultChars: 0,
      inputTokens: 3200,
      outputTokens: 450,
      cachedTokens: 1200,
      requestAttempt: 1,
      toolRound: 3,
      idempotencyKey: "story-001:TRIAGE:1",
    });

    assert.ok(event.eventId);
    assert.equal(event.schemaVersion, "telemetry-request-v2");
    assert.equal(event.stageId, "TRIAGE");
    assert.equal(event.contextChars, 4200);
    assert.equal(event.inputTokens, 3200);
    assert.equal(event.outputTokens, 450);
    assert.equal(event.cachedTokens, 1200);
    assert.equal(event.toolRound, 3);
    assert.equal(event.errorCode, null);
    assert.ok(event._canonicalHash);
  });

  it("inputTokens/outputTokens/cachedTokens 可为 null", () => {
    const event = telemetry.recordRequest({
      contextId: "ctx-story-002-repair-1",
      contextRevision: 2,
      stageId: "REPAIR",
      attempt: 1,
      providerName: "gemini",
      modelName: "gemini-2.5-pro",
      contextChars: 5000,
      systemChars: 800,
      stageChars: 750,
      toolSchemaChars: 2500,
      toolResultChars: 1200,
      requestAttempt: 1,
      toolRound: 5,
      idempotencyKey: "story-002:REPAIR:1",
    });

    assert.equal(event.inputTokens, null);
    assert.equal(event.outputTokens, null);
    assert.equal(event.cachedTokens, null);
  });

  it("非法字段抛出 WorkflowV2TelemetryError", () => {
    assert.throws(
      () => telemetry.recordRequest({ contextId: "", contextRevision: 0, stageId: "", attempt: 0, providerName: "", modelName: "", contextChars: -1, systemChars: 0, stageChars: 0, toolSchemaChars: 0, toolResultChars: 0, requestAttempt: 0, toolRound: 0, idempotencyKey: "" }),
      (err) => err.name === "WorkflowV2TelemetryError",
    );
  });

  it("aggregateByStage 按阶段聚合多请求", () => {
    telemetry.recordRequest({
      contextId: "ctx-story-003-triage-1",
      contextRevision: 1,
      stageId: "TRIAGE",
      attempt: 1,
      providerName: "claude",
      modelName: "claude-sonnet-4-20250514",
      contextChars: 4000,
      systemChars: 800,
      stageChars: 700,
      toolSchemaChars: 3000,
      toolResultChars: 500,
      inputTokens: 3000,
      outputTokens: 400,
      cachedTokens: 1000,
      requestAttempt: 1,
      toolRound: 4,
      idempotencyKey: "story-003:TRIAGE:1",
    });

    telemetry.recordRequest({
      contextId: "ctx-story-003-repair-1",
      contextRevision: 1,
      stageId: "REPAIR",
      attempt: 1,
      providerName: "claude",
      modelName: "claude-sonnet-4-20250514",
      contextChars: 5000,
      systemChars: 800,
      stageChars: 750,
      toolSchemaChars: 2500,
      toolResultChars: 800,
      inputTokens: 4500,
      outputTokens: 600,
      cachedTokens: 0,
      requestAttempt: 1,
      toolRound: 8,
      idempotencyKey: "story-003:REPAIR:1",
    });

    const stages = telemetry.aggregateByStage("ctx-story-003");
    assert.equal(stages.length, 2);

    const triage = stages.find((s) => s.stageId === "TRIAGE");
    assert.ok(triage);
    assert.equal(triage.totalRequests, 1);
    assert.equal(triage.totalInputTokens, 3000);
    assert.equal(triage.totalToolRounds, 4);
    assert.equal(triage.avgContextChars, 4000);

    const repair = stages.find((s) => s.stageId === "REPAIR");
    assert.ok(repair);
    assert.equal(repair.totalRequests, 1);
    assert.equal(repair.totalInputTokens, 4500);
    assert.equal(repair.totalToolRounds, 8);
  });

  it("baselineSnapshot 生成完整基线", () => {
    telemetry.recordRequest({
      contextId: "ctx-story-004-triage-1",
      contextRevision: 1,
      stageId: "TRIAGE",
      attempt: 1,
      providerName: "codex",
      modelName: "gpt-5-codex",
      contextChars: 3500,
      systemChars: 800,
      stageChars: 700,
      toolSchemaChars: 2800,
      toolResultChars: 0,
      inputTokens: 2800,
      outputTokens: 500,
      requestAttempt: 1,
      toolRound: 2,
      idempotencyKey: "story-004:TRIAGE:1",
    });

    const snapshot = telemetry.baselineSnapshot("ctx-story-004");
    assert.equal(snapshot.schemaVersion, "telemetry-baseline-v2");
    assert.equal(snapshot.storyId, "ctx-story-004");
    assert.equal(snapshot.totalRequests, 1);
    assert.equal(snapshot.totalInputTokens, 2800);
    assert.ok(snapshot.stages);
  });

  it("p50/p90 百分位计算正确", () => {
    for (let i = 0; i < 10; i++) {
      telemetry.recordRequest({
        contextId: `ctx-story-005-verify-${i}`,
        contextRevision: 1,
        stageId: "VERIFY_EXECUTE",
        attempt: 1,
        providerName: "api",
        modelName: "qwen-max",
        contextChars: 6000,
        systemChars: 800,
        stageChars: 750,
        toolSchemaChars: 4000,
        toolResultChars: 2000,
        inputTokens: 1000 + i * 200,
        outputTokens: 300,
        requestAttempt: 1,
        toolRound: i + 1,
        idempotencyKey: `story-005:VERIFY:${i}`,
      });
    }

    const stages = telemetry.aggregateByStage("ctx-story-005");
    assert.equal(stages.length, 1);
    const stage = stages[0];
    assert.equal(stage.totalRequests, 10);
    // 1000,1200,1400,1600,1800,2000,2200,2400,2600,2800
    // p50 = ceil(10*0.5)-1 = 4 → 1800
    assert.equal(stage.p50InputTokens, 1800);
    // p90 = ceil(10*0.9)-1 = 8 → 2600
    assert.equal(stage.p90InputTokens, 2600);
  });

  it("共享单例 workflowV2Telemetry 可用", () => {
    const event = workflowV2Telemetry.recordRequest({
      contextId: "ctx-singleton-test",
      contextRevision: 1,
      stageId: "TRIAGE",
      attempt: 1,
      providerName: "test",
      modelName: "test-model",
      contextChars: 1000,
      systemChars: 500,
      stageChars: 300,
      toolSchemaChars: 200,
      toolResultChars: 0,
      requestAttempt: 1,
      toolRound: 1,
      idempotencyKey: "singleton:test",
    });
    assert.ok(event.eventId);
    assert.ok(workflowV2Telemetry.eventCount >= 1);

    const snapshot = workflowV2Telemetry.baselineSnapshot("ctx-singleton-test");
    assert.ok(snapshot.stages.length >= 1);

    workflowV2Telemetry._resetForTest();
    assert.equal(workflowV2Telemetry.eventCount, 0);
  });

  it("errorCode 可记录错误状态", () => {
    const event = telemetry.recordRequest({
      contextId: "ctx-error-test",
      contextRevision: 1,
      stageId: "REPAIR",
      attempt: 2,
      providerName: "claude",
      modelName: "claude-sonnet-4-20250514",
      contextChars: 4500,
      systemChars: 800,
      stageChars: 750,
      toolSchemaChars: 2500,
      toolResultChars: 0,
      requestAttempt: 2,
      toolRound: 0,
      idempotencyKey: "error:REPAIR:2",
      errorCode: "WORKFLOW_V2_STAGE_TIMEOUT",
    });

    assert.equal(event.errorCode, "WORKFLOW_V2_STAGE_TIMEOUT");
    assert.equal(event.toolRound, 0);
    assert.equal(event.attempt, 2);
  });
});
