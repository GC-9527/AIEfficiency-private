import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "devbench-conversation-backup-"));
process.env.GATEWAY_DB_PATH = path.join(tmp, "data.db");
process.env.GATEWAY_CONFIG_PATH = path.join(tmp, "gateway.json");
process.env.DEVBENCH_CONFIG_PATH = path.join(tmp, "market.json");
process.env.DEVBENCH_LOCAL_PROJECTS_PATH = path.join(tmp, "local-projects.json");
process.env.AIEFFICIENCY_CLONE_PARENT = path.join(tmp, "clone-parent");
process.env.DEVBENCH_STORE_DIR = path.join(tmp, "store");
fs.writeFileSync(process.env.GATEWAY_CONFIG_PATH, JSON.stringify({ servers: { nodeId: "conversation-backup-test" } }));

const express = (await import("express")).default;
const store = await import("../services/devbench/store.js");
const runtimeDb = await import("../db/sqlite.js");
const { exportFullArchive } = await import("../services/devbench/index.js");
const { parseConversationBackup } = await import("../services/devbench/conversation-backup.js");
const devbenchRouter = (await import("../routes/devbench.js")).default;

function createProjectTab(title) {
  const repo = fs.mkdtempSync(path.join(tmp, "repo-"));
  const projectId = `project-${Date.now()}-${Math.random()}`;
  assert.equal(store.upsertProject({ id: projectId, name: title, path: repo }).ok, true);
  const tab = store.createTab({ title });
  return store.updateTab(tab.id, { primaryProjectId: projectId });
}

function fullMessages() {
  return [
    { role: "user", content: "请保留完整记录", turn: 1, ts: 1000, futureMetadata: { user: true } },
    {
      role: "assistant",
      content: "已保留完整记录",
      turn: 1,
      ts: 2000,
      engine: "codex",
      taskId: "task-backup",
      workflowKind: "verify",
      transcript: [{ type: "tool_use", content: "rg", input: "backup", result: "matched" }],
      usage: { inputTokens: 10, outputTokens: 20 },
      aiSnapshot: { engine: "codex", model: "gpt-5", tier: "high", capturedAt: 1500, future: "kept" },
      actualAi: { engine: "codex", provider: "openai", model: "gpt-5", appliedAt: 1600, future: "kept" },
      futureMetadata: { assistant: true },
    },
  ];
}

function checksumBody(body) {
  return createHash("sha256").update(JSON.stringify(body), "utf8").digest("hex");
}

async function startTestServer() {
  const app = express();
  app.use(express.json());
  app.use("/api/devbench", devbenchRouter);
  return new Promise((resolve) => {
    const instance = app.listen(0, "127.0.0.1", () => resolve(instance));
  });
}

test("独立 JSON 备份无损保留完整消息元数据且不改变 TXT 全量存档格式", () => {
  const source = createProjectTab("独立备份源故事点");
  for (const message of fullMessages()) store.appendMessage(source.id, message);

  const textArchive = exportFullArchive(store.getTab(source.id));
  assert.equal(textArchive.ok, true, textArchive.error);
  assert.match(textArchive.file, /\.txt$/i);
  assert.doesNotMatch(fs.readFileSync(textArchive.file, "utf8"), /"schema"\s*:|DEVBENCH_ARCHIVE_METADATA/);

  const backup = store.createConversationBackup(source.id);
  assert.equal(backup.ok, true, backup.error);
  assert.match(backup.file, /\.devbench-chat\.json$/i);
  const storage = store.getStoryStoragePaths(store.getTab(source.id), { create: true });
  assert.equal(path.dirname(textArchive.file), storage.archiveDirectory);
  assert.equal(path.dirname(backup.file), storage.backupDirectory);
  assert.equal(storage.archiveDirectory, storage.backupDirectory, "TXT 全量存档和默认 JSON 备份应同落 ask 目录");
  assert.equal(textArchive.file.startsWith(path.join(process.env.AIEFFICIENCY_CLONE_PARENT, "AllDocs", "StoryDev")), true);
  const parsed = parseConversationBackup(fs.readFileSync(backup.file, "utf8"));
  assert.equal(parsed.ok, true, parsed.error);
  assert.deepEqual(parsed.data.messages, fullMessages());
});

test("还原完整对话前自动保护目标记录，源备份保持不变", () => {
  const source = createProjectTab("还原来源");
  for (const message of fullMessages()) store.appendMessage(source.id, message);
  const backup = store.createConversationBackup(source.id);
  assert.equal(backup.ok, true, backup.error);
  const sourceBefore = fs.readFileSync(backup.file, "utf8");

  const target = createProjectTab("还原目标");
  store.appendMessage(target.id, { role: "user", content: "目标原记录", turn: 1, ts: 3000 });
  const restored = store.restoreConversationBackupToTab(target.id, backup.file);
  assert.equal(restored.ok, true, restored.error);
  assert.equal(fs.existsSync(restored.recoveryBackupFile), true);
  assert.deepEqual(store.getMessages(target.id), fullMessages());
  assert.equal(fs.readFileSync(backup.file, "utf8"), sourceBefore);
  assert.equal(store.getTab(target.id).cliSessionId, null);

  const recovery = parseConversationBackup(fs.readFileSync(restored.recoveryBackupFile, "utf8"));
  assert.equal(recovery.ok, true, recovery.error);
  assert.equal(recovery.data.kind, "pre_restore");
  assert.equal(recovery.data.messages[0].content, "目标原记录");
});

test("损坏校验和的 JSON 备份拒绝还原且不替换当前消息", () => {
  const tab = createProjectTab("损坏备份保护");
  store.appendMessage(tab.id, { role: "user", content: "不可丢失", turn: 1, ts: 1000 });
  const backup = store.createConversationBackup(tab.id);
  const tampered = fs.readFileSync(backup.file, "utf8").replace("不可丢失", "已被篡改");
  fs.writeFileSync(backup.file, tampered, "utf8");

  const restored = store.restoreConversationBackupToTab(tab.id, backup.file);
  assert.equal(restored.ok, false);
  assert.match(restored.error, /校验失败/);
  assert.equal(store.getMessages(tab.id)[0].content, "不可丢失");
});

test("还原前保护备份无法写入时中止还原并保留当前对话", () => {
  const source = createProjectTab("保护失败来源");
  store.appendMessage(source.id, { role: "user", content: "来源消息", turn: 1, ts: 1000 });
  const backup = store.createConversationBackup(source.id);
  assert.equal(backup.ok, true, backup.error);

  const target = createProjectTab("保护失败目标");
  store.appendMessage(target.id, { role: "user", content: "必须保留的目标消息", turn: 1, ts: 2000 });
  const restored = store.restoreConversationBackupToTab(target.id, backup.file, { recoveryDirectory: "relative-not-allowed" });
  assert.equal(restored.ok, false);
  assert.match(restored.error, /当前对话未被替换/);
  assert.equal(store.getMessages(target.id)[0].content, "必须保留的目标消息");
});

test("HTTP 还原仅阻断真实活跃租约，并收敛陈旧任务、Agent 与 runningTaskId", async () => {
  const tab = createProjectTab("HTTP 备份闭环");
  store.appendMessage(tab.id, { role: "user", content: "HTTP 原问题", turn: 1, ts: 1000 });
  store.appendMessage(tab.id, { role: "assistant", content: "HTTP 原回答", turn: 1, ts: 2000, engine: "codex" });
  const server = await startTestServer();
  const address = server.address();
  const base = `http://127.0.0.1:${address.port}/api/devbench/tabs/${tab.id}`;
  try {
    const createdResponse = await fetch(`${base}/conversation-backup`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    const created = await createdResponse.json();
    assert.equal(createdResponse.status, 200);
    assert.equal(created.ok, true, created.error);

    const listedResponse = await fetch(`${base}/conversation-backup-files?dir=${encodeURIComponent(created.data.directory)}`);
    const listed = await listedResponse.json();
    assert.equal(listed.ok, true, listed.error);
    assert.equal(listed.data.backups.some((item) => item.path === created.data.file && item.restorable), true);

    const runtimeTaskId = `task-running-${Date.now()}`;
    const runtimeAgentId = `agent-running-${Date.now()}`;
    runtimeDb.createTask({
      id: runtimeTaskId,
      title: "真实运行任务",
      description: "对话还原门禁测试",
      type: "general",
      status: "running",
      priority: 3,
      source: "devbench",
      sourceId: tab.sessionId,
    });
    runtimeDb.upsertAgent({
      id: runtimeAgentId,
      name: "真实运行 Agent",
      engine: "codex",
      status: "running",
      currentTaskId: runtimeTaskId,
    });
    runtimeDb.upsertTaskRuntimeLease({
      leaseId: `conversation-backup-${runtimeTaskId}`,
      taskId: runtimeTaskId,
      ownerInstance: "conversation-backup-foreign-gateway",
      ownerPid: process.pid,
      ttlMs: 60_000,
    });
    store.updateTab(tab.id, { runningTaskId: runtimeTaskId });
    const blockedResponse = await fetch(`${base}/conversation-backup-restore`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ filePath: created.data.file }),
    });
    const blocked = await blockedResponse.json();
    assert.equal(blockedResponse.status, 409);
    assert.equal(blocked.code, "AI_RUNNING");

    runtimeDb.removeTaskRuntimeLease(
      `conversation-backup-${runtimeTaskId}`,
      "conversation-backup-foreign-gateway",
    );
    store.replaceMessages(tab.id, [{ role: "user", content: "待替换", turn: 1, ts: 3000 }]);
    const restoredResponse = await fetch(`${base}/conversation-backup-restore`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ filePath: created.data.file, recoveryDirectory: created.data.directory }),
    });
    const restored = await restoredResponse.json();
    assert.equal(restoredResponse.status, 200);
    assert.equal(restored.ok, true, restored.error);
    assert.deepEqual(store.getMessages(tab.id).map((message) => message.content), ["HTTP 原问题", "HTTP 原回答"]);
    assert.equal(store.getTab(tab.id).runningTaskId, null);
    assert.equal(runtimeDb.getTask(runtimeTaskId).status, "failed");
    assert.equal(JSON.parse(runtimeDb.getTask(runtimeTaskId).result).code, "STALE_RUNTIME_LEASE");
    const settledAgent = runtimeDb.getAgents().find((agent) => agent.id === runtimeAgentId);
    assert.equal(settledAgent.status, "idle");
    assert.equal(settledAgent.current_task_id, null);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
