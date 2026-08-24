"use strict";

const {
  prepareGatewayBundle,
} = require("./gateway-bundle.cjs");
const {
  assertPinnedNodeRuntime,
  printRuntimePolicySuccess,
} = require("./runtime-policy.cjs");

const policy = assertPinnedNodeRuntime();
printRuntimePolicySuccess(policy, "Gateway staging runtime OK");

const result = prepareGatewayBundle();
console.log(
  `[desktop-gateway] Clean production bundle prepared: ${result.destinationDirectory}`,
);
