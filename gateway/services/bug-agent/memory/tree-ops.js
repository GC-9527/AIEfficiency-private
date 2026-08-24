/**
 * 记忆树操作（方案 §7.4-§7.8）
 *
 * 职责：
 *   - 根据 case 的 (category, sub_category) 找叶子节点并挂接（node_case_map）
 *   - 召回：按节点名 + FTS5 融合打分
 *   - 节点废弃 / 合并的数据迁移（§7.8.2 / §7.8.3）
 */

// ---------- 挂接 ----------

/**
 * 找到最匹配的叶子节点：按 sub_category 与 node.title 做归一化比对。
 * 若找不到，fallback 到父级大类（category），再不行挂到"其他/待归类"。
 */
export function resolveLeafNode(db, { category, sub_category }) {
  // 1. 精确 sub_category
  if (sub_category) {
    const lvl2 = db.prepare(
      "SELECT id, version FROM memory_tree WHERE level=2 AND status='active' AND title LIKE ?"
    ).get(`%${sub_category}%`);
    if (lvl2) return lvl2;
  }
  // 2. category → 其第一个子节点
  if (category) {
    const lvl1 = db.prepare(
      "SELECT id FROM memory_tree WHERE level=1 AND status='active' AND title LIKE ?"
    ).get(`%${category.replace(/\s+/g, "%")}%`);
    if (lvl1) {
      const firstChild = db.prepare(
        "SELECT id, version FROM memory_tree WHERE parent_id=? AND status='active' ORDER BY id ASC LIMIT 1"
      ).get(lvl1.id);
      if (firstChild) return firstChild;
    }
  }
  // 3. fallback：其他/待归类
  const fallback = db.prepare(
    "SELECT id, version FROM memory_tree WHERE level=2 AND status='active' AND title='待归类' LIMIT 1"
  ).get();
  return fallback || null;
}

/**
 * 把 case 挂到 node（写 node_case_map，§7.7 / §7.8.1）。
 * 若 case 已挂在其他节点 is_current=1，先将旧映射置 is_current=0。
 */
export function attachCaseToNode(db, { node_id, case_id, node_version }) {
  // 老的 current → set is_current=0
  db.prepare(
    "UPDATE node_case_map SET is_current=0 WHERE case_id=? AND is_current=1"
  ).run(case_id);

  const info = db.prepare(
    `INSERT OR IGNORE INTO node_case_map (node_id, case_id, node_version, relation_score, is_current)
     VALUES (?, ?, ?, 1.0, 1)`
  ).run(node_id, case_id, node_version);

  // hit_count / last_hit_at
  db.prepare(
    `UPDATE memory_tree
     SET hit_count=hit_count+1, last_hit_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
     WHERE id=?`
  ).run(node_id);

  return { map_id: info.lastInsertRowid };
}

// ---------- 召回（简化版，方案 §5 STEP 5/6） ----------

/**
 * 基于 title + sub_category 做记忆树节点相似度匹配，返回 Top N 节点 + 其下 case_ids。
 * P2a 阶段：用 FTS5 在 node.title + summary 上做文本召回；严谨的 embedding 留到 P2b。
 */
export function retrieveSimilarCases(db, { query_text, top_node_n = 3, top_case_n = 5 }) {
  // 简化：按 title/summary 模糊匹配
  const nodes = db.prepare(
    `SELECT id, title, summary, weight, version
     FROM memory_tree WHERE status='active' AND (title LIKE ? OR summary LIKE ?)
     ORDER BY weight DESC, hit_count DESC LIMIT ?`
  ).all(`%${query_text.slice(0, 30)}%`, `%${query_text.slice(0, 30)}%`, top_node_n);

  const result = [];
  for (const n of nodes) {
    const cases = db.prepare(
      `SELECT c.id, c.tb_id, c.title, c.category, c.sub_category, c.confidence, m.relation_score
       FROM node_case_map m JOIN cases c ON m.case_id = c.id
       WHERE m.node_id = ? AND m.is_current = 1
       ORDER BY m.relation_score DESC, c.analyzed_at DESC LIMIT ?`
    ).all(n.id, top_case_n);
    result.push({ node: n, cases });
  }
  return result;
}

// ---------- 节点演化（§7.8） ----------

/**
 * 废弃节点：case 自动重挂到父节点（§7.8.2）。
 */
export function deprecateNode(db, node_id, { operator = "system" } = {}) {
  const node = db.prepare("SELECT parent_id FROM memory_tree WHERE id=?").get(node_id);
  if (!node) return { moved: 0, reason: "not_found" };
  const parent_id = node.parent_id;
  if (!parent_id) throw new Error("cannot deprecate root");

  const parent = db.prepare("SELECT id, version FROM memory_tree WHERE id=?").get(parent_id);

  const affected = db.prepare(
    "SELECT case_id FROM node_case_map WHERE node_id=? AND is_current=1"
  ).all(node_id);

  const tx = db.transaction(() => {
    for (const row of affected) {
      db.prepare("UPDATE node_case_map SET is_current=0 WHERE case_id=? AND node_id=? AND is_current=1")
        .run(row.case_id, node_id);
      db.prepare(
        `INSERT OR IGNORE INTO node_case_map (node_id, case_id, node_version, relation_score, is_current)
         VALUES (?, ?, ?, 0.8, 1)`
      ).run(parent.id, row.case_id, parent.version);
    }
    db.prepare(
      "UPDATE memory_tree SET status='deprecated', version=version+1, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?"
    ).run(node_id);
    db.prepare(
      "INSERT INTO memory_tree_change_log (node_id, action, llm_output, operator) VALUES (?, 'deprecate', ?, ?)"
    ).run(node_id, JSON.stringify({ moved: affected.length, into_parent: parent_id }), operator);
  });
  tx();

  return { moved: affected.length, into_parent: parent_id };
}

/**
 * 合并节点（§7.8.3）：
 *   输入若干 source_node_ids → 新建 merged_node → 旧节点 deprecated → cases 迁移
 */
export function mergeNodes(db, { source_node_ids, merged_title, operator = "system" }) {
  if (!Array.isArray(source_node_ids) || source_node_ids.length < 2) {
    throw new Error("source_node_ids must be >=2");
  }
  const sources = source_node_ids
    .map((id) => db.prepare("SELECT id, parent_id, level FROM memory_tree WHERE id=?").get(id))
    .filter(Boolean);
  if (sources.length < 2) throw new Error("some source nodes not found");

  const parent_ids = [...new Set(sources.map((s) => s.parent_id))];
  if (parent_ids.length !== 1) throw new Error("merge sources must share same parent");
  const parent_id = parent_ids[0];
  const maxLevel = Math.max(...sources.map((s) => s.level));

  const tx = db.transaction(() => {
    const info = db
      .prepare(
        `INSERT INTO memory_tree (parent_id, level, title, summary, weight, status)
         VALUES (?, ?, ?, ?, 1.0, 'active')`
      )
      .run(parent_id, maxLevel, merged_title, `合并自 ${sources.length} 个节点`);
    const merged_id = info.lastInsertRowid;
    const merged_version = 1;

    for (const s of sources) {
      const rows = db.prepare(
        "SELECT case_id FROM node_case_map WHERE node_id=? AND is_current=1"
      ).all(s.id);

      for (const row of rows) {
        db.prepare("UPDATE node_case_map SET is_current=0 WHERE case_id=? AND node_id=? AND is_current=1")
          .run(row.case_id, s.id);
        db.prepare(
          `INSERT OR IGNORE INTO node_case_map (node_id, case_id, node_version, relation_score, is_current)
           VALUES (?, ?, ?, 1.0, 1)`
        ).run(merged_id, row.case_id, merged_version);
      }

      db.prepare(
        "UPDATE memory_tree SET status='deprecated', version=version+1 WHERE id=?"
      ).run(s.id);
    }

    db.prepare(
      "INSERT INTO memory_tree_change_log (node_id, action, llm_output, operator) VALUES (?, 'merge', ?, ?)"
    ).run(merged_id, JSON.stringify({ sources: source_node_ids }), operator);

    return merged_id;
  });
  const merged_id = tx();
  return { merged_id, deprecated: source_node_ids };
}
