"use strict";

const path = require("node:path");

const {
  verifyBetterSqliteRuntimeSync,
} = require("../gateway-runtime.cjs");
const {
  assertPinnedNodeRuntime,
  printRuntimePolicySuccess,
} = require("./runtime-policy.cjs");
const {
  printSuccess,
  verifyPackageConfig,
} = require("./verify-package.cjs");

const desktopRoot = path.resolve(__dirname, "..");
const repoRoot = path.resolve(desktopRoot, "..");
const gatewayRoot = path.join(repoRoot, "gateway");

try {
  const policy = assertPinnedNodeRuntime({ repoRoot });
  printRuntimePolicySuccess(policy, "preflight runtime OK");

  const packageVerification = verifyPackageConfig(desktopRoot);
  printSuccess(packageVerification, "preflight package graph OK");

  verifyBetterSqliteRuntimeSync(process.execPath, gatewayRoot);
  console.log(
    `[desktop-gateway] preflight native SQL OK: ${process.version} `
    + `(ABI ${process.versions.modules})`,
  );
} catch (error) {
  console.error(`[desktop-preflight] ERROR: ${error.message}`);
  process.exitCode = 1;
}
