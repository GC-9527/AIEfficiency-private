"use strict";

const { execFile, execFileSync } = require("node:child_process");
const path = require("node:path");
const util = require("node:util");

const execFileAsync = util.promisify(execFile);

// Merely requiring better-sqlite3 does not load its native .node binding.
// Opening an in-memory database forces the ABI-sensitive native module to load.
const BETTER_SQLITE3_SMOKE_SCRIPT = [
  "const Database = require('better-sqlite3');",
  "const database = new Database(':memory:');",
  "const result = database.prepare('SELECT 1 AS ok').get();",
  "if (!result || result.ok !== 1) throw new Error('better-sqlite3 smoke query failed');",
  "database.close();",
].join("");

async function verifyBetterSqliteRuntime(nodeExecutable, gatewayDirectory, options = {}) {
  const run = options.execFileAsync || execFileAsync;
  return run(
    nodeExecutable,
    ["-e", BETTER_SQLITE3_SMOKE_SCRIPT],
    {
      cwd: gatewayDirectory,
      timeout: options.timeout || 15000,
      windowsHide: true,
    },
  );
}

function verifyBetterSqliteRuntimeSync(nodeExecutable, gatewayDirectory, options = {}) {
  const run = options.execFileSync || execFileSync;
  return run(
    nodeExecutable,
    ["-e", BETTER_SQLITE3_SMOKE_SCRIPT],
    {
      cwd: gatewayDirectory,
      encoding: "utf8",
      stdio: options.stdio || "pipe",
      timeout: options.timeout || 15000,
      windowsHide: true,
    },
  );
}

function packagedGatewayPaths(appOutDir, platform = process.platform) {
  const resourcesDirectory = platform === "darwin"
    ? path.join(appOutDir, "Contents", "Resources")
    : path.join(appOutDir, "resources");
  return {
    gatewayDirectory: path.join(resourcesDirectory, "gateway"),
    nodeExecutable: platform === "win32"
      ? path.join(resourcesDirectory, "node-runtime", "node.exe")
      : path.join(resourcesDirectory, "node-runtime", "bin", "node"),
  };
}

module.exports = {
  BETTER_SQLITE3_SMOKE_SCRIPT,
  packagedGatewayPaths,
  verifyBetterSqliteRuntime,
  verifyBetterSqliteRuntimeSync,
};
