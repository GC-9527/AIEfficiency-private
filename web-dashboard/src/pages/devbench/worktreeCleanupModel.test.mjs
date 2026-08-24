import test from "node:test";
import assert from "node:assert/strict";
import {
  WORKTREE_FORCE_UNLOCK_MS,
  storyWorktreeDisplayPath,
  worktreeCleanupBlockerHelp,
  worktreeCleanupCanConfirm,
  worktreeCleanupCanForce,
  worktreeCleanupCards,
  worktreeCleanupForceStatus,
  worktreeMutationEntryDisabled,
} from "./worktreeCleanupModel.mjs";

test("陈旧 runningTaskId 不会隐藏 worktree 检查入口，当前页面活跃任务仍会禁用", () => {
  assert.equal(worktreeMutationEntryDisabled({
    liveRunning: false,
    persistedRunningTaskId: "stale-task-id",
  }), false);
  assert.equal(worktreeMutationEntryDisabled({
    liveRunning: true,
    persistedRunningTaskId: "",
  }), true);
});

test("安全清理卡片分别展示 dirty、未推送提交和 stash", () => {
  const cards = worktreeCleanupCards({
    totals: { dirty: 2, unpushed: 3, stashes: 1 },
  });
  assert.deepEqual(cards.map((card) => [card.key, card.safe, card.count]), [
    ["dirty", false, 2],
    ["unpushed", false, 3],
    ["stashes", false, 1],
  ]);
  assert.match(cards[1].statusText, /3 个提交/);
});

test("只有最新检查安全且用户确认时才能执行清理", () => {
  const ready = { available: true, safe: true, token: "token" };
  assert.equal(worktreeCleanupCanConfirm(ready, false), false);
  assert.equal(worktreeCleanupCanConfirm(ready, true), true);
  assert.equal(worktreeCleanupCanConfirm({ ...ready, safe: false }, true), false);
  assert.equal(worktreeCleanupCanConfirm({ ...ready, token: "" }, true), false);
});

test("阻断原因给出可操作的处理建议", () => {
  assert.match(worktreeCleanupBlockerHelp({ type: "dirty" }), /提交/);
  assert.match(worktreeCleanupBlockerHelp({ type: "unpushed" }), /Push/);
  assert.match(worktreeCleanupBlockerHelp({ type: "stash" }), /恢复/);
  assert.match(worktreeCleanupBlockerHelp({ type: "running_task" }), /AI 任务/);
});

test("强制删除需勾选确认且延迟解锁后才可点，不能绕过运行中的 AI 任务", () => {
  const blocked = {
    available: true,
    safe: false,
    forceAllowed: true,
    token: "token",
    blockers: [{ type: "dirty" }],
  };
  assert.equal(WORKTREE_FORCE_UNLOCK_MS, 2000);
  assert.equal(worktreeCleanupCanForce(blocked, false, true), false);
  assert.equal(worktreeCleanupCanForce(blocked, true, false), false);
  assert.equal(worktreeCleanupCanForce(blocked, true, true), true);
  assert.equal(worktreeCleanupCanForce({ ...blocked, token: "" }, true, true), false);
  assert.equal(worktreeCleanupCanForce({
    ...blocked,
    blockers: [{ type: "running_task" }],
  }, true, true), false);
  assert.equal(worktreeCleanupCanForce({
    ...blocked,
    forceAllowed: false,
    blockers: [{ type: "inspection" }],
  }, true, true), false);
});

test("旧 Gateway 缺少 forceAllowed 时安全禁用强制删除并识别为能力未加载", () => {
  const inspection = {
    available: true,
    safe: false,
    token: "token",
    blockers: [{ type: "dirty", message: "存在未提交文件" }],
  };
  assert.deepEqual(worktreeCleanupForceStatus(inspection), {
    kind: "gateway_capability_missing",
    blocked: true,
    blockers: [],
  });
  assert.equal(
    worktreeCleanupCanForce(inspection, true, true),
    false,
  );
});

test("forceAllowed=true 时开放强制删除能力", () => {
  assert.deepEqual(worktreeCleanupForceStatus({
    available: true,
    forceAllowed: true,
    blockers: [{ type: "dirty" }],
  }), {
    kind: "allowed",
    blocked: false,
    blockers: [],
  });
});

test("forceAllowed=false 时保留后端返回的真实 blocker", () => {
  const blockers = [
    { type: "running_task", message: "当前故事点仍有 AI 任务运行" },
    { type: "inspection", message: "worktree Git 归属校验失败" },
  ];
  assert.deepEqual(worktreeCleanupForceStatus({
    available: true,
    forceAllowed: false,
    blockers,
  }), {
    kind: "blocked",
    blocked: true,
    blockers,
  });
});

test("横幅展示路径优先用主工程真实 path", () => {
  const display = storyWorktreeDisplayPath({
    worktree: {
      root: "C:/wt/story-root",
      entries: [
        {
          role: "primary",
          name: "App",
          path: "C:/wt/story-root/Flavor_main_CARB_1",
          worktreePath: "C:/wt/story-root/Flavor_main_CARB_1",
          branch: "story/Flavor_main_CARB_1",
        },
      ],
    },
  });
  assert.equal(display.path, "C:/wt/story-root/Flavor_main_CARB_1");
  assert.equal(display.branch, "story/Flavor_main_CARB_1");
  assert.notEqual(display.path, display.root);
});
