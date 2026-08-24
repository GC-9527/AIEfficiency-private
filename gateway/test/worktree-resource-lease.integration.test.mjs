import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { execFileSync, spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const gatewayDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function git(cwd, ...args) {
  return execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    windowsHide: true,
  }).trim();
}

function storyDocSlug(title) {
  const match = String(title || "").match(/^\s*#([^#]+)#\s*([\s\S]*)$/);
  const ticket = match ? match[1].trim() : "";
  const name = (match ? match[2] : String(title || "")).trim();
  const value = ticket ? `#${ticket}#${name || ticket}` : (name || ticket);
  let safe = "";
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint < 0x20 || codePoint === 0x7f) continue;
    if (codePoint >= 0xd800 && codePoint <= 0xdfff) continue;
    if ("\\/:*?\"<>|".includes(character)) continue;
    safe += /\s/.test(character) ? "_" : character;
  }
  return Array.from(safe)
    .slice(0, ticket ? 40 : 24)
    .join("")
    .replace(/^[._]+|[._]+$/g, "")
    .trim() || "story";
}

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function waitHealth(baseUrl, child) {
  const deadline = Date.now() + 25_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Gateway 提前退出：${child.exitCode}\n${child._stderr?.() || ""}`);
    }
    try {
      if ((await fetch(`${baseUrl}/api/health`)).ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Gateway 启动超时\n${child._stderr?.() || ""}`);
}

async function api(baseUrl, method, route, body) {
  const response = await fetch(`${baseUrl}/api/devbench${route}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let payload;
  try { payload = JSON.parse(text); }
  catch { payload = { ok: false, error: text }; }
  return { status: response.status, ...payload };
}

async function executorApi(baseUrl, name, args, artifactScope, taskId = "") {
  const response = await fetch(`${baseUrl}/api/executor/run-tool`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      root: args.path,
      name,
      args,
      artifactScope,
      taskId,
    }),
  });
  const text = await response.text();
  let payload;
  try { payload = JSON.parse(text); }
  catch { payload = { ok: false, error: text }; }
  return { status: response.status, ...payload };
}

function bootGateway(port, env) {
  const child = spawn(process.execPath, ["server.js"], {
    cwd: gatewayDir,
    env: { ...process.env, ...env, PORT: String(port), ROLE: "standalone" },
    stdio: ["ignore", "ignore", "pipe"],
    windowsHide: true,
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
  child._stderr = () => stderr;
  return child;
}

async function stopChild(child) {
  if (!child || child.exitCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    new Promise((resolve) => setTimeout(resolve, 3000)),
  ]);
}

function startLeaseHolder({
  env,
  tab,
  kind = "ai",
  taskId = "foreign-runtime-task",
  orphanWorker = false,
}) {
  const script = `
    const { spawn } = await import("node:child_process");
    const manager = await import(process.env.WORKTREE_MANAGER_URL);
    const store = await import(process.env.STORE_URL);
    const db = await import(process.env.SQLITE_URL);
    const tab = JSON.parse(process.env.LEASE_TAB_JSON);
    const kind = process.env.LEASE_KIND;
    let handle = null;
    if (kind === "ai") {
      handle = manager.beginStoryAiLease(tab, process.env.LEASE_TASK_ID);
      if (handle) {
        try {
          db.createTask({
            id: process.env.LEASE_TASK_ID,
            title: tab.title || "foreign",
            description: "cross gateway lease test",
            type: "general",
            status: "running",
            source: "devbench",
            sourceId: tab.sessionId,
          });
        } catch {}
        store.updateTab(tab.id, { runningTaskId: process.env.LEASE_TASK_ID });
        if (process.env.LEASE_ORPHAN_WORKER === "1") {
          const worker = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
            detached: true,
            stdio: "ignore",
            windowsHide: true,
          });
          worker.unref();
          db.upsertTaskRuntimeLease({
            leaseId: "orphan-worker-" + process.env.LEASE_TASK_ID,
            taskId: process.env.LEASE_TASK_ID,
            ownerInstance: "orphan-holder-" + process.pid,
            ownerPid: process.pid,
            workerPid: worker.pid,
            ttlMs: 5000,
          });
          process.stdout.write("WORKER_PID:" + worker.pid + "\\n");
        }
      }
    } else if (kind === "stale") {
      store.updateTab(tab.id, { runningTaskId: process.env.LEASE_TASK_ID });
      handle = { stale: true };
    } else {
      handle = manager.beginWorktreeMutation(tab, "cleanup") ? { mutation: true } : null;
    }
    if (!handle) {
      process.stderr.write("LEASE_FAILED\\n");
      process.exit(2);
    }
    process.stdout.write("LEASE_READY\\n");
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (value) => {
      if (value.includes("release-hold")) {
        if (kind === "ai") {
          manager.endStoryAiLease(handle);
          store.updateTab(tab.id, { runningTaskId: null });
        } else if (kind === "stale") {
          store.updateTab(tab.id, { runningTaskId: null });
        } else {
          manager.endWorktreeMutation(tab);
        }
        process.stdout.write("LEASE_RELEASED\\n");
        return;
      }
      if (value.includes("release")) {
        if (kind === "ai") {
          manager.endStoryAiLease(handle);
          store.updateTab(tab.id, { runningTaskId: null });
        } else if (kind === "stale") {
          store.updateTab(tab.id, { runningTaskId: null });
        } else {
          manager.endWorktreeMutation(tab);
        }
        process.stdout.write("LEASE_RELEASED\\n");
        process.exit(0);
      }
      if (value.includes("exit")) process.exit(0);
      if (value.includes("orphan")) process.reallyExit(91);
    });
    process.stdin.resume();
  `;
  const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
    cwd: gatewayDir,
    env: {
      ...process.env,
      ...env,
      LEASE_KIND: kind,
      LEASE_TASK_ID: taskId,
      LEASE_ORPHAN_WORKER: orphanWorker ? "1" : "0",
      LEASE_TAB_JSON: JSON.stringify(tab),
      WORKTREE_MANAGER_URL: pathToFileURL(path.join(gatewayDir, "services", "devbench", "worktree-manager.js")).href,
      STORE_URL: pathToFileURL(path.join(gatewayDir, "services", "devbench", "store.js")).href,
      SQLITE_URL: pathToFileURL(path.join(gatewayDir, "db", "sqlite.js")).href,
    },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
  child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
  child._output = () => ({ stdout, stderr });
  return child;
}

function killPidTree(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return;
  try {
    if (process.platform === "win32") {
      execFileSync("taskkill", ["/pid", String(pid), "/t", "/f"], {
        stdio: "ignore",
        windowsHide: true,
        timeout: 10_000,
      });
    } else {
      try { process.kill(-pid, "SIGKILL"); }
      catch { process.kill(pid, "SIGKILL"); }
    }
  } catch {}
}

function workerPidFrom(holder) {
  const match = holder._output().stdout.match(/WORKER_PID:(\d+)/);
  return match ? Number(match[1]) : 0;
}

async function waitLeaseReady(child) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (child._output().stdout.includes("LEASE_READY")) return;
    if (child.exitCode !== null) {
      throw new Error(`租约进程提前退出：${child.exitCode}\n${child._output().stderr}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`租约进程启动超时\n${child._output().stderr}`);
}

test("跨 Gateway AI 租约阻断清理和并发发送，重启与崩溃过期均不误判", { timeout: 120_000 }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "devbench-resource-lease-"));
  const source = path.join(root, "source");
  const cloneParent = path.join(root, "clone-parent");
  const localProjects = path.join(root, "local", "devbench-projects.json");
  const gatewayConfig = path.join(root, "gateway.json");
  const dbPath = path.join(root, "gateway.db");
  const storeDir = path.join(root, "store");
  const market = path.join(root, "market.json");
  fs.mkdirSync(source);
  fs.mkdirSync(cloneParent);
  fs.mkdirSync(path.dirname(localProjects), { recursive: true });
  git(source, "init");
  git(source, "config", "user.name", "Lease Test");
  git(source, "config", "user.email", "lease@example.test");
  fs.writeFileSync(path.join(source, "tracked.txt"), "base\n");
  git(source, "add", "tracked.txt");
  git(source, "commit", "-m", "base");
  const branch = git(source, "branch", "--show-current");
  const revision = git(source, "rev-parse", "HEAD");
  git(source, "remote", "add", "origin", "https://example.invalid/lease.git");
  git(source, "update-ref", `refs/remotes/origin/${branch}`, revision);
  git(source, "branch", "--set-upstream-to", `origin/${branch}`, branch);
  fs.writeFileSync(market, "{}");
  fs.writeFileSync(localProjects, JSON.stringify({
    version: 2,
    cloneParent,
    projects: [{ id: "lease-project", name: "Lease Project", path: source, webAppPath: "" }],
  }));
  fs.writeFileSync(gatewayConfig, JSON.stringify({
    role: "standalone",
    servers: { nodeId: "lease-gateway", discovery: false, peers: [] },
    executor: { enabled: true, allowedRoots: [source] },
    distributedExecution: { enabled: true, commandPolicy: "trusted" },
  }));

  const sharedEnv = {
    GATEWAY_CONFIG_PATH: gatewayConfig,
    GATEWAY_DB_PATH: dbPath,
    DEVBENCH_CONFIG_PATH: market,
    DEVBENCH_LOCAL_PROJECTS_PATH: localProjects,
    DEVBENCH_STORE_DIR: storeDir,
    AIEFFICIENCY_CLONE_PARENT: cloneParent,
    DEVBENCH_SYNC_SCOPE: `lease-test-${Date.now()}`,
    DEVBENCH_WORKTREE_LEASE_TTL_MS: "5000",
    CLOUD_URL: "http://127.0.0.1:1",
  };
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  let gateway = bootGateway(port, sharedEnv);
  const holders = [];
  const orphanWorkerPids = [];
  t.after(async () => {
    for (const pid of orphanWorkerPids) killPidTree(pid);
    for (const holder of holders) {
      if (holder.exitCode === null) {
        try { holder.stdin.write("release\n"); } catch {}
        await stopChild(holder);
      }
    }
    await stopChild(gateway);
    try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch {}
  });
  await waitHealth(baseUrl, gateway);

  const created = await api(baseUrl, "POST", "/tabs", { title: "跨 Gateway 清理门禁" });
  assert.equal(created.ok, true, created.error);
  const tab = created.data;
  const worktreePath = tab.worktree.entries.find((entry) => entry.role === "primary").worktreePath;
  assert.equal(fs.existsSync(worktreePath), true);
  const mismatchedAgentRun = await api(baseUrl, "POST", "/agent-run", {
    task: "不得运行",
    tabId: tab.id,
    root: source,
  });
  assert.equal(mismatchedAgentRun.status, 403);
  assert.equal(mismatchedAgentRun.code, "AGENT_ROOT_TAB_MISMATCH");

  const aiHolder = startLeaseHolder({ env: sharedEnv, tab });
  holders.push(aiHolder);
  await waitLeaseReady(aiHolder);
  const inspection = await api(baseUrl, "GET", `/tabs/${tab.id}/worktree/cleanup-inspection`);
  assert.equal(inspection.ok, true, inspection.error);
  assert.equal(inspection.data.safe, false);
  assert.equal(inspection.data.forceAllowed, false);
  assert.equal(inspection.data.blockers.some((item) => item.type === "running_task"), true);

  const blockedCleanup = await api(
    baseUrl,
    "POST",
    `/tabs/${tab.id}/worktree/cleanup`,
    { token: inspection.data.token },
  );
  assert.equal(blockedCleanup.status, 409);
  assert.equal(blockedCleanup.code, "WORKTREE_CLEANUP_BLOCKED");
  assert.equal(fs.existsSync(worktreePath), true, "跨 Gateway AI 活跃时不得删除 worktree");

  await stopChild(gateway);
  gateway = bootGateway(port, sharedEnv);
  await waitHealth(baseUrl, gateway);
  const afterRestart = await api(baseUrl, "GET", `/tabs/${tab.id}/worktree/cleanup-inspection`);
  assert.equal(afterRestart.data.forceAllowed, false, "Gateway 重启不得清空其它进程的活动租约");
  const listed = await api(baseUrl, "GET", "/tabs");
  assert.equal(listed.data.find((item) => item.id === tab.id).runningTaskId, "foreign-runtime-task");

  aiHolder.stdin.write("release\n");
  await new Promise((resolve) => aiHolder.once("exit", resolve));
  const ready = await api(baseUrl, "GET", `/tabs/${tab.id}/worktree/cleanup-inspection`);
  assert.equal(ready.data.forceAllowed, true, JSON.stringify(ready.data));
  assert.equal(fs.existsSync(worktreePath), true);

  const artifactScope = {
    kind: "story",
    id: tab.id,
    title: tab.title,
    docSlug: tab.docSlug || storyDocSlug(tab.title),
  };
  const processArgs = {
    path: source,
    command: `"${process.execPath}" -e "setInterval(() => {}, 1000)"`,
    purpose: "keep cleanup blocked after API answer",
    max_minutes: 1,
  };
  const staleTaskId = `stale-api-background-${Date.now()}`;
  const staleHolder = startLeaseHolder({
    env: sharedEnv,
    tab,
    kind: "stale",
    taskId: staleTaskId,
  });
  holders.push(staleHolder);
  await waitLeaseReady(staleHolder);
  const staleSameTaskId = await executorApi(
    baseUrl,
    "start_process",
    processArgs,
    artifactScope,
    staleTaskId,
  );
  assert.equal(staleSameTaskId.ok, false);
  assert.match(staleSameTaskId.error || "", /活动 AI\/worktree 租约/);
  staleHolder.stdin.write("release\n");
  await new Promise((resolve) => staleHolder.once("exit", resolve));

  const backgroundTaskId = `api-background-${Date.now()}`;
  const backgroundHolder = startLeaseHolder({
    env: sharedEnv,
    tab,
    taskId: backgroundTaskId,
  });
  holders.push(backgroundHolder);
  await waitLeaseReady(backgroundHolder);
  const missingTaskId = await executorApi(
    baseUrl,
    "start_process",
    processArgs,
    artifactScope,
  );
  assert.equal(missingTaskId.ok, false);
  assert.match(missingTaskId.error || "", /taskId/);
  const mismatchedTaskId = await executorApi(
    baseUrl,
    "start_process",
    processArgs,
    artifactScope,
    `${backgroundTaskId}-forged`,
  );
  assert.equal(mismatchedTaskId.ok, false);
  assert.match(mismatchedTaskId.error || "", /taskId.*不一致/);

  const startedProcess = await executorApi(
    baseUrl,
    "start_process",
    processArgs,
    artifactScope,
    backgroundTaskId,
  );
  assert.equal(startedProcess.ok, true, startedProcess.error || JSON.stringify(startedProcess));
  const processInfo = JSON.parse(startedProcess.result);
  assert.equal(processInfo.status, "running");
  assert.equal(
    fs.existsSync(path.join(
      cloneParent,
      "AllDocs",
      "StoryDev",
      artifactScope.docSlug,
      "tempFiles",
      "api-tool-processes",
      `${processInfo.process_id}.json`,
    )),
    true,
  );

  // Simulate the API model returning its final answer. runningTaskId is cleared
  // and the original AI lease receives its normal release request, but the
  // start_process worker is still alive and must retain the physical worktree.
  backgroundHolder.stdin.write("release-hold\n");
  const releaseDeadline = Date.now() + 10_000;
  while (!backgroundHolder._output().stdout.includes("LEASE_RELEASED") && Date.now() < releaseDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.match(backgroundHolder._output().stdout, /LEASE_RELEASED/);
  const tabsAfterAnswer = await api(baseUrl, "GET", "/tabs");
  assert.equal(tabsAfterAnswer.data.find((item) => item.id === tab.id).runningTaskId, null);

  const backgroundInspection = await api(baseUrl, "GET", `/tabs/${tab.id}/worktree/cleanup-inspection`);
  assert.equal(backgroundInspection.ok, true, backgroundInspection.error);
  assert.equal(backgroundInspection.data.safe, false);
  assert.equal(backgroundInspection.data.forceAllowed, false);
  assert.equal(
    backgroundInspection.data.blockers.some((item) => item.type === "running_task"),
    true,
    JSON.stringify(backgroundInspection.data),
  );
  assert.equal(fs.existsSync(worktreePath), true);

  const stoppedProcess = await executorApi(baseUrl, "stop_process", {
    path: source,
    process_id: processInfo.process_id,
  }, artifactScope, backgroundTaskId);
  assert.equal(stoppedProcess.ok, true, stoppedProcess.error || JSON.stringify(stoppedProcess));
  let afterBackgroundExit;
  const cleanupReadyDeadline = Date.now() + 12_000;
  while (Date.now() < cleanupReadyDeadline) {
    afterBackgroundExit = await api(baseUrl, "GET", `/tabs/${tab.id}/worktree/cleanup-inspection`);
    if (afterBackgroundExit.data?.forceAllowed === true) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.equal(afterBackgroundExit.data.forceAllowed, true, JSON.stringify(afterBackgroundExit.data));
  assert.equal(fs.existsSync(worktreePath), true, "后台进程停止后的回归测试不得实际删除 worktree");
  backgroundHolder.stdin.write("exit\n");
  await new Promise((resolve) => backgroundHolder.once("exit", resolve));

  const cleanupHolder = startLeaseHolder({ env: sharedEnv, tab, kind: "cleanup" });
  holders.push(cleanupHolder);
  await waitLeaseReady(cleanupHolder);
  const blockedSend = await api(baseUrl, "POST", `/tabs/${tab.id}/send`, { content: "不得启动" });
  assert.equal(blockedSend.ok, false);
  assert.match(blockedSend.error || "", /worktree 正在清理|其它 AI 任务、清理或重建/);
  cleanupHolder.stdin.write("release\n");
  await new Promise((resolve) => cleanupHolder.once("exit", resolve));

  const orphanHolder = startLeaseHolder({
    env: sharedEnv,
    tab,
    taskId: "orphan-runtime-task",
    orphanWorker: true,
  });
  holders.push(orphanHolder);
  await waitLeaseReady(orphanHolder);
  const orphanWorkerPid = workerPidFrom(orphanHolder);
  assert.ok(orphanWorkerPid > 0);
  orphanWorkerPids.push(orphanWorkerPid);
  orphanHolder.stdin.write("orphan\n");
  await new Promise((resolve) => orphanHolder.once("exit", resolve));
  const staleInspection = await api(baseUrl, "GET", `/tabs/${tab.id}/worktree/cleanup-inspection`);
  assert.equal(staleInspection.data.forceAllowed, false, "崩溃后 TTL 内仍应保守阻断");
  await new Promise((resolve) => setTimeout(resolve, 5500));
  const afterExpiry = await api(baseUrl, "GET", `/tabs/${tab.id}/worktree/cleanup-inspection`);
  assert.equal(afterExpiry.data.forceAllowed, false, "租约过期但真实 AI 子进程存活时仍须阻断");
  killPidTree(orphanWorkerPid);
  await new Promise((resolve) => setTimeout(resolve, 500));
  const afterWorkerExit = await api(baseUrl, "GET", `/tabs/${tab.id}/worktree/cleanup-inspection`);
  assert.equal(afterWorkerExit.data.forceAllowed, true, JSON.stringify(afterWorkerExit.data));
  assert.equal(fs.existsSync(worktreePath), true, "测试全过程不得执行实际清理");
});
