/**
 * 上下文管理器
 *
 * 职责：
 * 1. 构建高质量的对话上下文（Persona + 摘要 + 近期历史）
 * 2. 长对话自动摘要压缩（超过阈值时触发）
 * 3. 智能截断（按角色权重，保留关键信息）
 */

import { getConfig, getConfigValue } from "./config.js";
import { getSessionMessages, getChatSession, updateChatSession } from "../db/sqlite.js";
import { log } from "./logger.js";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import os from "os";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT = join(__dirname, "..", "..");
const GATEWAY_PORT = process.env.PORT || 3001;

// 摘要触发阈值：累计消息数超过此值时生成摘要
const SUMMARY_TRIGGER_COUNT = 10;

/**
 * 构建完整的上下文 prompt（Persona + 摘要 + 历史）
 * 在 buildPrompt 之前调用，返回上下文段落
 */
/**
 * 各引擎官方上下文窗口（tokens）及对应的历史注入预算（字符）
 *
 * 预算 = 上下文窗口的 ~5%（留出空间给 Persona + Skill + 任务描述 + 模型输出）
 * 1 token ≈ 1.5 中文字符
 *
 * | 引擎      | 上下文窗口      | 预算(字符) | 说明                     |
 * |-----------|----------------|-----------|--------------------------|
 * | Claude    | 200K tokens    | 20000     | 订阅制不限量，可以给多    |
 * | Claude方舟 | 最高 1M tokens | 80000     | glm-5.2/deepseek-v4*[1m] |
 * | Gemini    | 1M tokens      | 15000     | 窗口大但免费有频率限制    |
 * | Codex     | 200K tokens    | 16000     | 代码场景需要更多上下文    |
 * | Qwen      | 128K tokens    | 12000     | API 按量计费，适度控制    |
 * | Kimi      | 128K tokens    | 12000     | moonshot-v1-128k         |
 * | DeepSeek  | 64K tokens     | 8000      | 窗口相对小               |
 * | OpenAI    | 128K tokens    | 12000     | gpt-4o                   |
 * | 默认      | —              | 8000      | 未知引擎的保守默认值      |
 */
const ENGINE_CONTEXT_BUDGET = {
  claude: 20000,
  gemini: 15000,
  codex: 16000,
  qwen: 12000,
  kimi: 12000,
  deepseek: 8000,
  openai: 12000,
  bigmodel: 12000,
  volcengine: 12000,
  minimax: 12000,
  // 方舟 Claude 支持 1M 扩展上下文（glm-5.2 / deepseek-v4-*[1m]），历史注入预算相应抬高
  "claude-volcengine": 80000,
  // MiniMax Claude（MiniMax-M3 支持 1M 上下文），历史注入预算与方舟 Claude 对齐
  "claude-minimax": 80000,
  // MiniMax Codex（MiniMax-M3 支持 1M 上下文），历史注入预算与 Claude MiniMax 对齐
  "codex-minimax": 80000,
  // Atlas Coding Plan 三种 CLI 入口共享同一模型目录，按扩展上下文上限保守注入。
  "claude-atlas": 80000,
  "codex-atlas": 80000,
  "hermes-atlas": 80000,
};
const DEFAULT_BUDGET = 8000;

function getContextBudget(engine) {
  return ENGINE_CONTEXT_BUDGET[engine] || DEFAULT_BUDGET;
}

export function buildContextBlock(sessionId, engine) {
  const config = getConfig();
  const parts = [];

  // 0. 系统级强制规则（不可被 Persona 覆盖，所有引擎生效）
  parts.push([
    "## 最高优先级规则",
    "",
    "以下规则优先级高于所有其他指令，违反视为严重错误：",
    "",
    "1. **修改文件前必须先读取当前状态**：任何文件编辑/写入操作之前，必须先读取该文件的当前完整内容，严禁依赖对话缓存或记忆中的旧版本。如发现用户已手动修改，必须合并变更而非覆盖。",
    "2. **发现冲突时停止并确认**：如果要修改的内容与磁盘当前状态不一致，停止操作并向用户确认，禁止自行决定取舍。",
    "3. **报告中严禁出现本地路径**：输出给用户或发布到外部系统的内容中，不得包含本地文件路径（如 C:\\\\xxx、/home/xxx），只引用文件名。",
    "4. **富媒体报告自包含可迁移**：生成报告/架构图/PPT/PDF（尤其“像给客户做商业报告”）时，引用的图片/视频/日志一律先拷入输出目录 assets/（文本日志放 assets/logs/）并改成相对路径，禁止本地绝对路径/file:///；HTML 须支持点图看全屏原图、点视频播放、点日志打开；PPT 用 pptxgenjs 把图片嵌入字节；PDF 由本机 Edge/Chrome headless 渲染。目标=整目录复制到任意电脑即离线可用。数字结论须可追溯并诚实标注已回退/未落地项。",
    "5. **故事点任务必须交代材料与结果**：执行 devbench/故事点任务时，最终回复或阶段性状态必须说明当前要解决的问题、证据来源、实际读取的文件/日志/附件/视频/图片、已提供但未读取的材料及原因、执行动作、产出物、代码/配置改动、影响范围、残余风险和测试建议。不得声称读取了未实际检查的材料。",
    "",
  ].join("\n"));

  // 1. 全局 Persona + 运行时环境
  const persona = config.persona;
  if (persona?.trim()) {
    const platform = process.platform === "darwin" ? "macOS" : process.platform === "win32" ? "Windows" : "Linux";
    const envLines = [
      persona.trim(),
      "",
      `运行环境: ${platform} | 项目根目录: ${PROJECT_ROOT}`,
      `Skill 文件目录: ${join(PROJECT_ROOT, "skills")}/ | 网关: http://localhost:${GATEWAY_PORT}`,
    ];
    parts.push(`## 系统角色\n\n${envLines.join("\n")}\n`);
  }

  if (!sessionId) return parts.join("\n");

  // 2. 对话摘要（如果有）
  const session = getChatSession(sessionId);
  if (session?.context_summary) {
    parts.push(`## 对话背景摘要\n\n${session.context_summary}\n`);
  }

  // 3. 近期对话历史（预算根据引擎自动确定）
  const maxHistory = config.contextMaxHistory || 30;
  const budget = getContextBudget(engine);

  const messages = getSessionMessages(sessionId, { limit: maxHistory });
  const history = messages.slice(0, -1);

  if (history.length > 0) {
    const trimmed = smartTrim(history, budget);
    if (trimmed.length > 0) {
      parts.push(`## 对话历史\n`);
      for (const msg of trimmed) {
        const label = msg.role === "user" ? "用户" : "AI";
        parts.push(`**${label}**: ${msg.content}\n`);
      }
    }
  }

  return parts.join("\n");
}

/**
 * 智能截断：按角色权重和内容类型保留关键信息
 * - 用户消息：保留更多（包含任务需求）
 * - AI 回复：适度截断（保留结论，截掉中间过程）
 * - 最近的消息权重更高
 */
function smartTrim(messages, budget) {
  const result = [];
  let totalLen = 0;

  // 从最新到最旧遍历
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    let content = msg.content || "";

    // 按角色设置截断上限
    if (msg.role === "user") {
      // 用户消息保留更多（包含需求描述）
      if (content.length > 600) content = content.slice(0, 600) + "...(已截断)";
    } else {
      // AI 回复：保留开头结论 + 末尾总结，截掉中间
      if (content.length > 1000) {
        const head = content.slice(0, 400);
        const tail = content.slice(-300);
        content = head + "\n...(中间内容已省略)...\n" + tail;
      }
    }

    if (totalLen + content.length > budget) break;
    totalLen += content.length;
    result.unshift({ role: msg.role, content });
  }

  return result;
}

/**
 * 检查并触发对话摘要生成
 * 当未摘要的消息数超过阈值时，用 LLM 生成摘要
 */
export async function maybeGenerateSummary(sessionId, runLLMFn) {
  const config = getConfig();
  if (!config.contextEnableSummary) return;

  const session = getChatSession(sessionId);
  if (!session) return;

  const summaryUpTo = session.summary_up_to || 0;
  const allMessages = getSessionMessages(sessionId, { limit: 200 });
  const unsummarized = allMessages.length - summaryUpTo;

  if (unsummarized < SUMMARY_TRIGGER_COUNT) return;

  // 需要摘要的消息
  const toSummarize = allMessages.slice(summaryUpTo);
  const existingSummary = session.context_summary || "";

  const summaryPrompt = buildSummaryPrompt(existingSummary, toSummarize);

  try {
    log("system", "info", "context", `生成对话摘要 (${unsummarized} 条新消息)`);
    const engine = config.decompositionEngine || "gemini";
    const summary = await runLLMFn(engine, summaryPrompt, "context-summary");

    // 保存摘要
    updateChatSession(sessionId, {
      context_summary: summary.trim(),
      summary_up_to: allMessages.length,
    });

    log("system", "info", "context", `对话摘要已更新 (${summary.length} 字)`);
  } catch (err) {
    log("system", "warn", "context", `摘要生成失败: ${err.message}`);
  }
}

function buildSummaryPrompt(existingSummary, messages) {
  let context = "";
  if (existingSummary) {
    context = `## 已有摘要\n${existingSummary}\n\n`;
  }

  let conversation = "## 新的对话内容\n\n";
  for (const msg of messages) {
    const label = msg.role === "user" ? "用户" : "AI";
    const content = (msg.content || "").slice(0, 500);
    conversation += `**${label}**: ${content}\n\n`;
  }

  return `你是对话摘要助手。请将以下对话浓缩为简洁的背景摘要，保留：
1. 用户的核心需求和目标
2. 已做出的关键决策
3. 重要的技术发现或结论
4. 待办事项或未解决的问题

摘要应在 200-400 字之间，使用要点列表格式。

${context}${conversation}

请直接输出摘要内容，不要其他文字。`;
}
