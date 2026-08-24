const LEGACY_KINDS_BY_STAGE = Object.freeze({
  TRIAGE: Object.freeze(new Set(["triage_is_bug", "triage_not_bug"])),
  REPAIR: Object.freeze(new Set(["fix_done"])),
  VERIFY_EXECUTE: Object.freeze(new Set(["verify_pass", "verify_fail"])),
  REPORT_SHORT: Object.freeze(new Set(["report_done"])),
  REPORT_EXPERT: Object.freeze(new Set(["report_done"])),
});

const CONTROL_COMMENT_PATTERN = /<!--[\s\S]*?-->/g;
const CONTROL_WORD_PATTERN = /\b(?:TRIAGE|VERIFY|IS_BUG|NOT_A_BUG|FIX_DONE|REPORT_DONE|NEXT|MARKER)\b/gi;
const JSON_DELIMITER_PATTERN = /[{}[\]]/g;
const HTML_DELIMITER_PATTERN = /[<>&]/g;

export class WorkflowV2LegacyResultAdapterError extends Error {
  constructor(message, code, details = {}) {
    super(message);
    this.name = "WorkflowV2LegacyResultAdapterError";
    this.code = code;
    this.details = details;
  }
}

function fail(message, code, details = {}) {
  throw new WorkflowV2LegacyResultAdapterError(message, code, details);
}

function unicodeSlice(value, maxChars) {
  return Array.from(String(value || "")).slice(0, maxChars).join("");
}

function safeFragment(value, fallback = "") {
  const normalized = unicodeSlice(value, 800)
    .replace(CONTROL_COMMENT_PATTERN, " ")
    .replace(CONTROL_WORD_PATTERN, " ")
    .replace(JSON_DELIMITER_PATTERN, (character) => ({
      "{": "｛",
      "}": "｝",
      "[": "［",
      "]": "］",
    })[character])
    .replace(HTML_DELIMITER_PATTERN, (character) => ({
      "<": "＜",
      ">": "＞",
      "&": "＆",
    })[character])
    .replace(/[`\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[。.!！?？；;]+$/u, "");
  return unicodeSlice(normalized || fallback, 500);
}

function triageDisplay(result, legacyKind) {
  const conclusion = legacyKind === "triage_not_bug" ? "非本侧问题" : (
    result?.classification === "CROSS_COMPONENT" ? "跨组件问题" : "本侧问题"
  );
  const summary = safeFragment(result?.userSummary);
  return summary
    ? `甄别完成：判定为${conclusion}。说明：${summary}。`
    : `甄别完成：判定为${conclusion}。`;
}

function repairDisplay(result) {
  const cause = safeFragment(result?.userFriendlyCause, "已确认问题原因");
  const measure = safeFragment(result?.userFriendlyMeasure, "已完成最小修复");
  return `修复完成。原因：${cause}。措施：${measure}。`;
}

function displayFor({ stageId, result, legacyKind }) {
  if (stageId === "TRIAGE") return triageDisplay(result, legacyKind);
  if (stageId === "REPAIR") return repairDisplay(result);
  if (stageId === "VERIFY_EXECUTE") {
    return legacyKind === "verify_pass" ? "系统验收门禁已通过。" : "系统验收门禁未通过。";
  }
  if (stageId === "REPORT_SHORT") {
    return `${safeFragment(result?.reportText, "简短报告已生成")}。`;
  }
  if (stageId === "REPORT_EXPERT") return "专家报告已通过渲染与文档系统门禁。";
  fail("structured result 的阶段不受 legacy adapter 支持", "WORKFLOW_V2_LEGACY_STAGE_UNSUPPORTED", {
    stageId,
  });
}

function assertSafeDisplay(displayText) {
  if (!displayText || CONTROL_COMMENT_PATTERN.test(displayText) || CONTROL_WORD_PATTERN.test(displayText)) {
    CONTROL_COMMENT_PATTERN.lastIndex = 0;
    CONTROL_WORD_PATTERN.lastIndex = 0;
    fail("legacy adapter 生成了不安全的用户文本", "WORKFLOW_V2_LEGACY_DISPLAY_UNSAFE");
  }
  CONTROL_COMMENT_PATTERN.lastIndex = 0;
  CONTROL_WORD_PATTERN.lastIndex = 0;
}

/**
 * Convert an already trusted gate decision into the legacy parser shape.
 * This adapter deliberately emits no HTML marker, NEXT instruction, or raw JSON.
 */
export function adaptStructuredResultToLegacyEvent({ stageId, result, legacyKind } = {}) {
  const allowedKinds = LEGACY_KINDS_BY_STAGE[String(stageId || "")];
  if (!allowedKinds || !allowedKinds.has(String(legacyKind || ""))) {
    fail("legacy event 与 structured stage 不匹配", "WORKFLOW_V2_LEGACY_EVENT_STAGE_MISMATCH", {
      stageId: String(stageId || ""),
      legacyKind: String(legacyKind || ""),
    });
  }
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    fail("legacy adapter 缺少已校验的 structured result", "WORKFLOW_V2_LEGACY_RESULT_REQUIRED");
  }
  const displayText = displayFor({ stageId, result, legacyKind });
  assertSafeDisplay(displayText);
  const legacyEvent = Object.freeze({ kind: legacyKind, cleaned: displayText });
  return Object.freeze({ displayText, legacyEvent });
}
