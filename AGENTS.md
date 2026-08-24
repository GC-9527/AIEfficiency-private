# AIEfficiency Codex Rules v4.1 — 工程任务与运行态故事点双轨验收

## 1. 先路由，再开发或验收

- 在开始实质开发、修复或验收前，必须先确定任务来源与验收对象；禁止把“当前工程自身的交付验收”与“工程运行后生成的故事点交付验收”混为一次验收。
- `task_origin` 只能是：
  - `DIRECT_ENGINEERING`：用户、开发者或编排器直接要求修改当前工程；
  - `RUNTIME_STORY_POINT`：运行中的平台已经创建内部故事点，并提供稳定的 `story_point_id` 与故事点快照。
- `scope_kind` 只能是：
  - `PROJECT_ENGINEERING`：验收当前工程/平台本身的代码、配置、制品、部署或修复；
  - `STORY_DELIVERY`：验收某个运行态故事点在其目标业务工程中的交付；
  - `DUAL_SCOPE`：同一任务同时修改平台/验收基础设施与故事点目标工程，必须拆成两套候选和结论。
- Teambition、飞书、JIRA、Redmine、GitHub/GitLab、邮件、API 或手工输入只是 `source_system`；来源系统不得直接决定技术验收协议、风险级别或 PASS 标准。
- 在首个写入动作前输出并保存：

```text
Acceptance Route
  task_origin: DIRECT_ENGINEERING | RUNTIME_STORY_POINT
  scope_kind: PROJECT_ENGINEERING | STORY_DELIVERY | DUAL_SCOPE
  protocols: project-engineering-acceptance | runtime-story-point-assurance | both
  change_type: FEATURE | DEFECT_FIX | REFACTOR | CONFIG_OR_DATA | PACKAGE_OR_RELEASE | TEST_OR_HARNESS | REVIEW_OR_ANALYSIS | DOCUMENTATION | MIXED
  risk_tier: AUTO | <resolved tier>
  target_repositories: ...
  project_task_id: ...
  story_point_id: ...            # 仅运行态故事点必填
  source_system/source_issue_id: # 仅来源追踪，不参与协议选择
```

- 路由不明确时使用 `$acceptance-router`。缺少 `story_point_id` 或不可变故事点快照时，不得把一张外部工单直接冒充为运行态故事点。

## 2. 协议 A：当前工程自身的开发/修复验收

当 `scope_kind=PROJECT_ENGINEERING` 时使用 `$project-engineering-acceptance`。

- `PROJECT-QUICK`：开发期受影响范围检查；不能声明任务已完成或可上线。
- `PROJECT-STANDARD`：功能、缺陷修复或里程碑完成后的默认验收；可以输出 `Project Change Decision: ACCEPTED`，但不能因此输出生产 `READY`。
- `PROJECT-RELEASE`：正式部署、升级或高风险发布前执行；只有该模式通过才能输出 `Project Production Readiness: READY`。
- 工程缺陷修复应验证该工程自身的复现、根因、回归、契约和运行路径；工程功能开发应验证验收标准、异常路径、兼容和部署影响。
- 只有改动确实涉及设备、AppMock、特定 Flavor、签名或安装时，工程协议才运行这些门禁；禁止机械套用故事点的设备验收流程。
- 平台端到端测试只能使用隔离测试账号、沙箱来源或固定 golden story cases，不得不可逆推进真实生产工单。

工程协议输出两个互不替代的结论：

```text
Project Change Decision: ACCEPTED | PARTIAL | REJECTED | NOT_ASSESSED
Project Production Readiness: READY | NOT_READY | NOT_ASSESSED
```

## 3. 协议 B：运行中网页内故事点的交付验收

当 `scope_kind=STORY_DELIVERY` 时使用 `$runtime-story-point-assurance`。

- 外部工单必须先规范化为内部 StoryPoint；一个故事点可关联一个或多个来源，但必须有唯一内部 `story_point_id`。
- 技术门禁由 `change_type + risk_tier + target_scope` 决定，不由来源平台决定。
- 风险模式：
  - `STORY-FAST`：低风险、局部且确定性证据充分；
  - `STORY-STANDARD`：默认；
  - `STORY-CRITICAL`：安全、权限、持久/敏感数据、并发、公共 API/SDK、多仓、多 Flavor、签名打包、安装升级、生产配置、不可逆操作或影响面不明。
- `DEFECT_FIX` 必须有复现或独立缺陷证据、根因链、主要竞争假设、Must Change/Must Preserve、基线红/候选绿或等价差分证据。
- `FEATURE`、`REFACTOR`、`CONFIG_OR_DATA`、`PACKAGE_OR_RELEASE` 等类型使用各自门禁；不存在缺陷基线时不得伪造“修复前失败”。
- 故事点 `VERIFIED` 只证明该故事点在冻结候选、环境和覆盖范围内证据充分，不代表当前平台工程整体可上线，也不代表目标产品绝对不存在其他缺陷。

故事点协议输出：

```text
Story Point Decision: VERIFIED | PARTIAL | BLOCKED | NOT_APPLICABLE
Source Sync Decision: ALLOWED | MANUAL_APPROVAL | DENIED
Source Sync Status: NOT_ATTEMPTED | SUCCEEDED | FAILED | PARTIAL
```

外部来源回写是独立副作用。技术验收已 `VERIFIED` 后回写失败，保持技术结论，单独记录 `SOURCE_CONNECTOR` Finding 并幂等重试。

## 4. 双范围任务必须拆分结论

- 当运行态故事点同时修改平台/编排器/验收器和目标业务工程时，标记 `DUAL_SCOPE`。
- 平台候选走 `$project-engineering-acceptance`；故事点候选走 `$runtime-story-point-assurance`。
- 两条流程必须使用不同的候选身份、证据目录、Finding 集合、修复预算和最终结论；禁止输出一个混合 `PASS`。
- 若故事点目标本身就是平台仓库，仍需先给出故事点交付结论；在部署该平台改动前，另行完成 `PROJECT-RELEASE`。
- 若故事点验收发现 `HARNESS_DEFECT` 或 `SOURCE_CONNECTOR`，停止通过修改目标业务代码规避，创建关联工程任务；平台修复完成后仅恢复被该修复失效的故事点门禁。

## 5. 共享证据与防幻觉规则

- 冻结候选：基线、HEAD、工作区差异哈希、依赖/配置哈希、目标环境和最终制品哈希；多仓故事点对每个仓库分别冻结。
- 运行态故事点还必须冻结来源快照、快照哈希、抓取时间、验收标准以及实际读取/未读取的评论、附件、日志、图片和视频。
- 关键陈述必须标记 `FACT | INFERENCE | UNKNOWN`；`FACT` 必须关联原始、可重复的非 LLM 证据。
- AI 新增的测试不能单独证明自己正确。缺陷回归优先证明同一判据在基线失败、候选通过；否则使用反向补丁、mutation、golden output、既有测试、真实设备、协议或数据库结果等独立 Oracle。
- 编译成功不等于功能正确；mock 只证明 mock 范围；截图只证明画面；单个成功路径不证明异常、并发、安全或兼容性正确。
- 不得声称“已全面考虑”“完全没有问题”或“绝对无缺陷”。必须输出影响矩阵、未执行门禁、`UNKNOWN` 和剩余风险。
- 候选、来源快照、制品、环境或设备证据不一致时，不得输出 `ACCEPTED/READY/VERIFIED`。

## 6. Finding 归属与修复边界

Finding 必须标记：

- `INTRODUCED`：当前候选引入；
- `PRE_EXISTING`：基线已有；
- `HARNESS_DEFECT`：平台、编排器、Agent、脚本、设备、AppMock、测试框架或证据设施问题；
- `SOURCE_CONNECTOR`：来源取数、字段映射、权限或状态回写问题；
- `ENVIRONMENT`：账号、网络、后端、数据库、设备或外部依赖环境问题；
- `UNKNOWN`：证据不足。

默认只自动修复当前协议候选中的 `INTRODUCED` 阻断项。不得顺手修复范围外问题，不得通过降低断言、改写验收标准、污染环境或修改无关代码来获得 PASS。

## 7. 轻量增量复验与停止条件

- 门禁按依赖 DAG 执行，失败后停止无意义的下游任务。
- 修复后只重跑失败门禁、被修改输入失效的门禁及必要最终 smoke；禁止无条件从头全量重跑。
- 同一候选只允许一个写入 Agent；独立 reviewer 保持只读。
- 每个协议最多自动修复 2 轮，每轮只实施最小补丁；仍失败则停止并输出 `PARTIAL/BLOCKED/REJECTED/NOT_READY`。
- `PROJECT-QUICK` 与 `STORY-FAST` 不强制子代理；`PROJECT-RELEASE` 必须独立复核；`STORY-STANDARD` 默认只做一次只读证据复核，`STORY-CRITICAL` 才独立重跑最关键的 1–3 个门禁。

## 8. 报告与持久化记忆

- 开始工作时明确当前问题、路由、范围和禁止范围。
- 最终或阶段报告必须列出：实际读取材料、未读取材料及原因、执行动作、命令与退出码、产物、代码/配置变化、行为影响、Finding、未覆盖项、剩余风险和最终结论。
- 不得声称读取了实际未检查的附件、视频、图片或日志。
- 聊天内容和临时报告不是持久工程记忆。可复现缺陷、关键根因、回归测试和保护措施应沉淀到 `docs/engineering/regression-ledger.md`、自动化测试或构建/运行门禁。
- 对安全、权限、数据、并发、公共协议、打包安装、重复缺陷和高影响缺陷，回归用例与 ledger 为强制项；低风险局部问题无法合理自动化时，必须说明替代证据和剩余风险。

## 9. Git 与提交卫生

- 使用 `git rev-parse --show-toplevel` 获取仓库根目录，不写死机器绝对路径。
- 任务开始、首次写入、破坏性 Git 操作前和提交前检查 `git status -sb`、工作区/暂存区差异及隐藏索引标记；发现 `skip-worktree` 或 `assume-unchanged` 必须先报告并检查真实差异。
- 将暂存区视为不可信。使用精确 pathspec 或交互式暂存；禁止日常使用 `git add .`；提交前检查 `git diff --cached --name-status`、`--stat` 和完整差异。
- 提交说明正文使用中文；Conventional Commit 的 type/scope 可保留英文。
- 平台代码、故事点目标代码、测试、仓库规则和本地配置按关注点拆分提交。不得把 `AGENTS.md`、`.codex/**` 等仓库规则与无关产品代码混在同一提交。
- `start.ps1`、`stop.*`、`web-dashboard/vite.config.js`、`gateway/config.json` 和本地运行配置属于高风险文件，暂存前必须确认是本任务的有意改动。

## 10. 临时产物与证据目录

- AI 生成的报告、一次性脚本、日志、trace、截图、录像、图片、压缩包、运行输出和制品默认不暂存、不提交。
- 工程验收证据放在 `docs/tempFiles/project-acceptance/<project-task-or-release-id>/<candidate-id>/`。
- 故事点验收证据放在 `docs/tempFiles/story-point-acceptance/<story-point-id>/<candidate-id>/`。
- 未经明确要求，不提交 `docs/PerformanceReports/`、`docs/devbench/script*/`、`docs/devbench/day*/performance/`、`docs/devbench/day*/ask_*.txt` 或上述临时证据目录。

<!-- AIEFFICIENCY_FULLSTACK_QUALITY:START -->
## AIEfficiency 全栈/UI 质量门禁

当任务涉及前端、UI/UX、布局、样式、路由、弹窗/侧栏/悬浮层、加载性能、API、权限、数据库、全栈 BUG 修复、代码评审或发布验收时：

1. 必须先读取 `.agents/skills/aiefficiency-fullstack-quality/SKILL.md` 并按其流程执行。
2. 在改代码前构建影响图；UI 改动不得只验证修改页，必须覆盖共享壳和关联路由。
3. 优先运行该 SKILL 的 `quality-gate.mjs`；缺工具时手工执行同等检查并明确 `SKIPPED`，不得伪造通过。
4. 不得复制 SKILL 到其他 AI 目录；Claude 目录只允许链接到 canonical `.agents/skills`。
<!-- AIEFFICIENCY_FULLSTACK_QUALITY:END -->

<!-- intent-impact-guard:start -->
## Mandatory intent and impact gate

Before editing for any request that describes missing/broken behavior, ambiguous intent, login/auth/permissions/routes/navigation/UI/shared code/public API/SDK/data-source/Flavor changes, deletion, migration, or refactoring, load and follow `.agents/skills/intent-impact-guard/SKILL.md`. A symptom is not an implementation decision. Do not write until its PREWRITE status is `READY`; preserve verified invariants, use the smallest reversible change, and verify the regression radius. High-risk ambiguity stays read-only as `BLOCKED_NEEDS_DECISION`.
<!-- intent-impact-guard:end -->

<!-- AIEFFICIENCY_VISUAL_OPERATION_GUARD:BEGIN -->
<!-- managed-version: 1.0.0 -->
## 本工程高效操作与视觉门禁

本工程的操作与视觉自动化以以下文件为事实来源：

- `.ai/visual-operation-guard/policy.json`
- `.ai/operation-map.json`
- `.agents/skills/efficient-ui-operation/SKILL.md`

执行网页、桌面、模拟器或真机操作前：

1. 先在 operation-map 查找已验证策略。
2. 再检查源码、脚本、路由、接口、ADB、DOM、Accessibility 和现有测试工具。
3. 只有结构化方式均不可用且视觉预算允许时，才请求视觉工具授权。
4. 所有 screenshot、computer-use 坐标点击、视觉输入必须经过 Visual Operation Guard；禁止直接调用底层工具绕过门禁。
5. 工具调用必须依次执行 `authorize → begin → real tool → result`；未获得 `EXECUTION_STARTED` 不得执行真实工具。
6. 工具执行后必须回报是否有进展、screenFingerprint、检查点和真实 usage（若工具提供）；异常路径也必须回报失败结果。
7. 成功发现新的高效入口后，补充到 `.ai/operation-map.json`，不得让后续任务重复探索。

故事点/工单修复默认使用 `balanced`；工程上线验收使用 `acceptance`；24 小时自动任务使用 `unattended`；CI 使用 `strict_ci`。

UI 是本次验收对象时，Arrange 可以结构化准备，但 Act 必须真实执行核心 UI 交互。不得以直接修改数据库、配置或内部状态替代核心交互。

发生人工接管时，必须输出固定格式 NEEDS_USER_ACTION，保存恢复检查点。用户完成后从检查点恢复，不从头导航。
<!-- AIEFFICIENCY_VISUAL_OPERATION_GUARD:END -->
