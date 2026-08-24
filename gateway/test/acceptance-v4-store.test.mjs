import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildGatePlan, emptyImpactMatrix, sha256 } from "../services/acceptance/core.js";

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "aieff-acceptance-v4-"));
process.env.GATEWAY_DB_PATH = path.join(tempRoot, "acceptance.db");

const service = await import(`../services/acceptance/service.js?acceptance-v4=${Date.now()}`);
const acceptanceStore = await import("../services/acceptance/store.js");
const { default: db } = await import("../db/sqlite.js");

after(() => {
  try { db.close(); } catch {}
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

function passGates(protocol, modeOrTier, changeType = "FEATURE") {
  const plan = protocol === "PROJECT_ENGINEERING"
    ? buildGatePlan({ protocol, mode: modeOrTier, changeType })
    : buildGatePlan({ protocol, riskTier: modeOrTier, changeType });
  return plan.map((gate) => ({ id: gate.id, result: "PASS", evidence_ids: [`E-${gate.id}`] }));
}

function passImpact() {
  return Object.fromEntries(Object.keys(emptyImpactMatrix()).map((key) => [key, { status: "PASS", basis: `oracle:${key}` }]));
}

function evidenceBinding(run) {
  return {
    candidateIdentityHash: run.candidateIdentityHash,
    sourceSnapshotHash: run.sourceSnapshotHash,
    environmentId: run.environmentId,
  };
}

function addTrustedGateEvidence(run, protocol, modeOrTier, changeType = "FEATURE") {
  const plan = protocol === "PROJECT_ENGINEERING"
    ? buildGatePlan({ protocol, mode: modeOrTier, changeType })
    : buildGatePlan({ protocol, riskTier: modeOrTier, changeType });
  return plan.map((gate) => {
    const evidence = acceptanceStore.addAcceptanceEvidence(run.id, {
      ...evidenceBinding(run),
      gateId: gate.id,
      kind: "command",
      command: `golden-runner --gate ${gate.id}`,
      exitCode: 0,
      sha256: `sha-${gate.id}`,
      trustLevel: "MECHANICAL",
      producer: "test-golden-runner",
      metadata: { requirementsCovered: gate.evidenceRequirements || [] },
    });
    return { id: gate.id, result: "PASS", evidence_ids: [evidence.id] };
  });
}

const canonicalInput = {
  story_point_id: "SP-INTEGRATION-1",
  title: "Acceptance v4 integration",
  description: "Verify immutable normalization and split decisions",
  change_type: "FEATURE",
  sources: [{
    system: "feishu",
    issue_id: "FS-100",
    fetched_at: "2026-08-10T00:00:00.000Z",
    mapping_version: "feishu-v1",
    raw_snapshot: { title: "Acceptance v4 integration", revision: 1 },
  }],
  acceptance_criteria: ["show four independent decisions"],
  must_change: ["route by acceptance object"],
  must_preserve: ["source system does not select technical gates"],
  target_repositories: ["AIEfficiency"],
  runtime_context: { environment_id: "test-loopback" },
};

test("immutable source snapshots are idempotent and new facts supersede without overwrite", () => {
  assert.throws(() => acceptanceStore.saveSourceSnapshot({
    story_point_id: "SP-MISSING-FETCHED-AT",
    source_snapshot_hash: "synthetic-hash",
    sources: [{ mapping_version: "1" }],
  }), /fetched_at is required/, "the store must not inject wall clock time into a snapshot");

  const first = service.normalizeStoryPoint(canonicalInput);
  const repeated = service.normalizeStoryPoint(canonicalInput);
  assert.equal(first.idempotent, false);
  assert.equal(repeated.idempotent, true);
  assert.equal(first.snapshot.id, repeated.snapshot.id);
  assert.equal(first.route.task_origin, "RUNTIME_STORY_POINT");
  assert.equal(first.route.scope_kind, "STORY_DELIVERY");

  const changed = service.normalizeStoryPoint({
    ...canonicalInput,
    acceptance_criteria: [...canonicalInput.acceptance_criteria, "source sync is independent"],
  });
  assert.notEqual(changed.snapshot.snapshotHash, first.snapshot.snapshotHash);
  const oldRow = acceptanceStore.getSourceSnapshot(first.snapshot.id);
  assert.equal(oldRow.supersededBy, changed.snapshot.id);
  assert.deepEqual(oldRow.canonical.acceptance_criteria, canonicalInput.acceptance_criteria, "old payload must stay immutable");
});

test("latest source snapshot is the unsuperseded chain tail, not a random id tie-break", () => {
  const storyPointId = "SP-SAME-TIMESTAMP";
  const createdAt = "2026-08-10T00:00:00.000Z";
  db.prepare(`
    INSERT INTO story_source_snapshots (
      id, story_point_id, snapshot_hash, mapping_version, canonical_json,
      fetched_at, superseded_by, created_at
    ) VALUES (?, ?, ?, '1', '{}', ?, ?, ?)
  `).run("asp_z_old_random_order", storyPointId, "old-hash", createdAt, "asp_a_new_chain_tail", createdAt);
  db.prepare(`
    INSERT INTO story_source_snapshots (
      id, story_point_id, snapshot_hash, mapping_version, canonical_json,
      fetched_at, superseded_by, created_at
    ) VALUES (?, ?, ?, '1', '{}', ?, NULL, ?)
  `).run("asp_a_new_chain_tail", storyPointId, "new-hash", createdAt, createdAt);

  const latest = acceptanceStore.getLatestSourceSnapshot(storyPointId);
  assert.equal(latest.id, "asp_a_new_chain_tail");
  assert.equal(latest.snapshotHash, "new-hash");
});

test("story run binds evidence to candidate/source/environment and sync failure stays orthogonal", () => {
  const latest = acceptanceStore.getLatestSourceSnapshot(canonicalInput.story_point_id);
  const run = service.createStoryRun({
    story_point_id: canonicalInput.story_point_id,
    risk_tier: "STORY-STANDARD",
    candidate: {
      repository: "AIEfficiency",
      base_ref: "base",
      head_ref: "head",
      diff_hash: "diff",
      dependency_hash: "dep",
      config_hash: "config",
      environment_id: "test-loopback",
      artifact_hash: "artifact",
    },
    gates: passGates("RUNTIME_STORY_POINT", "STORY-STANDARD"),
    claims: [{ type: "FACT", statement: "golden response matched", evidence_ids: ["E-GOLDEN"] }],
    impact_matrix: passImpact(),
    candidate_consistent: true,
  });
  assert.equal(run.storyPointDecision, "PARTIAL", "a request body must not be able to self-prove VERIFIED");
  assert.equal(run.sourceSnapshotHash, latest.snapshotHash);
  assert.equal(run.environmentId, "test-loopback");

  assert.throws(() => service.addEvidence(run.id, {
    kind: "command",
    candidateIdentityHash: "wrong-candidate",
    sourceSnapshotHash: run.sourceSnapshotHash,
    environmentId: run.environmentId,
  }), /candidate identity/);

  const evidence = service.addEvidence(run.id, {
    gateId: "S5_RUNTIME_SMOKE",
    kind: "command",
    candidateIdentityHash: run.candidateIdentityHash,
    sourceSnapshotHash: run.sourceSnapshotHash,
    environmentId: run.environmentId,
    command: "node --test test/acceptance-v4.test.mjs",
    exitCode: 0,
    sha256: "evidence-sha",
  });
  assert.equal(evidence.runId, run.id);
  assert.equal(evidence.trustLevel, "UNVERIFIED", "public evidence intake must not grant itself authority");

  const forged = service.resumeRun(run.id, {
    gates: [{ id: "S5_RUNTIME_SMOKE", result: "PASS", evidence_ids: [evidence.id] }],
  });
  assert.equal(forged.storyPointDecision, "PARTIAL");
  assert.ok(forged.gates.some((gate) => gate.id === "S5_RUNTIME_SMOKE" && gate.result === "PENDING"));

  const gates = addTrustedGateEvidence(run, "RUNTIME_STORY_POINT", "STORY-STANDARD");
  const claimEvidence = acceptanceStore.addAcceptanceEvidence(run.id, {
    ...evidenceBinding(run),
    kind: "attestation",
    uri: "evidence://golden/claim",
    sha256: "sha-golden-claim",
    trustLevel: "ATTESTED",
    producer: "test-independent-reviewer",
    metadata: { claims: { "C-001": sha256("golden response matched") } },
  });
  const impactDimensions = Object.keys(emptyImpactMatrix());
  const impactEvidence = acceptanceStore.addAcceptanceEvidence(run.id, {
    ...evidenceBinding(run),
    kind: "attestation",
    uri: "evidence://golden/impact",
    sha256: "sha-golden-impact",
    trustLevel: "ATTESTED",
    producer: "test-independent-reviewer",
    metadata: { impactResults: Object.fromEntries(impactDimensions.map((dimension) => [dimension, "PASS"])) },
  });
  const impactEvidenceMap = Object.fromEntries(impactDimensions.map((dimension) => [dimension, [impactEvidence.id]]));
  const tamperedClaim = service.resumeRun(run.id, {
    gates,
    claims: [{ id: "C-001", type: "FACT", statement: "different unsupported statement", evidence_ids: [claimEvidence.id] }],
    impact_matrix: passImpact(),
    impact_evidence: impactEvidenceMap,
  });
  assert.equal(tamperedClaim.storyPointDecision, "PARTIAL");
  assert.equal(tamperedClaim.claims[0].type, "UNKNOWN");

  const factToInferenceBypass = service.resumeRun(run.id, {
    gates,
    claims: [{
      id: "C-001",
      type: "INFERENCE",
      statement: "golden response matched",
      basis: "reuse a FACT attestation without an inference binding",
      verification_method: "independent protocol replay",
      evidence_ids: [claimEvidence.id],
    }],
    impact_matrix: passImpact(),
    impact_evidence: impactEvidenceMap,
  });
  assert.equal(factToInferenceBypass.storyPointDecision, "PARTIAL");
  assert.equal(factToInferenceBypass.claims[0].type, "UNKNOWN");

  const emptyClaimLedger = service.resumeRun(run.id, {
    gates,
    claims: [],
    impact_matrix: passImpact(),
    impact_evidence: impactEvidenceMap,
  });
  assert.equal(emptyClaimLedger.storyPointDecision, "PARTIAL");
  assert.equal(emptyClaimLedger.claims[0].type, "UNKNOWN");

  const inference = {
    id: "C-INFERENCE",
    type: "INFERENCE",
    statement: "the observed response is consistent with the documented contract",
    basis: "golden response and contract fixture agree",
    verification_method: "repeat the independent protocol fixture",
  };
  const inferenceEvidence = acceptanceStore.addAcceptanceEvidence(run.id, {
    ...evidenceBinding(run),
    kind: "attestation",
    uri: "evidence://golden/inference",
    sha256: "sha-golden-inference",
    trustLevel: "ATTESTED",
    producer: "test-independent-reviewer",
    metadata: {
      inferences: {
        [inference.id]: sha256({
          statement: inference.statement,
          basis: inference.basis,
          verification_method: inference.verification_method,
        }),
      },
    },
  });
  const supportedInference = service.resumeRun(run.id, {
    gates,
    claims: [{ ...inference, evidence_ids: [inferenceEvidence.id] }],
    impact_matrix: passImpact(),
    impact_evidence: impactEvidenceMap,
  });
  assert.equal(supportedInference.storyPointDecision, "VERIFIED");
  assert.equal(supportedInference.claims[0].type, "INFERENCE");

  const tamperedImpact = service.resumeRun(run.id, {
    gates,
    claims: [{ id: "C-001", type: "FACT", statement: "golden response matched", evidence_ids: [claimEvidence.id] }],
    impact_matrix: {
      ...passImpact(),
      permission_security_privacy: { status: "NOT_APPLICABLE", basis: "caller changed the attested outcome" },
    },
    impact_evidence: impactEvidenceMap,
  });
  assert.equal(tamperedImpact.storyPointDecision, "PARTIAL");
  assert.equal(tamperedImpact.impactMatrix.permission_security_privacy.status, "UNKNOWN");

  const verified = service.resumeRun(run.id, {
    gates,
    claims: [{ id: "C-001", type: "FACT", statement: "golden response matched", evidence_ids: [claimEvidence.id] }],
    impact_matrix: passImpact(),
    impact_evidence: impactEvidenceMap,
    candidate_consistent: true,
  });
  assert.equal(verified.storyPointDecision, "VERIFIED");
  assert.equal(verified.candidateEvidenceConsistent, true);

  const syncEvidence = acceptanceStore.addAcceptanceEvidence(run.id, {
    ...evidenceBinding(run),
    gateId: "SOURCE_SYNC",
    kind: "connector",
    uri: "evidence://source-sync/failed",
    sha256: "sha-source-sync-failed",
    trustLevel: "ATTESTED",
    producer: "test-source-connector",
    metadata: { sourceSyncStatus: "FAILED" },
  });

  const synced = service.resumeRun(run.id, {
    source_sync_status: "FAILED",
    source_sync_evidence_ids: [syncEvidence.id],
    source_sync_evidence: "HTTP 503 from source adapter",
  });
  assert.equal(synced.storyPointDecision, "VERIFIED");
  assert.equal(synced.sourceSyncStatus, "FAILED");
  assert.ok(synced.findings.some((finding) => finding.ownership === "SOURCE_CONNECTOR" && finding.blocking === false));

  const currentCanonical = acceptanceStore.getLatestSourceSnapshot(canonicalInput.story_point_id).canonical;
  const newer = service.normalizeStoryPoint({
    ...currentCanonical,
    sources: currentCanonical.sources.map((source) => ({
      ...source,
      fetched_at: "2026-08-10T01:00:00.000Z",
      raw_snapshot: { ...source.raw_snapshot, revision: 2 },
      snapshot_hash: undefined,
    })),
    acceptance_criteria: [...currentCanonical.acceptance_criteria, "new upstream fact must invalidate old assurance"],
  });
  assert.notEqual(newer.canonical.source_snapshot_hash, run.sourceSnapshotHash);
  const stale = acceptanceStore.getAcceptanceRun(run.id);
  assert.equal(stale.status, "STALE_SOURCE");
  assert.equal(stale.storyPointDecision, "PARTIAL");
  assert.equal(stale.sourceSyncDecision, "DENIED");
  assert.equal(stale.candidateEvidenceConsistent, false);
  assert.ok(stale.gates.every((gate) => gate.result === "PENDING" && gate.evidence_ids.length === 0));
  assert.ok(stale.claims.every((claim) => claim.type === "UNKNOWN" && claim.evidence_ids.length === 0));
  assert.ok(Object.values(stale.impactMatrix).every((entry) => entry.status === "UNKNOWN"));
  assert.throws(() => service.resumeRun(run.id, { gates }), /source snapshot is superseded/);

  const oldSnapshotId = db.prepare(`
    SELECT id FROM story_source_snapshots WHERE story_point_id = ? AND snapshot_hash = ?
  `).get(canonicalInput.story_point_id, run.sourceSnapshotHash).id;
  const newSnapshotId = newer.snapshot.id;
  db.transaction(() => {
    db.prepare("UPDATE story_source_snapshots SET superseded_by = ? WHERE id = ?").run(oldSnapshotId, newSnapshotId);
    db.prepare("UPDATE story_source_snapshots SET superseded_by = NULL WHERE id = ?").run(oldSnapshotId);
  })();
  assert.equal(acceptanceStore.getLatestSourceSnapshot(canonicalInput.story_point_id).snapshotHash, run.sourceSnapshotHash,
    "fixture deliberately simulates an erroneous resolver selecting the stale snapshot");
  assert.throws(() => service.resumeRun(run.id, { gates }), /source snapshot is superseded/,
    "STALE_SOURCE is terminal even if snapshot resolution is corrupted");
  db.transaction(() => {
    db.prepare("UPDATE story_source_snapshots SET superseded_by = ? WHERE id = ?").run(newSnapshotId, oldSnapshotId);
    db.prepare("UPDATE story_source_snapshots SET superseded_by = NULL WHERE id = ?").run(newSnapshotId);
  })();
});

test("PROJECT-STANDARD accepts the change without claiming production readiness", () => {
  const run = service.createProjectRun({
    project_task_id: "PROJECT-INTEGRATION-1",
    mode: "PROJECT-STANDARD",
    change_type: "TEST_OR_HARNESS",
    project_paths: ["gateway/services/acceptance"],
    target_repositories: ["AIEfficiency"],
    candidate: {
      repository: "AIEfficiency",
      base_ref: "base",
      head_ref: "head",
      diff_hash: "diff-project",
      dependency_hash: "dep",
      config_hash: "config",
      environment_id: "test-loopback",
      artifact_hash: "web-dist",
    },
    gates: passGates("PROJECT_ENGINEERING", "PROJECT-STANDARD", "TEST_OR_HARNESS"),
  });
  assert.equal(run.projectChangeDecision, "PARTIAL", "caller supplied PASS gates must start pending");
  const accepted = service.resumeRun(run.id, {
    gates: addTrustedGateEvidence(run, "PROJECT_ENGINEERING", "PROJECT-STANDARD", "TEST_OR_HARNESS"),
  });
  assert.equal(accepted.projectChangeDecision, "ACCEPTED");
  assert.equal(accepted.candidateEvidenceConsistent, true);
  assert.equal(accepted.productionReadiness, "NOT_ASSESSED");
  assert.equal(accepted.status, "STANDARD_ACCEPTED");
});

test("DUAL_SCOPE creates separate project and story runs with separate decisions", () => {
  const result = service.createDualRuns({
    story_point_id: canonicalInput.story_point_id,
    project_task_id: "PROJECT-DUAL-1",
    project_paths: ["gateway/services/acceptance"],
    story_target_paths: ["web-dashboard/src/pages/aiautowork"],
    target_repositories: ["AIEfficiency"],
    change_type: "FEATURE",
    story: {
      risk_tier: "STORY-STANDARD",
      candidate: {
        repository: "AIEfficiency-story-track",
        base_ref: "base",
        head_ref: "head-story",
        diff_hash: "diff-story",
        environment_id: "test-loopback",
        artifact_hash: "web-story",
      },
      gates: passGates("RUNTIME_STORY_POINT", "STORY-STANDARD"),
      claims: [{ type: "FACT", statement: "story UI matched", evidence_ids: ["E-UI"] }],
      impact_matrix: passImpact(),
      candidate_consistent: true,
    },
    project: {
      mode: "PROJECT-STANDARD",
      candidate: {
        repository: "AIEfficiency-project-track",
        base_ref: "base",
        head_ref: "head-project",
        diff_hash: "diff-project",
        environment_id: "test-loopback",
        artifact_hash: "web-project",
      },
      gates: passGates("PROJECT_ENGINEERING", "PROJECT-STANDARD"),
    },
  });
  assert.equal(result.route.scope_kind, "DUAL_SCOPE");
  assert.match(result.trackGroupId, /^dual_/);
  assert.equal(result.projectRun.trackGroupId, result.trackGroupId);
  assert.equal(result.storyRun.trackGroupId, result.trackGroupId);
  assert.notEqual(result.projectRun.contextId, result.storyRun.contextId);
  assert.notEqual(result.projectRun.candidateIdentityHash, result.storyRun.candidateIdentityHash);
  assert.equal(result.projectRun.projectChangeDecision, "PARTIAL");
  assert.equal(result.storyRun.storyPointDecision, "PARTIAL");
});

test("gate cache reuses only the exact protocol/gate/input hash", () => {
  const saved = acceptanceStore.putGateCache({
    protocol: "PROJECT_ENGINEERING",
    gateId: "P1_STATIC",
    inputHash: "candidate-a",
    result: "PASS",
    evidenceIds: ["E-1"],
  });
  assert.equal(saved.result, "PASS");
  assert.equal(acceptanceStore.getGateCache("PROJECT_ENGINEERING", "P1_STATIC", "candidate-b"), null);
  assert.equal(acceptanceStore.invalidateGateCache("PROJECT_ENGINEERING", ["P1_STATIC"]), 1);
  assert.equal(acceptanceStore.getGateCache("PROJECT_ENGINEERING", "P1_STATIC", "candidate-a"), null);
});

test("one acceptance run cannot mix candidate environments", () => {
  assert.throws(() => service.createProjectRun({
    project_task_id: "PROJECT-MIXED-ENV",
    target_repositories: ["AIEfficiency"],
    candidates: [
      { repository: "A", base_ref: "b", head_ref: "h", diff_hash: "d1", environment_id: "env-a" },
      { repository: "B", base_ref: "b", head_ref: "h", diff_hash: "d2", environment_id: "env-b" },
    ],
  }), /must share one environment_id/);
});
