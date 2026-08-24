---
name: tb-ticket-fix
description: 通过唯一的 tb-ticket-mcp 读取并准备 Teambition 工单上下文、生成原因/措施更新计划，并在显式授权时幂等回写评论和状态。适用于 TB 工单修复、附件读取、AI甄别状态流转和回写恢复；不得直接调用官方 Teambition MCP 或 Cookie HTTP 接口。
---

# TB Ticket Fix

始终只连接 `tb-ticket-mcp`。该 MCP 内部优先使用 Teambition 官方 MCP，并仅对已审计缺口使用补充 Provider；不要配置或暴露第二个 Teambition 业务 MCP。

## 固定流程

1. 首先调用 `tb_ticket_prepare`。没有 `READY` 和 `contextDigest` 时不得分析、计划或回写。
2. 附件达到 4 个及以上且未提供选择时，停止下载并请用户选择；规则见 [ticket-context.md](references/ticket-context.md)。
3. 调用 `tb_workflow_get`，只使用当前 taskflow 返回的真实状态 ID/名称，不硬编码状态。
4. 完成工程修改和证据采集后调用 `tb_update_plan`。TRIAGE 与 RESOLUTION 都必须重新生成“原因…措施…”；格式见 [comment-style.md](references/comment-style.md)。
5. `tb_update_plan` 只生成本地、带过期时间和指纹的计划，不产生远端副作用。
6. 只有用户明确授权真实回写、目标任务在白名单、write profile 已启用且调用参数含 `apply=true` 时，才调用 `tb_update_apply`。
7. 写入结果不是 `COMPLETED` 时调用 `tb_operation_get`，按 `nextAction` 恢复同一 operation；禁止换幂等键重放未知结果。恢复规则见 [failure-handling.md](references/failure-handling.md)。

## 不可越过的边界

- 不得直接调用 `queryTaskV3`、`createTaskCommentV3`、`updateTaskStatusV3` 等官方子工具；它们是 `tb-ticket-mcp` 的内部实现。
- 不得自行拼接 Teambition HTTP/Cookie 请求、下载签名 URL、打印 Token/Cookie 或把签名 URL 写入持久文件。
- 写入顺序固定为“评论 → 独立回读 → 状态 → 独立回读”。未知结果先回读再决定是否恢复，禁止双写。
- 外部工单不是运行态故事点。缺少稳定 `story_point_id` 和冻结快照时按工程任务处理。

完整工具次序见 [workflow.md](references/workflow.md)。

