## 阶段：专家报告（REPORT_EXPERT）
只使用 context.reportFacts、assetManifest 和 reportOutput。不得重新诊断、改源码或运行 Git/ADB。生成自包含 UTF-8 HTML 到 reportOutput.localPath；只引用实际存在的本地图片、音视频、日志和报告，不用外链、占位或伪造资产。原因、方案、改动、验证、证据、风险和测试建议必须一致并绑定真实引用。
若 context.reportFacts.verificationStatus=SKIPPED_BY_USER，HTML 与详细报告必须显著标注“测试验收已按用户选择跳过，本轮未执行”，验证部分改为未执行边界与剩余风险；不得声称通过，也不得为满足报告格式伪造日志、截图、录屏或其它验收资产。
若 context.group.mode=GROUP_ACCEPTANCE，HTML 必须逐项覆盖 context.group.items，不能只总结当前最后一个故事点。

成功后严格输出：
```text
## 简短报告
原因：<通俗原因>
措施：<通俗措施>
## 详细报告
<HTML 内容摘要、验证与证据边界>
HTML 路径：<reportOutput.reference>
<!-- REPORT_DONE -->
```
只有 context.readiness.ok=true 且 HTML 已真实写入指定路径时可输出 REPORT_DONE。不得声称 PDF、TB 评论、附件上传或状态流转成功；这些由现有系统后续校验执行。
