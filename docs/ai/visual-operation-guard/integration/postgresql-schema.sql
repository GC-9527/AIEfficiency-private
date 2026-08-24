-- Optional central persistence for multi-worker or multi-center deployments.
-- Adapt types and naming to the existing AIEfficiency migration framework.
-- Every state transition must run in a database transaction.

CREATE TABLE IF NOT EXISTS ai_visual_guard_task (
    task_id                 VARCHAR(120) PRIMARY KEY,
    source_task_id          VARCHAR(200),
    task_type               VARCHAR(64) NOT NULL,
    mode                    VARCHAR(32) NOT NULL,
    status                  VARCHAR(64) NOT NULL,
    policy_version          VARCHAR(32) NOT NULL,
    operation_map_version   VARCHAR(32),
    checkpoint              TEXT,
    state_json              JSONB NOT NULL,
    version                 BIGINT NOT NULL DEFAULT 1,
    created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ai_visual_guard_task_status
    ON ai_visual_guard_task(status, updated_at);

-- Durable form of pendingAuthorizations, activeExecutions, and completedExecutions.
CREATE TABLE IF NOT EXISTS ai_visual_guard_execution (
    authorization_id        UUID PRIMARY KEY,
    task_id                 VARCHAR(120) NOT NULL REFERENCES ai_visual_guard_task(task_id) ON DELETE CASCADE,
    execution_state         VARCHAR(16) NOT NULL CHECK (execution_state IN ('pending', 'active', 'completed', 'expired', 'cancelled')),
    tool_name               VARCHAR(200) NOT NULL,
    channel                 VARCHAR(40) NOT NULL,
    operation_type          VARCHAR(40) NOT NULL,
    target_id               VARCHAR(200),
    visual_cost_units       NUMERIC(12, 2) NOT NULL DEFAULT 0,
    request_json            JSONB NOT NULL,
    issued_at               TIMESTAMPTZ NOT NULL,
    start_expires_at        TIMESTAMPTZ NOT NULL,
    started_at              TIMESTAMPTZ,
    result_expires_at       TIMESTAMPTZ,
    completed_at            TIMESTAMPTZ,
    replay_expires_at       TIMESTAMPTZ,
    result_digest_sha256    CHAR(64),
    decision_json           JSONB,
    version                 BIGINT NOT NULL DEFAULT 1,
    CONSTRAINT ck_execution_active_fields CHECK (
        execution_state <> 'active' OR (started_at IS NOT NULL AND result_expires_at IS NOT NULL)
    ),
    CONSTRAINT ck_execution_completed_fields CHECK (
        execution_state <> 'completed' OR (
            completed_at IS NOT NULL AND replay_expires_at IS NOT NULL
            AND result_digest_sha256 IS NOT NULL AND decision_json IS NOT NULL
        )
    )
);

CREATE INDEX IF NOT EXISTS idx_ai_visual_guard_execution_task_state
    ON ai_visual_guard_execution(task_id, execution_state, issued_at);

CREATE INDEX IF NOT EXISTS idx_ai_visual_guard_execution_expiry
    ON ai_visual_guard_execution(execution_state, start_expires_at, result_expires_at, replay_expires_at);

CREATE TABLE IF NOT EXISTS ai_visual_guard_event (
    event_id                UUID PRIMARY KEY,
    task_id                 VARCHAR(120) NOT NULL REFERENCES ai_visual_guard_task(task_id) ON DELETE CASCADE,
    event_type              VARCHAR(80) NOT NULL,
    decision_code           VARCHAR(80),
    authorization_id        UUID,
    channel                 VARCHAR(40),
    operation_type          VARCHAR(40),
    visual_cost_units       NUMERIC(12, 2) NOT NULL DEFAULT 0,
    progress                BOOLEAN,
    payload_json            JSONB NOT NULL,
    created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (task_id, authorization_id, event_type)
);

CREATE INDEX IF NOT EXISTS idx_ai_visual_guard_event_task_time
    ON ai_visual_guard_event(task_id, created_at);

CREATE TABLE IF NOT EXISTS ai_operation_strategy_stat (
    project_id              VARCHAR(160) NOT NULL,
    operation_id            VARCHAR(160) NOT NULL,
    strategy_id             VARCHAR(160) NOT NULL,
    success_count           BIGINT NOT NULL DEFAULT 0,
    failure_count           BIGINT NOT NULL DEFAULT 0,
    consecutive_failures    INTEGER NOT NULL DEFAULT 0,
    average_duration_ms     BIGINT,
    last_success_at         TIMESTAMPTZ,
    last_failure_at         TIMESTAMPTZ,
    last_error_code         VARCHAR(120),
    updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (project_id, operation_id, strategy_id)
);

-- Atomic begin example. affected rows must equal 1 before a real tool may run:
-- UPDATE ai_visual_guard_execution
-- SET execution_state = 'active',
--     started_at = NOW(),
--     result_expires_at = NOW() + INTERVAL '1 hour',
--     version = version + 1
-- WHERE authorization_id = :authorization_id
--   AND task_id = :task_id
--   AND execution_state = 'pending'
--   AND start_expires_at > NOW()
-- RETURNING *;
-- A zero-row result means fail-closed: unknown, expired, cancelled, or already consumed.

-- Result transaction outline:
-- 1. SELECT ... FOR UPDATE by authorization_id and task_id.
-- 2. active + result_expires_at > NOW(): compute digest, save completed state and decision once.
-- 3. completed + same digest + replay_expires_at > NOW(): return decision_json without recounting.
-- 4. completed + different digest: reject RESULT_REPLAY_CONFLICT.
-- 5. any other state: reject without changing task counters.

-- Optimistic task update example:
-- UPDATE ai_visual_guard_task
-- SET state_json = :state, status = :status, version = version + 1, updated_at = NOW()
-- WHERE task_id = :task_id AND version = :expected_version;
-- The caller must retry the transaction or reject when affected rows = 0.
