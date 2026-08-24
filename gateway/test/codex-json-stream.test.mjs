import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeCodexJsonEvent } from "../services/codex-json-stream.js";

test("Codex JSONL: output/message delta maps to realtime text chunks", () => {
  assert.deepEqual(
    normalizeCodexJsonEvent({ type: "agent_message_delta", delta: "正在读取文件..." }).text,
    ["正在读取文件..."]
  );
  assert.deepEqual(
    normalizeCodexJsonEvent({ type: "response.output_text.delta", delta: "修好了" }).text,
    ["修好了"]
  );
});

test("Codex JSONL: final assistant item maps to final text", () => {
  const ev = {
    type: "item.completed",
    item: { type: "agent_message", text: "最终回复" },
  };
  assert.equal(normalizeCodexJsonEvent(ev).finalText, "最终回复");
});

test("Codex JSONL: reasoning summary maps to thinking stream", () => {
  const ev = {
    type: "item.completed",
    item: { type: "reasoning", summary: [{ type: "summary_text", text: "先检查路由，再看前端订阅。" }] },
  };
  assert.deepEqual(normalizeCodexJsonEvent(ev).thinking, ["先检查路由，再看前端订阅。"]);
});

test("Codex JSONL: command/tool item maps to tool_use stream", () => {
  const ev = {
    type: "item.started",
    item: { type: "command_execution", command: "rg -n codex gateway" },
  };
  assert.deepEqual(normalizeCodexJsonEvent(ev).tools, ["rg -n codex gateway"]);
});

test("Codex JSONL: command output maps to tool output stream", () => {
  const ev = {
    type: "item.completed",
    item: {
      type: "command_execution",
      command: "python tools/run_all.py",
      output: "-> pass [41/150] TC-A1001009-open-from-21600 page_source=21600\n-> missing, retry 1/1",
    },
  };
  const n = normalizeCodexJsonEvent(ev);
  assert.deepEqual(n.tools, ["python tools/run_all.py"]);
  assert.deepEqual(n.toolOutputs, [
    "-> pass [41/150] TC-A1001009-open-from-21600 page_source=21600\n-> missing, retry 1/1",
  ]);
  assert.equal(n.finalText, "");
});

test("Codex JSONL: usage and session id are preserved when present", () => {
  const ev = {
    type: "turn.completed",
    session_id: "sess_123",
    usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 2 },
  };
  const n = normalizeCodexJsonEvent(ev);
  assert.equal(n.sessionId, "sess_123");
  assert.deepEqual(n.usage, {
    inputTokens: 10,
    outputTokens: 5,
    cacheReadTokens: 2,
    cacheCreationTokens: 0,
    costUsd: null,
  });
  assert.equal(n.turnCompleted, true);
});

test("Codex JSONL: thread.started id is preserved as session id", () => {
  const n = normalizeCodexJsonEvent({ type: "thread.started", thread_id: "thread_123" });
  assert.equal(n.sessionId, "thread_123");
});
