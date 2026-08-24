/**
 * CarDev 模块 - APK / XAPK 安装
 *
 * 支持：
 *   - 普通 APK 安装（adb install -r）
 *   - XAPK 解压后批量安装（adb install-multiple）
 *   - 推送任意文件到设备
 *   - 媒体空间 / H方语音包分步装载
 */
import fs from "fs";
import path from "path";
import os from "os";
import { execSync } from "child_process";
import { adb, shell, install, installMultiple, push, uninstall } from "./adb.js";

/** 普通 APK 安装 */
export async function installApk(serial, apkPath) {
  if (!apkPath || !fs.existsSync(apkPath)) {
    return { ok: false, error: `APK 文件不存在` };
  }
  return install(serial, apkPath);
}

/** XAPK 安装：解压 → install-multiple */
export async function installXapk(serial, xapkPath) {
  if (!xapkPath || !fs.existsSync(xapkPath)) {
    return { ok: false, error: "XAPK 文件不存在" };
  }
  const tmpDir = path.join(os.tmpdir(), `xapk_extract_${Date.now()}`);
  fs.mkdirSync(tmpDir, { recursive: true });

  try {
    if (process.platform === "win32") {
      // Windows: PowerShell Expand-Archive 仅认 .zip 后缀
      const zipCopy = `${xapkPath}.zip`;
      fs.copyFileSync(xapkPath, zipCopy);
      try {
        execSync(
          `powershell -NoProfile -Command "Expand-Archive -Path '${zipCopy}' -DestinationPath '${tmpDir}' -Force"`,
          { stdio: "pipe", timeout: 60000, windowsHide: true }
        );
      } finally {
        try { fs.unlinkSync(zipCopy); } catch {}
      }
    } else {
      execSync(`unzip -o "${xapkPath}" -d "${tmpDir}"`, { stdio: "pipe", timeout: 60000, windowsHide: true });
    }
    const apks = fs.readdirSync(tmpDir).filter((f) => f.endsWith(".apk")).map((f) => path.join(tmpDir, f));
    if (!apks.length) return { ok: false, error: "XAPK 中未发现 .apk 文件" };
    const r = await installMultiple(serial, apks);
    return r;
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
}

/** 推送本地文件到设备指定路径 */
export async function pushFile(serial, localPath, remotePath) {
  if (!localPath || !fs.existsSync(localPath)) {
    return { ok: false, error: "本地文件不存在" };
  }
  return push(serial, localPath, remotePath || "/sdcard/");
}

const MEDIA_SPACE = {
  pkg: "com.appmarket.automotive.mediaspace",
  systemDir: "/system/priv-app/MediaSpaceTest/",
  tempDir: "/data/MediaSpaceTemp/",
};

const HW_VOICE = {
  pkg: "com.huawei.voice.car",
  systemDir: "/system/priv-app/HwVoiceTest/",
  tempDir: "/data/HwVoiceTemp/",
};

/**
 * 分步装载 APK：
 *  step1: 卸载 / 清理软链接
 *  step2: push 到 /data 临时目录 + 在 /system/priv-app 建软链接
 *  step3: 重启设备让 PMS 重新扫描
 */
async function unlinkOldSymlink(serial, target) {
  await shell(serial, `mkdir -p ${target.tempDir}`);
  await shell(serial, `mkdir -p ${target.systemDir}`);
  // 移除已有软链接
  const lsResult = await shell(serial, `ls ${target.systemDir}`);
  const files = lsResult.stdout
    .split(/\r?\n/)
    .map((f) => f.trim())
    .filter((f) => f && f.endsWith(".apk"));
  for (const f of files) {
    await shell(serial, `cd ${target.systemDir} && unlink ${f}`);
  }
  // 清理临时目录
  await shell(serial, `rm -rf ${target.tempDir}*`);
}

async function uploadAndLink(serial, target, apkPath) {
  if (!apkPath || !fs.existsSync(apkPath)) {
    return { ok: false, error: "APK 文件不存在" };
  }
  const fileName = path.basename(apkPath);
  await adb(serial, ["root"], { timeout: 6000 });
  await adb(serial, ["remount"], { timeout: 6000 });
  await shell(serial, `mkdir -p ${target.tempDir}`);
  await shell(serial, `mkdir -p ${target.systemDir}`);
  const pushed = await push(serial, apkPath, target.tempDir);
  if (!pushed.ok) return { ok: false, error: `push 失败: ${pushed.stderr}` };
  const linked = await shell(
    serial,
    `cd ${target.systemDir} && ln -s ${target.tempDir}${fileName} ${fileName}`
  );
  return { ok: linked.ok, output: pushed.stdout + linked.stdout };
}

async function rescanPackages(serial) {
  const r1 = await shell(serial, "rm -rf /data/system/package_cache");
  const r2 = await shell(serial, "rm -rf /data/system/packages.xml");
  return {
    ok: r1.ok && r2.ok,
    stdout: (r1.stdout + r2.stdout).trim(),
    stderr: (r1.stderr + r2.stderr).trim(),
    note: "缓存已清，请手动重启设备让 PMS 重新扫描",
  };
}

export const mediaSpace = {
  step1: (serial) => unlinkOldSymlink(serial, MEDIA_SPACE),
  step2: (serial, apkPath) => uploadAndLink(serial, MEDIA_SPACE, apkPath),
  step3: (serial) => rescanPackages(serial),
  uninstallNormal: (serial) => uninstall(serial, MEDIA_SPACE.pkg),
};

export const hwVoice = {
  step1: (serial) => unlinkOldSymlink(serial, HW_VOICE),
  step2: (serial, apkPath) => uploadAndLink(serial, HW_VOICE, apkPath),
  step3: (serial) => rescanPackages(serial),
  uninstallNormal: (serial) => uninstall(serial, HW_VOICE.pkg),
};
