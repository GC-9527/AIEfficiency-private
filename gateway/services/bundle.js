/**
 * LAN 自分发：把当前网关源码按需打成 gateway-bundle.zip（供客户端 setup.ps1 下载安装）。
 * 不含 node_modules/.secrets/db数据/feedback附件/config.json —— 客户端各自 npm install + 写自己的配置。
 * 跨平台 zip：Windows 用 Compress-Archive，mac/linux 用 zip。生成一次缓存到临时目录。
 */
import fs from "fs";
import os from "os";
import path from "path";
import { spawn } from "child_process";
import { fileURLToPath } from "url";
import { prepareReleaseResources } from "./release-resources.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GW_DIR = path.join(__dirname, ".."); // gateway/
const ROOT = path.join(GW_DIR, "..");      // 仓库根（含 skills/configs）

const EXCLUDE = new Set([
  "node_modules",
  ".tmp",
  ".secrets",
  "feedback-files",
  "fixture",
  "fixtures",
  "knowledge",
  "scripts",
  "__tests__",
  "tests",
  "config.json",
  "gateway-bundle.zip",
  ".git",
  "test",
]);
const BLOCKED_FILE_NAMES = new Set([".env", "credentials.json", "id_ed25519", "id_rsa", "service-account.json"]);
const isExcluded = (name) => {
  const lower = name.toLowerCase();
  return EXCLUDE.has(lower)
    || BLOCKED_FILE_NAMES.has(lower)
    || lower.startsWith(".env.")
    || /\.(db|db-wal|db-shm|db-journal|log|pem|key|p12|pfx|jks|keystore|mobileprovision|jar|zip|7z|rar|tar|gz|tgz)$/i.test(lower)
    || lower.startsWith("_dev_");
};

function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    if (isExcluded(e.name)) continue;
    const s = path.join(src, e.name), d = path.join(dest, e.name);
    if (e.isDirectory()) copyDir(s, d);
    else if (e.isFile()) { try { fs.copyFileSync(s, d); } catch {} }
  }
}

function zipDir(stageDir, outZip) {
  return new Promise((resolve, reject) => {
    try { fs.rmSync(outZip, { force: true }); } catch {}
    const isWin = process.platform === "win32";
    const cmd = isWin ? "powershell" : "zip";
    const args = isWin
      ? ["-NoProfile", "-Command", `Compress-Archive -Path '${path.join(stageDir, "*")}' -DestinationPath '${outZip}' -Force`]
      : ["-r", "-q", outZip, "."];
    const p = spawn(cmd, args, { cwd: stageDir, shell: false, windowsHide: true });
    let err = "";
    p.stderr.on("data", (d) => { err += d.toString(); });
    p.on("error", reject);
    p.on("close", (c) => (c === 0 && fs.existsSync(outZip) ? resolve(outZip) : reject(new Error(`打包失败(${cmd} 退出 ${c})：${err.slice(-300)}`))));
  });
}

let cached = null; // { path, builtAt }
let building = null; // 并发去重：同一进程内多个请求复用一次生成

// 返回可下载的 bundle 路径。首次/过期(>10min)重新生成（写唯一临时路径，避免并发争用固定文件）。失败回落仓库根已有的 gateway-bundle.zip。
export async function ensureBundle() {
  if (cached && fs.existsSync(cached.path) && Date.now() - cached.builtAt < 10 * 60 * 1000) return cached.path;
  if (building) return building;
  building = (async () => {
    const work = fs.mkdtempSync(path.join(os.tmpdir(), "gwbundle-"));
    const stage = path.join(work, "stage");
    const out = path.join(work, "gateway-bundle.zip");
    try {
      copyDir(GW_DIR, path.join(stage, "gateway"));
      const appMarketMcp = path.join(ROOT, "mcp-servers", "devServer");
      if (fs.existsSync(appMarketMcp)) {
        copyDir(appMarketMcp, path.join(stage, "gateway", "mcp-servers", "devServer"));
      }
      prepareReleaseResources(ROOT, stage);
      await zipDir(stage, out);
      try { fs.rmSync(stage, { recursive: true, force: true }); } catch {}
      cached = { path: out, builtAt: Date.now() };
      return out;
    } catch (e) {
      try { fs.rmSync(work, { recursive: true, force: true }); } catch {}
      const prebuilt = path.join(ROOT, "gateway-bundle.zip");
      if (fs.existsSync(prebuilt)) return prebuilt; // 回落已构建好的
      throw e;
    }
  })();
  try { return await building; } finally { building = null; }
}

export function gatewayVersion() {
  try { return JSON.parse(fs.readFileSync(path.join(GW_DIR, "package.json"), "utf-8")).version || "0.0.0"; }
  catch { return "0.0.0"; }
}

// 查找桌面安装包（管理员放在以下任一位置即可被分发）
function findInstaller({ env, names, exts }) {
  const cands = [env && process.env[env], path.join(GW_DIR, names.flat), path.join(ROOT, names.flat), path.join(ROOT, "cloud", names.flat)].filter(Boolean);
  for (const c of cands) { if (fs.existsSync(c)) return c; }
  const distDir = path.join(ROOT, "desktop", "dist");
  try {
    const files = fs.readdirSync(distDir).filter((f) => exts.some((e) => f.toLowerCase().endsWith(e)));
    if (files.length) return path.join(distDir, files.sort().reverse()[0]);
  } catch {}
  return null;
}
// Windows 安装包(.exe)
export function findDesktopExe() {
  return findInstaller({ env: "DESKTOP_EXE_PATH", names: { flat: "desktop-setup.exe" }, exts: [".exe"] });
}
// macOS 安装包(.dmg)
export function findDesktopDmg() {
  return findInstaller({ env: "DESKTOP_DMG_PATH", names: { flat: "desktop-setup.dmg" }, exts: [".dmg"] });
}
