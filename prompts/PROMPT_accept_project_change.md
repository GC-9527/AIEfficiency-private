# 当前工程开发或缺陷修复完成后的验收 Prompt

先执行 `$acceptance-router`。本任务应路由为：

```text
task_origin: DIRECT_ENGINEERING
scope_kind: PROJECT_ENGINEERING
protocol: project-engineering-acceptance
```

随后使用 `$project-engineering-acceptance`：

1. 自动识别 change_type；开发/修复完成默认 `PROJECT-STANDARD`，只有明确发布候选才使用 `PROJECT-RELEASE`。
2. 冻结当前工程候选、依赖/配置、环境和制品身份。
3. 从真实脚本选择受影响门禁，禁止机械执行无关设备、AppMock、Flavor 或完整安装升级。
4. 缺陷修复建立复现、根因、竞争假设、Must Preserve 和差分回归；功能开发建立验收标准追踪和异常/兼容路径。
5. 默认只读验收；需要修复时仅修 INTRODUCED 阻断项，最多 2 轮，并增量复验。
6. 输出 Project Change Decision；除非完整 PROJECT-RELEASE 通过，否则 Production Readiness 必须为 NOT_ASSESSED/NOT_READY。
7. 列出实际命令、退出码、证据、UNKNOWN 与剩余风险，不得使用“全面没有问题”等绝对表述。
