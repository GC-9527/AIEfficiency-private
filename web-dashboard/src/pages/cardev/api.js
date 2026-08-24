/**
 * CarDev 模块前端 API 封装
 * 所有调用走 /api/cardev/*，仅依赖 gateway.js 共享工具。
 */
import { getApiUrl } from "../../services/gateway.js";
import { authenticatedFetch } from "../../services/adminAuth.js";

async function call(method, path, body) {
  const opts = { method, headers: { "Content-Type": "application/json" } };
  if (body !== undefined) opts.body = JSON.stringify(body);
  const normalizedMethod = String(method || "GET").toUpperCase();
  const transport = normalizedMethod === "GET" || normalizedMethod === "HEAD"
    ? fetch
    : authenticatedFetch;
  const r = await transport(getApiUrl(`/api/cardev${path}`), opts);
  let data;
  try { data = await r.json(); } catch { data = { ok: false, error: `HTTP ${r.status}` }; }
  if (!r.ok && data.ok === undefined) data.ok = false;
  return data;
}

export const get = (p) => call("GET", p);
export const post = (p, body) => call("POST", p, body);
export const del = (p) => call("DELETE", p);

export const cardevApi = {
  // 设备
  listDevices: () => get("/devices"),
  listEngineeringModePlugins: () => get("/devices/engineering-mode/plugins"),
  connect: (ip) => post("/devices/connect", { ip }),
  disconnect: (ip) => post("/devices/disconnect", { ip }),
  scrcpy: (serial, extraArgs) => post("/devices/scrcpy", { serial, extraArgs }),
  enterEngineeringMode: (manufacturer, serial) => (
    post(`/devices/engineering-mode/${encodeURIComponent(manufacturer)}`, { serial })
  ),

  // 常用语音
  voiceCommon: (serial, key) => post("/voice/common", { serial, key }),
  voiceCustom: (serial, intentName, extra) => post("/voice/custom", { serial, intentName, extra }),
  searchMusic: (serial, keyword) => post("/voice/search-music", { serial, keyword }),
  searchVideo: (serial, keyword) => post("/voice/search-video", { serial, keyword }),

  // H 方语音
  hwText: (serial, text) => post("/voice/hw/text", { serial, text }),
  hwPreset: (serial, key) => post("/voice/hw/preset", { serial, key }),
  hwSetting: (serial) => post("/voice/hw/setting", { serial }),
  hwClear: (serial) => post("/voice/hw/clear", { serial }),
  hwRegionIL: (serial) => post("/voice/hw/region-il", { serial }),
  hwTestUrl: (serial) => post("/voice/hw/test-url", { serial }),
  killMarket: (serial) => post("/voice/kill-market", { serial }),
  startDrm: (serial) => post("/voice/start-drm", { serial }),

  // 方控
  keyEvent: (serial, key) => post("/keyevent", { serial, key }),

  // 可见可说
  voiceSee: (serial, action, name) => post("/voice-see/exec", { serial, action, name }),
  buildTree: (serial) => post("/voice-see/build-tree", { serial }),
  hotWords: (serial) => post("/voice-see/hot-words", { serial }),

  // 走行规制
  speed: (serial, speed) => post("/safe-drive/speed", { serial, speed }),
  gear: (serial, gear) => post("/safe-drive/gear", { serial, gear }),
  rawSafe: (serial, command, extra) => post("/safe-drive/raw", { serial, command, extra }),
  watching: (serial, watching) => post("/safe-drive/watching", { serial, watching }),
  randomStart: (serial, intervalMs) => post("/safe-drive/random/start", { serial, intervalMs }),
  randomStop: (serial) => post("/safe-drive/random/stop", { serial }),

  // APK
  installApk: (serial, apkPath) => post("/apk/install", { serial, apkPath }),
  installXapk: (serial, xapkPath) => post("/apk/install-xapk", { serial, xapkPath }),
  pushFile: (serial, localPath, remotePath) => post("/apk/push", { serial, localPath, remotePath }),
  mediaSpaceStep: (step, serial, apkPath) => post(`/apk/media-space/${step}`, { serial, apkPath }),
  hwVoiceStep: (step, serial, apkPath) => post(`/apk/hw-voice/${step}`, { serial, apkPath }),

  // 自定义命令
  listCommands: () => get("/commands"),
  addCommand: (cmd) => post("/commands", cmd),
  deleteCommand: (id) => del(`/commands/${id}`),
  execCommand: (serial, command) => post("/commands/exec", { serial, command }),

  // 偏好
  getLastText: (key) => get(`/last-text/${encodeURIComponent(key)}`),
  setLastText: (key, value) => post(`/last-text/${encodeURIComponent(key)}`, { value }),
};

// 剪贴板（Windows）— 复用网关已有的 /api/clipboard/files
export async function getClipboardFiles() {
  try {
    const r = await fetch(getApiUrl("/api/clipboard/files"));
    const d = await r.json();
    return d.data || [];
  } catch {
    return [];
  }
}
