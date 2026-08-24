/**
 * 评分 → 规则/节点权重更新（方案 §8.2 / §8.3）
 *
 * 触发时机：
 *   - 同步：POST /api/bug/rate 成功后立即调用 updateOnRating()
 *   - 周期：每周 cron 调用 cronWeeklyNormalization() 做归一化 + 冷衰减
 */

const ALPHA = 0.2;
const RULE_SCORE_MIN = 0.1;
const RULE_SCORE_MAX = 5.0;

// Median Absolute Deviation 风格的离线参数（µ/σ 用于 rule_prior sigmoid）
// 初始值来自标注集；每月 cron 重算。这里用保守默认。
const RULE_PRIOR_MU_DEFAULT = 2.0;
const RULE_PRIOR_SIGMA_DEFAULT = 1.0;

function clamp(x, lo, hi) {
  return Math.max(lo, Math.min(hi, x));
}

function sigmoid(x) {
  return 1 / (1 + Math.exp(-x));
}

/**
 * 平滑更新单条规则的 rule_score。
 * rule_score ← (1-α)·rule_score + α·normalize(avg_rating · log(1+hit_count))
 */
export function smoothedRuleScore(current, avg_rating, hit_count) {
  const raw = avg_rating * Math.log(1 + Math.max(0, hit_count));
  // normalize：将 raw 映射到 [RULE_SCORE_MIN, RULE_SCORE_MAX]
  // raw 的典型范围 ~[0, 25]（5星 × log(1+150)≈25）
  const normalized = clamp((raw / 25) * (RULE_SCORE_MAX - RULE_SCORE_MIN) + RULE_SCORE_MIN,
                           RULE_SCORE_MIN, RULE_SCORE_MAX);
  return clamp((1 - ALPHA) * current + ALPHA * normalized, RULE_SCORE_MIN, RULE_SCORE_MAX);
}

/**
 * 基于命中规则计算 rule_prior（§5 STEP 6b f3 特征）。
 * 归一化到 [0,1] via sigmoid。
 */
export function computeRulePrior(matched_rules, { mu = RULE_PRIOR_MU_DEFAULT, sigma = RULE_PRIOR_SIGMA_DEFAULT } = {}) {
  if (!Array.isArray(matched_rules) || matched_rules.length === 0) return 0;
  const avgScore = matched_rules.reduce((a, r) => a + (r.rule_score ?? 1), 0) / matched_rules.length;
  const sumHits = matched_rules.reduce((a, r) => a + (r.hit_count ?? 0), 0);
  const raw = avgScore * Math.log(1 + sumHits);
  return sigmoid((raw - mu) / Math.max(0.01, sigma));
}

/**
 * 应评分触发：更新相关规则的权重 + 标记低分报告。
 * 传入 report 的 matched_rules（JSON 字段）和评分。
 */
export function updateOnRating(storage, { report_id, package_name, score, matched_rule_ids, rater_id }) {
  if (!storage || !package_name) throw new Error("storage/package_name required");
  const { db } = storage.resolveTargetDb(package_name);

  // 低评分 → 报告进复核队列（§8.3）
  if (score <= 2) {
    db.prepare("UPDATE reports SET status='pending_review' WHERE id=?").run(report_id);
  }

  if (!Array.isArray(matched_rule_ids) || matched_rule_ids.length === 0) return { rules_updated: 0 };

  let updated = 0;
  const selectRule = db.prepare("SELECT id, pattern, rule_score, hit_count FROM rules WHERE id=?");
  const getAvgRating = db.prepare(
    `SELECT AVG(r.score) AS avg_rating, COUNT(*) AS cnt, COUNT(CASE WHEN r.score<=2 THEN 1 END) AS low_recent
     FROM ratings r JOIN reports rep ON r.report_id=rep.id
     WHERE rep.id IN (SELECT DISTINCT rep2.id FROM reports rep2
                      WHERE json_extract(rep2.matched_rules, '$') LIKE ?)`
  );
  const updateRule = db.prepare("UPDATE rules SET rule_score=?, hit_count=hit_count+1, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?");
  const deprecateRule = db.prepare("UPDATE rules SET status='deprecated', updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?");

  for (const rule_id of matched_rule_ids) {
    const r = selectRule.get(rule_id);
    if (!r) continue;
    // 简化估算：用当前评分作为 avg_rating 的观测，hit_count 自增
    const newScore = smoothedRuleScore(r.rule_score, score, r.hit_count + 1);
    updateRule.run(newScore, rule_id);
    updated++;

    // 规则近 10 次评分 avg ≤ 2.5 → 自动 deprecated
    const stats = db.prepare(
      `SELECT AVG(score) AS avg_score FROM ratings
       WHERE report_id IN (SELECT id FROM reports WHERE json_extract(matched_rules,'$') LIKE ?)
       ORDER BY id DESC LIMIT 10`
    ).get(`%"${rule_id}"%`);
    if (stats && stats.avg_score !== null && Number(stats.avg_score) <= 2.5) {
      deprecateRule.run(rule_id);
    }
  }

  return { rules_updated: updated };
}

/**
 * 每周 cron：冷节点衰减 + 全局归一化（§8.2）
 *
 * 对 rules、memory_tree 的 weight/score：
 *   - 30 天未命中 → ×= 0.9
 *   - 180 天未命中 → 归档（status='archived'）
 *   - min-max 归一化到 [0.1, 5.0]
 */
export function cronWeeklyNormalization(storage, { package_name, now } = {}) {
  if (!package_name) throw new Error("package_name required");
  const { db } = storage.resolveTargetDb(package_name);
  const nowMs = now || Date.now();
  const d30 = new Date(nowMs - 30 * 86400_000).toISOString();
  const d180 = new Date(nowMs - 180 * 86400_000).toISOString();

  // rules cold decay
  const rCold = db.prepare(
    `UPDATE rules SET rule_score = MAX(?, rule_score * 0.9)
     WHERE status='active' AND updated_at < ?`
  ).run(RULE_SCORE_MIN, d30);

  const rArchive = db.prepare(
    `UPDATE rules SET status='archived' WHERE status IN ('active','deprecated') AND updated_at < ?`
  ).run(d180);

  // memory_tree cold decay —— 用 COALESCE(last_hit_at, updated_at) 作冷度基准
  // 避免刚 seed 但未命中过的节点被当作"180 天未命中"直接归档
  const tCold = db.prepare(
    `UPDATE memory_tree SET weight = MAX(0.1, weight * 0.9)
     WHERE status='active' AND COALESCE(last_hit_at, updated_at) < ?`
  ).run(d30);

  const tArchive = db.prepare(
    `UPDATE memory_tree SET status='archived'
     WHERE status='active' AND COALESCE(last_hit_at, updated_at) < ?`
  ).run(d180);

  // rules 全局 min-max 归一化到 [0.1, 5.0]
  const minmax = db.prepare(
    "SELECT MIN(rule_score) AS mn, MAX(rule_score) AS mx FROM rules WHERE status='active'"
  ).get();
  if (minmax && minmax.mx !== null && minmax.mx > minmax.mn) {
    const span = minmax.mx - minmax.mn;
    db.prepare(
      `UPDATE rules SET rule_score = ? + ((rule_score - ?) / ?) * ?
       WHERE status='active'`
    ).run(RULE_SCORE_MIN, minmax.mn, span, RULE_SCORE_MAX - RULE_SCORE_MIN);
  }

  return {
    rules_decayed: rCold.changes,
    rules_archived: rArchive.changes,
    tree_decayed: tCold.changes,
    tree_archived: tArchive.changes,
  };
}
