"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  assertGatewaySqliteBundleCompatible,
  ensureGatewaySqliteRuntime,
  probeGatewaySqlite,
} = require("../gateway-native-runtime.cjs");

function writeFile(root, relativePath, content) {
  const target = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content, "utf8");
}

function writeGatewayFixture(root, moduleSource) {
  writeFile(root, "package.json", JSON.stringify({
    dependencies: { "better-sqlite3": "12.8.0" },
  }));
  writeFile(root, "node_modules/better-sqlite3/package.json", JSON.stringify({
    name: "better-sqlite3",
    version: "12.8.0",
    main: "index.js",
  }));
  writeFile(root, "node_modules/better-sqlite3/index.js", moduleSource);
}

const incompatibleBindingSource = `
const error = new Error(
  "better_sqlite3.node was compiled against NODE_MODULE_VERSION 127; this Node.js requires NODE_MODULE_VERSION 137",
);
error.code = "ERR_DLOPEN_FAILED";
throw error;
`;

const compatibleBindingSource = `
module.exports = class Database {
  prepare() {
    return { get() { return { ok: 1 }; } };
  }
  close() {}
};
`;

test("Service Control repairs a stale better-sqlite3 ABI before Gateway startup", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "service-control-sqlite-abi-"));
  try {
    writeGatewayFixture(root, incompatibleBindingSource);
    const before = await probeGatewaySqlite({
      nodeExecutable: process.execPath,
      gatewayDirectory: root,
    });
    assert.equal(before.ok, false);
    assert.match(before.detail, /NODE_MODULE_VERSION 127/);

    let rebuilds = 0;
    const result = await ensureGatewaySqliteRuntime({
      nodeExecutable: process.execPath,
      gatewayDirectory: root,
      rebuild: async () => {
        rebuilds += 1;
        writeGatewayFixture(root, compatibleBindingSource);
      },
    });

    assert.equal(result.ok, true);
    assert.equal(result.repaired, true);
    assert.equal(rebuilds, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Service Control fails closed when rebuilding does not repair the SQLite binding", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "service-control-sqlite-stale-"));
  try {
    writeGatewayFixture(root, incompatibleBindingSource);
    await assert.rejects(
      ensureGatewaySqliteRuntime({
        nodeExecutable: process.execPath,
        gatewayDirectory: root,
        rebuild: async () => {},
      }),
      /still incompatible after rebuilding better-sqlite3.*NODE_MODULE_VERSION 127/s,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Service Control packaging rejects a Gateway SQLite binding for another Node ABI", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "service-control-sqlite-package-"));
  try {
    writeGatewayFixture(root, incompatibleBindingSource);
    assert.throws(
      () => assertGatewaySqliteBundleCompatible({
        nodeExecutable: process.execPath,
        gatewayDirectory: root,
      }),
      /Cannot package Gateway.*NODE_MODULE_VERSION 127/s,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
