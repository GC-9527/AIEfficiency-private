// AI Workbench 数据访问层（13 张表）。
// 风格：每个函数返回 plain object（snake → camel），try/catch 转换 SQL 异常为 AiautoworkError。

import db from "../../db/sqlite.js";
import { computeIdempotencyKey } from "../../db/aiautowork-schema.js";
import { randomUUID } from "node:crypto";
import { AiautoworkError, ERROR_CODES } from "./error-codes.js";

function safeParse(text, dflt) {
  if (text === null || text === undefined || text === "") return dflt;
  if (typeof text !== "string") return text;
  try { return JSON.parse(text); } catch { return dflt; }
}

function rowToCamel(row) {
  if (!row) return null;
  const out = {};
  for (const key of Object.keys(row)) {
    const camel = key.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
    out[camel] = row[key];
  }
  return out;
}

function newId(prefix = "aw") {
  return `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
}

function parseJsonField(text) {
  if (!text) return null;
  try { return JSON.parse(text); } catch { return null; }
}

// ========== task_drafts ==========

export function createTaskDraft({ sourceType, sourceRef, rawInput, normalizedInput, configHash, policyVersion, createdBy, node, sourcePriority }) {
  if (!sourceType) throw new AiautoworkError(ERROR_CODES.INVALID_INPUT, "sourceType is required");
  const id = newId("td");
  const idempotencyKey = computeIdempotencyKey({
    sourceType,
    sourceRef,
    normalizedInput,
    configHash,
    policyVersion,
  });
  const now = new Date().toISOString();
  try {
    db.prepare(`
      INSERT INTO task_drafts (id, source_type, source_ref, idempotency_key, status, raw_input, normalized_input, config_fingerprint, source_priority, created_by, node, created_at, updated_at)
      VALUES (@id, @sourceType, @sourceRef, @idempotencyKey, @status, @rawInput, @normalizedInput, @configFingerprint, @sourcePriority, @createdBy, @node, @now, @now)
    `).run({
      id,
      sourceType,
      sourceRef: sourceRef || null,
      idempotencyKey,
      status: "INPUT_PARSED",
      rawInput: typeof rawInput === "string" ? rawInput : JSON.stringify(rawInput || {}),
      normalizedInput: typeof normalizedInput === "string" ? normalizedInput : JSON.stringify(normalizedInput || {}),
      configFingerprint: configHash || null,
      sourcePriority: sourcePriority || "normal",
      createdBy: createdBy || null,
      node: node || null,
      now,
    });
  } catch (e) {
    if (String(e.message).includes("UNIQUE constraint failed: task_drafts.idempotency_key")) {
      throw new AiautoworkError(ERROR_CODES.DUPLICATE_TASK_DRAFT, "TaskDraft 已存在（idempotency_key 冲突）", { httpStatus: 409 });
    }
    throw new AiautoworkError(ERROR_CODES.INTERNAL_ERROR, e.message, { cause: e });
  }
  return getTaskDraft(id);
}

export function getTaskDraft(id) {
  const row = db.prepare("SELECT * FROM task_drafts WHERE id = ?").get(id);
  if (!row) return null;
  const out = rowToCamel(row);
  out.rawInput = parseJsonField(out.rawInput);
  out.normalizedInput = parseJsonField(out.normalizedInput);
  return out;
}

export function getTaskDraftByIdempotencyKey(key) {
  if (!key) return null;
  const row = db.prepare("SELECT * FROM task_drafts WHERE idempotency_key = ?").get(key);
  if (!row) return null;
  const out = rowToCamel(row);
  out.rawInput = parseJsonField(out.rawInput);
  out.normalizedInput = parseJsonField(out.normalizedInput);
  return out;
}

export function listTaskDrafts({ status, sourceType, limit = 50, offset = 0 } = {}) {
  const where = ["1=1"];
  const params = { limit, offset };
  if (status) { where.push("status = @status"); params.status = status; }
  if (sourceType) { where.push("source_type = @sourceType"); params.sourceType = sourceType; }
  const sql = `SELECT * FROM task_drafts WHERE ${where.join(" AND ")} ORDER BY updated_at DESC LIMIT @limit OFFSET @offset`;
  return db.prepare(sql).all(params).map(rowToCamel);
}

export function updateTaskDraft(id, patch) {
  const fields = [];
  const params = { id };
  for (const [k, v] of Object.entries(patch || {})) {
    if (k === "rawInput" || k === "normalizedInput" || k === "signals") {
      params[k] = typeof v === "string" ? v : JSON.stringify(v);
    } else {
      params[k] = v;
    }
    const col = k.replace(/[A-Z]/g, (m) => "_" + m.toLowerCase());
    fields.push(`${col} = @${k}`);
  }
  if (!fields.length) return getTaskDraft(id);
  fields.push("updated_at = datetime('now','localtime')");
  db.prepare(`UPDATE task_drafts SET ${fields.join(", ")} WHERE id = @id`).run(params);
  return getTaskDraft(id);
}

// ========== batch_creation_jobs ==========

export function createBatchJob({ name, description, configTemplate, total = 0, createdBy, node }) {
  if (!name) throw new AiautoworkError(ERROR_CODES.INVALID_INPUT, "name is required");
  const id = newId("batch");
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO batch_creation_jobs (id, name, description, config_template, total, status, created_by, node, created_at, updated_at)
    VALUES (@id, @name, @description, @configTemplate, @total, 'pending', @createdBy, @node, @now, @now)
  `).run({
    id,
    name,
    description: description || null,
    configTemplate: typeof configTemplate === "string" ? configTemplate : JSON.stringify(configTemplate || {}),
    total,
    createdBy: createdBy || null,
    node: node || null,
    now,
  });
  return getBatchJob(id);
}

export function getBatchJob(id) {
  const row = db.prepare("SELECT * FROM batch_creation_jobs WHERE id = ?").get(id);
  if (!row) return null;
  const out = rowToCamel(row);
  out.configTemplate = parseJsonField(out.configTemplate);
  return out;
}

export function listBatchJobs({ status, limit = 50, offset = 0 } = {}) {
  const where = ["1=1"];
  const params = { limit, offset };
  if (status) { where.push("status = @status"); params.status = status; }
  const sql = `SELECT * FROM batch_creation_jobs WHERE ${where.join(" AND ")} ORDER BY updated_at DESC LIMIT @limit OFFSET @offset`;
  return db.prepare(sql).all(params).map(rowToCamel);
}

export function updateBatchJob(id, patch) {
  const fields = [];
  const params = { id };
  for (const [k, v] of Object.entries(patch || {})) {
    if (k === "configTemplate") {
      params[k] = typeof v === "string" ? v : JSON.stringify(v);
    } else {
      params[k] = v;
    }
    const col = k.replace(/[A-Z]/g, (m) => "_" + m.toLowerCase());
    fields.push(`${col} = @${k}`);
  }
  if (!fields.length) return getBatchJob(id);
  fields.push("updated_at = datetime('now','localtime')");
  db.prepare(`UPDATE batch_creation_jobs SET ${fields.join(", ")} WHERE id = @id`).run(params);
  return getBatchJob(id);
}

// ========== batch_task_items ==========

export function createBatchTaskItem({ batchId, taskDraftId, priority = 5, pool = "inference" }) {
  const id = newId("bi");
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO batch_task_items (id, batch_id, task_draft_id, status, priority, pool, created_at, updated_at)
    VALUES (@id, @batchId, @taskDraftId, 'queued', @priority, @pool, @now, @now)
  `).run({ id, batchId, taskDraftId: taskDraftId || null, priority, pool, now });
  return getBatchTaskItem(id);
}

export function getBatchTaskItem(id) {
  return rowToCamel(db.prepare("SELECT * FROM batch_task_items WHERE id = ?").get(id));
}

export function listBatchTaskItems({ batchId, status, pool, limit = 200, offset = 0 } = {}) {
  const where = ["1=1"];
  const params = { limit, offset };
  if (batchId) { where.push("batch_id = @batchId"); params.batchId = batchId; }
  if (status) { where.push("status = @status"); params.status = status; }
  if (pool) { where.push("pool = @pool"); params.pool = pool; }
  const sql = `SELECT * FROM batch_task_items WHERE ${where.join(" AND ")} ORDER BY priority ASC, created_at ASC LIMIT @limit OFFSET @offset`;
  return db.prepare(sql).all(params).map(rowToCamel);
}

export function updateBatchTaskItem(id, patch) {
  const fields = [];
  const params = { id };
  for (const [k, v] of Object.entries(patch || {})) {
    params[k] = v;
    const col = k.replace(/[A-Z]/g, (m) => "_" + m.toLowerCase());
    fields.push(`${col} = @${k}`);
  }
  if (!fields.length) return getBatchTaskItem(id);
  fields.push("updated_at = datetime('now','localtime')");
  db.prepare(`UPDATE batch_task_items SET ${fields.join(", ")} WHERE id = @id`).run(params);
  return getBatchTaskItem(id);
}

// ========== config_candidate_attempts ==========

export function createCandidateAttempt({ taskDraftId, version, inferrerEngine, inferrerModel }) {
  const id = newId("cand");
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO config_candidate_attempts (id, task_draft_id, version, inferrer_engine, inferrer_model, status, created_at)
    VALUES (@id, @taskDraftId, @version, @inferrerEngine, @inferrerModel, 'pending', @now)
  `).run({
    id,
    taskDraftId,
    version: version || 1,
    inferrerEngine: inferrerEngine || null,
    inferrerModel: inferrerModel || null,
    now,
  });
  return getCandidateAttempt(id);
}

export function getCandidateAttempt(id) {
  const row = db.prepare("SELECT * FROM config_candidate_attempts WHERE id = ?").get(id);
  if (!row) return null;
  const out = rowToCamel(row);
  out.signals = parseJsonField(out.signalsJson);
  out.decisions = parseJsonField(out.decisionsJson);
  out.candidate = parseJsonField(out.candidateJson);
  out.evidence = parseJsonField(out.evidenceJson);
  delete out.signalsJson;
  delete out.decisionsJson;
  delete out.candidateJson;
  delete out.evidenceJson;
  return out;
}

export function listCandidateAttempts(taskDraftId) {
  const rows = db.prepare("SELECT * FROM config_candidate_attempts WHERE task_draft_id = ? ORDER BY version DESC").all(taskDraftId);
  return rows.map((row) => {
    const out = rowToCamel(row);
    out.signals = parseJsonField(out.signalsJson);
    out.decisions = parseJsonField(out.decisionsJson);
    out.candidate = parseJsonField(out.candidateJson);
    out.evidence = parseJsonField(out.evidenceJson);
    delete out.signalsJson;
    delete out.decisionsJson;
    delete out.candidateJson;
    delete out.evidenceJson;
    return out;
  });
}

export function updateCandidateAttempt(id, patch) {
  const fields = [];
  const params = { id };
  const jsonColumns = {
    signals: "signals_json",
    decisions: "decisions_json",
    candidate: "candidate_json",
    evidence: "evidence_json",
  };
  for (const [k, v] of Object.entries(patch || {})) {
    if (jsonColumns[k]) {
      params[k] = typeof v === "string" ? v : JSON.stringify(v);
    } else {
      params[k] = v;
    }
    const col = jsonColumns[k] || k.replace(/[A-Z]/g, (m) => "_" + m.toLowerCase());
    fields.push(`${col} = @${k}`);
  }
  if (!fields.length) return getCandidateAttempt(id);
  db.prepare(`UPDATE config_candidate_attempts SET ${fields.join(", ")} WHERE id = @id`).run(params);
  return getCandidateAttempt(id);
}

// ========== validation_issues ==========

export function createValidationIssue(record) {
  const id = newId("iss");
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO validation_issues (id, task_draft_id, candidate_id, stage, severity, code, field_key, message, auto_fixable, fix_strategy, created_at)
    VALUES (@id, @taskDraftId, @candidateId, @stage, @severity, @code, @fieldKey, @message, @autoFixable, @fixStrategy, @now)
  `).run({
    id,
    taskDraftId: record.taskDraftId,
    candidateId: record.candidateId || null,
    stage: record.stage || "validator",
    severity: record.severity || "error",
    code: record.code || "UNKNOWN",
    fieldKey: record.fieldKey || null,
    message: record.message || "",
    autoFixable: record.autoFixable ? 1 : 0,
    fixStrategy: record.fixStrategy || null,
    now,
  });
  return getValidationIssue(id);
}

export function getValidationIssue(id) {
  return rowToCamel(db.prepare("SELECT * FROM validation_issues WHERE id = ?").get(id));
}

export function listValidationIssues({ taskDraftId, candidateId, stage, severity, resolved }) {
  const where = ["1=1"];
  const params = {};
  if (taskDraftId) { where.push("task_draft_id = @taskDraftId"); params.taskDraftId = taskDraftId; }
  if (candidateId) { where.push("candidate_id = @candidateId"); params.candidateId = candidateId; }
  if (stage) { where.push("stage = @stage"); params.stage = stage; }
  if (severity) { where.push("severity = @severity"); params.severity = severity; }
  if (resolved === false) { where.push("resolved_at IS NULL"); }
  else if (resolved === true) { where.push("resolved_at IS NOT NULL"); }
  return db.prepare(`SELECT * FROM validation_issues WHERE ${where.join(" AND ")} ORDER BY created_at DESC`)
    .all(params)
    .map(rowToCamel);
}

export function resolveValidationIssue(id) {
  const now = new Date().toISOString();
  db.prepare("UPDATE validation_issues SET fixed = 1, resolved_at = @now WHERE id = @id").run({ id, now });
  return getValidationIssue(id);
}

// ========== manual_intervention_cases ==========

export function createManualCase({ taskDraftId, openedReason, openedBy, reasonCode, payload }) {
  const id = newId("mi");
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO manual_intervention_cases (id, task_draft_id, opened_reason, opened_by, reason_code, payload_json, status, opened_at, updated_at)
    VALUES (@id, @taskDraftId, @openedReason, @openedBy, @reasonCode, @payload, 'open', @now, @now)
  `).run({
    id,
    taskDraftId,
    openedReason: openedReason || null,
    openedBy: openedBy || null,
    reasonCode: reasonCode || null,
    payload: typeof payload === "string" ? payload : JSON.stringify(payload || {}),
    now,
  });
  return getManualCase(id);
}

export function getManualCase(id) {
  const row = db.prepare("SELECT * FROM manual_intervention_cases WHERE id = ?").get(id);
  if (!row) return null;
  const out = rowToCamel(row);
  out.payload = parseJsonField(out.payloadJson);
  delete out.payloadJson;
  return out;
}

export function listManualCases({ status, taskDraftId, limit = 100 } = {}) {
  const where = ["1=1"];
  const params = { limit };
  if (status) { where.push("status = @status"); params.status = status; }
  if (taskDraftId) { where.push("task_draft_id = @taskDraftId"); params.taskDraftId = taskDraftId; }
  return db.prepare(`SELECT * FROM manual_intervention_cases WHERE ${where.join(" AND ")} ORDER BY opened_at DESC LIMIT @limit`)
    .all(params)
    .map(rowToCamel);
}

export function updateManualCase(id, patch) {
  const fields = [];
  const params = { id };
  for (const [k, v] of Object.entries(patch || {})) {
    if (k === "payload") {
      params[k] = typeof v === "string" ? v : JSON.stringify(v);
    } else {
      params[k] = v;
    }
    const col = k.replace(/[A-Z]/g, (m) => "_" + m.toLowerCase());
    fields.push(`${col} = @${k}`);
  }
  if (!fields.length) return getManualCase(id);
  fields.push("updated_at = datetime('now','localtime')");
  db.prepare(`UPDATE manual_intervention_cases SET ${fields.join(", ")} WHERE id = @id`).run(params);
  return getManualCase(id);
}

// ========== resolved_config_snapshots ==========

export function createSnapshot({ taskDraftId, candidateId, fingerprint, decisions, evidence, snapshot, scoreOverall, createdBy }) {
  const id = newId("snap");
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO resolved_config_snapshots (id, task_draft_id, candidate_id, fingerprint, decisions_json, evidence_json, snapshot_json, score_overall, created_by, created_at)
    VALUES (@id, @taskDraftId, @candidateId, @fingerprint, @decisions, @evidence, @snapshot, @scoreOverall, @createdBy, @now)
  `).run({
    id,
    taskDraftId,
    candidateId: candidateId || null,
    fingerprint: fingerprint || null,
    decisions: JSON.stringify(decisions || {}),
    evidence: JSON.stringify(evidence || {}),
    snapshot: JSON.stringify(snapshot || {}),
    scoreOverall: scoreOverall || null,
    createdBy: createdBy || "USER",
    now,
  });
  return getSnapshot(id);
}

export function getSnapshot(id) {
  const row = db.prepare("SELECT * FROM resolved_config_snapshots WHERE id = ?").get(id);
  if (!row) return null;
  const out = rowToCamel(row);
  out.decisions = parseJsonField(out.decisionsJson);
  out.evidence = parseJsonField(out.evidenceJson);
  out.snapshot = parseJsonField(out.snapshotJson);
  delete out.decisionsJson;
  delete out.evidenceJson;
  delete out.snapshotJson;
  return out;
}

export function listSnapshotsByFingerprint(fingerprint, { limit = 50 } = {}) {
  if (!fingerprint) return [];
  return db.prepare("SELECT * FROM resolved_config_snapshots WHERE fingerprint = ? ORDER BY created_at DESC LIMIT ?")
    .all(fingerprint, limit)
    .map(rowToCamel);
}

export function listSnapshotsByTaskDraft(taskDraftId) {
  const rows = db.prepare("SELECT * FROM resolved_config_snapshots WHERE task_draft_id = ? ORDER BY created_at DESC").all(taskDraftId);
  return rows.map((row) => {
    const out = rowToCamel(row);
    out.decisions = parseJsonField(out.decisionsJson);
    out.evidence = parseJsonField(out.evidenceJson);
    out.snapshot = parseJsonField(out.snapshotJson);
    delete out.decisionsJson;
    delete out.evidenceJson;
    delete out.snapshotJson;
    return out;
  });
}

// ========== story_points ==========

export function createStoryPoint({ taskDraftId, idempotencyKey, devbenchStoryId, devbenchSessionId }) {
  const id = newId("sp");
  const now = new Date().toISOString();
  try {
    db.prepare(`
      INSERT INTO story_points (id, task_draft_id, idempotency_key, devbench_story_id, devbench_session_id, status, last_event_at, created_at)
      VALUES (@id, @taskDraftId, @idempotencyKey, @devbenchStoryId, @devbenchSessionId, 'PENDING', @now, @now)
    `).run({
      id,
      taskDraftId,
      idempotencyKey,
      devbenchStoryId: devbenchStoryId || null,
      devbenchSessionId: devbenchSessionId || null,
      now,
    });
  } catch (e) {
    if (String(e.message).includes("UNIQUE constraint failed: story_points.idempotency_key")) {
      throw new AiautoworkError(ERROR_CODES.STORY_POINT_ALREADY_CREATED, "StoryPoint 已存在（idempotency_key 冲突）", { httpStatus: 409 });
    }
    throw new AiautoworkError(ERROR_CODES.INTERNAL_ERROR, e.message, { cause: e });
  }
  return getStoryPoint(id);
}

export function getStoryPoint(id) {
  return rowToCamel(db.prepare("SELECT * FROM story_points WHERE id = ?").get(id));
}

export function getStoryPointByIdempotencyKey(key) {
  if (!key) return null;
  return rowToCamel(db.prepare("SELECT * FROM story_points WHERE idempotency_key = ?").get(key));
}

export function listStoryPoints({ status, limit = 50 } = {}) {
  const where = ["1=1"];
  const params = { limit };
  if (status) { where.push("status = @status"); params.status = status; }
  return db.prepare(`SELECT * FROM story_points WHERE ${where.join(" AND ")} ORDER BY last_event_at DESC LIMIT @limit`)
    .all(params)
    .map(rowToCamel);
}

export function updateStoryPoint(id, patch) {
  const fields = [];
  const params = { id };
  for (const [k, v] of Object.entries(patch || {})) {
    params[k] = v;
    const col = k.replace(/[A-Z]/g, (m) => "_" + m.toLowerCase());
    fields.push(`${col} = @${k}`);
  }
  if (!fields.length) return getStoryPoint(id);
  fields.push("last_event_at = datetime('now','localtime')");
  db.prepare(`UPDATE story_points SET ${fields.join(", ")} WHERE id = @id`).run(params);
  return getStoryPoint(id);
}

// ========== execution_queue ==========

export function enqueueExecution({ taskDraftId, batchItemId, priority = 5, pool, queueReason, payload }) {
  if (!pool) throw new AiautoworkError(ERROR_CODES.INVALID_INPUT, "pool is required");
  const id = newId("eq");
  const now = Math.floor(Date.now() / 1000);
  db.prepare(`
    INSERT INTO execution_queue (id, task_draft_id, batch_item_id, priority, pool, status, queue_reason, payload_json, enqueued_at)
    VALUES (@id, @taskDraftId, @batchItemId, @priority, @pool, 'queued', @queueReason, @payload, @now)
  `).run({
    id,
    taskDraftId: taskDraftId || null,
    batchItemId: batchItemId || null,
    priority,
    pool,
    queueReason: queueReason || null,
    payload: typeof payload === "string" ? payload : JSON.stringify(payload || {}),
    now,
  });
  return getExecutionEntry(id);
}

export function getExecutionEntry(id) {
  const row = db.prepare("SELECT * FROM execution_queue WHERE id = ?").get(id);
  if (!row) return null;
  const out = rowToCamel(row);
  out.payload = parseJsonField(out.payloadJson);
  delete out.payloadJson;
  return out;
}

export function listExecutionQueue({ pool, status, limit = 100 } = {}) {
  const where = ["1=1"];
  const params = { limit };
  if (pool) { where.push("pool = @pool"); params.pool = pool; }
  if (status) { where.push("status = @status"); params.status = status; }
  return db.prepare(`SELECT * FROM execution_queue WHERE ${where.join(" AND ")} ORDER BY priority ASC, enqueued_at ASC LIMIT @limit`)
    .all(params)
    .map(rowToCamel);
}

export function updateExecutionEntry(id, patch) {
  const fields = [];
  const params = { id };
  for (const [k, v] of Object.entries(patch || {})) {
    if (k === "payload") {
      params[k] = typeof v === "string" ? v : JSON.stringify(v);
    } else {
      params[k] = v;
    }
    const col = k.replace(/[A-Z]/g, (m) => "_" + m.toLowerCase());
    fields.push(`${col} = @${k}`);
  }
  if (!fields.length) return getExecutionEntry(id);
  db.prepare(`UPDATE execution_queue SET ${fields.join(", ")} WHERE id = @id`).run(params);
  return getExecutionEntry(id);
}

// ========== aiautowork_settings ==========

export function getSetting(key, dflt = null) {
  const row = db.prepare("SELECT * FROM aiautowork_settings WHERE key = ?").get(key);
  if (!row) return dflt;
  return parseJsonField(row.value_json, dflt);
}

export function setSetting(key, value, { description = null, updatedBy = null } = {}) {
  const valueJson = typeof value === "string" ? value : JSON.stringify(value ?? null);
  db.prepare(`
    INSERT INTO aiautowork_settings (key, value_json, description, updated_by, updated_at)
    VALUES (@key, @valueJson, @description, @updatedBy, datetime('now','localtime'))
    ON CONFLICT(key) DO UPDATE SET
      value_json=excluded.value_json,
      description=COALESCE(excluded.description, aiautowork_settings.description),
      updated_by=COALESCE(excluded.updated_by, aiautowork_settings.updated_by),
      updated_at=datetime('now','localtime')
  `).run({ key, valueJson, description, updatedBy });
  return getSetting(key);
}

export function listSettings() {
  return db.prepare("SELECT key, value_json, description, updated_by, updated_at FROM aiautowork_settings ORDER BY key ASC")
    .all()
    .map((r) => ({
      key: r.key,
      value: parseJsonField(r.value_json, null),
      description: r.description || "",
      updatedBy: r.updated_by || "",
      updatedAt: r.updated_at,
    }));
}

// ========== config_audit_events ==========

export function addAuditEvent({ actor, action, targetType, targetId, before, after, reason }) {
  const id = newId("ae");
  const ts = Date.now();
  db.prepare(`
    INSERT INTO config_audit_events (id, actor, action, target_type, target_id, before_json, after_json, reason, ts)
    VALUES (@id, @actor, @action, @targetType, @targetId, @before, @after, @reason, @ts)
  `).run({
    id,
    actor: actor || null,
    action,
    targetType: targetType || null,
    targetId: targetId || null,
    before: typeof before === "string" ? before : JSON.stringify(before ?? null),
    after: typeof after === "string" ? after : JSON.stringify(after ?? null),
    reason: reason || null,
    ts,
  });
  return getAuditEvent(id);
}

export function getAuditEvent(id) {
  const row = db.prepare("SELECT * FROM config_audit_events WHERE id = ?").get(id);
  if (!row) return null;
  const out = rowToCamel(row);
  out.before = parseJsonField(out.beforeJson);
  out.after = parseJsonField(out.afterJson);
  delete out.beforeJson;
  delete out.afterJson;
  return out;
}

export function listAuditEvents({ actor, action, targetType, targetId, limit = 100 } = {}) {
  const where = ["1=1"];
  const params = { limit };
  if (actor) { where.push("actor = @actor"); params.actor = actor; }
  if (action) { where.push("action = @action"); params.action = action; }
  if (targetType) { where.push("target_type = @targetType"); params.targetType = targetType; }
  if (targetId) { where.push("target_id = @targetId"); params.targetId = targetId; }
  return db.prepare(`SELECT * FROM config_audit_events WHERE ${where.join(" AND ")} ORDER BY ts DESC LIMIT @limit`)
    .all(params)
    .map((row) => {
      const out = rowToCamel(row);
      out.before = parseJsonField(out.beforeJson);
      out.after = parseJsonField(out.afterJson);
      delete out.beforeJson;
      delete out.afterJson;
      return out;
    });
}

// ========== review_targets ==========

export function createReviewTarget({ sourceType, repoId, targetRef, baseRef, title }) {
  const id = newId("rt");
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO review_targets (id, source_type, repo_id, target_ref, base_ref, title, created_at, updated_at)
    VALUES (@id, @sourceType, @repoId, @targetRef, @baseRef, @title, @now, @now)
  `).run({
    id,
    sourceType,
    repoId: repoId || null,
    targetRef: targetRef || null,
    baseRef: baseRef || null,
    title: title || null,
    now,
  });
  return getReviewTarget(id);
}

export function getReviewTarget(id) {
  return rowToCamel(db.prepare("SELECT * FROM review_targets WHERE id = ?").get(id));
}

export function listReviewTargets({ state, limit = 50 } = {}) {
  const where = ["1=1"];
  const params = { limit };
  if (state) { where.push("state = @state"); params.state = state; }
  return db.prepare(`SELECT * FROM review_targets WHERE ${where.join(" AND ")} ORDER BY updated_at DESC LIMIT @limit`)
    .all(params)
    .map(rowToCamel);
}

export function updateReviewTarget(id, patch) {
  const fields = [];
  const params = { id };
  for (const [k, v] of Object.entries(patch || {})) {
    params[k] = v;
    const col = k.replace(/[A-Z]/g, (m) => "_" + m.toLowerCase());
    fields.push(`${col} = @${k}`);
  }
  if (!fields.length) return getReviewTarget(id);
  fields.push("updated_at = datetime('now','localtime')");
  db.prepare(`UPDATE review_targets SET ${fields.join(", ")} WHERE id = @id`).run(params);
  return getReviewTarget(id);
}

// ========== review_findings ==========

export function createReviewFinding({ reviewTargetId, severity, code, filePath, lineNumber, title, detail }) {
  const id = newId("rf");
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO review_findings (id, review_target_id, severity, code, file_path, line_number, title, detail, created_at, updated_at)
    VALUES (@id, @reviewTargetId, @severity, @code, @filePath, @lineNumber, @title, @detail, @now, @now)
  `).run({
    id,
    reviewTargetId,
    severity: severity || "medium",
    code: code || null,
    filePath: filePath || null,
    lineNumber: lineNumber || null,
    title: title || "",
    detail: detail || null,
    now,
  });
  return getReviewFinding(id);
}

export function getReviewFinding(id) {
  return rowToCamel(db.prepare("SELECT * FROM review_findings WHERE id = ?").get(id));
}

export function listReviewFindings({ reviewTargetId, state, severity, limit = 200 } = {}) {
  const where = ["1=1"];
  const params = { limit };
  if (reviewTargetId) { where.push("review_target_id = @reviewTargetId"); params.reviewTargetId = reviewTargetId; }
  if (state) { where.push("state = @state"); params.state = state; }
  if (severity) { where.push("severity = @severity"); params.severity = severity; }
  return db.prepare(`SELECT * FROM review_findings WHERE ${where.join(" AND ")} ORDER BY created_at DESC LIMIT @limit`)
    .all(params)
    .map(rowToCamel);
}

export function updateReviewFinding(id, patch) {
  const fields = [];
  const params = { id };
  for (const [k, v] of Object.entries(patch || {})) {
    params[k] = v;
    const col = k.replace(/[A-Z]/g, (m) => "_" + m.toLowerCase());
    fields.push(`${col} = @${k}`);
  }
  if (!fields.length) return getReviewFinding(id);
  fields.push("updated_at = datetime('now','localtime')");
  db.prepare(`UPDATE review_findings SET ${fields.join(", ")} WHERE id = @id`).run(params);
  return getReviewFinding(id);
}

// ========== 概览 ==========

export function getOverviewCounts() {
  const drafts = db.prepare(`
    SELECT status, COUNT(*) AS count FROM task_drafts
    GROUP BY status
  `).all();
  const draftCounts = Object.fromEntries(drafts.map((r) => [r.status, r.count]));
  const batches = db.prepare(`
    SELECT status, COUNT(*) AS count FROM batch_creation_jobs
    GROUP BY status
  `).all();
  const batchCounts = Object.fromEntries(batches.map((r) => [r.status, r.count]));
  const manual = db.prepare(`
    SELECT status, COUNT(*) AS count FROM manual_intervention_cases
    GROUP BY status
  `).all();
  const manualCounts = Object.fromEntries(manual.map((r) => [r.status, r.count]));
  const queue = db.prepare(`
    SELECT pool, COUNT(*) AS count FROM execution_queue
    WHERE status IN ('queued','running')
    GROUP BY pool
  `).all();
  const queueCounts = Object.fromEntries(queue.map((r) => [r.pool, r.count]));
  return { draftCounts, batchCounts, manualCounts, queueCounts };
}

export default {
  // task_drafts
  createTaskDraft, getTaskDraft, getTaskDraftByIdempotencyKey, listTaskDrafts, updateTaskDraft,
  // batch_creation_jobs
  createBatchJob, getBatchJob, listBatchJobs, updateBatchJob,
  // batch_task_items
  createBatchTaskItem, getBatchTaskItem, listBatchTaskItems, updateBatchTaskItem,
  // candidates
  createCandidateAttempt, getCandidateAttempt, listCandidateAttempts, updateCandidateAttempt,
  // issues
  createValidationIssue, getValidationIssue, listValidationIssues, resolveValidationIssue,
  // manual
  createManualCase, getManualCase, listManualCases, updateManualCase,
  // snapshots
  createSnapshot, getSnapshot, listSnapshotsByFingerprint, listSnapshotsByTaskDraft,
  // story points
  createStoryPoint, getStoryPoint, getStoryPointByIdempotencyKey, listStoryPoints, updateStoryPoint,
  // execution queue
  enqueueExecution, getExecutionEntry, listExecutionQueue, updateExecutionEntry,
  // settings
  getSetting, setSetting, listSettings,
  // audit
  addAuditEvent, getAuditEvent, listAuditEvents,
  // review
  createReviewTarget, getReviewTarget, listReviewTargets, updateReviewTarget,
  createReviewFinding, getReviewFinding, listReviewFindings, updateReviewFinding,
  // overview
  getOverviewCounts,
};
