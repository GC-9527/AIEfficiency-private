import test from "node:test";
import assert from "node:assert/strict";
import {
  canPromoteWorktreeExtra,
  selectedBaseProjectPaths,
} from "./worktreeProjectModel.mjs";

test("关联工程使用基仓身份判断是否可提升为主工程", () => {
  const worktree = {
    managed: true,
    entries: [{
      role: "extra",
      baseProjectId: "sdk-base",
      basePath: "D:\\repos\\sdk",
      path: "D:\\worktrees\\story\\sdk",
    }],
  };
  const projects = [{ id: "sdk-base", path: "D:\\repos\\sdk" }];
  assert.equal(canPromoteWorktreeExtra({
    projects,
    worktree,
    extraPath: "D:\\worktrees\\story\\sdk",
  }), true);
});

test("关联工程下拉用基仓路径排除当前故事点已选仓库", () => {
  const selected = selectedBaseProjectPaths({
    managed: true,
    entries: [
      { role: "primary", basePath: "D:\\repos\\app", path: "D:\\worktrees\\story\\app" },
      { role: "extra", basePath: "D:\\repos\\sdk", path: "D:\\worktrees\\story\\sdk" },
      {
        role: "inactive",
        active: false,
        basePath: "D:\\repos\\removed",
        path: "D:\\worktrees\\story\\removed",
      },
    ],
  });
  assert.equal(selected.has("d:/repos/app"), true);
  assert.equal(selected.has("d:/repos/sdk"), true);
  assert.equal(selected.has("d:/repos/removed"), false);
  assert.equal(selected.has("d:/worktrees/story/sdk"), false);
});
