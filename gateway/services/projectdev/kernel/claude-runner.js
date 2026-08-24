/**
 * Claude CLI 驱动 —— 自包含、零 gateway 依赖（可整目录拷走）。
 *
 * 跑一轮 claude（stream-json），解析事件流，追踪 cost / turns / 写操作 / 限流 / 过载 / sessionId。
 * 对照 Python claude_runner.py 的 ClaudeRunner.run + ClaudeRunResult。
 *
 * 返回 ClaudeRunResult:
 *   { rc, costUsd, turns, writesOrEdits, rateLimited, rateLimitResetAt, transientOverload, sessionId, finalText }
 */
import { spawn } from "node:child_process";

const WRITE_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);
const DEFAULT_ALLOWED_TOOLS = "Edit,Write,Read,Grep,Glob,Bash";
const IDLE_KILL_MS = 5 * 60 * 1000; // 5 分钟无 stdout 视为卡死，杀进程（对照 Python 300s watchdog）

/**
 * @param {object} opts
 *  - cwd            目标工程目录
 *  - prompt         本轮完整 prompt（vision + 里程碑指令 + 失败反馈）
 *  - engine         "claude"（预留其它）
 *  - cliSessionId   续接会话 id（省 token；可空）
 *  - maxTurns       单轮 --max-turns（可空）
 *  - allowedTools   工具白名单字符串（默认 Edit,Write,Read,Grep,Glob,Bash）
 *  - onEvent(evt)   流式回调：{type:'thinking'|'text'|'tool_use'|'usage'|'log', ...}
 *  - signal         AbortSignal（停止/暂停时中断）
 */
export function runClaude(opts) {
  const {
    cwd, prompt, engine = "claude", cliSessionId, maxTurns,
    allowedTools = DEFAULT_ALLOWED_TOOLS, onEvent = () => {}, signal,
  } = opts;

  return new Promise((resolve) => {
    const args = ["-p", "--output-format", "stream-json", "--verbose", "--dangerously-skip-permissions"];
    if (allowedTools) args.push("--allowedTools", allowedTools);
    if (cliSessionId) args.push("--resume", cliSessionId);
    if (maxTurns) args.push("--max-turns", String(maxTurns));

    const res = {
      rc: -1, costUsd: 0, turns: 0, writesOrEdits: 0,
      rateLimited: false, rateLimitResetAt: null, transientOverload: false,
      sessionId: cliSessionId || null, finalText: "",
    };

    let proc;
    try {
      proc = spawn(engine, args, { cwd, shell: true, windowsHide: true, stdio: ["pipe", "pipe", "pipe"], env: { ...process.env } });
    } catch (e) {
      res.rc = -1; res.finalText = `spawn 失败: ${e.message}`;
      onEvent({ type: "log", level: "error", message: res.finalText });
      return resolve(res);
    }

    let buf = "";
    let settled = false;
    let idleTimer = null;
    const resetIdle = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        onEvent({ type: "log", level: "warn", message: `5 分钟无输出，杀进程 pid=${proc.pid}` });
        try { proc.kill("SIGKILL"); } catch {}
      }, IDLE_KILL_MS);
    };

    const onAbort = () => { try { proc.kill("SIGKILL"); } catch {} };
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    }

    const finish = (rc) => {
      if (settled) return;
      settled = true;
      if (idleTimer) clearTimeout(idleTimer);
      if (signal) signal.removeEventListener?.("abort", onAbort);
      res.rc = rc;
      resolve(res);
    };

    proc.stdout.on("data", (d) => {
      resetIdle();
      buf += d.toString();
      const lines = buf.split("\n");
      buf = lines.pop();
      for (const line of lines) handleLine(line.trim(), res, onEvent);
    });
    proc.stderr.on("data", (d) => {
      const t = d.toString();
      if (t.trim()) onEvent({ type: "log", level: "stderr", message: t.slice(0, 2000) });
    });

    proc.on("error", (e) => { onEvent({ type: "log", level: "error", message: `进程错误: ${e.message}` }); finish(-1); });
    proc.on("close", (code) => {
      if (buf.trim()) handleLine(buf.trim(), res, onEvent);
      finish(code == null ? -1 : code);
    });

    // prompt 写入 stdin（daemon 式，避免大 prompt 管道死锁）
    try {
      proc.stdin.write(prompt, "utf8");
      proc.stdin.end();
    } catch (e) {
      onEvent({ type: "log", level: "error", message: `写 stdin 失败: ${e.message}` });
    }
    resetIdle();
  });
}

function handleLine(line, res, onEvent) {
  if (!line) return;
  let ev;
  try { ev = JSON.parse(line); } catch { return; } // 非 JSON 行忽略

  // 流式 assistant 内容
  if (ev.type === "assistant" && ev.message?.content) {
    for (const block of ev.message.content) {
      if (block.type === "thinking" && block.thinking) onEvent({ type: "thinking", text: block.thinking });
      else if (block.type === "text" && block.text) onEvent({ type: "text", text: block.text });
      else if (block.type === "tool_use") {
        if (WRITE_TOOLS.has(block.name)) res.writesOrEdits += 1;
        onEvent({ type: "tool_use", name: block.name, input: block.input });
      }
    }
    return;
  }

  // 终局 result：成本 / sessionId / 轮数 / 过载
  if (ev.type === "result") {
    if (typeof ev.total_cost_usd === "number") res.costUsd += ev.total_cost_usd;
    if (ev.session_id) res.sessionId = ev.session_id;
    if (typeof ev.num_turns === "number") res.turns = ev.num_turns;
    if (ev.usage) onEvent({ type: "usage", usage: normUsage(ev.usage), costUsd: ev.total_cost_usd || 0 });
    const finalText = typeof ev.result === "string" ? ev.result : "";
    res.finalText = finalText;
    if (/529\s*Overloaded|overloaded_error/i.test(finalText)) res.transientOverload = true;
    return;
  }

  // 限流事件（claude CLI 在被拒时给出 rate_limit 信息）
  if (ev.type === "rate_limit_event" || ev.rate_limit_info) {
    const info = ev.rate_limit_info || ev;
    res.rateLimited = true;
    const reset = info.resetsAt || info.resets_at;
    if (reset) res.rateLimitResetAt = typeof reset === "number" ? reset : Date.parse(reset) / 1000;
    onEvent({ type: "log", level: "warn", message: `限流，重置时间 ${res.rateLimitResetAt || "未知"}` });
    return;
  }

  if (ev.type === "system" && ev.session_id) res.sessionId = ev.session_id;
}

function normUsage(u) {
  return {
    inputTokens: u.input_tokens || 0,
    outputTokens: u.output_tokens || 0,
    cacheReadTokens: u.cache_read_input_tokens || 0,
    cacheCreationTokens: u.cache_creation_input_tokens || 0,
  };
}
