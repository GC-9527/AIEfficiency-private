# 定时任务 + 飞书集成 实施计划

> 状态：实施中
> 创建日期：2026-04-09
> 更新日期：2026-04-10（微信方案改为飞书）

## 背景

实现定时任务（cron 驱动）+ 飞书双向通信，让用户可以在飞书里向 AIEfficiency 发消息，平台调 AI 处理后把结果回发到飞书。

## 为什么改飞书

| 对比 | 微信客服 | 飞书自建应用 |
|------|---------|------------|
| 注册门槛 | 需企业微信 + 微信客服开通 | 飞书开放平台创建应用即可 |
| 公网 IP | 需要（webhook 回调） | **不需要（长连接模式）** |
| 内网穿透 | 需要（或云端中转） | **不需要** |
| 双向通信 | 复杂（客服号 + 加密） | 简单（事件订阅 + 长连接） |
| 发送消息 | 企业微信 API | 飞书 API `im:message:send_as_bot` |
| 接收消息 | 配置回调 URL + 加密 | `im.message.receive_v1` 事件 + WebSocket |
| 认证费用 | 300/年（完整功能） | 免费 |

## 一、定时任务

### 数据模型
```sql
CREATE TABLE scheduled_tasks (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  cron_expr TEXT NOT NULL,
  enabled INTEGER DEFAULT 1,
  prompt TEXT NOT NULL,
  engine TEXT,
  skill TEXT,
  output_target TEXT,        -- dingtalk / feishu / save_file / log
  output_config TEXT,        -- JSON
  last_run_at TEXT,
  last_status TEXT,
  last_output_excerpt TEXT,
  created_at TEXT DEFAULT (datetime('now', 'localtime')),
  updated_at TEXT DEFAULT (datetime('now', 'localtime'))
);
```

### 文件清单
- `gateway/services/scheduler.js` — 启动加载 + node-cron 注册
- `gateway/services/output-adapters.js` — 钉钉/飞书/文件适配器
- `gateway/routes/schedule.js` — CRUD + 立即执行 + 启停
- `gateway/db/sqlite.js` — 表迁移 + CRUD
- `web-dashboard/src/pages/Schedule.jsx` — 任务列表 + 表单 + 历史

### 用户交互
- 表单：名称 / 触发时间（预设下拉 + 高级 cron）/ prompt / 引擎 / 输出目标
- 列表：开关、下次运行时间、上次状态、立即执行按钮
- 触发预设：每天 X:XX / 每周 X 几点 / 每隔 N 分钟 / 自定义 cron

### 依赖
- `node-cron`：轻量 cron 库（npm install node-cron）

## 二、飞书集成

### 核心优势
- **WebSocket 长连接**：网关主动连飞书云端，不需要公网 IP、域名、内网穿透
- **免费**：飞书开放平台创建应用不收费
- **双向通信**：用户在飞书发消息 → 机器人收到 → AI 处理 → 机器人回复

### 前置准备

- [ ] 登录 [飞书开放平台](https://open.feishu.cn/) 创建企业自建应用
- [ ] 应用 → 凭证与基础信息 → 拿到 `App ID` 和 `App Secret`
- [ ] 添加机器人能力（应用能力 → 添加应用能力 → 机器人）
- [ ] 权限管理 → 申请权限：
  - `im:message` — 获取与发送单聊、群聊消息
  - `im:message:send_as_bot` — 以机器人身份发送消息
- [ ] 事件与回调 → **使用长连接接收事件**（不选 webhook）
- [ ] 添加事件 `im.message.receive_v1`（接收消息）
- [ ] 发布应用版本

### 架构设计

```
                    WebSocket 长连接（飞书 SDK 自动维护）
┌─────────────────┐ ──────────────────────────────────→ ┌──────────────────┐
│  用户本机网关    │                                      │  飞书云端         │
│  localhost:3001 │ ←────────────────────────────────── │  open.feishu.cn  │
└─────────────────┘   事件推送（用户消息）                 └──────────────────┘
        │                                                        ↑
        │ AI 处理                                               │
        ↓                                                        │
   runTask → 结果                                          用户在飞书发消息
        │
        └──→ 调飞书 API 回复消息
```

**关键**：不经过云端 Docker（8080），网关直连飞书，架构更简单。

### 数据流

#### 接收消息
1. 用户在飞书私聊或群聊 @机器人 发消息
2. 飞书通过 WebSocket 长连接推送 `im.message.receive_v1` 事件到网关
3. 网关解析消息内容（文本 / 富文本 / 图片）
4. 调 `runTask` → AI 处理 → 拿到结果

#### 发送回复
1. 网关调用飞书 API `POST /open-apis/im/v1/messages` 发送回复
2. 支持文本 / Markdown / 卡片消息

### 技术实现

#### 方案 A：使用飞书官方 Node.js SDK（推荐）
```bash
npm install @larksuiteoapi/node-sdk
```
SDK 内置长连接管理、事件分发、自动重连。

#### 方案 B：自行实现 WebSocket
不推荐，需要处理心跳、重连、事件分发等底层逻辑。

### 文件清单

- `gateway/services/feishu.js` — 飞书 SDK 初始化 + 消息收发 + 长连接
- `gateway/routes/feishu.js` — 配置 + 状态查询
- `web-dashboard/src/pages/Settings.jsx` — 飞书配置区（App ID / App Secret / 启用开关）

### 凭证存储

- `config.json` 中的 `feishu` 字段：
  ```json
  {
    "feishu": {
      "appId": "cli_xxxxx",
      "appSecret": "xxxxx",
      "enabled": false
    }
  }
  ```

## 三、参考资料

- [飞书自定义机器人使用指南](https://open.feishu.cn/document/client-docs/bot-v3/add-custom-bot?lang=zh-CN)
- [飞书 × OpenClaw 长连接接入指南](https://adg.csdn.net/69a286f10a2f6a37c594241a.html)
- [飞书 Node.js SDK](https://github.com/larksuite/node-sdk)
- [飞书开放平台 - 发送消息 API](https://open.feishu.cn/document/server-docs/im-v1/message/create)
- [飞书事件订阅 - 接收消息](https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/im-v1/message/events/receive)

## 四、实施顺序

1. **定时任务**（无外部依赖，立即实施）
   - DB 表 + CRUD + scheduler + 前端页面
   - 输出适配器（钉钉 / 飞书 / 文件）
2. **飞书集成**（需用户先在飞书开放平台创建应用）
   - npm install @larksuiteoapi/node-sdk
   - feishu.js 服务（长连接 + 消息收发）
   - 设置页飞书配置区
3. **联调**
   - 定时任务结果推送到飞书
   - 飞书消息触发 AI 任务
