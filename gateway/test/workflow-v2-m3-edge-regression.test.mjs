import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  createQueuedMessage,
  ensureQueuedMessageRuntimeIdentity,
  queuedMessageToSendTurn,
} from "../services/devbench/conversation/queued-message.js";
import {
  assertWorkflowV2CompatibilityDispatch,
  buildLegacyEvidenceManifest,
  prepareWorkflowV2CompatibilityDispatch,
  recordWorkflowV2CompatibilityResult,
} from "../services/devbench/workflow-v2/compatibility-dispatch.js";
import {
  canonicalJson,
  canonicalSha256,
} from "../services/devbench/workflow-v2/envelope-store.js";
import {
  resolveCompatibilityStage,
} from "../services/devbench/workflow-v2/prompt-v2-rollout.js";
import { WORKFLOW_V2_SCHEMA_IDS } from "../services/devbench/workflow-v2/schema-registry.js";

const rolloutConfig = {
  workflowV2: {
    featureFlags: { promptV2: true },
    promptV2Rollout: { percentage: 100, salt: "m3-edge", storyIds: [], providers: [] },
  },
};

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

test("v2 持久排队消息冻结 task/attempt/user 三元身份，legacy envelope 仍可补齐升级", () => {
  const ids = ["task-frozen", "attempt-frozen", "user-frozen"];
  const queued = createQueuedMessage({
    content: "生成专家报告",
    displayContent: "生成专家报告",
    messageInput: { text: "生成专家报告" },
    workflowKind: "report",
    effectiveReportMode: "expert",
  });
  const frozen = ensureQueuedMessageRuntimeIdentity(queued, {
    storyId: "story-queue-v2",
    idFactory: () => ids.shift(),
  });
  assert.equal(frozen.deviceRuntimeTaskId, "task-frozen");
  assert.equal(frozen.workflowV2AttemptId, "attempt-frozen");
  assert.equal(frozen.workflowV2UserMessageId, "user-frozen");

  const replay = ensureQueuedMessageRuntimeIdentity(JSON.parse(JSON.stringify(frozen)), {
    storyId: "story-queue-v2",
    idFactory: () => { throw new Error("冻结身份重试时不得重新生成 ID"); },
  });
  assert.deepEqual(replay, frozen);
  assert.deepEqual(queuedMessageToSendTurn(replay).options, {
    conversation: {
      displayContent: "生成专家报告",
      messageInput: { text: "生成专家报告" },
    },
    workflowKind: "report",
    deviceRuntimeRequestId: "story:story-queue-v2:task-frozen",
    deviceRuntimeTaskId: "task-frozen",
    workflowV2AttemptId: "attempt-frozen",
    workflowV2UserMessageId: "user-frozen",
    effectiveReportMode: "expert",
    fromPersistentQueue: true,
  });

  const legacyIds = ["attempt-upgraded", "user-upgraded"];
  const upgraded = ensureQueuedMessageRuntimeIdentity({
    content: "旧持久消息",
    displayContent: "旧持久消息",
    messageInput: { text: "旧持久消息" },
    deviceRuntimeTaskId: "legacy-task",
    deviceRuntimeRequestId: "story:story-queue-v2:legacy-task",
  }, {
    storyId: "story-queue-v2",
    idFactory: () => legacyIds.shift(),
  });
  assert.equal(upgraded.deviceRuntimeTaskId, "legacy-task");
  assert.equal(upgraded.deviceRuntimeRequestId, "story:story-queue-v2:legacy-task");
  assert.equal(upgraded.workflowV2AttemptId, "attempt-upgraded");
  assert.equal(upgraded.workflowV2UserMessageId, "user-upgraded");
});

test("group verify/report 进入生产精简阶段，出队时冻结的 effectiveReportMode 决定报告 stage", () => {
  const groupTab = { id: "story-group", groupId: "group-1", workflow: { phase: "verifying" } };
  assert.equal(resolveCompatibilityStage({ tab: groupTab, workflowKind: "verify" }), "VERIFY_EXECUTE");
  assert.equal(resolveCompatibilityStage({ tab: groupTab, workflowKind: "report", reportMode: "expert" }), "REPORT_EXPERT");

  const queued = createQueuedMessage({
    content: "生成报告",
    effectiveReportMode: "expert",
  });
  const request = queuedMessageToSendTurn(JSON.parse(JSON.stringify(queued)));
  const liveTab = { id: "story-single", reportMode: "short", workflow: { phase: "reporting" } };
  assert.equal(request.options.effectiveReportMode, "expert");
  assert.equal(resolveCompatibilityStage({
    tab: liveTab,
    workflowKind: "report",
    reportMode: request.options.effectiveReportMode,
  }), "REPORT_EXPERT");
  assert.equal(resolveCompatibilityStage({ tab: liveTab, workflowKind: "report" }), "REPORT_SHORT");
});

function extractPrivateBuildPrompt() {
  const source = fs.readFileSync(new URL("../services/agent-runner.js", import.meta.url), "utf8");
  const start = source.indexOf("function buildPrompt(task, skill)");
  const end = source.indexOf("function broadcastLoginPrompt", start);
  assert.ok(start >= 0 && end > start, "agent-runner buildPrompt guard must exist");
  const implementation = source.slice(start, end);
  return Function(
    "createHash",
    "buildContextBlock",
    `"use strict"; ${implementation}; return buildPrompt;`,
  )(createHash, () => { throw new Error("compatibility 不得进入 legacy context builder"); });
}

test("agent-runner compatibility guard 要求 frozen hash/context 且禁止 session/streaming/image", () => {
  const buildPrompt = extractPrivateBuildPrompt();
  const prompt = "COMPATIBILITY\n<CONTEXT_JSON>{}</CONTEXT_JSON>";
  const valid = {
    promptMode: "compatibility",
    promptOverride: prompt,
    promptSha256: sha256(prompt),
    cliSessionId: null,
    streamingInput: false,
    imagePaths: [],
    telemetryContext: {
      contextId: "ctx-frozen",
      contextRevision: 3,
      contextHash: "a".repeat(64),
      promptMode: "compatibility",
    },
  };
  assert.equal(buildPrompt(valid), prompt);

  for (const mutation of [
    { promptSha256: "b".repeat(64) },
    { cliSessionId: "resume-forbidden" },
    { streamingInput: true },
    { imagePaths: ["hidden.png"] },
    { telemetryContext: { ...valid.telemetryContext, contextId: "" } },
    { telemetryContext: { ...valid.telemetryContext, contextRevision: 0 } },
    { telemetryContext: { ...valid.telemetryContext, contextHash: "bad" } },
  ]) {
    assert.throws(
      () => buildPrompt({ ...valid, ...mutation }),
      (error) => error.code === "WORKFLOW_V2_COMPATIBILITY_PROMPT_INVALID",
    );
  }
});

function dispatchTab() {
  return {
    id: "story-m3-edge-dispatch",
    title: "M3 附件冻结",
    primaryProjectId: "project-main",
    workflow: { phase: "triaging", riskLevel: "MEDIUM" },
    tbContext: {
      tbTaskId: "tb-m3-edge",
      title: "原始标题",
      description: "原始描述",
      comments: [],
      attachments: [],
      sourceCoverage: {
        comments: { available: true, complete: true },
        attachments: { available: true, complete: true },
      },
    },
    materials: [],
  };
}

function dispatchHarness(tab) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "workflow-v2-m3-edge-"));
  fs.mkdirSync(path.join(root, "archives"), { recursive: true });
  fs.mkdirSync(path.join(root, "materials"), { recursive: true });
  fs.mkdirSync(path.join(root, "project"), { recursive: true });
  const streams = new Map(Object.values(WORKFLOW_V2_SCHEMA_IDS).map((id) => [id, []]));
  const storageApi = {
    getTab: () => tab,
    updateTab: (_storyId, patch) => Object.assign(tab, structuredClone(patch)),
    getConversation: () => tab.__conversation || { nodes: [] },
    tabProjectPaths: () => [{ role: "primary", projectId: "project-main", path: path.join(root, "project") }],
    getStoryStoragePaths: () => ({ storyDirectory: root, attachmentDirectory: path.join(root, "archives") }),
    validateStoryStorageTarget: (_tab, target) => {
      assert.equal(path.resolve(target).startsWith(`${path.resolve(root)}${path.sep}`), true);
      return true;
    },
  };
  function envelope(payloadSchemaId, payload, idempotencyKey, revision) {
    const payloadSha256 = canonicalSha256(payload);
    const value = {
      schemaVersion: "workflow-envelope-v2",
      storyId: tab.id,
      recordId: payload.contextId || `${payloadSchemaId}:${revision}`,
      contextId: payload.contextId || null,
      revision,
      idempotencyKey,
      payloadSchemaId,
      payloadSha256,
      operationArgsSha256: null,
      previousEnvelopeSha256: null,
      createdAt: new Date(Date.UTC(2026, 7, 7, 12, 0, revision)).toISOString(),
      payload: structuredClone(payload),
      envelopeSha256: canonicalSha256({ payloadSchemaId, revision, idempotencyKey, payloadSha256 }),
    };
    streams.get(payloadSchemaId).push(value);
    return { envelope: value, replayed: false };
  }
  const readEnvelopes = async ({ payloadSchemaId }) => structuredClone(streams.get(payloadSchemaId) || []);
  const appendCheckpoint = async ({ revision, idempotencyKey, payload }) => (
    envelope(WORKFLOW_V2_SCHEMA_IDS.workflowCheckpoint, payload, idempotencyKey, revision)
  );
  const appendManifest = async ({ revision, idempotencyKey, payload }) => (
    envelope(WORKFLOW_V2_SCHEMA_IDS.evidenceManifest, payload, idempotencyKey, revision)
  );
  const appendContext = async ({ payload }) => (
    envelope(WORKFLOW_V2_SCHEMA_IDS.stageContext, payload, payload.idempotencyKey, payload.revision)
  );
  const selectFromStore = async ({ baseContext, checkpointRevision, manifestRevision, sources }) => {
    const checkpoint = streams.get(WORKFLOW_V2_SCHEMA_IDS.workflowCheckpoint)
      .find((item) => item.revision === checkpointRevision)?.payload;
    const manifest = streams.get(WORKFLOW_V2_SCHEMA_IDS.evidenceManifest)
      .find((item) => item.revision === manifestRevision)?.payload;
    const selectedSources = JSON.parse(JSON.stringify(sources));
    const context = {
      ...structuredClone(baseContext),
      checkpoint: structuredClone(checkpoint),
      data: {
        ...selectedSources,
        evidenceManifest: structuredClone(manifest),
      },
    };
    return {
      context,
      canonical: canonicalJson(context),
      contextHash: canonicalSha256(context),
      budget: { total: Array.from(canonicalJson(context)).length },
      selection: { droppedFields: [] },
    };
  };
  return {
    root,
    streams,
    dependencies: {
      storageApi,
      fsApi: fs,
      readEnvelopes,
      appendCheckpoint,
      appendManifest,
      appendContext,
      selectFromStore,
    },
  };
}

function prepareArgs(tab, dependencies, taskId, attachments = []) {
  const content = "只处理当前轮附件与已冻结事实";
  return {
    tab,
    content,
    workflowKind: "triage",
    engine: "codex",
    taskId,
    attemptId: `${taskId}-attempt`,
    userMessageId: `${taskId}-message`,
    conversation: { messageInput: { text: content, attachments } },
    repositoryPathResolution: { mappedContent: content },
    config: rolloutConfig,
    ...dependencies,
  };
}

test("当前消息 storydev 附件进入 manifest 并冻结内容 sha，无效引用为 MISSING；fresh source 追加 revision", async () => {
  const tab = dispatchTab();
  const harness = dispatchHarness(tab);
  const currentFile = path.join(harness.root, "archives", "current.txt");
  const materialFile = path.join(harness.root, "materials", "new.log");
  fs.writeFileSync(currentFile, "first immutable bytes", "utf8");
  const attachments = [
    { id: "turn-current", name: "current.txt", reference: "storydev:/archives/current.txt" },
    { id: "turn-invalid", name: "escape.txt", reference: "storydev:/archives/../secret.txt" },
  ];
  try {
    const first = await prepareWorkflowV2CompatibilityDispatch(
      prepareArgs(tab, harness.dependencies, "task-source-1", attachments),
    );
    const manifest1 = harness.streams.get(WORKFLOW_V2_SCHEMA_IDS.evidenceManifest)[0];
    const available = manifest1.payload.items.find((item) => item.name === "current.txt");
    const missing = manifest1.payload.items.find((item) => item.name === "escape.txt");
    assert.equal(first.manifestRevision, 1);
    assert.equal(available.availability, "AVAILABLE");
    assert.equal(available.required, true);
    assert.match(available.contentRef, /^storydev:\/workflow-v2\/evidence-blobs\/[a-f0-9]{64}\.blob$/);
    assert.equal(available.sha256, sha256(Buffer.from("first immutable bytes")));
    assert.equal(
      fs.readFileSync(path.join(harness.root, ...available.contentRef.slice("storydev:/".length).split("/")), "utf8"),
      "first immutable bytes",
    );
    assert.equal(missing.availability, "MISSING");
    assert.equal(missing.required, true);
    assert.equal(missing.contentRef, null);

    fs.writeFileSync(currentFile, "second bytes must not mutate revision one", "utf8");
    assert.equal(
      first.context.data.evidenceManifest.items.find((item) => item.name === "current.txt").sha256,
      sha256(Buffer.from("first immutable bytes")),
    );

    tab.tbContext.comments.push({ id: "fresh-comment", text: "新 TB 事实", updatedAt: "2026-08-07T12:00:00Z" });
    const second = await prepareWorkflowV2CompatibilityDispatch(
      prepareArgs(tab, harness.dependencies, "task-source-2", attachments),
    );
    assert.equal(second.manifestRevision, 2);
    assert.equal(harness.streams.get(WORKFLOW_V2_SCHEMA_IDS.evidenceManifest).length, 2);
    assert.equal(
      second.context.data.evidenceManifest.items.find((item) => item.name === "current.txt").sha256,
      sha256(Buffer.from("second bytes must not mutate revision one")),
    );

    fs.writeFileSync(materialFile, "new material", "utf8");
    tab.materials.push({ id: "fresh-material", name: "new.log", relPath: "storydev:/materials/new.log" });
    const third = await prepareWorkflowV2CompatibilityDispatch(
      prepareArgs(tab, harness.dependencies, "task-source-3", attachments),
    );
    assert.equal(third.manifestRevision, 3);
    assert.equal(harness.streams.get(WORKFLOW_V2_SCHEMA_IDS.evidenceManifest).length, 3);
    assert.equal(third.context.data.evidenceManifest.items.some((item) => (
      item.name === "new.log" && item.availability === "AVAILABLE"
    )), true);
  } finally {
    fs.rmSync(harness.root, { recursive: true, force: true });
  }
});

test("本轮 required attachment 成为对话历史后，结果结算不得把它降级为 optional", async () => {
  const tab = dispatchTab();
  const harness = dispatchHarness(tab);
  const currentFile = path.join(harness.root, "archives", "required.txt");
  fs.writeFileSync(currentFile, "required evidence", "utf8");
  const attachment = {
    id: "turn-required",
    name: "required.txt",
    reference: "storydev:/archives/required.txt",
  };
  try {
    const dispatch = await prepareWorkflowV2CompatibilityDispatch(
      prepareArgs(tab, harness.dependencies, "task-required-carry", [attachment]),
    );
    const preparedItem = dispatch.context.data.evidenceManifest.items
      .find((item) => item.name === "required.txt");
    assert.equal(preparedItem.required, true);

    tab.__conversation = {
      revision: 1,
      headId: "turn-required-node",
      activePathIds: ["turn-required-node"],
      nodes: [{
        id: "turn-required-node",
        parentId: null,
        role: "user",
        input: { attachments: [attachment] },
      }],
    };
    const recorded = await recordWorkflowV2CompatibilityResult({
      tab,
      dispatch,
      report: "## 甄别结论\n结论：本侧问题\n原因：附件证据\n依据：required.txt\n未读：无",
      markerKind: "triage_is_bug",
      ...harness.dependencies,
    });
    const settledItem = recorded.manifest.payload.items.find((item) => item.name === "required.txt");
    assert.equal(settledItem.required, true);
    assert.equal(recorded.manifest.revision, 1, "required bit 稳定时不得制造无意义 manifest revision");
    assert.equal(harness.streams.get(WORKFLOW_V2_SCHEMA_IDS.evidenceManifest).length, 1);
  } finally {
    fs.rmSync(harness.root, { recursive: true, force: true });
  }
});

test("当前轮 folder attachment 在 compatibility prepare 阶段 typed fail-closed", async () => {
  const tab = dispatchTab();
  const harness = dispatchHarness(tab);
  try {
    await assert.rejects(
      prepareWorkflowV2CompatibilityDispatch(prepareArgs(tab, harness.dependencies, "task-current-folder", [{
        id: "folder-current",
        kind: "folder",
        name: "unexpanded-folder",
        reference: "storydev:/archives/unexpanded-folder",
      }])),
      (error) => error.code === "WORKFLOW_V2_COMPATIBILITY_FOLDER_ATTACHMENT_UNSUPPORTED",
    );
    assert.equal(harness.streams.get(WORKFLOW_V2_SCHEMA_IDS.stageContext).length, 0);
  } finally {
    fs.rmSync(harness.root, { recursive: true, force: true });
  }
});

test("evidence identity 冲突 fail-closed，完全重复幂等，同 sha 多 ID 重排仍 canonical", () => {
  const tab = dispatchTab();
  const harness = dispatchHarness(tab);
  for (const name of ["a.log", "b.log"]) {
    fs.writeFileSync(path.join(harness.root, "materials", name), `${name} bytes`, "utf8");
  }
  try {
    tab.materials = [
      {
        id: "stable-external-id",
        name: "a.log",
        relPath: "storydev:/materials/a.log",
        sha256: "a".repeat(64),
        size: 11,
      },
      {
        id: "stable-external-id",
        name: "b.log",
        relPath: "storydev:/materials/b.log",
        sha256: "b".repeat(64),
        size: 22,
      },
    ];
    assert.throws(
      () => buildLegacyEvidenceManifest(tab, harness.dependencies),
      (error) => /IDENTITY_CONFLICT/.test(String(error.code || "")),
    );

    const duplicate = {
      id: "exact-duplicate",
      name: "a.log",
      relPath: "storydev:/materials/a.log",
      sha256: "c".repeat(64),
      size: 11,
    };
    tab.materials = [duplicate, structuredClone(duplicate)];
    const deduped = buildLegacyEvidenceManifest(tab, harness.dependencies);
    assert.equal(deduped.items.filter((item) => item.name === "a.log").length, 1);

    tab.materials = [
      { id: "external-b", name: "b.log", relPath: "storydev:/materials/b.log", sha256: "d".repeat(64), size: 33 },
      { id: "external-a", name: "a.log", relPath: "storydev:/materials/a.log", sha256: "d".repeat(64), size: 33 },
    ];
    const forward = buildLegacyEvidenceManifest(tab, harness.dependencies);
    tab.materials.reverse();
    const reversed = buildLegacyEvidenceManifest(tab, harness.dependencies);
    assert.equal(canonicalJson(forward), canonicalJson(reversed));
    assert.equal(canonicalSha256(forward), canonicalSha256(reversed));
  } finally {
    fs.rmSync(harness.root, { recursive: true, force: true });
  }
});

test("conversation manifest 只读取 activePathIds 当前链，切换 head 后才纳入旧分支附件", () => {
  const tab = dispatchTab();
  const harness = dispatchHarness(tab);
  fs.writeFileSync(path.join(harness.root, "archives", "active.log"), "active", "utf8");
  fs.writeFileSync(path.join(harness.root, "archives", "stale.log"), "stale", "utf8");
  const activeNode = {
    id: "user-active",
    role: "user",
    input: { attachments: [{ id: "active-attachment", name: "active.log", reference: "storydev:/archives/active.log" }] },
  };
  const staleNode = {
    id: "user-stale",
    role: "user",
    input: { attachments: [{ id: "stale-attachment", name: "stale.log", reference: "storydev:/archives/stale.log" }] },
  };
  try {
    tab.__conversation = {
      nodes: [staleNode, activeNode],
      headId: activeNode.id,
      activePathIds: [activeNode.id],
    };
    const activeManifest = buildLegacyEvidenceManifest(tab, harness.dependencies);
    assert.equal(activeManifest.items.some((item) => item.name === "active.log"), true);
    assert.equal(activeManifest.items.some((item) => item.name === "stale.log"), false);

    tab.__conversation = {
      nodes: [staleNode, activeNode],
      headId: staleNode.id,
      activePathIds: [staleNode.id],
    };
    const switchedManifest = buildLegacyEvidenceManifest(tab, harness.dependencies);
    assert.equal(switchedManifest.items.some((item) => item.name === "active.log"), false);
    assert.equal(switchedManifest.items.some((item) => item.name === "stale.log"), true);
  } finally {
    fs.rmSync(harness.root, { recursive: true, force: true });
  }
});

test("edit-and-resend 在落新节点前按目标父链投影附件，旧 target 与 descendants 不得进入冻结 manifest", () => {
  const tab = dispatchTab();
  const harness = dispatchHarness(tab);
  for (const [name, body] of [
    ["ancestor.log", "ancestor"],
    ["old-target.log", "target"],
    ["old-descendant.log", "descendant"],
    ["replacement.log", "replacement"],
  ]) fs.writeFileSync(path.join(harness.root, "archives", name), body, "utf8");
  const attachment = (id, name) => ({ id, name, reference: `storydev:/archives/${name}` });
  tab.__conversation = {
    revision: 7,
    headId: "user-descendant",
    activePathIds: ["user-root", "assistant-one", "user-target", "assistant-two", "user-descendant"],
    nodes: [
      { id: "user-root", parentId: null, role: "user", input: { attachments: [attachment("ancestor", "ancestor.log")] } },
      { id: "assistant-one", parentId: "user-root", role: "assistant" },
      { id: "user-target", parentId: "assistant-one", role: "user", input: { attachments: [attachment("target", "old-target.log")] } },
      { id: "assistant-two", parentId: "user-target", role: "assistant" },
      { id: "user-descendant", parentId: "assistant-two", role: "user", input: { attachments: [attachment("descendant", "old-descendant.log")] } },
    ],
  };
  const replacement = attachment("replacement", "replacement.log");
  try {
    const middleEdit = buildLegacyEvidenceManifest(tab, {
      ...harness.dependencies,
      turnAttachments: [replacement],
      conversationRequest: { mode: "edit", messageId: "user-target", expectedRevision: 7 },
    });
    assert.equal(middleEdit.items.some((item) => item.name === "ancestor.log"), true);
    assert.equal(middleEdit.items.some((item) => item.name === "replacement.log" && item.required), true);
    assert.equal(middleEdit.items.some((item) => item.name === "old-target.log"), false);
    assert.equal(middleEdit.items.some((item) => item.name === "old-descendant.log"), false);

    const rootEdit = buildLegacyEvidenceManifest(tab, {
      ...harness.dependencies,
      turnAttachments: [replacement],
      conversationRequest: { mode: "edit", messageId: "user-root", expectedRevision: 7 },
    });
    assert.equal(rootEdit.items.some((item) => item.name === "ancestor.log"), false);
    assert.equal(rootEdit.items.some((item) => item.name === "old-target.log"), false);
    assert.equal(rootEdit.items.some((item) => item.name === "old-descendant.log"), false);
    assert.equal(rootEdit.items.some((item) => item.name === "replacement.log" && item.required), true);
  } finally {
    fs.rmSync(harness.root, { recursive: true, force: true });
  }
});

test("report prepare barrier 后 live tab.reportMode 改变必须 stale，Provider 保持 0 次", async () => {
  const tab = dispatchTab();
  tab.workflow.phase = "reporting";
  tab.reportMode = "short";
  const harness = dispatchHarness(tab);
  const content = "生成冻结的简短报告";
  const args = {
    tab,
    content,
    workflowKind: "report",
    reportMode: "short",
    engine: "codex",
    taskId: "task-report-mode-race",
    attemptId: "attempt-report-mode-race",
    userMessageId: "message-report-mode-race",
    conversation: { messageInput: { text: content } },
    repositoryPathResolution: { mappedContent: content },
    config: rolloutConfig,
    ...harness.dependencies,
  };
  try {
    const dispatch = await prepareWorkflowV2CompatibilityDispatch(args);
    assert.equal(dispatch.stageId, "REPORT_SHORT");
    tab.reportMode = "expert";
    let providerCalls = 0;
    assert.throws(
      () => {
        assertWorkflowV2CompatibilityDispatch({ dispatch, ...args });
        providerCalls += 1;
      },
      (error) => error.code === "WORKFLOW_V2_COMPATIBILITY_DISPATCH_STALE",
    );
    assert.equal(providerCalls, 0);
  } finally {
    fs.rmSync(harness.root, { recursive: true, force: true });
  }
});

test("VERIFY 实际取得设备租约后重做 assessment，漂移时阻断且新快照绑定 dispatch", async () => {
  const source = fs.readFileSync(new URL("../services/devbench/index.js", import.meta.url), "utf8");
  const start = source.indexOf("export async function sendTurnWithDeviceRuntime");
  const end = source.indexOf("export function sendTurn(", start);
  const runtime = source.slice(start, end);
  const acquired = runtime.indexOf('acquisition.status !== "acquired"');
  const reassess = runtime.indexOf("inspectVerifyDeviceTarget(dispatchTab", acquired);
  const dispatch = runtime.indexOf("sendTurnAtDispatchBoundary(dispatchTab", reassess);
  assert.ok(acquired >= 0 && reassess > acquired && dispatch > reassess);
  assert.match(runtime.slice(reassess, dispatch), /freshAssessment\.status === "offline"/);
  assert.match(runtime.slice(reassess, dispatch), /liveSerial !== serial/);
  assert.match(runtime.slice(reassess, dispatch), /liveSerial !== String\(freshAssessment\.serial/);
  assert.match(runtime.slice(reassess, dispatch), /WORKFLOW_V2_COMPATIBILITY_DEVICE_ASSESSMENT_STALE/);
  assert.match(runtime.slice(reassess, dispatch), /verifyDeviceAssessment:\s*freshAssessment/);

  const tab = dispatchTab();
  tab.workflow.phase = "verifying";
  tab.deviceSerial = "device-fresh";
  const harness = dispatchHarness(tab);
  const content = "执行冻结验收";
  const args = {
    tab,
    content,
    workflowKind: "verify",
    engine: "codex",
    taskId: "task-verify-freshness",
    attemptId: "attempt-verify-freshness",
    userMessageId: "message-verify-freshness",
    conversation: { messageInput: { text: content } },
    repositoryPathResolution: { mappedContent: content },
    deviceRuntimeLease: {
      serial: "device-fresh",
      leaseId: "lease-1",
      fencingToken: 7,
      storyId: tab.id,
      expiresAt: 4_102_444_800_000,
    },
    verifyDeviceAssessment: {
      serial: "device-fresh",
      status: "matched",
      checkedAt: 100,
      model: "AVATR 8678",
      brand: "AVATR",
    },
    config: rolloutConfig,
    ...harness.dependencies,
  };
  try {
    const frozen = await prepareWorkflowV2CompatibilityDispatch(args);
    assert.equal(frozen.stageId, "VERIFY_EXECUTE");
    assert.throws(
      () => assertWorkflowV2CompatibilityDispatch({
        dispatch: frozen,
        ...args,
        verifyDeviceAssessment: { ...args.verifyDeviceAssessment, checkedAt: 101 },
      }),
      (error) => error.code === "WORKFLOW_V2_COMPATIBILITY_DISPATCH_STALE",
    );
    const retryArgs = {
      ...args,
      deviceRuntimeLease: {
        serial: "device-fresh",
        leaseId: "lease-2",
        fencingToken: 8,
        storyId: tab.id,
        expiresAt: 4_102_444_800_000,
      },
      verifyDeviceAssessment: { ...args.verifyDeviceAssessment, checkedAt: 101 },
    };
    const reacquired = await prepareWorkflowV2CompatibilityDispatch(retryArgs);
    assert.equal(reacquired.replayed, true, "Provider 前重试应复用相同语义 StageContext");
    assert.equal(reacquired.contextHash, frozen.contextHash);
    assert.equal(assertWorkflowV2CompatibilityDispatch({ dispatch: reacquired, ...retryArgs }), true);
  } finally {
    fs.rmSync(harness.root, { recursive: true, force: true });
  }
});

test("VERIFY prepare 后可信 story/root 控制元数据逐项漂移均在 Provider 前 typed stale", async () => {
  const tab = dispatchTab();
  tab.workflow.phase = "verifying";
  tab.workflow.riskLevel = "MEDIUM";
  tab.deviceSerial = "device-control-drift";
  tab.flavor = "avatr8678ProdRelease";
  tab.versionName = "1.0.0";
  tab.primaryProjectId = "project-main";
  const harness = dispatchHarness(tab);
  const content = "执行冻结控制元数据的验收";
  const args = {
    tab,
    content,
    workflowKind: "verify",
    engine: "codex",
    taskId: "ta<REDACTED_API_KEY>",
    attemptId: "attempt-verify-control-drift",
    userMessageId: "message-verify-control-drift",
    conversation: { messageInput: { text: content } },
    repositoryPathResolution: { mappedContent: content },
    deviceRuntimeLease: {
      serial: "device-control-drift",
      leaseId: "lease-control-drift",
      fencingToken: 9,
      storyId: tab.id,
      expiresAt: 4_102_444_800_000,
    },
    verifyDeviceAssessment: {
      serial: "device-control-drift",
      status: "matched",
      checkedAt: 300,
      model: "AVATR 8678",
      brand: "AVATR",
    },
    config: rolloutConfig,
    ...harness.dependencies,
  };
  try {
    const frozen = await prepareWorkflowV2CompatibilityDispatch(args);
    const mainRoot = frozen.context.scope.roots.find((root) => root.kind === "MAIN");
    assert.equal(frozen.stageId, "VERIFY_EXECUTE");
    assert.equal(mainRoot.projectId, "project-main");
    assert.equal(mainRoot.flavor, "avatr8678ProdRelease");
    assert.equal(mainRoot.versionName, "1.0.0");

    const drifts = [
      {
        field: "flavor",
        mutate: () => { tab.flavor = "avatr8678DevRelease"; },
        restore: () => { tab.flavor = "avatr8678ProdRelease"; },
      },
      {
        field: "versionName",
        mutate: () => { tab.versionName = "2.0.0"; },
        restore: () => { tab.versionName = "1.0.0"; },
      },
      {
        field: "title",
        mutate: () => { tab.title = "已在 barrier 后改变的标题"; },
        restore: () => { tab.title = "M3 附件冻结"; },
      },
      {
        field: "riskLevel",
        mutate: () => { tab.workflow.riskLevel = "HIGH"; },
        restore: () => { tab.workflow.riskLevel = "MEDIUM"; },
      },
      {
        field: "primaryProjectId",
        mutate: () => { tab.primaryProjectId = "project-rebound"; },
        restore: () => { tab.primaryProjectId = "project-main"; },
      },
    ];
    let providerCalls = 0;
    for (const drift of drifts) {
      drift.mutate();
      assert.throws(
        () => {
          assertWorkflowV2CompatibilityDispatch({ dispatch: frozen, ...args });
          providerCalls += 1;
        },
        (error) => error.code === "WORKFLOW_V2_COMPATIBILITY_DISPATCH_STALE"
          && error.details?.bindingMatches === false,
        `${drift.field} drift must fail with a typed binding mismatch`,
      );
      drift.restore();
      assert.equal(
        assertWorkflowV2CompatibilityDispatch({ dispatch: frozen, ...args }),
        true,
        `${drift.field} restore must recover the exact frozen binding`,
      );
    }
    assert.equal(providerCalls, 0);
  } finally {
    fs.rmSync(harness.root, { recursive: true, force: true });
  }
});

test("VERIFY/REPORT_EXPERT 当前会话附件贯穿 manifest、StageContext 与 Prompt", async () => {
  const tab = dispatchTab();
  tab.workflow.phase = "verifying";
  tab.deviceSerial = "device-attachment";
  const harness = dispatchHarness(tab);
  const evidencePath = path.join(harness.root, "archives", "acceptance.png");
  fs.writeFileSync(evidencePath, Buffer.from("fake-image-evidence"));
  const attachment = {
    id: "acceptance-current",
    name: "acceptance.png",
    reference: "storydev:/archives/acceptance.png",
  };
  const verifyContent = "执行带当前附件的验收";
  const sharedIdentity = {
    tab,
    engine: "codex",
    conversation: { messageInput: { text: verifyContent, attachments: [attachment] } },
    deviceRuntimeLease: {
      serial: "device-attachment",
      leaseId: "lease-attachment",
      fencingToken: 8,
      storyId: tab.id,
      expiresAt: 4_102_444_800_000,
    },
    verifyDeviceAssessment: { serial: "device-attachment", status: "matched", checkedAt: 200, model: "AVATR 8678" },
    config: rolloutConfig,
    ...harness.dependencies,
  };
  try {
    const verify = await prepareWorkflowV2CompatibilityDispatch({
      ...sharedIdentity,
      content: verifyContent,
      workflowKind: "verify",
      taskId: "task-verify-attachment",
      attemptId: "attempt-verify-attachment",
      userMessageId: "message-verify-attachment",
      repositoryPathResolution: { mappedContent: verifyContent },
    });
    const verifyItem = verify.context.data.evidenceManifest.items.find((item) => item.name === "acceptance.png");
    assert.equal(verifyItem.required, true);
    assert.equal(verifyItem.availability, "AVAILABLE");
    assert.match(verifyItem.contentRef, /^storydev:\/workflow-v2\/evidence-blobs\/[a-f0-9]{64}\.blob$/);
    assert.match(verify.prompt, new RegExp(verifyItem.sha256));

    tab.workflow.phase = "reporting";
    tab.reportMode = "expert";
    const reportContent = "生成带当前附件证据的专家报告";
    const report = await prepareWorkflowV2CompatibilityDispatch({
      ...sharedIdentity,
      content: reportContent,
      workflowKind: "report",
      reportMode: "expert",
      taskId: "task-report-attachment",
      attemptId: "attempt-report-attachment",
      userMessageId: "message-report-attachment",
      conversation: { messageInput: { text: reportContent, attachments: [attachment] } },
      repositoryPathResolution: { mappedContent: reportContent },
      deviceRuntimeLease: null,
      verifyDeviceAssessment: null,
    });
    assert.equal(report.stageId, "REPORT_EXPERT");
    const asset = report.context.data.assetManifest.items.find((item) => item.contentRef === verifyItem.contentRef);
    assert.ok(asset, "当前会话附件必须进入专家报告 assetManifest");
    assert.match(report.prompt, new RegExp(verifyItem.sha256));
    assert.match(report.prompt, /storydev:\/workflow-v2\/evidence-blobs\//);

    const indexSource = fs.readFileSync(new URL("../services/devbench/index.js", import.meta.url), "utf8");
    const boundaryStart = indexSource.indexOf("async function sendTurnAtDispatchBoundary");
    const boundaryEnd = indexSource.indexOf("export async function sendTurnWithDeviceRuntime", boundaryStart);
    const boundary = indexSource.slice(boundaryStart, boundaryEnd);
    assert.match(boundary, /conversation:\s*opts\.conversation \|\| \{\}/);
    assert.match(boundary, /prepareWorkflowV2CompatibilityDispatch\(\{/);
  } finally {
    fs.rmSync(harness.root, { recursive: true, force: true });
  }
});

test("compatibility preflight/settlement failure 保留持久队列并触发一次 blocked-head 收敛", () => {
  const source = fs.readFileSync(new URL("../services/devbench/index.js", import.meta.url), "utf8");
  const drainStart = source.indexOf("async function drainQueue(tabId)");
  const drainEnd = source.indexOf("export function scheduleTabQueueDrain", drainStart);
  const drain = source.slice(drainStart, drainEnd);
  assert.match(drain, /if \(started\?\.error\) \{/);
  assert.match(drain, /if \(started\.dropPersistentQueue === true\)/);
  assert.match(drain, /排队消息启动失败，已保留待重试/);
  const retainedLog = drain.indexOf("排队消息启动失败，已保留待重试");
  const normalRemoval = drain.indexOf("queueAfterStart.slice(1)");
  assert.ok(retainedLog >= 0 && normalRemoval > retainedLog, "preflight error must return before normal queue removal");

  const callbackStart = source.indexOf("const onTurnCallbackFailure");
  const callbackEnd = source.indexOf("const settleTurnPromise", callbackStart);
  const callbackFailure = source.slice(callbackStart, callbackEnd);
  assert.match(callbackFailure, /status:\s*"failed"/);
  assert.match(callbackFailure, /queueRetained:\s*true/);
  assert.match(callbackFailure, /compatibilitySettlementPersisted/);
  assert.match(callbackFailure, /await drainQueue\(tab\.id\)/);
});

test("callback failure 的 update/emit 再失败也必须终止吸收，并在 finally 释放两类租约", () => {
  const source = fs.readFileSync(new URL("../services/devbench/index.js", import.meta.url), "utf8");
  const callbackStart = source.indexOf("const onTurnCallbackFailure");
  const callbackEnd = source.indexOf("const settleTurnPromise", callbackStart);
  const callbackFailure = source.slice(callbackStart, callbackEnd);
  assert.match(callbackFailure, /try\s*\{/);
  assert.match(callbackFailure, /finally\s*\{/);
  assert.match(callbackFailure, /releaseAiWorktreeLease\(\)/);
  assert.match(callbackFailure, /releaseDeviceRuntimeLease\("turn_callback_failed"\)/);

  const settleEnd = source.indexOf("let activeRemoteAgentSessionId", callbackEnd);
  const settlement = source.slice(callbackEnd, settleEnd);
  assert.match(
    settlement,
    /promise\.then\(onTurnSuccess, onTurnFailure\)\.catch\(onTurnCallbackFailure\)\.catch\(/,
    "callback failure itself must be terminally absorbed so the turn promise cannot reject",
  );
});

test("pure-client compatibility 禁止 legacy distributed，protocol v2 只发送 frozen prompt/hash/context", () => {
  const source = fs.readFileSync(new URL("../services/devbench/index.js", import.meta.url), "utf8");
  const start = source.indexOf("const runRemoteCenterTurn = async");
  const end = source.indexOf("if (aiWorktreeLeaseLost || deviceRuntimeLeaseLost)", start);
  const remote = source.slice(start, end);
  const protocol = remote.indexOf("const protocol =");
  const legacyRequest = remote.indexOf("/api/devbench/remote-agent-run");
  assert.ok(protocol >= 0 && legacyRequest > protocol);
  const beforeLegacyRequest = remote.slice(protocol, legacyRequest);
  assert.match(beforeLegacyRequest, /workflowV2PromptTurn[\s\S]*protocol === "legacy"/);
  assert.match(beforeLegacyRequest, /WORKFLOW_V2_COMPATIBILITY_DISTRIBUTED_PROTOCOL_UNSAFE/);

  const v2Start = remote.indexOf("runRemoteAgentV2({");
  const v2End = remote.indexOf("});", v2Start);
  const v2Call = remote.slice(v2Start, v2End);
  assert.match(v2Call, /task:\s*promptOverride/);
  assert.match(v2Call, /promptSha256:\s*workflowV2PromptTurn \? promptObservation\.sha256 : ""/);
  assert.match(v2Call, /telemetryContext:\s*workflowV2PromptTurn \? frozenTelemetryContext : null/);
  assert.match(v2Call, /promptMode:\s*workflowV2PromptTurn \? opts\.workflowV2Dispatch\.promptMode : "legacy"/);
});
