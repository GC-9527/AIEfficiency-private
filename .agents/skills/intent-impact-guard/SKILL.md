---
name: intent-impact-guard
description: Prevent premature, over-broad, or architecture-breaking code changes by separating problem symptoms from implementation decisions, inspecting real repository evidence, protecting invariants, comparing alternatives, selecting the smallest reversible change, and verifying regression radius. Use before editing when a request says something is missing/broken/not working, changes login/auth/permissions/routes/navigation/UI/shared components/public APIs/SDK/data sources/Flavor or model variants, removes/migrates code, or has ambiguous intent. Do not use for pure explanation or read-only questions unless impact analysis is requested.
compatibility: Model-agnostic. Requires repository read access; write phases require file-edit, Git/diff, and verification tools.
metadata:
  version: "1.0.0"
  language: "zh-CN"
  domains: "android,kmp,fullstack-web,sdk-governance,multi-agent"
---

# Intent & Impact Guard

## 核心契约

**问题现象不是实现方案。** 在修改任何文件前，必须完成：

`意图分类 → 真实证据 → 不变量 → 至少两个候选方案 → 风险/权限 → 最小可逆方案 → PREWRITE READY`

不输出冗长思维链；输出可核验的证据、决定、影响与测试。

## 何时执行

遇到以下任一情况必须执行：

- 用户说“没有、缺少、错误、不显示、不生效、被遮挡、太慢”等现象；
- 登录、认证、权限、路由、导航、首页、管理后台、共享 UI、公共状态发生变化；
- 公共 API、SDK、数据源、模块职责、Flavor、车型、KMP source set 发生变化；
- 删除、替换、迁移、合并、抽离、重构、复制已有能力；
- 用户指定的方案可能与现有架构、Mock、调试、兼容性或历史行为冲突；
- 改动可能跨页面、模块、仓库、分支、Variant 或部署节点。

纯解释、翻译、只读总结且不要求影响判断时不执行。

## 权限边界

按风险只申请必要权限：

- `READ_ONLY`：读取、搜索、分析、运行无副作用检查。
- `LOCAL_WRITE`：修改当前工作树、生成本地产物、运行本地测试。
- `EXTERNAL_WRITE`：推送、发 MR、回写工单、发布、调用会改变远端状态的接口。
- `DESTRUCTIVE`：删除数据/分支/资源、不可逆迁移、覆盖生产状态。

未获得对应授权时不得升级权限。外部写入和破坏性操作默认阻断。

## 执行协议

### 0. 固定真实状态

在可用工具范围内记录：

- 仓库根目录、当前分支、HEAD；
- 未提交改动和当前 diff；
- 目标模块、Flavor/Variant/车型、环境；
- `AGENTS.md`、架构文档、测试命令和更具体的目录规则。

不得覆盖、清理或吸收与当前任务无关的用户改动。

### 1. 分类用户输入

用一行或短字段明确：

- `problem_signal`：用户看到的现象；
- `business_goal`：真正要达到的结果；
- `explicit_solution`：用户是否明确指定实现；
- `non_goals`：本次不应改变什么；
- `unknowns`：只能通过代码/配置/日志确认的事实。

禁止把 `problem_signal` 自动当成 `explicit_solution`。

### 2. 获取最小充分证据

优先读取与决策直接相关的真实内容：

1. 入口、路由、调用方和被调用方；
2. 状态、权限、数据源和错误处理；
3. 现有测试、历史行为合同和相关 diff；
4. 共享组件、公共 API、Variant/Flavor/KMP source set 覆盖；
5. 生成代码与 canonical 源的边界。

每个关键结论标记为：

- `VERIFIED`：由代码、配置、测试、日志或 diff 直接支持；
- `INFERRED`：合理推断但尚未直接证明；
- `UNKNOWN`：没有证据。

不得凭文件名、聊天历史、旧报告或“通常如此”替代当前证据。

### 3. 建立不变量

至少列出一个必须保持的行为或边界，格式：

`不变量 | 证据来源 | 如何验证`

默认保护：

- 已有业务页面和路由职责；
- 认证、授权和角色边界；
- AppMock、调试、测试及离线能力；
- 公共 API/SDK 兼容性与单一源码；
- 多 Flavor/车型/KMP source set 的既有覆盖；
- 用户未要求改变的交互、数据和部署行为；
- 当前工作树中无关改动。

### 4. 比较候选方案

至少生成两个可行方案；每个方案只需简洁说明：

`目标满足度 | 不变量保护 | 影响范围 | 可逆性 | 安全/兼容风险 | 验证成本`

优先选择：

1. 满足真实目标；
2. 保持模块职责和权限边界；
3. 附加式、局部、可逆；
4. 不复制 canonical 源、不引入平行实现；
5. 可用有针对性的测试证明。

不得因为“代码更少”选择职责错误、绕过权限或形成技术债的方案。

### 5. 风险分级与写入决策

- `LOW`：局部附加改动，不改变共享合同、权限或数据。
- `MEDIUM`：路由、共享 UI/状态、多文件、多 Variant 行为，但无安全或公共合同迁移。
- `HIGH`：认证授权、公共 API/SDK、模块职责迁移、删除能力、数据迁移、跨仓共享实现。
- `CRITICAL`：生产数据、密钥、部署、远端不可逆操作。

低/中风险歧义：选择最小、可逆、安全默认方案并记录假设。  
高/关键风险歧义：保持代码不变，输出 `BLOCKED_NEEDS_DECISION` 和唯一必要决策，不反复猜测或追问。

### 6. PREWRITE 门禁

写文件前输出紧凑决策摘要：

```text
[INTENT]
现象：...
目标：...
明确方案：有/无；...
非目标：...

[EVIDENCE]
- VERIFIED path:locator — finding
- INFERRED ...

[INVARIANTS]
- ...

[OPTIONS]
A. ... | risk=... | reversible=yes/no
B. ... | risk=... | reversible=yes/no

[DECISION]
选择：A
原因：...
权限：LOCAL_WRITE
改动预算：模块/文件/接口边界
状态：READY | BLOCKED_NEEDS_DECISION

[VERIFY_PLAN]
- ...
```

`状态 != READY` 时禁止修改。编排器可使用 `scripts/gate.py` 校验结构化决策记录。

### 7. 受控实施

- 只修改被选方案和改动预算允许的文件；
- 先改 canonical 源，再由正式依赖/编译链传播；
- 不顺手重构、格式化或修复无关问题；
- 不删除 Mock/兼容/回退路径，除非它们是明确目标且有替代与测试；
- 发现新证据导致范围扩大时，暂停写入并重新执行步骤 2–6；
- 共享工作区同一时间最多一个可写 Agent。

### 8. 回归半径验证

至少验证：

- 用户目标的正向路径；
- 每条不变量；
- 失败、空态、权限不足、刷新/重启等边界；
- 所有受影响页面、调用方、Variant/Flavor/KMP source set；
- diff 中是否出现未计划文件、复制源码、权限降低或职责迁移；
- 测试、构建、静态检查的真实结果，不得把“建议运行”写成“已通过”。

无法执行的检查必须标记 `NOT_RUN` 并说明原因与残余风险。

### 9. POSTWRITE 与交接

输出：

```text
结果：PASS | PARTIAL | FAIL | BLOCKED
实际改动：文件 + 行为
目标证据：测试/日志/截图/构建输出
不变量：逐项 PASS/FAIL/NOT_RUN
范围偏差：无/有；原因与批准证据
残余风险：...
续作状态：branch + HEAD + dirty patch + Variant/Flavor + 下一步
```

中断或切换 AI 时，按 `assets/handoff.template.json` 保存状态；接手者必须重新核对 Git/Dirty Patch，不能直接相信旧结论。

## 强制禁止结果

除非用户明确要求且真实架构证据支持，否则禁止：

- 因“没有登录入口”把管理后台或首页改成登录页；
- 因生产数据源迁移删除 AppMock、测试或调试数据源；
- 把通用能力只实现在单一 Flavor/车型；
- 在应用工程复制或修复已经抽离到 SDK 工程的 canonical SDK 源码；
- 用隐藏按钮、绕过路由守卫或降低权限“解决”访问问题；
- 改动公共 API 而不检查调用方与兼容策略；
- 未检查关联页面、断点和状态就修改共享 UI；
- 清理、覆盖或提交与本任务无关的本地改动。

## 按需读取

仅在相关时加载，避免 Token 浪费：

- 决策与风险细节：`references/decision-protocol.md`、`references/risk-permission-model.md`
- 不变量与证据：`references/invariants-catalog.md`、`references/evidence-verification.md`
- Web/登录/UI：`references/domains/fullstack-web.md`
- Android/KMP/Flavor：`references/domains/android-kmp.md`
- SDK 抽离与单一源码：`references/domains/sdk-governance.md`
- 多 AI、无人值守和续作：`references/domains/multi-agent.md`
- 正反例：`references/examples.md`
- 验收评分：`references/evaluation-rubric.md`

## 完成定义

仅当以下全部满足才可声称完成：

- 目标由真实证据支持；
- 没有把现象误当实现；
- 不变量已验证；
- 权限未越界；
- 实际 diff 未超出批准范围；
- 关键回归检查有真实结果；
- 失败和未执行项被如实披露；
- 可由另一个 AI 依据结构化状态继续。
