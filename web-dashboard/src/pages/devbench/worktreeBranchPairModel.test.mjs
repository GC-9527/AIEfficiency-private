import test from "node:test";
import assert from "node:assert/strict";
import {
  branchPairHeadline,
  hasBranchPairMismatches,
  roleLabel,
} from "./worktreeBranchPairModel.mjs";

test("roleLabel 映射主工程/关联工程", () => {
  assert.equal(roleLabel("primary"), "主工程");
  assert.equal(roleLabel("extra"), "关联工程");
  assert.equal(roleLabel("webapp"), "WebApp");
});

test("hasBranchPairMismatches 仅在有异常时为真", () => {
  assert.equal(hasBranchPairMismatches(null), false);
  assert.equal(hasBranchPairMismatches({ available: true, ok: true, mismatchCount: 0 }), false);
  assert.equal(hasBranchPairMismatches({ available: true, ok: false, mismatchCount: 2 }), true);
});

test("branchPairHeadline 文案", () => {
  assert.match(branchPairHeadline({ mismatchCount: 1, issueCount: 2 }), /1 个工程/);
  assert.match(branchPairHeadline({ mismatchCount: 3, issueCount: 5 }), /3 个工程/);
});
