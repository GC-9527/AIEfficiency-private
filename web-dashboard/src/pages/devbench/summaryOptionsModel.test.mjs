import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_WEEKLY_TEMPLATE,
  addCustomSummaryTemplate,
  hasSummaryOutputMode,
  normalizeCustomSummaryTemplates,
  normalizeSummaryOutputModes,
  summaryResultFiles,
} from "./summaryOptionsModel.js";

test("默认周报模板与设计图六个区域一致", () => {
  assert.equal(DEFAULT_WEEKLY_TEMPLATE.name, "周报");
  assert.deepEqual(DEFAULT_WEEKLY_TEMPLATE.content.split("\n"), [
    "本周完成工作",
    "下周工作计划",
    "本周工作总结",
    "需协调与帮助",
    "图片",
    "附件",
  ]);
});

test("输出版本默认只生成高效简洁版，也允许同时勾选两个版本", () => {
  assert.deepEqual(normalizeSummaryOutputModes(), { concise: true, report: false });
  assert.deepEqual(normalizeSummaryOutputModes({ concise: true, report: true }), { concise: true, report: true });
  assert.equal(hasSummaryOutputMode({ concise: false, report: false }), false);
});

test("上传文件生成的模板去重、限制数量并可持久化", () => {
  const templates = addCustomSummaryTemplate([], {
    id: "uploaded-1",
    name: "项目周报",
    content: "成果\n计划",
  });
  assert.equal(templates.length, 1);
  assert.equal(templates[0].source, "上传文件 AI 生成");
  assert.deepEqual(normalizeCustomSummaryTemplates([templates[0], templates[0]]), templates);
});

test("生成结果优先展示服务端 outputs 清单", () => {
  assert.deepEqual(summaryResultFiles({
    outputs: [
      { key: "concise-txt", label: "简洁版", file: "a.txt", note: "纯文本" },
      { key: "report-md", label: "报告版", file: "a.md", note: "Markdown" },
    ],
  }).map((item) => item.file), ["a.txt", "a.md"]);
});
