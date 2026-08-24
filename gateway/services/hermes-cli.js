import fs from "node:fs";
import path from "node:path";

export const HERMES_ENGINE_ID = "hermes";
export const HERMES_DOCS_URL = "https://hermes-agent.nousresearch.com/docs/getting-started/quickstart";

export function isHermesEngine(engine) {
  const id = String(engine || "").trim().toLowerCase();
  return id === HERMES_ENGINE_ID || id === "hermes-atlas";
}

export function hermesExecutable(platform = process.platform, env = process.env) {
  const override = String(env.AIEFF_HERMES_EXECUTABLE || "").trim();
  if (override) return override;
  return platform === "win32" ? "hermes.exe" : "hermes";
}

/**
 * Hermes 的 --oneshot 参数直接接收 prompt。故事点 prompt 可能远超 Windows
 * CreateProcess 的命令行长度，因此这里只传递受控临时文件路径，让本地智能体
 * 自己读取完整请求。文件由调用方创建、持有并在进程结束后删除。
 */
export function hermesPromptReference(promptFile) {
  const file = path.resolve(String(promptFile || ""));
  return `Read the complete UTF-8 file at ${JSON.stringify(file)} before doing anything else. Treat its contents as the user's complete request, execute that request in the current working directory, and return only the final answer. Do not modify or delete this prompt file.`;
}

export function buildHermesOneshotArgs({ promptFile, usageFile = "", model = "" } = {}) {
  if (!promptFile) throw new Error("Hermes 缺少 prompt 临时文件");
  const args = ["--oneshot", hermesPromptReference(promptFile)];
  const selectedModel = String(model || "").trim();
  if (selectedModel) args.push("--model", selectedModel);
  if (usageFile) args.push("--usage-file", path.resolve(String(usageFile)));
  return args;
}

/**
 * 流式查询模式（hermes chat -q）：与 --oneshot 不同，该模式在非 TTY 管道下
 * 也会把工具进度行和正文逐句写到 stdout（实测 12s 长任务中 0.3~0.8s 一个 chunk），
 * 前端可实时展示；oneshot 会把 stdout 整体重定向到 devnull 直到进程结束才一次性
 * 输出最终答案，导致故事点看起来"卡住不动"。
 *
 * prompt 仍通过受控临时文件引用传入（chat 的 query 参数同样受 Windows 命令行
 * 长度上限约束）。chat 子命令不支持 --usage-file（仅顶层 oneshot 支持），用量
 * 由 stderr 的会话摘要兜底解析，缺失时按 null 降级，不影响流式展示。
 */
export function buildHermesChatArgs({ promptFile, model = "", maxTurns = 0 } = {}) {
  if (!promptFile) throw new Error("Hermes 缺少 prompt 临时文件");
  const args = ["chat", "-q", hermesPromptReference(promptFile)];
  const selectedModel = String(model || "").trim();
  if (selectedModel) args.push("--model", selectedModel);
  // 故事点修复任务工具调用多（编译/装机/日志检索可达数十轮），hermes 全局
  // agent.max_turns 默认 60 会在复杂任务上截断（回答框未闭合 → 最终报告只剩
  // 半句过程）。这里按任务场景放大预算，覆盖全局配置。
  const turns = Number(maxTurns);
  if (Number.isFinite(turns) && turns > 0) args.push("--max-turns", String(turns));
  return args;
}

export function normalizeHermesUsage(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const number = (value) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  };
  return {
    inputTokens: number(raw.input_tokens),
    outputTokens: number(raw.output_tokens),
    cacheReadTokens: number(raw.cache_read_tokens),
    cacheCreationTokens: number(raw.cache_write_tokens),
    reasoningTokens: number(raw.reasoning_tokens),
    totalTokens: number(raw.total_tokens),
    apiCalls: number(raw.api_calls),
    costUsd: raw.estimated_cost_usd == null ? null : number(raw.estimated_cost_usd),
    model: String(raw.model || "").trim(),
    provider: String(raw.provider || "").trim(),
    completed: raw.completed === true,
    failed: raw.failed === true,
  };
}

export function readHermesUsageFile(usageFile, io = fs) {
  if (!usageFile) return null;
  try {
    return normalizeHermesUsage(JSON.parse(io.readFileSync(usageFile, "utf8")));
  } catch {
    return null;
  }
}

export function hermesInstallGuide(platform = process.platform) {
  const command = platform === "win32"
    ? "iex (irm https://hermes-agent.nousresearch.com/install.ps1)"
    : "curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash";
  return {
    command,
    url: HERMES_DOCS_URL,
    manualOnly: true,
  };
}
