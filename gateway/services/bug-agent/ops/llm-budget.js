/**
 * LLM 日预算 + 熔断（方案 §11.5）
 *
 * 每次 LLM 调用前后：
 *   - 前：checkBudget() → 超限进降级
 *   - 后：recordLlmCost() 写 llm_cost_daily
 *
 * Haiku 4.5 定价：$0.80/M in, $4/M out
 */

const PRICE_IN_PER_M_TOKENS = 0.80;
const PRICE_OUT_PER_M_TOKENS = 4.00;

function todayUtc(now = Date.now()) {
  return new Date(now).toISOString().slice(0, 10);
}

export function computeCostUsd(tokens_in, tokens_out) {
  return (tokens_in / 1_000_000) * PRICE_IN_PER_M_TOKENS
       + (tokens_out / 1_000_000) * PRICE_OUT_PER_M_TOKENS;
}

/**
 * 查当日已用预算。返回 { usd, budget, remaining, over_limit }。
 */
export function checkBudget(storage, { budget_usd, now } = {}) {
  const b = budget_usd ?? Number(process.env.BUG_AGENT_DAILY_BUDGET_USD) ?? 10;
  const today = todayUtc(now);
  const common = storage.openCommon();
  const row = common.prepare("SELECT usd FROM llm_cost_daily WHERE date = ?").get(today);
  const used = row ? Number(row.usd) : 0;
  return {
    usd: used,
    budget: b,
    remaining: Math.max(0, b - used),
    over_limit: used >= b,
  };
}

/**
 * 记录一次 LLM 调用的 token 消耗。
 */
export function recordLlmCost(storage, { tokens_in = 0, tokens_out = 0, degraded = false, now } = {}) {
  const today = todayUtc(now);
  const usd = computeCostUsd(tokens_in, tokens_out);
  const common = storage.openCommon();
  common
    .prepare(
      `INSERT INTO llm_cost_daily (date, tokens_in, tokens_out, usd, degraded_count)
       VALUES (@date, @tokens_in, @tokens_out, @usd, @degraded_count)
       ON CONFLICT(date) DO UPDATE SET
         tokens_in = tokens_in + excluded.tokens_in,
         tokens_out = tokens_out + excluded.tokens_out,
         usd = usd + excluded.usd,
         degraded_count = degraded_count + excluded.degraded_count`
    )
    .run({
      date: today,
      tokens_in,
      tokens_out,
      usd,
      degraded_count: degraded ? 1 : 0,
    });
  return { today, incremental_usd: usd };
}

/**
 * 返回近 N 天的成本曲线（dashboard 用）
 */
export function listRecentCost(storage, days = 30) {
  const common = storage.openCommon();
  return common.prepare(
    "SELECT * FROM llm_cost_daily ORDER BY date DESC LIMIT ?"
  ).all(days);
}
