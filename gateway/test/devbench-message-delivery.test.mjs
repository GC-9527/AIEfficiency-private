import { test } from "node:test";
import assert from "node:assert/strict";
import {
  persistedQueuedTabIds,
  storyEngineDeliveryCapability,
} from "../services/devbench/message-delivery.js";

test("故事点消息能力按接入协议区分，而不是按模型或服务商名称猜测", () => {
  assert.deepEqual(storyEngineDeliveryCapability("claude"), {
    engine: "claude", realtimeAppend: true, protocol: "claude-stream-json",
  });
  assert.equal(storyEngineDeliveryCapability("claude-volcengine").realtimeAppend, true);
  assert.equal(storyEngineDeliveryCapability("claude-minimax").realtimeAppend, true);
  assert.equal(storyEngineDeliveryCapability("claude-atlas").realtimeAppend, true);
  assert.equal(storyEngineDeliveryCapability("codex").protocol, "codex-app-server-turn-steer");
  assert.equal(storyEngineDeliveryCapability("codex-minimax").realtimeAppend, true);
  assert.equal(storyEngineDeliveryCapability("codex-atlas").realtimeAppend, true);
  assert.equal(storyEngineDeliveryCapability("volcengine").realtimeAppend, false);
  assert.equal(storyEngineDeliveryCapability("minimax").protocol, "persistent-fifo-queue");
  assert.equal(storyEngineDeliveryCapability("hermes").protocol, "persistent-fifo-queue");
  assert.equal(storyEngineDeliveryCapability("hermes-atlas").protocol, "persistent-fifo-queue");
  assert.equal(storyEngineDeliveryCapability("custom-openai-api").realtimeAppend, false);
});

test("Gateway 恢复只重新调度真正有持久队列的故事点", () => {
  assert.deepEqual(persistedQueuedTabIds([
    { id: "empty", queue: [] },
    { id: "legacy" },
    { id: "one", queue: ["follow-up"] },
    { id: "two", queue: ["a", "b"] },
    { queue: ["missing-id"] },
  ]), ["one", "two"]);
});
