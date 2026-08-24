import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import express from "express";
import { DEFAULT_SYNC_POLICY_CONFIG } from "../../features/FeiShuProjects/src/sync-policy-engine.js";

const LEGACY_SOURCE_URL = "https://project.feishu.cn/intelligentspace/workObjectView/bug/2OuLlBcDg?scope=workspaces&node=28602134";
const DOUBLE_EIGHT_SOURCE_URL = "https://project.feishu.cn/intelligentspace/workObjectView/bug_double_eight/6VIRXf5vg";

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "feishu-source-views-"));
const previousConfigPath = process.env.GATEWAY_CONFIG_PATH;
const previousDbPath = process.env.GATEWAY_DB_PATH;
const originalFetch = globalThis.fetch;
const networkCalls = [];

process.env.GATEWAY_CONFIG_PATH = path.join(tempRoot, "gateway-config.json");
process.env.GATEWAY_DB_PATH = path.join(tempRoot, "gateway.db");
fs.writeFileSync(process.env.GATEWAY_CONFIG_PATH, JSON.stringify({}), "utf8");

let svc;
let createFeishuProjectSyncRouter;

before(async () => {
  globalThis.fetch = async (...args) => {
    networkCalls.push(args);
    throw new Error(`unexpected network request: ${String(args[0])}`);
  };
  svc = await import("../services/feishu-project-sync.js");
  ({ createFeishuProjectSyncRouter } = await import("../../features/FeiShuProjects/src/gateway-route.js"));
});

after(() => {
  globalThis.fetch = originalFetch;
  if (previousConfigPath === undefined) delete process.env.GATEWAY_CONFIG_PATH;
  else process.env.GATEWAY_CONFIG_PATH = previousConfigPath;
  if (previousDbPath === undefined) delete process.env.GATEWAY_DB_PATH;
  else process.env.GATEWAY_DB_PATH = previousDbPath;
  try {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  } catch (error) {
    // The shared SQLite module owns its connection until process exit on Windows.
    if (!["EBUSY", "EPERM"].includes(error?.code)) throw error;
  }
});

function sourceViews() {
  return [
    {
      id: "legacy-bug",
      name: "缺陷来源",
      url: LEGACY_SOURCE_URL,
      enabled: true,
      isDefault: true,
    },
    {
      id: "double-eight",
      name: "双八缺陷来源",
      url: DOUBLE_EIGHT_SOURCE_URL,
      enabled: true,
      isDefault: false,
    },
  ];
}

function syncConfig(views = sourceViews()) {
  return {
    enabled: true,
    feishu: { sourceViews: views },
    sync: {
      batchSize: 50,
      includeComments: false,
      includeAttachments: false,
      enforceSourceScope: true,
      requiredAssigneeKeywords: [],
      readScope: { enabled: false, filters: [] },
      sort: [],
    },
    mappings: { keywordRules: [] },
    pocWorkItemIds: [],
  };
}

function workItem(id, title = `Ticket ${id}`) {
  return {
    work_item_id: id,
    updated_at: "2026-07-24T00:00:00.000Z",
    fields: [
      { field_key: "title", field_name: "Title", value: title },
    ],
  };
}

function noWriteLoader(writeCalls = []) {
  const fail = (method) => async (...args) => {
    writeCalls.push({ method, args });
    throw new Error(`unexpected Teambition write: ${method}`);
  };
  return {
    createTask: fail("createTask"),
    updateTask: fail("updateTask"),
    syncComment: fail("syncComment"),
    syncAttachment: fail("syncAttachment"),
  };
}

async function createHttpHarness(t, {
  initialSyncConfig = syncConfig(),
  captureMcpItems,
  captureWebItems,
  syncWorkItem,
  refreshSourceRecords,
  writeLog,
} = {}) {
  let storedConfig = {
    feishuProjectSync: structuredClone(initialSyncConfig),
  };
  const updateCalls = [];
  const logCalls = [];
  const router = createFeishuProjectSyncRouter({
    Router: express.Router,
    verifyToken: (token) => (token === "admin-token" ? { role: "admin", name: "Admin" } : null),
    getConfig: () => structuredClone(storedConfig),
    updateConfig: (patch) => {
      updateCalls.push(structuredClone(patch));
      storedConfig = {
        ...storedConfig,
        ...structuredClone(patch),
      };
      return structuredClone(storedConfig);
    },
    listFeishuProjectSyncErrors: () => [],
    listFeishuProjectRawPayloads: () => [],
    listFeishuProjectCommentSync: () => [],
    listFeishuProjectAttachmentSync: () => [],
    listFeishuProjectRetryableErrors: () => [],
    listFeishuProjectSyncStatesSince: () => [],
    captureMcpItems: captureMcpItems || (async () => {
      throw new Error("unexpected MCP capture");
    }),
    captureWebItems: captureWebItems || (async () => {
      throw new Error("unexpected Web capture");
    }),
    syncWorkItem: syncWorkItem || (async () => {
      throw new Error("unexpected work item sync");
    }),
    ...(refreshSourceRecords ? { refreshSourceRecords } : {}),
    writeLog: writeLog || ((taskId, level, module, message) => {
      logCalls.push({ taskId, level, module, message });
    }),
  });
  const app = express();
  app.use(express.json());
  app.use("/api/feishu-project-sync", router);
  const server = app.listen(0);
  await new Promise((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  t.after(async () => {
    await new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}/api/feishu-project-sync`;
  const adminHeaders = {
    "Content-Type": "application/json",
    Authorization: "Bearer admin-token",
    Connection: "close",
  };
  return {
    updateCalls,
    logCalls,
    getStoredConfig: () => structuredClone(storedConfig),
    request: (pathname, options = {}) => originalFetch(`${baseUrl}${pathname}`, {
      ...options,
      headers: {
        ...adminHeaders,
        ...(options.headers || {}),
      },
    }),
  };
}

function parsedRefreshLogs(logCalls = []) {
  return logCalls
    .filter((entry) => entry.module === "feishu-project-sync" && entry.message.startsWith("[records-refresh] "))
    .map((entry) => ({
      ...entry,
      data: JSON.parse(entry.message.slice("[records-refresh] ".length)),
    }));
}

test("URL identity wins over legacy global workItemTypeKey when isolating a source view", () => {
  const config = svc.getFeishuProjectSyncConfig({
    feishu: {
      spaceKey: "intelligentspace",
      workItemTypeKey: "bug",
      sourceViews: [sourceViews()[0]],
    },
  });
  const isolated = svc.configForFeishuSourceView(config, { url: DOUBLE_EIGHT_SOURCE_URL });
  assert.equal(isolated.feishu.workItemTypeKey, "bug_double_eight");
  assert.equal(isolated.feishu.sourceView.viewId, "6VIRXf5vg");
  assert.equal(isolated.feishu.web.homepageUrl, DOUBLE_EIGHT_SOURCE_URL);
});

test("empty sourceViews falls back to legacy sourceView instead of leaving zero sources", () => {
  const config = svc.getFeishuProjectSyncConfig({
    feishu: {
      sourceViews: [],
      sourceView: { url: DOUBLE_EIGHT_SOURCE_URL },
      spaceKey: "intelligentspace",
      workItemTypeKey: "bug",
    },
  });
  assert.equal(config.feishu.sourceViews.length, 1);
  assert.equal(config.feishu.sourceViews[0].sourceWorkItemTypeKey, "bug_double_eight");
  assert.equal(config.feishu.workItemTypeKey, "bug_double_eight");
});

test("legacy feishu.sourceView migrates to one enabled default sourceViews item", () => {
  const config = svc.getFeishuProjectSyncConfig({
    feishu: {
      sourceView: { url: LEGACY_SOURCE_URL },
    },
  });

  assert.equal(config.feishu.sourceViews.length, 1);
  assert.deepEqual(
    {
      url: config.feishu.sourceViews[0].url,
      enabled: config.feishu.sourceViews[0].enabled,
      isDefault: config.feishu.sourceViews[0].isDefault,
      sourceProjectKey: config.feishu.sourceViews[0].sourceProjectKey,
      sourceWorkItemTypeKey: config.feishu.sourceViews[0].sourceWorkItemTypeKey,
      viewId: config.feishu.sourceViews[0].viewId,
    },
    {
      url: LEGACY_SOURCE_URL,
      enabled: true,
      isDefault: true,
      sourceProjectKey: "intelligentspace",
      sourceWorkItemTypeKey: "bug",
      viewId: "2OuLlBcDg",
    },
  );
});

test("accepts the bug_double_eight workObjectView URL and parses its source identity", () => {
  const validation = svc.validateFeishuSourceViewUrl(DOUBLE_EIGHT_SOURCE_URL);

  assert.equal(validation.ok, true);
  assert.equal(validation.parsed.sourceProjectKey, "intelligentspace");
  assert.equal(validation.parsed.sourceWorkItemTypeKey, "bug_double_eight");
  assert.equal(validation.parsed.viewId, "6VIRXf5vg");
});

test("strictly rejects non-Feishu hosts, non-workObjectView paths, credentials, and HTTP", () => {
  const invalidUrls = [
    "https://project.feishu.cn.evil.example/intelligentspace/workObjectView/bug/2OuLlBcDg",
    "https://project.feishu.cn/intelligentspace/bug/detail/2OuLlBcDg",
    "https://user:secret@project.feishu.cn/intelligentspace/workObjectView/bug/2OuLlBcDg",
    "http://project.feishu.cn/intelligentspace/workObjectView/bug/2OuLlBcDg",
  ];

  for (const url of invalidUrls) {
    assert.equal(svc.validateFeishuSourceViewUrl(url).ok, false, url);
  }
});

test("sourceViews validation reports duplicate identities and all-disabled configuration", () => {
  const duplicate = svc.validateFeishuSourceViewsConfig([
    { url: LEGACY_SOURCE_URL, enabled: true },
    {
      url: "https://project.feishu.cn/intelligentspace/workObjectView/bug/2OuLlBcDg?node=another-node",
      enabled: true,
    },
  ]);
  assert.equal(duplicate.ok, false);
  assert.ok(duplicate.errors.some((error) => error.code === "duplicate"));

  const allDisabled = svc.validateFeishuSourceViewsConfig([
    { url: LEGACY_SOURCE_URL, enabled: false },
    { url: DOUBLE_EIGHT_SOURCE_URL, enabled: false },
  ]);
  assert.equal(allDisabled.ok, false);
  assert.equal(allDisabled.enabledCount, 0);
  assert.ok(allDisabled.errors.some((error) => error.code === "no-enabled-source"));

  const duplicateIds = svc.validateFeishuSourceViewsConfig([
    { id: "same-source", url: LEGACY_SOURCE_URL, enabled: true },
    { id: "same-source", url: DOUBLE_EIGHT_SOURCE_URL, enabled: true },
  ]);
  assert.equal(duplicateIds.ok, false);
  assert.ok(duplicateIds.errors.some((error) => error.code === "duplicate-id"));
});

test("an explicit sourceViews context mismatch is rejected before service execution", async () => {
  const config = syncConfig([
    {
      id: "mismatched-source",
      url: LEGACY_SOURCE_URL,
      enabled: true,
      isDefault: true,
      sourceProjectKey: "another-space",
      sourceWorkItemTypeKey: "bug_double_eight",
      viewId: "6VIRXf5vg",
    },
  ]);
  const validation = svc.validateFeishuSourceViewsConfig(config);

  assert.equal(validation.ok, false);
  assert.ok(validation.errors.some((error) => error.code === "context-mismatch"));
  await assert.rejects(
    () => svc.runFeishuProjectSync({ config, workItems: [], dryRun: true }),
    (error) => error?.code === "FEISHU_SOURCE_VIEWS_INVALID"
      && error.validation?.errors?.some((item) => item.code === "context-mismatch"),
  );
});

test("the selected default source remains mirrored to legacy compatibility fields", () => {
  const views = sourceViews().map((view, index) => ({
    ...view,
    isDefault: index === 1,
  }));
  const config = svc.getFeishuProjectSyncConfig(syncConfig(views));

  assert.equal(config.feishu.sourceViews.filter((view) => view.isDefault).length, 1);
  assert.equal(config.feishu.sourceViews[1].isDefault, true);
  assert.equal(config.feishu.sourceView.url, DOUBLE_EIGHT_SOURCE_URL);
  assert.equal(config.feishu.sourceView.viewId, "6VIRXf5vg");
  assert.equal(config.feishu.spaceKey, "intelligentspace");
  assert.equal(config.feishu.workItemTypeKey, "bug_double_eight");
  assert.equal(config.feishu.web.homepageUrl, DOUBLE_EIGHT_SOURCE_URL);
});

test("the active source view overrides stale legacy view ids in configured and scoped extraBody", () => {
  const config = svc.getFeishuProjectSyncConfig({
    ...syncConfig(),
    sync: {
      ...syncConfig().sync,
      searchExtraBody: {
        view_id: "legacy-default-view",
        viewId: "legacy-default-view",
        work_object_view_id: "legacy-default-view",
        workObjectViewId: "legacy-default-view",
        node: "legacy-node",
      },
    },
  });
  const secondSource = svc.getFeishuSourceViews(config)[1];
  const secondConfig = svc.configForFeishuSourceView(config, secondSource);
  const fetchOptions = svc.buildFeishuFetchOptions(secondConfig, {
    scope: {
      extraBody: {
        view_id: "scoped-default-view",
        viewId: "scoped-default-view",
        work_object_view_id: "scoped-default-view",
        workObjectViewId: "scoped-default-view",
        node: "scoped-node",
      },
    },
  });

  assert.equal(fetchOptions.sourceViewId, "6VIRXf5vg");
  assert.equal(fetchOptions.extraBody.view_id, "6VIRXf5vg");
  assert.equal(fetchOptions.extraBody.viewId, "6VIRXf5vg");
  assert.equal(fetchOptions.extraBody.work_object_view_id, "6VIRXf5vg");
  assert.equal(fetchOptions.extraBody.workObjectViewId, "6VIRXf5vg");
  assert.equal(Object.hasOwn(fetchOptions.extraBody, "node"), false);
});

test("run reads both sourceViews, preserves same ids across types, dedupes within a type, and keeps the second type in scope", async () => {
  const clientCalls = [];
  const writeCalls = [];

  const result = await svc.runFeishuProjectSync({
    config: syncConfig(),
    limit: 20,
    dryRun: true,
    checkRemoteExisting: false,
    loader: noWriteLoader(writeCalls),
    clientFactory: async (sourceConfig, sourceView, index) => ({
      fetchWorkItems: async (fetchOptions) => {
        clientCalls.push({ sourceConfig, sourceView, index, fetchOptions });
        return index === 0
          ? [workItem("same-id", "First copy"), workItem("same-id", "Duplicate copy")]
          : [workItem("same-id", "Same id, different type")];
      },
    }),
  });

  assert.equal(result.ok, true);
  assert.equal(result.total, 2);
  assert.equal(clientCalls.length, 2);
  assert.equal(clientCalls[1].sourceConfig.feishu.workItemTypeKey, "bug_double_eight");
  assert.equal(clientCalls[1].sourceView.sourceWorkItemTypeKey, "bug_double_eight");
  assert.equal(clientCalls[1].sourceView.viewId, "6VIRXf5vg");
  assert.equal(clientCalls[1].fetchOptions.typeKey, "bug_double_eight");
  assert.equal(clientCalls[1].fetchOptions.sourceViewId, "6VIRXf5vg");
  assert.equal(clientCalls[1].fetchOptions.extraBody.view_id, "6VIRXf5vg");
  assert.deepEqual(
    result.results.map((row) => [
      row.item.sourceProjectKey,
      row.item.sourceWorkItemTypeKey,
      row.item.sourceWorkItemId,
    ]),
    [
      ["intelligentspace", "bug", "same-id"],
      ["intelligentspace", "bug_double_eight", "same-id"],
    ],
  );
  assert.ok(result.results.every((row) => row.action !== "skip"));
  assert.ok(result.results.every((row) => !String(row.reason || "").includes("out-of-scope")));
  assert.deepEqual(writeCalls, []);
  assert.deepEqual(networkCalls, []);
});

test("run applies the limit globally after aggregating every enabled source", async () => {
  const calls = [];
  const writeCalls = [];
  const result = await svc.runFeishuProjectSync({
    config: syncConfig(),
    limit: 3,
    dryRun: true,
    checkRemoteExisting: false,
    loader: noWriteLoader(writeCalls),
    clientFactory: async (_sourceConfig, sourceView, index) => ({
      fetchWorkItems: async (fetchOptions) => {
        calls.push({ sourceView, index, fetchOptions });
        return index === 0
          ? [workItem("bug-1"), workItem("bug-2")]
          : [workItem("double-1"), workItem("double-2")];
      },
    }),
  });

  assert.equal(calls.length, 2);
  assert.equal(result.total, 3);
  assert.equal(result.requested, 3);
  assert.deepEqual(result.sourceResults.map((row) => row.returned), [2, 2]);
  assert.deepEqual(writeCalls, []);
  assert.deepEqual(networkCalls, []);
});

test("one failed source rejects the whole run with partial results before any Teambition write", async () => {
  const writeCalls = [];
  let caught;

  try {
    await svc.runFeishuProjectSync({
      config: syncConfig(),
      limit: 10,
      loader: noWriteLoader(writeCalls),
      clientFactory: async (_sourceConfig, _sourceView, index) => ({
        fetchWorkItems: async () => {
          if (index === 1) throw new Error("second source unavailable");
          return [workItem("would-not-be-written")];
        },
      }),
    });
  } catch (error) {
    caught = error;
  }

  assert.ok(caught);
  assert.equal(caught.code, "FEISHU_SOURCE_VIEWS_PARTIAL_FAILURE");
  assert.equal(caught.partial, true);
  assert.equal(caught.sourceResults.length, 2);
  assert.deepEqual(caught.sourceResults.map((row) => row.ok), [true, false]);
  assert.equal(caught.sourceResults[0].returned, 1);
  assert.match(caught.sourceResults[1].error, /second source unavailable/);
  assert.deepEqual(writeCalls, []);
  assert.deepEqual(networkCalls, []);
});

test("HTTP PUT /config saves two Feishu source views and returns the normalized compatibility mirror", async (t) => {
  const harness = await createHttpHarness(t, {
    initialSyncConfig: syncConfig([sourceViews()[0]]),
  });

  const response = await harness.request("/config", {
    method: "PUT",
    body: JSON.stringify({ config: syncConfig() }),
  });
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.equal(payload.success, true);
  assert.equal(harness.updateCalls.length, 1);
  assert.equal(harness.updateCalls[0].feishuProjectSync.feishu.sourceViews.length, 2);
  assert.deepEqual(
    harness.updateCalls[0].feishuProjectSync.feishu.sourceViews.map((view) => view.url),
    [LEGACY_SOURCE_URL, DOUBLE_EIGHT_SOURCE_URL],
  );
  assert.equal(payload.data.config.feishu.sourceViews.length, 2);
  assert.equal(payload.data.config.feishu.sourceViews[1].sourceWorkItemTypeKey, "bug_double_eight");
  assert.equal(payload.data.config.feishu.sourceView.url, LEGACY_SOURCE_URL);
  assert.equal(payload.data.config.feishu.workItemTypeKey, "bug");
  assert.deepEqual(networkCalls, []);
});

test("HTTP PUT /config rejects a duplicate source identity with 409 and does not update config", async (t) => {
  const initial = syncConfig([sourceViews()[0]]);
  const harness = await createHttpHarness(t, { initialSyncConfig: initial });
  const duplicateConfig = syncConfig([
    sourceViews()[0],
    {
      id: "duplicate-bug",
      name: "Duplicate bug view",
      url: "https://project.feishu.cn/intelligentspace/workObjectView/bug/2OuLlBcDg?node=another-node",
      enabled: true,
      isDefault: false,
    },
  ]);

  const response = await harness.request("/config", {
    method: "PUT",
    body: JSON.stringify({ config: duplicateConfig }),
  });
  const payload = await response.json();

  assert.equal(response.status, 409);
  assert.equal(payload.success, false);
  assert.ok(payload.data.errors.some((error) => error.code === "duplicate"));
  assert.equal(harness.updateCalls.length, 0);
  assert.deepEqual(harness.getStoredConfig().feishuProjectSync, initial);
  assert.deepEqual(networkCalls, []);
});

test("HTTP PUT /config rejects all-disabled and invalid URL source lists with 400 and never updates config", async (t) => {
  const initial = syncConfig([sourceViews()[0]]);
  const harness = await createHttpHarness(t, { initialSyncConfig: initial });
  const invalidConfigs = [
    syncConfig(sourceViews().map((view) => ({ ...view, enabled: false }))),
    syncConfig([
      {
        id: "invalid-host",
        name: "Invalid host",
        url: "https://project.feishu.cn.evil.example/intelligentspace/workObjectView/bug/2OuLlBcDg",
        enabled: true,
        isDefault: true,
      },
    ]),
  ];

  for (const config of invalidConfigs) {
    const response = await harness.request("/config", {
      method: "PUT",
      body: JSON.stringify({ config }),
    });
    const payload = await response.json();
    assert.equal(response.status, 400);
    assert.equal(payload.success, false);
    assert.ok(Array.isArray(payload.data.errors));
    assert.ok(payload.data.errors.length > 0);
  }

  assert.equal(harness.updateCalls.length, 0);
  assert.deepEqual(harness.getStoredConfig().feishuProjectSync, initial);
  assert.deepEqual(networkCalls, []);
});

test("HTTP PUT /config validates a legacy sourceView and migrates a valid legacy update to canonical sourceViews", async (t) => {
  const initial = syncConfig([sourceViews()[0]]);
  const harness = await createHttpHarness(t, { initialSyncConfig: initial });

  const invalidResponse = await harness.request("/config", {
    method: "PUT",
    body: JSON.stringify({
      config: {
        feishu: {
          sourceView: {
            url: "https://project.feishu.cn.evil.example/intelligentspace/workObjectView/bug/2OuLlBcDg",
          },
        },
      },
    }),
  });
  const invalidPayload = await invalidResponse.json();
  assert.equal(invalidResponse.status, 400);
  assert.equal(invalidPayload.success, false);
  assert.ok(invalidPayload.data.errors.some((error) => error.code === "invalid-url"));
  assert.equal(harness.updateCalls.length, 0);

  const migratedResponse = await harness.request("/config", {
    method: "PUT",
    body: JSON.stringify({
      config: {
        feishu: {
          sourceView: { url: DOUBLE_EIGHT_SOURCE_URL },
        },
      },
    }),
  });
  const migratedPayload = await migratedResponse.json();
  assert.equal(migratedResponse.status, 200);
  assert.equal(migratedPayload.success, true);
  assert.equal(harness.updateCalls.length, 1);
  assert.equal(harness.updateCalls[0].feishuProjectSync.feishu.sourceViews.length, 1);
  assert.equal(harness.updateCalls[0].feishuProjectSync.feishu.sourceViews[0].url, DOUBLE_EIGHT_SOURCE_URL);
  assert.equal(migratedPayload.data.config.feishu.sourceViews.length, 1);
  assert.equal(migratedPayload.data.config.feishu.sourceView.url, DOUBLE_EIGHT_SOURCE_URL);
  assert.equal(migratedPayload.data.config.feishu.workItemTypeKey, "bug_double_eight");
  assert.deepEqual(networkCalls, []);
});

test("HTTP POST /policy-preview explains the built-in Spotify route without any TB write", async (t) => {
  const harness = await createHttpHarness(t);
  const response = await harness.request("/policy-preview", {
    method: "POST",
    body: JSON.stringify({
      action: "create",
      workItem: {
        work_item_id: "policy-api-spotify",
        space_key: "intelligentspace",
        work_item_type_key: "bug",
        fields: [
          { field_key: "title", field_name: "标题", field_value: "Spotify 无法播放" },
          { field_key: "function_module", field_name: "功能模块", field_value: "Spotify" },
        ],
      },
    }),
  });
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.equal(payload.success, true);
  assert.equal(payload.data.policyDecision.matchedRule.id, "builtin-module-spotify");
  assert.equal(payload.data.policyDecision.target.id, "spotify-8678");
  assert.equal(
    payload.data.payload.tasklistId,
    DEFAULT_SYNC_POLICY_CONFIG.routing.targets.find((target) => target.id === "spotify-8678").config.tasklistId,
  );
  assert.equal(harness.updateCalls.length, 0);
  assert.deepEqual(networkCalls, []);
});

test("HTTP PUT /config rejects an invalid policy reference before persisting", async (t) => {
  const harness = await createHttpHarness(t);
  const invalid = syncConfig();
  invalid.routing = {
    rules: [{
      id: "broken-policy-reference",
      name: "错误引用",
      enabled: true,
      priority: 999,
      conditions: [{ field: "item.title", operator: "contains", values: ["test"] }],
      targetId: "missing-target",
      strategyId: "legacy-default",
    }],
  };
  const response = await harness.request("/config", {
    method: "PUT",
    body: JSON.stringify({ config: invalid }),
  });
  const payload = await response.json();

  assert.equal(response.status, 400);
  assert.equal(payload.success, false);
  assert.ok(payload.policyValidation.errors.some((error) => error.path.endsWith("targetId")));
  assert.equal(harness.updateCalls.length, 0);
  assert.deepEqual(networkCalls, []);
});

test("HTTP POST /records/refresh logs a structured success with both source types", async (t) => {
  const refreshCalls = [];
  const harness = await createHttpHarness(t, {
    captureMcpItems: async (sourceConfig) => ({
      ok: true,
      source: "feishu-mcp",
      total: 1,
      items: [workItem(`refresh-${sourceConfig.feishu.workItemTypeKey}`)],
      warning: sourceConfig.feishu.workItemTypeKey === "bug"
        ? "飞书人员“李敏”存在同名，已按 user_key 唯一匹配。"
        : "",
    }),
    refreshSourceRecords: async (options) => {
      refreshCalls.push(options);
      return {
        ok: true,
        refreshed: options.workItems.length,
        skippedCount: 0,
        snapshotReconciled: false,
      };
    },
  });

  const response = await harness.request("/records/refresh", {
    method: "POST",
    body: JSON.stringify({
      source: "mcp",
      limit: 10,
      reconcileSnapshot: true,
      config: syncConfig(),
    }),
  });
  const payload = await response.json();
  const logs = parsedRefreshLogs(harness.logCalls);

  assert.equal(response.status, 200);
  assert.equal(payload.success, true);
  assert.equal(payload.data.refreshed, 2);
  assert.ok(payload.data.refreshLogId);
  assert.equal(refreshCalls.length, 1);
  assert.equal(logs.length, 2);
  assert.equal(logs[0].data.event, "records-refresh");
  assert.equal(logs[0].data.status, "started");
  assert.equal(logs[0].data.refreshLogId, payload.data.refreshLogId);
  assert.equal(logs[1].level, "info");
  assert.equal(logs[1].data.event, "records-refresh");
  assert.equal(logs[1].data.status, "succeeded");
  assert.equal(logs[1].data.refreshLogId, logs[0].data.refreshLogId);
  assert.deepEqual(logs[1].data.sourceTypes, ["bug", "bug_double_eight"]);
  assert.deepEqual(logs[1].data.sources.map((source) => source.workItemTypeKey), ["bug", "bug_double_eight"]);
  assert.match(logs[1].data.sources[0].warning, /user_key/);
  assert.deepEqual(networkCalls, []);
});

test("HTTP POST /records/refresh logs partial source failure without discarding successful records", async (t) => {
  const harness = await createHttpHarness(t, {
    captureMcpItems: async (sourceConfig) => {
      if (sourceConfig.feishu.workItemTypeKey === "bug_double_eight") {
        return { ok: false, items: [], total: 0, error: "second source unavailable" };
      }
      return {
        ok: true,
        source: "feishu-mcp",
        total: 1,
        items: [workItem("refresh-partial")],
      };
    },
    refreshSourceRecords: async (options) => ({
      ok: true,
      refreshed: options.workItems.length,
      skippedCount: 0,
      snapshotReconciled: false,
    }),
  });

  const response = await harness.request("/records/refresh", {
    method: "POST",
    body: JSON.stringify({ source: "mcp", limit: 10, config: syncConfig() }),
  });
  const payload = await response.json();
  const logs = parsedRefreshLogs(harness.logCalls);

  assert.equal(response.status, 200);
  assert.equal(payload.success, true);
  assert.equal(payload.data.partial, true);
  assert.equal(payload.data.refreshed, 1);
  assert.equal(logs[0].data.event, "records-refresh");
  assert.equal(logs.at(-1).level, "warn");
  assert.equal(logs.at(-1).data.event, "records-refresh");
  assert.equal(logs.at(-1).data.status, "partial");
  assert.equal(logs.at(-1).data.refreshLogId, logs[0].data.refreshLogId);
  assert.match(logs.at(-1).data.sources[1].error, /second source unavailable/);
  assert.deepEqual(networkCalls, []);
});

test("HTTP POST /records/refresh persists a redacted structured failure and returns its log id", async (t) => {
  const mcpSecret = "mcp-refresh-secret-sentinel";
  const pluginSecret = "plugin-refresh-secret-sentinel";
  const config = syncConfig();
  config.feishu.mcp = { token: mcpSecret };
  config.feishu.pluginSecret = pluginSecret;
  const harness = await createHttpHarness(t, {
    initialSyncConfig: config,
    captureMcpItems: async () => ({
      ok: true,
      items: [workItem("refresh-failure")],
      total: 1,
    }),
    refreshSourceRecords: async () => {
      throw new Error(`remote echoed ${mcpSecret}`);
    },
  });

  const response = await harness.request("/records/refresh", {
    method: "POST",
    body: JSON.stringify({ source: "mcp", limit: 10, config }),
  });
  const payload = await response.json();
  const logs = parsedRefreshLogs(harness.logCalls);
  const serializedLogs = JSON.stringify(logs);

  assert.equal(response.status, 500);
  assert.equal(payload.success, false);
  assert.ok(payload.refreshLogId);
  assert.equal(payload.data.refreshLogId, payload.refreshLogId);
  assert.match(payload.error, /\[REDACTED\]/);
  assert.equal(logs[0].data.event, "records-refresh");
  assert.equal(logs.at(-1).level, "error");
  assert.equal(logs.at(-1).data.event, "records-refresh");
  assert.equal(logs.at(-1).data.status, "failed");
  assert.equal(logs.at(-1).data.ok, false);
  assert.equal(logs.at(-1).data.refreshLogId, payload.refreshLogId);
  assert.equal(logs.at(-1).data.refreshLogId, logs[0].data.refreshLogId);
  assert.match(logs.at(-1).data.error, /\[REDACTED\]/);
  assert.equal(serializedLogs.includes(mcpSecret), false);
  assert.equal(serializedLogs.includes(pluginSecret), false);
  assert.equal(serializedLogs.includes("admin-token"), false);
  assert.equal(serializedLogs.includes("\"config\""), false);
  assert.equal(serializedLogs.includes("\"arguments\""), false);
  assert.deepEqual(networkCalls, []);
});

test("HTTP execution endpoints reject duplicate ids, too many sources, and URL context mismatch before capture", async (t) => {
  const captureCalls = [];
  const syncCalls = [];
  const harness = await createHttpHarness(t, {
    captureMcpItems: async (...args) => {
      captureCalls.push(args);
      return { ok: true, items: [] };
    },
    captureWebItems: async (...args) => {
      captureCalls.push(args);
      return { ok: true, items: [] };
    },
    syncWorkItem: async (...args) => {
      syncCalls.push(args);
      return { ok: true };
    },
  });
  const duplicateIds = [
    { ...sourceViews()[0], id: "same-id" },
    { ...sourceViews()[1], id: "same-id" },
  ];
  const tooMany = Array.from({ length: 21 }, (_, index) => ({
    id: `source-${index}`,
    url: `https://project.feishu.cn/intelligentspace/workObjectView/bug/view-${index}`,
    enabled: true,
    isDefault: index === 0,
  }));
  const mismatched = [{
    ...sourceViews()[0],
    sourceWorkItemTypeKey: "bug_double_eight",
  }];
  const cases = [
    { pathname: "/dry-run", body: { source: "mcp", sourceFallback: false, sourceViews: duplicateIds }, status: 409, code: "duplicate-id" },
    { pathname: "/run", body: { source: "mcp", sourceFallback: false, sourceViews: tooMany }, status: 400, code: "too-many" },
    { pathname: "/mcp-capture", body: { sourceViews: mismatched }, status: 400, code: "context-mismatch" },
    {
      pathname: "/web-capture",
      body: { sourceView: { url: "https://evil.example/intelligentspace/workObjectView/bug/view-1" } },
      status: 400,
      code: "invalid-url",
    },
  ];

  for (const entry of cases) {
    const response = await harness.request(entry.pathname, {
      method: "POST",
      body: JSON.stringify(entry.body),
    });
    const payload = await response.json();
    assert.equal(response.status, entry.status, entry.pathname);
    assert.equal(payload.success, false, entry.pathname);
    assert.ok(payload.data.errors.some((error) => error.code === entry.code), entry.pathname);
  }
  assert.equal(captureCalls.length, 0);
  assert.equal(syncCalls.length, 0);
  assert.deepEqual(networkCalls, []);
});

test("HTTP POST /dry-run captures both MCP source views with isolated contexts and aggregates their items", async (t) => {
  const captureCalls = [];
  const syncCalls = [];
  const harness = await createHttpHarness(t, {
    captureMcpItems: async (sourceConfig, options) => {
      captureCalls.push({
        sourceConfig: structuredClone(sourceConfig),
        options: structuredClone(options),
      });
      return {
        ok: true,
        source: "feishu-mcp",
        total: 1,
        items: [workItem("same-id", `Ticket from ${sourceConfig.feishu.workItemTypeKey}`)],
        tool: { name: "list_work_items" },
        effectiveTransport: "http-header",
      };
    },
    syncWorkItem: async (raw, options) => {
      syncCalls.push({
        raw: structuredClone(raw),
        options: structuredClone(options),
      });
      return {
        ok: true,
        dryRun: true,
        action: "create",
        item: svc.normalizeFeishuWorkItem(raw, options.config),
      };
    },
  });

  const response = await harness.request("/dry-run", {
    method: "POST",
    body: JSON.stringify({
      source: "mcp",
      sourceFallback: false,
      preparedRecordSync: true,
      limit: 10,
      config: syncConfig(),
    }),
  });
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.equal(payload.success, true);
  assert.equal(payload.data.ok, true);
  assert.equal(payload.data.total, 2);
  assert.equal(captureCalls.length, 2);
  assert.deepEqual(
    captureCalls.map((call) => call.sourceConfig.feishu.workItemTypeKey),
    ["bug", "bug_double_eight"],
  );
  assert.deepEqual(
    captureCalls.map((call) => call.options.sourceView.viewId),
    ["2OuLlBcDg", "6VIRXf5vg"],
  );
  assert.equal(syncCalls.length, 2);
  assert.deepEqual(
    syncCalls.map((call) => call.options.config.feishu.workItemTypeKey),
    ["bug", "bug_double_eight"],
  );
  assert.deepEqual(
    payload.data.sourceResults.map((result) => [result.workItemTypeKey, result.returned]),
    [["bug", 1], ["bug_double_eight", 1]],
  );
  assert.deepEqual(
    payload.data.results.map((result) => result.item.sourceWorkItemTypeKey),
    ["bug", "bug_double_eight"],
  );
  assert.deepEqual(networkCalls, []);
});

for (const source of ["mcp", "web"]) {
  for (const pathname of ["/dry-run", "/run"]) {
    test(`HTTP POST ${pathname} keeps ${source.toUpperCase()} multi-source capture atomic when one source fails`, async (t) => {
      const captureCalls = [];
      const syncCalls = [];
      const captureSource = async (sourceConfig, options) => {
        const typeKey = source === "mcp"
          ? sourceConfig.feishu.workItemTypeKey
          : sourceConfig.workItemTypeKey;
        captureCalls.push({
          typeKey,
          options: structuredClone(options || sourceConfig),
        });
        if (typeKey === "bug_double_eight") {
          throw new Error(`${source} second source unavailable`);
        }
        return {
          ok: true,
          source: `feishu-${source}`,
          total: 1,
          items: [workItem(`${source}-would-not-sync`)],
        };
      };
      const harness = await createHttpHarness(t, {
        captureMcpItems: source === "mcp"
          ? (sourceConfig, options) => captureSource(sourceConfig, options)
          : undefined,
        captureWebItems: source === "web"
          ? (options) => captureSource(options, options)
          : undefined,
        syncWorkItem: async (...args) => {
          syncCalls.push(args);
          throw new Error("partial capture must never reach work item synchronization");
        },
      });

      const response = await harness.request(pathname, {
        method: "POST",
        body: JSON.stringify({
          source,
          sourceFallback: false,
          preparedRecordSync: source === "mcp",
          limit: 10,
          config: syncConfig(),
        }),
      });
      const payload = await response.json();

      assert.equal(response.status, 200);
      assert.equal(payload.success, true);
      assert.equal(payload.data.ok, false);
      assert.equal(payload.data.partial, true);
      assert.equal(payload.data.total, 0);
      assert.equal(payload.data.requested, 1);
      assert.deepEqual(payload.data.results, []);
      assert.equal(syncCalls.length, 0);
      assert.deepEqual(captureCalls.map((call) => call.typeKey), ["bug", "bug_double_eight"]);
      assert.deepEqual(payload.data.sourceResults.map((result) => result.ok), [true, false]);
      assert.equal(payload.data.sourceResults[0].returned, 1);
      assert.match(payload.data.sourceResults[1].error, /second source unavailable/);
      assert.match(payload.data.firstError, /second source unavailable/);
      assert.equal(payload.data.captured.partial, true);
      assert.deepEqual(payload.data.captured.sourceResults, payload.data.sourceResults);
      assert.deepEqual(networkCalls, []);
    });
  }
}
