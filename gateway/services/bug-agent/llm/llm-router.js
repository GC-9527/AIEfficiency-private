/**
 * 引擎路由层（与 AIEfficiency 工具的 defaultEngine 体系一致）
 *
 * 选择优先级：
 *   1. process.env.BUG_AGENT_ENGINE（开发/测试覆盖）
 *   2. config.json 的 defaultEngine
 *   3. fallback 到 "claude" CLI
 *
 * 三类引擎：
 *   - **API Key 引擎**（OpenAI 兼容，从 config.apiEngines 读）
 *       qwen / kimi / deepseek / openai / 任何用户配置的 OpenAI 兼容 endpoint
 *   - **Anthropic 直连**（保留 v3.3 实现）
 *       engine="anthropic"，从 process.env.ANTHROPIC_API_KEY 或
 *       config.anthropic.apiKey 读
 *   - **CLI 引擎**（spawn 子进程）
 *       claude / gemini / codex / hermes
 *
 * 统一返回 { text: string, usage: { input_tokens?, output_tokens? }, raw: any }
 * 失败抛出 { code: "TIMEOUT"|"RATE_LIMIT"|"UPSTREAM_5XX"|"NETWORK"|
 *            "HTTP_ERROR"|"NO_API_KEY"|"CLI_NOT_FOUND"|"CLI_ERROR"|
 *            "CLI_NONZERO"|"UNKNOWN_ENGINE" }
 */

import { spawn } from "node:child_process";
import { existsSync, writeFileSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { callAnthropic } from "./anthropic-client.js";
import { ensureExternalTempDirectory } from "../../external-temp.js";
import { buildHermesOneshotArgs, hermesExecutable, isHermesEngine } from "../../hermes-cli.js";

const CLI_ENGINES = new Set(["claude", "gemini", "codex", "hermes"]);
const DEFAULT_TIMEOUT_MS = 30000;
const DEFAULT_CLI_TIMEOUT_MS = 90000;

/**
 * 主入口。签名与 callAnthropic 保持兼容，使 safe-call 无缝切换。
 *
 * @param {Object} opts
 * @param {string} opts.system
 * @param {Array<{role,content}>} opts.messages
 * @param {number} [opts.max_tokens]
 * @param {number} [opts.timeout_ms]
 * @param {Object} [opts._deps]  - { getConfig, fetch, spawn, callAnthropic }
 * @returns {Promise<{ text, usage, raw }>}
 */
export async function callConfiguredLlm(opts) {
  const { system, messages, max_tokens = 2048, timeout_ms, _deps = {} } = opts || {};
  if (!system || !Array.isArray(messages)) {
    const err = new Error("invalid prompt payload");
    err.code = "BAD_PAYLOAD";
    throw err;
  }

  const getCfg = _deps.getConfig || (await loadGetConfig());
  const config = getCfg();
  const engine = process.env.BUG_AGENT_ENGINE || config.defaultEngine || "claude";

  // 1. API Key 引擎（OpenAI 兼容）
  const apiCfg = config.apiEngines?.[engine];
  if (apiCfg && apiCfg.enabled && apiCfg.apiKey) {
    return callOpenAiCompat({
      engine,
      cfg: apiCfg,
      system,
      messages,
      max_tokens,
      timeout_ms: timeout_ms || DEFAULT_TIMEOUT_MS,
      _fetch: _deps.fetch || globalThis.fetch,
    });
  }

  // 2. Anthropic 直连（特殊命名 / 显式选择）
  if (engine === "anthropic" || engine === "claude-api") {
    const fn = _deps.callAnthropic || callAnthropic;
    const apiKeyOverride = config.anthropic?.apiKey;
    return fn({
      system, messages, max_tokens, timeout_ms,
      api_key: apiKeyOverride || undefined, // undefined 让 anthropic-client 读 env
      _fetch: _deps.fetch,
    });
  }

  // 3. CLI 引擎
  if (CLI_ENGINES.has(engine)) {
    return callViaCli({
      engine,
      system,
      messages,
      timeout_ms: timeout_ms || DEFAULT_CLI_TIMEOUT_MS,
      _spawn: _deps.spawn || spawn,
    });
  }

  const err = new Error(`unknown engine: ${engine}`);
  err.code = "UNKNOWN_ENGINE";
  throw err;
}

// 懒加载 getConfig 避免循环依赖
async function loadGetConfig() {
  const mod = await import("../../config.js");
  return mod.getConfig;
}

// ---------- OpenAI 兼容 API ----------

async function callOpenAiCompat({ engine, cfg, system, messages, max_tokens, timeout_ms, _fetch }) {
  const url = `${cfg.baseUrl.replace(/\/+$/, "")}/chat/completions`;
  const body = {
    model: cfg.model,
    messages: [{ role: "system", content: system }, ...messages],
    max_tokens,
    temperature: 0,
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout_ms);

  let resp;
  try {
    resp = await _fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${cfg.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (e) {
    clearTimeout(timer);
    if (e && e.name === "AbortError") {
      const err = new Error(`${engine} timed out`); err.code = "TIMEOUT"; throw err;
    }
    const err = new Error(`${engine} fetch failed: ${e.message}`);
    err.code = "NETWORK"; err.cause = e; throw err;
  }
  clearTimeout(timer);

  if (resp.status === 429) {
    const err = new Error("rate limited (429)"); err.code = "RATE_LIMIT"; err.status = 429; throw err;
  }
  if (resp.status >= 500) {
    const err = new Error(`upstream ${resp.status}`); err.code = "UPSTREAM_5XX"; err.status = resp.status; throw err;
  }
  if (!resp.ok) {
    let body = ""; try { body = await resp.text(); } catch {}
    const err = new Error(`HTTP ${resp.status}: ${body.slice(0, 500)}`);
    err.code = "HTTP_ERROR"; err.status = resp.status; throw err;
  }

  const json = await resp.json();
  const choice = json.choices?.[0];
  const text = choice?.message?.content || "";
  return {
    text,
    usage: {
      input_tokens: json.usage?.prompt_tokens,
      output_tokens: json.usage?.completion_tokens,
    },
    raw: json,
  };
}

// ---------- CLI 引擎 ----------

/**
 * 用 spawn 调本地 CLI（claude/gemini/codex/hermes）。Hermes 通过受控临时文件引用传 prompt，
 * 其余 CLI 通过 stdin 传 prompt；
 * 期望 LLM 直接输出纯文本（含 JSON 代码块）。
 */
function callViaCli({ engine, system, messages, timeout_ms, _spawn }) {
  let command, args;

  if (engine === "claude") {
    command = "claude";
    // 用 "text" 输出格式（非 stream-json），让 stdout 直接是 LLM 文本
    args = ["-p", "--output-format", "text", "--dangerously-skip-permissions"];
  } else if (engine === "gemini") {
    command = "gemini";
    args = ["--yolo"];
  } else if (engine === "codex") {
    command = "codex";
    args = ["exec", "--skip-git-repo-check", "--dangerously-bypass-approvals-and-sandbox", "-"];
  } else if (isHermesEngine(engine)) {
    command = hermesExecutable();
    args = [];
  } else {
    return Promise.reject(Object.assign(new Error(`unknown CLI: ${engine}`), { code: "UNKNOWN_ENGINE" }));
  }

  // 把 system 和 user 拼成单条 prompt（CLI 不区分 role）
  const userText = messages.map((m) => m.content).join("\n\n");
  const promptText = `[SYSTEM INSTRUCTIONS]\n${system}\n\n[USER INPUT]\n${userText}`;

  const cwd = existsSync(homedir()) ? homedir() : process.cwd();
  let promptFile = "";
  if (isHermesEngine(engine)) {
    // ensureExternalTempDirectory 已强制与 AIEfficiency 源码仓分离。
    // Bug Agent 的 CLI cwd 固定为用户主目录，而 Windows 的系统临时目录通常也位于主目录；
    // 因此不能再把 cwd 当作源码根校验，否则所有 Windows Hermes 调用都会在 spawn 前失败。
    const directory = ensureExternalTempDirectory(["aiefficiency", "hermes-prompts"]);
    promptFile = join(directory, `bug-agent-${randomUUID()}.txt`);
    writeFileSync(promptFile, promptText, { encoding: "utf8", flag: "wx", mode: 0o600 });
    args = buildHermesOneshotArgs({ promptFile });
  }
  const cleanupPrompt = () => {
    if (!promptFile) return;
    try { unlinkSync(promptFile); } catch {}
  };

  return new Promise((resolve, reject) => {
    let proc;
    try {
      proc = _spawn(command, args, {
        cwd,
        shell: !isHermesEngine(engine),
        windowsHide: true,
        env: { ...process.env },
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (e) {
      cleanupPrompt();
      const err = new Error(`spawn failed: ${e.message}`); err.code = "CLI_ERROR"; return reject(err);
    }

    let stdout = "", stderr = "";
    let killed = false;

    const timer = setTimeout(() => {
      killed = true;
      try { proc.kill("SIGTERM"); } catch {}
      setTimeout(() => { try { proc.kill("SIGKILL"); } catch {} }, 2000);
      cleanupPrompt();
      const err = new Error(`${engine} CLI timed out after ${timeout_ms}ms`);
      err.code = "TIMEOUT"; err.timeout_ms = timeout_ms;
      reject(err);
    }, timeout_ms);

    proc.on("error", (e) => {
      clearTimeout(timer);
      cleanupPrompt();
      const err = new Error(`spawn ${engine} failed: ${e.message}`);
      err.code = e.code === "ENOENT" ? "CLI_NOT_FOUND" : "CLI_ERROR";
      reject(err);
    });

    proc.stdout.on("data", (d) => { stdout += d.toString(); });
    proc.stderr.on("data", (d) => { stderr += d.toString(); });

    proc.on("close", (code) => {
      clearTimeout(timer);
      cleanupPrompt();
      if (killed) return; // timeout 已 reject
      if (code !== 0) {
        const err = new Error(`${engine} exit ${code}: ${stderr.slice(0, 500)}`);
        err.code = "CLI_NONZERO"; err.exit_code = code; err.stderr_head = stderr.slice(0, 500);
        return reject(err);
      }
      resolve({
        text: stdout.trim(),
        usage: {}, // CLI 一般无法精确返回 token 用量
        raw: { stdout, stderr, engine },
      });
    });

    // stdin 写 prompt
    try {
      proc.stdin.on("error", () => {}); // 忽略 EPIPE
      if (isHermesEngine(engine)) proc.stdin.end();
      else {
        const ok = proc.stdin.write(promptText);
        if (ok) proc.stdin.end();
        else proc.stdin.once("drain", () => proc.stdin.end());
      }
    } catch (_e) {
      // 子进程瞬间退出时 write 可能抛 —— close handler 会处理
    }
  });
}

// 内部测试导出
export const _internal = { callOpenAiCompat, callViaCli };
