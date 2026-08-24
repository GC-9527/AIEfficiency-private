"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const {
  BETTER_SQLITE3_SMOKE_SCRIPT,
  packagedGatewayPaths,
  verifyBetterSqliteRuntime,
  verifyBetterSqliteRuntimeSync,
} = require("./gateway-runtime.cjs");

test("native Gateway smoke check opens a database instead of only requiring better-sqlite3", () => {
  assert.match(BETTER_SQLITE3_SMOKE_SCRIPT, /new Database\(':memory:'\)/);
  assert.match(BETTER_SQLITE3_SMOKE_SCRIPT, /SELECT 1 AS ok/);
  assert.match(BETTER_SQLITE3_SMOKE_SCRIPT, /database\.close\(\)/);
});

test("async native runtime check invokes the selected Node executable in the Gateway directory", async () => {
  const calls = [];
  await verifyBetterSqliteRuntime("portable-node", "gateway-dir", {
    execFileAsync: async (...args) => {
      calls.push(args);
      return { stdout: "", stderr: "" };
    },
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], "portable-node");
  assert.deepEqual(calls[0][1], ["-e", BETTER_SQLITE3_SMOKE_SCRIPT]);
  assert.equal(calls[0][2].cwd, "gateway-dir");
  assert.equal(calls[0][2].windowsHide, true);
});

test("packaged Gateway paths use the same resources tree as electron-builder", () => {
  assert.deepEqual(packagedGatewayPaths("C:\\app", "win32"), {
    gatewayDirectory: path.join("C:\\app", "resources", "gateway"),
    nodeExecutable: path.join("C:\\app", "resources", "node-runtime", "node.exe"),
  });
  assert.deepEqual(packagedGatewayPaths("/Applications/App.app", "darwin"), {
    gatewayDirectory: path.join("/Applications/App.app", "Contents", "Resources", "gateway"),
    nodeExecutable: path.join("/Applications/App.app", "Contents", "Resources", "node-runtime", "bin", "node"),
  });
});

test("current Gateway native dependency is compatible with the Node used for packaging", () => {
  const gatewayDirectory = path.resolve(__dirname, "..", "gateway");
  assert.doesNotThrow(() =>
    verifyBetterSqliteRuntimeSync(process.execPath, gatewayDirectory));
});

test("Desktop startup, clean Gateway staging, and afterPack all use the native runtime smoke check", () => {
  const desktopRoot = __dirname;
  const mainSource = fs.readFileSync(path.join(desktopRoot, "main.js"), "utf8");
  const dependencyManagerSource = fs.readFileSync(
    path.join(desktopRoot, "gateway-dependency-manager.cjs"),
    "utf8",
  );
  const prepareSource = fs.readFileSync(
    path.join(desktopRoot, "scripts", "prepare-gateway.js"),
    "utf8",
  );
  const bundleSource = fs.readFileSync(
    path.join(desktopRoot, "scripts", "gateway-bundle.cjs"),
    "utf8",
  );
  const afterPackSource = fs.readFileSync(
    path.join(desktopRoot, "scripts", "after-pack.cjs"),
    "utf8",
  );

  assert.match(mainSource, /ensureCompatibleGatewayDependencies\(\{/);
  assert.match(mainSource, /verifyBetterSqliteRuntimeSync\(nodeExe, USER_GATEWAY_DIR\)/);
  assert.doesNotMatch(mainSource, /-e "require\('better-sqlite3'\)"/);
  assert.match(dependencyManagerSource, /await verifyRuntime\(nodeExecutable, userGatewayDirectory\)/);
  assert.match(prepareSource, /prepareGatewayBundle\(\)/);
  assert.match(bundleSource, /verifyRuntime\(nodeExecutable, stagingDirectory\)/);
  assert.match(bundleSource, /verifyRuntime\(nodeExecutable, destinationDirectory\)/);
  assert.match(afterPackSource, /verifyBetterSqliteRuntimeSync\(nodeExecutable, gatewayDirectory/);
});
