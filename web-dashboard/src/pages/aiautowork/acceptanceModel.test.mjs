import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import { __resetAdminSessionForTests } from "../../services/adminAuth.js";
import api from "./api.js";
import {
  ACCEPTANCE_STATUS_CARDS,
  normalizeAcceptanceRun,
  normalizeAcceptanceRuns,
  statusTone,
} from "./acceptanceModel.mjs";

const originalFetch = globalThis.fetch;
const originalWindow = globalThis.window;
const originalLocalStorage = globalThis.localStorage;
const originalWebSocket = globalThis.WebSocket;

function storage(values = {}) {
  const entries = new Map(Object.entries(values));
  return {
    getItem: (key) => entries.get(key) || null,
    setItem: (key, value) => entries.set(key, String(value)),
    removeItem: (key) => entries.delete(key),
  };
}

afterEach(() => {
  __resetAdminSessionForTests();
  globalThis.fetch = originalFetch;
  globalThis.window = originalWindow;
  globalThis.localStorage = originalLocalStorage;
  globalThis.WebSocket = originalWebSocket;
});

test("DUAL_SCOPE keeps project, release, story and source-sync decisions orthogonal", () => {
  const run = normalizeAcceptanceRun({
    id: "acceptance-42",
    routing: {
      task_origin: "RUNTIME_STORY_POINT",
      scope_kind: "DUAL_SCOPE",
      protocols: ["project-engineering-acceptance", "runtime-story-point-assurance"],
      project_task_id: "PROJECT-42",
      story_point_id: "SP-42",
      source_refs: [{ system: "jira", issue_id: "CARB-42", snapshot_hash: "snapshot-42" }],
    },
    project: {
      project_change_decision: "ACCEPTED",
      production_readiness: "NOT_ASSESSED",
      candidate: { repository: "AIEfficiency", head_ref: "abc" },
      candidate_evidence_consistent: true,
    },
    story: {
      story_point_decision: "VERIFIED",
      source_sync_decision: "ALLOWED",
      source_sync_status: "FAILED",
      candidates: [{ repository: "target-app", head_ref: "def" }],
      candidate_evidence_consistent: true,
    },
  });

  assert.equal(run.isDualScope, true);
  assert.deepEqual(run.statuses, {
    projectChange: "ACCEPTED",
    productionReadiness: "NOT_ASSESSED",
    storyPoint: "VERIFIED",
    sourceSync: "FAILED",
  });
  assert.equal(run.sourceSyncDecision, "ALLOWED");
  assert.equal(run.route.storyPointId, "SP-42");
  assert.equal(run.route.sources[0].system, "jira");
  assert.deepEqual(ACCEPTANCE_STATUS_CARDS.map((card) => card.key), [
    "projectChange", "productionReadiness", "storyPoint", "sourceSync",
  ]);
});

test("missing evidence is visible as UNKNOWN and does not become a success state", () => {
  const run = normalizeAcceptanceRun({
    id: "incomplete",
    story: {
      claims: [{ type: "UNKNOWN", statement: "设备日志未读取" }],
      impact_matrix: { permission_security_privacy: { status: "UNKNOWN" } },
      blocking_findings: [{ code: "HARNESS_TIMEOUT", ownership: "HARNESS_DEFECT", blocking: true }],
    },
  });

  assert.equal(run.statuses.projectChange, "UNKNOWN");
  assert.equal(run.statuses.storyPoint, "UNKNOWN");
  assert.ok(run.unknowns.includes("设备日志未读取"));
  assert.ok(run.unknowns.some((item) => item.includes("permission_security_privacy")));
  assert.equal(run.blockingFindings[0].ownership, "HARNESS_DEFECT");
  assert.equal(run.consistency.overall, "UNKNOWN");
  assert.equal(statusTone(run.statuses.storyPoint), "unknown");
});

test("list payloads and candidate consistency preserve an explicit inconsistency", () => {
  const [run] = normalizeAcceptanceRuns({
    runs: [{
      run_id: "bad-evidence",
      candidate_evidence_consistency: { overall: false, reasons: ["evidence digest differs"] },
    }],
  });

  assert.equal(run.id, "bad-evidence");
  assert.equal(run.consistency.overall, "INCONSISTENT");
  assert.deepEqual(run.consistency.reasons, ["evidence digest differs"]);
  assert.equal(statusTone(run.consistency.overall), "danger");
});

test("flat backend runs select their protocol track and retain candidate consistency", () => {
  const project = normalizeAcceptanceRun({
    id: "project-flat",
    protocol: "PROJECT_ENGINEERING",
    projectChangeDecision: "ACCEPTED",
    productionReadiness: "NOT_READY",
    candidateEvidenceConsistent: true,
    candidateConsistencyReasons: ["same candidate and environment"],
    candidate: { candidates: [{ repository: "AIEfficiency", headRef: "project-head" }] },
    repairRounds: 1,
    gates: [
      { id: "P0_SCOPE", result: "PASS", evidenceIds: ["E-P0"] },
      { id: "P1_STATIC", result: "PENDING", evidenceIds: [] },
    ],
    routing: { scope_kind: "PROJECT_ENGINEERING" },
  });
  const story = normalizeAcceptanceRun({
    id: "story-flat",
    protocol: "RUNTIME_STORY_POINT",
    storyPointDecision: "VERIFIED",
    sourceSyncStatus: "FAILED",
    candidateConsistent: false,
    candidate: { candidates: [{ repository: "target-app", headRef: "story-head" }] },
    routing: { scope_kind: "DUAL_SCOPE" },
  });

  assert.equal(project.statuses.projectChange, "ACCEPTED");
  assert.equal(project.statuses.storyPoint, "UNKNOWN");
  assert.equal(project.candidates.project[0].repository, "AIEfficiency");
  assert.equal(project.consistency.project, "CONSISTENT");
  assert.deepEqual(project.consistency.reasons, ["same candidate and environment"]);
  assert.equal(project.diagnostics.project.repairRounds, 1);
  assert.equal(project.diagnostics.project.gatesWithEvidence, 1);
  assert.equal(project.diagnostics.project.gateTotal, 2);
  assert.deepEqual(project.diagnostics.project.evidenceIds, ["E-P0"]);
  assert.equal(story.statuses.storyPoint, "VERIFIED");
  assert.equal(story.statuses.sourceSync, "FAILED");
  assert.equal(story.statuses.projectChange, "UNKNOWN");
  assert.equal(story.candidates.story[0].repository, "target-app");
  assert.equal(story.consistency.story, "INCONSISTENT");
  assert.equal(story.isDualScope, true);
});

test("source supersession exposes invalidated gates and repair/evidence coverage", () => {
  const run = normalizeAcceptanceRun({
    id: "stale-story",
    protocol: "RUNTIME_STORY_POINT",
    repair_rounds: 2,
    candidate_consistency_reasons: ["SOURCE_SNAPSHOT_SUPERSEDED: old -> new"],
    gates: [
      { id: "S0_SOURCE_FACTS", result: "PENDING", evidence_ids: [] },
      { id: "S1_CANDIDATE", result: "PENDING", evidence_ids: [] },
    ],
    findings: [{
      id: "F-STORY",
      ownership: "STORY_DELIVERY",
      invalidated_gates: ["S2_CHANGE_TYPE_EVIDENCE"],
      evidence_ids: ["E-FINDING"],
    }],
    routing: { scope_kind: "STORY_DELIVERY" },
  });

  assert.equal(run.diagnostics.story.repairRounds, 2);
  assert.equal(run.diagnostics.story.gatesWithEvidence, 0);
  assert.deepEqual(run.diagnostics.story.invalidatedGates, [
    "S2_CHANGE_TYPE_EVIDENCE", "S0_SOURCE_FACTS", "S1_CANDIDATE",
  ]);
  assert.deepEqual(run.diagnostics.story.evidenceIds, ["E-FINDING"]);
});

test("matching trackGroupId rows render as one DUAL_SCOPE item with two independent tracks", () => {
  const [dual] = normalizeAcceptanceRuns({
    runs: [{
      id: "project-run",
      trackGroupId: "dual-group-1",
      protocol: "PROJECT_ENGINEERING",
      projectChangeDecision: "ACCEPTED",
      productionReadiness: "NOT_ASSESSED",
      candidateEvidenceConsistent: true,
      candidate: { candidates: [{ repository: "AIEfficiency", head_ref: "project-head" }] },
      routing: { project_task_id: "PROJECT-DUAL-1" },
    }, {
      id: "story-run",
      trackGroupId: "dual-group-1",
      protocol: "RUNTIME_STORY_POINT",
      storyPointDecision: "PARTIAL",
      sourceSyncStatus: "NOT_ATTEMPTED",
      candidateEvidenceConsistent: false,
      candidate: { candidates: [{ repository: "target-app", head_ref: "story-head" }] },
      routing: { project_task_id: "PROJECT-DUAL-1", story_point_id: "SP-DUAL-1" },
    }],
  });

  assert.equal(dual.id, "dual-group-1");
  assert.equal(dual.isDualScope, true);
  assert.equal(dual.statuses.projectChange, "ACCEPTED");
  assert.equal(dual.statuses.storyPoint, "PARTIAL");
  assert.equal(dual.candidates.project[0].repository, "AIEfficiency");
  assert.equal(dual.candidates.story[0].repository, "target-app");
  assert.equal(dual.consistency.project, "CONSISTENT");
  assert.equal(dual.consistency.story, "INCONSISTENT");
  assert.equal(dual.consistency.overall, "INCONSISTENT");
});

test("acceptance run GET explicitly sends the admin Principal without changing other GET calls", async () => {
  globalThis.window = {
    location: new URL("https://panel.example/aiautowork"),
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent() {},
  };
  globalThis.localStorage = storage({
    admin_token: "admin-token",
    admin_token_audience: "https://panel.example",
  });
  globalThis.WebSocket = undefined;
  const requests = [];
  globalThis.fetch = async (input, init = {}) => {
    requests.push({ input: String(input), init });
    return {
      ok: true,
      status: 200,
      json: async () => ({ ok: true, data: { runs: [] } }),
    };
  };

  await api.listAcceptanceRuns({ limit: 2 });
  await api.health();

  assert.match(requests[0].input, /\/api\/aiautowork\/acceptance\/runs\?limit=2$/);
  assert.equal(new Headers(requests[0].init.headers).get("Authorization"), "Bearer admin-token");
  assert.equal(new Headers(requests[1].init.headers).get("Authorization"), null);
});
