import assert from "node:assert/strict";
import test from "node:test";

import { prepareNodeCenterRequest } from "../services/center-forward.js";

function config() {
  return {
    role: "standalone",
    servers: { peers: ["http://center.example:3001"] },
    claudeProxyClient: {
      enabled: false,
      host: "",
      token: "ai-token-must-not-be-used",
    },
  };
}

test("车型配置转发可使用独立于 AI 的出站口令", () => {
  const prepared = prepareNodeCenterRequest(null, {
    config: config(),
    requestedHost: "http://center.example:3001",
    allowedRoles: ["standalone"],
    outboundToken: "vehicle-center-token",
  });
  assert.equal(prepared.ok, true);
  assert.equal(prepared.headers.get("Authorization"), "Bearer vehicle-center-token");

  const missing = prepareNodeCenterRequest(null, {
    config: config(),
    requestedHost: "http://center.example:3001",
    allowedRoles: ["standalone"],
    outboundToken: "",
  });
  assert.equal(missing.ok, false);
  assert.equal(missing.code, "CENTER_M2M_TOKEN_REQUIRED");
});
