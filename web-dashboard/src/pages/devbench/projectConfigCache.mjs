export const PROJECT_CONFIG_CACHE_KEY = "devbench_project_config_cache_v1";

function normalizeProjectId(projectId) {
  return String(projectId || "__default__");
}

function normalizeEntry(value) {
  if (!value || typeof value !== "object") return null;
  if (!Array.isArray(value.rows) || !Array.isArray(value.applications)) return null;
  return {
    rows: value.rows,
    applications: value.applications,
    applicationOptions: Array.isArray(value.applicationOptions) ? value.applicationOptions : [],
    ts: Number(value.ts) || 0,
  };
}

/**
 * 应用工程配置缓存使用模块内存作为当前页面的第一层，并尽力持久化到 localStorage。
 * 读取到空数组也是有效快照，避免“没有配置”在重开弹窗时重新闪加载态。
 */
export function createProjectConfigCache({ storage = globalThis.localStorage, storageKey = PROJECT_CONFIG_CACHE_KEY } = {}) {
  const memory = new Map();
  let loaded = false;

  function load() {
    if (loaded) return;
    loaded = true;
    try {
      const parsed = JSON.parse(storage?.getItem(storageKey) || "null");
      if (!parsed || typeof parsed !== "object") return;
      for (const [projectId, value] of Object.entries(parsed)) {
        const entry = normalizeEntry(value);
        if (entry) memory.set(projectId, entry);
      }
    } catch { /* 缓存损坏或浏览器禁用存储时回退到接口加载 */ }
  }

  function persist() {
    try { storage?.setItem(storageKey, JSON.stringify(Object.fromEntries(memory))); }
    catch { /* 内存缓存仍可保证本页面内重开不闪加载态 */ }
  }

  return Object.freeze({
    read(projectId) {
      load();
      return memory.get(normalizeProjectId(projectId)) || null;
    },
    write(projectId, patch = {}) {
      load();
      const key = normalizeProjectId(projectId);
      const previous = memory.get(key);
      // 只有候选项不代表布局已经加载完成；首次写入必须同时带有两类布局数据，
      // 避免慢接口竞态把“未知布局”伪装成可立即展示的空布局快照。
      if (!previous && (!Array.isArray(patch.rows) || !Array.isArray(patch.applications))) return null;
      const next = normalizeEntry({ ...previous, ...patch, ts: Date.now() });
      if (!next) return previous;
      memory.set(key, next);
      persist();
      return next;
    },
  });
}
