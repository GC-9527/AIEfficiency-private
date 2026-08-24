# 正式开发交接

## 原型与正式功能边界

当前交付是 UI/UX Mock，不进入生产功能开发。静态 Demo 中的推导、评分、自检、自动修复、创建、执行、Findings、并发和数据源状态全部为本地模拟。

正式开发时应继续保留：

- `/aiautowork` 作为统一任务入口；
- `/devbench` 作为单故事点深度工作区；
- 故事点创建状态和执行状态分离；
- 工程、仓库、分支、依赖和 Flavor 独立建模；
- 候选配置与最终配置分离；
- 用户锁定字段不可被自动覆盖；
- 批量默认只看异常，公共字段可组确认，目标分支保持每任务独立。

## 建议路由

| 路由 | 用途 |
|---|---|
| `/aiautowork` | 工作概览与二级业务页签 |
| `/aiautowork/batches` | 批量中心 |
| `/aiautowork/batches/:batchId` | 批次详情 |
| `/aiautowork/confirmations` | 配置待确认 |
| `/aiautowork/settings` | 设置 |
| `/devbench` | 旧单故事点开发工作台，保持兼容 |

## 建议前端数据模型

核心实体为 `StoryPoint`、`TaskDraft`、`CandidateConfig`、`EffectiveConfig`、`ConfigFieldDecision`、`PreflightIssue`、`Batch`、`BatchItem`、`ExecutionQueueEntry`、`ReviewFinding`、`TBSource`。

字段状态、配置状态、创建状态、运行状态和工作流步骤应使用不同枚举，不能以单个 `status` 承载所有语义。

关键评分对象建议包含：

```ts
type ReadinessSignals = {
  overall: number
  criticalMinimum: number
  fieldScores: Record<string, number>
  evidenceCoverage: number
  deterministicCheck: 'pass' | 'warning' | 'blocked'
  independentAgreement: 'pass' | 'mismatch' | 'unknown'
  metadataValidity: 'valid' | 'partial' | 'invalid'
}
```

## 后端接口建议

- 任务草稿解析：输入标准化、类型识别、重复/无效/已存在检测。
- 候选配置：提交推导、查询版本、比较版本、选择最佳版本。
- 配置决策：逐字段采用、覆盖、忽略、锁定、解锁和证据摘要。
- 预检：确定性校验、警告确认、阻断定位和可自动修复能力。
- 批次：创建、分页查询、状态流、暂停、继续、取消、重试和批量应用。
- 故事点创建：幂等创建、部分成功、失败重试和结果查询。
- 执行队列：并发槽位、优先级、排队原因、暂停新任务。
- TB 来源：多视图配置、同步状态、去重来源详情。
- Review：范围解析、Findings、严重级别和人工处置。
- 设置：版本化保存、权限校验、冲突检测和审计记录。

## 实时更新

列表只接收行级增量状态，避免批量刷新 100 行。可使用 SSE 或 WebSocket 推送以下事件：

- 候选版本产生；
- 自检/复核/修复状态；
- 配置问题变化；
- 创建结果；
- 运行状态和工作流步骤；
- 并发槽位变化；
- Findings 变化。

## 权限和审计

正式实现必须在服务端强制验证人工确认、写权限、分支、Flavor、批量影响范围和并发设置；不能只依赖 UI 门禁。所有用户覆盖、批量应用、风险接受、字段锁定和自动创建策略变更需要审计。

## 组件化建议

优先抽取 `StatusBadge`、`SourceBadge`、`ReadinessScore`、`WorkflowProgress`、`DenseDataTable`、`TaskDrawer`、`ConfigDiffGrid`、`EvidenceSummary`、`PreflightList`、`CandidateTimeline`、`BatchActionBar`、`BatchFillDialog`、`ConcurrencyControl`、`ScenarioSwitcher`。

正式实现应在当前 React/Vite 技术栈内增量接入，避免为原型进行大规模 Layout 或后端重构。

## 实施顺序

1. 路由、Layout、设计令牌和只读列表。
2. Task Draft 与统一创建入口。
3. 候选配置、字段决策和预检。
4. 批次状态流、分组确认和批量补全。
5. 故事点创建与执行队列。
6. 设置、权限、审计和 TB 数据来源。
7. 真实 Review Findings、通知和趋势能力。

每一阶段都应验证 `/devbench` 路由、旧数据结构适配和深链接不回归。
