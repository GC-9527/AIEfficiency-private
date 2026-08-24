/**
 * LLM 输出 JSON 轻量校验（方案 §5.3）
 *
 * 不引入 zod，手写专用校验器。只覆盖 Bug Agent 的单一输出 schema。
 * 返回 { ok, value, errors }。ok=true 时 value 为 clamp 后的规范对象。
 */

const CATEGORIES = new Set(["非问题", "UI 问题", "代码问题", "其他"]);

/**
 * 校验 + 规范化（clamp）LLM 分类输出。
 *
 * @param {unknown} raw - JSON.parse 后的原始对象
 * @returns {{ ok: boolean, value: object|null, errors: string[] }}
 */
export function validateClassification(raw) {
  const errors = [];

  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, value: null, errors: ["root must be an object"] };
  }

  const { category, sub_category, confidence, reasoning_steps } = raw;

  if (typeof category !== "string" || !CATEGORIES.has(category)) {
    errors.push(`category must be one of ${[...CATEGORIES].join(" / ")}`);
  }

  const subCat = typeof sub_category === "string" && sub_category.trim() ? sub_category.trim() : "";
  if (!subCat) errors.push("sub_category must be a non-empty string");

  let conf = Number(confidence);
  if (!Number.isFinite(conf)) {
    errors.push("confidence must be a finite number");
    conf = 0;
  } else if (conf < 0 || conf > 1) {
    // clamp 而非 fail：记录 warning 但允许通过
    conf = Math.max(0, Math.min(1, conf));
  }

  if (!Array.isArray(reasoning_steps)) {
    errors.push("reasoning_steps must be an array");
  } else if (reasoning_steps.length === 0) {
    errors.push("reasoning_steps must not be empty");
  }

  const normalizedSteps = [];
  if (Array.isArray(reasoning_steps)) {
    for (let i = 0; i < reasoning_steps.length; i++) {
      const s = reasoning_steps[i];
      if (!s || typeof s !== "object") {
        errors.push(`reasoning_steps[${i}] must be an object`);
        continue;
      }
      const claim = typeof s.claim === "string" ? s.claim.trim() : "";
      if (!claim) {
        errors.push(`reasoning_steps[${i}].claim must be a non-empty string`);
        continue;
      }
      const refs = Array.isArray(s.evidence_refs)
        ? s.evidence_refs.filter((r) => typeof r === "string" && r.trim())
        : [];
      if (refs.length === 0) {
        errors.push(`reasoning_steps[${i}].evidence_refs must contain >=1 entry`);
        continue;
      }
      normalizedSteps.push({ claim, evidence_refs: refs });
    }
  }

  if (errors.length > 0) {
    return { ok: false, value: null, errors };
  }

  return {
    ok: true,
    value: {
      category,
      sub_category: subCat,
      confidence: conf,
      reasoning_steps: normalizedSteps,
    },
    errors: [],
  };
}

/**
 * 尝试从 LLM 原文中提取 JSON（兼容可能的 ```json 包裹）。
 * 返回 parsed 对象或 throw。
 */
export function extractJson(rawText) {
  if (typeof rawText !== "string" || !rawText.trim()) {
    throw new Error("empty LLM response");
  }
  let text = rawText.trim();

  // 去除 markdown 代码块
  const fence = text.match(/```(?:json)?\s*\n([\s\S]*?)\n```/);
  if (fence) text = fence[1].trim();

  // 兜底：取第一个 { 到最后一个 }
  if (!text.startsWith("{")) {
    const first = text.indexOf("{");
    const last = text.lastIndexOf("}");
    if (first >= 0 && last > first) text = text.slice(first, last + 1);
  }

  return JSON.parse(text);
}
