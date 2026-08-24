# projectdev kernel — 无人值守编排内核（可移植）

一个**零业务依赖**的 Node 编排内核：驱动 `claude` CLI，按 **里程碑 + 外部验收** 无人值守地从零把一个项目建出来并自验收。
抽取自 `2026AISdkV4/SdkFactory/orchestrator`（Python）的通用部分，重写为可整目录拷走的 ESM 模块。

## 它做什么
- 读一份 **spec**（项目愿景 + 若干里程碑，每个里程碑有 prompt 与**外部验收检查**）。
- 逐里程碑驱动 `claude` 改真实代码，每轮后跑**真实验收命令**（不信 AI 自报），通过才进下一里程碑。
- 全程护栏：会话/里程碑**成本上限**、**轮数上限**、限流/过载退避、无产出断路器、**死循环检测**、`needs_human` 挂起（非崩溃）。
- 状态原子落盘 `run-state.json`，**可断点续跑**（适合跑数天/数周）。

## 移植到任意 Node 能跑的环境
1. 把整个 `kernel/` 目录拷到你的项目（仅依赖 Node 内置模块 + 本机 `claude` CLI）。
2. 写一份 `spec.json`（参考 `example-spec.json`），**只填 vision + 里程碑 prompt + 验收检查** —— 不用改内核。
3. 跑：
   ```bash
   node kernel/cli.js --spec spec.json --state-dir runtime --print-events
   ```
   - 优雅停止：创建 `runtime/STOP` 文件。
   - 从头跑：删除 `runtime/run-state.json`。
   - 退出码：0=全部完成，3=需要人工(needs_human)，99=暂停/停止。

## 验收检查类型（spec.milestones[].acceptance）
| type | 字段 | 通过条件 |
|------|------|---------|
| `file_exists` | `path` | 文件/目录存在 |
| `cmd` | `cmd`, `timeoutSec?`, `expectRc?` | 命令退出码 == expectRc(默认0) |
| `grep_count` | `pattern`, `path`, `min?`, `max?` | 正则命中次数落在 [min,max] |
| `json_schema` | `path`, `schema` | 目标 JSON 满足 schema(required/type/properties/items) |

## 作为库嵌入（本仓 gateway 即如此用）
```js
import { runOrchestrator, validateSpec } from "./kernel/index.js";

const errs = validateSpec(spec);
await runOrchestrator({
  spec, stateDir,
  signal,                         // AbortSignal：硬停
  hooks: {
    onEvent: (evt) => { /* 推 WS / 写 DB / 打日志 */ },
    isStopRequested: () => stopFlag,
    isPauseRequested: () => pauseFlag,
    waitApproval: (id) => approvalPromise,   // gating=per_milestone 时等人审批
  },
});
```

## 事件（hooks.onEvent / --print-events）
`run_start` `milestone_start` `turn` `stream`(thinking/text/tool_use/usage/log) `cost` `acceptance` `milestone_done` `await_approval` `needs_human` `run_done` `run_exit`。

## 不在内核里的（=你的 spec 负责）
具体业务 prompt、各里程碑的验收命令/路径/schema、写白名单。内核只提供「可靠地驱动 AI + 验收 + 护栏 + 续跑」。
