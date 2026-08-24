import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "prompt-overlay-send-turn-"));
process.env.GATEWAY_DB_PATH = path.join(tempRoot, "gateway.db");
process.env.GATEWAY_CONFIG_PATH = path.join(tempRoot, "gateway.json");
process.env.DEVBENCH_CONFIG_PATH = path.join(tempRoot, "market.json");
process.env.DEVBENCH_STORE_DIR = path.join(tempRoot, "store");
process.env.AIEFFICIENCY_CLONE_PARENT = path.join(tempRoot, "clone-parent");
process.env.NODE_ENV = "test";
fs.writeFileSync(process.env.GATEWAY_CONFIG_PATH, JSON.stringify({
  codexEnabled: false,
  autoFallback: false,
  workDir: tempRoot,
  servers: { nodeId: "prompt-overlay-send-turn-test" },
  apiMaxToolIterations: 3,
  apiAgent: { workspaceIsolation: true, commandPolicy: "workspace" },
  teambition: { userCookie: "mock-cookie" },
  apiEngines: {
    deepseek: {
      enabled: true,
      name: "Mock DeepSeek",
      baseUrl: "https://prompt-overlay-provider.invalid",
      apiKey: "test-only-key",
      model: "mock-model",
      thinkingEnabled: false,
    },
  },
}), "utf8");

const store = await import("../services/devbench/store.js");
const configService = await import("../services/config.js");
const {
  freezePromptOverlayDecisionForQueue,
  sendTurn,
  sendTurnWithDeviceRuntime,
} = await import("../services/devbench/index.js");
const { readWorkflowV2Envelopes } = await import("../services/devbench/workflow-v2/envelope-store.js");
const { closeAppMarketMcpBridge } = await import("../services/appmarket-admin-mcp.js");

function git(args, cwd) {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

function providerResponse(finalResponse) {
  const encoder = new TextEncoder();
  const events = [
    { choices: [{ delta: { tool_calls: [{
      index: 0,
      id: "finish-overlay-triage",
      type: "function",
      function: { name: "finish_task", arguments: "" },
    }] } }] },
    { choices: [{ delta: { tool_calls: [{
      index: 0,
      function: { arguments: JSON.stringify({
        status: "completed",
        summary: "甄别完成",
        changes: [],
        verification: ["已核对故事点材料"],
        remaining: [],
        final_response: finalResponse,
      }) },
    }] } }] },
    { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
  ];
  return {
    ok: true,
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

async function waitFor(predicate, message, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(message);
}

test("真实 sendTurn 默认以 legacy 状态机执行生产 overlay Prompt，且不创建 Full V2 envelope/settlement", async () => {
  const repo = fs.mkdtempSync(path.join(tempRoot, "repo-"));
  const worktree = fs.mkdtempSync(path.join(tempRoot, "worktree-"));
  git(["init", "-q", "-b", "main"], repo);
  git(["config", "user.email", "test@example.com"], repo);
  git(["config", "user.name", "Test"], repo);
  fs.writeFileSync(path.join(repo, "README.md"), "prompt overlay integration\n", "utf8");
  git(["add", "README.md"], repo);
  git(["commit", "-q", "-m", "init"], repo);
  git(["worktree", "add", "-q", "-b", "story-prompt-overlay", worktree], repo);

  const projectId = "prompt-overlay-project";
  assert.equal(store.upsertProject({ id: projectId, name: "Prompt Overlay", path: repo }).ok, true);
  const created = store.createTab({ title: "TB Prompt overlay integration" });
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
        name: "Prompt Overlay",
        basePath: repo,
        path: worktree,
        worktreePath: worktree,
        branch: "story-prompt-overlay",
      }],
    },
    ticketUrl: "https://www.teambition.com/task/0123456789abcdef01234567",
    tbContext: {
      tbTaskId: "tb-prompt-overlay-integration",
      title: "当前 TB 标题",
      description: "当前 TB 描述",
      comments: [],
      attachments: [],
      sourceCoverage: {
        comments: { available: true, complete: true },
        attachments: { available: true, complete: true },
      },
    },
    workflow: { enabled: true, phase: "triaging", autoMode: "semi", riskLevel: "MEDIUM" },
  });
  const productionDefaults = configService.getConfig().workflowV2;
  assert.equal(productionDefaults.featureFlags.promptCompatibilityOverlay, true);
  assert.equal(productionDefaults.promptCompatibilityRollout.percentage, 100);
  assert.deepEqual(productionDefaults.promptCompatibilityRollout.storyIds, []);
  assert.deepEqual(productionDefaults.promptCompatibilityRollout.providers, []);
  assert.deepEqual(productionDefaults.promptCompatibilityRollout.stages, []);

  const capturedPrompts = [];
  const originalFetch = global.fetch;
  global.fetch = async (url, options = {}) => {
    if (/prompt-overlay-provider\.invalid/.test(String(url))) {
      const body = JSON.parse(String(options.body || "{}"));
      const capturedPrompt = (body.messages || []).map((message) => String(message.content || "")).join("\n");
      capturedPrompts.push(capturedPrompt);
      return providerResponse(capturedPrompt.includes("avatr8155也需要同样处理") ? [
        "已收到范围纠偏，将 avatr8155 与 avatr8678 一并纳入后续实现。",
      ].join("\n") : [
        "任务状态：已完成",
        "## 简短报告",
        "结论：本侧问题。",
        "## 详细报告",
        "证据表明当前客户端路径需要后续修复。",
        "<!-- TRIAGE: IS_BUG -->",
      ].join("\n"));
    }
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        _id: "tb-prompt-overlay-integration",
        isDone: true,
        taskflowstatus: { _id: "status-completed", name: "已完成" },
      }),
      json: async () => ({
        _id: "tb-prompt-overlay-integration",
        isDone: true,
        taskflowstatus: { _id: "status-completed", name: "已完成" },
      }),
    };
  };

  try {
    const started = await sendTurnWithDeviceRuntime(store.getTab(tab.id), "请甄别当前问题", { workflowKind: "triage" });
    assert.ok(started.taskId, started.error || "overlay turn should start");
    const finalTab = await waitFor(() => {
      const value = store.getTab(tab.id);
      return !value?.runningTaskId && value?.workflow?.phase === "fixing" ? value : null;
    }, "Prompt overlay triage did not settle through the legacy workflow");

    assert.equal(capturedPrompts.length, 1);
    assert.match(capturedPrompts[0], /Prompt-only 生产执行边界/);
    assert.match(capturedPrompts[0], /阶段：问题甄别（TRIAGE）/);
    assert.match(capturedPrompts[0], /<STAGE_CONTEXT_JSON>/);
    assert.doesNotMatch(capturedPrompts[0], /全自动工作流——问题甄别|<CONTEXT_JSON>|executionProfile/);

    const conversation = store.getConversation(tab.id);
    const currentUser = conversation.nodes.find((node) => node.role === "user" && node.content === "请甄别当前问题");
    assert.ok(currentUser);
    assert.equal(currentUser.aiPromptTelemetry.promptMode, "legacy");
    assert.equal(currentUser.aiPromptTelemetry.promptVariant, "phase2_overlay");
    assert.equal(currentUser.aiPromptTelemetry.overlayStage, "TRIAGE");
    assert.equal(currentUser.aiPromptTelemetry.overlayTemplateSha256.length, 64);
    const triageAssistant = conversation.nodes.find((node) => (
      node.role === "assistant" && node.taskId === started.taskId
    ));
    assert.ok(triageAssistant);
    assert.equal(triageAssistant.workflowKind, "triage");
    assert.match(triageAssistant.triageAnalysisReport, /^## 初步问题分析/m);
    assert.match(triageAssistant.triageAnalysisReport, /初步分析：证据表明当前客户端路径需要后续修复/);
    assert.match(triageAssistant.triageAnalysisReport, /尚未执行修复、测试或验收/);
    assert.equal(finalTab.workflowV2Compatibility, undefined);
    assert.deepEqual(await readWorkflowV2Envelopes({ tab: finalTab }), []);

    store.updateTab(tab.id, {
      flavors: [{ path: worktree, flavor: "avatr8155ProdRelease" }],
      workflow: { ...(store.getTab(tab.id).workflow || {}), phase: "verifying" },
    });
    const correction = "avatr8155也需要同样处理，不只是 avatr8678";
    const chatStarted = sendTurn(store.getTab(tab.id), correction, { workflowKind: "chat" });
    assert.ok(chatStarted.taskId, chatStarted.error || "chat turn should start");
    await waitFor(() => {
      const value = store.getTab(tab.id);
      return !value?.runningTaskId ? value : null;
    }, "chat correction did not settle");

    assert.equal(capturedPrompts.length, 2);
    assert.match(capturedPrompts[1], /主工程：Prompt Overlay/);
    assert.match(capturedPrompts[1], /avatr8155ProdRelease/);
    assert.match(capturedPrompts[1], /当前未绑定目标设备/);
    assert.match(capturedPrompts[1], /avatr8155也需要同样处理，不只是 avatr8678/);
    assert.doesNotMatch(capturedPrompts[1], /Prompt-only 生产执行边界/);
    assert.doesNotMatch(capturedPrompts[1], /阶段：故事点验收（VERIFY_EXECUTE）/);
    const chatConversation = store.getConversation(tab.id);
    const chatUser = chatConversation.nodes.find((node) => node.role === "user" && node.content === correction);
    assert.ok(chatUser);
    assert.equal(chatUser.aiPromptTelemetry.promptMode, "legacy");
    assert.equal(chatUser.aiPromptTelemetry.promptVariant, "legacy");
    assert.equal(chatUser.aiPromptTelemetry.workflowKind, "chat");

    store.updateTab(tab.id, {
      workflow: { ...(store.getTab(tab.id).workflow || {}), phase: "fixing" },
    });
    configService.updateConfig({
      workflowV2: {
        featureFlags: { promptV2: false, promptCompatibilityOverlay: true },
        promptCompatibilityRollout: {
          percentage: 100,
          salt: "prompt-overlay-queued-repair",
          storyIds: [tab.id],
          providers: ["deepseek"],
          stages: ["REPAIR"],
        },
      },
    });
    const frozenRepairDecision = freezePromptOverlayDecisionForQueue(
      store.getTab(tab.id),
      "继续修复",
    );
    assert.equal(frozenRepairDecision.selected, true);
    configService.updateConfig({
      workflowV2: { featureFlags: { promptCompatibilityOverlay: false } },
    });
    const drifted = sendTurn(store.getTab(tab.id), "继续修复", {
      fromPersistentQueue: true,
      promptOverlayDecision: frozenRepairDecision,
    });
    assert.equal(drifted.code, "PROMPT_COMPATIBILITY_OVERLAY_QUEUE_POLICY_DRIFT");
    assert.equal(drifted.blockPersistentQueue, true);
    assert.equal(capturedPrompts.length, 2);

    configService.updateConfig({
      workflowV2: {
        featureFlags: { promptV2: false, promptCompatibilityOverlay: true },
        promptCompatibilityRollout: {
          percentage: 100,
          salt: "prompt-overlay-report-mode",
          storyIds: [tab.id],
          providers: ["deepseek"],
          stages: ["REPORT_SHORT"],
        },
      },
    });
    store.updateTab(tab.id, {
      reportMode: "short",
      workflow: {
        ...(store.getTab(tab.id).workflow || {}),
        phase: "reporting",
        verifyPassedAt: Date.now(),
      },
    });
    const frozenReportDecision = freezePromptOverlayDecisionForQueue(
      store.getTab(tab.id),
      "生成报告",
      { workflowKind: "report", effectiveReportMode: "short" },
    );
    store.updateTab(tab.id, { reportMode: "expert" });
    const staleReport = sendTurn(store.getTab(tab.id), "生成报告", {
      workflowKind: "report",
      effectiveReportMode: "short",
      fromPersistentQueue: true,
      promptOverlayDecision: frozenReportDecision,
    });
    assert.equal(staleReport.code, "PROMPT_COMPATIBILITY_OVERLAY_REPORT_MODE_STALE");
    assert.equal(staleReport.blockPersistentQueue, true);
    assert.equal(capturedPrompts.length, 2);

    store.updateTab(tab.id, {
      reportMode: "short",
      workflow: { ...(store.getTab(tab.id).workflow || {}), phase: "fixing" },
    });
    configService.updateConfig({
      workflowV2: {
        featureFlags: { promptV2: true, promptCompatibilityOverlay: true },
        promptV2Rollout: {
          percentage: 100,
          salt: "prompt-overlay-full-v2-conflict",
          storyIds: [tab.id],
          providers: ["deepseek"],
        },
        promptCompatibilityRollout: {
          percentage: 100,
          salt: "prompt-overlay-conflict",
          storyIds: [tab.id],
          providers: ["deepseek"],
          stages: ["REPAIR"],
        },
      },
    });
    const retiredWorkflow = configService.getConfig().workflowV2;
    assert.equal(retiredWorkflow.mode, "prompt-only");
    assert.equal(Object.hasOwn(retiredWorkflow.featureFlags, "promptV2"), false);
    assert.equal(Object.hasOwn(retiredWorkflow, "promptV2Rollout"), false);
    const afterRetirement = freezePromptOverlayDecisionForQueue(store.getTab(tab.id), "继续修复");
    assert.equal(afterRetirement.selected, true);
    assert.equal(capturedPrompts.length, 2);

    const conflictDisplayContent = "修复Git合并冲突";
    const conflictTask = [
      "请自动解决下列 Git 合并冲突。操作范围严格限制为列出的仓库路径和冲突文件。",
      `- 仓库路径：${worktree}`,
      "- 仅允许处理以下冲突文件：",
      "  - README.md",
      "仅对列出的文件执行 git add -- <file>，不得执行 git commit、push、stash、reset、clean、切换分支或 merge --abort。",
    ].join("\n");
    const conflictStarted = sendTurn(store.getTab(tab.id), conflictTask, {
      workflowKind: "repair",
      conversation: {
        displayContent: conflictDisplayContent,
        messageInput: {
          text: conflictDisplayContent,
          actionKind: "git_conflict_resolution",
        },
      },
    });
    assert.ok(conflictStarted.taskId, conflictStarted.error || "Git conflict turn should start");
    await waitFor(() => {
      const value = store.getTab(tab.id);
      return !value?.runningTaskId ? value : null;
    }, "Git conflict display-content turn did not settle");

    assert.equal(capturedPrompts.length, 3);
    assert.match(capturedPrompts[2], /操作范围严格限制为列出的仓库路径和冲突文件/);
    assert.match(capturedPrompts[2], /仅对列出的文件执行 git add --/);
    assert.match(capturedPrompts[2], /不得执行 git commit、push、stash、reset、clean、切换分支或 merge --abort/);
    const conflictUser = store.getConversation(tab.id).nodes.find((node) => (
      node.role === "user" && node.taskId === conflictStarted.taskId
    ));
    assert.ok(conflictUser);
    assert.equal(conflictUser.content, conflictTask);
    assert.equal(conflictUser.displayContent, conflictDisplayContent);
    assert.equal(conflictUser.input.text, conflictDisplayContent);
    assert.equal(conflictUser.input.actionKind, "git_conflict_resolution");
  } finally {
    global.fetch = originalFetch;
    try { await closeAppMarketMcpBridge(); } catch {}
    try { git(["worktree", "remove", "--force", worktree], repo); } catch {}
    try { git(["worktree", "prune"], repo); } catch {}
  }
});
