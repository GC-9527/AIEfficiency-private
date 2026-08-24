/**
 * 中心 AI 文本代理（阶段0）：
 * 中心机对外提供「单轮文本任务」服务——远端把 prompt 发来，
 * 中心用配置的 AI 后端跑出文本、流式回传。只做非 agentic 文本任务（无工具）。
 * 带队列 + 最大并发，避免一个账号被并发打到限流。
 */
import { spawn } from "child_process";
import os from "os";
import { getConfig } from "./config.js";
import { log } from "./logger.js";
import { normalizeCodexJsonEvent } from "./codex-json-stream.js";

// ===== 简易并发信号量（队列）=====
let active = 0;
const waiters = [];
function acquire(max) {
  if (active < max) { active++; return Promise.resolve(); }
  return new Promise((res) => waiters.push(res));
}
function release() {
  active = Math.max(0, active - 1);
  const w = waiters.shift();
  if (w) { active++; w(); }
}

function selectedApiEngine(cfg = {}) {
  const root = getConfig();
  const id = String(cfg.apiEngineId || "openai").trim();
  const engine = root.apiEngines?.[id] || null;
  return { id, engine };
}

// 生效后端：订阅 CLI 直接生效；API Key 后端缺 key 时回落 Claude CLI，避免服务不可用。
function effectiveBackend(cfg) {
  const backend = String(cfg.backend || "cli").trim();
  if (backend === "codex") return "codex";
  if (backend === "api") return String(cfg.anthropicApiKey || "").trim() ? "api" : "cli";
  if (backend === "api-engine") {
    const { engine } = selectedApiEngine(cfg);
    return engine?.enabled && String(engine.apiKey || "").trim() ? "api-engine" : "cli";
  }
  return "cli";
}

// ===== 今日 Claude 用量统计（算力的一部分：剩余用量）=====
let usage = { day: "", input: 0, output: 0 };
function today() { return new Date().toISOString().slice(0, 10); }
export function recordUsage(u) {
  const d = today();
  if (usage.day !== d) usage = { day: d, input: 0, output: 0 };
  usage.input += u?.inputTokens || 0;
  usage.output += u?.outputTokens || 0;
}

export function proxyHealth() {
  const cfg = getConfig().claudeProxy || {};
  const backend = effectiveBackend(cfg);
  const apiEngine = selectedApiEngine(cfg);
  const usedToday = (usage.day === today()) ? usage.input + usage.output : 0;
  const budget = Math.max(0, parseInt(cfg.dailyTokenBudget) || 0);
  const remaining = budget > 0 ? Math.max(0, budget - usedToday) : null; // null = 不限
  return {
    ok: !!cfg.enabled, busy: active, queueLen: waiters.length, maxConcurrent: cfg.maxConcurrent || 3,
    backend,                                   // 实际生效的后端
    configuredBackend: cfg.backend || "cli",   // 用户所选（API Key 缺失时会回落 cli）
    apiEngineId: apiEngine.id,
    apiKeyConfigured: cfg.backend === "api-engine"
      ? !!String(apiEngine.engine?.apiKey || "").trim()
      : !!String(cfg.anthropicApiKey || "").trim(),
    tokensUsedToday: usedToday, tokenBudget: budget, tokensRemaining: remaining,
    quotaExhausted: budget > 0 && remaining <= 0,  // 额度用尽
  };
}

/**
 * 跑一次单轮文本任务。onChunk(deltaText) 流式回调。返回 { ok, text, usage } 或 { ok:false, error }。
 * 后端：Claude CLI 订阅、Codex CLI 订阅、Anthropic API Key、OpenAI 兼容 API Key。
 */
export async function runClaudeText({ prompt, system, onChunk, signal } = {}) {
  if (!prompt || !String(prompt).trim()) return { ok: false, error: "缺少 prompt" };
  const cfg = getConfig().claudeProxy || {};
  const max = Math.max(1, cfg.maxConcurrent || 3);
  await acquire(max);
  try {
    const backend = effectiveBackend(cfg);
    const r = backend === "api"
      ? await runViaAnthropicApi({ prompt, system, onChunk, signal, cfg })
      : backend === "api-engine"
        ? await runViaApiEngine({ prompt, system, onChunk, signal, cfg })
        : backend === "codex"
          ? await runViaCodexCli({ prompt, system, onChunk, signal })
          : await runViaClaudeCli({ prompt, system, onChunk, signal });
    if (r?.ok && r.usage) recordUsage(r.usage); // 计入今日用量
    return r;
  } finally {
    release();
  }
}

// 真 agentic 本机 Claude CLI：在指定工程目录(cwd)内运行，可读/改文件、Read 截图(原生视觉)。
// 用于「在此开发」：cwd=工程根 + --add-dir(工程根/截图目录)，无需 API Key 即有视觉。
export function runClaudeAgentic({ prompt, cwd, addDirs = [], system, onChunk, signal } = {}) {
  return runViaClaudeCli({ prompt, system, onChunk, signal, cwd, addDirs });
}

// ===== 后端1：本机 Claude CLI（订阅，默认）=====
function runViaClaudeCli({ prompt, system, onChunk, signal, cwd, addDirs = [] }) {
    return new Promise((resolve) => {
      // -p 非交互 + stream-json 流式；--dangerously-skip-permissions 因无终端无法弹授权。
      // 纯文本任务：cwd 用临时目录、不带 --add-dir；agentic 任务(在此开发)：cwd=工程根 + --add-dir。
      const args = ["-p", "--output-format", "stream-json", "--verbose", "--dangerously-skip-permissions"];
      const textOnly = !cwd && (!Array.isArray(addDirs) || addDirs.length === 0);
      if (textOnly) args.push("--tools=");
      for (const d of addDirs) { if (d) { args.push("--add-dir", String(d)); } }
      if (system && String(system).trim()) args.push("--append-system-prompt", String(system));
      let proc;
      try {
        proc = spawn("claude", args, { cwd: cwd || os.tmpdir(), shell: true, windowsHide: true, env: { ...process.env }, stdio: ["pipe", "pipe", "pipe"] });
      } catch (e) { return resolve({ ok: false, error: e.message }); }

      let buf = "", text = "", usage = null, textBlocks = 0, stderr = "";
      let settled = false;
      const finish = (r) => { if (!settled) { settled = true; resolve(r); } };
      const onAbort = () => { try { proc.kill("SIGKILL"); } catch {} finish({ ok: false, error: "已取消" }); };
      if (signal) { if (signal.aborted) return finish({ ok: false, error: "已取消" }); signal.addEventListener("abort", onAbort, { once: true }); }

      try { proc.stdin.write(String(prompt)); proc.stdin.end(); } catch {}
      proc.stdin.on("error", () => {});

      proc.stdout.on("data", (d) => {
        buf += d.toString();
        const lines = buf.split("\n"); buf = lines.pop();
        for (const line of lines) {
          const t = line.trim(); if (!t) continue;
          let ev; try { ev = JSON.parse(t); } catch { continue; }
          if (ev.type === "assistant" && ev.message?.content) {
            for (const b of ev.message.content) {
              if (b.type === "text" && b.text) { textBlocks++; text += (text ? "\n\n" : "") + b.text; try { onChunk?.(b.text); } catch {} }
            }
          } else if (ev.type === "result") {
            if (ev.result && textBlocks <= 1) text = ev.result;
            if (ev.usage) usage = { inputTokens: ev.usage.input_tokens || 0, outputTokens: ev.usage.output_tokens || 0, cacheReadTokens: ev.usage.cache_read_input_tokens || 0, costUsd: ev.total_cost_usd || null };
          }
        }
      });
      proc.stderr.on("data", (d) => { stderr += d.toString(); if (stderr.length > 6000) stderr = stderr.slice(-3000); });
      proc.on("error", (e) => finish({ ok: false, error: e.message }));
      proc.on("close", (code) => {
        if (signal) try { signal.removeEventListener("abort", onAbort); } catch {}
        if (text || code === 0) finish({ ok: true, text, usage });
        else finish({ ok: false, error: (stderr || `claude 退出码 ${code}`).trim().slice(-400) });
      });
    });
}

// ===== 后端2：本机 Codex CLI（订阅）=====
function runViaCodexCli({ prompt, system, onChunk, signal } = {}) {
  return new Promise((resolve) => {
    const args = ["exec", "--skip-git-repo-check", "--json", "-"];
    let proc;
    try {
      proc = spawn("codex", args, { cwd: os.tmpdir(), shell: true, windowsHide: true, env: { ...process.env }, stdio: ["pipe", "pipe", "pipe"] });
    } catch (e) { return resolve({ ok: false, error: e.message }); }

    let buf = "", text = "", finalText = "", stderr = "", usage = null;
    let settled = false;
    const finish = (r) => { if (!settled) { settled = true; resolve(r); } };
    const onAbort = () => { try { proc.kill("SIGKILL"); } catch {} finish({ ok: false, error: "已取消" }); };
    if (signal) { if (signal.aborted) return finish({ ok: false, error: "已取消" }); signal.addEventListener("abort", onAbort, { once: true }); }

    const input = [
      system && String(system).trim() ? `# System\n${system}` : "",
      "只做文本推理和回答，不要执行命令、不要修改文件。",
      String(prompt),
    ].filter(Boolean).join("\n\n");
    try { proc.stdin.write(input); proc.stdin.end(); } catch {}
    proc.stdin.on("error", () => {});

    proc.stdout.on("data", (d) => {
      buf += d.toString();
      const lines = buf.split("\n"); buf = lines.pop();
      for (const line of lines) {
        const t = line.trim(); if (!t) continue;
        let ev; try { ev = JSON.parse(t); } catch { continue; }
        const normalized = normalizeCodexJsonEvent(ev);
        if (normalized.usage) usage = normalized.usage;
        for (const chunk of normalized.text) {
          text += chunk;
          try { onChunk?.(chunk); } catch {}
        }
        if (normalized.finalText) finalText = normalized.finalText;
      }
    });
    proc.stderr.on("data", (d) => { stderr += d.toString(); if (stderr.length > 6000) stderr = stderr.slice(-3000); });
    proc.on("error", (e) => finish({ ok: false, error: e.message }));
    proc.on("close", (code) => {
      if (signal) try { signal.removeEventListener("abort", onAbort); } catch {}
      const out = finalText || text;
      if (out || code === 0) finish({ ok: true, text: out, usage });
      else finish({ ok: false, error: (stderr || `codex 退出码 ${code}`).trim().slice(-400) });
    });
  });
}

// ===== 视觉分析：用 Anthropic API（带图片块）对截图做一次分析，返回文本描述 =====
// 用于「在此开发」把页面截图作为视觉输入。需配 claudeProxy.anthropicApiKey（视觉走 API，CLI 文本通道无视觉）。
export async function analyzeImage({ base64, mediaType = "image/png", prompt, signal } = {}) {
  const cfg = getConfig().claudeProxy || {};
  const apiKey = String(cfg.anthropicApiKey || "").trim();
  if (!apiKey) return { ok: false, error: "未配置 Anthropic API Key（设置→AI 模式配置→代理后端选 Anthropic API 并填 Key），无法做截图视觉分析" };
  if (!base64) return { ok: false, error: "无截图" };
  const model = String(cfg.anthropicModel || "claude-sonnet-4-6").trim();
  const baseUrl = String(cfg.anthropicBaseUrl || "https://api.anthropic.com").replace(/\/+$/, "");
  const body = {
    model, max_tokens: 1024,
    messages: [{ role: "user", content: [
      { type: "image", source: { type: "base64", media_type: mediaType, data: base64 } },
      { type: "text", text: prompt || "请描述这张界面截图。" },
    ] }],
  };
  try {
    const resp = await fetch(`${baseUrl}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
      body: JSON.stringify(body), signal,
    });
    if (!resp.ok) { let m = `HTTP ${resp.status}`; try { const j = await resp.json(); m = j.error?.message || m; } catch {} return { ok: false, error: "视觉分析失败：" + m }; }
    const j = await resp.json();
    const text = (j.content || []).filter((c) => c.type === "text").map((c) => c.text).join("\n").trim();
    if (j.usage) recordUsage({ inputTokens: j.usage.input_tokens || 0, outputTokens: j.usage.output_tokens || 0 });
    return { ok: true, text };
  } catch (e) { return { ok: false, error: (e.name === "AbortError" ? "已取消" : e.message) }; }
}

// ===== 后端3：Anthropic API Key =====
async function runViaAnthropicApi({ prompt, system, onChunk, signal, cfg }) {
  const apiKey = String(cfg.anthropicApiKey || "").trim();
  const model = String(cfg.anthropicModel || "claude-sonnet-4-6").trim();
  const baseUrl = String(cfg.anthropicBaseUrl || "https://api.anthropic.com").replace(/\/+$/, "");
  const maxTokens = Math.max(256, parseInt(cfg.anthropicMaxTokens) || 4096);
  const body = {
    model, max_tokens: maxTokens, stream: true,
    messages: [{ role: "user", content: String(prompt) }],
  };
  if (system && String(system).trim()) body.system = String(system);

  let resp;
  try {
    resp = await fetch(`${baseUrl}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
      body: JSON.stringify(body),
      signal,
    });
  } catch (e) { return { ok: false, error: (e.name === "AbortError" ? "已取消" : e.message) }; }

  if (!resp.ok || !resp.body) {
    let msg = `HTTP ${resp.status}`;
    try { const j = await resp.json(); msg = j.error?.message || msg; } catch {}
    return { ok: false, error: `Anthropic API 失败: ${msg}` };
  }

  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buf = "", text = "", usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, costUsd: null };
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split("\n"); buf = lines.pop();
      for (const line of lines) {
        const t = line.trim();
        if (!t.startsWith("data:")) continue;
        const payload = t.slice(5).trim();
        if (!payload || payload === "[DONE]") continue;
        let ev; try { ev = JSON.parse(payload); } catch { continue; }
        if (ev.type === "content_block_delta" && ev.delta?.type === "text_delta" && ev.delta.text) {
          text += ev.delta.text; try { onChunk?.(ev.delta.text); } catch {}
        } else if (ev.type === "message_start" && ev.message?.usage) {
          usage.inputTokens = ev.message.usage.input_tokens || 0;
          usage.cacheReadTokens = ev.message.usage.cache_read_input_tokens || 0;
        } else if (ev.type === "message_delta" && ev.usage) {
          usage.outputTokens = ev.usage.output_tokens || usage.outputTokens;
        }
      }
    }
  } catch (e) {
    if (e.name === "AbortError") return { ok: false, error: "已取消" };
    return { ok: false, error: e.message };
  }
  return { ok: true, text, usage };
}

// ===== 后端4：OpenAI 兼容 API Key（复用设置页 API 引擎）=====
async function runViaApiEngine({ prompt, system, onChunk, signal, cfg }) {
  const { id, engine } = selectedApiEngine(cfg);
  const apiKey = String(engine?.apiKey || "").trim();
  if (!engine?.enabled || !apiKey) return { ok: false, error: `API 引擎 ${id} 未启用或未配置 API Key` };
  const baseUrl = String(engine.baseUrl || "").replace(/\/+$/, "");
  const model = String(engine.model || "").trim();
  if (!baseUrl || !model) return { ok: false, error: `API 引擎 ${id} 缺少 Base URL 或模型` };
  const makeBody = (includeUsage = true) => ({
    model,
    stream: true,
    messages: [
      ...(system && String(system).trim() ? [{ role: "system", content: String(system) }] : []),
      { role: "user", content: String(prompt) },
    ],
    ...(includeUsage ? { stream_options: { include_usage: true } } : {}),
  });
  let resp;
  let body = makeBody(true);
  try {
    resp = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body),
      signal,
    });
  } catch (e) { return { ok: false, error: (e.name === "AbortError" ? "已取消" : e.message) }; }

  if (!resp.ok || !resp.body) {
    let msg = `HTTP ${resp.status}`;
    try { const j = await resp.json(); msg = j.error?.message || j.message || msg; } catch {}
    if (/stream_options|include_usage|unsupported|unknown parameter|extra fields/i.test(msg)) {
      body = makeBody(false);
      try {
        resp = await fetch(`${baseUrl}/chat/completions`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
          body: JSON.stringify(body),
          signal,
        });
      } catch (e) { return { ok: false, error: (e.name === "AbortError" ? "已取消" : e.message) }; }
      if (resp.ok && resp.body) {
        msg = "";
      } else {
        try { const j = await resp.json(); msg = j.error?.message || j.message || `HTTP ${resp.status}`; } catch { msg = `HTTP ${resp.status}`; }
      }
    }
    if (msg) return { ok: false, error: `API 引擎 ${id} 调用失败: ${msg}` };
  }

  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buf = "", text = "", usage = null;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split("\n"); buf = lines.pop();
      for (const line of lines) {
        const t = line.trim();
        if (!t.startsWith("data:")) continue;
        const payload = t.slice(5).trim();
        if (!payload || payload === "[DONE]") continue;
        let ev; try { ev = JSON.parse(payload); } catch { continue; }
        const delta = ev.choices?.[0]?.delta || {};
        const chunk = delta.content || delta.reasoning_content || "";
        if (chunk) { text += chunk; try { onChunk?.(chunk); } catch {} }
        if (ev.usage) usage = {
          inputTokens: ev.usage.prompt_tokens || ev.usage.input_tokens || 0,
          outputTokens: ev.usage.completion_tokens || ev.usage.output_tokens || 0,
          cacheReadTokens: ev.usage.prompt_cache_hit_tokens || 0,
          costUsd: null,
        };
      }
    }
  } catch (e) {
    if (e.name === "AbortError") return { ok: false, error: "已取消" };
    return { ok: false, error: e.message };
  }
  return { ok: true, text, usage };
}
