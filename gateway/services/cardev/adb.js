/**
 * CarDev 模块 - ADB 原语封装
 *
 * 仅依赖 child_process / iconv-lite，不引用其他业务模块。
 * 所有命令通过 spawn 调用 adb，不依赖 .bat 脚本，跨平台可用。
 */
import { spawn as nodeSpawn } from "child_process";
import iconv from "iconv-lite";
import { log } from "../logger.js";

// 可注入的 spawn（默认即 child_process.spawn）。仅用于测试桩注入，生产行为不变。
let spawn = nodeSpawn;
/** @internal 测试用：替换底层 spawn；传 undefined 还原为 child_process.spawn */
export function __setSpawn(fn) { spawn = fn || nodeSpawn; }

const DEFAULT_TIMEOUT = 15000;
const MODULE = "cardev:adb";

/** 把 ADB 常见错误转为人话 hint */
export function classifyError(text) {
  if (!text) return null;
  const t = String(text);
  if (/more than one device|emulator/i.test(t)) {
    return "检测到多个 ADB 设备但未指定 serial。请在「车机调试 → 设备」标签页选中一个设备后再试。";
  }
  if (/device .*? not found|device offline/i.test(t)) {
    return "选中的设备已离线或未连接。请刷新设备列表，重新选择一个 status=device 的设备。";
  }
  if (/unauthorized/i.test(t)) {
    return "设备未授权 ADB 调试。请在车机屏幕上点「允许」（或勾选总是允许）。";
  }
  if (/no devices\/emulators found/i.test(t)) {
    return "ADB 当前没有任何已连接设备。请先 USB 接入或 adb connect <ip>。";
  }
  return null;
}

function exec(cmd, args, { timeout = DEFAULT_TIMEOUT, encoding = null } = {}) {
  return new Promise((resolve) => {
    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    let finished = false;
    const startedAt = Date.now();

    log(null, "info", MODULE, `→ ${cmd} ${args.join(" ").slice(0, 300)}`);

    let child;
    try {
      child = spawn(cmd, args, { windowsHide: true, shell: false });
    } catch (err) {
      log(null, "error", MODULE, `spawn 失败: ${err.message}`);
      resolve({ ok: false, code: -1, stdout: "", stderr: err.message, error: err.message });
      return;
    }

    child.stdout?.on("data", (d) => { stdout = Buffer.concat([stdout, d]); });
    child.stderr?.on("data", (d) => { stderr = Buffer.concat([stderr, d]); });

    const finalize = (code, extraStderr = "") => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      const stdoutText = decode(stdout, encoding);
      const stderrText = decode(stderr, encoding) + extraStderr;
      // 仅诊断 stderr：adb 的多设备/未授权/离线/无设备等错误均写 stderr。
      // 不要扫 stdout——正常 `adb devices` 列表里的 "unauthorized"/"offline" 设备行
      // 会被误判为错误，导致 listDevices 等命令在退出码为 0 时被当成失败。
      const hint = classifyError(stderrText);
      const ok = code === 0 && !hint;
      const dur = Date.now() - startedAt;
      log(null, ok ? "info" : "error", MODULE,
        `← code=${code} ${dur}ms ${ok ? "OK" : (hint || stderrText.trim() || "fail")}`.slice(0, 500));
      resolve({ ok, code, stdout: stdoutText, stderr: stderrText, error: hint });
    };

    const timer = setTimeout(() => {
      try { child.kill("SIGTERM"); } catch {}
      finalize(-1, "\n[timeout]");
    }, timeout);
    child.on("error", (err) => { if (!finished) { finished = true; clearTimeout(timer);
      log(null, "error", MODULE, `child 错误: ${err.message}`);
      resolve({ ok: false, code: -1, stdout: "", stderr: err.message, error: err.message });
    } });
    child.on("close", (code) => finalize(code));
  });
}

function decode(buf, encoding) {
  if (!buf || !buf.length) return "";
  if (encoding === "gbk") {
    try { return iconv.decode(buf, "gbk"); } catch {}
  }
  try { return buf.toString("utf-8"); } catch { return buf.toString(); }
}

/** 列出 adb devices（含状态） */
export async function listDevices() {
  const r = await exec("adb", ["devices", "-l"], { timeout: 8000 });
  if (!r.ok) return { ok: false, error: r.stderr || "adb 未就绪", devices: [] };
  const devices = [];
  for (const line of r.stdout.split(/\r?\n/)) {
    const m = line.match(/^(\S+)\s+(device|offline|unauthorized|recovery|sideload|bootloader)(?:\s+(.*))?\s*$/);
    if (!m) continue;
    const device = { id: m[1], status: m[2] };
    for (const token of String(m[3] || "").trim().split(/\s+/)) {
      const detail = token.match(/^([a-z_]+):(.+)$/i);
      if (detail) device[detail[1]] = detail[2];
    }
    devices.push(device);
  }
  return { ok: true, devices };
}

/** 连接指定 IP（adb connect ip:port） */
export async function connect(ip) {
  if (!ip) return { ok: false, error: "ip required" };
  const target = /:\d+$/.test(ip) ? ip : `${ip}:5555`;
  const r = await exec("adb", ["connect", target], { timeout: 8000 });
  return { ok: r.ok, output: (r.stdout + r.stderr).trim() };
}

/** 断开指定 IP（adb disconnect ip[:port]） */
export async function disconnect(ip) {
  if (!ip) return { ok: false, error: "ip required" };
  const target = /:\d+$/.test(ip) ? ip : `${ip}:5555`;
  const r = await exec("adb", ["disconnect", target], { timeout: 8000 });
  return { ok: r.ok, output: (r.stdout + r.stderr).trim() };
}

/** 通过 wlan0 ifconfig 获取设备 IP */
export async function getDeviceIp(serial) {
  const args = serial ? ["-s", serial, "shell", "ifconfig wlan0"] : ["shell", "ifconfig wlan0"];
  const r = await exec("adb", args, { timeout: 6000 });
  if (!r.ok) return null;
  const m = r.stdout.match(/inet\s+addr:\s*(\d+\.\d+\.\d+\.\d+)/) || r.stdout.match(/inet\s+(\d+\.\d+\.\d+\.\d+)/);
  return m ? m[1] : null;
}

/** 在设备上执行 shell 命令（整行字符串） */
export async function shell(serial, cmdLine, opts = {}) {
  const args = serial ? ["-s", serial, "shell", cmdLine] : ["shell", cmdLine];
  return exec("adb", args, { encoding: "gbk", ...opts });
}

/** 直接 adb 命令（args 数组） */
export async function adb(serial, args, opts = {}) {
  const finalArgs = serial ? ["-s", serial, ...args] : args;
  return exec("adb", finalArgs, { encoding: "gbk", ...opts });
}

/** 安装 APK 到设备 */
export async function install(serial, apkPath, { reinstall = true } = {}) {
  const args = ["install"];
  if (reinstall) args.push("-r");
  args.push(apkPath);
  return adb(serial, args, { timeout: 180000 });
}

/** 安装 multiple APK（XAPK 解压后） */
export async function installMultiple(serial, apkPaths) {
  if (!apkPaths?.length) return { ok: false, error: "no apks" };
  return adb(serial, ["install-multiple", "-r", ...apkPaths], { timeout: 180000 });
}

/** 推送本地文件到设备 */
export async function push(serial, localPath, remotePath) {
  return adb(serial, ["push", localPath, remotePath], { timeout: 180000 });
}

/** 卸载包 */
export async function uninstall(serial, pkg) {
  return adb(serial, ["uninstall", pkg], { timeout: 30000 });
}

/** 输入按键事件 */
export async function keyevent(serial, keycode) {
  return shell(serial, `input keyevent ${keycode}`);
}

/** am broadcast 事件（自动转义 message JSON） */
export async function broadcast(serial, action, messageObj) {
  const json = JSON.stringify(messageObj);
  // 单引号包裹整个 JSON，单引号在 JSON 内不会出现
  const cmd = `am broadcast -a ${action} -e "message" '${json}'`;
  return shell(serial, cmd);
}

/** am start activity */
export async function startActivity(serial, component, opts = {}) {
  const { action, category, dataUri, extras = {} } = opts;
  let cmd = "am start";
  if (action) cmd += ` -a ${action}`;
  if (category) cmd += ` -c ${category}`;
  cmd += ` -n ${component}`;
  if (dataUri) cmd += ` -d "${dataUri}"`;
  for (const [k, v] of Object.entries(extras)) cmd += ` --es ${k} "${v}"`;
  return shell(serial, cmd);
}

/** force-stop 包 */
export async function forceStop(serial, pkg) {
  return shell(serial, `am force-stop ${pkg}`);
}

/** pm clear 包数据 */
export async function clearPackage(serial, pkg) {
  return shell(serial, `pm clear ${pkg}`);
}

/** setprop */
export async function setProp(serial, key, value) {
  return shell(serial, `setprop ${key} ${value}`);
}

/**
 * 启动 scrcpy 投屏 — 在新的可见控制台窗口里运行，detached 让网关进程不持有它
 * 用户关闭主面板/重启网关也不影响投屏。
 *
 * 行为：
 *   - Windows: cmd /c start "标题" cmd /k "scrcpy -s <serial> ..."
 *     （新建一个 cmd 窗口，运行 scrcpy 并保留窗口便于看日志）
 *   - macOS / Linux: detached 后台启动 scrcpy（GUI 窗口由 scrcpy 自己创建）
 */
export function launchScrcpy(serial, extraArgs = []) {
  const safeArgs = (Array.isArray(extraArgs) ? extraArgs : []).map((a) => String(a));
  const baseArgs = serial ? ["-s", String(serial), ...safeArgs] : safeArgs;
  log(null, "info", MODULE, `→ scrcpy ${baseArgs.join(" ")}`.slice(0, 300));
  try {
    if (process.platform === "win32") {
      const inner = ["scrcpy", ...baseArgs].map((a) => /\s/.test(a) ? `"${a}"` : a).join(" ");
      const title = `scrcpy ${serial || ""}`.trim();
      const child = spawn("cmd.exe", ["/c", "start", title, "cmd", "/k", inner], {
        detached: true,
        stdio: "ignore",
        windowsHide: false,
        shell: false,
      });
      child.unref();
    } else {
      const child = spawn("scrcpy", baseArgs, {
        detached: true,
        stdio: "ignore",
      });
      child.unref();
    }
    return { ok: true, command: `scrcpy ${baseArgs.join(" ")}`.trim() };
  } catch (err) {
    log(null, "error", MODULE, `scrcpy 启动失败: ${err.message}`);
    return { ok: false, error: err.message };
  }
}

/**
 * 用 scrcpy 自己的 --list-displays 枚举可投屏的显示屏（权威来源，与 --display-id 一致）。
 * 返回 { ok, displays:[{id, resolution}], raw }。scrcpy < 2.0 无该选项时 ok=false（调用方回退 dumpsys）。
 */
export async function scrcpyListDisplays(serial) {
  const args = serial ? ["-s", String(serial), "--list-displays"] : ["--list-displays"];
  const r = await exec("scrcpy", args, { timeout: 30000 }); // utf-8
  const text = `${r.stdout || ""}\n${r.stderr || ""}`;
  const out = parseScrcpyDisplayList(text);
  return { ok: out.length > 0, displays: out, raw: text };
}

export function parseScrcpyDisplayList(text) {
  const byId = new Map();
  // 兼容：--display-id=0 (1920x1080) / --display-id 0 (1920x1080)
  const re = /--display[-_ ]?id[=\s]+(\d+)\s*(?:\(?\s*(\d+)\s*x\s*(\d+)\s*\)?)?/gi;
  let m;
  while ((m = re.exec(text))) {
    const id = parseInt(m[1], 10);
    const next = { id, resolution: m[2] && m[3] ? `${m[2]}x${m[3]}` : "" };
    const prev = byId.get(id);
    if (!prev) byId.set(id, next);
    else if (!prev.resolution && next.resolution) prev.resolution = next.resolution;
  }
  return [...byId.values()].sort((a, b) => a.id - b.id);
}
