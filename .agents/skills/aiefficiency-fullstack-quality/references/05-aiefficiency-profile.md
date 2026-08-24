# AIEfficiency 工程画像（审计基线）

> 来源：用户提供的 `AIEfficiency_Platform_Integration_Audit_20260813_104124_PARTIAL`。该审计是部分证据包，不等同于当前仓库完整源码；实际执行时必须重新探测，不可把本文件当永远正确的事实。

## 1. 已知技术栈

- Web：React 19、React Router 7、Vite 6、Tailwind 3。
- Gateway：Node/Express、better-sqlite3、ws、node-cron；审计时声明 Node 24.14.1。
- 审计统计：25 条前端路由、588 个后端 API、94 张 SQLite 表。
- Web 3000 代理 API/WS 到 Gateway 3001。

## 2. 高关联 UI 结构

- `web-dashboard/src/App.jsx` 提供共享侧栏、Outlet/Suspense 和 FloatingDock。
- 侧栏审计时展开 180px、收起 56px，使用 inline width transition。
- 主区为 flex + `overflow-hidden`，子页面必须正确设置收缩和滚动边界。
- `FloatingDock.jsx` 位于右下，展开宽约 148px，`z-40`，小于 `sm` 隐藏；它本来就是为避免覆盖 DevBench 操作区而引入，因此任何底部/右侧操作区修改都要联动验证。
- 项目大量局部 Tailwind class，未发现统一 Button/Card/Dialog 或完整语义 token。
- 审计证据中存在多档任意 z-index（如 60、70、80、90、145、175、180、200）和固定宽度，层级冲突概率高。

## 3. 代码耦合热点

审计时部分大文件：

- `web-dashboard/src/pages/devbench/index.jsx`：约 268 KiB / 5,000+ 行。
- `StoryTab.jsx`：约 355 KiB。
- `Settings.jsx`：约 181 KiB。
- `StoryInitializationPanel.jsx`：约 109 KiB。
- `TaskPanel.jsx`：约 86 KiB。

这些数值仅用于风险提示。修改大文件时：

1. 先定位具体状态和渲染责任。
2. 使用 import/调用/字符串 API 反向影响图。
3. 优先添加模型测试或抽离纯逻辑。
4. 不因难以理解而全文件格式化或大范围重写。

## 4. 关键路由回归组

默认关键路由：

- `/devbench`
- `/aiautowork`
- `/aiautowork/settings`
- `/settings`
- `/devices`
- `/admin`

共享壳变更时全部验证。DevBench 局部 UI 变更最低验证 `/devbench` + `/aiautowork` + `/settings`；Aiautowork 设置变更最低验证 overview/settings + 平台 `/settings`，避免同名设置语义混淆。

## 5. 已知状态风险

- DevBench 初始项目/Tab 请求失败可能返回空数组，401 可能呈现为“还没有故事点”。
- Aiautowork 多个请求可能把失败吞为 null/空。
- DevBench、Aiautowork、Admin、Devices、Settings 的错误/权限状态不一致。
- 根层审计时未发现 404 和 ErrorBoundary。

因此修改请求层、错误处理、路由或空态时，必须专门测试 401、403、5xx、网络失败和未知路由。

## 6. 已知性能结构

- 顶层路由使用 React `lazy()`。
- AdminPlatform 在 idle/timeout 预加载。
- 依赖含流程图、html2canvas、jszip、Markdown 等重型功能；避免将其提升到共享 App 初始路径。
- Aiautowork 审计时使用 5/8/10/15 秒轮询；修改时检查重复 timer、隐藏页停止、WS/SSE 规划和 source of truth。

## 7. 当前项目命令（执行前重新读取 package.json）

Web：

```bash
npm --prefix web-dashboard run build
npm --prefix web-dashboard test
```

Gateway：

```bash
npm --prefix gateway test
```

Gateway 全量测试可能成本较高；quick 仅在 gateway 改动时运行配置的聚焦检查，standard/deep 再按影响范围扩大。绝不因为测试慢而静默跳过。

## 8. 安全 P0

审计指出执行器 token、loopback/admin、整机目录枚举、Git 操作和任意 projectDir/shell acceptance 可能缺乏统一边界。任何触及这些代码的任务都归为 deep，并优先安全测试；UI 体验优化不能弱化后端授权。

## 9. 审计局限

审计截图阻断了 API/WS，只证明前端隔离渲染；未验证登录态、真实数据、多节点、Provider、真实 Git/ADB/Gradle 写操作或生产端到端。运行本 SKILL 时应以当前仓库和当前环境为准。
