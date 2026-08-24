/**
 * 故事点跨机一键备份/还原（.devbench-story.zip）单元测试：
 *  - 备份保留旧分支名 / 旧 worktree 目录（_legacyRefs / manifest.legacyRefs）
 *  - 还原消息 + 空对话图兜底（防“聊天记录全部丢失”）
 *  - worktree 就绪后 applyStoryBackupRefRemap 更新聊天记录中的旧分支名/旧目录
 * 隔离：临时 DEVBENCH_STORE_DIR / GATEWAY_DB_PATH，不污染真实库。
 */
import { test, before } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "story-backup-test-"));
const MARKET = path.join(tmp, "market.json");
process.env.DEVBENCH_CONFIG_PATH = MARKET;
process.env.DEVBENCH_LOCAL_PROJECTS_PATH = path.join(tmp, "local", "devbench-projects.json");
process.env.DEVBENCH_STORE_DIR = path.join(tmp, "store");
process.env.GATEWAY_CONFIG_PATH = path.join(tmp, "gw.json");
process.env.GATEWAY_DB_PATH = path.join(tmp, "data.db");
process.env.AIEFFICIENCY_CLONE_PARENT = path.join(tmp, "default-clone-parent");
fs.writeFileSync(process.env.GATEWAY_CONFIG_PATH, JSON.stringify({ teambition: { projects: [{ id: "projA", name: "A" }, { id: "projB", name: "B" }] } }));
fs.writeFileSync(MARKET, "{}");

let store, backup;
const require = createRequire(new URL("../../gateway/package.json", import.meta.url));
const JSZip = require("jszip");

before(async () => {
  store = await import("../services/devbench/store.js");
  backup = await import("../services/devbench/story-backup.js");
});

function seedTab(title) {
  const tab = store.createTab({ title, projectDefId: "defA" });
  store.updateTab(tab.id, {
    primaryProjectId: "projA",
    mode: "local",
    flavors: [{ projectId: "projA", flavor: "baicn5" }],
    worktree: {
      entries: [
        { role: "primary", baseProjectId: "projA", projectId: "projA", branch: "story/release_CARB_123", flavor: "baicn5", path: "D:/worktrees/AAA", worktreePath: "D:/worktrees/AAA", basePath: "D:/worktrees/AAA" },
        { role: "extra", baseProjectId: "projB", projectId: "projB", branch: "story/release_CARB_123", flavor: "appmarket", path: "D:/worktrees/BBB", worktreePath: "D:/worktrees/BBB", basePath: "D:/worktrees/BBB" },
      ],
      worktreePath: "D:/worktrees/AAA",
    },
    extraProjects: [{ baseProjectId: "projB", path: "D:/worktrees/BBB" }],
    ticketUrl: "https://www.teambition.com/task/abc123",
    tbContext: { title, projectId: "projA", projectName: "A" },
  });
  store.appendMessage(tab.id, { role: "user", content: "请分析问题", ts: Date.now() - 5000 });
  store.appendMessage(tab.id, {
    role: "assistant",
    engine: "codex",
    content: "我分析了 D:/worktrees/AAA 目录，分支 story/release_CARB_123。",
    ts: Date.now() - 4000,
  });
  store.appendMessage(tab.id, { role: "user", content: "继续", ts: Date.now() - 3000 });
  return tab;
}

test("备份 zip 保留旧分支名与旧 worktree 目录（tab._legacyRefs + manifest.legacyRefs）", async () => {
  const tab = seedTab("备份保留引用");
  const built = await backup.buildStoryBackupZip(tab.id);
  assert.equal(built.ok, true, built.error);
  const zip = await JSZip.loadAsync(built.buffer);
  const portableTab = JSON.parse(await zip.file("tab.json").async("string"));
  const manifest = JSON.parse(await zip.file("manifest.json").async("string"));
  assert.ok(Array.isArray(portableTab._legacyRefs?.worktree), "备份必须保留 _legacyRefs");
  const primary = portableTab._legacyRefs.worktree.find((entry) => entry.role === "primary");
  assert.equal(primary.branch, "story/release_CARB_123");
  assert.equal(primary.worktreePath, "D:/worktrees/AAA");
  assert.ok(manifest.legacyRefs?.branches?.includes("story/release_CARB_123"), "manifest 摘要应含旧分支名");
  assert.ok(manifest.legacyRefs?.worktreeDirs?.includes("D:/worktrees/AAA"), "manifest 摘要应含旧 worktree 目录");
  // 可移植形态：worktree.entries 不得再带本机绝对路径
  assert.equal(portableTab.worktree.entries[0].path, undefined, "可移植 tab 不应再暴露本机路径");
  assert.equal(portableTab.worktree.entries[0].worktreePath, undefined);
  assert.equal(portableTab.backupLegacyRefs, undefined, "本机暂存字段不随备份传播");
});

test("解析备份返回 snapshot：flavors 携带可移植 projectId（还原 Flavor 用）", async () => {
  const tab = seedTab("解析快照");
  const built = await backup.buildStoryBackupZip(tab.id);
  const parsed = await backup.parseStoryBackupZip(built.buffer);
  assert.equal(parsed.ok, true, parsed.error);
  const flavors = parsed.data.snapshot.flavors || [];
  const primaryFlavor = flavors.find((row) => row.projectId === "projA");
  assert.equal(primaryFlavor?.flavor, "baicn5", "主工程 Flavor 必须可移植保留");
  assert.ok(flavors.some((row) => row.projectId === "projB" && row.flavor === "appmarket"));
  assert.equal(parsed.data.messageCount, 3);
});

test("还原到新 tab：对话消息完整还原；worktree 未就绪时暂存 backupLegacyRefs", async () => {
  const src = seedTab("还原目标");
  const built = await backup.buildStoryBackupZip(src.id);
  const tab2 = store.createTab({ title: "还原后的故事点", projectDefId: "defA" });
  const applied = await backup.applyStoryBackupToTab(built.buffer, tab2.id);
  assert.equal(applied.ok, true, applied.error);
  assert.equal(applied.messageCount, 3);
  const messages = store.getMessages(tab2.id);
  assert.equal(messages.length, 3, "聊天记录必须完整还原");
  assert.match(messages[1].content, /D:\/worktrees\/AAA/);
  assert.equal(applied.refRemapApplied, false, "worktree 未就绪时不立即替换");
  const pending = store.getTab(tab2.id)?.backupLegacyRefs;
  assert.ok(pending, "未就绪时应暂存待替换引用");
  assert.equal(pending.worktree[0].branch, "story/release_CARB_123");
});

test("空对话图 + 有消息列表的备份：兜底还原消息，不丢聊天记录", async () => {
  const tab3 = store.createTab({ title: "空对话图兜底", projectDefId: "defA" });
  const zip = new JSZip();
  zip.file("manifest.json", JSON.stringify({ schema: backup.STORY_BACKUP_SCHEMA, version: 1, createdAt: Date.now(), sourceMachine: {}, storySlug: "empty", tabId: "old", tabTitle: "旧", messageCount: 1, fileCount: 0, totalBytes: 0 }));
  zip.file("tab.json", JSON.stringify({ title: "旧", id: "old" }));
  zip.file("conversation.json", JSON.stringify({ schemaVersion: 2, revision: 0, headId: null, nextSequence: 1, nodes: [] }));
  zip.file("messages.json", JSON.stringify([{ role: "user", content: "备份里唯一一条消息", ts: 1000 }]));
  const buffer = await zip.generateAsync({ type: "nodebuffer" });
  const applied = await backup.applyStoryBackupToTab(buffer, tab3.id);
  assert.equal(applied.ok, true, applied.error);
  assert.equal(applied.messageCount, 1);
  const messages = store.getMessages(tab3.id);
  assert.equal(messages.length, 1, "空对话图不得吞掉消息");
  assert.equal(messages[0].content, "备份里唯一一条消息");
});

test("worktree 就绪后 applyStoryBackupRefRemap：旧分支名/旧目录替换为新值并清除暂存", async () => {
  const src = seedTab("引用替换");
  const built = await backup.buildStoryBackupZip(src.id);
  const tab2 = store.createTab({ title: "替换目标", projectDefId: "defA" });
  await backup.applyStoryBackupToTab(built.buffer, tab2.id);
  // 模拟 worktree provision 完成：新分支 + 新目录
  store.updateTab(tab2.id, {
    worktree: {
      entries: [
        { role: "primary", baseProjectId: "projA", branch: "story/release_CARB_456", path: "C:/worktrees/NEW-AAA", worktreePath: "C:/worktrees/NEW-AAA", basePath: "C:/worktrees/NEW-AAA" },
        { role: "extra", baseProjectId: "projB", branch: "story/release_CARB_456", path: "C:/worktrees/NEW-BBB", worktreePath: "C:/worktrees/NEW-BBB", basePath: "C:/worktrees/NEW-BBB" },
      ],
      worktreePath: "C:/worktrees/NEW-AAA",
    },
  });
  const result = backup.applyStoryBackupRefRemap(tab2.id);
  assert.equal(result.ok, true);
  assert.equal(result.applied, true);
  const messages = store.getMessages(tab2.id);
  assert.match(messages[1].content, /C:\/worktrees\/NEW-AAA/);
  assert.doesNotMatch(messages[1].content, /D:\/worktrees\/AAA/);
  assert.match(messages[1].content, /story\/release_CARB_456/);
  assert.doesNotMatch(messages[1].content, /story\/release_CARB_123/);
  assert.equal(store.getTab(tab2.id)?.backupLegacyRefs == null, true, "替换完成后应清除暂存");
});

test("引用替换带字符边界：不误伤兄弟分支/兄弟目录，但能更新旧目录下的子路径前缀", async () => {
  const src = seedTab("边界替换");
  const built = await backup.buildStoryBackupZip(src.id);
  const tab2 = store.createTab({ title: "边界目标", projectDefId: "defA" });
  await backup.applyStoryBackupToTab(built.buffer, tab2.id);
  // 追加一条含兄弟串/子路径的消息，验证替换边界
  const extra = store.appendMessage(tab2.id, {
    role: "user",
    content: "兄弟分支 story/release_CARB_1234 与 story/release_CARB_12345；目录 D:/worktrees/AAA2 和 D:/worktrees/AAA/foo/bar.txt 都要保留正确。",
    ts: Date.now(),
  });
  void extra;
  store.updateTab(tab2.id, {
    worktree: {
      entries: [
        { role: "primary", baseProjectId: "projA", branch: "story/release_CARB_456", path: "C:/worktrees/NEW-AAA", worktreePath: "C:/worktrees/NEW-AAA", basePath: "C:/worktrees/NEW-AAA" },
      ],
      worktreePath: "C:/worktrees/NEW-AAA",
    },
  });
  const result = backup.applyStoryBackupRefRemap(tab2.id);
  assert.equal(result.ok, true);
  const messages = store.getMessages(tab2.id);
  const target = messages.find((m) => /兄弟分支/.test(m.content)).content;
  assert.match(target, /story\/release_CARB_1234/, "兄弟分支 1234 不得被误替换");
  assert.match(target, /story\/release_CARB_12345/, "兄弟分支 12345 不得被误替换");
  assert.match(target, /D:\/worktrees\/AAA2/, "兄弟目录 AAA2 不得被误替换");
  assert.match(target, /C:\/worktrees\/NEW-AAA\/foo\/bar\.txt/, "旧目录下的子路径前缀应同步更新");
  assert.doesNotMatch(target, /story\/release_CARB_123[^45]/, "旧分支名本身应被替换");
  assert.doesNotMatch(target, /D:\/worktrees\/AAA(?![2\/])/, "旧目录整段应被替换");
});
