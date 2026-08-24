import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

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

test("异主 worktree 的提交可被预检识别并 rebase 快进到原始分支", { timeout: 120_000 }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "devbench-rebase-safe-"));
  const source = path.join(root, "source");
  const cloneParent = path.join(root, "runtime");
  fs.mkdirSync(source);
  fs.mkdirSync(cloneParent);
  git(source, "init", "--quiet");
  git(source, "config", "user.name", "Devbench Test");
  git(source, "config", "user.email", "devbench@example.test");
  fs.writeFileSync(path.join(source, "tracked.txt"), "base\n");
  git(source, "add", "tracked.txt");
  git(source, "commit", "-m", "base");
  git(source, "branch", "-M", "release/seres");

  const market = path.join(root, "market.json");
  const localProjects = path.join(root, "local", "devbench-projects.json");
  const gatewayConfig = path.join(root, "gateway.json");
  fs.mkdirSync(path.dirname(localProjects), { recursive: true });
  fs.writeFileSync(market, "{}");
  fs.writeFileSync(localProjects, JSON.stringify({
    version: 2,
    cloneParent,
    projects: [{ id: "seres", name: "Seres", path: source, webAppPath: "" }],
  }));
  fs.writeFileSync(gatewayConfig, JSON.stringify({
    role: "standalone",
    servers: { nodeId: "rebase-safe-directory-test" },
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
      DEVBENCH_SYNC_SCOPE: `rebase-safe-${Date.now()}`,
      GIT_TEST_ASSUME_DIFFERENT_OWNER: "1",
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
  const created = await api(baseUrl, "POST", "/tabs", {
    title: "#CARB-13465# rebase 异主 worktree",
  });
  assert.equal(created.ok, true, created.error);
  const entry = created.data.worktree.entries.find((item) => item.role === "primary");
  assert.ok(entry?.path);
  assert.equal(entry.originalBranch, "release/seres");

  fs.writeFileSync(path.join(entry.path, "story-change.txt"), "story\n");
  git(entry.path, "add", "story-change.txt");
  git(entry.path, "commit", "-m", "#CARB-13465# story change");

  const preview = await api(baseUrl, "POST", `/tabs/${created.data.id}/git/rebase-preview`, {});
  assert.equal(preview.ok, true, preview.error);
  assert.equal(preview.summary.canRebase, 1);
  assert.equal(preview.summary.blocked, 0);
  assert.equal(preview.data[0].canRebase, true);
  assert.equal(preview.data[0].ahead, 1);

  const executed = await api(baseUrl, "POST", `/tabs/${created.data.id}/git/rebase-original`, {});
  assert.equal(executed.ok, true, executed.error);
  assert.equal(executed.summary.succeeded, 1);
  assert.equal(executed.data[0].rebased, true);
  assert.equal(git(source, "rev-parse", "release/seres"), git(entry.path, "rev-parse", entry.branch));
  assert.equal(fs.readFileSync(path.join(source, "story-change.txt"), "utf8").replace(/\r\n/g, "\n"), "story\n");
});
