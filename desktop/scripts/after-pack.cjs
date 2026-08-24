"use strict";

const {
  packagedGatewayPaths,
  verifyBetterSqliteRuntimeSync,
} = require("../gateway-runtime.cjs");
const { printSuccess, verifyPackagedApp } = require("./verify-package.cjs");

exports.default = async function afterPack(context) {
  const appDir = context?.packager?.appDir;
  const verification = verifyPackagedApp(appDir, context?.appOutDir);
  printSuccess(verification, "afterPack app.asar OK");

  const platform = context?.electronPlatformName
    || context?.packager?.platform?.nodeName
    || process.platform;
  const { nodeExecutable, gatewayDirectory } = packagedGatewayPaths(
    context?.appOutDir,
    platform,
  );
  verifyBetterSqliteRuntimeSync(nodeExecutable, gatewayDirectory, {
    timeout: 30000,
  });
  console.log(
    `[desktop-gateway] afterPack native runtime OK: ${nodeExecutable}`,
  );
};
