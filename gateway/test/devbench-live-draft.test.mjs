import { test, before } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "devbench-live-"));
process.env.GATEWAY_DB_PATH = path.join(tmp, "data.db");
process.env.GATEWAY_CONFIG_PATH = path.join(tmp, "gateway.json");
process.env.DEVBENCH_CONFIG_PATH = path.join(tmp, "market.json");
process.env.DEVBENCH_STORE_DIR = path.join(tmp, "store");
process.env.AIEFFICIENCY_CLONE_PARENT = path.join(tmp, "clone-parent");
fs.writeFileSync(process.env.GATEWAY_CONFIG_PATH, JSON.stringify({ servers: { nodeId: "test" } }));

let store;
before(async () => {
  store = await import("../services/devbench/store.js");
});

test("运行中对话草稿可持久化并恢复", () => {
  const saved = store.saveLiveDraft("tab-codex", {
    taskId: "task-1",
    sessionId: "dev_tab-codex",
    engine: "codex",
    aiSnapshot: { engine: "codex", model: "gpt-5.6-sol", tier: "max", capturedAt: 123456 },
    thinking: "正在分析",
    text: "部分回答",
    tools: ["rg -n MediaType ."],
    streaming: true,
  });

  assert.ok(saved.updatedAt > 0);
  assert.deepEqual(store.getLiveDraft("tab-codex"), saved);
});

test("任务结束后清理草稿", () => {
  store.saveLiveDraft("tab-codex", { taskId: "task-1", text: "partial" });
  store.clearLiveDraft("tab-codex");
  assert.equal(store.getLiveDraft("tab-codex"), null);
});

test("停止任务时草稿正文先保留并标记为已停止", () => {
  store.saveLiveDraft("tab-stop", {
    taskId: "task-stop",
    text: "停止前已经显示的有效回答",
    streaming: true,
    startedAt: 1000,
  });

  const stopped = store.markLiveDraftStopped("tab-stop", 1600);
  assert.equal(stopped.text, "停止前已经显示的有效回答");
  assert.equal(stopped.streaming, false);
  assert.equal(stopped.stopped, true);
  assert.equal(stopped.endedAt, 1600);
  assert.equal(stopped.durationMs, 600);
  assert.deepEqual(store.getLiveDraft("tab-stop"), stopped);
});
