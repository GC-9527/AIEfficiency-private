/**
 * 每日聚类 cron 骨架（方案 §7.4，P2b 阶段）
 *
 * 当前状态：**骨架实现**（feature flag 关闭）。
 *   - embedding 模型：bge-m3 本地 / OpenAI text-embedding-3-small（未集成）
 *   - P0/P1 阶段：方案 §7.4 明确"不启用 embedding"
 *   - 本模块提供 cron 入口 + 聚类调度 + 人工审核队列写入；
 *     真实 embedding 与 LLM 提炼留到 P2b 完整实施
 */

const ENABLE_EMBEDDING = process.env.BUG_AGENT_EMBEDDING_ENABLED === "1";
const CLUSTER_THRESHOLD_COUNT = 20;
const HIGH_FREQ_MIN_CASES = 3;
const HIGH_FREQ_WINDOW_DAYS = 7;

/**
 * 获取过去 24h 新 case。
 */
function listNewCases(db, hours = 24) {
  const since = new Date(Date.now() - hours * 3600_000).toISOString();
  return db.prepare(
    `SELECT c.id, c.tb_id, c.category, c.sub_category, c.title, c.exception_class, c.raw_content
     FROM cases c
     LEFT JOIN node_case_map m ON m.case_id = c.id AND m.is_current = 1
     WHERE c.created_at > ? AND m.id IS NULL`
  ).all(since);
}

/**
 * 挂接阶段（2a/2b/2c）：
 *   - 2a 关键词匹配：category + sub_category → resolveLeafNode
 *   - 2b embedding 相似度（feature flag 关闭时跳过）
 *   - 2c 阈值 0.65 → 挂接；否则暂存"待归类"
 */
export function stageAttach(db, { cases, resolveLeaf, attach }) {
  const attached = [];
  const pending = [];
  for (const c of cases) {
    const leaf = resolveLeaf(db, { category: c.category, sub_category: c.sub_category });
    if (leaf) {
      attach(db, { node_id: leaf.id, case_id: c.id, node_version: leaf.version || 1 });
      attached.push({ case_id: c.id, node_id: leaf.id });
    } else {
      pending.push(c);
    }
  }
  // embedding 阶段占位（feature flag 关闭时跳过）
  if (ENABLE_EMBEDDING) {
    // TODO P2b: 加载 bge-m3，对 pending 做 top3 召回 + 阈值 0.65 挂接
  }
  return { attached, pending };
}

/**
 * 判断是否触发 LLM 聚类提炼（§7.4 step 3）：
 *   - 待归类累计 ≥ 20 条
 *   - 近 7 天高频（同特征 case ≥ 3）
 */
export function shouldTriggerLlmClustering(pending, recentHistory) {
  if (pending.length < CLUSTER_THRESHOLD_COUNT) return false;
  // 简化判断：检查是否有"同特征"聚集（同 exception_class 或 title 近似）
  const counts = new Map();
  for (const p of recentHistory) {
    const key = p.exception_class || (p.title || "").slice(0, 20);
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  for (const v of counts.values()) {
    if (v >= HIGH_FREQ_MIN_CASES) return true;
  }
  return false;
}

/**
 * 主 cron 入口（每日 03:00 UTC）：处理一个应用库。
 */
export async function runDailyClusterCron(storage, package_name, { resolveLeaf, attach, _deps = {} } = {}) {
  const { db } = storage.resolveTargetDb(package_name);
  const newCases = listNewCases(db);

  const { attached, pending } = stageAttach(db, { cases: newCases, resolveLeaf, attach });

  // 近 7 天待归类历史
  const since7 = new Date(Date.now() - HIGH_FREQ_WINDOW_DAYS * 86400_000).toISOString();
  const pendingHistory = db.prepare(
    `SELECT c.* FROM cases c
     LEFT JOIN node_case_map m ON m.case_id=c.id AND m.is_current=1
     WHERE c.created_at > ? AND m.id IS NULL`
  ).all(since7);

  let llm_triggered = false;
  if (shouldTriggerLlmClustering(pending, pendingHistory) && _deps.callLlmCluster) {
    // P2b: 真实的 LLM 聚类提炼在 _deps.callLlmCluster 里实现
    await _deps.callLlmCluster({ pending, pendingHistory, db });
    llm_triggered = true;
  }

  return {
    package_name,
    new_cases: newCases.length,
    attached: attached.length,
    pending: pending.length,
    llm_triggered,
    embedding_enabled: ENABLE_EMBEDDING,
  };
}
