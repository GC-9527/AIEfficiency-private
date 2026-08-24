const SAFE_RUN_KINDS = new Set(["workflow", "live"]);
const SAFE_VIEW_KINDS = new Set(["dashboard", "live", "table", "artifacts", "report", "json"]);
const UNSAFE_KEYS = new Set(["__proto__", "prototype", "constructor"]);

const LEGACY_UI = Object.freeze({
  schemaVersion: 1,
  defaultView: "dashboard",
  legacy: true,
  warning: "该轮没有保存脚本 UI 快照，按旧版应用市场视图兼容展示。",
  runSections: Object.freeze([
    Object.freeze({ id: "workflow", kind: "workflow", label: "测试任务工作流", title: "测试任务工作流", description: "", source: "", showInHistory: true, metrics: Object.freeze([]), columns: Object.freeze([]), artifactKeys: Object.freeze([]), emptyText: "" }),
  ]),
  views: Object.freeze([
    Object.freeze({ id: "dashboard", kind: "dashboard", label: "仪表盘", title: "仪表盘", description: "", source: "", showInHistory: true, metrics: Object.freeze([]), columns: Object.freeze([]), artifactKeys: Object.freeze([]), emptyText: "" }),
    Object.freeze({ id: "raw", kind: "table", label: "原始数据", title: "逐点原始数据", description: "", source: "samples", showInHistory: true, metrics: Object.freeze([]), columns: Object.freeze([]), artifactKeys: Object.freeze([]), emptyText: "本轮未返回逐点样本" }),
    Object.freeze({ id: "report", kind: "report", label: "报表", title: "采集报告", description: "", source: "", showInHistory: true, metrics: Object.freeze([]), columns: Object.freeze([]), artifactKeys: Object.freeze([]), emptyText: "本轮尚未生成报表" }),
  ]),
});

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

function normalizeField(raw, index) {
  const field = asObject(raw);
  const key = clean(field.key);
  if (!key || UNSAFE_KEYS.has(key)) return null;
  return {
    key,
    label: clean(field.label) || key,
    unit: clean(field.unit),
    color: /^#[0-9a-f]{6}$/i.test(clean(field.color)) ? clean(field.color) : "#60a5fa",
    decimals: Math.max(0, Math.min(6, Math.trunc(finite(field.decimals) ?? 2))),
    order: index,
  };
}

function normalizeSection(raw, index, kinds) {
  const section = asObject(raw);
  const id = clean(section.id);
  const kind = clean(section.kind);
  if (!id || UNSAFE_KEYS.has(id) || !kinds.has(kind)) return null;
  const source = clean(section.source);
  if (source && source !== "samples" && source !== "diagnosticSamples" && !/^event:[A-Za-z][A-Za-z0-9_.-]{0,79}$/.test(source)) return null;
  return {
    id,
    kind,
    label: clean(section.label) || id,
    title: clean(section.title || section.label) || id,
    description: clean(section.description),
    source,
    samplingModes: [...new Set((Array.isArray(section.samplingModes) ? section.samplingModes : ["standard", "realtime"]).filter((mode) => mode === "standard" || mode === "realtime"))],
    showInHistory: section.showInHistory === true || kind !== "live",
    metrics: (Array.isArray(section.metrics) ? section.metrics : []).map(normalizeField).filter(Boolean),
    columns: (Array.isArray(section.columns) ? section.columns : []).map(normalizeField).filter(Boolean),
    artifactKeys: [...new Set((Array.isArray(section.artifactKeys) ? section.artifactKeys : []).map(clean).filter((key) => key && !UNSAFE_KEYS.has(key)))],
    emptyText: clean(section.emptyText),
    order: index,
  };
}

function cloneLegacyUi() {
  return {
    ...LEGACY_UI,
    runSections: LEGACY_UI.runSections.map((section) => ({ ...section, metrics: [], columns: [], artifactKeys: [] })),
    views: LEGACY_UI.views.map((section) => ({ ...section, metrics: [], columns: [], artifactKeys: [] })),
  };
}

export function normalizeTaskUi(script) {
  const raw = asObject(asObject(script).ui);
  if (!Object.keys(raw).length) return cloneLegacyUi();
  const schemaVersion = Math.trunc(finite(raw.schemaVersion) ?? 0);
  if (schemaVersion !== 1) {
    return { ...cloneLegacyUi(), warning: `暂不支持脚本 UI schemaVersion=${raw.schemaVersion || "未知"}，已安全降级。` };
  }
  const seen = new Set();
  const normalizeList = (value, kinds) => (Array.isArray(value) ? value : [])
    .map((section, index) => normalizeSection(section, index, kinds))
    .filter((section) => {
      if (!section || seen.has(section.id)) return false;
      seen.add(section.id);
      return true;
    });
  const runSections = normalizeList(raw.runSections, SAFE_RUN_KINDS);
  const views = normalizeList(raw.views, SAFE_VIEW_KINDS);
  if (!views.length) return { ...cloneLegacyUi(), warning: "脚本 UI 没有可渲染视图，已安全降级。" };
  const requestedDefault = clean(raw.defaultView);
  return {
    schemaVersion,
    defaultView: views.some((view) => view.id === requestedDefault) ? requestedDefault : views[0].id,
    legacy: false,
    warning: "",
    runSections,
    views,
  };
}

export function chooseTaskUiView(ui, requestedId = "") {
  const schema = ui && Array.isArray(ui.views) ? ui : cloneLegacyUi();
  const requested = clean(requestedId);
  if (schema.views.some((view) => view.id === requested)) return requested;
  if (schema.views.some((view) => view.id === schema.defaultView)) return schema.defaultView;
  return schema.views[0]?.id || "";
}

function safeValues(value) {
  const result = {};
  for (const [key, item] of Object.entries(asObject(value))) {
    if (UNSAFE_KEYS.has(key)) continue;
    if (["string", "number", "boolean"].includes(typeof item) || item === null) result[key] = item;
  }
  return result;
}

export function taskUiSourceRows(section, { run = {}, detail = null } = {}) {
  const source = clean(section?.source);
  const live = asObject(run?.live);
  if (source === "samples") {
    const rows = Array.isArray(detail?.samples) ? detail.samples : Array.isArray(live.samples) ? live.samples : [];
    return rows.map((row) => ({ ...asObject(row) }));
  }
  if (source === "diagnosticSamples") {
    const rows = Array.isArray(detail?.diagnosticSamples)
      ? detail.diagnosticSamples
      : Array.isArray(live.diagnosticSamples) ? live.diagnosticSamples : [];
    return rows.map((row) => ({ ...asObject(row) }));
  }
  if (source.startsWith("event:")) {
    const channel = source.slice("event:".length);
    const rows = Array.isArray(detail?.channelEvents)
      ? detail.channelEvents
      : Array.isArray(live.channelEvents) ? live.channelEvents : [];
    return rows
      .filter((event) => clean(event?.channel) === channel)
      .map((event) => ({
        sequence: finite(event?.sequence ?? event?.seq),
        target_elapsed_s: finite(event?.elapsed_s ?? event?.elapsedS ?? event?.sequence ?? event?.seq),
        at: clean(event?.at),
        message: clean(event?.message),
        ...safeValues(event?.values),
      }));
  }
  return [];
}

export function taskUiSourceLabel(source) {
  if (source === "samples") return "LIVE_SAMPLE_JSON";
  if (source === "diagnosticSamples") return "LIVE_DIAGNOSTIC_JSON";
  if (String(source || "").startsWith("event:")) return `LIVE_EVENT_JSON · ${String(source).slice(6)}`;
  return "脚本实时事件";
}
