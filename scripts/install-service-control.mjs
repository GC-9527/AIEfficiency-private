import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.join(path.dirname(fileURLToPath(import.meta.url)), ".."));
const controllerDir = path.join(repoRoot, "service-control-electron");
const launcherDir = path.join(repoRoot, "docs", "tempFiles", "service-control-launchers");
const appName = "AIEfficiency Service Control";

function fail(message) {
  console.error(`[ERROR] ${message}`);
  process.exit(1);
}

function quoteSh(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function psString(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function desktopDir() {
  const fromEnv = process.env.XDG_DESKTOP_DIR;
  if (fromEnv && fs.existsSync(fromEnv)) return fromEnv;
  const candidate = path.join(os.homedir(), "Desktop");
  fs.mkdirSync(candidate, { recursive: true });
  return candidate;
}

function npmCommand() {
  return process.platform === "win32" ? "npm.cmd" : "npm";
}

function ensureNodeAndNpm() {
  try {
    execFileSync("node", ["-v"], { stdio: "ignore" });
    execFileSync(npmCommand(), ["-v"], { stdio: "ignore", shell: process.platform === "win32" });
  } catch {
    fail("Node.js and npm are required. Install Node.js 20+ first.");
  }
}

function ensureElectronDependency() {
  if (fs.existsSync(path.join(controllerDir, "node_modules", "electron"))) return;
  console.log("[INFO] Installing service-control-electron dependencies...");
  execFileSync(npmCommand(), ["install", "--no-audit", "--no-fund"], {
    cwd: controllerDir,
    stdio: "inherit",
    shell: process.platform === "win32",
  });
}

function writeWindowsShortcut() {
  const cmdPath = path.join(launcherDir, "AIEfficiency-Service-Control.cmd");
  const vbsPath = path.join(launcherDir, "AIEfficiency-Service-Control.vbs");
  const linkPath = path.join(desktopDir(), `${appName}.lnk`);
  const iconPath = path.join(repoRoot, "desktop", "icons", "icon.ico");
  const psPath = path.join(launcherDir, "create-shortcut.ps1");

  fs.writeFileSync(cmdPath, [
    "@echo off",
    `cd /d "${controllerDir}"`,
    `npm start -- --dev-repo "${repoRoot}"`,
    "",
  ].join("\r\n"));

  fs.writeFileSync(vbsPath, [
    "Set shell = CreateObject(\"WScript.Shell\")",
    `shell.Run Chr(34) & "${cmdPath.replace(/\\/g, "\\\\")}" & Chr(34), 0, False`,
    "",
  ].join("\r\n"));

  fs.writeFileSync(psPath, [
    "$shell = New-Object -ComObject WScript.Shell",
    `$shortcut = $shell.CreateShortcut(${psString(linkPath)})`,
    `$shortcut.TargetPath = ${psString(path.join(process.env.SystemRoot || "C:\\Windows", "System32", "wscript.exe"))}`,
    `$shortcut.Arguments = ${psString(`"${vbsPath}"`)}`,
    `$shortcut.WorkingDirectory = ${psString(repoRoot)}`,
    `$shortcut.Description = ${psString("AIEfficiency cross-platform service controller")}`,
    fs.existsSync(iconPath) ? `$shortcut.IconLocation = ${psString(`${iconPath},0`)}` : "",
    "$shortcut.Save()",
    "",
  ].filter(Boolean).join("\r\n"));

  const result = spawnSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", psPath], {
    stdio: "inherit",
  });
  if (result.status !== 0) fail("Failed to create Windows desktop shortcut.");
  console.log(`[OK] Shortcut: ${linkPath}`);
}

function writeMacApp() {
  const appPath = path.join(desktopDir(), `${appName}.app`);
  const contentsDir = path.join(appPath, "Contents");
  const macosDir = path.join(contentsDir, "MacOS");
  fs.rmSync(appPath, { recursive: true, force: true });
  fs.mkdirSync(macosDir, { recursive: true });
  fs.writeFileSync(path.join(contentsDir, "Info.plist"), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>${appName}</string>
  <key>CFBundleDisplayName</key><string>${appName}</string>
  <key>CFBundleIdentifier</key><string>com.aiefficiency.servicecontrol.launcher</string>
  <key>CFBundleExecutable</key><string>launcher</string>
  <key>CFBundlePackageType</key><string>APPL</string>
</dict>
</plist>
`);
  const launcher = path.join(macosDir, "launcher");
  fs.writeFileSync(launcher, `#!/bin/sh
cd ${quoteSh(controllerDir)} || exit 1
npm start -- --dev-repo ${quoteSh(repoRoot)} >/tmp/aiefficiency-service-control.log 2>&1 &
`);
  fs.chmodSync(launcher, 0o755);
  console.log(`[OK] App launcher: ${appPath}`);
}

function writeLinuxDesktopEntry() {
  const desktopPath = path.join(desktopDir(), `${appName}.desktop`);
  const iconPath = path.join(repoRoot, "desktop", "icons", "icon.png");
  const execCommand = `/bin/sh -lc "cd ${quoteSh(controllerDir)} && npm start -- --dev-repo ${quoteSh(repoRoot)}"`;
  fs.writeFileSync(desktopPath, [
    "[Desktop Entry]",
    "Type=Application",
    `Name=${appName}`,
    `Exec=${execCommand}`,
    fs.existsSync(iconPath) ? `Icon=${iconPath}` : "",
    "Terminal=false",
    "Categories=Development;",
    "",
  ].filter(Boolean).join("\n"));
  fs.chmodSync(desktopPath, 0o755);
  console.log(`[OK] Desktop entry: ${desktopPath}`);
}

if (!fs.existsSync(path.join(repoRoot, "gateway", "server.js"))) {
  fail(`Repository root is invalid: ${repoRoot}`);
}

fs.mkdirSync(launcherDir, { recursive: true });
ensureNodeAndNpm();
ensureElectronDependency();

if (process.platform === "win32") writeWindowsShortcut();
else if (process.platform === "darwin") writeMacApp();
else writeLinuxDesktopEntry();

console.log("[OK] Service control installer completed.");
