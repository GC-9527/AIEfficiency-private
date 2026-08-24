import fs from "node:fs";
import path from "node:path";
import { spawnSync, execFile } from "node:child_process";

const IDENTITY_QUERY_TIMEOUT_MS = 10_000;
const WINDOWS_SYSTEM_ROOT = process.platform === "win32"
  ? path.win32.resolve(String(
      process.env.SystemRoot || `${process.env.SystemDrive || "C:"}\\Windows`,
    ))
  : "";
const WINDOWS_POWERSHELL_PATH = process.platform === "win32"
  && path.win32.basename(WINDOWS_SYSTEM_ROOT).toLowerCase() === "windows"
  ? path.win32.resolve(
      WINDOWS_SYSTEM_ROOT,
      "System32",
      "WindowsPowerShell",
      "v1.0",
      "powershell.exe",
    )
  : "";

function validPid(value) {
  const pid = Number(value);
  return Number.isInteger(pid) && pid > 0 ? pid : 0;
}

export function isProcessAlive(pidValue) {
  const pid = validPid(pidValue);
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function linuxProcessIdentity(pid) {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    const commandEnd = stat.lastIndexOf(")");
    if (commandEnd < 0) return "";
    // /proc/<pid>/stat 的右括号之后从 field 3(state) 开始；field 22(starttime)
    // 因此在剩余字段数组中的下标为 19。
    const fields = stat.slice(commandEnd + 1).trim().split(/\s+/);
    const startedAtTicks = String(fields[19] || "").trim();
    if (!/^\d+$/.test(startedAtTicks)) return "";
    let bootId = "";
    try { bootId = fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim(); } catch {}
    return `linux:${bootId || "unknown-boot"}:${startedAtTicks}`;
  } catch {
    return "";
  }
}

function windowsProcessIdentity(pid) {
  return "";
}

function windowsProcessIdentityAsync(pid) {
  return new Promise((resolve) => {
    if (!WINDOWS_POWERSHELL_PATH) return resolve("");
    const script = [
      `$p = Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}" -ErrorAction Stop`,
      "if ($null -eq $p -or $null -eq $p.CreationDate) { exit 3 }",
      "$p.CreationDate.ToUniversalTime().Ticks",
    ].join("; ");
    execFile(
      WINDOWS_POWERSHELL_PATH,
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
      {
        encoding: "utf8",
        windowsHide: true,
        timeout: IDENTITY_QUERY_TIMEOUT_MS,
        maxBuffer: 1024 * 1024,
      },
      (error, stdout) => {
        if (error) return resolve("");
        const ticks = String(stdout || "").trim().split(/\r?\n/).at(-1)?.trim() || "";
        resolve(/^\d+$/.test(ticks) ? `win:${ticks}` : "");
      },
    );
  });
}

function portableProcessIdentity(pid) {
  return "";
}

function portableProcessIdentityAsync(pid) {
  return new Promise((resolve) => {
    execFile(
      "ps",
      ["-p", String(pid), "-o", "lstart="],
      {
        encoding: "utf8",
        timeout: IDENTITY_QUERY_TIMEOUT_MS,
        maxBuffer: 1024 * 1024,
      },
      (error, stdout) => {
        if (error) return resolve("");
        const startedAt = String(stdout || "").replace(/\s+/g, " ").trim();
        resolve(startedAt ? `${process.platform}:${startedAt}` : "");
      },
    );
  });
}

/**
 * 返回 PID 对应进程的不可变启动身份。PID 会复用，单独保存 PID 不足以证明
 * 租约过期后仍是原 worker；启动身份用于在过期租约上做二次核验。
 *
 * 同步版本在 Windows/macOS 上返回 ""（身份未知），不阻塞事件循环。
 * 旧行为使用 spawnSync("powershell") 可阻塞 10s，导致 /api/health 超时。
 * 异步版本 captureProcessIdentityAsync 使用 execFile，不阻塞事件循环。
 */
export function captureProcessIdentity(pidValue) {
  const pid = validPid(pidValue);
  if (!pid || !isProcessAlive(pid)) return "";
  if (process.platform === "linux") return linuxProcessIdentity(pid);
  return "";
}

export async function captureProcessIdentityAsync(pidValue) {
  const pid = validPid(pidValue);
  if (!pid || !isProcessAlive(pid)) return "";
  if (process.platform === "win32") return windowsProcessIdentityAsync(pid);
  if (process.platform === "linux") return linuxProcessIdentity(pid);
  return portableProcessIdentityAsync(pid);
}

function windowsProcessIdentitySync(pid) {
  if (!WINDOWS_POWERSHELL_PATH) return "";
  const script = [
    `$p = Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}" -ErrorAction Stop`,
    "if ($null -eq $p -or $null -eq $p.CreationDate) { exit 3 }",
    "$p.CreationDate.ToUniversalTime().Ticks",
  ].join("; ");
  try {
    const result = spawnSync(
      WINDOWS_POWERSHELL_PATH,
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
      {
        encoding: "utf8",
        windowsHide: true,
        timeout: IDENTITY_QUERY_TIMEOUT_MS,
        maxBuffer: 1024 * 1024,
      },
    );
    const ticks = String(result.stdout || "").trim().split(/\r?\n/).at(-1)?.trim() || "";
    return !result.error && result.status === 0 && /^\d+$/.test(ticks)
      ? `win:${ticks}`
      : "";
  } catch {
    return "";
  }
}

function portableProcessIdentitySync(pid) {
  try {
    const result = spawnSync(
      "ps",
      ["-p", String(pid), "-o", "lstart="],
      {
        encoding: "utf8",
        timeout: IDENTITY_QUERY_TIMEOUT_MS,
        maxBuffer: 1024 * 1024,
      },
    );
    const startedAt = String(result.stdout || "").replace(/\s+/g, " ").trim();
    return !result.error && result.status === 0 && startedAt
      ? `${process.platform}:${startedAt}`
      : "";
  } catch {
    return "";
  }
}

/**
 * 同步阻塞版进程身份查询，仅供独立子进程（cli-supervisor / process-watchdog）使用。
 * 这些进程不服务 HTTP 请求，阻塞自身事件循环是安全的。
 * 网关主进程应使用 captureProcessIdentity（快速，不阻塞）或 captureProcessIdentityAsync。
 */
export function captureProcessIdentitySync(pidValue) {
  const pid = validPid(pidValue);
  if (!pid || !isProcessAlive(pid)) return "";
  if (process.platform === "win32") return windowsProcessIdentitySync(pid);
  if (process.platform === "linux") return linuxProcessIdentity(pid);
  return portableProcessIdentitySync(pid);
}

export function identityObservationKeepsLease(expectedIdentity, actualIdentity) {
  const expected = String(expectedIdentity || "").trim();
  if (!expected) return false;
  const actual = String(actualIdentity || "").trim();
  // 已登记身份的新 worker 在查询暂时失败时保守保护，下次请求/定时恢复会重试；
  // 只有成功读到不同启动身份时才能证明 PID 已被复用。
  if (!actual) return true;
  return actual === expected;
}

/**
 * PID 已死亡时返回 false；PID 存活且成功读取身份时严格比较。
 * 已登记身份但本次查询失败时保守返回 true，避免临时 CIM/procfs 故障误删真实孤儿。
 * 没有身份的兼容旧行在原租约 TTL 到期后不得仅凭 PID 继续阻断。
 */
export function isSameLiveProcess(pidValue, expectedIdentity) {
  const expected = String(expectedIdentity || "").trim();
  if (!expected || !isProcessAlive(pidValue)) return false;
  const actual = captureProcessIdentity(pidValue);
  return identityObservationKeepsLease(expected, actual);
}

export async function isSameLiveProcessAsync(pidValue, expectedIdentity) {
  const expected = String(expectedIdentity || "").trim();
  if (!expected || !isProcessAlive(pidValue)) return false;
  const actual = await captureProcessIdentityAsync(pidValue);
  return identityObservationKeepsLease(expected, actual);
}
