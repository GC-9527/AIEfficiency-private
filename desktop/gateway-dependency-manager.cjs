"use strict";

const fs = require("node:fs");
const path = require("node:path");

const {
  verifyBetterSqliteRuntime,
} = require("./gateway-runtime.cjs");

function replacementError(initialError, error) {
  const wrapped = new Error(
    `Bundled Gateway dependencies are still incompatible after replacement: ${error.message}`,
    { cause: error },
  );
  wrapped.initialError = initialError;
  if (error.stderr) wrapped.stderr = error.stderr;
  if (error.stdout) wrapped.stdout = error.stdout;
  return wrapped;
}

async function ensureCompatibleGatewayDependencies(options) {
  const {
    bundledGatewayDirectory,
    copyDirectory,
    nodeExecutable,
    onRepair = () => {},
    removeDirectory = (directory) =>
      fs.rmSync(directory, { recursive: true, force: true }),
    userGatewayDirectory,
    verifyRuntime = verifyBetterSqliteRuntime,
    pathExists = fs.existsSync,
  } = options || {};

  if (!nodeExecutable || !userGatewayDirectory || !bundledGatewayDirectory) {
    throw new Error("Gateway dependency repair requires Node, user, and bundled Gateway paths.");
  }
  if (typeof copyDirectory !== "function") {
    throw new Error("Gateway dependency repair requires a copyDirectory function.");
  }

  try {
    await verifyRuntime(nodeExecutable, userGatewayDirectory);
    return { repaired: false };
  } catch (initialError) {
    const sourceModules = path.join(bundledGatewayDirectory, "node_modules");
    const destinationModules = path.join(userGatewayDirectory, "node_modules");
    if (!pathExists(sourceModules)) {
      const error = new Error(
        `Bundled Gateway node_modules was not found: ${sourceModules}`,
        { cause: initialError },
      );
      error.initialError = initialError;
      throw error;
    }

    onRepair(initialError);
    removeDirectory(destinationModules);
    copyDirectory(sourceModules, destinationModules);

    try {
      await verifyRuntime(nodeExecutable, userGatewayDirectory);
    } catch (error) {
      throw replacementError(initialError, error);
    }
    return { repaired: true };
  }
}

module.exports = {
  ensureCompatibleGatewayDependencies,
};
