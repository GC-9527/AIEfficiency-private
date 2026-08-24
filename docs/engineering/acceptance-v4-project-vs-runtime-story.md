# 工程任务与运行态故事点双轨验收架构 v4.1

## 1. 真正需要拆分的不是“开发”和“修 BUG”

开发与修 BUG 都可能出现在两个不同验收域：

| 验收域 | 典型场景 | 验收对象 |
|---|---|---|
| PROJECT_ENGINEERING | Codex 直接开发 DevBench、AI 工作台、Gateway、编排器或修复这些工程的 BUG | 当前工程候选本身 |
| STORY_DELIVERY | 平台运行后，网页中的内部故事点驱动 Android App、SDK、后端或其他目标工程开发/修复 | 单个故事点的目标候选 |

因此正确的第一维不是 `FEATURE vs BUG`，而是 `验收对象/执行上下文`。在每个域内部，再按 FEATURE、DEFECT_FIX 等 change_type 选择门禁。

## 2. 为什么当前单协议会变慢和返工

单一协议容易产生四种错误：

1. 直接修改平台 UI，也被要求构建某个 Flavor、准备设备/AppMock；
2. 单个故事点通过后，被误写成整个平台可以生产上线；
3. 验收脚本或连接器故障时，AI 为了 PASS 去修改目标业务代码；
4. 平台与故事点的候选、证据、修复预算和状态混在一起，任何小改动都触发全量复验。

双轨方案共享底层执行引擎，但分离对象、结论与副作用。

## 3. 两层路由模型

### task_origin

- `DIRECT_ENGINEERING`：任务直接作用于当前工程；
- `RUNTIME_STORY_POINT`：任务由运行平台创建的内部故事点驱动。

### scope_kind

- `PROJECT_ENGINEERING`；
- `STORY_DELIVERY`；
- `DUAL_SCOPE`。

`task_origin` 解决“任务从哪里执行”，`scope_kind` 解决“哪些候选需要被验收”。两者分开后，可以正确处理“运行态故事点恰好修改平台自身”的场景。

## 4. 来源系统不参与技术路由

外部来源只负责：

- 身份与权限；
- 字段读取和映射；
- 评论/附件同步；
- 原始状态和状态回写；
- 幂等键与错误恢复。

技术门禁由以下因素决定：

```text
change_type + risk_tier + target_scope + candidate + environment
```

因此同样是公共 SDK 修改，无论来自飞书还是 JIRA，都应进入 STORY-CRITICAL；同样是局部文案调整，也不应因为来自某个平台而自动升级。

## 5. 工程任务流程

```text
直接工程任务
  → Acceptance Router
  → PROJECT-QUICK（开发中）
  → PROJECT-STANDARD（开发/修复完成）
  → Project Change Decision: ACCEPTED
  → 形成最终候选时 PROJECT-RELEASE
  → Project Production Readiness: READY
```

工程功能与工程缺陷共享协议，但使用不同 change_type 门禁。最终发布验收不应在每次局部开发完成后重复执行。

## 6. 运行态故事点流程

```text
外部来源/手工输入
  → Connector 取数
  → Canonical StoryPoint + immutable source snapshot
  → Acceptance Router
  → STORY-FAST/STANDARD/CRITICAL
  → Story Point Decision
  → Source Sync Decision
  → 幂等回写到一个或多个来源
```

技术结论与回写状态独立：来源 API 暂时失败不能抹掉已经成立的技术证据，也不能把技术失败伪装成同步失败。

## 7. DUAL_SCOPE

### 场景 A：故事点修目标业务代码，同时发现 AppMock/编排器缺陷

- 目标业务候选继续按故事点证据判断；
- HARNESS 缺陷创建独立工程任务；
- 不允许为绕过 HARNESS 修改正确的业务代码；
- 平台修复完成后只恢复相关失效门禁。

### 场景 B：故事点目标就是平台自身

- 先给出该故事点是否满足验收标准的 `Story Point Decision`；
- 若准备部署该平台代码，再执行 `PROJECT-RELEASE`；
- `VERIFIED` 与 `READY` 必须分别显示。

## 8. 轻量与可信如何同时实现

- root `AGENTS.md` 只保留路由与边界，详细流程按需加载 Skill；
- 普通工程任务使用 PROJECT-STANDARD，不重复完整安装升级；
- 普通故事点使用 STORY-STANDARD，reviewer 默认只复核证据，不重复全量测试；
- 修复后按候选输入精准失效，不从头重跑；
- 自动修复最多两轮；
- 只有高风险和最终发布才独立重跑关键门禁。

## 9. 推荐状态机

```text
PROJECT:
  IN_PROGRESS → QUICK_CHECKED → STANDARD_ACCEPTED → RELEASE_READY
                               ↘ PARTIAL / REJECTED

STORY:
  NORMALIZED → CANDIDATE_FROZEN → ASSURANCE_RUNNING
             → VERIFIED → SYNC_PENDING → SYNCED
             ↘ PARTIAL / BLOCKED      ↘ SYNC_FAILED
```

两个状态机通过关联 ID 连接，不合并成一个 PASS 字段。

## 10. 生产门禁最低要求

### Project Standard

- 范围、构建、受影响测试、契约、相关 E2E、错误/恢复路径、剩余风险。

### Project Release

- 最终制品、部署拓扑、升级/回滚、安全、并发/恢复、可观测性、golden story replay、独立审查。

### Story Standard

- 来源事实、候选身份、change_type 对应证据、Must Preserve、影响矩阵、目标构建、真实/等价运行、只读证据复核。

### Story Critical

- 扩展消费者/Flavor/SDK/环境矩阵、故障/并发/迁移/升级、独立关键门禁重跑、灰度监控与回滚。
