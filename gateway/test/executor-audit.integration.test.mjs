/**
 * 远端执行器 HTTP 集成测试：
 *   - /api/executor/run-tool 真实写入/读取本机白名单工程
 *   - 越界路径被拒绝
 *   - 执行动作写入 admin_audit，便于分布式任务跨端追踪
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { bootGateway, waitHealth } from "./_helpers.mjs";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "execaudit-"));
const root = path.join(tmp, "project");
fs.mkdirSync(root, { recursive: true });

const PORT = 39733;
const cfgPath = path.join(tmp, "gw.json");
const dbPath = path.join(tmp, "data.db");
const marketPath = path.join(tmp, "market.json");
const storeDir = path.join(tmp, "store");
const cloneParentA = path.join(tmp, "clone-a");
const cloneParentB = path.join(tmp, "clone-b");
const token = "tok-local";

fs.writeFileSync(cfgPath, JSON.stringify({
  role: "standalone",
  servers: { inboundToken: token, discovery: false, nodeName: "executor-audit-test" },
  executor: { enabled: true, allowedRoots: [root] },
  distributedExecution: { enabled: true, maxRounds: 12, requireRelativePaths: true, audit: true },
}, null, 2));
fs.writeFileSync(marketPath, JSON.stringify({ projects: [], cloneParent: cloneParentA }, null, 2));

const base = `http://127.0.0.1:${PORT}`;
const headers = { "Content-Type": "application/json", Authorization: `Bearer ${token}` };
const postTool = (name, args, extra = {}) => fetch(`${base}/api/executor/run-tool`, {
  method: "POST",
  headers,
  body: JSON.stringify({ root, name, args, sessionId: "sess-exec-audit", clientId: "test-center", ...extra }),
}).then((r) => r.json());

const srv = bootGateway({ port: PORT, role: "standalone", gwCfg: cfgPath, market: marketPath, storeDir, dbPath });
after(() => { try { srv.kill(); } catch {} });

test("executor run-tool 写/读/越界拒绝并写审计", async () => {
  await waitHealth(PORT, srv);
  const health = await fetch(`${base}/api/executor/health`).then((r) => r.json());
  assert.equal(health.ok, true);
  assert.ok((health.allowedRoots || []).some((x) => String(x).includes("execaudit-")));

  const write = await postTool("write_file", { path: "notes/out.txt", content: "hello distributed executor" });
  assert.equal(write.ok, true, write.error || JSON.stringify(write));
  assert.equal(fs.readFileSync(path.join(root, "notes/out.txt"), "utf8"), "hello distributed executor");

  const read = await postTool("read_file", { path: "notes/out.txt" });
  assert.equal(read.ok, true, read.error || JSON.stringify(read));
  assert.match(String(read.result), /hello distributed executor/);

  const readOnlyWrite = await postTool(
    "write_file",
    { path: "notes/readonly.txt", content: "must not be written" },
    { commandPolicy: "read_only" },
  );
  assert.equal(readOnlyWrite.ok, false);
  assert.equal(fs.existsSync(path.join(root, "notes/readonly.txt")), false);

  const denied = await postTool("write_file", { path: "../escape.txt", content: "bad" });
  assert.equal(denied.ok, false);
  assert.match(denied.error, /越界/);

  const audit = await fetch(`${base}/api/devbench/audit-since?since=0`).then((r) => r.json());
  assert.equal(audit.ok, true);
  const events = audit.data || [];
  assert.ok(events.some((e) => e.action === "执行器.动作" && String(e.target).includes("sess-exec-audit") && String(e.target).includes("write_file")));
  assert.ok(events.some((e) => e.action === "执行器.动作" && String(e.target).includes("sess-exec-audit") && String(e.after).includes("hello distributed executor")));
});

test("executor 故事点 start_process 必须携带与运行态一致的 taskId", async () => {
  await waitHealth(PORT, srv);
  const title = "#REMOTE-1# 远端产物隔离";
  const created = await fetch(`${base}/api/devbench/tabs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title }),
  }).then((response) => response.json());
  assert.equal(created.ok, true, created.error || JSON.stringify(created));
  const changedCloneParent = await fetch(`${base}/api/devbench/remote-config`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ cloneParent: cloneParentB }),
  }).then((response) => response.json());
  assert.equal(changedCloneParent.ok, true, changedCloneParent.error || JSON.stringify(changedCloneParent));

  const artifactScope = {
    kind: "story",
    id: created.data.id,
    title,
    docSlug: "#REMOTE-1#远端产物隔离",
    tempRoot: path.join(root, "docs", "tempFiles", "scope-injected"),
    ignored: "不得转交给工具上下文",
  };
  const callerTempRoot = path.join(root, "docs", "tempFiles", "body-injected");

  const missingTaskId = await postTool("start_process", {
    command: `"${process.execPath}" --version`,
    path: ".",
    purpose: "不得在没有故事点运行任务时启动",
  }, {
    artifactScope,
    tempRoot: callerTempRoot,
  });
  assert.equal(missingTaskId.ok, false);
  assert.match(missingTaskId.error || "", /taskId/);

  const noPersistedTask = await postTool("start_process", {
    command: `"${process.execPath}" --version`,
    path: ".",
  }, {
    artifactScope,
    taskId: "forged-ta<REDACTED_API_KEY>",
  });
  assert.equal(noPersistedTask.ok, false);
  assert.match(noPersistedTask.error || "", /没有可验证的运行中 AI 任务/);

  const processSnapshotDirectory = path.join(
    cloneParentA,
    "AllDocs",
    "StoryDev",
    artifactScope.docSlug,
    "tempFiles",
    "api-tool-processes",
  );
  assert.equal(
    fs.existsSync(processSnapshotDirectory)
      && fs.readdirSync(processSnapshotDirectory).some((name) => name.endsWith(".json")),
    false,
    "无可验证 taskId 时不得留下故事点后台进程快照",
  );
  assert.equal(
    fs.existsSync(path.join(
      cloneParentB,
      "AllDocs",
      "StoryDev",
      artifactScope.docSlug,
      "tempFiles",
      "api-tool-processes",
    )),
    false,
    "调用方改变 cloneParent 后不得在新目录写入产物",
  );
  assert.equal(fs.existsSync(path.join(root, "docs", "tempFiles")), false, "源码工程不得产生 docs/tempFiles");
  assert.equal(fs.existsSync(callerTempRoot), false, "调用方额外提供的绝对 tempRoot 不得生效");
  assert.equal(fs.existsSync(artifactScope.tempRoot), false, "artifactScope 内的绝对 tempRoot 字段不得生效");

  const mismatched = await postTool("start_process", {
    command: `"${process.execPath}" --version`,
    path: ".",
  }, {
    artifactScope: {
      kind: "story",
      id: artifactScope.id,
      title: artifactScope.title,
      docSlug: "forged-story",
    },
    tempRoot: callerTempRoot,
  });
  assert.equal(mismatched.ok, false, "不匹配的 docSlug 必须 fail closed");
  assert.equal(fs.existsSync(path.join(cloneParentA, "AllDocs", "StoryDev", "forged-story")), false);
  assert.equal(fs.existsSync(path.join(cloneParentB, "AllDocs", "StoryDev", "forged-story")), false);

  const mismatchedTitle = await postTool("start_process", {
    command: `"${process.execPath}" --version`,
    path: ".",
  }, {
    artifactScope: {
      ...artifactScope,
      title: "#REMOTE-1# 远端/产物隔离",
    },
  });
  assert.equal(mismatchedTitle.ok, false, "可安全识别的实质标题不匹配必须 fail closed");

  const unknown = await postTool("start_process", {
    command: `"${process.execPath}" --version`,
    path: ".",
  }, {
    artifactScope: {
      kind: "story",
      id: "unknown-story-id",
      title: "未知故事点",
      docSlug: "unknown-story",
    },
    tempRoot: callerTempRoot,
  });
  assert.equal(unknown.ok, false, "未知故事点 scope 必须 fail closed");
  assert.equal(fs.existsSync(path.join(cloneParentA, "AllDocs", "StoryDev", "unknown-story")), false);
  assert.equal(fs.existsSync(path.join(cloneParentB, "AllDocs", "StoryDev", "unknown-story")), false);

  const closed = await fetch(`${base}/api/devbench/tabs/${artifactScope.id}`, {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
  }).then((response) => response.json());
  assert.equal(closed.ok, true, closed.error || JSON.stringify(closed));
  const afterClose = await postTool("start_process", {
    command: `"${process.execPath}" --version`,
    path: ".",
  }, { artifactScope, tempRoot: callerTempRoot });
  assert.equal(afterClose.ok, false, "已关闭故事点 scope 必须 fail closed");
  assert.equal(fs.existsSync(path.join(root, "docs", "tempFiles")), false);
});

test("executor 通用生成产物只写入系统临时目录", async () => {
  await waitHealth(PORT, srv);
  const artifactScope = {
    kind: "generic",
    id: "executor-generic-artifact",
    title: "generic 不接受 title",
    tempRoot: path.join(root, "docs", "tempFiles", "scope-injected"),
  };
  const callerTempRoot = path.join(root, "docs", "tempFiles", "body-injected");
  const started = await postTool("start_process", {
    command: `"${process.execPath}" --version`,
    path: ".",
  }, {
    artifactScope,
    tempRoot: callerTempRoot,
  });
  assert.equal(started.ok, true, started.error || JSON.stringify(started));
  const processInfo = JSON.parse(started.result);
  const expectedSnapshot = path.join(
    os.tmpdir(),
    "aiefficiency",
    "api-artifacts",
    artifactScope.id,
    "api-tool-processes",
    `${processInfo.process_id}.json`,
  );
  assert.equal(fs.existsSync(expectedSnapshot), true, "generic 快照应落到系统临时目录");
  assert.equal(fs.existsSync(path.join(root, "docs", "tempFiles")), false, "generic scope 不得回退到源码工程");
  assert.equal(fs.existsSync(callerTempRoot), false);
  assert.equal(fs.existsSync(artifactScope.tempRoot), false);
});

test("executor 无 scope 时也不接收绝对 tempRoot 或回退源码目录", async () => {
  await waitHealth(PORT, srv);
  const callerTempRoot = path.join(root, "docs", "tempFiles", "body-injected");
  const started = await postTool("start_process", {
    command: `"${process.execPath}" --version`,
    path: ".",
  }, {
    tempRoot: callerTempRoot,
  });
  assert.equal(started.ok, true, started.error || JSON.stringify(started));
  assert.equal(fs.existsSync(path.join(root, "docs", "tempFiles")), false);
  assert.equal(fs.existsSync(callerTempRoot), false);
});
