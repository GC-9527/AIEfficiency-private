/**
 * WS 事件出口契约 · 集成测试（跨"后端 emit → ws.send 约束 → 前端 msg.data 解析"整条缝）。
 *
 * 背景：曾有 `broadcastAll({ type, tabId, ... })`（对象、未 stringify、无 data 包裹）——
 *   ① 真实 ws 的 send 只收 string/Buffer，传对象同步抛 TypeError；调用方空 catch{} 把它吞掉 → 静默丢消息；
 *   ② 即便侥幸送达，前端按 `const d = msg.data` 取，没有 data 包裹也读不到。
 * 普通单测抓不到：它只测一侧 + mock 掉对侧，mock 会复制同一个错误假设。
 * 本测试用【复刻真实 ws 约束的伪客户端】+【复刻前端解析】把两侧对接起来，专门守住这个契约。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { WS_BACKPRESSURE_LIMIT_BYTES, setWsClients, broadcastAll, emitWs } from "../services/logger.js";

// 伪 WS 客户端：行为对齐 ws 库 —— send 只接受 string/Buffer，传普通对象会抛（复刻 Buffer.from(object) 的 TypeError）。
function makeClient({ sessions = [], explode = false, bufferedAmount = 0 } = {}) {
  const received = [];
  let terminated = false;
  return {
    readyState: 1,
    bufferedAmount,
    subscribedSessions: new Set(sessions),
    received,
    get terminated() {
      return terminated;
    },
    terminate() {
      terminated = true;
      this.readyState = 3;
    },
    send(msg) {
      if (explode) throw new Error("boom（模拟某客户端 send 永远失败）");
      if (typeof msg !== "string" && !Buffer.isBuffer(msg)) {
        throw new TypeError("ws.send 仅接受 string/Buffer（复刻真实 ws 约束）");
      }
      received.push(msg);
    },
  };
}

// 复刻前端 index.jsx 的 onmessage：const msg = JSON.parse(e.data); const d = msg.data || {}
function parseAsFrontend(raw) {
  const msg = JSON.parse(raw);
  return { type: msg.type, d: msg.data || {} };
}

test("emitWs 产出前端可解析的 {type,data} 信封，data.* 能取到（正是历史 bug 丢失的字段）", () => {
  const c = makeClient();
  setWsClients(new Set([c]));
  emitWs("devbench_git_update", { tabId: "t1", phase: "end", summary: { updated: 0, total: 4 } });

  assert.equal(c.received.length, 1, "应送达 1 条");
  assert.equal(typeof c.received[0], "string", "必须是 JSON 字符串，不能是对象（否则真实 ws 拒收）");
  const { type, d } = parseAsFrontend(c.received[0]);
  assert.equal(type, "devbench_git_update");
  assert.equal(d.tabId, "t1", "前端按 msg.data.tabId 取 —— 这正是 push 传对象时丢失、导致浮窗永显的字段");
  assert.equal(d.phase, "end");
  assert.equal(d.summary.total, 4);
});

test("回归：旧式 broadcastAll(对象) 在真实 ws 约束下根本到不了前端，且不再静默吞错/不中断广播", () => {
  const c = makeClient();
  setWsClients(new Set([c]));
  // 复刻历史 bug 形态：把对象直接广播（未 stringify、无 data 包裹）
  assert.doesNotThrow(
    () => broadcastAll({ type: "devbench_git_update", tabId: "t1", phase: "end" }),
    "硬化后：单客户端 send 抛错被 sendSafe 隔离 + 记日志，不向上抛"
  );
  assert.equal(c.received.length, 0, "对象形态被 ws.send 拒收 → 前端什么都收不到（正是当初的 bug 现象）");
});

test("错误隔离：一个坏客户端 send 抛错，不影响把消息发给其它客户端", () => {
  const bad = makeClient({ explode: true });
  const good = makeClient();
  setWsClients(new Set([bad, good]));
  emitWs("devbench_build", { tabId: "t9", buildId: "b1", phase: "log", stream: "out", line: "hello" });

  assert.equal(good.received.length, 1, "坏客户端抛错被吞后应继续发好客户端");
  const { d } = parseAsFrontend(good.received[0]);
  assert.equal(d.buildId, "b1");
  assert.equal(d.line, "hello");
});

test("emitWs 序列化失败（循环引用）不崩溃、不发送（记日志而非静默吞）", () => {
  const c = makeClient();
  setWsClients(new Set([c]));
  const circular = {};
  circular.self = circular;
  assert.doesNotThrow(() => emitWs("x", circular));
  assert.equal(c.received.length, 0, "序列化失败时不应发出半成品");
});

test("emitWs 支持会话过滤：opts.sessionId 只发订阅该会话的客户端", () => {
  const sub = makeClient({ sessions: ["s1"] });
  const other = makeClient({ sessions: ["s2"] });
  setWsClients(new Set([sub, other]));
  emitWs("chat_stream", { sessionId: "s1", chunk: "x" }, { sessionId: "s1" });

  assert.equal(sub.received.length, 1, "订阅 s1 的客户端应收到");
  assert.equal(other.received.length, 0, "未订阅 s1 的客户端不该收到");
});

test("全故事点事件默认全局广播：所有在线客户端都收到同一信封", () => {
  const a = makeClient();
  const b = makeClient({ sessions: ["whatever"] });
  setWsClients(new Set([a, b]));
  emitWs("devbench_publish", { tabId: "t2", phase: "end", ok: true });

  for (const c of [a, b]) {
    assert.equal(c.received.length, 1);
    const { type, d } = parseAsFrontend(c.received[0]);
    assert.equal(type, "devbench_publish");
    assert.equal(d.tabId, "t2");
    assert.equal(d.ok, true);
  }
});

test("WebSocket 背压：断开积压客户端，但继续向健康客户端发送", () => {
  const slow = makeClient({ bufferedAmount: WS_BACKPRESSURE_LIMIT_BYTES });
  const good = makeClient();
  setWsClients(new Set([slow, good]));

  emitWs("chat_stream", { sessionId: "s1", chunk: "x" });

  assert.equal(slow.terminated, true, "达到积压上限的客户端应被断开，避免发送队列无限占堆");
  assert.equal(slow.received.length, 0, "积压客户端不得继续追加消息");
  assert.equal(good.received.length, 1, "健康客户端仍应收到同一条消息");
});
