---
name: aiefficiency-fullstack-quality
description: >-
  全栈开发与 UI 关联回归质量门禁。用于实现、修复或评审 React/Vue/Angular/Next/Vite 等 Web 前端、Node/Java/Go 后端、API、数据库和配置变更；重点防止“改一个 UI 导致其他页面变形、控件被侧栏/悬浮层/弹窗遮挡”、响应式回归、加载变慢、包体膨胀、错误态被吞为空态、前后端契约漂移。Use for full-stack implementation, UI/UX changes, layout, modal/sidebar/floating controls, loading performance, visual regression, API contract, bug fix, refactor, PR review, acceptance and release verification.
license: Apache-2.0
compatibility: Requires repository read access. Shell-enabled agents can run bundled Node.js 20+ scripts; instruction-only agents follow the same workflow manually. Canonical repo path is .agents/skills/aiefficiency-fullstack-quality.
metadata:
  version: "1.0.0"
  language: "zh-CN"
  standard: "agent-skills"
  owner: "AIEfficiency"
---

# AIEfficiency 全栈质量 SKILL

## 目标

在不扩大需求范围的前提下，以可复核证据完成全栈变更，并阻止以下回归进入交付：

- 修改一个页面或组件后，共享壳、相邻路由、不同分辨率发生变形、截断、横向滚动、遮挡或层级冲突。
- 加载、切换、轮询、懒加载、资源包体或首屏性能明显退化。
- Loading、Empty、Error、401、403、离线、超时被混为同一种状态。
- 前端、API、WebSocket、数据库、权限或配置只改一侧，形成契约漂移。
- AI 只声称“已验证”，却没有真实命令、浏览器证据、基线差异或残余风险。

## 何时启用

遇到下列任一任务必须启用：

- 新增或修改页面、组件、样式、交互、路由、弹窗、抽屉、下拉、侧栏、悬浮按钮、表格、长表单。
- 修复 UI 变形、遮挡、滚动、响应式、焦点、加载慢、白屏、状态显示错误。
- 修改全局 CSS、主题 token、App shell、共享组件、前端请求层、鉴权、轮询、WebSocket。
- 修改接口、DTO、错误码、权限、数据库迁移，并影响用户界面或任务流程。
- 执行全栈代码评审、验收、发布前检查、性能治理或技术债重构。

纯文档、纯注释且不影响生成物的变更可只执行最小检查。

## 不可违反的原则

1. **先影响分析，后改代码。** 不得仅凭文件名假定影响范围。
2. **最小而完整。** 修 BUG 优先最小改动；根因位于共享层时修共享根因，不在多个页面复制补丁。
3. **不覆盖用户工作。** 先记录 Git 状态；禁止 destructive reset、checkout 覆盖、清理未跟踪文件或擅自 stash。
4. **新增债务零容忍，存量债务渐进治理。** 默认只阻断本次新增的 P0/P1；存量问题列入报告，不借机大扫除。
5. **禁止 z-index 军备竞赛。** 不通过不断增加任意层级值掩盖遮挡；遵守统一层级契约。
6. **UI 变更不得只验修改页。** 至少验证直接页面、共享壳和一组受影响相邻页面。
7. **性能必须比较差异。** 不以“本机感觉快”作为证据；记录包体或浏览器指标基线与增量。
8. **状态必须可区分。** Loading、Empty、Error、401、403、Timeout、Offline 不得静默互相降级。
9. **事实与推断分开。** 没有执行的测试必须写“未执行”，不得伪造通过结果或截图。
10. **安全边界优先。** 不放宽认证、工作区边界、命令执行权限或路径访问来让测试通过。

## 标准流程

### 1. 建立现场快照

- 读取仓库级 `AGENTS.md`、模块说明、构建脚本和本 SKILL。
- 执行 `git status --short --branch`，记录已有改动、当前分支和基线提交。
- 识别应用入口、共享壳、路由、状态管理、请求层、后端入口、数据库和测试命令。
- Shell 可用时先运行：

```bash
node .agents/skills/aiefficiency-fullstack-quality/scripts/doctor.mjs --repo .
```

### 2. 构建影响图

执行：

```bash
node .agents/skills/aiefficiency-fullstack-quality/scripts/impact-map.mjs --repo . --base <基线引用>
```

必须输出并使用：

- 直接改动文件与新增行范围。
- 反向依赖、共享组件、全局 CSS、路由与 API 字符串关联。
- 直接路由、共享壳路由、相邻路由、后端/权限/数据影响。
- 风险等级和建议验证模式。

找不到可靠映射时扩大验证范围，不得缩小。

### 3. 选择验证模式

- **quick**：局部低风险、文案、小型组件；静态门禁 + 相关测试 + 构建。
- **standard（默认）**：普通功能或 BUG；增加影响路由、三档桌面视口、交互几何、包体比较。
- **deep**：共享壳、全局样式、弹窗/悬浮层、路由、鉴权、请求层、性能、数据库、跨模块或发布；执行完整视口、状态、视觉基线、浏览器性能和全栈测试。

下列变更最低为 `deep`：`App`/Layout、全局 CSS、路由入口、Sidebar、FloatingDock、Dialog/Portal、请求/鉴权公共层、错误映射、数据库迁移。

### 4. 写变更计划

计划必须包含：根因、最小修改点、受影响契约、直接测试、关联回归、性能检查、回滚方式。计划与需求不一致时优先需求，不擅自扩展产品功能。

### 5. 实现门禁

#### UI 与交互

- Flex/Grid 可收缩内容区显式考虑 `min-width: 0`、长文本、滚动容器和固定层安全区。
- Dialog/Drawer/Popover 必须适配当前视口，具备最大高度、内部滚动、关闭路径、焦点恢复和 Escape 行为。
- 固定/粘性元素不得覆盖主操作、输入区、分页、Toast、弹窗或系统安全区。
- 新层级使用语义 token 或统一层级表；不得新增无解释的 `z-[...]` 高值。
- 不用固定像素宽高代替响应式约束；确需固定值时说明视口边界和降级策略。
- 共享组件改变 DOM、间距、定位、overflow 或 stacking context 时，将所有消费者纳入影响图。
- 交互不能仅依赖 hover；键盘、禁用、加载中、重复点击和慢请求必须有明确行为。

#### 加载与性能

- 路由级重模块保持懒加载；大库按功能动态加载，避免放入所有页面初始包。
- 请求支持取消或防止过期响应覆盖新状态；轮询在卸载/隐藏时停止，并避免重复定时器。
- 缓存、预取、并发请求必须有失效和错误策略，不能以吞错换取“看起来更快”。
- 每次性能相关修改记录构建产物增量；浏览器可用时记录导航、LCP、CLS、长任务和资源体积。

#### 全栈契约

- 同步检查请求/响应 DTO、状态码、错误码、鉴权、权限、分页、时间/时区、幂等、重试与兼容性。
- 前端不得把 401/403/5xx/网络失败转换为空数组或空对象后展示 Empty。
- 数据库变更必须有迁移、回滚/兼容策略和旧版本读写考虑。
- WebSocket/SSE/轮询状态必须定义断线、重连、重复消息、乱序和降级路径。

详细规则按需读取：

- UI 关联回归：`references/02-ui-regression-contract.md`
- 性能：`references/03-performance-contract.md`
- 全栈契约：`references/04-fullstack-contract.md`
- AIEfficiency 画像：`references/05-aiefficiency-profile.md`

### 6. 执行确定性门禁

静态检查：

```bash
node .agents/skills/aiefficiency-fullstack-quality/scripts/static-ui-audit.mjs --repo . --base <基线引用>
```

标准总门禁：

```bash
node .agents/skills/aiefficiency-fullstack-quality/scripts/quality-gate.mjs \
  --repo . --base <基线引用> --mode standard
```

首次建立审核后的基线时，显式执行：

```bash
node .agents/skills/aiefficiency-fullstack-quality/scripts/quality-gate.mjs \
  --repo . --mode deep --update-baseline
```

禁止在未人工确认页面正确的情况下更新视觉或性能基线。静态、构建、包体、页面或几何阻断存在时，脚本会拒绝写入新基线；更新基线不是修复失败。

只有经产品/技术负责人批准的包体预算变化，才可显式记录工单/原因：

```bash
node .agents/skills/aiefficiency-fullstack-quality/scripts/quality-gate.mjs \
  --repo . --mode deep --update-baseline \
  --accept-budget-change "TB-1234 approved editor chunk increase"
```

此参数只接受包体预算变化，不得绕过遮挡、越界、视觉差异、页面错误、安全或测试失败。

### 7. UI 关联回归最低矩阵

任何 UI 改动至少覆盖：

- **路由**：直接路由 + App shell + 影响图选出的相邻路由。
- **视口**：1024×768、1440×900、1920×1080；响应式或共享布局再加 390×844、768×1024、1366×768。
- **壳状态**：侧栏展开/收起；悬浮工具展开/收起/隐藏；主区滚动顶部与底部。
- **浮层**：Dialog、Drawer、Dropdown、Tooltip、Toast 与 FloatingDock 同时存在时的层级。
- **数据状态**：Loading、Empty、成功、长内容、Error、401、403、超时、离线/WS 断开。
- **操作状态**：首次进入、快速重复点击、请求中切换路由、刷新、返回、键盘 Tab/Escape。

浏览器脚本应检测横向溢出、视口外固定层、裁剪、交互控件被覆盖、弹窗越界、页面异常、控制台错误和性能差异，并保存截图与 JSON 证据。

### 8. 判定

- **P0 阻断**：页面崩溃/白屏、数据破坏、安全边界回退、关键流程不可用。
- **P1 阻断**：新增遮挡/越界/横向溢出、关键状态错误、视觉差异超预算、构建/测试失败、明显性能回退。
- **P2 警告**：非关键存量债务、可维护性或轻微一致性问题；必须登记但不擅自扩大修复。
- **SKIPPED 不是 PASS**：缺少浏览器、服务、认证或测试数据时，报告限制和替代证据。

### 9. 交付报告

最终回答和报告必须包含：

1. 根因与实施摘要。
2. 改动文件及其作用。
3. 影响路由、共享层、API/数据契约。
4. 实际执行的命令、退出码和结果。
5. 视口/状态/交互覆盖及截图位置。
6. 包体与浏览器性能基线、当前值和差异。
7. 未执行项、残余风险、回滚方式。

使用 `references/06-verification-report.md` 的格式。禁止用“应该没问题”“理论上通过”代替证据。

## AIEfficiency 特别约束

- 当前审计资料显示前端为 React/Vite/Tailwind，后端为 Node/Express/SQLite/WS；共享 App shell、180/56px 侧栏和右下 FloatingDock 是高关联点。实际仓库版本变化时，以 `doctor.mjs` 和源码扫描结果更新项目配置。
- `devbench/index.jsx`、`StoryTab.jsx`、`Settings.jsx` 等超大文件改动时，先缩小责任边界并建立反向依赖，不因文件大而跳过关联验证。
- 当前样式缺少完整语义组件/token 层；不得通过复制局部 className 或新增更高 z-index 继续扩大分歧。
- DevBench/Aiautowork/Settings 的错误和权限表现不一致；任何请求层改动都要验证 401/403/Error 不会伪装为 Empty。
- AIEfficiency 审计中存在工作区路径与执行权限 P0 风险；本 SKILL 不允许为开发便利放宽这些边界。

更多项目画像见 `references/05-aiefficiency-profile.md`。
