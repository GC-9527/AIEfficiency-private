import { randomUUID } from "node:crypto";
import {
  IMPACT_DIMENSIONS,
  candidateIdentity,
  classifyProjectMode,
  classifyStoryRisk,
  evaluateProjectAcceptance,
  evaluateStoryAcceptance,
  normalizeCanonicalStoryPoint,
  routeAcceptance,
  sha256,
} from "./core.js";
import * as store from "./store.js";

const TRUSTED_EVIDENCE_LEVELS = new Set(["MECHANICAL", "ATTESTED"]);
const CONCLUSIVE_IMPACT_RESULTS = new Set(["PASS", "NOT_APPLICABLE"]);

function clean(value) {
  return typeof value === "string" ? value.trim() : "";
}

function asArray(value) {
  return Array.isArray(value) ? value : value === undefined || value === null ? [] : [value];
}

function cleanArray(value) {
  return [...new Set(asArray(value).map(clean).filter(Boolean))];
}

function evidenceReason(message) {
  return `ACCEPTANCE_EVIDENCE: ${message}`;
}

function candidateIdentityIsComplete(identity = {}) {
  const required = ["repository", "base_ref", "head_ref", "diff_hash", "environment_id"];
  return Array.isArray(identity.candidates)
    && identity.candidates.length > 0
    && identity.candidates.every((candidate) => required.every((key) => clean(candidate?.[key])));
}

function evidenceIsBoundToRun(run, evidence) {
  if (!evidence || evidence.runId !== run.id) return false;
  if (run.candidateIdentityHash && evidence.candidateIdentityHash !== run.candidateIdentityHash) return false;
  if (run.sourceSnapshotHash && evidence.sourceSnapshotHash !== run.sourceSnapshotHash) return false;
  if (run.environmentId && evidence.environmentId !== run.environmentId) return false;
  return true;
}

function evidenceHasOraclePayload(evidence) {
  if (evidence.exitCode !== null && evidence.exitCode !== undefined && evidence.exitCode !== 0) return false;
  return Boolean(
    clean(evidence.sha256)
    || clean(evidence.uri)
    || (clean(evidence.commandText) && evidence.exitCode === 0)
    || Object.keys(evidence.metadata || {}).length,
  );
}

function evidenceIsTrustedForPass(run, evidence, gateId) {
  if (!evidenceIsBoundToRun(run, evidence)) return false;
  if (gateId !== undefined && evidence.gateId !== gateId) return false;
  return TRUSTED_EVIDENCE_LEVELS.has(clean(evidence.trustLevel).toUpperCase())
    && Boolean(clean(evidence.producer))
    && evidenceHasOraclePayload(evidence);
}

function evidenceIndexForRun(run) {
  return new Map(store.listAcceptanceEvidence(run.id).map((evidence) => [evidence.id, evidence]));
}

function sanitizeGateEvidence(run, requested = [], evidenceIndex) {
  const reasons = [];
  const gates = asArray(requested).map((gate) => {
    const requestedResult = clean(gate?.result).toUpperCase();
    const requestedIds = cleanArray(gate?.evidence_ids || gate?.evidenceIds);
    const boundIds = requestedIds.filter((id) => evidenceIsBoundToRun(run, evidenceIndex.get(id)));
    if (requestedResult !== "PASS") return { ...gate, evidence_ids: boundIds };
    const trustedIds = requestedIds.filter((id) => evidenceIsTrustedForPass(run, evidenceIndex.get(id), clean(gate?.id)));
    const plannedGate = asArray(run.gates).find((item) => item?.id === gate?.id) || gate;
    const requiredCoverage = cleanArray(plannedGate.evidenceRequirements);
    const covered = new Set(trustedIds.flatMap((id) => cleanArray(
      evidenceIndex.get(id)?.metadata?.requirementsCovered
      || evidenceIndex.get(id)?.metadata?.requirements_covered,
    )));
    const coverageComplete = requiredCoverage.every((requirement) => covered.has(requirement));
    if (!requestedIds.length || trustedIds.length !== requestedIds.length || !coverageComplete) {
      reasons.push(evidenceReason(`gate ${clean(gate?.id) || "UNKNOWN"} PASS lacks trusted bound evidence`));
      return { ...gate, result: "PENDING", evidence_ids: trustedIds };
    }
    return { ...gate, result: "PASS", evidence_ids: trustedIds };
  });
  return { gates, reasons };
}

function sanitizeClaims(run, requested = [], evidenceIndex) {
  const reasons = [];
  const claims = asArray(requested).map((claim, index) => {
    const id = clean(claim?.id) || `C-${String(index + 1).padStart(3, "0")}`;
    const statement = clean(claim?.statement) || "Unspecified claim";
    const type = clean(claim?.type).toUpperCase();
    const basis = clean(claim?.basis);
    const verificationMethod = clean(claim?.verification_method || claim?.verificationMethod);
    const requestedIds = cleanArray(claim?.evidence_ids || claim?.evidenceIds);
    const trustedIds = requestedIds.filter((evidenceId) => {
      const evidence = evidenceIndex.get(evidenceId);
      if (!evidenceIsTrustedForPass(run, evidence)) return false;
      if (type === "FACT") {
        const claimHashes = evidence?.metadata?.claims || evidence?.metadata?.claimHashes || evidence?.metadata?.claim_hashes || {};
        return claimHashes[id] === sha256(statement);
      }
      if (type === "INFERENCE") {
        const inferences = evidence?.metadata?.inferences || evidence?.metadata?.inferenceBindings || evidence?.metadata?.inference_bindings || {};
        return inferences[id] === sha256({
          statement,
          basis,
          verification_method: verificationMethod,
        });
      }
      return false;
    });
    const incompleteInference = type === "INFERENCE" && (!basis || !verificationMethod);
    if (["FACT", "INFERENCE"].includes(type)
      && (incompleteInference || !requestedIds.length || trustedIds.length !== requestedIds.length)) {
      reasons.push(evidenceReason(`claim ${id} ${type} lacks trusted bound evidence`));
      return {
        ...claim,
        id,
        statement,
        type: "UNKNOWN",
        evidence_ids: trustedIds,
        ...(basis ? { basis } : {}),
        ...(verificationMethod ? { verification_method: verificationMethod } : {}),
      };
    }
    if (!["FACT", "INFERENCE", "UNKNOWN"].includes(type)) {
      reasons.push(evidenceReason(`claim ${id} has unsupported type ${type || "EMPTY"}`));
      return { ...claim, id, statement, type: "UNKNOWN", evidence_ids: [] };
    }
    return {
      ...claim,
      id,
      statement,
      evidence_ids: trustedIds,
      ...(basis ? { basis } : {}),
      ...(verificationMethod ? { verification_method: verificationMethod } : {}),
    };
  });
  return { claims, reasons };
}

function impactEvidenceIds(patch, dimension, entry, evidenceIndex, run) {
  const explicit = patch.impact_evidence || patch.impactEvidence || {};
  const requestedIds = cleanArray(
    explicit[dimension]
    || entry?.evidence_ids
    || entry?.evidenceIds,
  );
  if (requestedIds.length) return requestedIds;
  return [...evidenceIndex.values()]
    .filter((evidence) => Object.hasOwn(
      evidence.metadata?.impactResults || evidence.metadata?.impact_results || {},
      dimension,
    ))
    .filter((evidence) => evidenceIsTrustedForPass(run, evidence))
    .map((evidence) => evidence.id);
}

function sanitizeImpactMatrix(run, requested = {}, patch, evidenceIndex) {
  const reasons = [];
  const matrix = Object.fromEntries(IMPACT_DIMENSIONS.map((dimension) => {
    const entry = requested?.[dimension] || {};
    const status = clean(entry.status).toUpperCase();
    const basis = clean(entry.basis);
    if (!CONCLUSIVE_IMPACT_RESULTS.has(status)) return [dimension, { status: "UNKNOWN", basis }];
    const requestedIds = impactEvidenceIds(patch, dimension, entry, evidenceIndex, run);
    const trustedIds = requestedIds.filter((id) => {
      const evidence = evidenceIndex.get(id);
      const impactResults = evidence?.metadata?.impactResults || evidence?.metadata?.impact_results || {};
      return clean(impactResults[dimension]).toUpperCase() === status
        && evidenceIsTrustedForPass(run, evidence);
    });
    if (!basis || !requestedIds.length || trustedIds.length !== requestedIds.length) {
      reasons.push(evidenceReason(`impact ${dimension} ${status} lacks trusted bound evidence`));
      return [dimension, { status: "UNKNOWN", basis }];
    }
    return [dimension, { status, basis }];
  }));
  return { matrix, reasons };
}

function sanitizeSourceSync(run, patch, evidenceIndex) {
  const explicitStatus = clean(patch.sourceSyncStatus || patch.source_sync_status).toUpperCase();
  const requestedStatus = explicitStatus || clean(run.sourceSyncStatus).toUpperCase();
  if (!requestedStatus || requestedStatus === "NOT_ATTEMPTED") {
    return { status: "NOT_ATTEMPTED", accepted: true, reasons: [] };
  }
  const explicitIds = cleanArray(patch.sourceSyncEvidenceIds || patch.source_sync_evidence_ids);
  const requestedIds = explicitIds.length
    ? explicitIds
    : [...evidenceIndex.values()]
      .filter((evidence) => evidence.gateId === "SOURCE_SYNC")
      .map((evidence) => evidence.id);
  const trustedIds = requestedIds.filter((id) => {
    const evidence = evidenceIndex.get(id);
    const reportedStatus = clean(
      evidence?.metadata?.sourceSyncStatus
      || evidence?.metadata?.source_sync_status
      || evidence?.metadata?.result,
    ).toUpperCase();
    return reportedStatus === requestedStatus
      && evidenceIsTrustedForPass(run, evidence, "SOURCE_SYNC");
  });
  const supportedStatus = ["SUCCEEDED", "FAILED", "PARTIAL"].includes(requestedStatus);
  if (!supportedStatus || !requestedIds.length || trustedIds.length !== requestedIds.length) {
    return {
      status: "NOT_ATTEMPTED",
      accepted: false,
      reasons: [evidenceReason(`source sync ${requestedStatus || "UNKNOWN"} lacks trusted connector evidence`)],
    };
  }
  return { status: requestedStatus, accepted: true, reasons: [] };
}

function runStatusForProject(result) {
  if (result.mode === "PROJECT-QUICK") return "QUICK_CHECKED";
  if (result.production_readiness === "READY") return "RELEASE_READY";
  if (result.production_readiness === "NOT_READY") return "RELEASE_NOT_READY";
  if (result.project_change_decision === "ACCEPTED") return "STANDARD_ACCEPTED";
  if (result.project_change_decision === "REJECTED") return "REJECTED";
  return "PARTIAL";
}

function runStatusForStory(result) {
  if (result.story_point_decision === "VERIFIED") return "VERIFIED";
  if (result.story_point_decision === "BLOCKED") {
    const harness = result.blocking_findings.some((finding) => finding?.ownership === "HARNESS_DEFECT");
    return harness ? "BLOCKED_BY_HARNESS" : "BLOCKED";
  }
  return "PARTIAL";
}

export function routeTask(input = {}, { persist = true } = {}) {
  const route = routeAcceptance(input);
  const context = persist ? store.saveAcceptanceContext(route) : null;
  return { route, context };
}

export function normalizeStoryPoint(input = {}, { persist = true } = {}) {
  const canonical = normalizeCanonicalStoryPoint(input);
  const persisted = persist ? store.saveSourceSnapshot(canonical) : null;
  const routeInput = {
    ...input,
    story_point_id: canonical.story_point_id,
    source_snapshot_hash: canonical.source_snapshot_hash,
    source_refs: canonical.sources.map((source) => ({
      system: source.system,
      issue_id: source.issue_id,
      snapshot_hash: source.snapshot_hash,
    })),
    target_repositories: canonical.target_repositories,
    change_type: canonical.change_type,
    story_target_changed: true,
  };
  const { route, context } = routeTask(routeInput, { persist });
  return {
    canonical,
    snapshot: persisted?.snapshot || null,
    idempotent: persisted?.idempotent || false,
    route,
    context,
  };
}

function normalizeCandidateBundle(input = {}, sourceSnapshotHash = null) {
  const candidates = asArray(input.candidates?.length ? input.candidates : input.candidate);
  const candidateEnvironments = cleanArray(candidates.map((candidate) => candidate?.environment_id || candidate?.environmentId));
  const requestedEnvironment = clean(input.environment_id || input.environmentId);
  if (candidateEnvironments.length > 1) {
    throw new TypeError("all candidates in one acceptance run must share one environment_id");
  }
  if (requestedEnvironment && candidateEnvironments.length && candidateEnvironments[0] !== requestedEnvironment) {
    throw new TypeError("candidate environment_id does not match the acceptance run environment_id");
  }
  const environmentId = requestedEnvironment || candidateEnvironments[0] || null;
  const identity = candidateIdentity(candidates, {
    sourceSnapshotHash,
    environmentId,
    rulesHash: input.rules_hash || input.rulesHash,
  });
  return { candidates, identity };
}

export function createProjectRun(input = {}) {
  const mode = classifyProjectMode(input);
  const { route, context } = routeTask({
    ...input,
    direct_project_task: true,
    mode,
  });
  if (route.scope_kind !== "PROJECT_ENGINEERING") {
    throw new TypeError("project acceptance requires PROJECT_ENGINEERING routing");
  }
  const { candidates, identity } = normalizeCandidateBundle(input);
  const candidateComplete = candidateIdentityIsComplete(identity);
  const result = evaluateProjectAcceptance({
    ...input,
    mode,
    gates: [],
    unknowns: [
      ...cleanArray(input.unknowns),
      ...(!candidateComplete ? [evidenceReason("candidate identity is incomplete")] : []),
      evidenceReason("trusted gate evidence has not been evaluated"),
    ],
    route_status: route.route_status,
  });
  return store.createAcceptanceRun({
    contextId: context.id,
    protocol: "PROJECT_ENGINEERING",
    modeOrTier: mode,
    status: runStatusForProject(result),
    candidateIdentityHash: identity.identity_hash,
    candidate: { identity, candidates },
    environmentId: identity.environment_id,
    gates: result.gates,
    findings: [...result.blocking_findings, ...result.non_blocking_findings],
    unknowns: result.unknowns,
    residualRisks: result.residual_risks,
    repairRounds: result.repair_rounds,
    projectChangeDecision: result.project_change_decision,
    productionReadiness: result.production_readiness,
    trackGroupId: clean(input.track_group_id || input.trackGroupId) || null,
    candidateEvidenceConsistent: null,
    candidateConsistencyReasons: [evidenceReason("trusted gate evidence has not been evaluated")],
  });
}

function resolveStorySnapshot(input = {}) {
  if (input.canonical_story_point || input.canonicalStoryPoint) {
    return normalizeStoryPoint(input.canonical_story_point || input.canonicalStoryPoint);
  }
  const storyPointId = clean(input.story_point_id || input.storyPointId);
  if (!storyPointId) throw new TypeError("story_point_id is required");
  const snapshot = store.getLatestSourceSnapshot(storyPointId);
  if (!snapshot) throw new TypeError("immutable source snapshot is required before story assurance");
  const routeInput = {
    ...input,
    story_point_id: storyPointId,
    source_snapshot_hash: snapshot.snapshotHash,
    source_refs: snapshot.canonical.sources?.map((source) => ({
      system: source.system,
      issue_id: source.issue_id,
      snapshot_hash: source.snapshot_hash,
    })) || [],
    target_repositories: input.target_repositories || input.targetRepositories || snapshot.canonical.target_repositories,
    change_type: input.change_type || input.changeType || snapshot.canonical.change_type,
    story_target_changed: input.story_target_changed ?? input.storyTargetChanged ?? true,
  };
  const { route, context } = routeTask(routeInput);
  return { canonical: snapshot.canonical, snapshot, route, context, idempotent: true };
}

export function createStoryRun(input = {}) {
  const resolved = resolveStorySnapshot(input);
  if (!resolved.route.protocols.includes("runtime-story-point-assurance")) {
    throw new TypeError("story acceptance requires RUNTIME_STORY_POINT routing");
  }
  const risk = classifyStoryRisk({ ...resolved.canonical, ...input });
  const { candidates, identity } = normalizeCandidateBundle(input, resolved.canonical.source_snapshot_hash);
  const result = evaluateStoryAcceptance({
    ...resolved.canonical,
    ...input,
    gates: [],
    claims: asArray(input.claims).map((claim) => ({ ...claim, type: "UNKNOWN", evidence_ids: [] })),
    impact_matrix: {},
    candidate_consistent: false,
    source_sync_status: "NOT_ATTEMPTED",
    risk_tier: risk.tier,
    route_status: resolved.route.route_status,
  });
  return store.createAcceptanceRun({
    contextId: resolved.context.id,
    protocol: "RUNTIME_STORY_POINT",
    modeOrTier: risk.tier,
    status: runStatusForStory(result),
    candidateIdentityHash: identity.identity_hash,
    candidate: { identity, candidates },
    sourceSnapshotHash: resolved.canonical.source_snapshot_hash,
    environmentId: identity.environment_id,
    gates: result.gates,
    claims: result.claims,
    impactMatrix: result.impact_matrix,
    findings: [...result.blocking_findings, ...result.non_blocking_findings],
    residualRisks: result.residual_risks,
    repairRounds: result.repair_rounds,
    storyPointDecision: result.story_point_decision,
    sourceSyncDecision: result.source_sync_decision,
    sourceSyncStatus: result.source_sync_status,
    trackGroupId: clean(input.track_group_id || input.trackGroupId) || null,
    candidateEvidenceConsistent: null,
    candidateConsistencyReasons: [
      ...(!candidateIdentityIsComplete(identity) ? [evidenceReason("candidate identity is incomplete")] : []),
      evidenceReason("trusted story evidence has not been evaluated"),
    ],
  });
}

export function createDualRuns(input = {}) {
  const trackGroupId = `dual_${randomUUID().replace(/-/g, "").slice(0, 20)}`;
  const storyInput = { ...(input.story || {}), ...input, track_group_id: trackGroupId };
  delete storyInput.project;
  delete storyInput.story;
  const resolved = resolveStorySnapshot(storyInput);
  if (resolved.route.scope_kind !== "DUAL_SCOPE") {
    throw new TypeError("dual acceptance requires DUAL_SCOPE routing");
  }
  const storyRun = createStoryRun(storyInput);
  const projectInput = {
    ...(input.project || {}),
    project_task_id: input.project?.project_task_id || input.project?.projectTaskId || input.project_task_id || input.projectTaskId,
    direct_project_task: true,
    project_paths: input.project?.project_paths || input.project?.projectPaths || resolved.route.project_paths,
    target_repositories: input.project?.target_repositories || input.project?.targetRepositories || resolved.route.target_repositories,
    change_type: input.project?.change_type || input.project?.changeType || resolved.route.change_type,
    track_group_id: trackGroupId,
  };
  if (!projectInput.project_task_id) {
    projectInput.project_task_id = `PROJECT-FOR-${resolved.canonical.story_point_id}`;
  }
  const projectRun = createProjectRun(projectInput);
  return { trackGroupId, route: resolved.route, projectRun, storyRun };
}

export function resumeRun(runId, patch = {}) {
  const current = store.getAcceptanceRun(runId);
  if (!current) throw new TypeError("acceptance run not found");
  if (current.protocol === "RUNTIME_STORY_POINT") {
    if (current.status === "STALE_SOURCE") {
      throw new TypeError("acceptance run source snapshot is superseded; create a new run");
    }
    const storyPointId = clean(current.routing?.story_point_id || current.routing?.storyPointId);
    const latestSnapshot = storyPointId ? store.getLatestSourceSnapshot(storyPointId) : null;
    if (!latestSnapshot || latestSnapshot.snapshotHash !== current.sourceSnapshotHash) {
      if (storyPointId && latestSnapshot) {
        store.invalidateStoryRunsForSourceSnapshot(storyPointId, latestSnapshot.snapshotHash);
      }
      throw new TypeError("acceptance run source snapshot is superseded; create a new run");
    }
  }
  const evidenceIndex = evidenceIndexForRun(current);
  const gateCheck = sanitizeGateEvidence(current, patch.gates || current.gates, evidenceIndex);
  const candidateComplete = candidateIdentityIsComplete(current.candidate?.identity);
  const merged = {
    mode: current.modeOrTier,
    risk_tier: current.modeOrTier,
    change_type: current.routing?.change_type,
    gates: gateCheck.gates,
    claims: patch.claims || current.claims,
    impact_matrix: patch.impactMatrix || patch.impact_matrix || current.impactMatrix,
    findings: patch.findings || current.findings,
    unknowns: patch.unknowns || current.unknowns,
    residual_risks: patch.residualRisks || patch.residual_risks || current.residualRisks,
    repair_rounds: patch.repairRounds ?? patch.repair_rounds ?? current.repairRounds,
    source_sync_status: current.sourceSyncStatus,
    candidate_consistent: candidateComplete && gateCheck.reasons.length === 0,
    route_status: current.routing?.route_status,
  };
  if (current.protocol === "PROJECT_ENGINEERING") {
    const consistencyReasons = [
      ...(!candidateComplete ? [evidenceReason("candidate identity is incomplete")] : []),
      ...gateCheck.reasons,
    ];
    merged.unknowns = [
      ...cleanArray(merged.unknowns).filter((value) => !value.startsWith("ACCEPTANCE_EVIDENCE:")),
      ...consistencyReasons,
    ];
    const result = evaluateProjectAcceptance(merged);
    return store.updateAcceptanceRun(runId, {
      status: runStatusForProject(result),
      gates: result.gates,
      findings: [...result.blocking_findings, ...result.non_blocking_findings],
      unknowns: result.unknowns,
      residualRisks: result.residual_risks,
      repairRounds: result.repair_rounds,
      projectChangeDecision: result.project_change_decision,
      productionReadiness: result.production_readiness,
      candidateEvidenceConsistent: evidenceIndex.size ? consistencyReasons.length === 0 : null,
      candidateConsistencyReasons: consistencyReasons.length
        ? consistencyReasons
        : evidenceIndex.size ? [] : [evidenceReason("trusted gate evidence has not been evaluated")],
    });
  }
  const claimCheck = sanitizeClaims(current, patch.claims || current.claims, evidenceIndex);
  const impactCheck = sanitizeImpactMatrix(
    current,
    patch.impactMatrix || patch.impact_matrix || current.impactMatrix,
    patch,
    evidenceIndex,
  );
  const sourceSyncCheck = sanitizeSourceSync(current, patch, evidenceIndex);
  const consistencyReasons = [
    ...(!candidateComplete ? [evidenceReason("candidate identity is incomplete")] : []),
    ...gateCheck.reasons,
    ...claimCheck.reasons,
    ...impactCheck.reasons,
  ];
  merged.claims = claimCheck.claims;
  merged.impact_matrix = impactCheck.matrix;
  merged.source_sync_status = sourceSyncCheck.status;
  merged.candidate_consistent = candidateComplete && consistencyReasons.length === 0;
  if (sourceSyncCheck.reasons.length) {
    merged.findings = [...merged.findings, ...sourceSyncCheck.reasons.map((reason) => ({
      severity: "P2",
      ownership: "SOURCE_CONNECTOR",
      blocking: false,
      behavior: reason,
      evidence: "trusted source connector evidence was not available",
      minimal_fix: "run or retry the idempotent source connector and attach trusted bound evidence",
      invalidated_gates: [],
    }))];
  }
  if (sourceSyncCheck.status === "FAILED" && !merged.findings.some((finding) => finding?.ownership === "SOURCE_CONNECTOR")) {
    merged.findings = [...merged.findings, {
      severity: "P2",
      ownership: "SOURCE_CONNECTOR",
      blocking: false,
      behavior: "source result write-back failed after technical assurance",
      evidence: clean(patch.sourceSyncEvidence || patch.source_sync_evidence) || "source sync adapter reported FAILED",
      minimal_fix: "retry the idempotent source sync operation without changing target business code",
      invalidated_gates: [],
    }];
  }
  const result = evaluateStoryAcceptance(merged);
  return store.updateAcceptanceRun(runId, {
    status: runStatusForStory(result),
    gates: result.gates,
    claims: result.claims,
    impactMatrix: result.impact_matrix,
    findings: [...result.blocking_findings, ...result.non_blocking_findings],
    residualRisks: result.residual_risks,
    repairRounds: result.repair_rounds,
    storyPointDecision: result.story_point_decision,
    sourceSyncDecision: result.source_sync_decision,
    sourceSyncStatus: result.source_sync_status,
    candidateEvidenceConsistent: evidenceIndex.size ? consistencyReasons.length === 0 : null,
    candidateConsistencyReasons: consistencyReasons.length
      ? consistencyReasons
      : evidenceIndex.size ? [] : [evidenceReason("trusted story evidence has not been evaluated")],
  });
}

export function addEvidence(runId, evidence = {}) {
  const run = store.getAcceptanceRun(runId);
  if (!run) throw new TypeError("acceptance run not found");
  if (run.candidateIdentityHash && evidence.candidateIdentityHash !== run.candidateIdentityHash) {
    throw new TypeError("evidence candidate identity does not match the acceptance run");
  }
  if (run.sourceSnapshotHash && evidence.sourceSnapshotHash !== run.sourceSnapshotHash) {
    throw new TypeError("evidence source snapshot does not match the acceptance run");
  }
  if (run.environmentId && evidence.environmentId !== run.environmentId) {
    throw new TypeError("evidence environment does not match the acceptance run");
  }
  return store.addAcceptanceEvidence(runId, {
    ...evidence,
    trustLevel: "UNVERIFIED",
    producer: "ADMIN_API",
  });
}

export function registerRuntimeStoryPointFromDraft({ draft, snapshot, storyPoint } = {}) {
  if (!draft?.id || !storyPoint?.id) throw new TypeError("draft and storyPoint are required");
  const normalized = draft.normalizedInput || {};
  const resolved = snapshot?.snapshot || {};
  const sourceSystem = clean(draft.sourceType || "manual").toLowerCase();
  const sourceIssueId = clean(draft.sourceRef) || draft.id;
  const targetRepositories = asArray(
    resolved.targetRepositories
    || resolved.repositories
    || normalized.targetRepositories
    || normalized.repositories,
  ).map((value) => typeof value === "string" ? value : value?.path || value?.repository || "").filter(Boolean);
  return normalizeStoryPoint({
    story_point_id: storyPoint.id,
    title: normalized.title || resolved.title || sourceIssueId,
    description: normalized.description || resolved.description || "",
    change_type: normalized.changeType || resolved.changeType || "MIXED",
    sources: [{
      system: sourceSystem,
      issue_id: sourceIssueId,
      status: normalized.status || null,
      fetched_at: draft.createdAt,
      mapping_version: "aiautowork-v1",
      raw_snapshot: draft.rawInput || normalized,
    }],
    acceptance_criteria: normalized.acceptanceCriteria || resolved.acceptanceCriteria || [],
    must_change: normalized.mustChange || resolved.mustChange || [],
    must_preserve: normalized.mustPreserve || resolved.mustPreserve || [],
    forbidden_scope: normalized.forbiddenScope || resolved.forbiddenScope || [],
    target_repositories: targetRepositories.length ? targetRepositories : ["UNRESOLVED_TARGET_REPOSITORY"],
    runtime_context: resolved.runtimeContext || normalized.runtimeContext || {},
    conflicts: normalized.conflicts || [],
    story_target_changed: true,
  });
}

export function listRuns(filters = {}) {
  return store.listAcceptanceRuns(filters);
}

export function getRun(runId) {
  const run = store.getAcceptanceRun(runId);
  if (!run) return null;
  return {
    ...run,
    evidence: store.listAcceptanceEvidence(runId),
    events: store.listAcceptanceEvents(runId),
  };
}

export function listStoryRuns(storyPointId, limit = 100) {
  return store.listAcceptanceRuns({ storyPointId, limit });
}

export default {
  routeTask,
  normalizeStoryPoint,
  createProjectRun,
  createStoryRun,
  createDualRuns,
  resumeRun,
  addEvidence,
  registerRuntimeStoryPointFromDraft,
  listRuns,
  getRun,
  listStoryRuns,
};
