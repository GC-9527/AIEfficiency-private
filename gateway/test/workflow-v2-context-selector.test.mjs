import { after, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "workflow-v2-context-selector-"));
const cloneParent = path.join(tempRoot, "clone-parent");
const marketConfig = path.join(tempRoot, "market.json");
const localProjects = path.join(tempRoot, "local", "devbench-projects.json");
fs.mkdirSync(cloneParent, { recursive: true });
fs.mkdirSync(path.dirname(localProjects), { recursive: true });
fs.writeFileSync(marketConfig, "{}", "utf8");
fs.writeFileSync(localProjects, JSON.stringify({
  version: 4,
  cloneParent,
  projects: [],
}), "utf8");
process.env.DEVBENCH_CONFIG_PATH = marketConfig;
process.env.DEVBENCH_LOCAL_PROJECTS_PATH = localProjects;
process.env.DEVBENCH_STORE_DIR = path.join(tempRoot, "devbench-store");
process.env.GATEWAY_CONFIG_PATH = path.join(tempRoot, "gateway.json");
process.env.GATEWAY_DB_PATH = path.join(tempRoot, "gateway.db");
process.env.AIEFFICIENCY_CLONE_PARENT = cloneParent;
fs.mkdirSync(process.env.DEVBENCH_STORE_DIR, { recursive: true });
fs.writeFileSync(process.env.GATEWAY_CONFIG_PATH, "{}", "utf8");

const selectorModuleUrl = new URL("../services/devbench/workflow-v2/context-selector.js", import.meta.url);
const selector = await import(selectorModuleUrl);
const workflow = await import("../services/devbench/workflow-v2/envelope-store.js");
const { default: gatewayDatabase } = await import("../db/sqlite.js");
const { WORKFLOW_V2_SCHEMA_IDS, workflowV2SchemaRegistry } = await import(
  "../services/devbench/workflow-v2/schema-registry.js"
);

const {
  WorkflowV2ContextSelectionError,
  countUnicodeCharacters,
  loadContextBudgetConfig,
  selectStageContext,
  selectStageContextFromStore,
} = selector;

after(async () => {
  if (gatewayDatabase.open) gatewayDatabase.close();
  assert.equal(gatewayDatabase.open, false, "测试 SQLite 连接未关闭");
  const cleanupTarget = process.platform === "win32" ? path.toNamespacedPath(tempRoot) : tempRoot;
  await fs.promises.rm(cleanupTarget, {
    recursive: true,
    force: true,
    maxRetries: 20,
    retryDelay: 50,
  });
  assert.equal(fs.existsSync(cleanupTarget), false, `测试临时目录未清理: ${tempRoot}`);
});

function baseContext({ storyId = "story-context-1", stageId = "TRIAGE" } = {}) {
  return {
    schemaVersion: "tb-stage-context-v2",
    contextId: `context-${storyId}-${stageId.toLowerCase()}`,
    revision: 7,
    idempotencyKey: `${storyId}:${stageId}:7`,
    story: {
      storyId,
      ticketId: "ticket-1",
      carbId: "CARB-1",
      title: "Workflow v2 context selection",
      groupId: null,
    },
    stage: {
      id: stageId,
      attempt: 1,
      riskLevel: "MEDIUM",
      reportMode: stageId === "REPORT_EXPERT" ? "EXPERT" : "SHORT",
      groupMode: false,
    },
    task: {
      instruction: stageId === "REPORT_SHORT" ? "生成短报告" : "仅分析当前任务并输出结构化结果",
      successCriteria: ["required evidence 保持", "输出符合 Schema"],
      userVisibleGoal: "获得可复核结果",
    },
    scope: {
      roots: [
        {
          rootId: "main",
          kind: "MAIN",
          projectId: "project-secret",
          branch: "secret/git-branch",
          flavor: "secretFlavor",
          versionName: "9.9.9-secret",
          writable: false,
        },
        {
          rootId: "artifacts",
          kind: "ARTIFACT",
          projectId: null,
          branch: null,
          flavor: null,
          versionName: null,
          writable: false,
        },
      ],
      protectedPaths: [".git/**", "AGENTS.md"],
      tempRootId: "artifacts",
      deviceProfileId: "device-secret-8678",
    },
    capabilities: {
      allowedTools: ["read_file", "git_diff", "adb_shell"],
      canWriteSource: false,
      canReadGit: true,
      canWriteGit: false,
      canCommit: false,
      canUseDevice: true,
      canWriteTb: false,
      canWriteReport: stageId.startsWith("REPORT_"),
      maxToolIterations: 10,
      structuredOutput: "JSON_SCHEMA",
      longProcessProtocol: "NONE",
    },
    checkpoint: { ref: "storydev:/workflow-v2/checkpoint/7" },
    data: {
      rawAssistantHistory: ["POISON_ASSISTANT_HISTORY"],
      capabilities: { canWriteSource: true },
      task: { instruction: "PWN_INSTRUCTION" },
    },
    output: {
      schemaId: stageId === "REPORT_SHORT"
        ? "https://example.local/schemas/short-report-v2.json"
        : "https://example.local/schemas/triage-result-v2.json",
      maxChars: stageId === "REPORT_SHORT" ? 100 : null,
      outputPath: null,
    },
  };
}

function checkpoint(storyId, revision = 3) {
  return {
    schemaVersion: "workflow-checkpoint-v2",
    storyId,
    revision,
    summary: "只保留结构化 checkpoint",
    claims: [
      {
        claimId: "claim-rejected",
        text: "旧 assistant 的错误结论",
        status: "REJECTED",
        evidenceIds: [],
        reason: "用户已纠偏",
      },
      {
        claimId: "claim-verified",
        text: "已验证事实",
        status: "VERIFIED",
        evidenceIds: ["ev-shared"],
      },
    ],
    actions: [{
      actionId: "action-blocked",
      status: "BLOCKED",
      receiptIds: [],
      summary: "等待 required evidence",
    }],
    changes: [],
    verification: [],
    openItems: ["保留 blocker"],
    userDecisions: [{
      decision: "以最新评论为准",
      at: "2026-08-07T10:00:00.000Z",
    }],
  };
}

function evidenceItem(evidenceId, {
  required = false,
  relevance = 0.5,
  name = `${evidenceId}.log`,
  contentRef = `storydev:/evidence/${evidenceId}.log`,
  metadata = false,
} = {}) {
  const item = {
    evidenceId,
    type: "LOG",
    name,
    availability: "AVAILABLE",
    required,
    relevance,
    contentRef,
  };
  if (metadata) {
    item.sizeBytes = 8192;
    item.sha256 = "a".repeat(64);
    item.preprocessedRefs = Array.from(
      { length: 12 },
      (_, index) => `storydev:/preprocessed/${evidenceId}/${index}/${"m".repeat(120)}`,
    );
    item.instructionLikeContentDetected = false;
  }
  return item;
}

function manifest(storyId, items, coverage = "COMPLETE") {
  return {
    schemaVersion: "evidence-manifest-v2",
    storyId,
    coverage,
    items,
  };
}

function deterministicInput({ reversed = false } = {}) {
  const storyId = "story-deterministic";
  const base = baseContext({ storyId });
  base.scope.roots.push(structuredClone(base.scope.roots[0]));
  const comments = [
    {
      commentId: "comment-shared",
      text: "旧评论",
      updatedAt: "2026-08-07T08:00:00.000Z",
      isCorrection: false,
    },
    {
      commentId: "comment-shared",
      text: "最新用户纠偏",
      updatedAt: "2026-08-07T09:00:00.000Z",
      isCorrection: true,
      verified: true,
    },
    {
      commentId: "comment-other",
      text: "另一条评论",
      updatedAt: "2026-08-07T07:00:00.000Z",
    },
  ];
  const manifests = [
    manifest(storyId, [
      evidenceItem("ev-shared", { required: false, relevance: 0.9 }),
      evidenceItem("ev-alpha", { relevance: 0.7 }),
    ]),
    manifest(storyId, [
      evidenceItem("ev-shared", { required: true, relevance: 0.9 }),
      evidenceItem("ev-beta", { relevance: 0.6 }),
    ]),
  ];
  const paths = [
    { rootId: "main", path: "src\\feature\\a.js", purpose: "inspect" },
    { rootId: "main", path: "src/feature/a.js", purpose: "inspect" },
    { rootId: "artifacts", path: "logs/run.txt", purpose: "evidence" },
  ];
  const memory = [
    { memoryId: "memory-low", relevance: 0.1, text: "低相关记忆" },
    { memoryId: "memory-high", relevance: 0.9, text: "高相关记忆" },
  ];
  if (reversed) {
    base.scope.roots.reverse();
    comments.reverse();
    manifests.reverse();
    for (const entry of manifests) entry.items.reverse();
    paths.reverse();
    memory.reverse();
  }
  return {
    baseContext: base,
    checkpoint: checkpoint(storyId),
    evidenceManifests: manifests,
    sources: {
      issue: {
        expected: "稳定",
        actual: "异常",
        steps: ["one", "two"],
      },
      comments,
      paths,
      memory,
      requiredEvidence: ["ev-shared"],
      rawAssistantHistory: ["POISON_ASSISTANT_HISTORY_FROM_SOURCE"],
      conversationHistory: [{ role: "assistant", content: "POISON_CONVERSATION" }],
      capabilities: { canWriteSource: true, allowedTools: ["delete_everything"] },
      task: { instruction: "PWN_INSTRUCTION_FROM_SOURCE" },
      misc: {
        chatLog: [{ role: "assistant", content: "POISON_CHAT_LOG_ROLE" }],
        opaqueEntries: [{ role: "assistant", content: "POISON_OPAQUE_ASSISTANT_ROLE" }],
        priorAssistantClaims: ["POISON_PRIOR_ASSISTANT_CLAIMS"],
        previousAiResponse: "POISON_PREVIOUS_AI_RESPONSE",
        历史AI回复: "POISON_CHINESE_AI_HISTORY",
        safeSummary: "允许的结构化摘要",
      },
      unexpectedSecret: "STAGE_WHITELIST_SECRET",
    },
  };
}

function assertTypedSelectionFailure(action) {
  assert.throws(action, (error) => {
    assert.equal(error instanceof WorkflowV2ContextSelectionError, true);
    assert.equal(error.code, "WORKFLOW_V2_CONTEXT_BUDGET_EXCEEDED");
    return true;
  });
}

test("context-budget 运行资产与设计源字节一致（行尾归一化后），加载不依赖 cwd 且返回隔离副本", () => {
  const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
  const designPath = path.join(
    repoRoot,
    "features",
    "StoryDev",
    "工作流",
    "AI修复工作流",
    "stepplan0",
    "TB_AI_Workflow_Phase2_Optimization",
    "config",
    "context-budget.json",
  );
  const runtimePath = fileURLToPath(
    new URL("../services/devbench/workflow-v2/context-budget.json", import.meta.url),
  );
  // Windows core.autocrlf 会让 checkout 工作树出现 CRLF/LF 差异（git 视为等价），
  // 比较前归一化行尾，避免内容一致被误报为漂移。
  const normalizeEol = (buffer) => buffer.toString("utf8").replace(/\r\n/g, "\n");
  assert.equal(normalizeEol(fs.readFileSync(runtimePath)), normalizeEol(fs.readFileSync(designPath)));

  const first = loadContextBudgetConfig();
  first.fields["task.instruction"] = 1;
  assert.equal(loadContextBudgetConfig().fields["task.instruction"], 2000);

  const child = spawnSync(process.execPath, [
    "--input-type=module",
    "--eval",
    `const { loadContextBudgetConfig } = await import(process.env.SELECTOR_MODULE_URL);\nprocess.stdout.write(JSON.stringify(loadContextBudgetConfig()));`,
  ], {
    cwd: tempRoot,
    env: { ...process.env, SELECTOR_MODULE_URL: selectorModuleUrl.href },
    encoding: "utf8",
    windowsHide: true,
  });
  assert.equal(child.status, 0, child.stderr || child.stdout);
  assert.deepEqual(JSON.parse(child.stdout), loadContextBudgetConfig());
});

test("重排输入产生相同 canonical/hash，stable ID 去重、required OR 且不修改入参", () => {
  const firstInput = deterministicInput();
  const secondInput = deterministicInput({ reversed: true });
  const firstBefore = structuredClone(firstInput);
  const secondBefore = structuredClone(secondInput);

  const first = selectStageContext(firstInput);
  const second = selectStageContext(secondInput);

  assert.equal(first.canonical, second.canonical);
  assert.equal(first.contextHash, second.contextHash);
  assert.deepEqual(first.context, second.context);
  assert.deepEqual(firstInput, firstBefore);
  assert.deepEqual(secondInput, secondBefore);
  assert.equal(
    workflowV2SchemaRegistry.validate(WORKFLOW_V2_SCHEMA_IDS.stageContext, first.context).valid,
    true,
  );

  assert.equal(first.context.scope.roots.length, 2);
  assert.equal(new Set(first.context.scope.roots.map((entry) => entry.rootId)).size, 2);
  assert.equal(first.context.data.latestSubstantiveComments.length, 2);
  assert.equal(
    first.context.data.latestSubstantiveComments.find((entry) => entry.commentId === "comment-shared").text,
    "最新用户纠偏",
  );
  assert.equal(first.context.data.evidenceManifest.items.length, 3);
  assert.equal(
    first.context.data.evidenceManifest.items.find((entry) => entry.evidenceId === "ev-shared").required,
    true,
  );
  assert.deepEqual(first.context.data.requiredEvidence, ["ev-shared"]);
  assert.equal(first.context.data.paths.length, 2);
  assert.equal(
    first.context.data.paths.filter((entry) => (
      entry.rootId === "main" && entry.path === "src/feature/a.js"
    )).length,
    1,
  );
});

test("完全相同 evidence 重复输入保持幂等，显式 false 与空数组不丢失", () => {
  const storyId = "story-identical-evidence-replay";
  const item = evidenceItem("ev-shared", { required: true });
  item.preprocessedRefs = [];
  item.instructionLikeContentDetected = false;
  const baseInput = {
    baseContext: baseContext({ storyId }),
    checkpoint: checkpoint(storyId),
    sources: {},
  };
  const once = selectStageContext({
    ...baseInput,
    evidenceManifest: manifest(storyId, [item]),
  });
  const duplicated = selectStageContext({
    ...baseInput,
    evidenceManifests: [
      manifest(storyId, [structuredClone(item)]),
      manifest(storyId, [structuredClone(item)]),
    ],
  });
  assert.equal(duplicated.canonical, once.canonical);
  assert.equal(duplicated.contextHash, once.contextHash);
  const selected = duplicated.context.data.evidenceManifest.items[0];
  assert.deepEqual(selected.preprocessedRefs, []);
  assert.equal(selected.instructionLikeContentDetected, false);
});

test("raw assistant history 与外部 control plane 覆盖不会泄漏，REJECTED claim 保持", () => {
  const { context, canonical } = selectStageContext(deterministicInput());
  for (const poison of [
    "POISON_ASSISTANT_HISTORY",
    "POISON_ASSISTANT_HISTORY_FROM_SOURCE",
    "POISON_CONVERSATION",
    "PWN_INSTRUCTION",
    "PWN_INSTRUCTION_FROM_SOURCE",
    "delete_everything",
    "STAGE_WHITELIST_SECRET",
    "POISON_CHAT_LOG_ROLE",
    "POISON_OPAQUE_ASSISTANT_ROLE",
    "POISON_PRIOR_ASSISTANT_CLAIMS",
    "POISON_PREVIOUS_AI_RESPONSE",
    "POISON_CHINESE_AI_HISTORY",
  ]) {
    assert.equal(canonical.includes(poison), false, poison);
  }
  assert.equal(context.task.instruction, "仅分析当前任务并输出结构化结果");
  assert.equal(context.capabilities.canWriteSource, false);
  assert.deepEqual(context.capabilities.allowedTools, ["adb_shell", "git_diff", "read_file"]);
  assert.equal(
    context.checkpoint.claims.find((entry) => entry.claimId === "claim-rejected").status,
    "REJECTED",
  );
});

test("预算先裁低 relevance memory 再裁 optional evidence 元数据，required 与最新评论纠偏保留", () => {
  const storyId = "story-budget-trim";
  const budgetConfig = loadContextBudgetConfig();
  budgetConfig.typicalTotalMax = 90000;
  budgetConfig.hardTotalMax = 100000;
  budgetConfig.fields["data.relevantMemory"] = 260;
  budgetConfig.fields["data.evidenceManifest"] = 900;
  const result = selectStageContext({
    baseContext: baseContext({ storyId }),
    checkpoint: checkpoint(storyId),
    evidenceManifest: manifest(storyId, [
      evidenceItem("ev-required", { required: true, relevance: 1 }),
      evidenceItem("ev-optional", { relevance: 0.1, metadata: true }),
      evidenceItem("ev-shared", { relevance: 0.8 }),
    ]),
    sources: {
      issue: { actual: "异常", expected: "稳定" },
      requiredEvidence: ["ev-required"],
      comments: [
        {
          commentId: "latest-correction",
          text: "用户最新纠偏必须保留",
          updatedAt: "2026-08-07T12:00:00.000Z",
          isCorrection: true,
          verified: true,
        },
      ],
      memory: [
        { memoryId: "memory-high", relevance: 1, text: `高相关-${"h".repeat(80)}` },
        { memoryId: "memory-low", relevance: 0, text: `低相关-${"l".repeat(300)}` },
      ],
    },
    budgetConfig,
  });

  assert.deepEqual(result.context.data.relevantMemory.map((entry) => entry.memoryId), ["memory-high"]);
  assert.equal(
    result.context.data.evidenceManifest.items.some((entry) => (
      entry.evidenceId === "ev-required" && entry.required
    )),
    true,
  );
  assert.equal(
    result.context.data.latestSubstantiveComments.some((entry) => (
      entry.commentId === "latest-correction" && entry.text === "用户最新纠偏必须保留"
    )),
    true,
  );
  const optional = result.context.data.evidenceManifest.items.find(
    (entry) => entry.evidenceId === "ev-optional",
  );
  assert.equal(optional.preprocessedRefs, undefined);
  assert.equal(optional.sizeBytes, undefined);
  assert.equal(optional.sha256, undefined);
  assert.equal(optional.instructionLikeContentDetected, false);
  const memoryDropIndex = result.budget.drops.findIndex(
    (entry) => entry.field === "data.relevantMemory" && entry.id === "memory-low",
  );
  const evidenceDropIndex = result.budget.drops.findIndex(
    (entry) => entry.field === "data.evidenceManifest" && entry.id === "ev-optional",
  );
  assert.notEqual(memoryDropIndex, -1);
  assert.notEqual(evidenceDropIndex, -1);
  assert.ok(memoryDropIndex < evidenceDropIndex);
});

test("VERIFIED claim 的 evidence 自动提升为 required、预算不可裁，缺失时 typed 阻断", () => {
  const storyId = "story-verified-evidence";
  const verifiedCheckpoint = checkpoint(storyId);
  verifiedCheckpoint.claims.find(
    (entry) => entry.claimId === "claim-verified",
  ).evidenceIds = ["ev-verified"];
  const evidence = manifest(storyId, [
    evidenceItem("ev-verified", { required: false, relevance: 0, metadata: true }),
    evidenceItem("ev-optional-a", { required: false, relevance: 0.1 }),
    evidenceItem("ev-optional-b", { required: false, relevance: 0.2 }),
  ]);
  const input = {
    baseContext: baseContext({ storyId }),
    checkpoint: verifiedCheckpoint,
    evidenceManifest: evidence,
    sources: {},
  };
  const baseline = selectStageContext(input);
  const promoted = baseline.context.data.evidenceManifest.items.find(
    (entry) => entry.evidenceId === "ev-verified",
  );
  assert.equal(promoted.required, true);
  assert.equal(promoted.sha256, "a".repeat(64));
  assert.equal(promoted.preprocessedRefs.length, 12);
  assert.equal(promoted.instructionLikeContentDetected, false);
  assert.deepEqual(baseline.context.data.requiredEvidence, ["ev-verified"]);

  const requiredOnlyManifest = structuredClone(baseline.context.data.evidenceManifest);
  requiredOnlyManifest.items = requiredOnlyManifest.items.filter(
    (entry) => entry.evidenceId === "ev-verified",
  );
  requiredOnlyManifest.coverage = "PARTIAL";
  requiredOnlyManifest.coverageReason = "context budget omitted optional evidence";
  const tightBudget = loadContextBudgetConfig();
  tightBudget.typicalTotalMax = 90000;
  tightBudget.hardTotalMax = 100000;
  tightBudget.fields["data.evidenceManifest"] = countUnicodeCharacters({
    evidenceManifest: requiredOnlyManifest,
    requiredEvidence: ["ev-verified"],
  });
  const trimmed = selectStageContext({ ...input, budgetConfig: tightBudget });
  assert.deepEqual(
    trimmed.context.data.evidenceManifest.items.map((entry) => ({
      evidenceId: entry.evidenceId,
      required: entry.required,
    })),
    [{ evidenceId: "ev-verified", required: true }],
  );
  assert.equal(trimmed.context.data.evidenceManifest.coverage, "PARTIAL");
  assert.match(trimmed.context.data.evidenceManifest.coverageReason, /budget omitted optional evidence/);
  const retainedVerified = trimmed.context.data.evidenceManifest.items[0];
  assert.equal(retainedVerified.sha256, "a".repeat(64));
  assert.equal(retainedVerified.preprocessedRefs.length, 12);
  assert.equal(retainedVerified.instructionLikeContentDetected, false);
  assert.equal(
    trimmed.budget.drops.some((entry) => (
      entry.field === "data.evidenceManifest" && entry.id.startsWith("ev-optional-")
    )),
    true,
  );

  assert.throws(() => selectStageContext({
    ...input,
    evidenceManifest: manifest(storyId, [evidenceItem("ev-other")]),
  }), (error) => {
    assert.equal(error instanceof WorkflowV2ContextSelectionError, true);
    assert.equal(error.code, "WORKFLOW_V2_CONTEXT_REQUIRED_EVIDENCE_MISSING");
    assert.equal(error.details.evidenceId, "ev-verified");
    return true;
  });
});

test("mandatory 字段上限与无法裁剪的 hard total 均抛出 typed failure", () => {
  const storyId = "story-budget-failure";
  const oversized = baseContext({ storyId });
  oversized.task.instruction = "任".repeat(2001);
  assertTypedSelectionFailure(() => selectStageContext({
    baseContext: oversized,
    checkpoint: checkpoint(storyId),
    evidenceManifest: manifest(storyId, [evidenceItem("ev-shared")]),
    sources: {},
  }));

  const hardBudget = loadContextBudgetConfig();
  hardBudget.typicalTotalMax = 399;
  hardBudget.hardTotalMax = 400;
  for (const field of Object.keys(hardBudget.fields)) hardBudget.fields[field] = 10000;
  assertTypedSelectionFailure(() => selectStageContext({
    baseContext: baseContext({ storyId }),
    checkpoint: checkpoint(storyId),
    evidenceManifest: manifest(storyId, [evidenceItem("ev-shared")]),
    sources: {},
    budgetConfig: hardBudget,
  }));
});

test("Unicode 预算按 code point 计数，非字符串先 canonical JSON", () => {
  assert.equal(countUnicodeCharacters("A😀e\u0301"), 4);
  assert.equal(
    countUnicodeCharacters({ emoji: "😀", letter: "A" }),
    Array.from('{"emoji":"😀","letter":"A"}').length,
  );
});

test("REPORT_SHORT 只保留最小 reportFacts/maxChars，上下文仍符合 Schema", () => {
  const storyId = "story-report-short";
  const base = baseContext({ storyId, stageId: "REPORT_SHORT" });
  const result = selectStageContext({
    baseContext: base,
    checkpoint: checkpoint(storyId),
    evidenceManifest: manifest(storyId, [evidenceItem("ev-shared", { required: true })]),
    sources: {
      reportFacts: {
        cause: "已验证原因",
        remedy: "已验证措施",
        evidenceIds: ["ev-shared"],
        testAcceptanceSkipped: true,
        verificationStatus: "SKIPPED_BY_USER",
        changes: [{ path: "C:/SHOULD_NOT_LEAK_REPORT_FACT_PATH", summary: "内部修改" }],
      },
      maxChars: 100,
      assetManifest: [{ assetId: "SHOULD_NOT_LEAK_ASSET" }],
      issue: { path: "C:/SHOULD_NOT_LEAK_PROJECT_PATH" },
      paths: [{ rootId: "main", path: ".git/SHOULD_NOT_LEAK_GIT" }],
      deviceData: "SHOULD_NOT_LEAK_DEVICE",
      rawAssistantHistory: ["SHOULD_NOT_LEAK_HISTORY"],
    },
  });

  assert.equal(
    workflowV2SchemaRegistry.validate(WORKFLOW_V2_SCHEMA_IDS.stageContext, result.context).valid,
    true,
  );
  assert.deepEqual(Object.keys(result.context.data).sort(), ["maxChars", "reportFacts"]);
  assert.equal(result.context.data.reportFacts.testAcceptanceSkipped, true);
  assert.equal(result.context.data.reportFacts.verificationStatus, "SKIPPED_BY_USER");
  assert.deepEqual(Object.keys(result.context.checkpoint), ["ref"]);
  assert.deepEqual(result.context.capabilities.allowedTools, []);
  assert.equal(result.context.capabilities.canUseDevice, false);
  assert.equal(result.context.capabilities.canReadGit, false);
  assert.equal(result.context.capabilities.maxToolIterations, 0);
  assert.equal(result.context.scope.deviceProfileId, undefined);
  assert.equal(result.context.scope.protectedPaths, undefined);
  for (const root of result.context.scope.roots) {
    assert.deepEqual(Object.keys(root).sort(), ["kind", "rootId", "writable"]);
  }
  for (const poison of [
    "project-secret",
    "secret/git-branch",
    "secretFlavor",
    "device-secret-8678",
    "git_diff",
    "adb_shell",
    "SHOULD_NOT_LEAK_ASSET",
    "SHOULD_NOT_LEAK_PROJECT_PATH",
    "SHOULD_NOT_LEAK_GIT",
    "SHOULD_NOT_LEAK_DEVICE",
    "SHOULD_NOT_LEAK_HISTORY",
    "SHOULD_NOT_LEAK_REPORT_FACT_PATH",
  ]) {
    assert.equal(result.canonical.includes(poison), false, poison);
  }
});

test("报告阶段忽略 source 输出控制覆盖与非法路径，只消费可信 output", () => {
  const shortStoryId = "story-report-output-control-short";
  const shortBase = baseContext({ storyId: shortStoryId, stageId: "REPORT_SHORT" });
  shortBase.output.maxChars = 77;
  shortBase.output.outputPath = "reports/trusted-short.txt";
  const shortResult = selectStageContext({
    baseContext: shortBase,
    checkpoint: checkpoint(shortStoryId),
    sources: {
      reportFacts: { cause: "原因", remedy: "措施" },
      maxChars: { invalid: true },
      outputPath: "../../SOURCE_OUTPUT_PATH_MUST_NOT_WIN",
      output: { maxChars: 99999, outputPath: "SOURCE_OUTPUT_OBJECT_MUST_NOT_WIN" },
      paths: [
        { rootId: "main", path: "C:\\absolute\\SOURCE_INVALID_PATH" },
        { rootId: "main", path: "../../SOURCE_TRAVERSAL_PATH" },
      ],
    },
  });
  assert.equal(shortResult.context.data.maxChars, 77);
  assert.equal(shortResult.context.output.maxChars, 77);
  assert.equal(shortResult.context.output.outputPath, null);
  assert.deepEqual(
    shortResult.selection.droppedFields.filter((field) => (
      field === "sources.maxChars" || field === "sources.output" || field === "sources.outputPath"
    )),
    ["sources.maxChars", "sources.output", "sources.outputPath"],
  );
  for (const poison of [
    "SOURCE_OUTPUT_PATH_MUST_NOT_WIN",
    "SOURCE_OUTPUT_OBJECT_MUST_NOT_WIN",
    "SOURCE_INVALID_PATH",
    "SOURCE_TRAVERSAL_PATH",
  ]) {
    assert.equal(shortResult.canonical.includes(poison), false, poison);
  }

  const noArtifactStoryId = "story-report-no-artifact-root";
  const noArtifactBase = baseContext({ storyId: noArtifactStoryId, stageId: "REPORT_SHORT" });
  noArtifactBase.scope.roots = noArtifactBase.scope.roots.filter((root) => root.kind !== "ARTIFACT");
  const noArtifactResult = selectStageContext({
    baseContext: noArtifactBase,
    checkpoint: checkpoint(noArtifactStoryId),
    sources: { reportFacts: { cause: "原因", remedy: "措施" } },
  });
  assert.deepEqual(noArtifactResult.context.scope.roots, [
    { rootId: "main", kind: "MAIN", writable: false },
  ]);

  const expertStoryId = "story-report-output-control-expert";
  const expertBase = baseContext({ storyId: expertStoryId, stageId: "REPORT_EXPERT" });
  expertBase.output.outputPath = "reports/trusted-expert.html";
  const expertResult = selectStageContext({
    baseContext: expertBase,
    checkpoint: checkpoint(expertStoryId),
    sources: {
      reportFacts: { cause: "已验证原因", remedy: "已验证措施" },
      assetManifest: [{ assetId: "asset-1", contentRef: "storydev:/asset/1" }],
      verifiedEvidenceIds: ["ev-unverified-source-must-not-win"],
      outputPath: "../../SOURCE_EXPERT_OUTPUT_MUST_NOT_WIN.html",
      maxChars: -1,
      paths: [{ rootId: "main", path: "C:\\SOURCE_EXPERT_INVALID_PATH" }],
    },
  });
  assert.equal(expertResult.context.data.outputPath, "reports/trusted-expert.html");
  assert.equal(expertResult.context.output.outputPath, "reports/trusted-expert.html");
  assert.deepEqual(expertResult.context.data.verifiedEvidenceIds, ["ev-shared"]);
  assert.equal(expertResult.canonical.includes("SOURCE_EXPERT_OUTPUT_MUST_NOT_WIN"), false);
  assert.equal(expertResult.canonical.includes("SOURCE_EXPERT_INVALID_PATH"), false);
  assert.equal(expertResult.selection.droppedFields.includes("sources.outputPath"), true);
  assert.equal(expertResult.selection.droppedFields.includes("sources.maxChars"), true);
  assert.equal(expertResult.selection.droppedFields.includes("sources.verifiedEvidenceIds"), true);
  assert.equal(expertResult.canonical.includes("ev-unverified-source-must-not-win"), false);

  const oversizedShortBase = baseContext({
    storyId: "story-report-output-limit",
    stageId: "REPORT_SHORT",
  });
  oversizedShortBase.output.maxChars = 101;
  assert.throws(() => selectStageContext({
    baseContext: oversizedShortBase,
    checkpoint: checkpoint("story-report-output-limit"),
    sources: { reportFacts: { cause: "原因", remedy: "措施" } },
  }), (error) => {
    assert.equal(error.code, "WORKFLOW_V2_CONTEXT_BUDGET_EXCEEDED");
    assert.equal(error.details.field, "output.maxChars");
    return true;
  });
});

test("checkpoint changes 以 rootId + path 为复合 stable ID，同 path 跨 root 均保留", () => {
  const storyId = "story-checkpoint-change-identity";
  const selectedCheckpoint = checkpoint(storyId);
  selectedCheckpoint.changes = [
    {
      rootId: "main",
      path: "src/shared.js",
      summary: "主工程修改",
      receiptIds: ["receipt-main"],
    },
    {
      rootId: "artifacts",
      path: "src/shared.js",
      summary: "证据工程修改",
      receiptIds: ["receipt-artifact"],
    },
    {
      rootId: "main",
      path: "src/shared.js",
      summary: "主工程修改",
      receiptIds: ["receipt-main"],
    },
  ];
  const result = selectStageContext({
    baseContext: baseContext({ storyId }),
    checkpoint: selectedCheckpoint,
    evidenceManifest: manifest(storyId, [evidenceItem("ev-shared")]),
    sources: {},
  });
  assert.deepEqual(
    result.context.checkpoint.changes.map((entry) => ({
      rootId: entry.rootId,
      path: entry.path,
    })),
    [
      { rootId: "artifacts", path: "src/shared.js" },
      { rootId: "main", path: "src/shared.js" },
    ],
  );
});

test("未单列的阶段数据归入 misc bucket，结构化 path 规范化去重且越界失败", () => {
  const storyId = "story-repair-misc-budget";
  const base = baseContext({ storyId, stageId: "REPAIR" });
  const selectedCheckpoint = checkpoint(storyId);
  const evidence = manifest(storyId, [evidenceItem("ev-shared", { required: true })]);
  const valid = selectStageContext({
    baseContext: base,
    checkpoint: selectedCheckpoint,
    evidenceManifest: evidence,
    sources: {
      approvedPlan: { planId: "plan-1" },
      currentDiff: {
        changes: [
          { rootId: "main", path: "src\\feature.js", summary: "same" },
          { rootId: "main", path: "src/feature.js", summary: "same" },
        ],
      },
    },
  });
  assert.deepEqual(valid.context.data.currentDiff.changes, [
    { rootId: "main", path: "src/feature.js", summary: "same" },
  ]);

  assert.throws(() => selectStageContext({
    baseContext: base,
    checkpoint: selectedCheckpoint,
    evidenceManifest: evidence,
    sources: {
      approvedPlan: { planId: "plan-1" },
      currentDiff: "d".repeat(5000),
    },
  }), (error) => {
    assert.equal(error.code, "WORKFLOW_V2_CONTEXT_BUDGET_EXCEEDED");
    assert.equal(error.details.field, "data.misc");
    return true;
  });

  assert.throws(() => selectStageContext({
    baseContext: base,
    checkpoint: selectedCheckpoint,
    evidenceManifest: evidence,
    sources: {
      approvedPlan: {
        changes: [{ rootId: "main", path: "../../escape.js", summary: "unsafe" }],
      },
    },
  }), (error) => {
    assert.equal(error.code, "WORKFLOW_V2_CONTEXT_PATH_INVALID");
    return true;
  });
});

test("stage data whitelist 仅投影当前阶段允许字段", () => {
  const storyId = "story-stage-whitelist";
  const result = selectStageContext({
    baseContext: baseContext({ storyId }),
    checkpoint: checkpoint(storyId),
    evidenceManifest: manifest(storyId, [evidenceItem("ev-shared")]),
    sources: {
      issue: { actual: "保留 issue" },
      approvedPlanOrPriorResult: { text: "TRIAGE_SHOULD_NOT_SEE_PLAN" },
      reportFacts: { text: "TRIAGE_SHOULD_NOT_SEE_REPORT" },
      assetManifest: [{ text: "TRIAGE_SHOULD_NOT_SEE_ASSET" }],
      currentDiff: "TRIAGE_SHOULD_NOT_SEE_DIFF",
      outputPath: "TRIAGE_SHOULD_NOT_SEE_OUTPUT_PATH",
      unknown: "TRIAGE_SHOULD_NOT_SEE_UNKNOWN",
    },
  });
  assert.deepEqual(result.context.data.issue, { actual: "保留 issue" });
  for (const key of [
    "approvedPlanOrPriorResult",
    "reportFacts",
    "assetManifest",
    "currentDiff",
    "outputPath",
    "unknown",
  ]) {
    assert.equal(Object.hasOwn(result.context.data, key), false, key);
  }
  assert.equal(result.canonical.includes("TRIAGE_SHOULD_NOT_SEE_"), false);
});

test("全部 stage 使用固定字段矩阵，不以对象 spread 复制未声明数据", () => {
  const expectedByStage = {
    TRIAGE: [
      "evidenceManifest", "issue", "latestSubstantiveComments", "misc", "paths",
      "relevantMemory", "requiredEvidence",
    ],
    DIAGNOSE_PLAN: [
      "approvedPlan", "evidenceManifest", "issue", "latestSubstantiveComments", "misc", "paths",
      "priorStageResult", "relevantMemory", "requiredEvidence",
    ],
    REPAIR: [
      "approvedPlan", "currentDiff", "evidenceManifest", "localChecks", "misc", "paths",
      "priorStageResult", "requiredEvidence", "triageResult",
    ],
    INDEPENDENT_REVIEW: [
      "approvedPlan", "currentDiff", "evidenceManifest", "localChecks", "misc", "paths",
      "priorStageResult", "repairResult", "requiredEvidence",
    ],
    VERIFY_PLAN: [
      "approvedPlan", "currentDiff", "deviceProfile", "evidenceManifest", "flavorProfile",
      "localChecks", "misc", "paths", "priorStageResult", "repairResult", "requiredEvidence",
      "verificationPlan",
    ],
    VERIFY_EXECUTE: [
      "approvedPlan", "currentDiff", "deviceProfile", "evidenceManifest", "flavorProfile",
      "localChecks", "misc", "paths", "priorStageResult", "repairResult", "requiredEvidence",
      "verificationPlan",
    ],
    REPORT_SHORT: ["maxChars", "reportFacts"],
    REPORT_EXPERT: ["assetManifest", "outputPath", "reportFacts", "verifiedEvidenceIds"],
    MEMORY_DISTILL: ["evidenceManifest", "misc", "relevantMemory", "reportFacts", "requiredEvidence"],
  };
  for (const [stageId, expected] of Object.entries(expectedByStage)) {
    const storyId = `story-matrix-${stageId.toLowerCase()}`;
    const base = baseContext({ storyId, stageId });
    if (stageId === "REPORT_EXPERT") base.output.outputPath = "reports/trusted-matrix.html";
    const selectedCheckpoint = checkpoint(storyId);
    const input = {
      baseContext: base,
      checkpoint: selectedCheckpoint,
      evidenceManifest: manifest(storyId, [evidenceItem("ev-shared", { required: true })]),
      sources: {
        issue: { actual: "异常", expected: "正常" },
        comments: [{ commentId: "comment-1", text: "最新评论" }],
        memory: [{ memoryId: "memory-1", relevance: 1, text: "相关记忆" }],
        paths: [{ rootId: "main", path: "src/feature.js" }],
        approvedPlan: { planId: "plan-1" },
        approvedPlanOrPriorResult: { duplicateAlias: "must-not-duplicate-approved-plan" },
        priorStageResult: { resultId: "prior-1" },
        triageResult: { resultId: "triage-1" },
        repairResult: { resultId: "repair-1" },
        currentDiff: { sha256: "a".repeat(64) },
        localChecks: [{ caseId: "local-1", status: "PASS" }],
        verificationPlan: { cases: ["case-1"] },
        flavorProfile: { flavorId: "flavor-1" },
        deviceProfile: { profileId: "device-1" },
        reportFacts: { cause: "原因", remedy: "措施", evidenceIds: ["ev-shared"] },
        assetManifest: [{ assetId: "asset-1", exists: true }],
        verifiedEvidenceIds: ["ev-shared"],
        misc: { note: "阶段附加摘要" },
        unknownField: "MATRIX_UNKNOWN_MUST_NOT_LEAK",
      },
    };
    const result = selectStageContext(input);
    assert.deepEqual(Object.keys(result.context.data).sort(), [...expected].sort(), stageId);
    assert.equal(result.canonical.includes("MATRIX_UNKNOWN_MUST_NOT_LEAK"), false, stageId);
    assert.equal(result.canonical.includes("must-not-duplicate-approved-plan"), false, stageId);
  }
});

test("M2 selector 保持 dormant，旧 Prompt/Provider/marker/状态机无静态接入", () => {
  const gatewayRoot = fileURLToPath(new URL("../", import.meta.url));
  for (const relative of [
    "server.js",
    "services/agent-runner.js",
    "services/api-engine.js",
    "services/devbench/index.js",
    "services/devbench/report.js",
    "services/devbench/tb-workflow.js",
  ]) {
    const source = fs.readFileSync(path.join(gatewayRoot, relative), "utf8");
    assert.doesNotMatch(source, /workflow-v2\/context-selector/, relative);
  }
});

test("selectStageContextFromStore 严格读取指定 checkpoint/manifest revision", async () => {
  const storyId = "story-exact-revision";
  const tab = {
    id: storyId,
    title: "exact revision",
    docSlug: "exact-revision",
    closedAt: null,
  };
  const checkpointOne = checkpoint(storyId, 1);
  checkpointOne.summary = "CHECKPOINT_REVISION_ONE";
  checkpointOne.claims.find((entry) => entry.claimId === "claim-verified").evidenceIds = ["ev-one"];
  const checkpointTwo = checkpoint(storyId, 2);
  checkpointTwo.summary = "CHECKPOINT_REVISION_TWO";
  checkpointTwo.claims.find((entry) => entry.claimId === "claim-verified").evidenceIds = ["ev-two"];
  const manifestOne = manifest(storyId, [evidenceItem("ev-one", { required: true })]);
  const manifestTwo = manifest(storyId, [evidenceItem("ev-two", { required: true })]);
  await workflow.appendWorkflowCheckpoint({
    tab,
    revision: 1,
    idempotencyKey: `${storyId}:checkpoint:1`,
    payload: checkpointOne,
  });
  await workflow.appendWorkflowCheckpoint({
    tab,
    revision: 2,
    idempotencyKey: `${storyId}:checkpoint:2`,
    payload: checkpointTwo,
  });
  await workflow.appendEvidenceManifest({
    tab,
    revision: 1,
    idempotencyKey: `${storyId}:manifest:1`,
    payload: manifestOne,
  });
  await workflow.appendEvidenceManifest({
    tab,
    revision: 2,
    idempotencyKey: `${storyId}:manifest:2`,
    payload: manifestTwo,
  });

  const result = await selectStageContextFromStore({
    tab,
    baseContext: baseContext({ storyId }),
    checkpointRevision: 1,
    manifestRevision: 1,
    sources: { requiredEvidence: ["ev-one"] },
  });
  assert.equal(result.context.checkpoint.revision, 1);
  assert.equal(result.context.checkpoint.summary, "CHECKPOINT_REVISION_ONE");
  assert.deepEqual(
    result.context.data.evidenceManifest.items.map((entry) => entry.evidenceId),
    ["ev-one"],
  );
  assert.equal(result.canonical.includes("CHECKPOINT_REVISION_TWO"), false);
  assert.equal(result.canonical.includes("ev-two"), false);

  await assert.rejects(
    selectStageContextFromStore({
      tab,
      baseContext: baseContext({ storyId }),
      checkpointRevision: 1,
      manifestRevision: 1,
      sources: {
        evidenceManifests: [manifest(storyId, [evidenceItem("ev-injected")])],
      },
    }),
    (error) => {
      assert.equal(error.code, "WORKFLOW_V2_CONTEXT_SOURCE_OVERRIDE_FORBIDDEN");
      assert.equal(error.details.field, "sources.evidenceManifests");
      return true;
    },
  );

  const mismatchedStore = {
    async readRevision({ payloadSchemaId }) {
      if (payloadSchemaId === WORKFLOW_V2_SCHEMA_IDS.workflowCheckpoint) {
        return {
          storyId,
          payloadSchemaId,
          revision: 2,
          envelopeSha256: "a".repeat(64),
          payload: checkpoint(storyId, 2),
        };
      }
      return {
        storyId,
        payloadSchemaId,
        revision: 1,
        envelopeSha256: "b".repeat(64),
        payload: manifestOne,
      };
    },
  };
  await assert.rejects(
    selectStageContextFromStore({
      tab,
      baseContext: baseContext({ storyId }),
      checkpointRevision: 1,
      manifestRevision: 1,
      sources: {},
      envelopeStore: mismatchedStore,
    }),
    (error) => {
      assert.equal(error.code, "WORKFLOW_V2_CONTEXT_SOURCE_IDENTITY_MISMATCH");
      assert.equal(error.details.expectedRevision, 1);
      assert.equal(error.details.actualRevision, 2);
      return true;
    },
  );

  const payloadStoryMismatchStore = {
    async readRevision({ payloadSchemaId }) {
      if (payloadSchemaId === WORKFLOW_V2_SCHEMA_IDS.workflowCheckpoint) {
        return {
          storyId,
          payloadSchemaId,
          revision: 1,
          envelopeSha256: "c".repeat(64),
          payload: checkpoint("another-story", 1),
        };
      }
      return {
        storyId,
        payloadSchemaId,
        revision: 1,
        envelopeSha256: "d".repeat(64),
        payload: manifest("another-story", [evidenceItem("ev-other-story")]),
      };
    },
  };
  await assert.rejects(
    selectStageContextFromStore({
      tab,
      baseContext: baseContext({ storyId: "another-story" }),
      checkpointRevision: 1,
      manifestRevision: 1,
      sources: {},
      envelopeStore: payloadStoryMismatchStore,
    }),
    (error) => {
      assert.equal(error.code, "WORKFLOW_V2_CONTEXT_SOURCE_IDENTITY_MISMATCH");
      assert.equal(error.details.expectedStoryId, storyId);
      assert.equal(error.details.payloadStoryId, "another-story");
      return true;
    },
  );

  await assert.rejects(
    selectStageContextFromStore({
      tab,
      baseContext: baseContext({ storyId }),
      checkpointRevision: 1,
      sources: {},
    }),
    (error) => error instanceof WorkflowV2ContextSelectionError,
  );
});
