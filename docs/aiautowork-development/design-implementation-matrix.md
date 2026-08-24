# 设计 ↔ 实现 矩阵

> 里程碑 0 交付物 · 详细把每条设计要求落到代码位置
> 单元：设计条目 × 实现位置（含文件路径、行号区间或"待新增"）

## 1. 路由（Web 端）

| 设计路由 | 现状 | 实现文件 |
|----------|------|----------|
| `/aiautowork` | 无 | **新增** `web-dashboard/src/pages/aiautowork/Overview.jsx` |
| `/aiautowork/batches` | 无 | **新增** `web-dashboard/src/pages/aiautowork/Batches.jsx` |
| `/aiautowork/batches/:batchId` | 无 | **新增** `web-dashboard/src/pages/aiautowork/BatchDetail.jsx` |
| `/aiautowork/confirmations` | 无 | **新增** `web-dashboard/src/pages/aiautowork/Confirmations.jsx` |
| `/aiautowork/settings` | 无 | **新增** `web-dashboard/src/pages/aiautowork/Settings.jsx` |
| `/devbench` | 有 | 不动（`web-dashboard/src/pages/devbench/index.jsx`） |
| 路由注册 | `web-dashboard/src/App.jsx` | **新增** `<Route path="/aiautowork/*">` 5 条 |

## 2. 后端路由（HTTP API）

| 路径 | 方法 | 实现位置 |
|------|------|----------|
| `/api/aiautowork/overview` | GET | `gateway/routes/aiautowork.js#overview` |
| `/api/aiautowork/task-drafts` | POST/GET | `…#taskDrafts` |
| `/api/aiautowork/task-drafts/:id` | GET/PATCH | `…#taskDraftItem` |
| `/api/aiautowork/task-drafts/:id/parse` | POST | `…#parseTaskDraft` |
| `/api/aiautowork/task-drafts/:id/infer` | POST | `…#inferCandidate` |
| `/api/aiautowork/task-drafts/:id/review` | POST | `…#reviewCandidate` |
| `/api/aiautowork/task-drafts/:id/repair` | POST | `…#repairCandidate` |
| `/api/aiautowork/task-drafts/:id/decisions` | PUT | `…#updateDecisions` |
| `/api/aiautowork/task-drafts/:id/preflight` | POST | `…#runPreflight` |
| `/api/aiautowork/task-drafts/:id/create` | POST | `…#createStoryPoint` |
| `/api/aiautowork/batches` | POST/GET | `…#batches` |
| `/api/aiautowork/batches/:id` | GET | `…#batchItem` |
| `/api/aiautowork/batches/:id/pause` | POST | `…#pauseBatch` |
| `/api/aiautowork/batches/:id/resume` | POST | `…#resumeBatch` |
| `/api/aiautowork/batches/:id/cancel` | POST | `…#cancelBatch` |
| `/api/aiautowork/batches/:id/items` | GET | `…#batchItems`（支持游标/分页） |
| `/api/aiautowork/confirmations` | GET | `…#listConfirmations` |
| `/api/aiautowork/confirmations/:id/confirm` | POST | `…#confirmGroup` |
| `/api/aiautowork/confirmations/:id/edit` | POST | `…#editAndConfirm` |
| `/api/aiautowork/manual-cases` | GET | `…#listManualCases` |
| `/api/aiautowork/manual-cases/:id/edit` | POST | `…#editManualCase` |
| `/api/aiautowork/execution-queue` | GET | `…#listExecutionQueue` |
| `/api/aiautowork/tb-sources` | GET/PUT | `…#tbSources` |
| `/api/aiautowork/git-sources` | GET/PUT | `…#gitSources` |
| `/api/aiautowork/review-targets` | GET/POST | `…#reviewTargets` |
| `/api/aiautowork/findings` | GET/PATCH | `…#findings` |
| `/api/aiautowork/settings` | GET/PUT | `…#settings` |
| `/api/aiautowork/audit` | GET | `…#audit` |
| `/api/aiautowork/health` | GET | `…#health` |

注册入口：`gateway/server.js` 加 `app.use("/api/aiautowork", aiautoworkRouter)`。

## 3. 数据库表（13 张新表）

| 表 | 列 | 位置 |
|----|------|------|
| `task_drafts` | id, source_type, source_ref, idempotency_key, status, raw_input, normalized_input, created_by, created_at, updated_at, finalized_at | `gateway/db/aiautowork-schema.js` |
| `batch_creation_jobs` | id, name, total, completed, failed, status, created_by, created_at, started_at, finished_at, config_template | 同上 |
| `batch_task_items` | id, batch_id, task_draft_id, status, attempts, last_error, priority, queued_at, started_at, finished_at | 同上 |
| `config_candidate_attempts` | id, task_draft_id, version, inferrer_engine, signals_json, decisions_json, status, created_at, score_overall | 同上 |
| `validation_issues` | id, task_draft_id, candidate_id, stage (validator/reviewer/preflight), severity (blocker/error/warn), code, message, field_key, auto_fixable, created_at | 同上 |
| `manual_intervention_cases` | id, task_draft_id, opened_by, opened_at, status (open/in_progress/resolved/abandoned), reason_code, payload_json | 同上 |
| `resolved_config_snapshots` | id, task_draft_id, candidate_id, decisions_json, evidence_json, fingerprint, created_by, created_at | 同上 |
| `story_points` | id, task_draft_id, devbench_story_id, idempotency_key, status, created_at | 同上 |
| `story_point_config_versions` | id, story_point_id, version, snapshot_id, diff_json, created_at | 同上 |
| `config_audit_events` | id, actor, action, target_type, target_id, before_json, after_json, reason, ts | 同上 |
| `execution_queue` | id, task_draft_id, priority, pool, status, reason, enqueued_at, started_at, finished_at | 同上 |
| `resource_locks` | 复用 `worktree_resource_leases` 表，新增 `kind='ai_workbench'` 行 | 已存在 |
| `aiautowork_settings` | key, value_json, updated_by, updated_at | `gateway/db/aiautowork-schema.js` |

## 4. 业务服务文件（`gateway/services/aiautowork/`）

| 服务 | 文件 | 职责 |
|------|------|------|
| 入口 | `index.js` | 装配服务 + 调度器 |
| 数据访问 | `store.js` | 13 表的 CRUD |
| 任务草稿 | `task-draft.js` | 输入解析、规范化、idempotencyKey、状态机 |
| 数据源 | `sources/index.js` `sources/tb.js` `sources/git.js` `sources/manual.js` | 多源适配器 |
| 推导 | `inference.js` | 调 AI 生成候选版本 |
| 校验 | `validator.js` | 确定性校验（必填/枚举/分支存在） |
| 复核 | `reviewer.js` | 独立一致（多视角打分） |
| 修复 | `repair.js` | 按 issue 调修复策略（≤5） |
| 决策 | `decisions.js` | 字段决策合并器（userLock > manualSelect > aiInfer > default） |
| 预检 | `preflight.js` | 最后闸门 |
| 评分 | `readiness.js` | 7 维 signals 计算 |
| 路由 | `routing.js` | AUTO_READY / GROUP_CONFIRM / MANUAL 三档 |
| 批次 | `batch.js` | 100 条任务编排 |
| 队列 | `queue.js` | 优先级 + 4 类池 |
| 锁 | `resource-lock.js` | 包装 worktree_resource_leases |
| 分组 | `grouping.js` | 指纹算法 + 批量应用 |
| 故事点 | `story-point.js` | 调 tb-workflow.startDev 幂等创建 |
| 配置记忆 | 复用 `devbench/config-memory.js` | 直接调用 |
| 教训 | 复用 `devbench/lessons.js` | 直接调用 |
| WebSocket | `ws-bridge.js` | 行级 patch 推送 |
| 设置 | `settings.js` | 11 组配置 + 权限 + Feature Flag |
| 审计 | `audit.js` | 包装 admin_audit 表 |
| 指标 | `metrics.js` | 计数 + 仪表盘数据 |
| 适配器 | `git-adapter.js` `tb-adapter.js` | 包装 codeup/teambition |
| Review | `review-targets.js` `findings.js` | 包装 code-review-report |
| 错误码 | `error-codes.js` | 集中常量 |

## 5. 前端组件文件（`web-dashboard/src/pages/aiautowork/`）

| 组件 | 路径 |
|------|------|
| Layout | `Layout.jsx`（侧栏 4 一级 + 顶栏 + 场景切换） |
| Overview | `Overview.jsx`（7 子视图） |
| Batches | `Batches.jsx` |
| BatchDetail | `BatchDetail.jsx`（含 100 条虚拟滚动表） |
| Confirmations | `Confirmations.jsx` |
| Settings | `Settings.jsx`（11 组折叠面板） |
| 公共组件 | `components/StatusBadge.jsx` `SourceBadge.jsx` `ReadinessScore.jsx` `WorkflowProgress.jsx` `DenseDataTable.jsx` `TaskDrawer.jsx` `ConfigDiffGrid.jsx` `EvidenceSummary.jsx` `PreflightList.jsx` `CandidateTimeline.jsx` `BatchActionBar.jsx` `BatchFillDialog.jsx` `ConcurrencyControl.jsx` |
| 模型层 | `models/*.mjs`（每个组件对应一个 mjs，纯函数 + 单测） |
| API 层 | `api.js`（与 gateway.js 风格一致） |

## 6. 关键算法

| 算法 | 文件 | 输入 | 输出 |
|------|------|------|------|
| 幂等键生成 | `task-draft.js#computeIdempotencyKey` | `{sourceType, rawInput, tbIdOrGitTarget, configHash, policyVersion}` | `sha256:hex` |
| 7 维评分 | `readiness.js#computeSignals` | candidate + issues | `{overall, criticalMinimum, fieldScores, evidenceCoverage, deterministicCheck, independentAgreement, metadataValidity}` |
| 三档路由 | `routing.js#routeBySignals` | signals | `AUTO_READY`/`GROUP_CONFIRM`/`MANUAL` |
| 修复循环 | `repair.js#repairLoop` | taskDraft + issues | `≤5` 次后返回 bestCandidate |
| 字段决策合并 | `decisions.js#mergeDecisions` | userLock + manual + ai + default | resolved snapshot |
| 指纹分组 | `grouping.js#fingerprint` | resolved snapshot | `sha256:hex` |
| 批量应用 | `grouping.js#applyGroupDecision` | groupId + decision | updates many items |
| 预检闸门 | `preflight.js#runPreflight` | resolved snapshot | `pass`/`fail` + issues |
| 故事点创建 | `story-point.js#createStoryPoint` | taskDraft + snapshot | devbench story point id (幂等) |
| 资源锁 | `resource-lock.js#claimAiWorkbench` | resourceKey | `{leaseToken, expiresAt}` |

## 7. 实施顺序

1. **里程碑 1**（基础框架）：路由 + 后端模块骨架 + 13 表 migration + Feature Flag + 基础权限
2. **里程碑 2**（单 TaskDraft）：输入解析 + 推导（单）+ 校验 + 快照 + 单故事点创建幂等
3. **里程碑 3**（批量 100 条）：BatchCreationJob + 异步队列 + 进度推送 + 批次页面 + 暂停/恢复/取消
4. **里程碑 4**（AI 配置解析）：结构化推导 + 字段可信度 + Validator + Reviewer + Repair（≤5）+ 最佳候选
5. **里程碑 5**（人工介入）：异常队列 + 批量补全 + 配置分组（指纹）+ 预检 + 快照 + 审计
6. **里程碑 6**（StoryPoint 调度）：幂等创建 + 执行队列 + 4 类并发池 + 资源锁 + /devbench 集成
7. **里程碑 7**（TB / Git Review 集成）：TB 数据源 + 合并去重 + Git Adapter + Review Target + Findings 状态
8. **里程碑 8**（设置与运维）：并发设置 + 推导策略 + 自动修复策略 + 权限矩阵 + 指标 + 日志 + Feature Flag
9. **里程碑 9**（质量加固）：单元 + 集成 + E2E + 性能 + 安全 + Migration 验证 + 浏览器视觉验收
10. **里程碑 10**（文档交付）：20 个 aiautowork-development/*.md + 浏览器截图 + 最终实施报告

## 8. 验收口径

每一里程碑落地时必须满足：

- [ ] 对应前端页面可访问且关键路径无报错
- [ ] 关键 API 返回结构化错误（错误码 + 消息）
- [ ] 至少 1 个单元测试 + 1 个集成测试覆盖
- [ ] 现有 `/devbench` 路由仍能正常使用（路由冒烟）
- [ ] 现有 `data.db` 不被破坏
- [ ] 无 console error / warning（前端）
- [ ] 无堆栈泄漏（后端 try/catch 覆盖）
