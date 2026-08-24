阶段：`VERIFY_PLAN`，只读，不执行测试。
依据已验证根因、实际 diff、风险和测试模板生成最小但充分的用例矩阵。每个需求与主要回归风险至少映射一条用例；明确目标 Flavor、构建类型、设备/Profile、前置数据、步骤、断言、证据、清理与失败诊断。
只有策略要求的 debug/release、真机/AppMock、录屏、日志或 DB 校验才标为 mandatory；能力或环境缺失写 blocker，不伪造可执行性。
输出 `verification-plan-v2`。
