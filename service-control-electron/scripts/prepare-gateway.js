"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { assertGatewaySqliteBundleCompatible } = require("../gateway-native-runtime.cjs");

const skippedNames = new Set([
  ".tmp",
  ".secrets",
  "config.json",
  "feedback-files",
  "knowledge",
  "scripts",
  "__tests__",
  "fixture",
  "fixtures",
  "test",
  "tests",
  "data.db",
  "data.db-shm",
  "data.db-wal",
]);

const skipPattern = /\.(db|db-wal|db-shm|db-journal|log|pem|key|p12|pfx|jks|keystore|mobileprovision|jar|zip|7z|rar|tar|gz|tgz)$/i;
const blockedFileNames = new Set([".env", "credentials.json", "id_ed25519", "id_rsa", "service-account.json"]);

function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const lowerName = entry.name.toLowerCase();
    if (skippedNames.has(entry.name) || blockedFileNames.has(lowerName) || lowerName.startsWith(".env.") || skipPattern.test(entry.name)) continue;
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    const isDependencyTestFile = srcPath.toLowerCase().includes(`${path.sep}node_modules${path.sep}`)
      && /(^|[._-])(test|tests|spec)([._-]|$)/i.test(entry.name);
    if (isDependencyTestFile) continue;
    if (entry.isDirectory()) copyDir(srcPath, destPath);
    else if (entry.isFile()) fs.copyFileSync(srcPath, destPath);
  }
}

function assertPathInside(rootDirectory, targetPath) {
  const relative = path.relative(path.resolve(rootDirectory), path.resolve(targetPath));
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`Refusing to prepare Gateway outside the Service Control workspace: ${targetPath}`);
  }
}

function verifyAppMarketMcpBundle(gatewayDirectory) {
  const required = [
    path.join("mcp-servers", "devServer", "package.json"),
    path.join("mcp-servers", "devServer", "src", "index.js"),
    path.join("node_modules", "@modelcontextprotocol", "sdk", "package.json"),
    path.join("node_modules", "zod", "package.json"),
  ];
  for (const relativePath of required) {
    if (!fs.existsSync(path.join(gatewayDirectory, relativePath))) {
      throw new Error(`Bundled Gateway AppMarket MCP runtime is incomplete: ${relativePath}`);
    }
  }
  const mcpPackage = JSON.parse(fs.readFileSync(
    path.join(gatewayDirectory, "mcp-servers", "devServer", "package.json"),
    "utf8",
  ));
  if (mcpPackage.name !== "appmarket-admin-readonly-mcp-server") {
    throw new Error("Bundled Gateway AppMarket MCP package name is invalid.");
  }
}

function prepareGateway(options = {}) {
  const controllerDir = path.resolve(options.controllerDir || path.join(__dirname, ".."));
  const repoRoot = path.resolve(options.repoRoot || path.join(controllerDir, ".."));
  const srcDir = path.resolve(options.sourceDirectory || path.join(repoRoot, "gateway"));
  const appMarketMcpSourceDirectory = path.resolve(
    options.appMarketMcpSourceDirectory || path.join(repoRoot, "mcp-servers", "devServer"),
  );
  const destDir = path.resolve(options.destinationDirectory || path.join(controllerDir, "gateway-bundled"));

  assertPathInside(controllerDir, destDir);

  if (!fs.existsSync(path.join(srcDir, "server.js"))) {
    throw new Error(`Gateway source not found: ${srcDir}`);
  }
  if (!fs.existsSync(path.join(srcDir, "node_modules"))) {
    throw new Error("gateway/node_modules is missing. Run npm install in gateway before packaging.");
  }
  assertGatewaySqliteBundleCompatible({
    nodeExecutable: process.execPath,
    gatewayDirectory: srcDir,
  });
  for (const required of ["package.json", path.join("src", "index.js")]) {
    if (!fs.existsSync(path.join(appMarketMcpSourceDirectory, required))) {
      throw new Error(`AppMarket MCP source is missing required file: ${required}`);
    }
  }

  fs.rmSync(destDir, { recursive: true, force: true });
  copyDir(srcDir, destDir);
  copyDir(
    appMarketMcpSourceDirectory,
    path.join(destDir, "mcp-servers", "devServer"),
  );
  assertGatewaySqliteBundleCompatible({
    nodeExecutable: process.execPath,
    gatewayDirectory: destDir,
  });
  verifyAppMarketMcpBundle(destDir);
  return { destinationDirectory: destDir };
}

if (require.main === module) {
  const result = prepareGateway();
  console.log(`Prepared bundled gateway: ${result.destinationDirectory}`);
}

module.exports = {
  assertPathInside,
  copyDir,
  prepareGateway,
  verifyAppMarketMcpBundle,
};
