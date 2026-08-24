/**
 * CarDev 模块 - 可见可说（Voice See）
 */
import { broadcast } from "./adb.js";

const VOICE_ACC_ACTION = "com.appmarket.automotive.VOICE_ACC_ACTION";

const VALID_ACTIONS = new Set(["open", "close", "select", "play", "switch"]);

/** 执行可见可说指令 */
export function exec(serial, action, name) {
  if (!VALID_ACTIONS.has(action)) {
    return Promise.resolve({ ok: false, error: `invalid action: ${action}` });
  }
  return broadcast(serial, VOICE_ACC_ACTION, {
    command: "voiceSeeCommand",
    name: name || "",
    action,
    matchMode: "exact",
    scene: "switch",
  });
}

/** 构建无障碍树 */
export function buildTree(serial) {
  return broadcast(serial, VOICE_ACC_ACTION, { command: "buildTree" });
}

/** 模拟语音助手激活（mockSendHotWords） */
export function mockHotWords(serial) {
  return broadcast(serial, VOICE_ACC_ACTION, { command: "mockSendHotWords" });
}
