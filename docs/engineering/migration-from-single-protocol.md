# 从单一 story-acceptance-protocol 迁移到 v4.1

## 1. 需要删除的混合语义

旧逻辑中常见的混用：

- `story point/devbench task` 共用一套报告和完成规则；
- 所有开发/修复统一调用 `$story-acceptance-protocol`；
- 默认要求 release package、设备/AppMock 和全新子代理；
- `PASS` 同时被解释为任务完成、故事点完成和生产可上线。

迁移后必须消除这些复合字段和调用点。

## 2. 最小替换

1. 根规则替换为本包 `AGENTS.md`；
2. 加入 `$acceptance-router`、`$project-engineering-acceptance`、`$runtime-story-point-assurance`；
3. 将原 `$story-acceptance-protocol` 标记 deprecated；
4. 所有旧调用先经过 router；
5. 数据库/任务记录增加 `task_origin`、`scope_kind`、`change_type`、`risk_tier`、`protocol_version`；
6. 原单一 `acceptance_status` 拆为 project、story、source_sync 三组状态。

## 3. 兼容映射

| 旧字段/调用 | 新映射 |
|---|---|
| devbench task + story acceptance | DIRECT_ENGINEERING + PROJECT_ENGINEERING |
| TB/JIRA/飞书直接作为验收类型 | 先规范化为 RUNTIME_STORY_POINT；来源仅保留在 source_refs |
| acceptance PASS | 根据上下文映射为 Project Change ACCEPTED 或 Story VERIFIED；无法判断则 PARTIAL/NOT_ASSESSED |
| TB auto advance | Source Sync Decision/Status |
| sub-agent required for all | 仅 PROJECT-RELEASE、STORY-STANDARD/CRITICAL 按规则启用 |
| 一份证据目录 | project 与 story 分目录 |

历史数据无法可靠判断对象时，不得自动映射为通过。

## 4. 代码迁移建议

建议最小接口：

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

共享引擎不共享最终决策。

## 5. 灰度阶段

### Phase 0：只路由与记录

不改变旧结果，只记录新路由与差异。

### Phase 1：双写结果

旧/新协议并行生成结果，禁止自动推进；比较耗时、漏检、误报和状态一致性。

### Phase 2：新协议主判定

旧协议只作为观察者；自动修复仍关闭。

### Phase 3：有限修复

开放最多两轮最小修复和增量复验。

### Phase 4：来源自动回写

只有 VERIFIED、证据一致和 reviewer 通过时允许自动回写。

## 6. 回滚

保留协议版本、路由版本和原始证据。出现错误路由或状态异常时，可关闭新 router 并回到只报告模式；不得删除已生成的来源快照和候选身份。
