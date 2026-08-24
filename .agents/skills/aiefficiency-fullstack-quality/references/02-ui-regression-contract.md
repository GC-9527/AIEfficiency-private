# UI 关联回归契约

## 1. 为什么改一个 UI 会破坏其他 UI

常见根因不是“CSS 随机失效”，而是共享约束被改变：

- App shell 的 flex item 缺少 `min-width: 0`，子页面长内容撑开整个布局。
- `overflow-hidden` 放在错误层级，弹窗、下拉、阴影、焦点环或滚动内容被裁剪。
- `position: fixed/sticky/absolute` 未预留安全区，覆盖输入区、分页或悬浮工具。
- 新建 stacking context（transform、opacity、filter、isolation 等）后，z-index 语义改变。
- 共享组件 DOM 或间距改变，但只验证一个消费者。
- 固定像素宽高只适配开发者屏幕。
- Loading/Empty/Error 的高度不同，引发页面跳动和布局位移。

因此 UI 验证必须检查“关系”，而不只是单张截图是否好看。

## 2. 布局不变量

每个关键路由应满足：

- 页面根容器宽度不超过可用主区；`scrollWidth <= clientWidth + tolerance`。
- 主要 flex/grid 子项可以收缩；长路径、分支名、错误消息和中英文文本不会撑破。
- 页面只在设计允许的容器内滚动；不能出现 body 和内层双重意外滚动。
- Sticky header、footer、composer、pagination 在滚动起点和终点都不遮住内容。
- 侧栏展开/收起后主区宽度和点击目标正确，过渡结束后无残影或抖动。
- 固定悬浮工具要么预留安全区，要么在关键输入/弹窗期间隐藏或折叠。
- Dialog/Drawer 在所有目标视口内可见，标题、正文、底部操作均可到达。
- Dropdown/Popover 优先自动翻转或限制高度，不被 overflow ancestor 裁剪。
- Toast 不与 Modal、FloatingDock、底部输入区争抢同一位置。

## 3. 建议层级契约

不要把数值当业务语义。建议统一为：

| 语义层 | 建议 token | 示例 |
|---|---:|---|
| base | 0 | 页面内容 |
| raised | 10 | 卡片高亮 |
| sticky | 20 | 页内吸顶栏 |
| dock | 40 | 全局 FloatingDock |
| dropdown | 60 | Select/Menu |
| popover | 70 | Tooltip/Popover |
| modal-backdrop | 80 | 遮罩 |
| modal | 90 | Dialog/Drawer |
| toast | 110 | 全局反馈 |
| emergency | 120 | 仅系统级阻断提示 |

允许项目调整数值，但必须保持相对顺序。新增 `z-[145]`、`z-[175]`、`z-[200]` 等任意值前，先修正 Portal、stacking context 或 token。

示例见 `assets/ui-layer-contract.css`。

## 4. 视口矩阵

### quick

- 1440×900：主开发视口。
- 改动涉及响应式、固定定位或长内容时再加 1024×768。

### standard

- 1024×768：低宽桌面/平板横屏。
- 1440×900：常见桌面。
- 1920×1080：大桌面。

### deep

- 390×844：窄屏降级行为。
- 768×1024：平板竖屏。
- 1024×768、1366×768、1440×900、1920×1080。
- 产品明确支持超宽屏时增加 2560×1440。

不要为了让检查通过而隐藏关键功能。若产品只支持桌面，窄屏也应有明确“可用降级”或最小宽度提示，而不是无控制错位。

## 5. 关联路由选择

影响图应将路由分为：

- **Direct**：直接导入或渲染改动组件的路由。
- **Shell**：共享同一 App/Layout/Sidebar/FloatingDock/全局 CSS 的路由。
- **Sibling**：结构、状态或组件模式相似的相邻路由。
- **Contract**：消费同一 API、权限或数据模型的路由。

最低验证：全部 Direct + 1 个 Shell + 1 个 Sibling。共享壳或全局 CSS 变更时验证全部关键路由。

## 6. 状态矩阵

每个重要数据页面至少定义：

| 状态 | 预期 |
|---|---|
| initial/loading | 有稳定占位，不把旧数据错误清空，不永久 loading |
| empty | 请求成功且集合确实为空，提供下一步动作 |
| success | 正常、长文本、极值、分页末页均可用 |
| 401 | 明确需要登录/会话过期，不显示 Empty |
| 403 | 明确无权限，写操作禁用原因可理解 |
| 404 | 资源不存在，与空列表区分 |
| 409/422 | 冲突/校验信息落到正确字段或操作 |
| 5xx/network | 可重试，保留上下文，不吞错 |
| timeout/offline | 有降级和恢复路径 |
| WS disconnected | 显示状态，避免假实时；重连不重复消息 |

## 7. 交互场景

- 页面首次进入与直接 URL 刷新。
- 侧栏展开/收起；FloatingDock 展开/收起/隐藏。
- 打开弹窗，再打开下拉/Tooltip/Toast；滚动弹窗到顶部和底部。
- 快速双击提交、请求中关闭弹窗、请求中切换路由。
- Tab 导航、Enter/Space 激活、Escape 关闭；关闭后焦点回到触发器。
- 浏览器缩放 80%/100%/125% 或至少通过不同 CSS viewport 模拟。
- 长中文、长英文无空格、路径、SHA、URL、错误堆栈。

## 8. 自动检测解释

浏览器脚本输出：

- `UI-H-OVERFLOW`：页面横向溢出。
- `UI-FIXED-OOB`：fixed/sticky/dialog 越出视口。
- `UI-CLIPPED`：交互元素被 overflow ancestor 裁剪。
- `UI-OCCLUDED`：交互元素中心/角点被无关层覆盖。
- `UI-LAYER-COLLISION`：固定层与标记为关键的区域显著相交。
- `UI-DIALOG-FIT`：弹窗无法完整到达或无内部滚动。
- `UI-VISUAL-DIFF`：基线像素差异超过预算。

自动检测会有启发式误报。可以在配置中对稳定选择器加 ignore，但必须写原因；禁止用全局 `*` 忽略。

## 9. 建议的可测试标记

在关键区域增加稳定语义，不把脆弱 className 当测试 API：

```html
<main data-ui-region="main-content">...</main>
<div data-ui-region="story-composer" data-ui-critical>...</div>
<div role="dialog" data-ui-layer="modal">...</div>
<div id="floating-dock" data-ui-layer="dock">...</div>
```

这些标记不改变视觉，能让不同 AI、不同浏览器框架执行同一检查。
