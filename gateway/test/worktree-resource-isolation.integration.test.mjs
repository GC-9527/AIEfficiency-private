import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { createHash } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";

const gatewayDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function git(cwd, ...args) {
  return execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    windowsHide: true,
  }).trim();
}

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function waitForHealth(baseUrl, child) {
  const deadline = Date.now() + 25_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`隔离 Gateway 提前退出：${child.exitCode}`);
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error("隔离 Gateway 启动超时");
}

async function api(baseUrl, method, route, body) {
  const response = await fetch(`${baseUrl}/api/devbench${route}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const payload = await response.json();
  return { status: response.status, ...payload };
}

test("另一个故事点 AI 运行时 apply-config 仍可为新故事点创建独立 checkout", { timeout: 90_000 }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "devbench-worktree-isolation-"));
  const source = path.join(root, "source");
  const unmappedSource = path.join(root, "unmapped-source");
  const runtime = path.join(root, "runtime");
  const market = path.join(root, "market.json");
  const localProjects = path.join(root, "local", "devbench-projects.json");
  const gatewayConfig = path.join(root, "gateway.json");
  const gatewayDb = path.join(root, "gateway.db");
  fs.mkdirSync(source);
  fs.mkdirSync(unmappedSource);
  fs.mkdirSync(runtime);
  fs.mkdirSync(path.dirname(localProjects), { recursive: true });
  git(source, "init");
  git(source, "config", "user.name", "Devbench Test");
  git(source, "config", "user.email", "devbench@example.test");
  fs.writeFileSync(path.join(source, "tracked.txt"), "base\n");
  git(source, "add", "tracked.txt");
  git(source, "commit", "-m", "base");
  const unmappedSentinel = path.join(unmappedSource, "protected.txt");
  fs.writeFileSync(unmappedSentinel, "protected-base\n");
  fs.writeFileSync(market, "{}");
  fs.writeFileSync(localProjects, JSON.stringify({
    version: 2,
    cloneParent: runtime,
    projects: [
      { id: "shared-base", name: "Shared Base", path: source, webAppPath: "" },
      { id: "unmapped-base", name: "Unmapped Base", path: unmappedSource, webAppPath: "" },
    ],
  }));
  fs.writeFileSync(gatewayConfig, JSON.stringify({
    // 纯客户端且未配置中心机时，sendTurn 会在本地异步失败并立即收口，
    // 足以验证发送入口的租约判定，同时不会真的启动 Codex/Claude。
    role: "node",
    servers: { nodeId: "worktree-resource-isolation" },
    distributedExecution: { enabled: true },
  }));

  const port = await freePort();
  const child = spawn(process.execPath, ["server.js"], {
    cwd: gatewayDir,
    env: {
      ...process.env,
      NODE_ENV: "test",
      PORT: String(port),
      ROLE: "node",
      GATEWAY_CONFIG_PATH: gatewayConfig,
      GATEWAY_DB_PATH: gatewayDb,
      DEVBENCH_CONFIG_PATH: market,
      DEVBENCH_LOCAL_PROJECTS_PATH: localProjects,
      DEVBENCH_STORE_DIR: path.join(root, "store"),
      DEVBENCH_SYNC_SCOPE: `worktree-isolation-${Date.now()}`,
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  t.after(async () => {
    if (child.exitCode === null) {
      child.kill("SIGTERM");
      await Promise.race([
        new Promise((resolve) => child.once("exit", resolve)),
        new Promise((resolve) => setTimeout(resolve, 3000)),
      ]);
    }
    try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch {}
  });

  const baseUrl = `http://127.0.0.1:${port}`;
  await waitForHealth(baseUrl, child);
  const runningStory = await api(baseUrl, "POST", "/tabs", { title: "#CARB-1# running story" });
  const newStory = await api(baseUrl, "POST", "/tabs", { title: "#CARB-2# confirmed story" });
  assert.equal(runningStory.ok, true, runningStory.error);
  assert.equal(newStory.ok, true, newStory.error);

  const runningPath = runningStory.data.worktree.entries.find((entry) => entry.role === "primary").path;
  const newPathBeforeApply = newStory.data.worktree.entries.find((entry) => entry.role === "primary").path;
  assert.notEqual(runningPath, newPathBeforeApply);

  const sentinelBefore = fs.readFileSync(unmappedSentinel, "utf8");
  const sentinelMtimeBefore = fs.statSync(unmappedSentinel).mtimeMs;
  const blocked = await api(baseUrl, "POST", `/tabs/${newStory.data.id}/send`, {
    content: `请直接修改基础仓库 ${unmappedSentinel}`,
  });
  assert.equal(blocked.status, 409, JSON.stringify(blocked));
  assert.equal(blocked.code, "STORY_BASE_WORKTREE_MISSING");
  assert.match(blocked.error, /AI 未启动、未注入、未排队/);
  assert.equal(blocked.repositoryPathAlert?.paths?.some((candidate) => (
    path.resolve(candidate) === path.resolve(unmappedSource)
  )), true, JSON.stringify(blocked.repositoryPathAlert));
  const tabsAfterBlockedSend = await api(baseUrl, "GET", "/tabs");
  const blockedStory = tabsAfterBlockedSend.data.find((tab) => tab.id === newStory.data.id);
  assert.equal(blockedStory.runningTaskId || null, null, "缺少 worktree 时不得启动 AI task");
  assert.equal((blockedStory.queue || []).length, 0, "缺少 worktree 时不得把消息加入持久队列");
  assert.equal(blockedStory.repositoryPathAlert?.level, "error", "tab 应持久化醒目告警供聊天区刷新后显示");
  assert.equal(fs.readFileSync(unmappedSentinel, "utf8"), sentinelBefore, "受保护基础仓库文件不得被修改");
  assert.equal(fs.statSync(unmappedSentinel).mtimeMs, sentinelMtimeBefore, "受保护基础仓库文件 mtime 不得变化");

  const snapshot = await api(baseUrl, "GET", `/tabs/${runningStory.data.id}/config-snapshot`);
  assert.equal(snapshot.ok, true, snapshot.error);

  // 旧版本会把共享父目录写入每个故事点的 AI 租约。保留这条真实形态的遗留租约，
  // 验证新版本不会让它阻断另一个 checkout 的“确认并继续”后续 apply-config。
  const leaseDb = new Database(gatewayDb);
  const sharedRoot = fs.realpathSync.native(snapshot.data.worktree.root);
  const sharedRootKey = `path:${createHash("sha256")
    .update(path.resolve(sharedRoot).replace(/[\\/]+/g, "/").replace(/\/+$/, "").toLowerCase())
    .digest("hex")}`;
  const leaseToken = `other-story-ai-${Date.now()}`;
  const now = Date.now();
  leaseDb.prepare(`
    INSERT INTO worktree_resource_leases(
      resource_key, lease_token, kind, tab_id, task_id, owner_instance,
      owner_pid, acquired_at, heartbeat_at, expires_at
    ) VALUES (?, ?, 'ai', ?, ?, ?, ?, ?, ?, ?)
  `).run(
    sharedRootKey,
    leaseToken,
    runningStory.data.id,
    "other-story-running",
    "worktree-route-regression",
    process.pid,
    now,
    now,
    now + 60_000,
  );

  let applied;
  try {
    applied = await api(baseUrl, "POST", `/tabs/${newStory.data.id}/apply-config`, {
      snapshot: snapshot.data,
    });
    assert.equal(applied.ok, true, applied.error);
    assert.equal(
      leaseDb.prepare("SELECT COUNT(*) count FROM worktree_resource_leases WHERE lease_token = ?")
        .get(leaseToken).count,
      1,
      "另一个故事点的 AI 租约必须原样保留",
    );

    const sent = await api(baseUrl, "POST", `/tabs/${newStory.data.id}/send`, {
      content: "继续处理当前故事点",
    });
    assert.equal(sent.status, 200, JSON.stringify(sent));
    assert.equal(sent.ok, true, sent.error || JSON.stringify(sent));
    assert.notEqual(
      sent.code,
      "AI_STARTING_ON_OTHER_GATEWAY",
      "另一个故事点的 AI 租约不得导致当前故事点聊天发送失败",
    );
  } finally {
    leaseDb.prepare("DELETE FROM worktree_resource_leases WHERE lease_token = ?").run(leaseToken);
    leaseDb.close();
  }

  const newPathAfterApply = applied.data.tab.worktree.entries.find((entry) => entry.role === "primary").path;
  assert.notEqual(newPathAfterApply, runningPath, "新故事点必须继续使用自己的独立 checkout");
  assert.equal(fs.existsSync(runningPath), true, "运行中的故事点 checkout 不得被删除或迁移");
  assert.equal(fs.existsSync(newPathAfterApply), true);
});
