# Ticket context and attachments

- `tb_ticket_prepare` 必须完整读取任务详情、评论、任务附件、评论附件和富文本备注图片。
- 任一必需来源不可用时结果应为 `BLOCKED/CONTEXT_INCOMPLETE`，不得把未知数量当作 0。
- 0–3 个附件默认全部下载；4 个及以上先返回候选清单，由用户按 ID 选择或明确选择全部。
- 下载必须原子落盘并保存 byte size 与 SHA-256 receipt；中断时清理 `.part`。
- 签名 URL、Cookie、Authorization 和其他凭据只能存在于进程内，不得进入 context、manifest、日志或报告。
- 本地准备文件写入 Git exclude 覆盖的 `temp/<taskNo>/`，不得污染目标仓库状态。

