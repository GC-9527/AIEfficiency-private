import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "devbench-archive-live-"));
process.env.GATEWAY_DB_PATH = path.join(tmp, "data.db");
process.env.GATEWAY_CONFIG_PATH = path.join(tmp, "gateway.json");
process.env.DEVBENCH_CONFIG_PATH = path.join(tmp, "market.json");
process.env.DEVBENCH_STORE_DIR = path.join(tmp, "store");
process.env.AIEFFICIENCY_CLONE_PARENT = path.join(tmp, "clone-parent");
fs.writeFileSync(process.env.GATEWAY_CONFIG_PATH, JSON.stringify({ servers: { nodeId: "archive-live-test" } }));

const store = await import("../services/devbench/store.js");
const { exportFullArchive, __testMergeArchiveMessages } = await import("../services/devbench/index.js");

function createArchiveTab(title) {
  const repo = fs.mkdtempSync(path.join(tmp, "repo-"));
  const projectId = `archive-${Date.now()}-${Math.random()}`;
  assert.equal(store.upsertProject({ id: projectId, name: title, path: repo }).ok, true);
  const created = store.createTab({ title });
  return store.updateTab(created.id, { primaryProjectId: projectId });
}

test("全量存档会包含服务端持久化的回答中快照", () => {
  const tab = createArchiveTab("回答中存档");
  store.appendMessage(tab.id, { role: "user", content: "请继续分析", turn: 1 });
  store.saveLiveDraft(tab.id, {
    sessionId: tab.sessionId,
    engine: "codex",
    text: "这是尚未完成但已经显示的回答",
    tools: ["rg -n archive ."],
    streaming: true,
    startedAt: Date.now() - 1000,
  });

  const result = exportFullArchive(store.getTab(tab.id));
  assert.equal(result.ok, true);
  assert.equal(result.liveIncluded, true);
  assert.equal(result.count, 2);
  const archive = fs.readFileSync(result.file, "utf-8");
  assert.match(archive, /【AI:codex】（回答中备份）/);
  assert.match(archive, /这是尚未完成但已经显示的回答/);
  assert.match(archive, /\[工具\] rg -n archive \./);
});

test("页面点击瞬间的流式内容优先于稍旧的服务端草稿", () => {
  const tab = createArchiveTab("页面快照优先");
  store.appendMessage(tab.id, { role: "user", content: "生成长回答", turn: 1 });
  store.saveLiveDraft(tab.id, { engine: "codex", text: "服务端稍旧片段", streaming: true });

  const result = exportFullArchive(store.getTab(tab.id), {
    engine: "codex",
    text: "页面当前已经显示到这里",
    streaming: true,
    updatedAt: Date.now(),
  });
  const archive = fs.readFileSync(result.file, "utf-8");
  assert.equal(result.liveIncluded, true);
  assert.match(archive, /页面当前已经显示到这里/);
  assert.doesNotMatch(archive, /服务端稍旧片段/);
});

test("最终回答已落盘时不会重复存入流式前缀", () => {
  const merged = __testMergeArchiveMessages([
    { role: "user", content: "问题", turn: 1 },
    { role: "assistant", content: "部分回答，随后已经完整结束", turn: 1 },
  ], { text: "部分回答", streaming: true });

  assert.equal(merged.liveIncluded, false);
  assert.equal(merged.messages.length, 2);
});

test("停止回调落盘前导出全量存档也会保留停止状态", () => {
  const merged = __testMergeArchiveMessages([
    { role: "user", content: "问题", turn: 1 },
  ], {
    text: "停止前已经显示的回答",
    streaming: false,
    stopped: true,
  });

  assert.equal(merged.liveIncluded, true);
  assert.equal(merged.messages[1].content, "停止前已经显示的回答");
  assert.equal(merged.messages[1].stopped, true);
  assert.equal(merged.messages[1].partial, false);
});

test("从存档恢复停止前回答时保留 stopped 状态而不是标成执行失败", () => {
  const messages = store.parseArchiveMessages(`
========== 第 1 轮 [2026-07-20 03:00:00] ==========
【我】
请分析停止行为

【AI:codex】
## 已停止生成（停止前回答已保留）
这是停止前已经显示的有效回答
`);

  const assistant = messages.find((message) => message.role === "assistant");
  assert.ok(assistant);
  assert.equal(assistant.stopped, true);
  assert.equal(assistant.error, false);
  assert.equal(assistant.content, "这是停止前已经显示的有效回答");

  const tab = createArchiveTab("停止回答恢复");
  store.replaceMessages(tab.id, messages);
  const persisted = store.getMessages(tab.id).find((message) => message.role === "assistant");
  assert.equal(persisted.content, "这是停止前已经显示的有效回答");
  assert.equal(persisted.stopped, true);
  assert.equal(persisted.error, false);
});

test("全量存档会记录停止状态且恢复后不丢失已保留回答", () => {
  const source = createArchiveTab("停止回答全量存档");
  store.appendMessage(source.id, { role: "user", content: "请生成回答", turn: 1 });
  store.appendMessage(source.id, {
    role: "assistant",
    content: "这是停止前已经显示的有效回答",
    turn: 1,
    engine: "codex",
    stopped: true,
    error: false,
  });

  const exported = exportFullArchive(store.getTab(source.id));
  assert.equal(exported.ok, true);
  const archive = fs.readFileSync(exported.file, "utf-8");
  assert.match(archive, /## 已停止生成（停止前回答已保留）/);

  const target = createArchiveTab("停止回答全量恢复");
  const restored = store.restoreArchiveToTab(target.id, exported.file);
  assert.equal(restored.ok, true);
  const assistant = store.getMessages(target.id).find((message) => message.role === "assistant");
  assert.equal(assistant.content, "这是停止前已经显示的有效回答");
  assert.equal(assistant.stopped, true);
  assert.equal(assistant.error, false);
});
