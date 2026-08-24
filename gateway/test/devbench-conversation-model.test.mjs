import test from "node:test";
import assert from "node:assert/strict";

import {
  activeConversationPath,
  appendConversationNode,
  createUserRevision,
  normalizeConversation,
  selectConversationNode,
} from "../services/devbench/conversation/model.js";

test("legacy linear messages receive stable ids and keep metadata", () => {
  const legacy = [
    {
      role: "user",
      content: "first",
      turn: 1,
      ts: 10,
      custom: { kept: true },
      input: {
        text: "first",
        attachments: [{ name: "问题截图.png", relPath: "storydev:/archives/chat-attachments/batch/问题截图.png", size: 11 }],
      },
    },
    { role: "assistant", content: "answer", turn: 1, ts: 20, stopped: true, error: false },
  ];
  const first = normalizeConversation(legacy, { tabId: "tab-stable" });
  const second = normalizeConversation(legacy, { tabId: "tab-stable" });

  assert.deepEqual(first.nodes.map((node) => node.id), second.nodes.map((node) => node.id));
  assert.equal(first.nodes[0].custom.kept, true);
  assert.deepEqual(first.nodes[0].input.attachments, legacy[0].input.attachments);
  assert.equal(first.nodes[1].parentId, first.nodes[0].id);
  assert.equal(first.headId, first.nodes[1].id);
  assert.deepEqual(activeConversationPath(first).map((node) => node.content), ["first", "answer"]);
});

test("editing a user message creates a sibling and preserves the original answer", () => {
  const legacy = normalizeConversation([
    { role: "user", content: "original", ts: 10 },
    { role: "assistant", content: "old answer", ts: 20 },
  ], { tabId: "tab-edit" });
  const sourceUser = legacy.nodes[0];
  const oldAnswer = legacy.nodes[1];
  const edited = createUserRevision(legacy, {
    messageId: sourceUser.id,
    content: "edited",
    id: "edited-user",
    expectedRevision: 0,
    metadata: { displayContent: "edited", input: { text: "edited" } },
  });
  const completed = appendConversationNode(edited.conversation, {
    id: "new-answer",
    role: "assistant",
    content: "new answer",
  }, { parentId: edited.node.id });

  assert.equal(edited.node.parentId, sourceUser.parentId);
  assert.equal(edited.node.revisionRootId, sourceUser.id);
  assert.equal(edited.node.revisionOfId, sourceUser.id);
  assert.ok(completed.conversation.nodes.some((node) => node.id === oldAnswer.id));
  assert.deepEqual(activeConversationPath(completed.conversation).map((node) => node.content), ["edited", "new answer"]);
});

test("selecting a branch node resolves that branch latest leaf", () => {
  const base = normalizeConversation([
    { id: "u1", role: "user", content: "original", parentId: null, sequence: 1 },
    { id: "a1", role: "assistant", content: "old answer", parentId: "u1", sequence: 2 },
    { id: "u2", role: "user", content: "follow up", parentId: "a1", sequence: 3 },
    { id: "a2", role: "assistant", content: "follow answer", parentId: "u2", sequence: 4 },
    { id: "u1-edit", role: "user", content: "edited", parentId: null, revisionRootId: "u1", sequence: 5 },
    { id: "a-edit", role: "assistant", content: "edited answer", parentId: "u1-edit", sequence: 6 },
  ]);
  const selected = selectConversationNode(base, "u1", { expectedRevision: 0 });

  assert.equal(selected.head.id, "a2");
  assert.deepEqual(activeConversationPath(selected.conversation).map((node) => node.id), ["u1", "a1", "u2", "a2"]);
});

test("revision compare-and-set rejects stale mutations", () => {
  const graph = { ...normalizeConversation([]), revision: 4 };
  assert.throws(
    () => appendConversationNode(graph, { role: "user", content: "stale" }, { expectedRevision: 3 }),
    (error) => error.code === "CONVERSATION_REVISION_CONFLICT" && error.statusCode === 409,
  );
});
