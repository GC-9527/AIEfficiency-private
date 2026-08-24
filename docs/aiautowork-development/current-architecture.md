# 现状架构评估

> 里程碑 0 交付物 · 适用版本：gateway v2.5.7 / web-dashboard 配套前端
> 数据来源：仓库当前真实工程（避免凭印象或历史版本描述）

## 1. 代码组织

```
AIEfficiencyTrack/
├── gateway/                         # 统一网关（Express + better-sqlite3@12 + WebSocket）
│   ├── server.js                    # 入口
│   ├── routes/                      # HTTP 路由（chat / devbench / tb-tasks / bug-agent / …）
│   ├── services/                    # 业务服务
│   │   ├── devbench/                # 现有 35 个文件，单故事点工作台内核
│   │   │   ├── index.js             # 业务编排（kickTriage/kickVerify/kickReport）
│   │   │   ├── store.js             # SQLite 操作层（15K 行，覆盖 userdata / TB / sync / 备份等）
│   │   │   ├── config-inference.js  # 配置推导服务（3K 行）
│   │   │   ├── config-memory.js     # 配置记忆（按 TB 项目/车型）
│   │   │   ├── tb-workflow.js       # 三步工作流（甄别/修复/自验收+报告）
│   │   │   ├── tb-entry.js          # TB 数据接入
│   │   │   ├── worktree-manager.js  # worktree 资源锁
│   │   │   ├── verify-runner.js     # 第三步验收 runner
│   │   │   ├── store-training.js    # AI 训练样本沉淀
│   │   │   ├── lessons.js / config-memory.js
│   │   │   └── …
│   │   ├── config.js / dispatcher.js / task-decomposer.js / dag-scheduler.js
│   │   ├── bug-agent/               # Bug 智能分诊
│   │   └── …
│   └── db/sqlite.js                 # 单文件 SQLite 初始化 + 所有表 schema
├── web-dashboard/                   # React 19 + Vite + Tailwind，HashRouter
│   └── src/pages/
│       ├── Chat.jsx / Skills.jsx / Agents.jsx / Settings.jsx / …
│       ├── devbench/                # 单故事点工作台（40+ 组件）
│       │   ├── StoryTab.jsx / NewStoryPanel.jsx / ConfigInferenceReview.jsx
│       │   ├── TbTaskEntryModal.jsx / GitCommitBatchStoryModal.jsx
│       │   ├── ConfigSuggestModal.jsx / ProjectConfigModal.jsx
│       │   ├── PullLatestModal.jsx / …
│       │   └── *.mjs 模型层（configInferenceReviewModel / chatStopModel …）
│       ├── projectdev/              # 无人值守编排
│       └── aiautowork/              # ⛔ 不存在，需创建
└── docs/aiautowork-uiux/            # UI/UX 设计交付物（已存在）
```

## 2. 已具备、可直接复用的能力（不重复造轮子）

| 能力 | 现有位置 | 复用方式 |
|------|----------|----------|
| 配置推导（AI structured output） | `gateway/services/devbench/config-inference.js` | `inferConfig` / 多候选版本 / 字段决策；新 `/aiautowork` 复用其底层方法 |
| 配置记忆 + 启发式推荐 | `config-memory.js` | `getConfigMemory` / `addConfigMemory` / `suggestConfigSnapshot` |
| 教训沉淀 | `lessons.js` + `writeLessonsToClaudeMd` | 经验 / 关键词 / 状态映射 |
| Worktree 资源锁 | `worktree-manager.js` + `worktree_resource_leases` 表 | Owner/Lease/Heartbeat 模式可直接借给 AI Workbench |
| Runtime Lease（任务运行级） | `task_runtime_leases` 表 + `upsertTaskRuntimeLease` | 跨 Gateway 任务租约，沿用 |
| 飞书/TB/Git 客户端 | `feishu.js` / `teambition.js` / `codeup.js` / `git-remote.js` | 数据源适配器直接复用 |
| 故事点工作流 | `tb-workflow.js` + `index.js#kickTriage/kickVerify/kickReport` | AI Workbench 创建后，把 story point 抛给现有 `devbench` 三步流 |
| `worktree_resource_leases` | 已有 `kind=ai/taskId=…` 记录 | aiautowork 沿用，AI 锁 `kind=ai_workbench` |
| AI 引擎执行器 | `agent-runner.js` / `api-engine.js` | 推导/复核/修复/自验收统一调用 |
| 训练样本 | `story-training.js` / `machine-learn/` | 修复成功的 TaskDraft 落训练集 |
| 前端 React 栈 + 暗色主题 | `web-dashboard/src/pages/*`（zinc + #3b82f6 蓝） | `aiautowork/` 子目录沿用 `App.jsx` 现有路由 + Vite alias |
| 数据持久化 | `gateway/db/sqlite.js` WAL/busy_timeout=5000 | 13 张新表追加在此文件内，遵循 try/catch 迁移风格 |

## 3. 必须新增的能力

| 模块 | 说明 | 设计依据 |
|------|------|----------|
| TaskDraft 数据模型 | 任务草稿（输入标准化→idempotencyKey） | `prompt_ask_2.txt` 第 4 章 |
| BatchCreationJob + BatchTaskItem | 100 条任务并行异步 + 进度推送 | 第 5 章 |
| 候选配置版本（V1/V2/V3） | 结构化推导产物 + 评分 | 第 6 章 |
| 字段决策（采用/覆盖/忽略/锁定） | 5 种 decision + 证据 | `design-handoff.md` |
| 7 维度 ReadinessSignals | 整体 / 关键最低 / 字段分 / 证据覆盖 / 确定性 / 独立一致 / 元数据 | `confidence-design.md` |
| Reviewer 独立复核 | 与 Validator 分离的"独立一致"评分 | 第 6 章 |
| Repair（自动修复） | 最多 5 次重试 + 最佳候选 | `user-flows.md` auto-repair |
| Manual Intervention Case | 异常队列 + 人工编辑 | `user-flows.md` manual |
| 分组确认（指纹） | 公共字段组确认，单任务独立目标分支 | `user-flows.md` group-confirm |
| 资源锁 `kind=ai_workbench` | 推主干冲突用 worktree 锁 | `worktree-manager.js` |
| 13 张新表 | 任务草稿/批次/候选版本/审计/锁等 | 第 7 章 |
| WebSocket 行级增量 | 候选版本/Findings/排队原因/并发槽位 | `design-handoff.md` 实时更新 |
| 设置（11 组） | 并发/推导策略/自动修复/权限/指标/日志/Feature Flag | `page-inventory.md` |

## 4. 既有数据库盘点（`gateway/db/sqlite.js`）

WAL + busy_timeout=5000 的 better-sqlite3 实例。已有表（按主题）：

- **任务核心**：`tasks`、`task_logs`、`agent_status`、`task_runtime_leases`、`worktree_resource_leases`
- **聊天**：`chat_sessions`、`chat_messages`
- **管理员**：`admin_users`、`admin_audit`、`admin_tokens`
- **反馈**：`feedback`
- **devbench 共享数据**：`devbench_userdata`（按 user_key + kind）、`devbench_sync_backups`、`devbench_sync_backup_blobs`、`devbench_sync_backup_settings`
- **工作流模板**：`workflows`、`workflow_runs`
- **设备**：`discovered_subnets`、`discovered_devices`
- **性能**：`perf_session`、`perf_event`、`perf_metric`、`perf_report`
- **定时任务**：`scheduled_tasks`
- **TB 任务**：`tb_task_records`
- **飞书项目同步**：`feishu_project_sync_state`、`*_tombstones`、`raw_payloads`、`sync_errors`、`comment_sync`、`attachment_sync`
- **projectdev**：`projectdev_projects`、`projectdev_runs`、`projectdev_events`

迁移风格：`try { db.exec("ALTER TABLE …"); } catch {}`，可继续沿用。

## 5. 测试与工具链

- gateway 测试位于 `gateway/test/`，含 50+ 文件
  - 已有：`config-inference-{ranker,evaluator,governance,anchor,knowledge,quality,evidence,calibration,case-retriever,release}.test.mjs`
  - 这些都是 `config-inference.js` 的高质量单测，可作为新 `aiautowork/config-inference-pipeline.js` 测试范本
- 后端依赖（package.json）：express 4.21 / better-sqlite3 12.8 / ws 8.18 / jszip / node-cron / puppeteer-core / pptxgenjs
- 前端构建：React 19 + Vite 6 + Tailwind 3.4，无企业级 UI 库（自实现 `StatusBadge` / `DenseDataTable` 等）

## 6. 兼容性约束（实施时必须遵守）

1. **不破坏 `/devbench`**：`/aiautowork` 是新一级入口，但创建 story point 仍走 `tb-workflow.js` 现存三步流。
2. **同一 `data.db`**：新表直接追加到 `gateway/db/sqlite.js`，不新建数据库。
3. **同一前端 bundle**：`web-dashboard/src/pages/aiautowork/` 增量接入，路由 + 暗色锌色主题沿用。
4. **同一资源锁**：`worktree_resource_leases.kind` 新增 `ai_workbench`，沿用现有 claim/renew/release。
5. **AI 引擎统一抽象**：`/aiautowork` 内部不再新建引擎层，复用 `agent-runner.js`。
6. **审计沿用 `admin_audit` 表**：人工确认/批量应用/字段锁定/策略变更全部 `addAudit`。
7. **配置记忆沿用**：新增 TaskDraft 不再独立建库，复用 `config-memory.js` 的 byProject 记忆 + 启发式打分。
8. **TB 数据源适配器**：复用 `teambition.js` + `tb-task-analyzer.js`，新增 Git 适配器模式相同。

## 7. 风险点（实施时需提前关注）

| 风险 | 等级 | 缓解 |
|------|------|------|
| `gateway/db/sqlite.js` 已 4000 行，新增 13 张表会变 4500+ | M | 用独立子文件 `gateway/db/aiautowork-schema.js` 由 sqlite.js `import + exec` 注入 |
| 100 条任务并发推导可能触发 AI 限流 | M | 推导并发池默认 6 + 退避 + Reviewer 4 + Validation 10 + 优先级队列 |
| 字段决策与"用户锁"语义冲突 | M | 加 `userLocked: boolean` + `USER_EXPLICIT_INPUT`/`USER_MANUAL_SELECTION` 优先级最高，下游 AI 不得覆盖 |
| 100 条批次中途崩溃 | M | 每个 BatchTaskItem 独立事务，崩溃可恢复（按 `idempotencyKey` 重入） |
| 现有 devbench `worktree_resource_leases` 锁 | L | 沿用，新增 `kind=ai_workbench` 区分 |
| 报告型前端页面与 dark zinc 主题不一致 | L | 直接使用现有 zinc 调色板（`bg #0f0f10` / `sidebar #18181b` / `accent #3b82f6`） |
| 实时推送 100 行状态风暴 | M | 列表只接收行级增量 `WebSocket: {type:"row_patch", id, patch}` |

## 8. 现状的"已经能跑通"路径

```
用户 → /devbench → NewStoryPanel.jsx
                  → TbTaskEntryModal / GitCommitBatchStoryModal
                  → ConfigInferenceReview.jsx
                  → tb-workflow.js 三步 → 推 worktree → 改码 → verify → report
```

`/aiautowork` 需在上述链路**前面**加：

```
/aiautowork (工作概览) → "新建任务" → 解析 → TaskDraft 创建
       ↓
批量入口 → BatchCreationJob（最多 100） → 异步队列
       ↓
AI 推导（多版本） → Validator + Reviewer + Repair（≤5）
       ↓
配置分组确认 / 人工介入 / 最佳候选选择
       ↓
Story Point 创建（推到 /devbench） → 走现有三步流
```
