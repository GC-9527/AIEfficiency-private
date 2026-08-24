import { createHash, randomUUID } from "node:crypto";
import db from "../../db/sqlite.js";
import { canonicalJson, signLanSyncValue } from "./identity.js";

function json(value, fallback = null) {
  try { return value == null ? fallback : JSON.parse(value); } catch { return fallback; }
}

function normalizeOp(row) {
  if (!row) return null;
  return {
    opId: row.op_id,
    configSpace: row.config_space,
    changeSetId: row.change_set_id,
    changeSetIndex: Number(row.change_set_index) || 0,
    changeSetSize: Math.max(1, Number(row.change_set_size) || 1),
    changeSetHash: row.change_set_hash || "",
    originNodeId: row.origin_node_id,
    originSeq: Number(row.origin_seq) || 0,
    entityType: row.entity_type,
    entityKey: row.entity_key,
    action: row.action,
    baseRevision: row.base_revision,
    context: json(row.context_json, {}),
    hlc: row.hlc,
    actorUserId: row.actor_user_id || "",
    payload: json(row.payload_json, null),
    payloadHash: row.payload_hash,
    schemaVersion: Number(row.schema_version) || 1,
    signature: row.signature || "",
    applyStatus: row.apply_status || "applied",
    createdAt: Number(row.created_at) || 0,
  };
}

function normalizeMember(row) {
  if (!row) return null;
  return {
    nodeId: row.node_id,
    nodeName: row.node_name || "",
    publicKey: row.public_key,
    certificateFingerprint: row.certificate_fingerprint,
    configSpaces: json(row.config_spaces, []),
    state: row.state,
    host: row.host || "",
    lastSeenAt: Number(row.last_seen_at) || 0,
    createdAt: Number(row.created_at) || 0,
    updatedAt: Number(row.updated_at) || 0,
  };
}

function normalizeDelivery(row) {
  return row ? {
    changeSetId: row.change_set_id,
    peerNodeId: row.peer_node_id,
    status: row.status,
    attempts: Number(row.attempts) || 0,
    lastError: row.last_error || "",
    ackedAt: Number(row.acked_at) || 0,
    updatedAt: Number(row.updated_at) || 0,
  } : null;
}

export function payloadHash(payload) {
  return createHash("sha256").update(canonicalJson(payload)).digest("hex");
}

export function operationSigningValue(op) {
  const value = {
    opId: op.opId,
    configSpace: op.configSpace,
    changeSetId: op.changeSetId,
    originNodeId: op.originNodeId,
    originSeq: Number(op.originSeq) || 0,
    entityType: op.entityType,
    entityKey: op.entityKey,
    action: op.action,
    baseRevision: String(op.baseRevision || "0"),
    context: op.context || {},
    hlc: op.hlc,
    actorUserId: op.actorUserId || "",
    payload: op.payload ?? null,
    payloadHash: op.payloadHash,
    schemaVersion: Number(op.schemaVersion) || 1,
    createdAt: Number(op.createdAt) || 0,
  };
  // 兼容本功能开发阶段已落盘的单 op：只有带 manifest 的新操作才把
  // manifest 字段纳入签名。新发布一律由 sealChangeSet() 填充。
  if (op.changeSetHash) {
    value.changeSetIndex = Number(op.changeSetIndex) || 0;
    value.changeSetSize = Math.max(1, Number(op.changeSetSize) || 1);
    value.changeSetHash = String(op.changeSetHash);
  }
  return value;
}

export function signOperation(op) {
  return signLanSyncValue(operationSigningValue(op));
}

export function changeSetManifestHash(ops = []) {
  const ordered = [...ops].sort((left, right) => (
    Number(left.changeSetIndex) - Number(right.changeSetIndex)
  ));
  const manifest = ordered.map((op) => {
    const value = operationSigningValue({ ...op, changeSetHash: "" });
    return {
      ...value,
      changeSetIndex: Number(op.changeSetIndex) || 0,
      changeSetSize: Math.max(1, Number(op.changeSetSize) || ordered.length || 1),
    };
  });
  return createHash("sha256").update(canonicalJson(manifest)).digest("hex");
}

export function sealChangeSet(ops = []) {
  const size = ops.length;
  if (!size) return ops;
  for (let index = 0; index < size; index++) {
    ops[index].changeSetIndex = index;
    ops[index].changeSetSize = size;
  }
  const manifestHash = changeSetManifestHash(ops);
  for (const op of ops) {
    op.changeSetHash = manifestHash;
    op.signature = signOperation(op);
  }
  return ops;
}

export function runLanSyncTransaction(work) {
  if (typeof work !== "function") throw new TypeError("LAN sync transaction callback required");
  return db.transaction(work).immediate();
}

/**
 * Forget transport history before this Gateway explicitly joins a new LAN group.
 *
 * The materialized vehicle/project configuration lives in devbench_userdata and
 * is deliberately preserved. Local origin sequence counters are also preserved
 * so this node never reuses a signed sequence number after joining the new group.
 */
export function resetLanSyncStateForJoin() {
  const tables = [
    ["peerDeliveries", "lan_sync_peer_delivery"],
    ["peerCursors", "lan_sync_peer_cursors"],
    ["conflicts", "lan_sync_conflicts"],
    ["drafts", "lan_sync_drafts"],
    ["idempotencyKeys", "lan_sync_idempotency"],
    ["nonces", "lan_sync_nonces"],
    ["members", "lan_sync_members"],
    ["operations", "lan_sync_ops"],
  ];
  return runLanSyncTransaction(() => {
    const discarded = {};
    for (const [key, table] of tables) {
      discarded[key] = Number(db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()?.count) || 0;
      db.prepare(`DELETE FROM ${table}`).run();
    }
    // Compaction floors describe the previous group. Advertising them in a new
    // group could falsely claim that this node has seen operations it never got.
    discarded.compactionFloors = db.prepare(
      "DELETE FROM lan_sync_meta WHERE key LIKE 'compaction-floor:%'",
    ).run().changes;
    return discarded;
  });
}

export function nextOriginSequence(originNodeId) {
  const key = `origin-seq:${String(originNodeId || "")}`;
  const current = Number(json(db.prepare("SELECT value FROM lan_sync_meta WHERE key=?").get(key)?.value, 0)) || 0;
  const next = current + 1;
  db.prepare(`
    INSERT INTO lan_sync_meta(key, value) VALUES(?, ?)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value
  `).run(key, JSON.stringify(next));
  return next;
}

export function currentVersionVector(configSpace) {
  const rows = db.prepare(`
    SELECT origin_node_id, MAX(origin_seq) AS seq
    FROM lan_sync_ops
    WHERE config_space=?
    GROUP BY origin_node_id
  `).all(configSpace);
  const vector = Object.fromEntries(rows.map((row) => [row.origin_node_id, Number(row.seq) || 0]));
  const floors = db.prepare("SELECT key, value FROM lan_sync_meta WHERE key LIKE 'compaction-floor:%'").all();
  for (const row of floors) {
    const originNodeId = String(row.key).slice("compaction-floor:".length);
    vector[originNodeId] = Math.max(Number(vector[originNodeId]) || 0, Number(json(row.value, 0)) || 0);
  }
  return vector;
}

export function compactionFloor(originNodeId) {
  return Number(json(db.prepare("SELECT value FROM lan_sync_meta WHERE key=?")
    .get(`compaction-floor:${String(originNodeId || "")}`)?.value, 0)) || 0;
}

function setCompactionFloor(originNodeId, sequence) {
  const key = `compaction-floor:${String(originNodeId || "")}`;
  const next = Math.max(compactionFloor(originNodeId), Number(sequence) || 0);
  db.prepare(`
    INSERT INTO lan_sync_meta(key,value) VALUES(?,?)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value
  `).run(key, JSON.stringify(next));
}

export function listOpsMissingFromVector(configSpace, vector = {}, { limit = 500 } = {}) {
  const boundedLimit = Math.max(1, Math.min(5000, Number(limit) || 500));
  const rows = db.prepare(`
    SELECT * FROM lan_sync_ops
    WHERE config_space=?
    ORDER BY origin_node_id ASC, origin_seq ASC
  `).all(configSpace);
  const missing = rows.map(normalizeOp)
    .filter((op) => op.originSeq > (Number(vector?.[op.originNodeId]) || 0));
  if (missing.length <= boundedLimit) return missing;
  let end = boundedLimit;
  const finalChangeSetId = missing[boundedLimit - 1]?.changeSetId;
  while (end < missing.length && missing[end]?.changeSetId === finalChangeSetId) end++;
  return missing.slice(0, end);
}

export function getOperation(opId) {
  return normalizeOp(db.prepare("SELECT * FROM lan_sync_ops WHERE op_id=?").get(String(opId || "")));
}

export function getEntityOperation(configSpace, entityType, entityKey) {
  return normalizeOp(db.prepare(`
    SELECT * FROM lan_sync_ops
    WHERE config_space=? AND entity_type=? AND entity_key=? AND apply_status='applied'
    ORDER BY rowid DESC
    LIMIT 1
  `).get(configSpace, entityType, entityKey));
}

export function getEntityRevision(configSpace, entityType, entityKey) {
  return getEntityOperation(configSpace, entityType, entityKey)?.opId || "0";
}

export function entityRevisions(configSpace, entityType, entityKeys = []) {
  return Object.fromEntries(entityKeys.map((entityKey) => [
    entityKey,
    getEntityRevision(configSpace, entityType, entityKey),
  ]));
}

export function insertOperation(op, applyStatus = "applied") {
  const value = operationSigningValue(op);
  const signature = String(op.signature || "");
  db.prepare(`
    INSERT OR IGNORE INTO lan_sync_ops (
      op_id, config_space, change_set_id, change_set_index, change_set_size,
      change_set_hash, origin_node_id, origin_seq,
      entity_type, entity_key, action, base_revision, context_json, hlc,
      actor_user_id, payload_json, payload_hash, schema_version, signature,
      apply_status, created_at
    ) VALUES (
      @opId, @configSpace, @changeSetId, @changeSetIndex, @changeSetSize,
      @changeSetHash, @originNodeId, @originSeq,
      @entityType, @entityKey, @action, @baseRevision, @contextJson, @hlc,
      @actorUserId, @payloadJson, @payloadHash, @schemaVersion, @signature,
      @applyStatus, @createdAt
    )
  `).run({
    ...value,
    changeSetIndex: Number(op.changeSetIndex) || 0,
    changeSetSize: Math.max(1, Number(op.changeSetSize) || 1),
    changeSetHash: String(op.changeSetHash || ""),
    contextJson: JSON.stringify(value.context || {}),
    payloadJson: value.payload == null ? null : JSON.stringify(value.payload),
    signature,
    applyStatus,
  });
  return getOperation(op.opId);
}

export function createLocalOperation({
  configSpace,
  changeSetId,
  originNodeId,
  entityType,
  entityKey,
  action,
  baseRevision,
  context,
  actorUserId,
  payload,
  createdAt = Date.now(),
  schemaVersion = 1,
}) {
  const originSeq = nextOriginSequence(originNodeId);
  const op = {
    opId: randomUUID(),
    configSpace,
    changeSetId,
    changeSetIndex: 0,
    changeSetSize: 1,
    changeSetHash: "",
    originNodeId,
    originSeq,
    entityType,
    entityKey,
    action,
    baseRevision: String(baseRevision || "0"),
    context: context || {},
    hlc: `${createdAt}-${originSeq}-${originNodeId}`,
    actorUserId: String(actorUserId || ""),
    payload: payload ?? null,
    payloadHash: payloadHash(payload ?? null),
    schemaVersion,
    createdAt,
  };
  return op;
}

export function findIdempotentChangeSet(configSpace, idempotencyKey) {
  const row = db.prepare(`
    SELECT change_set_id FROM lan_sync_idempotency
    WHERE config_space=? AND idempotency_key=?
  `).get(configSpace, idempotencyKey);
  return row?.change_set_id || "";
}

export function recordIdempotency(configSpace, idempotencyKey, changeSetId) {
  db.prepare(`
    INSERT INTO lan_sync_idempotency(config_space, idempotency_key, change_set_id, created_at)
    VALUES(?,?,?,?)
  `).run(configSpace, idempotencyKey, changeSetId, Date.now());
}

export function listChangeSetOps(changeSetId) {
  return db.prepare(`
    SELECT * FROM lan_sync_ops WHERE change_set_id=?
    ORDER BY origin_node_id ASC, origin_seq ASC
  `).all(changeSetId).map(normalizeOp);
}

export function upsertMember(input = {}) {
  const now = Date.now();
  const nodeId = String(input.nodeId || "").trim();
  if (!nodeId) throw new Error("成员 nodeId 不能为空");
  const configSpaces = [...new Set((Array.isArray(input.configSpaces) ? input.configSpaces : [])
    .map((value) => String(value || "").trim()).filter(Boolean))];
  db.prepare(`
    INSERT INTO lan_sync_members (
      node_id, node_name, public_key, certificate_fingerprint, config_spaces,
      state, host, last_seen_at, created_at, updated_at
    ) VALUES (
      @nodeId, @nodeName, @publicKey, @fingerprint, @configSpaces,
      @state, @host, @lastSeenAt, @createdAt, @updatedAt
    )
    ON CONFLICT(node_id) DO UPDATE SET
      node_name=excluded.node_name,
      public_key=excluded.public_key,
      certificate_fingerprint=excluded.certificate_fingerprint,
      config_spaces=excluded.config_spaces,
      state=excluded.state,
      host=CASE WHEN excluded.host<>'' THEN excluded.host ELSE lan_sync_members.host END,
      last_seen_at=MAX(COALESCE(lan_sync_members.last_seen_at,0), COALESCE(excluded.last_seen_at,0)),
      updated_at=excluded.updated_at
  `).run({
    nodeId,
    nodeName: String(input.nodeName || ""),
    publicKey: String(input.publicKey || ""),
    fingerprint: String(input.certificateFingerprint || ""),
    configSpaces: JSON.stringify(configSpaces),
    state: ["active", "revoked", "retired"].includes(input.state) ? input.state : "active",
    host: String(input.host || ""),
    lastSeenAt: Number(input.lastSeenAt) || 0,
    createdAt: Number(input.createdAt) || now,
    updatedAt: now,
  });
  return getMember(nodeId);
}

export function getMember(nodeId) {
  return normalizeMember(db.prepare("SELECT * FROM lan_sync_members WHERE node_id=?").get(String(nodeId || "")));
}

export function listMembers(configSpace = "") {
  return db.prepare("SELECT * FROM lan_sync_members ORDER BY node_name ASC, node_id ASC")
    .all().map(normalizeMember)
    .filter((member) => !configSpace || member.configSpaces.includes(configSpace));
}

export function setMemberState(nodeId, state) {
  if (!["active", "revoked", "retired"].includes(state)) throw new Error("成员状态不合法");
  db.prepare("UPDATE lan_sync_members SET state=?, updated_at=? WHERE node_id=?")
    .run(state, Date.now(), nodeId);
  return getMember(nodeId);
}

export function touchMember(nodeId, { host = "", seenAt = Date.now() } = {}) {
  db.prepare(`
    UPDATE lan_sync_members
    SET host=CASE WHEN ?<>'' THEN ? ELSE host END,
        last_seen_at=MAX(COALESCE(last_seen_at,0), ?),
        updated_at=?
    WHERE node_id=?
  `).run(host, host, seenAt, Date.now(), nodeId);
}

export function createPendingDeliveries(changeSetId, configSpace, originNodeId) {
  const now = Date.now();
  const members = listMembers(configSpace)
    .filter((member) => member.nodeId !== originNodeId && member.state === "active");
  const insert = db.prepare(`
    INSERT OR IGNORE INTO lan_sync_peer_delivery(
      change_set_id, peer_node_id, status, attempts, last_error, acked_at, updated_at
    ) VALUES(?, ?, 'pending', 0, '', NULL, ?)
  `);
  for (const member of members) insert.run(changeSetId, member.nodeId, now);
  return members;
}

export function markDelivery(changeSetId, peerNodeId, status, { error = "", acknowledgedAt = 0 } = {}) {
  const now = Date.now();
  db.prepare(`
    INSERT INTO lan_sync_peer_delivery(
      change_set_id, peer_node_id, status, attempts, last_error, acked_at, updated_at
    ) VALUES(@changeSetId,@peerNodeId,@status,1,@lastError,@ackedAt,@updatedAt)
    ON CONFLICT(change_set_id,peer_node_id) DO UPDATE SET
      status=excluded.status,
      attempts=lan_sync_peer_delivery.attempts + CASE WHEN excluded.status='sent' THEN 1 ELSE 0 END,
      last_error=excluded.last_error,
      acked_at=CASE WHEN excluded.acked_at IS NOT NULL THEN excluded.acked_at ELSE lan_sync_peer_delivery.acked_at END,
      updated_at=excluded.updated_at
  `).run({
    changeSetId,
    peerNodeId,
    status,
    lastError: String(error || ""),
    ackedAt: acknowledgedAt || null,
    updatedAt: now,
  });
}

export function listDeliveries(changeSetId) {
  return db.prepare(`
    SELECT * FROM lan_sync_peer_delivery
    WHERE change_set_id=?
    ORDER BY peer_node_id ASC
  `).all(changeSetId).map(normalizeDelivery);
}

export function listOutstandingChangeSetsForPeer(peerNodeId, configSpace) {
  return db.prepare(`
    SELECT DISTINCT d.change_set_id
    FROM lan_sync_peer_delivery d
    JOIN lan_sync_ops o ON o.change_set_id=d.change_set_id
    WHERE d.peer_node_id=?
      AND o.config_space=?
      AND d.status NOT IN ('applied','conflict')
    ORDER BY d.updated_at ASC
  `).all(peerNodeId, configSpace).map((row) => row.change_set_id);
}

export function updatePeerCursor(peerNodeId, vector = {}) {
  const now = Date.now();
  const statement = db.prepare(`
    INSERT INTO lan_sync_peer_cursors(peer_node_id, origin_node_id, acked_seq, updated_at)
    VALUES(?,?,?,?)
    ON CONFLICT(peer_node_id,origin_node_id) DO UPDATE SET
      acked_seq=MAX(lan_sync_peer_cursors.acked_seq, excluded.acked_seq),
      updated_at=excluded.updated_at
  `);
  for (const [originNodeId, seq] of Object.entries(vector || {})) {
    statement.run(peerNodeId, originNodeId, Math.max(0, Number(seq) || 0), now);
  }
}

export function createConflict({
  configSpace,
  entityType,
  entityKey,
  localRevision,
  remoteRevision,
  localPayload,
  remotePayload,
}) {
  const conflictId = randomUUID();
  db.prepare(`
    INSERT INTO lan_sync_conflicts(
      conflict_id, config_space, entity_type, entity_key, local_revision,
      remote_revision, local_payload, remote_payload, status, created_at
    ) VALUES(?,?,?,?,?,?,?,?, 'open', ?)
  `).run(
    conflictId,
    configSpace,
    entityType,
    entityKey,
    localRevision,
    remoteRevision,
    localPayload == null ? null : JSON.stringify(localPayload),
    remotePayload == null ? null : JSON.stringify(remotePayload),
    Date.now(),
  );
  return getConflict(conflictId);
}

export function getConflict(conflictId) {
  const row = db.prepare("SELECT * FROM lan_sync_conflicts WHERE conflict_id=?").get(conflictId);
  return row ? {
    conflictId: row.conflict_id,
    configSpace: row.config_space,
    entityType: row.entity_type,
    entityKey: row.entity_key,
    localRevision: row.local_revision,
    remoteRevision: row.remote_revision,
    localPayload: json(row.local_payload, null),
    remotePayload: json(row.remote_payload, null),
    status: row.status,
    resolvedBy: row.resolved_by || "",
    resolvedAt: Number(row.resolved_at) || 0,
    createdAt: Number(row.created_at) || 0,
  } : null;
}

export function listConflicts(configSpace, { status = "open" } = {}) {
  return db.prepare(`
    SELECT conflict_id FROM lan_sync_conflicts
    WHERE config_space=? AND (?='' OR status=?)
    ORDER BY created_at DESC
  `).all(configSpace, status, status).map((row) => getConflict(row.conflict_id));
}

export function resolveConflictRecord(conflictId, resolvedBy) {
  db.prepare(`
    UPDATE lan_sync_conflicts
    SET status='resolved', resolved_by=?, resolved_at=?
    WHERE conflict_id=? AND status='open'
  `).run(String(resolvedBy || ""), Date.now(), conflictId);
  return getConflict(conflictId);
}

export function resolveConflictsByRevisions({
  configSpace,
  entityType,
  entityKey,
  revisions = [],
  resolvedBy = "",
} = {}) {
  const resolvedRevisions = new Set((Array.isArray(revisions) ? revisions : [])
    .map((value) => String(value || "").trim())
    .filter(Boolean));
  if (resolvedRevisions.size < 2) return [];
  const matches = listConflicts(String(configSpace || "")).filter((conflict) => (
    conflict.entityType === String(entityType || "")
    && conflict.entityKey === String(entityKey || "")
    && resolvedRevisions.has(conflict.localRevision)
    && resolvedRevisions.has(conflict.remoteRevision)
  ));
  for (const conflict of matches) resolveConflictRecord(conflict.conflictId, resolvedBy);
  return matches.map((conflict) => conflict.conflictId);
}

export function saveDraft({
  draftId = randomUUID(),
  ownerUserId,
  configSpace,
  projectId,
  baseRevision,
  changes,
}) {
  const now = Date.now();
  db.prepare(`
    INSERT INTO lan_sync_drafts(
      draft_id, owner_user_id, config_space, project_id, base_revision,
      changes_json, created_at, updated_at
    ) VALUES(?,?,?,?,?,?,?,?)
    ON CONFLICT(draft_id) DO UPDATE SET
      base_revision=excluded.base_revision,
      changes_json=excluded.changes_json,
      updated_at=excluded.updated_at
    WHERE lan_sync_drafts.owner_user_id=excluded.owner_user_id
  `).run(
    draftId,
    ownerUserId,
    configSpace,
    projectId,
    String(baseRevision || "0"),
    JSON.stringify(changes || []),
    now,
    now,
  );
  return getDraft(draftId, ownerUserId);
}

export function getDraft(draftId, ownerUserId = "") {
  const row = ownerUserId
    ? db.prepare("SELECT * FROM lan_sync_drafts WHERE draft_id=? AND owner_user_id=?").get(draftId, ownerUserId)
    : db.prepare("SELECT * FROM lan_sync_drafts WHERE draft_id=?").get(draftId);
  return row ? {
    draftId: row.draft_id,
    ownerUserId: row.owner_user_id,
    configSpace: row.config_space,
    projectId: row.project_id,
    baseRevision: row.base_revision,
    changes: json(row.changes_json, []),
    createdAt: Number(row.created_at) || 0,
    updatedAt: Number(row.updated_at) || 0,
  } : null;
}

export function deleteDraft(draftId, ownerUserId) {
  return db.prepare("DELETE FROM lan_sync_drafts WHERE draft_id=? AND owner_user_id=?")
    .run(draftId, ownerUserId).changes;
}

export function rememberNonce(peerNodeId, nonce, { now = Date.now(), maxAgeMs = 5 * 60_000 } = {}) {
  db.prepare("DELETE FROM lan_sync_nonces WHERE seen_at<?").run(now - maxAgeMs);
  const result = db.prepare(`
    INSERT OR IGNORE INTO lan_sync_nonces(peer_node_id, nonce, seen_at)
    VALUES(?,?,?)
  `).run(peerNodeId, nonce, now);
  return result.changes === 1;
}

export function publicationStatus(changeSetId) {
  const ops = listChangeSetOps(changeSetId);
  if (!ops.length) return null;
  const deliveries = listDeliveries(changeSetId);
  const counts = { applied: 1, pending: 0, offline: 0, conflict: 0, failed: 0, sent: 0 };
  for (const delivery of deliveries) {
    if (Object.hasOwn(counts, delivery.status)) counts[delivery.status] += 1;
  }
  return {
    changeSetId,
    configSpace: ops[0].configSpace,
    originNodeId: ops[0].originNodeId,
    createdAt: Math.min(...ops.map((op) => op.createdAt)),
    ops,
    deliveries,
    ...counts,
  };
}

export function lanSyncMetrics(configSpace) {
  const now = Date.now();
  const pending = db.prepare(`
    SELECT COUNT(*) AS count, MIN(created_at) AS oldest
    FROM (
      SELECT d.change_set_id, d.peer_node_id, MIN(o.created_at) AS created_at
      FROM lan_sync_peer_delivery d
      JOIN lan_sync_ops o ON o.change_set_id=d.change_set_id
      WHERE o.config_space=? AND d.status IN ('pending','sent','offline','failed')
      GROUP BY d.change_set_id, d.peer_node_id
    )
  `).get(configSpace);
  return {
    lan_sync_outbox_pending: Number(pending?.count) || 0,
    lan_sync_oldest_pending_seconds: pending?.oldest
      ? Math.max(0, Math.floor((now - Number(pending.oldest)) / 1000))
      : 0,
    lan_sync_conflicts_total: Number(db.prepare(`
      SELECT COUNT(*) AS count FROM lan_sync_conflicts WHERE config_space=?
    `).get(configSpace)?.count) || 0,
    lan_sync_ops_sent_total: Number(db.prepare(`
      SELECT COALESCE(SUM(attempts),0) AS count FROM (
        SELECT d.change_set_id, d.peer_node_id, MAX(d.attempts) AS attempts
        FROM lan_sync_peer_delivery d
        JOIN lan_sync_ops o ON o.change_set_id=d.change_set_id
        WHERE o.config_space=?
        GROUP BY d.change_set_id, d.peer_node_id
      )
    `).get(configSpace)?.count) || 0,
    lan_sync_ops_deduplicated_total: Number(json(
      db.prepare("SELECT value FROM lan_sync_meta WHERE key='deduplicated-total'").get()?.value,
      0,
    )) || 0,
    lan_sync_signature_failures_total: Number(json(
      db.prepare("SELECT value FROM lan_sync_meta WHERE key='signature-failures-total'").get()?.value,
      0,
    )) || 0,
    lan_sync_apply_latency_ms: metricAverage("apply-latency"),
    lan_sync_ack_latency_ms: metricAverage("ack-latency"),
    lan_sync_snapshot_bytes_total: metricValue("snapshot-bytes-total"),
    lan_sync_delta_bytes_total: metricValue("delta-bytes-total"),
    lan_sync_peer_vector_lag: peerVectorLag(configSpace),
  };
}

function metricAverage(prefix) {
  const count = metricValue(`${prefix}-count`);
  return count > 0 ? Math.round((metricValue(`${prefix}-sum`) / count) * 100) / 100 : 0;
}

function peerVectorLag(configSpace) {
  const local = currentVersionVector(configSpace);
  let lag = 0;
  for (const member of listMembers(configSpace).filter((row) => row.state === "active")) {
    const cursors = db.prepare(`
      SELECT origin_node_id, acked_seq FROM lan_sync_peer_cursors WHERE peer_node_id=?
    `).all(member.nodeId);
    const remote = Object.fromEntries(cursors.map((row) => [row.origin_node_id, Number(row.acked_seq) || 0]));
    for (const [originNodeId, sequence] of Object.entries(local)) {
      lag += Math.max(0, Number(sequence) - (Number(remote[originNodeId]) || 0));
    }
  }
  return lag;
}

export function metricValue(key) {
  return Number(json(db.prepare("SELECT value FROM lan_sync_meta WHERE key=?").get(String(key || ""))?.value, 0)) || 0;
}

export function setMetric(key, value) {
  db.prepare(`
    INSERT INTO lan_sync_meta(key,value) VALUES(?,?)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value
  `).run(String(key || ""), JSON.stringify(Number(value) || 0));
}

export function incrementMetric(key, by = 1) {
  const current = metricValue(key);
  db.prepare(`
    INSERT INTO lan_sync_meta(key,value) VALUES(?,?)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value
  `).run(key, JSON.stringify(current + by));
}

export function compactOperationLog(configSpace, {
  retentionDays = 30,
  now = Date.now(),
} = {}) {
  const days = Math.max(1, Math.min(365, Number(retentionDays) || 30));
  const cutoff = now - days * 24 * 60 * 60_000;
  const activeMembers = listMembers(configSpace).filter((member) => member.state === "active");
  const cursors = new Map(activeMembers.map((member) => [
    member.nodeId,
    Object.fromEntries(db.prepare(`
      SELECT origin_node_id, acked_seq FROM lan_sync_peer_cursors WHERE peer_node_id=?
    `).all(member.nodeId).map((row) => [row.origin_node_id, Number(row.acked_seq) || 0])),
  ]));
  const eligible = db.prepare(`
    SELECT o.op_id, o.change_set_id, o.origin_node_id, o.origin_seq
    FROM lan_sync_ops o
    WHERE o.config_space=?
      AND o.created_at<?
      AND o.apply_status IN ('applied','superseded')
      AND o.rowid NOT IN (
        SELECT MAX(rowid) FROM lan_sync_ops
        WHERE config_space=? AND apply_status IN ('applied','superseded')
        GROUP BY entity_type, entity_key
      )
      AND o.op_id NOT IN (
        SELECT local_revision FROM lan_sync_conflicts WHERE status='open'
        UNION
        SELECT remote_revision FROM lan_sync_conflicts WHERE status='open'
      )
    ORDER BY o.origin_node_id, o.origin_seq
  `).all(configSpace, cutoff, configSpace).filter((op) => (
    activeMembers.every((member) => (
      Number(cursors.get(member.nodeId)?.[op.origin_node_id] || 0) >= Number(op.origin_seq || 0)
    ))
  ));
  const eligibleByChangeSet = new Map();
  for (const op of eligible) {
    if (!eligibleByChangeSet.has(op.change_set_id)) eligibleByChangeSet.set(op.change_set_id, []);
    eligibleByChangeSet.get(op.change_set_id).push(op);
  }
  const totalByChangeSet = new Map(db.prepare(`
    SELECT change_set_id, COUNT(*) AS count
    FROM lan_sync_ops
    WHERE config_space=?
    GROUP BY change_set_id
  `).all(configSpace).map((row) => [row.change_set_id, Number(row.count) || 0]));
  // A signed change set is the atomic transport unit. Never leave only part of its
  // manifest on disk: a reconnecting or new peer would correctly reject that
  // truncated manifest even if the removed operations were already acknowledged.
  const compactedChangeSets = [...eligibleByChangeSet.entries()]
    .filter(([changeSetId, ops]) => ops.length === totalByChangeSet.get(changeSetId));
  const candidates = compactedChangeSets.flatMap(([, ops]) => ops);
  if (!candidates.length) return { deleted: 0, retentionDays: days, floors: {} };
  const floors = {};
  runLanSyncTransaction(() => {
    const remove = db.prepare("DELETE FROM lan_sync_ops WHERE op_id=?");
    for (const op of candidates) {
      remove.run(op.op_id);
      floors[op.origin_node_id] = Math.max(
        Number(floors[op.origin_node_id]) || 0,
        Number(op.origin_seq) || 0,
      );
    }
    const removeDeliveries = db.prepare("DELETE FROM lan_sync_peer_delivery WHERE change_set_id=?");
    for (const [changeSetId] of compactedChangeSets) removeDeliveries.run(changeSetId);
    for (const [originNodeId, sequence] of Object.entries(floors)) {
      setCompactionFloor(originNodeId, sequence);
    }
    incrementMetric("compacted-ops-total", candidates.length);
  });
  return { deleted: candidates.length, retentionDays: days, floors };
}
