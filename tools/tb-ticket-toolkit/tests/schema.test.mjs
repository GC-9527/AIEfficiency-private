import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function load(name) {
  return JSON.parse(fs.readFileSync(path.join(root, "schemas", name), "utf8"));
}

test("所有发布 JSON Schema 均可由 draft 2020-12 校验器编译", () => {
  const ajv = new Ajv2020({ strict: true, allErrors: true });
  addFormats(ajv);
  for (const name of [
    "attachment-selection.schema.json",
    "tb-ticket-context.schema.json",
    "tb-update-plan.schema.json",
    "tb-operation-record.schema.json",
  ]) {
    assert.equal(typeof ajv.compile(load(name)), "function", name);
  }
});

test("update plan 与 durable operation 示例满足发布契约", () => {
  const ajv = new Ajv2020({ strict: true, allErrors: true });
  addFormats(ajv);
  const hex = "a".repeat(64);
  const plan = {
    schemaVersion: 1, planId: "plan", fingerprint: hex,
    createdAt: "2026-08-23T00:00:00.000Z", expiresAt: "2026-08-23T00:15:00.000Z",
    phase: "TRIAGE", taskRef: "CARB-1",
    taskSnapshot: { taskId: "task", taskNo: "CARB-1", currentStatus: {}, versionToken: "v1", contextDigest: hex },
    workflowSnapshot: { projectId: "project", taskflowId: "flow", workflowVersion: "v1" },
    proposedChanges: { targetStatus: { statusId: "status" }, comment: "原因：上下文不完整；措施：补充读取并验证。", commentHash: hex },
    normalizedReason: "上下文不完整", normalizedMeasure: "补充读取并验证", styleChecks: [],
    evidenceRefs: [{ kind: "source", result: "OBSERVED", summary: "fixture" }], evidenceDigest: hex,
    source: { commit: "fixture" }, idempotencyKey: "tbfix:key", revalidated: false, applyAllowed: false, blockers: [],
  };
  const operation = {
    schemaVersion: 1, operationId: "operation", correlationId: "correlation", planId: "plan", idempotencyKey: "tbfix:key",
    taskId: "task", taskNo: "CARB-1", phase: "TRIAGE", state: "PARTIAL",
    steps: { comment: { state: "DONE", attempts: 1 }, status: { state: "UNKNOWN", attempts: 1 } },
    createdAt: "2026-08-23T00:00:00.000Z", updatedAt: "2026-08-23T00:01:00.000Z", safeToResume: true, nextAction: "retry status",
  };
  const planValidator = ajv.compile(load("tb-update-plan.schema.json"));
  const operationValidator = ajv.compile(load("tb-operation-record.schema.json"));
  assert.equal(planValidator(plan), true, JSON.stringify(planValidator.errors));
  assert.equal(operationValidator(operation), true, JSON.stringify(operationValidator.errors));
});

