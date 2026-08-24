/**
 * CarDev 模块 - Electron 原生能力包装
 *
 * desktop 模式下走 window.electronAPI.cardev.*，
 * web 模式下返回 null 让上层 fallback。
 */

function api() {
  return window.electronAPI?.cardev || null;
}

export function isElectron() {
  return !!api();
}

/** 调起原生文件选择 */
export async function pickFile(opts = {}) {
  const a = api();
  if (!a) return null;
  try {
    const r = await a.pickFile(opts);
    return r?.ok ? r.path : null;
  } catch { return null; }
}

/** 调起原生文件夹选择 */
export async function pickFolder(opts = {}) {
  const a = api();
  if (!a) return null;
  try {
    const r = await a.pickFolder(opts);
    return r?.ok ? r.path : null;
  } catch { return null; }
}

/** 在文件资源管理器中定位 */
export async function showInFolder(target) {
  const a = api();
  if (!a || !target) return false;
  try { const r = await a.showInFolder(target); return !!r?.ok; }
  catch { return false; }
}

/** 在外部默认应用中打开 */
export async function openExternal(target) {
  const a = api();
  if (!a || !target) return false;
  try { const r = await a.openExternal(target); return !!r?.ok; }
  catch { return false; }
}

/** 获取常用路径 */
export async function getPaths() {
  const a = api();
  if (!a) return null;
  try { const r = await a.getPaths(); return r?.ok ? r : null; }
  catch { return null; }
}
