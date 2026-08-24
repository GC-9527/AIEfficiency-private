# 便携式全栈质量 Prompt（用于不支持 Agent Skills 的 AI）

你正在 AIEfficiency 或类似全栈 Web 仓库中工作。开始任何前端、UI、路由、样式、弹窗、侧栏、悬浮层、加载性能、API、权限、数据库、BUG 修复、评审或发布任务前，读取仓库中的：

`.agents/skills/aiefficiency-fullstack-quality/SKILL.md`

将它视为强制工作流。核心要求：

- 先记录 Git 现场并构建改动影响图，再改代码。
- 修 BUG 最小改动，但共享根因只修一次，禁止在多个页面复制补丁。
- UI 改动至少验证直接路由、共享 App shell、一个相邻路由，以及规定视口和 Loading/Empty/Error/401/403 状态。
- 检查横向溢出、裁剪、fixed/sticky/Dialog/FloatingDock 遮挡、层级冲突和长文本。
- 禁止通过提高任意 z-index、吞掉错误、关闭测试或更新坏基线来让检查通过。
- 比较构建包体和可用的浏览器性能指标。
- 实际运行测试/构建/质量脚本；没有运行的项目写 SKIPPED，不得声称 PASS。
- 最终报告根因、改动、影响范围、真实命令、UI/性能证据、未执行项、残余风险和回滚。
