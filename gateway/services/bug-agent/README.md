# bug-agent

AAOS Bug 分析 Agent 实施代码。

方案依据：`docs/BugAnalysisAgent-Plan-Final.md`（v3.3）。

## 目录结构（随阶段推进逐步补齐）

```
bug-agent/
├── llm/                    # §5.2-§5.3 LLM 调用层
│   ├── injection-detector.js   # §5.2 Prompt 注入预检
│   ├── prompt-builder.js       # §5.2 结构化隔离 Prompt
│   ├── schema.js               # §5.3 输出 JSON 轻量校验
│   ├── anthropic-client.js     # 直连 Anthropic Messages API
│   └── safe-call.js            # §5.3 失败闭环 + 降级模式
├── classifier/             # §3.4 / §5.4 （P1d' 阶段）
├── ingest/                 # §5.5 归属解析（P1d' 阶段）
├── storage/                # §6 / §10 （P1a-P1c 阶段）
├── api/                    # §10.3 路由（P1c 之后）
└── __tests__/              # Node 内置 test runner 冒烟测试
```

## 当前进度（P-1 M1 完成）

- [x] §5.2 Prompt 结构化隔离 + 注入预检
- [x] §5.3 safe_call_llm + 降级规则模式 + 熔断
- [x] §10.8 失败态落盘字段约束（`error_code` / `raw_output`）
- [ ] M2 飞书 Webhook 签名（下一批）
- [ ] M3 Web XSS + 证据短链（下一批）

## 环境变量

| 变量 | 说明 | 必填 |
|---|---|---|
| `ANTHROPIC_API_KEY` | Claude API Key | 是（降级模式除外） |
| `BUG_AGENT_LLM_MODEL` | 默认 `claude-haiku-4-5-20251001` | 否 |
| `BUG_AGENT_LLM_TIMEOUT_MS` | 单次调用超时，默认 30000 | 否 |
| `BUG_AGENT_DAILY_BUDGET_USD` | 日预算，默认 10 | 否 |

## 测试

```
cd gateway
node --test services/bug-agent/__tests__/
```
