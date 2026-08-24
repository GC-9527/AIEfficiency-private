import { after, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "lan-sync-mtls-"));
process.env.GATEWAY_CONFIG_PATH = path.join(root, "gateway.json");
process.env.GATEWAY_DB_PATH = path.join(root, "data.db");
process.env.DEVBENCH_CONFIG_PATH = path.join(root, "market.json");
process.env.DEVBENCH_LOCAL_PROJECTS_PATH = path.join(root, "projects.json");
process.env.DEVBENCH_STORE_DIR = path.join(root, "store");
process.env.LAN_SYNC_IDENTITY_PATH = path.join(root, "identity.json");
process.env.DEVBENCH_SYNC_SCOPE = "lan-sync-mtls-test";

const config = await import("../services/config.js");
config.updateConfig({
  role: "standalone",
  lanSync: {
    syncMode: "peer",
    mtls: {
      enabled: true,
      required: true,
      caPath: "missing-ca.pem",
      certPath: "missing-cert.pem",
      keyPath: "missing-key.pem",
    },
  },
});
const sync = await import("../services/lan-sync/index.js");
const tls = await import("../services/lan-sync/tls.js");
const database = (await import("../db/sqlite.js")).default;

test("LAN sync 默认保持独立模式，管理员第一次真实发布后才启用 peer", () => {
  assert.equal(sync.configuredLanSyncMode({}), "disabled");
  assert.deepEqual(
    sync.lanSyncTransportPolicy({
      lanSync: { syncMode: "peer", mtls: { enabled: false } },
    }),
    {
      requestedMode: "peer",
      effectiveMode: "peer",
      mtlsEnabled: false,
      mtlsRequired: false,
      insecureTransportAllowed: false,
      applicationEncryption: true,
      blockedByTransport: false,
    },
  );
  assert.equal(sync.configuredLanSyncMode({
    lanSync: {
      syncMode: "peer",
      allowInsecureTransport: true,
      mtls: { enabled: false },
    },
  }), "peer");
  assert.equal(sync.configuredLanSyncMode({
    lanSync: {
      syncMode: "peer",
      mtls: { enabled: true, required: false },
    },
  }), "peer");
});

test("mTLS required 时 LAN WebSocket 在 HELLO 前拒绝无客户端证书连接", () => {
  let closed = null;
  sync.handleLanSyncConnection({
    close(code, reason) { closed = { code, reason }; },
  }, {
    socket: {
      authorized: false,
      authorizationError: "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
      remoteAddress: "127.0.0.1",
    },
  });
  assert.deepEqual(closed, { code: 1008, reason: "mTLS client certificate required" });
});

test("启用 mTLS 时缺失 CA/cert/key 会启动失败而不是静默降级 ws", () => {
  assert.throws(
    () => tls.lanSyncServerTlsOptions(),
    /ENOENT|path is required/,
  );
});

test("未配置 mTLS 时会记录应用层加密初始化且诊断保持脱敏", () => {
  const logDirectory = path.join(root, "blocked-policy-log");
  config.updateConfig({
    lanSync: {
      syncMode: "peer",
      allowInsecureTransport: false,
      mtls: { enabled: false, required: true },
      diagnosticLog: {
        enabled: true,
        directory: logDirectory,
        maxBytes: 256 * 1024,
        maxFiles: 2,
        retentionDays: 1,
      },
    },
  });
  sync.initLanSync();
  const content = fs.readFileSync(path.join(logDirectory, "lan-sync.log"), "utf8");
  assert.match(content, /"event":"service_initialized"/);
  assert.match(content, /"syncMode":"peer"/);
  assert.match(content, /"mtlsEnabled":false/);
  assert.doesNotMatch(content, /caPath|certPath|keyPath|privateKey|accessToken/);
  sync.stopLanSync();
});

after(() => {
  sync.stopLanSync();
  if (database.open) database.close();
  fs.rmSync(root, { recursive: true, force: true });
});
