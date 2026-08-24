export const DEFAULT_WEEKLY_TEMPLATE = {
  id: "weekly",
  name: "周报",
  source: "系统默认",
  content: [
    "本周完成工作",
    "下周工作计划",
    "本周工作总结",
    "需协调与帮助",
    "图片",
    "附件",
  ].join("\n"),
};

const CUSTOM_TEMPLATE_LIMIT = 10;
const TEMPLATE_CONTENT_LIMIT = 8000;

function clean(value) {
  return String(value || "").trim();
}

export function normalizeSummaryOutputModes(value = {}) {
  return {
    concise: value.concise !== false,
    report: value.report === true,
  };
}

export function hasSummaryOutputMode(value = {}) {
  const modes = normalizeSummaryOutputModes(value);
  return modes.concise || modes.report;
}

export function normalizeCustomSummaryTemplates(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  return value
    .map((item) => {
      const id = clean(item?.id);
      const name = clean(item?.name).slice(0, 80);
      const content = clean(item?.content).slice(0, TEMPLATE_CONTENT_LIMIT);
      if (!id || !name || !content || id === DEFAULT_WEEKLY_TEMPLATE.id || seen.has(id)) return null;
      seen.add(id);
      return { id, name, content, source: clean(item?.source) || "上传文件 AI 生成" };
    })
    .filter(Boolean)
    .slice(0, CUSTOM_TEMPLATE_LIMIT);
}

export function addCustomSummaryTemplate(existing, item) {
  const normalized = normalizeCustomSummaryTemplates([item]);
  if (!normalized.length) return normalizeCustomSummaryTemplates(existing);
  return normalizeCustomSummaryTemplates([
    normalized[0],
    ...normalizeCustomSummaryTemplates(existing).filter((entry) => entry.id !== normalized[0].id),
  ]);
}

export function summaryResultFiles(result) {
  if (Array.isArray(result?.outputs)) {
    return result.outputs.filter((item) => item?.file).map((item) => ({
      key: clean(item.key),
      label: clean(item.label) || "工作总结",
      file: clean(item.file),
      note: clean(item.note),
    }));
  }
  return [
    result?.txtFile ? { key: "concise-txt", label: "简洁版", file: result.txtFile, note: "纯文本" } : null,
    result?.mdFile ? { key: "report-md", label: "报告版", file: result.mdFile, note: "Markdown" } : null,
    result?.docxFile ? { key: "report-docx", label: "报告版", file: result.docxFile, note: "Word" } : null,
    result?.pdfFile ? { key: "report-pdf", label: "报告版", file: result.pdfFile, note: "PDF" } : null,
  ].filter(Boolean);
}
