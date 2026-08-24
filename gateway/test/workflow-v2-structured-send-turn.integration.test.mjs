import test, { after } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "workflow-v2-structured-send-turn-"));
process.env.GATEWAY_DB_PATH = path.join(tempRoot, "gateway.db");
process.env.GATEWAY_CONFIG_PATH = path.join(tempRoot, "gateway.json");
process.env.DEVBENCH_CONFIG_PATH = path.join(tempRoot, "market.json");
process.env.DEVBENCH_STORE_DIR = path.join(tempRoot, "store");
process.env.AIEFFICIENCY_CLONE_PARENT = path.join(tempRoot, "clone-parent");
process.env.NODE_ENV = "test";
process.env.AIEFF_TEST_FULL_WORKFLOW_V2 = "1";

fs.writeFileSync(process.env.GATEWAY_CONFIG_PATH, JSON.stringify({
  codexEnabled: false,
  autoFallback: false,
  workDir: tempRoot,
  servers: { nodeId: "workflow-v2-structured-send-turn-test" },
  apiMaxToolIterations: 3,
  apiAgent: { workspaceIsolation: true, commandPolicy: "workspace" },
  teambition: { userCookie: "mock-cookie" },
  apiEngines: {
    deepseek: {
      enabled: true,
      name: "Mock DeepSeek",
      baseUrl: "https://workflow-v2-structured-provider.invalid",
      apiKey: "test-only-key",
      model: "mock-model",
      thinkingEnabled: false,
    },
  },
  workflowV2: {
    featureFlags: {
      promptV2: true,
      promptCompatibilityOverlay: false,
      structuredResultsV2: true,
      stageToolFiltering: false,
      evidenceReceiptsRequired: false,
      tbSyncSaga: false,
      shortReportDeterministic: false,
    },
    promptV2Rollout: {
      percentage: 100,
      salt: "workflow-v2-structured-send-turn-integration",
      storyIds: [],
      providers: ["deepseek"],
    },
    activeExecutionProfileId: "profile-structured-send-turn-test",
    executionProfiles: [{
      profileId: "profile-structured-send-turn-test",
      rootId: "main",
      stages: {
        REPAIR: {
          executors: [{
            executorId: "repair-test-executor",
            action: "TEST",
            argv: [process.execPath, "--version"],
            cwdRootId: "main",
            timeoutMs: 10_000,
          }],
          localChecks: [{
            checkId: "repair-test-check",
            name: "repair-test-check",
            executorId: "repair-test-executor",
            mandatory: true,
            rootId: "main",
          }],
        },
      },
    }],
  },
}), "utf8");

const store = await import("../services/devbench/store.js");
const sqlite = await import("../db/sqlite.js");
const logger = await import("../services/logger.js");
const { getConfig, updateConfig } = await import("../services/config.js");
const { sendTurnWithDeviceRuntime } = await import("../services/devbench/index.js");
const {
  appendEvidenceReceipt,
  canonicalSha256,
  readWorkflowV2Envelopes,
} = await import("../services/devbench/workflow-v2/envelope-store.js");
const {
  WORKFLOW_V2_SCHEMA_IDS,
  workflowV2SchemaRegistry,
} = await import("../services/devbench/workflow-v2/schema-registry.js");
const {
  buildLegacyEvidenceManifest,
} = await import("../services/devbench/workflow-v2/compatibility-dispatch.js");
const { closeAppMarketMcpBridge } = await import("../services/appmarket-admin-mcp.js");

after(async () => {
  try { await closeAppMarketMcpBridge(); } catch {}
  if (sqlite.default?.open) sqlite.default.close();
  assert.equal(sqlite.default?.open, false, "测试 SQLite 连接未关闭");
  const cleanupTarget = process.platform === "win32" ? path.toNamespacedPath(tempRoot) : tempRoot;
  await fs.promises.rm(cleanupTarget, {
    recursive: true,
    force: true,
    maxRetries: 20,
    retryDelay: 50,
  });
  assert.equal(fs.existsSync(tempRoot), false, "structured sendTurn 临时目录未清理");
});

const SUCCESS_SENTINEL = "RAW_STRUCTURED_SUCCESS_MUST_ONLY_EXIST_IN_STAGE_RESULT";
const MISSING_RECEIPT_SENTINEL = "RAW_STRUCTURED_MISSING_RECEIPT_MUST_STAY_INTERNAL";
const MALFORMED_SENTINEL = "RAW_STRUCTURED_MALFORMED_MUST_STAY_INTERNAL";

function git(args, cwd) {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

function sha256(value) {
  return createHash("sha256").update(String(value), "utf8").digest("hex");
}

function finishStageResponse(argumentsText) {
  const encoder = new TextEncoder();
  const events = [
    {
      choices: [{
        delta: {
          tool_calls: [{
            index: 0,
            id: "finish-stage-triage",
            type: "function",
            function: { name: "finish_stage", arguments: "" },
          }],
        },
      }],
    },
    {
      choices: [{
        delta: {
          tool_calls: [{
            index: 0,
            function: { arguments: argumentsText },
          }],
        },
      }],
    },
    { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
  ];
  return {
    ok: true,
    status: 200,
    body: new ReadableStream({
      start(controller) {
        for (const event of events) controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      },
    }),
    text: async () => "",
    json: async () => ({}),
  };
}

function tbResponse() {
  const data = {
    _id: "tb-structured-send-turn",
    isDone: true,
    taskflowstatus: { _id: "status-completed", name: "已完成" },
  };
  return {
    ok: true,
    status: 200,
    body: null,
    text: async () => JSON.stringify(data),
    json: async () => structuredClone(data),
  };
}

function extractTaggedJson(prompt, tagName) {
  const match = new RegExp(`<${tagName}>([\\s\\S]*?)</${tagName}>`).exec(String(prompt));
  assert.ok(match, `Provider prompt must contain ${tagName}`);
  return JSON.parse(match[1]);
}

function providerPrompt(body) {
  const message = (body.messages || []).find((entry) => entry.role === "user");
  assert.equal(typeof message?.content, "string");
  return message.content;
}

function makeTriageResult(context, receiptIdsByEvidenceId, sentinel) {
  const readEvidence = context.data.evidenceManifest.items.filter((item) => item.availability === "AVAILABLE");
  assert.ok(readEvidence.length >= 2, "fixture must provide two independent evidence types");
  assert.ok(new Set(readEvidence.map((item) => item.type)).size >= 2);
  return {
    schemaVersion: "triage-result-v2",
    contextId: context.contextId,
    contextRevision: context.revision,
    idempotencyKey: context.idempotencyKey,
    status: "COMPLETED",
    classification: "CLIENT_ISSUE",
    confidence: "HIGH",
    rootCause: {
      symptom: "点击入口后页面状态未更新",
      trigger: "打开测试入口",
      observedBehavior: "客户端停留在旧状态",
      directCause: sentinel,
      faultOwner: "客户端",
      workaroundOwner: "客户端",
    },
    claims: [{
      text: "TB 字段与独立评论共同证明客户端状态边界遗漏",
      status: "SUPPORTED",
      evidenceFor: readEvidence.map((item) => item.evidenceId),
      evidenceAgainst: [],
    }],
    evidenceRead: readEvidence.map((item) => ({
      evidenceId: item.evidenceId,
      receiptIds: [receiptIdsByEvidenceId[item.evidenceId]],
      finding: `已读取冻结证据 ${item.type}`,
    })),
    evidenceUnread: [],
    recommendedAction: "进入修复阶段",
    userSummary: "已确认客户端存在边界判断缺失",
    nextStage: "REPAIR",
  };
}

async function waitFor(predicate, message, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await predicate();
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(message);
}

function createStoryFixture({ repo, projectId, suffix }) {
  const worktree = fs.mkdtempSync(path.join(tempRoot, `worktree-${suffix}-`));
  git(["worktree", "add", "-q", "-b", `story-structured-${suffix}`, worktree], repo);
  const created = store.createTab({ title: `Structured ${suffix}` });
  const tab = store.updateTab(created.id, {
    primaryProjectId: projectId,
    engine: "deepseek",
    worktreeStatus: "ready",
    worktree: {
      version: 1,
      managed: true,
      root: worktree,
      entries: [{
        role: "primary",
        active: true,
        baseProjectId: projectId,
        name: "Workflow v2 Structured Integration",
        basePath: repo,
        path: worktree,
        worktreePath: worktree,
        branch: `story-structured-${suffix}`,
      }],
    },
    tbTaskId: `tb-structured-${suffix}`,
    ticketUrl: "https://www.teambition.com/task/0123456789abcdef01234567",
    tbContext: {
      tbTaskId: `tb-structured-${suffix}`,
      title: `Structured ${suffix} title`,
      description: `Structured ${suffix} description`,
      comments: [{
        id: `comment-${suffix}`,
        text: `Structured ${suffix} independent comment evidence`,
        updatedAt: "2026-08-07T07:59:00.000Z",
      }],
      attachments: [],
      sourceCoverage: {
        comments: { available: true, complete: true },
        attachments: { available: true, complete: true },
      },
    },
    workflow: { enabled: true, phase: "triaging", autoMode: "semi", riskLevel: "MEDIUM" },
    cliSessionId: "legacy-resume-must-not-be-used",
    cliSessionIds: { deepseek: "legacy-resume-must-not-be-used" },
  });
  return { tab, worktree };
}

async function appendReadReceiptsForContext(tab, context, prefix) {
  const manifest = buildLegacyEvidenceManifest(tab);
  assert.deepEqual(manifest, context.data.evidenceManifest, "receipt fixture must bind the frozen manifest");
  const available = manifest.items.filter((item) => item.availability === "AVAILABLE");
  const receiptIdsByEvidenceId = {};
  for (const [index, item] of available.entries()) {
    const receiptId = `${prefix}-${index + 1}`;
    const payload = {
      schemaVersion: "evidence-receipt-v2",
      receiptId,
      evidenceId: item.evidenceId,
      action: "READ",
      status: "PASS",
      selector: {
        contextId: context.contextId,
        contextRevision: context.revision,
      },
      startedAt: "2026-08-07T08:00:00.000Z",
      finishedAt: "2026-08-07T08:00:01.000Z",
      toolName: "structured-send-turn-fixture",
      operationId: `operation-${receiptId}`,
      idempotencyKey: null,
      summary: `已读取冻结证据 ${item.evidenceId}`,
    };
    const appended = await appendEvidenceReceipt({
      tab,
      revision: index + 1,
      idempotencyKey: `receipt-envelope-${receiptId}`,
      operationArgs: { source: item.type, evidenceId: item.evidenceId },
      payload,
    });
    assert.equal(appended.replayed, false);
    assert.equal(appended.envelope.payloadSha256, canonicalSha256(payload));
    receiptIdsByEvidenceId[item.evidenceId] = receiptId;
  }
  return receiptIdsByEvidenceId;
}

function rawResultMustNotLeak({ sentinel, tab, taskId, wsEvents }) {
  const conversation = store.getConversation(tab.id);
  const archive = tab.archiveFile && fs.existsSync(tab.archiveFile)
    ? fs.readFileSync(tab.archiveFile, "utf8")
    : "";
  const taskRow = sqlite.getTask(taskId);
  assert.ok(taskRow, "task DB row must exist");
  assert.doesNotMatch(JSON.stringify(conversation), new RegExp(sentinel));
  assert.doesNotMatch(archive, new RegExp(sentinel));
  assert.doesNotMatch(JSON.stringify(wsEvents), new RegExp(sentinel));
  assert.doesNotMatch(String(taskRow.result || ""), new RegExp(sentinel));
  return { conversation, archive, taskRow };
}

test("structured sendTurn 真实 API mock：冻结合同、安全适配与 receipt 门禁端到端 fail closed", async () => {
  const repo = fs.mkdtempSync(path.join(tempRoot, "repo-"));
  git(["init", "-q", "-b", "main"], repo);
  git(["config", "user.email", "test@example.com"], repo);
  git(["config", "user.name", "Test"], repo);
  fs.writeFileSync(path.join(repo, "README.md"), "workflow v2 structured integration\n", "utf8");
  git(["add", "README.md"], repo);
  git(["commit", "-q", "-m", "init"], repo);

  const projectId = "workflow-v2-structured-send-turn-project";
  assert.equal(store.upsertProject({
    id: projectId,
    name: "Workflow v2 Structured Integration",
    path: repo,
  }).ok, true);

  const fixtures = [
    createStoryFixture({ repo, projectId, suffix: "success" }),
    createStoryFixture({ repo, projectId, suffix: "malformed" }),
    createStoryFixture({ repo, projectId, suffix: "missing-receipt" }),
  ];
  const [successFixture, malformedFixture, missingReceiptFixture] = fixtures;
  const scenarioByStoryId = new Map([
    [successFixture.tab.id, { kind: "success", tab: successFixture.tab }],
    [malformedFixture.tab.id, { kind: "malformed" }],
    [missingReceiptFixture.tab.id, { kind: "missing_receipt" }],
  ]);
  const providerCalls = [];
  const wsEvents = [];
  const mockClient = {
    readyState: 1,
    subscribedSessions: new Set(),
    send(message) { wsEvents.push(JSON.parse(message)); },
  };
  logger.setWsClients(new Set([mockClient]));
  const originalFetch = global.fetch;
  global.fetch = async (url, options = {}) => {
    if (!/workflow-v2-structured-provider\.invalid/.test(String(url))) return tbResponse();
    const body = JSON.parse(String(options.body || "{}"));
    const prompt = providerPrompt(body);
    const context = extractTaggedJson(prompt, "STAGE_CONTEXT_JSON");
    const scenario = scenarioByStoryId.get(context.story.storyId);
    assert.ok(scenario, `unexpected story in Provider prompt: ${context.story.storyId}`);
    providerCalls.push({ body: structuredClone(body), prompt, context, scenario: scenario.kind });
    if (scenario.kind === "malformed") {
      return finishStageResponse(`{"sentinel":"${MALFORMED_SENTINEL}"`);
    }
    const sentinel = scenario.kind === "success" ? SUCCESS_SENTINEL : MISSING_RECEIPT_SENTINEL;
    const receiptIdsByEvidenceId = scenario.kind === "success"
      ? await appendReadReceiptsForContext(scenario.tab, context, "receipt-structured-success")
      : Object.fromEntries(context.data.evidenceManifest.items.map((item, index) => (
        [item.evidenceId, `receipt-does-not-exist-${index + 1}`]
      )));
    return finishStageResponse(JSON.stringify(makeTriageResult(context, receiptIdsByEvidenceId, sentinel)));
  };

  try {
    const successWsStart = wsEvents.length;
    const successStarted = await sendTurnWithDeviceRuntime(
      store.getTab(successFixture.tab.id),
      "请使用结构化结果甄别当前问题",
      { workflowKind: "triage" },
    );
    assert.ok(successStarted.taskId, successStarted.error || "structured success turn should start");
    const successTab = await waitFor(
      () => {
        const value = store.getTab(successFixture.tab.id);
        return !value?.runningTaskId && value?.workflowV2Compatibility?.settlement?.status === "settled"
          ? value
          : null;
      },
      "structured result did not settle TRIAGE to REPAIR",
    );
    assert.equal(successTab.workflow.phase, "fixing");
    assert.equal(successTab.cliSessionId, null);

    const successCall = providerCalls.find((entry) => entry.scenario === "success");
    assert.ok(successCall);
    const terminalTools = successCall.body.tools.filter((tool) => ["finish_stage", "finish_task"].includes(tool.function?.name));
    assert.deepEqual(terminalTools.map((tool) => tool.function.name), ["finish_stage"]);
    const frozenSchema = workflowV2SchemaRegistry.getSchemaDocument(WORKFLOW_V2_SCHEMA_IDS.triageResult);
    assert.deepEqual(terminalTools[0].function.parameters, frozenSchema);
    assert.deepEqual(extractTaggedJson(successCall.prompt, "RESULT_SCHEMA_JSON"), frozenSchema);

    const contexts = await readWorkflowV2Envelopes({
      tab: successTab,
      payloadSchemaId: WORKFLOW_V2_SCHEMA_IDS.stageContext,
    });
    assert.equal(contexts.length, 1);
    assert.deepEqual(successCall.context, contexts[0].payload, "Provider must receive the immutable stored StageContext");
    assert.equal(successCall.context.output.schemaId, WORKFLOW_V2_SCHEMA_IDS.triageResult);

    const successConversation = store.getConversation(successTab.id);
    const successUser = successConversation.nodes.find((node) => (
      node.role === "user" && node.content === "请使用结构化结果甄别当前问题"
    ));
    assert.ok(successUser);
    assert.equal(successUser.aiPrompt, successCall.prompt);
    assert.equal(successUser.aiPromptTelemetry.promptMode, "structured");
    assert.equal(successUser.aiPromptTelemetry.contextId, successCall.context.contextId);
    assert.equal(successUser.aiPromptTelemetry.contextRevision, successCall.context.revision);
    assert.equal(successUser.aiPromptTelemetry.schemaId, WORKFLOW_V2_SCHEMA_IDS.triageResult);
    assert.equal(successUser.aiPromptTelemetry.idempotencyKey, successCall.context.idempotencyKey);
    assert.equal(successUser.aiPromptTelemetry.sha256, sha256(successCall.prompt));

    const stageResults = await readWorkflowV2Envelopes({
      tab: successTab,
      payloadSchemaId: WORKFLOW_V2_SCHEMA_IDS.stageResultRecord,
    });
    assert.equal(stageResults.length, 1);
    const stageResult = stageResults[0].payload;
    assert.equal(stageResult.stageId, "TRIAGE");
    assert.equal(stageResult.resultSchemaId, WORKFLOW_V2_SCHEMA_IDS.triageResult);
    assert.equal(stageResult.contextId, successCall.context.contextId);
    assert.equal(stageResult.contextRevision, successCall.context.revision);
    assert.equal(stageResult.contextIdempotencyKey, successCall.context.idempotencyKey);
    assert.equal(stageResult.resultSha256, canonicalSha256(stageResult.result));
    assert.equal(stageResult.result.rootCause.directCause, SUCCESS_SENTINEL);

    const successAssistant = successConversation.nodes.find((node) => (
      node.role === "assistant" && node.taskId === successStarted.taskId
    ));
    assert.ok(successAssistant);
    assert.equal(successAssistant.content, "甄别完成：判定为本侧问题。说明：已确认客户端存在边界判断缺失。");
    assert.equal(successAssistant.workflowKind, "triage");
    assert.match(successAssistant.triageAnalysisReport, /^## 初步问题分析/m);
    assert.match(successAssistant.triageAnalysisReport, /初步分析：已确认客户端存在边界判断缺失/);
    assert.match(successAssistant.triageAnalysisReport, /后续建议：进入修复阶段/);
    assert.match(successAssistant.triageAnalysisReport, /尚未执行修复、测试或验收/);
    assert.deepEqual(successAssistant.transcript || [], []);
    assert.doesNotMatch(successAssistant.content, /[{}\[\]]|<!--|\bNEXT\b|RAW_STRUCTURED/);
    assert.ok(successTab.archiveFile && fs.existsSync(successTab.archiveFile), "safe adapter answer must be archived");
    const successChannels = rawResultMustNotLeak({
      sentinel: SUCCESS_SENTINEL,
      tab: successTab,
      taskId: successStarted.taskId,
      wsEvents: wsEvents.slice(successWsStart),
    });
    assert.equal(successChannels.taskRow.status, "completed");
    assert.doesNotMatch(String(successChannels.taskRow.result || ""), /"structuredResult"/);
    const successChatEvent = wsEvents.slice(successWsStart).find((event) => (
      event.type === "chat_message" && event.data?.task_id === successStarted.taskId
    ));
    assert.equal(successChatEvent?.data?.content, successAssistant.content);
    assert.deepEqual(successChatEvent?.data?.transcript || [], []);
    const successTextStreams = wsEvents.slice(successWsStart).filter((event) => (
      event.type === "chat_stream" && ["text", "thinking"].includes(event.data?.deltaType)
    ));
    assert.deepEqual(successTextStreams, [], "structured Provider text/thinking must not stream to chat");

    const callsBeforeBlockedRepair = providerCalls.length;
    const blockedRepair = await sendTurnWithDeviceRuntime(
      store.getTab(successFixture.tab.id),
      "继续执行结构化修复",
      { workflowKind: "repair" },
    );
    assert.equal(blockedRepair.code, "WORKFLOW_V2_RECEIPT_CONFINED_EXECUTOR_UNAVAILABLE");
    assert.equal(blockedRepair.taskId, undefined);
    assert.equal(
      providerCalls.length,
      callsBeforeBlockedRepair,
      "missing attested executor must stop before any Provider request",
    );

    const configWithProfile = getConfig();
    updateConfig({
      workflowV2: {
        ...configWithProfile.workflowV2,
        activeExecutionProfileId: "profile-does-not-exist",
        executionProfiles: [],
      },
    });
    try {
      const callsBeforeMissingProfile = providerCalls.length;
      const missingProfile = await sendTurnWithDeviceRuntime(
        store.getTab(successFixture.tab.id),
        "缺少 profile 时不得调用 Provider",
        { workflowKind: "repair" },
      );
      assert.equal(missingProfile.code, "WORKFLOW_V2_EXECUTION_PROFILE_BLOCKED");
      assert.equal(providerCalls.length, callsBeforeMissingProfile);
    } finally {
      updateConfig({ workflowV2: configWithProfile.workflowV2 });
    }

    const malformedWsStart = wsEvents.length;
    const malformedStarted = await sendTurnWithDeviceRuntime(
      store.getTab(malformedFixture.tab.id),
      "返回 malformed structured JSON",
      { workflowKind: "triage" },
    );
    assert.ok(malformedStarted.taskId, malformedStarted.error || "malformed structured turn should start");
    const malformedTab = await waitFor(
      () => {
        const value = store.getTab(malformedFixture.tab.id);
        return !value?.runningTaskId && sqlite.getTask(malformedStarted.taskId)?.status === "failed" ? value : null;
      },
      "malformed finish_stage arguments did not fail closed",
    );
    assert.equal(malformedTab.workflow.phase, "triaging");
    const malformedResults = await readWorkflowV2Envelopes({
      tab: malformedTab,
      payloadSchemaId: WORKFLOW_V2_SCHEMA_IDS.stageResultRecord,
    });
    assert.deepEqual(malformedResults, []);
    const malformedChannels = rawResultMustNotLeak({
      sentinel: MALFORMED_SENTINEL,
      tab: malformedTab,
      taskId: malformedStarted.taskId,
      wsEvents: wsEvents.slice(malformedWsStart),
    });
    assert.equal(malformedChannels.taskRow.status, "failed");
    assert.match(
      malformedChannels.conversation.nodes.find((node) => (
        node.role === "assistant" && node.taskId === malformedStarted.taskId
      ))?.content || "",
      /finish_stage arguments 不是合法 JSON object/,
    );

    const missingWsStart = wsEvents.length;
    const missingStarted = await sendTurnWithDeviceRuntime(
      store.getTab(missingReceiptFixture.tab.id),
      "返回缺少 receipt 的 structured 结果",
      { workflowKind: "triage" },
    );
    assert.ok(missingStarted.taskId, missingStarted.error || "missing receipt turn should start");
    const missingTab = await waitFor(
      () => {
        const value = store.getTab(missingReceiptFixture.tab.id);
        return !value?.runningTaskId && value?.workflowV2Compatibility?.settlement?.status === "blocked"
          ? value
          : null;
      },
      "missing receipt result did not settle as blocked",
    );
    assert.equal(missingTab.workflow.phase, "triaging");
    assert.equal(
      missingTab.workflowV2Compatibility.settlement.code,
      "WORKFLOW_V2_STRUCTURED_RECEIPT_NOT_FOUND",
    );
    const missingResults = await readWorkflowV2Envelopes({
      tab: missingTab,
      payloadSchemaId: WORKFLOW_V2_SCHEMA_IDS.stageResultRecord,
    });
    assert.equal(missingResults.length, 1, "schema-valid blocked Provider result remains in immutable audit stream");
    assert.equal(missingResults[0].payload.result.rootCause.directCause, MISSING_RECEIPT_SENTINEL);
    const missingChannels = rawResultMustNotLeak({
      sentinel: MISSING_RECEIPT_SENTINEL,
      tab: missingTab,
      taskId: missingStarted.taskId,
      wsEvents: wsEvents.slice(missingWsStart),
    });
    assert.equal(missingChannels.taskRow.status, "completed", "Provider transport succeeded before receipt gate blocked advancement");
    assert.doesNotMatch(String(missingChannels.taskRow.result || ""), /"structuredResult"/);
    const missingAssistant = missingChannels.conversation.nodes.find((node) => (
      node.role === "assistant" && node.taskId === missingStarted.taskId
    ));
    assert.equal(missingAssistant?.content, "结构化阶段结果未通过安全校验。");
    assert.deepEqual(missingAssistant?.transcript || [], []);
  } finally {
    global.fetch = originalFetch;
    logger.setWsClients(new Set());
    try { await closeAppMarketMcpBridge(); } catch {}
    for (const fixture of fixtures) {
      try { git(["worktree", "remove", "--force", fixture.worktree], repo); } catch {}
    }
    try { git(["worktree", "prune"], repo); } catch {}
  }
});
