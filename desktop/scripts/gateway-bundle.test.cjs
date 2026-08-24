"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  assertPathInside,
  installProductionDependencies,
  prepareGatewayBundle,
} = require("./gateway-bundle.cjs");

function writeFile(root, relativePath, content = "") {
  const target = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content, "utf8");
}

test("clean Gateway staging never copies source node_modules or local secrets", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "desktop-gateway-bundle-"));
  const desktopDirectory = path.join(root, "desktop");
  const sourceDirectory = path.join(root, "gateway");
  const appMarketMcpSourceDirectory = path.join(root, "mcp-servers", "devServer");
  const destinationDirectory = path.join(desktopDirectory, "gateway-bundled");
  fs.mkdirSync(desktopDirectory, { recursive: true });
  writeFile(sourceDirectory, "server.js", "console.log('gateway');\n");
  writeFile(sourceDirectory, "package.json", "{}\n");
  writeFile(sourceDirectory, "package-lock.json", "{}\n");
  writeFile(appMarketMcpSourceDirectory, "package.json", '{"name":"appmarket-admin-readonly-mcp-server"}\n');
  writeFile(appMarketMcpSourceDirectory, "src/index.js", "console.log('mcp');\n");
  writeFile(appMarketMcpSourceDirectory, ".env", "PASSWORD=must-not-copy\n");
  writeFile(sourceDirectory, "config.json", '{"secret":true}\n');
  writeFile(sourceDirectory, ".env", "TOKEN=secret\n");
  writeFile(
    sourceDirectory,
    "node_modules/better-sqlite3/stale-native.node",
    "old ABI",
  );

  const verifiedDirectories = [];
  try {
    const result = prepareGatewayBundle({
      desktopDirectory,
      destinationDirectory,
      appMarketMcpSourceDirectory,
      installDependencies: (stagingDirectory) => {
        assert.equal(
          fs.existsSync(path.join(
            stagingDirectory,
            "node_modules",
            "better-sqlite3",
            "stale-native.node",
          )),
          false,
        );
        writeFile(
          stagingDirectory,
          "node_modules/better-sqlite3/runtime.js",
          "module.exports = true;\n",
        );
        writeFile(
          stagingDirectory,
          "node_modules/example/tests/example.test.js",
          "throw new Error('must not be packaged');\n",
        );
        writeFile(
          stagingDirectory,
          "node_modules/example/index.js",
          "module.exports = true;\n",
        );
        writeFile(
          stagingDirectory,
          "node_modules/@modelcontextprotocol/sdk/package.json",
          "{}\n",
        );
        writeFile(stagingDirectory, "node_modules/zod/package.json", "{}\n");
      },
      nodeExecutable: "pinned-node",
      sourceDirectory,
      verifyRuntime: (nodeExecutable, gatewayDirectory) => {
        assert.equal(nodeExecutable, "pinned-node");
        assert.ok(fs.existsSync(path.join(
          gatewayDirectory,
          "node_modules",
          "better-sqlite3",
          "runtime.js",
        )));
        verifiedDirectories.push(gatewayDirectory);
      },
    });

    assert.equal(result.destinationDirectory, destinationDirectory);
    assert.equal(verifiedDirectories.length, 2);
    assert.equal(fs.existsSync(path.join(destinationDirectory, "config.json")), false);
    assert.equal(fs.existsSync(path.join(destinationDirectory, ".env")), false);
    assert.equal(fs.existsSync(path.join(
      destinationDirectory,
      "mcp-servers",
      "devServer",
      "src",
      "index.js",
    )), true);
    assert.equal(fs.existsSync(path.join(
      destinationDirectory,
      "mcp-servers",
      "devServer",
      ".env",
    )), false);
    assert.equal(fs.existsSync(path.join(
      destinationDirectory,
      "node_modules",
      "better-sqlite3",
      "stale-native.node",
    )), false);
    assert.equal(fs.existsSync(path.join(
      destinationDirectory,
      "node_modules",
      "example",
      "tests",
    )), false);
    assert.equal(fs.existsSync(path.join(
      destinationDirectory,
      "node_modules",
      "example",
      "index.js",
    )), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Gateway bundle destination must stay inside the selected Desktop workspace", () => {
  assert.throws(
    () => assertPathInside("C:\\desktop", "C:\\outside"),
    /Refusing to prepare Gateway outside/,
  );
});

test("clean npm staging forces lifecycle scripts to use the pinned Node executable", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "desktop-gateway-npm-"));
  const nodeExecutable = path.join(root, "runtime", "node.exe");
  const npmExecPath = path.join(root, "npm-cli.js");
  writeFile(root, "runtime/node.exe");
  writeFile(root, "npm-cli.js");
  const calls = [];
  try {
    installProductionDependencies(root, {
      env: { Path: "C:\\other-node" },
      nodeExecutable,
      npmExecPath,
      spawnSync: (...args) => {
        calls.push(args);
        return { status: 0 };
      },
      stdio: "pipe",
    });

    assert.equal(calls.length, 1);
    assert.equal(calls[0][0], nodeExecutable);
    assert.deepEqual(calls[0][1], [
      npmExecPath,
      "ci",
      "--omit=dev",
      "--no-audit",
      "--no-fund",
    ]);
    assert.equal(calls[0][2].env.npm_node_execpath, nodeExecutable);
    assert.equal(
      calls[0][2].env.Path.startsWith(`${path.dirname(nodeExecutable)}${path.delimiter}`),
      true,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
