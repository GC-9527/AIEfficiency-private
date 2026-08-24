import assert from "node:assert/strict";
import test from "node:test";

import {
  createAgentExecutionSupervisor,
  DEFAULT_API_MAX_TOOL_ITERATIONS,
  isMeaningfulProgressStream,
  normalizeApiMaxToolIterations,
} from "../services/agent-progress.js";

function fakeClock(start = 1000) {
  let current = start;
  let sequence = 0;
  const timers = [];
  const schedule = (fn, delay) => {
    const timer = { id: ++sequence, at: current + Math.max(0, delay), fn, cancelled: false, unref() {} };
    timers.push(timer);
    return timer;
  };
  const unschedule = (timer) => { if (timer) timer.cancelled = true; };
  const advance = (ms) => {
    const target = current + ms;
    while (true) {
      const next = timers
        .filter((timer) => !timer.cancelled && timer.at <= target)
        .sort((a, b) => a.at - b.at || a.id - b.id)[0];
      if (!next) break;
      next.cancelled = true;
      current = next.at;
      next.fn();
    }
    current = target;
  };
  return { now: () => current, schedule, unschedule, advance };
}

test("心跳、状态和思考流不刷新业务推进，正文和工具结果才刷新", () => {
  assert.equal(isMeaningfulProgressStream({ deltaType: "status", chunk: "仍在运行" }), false);
  assert.equal(isMeaningfulProgressStream({ deltaType: "thinking", chunk: "分析中" }), false);
  assert.equal(isMeaningfulProgressStream({ deltaType: "usage", chunk: "1" }), false);
  assert.equal(isMeaningfulProgressStream({ deltaType: "tool_use", chunk: "read_file" }), false);
  assert.equal(isMeaningfulProgressStream({ deltaType: "text", chunk: "发现根因" }), true);
  assert.equal(isMeaningfulProgressStream({ deltaType: "tool_output", chunk: "test passed" }), true);
});

test("无业务推进先警告、再取消；新业务推进只重置停滞计时", () => {
  const clock = fakeClock();
  const states = [];
  const cancelled = [];
  const supervisor = createAgentExecutionSupervisor({
    policy: {
      meaningfulProgressWarningMs: 10,
      meaningfulProgressCancelMs: 30,
      apiActiveTurnMaxMs: 100,
      terminationVerifyMs: 20,
    },
    onState: (state) => states.push({ ...state }),
    onCancel: (error) => cancelled.push(error),
    now: clock.now,
    schedule: clock.schedule,
    unschedule: clock.unschedule,
  });

  clock.advance(10);
  assert.equal(states.at(-1).state, "warning");
  clock.advance(5);
  assert.equal(supervisor.markMeaningfulProgress({ source: "text", chunk: "完成第一步" }), true);
  assert.equal(states.at(-1).state, "active");
  assert.equal(states.at(-1).lastMeaningfulProgressAt, 1015);
  // 重复事件不应伪造推进。
  clock.advance(5);
  assert.equal(supervisor.markMeaningfulProgress({ source: "text", chunk: "完成第一步" }), false);
  assert.equal(states.at(-1).lastMeaningfulProgressAt, 1015);
  clock.advance(10);
  assert.equal(states.at(-1).state, "warning");
  clock.advance(20);
  assert.equal(cancelled.length, 1);
  assert.equal(cancelled[0].code, "AI_NO_MEANINGFUL_PROGRESS");
  assert.equal(cancelled[0].resumable, true);
  assert.equal(cancelled[0].storyLifetimeExpired, false);
  supervisor.dispose();
});

test("API 单片段总时限不会被持续正文进展无限延长", () => {
  const clock = fakeClock();
  const states = [];
  const cancelled = [];
  const supervisor = createAgentExecutionSupervisor({
    policy: {
      meaningfulProgressWarningMs: 1000,
      meaningfulProgressCancelMs: 2000,
      apiActiveTurnMaxMs: 100,
      terminationVerifyMs: 20,
    },
    onState: (state) => states.push({ ...state }),
    onCancel: (error) => cancelled.push(error),
    now: clock.now,
    schedule: clock.schedule,
    unschedule: clock.unschedule,
  });
  supervisor.startApiActiveTurn();
  clock.advance(50);
  supervisor.markMeaningfulProgress({ source: "text", chunk: "仍在有效推进" });
  clock.advance(40);
  assert.equal(states.at(-1).state, "warning");
  assert.equal(states.at(-1).timeoutKind, "active_turn");
  clock.advance(10);
  assert.equal(cancelled.length, 1);
  assert.equal(cancelled[0].code, "API_AGENT_ACTIVE_TURN_TIMEOUT");
  supervisor.dispose();
});

test("API Agent 历史不限配置迁移为有限迭代上限", () => {
  assert.equal(normalizeApiMaxToolIterations(0), DEFAULT_API_MAX_TOOL_ITERATIONS);
  assert.equal(normalizeApiMaxToolIterations(15), DEFAULT_API_MAX_TOOL_ITERATIONS);
  assert.equal(normalizeApiMaxToolIterations(undefined), DEFAULT_API_MAX_TOOL_ITERATIONS);
  assert.equal(normalizeApiMaxToolIterations(240), 240);
  assert.equal(normalizeApiMaxToolIterations(5000), 1000);
});

test("多年故事点只从本次执行片段开始计时，不按故事点年龄过期", () => {
  const yearsLater = Date.UTC(2035, 0, 1);
  const clock = fakeClock(yearsLater);
  const states = [];
  const supervisor = createAgentExecutionSupervisor({
    policy: {
      meaningfulProgressWarningMs: 100,
      meaningfulProgressCancelMs: 200,
      apiActiveTurnMaxMs: 300,
      terminationVerifyMs: 20,
    },
    onState: (state) => states.push({ ...state }),
    now: clock.now,
    schedule: clock.schedule,
    unschedule: clock.unschedule,
  });
  assert.equal(states[0].executionStartedAt, yearsLater);
  assert.equal(states[0].lastMeaningfulProgressAt, yearsLater);
  assert.equal(states[0].storyLifetimeExpired, false);
  supervisor.dispose();
});
