/**
 * Anthropic Messages API 直连（方案 §5）
 *
 * 故意不用 @anthropic-ai/sdk，减少依赖。仅封装足够 safe_call 使用的能力：
 * - 超时（AbortController）
 * - 错误分类（timeout / rate_limit / http / other）
 *
 * Claude Haiku 4.5 作为默认分类模型（方案 §5 STEP 8 指定）。
 */

const DEFAULT_MODEL = "claude-haiku-4-5-20251001";
const DEFAULT_ENDPOINT = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";

/**
 * 调用 Anthropic Messages API。
 *
 * @param {Object} opts
 * @param {string} opts.system - system prompt
 * @param {Array<{role: string, content: string}>} opts.messages
 * @param {string} [opts.model]
 * @param {number} [opts.max_tokens]
 * @param {number} [opts.timeout_ms]
 * @param {string} [opts.api_key] - 若不传则读 process.env.ANTHROPIC_API_KEY
 * @param {typeof fetch} [opts._fetch] - 测试注入点
 * @returns {Promise<{ text: string, usage: object, raw: object }>}
 */
export async function callAnthropic(opts) {
  const {
    system,
    messages,
    model = DEFAULT_MODEL,
    max_tokens = 2048,
    timeout_ms = Number(process.env.BUG_AGENT_LLM_TIMEOUT_MS) || 30000,
    api_key = process.env.ANTHROPIC_API_KEY,
    _fetch = globalThis.fetch,
  } = opts || {};

  if (!api_key) {
    const err = new Error("ANTHROPIC_API_KEY missing");
    err.code = "NO_API_KEY";
    throw err;
  }
  if (!system || !Array.isArray(messages) || messages.length === 0) {
    const err = new Error("invalid prompt payload");
    err.code = "BAD_PAYLOAD";
    throw err;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout_ms);

  let resp;
  try {
    resp = await _fetch(DEFAULT_ENDPOINT, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": api_key,
        "anthropic-version": ANTHROPIC_VERSION,
      },
      body: JSON.stringify({ model, max_tokens, system, messages, temperature: 0 }),
      signal: controller.signal,
    });
  } catch (e) {
    clearTimeout(timer);
    if (e && e.name === "AbortError") {
      const err = new Error("LLM call timed out");
      err.code = "TIMEOUT";
      err.timeout_ms = timeout_ms;
      throw err;
    }
    const err = new Error(`LLM fetch failed: ${e.message}`);
    err.code = "NETWORK";
    err.cause = e;
    throw err;
  }
  clearTimeout(timer);

  const status = resp.status;

  if (status === 429) {
    const retryAfter = Number(resp.headers.get("retry-after")) || 0;
    const err = new Error("rate limited (429)");
    err.code = "RATE_LIMIT";
    err.status = 429;
    err.retry_after_s = retryAfter;
    throw err;
  }

  if (status >= 500) {
    const err = new Error(`upstream ${status}`);
    err.code = "UPSTREAM_5XX";
    err.status = status;
    throw err;
  }

  if (!resp.ok) {
    let body = "";
    try { body = await resp.text(); } catch { /* ignore */ }
    const err = new Error(`HTTP ${status}: ${body.slice(0, 500)}`);
    err.code = "HTTP_ERROR";
    err.status = status;
    throw err;
  }

  const json = await resp.json();
  const text = Array.isArray(json.content)
    ? json.content.filter((b) => b.type === "text").map((b) => b.text).join("")
    : "";

  return { text, usage: json.usage || {}, raw: json };
}
