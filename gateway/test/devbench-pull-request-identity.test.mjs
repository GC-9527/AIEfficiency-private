import test from "node:test";
import assert from "node:assert/strict";
import {
  buildStoryMergeRequestDescription,
  buildStoryPullRequestTitle,
  formatStoryDevPrTimestamp,
  resolveStoryPullRequestIdentity,
} from "../services/devbench/pull-request.js";

const createdAt = new Date(2026, 6, 29, 14, 5, 6).getTime();

function story(overrides = {}) {
  return {
    id: `tab_${createdAt}_abcdef`,
    title: "WebApp 提交批量创建评审故事点",
    createdAt,
    worktree: {
      managed: true,
      entries: [
        { name: "WebApp", role: "primary", active: true },
        { name: "SdkFactory", role: "dependency", active: true },
      ],
    },
    ...overrides,
  };
}

test("无 TB/CARB 故事点使用创建时间生成稳定 StoryDev PR 标题", async () => {
  const tab = story();
  const identity = await resolveStoryPullRequestIdentity(tab);

  assert.equal(formatStoryDevPrTimestamp(createdAt), "20260729140506");
  assert.equal(identity.mode, "storydev");
  assert.equal(identity.carbId, "");
  assert.equal(identity.storyDevTag, "[StoryDev:20260729140506]");
  assert.equal(identity.title, "[StoryDev:20260729140506] WebApp 提交批量创建评审故事点");
  assert.equal(identity.globalBlocker, "");
  assert.match(identity.warning, /不会自动关联 Teambition/);
  assert.equal(buildStoryPullRequestTitle(tab), identity.title);
});

test("旧故事点可从 tab id 回退创建时间且预检执行标题保持一致", async () => {
  const tab = story({ createdAt: undefined });
  const preview = await resolveStoryPullRequestIdentity(tab);
  const execution = await resolveStoryPullRequestIdentity(tab);

  assert.equal(preview.title, "[StoryDev:20260729140506] WebApp 提交批量创建评审故事点");
  assert.equal(execution.title, preview.title);
});

test("唯一 CARB 保持现有标题格式", async () => {
  const tab = story({ title: "#CARB-13542# 修复 WebApp" });
  const identity = await resolveStoryPullRequestIdentity(tab);

  assert.equal(identity.mode, "carb");
  assert.equal(identity.carbId, "CARB-13542");
  assert.equal(identity.title, "#CARB-13542# 修复 WebApp");
  assert.equal(identity.globalBlocker, "");
});

test("多个 CARB 或关联 TB 解析失败时阻断而不是降级为 StoryDev", async () => {
  const conflict = await resolveStoryPullRequestIdentity(story({
    title: "#CARB-13542# 修复 WebApp，同时参考 CARB-13543",
  }));
  assert.equal(conflict.mode, "blocked");
  assert.match(conflict.globalBlocker, /多个不同 CARB/);

  const unresolved = await resolveStoryPullRequestIdentity(story({
    ticketUrl: "https://www.teambition.com/task/0123456789abcdef01234567",
  }), {
    getTaskDetail: async () => {
      throw new Error("network unavailable");
    },
  });
  assert.equal(unresolved.mode, "blocked");
  assert.match(unresolved.globalBlocker, /已填写关联任务信息/);
  assert.match(unresolved.globalBlocker, /network unavailable/);
});

test("关联 TB 与本地 CARB 冲突时阻断", async () => {
  const identity = await resolveStoryPullRequestIdentity(story({
    title: "#CARB-13542# 修复 WebApp",
    ticketUrl: "https://www.teambition.com/task/0123456789abcdef01234567",
  }), {
    getTaskDetail: async () => ({ uniqueId: "13543", title: "另一个任务" }),
  });

  assert.equal(identity.mode, "blocked");
  assert.deepEqual(identity.candidates, ["CARB-13542", "CARB-13543"]);
  assert.match(identity.globalBlocker, /CARB-13542、CARB-13543/);
});

test("TB 暂不可用但已有唯一本地 CARB 时保留 CARB 模式并提示降级证据", async () => {
  const identity = await resolveStoryPullRequestIdentity(story({
    title: "#CARB-13542# 修复 WebApp",
    ticketUrl: "https://www.teambition.com/task/0123456789abcdef01234567",
  }), {
    getTaskDetail: async () => {
      throw new Error("timeout");
    },
  });

  assert.equal(identity.mode, "carb");
  assert.equal(identity.globalBlocker, "");
  assert.match(identity.warning, /CARB-13542/);
});

test("无稳定创建时间时不使用当前点击时间生成漂移标题", async () => {
  const identity = await resolveStoryPullRequestIdentity({
    id: "legacy-story",
    title: "旧故事点",
  });

  assert.equal(identity.mode, "blocked");
  assert.equal(identity.title, "");
  assert.match(identity.globalBlocker, /缺少稳定创建时间/);
});

test("无 TB 的 Git Commit 故事点描述包含完整 StoryDev 与提交追溯信息", async () => {
  const tab = story({
    reviewContext: {
      kind: "git_commit",
      revision: "abcdef0123456789",
      subject: "修复 WebApp 搜索",
      repositoryName: "WebApp",
    },
  });
  const identity = await resolveStoryPullRequestIdentity(tab);
  const description = buildStoryMergeRequestDescription(tab, "story/webapp-review", "main", identity);

  assert.match(description, /关联类型：StoryDev 本地故事点/);
  assert.match(description, new RegExp(`StoryDev ID：${tab.id}`));
  assert.match(description, /StoryDev 标识：\[StoryDev:20260729140506\]/);
  assert.match(description, /关联提交：abcdef0123456789 修复 WebApp 搜索/);
  assert.match(description, /来源仓库：WebApp/);
  assert.match(description, /关联项目：WebApp、SdkFactory/);
  assert.match(description, /来源分支：story\/webapp-review/);
  assert.match(description, /目标分支：main/);
});
