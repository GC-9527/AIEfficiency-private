import test from "node:test";
import assert from "node:assert/strict";
import {
  buildGatePlan,
  classifyStoryRisk,
  emptyImpactMatrix,
  evidenceRequirementsForChangeType,
  evaluateProjectAcceptance,
  evaluateStoryAcceptance,
  mapLegacyAcceptance,
  normalizeCanonicalStoryPoint,
  normalizeImpactMatrix,
  planGateInvalidation,
  routeAcceptance,
} from "../services/acceptance/core.js";

function passingGates(protocol, modeOrTier, changeType = "FEATURE") {
  const plan = protocol === "PROJECT_ENGINEERING"
    ? buildGatePlan({ protocol, mode: modeOrTier, changeType })
    : buildGatePlan({ protocol, riskTier: modeOrTier, changeType });
  return plan.map((gate) => ({ id: gate.id, result: "PASS", evidence_ids: [`E-${gate.id}`] }));
}

function passingImpact() {
  return Object.fromEntries(Object.keys(emptyImpactMatrix()).map((key) => [key, {
    status: "PASS",
    basis: `golden:${key}`,
  }]));
}

test("golden route: direct engineering, runtime story, dual scope, and blocked external issue", () => {
  const direct = routeAcceptance({
    project_task_id: "PROJECT-1",
    direct_project_task: true,
    project_paths: ["gateway"],
    target_repositories: ["AIEfficiency"],
    change_type: "FEATURE",
  });
  assert.equal(direct.task_origin, "DIRECT_ENGINEERING");
  assert.equal(direct.scope_kind, "PROJECT_ENGINEERING");
  assert.deepEqual(direct.protocols, ["project-engineering-acceptance"]);
  assert.equal(direct.risk_tier, "PROJECT-STANDARD");

  const story = routeAcceptance({
    story_point_id: "SP-1",
    source_snapshot_hash: "source-1",
    story_target_paths: ["app/src"],
    target_repositories: ["AndroidApp"],
    change_type: "DEFECT_FIX",
  });
  assert.equal(story.task_origin, "RUNTIME_STORY_POINT");
  assert.equal(story.scope_kind, "STORY_DELIVERY");
  assert.deepEqual(story.protocols, ["runtime-story-point-assurance"]);

  const dual = routeAcceptance({
    story_point_id: "SP-2",
    source_snapshot_hash: "source-2",
    project_paths: ["gateway/services/acceptance"],
    story_target_paths: ["target-app"],
    target_repositories: ["AIEfficiency", "TargetApp"],
  });
  assert.equal(dual.scope_kind, "DUAL_SCOPE");
  assert.equal(dual.protocols.length, 2);

  const platformTarget = routeAcceptance({
    story_point_id: "SP-3",
    source_snapshot_hash: "source-3",
    story_target_kind: "platform_project",
    target_repositories: ["AIEfficiency"],
  });
  assert.equal(platformTarget.scope_kind, "DUAL_SCOPE");

  const externalOnly = routeAcceptance({
    direct_project_task: false,
    external_issue_ref: "https://jira.invalid/DEMO-1",
    source_refs: [{ system: "jira", issue_id: "DEMO-1" }],
    target_repositories: ["TargetApp"],
  });
  assert.equal(externalOnly.route_status, "BLOCKED_ROUTING");
  assert.equal(externalOnly.required_action, "normalize_to_internal_story_point");
  assert.deepEqual(externalOnly.protocols, []);
});

test("golden route: source system cannot change technical route or risk", () => {
  const base = {
    story_point_id: "SP-SOURCE-INDEPENDENT",
    source_snapshot_hash: "snapshot",
    story_target_paths: ["sdk-api"],
    target_repositories: ["SdkFactory"],
    change_type: "FEATURE",
    risk_tags: ["public_sdk"],
  };
  const feishu = routeAcceptance({ ...base, source_refs: [{ system: "feishu", issue_id: "F-1" }] });
  const jira = routeAcceptance({ ...base, source_refs: [{ system: "jira", issue_id: "J-1" }] });
  assert.equal(feishu.scope_kind, jira.scope_kind);
  assert.equal(feishu.risk_tier, "STORY-CRITICAL");
  assert.equal(jira.risk_tier, "STORY-CRITICAL");
  assert.deepEqual(feishu.protocols, jira.protocols);
  assert.equal(classifyStoryRisk({ risk_tags: ["public_sdk"] }).tier, "STORY-CRITICAL");
});

test("Canonical StoryPoint snapshots are deterministic, immutable inputs are hash-bound", () => {
  const input = {
    story_point_id: "SP-NORMALIZED",
    title: "Fix retry",
    change_type: "DEFECT_FIX",
    sources: [{
      system: "jira",
      issue_id: "DEMO-9",
      fetched_at: "2026-08-10T00:00:00.000Z",
      mapping_version: "1",
      raw_snapshot: { title: "Fix retry", revision: 1 },
    }],
    acceptance_criteria: ["retry once"],
    target_repositories: ["Gateway"],
  };
  const first = normalizeCanonicalStoryPoint(input);
  const second = normalizeCanonicalStoryPoint(input);
  const changed = normalizeCanonicalStoryPoint({ ...input, acceptance_criteria: ["retry at most once"] });
  const sourceMaterialChanged = normalizeCanonicalStoryPoint({
    ...input,
    source_materials: { read: ["description"], unread: ["attachment:a.log"] },
  });
  assert.equal(first.source_snapshot_hash, second.source_snapshot_hash);
  assert.notEqual(first.source_snapshot_hash, changed.source_snapshot_hash);
  assert.notEqual(first.source_snapshot_hash, sourceMaterialChanged.source_snapshot_hash);
  assert.equal(first.sources[0].snapshot_hash, second.sources[0].snapshot_hash);
  assert.throws(() => normalizeCanonicalStoryPoint({
    ...input,
    sources: [{ ...input.sources[0], fetched_at: undefined }],
  }), /fetched_at is required/, "wall clock time must never be injected into a canonical source hash");
});

test("change type selects explicit evidence requirements inside the chosen protocol", () => {
  const defect = evidenceRequirementsForChangeType("DEFECT_FIX");
  const feature = evidenceRequirementsForChangeType("FEATURE");
  assert.ok(defect.includes("baseline_red_candidate_green"));
  assert.ok(!feature.includes("baseline_red_candidate_green"));

  const storyGate = buildGatePlan({
    protocol: "RUNTIME_STORY_POINT",
    riskTier: "STORY-STANDARD",
    changeType: "DEFECT_FIX",
  }).find((gate) => gate.id === "S2_CHANGE_TYPE_EVIDENCE");
  const projectGate = buildGatePlan({
    protocol: "PROJECT_ENGINEERING",
    mode: "PROJECT-STANDARD",
    changeType: "REFACTOR",
  }).find((gate) => gate.id === "P3_INTEGRATION_CONTRACT");
  assert.deepEqual(storyGate.evidenceRequirements, defect);
  assert.ok(projectGate.evidenceRequirements.includes("observable_behavior_parity"));

  for (const riskTier of ["STORY-FAST", "STORY-STANDARD", "STORY-CRITICAL"]) {
    const plan = buildGatePlan({ protocol: "RUNTIME_STORY_POINT", riskTier, changeType: "FEATURE" });
    const ids = new Set(plan.map((gate) => gate.id));
    assert.ok(plan.every((gate) => gate.dependsOn.every((dependency) => ids.has(dependency))), `${riskTier} gate DAG must be closed`);
  }
});

test("project decisions separate change acceptance from production readiness", () => {
  const standard = evaluateProjectAcceptance({
    mode: "PROJECT-STANDARD",
    change_type: "FEATURE",
    gates: passingGates("PROJECT_ENGINEERING", "PROJECT-STANDARD"),
  });
  assert.equal(standard.project_change_decision, "ACCEPTED");
  assert.equal(standard.production_readiness, "NOT_ASSESSED");

  const release = evaluateProjectAcceptance({
    mode: "PROJECT-RELEASE",
    change_type: "PACKAGE_OR_RELEASE",
    gates: passingGates("PROJECT_ENGINEERING", "PROJECT-RELEASE", "PACKAGE_OR_RELEASE"),
  });
  assert.equal(release.project_change_decision, "ACCEPTED");
  assert.equal(release.production_readiness, "READY");

  const quick = evaluateProjectAcceptance({
    mode: "PROJECT-QUICK",
    gates: passingGates("PROJECT_ENGINEERING", "PROJECT-QUICK"),
  });
  assert.equal(quick.project_change_decision, "NOT_ASSESSED");
  assert.equal(quick.production_readiness, "NOT_ASSESSED");
});

test("story technical decision remains VERIFIED when source sync fails", () => {
  const result = evaluateStoryAcceptance({
    story_point_id: "SP-SYNC",
    change_type: "FEATURE",
    risk_tier: "STORY-STANDARD",
    gates: passingGates("RUNTIME_STORY_POINT", "STORY-STANDARD"),
    claims: [{ type: "FACT", statement: "contract response matched", evidence_ids: ["E-CONTRACT"] }],
    impact_matrix: passingImpact(),
    candidate_consistent: true,
    source_sync_status: "FAILED",
  });
  assert.equal(result.story_point_decision, "VERIFIED");
  assert.equal(result.source_sync_decision, "ALLOWED");
  assert.equal(result.source_sync_status, "FAILED");
});

test("story evidence gaps, harness defects, and unknown impact cannot silently verify", () => {
  const unsupportedNotApplicable = normalizeImpactMatrix({
    permission_security_privacy: { status: "NOT_APPLICABLE", basis: "" },
  });
  assert.equal(unsupportedNotApplicable.permission_security_privacy.status, "UNKNOWN");

  const noClaims = evaluateStoryAcceptance({
    change_type: "FEATURE",
    risk_tier: "STORY-STANDARD",
    gates: passingGates("RUNTIME_STORY_POINT", "STORY-STANDARD"),
    claims: [],
    impact_matrix: passingImpact(),
    candidate_consistent: true,
  });
  assert.equal(noClaims.story_point_decision, "PARTIAL");
  assert.equal(noClaims.claims[0].type, "UNKNOWN");

  const unsupportedInference = evaluateStoryAcceptance({
    change_type: "FEATURE",
    risk_tier: "STORY-STANDARD",
    gates: passingGates("RUNTIME_STORY_POINT", "STORY-STANDARD"),
    claims: [{ type: "INFERENCE", statement: "model thinks this is correct", evidence_ids: [] }],
    impact_matrix: passingImpact(),
    candidate_consistent: true,
  });
  assert.equal(unsupportedInference.story_point_decision, "PARTIAL");
  assert.equal(unsupportedInference.claims[0].type, "UNKNOWN");

  const partial = evaluateStoryAcceptance({
    change_type: "FEATURE",
    risk_tier: "STORY-STANDARD",
    gates: passingGates("RUNTIME_STORY_POINT", "STORY-STANDARD"),
    claims: [{ type: "FACT", statement: "direct path passed", evidence_ids: ["E-1"] }],
    impact_matrix: { ...passingImpact(), permission_security_privacy: { status: "UNKNOWN", basis: "not checked" } },
    candidate_consistent: true,
  });
  assert.equal(partial.story_point_decision, "PARTIAL");
  assert.equal(partial.source_sync_decision, "MANUAL_APPROVAL");

  const blocked = evaluateStoryAcceptance({
    change_type: "TEST_OR_HARNESS",
    risk_tier: "STORY-STANDARD",
    gates: passingGates("RUNTIME_STORY_POINT", "STORY-STANDARD", "TEST_OR_HARNESS"),
    claims: [{ type: "FACT", statement: "AppMock selected wrong target", evidence_ids: ["E-H"] }],
    impact_matrix: passingImpact(),
    findings: [{ ownership: "HARNESS_DEFECT", blocking: true, severity: "P1" }],
  });
  assert.equal(blocked.story_point_decision, "BLOCKED");
  assert.equal(blocked.source_sync_decision, "DENIED");
});

test("precise invalidation reuses gates whose declared inputs did not change", () => {
  const plan = buildGatePlan({ protocol: "RUNTIME_STORY_POINT", riskTier: "STORY-STANDARD", changeType: "FEATURE" });
  const before = {
    protocol: "4.1",
    source: "source-1",
    candidate: "candidate-1",
    dependency: "dep-1",
    config: "config-1",
    artifact: "artifact-1",
    environment: "env-1",
    impact: "impact-1",
    reviewer: "reviewer-v1",
    changeType: "FEATURE",
  };
  const after = { ...before, source: "source-2" };
  const result = planGateInvalidation(plan, before, after);
  const invalidated = result.invalidated.map((item) => item.gate_id);
  const reusable = result.reusable.map((item) => item.gate_id);
  assert.ok(invalidated.includes("S0_SOURCE_FACTS"));
  assert.ok(invalidated.includes("S5_RUNTIME_SMOKE"));
  assert.ok(reusable.includes("S4_TARGET_BUILD"), "source-only change must not invalidate target build");
});

test("legacy PASS without an authoritative object kind is conservatively mapped", () => {
  const ambiguous = mapLegacyAcceptance({ acceptance_status: "PASS" });
  assert.equal(ambiguous.project_change_decision, "PARTIAL");
  assert.equal(ambiguous.story_point_decision, "PARTIAL");
  assert.equal(ambiguous.production_readiness, "NOT_ASSESSED");

  const project = mapLegacyAcceptance({ acceptance_status: "PASS", object_kind: "PROJECT" });
  assert.equal(project.project_change_decision, "ACCEPTED");
  assert.equal(project.production_readiness, "NOT_ASSESSED");
});
