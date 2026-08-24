"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { prepareGateway } = require("./prepare-gateway.js");

function writeFile(root, relativePath, content = "") {
  const target = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content, "utf8");
}

test("Service Control Gateway bundle includes the sanitized AppMarket MCP runtime", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "service-control-mcp-bundle-"));
  const controllerDir = path.join(root, "service-control-electron");
  const sourceDirectory = path.join(root, "gateway");
  const mcpSourceDirectory = path.join(root, "mcp-servers", "devServer");
  const destinationDirectory = path.join(controllerDir, "gateway-bundled");
  try {
    writeFile(sourceDirectory, "server.js", "console.log('gateway');\n");
    writeFile(sourceDirectory, "node_modules/@modelcontextprotocol/sdk/package.json", "{}\n");
    writeFile(sourceDirectory, "node_modules/zod/package.json", "{}\n");
    writeFile(mcpSourceDirectory, "package.json", '{"name":"appmarket-admin-readonly-mcp-server"}\n');
    writeFile(mcpSourceDirectory, "src/index.js", "console.log('mcp');\n");
    writeFile(mcpSourceDirectory, ".env", "TOKEN=must-not-copy\n");

    prepareGateway({
      controllerDir,
      repoRoot: root,
      sourceDirectory,
      appMarketMcpSourceDirectory: mcpSourceDirectory,
      destinationDirectory,
    });

    assert.equal(fs.existsSync(path.join(destinationDirectory, "mcp-servers", "devServer", "src", "index.js")), true);
    assert.equal(fs.existsSync(path.join(destinationDirectory, "mcp-servers", "devServer", ".env")), false);
    assert.equal(fs.existsSync(path.join(destinationDirectory, "node_modules", "@modelcontextprotocol", "sdk", "package.json")), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Service Control bundle fails closed when the AppMarket MCP package is absent", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "service-control-mcp-missing-"));
  const sourceDirectory = path.join(root, "gateway");
  try {
    writeFile(sourceDirectory, "server.js", "console.log('gateway');\n");
    fs.mkdirSync(path.join(sourceDirectory, "node_modules"), { recursive: true });
    assert.throws(
      () => prepareGateway({
        controllerDir: path.join(root, "service-control-electron"),
        repoRoot: root,
        sourceDirectory,
        appMarketMcpSourceDirectory: path.join(root, "missing-mcp"),
      }),
      /AppMarket MCP source is missing required file/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Service Control preserves the previous bundle when the Gateway SQLite ABI is stale", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "service-control-sqlite-bundle-"));
  const controllerDir = path.join(root, "service-control-electron");
  const sourceDirectory = path.join(root, "gateway");
  const destinationDirectory = path.join(controllerDir, "gateway-bundled");
  const mcpSourceDirectory = path.join(root, "mcp-servers", "devServer");
  try {
    writeFile(sourceDirectory, "server.js", "console.log('gateway');\n");
    writeFile(sourceDirectory, "package.json", JSON.stringify({
      dependencies: { "better-sqlite3": "12.8.0" },
    }));
    writeFile(sourceDirectory, "node_modules/better-sqlite3/package.json", JSON.stringify({
      name: "better-sqlite3",
      main: "index.js",
    }));
    writeFile(
      sourceDirectory,
      "node_modules/better-sqlite3/index.js",
      "throw new Error('better_sqlite3.node was compiled against NODE_MODULE_VERSION 127; this Node.js requires NODE_MODULE_VERSION 137');\n",
    );
    writeFile(mcpSourceDirectory, "package.json", '{"name":"appmarket-admin-readonly-mcp-server"}\n');
    writeFile(mcpSourceDirectory, "src/index.js", "console.log('mcp');\n");
    writeFile(destinationDirectory, "last-known-good.txt", "keep\n");

    assert.throws(
      () => prepareGateway({
        controllerDir,
        repoRoot: root,
        sourceDirectory,
        appMarketMcpSourceDirectory: mcpSourceDirectory,
        destinationDirectory,
      }),
      /Cannot package Gateway.*NODE_MODULE_VERSION 127/s,
    );
    assert.equal(fs.readFileSync(path.join(destinationDirectory, "last-known-good.txt"), "utf8"), "keep\n");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
