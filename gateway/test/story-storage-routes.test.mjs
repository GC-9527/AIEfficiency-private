import { after, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "story-storage-routes-"));
process.env.GATEWAY_DB_PATH = path.join(tmp, "data.db");
process.env.GATEWAY_CONFIG_PATH = path.join(tmp, "gateway.json");
process.env.DEVBENCH_CONFIG_PATH = path.join(tmp, "market.json");
process.env.DEVBENCH_LOCAL_PROJECTS_PATH = path.join(tmp, "local-projects.json");
process.env.DEVBENCH_STORE_DIR = path.join(tmp, "store");
process.env.AIEFFICIENCY_CLONE_PARENT = path.join(tmp, "clone-parent");
fs.writeFileSync(process.env.GATEWAY_CONFIG_PATH, JSON.stringify({ servers: { nodeId: "story-storage-routes-test" } }));

const express = (await import("express")).default;
const store = await import("../services/devbench/store.js");
const router = (await import("../routes/devbench.js")).default;
const { issueToken, revokeToken } = await import("../services/admin-auth.js");
const { prepareVerifyAssets } = await import("../services/devbench/verify-runner.js");
const {
  inspectStoryArtifactTicket,
  storyArtifactSnapshotStore,
} = await import("../services/devbench/artifact-ticket.js");

const repo = fs.mkdtempSync(path.join(tmp, "repo-"));
assert.equal(store.upsertProject({ id: "story-storage-project", name: "StoryStorage", path: repo }).ok, true);
let tab = store.createTab({ title: "#CARB-200# 外部资料目录" });
tab = store.updateTab(tab.id, {
  primaryProjectId: "story-storage-project",
  worktree: {
    version: 1,
    managed: true,
    root: repo,
    entries: [{
      role: "primary",
      baseProjectId: "story-storage-project",
      name: "StoryStorage",
      basePath: repo,
      path: repo,
    }],
  },
});
const storage = store.getStoryStoragePaths(tab, { create: true });

const token = issueToken({ id: "story-storage-admin", username: "test", role: "admin" });
const adminHeaders = { Authorization: `Bearer ${token}` };
const issuedSnapshots = new Map();
const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  req.headers.authorization ||= adminHeaders.Authorization;
  next();
});
app.use("/api/devbench", router);
const server = await new Promise((resolve) => {
  const instance = app.listen(0, "127.0.0.1", () => resolve(instance));
});
const base = `http://127.0.0.1:${server.address().port}/api/devbench`;

async function ticketedArtifactUrl(ref, { download = false } = {}) {
  const response = await fetch(`${base}/tabs/${tab.id}/artifact-tickets`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ items: [{ ref, download }] }),
  });
  const body = await response.json();
  assert.equal(response.status, 200, body.error);
  const ticket = body.data?.items?.[0]?.ticket;
  assert.ok(ticket, JSON.stringify(body));
  const inspected = inspectStoryArtifactTicket(ticket, {
    tabId: tab.id,
    ref,
    download,
    method: "GET",
  });
  issuedSnapshots.set(inspected.snapshot.id, {
    id: inspected.snapshot.id,
    expiresAt: inspected.expiresAt,
  });
  const query = new URLSearchParams({ ref, ticket });
  if (download) query.set("download", "1");
  return `${base}/tabs/${tab.id}/artifact?${query}`;
}

after(async () => {
  revokeToken(token);
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  for (const snapshot of issuedSnapshots.values()) {
    try { await storyArtifactSnapshotStore.deleteSnapshot(snapshot); } catch {}
  }
});

test("拖拽材料和材料索引都落在外部 StoryDev archives，且拒绝跨故事点路径", async () => {
  const payload = Buffer.from("story attachment");
  const uploadedResponse = await fetch(
    `${base}/tabs/${tab.id}/upload?filename=${encodeURIComponent("logs/input.txt")}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream" },
      body: payload,
    },
  );
  const uploaded = await uploadedResponse.json();
  assert.equal(uploadedResponse.status, 200, uploaded.error);
  assert.equal(uploaded.ok, true, uploaded.error);
  assert.equal(uploaded.data.relPath, "storydev:/archives/logs/input.txt");
  assert.equal(uploaded.data.path, path.join(storage.attachmentDirectory, "logs", "input.txt"));
  assert.equal(fs.readFileSync(uploaded.data.path, "utf8"), "story attachment");
  assert.equal(fs.existsSync(path.join(repo, "docs", "story")), false, "上传不得污染源码工程");

  const materialResponse = await fetch(`${base}/tabs/${tab.id}/material`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ relPath: uploaded.data.relPath, name: "input.txt", fileCount: 0 }),
  });
  const material = await materialResponse.json();
  assert.equal(materialResponse.status, 200, material.error);
  assert.equal(material.ok, true, material.error);
  assert.equal(store.getTab(tab.id).materials[0].path, uploaded.data.path);

  const escapedResponse = await fetch(`${base}/tabs/${tab.id}/material`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ relPath: "storydev:/../other-story/secret.txt", name: "secret.txt" }),
  });
  assert.equal(escapedResponse.status, 400);
});

test("故事点附件接口完整接收并落盘 34MiB 文件", async () => {
  const payload = Buffer.alloc(34 * 1024 * 1024, 0x5a);
  let uploadedPath = "";
  try {
    const response = await fetch(
      `${base}/tabs/${tab.id}/upload?filename=${encodeURIComponent("large/attachment-34m.bin")}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream" },
        body: payload,
      },
    );
    const result = await response.json();
    assert.equal(response.status, 200, result.error);
    assert.equal(result.ok, true, result.error);
    assert.equal(result.data.size, payload.length);
    uploadedPath = result.data.path;
    const stat = fs.statSync(uploadedPath);
    assert.equal(stat.size, payload.length);
    const descriptor = fs.openSync(uploadedPath, "r");
    try {
      const first = Buffer.alloc(1);
      const last = Buffer.alloc(1);
      fs.readSync(descriptor, first, 0, 1, 0);
      fs.readSync(descriptor, last, 0, 1, payload.length - 1);
      assert.equal(first[0], 0x5a);
      assert.equal(last[0], 0x5a);
    } finally {
      fs.closeSync(descriptor);
    }
  } finally {
    if (uploadedPath && fs.existsSync(uploadedPath)) fs.unlinkSync(uploadedPath);
  }
});

test("故事点产物路由只打开当前 storydev 文件，并支持媒体 Range 与安全下载", async () => {
  const imageName = "代码评审摘要.png";
  const imagePath = path.join(storage.reportsDirectory, imageName);
  fs.writeFileSync(imagePath, Buffer.from("fake-png"));
  const imageRef = `storydev:/reports/${imageName}`;
  const imageResponse = await fetch(await ticketedArtifactUrl(imageRef));
  assert.equal(imageResponse.status, 200);
  assert.equal(imageResponse.headers.get("content-type"), "image/png");
  assert.match(imageResponse.headers.get("content-disposition") || "", /^inline;/);
  assert.match(imageResponse.headers.get("content-disposition") || "", /filename\*=UTF-8''/);
  assert.equal(imageResponse.headers.get("x-content-type-options"), "nosniff");
  assert.equal(imageResponse.headers.get("cross-origin-resource-policy"), "cross-origin");
  assert.equal(Buffer.from(await imageResponse.arrayBuffer()).toString(), "fake-png");

  const logPath = path.join(storage.reportsDirectory, "analysis.log");
  fs.writeFileSync(logPath, "line one\nline two");
  const logResponse = await fetch(await ticketedArtifactUrl("storydev:/reports/analysis.log"));
  assert.equal(logResponse.status, 200);
  assert.match(logResponse.headers.get("content-type") || "", /^text\/plain/);
  assert.match(logResponse.headers.get("content-disposition") || "", /^inline;/);

  const videoPath = path.join(storage.reportsDirectory, "review.webm");
  fs.writeFileSync(videoPath, Buffer.from("0123456789"));
  const videoResponse = await fetch(
    await ticketedArtifactUrl("storydev:/reports/review.webm"),
    { headers: { Range: "bytes=2-5" } },
  );
  assert.equal(videoResponse.status, 206);
  assert.equal(videoResponse.headers.get("content-range"), "bytes 2-5/10");
  assert.equal(Buffer.from(await videoResponse.arrayBuffer()).toString(), "2345");

  const htmlPath = path.join(storage.reportsDirectory, "review.html");
  fs.writeFileSync(htmlPath, "<script>alert(1)</script>");
  const htmlResponse = await fetch(await ticketedArtifactUrl("storydev:/reports/review.html"));
  assert.equal(htmlResponse.status, 200);
  assert.equal(htmlResponse.headers.get("content-type"), "application/octet-stream");
  assert.match(htmlResponse.headers.get("content-disposition") || "", /^attachment;/);

  const forcedDownload = await fetch(await ticketedArtifactUrl(imageRef, { download: true }));
  assert.equal(forcedDownload.status, 200);
  assert.match(forcedDownload.headers.get("content-disposition") || "", /^attachment;/);

  const localPathResponse = await fetch(`${base}/tabs/${tab.id}/artifact-tickets`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ items: [{ ref: "file:///C:/secret.txt", download: false }] }),
  });
  assert.equal(localPathResponse.status, 400);
  const escapedResponse = await fetch(`${base}/tabs/${tab.id}/artifact-tickets`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      items: [{ ref: "storydev:/../other-story/secret.txt", download: false }],
    }),
  });
  assert.equal(escapedResponse.status, 400);
});

test("故事点录屏和系统生成的验收脚本分别落到 tempFiles 与 reports", async () => {
  const recordingResponse = await fetch(
    `${base}/devmode/recording?tabId=${encodeURIComponent(tab.id)}&filename=case.webm`,
    {
      method: "POST",
      headers: { "Content-Type": "video/webm", ...adminHeaders },
      body: Buffer.from("fake-video"),
    },
  );
  const recording = await recordingResponse.json();
  assert.equal(recordingResponse.status, 200, recording.error);
  assert.equal(recording.ok, true, recording.error);
  assert.equal(recording.data.relPath, "storydev:/tempFiles/devtool-recordings/case.webm");
  assert.equal(recording.data.path, path.join(storage.tempDirectory, "devtool-recordings", "case.webm"));
  assert.equal(fs.readFileSync(recording.data.path, "utf8"), "fake-video");

  const assets = prepareVerifyAssets(store.getTab(tab.id));
  assert.equal(assets.ok, true);
  assert.equal(assets.reportsAbs, storage.reportsDirectory);
  assert.equal(assets.reportsRel, "storydev:/reports");
  assert.equal(assets.recorderAbs, path.join(storage.reportsDirectory, "_devbench-record.mjs"));
  assert.equal(fs.existsSync(assets.recorderAbs), true);
  assert.equal(fs.existsSync(path.join(repo, "docs", "tempFiles")), false, "生成脚本不得写回源码工程");

  const sourceRecorder = fileURLToPath(new URL("../services/devbench/verify-record.mjs", import.meta.url));
  const directTemplateRun = spawnSync(process.execPath, [
    sourceRecorder,
    "--", process.execPath, "-e", "process.exit(0)",
  ], { encoding: "utf8" });
  assert.equal(directTemplateRun.status, 2);
  assert.match(directTemplateRun.stderr, /只能从外置 AllDocs\/StoryDev/);
  assert.equal(
    fs.existsSync(fileURLToPath(new URL("../services/devbench/videos", import.meta.url))),
    false,
    "源码模板直接运行不得创建证据目录",
  );

  const unsafeReports = path.join(repo, "docs", "tempFiles", "verify-reports");
  const recorderRun = spawnSync(process.execPath, [
    assets.recorderAbs,
    "--dir", unsafeReports,
    "--", process.execPath, "-e", "process.exit(0)",
  ], { encoding: "utf8" });
  assert.equal(recorderRun.status, 2);
  assert.match(recorderRun.stderr, /外置 reports 目录/);
  assert.equal(fs.existsSync(unsafeReports), false, "录屏包装器不得接受源码树输出目录");

  const buriedPointCli = fileURLToPath(new URL("../services/devbench/run-buried-point.mjs", import.meta.url));
  const unsafeBuriedPoint = path.join(repo, "docs", "tempFiles", "buried-point.json");
  const buriedPointRun = spawnSync(process.execPath, [
    buriedPointCli,
    "--env", "missing-test-env",
    "--query", "SELECT 1",
    "--tab", tab.id,
    "--out", unsafeBuriedPoint,
  ], { encoding: "utf8", env: { ...process.env } });
  assert.equal(buriedPointRun.status, 2);
  assert.match(buriedPointRun.stderr, /外置 reports 目录/);
  assert.equal(fs.existsSync(unsafeBuriedPoint), false, "埋点证据 CLI 不得写回源码工程");
});

test("无故事点录屏使用系统临时目录，过期 tabId 不得回退写入请求中的源码路径", async () => {
  const filename = `global-${Date.now()}.webm`;
  const globalResponse = await fetch(
    `${base}/devmode/recording?root=${encodeURIComponent(repo)}&filename=${encodeURIComponent(filename)}`,
    {
      method: "POST",
      headers: { "Content-Type": "video/webm", ...adminHeaders },
      body: Buffer.from("global-video"),
    },
  );
  const globalBody = await globalResponse.json();
  assert.equal(globalResponse.status, 200, globalBody.error);
  assert.equal(globalBody.ok, true, globalBody.error);
  assert.equal(path.resolve(globalBody.data.path).startsWith(path.resolve(repo) + path.sep), false);
  assert.equal(fs.readFileSync(globalBody.data.path, "utf8"), "global-video");
  fs.rmSync(globalBody.data.path, { force: true });

  const staleTarget = path.join(repo, "docs", "tempFiles", "devtool-recordings");
  const staleResponse = await fetch(
    `${base}/devmode/recording?root=${encodeURIComponent(repo)}&tabId=missing-story&filename=stale.webm`,
    {
      method: "POST",
      headers: { "Content-Type": "video/webm", ...adminHeaders },
      body: Buffer.from("must-not-write"),
    },
  );
  const staleBody = await staleResponse.json();
  assert.equal(staleResponse.status, 400);
  assert.equal(staleBody.ok, false);
  assert.match(staleBody.error, /拒绝回退到源码工程目录/);
  assert.equal(fs.existsSync(staleTarget), false);
});

test("克隆父路径必须是绝对路径，配置 API 返回明确的 400 错误", async () => {
  const original = store.getRemoteConfig().cloneParent;
  const response = await fetch(`${base}/remote-config`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ cloneParent: "relative/story-root" }),
  });
  const body = await response.json();

  assert.equal(response.status, 400);
  assert.equal(body.ok, false);
  assert.equal(body.code, "STORY_STORAGE_CLONE_PARENT_INVALID");
  assert.match(body.error, /克隆父路径必须是绝对路径/);
  assert.equal(store.getRemoteConfig().cloneParent, original, "非法配置不得覆盖原值");
});

test("克隆父路径与源码或服务仓库重叠时在 mkdir 前拒绝", async () => {
  const original = store.getRemoteConfig().cloneParent;
  for (const unsafeParent of [repo, fileURLToPath(new URL("../..", import.meta.url))]) {
    const unsafeStoryRoot = path.join(unsafeParent, "AllDocs", "StoryDev");
    const existedBefore = fs.existsSync(unsafeStoryRoot);
    const response = await fetch(`${base}/remote-config`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cloneParent: unsafeParent }),
    });
    const body = await response.json();
    assert.equal(response.status, 400);
    assert.equal(body.ok, false);
    assert.equal(body.code, "STORY_STORAGE_SOURCE_OVERLAP");
    assert.equal(fs.existsSync(unsafeStoryRoot), existedBefore, "拒绝前不得在源码仓库创建 AllDocs/StoryDev");
  }
  assert.equal(store.getRemoteConfig().cloneParent, original);
});

test("历史非法克隆父路径使列表返回 400，但不会让 Gateway 进程退出", async () => {
  const localConfigPath = process.env.DEVBENCH_LOCAL_PROJECTS_PATH;
  const originalConfig = fs.readFileSync(localConfigPath, "utf8");
  const invalidConfig = JSON.parse(originalConfig);
  invalidConfig.cloneParent = repo;
  const invalidTab = store.createTab({ title: "历史非法克隆父路径" });
  store.updateTab(invalidTab.id, { storyStorageRoot: "" });
  const unsafeStoryRoot = path.join(repo, "AllDocs", "StoryDev");
  const existedBefore = fs.existsSync(unsafeStoryRoot);

  try {
    fs.writeFileSync(localConfigPath, `${JSON.stringify(invalidConfig, null, 2)}\n`, "utf8");
    const invalidResponse = await fetch(`${base}/tabs`);
    const invalidBody = await invalidResponse.json();
    assert.equal(invalidResponse.status, 400);
    assert.equal(invalidBody.ok, false);
    assert.equal(invalidBody.code, "STORY_STORAGE_SOURCE_OVERLAP");
    assert.equal(fs.existsSync(unsafeStoryRoot), existedBefore, "历史非法配置不得先在源码仓库创建 StoryDev");

    fs.writeFileSync(localConfigPath, originalConfig, "utf8");
    const recoveredResponse = await fetch(`${base}/tabs`);
    const recoveredBody = await recoveredResponse.json();
    assert.equal(recoveredResponse.status, 200, recoveredBody.error);
    assert.equal(recoveredBody.ok, true, recoveredBody.error);
  } finally {
    fs.writeFileSync(localConfigPath, originalConfig, "utf8");
    store.deleteTab(invalidTab.id);
  }
});

test("历史冻结 StoryDev 根和 junction 指向源码时同样拒绝且不创建目录", async (t) => {
  const unsafeRoot = path.join(repo, "AllDocs", "StoryDev");
  assert.throws(
    () => store.getStoryStoragePaths({ ...store.getTab(tab.id), storyStorageRoot: unsafeRoot }, { create: true }),
    (error) => error?.code === "STORY_STORAGE_SOURCE_OVERLAP",
  );
  assert.equal(fs.existsSync(unsafeRoot), false);

  assert.throws(
    () => store.getStoryStoragePaths({
      ...store.getTab(tab.id),
      worktree: {
        version: 1,
        root: storage.storyDevRoot,
        entries: [{ role: "primary", path: storage.storyDevRoot, basePath: repo }],
      },
    }, { create: true }),
    (error) => error?.code === "STORY_STORAGE_SOURCE_OVERLAP",
    "调用方传入的同 id 新 worktree 必须覆盖持久化旧快照参与校验",
  );

  const junction = path.join(tmp, `repo-link-${Date.now()}`);
  try {
    fs.symlinkSync(repo, junction, process.platform === "win32" ? "junction" : "dir");
  } catch (error) {
    t.diagnostic(`当前环境无法创建目录链接，跳过 canonical 路径分支：${error.message}`);
    return;
  }
  const response = await fetch(`${base}/remote-config`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ cloneParent: junction }),
  });
  const body = await response.json();
  assert.equal(response.status, 400);
  assert.equal(body.code, "STORY_STORAGE_SOURCE_OVERLAP");
  assert.equal(fs.existsSync(path.join(repo, "AllDocs", "StoryDev")), false);
  fs.rmSync(junction, { force: true });
});

test("HTTP 存档和完整对话备份均拒绝把输出目录设到源码树", async () => {
  const unsafeArchiveDir = path.join(repo, "docs", "story", "unsafe-archive");
  const archiveDirResponse = await fetch(`${base}/tabs/${tab.id}/archive-dir`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ archiveDir: unsafeArchiveDir }),
  });
  const archiveDirBody = await archiveDirResponse.json();
  assert.equal(archiveDirResponse.status, 400);
  assert.equal(archiveDirBody.ok, false);
  assert.equal(archiveDirBody.code, "STORY_STORAGE_LINK_UNSAFE");
  assert.equal(fs.existsSync(unsafeArchiveDir), false);

  const unsafeBackupDir = path.join(repo, "docs", "tempFiles", "backups");
  const backupResponse = await fetch(`${base}/tabs/${tab.id}/conversation-backup`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ directory: unsafeBackupDir }),
  });
  const backupBody = await backupResponse.json();
  assert.equal(backupResponse.status, 400);
  assert.equal(backupBody.ok, false);
  assert.equal(backupBody.code, "STORY_STORAGE_LINK_UNSAFE");
  assert.equal(fs.existsSync(unsafeBackupDir), false);
  assert.equal(fs.existsSync(path.join(repo, "docs")), false, "两个非法请求均不得污染源码工程");
});

test("StoryDev archives 为目录链接时拒绝上传且不向解析后的边界外写文件", async () => {
  let linkedTab = store.createTab({ title: "#CARB-201# 目录链接边界" });
  linkedTab = store.updateTab(linkedTab.id, {
    primaryProjectId: "story-storage-project",
    worktree: {
      version: 1,
      managed: true,
      root: repo,
      entries: [{
        role: "primary",
        baseProjectId: "story-storage-project",
        name: "StoryStorage",
        basePath: repo,
        path: repo,
      }],
    },
  });
  const linkedStorage = store.getStoryStoragePaths(linkedTab, { create: true });
  const outside = fs.mkdtempSync(path.join(tmp, "outside-story-storage-"));
  fs.rmdirSync(linkedStorage.attachmentDirectory);
  fs.symlinkSync(
    outside,
    linkedStorage.attachmentDirectory,
    process.platform === "win32" ? "junction" : "dir",
  );

  const response = await fetch(
    `${base}/tabs/${linkedTab.id}/upload?filename=${encodeURIComponent("must-not-write.txt")}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream" },
      body: Buffer.from("blocked"),
    },
  );
  const body = await response.json();
  assert.equal(response.status, 400);
  assert.equal(body.ok, false);
  assert.equal(body.code, "STORY_STORAGE_LINK_UNSAFE");
  assert.equal(fs.existsSync(path.join(outside, "must-not-write.txt")), false);
});

test("StoryDev 深层目录链接同时阻断上传和材料登记", async () => {
  let linkedTab = store.createTab({ title: "#CARB-202# 深层目录链接边界" });
  linkedTab = store.updateTab(linkedTab.id, {
    primaryProjectId: "story-storage-project",
    worktree: {
      version: 1,
      managed: true,
      root: repo,
      entries: [{
        role: "primary",
        baseProjectId: "story-storage-project",
        name: "StoryStorage",
        basePath: repo,
        path: repo,
      }],
    },
  });
  const linkedStorage = store.getStoryStoragePaths(linkedTab, { create: true });
  const outside = fs.mkdtempSync(path.join(tmp, "outside-story-storage-nested-"));
  const nested = path.join(linkedStorage.attachmentDirectory, "nested");
  fs.symlinkSync(outside, nested, process.platform === "win32" ? "junction" : "dir");
  fs.writeFileSync(path.join(outside, "secret.txt"), "outside");

  const uploadResponse = await fetch(
    `${base}/tabs/${linkedTab.id}/upload?filename=${encodeURIComponent("nested/must-not-write.txt")}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream" },
      body: Buffer.from("blocked"),
    },
  );
  const upload = await uploadResponse.json();
  assert.equal(uploadResponse.status, 400);
  assert.equal(upload.code, "STORY_STORAGE_LINK_UNSAFE");
  assert.equal(fs.existsSync(path.join(outside, "must-not-write.txt")), false);

  const materialResponse = await fetch(`${base}/tabs/${linkedTab.id}/material`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      relPath: "storydev:/archives/nested/secret.txt",
      name: "secret.txt",
    }),
  });
  assert.equal(materialResponse.status, 400);
  assert.equal(
    (store.getTab(linkedTab.id).materials || []).some((item) => item.name === "secret.txt"),
    false,
  );
});
