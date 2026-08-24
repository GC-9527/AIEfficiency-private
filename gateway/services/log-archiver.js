// 网关托管的车机日志归档器：面板点"开始"后，网关用 adb 持续抓 logcat，
// 定时轮转 gzip 压缩，按"设备名_序列号_IP"归档到 AIEfficiency/perf-logs/。
// 让用户**手动跑 Monkey** 即可，日志回传/归档全自动，无需跑任何脚本。
import { spawn, execFileSync } from "child_process";
import fs from "fs";
import path from "path";
import zlib from "zlib";
import { fileURLToPath } from "url";
import { log } from "./logger.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
// gateway/services -> ../.. = AIEfficiency 根
const PERF_LOGS_ROOT = path.join(__dirname, "..", "..", "perf-logs");
const REPORTS_DIR = path.join(__dirname, "..", "..", "tools", "perf-loop", "reports");
const ADB = process.platform === "win32" ? "adb.exe" : "adb";

// 单例会话状态
const state = {
  running: false,
  serial: null,
  deviceKey: null,
  model: null,
  ip: null,
  outDir: null,
  startedAt: null,
  rotateMin: 30,
  archivedCount: 0,
  archivedBytes: 0,
  error: null,
};

let child = null;
let writeStream = null;
let currentFile = null;
let rotateTimer = null;

function adbText(serial, args) {
  const full = serial ? ["-s", serial, ...args] : args;
  try {
    return execFileSync(ADB, full, { encoding: "utf-8", timeout: 8000, windowsHide: true }).trim();
  } catch {
    return "";
  }
}

function sanitize(s) {
  return String(s || "").replace(/[^A-Za-z0-9._-]/g, "_").replace(/^_+|_+$/g, "") || "unknown";
}

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, "-").replace("T", "_").slice(0, 19);
}

function resolveDevice(serial) {
  const model = adbText(serial, ["shell", "getprop", "ro.product.model"]) || "device";
  const realSerial = adbText(serial, ["get-serialno"]) || serial || "unknown";
  const ipRaw = adbText(serial, ["shell", "ip", "-f", "inet", "addr", "show", "wlan0"]);
  const m = ipRaw.match(/inet (\d+\.\d+\.\d+\.\d+)/);
  let ip = m ? m[1] : "noip";
  if (ip === "noip" && /^(\d+\.\d+\.\d+\.\d+):\d+$/.test(realSerial)) ip = realSerial.split(":")[0];
  return { model, serial: realSerial, ip };
}

function gzipFile(src) {
  return new Promise((resolve) => {
    if (!fs.existsSync(src) || fs.statSync(src).size === 0) {
      try { fs.existsSync(src) && fs.unlinkSync(src); } catch {}
      return resolve(0);
    }
    const dest = path.join(state.outDir, "archive", path.basename(src) + ".gz");
    const r = fs.createReadStream(src);
    const w = fs.createWriteStream(dest);
    r.pipe(zlib.createGzip()).pipe(w);
    w.on("finish", () => {
      let size = 0;
      try { size = fs.statSync(dest).size; } catch {}
      try { fs.unlinkSync(src); } catch {}
      state.archivedCount++;
      state.archivedBytes += size;
      resolve(size);
    });
    w.on("error", () => resolve(0));
  });
}

function sweepMonkeyReports() {
  if (!fs.existsSync(REPORTS_DIR) || !state.outDir) return;
  const monkeyDir = path.join(state.outDir, "monkey");
  for (const name of fs.readdirSync(REPORTS_DIR)) {
    const src = path.join(REPORTS_DIR, name);
    const dest = path.join(monkeyDir, name);
    if (fs.statSync(src).isDirectory() && !fs.existsSync(dest)) {
      fs.cpSync(src, dest, { recursive: true });
    }
  }
}

function openNewLogFile() {
  currentFile = path.join(state.outDir, "raw", `logcat-${stamp()}.log`);
  writeStream = fs.createWriteStream(currentFile, { flags: "a" });
}

async function rotate() {
  const old = writeStream;
  const oldFile = currentFile;
  openNewLogFile(); // 先切到新文件（data 监听器始终写 state 的当前流），不丢日志
  if (old) old.end();
  await gzipFile(oldFile);
  try { sweepMonkeyReports(); } catch {}
}

export function startLogArchive({ serial = "", rotateMin = 30, bufferMB = 16 } = {}) {
  if (state.running) return { ...publicState(), already: true };

  const dev = resolveDevice(serial);
  const deviceKey = `${sanitize(dev.model)}_${sanitize(dev.serial)}_${sanitize(dev.ip)}`;
  const outDir = path.join(PERF_LOGS_ROOT, deviceKey);
  for (const d of [outDir, path.join(outDir, "raw"), path.join(outDir, "archive"), path.join(outDir, "monkey")]) {
    fs.mkdirSync(d, { recursive: true });
  }

  Object.assign(state, {
    running: true, serial: serial || dev.serial, deviceKey, model: dev.model, ip: dev.ip,
    outDir, startedAt: new Date().toISOString(), rotateMin, archivedCount: 0, archivedBytes: 0, error: null,
  });
  fs.writeFileSync(path.join(outDir, "device.json"), JSON.stringify({
    model: dev.model, serial: dev.serial, ip: dev.ip, startedAt: state.startedAt, rotateMin, bufferMB,
  }, null, 2));

  // 调大设备 logcat 缓冲，降低轮转间隙丢日志概率
  adbText(serial, ["logcat", "-G", `${bufferMB}M`]);

  openNewLogFile();
  const args = (serial ? ["-s", serial] : []).concat(["logcat", "-b", "all", "-v", "threadtime"]);
  child = spawn(ADB, args, { windowsHide: true });
  child.stdout.on("data", (d) => { if (writeStream) writeStream.write(d); });
  child.on("error", (e) => { state.error = e.message; });
  child.on("exit", (code) => {
    // 非主动停止时的意外退出
    if (state.running) { state.error = `logcat 进程退出(code=${code})`; }
  });

  rotateTimer = setInterval(() => { rotate().catch(() => {}); }, rotateMin * 60 * 1000);
  log(null, "info", "log-archiver", `开始归档 ${deviceKey} → perf-logs/（每 ${rotateMin}min 轮转）`);
  return publicState();
}

export async function stopLogArchive() {
  if (!state.running) return publicState();
  if (rotateTimer) { clearInterval(rotateTimer); rotateTimer = null; }
  state.running = false;
  try { if (child && !child.killed) child.kill(); } catch {}
  child = null;
  const old = writeStream; const oldFile = currentFile;
  writeStream = null;
  if (old) old.end();
  await gzipFile(oldFile); // 收尾归档最后一段
  try { sweepMonkeyReports(); } catch {}
  log(null, "info", "log-archiver", `停止归档 ${state.deviceKey}（共 ${state.archivedCount} 个压缩包）`);
  return publicState();
}

function publicState() {
  let currentSize = 0;
  try { if (currentFile && fs.existsSync(currentFile)) currentSize = fs.statSync(currentFile).size; } catch {}
  return {
    running: state.running,
    deviceKey: state.deviceKey,
    model: state.model,
    serial: state.serial,
    ip: state.ip,
    startedAt: state.startedAt,
    rotateMin: state.rotateMin,
    archivedCount: state.archivedCount,
    archivedMB: Math.round((state.archivedBytes / 1048576) * 100) / 100,
    currentMB: Math.round((currentSize / 1048576) * 100) / 100,
    outDir: state.deviceKey ? `perf-logs/${state.deviceKey}` : null,
    error: state.error,
  };
}

export function getLogArchiveStatus() {
  return publicState();
}
