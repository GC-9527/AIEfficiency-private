import test from "node:test";
import assert from "node:assert/strict";
import {
  pullRequestChangeSummary,
  pullRequestPreviewView,
} from "./pullRequestPreviewModel.mjs";

test("PR preview only selects ready projects with concrete paths", () => {
  const view = pullRequestPreviewView({
    results: [
      { path: "D:/repo/app", status: "ready", eligible: true, aheadCount: 2 },
      { path: "D:/repo/sdk", status: "no_changes", eligible: false },
      { path: "D:/repo/web", status: "blocked", eligible: false },
      { path: "", status: "ready", eligible: true, dirtyCount: 1 },
    ],
  });

  assert.equal(view.total, 4);
  assert.equal(view.eligible, 1);
  assert.equal(view.noChanges, 1);
  assert.equal(view.blocked, 1);
  assert.deepEqual(view.executionPaths, ["D:/repo/app"]);
  assert.equal(view.canExecute, true);
});

test("PR preview disables execution when every project has no new commit", () => {
  const view = pullRequestPreviewView({
    results: [
      { path: "D:/repo/app", status: "no_changes", eligible: false },
      { path: "D:/repo/sdk", status: "no_changes", eligible: false },
    ],
  });

  assert.equal(view.eligible, 0);
  assert.equal(view.noChanges, 2);
  assert.equal(view.canExecute, false);
  assert.deepEqual(view.executionPaths, []);
});

test("global blocker overrides otherwise eligible projects", () => {
  const view = pullRequestPreviewView({
    globalBlocker: "未解析到故事点编号",
    results: [{ path: "D:/repo/app", status: "ready", eligible: true }],
  });

  assert.equal(view.eligible, 1);
  assert.equal(view.canExecute, false);
});

test("StoryDev warning keeps eligible no-TB projects executable", () => {
  const view = pullRequestPreviewView({
    globalWarning: "当前故事点未关联 TB/CARB，将使用 [StoryDev:20260729140506] 创建 PR",
    results: [{ path: "D:/repo/app", status: "ready", eligible: true }],
  });

  assert.equal(view.globalBlocker, "");
  assert.match(view.globalWarning, /\[StoryDev:20260729140506\]/);
  assert.equal(view.canExecute, true);
});

test("PR change summary combines committed and local work", () => {
  assert.equal(
    pullRequestChangeSummary({ aheadCount: 3, dirtyCount: 2 }),
    "3 个新增提交 · 2 项本地改动待自动提交",
  );
  assert.equal(pullRequestChangeSummary({ aheadCount: 0, dirtyCount: 0 }), "");
});
