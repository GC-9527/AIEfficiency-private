#!/usr/bin/env node
/**
 * devbench 验收·录屏包装器（record-while-run）
 *
 * 用法（cwd 一般是工程根，路径相对工程根）：
 *   node "<cloneParent>/AllDocs/StoryDev/<slug>/reports/_devbench-record.mjs" \
 *     --serial <设备序列号> --label tc01 --dir "<cloneParent>/AllDocs/StoryDev/<slug>/reports" -- <你的测试命令...>
 *
 * 作用：在绑定设备上**全程录屏**地执行 `--` 之后的测试命令，命令结束后停止录屏、
 * 拉取视频、截末帧图、保存运行日志，证据自动落到 reports/{videos,screenshots,logs}/。
 * 进程退出码 == 被测命令退出码（便于上层判定用例通过/失败）。
 *
 * 仅依赖 Node 内置模块与本机 PATH 上的 `adb`，无需 npm 依赖。
 */
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, createWriteStream, lstatSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

function arg(name, def = "") {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}
const serial = arg("--serial", process.env.DEVBENCH_DEVICE || "");
const label = (arg("--label", "case") || "case").replace(/[^\w.\-]+/g, "_").slice(0, 60);
const scriptFile = fileURLToPath(import.meta.url);
const reports = path.dirname(scriptFile);
const storyDirectory = path.dirname(reports);
const storyDevRoot = path.dirname(storyDirectory);
const allDocsRoot = path.dirname(storyDevRoot);
let safeInstalledRecorder = path.basename(scriptFile) === "_devbench-record.mjs"
  && path.basename(reports).toLowerCase() === "reports"
  && path.basename(storyDevRoot).toLowerCase() === "storydev"
  && path.basename(allDocsRoot).toLowerCase() === "alldocs";
try {
  const scriptStat = lstatSync(scriptFile);
  const reportsStat = lstatSync(reports);
  safeInstalledRecorder = safeInstalledRecorder
    && scriptStat.isFile()
    && !scriptStat.isSymbolicLink()
    && reportsStat.isDirectory()
    && !reportsStat.isSymbolicLink()
    && path.dirname(realpathSync.native(scriptFile)) === realpathSync.native(reports);
} catch {
  safeInstalledRecorder = false;
}
if (!safeInstalledRecorder) {
  console.error("录屏脚本只能从外置 AllDocs/StoryDev/<故事点>/reports/_devbench-record.mjs 运行");
  process.exit(2);
}
const requestedReports = path.resolve(arg("--dir", reports));
if (process.platform === "win32"
  ? requestedReports.toLowerCase() !== path.resolve(reports).toLowerCase()
  : requestedReports !== path.resolve(reports)) {
  console.error(`--dir 必须是录屏脚本所在的外置 reports 目录：${reports}`);
  process.exit(2);
}
const sep = process.argv.indexOf("--");
const cmd = sep >= 0 ? process.argv.slice(sep + 1) : [];
if (!cmd.length) {
  console.error("用法: node _devbench-record.mjs --serial <S> --label <L> --dir <reportsDir> -- <command...>");
  process.exit(2);
}

const dirs = { videos: path.join(reports, "videos"), shots: path.join(reports, "screenshots"), logs: path.join(reports, "logs") };
const realReports = realpathSync.native(reports);
for (const d of Object.values(dirs)) {
  if (path.dirname(d) !== reports) {
    console.error(`验收证据目录越界：${d}`);
    process.exit(2);
  }
  try {
    if (lstatSync(d).isSymbolicLink() || !lstatSync(d).isDirectory()) {
      throw new Error("不是普通目录");
    }
  } catch (error) {
    if (error?.code === "ENOENT") mkdirSync(d);
    else {
      console.error(`验收证据目录不安全：${d}（${error.message}）`);
      process.exit(2);
    }
  }
  const relative = path.relative(realReports, realpathSync.native(d));
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    console.error(`验收证据目录解析后越界：${d}`);
    process.exit(2);
  }
}

const adbArgs = (a) => (serial ? ["-s", serial, ...a] : a);
const adb = (a) => spawnSync("adb", adbArgs(a), { encoding: "utf8" });
const ts = Date.now().toString(36);
const devBase = `/sdcard/devbench_rec_${label}_${ts}`;

// 录屏分段循环（screenrecord 单段最长约 180s），后台进行直到被测命令结束
let recording = true;
let recProc = null;
const segs = [];
async function recordLoop() {
  let n = 0, quickFails = 0;
  while (recording) {
    n++;
    const devFile = `${devBase}_${String(n).padStart(2, "0")}.mp4`;
    segs.push(devFile);
    const start = Date.now();
    const ok = await new Promise((res) => {
      recProc = spawn("adb", adbArgs(["shell", "screenrecord", "--bit-rate", "4000000", "--time-limit", "170", devFile]), { stdio: "ignore" });
      recProc.on("exit", () => res(true));
      recProc.on("error", () => res(false)); // adb 不在 PATH：停止循环
    });
    if (!ok) { recording = false; break; }
    // 仍在录制中却"过快退出"（<3s）→ 多半是设备/adb 异常，连续两次就停止，避免空转
    if (recording && Date.now() - start < 3000) {
      if (++quickFails >= 2) { recording = false; break; }
      await new Promise((r) => setTimeout(r, 300));
    } else {
      quickFails = 0;
    }
  }
}
function stopRecording() {
  recording = false;
  try { adb(["shell", "pkill", "-l", "INT", "screenrecord"]); } catch {}
  try { recProc && recProc.kill("SIGINT"); } catch {}
}

const recPromise = recordLoop();

// 执行被测命令，stdout/stderr 既回显又写入日志
const logPath = path.join(dirs.logs, `${label}.log`);
const logStream = createWriteStream(logPath, { flags: "w" });
logStream.write(`# devbench verify run\n# label=${label} serial=${serial}\n# cmd=${cmd.join(" ")}\n# at=${new Date().toISOString()}\n\n`);
const child = spawn(cmd[0], cmd.slice(1), { shell: true, env: { ...process.env, DEVBENCH_DEVICE: serial || "" } });
child.stdout.on("data", (d) => { process.stdout.write(d); logStream.write(d); });
child.stderr.on("data", (d) => { process.stderr.write(d); logStream.write(d); });
const code = await new Promise((res) => child.on("exit", (c) => res(c == null ? 1 : c)).on("error", (e) => { logStream.write(String(e)); res(1); }));
logStream.end();

// 收尾：停录屏 → 等落盘 → 末帧截图 → 拉视频/截图
stopRecording();
await new Promise((r) => setTimeout(r, 1800));
await recPromise.catch(() => {});

const shotDev = `/sdcard/devbench_shot_${label}_${ts}.png`;
adb(["shell", "screencap", "-p", shotDev]);
const shotLocal = path.join(dirs.shots, `${label}.png`);
const shotR = adb(["pull", shotDev, shotLocal]);
adb(["shell", "rm", "-f", shotDev]);

const videos = [];
segs.forEach((dev, i) => {
  const local = path.join(dirs.videos, segs.length > 1 ? `${label}_part${String(i + 1).padStart(2, "0")}.mp4` : `${label}.mp4`);
  const r = adb(["pull", dev, local]);
  let big = false;
  try { big = r.status === 0 && statSync(local).size > 0; } catch {}
  if (big) videos.push(path.basename(local));
  adb(["shell", "rm", "-f", dev]);
});

const result = {
  label,
  exitCode: code,
  pass: code === 0,
  videos,
  screenshot: shotR.status === 0 ? path.basename(shotLocal) : null,
  log: path.basename(logPath),
};
console.log("\n[devbench-record] " + JSON.stringify(result));
process.exit(code);
