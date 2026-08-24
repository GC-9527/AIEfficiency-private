# AIEfficiency TB Skill/MCP Generator v2.0.0 — M0–M2 验证记录

## 1. 结论先行

- `M0 Milestone Decision: PASS`
- `Project Change Decision: NOT_ASSESSED`
- `Project Production Readiness: NOT_ASSESSED`
- `FACT` M0 规定的真实源码扫描、证据清单、当前流程和 BUG 登记已经生成；产品代码、配置、数据库和 Teambition 均未修改。
- `FACT` 本轮模式为 `PROJECT-QUICK`，只证明 M0 文档候选满足阶段门禁，不代表整个生成器完成，也不能声明工程可上线。

## 2. Acceptance Route

```text
Acceptance Route
  task_origin: DIRECT_ENGINEERING
  scope_kind: PROJECT_ENGINEERING
  protocols: project-engineering-acceptance
  change_type: REVIEW_OR_ANALYSIS
  risk_tier: MEDIUM
  target_repositories: 当前 AIEfficiencyTrack 仓库
  project_task_id: SKILLDEV-TB-TOOLKIT-M0-20260823
  story_point_id: N/A
  source_system/source_issue_id: N/A
  mode: PROJECT-QUICK
```

## 3. 候选冻结

| 项 | 值 |
| --- | --- |
| Branch | `feat/admin-rbac` |
| HEAD | `cac55b11b825ab18e0139bbf6dc4a9d8600369ad` |
| Candidate | `cac55b11-m0` |
| Package version | `2.0.0` |
| Package manifest SHA-256 | `AB7CB3BFDFB997A320D05CAA924A5FF91B957262733981590CE2D59C7AE875D4` |
| Runtime | Node.js `24.14.1` |
| Remote TB mutation | disabled / executed=false |

工作区起始即不干净：`features/StoryDev/故事点创建/ask_2.txt` 是用户已有修改，生成包目录是用户提供的未跟踪输入。二者均不属于 M0 候选，未修改、未暂存、未清理。

## 4. 执行命令与结果

| # | 命令 | 退出码 | 结果 | 证据/限制 |
| --- | --- | ---: | --- | --- |
| V01 | `python features/SkillDev/AIEfficiency_TB_Skill_MCP_Generator_v2.0.0/AIEfficiency_TB_Skill_MCP_Generator_v2.0.0/scripts/verify_package.py features/SkillDev/AIEfficiency_TB_Skill_MCP_Generator_v2.0.0/AIEfficiency_TB_Skill_MCP_Generator_v2.0.0` | 0 | `PASS` | `PACKAGE VALIDATION PASSED`；清单和文件哈希一致。 |
| V02 | `node .agents/skills/aiefficiency-fullstack-quality/scripts/doctor.mjs --repo .` | 0 | `PASS_WITH_WARNINGS` | Node、Git、npm、浏览器和本地 HTTP 200 可用；唯一警告为工作区已有改动。 |
| V03 | `node .agents/skills/aiefficiency-fullstack-quality/scripts/impact-map.mjs --repo . --base HEAD` | 0 | `PASS` | 生成包未跟踪文件使推荐模式保守提升为 deep；实际 M0 未改产品/UI 文件。 |
| V04 | `node --test gateway/test/teambition.test.mjs gateway/test/teambition-attachment-buffer.test.mjs gateway/test/teambition-attachment-stream.test.mjs gateway/test/teambition-user-ticket-access.test.mjs gateway/test/tb-entry.test.mjs gateway/test/devbench-tb-user-access-policy.test.mjs gateway/test/devbench-tb-attach-download.test.mjs gateway/test/devbench-tb-attach-stop-race.test.mjs gateway/test/devbench-prompt-mode.test.mjs gateway/test/workflow-v2-tb-sync-saga.test.mjs gateway/test/workflow-v2-tb-workflow-sync.test.mjs gateway/test/workflow-v2-tb-durable-operation.integration.test.mjs` | 0 | `PASS` | 196 tests；196 pass；0 fail；0 skipped。均为本地 fixture/mock，不是生产 TB 证据。 |
| V05 | `node .agents/skills/aiefficiency-fullstack-quality/scripts/quality-gate.mjs --repo . --base HEAD --mode quick` | 0 | `PASS_WITH_WARNINGS` | effective=deep，decision=`ALLOW_WITH_REVIEW`，无 blocker；static=`PASS`；bundle/browser=`NO_BASELINE`。报告：`.aiefficiency/quality/reports/quality-gate-2026-08-23T05-31-44-951Z.md`。 |
| V06 | `npm --prefix web-dashboard test` | — | `SKIPPED` | quality gate 判定没有产品前端文件变化。 |
| V07 | `npm --prefix web-dashboard run build` | — | `SKIPPED` | 同上；M0 不是 UI/制品候选。 |
| V08 | `npm --prefix gateway test` | — | `SKIPPED` | 全量网关测试未执行；已单独运行 12 个 TB/DevBench 相关测试文件。 |
| V09 | 真实 Teambition 读取/状态/评论/附件写入 | — | `SKIPPED` | M0 明确禁止真实 TB 写入；未提供隔离测试工单，读取也未执行。 |
| V10 | PowerShell：解析 `WORK_STATE.json`、断言 5 个必需交付物、逐一校验文档中的 `gateway/*:line` 引用并重跑包 verifier | 0 | `PASS` | 必需文件齐全；JSON/状态不变量有效；引用行号均位于真实文件范围；再次得到 `PACKAGE VALIDATION PASSED`。 |
| V11 | `git status -sb`、`git diff --cached --name-status`、`git ls-files -v` 隐藏标记检查、用户文件/差异哈希复核、`git check-ignore -v` | 0 | `PASS` | 暂存区为空；`skip-worktree/assume-unchanged=0`；`ask_2.txt` SHA-256 与起始值一致；tracked diff hash 仍为 `4bfa900e5bb3f0f1403721c0512d5c31d5313dcd`；验收证据由 `.gitignore:218` 排除。 |

探索期间有三次非门禁 `rg` 产生参数错误：两次把不存在的可选路径 `gateway/index.js` / `.roo` 放入 pathspec，一次被 PowerShell 对带空格的中文检索式拆分；均已改用实际存在的路径或单文件检索完成扫描，不属于产品或验收门禁失败。

## 5. M0 交付门禁

| 门禁 | 状态 | 证据 |
| --- | --- | --- |
| 每个关键结论有真实路径、符号/行号或命令 | `PASS` | `docs/audit/TB_EXTRACTION_EVIDENCE.md` E01-E15；`TB_BUG_REGISTER.md` TB-M0-001～014。 |
| 详情/备注/评论/附件/状态/评论调用链已覆盖 | `PASS` | `TB_CURRENT_FLOW.md` 读取、甄别、状态、评论和副作用地图。 |
| `AI甄别` 状态来源已核实 | `PASS_WITH_FINDING` | 当前源码无精确 `AI甄别` 逻辑状态；登记 TB-M0-002，后续必须从 taskflow 动态解析。 |
| 鉴权、顺序、错误和运行态依赖已记录 | `PASS` | Evidence E01/E06/E07/E12/E14；Bug TB-M0-001/006/010/011。 |
| 特征测试计划已形成 | `PASS` | `TB_EXTRACTION_EVIDENCE.md` 第 7 节。 |
| 未填充猜测接口 | `PASS` | 所有未证实的真实租户行为标为 `UNKNOWN`，MCP/CLI/API 未生成。 |
| 真实 TB 写入为 0 | `PASS` | 未调用 connector/API，`realTbWriteExecuted=false`。 |

## 6. 代码、配置和行为影响

- 新增 M0 文档：`docs/audit/TB_EXTRACTION_EVIDENCE.md`、`docs/audit/TB_CURRENT_FLOW.md`、`docs/audit/TB_BUG_REGISTER.md`。
- 新增阶段状态与验证：`WORK_STATE.json`、`VERIFICATION.md`。
- 新增忽略的本地验收路由证据：`docs/tempFiles/project-acceptance/SKILLDEV-TB-TOOLKIT-M0-20260823/cac55b11-m0/acceptance-route.md`。
- 产品源码变化：无。
- API/数据库/配置变化：无。
- UI/路由/制品变化：无。
- 远端 Teambition 行为变化：无。

## 7. Findings

### 当前候选引入

无产品 `INTRODUCED` finding；M0 只新增文档和状态文件。

### 基线已有或未知

- `PRE_EXISTING` P0：甄别入口在 context/attachment 准备前调用状态写入（TB-M0-001）。
- `PRE_EXISTING` P0：当前状态机与固定 `AI甄别 → 处理中 → 已解决` 不一致（TB-M0-002）。
- `PRE_EXISTING` P0：附件门禁为大于 10，4 个附件不会等待用户选择（TB-M0-003）。
- `PRE_EXISTING` P1/P2：完整上下文、temp/Git 卫生、安全下载、评论合同、统一网络策略和 legacy 重复实现等见 TB-M0-004～010、012～014。
- `UNKNOWN` P1：已有本地 story 的每次后续 TB 写入是否重新执行当前 principal 的 ticket access check（TB-M0-011）。

## 8. 实际读取与未读取

已读取：生成包 M0 必读集合；当前 provider、DevBench 路由/服务、workflow-v2 saga/store/sqlite、权限/config、legacy analyzer/watcher/routes、相关前端入口和 12 个测试文件/测试结果。

未读取：真实 TB 任务、评论附件、图片、视频、生产日志和生产数据库；生成包 M1-M5 的 MCP/Skill/CLI/schema 具体蓝图。前者缺少隔离任务且 M0 禁止真实写，后者不属于当前单里程碑输入。

## 9. 未覆盖与剩余风险

1. `UNKNOWN` 真实目标 taskflow 是否存在三个固定状态，以及各租户必填字段组合。
2. `UNKNOWN` 真实网络限流、超时、Cookie 过期、附件 URL 重签名和 readback 延迟。
3. `SKIPPED` 全量 gateway/web 测试、前端构建和真实 UI 核心交互；M0 无产品/UI 改动，后续 M1/M3 应按实际影响补跑。
4. Bundle/browser 没有评审基线，因此 `NO_BASELINE` 不是通过证据；本轮没有 bundle/UI 候选，风险不扩展为 M0 阻断。
5. 当前 M0 PASS 不表示 M1-M6 完成；不得据此部署、安装 skill、启 MCP/CLI 或回写 TB。

## 10. 停止点与下一动作

按生成包“一次只执行一个里程碑”的约束，本轮停止在 M0。下一次经明确要求继续时，只读取 `WORK_STATE.json`、本验证和三份 M0 证据，执行 M1 characterization/缺陷基线；不自动进入 M2，不真实写 TB。

## 11. M1 characterization 与缺陷基线

### 11.1 当前结论

- `M1 Milestone Decision: PASS`
- `Project Change Decision: PARTIAL`
- `Project Production Readiness: NOT_ASSESSED`
- `FACT` M1 已冻结旧入口的真实成功行为与 TB-M0-001/002/003/004/007 缺陷复现，并覆盖权限、HTTP/附件错误、重复与部分成功相关 Oracle。
- `FACT` 候选只新增测试、脱敏 fixture、审计/阶段文档和回归 ledger；产品源码、配置、数据库、UI 与 Teambition 均未修改。
- `FACT` 定向关联套件全部通过，但 deep 全栈质量门禁因 Gateway 全量测试超时并有范围外失败而 `BLOCK`，故工程结论不能提升为 `ACCEPTED`。

### 11.2 Acceptance Route 与候选

```text
Acceptance Route
  task_origin: DIRECT_ENGINEERING
  scope_kind: PROJECT_ENGINEERING
  protocols: project-engineering-acceptance
  change_type: TEST_OR_HARNESS
  risk_tier: HIGH
  target_repositories: 当前 AIEfficiencyTrack 仓库
  project_task_id: SKILLDEV-TB-TOOLKIT-M1-20260823
  story_point_id: N/A
  source_system/source_issue_id: N/A
  mode: PROJECT-STANDARD
```

| 项 | 值 |
| --- | --- |
| Branch | `feat/admin-rbac` |
| HEAD | `cac55b11b825ab18e0139bbf6dc4a9d8600369ad` |
| Candidate | `cac55b11-m1` |
| Package manifest SHA-256 | `AB7CB3BFDFB997A320D05CAA924A5FF91B957262733981590CE2D59C7AE875D4` |
| Remote TB mutation | disabled / executed=false |

PREWRITE 选择最小可逆方案：只允许 `gateway/test/**`、`docs/audit/TB_M1_CHARACTERIZATION.md`、`docs/engineering/regression-ledger.md`、根状态/验证文件和忽略的验收证据；禁止修改 `gateway/services/**`、`gateway/routes/**`、前端、配置、数据库、依赖以及 MCP/CLI/Skill 产品实现。路由记录：`docs/tempFiles/project-acceptance/SKILLDEV-TB-TOOLKIT-M1-20260823/cac55b11-m1/acceptance-route.md`。

### 11.3 交付物与行为影响

- 新增脱敏 fixture：`gateway/test/fixtures/tb-toolkit-m1-context.json`。
- 新增 11 项 characterization：`gateway/test/tb-toolkit-m1-characterization.test.mjs`。
- 新增 M1 证据矩阵：`docs/audit/TB_M1_CHARACTERIZATION.md`。
- 新增回归台账：`REG-20260823-DEVBENCH-085`。
- 更新 `WORK_STATE.json` 与本验证记录。
- 产品/API/数据库/配置/UI/远端 TB 行为影响：无。

### 11.4 执行命令与退出码

| # | 命令 | 退出码 | 结果与边界 |
| --- | --- | ---: | --- |
| M1-V01 | `node --test --test-timeout=60000 gateway/test/tb-toolkit-m1-characterization.test.mjs`（首轮） | 1 | 10/11；唯一失败为 C11 错误预期同调用会二次评论回读，归属 `HARNESS_DEFECT`。 |
| M1-V02 | 同上（最小修正后） | 0 | 11/11；未降低 `pending_ambiguous`、blocked、零状态写断言。 |
| M1-V03 | `npm --prefix gateway test -- tb-toolkit-m1 teambition devbench-tb workflow-v2-tb tb-entry` | 0 | 14 文件、131 tests、131 pass、0 fail/skipped/cancelled/todo；全为本地 fixture/mock。 |
| M1-V04 | `node .agents/skills/aiefficiency-fullstack-quality/scripts/doctor.mjs --repo .` | 0 | `PASS_WITH_WARNINGS`；环境可用，警告为 dirty worktree。 |
| M1-V05 | `node .agents/skills/aiefficiency-fullstack-quality/scripts/impact-map.mjs --repo . --base HEAD` | 0 | `PASS`；未跟踪生成包/阶段材料使推荐模式升级为 deep。 |
| M1-V06 | `node .agents/skills/aiefficiency-fullstack-quality/scripts/quality-gate.mjs --repo . --base HEAD --mode standard` | 1 | `FAIL/BLOCK`，effective=deep，737450ms；报告 `.aiefficiency/quality/reports/quality-gate-2026-08-23T07-15-49-946Z.md`。 |
| M1-V07 | `npm --prefix web-dashboard test`（门禁内） | 0 | `PASS`。 |
| M1-V08 | `npm --prefix web-dashboard run build`（门禁内） | 0 | `PASS`；保留既有大 chunk 警告。 |
| M1-V09 | `npm --prefix gateway test`（门禁内） | 2 | 600022ms timeout；报告记录 4 个范围外旧测试文件共 5 个失败，未执行到新增 M1 文件。 |
| M1-V10 | static UI / bundle / browser audit（门禁内） | 0 | static=`PASS`；bundle/browser=`NO_BASELINE`，browser 实际运行 42 个 case，但 `NO_BASELINE` 不等于通过。 |
| M1-V11 | 真实 Teambition 读取、下载与状态/评论写入 | — | `SKIPPED`；没有隔离真实工单和写授权，M1 只使用脱敏 fixture。 |
| M1-V12 | 生成包 `scripts/verify_package.py` | 0 | `PACKAGE VALIDATION PASSED`；输入包 manifest 未被修改。 |
| M1-V13 | `node --check gateway/test/tb-toolkit-m1-characterization.test.mjs` 与 `git diff --check` | 0 | 语法和差异格式通过；Git 仅提示 ledger 下次触碰时 LF→CRLF，不是内容错误。 |
| M1-V14 | PowerShell 解析 `WORK_STATE.json`、fixture JSON 并扫描 Cookie/Authorization/token/签名 URL 标记 | 0 | M1/PASS/PARTIAL、M0+M1、`realTbWriteExecuted=false` 均满足；fixture 禁止标记 0。 |
| M1-V15 | `git status -sb`、暂存区、隐藏索引标记、`ask_2.txt` SHA-256/差异哈希和 acceptance-route ignore 检查 | 0 | 暂存区空；隐藏标记 0；用户文件 SHA-256=`C67F...1827C`、差异哈希=`4bfa...dcd` 均与开始值一致；证据由 `.gitignore:218` 排除。 |

### 11.5 Findings

- `HARNESS_DEFECT`（已修正，自动修复第 1 轮）：C11 首轮把“后续 durable 恢复回读”误写为“当前调用立即二次回读”；只修正该断言，最终 11/11。
- `PRE_EXISTING`：TB-M0-001/002/003/004/007 已由确定性 characterization 重现；本里程碑按要求不修产品。
- `UNKNOWN/ENVIRONMENT`：Gateway 全量门禁记录 `agent-timeout.test.mjs` 1 项、`agent-v2.test.mjs` 1 项、`api-engine.test.mjs` 1 项、`api-process-supervisor.test.mjs` 2 项失败后超时。M1 没有修改这些文件或其实现，且运行器尚未到新增 M1 文件，因此可确认不是本候选直接引入；但没有干净 HEAD 同环境复跑，不能确认具体是基线缺陷还是环境/时序问题。
- `UNKNOWN`：真实 taskflow 三状态、租户必填字段、当前 principal 的逐次工单权限复核、评论歧义恢复 SLA 和真实网络行为仍未验证。

### 11.6 实际读取、未读取与停止点

已读取：`WORK_STATE.json`、M0 验证与三份审计文档；生成包 M1 里程碑、验收要求和 master prompt 对应段落；相关 provider、DevBench、Saga/durable、权限及附件实现/既有测试；本轮新增 fixture/test；质量门禁原始 JSON/Markdown 报告。

未读取或未执行：真实 TB 任务、评论、附件二进制、图片、视频、生产日志/数据库；M2-M5 的具体实现蓝图；真实 UI 核心交互；发布、部署、安装和真实来源回写。原因分别是缺少隔离真实工单/授权，或不属于 M1 单里程碑范围。

M1 在定向范围完成，但工程标准门禁保留阻断证据。本轮严格停止在 M1；下一次只有经用户明确要求继续，才进入 M2 context/attachment 规范化，不自动进入 M3，也不真实写 Teambition。

## 12. M2 官方 MCP 接入与上下文/附件核心

### 12.1 结论先行

- `M2 Milestone Decision: PARTIAL`
- `Project Change Decision: PARTIAL`
- `Project Production Readiness: NOT_ASSESSED`
- `FACT` 已按用户指令撤回自建 Teambition MCP/provider，固定接入官方 `@tng/teambition-openapi-mcp@0.2.2`。
- `FACT` 本地 context/attachment 核心、Git 隔离和安全下载合同在完整 fixture 下通过；官方 stdio 子进程的真实工具调用通过本机 mock OpenAPI 验证。
- `FACT` 官方 0.2.2 没有完整评论读取、任务/评论/备注附件全量枚举和任务附件下载工具；因此官方路径固定返回 `CONTEXT_INCOMPLETE`，不能把未知附件数伪装成 0。
- `FACT` 没有读取或写入真实 Teambition；M3 远端状态/评论写入未开始。

### 12.2 Acceptance Route 与候选冻结

```text
Acceptance Route
  task_origin: DIRECT_ENGINEERING
  scope_kind: PROJECT_ENGINEERING
  protocols: project-engineering-acceptance
  change_type: MIXED
  risk_tier: HIGH
  target_repositories: 当前 AIEfficiencyTrack 仓库
  project_task_id: SKILLDEV-TB-TOOLKIT-M2-20260823
  story_point_id: N/A
  source_system/source_issue_id: N/A
  mode: PROJECT-STANDARD
```

| 项 | 值 |
| --- | --- |
| Branch | `feat/admin-rbac` |
| HEAD | `cac55b11b825ab18e0139bbf6dc4a9d8600369ad` |
| Candidate | `cac55b11-m2-6310a3ed` |
| Toolkit tree SHA-256 | `6310a3edea9e05c27c5d9e649c468f79eb59284c7ff1e833629b2fd74e1f78da` |
| Official MCP | `@tng/teambition-openapi-mcp@0.2.2` |
| Official tarball SHA-256 | `539DCFDF6211DA1B5FBE8A12AA4CD9C2D04764B7E4B08B4F5F1B8E144C0994D3` |
| Remote TB read/write | disabled / executed=false |

原 PREWRITE 的“仓库自建 provider”方案因用户要求直接接入官方 MCP 而失效。新 PREWRITE 只允许固定官方依赖、薄 MCP 客户端、domain/application、本地 schema/测试与阶段证据；禁止修改现有 Gateway/DevBench 产品入口、数据库、Web、`.gitignore` 和用户输入包。记录位于忽略的 `docs/tempFiles/project-acceptance/SKILLDEV-TB-TOOLKIT-M2-20260823/cac55b11-m2/acceptance-route.md`。

### 12.3 交付物和行为影响

- 新增 `tools/tb-ticket-toolkit/`：官方 MCP 薄客户端、domain、application、schema、锁文件和 21 项测试。
- 新增 `docs/audit/TB_M2_OFFICIAL_MCP_INTEGRATION.md` 与回归台账 `REG-20260823-SKILLDEV-086`。
- 官方只读白名单：`queryTaskV3`、`searchTaskflowsV3`、`searchTaskflowStatusesV3`。
- 完整 fixture：0/1/3 自动准备；4 个及以上先选择；只下载选择项；恢复选择/receipt；普通仓库和 worktree 精确 `info/exclude`；路径/符号链接/同名冲突/大小/中断/秘密均失败关闭。
- 官方实际路径：评论或附件 coverage 不完整即 `CONTEXT_INCOMPLETE`，零下载，不生成附件 manifest，不允许后续写入。
- 现有 Gateway/DevBench 产品/API/数据库/UI/远端 TB 行为变化：无。

### 12.4 执行命令与退出码

| # | 命令 | 退出码 | 结果与边界 |
| --- | --- | ---: | --- |
| M2-V01 | `npm view @tng/teambition-openapi-mcp@0.2.2 ...`、发布包检查 | 0 | 官方包、版本、MIT 许可、tarball/integrity 和工具定义已核对。 |
| M2-V02 | `npm --prefix tools/tb-ticket-toolkit install --ignore-scripts` | 0 | 安装固定依赖；未运行第三方生命周期脚本。 |
| M2-V03 | `npm --prefix tools/tb-ticket-toolkit run check` | 0 | domain、official MCP、Git isolation 和 prepare 源码语法通过。 |
| M2-V04 | `npm --prefix tools/tb-ticket-toolkit test`（首轮实现后） | 1 | 15/20；5 项失败同源于 fixture 无条件追加备注图片，归属 `HARNESS_DEFECT`。 |
| M2-V05 | 同上（显式 remark image 后） | 0 | 最终 21/21；新增真实官方 stdio→本机 mock `queryTaskV3` Oracle。 |
| M2-V06 | `npm --prefix gateway test -- tb-toolkit-m1 teambition devbench-tb workflow-v2-tb tb-entry` | 0 | 14 文件、131/131，通过；本地 fixture/mock。 |
| M2-V07 | `npm --prefix web-dashboard test` | 0 | pretest 31/31，主测试 441/441。 |
| M2-V08 | `npm --prefix web-dashboard run build` | 0 | production build 通过；保留未修改文件 JSX 字符和大 chunk 警告。 |
| M2-V09 | `npm audit --omit=dev --json`（toolkit 目录） | 0 | 生产依赖 0 个已知漏洞。 |
| M2-V10 | 生成包 `scripts/verify_package.py` | 0 | `PACKAGE VALIDATION PASSED`；输入包未改。 |
| M2-V11 | full-stack `quality-gate --mode standard` | 1 | Web 阶段后进入 Gateway 全量，超过 180 秒无新输出后人工停止；未伪造通过。 |
| M2-V12 | `git diff --check`、JSON 解析、暂存区/隐藏索引/ignore/用户文件哈希 | 0 | 差异格式与 JSON 通过；暂存区空；隐藏标记 0；node_modules/证据被忽略；`ask_2.txt` SHA-256 仍为 `C67F...1827C`。 |
| M2-V13 | 真实 Teambition 读取/附件下载/状态与评论写入 | — | `SKIPPED`；没有隔离真实工单和写授权，且 M2 禁止远端副作用。 |

### 12.5 Finding、未读取材料与停止点

- `HARNESS_DEFECT`（已修正，第 1 轮）：fixture 的 `attachmentCount` 与无条件备注图片冲突；改为显式 `remarkImageCount`，没有降低统一聚合断言。
- `SOURCE_CONNECTOR`（阻断）：官方 MCP 缺少完整评论和任务附件读取/下载工具；官方路径不能达到 M2 真实 `READY`。
- `HARNESS_DEFECT/UNKNOWN`：仓库 Gateway 全量仍无进展；关联 131/131 通过，但 PROJECT-STANDARD 不能提升为 ACCEPTED。
- `PRE_EXISTING`：Vite 的 JSX 字符与大 chunk 警告来自未修改 Web 文件，本轮不顺手修复。

实际读取：M2 里程碑/验收矩阵、M0/M1 证据、当前 TB provider/相关 MCP 集成、官方 Teambition 文档/NPM 发布包/钉钉官方 MCP 仓库、M2 新增源码/测试及命令输出。未读取：真实 TB 任务/评论/附件二进制、图片、视频、生产日志/数据库和生产 taskflow；原因是无隔离任务/授权且官方能力缺口尚未解除。

本轮停止在 `M2 PARTIAL`。在官方 MCP 补齐完整评论/附件读能力，或用户明确选择新的集成边界之前，不进入 M3 远端写核心，也不声明生成器或工程可生产使用。

## 13. M2-M6 单一 MCP 组合实现

### 13.1 结论先行

- `M2-M5 Milestone Decision: PASS`
- `M6 Milestone Decision: PARTIAL`：唯一 MCP 的离线 canary 已通过；真实隔离工单 canary、canonical 切换和旧实现清理未执行。
- `Project Change Decision: PARTIAL`
- `Project Production Readiness: NOT_ASSESSED`
- `FACT`：对外只有 `tb-ticket-mcp`。它在内部启动固定版本 `@tng/teambition-openapi-mcp@0.2.2`，并调用一个不对外暴露 MCP 工具的补充 Provider 库。
- `FACT`：官方已覆盖的 6 个读取工具与 2 个写入工具不在补充层重复实现；补充层只处理 Cookie 只读兜底、富文本备注/图片、附件安全字节流与 URL 刷新。
- `FACT`：MCP、`tbfix` CLI 与 AIEfficiency Adapter 共用同一 application/domain；shadow 不写，canonical 模式不调用 legacy writer。
- `FACT`：本轮未连接、读取或写入真实 Teambition。

### 13.2 Acceptance Route 与候选冻结

```text
Acceptance Route
  task_origin: DIRECT_ENGINEERING
  scope_kind: PROJECT_ENGINEERING
  protocols: project-engineering-acceptance
  change_type: MIXED
  risk_tier: HIGH
  target_repositories: 当前 AIEfficiencyTrack 仓库
  project_task_id: SKILLDEV-TB-TOOLKIT-M2-M6-20260823
  story_point_id: N/A
  source_system/source_issue_id: N/A
  mode: PROJECT-STANDARD
```

| 项 | 值 |
| --- | --- |
| Branch / HEAD | `feat/admin-rbac` / `cac55b11b825ab18e0139bbf6dc4a9d8600369ad` |
| Candidate | `cac55b11-m6-a5311dd7` |
| Toolkit tree SHA-256 | `a5311dd709b74d0704535377954bec307b61f9cdf97bf5f399fa2cd569ba7013`（41 files，排除 `node_modules`） |
| Official MCP | `@tng/teambition-openapi-mcp@0.2.2` |
| Remote TB read/write | disabled / executed=false |

### 13.3 交付物和行为影响

- `tools/tb-ticket-toolkit/`：唯一业务 MCP、官方 MCP 薄客户端、补充 Provider、domain/application、持久计划与 operation、CLI、Adapter、Schema 和测试。
- `.agents/skills/tb-ticket-fix/`：只允许经 `tb-ticket-mcp` 访问业务能力的 canonical Skill。
- Gateway 仅加入默认关闭的 shadow 接入；配置为 canonical 时仍保持关闭，等待真实 M6 canary，不会提前替换现有生产路径。
- 写入固定为“评论 → 回读 → 状态 → 回读”，并受 write profile、全局写开关、任务白名单、计划 TTL/指纹、租约/fencing 和显式 `apply=true` 共同保护。
- 没有删除旧 Gateway 必填字段恢复逻辑；没有修改、暂存或提交用户的生成器输入文件。

### 13.4 执行命令与退出码

| # | 命令 | 退出码 | 结果与边界 |
| --- | --- | ---: | --- |
| M6-V01 | `npm test`（`tools/tb-ticket-toolkit`） | 0 | 48/48；真实 stdio 唯一 MCP、官方子进程、本机 mock OpenAPI、CLI、Adapter、离线 TRIAGE/RESOLUTION canary 全通过。 |
| M6-V02 | Gateway 14 个 TB/DevBench 关联测试文件 | 0 | 209/209；验证默认关闭、shadow 只读和旧权限/附件/必填字段/Saga/durable operation 未回退。 |
| M6-V03 | `npm run check`（toolkit） | 0 | 发布源码语法检查通过。 |
| M6-V04 | Schema strict compile tests | 0 | 4 份 draft 2020-12 Schema 与示例通过。 |
| M6-V05 | `quick_validate.py`（`PYTHONUTF8=1`） | 0 | `Skill is valid!`。 |
| M6-V06 | `npm audit --omit=dev --json` | 0 | 生产依赖 0 vulnerabilities。 |
| M6-V07a | 在生成包外层目录运行 `python scripts/verify_package.py` | 1 | 路径定位错误：外层目录没有该脚本；未修改任何文件。 |
| M6-V07 | 在内层包根运行 `python scripts/verify_package.py` | 0 | `PACKAGE VALIDATION PASSED`；生成器输入未改。 |
| M6-V08 | full-stack `quality-gate --mode standard` | 2 | Web tests/build 通过；Gateway 全仓在既有 4 个测试文件的 5 项失败后于 600014ms 超时，整体 `FAIL/BLOCK`。 |
| M6-V09 | 增量 `static-ui-audit --base HEAD` | 0 | 修复畸形 activity JSON 的失败关闭后 `PASS_WITH_WARNINGS`、blockerCount=0；仅保留未修改大文件 P2。 |
| M6-V10 | intent-impact POSTWRITE gate | 0 | 不变量、预算与实际改动范围检查通过。 |
| M6-V11 | 真实 Teambition canary | — | `SKIPPED`；缺少隔离测试任务、有效认证/任务白名单与明确 `apply=true` 授权。 |

### 13.5 Findings、未覆盖项与停止点

- `INTRODUCED / RESOLVED`：Cookie activity 畸形 JSON 曾被当成空对象；已改为 `UPSTREAM_INVALID` 失败关闭并补回归，最终 toolkit 48/48。
- `PRE_EXISTING / OPEN`：Gateway 全仓质量门禁仍被本候选未修改的 `agent-timeout`、`agent-v2`、`api-engine`、`api-process-supervisor` 失败与超时阻断。
- `ENVIRONMENT / OPEN`：目标租户 taskflow、权限、必填字段、分页和 Beta 版本漂移尚未在隔离工单验证。
- `UNKNOWN`：真实网络下评论写入/回读、状态写入/回读及 PARTIAL 恢复是否完全符合目标租户行为。

实际读取：v2.0.0 生成器里程碑、验收要求与脚本，M0-M2 审计材料，官方 NPM 发布包和工具定义，现有 Gateway/DevBench Teambition 读取、附件、权限、状态、Saga/durable operation 路径，本轮全部新增/修改源码与测试，以及质量门禁原始报告。未读取：真实 TB 工单、评论、附件二进制、图片、视频、生产日志、数据库与生产 taskflow；原因是没有隔离工单和外部副作用授权。

停止点：M0-M5 已在本地/影子范围完成，M6 离线 canary 完成。必须先提供隔离真实测试工单、可用认证、任务白名单并明确授权 `apply=true`，才能执行真实 canary；只有评论/状态独立回读和无双写证据通过后，才允许 canonical 切换和旧实现清理。
