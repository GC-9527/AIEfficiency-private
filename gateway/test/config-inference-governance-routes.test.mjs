import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "config-inference-governance-routes-"));
process.env.GATEWAY_DB_PATH = path.join(tmp, "gateway.db");
process.env.GATEWAY_CONFIG_PATH = path.join(tmp, "gateway.json");
process.env.DEVBENCH_CONFIG_PATH = path.join(tmp, "market.json");
process.env.DEVBENCH_LOCAL_PROJECTS_PATH = path.join(tmp, "local", "devbench-projects.json");
process.env.DEVBENCH_STORE_DIR = path.join(tmp, "store");
process.env.AIEFFICIENCY_CLONE_PARENT = path.join(tmp, "clone-parent");
process.env.ROLE = "standalone";

fs.writeFileSync(process.env.GATEWAY_CONFIG_PATH, JSON.stringify({
  role: "standalone",
  servers: { nodeId: "governance-route-node" },
  claudeProxyClient: { host: "http://central.invalid:19090" },
  teambition: { projects: [{ id: "project-route-governance", name: "route governance" }] },
}), "utf8");
fs.writeFileSync(process.env.DEVBENCH_CONFIG_PATH, JSON.stringify({
  projectDefs: [{
    id: "market",
    name: "market",
    ssh: "git@example.com:apps/market.git",
    branchOptions: ["release/base"],
    flavorOptions: ["demoProd"],
  }],
  byProject: {
    "project-route-governance": {
      keywordMappings: {
        title: {
          market: { category: "app", value: "market" },
          demo: { category: "vehicle", value: "demo" },
        },
      },
      vehicleMap: {
        demo: {
          apps: [{
            appName: "market",
            repos: [{ repoId: "market", branch: "release/base", flavor: "demoProd" }],
          }],
        },
      },
    },
  },
}), "utf8");

const express = (await import("express")).default;
const router = (await import("../routes/devbench.js")).default;
const store = await import("../services/devbench/store.js");
const { issueToken, revokeToken } = await import("../services/admin-auth.js");

const seededRun = store.runConfigInference("project-route-governance", {
  captureSignals: false,
  ticket: {
    ticketId: "ROUTE-GOVERNANCE-CASE",
    projectId: "project-route-governance",
    title: "market demo",
  },
});
assert.equal(seededRun.ok, true, seededRun.error);
const seededReview = store.reviewConfigInferenceRun("project-route-governance", seededRun.data.id, {
  decision: "correct",
  rating: 5,
  reviewer: "seed-annotator",
});
assert.equal(seededReview.ok, true, seededReview.error);

const app = express();
app.use(express.json());
app.use("/api/devbench", router);
const server = await new Promise((resolve) => {
  const instance = app.listen(0, "127.0.0.1", () => resolve(instance));
});
const base = `http://127.0.0.1:${server.address().port}/api/devbench`;
const nativeFetch = globalThis.fetch;
let centralFetchCalls = 0;
globalThis.fetch = async (input, init) => {
  const url = String(typeof input === "string" ? input : input?.url || "");
  if (url.startsWith("http://central.invalid:19090")) {
    centralFetchCalls++;
    throw new Error("central fetch must not be called for machine bindings");
  }
  return nativeFetch(input, init);
};

const adminToken = issueToken({
  role: "admin",
  name: "可变显示名",
  dingUserid: "ding-admin-stable-a",
});
const secondAdminToken = issueToken({
  role: "admin",
  name: "第二评审人",
  dingUserid: "ding-admin-stable-b",
});
const viewerToken = issueToken({
  role: "viewer",
  name: "只读用户",
  dingUserid: "ding-viewer-stable-a",
});
const unstableViewerToken = issueToken({
  role: "viewer",
  name: "只有可变显示名",
});
const headers = (token) => ({ Authorization: `Bearer ${token}`, "Content-Type": "application/json" });
const request = async (method, pathname, token, body) => {
  const response = await nativeFetch(`${base}${pathname}`, {
    method,
    headers: token ? headers(token) : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
};

test.after(async () => {
  process.env.ROLE = "standalone";
  globalThis.fetch = nativeFetch;
  revokeToken(adminToken);
  revokeToken(secondAdminToken);
  revokeToken(viewerToken);
  revokeToken(unstableViewerToken);
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  try {
    const { default: db } = await import("../db/sqlite.js");
    if (db?.open) db.close();
  } catch {}
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
});

test("v2 governance GET requires authentication and redacts revisions/effective values for non-admin", async () => {
  const missing = await request(
    "GET",
    "/ai-training/v2/knowledge-keys?projectId=project-route-governance",
  );
  assert.equal(missing.status, 401);

  const viewer = await request(
    "GET",
    "/ai-training/v2/knowledge-keys?projectId=project-route-governance",
    viewerToken,
  );
  assert.equal(viewer.status, 200, viewer.body.error);
  assert.ok(viewer.body.data.length > 0);
  assert.equal(Object.hasOwn(viewer.body.data[0], "revisions"), false);
  assert.equal(Object.hasOwn(viewer.body.data[0].effective || {}, "actualValue"), false);
  assert.equal(Object.hasOwn(viewer.body.data[0].effective || {}, "scopeId"), false);
});

test("config-inference run/review require stable identity and ignore forged reviewer", async () => {
  process.env.ROLE = "standalone";
  const runBody = {
    projectId: "project-route-governance",
    title: "market demo",
    captureSignals: false,
  };
  const anonymousRun = await request(
    "POST",
    "/ai-training/config-inference/run",
    null,
    runBody,
  );
  assert.equal(anonymousRun.status, 401);

  const unstableRun = await request(
    "POST",
    "/ai-training/config-inference/run",
    unstableViewerToken,
    runBody,
  );
  assert.equal(unstableRun.status, 403);
  assert.match(unstableRun.body.error, /稳定/);

  const created = await request(
    "POST",
    "/ai-training/config-inference/run",
    adminToken,
    runBody,
  );
  assert.equal(created.status, 200, created.body.error);
  const runId = created.body.data.id;
  assert.ok(runId);

  const anonymousReview = await request(
    "POST",
    `/ai-training/config-inference/runs/${encodeURIComponent(runId)}/review`,
    null,
    {
      projectId: "project-route-governance",
      decision: "correct",
      rating: 5,
      reviewer: "spoofed-client-reviewer",
    },
  );
  assert.equal(anonymousReview.status, 401);

  const unstableReview = await request(
    "POST",
    `/ai-training/config-inference/runs/${encodeURIComponent(runId)}/review`,
    unstableViewerToken,
    {
      projectId: "project-route-governance",
      decision: "correct",
      rating: 5,
      reviewer: "spoofed-client-reviewer",
    },
  );
  assert.equal(unstableReview.status, 403);

  const reviewed = await request(
    "POST",
    `/ai-training/config-inference/runs/${encodeURIComponent(runId)}/review`,
    adminToken,
    {
      projectId: "project-route-governance",
      decision: "correct",
      rating: 5,
      reviewer: "spoofed-client-reviewer",
    },
  );
  assert.equal(reviewed.status, 200, reviewed.body.error);
  assert.equal(reviewed.body.data.review.reviewer, "ding-admin-stable-a");
  assert.equal(reviewed.body.sample.annotation.reviewer, "ding-admin-stable-a");
  assert.notEqual(reviewed.body.data.review.reviewer, "spoofed-client-reviewer");
});

test("ROLE=node machine binding remains in this Gateway and never calls central fetch", async () => {
  const listed = await request(
    "GET",
    "/ai-training/v2/knowledge-keys?projectId=project-route-governance",
    adminToken,
  );
  assert.equal(listed.status, 200, listed.body.error);
  const branchKey = listed.body.data.find((row) => row.dimension === "branch");
  assert.ok(branchKey?.keyId);

  process.env.ROLE = "node";
  centralFetchCalls = 0;
  const denied = await request(
    "GET",
    "/ai-training/v2/machine-bindings?projectId=project-route-governance",
    viewerToken,
  );
  assert.equal(denied.status, 403);
  assert.equal(centralFetchCalls, 0);

  const saved = await request(
    "PUT",
    `/ai-training/v2/machine-bindings/${encodeURIComponent(branchKey.keyId)}`,
    adminToken,
    {
      projectId: "project-route-governance",
      actualValue: "D:\\workspace\\node-only",
      expectedRevision: 0,
      reason: "node-local route test",
      operator: "spoofed-client-actor",
    },
  );
  assert.equal(saved.status, 200, saved.body.error);
  assert.equal(saved.body.data.createdBy, "ding-admin-stable-a");
  assert.equal(centralFetchCalls, 0);

  const local = await request(
    "GET",
    "/ai-training/v2/machine-bindings?projectId=project-route-governance",
    adminToken,
  );
  assert.equal(local.status, 200, local.body.error);
  assert.equal(local.body.data.some((row) => row.actualValue === "D:\\workspace\\node-only"), true);
  assert.equal(centralFetchCalls, 0);

  const reset = await request(
    "PUT",
    `/ai-training/v2/machine-bindings/${encodeURIComponent(branchKey.keyId)}`,
    adminToken,
    {
      projectId: "project-route-governance",
      actualValue: "release/base",
      expectedRevision: 1,
      reason: "restore valid local branch after path isolation assertion",
    },
  );
  assert.equal(reset.status, 200, reset.body.error);
  assert.equal(centralFetchCalls, 0);
});

test("annotation approval requires two distinct stable reviewers and conflicting labels never serve", async () => {
  process.env.ROLE = "standalone";
  const run = store.runConfigInference("project-route-governance", {
    captureSignals: false,
    ticket: {
      ticketId: "ROUTE-DUAL-REVIEW",
      projectId: "project-route-governance",
      title: "market demo",
    },
  });
  assert.equal(run.ok, true, run.error);
  const reviewed = store.reviewConfigInferenceRun("project-route-governance", run.data.id, {
    decision: "correct",
    rating: 5,
    reviewer: "seed-annotator",
  });
  assert.equal(reviewed.ok, true, reviewed.error);
  const annotationId = reviewed.sample.id;
  const first = await request(
    "POST",
    `/ai-training/v2/annotations/${encodeURIComponent(annotationId)}/approve`,
    adminToken,
    {
      projectId: "project-route-governance",
      reviewer: "spoofed-client-reviewer",
      reason: "first vote",
    },
  );
  assert.equal(first.status, 200, first.body.error);
  assert.equal(first.body.requiresMoreReviewers, true);
  assert.equal(first.body.data.servingStatus, "pending");
  assert.equal(first.body.data.annotation.votes[0].reviewerId, "ding-admin-stable-a");

  const duplicate = await request(
    "POST",
    `/ai-training/v2/annotations/${encodeURIComponent(annotationId)}/approve`,
    adminToken,
    {
      projectId: "project-route-governance",
      reason: "duplicate vote",
    },
  );
  assert.equal(duplicate.status, 200, duplicate.body.error);
  assert.equal(duplicate.body.idempotent, true);
  assert.equal(duplicate.body.data.servingStatus, "pending");

  const conflict = await request(
    "POST",
    `/ai-training/v2/annotations/${encodeURIComponent(annotationId)}/approve`,
    secondAdminToken,
    {
      projectId: "project-route-governance",
      decision: "ticket_wrong",
      noTargets: true,
      reason: "conflicting label",
    },
  );
  assert.equal(conflict.status, 200, conflict.body.error);
  assert.equal(conflict.body.adjudication.status, "adjudication_required");
  assert.equal(conflict.body.data.servingStatus, "pending");
  assert.equal(store.getConfigInferenceData("project-route-governance").metrics.learnedSamples, 0);
});

test("positive annotation with incomplete TB sources is blocked before a reviewer vote is recorded", async () => {
  const capturedAt = "2026-07-29T00:00:00.000Z";
  const run = store.runConfigInference("project-route-governance", {
    captureSignals: false,
    ticket: {
      ticketId: "ROUTE-INCOMPLETE-SOURCE",
      tbTaskId: "ROUTE-INCOMPLETE-SOURCE",
      projectId: "project-route-governance",
      title: "market demo",
      snapshotAt: capturedAt,
      sourceCoverage: {
        detail: { available: true, complete: true, capturedAt },
        comments: { available: false, complete: false, capturedAt },
        attachments: { available: true, complete: true, capturedAt },
        tags: { available: true, complete: true, capturedAt },
      },
    },
  });
  assert.equal(run.ok, true, run.error);
  const reviewed = store.reviewConfigInferenceRun("project-route-governance", run.data.id, {
    decision: "correct",
    rating: 5,
    reviewer: "seed-annotator",
  });
  assert.equal(reviewed.ok, true, reviewed.error);

  const blocked = await request(
    "POST",
    `/ai-training/v2/annotations/${encodeURIComponent(reviewed.sample.id)}/approve`,
    adminToken,
    {
      projectId: "project-route-governance",
      allowPartialCoverage: true,
      overrideReason: "client override must not bypass serving gate",
    },
  );
  assert.equal(blocked.status, 409);
  assert.equal(blocked.body.code, "CONFIG_INFERENCE_ANNOTATION_APPROVAL_BLOCKED");
  assert.ok(blocked.body.blockers.includes("SOURCE_GATE_NOT_PASSED"));
  const persisted = store.getConfigInferenceData("project-route-governance").samples
    .find((row) => row.id === reviewed.sample.id);
  assert.equal(persisted.annotation.votes.length, 0);
  assert.equal(persisted.servingStatus, "pending");
});

test("legacy config-inference read cannot bypass v2 authentication or leak retired node values", async () => {
  process.env.ROLE = "node";
  const branchKey = store.listConfigInferenceKnowledgeKeys("project-route-governance")
    .data.find((row) => row.dimension === "branch");
  const unixLocal = await request(
    "PUT",
    `/ai-training/v2/machine-bindings/${encodeURIComponent(branchKey.keyId)}`,
    adminToken,
    {
      projectId: "project-route-governance",
      actualValue: "/root/private",
      expectedRevision: 2,
      reason: "verify unix node path redaction",
    },
  );
  assert.equal(unixLocal.status, 200, unixLocal.body.error);
  process.env.ROLE = "standalone";

  const anonymous = await request(
    "GET",
    "/ai-training/config-inference?projectId=project-route-governance",
  );
  assert.equal(anonymous.status, 401);

  const viewer = await request(
    "GET",
    "/ai-training/config-inference?projectId=project-route-governance",
    viewerToken,
  );
  assert.equal(viewer.status, 200, viewer.body.error);
  const serialized = JSON.stringify(viewer.body);
  assert.equal(serialized.includes("D:\\\\workspace\\\\node-only"), false);
  assert.equal(serialized.includes("/root/private"), false);
  const nodeScopedRows = (viewer.body.data.valueBindings || [])
    .filter((row) => row.effectiveScope === "node");
  assert.ok(nodeScopedRows.length > 0);
  assert.equal(nodeScopedRows.every((row) => !Object.hasOwn(row, "actualValue")), true);
  assert.equal(serialized.includes("valueRevisions"), false);
  assert.equal(serialized.includes("scopeId\":\"governance-route-node"), false);

  const reset = await request(
    "PUT",
    `/ai-training/v2/machine-bindings/${encodeURIComponent(branchKey.keyId)}`,
    adminToken,
    {
      projectId: "project-route-governance",
      actualValue: "release/base",
      expectedRevision: 3,
      reason: "restore portable branch after unix redaction assertion",
    },
  );
  assert.equal(reset.status, 200, reset.body.error);
});
