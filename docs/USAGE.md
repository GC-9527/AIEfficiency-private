# AIEfficiency 使用文档

> AAOS 三方应用集成 AI 提效工具 — 基于 OpenClaw 风格的 Skill 驱动智能编排架构

---

## 目录

1. [系统概览](#系统概览)
2. [快速开始](#快速开始)
3. [AI 对话](#ai-对话)
4. [Skill 系统](#skill-系统)
5. [引擎管理](#引擎管理)
6. [设备管理](#设备管理)
7. [工作流](#工作流)
8. [平台能力文档](#平台能力文档)
9. [API 参考](#api-参考)
10. [订阅与计费](#订阅与计费)

---

## 系统概览

### 架构

```
Web面板 (localhost:3000)  ←→  统一网关 (localhost:3001)  ←→  Claude / Gemini / Codex CLI
     ↑                              ↑
   浏览器                    钉钉机器人 / REST API / WebSocket
```

### 核心流程

```
用户消息
  ├─ /skill-name 命令 → 快速路径（直接执行指定 Skill）
  └─ 自然语言 → AI 智能规划
     ├─ 读取平台能力文档（所有 Skill 摘要）
     ├─ AI 分析任务 → 分配 Skill + 引擎 + 审查标记
     ├─ 单任务 → 直接执行
     └─ 复合任务 → DAG 调度并行/串行执行 → 汇总结果
```

### 本地/API 多引擎协作

| 引擎 | 定位 | 计费 | 适用场景 |
|------|------|------|---------|
| **Claude Code** | 强推理 | 订阅制 (Claude Max) | Bug 深度分析、SMALI 修改、架构设计 |
| **Gemini CLI** | 免费轻量 | 免费 1000次/天 | 日志初筛、信息查询、任务规划 |
| **OpenAI Codex** | 代码专精 | API 计费 | 代码生成、文件操作、批量修改 |
| **Hermes Agent** | 本地智能体 | 由 Hermes provider 决定 | 复用本机 Hermes 的工具、记忆、规则与模型执行 Agentic 任务 |

Hermes 首次使用前先在终端完成 `hermes setup`，再到「设置 → 引擎配置」开启「Hermes Agent」。平台使用 Hermes 官方 `--oneshot` 无头模式；运行中追加的消息会进入下一轮队列。

---

## 快速开始

### 本地开发

```bash
# 1. 启动网关
cd gateway && npm start          # → http://localhost:3001

# 2. 启动 Web 面板
cd web-dashboard && npm run dev  # → http://localhost:3000
```

### 云端访问

- 面板地址: `http://192.168.10.156:8080`
- 首次使用需在 **设置 → 网关地址** 配置本地网关 IP（如 `http://192.168.10.156:3001`）

---

## AI 对话

### 基本使用

在聊天页面输入自然语言，AI 会自动：
1. 分析你的需求
2. 匹配合适的 Skill（如有）
3. 选择最佳引擎
4. 执行任务并返回结果

### 示例

| 输入 | AI 行为 |
|------|--------|
| `分析这个 crash 日志` | → 匹配 `/bug-report` Skill，用 Claude 分析 |
| `帮我查一下 AAOS 的文档` | → 匹配 `/web-search` Skill，用 Gemini 搜索 |
| `修改 smali 绕过签名验证` | → 匹配 `/smali-analyze` Skill，用 Claude 执行，**自动审查** |
| `分析日志并修改适配代码` | → AI 拆分为 2 个子任务，分别分配 Skill，并行执行 |

### 快速命令

使用 `/skill-name` 直接指定 Skill，跳过 AI 规划：

```
/bug-report 应用市场闪退，日志如下...
/adb-helper 安装 test.apk 到设备
/smali-analyze 修改 com.example.MainActivity
```

### 自动审查

涉及代码/文件修改的任务（如 SMALI 修改、分辨率适配）会自动启用 **监察者审查**：

1. AI 执行修改任务
2. 监察者 AI 自动审查输出
3. 不合格 → 注入反馈，AI 重新执行（最多 3 次）
4. 合格 → 返回最终结果

用户无需手动操作，审查过程透明可见。

### 任务拆分

复杂任务自动拆分为子任务，通过 DAG 调度器并行/串行执行：

- 子任务面板实时显示进度
- 每个子任务独立分配 Skill 和引擎
- 所有子任务完成后 AI 汇总生成最终报告

### 会话续接

系统自动保存 CLI 会话 ID，同一聊天会话中的后续消息会续接上下文，无需重复说明背景。

---

## Skill 系统

### 概念

Skill 是平台的核心能力单元，定义 AI 在特定领域的行为指南。采用 **OpenClaw 风格的 Markdown 文件**（SKILL.md）：

```markdown
---
name: skill-id
description: 一句话能力描述
---

你是一个[领域]专家...

## 工作流程
1. ...
2. ...

## 输出格式
...
```

### 已有 Skill

| Skill | 说明 | 涉及修改 |
|-------|------|---------|
| `/bug-report` | Bug 分析报告生成 | 否 |
| `/adb-helper` | ADB 操作封装 | 否 |
| `/smali-analyze` | SMALI 分析与修改 | **是** |
| `/resolution-adapt` | 分辨率/DPI 适配 | **是** |
| `/web-search` | Web 搜索与信息抓取 | 否 |
| `/os-helper` | 系统文件/进程操作 | **是** |
| `/task-workflow` | 钉钉任务工作流 | 否 |
| `/analyze-voice-see-logs` | VoiceSee 日志诊断 | 否 |
| `/media-debug` | MediaSession 媒体诊断 | 否 |
| `/decrypt-elog` | ELOG 加密日志解密 | 否 |

### 管理 Skill

**Web 面板**：导航栏 → Skills 页面
- 查看所有 Skill 列表和内容
- 顶部显示平台能力摘要

**API 操作**：

```bash
# 列出所有 Skill
GET /api/skills

# 创建 Skill
POST /api/skills
{
  "id": "my-skill",
  "name": "我的技能",
  "description": "一句话描述",
  "content": "详细的 AI 行为指南..."
}

# 更新 Skill
PUT /api/skills/my-skill
{
  "name": "更新后的名称",
  "description": "更新后的描述",
  "content": "更新后的指南..."
}

# 删除 Skill
DELETE /api/skills/my-skill

# 同步到云端 Docker
POST /api/skills/sync-cloud
```

### 自定义 Skill 指南

创建新 Skill 时建议包含：

1. **角色定义**：你是什么专家
2. **能力范围**：能做什么、不能做什么
3. **工作流程**：步骤 1、2、3...
4. **输出格式**：期望的输出结构
5. **注意事项**：避免的常见错误

Skill 变更后系统自动更新平台能力文档，下次 AI 对话即可使用新能力。

---

## 引擎管理

### 配置

在 **设置** 页面管理引擎：

- **默认引擎**：所有任务的首选引擎
- **Gemini 开关**：启用/禁用免费引擎
- **Codex 开关**：启用/禁用代码专精引擎
- **自动切换**：主引擎失败时自动切换到备用引擎

### 引擎状态检测

点击引擎卡片检测当前状态（是否已登录、CLI 版本等）。

### 引擎选择逻辑

1. **显式指定**：任务可通过 AI 规划或手动指定引擎
2. **自动分配**：AI 规划器根据任务类型推荐引擎
3. **Fallback**：主引擎失败自动切换

---

## 设备管理

### 车机设备发现

导航栏 → **设备** 页面

**扫描发现**：
1. 点击 "扫描发现" 按钮
2. 系统自动从已连接 ADB 设备 + 本机网卡推导 /24 子网
3. TCP 5555 端口并发探测（~10 秒）
4. ADB 连接验证 + `automotive` 指纹识别
5. 车机设备绿色标记，其他设备蓝色标记

**手动操作**：
- 输入 IP 手动连接
- 添加/删除扫描网段
- 自定义扫描端口

**设备列表持久化**：
- 扫描结果保存到数据库
- 切换页面不丢失
- 下次扫描更新

---

## 工作流

### 自动工作流（推荐）

在对话中描述复杂任务，AI 自动编排：

```
用户: 分析应用市场的 crash 日志，找到根因后修改 smali 绕过问题
AI: [自动拆分]
  ├─ 子任务1: crash 日志分析 (bug-report, Claude)
  └─ 子任务2: smali 修改 (smali-analyze, Claude, 审查) [依赖子任务1]
```

### 手动工作流

导航栏 → 工作流页面 → 可视化编辑器：

1. 添加步骤节点
2. 设置 prompt、引擎、Skill
3. 每个步骤可独立开启"审查"
4. 拖拽连线设置依赖关系
5. 保存并执行

### 工作流设置

右侧面板：
- **自动分解**：启用后 AI 自动将输入拆分为步骤
- **审查引擎**：选择审查用的 AI 引擎
- **最大重试次数**：审查不通过时的重试上限

---

## 平台能力文档

系统自动从所有 Skill 生成能力摘要，用于：

1. **AI 自主编排**：每次 AI 规划时读取，知道自己能做什么
2. **前端展示**：Skills 页面顶部显示当前平台能力
3. **API 查询**：`GET /api/skills/capabilities`

### 能力自动推断

系统从 Skill 名称和描述自动推断：
- **触发关键词**：什么样的请求应该使用该 Skill
- **是否涉及修改**：是否需要自动审查

### Skill 变更自动同步

修改 `skills/` 目录下的文件后：
1. 系统自动清空缓存
2. 重新生成能力文档
3. WebSocket 通知前端刷新
4. 下次 AI 对话即可使用新能力

---

## API 参考

### 聊天

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/chat/sessions` | 创建会话 |
| GET | `/api/chat/sessions` | 会话列表 |
| POST | `/api/chat/sessions/:id/send` | 发送消息（AI 自动规划+执行） |
| GET | `/api/chat/sessions/:id/messages` | 获取消息历史 |

### Skills

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/skills` | 列出所有 Skill |
| POST | `/api/skills` | 创建 Skill |
| PUT | `/api/skills/:id` | 更新 Skill |
| DELETE | `/api/skills/:id` | 删除 Skill |
| GET | `/api/skills/capabilities` | 平台能力文档 |
| GET | `/api/skills/capabilities/summary` | 能力纯文本摘要 |
| POST | `/api/skills/sync-cloud` | 同步到云端 Docker |

### 设备

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/devices/discover` | 扫描发现车机 |
| GET | `/api/devices/cached` | 缓存的设备列表 |
| POST | `/api/devices/connect` | 连接设备 |
| POST | `/api/devices/disconnect` | 断开设备 |
| GET | `/api/devices/subnets` | 子网列表 |
| POST | `/api/devices/subnets` | 添加子网 |

### 配置

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/config` | 读取配置 |
| PUT | `/api/config` | 更新配置（即时生效） |
| GET | `/api/config/engine-status` | 引擎状态检测 |

### 工作流

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/workflows` | 工作流列表 |
| POST | `/api/workflows` | 创建工作流 |
| PUT | `/api/workflows/:id` | 更新工作流 |
| POST | `/api/workflows/:id/run` | 执行工作流 |

---

## 订阅与计费

### 订阅模式

本系统采用 **订阅制**，通过 CLI 工具的订阅服务使用 AI 能力：

| 引擎 | 计费方式 | 说明 |
|------|---------|------|
| Claude Code | **Claude Max 订阅** | 月付订阅，无需按 token 计费，强推理能力 |
| Gemini CLI | **免费** | Google 提供 1000 次/天免费额度 |
| OpenAI Codex | **API Key** | 按 token 计费，需配置 API Key |
| Hermes Agent | **本机配置决定** | 复用 `hermes setup` 选定的 provider/model，并记录 Hermes 返回的真实用量 |

### Token 用量追踪

导航栏 → **用量** 页面：
- 按引擎查看 token 消耗（估算值）
- 每日趋势条形图
- 支持 7/14/30 天切换

### 成本优化建议

1. 简单任务（查询、日志初筛）优先使用 **Gemini**（免费）
2. 复杂推理（Bug 分析、SMALI 修改）使用 **Claude**（订阅制，不按量计费）
3. AI 规划器默认使用 Gemini 执行（免费），规划结果分配到合适引擎
4. 设置 → 启用"失败自动切换"，主引擎不可用时自动降级

---

## Web 面板页面

| 页面 | 路径 | 说明 |
|------|------|------|
| 聊天 | `/chat` | 主交互入口，AI 自动编排 |
| Skills | `/skills` | Skill 列表 + 平台能力摘要 |
| Agents | `/agents` | 引擎角色 + 任务表 |
| 用量 | `/tokens` | Token 消耗统计 |
| 日志 | `/logs` | 任务日志查看 |
| 设备 | `/devices` | 车机发现与连接 |
| 设置 | `/settings` | 引擎配置 + 网关 + 钉钉 |

---

## 常见问题

### Q: 其他设备访问面板时设备扫描报错？
A: 设备扫描需要连接本地网关。在 **设置 → 网关地址** 配置网关 IP。

### Q: AI 没有使用我新创建的 Skill？
A: Skill 变更后能力文档会自动更新。如果仍未生效，尝试重启网关。

### Q: 如何让 AI 强制使用某个引擎？
A: 在消息中使用快速命令 `/skill-name`，Skill 会带上推荐引擎。或在工作流编辑器中为步骤指定引擎。

### Q: 审查机制会增加多少耗时？
A: 每次审查约增加 5-10 秒（一次额外的 AI 调用）。大多数修改首次就能通过审查。
