import { Router } from "express";
import { createHmac } from "crypto";
import { randomUUID } from "crypto";
import { createTask } from "../db/sqlite.js";
import { classifyTask } from "../services/dispatcher.js";
import { runTask } from "../services/agent-runner.js";
import { log } from "../services/logger.js";

const router = Router();

// 钉钉机器人回调验证密钥（从环境变量获取）
const DINGTALK_TOKEN = process.env.DINGTALK_ROBOT_TOKEN || "";
const DINGTALK_SECRET = process.env.DINGTALK_ROBOT_SECRET || "";

/**
 * 验证钉钉回调签名
 */
function verifySignature(timestamp, sign) {
  if (!DINGTALK_SECRET) {
    const environment = String(process.env.NODE_ENV || "").trim().toLowerCase();
    return environment === "test"
      || (
        environment === "development"
        && String(process.env.AIEFFICIENCY_ALLOW_UNSIGNED_DINGTALK_CALLBACK || "") === "1"
      );
  }

  const stringToSign = `${timestamp}\n${DINGTALK_SECRET}`;
  const hmac = createHmac("sha256", DINGTALK_SECRET)
    .update(stringToSign)
    .digest("base64");
  return hmac === sign;
}

/**
 * 钉钉机器人消息回调
 * POST /api/dingtalk/callback
 *
 * 钉钉消息格式参考:
 * {
 *   "msgtype": "text",
 *   "text": { "content": "@AI助手 分析这个bug" },
 *   "senderNick": "张三",
 *   "senderStaffId": "user123",
 *   "conversationId": "xxx",
 *   "atUsers": [{ "dingtalkId": "xxx" }]
 * }
 */
router.post("/callback", async (req, res) => {
  const { timestamp, sign } = req.headers;

  // 签名验证
  if (!DINGTALK_SECRET && !verifySignature(timestamp, sign)) {
    return res.status(503).json({ error: "钉钉回调密钥未配置，已失败关闭" });
  }
  if (DINGTALK_SECRET && !verifySignature(timestamp, sign)) {
    return res.status(403).json({ error: "签名验证失败" });
  }

  const msg = req.body;
  const content = msg.text?.content?.trim() || "";
  const senderNick = msg.senderNick || "未知用户";

  // 移除@提及部分，提取实际指令
  const command = content.replace(/@\S+/g, "").trim();

  if (!command) {
    return res.json({ msgtype: "text", text: { content: "请输入任务描述" } });
  }

  log("system", "info", "dingtalk", `收到钉钉消息 from ${senderNick}: ${command}`);

  // 处理特殊指令
  if (command === "帮助" || command === "help") {
    return res.json({
      msgtype: "markdown",
      markdown: {
        title: "AI助手帮助",
        text: [
          "## AI助手指令",
          "- **分析bug**: 发送bug描述/日志，自动分析并生成报告",
          "- **查看任务**: 查看当前任务列表和状态",
          "- **任务状态 <ID>**: 查看指定任务进度",
          "- **帮助**: 显示此帮助信息",
          "",
          "示例: @AI助手 分析这个crash日志: ...",
        ].join("\n"),
      },
    });
  }

  if (command === "查看任务") {
    // 返回最近任务列表（此处简化）
    return res.json({
      msgtype: "text",
      text: { content: "请访问 Web面板 查看完整任务列表" },
    });
  }

  // 创建并执行任务
  const taskId = randomUUID();
  const taskType = classifyTask(command);

  const task = {
    id: taskId,
    title: command.slice(0, 50),
    description: command,
    type: taskType,
    status: "pending",
    priority: 3,
    source: "dingtalk",
    sourceId: msg.conversationId || null,
  };

  createTask(task);

  // 异步执行
  runTask(task)
    .then((result) => {
      // TODO: 执行完成后通过钉钉机器人回调推送结果
      log(taskId, "info", "dingtalk", `任务完成，待推送结果`);
    })
    .catch((err) => {
      log(taskId, "error", "dingtalk", `任务失败: ${err.message}`);
    });

  // 立即回复确认
  res.json({
    msgtype: "text",
    text: {
      content: `✓ 任务已接收\n类型: ${taskType}\nID: ${taskId.slice(0, 8)}\n正在处理中，完成后将推送结果...`,
    },
  });
});

export default router;
