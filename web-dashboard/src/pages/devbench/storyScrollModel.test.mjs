import { test } from "node:test";
import assert from "node:assert/strict";
import {
  STORY_SCROLL_BOTTOM_THRESHOLD,
  storyPageUpTarget,
  storyScrollDistanceFromBottom,
  storyScrollKeyCommand,
  storyScrollStatus,
} from "./storyScrollModel.mjs";

test("用户向上滚离底部后暂停跟随并显示回到底部入口", () => {
  const status = storyScrollStatus({ scrollHeight: 1200, clientHeight: 500, scrollTop: 320 });
  assert.equal(status.distanceFromBottom, 380);
  assert.equal(status.atBottom, false);
  assert.equal(status.following, false);
  assert.equal(status.showJumpToBottom, true);
});

test("底部阈值内继续跟随实时回答且不显示悬浮按钮", () => {
  const status = storyScrollStatus({
    scrollHeight: 1200,
    clientHeight: 500,
    scrollTop: 700 - STORY_SCROLL_BOTTOM_THRESHOLD,
  });
  assert.equal(status.atBottom, true);
  assert.equal(status.following, true);
  assert.equal(status.showJumpToBottom, false);
});

test("点击回到底部后的平滑滚动期间保持强制跟随", () => {
  const status = storyScrollStatus(
    { scrollHeight: 1200, clientHeight: 500, scrollTop: 420 },
    { forceFollowing: true },
  );
  assert.equal(status.atBottom, false);
  assert.equal(status.following, true);
  assert.equal(status.showJumpToBottom, false);
});

test("无滚动空间和异常数值都按已到底部处理", () => {
  assert.equal(storyScrollDistanceFromBottom({ scrollHeight: 300, clientHeight: 500, scrollTop: -20 }), 0);
  assert.equal(storyScrollStatus({ scrollHeight: "bad", clientHeight: 0, scrollTop: 0 }).atBottom, true);
});

test("PageUp 上翻约一屏且不会越过顶部", () => {
  assert.equal(storyPageUpTarget({ scrollTop: 1000, clientHeight: 600 }), 490);
  assert.equal(storyPageUpTarget({ scrollTop: 120, clientHeight: 600 }), 0);
});

test("只把 PageUp 和 End 识别为故事点滚动快捷键", () => {
  assert.equal(storyScrollKeyCommand("PageUp"), "page-up");
  assert.equal(storyScrollKeyCommand("End"), "bottom");
  assert.equal(storyScrollKeyCommand("PageDown"), "");
  assert.equal(storyScrollKeyCommand("Home"), "");
});
