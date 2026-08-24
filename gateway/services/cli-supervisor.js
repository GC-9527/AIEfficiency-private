import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { captureProcessIdentitySync as captureProcessIdentity } from "./process-identity.js";

const DISCOVERY_INTERVAL_MS = 500;
const TERMINATE_GRACE_MS = 1500;
const FORCE_RETRY_MS = 500;
const WINDOWS_TASKKILL_RETRY_MS = 2000;
const EMPTY_TREE_SETTLE_MS = process.platform === "win32" ? 500 : 250;
const WINDOWS_JOB_CONTROLLER_PATH = fileURLToPath(
  new URL("./windows-job-controller.ps1", import.meta.url),
);
const WINDOWS_JOB_LAUNCHER_PATH = fileURLToPath(
  new URL("./windows-job-launcher.js", import.meta.url),
);
const trackedProcesses = new Map();
let processTreeToken = "";

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function validPid(value) {
  const pid = Number(value);
  return Number.isInteger(pid) && pid > 0 ? pid : 0;
}

function parseWindowsProcessTable(stdout) {
  const records = new Map();
  for (const rawLine of String(stdout || "").split(/\r?\n/)) {
    const fields = rawLine.split(",").map((field) => field.trim());
    if (fields.length < 4) continue;
    const pid = validPid(fields.at(-1));
    const ppid = validPid(fields.at(-2));
    const created = String(fields.at(-3) || "");
    if (pid) records.set(pid, { pid, ppid, created, state: "" });
  }
  return records;
}

function queryWindowsProcessTable() {
  let result = spawnSync(
    "wmic.exe",
    ["process", "get", "CreationDate,ParentProcessId,ProcessId", "/format:csv"],
    {
      encoding: "utf8",
      windowsHide: true,
      timeout: 10_000,
      maxBuffer: 16 * 1024 * 1024,
    },
  );
  let records = parseWindowsProcessTable(result.stdout);
  if (!result.error && records.size) return records;

  const script = [
    "Get-CimInstance Win32_Process | ForEach-Object {",
    "  $created = if ($_.CreationDate) { $_.CreationDate.ToUniversalTime().Ticks } else { 0 };",
    "  Write-Output ('host,{0},{1},{2}' -f $created,$_.ParentProcessId,$_.ProcessId)",
    "}",
  ].join(" ");
  result = spawnSync(
    "powershell.exe",
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
    {
      encoding: "utf8",
      windowsHide: true,
      timeout: 15_000,
      maxBuffer: 16 * 1024 * 1024,
    },
  );
  records = parseWindowsProcessTable(result.stdout);
  return !result.error && records.size ? records : null;
}

function queryUnixProcessTable() {
  const result = spawnSync(
    "ps",
    ["-eo", "pid=,ppid=,pgid=,state=,lstart="],
    {
      encoding: "utf8",
      timeout: 10_000,
      maxBuffer: 16 * 1024 * 1024,
    },
  );
  if (result.error || !String(result.stdout || "").trim()) return null;
  const records = new Map();
  for (const rawLine of String(result.stdout).split(/\r?\n/)) {
    const match = rawLine.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.+)$/);
    if (!match) continue;
    const pid = validPid(match[1]);
    if (!pid || pid === result.pid) continue;
    records.set(pid, {
      pid,
      ppid: validPid(match[2]),
      pgid: validPid(match[3]),
      state: match[4],
      created: match[5].trim(),
    });
  }
  return records;
}

function sameProcess(tracked, current) {
  if (!tracked || !current) return false;
  return !tracked.created || !current.created || tracked.created === current.created;
}

function refreshTrackedProcesses({ includeTokenProcesses = false } = {}) {
  const records = process.platform === "win32"
    ? queryWindowsProcessTable()
    : queryUnixProcessTable();
  if (!records) return null;

  // Linux detached/setsid descendants retain the unique API process-tree
  // token even after PPID reparenting and process-group escape. Scan only while
  // draining/stopping to avoid a /proc walk every 500 ms during long builds.
  // This protects accidental daemonization; a hostile child can clear its env
  // and requires OS-level containment beyond this supervisor.
  if (includeTokenProcesses && process.platform === "linux" && processTreeToken) {
    const marker = `AIEFF_PROCESS_TREE_TOKEN=${processTreeToken}`;
    for (const record of records.values()) {
      if (record.pid === process.pid) continue;
      try {
        const environment = fs.readFileSync(`/proc/${record.pid}/environ`, "utf8");
        if (!environment.split("\0").includes(marker)) continue;
        if (!trackedProcesses.has(record.pid)) {
          trackedProcesses.set(record.pid, { created: record.created });
        }
      } catch {
        // Other-user/protected processes are not part of this inherited token.
      }
    }
  }

  for (const [pid, tracked] of trackedProcesses) {
    const current = records.get(pid);
    if (current && !tracked.created) tracked.created = current.created;
  }

  let changed = true;
  while (changed) {
    changed = false;
    for (const record of records.values()) {
      if (record.pid === process.pid) continue;
      if (process.platform !== "win32" && record.pgid === process.pid) {
        if (!trackedProcesses.has(record.pid)) {
          trackedProcesses.set(record.pid, { created: record.created });
          changed = true;
        }
        continue;
      }
      const parent = trackedProcesses.get(record.ppid);
      if (!parent) continue;
      const currentParent = records.get(record.ppid);
      if (currentParent && !sameProcess(parent, currentParent)) continue;
      if (!trackedProcesses.has(record.pid)) {
        trackedProcesses.set(record.pid, { created: record.created });
        changed = true;
      }
    }
  }

  const live = [];
  for (const [pid, tracked] of trackedProcesses) {
    const current = records.get(pid);
    if (!current || !sameProcess(tracked, current)) continue;
    if (String(current.state || "").toUpperCase().startsWith("Z")) continue;
    live.push(current);
  }
  return live;
}

function runWindowsTaskkill(pid, force, expectedIdentity) {
  const expected = String(expectedIdentity || "").trim();
  if (!expected) return { ok: false, reason: "identity_missing" };
  const actual = captureProcessIdentity(pid);
  if (!actual) return { ok: false, reason: "identity_query_failed" };
  if (actual !== expected) return { ok: false, reason: "identity_mismatch" };
  const args = ["/pid", String(pid), "/t"];
  if (force) args.push("/f");
  try {
    const result = spawnSync("taskkill.exe", args, {
      stdio: "ignore",
      windowsHide: true,
      timeout: 10_000,
    });
    return {
      ok: !result.error && result.status === 0,
      reason: result.error ? "taskkill_error" : (result.status === 0 ? "" : "taskkill_failed"),
    };
  } catch {
    return { ok: false, reason: "taskkill_error" };
  }
}

function signalProcessTree(processes, force) {
  const pids = [...new Set(processes.map((entry) => validPid(entry.pid)).filter(Boolean))];
  if (process.platform === "win32") {
    // Windows production children are contained by the controller's Job Object
    // and are terminated only through its identity-checked root path below.
    return;
  }
  const signal = force ? "SIGKILL" : "SIGTERM";
  for (const pid of pids.reverse()) {
    try { process.kill(pid, signal); } catch {}
  }
}

const encodedPayload = String(process.argv[2] || "");
let payload;
try {
  payload = JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8"));
} catch {
  process.stderr.write("CLI supervisor payload 无效\n");
  process.exit(125);
}

const parentPid = Number(payload.parentPid);
if (!alive(parentPid)) process.exit(126);
const startGateToken = String(payload.startGateToken || "");
const launchGateToken = String(payload.launchGateToken || "");
processTreeToken = String(payload.processTreeToken || "");

// The supervisor is the worker PID stored in the runtime lease. On Windows, its
// controller gates the real CLI until the launcher belongs to a kill-on-close
// Job Object. The supervisor exits only after that controller confirms the Job
// is empty, or after a stop path independently observes no surviving process.
let child = null;
let childRootPid = 0;
let childRootIdentity = "";
let stopping = false;
let desiredExitCode = 143;
let drainStartedAt = 0;
let lastForceAt = 0;
let drainTimer = null;
let warned = false;
let controllerKillWarning = "";

const windowsControllerExited = () => (
  !childRootPid
  || child?.exitCode !== null
  || child?.signalCode != null
  || !alive(childRootPid)
);

const requestWindowsControllerTermination = () => {
  if (windowsControllerExited()) return { ok: true, reason: "already_exited" };
  const result = runWindowsTaskkill(childRootPid, true, childRootIdentity);
  if (!result.ok && result.reason && controllerKillWarning !== result.reason) {
    controllerKillWarning = result.reason;
    process.stderr.write(`CLI controller 未执行 taskkill: ${result.reason}\n`);
  }
  return result;
};

const finish = () => {
  clearInterval(monitor);
  if (drainTimer) clearTimeout(drainTimer);
  try { process.stdin.unpipe(); } catch {}
  process.stdin.pause();
  process.exit(desiredExitCode);
};

const scheduleDrain = () => {
  if (drainTimer) clearTimeout(drainTimer);
  drainTimer = setTimeout(drain, 100);
};

const drain = () => {
  const now = Date.now();
  if (process.platform === "win32") {
    // The PowerShell controller owns a KILL_ON_JOB_CLOSE Job Object. Once that
    // controller has exited, the kernel has already terminated every process in
    // the Job, so WMI process-table discovery is both redundant and much slower.
    if (windowsControllerExited() && now - drainStartedAt >= EMPTY_TREE_SETTLE_MS) {
      finish();
      return;
    }
    if (now - lastForceAt >= WINDOWS_TASKKILL_RETRY_MS) {
      lastForceAt = now;
      requestWindowsControllerTermination();
    }
    scheduleDrain();
    return;
  }

  const live = refreshTrackedProcesses({ includeTokenProcesses: true });
  if (live && live.length === 0 && now - drainStartedAt >= EMPTY_TREE_SETTLE_MS) {
    finish();
    return;
  }
  if (live && live.length && now - drainStartedAt >= TERMINATE_GRACE_MS) {
    if (now - lastForceAt >= FORCE_RETRY_MS) {
      lastForceAt = now;
      signalProcessTree(live, true);
    }
  }
  if (!warned && now - drainStartedAt >= 10_000) {
    warned = true;
    process.stderr.write("CLI supervisor 尚未确认进程树清空，继续持有运行租约并重试\n");
  }
  scheduleDrain();
};

const stop = (code = 143) => {
  if (stopping) return;
  stopping = true;
  desiredExitCode = code;
  drainStartedAt = Date.now();
  try { process.stdin.unpipe(child?.stdin); } catch {}
  if (!childRootPid) {
    finish();
    return;
  }
  if (process.platform === "win32") {
    if (!windowsControllerExited()) {
      lastForceAt = Date.now();
      requestWindowsControllerTermination();
    }
  } else {
    const live = refreshTrackedProcesses({ includeTokenProcesses: true });
    if (live?.length) signalProcessTree(live, false);
  }
  scheduleDrain();
};

const monitor = setInterval(() => {
  if (process.platform !== "win32" && childRootPid && !stopping) refreshTrackedProcesses();
  if (!alive(parentPid)) stop(143);
}, DISCOVERY_INTERVAL_MS);

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => stop(143));
}

const launchChild = () => {
  if (stopping || !alive(parentPid)) {
    stop(126);
    return;
  }
  const windows = process.platform === "win32";
  const command = windows ? "powershell.exe" : String(payload.command || "");
  const args = windows
    ? [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        WINDOWS_JOB_CONTROLLER_PATH,
        encodedPayload,
        process.execPath,
        WINDOWS_JOB_LAUNCHER_PATH,
      ]
    : (Array.isArray(payload.args) ? payload.args : []);
  child = spawn(command, args, {
    cwd: process.cwd(),
    shell: false,
    windowsHide: true,
    env: {
      ...process.env,
      ...(processTreeToken
        ? { AIEFF_PROCESS_TREE_TOKEN: processTreeToken }
        : {}),
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  childRootPid = validPid(child.pid);
  if (childRootPid) {
    trackedProcesses.set(childRootPid, { created: "" });
    if (process.platform === "win32") {
      const testOverride = process.env.NODE_ENV === "test"
        ? String(process.env.AIEFF_TEST_CONTROLLER_IDENTITY_OVERRIDE || "").trim()
        : "";
      childRootIdentity = testOverride || captureProcessIdentity(childRootPid);
    } else {
      refreshTrackedProcesses();
    }
  }
  if (startGateToken || launchGateToken) {
    // API background commands are non-interactive. Keep stdin exclusively as a
    // supervisor control/liveness channel so STOP can drain the whole tree.
    // Agent CLI launches use a distinct gate and forward stdin after the
    // supervisor runtime lease has been registered.
    if (startGateToken) child.stdin.end();
  } else {
    process.stdin.pipe(child.stdin);
  }
  child.stdout.pipe(process.stdout);
  child.stderr.pipe(process.stderr);
  process.stdin.on("error", () => {});
  child.stdin.on("error", () => {});
  child.on("error", (error) => {
    process.stderr.write(`启动 CLI 失败: ${error.message}\n`);
    if (!childRootPid) {
      clearInterval(monitor);
      process.exit(127);
    }
    stop(127);
  });
  child.on("exit", (code, signal) => {
    if (stopping) return;
    stop(Number.isInteger(code) ? code : (signal ? 128 : 0));
  });
};

if (!alive(parentPid)) {
  stop(126);
} else if (launchGateToken) {
  let activated = false;
  let gateBuffer = Buffer.alloc(0);
  process.stdin.on("data", (chunk) => {
    if (activated) {
      if (child?.stdin?.writable) child.stdin.write(chunk);
      return;
    }
    gateBuffer = Buffer.concat([gateBuffer, Buffer.from(chunk)]);
    const newline = gateBuffer.indexOf(0x0a);
    if (newline < 0) {
      if (gateBuffer.length > 4096) {
        process.stderr.write("CLI supervisor 启动门闩头部过长\n");
        stop(125);
      }
      return;
    }
    const received = gateBuffer.subarray(0, newline).toString("utf8").replace(/\r$/, "");
    const remainder = gateBuffer.subarray(newline + 1);
    gateBuffer = Buffer.alloc(0);
    if (received !== `START:${launchGateToken}`) {
      process.stderr.write("CLI supervisor 启动门闩校验失败\n");
      stop(125);
      return;
    }
    activated = true;
    launchChild();
    if (remainder.length && child?.stdin?.writable) child.stdin.write(remainder);
  });
  process.stdin.once("end", () => {
    if (!activated) {
      stop(125);
      return;
    }
    if (child?.stdin?.writable) child.stdin.end();
  });
} else if (startGateToken) {
  let activated = false;
  let controlBuffer = "";
  process.stdin.on("data", (chunk) => {
    controlBuffer += String(chunk || "");
    let newline;
    while ((newline = controlBuffer.indexOf("\n")) >= 0) {
      const received = controlBuffer.slice(0, newline).replace(/\r$/, "");
      controlBuffer = controlBuffer.slice(newline + 1);
      if (!activated) {
        if (received !== startGateToken) {
          process.stderr.write("CLI supervisor 启动门闩校验失败\n");
          stop(125);
          return;
        }
        activated = true;
        launchChild();
        continue;
      }
      if (received === `STOP:${startGateToken}`) stop(143);
    }
  });
  process.stdin.once("end", () => {
    // API start_process keeps this owner pipe open. Gateway crash/restart closes
    // it even if the operating system has already reused the old parent PID.
    stop(143);
  });
} else {
  launchChild();
}
