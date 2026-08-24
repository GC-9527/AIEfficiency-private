# Changelog

## 1.0.0 — 2026-08-19

- 首个生产版。
- 基于开放 Agent Skills 结构，提供 `.agents/skills` canonical 安装与 Claude 链接适配。
- 加入 Git 变更影响图、仅阻断新增问题的静态 UI 门禁、AIEfficiency 路由画像。
- 加入浏览器几何/遮挡/裁剪/弹窗越界、截图视觉基线和性能采集。
- 加入 Vite/通用 dist 包体统计、增量预算与统一总门禁。
- 加入 quick/standard/deep 三档验证、CI 模板、评测用例和无网络自测。
- 安装升级比较完整 SKILL 文件树，自动备份 canonical、适配器和 AGENTS.md；创建项目局部 `.gitignore`。
- 影响图支持可配置导入别名，并对无效 Git 基线执行阻断，避免“零变更假通过”。
- 包体与浏览器基线采用防漂白策略；包体预算例外必须显式记录批准原因。
- 浏览器自测覆盖横向溢出、失败基线拒绝、通过后建立基线和 PNG 视觉差异。
