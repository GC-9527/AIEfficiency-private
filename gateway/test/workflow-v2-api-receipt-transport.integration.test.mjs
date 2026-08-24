import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "workflow-v2-api-receipt-"));
const projectRoot = path.join(tempRoot, "project");
const storyRoot = path.join(tempRoot, "story");
fs.mkdirSync(projectRoot, { recursive: true });
fs.mkdirSync(storyRoot, { recursive: true });
fs.writeFileSync(path.join(projectRoot, "target.txt"), "before", "utf8");

process.env.NODE_ENV = "test";
process.env.GATEWAY_CONFIG_PATH = path.join(tempRoot, "gateway-config.json");
fs.writeFileSync(process.env.GATEWAY_CONFIG_PATH, JSON.stringify({
  apiMaxToolIterations: 6,
  apiAgent: { workspaceIsolation: true, commandPolicy: "workspace" },
  apiEngines: {
    deepseek: {
      enabled: true,
      name: "DeepSeek",
      baseUrl: "https://deepseek.invalid",
      apiKey: "test-only-key",
      model: "deepseek-test",
    },
  },
}), "utf8");

let apiEngine;
let compilePolicy;
let buildRecorder;
let canonicalSha256;
let evaluateStructuredWorkflowResult;
let evidenceReceiptSchemaId;
let validateCompatibilityWorkflowEvidence;
const originalFetch = global.fetch;

const receiptStorageApi = {
  getStoryStoragePaths: () => ({ storyDirectory: storyRoot }),
  validateStoryStorageTarget: (_tab, targetPath, {
    baseDirectory = storyRoot,
    createDirectory = false,
    mustExist = false,
    expectedType = "",
  } = {}) => {
    const base = path.resolve(baseDirectory);
    const target = path.resolve(targetPath);
    const relative = path.relative(base, target);
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error("path escape");
    let current = base;
    for (const segment of relative.split(path.sep).filter(Boolean)) {
      current = path.join(current, segment);
      if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) throw new Error("symlink target");
    }
    if (createDirectory && !fs.existsSync(target)) fs.mkdirSync(target);
    if (mustExist && !fs.existsSync(target)) throw new Error("missing target");
    if (fs.existsSync(target)) {
      const stat = fs.lstatSync(target);
      if (stat.isSymbolicLink()) throw new Error("symlink leaf");
      if (expectedType === "directory" && !stat.isDirectory()) throw new Error("not directory");
      if (expectedType === "file" && !stat.isFile()) throw new Error("not file");
    }
    return target;
  },
};

function deepFreeze(value, seen = new Set()) {
  if (!value || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
}

function sse(toolCalls) {
  const encoder = new TextEncoder();
  const events = [];
  toolCalls.forEach((call, index) => {
    events.push({ choices: [{ delta: { tool_calls: [{ index, id: call.id, type: "function", function: { name: call.name, arguments: "" } }] } }] });
    events.push({ choices: [{ delta: { tool_calls: [{ index, function: { arguments: JSON.stringify(call.args) } }] } }] });
  });
  events.push({ choices: [{ delta: {}, finish_reason: "tool_calls" }] });
  const body = new ReadableStream({
    start(controller) {
      for (const event of events) controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      controller.close();
    },
  });
  return { ok: true, body, text: async () => "", json: async () => ({}) };
}

function context(taskId) {
  return {
    schemaVersion: "tb-stage-context-v2",
    contextId: "ctx-api-repair",
    revision: 1,
    idempotencyKey: "repair:1",
    story: { storyId: "story-api-repair", ticketId: "t-1", carbId: null, title: "API receipt", groupId: null },
    stage: { id: "REPAIR", attempt: 1, riskLevel: "MEDIUM" },
    task: { instruction: "edit and test", successCriteria: ["pass"], userVisibleGoal: "repair" },
    scope: {
      roots: [{ rootId: "main", kind: "MAIN", projectId: "p-1", branch: null, flavor: null, versionName: null, writable: true }],
      protectedPaths: [".git/**", "AGENTS.md", "CLAUDE.md"],
      tempRootId: "main",
      deviceProfileId: null,
    },
    capabilities: {
      allowedTools: ["apply_patch", "edit_file", "git_diff", "git_inspect", "git_status", "list_dir", "read_file", "run_local_check", "search_files"],
      canWriteSource: true,
      canReadGit: true,
      canWriteGit: false,
      canCommit: false,
      canUseDevice: false,
      canWriteTb: false,
      canWriteReport: false,
      maxToolIterations: 24,
      longProcessProtocol: "NONE",
    },
    checkpoint: { ref: "storydev:/workflow-v2/checkpoint/1" },
    output: { schemaId: "https://example.local/schemas/repair-result-v2.json", maxChars: null, outputPath: null },
    data: {
      localChecks: [{
        checkId: "check-api",
        name: "API unit test",
        executorId: "exec-api",
        action: "TEST",
        mandatory: true,
        rootId: "main",
      }],
    },
    _taskId: taskId,
  };
}

before(async () => {
  ({ executeApiEngine: apiEngine } = await import("../services/api-engine.js"));
  ({ compileWorkflowV2StageToolPolicy: compilePolicy } = await import("../services/devbench/workflow-v2/stage-tool-policy.js"));
  ({ buildStageReceiptRecorder: buildRecorder } = await import("../services/devbench/workflow-v2/receipt-producer.js"));
  ({ canonicalSha256 } = await import("../services/devbench/workflow-v2/envelope-store.js"));
  ({ evaluateStructuredWorkflowResult } = await import("../services/devbench/workflow-v2/structured-result-gate.js"));
  ({ validateCompatibilityWorkflowEvidence } = await import("../services/devbench/workflow-v2/compatibility-evidence-gate.js"));
  ({ WORKFLOW_V2_SCHEMA_IDS: { evidenceReceipt: evidenceReceiptSchemaId } } = await import("../services/devbench/workflow-v2/schema-registry.js"));
});

after(() => {
  global.fetch = originalFetch;
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

test("structured local API edit and check return only Gateway-produced receipt identities", async () => {
  const taskId = "task-api-repair";
  const frozenContext = context(taskId);
  delete frozenContext._taskId;
  const policy = compilePolicy({
    context: frozenContext,
    storyId: "story-api-repair",
    taskId,
    contextHash: canonicalSha256(frozenContext),
    rootBindings: [{ rootId: "main", realRoot: projectRoot }],
  });
  const executionProfile = deepFreeze({
    schemaVersion: "workflow-v2-execution-profile-v1",
    profileId: "profile-api",
    rootId: "main",
    stageId: "REPAIR",
    executors: [{
      executorId: "exec-api",
      action: "TEST",
      argv: ["test-runner", "--frozen"],
      cwdRootId: "main",
      timeoutMs: 10_000,
    }],
  });
  const receipts = [];
  const executionStatus = deepFreeze({ status: "READY", profileId: executionProfile.profileId, blockers: [] });
  const executionProfileSha256 = canonicalSha256({
    executionProfile,
    status: executionStatus.status,
    profileId: executionStatus.profileId,
    blockers: executionStatus.blockers,
  });
  const recorder = buildRecorder({
    tab: { id: "story-api-repair" },
    dispatch: deepFreeze({
      contextId: frozenContext.contextId,
      contextRevision: frozenContext.revision,
      context: frozenContext,
      executionProfile,
      executionStatus,
      executionProfileSha256,
      evidenceSnapshots: [],
    }),
    executionProfile,
    storageApi: receiptStorageApi,
    readEnvelopes: async () => [...receipts],
    appendReceipt: async ({ revision, idempotencyKey, operationArgs, payload }) => {
      const operationArgsSha256 = canonicalSha256({
        action: payload.action,
        toolName: payload.toolName,
        rootId: payload.rootId ?? null,
        selector: payload.selector ?? null,
        operationArgs,
      });
      const unsigned = {
        schemaVersion: "workflow-envelope-v2",
        storyId: "story-api-repair",
        recordId: payload.receiptId,
        contextId: null,
        revision,
        idempotencyKey,
        payloadSchemaId: evidenceReceiptSchemaId,
        payloadSha256: canonicalSha256(payload),
        operationArgsSha256,
        previousEnvelopeSha256: receipts.at(-1)?.envelopeSha256 || null,
        createdAt: "2026-08-08T08:00:00.000Z",
        payload,
      };
      const envelope = { ...unsigned, envelopeSha256: canonicalSha256(unsigned), operationArgs };
      receipts.push(envelope);
      return { replayed: false, envelope };
    },
    runProcess: async ({ argv }) => {
      assert.deepEqual(argv, ["test-runner", "--frozen"]);
      return { exitCode: 0, timedOut: false, stdout: "1 passed", stderr: "" };
    },
    now: () => "2026-08-08T08:00:00.000Z",
  });

  const requests = [];
  let round = 0;
  global.fetch = async (_url, options) => {
    requests.push(JSON.parse(options.body));
    round += 1;
    if (round === 1) {
      return sse([{ id: "edit", name: "edit_file", args: {
        rootId: "main",
        path: "target.txt",
        old_string: "before",
        new_string: "after",
      } }]);
    }
    if (round === 2) return sse([{ id: "check", name: "run_local_check", args: { rootId: "main", checkId: "check-api" } }]);
    return sse([{ id: "finish", name: "finish_stage", args: { done: true } }]);
  };

  const descriptor = {
    mode: "structured",
    strategy: "finish_stage",
    schemaId: frozenContext.output.schemaId,
    schema: {
      type: "object",
      additionalProperties: false,
      properties: { done: { type: "boolean" } },
      required: ["done"],
    },
    contextId: frozenContext.contextId,
    contextRevision: frozenContext.revision,
    idempotencyKey: frozenContext.idempotencyKey,
  };
  const result = await apiEngine(
    "deepseek",
    "edit and verify",
    taskId,
    null,
    null,
    {
      cwd: projectRoot,
      stageToolPolicy: policy,
      stageReceiptRecorder: recorder,
    },
    {
      structuredOutput: descriptor,
      telemetryContext: {
        promptMode: "structured",
        contextId: descriptor.contextId,
        contextRevision: descriptor.contextRevision,
        schemaId: descriptor.schemaId,
        idempotencyKey: descriptor.idempotencyKey,
      },
    },
  );

  assert.deepEqual(result.structuredResult, { done: true });
  assert.equal(fs.readFileSync(path.join(projectRoot, "target.txt"), "utf8"), "after");
  assert.deepEqual(receipts.map((entry) => entry.payload.action), ["EDIT", "TEST"]);
  const secondRequest = JSON.stringify(requests[1].messages);
  const thirdRequest = JSON.stringify(requests[2].messages);
  assert.match(secondRequest, /gateway-edit-[a-f0-9]{32}/);
  assert.match(thirdRequest, /gateway-test-[a-f0-9]{32}/);
  assert.doesNotMatch(thirdRequest, /test-runner/);

  const gateDispatch = deepFreeze({
    promptMode: "structured",
    stageId: "REPAIR",
    resultSchemaId: descriptor.schemaId,
    contextId: frozenContext.contextId,
    contextRevision: frozenContext.revision,
    context: frozenContext,
    executionStatus,
    executionProfile,
    executionProfileSha256,
    structuredOutput: descriptor,
  });
  const editReceipt = receipts.find((entry) => entry.payload.action === "EDIT").payload;
  const checkReceipt = receipts.find((entry) => entry.payload.action === "TEST").payload;
  const gated = await evaluateStructuredWorkflowResult({
    dispatch: gateDispatch,
    tab: { id: "story-api-repair" },
    rawResult: {
      schemaVersion: "repair-result-v2",
      contextId: frozenContext.contextId,
      contextRevision: frozenContext.revision,
      idempotencyKey: frozenContext.idempotencyKey,
      status: "COMPLETED",
      outcome: "FIXED",
      rootCause: "verified test defect",
      changes: [{ rootId: "main", path: "target.txt", summary: "updated target", receiptIds: [editReceipt.receiptId] }],
      localChecks: [{ name: "API unit test", status: "PASS", receiptIds: [checkReceipt.receiptId] }],
      risks: [],
      remaining: [],
      userFriendlyCause: "旧内容错误",
      userFriendlyMeasure: "已更新并测试",
      changeSummary: "更新 target.txt",
      evidenceRead: [],
      evidenceUnread: [],
      nextStage: "LOCAL_GATE",
      summary: "修复和测试均通过",
    },
    readEnvelopes: async () => receipts.map(({ operationArgs: _operationArgs, ...envelope }) => envelope),
    storageApi: receiptStorageApi,
  });
  assert.equal(gated.ok, true, `${gated.code}: ${gated.error}`);
  assert.equal(gated.legacyEvent.kind, "fix_done");

  const persistedEnvelopes = receipts.map(({ operationArgs: _operationArgs, ...envelope }) => envelope);
  const compatibilityPass = await validateCompatibilityWorkflowEvidence({
    tab: { id: "story-api-repair" },
    dispatch: gateDispatch,
    markerKind: "fix_done",
    readEnvelopes: async () => persistedEnvelopes,
    storageApi: receiptStorageApi,
  });
  assert.equal(compatibilityPass.ok, true, compatibilityPass.error);

  const outputPath = path.join(
    storyRoot,
    ...checkReceipt.outputRef.slice("storydev:/".length).split("/"),
  );
  fs.writeFileSync(outputPath, "tampered after the signed receipt", "utf8");
  const structuredTamper = await evaluateStructuredWorkflowResult({
    dispatch: gateDispatch,
    tab: { id: "story-api-repair" },
    rawResult: gated.result,
    readEnvelopes: async () => persistedEnvelopes,
    storageApi: receiptStorageApi,
  });
  assert.equal(structuredTamper.ok, false);
  assert.equal(structuredTamper.code, "WORKFLOW_V2_STRUCTURED_RECEIPT_OUTPUT_INVALID");
  const compatibilityTamper = await validateCompatibilityWorkflowEvidence({
    tab: { id: "story-api-repair" },
    dispatch: gateDispatch,
    markerKind: "fix_done",
    readEnvelopes: async () => persistedEnvelopes,
    storageApi: receiptStorageApi,
  });
  assert.equal(compatibilityTamper.ok, false);
  assert.equal(compatibilityTamper.code, "WORKFLOW_V2_COMPATIBILITY_RECEIPT_OUTPUT_INVALID");

  fs.rmSync(outputPath);
  const structuredMissing = await evaluateStructuredWorkflowResult({
    dispatch: gateDispatch,
    tab: { id: "story-api-repair" },
    rawResult: gated.result,
    readEnvelopes: async () => persistedEnvelopes,
    storageApi: receiptStorageApi,
  });
  assert.equal(structuredMissing.code, "WORKFLOW_V2_STRUCTURED_RECEIPT_OUTPUT_INVALID");
  const compatibilityMissing = await validateCompatibilityWorkflowEvidence({
    tab: { id: "story-api-repair" },
    dispatch: gateDispatch,
    markerKind: "fix_done",
    readEnvelopes: async () => persistedEnvelopes,
    storageApi: receiptStorageApi,
  });
  assert.equal(compatibilityMissing.code, "WORKFLOW_V2_COMPATIBILITY_RECEIPT_OUTPUT_INVALID");
});

test("structured remote target fails before provider or remote tool execution", async () => {
  let fetched = false;
  global.fetch = async () => { fetched = true; throw new Error("must not fetch"); };
  await assert.rejects(
    apiEngine(
      "deepseek",
      "remote structured",
      "task-remote-structured",
      null,
      { host: "http://remote.invalid", root: "D:/remote" },
      { cwd: projectRoot },
      {
        structuredOutput: {
          mode: "structured",
          strategy: "finish_stage",
          schemaId: "urn:test:remote",
          schema: { type: "object" },
          contextId: "ctx-remote",
          contextRevision: 1,
          idempotencyKey: "remote:1",
        },
        telemetryContext: {
          promptMode: "structured",
          contextId: "ctx-remote",
          contextRevision: 1,
          schemaId: "urn:test:remote",
          idempotencyKey: "remote:1",
        },
      },
    ),
    (error) => error.code === "WORKFLOW_V2_STRUCTURED_REMOTE_EXECUTION_UNSUPPORTED",
  );
  assert.equal(fetched, false);
});
