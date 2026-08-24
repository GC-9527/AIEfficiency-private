import { after, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "story-artifact-http-"));
process.env.NODE_ENV = "production";
process.env.GATEWAY_DB_PATH = path.join(root, "gateway.db");
process.env.GATEWAY_CONFIG_PATH = path.join(root, "gateway.json");
process.env.DEVBENCH_CONFIG_PATH = path.join(root, "market.json");
process.env.DEVBENCH_LOCAL_PROJECTS_PATH = path.join(root, "projects.json");
process.env.DEVBENCH_STORE_DIR = path.join(root, "store");
process.env.AIEFFICIENCY_CLONE_PARENT = path.join(root, "clone-parent");
fs.writeFileSync(process.env.GATEWAY_CONFIG_PATH, JSON.stringify({
  servers: { nodeId: "story-artifact-ticket-test" },
}));
fs.writeFileSync(process.env.DEVBENCH_CONFIG_PATH, "{}");

const express = (await import("express")).default;
const store = await import("../services/devbench/store.js");
const router = (await import("../routes/devbench.js")).default;
const { issueToken, revokeToken } = await import("../services/admin-auth.js");
const {
  inspectStoryArtifactTicket,
  storyArtifactSnapshotStore,
} = await import("../services/devbench/artifact-ticket.js");

const repository = path.join(root, "repository");
fs.mkdirSync(repository, { recursive: true });
assert.equal(store.upsertProject({
  id: "artifact-project",
  name: "Artifact Project",
  path: repository,
}).ok, true);
let tab = store.createTab({ title: "artifact ticket" });
tab = store.updateTab(tab.id, { primaryProjectId: "artifact-project" });
const storage = store.getStoryStoragePaths(tab, { create: true });
const artifact = path.join(storage.reportsDirectory, "video.webm");
fs.writeFileSync(artifact, "0123456789");
const reference = "storydev:/reports/video.webm";

const app = express();
app.use(express.json());
app.use("/api/devbench", router);
const server = await new Promise((resolve) => {
  const instance = app.listen(0, "127.0.0.1", () => resolve(instance));
});
const base = `http://127.0.0.1:${server.address().port}/api/devbench`;
const adminToken = issueToken({
  id: "artifact-admin",
  username: "artifact-admin",
  role: "admin",
});
const adminHeaders = {
  Authorization: `Bearer ${adminToken}`,
  "Content-Type": "application/json",
};
const issuedSnapshots = [];

after(async () => {
  revokeToken(adminToken);
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  for (const snapshot of issuedSnapshots) {
    try { await storyArtifactSnapshotStore.deleteSnapshot(snapshot); } catch {}
  }
  try {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch {
    // better-sqlite3 keeps the per-process test database open until process
    // shutdown on Windows; the OS temp directory remains isolated.
  }
});

async function issue(items, headers = adminHeaders) {
  return fetch(`${base}/tabs/${tab.id}/artifact-tickets`, {
    method: "POST",
    headers,
    body: JSON.stringify({ items }),
  });
}

async function issuePayload(items) {
  const response = await issue(items);
  const payload = await response.json();
  assert.equal(response.status, 200, `${payload.code || "HTTP_ERROR"}: ${payload.error || JSON.stringify(payload)}`);
  for (const item of payload.data.items) {
    const inspected = inspectStoryArtifactTicket(item.ticket, {
      tabId: tab.id,
      ref: item.ref,
      download: item.download === true,
      method: "GET",
    });
    issuedSnapshots.push({
      id: inspected.snapshot.id,
      expiresAt: inspected.expiresAt,
    });
  }
  return payload;
}

test("production requires Bearer to issue a scoped artifact ticket", async () => {
  const anonymous = await issue([{ ref: reference }], { "Content-Type": "application/json" });
  assert.equal(anonymous.status, 401);

  const payload = await issuePayload([{ ref: reference }]);
  assert.equal(payload.ok, true);
  assert.equal(payload.data.items.length, 1);
  assert.equal(payload.data.items[0].ref, reference);
  assert.match(payload.data.items[0].ticket, /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/);
  assert.equal(payload.data.items[0].ticket.includes(adminToken), false);
});

test("one ticket supports repeated Range requests but rejects scope tampering", async () => {
  const issued = await issuePayload([{ ref: reference }]);
  const ticket = issued.data.items[0].ticket;
  const url = `${base}/tabs/${tab.id}/artifact?ref=${encodeURIComponent(reference)}&ticket=${encodeURIComponent(ticket)}`;

  const first = await fetch(url, { headers: { Range: "bytes=0-1" } });
  assert.equal(first.status, 206);
  assert.equal(await first.text(), "01");
  assert.equal(first.headers.get("referrer-policy"), "no-referrer");
  assert.equal(first.headers.get("cache-control"), "private, no-store");

  const second = await fetch(url, { headers: { Range: "bytes=2-3" } });
  assert.equal(second.status, 206);
  assert.equal(await second.text(), "23");

  const head = await fetch(url, { method: "HEAD" });
  assert.equal(head.status, 200);
  assert.equal(head.headers.get("content-length"), "10");
  assert.equal(await head.text(), "");

  const wrongRef = await fetch(
    `${base}/tabs/${tab.id}/artifact?ref=${encodeURIComponent("storydev:/reports/other.webm")}&ticket=${encodeURIComponent(ticket)}`,
  );
  assert.equal(wrongRef.status, 403);
  const noTicket = await fetch(
    `${base}/tabs/${tab.id}/artifact?ref=${encodeURIComponent(reference)}`,
  );
  assert.equal(noTicket.status, 401);
  const authenticatedWithoutTicket = await fetch(
    `${base}/tabs/${tab.id}/artifact?ref=${encodeURIComponent(reference)}`,
    { headers: { Authorization: `Bearer ${adminToken}` } },
  );
  assert.equal(authenticatedWithoutTicket.status, 401);
});

test("hard-linked artifact leaves are never eligible for a ticket", async () => {
  const hardlinkSource = path.join(root, "hardlink-source.txt");
  const hardlinkTarget = path.join(storage.reportsDirectory, "hardlink.txt");
  fs.writeFileSync(hardlinkSource, "sensitive");
  fs.linkSync(hardlinkSource, hardlinkTarget);
  const response = await issue([{ ref: "storydev:/reports/hardlink.txt" }]);
  assert.equal(response.status, 400);
  const payload = await response.json();
  assert.equal(payload.code, "STORY_ARTIFACT_FILE_UNSAFE");
});

test("parent-directory replacement cannot make a ticket return replacement bytes", async () => {
  const issued = await issuePayload([{ ref: reference }]);
  const ticket = issued.data.items[0].ticket;
  const originalReports = `${storage.reportsDirectory}-original`;
  const sensitiveMarker = "EXTERNAL-SENSITIVE-CONTENT";
  fs.renameSync(storage.reportsDirectory, originalReports);
  try {
    fs.mkdirSync(storage.reportsDirectory, { recursive: true });
    fs.writeFileSync(path.join(storage.reportsDirectory, "video.webm"), sensitiveMarker);
    const response = await fetch(
      `${base}/tabs/${tab.id}/artifact?ref=${encodeURIComponent(reference)}&ticket=${encodeURIComponent(ticket)}`,
    );
    assert.equal(response.status, 403);
    assert.equal((await response.text()).includes(sensitiveMarker), false);
  } finally {
    fs.rmSync(storage.reportsDirectory, { recursive: true, force: true });
    fs.renameSync(originalReports, storage.reportsDirectory);
  }
});

test("file replacement and tab deletion immediately invalidate an old ticket", async () => {
  const firstIssued = await issuePayload([{ ref: reference }]);
  const firstTicket = firstIssued.data.items[0].ticket;
  await new Promise((resolve) => setTimeout(resolve, 5));
  fs.writeFileSync(artifact, "replacement-content");
  const replaced = await fetch(
    `${base}/tabs/${tab.id}/artifact?ref=${encodeURIComponent(reference)}&ticket=${encodeURIComponent(firstTicket)}`,
  );
  assert.equal(replaced.status, 403);

  const secondIssued = await issuePayload([{ ref: reference }]);
  const secondTicket = secondIssued.data.items[0].ticket;
  assert.equal(store.discardUnpublishedTab(tab.id).removed, 1);
  const deleted = await fetch(
    `${base}/tabs/${tab.id}/artifact?ref=${encodeURIComponent(reference)}&ticket=${encodeURIComponent(secondTicket)}`,
  );
  assert.equal(deleted.status, 403);
});
