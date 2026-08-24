import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "devbench-closed-story-purge-"));
process.env.GATEWAY_DB_PATH = path.join(tmp, "data.db");
process.env.GATEWAY_CONFIG_PATH = path.join(tmp, "gateway.json");
process.env.DEVBENCH_CONFIG_PATH = path.join(tmp, "market.json");
process.env.DEVBENCH_LOCAL_PROJECTS_PATH = path.join(tmp, "local-projects.json");
process.env.DEVBENCH_STORE_DIR = path.join(tmp, "store");
process.env.AIEFFICIENCY_CLONE_PARENT = path.join(tmp, "clone-parent");
fs.writeFileSync(process.env.GATEWAY_CONFIG_PATH, JSON.stringify({ servers: { nodeId: "closed-story-purge-test" } }));

const express = (await import("express")).default;
const store = await import("../services/devbench/store.js");
const db = await import("../db/sqlite.js");
const devbenchRouter = (await import("../routes/devbench.js")).default;

let sequence = 0;

function seedStory(label, { customArchiveDir = "", close = true } = {}) {
  sequence += 1;
  const repo = fs.mkdtempSync(path.join(tmp, `repo-${sequence}-`));
  const projectId = `closed-purge-project-${sequence}`;
  assert.equal(store.upsertProject({ id: projectId, name: label, path: repo }).ok, true);
  let tab = store.createTab({ title: `${label}-${sequence}` });
  tab = store.updateTab(tab.id, { primaryProjectId: projectId, docSlug: `story-${sequence}` });
  if (customArchiveDir) {
    const changed = store.setTabArchiveDir(tab.id, customArchiveDir);
    assert.equal(changed.ok, true, changed.error);
    tab = changed.tab;
  }
  store.appendMessage(tab.id, { role: "user", content: `${label} 用户问题`, turn: 1, ts: 1000 });
  store.appendMessage(tab.id, { role: "assistant", content: `${label} AI 回答`, turn: 1, ts: 2000, engine: "codex" });
  store.saveLiveDraft(tab.id, { taskId: `live-${tab.id}`, text: "流式回答", streaming: false });

  const archive = store.getArchiveDirInfo(store.getTab(tab.id));
  fs.mkdirSync(archive.effectiveArchiveDir, { recursive: true });
  fs.writeFileSync(archive.archiveFile, `${label} TXT`, "utf8");
  const backup = store.createConversationBackup(tab.id);
  assert.equal(backup.ok, true, backup.error);

  const storage = store.getStoryStoragePaths(store.getTab(tab.id), { create: true });
  const currentAttachments = storage.attachmentDirectory;
  const legacyAttachments = storage.reportsDirectory;
  const tempFiles = storage.tempDirectory;
  fs.mkdirSync(path.join(currentAttachments, "nested"), { recursive: true });
  fs.mkdirSync(legacyAttachments, { recursive: true });
  fs.mkdirSync(tempFiles, { recursive: true });
  fs.writeFileSync(path.join(currentAttachments, "nested", "screen.png"), "image", "utf8");
  fs.writeFileSync(path.join(legacyAttachments, "verify.log"), "report", "utf8");
  fs.writeFileSync(path.join(tempFiles, "verify.ps1"), "script", "utf8");

  const executionTaskId = `execution-${tab.id}`;
  db.createTask({
    id: executionTaskId,
    title: tab.title,
    description: "数据库中的用户问题",
    type: "general",
    status: "completed",
    priority: 3,
    source: "devbench",
    sourceId: tab.sessionId,
  });
  db.addLog(executionTaskId, "info", "devbench", "数据库中的 AI 执行日志");
  db.addTokenUsage(executionTaskId, "codex", 10, 20);

  const todo = store.createTask({ title: `${label} 待办任务` }).task;
  store.updateTask(todo.id, { tabId: tab.id });
  if (close) assert.equal(store.deleteTab(tab.id).closed, true);
  return {
    tab,
    repo,
    archiveDir: archive.effectiveArchiveDir,
    archiveFile: archive.archiveFile,
    backupFile: backup.file,
    currentAttachments,
    legacyAttachments,
    tempFiles,
    executionTaskId,
    todoId: todo.id,
  };
}

async function startTestServer() {
  const app = express();
  app.use(express.json());
  app.use("/api/devbench", devbenchRouter);
  return new Promise((resolve) => {
    const server = app.listen(0, "127.0.0.1", () => resolve(server));
  });
}

test("已关闭故事点可按确认范围物理删除聊天、TXT 整目录、新旧附件和执行历史", () => {
  const fixture = seedStory("全部删除");
  const legacySentinel = { id: "unrelated-legacy-story", title: "必须保留的其它旧故事点" };
  const legacySnapshotPaths = [
    path.join(process.env.DEVBENCH_STORE_DIR, "tabs.json"),
    path.join(process.env.DEVBENCH_STORE_DIR, "tabs.json.migrated"),
    path.join(process.env.DEVBENCH_STORE_DIR, "closed-tabs.json"),
    path.join(process.env.DEVBENCH_STORE_DIR, "closed-tabs.json.migrated"),
  ];
  fs.mkdirSync(process.env.DEVBENCH_STORE_DIR, { recursive: true });
  for (const filePath of legacySnapshotPaths) {
    fs.writeFileSync(filePath, JSON.stringify([fixture.tab, legacySentinel], null, 2), "utf8");
  }
  const preview = store.previewClosedStoryDeletion(fixture.tab.id);
  assert.equal(preview.ok, true, preview.error);
  assert.equal(preview.data.archiveDirectory.safeToDelete, true, preview.data.archiveDirectory.unsafeReason);
  assert.equal(preview.data.attachments.safeToDelete, true, preview.data.attachments.unsafeReason);
  assert.equal(preview.data.conversationBackups.count, 1);
  assert.equal(preview.data.conversationBackups.coveredByArchiveDirectoryCount, 1);

  const removed = store.purgeClosedStory(fixture.tab.id, {
    confirmId: fixture.tab.id,
    expectedClosedAt: preview.data.story.closedAt,
    deleteConversationBackups: true,
    deleteArchiveDirectory: true,
    deleteAttachments: true,
  });
  assert.equal(removed.ok, true, removed.error);
  assert.equal(removed.data.story.status, "deleted");
  assert.equal(fs.existsSync(fixture.archiveDir), false, "TXT 的整个 ask 目录应删除");
  assert.equal(fs.existsSync(fixture.currentAttachments), false, "当前 archives 应删除");
  assert.equal(fs.existsSync(fixture.legacyAttachments), false, "reports 应删除");
  assert.equal(fs.existsSync(fixture.tempFiles), false, "tempFiles 应删除");
  assert.equal(fs.existsSync(path.join(process.env.DEVBENCH_STORE_DIR, `msg-${fixture.tab.id}.json`)), false);
  assert.equal(fs.existsSync(path.join(process.env.DEVBENCH_STORE_DIR, `live-${fixture.tab.id}.json`)), false);
  assert.equal(store.listClosedTabs().some((item) => item.id === fixture.tab.id), false);
  for (const filePath of legacySnapshotPaths) {
    const rows = JSON.parse(fs.readFileSync(filePath, "utf8"));
    assert.equal(rows.some((item) => item.id === fixture.tab.id), false, `${path.basename(filePath)} 不能残留目标关闭快照`);
    assert.equal(rows.some((item) => item.id === legacySentinel.id), true, `${path.basename(filePath)} 必须保留其它故事点`);
  }
  assert.equal(db.getTask(fixture.executionTaskId), undefined, "SQLite 中的聊天执行副本也应物理删除");
  const todo = store.listTasks().find((item) => item.id === fixture.todoId);
  assert.equal(todo.tabId, fixture.tab.id, "待办任务业务记录保留，原绑定用于下次识别为再次开发并重建");
  assert.equal(fs.existsSync(fixture.repo), true, "工程源码不能删除");
});

test("三个可选项都不选时仅删除故事点核心记录，外部备份、TXT 和附件保持不动", () => {
  const fixture = seedStory("保留外部资料");
  const preview = store.previewClosedStoryDeletion(fixture.tab.id);
  const removed = store.purgeClosedStory(fixture.tab.id, {
    confirmId: fixture.tab.id,
    expectedClosedAt: preview.data.story.closedAt,
    deleteConversationBackups: false,
    deleteArchiveDirectory: false,
    deleteAttachments: false,
  });
  assert.equal(removed.ok, true, removed.error);
  assert.equal(removed.data.conversationBackups.status, "preserved");
  assert.equal(removed.data.archiveDirectory.status, "preserved");
  assert.equal(removed.data.attachments.status, "preserved");
  assert.equal(fs.existsSync(fixture.backupFile), true);
  assert.equal(fs.existsSync(fixture.archiveFile), true);
  assert.equal(fs.existsSync(fixture.currentAttachments), true);
  assert.equal(fs.existsSync(fixture.legacyAttachments), true);
});

test("物理删除后的持久化 tombstone 可阻止另一个 Gateway 进程迟到重建聊天和草稿", () => {
  const fixture = seedStory("跨进程迟到回写");
  const preview = store.previewClosedStoryDeletion(fixture.tab.id);
  const removed = store.purgeClosedStory(fixture.tab.id, {
    confirmId: fixture.tab.id,
    expectedClosedAt: preview.data.story.closedAt,
  });
  assert.equal(removed.ok, true, removed.error);

  const storeUrl = new URL("../services/devbench/store.js", import.meta.url).href;
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", `
    const store = await import(${JSON.stringify(storeUrl)});
    store.appendMessage(${JSON.stringify(fixture.tab.id)}, { role: "assistant", content: "迟到回答", turn: 2 });
    store.saveLiveDraft(${JSON.stringify(fixture.tab.id)}, { taskId: "late", text: "迟到草稿" });
    if (!store.isTabDeletionBlocked(${JSON.stringify(fixture.tab.id)})) process.exit(3);
  `], { cwd: path.resolve("."), env: { ...process.env }, encoding: "utf8" });
  assert.equal(child.status, 0, child.stderr || child.stdout);
  assert.equal(fs.existsSync(path.join(process.env.DEVBENCH_STORE_DIR, `msg-${fixture.tab.id}.json`)), false);
  assert.equal(fs.existsSync(path.join(process.env.DEVBENCH_STORE_DIR, `live-${fixture.tab.id}.json`)), false);
  db.setUserData(store.storageUserKey("closed"), "closed", [{ ...fixture.tab, closedAt: preview.data.story.closedAt }], "stale-gateway");
  assert.equal(store.listClosedTabs().some((item) => item.id === fixture.tab.id), false, "其它 Gateway 的陈旧关闭行不能让已删除故事点重新出现");
  assert.equal(store.previewClosedStoryDeletion(fixture.tab.id).code, "CLOSED_STORY_NOT_FOUND");
});

test("删除整个 TXT 目录会明确覆盖同目录 JSON 备份，即使未单独选择备份", () => {
  const fixture = seedStory("TXT 覆盖备份");
  const preview = store.previewClosedStoryDeletion(fixture.tab.id);
  const removed = store.purgeClosedStory(fixture.tab.id, {
    confirmId: fixture.tab.id,
    expectedClosedAt: preview.data.story.closedAt,
    deleteConversationBackups: false,
    deleteArchiveDirectory: true,
    deleteAttachments: false,
  });
  assert.equal(removed.ok, true, removed.error);
  assert.equal(removed.data.conversationBackups.status, "covered_by_archive_directory");
  assert.equal(removed.data.conversationBackups.coveredByArchiveDirectoryCount, 1);
  assert.equal(fs.existsSync(fixture.backupFile), false);
  assert.equal(fs.existsSync(fixture.currentAttachments), true);
});

test("自定义 TXT 目录禁止递归物理删除，预检失败时故事点和文件均保留", () => {
  const custom = fs.mkdtempSync(path.join(tmp, "shared-custom-archive-"));
  const fixture = seedStory("自定义目录保护", { close: false });
  const rejected = store.setTabArchiveDir(fixture.tab.id, custom);
  assert.equal(rejected.ok, false, "新版本必须拒绝向自定义目录写入");
  const legacyArchiveFile = path.join(custom, `${fixture.tab.docSlug}.txt`);
  fs.writeFileSync(legacyArchiveFile, "历史自定义 TXT", "utf8");
  assert.notEqual(store.updateTab(fixture.tab.id, {
    archiveDir: custom,
    archiveFile: legacyArchiveFile,
  }), null);
  assert.equal(store.deleteTab(fixture.tab.id).closed, true);
  fixture.archiveFile = legacyArchiveFile;
  const preview = store.previewClosedStoryDeletion(fixture.tab.id);
  assert.equal(preview.ok, true);
  assert.equal(preview.data.archiveDirectory.safeToDelete, false);
  assert.match(preview.data.archiveDirectory.unsafeReason, /自定义|独占标记/);
  const removed = store.purgeClosedStory(fixture.tab.id, {
    confirmId: fixture.tab.id,
    expectedClosedAt: preview.data.story.closedAt,
    deleteArchiveDirectory: true,
  });
  assert.equal(removed.ok, false);
  assert.equal(removed.code, "UNSAFE_ARCHIVE_DIRECTORY");
  assert.notEqual(removed.partial, true, "删除前预检拒绝不能标记为部分删除");
  assert.equal(store.listClosedTabs().some((item) => item.id === fixture.tab.id), true);
  assert.equal(fs.existsSync(fixture.archiveFile), true);
  assert.equal(fs.existsSync(path.join(process.env.DEVBENCH_STORE_DIR, `msg-${fixture.tab.id}.json`)), true);
});

test("只有进入物理删除执行阶段后的失败才返回可展示的部分结果标记", () => {
  const fixture = seedStory("执行期失败分类");
  const preview = store.previewClosedStoryDeletion(fixture.tab.id);
  const originalRenameSync = fs.renameSync;
  fs.renameSync = (source, destination) => {
    if (path.resolve(String(source)) === path.resolve(fixture.archiveDir)) {
      const error = new Error("验收注入的目录隔离失败");
      error.code = "EBUSY";
      throw error;
    }
    return originalRenameSync(source, destination);
  };
  let removed;
  try {
    removed = store.purgeClosedStory(fixture.tab.id, {
      confirmId: fixture.tab.id,
      expectedClosedAt: preview.data.story.closedAt,
      deleteArchiveDirectory: true,
    });
  } finally {
    fs.renameSync = originalRenameSync;
  }
  assert.equal(removed.ok, false);
  assert.equal(removed.code, "RESOURCE_DELETE_FAILED");
  assert.equal(removed.partial, true, "执行期失败必须显式标记 data 是执行结果而非预览");
  assert.equal(removed.data.story.status, "pending");
  assert.equal(removed.data.archiveDirectory.status, "failed");
  assert.equal(removed.data.core.messageFile, undefined, "尚未执行的核心文件不能误报已处理");
  assert.equal(store.listClosedTabs().some((item) => item.id === fixture.tab.id), true);
  assert.equal(fs.existsSync(fixture.archiveFile), true);
});

test("两个 Gateway 并发物理删除不同故事点时四类旧快照不会丢失任一删除结果", async () => {
  const first = seedStory("并发旧快照甲");
  const second = seedStory("并发旧快照乙");
  const firstClosed = store.listClosedTabs().find((item) => item.id === first.tab.id);
  const secondClosed = store.listClosedTabs().find((item) => item.id === second.tab.id);
  const sentinel = { id: `legacy-sentinel-${Date.now()}`, title: "必须保留的其它故事点" };
  const legacyFiles = ["tabs.json", "tabs.json.migrated", "closed-tabs.json", "closed-tabs.json.migrated"]
    .map((name) => path.join(process.env.DEVBENCH_STORE_DIR, name));
  for (const filePath of legacyFiles) {
    fs.writeFileSync(filePath, `${JSON.stringify([firstClosed, secondClosed, sentinel], null, 2)}\n`, "utf8");
  }

  const readyFile = path.join(tmp, `legacy-lock-ready-${Date.now()}`);
  const goFile = `${readyFile}.go`;
  const secondLockAttemptFile = `${readyFile}.second-lock-attempt`;
  const legacyLockFile = path.join(process.env.DEVBENCH_STORE_DIR, "delete-tombstones", "legacy-story-snapshots.lock");
  const storeUrl = new URL("../services/devbench/store.js", import.meta.url).href;
  const workerSource = `
    import fs from "node:fs";
    import path from "node:path";
    const [tabId, expectedClosedAt, legacyFile, readyFile, goFile, hold, lockFile, lockAttemptFile] = process.argv.slice(1);
    const originalOpenSync = fs.openSync;
    let lockAttemptRecorded = false;
    fs.openSync = (target, flags, ...args) => {
      if (lockAttemptFile && !lockAttemptRecorded && flags === "wx"
        && path.resolve(String(target)) === path.resolve(lockFile)) {
        lockAttemptRecorded = true;
        fs.writeFileSync(lockAttemptFile, JSON.stringify({ tabId, at: Date.now() }), "utf8");
      }
      return originalOpenSync(target, flags, ...args);
    };
    const originalRenameSync = fs.renameSync;
    let paused = false;
    fs.renameSync = (source, destination) => {
      if (hold === "hold" && !paused && path.resolve(String(destination)) === path.resolve(legacyFile)) {
        paused = true;
        fs.writeFileSync(readyFile, "ready\\n", "utf8");
        const signal = new Int32Array(new SharedArrayBuffer(4));
        const deadline = Date.now() + 30000;
        while (!fs.existsSync(goFile) && Date.now() < deadline) Atomics.wait(signal, 0, 0, 10);
        if (!fs.existsSync(goFile)) throw new Error("legacy snapshot barrier timeout");
      }
      return originalRenameSync(source, destination);
    };
    const store = await import(${JSON.stringify(storeUrl)});
    const result = store.purgeClosedStory(tabId, {
      confirmId: tabId,
      expectedClosedAt: Number(expectedClosedAt),
      deleteConversationBackups: false,
      deleteArchiveDirectory: false,
      deleteAttachments: false,
    });
    process.stdout.write(JSON.stringify(result));
    process.exit(result.ok ? 0 : 2);
  `;
  function launch(tab, hold = false) {
    const child = spawn(process.execPath, [
      "--input-type=module",
      "-e",
      workerSource,
      tab.id,
      String(tab.closedAt),
      legacyFiles[0],
      readyFile,
      goFile,
      hold ? "hold" : "run",
      legacyLockFile,
      hold ? "" : secondLockAttemptFile,
    ], {
      cwd: path.resolve("."),
      env: { ...process.env },
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const completed = new Promise((resolve) => {
      child.stdout.on("data", (chunk) => { stdout += chunk; });
      child.stderr.on("data", (chunk) => { stderr += chunk; });
      child.on("close", (code) => resolve({ code, stdout, stderr }));
    });
    return { child, completed };
  }

  const firstRun = launch(firstClosed, true);
  const readyDeadline = Date.now() + 15000;
  while (!fs.existsSync(readyFile) && Date.now() < readyDeadline) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(fs.existsSync(readyFile), true, "首个 Gateway 必须持有旧快照锁并停在原子替换前");
  const secondRun = launch(secondClosed, false);
  const attemptDeadline = Date.now() + 15000;
  while (!fs.existsSync(secondLockAttemptFile) && Date.now() < attemptDeadline) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(fs.existsSync(secondLockAttemptFile), true, "第二个 Gateway 必须已经尝试取得同一把旧快照锁");
  const lockOwner = JSON.parse(fs.readFileSync(legacyLockFile, "utf8"));
  assert.equal(lockOwner.tabId, firstClosed.id, "第二个 Gateway 尝试加锁时，锁仍必须由首个故事点持有");
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(secondRun.child.exitCode, null, "第二个 Gateway 已到锁点后必须继续等待，不能覆盖首个进程的读改写");
  fs.writeFileSync(goFile, "go\n", "utf8");
  const [firstResult, secondResult] = await Promise.all([firstRun.completed, secondRun.completed]);
  assert.equal(firstResult.code, 0, firstResult.stderr || firstResult.stdout);
  assert.equal(secondResult.code, 0, secondResult.stderr || secondResult.stdout);

  for (const filePath of legacyFiles) {
    const rows = JSON.parse(fs.readFileSync(filePath, "utf8"));
    assert.equal(rows.some((item) => item?.id === first.tab.id), false, `${path.basename(filePath)} 不能残留甲故事点`);
    assert.equal(rows.some((item) => item?.id === second.tab.id), false, `${path.basename(filePath)} 不能残留乙故事点`);
    assert.equal(rows.some((item) => item?.id === sentinel.id), true, `${path.basename(filePath)} 必须保留其它故事点`);
  }
});

test("前一进程释放锁后 successor 立即取得新锁时不得被误报为释放失败", () => {
  const fixture = seedStory("旧快照锁 successor 交接");
  const closed = store.listClosedTabs().find((item) => item.id === fixture.tab.id);
  const lockFile = path.join(process.env.DEVBENCH_STORE_DIR, "delete-tombstones", "legacy-story-snapshots.lock");
  const successorToken = `successor-${Date.now()}`;
  const originalRmSync = fs.rmSync;
  let successorCreated = false;
  fs.rmSync = (target, ...args) => {
    const value = originalRmSync(target, ...args);
    if (!successorCreated && path.resolve(String(target)) === path.resolve(lockFile)) {
      successorCreated = true;
      fs.writeFileSync(lockFile, JSON.stringify({
        version: 1,
        token: successorToken,
        host: os.hostname(),
        pid: process.pid,
        tabId: "successor-owner",
        startedAt: Date.now(),
      }), "utf8");
    }
    return value;
  };
  let removed;
  try {
    removed = store.purgeClosedStory(fixture.tab.id, {
      confirmId: fixture.tab.id,
      expectedClosedAt: closed.closedAt,
    });
    assert.equal(successorCreated, true, "测试必须在旧 owner 删除锁后立即模拟 successor 取得新锁");
    assert.equal(JSON.parse(fs.readFileSync(lockFile, "utf8")).token, successorToken, "旧 owner 不能删除 successor 的锁");
  } finally {
    fs.rmSync = originalRmSync;
    originalRmSync(lockFile, { force: true });
  }
  assert.equal(removed.ok, true, removed.error);
  assert.equal(store.listClosedTabs().some((item) => item.id === fixture.tab.id), false);
  assert.equal(db.getTask(fixture.executionTaskId), undefined);
});

test("旧快照原子替换失败时原文件保持可解析且共享锁释放后可以重试", () => {
  const fixture = seedStory("旧快照原子写失败");
  const closed = store.listClosedTabs().find((item) => item.id === fixture.tab.id);
  const legacyFile = path.join(process.env.DEVBENCH_STORE_DIR, "tabs.json");
  const sentinel = { id: `atomic-sentinel-${Date.now()}`, title: "原子写失败也必须保留" };
  fs.writeFileSync(legacyFile, `${JSON.stringify([closed, sentinel], null, 2)}\n`, "utf8");
  const originalRenameSync = fs.renameSync;
  fs.renameSync = (source, destination) => {
    if (path.resolve(String(destination)) === path.resolve(legacyFile)
      && path.basename(String(source)).startsWith(`.${path.basename(legacyFile)}.`)) {
      const error = new Error("验收注入的旧快照原子替换失败");
      error.code = "EIO";
      throw error;
    }
    return originalRenameSync(source, destination);
  };
  let failed;
  try {
    failed = store.purgeClosedStory(fixture.tab.id, {
      confirmId: fixture.tab.id,
      expectedClosedAt: closed.closedAt,
    });
  } finally {
    fs.renameSync = originalRenameSync;
  }
  assert.equal(failed.ok, false);
  assert.equal(failed.partial, true);
  assert.equal(failed.code, "CORE_DELETE_FAILED");
  const rowsAfterFailure = JSON.parse(fs.readFileSync(legacyFile, "utf8"));
  assert.equal(rowsAfterFailure.some((item) => item?.id === fixture.tab.id), true, "原子替换失败不能截断或提前覆盖原文件");
  assert.equal(rowsAfterFailure.some((item) => item?.id === sentinel.id), true);
  assert.equal(store.listClosedTabs().some((item) => item.id === fixture.tab.id), true);
  assert.equal(fs.readdirSync(path.dirname(legacyFile)).some((name) => name.startsWith(`.${path.basename(legacyFile)}.`) && name.endsWith(".tmp")), false, "失败临时文件必须清理");

  const retried = store.purgeClosedStory(fixture.tab.id, {
    confirmId: fixture.tab.id,
    expectedClosedAt: closed.closedAt,
  });
  assert.equal(retried.ok, true, retried.error);
  const rowsAfterRetry = JSON.parse(fs.readFileSync(legacyFile, "utf8"));
  assert.equal(rowsAfterRetry.some((item) => item?.id === fixture.tab.id), false);
  assert.equal(rowsAfterRetry.some((item) => item?.id === sentinel.id), true);
});

test("最终预检后旧快照损坏必须按不安全失败，不能误报不存在后继续删除数据库记录", () => {
  const fixture = seedStory("旧快照最终复核失败关闭保护");
  const closed = store.listClosedTabs().find((item) => item.id === fixture.tab.id);
  const legacyFile = path.join(process.env.DEVBENCH_STORE_DIR, "tabs.json");
  const messageFile = path.join(process.env.DEVBENCH_STORE_DIR, `msg-${fixture.tab.id}.json`);
  const sentinel = { id: `unsafe-refresh-sentinel-${Date.now()}`, title: "最终复核失败必须保留" };
  fs.writeFileSync(legacyFile, `${JSON.stringify([closed, sentinel], null, 2)}\n`, "utf8");
  const preview = store.previewClosedStoryDeletion(fixture.tab.id);
  assert.equal(preview.ok, true, preview.error);
  assert.equal(preview.data.core.legacyStorySnapshots.find((item) => item.path === legacyFile)?.safeToRewrite, true);

  const originalRmSync = fs.rmSync;
  let corrupted = false;
  fs.rmSync = (target, ...args) => {
    if (!corrupted && path.resolve(String(target)) === path.resolve(messageFile)) {
      corrupted = true;
      fs.writeFileSync(legacyFile, "{ final recheck injected invalid json", "utf8");
    }
    return originalRmSync(target, ...args);
  };
  let failed;
  try {
    failed = store.purgeClosedStory(fixture.tab.id, {
      confirmId: fixture.tab.id,
      expectedClosedAt: preview.data.story.closedAt,
    });
  } finally {
    fs.rmSync = originalRmSync;
  }
  assert.equal(corrupted, true, "测试必须在最终预检完成后再破坏旧快照");
  assert.equal(failed.ok, false);
  assert.equal(failed.partial, true);
  assert.equal(failed.code, "CORE_DELETE_FAILED");
  const legacyResult = failed.data.core.legacyStorySnapshots.find((item) => item.path === legacyFile);
  assert.equal(legacyResult?.status, "failed", "不安全旧快照不能被误报为 missing");
  assert.match(legacyResult?.error || "", /JSON|Unexpected|position|property|token|input/i);
  assert.equal(store.listClosedTabs().some((item) => item.id === fixture.tab.id), true, "关闭记录必须保留以便修复后重试");
  assert.notEqual(db.getTask(fixture.executionTaskId), undefined, "核心文件复核失败前不得删除 SQLite 执行历史");

  fs.writeFileSync(legacyFile, `${JSON.stringify([closed, sentinel], null, 2)}\n`, "utf8");
  const retried = store.purgeClosedStory(fixture.tab.id, {
    confirmId: fixture.tab.id,
    expectedClosedAt: preview.data.story.closedAt,
  });
  assert.equal(retried.ok, true, retried.error);
  const rowsAfterRetry = JSON.parse(fs.readFileSync(legacyFile, "utf8"));
  assert.equal(rowsAfterRetry.some((item) => item?.id === fixture.tab.id), false);
  assert.equal(rowsAfterRetry.some((item) => item?.id === sentinel.id), true);
});

test("最终复核的旧快照在 lstat 后被替换时必须按身份变化失败", () => {
  const fixture = seedStory("旧快照最终复核身份替换保护");
  const closed = store.listClosedTabs().find((item) => item.id === fixture.tab.id);
  const legacyFile = path.join(process.env.DEVBENCH_STORE_DIR, "tabs.json");
  const replacementFile = path.join(process.env.DEVBENCH_STORE_DIR, `replacement-${Date.now()}.json`);
  const messageFile = path.join(process.env.DEVBENCH_STORE_DIR, `msg-${fixture.tab.id}.json`);
  const sentinel = { id: `identity-sentinel-${Date.now()}`, title: "身份替换也必须保留" };
  const rows = [closed, sentinel];
  fs.writeFileSync(legacyFile, `${JSON.stringify(rows, null, 2)}\n`, "utf8");
  fs.writeFileSync(replacementFile, `${JSON.stringify(rows, null, 2)}\n`, "utf8");
  const preview = store.previewClosedStoryDeletion(fixture.tab.id);
  assert.equal(preview.ok, true, preview.error);

  const originalRmSync = fs.rmSync;
  const originalOpenSync = fs.openSync;
  let armed = false;
  let replaced = false;
  fs.rmSync = (target, ...args) => {
    if (path.resolve(String(target)) === path.resolve(messageFile)) armed = true;
    return originalRmSync(target, ...args);
  };
  fs.openSync = (target, flags, ...args) => {
    if (armed && !replaced && path.resolve(String(target)) === path.resolve(legacyFile)) {
      replaced = true;
      fs.renameSync(replacementFile, legacyFile);
    }
    return originalOpenSync(target, flags, ...args);
  };
  let failed;
  try {
    failed = store.purgeClosedStory(fixture.tab.id, {
      confirmId: fixture.tab.id,
      expectedClosedAt: preview.data.story.closedAt,
    });
  } finally {
    fs.rmSync = originalRmSync;
    fs.openSync = originalOpenSync;
    originalRmSync(replacementFile, { force: true });
  }
  assert.equal(replaced, true, "测试必须在 lstat 后、打开旧快照前替换目录项");
  assert.equal(failed.ok, false);
  assert.equal(failed.partial, true);
  assert.equal(failed.code, "CORE_DELETE_FAILED");
  const legacyResult = failed.data.core.legacyStorySnapshots.find((item) => item.path === legacyFile);
  assert.equal(legacyResult?.status, "failed");
  assert.match(legacyResult?.error || "", /身份已变化/);
  assert.equal(store.listClosedTabs().some((item) => item.id === fixture.tab.id), true);
  assert.notEqual(db.getTask(fixture.executionTaskId), undefined);
});

test("共享备份目录中只删除 sourceTab.id 精确匹配的 JSON，另一故事点备份保持不动", () => {
  const sharedBackupDir = fs.mkdtempSync(path.join(tmp, "shared-conversation-backups-"));
  const first = seedStory("共享备份甲", { close: false });
  const second = seedStory("共享备份乙", { close: false });
  assert.equal(store.createConversationBackup(first.tab.id, { directory: sharedBackupDir }).ok, false);
  assert.equal(store.createConversationBackup(second.tab.id, { directory: sharedBackupDir }).ok, false);
  const firstBackup = {
    file: path.join(sharedBackupDir, `first-${path.basename(first.backupFile)}`),
  };
  const secondBackup = {
    file: path.join(sharedBackupDir, `second-${path.basename(second.backupFile)}`),
  };
  fs.copyFileSync(first.backupFile, firstBackup.file);
  fs.copyFileSync(second.backupFile, secondBackup.file);
  fs.rmSync(first.backupFile, { force: true });
  fs.rmSync(second.backupFile, { force: true });
  assert.notEqual(store.updateTab(first.tab.id, {
    conversationBackupDirectories: [sharedBackupDir],
    conversationBackupFiles: [firstBackup.file],
  }), null);
  assert.notEqual(store.updateTab(second.tab.id, {
    conversationBackupDirectories: [sharedBackupDir],
    conversationBackupFiles: [secondBackup.file],
  }), null);
  store.deleteTab(first.tab.id);
  store.deleteTab(second.tab.id);
  const preview = store.previewClosedStoryDeletion(first.tab.id);
  assert.equal(preview.data.conversationBackups.files.some((file) => file.path === firstBackup.file), true);
  assert.equal(preview.data.conversationBackups.files.some((file) => file.path === secondBackup.file), false);
  const removed = store.purgeClosedStory(first.tab.id, {
    confirmId: first.tab.id,
    expectedClosedAt: preview.data.story.closedAt,
    deleteConversationBackups: true,
    deleteArchiveDirectory: false,
    deleteAttachments: false,
  });
  assert.equal(removed.ok, true, removed.error);
  assert.equal(fs.existsSync(firstBackup.file), false);
  assert.equal(fs.existsSync(secondBackup.file), true, "共享目录中另一故事点的备份不能误删");
  assert.equal(store.listClosedTabs().some((item) => item.id === second.tab.id), true);
});

test("拒绝跨故事点新备份，并继续保护历史遗留在目标 ask 的备份", () => {
  const owner = seedStory("TXT 目录所有者", { close: false });
  const guest = seedStory("跨故事点备份", { close: false });
  const rejected = store.createConversationBackup(guest.tab.id, { directory: owner.archiveDir });
  assert.equal(rejected.ok, false, "新写入必须拒绝跨故事点 ask");
  const currentBackup = store.createConversationBackup(guest.tab.id);
  assert.equal(currentBackup.ok, true, currentBackup.error);
  const legacyFile = path.join(owner.archiveDir, path.basename(currentBackup.file));
  fs.copyFileSync(currentBackup.file, legacyFile);
  const guestBackup = { file: legacyFile };
  store.deleteTab(owner.tab.id);
  store.deleteTab(guest.tab.id);

  const preview = store.previewClosedStoryDeletion(owner.tab.id);
  assert.equal(preview.ok, true);
  assert.equal(preview.data.archiveDirectory.safeToDelete, false);
  assert.match(preview.data.archiveDirectory.unsafeReason, /其它故事点|跨故事点备份|引用/);
  const removed = store.purgeClosedStory(owner.tab.id, {
    confirmId: owner.tab.id,
    expectedClosedAt: preview.data.story.closedAt,
    deleteConversationBackups: false,
    deleteArchiveDirectory: true,
    deleteAttachments: false,
  });
  assert.equal(removed.ok, false);
  assert.equal(removed.code, "UNSAFE_ARCHIVE_DIRECTORY");
  assert.equal(fs.existsSync(guestBackup.file), true, "其它故事点的备份必须保留");
  assert.equal(store.listClosedTabs().some((item) => item.id === owner.tab.id), true);
  assert.equal(store.listClosedTabs().some((item) => item.id === guest.tab.id), true);
});

test("拒绝向附件目录新建备份，并保护附件目录内的历史 JSON", () => {
  const fixture = seedStory("附件目录备份保护", { close: false });
  const rejectedWrite = store.createConversationBackup(fixture.tab.id, { directory: fixture.currentAttachments });
  assert.equal(rejectedWrite.ok, false, "新写入必须拒绝 archives 目录");
  const currentBackup = store.createConversationBackup(fixture.tab.id);
  assert.equal(currentBackup.ok, true, currentBackup.error);
  const legacyFile = path.join(fixture.currentAttachments, path.basename(currentBackup.file));
  fs.copyFileSync(currentBackup.file, legacyFile);
  fs.rmSync(currentBackup.file, { force: true });
  const attachmentBackup = { file: legacyFile };
  store.deleteTab(fixture.tab.id);

  const preview = store.previewClosedStoryDeletion(fixture.tab.id);
  assert.equal(preview.ok, true);
  assert.equal(preview.data.attachments.safeToDelete, true, preview.data.attachments.unsafeReason);
  assert.equal(preview.data.conversationBackups.coveredByAttachmentDirectoryCount, 1);
  const rejected = store.purgeClosedStory(fixture.tab.id, {
    confirmId: fixture.tab.id,
    expectedClosedAt: preview.data.story.closedAt,
    deleteConversationBackups: false,
    deleteArchiveDirectory: false,
    deleteAttachments: true,
  });
  assert.equal(rejected.ok, false);
  assert.equal(rejected.code, "ATTACHMENT_CONTAINS_CONVERSATION_BACKUP");
  assert.equal(fs.existsSync(attachmentBackup.file), true, "未选择删除备份时附件目录内 JSON 必须保留");
  assert.equal(store.listClosedTabs().some((item) => item.id === fixture.tab.id), true);

  const removed = store.purgeClosedStory(fixture.tab.id, {
    confirmId: fixture.tab.id,
    expectedClosedAt: preview.data.story.closedAt,
    deleteConversationBackups: true,
    deleteArchiveDirectory: false,
    deleteAttachments: true,
  });
  assert.equal(removed.ok, true, removed.error);
  assert.equal(removed.data.conversationBackups.coveredByAttachmentDirectoryCount, 1);
  assert.equal(fs.existsSync(attachmentBackup.file), false);
  assert.equal(fs.existsSync(fixture.archiveFile), true, "未选择 TXT 时 TXT 文件仍须保留");
});

test("深层附件目录内的 JSON 对话备份也必须被发现并受备份选项保护", () => {
  const fixture = seedStory("深层附件备份保护");
  const deepDirectory = path.join(fixture.currentAttachments, ...Array.from({ length: 12 }, (_, index) => `level-${index + 1}`));
  fs.mkdirSync(deepDirectory, { recursive: true });
  const deepBackup = path.join(deepDirectory, "deep.devbench-chat.json");
  fs.copyFileSync(fixture.backupFile, deepBackup);

  const preview = store.previewClosedStoryDeletion(fixture.tab.id);
  assert.equal(preview.ok, true, preview.error);
  assert.equal(preview.data.conversationBackups.files.some((item) => item.path === deepBackup), true, "不能用固定目录深度漏掉有效备份");
  assert.ok(preview.data.conversationBackups.coveredByAttachmentDirectoryCount >= 1);
  const rejected = store.purgeClosedStory(fixture.tab.id, {
    confirmId: fixture.tab.id,
    expectedClosedAt: preview.data.story.closedAt,
    deleteConversationBackups: false,
    deleteAttachments: true,
  });
  assert.equal(rejected.ok, false);
  assert.equal(rejected.code, "ATTACHMENT_CONTAINS_CONVERSATION_BACKUP");
  assert.equal(fs.existsSync(deepBackup), true);
  assert.equal(store.listClosedTabs().some((item) => item.id === fixture.tab.id), true);

  const removed = store.purgeClosedStory(fixture.tab.id, {
    confirmId: fixture.tab.id,
    expectedClosedAt: preview.data.story.closedAt,
    deleteConversationBackups: true,
    deleteAttachments: true,
  });
  assert.equal(removed.ok, true, removed.error);
  assert.equal(fs.existsSync(deepBackup), false);
});

test("被篡改的 docSlug 不能把 TXT 或附件递归删除目标带出 docs/story 安全根", () => {
  sequence += 1;
  const repo = fs.mkdtempSync(path.join(tmp, "traversal-project-"));
  const projectId = `traversal-project-${sequence}`;
  assert.equal(store.upsertProject({ id: projectId, name: "路径越界保护", path: repo }).ok, true);
  let tab = store.createTab({ title: `路径越界保护-${sequence}` });
  tab = store.updateTab(tab.id, { primaryProjectId: projectId, docSlug: path.join("..", "..", "escape-target") });
  store.appendMessage(tab.id, { role: "user", content: "不能误删", turn: 1 });
  store.deleteTab(tab.id);
  const preview = store.previewClosedStoryDeletion(tab.id);
  assert.equal(preview.data.archiveDirectory.safeToDelete, false);
  assert.match(preview.data.archiveDirectory.unsafeReason, /安全根目录|单级安全目录名|存储根目录|路径/);
  assert.equal(preview.data.attachments.safeToDelete, false);
  const removed = store.purgeClosedStory(tab.id, {
    confirmId: tab.id,
    expectedClosedAt: preview.data.story.closedAt,
    deleteArchiveDirectory: true,
  });
  assert.equal(removed.ok, false);
  assert.equal(removed.code, "UNSAFE_ARCHIVE_DIRECTORY");
  assert.equal(store.listClosedTabs().some((item) => item.id === tab.id), true);
});

test("异常故事点 ID 不能参与 msg/live 文件路径删除", () => {
  const original = store.createTab({ title: `异常 ID-${Date.now()}` });
  const badId = path.join("..", `outside-${Date.now()}`);
  const changed = store.updateTab(original.id, { id: badId });
  assert.equal(changed.id, badId);
  assert.equal(store.deleteTab(badId).closed, true);
  const preview = store.previewClosedStoryDeletion(badId);
  assert.equal(preview.ok, false);
  assert.equal(preview.code, "INVALID_STORY_ID");
  const removed = store.purgeClosedStory(badId, { confirmId: badId, expectedClosedAt: Date.now() });
  assert.equal(removed.ok, false);
  assert.equal(removed.code, "INVALID_STORY_ID");
});

test("Windows 文件名非法字符的故事点 ID 必须拒绝删除，不能成功后遗留原聊天", () => {
  for (const badCharacter of [":", "*", "?", "<", ">", "|"]) {
    const original = store.createTab({ title: `Windows 非法 ID-${badCharacter}-${Date.now()}` });
    store.appendMessage(original.id, { role: "user", content: "必须保留的聊天", turn: 1 });
    store.saveLiveDraft(original.id, { taskId: `draft-${original.id}`, text: "必须保留的草稿", streaming: false });
    const originalMessageFile = path.join(process.env.DEVBENCH_STORE_DIR, `msg-${original.id}.json`);
    const originalDraftFile = path.join(process.env.DEVBENCH_STORE_DIR, `live-${original.id}.json`);
    const badId = `bad${badCharacter}name-${Date.now()}-${Math.random()}`;
    assert.equal(store.updateTab(original.id, { id: badId }).id, badId);
    assert.equal(store.deleteTab(badId).closed, true);

    const preview = store.previewClosedStoryDeletion(badId);
    assert.equal(preview.ok, false, badCharacter);
    assert.equal(preview.code, "INVALID_STORY_ID");
    const removed = store.purgeClosedStory(badId, { confirmId: badId, expectedClosedAt: Date.now() });
    assert.equal(removed.ok, false, badCharacter);
    assert.equal(removed.code, "INVALID_STORY_ID");
    assert.equal(fs.existsSync(originalMessageFile), true, `字符 ${badCharacter} 不能造成原聊天孤儿化`);
    assert.equal(fs.existsSync(originalDraftFile), true, `字符 ${badCharacter} 不能造成原草稿孤儿化`);
  }
});

test("会折叠目录层级的 docSlug 一律不能形成递归删除目标", () => {
  for (const badSlug of ["victim/..", ".", "a/../b"]) {
    sequence += 1;
    const repo = fs.mkdtempSync(path.join(tmp, `folded-slug-${sequence}-`));
    const projectId = `folded-slug-project-${sequence}`;
    assert.equal(store.upsertProject({ id: projectId, name: badSlug, path: repo }).ok, true);
    let tab = store.createTab({ title: `折叠路径-${sequence}` });
    tab = store.updateTab(tab.id, { primaryProjectId: projectId, docSlug: badSlug });
    const foldedAsk = path.resolve(repo, "docs", "story", badSlug, "ask");
    const foldedAttachment = path.resolve(repo, "docs", "story", badSlug, "archives");
    const foldedLegacy = path.resolve(repo, "docs", badSlug, "archives");
    for (const directory of [foldedAsk, foldedAttachment, foldedLegacy]) {
      fs.mkdirSync(directory, { recursive: true });
      fs.writeFileSync(path.join(directory, "sentinel.txt"), badSlug, "utf8");
    }
    store.appendMessage(tab.id, { role: "user", content: "折叠路径不能误删", turn: 1 });
    store.deleteTab(tab.id);
    const preview = store.previewClosedStoryDeletion(tab.id);
    assert.equal(preview.ok, true);
    assert.equal(preview.data.archiveDirectory.safeToDelete, false, badSlug);
    assert.equal(preview.data.attachments.safeToDelete, false, badSlug);
    assert.match(`${preview.data.archiveDirectory.unsafeReason} ${preview.data.attachments.unsafeReason}`, /单级安全目录名|存储根目录|路径/);
    const rejectedArchive = store.purgeClosedStory(tab.id, {
      confirmId: tab.id,
      expectedClosedAt: preview.data.story.closedAt,
      deleteArchiveDirectory: true,
    });
    assert.equal(rejectedArchive.ok, false);
    assert.equal(rejectedArchive.code, "UNSAFE_ARCHIVE_DIRECTORY");
    const rejectedAttachments = store.purgeClosedStory(tab.id, {
      confirmId: tab.id,
      expectedClosedAt: preview.data.story.closedAt,
      deleteAttachments: true,
    });
    assert.equal(rejectedAttachments.ok, false);
    assert.equal(rejectedAttachments.code, "UNSAFE_ATTACHMENT_DIRECTORY");
    for (const directory of [foldedAsk, foldedAttachment, foldedLegacy]) {
      assert.equal(fs.existsSync(path.join(directory, "sentinel.txt")), true, `${badSlug} 不能删除折叠后的无关目录`);
    }
  }
});

test("两个故事点共享异常 sessionId 时拒绝连带删除另一故事点执行历史", () => {
  const first = store.createTab({ title: `共享执行会话甲-${Date.now()}` });
  let second = store.createTab({ title: `共享执行会话乙-${Date.now()}` });
  second = store.updateTab(second.id, { sessionId: first.sessionId });
  store.deleteTab(first.id);
  store.deleteTab(second.id);
  const preview = store.previewClosedStoryDeletion(first.id);
  assert.equal(preview.ok, true);
  assert.equal(preview.data.core.executionHistory.safeToDelete, false);
  assert.equal(preview.data.core.executionHistory.sharedBy.some((item) => item.id === second.id), true);
  const removed = store.purgeClosedStory(first.id, {
    confirmId: first.id,
    expectedClosedAt: preview.data.story.closedAt,
  });
  assert.equal(removed.ok, false);
  assert.equal(removed.code, "SHARED_EXECUTION_SESSION");
  assert.notEqual(removed.partial, true, "共享会话预检拒绝不能标记为部分删除");
  assert.equal(store.listClosedTabs().some((item) => item.id === first.id), true);
  assert.equal(store.listClosedTabs().some((item) => item.id === second.id), true);
});

test("旧关闭快照缺少 sessionId 时仍按 dev_<故事点ID> 清理 SQLite 执行历史", () => {
  const fixture = seedStory("旧会话 ID 兼容");
  const closedRows = store.listClosedTabs().map((item) => {
    if (item.id !== fixture.tab.id) return item;
    const legacy = { ...item };
    delete legacy.sessionId;
    return legacy;
  });
  db.setUserData(store.storageUserKey("closed"), "closed", closedRows, "legacy-session-fixture");
  const preview = store.previewClosedStoryDeletion(fixture.tab.id);
  assert.equal(preview.ok, true, preview.error);
  assert.equal(preview.data.core.executionHistory.sessionId, `dev_${fixture.tab.id}`);
  const removed = store.purgeClosedStory(fixture.tab.id, {
    confirmId: fixture.tab.id,
    expectedClosedAt: preview.data.story.closedAt,
  });
  assert.equal(removed.ok, true, removed.error);
  assert.equal(db.getTask(fixture.executionTaskId), undefined, "旧快照的任务历史不能遗留");
});

test("物理删除关闭组中的单个故事点不会连带删除同组其它成员", () => {
  const anchor = store.createTab({ title: `关闭组锚点-${Date.now()}` });
  const member = store.createTab({ title: `关闭组成员-${Date.now()}` });
  const joined = store.joinGroup(member.id, anchor.id);
  assert.equal(joined.ok, true, joined.error);
  const groupId = store.getTab(anchor.id).groupId;
  const closedGroup = store.closeGroup(groupId);
  assert.equal(closedGroup.ok, true, closedGroup.error);
  const preview = store.previewClosedStoryDeletion(anchor.id);
  const staleGroupSnapshot = store.listClosedTabs().filter((item) => item.groupId === groupId).map((item) => ({ ...item }));
  const begun = store.beginClosedStoryDeletion(anchor.id, preview.data.story.closedAt);
  assert.equal(begun.ok, true, begun.error);
  const blockedReopen = store.reopenClosed(member.id, { force: true });
  assert.equal(blockedReopen.ok, false);
  assert.equal(blockedReopen.code, "DELETE_IN_PROGRESS", "组内任一成员删除中时不能并发恢复整组");
  store.releaseClosedStoryDeletion(anchor.id);
  const removed = store.purgeClosedStory(anchor.id, {
    confirmId: anchor.id,
    expectedClosedAt: preview.data.story.closedAt,
  });
  assert.equal(removed.ok, true, removed.error);
  assert.equal(store.listClosedTabs().some((item) => item.id === anchor.id), false);
  const remaining = store.listClosedTabs().find((item) => item.id === member.id);
  assert.ok(remaining, "同组未点选成员必须继续保留在关闭列表");
  assert.equal(remaining.groupId, groupId);

  // 模拟另一个 Gateway 在删除成功后迟到写回旧的整组 closed 快照。
  db.setUserData(store.storageUserKey("closed"), "closed", staleGroupSnapshot, "stale-group-gateway");
  assert.equal(store.listClosedTabs().some((item) => item.id === anchor.id), false, "永久 marker 必须隐藏迟到写回的已删成员");
  const reopenedMember = store.reopenClosed(member.id, { force: true });
  assert.equal(reopenedMember.ok, true, reopenedMember.error);
  assert.equal(reopenedMember.restored, 1, "恢复保留成员时不能把永久删除成员带回活动列表");
  assert.ok(store.getTab(member.id));
  assert.equal(store.getTab(anchor.id), null, "永久删除成员不能从组快照复活");
});

test("关闭后 cloneParent 改变时仍只删除关闭时冻结的 StoryDev 资料", () => {
  sequence += 1;
  const oldCloneParent = path.join(tmp, `frozen-old-clones-${sequence}`);
  const newCloneParent = path.join(tmp, `frozen-new-clones-${sequence}`);
  store.updateRemoteConfig({ cloneParent: oldCloneParent });
  const repo = fs.mkdtempSync(path.join(tmp, "frozen-repo-"));
  const projectId = `frozen-project-${sequence}`;
  const docSlug = `frozen-story-${sequence}`;
  assert.equal(store.upsertProject({ id: projectId, name: "冻结路径工程", path: repo }).ok, true);
  let tab = store.createTab({ title: `冻结路径故事点-${sequence}` });
  tab = store.updateTab(tab.id, { primaryProjectId: projectId, docSlug });
  store.appendMessage(tab.id, { role: "user", content: "冻结关闭时路径", turn: 1 });
  const frozenStorage = store.getStoryStoragePaths(store.getTab(tab.id), { create: true });
  const oldAsk = frozenStorage.archiveDirectory;
  const oldAttachments = frozenStorage.attachmentDirectory;
  fs.mkdirSync(oldAsk, { recursive: true });
  fs.mkdirSync(oldAttachments, { recursive: true });
  fs.writeFileSync(path.join(oldAsk, `${docSlug}.txt`), "old txt", "utf8");
  fs.writeFileSync(path.join(oldAttachments, "old.txt"), "old attachment", "utf8");
  store.deleteTab(tab.id);

  store.updateRemoteConfig({ cloneParent: newCloneParent });
  const newStoryDirectory = path.join(newCloneParent, "AllDocs", "StoryDev", docSlug);
  const newAsk = path.join(newStoryDirectory, "ask");
  const newAttachments = path.join(newStoryDirectory, "archives");
  fs.mkdirSync(newAsk, { recursive: true });
  fs.mkdirSync(newAttachments, { recursive: true });
  const newTxt = path.join(newAsk, "unrelated.txt");
  const newAttachment = path.join(newAttachments, "unrelated.txt");
  fs.writeFileSync(newTxt, "new unrelated txt", "utf8");
  fs.writeFileSync(newAttachment, "new unrelated attachment", "utf8");

  const preview = store.previewClosedStoryDeletion(tab.id);
  assert.equal(preview.ok, true);
  assert.equal(preview.data.archiveDirectory.path, oldAsk);
  assert.equal(preview.data.attachments.paths.some((item) => item.path === oldAttachments), true);
  assert.equal(preview.data.attachments.paths.some((item) => item.path === newAttachments), false);
  const removed = store.purgeClosedStory(tab.id, {
    confirmId: tab.id,
    expectedClosedAt: preview.data.story.closedAt,
    deleteArchiveDirectory: true,
    deleteAttachments: true,
  });
  assert.equal(removed.ok, true, removed.error);
  assert.equal(fs.existsSync(oldAsk), false);
  assert.equal(fs.existsSync(oldAttachments), false);
  assert.equal(fs.existsSync(newTxt), true, "新 cloneParent 中同 slug 的无关 TXT 不能删除");
  assert.equal(fs.existsSync(newAttachment), true, "新 cloneParent 中同 slug 的无关附件不能删除");
});

test("关闭后的 StoryDev 物理根被另一目录替换时禁止删除新目录中的同名资料", () => {
  const fixture = seedStory("工程路径身份替换");
  const storyDevRoot = store.listClosedTabs().find((item) => item.id === fixture.tab.id)
    .closedStorageSnapshot.storyDevRoot;
  const movedStoryDevRoot = `${storyDevRoot}-original`;
  fs.renameSync(storyDevRoot, movedStoryDevRoot);
  try {
    fs.mkdirSync(fixture.currentAttachments, { recursive: true });
    fs.mkdirSync(fixture.archiveDir, { recursive: true });
    const replacementAttachment = path.join(fixture.currentAttachments, "replacement.txt");
    const replacementArchive = path.join(fixture.archiveDir, "replacement.txt");
    fs.writeFileSync(replacementAttachment, "new owner", "utf8");
    fs.writeFileSync(replacementArchive, "new owner", "utf8");

    const preview = store.previewClosedStoryDeletion(fixture.tab.id);
    assert.equal(preview.ok, true, preview.error);
    assert.equal(preview.data.archiveDirectory.safeToDelete, false);
    assert.equal(preview.data.attachments.safeToDelete, false);
    assert.match(`${preview.data.archiveDirectory.unsafeReason} ${preview.data.attachments.unsafeReason}`, /身份已变化|真实路径/);
    const rejected = store.purgeClosedStory(fixture.tab.id, {
      confirmId: fixture.tab.id,
      expectedClosedAt: preview.data.story.closedAt,
      deleteArchiveDirectory: true,
      deleteAttachments: true,
    });
    assert.equal(rejected.ok, false);
    assert.equal(rejected.code, "UNSAFE_ARCHIVE_DIRECTORY");
    assert.equal(fs.existsSync(replacementAttachment), true);
    assert.equal(fs.existsSync(replacementArchive), true);
  } finally {
    fs.rmSync(storyDevRoot, { recursive: true, force: true });
    fs.renameSync(movedStoryDevRoot, storyDevRoot);
  }
});

test("closed-only HTTP 接口拒绝活动物理删除、非法范围和过期关闭版本，成功后关闭列表立即消失", async () => {
  const active = seedStory("活动故事点拒绝", { close: false });
  const closed = seedStory("HTTP 永久删除");
  const server = await startTestServer();
  const base = `http://127.0.0.1:${server.address().port}/api/devbench`;
  try {
    const activeResponse = await fetch(`${base}/closed-tabs/${active.tab.id}/purge-preview`);
    assert.equal(activeResponse.status, 409);
    assert.equal((await activeResponse.json()).code, "STORY_NOT_CLOSED");

    const legacyActivePurge = await fetch(`${base}/tabs/${active.tab.id}?purge=1`, { method: "DELETE" });
    assert.equal(legacyActivePurge.status, 409);
    assert.equal((await legacyActivePurge.json()).code, "PURGE_CLOSED_ONLY");
    assert.ok(store.getTab(active.tab.id));
    assert.equal(fs.existsSync(path.join(process.env.DEVBENCH_STORE_DIR, `msg-${active.tab.id}.json`)), true);
    assert.equal(fs.existsSync(path.join(process.env.DEVBENCH_STORE_DIR, `live-${active.tab.id}.json`)), true);
    const directActivePurge = store.deleteTab(active.tab.id, { purge: true });
    assert.equal(directActivePurge.ok, false);
    assert.equal(directActivePurge.code, "PURGE_CLOSED_ONLY");
    assert.ok(store.getTab(active.tab.id));

    const groupAnchor = store.createTab({ title: `活动组锚点-${Date.now()}` });
    const groupMember = store.createTab({ title: `活动组成员-${Date.now()}` });
    assert.equal(store.joinGroup(groupMember.id, groupAnchor.id).ok, true);
    const activeGroupId = store.getTab(groupAnchor.id).groupId;
    store.appendMessage(groupAnchor.id, { role: "user", content: "组消息", turn: 1 });
    store.saveLiveDraft(groupMember.id, { taskId: "group-live", text: "组草稿" });
    const legacyGroupPurge = await fetch(`${base}/groups/${activeGroupId}?purge=1`, { method: "DELETE" });
    assert.equal(legacyGroupPurge.status, 409);
    assert.equal((await legacyGroupPurge.json()).code, "PURGE_CLOSED_ONLY");
    assert.ok(store.getTab(groupAnchor.id));
    assert.ok(store.getTab(groupMember.id));
    assert.equal(store.closeGroup(activeGroupId, { purge: true }).code, "PURGE_CLOSED_ONLY");
    assert.equal(fs.existsSync(path.join(process.env.DEVBENCH_STORE_DIR, `msg-${groupAnchor.id}.json`)), true);
    assert.equal(fs.existsSync(path.join(process.env.DEVBENCH_STORE_DIR, `live-${groupMember.id}.json`)), true);

    const previewResponse = await fetch(`${base}/closed-tabs/${closed.tab.id}/purge-preview`);
    const preview = await previewResponse.json();
    assert.equal(previewResponse.status, 200);
    assert.equal(preview.ok, true);

    const injectedResponse = await fetch(`${base}/closed-tabs/${closed.tab.id}/purge`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ confirmId: closed.tab.id, archiveDir: tmp }),
    });
    assert.equal(injectedResponse.status, 400);
    assert.equal((await injectedResponse.json()).code, "UNEXPECTED_DELETE_FIELD");

    const missingVersionResponse = await fetch(`${base}/closed-tabs/${closed.tab.id}/purge`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ confirmId: closed.tab.id }),
    });
    assert.equal(missingVersionResponse.status, 400);
    assert.equal((await missingVersionResponse.json()).code, "CLOSED_VERSION_REQUIRED");

    const invalidVersionResponse = await fetch(`${base}/closed-tabs/${closed.tab.id}/purge`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ confirmId: closed.tab.id, expectedClosedAt: String(preview.data.story.closedAt) }),
    });
    assert.equal(invalidVersionResponse.status, 400);
    assert.equal((await invalidVersionResponse.json()).code, "CLOSED_VERSION_REQUIRED");

    const staleResponse = await fetch(`${base}/closed-tabs/${closed.tab.id}/purge`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ confirmId: closed.tab.id, expectedClosedAt: preview.data.story.closedAt + 1 }),
    });
    assert.equal(staleResponse.status, 409);
    assert.equal((await staleResponse.json()).code, "CLOSED_STORY_CHANGED");

    const reopened = store.reopenClosed(closed.tab.id, { force: true });
    assert.equal(reopened.ok, true, reopened.error);
    assert.equal(store.deleteTab(closed.tab.id).closed, true);
    const refreshedPreview = store.previewClosedStoryDeletion(closed.tab.id);
    assert.ok(refreshedPreview.data.story.closedAt > preview.data.story.closedAt, "再次关闭必须生成更高关闭版本");
    const oldConfirmation = await fetch(`${base}/closed-tabs/${closed.tab.id}/purge`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ confirmId: closed.tab.id, expectedClosedAt: preview.data.story.closedAt }),
    });
    assert.equal(oldConfirmation.status, 409);
    assert.equal((await oldConfirmation.json()).code, "CLOSED_STORY_CHANGED");

    const foreignTaskId = `foreign-running-${closed.tab.id}`;
    db.createTask({
      id: foreignTaskId,
      title: "其它 Gateway 运行中的任务",
      description: "不能被永久删除中断",
      type: "general",
      status: "running",
      priority: 3,
      source: "devbench",
      sourceId: refreshedPreview.data.core.executionHistory.sessionId,
    });
    db.updateTask(foreignTaskId, { createdAt: "2000-01-01 00:00:00" });
    const foreignLeaseId = `foreign-lease-${closed.tab.id}`;
    db.upsertTaskRuntimeLease({
      leaseId: foreignLeaseId,
      taskId: foreignTaskId,
      ownerInstance: "foreign-gateway-test",
      ownerPid: process.pid + 1000,
      ttlMs: 60_000,
    });
    for (let index = 0; index < 505; index += 1) {
      const historicalId = `paged-history-${closed.tab.id}-${index}`;
      db.createTask({
        id: historicalId,
        title: `分页历史 ${index}`,
        description: "已完成历史",
        type: "general",
        status: "completed",
        priority: 3,
        source: "devbench",
        sourceId: refreshedPreview.data.core.executionHistory.sessionId,
      });
      db.updateTask(historicalId, { createdAt: "2099-01-01 00:00:00" });
    }
    assert.equal(db.listTasks({ source: "devbench", sourceId: refreshedPreview.data.core.executionHistory.sessionId, limit: 500 }).some((task) => task.id === foreignTaskId), false, "夹具必须把活跃任务压到普通分页之外");
    assert.equal(db.listActiveDevbenchTasks(refreshedPreview.data.core.executionHistory.sessionId).some((task) => task.id === foreignTaskId), true);
    const wrongConfirmation = await fetch(`${base}/closed-tabs/${closed.tab.id}/purge`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ confirmId: "wrong-story-id", expectedClosedAt: refreshedPreview.data.story.closedAt }),
    });
    assert.equal(wrongConfirmation.status, 400);
    assert.equal((await wrongConfirmation.json()).code, "DELETE_CONFIRMATION_MISMATCH");
    assert.equal(db.getTask(foreignTaskId).status, "running", "错误确认不能先中断有效任务");

    const foreignRunningResponse = await fetch(`${base}/closed-tabs/${closed.tab.id}/purge`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ confirmId: closed.tab.id, expectedClosedAt: refreshedPreview.data.story.closedAt }),
    });
    assert.equal(foreignRunningResponse.status, 409);
    assert.equal((await foreignRunningResponse.json()).code, "AI_RUNNING_ON_OTHER_GATEWAY");
    assert.equal(store.listClosedTabs().some((item) => item.id === closed.tab.id), true);
    assert.equal(fs.existsSync(path.join(process.env.DEVBENCH_STORE_DIR, `msg-${closed.tab.id}.json`)), true);
    db.removeTaskRuntimeLease(foreignLeaseId, "foreign-gateway-test");
    db.updateTask(foreignTaskId, { status: "completed" });

    const purgeResponse = await fetch(`${base}/closed-tabs/${closed.tab.id}/purge`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        confirmId: closed.tab.id,
        expectedClosedAt: refreshedPreview.data.story.closedAt,
        deleteConversationBackups: false,
        deleteArchiveDirectory: false,
        deleteAttachments: false,
      }),
    });
    const purged = await purgeResponse.json();
    assert.equal(purgeResponse.status, 200);
    assert.equal(purged.ok, true, purged.error);
    assert.equal(store.listClosedTabs().some((item) => item.id === closed.tab.id), false);

    const staleDraftStory = seedStory("崩溃草稿租约");
    const stalePreview = store.previewClosedStoryDeletion(staleDraftStory.tab.id);
    const staleDraftTaskId = `stale-${staleDraftStory.tab.id}`;
    const staleDraftLeaseId = `stale-draft-lease-${staleDraftStory.tab.id}`;
    store.saveLiveDraft(staleDraftStory.tab.id, { taskId: staleDraftTaskId, text: "崩溃遗留草稿", streaming: true });
    db.upsertTaskRuntimeLease({
      leaseId: staleDraftLeaseId,
      taskId: staleDraftTaskId,
      ownerInstance: "foreign-draft-gateway-test",
      ownerPid: process.pid + 1001,
      ttlMs: 60_000,
    });
    const freshLeaseResponse = await fetch(`${base}/closed-tabs/${staleDraftStory.tab.id}/purge`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ confirmId: staleDraftStory.tab.id, expectedClosedAt: stalePreview.data.story.closedAt }),
    });
    assert.equal(freshLeaseResponse.status, 409);
    assert.equal((await freshLeaseResponse.json()).code, "AI_RUNNING_ON_OTHER_GATEWAY");
    db.removeTaskRuntimeLease(staleDraftLeaseId, "foreign-draft-gateway-test");
    const expiredLeaseResponse = await fetch(`${base}/closed-tabs/${staleDraftStory.tab.id}/purge`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ confirmId: staleDraftStory.tab.id, expectedClosedAt: stalePreview.data.story.closedAt }),
    });
    const expiredLeaseResult = await expiredLeaseResponse.json();
    assert.equal(expiredLeaseResponse.status, 200);
    assert.equal(expiredLeaseResult.ok, true, expiredLeaseResult.error);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
