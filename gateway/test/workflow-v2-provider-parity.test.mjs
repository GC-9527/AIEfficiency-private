import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { composeStructuredPrompt } from "../services/devbench/workflow-v2/structured-prompt.js";
import { parseStrictStructuredResult } from "../services/devbench/workflow-v2/structured-result-gate.js";
import { WORKFLOW_V2_SCHEMA_IDS, workflowV2SchemaRegistry } from "../services/devbench/workflow-v2/schema-registry.js";

const STORY_ID = "story-parity-001";
const CONTEXT_ID = "ctx-parity-001";
const REVISION = 5;
const IDEM_KEY = "parity:5";

function baseContext(stageId, outputSchemaId) {
  return {
    schemaVersion: "tb-stage-context-v2",
    contextId: CONTEXT_ID,
    revision: REVISION,
    idempotencyKey: IDEM_KEY,
    story: { storyId: STORY_ID, ticketId: "t-1", carbId: null, title: "parity", groupId: null },
    stage: { id: stageId, attempt: 1, riskLevel: "MEDIUM" },
    task: { instruction: "测试指令", successCriteria: ["c"], userVisibleGoal: "goal" },
    scope: {
      roots: [
        { rootId: "main", kind: "MAIN", projectId: null, branch: null, flavor: null, versionName: null, writable: stageId === "REPAIR" },
        { rootId: "artifacts", kind: "ARTIFACT", projectId: null, branch: null, flavor: null, versionName: null, writable: stageId === "REPORT_EXPERT" },
      ],
      protectedPaths: [".git/**", "AGENTS.md"],
      tempRootId: "artifacts",
      deviceProfileId: null,
    },
    capabilities: {
      allowedTools: ["read_file", "search_files", "git_diff"],
      canWriteSource: stageId === "REPAIR",
      canReadGit: true,
      canWriteGit: false,
      canCommit: false,
      canUseDevice: false,
      canWriteTb: false,
      canWriteReport: false,
      maxToolIterations: 10,
      longProcessProtocol: "NONE",
    },
    output: { schemaId: outputSchemaId, maxChars: stageId === "REPORT_SHORT" ? 100 : null, outputPath: null },
    checkpoint: {
      schemaVersion: "workflow-checkpoint-v2",
      storyId: STORY_ID,
      revision: 1,
      claims: [],
      actions: [],
      changes: [],
      verification: [],
      openItems: [],
      userDecisions: [],
    },
    data: { evidenceManifest: { items: [] } },
  };
}

const STAGES = Object.freeze({
  TRIAGE: WORKFLOW_V2_SCHEMA_IDS.triageResult,
  REPAIR: WORKFLOW_V2_SCHEMA_IDS.repairResult,
  VERIFY_EXECUTE: WORKFLOW_V2_SCHEMA_IDS.verificationResult,
  REPORT_SHORT: WORKFLOW_V2_SCHEMA_IDS.shortReportResult,
  REPORT_EXPERT: WORKFLOW_V2_SCHEMA_IDS.expertReportResult,
});

function stageResultFixture(stageId) {
  const identity = { schemaVersion: "x", contextId: CONTEXT_ID, contextRevision: REVISION, idempotencyKey: IDEM_KEY };
  switch (stageId) {
    case "TRIAGE":
      return {
        ...identity,
        status: "COMPLETED",
        classification: "CLIENT_ISSUE",
        confidence: "HIGH",
        rootCause: { symptom: "崩溃", trigger: "空指针", observedBehavior: "闪退", directCause: "缺少判空", faultOwner: "media", workaroundOwner: "" },
        claims: [],
        evidenceRead: [],
        evidenceUnread: [],
        recommendedAction: "REPAIR",
        userSummary: "已定位",
        nextStage: "REPAIR",
      };
    case "REPAIR":
      return {
        ...identity,
        status: "COMPLETED",
        outcome: "FIXED",
        rootCause: "空指针",
        changes: [],
        localChecks: [],
        risks: [],
        remaining: [],
        userFriendlyCause: "空指针",
        userFriendlyMeasure: "增加判空",
        changeSummary: "补判空",
        evidenceRead: [],
        evidenceUnread: [],
        nextStage: "LOCAL_GATE",
        summary: "修复完成",
      };
    case "VERIFY_EXECUTE":
      return {
        ...identity,
        status: "COMPLETED",
        conclusion: "PASS",
        planId: "plan-1",
        environment: { device: null, flavor: null },
        cases: [],
        mandatorySummary: { total: 0, passed: 0, failed: 0, blocked: 0, notRun: 0 },
        remaining: [],
        nextStage: "REPORTING",
      };
    case "REPORT_SHORT":
      return { ...identity, reportText: "原因：空指针未拦截\n措施：增加判空" };
    case "REPORT_EXPERT":
      return {
        ...identity,
        status: "COMPLETED",
        htmlRef: "storydev:/reports/acceptance-report.html",
        usedEvidenceIds: [],
        usedAssetIds: [],
        warnings: [],
      };
    default:
      throw new Error(`unknown stage ${stageId}`);
  }
}

describe("M10 跨 Provider 能力协商与结果一致性", () => {
  for (const stageId of Object.keys(STAGES)) {
    it(`${stageId}：finish_stage 与 json_text 两种策略共享冻结身份且结果 Schema 合法`, () => {
      const context = baseContext(stageId, STAGES[stageId]);
      const finish = composeStructuredPrompt({ context, strategy: "finish_stage" });
      const jsonText = composeStructuredPrompt({ context, strategy: "json_text" });

      // 同一 fixture 的冻结身份完全一致
      assert.equal(finish.contextHash, jsonText.contextHash);
      assert.equal(finish.resultSchemaId, STAGES[stageId]);
      assert.equal(finish.resultSchemaSha256, jsonText.resultSchemaSha256);
      assert.equal(finish.structuredOutput.contextId, CONTEXT_ID);
      assert.equal(finish.structuredOutput.contextRevision, REVISION);
      assert.equal(finish.structuredOutput.idempotencyKey, IDEM_KEY);
      assert.equal(jsonText.structuredOutput.idempotencyKey, IDEM_KEY);

      // 能力协商差异：finish_stage 提示必须要求终态工具，json_text 不要求
      assert.match(finish.prompt, /finish_stage/);
      assert.doesNotMatch(jsonText.prompt, /finish_stage/);
      assert.equal(finish.structuredStrategy, "finish_stage");
      assert.equal(jsonText.structuredStrategy, "json_text");

      // 没有任何 Provider 提示包含 run_bash/任务状态模板（API-002/PROV-001）
      assert.doesNotMatch(finish.prompt, /run_bash|Task 工具|任务状态：/);
      assert.doesNotMatch(jsonText.prompt, /run_bash|Task 工具|任务状态：/);
      // 两策略提示字符预算一致可控
      assert.ok(finish.promptChars < 50000 && jsonText.promptChars < 50000);

      // 同一 fixture 的结果在两个策略下都能严格解析并过 Schema（跨 Provider 语义一致）
      const fixture = stageResultFixture(stageId);
      fixture.schemaVersion = workflowV2SchemaRegistry.getSchemaDocument(STAGES[stageId]).properties.schemaVersion.const;
      const parsed = parseStrictStructuredResult(JSON.stringify(fixture));
      const validation = workflowV2SchemaRegistry.validate(finish.resultSchemaId, parsed);
      assert.equal(validation.valid, true, JSON.stringify(validation.errors).slice(0, 500));
    });
  }

  it("promptSha256 随策略变化但 contextHash 恒定（灰度对照可复现）", () => {
    const context = baseContext("TRIAGE", STAGES.TRIAGE);
    const first = composeStructuredPrompt({ context, strategy: "json_text" });
    const second = composeStructuredPrompt({ context, strategy: "json_text" });
    assert.equal(first.promptSha256, second.promptSha256);
    assert.equal(first.promptChars, second.promptChars);
    const finish = composeStructuredPrompt({ context, strategy: "finish_stage" });
    assert.notEqual(first.promptSha256, finish.promptSha256);
  });

  it("context 漂移（revision/指令变化）必然改变冻结 hash，同一 fixture 稳定", () => {
    const contextA = baseContext("TRIAGE", STAGES.TRIAGE);
    const contextB = baseContext("TRIAGE", STAGES.TRIAGE);
    contextB.revision = REVISION + 1;
    const a = composeStructuredPrompt({ context: contextA, strategy: "json_text" });
    const b = composeStructuredPrompt({ context: contextB, strategy: "json_text" });
    assert.notEqual(a.contextHash, b.contextHash);
    assert.notEqual(a.structuredOutput.contextRevision, b.structuredOutput.contextRevision);
  });

  it("strictMarkersV2 开关存在于配置默认值且默认关闭", async () => {
    const config = await import("../services/config.js");
    assert.equal(config.DEFAULT_WORKFLOW_V2_FEATURE_FLAGS.strictMarkersV2, false);
    assert.equal(config.getConfig().workflowV2.featureFlags.strictMarkersV2, false);
  });
});
