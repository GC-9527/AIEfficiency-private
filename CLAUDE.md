# AIEfficiency - AAOS 三方应用集成 AI 提效工具

## 最高优先级规则 / TOP PRIORITY RULES

> **本节规则优先级高于本文档其他所有内容，违反视为严重错误。**
> 这些规则不仅适用于 Claude Code CLI，也同时通过 `gateway/services/context-manager.js` 注入到所有引擎（Gemini/Codex/Qwen/Kimi/DeepSeek/OpenAI）。

### 0. 故事点任务必须交代材料读取与执行结果

每个故事点/devbench 任务，无论由 Claude、Codex、Gemini 还是 API 引擎执行，最终回复或阶段性状态必须明确说明：

1. 当前要解决的问题是什么，以及该判断来自用户消息、TB 评论、附件、日志、代码还是 git 提交。
2. 实际读取了哪些文件、日志、附件、视频、图片、截图或报告；只允许列出真正打开/解压/查看/解析过的材料。
3. 用户或 TB 提供了哪些材料但没有读取；必须逐项说明原因，例如未下载、无法解析、文件过大、格式不支持、路径不存在、无直接相关性或本轮未需要。
4. 自己做了哪些动作、运行了哪些关键命令或检查，产出了什么文件/报告/构建产物。
5. 修改了哪些代码或配置，改动行为和影响范围是什么，残余风险是什么。
6. 建议用户或测试同事重点验证哪些场景。

严禁笼统写“已查看附件/日志/相关文件”。证据引用优先使用文件名或仓库相对路径；对外报告/TB 评论不得泄露本地绝对路径。

### 1. 修改文件前必须先读取当前磁盘状态

任何对文件的编辑操作（`Edit` / `Write`）之前，**必须**先用 `Read` 工具读取该文件的当前完整内容，**严禁**依赖对话缓存、上下文历史记忆或过往任务结果中的文件快照。

**原因**：曾经发生过基于缓存覆盖用户已手动修改内容的事故，导致用户不得不重新手动改回，造成工作损失与信任损害。

### 2. 适用范围

适用于 AI 提效工具仓库内**所有**涉及文件修改的场景，包括但不限于：

- `CLAUDE.md`
- `skills/*.md`
- `configs/*.json`
- `gateway/**`（`routes/`、`services/`、`db/`、`server.js`、`package.json` 等）
- `web-dashboard/**`（`src/pages/`、`src/components/`、`src/services/` 等）
- `desktop/**`（`main.js`、`preload.js`、`mode-select.html` 等）
- `cloud/**`、`mcp-servers/**`、`templates/**`、`docs/**`
- 启动/停止脚本（`start.*`、`stop.*`）

**操作流程**：
1. `Edit` 前：先 `Read` 一次当前磁盘状态，对比记忆中的版本差异，确认无用户手动改动后再编辑。
2. `Write` 覆盖前：必须确认用户未在对话间隙手动修改该文件；若有改动，先合并用户变更再写入。
3. 对比差异后若发现冲突，**停止操作并向用户确认**，禁止自行决定取舍。

### 3. 报告中严禁出现本地路径

输出给用户或发布到外部系统（TB 评论、报告、日志等）的内容中，不得包含本地文件路径（如 `C:\xxx`、`/home/xxx`），只引用文件名。

### 4. AI 临时文件/脚本统一放 docs/tempFiles，不入 git

AI（Claude / 各引擎）在任何工程里**临时生成的文件或脚本**（中间产物、一次性脚本、调试输出、临时截图/视频/txt 等），一律放到**该工程所在目录的 `docs/tempFiles/`** 下，与用户源码/文档隔离；该目录**不加入 git、不提交**（新工程由 `ensureTempFilesIsolation` 自动写 `.gitignore`，手动操作也要保证此规则在位）。

- **与故事点路径冲突时**：故事点（devbench）产物仍按其自身路径约定（`docs/story/<slug>/{ask,archives,reports}/`），不强搬到 `docs/tempFiles/`；但故事点内的临时文件——验收**日志/截屏/录像/trace/埋点结果**（`reports/`、`archives/`）——**同样不入 git、不提交**。
- **唯一例外**：故事点**对话存档** `docs/story/<slug>/ask/` **仍纳入 git 提交**（要保留问答记录）。即"临时日志/截屏不入库，对话存档除外"。

### 5. Git 安全检查与跨设备路径规则

任何 AI 在本工程内执行 `git pull`、`merge`、`rebase`、`commit`、`checkout`、`restore`、`reset`、`stash` 前，必须先做 Git 安全检查，避免隐藏索引标记、行尾符变化、临时产物或本地配置污染提交。

- **路径可移植**：不要把某台设备的绝对路径写入规则、脚本、报告正文或提交说明。先用 `git rev-parse --show-toplevel` 确认当前仓库根目录，后续规则和命令优先使用仓库相对路径。
- **提交信息语言**：Git 提交信息的描述性内容必须使用中文，包括标题中冒号后的摘要和提交正文。允许保留 `feat(scope):`、`fix(scope):` 等 Conventional Commits 英文类型/范围前缀；仅当用户明确要求其他语言时例外。
- **提交/拉取前检查**：执行 `git status -sb`、`git diff --stat`、`git diff --cached --stat`，并检查隐藏索引标记。PowerShell 下使用 `git ls-files -v | findstr /R "^[Ssh]"`。
- **发现 `S`/`h` 标记时**：先列出文件并说明影响；需要处理时用 `git update-index --no-skip-worktree -- <file>` 或 `git update-index --no-assume-unchanged -- <file>` 解除后再看真实 diff。除非用户明确要求，禁止重新设置 `skip-worktree` 或 `assume-unchanged`。
- **高风险文件**：`start.ps1`、`stop.*`、`web-dashboard/vite.config.js`、`gateway/config.json`、本地运行配置和账号配置，提交前必须确认属于本次需求。
- **禁止默认全量添加**：不要默认 `git add .`；只暂存本次需求相关文件，提交前必须看 `git diff --cached --stat` 和 `git diff --cached`。
- **不得提交**：密钥、Token、账号信息、本地私有配置、构建产物、缓存、日志、截图、视频、生成报告、临时脚本、无关文档和 CRLF/LF 批量污染。

### 5a. 禁止的 Git 命令（除非用户明确授权）

以下命令**禁止**在未经用户明确确认的情况下执行：

- `git reset --hard`
- `git clean -fd` / `git clean -fdx`
- `git push --force` / `git push --force-with-lease`
- `git update-index --skip-worktree <file>`
- `git update-index --assume-unchanged <file>`

若确实需要，必须先解释原因、风险、影响文件，等待用户确认。

### 5b. pull/rebase 报错恢复流程（禁止直接 reset）

当 `git pull` 或 `git rebase` 报错 `Your local changes will be overwritten by merge.` 时，必须按以下顺序排查，**禁止**直接 `git reset --hard`：

1. `git status -sb`
2. `git diff --stat` → `git diff`
3. `git ls-files -v | findstr /R "^[Ssh]"`
4. `git config --get core.autocrlf`
5. `git config --get core.eol`

找到 skip-worktree 文件后的恢复流程：

```powershell
git update-index --no-skip-worktree -- <file>
git update-index --no-assume-unchanged -- <file>
git status -sb
git diff -- <file>          # 确认无真实业务改动
git restore --source=HEAD --worktree -- <file>
git pull --ff-only
```

### 5c. 本工程 skip-worktree 事故历史

**曾发生事故**：`start.ps1` 和 `web-dashboard/vite.config.js` 曾被设置 `skip-worktree`，导致 `git pull` 报 `Your local changes will be overwritten`，但 `git status` / `git diff` 看起来干净。根因是 Git 忽略隐藏标记文件的工作区变化，但远程需要更新这些文件时冲突。CRLF/LF 行尾符差异会放大此问题。

**预防**：每次 Git 操作前额外检查这两个高风险文件：

```powershell
git ls-files -v -- start.ps1 web-dashboard/vite.config.js
```

如果出现 `S` 或 `h` 标记，先解除再继续：

```powershell
git update-index --no-skip-worktree -- start.ps1 web-dashboard/vite.config.js
git update-index --no-assume-unchanged -- start.ps1 web-dashboard/vite.config.js
```

### 5d. 推荐拉取方式

```bash
git fetch origin
git pull --ff-only
```

仅在用户明确要求 rebase 或本地有提交需重排时使用 `git pull --rebase`。

---

## 项目概述

基于 OpenClaw 风格的 Skill 驱动智能编排架构，用于 AAOS（Android Automotive OS）三方应用集成工作。支持多引擎（CLI + API）、AI 自动任务规划、修改类任务自动审查、车机设备发现管理、TB 任务自动分析、Bug Agent 智能分诊。

## 工作环境
- **OS**: Windows 11 / macOS（跨平台）
- **CLI 引擎**: Claude Code（订阅制）、Gemini CLI（免费）、OpenAI Codex（CLI）
- **API 引擎**: Qwen 通义千问、Kimi 月之暗面、DeepSeek、OpenAI GPT（OpenAI 兼容格式）
- **消息平台**: 钉钉（Teambition + 机器人推送）、飞书（长连接 + 机器人）
- **Node.js**: v20+ LTS（better-sqlite3@12 强制要求，桌面版内置 v22.20.0 portable）

## 三种使用方式

### 1. Web 模式（开发/团队共享）
- 云端面板（Docker `192.168.10.156:8080`）+ 各用户本机网关（`localhost:3001`）
- Skills 共享、CLI 引擎走本机
- 安装命令：`irm http://192.168.10.156:8080/setup.ps1 | iex`

### 2. 桌面版独立模式
- 内置 Electron + portable Node + 预装依赖
- 完全离线可用，无外部依赖
- `desktop/dist/AI提效工具 Setup x.x.x.exe`（约 119MB）

### 3. 桌面版团队模式
- 桌面 EXE 启动本地网关 + 加载云端面板
- Skills 从云端共享，CLI 引擎走本机
- 适合团队协作，用户无需安装 Node.js

## 架构

```
┌─ 云端 Docker (192.168.10.156:8080) ────────────────┐
│  ├─ Web UI（前端面板，团队共享）                      │
│  ├─ /api/skills        Skills 列表（共享）            │
│  ├─ /api/shared-config TB 公用 appId/secret/orgId    │
│  ├─ /api/gateway-version + gateway-bundle.zip 网关分发│
│  └─ /api/desktop-version + desktop-setup.exe 桌面分发 │
└───────────────────────────────────────────────────┘
              │
              ▼
┌─ 用户本机 ──────────────────────────────────────┐
│ 桌面端 Electron (可选)                            │
│  ├─ portable Node v22.20.0（内置）                │
│  └─ resources/gateway/ → 复制到 AppData 运行       │
│                                                  │
│ 本地网关 (localhost:3001)                         │
│  ├─ Express + WebSocket + better-sqlite3         │
│  ├─ Bug Agent 模块 (api/bug/*)                   │
│  ├─ TB 任务监控 + 评论附件下载（Cookie 模式）       │
│  ├─ 飞书长连接（聊天双向通道）                      │
│  ├─ 定时任务调度（cron + 输出适配器）              │
│  ├─ AI 引擎（CLI + API + 工作流执行器）            │
│  ├─ 设备发现（TCP 5555 探测 + ADB）                │
│  └─ SQLite 数据库（任务/日志/Token/对话/TB 记录）   │
└──────────────────────────────────────────────────┘
```

### 核心流程

```
用户消息
  ├─ /skill-name 命令 → 快速路径（直接执行指定 Skill）
  └─ 自然语言 → 判断是否复合任务
     ├─ 简单任务 → dispatcher regex 分类 → 直接执行（零额外开销）
     └─ 复合任务 → AI 规划器 (planTask)
        ├─ 读取平台能力文档（所有 Skill 摘要）
        ├─ AI 分析 → 分配 Skill + 引擎 + 审查标记
        ├─ 单任务 → 直接执行
        └─ 多任务 → DAG 调度并行/串行执行 → 汇总
```

### 引擎分派优先级

1. `explicitEngine`（AI 规划器或手动指定）
2. `config.defaultEngine`（用户在设置中选择的默认引擎）
3. `ENGINE_PREFERENCE`（任务类型推荐，仅当对应引擎可用时）
4. 兜底（遍历所有引擎，找第一个可用的）

### 内置机制（用户不可见）

- **AI 规划器**：复合任务自动拆分为子任务，分配 Skill 和引擎
- **监察者审查**：涉及代码/文件修改的任务自动审查输出质量，不合格重试
- **Persona + 系统级规则**：全局注入到每次 AI 调用（最高优先级规则不可覆盖）
- **上下文管理**：智能截断 + 长对话自动摘要压缩
- **能力文档**：Skills 变更时自动生成平台能力摘要

## Skills（32 个）

### 通用工具
| Skill | 说明 | 涉及修改 |
|-------|------|---------|
| `/coding-agent` | 编码任务委托 | 是 |
| `/skill-creator` | 通过对话创建 Skill | 否 |
| `/healthcheck` | 系统健康巡检 | 否 |
| `/github` | GitHub 仓库操作 | 否 |
| `/web-search` | Web 搜索与信息抓取 | 否 |
| `/summarize` | 内容/日志摘要 | 否 |
| `/os-helper` | Windows 系统操作 | 否 |
| `/mac-os-helper` | macOS 系统操作 | 否 |

### Bug 分析（Bug Agent 配套）
| Skill | 说明 |
|-------|------|
| `/bug-sop` | Bug 处理标准流程 |
| `/bug-triage` | Bug 分诊与归类 |
| `/bug-analyze` | Bug 详细分析 |
| `/bug-evidence` | 证据收集 |
| `/bug-review` | Bug 审查 |
| `/bug-verify` | 问题验证 |
| `/bug-report` | Bug 报告生成 |

### AAOS 设备调试
| Skill | 说明 | 涉及修改 |
|-------|------|---------|
| `/adb-helper` | ADB 操作封装 | 否 |
| `/smali-analyze` | SMALI 分析与修改 | 是 |
| `/apk-repack` | APK 重打包 | 是 |
| `/resolution-adapt` | 分辨率/DPI 适配 | 是 |
| `/decrypt-elog` | ELOG 加密日志解密 | 否 |
| `/media-debug` | MediaSession 媒体诊断 | 否 |
| `/analyze-voice-see-logs` | VoiceSee 日志诊断 | 否 |
| `/analyze-safe-drive-logs` | SafeDrive 走行规制日志诊断 | 否 |
| `/video-analyze` | 视频日志分析 | 否 |

### 协作 / 报告
| Skill | 说明 |
|-------|------|
| `/task-workflow` | 钉钉任务工作流 |
| `/work-report` | 工作报告生成（周报/月报/季报/年报、工作总结）。**分档**：简短版（默认/周报·季度概要）= Markdown 概要 + 数据摘要，**维持不变**；**详细版**（用户要"详细总结/详细报告"时）= 把数据源组织成图文影音富文本 → 调 `/acceptance-report` 生成自包含富媒体 HTML → 转 PDF → **生成后把该 PDF 本地磁盘绝对路径告诉用户**（报告正文/对外回评仍只引用文件名，仅"告知本人 PDF 落点"这一句可给本地路径） |
| `/acceptance-report` | 故事点自我验收报告：跑自动化测试(Playwright/instrumented)+app-mock，收集截屏/录像/trace/日志/埋点DB证据，按 `rule_2.txt` 生成富文本图文影音 HTML 报告→PDF（devbench 第三步报告阶段用） |
| `/workflow-commander` | 工作流统领者（内部） |
| `/workflow-inspector` | 工作流监察者（内部） |

### 性能治理
| Skill | 说明 |
|-------|------|
| `/perf-analyze` | 应用市场性能分析：基于启动①②③/内存/CPU/FPS/Crash/ANR 与 Monkey 轮次，输出是否变好/恶化项/根因/优化建议/下一轮建议（与 `/api/performance/analyze` 契约一致） |

Skill CRUD API: `POST/PUT/DELETE /api/skills/:id`

## MCP Servers
- `teambition` — Teambition 开放平台 API 封装
- 配置位于 `.claude/settings.local.json`

## Web 面板（10 个页面）

| 页面 | 路径 | 说明 |
|------|------|------|
| 聊天 | `/chat` | 主交互入口，AI 自动规划+执行，子任务面板，流式输出，审查状态 |
| Skills | `/skills` | Skill 列表 + 平台能力摘要 + 详情查看 |
| Agents | `/agents` | 引擎角色卡片（Claude/Gemini/Codex），工作流编辑器/监控器 |
| 用量 | `/tokens` | Token 用量统计，引擎分布，每日趋势 |
| 日志 | `/logs` | 按任务分组，关键词搜索，级别筛选 |
| 设备 | `/devices` | 车机设备扫描发现/连接/断开，结果存客户端 localStorage |
| **TB 任务** | `/tb-tasks` | TB 任务自动分析、附件下载、评论挂起恢复 |
| **Bug 分析** | `/bug-agent` | Bug Agent 智能分诊与分析 |
| 定时 | `/schedule` | 定时任务（cron + 输出渠道：钉钉/飞书/文件/日志） |
| 设置 | `/settings` | Persona、上下文管理、引擎配置、API 引擎、TB Cookie、飞书、钉钉 |

## 项目结构

```
AIEfficiency/
├── CLAUDE.md                              # 本文件（最高优先级规则 + 项目说明）
├── start.{sh,ps1,bat} / stop.{sh,ps1,bat} # 一键启动/停止
├── gateway-bundle.zip                     # 网关源码包（云端分发用）
│
├── skills/                                # OpenClaw 风格 Skill 文件（30 个）
│   ├── bug-{sop,triage,analyze,evidence,review,verify,report}.md
│   ├── analyze-{safe-drive,voice-see}-logs.md
│   ├── {adb-helper,smali-analyze,apk-repack,resolution-adapt}.md
│   ├── {decrypt-elog,media-debug,video-analyze}.md
│   └── ...
│
├── gateway/                               # 统一网关服务（后端）
│   ├── server.js                          # Express + WS 主服务，bug-agent 路由
│   ├── package.json                       # v2.5.0
│   ├── routes/
│   │   ├── chat.js                        # AI 规划 + 执行 + 审查
│   │   ├── skills.js                      # Skill CRUD + 能力文档
│   │   ├── devices.js                     # 设备发现/连接
│   │   ├── workflows.js                   # 工作流 CRUD + 执行
│   │   ├── config.js                      # 配置读写 + 引擎检测 + self-update
│   │   ├── tasks.js / logs.js             # 任务 / 日志查询
│   │   ├── tb-tasks.js                    # TB 任务分析
│   │   ├── schedule.js                    # 定时任务（含 outputConfig 容错）
│   │   ├── dingtalk.js                    # 钉钉机器人回调
│   │   ├── clipboard.js                   # 剪贴板文件读取
│   │   ├── report.js                      # 工作报告生成
│   │   └── driveeats.js                   # 走行 OTA 数据
│   ├── services/
│   │   ├── agent-runner.js                # CLI + API 引擎执行器
│   │   ├── api-engine.js + api-tools.js   # OpenAI 兼容 API 调用器 + 工具函数
│   │   ├── dispatcher.js                  # 任务分类 + 引擎分配
│   │   ├── task-decomposer.js             # AI 智能规划器（planTask + 汇总）
│   │   ├── capability-doc.js              # 平台能力文档生成
│   │   ├── context-manager.js             # 上下文管理 + 系统级规则注入
│   │   ├── dag-scheduler.js               # DAG 并行/串行调度
│   │   ├── workflow-executor.js           # 工作流执行器（步骤级审查）
│   │   ├── device-discovery.js            # 车机设备发现（TCP 5555 + ADB）
│   │   ├── config.js                      # 运行时配置 + 云端 shared-config 同步
│   │   ├── logger.js                      # 日志 + WebSocket 推送
│   │   ├── feishu.js                      # 飞书长连接（机器人双向通道）
│   │   ├── scheduler.js                   # 定时任务（cron-node）
│   │   ├── output-adapters.js             # 输出渠道（钉钉/飞书/文件/日志）
│   │   ├── teambition.js                  # TB 开放平台 + Cookie API + 搜索
│   │   ├── tb-task-analyzer.js            # TB 任务分析（拉取/下载/AI/挂起）
│   │   ├── tb-task-watcher.js             # TB 任务监控（cron + 挂起恢复）
│   │   ├── tb-cookie-extractor.js         # 一键登录 Cookie + 自动填 operatorId
│   │   ├── platform-context.js            # 平台上下文
│   │   ├── report-generator.js            # 工作报告生成
│   │   └── bug-agent/                     # Bug Agent 子模块
│   │       ├── api/                       # 路由
│   │       ├── classifier/ ingest/        # 分诊 + 入库
│   │       ├── llm/ memory/ ops/          # LLM 调用 + 记忆 + 运维
│   │       ├── scoring/ storage/          # 评分 + 持久化
│   │       └── testing/                   # 测试
│   └── db/sqlite.js                       # SQLite（better-sqlite3@12.x）
│
├── web-dashboard/                         # Web 管理面板（前端）
│   ├── vite.config.js                     # Vite + React，base="./"，HashRouter (file://)
│   └── src/
│       ├── pages/
│       │   ├── Chat.jsx                   # 聊天 + 子任务面板 + Markdown 渲染
│       │   ├── Skills.jsx Agents.jsx      # Skills + 引擎卡片
│       │   ├── Devices.jsx Tokens.jsx Logs.jsx
│       │   ├── TbTasks.jsx                # TB 任务（附件/评论/挂起/打开目录）
│       │   ├── BugAnalysis.jsx            # Bug Agent
│       │   ├── Schedule.jsx               # 定时任务
│       │   └── Settings.jsx               # Persona/引擎/TB Cookie/飞书/钉钉
│       ├── components/
│       │   ├── Markdown.jsx Transcript.jsx
│       │   ├── SubtaskPanel.jsx
│       │   ├── WorkflowEditor.jsx WorkflowMonitor.jsx
│       │   └── workflow/                  # StepNode + NodeConfigPanel + Canvas
│       ├── services/gateway.js            # 网关 URL 管理（Electron/Web 自动识别）
│       └── App.jsx                        # 侧栏 + 路由 + 版本号 + 更新横幅
│
├── desktop/                               # Electron 桌面版（v1.5.1）
│   ├── main.js                            # 主进程：spawn portable Node 跑 gateway
│   ├── preload.js                         # IPC 暴露（更新/版本/模式切换）
│   ├── tray.js                            # 系统托盘
│   ├── splash.html                        # 启动画面
│   ├── mode-select.html                   # 模式选择（独立/团队）
│   ├── icons/                             # 应用图标（AI 字样）
│   ├── node-runtime/                      # 内置 Node v22.20.0 portable
│   ├── gateway-bundled/                   # 预装依赖的 gateway（含 node_modules）
│   ├── publish.sh                         # 发布到云端脚本
│   └── package.json                       # electron-builder NSIS 配置
│
├── cloud/                                 # Docker 云端服务
│   ├── server.js                          # 面板托管 + 安装脚本 + 共享 API
│   ├── shared-config.json                 # 公用 TB appId/secret/orgId
│   ├── gateway-bundle-version.txt         # 网关版本号
│   ├── desktop-version.txt                # 桌面版版本号
│   └── desktop-setup.exe                  # 桌面版安装包
│
├── configs/device-profiles.json           # 车机设备分辨率/DPI 配置表
├── templates/bug-report-template.md       # 报告模板
├── docs/USAGE.md                          # 完整使用文档
└── mcp-servers/dingtalk/                  # Teambition MCP Server
```

## 启动方式

### Web 模式（开发）
```bash
# 一键启动（Windows）
powershell -ExecutionPolicy Bypass -File start.ps1

# 手动启动
cd gateway && npm install && npm start    # → http://localhost:3001
cd web-dashboard && npm install && npm run dev  # → http://localhost:3000
```

### 桌面版安装
```
下载 desktop/dist/AI提效工具 Setup 1.5.1.exe（约 119MB）
双击安装 → 首次启动选模式（独立 / 团队）
内置 Node.js，无需任何依赖
```

### Docker 云端部署
```bash
# 更新前端
cd web-dashboard && npm run build
docker exec ai-efficiency-cloud sh -c "rm -rf /app/dist/*"
docker cp web-dashboard/dist/index.html ai-efficiency-cloud:/app/dist/index.html
docker cp web-dashboard/dist/assets ai-efficiency-cloud:/app/dist/assets
docker commit ai-efficiency-cloud ai-efficiency-cloud:latest

# 更新网关 bundle
powershell -Command "Compress-Archive -Path gateway -DestinationPath gateway-bundle.zip -Force"
docker cp gateway-bundle.zip ai-efficiency-cloud:/app/gateway-bundle.zip
echo "2.5.0" > /tmp/gv.txt
docker cp /tmp/gv.txt ai-efficiency-cloud:/app/gateway-bundle-version.txt

# 更新桌面版
cd desktop && rm -rf dist && npx electron-builder --win
docker cp "dist/AI提效工具 Setup 1.5.1.exe" ai-efficiency-cloud:/app/desktop-setup.exe
echo "1.5.1" > /tmp/dv.txt
docker cp /tmp/dv.txt ai-efficiency-cloud:/app/desktop-version.txt

docker restart ai-efficiency-cloud
```

远端用户一键安装/更新（Web 模式）：
```powershell
irm http://192.168.10.156:8080/setup.ps1 | iex
```

## 后端 API 列表

### 聊天
| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/chat/sessions` | 创建会话（支持置顶 pinned） |
| GET | `/api/chat/sessions` | 会话列表（pinned DESC, updated_at DESC） |
| POST | `/api/chat/sessions/:id/send` | 发送消息（AI 规划 → 执行 → 审查 → transcript 保存） |
| GET | `/api/chat/sessions/:id/messages` | 消息历史（含 thinking/tool_use 轨迹） |
| PUT | `/api/chat/sessions/:id` | 更新（标题、置顶） |
| DELETE | `/api/chat/sessions/:id` | 删除会话 |

### Skills
| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/skills` | Skill 列表 |
| POST/PUT/DELETE | `/api/skills/:id` | Skill CRUD |
| GET | `/api/skills/capabilities` | 平台能力文档 |
| GET | `/api/skills/capabilities/summary` | 能力纯文本摘要 |

### TB 任务
| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/tb-tasks` | 任务记录列表（含 attachments） |
| POST | `/api/tb-tasks/sync` | 触发全量同步扫描 |
| POST | `/api/tb-tasks/analyze` | 分析指定任务（支持 CARB-xxx / 数字 / taskId） |
| POST | `/api/tb-tasks/:id/reanalyze` | 重新分析 |
| POST | `/api/tb-tasks/:id/confirm` | 手动发送评论到 TB |
| POST | `/api/tb-tasks/:id/open-dir` | 打开附件目录 |
| DELETE | `/api/tb-tasks/:id` | 删除（含本地文件） |
| GET | `/api/tb-tasks/:id/report` | 获取分析报告 |
| GET | `/api/tb-tasks/cookie-check` | 验证 TB Cookie |
| POST | `/api/tb-tasks/login` | 一键 Puppeteer 登录提取 Cookie |
| POST | `/api/tb-tasks/login/cancel` | 取消登录 |

### Bug Agent
| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/bug/cases` | Bug 案例列表 |
| POST | `/api/bug/cases` | 创建案例 |
| GET/PUT/DELETE | `/api/bug/cases/:id` | 案例 CRUD |
| POST | `/api/bug/webhook/feishu` | 飞书 webhook（HMAC 签名校验） |
| ... | （其他子路由见 `gateway/services/bug-agent/api/routes.js`） |

### 设备
| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/devices/discover` | 扫描发现（TCP 5555 + ADB） |
| GET | `/api/devices/cached` / `/api/devices/quick` | 缓存的设备列表 |
| POST | `/api/devices/connect` / `/api/devices/disconnect` | 连接/断开设备 |
| GET/POST/DELETE | `/api/devices/subnets` | 扫描网段管理 |

### 工作流
| 方法 | 路径 | 说明 |
|------|------|------|
| GET/POST/PUT/DELETE | `/api/workflows[/:id]` | 工作流 CRUD |
| POST | `/api/workflows/:id/run` | 执行 |
| GET | `/api/workflow-runs` | 运行记录 |

### 配置
| 方法 | 路径 | 说明 |
|------|------|------|
| GET/PUT | `/api/config` | 读取/更新配置 |
| GET | `/api/config/engine-status` | 所有引擎状态 |
| GET | `/api/config/check-engine/:engine` | 检测单个引擎 |
| POST | `/api/config/self-update` | Web 模式网关自更新 |

### 定时任务
| 方法 | 路径 | 说明 |
|------|------|------|
| GET/POST/PUT/DELETE | `/api/schedule[/:id]` | 定时任务 CRUD（outputConfig JSON 容错） |

### 系统
| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/health` | 健康检查（返回 status + version） |
| GET | `/api/status` | 详细状态（stats / agents / tokens / uptime） |
| GET | `/api/tokens` | Token 用量统计 |
| GET | `/api/logs/search` | 日志搜索 |

### 云端独有 API（Docker 8080）
| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/health` | 标记 mode=cloud |
| GET | `/api/shared-config` | 共享配置（TB appId/secret/orgId） |
| GET | `/api/gateway-version` | 网关 bundle 版本 |
| GET | `/download/gateway-bundle.zip` | 网关源码包下载 |
| GET | `/api/desktop-version` | 桌面版版本 |
| GET | `/download/desktop-setup.exe` | 桌面版安装包下载 |
| GET | `/setup.ps1` | 动态生成的 PowerShell 安装脚本 |

## 配置层级（个人 vs 公用）

| 类型 | 字段 | 存储 | 同步 |
|------|------|------|------|
| **公用** | `teambition.appId / appSecret / orgId` | 本地 `gateway/config.json`，启动时从云端 `shared-config.json` 同步 | ✅ 云端 → 本地（仅填充空值） |
| **公用** | Skills | 云端 `/api/skills` | ✅ 团队共享 |
| **个人** | `teambition.userCookie` | 本地 | ❌ 仅本地 |
| **个人** | `teambition.operatorId` | 本地（一键登录自动填） | ❌ 仅本地 |
| **个人** | `tbTaskWatcher.executorId` | 本地（一键登录自动填） | ❌ 仅本地 |
| **个人** | TB 任务分析记录 + 附件 | 本地 SQLite + 文件系统 | ❌ 仅本地 |
| **个人** | Persona、API Keys、其他设置 | 本地 | ❌ 仅本地 |

## 桌面版更新机制

### 双轨更新
- **网关代码（v2.x.x）** → 下载 `gateway-bundle.zip` → 解压覆盖 AppData → 重启
- **桌面版 EXE（v1.x.x）** → 下载 `desktop-setup.exe` → 启动 NSIS 安装器自动覆盖

### 入口
- 侧边栏底部点击版本号 `v2.x.x` → 自动检查并弹横幅
- 菜单栏「应用 → 检查更新」（中文菜单）→ 同等效果
- 横幅区分两种更新：蓝色=网关、紫色=桌面版

### 当前版本
- 网关：**v2.5.0**（含 Bug Agent 模块）
- 桌面版：**v1.5.1**（内置 portable Node v22.20.0 + 预装依赖，无需用户装 Node）

## TB 任务分析关键实现

### 任务 ID 兼容
- 用户输入：`CARB-11080` / `11080` / MongoDB ObjectId
- 真实企业项目 `uniqueIdPrefix=CARB`，`uniqueId=11080` → 拼成 `CARB-11080`
- 测试企业的旧任务标题里包含 `CARB-xxx`，正则提取兜底

### 项目白名单
- `gateway/services/teambition.js` 中 `ALLOWED_PROJECT_IDS = ["65a5f274950780b816cf905e"]`（平台组件）
- 所有数据访问路径都被锁定：`getMyTasks` / `getTaskDetail` / `getTasksInRange`

### 附件下载
- 优先 `work/list`（开放平台 v3 API，需 work:get/work:list 权限）
- 评论内嵌附件（`activity.content.files`）→ Cookie 调 `/api/v2/tasks/{id}/activities` → 拿带 JWT token 的 `awos/download/file` 链接

### 评论控制
- `autoComment=false` 时：分析完成评论、信息不足挂起评论 **均不自动发**
- 附件下载失败时：**永远不发评论**（避免误导）
- 手动发送：通过「发送评论」按钮调 `/api/tb-tasks/:id/confirm`

### 信息不足挂起
- AI 标记 `<!-- NEED_MORE_INFO: ... -->` → 状态变 `suspended`
- 监控器每 15 分钟（工作日 8-20 点）检查挂起任务的新评论
- 检测到提单人补充资料 → 自动恢复分析

## devbench 工程开发工作台（TB 工作流）

`/devbench` 页面把 TB 待办按"故事点"分 tab，在所选应用市场工程目录下与 Claude CLI 多轮对话改码。
代码：`gateway/routes/devbench.js`、`gateway/services/devbench/{index,store,tb-workflow,lessons}.js`、`web-dashboard/src/pages/devbench/`。

### 三步工作流（半自动 / 全自动流程一致，区别仅"是否需人点按钮推进下一步"）
从任务列表创建故事点后，TB 单走固定三步；`tab.workflow.phase` 记录阶段：
1. **甄别**（`claimed`→…）：判断是否本应用市场客户端/工程侧问题，还是环境未配置对/车机等外部因素。
   - 不需处理 → 醒目提示 + 挂起，用户「确认拒绝」后流转 `已拒绝`（`triage_not_bug`）。
   - 需处理 → 流转 `修复中`（`triage_is_bug` → `fixing`）。
2. **修复**（`fixing`）：AI 改码，生成"修复原因/改动文件/影响范围/建议测试范围"；`<!-- FIX_DONE -->` → 进入第三步**自我验收**（**不再直接 `可提测`**）。
3. **自我验收 + 报告**：
   - 验收（`verifying`）：AI **新开验收 Agent**（Task 子代理）按下面【自我验收细则】跑通验收，证据落 `docs/story/<slug>/reports/`。`<!-- VERIFY: PASS|FAIL -->`，PASS→`reporting`，FAIL→回 `fixing`。
   - 报告（`reporting`）：AI 调 **`/acceptance-report` skill**，按 `docs/devbench/step3/rule_2.txt` 口径，把用例结果 + 截屏/录像/日志/埋点查询证据整理成**自包含富媒体 HTML 报告**写到 `reports/acceptance-report.html`；**系统自动把它渲染成 PDF（`report-pdf.js#htmlToPdf`，puppeteer 通用分页 `page.pdf()`，非 deck 幻灯片那套）并作为 TB 唯一附件上传**（无 HTML 则 md→PDF 兜底）。`<!-- REPORT_DONE -->` → TB 评论一条**简短报告**并**以该 PDF 为附件**，流转 `可提测`。（实现：`tb-workflow.js` report_done 分支 `buildReportPdf`）

#### 自我验收细则（第三步验收阶段，`buildVerifyRule` 注入）
- **测试用例来源**（按改动影响范围三选一或叠加）：① 根据**当前故事点**新编用例；② 复用该故事点/同模块**既往用例**；③ 跑**全量回归**用例。
- **自动化脚本 + App-mock**：编写自动化测试脚本（UI 优先 Playwright，原生走 instrumented/UIAutomator，按工程类型）；用 **app-mock 模拟设备 / 数据 / 环境**（无真机、或需构造特定数据/环境/账号态时）。
- **打包验证**：**分别打 debug 与 release 包**，在 TB 单**绑定设备**上复现并执行用例（设备闸门见下）。
- **证据强制**：每条用例必须有 **截屏 + 录像**（及日志/trace），落 `docs/story/<slug>/reports/{screenshots,videos,traces,logs}/`。无截录的用例不算通过。
  - **录屏由系统确定性调度**（已接通，不依赖 LLM 记得）：验收开始时 `verify-runner.js#prepareVerifyAssets` 铺好 reports 子目录并把录屏包装器 `verify-record.mjs` 复制为 `reports/_devbench-record.mjs`；`buildVerifyRule` 注入用法，要求 Agent 把每条用例命令用它包起来跑：`node <reports>/_devbench-record.mjs --serial <S> --label tcNN --dir <reports> -- <测试命令>` —— 它全程 `adb screenrecord` 录屏（分段≤170s，自动续段）+ 末帧 `screencap` 截图 + 日志落盘，退出码=命令退出码，末行打印 `[devbench-record] {...}`。仅依赖本机 adb + Node，无需 npm 依赖。
- **埋点验收（硬性）**：若改动涉及**埋点**，必须到**对应环境的数据库**中**查询到该埋点数据**才判该用例通过；查不到 = FAIL。系统提供可配置查询 CLI `run-buried-point.mjs`（连接配 `gateway/buried-point-db.json`，支持 **mysql**(本机 Python+pymysql，SQL 经 stdin)/sqlite/shell/http；该文件已 gitignore，凭据不进 git；示例见 `buried-point-db.example.json`）：`node <gateway>/services/devbench/run-buried-point.mjs --env <环境> --query "<SQL>" --out reports/buried-point/tcNN.json`（查到 exit 0 并存证据，否则 exit 1）。未配置环境时该用例须人工确认或标 NEED_MORE_INFO，不得仅凭客户端日志判过。实现：`buried-point.js`（loadBpConfig/listEnvs/describeEnvs/queryEnv）+ `bp-mysql.py`。**已就位环境 `appmarket`**：应用市场埋点库（MySQL，表 `t_app_log`，按 `event_id` 区分事件，过滤列 `device_key`/`create_time`/`page_source`；连接信息源自 `features/TrackFeature/config/db.json`，该处另有更完善的 pymysql 工具 `tools/trackdb.py` + 事件目录 `catalog/events.json` 可做字段级校验）。`buildVerifyRule` 会注入已配置环境名 + 其 note 供 Agent 写对 SQL。
- 全部用例 PASS（含埋点已在 DB 命中）才输出 `<!-- VERIFY: PASS -->`；任一 FAIL → `<!-- VERIFY: FAIL -->` 回 `fixing`。
- **设备闸门（半自动暂停点）**：第三步必须有绑定设备才能验收。`FIX_DONE` 时若**未绑定设备** → 停在 `verify_blocked` 并醒目提示；用户连上设备后点「执行验收」继续（即便全自动也在此暂停）。
- **半自动（默认）**：每步完成后停下，由用户点 `WorkflowStatusBar` 上的按钮（开始 AI 甄别 / 标记修复完成 / 开始自我验收 / 生成报告并提交）推进；甄别也可由**首条消息**触发。
- **全自动（`autoMode==='full'`，预留）**：流程相同，`applyWorkflow` 后自动 `kickVerify`/`kickReport` 推进下一步（设备闸门仍生效）。切换有二次确认。
- **「工程就绪」= 本地已配置工程或远程分支已克隆到本地存在；`kickTriage` 只读不拉，绝不自动 git clone/pull。**
- **拉取远程最新（第一步前，显式确认）**：点「开始 AI 甄别」先弹 `PullLatestModal` 问是否拉取远程最新代码。确认后逐工程 `stash -u → merge 远程跟踪分支 → stash pop`（保留本地改动）。冲突（合并时 / 还原时）→ 列出冲突文件，可「让 AI 解决冲突」(`/git/resolve-conflicts` 跑一轮 Claude 仅解决+`git add`、**不提交**、交人工审核) 或在 IDE 手动解决；可「重试拉取」或「仍继续甄别」。仍是"用户确认才拉"，不违反"不自动拉"。后端 `pullLatestRepo`/`/git/pull-latest`。
- 顶部常驻 `WorkflowStatusBar`：显示阶段（待甄别/甄别中/修复中/自我验收/待连设备验收/生成报告/已提测/已拒绝）+ AI 正在执行的动作 + 档位切换 + 各步手动入口。
- 路由：`/workflow/{start-dev,triage,mark-fixed,verify,report,reject,auto-mode}`；kick 函数 `kickTriage`(routes) / `kickVerify`,`kickReport`(`services/devbench/index.js`)。

### 甄别上下文（每轮注入，`buildTurnPrompt`）
- TB 单完整字段：标题/描述/**回复评论（最近 30 条）**/附件清单（`fetchAndSaveTbContext` → `tab.tbContext`）+ 备注图文（`fetchAndSaveTbNote`）。
- 工程 + **当前分支** + flavor + 设备 + 已附材料。
- **历史经验库**（同 TB 项目既往单的"原因→预防"，见下）。

### 附件自动下载（阈值闸门）
- 阈值：`数量>10` 或 `单个>20MB` 或 `合计>50MB`（`ATT_MAX_*`）。
- 未超阈值 → 甄别前**静默自动下载**到 `docs/story/<slug>/archives/` 供 Claude `Read`；
- 超阈值 → 不自动下，发 WS `devbench_attach_progress`（`need_confirm`）→ 前端 `AttachmentConfirmModal` 勾选 + 逐文件进度（`download-batch` 串行下载推 `file`/`end`）。

### AI 工作流标记（HTML 注释，前端不可见，`parseWorkflowMarkers` 解析后剥离）
- `<!-- TRIAGE: IS_BUG | NOT_A_BUG -->`：甄别结论。IS_BUG→`修复中`；NOT_A_BUG→挂起待用户「确认拒绝」。
- `<!-- FIX_DONE -->`：代码修复完成→进入第三步**自我验收**（已绑定设备则验收，否则 `verify_blocked` 暂停）。**不再直接 `可提测`**。
- `<!-- VERIFY: PASS | FAIL -->`：自我验收结论。须满足【自我验收细则】（用例有截屏录像、埋点已在对应环境 DB 命中）方可 PASS→`reporting`；FAIL→回 `fixing`。
- `<!-- REPORT_DONE -->`：报告完成（已用 `/acceptance-report` 按 `rule_2.txt` 生成富媒体报告并转 PDF）→ TB 评论简短报告 + **附该 PDF** + 流转 `可提测`。
- `<!-- LESSON 原因:/预防:/关键词: -->`：经验沉淀块（随 fix_done / NOT_A_BUG 产出）。
- 注入对应步骤规则：`buildTriageRule`/`buildFixDoneRule`/`buildVerifyRule`/`buildReportRule`（`buildTurnPrompt` 按 `opts.workflowKind` 选注）。

### 学习数据存储（lessons / configMemory / 关键词映射）
这些"学习"数据（`byProject.<TB项目>` 下的 lessons/configMemory/keywordMappings/statusMap/vehicleMap）**存 SQLite**（`devbench_userdata` 表、shared key `__devbench_shared__`），**不再写 `configs/market-projects.json`** —— 否则每加一条都整文件重写 + 团队 gossip 全量同步 + git 噪音。`market-projects.json` 仅留工程列表/projectDefs 等配置，基本不再变动。首次启动自动把旧 JSON 里的 `byProject` 迁到 SQLite 并清理 JSON（一次性）。团队共享仍走 gossip（`getSharedBundle`/`applySharedBundle`，现从 SQLite 读写），**不再随 git 分发**。检索仍是启发式（非 RAG/LLM）。
- **局域网同步**：学习数据走【版本闸门的 shared-bundle gossip】（`reconcileShared` 每 8s 比 `_sharedVersion`）。`listUserDataSince`/`maxUserDataUpdated` 已**排除 `__` 开头的内部键**（`__devbench_shared__`/`__system__`），避免学习数据又走"逐行 updated_at 新者胜"的用户数据 gossip 造成两套口径互相回退。
- **同一工程的多份备份（不同路径/分支/改动）**：配置记忆里存主工程的 **git 远程地址**（`primaryRemote`）；新建故事点建议时，若记忆里那份主工程本机不在，按 **git remote 相同** 找"同一工程的另一份当前可用备份"（`store.findAvailableSameProject` / `gitRemoteUrl`）落地，套用学到的分支/flavor（前端标「同工程备份」）。匹配靠信号(车型/关键词)与 remote，与目录无关。

### 配置记忆 + 推理建议（新建故事点自动推荐工程配置）
成功收尾（FIX_DONE）时，把〔TB 信号：标题/项目/迭代/标签/识别车型应用〕→〔工程配置：主工程/分支/flavor车型/关联工程(均按可移植的 projectId/分支名)〕沉淀到**配置记忆库**（`store.{get,add,delete}ConfigMemory`，按 TB 项目隔离、团队共享，签名=主工程+flavor+车型，重复则累加权重）。
新建故事点（任务列表「执行开发」）时，`/suggest-config`（`config-memory.js` 的 `suggestConfigSnapshot`，**启发式打分**：同车型+5 / 标签重叠 / 标题关键词重叠 / 同迭代 / 高频加权）匹配最可能配置 → 前端 `ConfigSuggestModal` 展示（主工程+分支彩标+flavor+关联工程）→ 用户点「应用配置」即 `applyConfig` 套用。代码：`gateway/services/devbench/config-memory.js`、`store.js`、`routes/devbench.js`、前端 `ConfigSuggestModal.jsx`。

### 经验沉淀（"写配置避免同类问题再次发生"）
fix_done / 确认拒绝时由 `persistLesson` 落库，并在后续同项目甄别/开发**自动注入**（`buildLessonsContext`）：
- **devbench 经验库**（`store.{get,add,delete}Lessons`，按 TB 项目隔离、团队共享）—— 权威永久库。
- **工程 CLAUDE.md**「已知问题与预防」托管块（`writeLessonsToClaudeMd`，**先读后写**、只重写 `<!-- DEVBENCH_LESSONS_START/END -->` 块）—— Claude CLI 每次在该工程目录自动加载＝等价永久记忆。**用户在完成卡片点按钮导出**（git 跟踪文件，不静默改）。
- **工程 `docs/wiki/<slug>.md`**（`writeWiki`）—— 用户点「加入 Wiki」导出。
- **Bug Agent 记忆**（`recordLessonToBugAgent`，best-effort）—— 注意 `session_memory` 为 **7 天 TTL 近期记忆**，非永久。

### 发布生产（车型生产发布目录 + 一键发布 + 钉钉通知）
- **车型增配置维度「生产发布目录」**：`VehicleSourceModal` 每车型一个 `prodReleaseDir`（**只填基目录**，UNC/本地皆可），存 `vehicleMap[flavor].prodReleaseDir`（`normalizeVehicleMapping` 保留），随既有 vehicleMap **gossip 局域网同步**（多设备/客户端/服务端）。
- **实际目录由代码补日期子级**（`datedReleaseDir`，**纯代码不调 AI**）：`<基目录>\<本周五 YYYY-MMDD>\Temp_<今天 YYYYMMDD>`（本周五已过则下周五；如 `…\E22H-GP\2026-0619\Temp_20260619`）。拷贝/ReadMe/钉钉里的「目录」均指这个补全后的全路径。
- **故事点「🚀 发布生产」按钮**（`StoryTab`，主工程区）→ `POST /devbench/tabs/:id/publish-prod`（仅管理员，body 带 `projectId`）：① 按主工程 flavor 查该车型 `prodReleaseDir`；② 扫 `build/outputs` 定位 **prod release apk**（路径含 prod+release 优先）+ `mapping.txt`（jszip 压成 `mapping-<ver>.zip`）；③ 拷 apk+mapping.zip 到该目录；④ 追加/创建 `ReadMe.txt`（版本/日期/改动内容/范围/测试建议——由 **git log(上个 tag→HEAD) + 故事点修复·验收报告** 经 AI 合成）；⑤ 钉钉「应用市场出包机器人」通知。版本号取 `store.readProjectVersion`，应用名取 `config.prodPublish.appName`(默认「应用市场」)。
- **车型维度「是否需要重新签名」`needsResign`**（默认 false，`normalizeVehicleMapping` 保留、随预置同步）：为 true 时发布生产的钉钉消息**版本号带 `_未签名` 后缀、且不 @人**（3 行）；false 时正常 4 行带真 @。
- **@ 的人可配置（钉钉消息配置）**：devbench 顶栏「📨 钉钉消息配置」按钮（**仅管理员可见/可改**）→ `DingtalkMsgConfigModal`，配 `publish.signed[]` / `publish.unsigned[]`（每项 `{name,mobile}`），存全局共享 `dingtalkMsgConfig`（`store.{get,set}DingtalkMsgConfig`，并入 shared-bundle gossip 随 byProject 同步）。发布时：有签名取 signed、没签名取 unsigned；该列表非空才 @、且版本号在 needsResign 时带 `_未签名`。手机号优先用配置里手填，其次按姓名自动解析（需钉钉应用凭证）。路由 `GET/PUT /devbench/dingtalk-msg-config`（PUT 管理员）。
- **钉钉消息格式**：`包来自：@${当前登录用户钉钉名}\n${应用名}：${版本[_未签名]}\n${生产发布目录}\n${改动简介}` + （配了人且有手机号时）钉钉自动在末尾追加 `@人1 @人2`（取不到手机号才用文本 @ 占位）。版本号优先从 apk 文件名解析。同名 apk 已存在则**终止不覆盖**。webhook/真@手机号配在 `config.prodPublish.{dingtalkWebhook,atMobiles}`（webhook 留空用内置出包机器人；`atMobiles` 填手机号才真 @到人）。实现：`routes/devbench.js`（findProdReleaseApk/findMappingFile/sendProdDingtalk/publish-prod 路由）。

## 开发约定

- **网关**: Node.js 20+（强制）+ Express + WebSocket + better-sqlite3@12.x，ESM 模块
- **前端**: React 19 + Vite + Tailwind CSS，暗色主题（zinc 色系），React Router（HashRouter for file://）
- **桌面**: Electron 33 + electron-builder NSIS，内置 Node.js portable
- **Prompt 构建顺序**: 系统级规则 → Persona → 对话摘要 → 历史 → Skill 指南 → 任务描述
- **CLI 引擎**通过 stdin 管道传入 prompt，**API 引擎**通过 HTTP 流式调用
- **上下文预算**根据引擎官方上下文窗口自动计算（Claude 20K、Gemini 15K、API 引擎 8-12K）
- **设备扫描**结果存客户端 localStorage，不存服务端
- **gateway-bundle.zip** 不含 node_modules（用于 Web 模式分发，桌面版用预装的）

## 富媒体商业报告交付规范（report-deliverable）

> 用户要"生成报告/架构图/PPT/PDF"，尤其强调"像给客户做商业报告"时，按此交付。目标：**整目录复制到任意电脑即离线可用，图文影音 + 日志链接全部正常**。

- **三件套同出**：HTML（自包含富媒体报告）+ PPT（`gateway/node_modules/pptxgenjs`，`addImage` 把图片嵌入字节、不外链）+ PDF（本机 Edge/Chrome `--headless --print-to-pdf`，或 `gateway/services/deck-export.js#findBrowser`）。
- **自包含可迁移（铁律）**：报告引用的所有图片/视频/日志/原始资料先**拷进输出目录 `assets/`**（图片视频放 `assets/`，文本日志/原始报告放 `assets/logs/`），HTML 一律用**相对路径**；严禁本地绝对路径、`file:///`、跨目录 `../` 外链。交付前自查无绝对路径泄露、每个引用文件存在。
- **交互三能**：图片点击→灯箱看全屏原尺寸图（纯 JS/CSS，含 1:1 切换 / Esc 关闭）；视频 `<video controls>` 可播放；日志/资料 `<a target=_blank>` 可打开。`@media print` 隐藏灯箱/缩放提示保证 PDF 干净。
- **数据诚实**：数字/结论可追溯到来源文件/commit；**已回退/未落地/方案稿/非严格 A/B 必须显式标注**，不得当成果展示（遵最高优先级回答标准）。
- **临时脚本即清理**（如 `gen-ppt.cjs` 用完即删）。本规范与 `/acceptance-report`、`/work-report 详细版`、devbench 第三步报告同源；样例产物：`docs/devbench/step3/架构图/`（avatr8678 代码架构 + 冷启动优化报告 HTML/PPT/PDF + assets/）。

## Windows 脚本中文编码（windows-bat-encoding，最高优先级）

> 反复踩坑：生成的 `.bat` 双击后中文乱码。根因：`.bat` 存成 UTF-8，zh-CN Win10 控制台默认 **GBK(cp936)**，cmd 按 GBK 解析 UTF-8 中文字节→乱码；`chcp 65001` 救不了 .bat 自身文本。

- **`.bat`/`.cmd` 文件本身只用 ASCII 英文**（echo/rem/提示）；**严禁在 UTF-8 的 .bat 里直接写中文**。顶部可留 `chcp 65001 >nul`（仅统一子进程 UTF-8，对纯 ASCII 无害）。
- **中文输出交给 python / PowerShell**：python3 走 WriteConsoleW 与代码页无关（管道时设 `PYTHONIOENCODING=utf-8`）；PowerShell 用 `-Encoding utf8`。
- Write 工具默认写 UTF-8：要中文就用 `.ps1`/python，或用 python 以 `cp936` 重编码落盘，别直接 UTF-8 存中文 .bat。
- **交付前自检**：`.bat`/`.cmd` 非 ASCII 字节应为空。样例已遵此：`docs/PerformanceReports/perfetto-timeline-gen/start_engine.bat`、`docs/PerformanceReports/demo0/start_engine.bat`。

<!-- intent-impact-guard:start -->
## Intent & Impact Guard

For ambiguous defects or changes to auth, routes, shared UI, public APIs, SDKs, data sources, Flavors, deletion or migration, invoke `/intent-impact-guard` before editing. The canonical rules are linked from `.claude/skills/intent-impact-guard` to `.agents/skills/intent-impact-guard`. No write before PREWRITE `READY`.
<!-- intent-impact-guard:end -->
