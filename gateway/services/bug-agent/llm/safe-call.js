/**
 * LLM 失败闭环 + 降级模式（方案 §5.3 / §10.8）
 *
 * 负责把所有可能的失败路径收拢为 3 种结局：
 *  - { ok: true,  data, usage, attempts }                  —— LLM 成功
 *  - { ok: true,  data, degraded: true, reason, attempts } —— 规则降级
 *  - { ok: false, error_code, raw_output, attempts }       —— 彻底失败（task_state=failed）
 *
 * 调用方（STEP 7）只需关心这三种形态。
 */

import { callConfiguredLlm } from "./llm-router.js";
import { extractJson, validateClassification } from "./schema.js";

const MAX_RETRY = 2;
const RETRY_BASE_MS = 500;
const TRUNCATE_RAW_OUTPUT = 8 * 1024;

/**
 * 连续超时熔断：内存滚动计数，超阈值后短时间全进降级。
 */
const breaker = {
  streak: 0,
  open_until: 0,
  THRESHOLD: 10,
  OPEN_MS: 5 * 60 * 1000,
};

function breakerOpen() {
  return Date.now() < breaker.open_until;
}
function breakerRecordFailure() {
  breaker.streak++;
  if (breaker.streak >= breaker.THRESHOLD) {
    breaker.open_until = Date.now() + breaker.OPEN_MS;
    breaker.streak = 0;
  }
}
function breakerRecordSuccess() {
  breaker.streak = 0;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
function jitter() {
  return Math.floor(Math.random() * 250);
}
function truncate(s) {
  if (typeof s !== "string") return "";
  return s.length > TRUNCATE_RAW_OUTPUT ? s.slice(0, TRUNCATE_RAW_OUTPUT) + "...(truncated)" : s;
}

/**
 * 规则降级分类器。调用方传入已命中的 weak_hints；本函数基于硬编码兜底逻辑
 * 产出 confidence ≤ 0.5 的结果，符合方案 §5.3。
 */
function degradedClassify({ weak_hints = [], reason = "LLM_UNAVAILABLE" }) {
  // 选取 weak_hints 中优先级最高的条目（规则已按顺序排列）
  const hit = weak_hints.find((h) => h && h.target_category);
  if (hit) {
    return {
      category: hit.target_category,
      sub_category: hit.target_sub_category || "规则降级",
      confidence: Math.min(0.5, Number(hit.base_confidence ?? 0.5)),
      reasoning_steps: [
        {
          claim: `规则降级：命中 ${hit.id}（${hit.target_category}/${hit.target_sub_category}）`,
          evidence_refs: ["degraded:rule-hint"],
        },
      ],
      _degraded_reason: reason,
    };
  }
  return {
    category: "其他",
    sub_category: "待归类",
    confidence: 0.3,
    reasoning_steps: [
      {
        claim: "规则降级：无命中规则，标记为待人工复核",
        evidence_refs: ["degraded:no-hint"],
      },
    ],
    _degraded_reason: reason,
  };
}

/**
 * 安全调用 LLM 分类。
 *
 * @param {Object} params
 * @param {{ system: string, messages: Array }} params.prompt - prompt-builder 产出
 * @param {Array} [params.weak_hints] - 规则引擎的先验提示（降级时用）
 * @param {boolean} [params.allow_degrade=true] - 允许降级（某些场景如 E2E 测试要关闭）
 * @param {Object} [params._deps] - 注入测试替身 { callLlm } 或保留兼容字段 { callAnthropic }
 * @returns {Promise<{ ok: boolean, data?: object, degraded?: boolean, reason?: string,
 *                     error_code?: string, raw_output?: string, attempts: number, usage?: object }>}
 */
export async function safeCallLlm({ prompt, weak_hints = [], allow_degrade = true, _deps = {} }) {
  // 新名 callLlm，保留 callAnthropic 字段以兼容旧测试
  const call = _deps.callLlm || _deps.callAnthropic || callConfiguredLlm;

  // 熔断期：直接降级
  if (allow_degrade && breakerOpen()) {
    const fallback = degradedClassify({ weak_hints, reason: "BREAKER_OPEN" });
    return { ok: true, data: fallback, degraded: true, reason: "BREAKER_OPEN", attempts: 0 };
  }

  let lastRaw = "";
  let attempts = 0;

  for (; attempts <= MAX_RETRY; attempts++) {
    let resp;
    try {
      resp = await call({ system: prompt.system, messages: prompt.messages });
    } catch (e) {
      const code = e && e.code;

      // 429 / 超时 / 5xx 指数退避重试
      if (code === "RATE_LIMIT") {
        const wait = Math.max((e.retry_after_s || 0) * 1000, 2000 * 2 ** attempts + jitter());
        if (attempts < MAX_RETRY) { await sleep(wait); continue; }
        return finalizeFailure("LLM_RATE_LIMIT", lastRaw, attempts, weak_hints, allow_degrade);
      }
      if (code === "TIMEOUT") {
        breakerRecordFailure();
        if (attempts < MAX_RETRY) { await sleep(RETRY_BASE_MS * 2 ** attempts + jitter()); continue; }
        return finalizeFailure("LLM_TIMEOUT", lastRaw, attempts, weak_hints, allow_degrade);
      }
      if (code === "UPSTREAM_5XX" || code === "NETWORK") {
        if (attempts < MAX_RETRY) { await sleep(RETRY_BASE_MS * 2 ** attempts + jitter()); continue; }
        return finalizeFailure(code === "NETWORK" ? "LLM_NETWORK" : "LLM_UPSTREAM_5XX",
                               lastRaw, attempts, weak_hints, allow_degrade);
      }

      // 其他配置类错误（NO_API_KEY / BAD_PAYLOAD / HTTP_ERROR /
      // CLI_NOT_FOUND / CLI_NONZERO / CLI_ERROR / UNKNOWN_ENGINE）不重试
      return finalizeFailure(code || "LLM_UNKNOWN", lastRaw, attempts, weak_hints, allow_degrade);
    }

    // 拿到响应 → JSON 解析 + schema 校验（不重试，因为换次不会改好）
    lastRaw = resp.text || "";
    let parsed;
    try {
      parsed = extractJson(lastRaw);
    } catch (e) {
      return finalizeFailure("LLM_NON_JSON", lastRaw, attempts + 1, weak_hints, allow_degrade);
    }
    const check = validateClassification(parsed);
    if (!check.ok) {
      return finalizeFailure("LLM_SCHEMA_INVALID", lastRaw, attempts + 1, weak_hints, allow_degrade,
                             check.errors);
    }

    breakerRecordSuccess();
    return { ok: true, data: check.value, attempts: attempts + 1, usage: resp.usage };
  }

  return finalizeFailure("LLM_MAX_RETRY_EXCEEDED", lastRaw, attempts, weak_hints, allow_degrade);
}

function finalizeFailure(error_code, raw, attempts, weak_hints, allow_degrade, errors) {
  if (allow_degrade) {
    const fallback = degradedClassify({ weak_hints, reason: error_code });
    return {
      ok: true,
      data: fallback,
      degraded: true,
      reason: error_code,
      raw_output: truncate(raw),
      attempts,
      schema_errors: errors,
    };
  }
  return {
    ok: false,
    error_code,
    raw_output: truncate(raw),
    attempts,
    schema_errors: errors,
  };
}

// 测试用导出（切勿在业务代码里依赖）
export const _internal = { breaker, degradedClassify };
