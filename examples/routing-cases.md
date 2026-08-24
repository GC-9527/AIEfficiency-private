# 验收路由示例

| 场景 | 路由 | 模式/风险 | 结论 |
|---|---|---|---|
| 直接开发 DevBench 新页面 | DIRECT_ENGINEERING / PROJECT_ENGINEERING | PROJECT-STANDARD | Project Change |
| 直接修复 Gateway 崩溃 | DIRECT_ENGINEERING / PROJECT_ENGINEERING + DEFECT_FIX | PROJECT-STANDARD | Project Change |
| 发布 AIEfficiency Linux 中心机新版本 | DIRECT_ENGINEERING / PROJECT_ENGINEERING | PROJECT-RELEASE | Production Readiness |
| 飞书工单转故事点，修 Android App UI | RUNTIME_STORY_POINT / STORY_DELIVERY | STORY-STANDARD | Story Point + Source Sync |
| JIRA 需求转故事点，新增后端接口 | RUNTIME_STORY_POINT / STORY_DELIVERY + FEATURE | STORY-STANDARD | Story Point |
| 手工故事点只改文档且低风险 | RUNTIME_STORY_POINT / STORY_DELIVERY | STORY-FAST | Story Point |
| Teambition 来源故事点修改公共 SDK、多 Flavor | RUNTIME_STORY_POINT / STORY_DELIVERY | STORY-CRITICAL | Story Point |
| 故事点失败实际是 AppMock 切换错误 | STORY_DELIVERY → HARNESS_DEFECT | 故事点 PARTIAL/BLOCKED + 新工程任务 | 两个状态 |
| 故事点要求修改编排器并同时修改目标 App | RUNTIME_STORY_POINT / DUAL_SCOPE | PROJECT-STANDARD + STORY-* | 两个独立结论 |
| 故事点目标就是 AIEfficiency 平台 | RUNTIME_STORY_POINT / DUAL_SCOPE | Story 验收；部署前 PROJECT-RELEASE | VERIFIED 不替代 READY |
| 故事点技术 VERIFIED，但 JIRA 回写超时 | STORY_DELIVERY | 技术结论保持 VERIFIED | Source Sync FAILED |
| 只拿到一张外部工单 URL，尚未生成 story_point_id | BLOCKED_ROUTING | 先规范化 | 不得直接 PASS |
