import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import express from "express";

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "feishu-sync-loading-"));
const previousConfigPath = process.env.GATEWAY_CONFIG_PATH;
const previousDbPath = process.env.GATEWAY_DB_PATH;
process.env.GATEWAY_CONFIG_PATH = path.join(tempRoot, "gateway-config.json");
process.env.GATEWAY_DB_PATH = path.join(tempRoot, "gateway.db");
fs.writeFileSync(process.env.GATEWAY_CONFIG_PATH, "{}", "utf8");

let createFeishuProjectSyncRouter;
let db;

before(async () => {
  db = await import("../db/sqlite.js");
  ({ createFeishuProjectSyncRouter } = await import("../../features/FeiShuProjects/src/gateway-route.js"));
});

after(() => {
  if (previousConfigPath === undefined) delete process.env.GATEWAY_CONFIG_PATH;
  else process.env.GATEWAY_CONFIG_PATH = previousConfigPath;
  if (previousDbPath === undefined) delete process.env.GATEWAY_DB_PATH;
  else process.env.GATEWAY_DB_PATH = previousDbPath;
  try {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  } catch (error) {
    if (!["EBUSY", "EPERM"].includes(error?.code)) throw error;
  }
});

async function createHarness(t, routerOverrides = {}) {
  const seen = {
    records: [],
    verification: [],
    rawPayloads: [],
  };
  const router = createFeishuProjectSyncRouter({
    Router: express.Router,
    verifyToken: () => ({ role: "admin" }),
    getConfig: () => ({ feishuProjectSync: {} }),
    updateConfig: (patch) => patch,
    listSyncRecords: (query) => {
      seen.records.push(query);
      return [{ sourceWorkItemId: "FS-1" }];
    },
    verifySyncTargets: async (query) => {
      seen.verification.push(query);
      return { checked: 0 };
    },
    listFeishuProjectSyncErrors: () => [],
    listFeishuProjectRetryableErrors: () => [],
    listFeishuProjectRawPayloads: (query) => {
      seen.rawPayloads.push(query);
      return query.includePayload === false
        ? [{ id: 1, sourceWorkItemId: "FS-1", payloadHash: "hash-1" }]
        : [{ id: 1, sourceWorkItemId: "FS-1", payloadHash: "hash-1", payloadJson: "{\"large\":true}" }];
    },
    listFeishuProjectCommentSync: () => [],
    listFeishuProjectAttachmentSync: () => [],
    listFeishuProjectSyncStatesSince: () => [],
    ...routerOverrides,
  });

  const app = express();
  app.use(express.json());
  app.use("/api/feishu-project-sync", router);
  const server = app.listen(0);
  await new Promise((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  t.after(() => new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  }));
  const base = `http://127.0.0.1:${server.address().port}/api/feishu-project-sync`;
  return {
    seen,
    request: (pathname, init) => fetch(`${base}${pathname}`, init).then((response) => response.json()),
  };
}

test("initial records request can be lightweight and never verifies remote targets implicitly", async (t) => {
  const { seen, request } = await createHarness(t);
  const response = await request("/records?limit=100&enrich=0");

  assert.equal(response.success, true);
  assert.equal(seen.records.length, 1);
  assert.equal(seen.records[0].enrich, false);
  assert.equal(seen.verification.length, 0);
});

test("raw payload list forwards metadata-only mode", async (t) => {
  const { seen, request } = await createHarness(t);
  const response = await request("/raw-payloads?limit=20&includePayload=0");

  assert.equal(response.success, true);
  assert.equal(seen.rawPayloads[0].includePayload, false);
  assert.equal(Object.hasOwn(response.data[0], "payloadJson"), false);
});

test("SQLite metadata-only raw payload query does not read or duplicate payload JSON", () => {
  const workItemId = `loading-${Date.now()}`;
  db.insertFeishuProjectRawPayload({
    sourceProjectKey: "project",
    sourceWorkItemTypeKey: "bug",
    sourceWorkItemId: workItemId,
    payloadHash: "hash-loading",
    payloadJson: { large: "x".repeat(64 * 1024) },
  });

  const rows = db.listFeishuProjectRawPayloads({ workItemId, limit: 1, includePayload: false });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].sourceWorkItemId, workItemId);
  assert.equal(Object.hasOwn(rows[0], "payload_json"), false);
  assert.equal(Object.hasOwn(rows[0], "payloadJson"), false);
});

test("public MCP status redacts a configured token echoed by an upstream server", async (t) => {
  const token = "status-reflection-sentinel-7b268c";
  const { request } = await createHarness(t, {
    getConfig: () => ({
      feishuProjectSync: {
        feishu: {
          mcp: {
            enabled: true,
            serverUrl: "https://mcp.invalid/v1",
            transport: "http-header",
            token,
          },
        },
      },
    }),
    getMcpStatus: async () => ({
      configured: true,
      connected: false,
      error: `upstream reflected ${token}`,
      authorizationUrl: `https://mcp.invalid/authorize?access_token=${encodeURIComponent(token)}`,
      wwwAuthenticate: `Bearer error="${token}"`,
      tools: [{ name: token, description: `description ${token}` }],
    }),
  });

  const response = await request("/mcp-status");
  const serialized = JSON.stringify(response);
  assert.equal(response.success, true);
  assert.equal(serialized.includes(token), false);
  assert.equal(serialized.includes(encodeURIComponent(token)), false);
  assert.match(serialized, /\[REDACTED\]/);
});

test("MCP token endpoint reports persistence failure instead of saved true", async (t) => {
  const { request } = await createHarness(t, {
    getConfig: () => ({ feishuProjectSync: {} }),
    getMcpTokenFromWeb: async () => ({
      ok: true,
      token: "write-failure-sentinel",
      tokenLength: 22,
    }),
    updateConfig: () => {
      throw new Error("simulated config persistence failure");
    },
  });

  const response = await request("/mcp-token-from-web", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer test-admin" },
    body: "{}",
  });
  assert.equal(response.success, false);
  assert.equal(response.data, undefined);
  assert.match(response.error, /persistence failure/);
});

test("MCP authorization endpoint sanitizes reflected status before opening or responding", async (t) => {
  const token = "authorization-route-sentinel-21df7a";
  const openedUrls = [];
  const { request } = await createHarness(t, {
    getConfig: () => ({
      feishuProjectSync: {
        feishu: {
          mcp: {
            enabled: true,
            serverUrl: "https://mcp.invalid/v1",
            token,
          },
        },
      },
    }),
    getMcpStatus: async () => ({
      connected: false,
      error: `reflected ${token}`,
      authorizationUrl: `https://mcp.invalid/authorize?access_token=${token}`,
      tools: [{ name: token }],
    }),
    openSystemUrl: async (url) => {
      openedUrls.push(url);
      return { opened: true, url };
    },
  });

  const response = await request("/mcp-open-authorization", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer test-admin" },
    body: "{}",
  });
  const serialized = JSON.stringify(response);
  assert.equal(response.success, true);
  assert.equal(serialized.includes(token), false);
  assert.equal(openedUrls.length, 1);
  assert.equal(openedUrls[0].includes(token), false);
  assert.equal(openedUrls[0], "https://project.feishu.cn/b/mcp");
});

test("MCP token endpoint sanitizes the newly acquired token from its status response", async (t) => {
  const token = "token-route-sentinel-5caf41";
  const { request } = await createHarness(t, {
    getConfig: () => ({ feishuProjectSync: {} }),
    getMcpTokenFromWeb: async () => ({
      ok: true,
      token,
      tokenLength: token.length,
    }),
    updateConfig: () => ({}),
    getMcpStatus: async () => ({
      connected: true,
      error: `reflected ${token}`,
      authorizationUrl: `https://mcp.invalid/authorize?token=${token}`,
      tools: [{ name: token, description: token }],
    }),
  });

  const response = await request("/mcp-token-from-web", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer test-admin" },
    body: "{}",
  });
  const serialized = JSON.stringify(response);
  assert.equal(response.success, true);
  assert.equal(response.data.saved, true);
  assert.equal(response.data.tokenLength, token.length);
  assert.equal(serialized.includes(token), false);
  assert.match(serialized, /\[REDACTED\]/);
});

test("all MCP route error responses redact the configured or newly acquired token", async (t) => {
  const configuredToken = "route-error-configured-sentinel-b808";
  const commonConfig = () => ({
    feishuProjectSync: {
      feishu: {
        mcp: {
          enabled: true,
          serverUrl: "https://mcp.invalid/v1",
          token: configuredToken,
        },
      },
    },
  });

  const statusHarness = await createHarness(t, {
    getConfig: commonConfig,
    getMcpStatus: async () => {
      throw new Error(`status failed ${configuredToken}`);
    },
  });
  const statusResponse = await statusHarness.request("/mcp-status");
  assert.equal(statusResponse.success, false);
  assert.equal(JSON.stringify(statusResponse).includes(configuredToken), false);

  const authorizationHarness = await createHarness(t, {
    getConfig: commonConfig,
    getMcpStatus: async () => ({ authorizationUrl: "https://project.feishu.cn/b/mcp" }),
    openSystemUrl: async () => {
      throw new Error(`open failed ${configuredToken}`);
    },
  });
  const authorizationResponse = await authorizationHarness.request("/mcp-open-authorization", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer test-admin" },
    body: "{}",
  });
  assert.equal(authorizationResponse.success, false);
  assert.equal(JSON.stringify(authorizationResponse).includes(configuredToken), false);

  const acquiredToken = "route-error-acquired-sentinel-d11c";
  const tokenHarness = await createHarness(t, {
    getConfig: () => ({ feishuProjectSync: {} }),
    getMcpTokenFromWeb: async () => ({
      ok: true,
      token: acquiredToken,
      tokenLength: acquiredToken.length,
    }),
    updateConfig: () => {
      throw new Error(`persist failed ${acquiredToken}`);
    },
  });
  const tokenResponse = await tokenHarness.request("/mcp-token-from-web", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer test-admin" },
    body: "{}",
  });
  assert.equal(tokenResponse.success, false);
  assert.equal(JSON.stringify(tokenResponse).includes(acquiredToken), false);
});

test("MCP metadata and capture routes redact token reflections in errors and nested source results", async (t) => {
  const token = "metadata-capture-route-sentinel-c24e";
  const config = {
    enabled: true,
    feishu: {
      authMode: "mcp",
      mcp: {
        enabled: true,
        serverUrl: "https://mcp.invalid/v1",
        transport: "http-header",
        token,
      },
      sourceViews: [{
        id: "route-redaction",
        name: "Route redaction",
        url: "https://project.feishu.cn/intelligentspace/workObjectView/bug/view-redaction",
        enabled: true,
        isDefault: true,
      }],
    },
    sync: {
      batchSize: 20,
      includeComments: false,
      includeAttachments: false,
      readScope: { enabled: false, filters: [] },
      requiredAssigneeKeywords: [],
    },
  };
  const common = {
    getConfig: () => ({ feishuProjectSync: config }),
    getMcpFilterMetadata: async () => {
      throw new Error(`metadata failed ${token}`);
    },
    captureMcpItems: async () => ({
      ok: false,
      error: `capture failed ${token}`,
      warning: `warning ${token}`,
      items: [],
      total: 0,
      nested: { reflected: token },
    }),
  };
  const { request } = await createHarness(t, common);
  const headers = { "Content-Type": "application/json", Authorization: "Bearer test-admin" };

  const metadata = await request("/mcp-filter-metadata", { headers });
  assert.equal(metadata.success, false);
  assert.equal(JSON.stringify(metadata).includes(token), false);
  assert.match(JSON.stringify(metadata), /\[REDACTED\]/);

  const capture = await request("/mcp-capture", {
    method: "POST",
    headers,
    body: "{}",
  });
  assert.equal(capture.success, true);
  assert.equal(capture.data.ok, false);
  assert.equal(JSON.stringify(capture).includes(token), false);
  assert.match(JSON.stringify(capture), /\[REDACTED\]/);
});
