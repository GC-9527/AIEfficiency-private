import test from "node:test";
import assert from "node:assert/strict";
import {
  conversationMessageStableId,
  conversationRevision,
  messageStableId,
  userRevisionNavigation,
} from "./conversationGraphModel.mjs";

test("messageStableId prefers persisted identifiers and keeps a legacy fallback", () => {
  assert.equal(messageStableId({ id: "m-1" }, 4), "m-1");
  assert.match(messageStableId({ role: "user", ts: 123 }, 4), /^legacy:user:/);
});

test("conversationMessageStableId restores generated graph ids omitted by the legacy message projection", () => {
  const conversation = {
    activePathIds: ["user-uuid", "assistant-uuid"],
    nodes: [
      { id: "user-uuid", role: "user", content: "请继续修复" },
      { id: "assistant-uuid", role: "assistant", content: "执行失败" },
    ],
  };

  assert.equal(
    conversationMessageStableId(conversation, { role: "user", content: "请继续修复", turn: 3 }, 0),
    "user-uuid",
  );
  assert.equal(
    conversationMessageStableId(conversation, { id: "local-message", role: "user", content: "本地失败" }, 0),
    "local-message",
  );
  assert.equal(
    conversationMessageStableId(conversation, { id: "legacy:explicit-id", role: "user", content: "请继续修复" }, 0),
    "legacy:explicit-id",
  );
  assert.match(
    conversationMessageStableId(conversation, { role: "assistant", content: "请继续修复", turn: 3 }, 0),
    /^legacy:assistant:/,
  );
});

test("user revisions are ordered siblings under the same parent", () => {
  const conversation = {
    revision: 7,
    nodes: [
      { id: "a-0", role: "assistant", createdAt: 1 },
      { id: "u-1", role: "user", parentId: "a-0", createdAt: 2 },
      { id: "u-2", role: "user", parentId: "a-0", revisionOfId: "u-1", createdAt: 3 },
      { id: "a-2", role: "assistant", parentId: "u-2", createdAt: 4 },
    ],
  };
  assert.equal(conversationRevision(conversation), 7);
  assert.deepEqual(userRevisionNavigation(conversation, conversation.nodes[2]), { currentId: "u-2", index: 2, total: 2, previousId: "u-1", nextId: null, variants: ["u-1", "u-2"] });
});

test("object-shaped nodes and explicit revision groups are supported", () => {
  const conversation = { nodes: {
    old: { role: "user", revisionGroupId: "prompt-1", revisionIndex: 0 },
    current: { role: "user", revisionGroupId: "prompt-1", revisionIndex: 1 },
    unrelated: { role: "user", revisionGroupId: "prompt-2", revisionIndex: 0 },
  } };
  const navigation = userRevisionNavigation(conversation, { id: "old", role: "user" });
  assert.equal(navigation.total, 2);
  assert.equal(navigation.nextId, "current");
});
