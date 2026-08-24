import test from "node:test";
import assert from "node:assert/strict";
import {
  evaluateWorktreeBranchPair,
  listWorktreeBranchPairSpecs,
  summarizeBranchPairIssues,
} from "../services/devbench/worktree-branch-pairs.js";

test("基仓与登记来源分支不一致时给出提示", () => {
  const result = evaluateWorktreeBranchPair({
    name: "App",
    role: "primary",
    baseExists: true,
    worktreeExists: true,
    baseBranch: "develop",
    worktreeBranch: "story/Avatr_release_CARB_1",
    originalBranch: "release/v1",
    expectedWorktreeBranch: "story/Avatr_release_CARB_1",
  });
  assert.equal(result.ok, false);
  assert.equal(result.issues.some((issue) => issue.code === "base_branch_mismatch"), true);
  assert.equal(result.issues.some((issue) => issue.code === "worktree_branch_mismatch"), false);
});

test("worktree 偏离故事点登记分支时给出提示", () => {
  const result = evaluateWorktreeBranchPair({
    name: "SDK",
    role: "extra",
    baseExists: true,
    worktreeExists: true,
    baseBranch: "main",
    worktreeBranch: "feature/tmp",
    originalBranch: "main",
    expectedWorktreeBranch: "story/main_CARB_9",
  });
  assert.equal(result.ok, false);
  assert.equal(result.issues.some((issue) => issue.code === "worktree_branch_mismatch"), true);
});

test("对应关系正常时不告警", () => {
  const result = evaluateWorktreeBranchPair({
    name: "App",
    role: "primary",
    baseExists: true,
    worktreeExists: true,
    baseBranch: "release/v1",
    worktreeBranch: "story/Avatr_release_CARB_1",
    originalBranch: "release/v1",
    expectedWorktreeBranch: "story/Avatr_release_CARB_1",
  });
  assert.equal(result.ok, true);
  assert.equal(result.issues.length, 0);
});

test("listWorktreeBranchPairSpecs 跳过 inactive，并汇总 mismatches", () => {
  const specs = listWorktreeBranchPairSpecs({
    worktree: {
      managed: true,
      entries: [
        {
          role: "primary",
          name: "App",
          path: "/wt/a",
          worktreePath: "/wt/a",
          basePath: "/src/a",
          baseRepositoryPath: "/src/a",
          originalBranch: "main",
          branch: "story/a",
        },
        {
          role: "inactive",
          name: "Old",
          path: "/wt/old",
          basePath: "/src/old",
          branch: "story/old",
        },
      ],
    },
  });
  assert.equal(specs.length, 1);
  assert.equal(specs[0].name, "App");

  const summary = summarizeBranchPairIssues([
    evaluateWorktreeBranchPair({
      ...specs[0],
      baseExists: true,
      worktreeExists: true,
      baseBranch: "develop",
      worktreeBranch: "story/a",
    }),
  ]);
  assert.equal(summary.ok, false);
  assert.equal(summary.mismatchCount, 1);
});
