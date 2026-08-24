只根据 `REPORT_FACTS_JSON` 生成 TB 短评，不读工程、不运行工具、不重新分析。
严格输出：
## 简短报告
原因：<通俗原因>
措施：<通俗措施>
当 REPORT_FACTS_JSON.verificationStatus=SKIPPED_BY_USER 时，增加：测试验收：已按用户选择跳过，本轮未执行。
<!-- REPORT_DONE -->
“原因+措施”含标点不超过 {{MAX_CHARS}} 字；不得写路径、类名、方法名、提交号、测试清单或 AI 腔。证据不足时如实写明；跳过时不得声称测试、自测或验收通过。

<REPORT_FACTS_JSON>{{REPORT_FACTS_JSON}}</REPORT_FACTS_JSON>
