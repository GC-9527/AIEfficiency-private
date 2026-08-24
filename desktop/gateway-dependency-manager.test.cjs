"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");

const {
  ensureCompatibleGatewayDependencies,
} = require("./gateway-dependency-manager.cjs");

function baseOptions(overrides = {}) {
  return {
    bundledGatewayDirectory: "bundled-gateway",
    copyDirectory: () => {},
    nodeExecutable: "portable-node",
    userGatewayDirectory: "user-gateway",
    ...overrides,
  };
}

test("compatible user Gateway dependencies are left untouched", async () => {
  let checks = 0;
  let copies = 0;
  let removals = 0;
  const result = await ensureCompatibleGatewayDependencies(baseOptions({
    copyDirectory: () => { copies += 1; },
    removeDirectory: () => { removals += 1; },
    verifyRuntime: async () => { checks += 1; },
  }));

  assert.deepEqual(result, { repaired: false });
  assert.equal(checks, 1);
  assert.equal(copies, 0);
  assert.equal(removals, 0);
});

test("an incompatible AppData dependency is replaced and verified again", async () => {
  const events = [];
  let checks = 0;
  const result = await ensureCompatibleGatewayDependencies(baseOptions({
    copyDirectory: (source, destination) =>
      events.push(["copy", source, destination]),
    onRepair: (error) => events.push(["repair", error.message]),
    pathExists: () => true,
    removeDirectory: (directory) => events.push(["remove", directory]),
    verifyRuntime: async () => {
      checks += 1;
      if (checks === 1) throw new Error("NODE_MODULE_VERSION 127, expected 137");
    },
  }));

  assert.deepEqual(result, { repaired: true });
  assert.deepEqual(events, [
    ["repair", "NODE_MODULE_VERSION 127, expected 137"],
    ["remove", path.join("user-gateway", "node_modules")],
    [
      "copy",
      path.join("bundled-gateway", "node_modules"),
      path.join("user-gateway", "node_modules"),
    ],
  ]);
  assert.equal(checks, 2);
});

test("repair fails clearly when the packaged dependency directory is missing", async () => {
  await assert.rejects(
    ensureCompatibleGatewayDependencies(baseOptions({
      pathExists: () => false,
      verifyRuntime: async () => { throw new Error("ABI mismatch"); },
    })),
    /Bundled Gateway node_modules was not found/,
  );
});

test("repair does not hide a packaged dependency that remains incompatible", async () => {
  let checks = 0;
  await assert.rejects(
    ensureCompatibleGatewayDependencies(baseOptions({
      pathExists: () => true,
      verifyRuntime: async () => {
        checks += 1;
        const error = new Error(checks === 1 ? "old ABI" : "packaged ABI is also bad");
        error.stderr = `check-${checks}`;
        throw error;
      },
    })),
    (error) => {
      assert.match(error.message, /still incompatible after replacement/);
      assert.equal(error.stderr, "check-2");
      assert.equal(error.initialError.message, "old ABI");
      return true;
    },
  );
});
