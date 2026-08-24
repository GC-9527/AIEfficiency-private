---
name: story-acceptance-protocol
description: 已弃用的兼容入口。旧调用必须先路由到工程验收或运行态故事点验收，不再直接执行单一混合协议。
---

# Story Acceptance Protocol compatibility alias

> Deprecated：本入口仅用于兼容历史调用，不再拥有独立门禁或 PASS 语义。

1. 先完整读取并执行同级 `../acceptance-router/SKILL.md`。
2. `PROJECT_ENGINEERING` 路由到同级 `../project-engineering-acceptance/SKILL.md`。
3. `STORY_DELIVERY` 路由到同级 `../runtime-story-point-assurance/SKILL.md`。
4. `DUAL_SCOPE` 分别执行两套协议，候选、证据、Finding、修复预算与结论互相隔离。
5. 只有外部工单、缺少稳定 `story_point_id` 或不可变来源快照时，输出 `BLOCKED_ROUTING`，不得继续沿用旧单协议。

下文保留为历史说明，不得作为新任务的执行规则。

# Historical Story Acceptance Protocol v2

## 目标

以风险为基础选择最低充分验收级别，优先运行确定性门禁，复用仍然有效的证据；发现问题时只修复当前差异引入的阻断问题，并按依赖关系增量复验，避免“发现一个问题 → 全量返工 → 从头验收”的循环。

## 一、建立候选快照

从仓库和任务上下文获取并记录：

- 任务/故事点 ID、目标行为和明确验收标准；
- 基线分支或提交、当前 `HEAD`、工作区和暂存区差异；
- 改动文件、模块、公共接口、依赖锁文件和运行配置；
- 目标环境、后端环境、Flavor/构建变体、设备或 AppMock 范围；
- 仓库已有的构建、测试、lint、typecheck、smoke 和部署脚本。

候选标识至少包含：`base + HEAD + worktree diff hash + dependency/config hash + environment id`。任一输入变化时，只失效依赖该输入的门禁结果。

## 二、风险与模式选择

选择最高适用风险，不要为低风险任务默认升级。

### QUICK

适用：开发期自检、文档/测试/局部 UI、小范围确定性修复、修复后的快速复验。

必须门禁：

1. 范围/差异预检；
2. 受影响模块静态、类型或编译检查；
3. 与改动直接相关的定向测试或可重复复验。

禁止：完整设备流程、全量截图/录像、独立子代理、无关模块全仓扫描。

### STANDARD

适用：普通故事点最终交付、非高风险 API/UI/后台功能。

必须门禁：

1. QUICK 全部；
2. 受影响模块单元/集成测试；
3. 构建受影响可交付制品或生产等价变体；
4. 一条与改动直接相关的关键 smoke 路径；
5. 仅采集能证明验收结论的必要证据。

### RELEASE

适用：明确生产上线，或认证/权限/数据/迁移/并发/调度/签名/打包/升级/部署/公共协议/关键 SDK/大范围重构等高风险范围。

必须门禁：

1. STANDARD 全部；
2. 冻结最终候选并构建最终制品；
3. 记录制品哈希、构建环境和运行环境；
4. 验证安装/启动/升级或部署、关键生产路径以及必要的回滚能力；
5. 只读独立复核；必要时在隔离 worktree 对最关键门禁进行独立重跑；
6. 所有强制门禁通过后才能输出 `Production Decision: READY`。

## 三、门禁 DAG

默认依赖图：

`G0 Scope/Repo → G1 Static/Type → G2 Targeted Tests → G3 Integration → G4 Build/Package → G5 Critical Smoke → G6 Independent Review → G7 Decision`

执行规则：

- G1 中互不依赖的静态检查可并行；G2 中不同模块的只读测试可并行。
- 任何写代码行为只能由一个主 Agent 负责；独立审查者不得写入主工作区。
- 门禁失败时停止启动依赖它的下游门禁，优先失败快速返回。
- 已通过门禁只有在其输入保持不变时才能复用。
- 源码改变通常使受影响测试、构建和 smoke 失效；文档或无运行行为变化不应使制品门禁失效。
- 公共协议、依赖锁、打包/签名、启动配置或环境变化会使更广泛的下游证据失效。

## 四、Finding 分类

每个 finding 使用以下字段：

- `severity`: P0 / P1 / P2 / P3；
- `ownership`: INTRODUCED / PRE_EXISTING / UNKNOWN；
- `blocking`: true / false；
- `behavior`: 受影响行为；
- `evidence`: 文件、日志、命令或可复现步骤；
- `minimal_fix`: 最小修复方向；
- `invalidated_gates`: 修复后必须重跑的门禁。

默认阻断条件：

- INTRODUCED 且违反验收标准；
- 构建、目标测试、关键 smoke 或生产启动失败；
- P0/P1 安全、数据、权限、错误制品或不可恢复升级问题；
- 用户明确指定的强制门禁失败。

默认不阻断：

- 未被当前差异改变的 PRE_EXISTING 问题；
- P3 风格、命名、注释和非功能性建议；
- 没有可复现证据的推测性问题；
- 不属于本任务范围的改进建议。

## 五、受限修复循环

仅当任务明确要求“验收并修复”或编排器允许自动修复时执行，最多 2 轮。

每轮流程：

1. 确认 finding 为当前交付阻断项；
2. 保存修复前候选和失败证据；
3. 只修改最小必要文件/代码块，不重构无关区域；
4. 运行修复点的最小复现或测试；
5. 重跑 `invalidated_gates` 和最终关键 smoke；
6. 更新候选标识、制品哈希和报告。

以下情况重新执行完整 RELEASE，而不是局部复验：

- 修复触及认证、权限、数据迁移、并发/调度、公共协议或部署边界；
- 修改依赖锁、打包、签名、安装、启动或生产配置；
- 更换验证环境；
- 独立审查证明已有证据不再有效；
- 无法确定影响范围。

超过修复预算后停止，输出 `BLOCKED`；不得继续机会主义修复或无限循环。

## 六、独立复核

- QUICK：不启动。
- STANDARD：仅当跨模块、证据冲突、测试覆盖不足或用户要求时启动。
- RELEASE：必须启动。

独立复核者接收：任务标准、候选标识、差异、门禁清单、原始命令结果和制品哈希；不接收主 Agent 的结论性措辞。

独立复核者默认只读：

- 检查验收标准是否被真实覆盖；
- 检查 finding 是否有证据且属于当前差异；
- 检查制品、环境和运行证据是否对应同一候选；
- 只在证据含糊或高风险时建议独立重跑关键门禁；
- 不直接修复代码，不重复全部测试，不把风格建议升级为阻断。

## 七、回归沉淀

- P0/P1、生产事故、重复缺陷、打包/升级、数据或安全缺陷：必须增加自动化门禁/保护并更新 `docs/engineering/regression-ledger.md`。
- 普通 P2：优先增加针对当前行为的测试；只有经验可跨任务复用时才更新台账。
- P3 或无行为变化：不强制台账。
- 若无法自动化，记录原因、可重复手工/脚本步骤、证据和剩余风险。

## 八、输出

最终只输出以下结构：

```text
Result: PASS | BLOCKED
Mode: QUICK | STANDARD | RELEASE
Candidate: <base/head/diff/environment>
Changed Scope: <modules/files>
Gates:
  - <gate>: PASS|FAIL|SKIPPED — <evidence>
Blocking Findings:
  - <none or structured finding>
Non-blocking Findings:
  - <pre-existing/out-of-scope observations>
Repair Rounds: 0|1|2
Residual Risk: <uncovered or waived gates>
Production Decision: READY | NOT_READY | NOT_ASSESSED
```

判定：

- QUICK/ STANDARD 通过：`Result: PASS`，`Production Decision: NOT_ASSESSED`；
- RELEASE 全部强制门禁通过：`Result: PASS`，`Production Decision: READY`；
- 任一阻断门禁失败、证据与候选不一致、或修复预算耗尽：`Result: BLOCKED`，`Production Decision: NOT_READY`。
