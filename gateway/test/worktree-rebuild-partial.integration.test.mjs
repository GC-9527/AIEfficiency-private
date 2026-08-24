import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { execFileSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const gatewayDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function git(cwd, ...args) {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", windowsHide: true }).trim();
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

function initRepository(repo, file, remote) {
  fs.mkdirSync(repo);
  git(repo, "init");
  git(repo, "config", "user.name", "Devbench Test");
  git(repo, "config", "user.email", "devbench@example.test");
  fs.writeFileSync(path.join(repo, file), `${file}\n`);
  git(repo, "add", file);
  git(repo, "commit", "-m", "base");
  git(repo, "remote", "add", "origin", remote);
  git(repo, "update-ref", "refs/remotes/origin/main", git(repo, "rev-parse", "HEAD"));
}

test("主工程重建部分清理后立即写回 cleanup_partial", { timeout: 60_000 }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "devbench-rebuild-partial-"));
  const primarySource = path.join(root, "primary-source");
  const secondSource = path.join(root, "second-source");
  const cloneParent = path.join(root, "runtime");
  fs.mkdirSync(cloneParent);
  initRepository(primarySource, "primary.txt", "https://example.invalid/primary.git");
  initRepository(secondSource, "second.txt", "https://example.invalid/second.git");

  const market = path.join(root, "market.json");
  const localProjects = path.join(root, "local", "devbench-projects.json");
  const gatewayConfig = path.join(root, "gateway.json");
  fs.mkdirSync(path.dirname(localProjects), { recursive: true });
  fs.writeFileSync(market, "{}");
  fs.writeFileSync(localProjects, JSON.stringify({
    version: 2,
    cloneParent,
    projects: [
      { id: "primary", name: "Primary", path: primarySource, webAppPath: "" },
      { id: "second", name: "Second", path: secondSource, webAppPath: "" },
    ],
  }));
  fs.writeFileSync(gatewayConfig, JSON.stringify({
    role: "standalone",
    servers: { nodeId: "worktree-rebuild-partial-test" },
  }));

  const port = await freePort();
  const child = spawn(process.execPath, ["server.js"], {
    cwd: gatewayDir,
    env: {
      ...process.env,
      PORT: String(port),
      ROLE: "standalone",
      GATEWAY_CONFIG_PATH: gatewayConfig,
      GATEWAY_DB_PATH: path.join(root, "gateway.db"),
      DEVBENCH_CONFIG_PATH: market,
      DEVBENCH_LOCAL_PROJECTS_PATH: localProjects,
      DEVBENCH_STORE_DIR: path.join(root, "store"),
      DEVBENCH_SYNC_SCOPE: `worktree-rebuild-partial-${Date.now()}`,
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
  const created = await api(baseUrl, "POST", "/tabs", { title: "#CARB-13851# 部分重建" });
  assert.equal(created.ok, true, created.error);
  const withSecond = await api(baseUrl, "POST", `/tabs/${created.data.id}/extra`, {
    path: secondSource,
    name: "Second",
  });
  assert.equal(withSecond.ok, true, withSecond.error);
  const primaryEntry = withSecond.data.worktree.entries.find((entry) => entry.role === "primary");
  const secondEntry = withSecond.data.worktree.entries.find((entry) => entry.role === "extra");
  git(secondSource, "worktree", "lock", "--reason", "partial cleanup regression", secondEntry.worktreePath);

  const preview = await api(baseUrl, "POST", `/tabs/${created.data.id}/primary`, {
    projectId: "second",
  });
  assert.equal(preview.status, 409);
  assert.equal(preview.code, "WORKTREE_REBUILD_CONFIRM_REQUIRED");

  const partial = await api(baseUrl, "POST", `/tabs/${created.data.id}/primary`, {
    projectId: "second",
    confirmRebuild: true,
    cleanupToken: preview.data.inspection.token,
  });
  assert.equal(partial.status, 409);
  assert.equal(partial.code, "WORKTREE_CLEANUP_FAILED");
  assert.equal(partial.partial, true);
  assert.equal(fs.existsSync(primaryEntry.worktreePath), false);
  assert.equal(fs.existsSync(secondEntry.worktreePath), true);
  assert.equal(partial.data.tab.worktreeStatus, "cleanup_partial");
  assert.deepEqual(partial.data.tab.worktree.entries.map((entry) => entry.role), ["extra"]);
  assert.deepEqual(partial.data.tab.worktree.cleanedEntries.map((entry) => entry.role), ["primary"]);

  const listed = await api(baseUrl, "GET", "/tabs");
  const saved = listed.data.find((tab) => tab.id === created.data.id);
  assert.equal(saved.worktreeStatus, "cleanup_partial");
  assert.deepEqual(saved.refs.map((entry) => entry.role), ["extra"]);
});
