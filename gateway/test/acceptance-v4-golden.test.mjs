import test from "node:test";
import assert from "node:assert/strict";

import {
  buildGatePlan,
  emptyImpactMatrix,
  evaluateProjectAcceptance,
  evaluateStoryAcceptance,
  normalizeCanonicalStoryPoint,
  routeAcceptance,
} from "../services/acceptance/core.js";

function passGates(protocol, modeOrTier, changeType) {
  const plan = protocol === "PROJECT_ENGINEERING"
    ? buildGatePlan({ protocol, mode: modeOrTier, changeType })
    : buildGatePlan({ protocol, riskTier: modeOrTier, changeType });
  return plan.map((gate) => ({ id: gate.id, result: "PASS", evidence_ids: [`golden-${gate.id}`] }));
}

function passImpact() {
  return Object.fromEntries(Object.keys(emptyImpactMatrix()).map((dimension) => [
    dimension,
    { status: "PASS", basis: `golden evidence for ${dimension}` },
  ]));
}

function verifiedStory(overrides = {}) {
  return evaluateStoryAcceptance({
    change_type: "FEATURE",
    risk_tier: "STORY-STANDARD",
    gates: passGates("RUNTIME_STORY_POINT", "STORY-STANDARD", "FEATURE"),
    claims: [{ type: "FACT", statement: "golden oracle matched", evidence_ids: ["golden-oracle"] }],
    impact_matrix: passImpact(),
    candidate_consistent: true,
    ...overrides,
  });
}

test("golden 01: direct engineering feature routes to PROJECT-STANDARD", () => {
  const route = routeAcceptance({
    project_task_id: "GOLDEN-PROJECT-FEATURE",
    direct_project_task: true,
    change_type: "FEATURE",
    project_paths: ["web-dashboard"],
    target_repositories: ["AIEfficiency"],
  });
  assert.equal(route.task_origin, "DIRECT_ENGINEERING");
  assert.equal(route.scope_kind, "PROJECT_ENGINEERING");
  assert.equal(route.risk_tier, "PROJECT-STANDARD");
});

test("golden 02: direct engineering defect keeps defect-specific evidence requirements", () => {
  const gate = buildGatePlan({
    protocol: "PROJECT_ENGINEERING",
    mode: "PROJECT-STANDARD",
    changeType: "DEFECT_FIX",
  }).find((item) => item.id === "P3_INTEGRATION_CONTRACT");
  assert.ok(gate.evidenceRequirements.includes("baseline_red_candidate_green"));
  assert.ok(gate.evidenceRequirements.includes("root_cause_and_competing_hypotheses"));
});

test("golden 03: production READY is available only in PROJECT-RELEASE", () => {
  const standard = evaluateProjectAcceptance({
    mode: "PROJECT-STANDARD",
    change_type: "PACKAGE_OR_RELEASE",
    gates: passGates("PROJECT_ENGINEERING", "PROJECT-STANDARD", "PACKAGE_OR_RELEASE"),
  });
  const release = evaluateProjectAcceptance({
    mode: "PROJECT-RELEASE",
    change_type: "PACKAGE_OR_RELEASE",
    gates: passGates("PROJECT_ENGINEERING", "PROJECT-RELEASE", "PACKAGE_OR_RELEASE"),
  });
  assert.equal(standard.project_change_decision, "ACCEPTED");
  assert.equal(standard.production_readiness, "NOT_ASSESSED");
  assert.equal(release.production_readiness, "READY");
});

test("golden 04: Feishu JIRA and Teambition select the same story protocol", () => {
  const base = {
    story_point_id: "GOLDEN-SP-SOURCE",
    source_snapshot_hash: "immutable-source",
    story_target_changed: true,
    target_repositories: ["TargetApp"],
    change_type: "FEATURE",
  };
  const routes = ["feishu", "jira", "teambition"].map((system) => routeAcceptance({
    ...base,
    source_refs: [{ system, issue_id: `${system}-1` }],
  }));
  assert.deepEqual([...new Set(routes.map((route) => route.scope_kind))], ["STORY_DELIVERY"]);
  assert.deepEqual([...new Set(routes.map((route) => route.protocols.join(",")))], ["runtime-story-point-assurance"]);
});

test("golden 05: multi-repository public SDK and multi-flavor story is CRITICAL", () => {
  const route = routeAcceptance({
    story_point_id: "GOLDEN-SP-CRITICAL",
    source_snapshot_hash: "immutable-source-critical",
    story_target_changed: true,
    target_repositories: ["SdkFactory", "TargetApp"],
    risk_tags: ["public_sdk", "multiple_flavors_or_consumers_with_unknown_compatibility"],
  });
  assert.equal(route.risk_tier, "STORY-CRITICAL");
  assert.ok(buildGatePlan({
    protocol: "RUNTIME_STORY_POINT",
    riskTier: route.risk_tier,
  }).some((gate) => gate.id === "S7_CRITICAL_RERUN_ROLLBACK"));
});

test("golden 06: HARNESS_DEFECT blocks the story without becoming a target-code fix", () => {
  const result = verifiedStory({
    change_type: "TEST_OR_HARNESS",
    gates: passGates("RUNTIME_STORY_POINT", "STORY-STANDARD", "TEST_OR_HARNESS"),
    findings: [{ ownership: "HARNESS_DEFECT", severity: "P1", blocking: true }],
  });
  assert.equal(result.story_point_decision, "BLOCKED");
  assert.equal(result.blocking_findings[0].ownership, "HARNESS_DEFECT");
});

test("golden 07: source connector failure stays orthogonal to technical verification", () => {
  const result = verifiedStory({ source_sync_status: "FAILED" });
  assert.equal(result.story_point_decision, "VERIFIED");
  assert.equal(result.source_sync_decision, "ALLOWED");
  assert.equal(result.source_sync_status, "FAILED");
});

test("golden 08: platform and target changes produce DUAL_SCOPE with two protocols", () => {
  const route = routeAcceptance({
    story_point_id: "GOLDEN-SP-DUAL",
    project_task_id: "GOLDEN-PROJECT-DUAL",
    source_snapshot_hash: "immutable-source-dual",
    project_paths: ["gateway/services/acceptance"],
    story_target_paths: ["target-app"],
    target_repositories: ["AIEfficiency", "TargetApp"],
  });
  assert.equal(route.scope_kind, "DUAL_SCOPE");
  assert.deepEqual(new Set(route.protocols), new Set([
    "runtime-story-point-assurance",
    "project-engineering-acceptance",
  ]));
});

test("golden 09: source facts changing during acceptance create a new immutable hash", () => {
  const base = {
    story_point_id: "GOLDEN-SP-SNAPSHOT",
    title: "Source changes",
    sources: [{
      system: "teambition",
      issue_id: "TB-GOLDEN-9",
      fetched_at: "2026-08-10T00:00:00.000Z",
      raw_snapshot: { revision: 1 },
    }],
    target_repositories: ["TargetApp"],
  };
  const first = normalizeCanonicalStoryPoint(base);
  const changed = normalizeCanonicalStoryPoint({
    ...base,
    sources: [{
      ...base.sources[0],
      fetched_at: "2026-08-10T00:05:00.000Z",
      raw_snapshot: { revision: 2 },
    }],
  });
  assert.notEqual(first.source_snapshot_hash, changed.source_snapshot_hash);
});

test("golden 10: missing gate and impact evidence must remain PARTIAL", () => {
  const result = evaluateStoryAcceptance({
    change_type: "FEATURE",
    risk_tier: "STORY-STANDARD",
    gates: [{ id: "S0_SOURCE_FACTS", result: "PASS", evidence_ids: [] }],
    claims: [{ type: "FACT", statement: "unsupported claim", evidence_ids: [] }],
    impact_matrix: {},
    candidate_consistent: true,
  });
  assert.equal(result.story_point_decision, "PARTIAL");
  assert.ok(result.gates.some((gate) => gate.result === "PENDING"));
  assert.ok(result.claims.some((claim) => claim.type === "UNKNOWN"));
});
