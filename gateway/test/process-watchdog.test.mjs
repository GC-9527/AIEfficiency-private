import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const gatewayDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const watchdogUrl = pathToFileURL(path.join(gatewayDir, "services", "process-watchdog.js")).href;
const supervisorPath = path.join(gatewayDir, "services", "cli-supervisor.js");

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

test("Gateway 宿主硬退出后看门狗终止遗留 CLI 进程树", { timeout: 20_000 }, async (t) => {
  const holderScript = `
    const { spawn } = await import("node:child_process");
    const { startProcessTreeWatchdog } = await import(process.env.WATCHDOG_URL);
    const worker = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    worker.unref();
    startProcessTreeWatchdog(worker.pid, process.pid);
    process.stdout.write("WORKER_PID:" + worker.pid + "\\n");
    setTimeout(() => process.reallyExit(77), 100);
  `;
  const holder = spawn(process.execPath, ["--input-type=module", "-e", holderScript], {
    cwd: gatewayDir,
    env: { ...process.env, WATCHDOG_URL: watchdogUrl },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let stdout = "";
  let stderr = "";
  holder.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
  holder.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
  await new Promise((resolve, reject) => {
    holder.once("exit", resolve);
    holder.once("error", reject);
  });
  const match = stdout.match(/WORKER_PID:(\d+)/);
  assert.ok(match, stderr || stdout);
  const workerPid = Number(match[1]);
  t.after(() => killPidTree(workerPid));
  const deadline = Date.now() + 7000;
  while (isAlive(workerPid) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.equal(isAlive(workerPid), false, `遗留 CLI ${workerPid} 未被看门狗终止`);
});

test("Windows watchdog 发现 worker PID 身份不一致时绝不 taskkill", {
  skip: process.platform !== "win32",
  timeout: 20_000,
}, async (t) => {
  const holderScript = `
    const { spawn } = await import("node:child_process");
    const { startProcessTreeWatchdog } = await import(process.env.WATCHDOG_URL);
    const worker = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    worker.unref();
    const watchdog = startProcessTreeWatchdog(worker.pid, process.pid, {
      workerIdentity: "win:1",
    });
    if (!watchdog) {
      process.stderr.write("WATCHDOG_NULL\\n");
      process.exit(2);
    }
    watchdog.ref();
    process.stdout.write("WORKER_PID:" + worker.pid + "\\n");
    watchdog.once("exit", (code) => {
      process.stdout.write("WATCHDOG_EXIT:" + code + "\\n", () => process.reallyExit(79));
    });
  `;
  const holder = spawn(process.execPath, ["--input-type=module", "-e", holderScript], {
    cwd: gatewayDir,
    env: { ...process.env, WATCHDOG_URL: watchdogUrl },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let stdout = "";
  let stderr = "";
  holder.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
  holder.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
  const exitCode = await new Promise((resolve, reject) => {
    holder.once("exit", resolve);
    holder.once("error", reject);
  });
  const workerPid = Number(stdout.match(/WORKER_PID:(\d+)/)?.[1] || 0);
  if (workerPid > 0) t.after(() => killPidTree(workerPid));
  assert.equal(exitCode, 79, stderr || stdout);
  assert.match(stdout, /WATCHDOG_EXIT:91/, stderr || stdout);
  assert.ok(workerPid > 0, stderr || stdout);
  assert.equal(isAlive(workerPid), true, "身份不一致的 PID 被 watchdog 误杀");
});

test("生产 CLI 监督器先建立监控再启动 shell，并在 Gateway 硬退出后终止孙进程", { timeout: 25_000 }, async (t) => {
  const hostScript = `
    const { spawn } = await import("node:child_process");
    const { startProcessTreeWatchdog } = await import(process.env.WATCHDOG_URL);
    const commandScript = [
      "const { spawn } = require('node:child_process');",
      "const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true });",
      "process.stdout.write('GRANDCHILD_PID:' + grandchild.pid + '\\\\n');",
      "setInterval(() => {}, 1000);",
    ].join("");
    const payload = Buffer.from(JSON.stringify({
      command: process.execPath,
      args: ["-e", commandScript],
      parentPid: process.pid,
    }), "utf8").toString("base64url");
    const supervisor = spawn(process.execPath, [process.env.SUPERVISOR_PATH, payload], {
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    startProcessTreeWatchdog(supervisor.pid, process.pid);
    supervisor.stderr.pipe(process.stderr);
    let buffer = "";
    supervisor.stdout.on("data", (chunk) => {
      buffer += chunk.toString();
      const match = buffer.match(/GRANDCHILD_PID:(\\d+)/);
      if (!match) return;
      process.stdout.write("SUPERVISOR_PID:" + supervisor.pid + "\\n" + match[0] + "\\n");
      setTimeout(() => process.reallyExit(78), 50);
    });
  `;
  const host = spawn(process.execPath, ["--input-type=module", "-e", hostScript], {
    cwd: gatewayDir,
    env: {
      ...process.env,
      WATCHDOG_URL: watchdogUrl,
      SUPERVISOR_PATH: supervisorPath,
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let stdout = "";
  let stderr = "";
  host.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
  host.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
  await new Promise((resolve, reject) => {
    host.once("exit", resolve);
    host.once("error", reject);
  });
  const supervisorMatch = stdout.match(/SUPERVISOR_PID:(\d+)/);
  const grandchildMatch = stdout.match(/GRANDCHILD_PID:(\d+)/);
  assert.ok(supervisorMatch && grandchildMatch, stderr || stdout);
  const supervisorPid = Number(supervisorMatch[1]);
  const grandchildPid = Number(grandchildMatch[1]);
  t.after(() => {
    killPidTree(supervisorPid);
    killPidTree(grandchildPid);
  });
  const deadline = Date.now() + 10_000;
  while ((isAlive(supervisorPid) || isAlive(grandchildPid)) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.equal(isAlive(supervisorPid), false, "CLI 监督器未在 Gateway 硬退出后结束");
  assert.equal(isAlive(grandchildPid), false, "CLI 孙进程未随监督器终止");
});

test("Windows CLI 监督器把 stdin EOF 透传给 shell 命令", {
  skip: process.platform !== "win32",
  timeout: 20_000,
}, async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cli-supervisor-stdin-eof-"));
  const readerPath = path.join(tempDir, "stdin-reader.mjs");
  fs.writeFileSync(
    readerPath,
    [
      'let input = "";',
      'process.stdin.setEncoding("utf8");',
      'process.stdin.on("data", (chunk) => { input += chunk; });',
      'process.stdin.on("end", () => {',
      '  const expected = `prompt-start:${"x".repeat(96 * 1024)}:prompt-end`;',
      '  const exact = input === expected || (input.length === expected.length + 1 && input.slice(1) === expected);',
      '  process.stdout.write(`STDIN_EOF:${input.length}:${exact}\\n`);',
      '});',
    ].join("\n"),
    "utf8",
  );
  const payload = Buffer.from(JSON.stringify({
    // codex/claude 在 Windows 上通过同一 shell-backed 分支启动。
    command: "node",
    args: [readerPath],
    parentPid: process.pid,
  }), "utf8").toString("base64url");
  const supervisor = spawn(process.execPath, [supervisorPath, payload], {
    detached: true,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  let stdout = "";
  let stderr = "";
  supervisor.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
  supervisor.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
  t.after(() => {
    killPidTree(supervisor.pid);
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const prompt = `prompt-start:${"x".repeat(96 * 1024)}:prompt-end`;
  supervisor.stdin.end(prompt);
  const exitResult = await Promise.race([
    new Promise((resolve, reject) => {
      supervisor.once("exit", (code, signal) => resolve({ code, signal }));
      supervisor.once("error", reject);
    }),
    new Promise((_, reject) => {
      setTimeout(() => reject(new Error(`stdin EOF 透传测试超时: ${stderr || stdout}`)), 12_000).unref();
    }),
  ]);

  assert.equal(exitResult.signal, null, stderr);
  assert.equal(exitResult.code, 0, stderr);
  const eofMatch = stdout.match(/STDIN_EOF:(\d+):true/);
  assert.ok(eofMatch, stderr || stdout);
  assert.ok(
    [prompt.length, prompt.length + 1].includes(Number(eofMatch[1])),
    `stdin 长度异常: ${eofMatch[1]}`
  );
});

test("Windows controller 身份不一致时 supervisor 不会裸 PID taskkill", {
  skip: process.platform !== "win32",
  timeout: 20_000,
}, async (t) => {
  const startGateToken = "controller-identity-mismatch-test";
  const commandScript = [
    "process.stdout.write('CONTROLLER_CHILD_STARTED\\n');",
    "setTimeout(() => {",
    "  process.stdout.write('CONTROLLER_CHILD_COMPLETED\\n');",
    "  process.exit(0);",
    "}, 900);",
  ].join("");
  const payload = Buffer.from(JSON.stringify({
    command: process.execPath,
    args: ["-e", commandScript],
    parentPid: process.pid,
    startGateToken,
  }), "utf8").toString("base64url");
  const supervisor = spawn(process.execPath, [supervisorPath, payload], {
    detached: true,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
    env: {
      ...process.env,
      NODE_ENV: "test",
      AIEFF_TEST_CONTROLLER_IDENTITY_OVERRIDE: "win:1",
    },
  });
  let stdout = "";
  let stderr = "";
  let stopSent = false;
  supervisor.stdin.on("error", () => {});
  supervisor.stdout.on("data", (chunk) => {
    stdout += chunk.toString();
    if (!stopSent && stdout.includes("CONTROLLER_CHILD_STARTED")) {
      stopSent = true;
      supervisor.stdin.write(`STOP:${startGateToken}\n`);
    }
  });
  supervisor.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
  t.after(() => killPidTree(supervisor.pid));
  supervisor.stdin.write(`${startGateToken}\n`);

  const exitResult = await Promise.race([
    new Promise((resolve, reject) => {
      supervisor.once("exit", (code, signal) => resolve({ code, signal }));
      supervisor.once("error", reject);
    }),
    new Promise((_, reject) => {
      setTimeout(() => reject(new Error(`controller mismatch 测试超时: ${stderr || stdout}`)), 12_000).unref();
    }),
  ]);
  assert.equal(stopSent, true, stderr || stdout);
  assert.match(stderr, /identity_mismatch/);
  assert.match(stdout, /CONTROLLER_CHILD_COMPLETED/);
  assert.equal(exitResult.signal, null);
  assert.equal(exitResult.code, 143);
});

test("CLI leader 正常退出后监督器强制排空忽略 TERM 的脱离孙进程", { timeout: 30_000 }, async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cli-supervisor-drain-"));
  const grandchildScriptPath = path.join(tempDir, "grandchild.mjs");
  const leaderScriptPath = path.join(tempDir, "leader.mjs");
  fs.writeFileSync(
    grandchildScriptPath,
    "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);\n",
    "utf8",
  );
  fs.writeFileSync(
    leaderScriptPath,
    [
      'import { spawn } from "node:child_process";',
      `const grandchild = spawn(process.execPath, [${JSON.stringify(grandchildScriptPath)}], {`,
      '  detached: true, stdio: "ignore", windowsHide: true,',
      "});",
      "grandchild.unref();",
      'process.stdout.write(`GRANDCHILD_PID:${grandchild.pid}\\n`);',
      "setTimeout(() => process.exit(0), 50);",
    ].join("\n"),
    "utf8",
  );

  const payload = Buffer.from(JSON.stringify({
    // Windows production commands such as codex/claude use this shell-backed path.
    command: process.platform === "win32" ? "node" : process.execPath,
    args: [leaderScriptPath],
    parentPid: process.pid,
  }), "utf8").toString("base64url");
  const supervisor = spawn(process.execPath, [supervisorPath, payload], {
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let stdout = "";
  let stderr = "";
  let grandchildPid = 0;
  supervisor.stdout.on("data", (chunk) => {
    stdout += chunk.toString();
    const match = stdout.match(/GRANDCHILD_PID:(\d+)/);
    if (match) grandchildPid = Number(match[1]);
  });
  supervisor.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
  t.after(() => {
    killPidTree(supervisor.pid);
    if (grandchildPid) killPidTree(grandchildPid);
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const exitResult = await Promise.race([
    new Promise((resolve, reject) => {
      supervisor.once("exit", (code, signal) => resolve({ code, signal }));
      supervisor.once("error", reject);
    }),
    new Promise((_, reject) => {
      setTimeout(() => reject(new Error(`监督器未退出: ${stderr || stdout}`)), 20_000).unref();
    }),
  ]);
  assert.ok(grandchildPid > 0, JSON.stringify({ exitResult, stderr, stdout }));
  assert.equal(exitResult.signal, null, stderr);
  assert.equal(exitResult.code, 0, stderr);
  assert.equal(
    isAlive(grandchildPid),
    false,
    `${stderr}\n脱离孙进程 ${grandchildPid} 在监督器退出后仍存活`,
  );
});
