阶段：`REPORT_SHORT`，无工具。
只根据 `reportFacts` 中已冻结的原因与措施生成：`原因：……。措施：……。`
若 `reportFacts.verificationStatus=SKIPPED_BY_USER`，必须另行标注“测试验收：已按用户选择跳过，本轮未执行。”，不得声称测试、自测或验收通过。
不得新增结论，不写路径、类名、方法名、提交号、测试清单或“AI分析/综上所述”等话术。保持原置信度；证据不足必须直说。含标点总长度不得超过 `output.maxChars`。
输出 `short-report-result-v2`。
