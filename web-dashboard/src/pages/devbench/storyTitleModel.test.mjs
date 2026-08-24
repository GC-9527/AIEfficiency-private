import assert from "node:assert/strict";
import test from "node:test";

import {
  repairStoryTitleCarbId,
  taskStoryTitle,
} from "./storyTitleModel.mjs";

test("TB 故事点标题保留完整来源标题，不在 56 字符处截断", () => {
  const sourceTitle = "【jira转载】SWIM-1659245【EF1E-A2-MR】【性能】【体验测试】天窗开闭过程中出现偶发卡顿与异响";
  const expected = `#CARB-14841# ${sourceTitle}`;

  assert.ok(expected.length > 56, "测试标题必须越过旧的 56 字符边界");
  assert.equal(taskStoryTitle({ carbId: "CARB-14841", title: sourceTitle }), expected);
});

test("修复 CARB 前缀时保留标题剩余内容", () => {
  const currentTitle = "#CARB-10000# 【jira转载】SWIM-1659245【EF1E-A2-MR】【性能】【体验测试】天窗开闭过程中出现偶发卡顿与异响";

  assert.ok(currentTitle.length > 60, "测试标题必须越过旧的重命名截断边界");
  assert.equal(
    repairStoryTitleCarbId(currentTitle, "CARB-14841"),
    currentTitle.replace("#CARB-10000#", "#CARB-14841#"),
  );
});
