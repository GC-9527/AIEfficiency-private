/**
 * 飞书集成服务
 * 使用飞书 SDK 长连接模式，双向通信
 * 不需要公网 IP、域名、内网穿透
 */
import { getConfig } from "./config.js";
import { log } from "./logger.js";
import { runTask } from "./agent-runner.js";
import { createTask } from "../db/sqlite.js";
import { randomUUID } from "crypto";

// SDK 动态加载（未安装时优雅降级，不阻塞启动）
let lark = null;
try {
  lark = await import("@larksuiteoapi/node-sdk");
} catch {
  // SDK 未安装，飞书功能不可用
}

let client = null;
let wsClient = null;

/**
 * 初始化飞书客户端
 */
export function initFeishu() {
  const config = getConfig();
  const feishu = config.feishu || {};

  if (!feishu.appId || !feishu.appSecret) {
    console.log("[feishu] 未配置飞书 App ID/Secret，跳过初始化");
    return;
  }

  if (!feishu.enabled) {
    console.log("[feishu] 飞书集成未启用");
    return;
  }

  if (!lark) {
    console.log("[feishu] 飞书 SDK 未安装（npm install @larksuiteoapi/node-sdk），跳过");
    return;
  }

  try {
    // 创建 API 客户端
    client = new lark.Client({
      appId: feishu.appId,
      appSecret: feishu.appSecret,
      appType: lark.AppType.SelfBuild,
    });

    // 创建事件分发器
    const dispatcher = new lark.EventDispatcher({}).register({
      "im.message.receive_v1": async (data) => {
        try {
          await handleIncomingMessage(data);
        } catch (err) {
          log("system", "error", "feishu", `处理消息异常: ${err.message}`);
        }
      },
    });

    // 启动 WebSocket 长连接
    wsClient = new lark.WSClient({
      appId: feishu.appId,
      appSecret: feishu.appSecret,
      loggerLevel: lark.LoggerLevel.WARN,
    });

    wsClient.start({ eventDispatcher: dispatcher });
    console.log(`[feishu] 飞书长连接已启动 (App: ${feishu.appId})`);
    log("system", "info", "feishu", "飞书长连接已启动");
  } catch (err) {
    console.error(`[feishu] 初始化失败: ${err.message}`);
    log("system", "error", "feishu", `初始化失败: ${err.message}`);
  }
}

// 消息去重（持久化到 SQLite，防止重启后丢失 + 飞书重复投递）
import db from "../db/sqlite.js";

// 初始化去重表
try { db.exec("CREATE TABLE IF NOT EXISTS feishu_msg_dedup (message_id TEXT PRIMARY KEY, created_at TEXT DEFAULT (datetime('now','localtime')))"); } catch {}
// 定期清理 24 小时前的记录
try { db.exec("DELETE FROM feishu_msg_dedup WHERE created_at < datetime('now', '-1 day', 'localtime')"); } catch {}

function isDuplicate(messageId) {
  if (!messageId) return true;
  try {
    const exists = db.prepare("SELECT 1 FROM feishu_msg_dedup WHERE message_id = ?").get(messageId);
    if (exists) return true;
    db.prepare("INSERT OR IGNORE INTO feishu_msg_dedup (message_id) VALUES (?)").run(messageId);
    return false;
  } catch {
    return false;
  }
}

/**
 * 处理收到的飞书消息
 */
async function handleIncomingMessage(data) {
  // 兼容不同的事件结构（SDK 版本差异）
  const msg = data.message || data.event?.message;
  if (!msg) return;

  const messageId = msg.message_id;

  // 消息去重（飞书长连接可能重复投递）
  if (isDuplicate(messageId)) {
    return;
  }

  // 跳过机器人自己的消息
  const sender = data.sender || data.event?.sender;
  const senderId = sender?.sender_id?.open_id;
  if (!senderId) return;
  // sender_type 为 "app" 时是机器人自己发的
  if (sender?.sender_type === "app") return;

  // 解析消息内容
  let text = "";
  try {
    const content = JSON.parse(msg.content || "{}");
    if (msg.message_type === "text") {
      text = content.text || "";
    } else {
      text = `[${msg.message_type}消息，暂不支持处理]`;
      await replyMessage(msg.message_id, `暂只支持文本消息，请发送文字。`);
      return;
    }
  } catch {
    text = msg.content || "";
  }

  // 去除 @机器人 的文本
  text = text.replace(/@_user_\d+/g, "").trim();
  if (!text) return;

  const chatId = msg.chat_id || data.event?.message?.chat_id;
  const chatType = msg.chat_type || "unknown";

  log("system", "info", "feishu", `收到消息 [${chatType}] ${senderId}: ${text.slice(0, 100)}`);

  // 1. 立即添加表情回应（表示已收到）
  try {
    await client.im.messageReaction.create({
      path: { message_id: msg.message_id },
      data: { reaction_type: { emoji_type: "OK" } },
    });
  } catch {}

  // 2. AI 处理
  const taskId = randomUUID();
  const task = {
    id: taskId,
    title: `[飞书] ${text.slice(0, 50)}`,
    description: text,
    type: "general",
    status: "pending",
    priority: 3,
    source: "feishu",
    sourceId: chatId,
  };

  try {
    createTask(task);
    const result = await runTask(task);
    const output = result.output || result.report || "(无输出)";

    // 3. 直接发新消息到会话（不引用回复，支持 Markdown 渲染）
    await sendToChat(chatId, output);
  } catch (err) {
    await sendToChat(chatId, `处理失败: ${err.message}`);
    log("system", "error", "feishu", `处理失败: ${err.message}`);
  }
}

/**
 * 发送新消息到会话（非引用回复，使用卡片消息支持 Markdown）
 */
async function sendToChat(chatId, content) {
  if (!client) throw new Error("飞书客户端未初始化");

  const text = content.length > 5000 ? content.slice(0, 5000) + "\n\n...(内容过长已截断)" : content;

  await client.im.message.create({
    data: {
      receive_id: chatId,
      msg_type: "interactive",
      content: JSON.stringify({
        elements: [{ tag: "markdown", content: text }],
      }),
    },
    params: { receive_id_type: "chat_id" },
  });
}

/**
 * 主动发送消息到指定会话
 * @param {string} chatId - 会话 ID (oc_xxx)
 * @param {string} content - 消息内容
 * @param {string} title - 可选标题（用卡片消息）
 */
export async function sendFeishuMessage(chatId, content, title) {
  if (!client) throw new Error("飞书客户端未初始化");

  if (title) {
    // 使用卡片消息（支持 Markdown）
    await client.im.message.create({
      data: {
        receive_id: chatId,
        msg_type: "interactive",
        content: JSON.stringify({
          header: { title: { tag: "plain_text", content: title } },
          elements: [{ tag: "markdown", content: content.slice(0, 5000) }],
        }),
      },
      params: { receive_id_type: "chat_id" },
    });
  } else {
    await client.im.message.create({
      data: {
        receive_id: chatId,
        msg_type: "text",
        content: JSON.stringify({ text: content.slice(0, 4000) }),
      },
      params: { receive_id_type: "chat_id" },
    });
  }
}

/**
 * 检测飞书连接状态
 */
export function getFeishuStatus() {
  const config = getConfig();
  const feishu = config.feishu || {};
  if (!feishu.appId || !feishu.appSecret) return { status: "not_configured" };
  if (!feishu.enabled) return { status: "disabled" };
  if (!client) return { status: "not_initialized" };
  return { status: "connected", appId: feishu.appId };
}

/**
 * 重新初始化（配置变更后调用）
 */
export function restartFeishu() {
  if (wsClient) {
    try { wsClient.stop?.(); } catch {}
    wsClient = null;
  }
  client = null;
  initFeishu();
}
