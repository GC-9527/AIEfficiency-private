/**
 * 规则自动提炼流水线骨架（方案 §9.3，P5 阶段）
 *
 * 每周日 04:00 cron：
 *   - 扫描同 (category, sub_category) 累积 ≥ 20 条且无对应 active 规则的群
 *   - 调用 LLM 分析共性生成候选 rule（pattern + conclusion）
 *   - 写 rules status='pending_review'，等待管理员审核
 *
 * 当前状态：**骨架实现**（LLM 调用走 _deps 注入，真实提炼逻辑在 P5 阶段落地）。
 */

const MIN_CASES_PER_GROUP = 20;

/**
 * 找出满足"≥20 case 且无 active 规则"的 (category, sub_category) 群组。
 */
export function findCandidateGroups(db) {
  return db.prepare(
    `SELECT category, sub_category, COUNT(*) AS cnt
     FROM cases
     WHERE category IS NOT NULL AND sub_category IS NOT NULL
     GROUP BY category, sub_category
     HAVING cnt >= ?`
  ).all(MIN_CASES_PER_GROUP)
    .filter((g) => {
      // 检查是否已有对应 active 规则
      const existing = db.prepare(
        "SELECT 1 FROM rules WHERE category=? AND sub_category=? AND status='active' LIMIT 1"
      ).get(g.category, g.sub_category);
      return !existing;
    });
}

/**
 * 写入候选规则（status='pending_review'）。
 */
export function proposeRule(db, { category, sub_category, pattern, conclusion, operator = "rule-miner" }) {
  const info = db.prepare(
    `INSERT INTO rules (pattern, category, sub_category, conclusion, status)
     VALUES (?, ?, ?, ?, 'pending_review')`
  ).run(pattern, category, sub_category, conclusion);
  return { id: info.lastInsertRowid };
}

/**
 * 审核动作（管理员面板调用）。
 */
export function approveRule(db, rule_id) {
  db.prepare("UPDATE rules SET status='active', updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?").run(rule_id);
}

export function rejectRule(db, rule_id, reason = "") {
  db.prepare(
    "UPDATE rules SET status='rejected', conclusion = COALESCE(conclusion,'') || ?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?"
  ).run(`\n[rejected] ${reason}`, rule_id);
}

/**
 * 主 cron 入口。
 */
export async function runWeeklyRuleMiner(storage, package_name, { _deps = {} } = {}) {
  const { db } = storage.resolveTargetDb(package_name);
  const groups = findCandidateGroups(db);

  const proposed = [];
  for (const g of groups) {
    // P5 实施：调用 _deps.callLlmRuleMining 让 LLM 看 20+ cases 共性生成正则 pattern
    if (_deps.callLlmRuleMining) {
      const out = await _deps.callLlmRuleMining({ db, group: g });
      if (out && out.pattern && out.conclusion) {
        const r = proposeRule(db, {
          category: g.category,
          sub_category: g.sub_category,
          pattern: out.pattern,
          conclusion: out.conclusion,
        });
        proposed.push({ group: g, rule_id: r.id });
      }
    }
  }

  return { candidate_groups: groups.length, proposed: proposed.length };
}
