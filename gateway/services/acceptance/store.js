import { randomUUID } from "node:crypto";
import db from "../../db/sqlite.js";
import { sha256, stableStringify } from "./core.js";

function id(prefix) {
  return `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 20)}`;
}

function parseJson(value, fallback) {
  if (value === null || value === undefined || value === "") return fallback;
  if (typeof value !== "string") return value;
  try { return JSON.parse(value); } catch { return fallback; }
}

function toCamel(row) {
  if (!row) return null;
  return Object.fromEntries(Object.entries(row).map(([key, value]) => [
    key.replace(/_([a-z])/g, (_, char) => char.toUpperCase()),
    value,
  ]));
}

function parseContextRow(row) {
  const out = toCamel(row);
  if (!out) return null;
  out.routing = parseJson(out.routingJson, {});
  delete out.routingJson;
  return out;
}

function parseRunRow(row) {
  const out = toCamel(row);
  if (!out) return null;
  for (const [column, target, fallback] of [
    ["candidateJson", "candidate", {}],
    ["gatesJson", "gates", []],
    ["claimsJson", "claims", []],
    ["impactMatrixJson", "impactMatrix", {}],
    ["findingsJson", "findings", []],
    ["unknownsJson", "unknowns", []],
    ["residualRisksJson", "residualRisks", []],
    ["candidateConsistencyReasonsJson", "candidateConsistencyReasons", []],
  ]) {
    out[target] = parseJson(out[column], fallback);
    delete out[column];
  }
  if (out.candidateEvidenceConsistent !== null && out.candidateEvidenceConsistent !== undefined) {
    out.candidateEvidenceConsistent = out.candidateEvidenceConsistent === 1;
  }
  return out;
}

function parseSnapshotRow(row) {
  const out = toCamel(row);
  if (!out) return null;
  out.canonical = parseJson(out.canonicalJson, {});
  delete out.canonicalJson;
  return out;
}

export function saveAcceptanceContext(route = {}) {
  const contextKey = sha256({
    protocol_version: route.protocol_version,
    route_status: route.route_status,
    task_origin: route.task_origin,
    scope_kind: route.scope_kind,
    project_task_id: route.project_task_id,
    story_point_id: route.story_point_id,
    source_snapshot_hash: route.source_snapshot_hash || null,
    target_repositories: route.target_repositories || [],
    project_paths: route.project_paths || [],
    story_target_paths: route.story_target_paths || [],
    harness_paths: route.harness_paths || [],
  });
  const existing = db.prepare("SELECT * FROM acceptance_contexts WHERE context_key = ?").get(contextKey);
  const now = new Date().toISOString();
  if (existing) {
    db.prepare(`
      UPDATE acceptance_contexts
      SET route_status=@routeStatus, risk_tier=@riskTier, routing_json=@routingJson, updated_at=@now
      WHERE context_key=@contextKey
    `).run({
      contextKey,
      routeStatus: route.route_status || "BLOCKED_ROUTING",
      riskTier: route.risk_tier || null,
      routingJson: stableStringify(route),
      now,
    });
    return getAcceptanceContext(existing.id);
  }
  const contextId = id("acx");
  db.prepare(`
    INSERT INTO acceptance_contexts (
      id, context_key, protocol_version, route_status, task_origin, scope_kind,
      change_type, risk_tier, project_task_id, story_point_id, source_snapshot_hash,
      routing_json, created_at, updated_at
    ) VALUES (
      @id, @contextKey, @protocolVersion, @routeStatus, @taskOrigin, @scopeKind,
      @changeType, @riskTier, @projectTaskId, @storyPointId, @sourceSnapshotHash,
      @routingJson, @now, @now
    )
  `).run({
    id: contextId,
    contextKey,
    protocolVersion: route.protocol_version || "4.1",
    routeStatus: route.route_status || "BLOCKED_ROUTING",
    taskOrigin: route.task_origin || null,
    scopeKind: route.scope_kind || null,
    changeType: route.change_type || "MIXED",
    riskTier: route.risk_tier || null,
    projectTaskId: route.project_task_id || null,
    storyPointId: route.story_point_id || null,
    sourceSnapshotHash: route.source_snapshot_hash || null,
    routingJson: stableStringify(route),
    now,
  });
  return getAcceptanceContext(contextId);
}

export function getAcceptanceContext(contextId) {
  return parseContextRow(db.prepare("SELECT * FROM acceptance_contexts WHERE id = ?").get(contextId));
}

export function listAcceptanceContexts({ projectTaskId, storyPointId, limit = 100 } = {}) {
  const where = ["1=1"];
  const params = { limit: Math.min(500, Math.max(1, Number(limit) || 100)) };
  if (projectTaskId) { where.push("project_task_id = @projectTaskId"); params.projectTaskId = projectTaskId; }
  if (storyPointId) { where.push("story_point_id = @storyPointId"); params.storyPointId = storyPointId; }
  return db.prepare(`SELECT * FROM acceptance_contexts WHERE ${where.join(" AND ")} ORDER BY updated_at DESC LIMIT @limit`)
    .all(params)
    .map(parseContextRow);
}

export function invalidateStoryRunsForSourceSnapshot(storyPointId, latestSnapshotHash) {
  if (!storyPointId || !latestSnapshotHash) return 0;
  const rows = db.prepare(`
    SELECT r.* FROM acceptance_runs r
    JOIN acceptance_contexts c ON c.id = r.context_id
    WHERE c.story_point_id = @storyPointId
      AND r.protocol = 'RUNTIME_STORY_POINT'
      AND r.source_snapshot_hash IS NOT NULL
      AND r.source_snapshot_hash <> @latestSnapshotHash
      AND r.status <> 'STALE_SOURCE'
  `).all({ storyPointId, latestSnapshotHash });
  if (!rows.length) return 0;
  const now = new Date().toISOString();
  const update = db.prepare(`
    UPDATE acceptance_runs SET
      status = 'STALE_SOURCE',
      gates_json = @gatesJson,
      claims_json = @claimsJson,
      impact_matrix_json = @impactMatrixJson,
      unknowns_json = @unknownsJson,
      story_point_decision = 'PARTIAL',
      source_sync_decision = 'DENIED',
      candidate_evidence_consistent = 0,
      candidate_consistency_reasons_json = @reasonsJson,
      updated_at = @now
    WHERE id = @runId
  `);
  for (const row of rows) {
    const reason = `SOURCE_SNAPSHOT_SUPERSEDED: ${row.source_snapshot_hash} -> ${latestSnapshotHash}`;
    const gates = parseJson(row.gates_json, []).map((gate) => ({
      ...gate,
      result: "PENDING",
      evidence_ids: [],
      evidence: "",
      input_hash: null,
    }));
    const claims = parseJson(row.claims_json, []).map((claim) => ({
      ...claim,
      type: "UNKNOWN",
      evidence_ids: [],
    }));
    const impactMatrix = Object.fromEntries(Object.entries(parseJson(row.impact_matrix_json, {}))
      .map(([dimension]) => [dimension, { status: "UNKNOWN", basis: reason }]));
    const unknowns = [...new Set([...parseJson(row.unknowns_json, []), reason])];
    const reasons = [...new Set([...parseJson(row.candidate_consistency_reasons_json, []), reason])];
    update.run({
      runId: row.id,
      gatesJson: stableStringify(gates),
      claimsJson: stableStringify(claims),
      impactMatrixJson: stableStringify(impactMatrix),
      unknownsJson: stableStringify(unknowns),
      reasonsJson: stableStringify(reasons),
      now,
    });
    appendAcceptanceEvent(row.id, "SOURCE_SNAPSHOT_SUPERSEDED", {
      previousSnapshotHash: row.source_snapshot_hash,
      latestSnapshotHash,
      invalidatedGateIds: gates.map((gate) => gate.id),
    });
  }
  return rows.length;
}

export function saveSourceSnapshot(canonical = {}) {
  if (!canonical.story_point_id || !canonical.source_snapshot_hash) {
    throw new TypeError("story_point_id and source_snapshot_hash are required");
  }
  const existing = db.prepare(`
    SELECT * FROM story_source_snapshots WHERE story_point_id = ? AND snapshot_hash = ?
  `).get(canonical.story_point_id, canonical.source_snapshot_hash);
  if (existing) return { snapshot: parseSnapshotRow(existing), idempotent: true };
  const snapshotId = id("asp");
  const now = new Date().toISOString();
  const mappingVersion = canonical.sources?.[canonical.primary_source_index || 0]?.mapping_version || "1";
  const fetchedAt = canonical.sources?.[canonical.primary_source_index || 0]?.fetched_at;
  if (!fetchedAt) {
    throw new TypeError("canonical primary source fetched_at is required");
  }
  const tx = db.transaction(() => {
    db.prepare(`
      INSERT INTO story_source_snapshots (
        id, story_point_id, snapshot_hash, mapping_version, canonical_json, fetched_at, created_at
      ) VALUES (@id, @storyPointId, @snapshotHash, @mappingVersion, @canonicalJson, @fetchedAt, @now)
    `).run({
      id: snapshotId,
      storyPointId: canonical.story_point_id,
      snapshotHash: canonical.source_snapshot_hash,
      mappingVersion,
      canonicalJson: stableStringify(canonical),
      fetchedAt,
      now,
    });
    db.prepare(`
      UPDATE story_source_snapshots SET superseded_by = @id
      WHERE story_point_id = @storyPointId AND id <> @id AND superseded_by IS NULL
    `).run({ id: snapshotId, storyPointId: canonical.story_point_id });
    invalidateStoryRunsForSourceSnapshot(canonical.story_point_id, canonical.source_snapshot_hash);
  });
  tx();
  return { snapshot: getSourceSnapshot(snapshotId), idempotent: false };
}

export function getSourceSnapshot(snapshotId) {
  return parseSnapshotRow(db.prepare("SELECT * FROM story_source_snapshots WHERE id = ?").get(snapshotId));
}

export function getLatestSourceSnapshot(storyPointId) {
  return parseSnapshotRow(db.prepare(`
    SELECT * FROM story_source_snapshots
    WHERE story_point_id = ? AND superseded_by IS NULL
    ORDER BY created_at DESC, id DESC LIMIT 1
  `).get(storyPointId));
}

export function createAcceptanceRun(input = {}) {
  if (!input.contextId || !input.protocol || !input.modeOrTier) {
    throw new TypeError("contextId, protocol, and modeOrTier are required");
  }
  const runId = id("arun");
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO acceptance_runs (
      id, context_id, protocol, mode_or_tier, track_group_id, status, candidate_identity_hash,
      candidate_json, source_snapshot_hash, environment_id, gates_json, claims_json,
      impact_matrix_json, findings_json, unknowns_json, residual_risks_json,
       repair_rounds, project_change_decision, production_readiness,
       story_point_decision, source_sync_decision, source_sync_status,
       candidate_evidence_consistent, candidate_consistency_reasons_json,
       supersedes_run_id, created_at, updated_at
    ) VALUES (
      @id, @contextId, @protocol, @modeOrTier, @trackGroupId, @status, @candidateIdentityHash,
      @candidateJson, @sourceSnapshotHash, @environmentId, @gatesJson, @claimsJson,
      @impactMatrixJson, @findingsJson, @unknownsJson, @residualRisksJson,
       @repairRounds, @projectChangeDecision, @productionReadiness,
       @storyPointDecision, @sourceSyncDecision, @sourceSyncStatus,
       @candidateEvidenceConsistent, @candidateConsistencyReasonsJson,
       @supersedesRunId, @now, @now
    )
  `).run({
    id: runId,
    contextId: input.contextId,
    protocol: input.protocol,
    modeOrTier: input.modeOrTier,
    trackGroupId: input.trackGroupId || null,
    status: input.status || "CREATED",
    candidateIdentityHash: input.candidateIdentityHash || null,
    candidateJson: stableStringify(input.candidate || {}),
    sourceSnapshotHash: input.sourceSnapshotHash || null,
    environmentId: input.environmentId || null,
    gatesJson: stableStringify(input.gates || []),
    claimsJson: stableStringify(input.claims || []),
    impactMatrixJson: stableStringify(input.impactMatrix || {}),
    findingsJson: stableStringify(input.findings || []),
    unknownsJson: stableStringify(input.unknowns || []),
    residualRisksJson: stableStringify(input.residualRisks || []),
    repairRounds: Math.min(2, Math.max(0, Number(input.repairRounds) || 0)),
    projectChangeDecision: input.projectChangeDecision || "NOT_ASSESSED",
    productionReadiness: input.productionReadiness || "NOT_ASSESSED",
    storyPointDecision: input.storyPointDecision || "NOT_APPLICABLE",
    sourceSyncDecision: input.sourceSyncDecision || "DENIED",
    sourceSyncStatus: input.sourceSyncStatus || "NOT_ATTEMPTED",
    candidateEvidenceConsistent: input.candidateEvidenceConsistent === true
      ? 1 : input.candidateEvidenceConsistent === false ? 0 : null,
    candidateConsistencyReasonsJson: stableStringify(input.candidateConsistencyReasons || []),
    supersedesRunId: input.supersedesRunId || null,
    now,
  });
  appendAcceptanceEvent(runId, "RUN_CREATED", { protocol: input.protocol, modeOrTier: input.modeOrTier });
  return getAcceptanceRun(runId);
}

export function updateAcceptanceRun(runId, patch = {}) {
  const mapping = {
    status: ["status", (value) => value],
    gates: ["gates_json", stableStringify],
    claims: ["claims_json", stableStringify],
    impactMatrix: ["impact_matrix_json", stableStringify],
    findings: ["findings_json", stableStringify],
    unknowns: ["unknowns_json", stableStringify],
    residualRisks: ["residual_risks_json", stableStringify],
    repairRounds: ["repair_rounds", (value) => Math.min(2, Math.max(0, Number(value) || 0))],
    projectChangeDecision: ["project_change_decision", (value) => value],
    productionReadiness: ["production_readiness", (value) => value],
    storyPointDecision: ["story_point_decision", (value) => value],
    sourceSyncDecision: ["source_sync_decision", (value) => value],
    sourceSyncStatus: ["source_sync_status", (value) => value],
    candidateEvidenceConsistent: ["candidate_evidence_consistent", (value) => value === true ? 1 : value === false ? 0 : null],
    candidateConsistencyReasons: ["candidate_consistency_reasons_json", stableStringify],
  };
  const fields = [];
  const params = { runId, now: new Date().toISOString() };
  for (const [key, value] of Object.entries(patch)) {
    const definition = mapping[key];
    if (!definition) continue;
    const [column, transform] = definition;
    fields.push(`${column} = @${key}`);
    params[key] = transform(value);
  }
  if (!fields.length) return getAcceptanceRun(runId);
  fields.push("updated_at = @now");
  db.prepare(`UPDATE acceptance_runs SET ${fields.join(", ")} WHERE id = @runId`).run(params);
  appendAcceptanceEvent(runId, "RUN_UPDATED", { fields: Object.keys(patch).filter((key) => mapping[key]) });
  return getAcceptanceRun(runId);
}

export function getAcceptanceRun(runId) {
  const run = parseRunRow(db.prepare("SELECT * FROM acceptance_runs WHERE id = ?").get(runId));
  if (!run) return null;
  run.routing = getAcceptanceContext(run.contextId)?.routing || null;
  return run;
}

export function listAcceptanceRuns({ protocol, status, storyPointId, projectTaskId, limit = 100 } = {}) {
  const where = ["1=1"];
  const params = { limit: Math.min(500, Math.max(1, Number(limit) || 100)) };
  if (protocol) { where.push("r.protocol = @protocol"); params.protocol = protocol; }
  if (status) { where.push("r.status = @status"); params.status = status; }
  if (storyPointId) { where.push("c.story_point_id = @storyPointId"); params.storyPointId = storyPointId; }
  if (projectTaskId) { where.push("c.project_task_id = @projectTaskId"); params.projectTaskId = projectTaskId; }
  return db.prepare(`
    SELECT r.* FROM acceptance_runs r
    JOIN acceptance_contexts c ON c.id = r.context_id
    WHERE ${where.join(" AND ")}
    ORDER BY r.updated_at DESC LIMIT @limit
  `).all(params).map((row) => {
    const run = parseRunRow(row);
    run.routing = getAcceptanceContext(run.contextId)?.routing || null;
    return run;
  });
}

export function addAcceptanceEvidence(runId, evidence = {}) {
  if (!getAcceptanceRun(runId)) throw new TypeError("acceptance run not found");
  const requestedTrust = String(evidence.trustLevel || evidence.trust_level || "UNVERIFIED").trim().toUpperCase();
  const trustLevel = ["UNVERIFIED", "MECHANICAL", "ATTESTED"].includes(requestedTrust)
    ? requestedTrust : "UNVERIFIED";
  const producer = String(evidence.producer || "").trim() || null;
  if (trustLevel !== "UNVERIFIED" && !producer) {
    throw new TypeError("trusted acceptance evidence requires a producer");
  }
  const evidenceId = id("aev");
  db.prepare(`
    INSERT INTO acceptance_evidence (
      id, run_id, gate_id, kind, uri, sha256, candidate_identity_hash,
      source_snapshot_hash, environment_id, command_text, exit_code,
      trust_level, producer, observed_at, metadata_json
    ) VALUES (
      @id, @runId, @gateId, @kind, @uri, @sha256, @candidateIdentityHash,
      @sourceSnapshotHash, @environmentId, @commandText, @exitCode,
      @trustLevel, @producer, @observedAt, @metadataJson
    )
  `).run({
    id: evidenceId,
    runId,
    gateId: evidence.gateId || null,
    kind: evidence.kind || "command",
    uri: evidence.uri || null,
    sha256: evidence.sha256 || null,
    candidateIdentityHash: evidence.candidateIdentityHash || null,
    sourceSnapshotHash: evidence.sourceSnapshotHash || null,
    environmentId: evidence.environmentId || null,
    commandText: evidence.command || null,
    exitCode: Number.isInteger(evidence.exitCode) ? evidence.exitCode : null,
    trustLevel,
    producer,
    observedAt: evidence.observedAt || new Date().toISOString(),
    metadataJson: stableStringify(evidence.metadata || {}),
  });
  appendAcceptanceEvent(runId, "EVIDENCE_ADDED", { evidenceId, gateId: evidence.gateId || null });
  return getAcceptanceEvidence(evidenceId);
}

export function getAcceptanceEvidence(evidenceId) {
  const out = toCamel(db.prepare("SELECT * FROM acceptance_evidence WHERE id = ?").get(evidenceId));
  if (!out) return null;
  out.metadata = parseJson(out.metadataJson, {});
  delete out.metadataJson;
  return out;
}

export function listAcceptanceEvidence(runId) {
  return db.prepare("SELECT * FROM acceptance_evidence WHERE run_id = ? ORDER BY observed_at, id").all(runId).map((row) => {
    const out = toCamel(row);
    out.metadata = parseJson(out.metadataJson, {});
    delete out.metadataJson;
    return out;
  });
}

export function putGateCache({ protocol, gateId, inputHash, result, evidenceIds = [] }) {
  const cacheKey = sha256({ protocol, gateId, inputHash });
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO acceptance_gate_cache (
      cache_key, protocol, gate_id, input_hash, result, evidence_ids_json, created_at, updated_at
    ) VALUES (@cacheKey, @protocol, @gateId, @inputHash, @result, @evidenceIdsJson, @now, @now)
    ON CONFLICT(cache_key) DO UPDATE SET
      result=excluded.result, evidence_ids_json=excluded.evidence_ids_json,
      invalidated_at=NULL, updated_at=excluded.updated_at
  `).run({ cacheKey, protocol, gateId, inputHash, result, evidenceIdsJson: stableStringify(evidenceIds), now });
  return getGateCache(protocol, gateId, inputHash);
}

export function getGateCache(protocol, gateId, inputHash) {
  const out = toCamel(db.prepare(`
    SELECT * FROM acceptance_gate_cache
    WHERE protocol = ? AND gate_id = ? AND input_hash = ? AND invalidated_at IS NULL
  `).get(protocol, gateId, inputHash));
  if (!out) return null;
  out.evidenceIds = parseJson(out.evidenceIdsJson, []);
  delete out.evidenceIdsJson;
  return out;
}

export function invalidateGateCache(protocol, gateIds = []) {
  const ids = [...new Set(gateIds.filter(Boolean))];
  if (!ids.length) return 0;
  const placeholders = ids.map(() => "?").join(",");
  return db.prepare(`
    UPDATE acceptance_gate_cache SET invalidated_at = ?, updated_at = ?
    WHERE protocol = ? AND gate_id IN (${placeholders}) AND invalidated_at IS NULL
  `).run(new Date().toISOString(), new Date().toISOString(), protocol, ...ids).changes;
}

export function appendAcceptanceEvent(runId, eventType, payload = {}) {
  const now = new Date().toISOString();
  const info = db.prepare(`
    INSERT INTO acceptance_events (run_id, event_type, payload_json, created_at)
    VALUES (?, ?, ?, ?)
  `).run(runId, eventType, stableStringify(payload), now);
  return { id: info.lastInsertRowid, runId, eventType, payload, createdAt: now };
}

export function listAcceptanceEvents(runId, { afterId = 0, limit = 500 } = {}) {
  return db.prepare(`
    SELECT * FROM acceptance_events WHERE run_id = ? AND id > ? ORDER BY id LIMIT ?
  `).all(runId, Number(afterId) || 0, Math.min(1000, Math.max(1, Number(limit) || 500))).map((row) => {
    const out = toCamel(row);
    out.payload = parseJson(out.payloadJson, {});
    delete out.payloadJson;
    return out;
  });
}
