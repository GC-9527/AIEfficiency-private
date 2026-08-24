# 运行态故事点开发或缺陷修复完成后的验收 Prompt

先执行 `$acceptance-router` 并确认存在平台生成的 `story_point_id` 与不可变来源快照。本流程不按 Teambition、飞书、JIRA 或其他来源选择技术协议。

使用 `$runtime-story-point-assurance`：

1. 读取内部 StoryPoint 和所有已声明来源；列出实际读取/未读取材料。
2. 冻结来源快照、目标仓库候选、依赖/配置、Flavor/变体、环境、设备/AppMock 和制品身份。
3. 按 change_type 与风险选择 STORY-FAST/STANDARD/CRITICAL；默认 STANDARD。
4. DEFECT_FIX 建立基线复现/独立缺陷证据、根因链、竞争假设、Must Change/Must Preserve、基线红/候选绿。
5. FEATURE/REFACTOR/CONFIG/PACKAGE 等使用对应门禁，不伪造 baseline-red。
6. 完成 12 维影响矩阵；关键 UNKNOWN 时不得 VERIFIED。
7. 检查测试 Oracle 独立性、候选与证据一致性，并由只读 reviewer 复核；只有 CRITICAL 独立重跑关键 1–3 个门禁。
8. HARNESS_DEFECT、SOURCE_CONNECTOR、ENVIRONMENT 不得通过修改目标业务代码规避。
9. 需要修复时最多 2 轮，只修当前故事点候选的 INTRODUCED 阻断项，增量复验。
10. 分别输出 Story Point Decision、Source Sync Decision 和 Source Sync Status；回写失败不得篡改已经成立的技术结论。
