/**
 * 前端分支名预览（branchNamingPreview.mjs）与后端 branch-naming.js 一致性测试：
 * 业务单号分支 …_CARB_14189 保持单号整体、追加/递增修正序号；普通分支保持原 +1 语义。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { isBusinessTicketBranch, branchPreview } from "./branchNamingPreview.mjs";
import { isBusinessTicketBranch as serverIsTicket, nextBranchSuffix } from "../../../../gateway/services/devbench/branch-naming.js";

test("前端预览：CARB 单号分支保持整体、追加 _1（用户需求核心）", () => {
  assert.equal(branchPreview("XXX/xxx_CARB_14189"), "XXX/xxx_CARB_14189_1");
  assert.equal(branchPreview("XXX/xxx_CARB_14189_1"), "XXX/xxx_CARB_14189_2");
  assert.equal(branchPreview("XXX/xxx_CARB_14189_9"), "XXX/xxx_CARB_14189_10");
});

test("前端预览：普通分支保持原行为", () => {
  assert.equal(branchPreview("feature/abc"), "feature/abc1");
  assert.equal(branchPreview("feature/login9"), "feature/login10");
  assert.equal(branchPreview("story/x_08051624471"), "story/x_08051624472");
  assert.equal(branchPreview(""), "");
});

test("前端预览与后端 branch-naming 结果一致", () => {
  const cases = [
    "XXX/xxx_CARB_14189",
    "XXX/xxx_CARB_14189_1",
    "story/geely_p155_CARB_13851",
    "story/x_carb_123",
    "feature/login9",
    "story/x_08051624471",
    "feature/abc",
  ];
  for (const branch of cases) {
    assert.equal(branchPreview(branch), nextBranchSuffix(branch), `预览与后端不一致: ${branch}`);
  }
  assert.equal(isBusinessTicketBranch("story/x_carb_1"), serverIsTicket("story/x_carb_1"));
});
