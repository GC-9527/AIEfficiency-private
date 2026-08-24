/**
 * 车型团队配置的局域网增量同步表。
 *
 * lan_sync_ops 同时承担不可变操作日志与 durable outbox；业务快照仍由
 * devbench_userdata 的共享行提供物化视图。其它表只保存投递水位、冲突、
 * 成员身份和本机草稿，不把同一 payload 为每个 peer 重复存储。
 */
export function applyLanSyncSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS lan_sync_ops (
      op_id TEXT PRIMARY KEY,
      config_space TEXT NOT NULL,
      change_set_id TEXT NOT NULL,
      change_set_index INTEGER NOT NULL DEFAULT 0,
      change_set_size INTEGER NOT NULL DEFAULT 1,
      change_set_hash TEXT NOT NULL DEFAULT '',
      origin_node_id TEXT NOT NULL,
      origin_seq INTEGER NOT NULL,
      entity_type TEXT NOT NULL,
      entity_key TEXT NOT NULL,
      action TEXT NOT NULL,
      base_revision TEXT NOT NULL,
      context_json TEXT NOT NULL DEFAULT '{}',
      hlc TEXT NOT NULL,
      actor_user_id TEXT,
      payload_json TEXT,
      payload_hash TEXT NOT NULL,
      schema_version INTEGER NOT NULL DEFAULT 1,
      signature TEXT,
      apply_status TEXT NOT NULL DEFAULT 'applied',
      created_at INTEGER NOT NULL,
      UNIQUE(origin_node_id, origin_seq)
    );

    CREATE INDEX IF NOT EXISTS idx_lan_sync_ops_space_origin_seq
      ON lan_sync_ops(config_space, origin_node_id, origin_seq);
    CREATE INDEX IF NOT EXISTS idx_lan_sync_ops_entity
      ON lan_sync_ops(config_space, entity_type, entity_key, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_lan_sync_ops_change_set
      ON lan_sync_ops(change_set_id, origin_seq);

    CREATE TABLE IF NOT EXISTS lan_sync_peer_cursors (
      peer_node_id TEXT NOT NULL,
      origin_node_id TEXT NOT NULL,
      acked_seq INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY(peer_node_id, origin_node_id)
    );

    CREATE TABLE IF NOT EXISTS lan_sync_peer_delivery (
      change_set_id TEXT NOT NULL,
      peer_node_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      attempts INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      acked_at INTEGER,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY(change_set_id, peer_node_id)
    );
    CREATE INDEX IF NOT EXISTS idx_lan_sync_delivery_status
      ON lan_sync_peer_delivery(status, updated_at);

    CREATE TABLE IF NOT EXISTS lan_sync_conflicts (
      conflict_id TEXT PRIMARY KEY,
      config_space TEXT NOT NULL,
      entity_type TEXT NOT NULL,
      entity_key TEXT NOT NULL,
      local_revision TEXT NOT NULL,
      remote_revision TEXT NOT NULL,
      local_payload TEXT,
      remote_payload TEXT,
      status TEXT NOT NULL DEFAULT 'open',
      resolved_by TEXT,
      resolved_at INTEGER,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_lan_sync_conflicts_status
      ON lan_sync_conflicts(config_space, status, created_at DESC);

    CREATE TABLE IF NOT EXISTS lan_sync_members (
      node_id TEXT PRIMARY KEY,
      node_name TEXT,
      public_key TEXT NOT NULL,
      certificate_fingerprint TEXT NOT NULL,
      config_spaces TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'active',
      host TEXT,
      last_seen_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_lan_sync_members_fingerprint
      ON lan_sync_members(certificate_fingerprint);

    CREATE TABLE IF NOT EXISTS lan_sync_drafts (
      draft_id TEXT PRIMARY KEY,
      owner_user_id TEXT NOT NULL,
      config_space TEXT NOT NULL,
      project_id TEXT NOT NULL,
      base_revision TEXT NOT NULL,
      changes_json TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_lan_sync_drafts_owner
      ON lan_sync_drafts(owner_user_id, config_space, updated_at DESC);

    CREATE TABLE IF NOT EXISTS lan_sync_idempotency (
      config_space TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      change_set_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY(config_space, idempotency_key)
    );

    CREATE TABLE IF NOT EXISTS lan_sync_nonces (
      peer_node_id TEXT NOT NULL,
      nonce TEXT NOT NULL,
      seen_at INTEGER NOT NULL,
      PRIMARY KEY(peer_node_id, nonce)
    );
    CREATE INDEX IF NOT EXISTS idx_lan_sync_nonces_seen
      ON lan_sync_nonces(seen_at);

    CREATE TABLE IF NOT EXISTS lan_sync_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  // 开发期数据库可能已经由较早版本创建。这里使用可重复执行的窄迁移，
  // 避免升级后把旧 durable outbox 直接丢弃。
  const opColumns = new Set(db.prepare("PRAGMA table_info(lan_sync_ops)").all().map((row) => row.name));
  for (const [name, definition] of [
    ["change_set_index", "INTEGER NOT NULL DEFAULT 0"],
    ["change_set_size", "INTEGER NOT NULL DEFAULT 1"],
    ["change_set_hash", "TEXT NOT NULL DEFAULT ''"],
  ]) {
    if (!opColumns.has(name)) db.exec(`ALTER TABLE lan_sync_ops ADD COLUMN ${name} ${definition}`);
  }
}
