import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "devbench-conversation-backup-v2-"));
process.env.GATEWAY_DB_PATH = path.join(tmp, "data.db");
process.env.GATEWAY_CONFIG_PATH = path.join(tmp, "gateway.json");
process.env.DEVBENCH_CONFIG_PATH = path.join(tmp, "market.json");
process.env.DEVBENCH_LOCAL_PROJECTS_PATH = path.join(tmp, "local-projects.json");
process.env.AIEFFICIENCY_CLONE_PARENT = path.join(tmp, "clone-parent");
process.env.DEVBENCH_STORE_DIR = path.join(tmp, "store");
fs.writeFileSync(process.env.GATEWAY_CONFIG_PATH, JSON.stringify({ servers: { nodeId: "conversation-backup-v2-test" } }));

const store = await import("../services/devbench/store.js");
const { parseConversationBackup } = await import("../services/devbench/conversation-backup.js");

function createProjectTab(title) {
  const repo = fs.mkdtempSync(path.join(tmp, "repo-"));
  const projectId = `project-${Date.now()}-${Math.random()}`;
  assert.equal(store.upsertProject({ id: projectId, name: title, path: repo }).ok, true);
  const tab = store.createTab({ title });
  return store.updateTab(tab.id, { primaryProjectId: projectId });
}

function sha256(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

test("v2 backup round-trips hidden branches, active head, checksum, and recovery backup", () => {
  const source = createProjectTab("v2-hidden-branch-source");
  store.appendMessage(source.id, { role: "user", content: "original", turn: 1, ts: 1000 });
  store.appendMessage(source.id, { role: "assistant", content: "old answer", turn: 1, ts: 2000 });
  const initial = store.getConversation(source.id);
  const originalUser = initial.nodes.find((node) => node.role === "user");
  const originalAnswer = initial.nodes.find((node) => node.role === "assistant");
  const edited = store.createConversationUserRevision(source.id, {
    messageId: originalUser.id,
    content: "edited",
    expectedRevision: initial.revision,
    metadata: { role: "user", content: "edited", displayContent: "edited", input: { text: "edited" } },
  });
  store.appendConversationNode(source.id, {
    role: "assistant",
    content: "new answer",
    turn: 1,
  }, { parentId: edited.node.id });
  const beforeSelection = store.getConversation(source.id);
  store.selectConversationHead(source.id, originalAnswer.id, { expectedRevision: beforeSelection.revision });

  const backup = store.createConversationBackup(source.id);
  assert.equal(backup.ok, true, backup.error);
  const sourceBefore = fs.readFileSync(backup.file, "utf8");
  const parsed = parseConversationBackup(sourceBefore);
  assert.equal(parsed.ok, true, parsed.error);
  assert.equal(parsed.data.version, 2);
  assert.equal(parsed.data.conversation.nodes.length, 4);
  assert.equal(parsed.data.conversation.headId, originalAnswer.id);
  assert.deepEqual(parsed.data.messages.map((message) => message.content), ["original", "old answer"]);

  const target = createProjectTab("v2-hidden-branch-target");
  store.appendMessage(target.id, { role: "user", content: "protect me", ts: 3000 });
  const restored = store.restoreConversationBackupToTab(target.id, backup.file);
  assert.equal(restored.ok, true, restored.error);
  assert.equal(fs.existsSync(restored.recoveryBackupFile), true);
  const restoredGraph = store.getConversation(target.id);
  assert.equal(restoredGraph.nodes.length, 4);
  assert.equal(restoredGraph.headId, originalAnswer.id);
  assert.deepEqual(store.getMessages(target.id).map((message) => message.content), ["original", "old answer"]);
  assert.equal(fs.readFileSync(backup.file, "utf8"), sourceBefore);

  const damaged = JSON.parse(sourceBefore);
  damaged.conversation.headId = edited.node.id;
  assert.equal(parseConversationBackup(JSON.stringify(damaged)).ok, false);
});

test("v1 backup imports as a linear graph and preserves user-owned graph-like metadata", () => {
  const messages = [
    { id: "user-owned-id", parentId: "user-owned-parent-metadata", sequence: 99, role: "user", content: "legacy question", turn: 1, ts: 1000 },
    { role: "assistant", content: "legacy answer", turn: 1, ts: 2000 },
  ];
  const body = {
    schema: "aiefficiency.devbench.conversation-backup",
    version: 1,
    createdAt: Date.now(),
    kind: "legacy-test",
    liveIncluded: false,
    sourceTab: { id: "legacy-source", title: "legacy", ticketUrl: "" },
    messages,
  };
  const legacyFile = path.join(tmp, `legacy-${Date.now()}.devbench-chat.json`);
  const source = `${JSON.stringify({ ...body, checksum: sha256(JSON.stringify(body)) }, null, 2)}\n`;
  fs.writeFileSync(legacyFile, source, "utf8");
  const target = createProjectTab("v1-import-target");
  const restored = store.restoreConversationBackupToTab(target.id, legacyFile);

  assert.equal(restored.ok, true, restored.error);
  assert.deepEqual(store.getMessages(target.id), messages);
  const graph = store.getConversation(target.id);
  assert.equal(graph.nodes.length, 2);
  assert.equal(graph.activePathIds.length, 2);
  assert.equal(graph.headId, graph.nodes[1].id);
  assert.equal(fs.readFileSync(legacyFile, "utf8"), source);
});
