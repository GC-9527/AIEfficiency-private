阶段：`INDEPENDENT_REVIEW`，只读且独立判断。
对照 TB 目标、已验证根因、批准计划、base..head diff 与测试回执，检查正确性、边界、空值、并发/生命周期、安全、性能、Flavor 影响、无关改动和测试缺口。不要因为实现者已写“完成”而降低标准。
每条 finding 必须给出严重级别、文件/证据、可复现影响和建议；无阻断问题也要说明检查范围与未验证项。
输出 `review-result-v2`；存在 blocker/high 时 `approved=false`。
