/**
 * Bug Agent 数据库 schema（方案 §4.2 / §7.7 / §10.1 / §10.2）
 *
 * 两类库：
 *   common.db    - 中央目录、运行时状态、画像、会话记忆、成本、审计
 *   apps/*.db    - 应用专属 cases/evidence/reports/ratings/rules/tree
 *   quarantine.db - 未登记包的暂存，schema 与 apps 库相同
 *
 * 所有时间戳统一 UTC（方案 §10.7）。
 */

// ---------- common.db ----------

export const SCHEMA_COMMON = `
PRAGMA journal_mode = WAL;

CREATE TABLE IF NOT EXISTS case_catalog (
  tb_id         TEXT PRIMARY KEY,
  package_name  TEXT NOT NULL,
  component_tag TEXT,
  db_path       TEXT NOT NULL,
  title         TEXT,
  category      TEXT,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_catalog_pkg ON case_catalog(package_name);
CREATE INDEX IF NOT EXISTS idx_catalog_component ON case_catalog(component_tag);

CREATE TABLE IF NOT EXISTS task_state (
  task_id     TEXT PRIMARY KEY,
  tb_id       TEXT UNIQUE NOT NULL,
  status      TEXT NOT NULL,        -- pending / running / succeeded / failed
  progress    REAL DEFAULT 0,
  result_ref  TEXT,                 -- report_id 或错误说明
  error_code  TEXT,
  raw_output  TEXT,
  attempt     INTEGER DEFAULT 0,
  degraded    INTEGER DEFAULT 0,    -- 1 = LLM 降级
  started_at  TEXT,
  updated_at  TEXT
);
CREATE INDEX IF NOT EXISTS idx_task_status ON task_state(status);

CREATE TABLE IF NOT EXISTS engineer_profile (
  user_id            TEXT PRIMARY KEY,
  expertise          TEXT,         -- JSON array
  preferred_tools    TEXT,         -- JSON array
  contribution_score REAL DEFAULT 0,
  archived_at        TEXT,
  updated_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS session_memory (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  case_id    INTEGER,
  content    TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_session_expires ON session_memory(expires_at);

CREATE TABLE IF NOT EXISTS llm_cost_daily (
  date           TEXT PRIMARY KEY,   -- UTC YYYY-MM-DD
  tokens_in      INTEGER DEFAULT 0,
  tokens_out     INTEGER DEFAULT 0,
  usd            REAL DEFAULT 0,
  degraded_count INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS purge_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  scope       TEXT NOT NULL,       -- reporter_id / tb_id
  target      TEXT NOT NULL,
  operator    TEXT,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS migration_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  package_name TEXT NOT NULL,
  src_count   INTEGER,
  dst_count   INTEGER,
  status      TEXT,
  note        TEXT,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS retraction_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  report_id   INTEGER NOT NULL,
  reason      TEXT,
  operator    TEXT,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS rules_common (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  pattern      TEXT NOT NULL,
  category     TEXT NOT NULL,
  sub_category TEXT,
  conclusion   TEXT,
  rule_score   REAL DEFAULT 1.0,
  hit_count    INTEGER DEFAULT 0,
  status       TEXT DEFAULT 'active',
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS memory_tree_common (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  parent_id   INTEGER,
  level       INTEGER NOT NULL,
  title       TEXT NOT NULL,
  summary     TEXT,
  weight      REAL DEFAULT 1.0,
  hit_count   INTEGER DEFAULT 0,
  version     INTEGER DEFAULT 1,
  status      TEXT DEFAULT 'active',
  last_hit_at TEXT,
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
`;

// ---------- apps/*.db 与 quarantine.db 共用 schema ----------

export const SCHEMA_APP = `
PRAGMA journal_mode = WAL;

CREATE TABLE IF NOT EXISTS cases (
  id                          INTEGER PRIMARY KEY AUTOINCREMENT,
  tb_id                       TEXT UNIQUE NOT NULL,
  package_name                TEXT NOT NULL,
  title                       TEXT,
  raw_content                 TEXT NOT NULL,
  category                    TEXT,
  sub_category                TEXT,
  confidence                  REAL,
  exception_class             TEXT,
  error_code                  TEXT,
  log_tag                     TEXT,
  process_name                TEXT,
  signal                      TEXT,
  reporter_id                 TEXT,
  suspicious_prompt_injection INTEGER DEFAULT 0,
  legal_hold                  INTEGER DEFAULT 0,
  migrated_to                 TEXT,
  migrated_at                 TEXT,
  source_time                 TEXT,
  created_at                  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  analyzed_at                 TEXT
);

CREATE VIRTUAL TABLE IF NOT EXISTS cases_fts USING fts5(
  tb_id, title, raw_content,
  exception_class, error_code, log_tag, process_name,
  content=cases, content_rowid=id,
  tokenize='unicode61 remove_diacritics 2'
);

-- FTS 同步触发器
CREATE TRIGGER IF NOT EXISTS cases_ai AFTER INSERT ON cases BEGIN
  INSERT INTO cases_fts(rowid, tb_id, title, raw_content,
    exception_class, error_code, log_tag, process_name)
  VALUES (new.id, new.tb_id, new.title, new.raw_content,
    new.exception_class, new.error_code, new.log_tag, new.process_name);
END;
CREATE TRIGGER IF NOT EXISTS cases_ad AFTER DELETE ON cases BEGIN
  INSERT INTO cases_fts(cases_fts, rowid, tb_id, title, raw_content,
    exception_class, error_code, log_tag, process_name)
  VALUES ('delete', old.id, old.tb_id, old.title, old.raw_content,
    old.exception_class, old.error_code, old.log_tag, old.process_name);
END;
CREATE TRIGGER IF NOT EXISTS cases_au AFTER UPDATE ON cases BEGIN
  INSERT INTO cases_fts(cases_fts, rowid, tb_id, title, raw_content,
    exception_class, error_code, log_tag, process_name)
  VALUES ('delete', old.id, old.tb_id, old.title, old.raw_content,
    old.exception_class, old.error_code, old.log_tag, old.process_name);
  INSERT INTO cases_fts(rowid, tb_id, title, raw_content,
    exception_class, error_code, log_tag, process_name)
  VALUES (new.id, new.tb_id, new.title, new.raw_content,
    new.exception_class, new.error_code, new.log_tag, new.process_name);
END;

CREATE TABLE IF NOT EXISTS evidence_spans (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  case_id               INTEGER NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  source_type           TEXT NOT NULL,
  source_sha256         TEXT NOT NULL,
  archived_path         TEXT NOT NULL,
  line_start            INTEGER,
  line_end              INTEGER,
  text_snapshot         TEXT NOT NULL,
  tag                   TEXT,
  owner_package         TEXT,
  ownership_confidence  REAL DEFAULT 1.0,
  source_time           TEXT,
  ingested_at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  retention_until       TEXT
);
CREATE INDEX IF NOT EXISTS idx_evidence_case ON evidence_spans(case_id);
CREATE INDEX IF NOT EXISTS idx_evidence_sha ON evidence_spans(source_sha256);
CREATE INDEX IF NOT EXISTS idx_evidence_owner ON evidence_spans(case_id, owner_package);

CREATE TABLE IF NOT EXISTS rules (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  pattern      TEXT NOT NULL,
  category     TEXT NOT NULL,
  sub_category TEXT,
  conclusion   TEXT,
  rule_score   REAL DEFAULT 1.0,
  hit_count    INTEGER DEFAULT 0,
  status       TEXT DEFAULT 'active',
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS reports (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  case_id             INTEGER NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  content             TEXT NOT NULL,
  evidence_refs       TEXT,                -- JSON array of evidence_span ids
  matched_rules       TEXT,                -- JSON
  matched_tree_nodes  TEXT,                -- JSON: [{node_id, version}]
  decision_trace      TEXT,                -- JSON
  is_degraded         INTEGER DEFAULT 0,
  status              TEXT DEFAULT 'active',  -- active/pending_review/retracted
  created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_reports_case ON reports(case_id);
CREATE INDEX IF NOT EXISTS idx_reports_status ON reports(status);

CREATE TABLE IF NOT EXISTS ratings (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  report_id  INTEGER NOT NULL REFERENCES reports(id) ON DELETE CASCADE,
  rater_id   TEXT,
  score      INTEGER NOT NULL,
  comment    TEXT,
  channel    TEXT,                       -- web / feishu / api / cli
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_ratings_report ON ratings(report_id);

CREATE TABLE IF NOT EXISTS memory_tree (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  parent_id   INTEGER,
  level       INTEGER NOT NULL,
  title       TEXT NOT NULL,
  summary     TEXT,
  weight      REAL DEFAULT 1.0,
  hit_count   INTEGER DEFAULT 0,
  version     INTEGER DEFAULT 1,
  status      TEXT DEFAULT 'active',
  last_hit_at TEXT,
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS node_case_map (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  node_id        INTEGER NOT NULL REFERENCES memory_tree(id),
  case_id        INTEGER NOT NULL REFERENCES cases(id),
  node_version   INTEGER NOT NULL,
  relation_score REAL DEFAULT 1.0,
  is_current     INTEGER DEFAULT 1,
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE(node_id, case_id, node_version)
);
CREATE INDEX IF NOT EXISTS idx_ncm_node_current ON node_case_map(node_id) WHERE is_current = 1;
CREATE INDEX IF NOT EXISTS idx_ncm_case ON node_case_map(case_id);

CREATE TABLE IF NOT EXISTS memory_tree_change_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  node_id    INTEGER,
  action     TEXT NOT NULL,       -- create/update/split/merge/deprecate
  prompt     TEXT,
  llm_output TEXT,
  operator   TEXT DEFAULT 'system',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
`;

export function initCommon(db) {
  db.exec(SCHEMA_COMMON);
}

export function initApp(db) {
  db.exec(SCHEMA_APP);
}
