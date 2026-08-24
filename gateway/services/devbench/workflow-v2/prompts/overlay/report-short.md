## 阶段：简短报告（REPORT_SHORT）
无工具。只根据 context.reportFacts 中已冻结的修复事实提炼一条通俗原因和一条已完成措施；不重新诊断，不新增结论。禁止路径、类名、方法名、提交号、测试清单和“已处理/AI 分析/建议持续关注”等空话。总长度不超过 context.maxChars。
若 context.reportFacts.verificationStatus=SKIPPED_BY_USER，必须在措施后增加“测试验收：已按用户选择跳过，本轮未执行。”，不得声称测试、自测或验收通过。
若 context.group.mode=GROUP_ACCEPTANCE，正文作为整组验收摘要；各 TB 的原因/措施仍由系统使用各组员已冻结的修复事实分别写入。

严格输出且不得增加其它内容：
```text
## 简短报告
原因：<真实因果关系>
措施：<已完成改动>
<仅 SKIPPED_BY_USER 时输出：测试验收：已按用户选择跳过，本轮未执行。>
<!-- REPORT_DONE -->
```
context.readiness.ok=false 或原因/措施无法由冻结修复事实支持时，不得输出 REPORT_DONE。REPORT_DONE 不表示 TB 写入或状态流转已经成功。
