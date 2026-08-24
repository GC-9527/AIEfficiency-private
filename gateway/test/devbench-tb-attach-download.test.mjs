// 集成测试：POST /tabs/:id/tb-attachments/download 与 /tb-attachments/stop
// 验证：
//   1) 下载响应立即返回 { ok: true, data: { started: true, attachmentKey, name } }
//   2) WS devbench_attach_progress 事件序列正确：file downloading → progress(N) → file done → end
//   3) 调 /stop 触发 file stopped → end，partial 文件保留
//
// 沿用 devbench-tb-ticket-access.integration.test.mjs 的 harness 模式。
// 直接用 store.updateTab 设置 worktree.entries 模拟已绑定主工程；storyStorageRoot 指向
// tmpdir/AllDocs/StoryDev 以满足 validFrozenStoryDevRoot。
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import express from "express";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "devbench-tb-attach-dl-"));
process.env.GATEWAY_CONFIG_PATH = path.join(root, "gateway.json");
process.env.GATEWAY_DB_PATH = path.join(root, "gateway.db");
process.env.DEVBENCH_STORE_DIR = path.join(root, "store");
fs.writeFileSync(process.env.GATEWAY_CONFIG_PATH, JSON.stringify({
  role: "standalone",
  teambition: {
    operatorId: "tb-test-user",
    userName: "TB 测试",
    userCookie: "TB_SESSION=test",
  },
}), "utf8");

const { currentTbUserActor } = await import("../services/devbench-tb-user-access-policy.js");
const store = await import("../services/devbench/store.js");
const logger = await import("../services/logger.js");
const router = (await import("../routes/devbench.js")).default;

const originalFetch = globalThis.fetch;

// 抓 WS 事件（替 wsClients 为一个 Set，里头是带 send() 的 mock client）
const wsEvents = [];
const fakeClients = new Set();
function makeClient() {
  return {
    readyState: 1,
    subscribedSessions: new Set(),
    send: (msg) => wsEvents.push(JSON.parse(msg)),
  };
}
fakeClients.add(makeClient());
logger.setWsClients(fakeClients);

// 启动 gateway route
let server;
let base;
before(async () => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.principal = currentTbUserActor();
    next();
  });
  app.use("/api/devbench", router);
  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${server.address().port}/api/devbench`;
});

after(async () => {
  globalThis.fetch = originalFetch;
  logger.setWsClients(new Set());
  if (server) await new Promise((resolve) => server.close(resolve));
  try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
});

// mock 远端下载源
async function withLocalOrigin(handler, run) {
  const srv = http.createServer(handler);
  await new Promise((resolve, reject) => {
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", resolve);
  });
  const port = srv.address().port;
  try { return await run(`http://127.0.0.1:${port}`); }
  finally { await new Promise((resolve) => srv.close(resolve)); }
}

function postJson(pathname, body) {
  return originalFetch(`${base}${pathname}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

test("GET /tb-attachments: 返回评论附件的归一化上传时间", async () => {
  const { tab } = await setupTabWithWorkspace("created-at");
  const taskId = "0123456789abcdef01234567";
  store.updateTab(tab.id, { ticketUrl: `https://www.teambition.com/task/${taskId}` });
  globalThis.fetch = async (url) => {
    const parsed = new URL(String(url));
    if (parsed.host === "www.teambition.com" && parsed.pathname === `/api/v2/tasks/${taskId}/activities`) {
      return new Response(JSON.stringify({
        result: [{
          _id: "activity-created-at",
          action: "activity.comment.attachments",
          created: "2026-08-19T12:34:56.789Z",
          content: {
            files: [{
              _id: "file-created-at",
              name: "运行日志",
              ext: "txt",
              size: 128,
              url: "https://download.example/runtime.txt",
            }],
          },
        }],
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    throw new Error(`unexpected fetch ${parsed.host}${parsed.pathname}`);
  };
  try {
    const response = await originalFetch(`${base}/tabs/${tab.id}/tb-attachments`);
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.data.attachments.length, 1);
    assert.equal(body.data.attachments[0].createdAt, "2026-08-19T12:34:56.789Z");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// 在 tmpdir 建一个工作区，配 AllDocs/StoryDev/<slug> 满足 validFrozenStoryDevRoot
// 并给 tab 装上 worktree.entries[role="primary"] 让 getPrimaryProject 直接走受管分支
async function setupTabWithWorkspace(label) {
  const wsRoot = fs.mkdtempSync(path.join(os.tmpdir(), `devbench-tb-attach-${label}-`));
  const storyDevRoot = path.join(wsRoot, "AllDocs", "StoryDev");
  fs.mkdirSync(storyDevRoot, { recursive: true });

  const tab = store.createTab({ title: `tb-attach-${label}-${Date.now()}` });
  // 强制 slug 校验通过：tab 现在已有 slug（来自 createTab → newTabRecord）
  const projDir = path.join(wsRoot, "project-src");
  fs.mkdirSync(projDir, { recursive: true });
  store.updateTab(tab.id, {
    storyStorageRoot: storyDevRoot,
    worktree: {
      managed: true,
      entries: [
        { role: "primary", name: "test-proj", path: projDir, active: true, branch: "main" },
      ],
    },
  });
  return { tab, wsRoot, storyDevRoot, projDir };
}

async function waitFor(predicate, timeoutMs = 5000, intervalMs = 25) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error("waitFor 超时");
}

test("POST /tb-attachments/download: 立即响应 + WS 事件序列 + 落盘文件正确", async () => {
  const { tab, projDir } = await setupTabWithWorkspace("done");

  const TOTAL = 256 * 1024; // 256 KB
  await withLocalOrigin((req, res) => {
    if (req.url === "/tb-file.bin") {
      res.writeHead(200, {
        "content-type": "application/octet-stream",
        "content-length": String(TOTAL),
      });
      res.end(Buffer.alloc(TOTAL, 0x55));
    } else {
      res.writeHead(404); res.end();
    }
  }, async (origin) => {
    wsEvents.length = 0;
    const attachmentKey = "test-key-done";
    const r = await postJson(`/tabs/${tab.id}/tb-attachments/download`, {
      url: `${origin}/tb-file.bin`,
      name: "测试附件.bin",
      attachmentKey,
    });
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.equal(j.ok, true);
    assert.equal(j.data.started, true);
    assert.equal(j.data.attachmentKey, attachmentKey);
    assert.equal(j.data.name, "测试附件.bin");

    await waitFor(() => wsEvents.some((e) => e.data?.phase === "end"));
    const seq = wsEvents
      .filter((e) => e.type === "devbench_attach_progress" && e.data?.attachmentKey === attachmentKey)
      .map((e) => e.data);
    assert.ok(seq.length >= 3, `应至少 3 条事件（实际 ${seq.length}）`);
    assert.equal(seq[0].phase, "file");
    assert.equal(seq[0].status, "downloading");
    assert.equal(seq[seq.length - 1].phase, "end");
    const fileDone = seq.find((s) => s.phase === "file" && s.status === "done");
    assert.ok(fileDone, "应有 file done 事件");
    assert.equal(fileDone.received, TOTAL);
    assert.equal(fileDone.total, TOTAL);
    const endEv = seq[seq.length - 1];
    assert.equal(endEv.ok, true);
    assert.equal(endEv.done, 1);
  });

  // 验证落盘：destPath = <storyDevRoot>/<slug>/archives/测试附件.bin
  const reloaded = store.getTab(tab.id);
  const storage = store.getStoryStoragePaths(reloaded, { create: false });
  const dest = path.join(storage.attachmentDirectory, "测试附件.bin");
  const stat = fs.statSync(dest);
  assert.equal(stat.size, TOTAL, `落盘文件大小应为 ${TOTAL}，实际 ${stat.size}`);
});

test("POST /tb-attachments/stop: 已停止后事件序列为 file stopped → end 且磁盘保留部分文件", async () => {
  const { tab } = await setupTabWithWorkspace("stop");

  await withLocalOrigin((req, res) => {
    if (req.url === "/slow.bin") {
      res.writeHead(200, {
        "content-type": "application/octet-stream",
        "content-length": String(2 * 1024 * 1024), // 2 MB
      });
      let sent = 0;
      const tick = () => {
        if (sent >= 2 * 1024 * 1024 || res.destroyed) { if (!res.destroyed) res.end(); return; }
        const c = Buffer.alloc(64 * 1024, 0x77);
        sent += c.length; res.write(c);
        setTimeout(tick, 30);
      };
      setTimeout(tick, 30);
    } else {
      res.writeHead(404); res.end();
    }
  }, async (origin) => {
    wsEvents.length = 0;
    const attachmentKey = "test-key-stop";
    const dlPromise = postJson(`/tabs/${tab.id}/tb-attachments/download`, {
      url: `${origin}/slow.bin`,
      name: "slow.bin",
      attachmentKey,
    });
    await dlPromise;
    // 等收到至少一次 progress 事件再 stop（确保 reader 已进入流式读取，不再是 abort 在 fetch 之前）
    await waitFor(() => wsEvents.some((e) => e.type === "devbench_attach_progress" && e.data?.attachmentKey === attachmentKey && e.data?.phase === "progress"), 8000);
    // 再等一小段确保再读几块
    await new Promise((r) => setTimeout(r, 100));
    await postJson(`/tabs/${tab.id}/tb-attachments/stop`, { attachmentKey });

    await waitFor(() => wsEvents.some((e) => e.data?.phase === "end"), 8000);
    const seq = wsEvents
      .filter((e) => e.type === "devbench_attach_progress" && e.data?.attachmentKey === attachmentKey)
      .map((e) => e.data);
    const lastFile = [...seq].reverse().find((e) => e.phase === "file");
    assert.ok(lastFile, "应有 file 事件");
    assert.equal(lastFile.status, "stopped", `file 终态应为 stopped（实际 ${lastFile.status}）`);
    assert.ok(lastFile.received > 0, `stopped 时应已收到一些字节（实际 received=${lastFile.received}）`);
    const endEv = seq[seq.length - 1];
    assert.equal(endEv.phase, "end");
    assert.equal(endEv.ok, false);
    assert.equal(endEv.done, 0);

    // 保留部分文件
    const reloaded = store.getTab(tab.id);
    const storage = store.getStoryStoragePaths(reloaded, { create: false });
    const dest = path.join(storage.attachmentDirectory, "slow.bin");
    const stat = fs.statSync(dest);
    assert.ok(stat.size > 0, `磁盘应保留部分文件（实际 ${stat.size} 字节）`);
  });
});

test("POST /tb-attachments/stop: 重复 stop / 未知 attachmentKey / 非法状况都返回 ok 不抛", async () => {
  const { tab } = await setupTabWithWorkspace("idle");

  // 未知 attachmentKey
  const r1 = await postJson(`/tabs/${tab.id}/tb-attachments/stop`, { attachmentKey: "never-registered" });
  assert.equal(r1.status, 200);
  const j1 = await r1.json();
  assert.equal(j1.ok, true);
  assert.equal(j1.stopped, false);

  // 缺少 attachmentKey
  const r2 = await postJson(`/tabs/${tab.id}/tb-attachments/stop`, {});
  assert.equal(r2.status, 400);

  // tab 不存在
  const r3 = await postJson(`/tabs/no-such-tab/tb-attachments/stop`, { attachmentKey: "x" });
  assert.equal(r3.status, 404);
});

test("POST /tb-attachments/download: 缺失主工程 / 缺失 url / 未传 url 都返回 4xx", async () => {
  const { tab } = await setupTabWithWorkspace("validation");

  // 缺 url
  const r1 = await postJson(`/tabs/${tab.id}/tb-attachments/download`, { name: "x" });
  assert.equal(r1.status, 400);
  const j1 = await r1.json();
  assert.equal(j1.ok, false);

  // 把 worktree 清掉，模拟没有主工程
  store.updateTab(tab.id, { worktree: { managed: false, entries: [] } });
  const r2 = await postJson(`/tabs/${tab.id}/tb-attachments/download`, {
    url: "http://127.0.0.1:1/x", name: "x.bin",
  });
  assert.equal(r2.status, 400);
  const j2 = await r2.json();
  assert.equal(j2.ok, false);
  assert.match(j2.error, /主工程/);
});
