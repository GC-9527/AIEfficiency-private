"use strict";

const {
  assertPinnedNodeRuntime,
  printRuntimePolicySuccess,
} = require("./runtime-policy.cjs");
const { printSuccess, verifyPackageConfig } = require("./verify-package.cjs");

exports.default = async function beforePack(context) {
  const policy = assertPinnedNodeRuntime();
  printRuntimePolicySuccess(policy, "beforePack runtime OK");
  const appDir = context?.packager?.appDir;
  const verification = verifyPackageConfig(appDir);
  printSuccess(verification, "beforePack OK");
};
