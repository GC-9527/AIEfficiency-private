# Workflow

唯一外部服务 `tb-ticket-mcp` 提供：

1. `tb_ticket_prepare`：解析工单、补齐审计缺口、选择性下载附件、返回冻结上下文。
2. `tb_workflow_get`：读取当前 taskflow 及精确状态。
3. `tb_update_plan`：本地生成 TRIAGE/RESOLUTION 计划、指纹和幂等键。
4. `tb_update_apply`：仅 write profile 暴露；执行有锁、白名单、过期、指纹和回读保护的写入。
5. `tb_operation_get`：读取持久 operation 并指导恢复。

read profile 不暴露 `tb_update_apply`。官方 MCP 是内部子进程，补充 Provider 是内部库，两者都不是 Agent 可选入口。

