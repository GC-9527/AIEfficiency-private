/**
 * 证据回查三层归一化匹配（方案 §5.4）
 *
 * LLM 输出的每个 claim 必须能在 evidence.text_snapshot 中找到对应。
 * 三层降级匹配 + 结构化字段直查，防止：
 *   - 严格子串误伤（LLM 合法断行/全半角/引号改写）
 *   - LLM 编造
 */

const NBSP = / | | /g;
const FULLWIDTH = /[！-～]/g;

function fullwidthToAscii(s) {
  return s.replace(FULLWIDTH, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
          .replace(/[　]/g, " ")  // IDEOGRAPHIC SPACE
          .replace(/[：]/g, ":")
          .replace(/[，]/g, ",")
          .replace(/[。]/g, ".")
          .replace(/[；]/g, ";")
          .replace(/[？]/g, "?")
          .replace(/[！]/g, "!")
          .replace(/[“”]/g, '"')
          .replace(/[‘’]/g, "'");
}

function normalize(s) {
  if (typeof s !== "string") return "";
  return fullwidthToAscii(
    s.normalize("NFC")
     .replace(NBSP, " ")
     .replace(/\s+/g, " ")
     .trim()
     .toLowerCase()
  );
}

/**
 * Levenshtein 距离（iterative DP，O(n*m) 空间 O(min)）。
 * 仅用于兜底，长度 <= 500。
 */
function levenshtein(a, b) {
  const m = a.length, n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  if (Math.abs(m - n) > 100) return Math.max(m, n); // 快速剪枝
  const prev = new Array(n + 1).fill(0);
  const curr = new Array(n + 1).fill(0);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(
        prev[j] + 1,
        curr[j - 1] + 1,
        prev[j - 1] + cost
      );
    }
    for (let j = 0; j <= n; j++) prev[j] = curr[j];
  }
  return prev[n];
}

// Tier 3：从 claim 里抽 "ClassName:Line" 或异常类名等结构化片段
const STRUCT_REFS = [
  /\b([A-Z][\w$]*(?:\.[A-Z][\w$]*)*):(\d{1,5})\b/,          // Foo.Bar:142
  /\b(java\.[\w$.]+(?:Exception|Error))\b/,                  // java.lang.X
  /\b([a-zA-Z_][\w$.]+(?:Exception|Error))\b/,               // NullPointerException
  /\b(signal\s+\d+\s+\(SIG\w+\))/i,                          // signal 11 (SIGSEGV)
];

function extractStructuralHints(text) {
  if (!text) return [];
  const hits = new Set();
  for (const re of STRUCT_REFS) {
    const m = text.match(re);
    if (m) hits.add(m[0]);
  }
  return [...hits];
}

/**
 * 校验单个 claim。
 *
 * @param {Object} p
 * @param {string} p.claim
 * @param {Array<{id: string|number, text_snapshot: string, exception_class?: string, line_start?: number, line_end?: number}>} p.refEvidences
 * @returns {{ ok: boolean, tier: 1|2|3|4|-1, matched_evidence_id?: string|number, reason?: string }}
 */
export function verifyClaim({ claim, refEvidences }) {
  if (typeof claim !== "string" || !claim.trim()) return { ok: false, tier: -1, reason: "empty_claim" };
  if (!Array.isArray(refEvidences) || refEvidences.length === 0) {
    return { ok: false, tier: -1, reason: "no_evidence_refs" };
  }

  // Tier 1 — 精确子串
  for (const e of refEvidences) {
    if (e.text_snapshot && e.text_snapshot.includes(claim)) {
      return { ok: true, tier: 1, matched_evidence_id: e.id };
    }
  }

  // Tier 2 — 归一化后子串（含去空格变体，应对 `Foo:<sp>bar` vs `Foo:bar` 等差异）
  const nClaim = normalize(claim);
  if (nClaim) {
    const nClaimNoSpace = nClaim.replace(/\s+/g, "");
    for (const e of refEvidences) {
      const nSnap = normalize(e.text_snapshot || "");
      if (nSnap.includes(nClaim)) return { ok: true, tier: 2, matched_evidence_id: e.id };
      if (nClaimNoSpace && nSnap.replace(/\s+/g, "").includes(nClaimNoSpace)) {
        return { ok: true, tier: 2, matched_evidence_id: e.id };
      }
    }
  }

  // Tier 3 — 结构化字段直查
  const hints = extractStructuralHints(claim);
  if (hints.length > 0) {
    for (const e of refEvidences) {
      const nSnap = normalize(e.text_snapshot || "");
      const hit = hints.find((h) => nSnap.includes(normalize(h)) || (e.exception_class && normalize(e.exception_class).includes(normalize(h))));
      if (hit) return { ok: true, tier: 3, matched_evidence_id: e.id };
    }
  }

  // Tier 4 — 保守模糊（仅 claim 长度 > 10 且 ≤ 500）
  if (claim.length > 10 && claim.length <= 500) {
    const target = nClaim;
    for (const e of refEvidences) {
      if (!e.text_snapshot || e.text_snapshot.length > 50000) continue;
      const snap = normalize(e.text_snapshot);
      // 在 snap 中滑窗找最佳
      const windowLen = Math.min(snap.length, target.length + 10);
      let bestDist = Infinity;
      const step = Math.max(1, Math.floor(target.length / 4));
      for (let i = 0; i + target.length - 5 < snap.length; i += step) {
        const slice = snap.slice(i, i + windowLen);
        const d = levenshtein(target, slice);
        if (d < bestDist) bestDist = d;
        if (d <= 3) break;
      }
      if (bestDist <= 3) return { ok: true, tier: 4, matched_evidence_id: e.id };
    }
  }

  return { ok: false, tier: -1, reason: "all_tiers_failed" };
}

/**
 * 批量校验一份 LLM 输出的 reasoning_steps。
 * 返回：通过数 / 总数 / 每条详细 / mismatch 数。
 */
export function verifyReasoning({ reasoning_steps, evidences }) {
  const byId = new Map();
  for (const e of evidences) byId.set(String(e.id), e);

  const details = [];
  let pass = 0;
  let mismatch = 0;
  for (const step of reasoning_steps || []) {
    const refIds = (step.evidence_refs || []).map((r) => String(r).replace(/^e:/, ""));
    const refs = refIds.map((id) => byId.get(id)).filter(Boolean);
    if (refs.length === 0) {
      details.push({ claim: step.claim, ok: false, reason: "unknown_evidence_ref", refs: step.evidence_refs });
      mismatch++;
      continue;
    }
    const r = verifyClaim({ claim: step.claim, refEvidences: refs });
    details.push({ claim: step.claim, ...r });
    if (r.ok) pass++;
    else mismatch++;
  }
  return {
    total: reasoning_steps?.length || 0,
    pass,
    mismatch,
    details,
  };
}

/**
 * 根据 verifyReasoning 结果应用 confidence 调整（方案 §5.4）：
 *   - 任何 mismatch：confidence *= 0.7
 *   - mismatch > 3：confidence 封顶 0.4
 */
export function adjustConfidence(originalConfidence, verifyResult) {
  let c = originalConfidence;
  if (verifyResult.mismatch > 0) c *= 0.7;
  if (verifyResult.mismatch > 3) c = Math.min(c, 0.4);
  return Math.max(0, Math.min(1, c));
}
