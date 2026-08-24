import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
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
    await new Promise((resolve) => setTimeout(resolve, 100));
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

test("Git 与普通初始化并发绑定同一显式票据时，最终原子门禁只允许一个 Tab", { timeout: 60_000 }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "devbench-git-ticket-race-"));
  const source = path.join(root, "source");
  const cloneParent = path.join(root, "runtime");
  const localProjects = path.join(root, "local", "devbench-projects.json");
  const gatewayConfig = path.join(root, "gateway.json");
  const marketConfig = path.join(root, "market.json");
  fs.mkdirSync(source);
  fs.mkdirSync(cloneParent);
  fs.mkdirSync(path.dirname(localProjects), { recursive: true });
  git(source, "init");
  git(source, "config", "user.name", "Story Initialization Test");
  git(source, "config", "user.email", "story-initialization@example.test");
  fs.writeFileSync(path.join(source, "tracked.txt"), "base\n");
  git(source, "add", "tracked.txt");
  git(source, "commit", "-m", "base");
  git(source, "remote", "add", "origin", "https://codeup.aliyun.com/xunihezi/AIEfficiency");
  const revision = git(source, "rev-parse", "HEAD");
  fs.writeFileSync(marketConfig, "{}");
  fs.writeFileSync(gatewayConfig, JSON.stringify({ role: "standalone", servers: { nodeId: "git-ticket-race" } }));
  fs.writeFileSync(localProjects, JSON.stringify({
    version: 2,
    cloneParent,
    projects: [{ id: "shared-base", name: "Shared Base", path: source, webAppPath: "" }],
  }));

  const port = await freePort();
  const child = spawn(process.execPath, ["server.js"], {
    cwd: gatewayDir,
    env: {
      ...process.env,
      NODE_ENV: "test",
      PORT: String(port),
      ROLE: "standalone",
      GATEWAY_CONFIG_PATH: gatewayConfig,
      GATEWAY_DB_PATH: path.join(root, "gateway.db"),
      DEVBENCH_CONFIG_PATH: marketConfig,
      DEVBENCH_LOCAL_PROJECTS_PATH: localProjects,
      DEVBENCH_STORE_DIR: path.join(root, "store"),
      DEVBENCH_SYNC_SCOPE: `git-ticket-race-${Date.now()}`,
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

  const ticketUrl = "https://example.invalid/devbench-ticket-race";
  const gitIntent = await api(baseUrl, "POST", "/story-initializations", {
    title: "Git commit ticket race",
    ticketInput: ticketUrl,
    configuration: { mode: "local", primaryProjectId: "shared-base" },
    entry: { kind: "git_commit", repositoryId: "aiEfficiency", revision },
  });
  assert.equal(gitIntent.status, 201, gitIntent.error);

  const ownerIntent = await api(baseUrl, "POST", "/story-initializations", {
    title: "Ticket race owner",
    ticketInput: ticketUrl,
    configuration: { mode: "blank" },
    entry: { kind: "blank_story" },
  });
  assert.equal(ownerIntent.status, 201, ownerIntent.error);

  const createBody = {
    repositoryId: "aiEfficiency",
    revision,
    configurationConfirmed: true,
    configuration: { mode: "local", localProjectId: "shared-base", localRole: "primary" },
    storyInitializationIntentId: gitIntent.data.id,
  };
  const [owner, gitReview] = await Promise.all([
    api(baseUrl, "POST", "/tabs", { initializationIntentId: ownerIntent.data.id }),
    api(baseUrl, "POST", "/git-commit-story", createBody),
  ]);
  const outcomes = [
    { kind: "tabs", result: owner },
    { kind: "git", result: gitReview },
  ];
  const succeeded = outcomes.filter((item) => item.result.ok === true);
  const rejected = outcomes.filter((item) => item.result.status === 409 && item.result.code === "STORY_TICKET_TAKEN");
  assert.equal(succeeded.length, 1, JSON.stringify(outcomes));
  assert.equal(rejected.length, 1, JSON.stringify(outcomes));

  const retried = rejected[0].kind === "git"
    ? await api(baseUrl, "POST", "/git-commit-story", createBody)
    : await api(baseUrl, "POST", "/tabs", { initializationIntentId: ownerIntent.data.id });
  assert.equal(retried.status, 409, retried.error);
  assert.equal(retried.code, "STORY_TICKET_TAKEN", "失败请求应释放 intent，重试仍执行原子票据检查");

  const tabs = await api(baseUrl, "GET", "/tabs");
  assert.equal(
    tabs.data.filter((tab) => tab.reviewContext?.kind === "git_commit").length,
    gitReview.ok === true ? 1 : 0,
  );
  assert.equal(tabs.data.filter((tab) => tab.ticketUrl === ticketUrl).length, 1);
});
