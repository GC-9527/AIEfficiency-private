# 双轨验收状态与 UI 展示模型

## 1. 页面不能再只显示“验收通过”

至少分成四张状态卡：

1. **工程任务验收**：Project Change Decision；
2. **生产发布就绪**：Project Production Readiness；
3. **故事点交付可信度**：Story Point Decision；
4. **来源系统同步**：Source Sync Status。

## 2. 路由信息

任务详情页固定展示：

- task_origin；
- scope_kind；
- protocol/version；
- change_type；
- risk_tier；
- project_task_id/story_point_id；
- 主来源与关联来源；
- 目标仓库与候选哈希。

`source_system` 只能出现在来源区域，不能出现在技术风险标签位置。

## 3. 推荐状态

### 工程任务

- IN_PROGRESS；
- QUICK_CHECKED；
- STANDARD_ACCEPTED；
- PARTIAL；
- REJECTED；
- RELEASE_READY；
- RELEASE_NOT_READY。

### 故事点

- NORMALIZING；
- NORMALIZED；
- CANDIDATE_FROZEN；
- ASSURANCE_RUNNING；
- VERIFIED；
- PARTIAL；
- BLOCKED；
- BLOCKED_BY_HARNESS。

### 来源同步

- NOT_ATTEMPTED；
- PENDING；
- SUCCEEDED；
- FAILED_RETRYABLE；
- FAILED_FINAL；
- PARTIAL。

## 4. DUAL_SCOPE UI

同一个任务显示两个独立进度轨：

```text
Platform/Project Track   [STANDARD_ACCEPTED] [RELEASE_NOT_ASSESSED]
Story Delivery Track     [VERIFIED]
Source Sync              [FAILED_RETRYABLE]
```

不得把三者聚合成绿色“全部完成”。顶部总状态可显示 `ACTION_REQUIRED`，并明确是同步失败而不是技术失败。

## 5. 证据与未知项

页面应展示：

- Acceptance Criteria Coverage；
- Impact Matrix Coverage；
- Facts / Inferences / Unknowns；
- Blocking/Non-blocking Findings；
- Candidate and Evidence Consistency；
- Repair Rounds；
- Invalidated/Reused Gates；
- Residual Risk。

## 6. 自动化权限

- `Project Change ACCEPTED` 不自动触发生产部署；
- `Project Production READY` 才允许进入发布审批；
- `Story VERIFIED + Source Sync ALLOWED` 才允许自动推进来源；
- PARTIAL 必须人工审批；
- BLOCKED/REJECTED/NOT_READY 禁止推进。
