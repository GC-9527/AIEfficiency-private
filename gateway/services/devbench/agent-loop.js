/**
 * 分布式执行 —— 文本反思循环编排器（客户端侧）。
 * 服务端 AI 大脑(无状态,出脚本/动作) ←→ 本机 executor(执行) ←→ 网关编排(回灌)。
 * 会话历史由客户端持有；每轮把 任务+历史+上次结果 回放给 brain → brain 出下一个动作 → 本机执行 → 回灌。
 * brain 可注入（本机 runClaudeText 或转发到所选服务端），便于测试与多端切换。
 */
import path from "path";
import { runTool } from "../executor.js";
import { runClaudeText } from "../claude-proxy.js";
import { getConfig } from "../config.js";

const TOOLS = ["run_bash", "read_file", "write_file", "edit_file", "list_dir", "done"];
const TOOL_ALIASES = {
  bash: "run_bash",
  shell: "run_bash",
  command: "run_bash",
  run_command: "run_bash",
  read: "read_file",
  write: "write_file",
  edit: "edit_file",
  list: "list_dir",
  ls: "list_dir",
  finish: "done",
  final: "done",
};
export const ACTION_PROTOCOL = {
  read_file: { required: ["path"], optional: ["start_line", "line_count"], path: "relative" },
  list_dir: { optional: ["path"], path: "relative" },
  write_file: { required: ["path", "content"], path: "relative" },
  edit_file: { required: ["path", "old_string", "new_string"], path: "relative" },
  run_bash: { required: ["command"], optional: ["path", "timeout_seconds"], path: "relative cwd only" },
  done: { optional: ["summary"] },
};

// 解析单条 SSE 块
function parseSSE(block) {
  let event = "message", data = "";
  for (const l of block.split("\n")) {
    if (l.startsWith("event:")) event = l.slice(6).trim();
    else if (l.startsWith("data:")) data += l.slice(5).trim();
  }
  if (!data) return null;
  try { return { event, data: JSON.parse(data) }; } catch { return { event, data }; }
}

// 转发到服务端 claude-proxy /run（SSE），收集最终文本
export async function forwardBrain(host, token, prompt, signal = null) {
  const r = await fetch(String(host).replace(/\/+$/, "") + "/api/claude-proxy/run", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({ prompt, clientId: "agent-loop" }),
    signal: signal || undefined,
  });
  if (!r.ok || !r.body) { let m = `HTTP ${r.status}`; try { m = (await r.json()).error || m; } catch {} throw new Error(`服务端大脑不可用：${m}`); }
  const reader = r.body.getReader(); const dec = new TextDecoder();
  let buf = "", text = "", err = null;
  for (;;) {
    const { value, done } = await reader.read(); if (done) break;
    buf += dec.decode(value, { stream: true });
    const parts = buf.split("\n\n"); buf = parts.pop();
    for (const p of parts) {
      const ev = parseSSE(p); if (!ev) continue;
      if (ev.event === "chunk" && ev.data?.delta) text += ev.data.delta;
      else if (ev.event === "done") { if (ev.data?.text) text = ev.data.text; }
      else if (ev.event === "error") err = ev.data?.message || "大脑出错";
    }
  }
  if (err) throw new Error(err);
  return text;
}

// 默认 brain：配了远端服务端则转发，否则用本机 AI 代理（standalone/server 自身）
export function defaultBrain() {
  const cfg = getConfig();
  const role = String(process.env.ROLE || cfg.role || "standalone").toLowerCase();
  const cli = cfg.claudeProxyClient || {};
  if (role === "node" && cli.enabled && cli.host) return (prompt, opts = {}) => forwardBrain(cli.host, cli.token, prompt, opts.signal || null);
  return async (prompt, opts = {}) => { const r = await runClaudeText({ prompt, signal: opts.signal || null }); if (!r.ok) throw new Error(r.error); return r.text; };
}

function normalizeParsedAction(obj) {
  if (!obj || typeof obj !== "object") return null;
  if (Array.isArray(obj.tool_calls) && obj.tool_calls.length) {
    const fn = obj.tool_calls[0]?.function || obj.tool_calls[0];
    return normalizeParsedAction({ name: fn?.name, arguments: fn?.arguments });
  }
  if (obj.function && typeof obj.function === "object") {
    return normalizeParsedAction({ name: obj.function.name, arguments: obj.function.arguments });
  }
  let argBag = obj.args ?? obj.arguments ?? obj.input ?? obj.parameters ?? {};
  if (typeof argBag === "string") {
    try { argBag = JSON.parse(argBag); } catch { argBag = {}; }
  }
  const rawTool = String(obj.tool || obj.action || obj.name || "").trim();
  const tool = TOOL_ALIASES[rawTool] || rawTool;
  const merged = { ...(argBag && typeof argBag === "object" ? argBag : {}), ...obj, tool };
  delete merged.args; delete merged.arguments; delete merged.input; delete merged.parameters; delete merged.action; delete merged.name; delete merged.function; delete merged.tool_calls;
  if (tool === "run_bash" && !merged.command && merged.cmd) merged.command = merged.cmd;
  if (tool === "done" && !merged.summary && merged.message) merged.summary = merged.message;
  return TOOLS.includes(tool) ? merged : null;
}

// 从 brain 文本里解析单个动作 JSON（优先 ```json 围栏；否则首个平衡花括号）
export function parseAction(text) {
  if (!text) return null;
  const s = String(text);
  let jsonStr = null;
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) jsonStr = fence[1].trim();
  if (!jsonStr) {
    const i = s.indexOf("{");
    if (i >= 0) {
      let depth = 0;
      for (let j = i; j < s.length; j++) {
        if (s[j] === "{") depth++;
        else if (s[j] === "}") { depth--; if (depth === 0) { jsonStr = s.slice(i, j + 1); break; } }
      }
    }
  }
  if (!jsonStr) return null;
  let obj; try { obj = JSON.parse(jsonStr); } catch { return null; }
  return normalizeParsedAction(obj);
}

function isAbsoluteLike(p) {
  const v = String(p || "").trim();
  return path.isAbsolute(v) || path.win32.isAbsolute(v) || path.posix.isAbsolute(v) || /^[a-zA-Z]:[\\/]/.test(v) || /^\\\\/.test(v);
}

function normalizeRelPath(action, field, fallback, requireRelativePaths) {
  const raw = action[field] == null || action[field] === "" ? fallback : String(action[field]);
  if (raw == null || raw === "") throw new Error(`${action.tool}.${field} 不能为空`);
  if (raw.includes("\0")) throw new Error(`${action.tool}.${field} 含非法字符`);
  if (requireRelativePaths && isAbsoluteLike(raw)) throw new Error(`${action.tool}.${field} 必须是相对工程根的路径，不能使用绝对路径`);
  if (String(raw).split(/[\\/]+/).includes("..")) throw new Error(`${action.tool}.${field} 不能包含 .. 越界路径`);
  return String(raw).replace(/\\/g, "/");
}

/**
 * 把模型输出收敛到固定动作协议。返回值只保留执行器需要的字段，避免把 thought/tool 等杂项传给工具层。
 */
export function normalizeAction(action, { requireRelativePaths = true } = {}) {
  if (!action || !TOOLS.includes(action.tool)) return null;
  const thought = String(action.thought || "").slice(0, 300);
  if (action.tool === "done") return { tool: "done", thought, summary: String(action.summary || action.thought || "") };
  if (action.tool === "read_file") {
    return {
      tool: "read_file", thought,
      path: normalizeRelPath(action, "path", null, requireRelativePaths),
      ...(action.start_line != null ? { start_line: action.start_line } : {}),
      ...(action.line_count != null ? { line_count: action.line_count } : {}),
    };
  }
  if (action.tool === "list_dir") {
    return { tool: "list_dir", thought, path: normalizeRelPath(action, "path", ".", requireRelativePaths) };
  }
  if (action.tool === "write_file") {
    if (action.content == null) throw new Error("write_file.content 不能为空");
    return { tool: "write_file", thought, path: normalizeRelPath(action, "path", null, requireRelativePaths), content: String(action.content) };
  }
  if (action.tool === "edit_file") {
    if (!String(action.old_string || "")) throw new Error("edit_file.old_string 不能为空");
    return {
      tool: "edit_file", thought,
      path: normalizeRelPath(action, "path", null, requireRelativePaths),
      old_string: String(action.old_string),
      new_string: String(action.new_string ?? ""),
    };
  }
  if (action.tool === "run_bash") {
    if (!String(action.command || "").trim()) throw new Error("run_bash.command 不能为空");
    const out = { tool: "run_bash", thought, command: String(action.command), ...(action.timeout_seconds != null ? { timeout_seconds: action.timeout_seconds } : {}) };
    if (action.path != null && action.path !== "") out.path = normalizeRelPath(action, "path", ".", requireRelativePaths);
    return out;
  }
  return null;
}

// token 滚动摘要参数：保留最近 N 步全文，更早折叠成有上限的摘要
const KEEP_RECENT = 4;
const MAX_RESULT_IN_SUMMARY = 200; // 折叠时每步结果截断
const MAX_SUMMARY_CHARS = 4000;    // 摘要总长上限（超出截头部）
const MAX_RECENT_RESULT = 2000;    // 近窗每步结果截断

// 把"被挤出近窗"的步骤折叠进滚动摘要（不调用 LLM，纯本地压缩，省 token）
export function foldSummary(prevSummary, steps) {
  let s = prevSummary || "";
  for (const h of steps) {
    const tool = h.tool || (h.error ? "解析失败" : "?");
    const arg = JSON.stringify(h.args || {}).slice(0, 120);
    const res = String(h.result ?? "").replace(/\s+/g, " ").slice(0, MAX_RESULT_IN_SUMMARY);
    s += `\n- ${tool} ${arg} → ${h.ok === false ? "[失败] " : ""}${res}`;
  }
  s = s.trim();
  if (s.length > MAX_SUMMARY_CHARS) s = "…(更早步骤已省略)…\n" + s.slice(-MAX_SUMMARY_CHARS);
  return s;
}

// 构造回放 prompt（任务 + 滚动摘要 + 最近若干步全文）。控 token。
export function buildPrompt({ task, summary = "", recentSteps = [], root, hint = "" }) {
  const rules = [
    "你是「远程开发大脑」。代码在另一台机器(客户端)上，你只负责思考并产出【下一步动作】，由客户端执行后把结果回灌给你。",
    "每轮只输出【一个】JSON 动作，放在 ```json 围栏里，不要多余文字。",
    "可用 tool：run_bash(command)、read_file(path)、write_file(path,content)、edit_file(path,old_string,new_string)、list_dir(path)、done(summary)。",
    "path 必须是相对工程根的路径，不要使用盘符、绝对路径或 .. 越界路径。",
    "run_bash 默认在工程根执行；不要 cd 到工程外。文件修改优先用 edit_file/write_file，不要输出一整段不可审计的大脚本。",
    "完成或无需继续时输出 {\"tool\":\"done\",\"summary\":\"...\"}。",
    "每步先在 thought 字段写简短意图。",
  ].join("\n");
  const lines = [rules, "", `# 动作协议\n${JSON.stringify(ACTION_PROTOCOL, null, 2)}`, "", `# 任务\n${task}`, hint ? `\n# 提示\n${hint}` : "", `\n# 客户端本机工程根（只用于理解环境，不要原样写入 path）\n${root}`];
  if (summary) lines.push("\n# 较早步骤摘要\n" + summary);
  lines.push("\n# 最近步骤与结果");
  if (!summary && !recentSteps.length) lines.push("(还没有执行任何步骤)");
  for (const [i, h] of recentSteps.entries()) {
    const a = h.tool ? `${h.tool} ${JSON.stringify(h.args || {}).slice(0, 300)}` : (h.error || "");
    const r = String(h.result ?? "").slice(0, MAX_RECENT_RESULT);
    lines.push(`## ${a}\n结果: ${r || (h.ok === false ? "[失败]" : "(无输出)")}`);
  }
  lines.push("\n请给出下一步动作(JSON)。");
  return lines.join("\n");
}
function pick(h) { const { tool, thought, result, ok, exitCode, ...rest } = h; return rest; }

function abortResult(history = []) {
  return { ok: false, error: "用户手动终止", stopped: true, history };
}

function compactLine(value, limit = 220) {
  const s = String(value ?? "").replace(/\s+/g, " ").trim();
  return s.length > limit ? `${s.slice(0, limit)}...` : s;
}

export function summarizeReachedMax(history = [], maxRounds = 0) {
  const steps = Array.isArray(history) ? history : [];
  const lines = [
    `分布式执行已达到最大回合数${maxRounds ? `（${maxRounds} 轮）` : ""}，本轮已执行 ${steps.length} 个动作，但中心机尚未收到 done 结论。`,
    "请继续追问以接着完成，或在 AI 模式配置中提高最大回合数。",
  ];
  const recent = steps.slice(-3);
  if (recent.length) {
    lines.push("", "最近执行：");
    for (const step of recent) {
      const tool = step.tool || "动作";
      const args = compactLine(JSON.stringify(step.args || {}), 140);
      const result = compactLine(step.result, 220);
      const status = step.ok === false ? "失败" : "成功";
      lines.push(`- ${tool}${args && args !== "{}" ? ` ${args}` : ""}：${status}${result ? `；${result}` : ""}`);
    }
  }
  return lines.join("\n");
}

function isAbortLike(error, signal) {
  return signal?.aborted || error?.name === "AbortError" || /abort|aborted|用户手动终止/i.test(String(error?.message || ""));
}

/**
 * 跑反思循环。
 * @param root 工程根(executor 白名单内)
 * @param task 任务描述
 * @param callBrain async (prompt) => string  // 服务端 AI 文本调用
 * @param onStep 进度回调
 * @param maxRounds 安全上限
 * 返回 { ok, done, history, summary?, reachedMax? }
 */
export async function runAgentLoop({ root, task, callBrain, onStep, onAudit, maxRounds = 12, hint = "", runId = "", sessionId = "", requireRelativePaths, signal = null, runToolFn = null } = {}) {
  if (!root) return { ok: false, error: "缺少工程根" };
  if (typeof callBrain !== "function") return { ok: false, error: "缺少 brain 调用" };
  const distCfg = getConfig().distributedExecution || {};
  const shouldRequireRelativePaths = requireRelativePaths ?? (distCfg.requireRelativePaths !== false);
  const auditEnabled = distCfg.audit !== false;
  const execTool = typeof runToolFn === "function" ? runToolFn : runTool;
  const history = [];     // 全量（用于返回/前端）
  const recent = [];      // 近窗全文（用于 prompt）
  let summary = "";       // 滚动摘要（更早步骤压缩）
  const remember = (step) => {
    history.push(step); recent.push(step);
    if (recent.length > KEEP_RECENT) summary = foldSummary(summary, [recent.shift()]); // 挤出的折叠进摘要
  };
  for (let round = 1; round <= maxRounds; round++) {
    if (signal?.aborted) return abortResult(history);
    const prompt = buildPrompt({ task, summary, recentSteps: recent, root, hint });
    let brainText;
    try { brainText = await callBrain(prompt, { signal }); }
    catch (e) {
      if (isAbortLike(e, signal)) return abortResult(history);
      return { ok: false, error: `大脑调用失败：${e.message}`, history };
    }
    const parsed = parseAction(brainText);
    let action = null;
    let protocolError = "";
    try { action = normalizeAction(parsed, { requireRelativePaths: shouldRequireRelativePaths }); }
    catch (e) { protocolError = e.message; }
    onStep?.({ runId, sessionId, round, phase: "think", action: action || parsed, raw: brainText, error: protocolError || null });
    if (!action) {
      const step = { error: protocolError || "无法解析动作", result: String(brainText || "").slice(0, 300), ok: false };
      remember(step);
      onStep?.({ runId, sessionId, round, phase: "exec", step });
      continue;
    }
    if (action.tool === "done") return { ok: true, done: true, summary: action.summary || action.thought || "", history };
    const args = pick(action);
    const exec = await execTool(root, action.tool, args, { signal, round, runId, sessionId });
    if (signal?.aborted) return abortResult(history);
    const step = { tool: action.tool, args, thought: action.thought || "", result: exec.ok ? (exec.result ?? "") : `[错误] ${exec.error}`, ok: exec.ok, exitCode: exec.exitCode };
    remember(step);
    if (auditEnabled) {
      try { onAudit?.({ runId, sessionId, round, root, action, step, ok: exec.ok, error: exec.error || null }); } catch {}
    }
    onStep?.({ runId, sessionId, round, phase: "exec", step });
  }
  return { ok: false, done: false, reachedMax: true, summary: summarizeReachedMax(history, maxRounds), error: "达到最大回合数仍未收到 done 动作", history };
}
