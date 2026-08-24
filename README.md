# AIEfficiency

AIEfficiency 是一个面向研发团队的本地优先 AI 自动化开发管理平台，将工单读取、故事点初始化、独立 Worktree、AI 执行、质量验收、设备联调与结果回写整合到同一工作台。

## 核心能力

- 统一研发工作台：管理故事点、任务列表、工程配置、环境诊断和设备状态。
- 多模型协作：支持 Codex、Claude、Gemini 等执行引擎的路由与状态追踪。
- 工单与项目同步：提供 Teambition、飞书项目等连接器及来源归一化能力。
- 隔离开发：为故事点创建独立 Git Worktree，降低并行修改互相污染的风险。
- 质量闭环：支持工程验收、运行态故事点验收、证据记录和可追踪状态流转。
- 车机联调：集成设备发现、ADB 操作、性能采集与工程调试入口。

## 技术架构

- Web：React 19、Vite 6、Tailwind CSS
- Gateway：Node.js、Express、SQLite、WebSocket
- Desktop：Electron
- AI/MCP：多 Agent 执行适配器、只读 MCP 服务与可配置模型路由

## 本地启动

建议使用仓库声明的 Node.js 版本。首次运行前安装各子项目依赖：

```powershell
Set-Location .\web-dashboard
npm ci

Set-Location ..\gateway
npm ci

Set-Location ..\mcp-servers\devServer
npm ci
```

回到仓库根目录后运行：

```powershell
.\start.ps1
```

默认本地页面为 `http://127.0.0.1:3000/`。具体配置请从仓库内的 `*.example` 文件复制到对应的本地配置文件，不要把真实凭据提交到 Git。

## 安全说明

此仓库是不包含原始 Git 历史的脱敏源码快照。运行数据库、日志、Cookie、令牌、私钥、本地账号配置、内部工单原始材料和临时验收证据均不纳入版本控制。详细导出摘要见 `SANITIZATION_MANIFEST.json`。

