import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  controllerErrorStatus,
} from "../services/devbench/git-controller-http.js";

test("Controller HTTP maps exact concurrency conflicts to 409 without hiding server failures", () => {
  for (const code of [
    "GIT_CONTROLLER_ACCEPTED_CAS_FAILED",
    "GIT_CONTROLLER_IDEMPOTENCY_CONFLICT",
    "GIT_CONTROLLER_REMOTE_HISTORY_ADMIN_APPROVAL_REQUIRED",
    "GIT_CONTROLLER_REMOTE_HISTORY_ADMIN_REVIEW_REQUIRED",
    "GIT_CONTROLLER_REMOTE_HISTORY_IMPACT_UNKNOWN",
    "GIT_CONTROLLER_REMOTE_CHANGED",
    "STORY_BASELINE_RESTRICTED_EXECUTOR_REQUIRED",
    "STORY_REPOSITORY_EXACT_SHA_CONFLICT",
  ]) {
    assert.equal(controllerErrorStatus({ code }), 409, code);
  }
  assert.equal(controllerErrorStatus({ code: "GIT_CONTROLLER_DATABASE_FAILED" }), 500);
  assert.equal(controllerErrorStatus({ code: "GIT_CONTROLLER_INTERNAL_CONFLICT" }), 500);
});

test("Controller HTTP maps only explicit caller parameter failures to 400", () => {
  for (const code of [
    "GIT_CONTROLLER_BRANCH_REQUIRED",
    "GIT_CONTROLLER_COMMAND_FIELD_INVALID",
    "GIT_CONTROLLER_IDEMPOTENCY_KEY_REQUIRED",
    "GIT_CONTROLLER_IDEMPOTENCY_MISMATCH",
    "GIT_CONTROLLER_INVALID_BRANCH",
    "GIT_CONTROLLER_INVALID_SHA",
    "GIT_CONTROLLER_REQUEST_FIELDS_REJECTED",
    "STORY_BASELINE_STRATEGY_REJECTED",
  ]) {
    assert.equal(controllerErrorStatus({ code }), 400, code);
  }

  // These similarly named failures describe Controller configuration or
  // persisted state, not malformed HTTP input.
  assert.equal(controllerErrorStatus({ code: "GIT_CONTROLLER_DAEMON_CONFIG_INVALID" }), 500);
  assert.equal(controllerErrorStatus({ code: "GIT_CONTROLLER_REPOSITORY_INVALID" }), 500);
});

test("Controller HTTP reserves 404 for missing registry resources", () => {
  assert.equal(
    controllerErrorStatus({ code: "GIT_CONTROLLER_REPOSITORY_NOT_REGISTERED" }),
    404,
  );
  assert.equal(
    controllerErrorStatus({ code: "GIT_CONTROLLER_EXECUTABLE_NOT_FOUND" }),
    500,
  );
});

test("Controller HTTP maps operation drift to 409", () => {
  for (const code of [
    "GIT_CONTROLLER_BASE_CONFIG_DRIFT",
    "GIT_CONTROLLER_PREVIEW_STALE",
    "GIT_CONTROLLER_EXPECTED_HEAD_CHANGED",
    "GIT_CONTROLLER_OPERATION_IN_PROGRESS",
    "GIT_CONTROLLER_BASE_CONFIG_RACE",
  ]) {
    assert.equal(controllerErrorStatus({ code }), 409, code);
  }
});

test("Controller trust and integrity failures remain server-side", () => {
  for (const code of [
    "GIT_CONTROLLER_ATTESTATION_MISMATCH",
    "GIT_CONTROLLER_RESPONSE_SIGNATURE_INVALID",
    "GIT_CONTROLLER_RESPONSE_UNSIGNED",
  ]) {
    assert.equal(controllerErrorStatus({ code }), 502, code);
  }
  for (const code of [
    "GIT_CONTROLLER_FETCHED_SHA_MISMATCH",
    "GIT_CONTROLLER_HOOKS_MANIFEST_MISMATCH",
    "GIT_CONTROLLER_MIRROR_STATE_CORRUPT",
    "GIT_CONTROLLER_OBJECT_FORMAT_MISMATCH",
  ]) {
    assert.equal(controllerErrorStatus({ code }), 500, code);
  }
});

test("story baseline execute route uses the same explicit write gate as other Controller writes", () => {
  const source = fs.readFileSync(new URL("../routes/devbench.js", import.meta.url), "utf8");
  const start = source.indexOf('router.post("/tabs/:id/story-baseline/refresh"');
  const end = source.indexOf("\nrouter.", start + 1);
  assert.ok(start >= 0 && end > start);
  const route = source.slice(start, end);
  assert.match(route, /controllerPrincipal\(req,\s*\{\s*write:\s*true\s*\}\)/);
  assert.doesNotMatch(route, /controllerPrincipal\(req\)(?:;|\s)/);
});

test("Gateway repository status never probes the Controller-only mirror path", () => {
  const source = fs.readFileSync(new URL("../routes/devbench.js", import.meta.url), "utf8");
  for (const [startMarker, endMarker] of [
    [
      'router.get("/repositories/:repositoryId/protection"',
      'router.get("/repositories/:repositoryId/sync-status"',
    ],
    [
      'router.get("/repositories/:repositoryId/sync-status"',
      'router.post("/repositories/:repositoryId/remote-refresh/preview"',
    ],
  ]) {
    const start = source.indexOf(startMarker);
    const end = source.indexOf(endMarker, start + 1);
    assert.ok(start >= 0 && end > start, startMarker);
    const route = source.slice(start, end);
    assert.doesNotMatch(route, /existsSync\s*\(\s*entry\.mirrorPath\s*\)/);
    assert.match(route, /controllerStatus|state\.mirrorStatus/);
  }
});

test("remote rewrite execute route forwards the approved impact digest to the Controller", () => {
  const source = fs.readFileSync(new URL("../routes/devbench.js", import.meta.url), "utf8");
  const start = source.indexOf(
    'router.post("/repositories/:repositoryId/remote-refresh/execute"',
  );
  const end = source.indexOf("\nrouter.", start + 1);
  assert.ok(start >= 0 && end > start);
  const route = source.slice(start, end);

  assert.match(route, /"adminApprovedImpactDigest"/);
  assert.match(
    route,
    /adminApprovedImpactDigest:\s*body\.adminApprovedImpactDigest\s*\|\|\s*""/,
  );
});
