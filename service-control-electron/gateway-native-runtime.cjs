"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { execFile, spawnSync } = require("node:child_process");
const { promisify } = require("node:util");

const execFileAsync = promisify(execFile);
const DEFAULT_PROBE_TIMEOUT_MS = 15_000;
const SQLITE_PROBE_SOURCE = String.raw`
const Database = require("better-sqlite3");
const db = new Database(":memory:");
try {
  db.prepare("SELECT 1 AS ok").get();
} finally {
  db.close();
}
`;

function gatewayUsesBetterSqlite3(gatewayDirectory) {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(gatewayDirectory, "package.json"), "utf8"));
    return !!(pkg.dependencies?.["better-sqlite3"] || pkg.optionalDependencies?.["better-sqlite3"]);
  } catch {
    return false;
  }
}

function compactDetail(...values) {
  const lines = values
    .filter(Boolean)
    .join("\n")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  return [...new Set(lines)].slice(0, 12).join(" ");
}

function asyncFailureDetail(error) {
  return compactDetail(error?.stderr, error?.stdout, error?.message);
}

function syncFailureDetail(result) {
  return compactDetail(result?.stderr, result?.stdout, result?.error?.message);
}

function isRepairableSqliteBindingFailure(detail) {
  return /ERR_DLOPEN_FAILED|NODE_MODULE_VERSION|better_sqlite3\.node|Could not locate the bindings file|was compiled against a different Node\.js version/i.test(
    String(detail || ""),
  );
}

function probeArgs() {
  return ["-e", SQLITE_PROBE_SOURCE];
}

async function probeGatewaySqlite({
  nodeExecutable,
  gatewayDirectory,
  execute = execFileAsync,
  timeoutMs = DEFAULT_PROBE_TIMEOUT_MS,
} = {}) {
  if (!nodeExecutable) throw new Error("Node executable is required for the Gateway SQLite preflight.");
  if (!gatewayDirectory) throw new Error("Gateway directory is required for the SQLite preflight.");
  try {
    await execute(nodeExecutable, probeArgs(), {
      cwd: gatewayDirectory,
      timeout: timeoutMs,
      windowsHide: true,
      maxBuffer: 1024 * 1024,
    });
    return { ok: true, detail: "" };
  } catch (error) {
    const detail = asyncFailureDetail(error) || "SQLite probe exited without diagnostics";
    return {
      ok: false,
      detail,
      repairable: isRepairableSqliteBindingFailure(detail),
    };
  }
}

function probeGatewaySqliteSync({
  nodeExecutable,
  gatewayDirectory,
  execute = spawnSync,
  timeoutMs = DEFAULT_PROBE_TIMEOUT_MS,
} = {}) {
  if (!nodeExecutable) throw new Error("Node executable is required for the Gateway SQLite preflight.");
  if (!gatewayDirectory) throw new Error("Gateway directory is required for the SQLite preflight.");
  const result = execute(nodeExecutable, probeArgs(), {
    cwd: gatewayDirectory,
    timeout: timeoutMs,
    windowsHide: true,
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
  });
  if (!result.error && result.status === 0) return { ok: true, detail: "" };
  const detail = syncFailureDetail(result) || `SQLite probe exited with code ${result.status}`;
  return {
    ok: false,
    detail,
    repairable: isRepairableSqliteBindingFailure(detail),
  };
}

async function ensureGatewaySqliteRuntime({
  nodeExecutable,
  gatewayDirectory,
  rebuild,
  execute,
  timeoutMs,
} = {}) {
  const initial = await probeGatewaySqlite({
    nodeExecutable,
    gatewayDirectory,
    execute,
    timeoutMs,
  });
  if (initial.ok) return { ok: true, repaired: false };
  if (!initial.repairable) {
    throw new Error(`Gateway SQLite runtime preflight failed before startup: ${initial.detail}`);
  }
  if (typeof rebuild !== "function") {
    throw new Error(
      `Gateway SQLite native binding is incompatible with the selected Node runtime and cannot be repaired automatically: ${initial.detail}`,
    );
  }

  await rebuild(initial);
  const repaired = await probeGatewaySqlite({
    nodeExecutable,
    gatewayDirectory,
    execute,
    timeoutMs,
  });
  if (!repaired.ok) {
    throw new Error(
      `Gateway SQLite runtime is still incompatible after rebuilding better-sqlite3: ${repaired.detail}`,
    );
  }
  return { ok: true, repaired: true };
}

function assertGatewaySqliteBundleCompatible({
  nodeExecutable = process.execPath,
  gatewayDirectory,
  execute,
  timeoutMs,
} = {}) {
  if (!gatewayUsesBetterSqlite3(gatewayDirectory)) return { ok: true, skipped: true };
  const result = probeGatewaySqliteSync({
    nodeExecutable,
    gatewayDirectory,
    execute,
    timeoutMs,
  });
  if (!result.ok) {
    throw new Error(
      `Cannot package Gateway: better-sqlite3 does not load with ${nodeExecutable}. `
      + `Rebuild Gateway dependencies with the packaging Node runtime first. ${result.detail}`,
    );
  }
  return { ok: true, skipped: false };
}

module.exports = {
  SQLITE_PROBE_SOURCE,
  assertGatewaySqliteBundleCompatible,
  ensureGatewaySqliteRuntime,
  gatewayUsesBetterSqlite3,
  isRepairableSqliteBindingFailure,
  probeGatewaySqlite,
  probeGatewaySqliteSync,
};
