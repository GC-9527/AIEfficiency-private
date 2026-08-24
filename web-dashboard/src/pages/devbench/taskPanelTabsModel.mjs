export const TASK_PANEL_TAB_IDS = Object.freeze({
  TODO: "todo",
  TB_POOL: "tbpool",
});

export const TASK_PANEL_TABS = Object.freeze([
  Object.freeze({
    id: TASK_PANEL_TAB_IDS.TODO,
    label: "待办列表",
    title: "待办任务列表",
  }),
  Object.freeze({
    id: TASK_PANEL_TAB_IDS.TB_POOL,
    label: "TB单列表",
    title: "TB 单候选列表（点「添加到任务」挑进待办）",
  }),
]);

export const TASK_PANEL_ACTIVE_TAB_STORAGE_KEY =
  "devbench_task_panel_active_tab_v1";

const VALID_TAB_IDS = new Set(TASK_PANEL_TABS.map((tab) => tab.id));

export function normalizeTaskPanelActiveTab(value) {
  const tabId = String(value || "").trim();
  return VALID_TAB_IDS.has(tabId) ? tabId : TASK_PANEL_TAB_IDS.TODO;
}

export function readTaskPanelActiveTab(storage = globalThis.localStorage) {
  try {
    return normalizeTaskPanelActiveTab(
      storage?.getItem(TASK_PANEL_ACTIVE_TAB_STORAGE_KEY),
    );
  } catch {
    return TASK_PANEL_TAB_IDS.TODO;
  }
}

export function saveTaskPanelActiveTab(tabId, storage = globalThis.localStorage) {
  const normalized = normalizeTaskPanelActiveTab(tabId);
  try {
    storage?.setItem(TASK_PANEL_ACTIVE_TAB_STORAGE_KEY, normalized);
  } catch {}
  return normalized;
}
