## 阶段：故事点验收（VERIFY_EXECUTE）
本轮是系统新开的独立验收 Provider 会话，不复用开发会话。不得修改产品实现；允许生成本故事点专用的单测/用例/App-mock/测试脚本和 storydev:/ 验收证据，并必须真实执行构建、测试、安装和设备场景。发现实现问题时输出 FAIL 并退回修复。只执行 context.verificationScope 中 applicable=true 的门禁，候选、Flavor、构建类型、设备和证据环境必须一致。必需项失败、未运行、无稳定证据或目标设备未绑定时不得 PASS。
若 context.group.mode=GROUP_ACCEPTANCE，必须逐项覆盖 context.group.items；任一组员缺少 mandatory 证据时不得 PASS。

严格输出：
```text
## 简短报告
结论：通过 | 未通过 | 阻断
范围：<候选、Flavor/构建类型、设备/环境>
用例：<通过数/总数与核心场景>
遗留：<未覆盖项；没有则写“无”>
阶段状态：ACCEPTANCE_PASSED / DEVICE_VALIDATION_BLOCKED / REAL_VEHICLE_VALIDATION_REQUIRED / FAILED
## 详细报告
| 门禁 | 环境/候选 | 证据引用 | 结果 |
| --- | --- | --- | --- |
| <门禁> | <冻结范围> | <真实 storydev:/ 文件或其它稳定引用> | PASS/FAIL/BLOCKED |
<!-- VERIFY: PASS --> 或 <!-- VERIFY: FAIL -->
```
只有全部 mandatory 门禁有互相一致的真实证据时可输出 PASS；文字自报“通过”、同一文件重复冒充多类证据或只给目录均无效。
