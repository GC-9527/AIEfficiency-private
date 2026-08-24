import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import express from "express";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "feishu-refresh-route-"));
process.env.GATEWAY_CONFIG_PATH = path.join(tempDir, "config.json");
process.env.GATEWAY_DB_PATH = path.join(tempDir, "data.db");
fs.writeFileSync(process.env.GATEWAY_CONFIG_PATH, "{}", "utf8");

const { createFeishuProjectSyncRouter } = await import("../../features/FeiShuProjects/src/gateway-route.js");

function workItem(index) {
  return {
    work_item_id: `refresh-route-${index}`,
    space_key: "intelligentspace",
    work_item_type_key: "bug",
    fields: [],
  };
}

async function startHarness(captureItems, { total = captureItems.length } = {}) {
  const refreshCalls = [];
  const app = express();
  app.use(express.json());
  app.use(createFeishuProjectSyncRouter({
    Router: express.Router,
    verifyToken: (token) => token === "admin-token" ? { role: "admin", name: "Admin" } : null,
    getConfig: () => ({ feishuProjectSync: { feishu: { spaceKey: "intelligentspace", workItemTypeKey: "bug" } } }),
    captureMcpItems: async () => ({ ok: true, total, items: captureItems }),
    refreshSourceRecords: async (options) => {
      refreshCalls.push(options);
      return { ok: true, refreshed: options.workItems.length, snapshotComplete: options.snapshotComplete };
    },
  }));
  const server = await new Promise((resolve) => {
    const instance = app.listen(0, "127.0.0.1", () => resolve(instance));
  });
  return {
    base: `http://127.0.0.1:${server.address().port}`,
    refreshCalls,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

async function refresh(base, body) {
  const response = await fetch(`${base}/records/refresh`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer admin-token" },
    body: JSON.stringify(body),
  });
  return { status: response.status, payload: await response.json() };
}

test("records refresh only reconciles an explicitly requested complete source snapshot", async (t) => {
  const complete = await startHarness([workItem(1), workItem(2)]);
  t.after(complete.close);
  const completeResponse = await refresh(complete.base, { source: "mcp", limit: 200, reconcileSnapshot: true });
  assert.equal(completeResponse.status, 200);
  assert.equal(complete.refreshCalls[0]?.reconcileSnapshot, true);
  assert.equal(complete.refreshCalls[0]?.snapshotComplete, true);

  const capped = await startHarness(Array.from({ length: 200 }, (_, index) => workItem(index)));
  t.after(capped.close);
  const cappedResponse = await refresh(capped.base, { source: "mcp", limit: 200, reconcileSnapshot: true });
  assert.equal(cappedResponse.status, 200);
  assert.equal(capped.refreshCalls[0]?.snapshotComplete, false);

  const targeted = await startHarness([workItem(3)]);
  t.after(targeted.close);
  const targetedResponse = await refresh(targeted.base, { source: "mcp", limit: 200, reconcileSnapshot: true, workItemIds: ["refresh-route-3"] });
  assert.equal(targetedResponse.status, 200);
  assert.equal(targeted.refreshCalls[0]?.snapshotComplete, false);

  const problemTargeted = await startHarness([workItem(4)]);
  t.after(problemTargeted.close);
  const problemTargetedResponse = await refresh(problemTargeted.base, { source: "mcp", limit: 200, reconcileSnapshot: true, problemNos: ["NSCP-4"] });
  assert.equal(problemTargetedResponse.status, 200);
  assert.equal(problemTargeted.refreshCalls[0]?.snapshotComplete, false);

  const truncated = await startHarness([workItem(5), workItem(6)], { total: 3 });
  t.after(truncated.close);
  const truncatedResponse = await refresh(truncated.base, { source: "mcp", limit: 200, reconcileSnapshot: true });
  assert.equal(truncatedResponse.status, 200);
  assert.equal(truncated.refreshCalls[0]?.snapshotComplete, false);

  const notRequested = await startHarness([workItem(7)]);
  t.after(notRequested.close);
  const notRequestedResponse = await refresh(notRequested.base, { source: "mcp", limit: 200 });
  assert.equal(notRequestedResponse.status, 200);
  assert.equal(notRequested.refreshCalls[0]?.snapshotComplete, false);
});
