/**
 * 回归测试：devbench 对话持久化 transcript 截断 + 读缓存（REG-SERVICE-CONTROL-033）
 *
 * 背景：MiniMax-M3 等长思考模型单轮 transcript 可达数 MB（实测 16341 条/7.5MB），
 * msg/conversation 文件随对话膨胀到几十 MB（实测 27MB+28MB）。旧实现每次消息变更都
 * 同步全量读+写两个大文件，冻结 gateway 事件循环，导致 Service Control /api/health
 * 2.5s 超时（HTTP 500 / “HTTP health check is temporarily unavailable for gateway;
 * owned processes are still running.”）。
 *
 * 本测试覆盖：
 * 1. 超长 transcript 按“保头 + 保尾 + 省略标记”压缩并标记截断；
 * 2. 小 transcript 不截断，单条超长 content 被裁剪；
 * 3. 模拟 MiniMax 长对话大文件：追加消息后文件体积被压缩到受控范围，耗时受控；
 * 4. 追加后立即读取返回一致数据（写盘同步完成）；
 * 5. live draft 同步落盘 + 清理后读取为空。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "devbench-store-large-"));
process.env.DEVBENCH_STORE_DIR = path.join(tmp, "store");
process.env.GATEWAY_DB_PATH = path.join(tmp, "data.db");
process.env.GATEWAY_CONFIG_PATH = path.join(tmp, "gateway.json");
process.env.DEVBENCH_CONFIG_PATH = path.join(tmp, "market.json");
process.env.DEVBENCH_LOCAL_PROJECTS_PATH = path.join(tmp, "local-projects.json");
fs.writeFileSync(process.env.GATEWAY_CONFIG_PATH, JSON.stringify({ servers: { nodeId: "large-transcript-test" } }));

const store = await import("../services/devbench/store.js");

const STORE_DIR = process.env.DEVBENCH_STORE_DIR;
const conversationFileFor = (tabId) => path.join(STORE_DIR, `msg-${tabId}.json.conversation-v2.json`);
const liveFileFor = (tabId) => path.join(STORE_DIR, `live-${tabId}.json`);

test("读取旧版超大 transcript 时只压缩内存投影且不改写原始会话文件", () => {
  const tab = store.createTab({ title: "旧版大 transcript 读取保护" });
  const transcript = Array.from({ length: 1_000 }, (_, index) => ({
    type: "thinking",
    content: `legacy-${index}-${"x".repeat(2_000)}`,
    ts: index,
  }));
  const conversation = {
    schemaVersion: 2,
    revision: 1,
    headId: "legacy-assistant",
    nextSequence: 2,
    nodes: [{
      id: "legacy-assistant",
      parentId: null,
      role: "assistant",
      content: "最终回答",
      sequence: 1,
      ts: 1,
      transcript,
    }],
  };
  const file = conversationFileFor(tab.id);
  fs.writeFileSync(file, JSON.stringify(conversation), "utf8");
  const before = fs.readFileSync(file);

  const message = store.getMessages(tab.id)[0];
  assert.equal(message.transcriptTruncated, true);
  assert.equal(message.transcriptTotal, 1_000);
  assert.equal(message.transcript.length, 401);
  assert.ok(JSON.stringify(message).length < before.length * 0.4);
  assert.deepEqual(fs.readFileSync(file), before, "GET/read 路径不能改写用户历史");
});

test("超长 transcript 按保头保尾压缩并标记截断", () => {
  const tab = store.createTab({ title: "大 transcript 截断" });
  const big = Array.from({ length: 1000 }, (_, i) => ({
    type: "text",
    content: `第 ${i} 条思考内容${"长文本".repeat(20)}`,
    ts: 1000 + i,
  }));
  store.appendMessage(tab.id, { role: "assistant", content: "回答", transcript: big });
  const messages = store.getMessages(tab.id);
  const node = messages[messages.length - 1];
  assert.equal(node.transcriptTruncated, true, "超长 transcript 应标记截断");
  assert.equal(node.transcriptTotal, 1000);
  // 压缩后 = 头 60 + 省略标记 1 + 尾 340
  assert.equal(node.transcript.length, 60 + 1 + 340);
  assert.match(String(node.transcript[0].content), /^第 0 条/);
  assert.equal(node.transcript[60].type, "note");
  assert.match(String(node.transcript[60].content), /已省略 600 条/);
  assert.match(String(node.transcript[node.transcript.length - 1].content), /^第 999 条/);
});

test("小 transcript 不截断，单条超长 content 被裁剪", () => {
  const tab = store.createTab({ title: "小 transcript" });
  const small = [{ type: "text", content: "x".repeat(5000), ts: 1 }];
  store.appendMessage(tab.id, { role: "assistant", content: "回答", transcript: small });
  const messages = store.getMessages(tab.id);
  const node = messages[messages.length - 1];
  assert.equal(node.transcriptTruncated, undefined, "条数不超限时不标记截断");
  assert.equal(node.transcript.length, 1);
  assert.ok(String(node.transcript[0].content).startsWith("x".repeat(1000)));
  assert.ok(String(node.transcript[0].content).length < 1100, "单条 content 应被裁剪到上限附近");
});

test("模拟 MiniMax 长对话大文件：追加消息后文件体积受控且耗时受控", () => {
  const tab = store.createTab({ title: "大文件体积控制" });
  // 构造约 8MB+ 的已有对话文件：每节点 2000 条超长 transcript（模拟 MiniMax 思考流，
  // 超过保头+保尾 400 条上限触发截断）+ 长回答正文
  const nodes = [];
  for (let i = 0; i < 12; i += 1) {
    nodes.push({
      id: `big-${i}`,
      role: i % 2 ? "user" : "assistant",
      content: `长回答 ${i} ${"正文".repeat(5000)}`,
      sequence: i + 1,
      ts: 1000 + i,
      parentId: i === 0 ? null : `big-${i - 1}`,
      transcript: Array.from({ length: 2000 }, (_, j) => ({
        type: "text",
        content: `思考 ${j} ${"思考文本".repeat(40)}`,
        ts: j,
      })),
    });
  }
  const conv = { schemaVersion: 2, revision: 12, headId: "big-11", nextSequence: 13, nodes, internal: {} };
  const convFile = conversationFileFor(tab.id);
  fs.writeFileSync(convFile, JSON.stringify(conv));
  const originalSize = fs.statSync(convFile).size;
  assert.ok(originalSize > 8 * 1024 * 1024, `构造文件应大于 8MB，实际 ${originalSize}`);

  // 追加一条新消息：触发完整读+compact+写盘，必须同步完成且文件被压缩到受控范围
  const started = process.hrtime.bigint();
  store.appendMessage(tab.id, { role: "user", content: "大文件下的新消息", turn: 13 });
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
  assert.ok(elapsedMs < 2000, `大文件下 appendMessage 不应阻塞超过 2s（实际 ${elapsedMs.toFixed(1)}ms）`);

  const messages = store.getMessages(tab.id);
  assert.equal(messages[messages.length - 1].content, "大文件下的新消息");

  const compactedSize = fs.statSync(convFile).size;
  assert.ok(
    compactedSize < 4 * 1024 * 1024,
    `append 后 conversation 文件应被压缩到 <4MB（原 ${(originalSize / 1024 / 1024).toFixed(1)}MB → 现 ${(compactedSize / 1024 / 1024).toFixed(2)}MB）`,
  );
  assert.ok(
    compactedSize < originalSize * 0.5,
    `压缩率应超过 50%（原 ${originalSize}B → 现 ${compactedSize}B）`,
  );
  // 落盘内容应包含新消息
  const raw = JSON.parse(fs.readFileSync(convFile, "utf8"));
  assert.equal(raw.nodes[raw.nodes.length - 1].content, "大文件下的新消息");
});

test("截断边界：恰好 401 条标记截断，400 条不标记", () => {
  const tab401 = store.createTab({ title: "401 边界" });
  const big401 = Array.from({ length: 401 }, (_, i) => ({ type: "text", content: `第 ${i} 条`, ts: i }));
  store.appendMessage(tab401.id, { role: "assistant", content: "回答", transcript: big401 });
  const m401 = store.getMessages(tab401.id);
  const n401 = m401[m401.length - 1];
  // 401 条 = 头 60 + 省略标记 1 + 尾 340，中间 1 条被省略 → 应标记截断
  assert.equal(n401.transcriptTruncated, true, "401 条应标记截断");
  assert.equal(n401.transcriptTotal, 401);
  assert.equal(n401.transcript.length, 401);
  assert.equal(n401.transcript[60].type, "note");

  const tab400 = store.createTab({ title: "400 边界" });
  const big400 = Array.from({ length: 400 }, (_, i) => ({ type: "text", content: `第 ${i} 条`, ts: i }));
  store.appendMessage(tab400.id, { role: "assistant", content: "回答", transcript: big400 });
  const m400 = store.getMessages(tab400.id);
  const n400 = m400[m400.length - 1];
  // 400 条 = 头 60 + 尾 340，恰好覆盖，无省略 → 不标记
  assert.equal(n400.transcriptTruncated, undefined, "400 条不应标记截断");
  assert.equal(n400.transcript.length, 400);
});

test("追加后立即读取返回一致数据（同步写盘完成）", () => {
  const tab = store.createTab({ title: "读写一致性" });
  store.appendMessage(tab.id, { role: "user", content: "问题一", turn: 1 });
  store.appendMessage(tab.id, { role: "assistant", content: "回答一", turn: 1 });
  const messages = store.getMessages(tab.id);
  assert.deepEqual(messages.map((m) => m.content), ["问题一", "回答一"]);
  // 同步写盘后文件应已存在且内容一致
  const convFile = conversationFileFor(tab.id);
  assert.equal(fs.existsSync(convFile), true);
  const raw = JSON.parse(fs.readFileSync(convFile, "utf8"));
  assert.equal(raw.nodes[raw.nodes.length - 1].content, "回答一");
});

test("live draft 同步落盘 + 清理后读取为空", () => {
  const tab = store.createTab({ title: "live draft 落盘" });
  store.saveLiveDraft(tab.id, { taskId: "t1", thinking: "思考内容", text: "回答内容", tools: ["a", "b"], streaming: true });
  const draft = store.getLiveDraft(tab.id);
  assert.equal(draft.thinking, "思考内容");
  assert.equal(draft.streaming, true);
  assert.deepEqual(draft.tools, ["a", "b"]);
  const liveFile = liveFileFor(tab.id);
  assert.equal(fs.existsSync(liveFile), true, "saveLiveDraft 后 live draft 文件应存在");
  const onDisk = JSON.parse(fs.readFileSync(liveFile, "utf8"));
  assert.equal(onDisk.text, "回答内容");
  store.clearLiveDraft(tab.id);
  assert.equal(store.getLiveDraft(tab.id), null, "clear 后读取应为空");
});
