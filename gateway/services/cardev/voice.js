/**
 * CarDev 模块 - 语音指令封装
 *
 * 包含两类：
 * 1. VOICE_ACTION 广播（"常用语音指令"，由车载语音框架接收）
 * 2. H方语音 — 通过启动 com.huawei.voice.car 直接识别文本
 */
import { broadcast, startActivity, clearPackage, forceStop, shell, adb } from "./adb.js";

const VOICE_ACTION = "com.appmarket.automotive.VOICE_ACTION";
const HW_VOICE_PKG = "com.huawei.voice.car";
const HW_VOICE_MAIN = "com.huawei.voice.car/com.huawei.vassistant.carui.MainActivity";
const HW_VOICE_SETTING = "com.huawei.voice.car/com.huawei.vassistant.carui.setting.VassistantSettingActivity";

/** 构建 VOICE_ACTION message 对象 */
function buildIntent(intentName, extra = {}) {
  return { intentName, ...extra };
}

/** 常用语音指令预设 */
export const COMMON_VOICE_INTENTS = {
  PreviousMusic: { intent: "PreviousMusic" },
  ResumeMusic: { intent: "ResumeMusic" },
  PauseMusic: { intent: "PauseMusic" },
  NextMusic: { intent: "NextMusic" },
  FastForwordMusic: {
    intent: "FastForwordMusic",
    extra: {
      moduleName: "Media",
      intentParams: { command: "8", defaultStepDuration: "5", duration: "10" },
    },
  },
  FastReverseMusic: {
    intent: "FastReverseMusic",
    extra: {
      moduleName: "Media",
      intentParams: { command: "8", defaultStepDuration: "5", duration: "10" },
    },
  },
  OpenVideo: { intent: "OpenVideo" },
  CloseVideo: { intent: "CloseVideo" },
  CollectMusic: { intent: "CollectMusic" },
  DiscollectMusic: { intent: "DiscollectMusic" },
  OpenCollect: { intent: "OpenCollect" },
  OpenCollectionVideo: { intent: "OpenCollectionVideo" },
};

/** 执行预设的常用语音指令 */
export async function runCommonIntent(serial, key) {
  const def = COMMON_VOICE_INTENTS[key];
  if (!def) return { ok: false, error: `unknown intent: ${key}` };
  return broadcast(serial, VOICE_ACTION, buildIntent(def.intent, def.extra));
}

/** 自定义任意 intent */
export async function runCustomIntent(serial, intentName, extra = {}) {
  return broadcast(serial, VOICE_ACTION, buildIntent(intentName, extra));
}

/** 搜索音乐 */
export async function searchMusic(serial, keyword) {
  const extra = {
    intentParams: {
      slots: [{ key: "videoName", value: [keyword] }],
    },
  };
  return broadcast(serial, VOICE_ACTION, buildIntent("PlaySearchMusic", extra));
}

/** 搜索视频 */
export async function searchVideo(serial, keyword) {
  const extra = {
    moduleName: "Media",
    abilityName: "Video",
    intentParams: {
      slots: [{ key: "videoName", value: [keyword] }],
    },
  };
  return broadcast(serial, VOICE_ACTION, buildIntent("PlaySearchVideo", extra));
}

/** H方语音 — 模拟语音文本输入
 *  注意：dataUri 内部不要加单引号；startActivity 会用双引号包裹整个 URI，
 *  Android sh 的双引号里单引号是字面字符，会污染识别文本（曾导致暂停按钮失效）。
 */
export async function hwVoiceInput(serial, text) {
  if (!text) return { ok: false, error: "text required" };
  const safe = String(text).replace(/['"]/g, "");
  return startActivity(serial, HW_VOICE_MAIN, {
    action: "android.intent.action.MAIN",
    category: "android.intent.category.DEFAULT",
    dataUri: `scheme://host/recognize?text=${safe}`,
  });
}

/** H方语音常用按钮（直接 Java 文本识别） */
export const HW_VOICE_PRESETS = {
  PreviousMusic: "Previous One",
  ResumeMusic: "Resume",
  PauseMusic: "Pause",
  NextMusic: "Next One",
  FastForward: "Fast forward",
  FastRewind: "Rewind",
  CloseVideo: "Close the video",
  CollectVideo: "Save favourites",
  DiscollectVideo: "Remove favorites",
  OpenCollect: "Open favorites",
};

export async function hwVoicePreset(serial, key) {
  const text = HW_VOICE_PRESETS[key];
  if (!text) return { ok: false, error: `unknown preset: ${key}` };
  return hwVoiceInput(serial, text);
}

/** 设置语音 App 国家码为以色列 */
export async function setRegionIsrael(serial) {
  const cmds = [
    "setprop seres.vehicle.config.which.car 16",
    "setprop persist.seres.vehicle.config.region.code 5",
    `pm clear ${HW_VOICE_PKG}`,
    "am force-stop com.seres.settings",
  ];
  const out = [];
  for (const c of cmds) out.push(await shell(serial, c));
  return { ok: out.every((x) => x.ok), steps: out };
}

/** 设置语音 App 测试 URL */
export async function setTestUrl(serial) {
  const cmds = [
    "setprop prop_trs_url https://lfhivoicebot.hwcloudtest.cn:8443",
    "setprop ro.logsystem.usertype 3",
    `am force-stop ${HW_VOICE_PKG}`,
  ];
  const out = [];
  for (const c of cmds) out.push(await shell(serial, c));
  return { ok: out.every((x) => x.ok), steps: out };
}

/** 打开语音设置页面 */
export async function openVoiceSetting(serial) {
  return startActivity(serial, HW_VOICE_SETTING);
}

/** 清除语音包数据 */
export async function clearVoiceData(serial) {
  return clearPackage(serial, HW_VOICE_PKG);
}

/** 杀死应用市场进程 */
export async function killMarket(serial) {
  return forceStop(serial, "com.appmarket.automotive");
}

/** 启动 DRM 进程 */
export async function startDrm(serial) {
  if (!serial) return { ok: false, error: "serial required" };
  const services = [
    "/vendor/bin/hw/android.hardware.drm@1.0-service",
    "/vendor/bin/hw/android.hardware.drm@1.4-service.clearkey",
    "/vendor/bin/hw/android.hardware.drm@1.4-service.widevine",
    "/vendor/bin/hw/android.hardware.drm@1.3-service.widevine",
  ];
  await adb(serial, ["root"], { timeout: 6000 });
  await adb(serial, ["remount"], { timeout: 6000 });
  const results = [];
  for (const svc of services) {
    results.push(await shell(serial, `nohup ${svc} &> /dev/null &`));
  }
  return { ok: true, steps: results };
}
