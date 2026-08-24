import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CodexAppServerClient,
  writeJsonLine,
} from "../services/codex-app-server.js";
import {
  codexAppServerHelpSupportsRealtime,
  codexAppServerSpawnSpec,
} from "../services/agent-runner.js";
import {
  buildCodexAppServerSpawnEnv,
  buildCodexOfficialSpawnEnv,
} from "../services/codex-minimax.js";

async function waitFor(predicate, timeoutMs = 1_500) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail("等待 Codex 凭据同步超时");
}

function fakeProcess(onClientMessage) {
  const proc = new EventEmitter();
  proc.stdin = new PassThrough();
  proc.stdout = new PassThrough();
  proc.stderr = new PassThrough();
  let buffer = "";
  proc.stdin.on("data", (chunk) => {
    buffer += String(chunk || "");
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() || "";
    for (const line of lines) {
      if (line.trim()) onClientMessage(JSON.parse(line), proc);
    }
  });
  return proc;
}

function send(proc, message) {
  proc.stdout.write(`${JSON.stringify(message)}\n`);
}

function sendSplitInsideUtf8Character(proc, message, marker = "中") {
  const bytes = Buffer.from(`${JSON.stringify(message)}\n`, "utf8");
  const markerBytes = Buffer.from(marker, "utf8");
  const markerIndex = bytes.indexOf(markerBytes);
  assert.ok(markerIndex >= 0, `测试消息中缺少拆分标记 ${marker}`);
  proc.stdout.write(bytes.subarray(0, markerIndex + 1));
  proc.stdout.write(bytes.subarray(markerIndex + 1));
}

test("Codex app-server：初始化、启动回合和 turn/steer 使用同一个活动 turn", async () => {
  const seen = [];
  const proc = fakeProcess((message, child) => {
    seen.push(message);
    if (message.method === "initialize") send(child, { id: message.id, result: { userAgent: "test", codexHome: "/tmp/codex", platformFamily: "unix", platformOs: "linux" } });
    else if (message.method === "thread/start") send(child, { id: message.id, result: { thread: { id: "thread-1" } } });
    else if (message.method === "turn/start") {
      send(child, { id: message.id, result: { turn: { id: "turn-1" } } });
    }
    else if (message.method === "turn/steer") send(child, { id: message.id, result: { turnId: "turn-1" } });
  });
  const client = new CodexAppServerClient(proc, { requestTimeoutMs: 1_000 });

  await client.initialize();
  await client.startThread({
    cwd: "/repo",
    model: "gpt-test",
    modelProvider: "openai",
    effort: "high",
    workspaceRoots: ["/repo", "/shared", "/shared"],
  });
  await client.startTurn("first", { clientUserMessageId: "msg-1" });
  // turn/start 的响应早于 turn/started 通知时，服务端仍会拒绝 steer。
  // 必须等待真实活动态，不能把“拿到 turn id”误当成“可以追加”。
  await assert.rejects(
    client.steer("too-early", { clientUserMessageId: "msg-early" }),
    /没有可追加的活动 turn/,
  );
  send(proc, { method: "turn/started", params: { threadId: "thread-1", turn: { id: "turn-1" } } });
  await new Promise((resolve) => setImmediate(resolve));
  await client.steer("follow-up", { clientUserMessageId: "msg-2" });

  const initialized = seen.find((message) => message.method === "initialized");
  assert.deepEqual(initialized, { method: "initialized" });
  const threadStart = seen.find((message) => message.method === "thread/start");
  assert.equal(threadStart.params.sandbox, "danger-full-access");
  assert.equal(threadStart.params.approvalPolicy, "never");
  assert.equal(threadStart.params.modelProvider, "openai");
  assert.deepEqual(threadStart.params.runtimeWorkspaceRoots, ["/repo", "/shared"]);
  const turnStart = seen.find((message) => message.method === "turn/start");
  assert.equal(turnStart.params.effort, "high");
  const steer = seen.find((message) => message.method === "turn/steer");
  assert.equal(steer.params.threadId, "thread-1");
  assert.equal(steer.params.expectedTurnId, "turn-1");
  assert.equal(steer.params.input[0].text, "follow-up");
  assert.equal(steer.params.clientUserMessageId, "msg-2");
});

test("JSONL 写入返回 false 只是背压，回调成功时不得重复排队", async () => {
  const stream = new EventEmitter();
  stream.destroyed = false;
  stream.writableEnded = false;
  stream.writable = true;
  let written = "";
  stream.write = (chunk, encoding, callback) => {
    written += String(chunk);
    queueMicrotask(() => callback());
    return false;
  };

  assert.equal(await writeJsonLine(stream, { method: "turn/steer", id: 7 }), true);
  assert.equal(JSON.parse(written).method, "turn/steer");
});

test("未知 app-server 主动请求会显式拒绝，不让回合无限等待", async () => {
  const replies = [];
  const proc = fakeProcess((message) => replies.push(message));
  const client = new CodexAppServerClient(proc, { requestTimeoutMs: 1_000 });
  send(proc, { method: "some/new/request", id: 99, params: {} });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(replies[0].id, 99);
  assert.equal(replies[0].error.code, -32601);
  client.removeAllListeners();
});

test("Codex app-server 跨 chunk 解码 UTF-8 中文命令输出且不产生替换字符", async () => {
  const proc = fakeProcess(() => {});
  const client = new CodexAppServerClient(proc, { requestTimeoutMs: 1_000 });
  const notifications = [];
  client.on("notification", (method, params) => notifications.push({ method, params }));

  sendSplitInsideUtf8Character(proc, {
    method: "item/commandExecution/outputDelta",
    params: { delta: "中文命令输出：检查通过" },
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(notifications, [{
    method: "item/commandExecution/outputDelta",
    params: { delta: "中文命令输出：检查通过" },
  }]);
  assert.doesNotMatch(notifications[0].params.delta, /\uFFFD/);
  client.removeAllListeners();
});

test("Codex 跨电脑预检：只有 CLI 暴露 app-server stdio/listen 才启用实时通道", () => {
  assert.equal(codexAppServerHelpSupportsRealtime("Usage: codex app-server [OPTIONS]\n  --listen <URL>"), true);
  assert.equal(codexAppServerHelpSupportsRealtime("Usage: codex exec [OPTIONS]"), false);
  assert.equal(codexAppServerHelpSupportsRealtime("codex app-server is unavailable"), false);
});

test("Codex app-server 跨平台启动：Windows 兼容 npm .cmd，Unix 不经过 shell", () => {
  assert.deepEqual(codexAppServerSpawnSpec("win32"), {
    command: "cmd.exe",
    args: ["/d", "/s", "/c", "codex app-server --stdio"],
    shell: false,
    detached: false,
  });
  assert.deepEqual(codexAppServerSpawnSpec("linux"), {
    command: "codex", args: ["app-server", "--stdio"], shell: false, detached: true,
  });
  assert.deepEqual(codexAppServerSpawnSpec("darwin"), {
    command: "codex", args: ["app-server", "--stdio"], shell: false, detached: true,
  });
});

test("CARB-13546：Codex app-server 独立运行目录会回写旋转凭据且旧副本不能覆盖新凭据", async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "codex-appserver-profile-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const defaultDir = path.join(home, ".codex");
  fs.mkdirSync(defaultDir, { recursive: true });
  fs.writeFileSync(path.join(defaultDir, "config.toml"), 'model = "gpt-test"\n', "utf8");
  fs.writeFileSync(path.join(defaultDir, "auth.json"), '{"refresh_token":"token-a"}', "utf8");

  const first = buildCodexAppServerSpawnEnv({}, { engine: "codex", home, credentialSyncIntervalMs: 25 });
  const second = buildCodexAppServerSpawnEnv({}, { engine: "codex", home, credentialSyncIntervalMs: 25 });
  assert.notEqual(first.configDir, second.configDir);
  assert.notEqual(first.configDir, first.sourceConfigDir);
  assert.equal(buildCodexOfficialSpawnEnv({}, { home }).configDir, defaultDir);
  assert.equal(first.modelProvider, "");
  assert.equal(
    fs.readFileSync(path.join(first.configDir, "config.toml"), "utf8").includes(
      "[mcp_servers.appmarket_admin_backend]",
    ),
    true,
  );
  assert.match(
    fs.readFileSync(path.join(first.configDir, "config.toml"), "utf8"),
    /model = "gpt-test"/,
  );
  assert.equal(
    fs.readFileSync(path.join(first.configDir, "config.toml"), "utf8").includes("APPMARKET_ADMIN_PASSWORD="),
    false,
  );
  assert.equal(fs.existsSync(path.join(first.configDir, "auth.json")), true);

  fs.writeFileSync(path.join(first.configDir, "auth.json"), '{"refresh_token":"token-b"}', "utf8");
  await waitFor(() => fs.readFileSync(path.join(defaultDir, "auth.json"), "utf8").includes("token-b"));
  first.cleanup();
  // second still contains token-a. Its cleanup must not overwrite token-b.
  second.cleanup();
  assert.match(fs.readFileSync(path.join(defaultDir, "auth.json"), "utf8"), /token-b/);

  const third = buildCodexAppServerSpawnEnv({}, { engine: "codex", home });
  assert.match(fs.readFileSync(path.join(third.configDir, "auth.json"), "utf8"), /token-b/);
  third.cleanup();
  assert.equal(fs.existsSync(first.configDir), false);
  assert.equal(fs.existsSync(second.configDir), false);
  assert.equal(fs.existsSync(third.configDir), false);
});
