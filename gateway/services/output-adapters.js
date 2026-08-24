/**
 * 输出适配器：将任务结果发送到不同渠道
 */
import { getConfig } from "./config.js";
import { writeFileSync, mkdirSync, existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { log } from "./logger.js";

/**
 * 发送结果到指定渠道
 * @param {string} target - dingtalk | feishu | save_file | log
 * @param {object} config - 渠道配置 JSON
 * @param {string} content - 消息内容
 * @param {string} title - 消息标题
 */
export async function sendOutput(target, outputConfig, content, title = "") {
  try {
    const cfg = typeof outputConfig === "string" ? JSON.parse(outputConfig || "{}") : (outputConfig || {});

    switch (target) {
      case "dingtalk":
        return await sendDingtalk(cfg, content, title);
      case "feishu":
        return await sendFeishu(cfg, content, title);
      case "save_file":
        return saveToFile(cfg, content, title);
      case "log":
      default:
        log("system", "info", "output", `[${title}] ${content.slice(0, 200)}`);
        return { success: true };
    }
  } catch (err) {
    log("system", "error", "output", `发送到 ${target} 失败: ${err.message}`);
    return { success: false, error: err.message };
  }
}

/**
 * 钉钉机器人 Webhook
 */
async function sendDingtalk(cfg, content, title) {
  const config = getConfig();
  const webhook = cfg.webhook || config.dingtalkRobotWebhook;
  if (!webhook) throw new Error("未配置钉钉机器人 Webhook");

  const body = {
    msgtype: "markdown",
    markdown: {
      title: title || "AI 定时任务",
      text: content.slice(0, 5000),
    },
  };

  const resp = await fetch(webhook, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await resp.json();
  if (data.errcode !== 0) throw new Error(data.errmsg || JSON.stringify(data));
  return { success: true };
}

/**
 * 飞书 Webhook（自定义机器人）或 API 消息
 */
async function sendFeishu(cfg, content, title) {
  const webhook = cfg.webhook;
  if (webhook) {
    // 自定义机器人 Webhook
    const body = {
      msg_type: "interactive",
      card: {
        header: { title: { tag: "plain_text", content: title || "AI 定时任务" } },
        elements: [{ tag: "markdown", content: content.slice(0, 5000) }],
      },
    };
    const resp = await fetch(webhook, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await resp.json();
    if (data.code !== 0 && data.StatusCode !== 0) throw new Error(data.msg || JSON.stringify(data));
    return { success: true };
  }

  // 通过飞书应用 API 发送（需要 feishu service 配合）
  // 此处由 feishu.js 的 sendMessage 处理
  const { sendFeishuMessage } = await import("./feishu.js");
  if (cfg.chatId) {
    await sendFeishuMessage(cfg.chatId, content, title);
    return { success: true };
  }

  throw new Error("飞书输出未配置 webhook 或 chatId");
}

/**
 * 保存到文件
 */
function saveToFile(cfg, content, title) {
  const config = getConfig();
  const dir = cfg.dir || config.reportOutputDir || join(homedir(), "ai-reports");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  const fileName = `${(title || "task").replace(/[\/\\:*?"<>|]/g, "-")}_${new Date().toISOString().slice(0, 10)}.md`;
  const filePath = join(dir, fileName);
  writeFileSync(filePath, content, "utf-8");
  log("system", "info", "output", `结果已保存: ${filePath}`);
  return { success: true, filePath };
}
