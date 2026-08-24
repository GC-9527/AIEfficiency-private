阶段：`TRIAGE`，只读，不修复。
读取 `requiredEvidence`；无法读取的逐项登记。分别判断现象、触发条件、应用实际行为、直接原因、根因责任方和可提供规避的一方，并至少验证一个替代假设。关联提交、进程名或“未崩溃”都不能单独证明归属。
只有时间、调用链、状态变化、可控代码路径中至少两类证据相互印证，才可判定 `CLIENT_ISSUE / NON_CLIENT_ISSUE / CROSS_COMPONENT`；否则为 `INSUFFICIENT_EVIDENCE`。
输出 `triage-result-v2`：状态、分类、置信度、根因边界、证据、反证、未读材料、下一阶段和通俗摘要。
