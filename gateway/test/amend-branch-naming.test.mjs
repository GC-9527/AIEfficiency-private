/**
 * 分支名「末尾 +1」推导单元测试（Amend 本地改动 / Git 提交整理共用）。
 *
 * 关键合同：
 * - 业务单号分支（…_CARB_14189）：CARB_<数字> 是整体单号，绝不递增单号数字；
 *   …_CARB_14189 → …_CARB_14189_1（首次追加修正序号），…_CARB_14189_1 → …_CARB_14189_2（序号 +1）。
 * - 普通分支保持原行为：末尾连续数字 +1（保留前导零）；无数字尾号直接追加 1。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { isBusinessTicketBranch, nextBranchSuffix } from "../services/devbench/branch-naming.js";

test("业务单号分支：CARB_14189 保持单号整体，首次追加 _1（用户需求核心）", () => {
  assert.equal(nextBranchSuffix("XXX/xxx_CARB_14189"), "XXX/xxx_CARB_14189_1");
  assert.equal(nextBranchSuffix("story/release/geely_p155_CARB_13851"), "story/release/geely_p155_CARB_13851_1");
});

test("业务单号分支：已带修正序号时递增序号而非单号", () => {
  assert.equal(nextBranchSuffix("XXX/xxx_CARB_14189_1"), "XXX/xxx_CARB_14189_2");
  assert.equal(nextBranchSuffix("XXX/xxx_CARB_14189_9"), "XXX/xxx_CARB_14189_10");
  assert.equal(nextBranchSuffix("XXX/xxx_CARB_14189_10"), "XXX/xxx_CARB_14189_11");
});

test("业务单号识别大小写不敏感", () => {
  assert.equal(isBusinessTicketBranch("story/x_carb_123"), true);
  assert.equal(nextBranchSuffix("story/x_carb_123"), "story/x_carb_123_1");
  assert.equal(nextBranchSuffix("story/x_Carb_123_2"), "story/x_Carb_123_3");
});

test("普通分支保持原行为：末尾数字 +1、无数字追加 1、时间戳前导零保留", () => {
  assert.equal(nextBranchSuffix("feature/abc"), "feature/abc1");
  assert.equal(nextBranchSuffix("feature/login9"), "feature/login10");
  assert.equal(nextBranchSuffix("story/x_08051624471"), "story/x_08051624472");
  // 时间戳类（非 CARB 单号）依旧按原长度补零递增
  assert.equal(nextBranchSuffix("story/x_0805162447"), "story/x_0805162448");
});

test("非业务单号的普通数字尾号（如开发分支后缀）不改变既有 +1 语义", () => {
  assert.equal(nextBranchSuffix("feature/login9"), "feature/login10");
  assert.equal(nextBranchSuffix("feature/login99"), "feature/login100");
  assert.equal(nextBranchSuffix("dev/20260806"), "dev/20260807");
});
