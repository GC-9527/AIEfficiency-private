import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { gunzipSync, gzipSync } from "node:zlib";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { captureProcessIdentity } from "../services/process-identity.js";
import { applyAiautoworkSchema } from "./aiautowork-schema.js";
import { applyLanSyncSchema } from "./lan-sync-schema.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// 测试可用 GATEWAY_DB_PATH 覆盖，实现隔离 db（生产零影响）
const DB_PATH = process.env.GATEWAY_DB_PATH || join(__dirname, "data.db");
const db = new Database(DB_PATH);

// 启用WAL模式提升并发性能
db.pragma("busy_timeout = 5000");
// journal_mode 切换是启动时的特殊写操作：两个 Gateway 同时打开旧库时，
// SQLite 偶尔会在这条 PRAGMA 上直接返回 SQLITE_BUSY，而不等满 busy_timeout。
// 只对 BUSY/LOCKED 做有界重试；其它错误仍立即失败关闭。
const walRetrySignal = new Int32Array(new SharedArrayBuffer(4));
const walRetryDeadline = Date.now() + 5000;
while (true) {
  try {
    const mode = db.pragma("journal_mode = WAL", { simple: true });
    if (String(mode || "").toLowerCase() !== "wal") {
      throw Object.assign(new Error(`无法启用 SQLite WAL 模式：${mode}`), { code: "SQLITE_WAL_UNAVAILABLE" });
    }
    break;
  } catch (error) {
    const retryable = error?.code === "SQLITE_BUSY" || error?.code === "SQLITE_LOCKED";
    const remaining = walRetryDeadline - Date.now();
    if (!retryable || remaining <= 0) throw error;
    Atomics.wait(walRetrySignal, 0, 0, Math.min(25, remaining));
  }
}
// 多个 Gateway 进程可能共用同一个 data.db。原子读改写会先获取写锁，
// 给其它进程一个有限等待窗口，避免瞬时竞争直接抛出 SQLITE_BUSY。
applyLanSyncSchema(db);

// ---------- 初始化表结构 ----------

db.exec(`
  CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    description TEXT,
    type TEXT NOT NULL DEFAULT 'bug_analysis',
    status TEXT NOT NULL DEFAULT 'pending',
    priority INTEGER DEFAULT 3,
    source TEXT DEFAULT 'web',
    source_id TEXT,
    assigned_engine TEXT,
    result TEXT,
    report TEXT,
    created_at TEXT DEFAULT (datetime('now', 'localtime')),
    updated_at TEXT DEFAULT (datetime('now', 'localtime')),
    completed_at TEXT
  );

  CREATE TABLE IF NOT EXISTS task_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id TEXT NOT NULL,
    level TEXT DEFAULT 'info',
    module TEXT DEFAULT 'system',
    message TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now', 'localtime')),
    FOREIGN KEY (task_id) REFERENCES tasks(id)
  );

  CREATE TABLE IF NOT EXISTS agent_status (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    engine TEXT NOT NULL,
    status TEXT DEFAULT 'idle',
    current_task_id TEXT,
    last_heartbeat TEXT DEFAULT (datetime('now', 'localtime')),
    FOREIGN KEY (current_task_id) REFERENCES tasks(id)
  );

  CREATE TABLE IF NOT EXISTS task_runtime_leases (
    lease_id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL,
    parent_task_id TEXT,
    owner_instance TEXT NOT NULL,
    owner_pid INTEGER NOT NULL,
    worker_pid INTEGER,
    worker_identity TEXT,
    heartbeat_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_task_runtime_leases_task
    ON task_runtime_leases(task_id, parent_task_id, expires_at);

  CREATE TABLE IF NOT EXISTS worktree_resource_leases (
    resource_key TEXT PRIMARY KEY,
    lease_token TEXT NOT NULL,
    kind TEXT NOT NULL,
    tab_id TEXT,
    task_id TEXT,
    owner_instance TEXT NOT NULL,
    owner_pid INTEGER NOT NULL,
    acquired_at INTEGER NOT NULL,
    heartbeat_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_worktree_resource_leases_token
    ON worktree_resource_leases(lease_token);
  CREATE INDEX IF NOT EXISTS idx_worktree_resource_leases_tab
    ON worktree_resource_leases(tab_id, expires_at);

  CREATE TABLE IF NOT EXISTS story_workspace (
    id TEXT PRIMARY KEY,
    story_id TEXT NOT NULL UNIQUE,
    node_id TEXT NOT NULL DEFAULT '',
    root_path TEXT NOT NULL,
    layout_version INTEGER NOT NULL DEFAULT 2,
    logical_branch TEXT NOT NULL,
    build_entry_repo_id TEXT NOT NULL,
    status TEXT NOT NULL,
    workspace_json TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_story_workspace_story_status
    ON story_workspace(story_id, status);

  CREATE TABLE IF NOT EXISTS story_workspace_member (
    workspace_id TEXT NOT NULL,
    repo_id TEXT NOT NULL,
    relative_dir TEXT NOT NULL,
    logical_branch TEXT NOT NULL,
    checkout_branch TEXT,
    checkout_commit TEXT,
    mode TEXT NOT NULL,
    worktree_path TEXT NOT NULL,
    status TEXT NOT NULL,
    member_json TEXT NOT NULL,
    PRIMARY KEY (workspace_id, repo_id)
  );
  CREATE INDEX IF NOT EXISTS idx_story_workspace_member_workspace
    ON story_workspace_member(workspace_id);

  CREATE TABLE IF NOT EXISTS token_usage (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id TEXT,
    engine TEXT NOT NULL,
    model TEXT,
    story_id TEXT,
    attempt_id TEXT,
    workflow_kind TEXT,
    stage TEXT,
    context_id TEXT,
    context_revision INTEGER,
    turn_attempt INTEGER DEFAULT 1,
    prompt_chars INTEGER DEFAULT 0,
    prompt_sha256 TEXT,
    system_chars INTEGER,
    stage_chars INTEGER,
    context_chars INTEGER,
    tool_schema_chars INTEGER,
    tool_result_chars INTEGER DEFAULT 0,
    input_tokens INTEGER DEFAULT 0,
    output_tokens INTEGER DEFAULT 0,
    cache_read_tokens INTEGER DEFAULT 0,
    cache_creation_tokens INTEGER DEFAULT 0,
    usage_source TEXT NOT NULL DEFAULT 'estimated',
    request_count INTEGER DEFAULT 0,
    request_attempts INTEGER DEFAULT 0,
    retry_count INTEGER DEFAULT 0,
    transport_retry_count INTEGER DEFAULT 0,
    workflow_retry_count INTEGER DEFAULT 0,
    tool_rounds INTEGER,
    tool_calls INTEGER DEFAULT 0,
    succeeded INTEGER,
    execution_succeeded INTEGER,
    created_at TEXT DEFAULT (datetime('now', 'localtime')),
    FOREIGN KEY (task_id) REFERENCES tasks(id)
  );

  CREATE TABLE IF NOT EXISTS workflow_stage_observations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    story_id TEXT,
    task_id TEXT,
    attempt_id TEXT,
    workflow_kind TEXT,
    stage TEXT NOT NULL,
    marker_kind TEXT,
    phase_before TEXT,
    phase_after TEXT,
    outcome TEXT NOT NULL,
    report_validation_retry INTEGER NOT NULL DEFAULT 0,
    error_code TEXT,
    recorded_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS tb_write_observations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    story_id TEXT,
    tb_task_id TEXT NOT NULL,
    write_kind TEXT NOT NULL,
    payload_sha256 TEXT NOT NULL,
    outcome TEXT NOT NULL,
    duplicate_candidate INTEGER NOT NULL DEFAULT 0,
    error_code TEXT,
    recorded_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS chat_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    task_id TEXT,
    engine TEXT,
    created_at TEXT DEFAULT (datetime('now', 'localtime'))
  );

  CREATE TABLE IF NOT EXISTS chat_sessions (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL DEFAULT '新对话',
    status TEXT NOT NULL DEFAULT 'active',
    created_at TEXT DEFAULT (datetime('now', 'localtime')),
    updated_at TEXT DEFAULT (datetime('now', 'localtime'))
  );

  CREATE TABLE IF NOT EXISTS admin_users (
    ding_userid TEXT PRIMARY KEY,
    subject_issuer TEXT NOT NULL DEFAULT 'teambition',
    name TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'admin' CHECK(role = 'admin'),
    added_by TEXT,
    created_at INTEGER,
    updated_at INTEGER,
    deleted_at INTEGER DEFAULT 0,
    node TEXT
  );

  CREATE TABLE IF NOT EXISTS admin_audit (
    id TEXT PRIMARY KEY,
    ts INTEGER,
    ip TEXT,
    actor TEXT,
    role TEXT,
    action TEXT,
    target TEXT,
    before TEXT,
    after TEXT,
    node TEXT
  );

  -- 管理员登录令牌（持久化，使网关重启后登录态不丢；过期或登出即删）
  CREATE TABLE IF NOT EXISTS admin_tokens (
    token TEXT PRIMARY KEY,
    data TEXT,                  -- json: { role, name, dingUserid }
    exp INTEGER
  );

  CREATE TABLE IF NOT EXISTS admin_authz_meta (
    id INTEGER PRIMARY KEY CHECK(id = 1),
    revision INTEGER NOT NULL DEFAULT 0
  );
  INSERT OR IGNORE INTO admin_authz_meta (id, revision)
    SELECT 1, COALESCE(MAX(updated_at), 0) FROM admin_users;

  -- 问题反馈（类简约 TB 单）：客户端提交→服务端存→服务端间 gossip 同步（updated_at 新者胜）
  CREATE TABLE IF NOT EXISTS feedback (
    id TEXT PRIMARY KEY,
    ts INTEGER,                 -- 创建时间
    updated_at INTEGER,         -- 最后更新（gossip 取较新者）
    reporter_id TEXT,           -- TB uid / 钉钉 userid / 匿名名 hash
    reporter_name TEXT,
    reporter_kind TEXT,         -- tb | ding | name
    title TEXT,
    body TEXT,
    status TEXT,                -- open | in_progress | resolved | closed | wontfix
    priority TEXT,              -- low | normal | high
    assignee TEXT,              -- 处理人(管理员名)
    page TEXT,                  -- 来源页面
    project TEXT,               -- 关联工程(用于 AI 修复)
    attachments TEXT,           -- json: [{name,size,kind,path}]
    comments TEXT,              -- json: [{ts,author,role,text}]
    node TEXT                   -- 起源节点
  );

  -- devbench 数据：tasks 按用户同步；tabs/closed 是本机打开状态，按设备保存且不参与 gossip
  CREATE TABLE IF NOT EXISTS devbench_userdata (
    user_key TEXT,
    kind TEXT,                  -- tasks | tabs | closed
    data TEXT,                  -- json 数组
    updated_at INTEGER,
    node TEXT,
    PRIMARY KEY (user_key, kind)
  );

  CREATE TABLE IF NOT EXISTS devbench_sync_backups (
    id TEXT PRIMARY KEY,
    created_at INTEGER NOT NULL,
    source TEXT,
    label TEXT,
    note TEXT,
    summary TEXT,
    data TEXT NOT NULL,
    blob_hash TEXT,
    node TEXT
  );

  CREATE TABLE IF NOT EXISTS devbench_sync_backup_blobs (
    blob_hash TEXT PRIMARY KEY,
    encoding TEXT NOT NULL,
    raw_bytes INTEGER NOT NULL,
    stored_bytes INTEGER NOT NULL,
    data BLOB NOT NULL,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS devbench_sync_backup_settings (
    key TEXT PRIMARY KEY,
    value TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
  CREATE INDEX IF NOT EXISTS idx_tasks_source ON tasks(source);
  CREATE INDEX IF NOT EXISTS idx_task_logs_task_id ON task_logs(task_id);
  CREATE INDEX IF NOT EXISTS idx_token_usage_engine ON token_usage(engine);
  CREATE INDEX IF NOT EXISTS idx_token_usage_created_at ON token_usage(created_at);
  CREATE INDEX IF NOT EXISTS idx_workflow_stage_observations_time ON workflow_stage_observations(recorded_at, stage);
  CREATE INDEX IF NOT EXISTS idx_tb_write_observations_time ON tb_write_observations(recorded_at, write_kind);
  CREATE INDEX IF NOT EXISTS idx_tb_write_observations_fingerprint ON tb_write_observations(tb_task_id, write_kind, payload_sha256, outcome);
  CREATE INDEX IF NOT EXISTS idx_chat_messages_created ON chat_messages(created_at);
  CREATE INDEX IF NOT EXISTS idx_chat_sessions_updated ON chat_sessions(updated_at);
  CREATE INDEX IF NOT EXISTS idx_devbench_sync_backups_created ON devbench_sync_backups(created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_admin_audit_ts_id ON admin_audit(ts DESC, id DESC);
`);

// Existing databases predate the role constraint. The replicated admin list is
// a membership list only; local TOTP is the sole source of a super principal.
const normalizedLegacyAdminRoles = db.prepare("UPDATE admin_users SET role = 'admin' WHERE role IS NULL OR role <> 'admin'").run();
if (normalizedLegacyAdminRoles.changes) {
  db.prepare("UPDATE admin_authz_meta SET revision = revision + 1 WHERE id = 1").run();
}

try { db.exec("ALTER TABLE devbench_sync_backups ADD COLUMN blob_hash TEXT"); } catch {}
db.exec(`
  CREATE TABLE IF NOT EXISTS devbench_sync_backup_blobs (
    blob_hash TEXT PRIMARY KEY,
    encoding TEXT NOT NULL,
    raw_bytes INTEGER NOT NULL,
    stored_bytes INTEGER NOT NULL,
    data BLOB NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_devbench_sync_backups_blob ON devbench_sync_backups(blob_hash);
`);

// 迁移：任务拆分相关字段
// ---------- DevBench Git Controller persistent state ----------
//
// These tables only store structured identities and controller-owned state. A
// path, URL or argv received from an HTTP client must never be persisted here
// and later treated as an executable Git command.
db.exec(`
  CREATE TABLE IF NOT EXISTS git_controller_repositories (
    repository_id TEXT PRIMARY KEY,
    remote_id TEXT NOT NULL,
    remote_fingerprint TEXT NOT NULL,
    base_realpath TEXT NOT NULL,
    base_git_common_realpath TEXT,
    mirror_realpath TEXT NOT NULL,
    logical_definition_ids_json TEXT NOT NULL DEFAULT '[]',
    allowed_branches_json TEXT NOT NULL DEFAULT '[]',
    config_digest TEXT NOT NULL,
    registered_at INTEGER NOT NULL,
    verified_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_git_controller_repositories_fingerprint
    ON git_controller_repositories(remote_fingerprint);

  CREATE TABLE IF NOT EXISTS git_controller_mirror_state (
    repository_id TEXT NOT NULL,
    remote_id TEXT NOT NULL,
    branch TEXT NOT NULL,
    accepted_sha TEXT,
    source_ref TEXT NOT NULL,
    generation INTEGER NOT NULL DEFAULT 0,
    accepted_at INTEGER,
    operation_id TEXT,
    fencing_token INTEGER,
    remote_fingerprint TEXT NOT NULL,
    PRIMARY KEY (repository_id, remote_id, branch)
  );
  CREATE INDEX IF NOT EXISTS idx_git_controller_mirror_state_operation
    ON git_controller_mirror_state(operation_id);

  CREATE TABLE IF NOT EXISTS git_controller_previews (
    preview_id TEXT PRIMARY KEY,
    repository_id TEXT NOT NULL,
    preview_kind TEXT NOT NULL,
    branch TEXT NOT NULL,
    preview_version INTEGER NOT NULL,
    expected_head TEXT,
    candidate_sha TEXT,
    mirror_generation INTEGER NOT NULL DEFAULT 0,
    relationship TEXT NOT NULL,
    eligible INTEGER NOT NULL DEFAULT 0,
    blocker_code TEXT,
    remote_fingerprint TEXT NOT NULL,
    payload_json TEXT NOT NULL DEFAULT '{}',
    status TEXT NOT NULL DEFAULT 'ACTIVE',
    consumed_by_operation TEXT,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    UNIQUE (repository_id, preview_kind, branch, preview_version)
  );
  CREATE INDEX IF NOT EXISTS idx_git_controller_previews_lookup
    ON git_controller_previews(repository_id, preview_kind, branch, status, expires_at);

  CREATE TABLE IF NOT EXISTS git_controller_operations (
    operation_id TEXT PRIMARY KEY,
    repository_id TEXT NOT NULL,
    operation_type TEXT NOT NULL,
    command_id TEXT NOT NULL,
    idempotency_key TEXT NOT NULL,
    preview_id TEXT,
    branch TEXT NOT NULL,
    expected_head TEXT,
    candidate_sha TEXT,
    status TEXT NOT NULL,
    phase TEXT NOT NULL,
    result_code TEXT,
    result_json TEXT,
    error_json TEXT,
    owner_instance TEXT NOT NULL,
    owner_hostname TEXT,
    owner_pid INTEGER,
    owner_process_start_identity TEXT,
    fencing_token INTEGER,
    started_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    completed_at INTEGER,
    UNIQUE (repository_id, operation_type, idempotency_key)
  );
  CREATE INDEX IF NOT EXISTS idx_git_controller_operations_recovery
    ON git_controller_operations(status, updated_at);

  CREATE TABLE IF NOT EXISTS git_controller_journal (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    operation_id TEXT NOT NULL,
    repository_id TEXT NOT NULL,
    phase TEXT NOT NULL,
    fencing_token INTEGER,
    data_json TEXT NOT NULL DEFAULT '{}',
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_git_controller_journal_operation
    ON git_controller_journal(operation_id, id);

  CREATE TABLE IF NOT EXISTS git_controller_audit (
    audit_id TEXT PRIMARY KEY,
    operation_id TEXT NOT NULL,
    repository_id TEXT NOT NULL,
    command_id TEXT NOT NULL,
    action TEXT NOT NULL,
    branch TEXT,
    before_sha TEXT,
    candidate_sha TEXT,
    result TEXT NOT NULL,
    reason TEXT,
    duration_ms INTEGER NOT NULL DEFAULT 0,
    fencing_token INTEGER,
    actor TEXT,
    details_json TEXT NOT NULL DEFAULT '{}',
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_git_controller_audit_repository
    ON git_controller_audit(repository_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_git_controller_audit_operation
    ON git_controller_audit(operation_id);

  CREATE TABLE IF NOT EXISTS git_controller_repository_fences (
    repository_id TEXT PRIMARY KEY,
    last_fencing_token INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS git_controller_repository_leases (
    repository_id TEXT PRIMARY KEY,
    lease_id TEXT NOT NULL UNIQUE,
    operation_id TEXT NOT NULL,
    lease_kind TEXT NOT NULL,
    owner_instance TEXT NOT NULL,
    owner_hostname TEXT,
    owner_pid INTEGER NOT NULL,
    owner_process_start_identity TEXT,
    fencing_token INTEGER NOT NULL,
    acquired_at INTEGER NOT NULL,
    heartbeat_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_git_controller_repository_leases_expiry
    ON git_controller_repository_leases(expires_at);
`);

try { db.exec("ALTER TABLE tasks ADD COLUMN parent_task_id TEXT"); } catch {}
try { db.exec("ALTER TABLE tasks ADD COLUMN subtask_id TEXT"); } catch {}
try { db.exec("ALTER TABLE tasks ADD COLUMN depends_on TEXT"); } catch {}
try { db.exec("ALTER TABLE tasks ADD COLUMN decomposition TEXT"); } catch {}
db.exec("CREATE INDEX IF NOT EXISTS idx_tasks_parent ON tasks(parent_task_id)");
function ensureTableColumns(tableName, columns) {
  const existing = new Set(db.prepare(`PRAGMA table_info(${tableName})`).all().map((row) => row.name));
  for (const [columnName, definition] of columns) {
    if (existing.has(columnName)) continue;
    try {
      db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition}`);
      existing.add(columnName);
    } catch (error) {
      const raced = new Set(db.prepare(`PRAGMA table_info(${tableName})`).all().map((row) => row.name));
      if (/duplicate column name/i.test(String(error?.message || "")) && raced.has(columnName)) {
        existing.add(columnName);
        continue;
      }
      throw error;
    }
  }
  const migrated = new Set(db.prepare(`PRAGMA table_info(${tableName})`).all().map((row) => row.name));
  const missing = columns.map(([columnName]) => columnName).filter((columnName) => !migrated.has(columnName));
  if (missing.length) throw new Error(`${tableName} 遥测迁移不完整，缺少列: ${missing.join(", ")}`);
}

ensureTableColumns("token_usage", [
  ["cache_read_tokens", "INTEGER DEFAULT 0"],
  ["cache_creation_tokens", "INTEGER DEFAULT 0"],
  ["usage_source", "TEXT NOT NULL DEFAULT 'estimated'"],
  ["model", "TEXT"],
  ["story_id", "TEXT"],
  ["attempt_id", "TEXT"],
  ["workflow_kind", "TEXT"],
  ["stage", "TEXT"],
  ["context_id", "TEXT"],
  ["context_revision", "INTEGER"],
  ["turn_attempt", "INTEGER DEFAULT 1"],
  ["prompt_chars", "INTEGER DEFAULT 0"],
  ["prompt_sha256", "TEXT"],
  ["system_chars", "INTEGER"],
  ["stage_chars", "INTEGER"],
  ["context_chars", "INTEGER"],
  ["tool_schema_chars", "INTEGER"],
  ["tool_result_chars", "INTEGER DEFAULT 0"],
  ["request_count", "INTEGER DEFAULT 0"],
  ["request_attempts", "INTEGER DEFAULT 0"],
  ["retry_count", "INTEGER DEFAULT 0"],
  ["transport_retry_count", "INTEGER DEFAULT 0"],
  ["workflow_retry_count", "INTEGER DEFAULT 0"],
  ["tool_rounds", "INTEGER"],
  ["tool_calls", "INTEGER DEFAULT 0"],
  ["succeeded", "INTEGER"],
  ["execution_succeeded", "INTEGER"],
]);
const tokenUsageColumns = new Set(db.prepare("PRAGMA table_info(token_usage)").all().map((row) => row.name));
if (tokenUsageColumns.has("succeeded") && tokenUsageColumns.has("execution_succeeded")) {
  db.exec(`
    UPDATE token_usage
    SET execution_succeeded = succeeded
    WHERE execution_succeeded IS NULL AND succeeded IS NOT NULL
  `);
  db.exec(`
    UPDATE token_usage
    SET succeeded = execution_succeeded
    WHERE succeeded IS NULL AND execution_succeeded IS NOT NULL
  `);
}
try { db.exec("ALTER TABLE task_runtime_leases ADD COLUMN worker_pid INTEGER"); } catch {}
try { db.exec("ALTER TABLE task_runtime_leases ADD COLUMN worker_identity TEXT"); } catch {}
try { db.exec("ALTER TABLE git_controller_operations ADD COLUMN owner_hostname TEXT"); } catch {}
try { db.exec("ALTER TABLE git_controller_operations ADD COLUMN owner_pid INTEGER"); } catch {}
try { db.exec("ALTER TABLE git_controller_operations ADD COLUMN owner_process_start_identity TEXT"); } catch {}
try { db.exec("ALTER TABLE git_controller_repository_leases ADD COLUMN owner_hostname TEXT"); } catch {}
try { db.exec("ALTER TABLE git_controller_repository_leases ADD COLUMN owner_process_start_identity TEXT"); } catch {}
try { db.exec("ALTER TABLE git_controller_repositories ADD COLUMN base_git_common_realpath TEXT"); } catch {}

// 迁移：为已有 chat_messages 添加 session_id 列
try { db.exec("ALTER TABLE chat_messages ADD COLUMN session_id TEXT REFERENCES chat_sessions(id)"); } catch {}
db.exec("CREATE INDEX IF NOT EXISTS idx_chat_messages_session ON chat_messages(session_id)");

// 迁移：为 chat_sessions 添加 CLI session ID 字段（支持对话续接）
try { db.exec("ALTER TABLE chat_sessions ADD COLUMN claude_session_id TEXT"); } catch {}
try { db.exec("ALTER TABLE chat_sessions ADD COLUMN gemini_session_id TEXT"); } catch {}
// 迁移：对话摘要（上下文压缩用）
try { db.exec("ALTER TABLE chat_sessions ADD COLUMN context_summary TEXT"); } catch {}
try { db.exec("ALTER TABLE chat_sessions ADD COLUMN summary_up_to INTEGER DEFAULT 0"); } catch {}
// 迁移：标题锁定（用户手动修改后不再被消息内容自动更新）
try { db.exec("ALTER TABLE chat_sessions ADD COLUMN title_locked INTEGER DEFAULT 0"); } catch {}
// 迁移：会话置顶
try { db.exec("ALTER TABLE chat_sessions ADD COLUMN pinned INTEGER DEFAULT 0"); } catch {}
// 迁移：消息思考/工具轨迹（JSON 数组）
try { db.exec("ALTER TABLE chat_messages ADD COLUMN transcript_json TEXT"); } catch {}
// 迁移：TB 任务附件信息
try { db.exec("ALTER TABLE tb_task_records ADD COLUMN attachments_json TEXT"); } catch {}
// 迁移：管理员名单局域网同步所需字段。deleted_at 为 tombstone，避免物理删除无法跨机传播。
try { db.exec("ALTER TABLE admin_users ADD COLUMN updated_at INTEGER"); } catch {}
try { db.exec("ALTER TABLE admin_users ADD COLUMN deleted_at INTEGER DEFAULT 0"); } catch {}
try { db.exec("ALTER TABLE admin_users ADD COLUMN node TEXT"); } catch {}
try { db.exec("ALTER TABLE admin_users ADD COLUMN subject_issuer TEXT"); } catch {}
// 旧版管理员名单来自 Teambition，却把 uid 存在历史 ding_userid 列中。
// 24 位十六进制 ObjectId 可确定为旧 TB uid；其它既有值按后续钉钉来源保留。
try {
  db.exec(`
    UPDATE admin_users
    SET subject_issuer = CASE
      WHEN length(ding_userid) = 24
        AND lower(ding_userid) = ding_userid
        AND ding_userid NOT GLOB '*[^0-9a-f]*'
      THEN 'teambition'
      ELSE 'dingtalk'
    END
    WHERE subject_issuer IS NULL OR trim(subject_issuer) = ''
  `);
} catch {}
try { db.prepare("UPDATE admin_users SET updated_at = COALESCE(updated_at, created_at, ?)").run(Date.now()); } catch {}
try { db.prepare("UPDATE admin_users SET deleted_at = COALESCE(deleted_at, 0)").run(); } catch {}

// ---------- 任务操作 ----------

export function createTask(task) {
  const stmt = db.prepare(`
    INSERT INTO tasks (id, title, description, type, status, priority, source, source_id, parent_task_id, subtask_id, depends_on, decomposition)
    VALUES (@id, @title, @description, @type, @status, @priority, @source, @sourceId, @parentTaskId, @subtaskId, @dependsOn, @decomposition)
  `);
  return stmt.run({
    parentTaskId: null,
    subtaskId: null,
    dependsOn: null,
    decomposition: null,
    ...task,
  });
}

export function getTask(id) {
  return db.prepare("SELECT * FROM tasks WHERE id = ?").get(id);
}

export function listTasks({ status, source, sourceId, parentTaskId, topLevel, limit = 50, offset = 0 } = {}) {
  let sql = "SELECT * FROM tasks WHERE 1=1";
  const params = {};

  if (status) {
    sql += " AND status = @status";
    params.status = status;
  }
  if (source) {
    sql += " AND source = @source";
    params.source = source;
  }
  if (sourceId) {
    sql += " AND source_id = @sourceId";
    params.sourceId = sourceId;
  }
  if (parentTaskId) {
    sql += " AND parent_task_id = @parentTaskId";
    params.parentTaskId = parentTaskId;
  }
  if (topLevel) {
    sql += " AND parent_task_id IS NULL";
  }

  sql += " ORDER BY priority ASC, created_at DESC LIMIT @limit OFFSET @offset";
  params.limit = limit;
  params.offset = offset;

  return db.prepare(sql).all(params);
}

// 永久删除故事点前使用：不能套普通列表的分页上限，否则长会话中较早的活跃任务
// 可能落在前 500 条之外而被误当成已结束。
export function listActiveDevbenchTasks(sourceId) {
  const sessionId = String(sourceId || "").trim();
  if (!sessionId) return [];
  return db.prepare(`
    SELECT * FROM tasks
    WHERE source = 'devbench' AND source_id = ? AND status IN ('pending', 'running')
    ORDER BY created_at ASC, id ASC
  `).all(sessionId);
}

export function updateTask(id, updates) {
  const fields = [];
  const params = { id };

  for (const [key, value] of Object.entries(updates)) {
    // camelCase转snake_case
    const snakeKey = key.replace(/[A-Z]/g, (m) => `_${m.toLowerCase()}`);
    fields.push(`${snakeKey} = @${key}`);
    params[key] = value;
  }

  fields.push("updated_at = datetime('now', 'localtime')");

  if (updates.status === "completed") {
    fields.push("completed_at = datetime('now', 'localtime')");
  }

  const sql = `UPDATE tasks SET ${fields.join(", ")} WHERE id = @id`;
  return db.prepare(sql).run(params);
}

export function deleteTask(id) {
  db.prepare("DELETE FROM task_logs WHERE task_id = ?").run(id);
  return db.prepare("DELETE FROM tasks WHERE id = ?").run(id);
}

// 物理删除已关闭故事点时，按故事点 sessionId 清理 AI 执行侧保存的提问、回答、日志与 Token。
// 仅匹配 source=devbench，避免同一个外部 ID 误伤其它任务来源。
export function deleteDevbenchExecutionHistory(sourceId) {
  const sessionId = String(sourceId || "").trim();
  if (!sessionId) return { tasks: 0, logs: 0, tokenUsage: 0, chatMessages: 0, agentsCleared: 0 };
  const taskIdsSql = "SELECT id FROM tasks WHERE source = 'devbench' AND source_id = ?";
  const remove = db.transaction((sid) => {
    const agentsCleared = db.prepare(`
      UPDATE agent_status
      SET status = 'idle', current_task_id = NULL, last_heartbeat = datetime('now', 'localtime')
      WHERE current_task_id IN (${taskIdsSql})
    `).run(sid).changes;
    db.prepare(`DELETE FROM task_runtime_leases WHERE task_id IN (${taskIdsSql}) OR parent_task_id IN (${taskIdsSql})`).run(sid, sid);
    const logs = db.prepare(`DELETE FROM task_logs WHERE task_id IN (${taskIdsSql})`).run(sid).changes;
    const tokenUsage = db.prepare(`DELETE FROM token_usage WHERE task_id IN (${taskIdsSql})`).run(sid).changes;
    const chatMessages = db.prepare(`DELETE FROM chat_messages WHERE task_id IN (${taskIdsSql})`).run(sid).changes;
    const tasks = db.prepare("DELETE FROM tasks WHERE source = 'devbench' AND source_id = ?").run(sid).changes;
    return { tasks, logs, tokenUsage, chatMessages, agentsCleared };
  });
  return remove(sessionId);
}

// ---------- 日志操作 ----------

function ensureSystemLogTask() {
  db.prepare(`
    INSERT OR IGNORE INTO tasks (
      id, title, description, type, status, priority, source, source_id,
      created_at, updated_at, completed_at
    )
    VALUES (
      'system', '系统日志', '不对应业务任务的网关运行日志',
      'system_log', 'completed', 99, 'system_log', 'system',
      '2000-01-01 00:00:00', '2000-01-01 00:00:00', '2000-01-01 00:00:00'
    )
  `).run();
}

export function addLog(taskId, level, module, message) {
  const normalizedTaskId = String(taskId || "").trim();
  if (normalizedTaskId === "system") ensureSystemLogTask();
  return db
    .prepare(
      "INSERT INTO task_logs (task_id, level, module, message) VALUES (?, ?, ?, ?)"
    )
    .run(normalizedTaskId, level, module, message);
}

export function getTaskLogs(taskId, { limit = 100, offset = 0 } = {}) {
  return db
    .prepare(
      "SELECT * FROM task_logs WHERE task_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?"
    )
    .all(taskId, limit, offset);
}

export function getRecentLogs({ limit = 100, days } = {}) {
  if (days && days > 0) {
    return db.prepare("SELECT * FROM task_logs WHERE created_at >= datetime('now','localtime', ?) ORDER BY created_at DESC LIMIT ?")
      .all(`-${parseInt(days)} days`, limit);
  }
  return db.prepare("SELECT * FROM task_logs ORDER BY created_at DESC LIMIT ?").all(limit);
}

// 取某一日历日的日志（用于反馈诊断包"当天/补昨天"）。date 形如 'YYYY-MM-DD'
export function getLogsByDate(date, { limit = 5000 } = {}) {
  return db.prepare("SELECT * FROM task_logs WHERE date(created_at) = ? ORDER BY created_at ASC LIMIT ?").all(date, limit);
}

// 日志保留清理：删超过 days 天的；再按总条数上限 maxRows 兜底（保留最新）。返回删除条数。
export function pruneOldLogs({ days = 14, maxRows = 200000 } = {}) {
  let removed = 0;
  if (days && days > 0) {
    removed += db.prepare("DELETE FROM task_logs WHERE created_at < datetime('now','localtime', ?)").run(`-${parseInt(days)} days`).changes;
  }
  if (maxRows && maxRows > 0) {
    removed += db.prepare("DELETE FROM task_logs WHERE id NOT IN (SELECT id FROM task_logs ORDER BY created_at DESC LIMIT ?)").run(maxRows).changes;
  }
  return removed;
}

// ---------- Agent状态 ----------

export function upsertAgent(agent) {
  const stmt = db.prepare(`
    INSERT INTO agent_status (id, name, engine, status, current_task_id)
    VALUES (@id, @name, @engine, @status, @currentTaskId)
    ON CONFLICT(id) DO UPDATE SET
      status = @status,
      current_task_id = @currentTaskId,
      last_heartbeat = datetime('now', 'localtime')
  `);
  return stmt.run(agent);
}

export function getAgents() {
  return db.prepare("SELECT * FROM agent_status ORDER BY name").all();
}

export function updateAgentStatus(id, status, currentTaskId = null) {
  return db
    .prepare(
      `UPDATE agent_status SET status = ?, current_task_id = ?,
       last_heartbeat = datetime('now', 'localtime') WHERE id = ?`
    )
    .run(status, currentTaskId, id);
}

// ---------- 跨 Gateway 的真实任务运行租约 ----------

export function upsertTaskRuntimeLease({
  leaseId,
  taskId,
  parentTaskId = null,
  ownerInstance,
  ownerPid = process.pid,
  workerPid = null,
  workerIdentity = "",
  now = Date.now(),
  ttlMs = 15000,
} = {}) {
  const id = String(leaseId || "").trim();
  const task = String(taskId || "").trim();
  const owner = String(ownerInstance || "").trim();
  if (!id || !task || !owner) return { changes: 0 };
  const heartbeatAt = Math.max(0, Number(now) || Date.now());
  const expiresAt = heartbeatAt + Math.max(5000, Number(ttlMs) || 15000);
  const normalizedWorkerPid = Number(workerPid) > 0 ? Number(workerPid) : null;
  let normalizedWorkerIdentity = String(workerIdentity || "").trim() || null;
  if (normalizedWorkerPid && !normalizedWorkerIdentity) {
    const existing = db.prepare(`
      SELECT worker_pid, worker_identity
      FROM task_runtime_leases
      WHERE lease_id = ?
    `).get(id);
    if (Number(existing?.worker_pid) === normalizedWorkerPid && existing?.worker_identity) {
      normalizedWorkerIdentity = String(existing.worker_identity);
    } else {
      normalizedWorkerIdentity = captureProcessIdentity(normalizedWorkerPid) || null;
    }
  }
  return db.prepare(`
    INSERT INTO task_runtime_leases
      (lease_id, task_id, parent_task_id, owner_instance, owner_pid, worker_pid, worker_identity, heartbeat_at, expires_at)
    VALUES
      (@leaseId, @taskId, @parentTaskId, @ownerInstance, @ownerPid, @workerPid, @workerIdentity, @heartbeatAt, @expiresAt)
    ON CONFLICT(lease_id) DO UPDATE SET
      task_id = excluded.task_id,
      parent_task_id = excluded.parent_task_id,
      owner_instance = excluded.owner_instance,
      owner_pid = excluded.owner_pid,
      worker_pid = excluded.worker_pid,
      worker_identity = excluded.worker_identity,
      heartbeat_at = excluded.heartbeat_at,
      expires_at = excluded.expires_at
  `).run({
    leaseId: id,
    taskId: task,
    parentTaskId: String(parentTaskId || "").trim() || null,
    ownerInstance: owner,
    ownerPid: Number(ownerPid) || 0,
    workerPid: normalizedWorkerPid,
    workerIdentity: normalizedWorkerIdentity,
    heartbeatAt,
    expiresAt,
  });
}

export function removeTaskRuntimeLease(leaseId, ownerInstance = "") {
  const id = String(leaseId || "").trim();
  const owner = String(ownerInstance || "").trim();
  if (!id) return { changes: 0 };
  return owner
    ? db.prepare("DELETE FROM task_runtime_leases WHERE lease_id = ? AND owner_instance = ?").run(id, owner)
    : db.prepare("DELETE FROM task_runtime_leases WHERE lease_id = ?").run(id);
}

export function removeTaskRuntimeLeasesForOwner(ownerInstance) {
  const owner = String(ownerInstance || "").trim();
  if (!owner) return { changes: 0 };
  return db.prepare("DELETE FROM task_runtime_leases WHERE owner_instance = ?").run(owner);
}

/**
 * 按 taskId 强制清理所有运行态租约（不论 owner / 过期与否）。
 * 仅用于已判定为"卡住"的任务：心跳定时器泄漏导致租约被持续续期、
 * isTaskAgentRunningAnywhere 永远返回 true 时，由 stop 端点显式收敛。
 * 调用方必须先确认 live draft 已长时间无更新（stalled），避免误杀正在其它 Gateway 正常执行的任务。
 */
export function removeTaskRuntimeLeasesForTask(taskId) {
  const task = String(taskId || "").trim();
  if (!task) return { changes: 0 };
  return db.prepare(`
    DELETE FROM task_runtime_leases
    WHERE task_id = ? OR parent_task_id = ?
  `).run(task, task);
}

export function hasActiveTaskRuntimeLease(taskId, now = Date.now()) {
  const task = String(taskId || "").trim();
  if (!task) return false;
  return !!db.prepare(`
    SELECT 1
    FROM task_runtime_leases
    WHERE expires_at > ?
      AND (task_id = ? OR parent_task_id = ?)
    LIMIT 1
  `).get(Number(now) || Date.now(), task, task);
}

export function listActiveTaskRuntimeLeases(taskId = "", now = Date.now()) {
  const task = String(taskId || "").trim();
  if (task) {
    return db.prepare(`
      SELECT * FROM task_runtime_leases
      WHERE expires_at > ?
        AND (task_id = ? OR parent_task_id = ?)
      ORDER BY heartbeat_at DESC, lease_id ASC
    `).all(Number(now) || Date.now(), task, task);
  }
  return db.prepare(`
    SELECT * FROM task_runtime_leases
    WHERE expires_at > ?
    ORDER BY heartbeat_at DESC, lease_id ASC
  `).all(Number(now) || Date.now());
}

export function listTaskRuntimeLeases(taskId = "", {
  now = Date.now(),
  maxHeartbeatAgeMs = null,
} = {}) {
  const task = String(taskId || "").trim();
  const checkedAt = Math.max(0, Number(now) || Date.now());
  const boundedByHeartbeat = Number.isFinite(Number(maxHeartbeatAgeMs))
    && Number(maxHeartbeatAgeMs) > 0;
  const oldestHeartbeat = boundedByHeartbeat
    ? checkedAt - Math.max(60_000, Number(maxHeartbeatAgeMs))
    : null;
  if (task) {
    if (!boundedByHeartbeat) {
      return db.prepare(`
        SELECT * FROM task_runtime_leases
        WHERE task_id = ? OR parent_task_id = ?
        ORDER BY heartbeat_at DESC, lease_id ASC
      `).all(task, task);
    }
    return db.prepare(`
      SELECT * FROM task_runtime_leases
      WHERE heartbeat_at >= ?
        AND (task_id = ? OR parent_task_id = ?)
      ORDER BY heartbeat_at DESC, lease_id ASC
    `).all(oldestHeartbeat, task, task);
  }
  if (!boundedByHeartbeat) {
    return db.prepare(`
      SELECT * FROM task_runtime_leases
      ORDER BY heartbeat_at DESC, lease_id ASC
    `).all();
  }
  return db.prepare(`
    SELECT * FROM task_runtime_leases
    WHERE heartbeat_at >= ?
    ORDER BY heartbeat_at DESC, lease_id ASC
  `).all(oldestHeartbeat);
}

export function listRuntimeStateTaskIds() {
  return db.prepare(`
    SELECT id AS task_id
    FROM tasks
    WHERE status = 'running'
    UNION
    SELECT current_task_id AS task_id
    FROM agent_status
    WHERE current_task_id IS NOT NULL AND status <> 'idle'
    UNION
    SELECT task_id
    FROM task_runtime_leases
    WHERE task_id IS NOT NULL AND trim(task_id) <> ''
    UNION
    SELECT parent_task_id AS task_id
    FROM task_runtime_leases
    WHERE parent_task_id IS NOT NULL AND trim(parent_task_id) <> ''
    ORDER BY task_id
  `).all().map((row) => String(row.task_id || "").trim()).filter(Boolean);
}

/**
 * 调用方已确认过期 worker 身份不再存活后，原子收敛任务/Agent/租约残留。
 * 事务内仍会复查有效租约，避免误清理刚被其它 Gateway 心跳续租的任务。
 */
export function settleInactiveTaskRuntimeState(taskId, {
  now = Date.now(),
  reason = "Gateway 运行租约已失效，任务未继续执行",
} = {}) {
  const task = String(taskId || "").trim();
  if (!task) return { active: false, taskUpdated: 0, agentsCleared: 0, leasesRemoved: 0 };
  const checkedAt = Math.max(0, Number(now) || Date.now());
  const failureResult = JSON.stringify({
    error: String(reason || "Gateway 运行租约已失效，任务未继续执行"),
    code: "STALE_RUNTIME_LEASE",
  });
  return db.transaction(() => {
    const activeRuntime = !!db.prepare(`
      SELECT 1
      FROM task_runtime_leases
      WHERE expires_at > ?
        AND (task_id = ? OR parent_task_id = ?)
      LIMIT 1
    `).get(checkedAt, task, task);
    const activeWorktree = !!db.prepare(`
      SELECT 1
      FROM worktree_resource_leases
      WHERE expires_at > ? AND kind = 'ai' AND task_id = ?
      LIMIT 1
    `).get(checkedAt, task);
    if (activeRuntime || activeWorktree) {
      return { active: true, taskUpdated: 0, agentsCleared: 0, leasesRemoved: 0 };
    }

    const leasesRemoved = db.prepare(`
      DELETE FROM task_runtime_leases
      WHERE task_id = ? OR parent_task_id = ?
    `).run(task, task).changes;
    db.prepare(`
      DELETE FROM worktree_resource_leases
      WHERE kind = 'ai' AND task_id = ? AND expires_at <= ?
    `).run(task, checkedAt);
    const taskUpdated = db.prepare(`
      UPDATE tasks
      SET status = 'failed',
          result = CASE
            WHEN result IS NULL OR trim(result) = '' THEN ?
            ELSE result
          END,
          updated_at = datetime('now', 'localtime')
      WHERE id = ? AND status = 'running'
    `).run(failureResult, task).changes;
    const agentsCleared = db.prepare(`
      UPDATE agent_status
      SET status = 'idle',
          current_task_id = NULL,
          last_heartbeat = datetime('now', 'localtime')
      WHERE current_task_id = ?
    `).run(task).changes;
    return { active: false, taskUpdated, agentsCleared, leasesRemoved };
  })();
}

// ---------- 跨 Gateway 的 worktree 物理资源租约 ----------

export function claimWorktreeResourceLease({
  resourceKeys,
  leaseToken,
  kind,
  tabId = null,
  taskId = null,
  ownerInstance,
  ownerPid = process.pid,
  now = Date.now(),
  ttlMs = 15000,
} = {}) {
  const keys = [...new Set((Array.isArray(resourceKeys) ? resourceKeys : [])
    .map((value) => String(value || "").trim())
    .filter(Boolean))]
    .sort();
  const token = String(leaseToken || "").trim();
  const leaseKind = String(kind || "").trim();
  const owner = String(ownerInstance || "").trim();
  if (!keys.length || !token || !leaseKind || !owner) {
    return { ok: false, reason: "invalid_lease" };
  }
  const heartbeatAt = Math.max(0, Number(now) || Date.now());
  const expiresAt = heartbeatAt + Math.max(1000, Number(ttlMs) || 15000);
  const placeholders = keys.map(() => "?").join(",");
  const claim = db.transaction(() => {
    db.prepare(`
      DELETE FROM worktree_resource_leases
      WHERE expires_at <= ? AND resource_key IN (${placeholders})
    `).run(heartbeatAt, ...keys);
    const conflict = db.prepare(`
      SELECT resource_key, lease_token, kind, tab_id, task_id, owner_instance, expires_at
      FROM worktree_resource_leases
      WHERE resource_key IN (${placeholders})
      ORDER BY resource_key
      LIMIT 1
    `).get(...keys);
    if (conflict) return { ok: false, reason: "conflict", conflict };
    const insert = db.prepare(`
      INSERT INTO worktree_resource_leases
        (resource_key, lease_token, kind, tab_id, task_id, owner_instance, owner_pid,
         acquired_at, heartbeat_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const resourceKey of keys) {
      insert.run(
        resourceKey,
        token,
        leaseKind,
        String(tabId || "").trim() || null,
        String(taskId || "").trim() || null,
        owner,
        Number(ownerPid) || 0,
        heartbeatAt,
        heartbeatAt,
        expiresAt,
      );
    }
    return { ok: true, leaseToken: token, resourceKeys: keys, expiresAt };
  });
  return claim.immediate();
}

export function renewWorktreeResourceLease(
  leaseToken,
  ownerInstance,
  { now = Date.now(), ttlMs = 15000 } = {},
) {
  const token = String(leaseToken || "").trim();
  const owner = String(ownerInstance || "").trim();
  if (!token || !owner) return { changes: 0 };
  const heartbeatAt = Math.max(0, Number(now) || Date.now());
  const expiresAt = heartbeatAt + Math.max(1000, Number(ttlMs) || 15000);
  return db.prepare(`
    UPDATE worktree_resource_leases
    SET heartbeat_at = ?, expires_at = ?
    WHERE lease_token = ? AND owner_instance = ?
  `).run(heartbeatAt, expiresAt, token, owner);
}

export function releaseWorktreeResourceLease(leaseToken, ownerInstance) {
  const token = String(leaseToken || "").trim();
  const owner = String(ownerInstance || "").trim();
  if (!token || !owner) return { changes: 0 };
  return db.prepare(`
    DELETE FROM worktree_resource_leases
    WHERE lease_token = ? AND owner_instance = ?
  `).run(token, owner);
}

export function releaseWorktreeResourceLeasesForOwner(ownerInstance) {
  const owner = String(ownerInstance || "").trim();
  if (!owner) return { changes: 0 };
  return db.prepare("DELETE FROM worktree_resource_leases WHERE owner_instance = ?").run(owner);
}

/**
 * 按 taskId 强制释放指定 kind（默认 ai）的 worktree 资源租约，不论 owner / 过期与否。
 * 仅用于已判定为"卡住"的任务收敛：心跳定时器泄漏导致租约被持续续期时，由 stop 端点显式清理。
 */
export function releaseWorktreeResourceLeasesForTask(taskId, kind = "ai") {
  const task = String(taskId || "").trim();
  if (!task) return { changes: 0 };
  const leaseKind = String(kind || "").trim();
  if (!leaseKind) return { changes: 0 };
  return db.prepare(`
    DELETE FROM worktree_resource_leases
    WHERE task_id = ? AND kind = ?
  `).run(task, leaseKind);
}

export function listActiveWorktreeResourceLeases(resourceKeys, now = Date.now()) {
  const keys = [...new Set((Array.isArray(resourceKeys) ? resourceKeys : [])
    .map((value) => String(value || "").trim())
    .filter(Boolean))];
  if (!keys.length) return [];
  const checkedAt = Math.max(0, Number(now) || Date.now());
  const placeholders = keys.map(() => "?").join(",");
  return db.prepare(`
    SELECT resource_key, lease_token, kind, tab_id, task_id, owner_instance,
           owner_pid, acquired_at, heartbeat_at, expires_at
    FROM worktree_resource_leases
    WHERE expires_at > ? AND resource_key IN (${placeholders})
    ORDER BY acquired_at, resource_key
  `).all(checkedAt, ...keys);
}

export function listWorktreeResourceLeases(resourceKeys) {
  const keys = [...new Set((Array.isArray(resourceKeys) ? resourceKeys : [])
    .map((value) => String(value || "").trim())
    .filter(Boolean))];
  if (!keys.length) return [];
  const placeholders = keys.map(() => "?").join(",");
  return db.prepare(`
    SELECT resource_key, lease_token, kind, tab_id, task_id, owner_instance,
           owner_pid, acquired_at, heartbeat_at, expires_at
    FROM worktree_resource_leases
    WHERE resource_key IN (${placeholders})
    ORDER BY acquired_at, resource_key
  `).all(...keys);
}

export function hasActiveWorktreeResourceLeaseForTask(taskId, now = Date.now()) {
  const task = String(taskId || "").trim();
  if (!task) return false;
  return !!db.prepare(`
    SELECT 1
    FROM worktree_resource_leases
    WHERE expires_at > ? AND kind = 'ai' AND task_id = ?
    LIMIT 1
  `).get(Math.max(0, Number(now) || Date.now()), task);
}

export function countActiveWorktreeResourceLeaseRows(
  leaseToken,
  ownerInstance,
  now = Date.now(),
) {
  const token = String(leaseToken || "").trim();
  const owner = String(ownerInstance || "").trim();
  if (!token || !owner) return 0;
  return Number(db.prepare(`
    SELECT COUNT(*) AS count
    FROM worktree_resource_leases
    WHERE lease_token = ? AND owner_instance = ? AND expires_at > ?
  `).get(token, owner, Math.max(0, Number(now) || Date.now()))?.count || 0);
}

function parseStoryWorkspaceRow(row) {
  if (!row) return null;
  let workspace = null;
  try { workspace = JSON.parse(row.workspace_json || "null"); } catch {}
  const members = db.prepare(`
    SELECT workspace_id, repo_id, relative_dir, logical_branch, checkout_branch,
           checkout_commit, mode, worktree_path, status, member_json
    FROM story_workspace_member
    WHERE workspace_id = ?
    ORDER BY repo_id
  `).all(row.id).map((member) => {
    let value = null;
    try { value = JSON.parse(member.member_json || "null"); } catch {}
    return { ...member, value };
  });
  return { ...row, workspace, members };
}

/** Bundle worktree 的重启恢复镜像；tab/worktree 对象仍是运行态唯一入口。 */
export function saveStoryWorkspaceBundle(storyId, workspace, { status = "READY", nodeId = "" } = {}) {
  const story = String(storyId || "").trim();
  const workspaceId = String(workspace?.workspaceId || "").trim();
  if (!story || !workspaceId || workspace?.bundle?.enabled !== true) {
    throw Object.assign(new Error("持久化 Bundle 工作区缺少 storyId、workspaceId 或 Bundle"), {
      code: "STORY_WORKSPACE_RECORD_INVALID",
    });
  }
  const rootPath = String(workspace.root || workspace.bundle.root || "").trim();
  const logicalBranch = String(workspace.preflight?.logicalBranch
    || workspace.entries?.find((entry) => entry.role === "primary")?.logicalBranch || "").trim();
  const buildEntryRepositoryId = String(workspace.bundle.buildEntryRepositoryId || "").trim();
  const now = Date.now();
  const createdAt = Math.max(0, Number(workspace.createdAt) || now);
  const save = db.transaction(() => {
    const previous = db.prepare("SELECT id FROM story_workspace WHERE story_id = ?").get(story);
    if (previous?.id && previous.id !== workspaceId) {
      db.prepare("DELETE FROM story_workspace_member WHERE workspace_id = ?").run(previous.id);
      db.prepare("DELETE FROM story_workspace WHERE id = ?").run(previous.id);
    }
    db.prepare(`
      INSERT INTO story_workspace (
        id, story_id, node_id, root_path, layout_version, logical_branch,
        build_entry_repo_id, status, workspace_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        story_id = excluded.story_id,
        node_id = excluded.node_id,
        root_path = excluded.root_path,
        layout_version = excluded.layout_version,
        logical_branch = excluded.logical_branch,
        build_entry_repo_id = excluded.build_entry_repo_id,
        status = excluded.status,
        workspace_json = excluded.workspace_json,
        updated_at = excluded.updated_at
    `).run(
      workspaceId,
      story,
      String(nodeId || "").trim(),
      rootPath,
      Math.max(2, Number(workspace.layoutVersion) || 2),
      logicalBranch,
      buildEntryRepositoryId,
      String(status || "READY").trim().toUpperCase(),
      JSON.stringify(workspace),
      createdAt,
      now,
    );
    db.prepare("DELETE FROM story_workspace_member WHERE workspace_id = ?").run(workspaceId);
    const insertMember = db.prepare(`
      INSERT INTO story_workspace_member (
        workspace_id, repo_id, relative_dir, logical_branch, checkout_branch,
        checkout_commit, mode, worktree_path, status, member_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const entry of Array.isArray(workspace.entries) ? workspace.entries : []) {
      if (!entry?.repositoryId) continue;
      insertMember.run(
        workspaceId,
        String(entry.repositoryId),
        String(entry.checkoutDirName || entry.directoryName || ""),
        String(entry.logicalBranch || ""),
        String(entry.branch || "") || null,
        String(entry.baseRevision || "") || null,
        String(entry.mode || "EDITABLE"),
        String(entry.worktreePath || entry.path || ""),
        entry.active === false ? "INACTIVE" : "READY",
        JSON.stringify(entry),
      );
    }
    return parseStoryWorkspaceRow(db.prepare("SELECT * FROM story_workspace WHERE id = ?").get(workspaceId));
  });
  return save.immediate();
}

export function getStoryWorkspaceBundle(storyId) {
  const story = String(storyId || "").trim();
  if (!story) return null;
  return parseStoryWorkspaceRow(db.prepare("SELECT * FROM story_workspace WHERE story_id = ?").get(story));
}

export function deleteStoryWorkspaceBundle(storyId, workspaceId = "") {
  const story = String(storyId || "").trim();
  const id = String(workspaceId || "").trim();
  const remove = db.transaction(() => {
    const rows = id
      ? db.prepare("SELECT id FROM story_workspace WHERE id = ? AND (? = '' OR story_id = ?)").all(id, story, story)
      : db.prepare("SELECT id FROM story_workspace WHERE story_id = ?").all(story);
    for (const row of rows) db.prepare("DELETE FROM story_workspace_member WHERE workspace_id = ?").run(row.id);
    const changes = id
      ? db.prepare("DELETE FROM story_workspace WHERE id = ? AND (? = '' OR story_id = ?)").run(id, story, story).changes
      : db.prepare("DELETE FROM story_workspace WHERE story_id = ?").run(story).changes;
    return { changes, workspaceIds: rows.map((row) => row.id) };
  });
  return remove.immediate();
}

// ---------- Token用量 ----------

export function addTokenUsage(taskId, engine, inputTokens, outputTokens, telemetry = {}) {
  const usage = telemetry?.usage || telemetry || {};
  const source = ["provider", "estimated", "unavailable"].includes(usage.source)
    ? usage.source
    : "estimated";
  return db
    .prepare(
      `INSERT INTO token_usage (
         task_id, engine, model, story_id, attempt_id, workflow_kind, stage,
         context_id, context_revision, turn_attempt,
         prompt_chars, prompt_sha256, system_chars, stage_chars, context_chars,
         tool_schema_chars, tool_result_chars,
         input_tokens, output_tokens,
         cache_read_tokens, cache_creation_tokens, usage_source,
         request_count, request_attempts, retry_count,
         transport_retry_count, workflow_retry_count,
         tool_rounds, tool_calls, succeeded, execution_succeeded
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      taskId,
      engine,
      telemetry.model || null,
      telemetry.storyId || null,
      telemetry.attemptId || null,
      telemetry.workflowKind || null,
      telemetry.stage || null,
      telemetry.contextId || null,
      telemetry.contextRevision == null ? null : Number(telemetry.contextRevision),
      Math.max(1, Number(telemetry.turnAttempt || 1)),
      Number(telemetry.promptChars || 0),
      telemetry.promptSha256 || null,
      telemetry.systemChars == null ? null : Number(telemetry.systemChars),
      telemetry.stageChars == null ? null : Number(telemetry.stageChars),
      telemetry.contextChars == null ? null : Number(telemetry.contextChars),
      telemetry.toolSchemaChars == null ? null : Number(telemetry.toolSchemaChars),
      Number(telemetry.toolResultChars || 0),
      inputTokens,
      outputTokens,
      Number(usage.cacheReadTokens || 0),
      Number(usage.cacheCreationTokens || 0),
      source,
      Number(telemetry.requestCount || 0),
      Number(telemetry.requestAttempts || 0),
      Number(telemetry.retryCount || 0),
      Number(telemetry.transportRetryCount || 0),
      Number(telemetry.workflowRetryCount || 0),
      telemetry.toolRounds == null ? null : Number(telemetry.toolRounds),
      Number(telemetry.toolCalls || 0),
      telemetry.executionSucceeded == null ? null : (telemetry.executionSucceeded ? 1 : 0),
      telemetry.executionSucceeded == null ? null : (telemetry.executionSucceeded ? 1 : 0),
    );
}

function normalizedMetricsDays(value, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(3650, Math.max(1, Math.floor(parsed)));
}

export function getTokenUsage({ days = 30 } = {}) {
  const windowDays = normalizedMetricsDays(days, 30);
  return db
    .prepare(
      `SELECT engine,
              SUM(input_tokens) as total_input,
              SUM(output_tokens) as total_output,
              SUM(CASE WHEN usage_source = 'provider' THEN input_tokens ELSE 0 END) as provider_input,
              SUM(CASE WHEN usage_source = 'provider' THEN output_tokens ELSE 0 END) as provider_output,
              SUM(CASE WHEN usage_source = 'estimated' THEN input_tokens ELSE 0 END) as estimated_input,
              SUM(CASE WHEN usage_source = 'estimated' THEN output_tokens ELSE 0 END) as estimated_output,
              SUM(cache_read_tokens) as cache_read_tokens,
              SUM(cache_creation_tokens) as cache_creation_tokens,
              SUM(prompt_chars) as prompt_chars,
              SUM(tool_schema_chars) as tool_schema_chars,
              SUM(tool_result_chars) as tool_result_chars,
              SUM(request_count) as request_count,
              SUM(request_attempts) as request_attempts,
              SUM(retry_count) as retry_count,
              SUM(transport_retry_count) as transport_retry_count,
              SUM(workflow_retry_count) as workflow_retry_count,
              SUM(tool_rounds) as tool_rounds,
              SUM(tool_calls) as tool_calls,
              SUM(CASE WHEN usage_source = 'unavailable' THEN 1 ELSE 0 END) as unavailable_calls,
              SUM(CASE WHEN COALESCE(execution_succeeded, succeeded) = 1 THEN 1 ELSE 0 END) as execution_succeeded_calls,
              SUM(CASE WHEN COALESCE(execution_succeeded, succeeded) = 0 THEN 1 ELSE 0 END) as execution_failed_calls,
              SUM(CASE WHEN COALESCE(execution_succeeded, succeeded) = 1 THEN 1 ELSE 0 END) as succeeded_calls,
              SUM(CASE WHEN COALESCE(execution_succeeded, succeeded) = 0 THEN 1 ELSE 0 END) as failed_calls,
              COUNT(*) as call_count
       FROM token_usage
       WHERE created_at >= datetime('now', 'localtime', ?)
       GROUP BY engine`
    )
    .all(`-${windowDays} days`);
}

export function getTokenUsageDaily({ days = 7 } = {}) {
  const windowDays = normalizedMetricsDays(days, 7);
  return db
    .prepare(
      `SELECT date(created_at) as date, engine,
              SUM(input_tokens) as input_tokens,
              SUM(output_tokens) as output_tokens,
              SUM(CASE WHEN usage_source = 'provider' THEN input_tokens ELSE 0 END) as provider_input_tokens,
              SUM(CASE WHEN usage_source = 'provider' THEN output_tokens ELSE 0 END) as provider_output_tokens,
              SUM(CASE WHEN usage_source = 'estimated' THEN input_tokens ELSE 0 END) as estimated_input_tokens,
              SUM(CASE WHEN usage_source = 'estimated' THEN output_tokens ELSE 0 END) as estimated_output_tokens,
              SUM(cache_read_tokens) as cache_read_tokens,
              SUM(cache_creation_tokens) as cache_creation_tokens,
              SUM(prompt_chars) as prompt_chars,
              SUM(tool_schema_chars) as tool_schema_chars,
              SUM(tool_result_chars) as tool_result_chars,
              SUM(request_count) as request_count,
              SUM(request_attempts) as request_attempts,
              SUM(retry_count) as retry_count,
              SUM(transport_retry_count) as transport_retry_count,
              SUM(workflow_retry_count) as workflow_retry_count,
              SUM(tool_rounds) as tool_rounds,
              SUM(tool_calls) as tool_calls,
              SUM(CASE WHEN usage_source = 'unavailable' THEN 1 ELSE 0 END) as unavailable_calls,
              SUM(CASE WHEN COALESCE(execution_succeeded, succeeded) = 1 THEN 1 ELSE 0 END) as execution_succeeded_calls,
              SUM(CASE WHEN COALESCE(execution_succeeded, succeeded) = 0 THEN 1 ELSE 0 END) as execution_failed_calls,
              SUM(CASE WHEN COALESCE(execution_succeeded, succeeded) = 1 THEN 1 ELSE 0 END) as succeeded_calls,
              SUM(CASE WHEN COALESCE(execution_succeeded, succeeded) = 0 THEN 1 ELSE 0 END) as failed_calls,
              COUNT(*) as calls
       FROM token_usage
       WHERE created_at >= datetime('now', 'localtime', ?)
       GROUP BY date(created_at), engine
       ORDER BY date(created_at)`
    )
    .all(`-${windowDays} days`);
}

export function recordWorkflowStageObservation({
  storyId = null,
  taskId = null,
  attemptId = null,
  workflowKind = null,
  stage = "UNKNOWN",
  markerKind = null,
  phaseBefore = null,
  phaseAfter = null,
  outcome = "unknown",
  reportValidationRetry = false,
  errorCode = null,
  recordedAt = Date.now(),
} = {}) {
  return db.prepare(`
    INSERT INTO workflow_stage_observations (
      story_id, task_id, attempt_id, workflow_kind, stage, marker_kind,
      phase_before, phase_after, outcome, report_validation_retry, error_code, recorded_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    storyId == null ? null : String(storyId),
    taskId == null ? null : String(taskId),
    attemptId == null ? null : String(attemptId),
    workflowKind == null ? null : String(workflowKind),
    String(stage || "UNKNOWN"),
    markerKind == null ? null : String(markerKind),
    phaseBefore == null ? null : String(phaseBefore),
    phaseAfter == null ? null : String(phaseAfter),
    String(outcome || "unknown"),
    reportValidationRetry ? 1 : 0,
    errorCode == null ? null : String(errorCode).slice(0, 120),
    Math.max(0, Number(recordedAt) || Date.now()),
  );
}

const insertTbWriteObservation = db.transaction(({
  storyId,
  tbTaskId,
  writeKind,
  payloadSha256,
  outcome,
  errorCode,
  recordedAt,
}) => {
  const duplicateCandidate = outcome === "succeeded" && !!db.prepare(`
    SELECT 1
    FROM tb_write_observations
    WHERE tb_task_id = ? AND write_kind = ? AND payload_sha256 = ? AND outcome = 'succeeded'
    LIMIT 1
  `).get(tbTaskId, writeKind, payloadSha256);
  const info = db.prepare(`
    INSERT INTO tb_write_observations (
      story_id, tb_task_id, write_kind, payload_sha256,
      outcome, duplicate_candidate, error_code, recorded_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    storyId,
    tbTaskId,
    writeKind,
    payloadSha256,
    outcome,
    duplicateCandidate ? 1 : 0,
    errorCode,
    recordedAt,
  );
  return { ...info, duplicateCandidate };
});

export function recordTbWriteObservation({
  storyId = null,
  tbTaskId,
  writeKind,
  payloadSha256,
  outcome,
  errorCode = null,
  recordedAt = Date.now(),
} = {}) {
  const taskId = String(tbTaskId || "").trim();
  const kind = String(writeKind || "").trim();
  const fingerprint = String(payloadSha256 || "").trim().toLowerCase();
  const normalizedOutcome = ["succeeded", "failed", "skipped"].includes(outcome) ? outcome : "failed";
  if (!taskId || !kind || !/^[a-f0-9]{64}$/.test(fingerprint)) {
    throw new Error("TB 写入观测缺少 task/kind/SHA-256");
  }
  return insertTbWriteObservation.immediate({
    storyId: storyId == null ? null : String(storyId),
    tbTaskId: taskId,
    writeKind: kind,
    payloadSha256: fingerprint,
    outcome: normalizedOutcome,
    errorCode: errorCode == null ? null : String(errorCode).slice(0, 120),
    recordedAt: Math.max(0, Number(recordedAt) || Date.now()),
  });
}

export function getWorkflowObservability({ days = 30 } = {}) {
  const since = Date.now() - normalizedMetricsDays(days, 30) * 24 * 60 * 60 * 1000;
  const stages = db.prepare(`
    SELECT stage,
           COUNT(*) AS attempts,
           SUM(CASE WHEN outcome = 'advanced' THEN 1 ELSE 0 END) AS advanced,
           SUM(CASE WHEN outcome = 'blocked' THEN 1 ELSE 0 END) AS blocked,
           SUM(CASE WHEN outcome = 'execution_failed' THEN 1 ELSE 0 END) AS execution_failed,
           SUM(CASE WHEN outcome = 'stopped' THEN 1 ELSE 0 END) AS stopped,
           SUM(CASE WHEN outcome = 'no_transition' THEN 1 ELSE 0 END) AS no_transition
    FROM workflow_stage_observations
    WHERE recorded_at >= ?
    GROUP BY stage
    ORDER BY stage
  `).all(since).map((row) => ({
    ...row,
    measured_attempts: Math.max(0, Number(row.attempts || 0) - Number(row.stopped || 0)),
    advancement_rate: Number(row.attempts || 0) - Number(row.stopped || 0) > 0
      ? Number(row.advanced || 0) / (Number(row.attempts) - Number(row.stopped || 0))
      : null,
  }));
  const report = db.prepare(`
    SELECT COUNT(*) AS validation_attempts,
           SUM(report_validation_retry) AS retry_required
    FROM workflow_stage_observations
    WHERE recorded_at >= ?
      AND (workflow_kind = 'report' OR stage = 'REPORT' OR marker_kind = 'report_done')
      AND outcome <> 'stopped'
  `).get(since);
  const tbWrites = db.prepare(`
    SELECT write_kind,
           COUNT(*) AS attempts,
           SUM(CASE WHEN outcome = 'succeeded' THEN 1 ELSE 0 END) AS succeeded,
           SUM(CASE WHEN outcome = 'failed' THEN 1 ELSE 0 END) AS failed,
           SUM(CASE WHEN outcome = 'skipped' THEN 1 ELSE 0 END) AS skipped,
           SUM(duplicate_candidate) AS duplicate_candidates
    FROM tb_write_observations
    WHERE recorded_at >= ?
    GROUP BY write_kind
    ORDER BY write_kind
  `).all(since).map((row) => ({
    ...row,
    duplicate_candidate_rate: Number(row.succeeded || 0) > 0
      ? Number(row.duplicate_candidates || 0) / Number(row.succeeded)
      : null,
  }));
  return {
    stages,
    report: {
      validationAttempts: Number(report?.validation_attempts || 0),
      retryRequired: Number(report?.retry_required || 0),
      retryRequiredRate: Number(report?.validation_attempts || 0) > 0
        ? Number(report?.retry_required || 0) / Number(report.validation_attempts)
        : null,
    },
    tbWrites,
  };
}

// ---------- 聊天消息 ----------

export function addChatMessage(role, content, taskId = null, engine = null, sessionId = null, transcript = null) {
  const transcriptJson = transcript ? JSON.stringify(transcript) : null;
  return db
    .prepare(
      "INSERT INTO chat_messages (role, content, task_id, engine, session_id, transcript_json) VALUES (?, ?, ?, ?, ?, ?)"
    )
    .run(role, content, taskId, engine, sessionId, transcriptJson);
}

export function getChatMessages({ limit = 50 } = {}) {
  return db
    .prepare("SELECT * FROM chat_messages ORDER BY created_at DESC LIMIT ?")
    .all(limit);
}

export function clearChatMessages() {
  return db.prepare("DELETE FROM chat_messages").run();
}

export function getChatMessagesInRange(since, until) {
  return db
    .prepare("SELECT role, content, engine, created_at FROM chat_messages WHERE created_at >= ? AND created_at <= ? ORDER BY created_at ASC")
    .all(since, until + " 23:59:59");
}

export function getTasksInRange(since, until) {
  return db
    .prepare("SELECT status, type, title, assigned_engine, created_at FROM tasks WHERE created_at >= ? AND created_at <= ? ORDER BY created_at ASC")
    .all(since, until + " 23:59:59");
}

// ---------- 会话管理 ----------

export function createChatSession(id, title = "新对话") {
  return db
    .prepare("INSERT INTO chat_sessions (id, title) VALUES (?, ?)")
    .run(id, title);
}

export function listChatSessions({ limit = 50 } = {}) {
  return db
    .prepare("SELECT * FROM chat_sessions ORDER BY pinned DESC, updated_at DESC LIMIT ?")
    .all(limit);
}

export function getChatSession(id) {
  return db.prepare("SELECT * FROM chat_sessions WHERE id = ?").get(id);
}

export function updateChatSession(id, updates) {
  const fields = [];
  const params = { id };
  for (const [key, value] of Object.entries(updates)) {
    fields.push(`${key} = @${key}`);
    params[key] = value;
  }
  fields.push("updated_at = datetime('now', 'localtime')");
  const sql = `UPDATE chat_sessions SET ${fields.join(", ")} WHERE id = @id`;
  return db.prepare(sql).run(params);
}

export function updateChatSessionCliId(sessionId, engine, cliSessionId) {
  const column = engine === "claude" ? "claude_session_id" : "gemini_session_id";
  return db
    .prepare(`UPDATE chat_sessions SET ${column} = ?, updated_at = datetime('now', 'localtime') WHERE id = ?`)
    .run(cliSessionId, sessionId);
}

export function deleteChatSession(id) {
  db.prepare("DELETE FROM chat_messages WHERE session_id = ?").run(id);
  return db.prepare("DELETE FROM chat_sessions WHERE id = ?").run(id);
}

export function getSessionMessages(sessionId, { limit = 200, offset } = {}) {
  if (offset !== undefined) {
    // 分页模式：从最新往旧取（offset=0 是最新的）
    return db
      .prepare("SELECT * FROM (SELECT * FROM chat_messages WHERE session_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?) ORDER BY created_at ASC")
      .all(sessionId, limit, offset);
  }
  return db
    .prepare("SELECT * FROM chat_messages WHERE session_id = ? ORDER BY created_at ASC LIMIT ?")
    .all(sessionId, limit);
}

export function getSessionMessageCount(sessionId) {
  const row = db.prepare("SELECT COUNT(*) as count FROM chat_messages WHERE session_id = ?").get(sessionId);
  return row?.count || 0;
}

// ---------- 日志搜索 ----------

export function searchLogs({ taskId, taskIds, keyword, level, limit = 200 } = {}) {
  let sql = "SELECT tl.*, t.title as task_title, t.source_id as session_id FROM task_logs tl LEFT JOIN tasks t ON tl.task_id = t.id WHERE 1=1";
  const params = {};

  if (taskIds && taskIds.length > 0) {
    const placeholders = taskIds.map((_, i) => `@tid${i}`).join(", ");
    sql += ` AND tl.task_id IN (${placeholders})`;
    taskIds.forEach((tid, i) => { params[`tid${i}`] = tid; });
  } else if (taskId) {
    sql += " AND tl.task_id = @taskId";
    params.taskId = taskId;
  }
  if (keyword) {
    sql += " AND tl.message LIKE @keyword";
    params.keyword = `%${keyword}%`;
  }
  if (level) {
    sql += " AND tl.level = @level";
    params.level = level;
  }

  sql += " ORDER BY tl.created_at DESC LIMIT @limit";
  params.limit = limit;

  return db.prepare(sql).all(params);
}

// ---------- 工作流模板 ----------

db.exec(`
  CREATE TABLE IF NOT EXISTS workflows (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT,
    steps TEXT NOT NULL DEFAULT '[]',
    created_at TEXT DEFAULT (datetime('now', 'localtime')),
    updated_at TEXT DEFAULT (datetime('now', 'localtime'))
  );

  CREATE TABLE IF NOT EXISTS workflow_runs (
    id TEXT PRIMARY KEY,
    workflow_id TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    step_states TEXT DEFAULT '{}',
    variables TEXT DEFAULT '{}',
    parent_task_id TEXT,
    trigger_source TEXT,
    session_id TEXT,
    created_at TEXT DEFAULT (datetime('now', 'localtime')),
    updated_at TEXT DEFAULT (datetime('now', 'localtime')),
    completed_at TEXT,
    FOREIGN KEY (workflow_id) REFERENCES workflows(id)
  );

  CREATE INDEX IF NOT EXISTS idx_workflow_runs_workflow ON workflow_runs(workflow_id);
  CREATE INDEX IF NOT EXISTS idx_workflow_runs_status ON workflow_runs(status);
`);

// 迁移：工作流角色配置
try { db.exec("ALTER TABLE workflows ADD COLUMN config TEXT DEFAULT '{}'"); } catch {}
// 迁移：工作流运行实例角色状态（审查记录）
try { db.exec("ALTER TABLE workflow_runs ADD COLUMN role_states TEXT DEFAULT '{}'"); } catch {}

export function createWorkflow(workflow) {
  return db.prepare(`
    INSERT INTO workflows (id, name, description, steps, config)
    VALUES (@id, @name, @description, @steps, @config)
  `).run({ config: "{}", ...workflow });
}

export function getWorkflow(id) {
  return db.prepare("SELECT * FROM workflows WHERE id = ?").get(id);
}

export function listWorkflows() {
  return db.prepare("SELECT * FROM workflows ORDER BY updated_at DESC").all();
}

export function updateWorkflow(id, updates) {
  const fields = [];
  const params = { id };
  for (const [key, value] of Object.entries(updates)) {
    fields.push(`${key} = @${key}`);
    params[key] = value;
  }
  fields.push("updated_at = datetime('now', 'localtime')");
  return db.prepare(`UPDATE workflows SET ${fields.join(", ")} WHERE id = @id`).run(params);
}

export function deleteWorkflow(id) {
  return db.prepare("DELETE FROM workflows WHERE id = ?").run(id);
}

export function createWorkflowRun(run) {
  return db.prepare(`
    INSERT INTO workflow_runs (id, workflow_id, status, step_states, variables, parent_task_id, trigger_source, session_id)
    VALUES (@id, @workflowId, @status, @stepStates, @variables, @parentTaskId, @triggerSource, @sessionId)
  `).run(run);
}

export function getWorkflowRun(id) {
  return db.prepare("SELECT * FROM workflow_runs WHERE id = ?").get(id);
}

export function listWorkflowRuns({ workflowId, status, limit = 20 } = {}) {
  let sql = "SELECT wr.*, w.name as workflow_name FROM workflow_runs wr LEFT JOIN workflows w ON wr.workflow_id = w.id WHERE 1=1";
  const params = {};
  if (workflowId) { sql += " AND wr.workflow_id = @workflowId"; params.workflowId = workflowId; }
  if (status) { sql += " AND wr.status = @status"; params.status = status; }
  sql += " ORDER BY wr.created_at DESC LIMIT @limit";
  params.limit = limit;
  return db.prepare(sql).all(params);
}

export function updateWorkflowRun(id, updates) {
  const fields = [];
  const params = { id };
  for (const [key, value] of Object.entries(updates)) {
    const snakeKey = key.replace(/[A-Z]/g, (m) => `_${m.toLowerCase()}`);
    fields.push(`${snakeKey} = @${key}`);
    params[key] = value;
  }
  fields.push("updated_at = datetime('now', 'localtime')");
  if (updates.status === "completed" || updates.status === "failed" || updates.status === "aborted") {
    fields.push("completed_at = datetime('now', 'localtime')");
  }
  return db.prepare(`UPDATE workflow_runs SET ${fields.join(", ")} WHERE id = @id`).run(params);
}

// ---------- 设备发现：历史网段 ----------

db.exec(`
  CREATE TABLE IF NOT EXISTS discovered_subnets (
    subnet TEXT PRIMARY KEY,
    source TEXT,
    last_found_at TEXT DEFAULT (datetime('now','localtime'))
  );
`);

// ---------- 设备发现：发现的设备缓存 ----------

db.exec(`
  CREATE TABLE IF NOT EXISTS discovered_devices (
    ip TEXT PRIMARY KEY,
    port INTEGER DEFAULT 5555,
    model TEXT,
    product TEXT,
    android_version TEXT,
    is_automotive INTEGER DEFAULT 0,
    screen_resolution TEXT,
    dpi INTEGER,
    status TEXT DEFAULT 'discovered',
    source TEXT,
    discovered_at TEXT DEFAULT (datetime('now','localtime')),
    updated_at TEXT DEFAULT (datetime('now','localtime'))
  );
`);

export function upsertDiscoveredDevice(dev) {
  return db.prepare(`
    INSERT INTO discovered_devices (ip, port, model, product, android_version, is_automotive, screen_resolution, dpi, status, source, updated_at)
    VALUES (@ip, @port, @model, @product, @androidVersion, @isAutomotive, @screenResolution, @dpi, @status, @source, datetime('now','localtime'))
    ON CONFLICT(ip) DO UPDATE SET
      port=@port, model=@model, product=@product, android_version=@androidVersion,
      is_automotive=@isAutomotive, screen_resolution=@screenResolution, dpi=@dpi,
      status=@status, source=@source, updated_at=datetime('now','localtime')
  `).run({
    ip: dev.ip, port: dev.port || 5555, model: dev.model || null, product: dev.product || null,
    androidVersion: dev.androidVersion || null, isAutomotive: dev.isAutomotive ? 1 : 0,
    screenResolution: dev.screenResolution || null, dpi: dev.dpi || null,
    status: dev.status || "discovered", source: dev.source || "scan",
  });
}

export function listDiscoveredDevices() {
  return db.prepare("SELECT * FROM discovered_devices ORDER BY updated_at DESC").all();
}

export function deleteDiscoveredDevice(ip) {
  return db.prepare("DELETE FROM discovered_devices WHERE ip = ?").run(ip);
}

export function clearDiscoveredDevices() {
  return db.prepare("DELETE FROM discovered_devices").run();
}

export function upsertSubnet(subnet, source) {
  return db.prepare(`
    INSERT INTO discovered_subnets (subnet, source, last_found_at)
    VALUES (?, ?, datetime('now','localtime'))
    ON CONFLICT(subnet) DO UPDATE SET last_found_at = datetime('now','localtime')
  `).run(subnet, source);
}

export function listSubnets() {
  return db.prepare("SELECT * FROM discovered_subnets ORDER BY last_found_at DESC").all();
}

export function deleteSubnet(subnet) {
  return db.prepare("DELETE FROM discovered_subnets WHERE subnet = ?").run(subnet);
}

// ---------- 性能数据（车机上报） ----------

db.exec(`
  CREATE TABLE IF NOT EXISTS perf_session (
    id TEXT PRIMARY KEY,
    scenario TEXT DEFAULT 'cold_start',
    flavor TEXT,
    app_version TEXT,
    app_version_code INTEGER DEFAULT 0,
    device_model TEXT,
    device_brand TEXT,
    channel TEXT,
    device_id TEXT,
    round TEXT,
    stage1_ms INTEGER DEFAULT 0,
    stage2_ms INTEGER DEFAULT 0,
    stage3_ms INTEGER DEFAULT 0,
    total_ms INTEGER DEFAULT 0,
    cold_loading_ms INTEGER DEFAULT 0,
    marks_json TEXT,
    raw_json TEXT,
    created_at TEXT DEFAULT (datetime('now','localtime'))
  );
  CREATE INDEX IF NOT EXISTS idx_perf_session_created ON perf_session(created_at);
  CREATE INDEX IF NOT EXISTS idx_perf_session_flavor ON perf_session(flavor);
  CREATE INDEX IF NOT EXISTS idx_perf_session_round ON perf_session(round);

  -- 稳定性事件（crash / anr，Step 4）
  CREATE TABLE IF NOT EXISTS perf_event (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT,
    type TEXT,
    detail TEXT,
    ts INTEGER,
    flavor TEXT,
    device_id TEXT,
    created_at TEXT DEFAULT (datetime('now','localtime'))
  );
  CREATE INDEX IF NOT EXISTS idx_perf_event_type ON perf_event(type);
  CREATE INDEX IF NOT EXISTS idx_perf_event_created ON perf_event(created_at);

  -- 细分指标（method/page/network/db/memory，Step 3/4）
  CREATE TABLE IF NOT EXISTS perf_metric (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT,
    name TEXT,
    value INTEGER DEFAULT 0,
    type TEXT,
    flavor TEXT,
    created_at TEXT DEFAULT (datetime('now','localtime'))
  );
  CREATE INDEX IF NOT EXISTS idx_perf_metric_type ON perf_metric(type);
  CREATE INDEX IF NOT EXISTS idx_perf_metric_created ON perf_metric(created_at);
`);

// 迁移：老库 perf_session 补 app_version_code 列（按版本对比优化效果用）
try { db.exec("ALTER TABLE perf_session ADD COLUMN app_version_code INTEGER DEFAULT 0"); } catch (e) { /* 已存在则忽略 */ }
// 迁移：补测试验收口径冷启动列（进程启动→模板页 loading，com.car.dev.perf 上报的 startup.coldToLoadingMs）
try { db.exec("ALTER TABLE perf_session ADD COLUMN cold_loading_ms INTEGER DEFAULT 0"); } catch (e) { /* 已存在则忽略 */ }

export function insertPerfSession(s) {
  return db.prepare(`
    INSERT INTO perf_session (id, scenario, flavor, app_version, app_version_code, device_model, device_brand, channel, device_id, round, stage1_ms, stage2_ms, stage3_ms, total_ms, cold_loading_ms, marks_json, raw_json)
    VALUES (@id, @scenario, @flavor, @appVersion, @appVersionCode, @deviceModel, @deviceBrand, @channel, @deviceId, @round, @stage1Ms, @stage2Ms, @stage3Ms, @totalMs, @coldLoadingMs, @marksJson, @rawJson)
    ON CONFLICT(id) DO UPDATE SET
      scenario=@scenario, flavor=@flavor, app_version=@appVersion, app_version_code=@appVersionCode, device_model=@deviceModel,
      device_brand=@deviceBrand, channel=@channel, device_id=@deviceId, round=@round,
      stage1_ms=@stage1Ms, stage2_ms=@stage2Ms, stage3_ms=@stage3Ms, total_ms=@totalMs, cold_loading_ms=@coldLoadingMs,
      marks_json=@marksJson, raw_json=@rawJson
  `).run({
    id: s.id,
    scenario: s.scenario || "cold_start",
    flavor: s.flavor || null,
    appVersion: s.appVersion || null,
    appVersionCode: s.appVersionCode || 0,
    deviceModel: s.deviceModel || null,
    deviceBrand: s.deviceBrand || null,
    channel: s.channel || null,
    deviceId: s.deviceId || null,
    round: s.round || null,
    stage1Ms: s.stage1Ms || 0,
    stage2Ms: s.stage2Ms || 0,
    stage3Ms: s.stage3Ms || 0,
    totalMs: s.totalMs || 0,
    coldLoadingMs: s.coldLoadingMs || 0,
    marksJson: s.marksJson || null,
    rawJson: s.rawJson || null,
  });
}

export function listPerfSessions({ flavor, deviceId, scenario, round, limit = 100 } = {}) {
  let sql = "SELECT * FROM perf_session WHERE 1=1";
  const params = {};
  if (flavor) { sql += " AND flavor = @flavor"; params.flavor = flavor; }
  if (deviceId) { sql += " AND device_id = @deviceId"; params.deviceId = deviceId; }
  if (scenario) { sql += " AND scenario = @scenario"; params.scenario = scenario; }
  if (round) { sql += " AND round = @round"; params.round = round; }
  sql += " ORDER BY created_at DESC LIMIT @limit";
  params.limit = limit;
  return db.prepare(sql).all(params);
}

const RESOURCE_PROFILE_KEYS = [
  "schema_version", "session_id", "scenario", "generated_at", "acceptance",
  "package", "flavor", "round", "device", "app", "sampling", "measurements",
  "metric_definitions", "thresholds", "checks", "flow", "screenrecord",
  "diagnostic", "perfetto_validation", "warnings", "artifact_dir", "script",
  "optimization_advice", "artifacts", "pdf",
];

const RESOURCE_SAMPLE_KEYS = [
  "sample_index", "target_elapsed_s", "actual_elapsed_s", "wall_time_local",
  "pids", "process_names", "logical_cpus", "cpu_one_core_equiv_pct",
  "cpu_device_normalized_pct", "pss_mb", "rss_mb", "process_set_changed",
  "collection_latency_s", "note",
];

function pickKnownFields(value, keys) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const out = {};
  for (const key of keys) {
    if (Object.hasOwn(value, key)) out[key] = value[key];
  }
  return out;
}

const RESOURCE_SCRIPT_ID_PATTERN = /^[A-Za-z][A-Za-z0-9_.-]*$/;
const RESOURCE_SCRIPT_MODES = new Set(["full", "launch-only"]);

function storedScriptText(value, maxLength, { allowEmpty = false, pattern = null } = {}) {
  if (typeof value !== "string" || /\0|[\r\n]/.test(value)) return null;
  const normalized = value.trim();
  if (!allowEmpty && !normalized) return null;
  if (normalized.length > maxLength || (pattern && normalized && !pattern.test(normalized))) return null;
  return normalized;
}

function publicStoredScriptRunner(value) {
  const runner = storedScriptText(value, 500);
  if (!runner || runner.includes("\\") || runner.includes(":")) return null;
  const parts = runner.split("/");
  if (
    !runner.startsWith("features/PerformanceFeature/")
    || !/\.py$/i.test(runner)
    || parts.some((part) => !part || part === "." || part === ".." || /[. ]$/.test(part))
  ) return null;
  return runner;
}

function publicStoredFeaturePath(value) {
  const source = storedScriptText(value, 500);
  if (!source || source.includes("\\") || source.includes(":")) return null;
  const parts = source.split("/");
  if (
    !source.startsWith("features/PerformanceFeature/")
    || parts.some((part) => !part || part === "." || part === ".." || /[. ]$/.test(part))
  ) return null;
  return source;
}

function publicStoredScriptStringArray(value, { maxItems, maxLength, path = false } = {}) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > maxItems) return null;
  const result = [];
  for (const raw of value) {
    const normalized = path ? publicStoredFeaturePath(raw) : storedScriptText(raw, maxLength);
    if (!normalized || result.includes(normalized)) return null;
    result.push(normalized);
  }
  return result;
}

function publicStoredScriptWorkflow(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  if (!Array.isArray(value.steps) || value.steps.length < 1 || value.steps.length > 100) return null;
  const keys = new Set();
  const mappedEvents = new Set();
  const steps = [];
  for (const rawStep of value.steps) {
    if (!rawStep || typeof rawStep !== "object" || Array.isArray(rawStep)) return null;
    const key = storedScriptText(rawStep.key, 80, { pattern: RESOURCE_SCRIPT_ID_PATTERN });
    const label = storedScriptText(rawStep.label, 120);
    if (!key || !label || keys.has(key)) return null;
    if (!Array.isArray(rawStep.eventSteps) || rawStep.eventSteps.length < 1 || rawStep.eventSteps.length > 20) {
      return null;
    }
    const eventSteps = [];
    for (const rawEvent of rawStep.eventSteps) {
      const eventStep = storedScriptText(rawEvent, 80, { pattern: RESOURCE_SCRIPT_ID_PATTERN });
      if (!eventStep || mappedEvents.has(eventStep)) return null;
      mappedEvents.add(eventStep);
      eventSteps.push(eventStep);
    }
    const rawModes = rawStep.modes === undefined ? ["full", "launch-only"] : rawStep.modes;
    if (!Array.isArray(rawModes) || !rawModes.length) return null;
    const modes = [];
    for (const mode of rawModes) {
      if (typeof mode !== "string" || !RESOURCE_SCRIPT_MODES.has(mode) || modes.includes(mode)) return null;
      modes.push(mode);
    }
    keys.add(key);
    steps.push({ key, label, eventSteps, modes });
  }
  return { steps };
}

function publicStoredPerformanceScript(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const id = storedScriptText(value.id, 80, { pattern: RESOURCE_SCRIPT_ID_PATTERN });
  const name = storedScriptText(value.name, 120);
  const description = storedScriptText(value.description, 500, { allowEmpty: true });
  const runner = publicStoredScriptRunner(value.runner);
  const workflow = publicStoredScriptWorkflow(value.workflow);
  if (!id || !name || description === null || !runner || !workflow) return null;
  const script = { id, name, description, runner, workflow };
  const category = storedScriptText(value.category, 80);
  const tags = publicStoredScriptStringArray(value.tags, { maxItems: 20, maxLength: 40 });
  const sourceFiles = publicStoredScriptStringArray(value.sourceFiles, { maxItems: 50, maxLength: 500, path: true });
  const version = storedScriptText(value.version, 40);
  const manifestPath = publicStoredFeaturePath(value.manifestPath);
  if (category) script.category = category;
  if (Array.isArray(value.tags) && tags) script.tags = tags;
  if (Array.isArray(value.sourceFiles) && sourceFiles) script.sourceFiles = sourceFiles;
  if (version) script.version = version;
  if (typeof value.managed === "boolean") script.managed = value.managed;
  if (manifestPath) script.manifestPath = manifestPath;
  return script;
}

function publicStoredArtifactDir(value) {
  if (typeof value !== "string") return null;
  const normalized = value.replace(/\\/g, "/").replace(/^\.\//, "");
  if (!/^docs\/tempFiles\/appmarket-performance\/[A-Za-z0-9._/-]+$/.test(normalized)) return null;
  if (normalized.split("/").some((part) => !part || part === "." || part === "..")) return null;
  return normalized;
}

function perfResourceRunSummary(row, profile = {}) {
  return {
    id: row.id,
    flavor: row.flavor || "",
    appVersion: row.app_version || "",
    appVersionCode: row.app_version_code || 0,
    deviceModel: row.device_model || "",
    deviceBrand: row.device_brand || "",
    deviceId: row.device_id || "",
    round: row.round || "",
    createdAt: row.created_at,
    acceptance: profile.acceptance || "INCONCLUSIVE",
    sampling: profile.sampling || {},
    measurements: profile.measurements || {},
    checks: Array.isArray(profile.checks) ? profile.checks : [],
    flow: profile.flow || {},
    diagnostic: profile.diagnostic || {},
    perfettoValidation: profile.perfetto_validation || {},
    script: profile.script || null,
    warnings: Array.isArray(profile.warnings) ? profile.warnings : [],
    artifactDir: publicStoredArtifactDir(profile.artifact_dir),
  };
}

function parsePerfResourceRow(row, { includeSamples = false } = {}) {
  let raw;
  try {
    raw = JSON.parse(row.raw_json || "{}");
  } catch {
    return { id: row.id, corrupt: true, run: perfResourceRunSummary(row), profile: {}, samples: [] };
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { id: row.id, corrupt: true, run: perfResourceRunSummary(row), profile: {}, samples: [] };
  }
  const profile = pickKnownFields(raw.resourceProfile, RESOURCE_PROFILE_KEYS);
  const script = publicStoredPerformanceScript(profile.script);
  if (script) profile.script = script;
  else delete profile.script;
  const samples = includeSamples && Array.isArray(raw.resourceSamples)
    ? raw.resourceSamples.map((sample) => pickKnownFields(sample, RESOURCE_SAMPLE_KEYS))
    : [];
  return {
    id: row.id,
    corrupt: false,
    run: perfResourceRunSummary(row, profile),
    profile,
    samples,
  };
}

// 应用市场 3 分钟 CPU/PSS 黑盒摸测结果。完整结构保存在 raw_json.resourceProfile，
// 这里仅投影面板需要的字段，避免前端理解车机上报的原始 envelope。
export function listPerfResourceRuns({ flavor, limit = 30 } = {}) {
  let sql = `
    SELECT id, flavor, app_version, app_version_code, device_model, device_brand,
           device_id, round, raw_json, created_at
    FROM perf_session
    WHERE scenario = 'resource_profile'
  `;
  const params = { limit };
  if (flavor) { sql += " AND flavor = @flavor"; params.flavor = flavor; }
  sql += " ORDER BY created_at DESC LIMIT @limit";
  return db.prepare(sql).all(params).map((row) => parsePerfResourceRow(row).run);
}

export function getPerfResourceRun(id) {
  const row = db.prepare(`
    SELECT id, flavor, app_version, app_version_code, device_model, device_brand,
           device_id, round, raw_json, created_at
    FROM perf_session
    WHERE id = ? AND scenario = 'resource_profile'
  `).get(id);
  return row ? parsePerfResourceRow(row, { includeSamples: true }) : null;
}

export function listPerfRounds({ limit = 50 } = {}) {
  // 只统计有效冷启动会话（scenario='cold_start' 且 total_ms>0）：
  // runtime 会话 total_ms=0、以及 run-perf-loop 某些轮次没抓到 ①②③ 的占位会话(total_ms=0)
  // 都不应进轮次对比，否则会出现"很多轮次 0ms 空条"。无任何有效冷启动数据的轮次因 WHERE 过滤后
  // 不成组，自动不出现在列表里。
  return db.prepare(`
    SELECT round,
           COUNT(*) AS sessions,
           AVG(total_ms) AS avg_total_ms,
           MIN(total_ms) AS min_total_ms,
           MAX(total_ms) AS max_total_ms,
           AVG(stage1_ms) AS avg_stage1_ms,
           AVG(stage2_ms) AS avg_stage2_ms,
           AVG(stage3_ms) AS avg_stage3_ms,
           AVG(cold_loading_ms) AS avg_cold_loading_ms,
           MAX(created_at) AS last_at
    FROM perf_session
    WHERE round IS NOT NULL AND round != ''
      AND scenario = 'cold_start' AND total_ms > 0
    GROUP BY round
    ORDER BY last_at DESC
    LIMIT @limit
  `).all({ limit });
}

// 批量写入一次会话携带的细分指标（来自上报 raw.metrics[]）
export function insertPerfMetrics(sessionId, flavor, metrics) {
  if (!Array.isArray(metrics) || metrics.length === 0) return 0;
  const stmt = db.prepare(`
    INSERT INTO perf_metric (session_id, name, value, type, flavor)
    VALUES (@sessionId, @name, @value, @type, @flavor)
  `);
  const tx = db.transaction((rows) => {
    for (const m of rows) {
      if (!m || typeof m !== "object") continue;
      stmt.run({
        sessionId,
        name: String(m.name || ""),
        // SQLite INTEGER affinity still preserves REAL values. Do not round here:
        // customer CPU thresholds include decimals (3.30% / 1.25%).
        value: Number(m.cost ?? m.value) || 0,
        type: String(m.type || ""),
        flavor: flavor || null,
      });
    }
  });
  tx(metrics);
  return metrics.length;
}

// 批量写入一次会话携带的稳定性事件（来自上报 raw.events[]）
export function insertPerfEvents(sessionId, flavor, deviceId, events) {
  if (!Array.isArray(events) || events.length === 0) return 0;
  const stmt = db.prepare(`
    INSERT INTO perf_event (session_id, type, detail, ts, flavor, device_id)
    VALUES (@sessionId, @type, @detail, @ts, @flavor, @deviceId)
  `);
  const tx = db.transaction((rows) => {
    for (const e of rows) {
      if (!e || typeof e !== "object") continue;
      stmt.run({
        sessionId,
        type: String(e.type || ""),
        detail: String(e.detail || ""),
        ts: Math.round(Number(e.ts) || 0),
        flavor: flavor || null,
        deviceId: deviceId || null,
      });
    }
  });
  tx(events);
  return events.length;
}

// 细分指标时间序列（取最近 limit 条，按时间升序返回，供趋势折线图）
export function listPerfMetrics({ type, name, flavor, limit = 300 } = {}) {
  let where = "WHERE 1=1";
  const params = { limit };
  if (type) { where += " AND type = @type"; params.type = type; }
  if (name) { where += " AND name = @name"; params.name = name; }
  if (flavor) { where += " AND flavor = @flavor"; params.flavor = flavor; }
  // 按 id（自增=插入顺序=时间顺序）排序，避免同一秒 created_at 打平时序列乱序。
  return db.prepare(`
    SELECT name, value, type, created_at FROM (
      SELECT id, name, value, type, created_at FROM perf_metric ${where}
      ORDER BY id DESC LIMIT @limit
    ) ORDER BY id ASC
  `).all(params);
}

export function listPerfEvents({ type, flavor, limit = 100 } = {}) {
  let sql = "SELECT * FROM perf_event WHERE 1=1";
  const params = {};
  if (type) { sql += " AND type = @type"; params.type = type; }
  if (flavor) { sql += " AND flavor = @flavor"; params.flavor = flavor; }
  sql += " ORDER BY created_at DESC LIMIT @limit";
  params.limit = limit;
  return db.prepare(sql).all(params);
}

// 前台使用 CPU/内存 峰值/均值聚合（测试"前台使用"口径）。
// 数据来自 perf_metric 里 type='fg' 的四类指标（车机端 PerfTracker.recordForegroundSummary 按前台会话窗口上报）：
//   cpu:fgPeak / cpu:fgAvg（占单核%）、mem:fgPeakPss / mem:fgAvgPss（PSS MB）。
// 多个前台窗口聚合：峰值取 MAX(各窗口峰值)、均值取 AVG(各窗口均值)。whereSql 限定范围（时间窗/轮次/版本）。
function selectFgAgg(whereSql, params) {
  const row = db.prepare(`
    SELECT
      MAX(CASE WHEN name = 'cpu:fgPeak'    THEN value END) AS cpu_peak,
      AVG(CASE WHEN name = 'cpu:fgAvg'     THEN value END) AS cpu_avg,
      MAX(CASE WHEN name = 'mem:fgPeakPss' THEN value END) AS mem_peak,
      AVG(CASE WHEN name = 'mem:fgAvgPss'  THEN value END) AS mem_avg
    FROM perf_metric
    WHERE type = 'fg' AND (${whereSql})
  `).get(params);
  return row || { cpu_peak: null, cpu_avg: null, mem_peak: null, mem_avg: null };
}

export function getPerfStats({ days = 30 } = {}) {
  // 启动均值只统计冷启动会话，避免 runtime（totalMs=0）会话拉低平均值。
  const overall = db.prepare(`
    SELECT COUNT(*) AS sessions,
           AVG(total_ms) AS avg_total_ms,
           AVG(stage1_ms) AS avg_stage1_ms,
           AVG(stage2_ms) AS avg_stage2_ms,
           AVG(stage3_ms) AS avg_stage3_ms,
           AVG(cold_loading_ms) AS avg_cold_loading_ms
    FROM perf_session
    WHERE scenario = 'cold_start' AND created_at >= datetime('now','localtime', @days)
  `).get({ days: `-${days} days` });
  // 按「车型 + 版本(versionName/versionCode)」分组：同一车型不同版本各占一行，便于看版本间启动变化。
  const byFlavor = db.prepare(`
    SELECT flavor,
           app_version,
           app_version_code,
           COUNT(*) AS sessions,
           AVG(total_ms) AS avg_total_ms,
           AVG(stage1_ms) AS avg_stage1_ms,
           AVG(stage2_ms) AS avg_stage2_ms,
           AVG(stage3_ms) AS avg_stage3_ms,
           AVG(cold_loading_ms) AS avg_cold_loading_ms,
           MAX(created_at) AS last_at
    FROM perf_session
    WHERE scenario = 'cold_start' AND created_at >= datetime('now','localtime', @days)
    GROUP BY flavor, app_version_code, app_version
    ORDER BY flavor ASC, app_version_code DESC
  `).all({ days: `-${days} days` });
  // 稳定性事件计数（crash / anr）
  const eventCounts = db.prepare(`
    SELECT type, COUNT(*) AS count
    FROM perf_event
    WHERE created_at >= datetime('now','localtime', @days)
    GROUP BY type
  `).all({ days: `-${days} days` });
  const events = { crash: 0, anr: 0, oom: 0 };
  for (const row of eventCounts) {
    if (row.type === "crash") events.crash = row.count;
    else if (row.type === "anr") events.anr = row.count;
    else if (row.type === "oom") events.oom = row.count;
  }
  // 前台使用 CPU/内存 峰值/均值（测试验收口径），近 N 天范围。
  const fg = selectFgAgg("created_at >= datetime('now','localtime', @days)", { days: `-${days} days` });
  return { overall, byFlavor, events, fg };
}

// 慢调用排行：按 name 聚合耗时类指标（method/network/io/page），取均值最高的 top-N
export function getTopMetrics({ types, flavor, days = 30, limit = 20 } = {}) {
  const typeList = (Array.isArray(types) && types.length) ? types : ["method", "network", "io", "page"];
  const placeholders = typeList.map((_, i) => `@t${i}`).join(",");
  const params = { limit, days: `-${days} days` };
  typeList.forEach((t, i) => { params[`t${i}`] = t; });
  let flavorClause = "";
  if (flavor) { flavorClause = " AND flavor = @flavor"; params.flavor = flavor; }
  return db.prepare(`
    SELECT name, type,
           AVG(value) AS avg_value,
           MAX(value) AS max_value,
           COUNT(*) AS n
    FROM perf_metric
    WHERE type IN (${placeholders})${flavorClause}
      AND created_at >= datetime('now','localtime', @days)
    GROUP BY name, type
    ORDER BY avg_value DESC
    LIMIT @limit
  `).all(params);
}

// 单轮明细（供 AI 分析与轮次对比）：冷启动均值 + 稳定性事件 + 最慢的若干细分指标
export function getPerfRoundDetail(round) {
  if (!round) return null;
  const agg = db.prepare(`
    SELECT COUNT(*) AS sessions,
           AVG(stage1_ms) AS avg_stage1_ms,
           AVG(stage2_ms) AS avg_stage2_ms,
           AVG(stage3_ms) AS avg_stage3_ms,
           AVG(total_ms) AS avg_total_ms,
           AVG(cold_loading_ms) AS avg_cold_loading_ms,
           MIN(total_ms) AS min_total_ms,
           MAX(total_ms) AS max_total_ms
    FROM perf_session
    WHERE round = @round AND scenario = 'cold_start'
  `).get({ round });
  const eventRows = db.prepare(`
    SELECT type, COUNT(*) AS count
    FROM perf_event
    WHERE session_id IN (SELECT id FROM perf_session WHERE round = @round)
    GROUP BY type
  `).all({ round });
  const events = { crash: 0, anr: 0, oom: 0 };
  for (const r of eventRows) {
    if (events[r.type] !== undefined) events[r.type] = r.count;
  }
  const fg = selectFgAgg("session_id IN (SELECT id FROM perf_session WHERE round = @round)", { round });
  const topMetrics = db.prepare(`
    SELECT name, type, AVG(value) AS avg_value, COUNT(*) AS n
    FROM perf_metric
    WHERE session_id IN (SELECT id FROM perf_session WHERE round = @round)
      AND type IN ('method', 'network', 'io', 'page')
    GROUP BY name, type
    ORDER BY avg_value DESC
    LIMIT 15
  `).all({ round });
  return { round, agg, events, topMetrics, fg };
}

// 最近数据明细（不依赖 round，供手动跑 Monkey 后的 AI 分析）：时间窗内冷启动均值 + 事件 + 最慢项
export function getPerfRecentDetail({ flavor, days = 7 } = {}) {
  const params = { days: `-${days} days` };
  let flavorClause = "";
  if (flavor) { flavorClause = " AND flavor = @flavor"; params.flavor = flavor; }
  const agg = db.prepare(`
    SELECT COUNT(*) AS sessions,
           AVG(stage1_ms) AS avg_stage1_ms,
           AVG(stage2_ms) AS avg_stage2_ms,
           AVG(stage3_ms) AS avg_stage3_ms,
           AVG(total_ms) AS avg_total_ms,
           AVG(cold_loading_ms) AS avg_cold_loading_ms,
           MIN(total_ms) AS min_total_ms,
           MAX(total_ms) AS max_total_ms
    FROM perf_session
    WHERE scenario = 'cold_start' AND created_at >= datetime('now','localtime', @days)${flavorClause}
  `).get(params);
  const eventRows = db.prepare(`
    SELECT type, COUNT(*) AS count
    FROM perf_event
    WHERE created_at >= datetime('now','localtime', @days)${flavorClause}
    GROUP BY type
  `).all(params);
  const events = { crash: 0, anr: 0, oom: 0 };
  for (const r of eventRows) {
    if (events[r.type] !== undefined) events[r.type] = r.count;
  }
  const topMetrics = getTopMetrics({ flavor, days, limit: 15 });
  const fg = selectFgAgg(
    `created_at >= datetime('now','localtime', @days)${flavorClause}`,
    flavor ? { days: `-${days} days`, flavor } : { days: `-${days} days` },
  );
  return { round: `最近${days}天`, agg, events, topMetrics, fg };
}

// 按 App 版本聚合冷启动（跟进优化效果：旧版本基线 vs 新版本优化后）
export function getPerfByVersion({ flavor, days = 90 } = {}) {
  const params = { days: `-${days} days` };
  let flavorClause = "";
  if (flavor) { flavorClause = " AND flavor = @flavor"; params.flavor = flavor; }
  const rows = db.prepare(`
    SELECT app_version,
           MAX(app_version_code) AS app_version_code,
           COUNT(*) AS sessions,
           AVG(stage1_ms) AS avg_stage1_ms,
           AVG(stage2_ms) AS avg_stage2_ms,
           AVG(stage3_ms) AS avg_stage3_ms,
           AVG(total_ms) AS avg_total_ms,
           AVG(cold_loading_ms) AS avg_cold_loading_ms,
           MIN(total_ms) AS min_total_ms,
           MAX(total_ms) AS max_total_ms,
           MAX(created_at) AS last_at
    FROM perf_session
    WHERE scenario = 'cold_start' AND total_ms > 0
      AND app_version IS NOT NULL AND app_version != ''
      AND created_at >= datetime('now','localtime', @days)${flavorClause}
    GROUP BY app_version
    ORDER BY app_version_code DESC, last_at DESC
  `).all(params);
  for (const r of rows) {
    const ev = db.prepare(`
      SELECT type, COUNT(*) AS c FROM perf_event
      WHERE session_id IN (SELECT id FROM perf_session WHERE app_version = @v) GROUP BY type
    `).all({ v: r.app_version });
    r.crash = 0; r.anr = 0; r.oom = 0;
    for (const e of ev) { if (r[e.type] !== undefined) r[e.type] = e.c; }
  }
  return rows;
}

// 单版本明细（供版本对比 AI 报表）：冷启动均值 + 事件 + top 慢调用（过滤掉被 monkey churn 污染的天文值）
export function getPerfVersionDetail(version) {
  const agg = db.prepare(`
    SELECT COUNT(*) AS sessions,
           AVG(stage1_ms) AS avg_stage1_ms, AVG(stage2_ms) AS avg_stage2_ms,
           AVG(stage3_ms) AS avg_stage3_ms, AVG(total_ms) AS avg_total_ms,
           AVG(cold_loading_ms) AS avg_cold_loading_ms,
           MIN(total_ms) AS min_total_ms, MAX(total_ms) AS max_total_ms
    FROM perf_session
    WHERE scenario = 'cold_start' AND total_ms > 0 AND app_version = @v
  `).get({ v: version });
  const eventRows = db.prepare(`
    SELECT type, COUNT(*) AS count FROM perf_event
    WHERE session_id IN (SELECT id FROM perf_session WHERE app_version = @v) GROUP BY type
  `).all({ v: version });
  const events = { crash: 0, anr: 0, oom: 0 };
  for (const r of eventRows) { if (events[r.type] !== undefined) events[r.type] = r.count; }
  const topMetrics = db.prepare(`
    SELECT name, type, AVG(value) AS avg_value, COUNT(*) AS n
    FROM perf_metric
    WHERE session_id IN (SELECT id FROM perf_session WHERE app_version = @v)
      AND type IN ('method', 'network', 'io', 'page') AND value < 60000
    GROUP BY name, type ORDER BY avg_value DESC LIMIT 15
  `).all({ v: version });
  const fg = selectFgAgg("session_id IN (SELECT id FROM perf_session WHERE app_version = @v)", { v: version });
  return { version, agg, events, topMetrics, fg };
}

// ---------- 性能 AI 分析报告（Step 6） ----------

db.exec(`
  CREATE TABLE IF NOT EXISTS perf_report (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    round TEXT,
    scope TEXT DEFAULT 'round',
    engine TEXT,
    input_json TEXT,
    result_md TEXT,
    created_at TEXT DEFAULT (datetime('now','localtime'))
  );
  CREATE INDEX IF NOT EXISTS idx_perf_report_round ON perf_report(round);
  CREATE INDEX IF NOT EXISTS idx_perf_report_created ON perf_report(created_at);
`);

export function insertPerfReport(r) {
  const info = db.prepare(`
    INSERT INTO perf_report (round, scope, engine, input_json, result_md)
    VALUES (@round, @scope, @engine, @inputJson, @resultMd)
  `).run({
    round: r.round || null,
    scope: r.scope || "round",
    engine: r.engine || null,
    inputJson: r.inputJson || null,
    resultMd: r.resultMd || null,
  });
  return info.lastInsertRowid;
}

export function listPerfReports({ round, limit = 50 } = {}) {
  let sql = "SELECT * FROM perf_report WHERE 1=1";
  const params = {};
  if (round) { sql += " AND round = @round"; params.round = round; }
  sql += " ORDER BY created_at DESC LIMIT @limit";
  params.limit = limit;
  return db.prepare(sql).all(params);
}

export function getPerfReport(id) {
  return db.prepare("SELECT * FROM perf_report WHERE id = ?").get(id);
}

// ---------- 统计 ----------

export function getStats() {
  const taskCounts = db
    .prepare(
      "SELECT status, COUNT(*) as count FROM tasks GROUP BY status"
    )
    .all();
  const totalTasks = db
    .prepare("SELECT COUNT(*) as count FROM tasks")
    .get();
  const todayTasks = db
    .prepare(
      "SELECT COUNT(*) as count FROM tasks WHERE date(created_at) = date('now', 'localtime')"
    )
    .get();

  return {
    taskCounts: Object.fromEntries(taskCounts.map((r) => [r.status, r.count])),
    totalTasks: totalTasks.count,
    todayTasks: todayTasks.count,
  };
}

// ---------- 定时任务 ----------

db.exec(`
  CREATE TABLE IF NOT EXISTS scheduled_tasks (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    cron_expr TEXT NOT NULL,
    enabled INTEGER DEFAULT 1,
    prompt TEXT NOT NULL,
    engine TEXT,
    skill TEXT,
    output_target TEXT DEFAULT 'log',
    output_config TEXT DEFAULT '{}',
    last_run_at TEXT,
    last_status TEXT,
    last_output_excerpt TEXT,
    created_at TEXT DEFAULT (datetime('now', 'localtime')),
    updated_at TEXT DEFAULT (datetime('now', 'localtime'))
  );
`);

export function createScheduledTask(task) {
  return db.prepare(`
    INSERT INTO scheduled_tasks (id, name, cron_expr, enabled, prompt, engine, skill, output_target, output_config)
    VALUES (@id, @name, @cronExpr, @enabled, @prompt, @engine, @skill, @outputTarget, @outputConfig)
  `).run({
    id: task.id, name: task.name, cronExpr: task.cronExpr, enabled: task.enabled ?? 1,
    prompt: task.prompt, engine: task.engine || null, skill: task.skill || null,
    outputTarget: task.outputTarget || "log", outputConfig: task.outputConfig || "{}",
  });
}

export function listScheduledTasks() {
  return db.prepare("SELECT * FROM scheduled_tasks ORDER BY created_at DESC").all();
}

export function getScheduledTask(id) {
  return db.prepare("SELECT * FROM scheduled_tasks WHERE id = ?").get(id);
}

export function updateScheduledTask(id, updates) {
  const fields = [];
  const params = { id };
  for (const [key, value] of Object.entries(updates)) {
    // camelCase → snake_case
    const col = key.replace(/[A-Z]/g, c => "_" + c.toLowerCase());
    fields.push(`${col} = @${key}`);
    params[key] = value;
  }
  fields.push("updated_at = datetime('now', 'localtime')");
  return db.prepare(`UPDATE scheduled_tasks SET ${fields.join(", ")} WHERE id = @id`).run(params);
}

export function deleteScheduledTask(id) {
  return db.prepare("DELETE FROM scheduled_tasks WHERE id = ?").run(id);
}

// ---------- TB 任务分析记录 ----------

db.exec(`
  CREATE TABLE IF NOT EXISTS tb_task_records (
    id TEXT PRIMARY KEY,
    carb_id TEXT,
    title TEXT,
    project_name TEXT,
    group_name TEXT,
    priority TEXT,
    creator_id TEXT,
    creator_name TEXT,
    executor_id TEXT,
    executor_name TEXT,
    status TEXT DEFAULT 'pending',
    local_dir TEXT,
    analysis_summary TEXT,
    comment_posted INTEGER DEFAULT 0,
    error_message TEXT,
    detected_at TEXT DEFAULT (datetime('now', 'localtime')),
    analyzed_at TEXT,
    created_at TEXT DEFAULT (datetime('now', 'localtime'))
  );
`);

export function upsertTbTaskRecord(record) {
  return db.prepare(`
    INSERT OR REPLACE INTO tb_task_records (id, carb_id, title, project_name, group_name, priority, creator_id, creator_name, executor_id, executor_name, status, local_dir, analysis_summary, comment_posted, error_message, detected_at, analyzed_at)
    VALUES (@id, @carbId, @title, @projectName, @groupName, @priority, @creatorId, @creatorName, @executorId, @executorName, @status, @localDir, @analysisSummary, @commentPosted, @errorMessage, @detectedAt, @analyzedAt)
  `).run({
    id: record.id, carbId: record.carbId || null, title: record.title || "",
    projectName: record.projectName || "", groupName: record.groupName || "",
    priority: record.priority || "", creatorId: record.creatorId || "",
    creatorName: record.creatorName || "", executorId: record.executorId || "",
    executorName: record.executorName || "", status: record.status || "pending",
    localDir: record.localDir || "", analysisSummary: record.analysisSummary || "",
    commentPosted: record.commentPosted || 0, errorMessage: record.errorMessage || "",
    detectedAt: record.detectedAt || new Date().toISOString(),
    analyzedAt: record.analyzedAt || null,
  });
}

export function listTbTaskRecords({ status, limit = 50 } = {}) {
  let sql = "SELECT * FROM tb_task_records";
  const params = {};
  if (status) { sql += " WHERE status = @status"; params.status = status; }
  sql += " ORDER BY detected_at DESC LIMIT @limit";
  params.limit = limit;
  return db.prepare(sql).all(params);
}

export function getTbTaskRecord(id) {
  return db.prepare("SELECT * FROM tb_task_records WHERE id = ? OR carb_id = ?").get(id, id);
}

export function deleteTbTaskRecord(id) {
  return db.prepare("DELETE FROM tb_task_records WHERE id = ? OR carb_id = ?").run(id, id);
}

export function updateTbTaskRecord(id, updates) {
  const fields = [];
  const params = { id };
  for (const [key, value] of Object.entries(updates)) {
    const col = key.replace(/[A-Z]/g, c => "_" + c.toLowerCase());
    fields.push(`${col} = @${key}`);
    params[key] = value;
  }
  if (fields.length === 0) return;
  return db.prepare(`UPDATE tb_task_records SET ${fields.join(", ")} WHERE id = @id`).run(params);
}

// ---------- Feishu Project -> Teambition sync ----------

db.exec(`
  CREATE TABLE IF NOT EXISTS feishu_project_sync_state (
    source_system TEXT NOT NULL DEFAULT 'feishu_project',
    source_project_key TEXT NOT NULL,
    source_work_item_type_key TEXT NOT NULL,
    source_work_item_id TEXT NOT NULL,
    source_work_item_url TEXT,
    source_problem_no TEXT,
    source_work_item_no TEXT,
    target_system TEXT NOT NULL DEFAULT 'teambition',
    target_task_id TEXT,
    target_unique_id TEXT,
    source_updated_at TEXT,
    source_in_scope INTEGER NOT NULL DEFAULT 1,
    target_updated_at TEXT,
    last_synced_at TEXT,
    source_payload_hash TEXT,
    comments_hash TEXT,
    attachments_hash TEXT,
    sync_status TEXT DEFAULT 'pending',
    last_error TEXT,
    created_at TEXT DEFAULT (datetime('now', 'localtime')),
    updated_at TEXT DEFAULT (datetime('now', 'localtime')),
    replicated_at INTEGER,
    origin_node TEXT,
    PRIMARY KEY (source_system, source_project_key, source_work_item_type_key, source_work_item_id, target_system)
  );

  CREATE TABLE IF NOT EXISTS feishu_project_sync_tombstones (
    source_system TEXT NOT NULL DEFAULT 'feishu_project',
    source_project_key TEXT NOT NULL,
    source_work_item_type_key TEXT NOT NULL,
    source_work_item_id TEXT NOT NULL,
    target_system TEXT NOT NULL DEFAULT 'teambition',
    deleted_at TEXT NOT NULL,
    replicated_at INTEGER NOT NULL,
    origin_node TEXT,
    PRIMARY KEY (source_system, source_project_key, source_work_item_type_key, source_work_item_id, target_system)
  );

  CREATE TABLE IF NOT EXISTS feishu_project_raw_payloads (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source_system TEXT NOT NULL DEFAULT 'feishu_project',
    source_project_key TEXT NOT NULL,
    source_work_item_type_key TEXT NOT NULL,
    source_work_item_id TEXT NOT NULL,
    payload_hash TEXT,
    payload_json TEXT,
    captured_at TEXT DEFAULT (datetime('now', 'localtime'))
  );

  CREATE TABLE IF NOT EXISTS feishu_project_sync_errors (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source_system TEXT NOT NULL DEFAULT 'feishu_project',
    source_project_key TEXT NOT NULL,
    source_work_item_type_key TEXT NOT NULL,
    source_work_item_id TEXT NOT NULL,
    target_system TEXT NOT NULL DEFAULT 'teambition',
    target_task_id TEXT,
    target_object_type TEXT,
    target_object_id TEXT,
    source_child_id TEXT,
    source_payload_hash TEXT,
    error_key TEXT,
    stage TEXT,
    error_message TEXT,
    error_detail TEXT,
    error_status TEXT DEFAULT 'open',
    retryable INTEGER DEFAULT 1,
    retry_count INTEGER DEFAULT 1,
    next_retry_at TEXT,
    last_attempt_at TEXT,
    resolved_at TEXT,
    updated_at TEXT DEFAULT (datetime('now', 'localtime')),
    created_at TEXT DEFAULT (datetime('now', 'localtime'))
  );

  CREATE TABLE IF NOT EXISTS feishu_project_comment_sync (
    source_system TEXT NOT NULL DEFAULT 'feishu_project',
    source_project_key TEXT NOT NULL,
    source_work_item_type_key TEXT NOT NULL,
    source_work_item_id TEXT NOT NULL,
    source_comment_id TEXT NOT NULL,
    target_system TEXT NOT NULL DEFAULT 'teambition',
    target_task_id TEXT,
    target_comment_id TEXT,
    source_payload_hash TEXT,
    sync_status TEXT DEFAULT 'pending',
    last_error TEXT,
    synced_at TEXT,
    retry_count INTEGER DEFAULT 0,
    last_attempt_at TEXT,
    created_at TEXT DEFAULT (datetime('now', 'localtime')),
    updated_at TEXT DEFAULT (datetime('now', 'localtime')),
    PRIMARY KEY (source_system, source_project_key, source_work_item_type_key, source_work_item_id, source_comment_id, target_system)
  );

  CREATE TABLE IF NOT EXISTS feishu_project_attachment_sync (
    source_system TEXT NOT NULL DEFAULT 'feishu_project',
    source_project_key TEXT NOT NULL,
    source_work_item_type_key TEXT NOT NULL,
    source_work_item_id TEXT NOT NULL,
    source_attachment_id TEXT NOT NULL,
    target_system TEXT NOT NULL DEFAULT 'teambition',
    target_task_id TEXT,
    target_file_id TEXT,
    source_payload_hash TEXT,
    sync_status TEXT DEFAULT 'pending',
    last_error TEXT,
    synced_at TEXT,
    retry_count INTEGER DEFAULT 0,
    last_attempt_at TEXT,
    created_at TEXT DEFAULT (datetime('now', 'localtime')),
    updated_at TEXT DEFAULT (datetime('now', 'localtime')),
    PRIMARY KEY (source_system, source_project_key, source_work_item_type_key, source_work_item_id, source_attachment_id, target_system)
  );

  CREATE INDEX IF NOT EXISTS idx_feishu_project_sync_status ON feishu_project_sync_state(sync_status, updated_at);
  CREATE INDEX IF NOT EXISTS idx_feishu_project_raw_source ON feishu_project_raw_payloads(source_project_key, source_work_item_type_key, source_work_item_id);
  CREATE INDEX IF NOT EXISTS idx_feishu_project_error_source ON feishu_project_sync_errors(source_project_key, source_work_item_type_key, source_work_item_id, created_at);
`);

for (const sql of [
  "ALTER TABLE feishu_project_sync_state ADD COLUMN target_updated_at TEXT",
  "ALTER TABLE feishu_project_sync_state ADD COLUMN source_problem_no TEXT",
  "ALTER TABLE feishu_project_sync_state ADD COLUMN source_work_item_no TEXT",
  "ALTER TABLE feishu_project_sync_state ADD COLUMN source_in_scope INTEGER NOT NULL DEFAULT 1",
  "ALTER TABLE feishu_project_sync_state ADD COLUMN replicated_at INTEGER",
  "ALTER TABLE feishu_project_sync_state ADD COLUMN origin_node TEXT",
  "ALTER TABLE feishu_project_sync_errors ADD COLUMN target_system TEXT NOT NULL DEFAULT 'teambition'",
  "ALTER TABLE feishu_project_sync_errors ADD COLUMN target_task_id TEXT",
  "ALTER TABLE feishu_project_sync_errors ADD COLUMN target_object_type TEXT",
  "ALTER TABLE feishu_project_sync_errors ADD COLUMN target_object_id TEXT",
  "ALTER TABLE feishu_project_sync_errors ADD COLUMN source_child_id TEXT",
  "ALTER TABLE feishu_project_sync_errors ADD COLUMN source_payload_hash TEXT",
  "ALTER TABLE feishu_project_sync_errors ADD COLUMN error_key TEXT",
  "ALTER TABLE feishu_project_sync_errors ADD COLUMN error_status TEXT DEFAULT 'open'",
  "ALTER TABLE feishu_project_sync_errors ADD COLUMN retryable INTEGER DEFAULT 1",
  "ALTER TABLE feishu_project_sync_errors ADD COLUMN retry_count INTEGER DEFAULT 1",
  "ALTER TABLE feishu_project_sync_errors ADD COLUMN next_retry_at TEXT",
  "ALTER TABLE feishu_project_sync_errors ADD COLUMN last_attempt_at TEXT",
  "ALTER TABLE feishu_project_sync_errors ADD COLUMN resolved_at TEXT",
  "ALTER TABLE feishu_project_sync_errors ADD COLUMN updated_at TEXT DEFAULT (datetime('now', 'localtime'))",
  "ALTER TABLE feishu_project_comment_sync ADD COLUMN retry_count INTEGER DEFAULT 0",
  "ALTER TABLE feishu_project_comment_sync ADD COLUMN last_attempt_at TEXT",
  "ALTER TABLE feishu_project_comment_sync ADD COLUMN created_at TEXT DEFAULT (datetime('now', 'localtime'))",
  "ALTER TABLE feishu_project_comment_sync ADD COLUMN updated_at TEXT DEFAULT (datetime('now', 'localtime'))",
  "ALTER TABLE feishu_project_attachment_sync ADD COLUMN retry_count INTEGER DEFAULT 0",
  "ALTER TABLE feishu_project_attachment_sync ADD COLUMN last_attempt_at TEXT",
  "ALTER TABLE feishu_project_attachment_sync ADD COLUMN created_at TEXT DEFAULT (datetime('now', 'localtime'))",
  "ALTER TABLE feishu_project_attachment_sync ADD COLUMN updated_at TEXT DEFAULT (datetime('now', 'localtime'))",
]) {
  try { db.exec(sql); } catch {}
}
for (const sql of [
  "ALTER TABLE feishu_project_sync_errors ADD COLUMN updated_at TEXT",
  "ALTER TABLE feishu_project_comment_sync ADD COLUMN created_at TEXT",
  "ALTER TABLE feishu_project_comment_sync ADD COLUMN updated_at TEXT",
  "ALTER TABLE feishu_project_attachment_sync ADD COLUMN created_at TEXT",
  "ALTER TABLE feishu_project_attachment_sync ADD COLUMN updated_at TEXT",
]) {
  try { db.exec(sql); } catch {}
}
for (const sql of [
  "CREATE UNIQUE INDEX IF NOT EXISTS ux_feishu_project_error_key ON feishu_project_sync_errors(error_key)",
  "CREATE INDEX IF NOT EXISTS idx_feishu_project_sync_replicated ON feishu_project_sync_state(replicated_at)",
  "CREATE INDEX IF NOT EXISTS idx_feishu_project_sync_tombstone_replicated ON feishu_project_sync_tombstones(replicated_at)",
  "CREATE INDEX IF NOT EXISTS idx_feishu_project_error_retry ON feishu_project_sync_errors(error_status, retryable, next_retry_at)",
  "CREATE INDEX IF NOT EXISTS idx_feishu_project_comment_status ON feishu_project_comment_sync(sync_status, synced_at)",
  "CREATE INDEX IF NOT EXISTS idx_feishu_project_attachment_status ON feishu_project_attachment_sync(sync_status, synced_at)",
]) {
  try { db.exec(sql); } catch {}
}
try {
  db.prepare("UPDATE feishu_project_sync_state SET replicated_at = ? WHERE replicated_at IS NULL OR replicated_at <= 0").run(Date.now());
} catch {}

function fpsKey(row = {}) {
  return {
    sourceSystem: row.sourceSystem || row.source_system || "feishu_project",
    sourceProjectKey: row.sourceProjectKey || row.source_project_key || "",
    sourceWorkItemTypeKey: row.sourceWorkItemTypeKey || row.source_work_item_type_key || "",
    sourceWorkItemId: row.sourceWorkItemId || row.source_work_item_id || "",
    targetSystem: row.targetSystem || row.target_system || "teambition",
  };
}

function fpsSourceInScopeValue(row = {}, fallback = 1) {
  const value = row.sourceInScope ?? row.source_in_scope;
  if (value === undefined || value === null || value === "") return fallback ? 1 : 0;
  if (typeof value === "string") return ["0", "false", "no", "off"].includes(value.trim().toLowerCase()) ? 0 : 1;
  return value === false || Number(value) === 0 ? 0 : 1;
}

function fpsStateRow(r) {
  if (!r) return null;
  return {
    sourceSystem: r.source_system,
    sourceProjectKey: r.source_project_key,
    sourceWorkItemTypeKey: r.source_work_item_type_key,
    sourceWorkItemId: r.source_work_item_id,
    sourceWorkItemUrl: r.source_work_item_url,
    sourceProblemNo: r.source_problem_no || "",
    sourceWorkItemNo: r.source_work_item_no || "",
    targetSystem: r.target_system,
    targetTaskId: r.target_task_id,
    targetUniqueId: r.target_unique_id,
    sourceUpdatedAt: r.source_updated_at,
    sourceInScope: fpsSourceInScopeValue(r) === 1,
    targetUpdatedAt: r.target_updated_at,
    lastSyncedAt: r.last_synced_at,
    sourcePayloadHash: r.source_payload_hash,
    commentsHash: r.comments_hash,
    attachmentsHash: r.attachments_hash,
    syncStatus: r.sync_status,
    lastError: r.last_error,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    replicatedAt: Number(r.replicated_at || 0),
    originNode: r.origin_node || "",
    rowVersion: fpsStateVersionMs(r),
    deleted: !!r.deleted_at,
    deletedAt: r.deleted_at || "",
  };
}

function fpsLimit(limit, fallback = 100) {
  return Math.min(Math.max(Number(limit) || fallback, 1), 1000);
}

function fpsTimeMs(value) {
  if (value === undefined || value === null || value === "") return 0;
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  if (typeof value === "string" && /^\d+$/.test(value.trim())) return Number(value);
  const ts = Date.parse(String(value).replace(" ", "T"));
  return Number.isNaN(ts) ? 0 : ts;
}

function fpsStateVersionMs(row = {}) {
  return Math.max(
    fpsStateAuthorityMs(row),
    fpsStateChangeMs(row),
    Number(row.replicatedAt ?? row.replicated_at ?? 0) || 0,
  );
}

function fpsStateAuthorityMs(row = {}) {
  return Math.max(
    fpsTimeMs(row.sourceUpdatedAt || row.source_updated_at),
    fpsTimeMs(row.targetUpdatedAt || row.target_updated_at),
  );
}

function fpsStateChangeMs(row = {}) {
  return Math.max(
    fpsTimeMs(row.lastSyncedAt || row.last_synced_at),
    fpsTimeMs(row.updatedAt || row.updated_at),
  );
}

function fpsCompareState(left = {}, right = {}) {
  const leftAuthority = fpsStateAuthorityMs(left);
  const rightAuthority = fpsStateAuthorityMs(right);
  if (leftAuthority !== rightAuthority) return leftAuthority - rightAuthority;
  const leftChange = fpsStateChangeMs(left);
  const rightChange = fpsStateChangeMs(right);
  if (leftChange !== rightChange) return leftChange - rightChange;
  const leftReplicated = Number(left.replicatedAt ?? left.replicated_at ?? 0) || 0;
  const rightReplicated = Number(right.replicatedAt ?? right.replicated_at ?? 0) || 0;
  return leftReplicated - rightReplicated;
}

function fpsStateReplicatedAt(k, row = {}) {
  const explicit = Number(row.replicatedAt ?? row.replicated_at ?? 0) || 0;
  if (explicit > 0) return explicit;
  const cur = db.prepare(`
    SELECT replicated_at FROM feishu_project_sync_state
    WHERE source_system = @sourceSystem
      AND source_project_key = @sourceProjectKey
      AND source_work_item_type_key = @sourceWorkItemTypeKey
      AND source_work_item_id = @sourceWorkItemId
      AND target_system = @targetSystem
  `).get(k);
  const tombstone = db.prepare(`
    SELECT replicated_at FROM feishu_project_sync_tombstones
    WHERE source_system = @sourceSystem
      AND source_project_key = @sourceProjectKey
      AND source_work_item_type_key = @sourceWorkItemTypeKey
      AND source_work_item_id = @sourceWorkItemId
      AND target_system = @targetSystem
  `).get(k);
  return Math.max(Date.now(), Number(cur?.replicated_at || 0) + 1, Number(tombstone?.replicated_at || 0) + 1);
}

function fpsBoolNumber(value, fallback = 1) {
  if (value === undefined || value === null || value === "") return fallback;
  return value === false || value === 0 || value === "0" ? 0 : 1;
}

function fpsJson(value) {
  return typeof value === "string" ? value : JSON.stringify(value ?? null);
}

function fpsKeyPart(value) {
  return encodeURIComponent(String(value ?? ""));
}

function fpsGetTombstone(key = {}) {
  const k = fpsKey(key);
  return db.prepare(`
    SELECT * FROM feishu_project_sync_tombstones
    WHERE source_system = @sourceSystem
      AND source_project_key = @sourceProjectKey
      AND source_work_item_type_key = @sourceWorkItemTypeKey
      AND source_work_item_id = @sourceWorkItemId
      AND target_system = @targetSystem
  `).get(k) || null;
}

function fpsDeleteTombstone(key = {}) {
  const k = fpsKey(key);
  return db.prepare(`
    DELETE FROM feishu_project_sync_tombstones
    WHERE source_system = @sourceSystem
      AND source_project_key = @sourceProjectKey
      AND source_work_item_type_key = @sourceWorkItemTypeKey
      AND source_work_item_id = @sourceWorkItemId
      AND target_system = @targetSystem
  `).run(k);
}

function fpsTombstoneRow(r) {
  if (!r) return null;
  return {
    sourceSystem: r.source_system,
    sourceProjectKey: r.source_project_key,
    sourceWorkItemTypeKey: r.source_work_item_type_key,
    sourceWorkItemId: r.source_work_item_id,
    targetSystem: r.target_system,
    syncStatus: "deleted",
    deleted: true,
    deletedAt: r.deleted_at,
    updatedAt: r.deleted_at,
    replicatedAt: Number(r.replicated_at || 0),
    originNode: r.origin_node || "",
    rowVersion: Math.max(fpsTimeMs(r.deleted_at), Number(r.replicated_at || 0)),
  };
}

function fpsUpsertTombstone(key = {}, { deletedAt = new Date().toISOString(), replicatedAt = 0, originNode = "" } = {}) {
  const k = fpsKey(key);
  const nextReplicatedAt = Number(replicatedAt) || fpsStateReplicatedAt(k);
  db.prepare(`
    INSERT INTO feishu_project_sync_tombstones (
      source_system, source_project_key, source_work_item_type_key, source_work_item_id,
      target_system, deleted_at, replicated_at, origin_node
    ) VALUES (
      @sourceSystem, @sourceProjectKey, @sourceWorkItemTypeKey, @sourceWorkItemId,
      @targetSystem, @deletedAt, @replicatedAt, @originNode
    )
    ON CONFLICT(source_system, source_project_key, source_work_item_type_key, source_work_item_id, target_system)
    DO UPDATE SET
      deleted_at = excluded.deleted_at,
      replicated_at = excluded.replicated_at,
      origin_node = excluded.origin_node
    WHERE excluded.replicated_at > feishu_project_sync_tombstones.replicated_at
  `).run({ ...k, deletedAt, replicatedAt: nextReplicatedAt, originNode });
  return fpsGetTombstone(k);
}

function fpsErrorKey(row = {}) {
  const k = fpsKey(row);
  const stage = row.stage || "";
  const targetObjectType = row.targetObjectType || row.target_object_type || "task";
  const sourceChildId = row.sourceChildId || row.source_child_id || row.sourceCommentId || row.source_comment_id || row.sourceAttachmentId || row.source_attachment_id || "";
  return [
    k.sourceSystem,
    k.sourceProjectKey,
    k.sourceWorkItemTypeKey,
    k.sourceWorkItemId,
    k.targetSystem,
    targetObjectType,
    stage,
    sourceChildId || "work-item",
  ].map(fpsKeyPart).join("|");
}

function fpsErrorParams(row = {}, { event = false } = {}) {
  const k = fpsKey(row);
  const now = row.lastAttemptAt || row.last_attempt_at || new Date().toISOString();
  const retryable = fpsBoolNumber(row.retryable, 1);
  const stage = row.stage || "";
  const targetObjectType = row.targetObjectType || row.target_object_type
    || (stage === "comment" || stage === "attachment" ? stage : "task");
  const sourceChildId = row.sourceChildId || row.source_child_id
    || row.sourceCommentId || row.source_comment_id
    || row.sourceAttachmentId || row.source_attachment_id || "";
  const base = {
    ...k,
    targetTaskId: row.targetTaskId || row.target_task_id || "",
    targetObjectType,
    targetObjectId: row.targetObjectId || row.target_object_id || "",
    sourceChildId,
    sourcePayloadHash: row.sourcePayloadHash || row.source_payload_hash || "",
    stage,
    errorMessage: row.errorMessage || row.error_message || "",
    errorDetail: fpsJson(row.errorDetail ?? row.error_detail ?? null),
    errorStatus: row.errorStatus || row.error_status || "open",
    retryable,
    retryCount: Math.max(1, Number(row.retryCount ?? row.retry_count ?? 1) || 1),
    nextRetryAt: row.nextRetryAt || row.next_retry_at || (retryable ? now : ""),
    lastAttemptAt: now,
    resolvedAt: row.resolvedAt || row.resolved_at || "",
    updatedAt: row.updatedAt || row.updated_at || now,
  };
  const stableKey = row.errorKey || row.error_key || fpsErrorKey(base);
  return {
    ...base,
    errorKey: event ? `${stableKey}|event|${Date.now()}|${Math.random().toString(36).slice(2)}` : stableKey,
  };
}

function fpsRawPayloadRow(r) {
  if (!r) return null;
  return {
    ...r,
    sourceSystem: r.source_system,
    sourceProjectKey: r.source_project_key,
    sourceWorkItemTypeKey: r.source_work_item_type_key,
    sourceWorkItemId: r.source_work_item_id,
    payloadHash: r.payload_hash,
    ...(Object.prototype.hasOwnProperty.call(r, "payload_json") ? { payloadJson: r.payload_json } : {}),
    capturedAt: r.captured_at,
  };
}

function fpsErrorRow(r) {
  if (!r) return null;
  return {
    ...r,
    sourceSystem: r.source_system,
    sourceProjectKey: r.source_project_key,
    sourceWorkItemTypeKey: r.source_work_item_type_key,
    sourceWorkItemId: r.source_work_item_id,
    targetSystem: r.target_system,
    targetTaskId: r.target_task_id,
    targetObjectType: r.target_object_type,
    targetObjectId: r.target_object_id,
    sourceChildId: r.source_child_id,
    sourcePayloadHash: r.source_payload_hash,
    errorKey: r.error_key,
    errorMessage: r.error_message,
    errorDetail: r.error_detail,
    errorStatus: r.error_status,
    retryable: r.retryable !== 0,
    retryCount: r.retry_count || 0,
    nextRetryAt: r.next_retry_at,
    lastAttemptAt: r.last_attempt_at,
    resolvedAt: r.resolved_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function fpsChildRow(r, childKind) {
  if (!r) return null;
  const isComment = childKind === "comment";
  return {
    ...r,
    sourceSystem: r.source_system,
    sourceProjectKey: r.source_project_key,
    sourceWorkItemTypeKey: r.source_work_item_type_key,
    sourceWorkItemId: r.source_work_item_id,
    sourceCommentId: isComment ? r.source_comment_id : undefined,
    sourceAttachmentId: isComment ? undefined : r.source_attachment_id,
    targetSystem: r.target_system,
    targetTaskId: r.target_task_id,
    targetCommentId: isComment ? r.target_comment_id : undefined,
    targetFileId: isComment ? undefined : r.target_file_id,
    sourcePayloadHash: r.source_payload_hash,
    syncStatus: r.sync_status,
    lastError: r.last_error,
    syncedAt: r.synced_at,
    retryCount: r.retry_count || 0,
    lastAttemptAt: r.last_attempt_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export function getFeishuProjectSyncState(key) {
  const k = fpsKey(key);
  return fpsStateRow(db.prepare(`
    SELECT * FROM feishu_project_sync_state
    WHERE source_system = @sourceSystem
      AND source_project_key = @sourceProjectKey
      AND source_work_item_type_key = @sourceWorkItemTypeKey
      AND source_work_item_id = @sourceWorkItemId
      AND target_system = @targetSystem
  `).get(k));
}

export function upsertFeishuProjectSyncState(row) {
  const k = fpsKey(row);
  const replicatedAt = fpsStateReplicatedAt(k);
  db.prepare(`
    INSERT INTO feishu_project_sync_state (
      source_system, source_project_key, source_work_item_type_key, source_work_item_id,
      source_work_item_url, source_problem_no, source_work_item_no, target_system, target_task_id, target_unique_id,
      source_updated_at, source_in_scope, target_updated_at, last_synced_at, source_payload_hash, comments_hash,
      attachments_hash, sync_status, last_error, updated_at, replicated_at, origin_node
    )
    VALUES (
      @sourceSystem, @sourceProjectKey, @sourceWorkItemTypeKey, @sourceWorkItemId,
      @sourceWorkItemUrl, @sourceProblemNo, @sourceWorkItemNo, @targetSystem, @targetTaskId, @targetUniqueId,
      @sourceUpdatedAt, @sourceInScope, @targetUpdatedAt, @lastSyncedAt, @sourcePayloadHash, @commentsHash,
      @attachmentsHash, @syncStatus, @lastError, datetime('now', 'localtime'), @replicatedAt, @originNode
    )
    ON CONFLICT(source_system, source_project_key, source_work_item_type_key, source_work_item_id, target_system)
    DO UPDATE SET
      source_work_item_url = excluded.source_work_item_url,
      source_problem_no = CASE WHEN excluded.source_problem_no IS NULL OR excluded.source_problem_no = '' THEN feishu_project_sync_state.source_problem_no ELSE excluded.source_problem_no END,
      source_work_item_no = CASE WHEN excluded.source_work_item_no IS NULL OR excluded.source_work_item_no = '' THEN feishu_project_sync_state.source_work_item_no ELSE excluded.source_work_item_no END,
      target_task_id = CASE WHEN excluded.target_task_id IS NULL OR excluded.target_task_id = '' THEN feishu_project_sync_state.target_task_id ELSE excluded.target_task_id END,
      target_unique_id = CASE WHEN excluded.target_unique_id IS NULL OR excluded.target_unique_id = '' THEN feishu_project_sync_state.target_unique_id ELSE excluded.target_unique_id END,
      source_updated_at = excluded.source_updated_at,
      source_in_scope = excluded.source_in_scope,
      target_updated_at = CASE WHEN excluded.target_updated_at IS NULL OR excluded.target_updated_at = '' THEN feishu_project_sync_state.target_updated_at ELSE excluded.target_updated_at END,
      last_synced_at = excluded.last_synced_at,
      source_payload_hash = excluded.source_payload_hash,
      comments_hash = excluded.comments_hash,
      attachments_hash = excluded.attachments_hash,
      sync_status = excluded.sync_status,
      last_error = excluded.last_error,
      updated_at = datetime('now', 'localtime'),
      replicated_at = excluded.replicated_at,
      origin_node = excluded.origin_node
  `).run({
    ...k,
    sourceWorkItemUrl: row.sourceWorkItemUrl || row.source_work_item_url || "",
    sourceProblemNo: row.sourceProblemNo || row.source_problem_no || row.problemNo || row.problem_no || "",
    sourceWorkItemNo: row.sourceWorkItemNo || row.source_work_item_no || "",
    targetTaskId: row.targetTaskId || row.target_task_id || "",
    targetUniqueId: row.targetUniqueId || row.target_unique_id || "",
    sourceUpdatedAt: row.sourceUpdatedAt || row.source_updated_at || "",
    sourceInScope: fpsSourceInScopeValue(row),
    targetUpdatedAt: row.targetUpdatedAt || row.target_updated_at || "",
    lastSyncedAt: row.lastSyncedAt || row.last_synced_at || "",
    sourcePayloadHash: row.sourcePayloadHash || row.source_payload_hash || "",
    commentsHash: row.commentsHash || row.comments_hash || "",
    attachmentsHash: row.attachmentsHash || row.attachments_hash || "",
    syncStatus: row.syncStatus || row.sync_status || "pending",
    lastError: row.lastError || row.last_error || "",
    replicatedAt,
    originNode: row.originNode || row.origin_node || row.node || "",
  });
  fpsDeleteTombstone(k);
  return getFeishuProjectSyncState(k);
}

export function mergeFeishuProjectSyncState(row) {
  const k = fpsKey(row);
  if (!k.sourceProjectKey || !k.sourceWorkItemTypeKey || !k.sourceWorkItemId) return null;
  const incomingReplicatedAt = Number(row.replicatedAt ?? row.replicated_at ?? 0) || fpsStateVersionMs(row) || Date.now();
  if (row.deleted === true || row.deletedAt || row.deleted_at) {
    return mergeFeishuProjectSyncTombstone(k, row, incomingReplicatedAt);
  }
  const tombstone = fpsGetTombstone(k);
  if (tombstone && Number(tombstone.replicated_at || 0) >= incomingReplicatedAt) {
    return fpsTombstoneRow(tombstone);
  }
  const cur = db.prepare(`
    SELECT * FROM feishu_project_sync_state
    WHERE source_system = @sourceSystem
      AND source_project_key = @sourceProjectKey
      AND source_work_item_type_key = @sourceWorkItemTypeKey
      AND source_work_item_id = @sourceWorkItemId
      AND target_system = @targetSystem
  `).get(k);
  if (cur) {
    const compare = fpsCompareState(cur, { ...row, replicated_at: incomingReplicatedAt });
    if (compare >= 0) return fpsStateRow(cur);
  }
  const params = {
    ...k,
    sourceWorkItemUrl: row.sourceWorkItemUrl || row.source_work_item_url || "",
    sourceProblemNo: row.sourceProblemNo || row.source_problem_no || row.problemNo || row.problem_no || "",
    sourceWorkItemNo: row.sourceWorkItemNo || row.source_work_item_no || "",
    targetTaskId: row.targetTaskId || row.target_task_id || "",
    targetUniqueId: row.targetUniqueId || row.target_unique_id || "",
    sourceUpdatedAt: row.sourceUpdatedAt || row.source_updated_at || "",
    sourceInScope: fpsSourceInScopeValue(row, cur ? fpsSourceInScopeValue(cur) : 1),
    targetUpdatedAt: row.targetUpdatedAt || row.target_updated_at || "",
    lastSyncedAt: row.lastSyncedAt || row.last_synced_at || "",
    sourcePayloadHash: row.sourcePayloadHash || row.source_payload_hash || "",
    commentsHash: row.commentsHash || row.comments_hash || "",
    attachmentsHash: row.attachmentsHash || row.attachments_hash || "",
    syncStatus: row.syncStatus || row.sync_status || "pending",
    lastError: row.lastError || row.last_error || "",
    createdAt: row.createdAt || row.created_at || new Date(incomingReplicatedAt).toISOString(),
    updatedAt: row.updatedAt || row.updated_at || new Date(incomingReplicatedAt).toISOString(),
    replicatedAt: incomingReplicatedAt,
    originNode: row.originNode || row.origin_node || row.node || "",
  };
  db.prepare(`
    INSERT INTO feishu_project_sync_state (
      source_system, source_project_key, source_work_item_type_key, source_work_item_id,
      source_work_item_url, source_problem_no, source_work_item_no, target_system, target_task_id, target_unique_id,
      source_updated_at, source_in_scope, target_updated_at, last_synced_at, source_payload_hash, comments_hash,
      attachments_hash, sync_status, last_error, created_at, updated_at, replicated_at, origin_node
    )
    VALUES (
      @sourceSystem, @sourceProjectKey, @sourceWorkItemTypeKey, @sourceWorkItemId,
      @sourceWorkItemUrl, @sourceProblemNo, @sourceWorkItemNo, @targetSystem, @targetTaskId, @targetUniqueId,
      @sourceUpdatedAt, @sourceInScope, @targetUpdatedAt, @lastSyncedAt, @sourcePayloadHash, @commentsHash,
      @attachmentsHash, @syncStatus, @lastError, @createdAt, @updatedAt, @replicatedAt, @originNode
    )
    ON CONFLICT(source_system, source_project_key, source_work_item_type_key, source_work_item_id, target_system)
    DO UPDATE SET
      source_work_item_url = excluded.source_work_item_url,
      source_problem_no = CASE WHEN excluded.source_problem_no IS NULL OR excluded.source_problem_no = '' THEN feishu_project_sync_state.source_problem_no ELSE excluded.source_problem_no END,
      source_work_item_no = CASE WHEN excluded.source_work_item_no IS NULL OR excluded.source_work_item_no = '' THEN feishu_project_sync_state.source_work_item_no ELSE excluded.source_work_item_no END,
      target_task_id = CASE WHEN excluded.target_task_id IS NULL OR excluded.target_task_id = '' THEN feishu_project_sync_state.target_task_id ELSE excluded.target_task_id END,
      target_unique_id = CASE WHEN excluded.target_unique_id IS NULL OR excluded.target_unique_id = '' THEN feishu_project_sync_state.target_unique_id ELSE excluded.target_unique_id END,
      source_updated_at = excluded.source_updated_at,
      source_in_scope = excluded.source_in_scope,
      target_updated_at = CASE WHEN excluded.target_updated_at IS NULL OR excluded.target_updated_at = '' THEN feishu_project_sync_state.target_updated_at ELSE excluded.target_updated_at END,
      last_synced_at = excluded.last_synced_at,
      source_payload_hash = excluded.source_payload_hash,
      comments_hash = excluded.comments_hash,
      attachments_hash = excluded.attachments_hash,
      sync_status = excluded.sync_status,
      last_error = excluded.last_error,
      updated_at = excluded.updated_at,
      replicated_at = excluded.replicated_at,
      origin_node = excluded.origin_node
  `).run(params);
  fpsDeleteTombstone(k);
  return getFeishuProjectSyncState(k);
}

function mergeFeishuProjectSyncTombstone(k, row, incomingReplicatedAt) {
  const currentTombstone = fpsGetTombstone(k);
  if (currentTombstone && Number(currentTombstone.replicated_at || 0) >= incomingReplicatedAt) {
    return fpsTombstoneRow(currentTombstone);
  }
  const currentState = db.prepare(`
    SELECT * FROM feishu_project_sync_state
    WHERE source_system = @sourceSystem
      AND source_project_key = @sourceProjectKey
      AND source_work_item_type_key = @sourceWorkItemTypeKey
      AND source_work_item_id = @sourceWorkItemId
      AND target_system = @targetSystem
  `).get(k);
  if (currentState && Number(currentState.replicated_at || 0) > incomingReplicatedAt) {
    return fpsStateRow(currentState);
  }
  const deletedAt = row.deletedAt || row.deleted_at || new Date(incomingReplicatedAt).toISOString();
  const originNode = row.originNode || row.origin_node || row.node || "";
  const tx = db.transaction(() => {
    deleteFeishuProjectSyncGraph(k, { requireState: false });
    return fpsUpsertTombstone(k, { deletedAt, replicatedAt: incomingReplicatedAt, originNode });
  });
  return fpsTombstoneRow(tx());
}

export function repointFeishuProjectSyncTarget(key = {}, target = {}) {
  const k = fpsKey(key);
  const targetTaskId = String(target.targetTaskId || target.target_task_id || "").trim();
  if (!targetTaskId) throw new Error("targetTaskId is required");
  const targetUniqueId = String(target.targetUniqueId || target.target_unique_id || "").trim();
  const targetUpdatedAt = String(target.targetUpdatedAt || target.target_updated_at || target.updatedAt || target.updated_at || new Date().toISOString()).trim();
  const syncStatus = target.syncStatus || target.sync_status || "success";
  const lastError = target.lastError || target.last_error || "";
  const replicatedAt = fpsStateReplicatedAt(k);
  const params = {
    ...k,
    sourceWorkItemUrl: key.sourceWorkItemUrl || key.source_work_item_url || "",
    sourceProblemNo: key.sourceProblemNo || key.source_problem_no || key.problemNo || key.problem_no || "",
    sourceWorkItemNo: key.sourceWorkItemNo || key.source_work_item_no || "",
    targetTaskId,
    targetUniqueId,
    targetUpdatedAt,
    syncStatus,
    lastError,
    replicatedAt,
    originNode: target.originNode || target.origin_node || target.node || "",
  };
  db.prepare(`
    INSERT INTO feishu_project_sync_state (
      source_system, source_project_key, source_work_item_type_key, source_work_item_id,
      source_work_item_url, source_problem_no, source_work_item_no, target_system, target_task_id, target_unique_id,
      target_updated_at, sync_status, last_error, updated_at, replicated_at, origin_node
    )
    VALUES (
      @sourceSystem, @sourceProjectKey, @sourceWorkItemTypeKey, @sourceWorkItemId,
      @sourceWorkItemUrl, @sourceProblemNo, @sourceWorkItemNo, @targetSystem, @targetTaskId, @targetUniqueId,
      @targetUpdatedAt, @syncStatus, @lastError, datetime('now', 'localtime'), @replicatedAt, @originNode
    )
    ON CONFLICT(source_system, source_project_key, source_work_item_type_key, source_work_item_id, target_system)
    DO UPDATE SET
      source_work_item_url = CASE WHEN excluded.source_work_item_url IS NULL OR excluded.source_work_item_url = '' THEN feishu_project_sync_state.source_work_item_url ELSE excluded.source_work_item_url END,
      source_problem_no = CASE WHEN excluded.source_problem_no IS NULL OR excluded.source_problem_no = '' THEN feishu_project_sync_state.source_problem_no ELSE excluded.source_problem_no END,
      source_work_item_no = CASE WHEN excluded.source_work_item_no IS NULL OR excluded.source_work_item_no = '' THEN feishu_project_sync_state.source_work_item_no ELSE excluded.source_work_item_no END,
      target_task_id = excluded.target_task_id,
      target_unique_id = CASE WHEN excluded.target_unique_id IS NULL OR excluded.target_unique_id = '' THEN feishu_project_sync_state.target_unique_id ELSE excluded.target_unique_id END,
      target_updated_at = excluded.target_updated_at,
      sync_status = excluded.sync_status,
      last_error = excluded.last_error,
      updated_at = datetime('now', 'localtime'),
      replicated_at = excluded.replicated_at,
      origin_node = excluded.origin_node
  `).run(params);
  fpsDeleteTombstone(k);
  const commentResult = db.prepare(`
    UPDATE feishu_project_comment_sync
    SET sync_status = CASE WHEN target_task_id IS NULL OR target_task_id = '' OR target_task_id = @targetTaskId THEN sync_status ELSE 'pending' END,
      target_comment_id = CASE WHEN target_task_id IS NULL OR target_task_id = '' OR target_task_id = @targetTaskId THEN target_comment_id ELSE '' END,
      last_error = CASE WHEN target_task_id IS NULL OR target_task_id = '' OR target_task_id = @targetTaskId THEN last_error ELSE '' END,
      target_task_id = @targetTaskId,
      updated_at = datetime('now', 'localtime')
    WHERE source_system = @sourceSystem
      AND source_project_key = @sourceProjectKey
      AND source_work_item_type_key = @sourceWorkItemTypeKey
      AND source_work_item_id = @sourceWorkItemId
      AND target_system = @targetSystem
  `).run(params);
  const attachmentResult = db.prepare(`
    UPDATE feishu_project_attachment_sync
    SET sync_status = CASE WHEN target_task_id IS NULL OR target_task_id = '' OR target_task_id = @targetTaskId THEN sync_status ELSE 'pending' END,
      target_file_id = CASE WHEN target_task_id IS NULL OR target_task_id = '' OR target_task_id = @targetTaskId THEN target_file_id ELSE '' END,
      last_error = CASE WHEN target_task_id IS NULL OR target_task_id = '' OR target_task_id = @targetTaskId THEN last_error ELSE '' END,
      target_task_id = @targetTaskId,
      updated_at = datetime('now', 'localtime')
    WHERE source_system = @sourceSystem
      AND source_project_key = @sourceProjectKey
      AND source_work_item_type_key = @sourceWorkItemTypeKey
      AND source_work_item_id = @sourceWorkItemId
      AND target_system = @targetSystem
  `).run(params);
  const errorResult = db.prepare(`
    UPDATE feishu_project_sync_errors
    SET target_task_id = @targetTaskId,
      updated_at = datetime('now', 'localtime')
    WHERE source_system = @sourceSystem
      AND source_project_key = @sourceProjectKey
      AND source_work_item_type_key = @sourceWorkItemTypeKey
      AND source_work_item_id = @sourceWorkItemId
      AND target_system = @targetSystem
      AND COALESCE(error_status, 'open') != 'resolved'
  `).run(params);
  return {
    state: getFeishuProjectSyncState(k),
    changes: {
      comments: commentResult.changes || 0,
      attachments: attachmentResult.changes || 0,
      errors: errorResult.changes || 0,
    },
  };
}

export function resetFeishuProjectSyncTarget(key = {}, target = {}) {
  const k = fpsKey(key);
  const targetTaskId = String(target.targetTaskId || target.target_task_id || "").trim();
  const replicatedAt = fpsStateReplicatedAt(k);
  const params = {
    ...k,
    targetTaskId,
    syncStatus: target.syncStatus || target.sync_status || "pending",
    lastError: target.lastError || target.last_error || "",
    replicatedAt,
  };
  const targetClause = targetTaskId ? "AND target_task_id = @targetTaskId" : "";
  const stateResult = db.prepare(`
    UPDATE feishu_project_sync_state
    SET target_task_id = '',
      target_unique_id = '',
      target_updated_at = '',
      last_synced_at = '',
      source_payload_hash = '',
      comments_hash = '',
      attachments_hash = '',
      sync_status = @syncStatus,
      last_error = @lastError,
      updated_at = datetime('now', 'localtime'),
      replicated_at = @replicatedAt
    WHERE source_system = @sourceSystem
      AND source_project_key = @sourceProjectKey
      AND source_work_item_type_key = @sourceWorkItemTypeKey
      AND source_work_item_id = @sourceWorkItemId
      AND target_system = @targetSystem
      ${targetClause}
  `).run(params);
  const commentResult = db.prepare(`
    UPDATE feishu_project_comment_sync
    SET target_task_id = '',
      target_comment_id = '',
      sync_status = 'pending',
      last_error = '',
      synced_at = '',
      updated_at = datetime('now', 'localtime')
    WHERE source_system = @sourceSystem
      AND source_project_key = @sourceProjectKey
      AND source_work_item_type_key = @sourceWorkItemTypeKey
      AND source_work_item_id = @sourceWorkItemId
      AND target_system = @targetSystem
      ${targetClause}
  `).run(params);
  const attachmentResult = db.prepare(`
    UPDATE feishu_project_attachment_sync
    SET target_task_id = '',
      target_file_id = '',
      sync_status = 'pending',
      last_error = '',
      synced_at = '',
      updated_at = datetime('now', 'localtime')
    WHERE source_system = @sourceSystem
      AND source_project_key = @sourceProjectKey
      AND source_work_item_type_key = @sourceWorkItemTypeKey
      AND source_work_item_id = @sourceWorkItemId
      AND target_system = @targetSystem
      ${targetClause}
  `).run(params);
  const errorResult = db.prepare(`
    UPDATE feishu_project_sync_errors
    SET target_task_id = '',
      error_status = 'resolved',
      resolved_at = COALESCE(resolved_at, datetime('now', 'localtime')),
      updated_at = datetime('now', 'localtime')
    WHERE source_system = @sourceSystem
      AND source_project_key = @sourceProjectKey
      AND source_work_item_type_key = @sourceWorkItemTypeKey
      AND source_work_item_id = @sourceWorkItemId
      AND target_system = @targetSystem
      AND COALESCE(error_status, 'open') != 'resolved'
      ${targetClause}
  `).run(params);
  return {
    state: getFeishuProjectSyncState(k),
    changes: {
      state: stateResult.changes || 0,
      comments: commentResult.changes || 0,
      attachments: attachmentResult.changes || 0,
      errors: errorResult.changes || 0,
    },
  };
}

export function upsertFeishuProjectSyncSourceRecord(row = {}) {
  const k = fpsKey(row);
  if (!k.sourceProjectKey || !k.sourceWorkItemTypeKey || !k.sourceWorkItemId) return null;
  const replicatedAt = fpsStateReplicatedAt(k);
  db.prepare(`
    INSERT INTO feishu_project_sync_state (
      source_system, source_project_key, source_work_item_type_key, source_work_item_id,
      source_work_item_url, source_problem_no, source_work_item_no, target_system,
      target_task_id, target_unique_id, source_updated_at, source_in_scope, target_updated_at,
      last_synced_at, source_payload_hash, comments_hash, attachments_hash,
      sync_status, last_error, updated_at, replicated_at, origin_node
    )
    VALUES (
      @sourceSystem, @sourceProjectKey, @sourceWorkItemTypeKey, @sourceWorkItemId,
      @sourceWorkItemUrl, @sourceProblemNo, @sourceWorkItemNo, @targetSystem,
      '', '', @sourceUpdatedAt, @sourceInScope, '', '', '', '', '',
      'pending', '', datetime('now', 'localtime'), @replicatedAt, @originNode
    )
    ON CONFLICT(source_system, source_project_key, source_work_item_type_key, source_work_item_id, target_system)
    DO UPDATE SET
      source_work_item_url = CASE WHEN excluded.source_work_item_url IS NULL OR excluded.source_work_item_url = '' THEN feishu_project_sync_state.source_work_item_url ELSE excluded.source_work_item_url END,
      source_problem_no = CASE WHEN excluded.source_problem_no IS NULL OR excluded.source_problem_no = '' THEN feishu_project_sync_state.source_problem_no ELSE excluded.source_problem_no END,
      source_work_item_no = CASE WHEN excluded.source_work_item_no IS NULL OR excluded.source_work_item_no = '' THEN feishu_project_sync_state.source_work_item_no ELSE excluded.source_work_item_no END,
      source_updated_at = CASE WHEN excluded.source_updated_at IS NULL OR excluded.source_updated_at = '' THEN feishu_project_sync_state.source_updated_at ELSE excluded.source_updated_at END,
      source_in_scope = excluded.source_in_scope,
      updated_at = datetime('now', 'localtime'),
      replicated_at = excluded.replicated_at,
      origin_node = excluded.origin_node
  `).run({
    ...k,
    sourceWorkItemUrl: row.sourceWorkItemUrl || row.source_work_item_url || "",
    sourceProblemNo: row.sourceProblemNo || row.source_problem_no || row.problemNo || row.problem_no || "",
    sourceWorkItemNo: row.sourceWorkItemNo || row.source_work_item_no || "",
    sourceUpdatedAt: row.sourceUpdatedAt || row.source_updated_at || "",
    sourceInScope: fpsSourceInScopeValue(row),
    replicatedAt,
    originNode: row.originNode || row.origin_node || row.node || "",
  });
  fpsDeleteTombstone(k);
  return getFeishuProjectSyncState(k);
}

export function clearFeishuProjectSyncRecords() {
  const resolvedAt = new Date().toISOString();
  const tx = db.transaction(() => {
    const stateResult = db.prepare("DELETE FROM feishu_project_sync_state").run();
    const commentResult = db.prepare("DELETE FROM feishu_project_comment_sync").run();
    const attachmentResult = db.prepare("DELETE FROM feishu_project_attachment_sync").run();
    const errorResult = db.prepare(`
      UPDATE feishu_project_sync_errors
      SET error_status = 'resolved',
        retryable = 0,
        resolved_at = COALESCE(resolved_at, @resolvedAt),
        updated_at = @resolvedAt
      WHERE COALESCE(error_status, 'open') != 'resolved'
    `).run({ resolvedAt });
    return {
      clearedAt: resolvedAt,
      records: stateResult.changes || 0,
      comments: commentResult.changes || 0,
      attachments: attachmentResult.changes || 0,
      errorsResolved: errorResult.changes || 0,
    };
  });
  return tx();
}

function deleteFeishuProjectSyncGraph(key = {}, { requireState = true } = {}) {
  const k = fpsKey(key);
  const state = db.prepare(`
    SELECT * FROM feishu_project_sync_state
    WHERE source_system = @sourceSystem
      AND source_project_key = @sourceProjectKey
      AND source_work_item_type_key = @sourceWorkItemTypeKey
      AND source_work_item_id = @sourceWorkItemId
      AND target_system = @targetSystem
  `).get(k);
  if (requireState && !state) {
    return { state: null, records: 0, comments: 0, attachments: 0, errors: 0, rawPayloads: 0 };
  }
  const records = state ? (db.prepare(`
    DELETE FROM feishu_project_sync_state
    WHERE source_system = @sourceSystem
      AND source_project_key = @sourceProjectKey
      AND source_work_item_type_key = @sourceWorkItemTypeKey
      AND source_work_item_id = @sourceWorkItemId
      AND target_system = @targetSystem
  `).run(k).changes || 0) : 0;
  const comments = db.prepare(`
    DELETE FROM feishu_project_comment_sync
    WHERE source_system = @sourceSystem
      AND source_project_key = @sourceProjectKey
      AND source_work_item_type_key = @sourceWorkItemTypeKey
      AND source_work_item_id = @sourceWorkItemId
      AND target_system = @targetSystem
  `).run(k).changes || 0;
  const attachments = db.prepare(`
    DELETE FROM feishu_project_attachment_sync
    WHERE source_system = @sourceSystem
      AND source_project_key = @sourceProjectKey
      AND source_work_item_type_key = @sourceWorkItemTypeKey
      AND source_work_item_id = @sourceWorkItemId
      AND target_system = @targetSystem
  `).run(k).changes || 0;
  const errors = db.prepare(`
    DELETE FROM feishu_project_sync_errors
    WHERE source_system = @sourceSystem
      AND source_project_key = @sourceProjectKey
      AND source_work_item_type_key = @sourceWorkItemTypeKey
      AND source_work_item_id = @sourceWorkItemId
      AND target_system = @targetSystem
  `).run(k).changes || 0;
  const remainingTargets = db.prepare(`
    SELECT COUNT(*) AS count FROM feishu_project_sync_state
    WHERE source_system = @sourceSystem
      AND source_project_key = @sourceProjectKey
      AND source_work_item_type_key = @sourceWorkItemTypeKey
      AND source_work_item_id = @sourceWorkItemId
  `).get(k)?.count || 0;
  const rawPayloads = remainingTargets ? 0 : (db.prepare(`
    DELETE FROM feishu_project_raw_payloads
    WHERE source_system = @sourceSystem
      AND source_project_key = @sourceProjectKey
      AND source_work_item_type_key = @sourceWorkItemTypeKey
      AND source_work_item_id = @sourceWorkItemId
  `).run(k).changes || 0);
  return { state, records, comments, attachments, errors, rawPayloads };
}

export function deleteFeishuProjectSyncRecords(records = []) {
  const requested = Array.isArray(records) ? records : [];
  const uniqueKeys = new Map();
  for (const record of requested) {
    const key = fpsKey(record || {});
    if (!key.sourceProjectKey || !key.sourceWorkItemTypeKey || !key.sourceWorkItemId) continue;
    const recordKey = [
      key.sourceSystem,
      key.sourceProjectKey,
      key.sourceWorkItemTypeKey,
      key.sourceWorkItemId,
      key.targetSystem,
    ].map(fpsKeyPart).join("/");
    uniqueKeys.set(recordKey, key);
  }

  const tx = db.transaction(() => {
    const result = {
      requested: requested.length,
      selected: uniqueKeys.size,
      records: 0,
      comments: 0,
      attachments: 0,
      errors: 0,
      rawPayloads: 0,
      tombstones: 0,
      deletedKeys: [],
      missingKeys: [],
    };
    for (const [recordKey, key] of uniqueKeys) {
      const deleted = deleteFeishuProjectSyncGraph(key, { requireState: true });
      if (!deleted.records) {
        result.missingKeys.push(recordKey);
        continue;
      }
      result.records += deleted.records;
      result.comments += deleted.comments;
      result.attachments += deleted.attachments;
      result.errors += deleted.errors;
      result.rawPayloads += deleted.rawPayloads;
      const currentTombstone = fpsGetTombstone(key);
      const replicatedAt = Math.max(
        Date.now(),
        Number(deleted.state?.replicated_at || 0) + 1,
        Number(currentTombstone?.replicated_at || 0) + 1,
      );
      fpsUpsertTombstone(key, { deletedAt: new Date().toISOString(), replicatedAt });
      result.tombstones += 1;
      result.deletedKeys.push(recordKey);
    }
    return result;
  });
  return tx();
}

export function listFeishuProjectSyncStates({ status, projectKey, typeKey, limit = 100 } = {}) {
  const where = [];
  const params = { limit: Math.min(Number(limit) || 100, 1000) };
  if (status) { where.push("sync_status = @status"); params.status = status; }
  if (projectKey) { where.push("source_project_key = @projectKey"); params.projectKey = projectKey; }
  if (typeKey) { where.push("source_work_item_type_key = @typeKey"); params.typeKey = typeKey; }
  const sql = `SELECT * FROM feishu_project_sync_state${where.length ? " WHERE " + where.join(" AND ") : ""} ORDER BY COALESCE(replicated_at,0) DESC, updated_at DESC LIMIT @limit`;
  return db.prepare(sql).all(params).map(fpsStateRow);
}

export function listFeishuProjectSyncStatesSince(since = 0, { limit = 1000 } = {}) {
  const params = { since: Number(since) || 0, limit: fpsLimit(limit, 1000) };
  const states = db.prepare(`
    SELECT * FROM feishu_project_sync_state
    WHERE COALESCE(replicated_at,0) >= @since
    ORDER BY COALESCE(replicated_at,0) ASC, updated_at ASC
    LIMIT @limit
  `).all(params).map(fpsStateRow);
  const tombstones = db.prepare(`
    SELECT * FROM feishu_project_sync_tombstones
    WHERE COALESCE(replicated_at,0) >= @since
    ORDER BY COALESCE(replicated_at,0) ASC, deleted_at ASC
    LIMIT @limit
  `).all(params).map(fpsTombstoneRow);
  return [...states, ...tombstones]
    .sort((left, right) => (left.replicatedAt - right.replicatedAt) || String(left.updatedAt || "").localeCompare(String(right.updatedAt || "")))
    .slice(0, params.limit);
}

export function maxFeishuProjectSyncStateReplicatedAt() {
  const stateMax = db.prepare("SELECT MAX(COALESCE(replicated_at,0)) AS m FROM feishu_project_sync_state").get().m || 0;
  const tombstoneMax = db.prepare("SELECT MAX(COALESCE(replicated_at,0)) AS m FROM feishu_project_sync_tombstones").get().m || 0;
  return Math.max(stateMax, tombstoneMax);
}

export function insertFeishuProjectRawPayload(row) {
  const k = fpsKey(row);
  return db.prepare(`
    INSERT INTO feishu_project_raw_payloads (
      source_system, source_project_key, source_work_item_type_key, source_work_item_id,
      payload_hash, payload_json
    )
    VALUES (@sourceSystem, @sourceProjectKey, @sourceWorkItemTypeKey, @sourceWorkItemId, @payloadHash, @payloadJson)
  `).run({
    ...k,
    payloadHash: row.payloadHash || row.payload_hash || "",
    payloadJson: typeof row.payloadJson === "string" ? row.payloadJson : JSON.stringify(row.payloadJson ?? row.payload ?? null),
  });
}

export function listFeishuProjectRawPayloads({ projectKey, typeKey, workItemId, payloadHash, limit = 100, includePayload = true } = {}) {
  const where = [];
  const params = { limit: fpsLimit(limit) };
  if (projectKey) { where.push("source_project_key = @projectKey"); params.projectKey = projectKey; }
  if (typeKey) { where.push("source_work_item_type_key = @typeKey"); params.typeKey = typeKey; }
  if (workItemId) { where.push("source_work_item_id = @workItemId"); params.workItemId = workItemId; }
  if (payloadHash) { where.push("payload_hash = @payloadHash"); params.payloadHash = payloadHash; }
  const columns = includePayload === false
    ? "id, source_system, source_project_key, source_work_item_type_key, source_work_item_id, payload_hash, captured_at"
    : "*";
  const sql = `SELECT ${columns} FROM feishu_project_raw_payloads${where.length ? " WHERE " + where.join(" AND ") : ""} ORDER BY id DESC LIMIT @limit`;
  return db.prepare(sql).all(params).map(fpsRawPayloadRow);
}

export function getLatestFeishuProjectRawPayload(key = {}) {
  const rows = listFeishuProjectRawPayloads({
    projectKey: key.projectKey || key.sourceProjectKey || key.source_project_key,
    typeKey: key.typeKey || key.sourceWorkItemTypeKey || key.source_work_item_type_key,
    workItemId: key.workItemId || key.sourceWorkItemId || key.source_work_item_id,
    limit: 1,
  });
  return rows[0] || null;
}

export function insertFeishuProjectSyncError(row) {
  const p = fpsErrorParams(row, { event: true });
  return db.prepare(`
    INSERT INTO feishu_project_sync_errors (
      source_system, source_project_key, source_work_item_type_key, source_work_item_id,
      target_system, target_task_id, target_object_type, target_object_id, source_child_id,
      source_payload_hash, error_key, stage, error_message, error_detail, error_status,
      retryable, retry_count, next_retry_at, last_attempt_at, resolved_at, updated_at
    )
    VALUES (
      @sourceSystem, @sourceProjectKey, @sourceWorkItemTypeKey, @sourceWorkItemId,
      @targetSystem, @targetTaskId, @targetObjectType, @targetObjectId, @sourceChildId,
      @sourcePayloadHash, @errorKey, @stage, @errorMessage, @errorDetail, @errorStatus,
      @retryable, @retryCount, @nextRetryAt, @lastAttemptAt, @resolvedAt, @updatedAt
    )
  `).run(p);
}

export function upsertFeishuProjectSyncError(row) {
  const p = fpsErrorParams(row);
  db.prepare(`
    INSERT INTO feishu_project_sync_errors (
      source_system, source_project_key, source_work_item_type_key, source_work_item_id,
      target_system, target_task_id, target_object_type, target_object_id, source_child_id,
      source_payload_hash, error_key, stage, error_message, error_detail, error_status,
      retryable, retry_count, next_retry_at, last_attempt_at, resolved_at, updated_at
    )
    VALUES (
      @sourceSystem, @sourceProjectKey, @sourceWorkItemTypeKey, @sourceWorkItemId,
      @targetSystem, @targetTaskId, @targetObjectType, @targetObjectId, @sourceChildId,
      @sourcePayloadHash, @errorKey, @stage, @errorMessage, @errorDetail, @errorStatus,
      @retryable, @retryCount, @nextRetryAt, @lastAttemptAt, @resolvedAt, @updatedAt
    )
    ON CONFLICT(error_key) DO UPDATE SET
      target_task_id = excluded.target_task_id,
      target_object_id = excluded.target_object_id,
      source_payload_hash = excluded.source_payload_hash,
      stage = excluded.stage,
      error_message = excluded.error_message,
      error_detail = excluded.error_detail,
      error_status = excluded.error_status,
      retryable = excluded.retryable,
      retry_count = feishu_project_sync_errors.retry_count + 1,
      next_retry_at = excluded.next_retry_at,
      last_attempt_at = excluded.last_attempt_at,
      resolved_at = CASE WHEN excluded.error_status = 'resolved' THEN excluded.resolved_at ELSE NULL END,
      updated_at = excluded.updated_at
  `).run(p);
  return getFeishuProjectSyncErrorByKey(p.errorKey);
}

export function getFeishuProjectSyncErrorByKey(errorKey) {
  return fpsErrorRow(db.prepare("SELECT * FROM feishu_project_sync_errors WHERE error_key = ?").get(String(errorKey || "")));
}

export function resolveFeishuProjectSyncError(row = {}) {
  const p = fpsErrorParams({ ...row, errorStatus: "resolved", retryable: 0, resolvedAt: row.resolvedAt || row.resolved_at || new Date().toISOString() });
  return db.prepare(`
    UPDATE feishu_project_sync_errors
    SET error_status = 'resolved',
      retryable = 0,
      resolved_at = @resolvedAt,
      updated_at = @updatedAt
    WHERE error_key = @errorKey
  `).run(p);
}

export function resolveFeishuProjectSyncErrors(query = {}) {
  const k = fpsKey(query);
  const where = [
    "source_system = @sourceSystem",
    "source_project_key = @sourceProjectKey",
    "source_work_item_type_key = @sourceWorkItemTypeKey",
    "source_work_item_id = @sourceWorkItemId",
    "target_system = @targetSystem",
    "COALESCE(error_status, 'open') != 'resolved'",
  ];
  const params = { ...k, resolvedAt: query.resolvedAt || query.resolved_at || new Date().toISOString() };
  if (query.stage) { where.push("stage = @stage"); params.stage = query.stage; }
  if (query.targetObjectType || query.target_object_type) {
    where.push("target_object_type = @targetObjectType");
    params.targetObjectType = query.targetObjectType || query.target_object_type;
  }
  if (query.sourceChildId || query.source_child_id) {
    where.push("source_child_id = @sourceChildId");
    params.sourceChildId = query.sourceChildId || query.source_child_id;
  }
  return db.prepare(`
    UPDATE feishu_project_sync_errors
    SET error_status = 'resolved',
      retryable = 0,
      resolved_at = @resolvedAt,
      updated_at = @resolvedAt
    WHERE ${where.join(" AND ")}
  `).run(params);
}

export function listFeishuProjectSyncErrors({ projectKey, typeKey, workItemId, status, stage, retryable, dueBefore, limit = 100 } = {}) {
  const where = [];
  const params = { limit: fpsLimit(limit) };
  if (projectKey) { where.push("source_project_key = @projectKey"); params.projectKey = projectKey; }
  if (typeKey) { where.push("source_work_item_type_key = @typeKey"); params.typeKey = typeKey; }
  if (workItemId) { where.push("source_work_item_id = @workItemId"); params.workItemId = workItemId; }
  if (status) { where.push("COALESCE(error_status, 'open') = @status"); params.status = status; }
  if (stage) { where.push("stage = @stage"); params.stage = stage; }
  if (retryable !== undefined) { where.push("COALESCE(retryable, 1) = @retryable"); params.retryable = fpsBoolNumber(retryable, 1); }
  if (dueBefore) {
    where.push("(next_retry_at IS NULL OR next_retry_at = '' OR next_retry_at <= @dueBefore)");
    params.dueBefore = dueBefore;
  }
  const sql = `SELECT * FROM feishu_project_sync_errors${where.length ? " WHERE " + where.join(" AND ") : ""} ORDER BY COALESCE(updated_at, created_at) DESC, id DESC LIMIT @limit`;
  return db.prepare(sql).all(params).map(fpsErrorRow);
}

export function listFeishuProjectRetryableSyncErrors(query = {}) {
  return listFeishuProjectSyncErrors({
    ...query,
    status: query.status || "open",
    retryable: query.retryable ?? true,
    dueBefore: query.includeFuture ? undefined : (query.dueBefore || query.due_before || new Date().toISOString()),
  });
}

export function getFeishuProjectCommentSync(key) {
  const k = fpsKey(key);
  return fpsChildRow(db.prepare(`
    SELECT * FROM feishu_project_comment_sync
    WHERE source_system = @sourceSystem
      AND source_project_key = @sourceProjectKey
      AND source_work_item_type_key = @sourceWorkItemTypeKey
      AND source_work_item_id = @sourceWorkItemId
      AND source_comment_id = @sourceCommentId
      AND target_system = @targetSystem
  `).get({ ...k, sourceCommentId: key.sourceCommentId || key.source_comment_id || "" }), "comment");
}

export function upsertFeishuProjectCommentSync(row) {
  const k = fpsKey(row);
  const syncStatus = row.syncStatus || row.sync_status || "pending";
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO feishu_project_comment_sync (
      source_system, source_project_key, source_work_item_type_key, source_work_item_id,
      source_comment_id, target_system, target_task_id, target_comment_id,
      source_payload_hash, sync_status, last_error, synced_at, retry_count,
      last_attempt_at, updated_at
    )
    VALUES (
      @sourceSystem, @sourceProjectKey, @sourceWorkItemTypeKey, @sourceWorkItemId,
      @sourceCommentId, @targetSystem, @targetTaskId, @targetCommentId,
      @sourcePayloadHash, @syncStatus, @lastError, @syncedAt, @retryCount,
      @lastAttemptAt, @updatedAt
    )
    ON CONFLICT(source_system, source_project_key, source_work_item_type_key, source_work_item_id, source_comment_id, target_system)
    DO UPDATE SET
      target_task_id = excluded.target_task_id,
      target_comment_id = excluded.target_comment_id,
      source_payload_hash = excluded.source_payload_hash,
      sync_status = excluded.sync_status,
      last_error = excluded.last_error,
      synced_at = CASE WHEN excluded.synced_at IS NULL OR excluded.synced_at = '' THEN feishu_project_comment_sync.synced_at ELSE excluded.synced_at END,
      retry_count = CASE WHEN excluded.sync_status = 'failed' THEN COALESCE(feishu_project_comment_sync.retry_count, 0) + 1 WHEN excluded.sync_status = 'success' THEN 0 ELSE excluded.retry_count END,
      last_attempt_at = excluded.last_attempt_at,
      updated_at = excluded.updated_at
  `).run({
    ...k,
    sourceCommentId: row.sourceCommentId || row.source_comment_id || "",
    targetTaskId: row.targetTaskId || row.target_task_id || "",
    targetCommentId: row.targetCommentId || row.target_comment_id || "",
    sourcePayloadHash: row.sourcePayloadHash || row.source_payload_hash || "",
    syncStatus,
    lastError: row.lastError || row.last_error || "",
    syncedAt: row.syncedAt || row.synced_at || (syncStatus === "success" ? now : ""),
    retryCount: Number(row.retryCount ?? row.retry_count ?? (syncStatus === "failed" ? 1 : 0)) || 0,
    lastAttemptAt: row.lastAttemptAt || row.last_attempt_at || now,
    updatedAt: row.updatedAt || row.updated_at || now,
  });
  return getFeishuProjectCommentSync({ ...k, sourceCommentId: row.sourceCommentId || row.source_comment_id || "" });
}

export function listFeishuProjectCommentSync({ projectKey, typeKey, workItemId, status, targetTaskId, limit = 100 } = {}) {
  const where = [];
  const params = { limit: fpsLimit(limit) };
  if (projectKey) { where.push("source_project_key = @projectKey"); params.projectKey = projectKey; }
  if (typeKey) { where.push("source_work_item_type_key = @typeKey"); params.typeKey = typeKey; }
  if (workItemId) { where.push("source_work_item_id = @workItemId"); params.workItemId = workItemId; }
  if (status) { where.push("sync_status = @status"); params.status = status; }
  if (targetTaskId) { where.push("target_task_id = @targetTaskId"); params.targetTaskId = targetTaskId; }
  const sql = `SELECT * FROM feishu_project_comment_sync${where.length ? " WHERE " + where.join(" AND ") : ""} ORDER BY COALESCE(updated_at, synced_at) DESC LIMIT @limit`;
  return db.prepare(sql).all(params).map((r) => fpsChildRow(r, "comment"));
}

export function getFeishuProjectAttachmentSync(key) {
  const k = fpsKey(key);
  return fpsChildRow(db.prepare(`
    SELECT * FROM feishu_project_attachment_sync
    WHERE source_system = @sourceSystem
      AND source_project_key = @sourceProjectKey
      AND source_work_item_type_key = @sourceWorkItemTypeKey
      AND source_work_item_id = @sourceWorkItemId
      AND source_attachment_id = @sourceAttachmentId
      AND target_system = @targetSystem
  `).get({ ...k, sourceAttachmentId: key.sourceAttachmentId || key.source_attachment_id || "" }), "attachment");
}

export function upsertFeishuProjectAttachmentSync(row) {
  const k = fpsKey(row);
  const syncStatus = row.syncStatus || row.sync_status || "pending";
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO feishu_project_attachment_sync (
      source_system, source_project_key, source_work_item_type_key, source_work_item_id,
      source_attachment_id, target_system, target_task_id, target_file_id,
      source_payload_hash, sync_status, last_error, synced_at, retry_count,
      last_attempt_at, updated_at
    )
    VALUES (
      @sourceSystem, @sourceProjectKey, @sourceWorkItemTypeKey, @sourceWorkItemId,
      @sourceAttachmentId, @targetSystem, @targetTaskId, @targetFileId,
      @sourcePayloadHash, @syncStatus, @lastError, @syncedAt, @retryCount,
      @lastAttemptAt, @updatedAt
    )
    ON CONFLICT(source_system, source_project_key, source_work_item_type_key, source_work_item_id, source_attachment_id, target_system)
    DO UPDATE SET
      target_task_id = excluded.target_task_id,
      target_file_id = excluded.target_file_id,
      source_payload_hash = excluded.source_payload_hash,
      sync_status = excluded.sync_status,
      last_error = excluded.last_error,
      synced_at = CASE WHEN excluded.synced_at IS NULL OR excluded.synced_at = '' THEN feishu_project_attachment_sync.synced_at ELSE excluded.synced_at END,
      retry_count = CASE WHEN excluded.sync_status = 'failed' THEN COALESCE(feishu_project_attachment_sync.retry_count, 0) + 1 WHEN excluded.sync_status = 'success' THEN 0 ELSE excluded.retry_count END,
      last_attempt_at = excluded.last_attempt_at,
      updated_at = excluded.updated_at
  `).run({
    ...k,
    sourceAttachmentId: row.sourceAttachmentId || row.source_attachment_id || "",
    targetTaskId: row.targetTaskId || row.target_task_id || "",
    targetFileId: row.targetFileId || row.target_file_id || "",
    sourcePayloadHash: row.sourcePayloadHash || row.source_payload_hash || "",
    syncStatus,
    lastError: row.lastError || row.last_error || "",
    syncedAt: row.syncedAt || row.synced_at || (syncStatus === "success" ? now : ""),
    retryCount: Number(row.retryCount ?? row.retry_count ?? (syncStatus === "failed" ? 1 : 0)) || 0,
    lastAttemptAt: row.lastAttemptAt || row.last_attempt_at || now,
    updatedAt: row.updatedAt || row.updated_at || now,
  });
  return getFeishuProjectAttachmentSync({ ...k, sourceAttachmentId: row.sourceAttachmentId || row.source_attachment_id || "" });
}

export function listFeishuProjectAttachmentSync({ projectKey, typeKey, workItemId, status, targetTaskId, limit = 100 } = {}) {
  const where = [];
  const params = { limit: fpsLimit(limit) };
  if (projectKey) { where.push("source_project_key = @projectKey"); params.projectKey = projectKey; }
  if (typeKey) { where.push("source_work_item_type_key = @typeKey"); params.typeKey = typeKey; }
  if (workItemId) { where.push("source_work_item_id = @workItemId"); params.workItemId = workItemId; }
  if (status) { where.push("sync_status = @status"); params.status = status; }
  if (targetTaskId) { where.push("target_task_id = @targetTaskId"); params.targetTaskId = targetTaskId; }
  const sql = `SELECT * FROM feishu_project_attachment_sync${where.length ? " WHERE " + where.join(" AND ") : ""} ORDER BY COALESCE(updated_at, synced_at) DESC LIMIT @limit`;
  return db.prepare(sql).all(params).map((r) => fpsChildRow(r, "attachment"));
}

// ========== 管理员（RBAC）==========
const adminUserChangeListeners = new Set();

export function onAdminUsersChanged(listener) {
  if (typeof listener !== "function") return () => {};
  adminUserChangeListeners.add(listener);
  return () => adminUserChangeListeners.delete(listener);
}

function notifyAdminUsersChanged(change) {
  for (const listener of adminUserChangeListeners) {
    try { listener(change); } catch {}
  }
}

function bumpAdminUsersRevision() {
  db.prepare("UPDATE admin_authz_meta SET revision = revision + 1 WHERE id = 1").run();
  return getAdminUsersRevision();
}

function inferredAdminIssuer(id) {
  return /^[0-9a-f]{24}$/.test(String(id || "")) ? "teambition" : "dingtalk";
}

function normalizedAdminIssuer(value, id) {
  const issuer = String(value || "").trim().toLowerCase();
  return ["teambition", "dingtalk"].includes(issuer) ? issuer : inferredAdminIssuer(id);
}

function adminRow(r) {
  if (!r) return null;
  const issuer = normalizedAdminIssuer(r.subject_issuer, r.ding_userid);
  return {
    dingUserid: r.ding_userid,
    subject: { issuer, id: r.ding_userid },
    subjectId: `${issuer}:${r.ding_userid}`,
    userId: r.ding_userid,
    name: r.name,
    // admin_users is a membership list; it can never grant local super.
    role: "admin",
    addedBy: r.added_by,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    deletedAt: r.deleted_at || 0,
    node: r.node || "",
  };
}
function adminBumpedTs(dingUserid) {
  const cur = db.prepare("SELECT updated_at FROM admin_users WHERE ding_userid = ?").get(String(dingUserid));
  return Math.max(Date.now(), (cur?.updated_at || 0) + 1);
}
export function listAdminUsers() {
  return db.prepare("SELECT ding_userid, subject_issuer, name, role, added_by, created_at, updated_at, deleted_at, node FROM admin_users WHERE COALESCE(deleted_at,0)=0 ORDER BY created_at DESC").all().map(adminRow);
}
export function getAdminUser(userId, issuer = "") {
  const id = String(userId);
  const row = db.prepare("SELECT ding_userid, subject_issuer, name, role, added_by, created_at, updated_at, deleted_at, node FROM admin_users WHERE ding_userid = ? AND COALESCE(deleted_at,0)=0").get(id);
  const user = adminRow(row);
  if (issuer && user?.subject?.issuer !== normalizedAdminIssuer(issuer, id)) return null;
  return user;
}
export function addAdminUser({ subject, issuer, userId, dingUserid, name, addedBy = "", node = "" }) {
  const id = String(subject?.id || userId || dingUserid || "").trim();
  const subjectIssuer = normalizedAdminIssuer(subject?.issuer || issuer, id);
  const now = adminBumpedTs(id);
  db.prepare(`INSERT INTO admin_users (ding_userid, subject_issuer, name, role, added_by, created_at, updated_at, deleted_at, node)
    VALUES (@ding_userid,@subject_issuer,@name,@role,@added_by,@created_at,@updated_at,0,@node)
    ON CONFLICT(ding_userid) DO UPDATE SET
      subject_issuer=excluded.subject_issuer, name=excluded.name, role=excluded.role, added_by=excluded.added_by,
      updated_at=excluded.updated_at, deleted_at=0, node=excluded.node`)
    .run({ ding_userid: id, subject_issuer: subjectIssuer, name: String(name || id), role: "admin", added_by: addedBy, created_at: now, updated_at: now, node });
  const user = getAdminUser(id, subjectIssuer);
  notifyAdminUsersChanged({ action: "upsert", dingUserid: id, subjectId: `${subjectIssuer}:${id}`, revision: bumpAdminUsersRevision(), user });
  return user;
}
export function removeAdminUser(dingUserid) {
  const id = String(dingUserid);
  const cur = db.prepare("SELECT ding_userid, subject_issuer FROM admin_users WHERE ding_userid = ?").get(id);
  if (!cur) return { changes: 0 };
  const now = adminBumpedTs(id);
  const result = db.prepare("UPDATE admin_users SET role = 'admin', updated_at = ?, deleted_at = ?, node = COALESCE(node,'') WHERE ding_userid = ?").run(now, now, id);
  if (result.changes) {
    const issuer = normalizedAdminIssuer(cur.subject_issuer, id);
    notifyAdminUsersChanged({ action: "remove", dingUserid: id, subjectId: `${issuer}:${id}`, revision: bumpAdminUsersRevision(), user: null });
  }
  return result;
}
export function countAdminUsers() {
  return db.prepare("SELECT COUNT(*) AS n FROM admin_users WHERE COALESCE(deleted_at,0)=0").get().n;
}
export function listAdminUsersSince(since = 0) {
  return db.prepare("SELECT ding_userid, subject_issuer, name, role, added_by, created_at, updated_at, deleted_at, node FROM admin_users WHERE COALESCE(updated_at,0) >= ? ORDER BY updated_at ASC")
    .all(since).map(adminRow);
}
export function mergeAdminUser(row) {
  const id = String(row?.subject?.id || row?.userId || row?.dingUserid || row?.ding_userid || "").trim();
  if (!id) return null;
  const subjectIssuer = normalizedAdminIssuer(row?.subject?.issuer || row?.subjectIssuer || row?.subject_issuer, id);
  const incoming = {
    ding_userid: id,
    subject_issuer: subjectIssuer,
    name: String(row.name || id),
    role: "admin",
    added_by: String(row.addedBy || row.added_by || ""),
    created_at: Number(row.createdAt ?? row.created_at ?? row.updatedAt ?? row.updated_at ?? Date.now()) || Date.now(),
    updated_at: Number(row.updatedAt ?? row.updated_at ?? row.createdAt ?? row.created_at ?? Date.now()) || Date.now(),
    deleted_at: Number(row.deletedAt ?? row.deleted_at ?? 0) || 0,
    node: String(row.node || ""),
  };
  const cur = db.prepare("SELECT updated_at FROM admin_users WHERE ding_userid = ?").get(id);
  if (cur && (cur.updated_at || 0) >= incoming.updated_at) return getAdminUser(id);
  db.prepare(`INSERT INTO admin_users (ding_userid, subject_issuer, name, role, added_by, created_at, updated_at, deleted_at, node)
    VALUES (@ding_userid,@subject_issuer,@name,@role,@added_by,@created_at,@updated_at,@deleted_at,@node)
    ON CONFLICT(ding_userid) DO UPDATE SET
      subject_issuer=excluded.subject_issuer, name=excluded.name, role=excluded.role, added_by=excluded.added_by,
      created_at=MIN(admin_users.created_at, excluded.created_at),
      updated_at=excluded.updated_at, deleted_at=excluded.deleted_at, node=excluded.node`)
    .run(incoming);
  const user = getAdminUser(id, subjectIssuer);
  notifyAdminUsersChanged({
    action: incoming.deleted_at ? "replicate-remove" : "replicate-upsert",
    dingUserid: id,
    subjectId: `${subjectIssuer}:${id}`,
    revision: bumpAdminUsersRevision(),
    user,
  });
  return user;
}
export function maxAdminUsersUpdated() {
  return db.prepare("SELECT MAX(updated_at) AS m FROM admin_users").get().m || 0;
}
export function getAdminUsersRevision() {
  return db.prepare("SELECT revision FROM admin_authz_meta WHERE id = 1").get()?.revision || 0;
}

// ========== 管理员操作审计日志 ==========
// id 用 节点+时间+随机 唯一；INSERT OR IGNORE 便于跨服务端合并去重
export function addAudit({ id, ts, ip, actor, role, action, target, before, after, node }) {
  db.prepare("INSERT OR IGNORE INTO admin_audit (id, ts, ip, actor, role, action, target, before, after, node) VALUES (@id,@ts,@ip,@actor,@role,@action,@target,@before,@after,@node)")
    .run({ id, ts: ts || Date.now(), ip: ip || "", actor: actor || "", role: role || "", action: action || "", target: target || "",
      before: typeof before === "string" ? before : JSON.stringify(before ?? null),
      after: typeof after === "string" ? after : JSON.stringify(after ?? null), node: node || "" });
}
export function listAudit({ limit = 50, since = 0 } = {}) {
  const safeLimit = Math.max(1, Math.min(2000, Number.parseInt(limit, 10) || 50));
  return db.prepare("SELECT id, ts, ip, actor, role, action, target, before, after, node FROM admin_audit WHERE ts >= ? ORDER BY ts DESC, id DESC LIMIT ?").all(since, safeLimit);
}
export function findAuditByActionTarget(action, target) {
  return db.prepare("SELECT id, ts, ip, actor, role, action, target, before, after, node FROM admin_audit WHERE action=? AND target=? ORDER BY ts DESC LIMIT 1")
    .get(String(action || ""), String(target || "")) || null;
}
export function maxAuditTs() {
  return db.prepare("SELECT MAX(ts) AS m FROM admin_audit").get().m || 0;
}

// ========== 管理员登录令牌持久化（网关重启不掉登录）==========
function persistedAuthTokenKey(token) {
  const value = String(token || "");
  if (value.startsWith("sha256:") && /^[0-9a-f]{64}$/.test(value.slice(7))) return value;
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}
export function saveAuthToken(token, data, exp) {
  db.prepare("INSERT OR REPLACE INTO admin_tokens (token, data, exp) VALUES (?,?,?)")
    .run(persistedAuthTokenKey(token), JSON.stringify(data || {}), exp || 0);
}
export function deleteAuthToken(token) {
  db.prepare("DELETE FROM admin_tokens WHERE token IN (?, ?)").run(
    persistedAuthTokenKey(token),
    String(token || ""),
  );
}
export function loadAuthTokens() {
  db.prepare("DELETE FROM admin_tokens WHERE exp < ?").run(Date.now()); // 顺手清过期
  const rows = db.prepare("SELECT token, data, exp FROM admin_tokens").all();
  const migrate = db.transaction((legacyRows) => {
    const insert = db.prepare("INSERT OR REPLACE INTO admin_tokens (token, data, exp) VALUES (?,?,?)");
    const remove = db.prepare("DELETE FROM admin_tokens WHERE token = ?");
    for (const row of legacyRows) {
      const key = persistedAuthTokenKey(row.token);
      if (key === row.token) continue;
      insert.run(key, row.data, row.exp);
      remove.run(row.token);
      row.token = key;
    }
  });
  migrate(rows);
  return rows.map((r) => {
    try {
      return { tokenHash: r.token, data: JSON.parse(r.data), exp: r.exp };
    } catch {
      return null;
    }
  }).filter(Boolean);
}

// ========== 问题反馈（feedback） ==========
const FB_COLS = "id, ts, updated_at, reporter_id, reporter_name, reporter_kind, title, body, status, priority, assignee, page, project, attachments, comments, node";
function fbRow(r) {
  if (!r) return null;
  return { ...r, attachments: safeParse(r.attachments, []), comments: safeParse(r.comments, []) };
}
function safeParse(s, dflt) { try { return s ? JSON.parse(s) : dflt; } catch { return dflt; } }

// upsert：本地新建/编辑与 gossip 合并统一走此函数；仅当 updated_at 较新才覆盖（新者胜，幂等）
export function upsertFeedback(f) {
  const row = {
    id: f.id, ts: f.ts || Date.now(), updated_at: f.updated_at || Date.now(),
    reporter_id: f.reporter_id || "", reporter_name: f.reporter_name || "", reporter_kind: f.reporter_kind || "name",
    title: f.title || "", body: f.body || "", status: f.status || "open", priority: f.priority || "normal",
    assignee: f.assignee || "", page: f.page || "", project: f.project || "",
    attachments: typeof f.attachments === "string" ? f.attachments : JSON.stringify(f.attachments || []),
    comments: typeof f.comments === "string" ? f.comments : JSON.stringify(f.comments || []),
    node: f.node || "",
  };
  db.prepare(`INSERT INTO feedback (${FB_COLS}) VALUES (@id,@ts,@updated_at,@reporter_id,@reporter_name,@reporter_kind,@title,@body,@status,@priority,@assignee,@page,@project,@attachments,@comments,@node)
    ON CONFLICT(id) DO UPDATE SET
      updated_at=excluded.updated_at, title=excluded.title, body=excluded.body, status=excluded.status,
      priority=excluded.priority, assignee=excluded.assignee, project=excluded.project,
      attachments=excluded.attachments, comments=excluded.comments
    WHERE excluded.updated_at > feedback.updated_at`).run(row);
  return getFeedback(f.id);
}
export function getFeedback(id) {
  return fbRow(db.prepare(`SELECT ${FB_COLS} FROM feedback WHERE id = ?`).get(id));
}
export function listFeedback({ reporterId, status, assignee, since = 0, limit = 500 } = {}) {
  const where = ["updated_at >= @since"], p = { since, limit };
  if (reporterId) { where.push("reporter_id = @reporterId"); p.reporterId = reporterId; }
  if (status) { where.push("status = @status"); p.status = status; }
  if (assignee) { where.push("assignee = @assignee"); p.assignee = assignee; }
  return db.prepare(`SELECT ${FB_COLS} FROM feedback WHERE ${where.join(" AND ")} ORDER BY updated_at DESC LIMIT @limit`).all(p).map(fbRow);
}
// 本地修改用单调递增时间戳（严格大于当前），避免同毫秒连续写被 upsert 的"新者胜"守卫挡掉
function bumpedTs(cur) { return Math.max(Date.now(), (cur?.updated_at || 0) + 1); }
export function updateFeedback(id, patch) {
  const cur = getFeedback(id);
  if (!cur) return null;
  return upsertFeedback({ ...cur, ...patch, attachments: patch.attachments ?? cur.attachments, comments: patch.comments ?? cur.comments, updated_at: bumpedTs(cur) });
}
export function addFeedbackComment(id, comment) {
  const cur = getFeedback(id);
  if (!cur) return null;
  const comments = [...(cur.comments || []), { ts: Date.now(), ...comment }];
  return upsertFeedback({ ...cur, comments, updated_at: bumpedTs(cur) });
}
export function maxFeedbackUpdated() {
  return db.prepare("SELECT MAX(updated_at) AS m FROM feedback").get().m || 0;
}

// ========== devbench 按用户数据(任务/Tab)，中心存 + gossip 同步 ==========
const LOCAL_ONLY_USERDATA_KINDS = new Set(["tabs", "closed", "deviceRuntime"]);
const LOCAL_ONLY_USERDATA_KIND_LIST = [...LOCAL_ONLY_USERDATA_KINDS];
const LOCAL_ONLY_USERDATA_KIND_SQL = LOCAL_ONLY_USERDATA_KIND_LIST.map(() => "?").join(",");
function isLocalOnlyUserData(kind) {
  return LOCAL_ONLY_USERDATA_KINDS.has(String(kind || ""));
}

// 读取某用户某类数据(返回解析后的数组，无则 null 以便上层迁移文件)
export function getUserData(userKey, kind) {
  const r = db.prepare("SELECT data FROM devbench_userdata WHERE user_key=? AND kind=?").get(userKey, kind);
  if (!r) return null;
  try { return JSON.parse(r.data); } catch { return null; }
}
export function getUserDataRecord(userKey, kind) {
  const r = db.prepare("SELECT data, updated_at, node FROM devbench_userdata WHERE user_key=? AND kind=?").get(userKey, kind);
  if (!r) return null;
  try { return { data: JSON.parse(r.data), updated_at: r.updated_at || 0, node: r.node || "" }; } catch { return null; }
}
export function getUserDataMetadata(userKey, kind) {
  // 热路径只读取索引行的版本字段；length(data) 会扫描多 MB 的共享 JSON，
  // 即使不解析内容也会让每次发现广播多出数毫秒 I/O。
  const r = db.prepare("SELECT updated_at, node FROM devbench_userdata WHERE user_key=? AND kind=?").get(userKey, kind);
  if (!r) return null;
  return {
    updatedAt: Number(r.updated_at) || 0,
    node: r.node || "",
  };
}
// 写入(本地修改用单调递增时间戳，避免同毫秒被 gossip 守卫挡掉)
export function setUserData(userKey, kind, arr, node = "") {
  const cur = db.prepare("SELECT updated_at FROM devbench_userdata WHERE user_key=? AND kind=?").get(userKey, kind);
  const ts = Math.max(Date.now(), (cur?.updated_at || 0) + 1);
  db.prepare(`INSERT INTO devbench_userdata (user_key, kind, data, updated_at, node) VALUES (@user_key,@kind,@data,@updated_at,@node)
    ON CONFLICT(user_key,kind) DO UPDATE SET data=excluded.data, updated_at=excluded.updated_at, node=excluded.node`)
    .run({ user_key: userKey, kind, data: JSON.stringify(arr || []), updated_at: ts, node });
  return ts;
}

/**
 * 在 SQLite 的 BEGIN IMMEDIATE 事务中完成一行用户数据的读-改-写。
 *
 * devbench 的共享配置是一整行 JSON；如果多个 Gateway 各自先读再调用
 * setUserData，较晚提交的旧快照会覆盖另一进程刚写入的 run/sample。这里把
 * “读取最新值 + 合并 + 回写”放进同一个跨进程写锁，供共享配置增量写使用。
 */
export function updateUserData(userKey, kind, updater, node = "") {
  if (typeof updater !== "function") throw new TypeError("updateUserData updater 必须是函数");
  const run = db.transaction(() => {
    const current = db.prepare("SELECT data, updated_at, node FROM devbench_userdata WHERE user_key=? AND kind=?").get(userKey, kind);
    let currentData = null;
    if (current) {
      try { currentData = JSON.parse(current.data); } catch { currentData = null; }
    }
    const nextData = updater(currentData, {
      updatedAt: Number(current?.updated_at || 0),
      node: String(current?.node || ""),
    });
    if (nextData === undefined) {
      return { data: currentData, updatedAt: Number(current?.updated_at || 0), node: String(current?.node || "") };
    }
    const ts = Math.max(Date.now(), Number(current?.updated_at || 0) + 1);
    db.prepare(`INSERT INTO devbench_userdata (user_key, kind, data, updated_at, node) VALUES (@user_key,@kind,@data,@updated_at,@node)
      ON CONFLICT(user_key,kind) DO UPDATE SET data=excluded.data, updated_at=excluded.updated_at, node=excluded.node`)
      .run({ user_key: userKey, kind, data: JSON.stringify(nextData ?? []), updated_at: ts, node });
    return { data: nextData, updatedAt: ts, node };
  });
  return run.immediate();
}

/**
 * 原子更新同一设备桶中的进行中/已关闭故事点两行。
 * 用于“重新打开”这类必须同时迁移 tabs 与 closed 的操作，避免两个 Gateway
 * 各自整行覆盖时出现同一故事点同时存在于两边或凭空丢失。
 */
export function updateDevbenchStoryState(userKey, updater, node = "") {
  if (typeof updater !== "function") throw new TypeError("updateDevbenchStoryState updater 必须是函数");
  const run = db.transaction(() => {
    const rows = db.prepare("SELECT kind, data, updated_at, node FROM devbench_userdata WHERE user_key=? AND kind IN ('tabs','closed')")
      .all(userKey);
    const byKind = new Map(rows.map((row) => [row.kind, row]));
    const parse = (kind) => {
      try {
        const value = JSON.parse(byKind.get(kind)?.data || "[]");
        return Array.isArray(value) ? value : [];
      } catch { return []; }
    };
    const current = { tabs: parse("tabs"), closed: parse("closed") };
    const next = updater(current);
    if (next === undefined) return { ...current, result: undefined };
    const write = (kind, value) => {
      const previous = byKind.get(kind);
      const ts = Math.max(Date.now(), Number(previous?.updated_at || 0) + 1);
      db.prepare(`INSERT INTO devbench_userdata (user_key, kind, data, updated_at, node) VALUES (@user_key,@kind,@data,@updated_at,@node)
        ON CONFLICT(user_key,kind) DO UPDATE SET data=excluded.data, updated_at=excluded.updated_at, node=excluded.node`)
        .run({ user_key: userKey, kind, data: JSON.stringify(value || []), updated_at: ts, node });
    };
    const tabs = Object.hasOwn(next || {}, "tabs") ? (next.tabs || []) : current.tabs;
    const closed = Object.hasOwn(next || {}, "closed") ? (next.closed || []) : current.closed;
    if (Object.hasOwn(next || {}, "tabs")) write("tabs", tabs);
    if (Object.hasOwn(next || {}, "closed")) write("closed", closed);
    return { tabs, closed, result: next?.result };
  });
  return run.immediate();
}
// gossip 合并(新者胜)：仅当传入 updated_at 比本地新才覆盖
export function mergeUserData(row) {
  if (!row || !row.user_key || !row.kind) return;
  if (isLocalOnlyUserData(row.kind)) return;
  const cur = db.prepare("SELECT updated_at FROM devbench_userdata WHERE user_key=? AND kind=?").get(row.user_key, row.kind);
  if (cur && cur.updated_at >= row.updated_at) return;
  db.prepare(`INSERT INTO devbench_userdata (user_key, kind, data, updated_at, node) VALUES (@user_key,@kind,@data,@updated_at,@node)
    ON CONFLICT(user_key,kind) DO UPDATE SET data=excluded.data, updated_at=excluded.updated_at, node=excluded.node`)
    .run({ user_key: row.user_key, kind: row.kind, data: typeof row.data === "string" ? row.data : JSON.stringify(row.data || []), updated_at: row.updated_at || Date.now(), node: row.node || "" });
}
// 注意：排除内部键（__devbench_shared__ 学习/共享数据、__system__ 迁移标记等以 __ 开头的键）。
//  - 学习/共享数据(byProject)走【版本闸门的 shared-bundle gossip】(getSharedBundle/applySharedBundle)，
//    不能再走这里的"按 updated_at 新者胜"逐行 gossip —— 两套排序口径不同会互相回退、丢数据；
//  - __system__ 是各节点本地的迁移标记，本就不该跨机同步。
export function listUserDataSince(since = 0) {
  return db.prepare(`SELECT user_key, kind, data, updated_at, node FROM devbench_userdata WHERE updated_at >= ? AND user_key NOT LIKE '\\_\\_%' ESCAPE '\\' AND kind NOT IN (${LOCAL_ONLY_USERDATA_KIND_SQL}) ORDER BY updated_at ASC`)
    .all(since, ...LOCAL_ONLY_USERDATA_KIND_LIST);
}
export function listSyncableUserDataRows() {
  return db.prepare(`SELECT user_key, kind, data, updated_at, node FROM devbench_userdata WHERE user_key NOT LIKE '\\_\\_%' ESCAPE '\\' AND kind NOT IN (${LOCAL_ONLY_USERDATA_KIND_SQL}) ORDER BY user_key ASC, kind ASC`)
    .all(...LOCAL_ONLY_USERDATA_KIND_LIST)
    .map((r) => ({ user_key: r.user_key, kind: r.kind, data: safeParse(r.data, []), updated_at: r.updated_at || 0, node: r.node || "" }));
}

export function replaceSyncableUserDataRows(rows = [], node = "") {
  const cleanRows = (Array.isArray(rows) ? rows : [])
    .filter((row) => row && row.user_key && row.kind && !String(row.user_key).startsWith("__") && !isLocalOnlyUserData(row.kind))
    .map((row) => ({ ...row, data: typeof row.data === "string" ? safeParse(row.data, []) : row.data }));
  const baseTs = Math.max(Date.now(), maxUserDataUpdated() + 1);
  const tx = db.transaction(() => {
    db.prepare(`DELETE FROM devbench_userdata WHERE user_key NOT LIKE '\\_\\_%' ESCAPE '\\' AND kind NOT IN (${LOCAL_ONLY_USERDATA_KIND_SQL})`)
      .run(...LOCAL_ONLY_USERDATA_KIND_LIST);
    const stmt = db.prepare(`INSERT INTO devbench_userdata (user_key, kind, data, updated_at, node)
      VALUES (@user_key, @kind, @data, @updated_at, @node)`);
    cleanRows.forEach((row, idx) => {
      stmt.run({
        user_key: String(row.user_key),
        kind: String(row.kind),
        data: JSON.stringify(row.data ?? []),
        updated_at: baseTs + idx,
        node: node || row.node || "",
      });
    });
  });
  tx();
  return { restored: cleanRows.length };
}

function backupMetaRow(r) {
  if (!r) return null;
  const legacyBytes = Number(r.legacy_bytes) || 0;
  return {
    id: r.id,
    createdAt: r.created_at || 0,
    source: r.source || "",
    label: r.label || "",
    note: r.note || "",
    summary: safeParse(r.summary, {}),
    node: r.node || "",
    blobHash: r.blob_hash || "",
    encoding: r.encoding || (r.blob_hash ? "" : "json"),
    rawBytes: Number(r.raw_bytes) || legacyBytes,
    storedBytes: Number(r.stored_bytes) || legacyBytes,
  };
}

const DEVBENCH_BACKUP_GZIP_ENCODING = "gzip-json-v1";
const DEVBENCH_BACKUP_JSON_ENCODING = "json-utf8-v1";

function encodeDevbenchSyncBackupData(value) {
  const text = typeof value === "string" ? value : JSON.stringify(value || {});
  const raw = Buffer.from(text, "utf8");
  const compressed = gzipSync(raw, { level: 6 });
  const useGzip = compressed.length < raw.length;
  const data = useGzip ? compressed : raw;
  return {
    blobHash: createHash("sha256").update(raw).digest("hex"),
    encoding: useGzip ? DEVBENCH_BACKUP_GZIP_ENCODING : DEVBENCH_BACKUP_JSON_ENCODING,
    rawBytes: raw.length,
    storedBytes: data.length,
    data,
  };
}

function decodeDevbenchSyncBackupData(row) {
  if (!row) return null;
  const payload = row.blob_data ?? row.legacy_data;
  if (payload === null || payload === undefined || payload === "") return null;
  try {
    if (row.encoding === DEVBENCH_BACKUP_GZIP_ENCODING) {
      return safeParse(gunzipSync(payload).toString("utf8"), null);
    }
    if (Buffer.isBuffer(payload)) return safeParse(payload.toString("utf8"), null);
    return safeParse(String(payload), null);
  } catch {
    return null;
  }
}

const backupMetaSelect = `
  SELECT b.id, b.created_at, b.source, b.label, b.note, b.summary, b.node, b.blob_hash,
         p.encoding, p.raw_bytes, p.stored_bytes,
         CASE WHEN COALESCE(b.blob_hash, '') = '' THEN length(CAST(b.data AS BLOB)) ELSE 0 END AS legacy_bytes
  FROM devbench_sync_backups b
  LEFT JOIN devbench_sync_backup_blobs p ON p.blob_hash = b.blob_hash
`;

export function insertDevbenchSyncBackup(row = {}) {
  const encoded = encodeDevbenchSyncBackupData(row.data);
  const createdAt = row.createdAt || row.created_at || Date.now();
  const tx = db.transaction(() => {
    db.prepare(`INSERT OR IGNORE INTO devbench_sync_backup_blobs
      (blob_hash, encoding, raw_bytes, stored_bytes, data, created_at)
      VALUES (@blob_hash, @encoding, @raw_bytes, @stored_bytes, @data, @created_at)`).run({
        blob_hash: encoded.blobHash,
        encoding: encoded.encoding,
        raw_bytes: encoded.rawBytes,
        stored_bytes: encoded.storedBytes,
        data: encoded.data,
        created_at: createdAt,
      });
    db.prepare(`INSERT INTO devbench_sync_backups
      (id, created_at, source, label, note, summary, data, blob_hash, node)
      VALUES (@id, @created_at, @source, @label, @note, @summary, '', @blob_hash, @node)`).run({
      id: row.id,
      created_at: createdAt,
      source: row.source || "manual",
      label: row.label || "",
      note: row.note || "",
      summary: JSON.stringify(row.summary || {}),
      blob_hash: encoded.blobHash,
      node: row.node || "",
    });
  });
  tx();
  return getDevbenchSyncBackup(row.id);
}

export function listDevbenchSyncBackups({ limit = 200 } = {}) {
  return db.prepare(`${backupMetaSelect} ORDER BY b.created_at DESC LIMIT ?`)
    .all(Math.max(1, Math.min(Number(limit) || 200, 1000)))
    .map(backupMetaRow);
}

export function getLatestDevbenchSyncBackupMeta(source = "") {
  const normalizedSource = String(source || "").trim();
  const where = normalizedSource ? " WHERE b.source = ?" : "";
  const r = db.prepare(`${backupMetaSelect}${where} ORDER BY b.created_at DESC, b.id DESC LIMIT 1`)
    .get(...(normalizedSource ? [normalizedSource] : []));
  return backupMetaRow(r);
}

export function pruneDevbenchSyncBackups({ source = "auto", keep = 48 } = {}) {
  const normalizedSource = String(source || "auto").trim() || "auto";
  const keepCount = Math.max(1, Math.min(1000, Math.trunc(Number(keep) || 48)));
  const stale = db.prepare(`
    SELECT b.id,
           COALESCE(p.stored_bytes, length(CAST(b.data AS BLOB)), 0) AS bytes
    FROM devbench_sync_backups b
    LEFT JOIN devbench_sync_backup_blobs p ON p.blob_hash = b.blob_hash
    WHERE b.source = ?
    ORDER BY b.created_at DESC, b.id DESC
    LIMIT -1 OFFSET ?
  `).all(normalizedSource, keepCount);
  if (!stale.length) {
    const retained = db.prepare("SELECT COUNT(*) AS count FROM devbench_sync_backups WHERE source = ?")
      .get(normalizedSource).count || 0;
    return { source: normalizedSource, keep: keepCount, deleted: 0, deletedBytes: 0, retained };
  }
  const remove = db.prepare("DELETE FROM devbench_sync_backups WHERE id = ?");
  const tx = db.transaction((rows) => {
    for (const row of rows) remove.run(row.id);
    db.prepare(`DELETE FROM devbench_sync_backup_blobs
      WHERE NOT EXISTS (
        SELECT 1 FROM devbench_sync_backups b WHERE b.blob_hash = devbench_sync_backup_blobs.blob_hash
      )`).run();
  });
  tx(stale);
  const retained = db.prepare("SELECT COUNT(*) AS count FROM devbench_sync_backups WHERE source = ?")
    .get(normalizedSource).count || 0;
  return {
    source: normalizedSource,
    keep: keepCount,
    deleted: stale.length,
    deletedBytes: stale.reduce((sum, row) => sum + (Number(row.bytes) || 0), 0),
    retained,
  };
}

export function getDevbenchSyncBackupStorageStats() {
  const bySource = db.prepare(`
    SELECT b.source, COUNT(*) AS count,
           COALESCE(SUM(COALESCE(p.stored_bytes, length(CAST(b.data AS BLOB)), 0)), 0) AS bytes,
           COALESCE(SUM(COALESCE(p.raw_bytes, length(CAST(b.data AS BLOB)), 0)), 0) AS raw_bytes
    FROM devbench_sync_backups b
    LEFT JOIN devbench_sync_backup_blobs p ON p.blob_hash = b.blob_hash
    GROUP BY b.source
    ORDER BY bytes DESC
  `).all().map((row) => ({
    source: row.source || "",
    count: Number(row.count) || 0,
    bytes: Number(row.bytes) || 0,
    rawBytes: Number(row.raw_bytes) || 0,
  }));
  const uniqueBlobs = db.prepare(`
    SELECT COUNT(*) AS count,
           COALESCE(SUM(stored_bytes), 0) AS stored_bytes,
           COALESCE(SUM(raw_bytes), 0) AS raw_bytes
    FROM devbench_sync_backup_blobs
    WHERE EXISTS (
      SELECT 1 FROM devbench_sync_backups b WHERE b.blob_hash = devbench_sync_backup_blobs.blob_hash
    )
  `).get();
  const legacy = db.prepare(`
    SELECT COUNT(*) AS count, COALESCE(SUM(length(CAST(data AS BLOB))), 0) AS bytes
    FROM devbench_sync_backups WHERE COALESCE(blob_hash, '') = ''
  `).get();
  const pageCount = Number(db.pragma("page_count", { simple: true })) || 0;
  const pageSize = Number(db.pragma("page_size", { simple: true })) || 0;
  const freePages = Number(db.pragma("freelist_count", { simple: true })) || 0;
  return {
    backupCount: bySource.reduce((sum, row) => sum + row.count, 0),
    backupBytes: (Number(uniqueBlobs.stored_bytes) || 0) + (Number(legacy.bytes) || 0),
    backupRawBytes: (Number(uniqueBlobs.raw_bytes) || 0) + (Number(legacy.bytes) || 0),
    uniqueBlobCount: Number(uniqueBlobs.count) || 0,
    legacyBackupCount: Number(legacy.count) || 0,
    bySource,
    databaseBytes: pageCount * pageSize,
    reclaimableBytes: freePages * pageSize,
  };
}

export function getDevbenchSyncBackup(id) {
  const r = db.prepare(`
    SELECT b.id, b.created_at, b.source, b.label, b.note, b.summary, b.node, b.blob_hash,
           b.data AS legacy_data, p.data AS blob_data, p.encoding, p.raw_bytes, p.stored_bytes,
           CASE WHEN COALESCE(b.blob_hash, '') = '' THEN length(CAST(b.data AS BLOB)) ELSE 0 END AS legacy_bytes
    FROM devbench_sync_backups b
    LEFT JOIN devbench_sync_backup_blobs p ON p.blob_hash = b.blob_hash
    WHERE b.id = ?
  `).get(id);
  if (!r) return null;
  return { ...backupMetaRow(r), data: decodeDevbenchSyncBackupData(r) };
}

export function getDevbenchSyncBackupSetting(key) {
  const r = db.prepare("SELECT value FROM devbench_sync_backup_settings WHERE key = ?").get(key);
  return r ? safeParse(r.value, null) : null;
}

export function setDevbenchSyncBackupSetting(key, value) {
  db.prepare(`INSERT INTO devbench_sync_backup_settings (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run(key, JSON.stringify(value ?? null));
  return value;
}

export function maxUserDataUpdated() {
  return db.prepare("SELECT MAX(updated_at) AS m FROM devbench_userdata WHERE user_key NOT LIKE '\\_\\_%' ESCAPE '\\' AND kind NOT IN ('tabs','closed')").get().m || 0;
}

// ========== 项目开发（projectdev：无人值守编排内核的持久化）==========
// projects：一份 spec（JSON）+ 状态；runs：每次编排运行（含 run-state 快照）；events：编排事件流。
// node 列为局域网同步预留口（暂不实现 gossip，仅记录产生节点）。
db.exec(`
  CREATE TABLE IF NOT EXISTS projectdev_projects (
    id TEXT PRIMARY KEY,
    name TEXT,
    spec TEXT,                 -- JSON: 编排 spec
    status TEXT DEFAULT 'idle',
    user_key TEXT,
    created_at TEXT DEFAULT (datetime('now', 'localtime')),
    updated_at TEXT DEFAULT (datetime('now', 'localtime')),
    node TEXT
  );

  CREATE TABLE IF NOT EXISTS projectdev_runs (
    run_id TEXT PRIMARY KEY,
    project_id TEXT,
    status TEXT DEFAULT 'running',
    state TEXT,                -- JSON: run-state 快照
    started_at TEXT DEFAULT (datetime('now', 'localtime')),
    finished_at TEXT
  );

  CREATE TABLE IF NOT EXISTS projectdev_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id TEXT,
    run_id TEXT,
    ts TEXT,
    type TEXT,
    data TEXT                  -- JSON: 事件载荷
  );
  CREATE INDEX IF NOT EXISTS idx_projectdev_events_pid ON projectdev_events(project_id, id);
`);

export function listProjectDevProjects() {
  return db.prepare("SELECT id, name, spec, status, user_key AS userKey, created_at AS createdAt, updated_at AS updatedAt, node FROM projectdev_projects ORDER BY updated_at DESC").all();
}
export function getProjectDevProject(id) {
  return db.prepare("SELECT id, name, spec, status, user_key AS userKey, created_at AS createdAt, updated_at AS updatedAt, node FROM projectdev_projects WHERE id = ?").get(id);
}
// upsert：spec 既可传对象也可传 JSON 字符串，统一序列化存储。
export function upsertProjectDevProject(row) {
  const now = new Date().toISOString();
  const spec = typeof row.spec === "string" ? row.spec : JSON.stringify(row.spec ?? null);
  const existing = getProjectDevProject(row.id);
  db.prepare(`
    INSERT INTO projectdev_projects (id, name, spec, status, user_key, created_at, updated_at, node)
    VALUES (@id, @name, @spec, @status, @user_key, @created_at, @updated_at, @node)
    ON CONFLICT(id) DO UPDATE SET name=excluded.name, spec=excluded.spec, status=excluded.status,
      user_key=excluded.user_key, updated_at=excluded.updated_at, node=excluded.node
  `).run({
    id: row.id, name: row.name || "", spec, status: row.status || "idle",
    user_key: row.userKey || row.user_key || "",
    created_at: existing?.createdAt || row.createdAt || now,
    updated_at: now, node: row.node || "",
  });
  return getProjectDevProject(row.id);
}
export function deleteProjectDevProject(id) {
  db.prepare("DELETE FROM projectdev_events WHERE project_id = ?").run(id);
  db.prepare("DELETE FROM projectdev_runs WHERE project_id = ?").run(id);
  return db.prepare("DELETE FROM projectdev_projects WHERE id = ?").run(id);
}

export function insertProjectDevRun({ runId, projectId, status = "running", state = null, startedAt } = {}) {
  db.prepare(`INSERT OR REPLACE INTO projectdev_runs (run_id, project_id, status, state, started_at, finished_at)
    VALUES (@run_id, @project_id, @status, @state, @started_at, NULL)`)
    .run({
      run_id: runId, project_id: projectId, status,
      state: state == null ? null : (typeof state === "string" ? state : JSON.stringify(state)),
      started_at: startedAt || new Date().toISOString(),
    });
  return getProjectDevRun(runId);
}
export function updateProjectDevRun(runId, { status, state, finishedAt } = {}) {
  const fields = [];
  const params = { run_id: runId };
  if (status !== undefined) { fields.push("status = @status"); params.status = status; }
  if (state !== undefined) { fields.push("state = @state"); params.state = state == null ? null : (typeof state === "string" ? state : JSON.stringify(state)); }
  if (finishedAt !== undefined) { fields.push("finished_at = @finished_at"); params.finished_at = finishedAt; }
  if (!fields.length) return getProjectDevRun(runId);
  db.prepare(`UPDATE projectdev_runs SET ${fields.join(", ")} WHERE run_id = @run_id`).run(params);
  return getProjectDevRun(runId);
}
export function getProjectDevRun(runId) {
  const r = db.prepare("SELECT run_id AS runId, project_id AS projectId, status, state, started_at AS startedAt, finished_at AS finishedAt FROM projectdev_runs WHERE run_id = ?").get(runId);
  if (r && typeof r.state === "string") { try { r.state = JSON.parse(r.state); } catch {} }
  return r || null;
}
export function getLatestRun(projectId) {
  const r = db.prepare("SELECT run_id AS runId, project_id AS projectId, status, state, started_at AS startedAt, finished_at AS finishedAt FROM projectdev_runs WHERE project_id = ? ORDER BY started_at DESC, rowid DESC LIMIT 1").get(projectId);
  if (r && typeof r.state === "string") { try { r.state = JSON.parse(r.state); } catch {} }
  return r || null;
}

export function insertProjectDevEvent({ projectId, runId, ts, type, data } = {}) {
  const info = db.prepare(`INSERT INTO projectdev_events (project_id, run_id, ts, type, data)
    VALUES (@project_id, @run_id, @ts, @type, @data)`)
    .run({
      project_id: projectId, run_id: runId, ts: ts || new Date().toISOString(), type: type || "",
      data: data == null ? null : (typeof data === "string" ? data : JSON.stringify(data)),
    });
  return Number(info.lastInsertRowid);
}
export function listProjectDevEvents(projectId, sinceId = 0, limit = 500) {
  const rows = db.prepare("SELECT id, project_id AS projectId, run_id AS runId, ts, type, data FROM projectdev_events WHERE project_id = ? AND id > ? ORDER BY id ASC LIMIT ?")
    .all(projectId, sinceId || 0, limit || 500);
  for (const r of rows) { if (typeof r.data === "string") { try { r.data = JSON.parse(r.data); } catch {} } }
  return rows;
}

// ---------- AI Workbench (/aiautowork) ----------
// 13 张表 + 默认设置。applyAiautoworkSchema 是幂等的（CREATE TABLE IF NOT EXISTS）；
// 老库升级时无需 ALTER。沿用 try/catch 风格。
applyAiautoworkSchema(db);

// ---------- DevBench Git Controller ----------

function parseGitControllerJson(value, fallback = null) {
  if (value == null || value === "") return fallback;
  if (typeof value !== "string") return value;
  try { return JSON.parse(value); } catch { return fallback; }
}

function stringifyGitControllerJson(value, fallback = {}) {
  if (typeof value === "string") return value;
  return JSON.stringify(value ?? fallback);
}

function mapGitControllerRepository(row) {
  if (!row) return null;
  return {
    repositoryId: row.repository_id,
    remoteId: row.remote_id,
    remoteFingerprint: row.remote_fingerprint,
    baseRealpath: row.base_realpath,
    baseGitCommonRealpath: row.base_git_common_realpath,
    mirrorRealpath: row.mirror_realpath,
    logicalDefinitionIds: parseGitControllerJson(row.logical_definition_ids_json, []),
    allowedBranches: parseGitControllerJson(row.allowed_branches_json, []),
    configDigest: row.config_digest,
    registeredAt: Number(row.registered_at || 0),
    verifiedAt: Number(row.verified_at || 0),
  };
}

export function upsertGitControllerRepository(row = {}) {
  const repositoryId = String(row.repositoryId || "").trim();
  if (!repositoryId) throw new Error("repositoryId is required");
  const now = Math.max(0, Number(row.verifiedAt) || Date.now());
  const existing = db.prepare(
    "SELECT registered_at FROM git_controller_repositories WHERE repository_id = ?",
  ).get(repositoryId);
  db.prepare(`
    INSERT INTO git_controller_repositories (
      repository_id, remote_id, remote_fingerprint, base_realpath, base_git_common_realpath,
      mirror_realpath,
      logical_definition_ids_json, allowed_branches_json, config_digest,
      registered_at, verified_at
    ) VALUES (
      @repository_id, @remote_id, @remote_fingerprint, @base_realpath,
      @base_git_common_realpath, @mirror_realpath,
      @logical_definition_ids_json, @allowed_branches_json, @config_digest,
      @registered_at, @verified_at
    )
    ON CONFLICT(repository_id) DO UPDATE SET
      remote_id = excluded.remote_id,
      remote_fingerprint = excluded.remote_fingerprint,
      base_realpath = excluded.base_realpath,
      base_git_common_realpath = excluded.base_git_common_realpath,
      mirror_realpath = excluded.mirror_realpath,
      logical_definition_ids_json = excluded.logical_definition_ids_json,
      allowed_branches_json = excluded.allowed_branches_json,
      config_digest = excluded.config_digest,
      verified_at = excluded.verified_at
  `).run({
    repository_id: repositoryId,
    remote_id: String(row.remoteId || "origin").trim(),
    remote_fingerprint: String(row.remoteFingerprint || "").trim(),
    base_realpath: String(row.baseRealpath || "").trim(),
    base_git_common_realpath: String(row.baseGitCommonRealpath || "").trim(),
    mirror_realpath: String(row.mirrorRealpath || "").trim(),
    logical_definition_ids_json: stringifyGitControllerJson(row.logicalDefinitionIds, []),
    allowed_branches_json: stringifyGitControllerJson(row.allowedBranches, []),
    config_digest: String(row.configDigest || "").trim(),
    registered_at: Number(existing?.registered_at || row.registeredAt || now),
    verified_at: now,
  });
  return getGitControllerRepository(repositoryId);
}

export function getGitControllerRepository(repositoryId) {
  return mapGitControllerRepository(db.prepare(
    "SELECT * FROM git_controller_repositories WHERE repository_id = ?",
  ).get(String(repositoryId || "").trim()));
}

export function listGitControllerRepositories() {
  return db.prepare("SELECT * FROM git_controller_repositories ORDER BY repository_id")
    .all()
    .map(mapGitControllerRepository);
}

function mapGitControllerMirrorState(row) {
  if (!row) return null;
  return {
    repositoryId: row.repository_id,
    remoteId: row.remote_id,
    branch: row.branch,
    acceptedSha: row.accepted_sha || null,
    sourceRef: row.source_ref,
    generation: Number(row.generation || 0),
    acceptedAt: row.accepted_at == null ? null : Number(row.accepted_at),
    operationId: row.operation_id || null,
    fencingToken: row.fencing_token == null ? null : Number(row.fencing_token),
    remoteFingerprint: row.remote_fingerprint,
  };
}

export function getGitControllerMirrorState(repositoryId, remoteId, branch) {
  return mapGitControllerMirrorState(db.prepare(`
    SELECT * FROM git_controller_mirror_state
    WHERE repository_id = ? AND remote_id = ? AND branch = ?
  `).get(
    String(repositoryId || "").trim(),
    String(remoteId || "").trim(),
    String(branch || "").trim(),
  ));
}

export function compareAndSwapGitControllerMirrorState({
  repositoryId,
  remoteId,
  branch,
  expectedSha = null,
  expectedGeneration = 0,
  acceptedSha,
  sourceRef,
  operationId,
  fencingToken,
  remoteFingerprint,
  acceptedAt = Date.now(),
} = {}) {
  const repo = String(repositoryId || "").trim();
  const remote = String(remoteId || "").trim();
  const branchName = String(branch || "").trim();
  const candidate = String(acceptedSha || "").trim();
  if (!repo || !remote || !branchName || !candidate) {
    return { ok: false, reason: "invalid_mirror_state" };
  }
  const swap = db.transaction(() => {
    const checkedAt = Date.now();
    const activeFence = db.prepare(`
      SELECT l.fencing_token
      FROM git_controller_repository_leases l
      JOIN git_controller_repository_fences f ON f.repository_id = l.repository_id
      WHERE l.repository_id = ? AND l.operation_id = ? AND l.fencing_token = ?
        AND l.expires_at > ? AND f.last_fencing_token = l.fencing_token
    `).get(
      repo,
      String(operationId || "").trim(),
      Number(fencingToken) || 0,
      checkedAt,
    );
    if (!activeFence) return { ok: false, reason: "stale_fencing_token" };
    const current = getGitControllerMirrorState(repo, remote, branchName);
    const actualSha = current?.acceptedSha || null;
    const actualGeneration = Number(current?.generation || 0);
    if (actualSha !== (expectedSha || null) || actualGeneration !== Number(expectedGeneration || 0)) {
      return { ok: false, reason: "compare_and_swap_failed", current };
    }
    const generation = actualGeneration + 1;
    db.prepare(`
      INSERT INTO git_controller_mirror_state (
        repository_id, remote_id, branch, accepted_sha, source_ref, generation,
        accepted_at, operation_id, fencing_token, remote_fingerprint
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(repository_id, remote_id, branch) DO UPDATE SET
        accepted_sha = excluded.accepted_sha,
        source_ref = excluded.source_ref,
        generation = excluded.generation,
        accepted_at = excluded.accepted_at,
        operation_id = excluded.operation_id,
        fencing_token = excluded.fencing_token,
        remote_fingerprint = excluded.remote_fingerprint
    `).run(
      repo,
      remote,
      branchName,
      candidate,
      String(sourceRef || `refs/heads/${branchName}`),
      generation,
      Math.max(0, Number(acceptedAt) || Date.now()),
      String(operationId || "").trim() || null,
      Number(fencingToken) || 0,
      String(remoteFingerprint || "").trim(),
    );
    return {
      ok: true,
      previousSha: actualSha,
      previousGeneration: actualGeneration,
      state: getGitControllerMirrorState(repo, remote, branchName),
    };
  });
  return swap.immediate();
}

function mapGitControllerPreview(row) {
  if (!row) return null;
  return {
    previewId: row.preview_id,
    repositoryId: row.repository_id,
    kind: row.preview_kind,
    branch: row.branch,
    previewVersion: Number(row.preview_version || 0),
    expectedHead: row.expected_head || null,
    candidateSha: row.candidate_sha || null,
    mirrorGeneration: Number(row.mirror_generation || 0),
    relationship: row.relationship,
    eligible: Number(row.eligible || 0) === 1,
    blockerCode: row.blocker_code || null,
    remoteFingerprint: row.remote_fingerprint,
    payload: parseGitControllerJson(row.payload_json, {}),
    status: row.status,
    consumedByOperation: row.consumed_by_operation || null,
    createdAt: Number(row.created_at || 0),
    expiresAt: Number(row.expires_at || 0),
  };
}

export function createGitControllerPreview(row = {}) {
  const repositoryId = String(row.repositoryId || "").trim();
  const kind = String(row.kind || "").trim();
  const branch = String(row.branch || "").trim();
  const previewId = String(row.previewId || "").trim();
  if (!repositoryId || !kind || !branch || !previewId) {
    throw new Error("previewId, repositoryId, kind and branch are required");
  }
  const create = db.transaction(() => {
    const currentVersion = Number(db.prepare(`
      SELECT MAX(preview_version) AS version
      FROM git_controller_previews
      WHERE repository_id = ? AND preview_kind = ? AND branch = ?
    `).get(repositoryId, kind, branch)?.version || 0);
    const previewVersion = currentVersion + 1;
    const createdAt = Math.max(0, Number(row.createdAt) || Date.now());
    db.prepare(`
      INSERT INTO git_controller_previews (
        preview_id, repository_id, preview_kind, branch, preview_version,
        expected_head, candidate_sha, mirror_generation, relationship, eligible,
        blocker_code, remote_fingerprint, payload_json, status,
        consumed_by_operation, created_at, expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ACTIVE', NULL, ?, ?)
    `).run(
      previewId,
      repositoryId,
      kind,
      branch,
      previewVersion,
      String(row.expectedHead || "").trim() || null,
      String(row.candidateSha || "").trim() || null,
      Number(row.mirrorGeneration || 0),
      String(row.relationship || "UNKNOWN"),
      row.eligible === true ? 1 : 0,
      String(row.blockerCode || "").trim() || null,
      String(row.remoteFingerprint || "").trim(),
      stringifyGitControllerJson(row.payload, {}),
      createdAt,
      Math.max(createdAt + 1000, Number(row.expiresAt) || createdAt + 300000),
    );
    return getGitControllerPreview(previewId);
  });
  return create.immediate();
}

export function getGitControllerPreview(previewId) {
  return mapGitControllerPreview(db.prepare(
    "SELECT * FROM git_controller_previews WHERE preview_id = ?",
  ).get(String(previewId || "").trim()));
}

export function consumeGitControllerPreview(previewId, operationId, now = Date.now()) {
  const id = String(previewId || "").trim();
  const operation = String(operationId || "").trim();
  if (!id || !operation) return { ok: false, reason: "invalid_preview" };
  const consume = db.transaction(() => {
    const preview = getGitControllerPreview(id);
    if (!preview) return { ok: false, reason: "not_found" };
    if (preview.status === "CONSUMED" && preview.consumedByOperation === operation) {
      return { ok: true, replay: true, preview };
    }
    if (preview.status !== "ACTIVE") return { ok: false, reason: "already_consumed", preview };
    if (preview.expiresAt <= Math.max(0, Number(now) || Date.now())) {
      db.prepare("UPDATE git_controller_previews SET status = 'EXPIRED' WHERE preview_id = ?")
        .run(id);
      return { ok: false, reason: "expired", preview: getGitControllerPreview(id) };
    }
    const changed = db.prepare(`
      UPDATE git_controller_previews
      SET status = 'CONSUMED', consumed_by_operation = ?
      WHERE preview_id = ? AND status = 'ACTIVE'
    `).run(operation, id).changes;
    if (changed !== 1) return { ok: false, reason: "already_consumed", preview: getGitControllerPreview(id) };
    return { ok: true, replay: false, preview: getGitControllerPreview(id) };
  });
  return consume.immediate();
}

function mapGitControllerOperation(row) {
  if (!row) return null;
  return {
    operationId: row.operation_id,
    repositoryId: row.repository_id,
    operationType: row.operation_type,
    commandId: row.command_id,
    idempotencyKey: row.idempotency_key,
    previewId: row.preview_id || null,
    branch: row.branch,
    expectedHead: row.expected_head || null,
    candidateSha: row.candidate_sha || null,
    status: row.status,
    phase: row.phase,
    resultCode: row.result_code || null,
    result: parseGitControllerJson(row.result_json, null),
    error: parseGitControllerJson(row.error_json, null),
    ownerInstance: row.owner_instance,
    ownerHostname: row.owner_hostname || null,
    ownerPid: row.owner_pid == null ? null : Number(row.owner_pid),
    ownerProcessStartIdentity: row.owner_process_start_identity || null,
    fencingToken: row.fencing_token == null ? null : Number(row.fencing_token),
    startedAt: Number(row.started_at || 0),
    updatedAt: Number(row.updated_at || 0),
    completedAt: row.completed_at == null ? null : Number(row.completed_at),
  };
}

export function getGitControllerOperation(operationId) {
  return mapGitControllerOperation(db.prepare(
    "SELECT * FROM git_controller_operations WHERE operation_id = ?",
  ).get(String(operationId || "").trim()));
}

export function getGitControllerOperationByIdempotency(repositoryId, operationType, idempotencyKey) {
  return mapGitControllerOperation(db.prepare(`
    SELECT * FROM git_controller_operations
    WHERE repository_id = ? AND operation_type = ? AND idempotency_key = ?
  `).get(
    String(repositoryId || "").trim(),
    String(operationType || "").trim(),
    String(idempotencyKey || "").trim(),
  ));
}

export function listGitControllerOperationsByType(operationType, { status } = {}) {
  const type = String(operationType || "").trim();
  const normalizedStatus = String(status || "").trim();
  if (!type) return [];
  const rows = normalizedStatus
    ? db.prepare(`
        SELECT * FROM git_controller_operations
        WHERE operation_type = ? AND status = ?
        ORDER BY completed_at ASC, operation_id ASC
      `).all(type, normalizedStatus)
    : db.prepare(`
        SELECT * FROM git_controller_operations
        WHERE operation_type = ?
        ORDER BY updated_at ASC, operation_id ASC
      `).all(type);
  return rows.map(mapGitControllerOperation);
}

export function beginGitControllerOperation(row = {}) {
  const repositoryId = String(row.repositoryId || "").trim();
  const operationType = String(row.operationType || "").trim();
  const idempotencyKey = String(row.idempotencyKey || "").trim();
  const operationId = String(row.operationId || "").trim();
  if (!repositoryId || !operationType || !idempotencyKey || !operationId) {
    throw new Error("operation identity is required");
  }
  const begin = db.transaction(() => {
    const existing = getGitControllerOperationByIdempotency(
      repositoryId,
      operationType,
      idempotencyKey,
    );
    if (existing) return { created: false, operation: existing };
    const now = Math.max(0, Number(row.startedAt) || Date.now());
    db.prepare(`
      INSERT INTO git_controller_operations (
        operation_id, repository_id, operation_type, command_id, idempotency_key,
        preview_id, branch, expected_head, candidate_sha, status, phase,
        result_code, result_json, error_json, owner_instance, owner_hostname,
        owner_pid, owner_process_start_identity, fencing_token,
        started_at, updated_at, completed_at
      ) VALUES (
        ?, ?, ?, ?, ?, ?, ?, ?, ?, 'RUNNING', ?, NULL, NULL, NULL,
        ?, ?, ?, ?, NULL, ?, ?, NULL
      )
    `).run(
      operationId,
      repositoryId,
      operationType,
      String(row.commandId || operationType).trim(),
      idempotencyKey,
      String(row.previewId || "").trim() || null,
      String(row.branch || "").trim(),
      String(row.expectedHead || "").trim() || null,
      String(row.candidateSha || "").trim() || null,
      String(row.phase || "PREVIEWED"),
      String(row.ownerInstance || "").trim(),
      String(row.ownerHostname || "").trim() || null,
      Number.isInteger(Number(row.ownerPid)) && Number(row.ownerPid) > 0
        ? Number(row.ownerPid)
        : null,
      String(row.ownerProcessStartIdentity || "").trim() || null,
      now,
      now,
    );
    return { created: true, operation: getGitControllerOperation(operationId) };
  });
  return begin.immediate();
}

export function updateGitControllerOperation(operationId, patch = {}) {
  const id = String(operationId || "").trim();
  if (!id) return null;
  const current = getGitControllerOperation(id);
  if (!current) return null;
  const next = {
    status: patch.status ?? current.status,
    phase: patch.phase ?? current.phase,
    resultCode: patch.resultCode ?? current.resultCode,
    resultJson: patch.result === undefined
      ? (current.result == null ? null : stringifyGitControllerJson(current.result))
      : (patch.result == null ? null : stringifyGitControllerJson(patch.result)),
    errorJson: patch.error === undefined
      ? (current.error == null ? null : stringifyGitControllerJson(current.error))
      : (patch.error == null ? null : stringifyGitControllerJson(patch.error)),
    fencingToken: patch.fencingToken ?? current.fencingToken,
    updatedAt: Math.max(0, Number(patch.updatedAt) || Date.now()),
    completedAt: patch.completedAt === undefined ? current.completedAt : patch.completedAt,
  };
  db.prepare(`
    UPDATE git_controller_operations
    SET status = ?, phase = ?, result_code = ?, result_json = ?, error_json = ?,
        fencing_token = ?, updated_at = ?, completed_at = ?
    WHERE operation_id = ?
  `).run(
    next.status,
    next.phase,
    next.resultCode,
    next.resultJson,
    next.errorJson,
    next.fencingToken,
    next.updatedAt,
    next.completedAt,
    id,
  );
  return getGitControllerOperation(id);
}

export function finishGitControllerOperation(operationId, {
  status = "SUCCEEDED",
  phase = "VERIFIED",
  resultCode = "PASS",
  result = null,
  error = null,
  fencingToken,
  completedAt = Date.now(),
} = {}) {
  return updateGitControllerOperation(operationId, {
    status,
    phase,
    resultCode,
    result,
    error,
    fencingToken,
    updatedAt: completedAt,
    completedAt,
  });
}

export function appendGitControllerJournal({
  operationId,
  repositoryId,
  phase,
  fencingToken = null,
  data = {},
  createdAt = Date.now(),
} = {}) {
  const operation = String(operationId || "").trim();
  const repo = String(repositoryId || "").trim();
  const nextPhase = String(phase || "").trim();
  if (!operation || !repo || !nextPhase) throw new Error("journal identity is required");
  const append = db.transaction(() => {
    const at = Math.max(0, Number(createdAt) || Date.now());
    const info = db.prepare(`
      INSERT INTO git_controller_journal (
        operation_id, repository_id, phase, fencing_token, data_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      operation,
      repo,
      nextPhase,
      fencingToken == null ? null : Number(fencingToken),
      stringifyGitControllerJson(data, {}),
      at,
    );
    db.prepare(`
      UPDATE git_controller_operations
      SET phase = ?, fencing_token = COALESCE(?, fencing_token), updated_at = ?
      WHERE operation_id = ?
    `).run(nextPhase, fencingToken == null ? null : Number(fencingToken), at, operation);
    return Number(info.lastInsertRowid);
  });
  return append.immediate();
}

export function stageGitControllerOperationRecovery({
  operationId,
  ownerInstance,
  phase,
  fencingToken,
  result,
  data = {},
  createdAt = Date.now(),
} = {}) {
  const id = String(operationId || "").trim();
  const owner = String(ownerInstance || "").trim();
  const nextPhase = String(phase || "").trim();
  const fence = Number(fencingToken);
  if (
    !id
    || !owner
    || !nextPhase
    || !Number.isSafeInteger(fence)
    || fence < 1
    || !result
    || typeof result !== "object"
    || Array.isArray(result)
  ) {
    return { ok: false, reason: "invalid_recovery_checkpoint" };
  }
  const stage = db.transaction(() => {
    const at = Math.max(0, Number(createdAt) || Date.now());
    const current = getGitControllerOperation(id);
    if (
      !current
      || current.status !== "RUNNING"
      || current.ownerInstance !== owner
    ) {
      return { ok: false, reason: "operation_not_running", operation: current };
    }
    const activeFence = db.prepare(`
      SELECT l.fencing_token
      FROM git_controller_repository_leases l
      JOIN git_controller_repository_fences f ON f.repository_id = l.repository_id
      WHERE l.repository_id = ? AND l.operation_id = ? AND l.owner_instance = ?
        AND l.fencing_token = ? AND l.expires_at > ?
        AND f.last_fencing_token = l.fencing_token
    `).get(
      current.repositoryId,
      id,
      owner,
      fence,
      at,
    );
    if (!activeFence) {
      return { ok: false, reason: "stale_fencing_token", operation: current };
    }
    db.prepare(`
      INSERT INTO git_controller_journal (
        operation_id, repository_id, phase, fencing_token, data_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      id,
      current.repositoryId,
      nextPhase,
      fence,
      stringifyGitControllerJson(data, {}),
      at,
    );
    const changed = db.prepare(`
      UPDATE git_controller_operations
      SET phase = ?, result_json = ?, fencing_token = ?, updated_at = ?
      WHERE operation_id = ? AND status = 'RUNNING' AND owner_instance = ?
    `).run(
      nextPhase,
      stringifyGitControllerJson(result, {}),
      fence,
      at,
      id,
      owner,
    ).changes;
    if (changed !== 1) {
      throw new Error("git controller recovery checkpoint CAS failed");
    }
    return { ok: true, operation: getGitControllerOperation(id) };
  });
  return stage.immediate();
}

export function recoverGitControllerOperation({
  operationId,
  expectedOwnerInstance,
  expectedUpdatedAt,
  status,
  phase,
  resultCode,
  result = null,
  error = null,
  fencingToken = null,
  data = {},
  completedAt = Date.now(),
} = {}) {
  const id = String(operationId || "").trim();
  const owner = String(expectedOwnerInstance || "").trim();
  const terminalStatus = String(status || "").trim();
  const terminalPhase = String(phase || "").trim();
  if (
    !id
    || !owner
    || !["SUCCEEDED", "RECOVERY_REQUIRED"].includes(terminalStatus)
    || !["VERIFIED", "RECOVERY_REQUIRED"].includes(terminalPhase)
  ) {
    return { ok: false, reason: "invalid_recovery_transition" };
  }
  const recover = db.transaction(() => {
    const current = getGitControllerOperation(id);
    if (!current) return { ok: false, reason: "operation_not_found" };
    if (current.status !== "RUNNING") {
      return { ok: false, reason: "operation_not_running", operation: current };
    }
    if (
      current.ownerInstance !== owner
      || (
        expectedUpdatedAt != null
        && current.updatedAt !== Number(expectedUpdatedAt)
      )
    ) {
      return { ok: false, reason: "operation_recovery_cas_failed", operation: current };
    }
    const at = Math.max(0, Number(completedAt) || Date.now());
    db.prepare(`
      INSERT INTO git_controller_journal (
        operation_id, repository_id, phase, fencing_token, data_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      id,
      current.repositoryId,
      terminalPhase,
      fencingToken == null ? current.fencingToken : Number(fencingToken),
      stringifyGitControllerJson(data, {}),
      at,
    );
    const changed = db.prepare(`
      UPDATE git_controller_operations
      SET status = ?, phase = ?, result_code = ?, result_json = ?, error_json = ?,
          fencing_token = COALESCE(?, fencing_token), updated_at = ?, completed_at = ?
      WHERE operation_id = ? AND status = 'RUNNING' AND owner_instance = ?
        AND updated_at = ?
    `).run(
      terminalStatus,
      terminalPhase,
      String(resultCode || "").trim() || null,
      result == null ? null : stringifyGitControllerJson(result, {}),
      error == null ? null : stringifyGitControllerJson(error, {}),
      fencingToken == null ? null : Number(fencingToken),
      at,
      at,
      id,
      owner,
      current.updatedAt,
    ).changes;
    if (changed !== 1) {
      throw new Error("git controller orphan recovery CAS failed");
    }
    return { ok: true, operation: getGitControllerOperation(id) };
  });
  return recover.immediate();
}

export function acknowledgeStoryBaselineRegistryRecovery({
  operationId,
  idempotencyKey,
  registryGeneration,
  entryGeneration,
  appliedAt = Date.now(),
} = {}) {
  const id = String(operationId || "").trim();
  const key = String(idempotencyKey || "").trim();
  if (
    !id
    || !key
    || !Number.isSafeInteger(Number(registryGeneration))
    || Number(registryGeneration) < 1
    || !Number.isSafeInteger(Number(entryGeneration))
    || Number(entryGeneration) < 1
  ) {
    return { ok: false, reason: "invalid_registry_recovery_ack" };
  }
  const acknowledge = db.transaction(() => {
    const current = getGitControllerOperation(id);
    if (
      !current
      || current.status !== "SUCCEEDED"
      || current.idempotencyKey !== key
      || current.result?.registryRecoveryMarker?.operationId !== id
    ) {
      return { ok: false, reason: "operation_not_acknowledgeable", operation: current };
    }
    if (current.result?.registryRecoveryState === "APPLIED") {
      return { ok: true, replay: true, operation: current };
    }
    if (current.result?.registryRecoveryState !== "PENDING") {
      return { ok: false, reason: "registry_recovery_not_pending", operation: current };
    }
    const at = Math.max(0, Number(appliedAt) || Date.now());
    const result = {
      ...current.result,
      registryRecoveryState: "APPLIED",
      registryRecoveryAppliedAt: at,
      registryRecoveryRegistryGeneration: Number(registryGeneration),
      registryRecoveryEntryGeneration: Number(entryGeneration),
    };
    const changed = db.prepare(`
      UPDATE git_controller_operations
      SET result_json = ?, updated_at = ?
      WHERE operation_id = ? AND status = 'SUCCEEDED' AND updated_at = ?
    `).run(
      stringifyGitControllerJson(result, {}),
      at,
      id,
      current.updatedAt,
    ).changes;
    if (changed !== 1) {
      throw new Error("story baseline registry recovery acknowledgement CAS failed");
    }
    return { ok: true, replay: false, operation: getGitControllerOperation(id) };
  });
  return acknowledge.immediate();
}

export function listGitControllerJournal(operationId) {
  return db.prepare(`
    SELECT id, operation_id, repository_id, phase, fencing_token, data_json, created_at
    FROM git_controller_journal
    WHERE operation_id = ?
    ORDER BY id
  `).all(String(operationId || "").trim()).map((row) => ({
    id: Number(row.id),
    operationId: row.operation_id,
    repositoryId: row.repository_id,
    phase: row.phase,
    fencingToken: row.fencing_token == null ? null : Number(row.fencing_token),
    data: parseGitControllerJson(row.data_json, {}),
    createdAt: Number(row.created_at || 0),
  }));
}

export function listGitControllerRecoverableOperations(options = 100) {
  const request = typeof options === "number"
    ? { limit: options }
    : (options && typeof options === "object" ? options : {});
  const clauses = ["status IN ('RUNNING', 'RECOVERY_REQUIRED')"];
  const params = [];
  const operationType = String(request.operationType || "").trim();
  const repositoryId = String(request.repositoryId || "").trim();
  if (operationType) {
    clauses.push("operation_type = ?");
    params.push(operationType);
  }
  if (repositoryId) {
    clauses.push("repository_id = ?");
    params.push(repositoryId);
  }
  const afterUpdatedAt = Number(request.afterUpdatedAt);
  const afterOperationId = String(request.afterOperationId || "").trim();
  if (Number.isFinite(afterUpdatedAt) && afterUpdatedAt >= 0 && afterOperationId) {
    clauses.push("(updated_at > ? OR (updated_at = ? AND operation_id > ?))");
    params.push(afterUpdatedAt, afterUpdatedAt, afterOperationId);
  }
  params.push(Math.max(1, Math.min(1000, Number(request.limit) || 100)));
  return db.prepare(`
    SELECT * FROM git_controller_operations
    WHERE ${clauses.join(" AND ")}
    ORDER BY updated_at ASC, operation_id ASC
    LIMIT ?
  `).all(...params).map(mapGitControllerOperation);
}

export function appendGitControllerAudit({
  auditId,
  operationId,
  repositoryId,
  commandId,
  action,
  branch = null,
  beforeSha = null,
  candidateSha = null,
  result,
  reason = null,
  durationMs = 0,
  fencingToken = null,
  actor = null,
  details = {},
  createdAt = Date.now(),
} = {}) {
  const id = String(auditId || "").trim();
  const operation = String(operationId || "").trim();
  const repo = String(repositoryId || "").trim();
  if (!id || !operation || !repo || !String(commandId || "").trim() || !String(result || "").trim()) {
    throw new Error("audit identity is required");
  }
  db.prepare(`
    INSERT INTO git_controller_audit (
      audit_id, operation_id, repository_id, command_id, action, branch,
      before_sha, candidate_sha, result, reason, duration_ms, fencing_token,
      actor, details_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    operation,
    repo,
    String(commandId).trim(),
    String(action || commandId).trim(),
    String(branch || "").trim() || null,
    String(beforeSha || "").trim() || null,
    String(candidateSha || "").trim() || null,
    String(result).trim(),
    String(reason || "").trim() || null,
    Math.max(0, Number(durationMs) || 0),
    fencingToken == null ? null : Number(fencingToken),
    String(actor || "").trim() || null,
    stringifyGitControllerJson(details, {}),
    Math.max(0, Number(createdAt) || Date.now()),
  );
  return id;
}

export function appendGitControllerAuditOnce(row = {}) {
  const operationId = String(row.operationId || "").trim();
  const action = String(row.action || row.commandId || "").trim();
  const result = String(row.result || "").trim();
  if (!operationId || !action || !result) {
    return { ok: false, reason: "invalid_audit_identity" };
  }
  const append = db.transaction(() => {
    const existing = db.prepare(`
      SELECT audit_id
      FROM git_controller_audit
      WHERE operation_id = ? AND action = ? AND result = ?
      ORDER BY created_at ASC, audit_id ASC
      LIMIT 1
    `).get(operationId, action, result);
    if (existing) {
      return { ok: true, replay: true, auditId: existing.audit_id };
    }
    const auditId = appendGitControllerAudit(row);
    return { ok: true, replay: false, auditId };
  });
  return append.immediate();
}

export function listGitControllerAudit({ repositoryId = "", operationId = "", limit = 200 } = {}) {
  const clauses = [];
  const params = [];
  if (String(repositoryId || "").trim()) {
    clauses.push("repository_id = ?");
    params.push(String(repositoryId).trim());
  }
  if (String(operationId || "").trim()) {
    clauses.push("operation_id = ?");
    params.push(String(operationId).trim());
  }
  params.push(Math.max(1, Math.min(1000, Number(limit) || 200)));
  return db.prepare(`
    SELECT * FROM git_controller_audit
    ${clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""}
    ORDER BY created_at DESC
    LIMIT ?
  `).all(...params).map((row) => ({
    auditId: row.audit_id,
    operationId: row.operation_id,
    repositoryId: row.repository_id,
    commandId: row.command_id,
    action: row.action,
    branch: row.branch || null,
    beforeSha: row.before_sha || null,
    candidateSha: row.candidate_sha || null,
    result: row.result,
    reason: row.reason || null,
    durationMs: Number(row.duration_ms || 0),
    fencingToken: row.fencing_token == null ? null : Number(row.fencing_token),
    actor: row.actor || null,
    details: parseGitControllerJson(row.details_json, {}),
    createdAt: Number(row.created_at || 0),
  }));
}

function mapGitControllerLease(row) {
  if (!row) return null;
  return {
    repositoryId: row.repository_id,
    leaseId: row.lease_id,
    operationId: row.operation_id,
    kind: row.lease_kind,
    ownerInstance: row.owner_instance,
    ownerHostname: row.owner_hostname || null,
    ownerPid: Number(row.owner_pid || 0),
    ownerProcessStartIdentity: row.owner_process_start_identity || null,
    fencingToken: Number(row.fencing_token || 0),
    acquiredAt: Number(row.acquired_at || 0),
    heartbeatAt: Number(row.heartbeat_at || 0),
    expiresAt: Number(row.expires_at || 0),
  };
}

export function claimGitControllerRepositoryLease({
  repositoryId,
  leaseId,
  operationId,
  kind,
  ownerInstance,
  ownerHostname = null,
  ownerPid = process.pid,
  ownerProcessStartIdentity = null,
  now = Date.now(),
  ttlMs = 30000,
} = {}) {
  const repo = String(repositoryId || "").trim();
  const lease = String(leaseId || "").trim();
  const operation = String(operationId || "").trim();
  const leaseKind = String(kind || "").trim();
  const owner = String(ownerInstance || "").trim();
  if (!repo || !lease || !operation || !leaseKind || !owner) {
    return { ok: false, reason: "invalid_lease" };
  }
  const claim = db.transaction(() => {
    const claimedAt = Math.max(0, Number(now) || Date.now());
    const expiresAt = claimedAt + Math.max(1000, Number(ttlMs) || 30000);
    const existingRow = db.prepare(
      "SELECT * FROM git_controller_repository_leases WHERE repository_id = ?",
    ).get(repo);
    const existing = mapGitControllerLease(existingRow);
    if (existing && existing.expiresAt > claimedAt) {
      return { ok: false, reason: "conflict", conflict: existing };
    }
    const lastFence = Number(db.prepare(`
      SELECT last_fencing_token AS token
      FROM git_controller_repository_fences
      WHERE repository_id = ?
    `).get(repo)?.token || 0);
    const fencingToken = Math.max(lastFence, Number(existing?.fencingToken || 0)) + 1;
    db.prepare(`
      INSERT INTO git_controller_repository_fences (repository_id, last_fencing_token, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(repository_id) DO UPDATE SET
        last_fencing_token = excluded.last_fencing_token,
        updated_at = excluded.updated_at
    `).run(repo, fencingToken, claimedAt);
    db.prepare("DELETE FROM git_controller_repository_leases WHERE repository_id = ?").run(repo);
    db.prepare(`
      INSERT INTO git_controller_repository_leases (
        repository_id, lease_id, operation_id, lease_kind, owner_instance,
        owner_hostname, owner_pid, owner_process_start_identity, fencing_token,
        acquired_at, heartbeat_at, expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      repo,
      lease,
      operation,
      leaseKind,
      owner,
      String(ownerHostname || "").trim() || null,
      Number(ownerPid) || 0,
      String(ownerProcessStartIdentity || "").trim() || null,
      fencingToken,
      claimedAt,
      claimedAt,
      expiresAt,
    );
    return {
      ok: true,
      lease: mapGitControllerLease(db.prepare(
        "SELECT * FROM git_controller_repository_leases WHERE repository_id = ?",
      ).get(repo)),
      expiredLease: existing || null,
    };
  });
  return claim.immediate();
}

export function renewGitControllerRepositoryLease({
  repositoryId,
  leaseId,
  ownerInstance,
  fencingToken,
  now = Date.now(),
  ttlMs = 30000,
} = {}) {
  const heartbeatAt = Math.max(0, Number(now) || Date.now());
  const expiresAt = heartbeatAt + Math.max(1000, Number(ttlMs) || 30000);
  const info = db.prepare(`
    UPDATE git_controller_repository_leases
    SET heartbeat_at = ?, expires_at = ?
    WHERE repository_id = ? AND lease_id = ? AND owner_instance = ?
      AND fencing_token = ? AND expires_at > ?
  `).run(
    heartbeatAt,
    expiresAt,
    String(repositoryId || "").trim(),
    String(leaseId || "").trim(),
    String(ownerInstance || "").trim(),
    Number(fencingToken) || 0,
    heartbeatAt,
  );
  return { ok: info.changes === 1, expiresAt, changes: info.changes };
}

export function assertGitControllerRepositoryLease({
  repositoryId,
  leaseId,
  ownerInstance,
  fencingToken,
  now = Date.now(),
} = {}) {
  const row = db.prepare(`
    SELECT l.*, f.last_fencing_token
    FROM git_controller_repository_leases l
    JOIN git_controller_repository_fences f ON f.repository_id = l.repository_id
    WHERE l.repository_id = ? AND l.lease_id = ? AND l.owner_instance = ?
      AND l.fencing_token = ? AND l.expires_at > ?
      AND f.last_fencing_token = l.fencing_token
  `).get(
    String(repositoryId || "").trim(),
    String(leaseId || "").trim(),
    String(ownerInstance || "").trim(),
    Number(fencingToken) || 0,
    Math.max(0, Number(now) || Date.now()),
  );
  return row ? { ok: true, lease: mapGitControllerLease(row) } : { ok: false, reason: "lease_lost" };
}

export function releaseGitControllerRepositoryLease({
  repositoryId,
  leaseId,
  ownerInstance,
  fencingToken,
} = {}) {
  const info = db.prepare(`
    DELETE FROM git_controller_repository_leases
    WHERE repository_id = ? AND lease_id = ? AND owner_instance = ? AND fencing_token = ?
  `).run(
    String(repositoryId || "").trim(),
    String(leaseId || "").trim(),
    String(ownerInstance || "").trim(),
    Number(fencingToken) || 0,
  );
  return { ok: info.changes === 1, changes: info.changes };
}

export function releaseOrphanedGitControllerRepositoryLease({
  repositoryId,
  leaseId,
  operationId,
  ownerInstance,
  ownerPid,
  fencingToken,
} = {}) {
  const info = db.prepare(`
    DELETE FROM git_controller_repository_leases
    WHERE repository_id = ? AND lease_id = ? AND operation_id = ?
      AND owner_instance = ? AND owner_pid = ? AND fencing_token = ?
  `).run(
    String(repositoryId || "").trim(),
    String(leaseId || "").trim(),
    String(operationId || "").trim(),
    String(ownerInstance || "").trim(),
    Number(ownerPid) || 0,
    Number(fencingToken) || 0,
  );
  return { ok: info.changes === 1, changes: info.changes };
}

export function getGitControllerRepositoryLease(repositoryId) {
  return mapGitControllerLease(db.prepare(
    "SELECT * FROM git_controller_repository_leases WHERE repository_id = ?",
  ).get(String(repositoryId || "").trim()));
}

export default db;
