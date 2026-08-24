import { test, before } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agent-timeout-"));
process.env.HOME = tmp;
process.env.USERPROFILE = tmp;
process.env.GATEWAY_DB_PATH = path.join(tmp, "data.db");
process.env.GATEWAY_CONFIG_PATH = path.join(tmp, "gateway.json");
process.env.NODE_ENV = "test";
fs.writeFileSync(process.env.GATEWAY_CONFIG_PATH, JSON.stringify({
  codexEnabled: true,
  hermesEnabled: true,
  autoFallback: false,
  maxCliConcurrency: 1,
  workDir: tmp,
  apiEngines: {
    atlas: {
      enabled: true,
      apiKey: "atlas-test-key",
      baseUrl: "https://api.atlascloud.ai/v1",
      model: "zai-org/glm-5.1",
    },
  },
}));

const fake = path.join(tmp, "fake-codex.mjs");
fs.writeFileSync(fake, `
import fs from "node:fs";
const emit = (text) => process.stdout.write(JSON.stringify({
  type: "item.completed",
  item: { type: "agent_message", text },
}) + "\\n");
if (process.env.FAKE_CODEX_MODE === "messages") {
  emit("我先检查现有改动。");
  emit("任务状态：已完成\\n最终总结");
} else if (process.env.FAKE_CODEX_MODE === "delayed-message") {
  setTimeout(() => emit("delayed prompt inspection complete"), 300);
} else if (process.env.FAKE_CODEX_MODE === "stderr-authlike-tool") {
  process.stderr.write("2026-07-11T14:16:30Z ERROR codex_core::tools::router: error=Exit code: 1\\n");
  process.stderr.write("Output:\\nUnauthorizedAccessException: Access to the path is denied\\nFullName\\n");
  emit("Task status: completed\\nrouter stderr should not be treated as CLI auth");
} else if (process.env.FAKE_CODEX_MODE === "tool-output") {
  process.stdout.write(JSON.stringify({
    type: "item.started",
    item: { type: "command_execution", command: "python tools/run_all.py" },
  }) + "\\n");
  process.stdout.write(JSON.stringify({
    type: "item.completed",
    item: {
      type: "command_execution",
      command: "python tools/run_all.py",
      output: "-> pass [41/150] TC-A1001009-open-from-21600 page_source=21600\\n-> missing, retry 1/1",
    },
  }) + "\\n");
  emit("Task status: completed\\ncommand output streamed");
} else if (process.env.FAKE_CODEX_MODE === "turn-completed-hang") {
  emit("## 简短报告\\n结论：未通过\\n<!-- VERIFY: FAIL -->");
  process.stdout.write(JSON.stringify({
    type: "turn.completed",
    usage: { input_tokens: 31, output_tokens: 7, cache_read_input_tokens: 5 },
  }) + "\\n");
  setInterval(() => {}, 1000);
} else if (process.env.FAKE_CODEX_MODE === "zero-output-hang") {
  setInterval(() => {}, 1000);
} else if (process.env.FAKE_CODEX_MODE === "refresh-reused-once") {
  const marker = process.env.FAKE_CODEX_REFRESH_MARKER;
  if (!marker || fs.existsSync(marker)) {
    emit("credential reload recovered the original CARB-13546 turn");
  } else {
    fs.writeFileSync(marker, "first attempt failed", "utf8");
    process.stderr.write('ERROR codex_login::auth::manager: 401 Unauthorized: {"code":"refresh_token_reused","message":"Your refresh token has already been used"}\\n');
    process.exitCode = 1;
  }
} else if (process.env.FAKE_CODEX_MODE === "refresh-reused-always") {
  process.stderr.write('ERROR codex_login::auth::manager: 401 Unauthorized: {"code":"refresh_token_reused","message":"Your refresh token has already been used"}\\n');
  process.exitCode = 1;
} else {
  process.stdout.write(JSON.stringify({ type: "thread.started", thread_id: "fake-session" }) + "\\n");
  setInterval(() => {}, 1000);
}
`);

const fakeHermes = path.join(tmp, "fake-hermes.mjs");
fs.writeFileSync(fakeHermes, `
import fs from "node:fs";
const args = process.argv.slice(2);
const at = args.indexOf("at");
if (at < 0 || args[at + 2] !== "before") { process.stderr.write("missing prompt reference: " + JSON.stringify(args)); process.exit(2); }
let token = args[at + 1];
let promptFile;
try { promptFile = JSON.parse(token); }
catch {
  promptFile = token.replace(/^\"|\"$/g, "");
  const slash = String.fromCharCode(92);
  while (promptFile.includes(slash + slash)) promptFile = promptFile.split(slash + slash).join(slash);
}
const content = fs.readFileSync(promptFile, "utf8");
if (!content.includes("unique hermes prompt marker")) { process.stderr.write("wrong prompt content"); process.exit(3); }
const usageIndex = args.indexOf("--usage-file");
if (usageIndex >= 0) fs.writeFileSync(args[usageIndex + 1], JSON.stringify({
  input_tokens: 21, output_tokens: 8, cache_read_tokens: 3, cache_write_tokens: 2,
  total_tokens: 34, api_calls: 2, estimated_cost_usd: 0.012, model: "local-hermes-model",
  provider: "test-provider", completed: true, failed: false,
}));
process.stdout.write("Hermes local agent completed");
`);

if (process.platform === "win32") {
  fs.writeFileSync(path.join(tmp, "codex.cmd"), `@echo off\r\nnode "${fake}" %*\r\n`);
  fs.writeFileSync(path.join(tmp, "hermes.cmd"), `@echo off\r\nnode "${fakeHermes}" %*\r\n`);
  process.env.AIEFF_HERMES_EXECUTABLE = path.join(tmp, "hermes.cmd");
} else {
  const bin = path.join(tmp, "codex");
  fs.writeFileSync(bin, `#!/bin/sh\nexec node "${fake}" "$@"\n`);
  fs.chmodSync(bin, 0o755);
  const hermesBin = path.join(tmp, "hermes");
  fs.writeFileSync(hermesBin, `#!/bin/sh\nexec node "${fakeHermes}" "$@"\n`);
  fs.chmodSync(hermesBin, 0o755);
  process.env.AIEFF_HERMES_EXECUTABLE = hermesBin;
}
process.env.PATH = `${tmp}${path.delimiter}${process.env.PATH || ""}`;

function apiToolCallSseResponse(toolCalls) {
  const encoder = new TextEncoder();
  const events = [];
  toolCalls.forEach((call, index) => {
    events.push({
      choices: [{
        delta: {
          tool_calls: [{
            index,
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
            index,
            function: { arguments: call.function.arguments },
          }],
        },
      }],
    });
  });
  events.push({ choices: [{ delta: {}, finish_reason: "tool_calls" }] });
  const body = new ReadableStream({
    start(controller) {
      for (const event of events) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      }
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

let db;
let runTask;
let getRunningAgents;
let shouldAutoFallback;
let stopTaskAgent;
let isTaskAgentRunning;
let defaultIdleTimeoutMsForTask;
let defaultMaxTimeoutMsForTask;
let shouldTrustWorkingStatusForTask;
let isCliAuthError;
let apiEngineLocalTargetForTask;
let cliPermissionArgs;
let isCodexRefreshTokenReusedError;
let shouldRetryCodexRefreshTokenError;
before(async () => {
  db = await import("../db/sqlite.js");
  ({
    runTask,
    getRunningAgents,
    shouldAutoFallback,
    stopTaskAgent,
    isTaskAgentRunning,
    defaultIdleTimeoutMsForTask,
    defaultMaxTimeoutMsForTask,
    shouldTrustWorkingStatusForTask,
    isCliAuthError,
    apiEngineLocalTargetForTask,
    cliPermissionArgs,
    isCodexRefreshTokenReusedError,
    shouldRetryCodexRefreshTokenError,
  } = await import("../services/agent-runner.js"));
});

test("故事点明确禁止回退时保持用户选择的引擎", () => {
  assert.equal(shouldAutoFallback({ explicitEngine: "deepseek", allowEngineFallback: false }, { autoFallback: true }), false);
  assert.equal(shouldAutoFallback({ explicitEngine: "deepseek" }, { autoFallback: true }), true);
});

test("devbench Codex 使用长 idle 上限，避免故事点 15 分钟静默误杀", () => {
  assert.equal(defaultIdleTimeoutMsForTask("codex", { source: "devbench" }), 60 * 60 * 1000);
  assert.equal(defaultIdleTimeoutMsForTask("codex", { source: "web" }), 15 * 60 * 1000);
  assert.equal(defaultMaxTimeoutMsForTask("codex", { source: "devbench" }), 8 * 60 * 60 * 1000);
  assert.equal(defaultMaxTimeoutMsForTask("codex", { source: "web" }), 2 * 60 * 60 * 1000);
  assert.equal(shouldTrustWorkingStatusForTask("codex", { source: "devbench" }), true);
  assert.equal(shouldTrustWorkingStatusForTask("codex", { source: "devbench", trustWorkingStatus: false }), false);
  assert.equal(shouldTrustWorkingStatusForTask("codex", { source: "web" }), false);
});

test("API 引擎透传统一 artifactScope，不拆成另一套故事字段", () => {
  const artifactScope = { kind: "story", id: "story-1", title: "Story 1", docSlug: "story-1" };
  const signal = new AbortController().signal;
  const target = apiEngineLocalTargetForTask({
    cwd: tmp,
    addDirs: [tmp],
    storyScoped: true,
    tempRoot: path.join(tmp, "story-temp"),
    artifactScope,
    storyId: "legacy-id",
  }, signal);
  assert.equal(target.artifactScope, artifactScope);
  assert.equal(target.signal, signal);
  assert.equal(target.storyScoped, true);
  assert.equal("storyId" in target, false);

  const readOnlyTarget = apiEngineLocalTargetForTask({
    cwd: tmp,
    commandPolicy: "read_only",
  }, signal);
  assert.equal(readOnlyTarget.commandPolicy, "read_only");
});

test("代码评审 CLI 使用引擎原生只读策略，不携带危险写权限参数", () => {
  const task = { commandPolicy: "read_only" };
  const claude = cliPermissionArgs("claude", task);
  const gemini = cliPermissionArgs("gemini", task);
  const codex = cliPermissionArgs("codex", task);
  assert.deepEqual(claude.slice(0, 2), ["--permission-mode", "plan"]);
  assert.equal(claude.includes("--dangerously-skip-permissions"), false);
  assert.deepEqual(gemini, ["--approval-mode", "plan"]);
  assert.equal(gemini.includes("--yolo"), false);
  assert.deepEqual(codex, ["--sandbox", "read-only"]);
  assert.equal(codex.includes("--dangerously-bypass-approvals-and-sandbox"), false);
});

test("Hermes 通过临时文件接收大 Prompt，并回传最终答案与真实用量", async () => {
  const storyTempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agent-hermes-story-"));
  const streamed = [];
  const task = {
    id: randomUUID(),
    title: "Hermes local integration",
    description: "unused",
    promptOverride: "unique hermes prompt marker",
    type: "general",
    status: "pending",
    priority: 3,
    source: "devbench",
    sourceId: "test-hermes-local",
    explicitEngine: "hermes",
    allowEngineFallback: false,
    storyScoped: true,
    tempRoot: storyTempRoot,
    cwd: tmp,
    onStream: (event) => streamed.push(event),
  };
  db.createTask(task);
  try {
    const result = await runTask(task);
    assert.equal(result.report, "Hermes local agent completed");
    const usage = streamed.find((event) => event.deltaType === "usage")?.usage;
    assert.equal(usage.inputTokens, 21);
    assert.equal(usage.outputTokens, 8);
    assert.equal(usage.model, "local-hermes-model");
    assert.deepEqual(fs.readdirSync(path.join(storyTempRoot, "prompts")), []);
  } finally {
    fs.rmSync(storyTempRoot, { recursive: true, force: true });
  }
});

test("Hermes 在只读任务中失败关闭，不把 oneshot 自动审批冒充只读沙箱", async () => {
  const task = {
    id: randomUUID(), title: "Hermes readonly", description: "review only", type: "general",
    status: "pending", priority: 3, source: "test", sourceId: "test-hermes-readonly",
    explicitEngine: "hermes", allowEngineFallback: false, commandPolicy: "read_only", cwd: tmp,
  };
  db.createTask(task);
  await assert.rejects(runTask(task), (error) => error?.code === "HERMES_READ_ONLY_UNSUPPORTED");
  assert.equal(isTaskAgentRunning(task.id), false);
});

test("Codex 无输出超时会直接失败并释放运行槽，不依赖 close 事件收尾", async () => {
  process.env.FAKE_CODEX_MODE = "hang";
  const task = {
    id: randomUUID(),
    title: "timeout regression",
    description: "hang",
    type: "general",
    status: "pending",
    priority: 3,
    source: "test",
    sourceId: "test-session",
    explicitEngine: "codex",
    cwd: tmp,
    idleTimeoutMs: 150,
    maxTimeoutMs: 3000,
  };
  db.createTask(task);

  await assert.rejects(runTask(task), /判定为卡死并终止/);
  assert.equal(db.getTask(task.id).status, "failed");
  assert.deepEqual(getRunningAgents(), []);
});

test("Codex 首次输出前的心跳使用状态流并展示启动上限", async () => {
  process.env.FAKE_CODEX_MODE = "zero-output-hang";
  const streamed = [];
  const task = {
    id: randomUUID(),
    title: "first output heartbeat regression",
    description: "hang before first output",
    type: "general",
    status: "pending",
    priority: 3,
    source: "devbench",
    sourceId: "test-session-first-output-heartbeat",
    explicitEngine: "codex",
    cwd: tmp,
    idleTimeoutMs: 5 * 60 * 1000,
    maxTimeoutMs: 3000,
    firstOutputTimeoutMs: 240,
    cliHeartbeatIntervalMs: 50,
    onStream: ({ deltaType, chunk }) => streamed.push({ deltaType, chunk }),
  };
  db.createTask(task);

  await assert.rejects(
    runTask(task),
    (error) => error?.timeoutKind === "first-output"
  );
  const statuses = streamed.filter((entry) => entry.deltaType === "status");
  assert.ok(statuses.length > 0);
  assert.ok(statuses.some((entry) => /首次输出上限 240 毫秒/.test(entry.chunk)));
  assert.equal(streamed.some((entry) => entry.deltaType === "thinking"), false);
  assert.equal(db.getTask(task.id).status, "failed");
  assert.deepEqual(getRunningAgents(), []);
});

test("CLI 并发槽位占满时持续展示排队状态，获得槽位后再提示开始执行", async () => {
  process.env.FAKE_CODEX_MODE = "delayed-message";
  const firstStreamed = [];
  const secondStreamed = [];
  const createCliTask = (title, sourceId, onStream) => ({
    id: randomUUID(),
    title,
    description: title,
    type: "general",
    status: "pending",
    priority: 3,
    source: "devbench",
    sourceId,
    explicitEngine: "codex",
    cwd: tmp,
    idleTimeoutMs: 3000,
    maxTimeoutMs: 5000,
    cliQueueHeartbeatIntervalMs: 30,
    onStream,
  });
  const first = createCliTask(
    "occupy cli slot",
    "test-session-cli-slot-first",
    (entry) => firstStreamed.push(entry)
  );
  const second = createCliTask(
    "wait for cli slot",
    "test-session-cli-slot-second",
    (entry) => secondStreamed.push(entry)
  );
  db.createTask(first);
  db.createTask(second);

  const firstRun = runTask(first);
  await waitForValue(() => firstStreamed.find(
    (entry) => entry.deltaType === "status" && /开始执行/.test(entry.chunk)
  ));

  const secondRun = runTask(second);
  const waiting = await waitForValue(() => secondStreamed.find(
    (entry) => entry.deltaType === "status" && /正在等待 CLI 并发槽位/.test(entry.chunk)
  ));
  assert.match(waiting.chunk, /占用 1\/1/);
  assert.match(waiting.chunk, /排队第 1 位/);
  await waitForValue(() => secondStreamed.filter(
    (entry) => entry.deltaType === "status" && /正在等待 CLI 并发槽位/.test(entry.chunk)
  ).length >= 2);

  await firstRun;
  await secondRun;
  assert.ok(secondStreamed.some(
    (entry) => entry.deltaType === "status" && /已获得 CLI 并发槽位，Codex 开始执行/.test(entry.chunk)
  ));
  assert.equal(db.getTask(first.id).status, "completed");
  assert.equal(db.getTask(second.id).status, "completed");
  assert.deepEqual(getRunningAgents(), []);
});

test("Codex 多条 agent_message 只把最后一条作为最终答复", async () => {
  process.env.FAKE_CODEX_MODE = "messages";
  const streamed = [];
  const task = {
    id: randomUUID(),
    title: "final message regression",
    description: "finish",
    type: "general",
    status: "pending",
    priority: 3,
    source: "test",
    sourceId: "test-session-final",
    explicitEngine: "codex",
    cwd: tmp,
    idleTimeoutMs: 3000,
    maxTimeoutMs: 5000,
    onStream: ({ deltaType, chunk }) => { if (deltaType === "text") streamed.push(chunk); },
  };
  db.createTask(task);

  const result = await runTask(task);
  assert.equal(result.report, "任务状态：已完成\n最终总结");
  assert.match(streamed.join(""), /我先检查现有改动/);
  assert.match(streamed.join(""), /任务状态：已完成/);
  assert.equal(db.getTask(task.id).status, "completed");
});

test("codex-atlas 复用 Codex JSONL 解析，只持久化最后一条 agent_message", async () => {
  process.env.FAKE_CODEX_MODE = "messages";
  const task = {
    id: randomUUID(),
    title: "codex atlas final message regression",
    description: "finish",
    type: "general",
    status: "pending",
    priority: 3,
    source: "test",
    sourceId: "test-session-atlas-final",
    explicitEngine: "codex-atlas",
    cwd: tmp,
    idleTimeoutMs: 3000,
    maxTimeoutMs: 5000,
  };
  db.createTask(task);

  const result = await runTask(task);
  assert.equal(result.report, "任务状态：已完成\n最终总结");
  assert.doesNotMatch(result.report, /item\.completed|agent_message/);
  assert.equal(db.getTask(task.id).status, "completed");
});

test("Codex turn.completed 收敛无自然语言完成标记且进程不退出的故事点任务", async () => {
  process.env.FAKE_CODEX_MODE = "turn-completed-hang";
  const streamed = [];
  const task = {
    id: randomUUID(),
    title: "turn completed terminal event regression",
    description: "finish without a natural-language completion marker",
    type: "general",
    status: "pending",
    priority: 3,
    source: "devbench",
    sourceId: "test-session-turn-completed-terminal",
    explicitEngine: "codex",
    cwd: tmp,
    idleTimeoutMs: 3000,
    maxTimeoutMs: 4000,
    onStream: (event) => streamed.push(event),
  };
  db.createTask(task);

  const result = await runTask(task);
  assert.equal(result.report, "## 简短报告\n结论：未通过\n<!-- VERIFY: FAIL -->");
  assert.equal(result.usage.inputTokens, 31);
  assert.equal(result.usage.outputTokens, 7);
  assert.equal(result.usage.cacheReadTokens, 5);
  assert.equal(db.getTask(task.id).status, "completed");
  assert.deepEqual(getRunningAgents(), []);
  assert.equal(streamed.some((event) => event.deltaType === "usage"), true);
});

test("停止按钮可中止 DeepSeek API Agent", async () => {
  const { getConfig, updateConfig } = await import("../services/config.js");
  updateConfig({
    autoFallback: false,
    apiMaxToolIterations: 0,
    apiEngines: {
      ...(getConfig().apiEngines || {}),
      deepseek: { enabled: true, name: "DeepSeek", baseUrl: "https://deepseek.invalid", apiKey: "test-key", model: "deepseek-v4-pro", thinkingEnabled: false },
    },
  });
  const originalFetch = global.fetch;
  global.fetch = async (_url, options = {}) => new Promise((_resolve, reject) => {
    const fail = () => { const error = new Error("aborted"); error.name = "AbortError"; reject(error); };
    if (options.signal?.aborted) fail();
    else options.signal?.addEventListener("abort", fail, { once: true });
  });
  const task = {
    id: randomUUID(), title: "stop deepseek", description: "wait", type: "general", status: "pending", priority: 3,
    source: "test", sourceId: "test-deepseek-stop", explicitEngine: "deepseek", allowEngineFallback: false, cwd: tmp,
  };
  db.createTask(task);
  try {
    const running = runTask(task);
    const stopped = assert.rejects(running, /用户手动终止/);
    for (let i = 0; i < 50 && !isTaskAgentRunning(task.id); i++) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(isTaskAgentRunning(task.id), true);
    assert.equal(stopTaskAgent(task.id), true);
    await stopped;
    assert.equal(isTaskAgentRunning(task.id), false);
  } finally {
    global.fetch = originalFetch;
  }
});

test("Atlas Provider 首包静默会终止 runTask 并释放运行 Agent", async () => {
  const { getConfig, updateConfig } = await import("../services/config.js");
  const previousApiAgent = getConfig().apiAgent || {};
  updateConfig({
    autoFallback: false,
    apiAgent: {
      ...previousApiAgent,
      providerFirstChunkTimeoutMs: 40,
      providerStreamIdleTimeoutMs: 80,
    },
  });
  const originalFetch = global.fetch;
  let requestSignal = null;
  global.fetch = async (_url, options = {}) => {
    requestSignal = options.signal;
    return {
      ok: true,
      body: new ReadableStream({
        start(controller) {
          options.signal?.addEventListener?.("abort", () => {
            try { controller.error(options.signal.reason || new Error("aborted")); } catch {}
          }, { once: true });
        },
      }),
      text: async () => "",
      json: async () => ({}),
    };
  };
  const task = {
    id: randomUUID(), title: "stalled atlas provider", description: "wait", type: "general", status: "pending", priority: 3,
    source: "test", sourceId: "test-atlas-provider-timeout", explicitEngine: "atlas", allowEngineFallback: false, cwd: tmp,
  };
  db.createTask(task);
  try {
    await assert.rejects(runTask(task), (error) => {
      assert.equal(error?.code, "API_PROVIDER_FIRST_CHUNK_TIMEOUT");
      assert.equal(error?.terminalFailure, true);
      assert.equal(error?.telemetry?.executionSucceeded, false);
      return true;
    });
    assert.equal(requestSignal?.aborted, true);
    assert.equal(isTaskAgentRunning(task.id), false);
    assert.deepEqual(getRunningAgents(), []);
  } finally {
    global.fetch = originalFetch;
    updateConfig({ apiAgent: previousApiAgent });
  }
});

test("MiniMax Provider 瞬时连接重置后 runTask 自动恢复并释放运行 Agent", async () => {
  const { getConfig, updateConfig } = await import("../services/config.js");
  const previousConfig = JSON.parse(JSON.stringify(getConfig()));
  updateConfig({
    autoFallback: false,
    apiMaxToolIterations: 0,
    apiEngines: {
      ...(getConfig().apiEngines || {}),
      minimax: {
        enabled: true,
        name: "MiniMax",
        baseUrl: "https://api.minimaxi.invalid/v1",
        apiKey: "test-key",
        model: "MiniMax-M3",
        thinkingEnabled: false,
      },
    },
  });
  const originalFetch = global.fetch;
  let calls = 0;
  global.fetch = async () => {
    calls++;
    if (calls === 1) {
      const cause = Object.assign(new Error("socket closed before response"), { code: "ECONNRESET" });
      throw Object.assign(new TypeError("fetch failed"), { cause });
    }
    return apiToolCallSseResponse([{
      id: "finish-minimax-retry",
      type: "function",
      function: {
        name: "finish_task",
        arguments: JSON.stringify({
          status: "completed",
          summary: "MiniMax 自动恢复",
          changes: [],
          verification: ["第二次 Provider 请求成功"],
          remaining: [],
        }),
      },
    }]);
  };
  const task = {
    id: randomUUID(), title: "retry minimax transport", description: "continue", type: "general", status: "pending", priority: 3,
    source: "test", sourceId: "test-minimax-transport-retry", explicitEngine: "minimax", allowEngineFallback: false, cwd: tmp,
  };
  db.createTask(task);
  try {
    const result = await runTask(task);
    assert.match(result.report, /MiniMax 自动恢复/);
    assert.equal(calls, 2);
    assert.equal(db.getTask(task.id).status, "completed");
    assert.equal(isTaskAgentRunning(task.id), false);
    assert.deepEqual(getRunningAgents(), []);
  } finally {
    global.fetch = originalFetch;
    updateConfig({
      autoFallback: previousConfig.autoFallback,
      apiMaxToolIterations: previousConfig.apiMaxToolIterations,
      apiEngines: previousConfig.apiEngines,
    });
  }
});

test("通用 API runTask 的生成产物写入系统临时目录而非任务源码", async () => {
  const { getConfig, updateConfig } = await import("../services/config.js");
  updateConfig({
    autoFallback: false,
    apiMaxToolIterations: 5,
    apiEngines: {
      ...(getConfig().apiEngines || {}),
      deepseek: {
        enabled: true,
        name: "DeepSeek",
        baseUrl: "https://deepseek.invalid",
        apiKey: "test-key",
        model: "deepseek-v4-pro",
        thinkingEnabled: false,
      },
    },
  });
  const originalFetch = global.fetch;
  let call = 0;
  global.fetch = async () => {
    call++;
    if (call === 1) {
      return apiToolCallSseResponse([{
          id: "generic-process",
          type: "function",
          function: {
            name: "start_process",
            arguments: JSON.stringify({
              command: "node -e \"console.log('generic-run-task')\"",
              purpose: "验证通用 API 产物目录",
              max_minutes: 1,
            }),
          },
        }]);
    }
    return apiToolCallSseResponse([{
        id: "generic-finish",
        type: "function",
        function: {
          name: "finish_task",
          arguments: JSON.stringify({
            status: "completed",
            summary: "通用 API 产物目录验证完成",
            changes: [],
            verification: ["已启动并记录短进程"],
            remaining: [],
            final_response: "任务状态：已完成\n\n通用 API 产物目录验证完成",
          }),
        },
      }]);
  };
  const task = {
    id: randomUUID(),
    title: "generic api artifact root",
    description: "run generic process",
    type: "general",
    status: "pending",
    priority: 3,
    source: "test",
    sourceId: "generic-api-artifact",
    explicitEngine: "deepseek",
    allowEngineFallback: false,
    cwd: tmp,
  };
  db.createTask(task);
  const artifactRoot = path.join(os.tmpdir(), "aiefficiency", "api-artifacts", task.id);
  try {
    const result = await runTask(task);
    assert.match(result.report, /任务状态：已完成/);
    const snapshot = await waitForValue(() => {
      const directory = path.join(artifactRoot, "api-tool-processes");
      if (!fs.existsSync(directory)) return null;
      const name = fs.readdirSync(directory).find((file) => file.endsWith(".json"));
      if (!name) return null;
      const data = JSON.parse(fs.readFileSync(path.join(directory, name), "utf8"));
      return data.status === "running" ? null : data;
    }, 5000);
    assert.equal(snapshot.status, "completed");
    assert.equal(fs.existsSync(path.join(tmp, "docs", "tempFiles")), false);
  } finally {
    global.fetch = originalFetch;
    fs.rmSync(artifactRoot, { recursive: true, force: true });
  }
});

test("devbench Codex Working process extends idle and stops only at max timeout", async () => {
  process.env.FAKE_CODEX_MODE = "hang";
  const task = {
    id: randomUUID(),
    title: "working idle extension regression",
    description: "hang",
    type: "general",
    status: "pending",
    priority: 3,
    source: "devbench",
    sourceId: "test-session-working",
    explicitEngine: "codex",
    cwd: tmp,
    idleTimeoutMs: 120,
    maxTimeoutMs: 450,
    cliHeartbeat: false,
  };
  db.createTask(task);

  await assert.rejects(
    runTask(task),
    (err) => err?.timeoutKind === "max" && err?.workingIdleExtensions > 0
  );
  const stored = JSON.parse(db.getTask(task.id).result || "{}");
  assert.equal(stored.timeoutKind, "max");
  assert.ok(stored.workingIdleExtensions > 0);
  assert.equal(db.getTask(task.id).status, "failed");
  assert.deepEqual(getRunningAgents(), []);
});

test("Codex tool-router stderr is not classified as CLI auth", () => {
  const toolRouter = [
    "2026-07-11T14:16:30Z ERROR codex_core::tools::router: error=Exit code: 1",
    "Output:",
    "UnauthorizedAccessException: Access to the path is denied",
    "FullName",
  ].join("\n");
  assert.equal(isCliAuthError("codex", toolRouter), false);
  assert.equal(isCliAuthError("codex", `${toolRouter}\n2026-07-11T14:16:31Z ERROR codex_core::auth: not logged in; please log in`), true);
  assert.equal(isCliAuthError("codex", "not logged in; please log in"), true);
  assert.equal(isCliAuthError("claude", "not logged in; please log in"), true);
  assert.equal(isCliAuthError("codex", "UnauthorizedAccessException: Access to the path is denied"), false);
});

test("Codex completed result ignores auth-like tool stderr", async () => {
  process.env.FAKE_CODEX_MODE = "stderr-authlike-tool";
  const task = {
    id: randomUUID(),
    title: "codex stderr auth false positive regression",
    description: "finish with tool stderr",
    type: "general",
    status: "pending",
    priority: 3,
    source: "devbench",
    sourceId: "test-session-stderr-authlike-tool",
    explicitEngine: "codex",
    cwd: tmp,
    idleTimeoutMs: 3000,
    maxTimeoutMs: 5000,
  };
  db.createTask(task);

  const result = await runTask(task);
  assert.match(result.report, /router stderr should not be treated as CLI auth/);
  assert.match(result.stderr, /codex_core::tools::router/);
  assert.equal(db.getTask(task.id).status, "completed");
});

test("CARB-13546：refresh_token_reused 在无正文时只重试一次并恢复原消息", async (t) => {
  const marker = path.join(tmp, `refresh-reused-${randomUUID()}.marker`);
  process.env.FAKE_CODEX_MODE = "refresh-reused-once";
  process.env.FAKE_CODEX_REFRESH_MARKER = marker;
  t.after(() => {
    delete process.env.FAKE_CODEX_REFRESH_MARKER;
    fs.rmSync(marker, { force: true });
  });
  const statuses = [];
  const task = {
    id: randomUUID(),
    title: "CARB-13546 refresh recovery",
    description: "keep this message exactly once",
    type: "general",
    status: "pending",
    priority: 3,
    source: "devbench",
    sourceId: "carb-13546-refresh-recovery",
    explicitEngine: "codex",
    cwd: tmp,
    codexAuthRetryDelayMs: 10,
    onStream: ({ deltaType, chunk }) => {
      if (deltaType === "status") statuses.push(chunk);
    },
  };
  db.createTask(task);

  const result = await runTask(task);
  assert.match(result.output, /credential reload recovered/);
  assert.ok(statuses.some((message) => /自动重试（1\/1）/.test(message)));
  assert.equal(db.getTask(task.id).status, "completed");
});

test("CARB-13546：凭据仍失效时停止重放并给出重新登录指令", async () => {
  process.env.FAKE_CODEX_MODE = "refresh-reused-always";
  const task = {
    id: randomUUID(),
    title: "CARB-13546 login required",
    description: "do not replay indefinitely",
    type: "general",
    status: "pending",
    priority: 3,
    source: "devbench",
    sourceId: "carb-13546-login-required",
    explicitEngine: "codex",
    cwd: tmp,
    codexAuthRetryDelayMs: 10,
  };
  db.createTask(task);

  await assert.rejects(runTask(task), (error) => {
    assert.equal(error.code, "CODEX_LOGIN_REQUIRED");
    assert.equal(error.authRequired, true);
    assert.match(error.message, /codex logout/);
    assert.match(error.message, /codex login/);
    return true;
  });
  assert.equal(db.getTask(task.id).status, "failed");
});

test("CARB-13546：刷新令牌错误检测不允许重放已有正文", () => {
  const message = "401 Unauthorized: refresh_token_reused";
  assert.equal(isCodexRefreshTokenReusedError(message), true);
  assert.equal(shouldRetryCodexRefreshTokenError(new Error(message)), true);
  assert.equal(shouldRetryCodexRefreshTokenError(Object.assign(new Error(message), {
    partialOutput: "already streamed answer",
  })), false);
  assert.equal(shouldRetryCodexRefreshTokenError(Object.assign(new Error(message), {
    codexPromptMayHaveStarted: true,
  })), false);
});

test("Codex command output streams as tool_output for long-running progress", async () => {
  process.env.FAKE_CODEX_MODE = "tool-output";
  const streamed = [];
  const task = {
    id: randomUUID(),
    title: "codex command output stream regression",
    description: "finish with command output",
    type: "general",
    status: "pending",
    priority: 3,
    source: "devbench",
    sourceId: "test-session-tool-output",
    explicitEngine: "codex",
    cwd: tmp,
    idleTimeoutMs: 3000,
    maxTimeoutMs: 5000,
    onStream: ({ deltaType, chunk }) => streamed.push({ deltaType, chunk }),
  };
  db.createTask(task);

  const result = await runTask(task);
  assert.match(result.report, /command output streamed/);
  assert.ok(streamed.some((x) => x.deltaType === "tool_output" && /pass \[41\/150\]/.test(x.chunk)));
  assert.equal(streamed.filter((x) => x.deltaType === "tool_use").length, 1);
  assert.equal(db.getTask(task.id).status, "completed");
});

test("故事点 CLI prompt 仅暂存在故事点 tempRoot/prompts 并在停止后清理", async () => {
  process.env.FAKE_CODEX_MODE = "hang";
  const storyTempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agent-story-temp-"));
  const promptDir = path.join(storyTempRoot, "prompts");
  const task = {
    id: randomUUID(),
    title: "story prompt temp root",
    description: "unique story prompt marker",
    type: "general",
    status: "pending",
    priority: 3,
    source: "devbench",
    sourceId: "story-prompt-temp",
    explicitEngine: "codex",
    allowEngineFallback: false,
    storyScoped: true,
    tempRoot: storyTempRoot,
    cwd: tmp,
    idleTimeoutMs: 5000,
    maxTimeoutMs: 10000,
  };
  db.createTask(task);

  const running = runTask(task);
  const stopped = assert.rejects(running, /用户手动终止/);
  const promptFile = await waitForValue(() => {
    if (!fs.existsSync(promptDir)) return null;
    const file = fs.readdirSync(promptDir).find((name) => /^prompt-agent-codex-[\w-]+\.txt$/.test(name));
    return file ? path.join(promptDir, file) : null;
  });
  assert.match(fs.readFileSync(promptFile, "utf8"), /unique story prompt marker/);
  assert.equal(stopTaskAgent(task.id), true);
  await stopped;
  assert.deepEqual(fs.readdirSync(promptDir), []);
  fs.rmSync(storyTempRoot, { recursive: true, force: true });
});

test("故事点 CLI prompt 目录为 junction 时失败关闭且不写入源码", async (t) => {
  const storyTempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agent-story-link-"));
  const sourceTarget = path.join(tmp, `prompt-link-target-${randomUUID()}`);
  fs.mkdirSync(sourceTarget);
  const promptDir = path.join(storyTempRoot, "prompts");
  try {
    fs.symlinkSync(sourceTarget, promptDir, process.platform === "win32" ? "junction" : "dir");
  } catch (error) {
    fs.rmSync(storyTempRoot, { recursive: true, force: true });
    fs.rmSync(sourceTarget, { recursive: true, force: true });
    t.skip(`当前环境无法创建目录链接：${error.message}`);
    return;
  }
  const task = {
    id: randomUUID(),
    title: "story prompt junction",
    description: "must not follow prompt junction",
    type: "general",
    status: "pending",
    priority: 3,
    source: "devbench",
    sourceId: "story-prompt-junction",
    explicitEngine: "codex",
    allowEngineFallback: false,
    storyScoped: true,
    tempRoot: storyTempRoot,
    cwd: tmp,
  };
  db.createTask(task);

  await assert.rejects(runTask(task), /临时目录不是普通目录/);
  assert.deepEqual(fs.readdirSync(sourceTarget), []);
  assert.equal(isTaskAgentRunning(task.id), false);
  fs.unlinkSync(promptDir);
  fs.rmSync(storyTempRoot, { recursive: true, force: true });
  fs.rmSync(sourceTarget, { recursive: true, force: true });
});

test("故事点 CLI 缺少 tempRoot 时失败关闭且不启动进程", async () => {
  process.env.FAKE_CODEX_MODE = "messages";
  const task = {
    id: randomUUID(),
    title: "missing story temp root",
    description: "must not run",
    type: "general",
    status: "pending",
    priority: 3,
    source: "devbench",
    sourceId: "missing-story-temp-root",
    explicitEngine: "codex",
    allowEngineFallback: false,
    storyScoped: true,
    cwd: tmp,
  };
  db.createTask(task);

  await assert.rejects(
    runTask(task),
    (error) => error?.code === "STORY_TEMP_ROOT_REQUIRED"
  );
  assert.equal(isTaskAgentRunning(task.id), false);
});

test("通用 CLI 与任务拆分 prompt 使用系统临时目录、随机文件名并在停止后清理", async () => {
  process.env.FAKE_CODEX_MODE = "hang";
  const genericPromptDir = path.join(os.tmpdir(), "aiefficiency", "agent-prompts");
  const decomposerPromptDir = path.join(os.tmpdir(), "aiefficiency", "decomposer-prompts");
  const task = {
    id: randomUUID(),
    title: "generic prompt temp root",
    description: "generic prompt marker",
    type: "general",
    status: "pending",
    priority: 3,
    source: "test",
    sourceId: "generic-prompt-temp",
    explicitEngine: "codex",
    allowEngineFallback: false,
    cwd: tmp,
    idleTimeoutMs: 5000,
    maxTimeoutMs: 10000,
  };
  db.createTask(task);

  const running = runTask(task);
  const stopped = assert.rejects(running, /用户手动终止/);
  const agentId = await waitForValue(() => getRunningAgents().find((id) => id.startsWith("agent-codex-")));
  const genericPrompt = await waitForValue(() => {
    if (!fs.existsSync(genericPromptDir)) return null;
    const file = fs.readdirSync(genericPromptDir).find((name) => name.startsWith(`prompt-${agentId}-`));
    return file ? path.join(genericPromptDir, file) : null;
  });
  assert.match(path.basename(genericPrompt), new RegExp(`^prompt-${agentId}-[0-9a-f-]{36}\\.txt$`));
  assert.equal(stopTaskAgent(task.id), true);
  await stopped;
  assert.equal(fs.existsSync(genericPrompt), false);

  const purpose = `prompt-path-${randomUUID().slice(0, 8)}`;
  const parentTaskId = randomUUID();
  process.env.FAKE_CODEX_MODE = "delayed-message";
  const { runLLM } = await import("../services/task-decomposer.js");
  const decomposing = runLLM("codex", "decomposer prompt marker", purpose, null, parentTaskId);
  const decomposerPrompt = await waitForValue(() => {
    if (!fs.existsSync(decomposerPromptDir)) return null;
    const file = fs.readdirSync(decomposerPromptDir).find((name) => name.startsWith(`prompt-${purpose}-`));
    return file ? path.join(decomposerPromptDir, file) : null;
  });
  assert.match(path.basename(decomposerPrompt), new RegExp(`^prompt-${purpose}-[0-9a-f-]{36}\\.txt$`));
  assert.match(await decomposing, /delayed prompt inspection complete/);
  assert.equal(fs.existsSync(decomposerPrompt), false);
});

test("业务无推进时按警告、取消、进程树退出验证三级收敛", async () => {
  process.env.FAKE_CODEX_MODE = "zero-output-hang";
  const states = [];
  const task = {
    id: randomUUID(),
    title: "meaningful progress convergence",
    description: "heartbeat must not keep a stuck task alive",
    type: "general",
    status: "pending",
    priority: 3,
    source: "test",
    sourceId: `progress-${randomUUID()}`,
    explicitEngine: "codex",
    allowEngineFallback: false,
    cwd: tmp,
    firstOutputTimeoutMs: 5000,
    idleTimeoutMs: 5000,
    maxTimeoutMs: 10000,
    progressPolicy: {
      meaningfulProgressWarningMs: 40,
      meaningfulProgressCancelMs: 120,
      terminationVerifyMs: 2000,
    },
    onProgressState: (state) => states.push(state.state),
  };
  db.createTask(task);

  await assert.rejects(runTask(task), (error) => {
    assert.equal(error.code, "AI_NO_MEANINGFUL_PROGRESS");
    assert.equal(error.resumable, true);
    assert.equal(error.storyLifetimeExpired, false);
    assert.equal(error.terminationVerified, true);
    return true;
  });
  assert.ok(states.includes("warning"));
  assert.ok(states.includes("cancelling"));
  assert.equal(states.at(-1), "terminated");
  assert.equal(isTaskAgentRunning(task.id), false);
});

test("API Agent 单片段总时限有限且取消后验证运行边界退出", async () => {
  const originalFetch = global.fetch;
  const states = [];
  global.fetch = async (_url, options = {}) => new Promise((_resolve, reject) => {
    const rejectAbort = () => reject(options.signal?.reason || new Error("aborted"));
    if (options.signal?.aborted) rejectAbort();
    else options.signal?.addEventListener?.("abort", rejectAbort, { once: true });
  });
  const task = {
    id: randomUUID(),
    title: "api active turn convergence",
    description: "active API slice must be finite",
    type: "general",
    status: "pending",
    priority: 3,
    source: "test",
    sourceId: `api-progress-${randomUUID()}`,
    explicitEngine: "atlas",
    allowEngineFallback: false,
    cwd: tmp,
    progressPolicy: {
      meaningfulProgressWarningMs: 10_000,
      meaningfulProgressCancelMs: 20_000,
      apiActiveTurnMaxMs: 150,
      terminationVerifyMs: 1000,
    },
    onProgressState: (state) => states.push({ ...state }),
  };
  db.createTask(task);
  try {
    await assert.rejects(runTask(task), (error) => {
      assert.equal(error.code, "API_AGENT_ACTIVE_TURN_TIMEOUT");
      assert.equal(error.timeoutKind, "active_turn");
      assert.equal(error.resumable, true);
      assert.equal(error.terminationVerified, true);
      return true;
    });
  } finally {
    global.fetch = originalFetch;
  }
  assert.ok(states.some((state) => state.code === "API_AGENT_ACTIVE_TURN_WARNING"));
  assert.ok(states.some((state) => state.state === "cancelling"));
  assert.equal(states.at(-1).state, "terminated");
  assert.equal(isTaskAgentRunning(task.id), false);
});

async function waitForValue(read, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = read();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail("等待 prompt 临时文件或运行进程超时");
}
