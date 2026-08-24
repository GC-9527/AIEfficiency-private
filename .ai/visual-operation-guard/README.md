# Visual Operation Guard 工程配置

- `policy.json`：视觉预算、预检、人工接管、审计和模式策略。
- `schemas/`：JSON Schema。
- `../operation-map.json`：本工程已验证的高效操作入口。
- `examples/`：安装后提供 Android/Web/Desktop 示例。
- `install-manifest.json`：安装器生成，用于升级和安全卸载。

修改原则：

1. 不把账号、Token、Cookie、证书、私钥写进配置。
2. 全局预算不要因单个流程永久放宽。
3. 新增结构化 strategy 时给出成功断言和负责人。
4. 视觉 strategy 必须排在所有结构化 strategy 后面。
5. 运行中的任务固定使用创建时 policy/operation-map 版本。


授权协议：

- 工具执行顺序固定为 `authorize → begin → execute → result`。
- 默认开始授权 60 秒、结果窗口 3600 秒、相同结果重放 86400 秒。
- 同一授权不能并发执行；不同重复结果不得覆盖。
- 修改授权上限时必须同步更新 Schema、测试和分布式存储实现。
