"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const {
  verifyBetterSqliteRuntimeSync,
} = require("../gateway-runtime.cjs");

const SKIPPED_NAMES = new Set([
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
const SKIP_PATTERN = /\.(db|db-wal|db-shm|db-journal|log|pem|key|p12|pfx|jks|keystore|mobileprovision|jar|zip|7z|rar|tar|gz|tgz)$/i;
const BLOCKED_FILE_NAMES = new Set([
  ".env",
  "credentials.json",
  "id_ed25519",
  "id_rsa",
  "service-account.json",
]);

function assertPathInside(rootDirectory, targetPath) {
  const relative = path.relative(
    path.resolve(rootDirectory),
    path.resolve(targetPath),
  );
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`Refusing to prepare Gateway outside the Desktop workspace: ${targetPath}`);
  }
}

function copySanitizedDirectory(source, destination, options = {}) {
  const includeNodeModules = options.includeNodeModules === true;
  fs.mkdirSync(destination, { recursive: true });
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const lowerName = entry.name.toLowerCase();
    if (entry.name === "node_modules" && !includeNodeModules) continue;
    if (
      SKIPPED_NAMES.has(entry.name)
      || BLOCKED_FILE_NAMES.has(lowerName)
      || lowerName.startsWith(".env.")
      || SKIP_PATTERN.test(entry.name)
    ) {
      continue;
    }

    const sourcePath = path.join(source, entry.name);
    const destinationPath = path.join(destination, entry.name);
    const isDependencyTestFile = sourcePath.toLowerCase().includes(
      `${path.sep}node_modules${path.sep}`,
    ) && /(^|[._-])(test|tests|spec)([._-]|$)/i.test(entry.name);
    if (isDependencyTestFile) continue;

    if (entry.isDirectory()) {
      copySanitizedDirectory(sourcePath, destinationPath, {
        includeNodeModules,
      });
    } else if (entry.isFile()) {
      fs.copyFileSync(sourcePath, destinationPath);
    }
  }
}

function resolveNpmCli(options = {}) {
  const nodeExecutable = options.nodeExecutable || process.execPath;
  const npmExecPath = options.npmExecPath || process.env.npm_execpath;
  const candidates = [
    npmExecPath,
    path.join(
      path.dirname(nodeExecutable),
      "node_modules",
      "npm",
      "bin",
      "npm-cli.js",
    ),
  ];
  const resolved = candidates.find((candidate) =>
    candidate && fs.existsSync(candidate));
  if (!resolved) {
    throw new Error("npm-cli.js was not found for clean Gateway staging.");
  }
  return resolved;
}

function installProductionDependencies(gatewayDirectory, options = {}) {
  const nodeExecutable = options.nodeExecutable || process.execPath;
  const npmCli = resolveNpmCli({
    nodeExecutable,
    npmExecPath: options.npmExecPath,
  });
  const run = options.spawnSync || spawnSync;
  const environment = { ...(options.env || process.env) };
  const pathKey = Object.keys(environment).find(
    (key) => key.toLowerCase() === "path",
  ) || "PATH";
  environment[pathKey] = [
    path.dirname(nodeExecutable),
    environment[pathKey],
  ].filter(Boolean).join(path.delimiter);
  environment.npm_node_execpath = nodeExecutable;
  const result = run(
    nodeExecutable,
    [npmCli, "ci", "--omit=dev", "--no-audit", "--no-fund"],
    {
      cwd: gatewayDirectory,
      env: environment,
      stdio: options.stdio || "inherit",
      timeout: options.timeout || 600000,
      windowsHide: true,
    },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`Clean Gateway npm ci failed with exit code ${result.status}.`);
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

function prepareGatewayBundle(options = {}) {
  const desktopDirectory = path.resolve(
    options.desktopDirectory || path.join(__dirname, ".."),
  );
  const sourceDirectory = path.resolve(
    options.sourceDirectory || path.join(desktopDirectory, "..", "gateway"),
  );
  const appMarketMcpSourceDirectory = path.resolve(
    options.appMarketMcpSourceDirectory
      || path.join(desktopDirectory, "..", "mcp-servers", "devServer"),
  );
  const destinationDirectory = path.resolve(
    options.destinationDirectory || path.join(desktopDirectory, "gateway-bundled"),
  );
  const installDependencies = options.installDependencies
    || installProductionDependencies;
  const verifyRuntime = options.verifyRuntime
    || verifyBetterSqliteRuntimeSync;
  const nodeExecutable = options.nodeExecutable || process.execPath;

  assertPathInside(desktopDirectory, destinationDirectory);
  for (const required of ["server.js", "package.json", "package-lock.json"]) {
    if (!fs.existsSync(path.join(sourceDirectory, required))) {
      throw new Error(`Gateway source is missing required file: ${required}`);
    }
  }
  for (const required of ["package.json", path.join("src", "index.js")]) {
    if (!fs.existsSync(path.join(appMarketMcpSourceDirectory, required))) {
      throw new Error(`AppMarket MCP source is missing required file: ${required}`);
    }
  }

  const stagingParent = path.join(desktopDirectory, ".tmp");
  fs.mkdirSync(stagingParent, { recursive: true });
  const stagingDirectory = fs.mkdtempSync(
    path.join(stagingParent, "gateway-stage-"),
  );
  try {
    copySanitizedDirectory(sourceDirectory, stagingDirectory, {
      includeNodeModules: false,
    });
    copySanitizedDirectory(
      appMarketMcpSourceDirectory,
      path.join(stagingDirectory, "mcp-servers", "devServer"),
      { includeNodeModules: false },
    );
    installDependencies(stagingDirectory, { nodeExecutable });
    verifyRuntime(nodeExecutable, stagingDirectory);
    verifyAppMarketMcpBundle(stagingDirectory);

    fs.rmSync(destinationDirectory, { recursive: true, force: true });
    copySanitizedDirectory(stagingDirectory, destinationDirectory, {
      includeNodeModules: true,
    });
    verifyRuntime(nodeExecutable, destinationDirectory);
    verifyAppMarketMcpBundle(destinationDirectory);
  } finally {
    fs.rmSync(stagingDirectory, { recursive: true, force: true });
  }

  return {
    destinationDirectory,
    nodeExecutable,
  };
}

module.exports = {
  assertPathInside,
  copySanitizedDirectory,
  installProductionDependencies,
  prepareGatewayBundle,
  resolveNpmCli,
  verifyAppMarketMcpBundle,
};
