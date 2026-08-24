/**
 * 金标集回归 runner（方案 §12.2 / §12.5）
 *
 * 用法（CI）：
 *   node services/bug-agent/testing/run-regression.js
 *   → 退出码 0=通过；1=准确率下降 > 5%
 *
 * 本文件只导出可调用函数；CLI 封装在 run-regression.js。
 */

import { analyzeTbCase } from "../classifier/classifier.js";

/**
 * 批量跑金标集，统计准确率。
 *
 * @param {Array} goldenEntries
 * @param {Object} ctx - { storage, _deps }
 * @returns {{
 *   total: number,
 *   category_correct: number,
 *   sub_category_correct: number,
 *   category_accuracy: number,
 *   sub_category_accuracy: number,
 *   details: Array
 * }}
 */
export async function runGoldenRegression(goldenEntries, ctx) {
  const details = [];
  let catOK = 0, subOK = 0;

  for (const gold of goldenEntries) {
    try {
      const r = await analyzeTbCase(
        {
          tb_id: gold.tb_id,
          package_name: gold.package_name,
          title: gold.title,
          raw_content: gold.raw_content,
          log_attachment: gold.log_attachment,
          reporter_id: "golden_runner",
        },
        ctx
      );
      if (!r.ok) {
        details.push({ tb_id: gold.tb_id, ok: false, error_code: r.error_code });
        continue;
      }
      const predCat = r.classification.category;
      const predSub = r.classification.sub_category;
      const catMatch = predCat === gold.expected_category;
      const subMatch = predSub && gold.expected_sub_category
        ? predSub.includes(gold.expected_sub_category) || gold.expected_sub_category.includes(predSub)
        : catMatch;
      if (catMatch) catOK++;
      if (subMatch) subOK++;
      details.push({
        tb_id: gold.tb_id,
        ok: true,
        predicted: { category: predCat, sub_category: predSub },
        expected: { category: gold.expected_category, sub_category: gold.expected_sub_category },
        category_match: catMatch,
        sub_category_match: subMatch,
        confidence: r.classification.confidence,
        is_degraded: r.is_degraded,
      });
    } catch (e) {
      details.push({ tb_id: gold.tb_id, ok: false, error: e.message });
    }
  }

  const total = goldenEntries.length;
  return {
    total,
    category_correct: catOK,
    sub_category_correct: subOK,
    category_accuracy: total > 0 ? catOK / total : 0,
    sub_category_accuracy: total > 0 ? subOK / total : 0,
    details,
  };
}

/**
 * 比较本次回归结果 vs 上一次基线，判断是否应拦截合并。
 *
 * @param {Object} current - runGoldenRegression 输出
 * @param {Object} baseline - 同样结构（nullable = 无基线）
 * @param {Object} [opts]
 * @returns {{ should_block: boolean, drop: number, reason?: string }}
 */
export function evaluateRegressionGate(current, baseline, { max_drop = 0.05 } = {}) {
  if (!baseline) return { should_block: false, drop: 0, reason: "no_baseline" };
  const drop = baseline.category_accuracy - current.category_accuracy;
  if (drop > max_drop) {
    return {
      should_block: true,
      drop,
      reason: `category_accuracy dropped ${(drop * 100).toFixed(1)}% (> ${max_drop * 100}% threshold)`,
    };
  }
  return { should_block: false, drop };
}
