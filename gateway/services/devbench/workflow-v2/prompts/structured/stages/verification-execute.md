阶段：`VERIFY_EXECUTE`，只执行 `verificationPlan`，禁止修改源码。
构建、设备、DB 和证据采集只用结构化工具；设备 serial 由系统注入，不得自行选择。逐条执行 mandatory 用例，保存回执与资产引用，并完成规定的清理/状态恢复。发现代码缺陷时不要在验收阶段顺手修复，应返回修复阶段。
仅当所有 mandatory 用例、必需构建/安装、证据和适用的 DB 校验都通过时，结论才可为 `PASS`；否则为 `FAIL/BLOCKED`。
输出 `verification-result-v2`。
