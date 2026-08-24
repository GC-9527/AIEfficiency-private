/**
 * CarDev 模块 - 走行规制（Safe Drive）
 */
import { broadcast } from "./adb.js";

const SAFE_DRIVE_ACTION = "com.appmarket.automotive.SAFE_DRIVE_ACTION";

/** 模拟车辆速度 */
export function speedChange(serial, speed) {
  return broadcast(serial, SAFE_DRIVE_ACTION, {
    command: "speedChange",
    speed: String(speed),
  });
}

/** 模拟车辆档位 */
export function gearChange(serial, gear) {
  return broadcast(serial, SAFE_DRIVE_ACTION, {
    command: "gearChange",
    gear: String(gear),
  });
}

/** 简单 command 透传（initSafeDrive / closeSafeDrive / setGear / setSpeed / etc.） */
export function rawCommand(serial, command, extra = {}) {
  return broadcast(serial, SAFE_DRIVE_ACTION, { command, ...extra });
}

/** 走行规制：正在浏览视频 */
export function setWatchingVideo(serial, watching) {
  return broadcast(serial, SAFE_DRIVE_ACTION, {
    command: "watchVideoChange",
    watching: watching ? "true" : "false",
  });
}

/**
 * 1 秒内 5km 上下随机切换
 * 通过定时器在内存中维持，每 1 秒切换一次速度
 */
const RANDOM_TIMERS = new Map();

export function startRandomSpeed(serial, intervalMs = 1000) {
  const key = serial || "_default_";
  stopRandomSpeed(serial);
  let toggle = false;
  const timer = setInterval(async () => {
    const speed = toggle ? 50 : 55;
    toggle = !toggle;
    try { await speedChange(serial, speed); } catch {}
  }, intervalMs);
  RANDOM_TIMERS.set(key, timer);
  return { ok: true, started: true };
}

export function stopRandomSpeed(serial) {
  const key = serial || "_default_";
  const t = RANDOM_TIMERS.get(key);
  if (t) {
    clearInterval(t);
    RANDOM_TIMERS.delete(key);
    return { ok: true, stopped: true };
  }
  return { ok: true, stopped: false };
}

export function isRandomRunning(serial) {
  const key = serial || "_default_";
  return RANDOM_TIMERS.has(key);
}
