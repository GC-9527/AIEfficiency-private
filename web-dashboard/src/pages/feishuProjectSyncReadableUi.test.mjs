import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const pageSource = readFileSync(new URL("./FeishuProjectSync.jsx", import.meta.url), "utf8");
const policySource = readFileSync(new URL("./FeishuSyncPolicyPanel.jsx", import.meta.url), "utf8");

test("current effective rules render policy routing conditions in readable form", () => {
  assert.match(pageSource, /data-testid="current-effective-routing-rules"/);
  assert.match(pageSource, /activePolicyRules\.map/);
  assert.match(pageSource, /policyRuleSummary\(rule, routing\)/);
  assert.match(pageSource, /summary\.conditionText/);
  assert.match(policySource, /policyConditionSummary\(condition\)/);
  assert.match(policySource, /data-testid=\{`policy-rule-summary-/);
});

test("Feishu sync selectors use names as primary text and keep IDs in technical details", () => {
  assert.doesNotMatch(pageSource, /TB 测试项目 Project ID/);
  assert.doesNotMatch(pageSource, /\{project\.name \|\| project\.id\} · \{project\.id\}/);
  assert.doesNotMatch(pageSource, /\{tasklistId \|\| "-"\}<\/code>/);
  assert.match(pageSource, /查看项目技术标识/);
  assert.match(pageSource, /查看任务列表技术标识/);
  assert.match(pageSource, /查看迭代技术标识/);
  assert.match(pageSource, /项目显示名称/);
  assert.match(pageSource, /任务列表显示名称/);
  assert.match(pageSource, /默认负责人姓名/);
});

test("policy targets and field mappings require readable names beside technical identifiers", () => {
  assert.match(policySource, /默认负责人姓名/);
  assert.match(policySource, /项目名称未解析/);
  assert.match(policySource, /任务列表名称未解析/);
  assert.match(policySource, /技术标识（仅下拉无法解析或排障时编辑）/);
  assert.match(pageSource, /TB 自定义字段名称/);
  assert.match(pageSource, /字段技术标识/);
  assert.match(pageSource, /显示名称未解析（请补充名称）/);
});
