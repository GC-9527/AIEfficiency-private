import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import Database from "better-sqlite3";

const gatewayDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const apiToolsUrl = pathToFileURL(path.join(gatewayDir, "services", "api-tools.js")).href;
const sqliteUrl = pathToFileURL(path.join(gatewayDir, "db", "sqlite.js")).href;
const agentRunnerUrl = pathToFileURL(path.join(gatewayDir, "services", "agent-runner.js")).href;

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function killPidTree(pid) {
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

function isolatedEnvironment(prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const configPath = path.join(root, "gateway.json");
  const dbPath = path.join(root, "gateway.db");
  const tempRoot = path.join(root, "story-temp");
  fs.mkdirSync(tempRoot, { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify({
    workDir: root,
    apiAgent: { workspaceIsolation: true, commandPolicy: "workspace" },
  }));
  return {
    root,
    dbPath,
    tempRoot,
    env: {
      ...process.env,
      GATEWAY_CONFIG_PATH: configPath,
      GATEWAY_DB_PATH: dbPath,
      API_TOOLS_URL: apiToolsUrl,
      SQLITE_URL: sqliteUrl,
      AGENT_RUNNER_URL: agentRunnerUrl,
      TEST_ROOT: root,
      TEST_TEMP_ROOT: tempRoot,
    },
  };
}

function runModuleScript(source, env, { timeout = 30_000, expectedExitCode = 0 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", source], {
      cwd: gatewayDir,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    const timer = setTimeout(() => {
      killPidTree(child.pid);
      reject(new Error(`host timeout\n${stderr || stdout}`));
    }, timeout);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      if (code !== expectedExitCode) {
        reject(new Error(`unexpected host exit ${code}\n${stderr || stdout}`));
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

function lastJsonLine(stdout) {
  const lines = String(stdout || "").trim().split(/\r?\n/).filter(Boolean);
  assert.ok(lines.length, "host did not return JSON");
  return JSON.parse(lines.at(-1));
}

test("故事点 start_process 预登记失败时不创建 supervisor 或真实命令", { timeout: 20_000 }, async (t) => {
  const fixture = isolatedEnvironment("api-process-reservation-");
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  const result = await runModuleScript(`
    import fs from "node:fs";
    import path from "node:path";
    const tools = await import(process.env.API_TOOLS_URL);
    const runtimeDb = await import(process.env.SQLITE_URL);
    const marker = path.join(process.env.TEST_ROOT, "must-not-exist.txt");
    const writer = path.join(process.env.TEST_ROOT, "writer.mjs");
    fs.writeFileSync(writer, \`fs.writeFileSync(\${JSON.stringify(marker)}, "spawned");\\n\`, "utf8");
    const ctx = {
      cwd: process.env.TEST_ROOT,
      allowedRoots: [],
      tempRoot: process.env.TEST_TEMP_ROOT,
      workspaceIsolation: true,
      commandPolicy: "workspace",
      artifactScope: { kind: "story" },
      storyTaskId: "reservation-failure-story",
    };
    runtimeDb.default.pragma("query_only = ON");
    const raw = await tools.executeTool("start_process", {
      command: JSON.stringify(process.execPath) + " " + JSON.stringify(writer),
      max_minutes: 1,
    }, ctx);
    runtimeDb.default.pragma("query_only = OFF");
    await new Promise((resolve) => setTimeout(resolve, 750));
    process.stdout.write(JSON.stringify({
      raw,
      markerExists: fs.existsSync(marker),
      leases: runtimeDb.listTaskRuntimeLeases("reservation-failure-story").length,
    }) + "\\n");
  `, fixture.env);
  const evidence = lastJsonLine(result.stdout);
  assert.match(evidence.raw, /无法预登记故事点后台进程运行租约/);
  assert.equal(evidence.markerExists, false);
  assert.equal(evidence.leases, 0);
});

test("supervisor 身份写回失败时启动门闩阻止真实命令并在退出后释放预留", { timeout: 25_000 }, async (t) => {
  const fixture = isolatedEnvironment("api-process-registration-");
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  const result = await runModuleScript(`
    import fs from "node:fs";
    import path from "node:path";
    const tools = await import(process.env.API_TOOLS_URL);
    const runtimeDb = await import(process.env.SQLITE_URL);
    const marker = path.join(process.env.TEST_ROOT, "must-not-run.txt");
    const writer = path.join(process.env.TEST_ROOT, "writer-after-reservation.mjs");
    fs.writeFileSync(writer, \`fs.writeFileSync(\${JSON.stringify(marker)}, "spawned");\\n\`, "utf8");
    runtimeDb.default.exec(\`
      CREATE TRIGGER reject_runtime_worker_registration
      BEFORE UPDATE OF worker_pid ON task_runtime_leases
      WHEN NEW.worker_pid IS NOT NULL
      BEGIN
        SELECT RAISE(ABORT, 'worker registration rejected by test');
      END;
    \`);
    const taskId = "registration-failure-story";
    const raw = await tools.executeTool("start_process", {
      command: JSON.stringify(process.execPath) + " " + JSON.stringify(writer),
      max_minutes: 1,
    }, {
      cwd: process.env.TEST_ROOT,
      allowedRoots: [],
      tempRoot: process.env.TEST_TEMP_ROOT,
      workspaceIsolation: true,
      commandPolicy: "workspace",
      artifactScope: { kind: "story" },
      storyTaskId: taskId,
    });
    await new Promise((resolve) => setTimeout(resolve, 1500));
    process.stdout.write(JSON.stringify({
      raw,
      markerExists: fs.existsSync(marker),
      leases: runtimeDb.listTaskRuntimeLeases(taskId).length,
    }) + "\\n");
  `, fixture.env);
  const evidence = lastJsonLine(result.stdout);
  assert.match(evidence.raw, /无法建立故事点后台进程运行租约/);
  assert.equal(evidence.markerExists, false);
  assert.equal(evidence.leases, 0);
});

test("shell leader 退出后 supervisor 排空顽固后台子进程才释放故事点租约", { timeout: 40_000 }, async (t) => {
  const fixture = isolatedEnvironment("api-process-drain-");
  let supervisorPid = 0;
  let backgroundPid = 0;
  t.after(() => {
    if (supervisorPid) killPidTree(supervisorPid);
    if (backgroundPid) killPidTree(backgroundPid);
    fs.rmSync(fixture.root, { recursive: true, force: true });
  });
  const result = await runModuleScript(`
    import fs from "node:fs";
    import path from "node:path";
    const tools = await import(process.env.API_TOOLS_URL);
    const runtimeDb = await import(process.env.SQLITE_URL);
    const background = path.join(process.env.TEST_ROOT, "background.mjs");
    const leader = path.join(process.env.TEST_ROOT, "leader.mjs");
    fs.writeFileSync(background, [
      "process.on('SIGTERM', () => {});",
      "setInterval(() => {}, 1000);",
    ].join("\\n"), "utf8");
    fs.writeFileSync(leader, [
      "import { spawn } from 'node:child_process';",
      \`const child = spawn(process.execPath, [\${JSON.stringify(background)}], { detached: true, stdio: "ignore", windowsHide: true });\`,
      "child.unref();",
      "process.stdout.write('BACKGROUND_PID:' + child.pid + '\\\\n');",
      "setTimeout(() => process.exit(0), 50);",
    ].join("\\n"), "utf8");
    const taskId = "leader-exit-story";
    const ctx = {
      cwd: process.env.TEST_ROOT,
      allowedRoots: [],
      tempRoot: process.env.TEST_TEMP_ROOT,
      workspaceIsolation: true,
      commandPolicy: "workspace",
      artifactScope: { kind: "story" },
      storyTaskId: taskId,
    };
    const started = JSON.parse(await tools.executeTool("start_process", {
      command: JSON.stringify(process.execPath) + " " + JSON.stringify(leader),
      max_minutes: 1,
    }, ctx));
    let registered = runtimeDb.listTaskRuntimeLeases(taskId);
    for (let i = 0; i < 40 && !registered[0]?.worker_identity; i++) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      registered = runtimeDb.listTaskRuntimeLeases(taskId);
    }
    let output = "";
    let terminal = null;
    for (let i = 0; i < 300; i++) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      terminal = JSON.parse(await tools.executeTool("poll_process", {
        process_id: started.process_id,
      }, ctx));
      if (terminal.output !== "(no new output)") output += terminal.output;
      if (!terminal.running) break;
    }
    const match = output.match(/BACKGROUND_PID:(\\d+)/);
    process.stdout.write(JSON.stringify({
      supervisorPid: started.pid,
      backgroundPid: Number(match?.[1] || 0),
      status: terminal?.status,
      registeredPid: Number(registered[0]?.worker_pid || 0),
      registeredIdentity: String(registered[0]?.worker_identity || ""),
      leasesAfter: runtimeDb.listTaskRuntimeLeases(taskId).length,
    }) + "\\n");
  `, fixture.env, { timeout: 35_000 });
  const evidence = lastJsonLine(result.stdout);
  supervisorPid = evidence.supervisorPid;
  backgroundPid = evidence.backgroundPid;
  assert.equal(evidence.status, "completed", result.stderr);
  assert.ok(backgroundPid > 0, result.stderr || result.stdout);
  assert.equal(evidence.registeredPid, supervisorPid);
  assert.ok(evidence.registeredIdentity);
  assert.equal(evidence.leasesAfter, 0);
  assert.equal(isAlive(backgroundPid), false, `background process ${backgroundPid} survived supervisor close`);
});

test("Gateway owner 硬退出后 API supervisor 与后台命令收敛，过期租约可恢复清除", { timeout: 45_000 }, async (t) => {
  const fixture = isolatedEnvironment("api-process-owner-crash-");
  let supervisorPid = 0;
  let workerPid = 0;
  t.after(() => {
    if (supervisorPid) killPidTree(supervisorPid);
    if (workerPid) killPidTree(workerPid);
    fs.rmSync(fixture.root, { recursive: true, force: true });
  });
  const crashed = await runModuleScript(`
    import fs from "node:fs";
    import path from "node:path";
    const tools = await import(process.env.API_TOOLS_URL);
    const runtimeDb = await import(process.env.SQLITE_URL);
    const worker = path.join(process.env.TEST_ROOT, "worker.mjs");
    fs.writeFileSync(worker, "process.stdout.write('WORKER_PID:' + process.pid + '\\\\n'); setInterval(() => {}, 1000);\\n", "utf8");
    const taskId = "owner-crash-story";
    const ctx = {
      cwd: process.env.TEST_ROOT,
      allowedRoots: [],
      tempRoot: process.env.TEST_TEMP_ROOT,
      workspaceIsolation: true,
      commandPolicy: "workspace",
      artifactScope: { kind: "story" },
      storyTaskId: taskId,
    };
    const started = JSON.parse(await tools.executeTool("start_process", {
      command: JSON.stringify(process.execPath) + " " + JSON.stringify(worker),
      max_minutes: 1,
    }, ctx));
    let output = "";
    let workerPid = 0;
    for (let i = 0; i < 200 && !workerPid; i++) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      const polled = JSON.parse(await tools.executeTool("poll_process", {
        process_id: started.process_id,
      }, ctx));
      if (polled.output !== "(no new output)") output += polled.output;
      workerPid = Number(output.match(/WORKER_PID:(\\d+)/)?.[1] || 0);
    }
    let lease = runtimeDb.listTaskRuntimeLeases(taskId)[0];
    for (let i = 0; i < 40 && !lease?.worker_identity; i++) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      lease = runtimeDb.listTaskRuntimeLeases(taskId)[0];
    }
    process.stdout.write(JSON.stringify({
      supervisorPid: started.pid,
      workerPid,
      leaseIdentity: String(lease?.worker_identity || ""),
    }) + "\\n", () => setTimeout(() => process.reallyExit(73), 50));
  `, fixture.env, { timeout: 25_000, expectedExitCode: 73 });
  const evidence = lastJsonLine(crashed.stdout);
  supervisorPid = evidence.supervisorPid;
  workerPid = evidence.workerPid;
  assert.ok(supervisorPid > 0 && workerPid > 0 && evidence.leaseIdentity, crashed.stderr || crashed.stdout);

  const deadline = Date.now() + 12_000;
  while ((isAlive(supervisorPid) || isAlive(workerPid)) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.equal(isAlive(supervisorPid), false, `supervisor ${supervisorPid} survived owner crash`);
  assert.equal(isAlive(workerPid), false, `worker ${workerPid} survived owner crash`);

  const db = new Database(fixture.dbPath);
  db.prepare("UPDATE task_runtime_leases SET expires_at = 0 WHERE task_id = ?").run("owner-crash-story");
  db.close();
  const recovered = await runModuleScript(`
    const runner = await import(process.env.AGENT_RUNNER_URL);
    const runtimeDb = await import(process.env.SQLITE_URL);
    const summary = runner.reconcileStaleRuntimeStates();
    process.stdout.write(JSON.stringify({
      summary,
      leasesAfter: runtimeDb.listTaskRuntimeLeases("owner-crash-story").length,
    }) + "\\n");
  `, fixture.env);
  const recovery = lastJsonLine(recovered.stdout);
  assert.equal(recovery.leasesAfter, 0);
  assert.ok(recovery.summary.settled >= 1);
});

test("Unix 故事点 start_process 拒绝显式 setsid 逃逸监督组", {
  skip: process.platform === "win32",
  timeout: 15_000,
}, async (t) => {
  const fixture = isolatedEnvironment("api-process-setsid-");
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  const result = await runModuleScript(`
    const tools = await import(process.env.API_TOOLS_URL);
    const runtimeDb = await import(process.env.SQLITE_URL);
    const raw = await tools.executeTool("start_process", {
      command: "setsid sh -c 'sleep 30'",
      max_minutes: 1,
    }, {
      cwd: process.env.TEST_ROOT,
      allowedRoots: [],
      tempRoot: process.env.TEST_TEMP_ROOT,
      workspaceIsolation: true,
      commandPolicy: "workspace",
      artifactScope: { kind: "story" },
      storyTaskId: "setsid-story",
    });
    process.stdout.write(JSON.stringify({
      raw,
      leases: runtimeDb.listTaskRuntimeLeases("setsid-story").length,
    }) + "\\n");
  `, fixture.env);
  const evidence = lastJsonLine(result.stdout);
  assert.match(evidence.raw, /禁止可脱离监督进程组/);
  assert.equal(evidence.leases, 0);
});
