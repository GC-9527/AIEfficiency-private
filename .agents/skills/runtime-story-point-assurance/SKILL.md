---
name: runtime-story-point-assurance
description: 对运行中的平台把 Teambition、飞书、JIRA、Redmine、GitHub/GitLab、邮件、API、手工输入或其他来源规范化后形成的内部故事点执行来源无关、类型感知、风险分级、证据约束和增量验收。不得用于判断平台工程整体是否可发布。
---

# Runtime Story Point Assurance v4.1

## 1. 目标与结论边界

本协议证明：

> 在冻结的来源快照、故事点验收标准、目标仓库候选、指定环境和明确风险覆盖范围内，该故事点达到可验证交付结果，且没有发现阻断回归。

它不能证明整个目标产品绝对没有缺陷，也不能替代当前平台工程的开发/发布验收。

## 2. 来源规范化与事实包

外部工单必须先转换为内部 StoryPoint。至少保存：

- 唯一 `story_point_id`；
- 一个主来源和零个或多个关联来源：`source_system/source_issue_id/source_url/source_type/source_status`；
- 不可变原始快照、快照哈希、抓取时间和字段映射版本；
- 标题、描述、评论、附件、日志、图片、视频；
- 实际读取材料、未读取材料及原因；
- 目标工程、仓库、分支、Flavor/变体、后端环境、设备/AppMock；
- 验收标准、Must Change、Must Preserve 和禁止范围。

信息分为 `FACT | INFERENCE | UNKNOWN`。来源冲突必须保留，不得静默选择有利于通过的版本。

若验收期间来源快照或验收标准改变，必须使相关事实、测试和结论失效；不得沿用旧证据静默通过。

## 3. 两个正交维度

### change_type：决定验证什么

- `DEFECT_FIX`；
- `FEATURE`；
- `REFACTOR`；
- `CONFIG_OR_DATA`；
- `PACKAGE_OR_RELEASE`；
- `TEST_OR_HARNESS`；
- `REVIEW_OR_ANALYSIS`；
- `DOCUMENTATION`；
- `MIXED`。

### risk_tier：决定验证多深

- `STORY-FAST`：低风险、影响局部、可稳定验证；
- `STORY-STANDARD`：默认；
- `STORY-CRITICAL`：安全、权限、敏感/持久数据、迁移、并发/幂等、公共 API/SDK、多仓、多 Flavor、签名打包、安装升级、生产配置、不可逆操作或影响面不明。

来源系统不是风险级别。不同来源中技术类型和影响范围相同的故事点应获得相同门禁。

## 4. 候选冻结

支持单仓或多仓。每个目标仓库分别记录：

- repository identity；
- base ref、HEAD 和 worktree diff hash；
- dependency/config hash；
- 目标 Flavor/build variant；
- 最终制品与哈希。

记录共享环境：后端、数据库、账号、设备/AppMock、外部服务版本、来源快照哈希和验收规则版本。不同候选、来源快照或环境的证据不得混用。

## 5. 按 change_type 选择故事点门禁

### DEFECT_FIX

必须具备：

1. expected 与 observed behavior；
2. 基线复现，或独立确定性缺陷证据；
3. `symptom → input/state → execution path → faulty condition → output` 根因链；
4. 主要竞争假设及排除证据；
5. Must Change / Must Preserve；
6. 基线红、候选绿或等价差分回归；
7. 直接、边界/错误和相邻回归场景。

### FEATURE

必须具备：

1. 验收标准到实现、测试和运行证据的双向追踪；
2. 正向、无权限、错误、取消、重试和边界场景中的适用项；
3. 旧行为、公共契约、其他消费者/Flavor 的兼容检查；
4. 功能开关、灰度、回滚或降级策略中的适用项。

不存在“修复前失败”时，不得伪造 baseline-red；应使用未实现的验收标准、契约或旧候选行为作为基准。

### REFACTOR

必须证明外部行为和公共 API/协议不变，进行改造前后等价性、主要消费者、多变体构建以及性能/资源退化检查；禁止暗中改变业务规则。

### CONFIG_OR_DATA

必须验证 schema、范围、环境/default 差异、dry-run/preflight、幂等、兼容、备份、恢复、回滚、部分失败和重复执行。

### PACKAGE_OR_RELEASE

必须验证最终制品的哈希、版本、签名、依赖、安装、启动、升级、覆盖安装、回滚/恢复和核心运行行为。源码存在或编译成功不足以证明该故事点通过。

### TEST_OR_HARNESS

必须证明测试在错误实现上失败、正确实现上通过，并检查 golden cases、mutation/reverse-patch、假阳性、假阴性、缓存污染和环境漂移。被修改的测试/验收器不得成为自己的唯一裁判。

### REVIEW_OR_ANALYSIS

默认只读；基于指定 commit/diff/材料给出可定位 Finding，区分事实、风险推断与未知，不修改代码，不虚构运行 PASS。

### DOCUMENTATION

验证文档与真实代码、命令、配置和 UI 一致，示例/链接/路径可用且不泄露秘密；不强制无关全量构建。

### MIXED

优先拆分成可独立验收的故事点或子任务。无法拆分时合并所有命中的门禁并采用最高风险级别。

## 6. 风险模式

### STORY-FAST

最低要求：

1. 完整来源事实包；
2. 与 change_type 匹配的最小差分证据；
3. 受影响模块静态/编译检查；
4. 定向测试；
5. 直接相关 smoke；
6. 无关键 `UNKNOWN`。

不强制独立 reviewer。

### STORY-STANDARD

除 STORY-FAST 外：

1. Must Change / Must Preserve；
2. 影响面矩阵；
3. 直接、边界/错误和相邻场景；
4. 目标变体可交付构建；
5. 一条真实运行或生产等价关键路径；
6. 一个只读 reviewer 复核证据包，默认不重复全部测试。

### STORY-CRITICAL

除 STORY-STANDARD 外：

1. 扩展消费者、仓库、SDK、Flavor、版本和环境兼容矩阵；
2. 必要的故障注入、并发、恢复、迁移或升级/回滚；
3. 真实设备、真实目标变体或生产等价环境；
4. reviewer 在隔离 worktree/环境独立重跑最关键 1–3 个门禁；
5. 灰度、监控、告警和回滚保护。

## 7. 影响面矩阵

每项标记 `PASS | NOT_APPLICABLE | UNKNOWN` 并说明依据：

1. 直接功能、调用者和消费者；
2. 边界值、空值、错误和异常；
3. 状态机、生命周期、并发和幂等；
4. 数据、缓存、持久化、迁移和一致性；
5. 权限、安全、隐私和输入校验；
6. 网络、离线、超时、重试和降级；
7. API、协议和 SDK 向后兼容；
8. 仓库、模块、Flavor、车型、设备、OS 和版本差异；
9. 构建、打包、签名、安装、升级和配置；
10. 性能、内存、线程、资源和容量；
11. 日志、监控、告警、恢复和回滚；
12. HARNESS/来源连接器是否可能造成假阳性或假阴性。

关键项为 `UNKNOWN` 时不得 `VERIFIED`。

## 8. 非 LLM 证据与防同源幻觉

- 每条验收标准至少映射一个可重复判据。
- 新增回归测试应在基线失败、候选通过；无法直接运行基线时，使用反向补丁、mutation、golden output、真实设备、协议/数据库结果等独立 Oracle。
- 断言应基于外部行为或契约，不能复制实现算法、常量或同一错误假设。
- mock 只证明 mock 范围；截图只证明画面；编译只证明构建阶段。
- 命令证据至少包含命令、退出码、候选、环境、时间和原始输出位置。

## 9. Finding、跨轨升级与有限修复

Finding 归属：`INTRODUCED | PRE_EXISTING | HARNESS_DEFECT | SOURCE_CONNECTOR | ENVIRONMENT | UNKNOWN`。

发现 `HARNESS_DEFECT` 或 `SOURCE_CONNECTOR`：

1. 停止通过修改目标业务代码规避；
2. 保存原始证据；
3. 创建关联 `PROJECT_ENGINEERING` 任务；
4. 当前故事点标记 `PARTIAL/BLOCKED_BY_HARNESS`，或在技术已 VERIFIED 时单独标记同步失败；
5. 工程修复通过 `$project-engineering-acceptance` 后，仅恢复被其失效的故事点门禁。

只自动修复当前故事点候选的 `INTRODUCED` 阻断项，最多 2 轮；每轮更新候选哈希并只重跑失效门禁。

## 10. 独立 reviewer

STORY-STANDARD reviewer 接收：

- 原始来源快照与事实包；
- change_type、risk_tier 与验收标准；
- 候选身份与 diff；
- 根因/需求追踪、行为契约与影响矩阵；
- 原始测试、构建、运行和制品证据。

Reviewer 不接受开发 Agent 的结论作为事实。STORY-STANDARD 默认只复核证据；STORY-CRITICAL 独立重跑最关键 1–3 个门禁。

## 11. 故事点结论与来源回写

只有同时满足以下条件才能 `VERIFIED`：

- change_type 要求与风险门禁全部满足；
- 所有强制验收标准有非 LLM 证据；
- 关键影响维度不是 `UNKNOWN`；
- 无阻断 Finding；
- 来源快照、候选、制品和运行证据一致；
- 修复轮数未超预算；
- 必需的独立复核通过。

状态策略：

- `VERIFIED` → `Source Sync Decision: ALLOWED`；
- `PARTIAL` → `MANUAL_APPROVAL`；
- `BLOCKED` → `DENIED`；
- `NOT_APPLICABLE` → 按来源映射策略处理，不得冒充完成。

回写失败不改变已经由技术证据确定的故事点结论，应记录 `Source Sync Status` 并建立 SOURCE_CONNECTOR 平台 Finding。

## 12. 输出

```text
Protocol: RUNTIME_STORY_POINT
Story Point ID:
Primary Source: <system/id/snapshot-hash>
Related Sources:
Change Type:
Risk Tier: STORY-FAST | STORY-STANDARD | STORY-CRITICAL
Story Point Decision: VERIFIED | PARTIAL | BLOCKED | NOT_APPLICABLE
Source Sync Decision: ALLOWED | MANUAL_APPROVAL | DENIED
Source Sync Status: NOT_ATTEMPTED | SUCCEEDED | FAILED | PARTIAL
Candidates:
Facts:
Inferences/Unknowns:
Acceptance Criteria Traceability:
Reproduction/Behavior Baseline:
Root Cause or Change Rationale:
Behavior Contract:
Impact Matrix:
Gates:
Independent Review:
Blocking Findings:
Non-blocking Findings:
Repair Rounds: 0 | 1 | 2
Residual Risk:
```
