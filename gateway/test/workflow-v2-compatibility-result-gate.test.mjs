import { test } from "node:test";
import assert from "node:assert/strict";
import { validateCompatibilityWorkflowResult } from "../services/devbench/workflow-v2/compatibility-result-gate.js";

test("compatibility result gate 要求恰好一个与冻结 stage 匹配的显式 marker", () => {
  const naturalOnly = validateCompatibilityWorkflowResult({
    stageId: "TRIAGE",
    text: "## 甄别结论\n结论：本侧问题\n原因：实现缺陷\n依据：ev-1\n未读：无",
  });
  assert.equal(naturalOnly.ok, false);
  assert.equal(naturalOnly.code, "WORKFLOW_V2_COMPATIBILITY_MARKER_MISSING");

  const multiple = validateCompatibilityWorkflowResult({
    stageId: "TRIAGE",
    text: "## 甄别结论\n结论：本侧问题\n原因：实现缺陷\n依据：ev-1\n未读：无\n<!-- TRIAGE: IS_BUG -->\n<!-- TRIAGE: NOT_A_BUG -->",
  });
  assert.equal(multiple.ok, false);
  assert.equal(multiple.code, "WORKFLOW_V2_COMPATIBILITY_MARKER_MULTIPLE");

  const mismatch = validateCompatibilityWorkflowResult({
    stageId: "REPAIR",
    text: "## 修复结果\n原因：缺陷\n措施：修复\n改动：a.js\n验证：测试通过\n风险：无\n<!-- VERIFY: PASS -->",
  });
  assert.equal(mismatch.ok, false);
  assert.equal(mismatch.code, "WORKFLOW_V2_COMPATIBILITY_MARKER_STAGE_MISMATCH");
});

test("五种 compatibility stage 的完整结果通过，marker 会从 cleaned 中移除", () => {
  const cases = [
    ["TRIAGE", "triage_is_bug", "## 甄别结论\n结论：本侧问题\n原因：实现缺陷\n依据：ev-1\n未读：无\n<!-- TRIAGE: IS_BUG -->"],
    ["REPAIR", "fix_done", "## 修复结果\n原因：边界错误\n措施：增加校验\n改动：src/a.js\n验证：单元测试 PASS\n风险：无\n<!-- FIX_DONE -->"],
    ["VERIFY_EXECUTE", "verify_pass", "## 验收结果\n结论：通过\n范围：设备 AppMock\n用例：见证据表\n| 证据类型 | 结果 | 稳定引用 |\n| --- | --- | --- |\n| 构建 | PASS | receipt-build-001 |\n| 测试 | PASS | evidence-test-001 |\n| 设备 | PASS | storydev:/workflow-v2/evidence-blobs/device-001.blob |\n遗留：无\n<!-- VERIFY: PASS -->"],
    ["REPORT_SHORT", "report_done", "## 简短报告\n原因：边界错误\n措施：增加校验\n<!-- REPORT_DONE -->"],
    ["REPORT_EXPERT", "report_done", "## 简短报告\n原因：边界错误\n措施：增加校验\n## 详细报告\n完整证据见正文\nHTML 路径：storydev:/reports/acceptance-report.html\n<!-- REPORT_DONE -->"],
  ];
  for (const [stageId, markerKind, text] of cases) {
    const result = validateCompatibilityWorkflowResult({ stageId, text, maxChars: 100 });
    assert.equal(result.ok, true, `${stageId}: ${result.error}`);
    assert.equal(result.markerKind, markerKind, stageId);
    assert.doesNotMatch(result.cleaned, /<!--\s*(?:TRIAGE|VERIFY|FIX_DONE|REPORT_DONE)/i, stageId);
  }
});

test("结构缺失、无验证和无证据的完成声明 fail closed", () => {
  const insufficientTriage = validateCompatibilityWorkflowResult({
    stageId: "TRIAGE",
    text: "## 甄别结论\n结论：证据不足\n原因：材料缺失\n依据：无\n未读：日志\n<!-- TRIAGE: IS_BUG -->",
  });
  assert.equal(insufficientTriage.ok, false);
  assert.equal(insufficientTriage.code, "WORKFLOW_V2_COMPATIBILITY_RESULT_INCOMPLETE");

  const unverifiedRepair = validateCompatibilityWorkflowResult({
    stageId: "REPAIR",
    text: "## 修复结果\n原因：缺陷\n措施：修复\n改动：a.js\n验证：未测试\n风险：无\n<!-- FIX_DONE -->",
  });
  assert.equal(unverifiedRepair.ok, false);

  const verifyWithoutDevice = validateCompatibilityWorkflowResult({
    stageId: "VERIFY_EXECUTE",
    text: "## 验收结果\n结论：通过\n范围：本地\n用例：构建 PASS；测试 PASS\n遗留：无\n<!-- VERIFY: PASS -->",
  });
  assert.equal(verifyWithoutDevice.ok, false);
  assert.match(verifyWithoutDevice.error, /设备证据/);
});

test("结论与 marker 矛盾、失败验证和无 evidence table 的成功自报全部 fail closed", () => {
  const triageContradiction = validateCompatibilityWorkflowResult({
    stageId: "TRIAGE",
    text: "## 甄别结论\n结论：非本侧问题\n原因：依赖方行为\n依据：evidence-triage-001\n未读：无\n<!-- TRIAGE: IS_BUG -->",
  });
  assert.equal(triageContradiction.ok, false);
  assert.equal(triageContradiction.code, "WORKFLOW_V2_COMPATIBILITY_RESULT_INCOMPLETE");

  for (const [conclusion, marker] of [
    ["疑似本侧问题", "IS_BUG"],
    ["可能是本侧问题", "IS_BUG"],
    ["倾向非本侧问题", "NOT_A_BUG"],
    ["大概率为跨组件", "IS_BUG"],
  ]) {
    const uncertainTriage = validateCompatibilityWorkflowResult({
      stageId: "TRIAGE",
      text: `## 甄别结论\n结论：${conclusion}\n原因：证据尚不确定\n依据：evidence-uncertain\n未读：无\n<!-- TRIAGE: ${marker} -->`,
    });
    assert.equal(uncertainTriage.ok, false, conclusion);
    assert.equal(uncertainTriage.code, "WORKFLOW_V2_COMPATIBILITY_RESULT_INCOMPLETE", conclusion);
  }

  const verifyContradiction = validateCompatibilityWorkflowResult({
    stageId: "VERIFY_EXECUTE",
    text: "## 验收结果\n结论：失败\n范围：设备 AppMock\n用例：见证据表\n| 证据类型 | 结果 | 稳定引用 |\n| --- | --- | --- |\n| 构建 | PASS | receipt-build-002 |\n| 测试 | PASS | evidence-test-002 |\n| 设备 | PASS | storydev:/workflow-v2/evidence-blobs/device-002.blob |\n遗留：存在失败项\n<!-- VERIFY: PASS -->",
  });
  assert.equal(verifyContradiction.ok, false);
  assert.equal(verifyContradiction.code, "WORKFLOW_V2_COMPATIBILITY_RESULT_INCOMPLETE");

  for (const verification of [
    "未执行，环境不可用",
    "失败",
    "FAIL",
    "全部测试失败",
    "已执行，结果未知",
    "检查完成，结果待确认",
    "测试完成，未说明是否通过",
    "已验证，尚无结论",
    "未成功",
    "尚未成功",
    "可能通过",
    "疑似成功",
    "大概率通过",
    "基本通过",
    "不成功",
    "成功率0%",
    "通过率0%",
    "PASS?",
  ]) {
    const repairWithoutSuccessfulVerification = validateCompatibilityWorkflowResult({
      stageId: "REPAIR",
      text: `## 修复结果\n原因：边界错误\n措施：增加校验\n改动：src/a.js\n验证：${verification}\n风险：环境尚不可用\n<!-- FIX_DONE -->`,
    });
    assert.equal(repairWithoutSuccessfulVerification.ok, false, verification);
    assert.equal(repairWithoutSuccessfulVerification.code, "WORKFLOW_V2_COMPATIBILITY_RESULT_INCOMPLETE", verification);
  }

  const verifyWithoutEvidenceTable = validateCompatibilityWorkflowResult({
    stageId: "VERIFY_EXECUTE",
    text: "## 验收结果\n结论：通过\n范围：构建通过；测试通过；设备通过\n用例：全部通过\n遗留：无\n<!-- VERIFY: PASS -->",
  });
  assert.equal(verifyWithoutEvidenceTable.ok, false);
  assert.equal(verifyWithoutEvidenceTable.code, "WORKFLOW_V2_COMPATIBILITY_RESULT_INCOMPLETE");

  for (const table of [
    "| 证据类型 | 结果 | 稳定引用 |\n| --- | --- | --- |\n| 构建测试设备 | PASS | receipt-one |",
    "| 证据类型 | 结果 | 稳定引用 |\n| --- | --- | --- |\n| 构建 | PASS | receipt-shared |\n| 测试 | PASS | receipt-shared |\n| 设备 | PASS | receipt-shared |",
  ]) {
    const nonIndependentEvidence = validateCompatibilityWorkflowResult({
      stageId: "VERIFY_EXECUTE",
      text: `## 验收结果\n结论：通过\n范围：AppMock\n用例：见证据表\n${table}\n遗留：无\n<!-- VERIFY: PASS -->`,
    });
    assert.equal(nonIndependentEvidence.ok, false, table);
    assert.equal(nonIndependentEvidence.code, "WORKFLOW_V2_COMPATIBILITY_RESULT_INCOMPLETE", table);
  }

  for (const [stageId, text] of [
    ["TRIAGE", "## 甄别结论\n结论：本侧问题\n结论：证据不足\n原因：冲突\n依据：evidence-1\n未读：无\n<!-- TRIAGE: IS_BUG -->"],
    ["REPAIR", "## 修复结果\n原因：缺陷\n措施：修复\n改动：a.js\n验证：PASS\n验证：失败\n风险：无\n<!-- FIX_DONE -->"],
    ["VERIFY_EXECUTE", "## 验收结果\n结论：通过\n结论：失败\n范围：AppMock\n用例：见表\n| 证据类型 | 结果 | 稳定引用 |\n| --- | --- | --- |\n| 构建 | PASS | receipt-build-dup |\n| 测试 | PASS | receipt-test-dup |\n| 设备 | PASS | receipt-device-dup |\n遗留：无\n<!-- VERIFY: PASS -->"],
  ]) {
    const duplicateControlLabel = validateCompatibilityWorkflowResult({ stageId, text });
    assert.equal(duplicateControlLabel.ok, false, stageId);
    assert.equal(duplicateControlLabel.code, "WORKFLOW_V2_COMPATIBILITY_RESULT_INCOMPLETE", stageId);
  }
});

test("短报告按 Unicode 字符限制原因和措施，emoji 不按 UTF-16 双计数", () => {
  const within = validateCompatibilityWorkflowResult({
    stageId: "REPORT_SHORT",
    maxChars: 8,
    text: "## 简短报告\n原因：😀\n措施：好\n<!-- REPORT_DONE -->",
  });
  assert.equal(within.ok, true);

  const over = validateCompatibilityWorkflowResult({
    stageId: "REPORT_SHORT",
    maxChars: 7,
    text: "## 简短报告\n原因：😀\n措施：好\n<!-- REPORT_DONE -->",
  });
  assert.equal(over.ok, false);
  assert.match(over.error, /超过 7 个 Unicode 字符/);
});
