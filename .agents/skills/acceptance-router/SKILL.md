---
name: acceptance-router
description: 在 AIEfficiency 中根据任务执行来源、内部故事点标识、实际改动范围和交付目标选择工程验收、运行态故事点验收或双范围验收。来源工单系统仅作为元数据，不得用于决定技术门禁。
---

# Acceptance Router v4.1

## 目的

本 Skill 只完成轻量路由和边界冻结，不运行重型构建或测试。

## 必需输入

尽量从当前上下文、仓库和运行任务清单自动发现：

- 是否存在由运行平台生成的稳定 `story_point_id`；
- 是否存在不可变故事点快照与快照哈希；
- 当前修改的是平台/编排器/验收设施，还是故事点目标工程；
- 是否跨多个仓库；
- 当前是开发、缺陷修复、重构、配置/数据、制品、测试设施、审查或文档任务；
- 是否准备正式部署/升级。

不得使用 `source_system` 作为技术协议选择条件。

## 路由表

| 条件 | task_origin | scope_kind | 协议 |
|---|---|---|---|
| 没有运行态故事点清单，直接修改当前工程 | DIRECT_ENGINEERING | PROJECT_ENGINEERING | `$project-engineering-acceptance` |
| 有 `story_point_id`，只修改故事点目标业务工程 | RUNTIME_STORY_POINT | STORY_DELIVERY | `$runtime-story-point-assurance` |
| 有 `story_point_id`，同时修改平台/验收设施与目标工程 | RUNTIME_STORY_POINT | DUAL_SCOPE | 两个协议分别执行 |
| 有 `story_point_id`，目标工程就是平台工程 | RUNTIME_STORY_POINT | DUAL_SCOPE | 故事点交付 + 部署前工程发布验收 |
| 外部工单存在，但尚未规范化为内部故事点 | 未确定 | 不得直接 STORY_DELIVERY | 先规范化或标记 BLOCKED_ROUTING |
| 故事点失败根因是编排器/脚本/连接器/设备设施 | RUNTIME_STORY_POINT | STORY_DELIVERY → 关联 PROJECT_ENGINEERING | 故事点阻断/部分 + 新工程任务 |

## 改动范围判定

将改动分成：

- `project_paths`：AIEfficiency、DevBench、AI 工作台、Gateway、调度、连接器、验收器、安装升级、平台配置；
- `story_target_paths`：故事点锁定的目标仓库/模块/Flavor；
- `harness_paths`：测试框架、脚本、AppMock、设备桥接、证据缓存与 reviewer；
- `unrelated_paths`：未包含在任务范围内的其他改动。

发现 `unrelated_paths` 时先隔离，不得把它们纳入任一 PASS。

## 输出

```text
Acceptance Route
  task_origin:
  scope_kind:
  protocols:
  change_type:
  risk_tier:
  project_task_id:
  story_point_id:
  source_refs:
  target_repositories:
  project_paths:
  story_target_paths:
  harness_paths:
  unrelated_paths:
  routing_evidence:
  routing_unknowns:
```

路由结果本身不是验收结论。
