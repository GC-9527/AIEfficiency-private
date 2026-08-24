/**
 * CarDev Geely 车机工程模式插件。
 *
 * 密码规则使用网关所在机器的本地时间：
 *   #* + (月份 + 5) + 日期 + 12 小时制小时
 */
import * as adb from "../../adb.js";
import { setTimeout as delay } from "node:timers/promises";

const DIALPAD_KEY_RESOURCE_NAMES = Object.freeze({
  pound: "#",
  star: "*",
  zero: "0",
  one: "1",
  two: "2",
  three: "3",
  four: "4",
  five: "5",
  six: "6",
  seven: "7",
  eight: "8",
  nine: "9",
});

const P177_REFERENCE_DIALPAD_TARGETS = Object.freeze({
  displayId: 0,
  deleteButton: Object.freeze({ x: 752, y: 1248 }),
  keys: Object.freeze({
    "#": Object.freeze({ x: 772, y: 1054 }),
    "*": Object.freeze({ x: 188, y: 1054 }),
    "0": Object.freeze({ x: 480, y: 1054 }),
    "1": Object.freeze({ x: 188, y: 487 }),
    "2": Object.freeze({ x: 480, y: 487 }),
    "3": Object.freeze({ x: 772, y: 487 }),
    "4": Object.freeze({ x: 188, y: 676 }),
    "5": Object.freeze({ x: 480, y: 676 }),
    "6": Object.freeze({ x: 772, y: 676 }),
    "7": Object.freeze({ x: 188, y: 865 }),
    "8": Object.freeze({ x: 480, y: 865 }),
    "9": Object.freeze({ x: 772, y: 865 }),
  }),
});

function nodeAttribute(node, name) {
  const match = String(node || "").match(new RegExp(`${name}="([^"]*)"`));
  return match?.[1] || "";
}

function resourceName(resourceId) {
  return String(resourceId || "").split(/:id\/|\//).at(-1) || "";
}

function nodeCenter(node) {
  const match = nodeAttribute(node, "bounds").match(/^\[(\d+),(\d+)\]\[(\d+),(\d+)\]$/);
  if (!match) return null;
  const [, left, top, right, bottom] = match.map(Number);
  if (right <= left || bottom <= top) return null;
  return {
    x: Math.round((left + right) / 2),
    y: Math.round((top + bottom) / 2),
  };
}

export function parseGeelyDialpadTargets(xml) {
  const keys = {};
  let deleteButton = null;
  for (const node of String(xml || "").match(/<node\b[^>]*\/?\s*>/g) || []) {
    const center = nodeCenter(node);
    if (!center) continue;
    const name = resourceName(nodeAttribute(node, "resource-id"));
    const key = DIALPAD_KEY_RESOURCE_NAMES[name];
    if (key) keys[key] = center;
    if (["deleteButton", "delete_button", "delete"].includes(name)) deleteButton = center;
  }
  return { deleteButton, keys };
}

/**
 * P177 重连后可能由 HUD 抢占无障碍根节点，但拨号器仍显示在物理主屏。
 * 只有型号、可见窗口、显示屏和分辨率全部命中实机基线时才允许使用兜底坐标。
 */
export function parseGeelyP177DialpadFallback(model, windowDump) {
  if (!/^P177(?:[-_].*)?$/i.test(String(model || "").trim())) return null;

  const dialerWindow = String(windowDump || "")
    .split(/(?=\n\s*Window #\d+\s+Window\{)/)
    .find((block) => (
      /com\.android\.dialer\/com\.android\.dialer\.DialtactsActivity/.test(block)
      && /\bmDisplayId=0\b/.test(block)
      && /\bRequested w=2560 h=1600\b/.test(block)
      && /\bmFrame=\[0,0\]\[2560,1600\]/.test(block)
      && /\bisVisible=true\b/.test(block)
    ));
  if (!dialerWindow) return null;

  return P177_REFERENCE_DIALPAD_TARGETS;
}

export function buildGeelyEngineeringModePassword(now = new Date()) {
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new TypeError("now must be a valid Date");
  }

  const month = now.getMonth() + 1 + 5;
  const day = now.getDate();
  const hour = now.getHours() % 12 || 12;
  return `#*${month}${day}${hour}`;
}

async function inputTap(serial, point, displayId = null) {
  const displayArgs = Number.isInteger(displayId) ? ["-d", String(displayId)] : [];
  return adb.adb(serial, ["shell", "input", ...displayArgs, "tap", String(point.x), String(point.y)]);
}

async function discoverP177DialpadFallback(serial) {
  const model = await adb.adb(serial, ["shell", "getprop", "ro.product.model"]);
  if (!model.ok || !/^P177(?:[-_].*)?$/i.test(String(model.stdout || "").trim())) return null;

  const windows = await adb.adb(serial, ["shell", "dumpsys", "window", "windows"]);
  if (!windows.ok) return null;
  return parseGeelyP177DialpadFallback(model.stdout, windows.stdout);
}

function failedStep(result, serial, step, fallbackError) {
  return {
    ...result,
    ok: false,
    serial,
    step,
    error: result?.error || result?.stderr || fallbackError,
  };
}

/**
 * 使用拨号器真实的屏幕按钮逐键输入，而不是向未聚焦的号码框注入硬件按键。
 * `tel:0` 会把重复执行遗留的旧号码重置成一个种子字符，再点击删除按钮清空。
 */
export async function openGeelyEngineeringMode(serial, {
  now = new Date(),
  renderDelayMs = 500,
  keyDelayMs = 350,
  verificationDelayMs = 800,
} = {}) {
  const targetSerial = String(serial || "").trim();
  if (!targetSerial) return { ok: false, error: "serial required" };

  const password = buildGeelyEngineeringModePassword(now);
  const opened = await adb.adb(targetSerial, [
    "shell", "am", "start", "-W",
    "-a", "android.intent.action.DIAL",
    "-d", "tel:0",
  ]);
  if (!opened.ok) return failedStep(opened, targetSerial, "open-dialer", "打开拨号页失败");

  if (renderDelayMs > 0) await delay(renderDelayMs);
  const hierarchy = await adb.adb(targetSerial, ["exec-out", "uiautomator", "dump", "/dev/tty"]);
  if (!hierarchy.ok) return failedStep(hierarchy, targetSerial, "read-dialpad", "读取拨号盘失败");

  let targets = parseGeelyDialpadTargets(hierarchy.stdout);
  const missingKeys = [...password].filter((key) => !targets.keys[key]);
  if (!targets.deleteButton || missingKeys.length) {
    const fallbackTargets = await discoverP177DialpadFallback(targetSerial);
    if (!fallbackTargets) {
      return {
        ok: false,
        serial: targetSerial,
        step: "locate-dialpad",
        code: "CARDEV_GEELY_DIALPAD_KEYS_NOT_FOUND",
        error: `拨号盘按钮识别失败：${[
          ...(!targets.deleteButton ? ["delete"] : []),
          ...new Set(missingKeys),
        ].join(", ")}`,
      };
    }
    targets = fallbackTargets;
  }

  const cleared = await inputTap(targetSerial, targets.deleteButton, targets.displayId);
  if (!cleared.ok) return failedStep(cleared, targetSerial, "clear-seed", "清空拨号框失败");
  if (keyDelayMs > 0) await delay(keyDelayMs);

  for (let index = 0; index < password.length; index += 1) {
    const key = password[index];
    const result = await inputTap(targetSerial, targets.keys[key], targets.displayId);
    if (!result.ok) {
      return failedStep(result, targetSerial, `input-key-${index + 1}`, `输入工程模式按键 ${key} 失败`);
    }
    if (keyDelayMs > 0 && index < password.length - 1) await delay(keyDelayMs);
  }

  if (verificationDelayMs > 0) await delay(verificationDelayMs);
  const activities = await adb.adb(targetSerial, ["shell", "dumpsys", "activity", "activities"]);
  if (!activities.ok) {
    return failedStep(activities, targetSerial, "verify-engineering-mode", "验证工程模式页面失败");
  }
  if (!/topResumedActivity=.*com\.geely\.engineermode\//.test(activities.stdout)) {
    return {
      ok: false,
      serial: targetSerial,
      step: "verify-engineering-mode",
      code: "CARDEV_GEELY_ENGINEERING_MODE_NOT_OPENED",
      error: "密码按键已发送，但未检测到车机工程模式页面",
    };
  }

  return {
    ok: true,
    serial: targetSerial,
    password,
    inputMethod: Number.isInteger(targets.displayId) ? "p177_dialpad_geometry_tap" : "dialpad_tap",
  };
}

export const geelyEngineeringModePlugin = Object.freeze({
  id: "geely",
  manufacturer: "Geely",
  displayName: "Geely车机工程模式",
  execute: openGeelyEngineeringMode,
});
