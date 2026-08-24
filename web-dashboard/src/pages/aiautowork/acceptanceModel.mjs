const UNKNOWN = "UNKNOWN";

export const ACCEPTANCE_STATUS_CARDS = Object.freeze([
  { key: "projectChange", label: "Project Change", description: "工程改动交付结论" },
  { key: "productionReadiness", label: "Production Readiness", description: "生产发布就绪结论" },
  { key: "storyPoint", label: "Story Point Decision", description: "故事点交付技术结论" },
  { key: "sourceSync", label: "Source Sync Status", description: "来源回写状态（独立副作用）" },
]);

function object(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function text(value) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function valueAt(source, paths, fallback = UNKNOWN) {
  for (const path of paths) {
    let value = source;
    for (const part of path) value = object(value)[part];
    if (text(value)) return text(value);
  }
  return fallback;
}

function arrayAt(source, paths) {
  for (const path of paths) {
    let value = source;
    for (const part of path) value = object(value)[part];
    if (Array.isArray(value)) return value;
  }
  return [];
}

function numberAt(source, paths, fallback = 0) {
  for (const path of paths) {
    let value = source;
    for (const part of path) value = object(value)[part];
    if (Number.isFinite(Number(value))) return Number(value);
  }
  return fallback;
}

function normalizeFinding(finding, fallbackOwnership = UNKNOWN) {
  const item = object(finding);
  return {
    id: valueAt(item, [["id"], ["code"]], "未命名 Finding"),
    severity: valueAt(item, [["severity"]]),
    ownership: valueAt(item, [["ownership"], ["owner"]], fallbackOwnership),
    blocking: item.blocking === true,
    behavior: valueAt(item, [["behavior"], ["message"], ["summary"]], "未提供说明"),
    evidence: arrayAt(item, [["evidence"], ["evidence_ids"], ["evidenceIds"]]),
    invalidatedGates: arrayAt(item, [["invalidated_gates"], ["invalidatedGates"]]),
  };
}

function normalizeTrackDiagnostics(result, findings = []) {
  const track = object(result);
  const gates = arrayAt(track, [["gates"], ["result", "gates"]]);
  const claims = arrayAt(track, [["claims"], ["result", "claims"]]);
  const explicitInvalidated = arrayAt(track, [["invalidated_gates"], ["invalidatedGates"]]);
  const reasons = arrayAt(track, [["candidate_consistency_reasons"], ["candidateConsistencyReasons"]]);
  const sourceSuperseded = reasons.some((reason) => text(reason).startsWith("SOURCE_SNAPSHOT_SUPERSEDED:"));
  const invalidatedGates = [...new Set([
    ...explicitInvalidated,
    ...findings.flatMap((finding) => finding.invalidatedGates),
    ...(sourceSuperseded ? gates.map((gate) => valueAt(gate, [["id"]], "")).filter(Boolean) : []),
  ])];
  const evidenceIds = [...new Set([
    ...gates.flatMap((gate) => arrayAt(gate, [["evidence_ids"], ["evidenceIds"]])),
    ...claims.flatMap((claim) => arrayAt(claim, [["evidence_ids"], ["evidenceIds"]])),
    ...findings.flatMap((finding) => finding.evidence),
  ].filter((value) => text(value)))];
  return {
    repairRounds: numberAt(track, [["repair_rounds"], ["repairRounds"]]),
    gateTotal: gates.length,
    gatesWithEvidence: gates.filter((gate) => arrayAt(gate, [["evidence_ids"], ["evidenceIds"]]).length > 0).length,
    evidenceIds,
    invalidatedGates,
  };
}

function collectUnknowns(run, project, story) {
  const values = new Set();
  for (const source of [run, project, story]) {
    for (const item of arrayAt(source, [["unknowns"], ["routing_unknowns"]])) {
      if (text(item)) values.add(text(item));
    }
  }
  for (const claim of arrayAt(story, [["claims"], ["result", "claims"]])) {
    if (valueAt(claim, [["type"]]) === UNKNOWN) values.add(valueAt(claim, [["statement"]], "存在未证实声明"));
  }
  for (const [dimension, item] of Object.entries(object(story.impact_matrix || story.impactMatrix))) {
    if (valueAt(item, [["status"]]) === UNKNOWN) values.add(`影响矩阵 ${dimension} 为 UNKNOWN`);
  }
  return [...values];
}

function normalizeConsistency(run, project, story) {
  const raw = object(run.candidate_evidence_consistency || run.candidateEvidenceConsistency);
  const projectValue = raw.project
    ?? project.candidate_evidence_consistent
    ?? project.candidateEvidenceConsistent
    ?? project.candidate_consistent
    ?? project.candidateConsistent;
  const storyValue = raw.story
    ?? story.candidate_evidence_consistent
    ?? story.candidateEvidenceConsistent
    ?? story.candidate_consistent
    ?? story.candidateConsistent;
  const overallValue = raw.overall
    ?? raw.consistent
    ?? run.candidate_evidence_consistent
    ?? run.candidateEvidenceConsistent
    ?? run.candidate_consistent
    ?? run.candidateConsistent;
  const state = (value) => value === true ? "CONSISTENT" : value === false ? "INCONSISTENT" : UNKNOWN;
  return {
    overall: state(overallValue),
    project: state(projectValue),
    story: state(storyValue),
    reasons: [
      ...arrayAt(raw, [["reasons"], ["issues"]]),
      ...arrayAt(run, [["candidate_consistency_reasons"], ["candidateConsistencyReasons"]]),
    ],
  };
}

function normalizeSources(run, routing, story) {
  return arrayAt(run, [["sources"], ["source_refs"], ["sourceRefs"]])
    .concat(arrayAt(routing, [["sources"], ["source_refs"], ["sourceRefs"]]))
    .concat(arrayAt(story, [["sources"]]))
    .map((source) => {
      const item = object(source);
      return {
        system: valueAt(item, [["system"]]),
        issueId: valueAt(item, [["issue_id"], ["issueId"]]),
        snapshotHash: valueAt(item, [["snapshot_hash"], ["snapshotHash"]]),
      };
    })
    .filter((source, index, items) => source.system !== UNKNOWN || source.issueId !== UNKNOWN)
    .filter((source, index, items) => items.findIndex((item) => item.system === source.system && item.issueId === source.issueId) === index);
}

function normalizeCandidates(project, story) {
  const candidatesOf = (result, paths) => {
    const direct = arrayAt(result, paths);
    if (direct.length) return direct;
    const candidate = object(result.candidate || result.project_candidate || result.projectCandidate);
    if (Array.isArray(candidate.candidates)) return candidate.candidates;
    return Object.keys(candidate).length ? [candidate] : [];
  };
  return {
    project: candidatesOf(project, [["candidates"], ["project_candidates"], ["projectCandidates"]]),
    story: candidatesOf(story, [["candidates"], ["story_candidates"], ["storyCandidates"]]),
  };
}

export function normalizeAcceptanceRun(input = {}) {
  const run = object(input);
  const routing = object(run.routing || run.context || run.acceptance_context || run.acceptanceContext);
  const protocol = valueAt(run, [["protocol"]]);
  const project = protocol === "PROJECT_ENGINEERING"
    ? run
    : object(run.project || run.project_result || run.projectResult || run.project_acceptance || run.projectAcceptance);
  const story = protocol === "RUNTIME_STORY_POINT"
    ? run
    : object(run.story || run.story_result || run.storyResult || run.story_assurance || run.storyAssurance);
  const projectDecision = object(project.decision || run.project_decision || run.projectDecision);
  const storyDecision = object(story.decision || run.story_decision || run.storyDecision);
  const findings = [
    ...arrayAt(run, [["findings"]]),
    ...(project === run ? [] : arrayAt(project, [["findings"], ["blocking_findings"], ["blockingFindings"]])),
    ...(story === run ? [] : arrayAt(story, [["findings"], ["blocking_findings"], ["blockingFindings"]])),
  ].map((finding) => normalizeFinding(finding));
  const projectFindings = findings.filter((finding) => project === run || finding.ownership !== "STORY_DELIVERY");
  const storyFindings = findings.filter((finding) => story === run || finding.ownership !== "PROJECT_ENGINEERING");
  const scopeKind = valueAt(run, [["scope_kind"], ["scopeKind"]], valueAt(routing, [["scope_kind"], ["scopeKind"]]));
  const sources = normalizeSources(run, routing, story);
  const statuses = {
    projectChange: valueAt(project, [["project_change_decision"], ["projectChangeDecision"]], valueAt(projectDecision, [["project_change"], ["projectChange"]])),
    productionReadiness: valueAt(project, [["production_readiness"], ["productionReadiness"]], valueAt(projectDecision, [["production_readiness"], ["productionReadiness"]])),
    storyPoint: valueAt(story, [["story_point_decision"], ["storyPointDecision"]], valueAt(storyDecision, [["story_point"], ["storyPoint"]])),
    sourceSync: valueAt(story, [["source_sync_status"], ["sourceSyncStatus"]], valueAt(storyDecision, [["source_sync_status"], ["sourceSyncStatus"]])),
  };
  return {
    id: valueAt(run, [["id"], ["run_id"], ["runId"]], "未命名验收运行"),
    title: valueAt(run, [["title"], ["name"]], valueAt(story, [["title"]], valueAt(project, [["title"]], "未命名验收"))),
    createdAt: valueAt(run, [["created_at"], ["createdAt"], ["started_at"], ["startedAt"]], "—"),
    updatedAt: valueAt(run, [["updated_at"], ["updatedAt"], ["completed_at"], ["completedAt"]], "—"),
    route: {
      taskOrigin: valueAt(run, [["task_origin"], ["taskOrigin"]], valueAt(routing, [["task_origin"], ["taskOrigin"]])),
      scopeKind,
      protocols: arrayAt(run, [["protocols"]]).concat(arrayAt(routing, [["protocols"]])),
      changeType: valueAt(run, [["change_type"], ["changeType"]], valueAt(routing, [["change_type"], ["changeType"]])),
      riskTier: valueAt(run, [["risk_tier"], ["riskTier"]], valueAt(routing, [["risk_tier"], ["riskTier"]])),
      projectTaskId: valueAt(run, [["project_task_id"], ["projectTaskId"]], valueAt(routing, [["project_task_id"], ["projectTaskId"]], valueAt(project, [["project_task_id"], ["projectTaskId"]]))),
      storyPointId: valueAt(run, [["story_point_id"], ["storyPointId"]], valueAt(routing, [["story_point_id"], ["storyPointId"]], valueAt(story, [["story_point_id"], ["storyPointId"]]))),
      targetRepositories: arrayAt(run, [["target_repositories"], ["targetRepositories"]]).concat(arrayAt(routing, [["target_repositories"], ["targetRepositories"]])),
      sources,
    },
    statuses,
    sourceSyncDecision: valueAt(story, [["source_sync_decision"], ["sourceSyncDecision"]], valueAt(storyDecision, [["source_sync_decision"], ["sourceSyncDecision"]])),
    isDualScope: scopeKind === "DUAL_SCOPE",
    unknowns: collectUnknowns(run, project, story),
    findings,
    blockingFindings: findings.filter((finding) => finding.blocking),
    candidates: normalizeCandidates(project, story),
    consistency: normalizeConsistency(run, project, story),
    diagnostics: {
      project: normalizeTrackDiagnostics(project, projectFindings),
      story: normalizeTrackDiagnostics(story, storyFindings),
    },
  };
}

export function normalizeAcceptanceRuns(payload) {
  const raw = Array.isArray(payload)
    ? payload
    : arrayAt(object(payload), [["items"], ["runs"], ["data", "items"], ["data", "runs"]]);
  const consumed = new Set();
  const combined = [];
  for (const [index, run] of raw.entries()) {
    if (consumed.has(index)) continue;
    const groupId = valueAt(run, [["track_group_id"], ["trackGroupId"]], "");
    if (!groupId) continue;
    const group = raw
      .map((item, itemIndex) => ({ item, itemIndex }))
      .filter(({ item }) => valueAt(item, [["track_group_id"], ["trackGroupId"]], "") === groupId);
    const projectTrack = group.find(({ item }) => valueAt(item, [["protocol"]]) === "PROJECT_ENGINEERING");
    const storyTrack = group.find(({ item }) => valueAt(item, [["protocol"]]) === "RUNTIME_STORY_POINT");
    if (!projectTrack || !storyTrack) continue;
    group.forEach(({ itemIndex }) => consumed.add(itemIndex));
    const projectConsistent = projectTrack.item.candidate_evidence_consistent ?? projectTrack.item.candidateEvidenceConsistent;
    const storyConsistent = storyTrack.item.candidate_evidence_consistent ?? storyTrack.item.candidateEvidenceConsistent;
    const overallConsistent = projectConsistent === false || storyConsistent === false
      ? false
      : projectConsistent === true && storyConsistent === true ? true : null;
    combined.push({
      id: groupId,
      title: `DUAL_SCOPE ${groupId}`,
      createdAt: projectTrack.item.createdAt || projectTrack.item.created_at || storyTrack.item.createdAt || storyTrack.item.created_at,
      updatedAt: storyTrack.item.updatedAt || storyTrack.item.updated_at || projectTrack.item.updatedAt || projectTrack.item.updated_at,
      routing: {
        ...object(storyTrack.item.routing),
        scope_kind: "DUAL_SCOPE",
        protocols: ["project-engineering-acceptance", "runtime-story-point-assurance"],
      },
      project: projectTrack.item,
      story: storyTrack.item,
      candidate_evidence_consistency: {
        overall: overallConsistent,
        project: projectConsistent,
        story: storyConsistent,
        reasons: [
          ...arrayAt(projectTrack.item, [["candidate_consistency_reasons"], ["candidateConsistencyReasons"]]),
          ...arrayAt(storyTrack.item, [["candidate_consistency_reasons"], ["candidateConsistencyReasons"]]),
        ],
      },
    });
  }
  return [
    ...combined.map((run) => normalizeAcceptanceRun(run)),
    ...raw.filter((_, index) => !consumed.has(index)).map((run) => normalizeAcceptanceRun(run)),
  ];
}

export function statusTone(status) {
  if (["ACCEPTED", "READY", "VERIFIED", "SUCCEEDED"].includes(status)) return "success";
  if (["PARTIAL", "NOT_ASSESSED", "NOT_ATTEMPTED", "MANUAL_APPROVAL"].includes(status)) return "warning";
  if (["REJECTED", "NOT_READY", "BLOCKED", "FAILED", "DENIED", "INCONSISTENT"].includes(status)) return "danger";
  return "unknown";
}
