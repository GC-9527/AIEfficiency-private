// AI Workbench (/aiautowork) 基础表与双轨验收 v4.1 的 schema + 迁移。
// 由 gateway/db/sqlite.js 在 import 时直接 exec() 注入。
// 设计原则：与 devbench 共享 SQLite，沿用 try/catch 迁移风格；不要破坏现有 data.db。
//
// 表清单：
//   1. task_drafts                 任务草稿
//   2. batch_creation_jobs         批次作业（最多 100 条）
//   3. batch_task_items            批次内单条任务
//   4. config_candidate_attempts   AI 推导的候选配置版本（V1/V2/V3...）
//   5. validation_issues           校验/复核/预检发现的问题
//   6. manual_intervention_cases   人工介入工单
//   7. resolved_config_snapshots   字段决策合并后的最终配置快照
//   8. story_points                推送/创建出的 devbench 故事点（幂等）
//   9. story_point_config_versions 故事点配置版本变更
//  10. config_audit_events         字段决策/手动覆盖/批量应用审计
//  11. execution_queue             执行队列（4 类并发池）
//  12. aiautowork_settings         11 组设置 + Feature Flag
//  13. review_targets              Git Review 目标（commit/range/branch/MR/PR）
//   +  review_findings              Review 发现问题

import { createHash } from "node:crypto";

const SCHEMA_VERSION = 2;

const TABLES = [
  // 1. 任务草稿
  `CREATE TABLE IF NOT EXISTS task_drafts (
    id TEXT PRIMARY KEY,
    source_type TEXT NOT NULL,                    -- TB | MANUAL | GIT_REVIEW
    source_ref TEXT,                              -- TB单号/GitTargetId/手输来源
    idempotency_key TEXT NOT NULL UNIQUE,         -- sha256:hex
    status TEXT NOT NULL,                         -- INPUT_PARSED/INVALID_INPUT/DUPLICATE/DRAFT_CREATED/...
    raw_input TEXT,                               -- 原始 JSON
    normalized_input TEXT,                        -- 规范化后 JSON
    config_fingerprint TEXT,                      -- 配置指纹，用于分组
    source_priority TEXT DEFAULT 'normal',        -- low|normal|high|urgent
    created_by TEXT,
    node TEXT,
    created_at TEXT DEFAULT (datetime('now','localtime')),
    updated_at TEXT DEFAULT (datetime('now','localtime')),
    finalized_at TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS idx_task_drafts_status ON task_drafts(status, updated_at)`,
  `CREATE INDEX IF NOT EXISTS idx_task_drafts_source ON task_drafts(source_type, source_ref)`,
  `CREATE INDEX IF NOT EXISTS idx_task_drafts_fp ON task_drafts(config_fingerprint)`,

  // 2. 批次作业
  `CREATE TABLE IF NOT EXISTS batch_creation_jobs (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT,
    config_template TEXT,                         -- 模板 JSON
    total INTEGER NOT NULL DEFAULT 0,
    completed INTEGER NOT NULL DEFAULT 0,
    failed INTEGER NOT NULL DEFAULT 0,
    skipped INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'pending',       -- pending|queued|running|paused|completed|failed|cancelled
    pause_reason TEXT,
    created_by TEXT,
    node TEXT,
    created_at TEXT DEFAULT (datetime('now','localtime')),
    started_at TEXT,
    finished_at TEXT,
    updated_at TEXT DEFAULT (datetime('now','localtime'))
  )`,
  `CREATE INDEX IF NOT EXISTS idx_batch_jobs_status ON batch_creation_jobs(status, updated_at)`,

  // 3. 批次内单条
  `CREATE TABLE IF NOT EXISTS batch_task_items (
    id TEXT PRIMARY KEY,
    batch_id TEXT NOT NULL,
    task_draft_id TEXT,
    status TEXT NOT NULL,                         -- 同 task_drafts 状态机的子集 + batch 内部状态
    attempts INTEGER NOT NULL DEFAULT 0,
    priority INTEGER NOT NULL DEFAULT 5,          -- 1=最高，10=最低
    pool TEXT,                                    -- inference|validation|reviewer|execution
    last_error TEXT,
    last_progress_at TEXT,
    queued_at TEXT,
    started_at TEXT,
    finished_at TEXT,
    created_at TEXT DEFAULT (datetime('now','localtime')),
    updated_at TEXT DEFAULT (datetime('now','localtime'))
  )`,
  `CREATE INDEX IF NOT EXISTS idx_batch_items_batch ON batch_task_items(batch_id, status)`,
  `CREATE INDEX IF NOT EXISTS idx_batch_items_draft ON batch_task_items(task_draft_id)`,
  `CREATE INDEX IF NOT EXISTS idx_batch_items_pool ON batch_task_items(pool, status, priority)`,

  // 4. AI 候选版本
  `CREATE TABLE IF NOT EXISTS config_candidate_attempts (
    id TEXT PRIMARY KEY,
    task_draft_id TEXT NOT NULL,
    version INTEGER NOT NULL,                     -- 1,2,3,...
    inferrer_engine TEXT,                         -- claude|gemini|codex|qwen|...
    inferrer_model TEXT,
    status TEXT NOT NULL,                         -- pending|running|generated|rejected|selected|superseded
    signals_json TEXT,                            -- 7 维评分
    decisions_json TEXT,                          -- 字段决策
    candidate_json TEXT,                          -- 候选配置 JSON
    evidence_json TEXT,                           -- 证据摘要
    score_overall REAL,
    score_critical_minimum REAL,
    auto_fixable_count INTEGER DEFAULT 0,
    blocker_count INTEGER DEFAULT 0,
    error_message TEXT,
    started_at TEXT,
    finished_at TEXT,
    created_at TEXT DEFAULT (datetime('now','localtime'))
  )`,
  `CREATE INDEX IF NOT EXISTS idx_candidate_draft ON config_candidate_attempts(task_draft_id, version)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS ux_candidate_draft_version ON config_candidate_attempts(task_draft_id, version)`,

  // 5. 校验/复核/预检问题
  `CREATE TABLE IF NOT EXISTS validation_issues (
    id TEXT PRIMARY KEY,
    task_draft_id TEXT NOT NULL,
    candidate_id TEXT,
    stage TEXT NOT NULL,                          -- validator|reviewer|preflight
    severity TEXT NOT NULL,                       -- blocker|error|warn|info
    code TEXT NOT NULL,                           -- 错误码
    field_key TEXT,                               -- 关联字段
    message TEXT NOT NULL,
    auto_fixable INTEGER NOT NULL DEFAULT 0,
    fixed INTEGER NOT NULL DEFAULT 0,
    fix_strategy TEXT,                            -- 修复策略名
    created_at TEXT DEFAULT (datetime('now','localtime')),
    resolved_at TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS idx_issues_draft ON validation_issues(task_draft_id, stage)`,
  `CREATE INDEX IF NOT EXISTS idx_issues_candidate ON validation_issues(candidate_id, severity)`,
  `CREATE INDEX IF NOT EXISTS idx_issues_code ON validation_issues(code, severity)`,

  // 6. 人工介入
  `CREATE TABLE IF NOT EXISTS manual_intervention_cases (
    id TEXT PRIMARY KEY,
    task_draft_id TEXT NOT NULL,
    opened_reason TEXT,
    opened_by TEXT,
    assigned_to TEXT,
    status TEXT NOT NULL DEFAULT 'open',          -- open|in_progress|resolved|abandoned
    reason_code TEXT,
    payload_json TEXT,
    notes TEXT,
    opened_at TEXT DEFAULT (datetime('now','localtime')),
    updated_at TEXT DEFAULT (datetime('now','localtime')),
    resolved_at TEXT,
    resolved_by TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS idx_manual_draft ON manual_intervention_cases(task_draft_id)`,
  `CREATE INDEX IF NOT EXISTS idx_manual_status ON manual_intervention_cases(status, opened_at)`,

  // 7. 最终配置快照
  `CREATE TABLE IF NOT EXISTS resolved_config_snapshots (
    id TEXT PRIMARY KEY,
    task_draft_id TEXT NOT NULL,
    candidate_id TEXT,
    fingerprint TEXT,                             -- 与 task_drafts.config_fingerprint 对应
    decisions_json TEXT,                          -- 字段决策（adopt/override/ignore/lock/unlock）
    evidence_json TEXT,
    snapshot_json TEXT NOT NULL,                  -- 最终生效配置
    score_overall REAL,
    created_by TEXT,                              -- USER|AI|AUTO
    created_at TEXT DEFAULT (datetime('now','localtime'))
  )`,
  `CREATE INDEX IF NOT EXISTS idx_snapshot_draft ON resolved_config_snapshots(task_draft_id, created_at)`,
  `CREATE INDEX IF NOT EXISTS idx_snapshot_fp ON resolved_config_snapshots(fingerprint)`,

  // 8. 故事点（与 devbench 关联，幂等）
  `CREATE TABLE IF NOT EXISTS story_points (
    id TEXT PRIMARY KEY,
    task_draft_id TEXT NOT NULL,
    devbench_story_id TEXT,
    devbench_session_id TEXT,
    idempotency_key TEXT NOT NULL UNIQUE,
    status TEXT NOT NULL,                         -- PENDING|CREATING|CREATED|CREATE_FAILED|CANCELLED
    error_message TEXT,
    last_event_at TEXT,
    created_at TEXT DEFAULT (datetime('now','localtime')),
    finalized_at TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS idx_story_draft ON story_points(task_draft_id)`,
  `CREATE INDEX IF NOT EXISTS idx_story_devbench ON story_points(devbench_story_id)`,
  `CREATE INDEX IF NOT EXISTS idx_story_status ON story_points(status, last_event_at)`,

  // 9. 故事点配置版本
  `CREATE TABLE IF NOT EXISTS story_point_config_versions (
    id TEXT PRIMARY KEY,
    story_point_id TEXT NOT NULL,
    version INTEGER NOT NULL,
    snapshot_id TEXT,
    diff_json TEXT,
    created_at TEXT DEFAULT (datetime('now','localtime')),
    created_by TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS idx_spv_story ON story_point_config_versions(story_point_id, version)`,

  // 10. 配置审计
  `CREATE TABLE IF NOT EXISTS config_audit_events (
    id TEXT PRIMARY KEY,
    actor TEXT,
    action TEXT NOT NULL,                         -- decision_apply|lock_field|unlock_field|group_confirm|bulk_apply|risk_accept|policy_change|...
    target_type TEXT,                             -- task_draft|snapshot|batch|setting
    target_id TEXT,
    before_json TEXT,
    after_json TEXT,
    reason TEXT,
    ts INTEGER DEFAULT (strftime('%s','now'))
  )`,
  `CREATE INDEX IF NOT EXISTS idx_audit_actor ON config_audit_events(actor, ts)`,
  `CREATE INDEX IF NOT EXISTS idx_audit_target ON config_audit_events(target_type, target_id, ts)`,

  // 11. 执行队列
  `CREATE TABLE IF NOT EXISTS execution_queue (
    id TEXT PRIMARY KEY,
    task_draft_id TEXT,
    batch_item_id TEXT,
    priority INTEGER NOT NULL DEFAULT 5,
    pool TEXT NOT NULL,                           -- inference|validation|reviewer|execution
    status TEXT NOT NULL DEFAULT 'queued',        -- queued|running|paused|completed|failed|cancelled
    queue_reason TEXT,
    lease_token TEXT,
    owner_instance TEXT,
    heartbeat_at INTEGER,
    expires_at INTEGER,
    enqueued_at INTEGER DEFAULT (strftime('%s','now')),
    started_at INTEGER,
    finished_at INTEGER,
    payload_json TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS idx_queue_pool ON execution_queue(pool, status, priority, enqueued_at)`,
  `CREATE INDEX IF NOT EXISTS idx_queue_draft ON execution_queue(task_draft_id)`,

  // 12. 设置
  `CREATE TABLE IF NOT EXISTS aiautowork_settings (
    key TEXT PRIMARY KEY,
    value_json TEXT,
    description TEXT,
    updated_by TEXT,
    updated_at TEXT DEFAULT (datetime('now','localtime'))
  )`,

  // 13. Review 目标
  `CREATE TABLE IF NOT EXISTS review_targets (
    id TEXT PRIMARY KEY,
    source_type TEXT NOT NULL,                    -- COMMIT|RANGE|BRANCH|MR|PR
    repo_id TEXT,
    target_ref TEXT,                              -- commit sha / range / branch / mr id
    base_ref TEXT,
    title TEXT,
    state TEXT NOT NULL DEFAULT 'open',           -- open|in_review|completed|abandoned
    last_synced_at TEXT,
    findings_count INTEGER DEFAULT 0,
    blocker_count INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now','localtime')),
    updated_at TEXT DEFAULT (datetime('now','localtime'))
  )`,
  `CREATE INDEX IF NOT EXISTS idx_review_state ON review_targets(state, updated_at)`,

  // 14. Review 发现
  `CREATE TABLE IF NOT EXISTS review_findings (
    id TEXT PRIMARY KEY,
    review_target_id TEXT NOT NULL,
    severity TEXT NOT NULL,                       -- blocker|high|medium|low|info
    code TEXT,
    file_path TEXT,
    line_number INTEGER,
    title TEXT NOT NULL,
    detail TEXT,
    state TEXT NOT NULL DEFAULT 'open',           -- open|accepted|fixed|wontfix|false_positive
    assigned_to TEXT,
    created_at TEXT DEFAULT (datetime('now','localtime')),
    updated_at TEXT DEFAULT (datetime('now','localtime')),
    resolved_at TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS idx_findings_target ON review_findings(review_target_id, state)`,
  `CREATE INDEX IF NOT EXISTS idx_findings_state ON review_findings(state, severity)`,

  // 15. 双轨验收路由上下文。上下文只描述“验收谁”，不承载最终 PASS。
  `CREATE TABLE IF NOT EXISTS acceptance_contexts (
    id TEXT PRIMARY KEY,
    context_key TEXT NOT NULL UNIQUE,
    protocol_version TEXT NOT NULL,
    route_status TEXT NOT NULL,
    task_origin TEXT,
    scope_kind TEXT,
    change_type TEXT NOT NULL,
    risk_tier TEXT,
    project_task_id TEXT,
    story_point_id TEXT,
    source_snapshot_hash TEXT,
    routing_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_acceptance_context_project ON acceptance_contexts(project_task_id, updated_at)`,
  `CREATE INDEX IF NOT EXISTS idx_acceptance_context_story ON acceptance_contexts(story_point_id, updated_at)`,

  // 16. Canonical StoryPoint 的不可变来源快照。同一 hash 永不覆盖。
  `CREATE TABLE IF NOT EXISTS story_source_snapshots (
    id TEXT PRIMARY KEY,
    story_point_id TEXT NOT NULL,
    snapshot_hash TEXT NOT NULL,
    mapping_version TEXT NOT NULL,
    canonical_json TEXT NOT NULL,
    fetched_at TEXT NOT NULL,
    superseded_by TEXT,
    created_at TEXT NOT NULL,
    UNIQUE(story_point_id, snapshot_hash)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_story_source_snapshot_story ON story_source_snapshots(story_point_id, created_at)`,

  // 17. 工程轨和故事点轨各自持有 run；DUAL_SCOPE 会创建两行而不是一个混合 PASS。
  `CREATE TABLE IF NOT EXISTS acceptance_runs (
    id TEXT PRIMARY KEY,
    context_id TEXT NOT NULL,
    protocol TEXT NOT NULL,
    mode_or_tier TEXT NOT NULL,
    track_group_id TEXT,
    status TEXT NOT NULL DEFAULT 'CREATED',
    candidate_identity_hash TEXT,
    candidate_json TEXT NOT NULL DEFAULT '{}',
    source_snapshot_hash TEXT,
    environment_id TEXT,
    gates_json TEXT NOT NULL DEFAULT '[]',
    claims_json TEXT NOT NULL DEFAULT '[]',
    impact_matrix_json TEXT NOT NULL DEFAULT '{}',
    findings_json TEXT NOT NULL DEFAULT '[]',
    unknowns_json TEXT NOT NULL DEFAULT '[]',
    residual_risks_json TEXT NOT NULL DEFAULT '[]',
    repair_rounds INTEGER NOT NULL DEFAULT 0,
    project_change_decision TEXT NOT NULL DEFAULT 'NOT_ASSESSED',
    production_readiness TEXT NOT NULL DEFAULT 'NOT_ASSESSED',
    story_point_decision TEXT NOT NULL DEFAULT 'NOT_APPLICABLE',
    source_sync_decision TEXT NOT NULL DEFAULT 'DENIED',
    source_sync_status TEXT NOT NULL DEFAULT 'NOT_ATTEMPTED',
    candidate_evidence_consistent INTEGER,
    candidate_consistency_reasons_json TEXT NOT NULL DEFAULT '[]',
    supersedes_run_id TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_acceptance_runs_context ON acceptance_runs(context_id, created_at)`,
  `CREATE INDEX IF NOT EXISTS idx_acceptance_runs_protocol_status ON acceptance_runs(protocol, status, updated_at)`,

  // 18. 非 LLM 原始证据索引；内容可留在外部 evidence store，仅保存不可变绑定。
  `CREATE TABLE IF NOT EXISTS acceptance_evidence (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    gate_id TEXT,
    kind TEXT NOT NULL,
    uri TEXT,
    sha256 TEXT,
    candidate_identity_hash TEXT,
    source_snapshot_hash TEXT,
    environment_id TEXT,
    command_text TEXT,
    exit_code INTEGER,
    trust_level TEXT NOT NULL DEFAULT 'UNVERIFIED',
    producer TEXT,
    observed_at TEXT NOT NULL,
    metadata_json TEXT NOT NULL DEFAULT '{}'
  )`,
  `CREATE INDEX IF NOT EXISTS idx_acceptance_evidence_run ON acceptance_evidence(run_id, gate_id, observed_at)`,

  // 19. 精准失效缓存。input_hash 绑定候选/来源/环境；旧结果只可在 hash 相同时复用。
  `CREATE TABLE IF NOT EXISTS acceptance_gate_cache (
    cache_key TEXT PRIMARY KEY,
    protocol TEXT NOT NULL,
    gate_id TEXT NOT NULL,
    input_hash TEXT NOT NULL,
    result TEXT NOT NULL,
    evidence_ids_json TEXT NOT NULL DEFAULT '[]',
    invalidated_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_acceptance_gate_cache_lookup ON acceptance_gate_cache(protocol, gate_id, input_hash, invalidated_at)`,

  // 20. UI/审计事件。只追加，不作为结论的替代证据。
  `CREATE TABLE IF NOT EXISTS acceptance_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id TEXT NOT NULL,
    event_type TEXT NOT NULL,
    payload_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_acceptance_events_run ON acceptance_events(run_id, id)`,
];

// 默认设置
export const DEFAULT_SETTINGS = {
  "concurrency.inference": { value: 6, description: "AI 推导并发池" },
  "concurrency.validation": { value: 10, description: "Validator 校验并发池" },
  "concurrency.reviewer": { value: 4, description: "Reviewer 独立复核并发池" },
  "concurrency.execution": { value: 5, description: "StoryPoint 执行并发池" },
  "routing.autoReady.overall": { value: 88, description: "AUTO_READY 整体分数阈值" },
  "routing.autoReady.criticalMin": { value: 75, description: "AUTO_READY 关键最低分阈值" },
  "routing.groupConfirm.overallMin": { value: 70, description: "GROUP_CONFIRM 整体分数下界" },
  "routing.manual.criticalMax": { value: 60, description: "MANUAL 关键分上界" },
  "repair.maxAttempts": { value: 5, description: "自动修复最大尝试次数" },
  "batch.maxItems": { value: 100, description: "单批次最大任务数" },
  "feature.enabled": { value: false, description: "AI 工作台全局开关" },
  "feature.batch.enabled": { value: true, description: "批量处理" },
  "feature.configInference.enabled": { value: true, description: "AI 配置解析" },
  "feature.autoRepair.enabled": { value: true, description: "自动修复" },
  "feature.manualIntervention.enabled": { value: true, description: "人工介入" },
  "permissions.allowBatch": { value: ["admin"], description: "可发起批量" },
  "permissions.allowManual": { value: ["admin", "user"], description: "可处理人工介入" },
  "permissions.allowPublish": { value: ["admin"], description: "可发布生产（沿用 devbench）" },
  "notifications.dingtalk": { value: { enabled: false, webhook: "" }, description: "钉钉通知" },
  "audit.enabled": { value: true, description: "审计开关" },
  "acceptance.mode": { value: "REPORT_ONLY", description: "双轨验收灰度模式：默认只报告，不改变旧判定" },
  "acceptance.protocolVersion": { value: "4.1", description: "双轨验收协议版本" },
  "acceptance.autoSourceSync.enabled": { value: false, description: "来源自动回写，灰度期保持关闭" },
  "acceptance.maxRepairRounds": { value: 2, description: "每条验收轨最多自动修复轮数" },
};

export function applyAiautoworkSchema(db) {
  for (const sql of TABLES) {
    db.exec(sql);
  }
  // 兼容曾短暂启动过 v4.1 preview schema 的本地数据库。
  try { db.exec("ALTER TABLE acceptance_evidence ADD COLUMN trust_level TEXT NOT NULL DEFAULT 'UNVERIFIED'"); } catch {}
  try { db.exec("ALTER TABLE acceptance_evidence ADD COLUMN producer TEXT"); } catch {}
  try { db.exec("ALTER TABLE acceptance_runs ADD COLUMN candidate_evidence_consistent INTEGER"); } catch {}
  try { db.exec("ALTER TABLE acceptance_runs ADD COLUMN candidate_consistency_reasons_json TEXT NOT NULL DEFAULT '[]'"); } catch {}
  try { db.exec("ALTER TABLE acceptance_runs ADD COLUMN track_group_id TEXT"); } catch {}
  try { db.exec("CREATE INDEX IF NOT EXISTS idx_acceptance_runs_track_group ON acceptance_runs(track_group_id, protocol, updated_at)"); } catch {}
  // 写入默认设置
  const insertStmt = db.prepare(`
    INSERT OR IGNORE INTO aiautowork_settings (key, value_json, description)
    VALUES (@key, @valueJson, @description)
  `);
  const tx = db.transaction((entries) => {
    for (const [key, { value, description }] of entries) {
      insertStmt.run({
        key,
        valueJson: typeof value === "string" ? value : JSON.stringify(value),
        description: description || "",
      });
    }
  });
  tx(Object.entries(DEFAULT_SETTINGS));

  // 写一次 schema_version 记录
  const upsert = db.prepare(`
    INSERT INTO aiautowork_settings (key, value_json, description)
    VALUES ('schema.version', @v, 'AI Workbench 数据库 schema 版本')
    ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json, updated_at=datetime('now','localtime')
  `);
  upsert.run({ v: JSON.stringify(SCHEMA_VERSION) });
}

// 幂等键生成：规范化输入 + sourceType + sourceRef + 关键字段哈希 + 策略版本
export function computeIdempotencyKey({ sourceType, sourceRef, normalizedInput, configHash, policyVersion }) {
  const norm = typeof normalizedInput === "string" ? normalizedInput : JSON.stringify(normalizedInput || {});
  const parts = [sourceType || "", sourceRef || "", norm, configHash || "", policyVersion || "1"];
  return "sha256:" + createHash("sha256").update(parts.join("|")).digest("hex");
}

export { SCHEMA_VERSION };
