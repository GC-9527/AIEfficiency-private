# Acceptance v4.1 迁移现状审计

审计时间：2026-08-10  
审计基线：`feat/admin-rbac`，`HEAD=ff59ee3af14769c40cf0e301309153357cd5b1c9`  
任务路由：`DIRECT_ENGINEERING / PROJECT_ENGINEERING / PROJECT-STANDARD / MIXED`

## 1. 审计边界与工作区基线

本报告区分“提交基线”与“当前迁移候选”，避免把本次新增代码倒推成既有能力。

- 审计开始时工作区已有与本任务无关的 Gateway OAuth/超时测试、飞书文档和 regression ledger 修改；它们未被清理、暂存、回退或纳入本次实现。
- 根 `AGENTS.md` 在工作区为 0 字节，SHA-256 为 `e3b0c442...b855`，相对 HEAD 删除了 51 行；这是一项真实 dirty 差异，而不是可忽略的“文件缺失”。
- HEAD 中旧规则已按字节保存在 `docs/engineering/migrations/AGENTS.pre-v4.1.md`，备份 blob 与 `HEAD:AGENTS.md` 相同；活动根规则由 v4.1 包整体替换。
- 未发现 `skip-worktree` 或 `assume-unchanged` 索引标志。
- 本次没有调用真实 Teambition、飞书、JIRA、Redmine、ADB、AppMock、生产部署或付费 Provider。

## 2. 提交基线中的真实 DevBench StoryPoint 链

真实 DevBench 故事不是 `aiautowork.story_points` 表中的行，而是一个完整 Tab JSON：

```text
DevBench UI
  -> POST /api/devbench/story-initializations
  -> 进程内 initialization intent
  -> POST /api/devbench/tabs
  -> store.createTabGuarded()
  -> SQLite devbench_userdata(kind=tabs) 中的 JSON 数组
```

主要调用点：

- Web 两步创建入口：`web-dashboard/src/pages/devbench/index.jsx` 的 `requestStoryInitialization`、`confirmStoryInitialization`，以及 `web-dashboard/src/pages/devbench/api.js` 的 story initialization/tabs API。
- Gateway intent 冻结与消费：`gateway/routes/devbench.js` 的 `/story-initializations` 和 `/tabs` 路由；`gateway/services/devbench/story-initialization.js` 使用进程内 `Map` 管理 intent。
- Tab 创建与存储：`gateway/services/devbench/store.js` 的 `newTabRecord`、`createTabGuarded`；`gateway/db/sqlite.js` 的 `devbench_userdata` JSON 读写。
- `tabs/closed` 属设备本地数据，不参与 gossip。
- `GET /api/devbench/tabs` 会做恢复、worktree provisioning 和 `store.updateTab`，因此不能把它当成纯只读审计端点。

现有创建链只把 ticket URL、ticketBound、worktreeNaming 等部分初始化字段写入 Tab；来源入口、完整来源事实包、mapping version 和不可变来源哈希没有形成统一 Canonical StoryPoint。

## 3. 基线中的“单一验收状态”

基线没有字面字段 `acceptance_status`。实际承担单一状态职责的是 TB Tab 的 `tab.workflow.phase`：

- 状态定义与推进位于 `gateway/services/devbench/tb-workflow.js`，包含 `claimed`、`triaging`、`fixing`、`verify_blocked`、`verifying`、`reporting`、`testable`、`sync_pending` 等阶段。
- Web 只展示这一条 phase：`web-dashboard/src/pages/devbench/workflowMapModel.js` 与 `StoryTab.jsx` 的 `WorkflowStatusBar`。
- `phase=testable` 同时混合技术验证、报告和来源同步含义，不能等价于下列四个正交结论：
  - Project Change Decision；
  - Project Production Readiness；
  - Story Point Decision；
  - Source Sync Status。

旧自动推进链仍是真实链路：AI marker -> `applyWorkflow()` -> `kickVerify()`/`kickReport()` -> 文件证据 -> `runPersistedTbSync()` -> `testable` 或 `sync_pending`。其证据目录由 `gateway/services/devbench/verify-runner.js` 创建，TB durable saga/outbox 位于 `tb-workflow.js` 与 DevBench store 中。

这条旧链已接入 TB 评论、附件、状态回写，但完全依赖 `workflow.phase`，没有读取或写入 v4.1 的 `story_point_decision`、`source_sync_decision` 或 `source_sync_status`。

## 4. 来源连接器与规范化现状

| 来源 | 基线能力 | 与 v4.1/真实 DevBench 的关系 |
|---|---|---|
| Teambition | 已实现拉取、上下文、评论/附件/状态 durable 回写 | 唯一直接接入 DevBench 的工单来源；`tbContext` 是最新可变快照，不是不可变 Canonical 快照 |
| 飞书项目 | 已实现独立飞书 -> TB 同步 | 不创建 DevBench Tab，也不生成 Canonical StoryPoint |
| Git commit | 已实现独立故事入口 | 不是通用 issue connector |
| JIRA | 无运行时 adapter | 只能保持未适配/UNKNOWN，不能虚构拉取或回写成功 |
| Redmine | 只有计划文档 | 无运行时代码 |
| GitHub/GitLab/禅道 | 无运行时 adapter | UI 仍标记“待适配器” |

现有 `machine-learn/source-snapshot.js` 有可复用的不可变推理快照 primitive，但只服务配置推理，尚未接入 DevBench 故事验收。

## 5. AIAutoWork 与真实 DevBench 的断层

`gateway/db/aiautowork-schema.js` 原有另一套 `task_drafts`、`config_snapshots` 和 `story_points`。`gateway/services/aiautowork/pipeline.js` 的创建逻辑仍是 deterministic stub：

- 直接生成随机 `devbench_<random>`；
- 没有调用 DevBench `store.createTabGuarded()`；
- `story_points.devbench_story_id` 因此不对应真实 `tab_*`；
- 当前 v4.1 `registerRuntimeStoryPointFromDraft()` 绑定的仍是 AIAutoWork `sp_*`，不是实际 DevBench Tab。

所以本阶段只能把 AIAutoWork 接入标记为“报告模型/双写候选”，不得宣称真实 DevBench StoryPoint 已完成端到端规范化。

## 6. 真实命令与风险分级

命令从仓库脚本和 `package.json` 提取，不凭空猜测。

| 目标 | 命令 | v4.1 默认使用 |
|---|---|---|
| Gateway 聚焦测试 | `npm test -- acceptance-v4 aiautowork` | PROJECT-STANDARD，本次使用；由仓库 runner 逐文件隔离执行 |
| Gateway 自动发现全量 | `npm test`（`scripts/run-tests.mjs`） | 标准/发布候选按影响选择；耗时较长 |
| Web 认证预检 | `npm run pretest` | 涉及鉴权/transport 时使用 |
| Web 全量模型测试 | `npm test` | 涉及 Web 时使用 |
| Web 生产构建 | `npm run build` | 涉及 Web 接线时使用；不等价于生产 READY |
| Desktop 预检 | `npm run preflight` | 仅桌面/打包范围 |
| Desktop 包校验 | `npm run verify-package` | 仅最终制品范围 |
| Desktop 构建/分发 | `npm run pack` / `npm run dist:*` | 只用于 PROJECT-RELEASE；本次不执行 |
| Android/ADB/AppMock | 由具体目标仓库、Flavor 和设备规则给出 | 普通平台工程任务不执行；不得用非目标设备/Flavor 替代 |
| 旧总入口 | `node scripts/acceptance.mjs` 或 `scripts/acceptance.ps1` | 过宽，只作为既有编排器；不能单独证明 v4.1 四类结论 |

仓库根没有 `package.json`，因此不能声称存在根级 `npm test`。`gateway/package.json` 当前 Node engine 为 `24.14.1`。

## 7. 证据、自证与误修风险

基线及迁移候选必须防止以下错误归因：

- HARNESS_DEFECT：AppMock、ADB forward、验收脚本、缓存或证据选择错误，不得为了“跑绿”去修改正确的目标业务代码。
- SOURCE_CONNECTOR：来源拉取/映射/回写失败只影响来源同步状态；技术结论已有可信证据时不得回退。
- ENVIRONMENT：依赖、网络、权限、设备或部署拓扑不确定时保持 UNKNOWN/BLOCKED，不得用模型描述填成 FACT。
- 自证：API 请求体中的 `gate.result=PASS` 和任意 `evidence_ids` 不能直接生成 ACCEPTED/VERIFIED。

迁移候选已采用以下约束：

- 新 run 固定从 PENDING/PARTIAL 开始；调用方提交的 PASS 不参与初始结论。
- 公开证据 API 只写 `UNVERIFIED`；可信等级只能由内部机械 runner 或独立 reviewer 产生。
- PASS/FACT/影响矩阵结论必须引用同一 run、候选、来源快照和环境的可信证据。
- Canonical source 的 `fetched_at` 必填，禁止用 wall clock 补值并污染幂等哈希。
- Source Sync 的非 `NOT_ATTEMPTED` 状态需要可信 connector evidence；Phase 0 不自动回写外部来源。

## 8. v4.1 当前迁移候选

已落地：

- 根规则、router、Project/Story 两套 Skill、只读 reviewers 和旧入口兼容转发器；
- routing/candidate/source/risk 示例配置与三套 JSON Schema；
- Canonical StoryPoint、不可变来源快照、候选身份、Gate plan、影响矩阵、精确失效和保守历史映射；
- `acceptance_*` SQLite 表、service/API、轻量 CLI 和 `/aiautowork/acceptance` UI；
- 四张正交状态卡、路由元数据、DUAL_SCOPE 双轨、UNKNOWN/Finding/候选证据一致性；
- report-only 设置、管理员 Principal 门禁与自动来源回写关闭。

仍为 PARTIAL/UNKNOWN：

- 真实 DevBench `tab_*` -> Canonical StoryPoint adapter；
- TB/飞书 raw payload 和旧 workflow 历史回填；
- 真实 GateEngine 与现有 verify-runner 的桥接；
- v4.1 Source Sync -> `runPersistedTbSync()` 桥接；
- JIRA/Redmine/GitHub/GitLab adapters；
- 生产发布、真实设备/AppMock 和外部来源端到端证据。

## 9. 灰度与回滚结论

当前只能进入 Phase 0：`REPORT_ONLY`。

1. 保留旧 `workflow.phase` 主判定，v4.1 只报告；
2. 在可信 GateEngine 和真实 Tab adapter 接入后再做双写对比；
3. 对比历史回放、耗时、重复门禁、误报/漏报、缓存误用和错误自动推进；
4. 只有完成 golden replay 且不存在错误升级为 PASS/READY/VERIFIED，才考虑切换主判定；
5. 回滚时关闭 v4.1 feature/settings 和 UI 入口即可，不能删除旧 workflow 数据或不可变来源快照。

本次不执行真实来源写入、部署、权限提升或不可逆数据操作。
