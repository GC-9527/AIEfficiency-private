# 将 v4.1 双轨验收落地到真实 AIEfficiency 仓库的 Codex 编排 Prompt

你是生产级软件交付、测试架构、AI 证据治理、多来源工单规范化和 Codex 编排专家。请基于当前仓库真实源码与脚本，把现有混合的 `$story-acceptance-protocol` 重构为：

1. 当前工程自身开发/修复/发布验收；
2. 平台运行后内部故事点的来源无关交付验收；
3. 两者共享候选、门禁 DAG、证据、缓存和 reviewer 适配，但状态、修复范围、证据目录和结论完全隔离。

先读取：

- 根 `AGENTS.md`；
- `.agents/skills/acceptance-router/SKILL.md`；
- `.agents/skills/project-engineering-acceptance/SKILL.md`；
- `.agents/skills/runtime-story-point-assurance/SKILL.md`；
- 现有 DevBench/AI 工作台/编排器/Gateway；
- Teambition、飞书、JIRA、Redmine 等连接器或同步代码；
- StoryPoint 数据模型、任务状态、UI、构建、测试、部署、设备/AppMock、证据和自动推进代码。

## 不可违反的约束

- 不猜命令；从真实 `package.json`、Gradle、PowerShell、Docker、CI、脚本和文档提取。
- `source_system` 只决定取数、映射、权限与回写，绝不决定技术协议和风险等级。
- 外部工单必须先规范化成唯一内部 `story_point_id` 与不可变快照。
- 主工作区只有一个写入 Agent；并行 Agent 只读。
- 不降低关键门禁换速度，不把模型文字当 PASS 证据。
- 不修改范围外产品缺陷；HARNESS/SOURCE_CONNECTOR 不得误修到目标业务代码。
- 自动修复最多 2 轮，工程与故事点预算独立。
- 修改验收器时使用旧稳定版本、独立 CI 或 golden cases，禁止自证。
- 不执行真实生产发布、不可逆工单推进、权限提升或数据破坏；这些动作只输出计划并等待明确授权。

## 里程碑 1：现状审计

输出并保存：

- `story point/devbench task` 混合规则和调用点；
- 单一 `$story-acceptance-protocol` 的入口、状态和 UI；
- 哪些流程错误地统一要求 release、设备/AppMock 或独立子代理；
- 真实 lint/typecheck/unit/integration/contract/build/package/smoke/deploy/ADB/AppMock 命令；
- 当前来源工单到故事点的映射、快照、更新和回写逻辑；
- 当前候选、证据、缓存、失败重试和全量重跑逻辑；
- HARNESS_DEFECT、SOURCE_CONNECTOR、ENVIRONMENT 可能被误判为业务缺陷的路径；
- 验收器自证风险。

不得修改代码，先形成可追踪审计。

## 里程碑 2：领域模型与路由

最小实现：

```text
AcceptanceRouter
ProjectEngineeringProtocol
RuntimeStoryPointProtocol
CandidateIdentityService
SourceSnapshotService
RiskClassifier
GateEngine
EvidenceStore
IndependentReviewAdapter
DecisionPolicy
SourceSyncService
```

新增字段：

```text
task_origin
scope_kind
protocol_version
change_type
risk_tier
project_task_id
story_point_id
source_refs[]
source_snapshot_hash
project_change_decision
production_readiness
story_point_decision
source_sync_decision
source_sync_status
```

实现 DIRECT_ENGINEERING、RUNTIME_STORY_POINT 和 DUAL_SCOPE 路由。来源名称不得出现在协议选择条件中。

## 里程碑 3：故事点规范化

实现 Canonical StoryPoint：

- 支持一个主来源和多个关联来源；
- 保存不可变原始快照、内容哈希、抓取时间和映射版本；
- 保存已读取/未读取评论、附件、日志、图片、视频；
- 来源更新使相关事实、门禁和结论精准失效；
- 字段冲突保留并要求显式解决；
- 来源回写幂等、可重试，与技术结论解耦。

先适配已有来源，不虚构不存在的连接器。

## 里程碑 4：工程验收协议

实现 PROJECT-QUICK/STANDARD/RELEASE：

- FEATURE、DEFECT_FIX、REFACTOR 等类型门禁；
- Project Change Decision 与 Production Readiness 分离；
- 最终发布才执行安装、升级、回滚、生产拓扑、安全、并发/恢复和 golden story replay；
- 普通工程任务不机械执行设备/Flavor 门禁；
- 平台 E2E 使用沙箱或固定 golden stories，不推进真实工单。

## 里程碑 5：运行态故事点协议

实现 STORY-FAST/STANDARD/CRITICAL：

- 按 change_type 选择证据；
- FACT/INFERENCE/UNKNOWN；
- DEFECT_FIX 的基线红/候选绿、根因和竞争假设；
- FEATURE 的验收标准追踪；
- 12 维影响矩阵；
- 候选/来源快照/制品/环境一致性；
- reviewer 默认只读复核，CRITICAL 才重跑关键 1–3 个门禁；
- Story Point Decision 与 Source Sync 状态分离。

## 里程碑 6：轻量执行与精准失效

提供最小入口，可按真实技术栈调整：

```text
accept route --task <id>
accept project --task <id> --mode quick|standard|release
accept story --story <id> --mode auto|fast|standard|critical
accept resume --manifest <path>
```

支持 fail-fast、changed-only、PASS 缓存、候选哈希、精准失效、最多两轮修复、JSON/JSONL、UI 实时事件和只读 reviewer handoff。

只有公共协议、依赖锁、数据库、打包签名、部署配置、运行环境或高风险边界变化时扩大重跑范围。

## 里程碑 7：数据与 UI 迁移

将单一 `acceptance_status` 拆为：

- Project Change；
- Project Production Readiness；
- Story Point Decision；
- Source Sync Status。

UI 固定展示 task_origin、scope_kind、change_type、risk、候选、证据覆盖、UNKNOWN、Finding、修复轮次和失效门禁。DUAL_SCOPE 显示两个独立进度轨。

提供历史结果保守映射；无法判断对象时映射为 PARTIAL/NOT_ASSESSED，不得自动升级为通过。

## 里程碑 8：Golden Cases 与灰度

至少覆盖：

1. 直接工程功能开发；
2. 直接工程缺陷修复；
3. 平台正式发布；
4. 飞书/JIRA/Teambition 任一来源的普通故事点；
5. 多仓/SDK/多 Flavor 高风险故事点；
6. HARNESS_DEFECT；
7. SOURCE_CONNECTOR 回写失败；
8. DUAL_SCOPE；
9. 来源快照在验收中变化；
10. 证据不足必须 PARTIAL。

对比旧/新结果、耗时、重复门禁、误报/漏报、缓存误用、错误自动推进和修复轮数。先只报告，再双写，最后切主判定。

## 最终交付

- 审计报告；
- 路由与领域模型；
- 两套协议、Skill 和 reviewer；
- 来源规范化、schema、manifest；
- 门禁、风险和精准失效配置；
- UI/状态迁移；
- 执行器与测试；
- golden case 对比；
- 灰度、回滚和残余风险文档。

每完成一个里程碑继续下一个，不等待重复确认；遇到真实生产写入、不可逆来源推进、权限提升或数据破坏时停止并明确列出所需授权。
