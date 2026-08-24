import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import JSZip from "jszip";
import { closeAppMarketMcpBridge } from "../services/appmarket-admin-mcp.js";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "api-engine-"));
const storyArtifacts = fs.mkdtempSync(path.join(os.tmpdir(), "api-engine-story-artifacts-"));
const observabilityFixture = JSON.parse(fs.readFileSync(
  new URL("./fixtures/devbench-phase2/turn-observability.fixture.json", import.meta.url),
  "utf8",
));
// This unit suite explicitly exercises the legacy in-process tool boundary.
// Empty/production NODE_ENV is fail-closed and covered by security integration tests.
process.env.NODE_ENV = "test";
process.env.GATEWAY_CONFIG_PATH = path.join(root, "gateway-config.json");
fs.writeFileSync(path.join(root, "hello.txt"), "hello\n", "utf8");
fs.writeFileSync(process.env.GATEWAY_CONFIG_PATH, JSON.stringify({
  apiMaxToolIterations: 5,
  apiAgent: { workspaceIsolation: true, commandPolicy: "workspace" },
  apiEngines: {
    deepseek: {
      enabled: true,
      name: "DeepSeek",
      baseUrl: "  https://deepseek.invalid  ",
      apiKey: "  test-only-key  ",
      model: "  deepseek-v4-pro  ",
      thinkingEnabled: true,
      reasoningEffort: "high",
    },
    volcengine: {
      enabled: true,
      name: "火山方舟",
      baseUrl: "https://volcengine.invalid",
      apiKey: "test-only-key",
      model: "glm-5.2[1m]",
      thinkingEnabled: false,
      reasoningEffort: "high",
    },
    minimax: {
      enabled: true,
      name: "MiniMax",
      baseUrl: "https://api.minimaxi.invalid/v1",
      apiKey: "test-only-key",
      model: "MiniMax-M3",
      thinkingEnabled: false,
      reasoningEffort: "high",
    },
  },
}));

let engine;
const originalFetch = global.fetch;

/**
 * 把 OpenAI 兼容 API 一次性返回的 message 形态转成符合 SSE 协议的事件序列，
 * 与生产环境真实 fetch Response 的 body 流一致，使测试真正覆盖流式读取路径。
 *  - reasoning / content 各自一次 delta 推完（流式协议允许）
 *  - 每个 tool_call 通过两次 delta 发出：先送 id+name，再送 arguments 整段
 *  - 最后送 finish_reason + 可选 usage
 */
function toolCallSseResponse({ reasoning = "", content = "", toolCalls = [], finishReason = "tool_calls", usage = null } = {}) {
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
  if (usage) events.push({ usage });
  const body = new ReadableStream({
    start(controller) {
      for (const e of events) controller.enqueue(encoder.encode(`data: ${JSON.stringify(e)}\n\n`));
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      controller.close();
    },
  });
  return {
    ok: true,
    body,
    text: async () => "",
    json: async () => ({}),
  };
}

function stalledSseResponse(signal, initialEvent = null) {
  const encoder = new TextEncoder();
  const body = new ReadableStream({
    start(controller) {
      if (initialEvent) controller.enqueue(encoder.encode(`data: ${JSON.stringify(initialEvent)}\n\n`));
      signal?.addEventListener?.("abort", () => {
        try { controller.error(signal.reason || new Error("aborted")); } catch {}
      }, { once: true });
    },
  });
  return {
    ok: true,
    body,
    text: async () => "",
    json: async () => ({}),
  };
}

before(async () => { engine = await import("../services/api-engine.js"); });
after(async () => {
  global.fetch = originalFetch;
  await closeAppMarketMcpBridge();
  // start_process 在故事点测试里启动的子进程可能仍在跑，删目录时 Windows 上偶发 EPERM；
  // 用 best-effort 兜底，避免 cleanup 失败掩盖真正的测试结果。
  try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 }); } catch {}
  try { fs.rmSync(storyArtifacts, { recursive: true, force: true, maxRetries: 3 }); } catch {}
});

test("远程故事点仍由 Gateway 本地执行 AppMarket MCP，其他工程工具保持远端执行", () => {
  const remote = { host: "http://node.invalid", root: "D:/project" };
  assert.equal(engine.shouldExecuteApiToolLocally("appmarket_admin_list_apps", remote), true);
  assert.equal(engine.shouldExecuteApiToolLocally("list_dir", remote), false);
  assert.equal(engine.shouldExecuteApiToolLocally("list_dir", null), true);
});

test("DeepSeek V4 思考模式在工具轮次保留 reasoning_content，并输出明确终态", async () => {
  const requests = [];
  let call = 0;
  global.fetch = async (_url, options) => {
    requests.push(JSON.parse(options.body));
    call++;
    if (call === 1) {
      return toolCallSseResponse({
        reasoning: "先读取文件",
        toolCalls: [{ id: "read-1", type: "function", function: { name: "read_file", arguments: JSON.stringify({ path: "hello.txt", start_line: 1, line_count: 5 }) } }],
        finishReason: "tool_calls",
      });
    }
    return toolCallSseResponse({
      reasoning: "读取成功，提交结果",
      toolCalls: [{ id: "finish-1", type: "function", function: { name: "finish_task", arguments: JSON.stringify({
        status: "completed",
        summary: "已检查文件。",
        changes: [],
        verification: ["已读取 hello.txt"],
        remaining: [],
      }) } }],
      finishReason: "tool_calls",
    });
  };

  const result = await engine.executeApiEngine("deepseek", "检查文件", "test-task", null, null, { cwd: root });
  assert.match(result.report, /^任务状态：已完成/);
  assert.match(result.report, /已读取 hello\.txt/);
  assert.equal(requests[0].thinking.type, "enabled");
  assert.equal(requests[0].reasoning_effort, "high");
  assert.equal(requests[0].model, "deepseek-v4-pro");
  const assistant = requests[1].messages.find((message) => message.role === "assistant");
  assert.equal(assistant.reasoning_content, "先读取文件");
  assert.ok(result.transcript.some((item) => item.type === "thinking" && item.content.includes("读取成功")));
});

test("Provider usage 覆盖兼容重试和三轮工具响应并形成可持久化遥测", async () => {
  const requests = [];
  let call = 0;
  global.fetch = async (_url, options) => {
    requests.push(JSON.parse(options.body));
    const responseFixture = observabilityFixture.responses[call++];
    if (responseFixture.outcome === "retryable_http_error") {
      return {
        ok: false,
        status: 400,
        body: null,
        text: async () => responseFixture.error,
      };
    }
    return toolCallSseResponse({
      toolCalls: [{
        id: `fixture-${call}`,
        type: "function",
        function: {
          name: responseFixture.tool.name,
          arguments: JSON.stringify(responseFixture.tool.arguments),
        },
      }],
      finishReason: "tool_calls",
      usage: responseFixture.usage,
    });
  };

  const result = await engine.executeApiEngine(
    "deepseek",
    observabilityFixture.prompt,
    "test-observability-fixture",
    null,
    null,
    { cwd: root },
    {
      telemetryContext: {
        storyId: "story-fixture",
        attemptId: "attempt-fixture",
        workflowKind: "verify",
        stage: "VERIFY",
      },
    },
  );
  const expected = observabilityFixture.expected;

  assert.equal(requests.length, expected.requestAttempts);
  assert.equal("stream_options" in requests[0], true);
  assert.equal("stream_options" in requests[1], false);
  assert.deepEqual(result.usage, {
    inputTokens: expected.inputTokens,
    outputTokens: expected.outputTokens,
    cacheReadTokens: expected.cacheReadTokens,
    cacheCreationTokens: expected.cacheCreationTokens,
    costUsd: null,
  });
  assert.equal(result.telemetry.promptChars, expected.promptChars);
  assert.equal(result.telemetry.requestAttempts, expected.requestAttempts);
  assert.equal(result.telemetry.requestCount, expected.requestCount);
  assert.equal(result.telemetry.retryCount, expected.retryCount);
  assert.equal(result.telemetry.transportRetryCount, expected.transportRetryCount);
  assert.equal(result.telemetry.workflowRetryCount, expected.workflowRetryCount);
  // 口径：每个包含 tool_calls 的 Provider 响应算一轮，单独 finish_task 也计入。
  assert.equal(result.telemetry.toolRounds, expected.toolRounds);
  assert.equal(result.telemetry.toolCalls, expected.toolCalls);
  assert.equal(result.telemetry.providerUsageRequests, expected.providerUsageRequests);
  assert.equal(result.telemetry.usage.inputTokens, expected.inputTokens);
  assert.equal(result.telemetry.usage.outputTokens, expected.outputTokens);
  assert.equal(result.telemetry.usage.source, "provider");
  assert.equal(result.telemetry.executionSucceeded, true);
  assert.ok(result.telemetry.systemChars > 0);
  assert.ok(result.telemetry.toolSchemaChars > 0);
  assert.ok(result.telemetry.toolResultChars > 0);
  assert.equal(result.telemetry.requests[0].outcome, "retryable_http_error");
  assert.deepEqual(result.telemetry.transportRetryReasons, ["unsupported_stream_options"]);
});

test("方舟 glm-5.2[1m] 忽略 finish_task 时自动改用无工具 JSON 收口", async () => {
  const requests = [];
  let call = 0;
  const finalResponse = [
    "## 评审结论",
    "已完成只读检查，未发现阻断问题。",
    "",
    "已核对真实文件并保留残余风险说明。",
    "",
    "FIX_DONE",
  ].join("\n");
  global.fetch = async (_url, options) => {
    requests.push(JSON.parse(options.body));
    call++;
    if (call === 1) {
      return toolCallSseResponse({
        reasoning: "先读取目录",
        toolCalls: [{
          id: "list-glm",
          type: "function",
          function: { name: "list_dir", arguments: JSON.stringify({ path: "." }) },
        }],
        finishReason: "tool_calls",
      });
    }
    if (call === 2) {
      return toolCallSseResponse({
        reasoning: "检查已经结束，我将整理最终评审结论，但模型没有调用 finish_task。",
        finishReason: "stop",
      });
    }
    return toolCallSseResponse({
      content: JSON.stringify({
        status: "completed",
        summary: "只读评审已完成",
        changes: [],
        verification: ["已读取目录并检查目标"],
        remaining: [],
        final_response: finalResponse,
      }),
      finishReason: "stop",
    });
  };

  const result = await engine.executeApiEngine(
    "volcengine",
    "执行只读评审并给出结论",
    "test-glm-text-finalization",
    null,
    null,
    { cwd: root },
    { model: "glm-5.2[1m]", tier: "high" },
  );

  assert.equal(result.report, finalResponse);
  assert.equal(requests.length, 3);
  assert.equal(requests[0].model, "glm-5.2[1m]");
  assert.equal(requests[0].tool_choice, "auto");
  assert.ok(Array.isArray(requests[0].tools));
  assert.equal(requests[1].tool_choice, "auto");
  assert.ok(Array.isArray(requests[1].tools));
  assert.equal("tool_choice" in requests[2], false);
  assert.equal("tools" in requests[2], false);
  assert.ok(requests[2].messages.some((message) => (
    message.role === "system" && message.content.includes("兼容性收口轮")
  )));
  assert.ok(requests[2].messages.some((message) => (
    message.role === "assistant"
      && message.reasoning_content.includes("模型没有调用 finish_task")
  )));
  assert.match(result.report, /FIX_DONE/);
  assert.doesNotMatch(result.report, /需要人工确认/);
});

test("方舟 glm-5.2[1m] 以 stop 收尾时不丢弃已流出的 finish_task", async () => {
  const requests = [];
  const finalResponse = "方舟 stop 尾包中的 finish_task 已被正确识别。";
  global.fetch = async (_url, options) => {
    requests.push(JSON.parse(options.body));
    return toolCallSseResponse({
      reasoning: "任务已经完成，现在调用 finish_task。",
      toolCalls: [{
        id: "finish-glm-stop",
        type: "function",
        function: {
          name: "finish_task",
          arguments: JSON.stringify({
            status: "completed",
            summary: "已完成",
            changes: [],
            verification: ["已验证 stop 尾包兼容性"],
            remaining: [],
            final_response: finalResponse,
          }),
        },
      }],
      finishReason: "stop",
    });
  };

  const result = await engine.executeApiEngine(
    "volcengine",
    "提交终态",
    "test-glm-stop-tool-call",
    null,
    null,
    { cwd: root },
    { model: "glm-5.2[1m]", tier: "high" },
  );

  assert.equal(result.report, finalResponse);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].tool_choice, "auto");
  assert.ok(result.transcript.some((item) => (
    item.type === "tool_use" && item.content === "finish_task"
  )));
});

test("纯 tool_calls 轮（无 content/reasoning）也下发 status 让前端 LiveBubble 显示", async () => {
  const logger = await import("../services/logger.js");
  const sessionId = "test-live-status-session";
  const captured = [];
  const mockClient = {
    readyState: 1,
    subscribedSessions: new Set([sessionId]),
    send: (msg) => captured.push(JSON.parse(msg)),
  };
  logger.setWsClients(new Set([mockClient]));
  try {
    const finalResponse = "纯 tool_calls 轮也下发 status。";
    global.fetch = async () => toolCallSseResponse({
      toolCalls: [{
        id: "finish-live-status",
        type: "function",
        function: {
          name: "finish_task",
          arguments: JSON.stringify({
            status: "completed",
            summary: "已完成",
            changes: [],
            verification: [],
            remaining: [],
            final_response: finalResponse,
          }),
        },
      }],
      finishReason: "stop",
    });
    const result = await engine.executeApiEngine(
      "volcengine",
      "提交终态",
      "test-glm-live-status",
      sessionId,
      null,
      { cwd: root },
      {
        model: "glm-5.2[1m]",
        tier: "high",
        aiSnapshot: { engine: "volcengine", model: "glm-5.2[1m]", tier: "high", capturedAt: Date.now() },
      },
    );
    assert.equal(result.report, finalResponse);
    const statusEvents = captured.filter((m) => m.type === "chat_stream" && m.data?.deltaType === "status");
    assert.ok(statusEvents.length > 0, "应至少下发一个 status 片段让前端创建 liveMap 并显示 LiveBubble");
    assert.ok(statusEvents.some((m) => /正在/.test(String(m.data.chunk || ""))), "status 文本应为运行中提示");
  } finally {
    logger.setWsClients(new Set());
  }
});

test("流被 length 截断时不执行可能不完整的工具调用", async () => {
  const parsed = await engine.readApiTextStream(toolCallSseResponse({
    toolCalls: [{
      id: "truncated-call",
      type: "function",
      function: { name: "finish_task", arguments: "{\"status\":\"completed\"" },
    }],
    finishReason: "length",
  }));
  assert.equal(parsed.finishReason, "length");
  assert.deepEqual(parsed.toolCalls, []);
});

test("stop 尾包中的工具参数不是完整 JSON 时不执行", async () => {
  const parsed = await engine.readApiTextStream(toolCallSseResponse({
    toolCalls: [{
      id: "malformed-stop-call",
      type: "function",
      function: { name: "finish_task", arguments: "{\"status\":\"completed\"" },
    }],
    finishReason: "stop",
  }));
  assert.equal(parsed.finishReason, "stop");
  assert.deepEqual(parsed.toolCalls, []);
});

test("content_filter 尾包即使工具参数完整也不执行", async () => {
  const parsed = await engine.readApiTextStream(toolCallSseResponse({
    toolCalls: [{
      id: "filtered-write-call",
      type: "function",
      function: {
        name: "write_file",
        arguments: JSON.stringify({ path: "blocked.txt", content: "must-not-run" }),
      },
    }],
    finishReason: "content_filter",
  }));
  assert.equal(parsed.finishReason, "content_filter");
  assert.deepEqual(parsed.toolCalls, []);
  assert.equal(fs.existsSync(path.join(root, "blocked.txt")), false);
});

test("API Agent Provider 首包静默时在有界时间失败并释放本轮", async () => {
  const safety = new AbortController();
  const safetyTimer = setTimeout(() => safety.abort(new Error("test safety timeout")), 300);
  let requestSignal = null;
  global.fetch = async (_url, options) => {
    requestSignal = options.signal;
    return stalledSseResponse(options.signal);
  };

  const started = Date.now();
  try {
    await assert.rejects(
      engine.executeApiEngine(
        "deepseek",
        "等待首包",
        "test-provider-first-chunk-timeout",
        null,
        null,
        { cwd: root, signal: safety.signal },
        { firstChunkTimeoutMs: 40, streamIdleTimeoutMs: 80 },
      ),
      (error) => {
        assert.equal(error?.code, "API_PROVIDER_FIRST_CHUNK_TIMEOUT");
        assert.equal(error?.terminalFailure, true);
        assert.equal(error?.userStopped, undefined);
        assert.equal(error?.telemetry?.executionSucceeded, false);
        assert.ok(Array.isArray(error?.transcript));
        return true;
      },
    );
    assert.ok(Date.now() - started < 250, "Provider 首包超时不应等待测试安全中止");
    assert.equal(requestSignal?.aborted, true);
  } finally {
    clearTimeout(safetyTimer);
  }
});

test("API Agent Provider 流收到数据后静默时按空闲超时失败", async () => {
  const safety = new AbortController();
  const safetyTimer = setTimeout(() => safety.abort(new Error("test safety timeout")), 300);
  let requestSignal = null;
  global.fetch = async (_url, options) => {
    requestSignal = options.signal;
    return stalledSseResponse(options.signal, {
      choices: [{ delta: { content: "已收到首段" } }],
    });
  };

  const started = Date.now();
  try {
    await assert.rejects(
      engine.executeApiEngine(
        "deepseek",
        "等待后续流",
        "test-provider-stream-idle-timeout",
        null,
        null,
        { cwd: root, signal: safety.signal },
        { firstChunkTimeoutMs: 40, streamIdleTimeoutMs: 60 },
      ),
      (error) => {
        assert.equal(error?.code, "API_PROVIDER_STREAM_IDLE_TIMEOUT");
        assert.equal(error?.terminalFailure, true);
        assert.equal(error?.userStopped, undefined);
        assert.equal(error?.telemetry?.executionSucceeded, false);
        assert.ok(Array.isArray(error?.transcript));
        return true;
      },
    );
    assert.ok(Date.now() - started < 250, "Provider 流空闲超时不应等待测试安全中止");
    assert.equal(requestSignal?.aborted, true);
  } finally {
    clearTimeout(safetyTimer);
  }
});

test("API Agent 在响应前连接重置时只重试一次并保留传输遥测", async () => {
  let calls = 0;
  global.fetch = async () => {
    calls++;
    if (calls === 1) {
      const cause = Object.assign(new Error("socket closed before response"), { code: "ECONNRESET" });
      throw Object.assign(new TypeError("fetch failed"), { cause });
    }
    return toolCallSseResponse({
      toolCalls: [{
        id: "finish-after-retry",
        type: "function",
        function: {
          name: "finish_task",
          arguments: JSON.stringify({
            status: "completed",
            summary: "传输重试后完成",
            changes: [],
            verification: ["Provider 第二次连接成功"],
            remaining: [],
          }),
        },
      }],
      finishReason: "tool_calls",
    });
  };

  const result = await engine.executeApiEngine("minimax", "继续执行", "test-provider-reset-retry", null, null, { cwd: root });
  assert.equal(calls, 2);
  assert.match(result.report, /传输重试后完成/);
  assert.equal(result.telemetry.requestAttempts, 2);
  assert.equal(result.telemetry.transportRetryCount, 1);
  assert.deepEqual(result.telemetry.transportRetryReasons, ["provider_transport_econnreset"]);
  assert.equal(result.telemetry.requests[0].outcome, "retryable_transport_error");
  assert.equal(result.telemetry.requests[1].outcome, "response");
});

test("API Agent 对缺少 cause 的原始 fetch failed 仍执行一次安全重试", async () => {
  let calls = 0;
  global.fetch = async () => {
    calls++;
    if (calls === 1) throw new TypeError("fetch failed");
    return toolCallSseResponse({
      toolCalls: [{
        id: "finish-after-generic-fetch-failure",
        type: "function",
        function: {
          name: "finish_task",
          arguments: JSON.stringify({
            status: "completed",
            summary: "原始 fetch failed 后恢复",
            changes: [],
            verification: ["第二次 Provider 请求成功"],
            remaining: [],
          }),
        },
      }],
      finishReason: "tool_calls",
    });
  };

  const result = await engine.executeApiEngine("minimax", "恢复原始错误", "test-provider-fetch-failed-retry", null, null, { cwd: root });
  assert.equal(calls, 2);
  assert.match(result.report, /原始 fetch failed 后恢复/);
  assert.deepEqual(result.telemetry.transportRetryReasons, ["provider_transport_fetch_failed"]);
});

test("API Agent 连续连接重置时只重试一次并返回最终传输码", async () => {
  let calls = 0;
  global.fetch = async () => {
    calls++;
    const cause = Object.assign(new Error("socket closed before response"), { code: "ECONNRESET" });
    throw Object.assign(new TypeError("fetch failed"), { cause });
  };

  await assert.rejects(
    engine.executeApiEngine("minimax", "连续网络失败", "test-provider-reset-exhausted", null, null, { cwd: root }),
    (error) => {
      assert.equal(error?.code, "API_PROVIDER_TRANSPORT_ERROR");
      assert.equal(error?.transportCode, "ECONNRESET");
      assert.equal(error?.telemetry?.requestAttempts, 2);
      assert.equal(error?.telemetry?.transportRetryCount, 1);
      assert.deepEqual(error?.telemetry?.requests.map((item) => item.outcome), [
        "retryable_transport_error",
        "transport_error",
      ]);
      return true;
    },
  );
  assert.equal(calls, 2);
});

test("API Agent 首包超时后只重试一次并可恢复", async () => {
  let calls = 0;
  global.fetch = async (_url, options) => {
    calls++;
    if (calls === 1) {
      return new Promise((_resolve, reject) => {
        options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true });
      });
    }
    return toolCallSseResponse({
      toolCalls: [{
        id: "finish-after-first-chunk-timeout",
        type: "function",
        function: {
          name: "finish_task",
          arguments: JSON.stringify({
            status: "completed",
            summary: "首包超时重试后完成",
            changes: [],
            verification: ["第二次请求收到响应"],
            remaining: [],
          }),
        },
      }],
      finishReason: "tool_calls",
    });
  };

  const result = await engine.executeApiEngine(
    "minimax",
    "等待 Provider",
    "test-provider-timeout-retry",
    null,
    null,
    { cwd: root },
    { firstChunkTimeoutMs: 30, streamIdleTimeoutMs: 80 },
  );
  assert.equal(calls, 2);
  assert.match(result.report, /首包超时重试后完成/);
  assert.deepEqual(result.telemetry.transportRetryReasons, ["provider_first_chunk_timeout"]);
});

test("API Agent 对证书错误不重试并返回可诊断传输码", async () => {
  let calls = 0;
  global.fetch = async () => {
    calls++;
    const cause = Object.assign(new Error("certificate expired"), { code: "CERT_HAS_EXPIRED" });
    throw Object.assign(new TypeError("fetch failed"), { cause });
  };

  await assert.rejects(
    engine.executeApiEngine("minimax", "检查证书失败", "test-provider-cert-failure", null, null, { cwd: root }),
    (error) => {
      assert.equal(error?.code, "API_PROVIDER_TRANSPORT_ERROR");
      assert.equal(error?.transportCode, "CERT_HAS_EXPIRED");
      assert.match(error?.message || "", /CERT_HAS_EXPIRED/);
      return true;
    },
  );
  assert.equal(calls, 1);
});

test("完成报告缺少结构时使用确定的部分完成兜底", () => {
  const report = engine.formatCompletionReport({ status: "unknown", summary: "需要确认", remaining: [] }, []);
  assert.match(report, /^任务状态：部分完成/);
  assert.match(report, /遗留事项/);
});

test("finish_task 原样保留工作流要求的完整最终正文与 REPORT_DONE 标记", async () => {
  let request;
  const finalResponse = [
    "## 简短报告",
    "原因：网页视频播放状态没有同步给系统媒体会话，方向盘按键被错误投给音乐应用。",
    "措施：让媒体会话跟随网页真实播放状态切换，使方向盘按键回到当前视频。",
    "<!-- REPORT_DONE -->",
  ].join("\n");
  global.fetch = async (_url, options) => {
    request = JSON.parse(options.body);
    return toolCallSseResponse({
      toolCalls: [{
        id: "finish-report",
        type: "function",
        function: {
          name: "finish_task",
          arguments: JSON.stringify({
            status: "completed",
            summary: "简短报告已生成",
            changes: [],
            verification: ["已根据修复证据重新总结"],
            remaining: [],
            final_response: finalResponse,
          }),
        },
      }],
      finishReason: "tool_calls",
    });
  };

  const result = await engine.executeApiEngine("deepseek", "生成简短报告", "test-report-response", null, null, { cwd: root });
  const finishTool = request.tools.find((tool) => tool.function?.name === "finish_task");
  assert.ok(finishTool.function.parameters.required.includes("final_response"));
  assert.equal(result.report, finalResponse);
  assert.doesNotMatch(result.report, /^任务状态：/);
});

test("有文件修改但没有验证时不能报告已完成", () => {
  const report = engine.formatCompletionReport({
    status: "completed", summary: "改完了", changes: ["修改 a.js"], verification: [], remaining: [],
  }, [{ name: "edit_file", args: { path: "a.js" }, result: "已编辑 a.js" }]);
  assert.match(report, /^任务状态：部分完成/);
  assert.match(report, /未执行 git diff\/status 或测试验证/);
});

test("故事点 API 缺少外置 tempFiles 或逻辑产物范围时在请求模型前失败", async () => {
  let fetched = false;
  global.fetch = async () => {
    fetched = true;
    throw new Error("不应调用模型");
  };
  await assert.rejects(
    engine.executeApiEngine("deepseek", "测试", "missing-story-temp", null, null, {
      cwd: root,
      storyScoped: true,
      artifactScope: { kind: "story", id: "tab-test", docSlug: "test-story" },
    }),
    /缺少外置 tempFiles/,
  );
  await assert.rejects(
    engine.executeApiEngine("deepseek", "测试", "missing-story-scope", null, null, {
      cwd: root,
      storyScoped: true,
      tempRoot: storyArtifacts,
    }),
    /缺少可验证的故事点产物范围/,
  );
  assert.equal(fetched, false);
});

test("故事点 API 的解压和进程快照只能写入外置 tempFiles", async () => {
  const zip = new JSZip();
  zip.file("payload.txt", "safe payload");
  fs.writeFileSync(path.join(root, "fixture.zip"), await zip.generateAsync({ type: "nodebuffer" }));
  const unsafeOutput = path.join(root, "must-not-extract.txt");
  let call = 0;
  global.fetch = async () => {
    call++;
    if (call === 1) {
      return toolCallSseResponse({
        toolCalls: [{
          id: "extract-source",
          type: "function",
          function: {
            name: "extract_archive_entry",
            arguments: JSON.stringify({
              path: "fixture.zip",
              entry_path: "payload.txt",
              output_path: unsafeOutput,
            }),
          },
        }],
        finishReason: "tool_calls",
      });
    }
    if (call === 2) {
      return toolCallSseResponse({
        toolCalls: [{
          id: "process-external",
          type: "function",
          function: {
            name: "start_process",
            arguments: JSON.stringify({
              command: "node -e \"setTimeout(() => console.log('artifact-process'), 1500)\"",
              purpose: "验证进程快照目录",
              max_minutes: 1,
            }),
          },
        }],
        finishReason: "tool_calls",
      });
    }
    return toolCallSseResponse({
      toolCalls: [{
        id: "finish-artifacts",
        type: "function",
        function: {
          name: "finish_task",
          arguments: JSON.stringify({
            status: "partial",
            summary: "边界验证完成",
            changes: [],
            verification: ["已验证产物目录"],
            remaining: ["源码路径解压被拒绝"],
          }),
        },
      }],
      finishReason: "tool_calls",
    });
  };

  const result = await engine.executeApiEngine("deepseek", "验证产物边界", "story-artifact-test", null, null, {
    cwd: root,
    addDirs: [storyArtifacts],
    storyScoped: true,
    tempRoot: storyArtifacts,
    artifactScope: { kind: "story", id: "tab-artifact-test", title: "产物边界", docSlug: "artifact-story" },
  });
  assert.match(result.report, /任务状态：部分完成/);
  assert.equal(fs.existsSync(unsafeOutput), false);
  assert.equal(fs.existsSync(path.join(root, "docs", "tempFiles")), false);
  const snapshots = fs.readdirSync(path.join(storyArtifacts, "api-tool-processes"));
  assert.ok(snapshots.some((name) => name.endsWith(".json")));
  // Windows 冷启动 node/PowerShell 的耗时波动较大；轮询真实快照终态，避免固定延时
  // 在机器繁忙时把仍在正常运行的 1.5s 测试进程误判为失败。
  let processStates = [];
  const processDeadline = Date.now() + 12_000;
  do {
    processStates = snapshots.map((name) => JSON.parse(
      fs.readFileSync(path.join(storyArtifacts, "api-tool-processes", name), "utf8"),
    ).status);
    if (processStates.includes("completed")) break;
    await new Promise((resolve) => setTimeout(resolve, 250));
  } while (Date.now() < processDeadline);
  assert.ok(processStates.includes("completed"), JSON.stringify(processStates));
});

test("关闭思考模式时请求显式发送 disabled", async () => {
  const config = JSON.parse(fs.readFileSync(process.env.GATEWAY_CONFIG_PATH, "utf8"));
  config.apiEngines.deepseek.thinkingEnabled = false;
  const { updateConfig } = await import("../services/config.js");
  updateConfig({ apiEngines: config.apiEngines });
  let request;
  global.fetch = async (_url, options) => {
    request = JSON.parse(options.body);
    return toolCallSseResponse({
      toolCalls: [{
        id: "finish-disabled", type: "function", function: { name: "finish_task", arguments: JSON.stringify({
          status: "completed", summary: "无需操作", changes: [], verification: [], remaining: [],
        }) },
      }],
      finishReason: "tool_calls",
    });
  };
  await engine.executeApiEngine("deepseek", "回答", "test-disabled", null, null, { cwd: root });
  assert.equal(request.thinking.type, "disabled");
  assert.equal("reasoning_effort" in request, false);
});

test("API 引擎接受故事点级 model/tier 运行时覆盖", async () => {
  const config = JSON.parse(fs.readFileSync(process.env.GATEWAY_CONFIG_PATH, "utf8"));
  config.apiEngines.deepseek.thinkingEnabled = true;
  config.apiEngines.deepseek.model = "deepseek-v4-pro";
  config.apiEngines.deepseek.reasoningEffort = "high";
  const { updateConfig } = await import("../services/config.js");
  updateConfig({ apiEngines: config.apiEngines });
  let request;
  global.fetch = async (_url, options) => {
    request = JSON.parse(options.body);
    return toolCallSseResponse({
      toolCalls: [{
        id: "finish-override", type: "function", function: { name: "finish_task", arguments: JSON.stringify({
          status: "completed", summary: "覆盖完成", changes: [], verification: [], remaining: [],
        }) },
      }],
      finishReason: "tool_calls",
    });
  };
  await engine.executeApiEngine(
    "deepseek",
    "回答",
    "test-override",
    null,
    null,
    { cwd: root },
    { model: "deepseek-story", tier: "max" },
  );
  assert.equal(request.model, "deepseek-story");
  assert.equal(request.reasoning_effort, "max");
});

test("纯文本流式调用接受工作总结 model/tier 与多模态内容覆盖", async () => {
  const config = JSON.parse(fs.readFileSync(process.env.GATEWAY_CONFIG_PATH, "utf8"));
  config.apiEngines.deepseek.thinkingEnabled = true;
  const { updateConfig } = await import("../services/config.js");
  updateConfig({ apiEngines: config.apiEngines });
  let request;
  const encoder = new TextEncoder();
  global.fetch = async (_url, options) => {
    request = JSON.parse(options.body);
    return {
      ok: true,
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"模板"}}]}\n'));
          controller.enqueue(encoder.encode("data: [DONE]\n"));
          controller.close();
        },
      }),
    };
  };
  const userContent = [
    { type: "text", text: "提取模板" },
    { type: "image_url", image_url: { url: "data:image/png;base64,AA==" } },
  ];
  const result = await engine.callApiEngineText("deepseek", "fallback", {
    model: "deepseek-summary",
    tier: "low",
    userContent,
  });
  assert.equal(result.text, "模板");
  assert.equal(request.model, "deepseek-summary");
  assert.equal(request.reasoning_effort, "low");
  assert.deepEqual(request.messages.at(-1).content, userContent);
  const serializedContent = JSON.stringify(userContent);
  assert.equal(result.telemetry.promptChars, Array.from(serializedContent).length);
  assert.equal(
    result.telemetry.promptSha256,
    createHash("sha256").update(serializedContent, "utf8").digest("hex"),
  );
});

test("纯文本报告调用记录 stream_options 兼容重试和真实 usage", async () => {
  const requests = [];
  global.fetch = async (_url, options) => {
    requests.push(JSON.parse(options.body));
    if (requests.length === 1) {
      return {
        ok: false,
        status: 400,
        body: null,
        text: async () => "unsupported stream_options",
      };
    }
    return toolCallSseResponse({
      content: "报告完成",
      finishReason: "stop",
      usage: { prompt_tokens: 41, completion_tokens: 9 },
    });
  };

  const result = await engine.callApiEngineText("deepseek", "生成报告", {
    system: "只输出报告",
    telemetryContext: {
      attemptId: "report-attempt",
      workflowKind: "report",
      stage: "REPORT_SHORT",
    },
  });

  assert.equal(result.text, "报告完成");
  assert.equal(requests.length, 2);
  assert.equal(result.telemetry.requestAttempts, 2);
  assert.equal(result.telemetry.requestCount, 1);
  assert.equal(result.telemetry.retryCount, 1);
  assert.equal(result.telemetry.toolRounds, 0);
  assert.equal(result.telemetry.usage.source, "provider");
  assert.equal(result.telemetry.usage.inputTokens, 41);
  assert.equal(result.telemetry.usage.outputTokens, 9);
  assert.equal(result.telemetry.executionSucceeded, true);
});

test("apiMaxToolIterations=0 迁移为有限安全上限，长任务仍可在上限内完成", async () => {
  const { getConfig, updateConfig } = await import("../services/config.js");
  updateConfig({ apiMaxToolIterations: 0 });
  let calls = 0;
  global.fetch = async () => {
    calls++;
    if (calls <= 45) {
      return toolCallSseResponse({
        toolCalls: [{ id: `list-${calls}`, type: "function", function: { name: "list_dir", arguments: "{\"path\":\".\"}" } }],
        finishReason: "tool_calls",
      });
    }
    return toolCallSseResponse({
      toolCalls: [{ id: "finish-unlimited", type: "function", function: { name: "finish_task", arguments: JSON.stringify({
        status: "completed", summary: "不限轮次执行完成", changes: [], verification: [], remaining: [],
      }) } }],
      finishReason: "tool_calls",
    });
  };
  const result = await engine.executeApiEngine("deepseek", "持续执行", "test-unlimited", null, null, { cwd: root });
  assert.equal(getConfig().apiMaxToolIterations, 80);
  assert.equal(calls, 46);
  assert.match(result.report, /^任务状态：已完成/);
  // Restore the suite default so later tests whose mock deliberately never
  // emits finish_task still exercise the bounded compatibility path.
  updateConfig({ apiMaxToolIterations: 5 });
});

test("executeApiEngine 在故事点档位 high 下应同时启用思考并下发 reasoning_effort", async () => {
  // volcengine.cfg.thinkingEnabled=false（持久化默认），tierOverride=high 时必须把 thinkingEnabled 翻起来，
  // 否则 reasoningRequest 因 cfg.thinkingEnabled !== true 而静默丢弃 reasoning_effort，前端显示的「档位 high」是假的。
  let request;
  global.fetch = async (_url, options) => {
    request = JSON.parse(options.body);
    return toolCallSseResponse({
      toolCalls: [{
        id: "finish-tier", type: "function", function: { name: "finish_task", arguments: JSON.stringify({
          status: "completed", summary: "档位覆盖完成", changes: [], verification: [], remaining: [],
          final_response: "档位 high 已生效。",
        }) },
      }],
      finishReason: "stop",
    });
  };
  const finalResponse = "档位 high 已生效。";
  const result = await engine.executeApiEngine(
    "volcengine",
    "档位覆盖",
    "test-tier-high",
    null,
    null,
    { cwd: root },
    { model: "glm-5.2[1m]", tier: "high", aiSnapshot: { engine: "volcengine", model: "glm-5.2[1m]", tier: "high", capturedAt: Date.now() } },
  );
  assert.equal(result.report, finalResponse);
  assert.deepEqual(request.thinking, { type: "enabled" }, "档位 high 必须把 thinkingEnabled 翻起，请求里应带 thinking.type=enabled");
  assert.equal(request.reasoning_effort, "high", "档位 high 必须落到 reasoning_effort=high（之前会被静默丢弃）");
});

test("executeApiEngine 把每条流片段同时喂给 task.onStream（devbench liveDraft 依赖）", async () => {
  const logger = await import("../services/logger.js");
  const sessionId = "test-on-stream-session";
  const captured = [];
  const mockClient = {
    readyState: 1,
    subscribedSessions: new Set([sessionId]),
    send: (msg) => captured.push(JSON.parse(msg)),
  };
  logger.setWsClients(new Set([mockClient]));
  try {
    const observerChunks = [];
    const observer = (entry) => observerChunks.push({ dt: entry.deltaType, value: String(entry.chunk || ""), engine: entry.engine });
    global.fetch = async () => toolCallSseResponse({
      reasoning: "先观察文件",
      toolCalls: [{
        id: "list-1", type: "function", function: { name: "list_dir", arguments: "{\"path\":\".\"}" },
      }],
      finishReason: "tool_calls",
    });
    await engine.executeApiEngine(
      "volcengine",
      "观察目录",
      "test-on-stream",
      sessionId,
      null,
      { cwd: root },
      { model: "glm-5.2[1m]", tier: "high", onStream: observer },
    );
    // 至少应有 status + thinking 两类事件被同步转发到 onStream（devbench appendLiveStream → liveDraft）。
    const dtSet = new Set(observerChunks.map((c) => c.dt));
    assert.ok(dtSet.has("status"), "onStream 应收到首条 status 片段（让 liveDraft 创建条目）");
    assert.ok(dtSet.has("thinking"), "onStream 应收到 thinking 片段（让 liveDraft 累积思考）");
    assert.ok(observerChunks.every((c) => c.engine === "volcengine"), "onStream 收到的事件应带 engine=volcengine");
    // WS 端亦收到对应事件（保持与 CLI 路径一致）。
    const wsThinking = captured.filter((m) => m.type === "chat_stream" && m.data?.deltaType === "thinking");
    assert.ok(wsThinking.length > 0, "WS 也应收到 thinking 片段");
  } finally {
    logger.setWsClients(new Set());
  }
});

test("executeApiEngine 终止时通过 WS 广播 chat_stream_end，让前端 streaming 早于 chat_message 翻转", async () => {
  const logger = await import("../services/logger.js");
  const sessionId = "test-stream-end-session";
  const captured = [];
  const mockClient = {
    readyState: 1,
    subscribedSessions: new Set([sessionId]),
    send: (msg) => captured.push(JSON.parse(msg)),
  };
  logger.setWsClients(new Set([mockClient]));
  try {
    global.fetch = async () => toolCallSseResponse({
      toolCalls: [{
        id: "finish-stream-end", type: "function", function: { name: "finish_task", arguments: JSON.stringify({
          status: "completed", summary: "完成", changes: [], verification: [], remaining: [],
          final_response: "已结束。",
        }) },
      }],
      finishReason: "stop",
    });
    await engine.executeApiEngine(
      "volcengine",
      "结束",
      "test-stream-end",
      sessionId,
      null,
      { cwd: root },
      { model: "glm-5.2[1m]", tier: "high", aiSnapshot: { engine: "volcengine", model: "glm-5.2[1m]", tier: "high", capturedAt: Date.now() } },
    );
    const endEvents = captured.filter((m) => m.type === "chat_stream_end");
    assert.equal(endEvents.length, 1, "终止时应发且仅发一条 chat_stream_end");
    assert.equal(endEvents[0].data.sessionId, sessionId);
    assert.equal(endEvents[0].data.engine, "volcengine");
    assert.equal(endEvents[0].data.success, true);
  } finally {
    logger.setWsClients(new Set());
  }
});

test("executeApiEngine 抛错路径也走 chat_stream_end，UI 不会卡在 streaming=true", async () => {
  const logger = await import("../services/logger.js");
  const sessionId = "test-stream-end-err-session";
  const captured = [];
  const mockClient = {
    readyState: 1,
    subscribedSessions: new Set([sessionId]),
    send: (msg) => captured.push(JSON.parse(msg)),
  };
  logger.setWsClients(new Set([mockClient]));
  try {
    global.fetch = async () => ({ ok: false, status: 500, text: async () => "server error" });
    let thrown;
    await assert.rejects(engine.executeApiEngine(
      "volcengine",
      "故意失败",
      "test-stream-end-err",
      sessionId,
      null,
      { cwd: root },
      { model: "glm-5.2[1m]", tier: "high" },
    ), (error) => {
      thrown = error;
      return true;
    });
    assert.equal(thrown.telemetry.executionSucceeded, false);
    assert.equal(thrown.telemetry.requestAttempts, 1);
    assert.equal(thrown.telemetry.requests[0].outcome, "http_500");
    assert.equal(thrown.telemetry.usage.source, "unavailable");
    const endEvents = captured.filter((m) => m.type === "chat_stream_end");
    assert.equal(endEvents.length, 1, "异常路径也应补发一条 chat_stream_end");
    assert.equal(endEvents[0].data.sessionId, sessionId);
    assert.equal(endEvents[0].data.success, false);
  } finally {
    logger.setWsClients(new Set());
  }
});

test("故事点 API 模型在首轮请求中获得完整 AppMarket MCP 工具集", async () => {
  const requests = [];
  global.fetch = async (_url, options) => {
    requests.push(JSON.parse(options.body));
    return toolCallSseResponse({
      toolCalls: [{
        id: "finish-appmarket-tools",
        type: "function",
        function: {
          name: "finish_task",
          arguments: JSON.stringify({
            status: "completed",
            summary: "已确认工具注册。",
            changes: [],
            verification: ["AppMarket MCP 工具已注入"],
            remaining: [],
            final_response: "工具注册检查完成。",
          }),
        },
      }],
      finishReason: "tool_calls",
    });
  };

  const result = await engine.executeApiEngine(
    "deepseek",
    "检查工具注册",
    "test-appmarket-mcp-tools",
    null,
    null,
    {
      cwd: root,
      storyScoped: true,
      tempRoot: storyArtifacts,
      artifactScope: { kind: "story", id: "story-mcp", title: "MCP", docSlug: "story-mcp" },
    },
  );

  const names = requests[0].tools.map((tool) => tool.function.name);
  assert.equal(names.filter((name) => name.startsWith("appmarket_admin_")).length, 20);
  assert.ok(names.includes("appmarket_admin_self_check"));
  assert.equal(result.report, "工具注册检查完成。");
});

function structuredFixture() {
  const schema = {
    type: "object",
    additionalProperties: false,
    properties: {
      contextId: { type: "string" },
      revision: { type: "integer" },
      conclusion: { type: "string", enum: ["PASS", "FAIL"] },
    },
    required: ["contextId", "revision", "conclusion"],
  };
  const descriptor = {
    mode: "structured",
    strategy: "finish_stage",
    schemaId: "urn:aiefficiency:workflow-v2:test-result",
    schema,
    contextId: "ctx-provider-1",
    contextRevision: 4,
    idempotencyKey: "story-provider:VERIFY:4",
  };
  const telemetryContext = {
    promptMode: "structured",
    contextId: descriptor.contextId,
    contextRevision: descriptor.contextRevision,
    schemaId: descriptor.schemaId,
    idempotencyKey: descriptor.idempotencyKey,
    storyId: "story-provider",
    stage: "VERIFY",
  };
  return { descriptor, telemetryContext };
}

test("structured API 只暴露动态 finish_stage，冻结 Schema 并累加 usage/attempt", async () => {
  const requests = [];
  const streamEvents = [];
  const fixture = structuredFixture();
  let call = 0;
  global.fetch = async (_url, options) => {
    requests.push(JSON.parse(options.body));
    call++;
    if (call === 1) {
      // executeApiEngine 在首个 await 之前已对 descriptor/schema 做深拷贝快照。
      fixture.descriptor.schema.properties.conclusion.enum.push("MUTATED");
      fixture.descriptor.schemaId = "mutated-after-dispatch";
      return toolCallSseResponse({
        reasoning: '{"internal":"must-not-leak"}',
        toolCalls: [{
          id: "read-structured",
          type: "function",
          function: {
            name: "read_file",
            arguments: JSON.stringify({ path: "hello.txt", start_line: 1, line_count: 5 }),
          },
        }],
        usage: { prompt_tokens: 11, completion_tokens: 3 },
      });
    }
    return toolCallSseResponse({
      toolCalls: [{
        id: "finish-structured",
        type: "function",
        function: {
          name: "finish_stage",
          arguments: JSON.stringify({ contextId: "ctx-provider-1", revision: 4, conclusion: "PASS" }),
        },
      }],
      usage: { prompt_tokens: 7, completion_tokens: 5 },
    });
  };

  const result = await engine.executeApiEngine(
    "deepseek",
    "提交结构化阶段结果",
    "test-structured-success",
    null,
    null,
    { cwd: root },
    {
      structuredOutput: fixture.descriptor,
      telemetryContext: fixture.telemetryContext,
      onStream: (event) => streamEvents.push(event),
    },
  );

  const toolNames = requests[0].tools.map((tool) => tool.function.name);
  assert.equal(toolNames.includes("finish_task"), false);
  assert.equal(toolNames.filter((name) => name === "finish_stage").length, 1);
  const terminalTool = requests[0].tools.find((tool) => tool.function.name === "finish_stage");
  assert.deepEqual(terminalTool.function.parameters.properties.conclusion.enum, ["PASS", "FAIL"]);
  assert.doesNotMatch(requests[0].messages[0].content, /finish_task/);
  assert.match(requests[0].messages[0].content, /finish_stage/);
  assert.equal(result.structuredSchemaId, "urn:aiefficiency:workflow-v2:test-result");
  assert.deepEqual(result.structuredResult, { contextId: "ctx-provider-1", revision: 4, conclusion: "PASS" });
  assert.equal(Object.isFrozen(result.structuredResult), true);
  assert.equal(result.output, "");
  assert.equal(result.report, "");
  assert.equal(result.telemetry.requestCount, 2);
  assert.equal(result.telemetry.requestAttempts, 2);
  assert.equal(result.telemetry.toolRounds, 2);
  assert.equal(result.telemetry.toolCalls, 2);
  assert.equal(result.usage.inputTokens, 18);
  assert.equal(result.usage.outputTokens, 8);
  assert.equal(streamEvents.some((event) => event.deltaType === "text"), false);
  assert.equal(streamEvents.some((event) => event.deltaType === "thinking"), false);
  assert.equal(result.transcript.some((item) => item.type === "thinking"), false);
  assert.equal(result.transcript.some((item) => item.content.includes("conclusion")), false);
});

test("structured API 拒绝文本/fence，不进入纯文本 finalization fallback", async () => {
  for (const content of [
    "已完成",
    '```json\n{"contextId":"ctx-provider-1","revision":4,"conclusion":"PASS"}\n```',
  ]) {
    const requests = [];
    const streamed = [];
    const fixture = structuredFixture();
    global.fetch = async (_url, options) => {
      requests.push(JSON.parse(options.body));
      return toolCallSseResponse({ content, toolCalls: [], finishReason: "stop", usage: { prompt_tokens: 2, completion_tokens: 2 } });
    };
    await assert.rejects(
      engine.executeApiEngine(
        "deepseek",
        "严格输出",
        "test-structured-text",
        null,
        null,
        { cwd: root },
        { ...fixture, structuredOutput: fixture.descriptor, onStream: (event) => streamed.push(event) },
      ),
      (error) => error.code === "WORKFLOW_V2_STRUCTURED_TEXT_NOT_ALLOWED"
        && error.telemetry.requestCount === 1
        && error.telemetry.usage.inputTokens === 2,
    );
    assert.equal(requests.length, 1);
    assert.equal(streamed.some((event) => event.deltaType === "text"), false);
  }
});

test("structured API 拒绝非 object arguments 和重复终态", async () => {
  const cases = [
    {
      code: "WORKFLOW_V2_STRUCTURED_ARGUMENTS_INVALID",
      calls: [{ id: "bad-json", type: "function", function: { name: "finish_stage", arguments: "```json\\n{}\\n```" } }],
    },
    {
      code: "WORKFLOW_V2_STRUCTURED_ARGUMENTS_INVALID",
      calls: [{ id: "bad-array", type: "function", function: { name: "finish_stage", arguments: "[]" } }],
    },
    {
      code: "WORKFLOW_V2_STRUCTURED_TERMINAL_DUPLICATE",
      calls: [
        { id: "finish-a", type: "function", function: { name: "finish_stage", arguments: "{}" } },
        { id: "finish-b", type: "function", function: { name: "finish_stage", arguments: "{}" } },
      ],
    },
  ];
  for (const scenario of cases) {
    const fixture = structuredFixture();
    global.fetch = async () => toolCallSseResponse({ toolCalls: scenario.calls, finishReason: "tool_calls" });
    await assert.rejects(
      engine.executeApiEngine(
        "deepseek",
        "严格输出",
        `test-structured-${scenario.code}`,
        null,
        null,
        { cwd: root },
        { structuredOutput: fixture.descriptor, telemetryContext: fixture.telemetryContext },
      ),
      (error) => error.code === scenario.code
        && !JSON.stringify(error.transcript || []).includes("contextId"),
    );
  }
});

test("structured API 同轮 finish_stage+非终态时只接受终态（deepseek 多工具适配）", async () => {
  const fixture = structuredFixture();
  const requests = [];
  global.fetch = async (_url, options) => {
    requests.push(JSON.parse(options.body));
    return toolCallSseResponse({
      toolCalls: [
        { id: "read-mixed", type: "function", function: { name: "read_file", arguments: "{}" } },
        {
          id: "finish-mixed",
          type: "function",
          function: { name: "finish_stage", arguments: JSON.stringify({ contextId: "ctx-provider-1", revision: 4, conclusion: "PASS" }) },
        },
      ],
      finishReason: "tool_calls",
    });
  };
  const result = await engine.executeApiEngine(
    "deepseek",
    "严格输出",
    "test-structured-mixed",
    null,
    null,
    { cwd: root },
    { structuredOutput: fixture.descriptor, telemetryContext: fixture.telemetryContext },
  );
  assert.deepEqual(result.structuredResult, { contextId: "ctx-provider-1", revision: 4, conclusion: "PASS" });
  assert.equal(result.telemetry.toolCalls, 2, "Provider 报告两个调用（finish_stage + read_file）");
  assert.ok(
    result.transcript.some((item) => item.type === "tool_use" && /已忽略同轮非终态调用/.test(item.content)),
    "被忽略调用必须记录到 transcript",
  );
  // 被忽略的 read_file 不得进入下一轮消息
  assert.equal(requests.length, 1, "终态轮后不再请求");
});

test("structured API 同轮多个非终态工具按序执行", async () => {
  const fixture = structuredFixture();
  const requests = [];
  let call = 0;
  global.fetch = async (_url, options) => {
    requests.push(JSON.parse(options.body));
    call++;
    if (call === 1) {
      return toolCallSseResponse({
        content: "我先检查一下工作区（deepseek 工具轮伴随文本，应放行不回传为结果）",
        toolCalls: [
          { id: "t-a", type: "function", function: { name: "read_file", arguments: JSON.stringify({ path: "hello.txt", start_line: 1, line_count: 3 }) } },
          { id: "t-b", type: "function", function: { name: "search_files", arguments: JSON.stringify({ pattern: "hello" }) } },
        ],
        finishReason: "tool_calls",
      });
    }
    return toolCallSseResponse({
      toolCalls: [{
        id: "finish-after-tools",
        type: "function",
        function: { name: "finish_stage", arguments: JSON.stringify({ contextId: "ctx-provider-1", revision: 4, conclusion: "FAIL" }) },
      }],
      finishReason: "tool_calls",
    });
  };
  const result = await engine.executeApiEngine(
    "deepseek",
    "严格输出",
    "test-structured-multi-tools",
    null,
    null,
    { cwd: root },
    { structuredOutput: fixture.descriptor, telemetryContext: fixture.telemetryContext },
  );
  assert.deepEqual(result.structuredResult, { contextId: "ctx-provider-1", revision: 4, conclusion: "FAIL" });
  assert.equal(result.telemetry.toolCalls, 3, "两个非终态工具 + finish_stage");
  assert.equal(requests.length, 2, "工具轮后仍有一轮终态请求");
  // 非终态工具结果必须进入消息序列（assistant 在前、tool 逐条在后）；
  // 工具轮伴随文本作为 assistant content 回传以保持模型上下文连贯
  const lastRequest = requests[1];
  const roles = lastRequest.messages.slice(-4).map((message) => message.role);
  assert.equal(roles[0], "assistant");
  assert.equal(roles[1], "tool");
  assert.equal(roles[2], "tool");
  assert.match(String(lastRequest.messages.at(-4)?.content || ""), /我先检查一下工作区/);
});

test("structured API 缺少 finish_stage 时 typed fail closed", async () => {
  const fixture = structuredFixture();
  global.fetch = async () => toolCallSseResponse({ toolCalls: [], content: "", finishReason: "stop" });
  await assert.rejects(
    engine.executeApiEngine(
      "deepseek",
      "必须结构化收口",
      "test-structured-missing",
      null,
      null,
      { cwd: root },
      { structuredOutput: fixture.descriptor, telemetryContext: fixture.telemetryContext },
    ),
    (error) => error.code === "WORKFLOW_V2_STRUCTURED_TERMINAL_MISSING",
  );
});
