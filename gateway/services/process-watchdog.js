import { spawn } from "node:child_process";
import { captureProcessIdentityAsync } from "./process-identity.js";

let currentProcessIdentity = "";

function encodedIdentity(value) {
  return Buffer.from(String(value || ""), "utf8").toString("base64url");
}

async function watchdogIdentity(pid, provided = "") {
  const explicit = String(provided || "").trim();
  if (explicit) return explicit;
  if (Number(pid) === process.pid) {
    if (!currentProcessIdentity) currentProcessIdentity = await captureProcessIdentityAsync(process.pid);
    return currentProcessIdentity;
  }
  return captureProcessIdentityAsync(pid);
}

/**
 * 启动一个脱离 Gateway 的极小看门狗。Gateway 被强制结束时，看门狗会在
 * worktree 租约 TTL 到期前终止仍存活的 CLI 进程树，避免旧 AI 与清理并发写目录。
 */
export async function startProcessTreeWatchdog(
  workerPid,
  parentPid = process.pid,
  { workerIdentity = "", parentIdentity = "" } = {},
) {
  const worker = Number(workerPid);
  const parent = Number(parentPid);
  if (!Number.isInteger(worker) || worker <= 0 || !Number.isInteger(parent) || parent <= 0) {
    return null;
  }
  const expectedWorkerIdentity = process.platform === "win32"
    ? await watchdogIdentity(worker, workerIdentity)
    : "";
  const expectedParentIdentity = process.platform === "win32"
    ? await watchdogIdentity(parent, parentIdentity)
    : "";
  // A PID without an immutable identity cannot be killed safely after expiry:
  // it may already belong to an unrelated process. The supervisor/owner pipe
  // and persisted runtime lease remain the fail-closed protection.
  if (process.platform === "win32"
    && (!expectedWorkerIdentity || !expectedParentIdentity)) {
    return null;
  }
  const script = String.raw`
    const { spawnSync } = require("node:child_process");
    const parentPid = Number(process.argv[1]);
    const workerPid = Number(process.argv[2]);
    const expectedWorkerIdentity = Buffer.from(
      String(process.argv[3] || ""),
      "base64url",
    ).toString("utf8");
    const expectedParentIdentity = Buffer.from(
      String(process.argv[4] || ""),
      "base64url",
    ).toString("utf8");
    const IDENTITY_CHECK_MS = 5000;
    const alive = (pid) => {
      try { process.kill(pid, 0); return true; }
      catch (error) { return error && error.code === "EPERM"; }
    };
    const groupAlive = (pid) => {
      if (process.platform === "win32") return alive(pid);
      try { process.kill(-pid, 0); return true; }
      catch (error) { return error && error.code === "EPERM"; }
    };
    const windowsIdentity = (pid) => {
      const script = [
        '$p = Get-CimInstance Win32_Process -Filter "ProcessId = ' + pid + '" -ErrorAction Stop',
        "if ($null -eq $p -or $null -eq $p.CreationDate) { exit 3 }",
        "$p.CreationDate.ToUniversalTime().Ticks",
      ].join("; ");
      try {
        const result = spawnSync(
          "powershell.exe",
          ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
          {
            encoding: "utf8",
            windowsHide: true,
            timeout: 10000,
            maxBuffer: 1024 * 1024,
          },
        );
        const ticks = String(result.stdout || "")
          .trim()
          .split(/\r?\n/)
          .at(-1)?.trim() || "";
        return !result.error && result.status === 0 && /^\d+$/.test(ticks)
          ? "win:" + ticks
          : "";
      } catch {
        return "";
      }
    };
    const identityMatches = (pid, expected) => {
      if (process.platform !== "win32") return true;
      const actual = windowsIdentity(pid);
      if (!actual) return null;
      return actual === expected;
    };
    const killWorker = () => {
      try {
        if (process.platform === "win32") {
          // Never send taskkill unless the PID still has the exact immutable
          // identity captured at watchdog construction time.
          if (identityMatches(workerPid, expectedWorkerIdentity) !== true) {
            return false;
          }
          spawnSync("taskkill", ["/pid", String(workerPid), "/t", "/f"], {
            stdio: "ignore",
            windowsHide: true,
            timeout: 10000,
          });
        } else {
          try { process.kill(-workerPid, "SIGTERM"); }
          catch { try { process.kill(workerPid, "SIGTERM"); } catch {} }
        }
        return true;
      } catch {
        return false;
      }
    };
    const finish = (code = 0) => process.exit(code);
    const ownerGone = () => {
      clearInterval(timer);
      const killed = killWorker();
      if (!killed) {
        finish();
        return;
      }
      setTimeout(() => {
        if (groupAlive(workerPid) && process.platform !== "win32") {
          try { process.kill(-workerPid, "SIGKILL"); }
          catch { try { process.kill(workerPid, "SIGKILL"); } catch {} }
        }
        finish();
      }, 1000);
    };
    let lastParentIdentityCheck = 0;
    const timer = setInterval(() => {
      if (!alive(parentPid)) {
        ownerGone();
        return;
      }
      if (!groupAlive(workerPid)) {
        clearInterval(timer);
        finish();
        return;
      }
      if (process.platform === "win32"
        && Date.now() - lastParentIdentityCheck >= IDENTITY_CHECK_MS) {
        lastParentIdentityCheck = Date.now();
        const parentMatch = identityMatches(parentPid, expectedParentIdentity);
        if (parentMatch === false) ownerGone();
      }
    }, 500);
    if (process.platform === "win32") {
      const workerMatch = identityMatches(workerPid, expectedWorkerIdentity);
      const parentMatch = identityMatches(parentPid, expectedParentIdentity);
      if (workerMatch === false) {
        clearInterval(timer);
        finish(91);
      } else if (workerMatch == null) {
        clearInterval(timer);
        finish(92);
      } else if (parentMatch === false) {
        ownerGone();
      }
      // A temporary parent identity query failure does not authorize a kill.
      // The cheap PID check continues and the next low-frequency check retries.
    }
  `;
  try {
    const watchdog = spawn(
      process.execPath,
      [
        "-e",
        script,
        String(parent),
        String(worker),
        encodedIdentity(expectedWorkerIdentity),
        encodedIdentity(expectedParentIdentity),
      ],
      {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
      },
    );
    watchdog.unref();
    return watchdog;
  } catch {
    return null;
  }
}
