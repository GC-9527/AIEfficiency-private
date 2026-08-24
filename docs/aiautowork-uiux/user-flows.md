# 核心用户流程

## 单个任务创建

```mermaid
flowchart TD
  A[点击新建故事点] --> B[选择智能输入/TB/手工/Git Review]
  B --> C[生成 Task Draft]
  C --> D[识别任务类型]
  D --> E[Mock AI 推导候选配置]
  E --> F[确定性自检]
  F -->|通过| G[配置审核]
  F -->|可自动修复| H[最多 3 次自动修复]
  H --> F
  F -->|必须人工| I[人工介入]
  I --> F
  G --> J[最终配置确认]
  J --> K[Mock 创建故事点]
  K --> L[已创建]
  L --> M{有执行槽位?}
  M -->|有| N[进入执行]
  M -->|无| O[进入等待队列]
```

## 智能混合输入

1. 用户粘贴多行内容。
2. UI 逐行生成草稿，不立即显示“已创建”。
3. 识别 TB、MANUAL、GIT_REVIEW。
4. 展示有效、重复、无效、已存在故事点和可创建数量。
5. 单条进入创建向导；多条进入批量处理中心。

## 100 条批量创建

```mermaid
flowchart TD
  A[100 条原始输入] --> B[解析与去重]
  B --> C[3 重复 / 2 无效 / 95 有效]
  C --> D[并发推导候选配置]
  D --> E[确定性自检 + 独立复核]
  E --> F[有限自动修复 V1-V3]
  F --> G{自动分流}
  G -->|68| H[自动就绪]
  G -->|17| I[建议按组确认]
  G -->|8| J[需要人工介入]
  G -->|2| K[达到修复上限]
  I --> L[整组采用或修改公共字段]
  J --> M[只补异常字段]
  K --> M
  L --> N[批量预检]
  M --> N
  H --> N
  N --> O[一次创建全部已就绪]
  O --> P[已创建 100]
  P --> Q[运行 5 / 等待 95]
```

## 配置推导与确认

```mermaid
flowchart LR
  Evidence[可验证证据摘要] --> AI[AI 推荐配置]
  AI --> Check[确定性预检]
  Check --> Compare[AI 推荐 vs 最终配置]
  Compare --> Adopt[全部/逐项采用]
  Compare --> Manual[人工修改]
  Compare --> Ignore[忽略 AI]
  Adopt --> Final[最终配置]
  Manual --> Final
  Ignore --> Final
  Final --> Recheck[立即重新预检]
```

证据只展示来源摘要，不展示模型内部思维链。

## 自动修复

```mermaid
stateDiagram-v2
  [*] --> V1
  V1 --> Check1
  Check1 --> Ready: 通过
  Check1 --> V2: 可自动修复
  V2 --> Check2
  Check2 --> Ready: 通过
  Check2 --> V3: 仍有可修问题
  V3 --> Check3
  Check3 --> Ready: 通过
  Check3 --> Best: 仍失败
  Best --> Human: 选择历史最佳候选
  Human --> Ready: 人工补全后通过
```

每个版本记录评分、关键字段最低分、阻断、警告、修改字段和修复原因。回滚表示恢复候选配置，不是 Git 回滚。

## 人工介入

1. 自动选择历史最佳候选并预填已通过字段。
2. 页面只展开异常字段。
3. 展示候选值、历史成功值、问题原因和自动修复历史。
4. 用户补全后立即 Mock 预检。
5. 通过后自动变为已就绪，不要求返回列表再次确认。

```mermaid
flowchart LR
  A[自动修复达到上限] --> B[选择历史最佳候选]
  B --> C[锁定已通过字段]
  C --> D[只展开异常字段]
  D --> E[用户补全或覆盖]
  E --> F[立即重新预检]
  F -->|通过| G[自动进入已就绪]
  F -->|仍阻断| D
```

## 配置分组确认

```mermaid
flowchart LR
  A[17 个中等可信任务] --> B[按配置相似性分组]
  B --> C[展示公共字段和组内差异]
  C --> D{用户决定}
  D -->|采纳整组| E[应用公共工程/仓库/依赖/Flavor]
  D -->|修改公共字段| F[预览影响范围]
  D -->|移出单项| G[单项进入独立处理]
  F --> E
  E --> H[保留各任务目标分支]
  H --> I[批量重新预检]
```

## 批量补全

```mermaid
flowchart LR
  A[选择 20 个缺主工程任务] --> B[批量补全]
  B --> C[选择公共主工程]
  C --> D[预览受影响 20 项]
  D --> E[确认应用]
  E --> F[保留每任务独立目标分支]
  F --> G[批量重新预检]
```

公共字段、独立字段、继承字段和单项覆盖字段必须在预览中明确区分。

## 创建与执行队列

```mermaid
flowchart LR
  Ready[配置已就绪 100] --> Creating[创建中]
  Creating --> Created[故事点已创建 100]
  Created --> Running[正在执行 5]
  Created --> Waiting[等待执行 95]
  Running --> Finished[执行完成]
  Finished --> Waiting
```

降低并发不会终止当前运行任务，只阻止新任务启动。
