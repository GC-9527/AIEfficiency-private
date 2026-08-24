import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "devbench-stop-answer-"));
process.env.GATEWAY_DB_PATH = path.join(tmp, "data.db");
process.env.GATEWAY_CONFIG_PATH = path.join(tmp, "gateway.json");
process.env.DEVBENCH_CONFIG_PATH = path.join(tmp, "market.json");
process.env.DEVBENCH_STORE_DIR = path.join(tmp, "store");
process.env.AIEFFICIENCY_CLONE_PARENT = path.join(tmp, "clone-parent");
process.env.NODE_ENV = "test";
fs.writeFileSync(process.env.GATEWAY_CONFIG_PATH, JSON.stringify({
  codexEnabled: true,
  autoFallback: false,
  maxCliConcurrency: 1,
  workDir: tmp,
  servers: { nodeId: "stop-answer-test" },
}));

const fake = path.join(tmp, "fake-codex.mjs");
fs.writeFileSync(fake, `
process.stdout.write(JSON.stringify({ type: "thread.started", thread_id: "stop-answer-session" }) + "\\n");
process.stdout.write(JSON.stringify({
  type: "item.completed",
  item: { type: "agent_message", text: "这是停止前已经显示的有效回答" },
}) + "\\n");
setInterval(() => {}, 1000);
`);

if (process.platform === "win32") {
  fs.writeFileSync(path.join(tmp, "codex.cmd"), `@echo off\r\nnode "${fake}" %*\r\n`);
} else {
  const bin = path.join(tmp, "codex");
  fs.writeFileSync(bin, `#!/bin/sh\nexec node "${fake}" "$@"\n`);
  fs.chmodSync(bin, 0o755);
}
process.env.PATH = `${tmp}${path.delimiter}${process.env.PATH || ""}`;

const store = await import("../services/devbench/store.js");
const { sendTurn } = await import("../services/devbench/index.js");
const {
  isTaskAgentRunning,
  registerVirtualProcess,
  stopTaskAgent,
  unregisterProcess,
} = await import("../services/agent-runner.js");
const express = (await import("express")).default;
const devbenchRouter = (await import("../routes/devbench.js")).default;

async function startTestServer() {
  const app = express();
  app.use(express.json());
  app.use("/api/devbench", devbenchRouter);
  return new Promise((resolve) => {
    const server = app.listen(0, "127.0.0.1", () => resolve(server));
  });
}

async function waitFor(predicate, message, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(message);
}

test("故事点停止真实运行中的 Agent 后把已显示回答晋升为历史消息", async () => {
  const baseRepo = fs.mkdtempSync(path.join(tmp, "base-repo-"));
  const repo = fs.mkdtempSync(path.join(tmp, "repo-"));
  const projectId = "stop-answer-project";
  assert.equal(store.upsertProject({ id: projectId, name: "停止回答工程", path: baseRepo }).ok, true);
  const created = store.createTab({ title: "停止回答故事点" });
  const tab = store.updateTab(created.id, {
    primaryProjectId: projectId,
    worktree: {
      version: 1,
      managed: true,
      root: repo,
      entries: [{
        role: "primary",
        baseProjectId: projectId,
        name: "停止回答工程",
        basePath: baseRepo,
        path: repo,
        worktreePath: repo,
      }],
    },
    engine: "codex",
    cliSessionId: null,
    cliSessionIds: {},
  });

  const started = sendTurn(tab, "请生成一段较长回答");
  assert.ok(started.taskId, started.error || "故事点任务未启动");
  const { taskId } = started;
  try {
    await waitFor(() => isTaskAgentRunning(taskId), "Agent 未进入运行态");
    await waitFor(
      () => store.getLiveDraft(tab.id)?.text?.includes("停止前已经显示"),
      "流式回答未写入故事点草稿",
    );
    assert.equal(stopTaskAgent(taskId), true);

    const stoppedMessage = await waitFor(
      () => store.getMessages(tab.id).find((message) => message.role === "assistant" && message.stopped),
      "停止后的回答未晋升为历史消息",
    );
    assert.equal(stoppedMessage.content, "这是停止前已经显示的有效回答");
    assert.equal(stoppedMessage.error, false);
    assert.equal(stoppedMessage.stopped, true);
    assert.doesNotMatch(stoppedMessage.content, /执行失败|用户手动终止/);
    assert.equal(store.getLiveDraft(tab.id), null);
    assert.equal(store.getTab(tab.id).runningTaskId, null);
    assert.equal(store.getTab(tab.id).turns, 1);
  } finally {
    if (isTaskAgentRunning(taskId)) stopTaskAgent(taskId);
  }
});

test("runningTaskId 提前丢失时停止路由仍按 live draft 的 taskId 中止 Agent", async () => {
  const baseRepo = fs.mkdtempSync(path.join(tmp, "base-live-fallback-"));
  const repo = fs.mkdtempSync(path.join(tmp, "repo-live-fallback-"));
  const projectId = "stop-live-fallback-project";
  assert.equal(store.upsertProject({ id: projectId, name: "停止任务标识回退工程", path: baseRepo }).ok, true);
  const created = store.createTab({ title: "停止任务标识回退故事点" });
  const tab = store.updateTab(created.id, {
    primaryProjectId: projectId,
    worktree: {
      version: 1,
      managed: true,
      root: repo,
      entries: [{
        role: "primary",
        baseProjectId: projectId,
        name: "停止任务标识回退工程",
        basePath: baseRepo,
        path: repo,
        worktreePath: repo,
      }],
    },
    engine: "codex",
    cliSessionId: null,
    cliSessionIds: {},
  });

  const started = sendTurn(tab, "请生成一段较长回答");
  assert.ok(started.taskId, started.error || "故事点任务未启动");
  const { taskId } = started;
  let server = null;
  try {
    await waitFor(() => isTaskAgentRunning(taskId), "Agent 未进入运行态");
    await waitFor(() => {
      const draft = store.getLiveDraft(tab.id);
      return draft?.taskId === taskId && draft.text?.includes("停止前已经显示");
    }, "流式草稿未记录 taskId 和已显示回答");

    // 复现 CARB-14113：页签持久字段已经被并发收尾清空，但实时草稿和本地 Agent 仍属于本轮。
    store.updateTab(tab.id, { runningTaskId: null });
    assert.equal(isTaskAgentRunning(taskId), true);

    server = await startTestServer();
    const address = server.address();
    const baseUrl = `http://127.0.0.1:${address.port}/api/devbench/tabs/${tab.id}`;
    const activeSnapshot = await (await fetch(`${baseUrl}/conversation`)).json();
    assert.equal(activeSnapshot.data?.runtime?.active, true);
    assert.equal(activeSnapshot.data?.runtime?.taskId, taskId);

    const response = await fetch(`${baseUrl}/stop`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    const body = await response.json();
    assert.equal(response.status, 200, body.error || JSON.stringify(body));
    assert.equal(body.ok, true, body.error || JSON.stringify(body));
    assert.equal(body.data?.stopped, true, "停止路由必须命中 live draft 所属的本地 Agent");

    const stoppedMessage = await waitFor(
      () => store.getMessages(tab.id).find((message) => message.role === "assistant" && message.stopped),
      "停止后的回答未晋升为历史消息",
    );
    assert.equal(stoppedMessage.content, "这是停止前已经显示的有效回答");
    assert.equal(isTaskAgentRunning(taskId), false);
    assert.equal(store.getTab(tab.id).runningTaskId, null);
    const stoppedSnapshot = await (await fetch(`${baseUrl}/conversation`)).json();
    assert.equal(stoppedSnapshot.data?.runtime?.active, false);
  } finally {
    if (isTaskAgentRunning(taskId)) stopTaskAgent(taskId);
    if (server) await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("持久与可见草稿 taskId 冲突且均在本机运行时只停止可见草稿任务", async () => {
  const persistedTaskId = "persisted-local-task";
  const liveTaskId = "visible-live-task";
  const persistedProcessKey = "virtual-persisted-local-task";
  const liveProcessKey = "virtual-visible-live-task";
  const stoppedTaskIds = [];
  const created = store.createTab({ title: "双本机任务归属冲突故事点" });
  store.updateTab(created.id, { runningTaskId: persistedTaskId });
  store.saveLiveDraft(created.id, {
    taskId: liveTaskId,
    sessionId: created.sessionId,
    text: "用户当前看到的草稿",
    streaming: true,
    startedAt: Date.now() - 1000,
  });
  registerVirtualProcess(persistedProcessKey, {
    taskId: persistedTaskId,
    abort: () => {
      stoppedTaskIds.push(persistedTaskId);
      unregisterProcess(persistedProcessKey);
      return true;
    },
  });
  registerVirtualProcess(liveProcessKey, {
    taskId: liveTaskId,
    abort: () => {
      stoppedTaskIds.push(liveTaskId);
      unregisterProcess(liveProcessKey);
      return true;
    },
  });

  let server = null;
  try {
    assert.equal(isTaskAgentRunning(persistedTaskId), true);
    assert.equal(isTaskAgentRunning(liveTaskId), true);
    server = await startTestServer();
    const address = server.address();
    const response = await fetch(`http://127.0.0.1:${address.port}/api/devbench/tabs/${created.id}/stop`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    const body = await response.json();

    assert.equal(response.status, 200, body.error || JSON.stringify(body));
    assert.equal(body.data?.taskId, liveTaskId, "停止必须归属于用户当前可见的 live draft");
    assert.deepEqual(body.data?.remainingTaskIds, [persistedTaskId]);
    assert.deepEqual(stoppedTaskIds, [liveTaskId]);
    assert.equal(isTaskAgentRunning(liveTaskId), false);
    assert.equal(isTaskAgentRunning(persistedTaskId), true, "不得误停另一个本机任务");
    assert.equal(store.getTab(created.id).runningTaskId, persistedTaskId, "不得误清另一个任务的持久归属");
    assert.equal(store.getLiveDraft(created.id)?.taskId, liveTaskId);
    assert.equal(store.getLiveDraft(created.id)?.stopped, true, "只标停当前可见草稿");
  } finally {
    unregisterProcess(liveProcessKey);
    unregisterProcess(persistedProcessKey);
    if (server) await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
