import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "lan-sync-log-"));
process.env.GATEWAY_CONFIG_PATH = path.join(root, "gateway.json");
process.env.LAN_SYNC_LOG_DIR = path.join(root, "logs");

const config = await import("../services/config.js");
const diagnostic = await import("../services/lan-sync/diagnostic-log.js");

after(() => fs.rmSync(root, { recursive: true, force: true }));

test("LAN 诊断日志按大小轮转并保持磁盘上限", () => {
  config.updateConfig({
    lanSync: {
      diagnosticLog: {
        enabled: true,
        maxBytes: 256 * 1024,
        maxFiles: 3,
        retentionDays: 7,
      },
    },
  });
  for (let index = 0; index < 4000; index++) {
    diagnostic.lanSyncDiagnostic("info", "bounded_test", {
      peerNodeId: `node-${index % 20}`,
      reason: `bounded-${index}-${"x".repeat(180)}`,
    });
  }
  diagnostic.lanSyncDiagnostic("warn", "sensitive_fields_test", {
    payload: "PAYLOAD_MARKER_MUST_NOT_BE_LOGGED",
    privateKey: "PRIVATE_KEY_MARKER_MUST_NOT_BE_LOGGED",
    accessToken: "ACCESS_TOKEN_MARKER_MUST_NOT_BE_LOGGED",
    password: "PASSWORD_MARKER_MUST_NOT_BE_LOGGED",
    peerNodeId: "safe-peer",
    reason: "Bearer BEARER_MARKER_MUST_NOT_BE_LOGGED",
  });
  const files = fs.readdirSync(process.env.LAN_SYNC_LOG_DIR)
    .filter((name) => /^lan-sync\.log(?:\.\d+)?$/.test(name));
  assert.ok(files.length >= 2);
  assert.ok(files.length <= 3);
  const total = files.reduce((sum, name) => (
    sum + fs.statSync(path.join(process.env.LAN_SYNC_LOG_DIR, name)).size
  ), 0);
  assert.ok(total <= 3 * 256 * 1024 + 1024);
  const current = fs.readFileSync(path.join(process.env.LAN_SYNC_LOG_DIR, "lan-sync.log"), "utf8");
  assert.doesNotMatch(
    current,
    /payload|privateKey|accessToken|password|MARKER_MUST_NOT_BE_LOGGED/i,
  );
  assert.match(current, /safe-peer/);
  assert.match(current, /redacted-sensitive-text/);
});
