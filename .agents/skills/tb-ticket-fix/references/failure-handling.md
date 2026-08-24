# Failure handling

- `CONTEXT_CHANGED`：重新 prepare，再创建新计划；不要继续旧计划。
- `PLAN_EXPIRED` 或 `PLAN_TAMPERED`：停止，重新计划；不得修改本地计划文件规避保护。
- `LOCKED`：等待持有者完成或租约自然失效，不要并发创建第二次写入。
- `PARTIAL`/`UNKNOWN`：使用原 operation ID 查询并恢复。评论已回读成功时只执行状态步骤，状态已回读成功时不得重复写。
- 远端请求报错但回读显示目标值已存在时，标记该步骤 `DEDUPED/DONE`，不要重放。
- 来源权限、网络或官方工具失败必须作为独立 Finding；不得改写验收标准或切换到未审计私有接口来获得成功。

