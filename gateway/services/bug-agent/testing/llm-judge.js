/**
 * LLM-as-Judge（方案 §12.3）
 *
 * 用 Claude Opus 4.7 评估 Haiku 的分类质量（避免自评偏差）。
 * 三个维度各 0-1：
 *   - classification_correctness
 *   - evidence_relevance
 *   - report_readability
 *
 * 本文件只负责构造 Prompt + 解析 Judge 输出。实际 LLM 调用复用 anthropic-client。
 */

import { callAnthropic } from "../llm/anthropic-client.js";

const JUDGE_SYSTEM = `你是一名资深 Bug 分类审核员。针对给定的 Bug 分析报告，请从三个维度打分：

1. classification_correctness（0-1）：分类是否正确、置信度是否合理
2. evidence_relevance（0-1）：推理链中的 claim 是否真的能从证据中找到支持
3. report_readability（0-1）：报告对非开发人员的可读性

仅输出 JSON，不要任何说明文字：
{"classification_correctness": <0-1>, "evidence_relevance": <0-1>, "report_readability": <0-1>, "summary": "<一句话评价>"}`;

const JUDGE_MODEL = process.env.BUG_AGENT_JUDGE_MODEL || "claude-opus-4-7-20260115";

/**
 * 评估单条报告。
 */
export async function judgeReport({ tb_title, tb_body, evidences, classification, _deps = {} }) {
  const call = _deps.callAnthropic || callAnthropic;

  const user = `【TB 单】
标题：${tb_title}
正文：${tb_body}

【证据（部分）】
${(evidences || []).slice(0, 8).map((e, i) => `[${i + 1}] (${e.source_type}) ${(e.text_snapshot || "").slice(0, 500)}`).join("\n\n")}

【分类结果】
category: ${classification.category}
sub_category: ${classification.sub_category}
confidence: ${classification.confidence}
reasoning:
${(classification.reasoning_steps || []).map((s) => `- ${s.claim} [refs: ${(s.evidence_refs || []).join(", ")}]`).join("\n")}

请打分并输出 JSON。`;

  let resp;
  try {
    resp = await call({
      system: JUDGE_SYSTEM,
      messages: [{ role: "user", content: user }],
      model: JUDGE_MODEL,
      max_tokens: 512,
    });
  } catch (e) {
    return { ok: false, error: e.code || e.message };
  }

  try {
    const text = resp.text.trim();
    const fence = text.match(/```(?:json)?\s*\n([\s\S]*?)\n```/);
    const body = fence ? fence[1] : text;
    const json = JSON.parse(body);
    const norm = (x) => Math.max(0, Math.min(1, Number(x) || 0));
    return {
      ok: true,
      scores: {
        classification_correctness: norm(json.classification_correctness),
        evidence_relevance: norm(json.evidence_relevance),
        report_readability: norm(json.report_readability),
      },
      summary: String(json.summary || ""),
      usage: resp.usage,
    };
  } catch (e) {
    return { ok: false, error: "JUDGE_NON_JSON", raw: resp.text.slice(0, 1000) };
  }
}

/**
 * 判断周评估是否应阻塞新规则/新节点发布（§12.3）
 */
export function evaluateJudgeGate(weekly_correctness_avg, { threshold = 0.75 } = {}) {
  return {
    should_block: weekly_correctness_avg < threshold,
    avg: weekly_correctness_avg,
    threshold,
  };
}
