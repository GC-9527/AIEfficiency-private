import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

// devbench sendTurn -> agent-runner -> executeApiEngine(deepseek) 完整链路验证：
// 1) WS 必须广播 chat_stream（thinking/text/status/tool_use），sessionId 与 tab.sessionId 一致
// 2) task.onStream 必须把流片段同步进 store liveDraft（刷新后恢复实时内容）
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "devbench-deepseek-live-"));
process.env.GATEWAY_DB_PATH = path.join(tmp, "data.db");
process.env.GATEWAY_CONFIG_PATH = path.join(tmp, "gateway.json");
process.env.DEVBENCH_CONFIG_PATH = path.join(tmp, "market.json");
process.env.DEVBENCH_STORE_DIR = path.join(tmp, "store");
process.env.AIEFFICIENCY_CLONE_PARENT = path.join(tmp, "clone-parent");
process.env.NODE_ENV = "test";
fs.writeFileSync(process.env.GATEWAY_CONFIG_PATH, JSON.stringify({
  codexEnabled: false,
  autoFallback: false,
  maxCliConcurrency: 1,
  workDir: tmp,
  servers: { nodeId: "deepseek-live-test" },
  apiMaxToolIterations: 5,
  apiAgent: { workspaceIsolation: true, commandPolicy: "workspace" },
  apiEngines: {
    deepseek: {
      enabled: true,
      name: "DeepSeek",
      baseUrl: "https://deepseek.invalid",
      apiKey: "test-only-key",
      model: "deepseek-v4-pro",
      thinkingEnabled: true,
      reasoningEffort: "high",
    },
  },
}));

function deepseekSseResponse({ reasoning = "", content = "", toolCalls = [], finishReason = "tool_calls" } = {}) {
  const encoder = new TextEncoder();
  const events = [];
  if (reasoning) events.push({ choices: [{ delta: { reasoning_content: reasoning } }] });
  if (content) events.push({ choices: [{ delta: { content } }] });
  toolCalls.forEach((call, i) => {
    events.push({
      choices: [{
        delta: {
          tool_calls: [{
            index: i,
            id: call.id,
            type: "function",
            function: { name: call.function.name, arguments: "" },
          }],
        },
      }],
    });
    events.push({
      choices: [{
        delta: {
          tool_calls: [{
            index: i,
            function: { arguments: call.function.arguments },
          }],
        },
      }],
    });
  });
  events.push({ choices: [{ delta: {}, finish_reason: finishReason }] });
  const body = new ReadableStream({
    start(controller) {
      for (const e of events) controller.enqueue(encoder.encode(`data: ${JSON.stringify(e)}\n\n`));
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      controller.close();
    },
  });
  return { ok: true, body, text: async () => "", json: async () => ({}) };
}

const originalFetch = global.fetch;
const logger = await import("../services/logger.js");
const store = await import("../services/devbench/store.js");
const { sendTurn } = await import("../services/devbench/index.js");
const { closeAppMarketMcpBridge } = await import("../services/appmarket-admin-mcp.js");

async function waitFor(predicate, message, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(message);
}

function git(args, cwd) {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

test("deepseek 故事点轮次：WS 广播 chat_stream 且 liveDraft 累积实时内容", async () => {
  const repo = fs.mkdtempSync(path.join(tmp, "repo-"));  const wt = fs.mkdtempSync(path.join(tmp, "wt-"));
  git(["init", "-q", "-b", "main"], repo);
  git(["config", "user.email", "test@example.com"], repo);
  git(["config", "user.name", "Test"], repo);
  fs.writeFileSync(path.join(repo, "hello.txt"), "hello\n", "utf8");
  git(["add", "."], repo);
  git(["commit", "-q", "-m", "init"], repo);
  git(["worktree", "add", "-q", "-b", "story-deepseek", wt], repo);
  const projectId = "deepseek-live-project";
  assert.equal(store.upsertProject({ id: projectId, name: "DeepSeek 实时工程", path: repo }).ok, true);
  const created = store.createTab({ title: "DeepSeek 实时故事点" });
  const tab = store.updateTab(created.id, {
    primaryProjectId: projectId,
    worktreeStatus: "ready",
    worktree: {
      version: 1,
      managed: true,
      root: wt,
      entries: [{
        role: "primary",
        active: true,
        baseProjectId: projectId,
        name: "DeepSeek 实时工程",
        basePath: repo,
        path: wt,
        worktreePath: wt,
        branch: "story-deepseek",
      }],
    },
    engine: "deepseek",
    cliSessionId: null,
    cliSessionIds: {},
  });

  const sessionId = store.getTab(tab.id).sessionId;
  const captured = [];
  const mockClient = {
    readyState: 1,
    subscribedSessions: new Set([sessionId]),
    send: (msg) => captured.push(JSON.parse(msg)),
  };
  logger.setWsClients(new Set([mockClient]));

  let call = 0;
  global.fetch = async () => {
    call++;
    // 模拟真实上游延迟：让任务运行足够久，liveDraft 才能在节流窗口内被捕获
    await new Promise((resolve) => setTimeout(resolve, 500));
    if (call === 1) {
      return deepseekSseResponse({
        reasoning: "先读取文件确认内容",
        toolCalls: [{ id: "read-1", type: "function", function: { name: "read_file", arguments: JSON.stringify({ path: "hello.txt", start_line: 1, line_count: 5 }) } }],
        finishReason: "tool_calls",
      });
    }
    return deepseekSseResponse({
      reasoning: "读取成功，整理结果并收尾",
      toolCalls: [{ id: "finish-1", type: "function", function: { name: "finish_task", arguments: JSON.stringify({
        status: "completed",
        summary: "已读取 hello.txt",
        changes: [],
        verification: ["已读取 hello.txt"],
        remaining: [],
        final_response: "## 结果\nhello.txt 内容为 hello。",
      }) } }],
      finishReason: "tool_calls",
    });
  };

  try {
    const started = sendTurn(tab, "请读取 hello.txt");
    assert.ok(started.taskId, started.error || "deepseek 故事点任务未启动");

    // 1) WS 应收到 deepseek 的实时流（含 sessionId）
    await waitFor(
      () => {
        const events = captured.filter((m) => m.type === "chat_stream");
        return events.length > 0 ? events : null;
      },
      "未收到 deepseek 的 chat_stream WS 事件",
    );

    // 2) liveDraft 累积思考流（刷新后恢复实时内容依赖）：必须与流并行轮询，
    //    在任务运行期间捕获（任务完成后 onTurnSuccess 会 clearLiveDraft）
    let liveDraftThinking = null;
    const liveDraftWatcher = (async () => {
      const deadline = Date.now() + 8000;
      while (Date.now() < deadline) {
        const draft = store.getLiveDraft(tab.id);
        if (draft && draft.thinking && draft.thinking.includes("先读取文件")) {
          liveDraftThinking = draft;
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    })();

    // 等流结束（chat_stream_end）再断言类型
    await waitFor(
      () => (captured.some((m) => m.type === "chat_stream_end") ? true : null),
      "未收到 chat_stream_end（流未结束）",
    );
    const streamEvents = captured.filter((m) => m.type === "chat_stream");
    assert.ok(streamEvents.length > 0, "chat_stream 事件不应为空");
    assert.ok(streamEvents.every((m) => m.data.sessionId === sessionId), "chat_stream 的 sessionId 必须与 tab.sessionId 一致");
    const types = new Set(streamEvents.map((m) => m.data.deltaType));
    assert.ok(types.has("status"), "应收到 status 片段");
    assert.ok(types.has("thinking"), "deepseek 思考流应作为 thinking 片段广播");
    assert.ok(types.has("tool_use"), "工具调用应作为 tool_use 片段广播");

    await liveDraftWatcher;
    assert.ok(liveDraftThinking, "liveDraft 应累积 deepseek 思考流（onStream → saveLiveDraft 链路）");

    // 3) 最终回复落库，任务完成
    const finalMessage = await waitFor(
      () => store.getMessages(tab.id).find((m) => m.role === "assistant" && !m.stopped),
      "deepseek 最终回复未落库",
    );
    assert.match(finalMessage.content, /hello\.txt 内容为 hello/);
    assert.equal(store.getLiveDraft(tab.id), null, "任务完成后应清理 liveDraft");
  } finally {
    logger.setWsClients(new Set());
    global.fetch = originalFetch;
    // 关闭 devServer MCP 子进程（devbench import 时启动），避免测试进程挂住
    try { await closeAppMarketMcpBridge(); } catch {}
    // 清理测试创建的 git worktree，避免 Windows 上残留文件句柄
    try { git(["worktree", "remove", "--force", wt], repo); } catch {}
    try { git(["worktree", "prune"], repo); } catch {}
  }
});
