---
name: project-engineering-acceptance
description: 对当前工程或 AIEfficiency 平台本身的功能开发、缺陷修复、重构、配置、制品、测试设施和正式发布执行分级、增量、可审计验收。不得用于替代运行态故事点的交付验收。
---

# Project Engineering Acceptance v4.1

## 1. 验收对象与结论

对象是当前工程候选：AIEfficiency、DevBench、AI 工作台、编排器、Gateway、调度器、连接器框架、验收引擎、安装升级能力或当前直接开发的产品工程。

输出两个维度：

```text
Project Change Decision: ACCEPTED | PARTIAL | REJECTED | NOT_ASSESSED
Project Production Readiness: READY | NOT_READY | NOT_ASSESSED
```

`PROJECT-STANDARD` 通过只能证明本次工程任务可交付；只有 `PROJECT-RELEASE` 通过才允许 `READY`。

## 2. 候选冻结

记录：

- `project_task_id/release_id`；
- base、HEAD、worktree diff hash；
- 受影响模块、公共协议、配置、依赖、数据库和安装/升级脚本；
- 目标 OS、中心机/Worker/浏览器/桌面网关拓扑；
- 制品/镜像/安装包及哈希；
- 测试环境与外部依赖标识；
- change_type 与风险级别；
- 是否修改故事点规范化、风险分类、门禁、缓存、reviewer、决策或来源回写逻辑。

## 3. 模式

### PROJECT-QUICK

用于开发期和局部自检：

1. 差异与范围预检；
2. 受影响模块 lint/typecheck/compile；
3. 定向单元测试或可重复局部验证；
4. 只在直接相关时执行局部 UI/API smoke。

结论最多为 `NOT_ASSESSED`，不得宣布任务最终完成或生产可用。

### PROJECT-STANDARD

功能、缺陷修复或里程碑完成后的默认模式：

1. PROJECT-QUICK；
2. 与 change_type 对应的专项门禁；
3. 受影响模块单元、集成和契约测试；
4. 可交付构建；
5. 至少一条直接相关的端到端工程路径；
6. 适用的错误、取消、超时、重试、幂等与恢复路径；
7. 配置兼容、数据迁移、权限和可观测性影响；
8. 若修改来源连接器，验证取数、规范化、附件/评论、幂等回写和失败隔离。

通过后可输出 `Project Change Decision: ACCEPTED`；生产就绪仍为 `NOT_ASSESSED`。

### PROJECT-RELEASE

正式部署、升级或高风险平台变更：

除 PROJECT-STANDARD 外必须验证：

1. 最终制品身份与可重复构建；
2. 安装、启动、停止、重启、升级、回滚或恢复；
3. 登录、认证、授权、密钥和敏感信息边界；
4. 队列、并发、锁、Worker/设备断连、任务恢复、重试去重和失败隔离；
5. 生产等价中心机、工作机、浏览器或桌面网关拓扑；
6. 日志、指标、告警、审计、容量、资源上限和长任务稳定性；
7. 隔离 golden story cases，覆盖成功、业务失败、证据不足、HARNESS、ENVIRONMENT 和 SOURCE_CONNECTOR；
8. 一个只读独立 reviewer。

全部强制门禁通过后，才能输出 `Project Production Readiness: READY`。

## 4. 按 change_type 选择工程专项门禁

### FEATURE

- 验收标准与实现/测试/运行证据双向追踪；
- 正向、错误、取消、重试、权限和边界场景中的适用项；
- 旧行为、公共协议、配置和消费者兼容；
- 灰度、开关、降级或回滚中的适用项。

### DEFECT_FIX

- 复现或独立确定性缺陷证据；
- `symptom → input/state → execution path → faulty condition → output` 根因链；
- 主要竞争假设与排除证据；
- Must Change / Must Preserve；
- 基线红/候选绿或等价差分；
- 直接、边界/错误和相邻回归。

### REFACTOR

- 外部行为、API、协议和配置兼容契约；
- 改造前后测试、golden output 或接口响应等价；
- 主要消费者与目标平台构建；
- 性能、资源和稳定性无不可接受退化；
- 禁止借重构暗改业务规则。

### CONFIG_OR_DATA

- schema、格式、范围和默认值校验；
- 环境差异、dry-run/preflight；
- 幂等、兼容、备份、恢复和回滚；
- 错误配置、部分失败和重复执行。

### PACKAGE_OR_RELEASE

必须验证最终制品本身的版本、哈希、签名、依赖、安装、启动、升级、回滚和核心运行路径。源码存在或编译成功不能替代制品运行验证。

### TEST_OR_HARNESS

必须验证测试/验收设施在错误实现上会失败、正确实现上会通过；使用 golden cases、mutation、reverse patch、旧稳定 runner 或独立 CI，禁止被修改的验收器自证。

### REVIEW_OR_ANALYSIS / DOCUMENTATION

默认只读并按真实性执行轻量检查；不虚构运行 PASS，不强制无关全量构建。

### MIXED

优先拆分。无法拆分时合并所有命中的门禁并采用最高风险级别。

## 5. 工程验收矩阵

每项标记 `PASS | NOT_APPLICABLE | UNKNOWN` 并提供依据：

1. Web/UI 与 Gateway/API 契约；
2. 编排状态机、取消、暂停、恢复与幂等；
3. 队列、调度、并发、设备/Worker 锁；
4. 认证、权限、用户/租户隔离与审计；
5. 数据模型、缓存、迁移、备份与恢复；
6. 多来源连接器与 StoryPoint 规范化；
7. 模型/Agent 适配、超时、限流与降级；
8. 构建、打包、安装、启动、升级与自更新；
9. Windows/Linux、中心机/工作机与版本兼容；
10. 日志、指标、告警、诊断与隐私脱敏；
11. 性能、容量、资源泄漏与长任务稳定性；
12. 验收体系的假阳性、假阴性和缓存误复用。

关键项为 `UNKNOWN` 时不得 `ACCEPTED/READY`。

## 6. 反自证规则

修改下列任何能力时，必须使用旧稳定版本、独立 CI 或固定 golden story cases 作为外部 Oracle：

- AcceptanceRouter；
- StoryPoint 规范化；
- 风险分类与 gate mapping；
- PASS/VERIFIED 决策；
- 证据缓存与精准失效；
- reviewer prompt；
- 来源工单自动推进/回写策略。

Golden cases 至少覆盖：应通过、应阻断、证据不足、HARNESS_DEFECT、SOURCE_CONNECTOR、ENVIRONMENT、多仓/SDK/多 Flavor 高风险。

## 7. 门禁 DAG、Finding 与有限修复

默认 DAG：

`P0 Scope → P1 Static → P2 Unit → P3 Integration/Contract → P4 Build → P5 Engineering E2E → P6 Deploy/Resilience/Security → P7 Golden Replay → P8 Independent Review → P9 Decision`

Finding 字段：`severity`、`ownership`、`blocking`、`behavior`、`evidence`、`minimal_fix`、`invalidated_gates`。

默认验收只读。用户要求“验收并修复”时最多 2 轮，只修当前工程候选的 `INTRODUCED` 阻断项，并只重跑失效门禁。

## 8. 输出

```text
Protocol: PROJECT_ENGINEERING
Mode: PROJECT-QUICK | PROJECT-STANDARD | PROJECT-RELEASE
Change Type:
Project Task/Release ID:
Candidate:
Changed Scope:
Acceptance Criteria Traceability:
Project Acceptance Matrix:
Gates:
Golden Story Replay: PASS | FAIL | NOT_APPLICABLE
Independent Review: PASS | BLOCKED | NOT_REQUIRED
Blocking Findings:
Non-blocking Findings:
Repair Rounds: 0 | 1 | 2
Unknowns:
Residual Risk:
Project Change Decision: ACCEPTED | PARTIAL | REJECTED | NOT_ASSESSED
Project Production Readiness: READY | NOT_READY | NOT_ASSESSED
```
