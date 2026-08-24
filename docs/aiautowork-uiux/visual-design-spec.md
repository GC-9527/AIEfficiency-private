# 视觉设计规范

## 设计方向

延续现有深色 Zinc 工作台，不制作营销页。通过更清晰的层级、统一状态 Token、紧凑表格和渐进披露提升专业度。

## 色彩 Token

| Token | 值 | 用途 |
|---|---|---|
| `--bg-app` | `#0f0f10` | 页面背景 |
| `--bg-sidebar` | `#18181b` | 一级导航 |
| `--bg-panel` | `#151518` | 面板 |
| `--bg-raised` | `#1c1c20` | Hover/浮层 |
| `--border` | `#2a2a2f` | 常规边框 |
| `--border-strong` | `#3f3f46` | 选中与强调 |
| `--text-primary` | `#f4f4f5` | 标题 |
| `--text-secondary` | `#a1a1aa` | 正文 |
| `--text-muted` | `#71717a` | 辅助信息 |
| `--accent` | `#3b82f6` | 主操作、选中 |
| `--success` | `#22c55e` | 通过、完成、运行 |
| `--warning` | `#f59e0b` | 建议确认、等待人工 |
| `--danger` | `#ef4444` | 失败、阻断、Critical |
| `--info` | `#06b6d4` | 推导、自检、自动修复 |
| `--violet` | `#8b5cf6` | Git Review、候选版本 |

禁止大面积渐变。仅允许在极小品牌标识或加载骨架中使用低对比渐变。

## 字体

- 系统字体：`-apple-system, BlinkMacSystemFont, Segoe UI, Noto Sans SC`。
- 代码和 ID：`ui-monospace, SFMono-Regular, Consolas`。
- 页面标题：18px / 600。
- 区块标题：14px / 600。
- 表格主文案：12px / 500。
- 正文：12px / 400。
- 标签和辅助信息：10–11px。
- 最小可读字号：10px，仅用于 ID、时间和元数据。

## 间距

基于 4px：

- 组件内部：4 / 8 / 12px。
- 面板内边距：12 / 16px。
- 页面边距：20 / 24px。
- 大区块间距：20px。
- 表格行高：48–56px。

## 圆角和阴影

- 标签：4px。
- 输入、按钮：6px。
- 面板：8px。
- Drawer/Dialog：10–12px。
- 阴影只用于 Drawer/Dialog/Popover，不给普通面板加重阴影。

## 状态视觉

状态组件由图标、文字、浅背景和边框组成：

- 草稿/待识别：灰色，文档图标。
- 推导/自检/自动修复：Cyan，旋转或脉冲进度图标。
- 自动通过/已就绪/已完成：Green，勾选图标。
- 建议确认/等待人工：Amber，人员或警告图标。
- 阻断/失败/Critical：Red，阻断或错误图标。
- 排队：Blue-gray，队列图标和位置。
- 已暂停：Zinc，暂停图标。
- 已取消：Zinc + 删除线。

## 来源视觉

- TB：链路图标 + `TB` 文本标签，蓝色边框。
- MANUAL：文档图标 + `MANUAL`，中性灰边框。
- GIT_REVIEW：分支图标 + `GIT REVIEW`，Violet 边框。

## 按钮层级

1. Primary：蓝色实心，每个区块最多一个。
2. Secondary：深色背景 + 边框。
3. Tertiary：纯文字。
4. Danger：红色边框/实心，仅确认后执行。
5. More：三个点图标。

行级最多一个 Primary。

## 表格

- 表头 34px、10px 字号、Sticky。
- 行 50px 左右，不使用大卡片。
- 第一列和摘要列可固定。
- Hover 使用 `#1a1a1e`。
- Selected 使用蓝色左边线和低饱和背景。
- 错误行不整行纯红，只在状态、关键字段和左边线强调。

## 表单

- 输入高度 34px，复杂文本 96px 起。
- Label 11px，必填使用文字“必填”或星号加说明。
- 错误信息紧贴字段。
- AI 推导值显示来源和“候选”标记。
- 用户锁定显示锁图标和不可自动覆盖提示。

## 响应式

- 1366×768：一级导航 196px；页面左右边距 16px；表格横向滚动。
- 1440×900：默认密度。
- 1920×1080：内容最大宽度 1680px，右侧可展示 Inspector，不扩大字号。
- Drawer 宽度：min(760px, 90vw)；创建 Drawer：min(1040px, 94vw)。

