import test from "node:test";
import assert from "node:assert/strict";
import {
  WORKTREE_FORCE_CONFIRMATION,
  WORKTREE_FORCE_UNLOCK_MS,
  buildWorktreeRebuildConfirmBody,
  isWorktreeRebuildConfirmRequired,
  worktreeRebuildCanForceConfirm,
  worktreeRebuildCanSafeConfirm,
  worktreeRebuildDeleteRows,
  worktreeRebuildReasonLabels,
} from "./worktreeRebuildModel.mjs";

test("isWorktreeRebuildConfirmRequired 仅识别确认码与预览", () => {
  assert.equal(isWorktreeRebuildConfirmRequired({
    ok: false,
    code: "WORKTREE_REBUILD_CONFIRM_REQUIRED",
    data: { preview: { needed: true } },
  }), true);
  assert.equal(isWorktreeRebuildConfirmRequired({
    ok: false,
    code: "WORKTREE_CLEANUP_BLOCKED",
    data: { preview: { needed: true } },
  }), false);
  assert.equal(isWorktreeRebuildConfirmRequired({
    ok: false,
    code: "WORKTREE_REBUILD_CONFIRM_REQUIRED",
    data: {},
  }), false);
});

test("预览文案与删除行整理", () => {
  const preview = {
    reasons: [{ code: "naming_changed", label: "Flavor 变化" }, { code: "x" }],
    deleteEntries: [
      { name: "App", role: "primary", path: "/a", branch: "story/a", inactive: false },
      { name: "Old", role: "inactive", path: "/b", branch: "story/b", inactive: true },
    ],
  };
  assert.deepEqual(worktreeRebuildReasonLabels(preview), ["Flavor 变化", "x"]);
  const rows = worktreeRebuildDeleteRows(preview);
  assert.equal(rows[0].title, "App");
  assert.match(rows[1].title, /inactive/);
});

test("确认 body 附带 cleanup token；强制删除自动附带确认词", () => {
  assert.deepEqual(buildWorktreeRebuildConfirmBody({ path: "/p", flavor: "A" }, {
    token: "tok",
    force: false,
  }), {
    path: "/p",
    flavor: "A",
    confirmRebuild: true,
    cleanupToken: "tok",
    forceCleanup: false,
    cleanupConfirmation: "",
  });
  assert.deepEqual(buildWorktreeRebuildConfirmBody({ projectId: "p2" }, {
    token: "tok2",
    force: true,
  }), {
    projectId: "p2",
    confirmRebuild: true,
    cleanupToken: "tok2",
    forceCleanup: true,
    cleanupConfirmation: WORKTREE_FORCE_CONFIRMATION,
  });
});

test("安全确认与强制确认门闸（延迟解锁）", () => {
  assert.equal(WORKTREE_FORCE_UNLOCK_MS, 2000);
  const safe = {
    available: true,
    safe: true,
    token: "t",
    forceAllowed: true,
    blockers: [],
  };
  assert.equal(worktreeRebuildCanSafeConfirm(safe, true), true);
  assert.equal(worktreeRebuildCanSafeConfirm(safe, false), false);

  const blocked = {
    available: true,
    safe: false,
    token: "t",
    forceAllowed: true,
    blockers: [{ type: "dirty" }],
  };
  assert.equal(worktreeRebuildCanForceConfirm(blocked, true, true), true);
  assert.equal(worktreeRebuildCanForceConfirm(blocked, true, false), false);
  assert.equal(worktreeRebuildCanForceConfirm({
    ...blocked,
    forceAllowed: false,
  }, true, true), false);
});
