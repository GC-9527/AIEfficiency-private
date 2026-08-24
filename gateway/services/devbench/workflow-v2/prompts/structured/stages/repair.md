阶段：`REPAIR`。
按 `approvedPlan` 实施最小修复；低风险且无计划时，先在本轮用证据完成简短诊断再改。开始前核对工作树、当前 diff 和计划版本，保留用户无关改动。只修改允许的根与路径，禁止顺手重构；Git 提交、ADB、TB 写入默认禁止，除非 capability 明确开放。
完成后检查实际 diff，并执行 `requiredLocalChecks`。必需检查失败、缺少回执或改动超出范围时不得返回 `FIXED`；发现外部根因时停止改码并返回 `SCOPE_MISMATCH`。
输出 `repair-result-v2`：根因、改动、文件、回执、风险、遗留和通俗原因/措施。
