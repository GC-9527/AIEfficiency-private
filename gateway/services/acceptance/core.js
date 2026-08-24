import { createHash } from "node:crypto";

export const ACCEPTANCE_PROTOCOL_VERSION = "4.1";

export const CHANGE_TYPES = Object.freeze([
  "FEATURE",
  "DEFECT_FIX",
  "REFACTOR",
  "CONFIG_OR_DATA",
  "PACKAGE_OR_RELEASE",
  "TEST_OR_HARNESS",
  "REVIEW_OR_ANALYSIS",
  "DOCUMENTATION",
  "MIXED",
]);

export const IMPACT_DIMENSIONS = Object.freeze([
  "direct_consumers",
  "boundary_and_errors",
  "state_lifecycle_concurrency",
  "data_cache_migration",
  "permission_security_privacy",
  "network_timeout_retry",
  "api_sdk_compatibility",
  "flavor_device_platform",
  "build_package_install_upgrade",
  "performance_resources",
  "observability_recovery_rollback",
  "harness_connector_false_results",
]);

const STORY_TIERS = new Set(["STORY-FAST", "STORY-STANDARD", "STORY-CRITICAL"]);
const PROJECT_MODES = new Set(["PROJECT-QUICK", "PROJECT-STANDARD", "PROJECT-RELEASE"]);
const GATE_RESULTS = new Set(["PASS", "FAIL", "SKIPPED", "BLOCKED", "PENDING"]);
const IMPACT_RESULTS = new Set(["PASS", "NOT_APPLICABLE", "UNKNOWN"]);
const CLAIM_TYPES = new Set(["FACT", "INFERENCE", "UNKNOWN"]);

const CHANGE_TYPE_EVIDENCE = Object.freeze({
  FEATURE: [
    "acceptance_criteria_trace",
    "positive_boundary_error_permission_scenarios",
    "compatibility_and_rollback",
  ],
  DEFECT_FIX: [
    "baseline_failure_or_independent_oracle",
    "root_cause_and_competing_hypotheses",
    "must_change_and_must_preserve",
    "baseline_red_candidate_green",
    "direct_boundary_adjacent_regression",
  ],
  REFACTOR: [
    "observable_behavior_parity",
    "public_contract_compatibility",
    "consumer_regression",
    "performance_and_resource_comparison",
  ],
  CONFIG_OR_DATA: [
    "schema_and_value_validation",
    "environment_binding",
    "migration_and_rollback",
  ],
  PACKAGE_OR_RELEASE: [
    "final_artifact_hash_version_signature",
    "install_upgrade_overwrite_and_rollback",
    "packaged_runtime_smoke",
  ],
  TEST_OR_HARNESS: [
    "independent_oracle",
    "false_positive_and_false_negative_checks",
    "baseline_candidate_separation",
  ],
  REVIEW_OR_ANALYSIS: [
    "authoritative_source_citations",
    "fact_inference_unknown_separation",
    "read_only_scope_confirmation",
  ],
  DOCUMENTATION: [
    "scope_and_behavior_accuracy",
    "link_and_code_sample_validation",
  ],
});

const CRITICAL_TAGS = new Set([
  "authentication",
  "authorization",
  "sensitive_data",
  "database_migration",
  "concurrency_or_idempotency",
  "public_api_or_protocol",
  "public_sdk",
  "signing_or_packaging",
  "install_or_upgrade",
  "production_configuration",
  "irreversible_operation",
  "security_boundary",
  "impact_scope_unknown",
  "multiple_repositories_with_unknown_compatibility",
  "multiple_flavors_or_consumers_with_unknown_compatibility",
  "cannot_reproduce_and_no_independent_oracle",
]);

function cleanString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function cleanStringArray(value) {
  return [...new Set((Array.isArray(value) ? value : [])
    .map(cleanString)
    .filter(Boolean))];
}

function normalizeChangeType(value) {
  const normalized = cleanString(value).toUpperCase();
  return CHANGE_TYPES.includes(normalized) ? normalized : "MIXED";
}

export function evidenceRequirementsForChangeType(value) {
  const changeType = normalizeChangeType(value);
  if (changeType !== "MIXED") return [...(CHANGE_TYPE_EVIDENCE[changeType] || [])];
  return [...new Set(Object.values(CHANGE_TYPE_EVIDENCE).flat())];
}

export function stableStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
}

export function sha256(value) {
  const payload = typeof value === "string" ? value : stableStringify(value);
  return createHash("sha256").update(payload).digest("hex");
}

export function normalizeCandidate(candidate = {}) {
  const repository = cleanString(candidate.repository || candidate.repositoryId);
  const baseRef = cleanString(candidate.base_ref || candidate.baseRef);
  const headRef = cleanString(candidate.head_ref || candidate.headRef);
  const diffHash = cleanString(candidate.diff_hash || candidate.diffHash);
  const dependencyHash = cleanString(candidate.dependency_hash || candidate.dependencyHash);
  const configHash = cleanString(candidate.config_hash || candidate.configHash);
  const environmentId = cleanString(candidate.environment_id || candidate.environmentId);
  const artifactHash = cleanString(candidate.artifact_hash || candidate.artifactHash);
  const flavorOrVariant = cleanString(candidate.flavor_or_variant || candidate.flavorOrVariant);
  const normalized = {
    repository,
    base_ref: baseRef,
    head_ref: headRef,
    diff_hash: diffHash,
    dependency_hash: dependencyHash,
    config_hash: configHash,
    environment_id: environmentId,
    artifact_hash: artifactHash || null,
    flavor_or_variant: flavorOrVariant || null,
  };
  normalized.candidate_hash = sha256(normalized);
  return normalized;
}

export function candidateIdentity(candidates = [], shared = {}) {
  const normalizedCandidates = (Array.isArray(candidates) ? candidates : [candidates]).map(normalizeCandidate);
  const identity = {
    protocol_version: ACCEPTANCE_PROTOCOL_VERSION,
    candidates: normalizedCandidates,
    source_snapshot_hash: cleanString(shared.sourceSnapshotHash || shared.source_snapshot_hash) || null,
    environment_id: cleanString(shared.environmentId || shared.environment_id) || null,
    rules_hash: cleanString(shared.rulesHash || shared.rules_hash) || null,
  };
  return { ...identity, identity_hash: sha256(identity) };
}

export function normalizeSourceRef(source = {}, index = 0) {
  const system = cleanString(source.system || source.sourceSystem || source.source_system || "manual").toLowerCase();
  const issueId = cleanString(source.issue_id || source.issueId || source.sourceIssueId || source.source_issue_id);
  if (!issueId) throw new TypeError(`sources[${index}].issue_id is required`);
  const rawSnapshot = source.raw_snapshot ?? source.rawSnapshot ?? source.payload ?? source;
  const snapshotHash = cleanString(source.snapshot_hash || source.snapshotHash) || sha256(rawSnapshot);
  const fetchedAt = cleanString(source.fetched_at || source.fetchedAt);
  if (!fetchedAt) throw new TypeError(`sources[${index}].fetched_at is required for a deterministic snapshot`);
  return {
    system,
    issue_id: issueId,
    url: cleanString(source.url || source.sourceUrl || source.source_url) || null,
    issue_type: cleanString(source.issue_type || source.issueType) || null,
    status: cleanString(source.status || source.sourceStatus || source.source_status) || null,
    fetched_at: fetchedAt,
    snapshot_hash: snapshotHash,
    mapping_version: cleanString(source.mapping_version || source.mappingVersion) || "1",
    raw_snapshot: rawSnapshot,
  };
}

export function normalizeCanonicalStoryPoint(input = {}) {
  const storyPointId = cleanString(input.story_point_id || input.storyPointId);
  if (!storyPointId) throw new TypeError("story_point_id is required");
  const sources = (Array.isArray(input.sources) ? input.sources : []).map(normalizeSourceRef);
  if (!sources.length) throw new TypeError("at least one source is required");
  const primarySourceIndex = Number.isInteger(input.primary_source_index ?? input.primarySourceIndex)
    ? Number(input.primary_source_index ?? input.primarySourceIndex)
    : 0;
  if (primarySourceIndex < 0 || primarySourceIndex >= sources.length) {
    throw new TypeError("primary_source_index is out of range");
  }
  const acceptanceCriteria = cleanStringArray(input.acceptance_criteria || input.acceptanceCriteria);
  const targetRepositories = cleanStringArray(input.target_repositories || input.targetRepositories);
  const sourceMaterials = input.source_materials || input.sourceMaterials || {};
  const normalized = {
    story_point_id: storyPointId,
    title: cleanString(input.title),
    description: cleanString(input.description),
    change_type: normalizeChangeType(input.change_type || input.changeType),
    primary_source_index: primarySourceIndex,
    sources,
    related_source_indices: (Array.isArray(input.related_source_indices || input.relatedSourceIndices)
      ? (input.related_source_indices || input.relatedSourceIndices) : [])
      .map(Number)
      .filter((value) => Number.isInteger(value) && value >= 0 && value < sources.length && value !== primarySourceIndex),
    source_materials: {
      read: cleanStringArray(sourceMaterials.read),
      unread: cleanStringArray(sourceMaterials.unread),
    },
    acceptance_criteria: acceptanceCriteria,
    must_change: cleanStringArray(input.must_change || input.mustChange),
    must_preserve: cleanStringArray(input.must_preserve || input.mustPreserve),
    forbidden_scope: cleanStringArray(input.forbidden_scope || input.forbiddenScope),
    target_repositories: targetRepositories,
    target_branches: cleanStringArray(input.target_branches || input.targetBranches),
    runtime_context: input.runtime_context || input.runtimeContext || {},
    conflicts: Array.isArray(input.conflicts) ? input.conflicts : [],
  };
  const snapshotInput = {
    story_point_id: normalized.story_point_id,
    change_type: normalized.change_type,
    primary_source_index: normalized.primary_source_index,
    sources: sources.map(({ raw_snapshot: rawSnapshot, ...source }) => ({ ...source, raw_snapshot: rawSnapshot })),
    related_source_indices: normalized.related_source_indices,
    source_materials: normalized.source_materials,
    title: normalized.title,
    description: normalized.description,
    acceptance_criteria: normalized.acceptance_criteria,
    must_change: normalized.must_change,
    must_preserve: normalized.must_preserve,
    forbidden_scope: normalized.forbidden_scope,
    target_repositories: normalized.target_repositories,
    target_branches: normalized.target_branches,
    runtime_context: normalized.runtime_context,
    conflicts: normalized.conflicts,
  };
  return { ...normalized, source_snapshot_hash: sha256(snapshotInput) };
}

export function classifyStoryRisk(input = {}) {
  const explicit = cleanString(input.risk_tier || input.riskTier).toUpperCase();
  if (STORY_TIERS.has(explicit)) return { tier: explicit, score: null, reasons: ["explicit"] };
  const tags = cleanStringArray(input.risk_tags || input.riskTags).map((tag) => tag.toLowerCase());
  const critical = tags.filter((tag) => CRITICAL_TAGS.has(tag));
  if (critical.length) return { tier: "STORY-CRITICAL", score: null, reasons: critical };

  const profile = input.risk_profile || input.riskProfile || {};
  const blast = { local: 0, module: 1, cross_module: 2, multi_product_or_sdk: 3 }[profile.blast_radius] ?? 1;
  const data = { none: 0, local_state: 1, persistent_or_shared: 2, sensitive_or_irreversible: 3 }[profile.state_and_data] ?? 0;
  const runtime = { deterministic: 0, environment_dependent: 1, device_or_external_system: 2 }[profile.runtime_uncertainty] ?? 0;
  const reproduce = { stable: 0, intermittent: 1, not_reproduced: 2 }[profile.reproducibility] ?? 0;
  const coverage = { strong_existing_tests: 0, partial: 1, weak_or_none: 2 }[profile.coverage_gap] ?? 1;
  const score = blast + data + runtime + reproduce + coverage;
  const tier = score <= 2 ? "STORY-FAST" : score <= 6 ? "STORY-STANDARD" : "STORY-CRITICAL";
  return { tier, score, reasons: [`score:${score}`] };
}

export function classifyProjectMode(input = {}) {
  const explicit = cleanString(input.mode).toUpperCase();
  if (PROJECT_MODES.has(explicit)) return explicit;
  if (input.productionRelease === true || input.production_release === true) return "PROJECT-RELEASE";
  if (input.developmentCheck === true || input.development_check === true) return "PROJECT-QUICK";
  return "PROJECT-STANDARD";
}

export function routeAcceptance(input = {}) {
  const storyPointId = cleanString(input.story_point_id || input.storyPointId);
  const projectTaskId = cleanString(input.project_task_id || input.projectTaskId) || null;
  const sourceRefs = Array.isArray(input.source_refs || input.sourceRefs) ? (input.source_refs || input.sourceRefs) : [];
  const externalIssueRef = cleanString(input.external_issue_ref || input.externalIssueRef);
  const sourceSnapshotHash = cleanString(input.source_snapshot_hash || input.sourceSnapshotHash);
  const projectPaths = cleanStringArray(input.project_paths || input.projectPaths);
  const harnessPaths = cleanStringArray(input.harness_paths || input.harnessPaths);
  const storyTargetPaths = cleanStringArray(input.story_target_paths || input.storyTargetPaths);
  const targetRepositories = cleanStringArray(input.target_repositories || input.targetRepositories);
  const changeType = normalizeChangeType(input.change_type || input.changeType);
  const directProjectTask = input.direct_project_task ?? input.directProjectTask;
  const hasExternalOnly = Boolean(sourceRefs.length || externalIssueRef) && !storyPointId;
  const direct = directProjectTask === true || (!hasExternalOnly && directProjectTask !== false);
  const routingEvidence = [];
  const routingUnknowns = [];

  if (!storyPointId) {
    if (!direct) {
      return {
        protocol_version: ACCEPTANCE_PROTOCOL_VERSION,
        route_status: "BLOCKED_ROUTING",
        required_action: "normalize_to_internal_story_point",
        task_origin: null,
        scope_kind: null,
        protocols: [],
        change_type: changeType,
        risk_tier: null,
        project_task_id: projectTaskId,
        story_point_id: null,
        source_snapshot_hash: null,
        source_refs: sourceRefs,
        target_repositories: targetRepositories,
        project_paths: projectPaths,
        story_target_paths: storyTargetPaths,
        harness_paths: harnessPaths,
        unrelated_paths: cleanStringArray(input.unrelated_paths || input.unrelatedPaths),
        routing_evidence: ["external issue exists without an internal story_point_id"],
        routing_unknowns: ["immutable source snapshot is unavailable"],
      };
    }
    routingEvidence.push("no runtime story_point_id; direct project task selected");
    return {
      protocol_version: ACCEPTANCE_PROTOCOL_VERSION,
      route_status: "ROUTED",
      task_origin: "DIRECT_ENGINEERING",
      scope_kind: "PROJECT_ENGINEERING",
      protocols: ["project-engineering-acceptance"],
      change_type: changeType,
      risk_tier: classifyProjectMode(input),
      project_task_id: projectTaskId,
      story_point_id: null,
      source_snapshot_hash: null,
      source_refs: sourceRefs,
      target_repositories: targetRepositories,
      project_paths: projectPaths,
      story_target_paths: [],
      harness_paths: harnessPaths,
      unrelated_paths: cleanStringArray(input.unrelated_paths || input.unrelatedPaths),
      routing_evidence: routingEvidence,
      routing_unknowns: routingUnknowns,
    };
  }

  const storyTargetKind = cleanString(input.story_target_kind || input.storyTargetKind).toLowerCase();
  const hasProjectScope = projectPaths.length > 0 || harnessPaths.length > 0 || input.project_or_harness_changed === true || input.projectOrHarnessChanged === true;
  const hasStoryScope = storyTargetPaths.length > 0 || input.story_target_changed === true || input.storyTargetChanged === true;
  const dualScope = storyTargetKind === "platform_project" || (hasProjectScope && hasStoryScope);
  if (!sourceSnapshotHash) routingUnknowns.push("immutable source_snapshot_hash is required before story assurance");
  routingEvidence.push(`stable story_point_id=${storyPointId}`);
  if (dualScope) routingEvidence.push("project/harness and story target scopes both changed");
  const risk = classifyStoryRisk(input);
  return {
    protocol_version: ACCEPTANCE_PROTOCOL_VERSION,
    route_status: sourceSnapshotHash ? "ROUTED" : "BLOCKED_ROUTING",
    required_action: sourceSnapshotHash ? null : "freeze_immutable_source_snapshot",
    task_origin: "RUNTIME_STORY_POINT",
    scope_kind: dualScope ? "DUAL_SCOPE" : "STORY_DELIVERY",
    protocols: dualScope
      ? ["runtime-story-point-assurance", "project-engineering-acceptance"]
      : ["runtime-story-point-assurance"],
    change_type: changeType,
    risk_tier: risk.tier,
    project_task_id: projectTaskId,
    story_point_id: storyPointId,
    source_snapshot_hash: sourceSnapshotHash || null,
    source_refs: sourceRefs,
    target_repositories: targetRepositories,
    project_paths: projectPaths,
    story_target_paths: storyTargetPaths,
    harness_paths: harnessPaths,
    unrelated_paths: cleanStringArray(input.unrelated_paths || input.unrelatedPaths),
    routing_evidence: routingEvidence,
    routing_unknowns: routingUnknowns,
  };
}

const PROJECT_GATE_DEFINITIONS = Object.freeze({
  P0: { id: "P0_SCOPE", dependsOn: [], inputKeys: ["candidate", "scope", "protocol"] },
  P1: { id: "P1_STATIC", dependsOn: ["P0_SCOPE"], inputKeys: ["candidate", "dependency", "config"] },
  P2: { id: "P2_UNIT", dependsOn: ["P1_STATIC"], inputKeys: ["candidate", "dependency", "config"] },
  P3: { id: "P3_INTEGRATION_CONTRACT", dependsOn: ["P2_UNIT"], inputKeys: ["candidate", "dependency", "config", "environment"] },
  P4: { id: "P4_BUILD", dependsOn: ["P3_INTEGRATION_CONTRACT"], inputKeys: ["candidate", "dependency", "config", "artifact"] },
  P5: { id: "P5_ENGINEERING_E2E", dependsOn: ["P4_BUILD"], inputKeys: ["candidate", "artifact", "environment"] },
  P6: { id: "P6_DEPLOY_RESILIENCE_SECURITY", dependsOn: ["P5_ENGINEERING_E2E"], inputKeys: ["candidate", "artifact", "environment", "deployment"] },
  P7: { id: "P7_GOLDEN_REPLAY", dependsOn: ["P6_DEPLOY_RESILIENCE_SECURITY"], inputKeys: ["candidate", "artifact", "environment", "golden"] },
  P8: { id: "P8_INDEPENDENT_REVIEW", dependsOn: ["P7_GOLDEN_REPLAY"], inputKeys: ["candidate", "artifact", "environment", "reviewer"] },
});

const STORY_GATE_DEFINITIONS = Object.freeze({
  S0: { id: "S0_SOURCE_FACTS", dependsOn: [], inputKeys: ["source", "protocol"] },
  S1: { id: "S1_CANDIDATE", dependsOn: ["S0_SOURCE_FACTS"], inputKeys: ["candidate", "source", "environment"] },
  S2: { id: "S2_CHANGE_TYPE_EVIDENCE", dependsOn: ["S1_CANDIDATE"], inputKeys: ["candidate", "source", "changeType"] },
  S3: { id: "S3_IMPACT_MATRIX", dependsOn: ["S2_CHANGE_TYPE_EVIDENCE"], inputKeys: ["candidate", "source", "environment", "impact"] },
  S4: { id: "S4_TARGET_BUILD", dependsOn: ["S3_IMPACT_MATRIX"], inputKeys: ["candidate", "dependency", "config", "artifact"] },
  S5: { id: "S5_RUNTIME_SMOKE", dependsOn: ["S4_TARGET_BUILD"], inputKeys: ["candidate", "source", "artifact", "environment"] },
  S6: { id: "S6_READONLY_REVIEW", dependsOn: ["S5_RUNTIME_SMOKE"], inputKeys: ["candidate", "source", "artifact", "environment", "reviewer"] },
  S7: { id: "S7_CRITICAL_RERUN_ROLLBACK", dependsOn: ["S6_READONLY_REVIEW"], inputKeys: ["candidate", "source", "artifact", "environment", "deployment", "reviewer"] },
});

export function buildGatePlan({ protocol, mode, riskTier, changeType } = {}) {
  const normalizedChangeType = normalizeChangeType(changeType);
  const evidenceRequirements = evidenceRequirementsForChangeType(normalizedChangeType);
  if (protocol === "PROJECT_ENGINEERING") {
    const projectMode = classifyProjectMode({ mode });
    const keys = projectMode === "PROJECT-QUICK"
      ? ["P0", "P1", "P2"]
      : projectMode === "PROJECT-RELEASE"
        ? ["P0", "P1", "P2", "P3", "P4", "P5", "P6", "P7", "P8"]
        : ["P0", "P1", "P2", "P3", "P4", "P5"];
    return keys.map((key) => ({
      ...PROJECT_GATE_DEFINITIONS[key],
      required: true,
      changeType: normalizedChangeType,
      ...(key === (projectMode === "PROJECT-QUICK" ? "P2" : "P3") ? { evidenceRequirements } : {}),
    }));
  }
  if (protocol === "RUNTIME_STORY_POINT") {
    const tier = STORY_TIERS.has(cleanString(riskTier).toUpperCase()) ? cleanString(riskTier).toUpperCase() : "STORY-STANDARD";
    const keys = tier === "STORY-FAST"
      ? ["S0", "S1", "S2", "S3", "S5"]
      : tier === "STORY-CRITICAL"
        ? ["S0", "S1", "S2", "S3", "S4", "S5", "S6", "S7"]
        : ["S0", "S1", "S2", "S3", "S4", "S5", "S6"];
    return keys.map((key) => ({
      ...STORY_GATE_DEFINITIONS[key],
      ...(tier === "STORY-FAST" && key === "S5" ? { dependsOn: ["S3_IMPACT_MATRIX"] } : {}),
      required: true,
      changeType: normalizedChangeType,
      ...(key === "S2" ? { evidenceRequirements } : {}),
    }));
  }
  throw new TypeError(`unsupported protocol: ${protocol}`);
}

export function emptyImpactMatrix() {
  return Object.fromEntries(IMPACT_DIMENSIONS.map((dimension) => [dimension, { status: "UNKNOWN", basis: "" }]));
}

export function normalizeImpactMatrix(value = {}) {
  return Object.fromEntries(IMPACT_DIMENSIONS.map((dimension) => {
    const entry = value[dimension] || {};
    const status = cleanString(entry.status).toUpperCase();
    const basis = cleanString(entry.basis);
    const normalizedStatus = IMPACT_RESULTS.has(status) ? status : "UNKNOWN";
    return [dimension, {
      status: ["PASS", "NOT_APPLICABLE"].includes(normalizedStatus) && !basis ? "UNKNOWN" : normalizedStatus,
      basis,
    }];
  }));
}

export function normalizeClaims(value = []) {
  return (Array.isArray(value) ? value : []).map((claim, index) => {
    const type = cleanString(claim.type).toUpperCase();
    const evidenceIds = cleanStringArray(claim.evidence_ids || claim.evidenceIds);
    const basis = cleanString(claim.basis);
    const verificationMethod = cleanString(claim.verification_method || claim.verificationMethod);
    const normalizedType = CLAIM_TYPES.has(type) ? type : "UNKNOWN";
    const supported = normalizedType === "FACT"
      ? evidenceIds.length > 0
      : normalizedType === "INFERENCE"
        ? evidenceIds.length > 0 && Boolean(basis) && Boolean(verificationMethod)
        : normalizedType === "UNKNOWN";
    return {
      id: cleanString(claim.id) || `C-${String(index + 1).padStart(3, "0")}`,
      type: supported ? normalizedType : "UNKNOWN",
      statement: cleanString(claim.statement) || "Unspecified claim",
      evidence_ids: evidenceIds,
      ...(basis ? { basis } : {}),
      ...(verificationMethod ? { verification_method: verificationMethod } : {}),
    };
  });
}

export function normalizeGateResults(plan = [], results = []) {
  const byId = new Map((Array.isArray(results) ? results : []).map((result) => [cleanString(result.id), result]));
  return plan.map((gate) => {
    const source = byId.get(gate.id) || {};
    const result = cleanString(source.result).toUpperCase();
    const evidenceIds = cleanStringArray(source.evidence_ids || source.evidenceIds);
    const normalizedResult = GATE_RESULTS.has(result) ? result : "PENDING";
    return {
      ...gate,
      result: normalizedResult === "PASS" && !evidenceIds.length ? "PENDING" : normalizedResult,
      evidence_ids: evidenceIds,
      evidence: cleanString(source.evidence),
      input_hash: cleanString(source.input_hash || source.inputHash) || null,
    };
  });
}

function blockingFindings(findings = []) {
  return (Array.isArray(findings) ? findings : []).filter((finding) => finding?.blocking === true);
}

function hasGateFailure(gates) {
  return gates.some((gate) => gate.required && ["FAIL", "BLOCKED"].includes(gate.result));
}

function hasIncompleteGate(gates) {
  return gates.some((gate) => gate.required && gate.result !== "PASS");
}

export function evaluateProjectAcceptance(input = {}) {
  const mode = classifyProjectMode(input);
  const plan = buildGatePlan({ protocol: "PROJECT_ENGINEERING", mode, changeType: input.change_type || input.changeType });
  const gates = normalizeGateResults(plan, input.gates);
  const findings = Array.isArray(input.findings) ? input.findings : [];
  const blockers = blockingFindings(findings);
  const unknowns = cleanStringArray(input.unknowns);
  const routeBlocked = input.route_status === "BLOCKED_ROUTING" || input.routeStatus === "BLOCKED_ROUTING";
  let projectChangeDecision = "NOT_ASSESSED";
  if (mode !== "PROJECT-QUICK") {
    if (routeBlocked || blockers.length || hasGateFailure(gates)) projectChangeDecision = "REJECTED";
    else if (unknowns.length || hasIncompleteGate(gates)) projectChangeDecision = "PARTIAL";
    else projectChangeDecision = "ACCEPTED";
  }
  let productionReadiness = "NOT_ASSESSED";
  if (mode === "PROJECT-RELEASE") {
    productionReadiness = projectChangeDecision === "ACCEPTED" ? "READY" : "NOT_READY";
  }
  return {
    protocol: "PROJECT_ENGINEERING",
    protocol_version: ACCEPTANCE_PROTOCOL_VERSION,
    mode,
    change_type: normalizeChangeType(input.change_type || input.changeType),
    gates,
    blocking_findings: blockers,
    non_blocking_findings: findings.filter((finding) => finding?.blocking !== true),
    unknowns,
    residual_risks: cleanStringArray(input.residual_risks || input.residualRisks),
    repair_rounds: Math.min(2, Math.max(0, Number(input.repair_rounds ?? input.repairRounds) || 0)),
    project_change_decision: projectChangeDecision,
    production_readiness: productionReadiness,
  };
}

export function evaluateStoryAcceptance(input = {}) {
  const risk = classifyStoryRisk(input);
  const plan = buildGatePlan({ protocol: "RUNTIME_STORY_POINT", riskTier: risk.tier, changeType: input.change_type || input.changeType });
  const gates = normalizeGateResults(plan, input.gates);
  const findings = Array.isArray(input.findings) ? input.findings : [];
  const blockers = blockingFindings(findings);
  const normalizedClaims = normalizeClaims(input.claims);
  const claims = normalizedClaims.length ? normalizedClaims : [{
    id: "C-001",
    type: "UNKNOWN",
    statement: "Claim ledger is empty",
    evidence_ids: [],
  }];
  const impactMatrix = normalizeImpactMatrix(input.impact_matrix || input.impactMatrix);
  const unknownClaims = claims.filter((claim) => claim.type === "UNKNOWN");
  const unknownImpact = Object.entries(impactMatrix).filter(([, entry]) => entry.status === "UNKNOWN");
  const routeBlocked = input.route_status === "BLOCKED_ROUTING" || input.routeStatus === "BLOCKED_ROUTING";
  const candidateConsistent = input.candidate_consistent ?? input.candidateConsistent;
  let storyPointDecision;
  if (routeBlocked || blockers.length || hasGateFailure(gates)) storyPointDecision = "BLOCKED";
  else if (candidateConsistent === false || hasIncompleteGate(gates) || unknownClaims.length || unknownImpact.length) storyPointDecision = "PARTIAL";
  else storyPointDecision = "VERIFIED";
  const sourceSyncDecision = storyPointDecision === "VERIFIED"
    ? "ALLOWED"
    : storyPointDecision === "PARTIAL" ? "MANUAL_APPROVAL" : "DENIED";
  const requestedSyncStatus = cleanString(input.source_sync_status || input.sourceSyncStatus).toUpperCase();
  const sourceSyncStatus = ["NOT_ATTEMPTED", "SUCCEEDED", "FAILED", "PARTIAL"].includes(requestedSyncStatus)
    ? requestedSyncStatus : "NOT_ATTEMPTED";
  return {
    protocol: "RUNTIME_STORY_POINT",
    protocol_version: ACCEPTANCE_PROTOCOL_VERSION,
    change_type: normalizeChangeType(input.change_type || input.changeType),
    risk_tier: risk.tier,
    gates,
    claims,
    impact_matrix: impactMatrix,
    blocking_findings: blockers,
    non_blocking_findings: findings.filter((finding) => finding?.blocking !== true),
    residual_risks: cleanStringArray(input.residual_risks || input.residualRisks),
    repair_rounds: Math.min(2, Math.max(0, Number(input.repair_rounds ?? input.repairRounds) || 0)),
    story_point_decision: storyPointDecision,
    source_sync_decision: sourceSyncDecision,
    source_sync_status: sourceSyncStatus,
  };
}

export function computeGateInputHash(gate, inputs = {}) {
  const selected = Object.fromEntries((gate.inputKeys || []).map((key) => [key, inputs[key] ?? null]));
  return sha256({ protocol_version: ACCEPTANCE_PROTOCOL_VERSION, gate: gate.id, inputs: selected });
}

export function planGateInvalidation(plan = [], previousInputs = {}, nextInputs = {}) {
  const invalidated = [];
  const reusable = [];
  for (const gate of plan) {
    const previousHash = computeGateInputHash(gate, previousInputs);
    const nextHash = computeGateInputHash(gate, nextInputs);
    (previousHash === nextHash ? reusable : invalidated).push({
      gate_id: gate.id,
      previous_input_hash: previousHash,
      next_input_hash: nextHash,
    });
  }
  return { invalidated, reusable };
}

export function mapLegacyAcceptance(value = {}) {
  const legacy = cleanString(value.acceptance_status || value.acceptanceStatus || value.status).toUpperCase();
  const objectKind = cleanString(value.object_kind || value.objectKind).toUpperCase();
  if (legacy !== "PASS") {
    return {
      project_change_decision: objectKind === "PROJECT" ? "REJECTED" : "NOT_ASSESSED",
      production_readiness: "NOT_ASSESSED",
      story_point_decision: objectKind === "STORY" ? "BLOCKED" : "NOT_APPLICABLE",
      source_sync_status: "NOT_ATTEMPTED",
      migration_confidence: objectKind ? "MEDIUM" : "LOW",
    };
  }
  if (objectKind === "PROJECT") {
    return {
      project_change_decision: "ACCEPTED",
      production_readiness: "NOT_ASSESSED",
      story_point_decision: "NOT_APPLICABLE",
      source_sync_status: "NOT_ATTEMPTED",
      migration_confidence: "MEDIUM",
    };
  }
  if (objectKind === "STORY") {
    return {
      project_change_decision: "NOT_ASSESSED",
      production_readiness: "NOT_ASSESSED",
      story_point_decision: "PARTIAL",
      source_sync_status: "NOT_ATTEMPTED",
      migration_confidence: "LOW",
    };
  }
  return {
    project_change_decision: "PARTIAL",
    production_readiness: "NOT_ASSESSED",
    story_point_decision: "PARTIAL",
    source_sync_status: "NOT_ATTEMPTED",
    migration_confidence: "LOW",
  };
}
