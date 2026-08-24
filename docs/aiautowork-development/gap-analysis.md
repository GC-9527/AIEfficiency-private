# 设计 vs 实现 差距分析

> 里程碑 0 交付物 · 对照表：UI/UX 设计交付（`docs/aiautowork-uiux/*`） vs 现有实现
> 状态：现状（现状=空） / 需新增 / 需改造

## 1. 一级导航

| 设计项 | 现状 | 工作 |
|--------|------|------|
| `/aiautowork`（工作概览） | 不存在 | **新增**：`web-dashboard/src/pages/aiautowork/Overview.jsx` |
| `/aiautowork/batches`（批量中心） | 不存在 | **新增** |
| `/aiautowork/batches/:batchId` | 不存在 | **新增** |
| `/aiautowork/confirmations` | 不存在 | **新增** |
| `/aiautowork/settings` | 不存在 | **新增** |
| `/devbench`（保留） | 已有 40+ 组件 | **不动**，仅在 `App.jsx` 添加入口 "打开 AI 工作台" |

## 2. 设计文档 ↔ 实现条目对照

| 设计条目 | 现有实现 | 差距 | 工作 |
|----------|----------|------|------|
| **4 个一级域** | 1 个（devbench） | 3 缺 | 新增 aiautowork/{Overview,Batches,Confirmations,Settings} |
| **7 个 work 子视图** | 1 个（StoryTab） | 6 缺 | Overview 含 7 个内联视图：Running/ToDo/Reviews/TB/Confirmations/Findings/Rules |
| **11 个 Settings 组** | 0 | 11 缺 | 并发 / 推导 / 自动修复 / 权限 / 指标 / 日志 / Feature Flag / 通知 / 备份 / 高级 / 关于 |
| **3 个 Project 概念**（Project/Repository/Flavor 独立） | Project 在 `market-projects.json`；Repository 在 devbench config | 中 | 沿用 `market-projects.json` 字段，新增 `repositories[]` 多对一 |
| **TaskDraft 数据模型** | 仅 Story/Tab 实体 | 高 | 新增 `task_drafts` 表 + JSON 字段 |
| **BatchCreationJob 100 条上限** | 无 | 高 | 新增 `batch_creation_jobs` + `batch_task_items` + 队列 |
| **多源（TB/MANUAL/GIT_REVIEW）** | 仅 TB + Git（devbench 有 Git Commit Story） | 中 | 抽 `TBSourceAdapter` / `GitSourceAdapter` / `ManualSourceAdapter` |
| **Idempotency Key** | 无 | 高 | 哈希 `normalizedInput + sourceType + tbIdOrGitTarget + configHash + policyVersion` |
| **AI 结构化推导 + 候选版本** | `config-inference.js` 支持 V1/V2/V3 | 低 | 复用为"candidate"层，新增 `config_candidate_attempts` |
| **7 维 ReadinessSignals** | 仅 `score` 单一值 | 高 | 新增 `validation_issues` 表（确定性/独立一致/元数据） |
| **三档自动路由**（AUTO_READY/GROUP_CONFIRM/MANUAL） | 硬编码 | 中 | 由 7 维 signals 驱动：`overall>=88 & critical>=75` ⇒ AUTO_READY；`70-87` ⇒ GROUP_CONFIRM；`<70` 或关键缺 ⇒ MANUAL |
| **Validator + Reviewer 独立** | `config-inference.js` 内部 | 中 | 抽 `Validator`（确定性 + 业务规则）与 `Reviewer`（独立一致）两个服务，共享底层 |
| **Repair 自动修复 ≤5** | 无 | 高 | 新增 `repair` 服务，根据 issue 类型调对应修复策略 |
| **Manual Intervention Case** | 无 | 高 | 新增 `manual_intervention_cases` 表 + 工单式流转 |
| **分组确认（指纹）** | 无 | 高 | 按 `configFingerprint(projectId+flavor+primaryRepo+branches)` 聚合 |
| **字段决策 5 种** | 仅 `decisions: {overrides: {}}` | 中 | 扩为 `{adopt, override, ignore, lock, unlock}` + `evidence` |
| **预检 PreflightIssue** | 无 | 高 | 新增 `validation_issues` 同时承担预检 |
| **Story Point 创建幂等** | 仅 `tb_workflow.startDev` | 中 | 增加 `idempotencyKey` 入参；重放返回已存在 |
| **执行队列 + 优先级 + 排队原因** | `task_runtime_leases` | 低 | 复用租约；新增 `execution_queue` 表 + 优先级列 |
| **4 类并发池**（推导/校验/复核/执行） | 单一 engine pool | 高 | 在 `agent-runner.js` 上方建 4 个 named pool（默认 6/10/4/5） |
| **资源锁 `kind=ai_workbench`** | 有 `kind=ai` | 低 | 复用 `worktree_resource_leases`，加 kind |
| **TB 数据源** | `tb-task-analyzer.js` | 低 | 直接复用 + 增 `tb_sources` 多视图配置 |
| **Git 适配器** | `git-remote.js` / `codeup.js` | 低 | 复用，新增 `GitAdapter` 抽象层（Commit/Range/Branch/MR/PR） |
| **Review Target / Findings** | 已有 `code-review-report.js` | 低 | 复用，扩 review_target 与 severity 字段 |
| **权限矩阵** | 已有 `admin_users` 4 角色 | 低 | 复用，新增 `aiautowork_settings` 中 `permissions.*` 字段 |
| **审计** | `admin_audit` 已用 | 低 | 直接 addAudit |
| **指标 / 日志** | `getStats()` / `searchLogs()` | 中 | 新增 aiautowork 维度计数；日志加 `traceId/batchId/taskDraftId/storyPointId` |
| **Feature Flag** | 散落 | 中 | 新增 `aiautowork_settings.featureFlags` |
| **20 个 aiautowork-development 文档** | 不存在 | 高 | 写 20 个 .md（架构图/状态机/数据模型/Mermaid） |
| **35 项最终实施报告** | 不存在 | 高 | 写 `final-report.md` |

## 3. 前端组件差距

| 设计组件 | 现状 | 工作 |
|----------|------|------|
| `StatusBadge`（统一徽章） | 散落多处，自实现 | 抽 `components/aiautowork/StatusBadge.jsx` 统一 21 状态 |
| `SourceBadge` | 无 | 新增 |
| `ReadinessScore`（7 维雷达） | 无 | 新增 |
| `WorkflowProgress` | devbench `WorkflowMap.jsx` 存在 | 复用样式 |
| `DenseDataTable`（虚拟滚动） | 无 | 新增，参考 devbench `TaskPanel.jsx` 风格 |
| `TaskDrawer`（详情抽屉） | devbench `StoryTab` 内置 | 抽到公共 |
| `ConfigDiffGrid`（候选对比） | `ConfigInferenceReview.jsx` | 扩为多版本对比 |
| `EvidenceSummary` | 无 | 新增 |
| `PreflightList` | 无 | 新增 |
| `CandidateTimeline`（版本时间线） | 无 | 新增 |
| `BatchActionBar`（批量操作） | 无 | 新增 |
| `BatchFillDialog`（批量补全） | 无 | 新增 |
| `ConcurrencyControl`（并发数调节） | 无 | 新增 |
| `ScenarioSwitcher`（Demo 场景） | 仅 Mock | 真实实现中可隐藏或保留演示模式 |

## 4. 状态机差距

设计文档（`state-matrix.md`）已定义 14 个 TaskDraft 状态 + 8 个 Field 状态 + 7 步 Batch 状态。
当前 devbench 仅有：`pending` / `running` / `completed` / `failed` / `suspended`（TB 单视角）。

需要在 `task_drafts.status` 引入完整 21 状态：

```
INPUT_PARSED → INVALID_INPUT → DUPLICATE
            → DRAFT_CREATED → QUEUED_FOR_INFERENCE → INFERENCING
            → CANDIDATE_GENERATED → SELF_CHECKING → REVIEWING
            → REPAIRING → AUTO_READY
            → GROUP_CONFIRM_REQUIRED → AUTO_READY（组确认后）
            → MANUAL_INTERVENTION_REQUIRED → MANUAL_EDITING → AUTO_READY
            → PRECHECKING → PRECHECK_FAILED → REPAIRING（重试）/ MANUAL
            → READY_TO_CREATE → CREATING → CREATED
            → CREATE_FAILED / CANCELLED
```

## 5. 并发差距

当前 `agent-runner.js` 是单一引擎池（每 CLI 引擎 ≤ 4 并发）。AI Workbench 需 4 个**不同**池：

```
inferencePool    = 6   (config-inference 推导)
validationPool   = 10  (Validator 确定性校验)
reviewerPool     = 4   (Reviewer 独立复核)
executionPool    = 5   (story point 执行)
```

**关键设计点**：同一 task draft 一次只能在一个池子，但 100 条批次里 4 池可同时跑不同条目。

## 6. 实时推送差距

当前 devbench 用 WebSocket 推送 story point 状态，但**没有**行级增量。
设计要求 100 条任务每个状态变化都推 1 条，列出全表会爆。
实现：行级 patch：

```js
ws.send(JSON.stringify({ type: "row_patch", table: "batch_task_items", id, patch: { status, signals } }))
```

## 7. 字段决策与"用户锁"

设计要求 USER_EXPLICIT_INPUT / USER_MANUAL_SELECTION 不得被下游 AI 覆盖。
当前 `config-inference.js` 有 `overrides` 概念但没锁。
实现：扩 `decisions[fieldKey] = { source, locked, decision, evidence }`，推导时跳过 locked。

## 8. 现实缺口（必须明确）

下列能力**目前完全没有**，全部需要新写：

1. `gateway/services/aiautowork/` 整套服务（25+ 个文件）
2. `web-dashboard/src/pages/aiautowork/` 整套组件（30+ 个）
3. 13 张新表 + 迁移
4. 4 类并发池调度器
5. 行级 WebSocket patch 协议
6. 7 维 ReadinessSignals 评分
7. Repair 策略库（针对每类 issue 的修复函数）
8. 字段决策合并器（user lock > manual selection > ai inference > default）
9. 群组确认（指纹）算法
10. 预检闸门
11. 20 个开发文档
12. 35 项实施报告
13. 完整测试金字塔（unit/integration/E2E/perf）
14. 浏览器视觉验收（Playwright 截图 + 像素对比）

## 9. 不需要做的（避免范围蔓延）

- 不重写现有 devbench 三步流
- 不重写 TB / Git / AI 引擎
- 不重建数据库
- 不破坏现有 dark zinc 主题
- 不修改现有路由 `/chat` / `/skills` / `/agents` 等
