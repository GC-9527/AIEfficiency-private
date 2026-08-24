# TB Ticket Toolkit 0.6.0

Teambition 工单修复工具链只提供一个外部 MCP：`tb-ticket-mcp`。

```text
Codex / tbfix / AIEfficiency adapter
                 │
                 ▼
          tb-ticket-mcp
                 │
        shared application/domain
          ┌──────┴────────┐
          ▼               ▼
 official Teambition MCP  audited supplement
 (covered capabilities)   (gaps only)
```

`@tng/teambition-openapi-mcp@0.2.2` 作为内部子进程承担它已经覆盖的任务、评论、附件元数据、工作流、评论写入和状态写入。仓库内补充 Provider 只承担经审计的缺口：OpenAPI 权限失败时的 Cookie 只读兜底、富文本备注/备注图片和受控附件字节下载。二者都不作为第二个业务 MCP 暴露。

## 对外工具

read profile 暴露：

- `tb_ticket_prepare`
- `tb_workflow_get`
- `tb_update_plan`
- `tb_operation_get`

write profile 在同一个 MCP 上额外暴露 `tb_update_apply`。远端写入还必须同时满足 `TB_TOOLKIT_WRITE_ENABLED=true`、任务白名单、未过期计划、正确指纹/幂等键和 `apply=true`；顺序固定为评论、回读、状态、回读。

## 本地命令

```powershell
npm --prefix tools/tb-ticket-toolkit install
npm --prefix tools/tb-ticket-toolkit test
npm --prefix tools/tb-ticket-toolkit run check
node tools/tb-ticket-toolkit/apps/tbfix-cli/src/index.js doctor --json
```

MCP 配置只登记 `tb-ticket-mcp`，示例见 [config/mcp.stdio.example.json](config/mcp.stdio.example.json)。不要另外登记官方 MCP 或补充 Provider。

## 安全边界

- 默认 read profile，Gateway 迁移开关默认 `off`；`shadow` 只比较读取，不产生 canonical 写入。
- 签名 URL 和凭据只保留在进程内，不写 context、manifest、operation 或日志。
- 附件使用 DNS 固定、HTTPS、私网/SSRF 阻断、大小/超时限制和原子落盘。
- 评论与状态分别回读；未知写结果恢复同一 operation，不换幂等键重放。
- 真实 Teambition canary 必须使用隔离测试工单和显式写授权；离线测试不能替代真实环境证据。

