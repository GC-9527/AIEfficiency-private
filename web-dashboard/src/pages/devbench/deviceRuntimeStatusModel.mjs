const OPERATION_LABELS = Object.freeze({
  story_turn: "AI 任务",
  plugin_operation: "插件任务",
  install_test: "安装测试",
  install_apk: "安装 APK",
  install_xapk: "安装 XAPK",
  adb_shell: "ADB 命令",
  adb_push: "推送文件",
  scrcpy: "投屏启动",
});

function text(value) {
  return String(value ?? "").trim();
}

function list(value) {
  return Array.isArray(value) ? value : [];
}

function operationLabel(kind) {
  const normalized = text(kind);
  if (!normalized) return "设备任务";
  return OPERATION_LABELS[normalized] || normalized.replaceAll("_", " ");
}

function storyLabel(entry, bindingByStoryId) {
  const storyId = text(entry?.storyId);
  return text(bindingByStoryId.get(storyId)?.title)
    || text(entry?.metadata?.title)
    || (storyId === "external:device-operation" ? "外部设备操作" : storyId)
    || "未知任务";
}

function projectedTask(entry, bindingByStoryId, fallbackPosition = null) {
  if (!entry) return null;
  return {
    requestId: text(entry.requestId),
    storyId: text(entry.storyId),
    storyTitle: storyLabel(entry, bindingByStoryId),
    operationKind: text(entry.operationKind),
    operationLabel: operationLabel(entry.operationKind),
    position: Number.isFinite(Number(entry.position)) ? Number(entry.position) : fallbackPosition,
    fencingToken: Number.isFinite(Number(entry.fencingToken)) ? Number(entry.fencingToken) : null,
    expired: entry.expired === true,
  };
}

export function deviceRuntimeStatusView(device = {}) {
  const bindings = list(device.bindings).map((binding) => ({
    storyId: text(binding?.storyId || binding?.tabId),
    title: text(binding?.title) || text(binding?.storyId || binding?.tabId) || "未命名故事点",
    groupId: text(binding?.groupId),
  })).filter((binding) => binding.storyId || binding.title);
  const bindingByStoryId = new Map(bindings.map((binding) => [binding.storyId, binding]));
  const runtime = device.runtime && typeof device.runtime === "object" ? device.runtime : {};
  const lease = runtime.lease || device.currentUse || null;
  const queue = list(runtime.queue?.length !== undefined ? runtime.queue : device.useQueue);
  const connectivity = text(device.connectivity || device.status || "unknown").toLowerCase();

  return {
    serial: text(device.id || device.serial || device.deviceSerial),
    connectivity,
    online: connectivity === "online" || connectivity === "device",
    runtimeStatus: text(runtime.status) || (lease ? "busy" : "idle"),
    bindings,
    currentUse: projectedTask(lease, bindingByStoryId, 0),
    queue: queue.map((entry, index) => projectedTask(entry, bindingByStoryId, index + 1)).filter(Boolean),
  };
}
