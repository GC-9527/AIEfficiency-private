const MARKER_PATTERN = /<!--\s*(TRIAGE\s*:\s*(?:NOT_A_BUG|IS_BUG)|VERIFY\s*:\s*(?:PASS|FAIL)|FIX_DONE|REPORT_DONE)\s*-->/gi;

export class WorkflowV2CompatibilityResultError extends Error {
  constructor(message, code, details = {}) {
    super(message);
    this.name = "WorkflowV2CompatibilityResultError";
    this.code = code;
    this.details = details;
  }
}

function cleanMarkers(text) {
  return String(text || "")
    .replace(MARKER_PATTERN, "")
    .replace(/<!--\s*LESSON[\s\S]*?-->/gi, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function markerKind(raw) {
  const value = String(raw || "").replace(/\s+/g, "").toUpperCase();
  if (value === "TRIAGE:NOT_A_BUG") return "triage_not_bug";
  if (value === "TRIAGE:IS_BUG") return "triage_is_bug";
  if (value === "VERIFY:PASS") return "verify_pass";
  if (value === "VERIFY:FAIL") return "verify_fail";
  if (value === "FIX_DONE") return "fix_done";
  if (value === "REPORT_DONE") return "report_done";
  return "";
}

function expectedKinds(stageId) {
  if (stageId === "TRIAGE") return new Set(["triage_not_bug", "triage_is_bug"]);
  if (stageId === "REPAIR") return new Set(["fix_done"]);
  if (stageId === "VERIFY_EXECUTE") return new Set(["verify_pass", "verify_fail"]);
  if (stageId === "REPORT_SHORT" || stageId === "REPORT_EXPERT") return new Set(["report_done"]);
  return new Set();
}

function hasExactLabels(text, labels) {
  return labels.every((label) => {
    const matches = [...String(text || "").matchAll(new RegExp(`(?:^|\\n)\\s*${label}\\s*[:：]\\s*([^\\n]+)`, "gi"))];
    return matches.length === 1 && !!matches[0][1]?.trim();
  });
}

function lineValue(text, label) {
  return String(text || "").match(new RegExp(`(?:^|\\n)\\s*${label}\\s*[:：]\\s*([^\\n]+)`, "i"))?.[1]?.trim() || "";
}

function failResult(text, code, error, details = {}) {
  return { ok: false, code, error, details, markerKind: "", cleaned: cleanMarkers(text) };
}

function classifiedTriageConclusion(text) {
  const conclusion = lineValue(text, "结论").replace(/\s+/g, "");
  if (["证据不足", "无法判断", "未知", "待确认", "阻断"].includes(conclusion)) return "insufficient";
  if (conclusion === "非本侧问题") return "not_bug";
  if (conclusion === "跨组件" || conclusion === "本侧问题") return "is_bug";
  return "unknown";
}

function classifiedVerifyConclusion(text) {
  const conclusion = lineValue(text, "结论");
  if (!conclusion) return "unknown";
  if (/未通过|不通过|失败|阻断|BLOCKED|FAIL(?:ED)?/i.test(conclusion)) return "fail";
  if (/^(?:验收)?通过$|^PASS$/i.test(conclusion.replace(/\s+/g, ""))) return "pass";
  return "unknown";
}

function isExplicitlySuccessful(value) {
  const text = String(value || "").trim();
  if (!text) return false;
  if (/(?:未|尚未).{0,10}(?:执行|验证|测试|检查|通过|成功|完成|说明)|没有(?:执行|验证|测试|检查)|无(?:验证|测试|检查)|失败|不通过|FAIL(?:ED)?|BLOCKED|阻断|环境不可用|无法执行|跳过|SKIP|未知|待确认|尚无结论|未说明是否通过|可能|疑似|倾向|大概率|基本|部分|不确定|或许|也许|预计|似乎/i.test(text)) return false;
  const subject = "(?:单元测试|集成测试|回归测试|本地测试|本地检查|静态检查|检查|测试|验证|构建|编译)";
  const status = "(?:PASS|通过|成功)";
  const count = "(?:\\s*[（(]\\d+\\s*\\/\\s*\\d+[）)])?";
  const reference = "(?:\\s+(?:receipt|evidence)[-_:][A-Za-z0-9._:-]+|\\s+storydev:\\/[^\\s]+)?";
  return new RegExp(`^(?:${status}|${subject}(?:结果)?\\s*[:：]?\\s*${status})${count}${reference}[。.!！]?$`, "i").test(text);
}

function isEvidenceRowSuccessful(value) {
  return /^(?:PASS|通过|成功)$/i.test(String(value || "").trim());
}

function splitMarkdownRow(line) {
  const source = String(line || "").trim();
  if (!source.startsWith("|") || !source.endsWith("|")) return null;
  return source.slice(1, -1).split("|").map((cell) => cell.trim());
}

function verifyEvidenceTable(text) {
  const lines = String(text || "").split(/\r?\n/);
  const stableReference = /(?:\b(?:receipt|evidence)[-_:][A-Za-z0-9._:-]+\b|storydev:\/[^\s|]+|artifact:\/\/[^\s|]+|tb:\/\/[^\s|]+|sha256:[a-f0-9]{64})/i;
  for (let index = 0; index < lines.length - 2; index += 1) {
    const header = splitMarkdownRow(lines[index]);
    const divider = splitMarkdownRow(lines[index + 1]);
    if (!header || !divider || divider.length !== header.length
      || !divider.every((cell) => /^:?-{3,}:?$/.test(cell))) continue;
    const typeIndex = header.findIndex((cell) => /类型|类别|type|category/i.test(cell));
    const evidenceIndex = header.findIndex((cell, cellIndex) => cellIndex !== typeIndex
      && /证据(?:引用|ID)?|稳定引用|回执|evidence|receipt|reference/i.test(cell));
    const resultIndex = header.findIndex((cell) => /结果|状态|result|status/i.test(cell));
    if (typeIndex < 0 || evidenceIndex < 0 || resultIndex < 0) continue;
    const rows = [];
    for (let rowIndex = index + 2; rowIndex < lines.length; rowIndex += 1) {
      const cells = splitMarkdownRow(lines[rowIndex]);
      if (!cells || cells.length !== header.length) break;
      rows.push(cells);
    }
    const requiredTypes = [
      /构建|build/i,
      /测试|用例|test/i,
      /设备|真机|车机|AppMock|device/i,
    ];
    const classifiedRows = rows.map((cells, rowIndex) => {
      const typeMatches = requiredTypes
        .map((pattern, type) => pattern.test(cells[typeIndex] || "") ? type : -1)
        .filter((type) => type >= 0);
      return {
        rowIndex,
        type: typeMatches.length === 1 ? typeMatches[0] : -1,
        reference: String(cells[evidenceIndex] || "").trim(),
        successful: isEvidenceRowSuccessful(cells[resultIndex]),
      };
    });
    const selectedRows = requiredTypes.map((_pattern, type) => classifiedRows.find((row) => (
      row.type === type && stableReference.test(row.reference) && row.successful
    )));
    const complete = selectedRows.every(Boolean)
      && new Set(selectedRows.map((row) => row.rowIndex)).size === requiredTypes.length
      && new Set(selectedRows.map((row) => row.reference.toLowerCase())).size === requiredTypes.length;
    if (complete) return true;
  }
  return false;
}

function validateTriage(text, kind) {
  if (!/^##\s*甄别结论\s*$/im.test(text) || !hasExactLabels(text, ["结论", "原因", "依据", "未读"])) {
    return "甄别输出缺少固定标题或结构字段";
  }
  const conclusion = classifiedTriageConclusion(text);
  if (conclusion === "insufficient" || conclusion === "unknown") return "甄别结论不是受控的本侧/非本侧判断";
  if (kind === "triage_not_bug" && conclusion !== "not_bug") return "NOT_A_BUG marker 与结论不一致";
  if (kind === "triage_is_bug" && conclusion !== "is_bug") return "IS_BUG marker 与结论不一致";
  return "";
}

function validateRepair(text) {
  if (!/^##\s*修复结果\s*$/im.test(text) || !hasExactLabels(text, ["原因", "措施", "改动", "验证", "风险"])) {
    return "修复输出缺少固定标题或结构字段";
  }
  const verification = lineValue(text, "验证");
  if (!isExplicitlySuccessful(verification)) return "FIX_DONE 缺少明确成功的本地检查结果";
  return "";
}

function validateVerify(text, kind) {
  if (!/^##\s*验收结果\s*$/im.test(text) || !hasExactLabels(text, ["结论", "范围", "用例", "遗留"])) {
    return "验收输出缺少固定标题或结构字段";
  }
  const conclusion = classifiedVerifyConclusion(text);
  if (kind === "verify_fail") {
    return conclusion === "fail" ? "" : "VERIFY FAIL marker 与结论不一致";
  }
  if (conclusion !== "pass") return "VERIFY PASS marker 与结论不一致";
  if (!verifyEvidenceTable(text)) {
    return "VERIFY PASS 缺少非空的构建、测试或设备证据表";
  }
  return "";
}

function validateShortReport(text, maxChars) {
  if (!/^##\s*简短报告\s*$/im.test(text) || !hasExactLabels(text, ["原因", "措施"])) {
    return "简短报告缺少固定标题、原因或措施";
  }
  const report = `原因：${lineValue(text, "原因")}措施：${lineValue(text, "措施")}`;
  if (Array.from(report).length > maxChars) return `原因和措施超过 ${maxChars} 个 Unicode 字符`;
  return "";
}

function validateExpertReport(text) {
  const hasShort = /^##\s*简短报告\s*$/im.test(text) || /(?:^|\n)\s*简短报告\s*[:：]/i.test(text);
  const hasDetail = /^##\s*详细报告\s*$/im.test(text) || /(?:^|\n)\s*详细报告\s*[:：]/i.test(text);
  const hasHtml = /(?:HTML\s*路径|报告路径)\s*[:：].*(?:storydev:\/reports\/|\.html\b)/i.test(text);
  return hasShort && hasDetail && hasHtml ? "" : "专家报告输出缺少简短报告、详细报告或 HTML 路径";
}

export function validateCompatibilityWorkflowResult({ stageId, text, maxChars = 100 } = {}) {
  const source = String(text || "");
  const matches = [...source.matchAll(MARKER_PATTERN)];
  if (matches.length !== 1) {
    return failResult(source, matches.length ? "WORKFLOW_V2_COMPATIBILITY_MARKER_MULTIPLE" : "WORKFLOW_V2_COMPATIBILITY_MARKER_MISSING",
      matches.length ? "compatibility 输出必须恰好包含一个显式 marker" : "compatibility 输出缺少显式 marker", {
        markerCount: matches.length,
      });
  }
  const kind = markerKind(matches[0][1]);
  if (!expectedKinds(stageId).has(kind)) {
    return failResult(source, "WORKFLOW_V2_COMPATIBILITY_MARKER_STAGE_MISMATCH", "marker 与冻结 stage 不匹配", {
      stageId,
      markerKind: kind,
    });
  }
  let error = "";
  if (stageId === "TRIAGE") error = validateTriage(source, kind);
  else if (stageId === "REPAIR") error = validateRepair(source);
  else if (stageId === "VERIFY_EXECUTE") error = validateVerify(source, kind);
  else if (stageId === "REPORT_SHORT") error = validateShortReport(source, maxChars);
  else if (stageId === "REPORT_EXPERT") error = validateExpertReport(source);
  if (error) return failResult(source, "WORKFLOW_V2_COMPATIBILITY_RESULT_INCOMPLETE", error, { stageId, markerKind: kind });
  return {
    ok: true,
    code: null,
    error: null,
    markerKind: kind,
    cleaned: cleanMarkers(source),
  };
}
