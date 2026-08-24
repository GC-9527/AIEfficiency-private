import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  conversationRuntimeActive,
  isTabRunning,
  preserveStoppedLive,
  reconcileConversationLiveMap,
  reconcileRunningTabIds,
} from "./chatStopModel.mjs";
import { storyComposerSubmitLabel, storyRunStatusView } from "./storyRunStatusModel.mjs";

test("点击停止后保留浏览器里正在显示的 AI 回答", () => {
  const before = {
    sessionA: {
      text: "这是停止前已经显示的回答",
      thinking: "分析过程",
      tools: ["rg -n stop ."],
      streaming: true,
      startedAt: 1000,
    },
  };

  const after = preserveStoppedLive(before, "sessionA", 1750);
  assert.equal(after.sessionA.text, before.sessionA.text);
  assert.equal(after.sessionA.thinking, before.sessionA.thinking);
  assert.deepEqual(after.sessionA.tools, before.sessionA.tools);
  assert.equal(after.sessionA.streaming, false);
  assert.equal(after.sessionA.stopped, true);
  assert.equal(after.sessionA.durationMs, 750);
});

test("没有对应流式会话时不制造空消息", () => {
  const before = { sessionA: { text: "existing" } };
  assert.equal(preserveStoppedLive(before, "missing", 2000), before);
});

test("服务端确认任务已结束时清除丢失 WS 终态事件留下的实时追加状态", () => {
  const before = new Set(["tab-stale", "tab-other"]);
  const after = reconcileRunningTabIds(before, "tab-stale", false);
  assert.deepEqual([...after], ["tab-other"]);
  assert.deepEqual([...before], ["tab-stale", "tab-other"], "不得原地修改 React state");
});

test("服务端确认任务仍活跃或状态未知时保留正确的运行态", () => {
  assert.deepEqual([...reconcileRunningTabIds(new Set(), "tab-active", true)], ["tab-active"]);
  const before = new Set(["tab-unknown"]);
  assert.equal(reconcileRunningTabIds(before, "tab-unknown", null), before);
});

test("CARB-14113：最终回答已落盘且服务端空闲时退出实时追加并保留回答", () => {
  const tabId = "tab-carb-14113";
  const sessionId = "dev_tab-carb-14113";
  const persistedMessages = [{ role: "assistant", content: "已落盘的最终回答" }];
  const staleLiveMap = {
    [sessionId]: { text: "已落盘的最终回答", streaming: true, updatedAt: 1000 },
  };

  const liveMap = reconcileConversationLiveMap(staleLiveMap, sessionId, null, false);
  const runningTabs = reconcileRunningTabIds(new Set([tabId]), tabId, false);
  const isRunning = runningTabs.has(tabId);

  assert.equal(liveMap[sessionId], undefined, "权威空闲快照必须清除残留的浏览器流");
  assert.equal(isRunning, false);
  assert.equal(storyRunStatusView({ isRunning, live: liveMap[sessionId] }).state, "idle");
  assert.equal(storyComposerSubmitLabel({ isRunning, streaming: !!liveMap[sessionId]?.streaming, realtimeAppend: true }), "发送");
  assert.deepEqual(persistedMessages, [{ role: "assistant", content: "已落盘的最终回答" }], "运行态收敛不得删除历史回答");
  assert.equal(staleLiveMap[sessionId].streaming, true, "不得原地修改 React state");
});

test("对话恢复兼容旧 Gateway、缺少 sessionId 及较新的 WS 流", () => {
  const before = { sessionA: { text: "浏览器较新", streaming: true, updatedAt: 2000 } };
  assert.equal(reconcileConversationLiveMap(before, "sessionA", null, null), before);
  assert.equal(reconcileConversationLiveMap(before, "", null, false), before);
  assert.equal(
    reconcileConversationLiveMap(before, "sessionA", { text: "服务端较旧", streaming: false, updatedAt: 1000 }, false),
    before,
  );
  assert.equal(conversationRuntimeActive(null, { streaming: true }), true, "旧 Gateway 的流式草稿仍应恢复运行标记");
  assert.equal(conversationRuntimeActive(null, null), null, "旧 Gateway 的空草稿不能武断判为空闲");
});

test("真实页面接入权威对话恢复和发送按钮标签模型", () => {
  const indexSource = fs.readFileSync(new URL("./index.jsx", import.meta.url), "utf8");
  const storyTabSource = fs.readFileSync(new URL("./StoryTab.jsx", import.meta.url), "utf8");
  assert.match(indexSource, /setLiveMap\(\(prev\) => reconcileConversationLiveMap\(prev, sessionId, live, runtimeActive\)\)/);
  assert.match(indexSource, /const runtimeSignal = conversationRuntimeActive\(runtimeActive, live\)/);
  assert.match(indexSource, /setRunningTabs\(\(prev\) => reconcileRunningTabIds\(prev, tabId, runtimeSignal\)\)/);
  assert.match(indexSource, /chat_stream_end[\s\S]{0,1500}loadMessages\(tabId\)/);
  assert.match(storyTabSource, /storyComposerSubmitLabel\(\{ copying, sending, isRunning, streaming, realtimeAppend \}\)/);
});

// === CARB-14755：停止 deepseek 后无法切换 AI —— isTabRunning 强信号豁免 ===

test("CARB-14755：live.stopped === true 时即使 runningTabs 残留也判定为未运行", () => {
  const runningTabs = new Set(["tab-14755"]);
  const liveMap = {
    "sess-14755": { text: "停止前回答", streaming: false, stopped: true, endedAt: 1000 },
  };

  const running = isTabRunning({
    runningTabs,
    liveMap,
    tabId: "tab-14755",
    sessionId: "sess-14755",
    now: 2000,
  });
  assert.equal(running, false, "已停止状态必须允许切换 AI / 再次发送");
});

test("CARB-14755：live.endedAt 距今超过 3s 时判定为未运行（兜底）", () => {
  const runningTabs = new Set(["tab-14755"]);
  const liveMap = {
    "sess-14755": { text: "已结束", streaming: false, endedAt: 1000 },
  };

  assert.equal(
    isTabRunning({ runningTabs, liveMap, tabId: "tab-14755", sessionId: "sess-14755", now: 2000 }),
    true,
    "距 endedAt ≤ 3s 内仍视为运行（避免 2 秒间隙重入误判）",
  );
  assert.equal(
    isTabRunning({ runningTabs, liveMap, tabId: "tab-14755", sessionId: "sess-14755", now: 5000 }),
    false,
    "距 endedAt > 3s 视为已结束",
  );
});

test("CARB-14755：流式输出过程中仍判定为运行", () => {
  const runningTabs = new Set(["tab-14755"]);
  const liveMap = {
    "sess-14755": { text: "正在流式", streaming: true },
  };
  assert.equal(
    isTabRunning({ runningTabs, liveMap, tabId: "tab-14755", sessionId: "sess-14755", now: 2000 }),
    true,
  );
});

test("CARB-14755：既无 live 也无 runningTabs 时判定为未运行", () => {
  assert.equal(
    isTabRunning({
      runningTabs: new Set(),
      liveMap: {},
      tabId: "tab-14755",
      sessionId: "sess-14755",
      now: 2000,
    }),
    false,
  );
});

test("CARB-14755：runningTabs 残留但无 live 记录且未传 sessionId 时按输入给结论", () => {
  // 真实页面总有 sessionId；这里覆盖「liveMap 缺少 sessionId 键 + runningTabs 残留」边界。
  assert.equal(
    isTabRunning({
      runningTabs: new Set(["tab-14755"]),
      liveMap: {},
      tabId: "tab-14755",
      sessionId: "sess-14755",
      now: 2000,
    }),
    true,
    "无 live 兜底数据时回退到 runningTabs 判定（不掩盖真实运行）",
  );
});

test("CARB-14755：不得原地修改 runningTabs / liveMap", () => {
  const runningTabs = new Set(["tab-14755"]);
  const liveMap = { "sess-14755": { streaming: false, stopped: true, endedAt: 1000 } };
  const beforeTabs = new Set(runningTabs);
  const beforeLive = { ...liveMap };

  isTabRunning({ runningTabs, liveMap, tabId: "tab-14755", sessionId: "sess-14755", now: 2000 });

  assert.deepEqual([...runningTabs], [...beforeTabs]);
  assert.deepEqual(liveMap, beforeLive);
});

test("CARB-14755：缺参 / 异常入参时安全返回 false", () => {
  assert.equal(isTabRunning({}), false);
  assert.equal(isTabRunning({ runningTabs: null, liveMap: null, tabId: "", sessionId: "" }), false);
  assert.equal(isTabRunning({ runningTabs: "not-a-set", liveMap: "not-obj", tabId: "x", sessionId: "y" }), false);
});

test("CARB-14755：跨 tab 互不干扰 — 停止 tabA 不影响 tabB 的运行状态", () => {
  const runningTabs = new Set(["tabA", "tabB"]);
  const liveMap = {
    sessA: { text: "停止前", streaming: false, stopped: true, endedAt: 1000 },
    sessB: { text: "正在流式", streaming: true, startedAt: 900 },
  };

  // 停止后：tabA 退出运行态，tabB 仍运行
  const tabAStopped = isTabRunning({ runningTabs, liveMap, tabId: "tabA", sessionId: "sessA", now: 2000 });
  const tabBStillRunning = isTabRunning({ runningTabs, liveMap, tabId: "tabB", sessionId: "sessB", now: 2000 });

  assert.equal(tabAStopped, false, "tabA 停止后必须可切换 AI");
  assert.equal(tabBStillRunning, true, "tabB 仍在流式时按钮必须 disabled，不受 tabA 影响");
});

test("CARB-14755：onStop 失败路径（r.ok=false）下纯函数视角仍返回未运行", () => {
  // 模拟 onStop 失败路径：前端仍会 setRunningTabs.delete(tabId) + preserveStoppedLive，
  // 因此纯 isTabRunning 拿到的入参就是「已清理 + 已写 stopped」的不变量。
  const runningTabs = new Set();
  const liveMap = { sessA: { text: "保留回答", streaming: false, stopped: true, endedAt: 1000 } };
  assert.equal(
    isTabRunning({ runningTabs, liveMap, tabId: "tabA", sessionId: "sessA", now: 2000 }),
    false,
    "onStop 失败但前端已 best-effort 清理 → 按钮可用",
  );
});

// 源码契约：onStop 必须 try/finally 且无条件清理 runningTabs（CARB-14755 异常路径）
// 失败路径包括：r.ok=false / 抛 network 异常 / 后端 409。
test("CARB-14755：onStop 实现满足「异常路径也清 runningTabs」契约", () => {
  const indexSource = fs.readFileSync(new URL("./index.jsx", import.meta.url), "utf8");
  // 找到 onStop 函数体（onStop 后面是 const isTabRunning = ...，不再用 indexOf("async function ") 找下一段）
  const start = indexSource.indexOf("async function onStop(tabId, sessionId)");
  assert.ok(start >= 0, "onStop must exist");
  // 沿花括号配对截取到函数结束
  let depth = 0;
  let end = start;
  let opened = false;
  for (let i = start; i < indexSource.length; i++) {
    const ch = indexSource[i];
    if (ch === "{") { depth++; opened = true; }
    else if (ch === "}") { depth--; if (opened && depth === 0) { end = i + 1; break; } }
  }
  const onStopSource = indexSource.slice(start, end);
  // 1. try/catch 包住 devbenchApi.stop（捕获网络异常）
  assert.match(onStopSource, /try\s*\{[\s\S]*?devbenchApi\.stop\(tabId\)/, "onStop 必须 try 包住 devbenchApi.stop");
  assert.match(onStopSource, /\}\s*catch\s*\(/, "onStop 必须 catch 网络异常");
  // 2. setRunningTabs.delete 必须出现在 try/catch 之后（catch 后仍执行 = 等同 finally 兜底）
  const setRunningTabsIdx = onStopSource.indexOf("setRunningTabs");
  const catchIdx = onStopSource.indexOf("} catch");
  assert.ok(setRunningTabsIdx > 0 && catchIdx > 0 && setRunningTabsIdx > catchIdx,
    "onStop 必须在 catch 之后无条件清理 runningTabs（保证按钮回到可点击）");
  // 3. 失败 toast 与成功 toast 并存
  assert.match(onStopSource, /已停止（\$?\{stopError\}）|停止.*\{stopError\}/, "失败要有可读 toast");
  assert.match(onStopSource, /已停止当前任务，停止前回答已保留/, "成功路径保留原 toast 文案");
  // 4. 即便 r.ok=false 也不允许早 return（catch 之外的早 return 同样禁止）
  assert.doesNotMatch(onStopSource, /if\s*\(!r\.ok\)\s*\{[\s\S]*?return;[\s\S]*?\}/,
    "onStop 不允许「r.ok=false 直接 return」——必须落到清理阶段");
});
