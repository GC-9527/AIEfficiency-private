# 项目开发（无人值守编排）— 设计 v1

> 目标：把 `2026AISdkV4\SdkFactory\orchestrator`（Python）里**通用、无业务依赖**的编排内核
> （claude_runner + state_manager + 精简 task/主循环）抽成一个**独立 Node 可移植骨架**放进本项目；
> 并参照 devbench「故事点开发」网页，新增「项目开发」Tab：点进去能**无人值守连续跑数天/数周，从零自建一个大型项目并自验收交付**。
> 移植到别的项目时，**只需填一份 spec（里程碑定义 + prompt + 验收检查）**，不改内核。

---

## 1. 为什么选「里程碑/spec 驱动」而不是固定 phase 链

参考工程有两套编排：
- `main.py`：固定 14 段 phase 链（scan→ast→…→publish），**强绑 Android SDK 工厂业务**，每段都有硬编码 `_seed_*()` 任务生成与 `_validate_phase_artifacts()` 校验 —— 不通用。
- `autorunv2.py`：**spec/里程碑驱动**，每个里程碑带 **外部验收检查**（cmd / file_exists / grep_count / json_schema），不信 Claude 自报、跑外部命令验证 —— **几乎零业务耦合**，正好是「从零建任意大型项目」的形态。

所以内核 v1 以 **autorunv2 的里程碑模型为骨架**，把它做成业务无关的可移植内核。

---

## 2. 内核结构（`gateway/services/projectdev/kernel/`，零 gateway 依赖、可整目录拷走）

```
kernel/
  state-manager.js   状态原子持久化（run-state.json，tmp+rename），可跨重启续跑
  claude-runner.js   驱动 claude CLI（stream-json，cost/turn/写操作/限流/过载追踪），自包含
  acceptance.js      外部验收检查器（cmd / file_exists / grep_count / json_schema）
  orchestrator.js    里程碑主循环（无人值守、闸门、退避、循环检测、needs_human 升级）
  index.js           导出 + createOrchestrator() 工厂
  cli.js             独立 CLI 入口：node cli.js --spec spec.json --state-dir runtime（等价 autoRun.bat）
  example-spec.json  样例 spec（演示怎么填）
  README.md          移植说明：拷目录 + 填 spec
```

**移植 = 拷 `kernel/` + 写一份 `spec.json`。** 内核不含任何业务；业务全在 spec 的 prompt 与 acceptance 里。

### 2.1 Spec 格式（用户要填的全部内容）

```jsonc
{
  "specId": "my-shop",                 // 唯一标识
  "vision": "用 Node+React 做一个完整电商：商品/购物车/下单/支付/后台……（作为每轮上下文前言）",
  "projectDir": "D:/work/my-shop",     // 目标工程目录（构建落点；可为空新目录，从零建）
  "engine": "claude",                  // 驱动引擎
  "sessionCostCapUsd": 300,            // 整轮会话成本硬上限（美元）
  "gating": "none",                    // none=全自动连续；per_milestone=每个里程碑完成后停下等人点「继续」
  "allowedWrites": [],                 // 可选写白名单（相对 projectDir）；空=不限制
  "cooldownSeconds": 3,                // 每轮间冷却
  "milestones": [
    {
      "id": "M1",
      "title": "项目脚手架与可运行骨架",
      "prompt": "在当前目录创建 …… 的工程骨架，要求 ……",
      "kind": "claude",                // claude=AI 跑；script=跑脚本（不烧 token）
      "script": "",                    // kind=script 时的命令
      "maxTurns": 60,                  // 单里程碑最多 AI 轮数
      "maxCostUsd": 40,                // 单里程碑成本上限
      "acceptance": [                  // 外部验收（全过才算完成；不信 AI 自报）
        { "type": "file_exists", "path": "package.json" },
        { "type": "cmd",         "cmd": "npm install && npm run build", "timeoutSec": 900 },
        { "type": "cmd",         "cmd": "npm test", "timeoutSec": 600 },
        { "type": "grep_count",  "pattern": "describe\\(", "path": "tests", "min": 3 },
        { "type": "json_schema", "path": "openapi.json", "schema": "schemas/openapi.json" }
      ]
    }
  ]
}
```

### 2.2 run-state.json（内核持久化，可断点续跑）

```jsonc
{
  "specId", "status",            // running|paused|completed|failed|needs_human
  "startedAt", "updatedAt",
  "sessionCostUsd",
  "currentMilestone",            // 当前里程碑 id
  "milestones": {
    "M1": { "status", "attempts", "costUsd", "turns", "lastFailure", "lastDiffHash", "startedAt", "finishedAt" }
  },
  "needsHuman": { "reason", "options", "raisedAt" } | null,
  "unproductiveStreak"
}
```

### 2.3 主循环（orchestrator.js，无人值守要点）

```
载入/新建 state
for 每个未完成 milestone:
  stop/pause? → 落盘后退出（可续跑）
  验收已全过? → 标记 completed（早退优化，省钱）
  while 未达上限:
     prompt = vision + 里程碑 prompt + 上轮失败反馈
     kind=claude → claude-runner 跑一轮；kind=script → 跑脚本
     累计 cost/turns；onEvent 推流（thinking/text/tool/usage/log）→ WS+DB
     限流(rate_limited) → 睡到重置（可中断）→ 重试本轮
     临时过载(529) → 退避 → 重试本轮
     cost/turns 超本里程碑上限 → needs_human 升级，跳出
     跑外部验收：全过 → completed，跳出
                 失败且与上轮"同样的失败/同样的 diff" → needs_human（防死循环）
                 否则记录 lastFailure，继续下一轮
  gating=per_milestone 且完成 → 等人审批「继续」
全部完成 → status=completed（自验收交付）
```

**无人值守保障**：成本硬上限、每里程碑 turn/cost 上限、无产出断路器、限流/过载退避、重复失败检测、原子状态可断点续跑、needs_human 不是崩溃而是"挂起等人"。

---

## 3. Web 集成（「项目开发」页）

参照 devbench：新增独立侧栏页 `/project-dev`（**仅管理员**，因为烧钱且强力）。

- **后端** `gateway/routes/projectdev.js` + `gateway/services/projectdev/runner.js`：
  - runner 在网关进程内驱动内核（`createOrchestrator`），把 `onEvent` 转成 **WS 广播** + 写 SQLite；提供 start/pause/stop/resume/approve 控制。
  - 表：`projectdev_projects`（项目+spec）、`projectdev_runs`（运行+里程碑状态+成本）、`projectdev_events`（事件流/日志，分页拉取）。
- **WS channel**：`projectdev_event`（统一前缀），载荷 `{ projectId, runId, kind, ... }`，kind ∈ milestone_start/turn/stream/acceptance/cost/needs_human/done。
- **前端** `web-dashboard/src/pages/projectdev/`：
  - 左：项目列表 + 新建。
  - 中：**里程碑泳道**（每个里程碑：状态/进度/成本/turns/最后失败摘要 + 验收勾叉）＋ **当前 AI 实时流**（thinking/text/tool）＋ 累计成本/token。
  - 右：spec 编辑（vision / 目标目录 / 引擎 / 成本上限 / 闸门 / 里程碑增删改 + 每里程碑验收检查编辑器）。
  - 顶：开始 / 暂停 / 停止 / 继续(续跑) / 审批(gating)；needs_human 醒目横幅（带 options，让人选/补充后继续）。

---

## 4. 用户需要输入什么（v1）

| 输入 | 说明 | 必填 |
|------|------|------|
| 项目名 | 标识 | ✅ |
| 目标工程目录 projectDir | 从零建/已存在的工程落点（绝对路径） | ✅ |
| 愿景 vision / PRD | 整体目标，作每轮上下文前言 | ✅ |
| 里程碑列表 | 每个：标题 + prompt + 验收检查 + maxTurns/maxCost + kind | ✅(至少 1) |
| 引擎 | claude（默认） | 默认 |
| 会话成本上限 / 每里程碑上限 | 预算护栏 | 默认值 |
| 闸门 gating | none 全自动 / per_milestone 每段审批 | 默认 none |
| 写白名单 allowedWrites | 限制 AI 只能改哪些目录（可选安全护栏） | 选填 |

> 设计取向：**先给最小可用闭环**（创建项目→填 spec→开跑→实时看里程碑/流式/成本→自验收→完成/挂起）。
> 你跑起来后我们再迭代：spec 可视化编辑器、里程碑依赖 DAG、断点续跑 UI、多项目并行、成本仪表盘、把 vision 一键 AI 拆成里程碑草稿等。
