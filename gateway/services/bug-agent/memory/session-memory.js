/**
 * L1 会话记忆 + 工程师画像（方案 §2 §7 §9.4 §10.1）
 *
 * session_memory TTL: case 级 7 天
 * engineer_profile: 永久 + 离职 90 天软删除
 */

const SESSION_TTL_DAYS = 7;
const OFFBOARD_COOLDOWN_DAYS = 90;

function nowUtc() {
  return new Date().toISOString();
}
function isoDaysFromNow(d) {
  return new Date(Date.now() + d * 86400_000).toISOString();
}

// ---------- session_memory ----------

export function appendSessionMemory(storage, { session_id, case_id, content }) {
  if (!session_id || !content) throw new Error("session_id/content required");
  const common = storage.openCommon();
  const expires_at = isoDaysFromNow(SESSION_TTL_DAYS);
  const info = common
    .prepare(
      "INSERT INTO session_memory (session_id, case_id, content, expires_at) VALUES (?, ?, ?, ?)"
    )
    .run(session_id, case_id ?? null, content, expires_at);
  return { id: info.lastInsertRowid, expires_at };
}

export function listSessionMemory(storage, { session_id, case_id, limit = 50 }) {
  const common = storage.openCommon();
  const rows = common
    .prepare(
      `SELECT * FROM session_memory
       WHERE session_id = ? AND expires_at > ?
         AND (? IS NULL OR case_id = ?)
       ORDER BY id DESC LIMIT ?`
    )
    .all(session_id, nowUtc(), case_id ?? null, case_id ?? null, limit);
  return rows;
}

/**
 * 每日 cron：清理过期 session_memory（§9.1）
 */
export function cronCleanupExpiredSessions(storage) {
  const common = storage.openCommon();
  const info = common.prepare("DELETE FROM session_memory WHERE expires_at <= ?").run(nowUtc());
  return { deleted: info.changes };
}

// ---------- engineer_profile ----------

/**
 * 获取/创建 profile（懒初始化）。
 */
export function getOrCreateProfile(storage, user_id) {
  if (!user_id) throw new Error("user_id required");
  const common = storage.openCommon();
  const existing = common.prepare("SELECT * FROM engineer_profile WHERE user_id = ?").get(user_id);
  if (existing) return existing;
  common
    .prepare(
      "INSERT INTO engineer_profile (user_id, expertise, preferred_tools, contribution_score) VALUES (?, '[]', '[]', 0)"
    )
    .run(user_id);
  return common.prepare("SELECT * FROM engineer_profile WHERE user_id = ?").get(user_id);
}

/**
 * 仅累加正向字段（§9.4 只记正向能力）。
 */
export function addExpertise(storage, user_id, tag) {
  const p = getOrCreateProfile(storage, user_id);
  const set = new Set(safeJson(p.expertise) || []);
  set.add(tag);
  const common = storage.openCommon();
  common
    .prepare(
      "UPDATE engineer_profile SET expertise=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE user_id=?"
    )
    .run(JSON.stringify([...set]), user_id);
}

export function addContribution(storage, user_id, delta = 1) {
  getOrCreateProfile(storage, user_id);
  const common = storage.openCommon();
  common
    .prepare(
      `UPDATE engineer_profile SET contribution_score=contribution_score+?,
         updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
       WHERE user_id=?`
    )
    .run(delta, user_id);
}

/**
 * 自查看（§9.4 透明度）
 */
export function selfProfile(storage, user_id) {
  const common = storage.openCommon();
  const row = common.prepare("SELECT * FROM engineer_profile WHERE user_id = ? AND archived_at IS NULL").get(user_id);
  if (!row) return null;
  return {
    user_id: row.user_id,
    expertise: safeJson(row.expertise) || [],
    preferred_tools: safeJson(row.preferred_tools) || [],
    contribution_score: row.contribution_score,
    updated_at: row.updated_at,
  };
}

/**
 * 软删除（离职触发）
 */
export function offboardProfile(storage, user_id) {
  const common = storage.openCommon();
  common.prepare("UPDATE engineer_profile SET archived_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE user_id=?").run(user_id);
}

/**
 * 离职再入职：清除 archived_at（管理员审核后调用）
 */
export function reactivateProfile(storage, user_id) {
  const common = storage.openCommon();
  common.prepare("UPDATE engineer_profile SET archived_at=NULL WHERE user_id=?").run(user_id);
}

/**
 * PII 擦除（§4.5 GDPR 风格）
 * - 删除 engineer_profile 的详细字段
 * - 把 cases.reporter_id / ratings.rater_id 置 NULL
 * - 写 purge_log
 */
export function purgeUser(storage, user_id, operator = "admin") {
  const common = storage.openCommon();

  // 跨库擦除 reporter_id / rater_id
  for (const [pkg, db] of storage.apps) {
    db.prepare("UPDATE cases SET reporter_id=NULL WHERE reporter_id=?").run(user_id);
    db.prepare("UPDATE ratings SET rater_id=NULL WHERE rater_id=?").run(user_id);
  }

  common.prepare("DELETE FROM engineer_profile WHERE user_id=?").run(user_id);
  common
    .prepare("INSERT INTO purge_log (scope, target, operator) VALUES ('reporter_id', ?, ?)")
    .run(user_id, operator);
}

function safeJson(s) {
  if (!s) return null;
  try { return JSON.parse(s); } catch { return null; }
}
