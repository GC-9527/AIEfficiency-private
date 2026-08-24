import { geelyEngineeringModePlugin } from "./plugins/geely.js";

const plugins = new Map();

function normalizePluginId(value) {
  return String(value || "").trim().toLowerCase();
}

export function registerEngineeringModePlugin(plugin) {
  const id = normalizePluginId(plugin?.id);
  if (!id || !/^[a-z0-9-]+$/.test(id)) {
    throw new TypeError("engineering mode plugin id must contain only lowercase letters, numbers, or hyphens");
  }
  if (typeof plugin?.execute !== "function") {
    throw new TypeError(`engineering mode plugin ${id} must provide execute(serial, options)`);
  }
  if (plugins.has(id)) throw new Error(`engineering mode plugin already registered: ${id}`);

  const registered = Object.freeze({
    ...plugin,
    id,
    manufacturer: String(plugin.manufacturer || id),
    displayName: String(plugin.displayName || `${plugin.manufacturer || id}车机工程模式`),
  });
  plugins.set(id, registered);
  return registered;
}

export function getEngineeringModePlugin(pluginId) {
  return plugins.get(normalizePluginId(pluginId)) || null;
}

export function listEngineeringModePlugins() {
  return [...plugins.values()].map(({ execute: _execute, ...metadata }) => metadata);
}

export async function enterEngineeringMode(pluginId, serial, options) {
  const plugin = getEngineeringModePlugin(pluginId);
  if (!plugin) {
    return {
      ok: false,
      statusCode: 400,
      code: "CARDEV_ENGINEERING_MODE_PLUGIN_NOT_FOUND",
      error: `不支持的车机工程模式厂商：${String(pluginId || "").trim() || "未指定"}`,
    };
  }

  const result = await plugin.execute(serial, options);
  return {
    ...result,
    manufacturer: plugin.id,
  };
}

registerEngineeringModePlugin(geelyEngineeringModePlugin);
