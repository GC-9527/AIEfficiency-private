const compactText = (value) => String(value || "").trim();

/**
 * 输入区状态条只描述 AI 运行状态与稳定元数据。
 * 工具名、命令和命令输出属于回答卡片，不允许进入这里，避免长命令挤压输入区。
 */
export function storyRunStatusView({
  isRunning = false,
  live = null,
  engineLabel = "",
  model = "",
  tier = "",
  timing = "",
  usage = "",
} = {}) {
  const stopped = live?.stopped === true;
  const streaming = live?.streaming === true;
  const stalled = live?.stalled === true;
  const progressState = compactText(live?.progressState || live?.progress_state);
  const streamEnded = !!live
    && live.streaming === false
    && (live.endedAt != null || live.ended_at != null || live.durationMs != null);

  let state = "idle";
  let label = "空闲";
  let hint = "等待输入";

  if (stopped) {
    state = "stopped";
    label = "已停止";
    hint = "停止前回答已保留";
  } else if (progressState === "termination_unconfirmed") {
    state = "termination_unconfirmed";
    label = "退出未确认";
    hint = "请检查执行节点后再续跑";
  } else if (progressState === "cancelling") {
    state = "cancelling";
    label = "正在取消";
    hint = "取消后将验证进程树退出";
  } else if (progressState === "warning") {
    state = "warning";
    label = "进展停滞警告";
    hint = "心跳仍活跃，但业务未推进；继续停滞将自动取消";
  } else if (progressState === "terminated") {
    state = "paused";
    label = "本轮已暂停";
    hint = "进程树已退出，可从检查点继续";
  } else if (stalled) {
    // AI 长时间无响应（live draft 超过阈值未更新）：租约仍 active 但是假象，
    // 提示用户点击停止后重发，而不是一直显示"运行中"。
    state = "stalled";
    label = "疑似卡住";
    hint = "AI 长时间无响应，可停止后重发";
  } else if (isRunning && streaming) {
    state = "running";
    label = "运行中";
    hint = "";
  } else if (isRunning && streamEnded) {
    state = "finalizing";
    label = "收尾中";
    hint = "正在保存回答";
  } else if (isRunning) {
    state = "starting";
    label = "启动中";
    hint = "正在等待 AI 响应";
  }

  const details = [
    compactText(engineLabel) ? `AI ${compactText(engineLabel)}` : "",
    compactText(model) ? `模型 ${compactText(model)}` : "",
    compactText(tier) ? `档位 ${compactText(tier)}` : "",
  ];

  if (state !== "idle" && state !== "starting") {
    details.push(compactText(timing), compactText(usage));
  }
  details.push(hint);

  const visibleDetails = details.filter(Boolean);
  return {
    state,
    label,
    details: visibleDetails,
    text: visibleDetails.length ? `${label} ${visibleDetails.join(" · ")}` : label,
    canStop: isRunning && !stopped && !["cancelling", "termination_unconfirmed", "paused"].includes(state),
    animated: ["running", "starting", "finalizing", "warning", "cancelling"].includes(state),
  };
}

/**
 * 判断实时流是否已停滞（残留）。
 * WS 未断但任务结束/异常时 chat_stream 事件可能丢失，liveMap 残留 streaming=true，
 * 故事点会一直显示「启动中 / AI minimax」。超过 stallMs 无任何流更新即视为残留，
 * 由前端自愈定时器清理运行标记；仍活跃的任务会在下一个 chat_stream 到达时恢复。
 */
export function isLiveStalled(live, now = Date.now(), stallMs = 120_000) {
  const progressState = compactText(live?.progressState || live?.progress_state);
  if (["terminated", "termination_unconfirmed"].includes(progressState)) return true;
  if (!live?.streaming) return false;
  if (progressState) return false;
  const updatedAt = live.updatedAt || live.updated_at || 0;
  if (!updatedAt) return false; // 未知更新时间（首个事件前）不武断判停滞
  return now - updatedAt > stallMs;
}

export function storyComposerSubmitLabel({ copying = false, sending = false, isRunning = false, streaming = false, realtimeAppend = false } = {}) {
  if (copying) return "复制工程中…";
  if (sending) return "发送中…";
  if (isRunning || streaming) return realtimeAppend ? "实时追加" : "排队发送";
  return "发送";
}
