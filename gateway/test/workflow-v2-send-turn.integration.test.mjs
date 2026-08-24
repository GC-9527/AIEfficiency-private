import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "workflow-v2-send-turn-"));
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
  servers: { nodeId: "workflow-v2-send-turn-test" },
  apiMaxToolIterations: 3,
  apiAgent: { workspaceIsolation: true, commandPolicy: "workspace" },
  teambition: { userCookie: "mock-cookie" },
  apiEngines: {
    deepseek: {
      enabled: true,
      name: "Mock DeepSeek",
      baseUrl: "https://workflow-v2-provider.invalid",
      apiKey: "test-only-key",
      model: "mock-model",
      thinkingEnabled: false,
    },
  },
  workflowV2: {
    featureFlags: {
      promptV2: true,
      promptCompatibilityOverlay: false,
      stageContextV2: false,
      checkpointV2: false,
      receiptGateV2: false,
      strictVerifyV2: false,
      promptTelemetryV2: false,
    },
    promptV2Rollout: {
      percentage: 100,
      salt: "workflow-v2-send-turn-integration",
      storyIds: [],
      providers: ["deepseek"],
    },
  },
}), "utf8");

const store = await import("../services/devbench/store.js");
const { sendTurnWithDeviceRuntime } = await import("../services/devbench/index.js");
const {
  readWorkflowV2Envelopes,
} = await import("../services/devbench/workflow-v2/envelope-store.js");
const { WORKFLOW_V2_SCHEMA_IDS } = await import("../services/devbench/workflow-v2/schema-registry.js");
const { closeAppMarketMcpBridge } = await import("../services/appmarket-admin-mcp.js");

function git(args, cwd) {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

function providerResponse(finalResponse) {
  const encoder = new TextEncoder();
  const events = [
    {
      choices: [{
        delta: {
          tool_calls: [{
            index: 0,
            id: "finish-triage",
            type: "function",
            function: { name: "finish_task", arguments: "" },
          }],
        },
      }],
    },
    {
      choices: [{
        delta: {
          tool_calls: [{
            index: 0,
            function: {
              arguments: JSON.stringify({
                status: "completed",
                summary: "甄别完成",
                changes: [],
                verification: ["已核对当前 StageContext"],
                remaining: [],
                final_response: finalResponse,
              }),
            },
          }],
        },
      }],
    },
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

async function waitFor(predicate, message, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await predicate();
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(message);
}

test("真实 sendTurn compatibility 链路隔离 raw history，并在 recorder 后推进 triage→fixing", async () => {
  const repo = fs.mkdtempSync(path.join(tempRoot, "repo-"));
  const worktree = fs.mkdtempSync(path.join(tempRoot, "worktree-"));
  git(["init", "-q", "-b", "main"], repo);
  git(["config", "user.email", "test@example.com"], repo);
  git(["config", "user.name", "Test"], repo);
  fs.writeFileSync(path.join(repo, "README.md"), "workflow v2 integration\n", "utf8");
  git(["add", "README.md"], repo);
  git(["commit", "-q", "-m", "init"], repo);
  git(["worktree", "add", "-q", "-b", "story-v2-send-turn", worktree], repo);

  const projectId = "workflow-v2-send-turn-project";
  assert.equal(store.upsertProject({ id: projectId, name: "Workflow v2 Integration", path: repo }).ok, true);
  const created = store.createTab({ title: "TB compatibility integration" });
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
        name: "Workflow v2 Integration",
        basePath: repo,
        path: worktree,
        worktreePath: worktree,
        branch: "story-v2-send-turn",
      }],
    },
    tbTaskId: "tb-workflow-v2-integration",
    ticketUrl: "https://www.teambition.com/task/0123456789abcdef01234567",
    tbContext: {
      tbTaskId: "tb-workflow-v2-integration",
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
    cliSessionId: "legacy-resume-must-not-be-used",
    cliSessionIds: { deepseek: "legacy-resume-must-not-be-used" },
  });
  const rawHistory = "RAW_ASSISTANT_HISTORY_MUST_NOT_REACH_PROVIDER";
  store.appendConversationNode(tab.id, { role: "assistant", content: rawHistory, turn: 0 });

  const capturedPrompts = [];
  const originalFetch = global.fetch;
  global.fetch = async (url, options = {}) => {
    if (!/workflow-v2-provider\.invalid/.test(String(url))) {
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          _id: "tb-workflow-v2-integration",
          isDone: true,
          taskflowstatus: { _id: "status-completed", name: "已完成" },
        }),
        json: async () => ({
          _id: "tb-workflow-v2-integration",
          isDone: true,
          taskflowstatus: { _id: "status-completed", name: "已完成" },
        }),
      };
    }
    const body = JSON.parse(String(options.body || "{}"));
    capturedPrompts.push((body.messages || []).map((message) => String(message.content || "")).join("\n"));
    return providerResponse([
      "## 甄别结论",
      "结论：本侧问题",
      "原因：当前实现遗漏 compatibility 边界",
      "依据：冻结 StageContext",
      "未读：无",
      "<!-- TRIAGE: IS_BUG -->",
    ].join("\n"));
  };

  try {
    const started = await sendTurnWithDeviceRuntime(store.getTab(tab.id), "请甄别当前问题", { workflowKind: "triage" });
    assert.ok(started.taskId, started.error || "compatibility turn should start");
    const finalTab = await waitFor(
      () => {
        const value = store.getTab(tab.id);
        return !value?.runningTaskId && value?.workflowV2Compatibility?.settlement ? value : null;
      },
      "compatibility recorder/apply did not settle triage to fixing",
      20_000,
    );
    assert.equal(finalTab.workflow?.phase, "fixing", JSON.stringify(finalTab.workflowV2Compatibility?.settlement));

    assert.equal(capturedPrompts.length, 1);
    assert.match(capturedPrompts[0], /<CONTEXT_JSON>/);
    assert.match(capturedPrompts[0], /compatibility/i);
    assert.doesNotMatch(capturedPrompts[0], new RegExp(rawHistory));
    assert.doesNotMatch(capturedPrompts[0], /最近对话|智能历史|legacy-resume-must-not-be-used/);

    const conversation = store.getConversation(tab.id);
    const currentUser = conversation.nodes.find((node) => node.role === "user" && node.content === "请甄别当前问题");
    assert.ok(currentUser);
    assert.equal(currentUser.aiPromptTelemetry.promptMode, "compatibility");
    assert.equal(typeof currentUser.aiPromptTelemetry.contextId, "string");
    assert.equal(currentUser.aiPromptTelemetry.contextRevision, 1);
    assert.match(currentUser.aiPromptTelemetry.contextHash, /^[a-f0-9]{64}$/);
    assert.equal(finalTab.workflowV2Compatibility.settlement.status, "settled");
    assert.equal(finalTab.cliSessionId, null);

    const checkpoints = await readWorkflowV2Envelopes({
      tab: finalTab,
      payloadSchemaId: WORKFLOW_V2_SCHEMA_IDS.workflowCheckpoint,
    });
    const manifests = await readWorkflowV2Envelopes({
      tab: finalTab,
      payloadSchemaId: WORKFLOW_V2_SCHEMA_IDS.evidenceManifest,
    });
    assert.equal(checkpoints.length, 2, "bootstrap and result checkpoint must be externalized");
    assert.equal(manifests.length, 1);
    assert.equal(finalTab.workflowV2Compatibility.sourceCursor.checkpoint.revision, 2);
    assert.equal(finalTab.workflowV2Compatibility.sourceCursor.evidenceManifest.revision, 1);
    assert.equal(checkpoints.at(-1).payload.claims.at(-1).status, "UNVERIFIED");
  } finally {
    global.fetch = originalFetch;
    try { await closeAppMarketMcpBridge(); } catch {}
    try { git(["worktree", "remove", "--force", worktree], repo); } catch {}
    try { git(["worktree", "prune"], repo); } catch {}
  }
});
