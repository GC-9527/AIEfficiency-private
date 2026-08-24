/**
 * CarDev 路由 - /api/cardev/*
 *
 * 独立模块化路由，封装车机调试相关全部能力（设备/语音/方控/可见可说/走行规制/APK 安装）。
 * 在 server.js 通过单行 app.use("/api/cardev", router) 挂载，不污染其他路由。
 */
import { Router } from "express";
import { adb, voice, voiceSee, safeDrive, apkInstall, engineeringMode, store } from "../services/cardev/index.js";
import { runImmediateDeviceOperation } from "../services/devbench/device-operation-guard-service.js";
import { scheduleTabQueueDrain } from "../services/devbench/index.js";
import { requireAdmin } from "../services/admin-auth.js";
import { isTrustedPerformanceResourceRequest } from "../services/performance-resource-local-access.js";

const router = Router();

// 只保护产生设备/主机副作用的请求；设备和命令列表等只读端点保持原语义。
// 工程模式是唯一免管理员操作，但仍仅允许 Gateway 本机可信页面调用，避免局域网转发、
// 恶意 Origin 或 DNS rebinding 借本机 ADB 操作车机；其余写请求继续走统一管理员身份。
router.use((req, res, next) => {
  if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return next();
  const normalizedPath = String(req.path || "").replace(/\/+$/, "") || "/";
  if (req.method === "POST" && /^\/devices\/engineering-mode\/[a-z0-9-]+$/.test(normalizedPath)) {
    if (!isTrustedPerformanceResourceRequest(req)) {
      return res.status(403).json({
        ok: false,
        code: "CARDEV_ENGINEERING_MODE_LOCAL_ONLY",
        error: "进入厂商车机工程模式仅允许 Gateway 本机可信页面操作",
      });
    }
    return next();
  }
  return requireAdmin(req, res, next);
});

function normalizedSerial(value) {
  return String(value ?? "").trim();
}

function responsePayload(result) {
  const { statusCode: _statusCode, ...payload } = result || {};
  return payload;
}

async function runCardevDeviceOperation(req, res, operationKind, serial, operation, options = {}) {
  const targetSerial = normalizedSerial(serial);
  if (!targetSerial) {
    // 保留原有的 adb 默认设备语义；没有明确 serial 时不创建虚假的全局设备锁。
    return res.json(await operation(null));
  }
  const guarded = await runImmediateDeviceOperation({
    serial: targetSerial,
    storyId: "external:cardev",
    operationKind: `cardev_${operationKind}`,
    ttlMs: options.ttlMs,
    metadata: {
      source: "cardev_http",
      route: req.path,
    },
    onReleased(released) {
      if (released?.nextLease?.storyId) scheduleTabQueueDrain(released.nextLease.storyId);
    },
  }, operation);
  if (!guarded.ok) {
    return res.status(guarded.statusCode || 500).json(responsePayload(guarded));
  }
  return res.json(guarded.value);
}

function explicitAdbSerial(args = []) {
  for (let index = 0; index < args.length; index += 1) {
    const value = String(args[index] || "");
    if (value === "-s" || value === "--serial") {
      return normalizedSerial(args[index + 1]).replace(/^"|"$/g, "");
    }
    const attached = value.match(/^(?:-s|--serial=)(.+)$/);
    if (attached) return normalizedSerial(attached[1]).replace(/^"|"$/g, "");
  }
  return "";
}

// ============================================================
// 设备
// ============================================================

router.get("/devices", async (req, res) => {
  const r = await adb.listDevices();
  if (!r.ok) return res.status(500).json(r);
  // 附带 IP（best-effort）
  const enriched = await Promise.all(
    r.devices.map(async (d) => ({ ...d, ip: await adb.getDeviceIp(d.id).catch(() => null) }))
  );
  res.json({ ok: true, devices: enriched });
});

router.get("/devices/engineering-mode/plugins", (_req, res) => {
  res.json({ ok: true, plugins: engineeringMode.listEngineeringModePlugins() });
});

router.post("/devices/connect", async (req, res) => {
  const { ip } = req.body || {};
  res.json(await adb.connect(ip));
});

router.post("/devices/disconnect", async (req, res) => {
  const { ip } = req.body || {};
  res.json(await adb.disconnect(ip));
});

// 启动 scrcpy 投屏（新建可见控制台窗口；网关不持有该进程）
router.post("/devices/scrcpy", async (req, res) => {
  const { serial, extraArgs } = req.body || {};
  return runCardevDeviceOperation(req, res, "scrcpy_start", serial, (targetSerial) => (
    adb.launchScrcpy(targetSerial, extraArgs || [])
  ));
});

// 厂商工程模式由插件注册中心分发；每个插件独立实现密码、页面和成功判据。
// 必须显式指定 serial，避免多设备环境下误操作其他车机。
router.post("/devices/engineering-mode/:manufacturer", async (req, res) => {
  const serial = normalizedSerial(req.body?.serial);
  if (!serial) return res.status(400).json({ ok: false, error: "serial required" });
  const manufacturer = String(req.params.manufacturer || "").trim().toLowerCase();
  const plugin = engineeringMode.getEngineeringModePlugin(manufacturer);
  if (!plugin) {
    return res.status(400).json({
      ok: false,
      code: "CARDEV_ENGINEERING_MODE_PLUGIN_NOT_FOUND",
      error: `不支持的车机工程模式厂商：${manufacturer || "未指定"}`,
    });
  }
  return runCardevDeviceOperation(req, res, `engineering_mode_${plugin.id}`, serial, (targetSerial) => (
    engineeringMode.enterEngineeringMode(plugin.id, targetSerial)
  ));
});

// 通用 shell 透传（仅暴露给本模块）
router.post("/shell", async (req, res) => {
  const { serial, cmd } = req.body || {};
  if (!cmd) return res.status(400).json({ ok: false, error: "cmd required" });
  return runCardevDeviceOperation(req, res, "shell", serial, (targetSerial) => (
    adb.shell(targetSerial, cmd)
  ));
});

// ============================================================
// 常用语音指令（VOICE_ACTION 广播）
// ============================================================

router.post("/voice/common", async (req, res) => {
  const { serial, key } = req.body || {};
  res.json(await voice.runCommonIntent(serial || null, key));
});

router.post("/voice/custom", async (req, res) => {
  const { serial, intentName, extra } = req.body || {};
  if (!intentName) return res.status(400).json({ ok: false, error: "intentName required" });
  res.json(await voice.runCustomIntent(serial || null, intentName, extra || {}));
});

router.post("/voice/search-music", async (req, res) => {
  const { serial, keyword } = req.body || {};
  res.json(await voice.searchMusic(serial || null, keyword || ""));
});

router.post("/voice/search-video", async (req, res) => {
  const { serial, keyword } = req.body || {};
  res.json(await voice.searchVideo(serial || null, keyword || ""));
});

// H 方语音
router.post("/voice/hw/text", async (req, res) => {
  const { serial, text } = req.body || {};
  res.json(await voice.hwVoiceInput(serial || null, text));
});

router.post("/voice/hw/preset", async (req, res) => {
  const { serial, key } = req.body || {};
  res.json(await voice.hwVoicePreset(serial || null, key));
});

router.post("/voice/hw/setting", async (req, res) => {
  res.json(await voice.openVoiceSetting(req.body?.serial || null));
});

router.post("/voice/hw/clear", async (req, res) => {
  res.json(await voice.clearVoiceData(req.body?.serial || null));
});

router.post("/voice/hw/region-il", async (req, res) => {
  res.json(await voice.setRegionIsrael(req.body?.serial || null));
});

router.post("/voice/hw/test-url", async (req, res) => {
  res.json(await voice.setTestUrl(req.body?.serial || null));
});

router.post("/voice/kill-market", async (req, res) => {
  res.json(await voice.killMarket(req.body?.serial || null));
});

router.post("/voice/start-drm", async (req, res) => {
  res.json(await voice.startDrm(req.body?.serial || null));
});

// ============================================================
// 方控（按键事件）
// ============================================================

const KEYCODES = {
  previous: "KEYCODE_MEDIA_PREVIOUS",
  play: "KEYCODE_MEDIA_PLAY",
  pause: "KEYCODE_MEDIA_PAUSE",
  next: "KEYCODE_MEDIA_NEXT",
};

router.post("/keyevent", async (req, res) => {
  const { serial, key } = req.body || {};
  const code = KEYCODES[key];
  if (!code) return res.status(400).json({ ok: false, error: `unknown key: ${key}` });
  res.json(await adb.keyevent(serial || null, code));
});

// ============================================================
// 可见可说
// ============================================================

router.post("/voice-see/exec", async (req, res) => {
  const { serial, action, name } = req.body || {};
  res.json(await voiceSee.exec(serial || null, action, name));
});

router.post("/voice-see/build-tree", async (req, res) => {
  res.json(await voiceSee.buildTree(req.body?.serial || null));
});

router.post("/voice-see/hot-words", async (req, res) => {
  res.json(await voiceSee.mockHotWords(req.body?.serial || null));
});

// ============================================================
// 走行规制
// ============================================================

router.post("/safe-drive/speed", async (req, res) => {
  const { serial, speed } = req.body || {};
  if (speed === undefined || speed === null) {
    return res.status(400).json({ ok: false, error: "speed required" });
  }
  res.json(await safeDrive.speedChange(serial || null, speed));
});

router.post("/safe-drive/gear", async (req, res) => {
  const { serial, gear } = req.body || {};
  if (gear === undefined || gear === null) {
    return res.status(400).json({ ok: false, error: "gear required" });
  }
  res.json(await safeDrive.gearChange(serial || null, gear));
});

router.post("/safe-drive/raw", async (req, res) => {
  const { serial, command, extra } = req.body || {};
  if (!command) return res.status(400).json({ ok: false, error: "command required" });
  res.json(await safeDrive.rawCommand(serial || null, command, extra || {}));
});

router.post("/safe-drive/watching", async (req, res) => {
  const { serial, watching } = req.body || {};
  res.json(await safeDrive.setWatchingVideo(serial || null, !!watching));
});

router.post("/safe-drive/random/start", async (req, res) => {
  const { serial, intervalMs } = req.body || {};
  res.json(await safeDrive.startRandomSpeed(serial || null, intervalMs || 1000));
});

router.post("/safe-drive/random/stop", async (req, res) => {
  res.json(await safeDrive.stopRandomSpeed(req.body?.serial || null));
});

router.get("/safe-drive/random/status", (req, res) => {
  res.json({ ok: true, running: safeDrive.isRandomRunning(req.query.serial || null) });
});

// ============================================================
// APK / XAPK 安装 / 文件推送
// ============================================================

router.post("/apk/install", async (req, res) => {
  const { serial, apkPath } = req.body || {};
  if (!apkPath) return res.status(400).json({ ok: false, error: "apkPath required" });
  return runCardevDeviceOperation(req, res, "apk_install", serial, (targetSerial) => (
    apkInstall.installApk(targetSerial, apkPath)
  ));
});

router.post("/apk/install-xapk", async (req, res) => {
  const { serial, xapkPath } = req.body || {};
  if (!xapkPath) return res.status(400).json({ ok: false, error: "xapkPath required" });
  return runCardevDeviceOperation(req, res, "xapk_install", serial, (targetSerial) => (
    apkInstall.installXapk(targetSerial, xapkPath)
  ), { ttlMs: 120_000 });
});

router.post("/apk/push", async (req, res) => {
  const { serial, localPath, remotePath } = req.body || {};
  if (!localPath) return res.status(400).json({ ok: false, error: "localPath required" });
  return runCardevDeviceOperation(req, res, "file_push", serial, (targetSerial) => (
    apkInstall.pushFile(targetSerial, localPath, remotePath)
  ));
});

// 媒体空间分步装载
router.post("/apk/media-space/:step", async (req, res) => {
  const step = req.params.step;
  const { serial, apkPath } = req.body || {};
  const fn = apkInstall.mediaSpace[step];
  if (!fn) return res.status(400).json({ ok: false, error: `unknown step: ${step}` });
  return runCardevDeviceOperation(req, res, `media_space_${step}`, serial, (targetSerial) => (
    fn(targetSerial, apkPath)
  ));
});

// H 方语音包分步装载
router.post("/apk/hw-voice/:step", async (req, res) => {
  const step = req.params.step;
  const { serial, apkPath } = req.body || {};
  const fn = apkInstall.hwVoice[step];
  if (!fn) return res.status(400).json({ ok: false, error: `unknown step: ${step}` });
  return runCardevDeviceOperation(req, res, `hw_voice_${step}`, serial, (targetSerial) => (
    fn(targetSerial, apkPath)
  ));
});

// ============================================================
// 自定义命令存储（CRUD）
// ============================================================

router.get("/commands", (req, res) => {
  res.json({ ok: true, data: store.listCommands() });
});

router.post("/commands", (req, res) => {
  res.json(store.addCommand(req.body || {}));
});

router.delete("/commands/:id", (req, res) => {
  res.json(store.deleteCommand(req.params.id));
});

router.post("/commands/exec", async (req, res) => {
  const { serial, command } = req.body || {};
  if (!command) return res.status(400).json({ ok: false, error: "command required" });
  // 仅允许 adb 开头的命令，避免任意 shell 注入
  const trimmed = String(command).trim();
  if (!/^adb\s/i.test(trimmed)) {
    return res.status(400).json({ ok: false, error: "仅支持以 adb 开头的命令" });
  }
  // 如果传了 serial 且命令中没有 -s，注入 -s
  let finalCmd = trimmed;
  if (serial && !/-s\s+\S+/.test(finalCmd)) {
    finalCmd = finalCmd.replace(/^adb\s+/i, `adb -s ${serial} `);
  }
  // 拆分简单参数（不支持引号嵌套的复杂场景）
  const args = finalCmd.replace(/^adb\s+/i, "").match(/(?:[^\s"]+|"[^"]*")+/g) || [];
  const commandSerial = explicitAdbSerial(args);
  return runCardevDeviceOperation(req, res, "raw_adb", commandSerial, () => adb.adb(null, args));
});

// ============================================================
// 用户偏好（最近输入文本）
// ============================================================

router.get("/last-text/:key", (req, res) => {
  res.json({ ok: true, value: store.getLastText(req.params.key) });
});

router.post("/last-text/:key", (req, res) => {
  res.json(store.setLastText(req.params.key, req.body?.value));
});

// ============================================================
// 模块自检
// ============================================================

router.get("/health", (req, res) => {
  res.json({ ok: true, module: "cardev", version: "1.0.0" });
});

export default router;
