import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import { isLiveStalled, storyRunStatusView } from "./storyRunStatusModel.mjs";

const ai = {
  engineLabel: "Codex（OpenAI 官方）",
  model: "gpt-5.6-sol",
  tier: "xhigh",
};

test("StoryTab 输入区状态条不再读取最后一条工具命令", () => {
  const source = fs.readFileSync(new URL("./StoryTab.jsx", import.meta.url), "utf8");
  assert.match(source, /const inputRunStatus = storyRunStatusView\(\{/);
  assert.match(source, /data-testid="story-input-run-status"[\s\S]{0,500}title=\{inputRunStatus\.text\}/);
  assert.doesNotMatch(source, /const currentTool\s*=|运行中[^\n]*currentTool/,
    "输入区不能恢复读取 live.tools 最后一项的旧实现");
});

test("输入区运行状态只显示 AI 元数据、时间和用量，不消费具体命令", () => {
  const command = '"C:\\\\Windows\\\\System32\\\\WindowsPowerShell\\\\v1.0\\\\powershell.exe" -Command git diff --check';
  const view = storyRunStatusView({
    isRunning: true,
    live: { streaming: true, tools: [command] },
    ...ai,
    timing: "开始 11:13:35 · 已运行 14分13秒",
    usage: "输入 7.59M · 输出 17.6K · 缓存命中 7.39M · 缓存写入 0 · 总消耗 15.00M",
  });

  assert.equal(view.state, "running");
  assert.equal(view.canStop, true);
  assert.equal(
    view.text,
    "运行中 AI Codex（OpenAI 官方） · 模型 gpt-5.6-sol · 档位 xhigh · 开始 11:13:35 · 已运行 14分13秒 · 输入 7.59M · 输出 17.6K · 缓存命中 7.39M · 缓存写入 0 · 总消耗 15.00M",
  );
  assert.doesNotMatch(JSON.stringify(view), /PowerShell|git diff|Command/);
});

test("输入区区分启动、收尾、停止和空闲状态", () => {
  assert.deepEqual(
    storyRunStatusView({ isRunning: true, ...ai }).details.slice(-1),
    ["正在等待 AI 响应"],
  );
  assert.equal(storyRunStatusView({ isRunning: true, ...ai }).state, "starting");

  const finalizing = storyRunStatusView({
    isRunning: true,
    live: { streaming: false, endedAt: 2000, durationMs: 1000 },
    ...ai,
    timing: "开始 11:13:35 · 结束 11:13:36 · 耗时 1秒",
    usage: "输入 2.0K · 输出 120",
  });
  assert.equal(finalizing.state, "finalizing");
  assert.equal(finalizing.canStop, true);
  assert.match(finalizing.text, /^收尾中 AI Codex/);
  assert.match(finalizing.text, /正在保存回答$/);

  const stopped = storyRunStatusView({
    live: { streaming: false, stopped: true, endedAt: 2000, durationMs: 1000 },
    ...ai,
    timing: "开始 11:13:35 · 结束 11:13:36 · 耗时 1秒",
  });
  assert.equal(stopped.state, "stopped");
  assert.equal(stopped.canStop, false);
  assert.match(stopped.text, /^已停止 AI Codex/);
  assert.match(stopped.text, /停止前回答已保留$/);

  const idle = storyRunStatusView({ ...ai });
  assert.equal(idle.state, "idle");
  assert.equal(idle.text, "空闲 AI Codex（OpenAI 官方） · 模型 gpt-5.6-sol · 档位 xhigh · 等待输入");
});

test("输入区识别卡住状态：不再显示运行中，提示可停止后重发", () => {
  const stalled = storyRunStatusView({
    isRunning: true,
    live: { streaming: false, stalled: true, stalledSinceMs: 12 * 60 * 1000 },
    ...ai,
    timing: "开始 11:13:35 · 已运行 12分00秒",
    usage: "输入 125.0K · 输出 147",
  });
  assert.equal(stalled.state, "stalled");
  assert.equal(stalled.canStop, true);
  assert.equal(stalled.animated, false);
  assert.match(stalled.text, /^疑似卡住 AI Codex/);
  assert.match(stalled.text, /AI 长时间无响应，可停止后重发$/);
  assert.doesNotMatch(stalled.text, /运行中/);
});

test("输入区显示警告、取消和进程树退出验证状态", () => {
  const warning = storyRunStatusView({
    isRunning: true,
    live: { streaming: true, progressState: "warning" },
    ...ai,
  });
  assert.equal(warning.state, "warning");
  assert.equal(warning.canStop, true);
  assert.match(warning.text, /心跳仍活跃，但业务未推进/);

  const cancelling = storyRunStatusView({
    isRunning: true,
    live: { streaming: true, progressState: "cancelling" },
    ...ai,
  });
  assert.equal(cancelling.state, "cancelling");
  assert.equal(cancelling.canStop, false);
  assert.match(cancelling.text, /验证进程树退出/);

  const unconfirmed = storyRunStatusView({
    live: { streaming: false, progressState: "termination_unconfirmed" },
    ...ai,
  });
  assert.equal(unconfirmed.state, "termination_unconfirmed");
  assert.match(unconfirmed.text, /检查执行节点后再续跑/);
});

test("isLiveStalled 识别实时流停滞（WS 事件丢失导致「启动中/AI」残留自愈）", () => {
  const now = Date.now();
  // streaming=true 且长时间无更新 → 停滞
  assert.equal(isLiveStalled({ streaming: true, updatedAt: now - 121_000 }, now), true);
  // 仍在更新（正常流式）→ 不停滞
  assert.equal(isLiveStalled({ streaming: true, updatedAt: now - 10_000 }, now), false);
  // streaming=false（已收尾）→ 不归为停滞
  assert.equal(isLiveStalled({ streaming: false, updatedAt: now - 300_000 }, now), false);
  // 无 live / 无 updatedAt → 不归为停滞
  assert.equal(isLiveStalled(null, now), false);
  assert.equal(isLiveStalled({ streaming: true }, now), false);
  // 自定义阈值
  assert.equal(isLiveStalled({ streaming: true, updatedAt: now - 40_000 }, now, 30_000), true);
  assert.equal(isLiveStalled({ streaming: true, updatedAt: now - 40_000 }, now, 60_000), false);
  // 新监督协议由服务端执行收敛，前端 2 分钟兼容计时不能抢先误杀。
  assert.equal(isLiveStalled({ streaming: true, progressState: "active", updatedAt: now - 600_000 }, now), false);
  assert.equal(isLiveStalled({ streaming: true, progressState: "warning", updatedAt: now - 600_000 }, now), false);
  assert.equal(isLiveStalled({ streaming: false, progressState: "termination_unconfirmed", updatedAt: now }, now), true);
});
