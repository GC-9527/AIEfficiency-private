import { resolveResourceScript } from "./resourceScriptModel.mjs";

const SYSTEM_DEFINITIONS = Object.freeze([
  { key: "starting", label: "创建测试轮次" },
  { key: "preflight", label: "设备与应用预检" },
  { key: "collecting", label: "脚本与采样并行" },
  { key: "analyzing", label: "生成分析报告" },
  { key: "finalizing", label: "上报并保留原始数据" },
  { key: "completed", label: "测试结束" },
]);

// 只用于没有脚本快照的旧轮次。新轮次必须完全按 configSnapshot.script.workflow 渲染。
const LEGACY_SCRIPT_DEFINITIONS = Object.freeze([
  { key: "launch", label: "启动并等待首页", eventSteps: ["launch", "select_home"], modes: ["full", "launch-only"] },
  { key: "detail", label: "进入应用详情", eventSteps: ["open_detail"], modes: ["full"] },
  { key: "scroll", label: "下滑至详情底部", eventSteps: ["scroll_detail"], modes: ["full"] },
  { key: "install", label: "下载并安装", eventSteps: ["download_install", "installer_confirm"], modes: ["full"] },
  { key: "home", label: "返回应用市场首页", eventSteps: ["return_home"], modes: ["full"] },
  { key: "mine", label: "进入“我的”页面", eventSteps: ["open_my"], modes: ["full"] },
  { key: "menus", label: "浏览二级菜单", eventSteps: ["browse_menu"], modes: ["full"] },
  { key: "flow", label: "自动化脚本结束", eventSteps: ["flow"], modes: ["full", "launch-only"] },
]);

const SUCCESS_STATUSES = new Set(["passed", "completed"]);
const WARNING_STATUSES = new Set(["partial", "skipped"]);
const FAILED_STATUSES = new Set(["failed"]);
const CANCELLED_STATUSES = new Set(["cancelled"]);
const TERMINAL_NODE_STATES = new Set(["success", "warning", "failed", "cancelled"]);

function asObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function clean(value) {
  return String(value ?? "").trim();
}

function finite(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function normalizeEvent(value, index) {
  const event = asObject(value);
  const step = clean(event.step);
  const status = clean(event.status).toLowerCase();
  if (!step || !status) return null;
  return {
    sequence: finite(event.sequence) ?? index + 1,
    at: clean(event.at),
    step,
    status,
    message: clean(event.message),
  };
}

function stringList(value) {
  return [...new Set((Array.isArray(value) ? value : []).map(clean).filter(Boolean))];
}

function normalizeDefinition(raw, index, child = false) {
  const value = asObject(raw);
  const key = clean(value.key || value.id) || `${child ? "child" : "step"}-${index + 1}`;
  const modes = stringList(value.modes);
  return {
    key,
    label: clean(value.label || value.name) || key,
    eventSteps: stringList(value.eventSteps),
    modes: modes.length ? modes : ["full", "launch-only"],
    children: (Array.isArray(value.children) ? value.children : [])
      .map((item, childIndex) => normalizeDefinition(item, childIndex, true)),
  };
}

function workflowDefinitions(script) {
  const workflow = Array.isArray(script?.workflow)
    ? { steps: script.workflow }
    : asObject(script?.workflow);
  return (Array.isArray(workflow.steps) ? workflow.steps : [])
    .map((item, index) => normalizeDefinition(item, index));
}

function menuLabel(message) {
  return clean(message).replace(/^未找到白名单菜单[：:]\s*/, "") || "未命名菜单";
}

function configSnapshotCandidates(run, detail) {
  return [
    run?.configSnapshot,
    detail?.configSnapshot,
    detail?.run?.configSnapshot,
  ].map(asObject);
}

function configuredMenuLabels(run, detail, events) {
  const labels = [];
  const add = (value) => {
    const label = clean(value);
    if (label && !labels.includes(label)) labels.push(label);
  };
  for (const snapshot of configSnapshotCandidates(run, detail)) {
    const configured = Array.isArray(snapshot.flow?.secondary_menus)
      ? snapshot.flow.secondary_menus
      : Array.isArray(snapshot.flow?.secondaryMenus) ? snapshot.flow.secondaryMenus : [];
    configured.forEach((item) => add(asObject(item).label));
  }
  events.filter((event) => event.step === "browse_menu").forEach((event) => add(menuLabel(event.message)));
  const flow = asObject(detail?.flow || detail?.profile?.flow || detail?.resourceProfile?.flow);
  (Array.isArray(flow.menus_visited) ? flow.menus_visited : []).forEach(add);
  (Array.isArray(flow.menus_missing) ? flow.menus_missing : []).forEach(add);
  return labels;
}

function stateFromEvent(event, nodeKey) {
  if (FAILED_STATUSES.has(event.status)) return "failed";
  if (CANCELLED_STATUSES.has(event.status)) return "cancelled";
  if (WARNING_STATUSES.has(event.status)) return "warning";
  if (SUCCESS_STATUSES.has(event.status)) return "success";
  if (event.status === "clicked" && !["install", "scroll"].includes(nodeKey)) return "success";
  return "running";
}

function systemPhaseIndex(phase, status) {
  if (["completed", "completed_with_upload_error", "cancelled", "failed"].includes(status)) return 5;
  const value = clean(phase || status).toLowerCase();
  if (["starting", "idle"].includes(value)) return 0;
  if (value === "preflight") return 1;
  if (["collecting", "sampling", "flow", "running"].includes(value)) return 2;
  if (value === "analyzing") return 3;
  if (["uploading", "finalizing"].includes(value)) return 4;
  if (["completed", "completed_with_upload_error", "cancelled", "failed"].includes(value)) return 5;
  return 0;
}

function buildSystemLane(run, active) {
  const live = asObject(run?.live);
  const status = clean(run?.status).toLowerCase();
  const phase = clean(live.phase || live.meta?.phase || status).toLowerCase();
  const currentIndex = systemPhaseIndex(phase, status);
  return SYSTEM_DEFINITIONS.map((definition, index) => {
    let state = index < currentIndex ? "success" : index === currentIndex ? "running" : "pending";
    if (!active && status === "completed") state = "success";
    if (!active && status === "completed_with_upload_error") state = index === 4 ? "warning" : "success";
    if (!active && status === "failed") state = index === currentIndex ? "failed" : (index < currentIndex ? "success" : "pending");
    if (!active && status === "cancelled") state = index === currentIndex ? "cancelled" : (index < currentIndex ? "success" : "pending");
    return { ...definition, state, active: state === "running" };
  });
}

function applyLegacyHistoricalFallback(nodes, flow, mode, runStatus) {
  if (mode === "launch-only") {
    nodes[0].state = flow.status === "failed" ? "failed" : "success";
    const terminal = nodes.find((node) => node.key === "flow");
    if (terminal) terminal.state = flow.status === "failed" ? "failed" : "success";
    return;
  }
  if (flow.status === "completed") {
    nodes.forEach((node) => { if (node.state !== "skipped") node.state = "success"; });
    return;
  }
  if (flow.status === "partial") {
    const states = { launch: "success", detail: "success", scroll: "success", install: flow.download_install_completed ? "success" : "warning", home: "success", mine: "success", menus: Array.isArray(flow.menus_missing) && flow.menus_missing.length ? "warning" : "success", flow: "warning" };
    nodes.forEach((node) => { if (states[node.key]) node.state = states[node.key]; });
    return;
  }
  const terminal = nodes.find((node) => node.key === "flow");
  if (terminal && (flow.status === "failed" || runStatus === "failed")) terminal.state = "failed";
  if (terminal && (flow.status === "cancelled" || runStatus === "cancelled")) terminal.state = "cancelled";
}

function matchesEvent(definition, event) {
  return definition.eventSteps.includes(event.step);
}

function updateNodeFromEvent(node, event) {
  node.event = event;
  const nextState = stateFromEvent(event, node.key);
  if (node.state !== "failed" && node.state !== "cancelled") node.state = nextState;
}

function childForEvent(children, event) {
  const candidates = children.filter((child) => matchesEvent(child, event));
  if (candidates.length <= 1) return candidates[0] || null;
  const message = clean(event.message).toLowerCase();
  return candidates.find((child) => message.includes(clean(child.label).toLowerCase())) || candidates[0];
}

function addConfiguredMenuChildren(nodes, run, detail, events, mode) {
  const menuNode = nodes.find((node) => node.eventSteps.includes("browse_menu"));
  if (!menuNode) return;
  for (const label of configuredMenuLabels(run, detail, events)) {
    if (menuNode.children.some((child) => child.label === label)) continue;
    menuNode.children.push({
      key: `menu-${menuNode.children.length + 1}`,
      label,
      eventSteps: ["browse_menu"],
      modes: [mode],
      state: "pending",
      event: null,
      children: [],
    });
  }
}

export function buildResourceWorkflow({
  run = {},
  detail = null,
  active = false,
  scripts = [],
  fallbackScriptId = "",
} = {}) {
  const live = asObject(run?.live);
  const liveEvents = Array.isArray(live.stepHistory) ? live.stepHistory : [];
  const detailEvents = Array.isArray(detail?.flowEvents) ? detail.flowEvents : [];
  const events = (liveEvents.length ? liveEvents : detailEvents)
    .map(normalizeEvent)
    .filter(Boolean)
    .sort((left, right) => left.sequence - right.sequence);
  const flow = asObject(detail?.flow || detail?.profile?.flow || detail?.resourceProfile?.flow);
  const mode = clean(flow.mode) || (run?.options?.executeFlow === false ? "launch-only" : "full");
  const resolvedScript = resolveResourceScript({ run, detail, scripts, fallbackScriptId });
  const legacy = !resolvedScript;
  const definitions = legacy
    ? LEGACY_SCRIPT_DEFINITIONS.map((definition) => ({ ...definition, children: [] }))
    : workflowDefinitions(resolvedScript);
  const nodes = definitions.map((definition) => ({
    ...definition,
    state: definition.modes.includes(mode) ? "pending" : "skipped",
    event: null,
    children: definition.children.map((child) => ({
      ...child,
      state: child.modes.includes(mode) ? "pending" : "skipped",
      event: null,
    })),
  }));
  addConfiguredMenuChildren(nodes, run, detail, events, mode);

  const unmappedEvents = [];
  let furthestIndex = -1;
  for (const event of events) {
    const index = nodes.findIndex((node) => matchesEvent(node, event));
    if (index < 0) {
      unmappedEvents.push(event);
      continue;
    }
    furthestIndex = Math.max(furthestIndex, index);
    const node = nodes[index];
    updateNodeFromEvent(node, event);
    const child = event.step === "browse_menu"
      ? node.children.find((item) => item.label === menuLabel(event.message)) || childForEvent(node.children, event)
      : childForEvent(node.children, event);
    if (child) updateNodeFromEvent(child, event);
  }

  if (legacy && furthestIndex >= 0) {
    nodes.forEach((node, index) => {
      if (index < furthestIndex && node.state === "pending") node.state = "success";
    });
  } else if (legacy && !active) {
    applyLegacyHistoricalFallback(nodes, flow, mode, clean(run?.status).toLowerCase());
  }

  const current = asObject(live.currentStep);
  const currentEvent = clean(current.step) ? normalizeEvent(current, events.length) : events.at(-1) || null;
  const currentIndex = currentEvent ? nodes.findIndex((node) => matchesEvent(node, currentEvent)) : -1;
  const currentMapped = currentIndex >= 0;
  if (active && currentMapped) {
    const currentNode = nodes[currentIndex];
    if (!TERMINAL_NODE_STATES.has(currentNode.state)) currentNode.state = "running";
  }
  if (active && currentEvent && !currentMapped) {
    const alreadyIncluded = unmappedEvents.some((event) => (
      event.sequence === currentEvent.sequence && event.step === currentEvent.step
    ));
    if (!alreadyIncluded) unmappedEvents.push(currentEvent);
  }

  const applicable = nodes.filter((node) => node.state !== "skipped");
  const finished = applicable.filter((node) => ["success", "warning"].includes(node.state)).length;
  const currentMenu = currentEvent?.step === "browse_menu" ? menuLabel(currentEvent.message) : "";
  const scriptMeta = resolvedScript
    ? {
        id: resolvedScript.id,
        name: resolvedScript.name,
        description: resolvedScript.description,
        runner: resolvedScript.runner,
        source: resolvedScript.source,
        legacy: false,
      }
    : {
        id: "legacy-appmarket-flow",
        name: "旧版应用市场固定流程",
        description: "该轮没有保存脚本快照，按旧版流程兼容展示。",
        runner: "",
        source: "legacy",
        legacy: true,
      };

  return {
    mode,
    events,
    unmappedEvents,
    system: buildSystemLane(run, active),
    script: nodes,
    scriptMeta,
    currentEvent,
    currentLabel: currentEvent && !currentMapped
      ? `未映射：${currentEvent.step}`
      : currentMapped
        ? `${nodes[currentIndex].label}${currentMenu ? ` · ${currentMenu}` : ""}`
        : active ? "等待脚本上报当前步骤" : "本轮没有实时步骤",
    currentOrdinal: currentMapped ? currentIndex + 1 : null,
    totalSteps: nodes.length,
    finished,
    applicable: applicable.length,
  };
}
