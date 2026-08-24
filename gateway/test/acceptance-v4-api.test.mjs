import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import express from "express";

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "aieff-acceptance-api-"));
process.env.GATEWAY_DB_PATH = path.join(tempRoot, "api.db");
process.env.NODE_ENV = "test";

const { default: router } = await import(`../routes/aiautowork.js?acceptance-api=${Date.now()}`);
const dbModule = await import("../db/sqlite.js");
const auth = await import("../services/admin-auth.js");

const app = express();
app.use(express.json());
app.use("/api/aiautowork", router);
const server = await new Promise((resolve) => {
  const instance = app.listen(0, "127.0.0.1", () => resolve(instance));
});
const baseUrl = `http://127.0.0.1:${server.address().port}/api/aiautowork`;

const adminId = `acceptance-admin-${Date.now()}`;
dbModule.addAdminUser({ dingUserid: adminId, name: "Acceptance Admin", addedBy: "test" });
const login = auth.dingUserLogin(adminId, "Acceptance Admin", { authMethod: "test" });
assert.equal(login.ok, true);
const headers = { Authorization: `Bearer ${login.token}`, "Content-Type": "application/json" };

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  try { dbModule.default.close(); } catch {}
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

test("sync aiautowork handlers send JSON instead of hanging", async () => {
  const response = await fetch(`${baseUrl}/overview`);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.ok, true);
  assert.ok(body.data.counts);
});

test("acceptance read and write endpoints require an administrator Principal", async () => {
  const read = await fetch(`${baseUrl}/acceptance/runs`);
  assert.equal(read.status, 401);
  const write = await fetch(`${baseUrl}/acceptance/route`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ project_task_id: "PROJECT-UNAUTHORIZED" }),
  });
  assert.equal(write.status, 401);
});

test("authorized route API returns the split acceptance route", async () => {
  const response = await fetch(`${baseUrl}/acceptance/route`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      project_task_id: "PROJECT-API-1",
      direct_project_task: true,
      project_paths: ["gateway/services/acceptance"],
      target_repositories: ["AIEfficiency"],
      change_type: "TEST_OR_HARNESS",
    }),
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.ok, true);
  assert.equal(body.data.route.task_origin, "DIRECT_ENGINEERING");
  assert.equal(body.data.route.scope_kind, "PROJECT_ENGINEERING");
  assert.deepEqual(body.data.route.protocols, ["project-engineering-acceptance"]);
});

test("authorized acceptance list returns both runs and items for UI compatibility", async () => {
  const response = await fetch(`${baseUrl}/acceptance/runs`, { headers });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.ok, true);
  assert.ok(Array.isArray(body.data.runs));
  assert.deepEqual(body.data.items, body.data.runs);
});

test("acceptance API cannot promote caller supplied PASS or trust declarations", async () => {
  const createdResponse = await fetch(`${baseUrl}/acceptance/project-runs`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      project_task_id: "PROJECT-API-SELF-PROOF",
      mode: "PROJECT-STANDARD",
      change_type: "FEATURE",
      project_paths: ["gateway/services/acceptance"],
      target_repositories: ["AIEfficiency"],
      candidate: {
        repository: "AIEfficiency",
        base_ref: "base",
        head_ref: "head",
        diff_hash: "diff-api",
        environment_id: "api-test",
      },
      gates: [{ id: "P0_SCOPE", result: "PASS", evidence_ids: ["caller-made-id"] }],
    }),
  });
  assert.equal(createdResponse.status, 200);
  const created = (await createdResponse.json()).data;
  assert.equal(created.projectChangeDecision, "PARTIAL");

  const evidenceResponse = await fetch(`${baseUrl}/acceptance/runs/${created.id}/evidence`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      gateId: "P0_SCOPE",
      kind: "command",
      candidateIdentityHash: created.candidateIdentityHash,
      environmentId: created.environmentId,
      command: "caller-controlled-command",
      exitCode: 0,
      sha256: "caller-controlled-sha",
      trustLevel: "MECHANICAL",
      producer: "caller-controlled-producer",
    }),
  });
  assert.equal(evidenceResponse.status, 200);
  const evidence = (await evidenceResponse.json()).data;
  assert.equal(evidence.trustLevel, "UNVERIFIED");
  assert.equal(evidence.producer, "ADMIN_API");

  const resumedResponse = await fetch(`${baseUrl}/acceptance/runs/${created.id}/resume`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      gates: [{ id: "P0_SCOPE", result: "PASS", evidence_ids: [evidence.id] }],
    }),
  });
  assert.equal(resumedResponse.status, 200);
  const resumed = (await resumedResponse.json()).data;
  assert.equal(resumed.projectChangeDecision, "PARTIAL");
  assert.equal(resumed.gates.find((gate) => gate.id === "P0_SCOPE").result, "PENDING");
});
