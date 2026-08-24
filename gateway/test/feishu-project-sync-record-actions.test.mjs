import { before, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import express from "express";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "fpsync-record-actions-"));
process.env.GATEWAY_CONFIG_PATH = path.join(tmp, "gateway-config.json");
process.env.GATEWAY_DB_PATH = path.join(tmp, "gateway.db");
fs.writeFileSync(process.env.GATEWAY_CONFIG_PATH, JSON.stringify({}), "utf8");

let createFeishuProjectSyncRouter;
let db;
let syncService;

const PROJECT_KEY = "intelligentspace";
const TYPE_KEY = "bug";
const ADMIN_HEADERS = {
  "Content-Type": "application/json",
  Authorization: "Bearer admin-token",
  Connection: "close",
};

before(async () => {
  db = await import("../db/sqlite.js");
  syncService = await import("../services/feishu-project-sync.js");
  ({ createFeishuProjectSyncRouter } = await import("../../features/FeiShuProjects/src/gateway-route.js"));
});

function mappingRecord(id, problemNo, targetTaskId = "") {
  return {
    sourceSystem: "feishu_project",
    sourceProjectKey: PROJECT_KEY,
    sourceWorkItemTypeKey: TYPE_KEY,
    sourceWorkItemId: id,
    sourceProblemNo: problemNo,
    sourceWorkItemNo: problemNo,
    targetSystem: "teambition",
    targetTaskId,
    targetUniqueId: targetTaskId ? problemNo.replace(/\D/g, "") : "",
    syncStatus: targetTaskId ? "success" : "pending",
  };
}

function workItem(id, problemNo, title, { mapped = false } = {}) {
  return {
    work_item_id: id,
    space_key: PROJECT_KEY,
    work_item_type_key: TYPE_KEY,
    updated_at: "2026-07-17T01:00:00.000Z",
    __testMapped: mapped,
    fields: [
      { field_key: "title", field_name: "Title", value: title },
      { field_key: "auto_number", field_name: "系统单号", value: problemNo },
    ],
    comments: [],
    attachments: [],
  };
}

function requestedValues(options = {}) {
  return [
    ...(Array.isArray(options.workItemIds) ? options.workItemIds : []),
    options.workItemId,
    ...(Array.isArray(options.workItemNos) ? options.workItemNos : []),
    options.workItemNo,
    ...(Array.isArray(options.problemNos) ? options.problemNos : []),
    options.problemNo,
  ].map((value) => String(value || "").trim()).filter(Boolean);
}

function itemIdentity(raw = {}) {
  const fields = Array.isArray(raw.fields) ? raw.fields : [];
  const problemNo = fields.find((field) => field.field_key === "auto_number")?.value || "";
  const title = fields.find((field) => field.field_key === "title")?.value || "";
  return {
    sourceWorkItemId: raw.work_item_id,
    sourceProjectKey: raw.space_key,
    sourceWorkItemTypeKey: raw.work_item_type_key,
    sourceProblemNo: problemNo,
    sourceWorkItemNo: problemNo,
    title,
  };
}

function resultWorkItemId(item = {}) {
  return String(
    item?.result?.item?.sourceWorkItemId
      || item?.result?.item?.id
      || item?.result?.sourceWorkItemId
      || "",
  );
}

function syncConfig() {
  return {
    enabled: true,
    feishu: {
      authMode: "mcp",
      spaceKey: PROJECT_KEY,
      workItemTypeKey: TYPE_KEY,
    },
    teambition: {
      projectId: "tb-project",
      tasklistId: "tb-list",
      defaultExecutorId: "tb-user",
    },
    sync: {
      includeComments: true,
      includeAttachments: true,
      requiredAssigneeKeywords: [],
      readScope: { enabled: false, filters: [] },
    },
  };
}

async function createHarness(t, {
  items = [],
  preparedPlanTtlMs = 30_000,
  now = () => Date.now(),
  deleteSyncRecords = db.deleteFeishuProjectSyncRecords,
  applyDelayMs = 0,
  previewResultForRaw = null,
  captureFilterRaw = null,
  captureBatchLimitOne = false,
  captureBatchExtraItems = [],
} = {}) {
  const calls = {
    capture: [],
    webCapture: [],
    previewSync: [],
    applySync: [],
    runSync: 0,
    delete: [],
  };
  const itemCatalog = items;
  const injectedDelete = (records) => {
    calls.delete.push(records);
    return deleteSyncRecords(records);
  };
  const router = createFeishuProjectSyncRouter({
    Router: express.Router,
    verifyToken: (token) => (token === "admin-token" ? { role: "admin", name: "Admin" } : null),
    getConfig: () => ({ feishuProjectSync: syncConfig() }),
    updateConfig: (next) => next,
    listFeishuProjectSyncErrors: () => [],
    listFeishuProjectRawPayloads: () => [],
    listFeishuProjectCommentSync: () => [],
    listFeishuProjectAttachmentSync: () => [],
    listFeishuProjectRetryableErrors: () => [],
    listFeishuProjectSyncStatesSince: () => [],
    captureMcpItems: async (_config, options = {}) => {
      calls.capture.push(options);
      const requested = new Set(requestedValues(options));
      let selected = requested.size
        ? itemCatalog.filter((raw) => {
            const identity = itemIdentity(raw);
            return requested.has(identity.sourceWorkItemId) || requested.has(identity.sourceProblemNo);
          })
        : itemCatalog;
      if (typeof captureFilterRaw === "function") {
        selected = selected.filter((raw) => captureFilterRaw(raw, options, _config));
      }
      if (captureBatchLimitOne && requested.size > 1) selected = selected.slice(0, 1);
      if (requested.size > 1 && Array.isArray(captureBatchExtraItems) && captureBatchExtraItems.length) {
        selected = [...selected, ...captureBatchExtraItems];
      }
      return {
        ok: true,
        source: "feishu-mcp",
        total: selected.length,
        items: selected.map((raw) => structuredClone(raw)),
      };
    },
    captureWebItems: async (options = {}) => {
      calls.webCapture.push(options);
      return { ok: false, source: "feishu-web", error: "web capture is disabled in record action tests", items: [], total: 0 };
    },
    syncWorkItem: async (raw, options = {}) => {
      const identity = itemIdentity(raw);
      const call = { raw: structuredClone(raw), options: { ...options }, identity };
      if (options.dryRun) calls.previewSync.push(call);
      else calls.applySync.push(call);
      if (options.dryRun && typeof previewResultForRaw === "function") {
        const override = previewResultForRaw(raw, options, identity);
        if (override !== undefined) return override;
      }
      if (!options.dryRun && applyDelayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, applyDelayMs));
      }
      const preparedFingerprint = `record-action:${raw.work_item_id}:${raw.__testMapped ? "update" : "create"}`;
      if (!options.dryRun && options.expectedPreparedFingerprint !== preparedFingerprint) {
        return {
          ok: false,
          stale: true,
          action: raw.__testMapped ? "update" : "create",
          item: identity,
          preparedFingerprint,
          error: "preview fingerprint changed",
        };
      }
      return {
        ok: true,
        dryRun: !!options.dryRun,
        action: raw.__testMapped ? "update" : "create",
        item: identity,
        existing: raw.__testMapped ? { targetTaskId: `tb-${raw.work_item_id}`, syncStatus: "success" } : null,
        payload: { content: identity.title },
        targetTaskId: raw.__testMapped ? `tb-${raw.work_item_id}` : options.dryRun ? "" : `tb-created-${raw.work_item_id}`,
        preparedFingerprint,
      };
    },
    runSync: async () => {
      calls.runSync += 1;
      throw new Error("record preview/apply must not call runSync");
    },
    deleteSyncRecords: injectedDelete,
    preparedPlanTtlMs,
    now,
  });
  const app = express();
  app.use(express.json());
  app.use("/api/feishu-project-sync", router);
  const server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  t.after(() => new Promise((resolve) => {
    server.close(resolve);
    server.closeIdleConnections?.();
    server.closeAllConnections?.();
  }));
  return {
    base: `http://127.0.0.1:${server.address().port}/api/feishu-project-sync`,
    calls,
    itemCatalog,
  };
}

async function post(base, endpoint, body, { admin = true } = {}) {
  const response = await fetch(`${base}${endpoint}`, {
    method: "POST",
    headers: admin ? ADMIN_HEADERS : { "Content-Type": "application/json", Connection: "close" },
    body: JSON.stringify(body),
  });
  let payload = null;
  try {
    payload = await response.json();
  } catch {}
  return { status: response.status, body: payload };
}

test("record sync preview captures once and partial apply reuses captured work items", async (t) => {
  const firstRecord = mappingRecord("record-preview-one", "NSCP-81001");
  const secondRecord = mappingRecord("record-preview-two", "NSCP-81002", "tb-record-preview-two");
  const harness = await createHarness(t, {
    items: [
      workItem(firstRecord.sourceWorkItemId, firstRecord.sourceProblemNo, "Preview create"),
      workItem(secondRecord.sourceWorkItemId, secondRecord.sourceProblemNo, "Preview update", { mapped: true }),
    ],
  });

  const preview = await post(harness.base, "/records/sync-preview", {
    source: "mcp",
    sourceFallback: false,
    records: [firstRecord, secondRecord],
    workItemIds: [firstRecord.sourceWorkItemId, secondRecord.sourceWorkItemId],
    config: syncConfig(),
  });
  assert.equal(preview.status, 200);
  assert.equal(preview.body?.success, true);
  assert.ok(preview.body?.data?.planId);
  assert.ok(preview.body?.data?.expiresAt);
  assert.equal(preview.body?.data?.items?.length, 2);
  assert.deepEqual(
    preview.body.data.items.map(resultWorkItemId).sort(),
    [firstRecord.sourceWorkItemId, secondRecord.sourceWorkItemId].sort(),
  );
  assert.deepEqual(preview.body.data.items.map((item) => item.result.action).sort(), ["create", "update"]);
  assert.ok(preview.body.data.items.every((item) => item.recordKey));
  assert.equal(harness.calls.capture.length, 1);
  assert.equal(harness.calls.previewSync.length, 2);
  assert.equal(harness.calls.applySync.length, 0);
  const runSyncCountAfterPreview = harness.calls.runSync;

  const selected = preview.body.data.items.find((item) => resultWorkItemId(item) === firstRecord.sourceWorkItemId);
  const apply = await post(harness.base, "/records/sync-apply", {
    planId: preview.body.data.planId,
    recordKeys: [selected.recordKey],
  });
  assert.equal(apply.status, 200);
  assert.equal(apply.body?.success, true);
  assert.equal(harness.calls.capture.length, 1, "apply must reuse the captured work item");
  assert.equal(harness.calls.previewSync.length, 2);
  assert.equal(harness.calls.applySync.length, 1);
  assert.equal(harness.calls.applySync[0].identity.sourceWorkItemId, firstRecord.sourceWorkItemId);
  assert.equal(harness.calls.applySync[0].options.dryRun, false);
  assert.equal(harness.calls.applySync[0].options.expectedPreparedFingerprint, selected.result.preparedFingerprint);
  assert.equal(harness.calls.applySync[0].options.now, harness.calls.previewSync[0].options.now);
  assert.equal(harness.calls.runSync, runSyncCountAfterPreview, "apply must not invoke runSync again");

  const replay = await post(harness.base, "/records/sync-apply", {
    planId: preview.body.data.planId,
    recordKeys: [selected.recordKey],
  });
  assert.equal(replay.status, 409);
  assert.equal(harness.calls.applySync.length, 1, "replay must not write twice");
});

test("record sync preview supports problem numbers and applies an entire batch", async (t) => {
  const records = [
    mappingRecord("record-batch-one", "NSCP-82001"),
    mappingRecord("record-batch-two", "NSCP-82002", "tb-record-batch-two"),
  ];
  const harness = await createHarness(t, {
    items: [
      workItem(records[0].sourceWorkItemId, records[0].sourceProblemNo, "Batch create"),
      workItem(records[1].sourceWorkItemId, records[1].sourceProblemNo, "Batch update", { mapped: true }),
    ],
  });

  const preview = await post(harness.base, "/records/sync-preview", {
    source: "mcp",
    sourceFallback: false,
    records,
    workItemNos: records.map((record) => record.sourceProblemNo),
    config: syncConfig(),
  });
  assert.equal(preview.status, 200);
  assert.equal(preview.body?.data?.items?.length, 2);
  assert.equal(harness.calls.capture.length, 1);
  const runSyncCountAfterPreview = harness.calls.runSync;

  const apply = await post(harness.base, "/records/sync-apply", {
    planId: preview.body.data.planId,
    recordKeys: preview.body.data.items.map((item) => item.recordKey),
  });
  assert.equal(apply.status, 200);
  assert.equal(apply.body?.success, true);
  assert.equal(harness.calls.capture.length, 1);
  assert.equal(harness.calls.applySync.length, 2);
  assert.deepEqual(
    harness.calls.applySync.map((call) => call.identity.sourceWorkItemId).sort(),
    records.map((record) => record.sourceWorkItemId).sort(),
  );
  assert.equal(harness.calls.runSync, runSyncCountAfterPreview, "apply must not invoke runSync again");
});

test("record sync preview returns a failed row even when its dry-run result omits item identity", async (t) => {
  const successRecord = mappingRecord("record-partial-success", "NSCP-82101");
  const failedRecord = mappingRecord("record-partial-failed", "NSCP-82102");
  const harness = await createHarness(t, {
    items: [
      workItem(successRecord.sourceWorkItemId, successRecord.sourceProblemNo, "Partial success"),
      workItem(failedRecord.sourceWorkItemId, failedRecord.sourceProblemNo, "Partial failure"),
    ],
    previewResultForRaw: (raw) => raw.work_item_id === failedRecord.sourceWorkItemId
      ? { ok: false, dryRun: true, action: "create", error: "飞书字段转换失败" }
      : undefined,
  });

  const preview = await post(harness.base, "/records/sync-preview", {
    source: "mcp",
    sourceFallback: false,
    records: [successRecord, failedRecord],
    workItemIds: [successRecord.sourceWorkItemId, failedRecord.sourceWorkItemId],
    config: syncConfig(),
  });

  assert.equal(preview.status, 200);
  assert.equal(preview.body?.success, true);
  assert.equal(preview.body?.data?.items?.length, 2);
  const failed = preview.body.data.items.find((item) => item.result?.error === "飞书字段转换失败");
  assert.ok(failed, "the backend must preserve the failed row and its real error");
  assert.equal(failed.status, "failed");
  assert.equal(failed.result.ok, false);
  assert.equal(failed.result.item.sourceWorkItemId, failedRecord.sourceWorkItemId);
  assert.equal(preview.body.data.missingKeys.length, 0);

  const success = preview.body.data.items.find((item) => item.status === "ready");
  const applySuccess = await post(harness.base, "/records/sync-apply", {
    planId: preview.body.data.planId,
    recordKeys: [success.recordKey],
  });
  assert.equal(applySuccess.status, 200);
  assert.equal(applySuccess.body?.data?.applied, 1);
  assert.equal(harness.calls.applySync.length, 1);
  assert.equal(harness.calls.applySync[0].identity.sourceWorkItemId, successRecord.sourceWorkItemId);

  const applyFailed = await post(harness.base, "/records/sync-apply", {
    planId: preview.body.data.planId,
    recordKeys: [failed.recordKey],
  });
  assert.equal(applyFailed.status, 409);
  assert.equal(harness.calls.applySync.length, 1, "failed preview rows must never be applied");
});

test("record sync preview returns an explicit failure when capture omits one selected record", async (t) => {
  const successRecord = mappingRecord("record-capture-success", "NSCP-82201");
  const missingRecord = mappingRecord("record-capture-missing", "NSCP-82202");
  const harness = await createHarness(t, {
    items: [workItem(successRecord.sourceWorkItemId, successRecord.sourceProblemNo, "Captured success")],
  });

  const preview = await post(harness.base, "/records/sync-preview", {
    source: "mcp",
    sourceFallback: false,
    records: [successRecord, missingRecord],
    workItemIds: [successRecord.sourceWorkItemId, missingRecord.sourceWorkItemId],
    config: syncConfig(),
  });

  assert.equal(preview.status, 200);
  assert.equal(preview.body?.data?.items?.length, 2);
  assert.equal(preview.body?.data?.ready, 1);
  assert.equal(preview.body?.data?.failed, 1);
  assert.equal(preview.body?.data?.missingKeys?.length, 1);
  const failed = preview.body.data.items.find((item) => item.status === "failed");
  assert.equal(failed?.result?.item?.sourceWorkItemId, missingRecord.sourceWorkItemId);
  assert.match(failed?.result?.error || "", /飞书读取未返回所选工单/);
});

test("record sync preview keeps an explicitly selected scope skip as the real failed row", async (t) => {
  const successRecord = mappingRecord("record-scope-success", "NSCP-82301");
  const skippedRecord = mappingRecord("record-scope-skipped", "NSCP-82302");
  const scopeReason = "read scope filter gate: 问题责任人（角色）: 存在选项属于 阳荣峰, 徐博超, 彭俊维, 冯国梁";
  const harness = await createHarness(t, {
    items: [
      workItem(successRecord.sourceWorkItemId, successRecord.sourceProblemNo, "Scope success"),
      workItem(skippedRecord.sourceWorkItemId, skippedRecord.sourceProblemNo, "Scope skipped"),
    ],
    previewResultForRaw: (raw, options, identity) => raw.work_item_id === skippedRecord.sourceWorkItemId
      ? {
          ok: true,
          dryRun: !!options.dryRun,
          action: "skip",
          skipped: true,
          reason: scopeReason,
          item: identity,
          scopeStatus: { ok: false, state: "initial-out-of-scope", reason: scopeReason },
          preparedFingerprint: `record-action:${raw.work_item_id}:skip`,
        }
      : undefined,
  });

  const preview = await post(harness.base, "/records/sync-preview", {
    source: "mcp",
    records: [successRecord, skippedRecord],
    workItemIds: [successRecord.sourceWorkItemId, skippedRecord.sourceWorkItemId],
    config: syncConfig(),
  });

  assert.equal(preview.status, 200);
  assert.equal(harness.calls.capture.length, 1);
  assert.equal(harness.calls.capture[0].sourceFallback, false, "record preview must disable adaptive source fallback");
  assert.equal(harness.calls.webCapture.length, 0, "record preview must not switch to an incomplete fallback source");
  assert.equal(preview.body?.data?.items?.length, 2);
  assert.equal(preview.body?.data?.ready, 1);
  assert.equal(preview.body?.data?.failed, 1);
  assert.deepEqual(preview.body?.data?.missingKeys, []);
  const failed = preview.body.data.items.find((item) => item.status === "failed");
  assert.equal(failed?.result?.item?.sourceWorkItemId, skippedRecord.sourceWorkItemId);
  assert.equal(failed?.result?.ok, false);
  assert.equal(failed?.result?.error, scopeReason);
  assert.doesNotMatch(failed?.result?.error || "", /飞书读取未返回所选工单/);

  const applyFailed = await post(harness.base, "/records/sync-apply", {
    planId: preview.body.data.planId,
    recordKeys: [failed.recordKey],
  });
  assert.equal(applyFailed.status, 409);
  assert.equal(harness.calls.applySync.length, 0, "scope-skipped preview rows must never be applied");
});

test("record sync preview fetches explicit ids without remote read-scope prefilter", async (t) => {
  const successRecord = mappingRecord("record-prefilter-success", "NSCP-19001");
  const nscp16432 = mappingRecord("7025398356", "NSCP-16432");
  const configuredNames = ["阳荣峰", "徐博超", "彭俊维", "冯国梁"];
  const scopeFilters = [{
    id: "problem-owner-role",
    enabled: true,
    kind: "role",
    fieldKey: "role_bd6222",
    fieldName: "问题责任人（角色）",
    operator: "containsAny",
    values: configuredNames,
  }];
  const harness = await createHarness(t, {
    items: [
      workItem(successRecord.sourceWorkItemId, successRecord.sourceProblemNo, "Prefilter success"),
      workItem(nscp16432.sourceWorkItemId, nscp16432.sourceProblemNo, "NSCP-16432 includes 阳荣峰 locally"),
    ],
    captureFilterRaw: (raw, options) => {
      const filters = Array.isArray(options.filters) ? options.filters : (options.scope?.filters || []);
      const keywords = Array.isArray(options.requiredAssigneeKeywords) ? options.requiredAssigneeKeywords : [];
      const remotePrefilterActive = filters.length > 0 || keywords.length > 0;
      return raw.work_item_id !== nscp16432.sourceWorkItemId || !remotePrefilterActive;
    },
  });

  const preview = await post(harness.base, "/records/sync-preview", {
    source: "mcp",
    records: [successRecord, nscp16432],
    workItemIds: [successRecord.sourceWorkItemId, nscp16432.sourceWorkItemId],
    requiredAssigneeKeywords: configuredNames,
    scope: { match: "all", filters: scopeFilters },
  });

  assert.equal(preview.status, 200);
  assert.equal(harness.calls.capture.length, 1);
  assert.deepEqual(harness.calls.capture[0].filters, [], "explicit-id capture must not send remote read-scope filters");
  assert.deepEqual(harness.calls.capture[0].requiredAssigneeKeywords, [], "explicit-id capture must not send remote assignee prefilters");
  assert.equal(preview.body?.data?.items?.length, 2);
  assert.equal(preview.body?.data?.ready, 2);
  assert.equal(preview.body?.data?.failed, 0);
  assert.deepEqual(preview.body?.data?.missingKeys, []);
  assert.equal(harness.calls.previewSync.length, 2, "both explicitly selected records must reach local dry-run evaluation");
  assert.equal(harness.calls.previewSync[0].options.config?.sync?.readScope?.filters?.length, 1, "local dry-run must still enforce the configured read scope");
  assert.ok(preview.body.data.items.some((item) => item.result?.item?.sourceWorkItemId === nscp16432.sourceWorkItemId));
  assert.ok(preview.body.data.items.every((item) => !/飞书读取未返回所选工单/.test(item.result?.error || "")));
});

test("record sync preview recovers an explicit id omitted by batch MCP brief", async (t) => {
  const successRecord = mappingRecord("7036093080", "NSCP-17420");
  const nscp16432 = mappingRecord("7025398356", "NSCP-16432");
  const harness = await createHarness(t, {
    items: [
      workItem(successRecord.sourceWorkItemId, successRecord.sourceProblemNo, "Batch brief first item"),
      workItem(nscp16432.sourceWorkItemId, nscp16432.sourceProblemNo, "Batch brief omitted NSCP-16432"),
    ],
    captureBatchLimitOne: true,
    captureBatchExtraItems: [workItem("2494788", "NSCP-2494788", "Unrequested MCP batch item")],
  });

  const preview = await post(harness.base, "/records/sync-preview", {
    source: "mcp",
    records: [successRecord, nscp16432],
    workItemIds: [successRecord.sourceWorkItemId, nscp16432.sourceWorkItemId],
  });

  assert.equal(preview.status, 200);
  assert.equal(harness.calls.capture.length, 2, "the missing explicit id must be retried in an individual MCP capture");
  assert.deepEqual(harness.calls.capture[0].workItemIds, [successRecord.sourceWorkItemId, nscp16432.sourceWorkItemId]);
  assert.deepEqual(harness.calls.capture[1].workItemIds, [nscp16432.sourceWorkItemId]);
  assert.equal(preview.body?.data?.items?.length, 2);
  assert.equal(preview.body?.data?.ready, 2);
  assert.equal(preview.body?.data?.failed, 0);
  assert.deepEqual(preview.body?.data?.missingKeys, []);
  assert.equal(harness.calls.previewSync.length, 2);
  assert.ok(preview.body.data.items.some((item) => item.result?.item?.sourceWorkItemId === nscp16432.sourceWorkItemId));
  assert.ok(preview.body.data.items.every((item) => !/飞书读取未返回所选工单/.test(item.result?.error || "")));
});

test("concurrent plans cannot apply the same mapping record twice", async (t) => {
  const record = mappingRecord("record-concurrent", "NSCP-82501");
  const harness = await createHarness(t, {
    items: [workItem(record.sourceWorkItemId, record.sourceProblemNo, "Concurrent create")],
    applyDelayMs: 80,
  });
  const previewBody = {
    source: "mcp",
    sourceFallback: false,
    records: [record],
    workItemIds: [record.sourceWorkItemId],
    config: syncConfig(),
  };
  const firstPreview = await post(harness.base, "/records/sync-preview", previewBody);
  const secondPreview = await post(harness.base, "/records/sync-preview", previewBody);
  assert.equal(firstPreview.status, 200);
  assert.equal(secondPreview.status, 200);
  const firstItem = firstPreview.body.data.items[0];
  const secondItem = secondPreview.body.data.items[0];

  const responses = await Promise.all([
    post(harness.base, "/records/sync-apply", {
      planId: firstPreview.body.data.planId,
      recordKeys: [firstItem.recordKey],
    }),
    post(harness.base, "/records/sync-apply", {
      planId: secondPreview.body.data.planId,
      recordKeys: [secondItem.recordKey],
    }),
  ]);
  assert.deepEqual(responses.map((response) => response.status).sort(), [200, 409]);
  assert.equal(harness.calls.applySync.length, 1, "the record lock must prevent a duplicate create/update call");
  assert.equal(harness.calls.runSync, 0);
});

test("record sync plans enforce admin access, expiry, and single-use semantics", async (t) => {
  let clock = Date.parse("2026-07-17T02:00:00.000Z");
  const record = mappingRecord("record-expiring", "NSCP-83001");
  const harness = await createHarness(t, {
    items: [workItem(record.sourceWorkItemId, record.sourceProblemNo, "Expiring preview")],
    preparedPlanTtlMs: 2_000,
    now: () => clock,
  });

  const deniedPreview = await post(harness.base, "/records/sync-preview", {
    source: "mcp",
    sourceFallback: false,
    records: [record],
    workItemIds: [record.sourceWorkItemId],
  }, { admin: false });
  assert.equal(deniedPreview.status, 403);
  assert.equal(harness.calls.capture.length, 0);

  const preview = await post(harness.base, "/records/sync-preview", {
    source: "mcp",
    sourceFallback: false,
    records: [record],
    workItemIds: [record.sourceWorkItemId],
    config: syncConfig(),
  });
  assert.equal(preview.status, 200);
  assert.equal(Date.parse(preview.body.data.expiresAt), clock + 2_000);
  const runSyncCountAfterPreview = harness.calls.runSync;

  const deniedApply = await post(harness.base, "/records/sync-apply", {
    planId: preview.body.data.planId,
    recordKeys: [preview.body.data.items[0].recordKey],
  }, { admin: false });
  assert.equal(deniedApply.status, 403);
  assert.equal(harness.calls.applySync.length, 0);

  clock += 2_001;
  const expiredApply = await post(harness.base, "/records/sync-apply", {
    planId: preview.body.data.planId,
    recordKeys: [preview.body.data.items[0].recordKey],
  });
  assert.equal(expiredApply.status, 410);
  assert.equal(harness.calls.capture.length, 1);
  assert.equal(harness.calls.applySync.length, 0);
  assert.equal(harness.calls.runSync, runSyncCountAfterPreview);
});

test("prepared fingerprint stays stable for the plan clock and rejects a changed clock", async () => {
  const raw = workItem("record-stale-fingerprint", "NSCP-83501", "Stale fingerprint");
  const config = syncConfig();
  const preparedNow = "2026-07-17T02:30:00.000Z";
  const preview = await syncService.syncFeishuProjectWorkItem(raw, {
    dryRun: true,
    config,
    checkRemoteExisting: false,
    now: preparedNow,
  });
  assert.equal(preview.ok, true);
  assert.equal(preview.action, "create");
  assert.ok(preview.preparedFingerprint);

  const replayedPreview = await syncService.syncFeishuProjectWorkItem(raw, {
    dryRun: true,
    config,
    checkRemoteExisting: false,
    now: preparedNow,
    expectedPreparedFingerprint: preview.preparedFingerprint,
  });
  assert.equal(replayedPreview.ok, true);
  assert.equal(replayedPreview.preparedFingerprint, preview.preparedFingerprint);

  const stale = await syncService.syncFeishuProjectWorkItem(raw, {
    dryRun: true,
    config,
    checkRemoteExisting: false,
    now: "2026-07-17T02:30:01.000Z",
    expectedPreparedFingerprint: preview.preparedFingerprint,
  });
  assert.equal(stale.ok, false);
  assert.equal(stale.stale, true);
  assert.match(stale.error, /预演结果已过期/);
  assert.equal(db.getFeishuProjectSyncState({
    sourceProjectKey: PROJECT_KEY,
    sourceWorkItemTypeKey: TYPE_KEY,
    sourceWorkItemId: raw.work_item_id,
  }), null);
});

test("stale target verification does not reset the mapping before fingerprint approval", async () => {
  const record = mappingRecord("record-stale-target", "NSCP-83601", "tb-stale-target");
  db.upsertFeishuProjectSyncState(record);
  const raw = workItem(record.sourceWorkItemId, record.sourceProblemNo, "Stale target verification");
  const config = {
    ...syncConfig(),
    sync: {
      ...syncConfig().sync,
      verifyExistingTargetFields: false,
    },
  };
  const preview = await syncService.syncFeishuProjectWorkItem(raw, {
    dryRun: true,
    config,
    loader: { checkTaskExists: async () => true },
    now: "2026-07-17T02:40:00.000Z",
  });
  assert.equal(preview.ok, true);
  assert.ok(preview.preparedFingerprint);

  const stale = await syncService.syncFeishuProjectWorkItem(raw, {
    dryRun: false,
    config,
    loader: { checkTaskExists: async () => false },
    now: "2026-07-17T02:40:00.000Z",
    expectedPreparedFingerprint: preview.preparedFingerprint,
  });
  assert.equal(stale.ok, false);
  assert.equal(stale.stale, true);
  const retained = db.getFeishuProjectSyncState(record);
  assert.equal(retained?.targetTaskId, record.targetTaskId);
  assert.equal(retained?.syncStatus, "success");
});

function seedRecordGraph(record, suffix) {
  db.upsertFeishuProjectSyncState(record);
  db.insertFeishuProjectRawPayload({
    ...record,
    payloadHash: `raw-${suffix}`,
    payloadJson: workItem(record.sourceWorkItemId, record.sourceProblemNo, `Raw ${suffix}`),
  });
  db.upsertFeishuProjectCommentSync({
    ...record,
    sourceCommentId: `comment-${suffix}`,
    targetCommentId: `tb-comment-${suffix}`,
    sourcePayloadHash: `comment-hash-${suffix}`,
    syncStatus: "success",
  });
  db.upsertFeishuProjectAttachmentSync({
    ...record,
    sourceAttachmentId: `attachment-${suffix}`,
    targetFileId: `tb-file-${suffix}`,
    sourcePayloadHash: `attachment-hash-${suffix}`,
    syncStatus: "success",
  });
  db.upsertFeishuProjectSyncError({
    ...record,
    stage: "record-action-test",
    errorMessage: `delete error ${suffix}`,
    retryable: true,
  });
}

function assertRecordGraph(id, exists) {
  const key = {
    sourceProjectKey: PROJECT_KEY,
    sourceWorkItemTypeKey: TYPE_KEY,
    sourceWorkItemId: id,
  };
  assert.equal(!!db.getFeishuProjectSyncState(key), exists, `state existence for ${id}`);
  assert.equal(db.listFeishuProjectRawPayloads({ projectKey: PROJECT_KEY, typeKey: TYPE_KEY, workItemId: id }).length > 0, exists, `raw existence for ${id}`);
  assert.equal(db.listFeishuProjectCommentSync({ projectKey: PROJECT_KEY, typeKey: TYPE_KEY, workItemId: id }).length > 0, exists, `comment existence for ${id}`);
  assert.equal(db.listFeishuProjectAttachmentSync({ projectKey: PROJECT_KEY, typeKey: TYPE_KEY, workItemId: id }).length > 0, exists, `attachment existence for ${id}`);
  assert.equal(db.listFeishuProjectSyncErrors({ projectKey: PROJECT_KEY, typeKey: TYPE_KEY, workItemId: id }).length > 0, exists, `error existence for ${id}`);
}

test("record delete requires confirmation and physically deletes only selected record graphs", async (t) => {
  const single = mappingRecord("record-delete-single", "NSCP-84001", "tb-delete-single");
  const batchOne = mappingRecord("record-delete-batch-one", "NSCP-84002", "tb-delete-batch-one");
  const batchTwo = mappingRecord("record-delete-batch-two", "NSCP-84003", "tb-delete-batch-two");
  const retained = mappingRecord("record-delete-retained", "NSCP-84004", "tb-delete-retained");
  seedRecordGraph(single, "single");
  seedRecordGraph(batchOne, "batch-one");
  seedRecordGraph(batchTwo, "batch-two");
  seedRecordGraph(retained, "retained");

  const harness = await createHarness(t);
  const denied = await post(harness.base, "/records/delete", {
    confirm: true,
    records: [single],
  }, { admin: false });
  assert.equal(denied.status, 403);
  assert.equal(harness.calls.delete.length, 0);

  const missingConfirm = await post(harness.base, "/records/delete", {
    records: [single],
  });
  assert.equal(missingConfirm.status, 400);
  assert.equal(harness.calls.delete.length, 0);

  const fakeTargetDelete = await post(harness.base, "/records/delete", {
    confirm: true,
    records: [{ ...retained, targetSystem: "not-a-real-target" }],
  });
  assert.equal(fakeTargetDelete.status, 200);
  assert.equal(fakeTargetDelete.body?.data?.records, 0);
  assert.equal(fakeTargetDelete.body?.data?.missingKeys?.length, 1);
  assertRecordGraph(retained.sourceWorkItemId, true);

  const deletedSingle = await post(harness.base, "/records/delete", {
    confirm: true,
    records: [single],
  });
  assert.equal(deletedSingle.status, 200);
  assert.equal(deletedSingle.body?.success, true);
  assert.equal(deletedSingle.body?.data?.deletedKeys?.length, 1);
  assert.equal(harness.calls.delete.length, 2);
  assertRecordGraph(single.sourceWorkItemId, false);
  assertRecordGraph(batchOne.sourceWorkItemId, true);
  assertRecordGraph(batchTwo.sourceWorkItemId, true);
  assertRecordGraph(retained.sourceWorkItemId, true);
  const tombstone = db.listFeishuProjectSyncStatesSince(0, { limit: 1000 })
    .find((row) => row.deleted && row.sourceWorkItemId === single.sourceWorkItemId);
  assert.ok(tombstone, "deleted mappings must be exposed as LAN replication tombstones");
  db.mergeFeishuProjectSyncState({
    ...single,
    targetTaskId: "tb-stale-replica",
    replicatedAt: Math.max(1, tombstone.replicatedAt - 1),
    updatedAt: "2026-07-16T00:00:00.000Z",
  });
  assert.equal(db.getFeishuProjectSyncState(single), null, "an older peer mapping must not revive a deleted row");

  const deletedBatch = await post(harness.base, "/records/delete", {
    confirm: true,
    records: [batchOne, batchTwo],
  });
  assert.equal(deletedBatch.status, 200);
  assert.equal(deletedBatch.body?.success, true);
  assert.equal(deletedBatch.body?.data?.deletedKeys?.length, 2);
  assert.equal(harness.calls.delete.length, 3);
  assertRecordGraph(batchOne.sourceWorkItemId, false);
  assertRecordGraph(batchTwo.sourceWorkItemId, false);
  assertRecordGraph(retained.sourceWorkItemId, true);

  const counts = deletedBatch.body?.data?.counts || deletedBatch.body?.data || {};
  assert.equal(counts.state ?? counts.records, 2);
  assert.equal(counts.comments, 2);
  assert.equal(counts.attachments, 2);
  assert.equal(counts.errors, 2);
  assert.equal(counts.raw ?? counts.rawPayloads, 2);
});
