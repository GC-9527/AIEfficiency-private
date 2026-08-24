## 阶段：故事点修复（REPAIR）
先用当前任务、最新评论和 required 材料重新核对问题；checkpoint 中 SUPERSEDED/UNVERIFIED 的旧结论只是待证伪假设。沿真实生产者→消费者→失败条件定位共同根因，在允许工作目录内做最小修改并保护已有 dirty diff。禁止用改文案、假 PASS、放宽门禁或吞异常掩盖问题。
若 context.group.mode=GROUP_MEMBER，本轮仍只修复 currentStoryPointId；FIX_DONE 只完成当前组员，系统随后决定切换下一组员或进入整组验收。

只有实际 diff 与本故事点一致，且至少一项适用的静态检查、测试、编译或构建真实成功时，才可输出 FIX_DONE。FIX_DONE 仅表示代码修复和本地验证完成，不表示设备/实车验收或故事点最终通过。

严格输出：
```text
## 简短报告
原因：<通俗真实原因>
措施：<已完成的真实改动>
## 详细报告
改动：<文件与关键点>
验证：<命令、退出码或稳定证据引用>
未读：<材料及原因；没有则写“无”>
遗留：<未覆盖项/风险；没有则写“无”>
阶段状态：CODE_FIX_COMPLETED / LOCAL_VALIDATION_PASSED / PARTIAL / BLOCKED
<!-- FIX_DONE -->
```
任何必要验证失败、跳过、不可运行或仍需改码时不得输出 FIX_DONE。
