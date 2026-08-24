# 组件清单

## 可复用现有组件/模式

| 现有组件或模式 | 复用方式 | 改造要求 |
|---|---|---|
| `EditableCombobox` | 工程、仓库、分支搜索选择 | 增加分组、最近、推荐、证据 |
| `RemoteBranchSelect` | 远程/目标分支 | 支持 Base/Head 和存在性状态 |
| `ConfigInferenceReview` | 配置候选数据结构和证据心智 | 重做为 AI 推荐 vs 最终配置 |
| `TaskPanel` | 待办、TB 候选、任务组语义 | 改为固定表格和统一来源 |
| `GitCommitBatchStoryModal` | revision 模糊匹配、歧义选择 | 纳入统一 Task Draft 与批次 |
| `TbTaskEntryModal` | TB 输入解析 | 迁入大型创建 Drawer |
| `WorkflowMap` | 单故事点工作流 | 在列表中使用摘要，详情中完整展示 |
| Portal Modal 模式 | Dialog/Drawer 层级 | 统一焦点锁和 Escape 行为 |
| `showToast` | 操作反馈 | 统一 Toast 类型和可撤销动作 |
| 内联 SVG | 图标策略 | 统一 16/20px、1.5px stroke，不使用 Emoji |

## 新增公共组件

### 布局与导航

- `AutoWorkShell`
- `ProductNav`
- `WorkspaceTabs`
- `PageHeader`
- `Breadcrumb`
- `CommandBar`
- `StickyBulkBar`

### 状态

- `StatusBadge`
- `SourceBadge`
- `RuntimeStatus`
- `WorkflowStepSummary`
- `CreationQueueSummary`
- `PreflightBadge`
- `AttemptBadge`
- `LockBadge`

### 数据展示

- `DenseDataTable`
- `StickyTableColumn`
- `TaskSummaryCell`
- `RepositoryBranchCell`
- `ScoreSignal`
- `ConfidenceBreakdown`
- `EvidenceSummary`
- `SourceTags`
- `BatchDistribution`
- `CandidateTimeline`
- `FieldDiffRow`

### 表单与配置

- `SmartTaskInput`
- `TaskDraftRow`
- `ProjectPicker`
- `RepositoryPicker`
- `BranchPicker`
- `FlavorPicker`
- `DependencyEditor`
- `ConfigCompleteness`
- `PreflightIssueList`
- `ConfigDiffEditor`
- `PublicFieldEditor`
- `PerTaskOverrideTable`

### Overlay

- `StoryDetailDrawer`
- `FindingsDrawer`
- `CreateStoryDrawer`
- `CandidateHistoryDrawer`
- `ConfigReviewDrawer`
- `GroupConfirmDialog`
- `BatchFillDialog`
- `ConfirmDialog`
- `DemoScenarioPopover`

### 反馈

- `ToastViewport`
- `InlineAlert`
- `EmptyState`
- `ErrorState`
- `SkeletonTable`
- `DrawerSkeleton`
- `PartialFailureBanner`

## 组件状态要求

每个交互组件至少实现：

- Default
- Hover
- Focus
- Active/Selected
- Disabled
- Loading
- Error
- Readonly

每个状态组件必须有文字和图标，不单独依赖颜色。

## 推荐正式实现拆分

```text
web-dashboard/src/pages/aiautowork/
  index.jsx
  routes.jsx
  components/
  pages/
    OverviewPage.jsx
    RunningPage.jsx
    TodoPage.jsx
    ReviewsPage.jsx
    TbPoolPage.jsx
    RecordsPage.jsx
    BatchesPage.jsx
    BatchDetailPage.jsx
    ConfigConfirmPage.jsx
    SettingsPage.jsx
  create/
  config/
  batch/
  mock/          # 原型期，生产阶段移除
```

