import assert from "node:assert/strict";
import test from "node:test";
import {
  createStoryReopenReviewScope,
  validateStoryReopenReviewRun,
  validateStoryReopenScope,
} from "../services/devbench/story-reopen-review.js";

function closedStory(id, closedAt, extra = {}) {
  return {
    id,
    title: `故事点 ${id}`,
    closedAt,
    mode: "local",
    primaryProjectId: `project-${id}`,
    flavors: ["demoProd"],
    ...extra,
  };
}

test("重开复核范围由服务端冻结整组成员和配置，不能跨故事或 owner 复用", () => {
  const closed = [
    closedStory("story-a", 100, { groupId: "group-1", groupClosedAt: 90 }),
    closedStory("story-b", 100, { groupId: "group-1", groupClosedAt: 90 }),
    closedStory("story-c", 110),
  ];
  const issued = createStoryReopenReviewScope(closed, "story-a", {
    ownerId: "owner-a",
    trigger: "task_group_execute",
    now: 120,
  });
  assert.equal(issued.ok, true);
  assert.deepEqual(issued.data.storyIds.map((row) => row.id), ["story-a", "story-b"]);

  assert.equal(validateStoryReopenScope(issued.data, {
    closedTabs: closed,
    storyId: "story-b",
    ownerId: "owner-a",
    trigger: "task_group_execute",
  }).ok, true);
  assert.equal(validateStoryReopenScope(issued.data, {
    closedTabs: closed,
    storyId: "story-c",
    ownerId: "owner-a",
    trigger: "task_group_execute",
  }).code, "STORY_REOPEN_AI_REVIEW_SCOPE_MISMATCH");
  assert.equal(validateStoryReopenScope(issued.data, {
    closedTabs: closed,
    storyId: "story-a",
    ownerId: "owner-b",
    trigger: "task_group_execute",
  }).code, "STORY_REOPEN_AI_REVIEW_OWNER_MISMATCH");

  const changed = closed.map((row) => row.id === "story-b" ? { ...row, flavors: ["otherProd"] } : row);
  assert.equal(validateStoryReopenScope(issued.data, {
    closedTabs: changed,
    storyId: "story-a",
    ownerId: "owner-a",
    trigger: "task_group_execute",
  }).code, "STORY_REOPEN_AI_REVIEW_STALE");
});

test("正向和负向人工结论都可放行，证明会过期且成功重放幂等", () => {
  const closed = [closedStory("story-a", 100)];
  const scope = createStoryReopenReviewScope(closed, "story-a", {
    ownerId: "owner-a",
    trigger: "story_reopened",
    now: 120,
  }).data;
  for (const decision of ["correct", "corrected", "insufficient", "ticket_wrong"]) {
    const checked = validateStoryReopenReviewRun({
      trigger: "story_reopened",
      reopenScope: scope,
      review: { decision, reviewer: "owner-a", reviewedAt: 130 },
    }, {
      closedTabs: closed,
      storyId: "story-a",
      ownerId: "owner-a",
      now: 140,
      ttlMs: 20,
    });
    assert.equal(checked.ok, true, decision);
  }

  const expired = validateStoryReopenReviewRun({
    trigger: "story_reopened",
    reopenScope: scope,
    review: { decision: "insufficient", reviewer: "owner-a", reviewedAt: 130 },
  }, {
    closedTabs: closed,
    storyId: "story-a",
    ownerId: "owner-a",
    now: 151,
    ttlMs: 20,
  });
  assert.equal(expired.code, "STORY_REOPEN_AI_REVIEW_EXPIRED");

  const replayed = validateStoryReopenReviewRun({
    trigger: "story_reopened",
    reopenScope: scope,
    review: { decision: "insufficient", reviewer: "owner-a", reviewedAt: 130 },
  }, {
    closedTabs: [],
    activeTabs: [{ id: "story-a", lastClosedAt: 100 }],
    storyId: "story-a",
    ownerId: "owner-a",
    now: 140,
    ttlMs: 20,
    allowIdempotentReplay: true,
  });
  assert.equal(replayed.ok, true);
  assert.equal(replayed.idempotent, true);
});

test("一次复核可冻结多个独立关闭范围，并允许按故事逐个安全恢复", () => {
  const storyA = closedStory("story-a", 100);
  const storyB = closedStory("story-b", 110);
  const issued = createStoryReopenReviewScope([storyA, storyB], [storyA.id, storyB.id], {
    ownerId: "owner-a",
    trigger: "task_team_execute",
    now: 120,
  });
  assert.equal(issued.ok, true);
  assert.deepEqual(issued.data.anchorStoryIds, ["story-a", "story-b"]);

  const partial = validateStoryReopenScope(issued.data, {
    closedTabs: [storyB],
    activeTabs: [{ ...storyA, closedAt: undefined, lastClosedAt: 100 }],
    storyId: storyB.id,
    ownerId: "owner-a",
    trigger: "task_team_execute",
    allowIdempotentReplay: true,
  });
  assert.equal(partial.ok, true);
  assert.equal(partial.idempotent, undefined, "尚未恢复的成员仍应获准执行真正的 reopen");
});
